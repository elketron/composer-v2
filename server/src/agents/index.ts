// The agents composer ships (D2, S33, Phase 6): the planner, the board's
// workers (coder, tester, reviewer, security), and the global assistant.
// Each definition is the agent's system prompt; each tool surface lives
// with its agent. Names stay shared here.

export {
  ASSISTANT_AGENT_NAME,
  CODER_AGENT_NAME,
  PIPELINE_AGENT_KINDS,
  PLANNER_AGENT_NAME,
} from './names.js';