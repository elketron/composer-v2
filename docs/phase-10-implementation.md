# Phase 10 implementation — staged pipelines, runs, and the board

Status: implementation design for [Pipeline and Kanban model](pipeline-kanban-model.md);
S35+ slice notes land in [milestones](milestones.md).

This document fixes the choices the model contract left open (tracked in
[deferred-product-decisions](deferred-product-decisions.md) until now). Product
decisions confirmed 2026-09-07:

- Automation toggles stay, keyed per pipeline stage (not per worker lane).
- No migration of existing dev logs: the application has no deployments, so the
  wire is redesigned cleanly where the staged model needs it. Old data dirs are
  deleted, not migrated.
- Run queueing is deferred to the Phase 13 scheduler; Phase 10 rejects a run or
  retry request while the task has an active run.
- A backward transition (agent outcome or stage error condition) ends the run
  with the new `returned` status and moves the task to the target stage.

## Vocabulary

The wire keeps the card vocabulary (task/card unification is still deferred).
`stage` now always means a pipeline-local stage; the fixed global Stage enum
(worker lanes) is gone.

## Wire shapes

Protocol bump: `PROTOCOL_VERSION` 5 → 6, golden regenerated on both sides.

### Pipeline

```ts
interface PipelineStage {
  id: string;            // pipeline-local, 'sg-N'
  label: string;
  kanbanVisible: boolean;
  terminal?: boolean;    // the completion stage; exactly one, must be last
  outcomes?: StageOutcomeRule[];   // agent stages (S36 enforces)
  requiresOutcome?: boolean;       // agent steps need an explicit outcome call (S36)
  errorReturnToStageId?: string;   // failed step returns the task here (S35 enforces)
}

interface StageOutcomeRule {
  outcome: string;       // agent-reported name, e.g. 'approved'
  toStageId?: string;    // absent = proceed to the next step; else an EARLIER stage
}

interface PipelineStep {
  id: string;            // 'st-N' (unchanged)
  kind: 'agent' | 'command' | 'human';
  stageId: string;       // references one stage of its own pipeline (required)
  agentKind?: string;
  instructions?: string;
  command?: string;
  description?: string;
}

interface Pipeline {
  id; projectId; name;
  revision: number;      // 1-based; a changed save allocates revision+1
  stages: PipelineStage[];  // ordered = forward path
  steps: PipelineStep[];    // ordered = execution order
  updatedAt: string;
}
```

Authoring validation (processor): ≥1 stage, ≥1 step, ≤64 steps; unique stage
and step ids; every `step.stageId` names a stage of the same pipeline; the step
sequence's stage order is non-decreasing (the normal path never moves
backward); the first stage is `kanbanVisible`; exactly one terminal stage and it
is the last; `outcomes[].toStageId` (when present) references a strictly
earlier stage; `errorReturnToStageId` references a strictly earlier stage.
Saving an unchanged definition (name + stages + steps) is a no-op; a changed
save publishes the pipeline with `revision + 1`. The fold keeps every revision
(runs pin theirs); the snapshot replays each revision as `pipelineSaved`.

### Card

```ts
interface Card {
  id; projectId; type; title; description; tags;
  pipelineId: string;    // assigned pipeline (exactly one at a time)
  stageId: string;       // current stage of that pipeline
  blockedBy; assignee?; sessionId?; branch?; fileStats?;
  stepStates: Record<stepId, 'pending' | 'running' | 'ok' | 'failed'>;
  rejectionComment?; createdAt; updatedAt;
}
```

Dropped: `stage` (global lane), `subState` (worker-flavored checklist —
replaced by `stepStates`, keyed by real step ids), `retries` (per-attempt
failure lives on run records). Cards cannot exist without a pipeline:
creation assigns the default pipeline (`PL-1`, else the first by id) and its
first stage; ticket emission and proposal confirmation do the same.

### Runs

