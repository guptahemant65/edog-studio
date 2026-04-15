# Chaos Engineering Panel Shell — State Matrix

> **Component:** Panel Shell (container for Rule Builder, Rule List, Traffic Monitor, Recording Viewer)
> **Status:** P3.1 — SPEC
> **Author:** Pixel (Frontend Engineer), reviewed by Sana Reeves (Architecture)
> **Depends On:** `signalr-protocol.md` (P2.5), `spec.md` §2–3
> **Implements:** P3.1 from the F24 prep checklist
> **Reference Patterns:** `runtime-view.js` (tab orchestrator), `sidebar.js` (phase-aware navigation)

---

## 0. Panel Position Decision

### Decision: 5th Sidebar View

The Chaos Panel is the **5th top-level sidebar view** (`data-view="chaos"`), a peer of Workspace, Runtime, API Playground, and Environment.

**Rationale:**

| Option | Verdict | Why |
|--------|---------|-----|
| (a) 5th sidebar view | **CHOSEN** | Consistent with existing navigation. Chaos is a first-class workflow, not a sub-feature of Runtime. Engineers will have it open for hours. The spec says "5th sidebar item" (§2). |
| (b) Bottom drawer in Runtime | Rejected | Competes for vertical space with 11 tab content areas. Traffic Monitor needs full height. Cannot co-view logs + traffic simultaneously. |
| (c) Slide-out right panel | Rejected | Breaks the existing grid layout. Would require z-index warfare with detail panels and command palette. |
| (d) Floating window | Rejected | Not possible in a single-HTML-file localhost app. No `window.open()` — violates the build-html.py constraint. |

**Coexistence with Runtime View:**

- Chaos Panel and Runtime View are mutually exclusive sidebar views (same as Workspace vs Runtime today). The user switches between them with sidebar click or keyboard `5`.
- Traffic Monitor in the Chaos Panel subscribes to the **same** `http` topic buffer as Runtime's HTTP Pipeline tab — traffic data is shared, presentation differs.
- The user CAN have chaos rules active while viewing Runtime's Logs tab. Rule firing events are engine-side; the panel doesn't need to be visible.
- Kill switch (`Ctrl+Shift+K`) works **globally** — regardless of which view is active.

**Layout within the Chaos View:**

```
┌─────────────────────────────────────────────────────┐
│ view-chaos (full content area, same as view-runtime) │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Chaos Tab Bar: Rules │ Builder │ Traffic │ Rec  │ │
│ │ ─────────────────────[indicator]─────────────── │ │
│ ├─────────────────────────────────────────────────┤ │
│ │ Chaos Status Bar:                                │ │
│ │ ● Engine: idle │ 0 active rules │ Kill: off     │ │
│ ├─────────────────────────────────────────────────┤ │
│ │                                                  │ │
│ │              Active sub-view content              │ │
│ │          (one of 4 sub-views at a time)           │ │
│ │                                                  │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

The shell has:
1. **Tab bar** — 4 tabs: Rules, Builder, Traffic, Recording. Sliding indicator (same pattern as `runtime-view.js`).
2. **Status bar** — Engine status, active rule count, kill switch state, recording indicator. 32px height. Always visible.
3. **Content area** — Renders the active sub-view. One sub-view visible at a time (`position: absolute; inset: 0` stacking with `opacity` transition, same as `.rt-tab-content`).

---

## 1. State Definitions

### Naming Convention

```
panel.<visibility>.<subview?>.<substate?>
```

---

### 1.1 `panel.hidden`

The Chaos Panel is not rendered in the viewport. Another sidebar view is active.

| Property | Value |
|----------|-------|
| **Entry conditions** | (a) App starts — default view is Workspace. (b) User switches to another sidebar view. (c) User presses `1`–`4` (sidebar view shortcuts). |
| **Exit conditions** | (a) User clicks Chaos sidebar icon. (b) User presses `5` (sidebar shortcut). (c) Command Palette action "Open Chaos Panel". |
| **Visual** | `#view-chaos` has `display: none` (via `.view-panel` without `.active`). Sidebar chaos icon is visible but not highlighted. If chaos rules are active, the sidebar icon shows a pulsing amber badge (rule count). |
| **Keyboard** | `5` — switches to Chaos view (enters `panel.open.rules` or last-active sub-view). |
| **SignalR subscriptions** | **None started by the panel.** But: (1) `KillSwitchActivated` listener is registered globally in `main.js`, not panel-scoped. (2) `RuleFired` events update the sidebar badge counter even while hidden. |
| **Data** | Panel class retains `_lastSubView` in memory so returning to Chaos restores the last sub-view. No SignalR traffic stream active (saves bandwidth). |

**Transitions:**

```
panel.hidden ──[sidebar click / key 5 / command palette]──▸ panel.open.{_lastSubView || rules}
panel.hidden ──[phase → disconnected]──▸ panel.hidden (no change; badge clears)
```

---

### 1.2 `panel.opening`

Transient animation state. Duration: 150ms (matches `.rt-tab-content` opacity transition).

| Property | Value |
|----------|-------|
| **Entry conditions** | Transition from `panel.hidden` to any `panel.open.*` state. |
| **Exit conditions** | CSS transition completes (150ms). |
| **Visual** | `#view-chaos` gains `.active` class → `display: flex`. Opacity transitions from 0 to 1. Sub-view content is already determined. Status bar populates with cached state. |
| **Keyboard** | All panel shortcuts are queued, not dropped. They execute after animation completes. |
| **SignalR subscriptions** | On entering: (1) `connection.invoke('Subscribe', 'chaos')` to join the chaos event group. (2) `ChaosGetAllRules()` to hydrate rule state. (3) If entering traffic sub-view, `ChaosSubscribeTraffic()`. |
| **Data** | Rule list cache is populated from `ChaosGetAllRules()` response. Engine state (kill switch, active count) is derived from the rule snapshot. |

