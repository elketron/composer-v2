// The global assistant's read tools (Phase 6): server-mediated reads over
// the thread's explicitly selected projects — composer state from the
// fold, bounded file reads inside the project directories, git status /
// log / diff, and restricted web fetches. No write surface exists: the
// assistant cannot edit files, run commands, or touch pipelines.
//
// Every tool validates the thread's scope at call time (the server is the
// authority — a scope change applies to in-flight conversations). File
// tools enforce real-path containment (symlink escapes reject), binary
// detection, and size caps; web tools enforce protocol, private-network,
// redirect, timeout, and response-size restrictions. Git and fetch are
// injected so tests never touch the network or a real repository.

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { RunRecord, State } from './fold.js';
import { readGitStatus, type GitRunner } from './dashboard.js';
import type { KnowledgeStore } from './knowledge.js';

/** One tool result, tool-shaped either way (rejections are content, not transport errors). */
export type ToolResult = { ok: true; content: string } | { ok: false; error: string };

/** The environment a tool executes against (injectable for tests). */
export interface AssistantToolEnv {
  /** The live fold (composer state reads). */
  state: State;
  /** The git runner (default: the dashboard's bounded execFile runner). */
  git?: GitRunner;
  /** The HTTP fetcher (default: global fetch). */
  fetchPage?: typeof fetch;
  /** The host resolver for the web tool's private-network guard. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** The knowledge library (the knowledge_search read). */
  knowledge?: KnowledgeStore;
}

