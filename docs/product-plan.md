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
- Pipeline stages define the coding board. The board projects only stages marked
  as Kanban-visible, while task cards expose finer-grained execution state. See
  [Pipeline and Kanban model](pipeline-kanban-model.md).

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
- `/projects/:projectId/coding/docs`
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

Status: implemented 2026-09-06 (S20: stop, retry, explicit statuses,
rename, safe markdown; S21: edit-and-resend with immutable branch
lineage and the branch navigator; S22: token-level streaming on a
serve-based runtime).

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

Status: implemented 2026-09-06 (S23).

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

## Phase 9 - Docs, diagrams, and knowledge

Status: implemented 2026-09-06 (S26 docs storage and the read-only
viewer; S27 the editor with unsaved-work guards; S28 mermaid rendering
in docs and assistant replies; S29 the knowledge library and the
agent's search/save MCP tools; S30 the knowledge pane and the one-click
remember; S31 the drag-and-drop flow editor over the mermaid subset).

Composer gains durable written artifacts: per-project documentation as real
markdown files, inline diagrams, and a global knowledge library the assistant
can query and extend.

Decisions:

- Docs are plain markdown files under `<projectDirectory>/docs/` — versioned
  with the project's own code, readable by the assistant's existing file
  tools, and editable outside Composer without breaking anything. A project
  without a linked directory has no docs surface (empty state pointing at
  directory linking).
