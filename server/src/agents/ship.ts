// Shipping: writes the agent definitions into place if absent —
// user-editable, never overwritten (idempotent).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ASSISTANT_DEFINITION,
  CODER_DEFINITION,
  PLANNER_DEFINITION,
  REVIEWER_DEFINITION,
  SECURITY_DEFINITION,
  TESTER_DEFINITION,
} from './definitions.js';
import { ASSISTANT_AGENT_NAME, CODER_AGENT_NAME, PLANNER_AGENT_NAME } from './names.js';

/** Writes the agent definitions into the project if absent. Idempotent. */
export function ensureAgentFiles(projectDirectory: string): void {
  const agentDirectory = join(projectDirectory, '.opencode', 'agent');
  mkdirSync(agentDirectory, { recursive: true });
  writeIfAbsent(agentDirectory, `${PLANNER_AGENT_NAME}.md`, PLANNER_DEFINITION);
  writeIfAbsent(agentDirectory, `${CODER_AGENT_NAME}.md`, CODER_DEFINITION);
  writeIfAbsent(agentDirectory, 'composer-tester.md', TESTER_DEFINITION);
  writeIfAbsent(agentDirectory, 'composer-reviewer.md', REVIEWER_DEFINITION);
  writeIfAbsent(agentDirectory, 'composer-security.md', SECURITY_DEFINITION);
}

/**
 * The global assistant's agent definition (Phase 6): threads are global, so
 * the definition lives in composer's own workspace (a scratch directory in
 * the data dir) — never inside a project the assistant only reads.
 */
export function ensureAssistantWorkspace(workspaceDirectory: string): void {
  const agentDirectory = join(workspaceDirectory, '.opencode', 'agent');
  mkdirSync(agentDirectory, { recursive: true });
  writeIfAbsent(agentDirectory, `${ASSISTANT_AGENT_NAME}.md`, ASSISTANT_DEFINITION);
}

function writeIfAbsent(directory: string, name: string, definition: string): void {
  const path = join(directory, name);
  if (!existsSync(path)) {
    writeFileSync(path, definition, { flag: 'wx' });
  }
}
