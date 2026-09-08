# Server Best-Practices Audit

Date: 2026-09-08

Scope: `server/src/**/*.ts`

This audit checks four requested rules:

- Control flow nested more than three levels below a function body.
- Classes or modules with too many reasons to change.
- Meaningful duplicated policy or implementation.
- Domain/application objects coupled to filesystem, network, process, clock, entropy, or database I/O that should sit behind a port.

Severity means:

- **High:** correctness, authorization, security, or consistency risk.
- **Medium:** material maintainability or testability problem.
- **Low:** localized drift or readability risk.

## High-Severity Findings

### SRV-001: Write containment can follow a final-component symlink

**Status:** Resolved 2026-09-08. Shared containment now verifies real parents and opens final write targets with `O_NOFOLLOW`; docs and knowledge have final-symlink regression tests.

**Categories:** duplicate code, inappropriate I/O boundary, security

**References:**

- `server/src/docs/paths.ts:41-68`
- `server/src/knowledge.ts:149-178`
- `server/src/workflows.ts:138-149`
- `server/src/workflows.ts:211-218`
- `server/src/agents/assistant/filesystem.ts:10-33`

Several implementations independently enforce filesystem containment. The docs resolver realpaths existing parent directories but does not realpath or reject an existing final target. Knowledge writes perform a lexical containment check against the real root but then use `writeFileSync` on a potentially symlinked target. A planted final-component symlink can therefore redirect a write outside the intended root.

The duplication makes this security policy likely to drift further.

**Remediation:** Add one low-level filesystem containment module with `isWithinRoot`, existing-target resolution, and safe write-target resolution. Existing final targets must be realpathed and contained or opened using a strategy that rejects symlinks. Keep domain-specific path grammar and errors in each repository.

### SRV-002: Transcript collision policy is duplicated and behavior has diverged

**Status:** Resolved 2026-09-08. Assistant, planning, and worker-session folds now use the shared collision policy in `domain/transcript.ts`; planning has a regression test.

**Categories:** duplicate code, correctness

**References:**

- `server/src/fold/planning.ts:39-64`
- `server/src/fold/threads.ts:101-127`
- `server/src/domain/transcript.ts:7-49`

Both folds claim an opposite-role message cannot replace an occupied transcript index. Assistant threads move the incoming message to the next index. Planning and worker-session transcripts remove the current occupant and replace it.

This can erase a queued user message or late completion in planning/worker transcripts, while assistant transcripts preserve both.

**Remediation:** Put collision-safe, idempotent transcript upsert behavior in `domain/transcript.ts` and use it from both folds.

### SRV-003: Filesystem mutation and event persistence form an unsafe dual write

**Status:** Resolved 2026-09-08. Docs and workflow repositories are now injected ports (beside the existing `KnowledgeStore`); each mutating repository method returns the write plus a `rollback` closure, and the processor publishes each command's metadata event(s) under a compensating runner — if any event append fails, the file mutation is undone so a failed command leaves neither the file nor the event behind (strategy: compensating actions). Genuine storage failures throw `StorageError` and surface as transport errors instead of `invalidCommand`; containment rejections (planted symlinks) stay validation results. Regression tests cover save, rename (two events) and delete rollback, plus the storage-vs-validation separation.

**Categories:** inappropriate I/O boundary, consistency

**References:**

- `server/src/processor/files.ts:17-67`
- `server/src/processor/files.ts:100-135`
- `server/src/processor/files.ts:209-253`
- `server/src/docs/index.ts`
- `server/src/knowledge.ts:33-179`
- `server/src/workflows.ts:46-174`

The command handlers mutate files before publishing durable events. If the file operation succeeds and `Bus.publish()` or event-store append fails, disk and replayed state disagree. Rename is especially exposed because one disk operation is followed by two event publications.

The handlers also collapse infrastructure errors into domain-style invalid-command outcomes and perform synchronous filesystem work on the event loop.

**Remediation:** Inject document, knowledge, and workflow repository ports. Define an explicit consistency strategy such as idempotent operations plus reconciliation, an operation journal, or compensating actions. Preserve infrastructure failures separately from validation failures.

