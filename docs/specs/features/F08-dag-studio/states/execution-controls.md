# F08 · Execution Controls — State Matrix

> **Feature:** F08 — DAG Studio
> **Component:** Execution Controls (toolbar: Run, Cancel, Refresh, Lock, Settings, Definitions)
> **Status:** DRAFT
> **Author:** Sana Reeves (Architecture)
> **Last updated:** 2025-07-17
> **Total states:** 75
> **Design system:** Light theme · No emoji · Unicode symbols only (●, ▸, ◆, ✕, ⋯)

---

## How to Read This Document

Each state has a **prefixed ID** that encodes its category and sequence:

| Prefix | Category | Count |
|--------|----------|-------|
| `EC-IDLE-` | Idle / ready states | 6 |
| `EC-RUN-` | Run DAG lifecycle | 9 |
| `EC-EXEC-` | Active execution monitoring | 6 |
| `EC-CNCL-` | Cancel lifecycle | 7 |
| `EC-REF-` | Refresh DAG | 8 |
| `EC-LOCK-` | Lock detection + force unlock | 11 |
| `EC-SET-` | Settings panel | 10 |
| `EC-DEF-` | MLV Definitions dropdown | 11 |
| `EC-KBD-` | Keyboard shortcuts | 7 |

**Column definitions:**

| Column | Meaning |
|--------|---------|
| **ID** | Unique state identifier (`EC-{CATEGORY}-{NNN}`) |
| **State** | Human-readable state name |
| **Trigger** | Event or user action that enters this state |
| **What User Sees** | Visual description referencing design tokens (`--token`) |
| **Next States** | Valid transitions out of this state |

**Key conventions:**

- All colours reference CSS custom properties: `var(--status-succeeded)`, `var(--accent)`, etc.
- Timer format: `0:00` → `1:23` → `12:07` (seconds precision, no leading zero on minutes)
- Cancel API: `DELETE /liveTableSchedule/cancelDAG/{iterationId}` (not GET)
- SignalR events: `NodeStarted`, `NodeCompleted`, `NodeFailed`, `DagTerminal`
- `DagTerminal` is the **authoritative** execution completion signal
- Optimistic UI on Run: immediate visual update, revert via `_previousState` on error
- Escape cascade order: Force Unlock modal → Cancel popover → Settings panel → Definition dropdown → Node selection

---

## 1. Idle / Ready States (`EC-IDLE-*`)

These states represent the toolbar at rest — before, between, or after executions.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-IDLE-010 | Initial Load | Page mount after DAG selected from definitions dropdown | Run ▸ button enabled with `var(--accent)` background. Cancel ✕ disabled at `var(--color-text-tertiary)`. Refresh ↻ enabled. Timer hidden. Status area empty. Toolbar background `var(--color-bg-secondary)`. | EC-RUN-010, EC-REF-010, EC-SET-010, EC-DEF-020, EC-LOCK-010 |
| EC-IDLE-020 | Post-Completion | `DagTerminal` SignalR event received with `status=Succeeded` | Run ▸ re-enabled with `var(--accent)`. Cancel ✕ disabled. Timer frozen at final elapsed value. Status badge shows "Completed" with `var(--status-succeeded)` background and white text. All node icons on canvas show final succeeded state. | EC-RUN-010, EC-REF-010, EC-SET-010, EC-DEF-020 |
| EC-IDLE-030 | Post-Failure | `DagTerminal` SignalR event received with `status=Failed` | Run ▸ re-enabled. Cancel ✕ disabled. Timer frozen. Status badge "Failed" with `var(--status-failed)` background. Secondary text shows "{n} node(s) failed" in `var(--color-text-secondary)`. Failed nodes highlighted on canvas with `var(--status-failed)` ring. | EC-RUN-010, EC-REF-010, EC-SET-010, EC-DEF-020 |
| EC-IDLE-040 | Post-Cancel | Cancel API confirmed + `DagTerminal` event with `status=Cancelled` | Run ▸ re-enabled. Cancel ✕ disabled. Timer frozen. Status badge "Cancelled" with `var(--status-cancelled)` background. Nodes show mixed states: completed nodes keep ✓, cancelled nodes show ◆ in `var(--status-cancelled)`. | EC-RUN-010, EC-REF-010, EC-SET-010, EC-DEF-020 |
| EC-IDLE-050 | Loading DAG | DAG selection changed in definitions dropdown (EC-DEF-030) | All toolbar buttons disabled at `var(--color-text-tertiary)`. Skeleton pulse animation on toolbar controls (1500ms ease-in-out, opacity 0.4→1.0). Spinner in status area. Canvas shows skeleton node placeholders. | EC-IDLE-010, EC-IDLE-060 |
| EC-IDLE-060 | Load Failed | `GET /dagTopology` returns 4xx/5xx or network error | Error banner below toolbar with `var(--status-failed)` left border (3px). Banner text "Failed to load DAG topology" in `var(--color-text)`. "Retry" link in `var(--accent)`. All buttons disabled except Refresh ↻. Canvas empty with error illustration. | EC-IDLE-050, EC-REF-010 |

---

## 2. Run DAG Lifecycle (`EC-RUN-*`)

