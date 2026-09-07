# Live run workbench

Status: approved product direction; target implementation planned.

This document defines the intended live run experience. The screenshot
`8963140e-a172-4b96-94fb-67e767dabd90.png` is the layout reference. Composer's
existing visual theme remains authoritative; the screenshot is not a request to
replace it.

## Purpose

The live run view is an execution and inspection workbench for one task. It is
not the pipeline editor and does not need a full pipeline diagram. Pipeline
position appears as compact stage and step status; the full visual stage diagram
belongs in the pipeline editor.

The wide layout has three main panes:

```text
Agent output | Context | Terminal output
```

The panes are resizable and start near the proportions in the reference image.
At widths where three panes are no longer useful, they become selectable tabs.

## Run header

The compact header establishes task and execution identity without consuming
workbench space. It may include:

- project and task identity;
- current stage and step;
- run status and attempt;
- active model and agent;
- elapsed time and tool-call count; and
- validation or build health.

The header status is a summary. Detailed evidence remains in the panes.

## Agent output pane

The primary pane shows the task's complete OpenCode session:

- streamed reasoning and responses;
- tool activity in execution order;
- agent state and suggested next actions; and
- clear separators between run attempts.

A retry creates a new run but continues the same OpenCode session. The complete
session remains visible so later attempts retain understandable context. A run
filter or navigation affordance may focus an attempt without deleting or
hiding the session history permanently.

The bottom composer remains available in wide and narrow layouts. Sending a
message delivers guidance to the task's active OpenCode session. It does not
create a second concurrent turn for that session.

## Context pane

The context pane is read-only execution context assembled from Composer and
OpenCode. It may show:

- token usage and cost;
- OpenCode todo state;
- task, run, agent, and session information;
- modified files; and
- added and removed line counts.

The modified-file list represents changes attributed to the whole task, not
only the current run attempt. Composer records a per-task change baseline when
the task first starts and a latest attributed snapshot as it runs. This keeps a
task's diff distinct when several tasks execute serially in one group worktree.
Clicking a file opens a dedicated read-only diff view.

The diff view supports:

- unified and side-by-side presentation;
- syntax-aware rendering where practical;
- navigation among modified files;
- additions, deletions, and changed-line counts; and
- safe handling of files that cannot be rendered as text.

The diff surface does not edit files. File modification remains the
responsibility of the active agent or the user's external development tools.

## Terminal output pane

The terminal pane contains two visually distinct groups:

- terminals opened by the model during agent execution; and
- standalone commands executed as pipeline steps.

- Each terminal has a stable identity and originating run attempt.
- Terminals remain grouped under their run attempts after a retry.
- Output remains chronological and may be collapsed.
- Running, completed, failed, stopped, listening, and interrupted states are
  visible.
- Concurrent model-opened terminals remain independently inspectable.
- Terminal input is read-only to the user.
- The user may stop a running terminal.

Stopping a terminal reports its exit to the active agent. It does not
automatically fail or pause the run; the agent decides how to respond.

Model-opened terminals may remain alive for the duration of their run. When the
run ends, Composer stops any terminals that are still running while preserving
their final output and status in history.

Pipeline command output remains associated with its pipeline step and command
attempt. Interrupted command attempts remain visible; after restart, the rerun
appears as a new attempt under the same step rather than replacing prior output.

If Composer restarts, OS terminal processes cannot be adopted. They become
`interrupted` records. The resumed agent receives that result and decides
whether to rerun a command or recover another way.

## Run and session history

Runs and OpenCode sessions have different lifetimes:

- A run is one immutable execution attempt against one pipeline revision.
- A task's OpenCode session may continue across retries and resumed runs.
- Agent output presents session continuity with run-attempt boundaries.
- Terminal records remain grouped by the run that created them.
- The task-wide diff spans work across all attempts using the task's attributed
  baseline and snapshot.

This distinction preserves both conversational continuity and reliable run
history.

## Responsive behavior

- Wide screens use three resizable panes.
- Narrow screens use Agent, Context, and Terminal tabs.
- Pane sizes and the selected narrow-screen tab should be remembered locally.
- The composer remains reachable without covering important output.
- Long output uses internal scrolling rather than expanding the whole page.
- Keyboard navigation and focus states follow Composer's existing patterns.

## Invariants

- The workbench is scoped to one task and its session.
- The context and diff surfaces are read-only.
- Task diffs remain attributable when tasks share a group worktree.
- Run attempts remain visibly distinct inside a continuous agent session.
- Previous terminal output remains attributable to its originating run.
- User terminal control is limited to stopping a running process.
- Model-opened terminals do not outlive their run.
- Restart never pretends an OS process survived.
- A full pipeline diagram is not required in the run workbench.

## Deferred details

Open layout, diff, filtering, reasoning-display, and renderer questions are
tracked in [Deferred product decisions](deferred-product-decisions.md). They are
not part of this approved product contract.
