# Refactor: objects own state + representation

The working rules this refactor enforces, and the slice plan for getting there.

Frontend:

1. Objects own their own state and representation logic.
2. Services own what and where objects come from (I/O boundary, lists, etc.).
3. Components are dumb.

Server:

1. The repr pattern is good for most things — an object owns its wire
   conversion (`fromWire`/`toWire`) rather than leaving parsing to `http.ts`
   and emitting to `snapshot.ts`.
2. Objects are used together — a per-project aggregate of linked objects
   (card → pipeline → run) answers cross-object rules in one place; no POCOs.

## Decisions

- **Dual representation.** Domain classes live in `server/src/domain/` and own
  `fromWire()`/`toWire()`. `wire/models.ts` stays the pure JSON catalog the
  golden fixture pins. The fold builds classes; the snapshot asks them for
  repr.
- **Objects own transitions.** Command validation moves from `processor.ts`
  into entity/aggregate transition methods that return their events or throw
  typed rejections. The processor thins to dispatch + publish; it stays the
  only writer (single write path through the bus).
- **Wire frozen.** No event-shape changes, no PROTOCOL_VERSION bump, golden
  fixture untouched. The refactor is provable by existing tests.
- **Server first.** The frontend `core/models/` already speaks the target
  language; the server founds it.

## Where we stand

### Server — zero repr, all POCOs

`wire/models.ts` interfaces *are* the domain shapes; serialization is
`JSON.stringify` by omission. One entity's logic is smeared across 4–6 files:

- `Card`: blocking rule written twice (`processor.isBlockedIn`,
  `snapshot.isBlocked`), terminal rule twice (`processor.isTerminalStage`,
  `fold.isTerminal`), stage projection in `fold.visibleStageOf`, lenient
  parsing in `http.readCard` (~50 lines), view shaping in `dashboard.ts` +
  `assistant-tools.ts`.
- `nextMessageIndex` implemented 4× (`processor.ts` ×2, `planning.ts`,
  `assistant.ts`); the planning/assistant orchestrators are ~80% copy-paste.
- `RunRecord` lives in `fold.ts`, not with the models; revision pinning is
  re-derived in `fold`, `processor`, `runner`, and `snapshot`.
- `processor.ts` (~1.9k lines) is a god module; `http.ts` carries a 240-line
  stringly-typed `fromAction` mapper.
- `structuredClone` wherever state is read — the symptom of shared mutable
  POCOs.

### Frontend — the rules are half-true

`core/models/` (board, pipeline, plan, assistant) already states the rules in
its header: components render models and forward events, services only hold
state and issue commands, models never do I/O. The fold services are clean
I/O + state owners (`EventsClient` is the single boundary). Gaps:

- No models at all for docs, knowledge, dashboard — raw `*Json` wire shapes
  flow into components.
- Repr leaked into components: `runLabel`/`stepSummary` (board-card),
  `elapsed()` (card-panel), markdown + sanitizer (docs), and
  `pipeline-editor.component.ts` (~610 lines) owning an `EditorDraft` model
  with validation that duplicates `Pipeline.toWire()`.
- Fat components: `assistant.component.ts`, `docs.component.ts`,
  `knowledge-pane`, `flow-editor` each hold edit-session state machines.
- Service hygiene: hand-rolled `fetch` duplicated in settings/dashboard/docs,
  `settings.service` writes into `shell.model` directly, `app.ts` eagerly
  injects every fold service to work around snapshot ordering.

## Target architecture

### Server

```
server/src/domain/        the objects
  card.ts                 Card — fromWire/toWire, local queries, transitions (R3)
  pipeline.ts             Pipeline + PipelineStage + PipelineStep
  run.ts                  Run (moved out of fold.ts)
  project.ts              Project
  board.ts                the per-project aggregate (R2)
  thread.ts / session.ts / planning.ts / proposal.ts   (later slices)
  doc.ts / knowledge.ts / workflow.ts                  (file domains, R5)
```

Pattern every entity follows (dual representation):

