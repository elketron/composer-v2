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
import { piCustomTools } from "./pi-tools.js";
import {
  changedFilesSince,
  snapshotWorkingTree,
  type WorkingTreeSnapshot,
} from "../filesystem/git-changes.js";
import type {
  AgentEngine,
  AgentTurnEvent,
  AgentTurnOutcome,
  AgentTurnSpec,
  FileObservation,
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
  /** Re-points the session's model (a settings change between turns). */
  setModel?(configured: string | undefined): Promise<void>;
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

/**
 * The git seam: working-tree change detection around a turn, so
 * shell-created files are observed alongside native edit/write results.
 */
export interface PiGitChanges {
  /** Snapshot the directory's working tree; null when git is unavailable. */
  snapshot(directory: string): Promise<unknown>;
  /** The files changed since the snapshot (git-computed counts). */
  changes(directory: string, snapshot: unknown): Promise<FileObservation[]>;
}

export interface PiEngineOptions {
  createSession?: PiSessionFactory;
  git?: PiGitChanges;
  defaultTimeoutMs?: number;
}

interface SessionEntry {
  session: PiSession;
  nextMessage: number;
  /** The configured model the session currently runs (the last applied). */
  model?: string;
}

/**
 * In-process Pi adapter. It deliberately sits behind the existing engine
 * contract so orchestrators and the desktop do not consume Pi wire types.
 */
export class PiEngine implements AgentEngine {
  readonly name = "pi";
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly createSession: PiSessionFactory;
  private readonly git: PiGitChanges;
  private readonly defaultTimeoutMs: number;

  constructor(options: PiEngineOptions = {}) {
    this.createSession = options.createSession ?? createSdkPiSessionFactory();
    this.git = options.git ?? createExecGitChanges();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;
  }

  async run(
    spec: AgentTurnSpec,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<AgentTurnOutcome> {
    const key = sessionKey(spec);
    let entry = this.sessions.get(key);
    if (entry === undefined) {
      try {
        entry = { session: await this.createSession(spec), nextMessage: 0, model: spec.model };
        this.sessions.set(key, entry);
      } catch (error) {
        return { ok: false, error: `pi session failed: ${errorText(error)}` };
      }
    } else if (spec.model !== entry.model) {
      // A settings change between turns rides the next prompt: re-point the
      // live session (a model the runtime cannot resolve fails the turn).
      try {
        await entry.session.setModel?.(spec.model);
        entry.model = spec.model;
      } catch (error) {
        return {
          ok: false,
          error: `pi model failed: ${errorText(error)}`,
          engineSessionId: entry.session.sessionId,
        };
      }
    }

    const usage = emptyUsage();
    let cost = 0;
    let activeMessageId: string | undefined;
    let activeText = "";
    // The turn's file observations: completed edit/write calls announce
    // their path immediately, and the working-tree diff around the turn
    // adds shell-created files (the run view's diff list reads these).
    const edited = new Map<string, FileObservation>();
    // Pi's tool start events carry the call's args; its end events carry
    // only the result — the path rides the start event.
    const toolArgs = new Map<string, unknown>();
    const before =
      spec.projectDirectory !== undefined
        ? await this.git.snapshot(spec.projectDirectory).catch(() => null)
        : null;
    const emitChanges = async (): Promise<void> => {
      if (spec.projectDirectory === undefined || before === null) return;
      let observed: FileObservation[] = [];
      try {
        observed = await this.git.changes(spec.projectDirectory, before);
      } catch {
        return;
      }
      const merged = new Map(edited);
      for (const file of observed) merged.set(file.path, file);
      if (merged.size > 0) onEvent({ kind: "files", files: [...merged.values()] });
    };
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
            toolArgs.set(event.toolCallId, event.args);
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
            // A settled native edit/write names its file for the diff
            // list; failed calls did not write anything.
            if (
              (event.toolName === "edit" || event.toolName === "write") &&
              !event.isError
            ) {
              const path = editedPath(
                toolArgs.get(event.toolCallId),
                spec.projectDirectory,
              );
              if (path !== undefined && !edited.has(path)) {
                edited.set(path, { path, additions: 0, deletions: 0 });
                onEvent({ kind: "files", files: [...edited.values()] });
              }
            }
            toolArgs.delete(event.toolCallId);
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
        this.releaseSession(spec);
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
      await emitChanges();
    }
  }

  releaseSession(spec: AgentTurnSpec): void {
    const key = sessionKey(spec);
    const entry = this.sessions.get(key);
    if (entry === undefined) return;
    this.sessions.delete(key);
    entry.session.dispose();
  }

  close(): void {
    for (const entry of this.sessions.values()) entry.session.dispose();
    this.sessions.clear();
  }
}

/** Real SDK factory; production boot can opt into it after parity gates pass. */
export function createSdkPiSessionFactory(): PiSessionFactory {
  return async (spec) => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const modelRuntime = await piModelRuntime();
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
      systemPrompt: agentDefinition(spec.agentName),
    });
    await resourceLoader.reload();
    const configuredModel = resolveModel(modelRuntime, spec.model);
    const customTools = piCustomTools(spec);
    const result = await sdk.createAgentSession({
      cwd,
      modelRuntime,
      ...toolOptions(spec.agentName, customTools),
      customTools,
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
    const defaultModel = session.model;
    if (configuredModel !== undefined) await session.setModel(configuredModel);
    return {
      sessionId: session.sessionId,
      subscribe: (listener) =>
        session.subscribe((event) => listener(event as PiSessionEvent)),
      prompt: (text, options) => session.prompt(text, options),
      setModel: async (configured) => {
        const model = resolveModel(modelRuntime, configured) ?? defaultModel;
        if (model === undefined) throw new Error("Pi default model unavailable");
        await session.setModel(model);
      },
      abort: () => session.abort(),
      dispose: () => session.dispose(),
    };
  };
}

