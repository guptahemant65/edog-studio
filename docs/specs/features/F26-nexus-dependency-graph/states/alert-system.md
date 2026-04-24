# Alert System — Complete UX State Matrix

> **Feature:** F26 Nexus Dependency Graph — Alert & Notification System
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Frontend Engineer)
> **Date:** 2026-04-24
> **Depends On:** `signalr-protocol.md` (NexusAlert, out-of-band alert message), `C03-nexus-aggregator.md` (anomaly detection algorithm), `C06-tab-nexus.md` (S13 alert rendering, S17 error states), `DESIGN_SYSTEM.md` (tokens, z-index, transitions)
> **States Documented:** 78

---

## How to Read This Document

Every state is documented as:

```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

Prefix key:
- `AL-NONE-*` — Quiescent / no active alerts
- `AL-SINGLE-*` — Single anomaly alert lifecycle
- `AL-MULTI-*` — Multiple concurrent alerts (stacking)
- `AL-ACK-*` — Acknowledgment / dismissal
- `AL-AUTO-*` — Auto-dismiss when anomaly resolves
- `AL-NAV-*` — Alert click → graph navigation / highlight
- `AL-STALE-*` — Data staleness detection
- `AL-CONN-*` — Connection status (lost / reconnecting / restored)
- `AL-OVER-*` — Overflow / alert storm management
- `AL-BADGE-*` — Tab badge (inactive tab alert count)
- `AL-TIER-*` — Urgency tier visual differentiation
- `AL-ERR-*` — Alert subsystem internal errors
- `AL-A11Y-*` — Keyboard accessibility for alert system

---

## 0. Data Contract Reference

### 0.1 Alert Payload (from `nexus` topic)

Two delivery paths for the same alert data:

**Embedded in snapshot** (`type: "snapshot"` → `data.alerts[]`):

| Field | Type | Description |
|-------|------|-------------|
| `severity` | `string` | `"warning"` or `"critical"`. No `"info"` level. |
| `dependencyId` | `string` | Canonical dependency ID (e.g., `spark-gts`, `auth`, `onelake`). |
| `message` | `string` | Human-readable English string for toast rendering. |
| `timestamp` | `string` (ISO 8601) | When alert was generated. |

**Out-of-band alert** (`type: "alert"` — published immediately between snapshots):

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"alert"`. |
| `severity` | `string` | `"warning"` or `"critical"`. |
| `dependencyId` | `string` | Which dependency triggered anomaly. |
| `metric` | `string` | Trigger metric: `"p95Ms"`, `"errorRate"`, `"retryRate"`. |
| `currentValue` | `double` | Current metric value at trigger time. |
| `baselineValue` | `double` | Baseline for comparison. |
| `delta` | `double` | `currentValue / baselineValue` ratio. |
| `message` | `string` | Human-readable alert text. |
| `timestamp` | `string` (ISO 8601) | When alert was generated. |

### 0.2 Anomaly Detection Thresholds (from C03-S06)

| Metric | Warning | Critical |
|--------|---------|----------|
| Latency (p50 / baseline) | >= 3.0x | >= 5.0x |
| Error rate delta (current - baseline) | >= 0.10 | — |
| Error rate absolute | — | >= 0.50 |

**Debounce:** Per-dependency, 30-second cooldown. Same `(dependencyId, severity)` suppressed.

### 0.3 Visual Token Reference

| Element | Token / Value | Source |
|---------|---------------|--------|
| Warning icon | `\u26A0` (amber) | C06-S13 |
| Critical icon | `\u25CF` (red dot) | C06-S13 |
| Warning color | `--status-cancelled` (`#e5940c` / `#f0b429`) | DESIGN_SYSTEM.md |
| Critical color | `--status-failed` (`#e5453b` / `#ff6b6b`) | DESIGN_SYSTEM.md |
| Success color | `--status-succeeded` (`#18a058` / `#34d399`) | DESIGN_SYSTEM.md |
| Toast z-index | `--z-toast` (`400`) | DESIGN_SYSTEM.md |
| Toast close icon | `\u2715` | C06-S13 |
| Transition speed | `--transition-normal` (`150ms ease-out`) | DESIGN_SYSTEM.md |
| Fast transition | `--transition-fast` (`80ms ease-out`) | DESIGN_SYSTEM.md |
| Auto-dismiss timer | 8 seconds | C06-S13 |
| Max visible toasts | 3 | C06-S13 |
| Dedup window | 10 seconds (key: `dependencyId + severity + message`) | C06-S13 |
| Staleness threshold | 3 seconds (3x the 1 Hz heartbeat) | signalr-protocol.md §5.4 |
| Badge radius | `--radius-full` | DESIGN_SYSTEM.md |
| Badge font | `--font-mono`, `--text-xs`, weight 600 | DESIGN_SYSTEM.md |

### 0.4 Toast DOM Structure

```html
<div class="nexus-toast-container">  <!-- positioned top-right of Nexus tab, z-index: var(--z-toast) -->
  <div class="nexus-toast severity-warning">
    <span class="nexus-toast-icon">\u26A0</span>
    <span class="nexus-toast-msg">Latency 3.0x above baseline (690ms vs 230ms avg)</span>
    <button class="nexus-toast-close">\u2715</button>
  </div>
</div>
```

### 0.5 Staleness / Connection Overlay DOM Structure

```html
<div class="nexus-overlay nexus-stale-indicator hidden">
  <span class="nexus-stale-dot"></span> Data may be stale
</div>
<div class="nexus-overlay nexus-conn-lost hidden">
  Connection lost — reconnecting...
</div>
<div class="nexus-overlay nexus-conn-restored hidden">
  Reconnected
</div>
```

---

## 1. QUIESCENT STATES (No Active Alerts)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-NONE-001 | No alerts — graph healthy | All edges `health: "healthy"`, `snapshot.alerts` empty, SignalR connected, staleness timer < 3s | Toast container empty (display: none). No overlay indicators. Graph renders normally per C06-S04. Tab badge count: 0 (badge hidden). Staleness dot hidden. Connection dot green (from `rt-conn-dot`). Screen reader: no live region announcements | AL-SINGLE-001, AL-STALE-001, AL-CONN-001 |
| AL-NONE-002 | No alerts — graph empty | Tab activated, no snapshot received yet (cold start) | Empty state per C06-S17: graph icon + "No dependency data yet". Toast container empty. No alert-related UI visible. Tab badge: 0 (hidden). Connection indicator shows "Waiting for Nexus data..." with subtle opacity pulse | AL-NONE-001, AL-CONN-001 |
| AL-NONE-003 | All alerts cleared | Last active alert dismissed or auto-expired, no new anomalies | Toast container fades to empty (last toast exit animation: 200ms). Active alert counter resets to 0. Tab badge fades out (150ms). Graph pulse animations cease — all edges return to static health colors. `aria-live` region: "All alerts cleared" | AL-NONE-001 |