**Transitions:**

```
panel.opening ──[animation complete]──▸ panel.open.{target subview}
panel.opening ──[sidebar click on different view during animation]──▸ panel.hidden
```

---

### 1.3 `panel.open.rules`

Showing the Active Rules List. This is the **default** sub-view when no prior state exists.

| Property | Value |
|----------|-------|
| **Entry conditions** | (a) Panel opens with no prior sub-view. (b) User clicks "Rules" tab. (c) User presses `Alt+1` while Chaos view is active. (d) User clicks "View in Rules" from builder success toast. |
| **Exit conditions** | (a) User clicks another sub-view tab. (b) User navigates away from Chaos via sidebar. (c) `panel.open.builder.editing` triggered by "Edit" action on a rule row. |
| **Visual** | Tab bar: "Rules" tab active with indicator underline. Content: rule list table — columns: Enable toggle, Name, Category, Status badge (●), Fire count, Last fired, Actions (edit/duplicate/delete). Empty state if no rules: centered message "No chaos rules configured" with "Create Rule" button (navigates to Builder). |
| **Keyboard** | `Alt+1` — activates this tab. `Enter` on focused rule row — opens detail expansion. `E` on focused row — edit (goes to `panel.open.builder.editing`). `Delete` on focused row — soft-delete with confirm. `Space` on focused row — toggle enable/disable. `N` — new rule (goes to `panel.open.builder`). |
| **SignalR subscriptions** | Active: `chaos` group (for `RuleCreated`, `RuleUpdated`, `RuleDeleted`, `RuleFired`, `RuleAutoDisabled`, `AuditEntry`). Rule list live-updates from these events. |
| **Data** | `_rules[]` — full rule array from `ChaosGetAllRules()`. Updated in-place from push events. `RuleFired` events increment `fireCount` on matching rule — UI counter badge throttled to 2 refreshes/sec. |

**Transitions:**

```
panel.open.rules ──[click Builder tab / Alt+2]──▸ panel.open.builder
panel.open.rules ──[click Traffic tab / Alt+3]──▸ panel.open.traffic
panel.open.rules ──[click Recording tab / Alt+4]──▸ panel.open.recording
panel.open.rules ──[click Edit on rule row / E key]──▸ panel.open.builder.editing
panel.open.rules ──[click New Rule / N key]──▸ panel.open.builder
panel.open.rules ──[sidebar navigation away]──▸ panel.hidden
panel.open.rules ──[KillSwitchActivated event]──▸ panel.open.rules.killed (visual overlay)
panel.open.rules ──[SignalR disconnect]──▸ panel.open.rules.disconnected
```

---

### 1.4 `panel.open.rules.killed`

Kill switch has been activated. Overlays the rules list with a safety banner.

| Property | Value |
|----------|-------|
| **Entry conditions** | `KillSwitchActivated` event received while on rules sub-view. |
| **Exit conditions** | (a) User calls `ChaosResetKillSwitch`. (b) User navigates to another sub-view (banner follows to status bar). |
| **Visual** | Full-width danger banner at top of content area: red background, "⚠ KILL SWITCH ACTIVE — All rules disabled. Engine locked." with "Reset Kill Switch" button. All rule rows show `disabled-by-safety` state (red text, greyed toggle). Enable toggles are non-interactive. "New Rule" button disabled. Status bar kill indicator turns red: `● Kill: ACTIVE`. |
| **Keyboard** | `Ctrl+Shift+K` — no-op (already killed). All other shortcuts work normally. Tab to "Reset Kill Switch" button. |
| **SignalR** | Same as `panel.open.rules`. `ChaosResetKillSwitch` invoke clears the banner. |
| **Data** | `_killSwitchActive = true`. All rules have `lifecycle.state` updated to `disabled-by-safety` from the push events. |

**Transitions:**

```
panel.open.rules.killed ──[ChaosResetKillSwitch success]──▸ panel.open.rules
panel.open.rules.killed ──[tab switch]──▸ panel.open.{other}.killed
```

---

### 1.5 `panel.open.builder`

Showing the Rule Builder form for creating a **new** rule.

| Property | Value |
|----------|-------|
| **Entry conditions** | (a) User clicks "Builder" tab or `Alt+2`. (b) User clicks "New Rule" from rules list. (c) User clicks "Create Rule" from empty state. (d) Command Palette "New Chaos Rule". |
| **Exit conditions** | (a) User clicks another tab. (b) Rule successfully created (→ `panel.open.rules` with toast). (c) User clicks "Cancel" / presses `Escape`. |
| **Visual** | Tab bar: "Builder" tab active. Content: form with 4 sections — (1) Identity (name, description, category, tags), (2) Predicate (condition builder), (3) Action (action type + config), (4) Limits (maxFirings, TTL, probability). Bottom bar: "Create Rule" primary button (disabled until form valid), "Cancel" secondary button, "Create & Activate" tertiary. |
| **Keyboard** | `Alt+2` — activates this tab. `Ctrl+Enter` — submit form (create rule). `Escape` — cancel (returns to previous sub-view). `Tab` — navigate between form fields. |
| **SignalR** | Invokes `ChaosCreateRule` on submit. If "Create & Activate", chains `ChaosCreateRule` → `ChaosEnableRule`. |
| **Data** | `_builderDraft` — in-progress form state. NOT persisted across tab switches (intentional — prevents stale half-edits). Builder starts with blank form. Unsaved changes trigger a "Discard changes?" confirm dialog on tab switch. |

**Form validation (live, not on-submit):**

| Field | Validation | Visual |
|-------|-----------|--------|
| `name` | Required, 1–100 chars | Red border + inline error on blur |
| `predicate.conditions` | At least 1 condition required | Section header turns red |
| `action.type` | Required selection | Dropdown border red |
| `limits` | At least one limit set (maxFirings, ttlSeconds, or expiresAt) | Warning banner above submit buttons |