Covers the moment the user clicks Run through API resolution. Uses **optimistic UI** — the toolbar updates immediately, reverting to `_previousState` on any error.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-RUN-010 | Run Clicked | User clicks Run ▸ button or presses `Ctrl+Shift+R` | **Optimistic update:** Run ▸ text replaced with 16px spinner (animated rotate 360° / 800ms linear infinite) in `var(--accent)`. Cancel ✕ pre-emptively enabled with `var(--status-failed)` colour. Timer appears and starts counting from `0:00`. Internal: save `_previousState`, fire `POST /liveTableSchedule/runDAG`. | EC-RUN-020, EC-RUN-030, EC-RUN-040, EC-RUN-050, EC-RUN-060, EC-RUN-070, EC-RUN-080 |
| EC-RUN-020 | API Success | `POST /liveTableSchedule/runDAG` returns `200 OK` with `iterationId` | Spinner replaced with "Running" badge in `var(--accent)` background. Timer continues counting. Cancel ✕ fully active. `iterationId` stored for cancel operations. Canvas nodes transition to "pending" state with `var(--status-pending)` fill. | EC-EXEC-010, EC-EXEC-040 |
| EC-RUN-030 | Auth Error (401/403) | API returns `401 Unauthorized` or `403 Forbidden` | **Revert** to `_previousState`. Toast notification slides in from top-right: "Authentication failed — please sign in again" with `var(--status-failed)` left border. Run ▸ re-enabled. Timer removed. Cancel ✕ disabled. Toast auto-dismisses after 6s. | EC-IDLE-010, EC-IDLE-020, EC-IDLE-030, EC-IDLE-040 |
| EC-RUN-040 | Not Found (404) | API returns `404 Not Found` | **Revert** to `_previousState`. Toast: "DAG not found — topology may have changed" with `var(--status-failed)` left border. "Refresh topology" action link in `var(--accent)` within toast body. Run ▸ re-enabled. | EC-IDLE-010, EC-REF-010 |
| EC-RUN-050 | Conflict (409) | API returns `409 Conflict` (DAG already running or locked) | **Revert** to `_previousState`. Toast: "DAG is already running or locked by another user" with `var(--status-cancelled)` left border. If lock info returned in response body, "Force Unlock" action link in toast. Run ▸ re-enabled. | EC-IDLE-010, EC-LOCK-010, EC-LOCK-020 |
| EC-RUN-060 | Rate Limited (429) | API returns `429 Too Many Requests` with `Retry-After` header | **Revert** to `_previousState`. Toast: "Too many requests — try again in {retryAfter}s" with `var(--status-cancelled)` left border. Run ▸ **disabled** for `retryAfter` seconds with countdown shown in tooltip. Auto-enable after countdown. | EC-IDLE-010 |
| EC-RUN-070 | Server Error (500) | API returns `500`, `502`, `503`, or other 5xx | **Revert** to `_previousState`. Toast: "Server error — please try again" with `var(--status-failed)` left border. Run ▸ re-enabled immediately. No auto-retry (user must explicitly click). | EC-IDLE-010, EC-IDLE-020, EC-IDLE-030, EC-IDLE-040 |
| EC-RUN-080 | Network Error | `fetch()` promise rejects (no HTTP response received) | **Revert** to `_previousState`. Toast: "Network error — check your connection" with `var(--status-failed)` left border. If `navigator.onLine === false`, additional offline indicator icon (◆) in toolbar right edge with `var(--status-cancelled)`. | EC-IDLE-010 |
| EC-RUN-090 | Debounce Guard | Run ▸ clicked within 2s of a prior Run click | No visual change. Click silently absorbed — no API call, no spinner, no toast. Internal debounce flag resets after 2s. Prevents accidental double-submits. | _(remains in current state)_ |

---

## 3. Active Execution Monitoring (`EC-EXEC-*`)

Driven by **SignalR events** — the toolbar reflects real-time execution progress. `DagTerminal` is the single authoritative completion signal.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-EXEC-010 | Running | First `NodeStarted` SignalR event received | Toolbar badge: "Running" with `var(--accent)` background, white text. Timer counting in `var(--color-text)` (format `0:00` → `1:23` → `12:07`). Cancel ✕ enabled in `var(--status-failed)`. Active node highlighted on canvas with animated pulse ring in `var(--accent)`. Progress fraction hidden until first `NodeCompleted`. | EC-EXEC-020, EC-EXEC-030, EC-EXEC-050, EC-CNCL-010 |
| EC-EXEC-020 | Completed | `DagTerminal` SignalR event with `status=Succeeded` | Badge transitions (300ms ease-in-out) to "Completed" with `var(--status-succeeded)` background. Timer freezes at final value. Cancel ✕ disabled. All canvas nodes show succeeded state (✓ icon, `var(--status-succeeded)` fill). Brief 600ms scale-pulse animation (1.0→1.05→1.0) on badge. | EC-IDLE-020 |
| EC-EXEC-030 | Failed | `DagTerminal` SignalR event with `status=Failed` | Badge transitions to "Failed" with `var(--status-failed)` background. Timer freezes. Cancel ✕ disabled. Failed nodes on canvas show ✕ icon with `var(--status-failed)` ring. Error summary line below badge: "{n} of {total} nodes failed" in `var(--color-text-secondary)`. | EC-IDLE-030 |
| EC-EXEC-040 | Not Started | No `NodeStarted` event received within 15s of EC-RUN-020 | Badge shows "Waiting…" in `var(--status-pending)` background with subtle spinner. Timer counting (execution time includes queue wait). Tooltip on badge: "Execution queued — waiting for scheduler". Cancel ✕ enabled (pre-emptive cancel allowed). | EC-EXEC-010, EC-EXEC-060, EC-CNCL-010 |
| EC-EXEC-050 | Progress Update | `NodeCompleted` SignalR event received during execution | Progress fraction appears next to timer: "{completed}/{total} nodes" in `var(--color-text-secondary)`. Completed node on canvas transitions to ✓ with `var(--status-succeeded)`. Currently running node continues pulse. No badge change. Fraction updates on each `NodeCompleted`. | EC-EXEC-010, EC-EXEC-020, EC-EXEC-030, EC-CNCL-010 |
| EC-EXEC-060 | Stalled | No SignalR event (`NodeStarted`, `NodeCompleted`, `NodeFailed`) received for 60s during active execution | Badge changes to "Stalled?" with `var(--status-cancelled)` background. Tooltip: "No updates received for 60s — execution may be stalled". Timer continues counting. Subtle warning icon (◆) next to badge. Refresh and Cancel both suggested via tooltip. | EC-EXEC-010, EC-REF-070, EC-CNCL-010 |

