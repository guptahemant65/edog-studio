# Toolbar & Controls — Complete UX State Matrix

> **Feature:** F26 Nexus — Real-Time Cross-Workload Dependency Graph
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Toolbar & Controls UX Specialist)
> **Date:** 2025-07-26
> **Depends On:** `components/C06-tab-nexus.md` (S11, S14, S17), `architecture.md` (§1, §5), `signalr-protocol.md` (§5.4 Staleness), `2026-04-24-nexus-design.md` (§5, §6)
> **States Documented:** 55

---

## How to Read This Document

Every state is documented as:

```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

Prefix key:
- `TB-INIT-*` — Toolbar initialisation and disabled states
- `TB-INT-*` — Internals toggle lifecycle
- `TB-FLT-*` — Health filter lifecycle
- `TB-CONN-*` — Connection status indicator states
- `TB-STAT-*` — Stats summary bar states
- `TB-LAY-*` — Layout control states (reset, re-center)
- `TB-SNAP-*` — Snapshot timestamp / freshness states
- `TB-PAUSE-*` — Pause/resume future control surface
- `TB-KBD-*` — Keyboard shortcut states
- `TB-ERR-*` — Error recovery states

---

## Data Dependencies

All toolbar state derives from two data sources:

| Source | Fields Consumed | Refresh Cadence |
|--------|----------------|-----------------|
| `NexusSnapshot` (via `nexus` topic) | `nodes[]`, `edges[]`, `alerts[]`, `generatedAt`, `windowSec` | 1 Hz heartbeat |
| `SignalRManager.status` | `'connected'`, `'reconnecting'`, `'disconnected'` | Event-driven |

Derived toolbar data:

| Metric | Derivation |
|--------|-----------|
| Total nodes | `snapshot.nodes.length` (excluding `flt-local` unless showing internals) |
| Total edges | `snapshot.edges.length` (respecting internals + health filter) |
| Visible nodes | Nodes passing internals toggle + health filter |
| Overall health | Worst `edge.health` across all visible edges (`critical` > `degraded` > `healthy`) |
| Last update | `snapshot.generatedAt` formatted as relative time ("2s ago") |
| Staleness | `Date.now() - Date.parse(snapshot.generatedAt) > 3000` |

---

## 1. INITIALISATION & DISABLED STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-INIT-001 | Toolbar disabled — tab inactive | Nexus tab is not the active Runtime View tab (`deactivate()` called or never activated) | Toolbar DOM exists but entire `.nexus-toolbar` has `pointer-events: none`, `opacity: 0.4`. All buttons show `aria-disabled="true"`. No staleness timer running. No keyboard listeners registered. Stats bar shows dashes: "-- nodes  -- edges". Connection indicator hidden. | TB-INIT-002 (tab activated) |
| TB-INIT-002 | Toolbar enabled — awaiting data | `activate()` called, SignalR connected, no snapshot received yet | Toolbar interactive (`opacity: 1.0`). Internals toggle: OFF (default). Health filter: "All" selected. Stats bar: "-- nodes  -- edges" with subtle pulse animation (awaiting data). Connection indicator: green dot + "Live". Layout controls: disabled (no graph to reset). Snapshot timestamp: "Waiting..." in `--text-muted`. Staleness timer started at 1s interval. | TB-STAT-001 (first snapshot), TB-CONN-003 (disconnect), TB-INIT-001 (tab deactivated) |
| TB-INIT-003 | Toolbar enabled — data loaded | First non-empty snapshot received | All controls active. Stats bar populates with real values. Snapshot timestamp shows relative time. Health filter buttons reflect current edge distribution. Layout controls enabled. This is the standard operating state — all other states branch from here. | TB-INT-*, TB-FLT-*, TB-CONN-*, TB-STAT-*, TB-LAY-*, TB-SNAP-*, TB-KBD-* |
| TB-INIT-004 | Toolbar enabled — empty graph | Snapshot received but `nodes` contains only `flt-local` (no dependency traffic yet) | Toolbar interactive. Stats bar: "0 nodes  0 edges". Health filter pills all show count 0; filter buttons enabled but have no effect. Internals toggle: functional but no filesystem node to reveal. Layout controls: disabled (nothing to reset). Snapshot timestamp shows time since last snapshot. | TB-INIT-003 (traffic arrives), TB-CONN-002 (stale), TB-INIT-001 (deactivated) |

---

## 2. INTERNALS TOGGLE STATES

The internals toggle controls visibility of the `filesystem` dependency node and its edge. Hidden by default per design spec §6.3 item 3.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-INT-001 | Internals hidden (default) | Initial state, or user clicks toggle while ON | Toggle button: ghost style, `--text-muted` text, `aria-pressed="false"`. Eye icon + "Internals" label. `filesystem` node and edge excluded from render loop. Stats bar counts exclude filesystem node/edge. Health filter counts exclude filesystem edge. Graph layout computed without filesystem. | TB-INT-002 (click toggle), TB-INT-003 (keyboard `I`) |
| TB-INT-002 | Internals shown | User clicks "Internals" toggle button | Toggle button: `active` class — `--accent-dim` background, `--accent` text/border, `aria-pressed="true"`. Label unchanged ("Internals"). `filesystem` node appears on ring. Layout recomputes immediately (`_layoutDirty = true`, `_computeLayout()`, `_scheduleRender()`). Stats bar counts include filesystem. Health filter includes filesystem edge health. If filesystem has critical health, its alert badge becomes visible on the node. | TB-INT-001 (click toggle again), TB-INT-004 (no filesystem in snapshot) |
| TB-INT-003 | Internals toggle via keyboard | User presses `I` (not in text input) | Equivalent to click. Toggle flips state. If currently TB-INT-001 -> TB-INT-002. If currently TB-INT-002 -> TB-INT-001. Focus ring appears briefly on toggle button (`--shadow-glow`, 150ms). | TB-INT-001 or TB-INT-002 |
| TB-INT-004 | Internals shown — no filesystem node | Toggle is ON but snapshot contains no `filesystem` node (no file I/O traffic) | Toggle shows `active` styling (user intent preserved). Graph unchanged — no filesystem node to show. Stats bar unchanged. No error or warning. Toggle remains interactive for when filesystem traffic arrives. If filesystem node appears in next snapshot, it renders immediately. | TB-INT-002 (filesystem appears), TB-INT-001 (user toggles off) |
| TB-INT-005 | Internals toggle while filter active | User toggles internals while a health filter (not "All") is active | Toggle state changes. If filesystem edge health does not pass the active filter, the filesystem node still does not render despite toggle being ON. Toggle shows `active` styling (intent preserved). Node appears only when both conditions met: internals ON AND edge health passes filter. | TB-INT-001, TB-INT-002 |

---

## 3. HEALTH FILTER STATES

Health filter is a pill-group control with four mutually exclusive options. Each pill shows a live count of edges matching that health level.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-FLT-001 | Filter: All (default) | Initial state, or user selects "All" pill | Four pills: **[All (N)]** `[Healthy (N)]` `[Degraded+ (N)]` `[Critical (N)]`. "All" pill has `active` class: `--accent-dim` bg, `--accent` text. Other pills: ghost style, `--text-muted`. All nodes/edges visible (subject to internals toggle). N = total visible edge count per health level. `aria-pressed="true"` on All, `"false"` on others. | TB-FLT-002, TB-FLT-003, TB-FLT-004, TB-FLT-005 |
| TB-FLT-002 | Filter: Healthy only | User clicks "Healthy" pill or presses `1` | "Healthy" pill: `active`. Others: ghost. Only edges with `health === "healthy"` render. Nodes connected only by hidden edges fade to `opacity: 0.2` (ghost nodes — still clickable but visually suppressed). Stats bar updates to show filtered counts. Graph layout unchanged (nodes don't move, only visibility changes). If no healthy edges exist: graph shows only FLT center node + "No healthy dependencies" annotation. | TB-FLT-001, TB-FLT-003, TB-FLT-004, TB-FLT-005 |
| TB-FLT-003 | Filter: Degraded+ | User clicks "Degraded+" pill or presses `2` | "Degraded+" pill: `active` with `--status-cancelled` tint. Edges with `health === "degraded"` or `health === "critical"` render. Healthy edges hidden. Ghost nodes for dependencies with only healthy edges. Triage-optimised: only problem dependencies visible. Stats bar: "Showing N degraded+ of M total". | TB-FLT-001, TB-FLT-002, TB-FLT-004, TB-FLT-005 |
| TB-FLT-004 | Filter: Critical only | User clicks "Critical" pill or presses `3` | "Critical" pill: `active` with `--status-failed` tint. Only edges with `health === "critical"` render. All other edges hidden. Strongest triage view. If no critical edges: "No critical dependencies" annotation centered on canvas, with a green shield icon and "All clear" message. Stats bar: "Showing N critical of M total". | TB-FLT-001, TB-FLT-002, TB-FLT-003, TB-FLT-005 |
| TB-FLT-005 | Filter: Keyboard cycling | User presses `0` through `3` | `0` = All, `1` = Healthy, `2` = Degraded+, `3` = Critical. Active pill updates. Focus ring on new active pill (150ms). Filter applies immediately. Same transitions as click-based selection. | TB-FLT-001 through TB-FLT-004 |
| TB-FLT-006 | Filter counts update | New snapshot arrives, edge health distribution changes | Pill counts update in-place. If the active filter now matches 0 edges (e.g., all critical edges recovered), the "no matches" annotation appears. Active filter selection does NOT auto-reset — user chose the filter, user clears it. Count badges use monospace numerals for stable layout width. | (stays in current filter state) |
| TB-FLT-007 | Filter + internals interaction | Health filter is non-"All" AND internals toggle changes | Filter result recomputed. The filesystem edge is included/excluded from filter evaluation based on internals toggle state. Pill counts update. If filesystem was the only edge matching the active filter and internals is toggled OFF, the "no matches" annotation may appear. | (stays in current filter state) |

---

## 4. CONNECTION STATUS INDICATOR STATES

Connection status is a small dot + label in the toolbar, mirroring the top-bar `rt-conn-dot` pattern. Driven by `SignalRManager.status` and snapshot staleness.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-CONN-001 | Connection: Live | `SignalRManager.status === 'connected'` AND last snapshot age < 3000ms | Green dot (`--status-succeeded`) + "Live" label in `--text-dim`. Dot is static (no pulse). This is the normal operating state. Staleness timer checks every 1s but finds fresh data. | TB-CONN-002 (stale), TB-CONN-003 (reconnecting), TB-CONN-004 (disconnected) |
| TB-CONN-002 | Connection: Stale | `SignalRManager.status === 'connected'` BUT `Date.now() - Date.parse(snapshot.generatedAt) > 3000` | Amber dot (`--status-cancelled`) + "Stale" label. Dot has slow pulse (2s cycle, `opacity: 0.5–1.0`). Tooltip: "No snapshot received for {N}s. Backend may be under load." All controls remain interactive (data is stale but not gone). Stats bar values freeze at last-known values. Snapshot timestamp turns amber: "{N}s ago". | TB-CONN-001 (fresh snapshot arrives), TB-CONN-003 (reconnecting), TB-CONN-004 (disconnected) |
| TB-CONN-003 | Connection: Reconnecting | `SignalRManager.status === 'reconnecting'` (auto-reconnect schedule active) | Amber dot with fast pulse (1s cycle) + "Reconnecting..." label. All controls remain interactive but data is frozen. Stats bar values freeze. Snapshot timestamp shows "Reconnecting..." in amber. Graph canvas dims slightly (`opacity: 0.85`) to signal uncertainty. Staleness timer continues running (will detect stale if reconnect takes >3s). | TB-CONN-001 (reconnect + fresh snapshot), TB-CONN-004 (reconnect failed) |
| TB-CONN-004 | Connection: Disconnected | `SignalRManager.status === 'disconnected'` (all retry attempts exhausted) OR SignalR never connected | Red dot (`--status-failed`) + "Disconnected" label. Graph canvas overlay: semi-transparent error state matching S17 error overlay from C06. Stats bar shows last-known values with `--text-muted` color + "(last known)" suffix. All filter/toggle controls remain interactive (operate on last-known data). Layout controls disabled (no live graph to manipulate). Snapshot timestamp: "Disconnected" in red. | TB-CONN-001 (connection restored), TB-CONN-003 (reconnect attempt) |
| TB-CONN-005 | Connection: Pre-connect | Tab activated but SignalR has not connected yet (disconnected phase of lifecycle) | Grey dot (`--status-pending`) + "Not connected" label. All controls except internals toggle and health filter are disabled. Stats bar: dashes. This state occurs in the Disconnected Phase (before FLT connects). | TB-CONN-001 (SignalR connects), TB-INIT-001 (tab deactivated) |

---

## 5. STATS SUMMARY BAR STATES

The stats bar is a horizontal strip within the toolbar showing: node count, edge count, overall health, and window size. Updated on each snapshot.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-STAT-001 | Stats: Updating | New snapshot arrives, values change from previous | Stat values update in-place with no animation (instant swap). Format: "**N** nodes  **M** edges  **{health}**  {windowSec}s window". Node count = `snapshot.nodes.length - 1` (exclude `flt-local`), adjusted for internals toggle and health filter. Edge count = visible edges after filter. Overall health: worst health across visible edges, shown as coloured status pill — green "Healthy", amber "Degraded", red "Critical". Window size: e.g., "300s window" in `--text-muted`. Monospace numerals prevent layout jitter. | TB-STAT-002 (no change), TB-STAT-003 (empty), TB-STAT-004 (filter changes counts) |
| TB-STAT-002 | Stats: Steady | New snapshot arrives, values identical to previous | No DOM update (diff check on count values). Avoids unnecessary reflows. Stats bar remains static. | TB-STAT-001 (values change next snapshot) |
| TB-STAT-003 | Stats: Empty graph | Snapshot has only `flt-local` node | Stats bar: "0 nodes  0 edges" in `--text-muted`. Overall health pill: grey "No data". Window size still shown. | TB-STAT-001 (traffic arrives) |
| TB-STAT-004 | Stats: Filter narrows view | Health filter or internals toggle changes visible set | Stats bar recalculates immediately from cached snapshot (no new network request). Counts reflect the current filter + internals state. Brief highlight flash on changed numerals (100ms `--accent-dim` background, then fade). | TB-STAT-001, TB-STAT-002 |
| TB-STAT-005 | Stats: Stale data | Connection enters stale or disconnected state | Stats values freeze at last-known. All stat text shifts to `--text-muted`. A small "(stale)" or "(last known)" annotation appears after the health pill. Values remain accurate to the last received snapshot. | TB-STAT-001 (fresh data resumes) |

---

## 6. LAYOUT CONTROL STATES

Two layout controls: "Reset Layout" (recalculate positions from seed) and "Re-center" (pan canvas to center the graph). Both are ghost-style buttons.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-LAY-001 | Layout controls: Idle | Graph is rendered, no layout operation in progress | Two ghost buttons: [Reset Layout] and [Re-center]. Both enabled. `--text-muted` text, `--border` outline. Cursor: pointer on hover. Hover: `--surface-2` background. | TB-LAY-002 (reset clicked), TB-LAY-004 (re-center clicked), TB-LAY-006 (keyboard) |
| TB-LAY-002 | Layout: Reset in progress | User clicks [Reset Layout] or presses `R` | Button text: "Resetting..." with 80ms fade. Button disabled during animation. `_layoutSeed` unchanged (deterministic). `_layoutDirty = true`. `_computeLayout()` runs synchronously (< 1ms for <=30 nodes). New positions applied. Canvas redraws via `_scheduleRender()`. If node positions are identical (same node set), no visible change. Total duration: single RAF frame. | TB-LAY-003 (complete) |
| TB-LAY-003 | Layout: Reset complete | `_computeLayout()` returns, render scheduled | Button text reverts to "Reset Layout" after 300ms delay (brief confirmation). Button re-enabled. If nodes moved, user sees them snap to new ring positions. No transition animation on node positions (instant repositioning — matches design spec §6.1 deterministic layout). | TB-LAY-001 (idle) |
| TB-LAY-004 | Re-center: In progress | User clicks [Re-center] or presses `C` | If pan/zoom transform is applied (future V2 feature), reset transform to identity. In V1 (no pan/zoom), this is a no-op — button exists for forward compatibility. Button shows brief "Centered" confirmation text (300ms). | TB-LAY-005 (complete) |
| TB-LAY-005 | Re-center: Complete | Transform reset, render scheduled | Button text reverts to "Re-center". Canvas shows graph at default scale/position. | TB-LAY-001 (idle) |
| TB-LAY-006 | Layout: Keyboard trigger | User presses `R` (reset) or `C` (re-center), not in text input | Equivalent to click. Focus ring on corresponding button (150ms `--shadow-glow`). Same lifecycle as click-based trigger. Guard: `e.target.tagName` check ensures not in input/textarea. | TB-LAY-002 or TB-LAY-004 |
| TB-LAY-007 | Layout controls: Disabled | No graph data (TB-INIT-002, TB-INIT-004) or connection disconnected (TB-CONN-004) | Both buttons: `aria-disabled="true"`, `opacity: 0.4`, `cursor: default`. Click is no-op. Keyboard shortcuts ignored. Tooltip: "No graph data to reset". | TB-LAY-001 (data arrives or reconnects) |

---

## 7. SNAPSHOT TIMESTAMP & FRESHNESS STATES

A small timestamp indicator in the toolbar showing when the last snapshot was generated. Updates every 1s via the staleness timer.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-SNAP-001 | Timestamp: Fresh | Snapshot age < 3000ms | Relative time: "1s ago" or "just now" in `--text-muted`, `--text-xs`, monospace. Updated every 1s by staleness timer. Tooltip: absolute UTC time from `snapshot.generatedAt`. No colour emphasis — data is current and unremarkable. | TB-SNAP-002 (age > 3s), TB-SNAP-004 (disconnect) |
| TB-SNAP-002 | Timestamp: Stale | Snapshot age >= 3000ms AND < 30000ms, connection still active | Text turns amber (`--status-cancelled`): "{N}s ago". Age counter increments each second. Tooltip: "Data may be stale. Backend aggregator may be under load." Triggers TB-CONN-002 (stale connection indicator). | TB-SNAP-001 (fresh snapshot), TB-SNAP-003 (very stale), TB-SNAP-004 (disconnect) |
| TB-SNAP-003 | Timestamp: Very stale | Snapshot age >= 30000ms, connection active | Text turns red (`--status-failed`): "{N}s ago" with slow pulse. Tooltip: "Data is significantly outdated. Check backend health." This threshold (30s = 30x heartbeat) indicates a serious backend issue, not just jitter. | TB-SNAP-001 (fresh snapshot), TB-SNAP-004 (disconnect) |
| TB-SNAP-004 | Timestamp: Disconnected | Connection lost (TB-CONN-003 or TB-CONN-004) | Text: "Disconnected" in `--status-failed`. No age counter (meaningless when disconnected). Staleness timer continues running but display is overridden by disconnect state. | TB-SNAP-001 (reconnect + fresh snapshot) |
| TB-SNAP-005 | Timestamp: No data yet | Tab active, no snapshot ever received | Text: "Waiting..." in `--text-muted` with subtle opacity pulse. Staleness timer running but no `generatedAt` to compare against. | TB-SNAP-001 (first snapshot arrives) |
| TB-SNAP-006 | Timestamp: Update tick | Staleness timer fires (every 1s) | Relative time recalculated: `Date.now() - Date.parse(this._snapshot.generatedAt)`. Display text updated only if formatted string changes (avoid unnecessary DOM writes). Staleness threshold evaluated: if age crosses 3000ms boundary, triggers TB-SNAP-002. If crosses 30000ms, triggers TB-SNAP-003. | (stays in current state or transitions per thresholds) |

---

## 8. PAUSE / RESUME STATES (Future Control Surface)

Pause/resume allows the user to freeze the graph at a point in time for inspection. Snapshots continue arriving but are buffered, not rendered. V1 scope — control surface present but may be deferred to V1.1.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-PAUSE-001 | Stream: Live (default) | Initial state, or user clicks Resume / presses `Space` | No pause indicator. Snapshots processed normally. Pause button (if rendered): ghost button with pause icon (two vertical bars). Label: "Pause". `aria-pressed="false"`. | TB-PAUSE-002 (pause clicked), TB-PAUSE-004 (keyboard) |
| TB-PAUSE-002 | Stream: Paused | User clicks Pause button or presses `Space` | Button swaps to play icon (triangle). Label: "Resume". `aria-pressed="true"`. Button has `active` class: `--accent-dim` bg. Graph freezes at current state. New snapshots buffered (ring buffer of last 5, drop oldest). Stats bar shows "(paused)" suffix in amber. Snapshot timestamp freezes but staleness timer still runs — stale indicator may appear. Canvas border: subtle amber dashed outline (1px `--status-cancelled`) to signal frozen state. | TB-PAUSE-003 (resume), TB-PAUSE-004 (keyboard) |
| TB-PAUSE-003 | Stream: Resuming | User clicks Resume or presses `Space` while paused | Latest buffered snapshot applied immediately (skip intermediates — full state replacement). Graph updates to current state. Pause indicator removed. Stats bar "(paused)" suffix removed. Canvas border reverts to normal. Button returns to pause icon. Brief "caught up" flash on stats bar (100ms `--accent-dim` bg). | TB-PAUSE-001 (live) |
| TB-PAUSE-004 | Pause: Keyboard toggle | User presses `Space` (not in text input, not on a button) | Toggle between TB-PAUSE-001 and TB-PAUSE-002. Guard: check `document.activeElement` is not input/textarea/button. Focus ring on pause/resume button (150ms). | TB-PAUSE-001 or TB-PAUSE-002 |

---

## 9. KEYBOARD SHORTCUT STATES

All toolbar shortcuts consolidated. Active only when Nexus tab is active AND focus is not in a text input or the detail panel.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-KBD-001 | Shortcut: `I` — Toggle internals | `keydown` event, `e.key === 'I'` or `e.key === 'i'` | Same as TB-INT-003. Internals toggle flips. Focus ring on toggle button. | TB-INT-001 or TB-INT-002 |
| TB-KBD-002 | Shortcut: `0` — Filter All | `keydown`, `e.key === '0'` | Same as TB-FLT-001. "All" pill activates. Focus ring on pill. | TB-FLT-001 |
| TB-KBD-003 | Shortcut: `1` — Filter Healthy | `keydown`, `e.key === '1'` | Same as TB-FLT-002. "Healthy" pill activates. | TB-FLT-002 |
| TB-KBD-004 | Shortcut: `2` — Filter Degraded+ | `keydown`, `e.key === '2'` | Same as TB-FLT-003. "Degraded+" pill activates. | TB-FLT-003 |
| TB-KBD-005 | Shortcut: `3` — Filter Critical | `keydown`, `e.key === '3'` | Same as TB-FLT-004. "Critical" pill activates. | TB-FLT-004 |
| TB-KBD-006 | Shortcut: `R` — Reset layout | `keydown`, `e.key === 'R'` or `e.key === 'r'` | Same as TB-LAY-006. Layout reset triggers. | TB-LAY-002 |
| TB-KBD-007 | Shortcut: `C` — Re-center | `keydown`, `e.key === 'C'` or `e.key === 'c'` | Same as TB-LAY-006. Re-center triggers. | TB-LAY-004 |
| TB-KBD-008 | Shortcut: `Space` — Pause/resume | `keydown`, `e.key === ' '` | Same as TB-PAUSE-004. Stream pause toggles. Guard: `e.target` not button/input/textarea. `e.preventDefault()` to avoid page scroll. | TB-PAUSE-001 or TB-PAUSE-002 |
| TB-KBD-009 | Shortcut guard: Input focused | Any shortcut key pressed while `document.activeElement` is `input`, `textarea`, or `[contenteditable]` | Key event ignored. No toolbar action. Normal text input behaviour. | (no transition) |
| TB-KBD-010 | Shortcut guard: Tab inactive | Any shortcut key pressed while `this._active === false` | Key event ignored. No keyboard listener registered (removed in `deactivate()`). | (no transition) |

---

## 10. ERROR RECOVERY STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TB-ERR-001 | Snapshot parse error | `_onSnapshot(envelope)` receives malformed data (`!data.nodes`, type mismatch) | Snapshot silently dropped. Console warn: "Nexus: malformed snapshot dropped (sequenceId: {id})". Toolbar remains in previous state. Stats bar unchanged. No user-facing error (transient; next snapshot expected in 1s). If 5+ consecutive drops, escalate to TB-ERR-003. | (stays in current state) |
| TB-ERR-002 | SequenceId gap detected | `envelope.sequenceId > this._lastSequenceId + 1` | Console warn: "Nexus: sequenceId gap ({expected} -> {received}), {gap} events missed". No user-facing indicator for small gaps (1–3). For gaps > 3: brief amber flash on connection indicator (500ms). Data is still valid (each snapshot is full state replacement, not delta). No recovery action needed. | TB-CONN-001 or TB-CONN-002 |
| TB-ERR-003 | Sustained data loss | 5+ consecutive malformed snapshots or 10+ seconds with no valid snapshot while connected | Stats bar shows "(data error)" suffix in `--status-failed`. Connection indicator remains green (connection is fine, data is bad). Tooltip on error suffix: "Multiple invalid snapshots received. Backend aggregator may need restart." Auto-clears when next valid snapshot arrives. | TB-STAT-001 (valid snapshot arrives) |
| TB-ERR-004 | SignalR reconnect recovery | Connection transitions from disconnected/reconnecting to connected | `subscribeTopic('nexus')` re-invoked. Ring buffer replays snapshots. First valid snapshot clears all stale/error indicators. Stats bar, timestamp, connection dot all transition to their "live" states. Graph redraws with fresh data. Smooth recovery — no manual user action needed. | TB-CONN-001, TB-STAT-001, TB-SNAP-001 |
| TB-ERR-005 | Tab reactivation recovery | User switches away from Nexus tab and back | `activate()` re-subscribes to topic. Staleness timer restarts. If cached `_snapshot` exists, toolbar renders from cache immediately (no flash of empty state). Fresh snapshot from subscription replaces cache within ~1s. If no cached snapshot, falls to TB-INIT-002. | TB-INIT-003 (has cache), TB-INIT-002 (no cache) |

---

## Complete Keyboard Shortcut Reference

| Key | Action | Guard | State Reference |
|-----|--------|-------|-----------------|
| `I` / `i` | Toggle internals visibility | Not in input | TB-KBD-001 |
| `0` | Filter: Show all | Not in input | TB-KBD-002 |
| `1` | Filter: Healthy only | Not in input | TB-KBD-003 |
| `2` | Filter: Degraded+ only | Not in input | TB-KBD-004 |
| `3` | Filter: Critical only | Not in input | TB-KBD-005 |
| `R` / `r` | Reset graph layout | Not in input | TB-KBD-006 |
| `C` / `c` | Re-center graph | Not in input | TB-KBD-007 |
| `Space` | Pause / resume stream | Not in input/button | TB-KBD-008 |
| `Tab` | Cycle node selection | Not in input | Handled by C06-S16 (graph canvas) |
| `Escape` | Close detail panel / deselect | Always | Handled by C06-S16 (graph canvas) |

---

## Full State Transition Map

```
                     ┌─────────────┐
                     │ TB-INIT-001 │  (Tab inactive)
                     │  disabled   │
                     └──────┬──────┘
                            │ activate()
                     ┌──────▼──────┐
                     │ TB-INIT-002 │  (Awaiting data)
                     │  enabled    │
                     └──────┬──────┘
                            │ first snapshot
              ┌─────────────▼─────────────┐
              │       TB-INIT-003         │  (Data loaded — operating state)
              │    ALL CONTROLS ACTIVE    │
              └─┬───┬───┬───┬───┬───┬──┬─┘
                │   │   │   │   │   │  │
    ┌───────────▼┐ ┌▼──┐│  ┌▼──┐│  ┌▼─┐│
    │  INTERNALS ││FLT ││ │CONN││ │LAY││
    │ INT-001/02 ││001 ││ │001 ││ │001││
    │ toggle ◄──►││thru││ │thru││ │thru││
    └────────────┘│005 ││ │005 ││ │007││
                  └────┘│ └────┘│ └───┘│
                   ┌────▼┐ ┌───▼──┐┌──▼───┐
                   │STATS│ │ SNAP ││PAUSE │
                   │001  │ │001   ││001/02│
                   │thru │ │thru  │└──────┘
                   │005  │ │006   │
                   └─────┘ └──────┘
