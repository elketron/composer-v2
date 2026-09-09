// Shipping: writes Composer-owned agent definitions into place.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASSISTANT_DEFINITION } from './assistant/definition.js';
import { ASSISTANT_AGENT_NAME, CODER_AGENT_NAME, PLANNER_AGENT_NAME } from './names.js';
import { PLANNER_DEFINITION } from './planner/definition.js';
import {
  CODER_DEFINITION,
  REVIEWER_DEFINITION,
  SECURITY_DEFINITION,
  TESTER_DEFINITION,
} from './worker/definitions.js';

/** Refreshes the predefined agent definitions shipped by Composer. */
export function ensureAgentFiles(projectDirectory: string): void {
  const agentDirectory = join(projectDirectory, '.opencode', 'agent');
  mkdirSync(agentDirectory, { recursive: true });
  writeDefinition(agentDirectory, `${PLANNER_AGENT_NAME}.md`, PLANNER_DEFINITION);
  writeDefinition(agentDirectory, `${CODER_AGENT_NAME}.md`, CODER_DEFINITION);
  writeDefinition(agentDirectory, 'composer-tester.md', TESTER_DEFINITION);
  writeDefinition(agentDirectory, 'composer-reviewer.md', REVIEWER_DEFINITION);
  writeDefinition(agentDirectory, 'composer-security.md', SECURITY_DEFINITION);
}

/**
 * The global assistant's agent definition (Phase 6): threads are global, so
 * the definition lives in composer's own workspace (a scratch directory in
 * the data dir) — never inside a project the assistant only reads.
 */
export function ensureAssistantWorkspace(workspaceDirectory: string): void {
  const agentDirectory = join(workspaceDirectory, '.opencode', 'agent');
  mkdirSync(agentDirectory, { recursive: true });
  writeDefinition(agentDirectory, `${ASSISTANT_AGENT_NAME}.md`, ASSISTANT_DEFINITION);
}

function writeDefinition(directory: string, name: string, definition: string): void {
  writeFileSync(join(directory, name), definition);
}