```ts
type PipelineRunStatus = 'running' | 'waiting' | 'completed' | 'failed'
                       | 'returned' | 'cancelled';

interface RunRecord {
  id: string;            // 'R-N', allocated per project
  cardId; projectId; pipelineId;
  revision: number;      // pinned at start
  status; startedAt; endedAt?; error?;
  stageId?; stepId?;     // current position while active
}
```

- `pipelineRunStarted {runId, cardId, pipelineId, revision}` — the processor
  allocates the run and pins the pipeline's current revision.
- `pipelineStepStarted {runId, cardId, pipelineId, stepId, kind, stageId}` —
  carries the step's stage; the fold moves the card into that stage.
- `pipelineStepFinished {runId, cardId, pipelineId, stepId, ok, error?}`.
- `pipelineRunEnded {runId, cardId, pipelineId, revision, status, error?}`.
- `pipelineGateResponded {runId, cardId, approved, comment?}`.
- `commandOutput {runId, cardId, pipelineId, stepId, line}` (ephemeral).

A run executes the steps whose stage is at or after the task's current stage
(stage order); steps in earlier stages are skipped. Reaching the end moves the
task to the terminal stage. A failed step ends the run `failed` and the task
stays where it is (S35 added the error-condition return; S36 added the
agent-outcome transitions). One active run per
task; a second run/retry request rejects `runActive`.

### Card movement and assignment

- `cardStageMoved {cardId, pipelineId, fromStageId, toStageId, comment?}` —
  published by the processor (manual moves, validated) and by the runner (run
  transitions, `override` semantics built in). Replaces `cardMoved`.
- `cardPipelineAssigned {cardId, pipelineId, stageId}` — assignment always
  places the task in the pipeline's first stage; assigning to a completed task
  reopens it (the same event). Requires no active run.
- `cardStepStateUpdated {cardId, stepId, status}` — replaces
  `subStateUpdated`; humans may tick step states of an idle task.
- `requestCardReopen {cardId}` — a terminal task returns to the first stage
  (publishes `cardStageMoved`).
- `automationToggled {pipelineId, stageId, on}` — per stage (no server-side
  behavior beyond persistence, as before).

Manual rules: stage moves require no active run (`runActive`), the target must
be a stage of the assigned pipeline (`unknownStage`), blockers reject unless
`override`, same-stage is a no-op. Drags out of the terminal stage keep the
rejection-comment flow.

### Removed from the catalog

`cardMoved`, `subStateUpdated`, the global `Stage` enum, `lanesFor`,
`subStateFor`, `stepStageOf`, `implementLaneFor`, `stageCsName` and the C#-enum
rejection messages. New rejection codes: `unknownStage`; `runActive` replaces
`pipelineAlreadyRunning`.

## Board projection

One tab per pipeline (project board route, tab state remembered locally).
Columns = the current revision's `kanbanVisible` stages. A card's column is the
last visible stage at or before its `stageId` in stage order — a hidden-stage
task stays in its previous visible column while the card shows the active
hidden stage and current step. Blocked-ness derives from blockers whose stage
is not the terminal stage. The board's type filter stays; automation toggles
render per agent-hosting stage column.

## Dashboard health

`returned` joins `failed` as an actionable latest-run outcome (inbox +
project health). A started rerun replaces it; success clears it.

## Defaults

The seeded `PL-1` becomes staged:

```text
Stages:  New [visible] → Implementation [visible] → Validation [visible]
         → Approval [visible] → Done [terminal, visible]
Steps:   coder agent → Implementation
         build command → Validation
         test command → Validation
         approval human → Approval
```

Stage outcomes shipped with the defaults in S36 (`Review`-style stage:
`approved` proceeds, `changes_requested` returns to Implementation,
`requiresOutcome`); the default Validation stage has carried an error
return to Implementation since S35.

## Out of scope here

Queued run requests, worktrees, and scheduler recovery (Phase 13); milestone
fields; the task/ticket vocabulary; nonlinear pipelines.
