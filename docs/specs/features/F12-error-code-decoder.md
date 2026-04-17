# Feature 12: Error Intelligence & Log Experience

> **Phase:** MVP
> **Status:** Not Started
> **Spec:** docs/specs/features/F12-error-code-decoder.md
> **Design Ref:** docs/specs/design-spec-v2.md §12
> **PM Gap Analysis:** docs/specs/reviews/pm-logs-gap-analysis.md
> **Phantom Review:** docs/specs/reviews/phantom-logs-telemetry-review.md

---

## Problem

FLT logs are high-volume (1000+ entries/minute) and contain structured error codes like `MLV_SPARK_SESSION_ACQUISITION_FAILED` that engineers must grep the FLT codebase to decode. The current log viewer — while technically strong (virtual scroll, regex breakpoints, anomaly detection) — lacks: error code intelligence, search match visibility, log stream control (freeze/pause), and error frequency analytics. Engineers debugging pipeline failures spend more time reading logs than understanding them.

## Objective

Transform the Logs View from a log *reader* into an error *intelligence* tool:

1. **Decode** — Inline error code tooltips with human-readable descriptions, classifications, and fix suggestions
2. **Highlight** — Visual marking of search matches and error codes within log messages
3. **Freeze** — Pause the log stream for inspection without losing incoming data
4. **Analyze** — Error timeline, clustering, and frequency trends to surface patterns

---

## Scope Phases

### P0 — Error Code Decoder (Core)

The original mission: parse `ErrorRegistry.cs` at build time, highlight error codes at runtime.

#### Build Pipeline

| Item | Description |
|------|-------------|
| `scripts/generate-error-codes.py` | Parse `ErrorRegistry.cs` → `error-codes.json`. Extract: code, message template, severity (user/system), category, suggested fix. |
| JSON schema | `{ code: string, message: string, severity: "user" \| "system", category: string, suggestedFix: string, runbookUrl?: string }` |
| Build integration | `scripts/build-html.py` embeds `error-codes.json` as inline `<script>` in the single HTML output |

#### Runtime — Error Code Detection

Three-layer detection:

| Layer | What | Example | Visual |
|-------|------|---------|--------|
| **Known** | Code exists in `error-codes.json` | `MLV_SPARK_SESSION_ACQUISITION_FAILED` | Underline + accent badge |
| **Pattern-matched unknown** | Matches `MLV_*` / `FLT_*` pattern but not in registry | `MLV_UNKNOWN_FUTURE_CODE` | Dashed underline + "?" badge |
| **Pass-through** | No match | Regular log text | No decoration |

#### Runtime — Error Context Card

On hover/click of a decorated error code, show a **popover card** (not a tooltip):

- Error title + code
- Human-readable description
- Classification badge: `USER ERROR` / `SYSTEM ERROR`
- Suggested fix text
- "N occurrences in this session" with live count
- Actions: "Filter to all [CODE]" · "Copy error details" · "View in detail panel"
- If `runbookUrl` present: "View runbook →" link

#### Files

| Action | File | Changes |
|--------|------|---------|
| Create | `scripts/generate-error-codes.py` | ErrorRegistry.cs parser |
| Create | `src/frontend/js/error-decoder.js` | Error matching, card rendering, occurrence tracking |
| Modify | `src/frontend/js/renderer.js` | Call error decoder on row population |
| Modify | `src/frontend/css/logs.css` | Error code decoration styles, popover card styles |
| Modify | `scripts/build-html.py` | Include error-codes.json |

#### Acceptance Criteria

- [ ] Known FLT error codes in log messages are underlined/highlighted
- [ ] Hovering shows error context card with description, classification, fix, count
- [ ] Pattern-matched unknown codes get dashed underline + "?" indicator
- [ ] Build script generates valid `error-codes.json` from `ErrorRegistry.cs`
- [ ] Error codes JSON embedded in single HTML output
- [ ] Error codes decorated in both log row and detail panel
- [ ] Gracefully handles unknown error codes (no highlighting, no crash)

---

