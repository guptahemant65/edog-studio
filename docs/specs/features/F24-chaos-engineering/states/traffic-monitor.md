# Traffic Monitor — Complete UX State Matrix

> **Feature:** F24 Chaos Engineering Panel — Section 2.3 Traffic Monitor
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Frontend Engineer) + Sana Reeves (Architecture)
> **Date:** 2026-07-29
> **Depends On:** `signalr-protocol.md` (ChaosTrafficEvent, ChaosSubscribeTraffic), `C05-observability.md` (recording, HAR export)
> **States Documented:** 85+

---

## How to Read This Document

Every state is documented as:

```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

Prefix key:
- `TM-CONN-*` — SignalR connection lifecycle for traffic stream
- `TM-STRM-*` — Live streaming, rendering, auto-scroll, virtual scroll
- `TM-PAUSE-*` — Paused/frozen stream states
- `TM-FILT-*` — Filter bar, text search, column filters
- `TM-ROW-*` — Row hover, selection, keyboard navigation
- `TM-DTL-*` — Detail panel (request/response/timing/chaos tabs)
- `TM-COL-*` — Column layout, resize, reorder
- `TM-EXP-*` — Export (HAR/JSON/CSV)
- `TM-CMP-*` — Request comparison (diff two entries)
- `TM-REC-*` — Recording indicator integration
- `TM-BUF-*` — Buffer overflow, memory management
- `TM-EMPTY-*` — Empty/zero-match states

---

## 0. Column Layout Specification

### 0.1 Default Columns

| # | Column | Default Width | Min Width | Resizable | Sortable | Description |
|---|--------|--------------|-----------|-----------|----------|-------------|
| 1 | `#` | 48px | 48px | No | By sequence | Monotonic sequence number from `TopicEvent.sequenceId` |
| 2 | Time | 90px | 72px | Yes | By timestamp | `HH:mm:ss.SSS` from `timestamp`. Hover tooltip: full ISO 8601 |
| 3 | Method | 56px | 48px | No | Alphabetic | HTTP method badge: `GET` `PUT` `POST` `DELETE` `PATCH` `HEAD` `OPTIONS` |
| 4 | Status | 48px | 48px | No | Numeric | HTTP status code, color-coded pill (see §0.3) |
| 5 | URL | flex (1fr, min 200px) | 200px | Yes | Alphabetic | Truncated with ellipsis. SAS-redacted. Monospace. Hover: full URL tooltip |
| 6 | Duration | 72px | 56px | Yes | Numeric | `durationMs` formatted: `<1s`: `145ms`, `1-10s`: `3.0s`, `>10s`: `14s` (red) |
| 7 | Size | 64px | 48px | Yes | Numeric | `responseBodySize` formatted: bytes/KB/MB. `-1` shows `--` |
| 8 | Client | 120px | 80px | Yes | Alphabetic | `httpClientName` truncated. Tooltip: full name |
| 9 | Chaos | 28px | 28px | No | Boolean | Chaos indicator: `◆` icon if `chaosModified: true`, empty if false |

### 0.2 Column Behavior

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-COL-001 | Default layout | Traffic Monitor opened | All 9 columns at default widths. URL column takes remaining space (flex). Column headers: uppercase, 11px, `--color-text-tertiary`, 600 weight | TM-COL-002 |
| TM-COL-002 | Column resize drag | Mousedown on column resize handle (2px right border) | Cursor changes to `col-resize`. Drag ghost line (1px accent) follows cursor. Adjacent columns adjust in real-time. Minimum widths enforced — handle stops at min | TM-COL-003 |
| TM-COL-003 | Column resize committed | Mouseup after drag | Widths persist to `localStorage` key `edog.trafficMonitor.columnWidths`. Table re-renders with new proportions | TM-COL-001 |
| TM-COL-004 | Column header click — sort | Click column header (except `#` and Chaos) | Sort indicator appears: `▲` ascending (first click), `▼` descending (second click), removed (third click restores sequence order). Existing rows re-sort with 150ms transition. New incoming rows insert in sorted position. Active sort column header: accent color | TM-COL-001 |
| TM-COL-005 | Reset columns | Right-click column header → "Reset Column Widths" | All columns snap to default widths (200ms ease). `localStorage` key cleared | TM-COL-001 |

### 0.3 Color Coding

**Status code pills** (OKLCH, dark theme):

| Range | Color | Token | Text | Background |
|-------|-------|-------|------|------------|
| 1xx | Blue-grey | `--color-status-info` | `oklch(0.80 0.04 250)` | `oklch(0.25 0.03 250)` |
| 2xx | Green | `--color-status-success` | `oklch(0.82 0.14 145)` | `oklch(0.28 0.06 145)` |
| 3xx | Teal | `--color-status-redirect` | `oklch(0.78 0.10 190)` | `oklch(0.26 0.05 190)` |
| 4xx | Amber | `--color-status-client-error` | `oklch(0.82 0.14 80)` | `oklch(0.30 0.08 80)` |
| 5xx | Red | `--color-status-server-error` | `oklch(0.80 0.16 25)` | `oklch(0.28 0.08 25)` |
| 0 (blocked/timeout) | Magenta | `--color-status-blocked` | `oklch(0.78 0.16 330)` | `oklch(0.26 0.08 330)` |

**Chaos-affected row highlight:**

| Condition | Row Style |
|-----------|-----------|
| `chaosModified: false` | Default row background |
| `chaosModified: true` | Left border: 3px solid `oklch(0.72 0.18 300)` (chaos accent). Background: `oklch(0.20 0.02 300 / 0.15)`. Chaos column: `◆` in chaos accent |
| Row selected + chaos | Left border stays chaos-colored. Selection highlight overlays on top |

**Method badges** (compact, no background — text color only):

| Method | Color |
|--------|-------|
| `GET` | `oklch(0.80 0.10 145)` (green) |
| `POST` | `oklch(0.80 0.10 250)` (blue) |
| `PUT` | `oklch(0.80 0.10 80)` (amber) |
| `DELETE` | `oklch(0.80 0.14 25)` (red) |
| `PATCH` | `oklch(0.80 0.10 190)` (teal) |
| `HEAD` / `OPTIONS` | `oklch(0.60 0.02 260)` (muted) |

**Duration color thresholds:**

| Range | Color |
|-------|-------|
| < 200ms | Default text color |
| 200ms–1s | `oklch(0.82 0.14 80)` (amber) |
| 1s–5s | `oklch(0.80 0.16 50)` (orange) |
| > 5s | `oklch(0.80 0.16 25)` (red), bold weight |

