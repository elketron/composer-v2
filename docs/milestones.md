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

## S1 — Domain core  ·  planned

Cards, lanes, sub-state, blockers, automation — the board's engine,
ported from v1's processor semantics (same validation order, same
rejection messages, same emitted event lists).

- Commands: `requestCardCreate` / `requestCardsCreate` (blockedBy must
  reference existing cards; ids allocate `T-N` per project; initial
  sub-state per type), `requestCardMove` (lane-valid for the type,
  blockers unless `override`, same-lane no-op, automation honored for
  agent moves — human drags never blocked), `requestCardTypeChange`
  (resets sub-state; invalid lane falls back to new),
  `requestCardArchive`, `requestSubStateUpdate`,
  `requestAutomationToggle`.
- Fold: card moves (New unassigns; rejection comments),
  type changes, sub-state, dependency state, automation.
- Action mapping: `create`/`update`/`delete` on `card`, `update` on
  `automation`.
- Tests: v1's processor behavioral suite re-expressed (create/move/
  blockers/type-change/automation) + fold/snapshot round-trips.

Exit criteria: the desktop board is fully interactive against v2
(create, drag, block, archive); the processor suite is green; the wire
is untouched (golden stays).

## S2 — Planning turn  ·  planned

The planner on opencode: chat → plan document → tickets.

- Domain: planning sessions (`requestPlanningSessionCreate`,
  `requestUserMessage`), the document
  (`requestPlanDocumentUpdate`), ticket emission
  (`requestTicketsCreate` — in-batch keys remap onto fresh card ids,
  blockedBy validated; session → `done`).
- Engine boundary: `AgentEngine` interface (`run(spec, onEvent) →
  outcome`) + `FakeEngine` (scripted sessions for tests) +
  `OpenCodeEngine` (spawn/parse `opencode run --agent composer-planner
  --format json`; session id stored on the planning session for
  continuity).
- The `composer-planner` agent definition (shipped into the project):
  the document-in-context brief, v1's prompt discipline (§6: directive
  tool usage), with `edit_document` / `create_tickets` as MCP tools
  calling the validated commands.
- Composer's MCP server (`server/src/mcp.ts`, stdio): the planner's
  tools + session context (document + transcript tail).
- Wire: `agentSessionStarted/Ended` + `agentMessageDelta/Complete`
  become real (streamed from the engine, deltas ephemeral).

Exit criteria: scripted-FakeEngine e2e — user message → document edit →
`planDocumentUpdated` → approval turn → `create_tickets` → cards land →
session `done`; the desktop Plan view works unchanged; one real-opencode
manual smoke documented here.

## S3 — Pipelines  ·  planned

Authoring + the sequential runner + the coder.

- Authoring: `requestPipelineSave` / `requestPipelineDelete` (fresh ids
  `PL-N`, known ids upsert; step validation: unique ids, per-kind
  required fields); the default coding pipeline seeds each project
  (`coder → build → test → approval`), deletion tombstones keep it
  dead; `requestPipelineRun` / `requestPipelineStop` /
  `requestPipelineGateRespond`.
- Runner: one in-process task per run; steps execute in order —
  `command` (child process in the project directory, output captured,
  wall-clock cap), `human` (run parks `waiting`; the gate command
  resumes or rejects — rejection routes the card back to its implement
  lane with the comment, approval routes to Done when the gate is the
  last step), `agent` (the engine; `agentKind` names the shipped
  agent). Progress events per step; lane + sub-state as the projection;
  failures recorded on the card's `retries`; stop kills the current
  child; boot cancels interrupted runs (D5).
- The `composer-coder` agent definition: implement the card through
  opencode's own file/bash tools in the project directory (no workspace
  buffer — the runtime's tools are the surface).
- First task: a spike capturing `opencode run --format json`'s event
  schema (isolated in `engine/opencode.ts`'s parser).

Exit criteria: fake-engine runner e2e (walk hands-off, park at the gate,
gate resumes/rejects, stop, boot-cancel); the real smoke — the sum.js
repo fixed end to end through opencode (coder → build → test → approval
→ Done); board progress visible at every step.

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