### P1 — Search & Highlight Infrastructure

Generic "highlight substring in log message" infrastructure that both error code decoration and search highlighting share.

> **PM Reference:** G-03 (search highlighting), G-06 (export formats)

#### Highlight Engine

- Modify `_populateRow` to support a `highlights: [{start, end, className}]` array
- **Search highlighting:** wrap matches in `<mark class="search-hit">`
- **Error code highlighting:** wrap known codes in `<span class="error-code-hint">`
- Both work with controlled `innerHTML` + proper HTML escaping (current `textContent` approach must be upgraded)
- Highlight priority: error code > search match (if overlapping, error code wins)

#### Export Upgrade

- Format selector: JSON / CSV / Plain Text
- Export only visible (filtered) logs, not the full buffer
- Clean export data: exclude internal state (`stats`, `filters`), include only log fields
- Success toast with count: "Exported 1,247 entries as CSV"

#### Acceptance Criteria

- [ ] Search terms highlighted in yellow within matching log rows
- [ ] Error codes and search highlights can coexist in the same row
- [ ] No XSS vectors from innerHTML usage (all user text escaped)
- [ ] Export supports JSON, CSV, plain text formats
- [ ] Export only includes filtered/visible entries
- [ ] Export shows success feedback with count

---

### P2 — Log Stream Control (Freeze/Pause)

> **CEO requirement:** "Logs will be always flowing — user can't stop at one position to read"

Buffered pause mode where the viewport freezes while new logs continue accumulating.

#### States

| State | Indicator | Behavior |
|-------|-----------|----------|
| **LIVE** | Pulsing green `● LIVE` badge in toolbar | Auto-scroll ON, viewport follows latest entry |
| **PAUSED** | Amber `⏸ PAUSED · 238 new` badge in toolbar | Viewport frozen, new logs buffer silently, counter ticks up |

#### Triggers

| Action | Result |
|--------|--------|
| **User scrolls up** | Auto-pause → PAUSED state. User intent detection: if they scroll away from bottom, they want to read. |
| **Click Pause button** | Manual pause → PAUSED state |
| **Mouse enters log area** (optional, configurable) | Temporary freeze — rows don't shift under cursor. Mouse leaves → resumes if was LIVE before. |
| **Click "Resume"** or buffered count badge | Snap to bottom → LIVE state |
| **Press `End` key** | Snap to bottom → LIVE state |
| **Press `Ctrl+↓`** | Snap to bottom → LIVE state |

#### Buffered Count Badge

While paused, a persistent banner/badge shows:

```
⏸ PAUSED — 238 new entries ▸ Resume
```

- Counter increments in real-time as new logs arrive
- Clicking the badge or "Resume" snaps to bottom and clears count
- Badge uses the amber/warning color from design tokens

#### Files

| Action | File | Changes |
|--------|------|---------|
| Modify | `src/frontend/js/renderer.js` | Scroll-up detection, LIVE/PAUSED state machine, buffered count tracking |
| Modify | `src/frontend/js/main.js` | Keyboard handlers (End, Ctrl+↓), toolbar badge rendering |
| Modify | `src/frontend/css/logs.css` | LIVE/PAUSED indicator styles, buffered count badge |

#### Acceptance Criteria

- [ ] Scrolling up in the log view automatically pauses auto-scroll
- [ ] "LIVE" indicator visible in toolbar when auto-scroll is active (pulsing green dot)
- [ ] "PAUSED" indicator with buffered count badge when paused
- [ ] Buffered count increments in real-time while paused
- [ ] Click "Resume" or press `End` snaps to bottom and restores LIVE mode
- [ ] New logs continue buffering in ring buffer during pause (no data loss)
- [ ] Keyboard shortcut `Ctrl+↓` also resumes live mode
- [ ] Hover-freeze is configurable (on/off in settings or logs toolbar)

---

### P3 — Error Analytics

Error timeline, clustering, and frequency trends to surface patterns beyond individual log entries.

> **CEO picks from V2 moonshot:** error timeline, error clustering, frequency trends

