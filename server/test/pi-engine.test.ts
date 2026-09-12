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
  agentName: "composer-coder",
  timeoutMs: 1_000,
  ...(signal !== undefined ? { signal } : {}),
});

class StubPiSession implements PiSession {
  readonly abort = vi.fn(async () => undefined);
  readonly dispose = vi.fn();
  readonly setModel = vi.fn(async (_configured?: string) => undefined);
  promptImpl: () => Promise<void> = async () => undefined;
  private readonly listeners = new Set<(event: PiSessionEvent) => void>();

  constructor(readonly sessionId = "pi-session-1") {}

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

    engine.releaseSession(turnSpec());
    expect(first.dispose).toHaveBeenCalledOnce();
    await engine.run(turnSpec(), () => undefined);
    expect(createSession).toHaveBeenCalledTimes(2);

    engine.close();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("isolates project-local session ids and releases only the matching session", async () => {
    const first = new StubPiSession("pi-project-1");
    const second = new StubPiSession("pi-project-2");
    const replacement = new StubPiSession("pi-project-1-replacement");
    const createSession = vi
      .fn<(spec: AgentTurnSpec) => Promise<PiSession>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(replacement);
    const engine = new PiEngine({ createSession });
    const projectOne = {
      ...turnSpec(),
      projectId: "project-1",
      mcpTools: "worker" as const,
    };
    const projectTwo = { ...projectOne, projectId: "project-2" };

    await engine.run(projectOne, () => undefined);
    await engine.run(projectTwo, () => undefined);
    await engine.run(projectOne, () => undefined);
    expect(createSession).toHaveBeenCalledTimes(2);

    engine.releaseSession(projectOne);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();

    await engine.run(projectOne, () => undefined);
    expect(createSession).toHaveBeenCalledTimes(3);
    engine.close();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(replacement.dispose).toHaveBeenCalledOnce();
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

  it("announces settled edit/write calls as cumulative file observations", async () => {
    const session = new StubPiSession();
    session.promptImpl = async () => {
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "write",
        args: { path: "hello.txt", content: "hi" },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "write",
        result: { content: [{ type: "text", text: "wrote hello.txt" }] },
        isError: false,
      });
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-2",
        toolName: "edit",
        args: { path: "/proj/src/deep.ts", edits: [] },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-2",
        toolName: "edit",
        result: { content: [{ type: "text", text: "edited" }] },
        isError: false,
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-3",
        toolName: "write",
        result: { content: [] },
        isError: true,
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-4",
        toolName: "bash",
        result: { content: [{ type: "text", text: "did something" }] },
        isError: false,
      });
    };
    const engine = new PiEngine({
      createSession: async () => session,
      git: { snapshot: async () => null, changes: async () => [] },
    });
    const events: AgentTurnEvent[] = [];

    await engine.run(
      { ...turnSpec(), projectDirectory: "/proj" },
      (event) => events.push(event),
    );

