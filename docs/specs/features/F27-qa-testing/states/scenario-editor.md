# P3 State Matrix — Scenario Editor

> **Agent:** Pixel (Senior Frontend Engineer)
> **Feature:** F27 QA Testing
> **Component:** C06 Frontend Panel — Scenario Editor Modal
> **Priority:** P3
> **Date:** 2025-07-14
> **Depends On:** `C02-scenario-model-curation.md` (schema), `C06-frontend-panel.md` (panel arch), `signalr-protocol.md` (wire format)
> **States:** 19

---

## Table of Contents

1. [Editor Layout Wireframe](#editor-layout-wireframe)
2. [State Inventory](#state-inventory)
3. [State Definitions](#state-definitions)
4. [Transition Diagram](#transition-diagram)
5. [Focus Management](#focus-management)
6. [Keyboard Shortcut Summary](#keyboard-shortcut-summary)

---

## Editor Layout Wireframe

```
+===================================================================+
|  SCENARIO EDITOR                                    [JSON] [x]    |
+===================================================================+
|  [Metadata]  [Stimulus]  [Setup]  [Expectations]                  |
+-------------------------------------------------------------------+
|                                                                   |
|  Title  [________________________________]  120 char max          |
|                                                                   |
|  Category  [ happy_path       v ]    Priority  [ 2 v ]            |
|                                                                   |
|  Description                                                      |
|  +-------------------------------------------------------------+ |
|  |                                                             | |
|  |  (textarea, 500 char max)                                   | |
|  +-------------------------------------------------------------+ |
|                                                                   |
|  Impact Zone  zone-001             Timeout  [30000] ms            |
|                                                                   |
|  Tags  [ perf ] [ regression ] [ + Add ]                          |
|                                                                   |
+-------------------------------------------------------------------+
|  Validation: 0 errors, 0 warnings         [ Cancel ] [ Save ]    |
+===================================================================+
```

### Tab Section Layouts

**Stimulus Tab:**
```
+-------------------------------------------------------------------+
|  Stimulus Type  [ http_request    v ]                              |
|                                                                    |
|  --- HTTP Request Config ---                                       |
|  Method  [ GET  v ]    Path  [/api/v1/tables______]                |
|                                                                    |
|  Headers                                                           |
|  +-----------------------------------------------------------+    |
|  | Content-Type : application/json                    [x]    |    |
|  | Authorization : Bearer {token}                     [x]    |    |
|  +-----------------------------------------------------------+    |
|  [ + Add Header ]                                                  |
|                                                                    |
|  Body (JSON)                                                       |
|  +-----------------------------------------------------------+    |
|  | { "tableName": "Table1" }                                 |    |
|  +-----------------------------------------------------------+    |
+-------------------------------------------------------------------+
```

**Setup Steps Tab:**
```
+-------------------------------------------------------------------+
|  Setup Steps (2)                               [ + Add Step ]      |
|                                                                    |
|  +-----------------------------------------------------------+    |
|  | [=] 1. chaos_rule                                  [x]    |    |
|  |    Target: */api/onelake/*                                |    |
|  |    Fault: latency  Params: { "delayMs": 500 }            |    |
|  +-----------------------------------------------------------+    |
|  +-----------------------------------------------------------+    |
|  | [=] 2. flag_override                               [x]    |    |
|  |    Flag: enable_cache_bypass  Value: true                 |    |
|  +-----------------------------------------------------------+    |
|                                                                    |
|  [=] = drag handle    [x] = remove                                 |
+-------------------------------------------------------------------+
```

**Expectations Tab:**
```
+-------------------------------------------------------------------+
|  Expectations (2)                        [ + Add Expectation ]     |
|                                                                    |
|  +-----------------------------------------------------------+    |
|  | exp-1  event_present  topic:fileop             [Edit] [x] |    |
|  |   "File write to OneLake at correct path"                 |    |
|  +-----------------------------------------------------------+    |
|  +-----------------------------------------------------------+    |
|  | exp-2  event_absent   topic:log                [Edit] [x] |    |
|  |   "No error logs during write"                            |    |
|  +-----------------------------------------------------------+    |
|                                                                    |
+-------------------------------------------------------------------+
```

**JSON View:**
```
+-------------------------------------------------------------------+
|  Raw JSON                                        [ Copy ] [Back]   |
|  +-----------------------------------------------------------+    |
|  | {                                                         |    |
|  |   "id": "scn-write-file-correct-path-a1b2",              |    |
|  |   "title": "Write file to correct OneLake path",         |    |
|  |   "category": "happy_path",                              |    |
|  |   ...                                                     |    |
|  | }                                                         |    |
|  +-----------------------------------------------------------+    |
|  Validation: Valid JSON, schema OK                                 |
+-------------------------------------------------------------------+
```

---

## State Inventory

| # | State ID | Summary |
|---|----------|---------|
| 1 | `editor.closed` | Modal not visible, no scenario loaded |
| 2 | `editor.opening` | Modal animating in, scenario loading |
| 3 | `editor.metadata` | Editing name / category / description / tags |
| 4 | `editor.stimulus` | Configuring stimulus type + type-specific params |
| 5 | `editor.stimulus.type-select` | Stimulus type dropdown open |
| 6 | `editor.setup` | Managing setup steps list |
| 7 | `editor.setup.adding` | Inline form open for new setup step |
| 8 | `editor.setup.reordering` | Drag or keyboard reorder active |
| 9 | `editor.expectations` | Managing expectations list |
| 10 | `editor.expectations.adding` | Inline form for new expectation |
| 11 | `editor.expectations.matcher` | Editing matcher details for one expectation |
| 12 | `editor.json-view` | Raw JSON editor visible |
| 13 | `editor.json-view.editing` | User has modified JSON text directly |
| 14 | `editor.validating` | Running client-side validation pass |
| 15 | `editor.valid` | All fields pass — save enabled |
| 16 | `editor.invalid` | Validation errors displayed inline |
| 17 | `editor.saving` | Submitting scenario via SignalR |
| 18 | `editor.dirty` | Modifier flag — unsaved changes exist |
| 19 | `editor.confirm-discard` | Modal dialog warning about unsaved changes |

---

## State Definitions

### 1. `editor.closed`

| Field | Detail |
|-------|--------|
| **Entry conditions** | (a) Page load (default). (b) Save completes successfully. (c) User confirms discard. (d) Escape from clean editor. |
| **Exit conditions** | User clicks "Edit" on a scenario card in the curation list, or clicks "New Scenario". |
| **Visual description** | Modal overlay not rendered. Focus remains on the curation list. No DOM for the editor exists (removed on close, not hidden). |
| **Keyboard shortcuts** | `Enter` or `E` on focused scenario card opens editor. |
| **Data requirements** | None. Editor state is fully torn down. |
| **Transitions** | `editor.closed` -> `editor.opening` (on edit/new action). |
| **Error recovery** | N/A — quiescent state. |

---

### 2. `editor.opening`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User triggers edit on a scenario (existing or new). |
| **Exit conditions** | (a) Animation completes + scenario data loaded -> `editor.metadata`. (b) Load fails -> `editor.closed` with toast error. |
| **Visual description** | Modal backdrop fades in (opacity 0 -> 1, 150ms ease-out). Editor panel slides up from bottom (translateY(24px) -> 0, 200ms ease-out). Skeleton placeholders shown for all fields until data resolves. |
| **Keyboard shortcuts** | `Escape` cancels open, returns to `editor.closed`. |
| **Data requirements** | For existing scenario: full `Scenario` object fetched from `QAPanelState.scenarios[id]`. For new: empty template with generated ID (`scn-{slug}-{hash}`), default category `happy_path`, priority 3, timeout 30000. |
| **Transitions** | `editor.opening` -> `editor.metadata` (success). `editor.opening` -> `editor.closed` (load error / cancel). |
| **Error recovery** | If scenario data is missing from state (e.g., stale reference), show toast "Scenario not found" and transition to `editor.closed`. |

---

### 3. `editor.metadata`

| Field | Detail |
|-------|--------|
| **Entry conditions** | (a) Editor opens (default tab). (b) User clicks "Metadata" tab from another section. (c) Validation error points to metadata field. |
| **Exit conditions** | User switches to another tab (Stimulus / Setup / Expectations / JSON). |
| **Visual description** | Active tab highlighted with `--accent` bottom border (2px). Fields: Title (text input, 120 char counter), Category (dropdown: `happy_path`, `error_path`, `edge_case`, `regression`, `performance`), Priority (dropdown 1-5), Description (textarea, 500 char counter), Impact Zone (read-only text), Timeout (number input, suffix "ms"), Tags (chip list with add button). Character counters turn `--error` (red) when limit exceeded. |
| **Keyboard shortcuts** | `Tab` / `Shift+Tab` between fields. `Ctrl+1` focuses Title. `Ctrl+S` triggers save. `Escape` triggers close/discard flow. `Ctrl+Shift+J` toggles JSON view. |
| **Data requirements** | `scenario.title`, `scenario.category`, `scenario.priority`, `scenario.description`, `scenario.impactZone`, `scenario.timeoutMs`, `scenario.metadata.tags`. |
| **Transitions** | `editor.metadata` -> `editor.stimulus` (click Stimulus tab or `Ctrl+2`). `editor.metadata` -> `editor.setup` (click Setup tab or `Ctrl+3`). `editor.metadata` -> `editor.expectations` (click Expectations tab or `Ctrl+4`). `editor.metadata` -> `editor.json-view` (`Ctrl+Shift+J`). `editor.metadata` -> `editor.validating` (on any field blur, debounced 300ms). `editor.metadata` -> `editor.confirm-discard` (Escape with dirty state). |
| **Error recovery** | Character overflow: counter goes red, save disabled. Empty title: inline error "Title is required" below field. Invalid timeout (< 1000 or > 60000): inline error with valid range hint. |

---

### 4. `editor.stimulus`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks "Stimulus" tab or presses `Ctrl+2`. |
| **Exit conditions** | User switches tab, opens type dropdown, or triggers save/close. |
| **Visual description** | Stimulus type selector (dropdown, current value shown). Below it, a type-specific parameter form renders dynamically: **http_request** — Method dropdown (GET/POST/PUT/DELETE/PATCH), Path text input, Headers key-value list, Body JSON textarea. **signalr_invoke** — Hub, Method, Args JSON array. **dag_trigger** — IterationId, NodeFilter multi-select. **file_event** — Path, Content textarea, Encoding radio (utf8/base64). **timer_tick** — TickSource, Topic, MaxWaitMs. Only the active type's form is visible. |
| **Keyboard shortcuts** | `Ctrl+2` activates tab. `Tab` / `Shift+Tab` within form fields. `Space` or `Enter` on type dropdown opens `editor.stimulus.type-select`. |
| **Data requirements** | `scenario.stimulus.type`, plus the matching sub-object (`httpRequest`, `signalrInvoke`, `dagTrigger`, `fileEvent`, `timerTick`). |
| **Transitions** | `editor.stimulus` -> `editor.stimulus.type-select` (open dropdown). `editor.stimulus` -> `editor.metadata` / `editor.setup` / `editor.expectations` (tab switch). `editor.stimulus` -> `editor.validating` (field blur, debounced). |
| **Error recovery** | If stimulus type changes, previous type's data is preserved in memory (not discarded) so user can switch back without loss. Missing required fields (e.g., `path` for http_request) shown as inline validation on blur. |

---

### 5. `editor.stimulus.type-select`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks or presses `Space`/`Enter`/`ArrowDown` on stimulus type dropdown. |
| **Exit conditions** | (a) User selects a type. (b) User presses `Escape`. (c) Click outside dropdown. |
| **Visual description** | Dropdown listbox overlays below the type selector. Options: `http_request`, `signalr_invoke`, `dag_trigger`, `file_event`, `timer_tick`. Current selection marked with `▸` prefix. Each option has a one-line description in `--text-muted` below the label. Focused option has `--bg-hover` highlight. |
| **Keyboard shortcuts** | `ArrowUp` / `ArrowDown` move focus. `Enter` / `Space` confirm selection. `Escape` closes without change. `Home` / `End` jump to first / last option. Type-ahead: typing "h" jumps to `http_request`. |
| **Data requirements** | Enum values from `StimulusType`: `http_request`, `signalr_invoke`, `dag_trigger`, `file_event`, `timer_tick`. |
| **Transitions** | `editor.stimulus.type-select` -> `editor.stimulus` (selection made or Escape). Selecting a new type triggers form rebuild for that type. Sets `editor.dirty` flag if type changed. |
| **Error recovery** | N/A — all options are valid enum values. |

---

### 6. `editor.setup`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks "Setup" tab or presses `Ctrl+3`. |
| **Exit conditions** | User switches tab, clicks "Add Step", or initiates reorder. |
| **Visual description** | Header shows step count: "Setup Steps (N)". Each step rendered as a card with: drag handle `[=]` on left, step number, type badge (`chaos_rule` / `flag_override` / `state_seed` / `wait`), summary line, remove button `[x]` on right. Empty state: dashed border box with "No setup steps. Click + Add Step to configure pre-conditions." and centered add button. |
| **Keyboard shortcuts** | `Ctrl+3` activates tab. `ArrowUp` / `ArrowDown` move focus between step cards. `Delete` on focused card prompts removal. `Enter` on focused card expands for inline edit. `N` or `Ctrl+Shift+A` opens add-step form. `Ctrl+ArrowUp` / `Ctrl+ArrowDown` enters reorder mode. |
| **Data requirements** | `scenario.setup[]` — array of `SetupStep` objects. Each has `type` + one populated sub-object (`chaosRule`, `flagOverride`, `stateSeed`, `wait`). |
| **Transitions** | `editor.setup` -> `editor.setup.adding` (click Add Step). `editor.setup` -> `editor.setup.reordering` (`Ctrl+Arrow` or drag start). `editor.setup` -> `editor.metadata` / `editor.stimulus` / `editor.expectations` (tab switch). `editor.setup` -> `editor.validating` (on step remove or inline edit blur). |
| **Error recovery** | Remove step: no confirmation for single step (undo via `Ctrl+Z` within 5s — step stored in undo buffer). If undo timer expires, removal is permanent. |

---

### 7. `editor.setup.adding`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks "+ Add Step" or presses `N` / `Ctrl+Shift+A` in setup tab. |
| **Exit conditions** | (a) User confirms step (fills required fields, presses Enter or clicks Add). (b) User cancels (`Escape`). |
| **Visual description** | Inline form appended below existing steps. Step type dropdown (chaos_rule / flag_override / state_seed / wait). Below dropdown, type-specific fields appear: **chaos_rule** — Target (text), Fault (dropdown: http_error / latency / timeout / partial_response), Parameters (key-value editor). **flag_override** — Flag Name (text), Value (toggle). **state_seed** — Method (dropdown), URL (text), Body (JSON textarea). **wait** — DurationMs (number, 0-30000). Confirm `[ Add ]` and cancel `[ Cancel ]` buttons at bottom. |
| **Keyboard shortcuts** | `Escape` cancels. `Ctrl+Enter` confirms. `Tab` cycles through fields. |
| **Data requirements** | Empty `SetupStep` template. Type selection determines which sub-object fields render. |
| **Transitions** | `editor.setup.adding` -> `editor.setup` (confirm or cancel). On confirm: new step appended to `scenario.setup[]`, dirty flag set, validation triggered. |
| **Error recovery** | Required field missing on confirm: inline error on the empty field, form stays open. Invalid parameter JSON: red border on textarea, error message "Invalid JSON". |

---

### 8. `editor.setup.reordering`

| Field | Detail |
|-------|--------|
| **Entry conditions** | (a) User starts dragging a step card (mousedown on drag handle). (b) User presses `Ctrl+ArrowUp` or `Ctrl+ArrowDown` on a focused step. |
| **Exit conditions** | (a) Mouse drag: mouseup drops the card. (b) Keyboard: `Escape` cancels reorder, `Enter` confirms position. |
| **Visual description** | **Drag mode:** Dragged card lifts with `box-shadow` elevation and slight scale(1.02). A 2px `--accent` insertion line shows the drop target between cards. Other cards shift to make room (60ms transition). **Keyboard mode:** Focused card gets a pulsing `--accent` left border (2px). Arrow keys swap it with adjacent cards. Live aria announcement: "Step 2 moved to position 1 of 3". |
| **Keyboard shortcuts** | `Ctrl+ArrowUp` moves step up. `Ctrl+ArrowDown` moves step down. `Escape` reverts to original order. `Enter` confirms new order. |
| **Data requirements** | Original `scenario.setup[]` order preserved until confirm. Reorder operates on a shadow copy. |
| **Transitions** | `editor.setup.reordering` -> `editor.setup` (drop / confirm / cancel). On confirm: `scenario.setup[]` rewritten with new order, dirty flag set. On cancel: original order restored. |
| **Error recovery** | If drag target goes outside the step list area, snap back to last valid position. Touch events: 200ms long-press activates drag mode to prevent accidental reorder on scroll. |

---

### 9. `editor.expectations`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks "Expectations" tab or presses `Ctrl+4`. |
| **Exit conditions** | User switches tab, clicks "Add Expectation", or clicks "Edit" on a row. |
| **Visual description** | Header: "Expectations (N)" with add button. Each expectation is a compact row: ID badge (`exp-1`), type badge (color-coded: green=event_present, red=event_absent, blue=event_count, etc.), topic chip, description text, `[Edit]` and `[x]` action buttons. Minimum 1 expectation required — if list is empty, show warning banner "At least one expectation is required" in `--warning` color. |
| **Keyboard shortcuts** | `Ctrl+4` activates tab. `ArrowUp` / `ArrowDown` navigate rows. `Enter` or `E` on focused row opens matcher editor. `Delete` removes focused row (with undo). `N` or `Ctrl+Shift+A` opens add form. |
| **Data requirements** | `scenario.expectations[]` — array of `Expectation` objects. Each has `id`, `type`, `topic`, `matcher`, `timeWindow`, `count`, `order`, `description`. |
| **Transitions** | `editor.expectations` -> `editor.expectations.adding` (add action). `editor.expectations` -> `editor.expectations.matcher` (edit action on existing row). `editor.expectations` -> other tabs (tab switch). `editor.expectations` -> `editor.validating` (on remove). |
| **Error recovery** | Removing last expectation: show warning banner immediately. Save stays disabled until at least 1 expectation exists. Remove with undo buffer (same 5s pattern as setup steps). |

---

### 10. `editor.expectations.adding`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks "+ Add Expectation" or presses `N` in expectations tab. |
| **Exit conditions** | (a) User fills required fields and confirms. (b) User cancels. |
| **Visual description** | Inline form below existing expectations. Fields: ID (auto-generated `exp-{N+1}`, editable), Type dropdown (event_present / event_absent / event_count / event_order / timing / field_match), Topic dropdown (16 registered topics: http, token, flag, perf, spark, log, telemetry, retry, cache, fileop, catalog, dag, flt-ops, di, capacity, nexus), Description (text input). Confirm transitions to `editor.expectations.matcher` to configure the matcher details. |
| **Keyboard shortcuts** | `Escape` cancels. `Tab` cycles fields. `Ctrl+Enter` confirms and opens matcher editor. |
| **Data requirements** | Empty `Expectation` template. `id` auto-assigned as `exp-{max_existing + 1}`. Topic enum from `EdogTopicRouter` registry. |
| **Transitions** | `editor.expectations.adding` -> `editor.expectations.matcher` (confirm — proceeds to matcher config). `editor.expectations.adding` -> `editor.expectations` (cancel). |
| **Error recovery** | Duplicate ID: inline error "Expectation ID already exists". Missing topic: inline error "Topic is required". Invalid ID format (must match `^exp-[0-9]+$`): inline error with format hint. |

---

### 11. `editor.expectations.matcher`

| Field | Detail |
|-------|--------|
| **Entry conditions** | (a) User clicks "Edit" on an expectation row. (b) User confirms new expectation (flows from `editor.expectations.adding`). |
| **Exit conditions** | (a) User clicks "Done" or presses `Ctrl+Enter`. (b) User presses `Escape` (reverts matcher changes). |
| **Visual description** | Expanded panel replaces the expectation row (accordion style). Sections based on expectation type: **All types:** Matcher section with sub-tabs: Exact (key-value pairs), Contains (key-substring pairs), Regex (key-pattern pairs), Range (key-min/max pairs), Exists (field name list). **event_count:** Count section — Min/Max/Exact number inputs. **timing:** TimeWindow section — WithinMs, AfterMs number inputs. **event_order:** Order section — "After" dropdown referencing other expectation IDs. Each matcher sub-section is a key-value editor with `[+ Add]` / `[x]` per row. Active sub-tab highlighted. |
| **Keyboard shortcuts** | `Tab` cycles fields within matcher. `Ctrl+Enter` confirms. `Escape` reverts and closes. `Ctrl+Shift+E/C/R/G/X` switch to Exact/Contains/Regex/Range/Exists matcher sub-tabs. |
| **Data requirements** | Full `Expectation` object: `matcher.exact`, `matcher.contains`, `matcher.regex`, `matcher.range`, `matcher.exists`, `timeWindow`, `count`, `order`. Other expectation IDs for `order.after` dropdown. |
| **Transitions** | `editor.expectations.matcher` -> `editor.expectations` (done / escape). On done: expectation updated in `scenario.expectations[]`, dirty flag set, validation triggered. On escape: changes reverted to pre-edit state. |
| **Error recovery** | Invalid regex pattern: red border + "Invalid regular expression" message (tested with `new RegExp()` on blur). Empty matcher (no predicates): show info "Empty matcher matches ALL events for this topic" in `--warning` color. Cycle in order references (exp-1 after exp-2, exp-2 after exp-1): inline error "Circular order dependency detected". |

---

### 12. `editor.json-view`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks `[JSON]` toggle button or presses `Ctrl+Shift+J`. |
| **Exit conditions** | User clicks `[Back]` or presses `Ctrl+Shift+J` again (toggle). |
| **Visual description** | Full editor area replaced with a monospace `<textarea>` (or `<pre contenteditable>`) showing the complete scenario JSON, pretty-printed with 2-space indent. Syntax highlighting via CSS classes (keys in `--accent`, strings in `--text-secondary`, numbers in `--info`). Top bar: `[Copy]` button, `[Back]` button, read/write toggle. Bottom bar: validation status line ("Valid JSON, schema OK" or error with line number). |
| **Keyboard shortcuts** | `Ctrl+Shift+J` toggles view. `Ctrl+C` / `Ctrl+A` standard text ops. `Ctrl+S` saves (parses JSON first). `Escape` exits to previous tab. |
| **Data requirements** | Complete `Scenario` object serialized to JSON. On entry, generate JSON from current in-memory state (including unsaved edits). |
| **Transitions** | `editor.json-view` -> `editor.json-view.editing` (user modifies text). `editor.json-view` -> previous tab (Back / toggle). `editor.json-view` -> `editor.validating` (on exit, if JSON was edited). |
| **Error recovery** | If JSON is malformed when exiting: show modal "JSON has syntax errors. Fix or discard changes?" with `[Fix]` (stay in JSON view, cursor at error line) and `[Discard]` (revert to pre-edit JSON). |

---

### 13. `editor.json-view.editing`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User makes any text modification in the JSON view textarea. |
| **Exit conditions** | (a) User exits JSON view (triggers parse). (b) User saves. |
| **Visual description** | Same as `editor.json-view` but with: dirty indicator dot next to `[JSON]` tab, live validation running on 500ms debounce after each keystroke. Status bar updates in real-time: green "Valid JSON" or red "Syntax error at line N: {message}". If valid JSON but schema invalid, show orange "Valid JSON, schema errors: {count}". |
| **Keyboard shortcuts** | Same as `editor.json-view`. `Ctrl+Z` / `Ctrl+Y` undo/redo within textarea. |
| **Data requirements** | Raw text content of the textarea. Parse on debounce to validate. |
| **Transitions** | `editor.json-view.editing` -> `editor.json-view` (no change after undo all). `editor.json-view.editing` -> `editor.validating` (on exit or save). On successful parse: JSON is deserialized back into the in-memory `Scenario` object, all form tabs reflect the new data. |
| **Error recovery** | JSON parse failure: highlight error line with red background, show cursor-positioned error. Schema validation failure after successful parse: list schema errors in status bar. User can keep editing or discard. |

---

### 14. `editor.validating`

| Field | Detail |
|-------|--------|
| **Entry conditions** | (a) Field blur (debounced 300ms). (b) Tab switch. (c) Save triggered. (d) JSON view exit after edit. |
| **Exit conditions** | Validation completes (synchronous, < 16ms for client-side checks) -> `editor.valid` or `editor.invalid`. |
| **Visual description** | Transient state — no visible spinner (validation is synchronous and fast). The validation status bar at the bottom updates: brief flash of "Validating..." text (visible only if validation takes > 50ms, which it shouldn't). |
| **Keyboard shortcuts** | None — state is transient. |
| **Data requirements** | Complete in-memory `Scenario` object. Validation rules from C02-S01 schema: `id` matches `^scn-[a-z0-9-]+$`, `title` required + max 120, `category` in enum, `stimulus.type` required, `expectations` min 1, each `expectation.id` matches `^exp-[0-9]+$`, `timeout` 1000-60000, expectation order acyclic (topological sort), no `timeWindow.withinMs` > `scenario.timeoutMs`. |
| **Transitions** | `editor.validating` -> `editor.valid` (zero errors). `editor.validating` -> `editor.invalid` (one or more errors). |
| **Error recovery** | If validation itself throws (defensive — shouldn't happen): catch, log to console, treat as valid (fail-open for UX, server will re-validate). |

---

### 15. `editor.valid`

| Field | Detail |
|-------|--------|
| **Entry conditions** | Validation pass completes with zero errors. |
| **Exit conditions** | User edits any field (returns to section state, then re-validates). |
| **Visual description** | Status bar: "0 errors, 0 warnings" in `--success` color. Save button fully enabled with solid `--accent` background. All inline field errors cleared. If warnings exist (e.g., empty matcher), show warning count in `--warning` color but save remains enabled. |
| **Keyboard shortcuts** | `Ctrl+S` triggers save. |
| **Data requirements** | Validated `Scenario` object ready for submission. |
| **Transitions** | `editor.valid` -> `editor.saving` (`Ctrl+S` or click Save). `editor.valid` -> any section state (user edits a field, triggers re-validation). |
| **Error recovery** | N/A — valid state. |

---

### 16. `editor.invalid`

| Field | Detail |
|-------|--------|
| **Entry conditions** | Validation pass completes with one or more errors. |
| **Exit conditions** | User fixes the error(s) and re-validation yields zero errors. |
| **Visual description** | Status bar: "N errors, M warnings" in `--error` color. Save button disabled (grayed out, `cursor: not-allowed`). Inline errors appear below the offending fields with red text and `--error` left border. Clicking an error in the status bar navigates to the correct tab and focuses the offending field. Error summary tooltip on hover over status bar listing all errors. |
| **Keyboard shortcuts** | `F8` jumps to next error. `Shift+F8` jumps to previous error. `Ctrl+S` blocked (shows tooltip "Fix N errors before saving"). |
| **Data requirements** | Array of `ValidationError` objects: `{ field: string, tab: string, message: string, severity: 'error' | 'warning' }`. |
| **Transitions** | `editor.invalid` -> `editor.validating` (user edits a field). `editor.invalid` -> any section state (user navigates to fix errors). Cannot transition to `editor.saving`. |
| **Error recovery** | Error navigation (`F8`) wraps around. If error references a field on another tab, auto-switch to that tab and focus the field. |

---

### 17. `editor.saving`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User presses `Ctrl+S` or clicks Save while in `editor.valid` state. |
| **Exit conditions** | (a) Save succeeds -> `editor.closed`. (b) Save fails -> return to `editor.valid` with error toast. |
| **Visual description** | Save button shows inline spinner (rotating `◌` character, 12px) and text changes to "Saving...". All form fields become read-only (`pointer-events: none`, `opacity: 0.6`). Cancel button disabled. Escape key blocked. |
| **Keyboard shortcuts** | None — all input blocked during save. |
| **Data requirements** | Serialized `Scenario` JSON. For existing scenarios: `QAPanelState` diff to detect actual changes. SignalR call: `connection.invoke('QaUpdateScenario', { scenario, correlationId })` for updates, or mutation of the curated scenarios array for new scenarios. |
| **Transitions** | `editor.saving` -> `editor.closed` (success — toast "Scenario saved", curation list refreshes). `editor.saving` -> `editor.valid` (failure — toast with error, fields re-enabled). |
| **Error recovery** | Network error: toast "Save failed: connection error. Changes preserved locally." Fields re-enabled, dirty flag remains. Validation error from server (server-side re-validation): toast with server errors, map to inline field errors where possible, transition to `editor.invalid`. Timeout (> 5s): cancel save, show toast "Save timed out. Try again.", re-enable fields. |

---

### 18. `editor.dirty`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User modifies any field value from its original loaded state. This is a **modifier flag**, not a standalone state — it overlays any section state. |
| **Exit conditions** | (a) Save succeeds (clears flag). (b) User confirms discard (clears flag). (c) All fields manually reverted to original values (clears flag via deep equality check). |
| **Visual description** | Dirty indicator: small `●` dot in `--warning` color next to the editor title. Modified field labels gain a subtle `--warning` left border (1px). Tab labels for tabs containing changes show a dot indicator. Browser `beforeunload` handler registered to warn on page navigation. |
| **Keyboard shortcuts** | No dedicated shortcuts. Dirty flag is tracked automatically on every field change via input event listeners. |
| **Data requirements** | Original scenario snapshot (deep clone on editor open). Current scenario state. Deep equality comparison on each change to determine dirty status. Changed field paths tracked for per-field dirty indicators. |
| **Transitions** | `editor.dirty` (set) — on any field mutation where `current !== original`. `editor.dirty` (clear) — on save success, confirmed discard, or full revert. If dirty and user attempts close: -> `editor.confirm-discard`. |
| **Error recovery** | If deep equality check is expensive (large scenario), throttle to 200ms. The `beforeunload` handler is removed on `editor.closed` to avoid orphaned handlers. |

---

### 19. `editor.confirm-discard`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User attempts to close editor (Escape, click `[x]`, click backdrop, switch away from curation stage) while `editor.dirty` flag is set. |
| **Exit conditions** | (a) User clicks "Discard" -> `editor.closed`. (b) User clicks "Keep Editing" -> returns to previous section state. (c) User clicks "Save" -> `editor.saving`. |
| **Visual description** | Nested modal dialog (smaller, centered over the editor). Backdrop dims the editor further. Content: warning icon (Unicode `◆`), heading "Unsaved Changes", message "You have unsaved changes to '{scenario.title}'. What would you like to do?", three buttons: `[ Discard ]` (destructive, `--error` outline), `[ Save ]` (`--accent` solid), `[ Keep Editing ]` (neutral, auto-focused). |
| **Keyboard shortcuts** | `Escape` selects "Keep Editing" (safe default). `Enter` activates focused button. `Tab` cycles between the three buttons. `D` shortcut for Discard (with 500ms hold to prevent accidental activation). |
| **Data requirements** | `scenario.title` for the confirmation message. Dirty flag state. |
| **Transitions** | `editor.confirm-discard` -> `editor.closed` (Discard — clears dirty flag, tears down editor). `editor.confirm-discard` -> `editor.saving` (Save — same as normal save flow). `editor.confirm-discard` -> previous section state (Keep Editing — dialog dismissed). |
| **Error recovery** | If save is chosen and fails, the confirm-discard dialog does not reappear — user lands in `editor.valid` with the error toast and can retry or manually discard. |

---

## Transition Diagram

```
                              +-----------------+
                              | editor.closed   |
                              +--------+--------+
                                       |
                           Edit / New Scenario
                                       |
                                       v
                              +-----------------+
                              | editor.opening  |
                              +--------+--------+
                                       |
                            load success / animation done
                                       |
            +-----------+--------------+---------------+
            |           |              |               |
            v           v              v               v
   +--------+--+ +------+-----+ +-----+------+ +------+--------+
   | .metadata | | .stimulus  | | .setup     | | .expectations |
   +-----------+ +------+-----+ +-----+------+ +------+--------+
         |           |     |        |      |        |       |
         |           |     |        |      |        |       |
   Ctrl+Shift+J     |     |        |      |        |       |
   or [JSON]        |     |        |      |        |       |
         |           |     v        |      v        |       v
         |           | +-------+   | +--------+    | +----------+
         |           | |.type- |   | |.adding |    | | .adding  |
         |           | |select |   | +--------+    | +----+-----+
         |           | +-------+   |               |      |
         |           |             v               v      v
         |           |       +-----------+   +-----------+
         |           |       |.reordering|   | .matcher  |
         |           |       +-----------+   +-----------+
         |           |
         v           v
   +-----+-----------+-----+
   |   editor.json-view    |
   +----------+------------+
              |
         (edit text)
              v
   +----------+------------+
   | editor.json-view      |
   |       .editing        |
   +-----------------------+


  === Validation Overlay (runs from any section state) ===

   (any section state)
         |
    field blur / tab switch / save trigger
         |
         v
   +-----------+
   |.validating|
   +-----+-----+
         |
    +----+----+
    |         |
    v         v
 +------+ +-------+
 |.valid| |.invalid|
 +--+---+ +---+---+
    |          |
    |     F8 = jump to error
    |          |
    v          |
 +------+     |
 |.saving|    |
 +--+----+    |
    |         |
    +----+----+
         |
         v
   +----------+
   |  .closed |
   +----------+


  === Dirty Flag + Discard Overlay ===

   (any section state) + dirty flag
         |
    Escape / close attempt
         |
         v
   +------------------+
   |.confirm-discard  |
   +--------+---------+
            |
   +--------+---------+--------+
   |        |                  |
   v        v                  v
 .closed  .saving    (previous section state)
```

---

## Focus Management

### Modal Open / Close

| Event | Focus Target |
|-------|-------------|
| Editor opens | Title field in Metadata tab (first interactive element) |
| Tab switch | First interactive field in the target tab |
| Editor closes | The scenario card in the curation list that was being edited |
| Confirm-discard opens | "Keep Editing" button (safe default) |
| Confirm-discard closes | Restores focus to the element that was focused before the dialog |

### Focus Trap

The editor modal implements a focus trap. `Tab` / `Shift+Tab` cycle only within the modal. Focus does not escape to the page behind the modal. The trap is implemented with a sentinel `<div tabindex="0">` at the start and end of the modal that redirect focus on receive.

### Tab Navigation Order (per section)

**Metadata:** Title -> Category dropdown -> Priority dropdown -> Description -> Impact Zone (read-only, skipped) -> Timeout -> Tags chip input -> Cancel button -> Save button.

**Stimulus:** Type dropdown -> (type-specific fields in DOM order) -> Cancel -> Save.

**Setup:** Step cards (ArrowUp/ArrowDown) -> Add Step button -> Cancel -> Save.

**Expectations:** Expectation rows (ArrowUp/ArrowDown) -> Add Expectation button -> Cancel -> Save.

**JSON View:** Textarea -> Copy button -> Back button -> Cancel -> Save.

### ARIA Attributes

| Element | ARIA |
|---------|------|
| Modal overlay | `role="dialog"`, `aria-modal="true"`, `aria-labelledby="editor-title"` |
| Tab bar | `role="tablist"` |
| Tab buttons | `role="tab"`, `aria-selected`, `aria-controls="panel-{name}"` |
| Tab panels | `role="tabpanel"`, `aria-labelledby="tab-{name}"` |
| Setup step list | `role="listbox"`, `aria-label="Setup steps"` |
| Step card | `role="option"`, `aria-grabbed` (during reorder) |
| Expectation list | `role="listbox"`, `aria-label="Expectations"` |
| Validation errors | `role="alert"`, `aria-live="polite"` |
| Confirm dialog | `role="alertdialog"`, `aria-describedby="discard-message"` |
| Status bar | `role="status"`, `aria-live="polite"` |
| Dirty indicator | `aria-label="Unsaved changes"` |

---

## Keyboard Shortcut Summary

| Shortcut | Scope | Action |
|----------|-------|--------|
| `Ctrl+S` | Global (editor open) | Save scenario |
| `Escape` | Global (editor open) | Close editor (triggers discard if dirty) |
| `Ctrl+1` | Global (editor open) | Switch to Metadata tab |
| `Ctrl+2` | Global (editor open) | Switch to Stimulus tab |
| `Ctrl+3` | Global (editor open) | Switch to Setup tab |
| `Ctrl+4` | Global (editor open) | Switch to Expectations tab |
| `Ctrl+Shift+J` | Global (editor open) | Toggle JSON view |
| `F8` | Global (editor open) | Jump to next validation error |
| `Shift+F8` | Global (editor open) | Jump to previous validation error |
| `Tab` / `Shift+Tab` | Global (editor open) | Cycle focus within modal |
| `Ctrl+Z` | Setup / Expectations | Undo last remove (within 5s) |
| `N` / `Ctrl+Shift+A` | Setup / Expectations | Add new item |
| `Delete` | Setup / Expectations | Remove focused item |
| `Enter` / `E` | Expectations list | Edit focused expectation matcher |
| `Ctrl+ArrowUp` | Setup list | Move focused step up (reorder) |
| `Ctrl+ArrowDown` | Setup list | Move focused step down (reorder) |
| `ArrowUp` / `ArrowDown` | Type dropdown / lists | Navigate options |
| `Space` / `Enter` | Dropdowns | Open / confirm selection |
| `Home` / `End` | Dropdowns / lists | Jump to first / last item |
| `Ctrl+Enter` | Adding / Matcher forms | Confirm and close form |
| `Ctrl+Shift+E` | Matcher editor | Switch to Exact sub-tab |
| `Ctrl+Shift+C` | Matcher editor | Switch to Contains sub-tab |
| `Ctrl+Shift+R` | Matcher editor | Switch to Regex sub-tab |
| `Ctrl+Shift+G` | Matcher editor | Switch to Range sub-tab |
| `Ctrl+Shift+X` | Matcher editor | Switch to Exists sub-tab |
