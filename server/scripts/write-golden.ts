// Builds one frame per event type, in catalog order, with fixed timestamps
// — the golden fixture (v1 rule: a wire change breaks exactly one test on
// each side; do not regenerate casually).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFrame, nowIso } from '../src/wire/envelope.js';
import { EVENT_NAMES, GLOBAL_EVENTS, type EventBodyMap } from '../src/wire/events.js';

const TS = '2026-09-04T12:00:00.123456Z';
void nowIso;

const card = {
  id: 'T-1',
  projectId: 'P-1',
  type: 'coding' as const,
  title: 'Board drag & drop',
  description: '',
  tags: ['ui'],
  pipelineId: 'PL-1',
  stageId: 'sg-2',
  blockedBy: [],
  assignee: { role: 'coder', model: 'qwen3.6', effort: 'high' },
  branch: 'feat/board-drag',
  fileStats: { added: 120, removed: 12, files: 3 },
  stepStates: { 'st-1': 'ok', 'st-2': 'running' },
  rejectionComment: 'needs tests',
  createdAt: TS,
  updatedAt: TS,
};

const message = (index: number, role: string, text: string) => ({
  index,
  role,
  text,
  at: TS,
});

const bodies: { [N in keyof EventBodyMap]: EventBodyMap[N] } = {
  cardCreated: { card },
  cardStageMoved: {
    cardId: 'T-1',
    pipelineId: 'PL-1',
    fromStageId: 'sg-2',
    toStageId: 'sg-3',
    comment: 'needs tests',
  },
  cardPipelineAssigned: { cardId: 'T-1', pipelineId: 'PL-1', stageId: 'sg-1' },
  cardTypeChanged: { cardId: 'T-1', from: 'coding', to: 'design' },
  cardAssigned: { cardId: 'T-1', assignee: { role: 'human' } },
  cardArchived: { cardId: 'T-2' },
  cardStepStateUpdated: { cardId: 'T-1', stepId: 'st-2', status: 'running' },
  dependencyStateChanged: { cardId: 'T-2', blocked: true, blockedBy: ['T-1'] },
  automationToggled: { pipelineId: 'PL-1', stageId: 'sg-2', on: true },
  planningSessionCreated: {
    session: {
      id: 'S-1',
      projectId: 'P-1',
      createdAt: TS,
      status: 'drafting',
      messages: [],
      planDocument: '',
    },
  },
  userMessageReceived: { sessionId: 'S-1', message: message(1, 'user', 'plan the board') },
  agentMessageDelta: { sessionId: 'S-1', messageIndex: 2, delta: 'Here is' },
  agentMessageComplete: {
    sessionId: 'S-1',
    message: message(2, 'agent', 'Here is the plan.'),
  },
  planDocumentUpdated: {
    sessionId: 'S-1',
    document:
      '<plan>\n<goal>Board drag and drop</goal>\n<tasks>\n<task key="t1">Implement drag handlers</task>\n</tasks>\n</plan>',
  },
  planningSessionCompleted: { sessionId: 'S-1' },
  cardsCommitted: {
    cards: [
      {
        ...card,
        id: 'T-3',
        type: 'docs' as const,
        title: 'Write the onboarding doc',
        stageId: 'sg-1',
        tags: [],
        assignee: undefined,
        branch: undefined,
        fileStats: undefined,
        stepStates: {},
        rejectionComment: undefined,
      },
    ],
  },
  projectCreated: {
    project: { id: 'P-1', name: 'alpha', directory: '/home/odmar/Projects/composer-v2', createdAt: TS },
  },
  projectDirectoryChanged: { projectId: 'P-1', directory: '/home/odmar/Projects/composer-v2' },
  projectActivated: { projectId: 'P-1' },
  projectArchived: { projectId: 'P-1', archivedAt: TS },
  projectRestored: { projectId: 'P-1', restoredAt: TS },
  agentSessionStarted: { cardId: 'T-1', sessionId: 'A-1', agentKind: 'coder', startedAt: TS },
  agentSessionEnded: { cardId: 'T-1', sessionId: 'A-1', status: 'ended', endedAt: TS },
  agentToolCall: {
    sessionId: 'A-1',
    toolCallId: 'call-1',
    toolName: 'write',
    args: { path: 'src/main.ts', content: 'fn main() {}' },
  },
  agentToolResult: { sessionId: 'A-1', toolCallId: 'call-1', content: 'written', isError: false },
  pipelineSaved: {
    pipeline: {
      id: 'PL-1',
      projectId: 'P-1',
      name: 'Standard coding card',
      revision: 2,
      updatedAt: TS,
      stages: [
        { id: 'sg-1', label: 'New', kanbanVisible: true },
        { id: 'sg-2', label: 'Implementation', kanbanVisible: true },
        { id: 'sg-3', label: 'Validation', kanbanVisible: true, errorReturnToStageId: 'sg-2' },
        {
          id: 'sg-4',
          label: 'Review',
          kanbanVisible: true,
          outcomes: [{ outcome: 'approved' }, { outcome: 'changes_requested', toStageId: 'sg-2' }],
          requiresOutcome: true,
        },
        { id: 'sg-5', label: 'Approval', kanbanVisible: true, errorReturnToStageId: 'sg-2' },
        { id: 'sg-6', label: 'Done', kanbanVisible: true, terminal: true },
      ],
      steps: [
        {
          id: 'st-1',
          kind: 'agent' as const,
          stageId: 'sg-2',
          agentKind: 'coder',
          instructions: 'Implement the card per its description.',
        },
        { id: 'st-2', kind: 'command' as const, stageId: 'sg-3', command: 'npm test', description: 'Run tests' },
        {
          id: 'st-3',
          kind: 'agent' as const,
          stageId: 'sg-4',
          agentKind: 'reviewer',
          instructions: 'Review the implemented card.',
        },
        { id: 'st-4', kind: 'human' as const, stageId: 'sg-5', description: 'Approval' },
      ],
    },
  },
  pipelineDeleted: { pipelineId: 'PL-2' },
  pipelineRunStarted: { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', revision: 2 },
  pipelineStepStarted: {
    runId: 'R-1',
    cardId: 'T-1',
    pipelineId: 'PL-1',
    stepId: 'st-1',
    kind: 'agent' as const,
    stageId: 'sg-2',
  },
  pipelineStepFinished: { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-1', ok: true },
  pipelineRunEnded: {
    runId: 'R-1',
    cardId: 'T-1',
    pipelineId: 'PL-1',
    revision: 2,
    status: 'returned' as const,
    error: 'changes requested: needs tests',
  },
  pipelineGateResponded: { runId: 'R-1', cardId: 'T-1', approved: true, comment: 'ship it' },
  pipelineOutcomeReported: {
    runId: 'R-1',
    cardId: 'T-1',
    pipelineId: 'PL-1',
    stepId: 'st-3',
    outcome: 'changes_requested',
    note: 'the error path is untested',
  },
  commandOutput: { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-2', line: 'npm test' },
  assistantThreadCreated: {
    thread: {
      id: 'TH-1',
      name: 'Thread 1',
      createdAt: TS,
      status: 'idle',
      projectIds: ['P-1'],
      messages: [],
    },
  },
  assistantThreadArchived: { threadId: 'TH-1', archivedAt: TS },
  assistantThreadRestored: { threadId: 'TH-1', restoredAt: TS },
  assistantThreadScopeChanged: { threadId: 'TH-1', projectIds: ['P-1'] },
  assistantUserMessage: {
    threadId: 'TH-1',
    message: { id: 'am-1', index: 1, role: 'user', text: 'what needs me?', at: TS },
  },
  assistantMessageDelta: { threadId: 'TH-1', messageIndex: 2, delta: 'Two projects' },
  assistantMessageComplete: {
    threadId: 'TH-1',
    message: { id: 'am-2', parentId: 'am-1', index: 2, role: 'agent', text: 'Two projects have waiting approvals.', at: TS },
  },
  assistantThreadStopped: { threadId: 'TH-1' },
  assistantRetryRequested: { threadId: 'TH-1' },
  assistantThreadStatusChanged: { threadId: 'TH-1', status: 'failed' },
  assistantThreadRenamed: { threadId: 'TH-1', name: 'portfolio' },
  assistantResent: {
    threadId: 'TH-1',
    message: { id: 'am-3', index: 3, role: 'user', text: 'what needs me today?', at: TS },
  },
  assistantToolCall: {
    threadId: 'TH-1',
    parentId: 'am-1',
    toolCallId: 'at-1',
    toolName: 'composer_overview',
    args: {},
  },
  assistantToolResult: {
    threadId: 'TH-1',
    toolCallId: 'at-1',
    summary: 'Two projects have waiting approvals.',
    isError: false,
  },
  proposalDrafted: {
    proposal: {
      id: 'PR-1',
      threadId: 'TH-1',
      createdAt: TS,
      status: 'drafted',
      items: [
        {
          id: 'pi-1',
          projectId: 'P-1',
          title: 'Add a status strip filter',
          description: 'Filter the board by assignee.',
          cardType: 'coding',
          key: 'filter',
          blockedBy: [],
          included: true,
        },
      ],
    },
  },
  proposalConfirmed: {
    proposalId: 'PR-1',
    items: [
      {
        id: 'pi-1',
        projectId: 'P-1',
        title: 'Add a status strip filter',
        description: 'Filter the board by assignee.',
        cardType: 'coding',
        key: 'filter',
        blockedBy: [],
        included: true,
      },
    ],
    outcomes: [{ projectId: 'P-1', ok: true, cardIds: ['T-9'] }],
    confirmedAt: TS,
  },
  proposalDiscarded: { proposalId: 'PR-1' },
  docSaved: {
    doc: { path: 'setup.md', title: 'Setup guide', size: 128, updatedAt: TS },
  },
  docDeleted: { path: 'drafts/old.md' },
  knowledgeSaved: {
    entry: {
      path: 'postgres-conventions.md',
      title: 'Postgres conventions',
      tags: ['postgres', 'conventions'],
      size: 96,
      updatedAt: TS,
    },
  },
  knowledgeDeleted: { path: 'stale-note.md' },
  workflowSaved: {
    workflow: {
      path: 'add-an-http-endpoint.md',
      title: 'Add an HTTP endpoint',
      description: 'The procedure for a new route, from scaffold to verified.',
      tags: ['backend', 'http'],
      source: 'T-1',
      agent: 'coder',
      steps: 2,
      links: ['docs/api.md', 'card:T-3'],
      size: 512,
      recordedAt: TS,
      updatedAt: TS,
    },
  },
  workflowDeleted: { path: 'stale-procedure.md' },
};

const frames = EVENT_NAMES.map((name, index) =>
  makeFrame({
    id: `e-${String(index + 1).padStart(2, '0')}`,
    // Global assistant events carry no project scope.
    ...(GLOBAL_EVENTS.has(name) ? {} : { projectId: 'P-1' }),
    occurredAt: TS,
    name,
    body: bodies[name],
  }),
);

const outDir = join(import.meta.dirname ?? '.', '..', '..', 'wire-golden');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'events.json'), `${JSON.stringify(frames, null, 2)}\n`);
console.log(`wrote ${frames.length} frames to ${join(outDir, 'events.json')}`);