---

## 2. SINGLE ALERT LIFECYCLE

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-SINGLE-001 | Alert received — warning | `_processAlerts()` receives alert with `severity: "warning"`. Dedup key (`dependencyId + severity + message`) not in `_recentAlertKeys` | Toast slides in from top-right (transform: `translateX(100%) -> translateX(0)`, 200ms ease-out). Warning styling: left border 3px solid `--status-cancelled`, icon `\u26A0` in amber. Message text: human-readable from `alert.message` (HTML-escaped). Close button `\u2715` right-aligned. Affected graph edge pulses amber (CSS animation: `nexus-pulse-warn`, 1.5s ease-in-out infinite). `aria-live="polite"` region announces: "Warning: {message}". Auto-dismiss timer starts (8s) | AL-ACK-001, AL-AUTO-001, AL-MULTI-001, AL-NAV-001 |
| AL-SINGLE-002 | Alert received — critical | `_processAlerts()` receives alert with `severity: "critical"`. Dedup key not in `_recentAlertKeys` | Toast slides in from top-right (same animation). Critical styling: left border 3px solid `--status-failed`, icon `\u25CF` in red, background `rgba(229, 69, 59, 0.06)` tint. Affected graph edge pulses red (CSS animation: `nexus-pulse-crit`, 0.8s ease-in-out infinite — faster than warning to convey urgency). `aria-live="assertive"` region announces: "Critical alert: {message}". Auto-dismiss timer starts (8s). If tab inactive: tab badge increments, badge turns red | AL-ACK-001, AL-AUTO-001, AL-MULTI-001, AL-NAV-001 |
| AL-SINGLE-003 | Alert deduplication — suppressed | Alert arrives but `dependencyId + severity + message` key exists in `_recentAlertKeys` (within 10s window) | No new toast created. No visual change. Existing toast for this alert (if still visible) remains unchanged. Console debug log: `[nexus] alert suppressed (dedup): {key}`. Graph pulse continues if edge is already pulsing | — (stays in current state) |
| AL-SINGLE-004 | Alert debounced — backend suppressed | Backend debounce fires (same dependency within 30s cooldown per C03-S06). No alert arrives on wire | No frontend change. This is a non-event from the UI perspective. Backend logs: `[nexus] alert debounced for {dependencyId}`. Frontend never sees this alert | — |
| AL-SINGLE-005 | Alert received — out-of-band | `type: "alert"` message arrives between snapshot ticks (sub-second delivery) | Identical rendering to AL-SINGLE-001 or AL-SINGLE-002 depending on severity. Out-of-band alerts carry additional fields (`metric`, `currentValue`, `baselineValue`, `delta`) — these are stored in `_alertHistory` for detail panel but not shown in toast. Toast renders `message` field only | AL-ACK-001, AL-AUTO-001, AL-MULTI-001, AL-NAV-001 |
| AL-SINGLE-006 | Alert received — snapshot-embedded | `snapshot.alerts[]` contains alert not previously seen via out-of-band path | Dedup check via `_recentAlertKeys`. If key not present: render toast per AL-SINGLE-001/002. If key present (alert already shown from out-of-band delivery): suppress per AL-SINGLE-003. This prevents double-toast for the same anomaly | AL-SINGLE-003 or AL-SINGLE-001/002 |

---

## 3. MULTIPLE CONCURRENT ALERTS (Stacking)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-MULTI-001 | Two alerts active | Second unique alert arrives while first toast still visible | Two toasts stacked vertically in container. Newest toast at bottom (append order). Each toast independently closeable and auto-dismissing. Stack gap: 8px (`--space-2`). Total stack height: max 3 toasts visible. Container uses `flex-direction: column; gap: 8px` | AL-MULTI-002, AL-ACK-001, AL-AUTO-001 |
| AL-MULTI-002 | Three alerts active (max visible) | Third unique alert arrives while two toasts visible | Three toasts stacked. Container at max visual capacity. All three visible with independent timers. Graph may show multiple edges pulsing simultaneously (one per affected dependency). Each pulse animation is independent — different edges can pulse at different rates (warning: 1.5s, critical: 0.8s) | AL-OVER-001, AL-ACK-001, AL-AUTO-001 |
| AL-MULTI-003 | Mixed severity stack | Warning and critical alerts coexist in stack | Toasts render in arrival order (not sorted by severity). Critical toasts have stronger visual weight (red tint, `\u25CF` icon) to naturally draw attention above warnings. No reordering — positional stability aids scanning. Screen reader announces each individually as they arrive | AL-ACK-001, AL-AUTO-001 |
| AL-MULTI-004 | Same dependency — different metrics | `spark-gts` fires latency alert, then error-rate alert within same snapshot | Both toasts appear (different `message` content → different dedup keys). Dependency node gets the worst-severity pulse (critical overrides warning). Detail panel (if open for that node) shows both anomaly indicators | AL-ACK-001, AL-AUTO-001 |
| AL-MULTI-005 | Multiple dependencies alerting | `spark-gts` and `auth` both fire alerts simultaneously | Both toasts appear. Both edges pulse independently. Tab badge: sum of active alerts. Graph becomes a clear triage surface — pulsing edges immediately identify the problem dependencies | AL-ACK-001, AL-OVER-001 |

---

## 4. ACKNOWLEDGMENT / DISMISSAL

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-ACK-001 | User clicks close button | Click `\u2715` on a toast | Toast adds class `exiting` → opacity: 0, transform: `translateX(100%)` over 200ms. After animation: `toast.remove()`. Remaining toasts slide up to fill gap (150ms ease-out via CSS gap collapse). Alert counter decrements. Auto-dismiss timer cancelled for this toast. Graph edge pulse continues (alert acknowledged ≠ anomaly resolved). `aria-live`: "Alert dismissed" | AL-NONE-003 (if last), AL-MULTI-001 (if others remain) |
| AL-ACK-002 | User presses Escape on focused toast | Toast has keyboard focus, user presses Escape | Same behavior as AL-ACK-001. Focus moves to next toast in stack (if any), else to graph canvas | AL-NONE-003, AL-MULTI-001 |
| AL-ACK-003 | Dismiss all (keyboard shortcut) | User presses `Ctrl+Shift+A` while Nexus tab active | All visible toasts dismissed simultaneously with staggered exit animation (50ms delay between each, top to bottom). Counter resets to 0. Graph pulses continue. `aria-live`: "All {N} alerts dismissed". Toast container scrolls to empty | AL-NONE-003 |
| AL-ACK-004 | Acknowledge without dismiss | User clicks toast body (not the close button and not navigating) | Toast remains visible but gains `acknowledged` class: opacity reduces to 0.7, left border dims to 50% opacity. Auto-dismiss timer resets to 4s (halved — user saw it). Acknowledged alerts sort below new unacknowledged alerts in overflow view (AL-OVER-*). This is a soft-ack: "I saw it, not ready to dismiss" | AL-AUTO-001, AL-NAV-001 |

