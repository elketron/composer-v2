import type { Bus } from '../../bus.js';
import type { Processor } from '../../processor/index.js';
import type { CommandOutcome } from '../../wire/commands.js';
import { normalizeLinks, readWorkflow, searchWorkflows } from '../../workflows.js';

/** The environment a worker tool executes against (the validated surfaces). */
export interface WorkerToolEnv {
  bus: Bus;
  processor: Processor;
}

// The worker agents' MCP tools (S34, S36): the outcome signal, the
// workflow-recording tools, and the retrieval tools. The definitions ride
// the agent's tool folder; the validated dispatch (the commands they issue)
// is executeWorkerTool below.

import type { McpToolDefinition } from '../../mcp/protocol.js';

export const WORKER_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'report_outcome',
    description:
      'Reports your stage outcome for the current pipeline step — required when your task message lists stage outcomes. Pass exactly one of the listed outcome names; the pipeline applies the transition (proceed to the next step, or return the card to an earlier stage). Add a note when the card must go back: what the next attempt still needs.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', description: "One of the stage's named outcomes, e.g. 'approved'" },
        note: { type: 'string', description: 'Optional verdict note — what a returned card still needs' },
      },
      required: ['outcome'],
    },
  },
  {
    name: 'workflow_start_recording',
    description:
      'Opens a workflow recording for this session: the repeatable procedure you are performing, to be saved into the project (.composer/workflows/) when you stop. Search existing workflows first and follow one when it applies; record a new one only when the procedure is reusable. Give the procedure a short title, a description of when it applies, and tags for later search.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short procedure title, e.g. "Add an HTTP endpoint"' },
        description: { type: 'string', description: 'When this procedure applies (one line)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Keywords for later search' },
      },
      required: ['title'],
    },
  },
  {
    name: 'workflow_add_step',
    description:
      'Appends one step to the open workflow recording — a step you actually performed. Title stays short ("Run the test suite"); detail carries the nuance (which files, which flags, what to watch for); command carries the exact shell command when there is one. Record steps in the order a future agent should do them.',
    inputSchema: {
      type: 'object',
      properties: {
        step: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short step title' },
            detail: { type: 'string', description: 'How to do it: files, flags, caveats' },
            command: { type: 'string', description: 'The exact shell command, when there is one' },
          },
          required: ['title'],
        },
      },
      required: ['step'],
    },
  },
  {
    name: 'workflow_stop_recording',
    description:
      'Finalizes the open recording: writes the workflow file and returns its path. Pass links to what the procedure draws on — project docs paths (docs/…), knowledge note names, card ids. The recording must have at least one step.',
    inputSchema: {
      type: 'object',
      properties: {
        links: {
          type: 'array',
          items: { type: 'string' },
          description: 'Referenced artifacts: docs paths, knowledge note names, card ids',
        },
      },
    },
  },
  {
    name: 'workflow_search',
    description:
      'Searches this project\'s recorded workflows — procedures earlier agents captured (titles, tags, steps). Search at the start of a task and follow a matching workflow instead of rediscovering the procedure.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Whitespace-split keywords, AND-matched' } },
      required: ['query'],
    },
  },
  {
    name: 'workflow_read',
    description:
      'Reads one recorded workflow in full — its frontmatter and its ordered steps. Follow its steps, adapting to the task at hand.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'The workflow file name, e.g. add-an-http-endpoint.md' } },
      required: ['path'],
    },
  },
];