---

## 4. Cancel Lifecycle (`EC-CNCL-*`)

Cancel uses a **confirmation popover** (not modal) so the user can still observe the DAG canvas. The API is `DELETE /liveTableSchedule/cancelDAG/{iterationId}`.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-CNCL-010 | Popover Shown | User clicks Cancel ✕ button or presses `Ctrl+Shift+C` | **280px popover** anchored below Cancel button. Arrow points to button. Heading: "Cancel this execution?" in `var(--color-text)`. Body text: "Running nodes will be interrupted. Completed nodes are unaffected." in `var(--color-text-secondary)`. Two buttons: "Cancel Execution" (destructive, `var(--status-failed)` bg, white text) and "Keep Running" (secondary, `var(--color-bg-tertiary)` bg). Popover backdrop is transparent — DAG canvas remains interactive. Popover border: `var(--color-border)` with 8px border-radius and `box-shadow: 0 8px 24px rgba(0,0,0,0.12)`. | EC-CNCL-020, EC-CNCL-060 |
| EC-CNCL-020 | Confirmed | User clicks "Cancel Execution" in popover | Popover closes immediately (no animation). Cancel ✕ button text replaced with 14px spinner in `var(--status-cancelled)`. Badge transitions to "Cancelling…" with `var(--status-cancelled)` background. API call: `DELETE /liveTableSchedule/cancelDAG/{iterationId}`. Timer continues counting. | EC-CNCL-030, EC-CNCL-040 |
| EC-CNCL-030 | API Success | `DELETE /liveTableSchedule/cancelDAG/{iterationId}` returns `200 OK` | "Cancelling…" badge **persists** — waiting for authoritative `DagTerminal` event. Cancel ✕ disabled (spinner removed, greyed out). Nodes continue updating via SignalR until `DagTerminal` arrives. No toast yet — completion toast fires on terminal event. | EC-IDLE-040, EC-CNCL-050 |
| EC-CNCL-040 | API Error | `DELETE /liveTableSchedule/cancelDAG/{iterationId}` returns 4xx or 5xx | Toast: "Failed to cancel — {error.message}" with `var(--status-failed)` left border. Cancel ✕ spinner removed, button re-enabled with `var(--status-failed)` colour. Badge reverts to "Running" with `var(--accent)` background. Execution continues uninterrupted. | EC-EXEC-010, EC-CNCL-010 |
| EC-CNCL-050 | Timeout | 30s elapsed after EC-CNCL-030 without `DagTerminal` event | Toast: "Cancel is taking longer than expected" with `var(--status-cancelled)` left border. "Cancelling…" badge persists. System auto-retries `DELETE cancelDAG/{iterationId}` once. If retry also times out after 30s, badge remains and user is advised to refresh. | EC-CNCL-030, EC-IDLE-040 |
| EC-CNCL-060 | Dismissed | User clicks "Keep Running" button, presses Escape, or clicks outside popover | Popover fades out (150ms ease-in, opacity 1→0). All toolbar controls unchanged — execution continues. Focus returns to Cancel ✕ button. | EC-EXEC-010, EC-EXEC-050, EC-EXEC-060 |
| EC-CNCL-070 | Cancel Queued | Cancel ✕ clicked while in EC-EXEC-040 (execution not yet started) | Popover skipped. Toast: "Cancel queued — will cancel when execution begins" with `var(--status-cancelled)` left border. Cancel ✕ shows ◆ indicator in `var(--status-cancelled)`. Cancel request held in memory. When first `NodeStarted` arrives, immediately fires `DELETE cancelDAG/{iterationId}`. | EC-CNCL-020, EC-IDLE-040 |

---

## 5. Refresh DAG (`EC-REF-*`)

