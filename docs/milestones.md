# Milestones — composer v2

The plan for v2 after the 2026-09-04 reset. v1's lesson that shaped this
reset: composer spent M3a–M3.3 re-inventing an agent runtime (model
adapter, agent loops, buffers, budgets, tool surfaces, session bridges)
inside spect — the layer pi-mono and opencode already are. v2 keeps the
board, the event backbone, the planning turn, and pipelines on cards, and
**delegates agent execution to opencode**: a pipeline `agent` step launches
`opencode run --agent <name>` in the project directory with a named,
editable agent; composer observes the session (its existing
`agentSession*` / `agentMessage*` wire) and gates it (approval steps).

Status legend: **done** / **active** / **planned**. The gate is
`pnpm verify` (build + server tests + desktop specs). No real LLM in
automated tests — agent calls run against a scripted fake engine.

## Decision log

| # | Date | Decision | Reason |
|---|------|----------|--------|
| D1 | 2026-09-04 | **v2 is a new repo.** The board, event backbone, planning turn, and pipelines survive; the agent-runtime layer does not. v1 is archived for reference (its `processor.rs` semantics, fold, wire catalog, and golden fixture are the porting sources). | The throwaway instinct was about the agent layer, not the product; a fresh repo with the wire inherited makes the rewrite cheap and the deletion real. |
| D2 | 2026-09-04 | **opencode is the agent runtime.** Pipeline steps "launch the runtime with a specific agent loaded" — `opencode run --agent <name> --format json` in the project directory. Agent definitions are markdown files composer ships into each project (`.opencode/agent/composer-{coder,planner}.md`), user-editable, never overwritten. | The runtime is already installed, already wired to the llama.cpp endpoint, and has named agents, skills, MCP tools, session continuity, and permissions out of the box. pi-mono stays reachable behind the engine boundary (the M1 host is recoverable from v1's git). |
| D3 | 2026-09-04 | **TypeScript server** (Node 22+, ESM, hono), **embedded SurrealDB** (`@surrealdb/node`, RocksDB) for the event log, **single process, many projects**, and the **existing Angular desktop reused** over the same wire. | One language across server and desktop; the opencode integration is spawn/parse; the desktop (and its 131 specs) survive by inheriting the wire contract verbatim. |
| D4 | 2026-09-04 | **The wire contract is inherited, trimmed.** Same action envelope, same event names/shapes for the kept domains, same SSE snapshot-then-live, same typed rejections, golden fixture at `wire-golden/events.json` asserted on both sides. Dropped: workflow recording (v1 M2 — not on the keep list), the domain-failure lane-routing events (`validationFailed`, `reviewFinding`, `securityFinding`, `implementCompleted`, `specAmbiguous` — v2's runner drives lanes directly), the dormant `agentSession` commands (agent sessions are created by pipeline runs). 28 events. | The wire is what makes the server rewrite cheap: the desktop changes are three touch points (single-server attach, "+" → `requestProjectCreate`, trimmed types). |
| D5 | 2026-09-04 | **No durable runs.** A pipeline run is an in-process sequential executor; run state lives in the event log + fold. A failed step fails the run (recorded on the card's `retries`); the user re-runs — that is "retry the coder", human-triggered. A restart ends non-terminal runs `cancelled`. Failure handoffs (v1 M3.2's capped retry-the-coder) do not exist; if the pattern earns it back, it lands as data on the pipeline, not runtime machinery. | v1's registry / gate-wake / adoption / healing machinery was several subtle concurrency patterns for "run these steps in order". For a single-user local tool, re-run is an acceptable recovery story. |
| D6 | 2026-09-04 | **The event log is the only store-side truth.** Project ids derive from `event_log` itself (`store.projectIds()`); no registry table beside it. Replay skips ephemeral events (`agentMessageDelta`). | Dual-write (log + registry) bit the first S0 demo: the registry was never populated, rehydrate replayed nothing. Deleted on principle. |
| D7 | 2026-09-04 | **Deployment: standalone server, attach-only desktops.** The server is a plain Node process (`COMPOSER_HTTP_ADDR`); the desktop's gateway probes `COMPOSER_SERVER_URL`, optionally spawns via `COMPOSER_SERVER_CMD` (e.g. `wsl -e bash -c "..."` on a Windows laptop with the server inside WSL), else spawns the workspace build, else is attach-only. Permissive CORS stays (the renderer connects directly). | The company-laptop flow: server inside WSL, Windows desktop attaching over localhost forwarding. |
| D8 | 2026-09-04 | **Composer's domain tools reach the agent over MCP.** `edit_document` / `create_tickets` (planner) are exposed by a composer MCP server (stdio) that issues the same validated commands — commits stay validated regardless of model behavior. | Engine-agnostic (MCP is the generic tool protocol), and prompt discipline moves into the agent definition files instead of runtime code. |

## S0 — Skeleton + wire + desktop  ·  done (2026-09-05)

Scope (landed):

- **Server**: Node/TS + hono; embedded SurrealDB event log (`event_log`,
  seq-ordered, ephemeral-skipped replay); the single write path
  (append → fold → fan-out under one write lock); SSE
  snapshot-then-live with the subscribe-before-snapshot rule; `POST
  /action` (envelope → command mapping, typed rejections, 400 for
  malformed); `GET /health`; permissive CORS.
- **Wire** (`server/src/wire/`): the event catalog (28), commands +
  rejections, domain models, lane semantics — ported and trimmed; golden
  fixture regenerated and asserted on both sides (server `wire.test` +
  desktop `wire-golden.spec`).
- **Fold** (`server/src/fold.ts`): per-project keyed, idempotent; S0 folds
  the project domain; snapshot rebuilds state as synthetic events.
- **Desktop**: moved in as a workspace package; single-server
  `EventsClient` (gateway discover → one link, reconnect with backoff);
  `+` publishes `requestProjectCreate` (directory optional); electron
  preload/main trimmed to `pickDirectory` + `discover`.
- **Verified end to end**: two boots, two projects, snapshot replay
  without re-seed ("replayed 4 events, 2 projects").

Exit criteria (met): `pnpm verify` green (server 17, desktop 131); the
desktop builds against the trimmed wire; the boot contract e2e covers
health, malformed-action 400, snapshot + live SSE, restart replay.

## S1 — Domain core  ·  done (2026-09-05)

Cards, lanes, sub-state, blockers, automation — the board's engine,
ported from v1's processor semantics (same validation order, same
rejection messages, same emitted event lists).

- Commands: `requestCardCreate` / `requestCardsCreate` (blockedBy must
  reference existing cards — validated against the pre-command state, so
  in-batch cross-references reject; in-batch keys are the planner-ticket
  path, S2. ids allocate `T-N` per project; initial sub-state per type),
  `requestCardMove` (lane-valid for the type, blockers unless `override`,
  same-lane no-op, automation honored for agent moves — human drags never
  blocked), `requestCardTypeChange` (resets sub-state; invalid lane falls
  back to new), `requestCardArchive`, `requestSubStateUpdate`,
  `requestAutomationToggle`.
- Fold: card moves (New unassigns; the move's comment records as
  `rejectionComment` whenever present), type changes, sub-state,
  dependency state (derived — the fold ignores
  `dependencyStateChanged`, clients compute blocked-ness), automation
  (absent lane = on).
- Action mapping: `create`/`update`/`delete` on `card`, `update` on
  `automation` — the desktop's `actionForCommand` routes verified against
  it.
- Tests: v1's processor behavioral suite re-expressed (create/move/
  blockers/type-change/automation) + fold/snapshot round-trips + an
  http e2e driving the whole card surface through `POST /action`.

