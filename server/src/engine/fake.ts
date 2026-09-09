// The scripted engine: no real LLM in automated tests (the testing rule).
// Each enqueued turn is a function that streams events through `emit` and
// may call the planner's domain tools — the same handlers the MCP server
// exposes — against the caller the fixture wired up.

import type {
  AgentEngine,
  AgentTurnEvent,
  AgentTurnOutcome,
  AgentTurnSpec,
} from './types.js';
import type { ComposerCaller } from '../agents/planner/index.js';
import { createTickets, editDocument } from '../agents/planner/index.js';

/** The tool surface a scripted turn sees (the planner's MCP tools). */
export interface FakeTurnTools {
  editDocument(document: string): Promise<{ ok: true } | { ok: false; message: string }>;
  createTickets(): Promise<{ ok: true; cards: number } | { ok: false; message: string }>;
}

export type FakeTurn = (context: {
  spec: AgentTurnSpec;
  tools: FakeTurnTools;
  emit: (event: AgentTurnEvent) => void;
}) => Promise<string | { error: string }>;

export class FakeEngine implements AgentEngine {
  readonly name = 'fake';
  private readonly turns: FakeTurn[] = [];
  readonly toolCalls: AgentTurnSpec[] = [];
  private emitted = 0;

  constructor(private readonly caller: ComposerCaller) {}

  /** Queues one scripted turn; turns run in enqueue order. */
  enqueue(turn: FakeTurn): void {
    this.turns.push(turn);
  }

  async run(
    spec: AgentTurnSpec,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<AgentTurnOutcome> {
    this.toolCalls.push(spec);
    const turn = this.turns.shift();
    // The final message completes the streamed one (the real engine pairs a
    // part's deltas and its complete on one id), so the scripted turn's
    // return rides the last delta's messageId when there is one.
    let lastDeltaId: string | undefined;
    const emit = (event: AgentTurnEvent): void => {
      if (event.kind === 'messageDelta') lastDeltaId = event.messageId;
      onEvent(event);
    };
    const tools: FakeTurnTools = {
      editDocument: (document) =>
        editDocument(this.caller, spec.projectId ?? '', spec.sessionId, document),
      createTickets: () =>
        createTickets(this.caller, spec.projectId ?? '', spec.sessionId),
    };
    if (turn === undefined) {
      return { ok: false, error: 'FakeEngine has no scripted turn left' };
    }
    const result = await turn({ spec, tools, emit });
    if (typeof result === 'string') {
      // The turn's reply is its final message.
      const messageId = lastDeltaId ?? `fake-${this.emitted++}`;
      onEvent({ kind: 'messageComplete', messageId, text: result });
      return { ok: true, engineSessionId: `fake-${spec.sessionId}` };
    }
    return { ok: false, error: result.error };
  }
}
