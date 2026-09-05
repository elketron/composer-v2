// The project domain: validation order, rejection messages, and the
// emitted events match v1's processor (create_project, set_directory,
// activate). The fold and the snapshot round-trip into equal state.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Processor } from '../src/processor.js';
import { apply } from '../src/fold.js';
import { snapshotEvents } from '../src/snapshot.js';
import { newState } from '../src/fold.js';
import type { EventFrame } from '../src/wire/envelope.js';

let dir: string;
let store: InstanceType<typeof import('../src/store.js').EventStore>;
let bus: Bus;
let processor: Processor;
const recorded: EventFrame[] = [];

beforeEach(async () => {
  recorded.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'composer-proc-'));
  const { EventStore } = await import('../src/store.js');
  store = new EventStore();
  await store.connect(dir);
  bus = new Bus(store);
  processor = new Processor(bus);
  bus.subscribe((frame) => recorded.push(frame));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const ProjectCreated = 'projectCreated' as const;

describe('project commands', () => {
  it('create_project_rejects_empty_and_duplicate_names', async () => {
    const empty = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: '  ',
    });
    expect(empty).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Project name is required' },
    });

    const created = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'alpha',
    });
    expect(created.ok).toBe(true);

    const duplicate = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'ALPHA',
    });
    expect(duplicate).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: "Project 'ALPHA' already exists" },
    });
  });

  it('create_project_emits_created_then_activated', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    expect(recorded.map((frame) => frame.eventType)).toEqual([ProjectCreated, 'projectActivated']);
    const project = (recorded[0]?.body as { project: { id: string } }).project;
    expect(project.id).toBe('P-1');
  });

  it('create_project_validates_and_links_the_directory', async () => {
    const missing = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'alpha',
      directory: '/composer/does/not/exist',
    });
    expect(missing).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Project directory must exist' },
    });

    const linked = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'alpha',
      directory: dir,
    });
    expect(linked.ok).toBe(true);

    const again = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'beta',
      directory: `${dir}/`,
    });
    expect(again).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: `Directory '${dir}' is already linked` },
    });
  });

  it('set_project_directory_validates_and_updates', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    const other = mkdtempSync(join(tmpdir(), 'composer-dir-'));

    const noScope = await processor.execute('P-9', {
      type: 'requestProjectSetDirectory',
      projectId: 'P-1',
      directory: other,
    });
    expect(noScope).toEqual({
      ok: false,
      rejection: { code: 'unknownProject', message: 'Unknown project P-9' },
    });

    const updated = await processor.execute('P-1', {
      type: 'requestProjectSetDirectory',
      projectId: 'P-1',
      directory: other,
    });
    expect(updated.ok).toBe(true);
    expect(bus.state.projects.get('P-1')?.directory).toBe(other);

    // Same directory: a no-op (no event).
    const before = recorded.length;
    const same = await processor.execute('P-1', {
      type: 'requestProjectSetDirectory',
      projectId: 'P-1',
      directory: other,
    });
    expect(same.ok).toBe(true);
    expect(recorded.length).toBe(before);
    rmSync(other, { recursive: true, force: true });
  });

  it('activate_project_rejects_unknown_projects', async () => {
    const result = await processor.execute(undefined, {
      type: 'requestProjectActivate',
      projectId: 'P-9',
    });
    expect(result).toEqual({
      ok: false,
      rejection: { code: 'unknownProject', message: 'Unknown project P-9' },
    });
  });

  it('the_snapshot_replays_into_equal_state', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'beta', directory: dir });

    const snapshot = snapshotEvents(bus.state);
    const replayed = newState();
    for (const frame of snapshot) {
      apply(replayed, {
        id: frame.id,
        ...(frame.projectId !== undefined ? { projectId: frame.projectId } : {}),
        occurredAt: frame.occurredAt,
        name: frame.eventType,
        body: frame.body,
      });
    }
    expect([...replayed.projects.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...bus.state.projects.values()].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
