# P3 State Matrix — Scenario Curation Stage

**Feature:** F27 QA Testing
**Stage:** S05 (C06-S05) — Scenario Curation
**Author:** Pixel (Frontend)
**Priority:** P0 — Core user interaction for scenario management
**Ref:** C02-S03 (User Curation Flow), C06-S05 (Frontend Panel), SignalR `QaSubmitCuratedScenarios`

---

## Overview

The curation stage is the human-in-the-loop safety net. AI generates scenarios
with confidence scores; users curate (approve/edit/reject) before execution.
Default posture is "approve all" — generated scenarios are pre-approved and users
only intervene when something looks wrong. This keeps friction low while
maintaining human oversight.

**Lifecycle:** `generated --APPROVE--> curated --SUBMIT--> queued`

**Data model (frontend state):**

```
{
  scenarios:      Scenario[],      // from S02 generation
  zones:          ImpactZone[],    // from QA.AnalysisComplete
  approved:       Set<string>,     // scenario IDs (all approved by default)
  rejected:       Set<string>,     // scenario IDs
  selectedIds:    Set<string>,     // multi-select for batch ops
  sortOrder:      string[],        // scenario IDs in execution order
  filterCategory: string | null,   // active category filter
  editingId:      string | null,   // scenario being edited inline
  isDirty:        boolean,         // unsaved edits present
  focusIndex:     number           // keyboard focus position
}
```

**Categories:** `happy_path`, `error_path`, `edge_case`, `regression`, `performance`

---

## Scenario Card Layout (ASCII Wireframe)

```
+-----------------------------------------------------------------------+
|  S3 META BAR                                                          |
|  "3 impact zones > 8 scenarios > 22 expectations"                     |
|                                [Approve All]  [Run Approved 8]        |
+-----------------------------------------------------------------------+
|  [!] Coverage gap: 2 code paths not observable via interceptors       |
+-----------------------------------------------------------------------+
|  FILTER: [All] [Happy] [Error] [Edge] [Regression] [Performance]     |
+-----------------------------------------------------------------------+
|                                                                       |
|  --- ZONE: FileOperations (zone-001) --- 3 scenarios ---------- [v]  |
|                                                                       |
|  +-------------------------------------------------------------------+|
|  | [x]  WriteFileAsync writes correct path  HAPPY  P1  4exp  ~15s   ||
|  |      [fileop] [http]                              [ EDIT ] [ X ]  ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  +-------------------------------------------------------------------+|
|  | [x]  WriteFileAsync handles null path    ERROR  P2  2exp  ~10s   ||
|  |      [fileop]                                     [ EDIT ] [ X ]  ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  +-------------------------------------------------------------------+|
|  | [x]  Concurrent writes race condition   EDGE   P3  3exp  ~20s   ||
|  |      [fileop] [concurrency]                       [ EDIT ] [ X ]  ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  --- ZONE: HttpPipeline (zone-002) --- 2 scenarios ------------ [v]  |
|  ...                                                                  |
+-----------------------------------------------------------------------+
|  SUMMARY: 8 approved / 0 rejected / 0 pending                        |
|                              [Run Approved 8 -->]                     |
+-----------------------------------------------------------------------+
```

**Card row structure (single scenario):**

```
+----------------------------------------------------------------------+
| [ ] | Title text up to 120 chars          | CAT  | Pn | Ne | ~Ts   |
|     | [topic1] [topic2] ...               |      |    |    |       |
|     | Confidence: ||||||||-- 0.85          |      |    | [EDIT][X] |
+----------------------------------------------------------------------+
   ^      ^                                    ^     ^    ^     ^
   |      |                                    |     |    |     |
   |      sc-name                           sc-cat  pri  exp  actions
   |
   sc-check (checkbox: approve/unapprove)

Legend:
  [ ]  = unapproved     [x] = approved     [~] = edited
  CAT  = HAPPY | ERROR | EDGE | REGR | PERF
  Pn   = P1..P5 priority
  Ne   = expectation count (e.g. "4 exp")
  ~Ts  = estimated duration (e.g. "~15s")
```

---

## Inline Edit Modal (ASCII Wireframe)