Exit criteria (met): the desktop board is fully interactive against v2
(drag, block, archive — the desktop has no card-create UI, so create is
covered at the action surface); the processor suite is green; the wire
is untouched (golden stays). `pnpm verify`: server 31, desktop 131.

Notes for later slices (researched while porting):

- v1's processor collects events then publishes after validation; v2
  publishes each event as it goes. For bulk card create this is a
  deliberate fix: ids allocate per publish, so one batch gets `T-1`,
  `T-2`, … (v1's allocate-then-publish would duplicate `T-1` across a
  batch). Validation still runs over the whole batch before the first
  publish, so a bad batch emits nothing.
- Archiving a blocker emits no `dependencyStateChanged` (v1 semantics:
  missing blockers don't block, and the fold derives blocked-ness
  client-side). Don't "fix" this asymmetry later.
- Rejection messages interpolate C# enum names (`Lane Security is not
  valid for Design cards`) — `stageCsName` / `cardTypeCsName` in
  `wire/models.ts` exist for exactly this.
- The wire-enum parse rule (unknown string → first variant: `new` /
  `coding` / `pending`) lives in the action mapper (`http.ts`); the
  desktop mirrors it in `wire.ts`.

## S2 — Planning turn  ·  done (2026-09-05)

The planner on opencode: chat → plan document → tickets.

- Domain: planning sessions (`requestPlanningSessionCreate` allocates
  `S-N` per project, `requestUserMessage` — drafting-only, sequential
  transcript indexes), the document (`requestPlanDocumentUpdate` —
  wholesale replace, drafting-only), ticket emission
  (`requestTicketsCreate` — title/key/key-uniqueness/self-block/dep
  validation; ids allocate a `T-N` block; in-batch keys remap onto fresh
  card ids; `cardsCommitted` → per-blocked `dependencyStateChanged` →
  `planningSessionCompleted`).
- Fold: sessions, messages (replace-by-index, sorted), document,
  completion, `cardsCommitted`. Snapshot replays sessions after
  automation, before cards (v1 order) — the creation event carries the
  current record, messages re-fold idempotently.
- Engine boundary (`server/src/engine/`): `AgentEngine` (`run(spec,
  onEvent) → outcome`) + `FakeEngine` (scripted turns that call the real
  planner-tools against the processor) + `OpenCodeEngine` (spawn/parse).
  Engine-session continuity is in-process state (D5: a restart starts a
  fresh runtime session; document + transcript are durable, so context
  survives).
- The `composer-planner` agent definition ships into the project on turn
  start (`.opencode/agent/composer-planner.md`; user-editable, written
  once) with v1's prompt discipline: commit the document every turn,
  reply short, tickets only on explicit approval.
- Composer's MCP server (`server/src/mcp.ts`, stdio, hand-rolled
  newline-delimited JSON-RPC — no SDK): `edit_document` /
  `create_tickets` (accepts v1's `type` alias, defaults cardType) →
  `POST /mcp/command` → the processor. The route is whitelisted to the
  two planning commands — not a second generic action surface.
- Wire: `agentMessageDelta/Complete` are real (deltas ephemeral);
  `agentSessionStarted/Ended` stay S3 (they are card-bound; planning
  turns are session-bound).

Exit criteria (met): the FakeEngine e2e covers user message → document
edit → `planDocumentUpdated` → approval turn → `create_tickets` → cards
land → session `done`, plus mid-turn queueing, failure publishing, and
continuity; the desktop Plan view folds unchanged (131 specs green);
`pnpm verify`: server 54, desktop 131. The real-opencode smoke ran
2026-09-05 (see below).

Manual smoke (real opencode 1.18.25 + the llama.cpp endpoint): project
pointing at a scratch dir → `create:planningSession` → `create:chatMessage`
"plan the work to add a sum(a,b) function…" — ~30s later the planner had
committed `<plan><goal>…</goal><tasks>…</tasks></plan>` through
`composer_edit_document`; "Approved. Emit the tickets." →
`composer_create_tickets` → T-1, T-2 (t2 blockedBy t1 → `T-1` remapped),
session `done`, transcript user/agent/user/agent.

Research notes for later slices:

- **`opencode run --format json` schema** (probed 2026-09-05, opencode
  1.18.25): stdout is one JSON object per line — vendor banner lines
  (the llama.cpp plugin's) precede it, so non-JSON lines must be
  skipped. Events: `{type, timestamp, sessionID, part}` with type
  `step_start | text | tool_use | step_finish`; `text` parts may arrive
  repeatedly with growing text (streamed — diff per part id for
  deltas); `tool_use` parts carry the tool name, `callID`, and
  `state.input/output` post-hoc; `step_finish.reason` is `stop` or
  `tool-calls`. Exit code 0 = ok; on nonzero, stderr (or the last
  stdout line, which may be a `{"type":"error"}` JSON) carries the
  cause.
- **opencode trusts `$PWD` over the real cwd** for workspace discovery.
  A spawn with `cwd: <project>` but an inherited stale `PWD` points
  opencode at the wrong project (symptom: `UnknownError … Check server
  logs`, exit 1 in ~5s). The engine pins `PWD`/`OLDPWD` to the spawn
  directory. S3's coder spawn must do the same.
- **MCP without an SDK**: newline-delimited JSON-RPC over stdio works —
  initialize → `notifications/initialized` → `tools/list` →
  `tools/call` (opencode sends `_meta.progressToken`; a trailing
  `notifications/cancelled` is normal). Tool names on the wire are
  `<server>_<tool>` (`composer_edit_document`). Register the server per
  spawn via `OPENCODE_CONFIG_CONTENT` (inline JSON config) — nothing in
  the user's project config is touched. Session context rides the
  environment (`COMPOSER_SERVER_URL/PROJECT_ID/SESSION_ID`), which the
  MCP child inherits from opencode.
- **opencode silently falls back to its default agent** when the named
  agent file is missing (the first smoke chatted happily without the
  shipped definition). S3's runner should verify the agent file exists
  before spawning, or the turn runs without composer's tools.
- The desktop's send-lock clears on `agentMessageComplete`; a failed
  turn publishes the failure as an agent message so the UI unblocks
  (v1 logged only).
- Kill switches: `COMPOSER_PLANNER_ENABLED=0` (no turns),
  `COMPOSER_FAKE_ENGINE=1` (scripted engine in dev boots);
  `COMPOSER_MCP_SCRIPT` overrides the MCP child path for tsx/dev runs.

## S3 — Pipelines  ·  done (2026-09-05)

Authoring + the sequential runner + the coder.

- Authoring: `requestPipelineSave` / `requestPipelineDelete` (fresh ids
  `PL-N`, known ids upsert; step validation: unique ids, per-kind
  required fields — v1's messages; 64-step cap); the default coding
  pipeline (`PL-1`, `coder → build → test → approval`) seeds each
  project **inside `requestProjectCreate`** — deterministic log order
  (an async seed raced the snapshot in tests); deletion tombstones keep
  it dead; `requestPipelineRun` (directory, card, already-running, and
  agent-kind checks) / `requestPipelineStop` / `requestPipelineGateRespond`.
- Runner (`server/src/runner.ts`): one in-process task per run (D5). Steps
  in order — `command` (`/bin/sh -c` in the project directory, output
  captured, 10-min cap), `agent` (the engine; `agentKind` names the
  shipped agent, an `A-N` agent session wraps the attempt), `human` (the
  run parks `waiting`; the gate command resolves it). Lane + sub-state
  are the projection (v1 on_step_started/finished): agent → implement
  lane, command → validation, human → approval, override moves; failures
  land on the card's `retries` (fold) and fail the run; a rejected gate
  completes the run and routes the card back to its implement lane with
  the comment; approval routes to Done when the gate is the last step;
  stop kills the current child and the task exits silently (the cancelled
  `pipelineRunEnded` is already on the stream); boot cancels interrupted
  runs.
- The `composer-coder` agent definition ships beside the planner's:
  implement the card through opencode's own file/bash tools, keep it
  minimal, make the checks pass.
- Action mapping: `create`/`delete` on `pipeline`, `start`/`stop` on
  `pipeline`, `update` on `pipelineGate`.

Exit criteria (met): the FakeEngine runner e2e covers walk hands-off →
gate → approve/reject, stop-kill, boot-cancel, failure retries, and the
snapshot round-trip (`pnpm verify`: server 65, desktop 131). The real
smoke ran 2026-09-05: the sum.js repo (sum.js missing, test + scripts
present) fixed end to end through real opencode — the coder implemented
(~25s), build + `node --test` passed, the run parked at the approval
gate, `update:pipelineGate approved` → card `done`, `sum(2,3) = 5`,
`retries: {}`, sub-states implement/runValidation/humanReview all `ok`;
lane + sub-state progress visible at every step via the event stream.

Research notes for later slices:

- **Gate ordering**: the gate's resolver is armed *before* the
  `pipelineStepStarted(human)` publish. The fold flips the run to
  `waiting` mid-publish; a gate answer arriving from then on must find
  the resolver in place (the flake that motivated this: ~1 in 6 runs
  parked forever). This replaces v1's GATE_WAKE_ATTEMPTS retry loop.
- The snapshot replays an active run as `pipelineRunStarted` + only the
  **current** `pipelineStepStarted` (the fold lands on the same run
  status); history rides the log.
- Fire-and-forget publishes (the runner's/planner's stream events) must
  carry `.catch` — a publish in flight when a test closes the store
  otherwise surfaces as an unhandled rejection.
- A killed child (stop) resolves the command step with
  `the run was stopped` so the awaiting drive unwinds; the drive then
  checks `task.stopped` and exits without publishing.
- The engine gained `spec.signal` (AbortSignal): stop aborts the
  controller, opencode's process gets SIGKILL. The planner can adopt
  this later if turns ever need cancelling.
- `Set.add` returns the set — v1's `!seen.insert(..)` duplicate-check
  idiom does not transliterate (caught by the validation suite).

## S4 — Desktop completion  ·  done (2026-09-05)

The visible-product slice: the pipeline step editor, run progress on the
board, the approval-gate affordance, and the coding tab.

- Pipeline models (`core/models/pipeline.models.ts`): `Pipeline`,
  `PipelineStep` (with the per-kind `missingField()` pre-validation the
  server re-checks), `RunProgress`. Wire: `requestPipelineSave/Delete`
  join the publish DTOs and route to `create`/`delete:pipeline`.
- Pipeline service (`pipelines/pipeline.service.ts`): folds
  `pipelineSaved/Deleted`, the run lifecycle (`pipelineRunStarted` →
  `StepStarted` → `RunEnded`; a human step parks `waiting`),
  `agentSessionStarted/Ended` (the coding tab's list). Commands:
  save/remove/run/stop/gateRespond; a rejection resolves `false`.
- Board: cards show a run chip (step kind, pulsing `waiting` at the
  gate); the card panel shows the run (pipeline, current step, stop),
  the gate affordance (approve/reject with an optional comment), and the
  start affordance (pipeline picker + run) when no run is active.
- Pipeline editor (`/pipelines`, rail entry replaces the dormant
  `library` stub): from-scratch authoring per the ownership rule — name +
  ordered step builder (kind, per-kind fields, reorder, remove),
  client-side validation, delete; edits upsert by id.
- Coding tab (`/coding`, the `agent` stub lands): cards with agent
  sessions, newest first, status + error; the `opencode attach` hint —
  the transcript lives in the runtime, this view is the pointer.

Exit criteria (met): author → run → watch → approve without leaving the
app — the editor spec authors and publishes `requestPipelineSave`, the
panel specs drive run/stop and the gate answer, and the wire-level smoke
ran the exact action sequence the UI publishes against a live server:
authored pipeline (fresh id) → `start:pipeline` → parked at the gate →
`update:pipelineGate approved` → card `done` (state survives restart).
`pnpm verify`: server 65, desktop 144 (13 new specs).

Research notes:

- The desktop specs drive folds by emitting wire events through the
  `FakeEventsClient`; **services subscribe at construction**, so emit
  order matters — construct/inject the service under test *before*
  emitting events, and re-render (a fresh `render()` is fine) after
  emits when a template `@if` branch switches.
- `PipelineService` keys on the shell's active tab; seeding a project
  (a `projectCreated` emit) auto-activates the first tab.
- Boot wiring: the engine is shared by planner + runner; the runner is
  **not** gated by `COMPOSER_PLANNER_ENABLED` (only the planner is) — a
  run's agent step needs the runner alive even when planning is off.

## S5 — UI slices: card create, assignment, settings, transcript integrity  ·  done (2026-09-05)

Four gaps left by the S0–S4 smoke test (see `desktop/docs/ui-issues.md`), plus
the desktop fix pass it drove (silent rejections surfaced, honest status
strip/top bar, the 12px floor).

- **Card creation UI**: the board's `+ new card` form (title, description,
  type) publishes `requestCardCreate` — the desktop's first authoring path
  outside the planner; the card lands via its echo and opens in the panel.
- **Assignment on the wire**: `requestCardAssign` (29th event,
  `cardAssigned`; assignee absent = unassigned) — processor, fold, action
  mapping (`update:card` + `assignee`), golden regenerated, desktop folds
  and publishes it; "assign to me"/"unassign" now survive reloads.
- **Transcript integrity**: the planning orchestrator reserves one
  transcript index per engine messageId (deltas and their completion always
  pair; successive messages of a turn can't collide when the fold lags);
  the FakeEngine pairs its final message with the last delta's id. The
  desktop's fold clears the live bubble on any completion for the active
  session and dedupes the transcript projection.
- **Settings + model wiring**: a global `settings` table (config, not
  domain history — outside the event log) with `GET/PUT /settings`; the
  desktop settings view edits the model override, the top bar/status strip
  show the live value, and the runner/planner pass it into each spawn's
  `OPENCODE_CONFIG_CONTENT` (`model`).
- **Plan document as markdown**: the document pane renders markdown (HTML
  escaped first, so the XML skeleton displays literally); `marked` added.

Exit criteria (met): `pnpm verify` (server 69, desktop 156 — 4 new spec
files); the live smoke created a card from the UI, assigned it (server
state carries the assignee across restart), saved a model override (badge
followed, spawn spec carries it), and a fresh boot restored the transcript
without duplicates.

## S6 — The live run view  ·  done (2026-09-05)

A full page for one card's pipeline run (`#/run/:cardId`): the agent output
pane (streamed messages interleaved with tool calls and their results), the
context column (usage counts, the card's sub-state checklist, changed
files), and the command output pane — the three-pane mock (2026-09-05)
reduced to what the wire can honestly carry. Entry points: a board card's
run chip and the card panel's run box; a finished run stays readable
(durable history + the outcome banner).