```ts
export class Card {
  static fromWire(json: CardJson): Card        // lenient parse (absorbs http.readCard in R4)
  toWire(): CardJson                           // strict emit (absorbs snapshot + tool shaping)
  // queries — the rules currently duplicated in processor/fold/snapshot
  // transitions — return their events or throw typed rejections (R3)
  with(changes: Partial<CardJson>): Card       // immutable; the fold swaps instances
}
```

The aggregate ("objects used together"): `ProjectState` becomes a `Board`
aggregate class; the root `State` composes projects plus the global domains
(threads, proposals). Cross-object rules live on the aggregate; local rules on
entities:

```
State ─ projects → Board (per project)
      │             ├─ cards: Card        ─┐ resolves links
      │             ├─ pipelines: Pipeline  ├─ board.pipelineOf(card)
      │             ├─ revisions by run     │  board.activeRunOf(card)
      │             └─ runs: Run            │  board.isBlocked(card)   ← single definition
      ├─ threads (global)                   │  board.revisionOf(run)
      └─ proposals                          ─┘
```

Entities are immutable (`with()`); the fold replaces instances instead of
mutating them, which deletes the `structuredClone` defensiveness. The write
path keeps its shape:

```
command → aggregate.execute(cmd) → EventBody[] | Rejection → bus.publish
```

The snapshot becomes a repr: each entity owns its synthetic-event projection;
`snapshot.ts` shrinks to composition, ordering, and envelope wrapping.

### Frontend

Finish the rules that `core/models/` already declares: models for docs /
knowledge / dashboard, `EditorDraft` for the pipeline editor, `ProposalDraft`
for assistant, card/run repr onto models, a shared REST client, services that
only own I/O + folds, dumb components.

## Slices

Each slice ends `pnpm verify` green. Server slices are sequential R1→R2→R3;
R4–R6 are independent; F1–F5 are independent of the server (wire frozen) and
can interleave once R1 lands.

| # | Slice | Key moves |
|---|---|---|
| R1 | Domain foundation | `domain/` with Card, Pipeline(+Stage/Step), Run (out of fold.ts), Project; fromWire/toWire; local queries; the fold produces immutable instances; the duplicated rules (`isBlocked`, `isTerminal`, `visibleStageOf`) collapse onto the objects |
| R2 | Aggregate | `Board` class resolving links; snapshot becomes the aggregate's repr; `snapshot.isBlocked` and friends die |
| R3 | Transitions | Validation moves from processor into entity/aggregate transition methods; processor → dispatcher |
| R4 | Command repr | `fromAction` + `readCard`/`readPipeline` become parse methods; shared turn-loop object for planning/assistant; `thread.nextIndex()` |
| R5 | File domains | Doc/KnowledgeEntry/Workflow classes own frontmatter repr; knowledge gets a real serializer; round-trip tests first |
| R6 | Consumers | dashboard + assistant-tools shape views through the aggregate |
| F1 | Pipeline-editor draft | `EditorDraft` class owns conversion, validation, reordering, id allocation |
| F2 | Docs + knowledge models | `Doc`, `DocEditSession`, `KnowledgeEntry`; markdown/mermaid repr off components |
| F3 | Assistant models | `ProposalDraft`, title/tool-strip repr; assistant component becomes dumb |
| F4 | Board repr | `runLabel`/`stepSummary`/`hiddenStageLabel`/`runIcon`/`elapsed` become model getters |
| F5 | Service hygiene | `core/rest.ts` client; settings stops writing `shell.model`; startup ordering fix |

## Invariants (every slice)

- PROTOCOL_VERSION stays 7; `wire-golden/events.json` untouched; the desktop
  asserts the same file and connects unchanged.
- The event log stays append-only; no store migrations.
- R1–R3 must pass all server tests **unmodified** — they are the behavior pin
  that makes the refactor provable.
- `pnpm verify` after every slice.

## Risks

- **R3 is the blast radius** — every validation rule moves. Mitigation: the
  unmodified-tests constraint; mechanical move-then-dispatch, no rule edits.
- **Fold churn** — immutable instances mean a new object per event instead of
  in-place mutation. Fine at this scale, and it deletes the per-call map
  clones that exist today.
- **R5** — knowledge has no serializer today, only inline frontmatter
  building; port the workflows round-trip test idiom before extracting.