    expect(events.filter((event) => event.kind === "files")).toEqual([
      {
        kind: "files",
        files: [{ path: "hello.txt", additions: 0, deletions: 0 }],
      },
      {
        kind: "files",
        files: [
          { path: "hello.txt", additions: 0, deletions: 0 },
          { path: "src/deep.ts", additions: 0, deletions: 0 },
        ],
      },
    ]);
  });

  it("merges shell-created files and git counts into the end-of-turn observation", async () => {
    const session = new StubPiSession();
    session.promptImpl = async () => {
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "edit",
        args: { path: "src/a.ts", edits: [] },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "edit",
        result: { content: [] },
        isError: false,
      });
    };
    const engine = new PiEngine({
      createSession: async () => session,
      git: {
        snapshot: async (directory) => {
          expect(directory).toBe("/proj");
          return "tree-1";
        },
        changes: async (directory, snapshot) => {
          expect(directory).toBe("/proj");
          expect(snapshot).toBe("tree-1");
          return [
            { path: "src/a.ts", additions: 7, deletions: 2 },
            { path: "shell.txt", additions: 3, deletions: 0 },
          ];
        },
      },
    });
    const events: AgentTurnEvent[] = [];

    await engine.run(
      { ...turnSpec(), projectDirectory: "/proj" },
      (event) => events.push(event),
    );

    expect(events.filter((event) => event.kind === "files")).toEqual([
      {
        kind: "files",
        files: [{ path: "src/a.ts", additions: 0, deletions: 0 }],
      },
      {
        kind: "files",
        files: [
          { path: "src/a.ts", additions: 7, deletions: 2 },
          { path: "shell.txt", additions: 3, deletions: 0 },
        ],
      },
    ]);
  });

  it("keeps the turn outcome when the git observation fails", async () => {
    const session = new StubPiSession();
    session.promptImpl = async () => {
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "write",
        args: { path: "hello.txt", content: "hi" },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "write",
        result: { content: [] },
        isError: false,
      });
    };
    const engine = new PiEngine({
      createSession: async () => session,
      git: {
        snapshot: async () => "tree-1",
        changes: async () => {
          throw new Error("git blew up");
        },
      },
    });
    const events: AgentTurnEvent[] = [];

    await expect(
      engine.run({ ...turnSpec(), projectDirectory: "/proj" }, (event) =>
        events.push(event),
      ),
    ).resolves.toEqual({ ok: true, engineSessionId: "pi-session-1" });

    expect(events.filter((event) => event.kind === "files")).toEqual([
      {
        kind: "files",
        files: [{ path: "hello.txt", additions: 0, deletions: 0 }],
      },
    ]);
  });

  it("skips the git observation when the turn has no project directory", async () => {
    const session = new StubPiSession();
    const git = {
      snapshot: vi.fn(async () => "tree-1"),
      changes: vi.fn(async () => []),
    };
    const engine = new PiEngine({ createSession: async () => session, git });

    await expect(
      engine.run(turnSpec(), () => undefined),
    ).resolves.toEqual({ ok: true, engineSessionId: "pi-session-1" });

    expect(git.snapshot).not.toHaveBeenCalled();
    expect(git.changes).not.toHaveBeenCalled();
  });

  it("re-points a reused session only when the configured model changes", async () => {
    const session = new StubPiSession();
    const engine = new PiEngine({ createSession: async () => session });

    await engine.run({ ...turnSpec(), model: "llama/qwen3.8" }, () => undefined);
    await engine.run({ ...turnSpec(), model: "llama/qwen3.8" }, () => undefined);
    expect(session.setModel).not.toHaveBeenCalled();

    await engine.run({ ...turnSpec(), model: "llama/qwen3.6-27b" }, () => undefined);
    expect(session.setModel).toHaveBeenCalledOnce();
    expect(session.setModel).toHaveBeenCalledWith("llama/qwen3.6-27b");

    // Removing the override restores the runtime-selected default.
    await engine.run(turnSpec(), () => undefined);
    expect(session.setModel).toHaveBeenCalledTimes(2);
    expect(session.setModel).toHaveBeenLastCalledWith(undefined);
  });

  it("fails the turn when the new model cannot be applied", async () => {
    const session = new StubPiSession();
    session.setModel.mockRejectedValue(new Error("Pi model not found: nope/bad"));
    session.promptImpl = vi.fn(async () => undefined);
    const engine = new PiEngine({ createSession: async () => session });

    await engine.run({ ...turnSpec(), model: "llama/qwen3.8" }, () => undefined);
    session.promptImpl.mockClear();
    await expect(
      engine.run({ ...turnSpec(), model: "nope/bad" }, () => undefined),
    ).resolves.toEqual({
      ok: false,
      error: "pi model failed: Pi model not found: nope/bad",
      engineSessionId: "pi-session-1",
    });
    expect(session.promptImpl).not.toHaveBeenCalled();
  });
});
