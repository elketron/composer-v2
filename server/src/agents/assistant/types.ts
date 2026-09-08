import type { GitRunner } from '../../dashboard/git.js';
import type { State } from '../../fold/index.js';
import type { KnowledgeStore } from '../../knowledge.js';

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
