import { listFiles, readFile } from './filesystem.js';
import { gitDiff, gitLog, gitStatus } from './git.js';
import { optionalString, requiredString } from './guards.js';
import { isAssistantToolName, type AssistantToolName } from './names.js';
import { composerCard, composerOverview, composerPlan, knowledgeSearch } from './state.js';
import type { AssistantToolEnv, ToolResult } from './types.js';
import { webFetch } from './web.js';

type ToolHandler = (
  env: AssistantToolEnv,
  scope: string[],
  args: Record<string, unknown>,
) => ToolResult | Promise<ToolResult>;

const handlers: Record<AssistantToolName, ToolHandler> = {
  composer_overview: (env, scope, args) =>
    composerOverview(env.state, scope, optionalString(args['projectId'])),
  composer_card: (env, scope, args) =>
    composerCard(env.state, scope, requiredString(args, 'projectId'), requiredString(args, 'cardId')),
  composer_plan: (env, scope, args) =>
    composerPlan(env.state, scope, requiredString(args, 'projectId'), optionalString(args['sessionId'])),
  knowledge_search: (env, _scope, args) =>
    knowledgeSearch(env.knowledge, requiredString(args, 'query')),
  list_files: (env, scope, args) =>
    listFiles(env.state, scope, requiredString(args, 'projectId'), optionalString(args['path']) ?? '.'),
  read_file: (env, scope, args) =>
    readFile(env.state, scope, requiredString(args, 'projectId'), requiredString(args, 'path')),
  git_status: (env, scope, args) =>
    gitStatus(env.state, scope, requiredString(args, 'projectId'), env.git),
  git_log: (env, scope, args) =>
    gitLog(env.state, scope, requiredString(args, 'projectId'), args['limit'], env.git),
  git_diff: (env, scope, args) =>
    gitDiff(env.state, scope, requiredString(args, 'projectId'), optionalString(args['path']), env.git),
  web_fetch: (env, _scope, args) => webFetch(env, requiredString(args, 'url')),
};

/** Executes one read tool for a thread. Scope is re-read from state per call. */
export async function executeAssistantTool(
  env: AssistantToolEnv,
  threadId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!isAssistantToolName(name)) return { ok: false, error: `unknown tool ${name}` };
  const thread = env.state.assistantThreads.get(threadId);
  if (!thread) return { ok: false, error: `unknown thread ${threadId}` };
  const scope = thread.projectIds;
  try {
    return await handlers[name](env, scope, args);
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}