- **Engine**: `AgentTurnEvent` gains `toolCall`/`toolResult`;
  `OpenCodeEngine` announces a `tool_use` part once (args from
  `state.input`) and settles it once on `completed`/`error` (output
  post-hoc, `metadata.error` → `isError`).
- **Wire**: `agentToolCall`/`agentToolResult` are now actually published
  (the runner forwards them; the fold + snapshot support existed); new
  ephemeral `commandOutput` (30th event, golden regenerated) — one line per
  publish, capped at 400 lines per step, live-only like agent deltas.
- **Desktop**: `PipelineService` folds the run transcript (per agent
  session: deltas merge into a streaming bubble, completes finalize, tool
  results patch their call) and the per-card command-output buffer
  (cleared on a fresh run); `RunProgress` carries `sessionId` +
  `stepStartedAt` (the elapsed clock); a finished run's outcome keeps its
  session id so the transcript outlives the run, and the page falls back to
  the card's newest session after a restart. `plan.service` now ignores
  message events for sessions it doesn't own — a coder's stream can never
  clobber the plan session (a latent mis-fold the run view would have
  exposed).
- **Routing**: `provideRouter` gained `withComponentInputBinding()` (route
  params → component inputs).

Exit criteria (met): `pnpm verify` (server 69, desktop 161); the live
smoke ran the real coder on a card — messages and tool calls streamed into
the run page with the elapsed clock ticking, an echo pipeline's
`commandOutput` frames landed on the SSE stream, a saved model override
reached opencode and was rejected by it (the settings→spawn path works end
to end), stop killed the run mid-flight, and the page rebuilt the full
transcript (16 messages · 33 tool calls) from the snapshot after a reload.