**Transitions:**

```
panel.open.builder ──[submit success]──▸ panel.open.rules (with success toast)
panel.open.builder ──[submit + activate success]──▸ panel.open.rules (with "Created & activated" toast)
panel.open.builder ──[submit validation error]──▸ panel.open.builder (form shows server errors)
panel.open.builder ──[Cancel / Escape]──▸ panel.open.rules (or _lastSubView)
panel.open.builder ──[click Rules tab / Alt+1]──▸ panel.open.rules (confirm discard if dirty)
panel.open.builder ──[click Traffic tab / Alt+3]──▸ panel.open.traffic (confirm discard if dirty)
panel.open.builder ──[click Recording tab / Alt+4]──▸ panel.open.recording (confirm discard if dirty)
panel.open.builder ──[KillSwitchActivated]──▸ panel.open.builder.killed (form stays, submit disabled)
```

---

### 1.6 `panel.open.builder.editing`

Editing an **existing** rule. Same form layout as builder, pre-populated with rule data.

| Property | Value |
|----------|-------|
| **Entry conditions** | (a) User clicks "Edit" on a rule in the rules list. (b) User presses `E` on a focused rule row. |
| **Exit conditions** | (a) User saves (invokes `ChaosUpdateRule`). (b) User cancels. (c) Tab switch (with discard confirm if dirty). |
| **Visual** | Same form as `panel.open.builder` but: (1) Title reads "Edit Rule: {rule name}" instead of "New Rule". (2) Form pre-filled with existing rule data. (3) Submit button reads "Save Changes" not "Create Rule". (4) "Save & Activate" replaces "Create & Activate" (only visible if rule is paused/draft). (5) Breadcrumb: "Rules ▸ Edit: {name}" at top of content area. (6) If the rule is `active`, a warning banner: "This rule is active. Pause it first to edit." — form is read-only, "Pause & Edit" button shown. |
| **Keyboard** | `Ctrl+Enter` — save changes. `Escape` — cancel (back to rules). |
| **SignalR** | (1) If rule is `active` and user clicks "Pause & Edit": invokes `ChaosDisableRule` then makes form editable. (2) On save: invokes `ChaosUpdateRule`. |
| **Data** | `_editingRuleId` — ID of the rule being edited. `_builderDraft` — cloned from existing rule data. Diff detection: track which fields changed from original. |

**Active rule guard:**

```
User clicks Edit on active rule
  → Form loads READ-ONLY
  → Banner: "This rule is active. Pause it to make changes."
  → User clicks "Pause & Edit"
  → ChaosDisableRule(ruleId)
  → On success: form becomes editable, banner replaced with info: "Rule paused for editing."
  → On failure: toast error, form stays read-only
```

**Transitions:**

```
panel.open.builder.editing ──[save success]──▸ panel.open.rules (with "Rule updated" toast)
panel.open.builder.editing ──[Cancel / Escape]──▸ panel.open.rules
panel.open.builder.editing ──[rule deleted by another client while editing]──▸ panel.open.rules (with "Rule was deleted" warning toast)
panel.open.builder.editing ──[RuleUpdated event for this rule from another client]──▸ show conflict banner: "This rule was modified externally. Reload?"
```

---

### 1.7 `panel.open.traffic`

Live traffic stream — the Burp Suite HTTP History equivalent.

| Property | Value |
|----------|-------|
| **Entry conditions** | (a) User clicks "Traffic" tab or `Alt+3`. |
| **Exit conditions** | (a) User clicks another tab. (b) User navigates away via sidebar. |
| **Visual** | Tab bar: "Traffic" tab active. Content: (1) Filter bar at top — method filter chips (GET/PUT/POST/DELETE/PATCH), status code range, URL search, "Chaos only" toggle (shows only `chaosModified: true` traffic), httpClient dropdown. (2) Traffic table: Timestamp, Method badge, URL (truncated), Status (color-coded), Duration (ms), Matched Rules (count badge or "—"), httpClient. (3) Auto-scrolls to newest entry (tail mode). (4) Status bar shows live throughput: "{N} req/s". |
| **Keyboard** | `Alt+3` — activates this tab. `↑/↓` — navigate traffic rows. `Enter` on row — expand detail (→ `panel.open.traffic.detail`). `P` — toggle pause. `C` — clear traffic. `F` — focus filter search. |
| **SignalR** | `ChaosSubscribeTraffic(filter)` streaming active. Stream is started when entering this state and cancelled (`stream.dispose()`) when leaving. Filter changes cancel + restart the stream. |
| **Data** | `_trafficEntries[]` — ring buffer, max 5000 entries in memory. Older entries evicted. `_trafficFilter` — current filter state, persisted in `_panelState`. Virtual scrolling for performance (same pattern as log viewer). |

**Performance budget:**

| Metric | Target |
|--------|--------|
| DOM rows rendered | Max 100 visible + 20 buffer (virtual scroll) |
| Render throttle | requestAnimationFrame, max 1 paint/frame |
| Row height | Fixed 28px (`--row-height`) for virtual scroll math |
| Stream backpressure | `BoundedChannelOptions(2000)`, `DropOldest` — frontend never blocks server |

**Transitions:**

```
panel.open.traffic ──[click on row / Enter]──▸ panel.open.traffic.detail
panel.open.traffic ──[press P / click Pause]──▸ panel.open.traffic.paused
panel.open.traffic ──[tab switch]──▸ panel.open.{other} (stream disposed)
panel.open.traffic ──[sidebar navigation]──▸ panel.hidden (stream disposed)
panel.open.traffic ──[SignalR disconnect]──▸ panel.open.traffic.disconnected
panel.open.traffic ──[filter change]──▸ panel.open.traffic (stream restart)
```

---

### 1.8 `panel.open.traffic.detail`

A traffic entry is selected, showing full request/response detail in a split view.

