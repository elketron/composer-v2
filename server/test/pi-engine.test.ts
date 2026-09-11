import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiEngine,
  type PiSession,
  type PiSessionEvent,
} from "../src/engine/pi.js";
import type { AgentTurnEvent, AgentTurnSpec } from "../src/engine/types.js";

const turnSpec = (signal?: AbortSignal): AgentTurnSpec => ({
  sessionId: "thread-1",
  prompt: "inspect the project",
  serverUrl: "http://composer.test",
  mcpScriptPath: "/tmp/mcp.js",
  agentName: "composer-coder",
  timeoutMs: 1_000,
  ...(signal !== undefined ? { signal } : {}),
});

class StubPiSession implements PiSession {
  readonly sessionId = "pi-session-1";
  readonly abort = vi.fn(async () => undefined);
  readonly dispose = vi.fn();
  promptImpl: () => Promise<void> = async () => undefined;
  private readonly listeners = new Set<(event: PiSessionEvent) => void>();

  subscribe(listener: (event: PiSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(): Promise<void> {
    return this.promptImpl();
  }

  emit(event: PiSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PiEngine", () => {
  it("normalizes Pi text, tools, and cumulative usage into turn events", async () => {
    const session = new StubPiSession();
    session.promptImpl = async () => {
      session.emit({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Checked " },
      });
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "README.md" },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "contents" }] },
        isError: false,
      });
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "README." },
      });
      session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Checked README." }],
          usage: {
            input: 20,
            output: 4,
            cacheRead: 10,
            cacheWrite: 2,
            cost: { total: 0.25 },
          },
        },
      });
    };
    const createSession = vi.fn(async () => session);
    const events: AgentTurnEvent[] = [];
    const engine = new PiEngine({ createSession });

    await expect(
      engine.run(turnSpec(), (event) => events.push(event)),
    ).resolves.toEqual({
      ok: true,
      engineSessionId: "pi-session-1",
    });

    expect(events).toEqual([
      {
        kind: "messageDelta",
        messageId: "pi-session-1:message:1",
        delta: "Checked ",
      },
      {
        kind: "toolCall",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "README.md" },
      },
      {
        kind: "toolResult",
        toolCallId: "call-1",
        content: "contents",
        isError: false,
      },
      {
        kind: "messageDelta",
        messageId: "pi-session-1:message:1",
        delta: "README.",
      },
      {
        kind: "messageComplete",
        messageId: "pi-session-1:message:1",
        text: "Checked README.",
      },
      {
        kind: "usage",
        cost: 0.25,
        tokens: {
          input: 20,
          output: 4,
          reasoning: 0,
          cacheRead: 10,
          cacheWrite: 2,
        },
      },
    ]);
    expect(session.listenerCount()).toBe(0);
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("reuses a Pi session until Composer releases it", async () => {
    const first = new StubPiSession();
    const second = new StubPiSession();
    const createSession = vi
      .fn<() => Promise<PiSession>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const engine = new PiEngine({ createSession });

    await engine.run(turnSpec(), () => undefined);
    await engine.run(turnSpec(), () => undefined);
    expect(createSession).toHaveBeenCalledOnce();

    engine.releaseSession("thread-1");
    expect(first.dispose).toHaveBeenCalledOnce();
    await engine.run(turnSpec(), () => undefined);
    expect(createSession).toHaveBeenCalledTimes(2);

    engine.close();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("aborts and disposes the session without losing streamed partial text", async () => {
    const session = new StubPiSession();
    session.promptImpl = () =>
      new Promise<void>(() => {
        session.emit({ type: "message_start", message: { role: "assistant" } });
        session.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "partial" },
        });
      });
    const controller = new AbortController();
    const events: AgentTurnEvent[] = [];
    const engine = new PiEngine({ createSession: async () => session });

    const result = engine.run(turnSpec(controller.signal), (event) =>
      events.push(event),
    );
    await vi.waitFor(() => expect(session.listenerCount()).toBe(1));
    controller.abort();

    await expect(result).resolves.toEqual({
      ok: false,
      error: "aborted",
      engineSessionId: "pi-session-1",
    });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.listenerCount()).toBe(0);
    expect(events.at(-1)).toEqual({
      kind: "messageComplete",
      messageId: "pi-session-1:message:1",
      text: "partial",
    });
  });

  it("returns session creation failures as engine outcomes", async () => {
    const engine = new PiEngine({
      createSession: async () => {
        throw new Error("no configured model");
      },
    });

    await expect(engine.run(turnSpec(), () => undefined)).resolves.toEqual({
      ok: false,
      error: "pi session failed: no configured model",
    });
  });
});
