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

## S4 — Desktop completion  ·  planned

The visible-product slice: the pipeline step editor (from-scratch
authoring per the ownership rule — pipelines are user-authored), run
progress on the board, the approval-gate affordance, and the coding-tab
question (likely an `opencode attach` link before any transcript UI).

Exit criteria: author → run → watch → approve without leaving the app;
desktop specs for the editor and the progress folds.

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
