# Deferred product decisions

Status: decision register; these items are not approved implementation scope.

This document collects product and implementation choices intentionally left
open while the pipeline, assistant, live-run, and scheduler contracts were
defined. A deferred item must not be treated as an implicit requirement. Move
it into an authoritative product contract only after the triggering need is
real and the behavior has been decided.

## Pipeline and Kanban

### Event model and migration

Decided 2026-09-07 — see
[Phase 10 implementation](phase-10-implementation.md): event and command names,
the clean (no-deployment) cutover from worker lanes, revision storage in the
fold, and run replay in the snapshot. Remaining open:

- queued run request events and durable queue mechanics (Phase 13's scheduler
  contract);
- board/history presentation for tasks pinned to stages removed from a newer
  pipeline revision (the run keeps its pinned revision; decide when a revision
  history UI exists).

### Stage outcomes and recovery

Decided 2026-09-07 — see
[Phase 10 implementation](phase-10-implementation.md) and the S35/S36
notes in [milestones](milestones.md): outcome rules are per-stage user
configuration (`outcome` → proceed or an earlier stage), stage error
conditions (`errorReturnToStageId`) return the task on step failure
(S35), and the agent outcome tool enforces the rules at run time — a
backward outcome ends the run `returned`, `requiresOutcome` fails a turn
without the call, and a stage without outcomes proceeds on success (S36).
The built-in vocabulary (`approved` / `changes_requested` on the default
Review stage) and the tool's payload (`outcome`, optional `note`) shipped
with the defaults; malformed or disallowed outcomes are teaching
rejections that list the allowed names.

### Visual editor controls

The editor is a linear stage diagram without general branching. Exact controls
remain open, including stage and step creation, drag behavior, selection,
keyboard operation, zoom, layout persistence, and how recovery settings are
edited without drawing branches.

Revisit during the pipeline-editor interaction design slice.

### Nonlinear pipelines

General conditional branches, parallel paths, joins, loops, sub-pipelines,
sub-agents, fallback models, and arbitrary graph edges are not current scope.
They require explicit scheduling, cancellation, merge, validation, and run-view
semantics before they can be approved.

Revisit only after the linear pipeline and worktree scheduler are proven in
normal use.

## Tickets and milestones

Milestones are currently limited to the direction that one milestone groups
multiple tasks and one task belongs to at most one milestone. Still to decide:

- milestone fields, status, dates, and lifecycle;
- progress calculation;
- task assignment and removal behavior;
- archive and deletion rules;
- milestone presentation across pipeline tabs; and
- the broader ticket model and canonical task/card/ticket vocabulary.

Revisit when the additional ticket requirements are available.

## Assistant and plans

### Expanded write authority

The assistant may update an explicitly requested plan in a selected project. It
does not currently receive general project-file editing or pipeline execution
authority. Any broader write, run, stop, or approval capability remains open
and requires a separate confirmation and permission model.

Revisit only when a concrete assistant-driven execution workflow requires it.

### Plan editing UX

Exact presentation of assistant-authored plan changes remains open. Potential
work includes change summaries, history, and read-only diffs, but no additional
review UI is required by the current product contract.

Revisit if direct plan updates become difficult to inspect or recover.

## Tool activity

### Generic execution-event contract

The intended generic event can represent tool identity, status, timing, input,
output, errors, artifacts, and child calls. Its wire shape, streaming behavior,
nesting limits, retention, truncation, and relationship to run events remain
undecided.

Revisit after OpenCode tool and session event formats stabilize.

### Specialized renderers

Purpose-built command, file-read, search, diff, artifact, and nested-agent
renderers are deferred. Raw payloads and a compact generic fallback remain the
required baseline.

Revisit one renderer at a time after the generic execution-event contract is
stable and observed tool volume demonstrates value.

## Live run workbench

Still to decide:

- exact initial pane proportions and persisted sizing keys;
- binary, generated, renamed, and oversized diff presentation;
- run-attempt filtering and navigation controls;
- model-specific reasoning visibility and redaction policy; and
- detailed styling for model terminals versus pipeline command steps.

Revisit during live-run interaction design. These choices must preserve the
approved three-pane layout, read-only diffs, run grouping, and terminal control
boundaries.

## Skills

### Semantic discovery

Skill resolution by deterministic name and source is required. Semantic search,
ranking, recommendations, aliases, and capability matching remain deferred.

Revisit when the available skill catalog becomes large enough that explicit
names and ordinary metadata are insufficient.

## Project indexing

Project indexing is optional per project and is not required for normal
operation. Still to decide:

- storage engine and lifecycle;
- indexed file and artifact boundaries;
- ignore rules and secret handling;
- initial build and incremental refresh behavior;
- local or remote embedding provider;
- lexical, semantic, symbol, dependency, documentation, and Git-history
  retrieval signals;
- ranking and result provenance;
- worktree-aware indexing; and
- resource limits, invalidation, deletion, and portability.

Revisit when ordinary file, Git, and lexical search produce measured retrieval
or performance problems in selected projects.

## Scheduler and worktrees

### Durable scheduler contract

Event and action shapes, restart-checkpoint serialization, cancellation event
transitions, and the mechanics used to restore the approved durable queue and
resumable run state remain implementation decisions.

Revisit before scheduler implementation and protocol migration planning.

### Queue fairness

FIFO with manual reordering is approved. Fairness between projects, task groups,
and independent worktrees is not defined beyond that baseline. Starvation
prevention and priority scheduling are also open.

Revisit if real workloads demonstrate starvation or make one global FIFO queue
insufficient.

### Git naming and checkpoints

Still to decide:

- task, group, branch, and worktree naming conventions;
- collision and stale-directory recovery;
- checkpoint commit author, message, and metadata;
- whether operational checkpoints are hidden, squashed, or exposed during
  integration; and
- cleanup behavior for abandoned checkpoint history.

Revisit before implementing lazy worktree creation and base synchronization.

### Conflict resolver

The dedicated resolver and pause-on-failure behavior are approved. Prompting,
model selection, retry bounds, validation commands, timeout, and evidence shown
to the user remain open.

Revisit when defining the conflict-resolution pipeline step.

### Remote base updates

The first version observes local base-branch advancement. Fetch scheduling,
remote polling, credentials, offline behavior, and automatic synchronization
with remote refs remain deferred.

Revisit after local base synchronization is stable or when stale local refs
become a practical problem.

### Integration and pull requests

Integration is user-triggered and initially limited to status, commands, and
guidance. Still to decide:

- generated command UX;
- Git provider integration;
- pull request creation and updates;
- automated merge or rebase execution;
- validation required before integration;
- branch publication and post-integration cleanup; and
- worktree disk-usage warnings and cleanup recommendations.

Revisit after the manual PR and integration workflow has been used enough to
identify repetitive steps worth automating.

## Revisit process

When taking an item out of this register:

1. Record the product decision and its reason.
2. Update the relevant authoritative contract.
3. Define migration and compatibility behavior where durable data is affected.
4. Add acceptance outcomes before implementation.
5. Remove or replace the deferred entry so this register does not contradict
   the approved model.