## S7 — Reliability: single-writer, stranded turns, gateway hygiene  ·  done (2026-09-05)

The three incident fixes S2's smoke flagged (t9/t10/t11), plus the
planning-session lifecycle affordance they left exposed.

- **t9, single-writer store**: a PID lockfile (`server.lock`) in the data
  dir — a second boot against a live server's dir is refused with a plain
  error (`another composer server (pid …) is already using …`); a stale
  lock (dead PID — a crash) is reaped; `close()` releases. Two-boot test.
- **t10, stranded turns**: on boot, any drafting session whose transcript
  ends with a user message lost its turn to the restart — one failure
  agent message is published per stranded session, so the transcript is
  coherent and the desktop's send-lock clears ("resumed N stranded
  turns" in the boot line).
- **t11, gateway churn**: the desktop's registry now tracks its spawn —
  a wedged previous child is killed before the next spawn, a spawn attempt
  is never concurrent with itself, and a failed spawn backs off 30s (no
  more per-retry process piles).
- **New planning session**: a completed session's transcript is closed
  (`requestUserMessage` rejects), and there was no way to plan the next
  milestone. The plan header gains `+ new session` and a finished chat
  shows `start a new session`; the service marks the deliberate create so
  the fresh echo replaces the populated session (the stale-replay
  clobber-guard stays).

Exit criteria (met): `pnpm verify` (server 73, desktop 163); the two-boot
refusal, stale-lock reaping, and stranded-turn publishing are unit-tested
against the real store; the live stack restarted cleanly through the
gateway with the lock held by the spawned server.

## S8 — Planning ergonomics  ·  done (2026-09-05)

- **Per-agent models**: settings gain a per-agent map (`models`, keyed by
  the bare agent kind) beside the default model; `resolveModel` picks
  override → default, and the planner/coder spawns use it. The settings
  view lists planner + coder rows, custom kinds are addable, and the
  pipeline editor's agent-kind field offers the known kinds as a
  type-to-filter list (`datalist`).
- **Multi-line plan composer**: the single-line input becomes an
  auto-growing textarea — Enter sends, Shift+Enter folds a newline,
  height resets after send.

Exit criteria (met): `pnpm verify` (server 76, desktop 167); the live
smoke saved `models.planner` over HTTP (the resolution override is
unit-tested at the orchestrator), the editor's picker listed the known
kinds, and the composer held a newline through Shift+Enter.

## S9 — Global shell + project lifecycle  ·  done (2026-09-06)

- **Product plan**: `docs/product-plan.md` records the dashboard-first roadmap,
  global assistant boundary, and the project model: one project may host one
  workspace of each workflow type; coding is the only implemented workflow.
- **Global shell**: Dashboard is the default route. Coding views now live below
  `/projects/:projectId/coding/...`; the route selects project context, the
  project workspace owns its workflow tab + compact rail, and opening a project
  restores its last-used coding view.
- **Dashboard foundation**: all projects are visible without opening tabs, with
  create/open actions and explicit archive access. The health/Git read model is
  intentionally left to the next slice.
- **Durable lifecycle**: `requestProjectArchive/Restore` and
  `projectArchived/Restored` add a non-destructive `archivedAt` projection.
  Archived projects keep their directory and all cards/plans/pipelines/history,
  reject ordinary mutations, and are restorable from the Dashboard. Archive is
  rejected while any pipeline is running or waiting.
- **Wire**: 32 events; snapshots carry the folded project lifecycle state in
  `projectCreated`, while live archive/restore events move projects between the
  active and archived Dashboard views.

Exit criteria (met): project routes and last-view restoration were exercised in
the live Electron renderer with no console errors; server tests cover state
retention, mutation blocking, active-run rejection, snapshot equality, and the
HTTP action mapping; desktop tests cover routing, action mapping, folds, and the
Dashboard archive/restore flow.

## S10 — Dashboard health + Git status  ·  done (2026-09-06)

- **Durable run health**: each coding card's latest pipeline run now remains in
  the server projection after it ends (status, pipeline, timestamps, error).
  Starting a rerun replaces the failure with active state; successful completion
  clears it. Snapshot replay recreates terminal lifecycle events at their
  original timestamps, so both server and desktop outcomes survive restart.
- **Dashboard read model**: `GET /dashboard` excludes archived projects and
  returns running runs, waiting approvals, and unresolved failed card runs. The
  renderer shows these as an action-required list with direct links to the run
  view and per-project health chips.
- **Git status**: on-demand, transient probes report clean/dirty, current branch,
  and latest commit subject/age. Probes use `git -C` without a shell, a 3-second
  timeout, bounded output, and four-project concurrency; missing directories and
  non-repositories are explicit states. Refresh happens on server attachment,
  Dashboard focus, successful lifecycle actions, and the manual control.
- **Tests**: Git parsing and health aggregation have an injected runner suite;
  the real HTTP boot covers Dashboard archive exclusion/restoration; runner
  tests cover terminal outcome snapshot equality; desktop service/component
  specs cover loading, failure retention, Git display, and action-required work.

## S11 — UX refinement pass 1: confirmations + safe markdown  ·  done (2026-09-06)

