// The shared turn coordination (SRV-013): the one lifecycle both the
// planning and assistant orchestrators run, extracted into a hook-driven
// coordinator rather than a common base class. It owns the mechanics that
// are identical across the two — the subscription lifecycle, the one-turn
// in-flight lock, engine-session continuity, transcript-index reservations,
// and the "drive until no new user message is queued" loop — and delegates
// the domain-specific parts (active/predication, provisioning, spec build,
// event routing, failure/queued handling) to hooks the orchestrator closes
// over.

import type { Bus } from './bus.js';
import type { EventFrame } from './wire/envelope.js';
import type {
  AgentEngine,
  AgentTurnEvent,
  AgentTurnOutcome,
  AgentTurnSpec,
} from './engine/types.js';
import { ReservedIndexes, userMessageCount } from './domain/transcript.js';

export interface TurnHooks {
  /** The console.error label for a turn crash. */
  label: string;
  /** The conversation is still runnable (drafting / not archived). */
  active(conversationId: string): boolean;
  /** Ship the agent definition / workspace before the turn (best-effort). */
  provision(conversationId: string): void;
  /** Build the turn spec (prompt, settings, mcpTools, signal…). */
  buildSpec(conversationId: string, text: string, engineSessionId: string | undefined): Promise<AgentTurnSpec>;
  /** Route one streamed engine event into the domain's publish path. */
  onEvent(conversationId: string, event: AgentTurnEvent): void;
  /** A turn failed — publish the domain's failure (and terminal status). */
  onFailure(conversationId: string, outcome: AgentTurnOutcome): Promise<void>;
  /** A turn succeeded — flush the domain's buffered completion (optional). */
  onSuccess?(conversationId: string): Promise<void>;
  /** After a turn, the next queued user message (or null when done). */
  nextQueued(conversationId: string, count: number): { text: string; count: number } | null;
  /** The user-message count at a turn's start (the in-flight watermark). */
  userCount(conversationId: string): number;
  /** Pre-run hook (sets an abort controller / reply lineage). */
  beforeRun?(conversationId: string): void;
  /** Post-run cleanup a turn leaves behind (controllers, stream buffers). */
  cleanup?(conversationId: string): void;
}

/** The queued-follower probe both orchestrators run after a turn. */
export function nextQueuedMessage<
  T extends { messages: readonly { role: string; text: string }[] },
>(
  get: () => T | undefined,
  count: number,
): { text: string; count: number } | null {
  const state = get();
  const countNow = state === undefined ? count : userMessageCount(state.messages);
  if (countNow === count) return null;
  // Only a new HUMAN message is a queued turn; pick up its text.
  const queued = state?.messages.filter((message) => message.role === 'user') ?? [];
  return { text: queued.at(-1)?.text ?? '', count: countNow };
}

export class TurnCoordinator {
  /** Transcript index reservations, shared by the event-routing closures. */
  readonly indexes = new ReservedIndexes();
  private readonly engineSessions = new Map<string, string>();
  private readonly inFlight = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly bus: Bus,
    private readonly engine: AgentEngine,
    private readonly hooks: TurnHooks,
  ) {}

  /** Subscribes with a handler that reports failures under the hook's label. */
  start(onFrame: (frame: EventFrame) => Promise<void>): void {
    this.unsubscribe = this.bus.subscribe((frame) => {
      void onFrame(frame).catch((error) => console.error(`${this.hooks.label}:`, error));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  isRunning(conversationId: string): boolean {
    return this.inFlight.has(conversationId);
  }

  /** Drives turns until the conversation is idle; a queued follower coalesces. */
  async runTurn(conversationId: string, firstText: string): Promise<void> {
    if (this.inFlight.has(conversationId)) return;
    if (!this.hooks.active(conversationId)) return;
    const count = this.hooks.userCount(conversationId);
    this.inFlight.set(conversationId, count);
    try {
      await this.loop(conversationId, count, firstText);
    } finally {
      this.inFlight.delete(conversationId);
      this.indexes.release(conversationId);
      this.hooks.cleanup?.(conversationId);
    }
  }

  private async loop(conversationId: string, count: number, firstText: string): Promise<void> {
    let text = firstText;
    for (;;) {
      if (!this.hooks.active(conversationId)) return;
      this.hooks.provision(conversationId);
      this.hooks.beforeRun?.(conversationId);
      const spec = await this.hooks.buildSpec(
        conversationId,
        text,
        this.engineSessions.get(conversationId),
      );
      const outcome = await this.engine.run(spec, (event) => this.hooks.onEvent(conversationId, event));
      if (outcome.engineSessionId !== undefined) {
        this.engineSessions.set(conversationId, outcome.engineSessionId);
      }
      if (!outcome.ok) {
        await this.hooks.onFailure(conversationId, outcome);
        return;
      }
      await this.hooks.onSuccess?.(conversationId);
      const next = this.hooks.nextQueued(conversationId, count);
      if (next === null) return;
      text = next.text;
      count = next.count;
    }
  }
}