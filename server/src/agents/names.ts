// The shipped agents' names and the pipeline agent kinds (S33): the
// processor's run gate and the runner's lane/prompt mapping read the kinds.

export const PLANNER_AGENT_NAME = 'composer-planner';
export const CODER_AGENT_NAME = 'composer-coder';
export const ASSISTANT_AGENT_NAME = 'composer-assistant';

export const PIPELINE_AGENT_KINDS: readonly string[] = ['coder', 'tester', 'reviewer', 'security'];

