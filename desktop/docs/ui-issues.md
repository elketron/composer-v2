# Desktop UI issues — smoke test (2026-09-05)

Environment: Electron 43 window (dev server `ng serve` :4200, composer server on 5214), Angular 22 renderer.
Views exercised: board (ALL swimlane + per-type), card panel, plan, pipelines (editor + list), coding, settings, shell (topbar/left rail/status strip).
Working tree ref under test: `28f721e S4: desktop completion` + uncommitted `desktop/angular.json`, `pipeline.service.ts`.

What worked: view routing, left rail + tooltips, card panel open/close (Esc), type change (checklist resets + accent), force move, drag & drop between lanes (real mouse drag, server echo), pipeline authoring save/edit flow, pipeline appearing in the card run selector, run progress box + pulsing checklist, coding-sessions list, board column headers/counters, focus rings on Tab.

> **Fix pass (same day)**: issues 2, 3 (outcome line), 5, 6, 7, 8, 9 (hardened), 10, 11, 12 and the
> full sub-12px inventory are fixed in the working tree; issue 1's client-side fold bugs (stuck
> stream bubble, index-mismatch duplicates) fixed with a regression spec; issue 4 got honest
> tooltips ("session-local"). Remaining open: 1 (server-side numbering), 4 (needs a server
> command), 6-adjacent transcript restore (13), and the design-level observations 14-20.

---

## Confirmed issues

### 1. Plan transcript: message streams merge, indices collide, stuck "thinking" bubble — HIGH
Reproduced three times, each worse than the last:
- Right after one send, transcript rendered `YOU m1` → `AGENT m2` → `AGENT m3` → `AGENT m2` (same
  text as m3, out of order) with a still-pulsing stream-dot under the last bubble.
- A few minutes later the transcript contained a *different session's* history (m1…m12 of the
  earlier S-1 smoke conversation) interleaved with live messages, plus a permanently stuck
  streaming bubble labeled `m11` (pulse dot never goes away).
Root cause (client): messages are folded/tracked by `message.index` only
(`track message.role + '-' + message.index`, plan-chat.component.html:10) so snapshot-replayed
history and live events collide on the same index range; the streaming message's index is guessed
as `message.index + 1` (plan.service.ts:152) and never reconciles with the server's numbering, so
`AgentMessageComplete` fails to clear it (plan.service.ts:171).
Severity: high — the primary planning surface shows corrupted conversation state.

### 2. Pipeline run start fails silently — HIGH
Pressing **run** on a card whose project has no directory set does nothing visible. The server
rejects with `{"ok":false,"rejectionCode":"invalidCommand","rejectionMessage":"Project P-1 has no
directory set"}` but `CardPanelComponent.startPipeline()` (card-panel.component.ts:116-119)
fire-and-forgets the promise; the rejection is swallowed. No toast, no inline error — the select
just stays open. Same pattern for `stopPipeline`, `approveGate`, `rejectGate`.
Repro: fresh seed data (no project directory) → card panel → pick pipeline → run.
Severity: high — a primary action appears broken with zero feedback.

### 3. Run outcome is never surfaced — MEDIUM/HIGH
Watched a real run end (agent session `A-1` → status `ended`, `pipelineRunEnded` folded): the card
panel simply drops back to the plain checklist (all steps "pending", including the ones that
already ran) — no success/failure indication, no run history, no notification. If the run fails,
there is likewise nothing on the card or in the panel. The only trace is the coding tab's session
row ("ended").
Severity: medium-high — completed/failed work is indistinguishable from "nothing happened".