Refresh re-fetches the DAG topology. It can run during execution without interrupting it.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-REF-010 | Initiated | User clicks Refresh ↻ button or presses `Ctrl+Shift+F` | Refresh ↻ icon starts rotating animation (360° / 600ms linear infinite) in `var(--accent)`. `GET /dagTopology` fired. Other toolbar buttons remain in their current states. | EC-REF-020, EC-REF-030, EC-REF-040, EC-REF-050, EC-REF-060 |
| EC-REF-020 | No Topology Change | API returns `200 OK` with same topology hash as current | Spinner stops. Subtle toast: "✓ Up to date" with `var(--status-succeeded)` left border, auto-dismisses after 2s. No canvas changes. Refresh ↻ returns to static state. | EC-IDLE-010, EC-IDLE-020, EC-IDLE-030, EC-IDLE-040 |
| EC-REF-030 | Topology Changed | API returns `200 OK` with different topology hash | Spinner stops. Canvas re-renders with cross-fade transition (300ms ease-out). Toast: "Topology updated — {n} node(s) changed" with `var(--accent)` left border. Changed nodes highlighted with `var(--accent-dim)` background that fades to transparent over 3s (3000ms linear). Refresh ↻ returns to static. | EC-IDLE-010, EC-IDLE-020, EC-IDLE-030, EC-IDLE-040 |
| EC-REF-040 | Auth Error (401/403) | API returns `401` or `403` | Spinner stops. Toast: "Authentication failed" with `var(--status-failed)` left border. Refresh ↻ re-enabled. Canvas unchanged. | EC-IDLE-010 |
| EC-REF-050 | Not Found (404) | API returns `404` (DAG deleted or renamed) | Spinner stops. Toast: "DAG not found — select a different definition" with `var(--status-failed)` left border. Canvas cleared. Definitions dropdown highlighted with `var(--accent-glow)` ring to draw attention. | EC-IDLE-060, EC-DEF-020 |
| EC-REF-060 | Server / Network Error | API returns 5xx or `fetch()` rejects | Spinner stops. Toast: "Refresh failed — try again" with `var(--status-failed)` left border. Refresh ↻ re-enabled immediately. Canvas unchanged (stale topology preserved). | EC-IDLE-010, EC-IDLE-020, EC-IDLE-030, EC-IDLE-040 |
| EC-REF-070 | During Execution | Refresh ↻ clicked while any `EC-EXEC-*` state is active | Topology refresh proceeds normally. Execution state is **preserved** — node statuses from SignalR are overlaid onto the new topology. If the new topology removes a currently-running node, warning toast: "Active node removed from topology" with `var(--status-cancelled)` left border. Timer and badge unaffected. | EC-EXEC-010, EC-EXEC-050 |
| EC-REF-080 | Debounce Guard | Refresh ↻ clicked within 3s of a prior Refresh | Click silently absorbed — no API call, no spinner, no toast. Internal debounce flag resets after 3s. Prevents rapid re-fetching. | _(remains in current state)_ |

---

## 6. Lock Detection + Force Unlock (`EC-LOCK-*`)

Lock status is polled every **30 seconds**. The Force Unlock option appears when a lock is older than **5 minutes**. The Force Unlock modal (420px) uses `click-outside does NOT dismiss` to prevent accidental closure.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-LOCK-010 | Young Lock | Lock poll detects lock with age < 5 minutes | Lock indicator ◆ appears next to DAG name in `var(--status-cancelled)`. Tooltip: "Locked by {userName} — {timeAgo} ago". Run ▸ **disabled** at `var(--color-text-tertiary)` with tooltip "DAG is locked". Cancel, Refresh, Settings remain functional. | EC-LOCK-010, EC-LOCK-020, EC-LOCK-110 |
| EC-LOCK-020 | Stale Lock | Lock poll detects lock with age ≥ 5 minutes | ◆ indicator begins **pulse animation** (2000ms ease-in-out, opacity 0.6→1.0) in `var(--status-cancelled)`. "Force Unlock" text button appears in toolbar with `var(--status-cancelled)` text and 1px `var(--status-cancelled)` border, 4px border-radius. Tooltip on ◆: "Lock held for {time} — may be stale". Run ▸ remains disabled. | EC-LOCK-030, EC-LOCK-110 |
| EC-LOCK-030 | Confirm Dialog | User clicks "Force Unlock" button or presses `Ctrl+Shift+U` | **420px modal** centered on screen with `var(--color-bg)` background. Backdrop: `rgba(0,0,0,0.4)`. **Click-outside does NOT dismiss** (intentional — prevents accidental force-unlock). Heading: "Force unlock this DAG?" in `var(--color-text)`. Warning paragraph: "This will release the lock held by {userName}. Any unsaved work in their session may be lost." in `var(--color-text-secondary)`. Two buttons: "Force Unlock" (destructive, `var(--status-failed)` bg, white text) and "Cancel" (secondary, `var(--color-bg-tertiary)` bg). | EC-LOCK-040, EC-LOCK-060 |
| EC-LOCK-040 | API Call | User clicks "Force Unlock" in modal | Both modal buttons disabled at `var(--color-text-tertiary)`. "Force Unlock" button text replaced with 14px spinner in white. `DELETE /liveTableSchedule/lock/{dagId}` fired. Modal remains open during request. | EC-LOCK-050, EC-LOCK-070, EC-LOCK-080, EC-LOCK-090 |
| EC-LOCK-050 | Success | `DELETE /liveTableSchedule/lock/{dagId}` returns `200 OK` | Modal fades out (150ms ease-in). ◆ indicator removed with fade (200ms). "Force Unlock" toolbar button removed. Toast: "Lock released" with `var(--status-succeeded)` left border, auto-dismisses after 3s. Run ▸ re-enabled with `var(--accent)`. Lock polling resets. | EC-IDLE-010, EC-IDLE-020, EC-IDLE-030, EC-IDLE-040 |
| EC-LOCK-060 | Dismissed | User clicks "Cancel" in modal or presses Escape | Modal fades out (150ms ease-in). Lock state unchanged — ◆ indicator and "Force Unlock" button persist. Focus returns to "Force Unlock" toolbar button. | EC-LOCK-020 |
| EC-LOCK-070 | No Lock Error | `DELETE /liveTableSchedule/lock/{dagId}` returns `404` (lock already released) | Modal fades out. ◆ indicator removed. Toast: "No lock found — DAG is available" with `var(--status-succeeded)` left border. Run ▸ re-enabled. "Force Unlock" button removed. Lock polling continues normally. | EC-IDLE-010 |
| EC-LOCK-080 | Auth Error | `DELETE /liveTableSchedule/lock/{dagId}` returns `401` or `403` | Modal fades out. Toast: "Not authorized to unlock this DAG" with `var(--status-failed)` left border. ◆ indicator and "Force Unlock" button persist. Lock state unchanged. | EC-LOCK-020 |
| EC-LOCK-090 | Server Error | `DELETE /liveTableSchedule/lock/{dagId}` returns 5xx or `fetch()` rejects | Modal fades out. Toast: "Unlock failed — try again" with `var(--status-failed)` left border. ◆ indicator and "Force Unlock" button persist. No auto-retry. | EC-LOCK-020 |
| EC-LOCK-100 | Poll Error | Lock status poll (`GET /liveTableSchedule/lock/{dagId}`) fails with any error | Previous lock state preserved (no change to ◆ indicator or button visibility). Silent retry on next 30s poll interval. After **3 consecutive poll failures**: subtle warning icon (▸) with tooltip "Lock status unknown — check connection" in `var(--status-cancelled)`. Warning clears on next successful poll. | EC-LOCK-010, EC-LOCK-020, EC-LOCK-110 |
| EC-LOCK-110 | External Clear | Lock poll detects lock is no longer present (another user released it, or lock expired) | ◆ indicator removed with fade-out (200ms ease-in). "Force Unlock" toolbar button removed if present. Run ▸ re-enabled with `var(--accent)`. **No toast** — this is a silent, ambient transition. Lock polling continues normally. | EC-IDLE-010, EC-IDLE-020, EC-IDLE-030, EC-IDLE-040 |

