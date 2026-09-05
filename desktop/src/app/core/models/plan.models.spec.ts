import {
  ChatMessage,
  PlanningSession,
  normalizePlanningSessionStatus,
} from './plan.models';

describe('plan models', () => {
  it('normalizes session status and message roles', () => {
    expect(normalizePlanningSessionStatus('done')).toBe('DONE');
    expect(normalizePlanningSessionStatus('drafting')).toBe('DRAFTING');
    expect(normalizePlanningSessionStatus(undefined)).toBe('DRAFTING');

    const message = new ChatMessage({ index: 2, role: 'AGENT', text: 'reply' });
    expect(message.isAgent).toBe(true);
    expect(message.with({ text: 'edited' }).text).toBe('edited');
  });

  it('allocates the next transcript turn from the highest message index', () => {
    const session = new PlanningSession({
      id: 'S-1',
      projectId: 'P-1',
      messages: [
        new ChatMessage({ index: 1, role: 'user', text: 'one' }),
        new ChatMessage({ index: 2, role: 'agent', text: 'answer' }),
      ],
    });

    expect(session.nextMessageIndex).toBe(3);
  });

  it('defaults a fresh session to drafting with an empty document', () => {
    const session = new PlanningSession({ id: 'S-1', projectId: 'P-1' });

    expect(session.status).toBe('DRAFTING');
    expect(session.isDone).toBe(false);
    expect(session.planDocument).toBe('');
    expect(session.with({ status: 'DONE' }).isDone).toBe(true);
  });

  it('coerces plain data into message and session models', () => {
    const session = new PlanningSession({
      id: 'S-1',
      projectId: 'P-1',
      status: 'done',
      messages: [{ index: 1, role: 'user', text: 'one' }],
      planDocument: 'doc',
    });

    expect(session.status).toBe('DONE');
    expect(session.messages[0] instanceof ChatMessage).toBe(true);
    expect(session.planDocument).toBe('doc');
  });
});
