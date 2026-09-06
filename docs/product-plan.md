# Composer product plan

Composer is a local-first desktop command center for a solo developer working
across roughly 10-50 projects. The next product phase improves orientation and
project management first, then adds a persistent global assistant without
replacing the focused planning and coding workflows that already work.

This document records the product decisions made after S8. It is directional:
each slice still needs its own implementation notes and acceptance tests before
landing.

## Product principles

- The dashboard answers "what needs me?" before it reports aggregate metrics.
- Projects are durable containers, not disposable tabs.
- A project may contain several workflow workspaces, with at most one workspace
  of each type.
- Workflows share project identity, directory, lifecycle, and assistant context,
  but own their work items, history, health rules, navigation, and UI.
- Coding is the only workflow implemented now. Image generation, video
  generation, and other workflows may be added later.
- Do not build a workflow plugin system before a second workflow exists. Keep a
  clear boundary so the global shell and dashboard do not depend directly on
  coding cards and pipelines.
- Agent writes require an explicit user confirmation. The first global
  assistant reads and proposes work; it does not edit code or run workflows.
- Existing projects, cards, plans, pipelines, and run history must survive the
  changes.

## Information architecture

Global application routes:

- `/dashboard` - active projects, health, resumable work, and action inbox.
- `/assistant` - persistent global assistant threads.
- `/settings` - application and agent settings.
- `/archive` - archived projects and restore actions.

Project workflow routes:

- `/projects/:projectId/coding/board`
- `/projects/:projectId/coding/plan`
- `/projects/:projectId/coding/pipelines`
- `/projects/:projectId/coding/coding`
- `/projects/:projectId/coding/run/:cardId`

Opening a project returns to its last-used workflow route, with the coding board
as the fallback. A project header owns the small workflow tab set. The coding
workflow retains the compact icon rail for its views.

Future workflow routes fit under the same boundary, for example
`/projects/:projectId/images/...` and `/projects/:projectId/video/...`. A future
workflow contributes its own views and health summary without changing the
project dashboard's core model.

## Phase 1 - Product shell

Status: implemented 2026-09-06.

Establish the global/project navigation boundary before adding new domain
features.

- Make Dashboard the default application route.
- Introduce project routes containing both project id and workflow type.
- Synchronize route project context with the existing event-folding services.
- Add the coding workflow tab as the only current workflow.
- Preserve Board, Plan, Pipelines, Coding, and Run behavior.
- Remember each project's last-used view locally and fall back safely to Board.
- Add the foundation for keyboard project/view navigation and a future command
  palette.

Acceptance criteria:

- The app opens on Dashboard.
- Every known project is visible without opening tabs.
- Opening a project selects the correct project state and coding view.
- Deep links select the route's project before rendering project data.
- Existing coding workflow actions continue to work.
- The shell remains usable at narrow desktop and split-screen widths.

## Phase 2 - Project lifecycle

Status: implemented 2026-09-06.

Replace process-local closed tabs with durable project lifecycle state.

- Add `requestProjectArchive` and `requestProjectRestore` commands.
- Add `projectArchived` and `projectRestored` events.
- Add `archivedAt` to the project projection.
- Hide archived projects from normal Dashboard and assistant scope pickers.
- Preserve all project data and allow restoration.
- Reject archive while a pipeline is running or waiting for approval.
- Keep archived project names and directories reserved.

Archiving never deletes or alters the linked directory.

## Phase 3 - Dashboard and health

Status: implemented 2026-09-06.

The dashboard targets 10-50 projects with search, sorting, a visual card mode,
and a compact list mode.

Initial project health:

- Pipelines waiting for human approval.
- Cards whose latest run failed and have not subsequently succeeded.
- Missing or inaccessible project directories.
- Git working tree clean/dirty state.
- Current Git branch.
- Most recent commit subject and age.

Primary dashboard actions:

- Open the project's last-used workflow view.
- Resume a live run or waiting approval.
- Start a global assistant thread scoped to the project.
- Archive the project.
- Refresh transient repository state.

Git state is a transient read model, not an event-log domain. Refresh it on
dashboard entry, window focus, user actions that may change it, and manual
refresh. Use bounded concurrency, timeouts, and output limits.

The first inbox contains action-required items only: waiting approvals and
unresolved failed runs. It does not become a general activity feed.

## Phase 4 - Durable run health

Status: implemented 2026-09-06.