---

## 7. Settings Panel (`EC-SET-*`)

The Settings panel slides in from the right edge (360px width). Settings **auto-save** with a **500ms debounce** — no explicit save button.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-SET-010 | Opened | User clicks ⚙ Settings button or presses `Ctrl+Shift+S` | Panel slides in from right edge (250ms ease-out, `translateX(100%)` → `translateX(0)`). 360px width, `var(--color-bg)` background, `var(--color-border)` left border (1px). Header: "Settings" in `var(--color-text)` with close ✕ button top-right. Panel overlays DAG canvas (no push). Focus trapped within panel. | EC-SET-020 |
| EC-SET-020 | Loading | Panel opened, `GET /dagSettings/{dagId}` in flight | Skeleton placeholders for each setting row: 3 rows of 200px×32px rectangles with pulse animation (1500ms ease-in-out, `var(--color-bg-tertiary)` → `var(--color-bg-secondary)` → `var(--color-bg-tertiary)`). 12px spinner in panel header next to "Settings" text. Close ✕ enabled. | EC-SET-030, EC-SET-070 |
| EC-SET-030 | Loaded | `GET /dagSettings/{dagId}` returns `200 OK` | Settings form fully populated. **Parallelism:** range slider (1–16), track fill `var(--accent)`, thumb 16px circle `var(--accent)`, current value label right-aligned. **Timeout:** number input (1–3600s), `var(--color-border)` border, focus ring `var(--accent-glow)`. **Environment:** dropdown select, chevron ▸. **Retry on failure:** toggle switch, active state `var(--accent)`. Each setting has label in `var(--color-text)` and description in `var(--color-text-tertiary)`. | EC-SET-040, EC-SET-080, EC-SET-090, EC-SET-100 |
| EC-SET-040 | Changed | User modifies any setting value | "Unsaved" indicator: 6px dot in `var(--status-cancelled)` appears next to ⚙ button in toolbar (visible even when panel open). Internal: 500ms debounce timer starts. After debounce expires, `PUT /dagSettings/{dagId}` fires automatically. No explicit save button. | EC-SET-050, EC-SET-060 |
| EC-SET-050 | Save Success | `PUT /dagSettings/{dagId}` returns `200 OK` | "Unsaved" dot removed from ⚙ button. Brief inline "Saved" text in `var(--status-succeeded)` appears next to the changed setting label, fades out after 1s (1000ms ease-in). No toast — feedback is contextual and quiet. | EC-SET-030 |
| EC-SET-060 | Save Error | `PUT /dagSettings/{dagId}` returns error (any status) | "Unsaved" dot colour changes from `var(--status-cancelled)` to `var(--status-failed)`. Toast: "Settings save failed — retrying…" with `var(--status-failed)` left border. System auto-retries **once** after 2s. If retry also fails, dot persists and toast updates to "Settings save failed — changes not saved" with no further auto-retry. | EC-SET-040, EC-SET-030 |
| EC-SET-070 | Load Error | `GET /dagSettings/{dagId}` returns error (any status) | Skeleton removed. Panel body shows centered error state: "Failed to load settings" in `var(--color-text-secondary)`, error icon (✕) in `var(--status-failed)` above text. "Retry" link in `var(--accent)` below. Close ✕ remains enabled. | EC-SET-020, EC-SET-080 |
| EC-SET-080 | Closed | User clicks close ✕, presses Escape (when panel is topmost layer), or clicks outside panel on canvas | **Pre-close:** if unsaved changes exist (EC-SET-040), auto-save fires immediately (no debounce wait). Panel slides out right (200ms ease-in, `translateX(0)` → `translateX(100%)`). Focus returns to ⚙ Settings button. Focus trap released. | EC-IDLE-010, EC-IDLE-020, EC-IDLE-030, EC-IDLE-040 |
| EC-SET-090 | Slider Interaction | User clicks or drags the parallelism range slider | **Real-time value preview**: numeric label next to slider thumb updates live during drag. Track fill width adjusts in real-time with `var(--accent)`. On mouse-up / touch-end: debounce timer starts (500ms) and transitions to EC-SET-040. Slider emits `input` events during drag (preview) and `change` event on release (save trigger). | EC-SET-040 |
| EC-SET-100 | Env Dropdown Open | User clicks the Environment dropdown trigger | Dropdown expands below field (200ms ease-out, max-height animation). Options list with `var(--color-bg)` background, `var(--color-border)` border. Each option: text label + radio-style indicator (○ unselected, ● selected in `var(--accent)`). If >5 environments: search/filter input at top. Hover state: `var(--color-bg-tertiary)`. Click-outside or Escape closes. Selected option triggers EC-SET-040. | EC-SET-040 |