### SRV-004: Worker-session authorization differs by tool branch

**Status:** Resolved 2026-09-08. Worker tool dispatch now validates the project and running agent session before every tool branch; workflow retrieval has an authorization regression test.

**Categories:** duplicate policy, authorization

**References:**

- `server/src/http/mcp.ts:115-132`
- `server/src/processor/files.ts:145-239`
- `server/src/processor/pipelines.ts:236-270`
- `server/src/agents/worker/tools.ts:113-199`

Workflow recording and outcome branches independently validate different subsets of project/session state. Workflow search and read accept a non-empty session ID without confirming that the session exists, belongs to the project, or is running.

**Remediation:** Resolve and authorize `{ projectId, sessionId }` once before worker-tool dispatch. Pass a validated worker context to handlers, which should perform only tool-specific checks.

## Responsibility Findings

### SRV-005: `AssistantOrchestrator` owns too much mutable lifecycle state

**Status:** Resolved 2026-09-08. Two extractions: `turn.ts` `TurnCoordinator` (SRV-013) took the per-session turn lifecycle, and `assistant-turn.ts` `AssistantTurnProjector` now owns the per-turn mutable state and event projection (abort controller, streaming part, last completion, reply lineage, and the fault/stop terminal handling). The orchestrator keeps only routing and spec building.

**Severity:** Medium

**Reference:** `server/src/assistant.ts:44-328`

The class handles bus routing, per-thread serialization, queue and retry policy, workspace provisioning, model selection, runtime-session continuity, aborts, transcript indexes, reply lineage, engine-event projection, and terminal-state policy. Seven mutable maps/sets must remain synchronized across completion, failure, retry, stop, and cleanup.

**Remediation:** Extract an engine-event projector and a reusable per-session turn coordinator. Inject a turn-spec/workspace factory.

### SRV-006: `OpenCodeServeEngine` combines process supervision, HTTP client behavior, SSE, pooling, and turn execution

**Status:** Resolved 2026-09-08. Split into `engine/serve-process.ts` `ServeProcessManager` (spawn, health-wait, SSE reader, pooling, teardown) and `engine/serve-client.ts` `OpenCodeServeClient` (session/prompt/abort requests). `OpenCodeServeEngine.run` is now only the turn coordinator + `ServeEventReducer`.

**Severity:** Medium

**Reference:** `server/src/engine/serve.ts:198-426`

Changes to CLI startup, health checks, HTTP sessions, SSE reduction, MCP environment, timeouts, pooling, stale-session recovery, or shutdown all affect one class.

**Remediation:** Extract a `ServeProcessManager` and an `OpenCodeServeClient`. Keep `OpenCodeServeEngine.run` as the turn coordinator.

### SRV-007: `Board` combines queries with unrelated transition policies

**Status:** Resolved 2026-09-08. `Board` is now the read facade (queries + the read-or-reject `require*` helpers). The event-producing card transitions moved to `domain/card-transitions.ts` `CardTransitions` and the run/outcome policies to `domain/run-policy.ts` `RunPolicy`, both over the same `ProjectState` view.

**Severity:** Medium

**Reference:** `server/src/domain/board.ts:17-341`

`Board` is simultaneously a card/pipeline/run query facade and the policy/event factory for card mutation, pipeline lifecycle, gates, outcomes, and dependency transitions.

**Remediation:** Retain `Board` as a read facade. Move card transitions and run/outcome policies into focused policy modules over the same state view.

### SRV-008: `Pipeline` combines model behavior, boundary parsing, normalization, and command validation

**Status:** Resolved 2026-09-08. The action parses moved to `domain/pipeline-codec.ts` (`pipelineStageFromAction`/`pipelineStepFromAction`/`pipelineDraftFromAction`), and the draft validation/normalization to `domain/pipeline-draft.ts` (`validateDraft`/`normalizeStages`/`sameDefinition`/`missingStepField`). `Pipeline` keeps only topology + serialization.

