// The agents composer ships (D2, S33, Phase 6): the planner, the board's
// workers (coder, tester, reviewer, security), and the global assistant —
// markdown definitions under `.opencode/agent/`, written once,
// user-editable, never overwritten. Each definition and tool surface lives
// with its agent; names and shipping remain shared here.

export {
  ASSISTANT_AGENT_NAME,
  CODER_AGENT_NAME,
  PIPELINE_AGENT_KINDS,
  PLANNER_AGENT_NAME,
} from './names.js';
export { ensureAgentFiles, ensureAssistantWorkspace } from './ship.js';