#### Error Timeline

A lightweight mini-timeline rendered above the log list (or in the error intelligence panel):

- Time axis: session duration, bucketed into 30-60 bars
- Y axis: error count per bucket
- Color-coded by error severity or error code
- Click a bar → filter logs to that time window
- Reuses time range filter infrastructure

#### Error Clustering (Enhanced)

Current: `detectClusters` groups *consecutive* errors with signature-based dedup (≥3 threshold).

Enhanced:
- **Global clustering:** group by error signature across the full ring buffer, not just consecutive
- **Cluster summary panel:** "MLV_SPARK_SESSION_ACQUISITION_FAILED: 47 occurrences, first at 14:30, last at 14:35, 3 distinct nodes"
- **Cluster expand:** click to see all occurrences with context
- **Pattern detection:** identify repeating error sequences (A → B → C pattern)

#### Frequency Trends

Per-error-code trend indicators:

- Badge on error cluster pills: `↑` (increasing) / `↓` (decreasing) / `→` (stable)
- First-seen / last-seen timestamps per code
- Rate calculation: errors/minute over sliding window
- Extend `le-cluster-summary` to show per-error-code counts

#### Error-to-Node Mapping

FLT errors are often node-specific. `ErrorIntelligence` (`error-intel.js:25-35`) already extracts `latestError.node` and `exec.skippedNodes`.

- Error context card includes: "Occurred in node: [NodeName]"
- Show downstream impact: "Skipped nodes: [list]"
- If node appears in DAG tab, add "View in DAG →" cross-link
- Filter action: "Show all errors from node [X]"

#### Files

| Action | File | Changes |
|--------|------|---------|
| Create | `src/frontend/js/error-timeline.js` | Timeline chart rendering, time-bucket aggregation |
| Modify | `src/frontend/js/error-intel.js` | Enhanced clustering, global signature grouping, frequency calculation |
| Modify | `src/frontend/js/logs-enhancements.js` | Cluster summary upgrades, trend badges |
| Modify | `src/frontend/css/logs.css` | Timeline chart styles, trend badge styles |

#### Acceptance Criteria

- [ ] Error timeline mini-chart visible above log list (or in error panel)
- [ ] Click timeline bar filters logs to that time window
- [ ] Error clusters work globally (not just consecutive)
- [ ] Cluster summary shows occurrence count, first/last seen, affected nodes
- [ ] Frequency trend badges (↑↓→) on error code pills
- [ ] Error context card shows node name and downstream skip impact
- [ ] "View in DAG" cross-link works when DAG tab is available

---

## Dependencies

- Access to FLT repo's `ErrorRegistry.cs` at build time (P0)
- Existing infrastructure: `renderer.js` RowPool, `state.js` RingBuffer, `error-intel.js` ErrorIntelligence class

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `innerHTML` for highlighting introduces XSS | Medium | Strict escaping: only `<mark>` and `<span>` with class attributes allowed. All text content HTML-escaped before wrapping. |
| Timeline chart performance with 50K entries | Low | Aggregate into 30-60 time buckets — the chart never renders 50K elements |
| Hover-freeze conflicts with virtual scroll | Low | Freeze only pauses auto-scroll, doesn't interfere with manual scroll or DOM recycling |
| ErrorRegistry.cs format changes | Low | Parser is regex-based, easy to update. Build step fails loudly on parse errors. |

## Non-Goals (V2+)

These are explicitly out of scope for MVP but the architecture should not prevent them:

- Full query language for log search (G-15)
- Log-to-telemetry correlation timeline (G-07)
- Execution-level log diffing (G-13)
- ML-powered log pattern detection (G-14)
- Log metrics/aggregation dashboards (G-16)
- Regex search in main search bar (G-10 — breakpoints already support this)
- Negative search / exclusion syntax (G-11)
- Context lines around filtered results (G-12)
- Saved filter views / persistent filter state (G-05)
- Inline log row expansion with dynamic row heights (G-01)
- Stack trace rendering with frame highlighting (G-08)