```
+----------------------------------------------------------------------+
| [x]  WriteFileAsync writes correct path  HAPPY  P1  4exp  ~15s     |
|      [fileop] [http]                              [ SAVE ] [ X ]    |
+----------------------------------------------------------------------+
| INLINE EDITOR                                                        |
| +------------------------------------------------------------------+ |
| | TITLE   [WriteFileAsync writes to correct OneLake path_______]   | |
| | DESC    [Verifies that the file write targets the expected____]  | |
| |         [OneLake table path structure________________________]   | |
| |                                                                  | |
| | CATEGORY  (o) Happy  ( ) Error  ( ) Edge  ( ) Regr  ( ) Perf    | |
| | PRIORITY  [P1 v]                                                 | |
| |                                                                  | |
| | --- STIMULUS ---                                                 | |
| | Type: dag_trigger                                                | |
| | Params:                                                          | |
| |   iterationId: [current___________]                              | |
| |   nodeFilter:  [MaterializeNode_Table1______]                    | |
| |                                                                  | |
| | --- EXPECTATIONS (4) ---                                         | |
| | +--------------------------------------------------------------+ | |
| | | exp-1  event_present  fileop                                 | | |
| | |   matcher.exact.operation: [WriteFile___]                    | | |
| | |   matcher.contains.path:   [/Tables/Table1/___]              | | |
| | |   timeWindow.withinMs:     [15000]                           | | |
| | |   description: [File write to OneLake at correct path___]    | | |
| | +--------------------------------------------------------------+ | |
| | | exp-2  event_present  http                                   | | |
| | |   ...                                                        | | |
| | +--------------------------------------------------------------+ | |
| | [+ Add Expectation]                                              | |
| |                                                                  | |
| | --- SETUP STEPS (0) ---                                          | |
| | [+ Add Setup Step]                                               | |
| |                                                                  | |
| | --- TEARDOWN STEPS (0) ---                                       | |
| | [+ Add Teardown Step]                                            | |
| |                                                                  | |
| | TIMEOUT  [20000] ms  (1000-60000)                                | |
| |                                                                  | |
| | READ-ONLY: id=scn-write-file-correct-path  generatedBy=ai       | |
| |            generatedAt=2025-07-14T14:30:22Z  confidence=0.92     | |
| +------------------------------------------------------------------+ |
| VALIDATION: [OK] All fields valid                                    |
|                                              [ Cancel ] [ Save ]     |
+----------------------------------------------------------------------+
```

---

## State Definitions

### 1. `curation.loading`

| Field | Value |
|---|---|
| **State** | `curation.loading` |
| **Entry conditions** | Analysis stage (S04) emits `QA.AnalysisComplete` with impact zones. Backend begins streaming scenarios via `ScenarioGenerated` SignalR events. |
| **Exit conditions** | All scenarios received (backend sends `QA.GenerationComplete`), OR timeout after 30s, OR error. |
| **Visual description** | Stage 3 container visible. Meta bar shows "Generating scenarios..." with animated dots. Skeleton card rows (3 pulse-shimmer placeholders) in the zone container. Zone headers not yet rendered. "Approve All" and "Run Approved" buttons disabled (opacity 0.4, `pointer-events: none`). Progress text: "N scenarios generated..." updates as each `ScenarioGenerated` event arrives. |
| **Keyboard shortcuts** | None active. Focus trapped on stage header. `Escape` — cancel generation (confirmation dialog). |
| **Data requirements** | `zones[]` from analysis, `correlationId`, `analysisId`. Scenarios array starts empty, grows with each `ScenarioGenerated` event. |
| **Transitions** | `curation.list` — on `QA.GenerationComplete` with >= 1 scenario. `curation.empty` — on `QA.GenerationComplete` with 0 scenarios. `curation.error` — on generation timeout or SignalR error. |
| **Error recovery** | SignalR disconnect: show reconnecting banner, retry 3x with exponential backoff. Timeout: show "Generation timed out. N scenarios received so far. [Use Partial Results] [Retry]". Partial results transition to `curation.list` with available scenarios. |

---

### 2. `curation.empty`

| Field | Value |
|---|---|
| **State** | `curation.empty` |
| **Entry conditions** | `QA.GenerationComplete` received with 0 scenarios. |
| **Exit conditions** | User clicks "Create Manual Scenario" or "Re-generate". |
| **Visual description** | Empty state card centered in zone container. Icon: outlined document with question mark (inline SVG). Title: "No scenarios generated". Body: "The changed code may not be observable through interceptors. You can create manual scenarios or adjust analysis settings and re-generate." Two buttons: `[Create Manual Scenario]` (primary), `[Re-generate]` (ghost). Meta bar: "0 impact zones, 0 scenarios". Both top-bar action buttons hidden. |
| **Keyboard shortcuts** | `M` — focus "Create Manual Scenario" button. `R` — focus "Re-generate" button. `Enter` on focused button — activate. |
| **Data requirements** | `analysisId` for re-generation. Template registry for manual creation (S10). |
| **Transitions** | `curation.editing` — on "Create Manual Scenario" (opens editor with blank template). `curation.loading` — on "Re-generate" (re-invokes S02 pipeline). Previous stage — on `Backspace` / back navigation (with confirmation). |
| **Error recovery** | Re-generation failure: toast "Re-generation failed: {reason}. [Retry]". Template load failure: toast "Could not load scenario templates. [Retry]". |

---

### 3. `curation.list`

