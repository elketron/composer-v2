import {
  EVENT_KINDS,
  EventFrameJson,
  WireAgentSessionStatus,
  WireCardType,
  WirePipelineRunStatus,
  WirePlanningSessionStatus,
  WireStepStateStatus,
  domainEventKind,
  frameToDomainEvent,
} from './wire';
import fixture from '../../../../../wire-golden/events.json';

// The golden fixture is asserted on both sides: the server serializes its
// canonical frames to it (server/src/http.rs golden test), and this spec
// checks the desktop's wire types against it. Regenerate from the server:
//   cargo test -p composer-server golden_fixture_dump -- --ignored
const frames = fixture as unknown as EventFrameJson[];

/** Global assistant events carry no project scope (Phase 6). */
const GLOBAL_KINDS: ReadonlySet<string> = new Set([
  'assistantThreadCreated',
  'assistantThreadArchived',
  'assistantThreadRestored',
  'assistantThreadScopeChanged',
  'assistantUserMessage',
  'assistantMessageDelta',
  'assistantMessageComplete',
  'assistantThreadStopped',
  'assistantRetryRequested',
  'assistantThreadStatusChanged',
  'assistantThreadRenamed',
  'assistantResent',
  'assistantToolCall',
  'assistantToolResult',
  'proposalDrafted',
  'proposalConfirmed',
  'proposalDiscarded',
  'knowledgeSaved',
  'knowledgeDeleted',
]);

const byKind = () => new Map(frames.map((frame) => [frame.eventType, frame]));

describe('wire-golden/events.json', () => {
  it('covers every event kind exactly once, in EVENT_KINDS order', () => {
    expect(frames.map((frame) => frame.eventType)).toEqual([...EVENT_KINDS]);
  });

  it('frames carry scope and an RFC 3339 timestamp', () => {
    for (const frame of frames) {
      expect(frame.id).toBeTruthy();
      expect(Number.isNaN(Date.parse(frame.occurredAt))).toBe(false);
      if (GLOBAL_KINDS.has(frame.eventType)) {
        expect(frame.projectId).toBeUndefined();
      } else {
        expect(frame.projectId).toBe('P-1');
      }
    }
  });

  it('folds each frame into a oneof domain event carrying only its kind', () => {
    for (const frame of frames) {
      const event = frameToDomainEvent(frame);
      expect(domainEventKind(event)).toBe(frame.eventType);
      expect(event[frame.eventType]).toEqual(frame.body);
      for (const kind of EVENT_KINDS.filter((kind) => kind !== frame.eventType)) {
        expect(event[kind]).toBeUndefined();
      }
      expect(event.id).toBe(frame.id);
      expect(event.projectId).toBe(frame.projectId);
      expect(event.occurredAt).toBe(frame.occurredAt);
    }
  });

  it('enum-typed body fields are wire enum values', () => {
    const kinds = byKind();
    const card = (kinds.get('cardCreated')?.body as { card: Record<string, unknown> }).card;
    expect(Object.values(WireCardType)).toContain(card['type']);
    for (const status of Object.values(card['stepStates'] as Record<string, string>)) {
      expect(Object.values(WireStepStateStatus)).toContain(status);
    }

    const moved = kinds.get('cardLaneMoved')?.body as { fromLaneId: string; toLaneId: string };
    expect(moved.fromLaneId).toBe('ln-2');
    expect(moved.toLaneId).toBe('ln-3');

    const assigned = kinds.get('cardPipelineAssigned')?.body as { pipelineId: string; laneId: string };
    expect(assigned.pipelineId).toBe('PL-1');
    expect(assigned.laneId).toBe('ln-1');

    const typeChanged = kinds.get('cardTypeChanged')?.body as { from: string; to: string };
    expect(typeChanged.from).toBe(WireCardType.CARD_TYPE_CODING);
    expect(typeChanged.to).toBe(WireCardType.CARD_TYPE_DESIGN);

    const stepState = kinds.get('cardStepStateUpdated')?.body as { status: string };
    expect(stepState.status).toBe(WireStepStateStatus.STEP_STATE_RUNNING);

    const toggled = kinds.get('automationToggled')?.body as { pipelineId: string; laneId: string };
    expect(toggled.pipelineId).toBe('PL-1');
    expect(toggled.laneId).toBe('ln-2');

    const runEnded = kinds.get('pipelineRunEnded')?.body as { status: string };
    expect(Object.values(WirePipelineRunStatus)).toContain(runEnded.status);

    const session = (kinds.get('planningSessionCreated')?.body as { session: { status: string } })
      .session;
    expect(session.status).toBe(WirePlanningSessionStatus.PLANNING_SESSION_STATUS_DRAFTING);

    const completed = kinds.get('planningSessionCompleted')?.body as { sessionId: string };
    expect(completed.sessionId).toBe('S-1');

    const ended = kinds.get('agentSessionEnded')?.body as { status: string };
    expect(ended.status).toBe(WireAgentSessionStatus.AGENT_SESSION_STATUS_ENDED);
  });
});
