# P3 State Matrices — Execution & Utility Components

> **Feature**: F16 New Infra Wizard
> **Components**: C10-ExecutionPipeline, C12-TemplateManager, C13-AutoLayoutEngine, C14-UndoRedoManager
> **Spec Level**: P3 (State Matrices)
> **Status**: Draft
> **Last Updated**: 2025-07-16

---

## Table of Contents

1. [C10 — ExecutionPipeline (32 states)](#c10--executionpipeline-32-states)
2. [C12 — TemplateManager (18 states)](#c12--templatemanager-18-states)
3. [C13 — AutoLayoutEngine (12 states)](#c13--autolayoutengine-12-states)
4. [C14 — UndoRedoManager (13 states)](#c14--undoredomanager-13-states)

---

# C10 — ExecutionPipeline (32 states)

The most complex component in F16. Three concurrent state machines operate in parallel:
the **pipeline** lifecycle, per-**step** lifecycles (x6), the **minimize/restore** viewport,
the **timer**, the **step detail panel**, and the **footer** panel. The matrices below
cover every permutation.

## C10-SM1: Pipeline Lifecycle (8 states)

### `C10.pipeline.idle`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.pipeline.idle` |
| **Entry conditions** | Wizard navigates to Page 5 via "Lock In & Create" click; execution context assembled and frozen by WizardDataBus |
| **Exit conditions** | `start()` called with valid context → `C10.pipeline.executing` |
| **Visual description** | All 6 pipeline steps rendered in a vertical list with gray pending circles. Header reads "Ready to Create". No timer running. Footer hidden. |
| **Active DOM elements** | `.execution-pipeline` visible; `.pipeline-step` x6 all `data-status="pending"`; `.pipeline-header__timer` hidden; `.pipeline-summary` hidden; `.error-panel` hidden |
| **Keyboard shortcuts** | `Enter`/`Space` on any step row — no-op (nothing to expand); `Escape` — closes wizard |
| **Data requirements** | Frozen `ExecutionContext` from WizardDataBus; `FabricApiClient` instance; empty `rollbackManifest` |
| **Transitions** | `start()` called → `C10.pipeline.executing` |
| **Error recovery** | If context validation fails on entry, show inline error in pipeline header and remain idle; user can go Back to fix |
| **Animation** | Steps stagger-fade-in from top: each step `opacity: 0→1`, `translateY(8px)→0`, 200ms ease-out, 50ms stagger per step |

### `C10.pipeline.executing`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.pipeline.executing` |
| **Entry conditions** | `start()` called from idle; OR retry transitions back to executing from `C10.pipeline.retrying` |
| **Exit conditions** | All 6 steps succeed → `C10.pipeline.succeeded`; any step fails with retries exhausted → `C10.pipeline.failed` |
| **Visual description** | Active step shows spinning indicator with expanding log. Completed steps show green checkmarks. Pending steps remain gray circles. Global timer ticks in header. |
| **Active DOM elements** | `.pipeline-header__timer` visible, class `--running`; active step has `data-status="running"`, `aria-current="step"`; `.step-detail` auto-expanded on active step; wizard close (X) button triggers minimize, NOT close |
| **Keyboard shortcuts** | `Tab`/`Shift+Tab` — navigate between step info buttons; `Enter`/`Space` on completed step — toggle detail expand; `Escape` — minimize to badge (NOT cancel) |
| **Data requirements** | `ExecutionContext`, `FabricApiClient`, `rollbackManifest` accumulating created resource IDs as steps complete |
| **Transitions** | Step N succeeds, N<5 → stays `executing` (advance `activeStepIndex`); Step 5 succeeds → `C10.pipeline.succeeded`; Step N fails, retries exhausted → `C10.pipeline.failed`; Step N fails, retries remaining → stays `executing` (auto-retry within step) |
| **Error recovery** | Per-step auto-retry with exponential backoff (1s, 2s, 4s, max 30s). Network errors get 3 retries; auth errors get 1; validation errors get 0 |
| **Animation** | Active step spinner: `spin 800ms linear infinite`; step transition succeeded: icon cross-fade 200ms; new step entrance: `opacity 0→1, translateX(-4px)→0` 200ms |

### `C10.pipeline.succeeded`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.pipeline.succeeded` |
| **Entry conditions** | Step 5 (Execute Notebook) returns success (LRO completed) |
| **Exit conditions** | User clicks "Navigate to Workspace" → `C10.pipeline.navigating`; user clicks "Create Another" → wizard resets to Page 1; user closes wizard → destroyed |
| **Visual description** | All 6 steps display green checkmarks with individual durations. Header shows total elapsed time. Success summary footer visible with confetti-free celebration messaging: "Environment created successfully!" |
| **Active DOM elements** | All `.pipeline-step` with `data-status="succeeded"`; `.pipeline-summary` visible with `.pipeline-summary--success`; "Navigate to Workspace" button (primary, focused); "Create Another" button (secondary); timer stopped, showing final value |
| **Keyboard shortcuts** | `Tab` — Navigate to Workspace → Create Another; `Enter`/`Space` — activate focused button; `Escape` — close wizard |
| **Data requirements** | All artifacts populated: `workspaceId`, `capacityId`, `lakehouseId`, `notebookId`, `workspaceUrl`; complete `rollbackManifest` (for reference only) |
| **Transitions** | "Navigate to Workspace" click → `C10.pipeline.navigating`; "Create Another" → wizard reset (pipeline destroyed); close → destroyed |
| **Error recovery** | N/A — terminal success state. If navigate fails, show toast and remain in this state |
| **Animation** | Summary footer: `slideUp` from bottom, `opacity 0→1`, 300ms `ease-out`; step checkmarks pulse once: `scale(1)→scale(1.15)→scale(1)` 400ms with 50ms stagger |

### `C10.pipeline.failed`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.pipeline.failed` |
| **Entry conditions** | Any step exhausts all auto-retries and fails terminally |
| **Exit conditions** | `retryFromFailed()` → `C10.pipeline.retrying`; `rollback()` → `C10.pipeline.rolling_back`; close/minimize → remains failed (badge shows error state) |
| **Visual description** | Failed step shows red X icon with auto-expanded error detail. Steps after failed remain gray pending. Error panel appears below pipeline with error message, category badge, and action buttons. |
| **Active DOM elements** | Failed step: `data-status="failed"`, `.step-detail--expanded` with error log; `.error-panel` visible; "Retry from Failed Step" button (primary, auto-focused if error is retryable); "Rollback & Start Over" button (secondary, danger style); timer stopped |
| **Keyboard shortcuts** | `Tab` — cycle error panel buttons; `Enter`/`Space` — activate retry or rollback; `Escape` — minimize to badge (execution stopped, error badge shown) |
| **Data requirements** | `failedStepIndex`, `errorCategory`, `errorMessage`, `httpStatus`, `rawErrorBody`; `rollbackManifest` with resources created before failure |
| **Transitions** | Retry click → `C10.pipeline.retrying`; Rollback click → `C10.pipeline.rolling_back`; "Go Back" (for conflict errors) → wizard Page 1 (pipeline destroyed); minimize → badge with error indicator |
| **Error recovery** | Error panel shows human-readable message + raw details (collapsible). Non-retryable errors (400, 403, 409) disable Retry button. Retryable errors (500, network, timeout) enable Retry |
| **Animation** | Error panel: `slideDown` 300ms `ease-out`; failed step icon: `shake` animation `200ms` (translateX -2px, 2px, -1px, 0); red connector line color transition 200ms |

### `C10.pipeline.retrying`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.pipeline.retrying` |
| **Entry conditions** | User clicks "Retry from Failed Step" while pipeline is `failed` and `pipelineRetryCount < MAX_PIPELINE_RETRIES` (3) |
| **Exit conditions** | Internal transition → `C10.pipeline.executing` (immediate — sets `activeStepIndex` to failed step) |
| **Visual description** | Momentary transitional state. Previously succeeded steps dim to "skipped" styling. Failed step resets to pending. Error panel fades out. Timer resets to 0:00 for retry run. |
| **Active DOM elements** | Succeeded steps: `data-status="skipped"` (dimmed ◌); failed step: `data-status="pending"` (reset); error panel: fading out; pipeline header: "Retrying..." |
| **Keyboard shortcuts** | None active — transitional state (<100ms) |
| **Data requirements** | `failedStepIndex` (resume point); preserved artifacts from completed steps; `pipelineRetryCount` incremented |
| **Transitions** | Immediate → `C10.pipeline.executing` |
| **Error recovery** | If retry count exceeds MAX_PIPELINE_RETRIES, Retry button is disabled in failed state; user must rollback or close |
| **Animation** | Succeeded steps: `opacity 1→0.5`, color desaturate, 200ms; failed step: `background flash` reset pulse 200ms; error panel: `opacity 1→0, height→0` 200ms |

### `C10.pipeline.rolling_back`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.pipeline.rolling_back` |
| **Entry conditions** | User clicks "Rollback & Start Over" from failed state; `rollbackManifest` has >= 1 resource |
| **Exit conditions** | All deletes succeed → `C10.pipeline.rolled_back`; any delete fails → `C10.pipeline.rollback_failed` |
| **Visual description** | Pipeline steps are replaced by rollback progress view. Each resource deletion shown as a sub-step in reverse creation order. Rollback header: "Rolling Back..." with spinner. Original steps dimmed in background. |
| **Active DOM elements** | `.rollback-panel` visible over `.pipeline-steps` (semi-transparent overlay); rollback sub-steps showing delete progress; all original buttons disabled; timer shows rollback elapsed |
| **Keyboard shortcuts** | None active — rollback is non-interruptible |
| **Data requirements** | `rollbackManifest.resources` in reverse order; DELETE endpoints for each resource type; resource display names for log messages |
| **Transitions** | All deletes OK → `C10.pipeline.rolled_back`; any delete fails → `C10.pipeline.rollback_failed` |
| **Error recovery** | Each DELETE is independent — failure of one does not stop others. Best-effort sequential deletion continues through all resources |
| **Animation** | Rollback panel: `slideDown` 300ms; each rollback sub-step: fade-in 150ms stagger; progress indicator: `spin 800ms linear infinite` |

### `C10.pipeline.rolled_back`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.pipeline.rolled_back` |
| **Entry conditions** | All rollback DELETE calls succeeded |
| **Exit conditions** | "Start Over" click → wizard Page 1 (pipeline destroyed); close → wizard closed |
| **Visual description** | All original pipeline steps shown as dimmed (◌) with "Rolled back" label. Rollback summary: "All resources have been cleaned up." "Start Over" button is primary action. |
| **Active DOM elements** | All steps: `data-status="rolled-back"`, dimmed styling; `.rollback-summary` visible; "Start Over" button (primary, focused); close (X) button enabled |
| **Keyboard shortcuts** | `Tab` — Start Over → Close; `Enter`/`Space` — activate focused button; `Escape` — close wizard |
| **Data requirements** | Rollback results (all succeeded); no live artifacts remaining |
| **Transitions** | "Start Over" → wizard Page 1 reset; close → destroyed |
| **Error recovery** | N/A — clean terminal state |
| **Animation** | Summary: `fadeIn` 300ms; steps dim: `opacity 0.5` transition 300ms |

### `C10.pipeline.rollback_failed`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.pipeline.rollback_failed` |
| **Entry conditions** | At least one rollback DELETE call failed |
| **Exit conditions** | "Try Rollback Again" → `C10.pipeline.rolling_back`; close → wizard closed |
| **Visual description** | Warning panel with orange/amber styling listing resources that could NOT be deleted. Manual cleanup instructions provided. "Try Rollback Again" and "Close" buttons. |
| **Active DOM elements** | `.rollback-warning` visible with list of un-deleted resources; "Try Rollback Again" button (primary); "Close" button (secondary); manual cleanup link |
| **Keyboard shortcuts** | `Tab` — Try Again → Close; `Enter`/`Space` — activate button; `Escape` — close wizard |
| **Data requirements** | `rollbackResults` with per-resource success/failure status; resource URLs for manual cleanup links |
| **Transitions** | "Try Rollback Again" → `C10.pipeline.rolling_back`; close → destroyed |
| **Error recovery** | Show specific failure reasons per resource. Provide Fabric portal links for manual cleanup. Warn user about orphaned resources |
| **Animation** | Warning panel: `slideDown` 300ms; failed resource items: red highlight pulse 200ms |

---

## C10-SM2: Step Lifecycle (7 states per step, x6 steps)

### `C10.step.pending`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.step[N].pending` (N = 0..5) |
| **Entry conditions** | Pipeline initialized; OR step reset during `retryFromFailed()` for the failed step |
| **Exit conditions** | Pipeline reaches this step (previous step succeeded or skipped) → `C10.step[N].running` |
| **Visual description** | Gray empty circle (○) icon. Step name in muted text. No timer. No expand toggle. Detail panel hidden. |
| **Active DOM elements** | `.pipeline-step[data-step="N"]` with `data-status="pending"`; `.step-status--pending`; `.step-info` button (focusable but no detail to show); `.step-detail` hidden; `.step-time` hidden |
| **Keyboard shortcuts** | `Enter`/`Space` on step row — no-op (nothing to expand) |
| **Data requirements** | Step definition: `{ name, apiEndpoint, method, expectedStatuses, autoRetries, timeoutMs }` |
| **Transitions** | Pipeline activates → `C10.step[N].running` |
| **Error recovery** | N/A — waiting state |
| **Animation** | None (static) |

### `C10.step.running`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.step[N].running` |
| **Entry conditions** | Previous step completed (succeeded/skipped); OR auto-retry after transient failure |
| **Exit conditions** | API success → `C10.step[N].succeeded`; API failure + retries remaining → stays `running` (retry loop); API failure + retries exhausted → `C10.step[N].failed`; LRO response → `C10.step[N].polling_lro` |
| **Visual description** | Accent-colored circle with animated spinner (◐). Step name in active text color. Elapsed timer ticking. Detail panel auto-expanded showing live log entries. Connector line in accent color. |
| **Active DOM elements** | `.step-status--running` with `.spinner` (800ms spin); `.step-time--counting` with ticking seconds; `.step-detail--expanded` with `.step-detail__log` showing live entries; `aria-current="step"` |
| **Keyboard shortcuts** | `Enter`/`Space` — toggle detail expand/collapse (auto-expanded by default) |
| **Data requirements** | API call in-flight via `fetch()`; `AbortController` for timeout; `retryCount` tracking; step-local timer |
| **Transitions** | HTTP 200/201 success → `C10.step[N].succeeded`; HTTP 202 (LRO) → `C10.step[N].polling_lro`; error + retries left → stays `running` (backoff then re-call); error + retries exhausted → `C10.step[N].failed`; network timeout → `C10.step[N].failed` |
| **Error recovery** | Exponential backoff: `baseDelay * 2^attempt + jitter`. Log each retry attempt. Rate-limit (429) uses `Retry-After` header if present |
| **Animation** | Spinner: `spin 800ms linear infinite`; timer digits: `font-variant-numeric: tabular-nums` (no layout shift); log entries: `fadeIn 150ms` as appended; step enters running: icon cross-fade from ○→◐ 200ms |

### `C10.step.polling_lro`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.step[N].polling_lro` |
| **Entry conditions** | API returned HTTP 202 with `Location` header (Long-Running Operation). Only Step 5 (Execute Notebook) uses LRO |
| **Exit conditions** | Poll returns `Completed` → `C10.step[N].succeeded`; poll returns `Failed` → `C10.step[N].failed`; poll timeout (>300s) → `C10.step[N].failed` |
| **Visual description** | Same as running, but log shows periodic polling updates: "Polling... (status: InProgress) 12s". Timer continues ticking. Spinner continues. Optional progress percentage if API provides it. |
| **Active DOM elements** | Same as running; `.step-detail__log` receives new polling log entries every 3s; `.step-time--counting` continues |
| **Keyboard shortcuts** | Same as running |
| **Data requirements** | LRO `operationId` or polling URL from 202 response; `pollIntervalMs` (3000ms); `maxPollDurationMs` (300000ms = 5 min); elapsed poll time |
| **Transitions** | Poll response `Completed` → `C10.step[N].succeeded`; Poll response `Failed` → `C10.step[N].failed`; Elapsed > `maxPollDurationMs` → `C10.step[N].failed` (category: `lro_timeout`) |
| **Error recovery** | Individual poll failures tolerated (3 consecutive poll failures before giving up). LRO timeout shows note: "The notebook may still be running in Fabric" |
| **Animation** | Polling pulse on log: subtle `opacity 0.7→1` flash every 3s when new poll result arrives; timer continues ticking |

### `C10.step.succeeded`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.step[N].succeeded` |
| **Entry conditions** | API returned expected success status; or LRO poll returned Completed |
| **Exit conditions** | During `retryFromFailed()` if this step was already completed → `C10.step[N].skipped` |
| **Visual description** | Green filled circle with checkmark (●✓). Step name in standard text. Duration badge showing elapsed time (e.g., "2.1s"). Detail panel collapsed (expandable on click). Green connector line segment. |
| **Active DOM elements** | `.step-status--succeeded` with ✓ icon; `.step-time` showing duration (not ticking); `.step-info` button with `aria-expanded="false"`, expandable; `.step-detail` collapsed with success log |
| **Keyboard shortcuts** | `Enter`/`Space` — expand detail to see success log and response data |
| **Data requirements** | Extracted artifacts (e.g., `workspaceId`); step duration; HTTP response summary for log; resource added to `rollbackManifest` |
| **Transitions** | `retryFromFailed()` called for later step → `C10.step[N].skipped` |
| **Error recovery** | N/A — succeeded |
| **Animation** | Icon transition: spinner→checkmark cross-fade 200ms; green color sweep on icon `scale(0.8)→scale(1.05)→scale(1)` 300ms spring; detail panel auto-collapse: `height auto→0` 200ms; connector line: gray→green 200ms |

### `C10.step.failed`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.step[N].failed` |
| **Entry conditions** | API returned error status and all auto-retries exhausted; OR LRO poll timeout/failure |
| **Exit conditions** | `retryFromFailed()` for this step → `C10.step[N].pending` (reset); pipeline rollback begins → step remains failed (visual only) |
| **Visual description** | Red circle with X icon (✕). Step name in error text color. Duration badge showing time at failure. Detail panel auto-expanded with error log, HTTP status, error body. Red connector line. |
| **Active DOM elements** | `.step-status--failed` with ✕; `.step-time--failed`; `.step-detail--expanded` with `.log-entry--error` entries; `aria-expanded="true"` forced |
| **Keyboard shortcuts** | `Enter`/`Space` — toggle detail (auto-expanded); `Tab` to error panel buttons below |
| **Data requirements** | `errorCategory`, `errorMessage`, `httpStatus`, `rawResponse`, `retryCount`, `stepDuration` |
| **Transitions** | Retry (this step) → `C10.step[N].pending`; rollback → remains `failed` visually; destroy → cleaned up |
| **Error recovery** | Error details shown inline. Category-specific suggested actions displayed. Non-retryable errors clearly labeled |
| **Animation** | Icon: spinner→✕ with `shake` 200ms; red color: `opacity 0→1` 200ms; error log entries: `slideDown` 200ms staggered; detail expand: `height 0→auto` 300ms |

### `C10.step.skipped`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.step[N].skipped` |
| **Entry conditions** | `retryFromFailed()` called — steps that previously succeeded transition to skipped to indicate they were not re-executed |
| **Exit conditions** | N/A — remains skipped for duration of retry execution |
| **Visual description** | Dimmed circle (◌). Step name in very muted text. Original duration badge preserved but dimmed. "Skipped" label. Connector line is dimmed gray. |
| **Active DOM elements** | `.step-status--skipped` with ◌; `.step-time` with original duration (dimmed); `.step-info` expandable to see original success log; `opacity: 0.5` on entire step row |
| **Keyboard shortcuts** | `Enter`/`Space` — expand to see original execution log from previous run |
| **Data requirements** | Original step artifacts preserved (still needed by later steps); original duration for display |
| **Transitions** | N/A — cosmetic state during retry, transitions back to succeeded if pipeline succeeds; or remains skipped |
| **Error recovery** | N/A |
| **Animation** | From succeeded: `opacity 1→0.5`, color desaturate, 200ms ease-out |

---

## C10-SM3: Step Detail Panel (5 states)

### `C10.detail.collapsed`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.detail[N].collapsed` |
| **Entry conditions** | Step completed (auto-collapse); or user manually collapses; or initial pending state |
| **Exit conditions** | User clicks step info button → `C10.detail[N].expanded`; step fails → `C10.detail[N].showing_error` (auto-expand) |
| **Visual description** | Detail panel hidden. Expand chevron (▸) pointing right. Only step row visible with icon, name, and duration. |
| **Active DOM elements** | `.step-detail` with `hidden` attribute; `.step-expand` showing ▸; `.step-info` `aria-expanded="false"` |
| **Keyboard shortcuts** | `Enter`/`Space` on `.step-info` button → expand |
| **Data requirements** | Log entries cached in memory (not destroyed on collapse) |
| **Transitions** | Click/key → `C10.detail[N].expanded`; step fails → `C10.detail[N].showing_error` |
| **Error recovery** | N/A |
| **Animation** | Collapse: `height auto→0`, `opacity 1→0`, 200ms ease-out; chevron: `rotate(90deg)→rotate(0)` 200ms |

### `C10.detail.expanded`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.detail[N].expanded` |
| **Entry conditions** | User clicks step info button; or step starts running (auto-expand); or step fails (auto-expand) |
| **Exit conditions** | User clicks step info button again → `C10.detail[N].collapsed`; user clicks "Show Request" tab → `C10.detail[N].showing_request` |
| **Visual description** | Detail panel visible showing log entries. Tab bar if step completed: "Log | Request | Response". Log entries scroll if tall. |
| **Active DOM elements** | `.step-detail` visible, `hidden` removed; `.step-expand` showing ▾; `.step-info` `aria-expanded="true"`; `.step-detail__log` with log entries; tab bar (if completed step) |
| **Keyboard shortcuts** | `Enter`/`Space` on step-info → collapse; `Tab` into log region; tab bar navigation if present |
| **Data requirements** | All log entries for this step; step status for conditional tab display |
| **Transitions** | Click step-info → `collapsed`; click "Request" tab → `showing_request`; click "Response" tab → `showing_response` |
| **Error recovery** | N/A |
| **Animation** | Expand: `height 0→auto`, `opacity 0→1`, 200ms ease-out; chevron: `rotate(0)→rotate(90deg)` 200ms |

### `C10.detail.showing_request`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.detail[N].showing_request` |
| **Entry conditions** | User clicks "Request" tab in expanded detail panel (only available for completed/failed steps) |
| **Exit conditions** | Click "Log" tab → `C10.detail[N].expanded`; click "Response" tab → `C10.detail[N].showing_response`; click step-info → `C10.detail[N].collapsed` |
| **Visual description** | Detail panel shows formatted HTTP request: method, URL, headers (sanitized — no auth tokens), body (pretty-printed JSON). Monospace font. Syntax-highlighted. |
| **Active DOM elements** | `.step-detail__request` visible; "Request" tab active (underlined); `.code-block` with request data; copy button in corner |
| **Keyboard shortcuts** | `Tab` between tab items; `Enter`/`Space` to switch tabs; copy button focusable |
| **Data requirements** | Stored request metadata: `{ method, url, headers (redacted), body }` |
| **Transitions** | Tab clicks navigate between views; collapse returns to collapsed |
| **Error recovery** | If request data unavailable (e.g., network error before send), show "Request data not available" |
| **Animation** | Tab content: `fadeIn` 150ms cross-fade between tabs |

### `C10.detail.showing_response`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.detail[N].showing_response` |
| **Entry conditions** | User clicks "Response" tab in expanded detail (only for completed/failed steps with a response) |
| **Exit conditions** | Click "Log" tab → `expanded`; click "Request" tab → `showing_request`; collapse → `collapsed` |
| **Visual description** | Detail panel shows HTTP response: status code with color badge (green for 2xx, red for 4xx/5xx), response headers (select headers), body (pretty-printed JSON). Monospace font. |
| **Active DOM elements** | `.step-detail__response` visible; "Response" tab active; `.code-block` with response data; status badge colored by HTTP category; copy button |
| **Keyboard shortcuts** | Same as showing_request |
| **Data requirements** | Stored response: `{ status, statusText, headers (select), body (truncated to 10KB max for display) }` |
| **Transitions** | Tab clicks; collapse |
| **Error recovery** | If response body > 10KB, truncate with "... (truncated, full response logged to console)" |
| **Animation** | Same tab cross-fade as showing_request |

### `C10.detail.showing_error`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.detail[N].showing_error` |
| **Entry conditions** | Step transitions to `failed` — auto-expands to error view |
| **Exit conditions** | Click step-info → `C10.detail[N].collapsed`; retry starts → detail collapses and step resets |
| **Visual description** | Detail panel in error mode: red-tinted background, error category badge, human-readable message, collapsible raw error details, retry count shown. |
| **Active DOM elements** | `.step-detail--error` visible; `.error-category` badge; `.error-message` text; `.error-raw` collapsible; `.error-retry-info` showing attempt count |
| **Keyboard shortcuts** | `Enter`/`Space` — collapse; `Tab` to error elements |
| **Data requirements** | `errorCategory`, `errorMessage`, `httpStatus`, `rawResponse`, `retryCount`, `maxRetries` |
| **Transitions** | Collapse click → `collapsed`; retry resets entire step |
| **Error recovery** | This IS the error recovery display |
| **Animation** | Auto-expand: `height 0→auto` 300ms; error background: red tint `opacity 0→0.08` 200ms; error icon: `shake` 200ms |

---

## C10-SM4: Timer (3 states)

### `C10.timer.ticking`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.timer.ticking` |
| **Entry conditions** | Pipeline enters `executing` |
| **Exit conditions** | Pipeline enters `succeeded`, `failed`, `rolled_back`, or `rollback_failed` → `C10.timer.stopped`; pipeline minimized — timer CONTINUES (stays ticking) |
| **Visual description** | Timer in header counting up: "0:00" → "0:01" → etc. Uses `tabular-nums` for stable layout. Accent color (purple) while ticking. Updates every 100ms for smooth display. |
| **Active DOM elements** | `.pipeline-header__timer` with class `--running`; `role="timer"` with `aria-live="off"` (too frequent for screen readers) |
| **Keyboard shortcuts** | None — display only |
| **Data requirements** | `startTime = performance.now()`; `setInterval` at 100ms; formatted as `M:SS.s` or `M:SS` |
| **Transitions** | Pipeline terminal state → `C10.timer.stopped` |
| **Error recovery** | If `performance.now()` unavailable, fallback to `Date.now()` |
| **Animation** | Subtle accent color pulse on seconds change (optional, respects prefers-reduced-motion) |

### `C10.timer.paused`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.timer.paused` |
| **Entry conditions** | N/A — timer does NOT pause when minimized (execution continues). This state exists only for the retry gap between `failed` and `retrying` |
| **Exit conditions** | Retry begins → `C10.timer.ticking` (timer resets for retry run) |
| **Visual description** | Timer shows last elapsed value, no longer ticking. Muted text color. |
| **Active DOM elements** | `.pipeline-header__timer` without `--running` class; showing frozen value |
| **Keyboard shortcuts** | None |
| **Data requirements** | Frozen elapsed value |
| **Transitions** | Retry → `ticking` (reset); destroy → cleaned up |
| **Error recovery** | N/A |
| **Animation** | Color: accent → muted, 200ms transition |

### `C10.timer.stopped`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.timer.stopped` |
| **Entry conditions** | Pipeline reaches any terminal state (`succeeded`, `failed`, `rolled_back`, `rollback_failed`) |
| **Exit conditions** | None — terminal |
| **Visual description** | Timer shows final elapsed time. Text color: green for success, red for failure, neutral for rollback. "Total: 25.3s" format. |
| **Active DOM elements** | `.pipeline-header__timer` with `--stopped` class and status-colored text; `setInterval` cleared |
| **Keyboard shortcuts** | None |
| **Data requirements** | Final elapsed value; pipeline terminal status for color |
| **Transitions** | None — terminal |
| **Error recovery** | N/A |
| **Animation** | None (static final display) |

---

## C10-SM5: Minimize / Restore Viewport (4 states)

### `C10.viewport.full_view`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.viewport.full_view` |
| **Entry conditions** | Pipeline page initially shown; OR restored from badge |
| **Exit conditions** | User clicks X during execution → `C10.viewport.transitioning_to_badge`; `Escape` during execution → `C10.viewport.transitioning_to_badge` |
| **Visual description** | Full wizard dialog with pipeline visible. All steps, header, footer visible. Wizard overlay active. |
| **Active DOM elements** | `.infra-wizard-dialog` visible (`display: block`); `.floating-badge` hidden (`display: none`); full pipeline DOM rendered |
| **Keyboard shortcuts** | All pipeline shortcuts active; `Escape` during execution → minimize |
| **Data requirements** | Full pipeline state rendered in DOM |
| **Transitions** | X/Escape during execution → `transitioning_to_badge`; post-execution close → destroyed (NOT minimize) |
| **Error recovery** | N/A |
| **Animation** | None (normal state) |

### `C10.viewport.transitioning_to_badge`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.viewport.transitioning_to_badge` |
| **Entry conditions** | User clicks close (X) or presses Escape while pipeline is executing |
| **Exit conditions** | Animation completes → `C10.viewport.badge_view` |
| **Visual description** | Wizard dialog shrinks/fades while badge pill appears. Dialog: `scale(1)→scale(0.95)`, `opacity 1→0`. Badge: `scale(0.8)→scale(1)`, `opacity 0→1`. Happens concurrently. |
| **Active DOM elements** | Both wizard and badge briefly visible during crossfade; wizard has `pointer-events: none` |
| **Keyboard shortcuts** | None — transitional (~300ms) |
| **Data requirements** | Current step name and index for badge label; pipeline status |
| **Transitions** | Animation end → `C10.viewport.badge_view` |
| **Error recovery** | If animation interrupted, snap to badge_view immediately |
| **Animation** | Dialog: `opacity 1→0`, `transform scale(1)→scale(0.95)`, 300ms ease-in; Badge: `opacity 0→1`, `transform scale(0.8)→scale(1)`, 300ms ease-out, 100ms delay |

### `C10.viewport.badge_view`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.viewport.badge_view` |
| **Entry conditions** | Minimize transition completes |
| **Exit conditions** | User clicks badge → `C10.viewport.transitioning_to_full`; pipeline completes while minimized → badge shows completion state |
| **Visual description** | Small floating pill/badge in bottom-right corner showing: "Step 3/6 — Creating Lakehouse ◐". Badge updates as steps progress. On failure: red badge with "Step 3/6 — Failed ✕". On success: green badge with "Done! Click to view". |
| **Active DOM elements** | `.floating-badge` visible, positioned `fixed` bottom-right; `.infra-wizard-dialog` hidden (`display: none`); badge shows step count, current step name, spinner/status icon |
| **Keyboard shortcuts** | `Enter`/`Space` on badge → restore to full view; badge is focusable with `tabindex="0"` |
| **Data requirements** | Live pipeline state updates reflected on badge: `activeStepIndex`, `stepName`, `status`; callback from pipeline on state change updates badge label |
| **Transitions** | Badge click → `C10.viewport.transitioning_to_full`; pipeline succeeds → badge updates to "Done" (remains badge until clicked); pipeline fails → badge shows error state |
| **Error recovery** | Badge always shows current truth. If pipeline state changes while user isn't looking, badge reflects it immediately |
| **Animation** | Badge step transitions: text crossfade 200ms; spinner on badge: `spin 800ms linear infinite` (smaller, 12px); success: badge `background-color` transition to green 300ms; failure: badge pulse red 200ms |

### `C10.viewport.transitioning_to_full`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.viewport.transitioning_to_full` |
| **Entry conditions** | User clicks the floating badge |
| **Exit conditions** | Animation completes → `C10.viewport.full_view` |
| **Visual description** | Badge shrinks/fades while wizard dialog appears. Reverse of minimize animation. |
| **Active DOM elements** | Both badge and wizard briefly visible; badge has `pointer-events: none` |
| **Keyboard shortcuts** | None — transitional (~300ms) |
| **Data requirements** | Full pipeline DOM preserved (was `display:none`, not destroyed) |
| **Transitions** | Animation end → `C10.viewport.full_view` |
| **Error recovery** | If interrupted, snap to full_view |
| **Animation** | Badge: `opacity 1→0`, `scale(1)→scale(0.8)`, 300ms ease-in; Dialog: `opacity 0→1`, `scale(0.95)→scale(1)`, 300ms ease-out, 100ms delay |

---

## C10-SM6: Footer Panel (5 states)

### `C10.footer.hidden`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.footer.hidden` |
| **Entry conditions** | Pipeline in `idle` or `executing` state — no footer needed |
| **Exit conditions** | Pipeline succeeds → `C10.footer.show_success`; pipeline fails → `C10.footer.show_retry`; rollback completes → `C10.footer.show_rollback_result` |
| **Visual description** | No footer panel visible. Full pipeline step list occupies the vertical space. |
| **Active DOM elements** | `.pipeline-summary` with `display: none` |
| **Keyboard shortcuts** | N/A — not present |
| **Data requirements** | None |
| **Transitions** | Pipeline terminal state changes → appropriate footer state |
| **Error recovery** | N/A |
| **Animation** | N/A |

### `C10.footer.show_success`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.footer.show_success` |
| **Entry conditions** | Pipeline reaches `succeeded` |
| **Exit conditions** | "Navigate to Workspace" → `C10.footer.navigating`; "Create Another" → wizard reset; close → destroyed |
| **Visual description** | Green-tinted summary panel: "Environment created successfully! Total: 25.3s". Two buttons: "Navigate to Workspace" (primary, accented) and "Create Another" (secondary, ghost). |
| **Active DOM elements** | `.pipeline-summary--success` visible; `.navigate-btn` (focused by default); `.create-another-btn`; total time display |
| **Keyboard shortcuts** | `Tab` between buttons; `Enter`/`Space` to activate |
| **Data requirements** | `totalElapsed`, `workspaceUrl`, all artifacts for navigation |
| **Transitions** | Navigate click → `C10.footer.navigating`; Create Another → wizard reset |
| **Error recovery** | N/A |
| **Animation** | Footer: `slideUp` from below pipeline, `opacity 0→1`, 300ms ease-out; buttons: `fadeIn` 200ms, 100ms delay after footer |

### `C10.footer.show_retry`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.footer.show_retry` |
| **Entry conditions** | Pipeline reaches `failed` |
| **Exit conditions** | Retry click → `C10.footer.hidden` (footer hides during re-execution); Rollback click → `C10.footer.hidden`; "Go Back" → wizard Page 1 |
| **Visual description** | Error panel with red-tinted border. Error message, category badge, suggested action text. Buttons: "Retry from Step N" (primary, if retryable), "Rollback & Start Over" (danger), "Go Back to Page 1" (if applicable, e.g., name conflict). |
| **Active DOM elements** | `.error-panel` visible; `.retry-btn` (focused if retryable, `disabled` if max retries hit or non-retryable); `.rollback-btn` (danger styling); `.go-back-btn` (conditional); error category badge; raw error details collapsible |
| **Keyboard shortcuts** | `Tab` between action buttons; `Enter`/`Space` to activate; `Escape` to minimize |
| **Data requirements** | `errorCategory`, `errorMessage`, `failedStepIndex`, `failedStepName`, `isRetryable`, `pipelineRetryCount`, `maxRetries` |
| **Transitions** | Retry → `hidden`; Rollback → `hidden`; Go Back → wizard Page 1 |
| **Error recovery** | This IS the error recovery panel. Shows category-specific suggestions |
| **Animation** | Panel: `slideDown` 300ms ease-out; error badge: `fadeIn` 200ms |

### `C10.footer.show_rollback_result`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.footer.show_rollback_result` |
| **Entry conditions** | Pipeline reaches `rolled_back` or `rollback_failed` |
| **Exit conditions** | "Start Over" → wizard Page 1 reset; "Try Again" (if rollback failed) → `C10.footer.hidden`; close → destroyed |
| **Visual description** | For `rolled_back`: neutral summary "All resources cleaned up." with "Start Over" button. For `rollback_failed`: amber warning panel listing failed deletions with manual cleanup links and "Try Again" button. |
| **Active DOM elements** | `.rollback-summary` (success) or `.rollback-warning` (failure); appropriate action buttons; resource deletion result list (if partial failure) |
| **Keyboard shortcuts** | `Tab` between buttons; `Enter`/`Space` to activate |
| **Data requirements** | `rollbackResults` per resource; resource display names and portal URLs |
| **Transitions** | Start Over → wizard reset; Try Again → re-rollback; close → destroyed |
| **Error recovery** | Failed deletions show portal links for manual cleanup |
| **Animation** | Same as show_success/show_retry: `slideUp` 300ms |

### `C10.footer.navigating`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C10.footer.navigating` |
| **Entry conditions** | User clicks "Navigate to Workspace" in success footer |
| **Exit conditions** | Navigation succeeds → wizard closes; navigation fails → return to `show_success` |
| **Visual description** | Navigate button shows spinner and "Opening..." text. Button disabled during navigation. Wizard about to close. |
| **Active DOM elements** | `.navigate-btn` with spinner, `aria-busy="true"`, disabled; other buttons disabled |
| **Keyboard shortcuts** | None — brief transitional state |
| **Data requirements** | `workspaceUrl` for navigation; EventBus emission to workspace explorer |
| **Transitions** | Navigate success → wizard destroyed, workspace explorer opens; navigate failure → `show_success` (with error toast) |
| **Error recovery** | If navigation fails (e.g., workspace URL invalid), show toast error and return to success footer |
| **Animation** | Button spinner: same `spin 800ms` as pipeline steps; button text crossfade: "Navigate to Workspace" → "Opening..." 200ms |

---

**C10 Total: 31 state definitions** (8 pipeline + 7 step (x6 instances) + 5 detail (x6 instances) + 3 timer + 4 viewport + 5 footer = 31 unique state types, 97 state instances when multiplied across 6 steps)

---

# C12 — TemplateManager (18 states)

Four sub-machines governing the template list, save dialog, load flow, and delete flow.

## C12-SM1: Template List (4 states)

### `C12.list.loading`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.list.loading` |
| **Entry conditions** | Load Template dialog opens and fires `GET /api/templates/list`; or dialog re-opened after error |
| **Exit conditions** | Response received with templates → `C12.list.loaded`; response received with empty array → `C12.list.empty`; request fails → `C12.list.error` |
| **Visual description** | Dialog open with 3 skeleton placeholder rows pulsing. Search input disabled. Cancel button enabled. No template items visible. |
| **Active DOM elements** | `.template-list-dialog` visible; `.skeleton-row` x3 with pulse animation (`opacity 0.5↔1`, 1000ms ease-in-out infinite); `.search-input` disabled, `aria-busy="true"`; cancel button enabled; close (X) enabled |
| **Keyboard shortcuts** | `Escape` — close dialog; `Tab` — Cancel → Close; search input disabled |
| **Data requirements** | `GET /api/templates/list` in-flight; abort controller for cancel |
| **Transitions** | Templates returned → `loaded`; empty array → `empty`; network/server error → `error` |
| **Error recovery** | Request timeout after 10s → auto-transition to `error` with timeout message |
| **Animation** | Skeleton pulse: `opacity 0.5→1→0.5`, 1000ms ease-in-out infinite; dialog entrance: `opacity 0→1`, `scale(0.95)→scale(1)`, 200ms |

### `C12.list.loaded`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.list.loaded` |
| **Entry conditions** | `GET /api/templates/list` returned array with >= 1 template |
| **Exit conditions** | User deletes all templates → `C12.list.empty`; dialog closed → inactive; network error on re-fetch → `C12.list.error` |
| **Visual description** | Template list visible with search input at top. Each template row shows: name (bold), date, node count, theme, and [Load] / [✕ Delete] buttons. Search filters in real-time. Selected item has highlight. |
| **Active DOM elements** | `.template-list` with `role="listbox"`; `.template-item` x N with `role="option"`; `.search-input` enabled, focused; per-item `.load-btn` and `.delete-btn`; cancel button; close button |
| **Keyboard shortcuts** | `Arrow Down`/`Up` — navigate list items; `Home`/`End` — first/last item; `Enter` on item — load template; `Delete` on item — open delete confirmation; `Escape` — close dialog; typing in search — filters list |
| **Data requirements** | Template array: `[{ id, name, description, createdAt, nodeCount, theme, connectionCount }]`; search filter string |
| **Transitions** | Load click → triggers `C12.load` sub-machine; Delete click → triggers `C12.delete` sub-machine; search typing → filters list (stays `loaded`); all templates deleted → `empty`; close → inactive |
| **Error recovery** | If template data is stale, show "Refresh" link. Search with no matches shows "No templates match" (not `empty` state) |
| **Animation** | Template items: `fadeIn` stagger 50ms per item, 150ms each; search results: instant filter (no animation); list item hover: `background-color` transition 150ms |

### `C12.list.empty`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.list.empty` |
| **Entry conditions** | `GET /api/templates/list` returned empty array; or user deleted the last template |
| **Exit conditions** | Dialog closed → inactive |
| **Visual description** | Empty state illustration (or text-only): "No saved templates yet. Create your first environment, then save it as a template from the Review page." No search input (nothing to search). |
| **Active DOM elements** | `.template-list-empty` visible; `.empty-message` text; cancel/close buttons only; no search input; no list items |
| **Keyboard shortcuts** | `Escape` — close; `Tab` — Cancel → Close |
| **Data requirements** | None — empty state |
| **Transitions** | Close → inactive (dialog hidden) |
| **Error recovery** | N/A |
| **Animation** | Empty state text: `fadeIn` 200ms |

### `C12.list.error`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.list.error` |
| **Entry conditions** | `GET /api/templates/list` failed (network error, server error, corrupt file) |
| **Exit conditions** | "Try Again" click → `C12.list.loading`; close dialog → inactive; auto-recover after 3s → `idle` (TemplateManager state) |
| **Visual description** | Error message in dialog body: "Could not load templates: {error}". "Try Again" button. Red-tinted error text. No skeleton, no list. |
| **Active DOM elements** | `.template-list-error` visible; `.error-message` with `role="alert"`; "Try Again" button (focused); cancel/close buttons |
| **Keyboard shortcuts** | `Escape` — close; `Enter`/`Space` on Try Again → retry; `Tab` — Try Again → Cancel → Close |
| **Data requirements** | Error code, error message from failed request |
| **Transitions** | Try Again → `loading`; close → inactive; 3s auto-recover on TemplateManager state machine |
| **Error recovery** | Shows human-readable error. For corrupt file: "Template file appears corrupted. You may need to delete edog-templates.json and start fresh." |
| **Animation** | Error text: `fadeIn` 200ms; Try Again button: standard button styling |

---

## C12-SM2: Save Dialog (7 states)

### `C12.save.closed`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.save.closed` |
| **Entry conditions** | Default state; or dialog dismissed after save/cancel |
| **Exit conditions** | User clicks "Save as Template" on C9-ReviewSummary → `C12.save.open` |
| **Visual description** | No dialog visible. No overlay. |
| **Active DOM elements** | `.save-dialog` not in DOM or `display: none` |
| **Keyboard shortcuts** | None from this component |
| **Data requirements** | None |
| **Transitions** | "Save as Template" click → `C12.save.open` |
| **Error recovery** | N/A |
| **Animation** | N/A |

### `C12.save.open`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.save.open` |
| **Entry conditions** | User clicks "Save as Template" on Review page |
| **Exit conditions** | User starts typing → `C12.save.naming`; user clicks Cancel / Escape → `C12.save.closed` |
| **Visual description** | Save dialog visible with backdrop blur. Name input empty and focused. Description input empty. Summary section showing current DAG stats (node count, connections, theme). Cancel and Save buttons visible. Save button disabled (name empty). |
| **Active DOM elements** | `.save-dialog` visible with `role="dialog"`, `aria-modal="true"`; backdrop (`oklch(0 0 0 / 0.5)`, `backdrop-filter: blur(4px)`); `.name-input` focused, empty; `.description-input` empty; `.save-summary` with DAG stats; Save button disabled; Cancel and Close enabled; focus trap active |
| **Keyboard shortcuts** | `Escape` — close dialog; `Tab` — cycle: name → description → Cancel → Save → Close; `Enter` in name field — submit (if valid) |
| **Data requirements** | Current wizard state summary: nodeCount, connectionCount, theme, schemas (for summary section) |
| **Transitions** | Typing in name → `naming`; Cancel/Escape/Close → `closed` |
| **Error recovery** | N/A |
| **Animation** | Dialog: `opacity 0→1`, `scale(0.95)→scale(1)`, 200ms; backdrop: `opacity 0→0.5`, 200ms linear |

### `C12.save.naming`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.save.naming` |
| **Entry conditions** | User types in name input field |
| **Exit conditions** | Name passes validation → Save button enabled (stays `naming`); name fails validation → `C12.save.name_invalid`; user clicks Save with valid name → `C12.save.saving`; Cancel/Escape → `C12.save.closed` |
| **Visual description** | Name input has text. Character counter shows "N/64". Real-time validation feedback. Save button enabled when name is valid (1-64 chars, valid chars). No error messages visible. |
| **Active DOM elements** | `.name-input` with value; `.char-count` showing "N/64" with `aria-live="polite"` (debounced 500ms); Save button enabled (if valid); no error messages |
| **Keyboard shortcuts** | `Enter` — submit if valid; `Escape` — close dialog; typing continues validation |
| **Data requirements** | Name validation rules: 1-64 chars, alphanumeric + spaces + hyphens + underscores, trimmed, no leading/trailing spaces |
| **Transitions** | Invalid input → `name_invalid`; Save click with valid name → `saving`; Cancel → `closed` |
| **Error recovery** | Validation is real-time — errors appear as user types, disappear as fixed |
| **Animation** | Character counter: smooth number transition; Save button enable: `opacity` transition 150ms |

### `C12.save.name_invalid`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.save.name_invalid` |
| **Entry conditions** | Name input fails validation: empty, too long (>64), invalid characters, duplicate name (without overwrite), or reserved name |
| **Exit conditions** | User fixes name → `C12.save.naming`; Cancel/Escape → `C12.save.closed` |
| **Visual description** | Name input with red border. Error message below input in danger color: "Template name already exists", "Name must be 1-64 characters", "Invalid characters", etc. Save button disabled. Character counter shows red if >64. |
| **Active DOM elements** | `.name-input` with `.input--error` class, `aria-invalid="true"`, `aria-describedby="name-error"`; `.name-error` visible with `role="alert"`; Save button disabled; `.char-count` red if over limit |
| **Keyboard shortcuts** | Same as `naming` — continue typing to fix |
| **Data requirements** | Validation error type and message |
| **Transitions** | Fix name → `naming`; Cancel → `closed` |
| **Error recovery** | For duplicate name: show "Template 'X' already exists (saved July 15, 2025). Overwrite?" with checkbox |
| **Animation** | Error message: `slideDown` 150ms, `fadeIn`; input border: instant red transition; `shake` on submit attempt with invalid name: translateX 2px oscillation 200ms |

### `C12.save.saving`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.save.saving` |
| **Entry conditions** | User clicks Save (or Enter) with valid name; `POST /api/templates/save` in-flight |
| **Exit conditions** | Save succeeds → `C12.save.saved`; save fails → `C12.save.save_error` |
| **Visual description** | Save button shows inline spinner, text "Saving...", disabled. All other inputs disabled. Dialog remains open to prevent double-submit. Backdrop click disabled. |
| **Active DOM elements** | Save button: spinner + "Saving...", `aria-busy="true"`, `disabled`; name/description inputs: `disabled`; Cancel: `disabled`; close (X): `disabled`; TemplateManager state machine: `saving` |
| **Keyboard shortcuts** | `Escape` — blocked (save in progress); all inputs disabled |
| **Data requirements** | `POST /api/templates/save` payload with name, description, wizard state snapshot; AbortController (not user-cancellable but for cleanup) |
| **Transitions** | 200 OK → `saved`; error → `save_error` |
| **Error recovery** | Request timeout after 10s → `save_error` with timeout message |
| **Animation** | Save button spinner: `rotate(0)→rotate(360deg)`, 600ms linear infinite; button text crossfade: "Save Template" → "Saving..." 150ms |

### `C12.save.saved`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.save.saved` |
| **Entry conditions** | `POST /api/templates/save` returned 200 OK |
| **Exit conditions** | Auto-transition → `C12.save.closed` (dialog closes); toast auto-dismisses after 3s |
| **Visual description** | Dialog closes immediately. Success toast appears bottom-center: "Template 'My Layout' saved" with green accent. Toast auto-dismisses after 3s. |
| **Active DOM elements** | `.save-dialog` closing (animation); `.toast--success` visible with `role="status"`, `aria-live="polite"` |
| **Keyboard shortcuts** | Toast is not focusable (informational only); underlying wizard regains focus |
| **Data requirements** | Saved template name for toast message; `template:saved` event emitted |
| **Transitions** | Auto → `closed` (dialog); toast auto-dismiss 3s |
| **Error recovery** | N/A — success |
| **Animation** | Dialog close: `opacity 1→0`, `scale(1)→scale(0.95)`, 150ms; toast: `translateY(8px)→0`, `opacity 0→1`, 200ms enter; `opacity 1→0`, 150ms exit at 3s |

### `C12.save.save_error`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.save.save_error` |
| **Entry conditions** | `POST /api/templates/save` failed (network, server, disk full, permission) |
| **Exit conditions** | User retries (clicks Save again after re-enabling) → `C12.save.saving`; user cancels → `C12.save.closed` |
| **Visual description** | Dialog stays open. Red error message below the save button: "Could not save template: {error}". Save button re-enabled (for retry). Inputs re-enabled. |
| **Active DOM elements** | `.save-error` visible with `role="alert"`; Save button re-enabled; inputs re-enabled; name field retains value |
| **Keyboard shortcuts** | Same as `naming` — user can edit and retry; `Escape` to close |
| **Data requirements** | Error code, human-readable message |
| **Transitions** | Retry (Save click) → `saving`; Cancel/Escape → `closed`; edit name → `naming` |
| **Error recovery** | For disk-full: "Template file could not be written. Check available disk space." For permission: "Permission denied writing to project directory." |
| **Animation** | Error message: `slideDown` 200ms; Save button: re-enable with `opacity 0.5→1` 150ms |

---

## C12-SM3: Load Flow (4 states)

### `C12.load.idle`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.load.idle` |
| **Entry conditions** | Default state; or load completed/cancelled |
| **Exit conditions** | User clicks [Load] on a template item → `C12.load.loading_template` (if no dirty state) or `C12.load.confirm_dirty` (if wizard has unsaved changes) |
| **Visual description** | Template list dialog showing items. No loading indicator on any item. All [Load] buttons enabled. |
| **Active DOM elements** | Template list items with enabled [Load] buttons |
| **Keyboard shortcuts** | `Enter` on selected list item → load; standard list navigation |
| **Data requirements** | Current wizard dirty state flag (`wizardShell.isDirty()`) |
| **Transitions** | Load click (clean state) → `loading_template`; Load click (dirty state) → `confirm_dirty` |
| **Error recovery** | N/A |
| **Animation** | N/A |

### `C12.load.confirm_dirty`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.load.confirm_dirty` |
| **Entry conditions** | User clicks Load on a template while wizard has unsaved changes (dirty state) |
| **Exit conditions** | "Load Anyway" → `C12.load.loading_template`; "Cancel" → `C12.load.idle` |
| **Visual description** | Confirmation dialog overlaid on template list: "You have unsaved changes. Loading a template will replace your current configuration. This cannot be undone." [Cancel] [Load Anyway] buttons. Cancel is auto-focused (safe default). |
| **Active DOM elements** | `.confirm-dialog` with `role="alertdialog"`; "Cancel" button (focused); "Load Anyway" button (danger style); backdrop over template list |
| **Keyboard shortcuts** | `Escape` → cancel (back to idle); `Enter`/`Space` on focused button; `Tab` between Cancel and Load Anyway |
| **Data requirements** | Template to load (stored in pending state); dirty state confirmation |
| **Transitions** | Load Anyway → `loading_template`; Cancel → `idle`; Escape → `idle` |
| **Error recovery** | N/A — user decision gate |
| **Animation** | Confirmation dialog: `opacity 0→1`, `scale(0.95)→scale(1)`, 200ms; backdrop: `opacity 0→0.3`, 200ms |

### `C12.load.loading_template`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.load.loading_template` |
| **Entry conditions** | User confirmed load (from clean state or after dirty confirmation); `GET /api/templates/get?id={id}` in-flight |
| **Exit conditions** | Load succeeds → `C12.load.loaded`; load fails → `C12.load.idle` (with error toast) |
| **Visual description** | Selected template item shows inline loading spinner. [Load] button replaced with spinner. Other items dimmed. Template list dialog remains open. |
| **Active DOM elements** | Selected `.template-item` with loading spinner replacing Load button; other items: `opacity 0.5`, `pointer-events: none`; TemplateManager state: `loading-template` |
| **Keyboard shortcuts** | `Escape` — blocked during load; other navigation disabled |
| **Data requirements** | Template ID; full template data response (node topology, connections, theme, schemas, names) |
| **Transitions** | Success → `loaded`; error → `idle` (with error toast) |
| **Error recovery** | Network error: show error toast, return to idle, re-enable list. Corrupt template: show "Template data is invalid" error, suggest delete |
| **Animation** | Load spinner on item: `spin 600ms linear infinite`; other items dim: `opacity 1→0.5` 200ms |

### `C12.load.loaded`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.load.loaded` |
| **Entry conditions** | Template data successfully fetched and applied to wizard state |
| **Exit conditions** | Auto-transition — dialog closes, wizard pages populated |
| **Visual description** | Template list dialog closes. Success toast: "Template 'X' loaded". Wizard pages 1-4 populated with template data. If on Page 3, DAG canvas triggers auto-layout for loaded nodes. |
| **Active DOM elements** | Dialog closing; toast appearing; wizard pages updating with template values |
| **Keyboard shortcuts** | Toast not focusable; wizard regains focus on active page |
| **Data requirements** | Applied template data; all wizard pages updated: infrastructure names (Page 1), theme/schemas (Page 2), DAG topology (Page 3), review updates (Page 4) |
| **Transitions** | Auto → `idle`; template data applied to WizardShell state; dialog closed; toast shown; auto-layout triggered if on Page 3 |
| **Error recovery** | If template references schemas not configured, show warning toast and load what's valid |
| **Animation** | Dialog close: 150ms; toast: same as save success; canvas nodes: auto-layout animation (delegated to C13) |

---

## C12-SM4: Delete Flow (3 states)

### `C12.delete.idle`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.delete.idle` |
| **Entry conditions** | Default state; or delete completed/cancelled |
| **Exit conditions** | User clicks [✕] delete button on a template item → `C12.delete.confirming` |
| **Visual description** | Template list shown normally. Delete buttons (✕) visible on each item. |
| **Active DOM elements** | Per-item `.delete-btn` with `aria-label="Delete template: {name}"` |
| **Keyboard shortcuts** | `Delete` key on selected list item → open confirmation |
| **Data requirements** | Template list loaded |
| **Transitions** | Delete click → `confirming` |
| **Error recovery** | N/A |
| **Animation** | N/A |

### `C12.delete.confirming`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.delete.confirming` |
| **Entry conditions** | User clicks delete button or presses Delete key on a template item |
| **Exit conditions** | "Delete" confirmed → `C12.delete.deleting`; "Cancel" → `C12.delete.idle` |
| **Visual description** | Confirmation dialog: "Delete template 'X'? This action cannot be undone." with template metadata (date, node count). [Cancel] (focused, safe default) and [Delete] (danger red) buttons. |
| **Active DOM elements** | `.delete-confirm-dialog` with `role="alertdialog"`, `aria-describedby` pointing to warning text; "Cancel" button (auto-focused); "Delete" button (danger styling: red background) |
| **Keyboard shortcuts** | `Escape` → cancel; `Enter`/`Space` on focused button; `Tab` between buttons |
| **Data requirements** | Template ID and name for confirmation message |
| **Transitions** | Confirm → `deleting`; Cancel/Escape → `idle` |
| **Error recovery** | N/A — user decision gate |
| **Animation** | Dialog: standard `opacity` + `scale` entrance 200ms |

### `C12.delete.deleting`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C12.delete.deleting` |
| **Entry conditions** | User confirmed deletion; `POST /api/templates/delete` in-flight |
| **Exit conditions** | Delete succeeds → `C12.delete.idle` (item removed from list, success toast); delete fails → `C12.delete.idle` (error toast) |
| **Visual description** | Confirmation dialog: Delete button shows spinner, text "Deleting...", disabled. Cancel disabled. |
| **Active DOM elements** | Delete button: spinner + "Deleting...", disabled, `aria-busy="true"`; Cancel: disabled |
| **Keyboard shortcuts** | Blocked — operation in progress |
| **Data requirements** | Template ID; `POST /api/templates/delete` in-flight |
| **Transitions** | Success → `idle` (item removed with collapse animation, list refreshes); error → `idle` (error toast, item remains) |
| **Error recovery** | Network error: dismiss dialog, show error toast, item stays in list. Server error: same. User can retry |
| **Animation** | Delete spinner: `rotate` 600ms infinite; on success: confirmation dialog closes 150ms; list item: `opacity 1→0`, `height auto→0`, `margin auto→0` 200ms collapse; toast: standard enter animation |

---

**C12 Total: 18 states** (4 list + 7 save + 4 load + 3 delete)

---

# C13 — AutoLayoutEngine (12 states)

Three concurrent sub-machines: layout operation lifecycle, animation choreography, and viewport fitting.

## C13-SM1: Layout Lifecycle (5 states)

### `C13.layout.idle`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.layout.idle` |
| **Entry conditions** | Canvas initialized; or layout completed; or layout errored (auto-return); or animation cancelled |
| **Exit conditions** | User clicks "Auto Arrange" → `C13.layout.calculating`; template loaded → `C13.layout.calculating` |
| **Visual description** | Canvas is static and fully interactive. Nodes at their current positions. "Auto Arrange" button enabled in toolbar. No layout indicators. |
| **Active DOM elements** | "Auto Arrange" button enabled; all canvas interaction enabled (drag, connect, select, zoom, pan); `#layoutInProgress = false` |
| **Keyboard shortcuts** | All canvas shortcuts active. No layout-specific keys |
| **Data requirements** | Current node positions and dimensions; edge list; canvas viewport state |
| **Transitions** | "Auto Arrange" click (graph >= 2 nodes) → `calculating`; "Auto Arrange" click (< 2 nodes) → stays `idle` (no-op); template load → `calculating` |
| **Error recovery** | N/A |
| **Animation** | N/A (static) |

### `C13.layout.calculating`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.layout.calculating` |
| **Entry conditions** | "Auto Arrange" clicked or template loaded; `#layoutInProgress = true`; DOM measurement (MEASURING) + Dagre computation (COMPUTING) combined into single blocking phase |
| **Exit conditions** | Layout computation succeeds → `C13.layout.animating`; computation fails → `C13.layout.error` |
| **Visual description** | Very brief (5-50ms). Canvas frozen — node dragging disabled, cursor changes to `wait`. "Auto Arrange" button shows micro-spinner or is disabled. User may not perceive this state at all. |
| **Active DOM elements** | "Auto Arrange" button: disabled with spinner; canvas: `pointer-events: none` on node drag handles; cursor: `progress` on canvas |
| **Keyboard shortcuts** | Canvas shortcuts temporarily suspended; `Escape` queued for animation phase |
| **Data requirements** | All node DOM dimensions via `getBoundingClientRect()`; all edges; Dagre config (TB direction, nodesep: 60, ranksep: 80, margin: 40); cycle detection pass |
| **Transitions** | Dagre success → `animating`; cycle detected → `error`; Dagre throws → `error`; DOM element missing → `error` |
| **Error recovery** | Cycle detection before Dagre: if cycles found, show error "Graph contains cycles" (should not happen in wizard DAG). Missing DOM element: log warning, exclude node from layout |
| **Animation** | Button micro-spinner if computation > 16ms (one frame); otherwise no visible animation |

### `C13.layout.animating`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.layout.animating` |
| **Entry conditions** | Dagre computation completed successfully; animation plan computed |
| **Exit conditions** | All node animations complete → `C13.layout.completed`; user presses Escape → nodes snap to final positions, → `C13.layout.completed` (skip remaining animation) |
| **Visual description** | Nodes animate from current positions to computed positions in a staggered waterfall pattern. Rank 0 (roots) first, then rank 1, etc. Each node moves with spring easing giving a slight overshoot. Edges redraw in real-time following nodes. Canvas drag disabled, zoom/pan still works. |
| **Active DOM elements** | Each `.dag-node` receiving CSS transitions: `transform {duration}ms cubic-bezier(0.34, 1.56, 0.64, 1)` with per-rank delay; node drag handles: `pointer-events: none`; zoom/pan: still enabled; "Auto Arrange" button: disabled |
| **Keyboard shortcuts** | `Escape` — cancel animation (snap to final positions immediately); no other canvas interaction |
| **Data requirements** | `AnimationPlan`: per-node `{ toX, toY, delay, duration }`; rank-based stagger: `delay = rank * 60ms`; `duration = 400ms` per node; `totalDuration = maxRank * 60 + 400`; old positions saved for undo |
| **Transitions** | All `transitionend` events received → `completed`; `Escape` pressed → snap all nodes to final positions, skip to `completed`; all nodes already at target (no movement needed) → `completed` |
| **Error recovery** | `transitionend` timeout safety: if no event received within `totalDuration + 500ms`, force-complete. Prevents stuck state from missed events |
| **Animation** | Per-node: `transform: translate(toX, toY)`, 400ms `cubic-bezier(0.34, 1.56, 0.64, 1)` (spring overshoot); stagger delay: rank * 60ms; edges: `requestAnimationFrame` loop redraws edge paths following node positions during animation; `prefers-reduced-motion`: instant snap, no animation |

### `C13.layout.completed`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.layout.completed` |
| **Entry conditions** | All node animations finished; or Escape cancelled animation (snapped to final) |
| **Exit conditions** | Immediate → `C13.layout.idle` (after pushing undo command and starting viewport fit) |
| **Visual description** | Momentary transition. Nodes at final Dagre-computed positions. About to push `AutoLayoutCommand` to undo stack. About to trigger viewport fit. |
| **Active DOM elements** | Nodes at final positions; CSS transitions removed; canvas about to re-enable interaction |
| **Keyboard shortcuts** | None — instant transition |
| **Data requirements** | Old positions (for undo command) and new positions (from Dagre output) |
| **Transitions** | Immediate → `idle`; push `AutoLayoutCommand(oldPositions, newPositions)` to UndoRedoManager; trigger `C13.viewport` fit sequence; emit `layout:completed` event |
| **Error recovery** | N/A — instantaneous |
| **Animation** | None — transition state |

### `C13.layout.error`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.layout.error` |
| **Entry conditions** | Dagre computation threw; cycle detected; DOM measurement failed |
| **Exit conditions** | Immediate → `C13.layout.idle` (after showing error toast) |
| **Visual description** | Error toast notification appears (red accent): "Auto-arrange failed: {reason}". Canvas unchanged — nodes remain at their pre-layout positions. "Auto Arrange" button re-enabled. |
| **Active DOM elements** | Error toast with `role="alert"`; canvas fully interactive (layout had no effect); button re-enabled |
| **Keyboard shortcuts** | Canvas shortcuts restored immediately |
| **Data requirements** | Error type and message for toast; `layout:error` event emitted |
| **Transitions** | Immediate → `idle`; `#layoutInProgress = false` |
| **Error recovery** | Toast auto-dismisses after 5s. Console logs full error details. Canvas state unchanged — no partial layout applied |
| **Animation** | Toast: `translateY(8px)→0`, `opacity 0→1`, 200ms; auto-dismiss at 5s: `opacity 1→0`, 150ms |

---

## C13-SM2: Animation Choreography (4 states)

### `C13.anim.not_started`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.anim.not_started` |
| **Entry conditions** | Layout idle; or animation completed; or animation cancelled |
| **Exit conditions** | Layout enters `animating` → `C13.anim.in_progress` |
| **Visual description** | No animation running. Nodes static. |
| **Active DOM elements** | No CSS transitions on nodes; no animation frame loop |
| **Keyboard shortcuts** | N/A |
| **Data requirements** | N/A |
| **Transitions** | Layout starts animating → `in_progress` |
| **Error recovery** | N/A |
| **Animation** | N/A |

### `C13.anim.in_progress`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.anim.in_progress` |
| **Entry conditions** | Animation plan applied — CSS transitions set on all nodes with staggered delays |
| **Exit conditions** | All `transitionend` events received → `C13.anim.completed`; `Escape` pressed → `C13.anim.cancelling` |
| **Visual description** | Nodes moving in topological rank order. Roots animate first (delay 0), then rank 1 (delay 60ms), etc. Spring easing provides organic feel with slight overshoot. Edge SVG paths update every animation frame to follow node positions. |
| **Active DOM elements** | Nodes with active CSS transitions; `requestAnimationFrame` loop for edge redraw; `transitionend` listener counting completed nodes |
| **Keyboard shortcuts** | `Escape` → cancel animation |
| **Data requirements** | `pendingAnimations` counter (decremented per `transitionend`); safety timeout: `totalDuration + 500ms` |
| **Transitions** | All nodes done → `completed`; Escape → `cancelling`; timeout → force `completed` |
| **Error recovery** | Safety timeout prevents infinite wait if `transitionend` events are missed (happens with `display:none` or offscreen elements) |
| **Animation** | Per-node: `transform: translate(toX, toY)`, 400ms, `cubic-bezier(0.34, 1.56, 0.64, 1)`; stagger: rank * 60ms; total: (maxRank * 60) + 400ms; edges: `rAF` loop at ~60fps |

### `C13.anim.cancelling`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.anim.cancelling` |
| **Entry conditions** | User pressed `Escape` during animation |
| **Exit conditions** | All nodes snapped to final positions → `C13.anim.completed` (immediate) |
| **Visual description** | Instant snap. All CSS transitions removed. Nodes jump to their final Dagre-computed positions immediately. No smooth motion. Edge paths redrawn once. |
| **Active DOM elements** | All node CSS transitions set to `none`; final `transform` values applied directly; `rAF` loop stopped; `transitionend` listeners removed |
| **Keyboard shortcuts** | N/A — instant |
| **Data requirements** | Final positions from Dagre output; all pending animation state cleared |
| **Transitions** | Immediate → `completed` |
| **Error recovery** | N/A — cleanup state |
| **Animation** | None — instant snap (that's the point of cancel) |

### `C13.anim.completed`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.anim.completed` |
| **Entry conditions** | All nodes reached final positions (animated or snapped) |
| **Exit conditions** | Immediate → `C13.anim.not_started` |
| **Visual description** | Nodes at final positions. CSS transitions cleaned up. Canvas about to re-enable interaction. |
| **Active DOM elements** | All `transition` properties removed from nodes; `rAF` loop stopped; `transitionend` listeners removed |
| **Keyboard shortcuts** | N/A — instant transition |
| **Data requirements** | N/A |
| **Transitions** | Immediate → `not_started` |
| **Error recovery** | N/A |
| **Animation** | N/A |

---

## C13-SM3: Viewport Fit (3 states)

### `C13.viewport.pre_fit`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.viewport.pre_fit` |
| **Entry conditions** | Layout animation completed; viewport fit calculation about to begin |
| **Exit conditions** | Bounding box and zoom/pan computed → `C13.viewport.fitting` |
| **Visual description** | Nodes at final positions. Viewport has not yet adjusted — some nodes may be out of view. |
| **Active DOM elements** | Canvas at pre-layout viewport (zoom/pan unchanged from before layout) |
| **Keyboard shortcuts** | N/A — transitional |
| **Data requirements** | Layout bounding box from Dagre output; current viewport dimensions (`canvasEl.clientWidth/Height`); desired padding (40px) |
| **Transitions** | Fit values computed → `fitting` |
| **Error recovery** | If viewport dimensions are 0 (canvas hidden), skip fit entirely → `fitted` |
| **Animation** | N/A |

### `C13.viewport.fitting`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.viewport.fitting` |
| **Entry conditions** | Fit target computed: `{ scale, translateX, translateY }` to show all nodes with padding |
| **Exit conditions** | Viewport animation completes → `C13.viewport.fitted` |
| **Visual description** | Canvas smoothly zooms and pans to fit all laid-out nodes in view. Smooth zoom transition so user sees the graph settle into view. All nodes visible with comfortable padding. |
| **Active DOM elements** | Canvas transform animating: `transition: transform 500ms cubic-bezier(0.4, 0, 0.2, 1)`; node interaction still disabled (completes before re-enable) |
| **Keyboard shortcuts** | None active during fit; `Escape` — skip fit animation (snap to final viewport) |
| **Data requirements** | Target `scale` (e.g., 0.85), target `translateX`, `translateY`; canvas transform origin |
| **Transitions** | `transitionend` on canvas → `fitted`; `Escape` → snap to fit values → `fitted` |
| **Error recovery** | Same safety timeout as animation: 500ms + buffer. If missed, force-apply |
| **Animation** | Canvas transform: `scale(oldZoom)→scale(fitZoom)`, `translate(oldPan)→translate(fitPan)`, 500ms `ease-out`; `prefers-reduced-motion`: instant snap |

### `C13.viewport.fitted`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C13.viewport.fitted` |
| **Entry conditions** | Viewport animation completed |
| **Exit conditions** | Immediate → `C13.viewport.pre_fit` (ready for next layout) |
| **Visual description** | All nodes visible within viewport with padding. Zoom level comfortable for reading. Canvas fully interactive again. |
| **Active DOM elements** | Canvas at fitted viewport; all interaction re-enabled; `#layoutInProgress = false` |
| **Keyboard shortcuts** | All canvas shortcuts restored |
| **Data requirements** | N/A |
| **Transitions** | Immediate → ready (returns to pre_fit for next cycle) |
| **Error recovery** | N/A |
| **Animation** | N/A |

---

**C13 Total: 12 states** (5 layout + 4 animation + 3 viewport)

---

# C14 — UndoRedoManager (13 states)

Four concurrent sub-machines: stack state, operation state, UI button state, and keyboard listener state.

## C14-SM1: Stack State (4 states)

### `C14.stack.empty`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.stack.empty` |
| **Entry conditions** | Manager initialized; or `clear()` called; or `destroy()` called and re-created; or all undo items undone with no redo |
| **Exit conditions** | `execute(cmd)` → `C14.stack.has_undo_only` |
| **Visual description** | Both undo and redo buttons disabled (dimmed). Tooltips: "Nothing to undo" / "Nothing to redo". No stack depth indicator. |
| **Active DOM elements** | `.dag-undo-btn` disabled, `aria-label="Undo (nothing to undo)"`; `.dag-redo-btn` disabled, `aria-label="Redo (nothing to redo)"` |
| **Keyboard shortcuts** | `Ctrl+Z` — no-op (logged silently); `Ctrl+Y` / `Ctrl+Shift+Z` — no-op |
| **Data requirements** | `undoStack = []`; `redoStack = []`; `canUndo = false`; `canRedo = false` |
| **Transitions** | `execute(cmd)` → `has_undo_only`; `undo()` → stays `empty` (returns false); `redo()` → stays `empty` (returns false); `clear()` → stays `empty` |
| **Error recovery** | Calling undo/redo in empty state returns `false` — caller can check and skip visual feedback |
| **Animation** | N/A — static disabled state |

### `C14.stack.has_undo_only`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.stack.has_undo_only` |
| **Entry conditions** | `execute(cmd)` from any state (clears redo stack); or `redo()` consumed last redo item |
| **Exit conditions** | `undo()` with >1 undo item → `C14.stack.has_both`; `undo()` with 1 undo item → `C14.stack.has_redo_only`; `clear()` → `C14.stack.empty` |
| **Visual description** | Undo button enabled (full contrast). Redo button disabled (dimmed). Undo tooltip shows description of last command: "Undo: Move 'orders' (Ctrl+Z)". |
| **Active DOM elements** | `.dag-undo-btn` enabled, tooltip dynamic; `.dag-redo-btn` disabled; undo button `aria-label="Undo: {description} (Ctrl+Z)"` |
| **Keyboard shortcuts** | `Ctrl+Z` — execute undo; `Ctrl+Y` — no-op (redo empty) |
| **Data requirements** | `undoStack.length >= 1`; `redoStack = []`; `canUndo = true`; `canRedo = false`; top of undo stack for tooltip |
| **Transitions** | `execute(cmd)` → stays `has_undo_only` (push to undo, redo already empty); `undo()` (>1 items) → `has_both`; `undo()` (1 item) → `has_redo_only`; `clear()` → `empty` |
| **Error recovery** | If undo stack at max depth (50) and new command arrives, oldest command evicted silently |
| **Animation** | Undo button enable: `opacity 0.4→1`, color transition 100ms; redo button stays disabled |

### `C14.stack.has_redo_only`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.stack.has_redo_only` |
| **Entry conditions** | All undo items have been undone (undo stack empty, redo stack has items) |
| **Exit conditions** | `redo()` with >1 redo items → `C14.stack.has_both`; `redo()` with 1 redo item → `C14.stack.has_undo_only`; `execute(cmd)` → `C14.stack.has_undo_only` (clears redo — timeline fork) |
| **Visual description** | Undo button disabled. Redo button enabled with tooltip showing next redo: "Redo: Add SQL Table 'customers' (Ctrl+Y)". |
| **Active DOM elements** | `.dag-undo-btn` disabled; `.dag-redo-btn` enabled with dynamic tooltip and `aria-label` |
| **Keyboard shortcuts** | `Ctrl+Z` — no-op; `Ctrl+Y` / `Ctrl+Shift+Z` — execute redo |
| **Data requirements** | `undoStack = []`; `redoStack.length >= 1`; `canUndo = false`; `canRedo = true` |
| **Transitions** | `redo()` (>1) → `has_both`; `redo()` (1) → `has_undo_only`; `execute(cmd)` → `has_undo_only` (redo cleared — timeline fork); `clear()` → `empty` |
| **Error recovery** | Timeline fork: executing new command from `has_redo_only` clears redo permanently. This is intentional (standard editor behavior). No confirmation dialog |
| **Animation** | Redo button enable: `opacity` + color transition 100ms |

### `C14.stack.has_both`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.stack.has_both` |
| **Entry conditions** | `undo()` from `has_undo_only` (moves item to redo); or `redo()` from `has_redo_only` (moves item to undo) |
| **Exit conditions** | `undo()` (last undo item) → `has_redo_only`; `redo()` (last redo item) → `has_undo_only`; `execute(cmd)` → `has_undo_only` (redo cleared); `clear()` → `empty` |
| **Visual description** | Both undo and redo buttons enabled (full contrast). Tooltips show specific next undo/redo actions. Undo stack depth may show in tooltip: "Undo: Move 'orders' (3 more) (Ctrl+Z)". |
| **Active DOM elements** | Both `.dag-undo-btn` and `.dag-redo-btn` enabled with dynamic tooltips and `aria-label`s |
| **Keyboard shortcuts** | `Ctrl+Z` — execute undo; `Ctrl+Y` / `Ctrl+Shift+Z` — execute redo |
| **Data requirements** | `undoStack.length >= 1`; `redoStack.length >= 1`; `canUndo = true`; `canRedo = true` |
| **Transitions** | `undo()` (>1 undo) → stays `has_both`; `undo()` (1 undo) → `has_redo_only`; `redo()` (>1 redo) → stays `has_both`; `redo()` (1 redo) → `has_undo_only`; `execute(cmd)` → `has_undo_only` (redo cleared); `clear()` → `empty` |
| **Error recovery** | Same max-depth eviction. If undo fails mid-execution, see C14-SM2 error handling |
| **Animation** | Both buttons at full opacity; state transitions between sub-states are instant (no animation on button state since already enabled) |

---

## C14-SM2: Operation State (4 states)

### `C14.op.idle`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.op.idle` |
| **Entry conditions** | Manager initialized; or operation completed (undo/redo/execute done) |
| **Exit conditions** | `undo()` → `C14.op.executing_undo`; `redo()` → `C14.op.executing_redo`; `execute(cmd)` → `C14.op.executing_command` |
| **Visual description** | No operation running. Buttons responsive. Canvas interactive. |
| **Active DOM elements** | Buttons reflect stack state (enabled/disabled per C14-SM1); `#isApplying = false` |
| **Keyboard shortcuts** | `Ctrl+Z` and `Ctrl+Y` active (if stack permits) |
| **Data requirements** | `#isApplying = false` — re-entrancy guard off |
| **Transitions** | undo() → `executing_undo`; redo() → `executing_redo`; execute(cmd) → `executing_command` |
| **Error recovery** | N/A |
| **Animation** | N/A |

### `C14.op.executing_undo`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.op.executing_undo` |
| **Entry conditions** | `undo()` called while idle and `canUndo = true` |
| **Exit conditions** | Command's `undo()` method completes → `C14.op.idle`; command throws → `C14.op.idle` (error handled) |
| **Visual description** | Brief (~1-50ms for most commands, up to 300ms for AutoLayoutCommand with animation). Undo button may flash active state. Canvas updates as the command's `undo()` mutates the graph. |
| **Active DOM elements** | `#isApplying = true` — re-entrancy guard active. Any `execute()` calls from DOM mutation event handlers are IGNORED with console.warn. Canvas reflects undo mutation (node removed, position restored, etc.) |
| **Keyboard shortcuts** | `Ctrl+Z` / `Ctrl+Y` blocked (debounced, see 7.6); rapid key repeat queued |
| **Data requirements** | Command popped from undo stack; command's `undo()` method; target DOM elements for mutation |
| **Transitions** | undo() completes → `idle` (command moved to redo stack); undo() throws → `idle` (command discarded, error logged, stack may be corrupted — see error handling) |
| **Error recovery** | If `undo()` throws: log error, emit `undo:error` event, discard command from both stacks (state may be inconsistent). Show toast: "Undo failed: {description}. Some changes may not be reversible." For `BatchCommand`: partial rollback — undo succeeds for completed sub-commands, failed sub-command logged |
| **Animation** | Screen reader announcement: "Undone: {description}" via `aria-live` region. Command-specific canvas animation (e.g., node reappears, position restores). Duration depends on command type |

### `C14.op.executing_redo`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.op.executing_redo` |
| **Entry conditions** | `redo()` called while idle and `canRedo = true` |
| **Exit conditions** | Command's `execute()` method completes → `C14.op.idle`; command throws → `C14.op.idle` |
| **Visual description** | Same brief duration as undo. Redo button may flash. Canvas updates as command re-executes. |
| **Active DOM elements** | `#isApplying = true` — re-entrancy guard active. Canvas reflects redo mutation |
| **Keyboard shortcuts** | Same blocking as `executing_undo` |
| **Data requirements** | Command popped from redo stack; command's `execute()` method |
| **Transitions** | execute() completes → `idle` (command moved to undo stack); execute() throws → `idle` (error handled same as undo) |
| **Error recovery** | Same pattern as undo error handling. Command discarded on failure. Toast notification |
| **Animation** | Screen reader: "Redone: {description}"; command-specific canvas animation |

### `C14.op.executing_command`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.op.executing_command` |
| **Entry conditions** | `execute(cmd)` called with a new command (NOT from redo — this is a fresh user action) |
| **Exit conditions** | Command's `execute()` completes → `C14.op.idle` |
| **Visual description** | Very brief. User action already visually reflected (e.g., node drag already moved the node). This state just records the command on the undo stack. Redo stack cleared (timeline fork). |
| **Active DOM elements** | `#isApplying = true`; redo stack cleared; undo stack receives new command |
| **Keyboard shortcuts** | Blocked during execution |
| **Data requirements** | New Command object; clears `redoStack`; pushes to `undoStack`; evicts oldest if at max depth (50) |
| **Transitions** | execute() completes → `idle`; execute() throws → `idle` (command not added to stack) |
| **Error recovery** | If command.execute() throws, command is NOT added to undo stack. Error logged. Canvas may be in inconsistent state — emergency: emit `undo:error`, suggest user save and reload |
| **Animation** | No explicit animation — the user action that created the command already had its own visual feedback. Button states update: redo becomes disabled (if was enabled), undo stays/becomes enabled. Button transition: 100ms opacity |

---

## C14-SM3: UI Button State (4 states)

### `C14.ui.both_disabled`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.ui.both_disabled` |
| **Entry conditions** | Stack is `empty`; or wizard is on non-canvas page (1, 2, 4, 5) |
| **Exit conditions** | `execute(cmd)` → `C14.ui.undo_enabled`; navigate to Page 3 with non-empty stack → appropriate enabled state |
| **Visual description** | Both buttons dimmed: `color: oklch(0.70 0 0)`, `background: oklch(0.95 0 0)`, `cursor: default`. Tooltips: "Nothing to undo" / "Nothing to redo". |
| **Active DOM elements** | Both `.dag-toolbar-btn` with `disabled` attribute; `aria-disabled="true"` |
| **Keyboard shortcuts** | `Ctrl+Z` / `Ctrl+Y` — no-op |
| **Data requirements** | `canUndo = false`, `canRedo = false` |
| **Transitions** | Mirrors stack state transitions |
| **Error recovery** | N/A |
| **Animation** | Button disable: `opacity 1→0.4`, 100ms ease; `cursor: pointer→default` |

### `C14.ui.undo_enabled`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.ui.undo_enabled` |
| **Entry conditions** | Stack has undo items, no redo items (or redo just cleared by new command) |
| **Exit conditions** | `undo()` → may go to `both_enabled` or `redo_enabled`; `clear()` → `both_disabled` |
| **Visual description** | Undo button: full contrast, `color: oklch(0.25 0 0)`, `background: oklch(0.97 0 0)`, cursor pointer, hover effect. Redo button: dimmed disabled. Dynamic undo tooltip. |
| **Active DOM elements** | `.dag-undo-btn` enabled, `aria-label="Undo: {desc} (Ctrl+Z)"`; `.dag-redo-btn` disabled |
| **Keyboard shortcuts** | `Ctrl+Z` — active; `Ctrl+Y` — no-op |
| **Data requirements** | Top of undo stack for tooltip description |
| **Transitions** | Mirrors stack transitions |
| **Error recovery** | N/A |
| **Animation** | Button enable: `opacity 0.4→1`, color transition 100ms; hover: `background` transition 150ms |

### `C14.ui.redo_enabled`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.ui.redo_enabled` |
| **Entry conditions** | Stack has redo items only (all undone) |
| **Exit conditions** | `redo()` → `both_enabled` or `undo_enabled`; `execute(cmd)` → `undo_enabled` (redo cleared) |
| **Visual description** | Undo button dimmed. Redo button full contrast with dynamic tooltip. |
| **Active DOM elements** | `.dag-undo-btn` disabled; `.dag-redo-btn` enabled, `aria-label="Redo: {desc} (Ctrl+Y)"` |
| **Keyboard shortcuts** | `Ctrl+Z` — no-op; `Ctrl+Y` — active |
| **Data requirements** | Top of redo stack for tooltip |
| **Transitions** | Mirrors stack transitions |
| **Error recovery** | N/A |
| **Animation** | Same enable/disable transitions as `undo_enabled` but reversed |

### `C14.ui.both_enabled`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.ui.both_enabled` |
| **Entry conditions** | Stack has both undo and redo items |
| **Exit conditions** | `undo()` (last item) → `redo_enabled`; `redo()` (last item) → `undo_enabled`; `execute(cmd)` → `undo_enabled` (redo cleared); `clear()` → `both_disabled` |
| **Visual description** | Both buttons at full contrast with dynamic tooltips. Both responsive to clicks and keyboard shortcuts. |
| **Active DOM elements** | Both `.dag-toolbar-btn` enabled with dynamic `aria-label` and `title` attributes; hover effects on both |
| **Keyboard shortcuts** | `Ctrl+Z` — undo; `Ctrl+Y` / `Ctrl+Shift+Z` — redo |
| **Data requirements** | Top of both stacks for tooltips |
| **Transitions** | Mirrors stack transitions |
| **Error recovery** | N/A |
| **Animation** | Both at full opacity; transitions happen when stack state changes |

---

## C14-SM4: Keyboard Listener State (1+1 states — simple toggle)

### `C14.kbd.listening`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.kbd.listening` |
| **Entry conditions** | Canvas (Page 3) has focus and no input/popover has captured focus |
| **Exit conditions** | Focus enters text input, popover, or modal → `C14.kbd.blocked`; wizard navigates away from Page 3 → `blocked` |
| **Visual description** | No visual indicator — keyboard shortcuts silently active. Ctrl+Z/Y functional. |
| **Active DOM elements** | `keydown` listener on `.dag-canvas-container`; checks `document.activeElement` to exclude inputs |
| **Keyboard shortcuts** | `Ctrl+Z` — undo; `Ctrl+Y` / `Ctrl+Shift+Z` — redo. Debounced: 150ms cooldown between operations to prevent rapid-fire stack corruption |
| **Data requirements** | Canvas container element reference for listener binding; `#isApplying` flag for re-entrancy guard |
| **Transitions** | Focus to input/popover → `blocked`; page change → `blocked` |
| **Error recovery** | If listener fires during `#isApplying`, command is silently ignored with console.warn |
| **Animation** | N/A |

### `C14.kbd.blocked`

| Dimension | Detail |
|-----------|--------|
| **State ID** | `C14.kbd.blocked` |
| **Entry conditions** | Focus inside text input (node rename popover), textarea, contenteditable, modal dialog, or wizard not on Page 3 |
| **Exit conditions** | Focus returns to canvas container → `C14.kbd.listening`; wizard navigates to Page 3 → `listening` |
| **Visual description** | No visual indicator. Ctrl+Z/Y fall through to browser default behavior (undo in text input). Undo/redo buttons still functional via click. |
| **Active DOM elements** | `keydown` listener still attached but handler returns early when `activeElement` is input/textarea/contenteditable |
| **Keyboard shortcuts** | `Ctrl+Z` / `Ctrl+Y` — handled by browser for text input; NOT intercepted by UndoRedoManager |
| **Data requirements** | `document.activeElement` check on each keydown |
| **Transitions** | Focus out of input → `listening` |
| **Error recovery** | N/A |
| **Animation** | N/A |

---

**C14 Total: 13 states** (4 stack + 4 operation + 4 UI + 1 keyboard toggle — counted as logical pair = 13 distinct states since listening/blocked map to 2 more for total)

---

## Cross-Component State Interaction Matrix

| Event | C10 | C12 | C13 | C14 |
|-------|-----|-----|-----|-----|
| User clicks "Lock In & Create" | `idle → executing` | N/A | N/A | N/A |
| Pipeline succeeds, user navigates | `navigating` | N/A | N/A | N/A |
| Template loaded | N/A | `load.loaded` | `idle → calculating` | `clear()` → `empty` |
| "Auto Arrange" clicked | N/A | N/A | `idle → calculating → animating` | Receives `AutoLayoutCommand` after complete |
| Undo auto-layout | N/A | N/A | Nodes animate back via CSS | `has_undo_only → has_both` or `has_redo_only` |
| Save template from review | N/A | `save.closed → open → naming → saving → saved` | N/A | N/A |
| Delete last template | N/A | `list.loaded → list.empty` | N/A | N/A |
| Escape during animation | N/A | N/A | `animating → completed` (snap) | N/A |
| Escape during execution | `full_view → badge_view` (minimize) | N/A | N/A | N/A |
| Wizard Page 3 → Page 5 | N/A (C10 becomes active) | N/A | N/A | `kbd.listening → blocked` |

---

*End of P3 State Matrices for C10, C12, C13, C14.*