**Severity:** Medium

**Reference:** `server/src/domain/pipeline.ts:39-429`

The domain class knows untyped action payloads and wire readers in addition to topology, serialization, draft validation, normalization, and rejection wording.

**Remediation:** Move `fromAction` behavior to an action codec and draft validation/normalization to a `PipelineDraftValidator`. Keep model topology and serialization on `Pipeline`.

### SRV-009: `EventStore` still owns event persistence, settings persistence, database lifecycle, and locking

**Status:** Resolved 2026-09-08. Split into `store/database.ts` `ComposerDatabase` (connection, PID lock, sequence counter), `store/event-repository.ts` `EventRepository`, and `store/settings-repository.ts` `SettingsRepository`; `store/event-store.ts` `EventStore` is now a compatibility facade over the three (public API unchanged — the restart tests still pass).

**Severity:** Medium

**Reference:** `server/src/store/event-store.ts:22-122`

The recent file split improved implementation layout, but the public class still has unrelated event-log and settings responsibilities and owns the process lock/database lifecycle.

**Remediation:** Give event and settings repositories separate interfaces over a shared database-lifecycle object. Keep a compatibility facade only at the composition boundary if needed.

### SRV-010: `processor/files.ts` contains three independent command domains

**Status:** Resolved 2026-09-08. Split into `processor/docs.ts`, `processor/knowledge.ts`, and `processor/workflows.ts` (each exporting its own command map), with the shared `directoryOf`/`commitFile` runners in `processor/files-util.ts`. The open recordings now live in an injected `WorkflowRecordings` registry (`processor/recordings.ts`) instead of a `Map` hanging on `Processor`.

**Severity:** Medium

**Reference:** `server/src/processor/files.ts:1-266`

Docs CRUD, global knowledge CRUD, and stateful worker workflow recording have independent reasons to change. The workflow concern also causes `Processor` to expose recording state.

**Remediation:** Split into docs, knowledge, and workflow-recording command modules. Encapsulate recordings in an injected registry.

### SRV-011: `snapshotEvents` owns every aggregate reconstruction protocol

**Status:** Resolved 2026-09-08. Split into pure per-domain appenders (`snapshot/assistant.ts`, `snapshot/proposals.ts`, `snapshot/project.ts`) over a shared nonce-scoped frame emitter (`snapshot/emit.ts`). `snapshotEvents` is now only the ordering coordinator + frame factory.

**Severity:** Medium

**Reference:** `server/src/snapshot.ts:35-296`

One function reconstructs assistant threads, proposals, projects, planning and worker transcripts, pipeline revisions, historical and active runs, cards, and derived dependency state while sharing one index cursor.

**Remediation:** Extract pure per-domain snapshot appenders. Keep `snapshotEvents` only as the explicit ordering coordinator with a shared frame factory.

### SRV-012: `registerMcpRoutes` implements three distinct MCP applications

**Status:** Resolved 2026-09-08. Split into planner, assistant, and worker route registrars (`http/mcp/planner.ts`, `http/mcp/assistant.ts`, `http/mcp/worker.ts`). `http/mcp.ts` is now composition only.

**Severity:** Medium

**Reference:** `server/src/http/mcp.ts:32-135`

Planner commands, assistant reads/writes, and worker tools have different authorization and translation behavior but are implemented in one registrar.

**Remediation:** Split planner, assistant, and worker route registrars. Keep `http/mcp.ts` as composition only.

## Duplicate-Code Findings

### SRV-013: Planning and assistant orchestration duplicate turn coordination

**Status:** Resolved 2026-09-08. Extracted a hook-driven `TurnCoordinator` (`server/src/turn.ts`) that owns the shared lifecycle — subscription, the one-turn in-flight lock, engine-session continuity, transcript-index reservations, and the follower (queued-message) loop. `PlanningOrchestrator` and `AssistantOrchestrator` supply planner/assistant-specific hooks; assistant-only stop/retry/tools/lineage stay in the orchestrator. Behavior pinned by the existing orchestrator tests (unmodified).

