# F04 Runtime View — Complete UX State Matrix

> **Feature:** F04 Runtime View (Debugging Cockpit)
> **Status:** Specification complete
> **Owner:** Zara (JS) + Mika (CSS) + Arjun (C# WebSocket) + Kael (UX)
> **Last Updated:** 2026-04-12
> **States Documented:** 200+

---

## How to Read This Document

Every state is documented as:
```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

States are grouped by tab and category. Each state has a unique ID for reference in code reviews and bug reports (e.g., "this violates F04-LOG-STRM-005").

Prefix key:
- `RTAB-*` — Tab-level and phase-gating states
- `LOG-CONN-*` — Logs: WebSocket connection
- `LOG-STRM-*` — Logs: stream rendering and scrolling
- `LOG-FILT-*` — Logs: filtering and search
- `LOG-BRK-*` — Logs: breakpoints
- `LOG-BMK-*` — Logs: bookmarks
- `LOG-CLST-*` — Logs: error clustering
- `LOG-ENTRY-*` — Logs: entry interaction and detail
- `TELE-*` — Telemetry tab
- `SYSF-*` — System Files tab
- `SPARK-*` — Spark Sessions tab
- `INT-*` — Internals dropdown and sub-views
- `RV-*` — Cross-cutting Runtime View states

---

## 1. TAB-LEVEL STATES

### 1.1 Phase Gating

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| RTAB-001 | Phase 1 — disabled | User navigates to Runtime View in disconnected mode | Full-panel empty state: server rack icon (muted) + "Runtime View requires a running FLT service" + "Deploy to a lakehouse to enable logs, telemetry, and debugging tools" + [Go to Workspace Explorer] button. All tabs visible but dimmed at 40% opacity | RTAB-010 (after deploy) |
| RTAB-002 | Phase 1 — sidebar hint | Sidebar "Runtime" icon hovered in Phase 1 | Tooltip: "Deploy to enable Runtime View". Icon stays dimmed with lock overlay | RTAB-001 |
| RTAB-003 | Phase 1 — keyboard blocked | User presses `4` (Runtime View shortcut) in Phase 1 | Status bar flash: "Runtime View available after deploy". No navigation occurs | — |

### 1.2 Phase 2 Transition

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| RTAB-010 | Phase 2 — enabling | Deploy completes (CONTENT-066) | Runtime View sidebar icon enables: lock overlay fades (200ms), icon colour transitions from muted to accent, subtle pulse ring (one cycle). Tab bar animates in: each tab label fades from 40% to 100% with 100ms stagger (Logs → Telemetry → System Files → Spark → Internals) | RTAB-020 |
| RTAB-011 | Phase 2 — auto-navigate | First deploy completes AND user was on Runtime View empty state | Auto-switch to Logs tab. WebSocket connection begins immediately. Toast: "Runtime View active — streaming logs" | LOG-CONN-001 |
| RTAB-012 | Phase 2 — service stopped | FLT service crashes or user stops it | All tabs get amber overlay: "Service stopped — data is stale" + timestamp of last data. [Restart] [Re-deploy] buttons. Existing data remains visible but greyed. WebSocket enters reconnect loop | RTAB-013 |
| RTAB-013 | Phase 2 — service restarted | Service comes back after stop | Amber overlay dissolves (300ms). WebSocket reconnects. Toast: "Service reconnected — streaming resumed". Log stream resumes from new session (old entries preserved in buffer) | RTAB-020 |

### 1.3 Tab Switching

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| RTAB-020 | Logs active (default) | Phase 2 entered, or click Logs tab | Logs tab label: bold, accent underline (3px) slides in from left (200ms ease-out). Content area crossfades (150ms out, 200ms in). Other tab labels: normal weight, no underline | LOG-* |
| RTAB-021 | Telemetry active | Click Telemetry tab | Underline slides from Logs position to Telemetry (200ms ease). Content crossfades | TELE-* |
| RTAB-022 | System Files active | Click System Files tab | Underline slides to System Files. Content crossfades | SYSF-* |
| RTAB-023 | Spark Sessions active | Click Spark Sessions tab | Underline slides to Spark Sessions. Content crossfades | SPARK-* |
| RTAB-024 | Internals dropdown open | Click "Internals ▾" | Dropdown menu appears below tab bar (100ms, cubic-bezier(0.34,1.56,0.64,1)): 7 items vertically — Tokens, Caches, HTTP Pipeline, Retries, Feature Flag Evals, DI Registry, Perf Markers. Each with left icon. Hover highlights row. Click outside or Escape dismisses | INT-* |
| RTAB-025 | Internals sub-view active | Click item in Internals dropdown | Dropdown closes. Tab label changes to "Internals: {name}" with ▾. Underline slides to Internals position. Content crossfades to selected sub-view | INT-* |
| RTAB-026 | Tab keyboard navigation | Arrow Left / Arrow Right on tab bar | Focus ring moves between tabs. Enter activates. Internals: Enter opens dropdown, then ↑/↓ to navigate items | RTAB-020–025 |
| RTAB-027 | Tab badge — errors | Unread errors arrive in any tab | Red dot badge on tab label: "Logs (3)" for 3 unread errors. Badge pulses once on increment. Clears when user views that tab | RTAB-020 |
| RTAB-028 | Tab badge — activity | New events arrive while tab inactive | Small blue dot on tab label (no count). Indicates fresh data since last view. Clears on tab activation | RTAB-020 |
| RTAB-029 | Rapid tab switch | User clicks 3 tabs in <500ms | Cancel pending data loads for abandoned tabs. Only render the final tab. No stale content flash | RTAB-020–025 |

---

## 2. LOGS TAB

### 2.1 WebSocket Connection

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LOG-CONN-001 | Connecting | Logs tab activated for first time in session | Connection indicator (top-right of log toolbar): amber dot + "Connecting..." with 3-dot ellipsis animation. Log area shows: centered spinner + "Establishing WebSocket connection to EdogLogServer..." | LOG-CONN-002 or LOG-CONN-005 |
| LOG-CONN-002 | Connected | WebSocket opens successfully | Connection indicator: green dot + "Connected". Throughput counter appears: "0 msg/s". Log area transitions to empty-stream state. Toast: "Log stream connected" (auto-dismiss 2s) | LOG-STRM-001 |
| LOG-CONN-003 | Disconnected — reconnecting | WebSocket closes unexpectedly (network glitch, server restart) | Connection indicator: amber dot + "Reconnecting..." + retry counter "(attempt 2/10)". Existing log entries remain visible but dimmed to 80% opacity. Top-of-stream amber banner: "Connection lost — reconnecting automatically" | LOG-CONN-002 or LOG-CONN-005 |
| LOG-CONN-004 | Disconnected — backoff | Reconnect attempts failing | Retry counter increments with exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap). Banner updates: "Reconnecting in 8s..." with countdown. [Reconnect Now] button appears after 3rd failure | LOG-CONN-002 or LOG-CONN-005 |
| LOG-CONN-005 | Failed | 10 reconnect attempts exhausted OR server explicitly rejects | Connection indicator: red dot + "Offline". Banner: red background, "WebSocket connection failed" + "EdogLogServer may not be running" + [Reconnect] button + [Check Server Status] link. Log entries remain visible (stale data) | LOG-CONN-001 (manual reconnect) |
| LOG-CONN-006 | Manual reconnect | Click [Reconnect] or [Reconnect Now] | Same as LOG-CONN-001 but banner shows "Reconnecting (manual)..." Retry counter resets to 0 | LOG-CONN-002 or LOG-CONN-005 |
| LOG-CONN-007 | Throughput normal | Connected, messages flowing | Throughput counter updates every 1s: "142 msg/s" in default colour. Counter animates number changes (roll transition, 200ms) | — |
| LOG-CONN-008 | Throughput high | >500 msg/s sustained for 3s | Throughput counter turns amber: "1,247 msg/s ▲". Tooltip: "High throughput — rendering may throttle" | LOG-STRM-010 |
| LOG-CONN-009 | Throughput zero | Connected but 0 messages for >10s | Throughput shows "0 msg/s" in dimmed text. After 30s: "(idle)" appended. No alarm — service may be between iterations | — |

### 2.2 Log Stream Rendering

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LOG-STRM-001 | Empty stream | Connected, no messages yet | Centered in log area: clock icon (muted) + "Waiting for first log entry..." + "Trigger an operation in FLT to see logs here" hint text. Toolbar visible with all controls dimmed except connection indicator | LOG-STRM-002 |
| LOG-STRM-002 | First entry arrives | First WebSocket message received | Empty state fades out (150ms). First log row slides in from bottom (200ms). Toolbar controls enable with fade-in. Level filter counts start at 1 | LOG-STRM-003 |
| LOG-STRM-003 | Streaming — normal | Messages arriving at ≤500/sec | Entries append at bottom of visible area. Each row: timestamp (monospace, dimmed) + level badge (coloured pill) + component (dimmed) + message (primary text). Auto-scroll keeps newest entry visible. Scroll thumb tracks position | LOG-STRM-003 (continue) |
| LOG-STRM-004 | Streaming — auto-scroll active | User is at bottom of scroll (within 50px) | "Auto-scroll" indicator lit (accent colour) in bottom-right corner. New entries smoothly scroll into view. No jump — continuous append animation | LOG-STRM-005 |
| LOG-STRM-005 | Streaming — auto-scroll off | User scrolls up (>50px from bottom) | "Auto-scroll" indicator dims. New entries still buffered and appended to DOM but scroll position preserved. Floating pill appears at bottom: "↓ 47 new entries" with count updating live. Click pill to jump to bottom and re-enable auto-scroll | LOG-STRM-004 (click pill) |
| LOG-STRM-006 | Paused | Click Pause button (⏸) or press `Space` | Pause button changes to Play (▶). "PAUSED" badge appears (amber, top-left of stream area). Stream freezes — new messages buffer in memory but don't render. Badge shows buffer count: "PAUSED · 238 buffered". Toolbar background gets subtle amber tint | LOG-STRM-007 |
| LOG-STRM-007 | Resuming | Click Play button (▶) or press `Space` | Badge changes to "Flushing..." briefly. Buffered entries render in batches (100/frame) with fast scroll animation. Badge disappears when buffer empty. Play button changes back to Pause | LOG-STRM-003 |
| LOG-STRM-008 | Paused — buffer warning | Paused for >60s or buffer exceeds 5,000 entries | Badge turns red: "PAUSED · 5,000+ buffered — oldest entries will be dropped". After 10K buffer: oldest entries silently discarded even while paused | LOG-STRM-007 |
| LOG-STRM-009 | Clear stream | Click Clear button (🗑) or `Ctrl+L` | Confirmation inline: "Clear all entries?" [Clear] [Cancel] (no modal — inline in toolbar). If confirmed: all entries fade out top-to-bottom (100ms stagger, 50ms per batch). Counter resets. Bookmarks preserved in drawer. Breakpoints preserved | LOG-STRM-001 |
| LOG-STRM-010 | Throttled rendering | >1000 msg/s sustained for 2s | Rendering switches to batch mode: accumulate 150ms worth of entries, render as single DOM operation. Amber banner: "High volume: rendering batched (1,247 msg/s)". Individual entry animations disabled. Virtual scroll DOM nodes reduced to 30 | LOG-STRM-003 (when rate drops) |
| LOG-STRM-011 | Ring buffer rotation | Total entries reach 10,000 | Oldest entries silently removed from top of buffer as new entries arrive. Scroll indicator adjusts. No user notification — seamless FIFO. If user is scrolled to top: view shifts to keep current viewport stable, entries disappear above | LOG-STRM-003 |
| LOG-STRM-012 | Virtual scroll — normal | >100 entries in buffer | Only ~50 DOM nodes rendered. Scroll thumb reflects full virtual height. Scroll position indicator shows "Entry 4,231 of 8,947" in bottom-left. Rapid scroll shows brief blank flash (<100ms) then renders target viewport | — |
| LOG-STRM-013 | Virtual scroll — jump | Click scroll indicator or drag thumb rapidly | Viewport jumps to target position. Brief shimmer (50ms) then entries render. Scroll position indicator updates immediately | — |
| LOG-STRM-014 | Scroll to error | Press `Shift+E` (Jump to Next Error) | Viewport scrolls to next Error-level entry below current position. Target row flashes with red tint (300ms pulse, 2 cycles). If no more errors below: toast "No more errors below" + offer to wrap to top | LOG-ENTRY-001 |
| LOG-STRM-015 | Scroll to error — wrap | No errors below, user confirms wrap | Scroll jumps to first Error-level entry from top. Same flash animation. Status bar: "Wrapped to top" | LOG-ENTRY-001 |

### 2.3 Level Filter Pills

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LOG-FILT-001 | All levels active (default) | Initial state or Clear All Filters | Filter pills in toolbar: `All (8,947)` `Verbose (2,104)` `Message (5,632)` `Warning (847)` `Error (364)`. "All" pill has accent background, rest are ghost/outline. Counts update live as entries stream in (number roll animation) | LOG-FILT-002 |
| LOG-FILT-002 | Single level selected | Click a level pill (e.g., "Error") | Clicked pill gets accent background. "All" deselects. Other pills become ghost. Stream filters instantly: non-matching rows collapse with height animation (100ms). Visible count updates: "Showing 364 of 8,947". Scroll resets to bottom | LOG-FILT-001 (click All) |
| LOG-FILT-003 | Multiple levels selected | Ctrl+click additional level pills | Multiple pills get accent background. "All" deselects. Stream shows union of selected levels. e.g., Warning + Error: "Showing 1,211 of 8,947" | LOG-FILT-001 |
| LOG-FILT-004 | Level deselected | Click an active level pill | Pill reverts to ghost. If no pills active: auto-select "All". Filter updates immediately | LOG-FILT-001 or LOG-FILT-003 |
| LOG-FILT-005 | Error count increment | New Error-level entry arrives | Error pill count increments with red flash on the number (200ms). If Error pill not active: red dot badge appears on pill briefly (1s) | — |
| LOG-FILT-006 | Zero entries for level | No Warning entries in current stream | Warning pill shows "Warning (0)" in dimmed text. Pill still clickable (shows empty filtered view) | LOG-FILT-007 |
| LOG-FILT-007 | Filter shows empty | Level selected but 0 entries match | Log area: "No {level} entries" + "Try a different filter or wait for new entries" | LOG-FILT-001 |

### 2.4 Component & Text Filters

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LOG-FILT-010 | Component dropdown — closed | Default state | Dropdown button: "Component: All" with ▾ chevron | LOG-FILT-011 |
| LOG-FILT-011 | Component dropdown — open | Click dropdown | Dropdown menu lists all components seen in stream, sorted by frequency. Each item: component name + count badge. Search input at top of dropdown for filtering long lists. Multi-select with checkboxes | LOG-FILT-012 |
| LOG-FILT-012 | Component(s) selected | Check 1+ components | Dropdown label: "Component: DagEngine (+2)" showing first selected + overflow count. Stream filters to selected components. Active filter badge on toolbar increments | LOG-FILT-010 (clear) |
| LOG-FILT-013 | Component — new in stream | Stream delivers entry with unseen component name | Component auto-added to dropdown list. If user has component filter active: new component does NOT auto-include (must manually add) | — |
| LOG-FILT-020 | Text search — inactive | Default state | Search input in toolbar: magnifying glass icon + placeholder "Search logs... (Ctrl+/)" | LOG-FILT-021 |
| LOG-FILT-021 | Text search — active | Click search input or `Ctrl+/` | Input focused with accent border + glow ring. As user types: live filtering begins after 2 characters (debounce 200ms) | LOG-FILT-022 |
| LOG-FILT-022 | Text search — results | Query matches entries | Matching entries: search term highlighted with amber background in message text. Non-matching entries dimmed to 30% opacity (not hidden — preserves scroll context). Counter: "4 of 1,293 entries" + ▲/▼ navigation arrows to jump between matches. Current match has stronger highlight (accent outline) | LOG-FILT-023 |
| LOG-FILT-023 | Text search — navigate | Click ▲/▼ arrows or `Enter`/`Shift+Enter` | Viewport scrolls to next/previous match. Current match counter updates: "2 of 4". Match row gets brief pulse (200ms) | LOG-FILT-022 |
| LOG-FILT-024 | Text search — no results | Query matches nothing | Counter: "0 results for '{query}'". All entries dimmed. Amber info below search: "No entries match. Try a broader term." | LOG-FILT-021 (modify query) |
| LOG-FILT-025 | Text search — regex mode | Click `.*` toggle in search bar | Toggle activates (accent background). Input placeholder changes to "Regex search...". Invalid regex: red border + "Invalid regex" tooltip. Valid regex: normal filtering. Regex applied to full message text | LOG-FILT-022 |
| LOG-FILT-026 | Text search — cleared | Click ✕ in search or `Escape` | Input clears. All entries restore full opacity. Counter disappears. Highlights removed | LOG-FILT-020 |

### 2.5 Time Range & Preset Filters

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LOG-FILT-030 | Time range — All (default) | Initial state | Time range pills: `All` `1m` `5m` `15m` `1h` `Custom`. "All" has accent background | LOG-FILT-031 |
| LOG-FILT-031 | Time range — preset selected | Click 5m pill | "5m" gets accent background. Stream filters to entries from last 5 minutes. Counter updates. As time passes, oldest entries leave the window (fade out at top) | LOG-FILT-030 |
| LOG-FILT-032 | Time range — custom | Click "Custom" pill | Inline date-time picker appears: two fields (From / To) with calendar dropdowns. Pre-populated with first entry time → now. [Apply] [Cancel] | LOG-FILT-033 |
| LOG-FILT-033 | Time range — custom applied | Click [Apply] on custom range | "Custom" pill shows abbreviated range: "10:42–10:47". Stream filters to that window. New entries outside range excluded even as they arrive | LOG-FILT-030 (click All) |
| LOG-FILT-040 | RAID filter — inactive | Default state | Dropdown: "RAID / IterationId: All" with ▾ | LOG-FILT-041 |
| LOG-FILT-041 | RAID filter — open | Click dropdown | List of RAIDs/IterationIds seen in stream, sorted by recency. Each with count + time range. Click to filter. Search input at top | LOG-FILT-042 |
| LOG-FILT-042 | RAID filter — active | Select a RAID | Dropdown label updates with truncated RAID. Stream filters to entries with that RAID. Useful for isolating a single DAG execution | LOG-FILT-040 (clear) |
| LOG-FILT-050 | Preset filter — All | Default preset | Preset toggle group: `All` `FLT` `DAG` `Spark`. "All" active (accent background). No component filtering | LOG-FILT-051 |
| LOG-FILT-051 | Preset filter — FLT | Click "FLT" preset | Filters to FLT-specific components (e.g., DagEngine, SparkClient, Catalog). Equivalent to selecting multiple components at once. Overrides manual component selection | LOG-FILT-050 |
| LOG-FILT-052 | Preset filter — DAG | Click "DAG" preset | Filters to DAG execution components only: DagExecutionHandler, DagNode, DagScheduler | LOG-FILT-050 |
| LOG-FILT-053 | Preset filter — Spark | Click "Spark" preset | Filters to Spark components: SparkClient, NotebookContext, SparkSessionManager | LOG-FILT-050 |
| LOG-FILT-060 | Active filter count | 1+ filters active beyond defaults | Toolbar shows filter count badge: "3 filters active" (accent pill). Click badge → dropdown listing all active filters with ✕ to remove individually. [Clear All Filters] at bottom | LOG-FILT-001 (clear all) |
| LOG-FILT-061 | Clear all filters | Click [Clear All Filters] or `Ctrl+Shift+F` | All filters reset to defaults: All levels, All components, All time, All presets, no text search. Brief flash on toolbar confirming reset. Stream shows all entries | LOG-FILT-001 |

### 2.6 Breakpoints

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LOG-BRK-001 | No breakpoints | Initial state | Breakpoint bar below toolbar: collapsed (0px height). Only a small `+ Breakpoint` link visible at right edge of toolbar, dimmed | LOG-BRK-002 |
| LOG-BRK-002 | Add breakpoint — input | Click `+ Breakpoint` | Breakpoint bar expands (200ms slide-down). Inline row appears: regex input field (placeholder "Enter regex pattern...") + colour picker (5 preset colours: amber, cyan, magenta, lime, coral — small circles) + [Add] + [Cancel]. Input auto-focused | LOG-BRK-003 or LOG-BRK-001 |
| LOG-BRK-003 | Breakpoint added | Enter valid regex + click [Add] or press Enter | Input clears. New breakpoint pill appears in bar: coloured dot + truncated pattern text + ✕ remove button. Pill animates in (scale 0→1, 200ms). Existing log entries matching the regex retroactively get coloured left border strip (4px, breakpoint colour) | LOG-BRK-006 |
| LOG-BRK-004 | Breakpoint regex invalid | Enter invalid regex (unmatched parens, etc.) | Input border turns red. Inline error: "Invalid regex: {error}". [Add] button disabled. Input retains focus for correction | LOG-BRK-002 |
| LOG-BRK-005 | Breakpoint duplicate | Enter regex identical to existing breakpoint | Inline warning: "This pattern already exists". Existing pill flashes (200ms pulse). [Add] disabled | LOG-BRK-002 |
| LOG-BRK-006 | Breakpoint active — matching | Log entries stream in that match a breakpoint regex | Matching rows: coloured left border strip (4px wide, breakpoint's colour). Strip colour corresponds to which breakpoint matched. If entry matches multiple breakpoints: strip shows gradient of both colours. No auto-pause — visual highlight only | — |
| LOG-BRK-007 | Multiple breakpoints | 2+ breakpoints active | Breakpoint bar shows all pills in a horizontal row. If >5 pills: horizontal scroll with fade indicators on edges. Each pill independently removable | LOG-BRK-008 |
| LOG-BRK-008 | Remove breakpoint | Click ✕ on a breakpoint pill | Pill scales down and fades (150ms). Corresponding coloured strips removed from all log entries (batch DOM update). If last breakpoint removed: bar collapses back to hidden state | LOG-BRK-001 or LOG-BRK-007 |
| LOG-BRK-009 | Breakpoint toggle | Click breakpoint pill (not ✕) | Pill toggles between active (full colour) and disabled (greyed, strikethrough on text). Disabled breakpoints: matching stops, existing highlights removed, pill stays for re-enabling | LOG-BRK-006 |
| LOG-BRK-010 | Breakpoint — high match rate | Breakpoint matches >50% of stream | Tooltip on pill: "Matching 73% of entries — consider a more specific pattern". No auto-disable, user decides | — |

### 2.7 Bookmarks

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LOG-BMK-001 | Bookmark gutter | Any log entries visible | Each log row has a small star icon (☆) in gutter column (left-most, 24px wide). Star is dimmed (30% opacity) until hover (80% opacity) | LOG-BMK-002 |
| LOG-BMK-002 | Bookmark entry | Click star gutter on a log row | Star fills (☆ → ★) with gold colour and bounce animation (scale 1→1.3→1, 200ms). Entry gets subtle gold left-border accent (2px). Bookmark count badge appears/updates on toolbar Bookmarks button: "★ 3" | LOG-BMK-003 |
| LOG-BMK-003 | Unbookmark entry | Click filled star on a bookmarked row | Star unfills (★ → ☆) with reverse animation. Gold border removed. Bookmark count decrements. If count reaches 0: badge disappears | LOG-BMK-001 |
| LOG-BMK-004 | Bookmarks drawer — closed | Default state | Toolbar button: "★ Bookmarks (3)" (or just "★ Bookmarks" if 0). No drawer visible | LOG-BMK-005 |
| LOG-BMK-005 | Bookmarks drawer — open | Click Bookmarks button or `Ctrl+B` | Right drawer slides in (280px, 200ms ease-out). Header: "BOOKMARKS" + count + [Export] + [Clear All] + ✕ close. List of bookmarked entries: each shows timestamp + level badge + truncated message (2 lines max). Entries ordered by original timestamp. Current viewed bookmark highlighted | LOG-BMK-006 |
| LOG-BMK-006 | Bookmark — navigate | Click entry in bookmarks drawer | Main log view scrolls to that entry. Entry flashes with gold pulse (300ms, 2 cycles). Drawer stays open. If entry was removed by ring buffer rotation: "Entry no longer in buffer" greyed text with ✕ to remove stale bookmark | — |
| LOG-BMK-007 | Bookmark — stale entry | Bookmarked entry fell off ring buffer | In drawer: entry shows with muted text + "(out of buffer)" label. Click shows tooltip: "This entry has scrolled out of the log buffer. Bookmark data preserved." Detail still viewable from bookmark metadata but cannot scroll to original position | — |
| LOG-BMK-008 | Export bookmarks — JSON | Click [Export] → select JSON | Browser downloads `edog-bookmarks-{timestamp}.json`. Each bookmark: full entry object (timestamp, level, component, message, properties). Toast: "Exported 7 bookmarks to JSON" | — |
| LOG-BMK-009 | Export bookmarks — HTML | Click [Export] → select HTML | Browser downloads self-contained HTML file with styled bookmark list, syntax-highlighted properties, filterable. Toast: "Exported 7 bookmarks to HTML" | — |
| LOG-BMK-010 | Clear bookmarks | Click [Clear All] in drawer | Inline confirmation in drawer: "Remove all 7 bookmarks?" [Clear] [Cancel]. If confirmed: all stars unfill with staggered animation (30ms per entry). Drawer shows empty state | LOG-BMK-011 |
| LOG-BMK-011 | Bookmarks drawer — empty | No bookmarks, drawer open | Drawer shows: star icon (muted) + "No bookmarks yet" + "Click the ☆ icon on any log entry to bookmark it" | LOG-BMK-002 |
| LOG-BMK-012 | Bookmarks survive clear | User clears log stream (LOG-STRM-009) | Bookmarks remain in drawer with preserved metadata. Entries marked as "(cleared)" but data intact. New log entries can be bookmarked independently | LOG-BMK-007 |

### 2.8 Error Clustering

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LOG-CLST-001 | Clustering off | <3 error entries in stream, or clustering disabled | No clustering UI visible. Error entries display individually in stream | LOG-CLST-002 |
| LOG-CLST-002 | Cluster detected | ≥3 errors with same normalized pattern (strip GUIDs, timestamps, numbers, hash remaining text) | Cluster header row appears inline in stream: red accent left border + error icon + normalized message + "×7" count badge (accent pill) + first/last timestamps + expand chevron ▸. Individual entries collapse under header. Header has slightly darker background | LOG-CLST-003 |
| LOG-CLST-003 | Cluster expanded | Click cluster header or ▸ chevron | Chevron rotates to ▾. All entries in cluster expand below header with indent (16px left) and staggered slide-in (30ms per entry, max 500ms total). Header stays sticky during scroll through cluster. Each entry shows its unique details (specific GUIDs, timestamps) | LOG-CLST-002 (collapse) |
| LOG-CLST-004 | Cluster growing | New error matches existing cluster | Cluster count badge increments with pulse animation. "Last: {time}" timestamp updates. If cluster is collapsed: no visual disruption, just count update. If expanded: new entry slides in at bottom of cluster group | — |
| LOG-CLST-005 | Cluster — single entry remaining | User filters out all but 1 entry in a cluster | Cluster header dissolves, entry displays as normal individual row. Cluster reforms if filter cleared | LOG-CLST-001 |
| LOG-CLST-006 | Multiple clusters | Several distinct error patterns | Each cluster independently collapsible. Clusters ordered by most recent occurrence. Summary bar above stream (if ≥3 clusters): "3 error patterns detected" with cluster mini-pills showing pattern + count. Click mini-pill scrolls to that cluster | — |
| LOG-CLST-007 | Cluster detail — compare | Right-click cluster header → "Compare entries" | Side panel shows diff view: normalized template on top, then a table of varying fields across entries (which GUIDs, which timestamps differ). Helps identify if errors correlate with specific inputs | — |

### 2.9 Log Entry Interaction

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LOG-ENTRY-001 | Entry hover | Mouse enters a log row | Row background: rgba(var(--fg), 0.03). Gutter icons (bookmark star, copy) become visible at full opacity. Row highlights subtly | LOG-ENTRY-002 |
| LOG-ENTRY-002 | Entry selected | Click a log row (not star gutter) | Row background: var(--accent-dim). Left border: 3px solid var(--accent). Detail panel opens (bottom split or right drawer — user configurable via drag handle). Previously selected row deselects | LOG-ENTRY-003 |
| LOG-ENTRY-003 | Entry detail — loaded | Entry selected, detail panel open | Detail panel sections: **HEADER** (full timestamp + level badge + component) → **MESSAGE** (full message text, monospace, word-wrap) → **PROPERTIES** (JSON tree viewer: collapsible key-value pairs, syntax-coloured values) → **STACK TRACE** (if error: monospace, file:line links clickable) → **CORRELATION** (IterationId, RAID, ActivityId as clickable filter links) | — |
| LOG-ENTRY-004 | Entry detail — JSON expand | Click ▸ on a JSON property key | Property value expands showing nested structure. Deep nesting indented. Arrays show count badge. Long strings truncated with "Show all" link | — |
| LOG-ENTRY-005 | Entry detail — stack trace | Error entry with stack trace | Stack trace section: monospace text, file paths highlighted as links. Click file:line: if VS Code available, opens file (via `code --goto` link). Frame numbers in gutter. Exception type highlighted in red | — |
| LOG-ENTRY-006 | Copy entry | Click copy icon on row, or `Ctrl+C` with entry selected | Entry copied to clipboard as formatted JSON. Toast: "Log entry copied" (auto-dismiss 2s). JSON includes timestamp, level, component, message, all properties | — |
| LOG-ENTRY-007 | Copy entry — message only | Right-click entry → "Copy Message" | Only message text copied to clipboard. Toast: "Message copied" | — |
| LOG-ENTRY-008 | Filter by correlation | Click IterationId/RAID link in detail panel, or right-click entry → "Filter by IterationId" | RAID filter auto-selects this ID. Stream filters to show only entries with same correlation. Active filter badge updates. Breadcrumb hint: "Filtered to IterationId: abc-123" with ✕ to clear | LOG-FILT-042 |
| LOG-ENTRY-009 | Entry detail — dismiss | Click outside detail panel, or press `Escape`, or click ✕ | Detail panel slides closed (150ms). Entry row deselects (border removed, background reverts) | LOG-STRM-003 |
| LOG-ENTRY-010 | Entry context menu | Right-click a log row | Context menu: Copy Entry · Copy Message · Bookmark · Filter by Component · Filter by IterationId · Filter by Level · Open in New Window. Each with keyboard shortcut hint | LOG-ENTRY-* |
| LOG-ENTRY-011 | Detail panel resize | Drag divider between stream and detail panel | Panel resizes continuously following mouse. Min height 100px, max 60% of container. Position remembered per session (localStorage) | — |
| LOG-ENTRY-012 | Detail panel toggle mode | Click layout toggle in detail panel header | Switches between bottom-split and right-drawer layout. Preference saved to localStorage. Animated transition (200ms) | — |

---

## 3. TELEMETRY TAB

### 3.1 Connection & Empty States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TELE-001 | Empty | Telemetry tab activated, no events yet | Centered: activity icon (muted) + "Waiting for telemetry events..." + "SSR telemetry events will appear as operations execute" | TELE-002 |
| TELE-002 | First event arrives | First telemetry WebSocket message | Empty state fades out. First activity card slides in from bottom | TELE-003 |

### 3.2 Event Stream

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TELE-003 | Events streaming | Telemetry events arriving | Activity cards in vertical list, newest at top. Each card: activity name (bold) + status badge (Running ● / Succeeded ✓ / Failed ✕) + duration bar (accent fill proportional to elapsed vs estimated time) + start timestamp + correlation IDs. Running activities have animated duration bar (growing) | TELE-004 |
| TELE-004 | Activity completed | Activity receives completion event | Status badge transitions (● → ✓ or ✕). Duration bar freezes at final value. Colour transitions: green for success, red for failure. Duration text: "2.4s" | — |
| TELE-005 | Activity failed | Activity completes with error | Card gets red left border. Status: "Failed ✕" in red. Error summary below card: first line of exception. Click card to see full error detail | TELE-008 |
| TELE-006 | Long-running activity | Activity duration exceeds 30s | Duration bar turns amber. Badge: "Long-running" tooltip. Duration text pulses subtly. No auto-cancel — informational only | TELE-004 |
| TELE-007 | Many concurrent activities | >10 activities running simultaneously | Cards stack with virtual scroll. Running activities pinned to top with "ACTIVE" section header. Completed activities below in "COMPLETED" section. Section counts in headers | — |

### 3.3 Telemetry Interaction

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TELE-008 | Activity detail | Click activity card | Detail panel (same pattern as LOG-ENTRY-002): full activity name, all properties, child activities (nested), correlated log entries (cross-tab link). If RunDAG: shows per-node breakdown | — |
| TELE-009 | Cross-tab correlation | Click "View in Logs" link in activity detail | Tab switches to Logs. RAID filter auto-set to this activity's IterationId. Stream scrolls to time range of activity. Toast: "Filtered logs to activity: {name}" | LOG-FILT-042 |
| TELE-010 | Filter by activity name | Type in filter input above cards, or click funnel icon | Cards filter in real-time. Counter: "Showing 4 of 23 activities". Supports partial match | TELE-003 |
| TELE-011 | Filter by status | Click status pill filter: All / Running / Succeeded / Failed | Cards filter by status. Counts on pills update live | TELE-003 |
| TELE-012 | Filter by duration | Drag duration range slider (0s – max) | Cards filter to activities within duration range. Useful for finding slow operations | TELE-003 |
| TELE-013 | Export telemetry | Click [Export] button | Dropdown: JSON / CSV. Downloads filtered telemetry data. Toast: "Exported {n} activities" | — |

---

## 4. SYSTEM FILES TAB

### 4.1 Empty & Loading

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SYSF-001 | Empty | Tab activated, no file operations captured | Centered: file icon (muted) + "No file operations captured yet" + "File read/write/delete operations on OneLake will appear here when FLT accesses DagExecutionMetrics, locks, or settings" | SYSF-002 |
| SYSF-002 | First operation | First file operation event | Empty state fades. Table header appears + first row slides in | SYSF-003 |

### 4.2 File Operations Stream

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SYSF-003 | Operations streaming | File events arriving via WebSocket | Data table: Path (truncated, hover for full) | Operation (badge: Read=green, Write=amber, Delete=red) | Size (formatted: "4.2 KB") | Timestamp | IterationId (truncated). Newest at top. Rows slide in with subtle animation | — |
| SYSF-004 | Operation hover | Mouse enters table row | Row highlight. Full path shown in tooltip. Action icons appear: Copy Path, View Content, Filter by Directory | SYSF-005 |
| SYSF-005 | Operation selected | Click table row | Row gets accent background + left border. Detail panel opens: full path, operation type, raw size, full timestamp, IterationId, content preview (if JSON: formatted + syntax-highlighted; if binary: hex dump first 256 bytes) | SYSF-006 |
| SYSF-006 | Content preview — JSON | Selected file is JSON (dag.json, dagsettings.json, environment.json) | Detail panel shows formatted JSON tree: collapsible, syntax-coloured, line numbers. Search within content (Ctrl+F in panel). [Copy Content] button | — |
| SYSF-007 | Content preview — binary | Selected file is non-JSON | Detail panel: "Binary file ({size})" + hex dump preview (first 256 bytes) + file type hint if detectable | — |
| SYSF-008 | Content preview — unavailable | File content not captured (large file, or delete operation) | Detail panel: "Content not available" + reason ("File was deleted" or "Content too large to capture") | — |

### 4.3 File Filters

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SYSF-010 | Directory filter | Click directory filter dropdown | Dropdown: All Directories, DagExecutionMetrics, Locks, Settings, MLV Definitions, Other. Multi-select with checkboxes. Counts per directory | SYSF-003 |
| SYSF-011 | Operation type filter | Click operation badge filter | Toggle pills: All / Read / Write / Delete. Multiple selectable. Counts on each pill | SYSF-003 |
| SYSF-012 | Path search | Type in search input | Table filters to rows matching path substring. Highlights matches in path column. Counter: "4 of 127 operations" | SYSF-003 |
| SYSF-013 | Lock file highlight | File operation involves lock files (*.lock) | Row gets amber left border. If lock age >60s: warning icon + "Stale lock" tooltip. Lock holder shown if available | — |
| SYSF-014 | Export operations | Click [Export] | Downloads filtered operations as JSON or CSV. Includes content if available | — |

---

## 5. SPARK SESSIONS TAB

### 5.1 Empty & Loading

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SPARK-001 | Empty | Tab activated, no Spark sessions | Centered: notebook icon (muted) + "No Spark sessions active" + "Sessions will appear when FLT creates notebook execution contexts" | SPARK-002 |
| SPARK-002 | First session | NotebookExecutionContext created | Empty state fades. First session card animates in | SPARK-003 |

### 5.2 Session Lifecycle

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SPARK-003 | Session created | Session creation event | Session card: session ID (truncated) + "Created" status badge (blue) + creation timestamp + lifecycle progress bar at 0%. Card has blue left border | SPARK-004 |
| SPARK-004 | Session active | Session begins executing commands | Status badge: "Active ●" (green, pulsing dot). Lifecycle bar starts filling. Below card: command list grows as cells execute — each command shows: cell index, type (SQL/PySpark), status (Running/Done/Failed), duration. Green left border | SPARK-005 or SPARK-006 |
| SPARK-005 | Session — command executing | Cell/command running | Command row in session card: spinner + "Running cell 3 of 7..." + elapsed time counting up. Progress bar animates | SPARK-004 |
| SPARK-006 | Session disposed | Session explicitly disposed | Status badge: "Disposed" (grey). Lifecycle bar shows full duration. All commands completed. Left border grey. Duration text: "Lived 4m 32s". Card greyed slightly | — |
| SPARK-007 | Session timeout | Session exceeded TTL without activity | Status badge: "Timed Out ⚠" (amber). Lifecycle bar shows yellow segment for idle period. Tooltip: "Session idle for {duration} before timeout". Amber left border | — |
| SPARK-008 | Session error | Session crashed or failed | Status badge: "Error ✕" (red). Last command shows error. Red left border. Error summary visible without expanding | — |
| SPARK-009 | Session reuse | Existing session picked up for new MLV | "Reused" badge appears on session card (cyan). Command list continues growing with new MLV's cells. Lifecycle bar shows reuse boundary marker (thin vertical line) | SPARK-004 |

### 5.3 Session Interaction

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SPARK-010 | Session card expanded | Click session card | Card expands to show full command history: table of all cells executed with index, code snippet (first line), status, duration, retry count. Expandable rows for full code | — |
| SPARK-011 | Multiple sessions | >1 session exists | Sessions listed vertically, newest first. Active sessions pinned to top with "ACTIVE" section. Disposed/timed-out in "HISTORY" section. Filter: All / Active / Disposed / Errored | — |
| SPARK-012 | Session command detail | Click command row in expanded session | Detail panel: full code (syntax highlighted), execution metrics, Spark job URL (if available), error details if failed. [Copy Code] button | — |
| SPARK-013 | Session cross-reference | Click "View Logs" in session detail | Switches to Logs tab filtered by session's time range + Spark component preset. Shows correlated log entries | LOG-FILT-042 |
| SPARK-014 | Export sessions | Click [Export] | Downloads session lifecycle data as JSON. Includes all commands, timings, errors | — |

---

## 6. INTERNALS DROPDOWN SUB-VIEWS

### 6.1 Tokens

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INT-TOK-001 | Empty | No tokens captured yet | Centered: key icon + "No tokens captured" + "Tokens will appear as FLT authenticates with services" | INT-TOK-002 |
| INT-TOK-002 | Tokens streaming | Token events arriving | Card list: each token card shows: type badge (Bearer / MWC / S2S / OBO) + audience / scope + TTL countdown (live, mm:ss, colour transitions: green >10m, amber 5-10m, red <5m) + issued timestamp. Cards sorted by expiry (soonest first) | INT-TOK-003 |
| INT-TOK-003 | Token detail | Click token card | Expanded view: full JWT decode — Header (alg, typ), Payload (all claims, formatted table), Signature (truncated). Usage stream: list of API calls that used this token (timestamp + endpoint). [Copy Token] [Copy as cURL] buttons. Warning: sensitive data banner at top | — |
| INT-TOK-004 | Token expired | Token TTL reaches 0 | Card: TTL shows "EXPIRED" in red. Card dims. If refreshed: new token card appears, old one marked "(replaced)" | — |
| INT-TOK-005 | Token timeline | Click [Timeline] toggle | Horizontal timeline view: all tokens plotted by issued → expiry time. Overlapping tokens visible. Hover for detail. Useful for understanding token lifetimes | INT-TOK-002 (toggle back) |
| INT-TOK-006 | Token search | Type in filter input | Filter by token type, audience, claim values. "2 of 8 tokens" counter | INT-TOK-002 |

### 6.2 Caches

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INT-CACHE-001 | Empty | No cache events yet | Centered: database icon + "No cache activity captured" + "Cache read/write/evict events from FLT's 10 cache managers will appear here" | INT-CACHE-002 |
| INT-CACHE-002 | Caches streaming | Cache events arriving | Left sidebar: list of 10 cache managers (TokenManager, DagExecutionStore, etc.) with event count badges. Right panel: event stream for selected cache. Each event: operation (Get/Set/Evict badge) + key (truncated) + timestamp + TTL (if Set) + IterationId | INT-CACHE-003 |
| INT-CACHE-003 | Cache detail | Click event row | Detail: full cache key, full value (JSON formatted), TTL, eviction reason (if eviction), IterationId, which code path triggered the operation | — |
| INT-CACHE-004 | Cache eviction | Eviction event | Event row: red "Evict" badge. If TTL-based: "TTL expired". If capacity-based: "Cache full — LRU eviction". Count badge on cache manager sidebar increments | — |
| INT-CACHE-005 | Cache search | Type in search input | Filter events by key substring. Search across all cache managers or within selected one | INT-CACHE-002 |

### 6.3 HTTP Pipeline

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INT-HTTP-001 | Empty | No HTTP calls captured | Centered: globe icon + "No HTTP calls captured" + "Outbound HTTP requests through DelegatingHandlers will appear here" | INT-HTTP-002 |
| INT-HTTP-002 | Requests streaming | HTTP events arriving | Table: Method (badge: GET=green, POST=blue, PUT=amber, DELETE=red) | URL (truncated) | Status (coloured: 2xx=green, 4xx=amber, 5xx=red) | Duration (ms) | Retry (count, if >0) | Handlers (which of the 4 DelegatingHandlers fired). Newest first. Live updates | INT-HTTP-003 |
| INT-HTTP-003 | Request detail | Click table row | Detail panel: full URL, all request headers, request body (if POST/PUT), response status, response headers, response body (JSON formatted), handler chain (ordered list of which handlers processed), correlation IDs. Timing waterfall: DNS → Connect → TLS → Send → Wait → Receive | — |
| INT-HTTP-004 | Request failed | HTTP status 4xx or 5xx | Row: status badge in red/amber. Error detail in expandable sub-row. If 429: "Throttled" badge + retry-after value. If 5xx: error body preview | INT-HTTP-003 |
| INT-HTTP-005 | Filter requests | Use filter bar | Filter by: method, status range (2xx/4xx/5xx), URL pattern, duration range, handler. Multi-filter with AND logic. Active filter count badge | INT-HTTP-002 |
| INT-HTTP-006 | Export requests | Click [Export] | Downloads as HAR file (standard HTTP Archive format) or JSON. Toast: "Exported {n} requests" | — |

### 6.4 Retries & Throttling

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INT-RETRY-001 | Empty | No retry events yet | Centered: refresh icon + "No retries or throttling events" + "Retry attempts, 429/430 responses, and capacity admission delays will appear here" | INT-RETRY-002 |
| INT-RETRY-002 | Events streaming | Retry/throttle events arriving | Event cards: type badge (Retry / Throttle / Capacity Wait) + endpoint + reason + delay applied + attempt number. Capacity wait cards show window duration (20s/40s/60s/90s) with countdown if active. Colour: amber for retry, red for throttle, blue for capacity wait | INT-RETRY-003 |
| INT-RETRY-003 | Retry detail | Click event card | Detail: full request context, all retry attempts in chain (timeline visualization), jitter values applied, final outcome (succeeded after N retries / exhausted retries), rate limiter state (per artifact/user/capacity quotas) | — |
| INT-RETRY-004 | Active throttle | Currently being throttled (429 response, waiting) | Live card with countdown: "Throttled — retrying in 8s" with animated countdown bar. Card stays at top until resolved. Resolves to success (green flash) or failure (red) | — |
| INT-RETRY-005 | Throttle summary | Multiple throttle events | Summary bar: "12 retries, 3 throttled, 2 capacity waits in last 5 minutes" + trend indicator (▲ increasing / ▼ decreasing / — stable) | — |

### 6.5 Feature Flag Evals

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INT-FLAG-001 | Empty | No flag evaluations captured | Centered: flag icon + "No feature flag evaluations captured" + "FeatureFlighter.IsEnabled() calls will appear here in real-time" | INT-FLAG-002 |
| INT-FLAG-002 | Evals streaming | Flag eval events arriving | Table: Flag Name | Tenant | Capacity | Workspace | Result (green "true" / red "false") | Timestamp. Newest first. Result column colour-coded for instant scanning. Same flag name groups visually with alternating row tint | INT-FLAG-003 |
| INT-FLAG-003 | Flag detail | Click eval row | Detail: full flag name, all context parameters (tenantId, capacityId, workspaceId, etc.), evaluation result, evaluation path (which rule matched), evaluation duration | — |
| INT-FLAG-004 | Flag search | Type flag name in search input | Filter to matching flag evaluations. Auto-complete from seen flag names. Counter: "4 evals of 'FLTDagExecutionHandlerV2'" | INT-FLAG-002 |
| INT-FLAG-005 | Flag result flip | Same flag returns different result than previous eval | Row gets accent border flash. "Changed" badge appears. Previous result shown in strikethrough next to new result: "~~false~~ → true". Useful for detecting flag changes mid-session | — |
| INT-FLAG-006 | Flag summary | Click [Summary] toggle | Aggregated view: unique flags table with total eval count, true%, false%, last eval time. Sorted by eval count. Click row → filters stream to that flag | INT-FLAG-002 |

### 6.6 DI Registry

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INT-DI-001 | Empty | No DI data captured | Centered: container icon + "DI registry not yet captured" + "Container state from WorkloadApp.cs will appear after service initialization" | INT-DI-002 |
| INT-DI-002 | Registry loaded | DI registration snapshot received | Table: Service Type | Implementation | Lifetime (Singleton=blue / Transient=amber / Scoped=green pill) | EDOG Intercepted (✓ if replaced by EDOG, blank otherwise). 25+ rows. Sorted alphabetically by service type. EDOG-intercepted rows highlighted with accent left border | INT-DI-003 |
| INT-DI-003 | Registration detail | Click table row | Detail: full type names (namespace-qualified), constructor parameters, registration source (which extension method or direct call), if intercepted: original implementation shown below EDOG wrapper | — |
| INT-DI-004 | DI search | Type in search input | Filter registrations by service type or implementation name. Partial match. Counter: "4 of 27 registrations" | INT-DI-002 |
| INT-DI-005 | DI filter — intercepted only | Toggle "Show EDOG only" | Table filters to only EDOG-intercepted registrations. Shows which services EDOG is wrapping for debugging | INT-DI-002 |

### 6.7 Perf Markers

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INT-PERF-001 | Empty | No perf markers captured | Centered: timer icon + "No performance markers captured" + "MonitoredCodeMarkers duration metrics will stream here as operations execute" | INT-PERF-002 |
| INT-PERF-002 | Markers streaming | Perf marker events arriving | Table: Operation (PingApi, GetDag, RunDAG, etc.) | Duration (ms, colour-coded: green <100ms, amber 100-500ms, red >500ms) | Timestamp | IterationId. Bar chart column: inline horizontal bar proportional to duration relative to max in view | INT-PERF-003 |
| INT-PERF-003 | Marker detail | Click table row | Detail: operation name, precise duration (µs), start/end timestamps, parent operation (if nested), IterationId. History: sparkline of last 20 durations for this operation (shows trends) | — |
| INT-PERF-004 | Perf summary | Click [Summary] toggle | Aggregated view: each operation with min/avg/max/p50/p95/p99 durations. Sorted by avg duration descending. Click row → filters stream to that operation | INT-PERF-002 |
| INT-PERF-005 | Perf anomaly | Duration >3× the running average for that operation | Row gets red flash. "Slow" badge appears. Tooltip: "3.2× slower than average (avg: 45ms, this: 144ms)". Badge counts in toolbar: "2 anomalies" | — |
| INT-PERF-006 | Perf filter | Type operation name or set duration threshold | Filter by operation name (partial match) or duration range (e.g., >500ms). Useful for finding slow operations | INT-PERF-002 |
| INT-PERF-007 | Export markers | Click [Export] | Downloads perf data as JSON or CSV with summary statistics included | — |

---

## 7. CROSS-CUTTING STATES

### 7.1 Memory & Performance

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| RV-001 | Memory — normal | Session memory <150MB | No indicator. All tabs responsive. Virtual scroll active on all stream views | — |
| RV-002 | Memory — warning | Session memory 150-200MB | Status bar (bottom): "Memory: 178MB / 200MB" in amber. Oldest entries in all ring buffers aggressively pruned. Toast: "High memory usage — oldest entries being cleared" | RV-003 |
| RV-003 | Memory — critical | Session memory approaching 200MB | Status bar: "Memory: 195MB" in red + "Clear old data to continue". Auto-prune all ring buffers to 50% capacity. Internals sub-views clear oldest events. Force garbage collection | RV-001 |
| RV-004 | Performance — jank detected | Frame time exceeds 32ms during scroll or stream render | Automatic: reduce virtual scroll overscan, disable entry animations, batch DOM updates more aggressively. No user notification — silent performance adaptation | — |

### 7.2 Export (All Views)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| RV-010 | Export button | Each tab/sub-view has [Export] button | Button: download icon + "Export" in toolbar. Dropdown on click: JSON / CSV / HTML (where applicable). Exports respect current filters | RV-011 |
| RV-011 | Export in progress | Large dataset export (>5000 entries) | Button shows spinner. "Exporting 8,947 entries..." text. [Cancel] available. Progress percentage if >2s | RV-012 |
| RV-012 | Export complete | File generated | Browser download triggers. Toast: "Exported {n} entries to {format}" with file size. Button returns to normal | — |
| RV-013 | Export — empty | No data to export (filters too restrictive, or no events) | Toast: "Nothing to export — adjust filters or wait for data" | — |

### 7.3 Keyboard Shortcuts (F04-specific)

| Key | Action | Context |
|-----|--------|---------|
| `4` | Switch to Runtime View | Global (not in input) |
| `Alt+1` through `Alt+4` | Switch sub-tabs: Logs / Telemetry / System Files / Spark | Runtime View active |
| `Alt+5` | Open Internals dropdown | Runtime View active |
| `Space` | Pause / Resume log stream | Logs tab active, not in input |
| `Ctrl+L` | Clear log stream | Logs tab active |
| `Ctrl+/` | Focus text search | Logs tab active |
| `Ctrl+B` | Toggle bookmarks drawer | Logs tab active |
| `Shift+E` | Jump to next error | Logs tab active |
| `Shift+Ctrl+E` | Jump to previous error | Logs tab active |
| `Escape` | Dismiss detail panel / dropdown / drawer / search | Any |
| `Ctrl+Shift+F` | Clear all filters | Any tab with filters |
| `↑` / `↓` | Navigate entries/rows in active stream | Any stream/table focused |
| `Enter` | Select focused entry / expand cluster | Stream focused |
| `Ctrl+C` | Copy selected entry | Entry selected |
| `Ctrl+E` | Export current view | Any tab |
| `F5` | Force reconnect WebSocket | Any Runtime View tab |

### 7.4 Screen Reader Announcements

| Event | Announcement |
|-------|-------------|
| Runtime View opened (Phase 1) | "Runtime View. Service not connected. Deploy to a lakehouse to enable debugging tools." |
| Runtime View opened (Phase 2) | "Runtime View. Service connected. Logs tab active. Streaming log entries." |
| Tab switched | "{tab name} tab active. {count} entries." |
| WebSocket connected | "Log stream connected. Receiving entries." |
| WebSocket disconnected | "Log stream disconnected. Reconnecting, attempt {n}." |
| WebSocket failed | "Log stream offline. Reconnect button available." |
| Stream paused | "Log stream paused. {n} entries buffered." |
| Stream resumed | "Log stream resumed. Flushing {n} buffered entries." |
| Filter applied | "Filter active: {description}. Showing {n} of {total} entries." |
| Filter cleared | "All filters cleared. Showing all {n} entries." |
| Breakpoint added | "Breakpoint added: {pattern}. {n} matching entries highlighted." |
| Breakpoint removed | "Breakpoint removed: {pattern}." |
| Bookmark added | "Entry bookmarked. {n} total bookmarks." |
| Bookmark removed | "Bookmark removed. {n} remaining." |
| Error cluster detected | "Error cluster: {pattern}, {n} occurrences." |
| Entry selected | "Log entry selected. Level: {level}. Component: {component}. Detail panel open." |
| Export complete | "Exported {n} entries to {format}." |
| New error (unfocused tab) | "New error in {tab name}." |
| Spark session created | "New Spark session created. Session ID: {id}." |
| Spark session disposed | "Spark session disposed after {duration}." |
| Token expiring | "Token {type} expiring in {time}." |
| Perf anomaly | "Performance anomaly: {operation} took {duration}, {multiplier} times slower than average." |

### 7.5 Animation Timing Reference

| Animation | Duration | Easing | Use |
|-----------|----------|--------|-----|
| Tab underline slide | 200ms | ease-out | Active tab indicator transition |
| Tab content crossfade | 150ms out + 200ms in | ease | Tab content swap |
| Phase 2 tab enable | 100ms per tab × 5 stagger | ease-out | Tab labels enable on deploy |
| Dropdown appear | 100ms | cubic-bezier(0.34,1.56,0.64,1) | Internals dropdown, filter dropdowns |
| Dropdown dismiss | 80ms | ease-in | Fade out |
| Log entry append | 0ms (instant) | none | Normal streaming — no per-entry animation |
| Breakpoint pill appear | 200ms | cubic-bezier(0.34,1.56,0.64,1) | Scale 0→1 on add |
| Breakpoint pill remove | 150ms | ease-in | Scale 1→0 + fade |
| Bookmark star fill | 200ms | cubic-bezier(0.34,1.56,0.64,1) | Scale 1→1.3→1 + colour fill |
| Bookmarks drawer slide | 200ms | ease-out | Open/close 280px drawer |
| Detail panel open | 150ms | ease-out | Bottom or right panel expand |
| Detail panel close | 150ms | ease-in | Panel collapse |
| Cluster expand | 30ms per entry (max 500ms) | ease-out | Staggered entry reveal |
| Cluster collapse | 100ms | ease-in | Height collapse |
| Error flash | 300ms × 2 cycles | ease | Red pulse on error entry |
| Gold bookmark pulse | 300ms × 2 cycles | ease | Gold flash on navigate-to-bookmark |
| Throughput counter roll | 200ms | ease-out | Number change animation |
| Duration bar fill | continuous | linear | Telemetry activity duration |
| Session lifecycle bar | continuous | linear | Spark session elapsed time |
| Token countdown | 1s tick | step-end | TTL countdown |
| Filter badge update | 200ms | ease-out | Count increment/decrement |
| Hover state | 80-120ms | ease-out | Row highlight |
| Amber banner appear | 200ms | ease-out | Reconnecting / stale data |
| Memory warning flash | 400ms | ease | Status bar amber pulse |
| Perf anomaly flash | 300ms | ease | Red highlight on slow operation |

### 7.6 Responsive Behavior

| Breakpoint | Layout Change |
|------------|--------------|
| >1400px | Full layout: tab bar + stream area + detail panel (right drawer or bottom split, user choice) |
| 1000-1400px | Tab bar + stream area full width. Detail panel always bottom split (max 40% height). Bookmarks drawer overlays instead of pushing content |
| <1000px | Tab bar scrolls horizontally. Internals in hamburger menu. Stream area full width. Detail as full-screen overlay on entry click |
| <768px | Not supported — show message "EDOG Playground requires a desktop browser (1000px+)" |

---

*"200+ states. Every WebSocket hiccup handled. Every 1000 msg/s spike throttled. Zero blank screens. Zero 'where did my logs go?' moments."*

— F04 Runtime View UX Specification