| Property | Value |
|----------|-------|
| **Entry conditions** | User clicks a traffic row or presses `Enter` on a focused row. |
| **Exit conditions** | (a) User presses `Escape` or clicks the row again (deselect). (b) User clicks a different row (detail changes). (c) User navigates away. |
| **Visual** | Content area splits: (1) Left 40% — traffic list (selected row highlighted with `--accent-dim` background). (2) Right 60% — detail panel. Resizable divider between them (see §3 Resize). Detail panel shows: Request section (method, URL, headers, body preview), Response section (status, headers, body preview), Timing section (total, DNS, TCP, TLS, TTFB, transfer), Chaos section (matched rules, actions applied — only if `chaosModified: true`). Vertical resize handle at the split boundary. |
| **Keyboard** | `Escape` — close detail (back to full traffic list). `↑/↓` — navigate to adjacent traffic entry (detail updates). `H` — toggle headers collapsed/expanded. `Ctrl+C` — copy selected section to clipboard (cURL format for request, raw for response). |
| **SignalR** | Same stream as `panel.open.traffic` — still running. New entries append to list; detail stays on selected entry. |
| **Data** | `_selectedTrafficEntry` — full `ChaosTrafficEvent` for the selected row. `_detailSplitRatio` — percentage for left/right split (default 40%, persisted to `_panelState`). |

**Transitions:**

```
panel.open.traffic.detail ──[Escape / deselect]──▸ panel.open.traffic
panel.open.traffic.detail ──[click different row]──▸ panel.open.traffic.detail (detail updates)
panel.open.traffic.detail ──[P key / Pause click]──▸ panel.open.traffic.detail.paused (stream paused, detail stays)
panel.open.traffic.detail ──[tab switch]──▸ panel.open.{other}
```

---

### 1.9 `panel.open.traffic.paused`

Traffic stream paused. Existing entries frozen, new entries buffered server-side.

| Property | Value |
|----------|-------|
| **Entry conditions** | User presses `P` or clicks the "Pause" button in traffic view. |
| **Exit conditions** | (a) User presses `P` again or clicks "Resume". (b) Tab switch (stream disposed regardless). |
| **Visual** | Same as `panel.open.traffic` but: (1) "Pause" button shows as "Resume" with a play icon (▸). (2) Amber banner at top of traffic list: "Traffic paused — new requests are still being intercepted but not displayed. Press P to resume." (3) Status bar throughput shows "Paused" instead of "{N} req/s". (4) List content is frozen — no new rows append. |
| **Keyboard** | `P` — resume (back to `panel.open.traffic`). All other shortcuts work on the frozen list. |
| **SignalR** | Stream **remains active** on the server side — we do NOT dispose the `ChannelReader`. The JS client simply stops reading from the stream iterator. On resume, it drains the buffered entries and catches up. This prevents a snapshot+live restart on every pause/resume. |
| **Data** | `_trafficPaused = true`. The `ChannelReader` is not disposed — entries buffer in the 2000-entry bounded channel. On resume, entries drain into the UI. If the buffer overflows during pause, oldest entries are dropped (server-side `DropOldest`). |

**Transitions:**

```
panel.open.traffic.paused ──[P key / Resume click]──▸ panel.open.traffic (drain buffer, catch up)
panel.open.traffic.paused ──[tab switch]──▸ panel.open.{other} (stream disposed)
panel.open.traffic.paused ──[click row]──▸ panel.open.traffic.detail (still paused, but detail opens)
```

---

### 1.10 `panel.open.recording`

Recording sub-view — shows past recordings and recording controls.

| Property | Value |
|----------|-------|
| **Entry conditions** | (a) User clicks "Recording" tab or `Alt+4`. |
| **Exit conditions** | Tab switch or sidebar navigation. |
| **Visual** | Tab bar: "Recording" tab active. Content: (1) Top controls: "Start Recording" button (primary), recording name input, filter config expander. (2) Recording list: table of past recordings — Name, Status badge, Entry count, Duration, Size, Date, Actions (export HAR, delete, review). (3) If a recording is active, the top area transforms into a live recording dashboard (see `panel.open.recording.active`). |
| **Keyboard** | `Alt+4` — activates this tab. `R` — start recording (opens recording config mini-dialog). `Enter` on recording row — review that recording (→ `panel.open.recording.reviewing`). |
| **SignalR** | Invokes `ChaosGetRecordings()` on entry to populate the list. Listens for `RecordingStarted`, `RecordingStopped` events to live-update the list. |
| **Data** | `_recordings[]` — array of `RecordingSession` metadata. Populated from `ChaosGetRecordings()`, updated by push events. |

**Transitions:**

```
panel.open.recording ──[Start Recording]──▸ panel.open.recording.active
panel.open.recording ──[click Review on a recording]──▸ panel.open.recording.reviewing
panel.open.recording ──[tab switch]──▸ panel.open.{other}
```

---

### 1.11 `panel.open.recording.active`

A recording session is in progress. Live counter ticks up.