/** The whitelist the /mcp/worker route answers (the worker tool surface). */
export const WORKER_MCP_TOOLS: ReadonlySet<string> = new Set(WORKER_TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * The worker call dispatch, extracted from the HTTP route: the outcome
 * signal and the recording commands land on the validated processor; the
 * retrieval tools read the project's workflow files. Every call
 * re-validates the project and session — the child carries no authority.
 */
export async function executeWorkerTool(
  env: WorkerToolEnv,
  projectId: string,
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!WORKER_MCP_TOOLS.has(tool)) return { ok: false, error: `unknown worker tool ${tool}` };
  const project = env.bus.state.projects.get(projectId);
  if (project === undefined) return { ok: false, error: `Unknown project ${projectId}` };
  const session = env.bus.state.byProject.get(projectId)?.agentSessions.get(sessionId);
  if (session === undefined) return { ok: false, error: `Unknown agent session ${sessionId}` };
  if (session.status !== 'running') {
    return { ok: false, error: `Agent session ${sessionId} is not running` };
  }

  if (tool === 'report_outcome') {
    const outcome = typeof args['outcome'] === 'string' ? args['outcome'] : '';
    if (outcome.trim() === '') {
      return { ok: false, error: 'an outcome needs a name' };
    }
    const result = await env.processor.execute(projectId, {
      type: 'requestPipelineOutcomeReport',
      sessionId,
      outcome,
      ...(typeof args['note'] === 'string' ? { note: args['note'] } : {}),
    });
    if (!result.ok) {
      return { ok: false, error: result.rejection.message };
    }
    return { ok: true, ...(result.transition !== undefined ? { transition: result.transition } : {}) };
  }
  if (tool === 'workflow_start_recording') {
    const outcome = await env.processor.execute(projectId, {
      type: 'requestWorkflowRecordStart',
      sessionId,
      title: typeof args['title'] === 'string' ? args['title'] : '',
      ...(typeof args['description'] === 'string' ? { description: args['description'] } : {}),
      ...(Array.isArray(args['tags'])
        ? { tags: args['tags'].filter((tag): tag is string => typeof tag === 'string') }
        : {}),
    });
    return outcomeToToolResult(outcome);
  }
  if (tool === 'workflow_add_step') {
    const raw = args['step'];
    const step = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
    const title = typeof step?.['title'] === 'string' ? step['title'] : '';
    if (step === undefined || title.trim() === '') {
      return { ok: false, error: 'a workflow step needs a title' };
    }
    const outcome = await env.processor.execute(projectId, {
      type: 'requestWorkflowRecordStep',
      sessionId,
      step: {
        title,
        ...(typeof step['detail'] === 'string' ? { detail: step['detail'] } : {}),
        ...(typeof step['command'] === 'string' ? { command: step['command'] } : {}),
      },
    });
    return outcomeToToolResult(outcome);
  }
  if (tool === 'workflow_stop_recording') {
    const links = normalizeLinks(args['links']);
    if (links === null) {
      return { ok: false, error: 'links must be strings, at most 20 of 200 chars each' };
    }
    const outcome = await env.processor.execute(projectId, {
      type: 'requestWorkflowRecordStop',
      sessionId,
      ...(links.length > 0 ? { links } : {}),
    });
    return outcomeToToolResult(outcome);
  }
  // Retrieval reads over the project's workflow files.
  if (project.directory === undefined) {
    return { ok: false, error: `project ${projectId} has no readable directory` };
  }
  if (tool === 'workflow_search') {
    const query = typeof args['query'] === 'string' ? args['query'] : '';
    return {
      ok: true,
      results: searchWorkflows(project.directory, query).map((result) => ({
        ...result.info,
        snippet: result.snippet,
        score: result.score,
      })),
    };
  }
  const path = typeof args['path'] === 'string' ? args['path'] : '';
  const result = readWorkflow(project.directory, path);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, workflow: { ...result.value.info, content: result.value.content } };
}

/** The tool result a recording command's outcome becomes (the MCP child's JSON). */
function outcomeToToolResult(outcome: CommandOutcome): { ok: true; savedPath?: string } | { ok: false; error: string } {
  if (outcome.ok) {
    return outcome.savedPath !== undefined
      ? { ok: true, savedPath: outcome.savedPath }
      : { ok: true };
  }
  return { ok: false, error: outcome.rejection.message };
}