**Severity:** Medium

**References:**

- `server/src/planning.ts:29-242`
- `server/src/assistant.ts:29-381`

Both implement subscription lifecycle, one-turn locking, queued-user detection, runtime-session continuity, model/timeout setup, reserved transcript indexes, failure completion, cleanup, and stranded-turn recovery. Assistant-specific stop, retry, tools, and lineage behavior should remain separate.

**Remediation:** Extract a hook-driven `TurnCoordinator` for shared lifecycle mechanics rather than introducing a common base class.

### SRV-014: Planner tickets and assistant proposals duplicate card-batch policy

**Status:** Resolved 2026-09-08. Extracted `processor/card-batch.ts` — `allocateCardIds` / `materializeCards` / `publishCardBatch` — the shared id allocation, in-batch key remap, default-pipeline assignment, card construction, and commit+dependency-event path. Tickets and proposal confirm call it with their own context defaults (session id for tickets); validation wording and the terminal events (session completion vs proposal outcomes) stay per-caller.

**Severity:** Medium

**References:**

- `server/src/domain/planning.ts:48-84`
- `server/src/domain/proposal.ts:45-71`
- `server/src/processor/planning.ts:102-163`
- `server/src/processor/proposals.ts:26-52`
- `server/src/processor/proposals.ts:84-163`

Title/key/dependency validation, ID remapping, default pipeline assignment, card construction, and dependency events are implemented independently and already differ in limits and type validation.

**Remediation:** Extract a domain-neutral card-batch validator/materializer parameterized by context defaults. Keep proposal inclusion/partial outcomes and planning-session completion separate.

### SRV-015: Knowledge and workflow repositories duplicate a flat Markdown library

**Status:** Resolved 2026-09-08. The text helpers were already shared in `domain/markdown.ts`; the write/delete protocol (root provisioning, containment resolution, O_NOFOLLOW write, remove, and the containment-vs-StorageError classification with the SRV-003 rollback) is now `filesystem/contained-file.ts`, used by both stores. The domain-specific listing/search/parse stays per store (their shapes differ).

**Severity:** Medium

**References:**

- `server/src/knowledge.ts:17-178`
- `server/src/workflows.ts:20-218`

Both implement the same size/list/search caps, sorted flat Markdown listing, slug allocation, scoring, containment, read/stat, write, and delete protocol.

**Remediation:** Extract a small flat Markdown filesystem repository parameterized by root, parser, serializer, and metadata adapter. Do not move workflow-recording policy into it.

### SRV-016: OpenCode CLI and serve adapters duplicate text/tool reduction

**Status:** Resolved 2026-09-08. Extracted `server/src/engine/reduce.ts` with the shared `resultContent`, `TextReducer` (growing text → byte-precise deltas), and `ToolReducer` (announce-once / settle-once). The run engine and `ServeEventReducer` now map their vendor wire onto these primitives; the CLI's first-sight output rule rides a `settleOnOutput` flag. Behavior pinned by `serve-engine.test.ts` (unmodified).

**Severity:** Medium

**References:**

- `server/src/engine/opencode.ts:35-53`
- `server/src/engine/opencode.ts:165-258`
- `server/src/engine/serve.ts:39-186`

The transports differ, but both reproduce incremental text calculation, tool-call announcement, terminal tool-result handling, completion/error interpretation, and output conversion.

**Remediation:** Normalize both vendor inputs into shared part updates and apply one text/tool reducer.

### SRV-017: MCP schemas and runtime argument decoders are parallel contracts

**Status:** Resolved 2026-09-08. Tightened the decoders to their published schemas: the planner's `create_tickets` no longer accepts the undocumented `type` alias (schema field `cardType` only), the worker's `workflow_search` rejects a missing/empty query (schema `required: ['query']`), and the assistant's `knowledge_save` no longer forwards the schema-absent `path` form (the desktop's path edits ride the `/action` route, not the MCP tool). The planner alias test was updated to pin the tightened behavior.

**Severity:** Medium

**References:**