---

## 1. CONNECTION STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-CONN-001 | Connecting | User opens Traffic Monitor sub-view; `ChaosSubscribeTraffic(filter)` called | Connection indicator in toolbar: amber dot + "Connecting..." with 3-dot pulse animation. Main area: centered spinner (16px, accent) + "Subscribing to traffic stream...". Toolbar controls dimmed at 40% opacity except filter input (pre-fillable) | TM-CONN-002, TM-CONN-005 |
| TM-CONN-002 | Connected — snapshot loading | SignalR stream opened; server sending snapshot from `http` topic ring buffer | Spinner replaces text: "Loading history... (847 entries)". Counter increments as snapshot entries arrive. Rows begin populating table from top (batched: 200 entries/frame to avoid jank) | TM-CONN-003 |
| TM-CONN-003 | Connected — live | Snapshot complete, live events flowing | Connection indicator: green dot + throughput counter (e.g., "24 req/s"). Spinner removed. Auto-scroll active. All toolbar controls enabled. Toast: "Traffic stream active" (auto-dismiss 2s) | TM-STRM-* |
| TM-CONN-004 | Disconnected — reconnecting | SignalR connection drops (network, FLT restart) | Connection indicator: amber dot + "Reconnecting (2/10)..." with retry count. Existing rows remain visible at 80% opacity. Top banner: amber, "Connection lost — reconnecting automatically. Data below may be stale." Throughput counter: "-- req/s" | TM-CONN-002, TM-CONN-005 |
| TM-CONN-005 | Disconnected — failed | 10 reconnect attempts exhausted | Connection indicator: red dot + "Offline". Top banner: red, "Traffic stream disconnected" + "EdogLogServer may not be running" + [Reconnect] button. Existing rows remain visible (stale), full opacity restored. Filter/sort/export still functional on cached data. Keyboard nav still works | TM-CONN-001 (manual) |
| TM-CONN-006 | Reconnected — gap detected | Reconnection succeeds but `sequenceId` gap detected | Banner: blue, "Reconnected — {N} events may have been missed during disconnection". New snapshot merges with existing entries. Duplicate `sequenceId` entries are deduplicated (server-side sequence is authoritative). Gap marker row inserted: dashed line + "~{N} events not captured" | TM-CONN-003 |
| TM-CONN-007 | Throughput — normal | Connected, < 50 req/sec | Throughput counter: default text, updates every 1s. Number change animates (roll, 200ms) | — |
| TM-CONN-008 | Throughput — high | > 50 req/sec sustained for 3s | Throughput counter turns amber. Tooltip: "High throughput — virtual scroll active" | TM-STRM-010 |
| TM-CONN-009 | Throughput — extreme | > 200 req/sec sustained for 5s | Throughput counter turns red: "412 req/s ▲". Auto-enables render throttle: only every 3rd row renders immediately, rest batch at 16ms intervals. Sampling indicator appears: "Rendering 1:3" | TM-STRM-011 |
| TM-CONN-010 | Throughput — idle | Connected, 0 req/sec for > 15s | Throughput: "0 req/s" dimmed. After 30s: "(idle)" appended. Not an error — FLT may be between DAG executions | — |

---

## 2. STREAMING STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-STRM-001 | Empty stream | Connected, no traffic events received (snapshot empty, no live events) | Centered empty state: network icon (muted, 48px) + "No HTTP traffic yet" + "Trigger a DAG execution or API call in FLT to see traffic here" + "Or check that chaos rules are configured if filtering by chaos-affected only". Toolbar visible, controls dimmed except connection indicator and filter bar | TM-STRM-002 |
| TM-STRM-002 | First entry arrives | First `ChaosTrafficEvent` received | Empty state fades out (150ms). Column headers slide in from top (100ms). First row fades in (200ms). Toolbar controls enable. Level filter counts start at 1 | TM-STRM-003 |
| TM-STRM-003 | Streaming — normal | Events arriving at <= 50/sec | Rows append at bottom. Each row renders inline: `#`, time, method badge, status pill, URL (truncated), duration, size, client name, chaos indicator. Smooth append animation (row slides up from below, 100ms ease-out). Auto-scroll keeps newest visible | TM-STRM-004, TM-STRM-005 |
| TM-STRM-004 | Auto-scroll active | User is at scroll bottom (within 50px of end) | Bottom-right indicator lit: "Auto-scroll ●" in accent color. New rows smoothly scroll into view — no jumps. Scrollbar thumb tracks position. If detail panel is open, auto-scroll pauses (see TM-DTL-*) | TM-STRM-005 |
| TM-STRM-005 | Auto-scroll off | User scrolls up (> 50px from bottom) | Indicator dims: "Auto-scroll ○". New rows append to DOM below viewport (not visible). Floating pill at bottom-right: "↓ 47 new" with live counter, accent background. Click pill or press `End` → jump to bottom, re-enable auto-scroll | TM-STRM-004 |
| TM-STRM-006 | Scroll position preserved | User is reading historical entries while stream continues | Scroll position locked to current viewport. Scrollbar thumb shrinks as new entries extend total height. New-entry pill counter increments. No forced scroll, no layout shift of visible rows | TM-STRM-005 |
| TM-STRM-007 | Jump to bottom | Click "↓ N new" pill, or press `End` key | Smooth scroll to bottom (300ms ease-out). Pill fades out. Auto-scroll re-enables. If > 500 new entries since last view: instant jump (no animation — would be too slow) | TM-STRM-004 |
| TM-STRM-008 | Jump to top | Press `Home` key | Smooth scroll to first entry (300ms ease-out). Auto-scroll disables. "↓ N new" pill appears | TM-STRM-005 |

### 2.1 High-Frequency Rendering (> 100 req/sec)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-STRM-010 | Virtual scroll engaged | Entry count exceeds 500 OR throughput > 100 req/sec | Rendering switches from full-DOM to virtual scroll. Only visible rows + 20-row overscan buffer are in DOM. Scroll performance stays smooth. Row height: fixed 32px (required for virtual scroll math). No visual change — seamless transition | TM-STRM-011 |
| TM-STRM-011 | Render throttle active | Throughput > 200 req/sec sustained 5s | Batch rendering: accumulate entries in memory, flush to DOM every 16ms (one rAF). Rows appear in clusters. Toolbar badge: "Throttled" in amber. Tooltip: "Batching render at 60fps to maintain responsiveness. All entries are captured — only rendering is deferred." | TM-STRM-012 |
| TM-STRM-012 | Render throttle — burst complete | Throughput drops below 100 req/sec for 5s | "Throttled" badge fades out (300ms). Rendering returns to per-event mode. Any buffered entries flush immediately | TM-STRM-003 |
| TM-STRM-013 | Frame budget exceeded | Single rAF frame takes > 12ms for row rendering | Drop to skeleton rows: show `#`, time, method only. Full row content renders on next idle frame (`requestIdleCallback`). Prevents dropped frames during sustained bursts | TM-STRM-011 |