/** Composer session IDs are local to their project and orchestration surface. */
function sessionKey(spec: AgentTurnSpec): string {
  return JSON.stringify([
    spec.projectId ?? null,
    spec.mcpTools ?? "none",
    spec.agentName,
    spec.sessionId,
  ]);
}

/** The process-shared Pi model runtime (the catalog, credentials, models). */
let modelRuntimePromise: Promise<
  import("@earendil-works/pi-coding-agent").ModelRuntime
> | null = null;
export function piModelRuntime(): Promise<
  import("@earendil-works/pi-coding-agent").ModelRuntime
> {
  modelRuntimePromise ??= import(
    "@earendil-works/pi-coding-agent"
  ).then((sdk) => sdk.ModelRuntime.create());
  return modelRuntimePromise;
}

/**
 * The Pi model catalog (gate 5): the models the runtime can actually use —
 * its credential resolution covers stored credentials, environment
 * variables, and custom providers' own keys, the same resolution a turn
 * performs. The flat `provider/model` spelling the settings model already
 * persists.
 */
export async function listPiModels(): Promise<string[]> {
  const runtime = await piModelRuntime();
  const available = await runtime.getAvailable();
  return [
    ...new Set(available.map((model) => `${model.provider}/${model.id}`)),
  ].sort((left, right) => left.localeCompare(right));
}

/** The real git observation: working-tree snapshots via a throwaway index. */
function createExecGitChanges(): PiGitChanges {
  return {
    snapshot: (directory) => snapshotWorkingTree(directory),
    changes: (directory, snapshot) =>
      changedFilesSince(directory, snapshot as WorkingTreeSnapshot),
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

function toolOptions(
  name: string,
  customTools: ReturnType<typeof piCustomTools>,
): { tools: string[] } {
  return { tools: [...builtinTools(name), ...customTools.map((tool) => tool.name)] };
}

/** The built-in surface per shipped agent (the custom tools ride on top). */
function builtinTools(name: string): string[] {
  switch (name) {
    case CODER_AGENT_NAME:
    case "composer-tester":
      return ["read", "bash", "edit", "write", "grep", "find", "ls"];
    case "composer-reviewer":
    case "composer-security":
      return ["read", "bash", "grep", "find", "ls"];
    case PLANNER_AGENT_NAME:
      // The plan document is the planner's one artifact; its edits go
      // through the path-fixed composer_edit_plan tool.
      return ["read"];
    case ASSISTANT_AGENT_NAME:
      return [];
    default:
      return ["read"];
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

/**
 * The file path a Pi edit/write call targets (defensive on the input
 * shape), relative to the turn's directory when it lives inside it — the
 * same spelling git's --relative observation uses, so the two merge.
 */
function editedPath(
  args: unknown,
  directory: string | undefined,
): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const candidate = (args as Record<string, unknown>)["path"];
  if (typeof candidate !== "string" || candidate.trim() === "") return undefined;
  const path = candidate.trim();
  if (directory === undefined) return path;
  const prefix = `${directory.replace(/[\\/]+$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
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
