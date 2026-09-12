# Frontend architecture

The three working rules the desktop follows, where things live, and the
canonical shapes to imitate. The audit that found the gaps:
`docs/frontend-restructure.md`.

## The rules

1. **Dumb, presentational components** — a component renders, projects
   (computeds over service state), and holds view-local UI state only.
   Exceptions: forms (a form's draft is the form's business —
   `card-creator`, `model-picker`).
2. **Classes as POCOs with functions** — reusable logic lives on model
   classes (`Pipeline.fromWire`, `DocEditSession.dirty()`) or plain
   functions beside the model they serve (`parsePlanDocument`,
   `assistantToolLabel`). Never copy-pasted at call sites.
3. **State and I/O live in services** — services own signals (the fold)
   and all transport (REST reads, command publishes, SSE comes from
   `EventsClient`). Components read from services and delegate intents
   ("save this", "open that"); they never fetch and never write a
   service's signals directly — services expose intent methods that
   update their own state.

## The layers

```
core/            the shared kernel, knows nothing about features
  events/        EventsClient (SSE + command publish), wire.ts, fakes
  rest.ts        RestClient (fetch GET/PUT wrapper)
  models/        the POCOs: board, pipeline, diagram, docs, knowledge,
                 assistant, plan models — fromWire/toWire + queries
  *.ts           shared helpers (markdown render, confirm, palette,
                 directory picker) and small pipes
<feature>/       one folder per feature
  *.service.ts   the feature's state + I/O (the fold, commands, REST)
  *.component.*  the views: inputs, computeds, view-local signals
  *.spec.ts      component specs run on the FakeEventsClient; model
                 specs are pure
```

Dependencies point one way: `components → services → core`. Services may
inject other services' reads (PipelineService is the runs catalog); a
component never reaches past its service into another feature's
plumbing.

## Component shape

- Inputs are `input()`/`input.required()`; route params bind through
  `withComponentInputBinding`.
- Domain data arrives as service computeds or local computeds **over**
  service signals — never a `fetch`-filled signal.
- View-local state is fine: a draft textarea, an expanded toggle, the
  hovered row, a ticker (`now` in run-view). If it would survive the
  route change and still mean something, it belongs in a service.
- The only allowed writes to services are intent method calls
  (`save()`, `select()`, `stop()`). Mutating a service's signal from a
  component is a violation even through a pass-through alias.
- Formatting for display: tiny helpers may live on the component only
  when they are pure string shaping of one template; anything with a
  rule (outcome labels, elapsed, step projections) goes on the model.

## Service shape

- State: private signals + public read-only computeds/selectors.
- I/O: `EventsClient.publish` for commands, `RestClient` for reads; a
  fold that is idempotent (dedupe by event id, keyed by projectId).
- Commands return success and surface the server's rejection through a
  service-owned signal (`rejection`), never by throwing into the
  component.
- No UI concepts in a service's state (`mode`, `selected` panel tabs,
  dirty-during-typing) unless the service *is* that UI's store — and
  then it owns the transitions (see `KnowledgeService.select`,
  `SettingsService`'s draft).

## POCO shape

- Converters: `static fromWire(json)` / `toWire()`.
- Queries: methods that read `this` (`Card.blockers()`,
  `Pipeline.stepById()`, `Doc.markup()`).
- Editing state machines: a draft class owning validation + dirty +
  commit (`EditorDraft`, `DocEditSession`, `ProposalDraft`). The
  component calls it; it never reimplements the rules.
- Pure module functions beside their model for things that don't need
  `this` (`parsePlanDocument`, `runElapsed`, `assistantToolLabel`).
- Server-side mirror: when the server has the same rule, the frontend
  POCO mirrors `server/src/domain/` — same names where possible.

## The exemplars (imitate these)

- `pipelines/editor-draft.ts` — draft + validation + reorder rules as a
  POCO; the editor component stays a shell.
- `core/models/docs.models.ts` — `Doc` + `DocEditSession` (dirty,
  guards, fence ops).
- `core/models/board.models.ts` — `Card` queries (`blockers`,
  `isBlockedIn`, `with`).
- `board/card-panel.component.ts`, `settings/` — dumb components over
  service intents.
- `core/events/events-client.ts` — the transport boundary (the only
  `EventSource` in the repo), fake injected in tests
  (`provideFakeEventsClient`).