---

## 8. MLV Definitions Dropdown (`EC-DEF-*`)

The definitions dropdown lives in the toolbar and controls which MLV definition (and its associated DAG) is currently loaded.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-DEF-010 | Closed | Default state / dropdown dismissed / definition selected | Dropdown trigger in toolbar shows selected MLV name in `var(--color-text)`, truncated at 200px max-width with ellipsis. Chevron ▸ in `var(--color-text-secondary)`. Background `var(--color-bg-secondary)`, 4px border-radius. Hover: `var(--color-bg-tertiary)`. | EC-DEF-020 |
| EC-DEF-020 | Opened | User clicks dropdown trigger or presses `Ctrl+Shift+D` | Dropdown panel opens below trigger (200ms ease-out, `opacity 0→1` + `translateY(-4px)→0`). Max-height 400px with overflow-y scroll if needed. `var(--color-bg)` background, `var(--color-border)` border, `box-shadow: 0 8px 24px rgba(0,0,0,0.12)`. Search input at top: `var(--color-bg-secondary)` background, placeholder "Search definitions…" in `var(--color-text-tertiary)`, auto-focused. Divider below search: 1px `var(--color-border)`. Definition list below. "＋ New Definition" link at bottom in `var(--accent)`. | EC-DEF-030, EC-DEF-040, EC-DEF-050, EC-DEF-060, EC-DEF-100, EC-DEF-110 |
| EC-DEF-030 | Selected | User clicks a definition item in the list | Clicked item briefly highlights with `var(--accent-dim)` background (150ms). Dropdown closes (150ms fade-out). Trigger text updates to newly selected name. Fires DAG topology fetch → transitions to EC-IDLE-050. | EC-IDLE-050 |
| EC-DEF-040 | Keyboard Nav | User presses ↑ or ↓ arrow keys while dropdown is open | Focus ring (`var(--accent-glow)` box-shadow, 2px) moves between definition items. Currently focused item also gets `var(--accent-dim)` background. Home/End jump to first/last item. `Enter` selects focused item → EC-DEF-030. `Escape` closes → EC-DEF-060. Typing filters the list (search input receives keystrokes). | EC-DEF-030, EC-DEF-060 |
| EC-DEF-050 | Create Dialog | User clicks "＋ New Definition" link | Dropdown closes. **480px modal** centered on screen with `var(--color-bg)` background, backdrop `rgba(0,0,0,0.4)`. Heading: "Create New Definition" in `var(--color-text)`. Name input: auto-focused, `var(--color-border)` border, placeholder "my-definition" in `var(--color-text-tertiary)`. Validation: 3–64 characters, alphanumeric + hyphens only (shown as hint text below input in `var(--color-text-tertiary)`). Two buttons: "Create" (`var(--accent)` bg, white text) and "Cancel" (secondary). | EC-DEF-070, EC-DEF-060 |
| EC-DEF-060 | Dismissed | Escape pressed, click outside dropdown/dialog, or "Cancel" clicked | Dropdown or dialog closes with fade-out (150ms ease-in, opacity 1→0). Focus returns to dropdown trigger. No state change to selected definition. | EC-DEF-010 |
| EC-DEF-070 | Submitting | User clicks "Create" with valid name | "Create" button text replaced with 14px spinner in white. Name input disabled at `var(--color-text-tertiary)`. "Cancel" button disabled. `POST /mlvDefinitions` fires. Modal remains open during request. | EC-DEF-080, EC-DEF-090 |
| EC-DEF-080 | Success | `POST /mlvDefinitions` returns `201 Created` | Modal fades out (150ms). Toast: "Definition created" with `var(--status-succeeded)` left border. New definition auto-selected in trigger. DAG topology fetch fires → EC-IDLE-050. | EC-IDLE-050 |
| EC-DEF-090 | Error | `POST /mlvDefinitions` returns error | Inline error text below name input in `var(--status-failed)`. If `409 Conflict`: "A definition with this name already exists". Otherwise: "Failed to create definition — {error.message}". Name input border changes to `var(--status-failed)`. Input and buttons re-enabled for correction. | EC-DEF-050 |
| EC-DEF-100 | Loading | Dropdown opened but definition list still fetching from API | 3 skeleton rows with pulse animation (1500ms ease-in-out, `var(--color-bg-tertiary)`). Search input disabled. "＋ New Definition" link hidden. Skeleton rows: 160px×28px with 4px border-radius. | EC-DEF-020 |
| EC-DEF-110 | Empty | Definition list loaded successfully but contains zero items | Empty state in dropdown body: illustration placeholder (48px circle in `var(--color-bg-tertiary)`). Text: "No definitions found" in `var(--color-text-secondary)`. "＋ Create your first definition" link in `var(--accent)`. Search input hidden (nothing to search). | EC-DEF-050 |