Terminal pipeline state currently disappears from the server projection. Add a
durable latest-run projection per card so dashboard health survives restarts.

- Record pipeline/card ids, status, timestamps, error, and agent session id.
- Starting a rerun changes an unresolved failure to active.
- A successful rerun clears that card's failure.
- A failed rerun keeps it actionable.
- Waiting human gates feed the global inbox.

Keep this as coding-workflow health. The global dashboard consumes a normalized
project health summary so future workflows can contribute their own signals.

## Phase 5 - UX refinement

Retain the dark, compact, monospace IDE identity while improving hierarchy and
feedback.

- Standardize page headers, primary actions, loading, empty, rejection,
  success, and failure states.
- Make project and directory context visible and actionable.
- Add consistent confirmation dialogs for destructive actions.
- Improve focus management, shortcut discovery, and keyboard navigation.
- Improve Board detail-panel space usage and run outcome visibility.
- Improve Plan document readability and narrow-window pane behavior.
- Turn Coding into useful session history with direct run links.
- Remove obsolete or misleading instructions and status text.
- Sanitize and consistently style Markdown and fenced code.

## Phase 6 - Global assistant domain

Status: implemented 2026-09-06 (S18 foundation: threads, global event
slice, `/assistant`; S19: the scoped read-only tools — composer state,
files, git, web). Conversation controls follow in Phase 7.

The global assistant is distinct from planning sessions and card-bound agent
sessions.

Thread behavior:

- Persistent named threads with archive support.
- One or more explicitly selected active projects per thread.
- Scope remains visible beside the conversation.
- Durable messages with stable ids and immutable branch lineage.
- Running, completed, failed, stopped, and stranded-turn recovery states.

Read capabilities:

- Composer cards, plans, pipelines, and run outcomes.
- Files in the selected project directories.
- Git status, history, and diffs.
- External web documentation.
- Cross-project portfolio summaries.

The initial assistant cannot edit project files, execute arbitrary commands,
start or stop pipelines, or answer approval gates. It receives server-mediated
read tools only. Every tool validates thread project scope. File tools enforce
real-path containment, symlink safety, binary and size limits. Web tools enforce
protocol, redirect, private-network, timeout, and response-size restrictions.

Global assistant state belongs in the event log. The store, fold, snapshot, and
SSE paths therefore need explicit global-event replay; current rehydration only
enumerates project-scoped events.

## Phase 7 - Assistant conversation UX

Status: controls implemented 2026-09-06 (S20: stop, retry, explicit
statuses, rename, safe markdown). Edit-and-resend with branch lineage and
the branch navigator are next (S21).

The assistant surface contains a thread sidebar, transcript, visible project
scope picker, composer, and contextual proposal panel.

Required controls:

- Stop a running response.
- Retry from the same user message.
- Edit and resend an earlier user message.
- Navigate branches created by edit-and-resend.
- Render Markdown and fenced code clearly and safely.

Retry appends an alternate response. Edit-and-resend creates an immutable
alternate branch; it never silently rewrites persisted history.

## Phase 8 - Work proposals

The assistant drafts editable board-ready cards instead of creating cards
directly.

Each proposal item includes:

- Target project.
- Inclusion checkbox.
- Title and description.
- Coding card type.
- Temporary key.
- Dependencies within its target project.

The user edits the proposal, confirms it, and Composer creates cards through the
existing validated processor. One conversation proposal may span projects, but
confirmation executes as a separate idempotent batch per project and reports
partial failures explicitly.

## Cross-cutting engineering requirements

- Preserve old event logs through additive fold defaults and migrations.
- Update both wire definitions and the golden fixture for every catalog change.
- Keep real LLM and web access out of automated tests; use `FakeEngine` and
  injected adapters.
- Add real-store restart tests for archive state, run health, global events,
  assistant transcripts, and proposals.
- Secure read tools even though Composer is local-first and currently uses
  permissive CORS for Windows/WSL attachment.
- Keep `pnpm verify` green at each slice boundary.

## Delivery order

1. Global/project shell and coding-workflow route migration.
2. Durable project archive and restore.
3. Durable run health and transient Git status.
4. Projects dashboard and action-required inbox.
5. Cross-application UX refinement and command palette.
6. Persistent read-only global assistant.
7. Assistant branching and advanced conversation controls.
8. Editable work proposals and confirmed card creation.