First slice of the product plan's Phase 5 (cross-application UX refinement):

- **In-app confirmations**: `ConfirmService` + `ConfirmDialogComponent` replace
  native `window.confirm` — one themed alert dialog mounted at the app root,
  Escape/backdrop cancel, focus lands on the confirming button, a superseding
  request cancels the abandoned promise. Project archive (already confirmed)
  and pipeline delete (previously unconfirmed) both wait on it.
- **Safe markdown**: the plan document no longer bypasses Angular's sanitizer —
  raw HTML stays escaped to literal text (the planner's XML skeleton renders
  visibly) and the generated markup passes default `innerHTML` sanitization,
  so `javascript:` links cannot survive as executable hrefs.
- **Tests**: the dialog spec covers pending rendering, confirm/cancel/backdrop/
  Escape resolution, and supersede-cancellation; dashboard and pipeline-editor
  specs assert the destructive actions wait on the dialog before publishing;
  the plan-document spec covers the empty state, literal escaping of injected
  tags, and inert link schemes — verified live in the Electron renderer with
  no console errors.
- **Card text containment**: long project names, directories, branch chips,
  commit subjects, and action-item titles ellipsize inside their cards instead
  of spilling across the grid — the card body's rows are width-capped
  (`max-width: 100%`, stretch instead of fit-content) and the health chips
  truncate individually.

## S12 — Command palette  ·  done (2026-09-06)

Second slice of Phase 5 (cross-application UX refinement and command palette):

- **Global palette** (`Ctrl/Cmd+K`): `PaletteService` + `PaletteComponent`
  mount one overlay at the app root — a query input over a ranked result
  list. Arrow keys move the active entry (cyclically), Enter runs it, Escape
  and the backdrop close; the input takes focus on open and a footer hints
  the keys.
- **Commands**: shell destinations (projects dashboard, settings), per-project
  navigation (open, board, plan, pipelines, coding — built from shell state so
  projects appear and disappear without wiring), and actions: new project,
  refresh project health, and archive project (which reuses the S11
  confirmation dialog before publishing).
- **Matching**: case-insensitive ranking — label prefix, then word prefix,
  then keyword hit, then in-order subsequence fallback.
- **Discoverability**: a topbar palette button (search glyph + `Ctrl K` hint,
  hidden on narrow windows) opens the palette for users who have not learned
  the shortcut.
- **Tests**: the service spec covers item composition, ranking tiers, cyclic
  movement, execution closing the palette, and the archive action's
  confirmation gate (accept publishes, reject does not); the component spec
  covers Ctrl+K open/focus, Escape close, typed filtering, Enter execution
  with navigation, arrow-key movement, and backdrop dismissal — verified live
  in the Electron renderer (open, filter "plan", Enter lands on the plan
  view, no console errors).

## S13 — Shared async-state language  ·  done (2026-09-06)

Third Phase 5 slice: one visual voice for empty and failure states, and a
stale-copy sweep.

- **Global state classes** (`styles.scss`): `.state-empty` (centered muted
  pane with an accented `.state-label`, plus an `inline` variant for hints
  inside busy panes) and `.state-error` (left-bordered alert). Seven
  per-component duplicates removed; the run view's full-pane state and the
  dashboard's tight-under-header spacing keep local overrides. Card-panel's
  gate-rejection comment deliberately keeps its own style — it is quoted
  content, not an alert.
- **Migrated views**: plan chat/document empties, run view panes and
  unknown-card state, coding sessions and pipeline editor fallbacks and
  validation/rejection alerts, settings and card-creator errors, dashboard
  error + amber health alert.
- **Stale copy**: the left rail's disabled stubs no longer tease a milestone
  ("lands in M2" → "not available yet"); the component docblock no longer
  cites the retired mvp/design docs.
- **Tests**: unchanged behavior — pipeline-editor validation assertions
  moved to the shared class; verified live (run view's unknown-card state,
  coding tab's inline empty) with no console errors.

## S14 — Board panel space + plan narrow windows  ·  done (2026-09-06)

Continuing Phase 5's space-usage and readability items:

- **Board detail panel**: the card panel now opens beside the board on wide
  windows (clamp 380–560px column, board visible and selectable behind it);
  narrow windows keep the full-area takeover. The panel body wraps (main and
  checklist reflow instead of squeezing), the action footer wraps cleanly at
  one row, and the panel's dead embedded run-pane styles (superseded by the
  full-page run view) are gone.
- **Run outcome visibility**: the card panel's idle state shows the last
  run's outcome as a status chip (completed/failed) with the error text and
  a direct "run view" hop — previously a single faint line, hidden whenever
  no pipelines were authored.
- **Plan narrow windows**: below 1000px the chat/document panes become tabs
  (`matchMedia`-driven) — one full-width pane at a time with a tab switcher
  in the plan header; wide windows keep the side-by-side split.
- **Tests**: board spec asserts the board stays visible beside the open
  panel; card-panel spec covers the outcome row (status, error, run-view
  link); plan spec covers tab rendering, the chat-default, and pane gating.
  Verified live (split panel at 1771px, tab switch at 860px).

## S15 — Coding session history  ·  done (2026-09-06)

The coding tab becomes the project's session history with direct run links:

- **Linked rows**: each agent session row links to its card's run view
  (`routerLink`, keyboard-focusable); sessions without a card render as
  inert articles. A relative age (started) joins the row; failure rows keep
  their error detail.
- **First spec** for the view (S4 deferred it): empty state, newest-first
  ordering with status/failure detail, and the linked-vs-inert row split
  with navigation. Verified live: clicking a session lands on that card's
  run view.

## S16 — Focus management  ·  done (2026-09-06)

The last Phase 5 item: keyboard users are never dropped on `<body>` by a
transient surface.

- **Restoration on close**: the confirm dialog returns focus to its
  trigger on settle (accept, cancel, backdrop, Escape); the palette returns
  focus to its trigger (topbar button) on close; the card panel focuses its
  back button on open (and when switching to a related card) and returns
  focus to the opener card on close.
- **Board cards were already keyboard-activatable** (tabindex, role,
  Enter/Space via click) — this slice closes the focus-handoff gaps around
  them.
- **Tests**: focus restoration asserted in the confirm, palette, and board
  specs; verified live (dashboard archive → dialog → Escape → focus back on
  the archive button).

## S17 — Board restructure: work-state columns  ·  done (2026-09-06)

The board no longer rows by card type — design/docs swimlanes read as states
they are not, and the board was meant to picture work moving through agents:

- **Flat columns, no rows**: `backlog | coder | tester | reviewer | security
  | approval | done` — the stage machine projected for viewing, each column
  labeled by the worker who owns that state. The type-named implement stages
  (coding/design/docs) collapse into the coder column; a drop lands on the
  card's own implement stage, so the underlying Stage model, routing,
  sub-state, and wire are unchanged.
- **Type is a filter**: the type selector (all/coding/design/docs) filters
  the one board instead of switching to per-type column layouts; the per-type
  board component is gone.
- **Automation toggles** sit on the agent-worked columns (coder, tester,
  reviewer, security); the coder column's toggle reflects and drives all
  three type-implement stages.
- **Tests**: the SwimlaneRow suite is replaced by a Column suite (order,
  implement collapse, per-type drop stage, agent-owned flags) and the board
  spec now covers the column set, filter behavior, and card placement.

