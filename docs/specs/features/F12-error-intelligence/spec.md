# Feature 12: Error Intelligence & Log Experience

> **Status:** P0 (Foundation Research) — NOT STARTED
> **Phase:** MVP
> **Owner:** Pixel (JS/CSS) + Vex (build pipeline)
> **Design Ref:** docs/specs/design-spec-v2.md §12
> **SOP:** hivemind/FEATURE_DEV_SOP.md
> **PM Gap Analysis:** docs/specs/reviews/pm-logs-gap-analysis.md
> **Phantom Review:** docs/specs/reviews/phantom-logs-telemetry-review.md

---

## 1. Problem

FLT logs are high-volume (1000+ entries/minute) and contain structured error codes like `MLV_SPARK_SESSION_ACQUISITION_FAILED` that engineers must grep the FLT codebase to decode. The current log viewer — while technically strong (virtual scroll, regex breakpoints, anomaly detection) — lacks: error code intelligence, search match visibility, log stream control (freeze/pause), and error frequency analytics. Engineers debugging pipeline failures spend more time *reading* logs than *understanding* them.

## 2. Objective

Transform the Logs View from a log *reader* into an error *intelligence* tool:

1. **Decode** — Inline error code tooltips with human-readable descriptions, classifications, and fix suggestions
2. **Highlight** — Visual marking of search matches and error codes within log messages
3. **Freeze** — Pause the log stream for inspection without losing incoming data
4. **Analyze** — Error timeline, clustering, and frequency trends to surface patterns

## 3. What User Sees

### Error Code Decoration

Log messages containing known FLT error codes are underlined with an accent-colored badge. Three-layer detection:

| Layer | What | Example | Visual |
|-------|------|---------|--------|
| **Known** | Code exists in `error-codes.json` | `MLV_SPARK_SESSION_ACQUISITION_FAILED` | Solid underline + accent badge |
| **Pattern-matched unknown** | Matches `MLV_*` / `FLT_*` pattern but not in registry | `MLV_UNKNOWN_FUTURE_CODE` | Dashed underline + "?" badge |
| **Pass-through** | No match | Regular log text | No decoration |

### Error Context Card

On hover/click of a decorated error code, a popover card (not tooltip) shows:

- Error title + code
- Human-readable description
- Classification badge: `USER ERROR` / `SYSTEM ERROR`
- Suggested fix text
- "N occurrences in this session" with live count
- Node context: "Occurred in node: [NodeName]" with downstream skip impact
- Actions: "Filter to all [CODE]" · "Copy error details" · "View in detail panel"
- If `runbookUrl` present: "View runbook →" link

### Search Highlighting

When search is active, matching substrings are highlighted in `<mark>` within log rows. Error code decoration and search highlighting coexist (error code wins on overlap).

### Log Stream Control

| State | Indicator | Behavior |
|-------|-----------|----------|
| **LIVE** | Pulsing green `● LIVE` badge in toolbar | Auto-scroll ON, viewport follows latest entry |
| **PAUSED** | Amber `⏸ PAUSED · 238 new` badge in toolbar | Viewport frozen, new logs buffer silently, counter ticks up |

Triggers: scroll-up → auto-pause · click Pause → manual pause · `End` / `Ctrl+↓` → resume · click badge → resume · hover-freeze (configurable)

### Error Timeline

Mini-chart above log list: 30-60 time-bucketed bars, colored by severity. Click a bar → filter to that time window.

### Error Clustering (Enhanced)

Global signature-based grouping across full buffer (not just consecutive). Cluster summary: occurrence count, first/last seen, affected nodes, trend badge (↑↓→).

### Frequency Trends

Per-error-code rate indicators: errors/minute over sliding window, trend direction, first-seen / last-seen timestamps.

### Export Upgrade

Format selector: JSON / CSV / Plain Text. Only exports filtered/visible entries. Success toast with count.

## 4. Existing Code

| File | What exists | Relevance |
|------|-------------|-----------|
| `src/frontend/js/renderer.js` (25KB) | RowPool, virtual scroll, `_populateRow`, `passesFilter`, auto-scroll FAB | Core rendering — P1/P2/P3 all modify this |
| `src/frontend/js/logs-enhancements.js` (38KB) | Regex breakpoints, error clustering (`detectClusters`), anomaly detection, bookmarks | P3 extends clustering, reuses regex validation |
| `src/frontend/js/error-intel.js` (2KB) | `ErrorIntelligence` class — node extraction, skip detection | P3 extends with global clustering, node mapping |
| `src/frontend/js/main.js` | `exportLogs()`, keyboard handlers, toolbar rendering | P1 export upgrade, P2 keyboard resume |
| `src/frontend/js/state.js` | `RingBuffer` (50K), `FilterIndex`, search state | P2 buffered count tracking, P3 aggregation source |
| `src/frontend/css/logs.css` | Log row styles, error code hint CSS (L271-276) | All phases add styles here |
| `src/frontend/css/variables.css` | Design tokens, light theme default | Token reference for all new UI |
| `scripts/build-html.py` | Single HTML builder | P0 adds error-codes.json embedding |