### 2.2 Buffer Management

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-BUF-001 | Buffer normal | Entry count < 8,000 | No indicator. Memory usage nominal | TM-BUF-002 |
| TM-BUF-002 | Buffer warning | Entry count reaches 8,000 (80% of 10,000 max) | Subtle indicator in toolbar: "8,000 / 10,000" in amber text. Tooltip: "Oldest entries will be dropped when buffer is full. Export or start a recording to preserve traffic." | TM-BUF-003 |
| TM-BUF-003 | Buffer full — dropping oldest | Entry count at 10,000; new entries push oldest out | Indicator turns red: "10,000 (dropping oldest)". First visible row may disappear if user is viewing oldest entries — scroll position adjusts to compensate (no jarring jump). If user has selected a row that gets dropped: selection clears, detail panel closes with toast "Selected entry was dropped from buffer" | TM-BUF-001 (after drop) |
| TM-BUF-004 | Buffer cleared | User clicks "Clear" button (🗑) or presses `Ctrl+L` | All rows removed with fade-out (150ms). Sequence counter resets visually (server sequence continues). Empty state TM-STRM-001 shown briefly until next event arrives. Toast: "Traffic buffer cleared ({N} entries removed)" | TM-STRM-001 |
| TM-BUF-005 | Buffer full + recording active | Buffer at 10,000 but recording is capturing to disk | Indicator: "10,000 (dropping oldest) · Recording preserves all". Color: amber (not red) since data is being persisted. User can still scroll to see the last 10K entries; full history is in the recording file | TM-BUF-003 |

---

## 3. PAUSE STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-PAUSE-001 | Paused | Click Pause button (⏸) in toolbar, or press `Space` (when no text input focused) | Pause button toggles to Play (▶). "PAUSED" badge: amber pill, top-left of table area. Stream freezes visually — new events buffer in memory. Badge shows buffer count: "PAUSED · 142 buffered". Toolbar background gets subtle amber tint (`oklch(0.22 0.03 80)`). All existing rows remain interactive — filter, sort, select, export still work on frozen snapshot | TM-PAUSE-002, TM-PAUSE-003 |
| TM-PAUSE-002 | Resuming | Click Play (▶) or press `Space` | Badge: "Flushing..." (brief). Buffered entries render in batches (200/frame). If > 1000 buffered: virtual scroll handles the bulk insert without jank. Badge disappears when buffer empty. Play toggles back to Pause | TM-STRM-003 |
| TM-PAUSE-003 | Paused — buffer overflow | Paused for > 120s or pause buffer exceeds 5,000 entries | Badge turns red: "PAUSED · 5,000+ buffered — oldest will be dropped". After 10,000 in pause buffer: oldest silently discarded. Tooltip: "Resume to see latest traffic. Paused buffer is at capacity." | TM-PAUSE-002 |
| TM-PAUSE-004 | Paused — detail open | User pauses, then clicks a row to inspect | Pause persists. Detail panel opens (TM-DTL-*). User can freely browse request/response/timing of any frozen row. Ideal workflow: pause → inspect → navigate with j/k → resume | TM-PAUSE-002 |
| TM-PAUSE-005 | Auto-pause on selection | User clicks a row while streaming (not paused) | Stream does NOT auto-pause (deliberate decision — matches Chrome DevTools behavior). Detail panel opens. New rows continue appending. Selected row stays highlighted and anchored. If selected row scrolls out of viewport: floating indicator at top: "▲ Selected: GET /api/fabric/..." — click to scroll back | TM-STRM-003 |

---

## 4. FILTER STATES

### 4.1 Filter Bar

The filter bar sits between the toolbar and the column headers. Always visible. Contains:
- Text search input (full-width, left)
- Method dropdown multi-select
- Status range dropdown
- Client name dropdown
- Chaos-only toggle
- Clear filters button

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-FILT-001 | No filters active | Default state | Filter bar: text input placeholder "Filter by URL, header, body... (Ctrl+F)", all dropdowns showing "All". No active filter indicator. Full entry count shown in status bar: "2,847 entries" | TM-FILT-002 |
| TM-FILT-002 | Text search focused | Click filter input or press `Ctrl+F` | Input gets focus ring (accent). Placeholder clears. As user types, results filter in real-time (debounced 150ms). Search scans: URL, `httpClientName`, `correlationId`, request/response header values, body previews | TM-FILT-003 |
| TM-FILT-003 | Text search active | User typed a query, results filtered | Active filter pill appears right of input: "url: onelake" (removable with ✕). Status bar: "142 / 2,847 entries" — matched count / total. Non-matching rows hidden (not dimmed — hidden). Virtual scroll recalculates for filtered set. If 0 matches: TM-EMPTY-001 | TM-FILT-001 (clear), TM-EMPTY-001 |
| TM-FILT-004 | Text search — regex mode | User prefixes query with `/` (e.g., `/onelake\\.dfs.*Tables/`) | Input border changes to teal (regex indicator). Regex compiled on each keystroke (debounced 300ms). Invalid regex: input border turns red, tooltip shows error. Valid regex: filter applies immediately | TM-FILT-003 |
| TM-FILT-005 | Method filter active | Click Method dropdown, check/uncheck methods | Dropdown: checkboxes for GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS. Checked items filter traffic. Pill: "method: GET, PUT". Unchecked methods' rows hidden. Dropdown stays open until click-outside or Escape | TM-FILT-003 |
| TM-FILT-006 | Status filter active | Click Status dropdown, select range | Options: "All", "2xx", "3xx", "4xx", "5xx", "Errors (4xx+5xx)", "Custom range..." Custom range: two number inputs (min, max). Pill: "status: 4xx-5xx" | TM-FILT-003 |
| TM-FILT-007 | Client filter active | Click Client dropdown | Lists all unique `httpClientName` values seen in current buffer, sorted by frequency. Checkboxes. Pill: "client: OneLakeRestClient" | TM-FILT-003 |
| TM-FILT-008 | Chaos-only toggle | Click "Chaos ◆" toggle button | Toggle active: button fills with chaos accent color. Only rows where `chaosModified: true` shown. Pill: "chaos-affected only". Powerful for isolating which traffic your rules are hitting | TM-FILT-003 |
| TM-FILT-009 | Multiple filters active | Two or more filter types active simultaneously | Filters combine with AND logic. Multiple pills shown. Status bar: "23 / 2,847 entries (3 filters active)". Clear all: click "Clear filters" or press `Escape` when filter input is empty | TM-FILT-001 |
| TM-FILT-010 | Clear single filter | Click ✕ on a filter pill | That filter removed. Remaining filters re-evaluate. Row count updates | TM-FILT-003 or TM-FILT-001 |
| TM-FILT-011 | Clear all filters | Click "Clear filters" button or `Escape` (when filter input focused and empty) | All pills removed. All dropdowns reset to "All". Toggle deactivated. Full entry set visible again. Smooth transition (rows fade in, 150ms) | TM-FILT-001 |
| TM-FILT-012 | Filter persists across pause/resume | User sets filter, then pauses, then resumes | Filter remains active. Resumed entries are filtered as they arrive. No filter state lost | TM-FILT-003 |
| TM-FILT-013 | Column header quick filter | Right-click a cell value → "Filter to this value" | Adds filter for that column's value. E.g., right-click "429" in Status column → status filter set to 429. Right-click URL → text filter set to that URL substring | TM-FILT-003 |
| TM-FILT-014 | Negative filter | Right-click a cell value → "Exclude this value" | Adds exclusion filter (prefixed with `-`). Pill: "status: -429". Hides rows matching that value | TM-FILT-003 |

