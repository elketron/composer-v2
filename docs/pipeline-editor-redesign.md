# Pipeline editor redesign

Status: implemented 2026-09-09 — reference mockup
`docs/ChatGPT Image Sep 9, 2026, 07_29_51 PM.png`. The product model in
[pipeline-kanban-model](pipeline-kanban-model.md) is unchanged; this was a
UI-layer redesign of the pipeline editor plus one small wire addition.
Composer's existing dark theme and tokens remain the baseline.

## Goals

- Replace the browse list + linear editor with the mockup's layout: a
  **pipelines sidebar** grouped by category, a header with save, and
  **Steps / Settings** tabs.
- Make outcome routing **visible in the flow** (labeled, colored edges)
  instead of text chips.
- Add an **add-step palette** with step types and predefined steps.
- Reorganize the step inspector into **General / Outcomes / Advanced** tabs.
- Add a `category` field to pipelines for sidebar grouping.

Non-goals (explicitly out of scope): the board view, the run view, a
free-form canvas editor, forward outcome routing, per-pipeline agent
configuration ("Configure agent" in the mockup).

## Locked decisions

1. **`category` joins the wire model** as an optional string on `Pipeline`
   (protocol bump 11 → 12). Fixed taxonomy served via `GET /catalog`;
   unknown/absent values group under "General".
2. **The board stays as-is** (per-pipeline tabs in the board view). The editor
   gets Steps and Settings tabs only — no embedded Board tab.
3. **Completion stays a pinned pseudo-node** — the implicit terminal lane,
   rendered as a node. "Custom completion" means editing the terminal lane's
   label (currently hardcoded `done`).

## Current state (what changes)

The editor today (`desktop/src/app/pipelines/`) is a vertical node list in a
fixed 640px column joined by line connectors with hover-insert buttons; the
selected node opens a 320px settings panel. Lanes are not first-class: each
step has a `boardVisible` checkbox and lanes are derived on save
(`editor-draft.ts`). Transitions render as text chips under nodes. Validation
surfaces one error at a time after a save attempt.

What carries over unchanged: the `EditorDraft` working-copy semantics
(backward-only outcome routing, terminal pinned last, first step
board-visible, reorder guards), the publish-and-await-echo save flow, the
`GET /catalog` presets, and all server validation
(`server/src/domain/pipeline-draft.ts`).

## Phases

### Phase 0 — wire: `category` field

- `server/src/wire/models.ts`: optional `category?: string` on `Pipeline`;
  bump `PROTOCOL_VERSION` to 12.
- `server/src/domain/pipeline.ts` (fromWire/toWire), `pipeline-draft.ts`
  (validate: optional, trimmed, ≤ 32 chars), `pipeline-codec.ts` (lenient
  parse).
- `PIPELINE_CATEGORIES` (coding, documentation, research, release,
  infrastructure) in `server/src/agents/catalog.ts`, served via `GET
  /catalog`; mirrored desktop-side like `PIPELINE_AGENT_KINDS`.
- Seed PL-1 with `category: 'coding'`.
- Desktop: `wire.ts` mirror, `pipeline.models.ts`, golden fixture, registry
  protocol pin. Lands atomically.

### Phase 1 — editor shell: sidebar, header, tabs

- Layout: left sidebar (pipelines grouped by category, per-group counts,
  `+` button, selected state) + main area. The browse list becomes the
  sidebar; an empty state invites creating/selecting a pipeline.
- Header: back arrow, inline name, Save (accent), overflow menu (delete).
- Tab bar: Steps | Settings.
- New-pipeline flow: name + category picker.

### Phase 2 — flow diagram (Steps tab)

- Keep the DOM-based vertical flow (matches the mockup; no canvas library).
- Node card: number badge, kind icon, name, description line, type badge
  (`Agent` / `Approval` / `Set step` / `Completion`) + presentation badge
  (`Lane` / `Hidden`), overflow menu (duplicate, delete).
- **Labeled edges**: forward edges keep arrows; outcome routes render as
  labeled chips on the edge — green for proceed-style outcomes, red for
  backward routes, with a curved left-side connector (SVG overlay) for
  `changes_requested`-style loops.
- **Add-step palette**: "add step" (and edge `+` buttons) opens a palette
  grouped like the mockup — Agent step (Coder, Reviewer, Planner, Custom
  agent), Approval step (simple / with checklist), Set step (predefined
  runtime steps from `RUNTIME_STEPS`, custom command), Completion step
  (focuses the terminal node / renames it).
- Terminal node rendered as **Completion** ("Mark card as complete"), pinned
  last, non-removable; its lane label becomes editable (custom completion).
- Reorder rules unchanged; up/down + insert buttons stay this phase.

**Extensibility requirement — built-in steps are coming.** Step authoring
must be driven by a single **step-type registry** (a metadata map: id, label,
description, icon, palette group, preset factory, inspector fields), not
scattered per-kind switches. Today's kinds (`agent`, `command`, `human`) are
the first registry entries; predefined command presets are palette entries
from the catalog. Later built-ins (deploy, notify, git operations, …) should
slot in by adding registry entries — palette, node rendering, and inspector
follow automatically. Where a wire change is unavoidable for a new built-in,
it should be one new `PipelineStepKind` + registry entry, not an editor
rewrite. Avoid hardcoding kind checks outside the registry.

### Phase 3 — inspector panel (tabbed)

- Header: icon, "Step 2 — Reviewer", description, delete button.
- **General**: step type (display + change action), per-kind fields — agent
  select + description hint, **Instructions textarea** (the wire model
  supports `instructions`; today's panel never renders it), command/label for
  Set steps, approval prompt for Approval.
- **Board**: "Show this step as a board lane" checkbox + hint copy —
  presentation setting, separate from execution logic.
- **Advanced**: "On execution error" (Stay on this step / Return to …), id
  and revision info.
- **Outcomes**: "Agent must report an outcome" checkbox with hint, outcome
  rows (dot, name, → target select, delete), Add outcome.
- Footer: Delete step / **Duplicate step** (new `EditorDraft` mutation).

### Phase 4 — settings tab

- Pipeline name, category select, stats (id, revision, lanes/steps count),
  danger zone: delete pipeline (server already rejects when cards are
  assigned).

### Phase 5 — polish + tests

- Update the 14 editor specs; add palette, inspector-tabs, category, and
  duplicate-step specs.
- `pnpm build && pnpm test`; verify golden fixture + protocol handshake.

## Risks / notes

- The protocol bump touches the golden fixture and the registry pin; land it
  in the same change as the wire field.
- Outcome targets stay **backward-only + proceed** (domain rule). The
  mockup's `approved → Approval` is "proceed" in our model, since Approval is
  the next lane.
- "Configure agent" is dropped for now — agents are fixed catalog kinds; no
  per-pipeline agent config exists.