## 5. Components (7 total)

| ID | Component | Phase | New/Modify |
|----|-----------|-------|------------|
| C01 | Error Code Build Pipeline | P0 core | New: `scripts/generate-error-codes.py` |
| C02 | Error Decoder Runtime | P0 core | New: `src/frontend/js/error-decoder.js` |
| C03 | Highlight Engine | P1 | Modify: `renderer.js` `_populateRow` |
| C04 | Export Manager | P1 | Modify: `main.js` `exportLogs()` |
| C05 | Log Stream Controller | P2 | Modify: `renderer.js`, `main.js` |
| C06 | Error Timeline Chart | P3 | New: `src/frontend/js/error-timeline.js` |
| C07 | Enhanced Error Clustering | P3 | Modify: `error-intel.js`, `logs-enhancements.js` |

## 6. Acceptance Criteria

### P0 — Error Code Decoder
- [ ] Build script generates valid `error-codes.json` from `ErrorRegistry.cs`
- [ ] Error codes JSON embedded in single HTML output
- [ ] Known FLT error codes in log messages are underlined/highlighted
- [ ] Pattern-matched unknown codes get dashed underline + "?" indicator
- [ ] Hovering shows error context card with description, classification, fix, count
- [ ] Error codes decorated in both log row and detail panel
- [ ] Gracefully handles unknown error codes (no highlighting, no crash)

### P1 — Search & Highlight Infrastructure
- [ ] Search terms highlighted in yellow within matching log rows
- [ ] Error codes and search highlights coexist in same row
- [ ] No XSS vectors from innerHTML usage (all user text escaped)
- [ ] Export supports JSON, CSV, plain text formats
- [ ] Export only includes filtered/visible entries
- [ ] Export shows success feedback with count

### P2 — Log Stream Control
- [ ] Scrolling up automatically pauses auto-scroll
- [ ] "LIVE" indicator visible in toolbar when auto-scroll active (pulsing green dot)
- [ ] "PAUSED" indicator with buffered count badge when paused
- [ ] Buffered count increments in real-time while paused
- [ ] Click "Resume" or press `End` snaps to bottom and restores LIVE mode
- [ ] New logs continue buffering in ring buffer during pause (no data loss)
- [ ] `Ctrl+↓` also resumes live mode
- [ ] Hover-freeze is configurable (on/off in settings or logs toolbar)

### P3 — Error Analytics
- [ ] Error timeline mini-chart visible above log list
- [ ] Click timeline bar filters logs to that time window
- [ ] Error clusters work globally (not just consecutive)
- [ ] Cluster summary shows occurrence count, first/last seen, affected nodes
- [ ] Frequency trend badges (↑↓→) on error code pills
- [ ] Error context card shows node name and downstream skip impact
- [ ] "View in DAG" cross-link works when DAG tab available

## 7. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `innerHTML` for highlighting introduces XSS | Medium | Strict escaping: only `<mark>` and `<span>` with class attributes. All text HTML-escaped before wrapping. |
| Timeline chart performance with 50K entries | Low | Aggregate into 30-60 time buckets — chart never renders 50K elements |
| Hover-freeze conflicts with virtual scroll | Low | Freeze only pauses auto-scroll, doesn't interfere with manual scroll or DOM recycling |
| ErrorRegistry.cs format changes | Low | Parser is regex-based, easy to update. Build step fails loudly on parse errors. |

## 8. Dependencies

- Access to FLT repo's `ErrorRegistry.cs` at build time (P0)
- Existing infrastructure: `renderer.js` RowPool, `state.js` RingBuffer, `error-intel.js` ErrorIntelligence class

## 9. Non-Goals (V2+)

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

---

## 10. Prep Checklist

### Phase 0: Foundation Research

| Task | What | Who | Output |
|------|------|-----|--------|
| P0.1 | **Existing code audit** — read `renderer.js` (RowPool, _populateRow, passesFilter, auto-scroll), `logs-enhancements.js` (clustering, breakpoints), `error-intel.js` (ErrorIntelligence class), `main.js` (export, keyboard), `state.js` (RingBuffer, FilterIndex). Map every function that F12 touches. | Pixel | `research/p0-foundation.md` §1 |
| P0.2 | **ErrorRegistry.cs analysis** — read the actual C# source. Map error code format, message templates, categories. Determine parsing strategy. | Vex | `research/p0-foundation.md` §2 |
| P0.3 | **Industry research** — how do Datadog, Grafana Loki, Seq, Chrome DevTools handle: error highlighting, log stream freeze, error analytics. Extract patterns. | Sana | `research/p0-foundation.md` §3 |
| P0.4 | **innerHTML security audit** — current `textContent` usage in `_populateRow`. Map every place that would need to switch to `innerHTML` for highlighting. Document escaping strategy. | Pixel | `research/p0-foundation.md` §4 |

**Gate:** P0 DONE before P1 starts.

### Phase 1: Component Deep Specs