### 4.2 Empty Filter Results

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-EMPTY-001 | No matches | Active filter returns 0 results from current buffer | Table body replaced with centered message: search icon (muted) + "No traffic matches your filter" + active filter pills repeated below + [Clear Filters] button. Status bar: "0 / 2,847 entries". Column headers remain visible | TM-FILT-001 (clear) |
| TM-EMPTY-002 | No matches — streaming continues | Filter active, 0 current matches, but new events arriving | Same empty state but with subtle pulse on the throughput counter to indicate traffic is flowing (just not matching). If a new event matches the filter: row appears immediately, empty state fades out | TM-STRM-002 |
| TM-EMPTY-003 | No matches — chaos-only with no rules | Chaos-only toggle active but no chaos rules are enabled | Enhanced message: search icon + "No chaos-affected traffic" + "No chaos rules are currently active. Create rules in the Rule Builder to see affected traffic here." + [Open Rule Builder] button | TM-FILT-001 |

---

## 5. ROW INTERACTION STATES

### 5.1 Hover

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-ROW-001 | Row hover | Mouse enters a row | Row background lightens: `oklch(0.22 0.01 260)`. URL column shows full URL in a truncation-safe way (still single line but scroll reveal on hover, or tooltip after 500ms). If chaos-modified: left border brightens to full opacity | TM-ROW-002 |
| TM-ROW-002 | Row hover — preview tooltip | Mouse hovers on row for > 500ms | Rich tooltip (300px wide, max 200px tall) appears below cursor: summary card showing Method + full URL (wrapped) + Status badge + Duration + matched chaos rules (if any). No click required. Tooltip dismisses on mouse-out | TM-ROW-001 |
| TM-ROW-003 | Row hover — chaos indicator | Mouse hovers over `◆` in Chaos column | Tooltip: list of matched rule names, e.g., "Matched: [OneLake Outage] Blackhole all writes, Delay Spark calls 2s". Click to jump to Chaos detail tab | TM-DTL-040 |

### 5.2 Selection and Keyboard Navigation

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-ROW-010 | Row selected | Click a row, or press `Enter` on focused row | Row gets selection highlight: `oklch(0.24 0.04 250)` background, left border 3px accent (or chaos-accent if chaos-modified). Detail panel opens at bottom (split horizontal) or right (split vertical, user preference in settings). Previous selection deselected | TM-DTL-001 |
| TM-ROW-011 | Keyboard focus | Press `j` or `↓` to move down, `k` or `↑` to move up | Focus ring (2px accent outline, -2px offset) moves between rows. Focused row is distinct from selected row: focus ring = navigation, selection = detail panel target. Scroll follows focus — focused row always visible within viewport | TM-ROW-010 (Enter to select) |
| TM-ROW-012 | Navigate — first/last | `Home` (first row), `End` (last row) | Focus jumps. Scroll follows. If `End` and auto-scroll was off: auto-scroll re-enables | TM-ROW-011 |
| TM-ROW-013 | Navigate — page | `PageUp` / `PageDown` | Focus moves by visible-row-count (typically ~20 rows). Scroll follows | TM-ROW-011 |
| TM-ROW-014 | Navigate — next error | `e` key | Focus jumps to next row with `statusCode >= 400`. Wraps around at end. If no errors: status bar flash "No error responses in current view" | TM-ROW-011 |
| TM-ROW-015 | Navigate — next chaos | `c` key | Focus jumps to next row with `chaosModified: true`. Wraps. If none: status bar flash "No chaos-affected entries in current view" | TM-ROW-011 |
| TM-ROW-016 | Multi-select for comparison | `Ctrl+Click` a second row (while one is selected) | Two rows highlighted. Toolbar shows: "2 selected — [Compare]" button enabled. Both rows get selection highlight. Detail panel stays on first selected | TM-CMP-001 |
| TM-ROW-017 | Deselect | Press `Escape` or click empty area | Selection cleared. Detail panel closes (slide-down 200ms). Focus remains on last focused row | TM-STRM-003 |
| TM-ROW-018 | Selection — entry scrolled off | Selected entry is far from viewport (user scrolled away) | Floating indicator at appropriate edge (top or bottom): "▲ Selected: PUT /api/onelake/... (503)" or "▼ Selected: GET ...". Click indicator to scroll back to selected row | TM-ROW-010 |