---

## 9. Keyboard Shortcuts (`EC-KBD-*`)

Global keyboard shortcuts are disabled when a text input/textarea is focused (EC-KBD-070). The **Escape cascade** dismisses the topmost overlay layer.

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-KBD-010 | Run Shortcut | `Ctrl+Shift+R` pressed | Equivalent to clicking Run ▸. Only fires when: no modal or popover is open, no text input is focused, and Run ▸ is enabled. Visual: Run ▸ button gets brief focus ring (150ms `var(--accent-glow)`) before triggering. | EC-RUN-010 |
| EC-KBD-020 | Cancel Shortcut | `Ctrl+Shift+C` pressed | Equivalent to clicking Cancel ✕. Only fires when: execution is active (any `EC-EXEC-*` state), no modal is open, Cancel ✕ is enabled. Visual: Cancel ✕ button gets brief focus ring. | EC-CNCL-010 |
| EC-KBD-030 | Refresh Shortcut | `Ctrl+Shift+F` pressed | Equivalent to clicking Refresh ↻. Only fires when: no modal is open, Refresh is enabled. Visual: Refresh ↻ gets brief focus ring. | EC-REF-010 |
| EC-KBD-040 | Unlock Shortcut | `Ctrl+Shift+U` pressed | Equivalent to clicking "Force Unlock". Only fires when: stale lock detected (EC-LOCK-020), no other modal is open. Visual: "Force Unlock" button gets brief focus ring. | EC-LOCK-030 |
| EC-KBD-050 | Settings Shortcut | `Ctrl+Shift+S` pressed | Equivalent to clicking ⚙ Settings. Only fires when: Settings panel is closed, no modal is open. If panel is already open, shortcut does nothing (close via Escape). Visual: ⚙ button gets brief focus ring. | EC-SET-010 |
| EC-KBD-060 | Escape Cascade | `Escape` key pressed | Dismisses the **topmost** overlay layer in strict priority order: **(1)** Force Unlock modal (EC-LOCK-030 → EC-LOCK-060) → **(2)** Cancel popover (EC-CNCL-010 → EC-CNCL-060) → **(3)** Settings panel (EC-SET-080) → **(4)** Definition dropdown (EC-DEF-060) → **(5)** Node selection on canvas (deselects selected node). Only one layer dismissed per keypress. If nothing is open, Escape is a no-op. | EC-LOCK-060, EC-CNCL-060, EC-SET-080, EC-DEF-060, _(canvas deselect)_ |
| EC-KBD-070 | Input Blocked | Any `Ctrl+Shift+{key}` shortcut pressed while an `<input>`, `<textarea>`, or `[contenteditable]` element has focus | **No action taken.** Keystroke passes through to the focused input element. Prevents accidental Run/Cancel/Refresh triggers during text entry (e.g., typing in search input within definitions dropdown, or editing settings values). Escape is **not blocked** — it always works for the cascade. | _(remains in current state)_ |

---

## Transition Animations

All animation values are applied via CSS. Durations follow the principle: entrances slightly longer than exits.