- `server/src/agents/planner/tools.ts:45-123`
- `server/src/agents/worker/tools.ts:19-199`
- `server/src/agents/assistant/tools.ts:4-156`
- `server/src/agents/assistant/dispatcher.ts:9-57`
- `server/src/http/mcp.ts:71-105`

Published JSON schemas and handwritten decoders already differ. Examples include planner's undocumented `type` alias, worker search accepting a missing query despite a required schema field, and assistant knowledge-save accepting a path-based edit form absent from the schema.

**Remediation:** Define each tool with one schema-backed decoder. Put intentional compatibility aliases in an explicit normalization layer.

### SRV-018: Empty `ProjectState` construction is copied three times

**Status:** Resolved 2026-09-08. `fold/state.ts` exports `emptyProjectState(projectId)`; `projectStateOf` builds from it and `dashboard` / `assistant/state` import it instead of copying the literal.

**Severity:** Low

**References:**

- `server/src/fold/state.ts:74-93`
- `server/src/dashboard/index.ts:72-86`
- `server/src/agents/assistant/state.ts:8-22`

The copies are currently field-for-field identical but can silently diverge when state grows.

**Remediation:** Export a pure `emptyProjectState(projectId)` factory. Let `projectStateOf` insert its result while read-only consumers use it without insertion.

### SRV-019: Settings normalization is spread across HTTP, load, and persistence

**Status:** Resolved 2026-09-08. Added pure `normalizeStoredSettings` / `applySettingsPatch` / `parseSettingsPatch` to `store/settings.ts`. The repository uses the first two, the HTTP route only parses/rejects via the third.

**Severity:** Low

**References:**

- `server/src/http/settings.ts:31-74`
- `server/src/store/event-store.ts:38-52`
- `server/src/store/event-store.ts:84-110`

Whitespace, empty values, null clearing, malformed map values, and stored-value cleanup have subtly different rules at each boundary.

**Remediation:** Add pure stored-settings and settings-patch normalization functions in `store/settings.ts`. HTTP should only parse/reject malformed transport types.

### SRV-020: Project-directory route guards are copied

**Status:** Resolved 2026-09-08. Added `http/project-dir.ts` `resolveProjectDirectory` (404 unknown, else the directory); the docs and workflow routes use it instead of repeating the guard.

**Severity:** Low

**References:**

- `server/src/http/docs.ts:12-42`
- `server/src/http/workflows.ts:12-57`

Unknown-project and missing-directory handling repeats across five handlers and can drift in status-code policy.

**Remediation:** Add a small HTTP helper that resolves a project directory or returns the canonical response.

### SRV-021: Binary-file detection is exactly duplicated

**Status:** Resolved 2026-09-08. Added `filesystem/binary.ts` `looksBinary(buffer)`; the docs reader and the assistant read tool share the pure helper, each keeping its own response.

**Severity:** Low

**References:**

- `server/src/docs/index.ts:61-95`
- `server/src/docs/index.ts:216-222`
- `server/src/agents/assistant/filesystem.ts:72-114`

Both use the same NUL/control-byte heuristic over an 8 KiB sample.

**Remediation:** Share only the pure `looksBinary(buffer)` helper; preserve each caller's different response behavior.

## Inappropriate I/O Coupling

### SRV-022: Domain transitions read clock and entropy directly

**Status:** Resolved 2026-09-08. Added `Clock`/`IdGenerator` ports (`domain/ports.ts`); `Thread`'s archive/restore/message/resend transitions and `Planning.userMessage` now take the clock (and id generator) as parameters — the application layer passes `nowIso`/`randomUUID`, so the transitions are pure.

**Severity:** Medium

**References:**

- `server/src/domain/thread.ts:7-113`
- `server/src/domain/planning.ts:5-36`
- `server/src/wire/envelope.ts:35-44`

Domain transitions call `randomUUID()` and `nowIso()`. Identical state and commands therefore do not produce identical pending events, and domain code depends on Node/wire concerns.

**Remediation:** Generate IDs and timestamps in the application layer through `Clock` and `IdGenerator` ports and pass them into pure transitions.

