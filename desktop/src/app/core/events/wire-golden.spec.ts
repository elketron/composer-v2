import {
  EVENT_KINDS,
  EventFrameJson,
  WireAgentSessionStatus,
  WireCardType,
  WirePlanningSessionStatus,
  WireStage,
  WireSubStateStatus,
  domainEventKind,
  frameToDomainEvent,
} from './wire';
import fixture from '../../../../../wire-golden/events.json';

// The golden fixture is asserted on both sides: the server serializes its
// canonical frames to it (server/src/http.rs golden test), and this spec
// checks the desktop's wire types against it. Regenerate from the server:
//   cargo test -p composer-server golden_fixture_dump -- --ignored
const frames = fixture as unknown as EventFrameJson[];

const byKind = () => new Map(frames.map((frame) => [frame.eventType, frame]));

describe('wire-golden/events.json', () => {
  it('covers every event kind exactly once, in EVENT_KINDS order', () => {
    expect(frames.map((frame) => frame.eventType)).toEqual([...EVENT_KINDS]);
  });

  it('frames carry project scope and an RFC 3339 timestamp', () => {
    for (const frame of frames) {
      expect(frame.id).toBeTruthy();
      expect(frame.projectId).toBe('P-1');
      expect(Number.isNaN(Date.parse(frame.occurredAt))).toBe(false);
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
    expect(card['stage']).toBe(WireStage.STAGE_CODING);
    for (const status of Object.values(card['subState'] as Record<string, string>)) {
      expect(Object.values(WireSubStateStatus)).toContain(status);
    }

    const moved = kinds.get('cardMoved')?.body as { from: string; to: string };
    expect(moved.from).toBe(WireStage.STAGE_NEW);
    expect(moved.to).toBe(WireStage.STAGE_CODING);

    const typeChanged = kinds.get('cardTypeChanged')?.body as { from: string; to: string };
    expect(typeChanged.from).toBe(WireCardType.CARD_TYPE_CODING);
    expect(typeChanged.to).toBe(WireCardType.CARD_TYPE_DESIGN);

    const subState = kinds.get('subStateUpdated')?.body as { status: string };
    expect(subState.status).toBe(WireSubStateStatus.SUB_STATE_STATUS_RUNNING);

    const toggled = kinds.get('automationToggled')?.body as { lane: string };
    expect(toggled.lane).toBe(WireStage.STAGE_CODING);

    const session = (kinds.get('planningSessionCreated')?.body as { session: { status: string } })
      .session;
    expect(session.status).toBe(WirePlanningSessionStatus.PLANNING_SESSION_STATUS_DRAFTING);

    const completed = kinds.get('planningSessionCompleted')?.body as { sessionId: string };
    expect(completed.sessionId).toBe('S-1');

    const ended = kinds.get('agentSessionEnded')?.body as { status: string };
    expect(ended.status).toBe(WireAgentSessionStatus.AGENT_SESSION_STATUS_ENDED);
  });
});
