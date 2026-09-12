# Frontend restructure: violations and target shapes

Date: 2026-09-12

Scope: `desktop/src/app/**`

The audit behind this plan measured the frontend against the three rules
in `docs/frontend-architecture.md` (dumb components; POCOs with
functions; state + I/O in services). The findings use the server audit's
format (`docs/server-best-practices-audit.md`); the slices follow
`docs/refactor-architecture.md`'s F1/F2… convention. Code changes happen
per slice, spec-green between slices.

Severity means:

- **High:** breaks a rule outright (component I/O, component writing
  service state).
- **Medium:** a rule's logic living at call sites / duplicated policy.
- **Low:** localized drift.

## Slice F1 — component I/O (rule 3, high)

### FNT-001: the pipeline editor fetches the server catalog itself

**Status:** Resolved 2026-09-12. `PipelineService` owns the reads
(`ensureCatalog`/`ensureRecipes` + `catalog`/`justRecipes` reads, cached
per project and retried on a failed attach); the editor only triggers.

**Categories:** component I/O, misplaced state.

**References:** `desktop/src/app/pipelines/pipeline-editor.component.ts:41,131,268-282,137,140`

`loadCatalog()`/`loadRecipes()` GET `/catalog` and `/justfile` via
`RestClient` inside the component; results sit in component signals
`catalog`/`justRecipes`.

**Target shape:** `PipelineService` gains the read side:

```ts
readonly catalog = computed(() => …);          // CatalogEntry[], loaded per project
readonly justRecipes = computed(() => …);      // JustRecipeEntry[]
```

loaded lazily on first consumer per project (one in-flight guard), the
editor's effects replaced by plain reads. The editor keeps zero
`RestClient`.

### FNT-002: the diff page fetches its patch itself

**Status:** Resolved 2026-09-12. `PipelineService.diffFor(sessionId, path,
projectId)` owns the read; the component keeps only the stale-selection
guard and the render.

**Categories:** component I/O, misplaced state.

**References:** `desktop/src/app/run/diff-view.component.ts:29,40,68-85`

**Target shape:** `PipelineService.diffFor(sessionId, path)` returning
the patch (null loading / '' unavailable), with its own stale-response
guard; the component keeps a computed over it and the diff2html render
moves to a shared helper (FNT-011).

### FNT-003: the directory picker bypasses RestClient

**Status:** Resolved 2026-09-12. The browse goes through `RestClient.get`
(the `backend unavailable` case is its null response).

**Categories:** transport inconsistency.

**References:** `desktop/src/app/core/directory-picker/directory-picker.service.ts:77`

Raw `fetch(base + '/directories…')` beside an existing `RestClient`.

**Target shape:** inject `RestClient` and call `get()`; `base` handling
stays in one place.

## Slice F2 — components writing service state (rule 3, high)

### FNT-004: knowledge pane writes service signals directly

**Status:** Resolved 2026-09-12. `KnowledgeService` owns the editor's
transitions (`beginEdit`/`cancelEdit`/`saveEdit`/`createNote`/`delete`
reset mode/selection/dirty themselves; `setEditingDirty` is the pane's
one mirror intent). The poll loop died by wire: the create response
carries `savedPath` (`PublishResponseJson` gained the field), so the
pane selects via `select(savedPath)` — no event-echo wait.

**Categories:** state ownership, UI state in a service.

**References:** `desktop/src/app/knowledge/knowledge-pane.component.ts:88,107,125-126,153-154,169-170,183-184,191-207`

The pane sets `knowledge.mode/selected/editingDirty` from twelve call
sites, and `selectSavedNote()` polls the event stream (20 × 50 ms) to
await the save's echo.

**Target shape:** the service owns the editor's transitions and the
component only calls intents:

```ts
// knowledge.service.ts
select(path: string | null): void            // sets mode/selected itself
beginCreate(): void
beginEdit(entry): void
save(): Promise<{ ok: boolean; savedPath?: string }>  // awaits the fold's
                                             // workflowSaved echo itself
cancel(): void
```

The dirty machine on the pane becomes a `KnowledgeDraft` POCO mirroring
`DocEditSession` (title/tags/body validation + dirty), or reuses
`DocEditSession`'s shape; the poll loop dies because the service's
command path can await its own echo.

### FNT-005: the assistant component writes the service's error signal through an alias