| Field | Value |
|---|---|
| **State** | `curation.list` |
| **Entry conditions** | Scenarios loaded successfully (>= 1). All scenarios auto-approved on initial render. Zones rendered with scenario cards. |
| **Exit conditions** | User opens editor, enters filter mode, enters bulk select, or transitions to execution. |
| **Visual description** | Full curation layout rendered. Meta bar: "N impact zones, M scenarios, K expectations". Zone groups with collapsible headers. Each scenario card shows: approval checkbox (checked by default), title, category badge (color-coded: happy=green, error=red, edge=amber, regression=blue, performance=purple), priority pill, expectation count, estimated duration, topic pills, and action buttons (edit, remove). Confidence bar below title (thin horizontal fill, color shifts from red < 0.5 to amber < 0.8 to green >= 0.8). "Approve All" button active. "Run Approved N" shows count. Coverage gap warning visible if applicable. Bottom summary bar: "N approved / M rejected / K pending". |
| **Keyboard shortcuts** | `J` / `ArrowDown` — move focus to next card. `K` / `ArrowUp` — move focus to previous card. `Space` — toggle approve on focused card. `X` — reject focused card. `E` — edit focused card. `Enter` — expand/collapse focused card details. `A` — approve all. `F` — open filter bar. `/` — focus filter search. `Ctrl+Enter` — submit (run approved). `Tab` — cycle through interactive elements within focused card. `H` / `L` — collapse/expand zone group. |
| **Data requirements** | `scenarios[]` with full schema data. `zones[]` with zone metadata. Approved set (default: all IDs). Rejected set (default: empty). Sort order (default: zone grouping, priority within zone). |
| **Transitions** | `curation.card.focused` — on keyboard navigation to first card (auto-enters on list render). `curation.list.filtered` — on filter activation. `curation.bulk.selecting` — on `Ctrl+Click` or `Shift+Click`. `curation.editing` — on edit action. `curation.card.approving` — on approve toggle. `curation.card.rejecting` — on reject action. `curation.ready` — when all scenarios reviewed and user initiates run. `curation.submitting` — on "Run Approved" click. |
| **Error recovery** | Stale data: if scenarios modified server-side (unlikely in V1), SignalR push updates local state. DOM rendering failure: catch in `renderZones()`, show "Failed to render scenario list. [Retry]" with full state reset. |

---

### 4. `curation.list.filtered`

| Field | Value |
|---|---|
| **State** | `curation.list.filtered` |
| **Entry conditions** | User selects a category filter pill or types in search. |
| **Exit conditions** | User clears filter or selects "All". |
| **Visual description** | Filter bar highlighted with active filter indicated. Active filter pill has filled background (e.g., green fill for "Happy"). Non-matching cards hidden with `display: none` (not removed from DOM — preserves approved/rejected state). Zone headers hidden if all their scenarios are filtered out. Meta bar updates to show filtered count: "Showing N of M scenarios (filter: happy_path)". "Approve All" scopes to visible scenarios only. Empty filter result: centered message "No scenarios match filter '{category}'." with `[Clear Filter]` button. |
| **Keyboard shortcuts** | All `curation.list` shortcuts remain active and operate on visible cards only. `Escape` — clear filter, return to `curation.list`. `1`-`5` — quick filter by category (1=happy, 2=error, 3=edge, 4=regression, 5=performance). `0` — clear filter (show all). |
| **Data requirements** | Active `filterCategory` string. Original unfiltered `scenarios[]` preserved. Filtered view is computed, not stored. |
| **Transitions** | `curation.list` — on filter clear. All card-level transitions (focused, editing, approving, rejecting) remain available for visible cards. `curation.bulk.selecting` — if batch action initiated on filtered set. |
| **Error recovery** | Invalid filter value (programmatic): silently reset to "All". Filter persistence: filter state survives zone collapse/expand. |

---

### 5. `curation.card.focused`

| Field | Value |
|---|---|
| **State** | `curation.card.focused` |
| **Entry conditions** | Keyboard navigation (`J`/`K`/`ArrowDown`/`ArrowUp`) moves `focusIndex`, or mouse click on a card row. |
| **Exit conditions** | Focus moves to another card, editor opens, or focus leaves card list. |
| **Visual description** | Focused card has 2px left border accent (var(--accent-blue)), subtle background highlight (`rgba(var(--accent-blue-rgb), 0.06)`). Focus ring visible on the card container (`outline: 2px solid var(--focus-ring)`). Card action buttons become visible (normally opacity 0 on non-hover cards, forced visible on focus). Screen reader announces: card title, category, approval status, priority. |
| **Keyboard shortcuts** | `Space` — toggle approve. `X` — reject. `E` — open editor. `Enter` — expand/collapse card details. `D` — duplicate/clone scenario. `Tab` — move focus into card action buttons. `Shift+Tab` — move focus back to card container. `Ctrl+Space` — toggle selection for bulk mode. |
| **Data requirements** | `focusIndex` into visible scenario list. Card DOM element reference for scroll-into-view. |
| **Transitions** | `curation.card.expanded` — on `Enter`. `curation.card.approving` — on `Space`. `curation.card.rejecting` — on `X`. `curation.editing` — on `E`. `curation.bulk.selecting` — on `Ctrl+Space`. Another `curation.card.focused` — on `J`/`K` (index changes). |
| **Error recovery** | Focus index out of bounds: clamp to [0, visibleCount - 1]. Focus on rejected card: skip to next non-rejected card. Empty list after filtering: focus returns to filter bar. |

---

### 6. `curation.card.expanded`