export const ASSISTANT_TOOL_NAMES = [
  'composer_overview',
  'composer_card',
  'composer_plan',
  'knowledge_search',
  'list_files',
  'read_file',
  'git_status',
  'git_log',
  'git_diff',
  'web_fetch',
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

/**
 * The write-capable tools on the assistant's MCP surface: proposals are
 * drafted (validated, reversible via discard) and never create cards;
 * knowledge saves write only the composer data dir's library. Both are
 * dispatched by the route before the read executor.
 */
export const ASSISTANT_PROPOSAL_TOOL = 'propose_cards' as const;
export const ASSISTANT_KNOWLEDGE_SAVE_TOOL = 'knowledge_save' as const;

/** Every tool name the assistant's MCP child may call. */
export const ASSISTANT_MCP_TOOL_NAMES: readonly string[] = [
  ...ASSISTANT_TOOL_NAMES,
  ASSISTANT_PROPOSAL_TOOL,
  ASSISTANT_KNOWLEDGE_SAVE_TOOL,
];

export function isAssistantToolName(name: string): name is AssistantToolName {
  return (ASSISTANT_TOOL_NAMES as readonly string[]).includes(name);
}

// ---- Caps (bounds documented in the tool descriptions too) ----

const MAX_LIST_ENTRIES = 500;
const MAX_READ_BYTES = 64 * 1024;
const MAX_DIFF_BYTES = 16 * 1024;
const MAX_LOG_COMMITS = 20;
const MAX_WEB_BYTES = 256 * 1024;
const MAX_WEB_REDIRECTS = 3;
const WEB_TIMEOUT_MS = 10_000;

/** Executes one read tool for a thread. Scope is re-read from state per call. */
export async function executeAssistantTool(
  env: AssistantToolEnv,
  threadId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!isAssistantToolName(name)) {
    return { ok: false, error: `unknown tool ${name}` };
  }
  const thread = env.state.assistantThreads.get(threadId);
  if (!thread) {
    return { ok: false, error: `unknown thread ${threadId}` };
  }
  const scope = thread.projectIds;
  try {
    switch (name) {
      case 'composer_overview':
        return composerOverview(env.state, scope, optionalString(args['projectId']));
      case 'composer_card':
        return composerCard(env.state, scope, requiredString(args, 'projectId'), requiredString(args, 'cardId'));
      case 'composer_plan':
        return composerPlan(env.state, scope, requiredString(args, 'projectId'), optionalString(args['sessionId']));
      case 'knowledge_search':
        return knowledgeSearch(env.knowledge, requiredString(args, 'query'));
      case 'list_files':
        return listFiles(env.state, scope, requiredString(args, 'projectId'), optionalString(args['path']) ?? '.');
      case 'read_file':
        return readFile(env.state, scope, requiredString(args, 'projectId'), requiredString(args, 'path'));
      case 'git_status':
        return await gitStatus(env.state, scope, requiredString(args, 'projectId'), env.git);
      case 'git_log':
        return await gitLog(env.state, scope, requiredString(args, 'projectId'), args['limit'], env.git);
      case 'git_diff':
        return await gitDiff(env.state, scope, requiredString(args, 'projectId'), optionalString(args['path']), env.git);
      case 'web_fetch':
        return await webFetch(env, requiredString(args, 'url'));
    }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}

// ---- Composer state reads ----

function composerOverview(state: State, scope: string[], projectId: string | undefined): ToolResult {
  const ids = projectId !== undefined ? [projectId] : scope;
  if (ids.length === 0) {
    return { ok: false, error: 'the thread has no projects in scope' };
  }
  const unknown = ids.find((id) => !scope.includes(id));
  if (unknown !== undefined) {
    return { ok: false, error: `project ${unknown} is not in this thread's scope` };
  }
  const projects = ids
    .map((id) => state.projects.get(id))
    .filter((project): project is NonNullable<typeof project> => project !== undefined);
  if (projects.length === 0) {
    return { ok: false, error: `unknown project ${ids[0]}` };
  }

  const body = projects.map((project) => {
    const projectState = state.byProject.get(project.id);
    const cards = [...(projectState?.cards.values() ?? [])];
    const byStage: Record<string, number> = {};
    for (const card of cards) {
      const pipeline = projectState?.pipelines.get(card.pipelineId);
      const label = pipeline?.stages.find((stage) => stage.id === card.stageId)?.label ?? card.stageId;
      byStage[label] = (byStage[label] ?? 0) + 1;
    }
    const latestRunByCard = new Map<string, RunRecord>();
    for (const run of projectState?.runs.values() ?? []) {
      const latest = latestRunByCard.get(run.cardId);
      if (latest === undefined || run.startedAt >= latest.startedAt) latestRunByCard.set(run.cardId, run);
    }
    const runs = [...latestRunByCard.values()].map((run) => ({
      runId: run.id,
      cardId: run.cardId,
      cardTitle: projectState?.cards.get(run.cardId)?.title ?? run.cardId,
      pipelineId: run.pipelineId,
      status: run.status,
      ...(run.error !== undefined ? { error: run.error } : {}),
    }));
    const activeRuns = [...(projectState?.runs.values() ?? [])]
      .filter((run) => run.status === 'running' || run.status === 'waiting')
      .map((run) => ({
        runId: run.id,
        cardId: run.cardId,
        pipelineId: run.pipelineId,
        status: run.status,
        stepKind: run.stepKind,
      }));
    const sessions = [...(projectState?.planningSessions.values() ?? [])].map((session) => ({
      id: session.id,
      status: session.status,
      messages: session.messages.length,
      documentChars: session.planDocument.length,
    }));
    return {
      project: { id: project.id, name: project.name, ...(project.directory ? { directory: project.directory } : {}) },
      cards: { total: cards.length, byStage },
      activeRuns,
      latestRuns: runs,
      planningSessions: sessions,
    };
  });
  return { ok: true, content: JSON.stringify(projectId !== undefined ? body[0] : body, null, 2) };
}

function composerCard(state: State, scope: string[], projectId: string, cardId: string): ToolResult {
  const scopeError = scoped(scope, projectId);
  if (scopeError) return scopeError;
  const projectState = state.byProject.get(projectId);
  const card = projectState?.cards.get(cardId);
  if (!card) {
    return { ok: false, error: `unknown card ${cardId}` };
  }
  let latestRun: RunRecord | undefined;
  for (const run of projectState?.runs.values() ?? []) {
    if (run.cardId !== cardId) continue;
    if (latestRun === undefined || run.startedAt >= latestRun.startedAt) latestRun = run;
  }
  const transcriptSessions = [...(projectState?.agentSessions.values() ?? [])]
    .filter((session) => session.cardId === cardId)
    .map((session) => ({
      id: session.id,
      status: session.status,
      entries: session.transcript.length,
      ...(session.error !== undefined ? { error: session.error } : {}),
    }));
  return {
    ok: true,
    content: JSON.stringify(
      {
        ...card,
        ...(latestRun !== undefined ? { latestRun } : {}),
        agentSessions: transcriptSessions,
      },
      null,
      2,
    ),
  };
}

function composerPlan(state: State, scope: string[], projectId: string, sessionId: string | undefined): ToolResult {
  const scopeError = scoped(scope, projectId);
  if (scopeError) return scopeError;
  const sessions = [...(state.byProject.get(projectId)?.planningSessions.values() ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const session = sessionId !== undefined
    ? sessions.find((entry) => entry.id === sessionId)
    : sessions.at(-1);
  if (!session) {
    return {
      ok: false,
      error:
        sessionId !== undefined
          ? `unknown session ${sessionId}`
          : `project ${projectId} has no planning sessions`,
    };
  }
  return {
    ok: true,
    content: JSON.stringify(
      { id: session.id, status: session.status, planDocument: session.planDocument },
      null,
      2,
    ),
  };
}

// ---- File tools (real-path containment; symlinks cannot escape) ----

function projectDirectory(state: State, scope: string[], projectId: string): { base: string } | ToolResult {
  const scopeError = scoped(scope, projectId);
  if (scopeError) return scopeError;
  const directory = state.projects.get(projectId)?.directory;
  if (directory === undefined) {
    return { ok: false, error: `project ${projectId} has no directory set` };
  }
  let base: string;
  try {
    base = realpathSync(directory);
  } catch {
    return { ok: false, error: `project ${projectId}'s directory does not exist` };
  }
  return { base };
}

/** Resolves `path` inside `base` through the real filesystem; escapes reject. */
function containedPath(base: string, path: string): string {
  const joined = isAbsolute(path) ? path : resolve(base, path);
  const real = realpathSync(joined);
  if (real !== base && !real.startsWith(base + sep)) {
    throw new Error('path escapes the project directory');
  }
  return real;
}

/** Translates a containedPath failure: containment violations keep their message; ENOENT reads as not-found. */
function pathError(error: unknown, path: string): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('escapes')
    ? { ok: false, error: message }
    : { ok: false, error: `not a readable path: ${path}` };
}

function listFiles(state: State, scope: string[], projectId: string, path: string): ToolResult {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  let real: string;
  try {
    real = containedPath(found.base, path);
  } catch (error) {
    return pathError(error, path);
  }
  let entries;
  try {
    entries = readdirSync(real, { withFileTypes: true });
  } catch {
    return { ok: false, error: `not a readable directory: ${path}` };
  }
  const listing = entries
    .slice(0, MAX_LIST_ENTRIES)
    .map((entry) => {
      const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file';
      let size: number | undefined;
      if (kind === 'file') {
        try {
          size = lstatSync(resolve(real, entry.name)).size;
        } catch {
          size = undefined;
        }
      }
      return { name: entry.name, kind, ...(size !== undefined ? { size } : {}) };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return {
    ok: true,
    content: JSON.stringify(
      { path, entries: listing, truncated: entries.length > MAX_LIST_ENTRIES },
      null,
      2,
    ),
  };
}

function readFile(state: State, scope: string[], projectId: string, path: string): ToolResult {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  let real: string;
  try {
    real = containedPath(found.base, path);
  } catch (error) {
    return pathError(error, path);
  }
  let stat;
  try {
    stat = statSync(real);
  } catch {
    return { ok: false, error: `not a readable file: ${path}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `not a file: ${path}` };
  }
  const buffer = readFileSync(real);
  // Binary sniff: a NUL byte in the head, or mostly non-printable content.
  const head = buffer.subarray(0, 8192);
  if (head.includes(0) || (head.length > 0 && nonPrintableRatio(head) > 0.3)) {
    return {
      ok: true,
      content: JSON.stringify({ path, binary: true, size: stat.size }, null, 2),
    };
  }
  const text = buffer.subarray(0, MAX_READ_BYTES).toString('utf8');
  return {
    ok: true,
    content: JSON.stringify(
      {
        path,
        size: stat.size,
        truncated: stat.size > MAX_READ_BYTES,
        text,
      },
      null,
      2,
    ),
  };
}

function nonPrintableRatio(buffer: Buffer): number {
  let nonPrintable = 0;
  for (const byte of buffer) {
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable += 1;
  }
  return nonPrintable / buffer.length;
}

// ---- Knowledge reads (the save is a routed write, like propose_cards) ----

function knowledgeSearch(knowledge: KnowledgeStore | undefined, query: string): ToolResult {
  if (knowledge === undefined) {
    return { ok: false, error: 'knowledge storage is unavailable' };
  }
  const results = knowledge.search(query);
  return {
    ok: true,
    content: JSON.stringify(
      {
        query,
        results: results.map((result) => ({
          path: result.info.path,
          title: result.info.title,
          tags: result.info.tags,
          score: result.score,
          snippet: result.snippet,
        })),
      },
      null,
      2,
    ),
  };
}

// ---- Git tools (no shell; bounded output) ----

async function gitStatus(state: State, scope: string[], projectId: string, git: GitRunner | undefined): Promise<ToolResult> {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  const status = await readGitStatus(found.base, git);
  return { ok: true, content: JSON.stringify(status, null, 2) };
}

async function gitLog(state: State, scope: string[], projectId: string, limit: unknown, git: GitRunner | undefined): Promise<ToolResult> {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  const count = Math.min(Math.max(Number(limit) || 10, 1), MAX_LOG_COMMITS);
  const output = await runGit(found.base, ['log', `--max-count=${count}`, '--format=%h%x00%s%x00%cI'], git);
  const commits = output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [hash, subject, at] = line.split('\0');
      return { ...(hash ? { hash } : {}), ...(subject ? { subject } : {}), ...(at ? { at } : {}) };
    });
  return { ok: true, content: JSON.stringify({ commits }, null, 2) };
}

async function gitDiff(state: State, scope: string[], projectId: string, path: string | undefined, git: GitRunner | undefined): Promise<ToolResult> {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  const args = ['diff', '--no-color', ...(path !== undefined ? ['--', path] : [])];
  const output = await runGit(found.base, args, git);
  const truncated = output.length > MAX_DIFF_BYTES;
  return {
    ok: true,
    content: JSON.stringify(
      { ...(path !== undefined ? { path } : {}), truncated, diff: output.slice(0, MAX_DIFF_BYTES) },
      null,
      2,
    ),
  };
}

function runGit(directory: string, args: string[], git: GitRunner | undefined): Promise<string> {
  const runner = git ?? defaultGit;
  return runner(directory, args).catch((error) => {
    throw new Error(`git failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

const defaultGit: GitRunner = async (directory, args) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 512 * 1024,
  });
  return result.stdout;
};

// ---- Web fetch (https, public hosts, bounded) ----

async function webFetch(env: AssistantToolEnv, rawUrl: string): Promise<ToolResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid url' };
  }
  if (url.protocol !== 'https:' || url.hostname === '') {
    return { ok: false, error: 'only https urls are fetched' };
  }

  const resolveHost = env.resolveHost ?? defaultResolveHost;
  const fetchPage = env.fetchPage ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_WEB_REDIRECTS; hop++) {
    const addresses = await resolveHost(current.hostname).catch(() => []);
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      return { ok: false, error: `host ${current.hostname} is not reachable (private or unknown)` };
    }
    let response: Response;
    try {
      response = await fetchPage(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
        headers: { accept: 'text/*, application/json' },
      });
    } catch (error) {
      return { ok: false, error: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) {
        return { ok: false, error: `redirect without a location (${response.status})` };
      }
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, error: 'redirect location is not a valid url' };
      }
      if (current.protocol !== 'https:') {
        return { ok: false, error: 'redirect left https' };
      }
      continue;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^(text\/|application\/(json|xml))/.test(contentType)) {
      return { ok: false, error: `unsupported content-type: ${contentType || 'none'}` };
    }
    const body = await readCapped(response, MAX_WEB_BYTES);
    return {
      ok: true,
      content: JSON.stringify(
        {
          url: current.toString(),
          status: response.status,
          contentType,
          truncated: body.truncated,
          text: body.text,
        },
        null,
        2,
      ),
    };
  }
  return { ok: false, error: `too many redirects (>${MAX_WEB_REDIRECTS})` };
}

async function readCapped(response: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total >= cap) {
      chunks.push(value.subarray(0, value.byteLength - (total - cap)));
      truncated = true;
      void reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** True for global unicast addresses; false for loopback/private/link-local/etc. */
export function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return false; // link-local fe80::/10
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // unique local fc00::/7
    if (lower.startsWith('::ffff:')) return isPublicAddress(lower.slice('::ffff:'.length));
    return true;
  }
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  return true;
}

// ---- Shared guards ----

function scoped(scope: string[], projectId: string): ToolResult | null {
  if (!scope.includes(projectId)) {
    return { ok: false, error: `project ${projectId} is not in this thread's scope` };
  }
  return null;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`the ${key} argument is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