---

## 5. AUTO-DISMISS (Anomaly Resolved)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-AUTO-001 | Timer expires — standard | 8 seconds elapsed since toast appeared, no user interaction | Toast adds class `exiting`. Fade-out animation (opacity 0, translateX 100%, 200ms). Toast removed from DOM. Alert counter decrements. Graph edge pulse continues independently (pulse tracks edge health, not toast visibility) | AL-NONE-003 (if last), AL-MULTI-001 (if others remain) |
| AL-AUTO-002 | Anomaly resolves — edge recovers | Next snapshot shows affected dependency with `health: "healthy"` and no new alert for that `dependencyId` | Edge pulse animation stops (transition to static color, 300ms ease-out). If toast for this dependency is still visible: toast gains class `resolving` — left border transitions to green (`--status-succeeded`), message appends " — resolved". Auto-dismiss timer overrides to 3s (faster exit since anomaly ended). New screen reader announcement: "{dependency} anomaly resolved" | AL-NONE-003, AL-NONE-001 |
| AL-AUTO-003 | Anomaly persists — repeated alert | Same dependency fires another alert after 30s debounce window expires | New toast appears (dedup key expired from `_recentAlertKeys` after 10s). Previous toast may still be visible or already dismissed. If previous toast still visible with same severity: suppress (dedup). If severity escalated (warning → critical): new toast appears with critical styling, old warning toast auto-dismissed immediately | AL-SINGLE-001, AL-SINGLE-002 |
| AL-AUTO-004 | Severity escalation | Warning alert active for `spark-gts`, then critical alert arrives for same dependency | Warning toast dismissed immediately (class `exiting`, 200ms). Critical toast appears. Edge pulse upgrades from amber/1.5s to red/0.8s (seamless CSS transition). Tab badge color upgrades from amber to red. `aria-live="assertive"`: "Alert escalated to critical: {message}" | AL-SINGLE-002, AL-ACK-001 |
| AL-AUTO-005 | Severity de-escalation | Critical alert was active, next snapshot shows `health: "degraded"` (not fully recovered) | Edge pulse slows from critical (0.8s) to warning (1.5s). If critical toast still visible: no change to toast (it will auto-dismiss on timer). No new warning toast generated — de-escalation is silent at toast level, visible only via edge pulse speed change. Avoids alert noise during recovery | — (edge visual updates) |

---

## 6. ALERT NAVIGATION (Click → Graph Highlight)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-NAV-001 | Click alert toast → highlight dependency | User clicks toast message area (not close button) | Affected dependency node and its edge to FLT center get selection highlight: dashed accent ring on node (per C06-S07 selection ring), edge stroke width increases 2px. If node is off-screen (future pan/zoom): viewport pans to center the affected node. Detail panel opens for that dependency showing current metrics (p50, p95, p99, error rate). Toast gains `acknowledged` class per AL-ACK-004. `_selectedNode` set to `alert.dependencyId` | AL-ACK-004, (detail panel states) |
| AL-NAV-002 | Click alert → dependency hidden by internals toggle | Alert is for `filesystem` dependency, but internals toggle is off (default per C06-S11) | Toast click temporarily enables internals visibility for the targeted node only. Filesystem node fades in (150ms) with selection highlight. Tooltip: "Shown due to active alert — normally hidden". When alert is dismissed and node deselected, node fades back out unless user manually enabled internals toggle | AL-NAV-001 |
| AL-NAV-003 | Click alert — detail panel already open for different node | User has `onelake` detail panel open, clicks `spark-gts` alert toast | Detail panel content transitions to `spark-gts` data (150ms crossfade). Previous node deselected, new node selected. Panel header updates to show alert indicator: `\u26A0` or `\u25CF` icon next to dependency name. Anomaly details section shows `metric`, `currentValue`, `baselineValue`, `delta` from the alert payload | (detail panel states) |
| AL-NAV-004 | Click alert — multiple alerts for same dependency | Two alerts exist for `auth` (latency + error rate). User clicks one | Detail panel opens for `auth` node. Both anomaly indicators shown in panel: latency section highlighted amber, error rate section highlighted red. Panel displays a mini-timeline of recent alerts for this dependency (from `_alertHistory`). Graph node selection ring uses worst-severity color (critical red) | (detail panel states) |
| AL-NAV-005 | Keyboard navigate to alert | User presses `A` key (alert focus mode) while Nexus tab active | Focus moves to newest toast in stack. Toast gains focus ring (`--accent-glow`). Arrow Up/Down navigates between stacked toasts. Enter on focused toast → same as click (AL-NAV-001). Escape exits alert focus mode, returns focus to graph canvas | AL-NAV-001, AL-ACK-002 |

---

## 7. STALENESS WARNING

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-STALE-001 | Staleness detected | `Date.now() - Date.parse(snapshot.generatedAt) > 3000` (checked every 1s via `setInterval` during `activate()`) | Stale indicator appears at top-center of graph area: amber dot + "Data may be stale" in `--text-muted` with amber tint. Graph overlay: subtle 10% opacity amber wash over entire graph (CSS: `nexus-stale-overlay`). Edge pulse animations pause (frozen at current frame — no CPU waste on stale data). All metric values in detail panel gain `(stale)` suffix in muted text. `aria-live="polite"`: "Nexus data is stale — no updates for {N} seconds" | AL-STALE-002, AL-STALE-003, AL-CONN-001 |
| AL-STALE-002 | Staleness clears | New snapshot arrives with `generatedAt` within 3s of current time | Stale indicator fades out (150ms). Graph overlay removed. Edge pulse animations resume. Detail panel values lose `(stale)` suffix. `aria-live`: "Data stream resumed". No toast generated — staleness resolution is ambient, not attention-demanding | AL-NONE-001 |
| AL-STALE-003 | Staleness escalates to connection concern | Staleness persists for > 10 seconds (no snapshot for 10s, but SignalR still reports `connected`) | Stale indicator text changes: amber dot + "No data for {N}s — backend may be paused". Dot pulses slowly (2s cycle). If staleness > 30s: text changes to "No data for {N}s — check if FLT is running". Color transitions from amber to red at 30s threshold. This covers the case where SignalR is connected but the aggregator is stopped/crashed | AL-CONN-001, AL-STALE-002 |
| AL-STALE-004 | Staleness during alert | Active anomaly alert + data goes stale | Both indicators coexist. Stale indicator takes priority position (top-center). Alert toasts remain visible below stale indicator. Alert pulse animations freeze (stale takes visual precedence). Toast timestamps show relative age: "45s ago" → updates every second. Visually communicates: "there was a problem, and now we cannot confirm if it is resolved" | AL-STALE-002, AL-CONN-001 |
| AL-STALE-005 | Tab inactive during staleness | User switches away from Nexus tab while data is stale | `setInterval` staleness check cleared on `deactivate()`. Stale state preserved in `_isStale` flag. When tab reactivated: staleness check resumes immediately. If data is still stale: indicator shown instantly (no delay). If fresh snapshot arrived while away: indicator stays hidden | AL-STALE-001, AL-NONE-001 |