| Field | Value |
|---|---|
| **State** | `curation.card.expanded` |
| **Entry conditions** | User presses `Enter` on focused card or clicks card title. |
| **Exit conditions** | User presses `Enter` again (collapse), presses `Escape`, or navigates to another card. |
| **Visual description** | Card row expands with slide-down animation (200ms ease-out). Expanded section shows: full description text, stimulus details (type + params), expectations list (id, type, topic, matcher summary, time window), setup/teardown step count, confidence score with numeric value, metadata (generatedBy, generatedAt, tags). Expansion area has slightly darker background (`var(--surface-sunken)`). Other cards remain in place (expanded card pushes them down). Expand/collapse icon rotates: `>` to `v` (90deg rotation, 150ms). |
| **Keyboard shortcuts** | All `curation.card.focused` shortcuts remain active. `Enter` — collapse back. `Escape` — collapse and keep focus. `E` — open inline editor (from expanded view, editor replaces expansion). `Tab` — cycle through expandable detail sections (stimulus, expectations, setup, teardown). |
| **Data requirements** | Full scenario object for the focused card (all fields including nested expectations, stimulus, setup, teardown). |
| **Transitions** | `curation.card.focused` — on collapse (`Enter` or `Escape`). `curation.editing` — on `E` (editor replaces expansion content). `curation.card.approving` — on `Space` (while expanded). `curation.card.rejecting` — on `X` (while expanded, animates collapse then rejection). |
| **Error recovery** | Missing scenario details (partial data): show available fields, gray placeholder for missing. "Details unavailable" for corrupted nested objects. |

---

### 7. `curation.card.approving`

| Field | Value |
|---|---|
| **State** | `curation.card.approving` |
| **Entry conditions** | User toggles approval checkbox (Space on focused card, click on checkbox, or "Approve All"). |
| **Exit conditions** | Animation completes (300ms). |
| **Visual description** | **Approving (check on):** Checkbox fills with accent color, checkmark draws in with SVG stroke animation (200ms). Card left-border transitions to green (`var(--status-pass)`). Brief green pulse on card background (opacity 0 to 0.08 to 0, 300ms). **Unapproving (check off):** Checkbox drains color, checkmark fades out (150ms). Card left-border returns to neutral. Approved count in "Run Approved N" button increments/decrements with number roll animation. |
| **Keyboard shortcuts** | None specific — animation is non-blocking. All parent state shortcuts remain active. |
| **Data requirements** | `scenarioId` to add/remove from `approved` Set. Previous approval state for toggle direction. |
| **Transitions** | `curation.card.focused` — after animation completes (focus remains on same card). `curation.list` — if triggered by "Approve All" (no single card focused). `curation.ready` — if this was the last unreviewed scenario. |
| **Error recovery** | Approve on rejected card: no-op (rejected cards have `pointer-events: none` on checkbox). Rapid toggle: debounce 100ms, use final state. |

---

### 8. `curation.card.rejecting`

| Field | Value |
|---|---|
| **State** | `curation.card.rejecting` |
| **Entry conditions** | User clicks remove button or presses `X` on focused card. |
| **Exit conditions** | Rejection animation completes (400ms) and undo window passes (5s) or user dismisses. |
| **Visual description** | Card animates: opacity 1.0 to 0.3, `transform: scale(0.97)`, `filter: grayscale(0.6)`, 300ms ease-out. Card height collapses to 0 with overflow hidden (200ms, after opacity). Gap closes smoothly. `pointer-events: none` applied immediately. Undo toast appears bottom-right: "Scenario removed. [Undo]" with 5s countdown bar. Toast auto-dismisses after 5s. If undone: card restores with reverse animation (opacity 0.3 to 1.0, scale back, filter removed). Approved count decrements. Focus moves to next card (or previous if last in list). |
| **Keyboard shortcuts** | `Ctrl+Z` — undo rejection (within 5s window). Focus is on the undo toast button during countdown. `Escape` — dismiss toast, confirm rejection. |
| **Data requirements** | `scenarioId` to add to `rejected` Set and remove from `approved` Set. Original scenario data preserved for undo. Undo timer ID for cleanup. |
| **Transitions** | `curation.card.focused` — focus moves to next card after animation. `curation.card.focused` (same card) — if undo triggered, card restores and regains focus. `curation.empty` — if this was the last scenario (all rejected). `curation.ready` — if all remaining scenarios are approved. |
| **Error recovery** | Undo after timeout: silent no-op (card already removed from DOM). Reject during edit: close editor first, then reject (confirmation dialog: "Discard edits and remove scenario?"). Multiple rapid rejections: each gets its own undo toast, stacked vertically (max 3 visible, oldest auto-dismissed). |

---

### 9. `curation.editing`