### SRV-023: Turn orchestration performs hidden synchronous agent provisioning

**Status:** Resolved 2026-09-08. `PlanningOptions`/`AssistantOptions`/`RunnerOptions` each gain a `provision` port; the planner, assistant, and worker step call it (defaulting to `ensureAgentFiles`/`ensureAssistantWorkspace`) instead of reaching the filesystem shipping directly.

**Severity:** Medium

**References:**

- `server/src/planning.ts:102-143`
- `server/src/assistant.ts:154-198`
- `server/src/runner/agent-step.ts:19-70`
- `server/src/agents/ship.ts:4-44`

Scheduling paths directly create directories and agent files. Failure policy differs between planner/assistant and worker execution, and provisioning runs inside turn logic.

**Remediation:** Inject an `AgentProvisioner` port and preferably provision during project/workspace setup or engine initialization.

### SRV-024: Node child-process handles leak into runner policy

**Status:** Resolved 2026-09-08. `RunTask.child` is now the opaque `CommandHandle { cancel() }` (the concrete `ChildProcess` stays inside the command step), and the lifecycle coordinators call `cancel()` instead of `kill('SIGKILL')`.

**Severity:** Medium

**References:**

- `server/src/runner/types.ts:5-43`
- `server/src/runner/pipeline-runner.ts:34-65`
- `server/src/runner/frame-handler.ts:50-61`
- `server/src/runner/command-step.ts:5-83`

`RunTask` exposes `ChildProcess`, and lifecycle coordinators issue `SIGKILL` directly. Process ownership and cancellation are consequently distributed across the process adapter and runner policy.

**Remediation:** Keep the child process inside a `CommandExecutor`; expose an opaque handle with `cancel()` and result/output behavior.

### SRV-025: Project command validation depends on cwd and synchronous filesystem state

**Status:** Resolved 2026-09-08. Added `filesystem/directory.ts` `makeDirectoryResolver` (canonical `realpathSync`, explicit base) injected into the `Processor` as `resolveDirectory`; the project commands use it, keeping the duplicate-link policy in the handler.

**Severity:** Medium

**Reference:** `server/src/processor/projects.ts:14-85`, `server/src/processor/projects.ts:157-177`

Project policy resolves relative paths against ambient `process.cwd()` and calls `statSync()`. Results vary with launch directory, tests require real filesystem setup, symlink aliases are not canonicalized, and validation is still TOCTOU.

**Remediation:** Inject a directory resolver/probe with an explicit base directory and canonical path result. Keep duplicate-link policy in the command handler.

### SRV-026: Model parsing and process execution share one concrete dependency

**Status:** Resolved 2026-09-08. `HttpDeps` gains a `models` catalog; the settings route reads it (defaulting to the OpenCode adapter `listOpenCodeModels`), which boot injects. The pure `parseOpenCodeModels` stays separate from the process adapter.

**Severity:** Low

**References:**

- `server/src/models.ts:1-24`
- `server/src/http/settings.ts:18-29`

The settings route directly executes `opencode models`; the pure parser and process adapter are bundled together and cannot be configured independently.

**Remediation:** Inject a `ModelCatalog` into HTTP dependencies and keep command execution in an OpenCode adapter.

### SRV-027: A pure pipeline validator imports the agent provisioning barrel

**Status:** Resolved 2026-09-08. `processor/pipelines.ts` imports `PIPELINE_AGENT_KINDS` directly from `agents/names.ts` (the pure catalog), not the provisioning barrel.

**Severity:** Low

**References:**

- `server/src/processor/pipelines.ts:6-14`
- `server/src/agents/index.ts:7-13`

The validator only needs `PIPELINE_AGENT_KINDS`, but importing `agents/index.ts` also reaches filesystem provisioning exports.

**Remediation:** Import the catalog directly from `agents/names.ts`, or expose a pure catalog entry point.

## Excessive Nesting

The function body is treated as indentation level zero. Only control-flow nesting beyond three levels is listed; multiline expressions and object literals are not counted.