| Transition | Duration | Easing | Properties | Tokens Referenced |
|------------|----------|--------|------------|-------------------|
| Button state change (enable/disable) | 150ms | `ease-out` | `opacity`, `background-color`, `color` | `var(--accent)`, `var(--color-text-tertiary)` |
| Spinner appear | 200ms | `ease-in` | `opacity` 0→1, `transform: rotate()` 360°/800ms linear infinite | `var(--accent)` |
| Toast enter | 250ms | `cubic-bezier(0.4, 0, 0.2, 1)` | `transform: translateY(-8px)→0`, `opacity` 0→1 | — |
| Toast exit / auto-dismiss | 200ms | `ease-in` | `opacity` 1→0 | — |
| Settings panel slide-in | 250ms | `ease-out` | `transform: translateX(100%)→0` | — |
| Settings panel slide-out | 200ms | `ease-in` | `transform: translateX(0)→translateX(100%)` | — |
| Modal fade-in (Lock, Create Def) | 200ms | `ease-out` | `opacity` 0→1, `transform: scale(0.96)→scale(1)` | — |
| Modal fade-out | 150ms | `ease-in` | `opacity` 1→0 | — |
| Popover appear (Cancel confirm) | 150ms | `ease-out` | `opacity` 0→1, `transform: translateY(-4px)→0` | — |
| Popover dismiss | 150ms | `ease-in` | `opacity` 1→0 | — |
| Badge colour change | 300ms | `ease-in-out` | `background-color`, `color` | `var(--status-succeeded)`, `var(--status-failed)`, `var(--status-cancelled)`, `var(--accent)` |
| Completion badge pulse | 600ms | `ease-in-out` | `transform: scale(1→1.05→1)` | `var(--status-succeeded)` |
| Lock icon pulse (stale) | 2000ms | `ease-in-out` | `opacity` 0.6→1.0 (infinite) | `var(--status-cancelled)` |
| Skeleton pulse | 1500ms | `ease-in-out` | `opacity` 0.4→1.0 (infinite) | `var(--color-bg-tertiary)` |
| Canvas re-render (topology change) | 300ms | `ease-out` | `opacity` (cross-fade) | — |
| Diff highlight decay | 3000ms | `linear` | `background-color` tinted→transparent | `var(--accent-dim)` → `transparent` |
| Dropdown expand | 200ms | `ease-out` | `max-height`, `opacity` | — |
| Dropdown collapse | 150ms | `ease-in` | `max-height`, `opacity` | — |
| Focus ring (keyboard nav) | 150ms | `ease-out` | `box-shadow` | `var(--accent-glow)` |
| Lock indicator fade-out | 200ms | `ease-in` | `opacity` 1→0 | `var(--status-cancelled)` |
| Timer tick | — (immediate) | — | Text content update (no animation) | `var(--color-text)` |

---

## Error State Summary

Quick reference for all error states, their HTTP codes, user-facing messages, and recovery paths.

| State ID | Error Type | HTTP Status | User Message | Recovery Path |
|----------|-----------|-------------|--------------|---------------|
| EC-RUN-030 | Auth | 401 / 403 | "Authentication failed — please sign in again" | Re-authenticate, retry Run |
| EC-RUN-040 | Not Found | 404 | "DAG not found — topology may have changed" | Refresh topology (EC-REF-010) |
| EC-RUN-050 | Conflict | 409 | "DAG is already running or locked by another user" | Wait for completion, or Force Unlock (EC-LOCK-030) |
| EC-RUN-060 | Rate Limit | 429 | "Too many requests — try again in {n}s" | Wait for `Retry-After`, auto-enables |
| EC-RUN-070 | Server | 5xx | "Server error — please try again" | Manual retry |
| EC-RUN-080 | Network | _(no response)_ | "Network error — check your connection" | Restore connectivity, retry |
| EC-CNCL-040 | Cancel Failed | 4xx / 5xx | "Failed to cancel — {error.message}" | Retry Cancel (EC-CNCL-010) |
| EC-CNCL-050 | Cancel Timeout | _(timeout)_ | "Cancel is taking longer than expected" | Auto-retry once, then Refresh |
| EC-REF-040 | Auth | 401 / 403 | "Authentication failed" | Re-authenticate |
| EC-REF-050 | Not Found | 404 | "DAG not found — select a different definition" | Re-select from dropdown (EC-DEF-020) |
| EC-REF-060 | Server / Net | 5xx / _(none)_ | "Refresh failed — try again" | Manual retry |
| EC-LOCK-070 | No Lock | 404 | "No lock found — DAG is available" | _(auto-recovery — not an error)_ |
| EC-LOCK-080 | Auth | 401 / 403 | "Not authorized to unlock this DAG" | Contact workspace admin |
| EC-LOCK-090 | Server | 5xx / _(none)_ | "Unlock failed — try again" | Manual retry |
| EC-LOCK-100 | Poll Failure | _(varies)_ | _(silent — warning after 3 failures)_ | Auto-retry on next 30s interval |
| EC-SET-060 | Save Failed | _(varies)_ | "Settings save failed — retrying…" | Auto-retry once (2s delay) |
| EC-SET-070 | Load Failed | _(varies)_ | "Failed to load settings" | Manual retry via "Retry" link |
| EC-DEF-090 | Create Failed | 409 / _(varies)_ | "A definition with this name already exists" / server error | Fix input, retry |
| EC-IDLE-060 | Load Failed | 4xx / 5xx | "Failed to load DAG topology" | Retry or Refresh (EC-REF-010) |

---

## State Count

| Category | Prefix | Count |
|----------|--------|-------|
| Idle / Ready | `EC-IDLE-` | 6 |
| Run DAG | `EC-RUN-` | 9 |
| Execution Monitoring | `EC-EXEC-` | 6 |
| Cancel | `EC-CNCL-` | 7 |
| Refresh | `EC-REF-` | 8 |
| Lock / Unlock | `EC-LOCK-` | 11 |
| Settings | `EC-SET-` | 10 |
| Definitions | `EC-DEF-` | 11 |
| Keyboard Shortcuts | `EC-KBD-` | 7 |
| **Total** | | **75** |

---

> *"Every pixel is a state machine. Every state machine is a contract with the user.*
> *75 states. Zero ambiguity. Zero guesswork for Pixel."*
> — Sana Reeves, Architecture