| Task | What | Who | Output |
|------|------|-----|--------|
| P1.1 | **C01 — Error Code Build Pipeline** — parser design, JSON schema, build integration, error handling | Vex | `components/C01-build-pipeline.md` |
| P1.2 | **C02 — Error Decoder Runtime** — pattern matching, 3-layer detection, context card rendering, occurrence tracking | Pixel | `components/C02-error-decoder.md` |
| P1.3 | **C03 — Highlight Engine** — generic highlight array, innerHTML transition, escaping, priority rules | Pixel | `components/C03-highlight-engine.md` |
| P1.4 | **C04 — Export Manager** — format selector, filtered export, toast feedback, clean data shape | Pixel | `components/C04-export-manager.md` |
| P1.5 | **C05 — Log Stream Controller** — LIVE/PAUSED state machine, scroll-up detection, buffered count, keyboard shortcuts, hover-freeze | Pixel | `components/C05-stream-controller.md` |
| P1.6 | **C06 — Error Timeline Chart** — time bucketing, bar rendering, click-to-filter, color coding | Pixel | `components/C06-error-timeline.md` |
| P1.7 | **C07 — Enhanced Clustering** — global signature grouping, frequency calculation, trend badges, node mapping | Pixel | `components/C07-enhanced-clustering.md` |

**Gate:** All component specs DONE before P2 starts.

### Phase 2: Architecture

| Task | What | Who | Output |
|------|------|-----|--------|
| P2.1 | **Data model** — error-codes.json schema, highlight array format, LIVE/PAUSED state shape, cluster data structures, timeline bucket format | Sana | `architecture.md` §1 |
| P2.2 | **Highlight engine design** — how `_populateRow` changes, innerHTML escaping pipeline, highlight priority resolution, performance with 50K rows | Sana | `architecture.md` §2 |
| P2.3 | **Stream controller design** — scroll event detection, buffered count tracking, state transitions, keyboard bindings, hover-freeze toggle | Sana | `architecture.md` §3 |
| P2.4 | **Timeline aggregation** — time bucketing algorithm, incremental updates as new logs arrive, filter integration | Sana | `architecture.md` §4 |
| P2.5 | **Performance targets** — highlight rendering <1ms per row, timeline update <16ms, stream state change <1 frame | Sana | `architecture.md` §5 |

**Gate:** Architecture DONE before P3 starts.

### Phase 3: State Matrices

| Task | What | Who | Output |
|------|------|-----|--------|
| P3.1 | **Error decoder states** — hover, click, card open, card pinned, filter-from-card, copy, dismiss | Pixel (popover UX specialist) | `states/error-decoder.md` |
| P3.2 | **Stream controller states** — LIVE, PAUSED (scroll-triggered), PAUSED (manual), PAUSED (hover-freeze), resuming, badge interactions | Pixel (log UX specialist) | `states/stream-controller.md` |
| P3.3 | **Timeline chart states** — empty, populating, hover-bar, click-filter, time-range-active, reset | Pixel (chart UX specialist) | `states/error-timeline.md` |
| P3.4 | **Export dialog states** — format select, exporting, success, error, empty-filtered-warning | Pixel (dialog UX specialist) | `states/export-manager.md` |

**Gate:** All state matrices DONE before P4 starts.

### Phase 4: Interactive Mocks

| Task | What | Who | Output |
|------|------|-----|--------|
| P4.1 | **Logs view with all F12 features** — error highlighting, context cards, LIVE/PAUSED toggle, timeline chart, enhanced clustering, export dialog. Single self-contained HTML. | Phantom | `mocks/error-intelligence.html` |

**Gate:** CEO approves mock before implementation starts.

### Phase 5: Implementation

| Layer | What | Agent | Rule |
|-------|------|-------|------|
| L0 | `scripts/generate-error-codes.py` — build pipeline | One agent | Verify with test ErrorRegistry input |
| L1 | `src/frontend/js/error-decoder.js` — runtime decoder | One agent | Match card design from mock |
| L2 | `renderer.js` highlight engine — innerHTML transition | One agent | Security audit from P0.4 |
| L3 | `renderer.js` stream controller — LIVE/PAUSED | One agent | Match state matrix P3.2 |
| L4 | `src/frontend/js/error-timeline.js` — timeline chart | One agent | Match mock exactly |
| L5 | `error-intel.js` + `logs-enhancements.js` — enhanced clustering | One agent | Match P3.3 states |
| L6 | `main.js` — export upgrade, keyboard bindings | One agent | Surgical edits only |
| L7 | `logs.css` — all new styles | One agent | Match mock tokens |
| L8 | `build-html.py` — wire error-codes.json | One agent | Verify build passes |
| L9 | Build + Test | Verify | `make build && make test` |

## 11. Implementation Order (AFTER all prep is done)

```
L0 (build pipeline) → L1 (decoder) → L2 (highlight engine) → L3 (stream controller)
                                                              → L4 (timeline) → L5 (clustering)
                                                              → L6 (export + keys)
                                                              → L7 (CSS)
                                                              → L8 (build wiring) → L9 (verify)
```

L0→L1→L2 is sequential (each depends on prior). L3-L7 can be parallelized after L2.