- Diagrams are ```mermaid fenced blocks rendered inline. A drag-and-drop flow
  editor round-trips a small mermaid flowchart subset (boxes, diamonds,
  labeled arrows — logic flows, not art), so the saved file stays markdown.
- Knowledge is markdown (small title/tags frontmatter) under the composer
  data dir (`$COMPOSER_DATA_DIR/knowledge/`) — global, project-agnostic,
  outside any repository.
- The assistant recalls nothing automatically. It queries knowledge and docs
  itself through new MCP tools (`composer_knowledge_search`,
  `composer_knowledge_save`), visible in the tool-activity strip; project
  docs stay reachable through the existing `list_files`/`read_file` tools.

Architecture notes:

- File content is the truth; the event log carries change notifications, not
  copies. Doc and knowledge events carry metadata only (path, title, size,
  hash, timestamps). Content moves over REST (list/read/write/delete).
- Doc and knowledge writes go through the processor (single writer), enforce
  real-path containment, symlink, binary, and size limits like the assistant
  file tools, and publish metadata events (`docCreated`, `docSaved`,
  `docDeleted`, `knowledgeSaved`, `knowledgeDeleted`) so desktop folds stay
  reactive. External file edits reconcile on list refresh and view entry.
- The knowledge directory is the only agent-writable location added by this
  phase. The assistant still cannot edit project files; docs remain
  human-edited through the editor.

Slices:

- S26 Docs storage and viewer: wire additions (commands, metadata events,
  golden regen, protocol bump to 3), server CRUD over
  `<projectDirectory>/docs/**.md`, docs view in the coding rail with list and
  safe markdown rendering.
- S27 Doc editor: create, edit, rename, delete with a real editor
  (CodeMirror 6 — CSP-clean), unsaved-changes guard, save/delete through the
  processor with explicit confirmations for destructive actions.
- S28 Mermaid rendering: shared markdown pipeline renders ```mermaid blocks
  to inline SVG (mermaid npm) in the docs viewer and the assistant
  transcript; malformed diagrams render a visible error, never break the
  page; sanitizer/CSP verification (no unsafe-eval; Angular sanitizer
  bypassed only for mermaid-owned SVG output).
- S29 Knowledge storage and agent access: knowledge service over the XDG
  knowledge dir, REST list/read/write/delete/search (title, tag, and body
  scoring), metadata events, and the two MCP tools behind the existing
  `/mcp/read` whitelist.
- S30 Knowledge UX: knowledge tab in the assistant surface (list, view,
  search, edit) and a "save as knowledge" action on assistant messages that
  writes through the same server path.
- S31 Flow editor: drag-and-drop canvas over the mermaid flowchart subset —
  add, connect, move, relabel nodes and edges, auto-layout (dagre), two-way
  sync with the fenced block in the doc being edited.

Acceptance criteria:

- Docs are ordinary `.md` files in the project repository; edits made outside
  Composer appear on refresh, and Composer's writes are plain file writes.
- Assistant threads scoped to a project can read its docs with existing
  tools; agents can save and later find knowledge through MCP.
- Mermaid blocks render in docs and assistant replies; a bad diagram shows an
  inline error without losing the rest of the document.
- The flow editor round-trips: canvas edits re-emit the fenced block; hand
  edits to the code appear on the canvas; surrounding doc text is untouched.
- Every slice keeps `pnpm verify` green; the protocol bump leaves stale
  servers refused, not silently attached.

## Phase 10 - Pipeline-first Kanban

Status: in progress 2026-09-07 (S35: the staged domain core - pipeline
stages, per-pipeline board tabs, run records with revisions, run locks,
error returns, and the staged pipeline editor; S36: the agent outcome
tool - stage outcome rules, the report tool, required-outcome
enforcement, and the shipped defaults; the linear visual editor
follows).

Make each pipeline the source of its task workflow and board projection. A
project may have multiple pipeline tabs, each showing only the pipeline stages
configured as Kanban-visible. Execution steps remain visible on task cards and
in run detail without automatically becoming board columns.

The approved domain behavior, including assignment, run locking, retries,
pipeline revisions, hidden stages, recovery transitions, and the linear visual
editor, is defined in the
[Pipeline and Kanban model](pipeline-kanban-model.md).

Acceptance direction:

- One task is assigned to one pipeline and appears on that pipeline's board
  tab.
- Pipeline steps reference ordered stages; multiple steps may share a stage.
- Active runs own stage transitions and lock manual task movement.
- Hidden stage activity is shown on the task card while the card remains in its
  previous visible column.
- Retries preserve failed runs and reuse the task's prior OpenCode session.
- Pipeline edits do not mutate active or historical runs.
- The editor presents a linear visual stage diagram without general graph
  branching.

## Phase 11 - Assistant capability boundaries

Status: planned 2026-09-07.

Formalize unscoped and multi-project threads, explicit plan updates, knowledge
provenance, deterministic skill resolution, and optional project indexing. See
[Assistant, knowledge, and skills model](assistant-knowledge-skills-model.md).

Acceptance direction:

- A thread owns one OpenCode session and one active turn, while separate threads
  may run concurrently.
- Zero-project threads retain research and global-knowledge capabilities without
  gaining project access.
- Explicit instructions authorize scoped plan updates and global knowledge
  writes.
- Built-in Composer skills work on clean installations and cannot be overridden.
- Project indexing remains optional and is never required for normal operation.

## Phase 12 - Live run workbench

Status: planned 2026-09-07.

Evolve the run page into the resizable Agent, Context, and Terminal workbench
defined in [Live run workbench](live-run-workbench.md). Preserve one continuous
OpenCode session across retry attempts while keeping runs and terminal output
historically distinct.

Acceptance direction:

- Wide layouts provide three resizable panes and narrow layouts provide tabs.
- The context pane shows task-wide modified files with read-only unified and
  side-by-side diffs.
- Model-opened terminals remain grouped by run and allow read-only inspection
  plus stop control.
- Restarted terminal processes are reported as interrupted rather than alive.
- The run composer sends guidance to the task's active OpenCode session.

## Phase 13 - Concurrent worktree scheduler

Status: planned 2026-09-07.

Add durable queued execution and Git worktree isolation as defined in
[Scheduling and worktrees](scheduling-worktrees.md). This phase replaces the
current boot-cancellation behavior for active runs with resumable OpenCode
session continuity.

Acceptance direction:

- Ungrouped tasks receive dedicated worktrees and grouped tasks serialize in a
  shared project-local worktree.
- Worktrees are created lazily when queued work receives an execution slot.
- The configurable scheduler defaults to five concurrently executing worktrees.
- Queues survive restart, are FIFO by default, and support manual reordering.
- Existing worktrees rebase when their base advances, using checkpoint commits
  and a bounded conflict-resolution agent when needed.
- Integration and worktree cleanup remain user-triggered.

Choices intentionally excluded from the approved phase contracts are maintained
in [Deferred product decisions](deferred-product-decisions.md).

## Cross-cutting engineering requirements

- Preserve old event logs through additive fold defaults and migrations.
- Update both wire definitions and the golden fixture for every catalog
  change, and bump the wire protocol version (`server/src/wire/events.ts`
  and `desktop/electron/server-registry.js`) with it — the gateway refuses
  a server whose `/health` pin doesn't match, so a stale server can't be
  attached to silently after an upgrade.
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
9. Docs, diagrams, and the global knowledge library.
10. Pipeline-defined stages, per-pipeline Kanban tabs, and the visual pipeline
    editor.
11. Assistant boundaries, deterministic skills, and knowledge provenance.
12. Three-pane live run workbench and task-wide diff inspection.
13. Concurrent queued execution with task and group worktrees.
