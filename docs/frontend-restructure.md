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

**Status:** planned. **Categories:** component I/O, misplaced state.

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

**Status:** planned. **Categories:** component I/O, misplaced state.

**References:** `desktop/src/app/run/diff-view.component.ts:29,40,68-85`

**Target shape:** `PipelineService.diffFor(sessionId, path)` returning
the patch (null loading / '' unavailable), with its own stale-response
guard; the component keeps a computed over it and the diff2html render
moves to a shared helper (FNT-011).

### FNT-003: the directory picker bypasses RestClient

**Status:** planned. **Categories:** transport inconsistency.

**References:** `desktop/src/app/core/directory-picker/directory-picker.service.ts:77`

Raw `fetch(base + '/directories…')` beside an existing `RestClient`.

**Target shape:** inject `RestClient` and call `get()`; `base` handling
stays in one place.

## Slice F2 — components writing service state (rule 3, high)

### FNT-004: knowledge pane writes service signals directly

**Status:** planned. **Categories:** state ownership, UI state in a service.

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

**Status:** planned. **Categories:** state ownership.

**References:** `desktop/src/app/assistant/assistant.component.ts:50,202`

**Target shape:** `AssistantService` sets its own `error` when its
publish path fails; the component only reads and clears via
`dismissError()`.

## Slice F3 — dedupe the copied logic (rule 2, medium)

### FNT-006: the event-id dedupe fold block, copy-pasted ×5

**Status:** planned. **Categories:** duplicate code.

**References:** `assistant.service.ts:262-270`, `plan.service.ts:156-163`,
`board.service.ts:356-363`, `pipeline.service.ts:182-189`, and the Set
variant `diagram.service.ts:86-89`

**Target shape:** one RxJS operator in `core/events`:

```ts
export function dedupeEvents(cap = 4096): MonoTypeOperatorFunction<DomainEventJson>
```

applied where services subscribe (`events.events$.pipe(dedupeEvents())`).

### FNT-007: composer textarea behavior ×2

**Status:** planned. **Categories:** duplicate code.

**References:** `assistant.component.ts:499-502,527-532` ≡
`plan-chat.component.ts:91-94,97-103` (identical `resize()` with the
180px cap; identical Enter/Shift+Enter keydown)

**Target shape:** `core/composer.ts`:

```ts
export function resizeComposer(area: HTMLTextAreaElement, capPx = 180): void
export function composerKeydown(event: KeyboardEvent): boolean // true = send
```

### FNT-008: relative time ×2

**Status:** planned. **Categories:** duplicate code.

**References:** `core/age.pipe.ts:6-17` ≡ `canvas/canvas.component.ts:59-69`

**Target shape:** the ladder lives in one function
(`core/age.ts:ageLabel(date, now?)`); `AgePipe` and the canvas stamp call
it. (`runElapsed` stays separate — mm:ss, different contract.)

### FNT-009: markdown render + sanitizer bypass ×3

**Status:** planned. **Categories:** duplicate code, security-sensitive
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

**Status:** planned. **Categories:** duplicate code, model leakage.

**References:** `card-panel.component.ts:139-147` ≡ `run-view.component.ts:101-109`;
step lookup `board-card.component.ts:57-62` ≡ `card-panel.component.ts:94-99` ≡
`run-view.component.ts:58-63`

**Target shape:** on the `Pipeline` model:

```ts
stepRowsFor(stepStates: Record<string, StepStateStatus>): { step; status }[]
stepForRun(run: RunProgress): PipelineStep | undefined
```

### FNT-011: transcript formatting leaks into run-view

**Status:** planned. **Categories:** model leakage.

**References:** `run-view.component.ts:167-171,186-190,192-203` vs
`assistant.models.ts:329-331`

**Target shape:** `RunTranscriptEntry` gains `argsPreview()` /
`resultPreview()`; `outcomeLabel(outcome)` becomes a function beside
`RunOutcome` in `core/models/pipeline.models.ts` (mirroring
`server/src/domain`'s outcome vocabulary).

### FNT-012: small coercion helpers ×2

**Status:** planned. **Categories:** duplicate code.

**References:** `isRecord`/`arrayOfStrings` (`assistant.service.ts:680-688` ≡
`plan.service.ts:652-660`); `toIso`/`normalizeMessageRole`
(`assistant.models.ts:194-197,154-156` ≡ `plan.models.ts:226-229,222-224`)

**Target shape:** one `core/models/coerce.ts`; the plan/assistant models
import from it.

### FNT-013: card coercion duplicated inside plan.service

**Status:** planned. **Categories:** duplicate code, correctness risk.

**References:** `plan.service.ts:593-622` (`asCommittedCard`) vs the same
file using `cardFromWire` (`wire.ts:1093`) for the same event family at
`:275` vs `:517`

**Target shape:** one coercion (the wire one); `asCommittedCard` deleted.

## Slice F4 — transcript logic onto the models (rule 1+2, medium)

### FNT-014: assistant turn-activity queries reimplemented in components

**Status:** planned. **Categories:** model leakage, duplicate code.

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

**Status:** planned. **Categories:** misplaced state, gray-zone smart
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

**Status:** planned. **Categories:** domain state in a component,
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
