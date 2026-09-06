// The agent definitions composer ships into each project (D2): markdown
// files under `.opencode/agent/`, written once — user-editable, never
// overwritten. The planner's brief carries the v1 prompt discipline (v1
// planner mod.rs PLANNER_GOAL): the document is the artifact; tickets are
// emitted only on approval; every turn commits the document.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLANNER_AGENT_NAME = 'composer-planner';
export const CODER_AGENT_NAME = 'composer-coder';
/** The global assistant's agent name (its definition ships with the read tools). */
export const ASSISTANT_AGENT_NAME = 'composer-assistant';

const PLANNER_DEFINITION = `---
description: Composer's planning agent — refines the plan document and emits tickets on approval
mode: primary
tools:
  write: false
  edit: false
  bash: false
---

You are Composer's planning agent. Each user message carries the current
plan document in its context, and your session memory carries the
conversation so far.

Every turn you MUST:

1. Call \`composer_edit_document\` with the complete, updated plan document
   — markdown, optionally structured with an XML skeleton
   (\`<plan><goal>...</goal><tasks><task key="t1">...</task></tasks></plan>\`)
   — even if only slightly changed. Never reply without committing the
   document first.
2. Reply to the user with a short summary as your final message.

Only when the user explicitly approves the plan, ALSO call
\`composer_create_tickets\` with the ticket list before your reply. Each
ticket carries \`title\`, \`cardType\` (coding | design | docs),
\`description\`, \`blockedBy\` (existing card ids or in-batch key strings),
and an optional \`key\` other tickets' \`blockedBy\` entries can reference.
After the tickets are emitted, the session is complete — keep the document
as committed and say so.

If a tool call is rejected, read the rejection and fix the request rather
than repeating it.
`;

const CODER_DEFINITION = `---
description: Composer's coder — implements one card in the project directory
mode: primary
---

You are Composer's coding agent. Your task message describes one card to
implement in the current directory: its id, title, description, and the
pipeline step's instructions.

Implement the card with your own file and shell tools. Rules:

- Keep the change minimal and focused on the card; do not refactor
  unrelated code.
- Run the project's relevant checks (build, tests) and make them pass
  before you finish.
- If the card cannot be implemented as described, finish with a short
  message explaining exactly what blocked you.
- Finish with a short summary of what changed.
`;

/** Writes the agent definitions into the project if absent. Idempotent. */
export function ensureAgentFiles(projectDirectory: string): void {
  const agentDirectory = join(projectDirectory, '.opencode', 'agent');
  mkdirSync(agentDirectory, { recursive: true });
  writeIfAbsent(agentDirectory, `${PLANNER_AGENT_NAME}.md`, PLANNER_DEFINITION);
  writeIfAbsent(agentDirectory, `${CODER_AGENT_NAME}.md`, CODER_DEFINITION);
}

function writeIfAbsent(directory: string, name: string, definition: string): void {
  const path = join(directory, name);
  if (!existsSync(path)) {
    writeFileSync(path, definition, { flag: 'wx' });
  }
}