---

## 8. CONNECTION STATUS

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-CONN-001 | Connection lost | `signalr-manager.js` fires `onStatusChange('reconnecting')` | Full-width banner at top of Nexus tab area: red background (`rgba(229, 69, 59, 0.08)`), red dot + "Connection lost — reconnecting automatically". Graph dims to 60% opacity (CSS filter: `brightness(0.6)`). All toasts remain visible but gain `stale` class (border dims). Edge pulse animations freeze. Detail panel (if open) shows "Last updated: {time}" with stale marker. Staleness indicator hidden (connection banner takes priority as the root-cause indicator). `aria-live="assertive"`: "Nexus connection lost. Reconnecting." | AL-CONN-002, AL-CONN-005 |
| AL-CONN-002 | Reconnecting — attempt in progress | SignalR automatic reconnect fires (built-in retry policy) | Banner text updates: "Reconnecting... (attempt {N})". Dot animates: slow pulse (2s amber). Graph remains dimmed. Each retry attempt increments counter. Retry timing is controlled by `signalr-manager.js` (existing exponential backoff). Frontend is passive — just displays status | AL-CONN-003, AL-CONN-005 |
| AL-CONN-003 | Connection restored | `onStatusChange('connected')` fires, followed by `_resubscribeAll()` re-subscribing `nexus` topic | Banner transitions: red → green background (`rgba(24, 160, 88, 0.08)`), green dot + "Reconnected". Graph opacity restores to 100% (300ms ease-out). Phase 1 replay delivers full ring buffer — graph state rebuilds from complete snapshot. Stale data flags clear. Banner auto-dismisses after 3 seconds. `aria-live="polite"`: "Nexus connection restored" | AL-CONN-004, AL-NONE-001 |
| AL-CONN-004 | Post-reconnect snapshot arrives | First snapshot received after reconnection | Graph updates with fresh data (full-state replacement — no reconciliation needed per signalr-protocol.md §5.3). Any active alerts from the new snapshot trigger toast rendering per normal flow. If alerts existed before disconnect and same alerts are in new snapshot: dedup suppresses (keys still in `_recentAlertKeys` if within 10s). If > 10s elapsed: new toasts appear. Reconnection banner dismissed if still showing | AL-NONE-001, AL-SINGLE-001 |
| AL-CONN-005 | Connection failed — max retries exhausted | SignalR gives up reconnection (fires `onclose`) | Banner: red background, red dot + "Offline — connection lost". Text below: "EdogLogServer may not be running" + [Retry] button (accent styled). Graph stays dimmed at 60%. All edge pulses frozen. Existing toasts persist (user may still want to read them). [Retry] button click: calls `signalr.start()` manually → transitions to AL-CONN-002. Keyboard: `R` key triggers retry when banner is focused | AL-CONN-002 (manual retry) |
| AL-CONN-006 | Connection lost — tab inactive | SignalR disconnects while user is on a different tab | No visual change on Nexus tab (not rendered). Connection state stored: `_connectionState = 'disconnected'`. When user activates Nexus tab: immediately show appropriate banner (AL-CONN-001 or AL-CONN-005 depending on current reconnect state). Tab badge shows disconnection indicator: grey dot replaces alert count | AL-CONN-001, AL-CONN-005 |
| AL-CONN-007 | Reconnect — sequence gap detected | After reconnection, `sequenceId` gap detected (§5.5 protocol) | Console warning logged: `[nexus] sequence gap: expected {N}, got {M}`. No user-visible indicator — snapshots are full-state replacements, so gaps are self-healing. Next snapshot fully replaces graph. Diagnostic info available in browser devtools only | AL-CONN-004 |

---

## 9. OVERFLOW / ALERT STORM

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-OVER-001 | Fourth alert arrives (overflow) | 4th unique alert while 3 toasts visible (max visible per C06-S13) | Oldest toast (top of stack) immediately removed (`toast.remove()`, no exit animation — instant to make room). New toast appends at bottom with standard entrance animation. Overflow counter appears below toast stack: muted text "+ {N} more alerts" where N is total active alerts minus 3 visible. Counter updates as alerts arrive/dismiss | AL-OVER-002, AL-ACK-001 |
| AL-OVER-002 | Alert storm (10+ in one snapshot) | Snapshot contains 10+ unique alerts (multi-dependency incident) | Only 3 newest toasts visible (per C06-S13: "Cap at 3 visible toasts"). Overflow counter: "+ {N} more" in amber text when > 5, red text when > 10. Graph shows multiple edges pulsing — the visual graph IS the alert summary. Tab badge shows total count (all active, not just visible). `aria-live`: "Alert storm: {N} active anomalies detected" | AL-OVER-003, AL-ACK-003 |
| AL-OVER-003 | Overflow — user expands | User clicks "+ {N} more alerts" counter | Toast container expands: max-height transitions from 3-toast to 8-toast (scrollable if more). Container gains thin scrollbar (4px, `--border-bright` color). Expanded state persists until user clicks collapse or all alerts clear. Counter text changes to "Collapse" link. Container: `max-height: 400px; overflow-y: auto` | AL-OVER-004, AL-ACK-001 |
| AL-OVER-004 | Overflow — user collapses | User clicks "Collapse" or presses Escape while overflow expanded | Container max-height transitions back to 3-toast limit (150ms ease-out). Overflow counter reappears: "+ {N} more". Scroll position resets to bottom (newest visible) | AL-OVER-001 |
| AL-OVER-005 | Storm subsides | Alert count drops from 10+ to < 4 (anomalies resolving) | Overflow counter fades out as toasts auto-dismiss. When <= 3 active toasts: overflow container collapses automatically. Toast stack returns to normal stacking behavior. `aria-live`: "Alert storm clearing — {N} active anomalies" | AL-MULTI-001, AL-NONE-003 |