### SRV-028: `snapshotEvents` nests transcript-kind dispatch inside three loops/branches

**Status:** Resolved 2026-09-08. The SRV-011 appender split extracted agent-session replay and transcript-entry serialization into `snapshot/project.ts`, flattening the loop/branch chain.

**Severity:** Medium

**Reference:** `server/src/snapshot.ts:83-169`

The relevant chain reaches project iteration, agent-session iteration, transcript-entry iteration, then entry-kind branching.

**Remediation:** Extract agent-session replay and transcript-entry serialization helpers.

### SRV-029: Pipeline outcome validation nests target policy inside stage/outcome traversal

**Status:** Resolved 2026-09-08. Extracted `assertEarlierReturn` (the known, strictly-earlier target check) in `domain/pipeline-draft.ts`; outcome and error-return validation now call it instead of nesting the target branch inline.

**Severity:** Medium

**Reference:** `server/src/domain/pipeline.ts:299-317`

The chain reaches stage iteration, outcome iteration, optional target branching, then missing/not-earlier target validation.

**Remediation:** Extract per-outcome target validation using a stage-order map.

### SRV-030: Serve event reduction nests protocol and part-state branching

**Status:** Resolved 2026-09-08. The SRV-016 reduction moved text/tool updates into the shared `engine/reduce.ts` `TextReducer`/`ToolReducer`, so the serve dispatch delegates to focused reducer methods instead of nesting part-state conditions.

**Severity:** Medium

**Reference:** `server/src/engine/serve.ts:91-125`

Protocol event dispatch contains part-kind and then text/tool-state conditions.

**Remediation:** Delegate text-part and tool-part updates to focused reducer methods or a handler map.

### SRV-031: Settings route nests model-map parsing four levels deep

**Status:** Resolved 2026-09-08. The route now delegates to the pure `parseSettingsPatch` model-map parser (from `store/settings.ts`), returning a normalized patch or a transport rejection.

**Severity:** Low

**Reference:** `server/src/http/settings.ts:52-70`

The route mixes optional field detection, object validation, entry iteration, and entry-value validation.

**Remediation:** Extract a pure model-map parser returning a normalized value or transport validation error.

## Valid I/O Boundaries

These modules touch I/O appropriately and should not be abstracted solely to satisfy a purity rule:

- `server/src/index.ts`: composition and server lifecycle.
- `server/src/store/**`: database repositories and PID-lock adapter. The concern is the breadth of `EventStore`, not that persistence performs I/O.
- `server/src/docs/**`, `server/src/knowledge.ts`, `server/src/workflows.ts`: explicit filesystem repositories. The concern is duplicated containment and application-layer dual writes.
- `server/src/engine/opencode.ts`, `server/src/engine/serve.ts`: external engine adapters.
- `server/src/runner/command-step.ts`: command process adapter. The concern is leaking its concrete handle.
- `server/src/agents/ship.ts`: filesystem provisioning adapter. The concern is direct use inside turn coordination.
- `server/src/dashboard/git.ts`: git query adapter.
- `server/src/mcp/**` and `server/src/http/**`: transport boundaries.
- `server/src/agents/assistant/filesystem.ts` and `server/src/agents/assistant/web.ts`: intentionally I/O-backed assistant tools.
- `server/src/bus.ts`: application infrastructure coordinating append, fold, and fan-out.

No direct filesystem, network, process, or database access was found in `server/src/fold/**`.

## Recommended Order

1. Fix `SRV-001` final-component symlink writes and centralize containment.
2. Fix `SRV-002` transcript collision behavior and add regression tests.
3. Fix `SRV-004` worker-session authorization before adding worker tools.
4. Choose and document a consistency strategy for `SRV-003` filesystem/event dual writes.
5. Split `processor/files.ts`, `registerMcpRoutes`, and snapshot appenders along existing domain boundaries.
6. Extract shared turn coordination and OpenCode part reduction only after behavior is covered by characterization tests.
7. Address the remaining responsibility, I/O, duplication, and nesting items opportunistically by subsystem.