### 5.3 Context Menu

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-ROW-020 | Context menu | Right-click a row | Context menu appears at cursor: Copy URL · Copy as cURL · Copy as PowerShell · Copy response body · ──── · Filter to this URL · Filter to this status · Filter to this client · Exclude this URL · ──── · Compare with... (starts comparison mode) · ──── · Open in detail | TM-ROW-021, TM-FILT-013 |
| TM-ROW-021 | Copy as cURL | Click "Copy as cURL" in context menu | Generates: `curl -X PUT 'https://...' -H 'Content-Type: ...' -H 'Authorization: [redacted]'`. Copied to clipboard. Toast: "Copied cURL command". Headers reconstructed from `requestHeaders`. Body NOT included (only preview available) | — |
| TM-ROW-022 | Copy as PowerShell | Click "Copy as PowerShell" in context menu | Generates: `Invoke-WebRequest -Uri '...' -Method PUT -Headers @{...}`. Copied to clipboard. Toast: "Copied PowerShell command" | — |
| TM-ROW-023 | Copy response body | Click "Copy response body" | Copies `responseBodyPreview` to clipboard. If `null` (binary): toast "Response body is binary — cannot copy preview". If truncated (> 4KB original): toast "Copied response body preview (first 4KB)" | — |

---

## 6. DETAIL PANEL STATES

The detail panel appears when a row is selected. It occupies the bottom third of the Traffic Monitor area (horizontal split, resizable). Contains tabs: Request · Response · Timing · Chaos.

### 6.1 Panel Chrome

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-DTL-001 | Panel opening | Row selected (TM-ROW-010) | Panel slides up from bottom (200ms ease-out). Height: 33% of Traffic Monitor area (min 200px, max 60%). Resize handle (4px) at top border. Tab bar at top of panel: Request · Response · Timing · Chaos. Default tab: Response (most common inspection target) | TM-DTL-010 |
| TM-DTL-002 | Panel — tab switch | Click tab or press `1`-`4` (when panel focused) | Tab underline slides to new position (150ms). Content crossfades (100ms out, 150ms in). `1`=Request, `2`=Response, `3`=Timing, `4`=Chaos | TM-DTL-010/020/030/040 |
| TM-DTL-003 | Panel — resize | Drag resize handle at top of panel | Panel height adjusts. Table area above shrinks/grows inversely. Minimum: 200px. Maximum: 60% of monitor area. Height persists to `localStorage` | TM-DTL-001 |
| TM-DTL-004 | Panel — close | Click ✕ on panel, or press `Escape` | Panel slides down (200ms). Table area reclaims full height. Row remains visually selected (highlight) but no panel. Press `Enter` to re-open | TM-ROW-017 |
| TM-DTL-005 | Panel — navigate while open | Press `j`/`k` to change focused row, then `Enter` | Panel content updates to new row's data. Tab selection preserved. Crossfade on content (100ms). Header updates: "PUT /api/onelake/... → 503 · 3045ms" | TM-DTL-010/020/030/040 |
| TM-DTL-006 | Panel — quick navigate | Press `j`/`k` while panel open (without Enter) | Focus ring moves in table. Panel stays on currently selected row (not focused row). `Enter` switches panel to focused row | TM-DTL-005 |
| TM-DTL-007 | Panel — orientation toggle | Click layout toggle icon in panel header (⬒ / ⬓) | Toggles between horizontal split (panel at bottom) and vertical split (panel at right). Preference persists to `localStorage`. Vertical split: panel width 40%, min 300px | TM-DTL-001 |

### 6.2 Request Tab

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-DTL-010 | Request — headers | Tab 1 (Request) active | **Header section**: full URL (monospace, word-wrap, selectable). Below: Method badge + URL. Below: table of request headers (Name · Value columns, monospace). `Authorization` value: `[redacted]` in muted text. "Copy headers" button (top-right). Section label: "Request Headers ({count})" | TM-DTL-011 |
| TM-DTL-011 | Request — body | Scroll down in Request tab, or body section exists | **Body section** (below headers): If `requestBodyPreview` is non-null: syntax-highlighted JSON (or raw text). Line numbers in gutter. If preview is truncated: amber bar at bottom: "Body truncated to first 4KB of {requestBodySize} total". Copy button. If `null`: muted text: "No request body" or "Binary content ({requestBodySize} bytes)" | — |
| TM-DTL-012 | Request — empty body | `requestBodyPreview` is null, `requestBodySize` is 0 or -1 | Body section: "No request body" centered, muted | — |
| TM-DTL-013 | Request — binary body | `requestBodyPreview` is null, `requestBodySize` > 0 | Body section: file icon + "Binary content" + formatted size (e.g., "1.0 MB") + "Body preview unavailable for binary content" | — |
| TM-DTL-014 | Request — JSON body | `requestBodyPreview` is valid JSON | Body section: auto-formatted (pretty-printed) with syntax highlighting. OKLCH colors: keys in `oklch(0.78 0.12 250)`, strings in `oklch(0.78 0.12 145)`, numbers in `oklch(0.78 0.12 80)`, booleans in `oklch(0.78 0.12 300)`, null in `oklch(0.60 0.02 260)`. Collapsible objects/arrays (click `{` or `[` to fold) | — |

### 6.3 Response Tab

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-DTL-020 | Response — headers | Tab 2 (Response) active | **Status line**: large status badge + status text (e.g., "503 Service Unavailable") + HTTP version. Color-coded per §0.3. Below: response headers table (same format as request). "Copy headers" button | TM-DTL-021 |
| TM-DTL-021 | Response — body | Scroll down or body section present | Same layout as request body (TM-DTL-011–014) but for `responseBodyPreview`. JSON: syntax highlighted, collapsible. Truncation warning if applicable. Copy button | — |
| TM-DTL-022 | Response — error body | `statusCode` >= 400 and body contains error JSON | Error body gets enhanced display: error code extracted and shown as red badge above body. Common Fabric error patterns (`{"error":{"code":"...","message":"..."}}`) are parsed and message shown prominently | — |
| TM-DTL-023 | Response — empty | `responseBodyPreview` null, `responseBodySize` 0 | "Empty response body" centered, muted. Common for 204, 304 responses | — |