| Property | Value |
|----------|-------|
| **Entry conditions** | (a) User starts a recording (`ChaosStartRecording`). (b) Panel opens and a recording is already active server-side (detected via `ChaosGetRecordings` showing `status: "recording"`). |
| **Exit conditions** | (a) User stops the recording. (b) Recording auto-stops (size/entry limit). (c) `RecordingStopped` event from server. |
| **Visual** | Top area replaces "Start Recording" with live dashboard: (1) Pulsing red recording dot + "Recording: {name}". (2) Live counters: entry count, elapsed time (ticking), estimated size. (3) "Stop Recording" destructive button. (4) Mini traffic preview — last 5 captured entries in compact format. (5) Tab badge: "Recording" tab shows a red dot indicator. (6) Status bar: recording icon (pulsing red ●) + entry count. |
| **Keyboard** | `R` — stop recording (same key, toggles). `Escape` — no-op (doesn't stop recording — too destructive for Escape). |
| **SignalR** | Listens for `RecordingEntry` events — increments counter, updates mini-preview. Throttle UI updates to max 5/sec. `RecordingStopped` event transitions out of this state. |
| **Data** | `_activeRecording` — `RecordingSession` object. `_recordingEntryCount` — live counter (from `RecordingEntry` events). `_recordingStartTime` — for elapsed timer (JS `setInterval` at 1s). |

**Recording indicator persistence:**

The recording dot in the status bar and the tab badge remain visible across ALL sub-view tabs. If the user switches to Rules while recording, the status bar still shows "● Recording: {name} — 423 entries". This is because recording is a background operation — it doesn't require the Recording tab to be active.

**Transitions:**

```
panel.open.recording.active ──[Stop click / R key]──▸ panel.open.recording (list refreshed, recording now in list)
panel.open.recording.active ──[RecordingStopped event (auto)]──▸ panel.open.recording (toast: "Recording stopped: {reason}")
panel.open.recording.active ──[tab switch while recording]──▸ panel.open.{other} (recording continues in background; status bar indicator persists)
panel.open.recording.active ──[sidebar navigation]──▸ panel.hidden (recording continues; sidebar badge shows recording icon)
```

---

### 1.12 `panel.open.recording.reviewing`

Reviewing a completed recording — HAR viewer.

| Property | Value |
|----------|-------|
| **Entry conditions** | User clicks "Review" on a completed recording in the list. |
| **Exit conditions** | (a) User clicks "Back to Recordings" breadcrumb. (b) User presses `Escape`. (c) Tab switch. |
| **Visual** | Breadcrumb: "Recordings ▸ {recording name}". Content: (1) Recording metadata header — name, date, duration, entry count, filter summary. (2) Traffic table — same layout as Traffic Monitor but showing recorded entries (not live). (3) Click to expand detail (same split-view as `panel.open.traffic.detail`). (4) Export button: "Export as HAR". (5) "Compare" button (future: diff two recordings). No live stream — data is static (loaded from `ChaosGetRecordingEntries` or fetched from JSONL). |
| **Keyboard** | `Escape` — back to recording list. `↑/↓` — navigate entries. `Enter` — expand detail. `Ctrl+E` — export HAR. |
| **SignalR** | Invokes `ChaosExportRecording(sessionId, "har")` for export. The recording entry data is fetched once and cached locally. |
| **Data** | `_reviewingSessionId` — which recording is being viewed. `_reviewEntries[]` — entries loaded from server. Virtual scroll for large recordings. |

**Transitions:**

```
panel.open.recording.reviewing ──[Escape / Back breadcrumb]──▸ panel.open.recording
panel.open.recording.reviewing ──[Export HAR]──▸ panel.open.recording.reviewing (triggers download, stays on page)
panel.open.recording.reviewing ──[tab switch]──▸ panel.open.{other}
```

---

### 1.13 `panel.minimized`

Panel collapsed to a thin header bar. Saves space while keeping Chaos accessible.

| Property | Value |
|----------|-------|
| **Entry conditions** | (a) User clicks the minimize chevron (▾) in the tab bar. (b) User presses `Ctrl+Shift+M` while Chaos view is active. |
| **Exit conditions** | (a) User clicks the expand chevron (▴). (b) User presses `Ctrl+Shift+M` again. (c) User clicks any tab in the collapsed tab bar. |
| **Visual** | Content area collapses. Only the tab bar + status bar remain visible (72px total height). Tab bar shows tab names but content area is `height: 0; overflow: hidden`. The remaining vertical space is reclaimed by the cockpit body (no content renders below — this isn't a bottom panel). Status bar still shows active rule count, kill switch state, recording indicator. |
| **Keyboard** | `Ctrl+Shift+M` — toggle minimize. Clicking a tab auto-expands. `Alt+1-4` — auto-expands to the target tab. |
| **SignalR** | If Traffic stream was active, it is **disposed** on minimize (bandwidth saving). Other subscriptions (chaos group) remain. |
| **Data** | `_minimized = true`. `_lastSubView` preserved. `_lastContentHeight` preserved for restore. |

**Transitions:**

```
panel.minimized ──[expand / tab click / Ctrl+Shift+M]──▸ panel.open.{_lastSubView}
panel.minimized ──[sidebar navigation away]──▸ panel.hidden
```

---

### 1.14 `panel.resizing`

User is dragging the detail split handle or the traffic/recording viewer resize divider.

| Property | Value |
|----------|-------|
| **Entry conditions** | User mousedown on a resize handle element (`.chaos-resize-handle`). |
| **Exit conditions** | User mouseup anywhere. |
| **Visual** | Resize handle gets `--accent` color highlight. A 1px guide line follows the cursor. The two panes resize live (no ghosting — direct resize for instant feedback). `user-select: none` and `cursor: col-resize` applied to `<body>` during drag. |
| **Keyboard** | Not keyboard-accessible (resize uses mouse drag only — follows existing detail panel pattern). |
| **SignalR** | No change — existing subscriptions continue. |
| **Data** | `_resizing = true`. On mouseup: new ratio saved to `_panelState.detailSplitRatio` and persisted to `localStorage('edog-chaos-panel-state')`. |

**Resize constraints:**

| Split | Min Left | Min Right | Default | Snap Points |
|-------|----------|-----------|---------|-------------|
| Traffic list ↔ Detail | 240px | 320px | 40% / 60% | 33%, 50%, 67% (snap within 8px) |

**Transitions:**

```
panel.resizing ──[mouseup]──▸ panel.open.traffic.detail (or whichever sub-state was active)
```

---

### 1.15 `panel.open.*.disconnected`

SignalR connection lost while the Chaos Panel is open. This is a **modifier state** that overlays any `panel.open.*` state.

| Property | Value |
|----------|-------|
| **Entry conditions** | SignalR `connection.onclose()` fires, or `setConnectionStatus('failed')` is called. |
| **Exit conditions** | SignalR reconnects (`connection.onreconnected()`). |
| **Visual** | (1) Status bar connection dot turns red, label: "Disconnected". (2) Amber overlay banner at top of content: "Connection lost — data may be stale. Reconnecting..." with a pulsing animation. (3) Traffic stream shows "Stream ended" marker at the end of the list. (4) All mutating actions (create/update/enable/disable rule) show inline disabled state with tooltip: "Reconnecting...". (5) Rule list data is frozen at last known state. |
| **Keyboard** | All shortcuts continue to work for navigation. Mutating actions show a toast: "Cannot perform action — connection lost." |
| **SignalR** | Auto-reconnect runs: `[0, 1000, 2000, 5000, 10000, 30000]` ms backoff. On reconnect: (1) Re-invoke `Subscribe('chaos')`. (2) Re-fetch `ChaosGetAllRules()` (state may have changed during disconnect). (3) If traffic was streaming, restart `ChaosSubscribeTraffic()` (fresh snapshot + live). (4) Check kill switch state. |
| **Data** | `_connectionStatus = 'disconnected'`. Stale data indicators shown. On reconnect, full state refresh — diff against cached state, animate changes. |

**Transitions:**

```
panel.open.*.disconnected ──[reconnect success]──▸ panel.open.* (state refreshed, banner dismissed)
panel.open.*.disconnected ──[reconnect failed after all retries]──▸ panel.open.*.failed (banner becomes: "Connection failed. Retry?" with manual retry button)
panel.open.*.disconnected ──[sidebar navigation]──▸ panel.hidden
```

---

## 2. Phase Awareness

The Chaos Panel has a **dual-phase** personality — unlike Runtime View which is Phase 2-only.

### Phase 1 (Disconnected — No FLT Service)

| Behavior | Detail |
|----------|--------|
| Sidebar icon | Visible, **enabled** (not greyed out like Runtime). Label: "Chaos". No lock icon. |
| View access | Fully accessible. User can open the Chaos view. |
| Available actions | Create rules, edit rules, delete rules, duplicate rules, browse presets, import rules from JSON, review past recordings. |
| Unavailable actions | Enable/activate rules (no engine to evaluate). Start recording (no traffic). View live traffic. Kill switch (nothing to kill). |
| Visual indicators | Status bar: "● Engine: offline — rules will activate when FLT connects". Enable toggles are present but show tooltip: "Connect to FLT to activate rules". Traffic tab shows empty state: "Connect to FLT to see live traffic". Recording tab "Start Recording" button disabled: "Connect to FLT to record traffic". |
| Rationale | Engineers configure chaos scenarios **before** deploying. The workflow is: (1) open EDOG Studio, (2) create chaos rules for the scenario you want to test, (3) deploy to lakehouse, (4) FLT connects → rules auto-evaluate against traffic. Pre-configuration is a key UX differentiator. |

### Phase 2 (Connected — FLT Running)

| Behavior | Detail |
|----------|--------|
| All actions available | Full CRUD, enable/disable, traffic streaming, recording, kill switch. |
| Phase transition animation | When FLT connects: (1) Status bar animates: "● Engine: offline" → "● Engine: idle" (green dot fade-in, same stagger as Runtime tab enabling). (2) Enable toggles become interactive. (3) If rules were pre-configured in Phase 1, a toast: "FLT connected — {N} draft rules ready to activate." |
| Disconnection during Phase 2 | See `panel.open.*.disconnected` (§1.15). Active rules continue server-side — the panel is just the control surface. |

### Phase transition (Connected → Disconnected)

When FLT drops:
1. Status bar: "● Engine: offline" (red dot).
2. Active rule badges freeze at last known state.
3. Traffic stream ends with "FLT disconnected" marker.
4. Recording auto-stops (server-side `RecordingStopped` with `reason: "flt_exit"`).
5. Panel does NOT navigate away — the user stays on whatever sub-view they were on. Rule definitions persist in the panel's local cache for review.

---

## 3. Resize Behavior

### Traffic Detail Split

| Property | Value |
|----------|-------|
| Handle | 4px wide, `cursor: col-resize`, centered on the split boundary |
| Min left (traffic list) | 240px |
| Min right (detail) | 320px |
| Default | 40% / 60% |
| Snap points | 33%, 50%, 67% — snap when cursor is within 8px of a snap boundary |
| Persistence | `localStorage('edog-chaos-panel-state').detailSplitRatio` |
| Animation | None during drag (direct resize). On initial open, split animates from 0% to default in 150ms. |
| Reduced motion | Skip open animation. Drag is always direct (no animation to respect). |

### No outer panel resize

The Chaos view occupies the full content area (like Runtime View). There is no resizable outer boundary — the view is always `flex: 1` filling all space between sidebar and viewport edge. This matches the existing architecture where `.view-panel.active` is `display: flex; height: 100%`.

---

## 4. Sub-View Navigation

### Tab Bar

4 tabs in a horizontal tab bar — identical component pattern to Runtime View's tab bar:

| Tab | Label | Shortcut | Icon |
|-----|-------|----------|------|
| Rules | "Rules" | `Alt+1` | List icon (≡) |
| Builder | "Builder" | `Alt+2` | Plus-square icon (⊞) |
| Traffic | "Traffic" | `Alt+3` | Activity/pulse icon (⌇) |
| Recording | "Recording" | `Alt+4` | Circle-dot icon (◉) |

- Sliding underline indicator (same CSS as `.rt-tab-indicator`).
- Tab labels are static — no dynamic rename (unlike Internals dropdown).
- Tab badges: Rules tab shows active count if > 0. Traffic tab shows live throughput. Recording tab shows red dot when recording is active.

### Breadcrumbs

Used only in nested states:

| State | Breadcrumb |
|-------|------------|
| `panel.open.builder.editing` | "Rules ▸ Edit: {rule name}" |
| `panel.open.recording.reviewing` | "Recordings ▸ {recording name}" |

Breadcrumbs render above the content area, below the status bar. Clicking a breadcrumb segment navigates back.

### No back button

We use breadcrumbs + Escape, not a ← back button. Reasoning: back buttons create ambiguous state in tab-based UIs. Is "back" the previous tab? The previous state within this tab? Breadcrumbs are explicit.

---

## 5. Kill Switch Visual Behavior

`Ctrl+Shift+K` is a **global** shortcut — it works regardless of which view or sub-view is active.

### Sequence on kill switch activation:

```
1. User presses Ctrl+Shift+K
   │
   ▼
2. Frontend: invoke ChaosKillSwitch() via SignalR
   │
   ▼
3. Server: atomically clears active rules, sets KillSwitchActive = true
   │
   ▼
4. Server: broadcasts KillSwitchActivated to ALL clients
   │
   ▼
5. Frontend (all views): receives KillSwitchActivated event
   │
   ├──▸ Top bar: kill switch indicator appears (red badge: "KILL ACTIVE")
   ├──▸ Chaos panel status bar: "● Kill: ACTIVE" in red
   ├──▸ If on rules view: kill overlay appears (§1.4)
   ├──▸ If on traffic view: "Kill switch activated" marker in traffic stream
   ├──▸ If on builder: submit buttons disabled
   └──▸ If panel.hidden: sidebar chaos icon shows red kill badge
```

### Reset sequence:

```
1. User navigates to Chaos Panel → Rules tab
2. Kill banner visible: "⚠ KILL SWITCH ACTIVE — All rules disabled. Engine locked."
3. User clicks "Reset Kill Switch"
4. Confirm dialog: "Reset the kill switch? Rules will remain paused. You must re-enable them individually."
5. User confirms
6. ChaosResetKillSwitch() → success
7. Kill banner dismissed
8. Top bar kill indicator removed
9. Rules show as "disabled-by-safety" (greyed, not auto-re-enabled)
10. User must manually re-enable each rule they want active
```

---

## 6. State Persistence

### What persists across page reload (localStorage)

| Key | Value | Default |
|-----|-------|---------|
| `edog-chaos-panel-state.lastSubView` | Last active sub-view tab ID | `'rules'` |
| `edog-chaos-panel-state.detailSplitRatio` | Traffic detail split percentage | `0.4` |
| `edog-chaos-panel-state.trafficFilter` | Last traffic filter config | `{}` (no filter) |
| `edog-chaos-panel-state.minimized` | Whether panel was minimized | `false` |

### What does NOT persist

| Data | Reason |
|------|--------|
| Builder form draft | Prevent stale half-edits across sessions. Fresh start on every page load. |
| Traffic entries | Too large. Re-fetched via snapshot on stream subscribe. |
| Rule list | Fetched from server on panel open (`ChaosGetAllRules`). Server is source of truth. |
| Selected traffic entry | Ephemeral selection state. |
| Recording review state | User navigates back into recordings list, picks again. |

---

## 7. Complete State Transition Diagram

```
                                    ┌──────────────┐
                            ┌──────▸│ panel.hidden │◂───────────────────────────┐
                            │       └──────┬───────┘                            │
                            │              │ sidebar click / key 5              │
                            │              ▼                                    │
                            │       ┌──────────────┐                            │
                            │       │panel.opening │                            │
                            │       └──────┬───────┘                            │
                            │              │ animation done                     │
                 sidebar    │              ▼                                    │
                 nav away   │  ┌───────────────────────────┐                   │ sidebar
                            │  │                           │                   │ nav away
                            │  │    panel.open.rules  ◂────┤◂── save/cancel    │
                            │  │                           │    from builder   │
                            ├──┤         │    │    │       │                   │
                            │  │         │    │    │       │                   │
                            │  │  Alt+2  │    │    │ E/Edit│                   │
                            │  │    │    │    │    │   │   │                   │
                            │  │    ▼    │    │    ▼   ▼   │                   │
                            │  │ builder │    │ builder    │                   │
                            │  │ (new)   │    │ (editing)  │                   │
                            │  │         │    │            │                   │
                            │  │         │    │            │                   │
                            │  │  Alt+3  │    │            │                   │
                            │  │    │    │    │            │                   │
                            │  │    ▼    │    │            │                   │
                            │  │ traffic ◂────┘            │                   │
                            │  │    │                      │                   │
                            │  │    │ click row            │                   │
                            │  │    ▼                      │                   │
                            │  │ traffic.detail            │                   │
                            │  │    │                      │                   │
                            │  │    │ P key                │                   │
                            │  │    ▼                      │                   │
                            │  │ traffic.paused            │                   │
                            │  │                           │                   │
                            │  │  Alt+4                    │                   │
                            │  │    │                      │                   │
                            │  │    ▼                      │                   │
                            │  │ recording                 │                   │
                            │  │    │                      │                   │
                            │  │    ├── Start ──▸ recording.active             │
                            │  │    │                      │                   │
                            │  │    └── Review ─▸ recording.reviewing          │
                            │  │                           │                   │
                            │  └───────────────────────────┘                   │
                            │              │                                    │
                            │              │ Ctrl+Shift+M                      │
                            │              ▼                                    │
                            │       ┌──────────────┐                            │
                            └───────│panel.minimized│───────────────────────────┘
                                    └──────────────┘

Cross-cutting modifiers (overlay any panel.open.* state):
  ──[KillSwitchActivated]──▸  *.killed
  ──[SignalR disconnect]──▸    *.disconnected
  ──[resize handle drag]──▸    panel.resizing
```

---

## 8. CSS Class Mapping

For the implementer — how states map to DOM classes:

| State | CSS Classes | DOM Target |
|-------|-------------|------------|
| `panel.hidden` | `.view-panel` (no `.active`) | `#view-chaos` |
| `panel.opening` | `.view-panel.active` (transition in progress) | `#view-chaos` |
| `panel.open.rules` | `.chaos-tab-content.active` | `#chaos-tab-rules` |
| `panel.open.builder` | `.chaos-tab-content.active` | `#chaos-tab-builder` |
| `panel.open.builder.editing` | `.chaos-tab-content.active.editing` | `#chaos-tab-builder` |
| `panel.open.traffic` | `.chaos-tab-content.active` | `#chaos-tab-traffic` |
| `panel.open.traffic.detail` | `.chaos-tab-content.active` + `.chaos-detail-open` | `#chaos-tab-traffic` |
| `panel.open.traffic.paused` | `.chaos-tab-content.active` + `.chaos-traffic-paused` | `#chaos-tab-traffic` |
| `panel.open.recording` | `.chaos-tab-content.active` | `#chaos-tab-recording` |
| `panel.open.recording.active` | `.chaos-tab-content.active` + `.chaos-recording-live` | `#chaos-tab-recording` |
| `panel.open.recording.reviewing` | `.chaos-tab-content.active` + `.chaos-recording-review` | `#chaos-tab-recording` |
| `panel.minimized` | `.chaos-panel-minimized` | `#view-chaos` |
| `*.killed` | `.chaos-kill-active` | `#view-chaos` (propagates to all children) |
| `*.disconnected` | `.chaos-disconnected` | `#view-chaos` |
| `panel.resizing` | `body.chaos-resizing` | `<body>` |

---

## 9. Keyboard Shortcut Summary

| Shortcut | Scope | Action |
|----------|-------|--------|
| `5` | Global (no modifier) | Switch to Chaos sidebar view |
| `Alt+1` | Chaos view active | Switch to Rules tab |
| `Alt+2` | Chaos view active | Switch to Builder tab |
| `Alt+3` | Chaos view active | Switch to Traffic tab |
| `Alt+4` | Chaos view active | Switch to Recording tab |
| `Ctrl+Shift+K` | **Global** (any view) | Kill switch — disable all chaos rules |
| `Ctrl+Shift+M` | Chaos view active | Toggle minimize |
| `N` | Rules tab active | New rule (go to Builder) |
| `E` | Rules tab, row focused | Edit rule |
| `Space` | Rules tab, row focused | Toggle rule enable/disable |
| `Delete` | Rules tab, row focused | Delete rule (with confirm) |
| `Enter` | Rules/Traffic tab, row focused | Expand detail |
| `Escape` | Builder or detail view | Go back / close detail |
| `Ctrl+Enter` | Builder active | Submit form |
| `P` | Traffic tab active | Toggle pause/resume |
| `C` | Traffic tab active | Clear traffic list |
| `F` | Traffic tab active | Focus filter search |
| `R` | Recording tab active | Start/stop recording |
| `H` | Traffic detail open | Toggle headers collapse |
| `Ctrl+C` | Traffic detail, section selected | Copy to clipboard |
| `Ctrl+E` | Recording review active | Export as HAR |

**Conflict avoidance:**

- `5` for Chaos view follows the existing `1`–`4` pattern in `sidebar.js._onKeyDown()`.
- `Alt+1-4` inside Chaos view mirrors `Alt+1-5` inside Runtime View (both use the same mechanism — scoped to active view).
- `Ctrl+Shift+K` is globally unique — no existing shortcut uses this combo.
- Single-key shortcuts (`N`, `E`, `P`, etc.) are scoped to specific sub-views and suppressed when focus is in `INPUT`, `TEXTAREA`, or `SELECT` elements.

---

## 10. Implementation Notes

### Follow Runtime View patterns exactly

The `ChaosPanel` class should mirror `RuntimeView`:

```javascript
class ChaosPanel {
  constructor(signalr) {
    this._signalr = signalr;
    this._tabs = {};               // tabId → { module, el }
    this._activeTab = 'rules';     // default
    this._phase = 'disconnected';
    this._killSwitchActive = false;
    this._minimized = false;
    this._rules = [];
    this._trafficStream = null;
    this._panelState = {};         // persisted to localStorage
  }

  init() { /* Cache DOM, bind tabs, bind keyboard, restore state */ }
  registerTab(tabId, module) { /* Same as RuntimeView.registerTab */ }
  switchTab(tabId) { /* Same lifecycle: deactivate/activate with transitions */ }
  setPhase(phase) { /* Phase 1 ↔ Phase 2 transitions */ }
  setConnectionStatus(status) { /* Mirror RuntimeView.setConnectionStatus */ }

  // Chaos-specific
  onKillSwitch(event) { /* Handle KillSwitchActivated */ }
  onRuleEvent(event) { /* Handle RuleCreated/Updated/Deleted/Fired */ }
  onRecordingEvent(event) { /* Handle RecordingStarted/Stopped/Entry */ }
}
```

### Sidebar integration

Add to `sidebar.js`:
- New nav item: `data-view="chaos"`, `data-phase="all"` (available in both phases).
- Badge shows active rule count when > 0 (amber), kill switch active (red), recording active (pulsing red dot).
- Keyboard `5` mapped in `_onKeyDown()` (extend the existing `views` array).

### Status bar (always visible inside Chaos view)

32px bar below the tab bar, always present. Contains:

| Segment | Content | Update Frequency |
|---------|---------|-----------------|
| Engine status | `● Engine: {idle/active/offline/locked}` | On phase change or rule state change |
| Active rules | `{N} active rules` | On `RuleUpdated` events |
| Kill switch | `Kill: off` / `Kill: ACTIVE` (red) | On `KillSwitchActivated` / reset |
| Recording | `● Recording: {name} — {N} entries` (pulsing red) | On `RecordingEntry` events (throttled 5/sec) |
| Connection | `Connected` / `Reconnecting...` / `Disconnected` | On connection state change |

---

*End of panel shell state matrix. This document is sufficient for implementation without mockups.*
