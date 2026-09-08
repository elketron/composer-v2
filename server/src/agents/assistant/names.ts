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