### 6.4 Timing Tab

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-DTL-030 | Timing — waterfall | Tab 3 (Timing) active | **Single-bar waterfall**: horizontal bar representing total `durationMs`. Color-coded by status code color. Label: "{durationMs}ms total". Since `DelegatingHandler` only gives us total round-trip time, no sub-timing decomposition. Note below bar: "Sub-timing breakdown (DNS, connect, TLS, TTFB) unavailable — EDOG intercepts at the DelegatingHandler level" | TM-DTL-031 |
| TM-DTL-031 | Timing — context comparison | Always shown below waterfall | **Percentile context**: "This request: 3045ms" + "Avg for this endpoint: 145ms" + "P95 for this endpoint: 280ms". Bar chart comparing this request's duration against historical distribution (from buffer). Highlights if this request is an outlier (> P95: amber, > P99: red) | — |
| TM-DTL-032 | Timing — chaos delay annotated | `chaosModified: true` and matched rule includes `delay` action | Waterfall bar is split: natural duration (green segment) + injected delay (striped chaos-accent segment). Label: "145ms natural + 3000ms chaos delay = 3145ms total". Makes it immediately obvious how much latency the chaos rule added | — |
| TM-DTL-033 | Timing — insufficient data | Fewer than 5 entries for this endpoint in buffer | Percentile context section: "Insufficient data for comparison (need 5+ requests to this endpoint)" in muted text. Only the single bar shown | — |

### 6.5 Chaos Tab

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-DTL-040 | Chaos — no rules matched | Tab 4 (Chaos) active, `matchedRules` array empty | Centered: "No chaos rules matched this request" + "This request was processed normally without any chaos modifications." Muted text. Shield-check icon | — |
| TM-DTL-041 | Chaos — rules matched | `matchedRules` array non-empty | **Matched Rules section**: card per matched rule, showing: Rule name (bold) · Rule ID (monospace, muted) · Phase (`request` or `response`) badge · Action type badge (e.g., "blockRequest", "delay", "modifyStatus"). Below each card: action description from `actionsApplied` array (e.g., "blockRequest → 503 ServiceUnavailable (forged response)"). Cards are clickable: opens Rule Builder with that rule focused | TM-DTL-042 |
| TM-DTL-042 | Chaos — action detail | Click a matched rule card in Chaos tab | Card expands inline: shows full rule predicate (which conditions matched), action config (delay ms, forged status, etc.), and rule lifecycle info (fire count, TTL remaining). [Edit Rule] button. [Disable Rule] button | — |
| TM-DTL-043 | Chaos — multiple rules matched | `matchedRules.length > 1` | Multiple cards stacked vertically. Order: by phase (request-phase first, response-phase second), then by priority. Visual connector line between cards: "→" indicating evaluation order. Summary at top: "2 rules matched this request" | TM-DTL-041 |
| TM-DTL-044 | Chaos — forged response indicator | Action type is `blockRequest` or `forgeResponse` | Prominent warning banner at top of Chaos tab: "This response was FORGED by a chaos rule" in chaos-accent color with shield icon. The response shown in the Response tab is the forged one, not a real server response. Banner links to Response tab for inspection | TM-DTL-020 |

---

## 7. EXPORT STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-EXP-001 | Export menu | Click "Export ▾" button in toolbar | Dropdown: Export as HAR 1.2 · Export as JSON (EDOG format) · Export as CSV · ──── · Export filtered view ({N} entries) · Export all ({N} entries). If a selection exists: "Export selected (2 entries)" option appears | TM-EXP-002/003/004 |
| TM-EXP-002 | Exporting — HAR | Click "Export as HAR 1.2" | Progress: "Exporting {N} entries as HAR..." with spinner. File dialog opens (or auto-download). Filename: `edog-traffic-{YYYY-MM-DD-HHmmss}.har`. Format follows HAR 1.2 spec (see C05 §OB-01). EDOG extensions in `_edog` custom fields. Toast: "Exported {N} entries as HAR" | TM-EXP-005 |
| TM-EXP-003 | Exporting — JSON | Click "Export as JSON" | Same UX as HAR but filename `.json`. Format: array of raw `ChaosTrafficEvent` objects with all fields. Preserves `matchedRules`, `actionsApplied`, `chaosModified` | TM-EXP-005 |
| TM-EXP-004 | Exporting — CSV | Click "Export as CSV" | Filename: `.csv`. Columns: `#`, `timestamp`, `method`, `url`, `statusCode`, `durationMs`, `responseBodySize`, `httpClientName`, `chaosModified`, `matchedRuleNames` (semicolon-separated). Headers and body previews excluded (too large for CSV). Toast: "Exported {N} entries as CSV" | TM-EXP-005 |
| TM-EXP-005 | Export complete | File saved | Toast: "Exported {N} entries to {filename}". Export button returns to default state | TM-EXP-001 |
| TM-EXP-006 | Export — large set warning | Exporting > 5,000 entries as HAR | Confirmation dialog: "Export {N} entries? This may produce a large file (~{size}MB). Continue?" [Export] [Cancel]. Size estimate: avg 2KB/entry | TM-EXP-002 |
| TM-EXP-007 | Export — filter active | Filter is active during export | "Export filtered view" uses current filter. "Export all" ignores filter. Dropdown makes this explicit. Exported file metadata includes filter description if filtered | TM-EXP-002/003/004 |

---

## 8. COMPARISON STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-CMP-001 | Comparison mode entry | `Ctrl+Click` second row, or select row → context menu → "Compare with..." | Toolbar enters comparison mode: amber bar "Comparison Mode — select a second request" (if only one selected). With two selected: bar shows "Comparing #{seqA} vs #{seqB}" + [View Diff] + [Cancel] | TM-CMP-002 |
| TM-CMP-002 | Comparison — diff view | Click [View Diff] | Detail panel switches to full-width diff view. Two-column layout: Left = Request A, Right = Request B. Sections (collapsible): **URL** (side-by-side, differences highlighted in amber), **Status** (badges side-by-side), **Duration** (bar comparison), **Request Headers** (diff: added=green, removed=red, changed=amber), **Response Headers** (same diff), **Request Body** (JSON diff if both are JSON), **Response Body** (JSON diff). Header: "#{seqA} vs #{seqB}" | TM-CMP-003 |
| TM-CMP-003 | Comparison — JSON diff | Both entries have JSON response bodies | Inline diff view: shared lines in default color, additions in green background, deletions in red background, modifications in amber. Line numbers for both sides. Collapsible unchanged sections (shows "... 15 unchanged lines ...") | — |
| TM-CMP-004 | Comparison — header diff | Comparing headers between two entries | Table: Header Name · Value A · Value B. Rows: matching values in default color, different values highlighted amber, headers only in A have Value B cell red-striped ("missing"), headers only in B have Value A cell green-striped ("added") | — |
| TM-CMP-005 | Comparison — timing diff | Comparing timing between two entries | Side-by-side waterfall bars. Delta shown: "+2900ms" or "-50ms". If both chaos-modified: chaos delay segments compared separately | — |
| TM-CMP-006 | Comparison — chaos diff | Comparing chaos annotations | Side-by-side rule match cards. Highlights which rules matched A but not B, and vice versa. Useful for validating that a rule change affected the right traffic | — |
| TM-CMP-007 | Comparison — exit | Click [Cancel] or press `Escape` | Comparison mode exits. Detail panel returns to single-entry view. Selection clears to single row (last selected) | TM-DTL-001 |
| TM-CMP-008 | Compare with... mode | Context menu → "Compare with..." | First row locked as comparison anchor. Toolbar: "Select a second request to compare with #{seqA}". All rows get hover effect. Click any row → enters comparison diff (TM-CMP-002). `Escape` to cancel | TM-CMP-002, TM-ROW-017 |