## S18 — Global assistant foundation  ·  done (2026-09-06)

Phase 6's first slice: the assistant becomes a global domain (its own event
family, global log slice, `/assistant` surface). Threads are persistent and
named, carry an explicitly selected project scope, and turn through the
shared engine — read-only for now (`mcpTools: 'none'`; the scoped read
tools are S19, stop/retry/branching are Phase 7).

- **Global events on the wire** (33–39): `assistantThreadCreated` (the
  record rides the event), `assistantThreadArchived/Restored`,
  `assistantThreadScopeChanged` (wholesale replace),
  `assistantUserMessage`, `assistantMessageDelta` (ephemeral, 33rd
  EPHEMERAL member), `assistantMessageComplete`. Global frames carry no
  `projectId`; golden regenerated (e-33…e-39 unscoped) and both golden
  tests amended (project events stay `P-1`, global ones stay undefined).
- **Store/rehydrate**: `replayGlobal()` (`WHERE projectId IS NULL` — the
  embedded engine binds JS `null` as SQL NULL, `IS NONE` matches nothing);
  `bus.rehydrate()` replays the global slice before the projects'.
- **Fold**: `State.assistantThreads`; user message → status `running`, the
  reply's completion → `idle`. Transcript-index races heal in the fold: a
  message never steals a slot the opposite role holds — the latecomer
  lands past every folded message (the processor allocates indexes
  outside the write lock, so a queued reply and a queued user message can
  collide; both desktop and server fold mirror the heal).
- **Processor**: the first commands with no project scope — thread create
  (`TH-N`, blank name → `Thread N`), archive/restore (idempotent), scope
  (unknown/archived projects rejected, duplicates collapse, archived
  threads reject), message (archived threads closed, empty text
  rejected); new `unknownThread` rejection.
- **Engine**: `AgentTurnSpec.projectId` is optional (global turns) and
  `mcpTools: 'planner' | 'none'` gates the MCP registration (`none` = no
  composer tools at all — the assistant must not reach the planner's
  write tools).
- **Orchestrator** (`server/src/assistant.ts`): the planning turn loop
  retargeted at threads — in-flight counting, per-engine-message index
  reservation, engine-session continuity, failure published as an agent
  message, `resumeStrandedThreads` at boot. Kill switch
  `COMPOSER_ASSISTANT_ENABLED=0`; the shipped agent name is
  `composer-assistant` (its definition ships with the read tools).
- **Desktop**: `/assistant` (topbar link live, palette entry), an
  `AssistantService` root-injected in `app.ts` (global frames pass every
  SSE filter), thread sidebar with archive/restore, transcript with live
  bubble, scope picker beside the conversation (chips + checkbox menu
  over the active projects, wholesale apply), archive behind the
  confirm dialog.

Exit criteria (met): `pnpm verify` (server 102, desktop 208 — 14 new
specs); the store restart test exercises global replay across real
process boundaries (child boot 1 → first-open boot 2, ephemeral delta
skipped); the live smoke drove create → scope → message → turn over HTTP
against the scripted engine (the no-turn failure path publishes a real
failure message; snapshot rebuilds the transcript; restart replays the
global slice with `0 projects`).

Research notes for later slices:

- **In-process store reopen deadlocks** on the RocksDB file lock (the
  engine holds it until process exit — `store.close()` releases the PID
  lockfile but not RocksDB). Restart tests must cross a real process
  boundary (child boot 1, parent first-opens as boot 2); `afterEach`
  closes best-effort.
- SurrealQL: `projectId IS NULL` matches the JS-bound `null`; `IS NONE`
  does not (probed on the embedded engine).
- The engine's MCP child env still carries `COMPOSER_SESSION_ID` (the
  thread id for assistant turns); S19's read tools re-evaluate the env
  contract when the tool surface grows.
- The assistant's real-opencode story is deliberately deferred: without a
  shipped agent file opencode silently falls back to its default agent,
  so S19 must ship `composer-assistant.md` (a home outside the project
  directories — the threads are global) before a real smoke.

## S19 — Assistant read tools  ·  done (2026-09-06)