| Field | Value |
|---|---|
| **State** | `curation.editing` |
| **Entry conditions** | User clicks edit button or presses `E` on focused/expanded card. Only one editor open at a time — opening a new editor auto-closes the previous one (with save prompt if dirty). |
| **Exit conditions** | User saves, cancels, or closes editor. |
| **Visual description** | Inline editor slides open below the card row (300ms slide-down). Card row itself remains visible above, with edit button replaced by save/cancel. Editor shows structured fields (not raw JSON): title input, description textarea, category radio group, priority dropdown, stimulus section, expectations list, setup/teardown steps, timeout input. Read-only fields displayed but grayed: `id`, `generatedBy`, `generatedAt`, `confidence`. Validation status line at bottom: green checkmark "All fields valid" or red indicator with error list. Background overlay on rest of card list (opacity 0.3) to draw attention to editor. |
| **Keyboard shortcuts** | `Ctrl+S` — save changes. `Escape` — cancel (if dirty: "Discard changes?" confirmation). `Tab` — cycle through editor fields. `Ctrl+E` — toggle between stimulus and expectations sections. |
| **Data requirements** | Full scenario object (deep clone for editing — original preserved for cancel/undo). Schema from C02-S01 for validation. `editingId` set to current scenario ID. `isDirty` flag tracks modifications. |
| **Transitions** | `curation.editing.stimulus` — when focus enters stimulus section. `curation.editing.expectations` — when focus enters expectations section. `curation.card.focused` — on save (success) or cancel. `curation.editing.validationError` — on save attempt with invalid data. |
| **Error recovery** | Validation failure on save: highlight invalid fields with red border, show per-field error messages, block save. Editor state preserved across SignalR reconnect (edits are local-first). Accidental close (browser navigate): `beforeunload` warning if dirty. |

---

### 10. `curation.editing.stimulus`

| Field | Value |
|---|---|
| **State** | `curation.editing.stimulus` |
| **Entry conditions** | Focus enters stimulus section of inline editor, or user clicks stimulus section header. |
| **Exit conditions** | Focus leaves stimulus section, or editor closes. |
| **Visual description** | Stimulus section expanded with highlighted border. Fields shown based on stimulus type: **http_request** — method dropdown, path input, headers key-value editor, body textarea. **signalr_invoke** — hub method dropdown, arguments JSON editor. **dag_trigger** — iterationId input, nodeFilter multi-select. **file_event** — path input, operation dropdown. **timer_tick** — intervalMs input. Type selector is a dropdown; changing type clears type-specific fields with confirmation. Section header: "STIMULUS" with type badge. |
| **Keyboard shortcuts** | `Tab` — cycle through stimulus fields. `Ctrl+E` — jump to expectations section. `Escape` — collapse stimulus section (if other sections exist) or exit editor. |
| **Data requirements** | `stimulus` object from scenario. Enum values for stimulus types (`http_request`, `signalr_invoke`, `dag_trigger`, `file_event`, `timer_tick`). Validation rules: type-payload match (S04 Tier 2). |
| **Transitions** | `curation.editing.expectations` — on `Ctrl+E` or Tab past last stimulus field. `curation.editing` — on section collapse. `curation.card.focused` — on editor save/cancel. |
| **Error recovery** | Invalid stimulus type (corrupted data): reset to `http_request` with empty fields, show warning. Type change with filled fields: "Changing stimulus type will clear current parameters. [Continue] [Cancel]". |

---

### 11. `curation.editing.expectations`

| Field | Value |
|---|---|
| **State** | `curation.editing.expectations` |
| **Entry conditions** | Focus enters expectations section, or user clicks expectations section header. |
| **Exit conditions** | Focus leaves expectations section, or editor closes. |
| **Visual description** | Expectations rendered as a vertical list of mini-cards within the editor. Each expectation card shows: id (read-only), type dropdown (`event_present`, `event_absent`, `event_count`, `event_order`, `timing`, `field_match`), topic dropdown (16 registered topics), matcher fields (dynamic based on type), time window inputs, description text input. Cards are reorderable via drag handles or `Alt+ArrowUp` / `Alt+ArrowDown`. "[+ Add Expectation]" button at bottom. Delete button (X) on each card (min 1 enforced — last one shows disabled delete). Expectation count badge updates in real-time. |
| **Keyboard shortcuts** | `Tab` — cycle through fields within current expectation. `Alt+ArrowDown` / `Alt+ArrowUp` — reorder expectation. `Ctrl+N` — add new expectation. `Delete` — remove focused expectation (with confirmation if > 1). `Ctrl+E` — jump back to stimulus section. |
| **Data requirements** | `expectations[]` array. Topic enum (16 registered topics from `EdogTopicRouter.Initialize()`). Expectation type enum. Validation: unique IDs within scenario, acyclic order references, satisfiable time windows. |
| **Transitions** | `curation.editing.stimulus` — on `Ctrl+E`. `curation.editing` — on section collapse. `curation.card.focused` — on editor save/cancel. `curation.editing.validationError` — on validation failure (e.g., duplicate expectation IDs, cyclic order). |
| **Error recovery** | Delete last expectation blocked: button disabled, tooltip "At least one expectation required". Invalid topic (not in enum): dropdown rejects, shows "Topic not registered". Duplicate expectation ID: auto-generated unique ID on add, warn if user manually edits to duplicate. Cyclic order detected: highlight cycle participants in red, show "Circular dependency detected between exp-N and exp-M". |

---

### 12. `curation.editing.validationError`