---

## 9. RECORDING INTEGRATION

The Traffic Monitor shows recording status when a recording is active (via `RecordingManager`).

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-REC-001 | Recording active indicator | Recording started (from Recording sub-view) | Toolbar: red dot pulsing (1s cycle) + "REC" label + entry counter (e.g., "REC · 1,247"). Indicates all traffic is being persisted to disk. Tooltip: "Recording active: {session name}. {N} entries captured. Click to open Recording view." | TM-REC-002 |
| TM-REC-002 | Recording with filter mismatch | Recording filter is narrower than Traffic Monitor filter | Indicator: "REC · 847 (filtered)" — counter shows only entries matching the recording filter, not total traffic. Tooltip explains: "Recording filter: OneLakeRestClient only. Traffic Monitor shows all traffic." | TM-REC-001 |
| TM-REC-003 | Recording stopped | User stops recording | Red dot stops pulsing, fades to grey. Label: "Recording stopped · {N} entries saved". After 5s, indicator disappears. Toast: "Recording saved: {name}" | — |
| TM-REC-004 | Recording — buffer vs disk | Buffer overflow while recording | Buffer drops oldest (TM-BUF-003) but recording preserves all to disk. Indicator: "REC · 12,847 (buffer: 10,000)". User understands: buffer view is partial, recording is complete | TM-BUF-005 |

---

## 10. DISCONNECTED / ERROR STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TM-DISC-001 | Phase 1 — disabled | User opens Chaos Panel in disconnected mode (no FLT running) | Full-panel empty state: network icon (muted, 48px) + "Traffic Monitor requires a running FLT service" + "Deploy to a lakehouse to enable real-time traffic inspection" + [Go to Workspace Explorer] button. All toolbar controls disabled | TM-CONN-001 (after deploy) |
| TM-DISC-002 | Service crashed | FLT process dies while streaming | Stream stops. Connection enters reconnect loop (TM-CONN-004). Existing entries preserved. Banner: "FLT service stopped — traffic stream disconnected. Showing last {N} cached entries." All interaction (filter, sort, select, export) still works on cached data | TM-CONN-004 |
| TM-DISC-003 | Kill switch activated | `Ctrl+Shift+K` pressed (global chaos kill switch) | Flash banner: red, "KILL SWITCH ACTIVATED — All chaos rules disabled". Chaos `◆` indicators on rows remain (historical) but no new chaos-affected traffic will appear. Traffic stream continues (only chaos rules are killed, not the monitor). Banner auto-dismisses after 10s, leaving status bar note | TM-STRM-003 |
| TM-DISC-004 | SignalR degraded | Connection alive but messages arriving > 5s late | Throughput counter gets warning: "24 req/s (delayed)". Tooltip: "Messages arriving with > 5s latency. SignalR backpressure may be active." Timestamps in rows are server-side (accurate), but visual append is delayed | TM-CONN-003 |

---

## 11. KEYBOARD SHORTCUT SUMMARY

All shortcuts are active when the Traffic Monitor has focus. None conflict with browser defaults or the global Command Palette (`Ctrl+K`).

| Shortcut | Action | Context |
|----------|--------|---------|
| `j` / `↓` | Focus next row | Table focused |
| `k` / `↑` | Focus previous row | Table focused |
| `Enter` | Select focused row / open detail panel | Row focused |
| `Escape` | Close detail panel / clear selection / exit comparison / clear filter | Contextual — cascading dismiss |
| `Space` | Pause / Resume stream | Table focused (not in text input) |
| `Home` | Jump to first row | Table focused |
| `End` | Jump to last row (re-enables auto-scroll) | Table focused |
| `PageUp` / `PageDown` | Page through rows | Table focused |
| `e` | Jump to next error (4xx/5xx) | Table focused |
| `c` | Jump to next chaos-affected entry | Table focused |
| `Ctrl+F` | Focus filter input | Any |
| `Ctrl+L` | Clear buffer | Any |
| `1` / `2` / `3` / `4` | Switch detail panel tab (Req/Res/Timing/Chaos) | Detail panel open |
| `Ctrl+Click` | Multi-select for comparison | Row click |
| `Ctrl+Shift+E` | Export menu | Any |
| `Ctrl+C` | Copy selected row as text summary | Row selected |

---

## 12. PERFORMANCE TARGETS

| Metric | Target | Measurement |
|--------|--------|-------------|
| Row render time | < 0.5ms per row | `performance.mark()` around row creation |
| 60fps scroll | No dropped frames during scroll at any buffer size | Chrome DevTools Performance tab |
| Virtual scroll activation | Automatic at > 500 rows | Row count threshold |
| Filter response time | < 50ms for 10,000 entries | Time from keystroke to visible filter result |
| Detail panel open | < 100ms from click to content visible | `performance.measure()` |
| Memory ceiling | < 80MB for 10,000 entries with detail data | Chrome DevTools Memory tab |
| Export HAR (10K entries) | < 3s | Time from click to file-save dialog |
| Throughput counter | Updates every 1s, no jank | Visual inspection + performance trace |
| Initial snapshot load | < 500ms for 2,000 buffered entries | Time from stream open to all rows rendered |
| Sort (10K rows) | < 200ms | Time from click to re-rendered sorted view |

---

## 13. DATA REQUIREMENTS PER STATE

