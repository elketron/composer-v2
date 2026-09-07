// The golden fixture guards the cross-language contract (v1 rule): the
// desktop asserts the same file, so a wire change breaks exactly one test
// on each side. Do not regenerate casually (pnpm golden).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFrame, type EventFrame } from '../src/wire/envelope.js';
import { EVENT_NAMES, GLOBAL_EVENTS, type EventName } from '../src/wire/events.js';

const fixturePath = join(import.meta.dirname, '..', '..', 'wire-golden', 'events.json');
const frames = JSON.parse(readFileSync(fixturePath, 'utf8')) as EventFrame[];

describe('wire-golden/events.json', () => {
  it('covers every event kind exactly once, in catalog order', () => {
    expect(frames.map((frame) => frame.eventType)).toEqual([...EVENT_NAMES]);
  });

  it('frames carry scope and an RFC 3339 timestamp', () => {
    for (const frame of frames) {
      expect(frame.id).toBeTruthy();
      expect(Number.isNaN(Date.parse(frame.occurredAt))).toBe(false);
      if (GLOBAL_EVENTS.has(frame.eventType as EventName)) {
        expect(frame.projectId).toBeUndefined();
      } else {
        expect(frame.projectId).toBe('P-1');
      }
    }
  });

  it('enum-typed body fields are wire enum values', () => {
    const byKind = new Map(frames.map((frame) => [frame.eventType as EventName, frame]));
    const card = (byKind.get('cardCreated')?.body as { card: Record<string, unknown> }).card;
    expect(['coding', 'design', 'docs']).toContain(card['type']);
    for (const status of Object.values(card['stepStates'] as Record<string, string>)) {
      expect(['pending', 'running', 'ok', 'failed']).toContain(status);
    }
    const runEnded = byKind.get('pipelineRunEnded')?.body as { status: string };
    expect(['running', 'waiting', 'completed', 'failed', 'returned', 'cancelled']).toContain(
      runEnded.status,
    );
  });

  it('every frame re-serializes identically (the server is the fixture source)', () => {
    for (const frame of frames) {
      const rebuilt = makeFrame({
        id: frame.id,
        ...(frame.projectId !== undefined ? { projectId: frame.projectId } : {}),
        occurredAt: frame.occurredAt,
        name: frame.eventType,
        body: frame.body,
      });
      expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(frame);
    }
  });
});
