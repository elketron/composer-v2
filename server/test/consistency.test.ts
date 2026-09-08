// The filesystem/event dual-write compensation (SRV-003): a file command
// writes the file then publishes its metadata event. When the event append
// fails, the file mutation must roll back so a failed command leaves
// neither the file nor the event behind. A genuine storage failure must
// also surface as an error (not a domain rejection), unlike a validation
// rejection.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { EventStore } from '../src/store/index.js';
import { Processor } from '../src/processor/index.js';
import { StorageError } from '../src/filesystem/errors.js';

let dir: string;
let projectDir: string;
let store: EventStore;
let bus: Bus;
let processor: Processor;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'composer-consistency-'));
  projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
  store = new EventStore();
  await store.connect(dir);
  bus = new Bus(store);
  processor = new Processor(bus);
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createProject(): Promise<void> {
  const created = await processor.execute(undefined, {
    type: 'requestProjectCreate',
    name: 'alpha',
    directory: projectDir,
  });
  if (!created.ok) throw new Error(created.rejection.message);
}

describe('the filesystem/event dual write', () => {
  it('a_failed_event_append_rolls_back_the_doc_write', async () => {
    await createProject();
    store.append = async () => {
      throw new Error('disk full');
    };

    await expect(
      processor.execute('P-1', { type: 'requestDocSave', path: 'a.md', content: '# A\n' }),
    ).rejects.toThrow('disk full');

    // The file was written then rolled back: nothing changed on disk.
    expect(() => statSync(join(projectDir, 'docs', 'a.md'))).toThrow();
  });

  it('a_failed_second_event_rolls_back_a_rename', async () => {
    await createProject();
    await processor.execute('P-1', { type: 'requestDocSave', path: 'a.md', content: '# A\n' });

    const original = store.append.bind(store);
    store.append = async (envelope, ephemeral) => {
      if (envelope.name === 'docDeleted') throw new Error('disk full');
      return original(envelope, ephemeral);
    };

    await expect(
      processor.execute('P-1', { type: 'requestDocRename', path: 'a.md', to: 'b.md' }),
    ).rejects.toThrow('disk full');

    // The rename was undone: source restored, target never created.
    expect(readFileSync(join(projectDir, 'docs', 'a.md')).toString()).toContain('# A');
    expect(() => statSync(join(projectDir, 'docs', 'b.md'))).toThrow();
  });

  it('a_failed_append_for_a_delete_reconstitutes_the_file', async () => {
    await createProject();
    await processor.execute('P-1', { type: 'requestDocSave', path: 'a.md', content: '# A\n' });

    store.append = async () => {
      throw new Error('disk full');
    };

    await expect(
      processor.execute('P-1', { type: 'requestDocDelete', path: 'a.md' }),
    ).rejects.toThrow('disk full');

    expect(readFileSync(join(projectDir, 'docs', 'a.md')).toString()).toContain('# A');
  });

  it('a_storage_failure_surfaces_as_an_error_not_a_rejection', async () => {
    await createProject();
    const failing = new Processor(bus, undefined, {
      docs: {
        save: () => {
          throw new StorageError('boom');
        },
        rename: () => {
          throw new StorageError('boom');
        },
        remove: () => {
          throw new StorageError('boom');
        },
      },
      workflows: {
        save: () => {
          throw new StorageError('boom');
        },
        remove: () => {
          throw new StorageError('boom');
        },
      },
    });

    await expect(
      failing.execute('P-1', { type: 'requestDocSave', path: 'x.md', content: 'x' }),
    ).rejects.toBeInstanceOf(StorageError);
  });
});