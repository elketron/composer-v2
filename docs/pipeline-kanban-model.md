# Pipeline and Kanban model

Status: approved product direction; implementation started 2026-09-07 — the
wire and runtime decisions live in
[Phase 10 implementation](phase-10-implementation.md), slice notes in
[milestones](milestones.md).

This document is the authoritative product model for the relationship between
pipelines, tasks, stages, runs, and the Kanban board. The chat transcripts and
mockup in this directory are supporting design material, not UI specifications.
Composer's existing visual theme and interaction patterns remain the baseline.

## Product model

Composer is pipeline-first:

- A pipeline defines how a task moves through work.
- A stage describes a meaningful state in that pipeline.
- A step describes one unit of execution.
- A run is one execution attempt for a task.
- The Kanban board is a projection of pipeline stages, not pipeline steps.
- The task card shows finer-grained execution state that does not belong in the
  board's column structure.

In short:

> The board shows where work is. The pipeline shows what happens to move it.

## Pipeline ownership

- A project may contain multiple pipelines.
- A task is assigned to exactly one pipeline at a time.
- Each pipeline has its own tab on the project's Kanban board.
- A task appears on the tab for its assigned pipeline.
- A task may change pipelines whenever it has no active run.
- Changing a completed task's pipeline automatically reopens the task.
- Changing pipelines does not delete the task's run history or OpenCode
  sessions.

## Stages and steps

A pipeline contains an ordered sequence of steps and an ordered set of stages.
Every step references one stage defined by that pipeline. Multiple consecutive
steps may reference the same stage.

Stages are local to a pipeline. Two pipelines may both define a stage called
`Review`, but those are independent stage instances with independent
configuration. Their pipelines do not share runs.

A stage defines:

- its stable identity and display label;
- its order in the pipeline's forward path;
- whether it is visible as a Kanban column;
- its allowed named agent outcomes and their transitions;
- whether agent steps require an explicit outcome signal; and
- any configured error conditions that return the task to an earlier stage.

A step defines its executor and step-kind-specific configuration. Supported
step kinds may include agent, command, and approval. Approval is a step kind,
not an implicit stage. Tester, reviewer, and security are ordinary stages when
a pipeline defines them that way.

The normal execution path moves forward through the ordered stages. Steps must
not reference stages in an order that makes the normal path move backward.
Backward movement is reserved for explicit stage error conditions and is not a
branch in the normal path.

Agents report outcomes; they do not control the pipeline directly. Each agent
stage defines allowed named outcomes such as `completed`, `changes_requested`,
or `blocked` and maps them to runner-controlled transitions. An agent cannot
name an arbitrary target stage. Depending on stage configuration, an agent step
either requires an explicit Composer outcome-tool call or treats a successful
OpenCode turn as completion.

Example:

```text
Stages:
  Planning [visible] -> Implementation [visible] -> Build [hidden]
  -> Testing [visible] -> Review [visible]

Steps:
  planner agent      -> Planning
  coder agent        -> Implementation
  build command      -> Build
  test command       -> Testing
  reviewer agent     -> Review
  human approval     -> Review
```

## Kanban projection

Only stages marked as Kanban-visible become columns. Pipeline steps never
become columns automatically.

When execution enters a visible stage, the task moves to that stage's column.
When execution enters a hidden stage, the task remains in the most recent
visible stage. The card displays the active hidden stage and current step
directly so that execution remains observable without adding board noise.

For example, a task may remain in `Implementation` while its card status moves
through `Installing dependencies`, `Building`, or another hidden execution
state.

The first stage in each pipeline must be Kanban-visible. A newly assigned or
reopened task begins in that stage. Later hidden stages can therefore always
retain a well-defined previous visible column.

Planning has two distinct but compatible uses:

- The Plan view is a dedicated workspace for discussing and authoring plans.
- A pipeline may also define a Planning stage for tasks whose current workflow
  state is planning.

## Run behavior

- A task may have at most one active run.
- A task may have at most one queued run request or active run.
- A task is locked against manual stage movement and pipeline reassignment while
  its run is active.
- The pipeline controls stage transitions during a run.
- Agent outcome signals are validated against the current stage configuration.
- A failed task remains in its current visible Kanban stage unless a matching
  error condition returns it to an earlier stage.
- Finished runs remain immutable historical records.
- Run history records the pipeline and pipeline revision used for that attempt.

The task card surfaces the active run's current stage, current step, worker or
executor, status, and relevant elapsed or failure information. The run view
contains the complete execution detail.

## Error transitions and retries

Stages may define specific error conditions that return a task to an earlier
stage. These are recovery rules, not visual branches in the pipeline editor.
The editor shows the forward path; stage settings expose the recovery rules.

When a matching error condition occurs:

- the failed run ends and remains in history;
- the task moves to the configured earlier stage;
- the card reports the failure and recovery state; and
- a user may request a retry when no other run request is queued and no run is
  active for the task.

The same rule applies when an agent reports an allowed backward outcome, such
as a reviewer returning work to the coder. The current run ends and the task
moves to the configured earlier stage. A subsequent retry starts a new run from
that stage.

A retry creates a new run instead of reopening or mutating the failed run. The
new run reuses the previous OpenCode session attached to the task, preserving
agent context while keeping each execution attempt independently inspectable.

## Pipeline revisions

Saving an edited pipeline creates a new revision of that pipeline.

- A run is pinned to the revision with which it started.
- Editing a pipeline never changes the steps remaining in an active run.
- After an active run ends, a nonterminal task adopts the newest pipeline
  revision before its next run.
- Nonterminal tasks without an active run use the newest revision.
- Terminal tasks remain associated with the revision on which they completed
  and are not migrated merely because the pipeline changes.
- Reopening a terminal task, including by assigning it to another pipeline,
  assigns the newest revision of its selected pipeline.
- Historical runs and their outputs always retain their original revision.

## Visual pipeline editor

The preferred editor is a visual stage diagram that represents the pipeline's
linear forward path. It should use Composer's current UI theme rather than the
exploratory mockup as a visual target.

The diagram should:

- display stages in forward order;
- group or associate each step with its referenced stage;
- distinguish Kanban-visible and hidden stages;
- support editing stage settings and step configuration;
- support reordering while preserving a valid forward path; and
- expose backward error transitions in stage settings rather than drawing
  branches on the canvas.

The editor does not need general graph authoring, conditional branches,
parallel paths, joins, loops, or arbitrary edges. If those execution semantics
are introduced later, they require a separate product and runtime design.

## Milestones

Milestones are useful project-level task groupings but are not part of pipeline
execution. One milestone may contain multiple tasks, and a task may belong to
at most one milestone. Milestone fields, lifecycle, and UI will be specified
with the broader ticket model later.

## Invariants

- One task has one assigned pipeline.
- One task has at most one queued run request or active run.
- One task has at most one active run.
- Every step references a stage from its own pipeline.
- The normal stage path moves forward only.
- The first stage of every pipeline is Kanban-visible.
- Pipeline execution has sole transition authority during an active run.
- Agents can report only outcomes allowed by their current stage.
- Hidden stages update card status without creating or changing to a hidden
  column.
- Runs are immutable attempts and retain their pipeline revision.
- Retry creates a new run and reuses the task's prior OpenCode session.
- Milestones do not control pipeline execution or stage transitions.

## Deferred details

Open pipeline, migration, milestone, and nonlinear-execution questions are
tracked in [Deferred product decisions](deferred-product-decisions.md). They are
not part of this approved product contract.