```

---

## State x Event Cross-Reference Matrix

| Event \ State | TB-INIT-001 (disabled) | TB-INIT-002 (awaiting) | TB-INIT-003 (loaded) | TB-INIT-004 (empty graph) |
|---------------|----------------------|----------------------|--------------------|-----------------------|
| Snapshot arrives | Buffered (tab inactive) | -> TB-INIT-003 | TB-STAT-001 refresh | -> TB-INIT-003 if non-empty |
| Internals click | Ignored (disabled) | Toggle (visual only) | TB-INT-001/002 | Toggle (no visible effect) |
| Filter click | Ignored (disabled) | Apply (counts are 0) | TB-FLT-001..004 | Apply (counts are 0) |
| Reset Layout | Ignored (disabled) | Ignored (disabled) | TB-LAY-002 | Ignored (no graph) |
| Re-center | Ignored (disabled) | Ignored (disabled) | TB-LAY-004 | Ignored (no graph) |
| SignalR disconnect | TB-CONN-004 | TB-CONN-004 | TB-CONN-003/004 | TB-CONN-003/004 |
| SignalR reconnect | N/A | TB-CONN-001 | TB-ERR-004 | TB-ERR-004 |
| Tab deactivated | (already disabled) | -> TB-INIT-001 | -> TB-INIT-001 | -> TB-INIT-001 |
| Tab reactivated | -> TB-INIT-002/003 | (already active) | (already active) | (already active) |
| Keyboard shortcut | Ignored (no listener) | Processed | Processed | Processed (may be no-op) |
| Malformed snapshot | Ignored | TB-ERR-001 | TB-ERR-001 | TB-ERR-001 |
| Staleness timer | Not running | Evaluates (no snapshot = no stale) | TB-SNAP-001..003 | TB-SNAP-001..003 |

---

## Design Token Usage

| Toolbar Element | Token(s) | Notes |
|----------------|---------|-------|
| Toolbar background | `--surface` | Matches `.nexus-toolbar` in C06-S18 |
| Toolbar border | `--border` | Bottom border separating toolbar from canvas |
| Toggle button (off) | `--text-muted`, `--border`, `--surface` transparent bg | Ghost button pattern |
| Toggle button (on) | `--accent`, `--accent-dim` bg, `--accent` border | Active toggle pattern from DESIGN_SYSTEM.md |
| Filter pill (inactive) | `--text-muted`, `--border-bright` | Ghost style |
| Filter pill (active: All/Healthy) | `--accent-dim` bg, `--accent` text | Standard active pill |
| Filter pill (active: Degraded+) | `--status-cancelled` tint | Amber health encoding |
| Filter pill (active: Critical) | `--status-failed` tint | Red health encoding |
| Stats numerals | `--font-mono`, `--text-sm` | Monospace for stable width |
| Stats labels | `--text-muted`, `--text-xs` | De-emphasised metadata |
| Health pill (healthy) | `--status-succeeded` bg at 10%, `--status-succeeded` text | Status chip |
| Health pill (degraded) | `--status-cancelled` bg at 10%, `--status-cancelled` text | Status chip |
| Health pill (critical) | `--status-failed` bg at 10%, `--status-failed` text | Status chip |
| Connection dot | `--status-succeeded` / `--status-cancelled` / `--status-failed` / `--status-pending` | Matches `rt-conn-dot` |
| Timestamp (fresh) | `--text-muted` | Unremarkable when current |
| Timestamp (stale) | `--status-cancelled` | Amber warning |
| Timestamp (very stale) | `--status-failed` | Red alarm |
| Disabled controls | `opacity: 0.4`, `pointer-events: none` | Standard disabled pattern |
| Focus ring | `--shadow-glow` (`0 0 0 3px var(--accent-glow)`) | Keyboard navigation |
| Toolbar z-index | `--z-toolbar` (90) | Above canvas, below modals |

---

## Accessibility Notes

1. **ARIA states:** All toggles use `aria-pressed`. All disabled controls use `aria-disabled="true"`. Filter pills form a `role="radiogroup"` with `role="radio"` on each pill and `aria-checked` matching active state.
2. **Keyboard:** Every control is reachable via keyboard shortcut. Focus indicators use `--shadow-glow` (3px accent ring). Tab order: Internals toggle -> Filter pills (left to right) -> Layout buttons -> Pause button -> Timestamp (readonly).
3. **Screen readers:** Connection status changes announced via `aria-live="polite"` region. Stats bar is `role="status"` with `aria-live="polite"`. Filter changes announced: "Showing degraded and critical dependencies, 3 of 7 edges visible."
4. **Colour independence:** Health states are encoded by colour AND text label (e.g., green dot AND "Live" text, amber dot AND "Stale" text). Filter pills include text labels, not just colour.
5. **Motion:** Pulse animations respect `prefers-reduced-motion: reduce` — pulse replaced with static amber/red styling.