Phase 6's second slice: the assistant's server-mediated read-only tool
surface (the plan's read capabilities, scope-validated end to end). The
assistant still cannot edit files, run commands, or touch pipelines —
there is no write path anywhere in the chain.

- **Tools** (`server/src/assistant-tools.ts`, 9): `composer_overview`
  (per-project cards/runs/sessions; omitted projectId = the portfolio
  summary across the scope), `composer_card`, `composer_plan`, `list_files`
  / `read_file`, `git_status` / `git_log` / `git_diff`, `web_fetch`. Every
  call re-validates the thread's scope from the live fold — a scope change
  applies to in-flight conversations.
- **Safety rails**: file tools enforce real-path containment (symlink
  escapes reject — the realpath must stay inside the project root), binary
  detection (NUL/head sniff), 64 KiB read cap, 500-entry listing cap; git
  runs `git -C` without a shell (3 s timeout, capped output, 20-commit log
  cap); `web_fetch` is https-only, resolves every hop's host and rejects
  private/loopback/link-local/carrier-NAT ranges, follows ≤3 redirects
  (re-validated, never leaves https), 10 s timeout, text/json
  content-types only, 256 KiB body cap with a streaming reader. Git and
  fetch are injected adapters (tests never touch a repository or the
  network).
- **MCP child** (`server/src/assistant-mcp.js`): the read tools over the
  shared stdio JSON-RPC framing (extracted to `mcp-stdio.ts`; the
  planner's server rides it too). The child carries only
  `COMPOSER_SERVER_URL` + `COMPOSER_THREAD_ID` — every call POSTs
  `/mcp/read`, which whitelists the nine tool names and executes against
  the fold; the child holds no authority of its own.
- **Engine**: `mcpTools` gains `'assistant'` — opencode spawns get
  `COMPOSER_THREAD_ID` and register the assistant MCP script inline.
- **Workspace**: the `composer-assistant.md` definition ships into
  `<dataDir>/assistant/.opencode/agent/` (threads are global, so the
  definition lives outside every project; that directory is also the
  real-engine cwd). The prompt carries the thread's scope plus a
  transcript tail — context survives a restart's fresh engine session.
- **Boot**: the assistant orchestrator wires the workspace +
  `dist/assistant-mcp.js` (`COMPOSER_ASSISTANT_MCP_SCRIPT` overrides).

Exit criteria (met): `pnpm verify` (server 126, desktop 208 — the wire is
untouched, no new events); the tools suite covers scope, state reads,
containment/symlink/binary/size, bounded git args, and every web guard
with injected adapters; the `/mcp/read` e2e drives a real boot (overview
content, out-of-scope rejection, route whitelist); a manual stdio smoke
ran the MCP child against a live server — initialize → tools/list (9) →
`read_file` returned real file content, `../../../etc/passwd` was
refused.

Research notes for later slices:

- Tool calls do not stream into the assistant transcript yet (the run
  view's toolCall/toolResult events are card-session territory); Phase 7's
  proposal panel decides what the conversation shows.
- The web tool resolves the host per hop but undici re-resolves at
  connect — a documented local-first simplification; the private-range
  guard still stops the obvious SSRF shapes.
- `assistantMcpScriptPath` mirrors `mcpScriptPath`'s override pattern; if
  a third MCP surface ever appears, promote the pair into one helper.

## S20 — Conversation controls: stop, retry, statuses, markdown  ·  done (2026-09-06)

Phase 7's first slice — the assistant transcript becomes a controlled
conversation. Edit-and-resend with branch lineage is deliberately deferred
to S21 (it needs stable message ids); everything else in the phase's
control list lands here.

- **Wire** (40–43, all global): `assistantThreadStopped` (the canonical
  stop record), `assistantRetryRequested` (the canonical retry record —
  the orchestrator re-runs the last user message), `assistantThreadStatusChanged`
  (explicit status marks; only `failed` is published today),
  `assistantThreadRenamed`. `AssistantThreadStatus` gains `failed` |
  `stopped`; commands gain `requestAssistantThreadStop` /
  `requestAssistantRetry` / `requestAssistantThreadRename` (actions
  `stop:`/`retry:`/`update`+name; the envelope's `type` union gains
  `retry`). Golden regenerated (e-40…e-43, unscoped).
- **Fold**: stop → `stopped`; retry → `running`; statusChanged → the
  carried status; renamed → the name. The complete case closes a turn
  (`running` → `idle`) but never un-marks a `stopped`/`failed` thread —
  the stop's partial completion and the failure message both land through
  it. The snapshot re-marks a terminal status after its message replays
  (the message replays derive running/idle and would clobber it).
- **Processor**: stop requires a `running` thread (else `invalidCommand`);
  retry requires a non-archived thread, no in-flight turn, and a last user
  message; rename validates non-empty and no-ops on the same name.
- **Orchestrator**: per-thread abort controllers — the stop event aborts
  the engine (opencode's process dies with it). The streaming message is
  accumulated, so a stop lands the partial reply as durable content
  (`stopped.` when nothing had streamed) instead of a failure; failed
  turns publish the failure message then `assistantThreadStatusChanged
  failed`. Retry runs the same turn loop against the last user text
  (engine-session continuity carries context; the reply appends —
  nothing is rewritten).
- **Desktop**: the header gains stop (while running) / retry (when a user
  message exists and the thread is idle) and an inline rename (click the
  title, Enter commits, blur cancels); the status chip shows running /
  failed / stopped. Agent replies render as safe markdown — the S11 rule
  extracted to `core/markdown.ts` (escape-then-parse, default
  sanitization), shared with the plan document.

Exit criteria (met): `pnpm verify` (server 132, desktop 214); the
orchestrator stop e2e aborts a parked turn and lands the partial reply
with the thread staying `stopped`; retry appends the alternate response
with the transcript intact; the fold/snapshot rules are covered
(terminal-status re-marking included); the desktop specs drive stop,
retry, rename, and assert injected `<script>` stays literal in a styled
bubble.

Research notes for later slices:

- The stop's partial-completion `messageId` falls back to
  `stopped:<threadId>` when nothing had streamed (no reservation exists);
  the fold's collision heal covers the rest.
- Retry while the turn loop is between iterations is invisible to the
  processor (in-flight is orchestrator state) — the orchestrator ignores
  a retry when `inFlight` holds the thread, so no double turn runs.
- S21 (branching) will want stable message ids on the wire (the index
  heal renumbers, so indexes are not fully stable) and `parentId`
  lineage; both are additive ChatMessage fields.

## S21 — Branch lineage: edit-and-resend  ·  done (2026-09-06)

Phase 7's last slice: the transcript becomes a tree, and editing an
earlier user message opens an immutable alternate branch instead of
rewriting history.

- **Wire**: `ChatMessage` gains optional `id` / `parentId` (assistant
  threads only; planning messages stay id-less and linear); new event
  `assistantResent` (44th, global, golden regenerated), new command
  `requestAssistantResend` (action `create:assistantResend`).
- **Processor**: the resend validates thread/archive/text, finds the
  original by message id, and publishes the edited text as a sibling —
  same `parentId`, fresh id and index (the running check comes after the
  lookup so an unknown id reports `unknownSession`). The ordinary
  `assistantUserMessage` now carries a stable id too.
- **Orchestrator**: every turn records the user message it answers, so
  replies publish `parentId` (a resent edit is the newest user message,
  hence the reply opens the new branch); the stop/failure/stranded paths
  attach to the same parent. `assistantResent` triggers turns exactly
  like a user message.
- **Fold**: `assistantResent` folds like a user message; indexes stay the
  append-order log, the tree is client-derived.
- **Desktop**: `AssistantMessage` carries id/parentId; the visible
  transcript is the active path through the tree (newest sibling by
  default, `switchBranch` navigates; id-less transcripts fall back to the
  linear dedupe). User bubbles gain an edit affordance (loads the composer
  with "resend" mode and an immutable-lineage hint) and a `‹ k/n ›`
  sibling switcher when forked.

Exit criteria (met): `pnpm verify` (server 135, desktop 220); the
processor suite covers the resend rules (sibling lineage, agent-message
and unknown-id rejections, immutable original); the orchestrator e2e runs
a turn for the edited message with the reply's `parentId` on the new
branch; the desktop specs drive the edit flow, the switcher, and the
linear fallback; the live smoke showed both branches in the fold with
replies attached to their own user messages.

Research notes for later slices:

- **Stale-server skew** (hit live): the desktop's gateway attaches to
  whatever answers `/health` and never respawns, so after an upgrade the
  renderer can spend hours talking to a server that predates the new
  commands — unknown actions 400, and the pane's rejection was invisible
  (the error rendered only when a thread existed). Fixed the invisible
  half (the assistant error alert now sits above the thread branch); the
  restart half is operational (kill the stale server; the reconnect
  respawns the current dist). A `/health` version pin in the gateway
  would make this automatic if it bites again.

## S22 — Streaming assistant turns (serve engine)  ·  done (2026-09-06)

The user-facing gap behind "streaming in chat": `opencode run --format
json` buffers a turn's text and emits it once (probed: one delta with the
full reply), so every chat turn landed all at once. The assistant now
runs on a long-lived `opencode serve` per thread whose SSE feed carries
token-level deltas.

- **Engine** (`server/src/engine/serve.ts`, `OpenCodeServeEngine`): one
  `opencode serve` process per chat key (the thread), spawned on the
  first turn with the turn spec's workspace + inline MCP config
  (`mcpConfig` shared with the run engine). Per turn: create/reuse the
  runtime session (`GET /session/:id` liveness check → recreate on 404),
  `POST /session/:id/prompt_async`, and translate the serve's `/event`
  SSE feed — `message.part.updated` (part snapshots), `message.part.delta`
  (token chunks), tool parts (announce once / settle once),
  `session.error` (`MessageAbortedError` = stop), `session.idle` (turn
  end). Stop/timeout POST `/session/:id/abort`. `AgentEngine` gains an
  optional `close()`; boot kills the serves on shutdown.
- **Per-thread serve, not global**: the composer MCP child inherits the
  serve's env (`COMPOSER_THREAD_ID`), so one serve per thread keeps the
  read tools' scope context correct — a global serve could not.
- **Reducer** (`ServeEventReducer`) is a unit-tested pure translation
  (role-map gating so the prompt echo never surfaces, snapshot suffixes,
  idempotent settle); the process/HTTP orchestration is smoke-verified.
- **Boot**: the assistant gets the serve engine unless
  `COMPOSER_ASSISTANT_SERVE=0` or an engineFactory is configured (tests
  keep the FakeEngine); planner/coder stay on `run` (their per-spawn env
  is the MCP write-tools' context, and their runs interleave tool calls
  that stream as events anyway).
- **Snapshot ids**: synthetic snapshot frames now carry a per-call nonce
  (`snapshot-<nonce>-<n>`) — reused ids made clients' seen-id dedupe
  drop re-delivered snapshot events on reconnect, which wedged the
  assistant's send-lock (a completion that never "arrived" twice).
- **Desktop**: the streaming bubble renders plain text while streaming
  (markdown lands with the durable completion — no per-delta re-parse
  flicker), and the transcript sticks to the bottom while streaming
  unless the user scrolls up.

Exit criteria (met): `pnpm verify` (server 140, desktop 221); the live
smoke in the real app streamed a turn token-by-token (12
`assistantMessageDelta` frames for an eight-word count, watched arriving
incrementally on the SSE capture and in the renderer) with the durable
completion landing after.

Research notes for later slices:

- Serve sessions live in opencode's global session store — continuity
  even survives a serve respawn (the session id resolves again), but the
  engine's in-process continuity map does not (a restart starts a fresh
  runtime session, D5 as before).
- The serve event stream carries the user's prompt echo as a text part;
  the reducer's role map (from `message.updated`) is what keeps it out of
  the transcript. Keep that gate when touching part handling.
- `run --attach` was considered and rejected: sessions would execute on
  the serve process, whose static env cannot carry the per-turn
  `COMPOSER_PROJECT_ID/SESSION_ID` the planner/coder MCP children need.

## S23 — Work proposals  ·  done (2026-09-06)

Phase 8, the plan's final slice: the assistant drafts board-ready cards;
the user edits and confirms; cards land through the validated processor.

- **Domain** (3 global events, 45–47, golden regenerated):
  `proposalDrafted` (the record rides the event), `proposalConfirmed`
  (the possibly-edited items + per-project batch outcomes),
  `proposalDiscarded`. `CardProposal {id PR-N, threadId, status
  drafted|confirmed|discarded, items, outcomes?}`; items carry projectId,
  title, description, cardType, an optional in-batch key, blockedBy, and
  the user's `included` flag. Commands: `requestProposalDraft` (MCP
  only), `requestProposalConfirm` / `requestProposalDiscard` (desktop,
  actions `update:`/`delete:proposal`); new `unknownProposal` rejection.
- **Draft validation** happens at draft time (scope: every projectId must
  be in the thread's scope; shape; keys unique; deps = in-batch keys or
  existing cards of the target project; self-blocks reject) so the tool
  result teaches the model before the user sees anything.
- **Confirm** re-validates against current state and executes one
  independent batch per target project — a project whose validation fails
  (state drifted since the draft) records an explicit error outcome while
  the others create cards; key remap and the `cardsCommitted` →
  `dependencyStateChanged` sequence are the planner's ticket-emission
  semantics without a planning session. Confirm runs once per proposal;
  discarding only closes drafts.
- **MCP**: the assistant's surface gains `propose_cards` — the one
  write-capable tool, dispatched on `/mcp/read` to the processor; the
  shipped agent definition tells the model it only drafts. The route's
  whitelist and the executor's stay separate (the read executor cannot be
  reached with the draft tool).