---

## 10. TAB BADGE (Inactive Tab Alert Count)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-BADGE-001 | Tab inactive — no alerts | User is on a different tab (HTTP, Spark, etc.), no active anomalies | Nexus tab header shows label "Nexus" only. No badge. No visual differentiation from other tabs | AL-BADGE-002 |
| AL-BADGE-002 | Tab inactive — warning alert arrives | Warning alert received while Nexus tab is deactivated (`_active === false`) | Tab header: "Nexus" + amber badge circle with count (e.g., "1"). Badge styling: `border-radius: var(--radius-full)`, `background: rgba(229, 148, 12, 0.08)`, `color: var(--status-cancelled)`, `font: var(--font-mono) var(--text-xs) 600`. Badge pulses once on increment (scale 1.0 → 1.2 → 1.0, 200ms). No toast rendered (tab not active per C06-S13: "Tab deactivated: toasts stop appearing"). Alert stored in `_pendingAlerts` queue | AL-BADGE-003, AL-BADGE-005 |
| AL-BADGE-003 | Tab inactive — critical alert arrives | Critical alert received while Nexus tab is deactivated | Badge turns red: `background: rgba(229, 69, 59, 0.08)`, `color: var(--status-failed)`. Count increments. Badge pulses on increment. Critical severity overrides badge color (even if warning alerts also pending). `_pendingAlerts` queue stores alert for deferred rendering | AL-BADGE-004, AL-BADGE-005 |
| AL-BADGE-004 | Tab inactive — count accumulates | Multiple alerts arrive while tab inactive | Badge count increments with each unique alert (dedup still applies via `_recentAlertKeys`). Count capped at display: "9+" for 10 or more. Badge color: worst active severity (critical red > warning amber). Each increment triggers badge pulse animation | AL-BADGE-005 |
| AL-BADGE-005 | Tab activated — pending alerts flush | User switches to Nexus tab | Badge count fades out (150ms). `_pendingAlerts` queue is processed: each alert runs through `_processAlerts()` → toasts appear (up to max 3 visible). Alerts older than 30s in the queue are discarded (stale). Recent alerts render as normal toasts with adjusted auto-dismiss timers (remaining time = 8s minus age, minimum 2s). `aria-live`: "{N} alerts while you were away" | AL-SINGLE-001, AL-MULTI-001, AL-NONE-001 |
| AL-BADGE-006 | Tab inactive — connection lost | SignalR disconnects while on different tab | Badge changes to grey dot (no count number): `background: var(--status-pending)`. Tooltip on tab: "Nexus — disconnected". When tab activated: connection banner shown per AL-CONN-001/005 | AL-CONN-006 |
| AL-BADGE-007 | Tab inactive — alerts resolve | All pending alerts auto-resolve (health returns to healthy in subsequent snapshots) | Badge count decrements as anomalies clear. If all clear: badge fades out entirely. `_pendingAlerts` queue entries marked as resolved — when tab activates, resolved alerts show brief "resolved" toasts (3s auto-dismiss) or are silently discarded if > 30s old | AL-BADGE-001 |

---

## 11. URGENCY TIERS — Visual Differentiation

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-TIER-001 | Warning tier — latency spike | `severity: "warning"`, `metric: "p95Ms"`, `delta >= 3.0` | Toast: amber left border, `\u26A0` icon, standard auto-dismiss (8s). Edge: amber pulse (1.5s cycle, `ease-in-out`). Node: no additional decoration (edge carries signal). Detail panel metric row: amber background tint. No sound. No browser notification. Designed for "investigate when convenient" urgency | — |
| AL-TIER-002 | Warning tier — error rate increase | `severity: "warning"`, `metric: "errorRate"`, `currentValue - baselineValue >= 0.10` | Same visual treatment as AL-TIER-001. Message text differs: "Error rate increased to {X}% (baseline {Y}%)". Edge color: amber (same as latency warning — warning is warning regardless of metric) | — |
| AL-TIER-003 | Critical tier — latency critical | `severity: "critical"`, `metric: "p95Ms"`, `delta >= 5.0` | Toast: red left border, `\u25CF` red dot icon, red background tint (`rgba(229, 69, 59, 0.06)`). Auto-dismiss: 8s (same timer — critical alerts are not sticky by default). Edge: red pulse (0.8s cycle — noticeably faster than warning). Node: gains red ring glow (`box-shadow: 0 0 8px rgba(229, 69, 59, 0.4)`). Detail panel metric row: red background tint. `aria-live="assertive"` (interrupts screen reader). Designed for "look at this now" urgency | — |
| AL-TIER-004 | Critical tier — error rate critical | `severity: "critical"`, `metric: "errorRate"`, `currentValue >= 0.50` | Same visual treatment as AL-TIER-003. Message: "Error rate {X}% — majority of requests failing". This is the highest urgency: > 50% of requests failing indicates a major outage. Edge and node: red pulse + glow | — |
| AL-TIER-005 | Mixed tiers — worst wins for node | Single dependency has both warning (latency) and critical (error rate) | Node uses critical styling (red glow). Edge uses critical pulse (0.8s red). Both toasts visible in stack (different messages). Detail panel shows both anomalies with their respective tier colors. Badge uses critical color. Worst severity always wins for aggregate visual indicators | — |
| AL-TIER-006 | No sound — V1 design decision | Any alert | V1 does not implement audio notifications. All urgency is conveyed visually + screen reader. Future V2 consideration: optional audio ping for critical alerts, controlled by user preference toggle. No browser Notification API usage in V1 — EDOG Studio is a localhost tool, always in focus during triage | — |

---