| Field | Value |
|---|---|
| **State** | `curation.editing.validationError` |
| **Entry conditions** | User attempts to save with validation errors (structural, semantic, or both). |
| **Exit conditions** | User fixes all errors, or cancels edit. |
| **Visual description** | Validation status line turns red: "N validation errors — fix before saving". Error list appears below status line with per-field errors: field path, rule violated, current value. Invalid fields highlighted with red border and inline error text. Save button disabled (opacity 0.4). First invalid field auto-scrolled into view and focused. Error count badge pulses once (scale 1.0 to 1.1 to 1.0, 200ms). |
| **Keyboard shortcuts** | `Ctrl+.` — jump to next error field. `Ctrl+,` — jump to previous error field. All editor shortcuts remain active. |
| **Data requirements** | Validation result from schema check (C02-S04 Tier 1 + Tier 2). Error array: `[{ field, rule, message, value }]`. |
| **Transitions** | `curation.editing` — when all errors resolved (real-time validation clears errors as fields are fixed). `curation.editing.stimulus` / `curation.editing.expectations` — focus can still move between sections. `curation.card.focused` — on cancel. |
| **Error recovery** | Validation engine error: fall back to save with server-side validation (show warning: "Client validation unavailable. Server will validate on submission."). |

---

### 13. `curation.bulk.selecting`

| Field | Value |
|---|---|
| **State** | `curation.bulk.selecting` |
| **Entry conditions** | User `Ctrl+Click` on a card, `Shift+Click` for range, or activates multi-select mode via toolbar button. |
| **Exit conditions** | User clears selection, executes bulk action, or presses `Escape`. |
| **Visual description** | Selection mode banner appears above card list: "N scenarios selected — [Approve Selected] [Reject Selected] [Clear Selection]". Selected cards have blue left border and checked selection indicator (distinct from approve checkbox). `Shift+Click` selects range between last click and current. `Ctrl+Click` toggles individual selection. Selection count updates in real-time. Non-selected cards slightly dimmed (opacity 0.7). Drag-to-select supported (mousedown + drag draws selection rectangle). |
| **Keyboard shortcuts** | `Ctrl+A` — select all visible scenarios. `Ctrl+Space` — toggle selection on focused card. `Shift+J` / `Shift+K` — extend selection down/up. `Escape` — clear selection, return to `curation.list`. `Enter` — open bulk action menu. `Ctrl+Shift+A` — approve selected. `Ctrl+Shift+X` — reject selected. |
| **Data requirements** | `selectedIds` Set. Selection anchor (for Shift+Click range). Visible scenario list (respects active filter). |
| **Transitions** | `curation.bulk.confirming` — on bulk action button click. `curation.list` — on `Escape` or "Clear Selection". `curation.card.focused` — on single click without modifier (clears selection). |
| **Error recovery** | Select on rejected cards: silently skip. Select all with filter active: selects only visible cards (toast: "Selected N of M scenarios (filtered view)"). Empty selection + bulk action: buttons disabled. |

---

### 14. `curation.bulk.confirming`

| Field | Value |
|---|---|
| **State** | `curation.bulk.confirming` |
| **Entry conditions** | User triggers bulk action (approve/reject) on selected scenarios. |
| **Exit conditions** | User confirms or cancels. |
| **Visual description** | Confirmation dialog overlay (not a browser `confirm()` — custom modal). Title: "Confirm Bulk Action". Body varies: **Approve N:** "Approve N selected scenarios for execution?" **Reject N:** "Reject N selected scenarios? This will remove them from the run." [Undo available for 5s after each]. Scenario count and category breakdown shown: "3 happy_path, 2 error_path, 1 edge_case". Two buttons: `[Cancel]` (ghost), `[Confirm]` (primary, red for reject, green for approve). Dialog traps focus. Background dimmed. |
| **Keyboard shortcuts** | `Enter` — confirm. `Escape` — cancel. `Tab` — cycle between Cancel and Confirm buttons. |
| **Data requirements** | `selectedIds` Set. Action type (approve or reject). Category breakdown of selected scenarios. |
| **Transitions** | `curation.list` — on confirm (bulk action applied, selection cleared). `curation.bulk.selecting` — on cancel (selection preserved). `curation.card.rejecting` — bulk reject triggers sequential rejection animations (staggered 50ms apart). `curation.ready` — if bulk approve completes the review. |
| **Error recovery** | Confirm with 0 selections (race condition): no-op, close dialog. Confirm reject all: extra warning "This will remove all scenarios. Are you sure?" with distinct red styling. |

---

### 15. `curation.ready`

| Field | Value |
|---|---|
| **State** | `curation.ready` |
| **Entry conditions** | All scenarios have been reviewed (approved or rejected). At least 1 approved scenario exists. |
| **Exit conditions** | User clicks "Run Approved" or continues editing. |
| **Visual description** | Bottom summary bar transitions to "ready" state: green accent border, summary text: "Ready to execute: N scenarios, K expectations, ~Ts estimated". "Run Approved N" button pulses with subtle glow animation (box-shadow pulse, 2s infinite). Confetti-free — professional. A mini-preview appears in the summary: approved scenario titles as a compact comma-separated list (max 3 shown, "+N more" for rest). If rejected scenarios exist, secondary text: "M scenarios excluded". |
| **Keyboard shortcuts** | `Ctrl+Enter` — submit curated scenarios (proceed to execution). `E` on any card — still allows editing (exits ready state if changes made). `Escape` — no-op (already at rest state). |
| **Data requirements** | Approved set with >= 1 entry. All scenarios either in `approved` or `rejected` set (none pending). Computed: total expectation count, estimated total duration. |
| **Transitions** | `curation.submitting` — on "Run Approved" / `Ctrl+Enter`. `curation.list` — if user edits a scenario (returns to non-ready). `curation.card.focused` — on keyboard navigation to a card. |
| **Error recovery** | Ready state with 0 approved (all rejected after entering ready): revert to `curation.list`, disable "Run Approved", show "No scenarios to execute." |

