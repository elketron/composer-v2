import {
  ASSISTANT_AGENT_NAME,
  CODER_AGENT_NAME,
  PLANNER_AGENT_NAME,
} from "../agents/names.js";
import { ASSISTANT_DEFINITION } from "../agents/assistant/definition.js";
import { PLANNER_DEFINITION } from "../agents/planner/definition.js";
import {
  CODER_DEFINITION,
  REVIEWER_DEFINITION,
  SECURITY_DEFINITION,
  TESTER_DEFINITION,
} from "../agents/worker/definitions.js";
import type {
  AgentEngine,
  AgentTurnEvent,
  AgentTurnOutcome,
  AgentTurnSpec,
  UsageTokens,
} from "./types.js";

/** The small Pi session surface the engine needs, kept injectable for tests. */
export interface PiSession {
  readonly sessionId: string;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  prompt(
    text: string,
    options?: { expandPromptTemplates?: boolean },
  ): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

/** Pi's relevant event fields, structurally compatible with AgentSessionEvent. */
export interface PiSessionEvent {
  type: string;
  message?: PiMessage;
  assistantMessageEvent?: { type: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

interface PiMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
}

export type PiSessionFactory = (spec: AgentTurnSpec) => Promise<PiSession>;

export interface PiEngineOptions {
  createSession?: PiSessionFactory;
  defaultTimeoutMs?: number;
}

interface SessionEntry {
  session: PiSession;
  nextMessage: number;
}

/**
 * In-process Pi adapter. It deliberately sits behind the existing engine
 * contract so orchestrators and the desktop do not consume Pi wire types.
 */
export class PiEngine implements AgentEngine {
  readonly name = "pi";
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly createSession: PiSessionFactory;
  private readonly defaultTimeoutMs: number;

  constructor(options: PiEngineOptions = {}) {
    this.createSession = options.createSession ?? createSdkPiSessionFactory();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;
  }

  async run(
    spec: AgentTurnSpec,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<AgentTurnOutcome> {
    let entry = this.sessions.get(spec.sessionId);
    if (entry === undefined) {
      try {
        entry = { session: await this.createSession(spec), nextMessage: 0 };
        this.sessions.set(spec.sessionId, entry);
      } catch (error) {
        return { ok: false, error: `pi session failed: ${errorText(error)}` };
      }
    }

    const usage = emptyUsage();
    let cost = 0;
    let activeMessageId: string | undefined;
    let activeText = "";
    const messageId = (): string => {
      if (activeMessageId === undefined) {
        activeMessageId = `${entry.session.sessionId}:message:${++entry.nextMessage}`;
      }
      return activeMessageId;
    };
    const unsubscribe = entry.session.subscribe((event) => {
      switch (event.type) {
        case "message_start":
          if (event.message?.role === "assistant") {
            activeMessageId = undefined;
            activeText = "";
            messageId();
          }
          return;
        case "message_update":
          if (event.assistantMessageEvent?.type === "text_delta") {
            const delta = event.assistantMessageEvent.delta ?? "";
            if (delta !== "") {
              activeText += delta;
              onEvent({ kind: "messageDelta", messageId: messageId(), delta });
            }
          }
          return;
        case "message_end":
          if (event.message?.role !== "assistant") return;
          activeText = messageText(event.message) || activeText;
          if (activeText !== "") {
            onEvent({
              kind: "messageComplete",
              messageId: messageId(),
              text: activeText,
            });
          }
          addUsage(usage, event.message.usage);
          cost += event.message.usage?.cost?.total ?? 0;
          if (cost !== 0 || sumUsage(usage) !== 0) {
            onEvent({ kind: "usage", cost, tokens: { ...usage } });
          }
          activeMessageId = undefined;
          activeText = "";
          return;
        case "tool_execution_start":
          if (event.toolCallId !== undefined) {
            onEvent({
              kind: "toolCall",
              toolCallId: event.toolCallId,
              toolName: event.toolName ?? "tool",
              ...(event.args !== undefined ? { args: event.args } : {}),
            });
          }
          return;
        case "tool_execution_end":
          if (event.toolCallId !== undefined) {
            onEvent({
              kind: "toolResult",
              toolCallId: event.toolCallId,
              content: resultText(event.result),
              isError: event.isError ?? false,
            });
          }
          return;
      }
    });

    let cancelTurn!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelTurn = () => reject(TURN_ABORTED);
    });
    let cancelledLocally = false;
    const abortTurn = (): void => {
      if (cancelledLocally) return;
      cancelledLocally = true;
      cancelTurn();
      void entry.session.abort().catch(() => undefined);
    };
    const timeout = setTimeout(
      abortTurn,
      spec.timeoutMs > 0 ? spec.timeoutMs : this.defaultTimeoutMs,
    );
    timeout.unref?.();
    if (spec.signal?.aborted) abortTurn();
    else spec.signal?.addEventListener("abort", abortTurn, { once: true });