### 4. "assign to me" / "unassign" are local-only and silently revert — MEDIUM
Documented in code (board.service.ts:199-207: "no command in the event catalog yet… do not survive
a restart"), but the UI gives no hint. Clicking "assign to me" shows "you"; any page reload /
SSE snapshot replay replaces the card with the server body and the assignment vanishes without a
word. Severity: medium — looks like a working feature that randomly forgets.

### 5. Status strip advertises "ctrl+k command" but nothing handles it — MEDIUM
`status-strip.component.html:13` shows the hint; there is no Ctrl+K handler anywhere in the
renderer (grep over `src/app`). Same for the plan composer: advertised but dead.

### 6. Status strip "N agents running" counts automation toggles, not agents — MEDIUM
`agentCount = this.board.automation().onCount` (status-strip.component.ts:22) — the strip showed
"6 agents running" (all six pulsing) while the coding tab listed exactly 1 real session, and later
0 running with the strip unchanged. Label/dots misrepresent system state.

### 7. Top bar badges are hardcoded static HTML — MEDIUM
`topbar.component.html:48-50`: `0 calls`, `00:00`, `build —` are literal strings, never updating.
On a live session they present fake telemetry as real.

### 8. Pipeline editor: red error styling with no message before the user does anything — MEDIUM
Opening "new pipeline" immediately renders every step row with the red `.invalid` outline
(the form-wide `validate()` result is applied per-step, pipeline-editor.component.html:32) before
the user has typed anything or tried to save. The reason (`validate()` returns a string) is only
shown after pressing save (`draft.rejection`). Also: all steps are outlined red even when only one
is invalid, and `@for (…; track $index)` over an editable list is fragile (index churn on
remove/move).
Minor sibling: `console.log('[dbg] pipelineSaved fold: …')` left in pipeline.service.ts:116.

### 9. Console TypeError in pipeline editor validate — LOW (needs hardening)
Observed repeatedly in console during the session:
`ERROR TypeError: name.trim is not a function at _PipelineEditorComponent.validate`
(pipeline-editor validate() called from the step-row template on every CD cycle). Only reproduced
under synthetic input events during testing, not by real typing — but validate() throwing inside
render aborts change detection for the whole view, so it should be defensive (and shouldn't run
per-step-per-CD anyway).

### 10. Card panel: "blocked by" label wraps and misaligns — LOW
`.dep-label` fixed `width: 72px` wraps "blocked by" onto two lines ("blocked" / "by") while the
value ("nothing") stays on the first line — reads as three unrelated rows
(card-panel.component.html:41-52). Repro: open any card without deps.

### 11. Plan composer: sent draft lingers while composer is locked — LOW
After Enter, the input disables (good) but the just-sent text stays visible until some other
signal (agent delta) triggers change detection; `draft = ''` in `PlanChatComponent.send()`
(plan-chat.component.ts:21-26) is a plain-field write that never repaints on its own under
zoneless/OnPush. Looks like the send failed.

### 12. Plan chat composer tool buttons are dead — LOW
`+` (attach), `T` (format), `#` (comment) have titles but no handlers
(plan-chat.component.html:38-40). No disabled state either.

### 13. Plan transcript history not restored on relaunch — MEDIUM (design decision needed)
Session `S-1 · drafting` had a populated plan document; after a fresh app start the transcript
pane showed the empty state while the document pane was full. (Later, a snapshot replay restored
a *different* session's messages — see issue 1. Transcript restore is inconsistent in both
directions.)

## Observations / polish (not necessarily bugs)

### 14. Board column widths inconsistent between modes
ALL view (swimlane) stretches columns across the window; per-type view packs fixed ~192px columns
left with ~40% dead space at 1440px.

### 15. Card panel dead space
The pipeline-checklist aside is a narrow box top-right of a wide mostly-empty column; the main
column is also capped narrow — on a 1440px window roughly half the panel is empty.

### 16. Plan document renders raw plan XML
`<plan> <goal> <task key="…">` shown literally. If intentional (source view), label it "source";
otherwise format it.

### 17. Checklist vs custom pipeline step naming mismatch
While a custom pipeline ran (step id `impl`), the run box showed `impl` but the type checklist
highlighted `implement · running` — two different names for the same thing in one panel.

### 18. Tab order on the board starts at the column "auto" chips
First Tab lands on the CODING `auto · on` chip, not the top bar / left rail (they come later in
DOM order). Focus rings themselves are visible and clear (good).

### 19. Project directory linking is near-invisible
The only way to set a project directory (required for runs) is a 12px folder icon on each project
tab (title "link directory"). Given issue 2's silent failure, the fix path is undiscoverable.

### 20. Settings is a placeholder
"planner model settings land in step 6" — fine for the milestone, just noting it's empty.

---

## Sub-12px inventory (rule: nothing in the UI should render under 12px)

Audit of all `.scss` files, icon `[size]` bindings, and computed styles in the live DOM.

### A. Font sizes under 12px — 27 occurrences

**9px (1) — worst offender**
- `board-card.component.scss:179` — `.run-chip` (the pipeline-run chip on every working card)

**10px (7)**
- `board-card` none — but card panel:
- `card-panel.component.scss:391` — `.run-status` (step status in the run box)
- `pipeline-editor.component.scss:168` — `.mini` buttons (edit / delete / move up / move down)
- `pipeline-editor.component.scss:275` — `.retries` input
- `coding-view.component.scss:75` — session id column
- `coding-view.component.scss:88` — `composer-<kind>` column
- `coding-view.component.scss:106` — session status chip ("running"/"ended"/"failed")
- `coding-view.component.scss:122` — `.error` text (media/hover variant)

**11px (19)**
- `card-panel.component.scss:374, 401, 417, 425, 460, 474` — run box detail, gate label, gate
  comment input, approve/reject buttons, run-stop, session icon row
- `pipeline-editor.component.scss:34, 58, 65, 110, 120, 130, 146, 203, 214, 228, 280` — new-pipeline
  button, name label, hint, step index, step fields (agent kind / command / retries), add-step,
  save/cancel, rejection text
- `coding-view.component.scss:44` — header label, `:118` — attach hint
- `type-selector` chips: 14px text is fine, but see icons below
- `pipeline-editor.component.scss:273` — `.row-id` (pipeline id in the list) — **10px, confirmed
  in live DOM**; `:278` — `.row-steps` (step summary) — 11px

### B. Icon sizes under 12px — 13 lucide bindings + 1 inline svg

`[size]="10"` (6): board-card lock / run / session icons (board-card.component.html:19,29,55),
card-panel stop + run + session icons (card-panel.component.html:88,127,151)

`[size]="11"` (7): type-selector option icons (type-selector.component.html:12), card-panel type
option icons (:26), pipeline-editor move-up/move-down/remove icons (:52,55,58) and list delete
(:150), coding-view attach hint icon (:27)

Inline svg: topbar tab folder icon is 12×12 exactly (at the limit, see hit targets below).

### C. Click targets far too small

- **Topbar tab close `×`: 8×14px** (topbar.component.html:28-34, `role="button"`) — the control
  that closes a project tab is 8px wide and invisible until hover.
- **Topbar tab directory icon: 12×12px** (topbar.component.html:17-27, `role="button"`) — the
  *only* way to link a project directory (required for pipeline runs, see issue 2/19) is a 12×12
  hit area.
- **Pipeline editor `.mini` buttons: 19px tall, 10px text** (pipeline-editor.component.scss:159,
  confirmed live) — move up / move down / remove step, the most error-prone actions in the form;
  same `.mini` class renders the list row's edit/delete at 19px tall.
- Status-strip agent dots are 6×6px (status-strip.component.scss:25) — decorative, but they pulse
  like live indicators (see issue 6), so they read as UI, not decoration.

### Recommendation
Enforce a 12px floor: bump all 9/10/11px font sizes to 12px (this affects ~27 declarations across
5 components — a mechanical pass), raise all lucide `[size]` bindings to ≥12, and give the topbar
close/directory controls a padded hit area (≥20×20px, e.g. padding around the existing glyph).
A lint rule (stylelint `declaration-property-value-allowed-list` for `font-size` + a review check
for `[size]`) would keep the floor enforced.
