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
  stage: 'coding' as const,
  blockedBy: [],
  assignee: { role: 'coder', model: 'qwen3.6', effort: 'high' },
  branch: 'feat/board-drag',
  fileStats: { added: 120, removed: 12, files: 3 },
  subState: { retrieveContext: 'ok', implement: 'running' },
  retries: { review: 1 },
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
  cardMoved: { cardId: 'T-1', from: 'new', to: 'coding', comment: 'needs tests' },
  cardTypeChanged: { cardId: 'T-1', from: 'coding', to: 'design' },
  cardAssigned: { cardId: 'T-1', assignee: { role: 'human' } },
  cardArchived: { cardId: 'T-2' },
  subStateUpdated: { cardId: 'T-1', stage: 'implement', status: 'running' },
  dependencyStateChanged: { cardId: 'T-2', blocked: true, blockedBy: ['T-1'] },
  automationToggled: { lane: 'coding', on: true },
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
        stage: 'new' as const,
        tags: [],
        assignee: undefined,
        branch: undefined,
        fileStats: undefined,
        subState: { draft: 'pending', implement: 'pending', runValidation: 'pending', reviewChanges: 'pending', humanReview: 'pending' },
        retries: {},
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
      updatedAt: TS,
      steps: [
        {
          id: 'st-1',
          kind: 'agent' as const,
          agentKind: 'coder',
          instructions: 'Implement the card per its description.',
        },
        { id: 'st-2', kind: 'command' as const, command: 'npm test', description: 'Run tests', retries: 1 },
        { id: 'st-3', kind: 'human' as const, description: 'Approval' },
      ],
    },
  },
  pipelineDeleted: { pipelineId: 'PL-2' },
  pipelineRunStarted: { cardId: 'T-1', pipelineId: 'PL-1' },
  pipelineStepStarted: { cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-1', kind: 'agent' as const },
  pipelineStepFinished: { cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-1', ok: true },
  pipelineRunEnded: { cardId: 'T-1', pipelineId: 'PL-1', status: 'completed' as const },
  pipelineGateResponded: { cardId: 'T-1', approved: true, comment: 'ship it' },
  commandOutput: { cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-2', line: 'npm test' },
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
  assistantUserMessage: { threadId: 'TH-1', message: message(1, 'user', 'what needs me?') },
  assistantMessageDelta: { threadId: 'TH-1', messageIndex: 2, delta: 'Two projects' },
  assistantMessageComplete: {
    threadId: 'TH-1',
    message: message(2, 'agent', 'Two projects have waiting approvals.'),
  },
  assistantThreadStopped: { threadId: 'TH-1' },
  assistantRetryRequested: { threadId: 'TH-1' },
  assistantThreadStatusChanged: { threadId: 'TH-1', status: 'failed' },
  assistantThreadRenamed: { threadId: 'TH-1', name: 'portfolio' },
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