| State Group | Required Fields from `ChaosTrafficEvent` | Optional / Enhanced |
|-------------|------------------------------------------|---------------------|
| Row rendering | `sequenceId`, `timestamp`, `method`, `url`, `statusCode`, `durationMs`, `responseBodySize`, `httpClientName`, `chaosModified` | `matchedRules` (for `◆` tooltip) |
| Detail — Request | All row fields + `requestHeaders`, `requestBodyPreview`, `requestBodySize`, `httpVersion` | — |
| Detail — Response | All row fields + `responseHeaders`, `responseBodyPreview`, `responseBodySize`, `httpVersion` | — |
| Detail — Timing | `durationMs`, `url`, `method` | Buffer history for percentile calculation |
| Detail — Chaos | `matchedRules`, `actionsApplied`, `chaosModified` | Rule details via `ChaosGetRule(ruleId)` |
| Filter | `url`, `method`, `statusCode`, `httpClientName`, `chaosModified`, `requestHeaders`, `responseHeaders`, `requestBodyPreview`, `responseBodyPreview`, `correlationId` | — |
| Export — HAR | All `ChaosTrafficEvent` fields | `httpVersion`, `requestBodySize`, `responseBodySize` |
| Export — CSV | Row fields only | — |
| Comparison | All fields for both entries | — |

---

## 14. REAL-TIME UPDATE BEHAVIOR MATRIX

How each state reacts when new `ChaosTrafficEvent` arrives from the SignalR stream:

| Current State | New Event Behavior |
|---------------|--------------------|
| `TM-STRM-003` (streaming normal) | Row appended at bottom. Auto-scroll if active. Virtual scroll viewport updated |
| `TM-STRM-005` (auto-scroll off) | Row appended to DOM (below viewport). "↓ N new" pill increments. No visual disruption |
| `TM-PAUSE-001` (paused) | Event buffered in memory. Badge counter increments. No DOM update |
| `TM-FILT-003` (filter active) | Event evaluated against filter. If match: row appended (visible). If no match: row added to backing store but hidden. Status bar total count increments |
| `TM-ROW-010` (row selected, detail open) | Row appended per streaming rules. Selected row stays selected. Detail panel unaffected |
| `TM-CMP-002` (comparison view) | Row appended per streaming rules (visible in background table). Comparison panel unaffected |
| `TM-CONN-004` (disconnected) | Events missed. Gap counter increments internally |
| `TM-EXP-002` (exporting) | Events continue to stream. Export operates on snapshot taken at export-start time |
| `TM-COL-004` (sorted view) | New row inserted in sorted position (binary search on sort key). No full re-sort |
| `TM-BUF-003` (buffer full) | New row appended, oldest row evicted. Scroll adjustment if oldest row was visible |

---

## 15. ACCESSIBILITY

| Requirement | Implementation |
|-------------|---------------|
| Screen reader: row announce | Each row is `role="row"` in a `role="grid"`. Focus announces: "Row 47: PUT, onelake.dfs.fabric, 503, 3045ms, chaos modified" |
| Focus management | `j`/`k` moves `aria-activedescendant`. Focus never trapped — `Tab` exits table to toolbar. `Shift+Tab` from toolbar to table |
| Color contrast | All text meets WCAG AA (4.5:1) against dark background. Status badges: text + background verified per OKLCH values in §0.3 |
| Reduced motion | `prefers-reduced-motion: reduce`: row append animation disabled, auto-scroll is instant (no smooth), panel transitions instant |
| High contrast | Windows High Contrast mode: fall back to system colors. Chaos border → `Highlight`. Selection → `Highlight` + `HighlightText` |
| Keyboard only | Every action achievable without mouse. Documented in §11 |

---

## 16. STATE TRANSITION DIAGRAM

```
                                    ┌─────────────────┐
                                    │  TM-DISC-001    │
                                    │  Phase 1 disabled│
                                    └────────┬────────┘
                                             │ Deploy completes
                                             ▼
                                    ┌─────────────────┐
                              ┌────►│  TM-CONN-001    │◄──── Manual reconnect
                              │     │  Connecting      │
                              │     └────────┬────────┘
                              │              │ SignalR opens
                              │              ▼
                              │     ┌─────────────────┐
                              │     │  TM-CONN-002    │
                              │     │  Snapshot loading│
                              │     └────────┬────────┘
                              │              │ Snapshot complete
                              │              ▼
                ┌─────────────┤     ┌─────────────────┐
                │             │     │  TM-CONN-003    │
                │ Reconnect   │     │  Live streaming  │
                │ exhausted   │     └───┬──────┬──────┘
                │             │         │      │
                ▼             │    Pause │      │ Connection drops
        ┌───────────────┐     │         │      │
        │ TM-CONN-005   │     │         ▼      ▼
        │ Failed/Offline │     │  ┌──────────┐ ┌──────────────┐
        └───────────────┘     │  │TM-PAUSE  │ │TM-CONN-004   │
                              │  │ Paused   │ │ Reconnecting  │
                              │  └────┬─────┘ └──────┬────────┘
                              │       │ Resume        │
                              │       ▼               │
                              │  ┌──────────┐         │
                              │  │TM-STRM-* │         │
                              │  │Streaming │◄────────┘
                              │  └──────────┘    Reconnected
                              │       │
                              │       │ Filter applied
                              │       ▼
                              │  ┌──────────┐
                              │  │TM-FILT-* │ ◄──── 0 matches ──── TM-EMPTY-*
                              │  │Filtered  │
                              │  └──────────┘
                              │       │
                              │       │ Row selected
                              │       ▼
                              │  ┌──────────┐
                              │  │TM-ROW-*  │ ◄──── Ctrl+Click ──── TM-CMP-*
                              │  │Selected  │
                              │  └────┬─────┘
                              │       │ Enter / Click
                              │       ▼
                              │  ┌──────────┐
                              │  │TM-DTL-*  │
                              │  │Detail    │
                              │  └──────────┘
                              │
                              └──── Connection drops at any point
```

---

## 17. OPEN QUESTIONS

| # | Question | Owner | Impact |
|---|----------|-------|--------|
| 1 | Should we support column reorder (drag-and-drop)? Chrome DevTools does. Adds complexity. | Pixel | TM-COL-* |
| 2 | Request body capture: C# side needs to buffer + rewind `HttpContent`. What's the perf cost for large PUT bodies (Parquet, 100MB+)? | Vex | TM-DTL-011 |
| 3 | Should "Compare with..." support comparing entries from different recordings (not just live buffer)? | Sana | TM-CMP-* |
| 4 | Diff view: should we use a proper diff library (e.g., port of `difflib`) or simple side-by-side? | Pixel | TM-CMP-003 |
| 5 | Should filter presets be saveable? E.g., "OneLake errors" = method:PUT + status:4xx-5xx + client:OneLakeRestClient | Pixel + Sana | TM-FILT-* |