    try {
      await Promise.race([
        entry.session.prompt(spec.prompt, { expandPromptTemplates: false }),
        cancelled,
      ]);
      return { ok: true, engineSessionId: entry.session.sessionId };
    } catch (error) {
      if (activeMessageId !== undefined && activeText !== "") {
        onEvent({
          kind: "messageComplete",
          messageId: activeMessageId,
          text: activeText,
        });
      }
      if (error === TURN_ABORTED) {
        this.releaseSession(spec.sessionId);
        return {
          ok: false,
          error: "aborted",
          engineSessionId: entry.session.sessionId,
        };
      }
      return {
        ok: false,
        error: `pi turn failed: ${errorText(error)}`,
        engineSessionId: entry.session.sessionId,
      };
    } finally {
      clearTimeout(timeout);
      spec.signal?.removeEventListener("abort", abortTurn);
      unsubscribe();
    }
  }

  releaseSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    this.sessions.delete(sessionId);
    entry.session.dispose();
  }

  close(): void {
    for (const sessionId of [...this.sessions.keys()])
      this.releaseSession(sessionId);
  }
}

/** Real SDK factory; production boot can opt into it after parity gates pass. */
export function createSdkPiSessionFactory(): PiSessionFactory {
  let runtimePromise: Promise<
    import("@earendil-works/pi-coding-agent").ModelRuntime
  > | null = null;
  return async (spec) => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    runtimePromise ??= sdk.ModelRuntime.create();
    const modelRuntime = await runtimePromise;
    const cwd = spec.projectDirectory ?? process.cwd();
    const settingsManager = sdk.SettingsManager.inMemory();
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: sdk.getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: sdk.stripFrontmatter(agentDefinition(spec.agentName)),
    });
    await resourceLoader.reload();
    const model = resolveModel(modelRuntime, spec.model);
    const result = await sdk.createAgentSession({
      cwd,
      modelRuntime,
      ...(model !== undefined ? { model } : {}),
      ...toolOptions(spec.agentName),
      resourceLoader,
      settingsManager,
      sessionManager: sdk.SessionManager.inMemory(
        cwd,
        spec.engineSessionId !== undefined
          ? { id: spec.engineSessionId }
          : undefined,
      ),
    });
    const session = result.session;
    return {
      sessionId: session.sessionId,
      subscribe: (listener) =>
        session.subscribe((event) => listener(event as PiSessionEvent)),
      prompt: (text, options) => session.prompt(text, options),
      abort: () => session.abort(),
      dispose: () => session.dispose(),
    };
  };
}

function resolveModel(
  runtime: import("@earendil-works/pi-coding-agent").ModelRuntime,
  configured: string | undefined,
): ReturnType<
  import("@earendil-works/pi-coding-agent").ModelRuntime["getModel"]
> {
  if (configured === undefined || configured.trim() === "") return undefined;
  const separator = configured.indexOf("/");
  if (separator < 1 || separator === configured.length - 1) {
    throw new Error(
      `invalid Pi model id ${configured}; expected provider/model`,
    );
  }
  const provider = configured.slice(0, separator);
  const modelId = configured.slice(separator + 1);
  const model = runtime.getModel(provider, modelId);
  if (model === undefined) throw new Error(`Pi model not found: ${configured}`);
  return model;
}

function agentDefinition(name: string): string {
  switch (name) {
    case PLANNER_AGENT_NAME:
      return PLANNER_DEFINITION;
    case CODER_AGENT_NAME:
      return CODER_DEFINITION;
    case "composer-tester":
      return TESTER_DEFINITION;
    case "composer-reviewer":
      return REVIEWER_DEFINITION;
    case "composer-security":
      return SECURITY_DEFINITION;
    case ASSISTANT_AGENT_NAME:
      return ASSISTANT_DEFINITION;
    default:
      throw new Error(`unknown Pi agent ${name}`);
  }
}

function toolOptions(name: string): {
  tools?: string[];
  noTools?: "all";
} {
  switch (name) {
    case CODER_AGENT_NAME:
    case "composer-tester":
      return { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] };
    case "composer-reviewer":
    case "composer-security":
      return { tools: ["read", "bash", "grep", "find", "ls"] };
    default:
      // Planner and assistant await their path-restricted/Composer custom
      // tools before Pi is eligible for production boot.
      return { noTools: "all" };
  }
}

function messageText(message: PiMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function resultText(result: unknown): string {
  if (result !== null && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part): part is { type: string; text: string } =>
            part !== null &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        )
        .map((part) => part.text)
        .join("\n");
      if (text !== "") return text;
    }
  }
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result) ?? "";
  } catch {
    return String(result);
  }
}

function emptyUsage(): UsageTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function addUsage(target: UsageTokens, usage: PiMessage["usage"]): void {
  target.input += usage?.input ?? 0;
  target.output += usage?.output ?? 0;
  target.cacheRead += usage?.cacheRead ?? 0;
  target.cacheWrite += usage?.cacheWrite ?? 0;
}

function sumUsage(tokens: UsageTokens): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cacheRead +
    tokens.cacheWrite
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TURN_ABORTED = Symbol("turn aborted");