- **Desktop**: the proposal panel sits between transcript and composer —
  per-item inclusion checkbox, editable title/description/type, project
  chip, dep summary; confirm publishes the edited items (edits ride the
  confirm command; a reload mid-edit drops them), discard closes the
  draft; confirmation renders per-project outcome chips (created N cards
  / failed: reason). Nothing is created until confirm.

Exit criteria (met): `pnpm verify` (server 145, desktop 225); the server
suite covers draft validation, per-project key remap, exclusion, partial
failures via state drift (dep card archived between draft and confirm),
double-confirm/discard rules, and the snapshot round-trip; the http e2e
drives propose_cards → confirm → the created card read back; the desktop
specs drive the panel (edit, include toggle, confirm payload, empty
confirm blocked) and outcome folding; a live smoke on the real stack
drafted PR-1 over `/mcp/read`, confirmed it over `/action`, and read back
the created cards with deps remapped.

## S24 — Gateway protocol pin: refuse + respawn stale servers  ·  done (2026-09-06)

The restart half of S21's stale-server skew, made automatic: after an
upgrade the desktop could spend hours attached to a server that predated
its commands (unknown actions 400; the S21 note deferred the fix as "a
`/health` version pin in the gateway would make this automatic if it
bites again"). It had already bitten once — this closes the class.

- **The pin**: `/health` answers `{status, protocol, pid}` — `protocol`
  is the new `PROTOCOL_VERSION` in `server/src/wire/events.ts` (bump on
  every wire change, with the gateway's copy in
  `desktop/electron/server-registry.js`). The gateway's probe now demands
  the pinned protocol: a 200 without a matching version — older, newer,
  or predating the pin (no field) — is not a server the desktop attaches
  to. An arbitrary 200 responder (wrong shape) is likewise refused.
- **The respawn**: on a skewed answer the gateway replaces the stale
  server only when it can prove it spawned that exact process — the
  health `pid` matches the spawn record (`desktop/logs/server.json`,
  written on each workspace-entry spawn, read across desktop restarts).
  Proven: SIGTERM, wait for the URI to go quiet (SIGKILL past the 5s
  grace), clear the record, then the normal spawn path takes over. Not
  proven (a foreign or hand-run server — the WSL attach-only case):
  nothing is killed; discovery refuses and the desktop shows `backend
  unavailable` until the operator restarts that server. Cross-OS pid
  spaces are exactly why ownership is never assumed from the pin alone.
- **Unchanged**: the t11 backoff (a failed spawn still waits 30s),
  `COMPOSER_SERVER_CMD` (never killed — its child's pid is unknowable),
  and the renderer (discover's entry/null contract is the same; a refusal
  surfaces as the existing offline state and `backend unavailable`
  rejections, which is the loud failure the skew never gave).

Exit criteria (met): a new desktop node suite (`desktop/test/` via
`vitest.node.config.ts`, chained into `pnpm test`) drives the registry
against real HTTP servers and real child processes — the pin matches the
server constant (imported from `server/src/wire/events.ts`), a pinned
server is accepted, a pre-pin shape and a foreign stale server are
refused alive, a recorded stale child is SIGTERMed and the pinned build
respawns on the freed port, and a failed spawn still backs off; the
server's boot e2e asserts the health shape. `pnpm verify` green.

## Testing strategy

- Tests are co-located (`server/test/*.test.ts`, desktop `*.spec.ts`).
- **No database mocks** — the store tests run the real embedded RocksDB in
  temp dirs; restarts are exercised across real process boundaries (the
  engine holds the lock until exit, so "boot 2" is a child process).
- **No real LLM in automated tests** — the engine boundary is scripted
  (`FakeEngine`); real-provider checks are manual smokes documented per
  slice.
- The golden fixture guards the cross-language contract: a wire change
  breaks exactly one test on each side. Do not regenerate casually
  (`pnpm --filter @composer/server golden`).
- The gate is `pnpm verify` (D2's no-CI rule carries over).