## 12. ALERT SUBSYSTEM ERRORS

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-ERR-001 | Malformed alert payload | `_processAlerts()` receives alert missing required fields (`severity`, `dependencyId`, or `message`) | Alert silently dropped. Console error: `[nexus] malformed alert: missing {field}`. No toast rendered. No crash — `try/catch` wraps `_processAlerts()`. Graph continues rendering from snapshot data. Counter not incremented. Defensive: never trust wire data to be well-formed | — (stays in current state) |
| AL-ERR-002 | Unknown severity value | Alert has `severity` not in `["warning", "critical"]` | Default to warning styling (amber). Console warn: `[nexus] unknown severity: {value}, defaulting to warning`. Toast renders with warning appearance. Forward-compatible: new severity levels from future backend versions degrade gracefully | AL-SINGLE-001 |
| AL-ERR-003 | Toast container missing | `_els.toastContainer` is null (DOM not ready or destroyed) | `_showToast()` returns early. Console error: `[nexus] toast container not found`. Alerts still processed for `_alertHistory` and tab badge. Graph edge pulses still activate. Toast rendering is non-critical — failure isolated to notification UI only | — |
| AL-ERR-004 | Staleness timer error | `setInterval` callback throws (e.g., `_snapshot` in unexpected state) | `try/catch` in `_checkStaleness()` logs error and continues. Timer remains active. Next tick retries. One failed check does not disable staleness monitoring. Console: `[nexus] staleness check error: {msg}` | — |
| AL-ERR-005 | Alert history overflow | `_alertHistory` array exceeds 200 entries | Oldest entries trimmed: `_alertHistory = _alertHistory.slice(-100)` (keep newest 100). No user-visible effect — history is for detail panel only. Console debug: `[nexus] alert history trimmed to 100 entries` | — |
| AL-ERR-006 | Rapid reconnect alert flood | Connection restores and ring buffer replay contains many old alerts | All replayed alerts run through dedup filter (`_recentAlertKeys`). Alerts older than 30s since `generatedAt` are silently discarded (stale alerts from before disconnect). Only fresh, non-duplicate alerts render as toasts. Prevents post-reconnect alert storm from overwhelming the UI | AL-SINGLE-001, AL-NONE-001 |

---

## 13. KEYBOARD ACCESSIBILITY

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| AL-A11Y-001 | Alert focus mode | Press `A` while Nexus tab active and no text input focused | Focus ring (`--accent-glow`) appears on newest toast. Screen reader: "Alert navigation mode. {N} active alerts. Use arrows to navigate, Enter to inspect, Escape to exit." Toast gains `tabindex="0"` dynamically. Focus trap: Tab key cycles within alert stack only | AL-A11Y-002, AL-NAV-001, AL-ACK-002 |
| AL-A11Y-002 | Navigate alerts with arrows | Arrow Up/Down while in alert focus mode | Focus ring moves between toasts. Screen reader reads each toast content on focus. Arrow Up: older toast. Arrow Down: newer toast. Wrap around at stack boundaries. If overflow expanded: arrows scroll through all alerts. Focus indicator: 2px solid `--accent` outline | AL-NAV-001, AL-ACK-002 |
| AL-A11Y-003 | Dismiss focused alert | Press Delete or Backspace while toast focused | Same as AL-ACK-001 (close button click). Focus moves to next toast (or exits alert mode if last). Screen reader: "Alert dismissed. {N} remaining." | AL-ACK-001, AL-NONE-003 |
| AL-A11Y-004 | Inspect focused alert | Press Enter while toast focused | Same as AL-NAV-001 (click alert body). Graph highlights affected dependency. Detail panel opens. Focus moves to detail panel. Alert mode exits | AL-NAV-001 |
| AL-A11Y-005 | Exit alert focus mode | Press Escape while in alert focus mode (no toast focused for dismiss) | Focus returns to graph canvas (previously focused node, or first node). Alert mode flag cleared. Toasts remain visible but lose focus indicators. Screen reader: "Exited alert navigation" | AL-NONE-001 |
| AL-A11Y-006 | Screen reader — alert announced | New alert arrives (any state) | `aria-live` region updated. Warning: `polite` priority. Critical: `assertive` priority. Announcement text: "{severity}: {message}" — e.g., "Critical: Error rate 40% — token acquisition failures". Resolving alerts: "Resolved: {dependency} anomaly cleared" | — |
| AL-A11Y-007 | Screen reader — staleness announced | Staleness indicator appears or disappears | `aria-live="polite"`: "Warning: Nexus data stale — no updates for {N} seconds" on appear. "Nexus data stream resumed" on clear. No repeated announcements — only on state change | — |
| AL-A11Y-008 | Screen reader — connection announced | Connection status changes | `aria-live="assertive"`: "Nexus connection lost. Reconnecting." on disconnect. `aria-live="polite"`: "Nexus connection restored" on reconnect. "Nexus offline — press R to retry" on max retries exhausted | — |

---

## 14. COMPLETE TRANSITION MATRIX

Every `(current_state, event)` pair resolved. Unlisted combinations are no-ops.

### 14.1 Alert Lifecycle Transitions

```
                          ┌─────────────────────────────────────────────────────────┐
                          │                   AL-NONE-001                           │
                          │              (No active alerts)                         │
                          └──────────┬──────────┬──────────┬───────────────────────┘
                                     │          │          │
                        warning_alert│ crit_alert│  stale   │ conn_lost
                                     │          │          │
                          ┌──────────▼─┐  ┌─────▼────┐  ┌─▼────────────┐
                          │ AL-SINGLE  │  │ AL-SINGLE │  │ AL-STALE-001 │
                          │    -001    │  │    -002   │  │              │
                          │ (warning)  │  │ (critical)│  │(stale active)│
                          └──┬──┬──┬───┘  └──┬──┬──┬──┘  └──────┬───────┘
                             │  │  │         │  │  │             │
              ┌──────────────┘  │  └──┐      │  │  │    fresh_snapshot
              │ack    2nd_alert │  nav │      │  │  │             │
              │                 │     │      │  │  │     ┌───────▼──────┐
     ┌────────▼───┐    ┌───────▼──┐  │      │  │  │     │ AL-STALE-002 │
     │ AL-ACK-001 │    │AL-MULTI  │  │      │  │  │     │  (cleared)   │
     │ (dismissed)│    │  -001    │  │      │  │  │     └──────────────┘
     └────────────┘    │ (2 toasts│  │      │  │  │
                       └──────┬───┘  │      │  │  │
                              │      │      │  │  │
                      3rd_alert      │      │  │  │
                              │      │      │  │  │
                       ┌──────▼───┐  │      │  │  │
                       │AL-MULTI  │  │      │  │  │
                       │  -002    │  │      │  │  │
                       │(3 toasts)│  │      │  │  │
                       └──────┬───┘  │      │  │  │
                              │      │      │  │  │
                       4th_alert     │      │  │  │
                              │      │      │  │  │
                       ┌──────▼────┐ │      │  │  │
                       │AL-OVER-001│ │      │  │  │
                       │(overflow) │ │      │  │  │
                       └───────────┘ │      │  │  │
                                     │      │  │  │
                          ┌──────────▼──┐   │  │  │
                          │ AL-NAV-001  │   │  │  │
                          │(highlighting│   │  │  │
                          │  dep node)  │   │  │  │
                          └─────────────┘   │  │  │
                                            │  │  │
                                  ┌─────────┘  │  └─────────────┐
                                  │ack         │timer           │nav
                                  │            │                │
                         ┌────────▼───┐ ┌──────▼──────┐ ┌──────▼──────┐
                         │ AL-ACK-001 │ │ AL-AUTO-001 │ │ AL-NAV-001  │
                         └────────────┘ │(timer expire)│ │(highlight)  │
                                        └──────┬──────┘ └─────────────┘
                                               │
                                        all_cleared
                                               │
                                        ┌──────▼──────┐
                                        │ AL-NONE-003 │
                                        │(all cleared) │
                                        └──────┬──────┘
                                               │
                                               ▼
                                        AL-NONE-001
```