---

### 16. `curation.submitting`

| Field | Value |
|---|---|
| **State** | `curation.submitting` |
| **Entry conditions** | User confirms execution. Frontend calls `QaSubmitCuratedScenarios` via SignalR. |
| **Exit conditions** | Server responds with `QaSubmissionResult`. |
| **Visual description** | "Run Approved" button replaced with spinner + "Submitting...". All card interactions disabled (`pointer-events: none`, opacity 0.6). Meta bar: "Submitting N scenarios for execution...". No new edits allowed. Progress is indeterminate (server validation + disk persist < 200ms per SLA). |
| **Keyboard shortcuts** | None active. `Escape` — no-op (cannot cancel mid-submission). |
| **Data requirements** | `QaScenarioSubmission` payload: `{ correlationId, analysisId, scenarios: approvedScenarios[] }`. Scenarios are the curated versions (with any user edits applied). |
| **Transitions** | Execution stage (S06) — on `success: true` response with `runId`. `curation.submitting.error` — on `success: false` (validation errors, duplicate IDs, etc.). `curation.submitting.error` — on SignalR timeout (10s). |
| **Error recovery** | **Validation errors from server:** Transition to `curation.submitting.error` with per-scenario error details. User can fix and retry. **Network error:** Toast "Submission failed: connection lost. [Retry]". Return to `curation.ready` with data preserved. **Timeout:** Toast "Submission timed out. [Retry]". Return to `curation.ready`. **Server error (500):** Toast "Server error during submission. [Retry]". Return to `curation.ready`. Retry uses same payload (idempotent — server deduplicates by `correlationId`). |

---

### 17. `curation.submitting.error`

| Field | Value |
|---|---|
| **State** | `curation.submitting.error` |
| **Entry conditions** | `QaSubmitCuratedScenarios` returns `success: false` with `validationErrors[]`. |
| **Exit conditions** | User fixes errors and resubmits, or navigates back to edit. |
| **Visual description** | Error banner at top of curation stage: red background, icon (inline SVG warning triangle). Title: "Submission failed — N scenarios have validation errors". Error list: per-scenario errors with scenario title, field path, and message. Affected scenario cards highlighted with red border. "Fix and Retry" button (primary). "Back to Editing" button (ghost). Card interactions re-enabled for affected scenarios only. |
| **Keyboard shortcuts** | `Ctrl+.` — jump to next error scenario. `Enter` — retry submission. `Escape` — dismiss error banner, return to `curation.list`. |
| **Data requirements** | `QaSubmissionResult.validationErrors[]`: `[{ scenarioId, field, message }]`. Map errors back to scenario cards for highlighting. |
| **Transitions** | `curation.editing` — on click of affected scenario (opens editor at error field). `curation.submitting` — on retry after fixes. `curation.list` — on "Back to Editing". |
| **Error recovery** | Error mapping failure (scenarioId not found): show generic error banner with raw server message. Stale error (scenario already fixed): clear error highlight on next validation pass. |

---

### 18. `curation.error`

| Field | Value |
|---|---|
| **State** | `curation.error` |
| **Entry conditions** | Fatal error during scenario generation, SignalR disconnect with no recovery, or corrupted scenario data. |
| **Exit conditions** | User retries or navigates back. |
| **Visual description** | Error state card centered in stage container. Icon: inline SVG warning circle. Title: "Something went wrong". Body: contextual error message (e.g., "Scenario generation failed: {reason}", "Lost connection to server", "Scenario data corrupted"). Two buttons: `[Retry]` (primary — re-triggers generation), `[Back to Analysis]` (ghost — returns to previous stage). Error details collapsible: technical message for copy-paste into bug reports. |
| **Keyboard shortcuts** | `R` — retry. `Escape` / `Backspace` — back to analysis stage. `C` — copy error details to clipboard. |
| **Data requirements** | Error object with `code`, `message`, `details`. Original `analysisId` for retry. |
| **Transitions** | `curation.loading` — on retry. Previous stage (S04) — on back navigation. |
| **Error recovery** | Retry loop protection: after 3 retries, disable retry button, show "Maximum retries reached. Please re-run analysis from the beginning." |

---

## Transition Diagram

