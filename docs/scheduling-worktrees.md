# Scheduling and worktrees

Status: approved product direction; implementation not started.

This document defines how Composer schedules concurrent task runs, isolates Git
changes, groups related tasks, and recovers work after restart.

## Scheduling model

Tasks in the same project may run concurrently only when they use different Git
worktrees. Worktree ownership is the unit of mutual exclusion:

- an ungrouped task owns a dedicated worktree;
- a task group owns one worktree shared by its tasks;
- one worktree permits at most one active run; and
- runs in different worktrees may execute concurrently.

A task may have at most one queued run request or active run. Repeated run or
retry requests must not create duplicate queue entries for the same task.

Composer defaults to five concurrently running worktrees. The limit is
configurable. Retained worktrees without active runs do not consume execution
slots.

A requested run that cannot start enters a durable queue. This includes work
blocked by the global concurrency limit and work waiting for another task in
the same group. Queues are FIFO by default and support explicit user
reordering.

A queued item is a request, not a started run. Before it is dequeued, the task
may still change pipelines under the normal task rules. When execution receives
a scheduler slot, Composer resolves the task's current pipeline and newest
applicable revision, creates the run record, and pins that identity for the
attempt.

## Lazy worktree creation

Assigning a task or creating a group does not immediately create a branch or
worktree. Composer creates the worktree only after the first queued run for its
owner receives a scheduler slot and is about to execute.

Lazy creation ensures that:

- queued work does not reserve unnecessary worktrees;
- the worktree starts from the latest applicable base revision; and
- tasks that never run do not leave Git artifacts behind.

## Base branch selection

A new task or group worktree normally branches from the repository's base
branch:

1. `main`, when available;
2. `master`, when available;
3. the repository's configured default branch or remote HEAD; and
4. the current branch as the final fallback.

The selected base branch and revision are recorded with the worktree.

## Task groups

A group coordinates tasks that intentionally share one worktree and cumulative
set of changes.

- Groups are project-local.
- A task belongs to at most one group.
- New tasks may be created directly in an existing open group.
- A task may join or leave a group only before its first run starts.
- Group membership becomes immutable after the task's first run.
- Group runs execute serially in the shared worktree.
- An integrated and cleaned-up group closes permanently.
- Closed groups retain history but cannot accept new tasks.

Related work after closure uses a new group.

## Task change attribution

Composer records a change baseline when a task first starts in its worktree and
maintains the latest change snapshot attributed to that task. Because grouped
tasks execute serially, their baselines and snapshots keep each task's diff
separate from changes already present for earlier group tasks.

Rebasing the worktree updates Git ancestry but does not redefine prior task
changes as new work. Terminal task snapshots remain stable when later tasks
continue in the same group worktree.

## Synchronizing with the base branch

Before each later run in an existing worktree, Composer compares the recorded
base revision with the current base branch.

- If the base has not advanced, the run starts without Git mutation.
- If the base advanced, Composer rebases the worktree branch before execution.
- Composer never synchronizes or rebases a worktree during an active run.
- A base change detected during execution is handled before the next run.

The first version observes local base-branch advancement only. Remote polling
or automatic fetching may be added later but is not required for initial
worktree synchronization.

If synchronization requires a clean worktree and changes are uncommitted,
Composer creates a clearly identified checkpoint commit first. Checkpoint
commits are operational safety points and may later be squashed or reorganized
during user-directed integration. Composer never creates them in the project's
base worktree.

## Conflict resolution

A dedicated OpenCode conflict-resolution step attempts to resolve conflicts
created by synchronization and validates the result before execution continues.

If automatic resolution or validation fails:

- the run does not begin or continue past synchronization;
- the worktree and conflict state remain intact;
- Composer pauses for user intervention; and
- Composer presents the relevant context and suggested commands.

Conflict resolution is bounded. Composer does not launch unbounded resolver
attempts or discard changes after a failed resolution.

## Run recovery after restart

Scheduler and run state survive Composer restarts:

- queued run requests remain queued in their established order;
- an active run remains a resumable run record;
- its pipeline revision remains pinned;
- an interrupted agent step starts a continuation turn in the same OpenCode
  session; and
- model-opened OS terminal processes become interrupted records rather than
  being reported as still running.

The resumed agent receives terminal interruption information and decides how to
recover. Composer does not blindly rerun terminal commands after restart.

Standalone pipeline command steps have different recovery behavior from
model-opened terminals. If Composer stops while a command step is active, the
interrupted command attempt is recorded and the command step is rerun when the
pipeline run resumes.

A run waiting at a human approval step retains exclusive ownership of its
worktree and continues to consume one of the configured global execution slots.

## Worktree retention and integration

When a task, or every task in a group, becomes terminal, its worktree remains
available for inspection and integration. Retained worktrees do not consume the
concurrent-run limit.

Integration is user-triggered. The initial product provides:

- repository and branch status;
- PR, merge, rebase, and cleanup guidance;
- suggested commands; and
- conflict context.

Composer does not initially create pull requests, merge branches, or delete
worktrees automatically. Automated integration may be considered later if
actual use warrants it.

After integration, explicit cleanup removes the worktree. Cleaning up a group
also closes it permanently. Historical tasks, runs, sessions, queue records,
and worktree metadata remain inspectable after filesystem cleanup.

## Scheduler invariants

- One task has at most one active run.
- One task has at most one queued run request or active run.
- One worktree has at most one active run.
- Ungrouped tasks do not share worktrees.
- Tasks in one group do share a worktree and execute serially.
- No more than the configured number of worktrees execute concurrently.
- Queued runs are durable and user-reorderable.
- Worktrees are created only when dequeued work is ready to execute.
- Group membership cannot change after a task's first run.
- Active worktrees are never rebased.
- Integration and cleanup are user-triggered.

## Deferred details

Open scheduler, queue, Git, resolver, remote-sync, and integration questions are
tracked in [Deferred product decisions](deferred-product-decisions.md). They are
not part of this approved product contract.