### 14.2 Connection State Transitions

```
  AL-NONE-001 ──conn_lost──▶ AL-CONN-001 ──auto_retry──▶ AL-CONN-002
       ▲                                                       │
       │                                              success/│\fail
       │                                                     │  │
       │                                    ┌───────────────▼┐ │
       │                                    │  AL-CONN-003   │ │
       │                                    │  (restored)    │ │
       │                                    └───────┬────────┘ │
       │                                            │          │
       │                               snapshot     │          │
       │                                            │          │
       │                                    ┌───────▼────────┐ │
       │◀───────────────────────────────────│  AL-CONN-004   │ │
       │                                    │(post-reconnect)│ │
                                            └────────────────┘ │
                                                               │
                                                       ┌───────▼────────┐
                                                       │  AL-CONN-005   │
                                                       │  (offline)     │
                                              retry──▶ │  [Retry] btn   │
                                              (manual) └────────────────┘
                                                  └──────▶ AL-CONN-002
```

### 14.3 Staleness State Transitions

```
  AL-NONE-001 ──no_snapshot_3s──▶ AL-STALE-001 ──10s──▶ AL-STALE-003
       ▲                               │                     │
       │                     fresh_snap │            conn_lost│
       │                               │                     │
       │                        ┌──────▼──────┐      ┌───────▼──────┐
       │◀───────────────────────│ AL-STALE-002│      │ AL-CONN-001  │
                                │  (cleared)  │      └──────────────┘
                                └─────────────┘
```

### 14.4 Event × State Matrix (Key Combinations)

| Current State \ Event | `warning_alert` | `critical_alert` | `ack_click` | `auto_expire` | `conn_lost` | `conn_restored` | `stale_3s` | `fresh_snap` | `tab_deactivate` | `tab_activate` | `key_A` | `key_Esc` | `key_CtrlShiftA` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **AL-NONE-001** | AL-SINGLE-001 | AL-SINGLE-002 | — | — | AL-CONN-001 | — | AL-STALE-001 | — | AL-BADGE-001 | — | — | — | — |
| **AL-SINGLE-001** | AL-SINGLE-003 (dedup) or AL-MULTI-001 | AL-AUTO-004 (escalate) or AL-MULTI-001 | AL-ACK-001 | AL-AUTO-001 | AL-CONN-001 | — | AL-STALE-004 | — | AL-BADGE-002 | — | AL-A11Y-001 | — | AL-ACK-003 |
| **AL-SINGLE-002** | AL-MULTI-001 | AL-SINGLE-003 (dedup) or AL-MULTI-001 | AL-ACK-001 | AL-AUTO-001 | AL-CONN-001 | — | AL-STALE-004 | — | AL-BADGE-003 | — | AL-A11Y-001 | — | AL-ACK-003 |
| **AL-MULTI-002** | AL-OVER-001 | AL-OVER-001 | AL-ACK-001 | AL-AUTO-001 | AL-CONN-001 | — | AL-STALE-004 | — | AL-BADGE-004 | — | AL-A11Y-001 | — | AL-ACK-003 |
| **AL-OVER-001** | AL-OVER-001 (count++) | AL-OVER-001 (count++) | AL-ACK-001 | AL-OVER-005 | AL-CONN-001 | — | AL-STALE-004 | — | AL-BADGE-004 | — | AL-A11Y-001 | — | AL-ACK-003 |
| **AL-STALE-001** | AL-STALE-004 | AL-STALE-004 | — | — | AL-CONN-001 | — | — | AL-STALE-002 | AL-STALE-005 | AL-STALE-001 | — | — | — |
| **AL-CONN-001** | — (queued) | — (queued) | — | — | — | AL-CONN-003 | — | — | AL-CONN-006 | AL-CONN-001 | — | — | — |
| **AL-CONN-005** | — (offline) | — (offline) | — | — | — | AL-CONN-003 | — | — | AL-CONN-006 | AL-CONN-005 | — | — | — |
| **AL-BADGE-001** | AL-BADGE-002 | AL-BADGE-003 | — | — | AL-BADGE-006 | — | — | — | — | AL-NONE-001 | — | — | — |
| **AL-BADGE-004** | AL-BADGE-004 (count++) | AL-BADGE-004 (count++) | — | AL-BADGE-007 | AL-BADGE-006 | — | — | — | — | AL-BADGE-005 | — | — | — |
| **AL-A11Y-001** | AL-SINGLE-001 (+ announce) | AL-SINGLE-002 (+ announce) | — | — | AL-CONN-001 | — | — | — | — | — | — | AL-A11Y-005 | AL-ACK-003 |

---

## 15. CSS SPECIFICATION

### 15.1 Toast Styles

```css
.nexus-toast-container {
  position: absolute;
  top: var(--space-3);            /* 12px */
  right: var(--space-3);
  z-index: var(--z-toast);        /* 400 */
  display: flex;
  flex-direction: column;
  gap: var(--space-2);            /* 8px */
  max-width: 380px;
  pointer-events: none;           /* pass clicks to graph below */
}

.nexus-toast {
  pointer-events: auto;           /* re-enable on toast itself */
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text);
  transform: translateX(0);
  opacity: 1;
  transition: transform 200ms ease-out, opacity 200ms ease-out;
  cursor: pointer;
}

.nexus-toast.severity-warning {
  border-left: 3px solid var(--status-cancelled);
}
.nexus-toast.severity-warning .nexus-toast-icon {
  color: var(--status-cancelled);
}

.nexus-toast.severity-critical {
  border-left: 3px solid var(--status-failed);
  background: rgba(229, 69, 59, 0.06);
}
.nexus-toast.severity-critical .nexus-toast-icon {
  color: var(--status-failed);
}

.nexus-toast.acknowledged {
  opacity: 0.7;
}

.nexus-toast.resolving {
  border-left-color: var(--status-succeeded);
}

.nexus-toast.exiting {
  opacity: 0;
  transform: translateX(100%);
  pointer-events: none;
}

.nexus-toast-icon {
  flex-shrink: 0;
  font-size: var(--text-base);
  line-height: 1;
}

.nexus-toast-msg {
  flex: 1;
  line-height: 1.4;
  word-break: break-word;
}

.nexus-toast-close {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 var(--space-1);
  font-size: var(--text-sm);
  transition: color var(--transition-fast);
}
.nexus-toast-close:hover {
  color: var(--text);
}

.nexus-toast-overflow {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-align: right;
  padding-right: var(--space-3);
  cursor: pointer;
}
.nexus-toast-overflow:hover {
  color: var(--accent);
  text-decoration: underline;
}
```