```
                                 QA.AnalysisComplete
                                        |
                                        v
                              +-------------------+
                              | curation.loading  |
                              +-------------------+
                               /        |         \
                     0 scenarios   >= 1 scenarios   error/timeout
                             /          |            \
                            v           v             v
                  +----------------+ +---------------+ +----------------+
                  | curation.empty | | curation.list | | curation.error |
                  +----------------+ +---------------+ +----------------+
                     |        |        |   |   |   |          |    |
                 manual   re-gen    focus filter bulk edit   retry  back
                     |        |        |   |   |   |          |    |
                     v        v        v   |   |   |          v    v
              curation.   curation.  card  |   |   |      curation. S04
              editing     loading  focused |   |   |      loading
                                     |    |   |   |
                               +-----+    |   |   +----------+
                               |          |   |              |
                               v          v   v              v
                         card.expanded  list. bulk.      curation.
                               |       filter select     editing
                               |          |   |              |
                               |          |   v              +--------+
                               |          | bulk.            |        |
                               |          | confirming  editing.  editing.
                               |          |   |        stimulus  expectations
                               |          |   |              |        |
                               +----+-----+---+              +---+----+
                                    |                            |
                            +-------+-------+                    v
                            |               |           editing.
                            v               v          validationError
                     card.approving  card.rejecting
                            |               |
                            +-------+-------+
                                    |
                                    v
                          +------------------+
                          | curation.ready   |
                          +------------------+
                                    |
                              Run Approved
                                    |
                                    v
                        +----------------------+
                        | curation.submitting  |
                        +----------------------+
                              /           \
                         success         failure
                            /               \
                           v                 v
                     S06 Execution    curation.submitting.error
                       Stage               |
                                      fix + retry
                                           |
                                           v
                                  curation.submitting
```

---

## State Count Summary

| # | State | Category |
|---|-------|----------|
| 1 | `curation.loading` | Initialization |
| 2 | `curation.empty` | Empty state |
| 3 | `curation.list` | Primary browse |
| 4 | `curation.list.filtered` | Filtered browse |
| 5 | `curation.card.focused` | Card interaction |
| 6 | `curation.card.expanded` | Card interaction |
| 7 | `curation.card.approving` | Card action (animation) |
| 8 | `curation.card.rejecting` | Card action (animation) |
| 9 | `curation.editing` | Editor root |
| 10 | `curation.editing.stimulus` | Editor section |
| 11 | `curation.editing.expectations` | Editor section |
| 12 | `curation.editing.validationError` | Editor error |
| 13 | `curation.bulk.selecting` | Bulk operations |
| 14 | `curation.bulk.confirming` | Bulk operations |
| 15 | `curation.ready` | Pre-submission |
| 16 | `curation.submitting` | Submission |
| 17 | `curation.submitting.error` | Submission error |
| 18 | `curation.error` | Fatal error |

**Total: 18 states** (15 minimum met)

---

## Global Keyboard Shortcut Reference

| Key | Context | Action |
|-----|---------|--------|
| `J` / `ArrowDown` | List/filtered | Focus next card |
| `K` / `ArrowUp` | List/filtered | Focus previous card |
| `Space` | Card focused | Toggle approve |
| `X` | Card focused | Reject scenario |
| `E` | Card focused/expanded | Open inline editor |
| `Enter` | Card focused | Expand/collapse details |
| `D` | Card focused | Duplicate scenario |
| `A` | List | Approve all visible |
| `F` | List | Open filter bar |
| `/` | List | Focus filter search |
| `0`-`5` | Filtered | Quick category filter (0=all) |
| `H` / `L` | List | Collapse/expand zone |
| `Ctrl+A` | Bulk selecting | Select all visible |
| `Ctrl+Space` | Card focused | Toggle multi-select |
| `Shift+J/K` | Bulk selecting | Extend selection |
| `Ctrl+Shift+A` | Bulk selecting | Approve selected |
| `Ctrl+Shift+X` | Bulk selecting | Reject selected |
| `Ctrl+S` | Editing | Save changes |
| `Ctrl+Enter` | Ready/list | Submit for execution |
| `Ctrl+.` | Validation error | Jump to next error |
| `Ctrl+Z` | After rejection | Undo rejection (5s window) |
| `Ctrl+E` | Editing | Toggle stimulus/expectations |
| `Ctrl+N` | Editing expectations | Add new expectation |
| `Alt+Up/Down` | Editing expectations | Reorder expectation |
| `Escape` | Any | Context-dependent dismiss/back |
| `R` | Empty/error | Retry/re-generate |
| `M` | Empty | Create manual scenario |
| `C` | Error | Copy error details |

---

## Accessibility Notes

- All interactive elements have `aria-label` attributes.
- Card list uses `role="list"` / `role="listitem"` pattern.
- Approve checkbox uses `role="checkbox"` with `aria-checked` state.
- Category badges use `aria-label` for full category name (not abbreviation).
- Focus management: editor open traps focus within editor; editor close returns focus to originating card.
- Screen reader announcements via `aria-live="polite"` region for: approval count changes, rejection with undo, filter result count, validation errors, submission status.
- Reduced motion: all animations respect `prefers-reduced-motion: reduce` (instant state changes, no slide/pulse/sweep).
- Color is never the sole indicator — category badges include text labels, approval uses checkmark icon, confidence uses numeric value alongside bar.