**Status:** Resolved 2026-09-12. `archiveThread` sets the service's own
error and returns void; the component only awaits it (every other
publish path already set the service's error itself).

**Categories:** state ownership.

**References:** `desktop/src/app/assistant/assistant.component.ts:50,202`

**Target shape:** `AssistantService` sets its own `error` when its
publish path fails; the component only reads and clears via
`dismissError()`.

## Slice F3 — dedupe the copied logic (rule 2, medium)

### FNT-006: the event-id dedupe fold block, copy-pasted ×5

**Status:** Resolved 2026-09-12. One shared `EventDeduper` in
`core/events/dedupe-events.ts`; all five services hold one and open
their fold with `if (!this.dedupe.first(event)) return;`. Shape note: a
class instead of the planned RxJS operator — the plan service maps
wire → PlanEvent before folding and specs call `applyEvent` directly, so
the dedupe must live at the fold entry, not in the subscription pipe.

**Categories:** duplicate code.

**References:** `assistant.service.ts:262-270`, `plan.service.ts:156-163`,
`board.service.ts:356-363`, `pipeline.service.ts:182-189`, and the Set
variant `diagram.service.ts:86-89`

**Target shape:** one RxJS operator in `core/events`:

```ts
export function dedupeEvents(cap = 4096): MonoTypeOperatorFunction<DomainEventJson>
```

applied where services subscribe (`events.events$.pipe(dedupeEvents())`).

### FNT-007: composer textarea behavior ×2

**Status:** Resolved 2026-09-12. `core/composer.ts` (`resizeComposer`,
`composerEnter`); both composers call the helpers (the assistant's
@-mention keys stay local — only it has mentions).

**Categories:** duplicate code.

**References:** `assistant.component.ts:499-502,527-532` ≡
`plan-chat.component.ts:91-94,97-103` (identical `resize()` with the
180px cap; identical Enter/Shift+Enter keydown)

**Target shape:** `core/composer.ts`:

```ts
export function resizeComposer(area: HTMLTextAreaElement, capPx = 180): void
export function composerKeydown(event: KeyboardEvent): boolean // true = send
```

### FNT-008: relative time ×2

**Status:** Resolved 2026-09-12. `core/age.ts:ageLabel` (the canvas's
richer ladder — floor semantics + the ≥30d locale fallback); `AgePipe`
delegates, the canvas dropped its copy.

**Categories:** duplicate code.

**References:** `core/age.pipe.ts:6-17` ≡ `canvas/canvas.component.ts:59-69`

**Target shape:** the ladder lives in one function
(`core/age.ts:ageLabel(date, now?)`); `AgePipe` and the canvas stamp call
it. (`runElapsed` stays separate — mm:ss, different contract.)

### FNT-009: markdown render + sanitizer bypass ×3

**Status:** Resolved 2026-09-12. `core/trusted-html.ts` (`trustHtml`,
`renderTrustedMarkdown`) — the repo's only `bypassSecurityTrustHtml`
call sites now live there (docs, knowledge, diff all route through).

**Categories:** duplicate code, security-sensitive
copy.

**References:** `docs/docs.component.ts:269-283`,
`knowledge/knowledge-pane.component.ts:235-240`,
`run/diff-view.component.ts:43-53`

**Target shape:** `core/trusted-html.ts`:

```ts
export function renderTrustedHtml(sanitizer: DomSanitizer, text: string): SafeHtml
```

(one place to audit the bypass).

### FNT-010: pipeline step projection ×3 + step lookup ×3

**Status:** Resolved 2026-09-12. `Pipeline.stepRowsFor(stepStates)` and
`Pipeline.stepForRun(run)`; card-panel, run-view, and board-card call
the model.

**Categories:** duplicate code, model leakage.

**References:** `card-panel.component.ts:139-147` ≡ `run-view.component.ts:101-109`;
step lookup `board-card.component.ts:57-62` ≡ `card-panel.component.ts:94-99` ≡
`run-view.component.ts:58-63`

**Target shape:** on the `Pipeline` model:

```ts
stepRowsFor(stepStates: Record<string, StepStateStatus>): { step; status }[]
stepForRun(run: RunProgress): PipelineStep | undefined
```

### FNT-011: transcript formatting leaks into run-view

**Status:** Resolved 2026-09-12. `outcomeLabel`, `toolArgsPreview`,
`toolResultPreview` moved beside `RunOutcome` in
`core/models/pipeline.models.ts`; run-view re-exports them for the
template and holds no formatting.

**Categories:** model leakage.

**References:** `run-view.component.ts:167-171,186-190,192-203` vs
`assistant.models.ts:329-331`

**Target shape:** `RunTranscriptEntry` gains `argsPreview()` /
`resultPreview()`; `outcomeLabel(outcome)` becomes a function beside
`RunOutcome` in `core/models/pipeline.models.ts` (mirroring
`server/src/domain`'s outcome vocabulary).

### FNT-012: small coercion helpers ×2

**Status:** Resolved 2026-09-12. `core/models/coerce.ts` (`isRecord`,
`arrayOfStrings`, `normalizeMessageRole`, `toIso`); the assistant and
plan models + services import it (`arrayOfStrings` unified on the
stricter empty-string filter).

**Categories:** duplicate code.

**References:** `isRecord`/`arrayOfStrings` (`assistant.service.ts:680-688` ≡
`plan.service.ts:652-660`); `toIso`/`normalizeMessageRole`
(`assistant.models.ts:194-197,154-156` ≡ `plan.models.ts:226-229,222-224`)

**Target shape:** one `core/models/coerce.ts`; the plan/assistant models
import from it.

### FNT-013: card coercion duplicated inside plan.service

**Status:** Resolved 2026-09-12. `PlanEvent`'s `CardsCommitted` now
declares `cards: Card[]` (the wire mapping runs `cardFromWire` already);
the fold passes them through and `asCommittedCard` plus its satellite
helpers (`asAssignee`, `asFileStats`, `cardType`, the DTO interfaces)
are deleted.

**Categories:** duplicate code, correctness risk.

**References:** `plan.service.ts:593-622` (`asCommittedCard`) vs the same
file using `cardFromWire` (`wire.ts:1093`) for the same event family at
`:275` vs `:517`

**Target shape:** one coercion (the wire one); `asCommittedCard` deleted.

## Slice F4 — transcript logic onto the models (rule 1+2, medium)

### FNT-014: assistant turn-activity queries reimplemented in components

**Status:** Resolved 2026-09-12. `AssistantThread.turnActivityFor()` and
`PlanningSession.turnActivityFor()` own the grouping (each with its key:
id vs index); `turnActivityLabel` is the shared collapsed label (the plan
chat adopts the assistant's richer ladder); `assistantToolLabel` now
takes `{toolName, args}` so both entry types use it; the service exposes
`siblingsOf()` (branchOf reuses it) and the component dropped its copy.

**Categories:** model leakage, duplicate code.

**References:** `assistant.component.ts:245-269,289-293,312-317` ≡
`plan-chat.component.ts:31-65,67-73` ≡ `assistant.service.ts:639-646`

`activityFor`/`activityLabel`/`isLive` (thread-structure queries) and
`siblingsOf` (≡ service `visibleSiblings`) exist as 2-3 copies; the plan
variant also reimplements `assistantToolLabel` minus truncation.

**Target shape:** queries on the models —
`AssistantThread.activityFor(message)`, `visibleSiblingsOf(message)`;
`AssistantMessage.toolLabel()` wrapping `assistantToolLabel`; the plan
chat imports them (its shapes differ only by `parentId` vs `parentIndex`,
which the model can normalize). Component keeps only loop/render.

## Slice F5 — the docs viewer state machine (rule 1, medium)

### FNT-015: docs.component orchestrates fetches and owns viewer state

**Status:** Resolved 2026-09-12. `DocsService` owns the viewer state
machine (`viewer` signal: path/text/html/content/error/loading; the
intents `select(projectId, path)`, `show(path, text)`, `clear()`; the
stale-response guard rides a request counter). The viewer keeps the raw
markdown, so `beginEdit` needs no refetch at all — the component's whole
fetch orchestration (`showDoc`/`showText`/`selectPath` guards) is gone,
and the component now imports nothing from wire (the last component-level
wire import is dead). Save/rename failures stay on the editor session's
`saveError`; a failed delete surfaces through the viewer (the service's
surface).

**Categories:** misplaced state, gray-zone smart
component.

**References:** `desktop/src/app/docs/docs.component.ts:55-57,106-131,135-146,172-238,269-283,285-298`

I/O is in `DocsService`, but the component owns `rendered/content/
readError` plus the select/edit/save sequences with stale-response
guards.

**Target shape:** a `DocsViewer` state machine in `docs.service.ts`
(idle → reading doc → reading text → error), exposing
`selection: computed`, `select(path)`, mirroring how
`KnowledgeService.select` works after FNT-004; the component keeps only
the editor handoff (`DocEditSession` stays as is — exemplary).

Also: `docs.component.ts:17` imports `DocInfoJson` from wire — the last
component-level wire import; replaced by the `Doc` model.

## Slice F6 — DiagramDraft: the canvas working copy (rule 1+2, high, largest)

### FNT-016: canvas.component owns the diagram domain

**Status:** Resolved 2026-09-12. `DiagramDraft` (core/models/
diagram-draft.ts) owns the working copy and every mutation rule —
`addNode`/`addNodeNear` (id allocation + join-on-drop-in + cascade),
`groupSelection`, `moveNodes`, `dropToGroup`, `connect` (duplicate
guard), the label/type/description/group/edge setters (grow-only
frames), and the deletes (edges die with nodes, groups keep theirs).
The dirty compare lives on `Diagram.signature()` /
`diagramContentSignature`. The graph primitives
(`connectorSourceId/TargetId`, `nodeIdFromConnector`, `groupIdContaining`,
`overlapsAny`, `freshNodeSpot`, `edgeExists`, `nodesBounds`,
`applyNodeMoves`) are pure functions on `diagram.models.ts`. The canvas
holds one `draft` signal and projects `name/nodes/edges/groups` from it
(1181 → 955 lines; zero domain rules left). flow-editor imports
`nextNodeId` + the connector helpers; its local `nextNodeId` (byte-equal
to the model's) is deleted — its `nextGroupId` stays (genuinely
different rule: the `Group1` namespace includes node ids, unlike the
canvas's `G1`). Verified by the new `diagram-draft.spec.ts` round-trip
(open → clean, edits → dirty, projection → save → reopen → clean) plus
the unchanged canvas component specs.

**Categories:** domain state in a component,
duplicate graph rules.

**References:** `desktop/src/app/canvas/canvas.component.ts:88-115,181-191,234-248,503-510,536-581,608-633,687-741,700-714,963-995`

The whole working copy (name/nodes/edges/groups/viewport signals), the
dirty-compare signatures, and the graph rules (group formation from
selection, membership on drag, duplicate-edge guard, cascade deletes,
collision-aware placement) live in the component — and most of them a
second time in `docs/flow/flow-editor.component.ts`
(`:122-160,218-235,283-315,331-361`), whose local `nextGroupId`/`nextNodeId`
also duplicate `core/models/diagram.models.ts:128-148`.

**Target shape:** a `DiagramDraft` POCO beside `Diagram`
(`core/models/diagram-draft.ts`), plus pure graph primitives on the
diagram model module shared by canvas and flow-editor:

```ts
// diagram-draft.ts (mirrors EditorDraft/DocEditSession)
DiagramDraft.open(saved: Diagram): DiagramDraft
fromBlank(): DiagramDraft
readonly dirty: boolean            // signature compare lives here
addNode(spot: Spot): DiagramNode  // collision-aware placement
deleteSelected(ids): void          // membership cascade
groupSelection(ids): DiagramGroup  // bounding-box formation
moveNodes(ids, delta): void        // membership-on-drag rule
connect(edge): { ok: true } | { ok: false, error: string }
toDiagram(): Diagram
```

graph primitives as pure functions on `diagram.models.ts`
(`connectorIds(node)`, `groupIdContaining(nodes, x, y)`,
`boundingBox(nodes)`, `freshNodeSpot(…)`) — shared by both editors;
`flow-graph.ts`'s local allocators deleted. The components shrink to
event handlers calling the draft + `DiagramService` commits. The dirty
signature fns move onto `Diagram` (`signature(): string`).

## Order and verification

F1 → F2 (mechanical, unblocks trust in the seams) → F3 → F4 (pure
moves, low risk) → F5 → F6 (largest; spec the draft POCO first).

Every slice: `pnpm --filter @composer/desktop test` (unit specs incl.
the fake-events harness) and `ng build`; FNT-016 additionally gets a
round-trip spec (open → edit → dirty → toDiagram → save → open).