### 15.2 Staleness Indicator

```css
.nexus-stale-indicator {
  position: absolute;
  top: var(--space-2);
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-toolbar);      /* 90 — below toasts */
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  background: rgba(229, 148, 12, 0.08);
  border: 1px solid rgba(229, 148, 12, 0.2);
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--status-cancelled);
  opacity: 0;
  transition: opacity var(--transition-normal);
}
.nexus-stale-indicator.visible {
  opacity: 1;
}

.nexus-stale-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--status-cancelled);
}
.nexus-stale-indicator.escalated {
  color: var(--status-failed);
  background: rgba(229, 69, 59, 0.08);
  border-color: rgba(229, 69, 59, 0.2);
}
.nexus-stale-indicator.escalated .nexus-stale-dot {
  background: var(--status-failed);
  animation: nexus-slow-pulse 2s ease-in-out infinite;
}
```

### 15.3 Connection Banner

```css
.nexus-conn-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--z-toolbar);      /* 90 */
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  opacity: 0;
  transition: opacity var(--transition-normal);
}
.nexus-conn-banner.visible {
  opacity: 1;
}

.nexus-conn-banner.lost {
  background: rgba(229, 69, 59, 0.08);
  color: var(--status-failed);
}
.nexus-conn-banner.reconnecting {
  background: rgba(229, 148, 12, 0.08);
  color: var(--status-cancelled);
}
.nexus-conn-banner.restored {
  background: rgba(24, 160, 88, 0.08);
  color: var(--status-succeeded);
}

.nexus-conn-banner .nexus-conn-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
}
.nexus-conn-banner.lost .nexus-conn-dot {
  background: var(--status-failed);
}
.nexus-conn-banner.reconnecting .nexus-conn-dot {
  background: var(--status-cancelled);
  animation: nexus-slow-pulse 2s ease-in-out infinite;
}
.nexus-conn-banner.restored .nexus-conn-dot {
  background: var(--status-succeeded);
}

.nexus-conn-retry-btn {
  margin-left: auto;
  background: none;
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text);
  cursor: pointer;
  transition: background var(--transition-fast);
}
.nexus-conn-retry-btn:hover {
  background: var(--surface-2);
}
```

### 15.4 Tab Badge

```css
.nexus-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  margin-left: var(--space-1);
  transition: background var(--transition-fast), color var(--transition-fast),
              transform 200ms ease-out;
}
.nexus-tab-badge.warning {
  background: rgba(229, 148, 12, 0.08);
  color: var(--status-cancelled);
}
.nexus-tab-badge.critical {
  background: rgba(229, 69, 59, 0.08);
  color: var(--status-failed);
}
.nexus-tab-badge.disconnected {
  background: rgba(142, 149, 165, 0.08);
  color: var(--status-pending);
}
.nexus-tab-badge.pulse {
  animation: nexus-badge-pulse 200ms ease-out;
}

@keyframes nexus-badge-pulse {
  0%   { transform: scale(1.0); }
  50%  { transform: scale(1.2); }
  100% { transform: scale(1.0); }
}
```

### 15.5 Pulse Animations (Edge Anomaly)

```css
@keyframes nexus-pulse-warn {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}

@keyframes nexus-pulse-crit {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.3; }
}

@keyframes nexus-slow-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.5; }
}
```

---

## 16. DATA REQUIREMENTS SUMMARY

| State Group | Required Data | Source |
|---|---|---|
| Alert toast rendering | `severity`, `dependencyId`, `message`, `timestamp` | `snapshot.alerts[]` or out-of-band `type: "alert"` |
| Alert navigation | `dependencyId`, `metric`, `currentValue`, `baselineValue`, `delta` | Out-of-band alert payload |
| Deduplication | `dependencyId + severity + message` composite key | Computed from alert fields |
| Staleness check | `snapshot.generatedAt` compared to `Date.now()` | Most recent snapshot |
| Connection status | `signalr.status` (`connected`, `reconnecting`, `disconnected`) | `signalr-manager.js` `onStatusChange` |
| Tab badge | Active alert count, worst severity, connection state | Internal `_pendingAlerts` queue + `_connectionState` |
| Alert history | Array of recent alerts (max 200) | Internal `_alertHistory` accumulator |
| Edge pulse | `edge.health` per dependency | `snapshot.edges[]` |

---

## 17. KEYBOARD SHORTCUT SUMMARY

| Shortcut | Context | Action | State Reference |
|---|---|---|---|
| `A` | Nexus tab active, no text input focused | Enter alert focus mode | AL-A11Y-001 |
| `Escape` | Alert focus mode | Exit alert focus mode | AL-A11Y-005 |
| `Escape` | Toast focused | Dismiss focused toast | AL-ACK-002 |
| `Enter` | Toast focused in alert mode | Navigate to affected dependency | AL-A11Y-004 |
| `Arrow Up/Down` | Alert focus mode | Navigate between toasts | AL-A11Y-002 |
| `Delete` / `Backspace` | Toast focused | Dismiss focused toast | AL-A11Y-003 |
| `Ctrl+Shift+A` | Nexus tab active | Dismiss all alerts | AL-ACK-003 |
| `R` | Connection failed banner focused | Retry connection | AL-CONN-005 |

---

## 18. ERROR RECOVERY SUMMARY

| Failure | Detection | Recovery | User Impact |
|---|---|---|---|
| Malformed alert payload | Missing required fields in `_processAlerts()` | Silent drop + console error | None — alert not shown |
| Unknown severity | `severity` not in known set | Default to warning styling | Minor — wrong color possible |
| Toast container missing | `_els.toastContainer === null` | Skip toast, continue processing | No toasts — alerts tracked internally |
| Staleness timer throws | Exception in `_checkStaleness()` | Catch + retry on next tick | Brief gap in staleness monitoring |
| Alert history overflow | `_alertHistory.length > 200` | Trim to newest 100 | Oldest alert details lost from panel |
| Post-reconnect alert flood | Many old alerts in ring buffer replay | Discard alerts > 30s old, dedup rest | Prevents UI overwhelm |
| Double subscribe | `activate()` called twice | Guard via `_active` flag | No duplicate toasts |
| DOM removed during animation | Toast `parentNode` null when auto-dismiss fires | Guard: `if (toast.parentNode)` before remove | No crash |
