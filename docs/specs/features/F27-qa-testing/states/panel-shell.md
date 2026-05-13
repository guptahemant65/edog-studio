# P3 State Matrix — QA Testing Panel Shell

> **Author:** Pixel (Senior Frontend Engineer)
> **Feature:** F27 QA Testing
> **Status:** P3 State Matrix
> **Date:** 2025-07-15
> **Inputs:** `C06-frontend-panel.md` (S01, S02, S08-S13), `signalr-protocol.md`, `architecture.md` (section 1)
> **Governs:** `src/frontend/js/qa-panel.js`, `src/frontend/js/qa-panel-state.js`, `src/frontend/css/qa-panel.css`

---

## Table of Contents

1. [Overview](#1-overview)
2. [State Inventory](#2-state-inventory)
3. [Full State Transition Diagram](#3-full-state-transition-diagram)
4. [State Definitions](#4-state-definitions)
5. [Keyboard Shortcut Reference](#5-keyboard-shortcut-reference)
6. [Cross-Cutting Concerns](#6-cross-cutting-concerns)
7. [Integration Points](#7-integration-points)

---

## 1. Overview

The panel shell is the outermost container for the QA Testing feature. It owns:

- **Lifecycle** — open/close within the EDOG sidebar (`sidebar.js:78` `switchView`)
- **Stage navigation** — 5-stage linear pipeline managed by `StageManager` (`C06-S02`)
- **Connection overlay** — disconnected/reconnecting chrome (`signalr-manager.js:81-97`)
- **Kill switch** — emergency abort of in-flight execution
- **Error boundary** — unrecoverable error catch-all

The shell does NOT own stage-internal rendering (PR card, scenario rows, result charts). Each stage controller manages its own DOM within the stage container.

### Naming Convention

```
panel.{lifecycle}.{sub-state}

Examples:
  panel.closed
  panel.open.stage.input
  panel.open.disconnected
```

---

## 2. State Inventory

| # | State ID | Category | Duration |
|---|----------|----------|----------|
| 1 | `panel.closed` | Lifecycle | Indefinite |
| 2 | `panel.open.empty` | Lifecycle | Until PR loaded or restored |
| 3 | `panel.open.stage.input` | Stage | User-driven |
| 4 | `panel.open.stage.analysis` | Stage | 10-120s (backend pipeline) |
| 5 | `panel.open.stage.curation` | Stage | User-driven |
| 6 | `panel.open.stage.execution` | Stage | 5-300s per scenario |
| 7 | `panel.open.stage.results` | Stage | Indefinite |
| 8 | `panel.open.transition` | Transient | 250ms (animation) |
| 9 | `panel.open.disconnected` | Overlay | Until reconnect or timeout |
| 10 | `panel.open.reconnecting` | Overlay | 0-30s |
| 11 | `panel.open.killed` | Terminal | Until reset |
| 12 | `panel.open.error` | Terminal | Until retry or reset |
| 13 | `panel.open.phase-gate` | Gate | Until FLT connects |
| 14 | `panel.open.confirming-back` | Modal | Until user confirms/cancels |

**Total: 14 states** (5 stage, 3 overlay/gate, 2 terminal, 2 lifecycle, 2 transient)

---

## 3. Full State Transition Diagram

```
                                 sidebar.switchView('qa')
                                         |
                                         v
    +==============+    first activation    +==================+
    | panel.closed | ---------------------> | panel.open.empty |
    +==============+                        +==================+
         ^                                    |
         |  sidebar.switchView(other)         | state.restore() succeeds?
         |  or panel deactivate()             |
         |                                    +--yes--> [restored stage]
         |                                    |
         |                                    +--no---> panel.open.phase-gate
         |                                              (if Disconnected phase)
         |                                              |
         |                                    +---------+--FLT connects
         |                                    |
         |                                    v
         |                    +============================+
         |                    | panel.open.stage.input (0) |<----+
         |                    +============================+     |
         |                           |                           |
         |              "Analyze" clicked +                      |
         |              PR validated      |                      |
         |                                v                      |
         |                    +---------------------------+      |
         |                    | panel.open.transition     |      |
         |                    | (250ms fade animation)    |      |
         |                    +---------------------------+      |
         |                                |                      |
         |                                v                      |
         |                    +===============================+  |
         |                    | panel.open.stage.analysis (1) |  |
         |                    +===============================+  |
         |                           |                           |
         |              all 3 tracks complete                    |
         |                                |                      |
         |                    [ transition ]                     |
         |                                |                      |
         |                                v                      |
         |                    +================================+ |  confirm
         |                    | panel.open.stage.curation (2)  |-+<------+
         |                    +================================+         |
         |                        |       |                              |
         |     back to input +----+       | "Run Approved"               |
         |     (confirm dialog)           | (>= 1 approved)             |
         |           |                    v                              |
         |           v        +================================+         |
         |  panel.open.       | panel.open.stage.execution (3) |         |
         |  confirming-back   +================================+         |
         |                         |             |                       |
         |              all done   |   kill      |                       |
         |                    |    |   switch    |                       |
         |        [ transition ]   |             v                       |
         |                    |    |   +====================+            |
         |                    v    |   | panel.open.killed  |            |
         |                    |    |   +====================+            |
         |                    |    |        | "View Results"             |
         |                    |    |        v                            |
         |                    +----+------->+                            |
         |                                  |                            |
         |                                  v                            |
         |                    +==============================+           |
         |                    | panel.open.stage.results (4) |-----------+
         |                    +==============================+  re-run
         |                         |
         |           reset / new PR|
         |                         v
         +---- deactivate --------[stage.input]


  ========= OVERLAY STATES (can activate from ANY open.stage.*) =========

  panel.open.stage.*
       |                                        |
       | ws.status='disconnected'               | ws.status='reconnecting'
       v                                        v
  +========================+            +=========================+
  | panel.open.disconnected|<---------->| panel.open.reconnecting |
  +========================+            +=========================+
       |                                        |
       | 30s timeout                            | ws.status='connected'
       v                                        v
  +===================+                 [previous stage restored]
  | panel.open.error  |
  +===================+
       |
       | "Retry" or "Reset"
       v
  [stage.input] or [reconnect attempt]
```

---

## 4. State Definitions

### 4.1 `panel.closed`

| Field | Value |
|-------|-------|
| **Entry conditions** | App load (default). Sidebar switches to another view (`sidebar.js:78`). `deactivate()` called on `QATestingPanel`. |
| **Exit conditions** | User clicks QA nav item (sidebar `data-view="qa"`). Keyboard shortcut `Ctrl+6`. Command palette "QA: Open Panel". |
| **Visual description** | Nothing rendered. `#qa-panel-root` has `display:none`. Sidebar QA icon (&#9673;) is inactive (no highlight). |
| **Keyboard shortcuts** | `Ctrl+6` -- open QA panel (handled by `sidebar.js:317`) |
| **Data requirements** | None. No SignalR subscriptions active for QA. |
| **Transitions** | `panel.closed` --> `panel.open.empty` (on first activation) |
| | `panel.closed` --> `panel.open.stage.*` (on re-activation with preserved state) |
| **Error recovery** | N/A -- no active operations. |

---

### 4.2 `panel.open.empty`

| Field | Value |
|-------|-------|
| **Entry conditions** | First-ever activation of QA panel. `QATestingPanel` constructor runs, `state.restore()` returns `false`. |
| **Exit conditions** | Phase check passes (Connected phase) --> `stage.input`. Phase check fails --> `phase-gate`. |
| **Visual description** | Momentary (< 1 frame). Panel container visible, stage containers hidden. Pipeline bar rendered but all steps in `pending` state. Immediately transitions to `phase-gate` or `stage.input`. |
| **Keyboard shortcuts** | None (transient state). |
| **Data requirements** | Reads `ws.status` from `SignalRManager` (`signalr-manager.js:19`). |
| **Transitions** | `panel.open.empty` --> `panel.open.phase-gate` (if Disconnected phase) |
| | `panel.open.empty` --> `panel.open.stage.input` (if Connected phase) |
| **Error recovery** | If `QATestingPanel` constructor throws, catch in `main.js:_onViewChange` and show `panel.open.error`. |

---

### 4.3 `panel.open.phase-gate`

| Field | Value |
|-------|-------|
| **Entry conditions** | Panel activated but FLT is not running (Disconnected phase). `ws.status !== 'connected'` and no prior connection established. |
| **Exit conditions** | FLT connects (`ws.status` changes to `'connected'`). User switches away (panel closes). |
| **Visual description** | See wireframe below. |
| **Keyboard shortcuts** | `Escape` -- close panel (return to previous view). |
| **Data requirements** | Listens to `ws.onStatusChange` (`signalr-manager.js:161`). |
| **Transitions** | `panel.open.phase-gate` --> `panel.open.stage.input` (on FLT connect) |
| | `panel.open.phase-gate` --> `panel.closed` (sidebar switch) |
| **Error recovery** | Static display. No operations to fail. |

```
+------------------------------------------------------------------+
|  [1]----[2]----[3]----[4]----[5]   (pipeline bar, all grey)      |
|  Input  Analysis Curation Exec Results                           |
+------------------------------------------------------------------+
|                                                                  |
|                                                                  |
|               +----------------------------+                     |
|               |     ◇  QA Testing          |                     |
|               |                            |                     |
|               |  Connect to FLT to use     |                     |
|               |  QA Testing.               |                     |
|               |                            |                     |
|               |  Run `edog connect` or     |                     |
|               |  use the connection panel   |                     |
|               |  to start FLT first.       |                     |
|               |                            |                     |
|               +----------------------------+                     |
|                                                                  |
+------------------------------------------------------------------+
```

---

### 4.4 `panel.open.stage.input`

| Field | Value |
|-------|-------|
| **Entry conditions** | Panel opens in Connected phase. User navigates back from curation/results (with confirmation). State restored with `currentStage === 0`. |
| **Exit conditions** | User clicks "Analyze" with a validated PR. Sidebar switches away. |
| **Visual description** | See wireframe below. |
| **Keyboard shortcuts** | `Enter` -- submit PR input (when input focused). `Escape` -- clear input, hide PR card. `1` -- no-op (already on stage 1). `?` -- help overlay. |
| **Data requirements** | No SignalR subscriptions. REST call to `/api/qa/pr/{n}` for PR validation (via `api-client.js`). Reads `localStorage` key `edog-qa-recent-prs` for recent PRs list. |
| **Transitions** | `panel.open.stage.input` --> `panel.open.transition` --> `panel.open.stage.analysis` (on "Analyze" click with valid PR) |
| | `panel.open.stage.input` --> `panel.closed` (sidebar switch) |
| **Error recovery** | PR not found: inline error below input, input border turns `var(--fail)`. Network error: inline error "Could not reach EDOG backend". User corrects and retries. |

```
+------------------------------------------------------------------+
|  [1]----[2]----[3]----[4]----[5]   (pipeline bar)                |
| *Input* Analysis Curation Exec Results                           |
+------------------------------------------------------------------+
|                                                                  |
|   PULL REQUEST                                                   |
|   +--------------------------------------------------------+    |
|   | ◇  Enter PR # or URL...                               |    |
|   +--------------------------------------------------------+    |
|                                                                  |
|   RECENT PRS                                                     |
|   +--------------------------------------------------------+    |
|   | #14823  Fix retry logic in WriteFileAsync    2h ago  x |    |
|   | #14801  Add Spark session pooling            1d ago  x |    |
|   +--------------------------------------------------------+    |
|                                                                  |
|   +--------------------------------------------------------+    |
|   | PR #14823                                              |    |
|   | Fix retry logic in WriteFileAsync                      |    |
|   | alice@contoso.com  +142 -38  12 files                  |    |
|   |                                                        |    |
|   |                              [ Analyze ]               |    |
|   +--------------------------------------------------------+    |
|                                                                  |
+------------------------------------------------------------------+
```

---

### 4.5 `panel.open.stage.analysis`

| Field | Value |
|-------|-------|
| **Entry conditions** | `connection.invoke('QaStartCodeAnalysis', request)` returns `success: true` (`signalr-protocol.md` section 1.1). Transition animation from input stage completes. |
| **Exit conditions** | All 3 analysis tracks reach `status: 'done'` (backend sends `QA.AnalysisComplete`). Analysis error (all tracks failed). User cancels (kill switch). |
| **Visual description** | See wireframe below. Three parallel analysis tracks with animated progress bars. Pipeline step 1 shows green check, step 2 pulses with accent color. |
| **Keyboard shortcuts** | `Escape` -- cancel analysis (invokes `QaCancelAnalysis`, returns to input). `1` -- back to input (cancels analysis, with confirmation). `?` -- help overlay. |
| **Data requirements** | **SignalR subscriptions:** `qa` topic via `ws.on('qa', handler)` + `ws.subscribeTopic('qa')` (`signalr-manager.js:171,186`). **Events consumed:** `QA.AnalysisProgress` (per-track updates), `QA.AnalysisComplete`, `QA.AnalysisError`. |
| **Transitions** | `panel.open.stage.analysis` --> `panel.open.transition` --> `panel.open.stage.curation` (all tracks done) |
| | `panel.open.stage.analysis` --> `panel.open.stage.input` (user cancels / all tracks fail) |
| | `panel.open.stage.analysis` --> `panel.open.disconnected` (SignalR drops) |
| **Error recovery** | Single track failure: track shows red "ERROR" badge, subtitle shows error text. Remaining tracks continue. Partial results allowed -- "Continue with partial analysis?" prompt. All tracks fail: full error card with "Try Again" and "Create Manual Scenarios" actions. |

```
+------------------------------------------------------------------+
|  [1]----[2]----[3]----[4]----[5]   (pipeline bar)                |
|   ok   *Analyzing* Curation Exec Results                         |
+------------------------------------------------------------------+
|                                                                  |
|   ◆ Roslyn Blast Radius                           RUNNING       |
|   [=================----------]  67%                             |
|   Analyzing WriteFileAsync call graph...                         |
|                                                                  |
|   ◆ Graphify Service Map                           RUNNING       |
|   [=============--------------]  48%                             |
|   Mapping HTTP dependencies for FileService...                   |
|                                                                  |
|   ◆ GPT-5.4 Scenario Generation                   PENDING       |
|   [------------------------------]  0%                           |
|   Waiting for Roslyn + Graphify...                               |
|                                                                  |
|                                          [ Cancel Analysis ]     |
|                                                                  |
+------------------------------------------------------------------+
```

---

### 4.6 `panel.open.stage.curation`

| Field | Value |
|-------|-------|
| **Entry conditions** | Analysis completes. `state.scenarios` populated. `stageManager.advance(2)` called from `_onAnalysisComplete()`. |
| **Exit conditions** | User clicks "Run Approved" with `approvedCount >= 1`. User navigates back to input (with confirmation). |
| **Visual description** | Scenario list with checkboxes, category badges, priority indicators. Toolbar: "Approve All" / "Reject All" / "Run Approved (N)". Each row: checkbox, title, category pill, priority star, edit/delete actions. Virtual scrolling for lists > 50 items (`C06-S14`). |
| **Keyboard shortcuts** | `Enter` -- toggle approve on focused scenario. `E` -- edit focused scenario. `Delete`/`Backspace` -- reject focused scenario. `A` -- approve all. `R` -- run approved. `1` -- back to input (confirm dialog). `?` -- help overlay. Arrow keys -- navigate scenario list. |
| **Data requirements** | `qa` topic subscription remains active (for late-arriving scenarios if generation is async). `state.scenarios[]`, `state.approved`, `state.rejected` as source of truth. |
| **Transitions** | `panel.open.stage.curation` --> `panel.open.transition` --> `panel.open.stage.execution` (on "Run Approved") |
| | `panel.open.stage.curation` --> `panel.open.confirming-back` --> `panel.open.stage.input` (back with confirmation) |
| | `panel.open.stage.curation` --> `panel.open.disconnected` (SignalR drops) |
| **Error recovery** | Empty scenario list: show empty state card with "Create Manual Scenario" button. Scenario validation error on submit: toast with details, submission blocked. |

---

### 4.7 `panel.open.stage.execution`

| Field | Value |
|-------|-------|
| **Entry conditions** | `connection.invoke('QaStartRun', { scenarios })` returns `success: true`. `state.isExecuting = true`. `stageManager._locked = true`. |
| **Exit conditions** | All scenarios complete/fail/timeout (backend sends `QA.RunComplete`). Kill switch activated. |
| **Visual description** | Split-pane layout. Left sidebar: scenario queue with status icons (pending &#9675;, running &#9899;, passed &#9679;, failed &#9650;). Right main area: live execution view for current scenario showing 8-phase progress (Isolate, Setup, Mark, Stimulate, Capture, Evaluate, Teardown, Report), interceptor event stream, timer, expectation match indicators. |
| **Keyboard shortcuts** | `K` -- kill switch (confirm dialog). `4` -- no-op (already on stage). `1`/`2`/`3`/`5` -- blocked (locked). Up/Down arrows -- scroll scenario sidebar. `?` -- help overlay. All other stage shortcuts disabled. |
| **Data requirements** | **SignalR events (high throughput, batched per rAF):** `QA.ScenarioStarted`, `QA.InterceptorEvent` (>100/s possible), `QA.ExpectationMatched`, `QA.ScenarioCompleted`, `QA.RunComplete`. Dedup by `TopicEvent.SequenceId` via `state._lastSeenSeq`. `state.save()` called every 5 completed scenarios for crash recovery. |
| **Transitions** | `panel.open.stage.execution` --> `panel.open.transition` --> `panel.open.stage.results` (run complete) |
| | `panel.open.stage.execution` --> `panel.open.killed` (kill switch) |
| | `panel.open.stage.execution` --> `panel.open.disconnected` (SignalR drops -- execution continues on backend) |
| **Error recovery** | Single scenario timeout: timer badge turns red, verdict "TIMED OUT", auto-advances to next scenario. FLT crash during execution: on reconnect, backend sends partial results. Panel shows "Execution interrupted" banner with whatever completed. Network blip (<5s): SignalR auto-reconnects, events replayed via snapshot+live pattern. `state.save()` persists progress. |

---

### 4.8 `panel.open.stage.results`

| Field | Value |
|-------|-------|
| **Entry conditions** | All scenarios resolved. `state.runResult` populated. `stageManager.advance(4)` called from `_onRunComplete()`. |
| **Exit conditions** | User starts a new workflow ("New Analysis" returns to input). User navigates back to curation for re-run. Sidebar switches away. |
| **Visual description** | Summary header: pass/fail counts, total duration, donut/ring chart. Expandable result rows: scenario title, verdict badge (PASSED/FAILED/PARTIAL/TIMED OUT), duration, matched/unmatched expectations. Action bar: "Re-run Failed", "Post to PR", "Copy to Clipboard". |
| **Keyboard shortcuts** | `Enter` -- expand/collapse focused result row. `P` -- post to PR. `C` -- copy results to clipboard. `F` -- re-run failed scenarios. `3` -- back to curation. `1` -- back to input (new PR). `?` -- help overlay. |
| **Data requirements** | `qa` topic subscription remains active (for late corrections). `state.runResult`, `state.scenarioResults` as source of truth. REST call for `QaGetCommentPreview` when "Post to PR" is clicked. |
| **Transitions** | `panel.open.stage.results` --> `panel.open.stage.curation` (re-run, no confirmation needed) |
| | `panel.open.stage.results` --> `panel.open.confirming-back` --> `panel.open.stage.input` (new PR, with confirmation) |
| | `panel.open.stage.results` --> `panel.closed` (sidebar switch) |
| **Error recovery** | "Post to PR" failure: toast "Failed to post comment" + "Copy to Clipboard" fallback. Partial results from interrupted run: banner "Execution was interrupted. Showing partial results." with count of completed vs total. |

---

### 4.9 `panel.open.transition`

| Field | Value |
|-------|-------|
| **Entry conditions** | `stageManager.goTo(n)` or `stageManager.advance(n)` called. CSS animation begins. |
| **Exit conditions** | Animation completes (250ms). `animationend` event fires. |
| **Visual description** | Outgoing stage fades out. Incoming stage fades in with `fadeIn 250ms var(--ease) 80ms both` (`C06-S13`). Pipeline bar step animates: completed node fills green (300ms), connecting line fills (400ms), new active node pulses accent. |
| **Keyboard shortcuts** | All input suppressed during transition. `_locked` flag prevents re-entry. |
| **Data requirements** | None. Pure CSS animation. |
| **Transitions** | `panel.open.transition` --> `panel.open.stage.*` (target stage, on animation end) |
| **Error recovery** | If `animationend` does not fire within 500ms (browser quirk), `setTimeout` fallback forces transition completion. Prevents user from getting stuck. |

---

### 4.10 `panel.open.disconnected`

| Field | Value |
|-------|-------|
| **Entry conditions** | `SignalRManager.onclose` fires with `status = 'disconnected'` (`signalr-manager.js:92-97`). Panel is open. |
| **Exit conditions** | SignalR enters reconnecting state. Manual "Retry" click. 30s timeout triggers error state. |
| **Visual description** | Semi-transparent overlay on current stage (stage DOM remains visible but non-interactive). Error banner pinned to top: "&#9650; Connection lost. Reconnecting..." with spinner. Stage content dimmed with `pointer-events: none`. |
| **Keyboard shortcuts** | `Enter` -- trigger manual reconnect. `Escape` -- dismiss overlay (stage remains but without live data). |
| **Data requirements** | Listens to `ws.onStatusChange` for reconnection signals. If execution was in progress, backend continues independently. |
| **Transitions** | `panel.open.disconnected` --> `panel.open.reconnecting` (auto-reconnect starts) |
| | `panel.open.disconnected` --> `panel.open.error` (30s timeout with no reconnect) |
| | `panel.open.disconnected` --> `panel.open.stage.*` (manual retry succeeds immediately) |
| **Error recovery** | Execution survives disconnection on the backend. On reconnect, snapshot+live replay catches the panel up. `state._lastSeenSeq` prevents duplicate processing. If in input stage (no SignalR dependency), dismiss overlay silently -- PR validation uses REST. |

---

### 4.11 `panel.open.reconnecting`

| Field | Value |
|-------|-------|
| **Entry conditions** | `connection.onreconnecting()` fires (`signalr-manager.js:81-84`). |
| **Exit conditions** | `connection.onreconnected()` fires. Reconnect fails permanently (falls to disconnected/error). |
| **Visual description** | Same overlay as disconnected but banner text changes to "&#9650; Reconnecting... (attempt N)" with animated dots. Retry counter visible. Stage content still dimmed. |
| **Keyboard shortcuts** | Same as disconnected. |
| **Data requirements** | Reconnect attempt counter tracked locally. `_resubscribeAll()` (`signalr-manager.js:146`) called on successful reconnect re-subscribes `qa` topic. |
| **Transitions** | `panel.open.reconnecting` --> `panel.open.stage.*` (reconnect succeeds, `_resubscribeAll()` restores subscriptions) |
| | `panel.open.reconnecting` --> `panel.open.disconnected` (reconnect attempt fails, will retry) |
| | `panel.open.reconnecting` --> `panel.open.error` (max retries exhausted) |
| **Error recovery** | SignalR's built-in exponential backoff handles retry timing. After reconnect, `qa` topic snapshot replay delivers missed events. Panel processes replay idempotently via `sequenceId` dedup. |

---

### 4.12 `panel.open.killed`

| Field | Value |
|-------|-------|
| **Entry conditions** | User activates kill switch during execution. Confirmation dialog accepted. `connection.invoke('QaCancelRun')` sent. Backend sends `QA.RunComplete` with partial results and `cancelled: true`. |
| **Exit conditions** | User clicks "View Results" (goes to results with partial data). User clicks "Back to Curation" (re-enter curation with same scenarios). User clicks "New Analysis" (reset to input). |
| **Visual description** | Execution stage replaced with kill confirmation card. Red accent banner: "Run Cancelled". Summary of completed scenarios before kill (e.g., "4 of 12 scenarios completed"). Three action buttons. |
| **Keyboard shortcuts** | `V` -- view results. `3` -- back to curation. `1` -- new analysis. `?` -- help overlay. |
| **Data requirements** | `state.isExecuting = false`. `state.scenarioResults` contains partial results. `stageManager._locked = false` (navigation unlocked). |
| **Transitions** | `panel.open.killed` --> `panel.open.stage.results` (view results) |
| | `panel.open.killed` --> `panel.open.stage.curation` (back to curation) |
| | `panel.open.killed` --> `panel.open.stage.input` (new analysis) |
| **Error recovery** | If `QaCancelRun` invoke fails (network), retry once. On second failure, force-set `state.isExecuting = false` and unlock navigation locally. Backend will time out independently. |

---

### 4.13 `panel.open.error`

| Field | Value |
|-------|-------|
| **Entry conditions** | Unrecoverable failure: SignalR permanently disconnected (30s timeout + max retries exhausted). `QATestingPanel` constructor threw. Backend QA module missing (topic `qa` fails to register). |
| **Exit conditions** | User clicks "Retry" (attempts reconnect). User clicks "Reset" (clears state, returns to input). |
| **Visual description** | Full-panel error card replacing all stage content. Error icon (&#9650;), title ("Something went wrong"), detail message, and action buttons. If the error is "QA backend not available", message includes version requirement ("QA Testing requires EDOG backend v2.1+"). |
| **Keyboard shortcuts** | `Enter` -- retry. `Escape` -- reset to input. `?` -- help overlay. |
| **Data requirements** | No active subscriptions. Previous state preserved in `QAPanelState` for potential recovery. |
| **Transitions** | `panel.open.error` --> `panel.open.reconnecting` (retry triggers reconnect) |
| | `panel.open.error` --> `panel.open.stage.input` (reset clears state) |
| | `panel.open.error` --> `panel.closed` (sidebar switch) |
| **Error recovery** | "Retry" follows same path as initial connection. After 3 consecutive failures of same error type, add diagnostic hint: "Check EDOG backend logs at ~/.edog/logs/". |

---

### 4.14 `panel.open.confirming-back`

| Field | Value |
|-------|-------|
| **Entry conditions** | User presses `1` or clicks stage 1 in pipeline bar while on curation or results stage (where back-navigation would discard scenario data). |
| **Exit conditions** | User confirms (proceed with back-navigation). User cancels (stay on current stage). |
| **Visual description** | Modal dialog overlaying current stage. Focus-trapped. "Going back will discard generated scenarios. Continue?" with "Continue" (destructive) and "Cancel" buttons. |
| **Keyboard shortcuts** | `Enter` -- confirm (continue back). `Escape` -- cancel (stay). `Tab` -- cycle between buttons (focus trap). |
| **Data requirements** | None. Pure UI state. |
| **Transitions** | `panel.open.confirming-back` --> `panel.open.stage.input` (user confirms, `state.reset()` clears scenarios) |
| | `panel.open.confirming-back` --> `panel.open.stage.curation` or `panel.open.stage.results` (user cancels, restore previous stage) |
| **Error recovery** | Modal auto-dismisses if SignalR disconnects (overlay takes priority). |

---

## 5. Keyboard Shortcut Reference

### Global Shortcuts (active when QA panel is open, focus NOT in input/textarea)

| Key | Action | Blocked During |
|-----|--------|----------------|
| `1` | Go to PR Input stage | Execution (locked), Transition |
| `2` | Go to Analysis stage (if reached) | Execution, Transition |
| `3` | Go to Curation stage (if reached) | Execution, Transition |
| `4` | Go to Execution stage (if reached) | Transition |
| `5` | Go to Results stage (if reached) | Execution, Transition |
| `?` | Toggle help overlay | Never |
| `Escape` | Context-dependent close (see below) | Never |
| `K` | Kill switch (execution only) | All except execution |

### Escape Key Cascade

Escape is processed in priority order. First matching action wins:

1. Close help overlay (if open)
2. Close confirmation dialog (if open)
3. Close scenario editor (if open in curation)
4. Cancel analysis (if running in analysis stage)
5. Clear PR input (if on input stage with text)
6. No-op (nothing to close)

### Stage-Specific Shortcuts

| Stage | Key | Action |
|-------|-----|--------|
| Input (0) | `Enter` | Submit PR input (when input focused) |
| Curation (2) | `A` | Approve all scenarios |
| Curation (2) | `R` | Run approved scenarios |
| Curation (2) | `Enter` | Toggle approve on focused scenario |
| Curation (2) | `E` | Edit focused scenario |
| Curation (2) | `Delete` | Reject focused scenario |
| Curation (2) | `Up`/`Down` | Navigate scenario list |
| Execution (3) | `K` | Kill switch (opens confirmation) |
| Execution (3) | `Up`/`Down` | Scroll scenario sidebar |
| Results (4) | `Enter` | Expand/collapse focused result |
| Results (4) | `P` | Post results to PR |
| Results (4) | `C` | Copy results to clipboard |
| Results (4) | `F` | Re-run failed scenarios |

### Shortcut Guard

All shortcuts are suppressed when `e.target.tagName` is `INPUT`, `TEXTAREA`, or `SELECT` (`C06-S10`). This prevents conflicts between typing and navigation.

Source: `src/frontend/js/qa-panel.js` -- `_bindKeyboard()` handler registered on `activate()`, removed on `deactivate()`.

---

## 6. Cross-Cutting Concerns

### 6.1 Theme Change

- **Trigger:** User toggles theme via topbar (`src/frontend/js/topbar.js`).
- **Impact:** All QA panel CSS uses `var(--*)` design tokens. No JS intervention needed. CSS custom properties cascade automatically.
- **Validation:** `qa-panel.css` must use ONLY variables from the design token set. No hardcoded colors except `#fff` for text-on-green badges.
- **During animation:** Theme change during `panel.open.transition` is safe -- CSS variables update instantly, ongoing animations inherit new values.

### 6.2 Window Resize

- **Trigger:** Browser resize or sidebar expand/collapse.
- **Breakpoints** (`C06-S11`):
  - `>1100px` -- default layout (exec split-pane horizontal)
  - `900-1100px` -- condensed sidebar (200px)
  - `700-900px` -- narrow (180px sidebar, wrapped summary)
  - `<700px` -- stacked (exec split-pane vertical, pipeline labels hidden)
- **Impact per state:**
  - `stage.execution`: Split-pane switches between horizontal and vertical layout. `ResizeObserver` on `#qaContent` recalculates virtual scroll viewport.
  - `stage.curation`: Virtual scroll (`C06-S14`) recalculates visible rows on container resize.
  - `stage.results`: Summary cards reflow with `flex-wrap`.
  - Pipeline bar: `pipe-line` segments shrink. At `<700px`, labels collapse to numbers only.
- **Guard:** `ResizeObserver` callback debounced to 1 per `rAF` cycle to prevent layout thrash.

### 6.3 FLT Crash Recovery

- **Detection:** `connection.onclose()` fires (`signalr-manager.js:92`). `ws.status` changes to `'disconnected'`.
- **State preservation:** `QAPanelState.save()` persists to `localStorage` immediately on disconnect.
- **Recovery flow:**
  1. Panel enters `panel.open.disconnected`.
  2. User restarts FLT (`edog connect`).
  3. SignalR reconnects. `_resubscribeAll()` re-subscribes `qa` topic.
  4. If execution was in progress: backend may have partial results. Panel shows "Execution was interrupted" banner with available data.
  5. If analysis was in progress: analysis state is lost (backend-side). User must re-trigger from input stage.
- **Stale state guard:** Restored state older than 1 hour is discarded (`QAPanelState.restore()` checks `timestamp`).

### 6.4 Sidebar Expand/Collapse

- **Trigger:** User clicks sidebar toggle.
- **Impact:** `#qa-panel-root` width changes. CSS handles via percentage widths and flex layout. No JS resize handling needed beyond the `ResizeObserver` already in place for viewport changes.

### 6.5 Concurrent View Activation

- **DAG Studio + QA:** Both can be instantiated simultaneously. Each uses scoped `.on()`/`.off()` for different topics (`dag` vs `qa`). No conflict.
- **Runtime View + QA:** Runtime subscribes to `http`, `log`, etc. QA subscribes to `qa`. Independent topic spaces.
- **Deactivation:** When sidebar switches away, `QATestingPanel.deactivate()` unsubscribes `qa` topic UNLESS `state.isExecuting === true` (execution continues in background, events buffered).

---

## 7. Integration Points

| Module | File | Integration | States Affected |
|--------|------|-------------|-----------------|
| `EdogLogViewer` | `main.js:94` | Instantiates `QATestingPanel` in `_onViewChange('qa')` at line 794. Passes `this.ws` (SignalR) and `this.apiClient`. | `panel.closed` --> `panel.open.*` |
| `Sidebar` | `sidebar.js:78` | `switchView('qa')` toggles `#qa-panel-root` visibility. Nav item at `data-view="qa"`. `Ctrl+6` shortcut at `sidebar.js:317`. | `panel.closed` <--> `panel.open.*` |
| `SignalRManager` | `signalr-manager.js:16` | `.on('qa', handler)` at line 171. `.subscribeTopic('qa')` at line 186. `.onStatusChange` at line 161. Reconnect at line 146. | All `panel.open.*` states |
| `QAPanelState` | `qa-panel-state.js` (new) | Single source of truth. `.save()` for crash recovery. `.restore()` on reload. `.reset()` on new workflow. | All states read/write state |
| `StageManager` | `qa-panel.js` (inner class) | `goTo(n)`, `advance(n)`, `_locked` flag. Pipeline DOM rendering. | All `panel.open.stage.*` + `transition` |
| `Toast` | `toast.js` | Error toasts for non-blocking failures (PR comment post failed, copy failed). | `stage.results`, `stage.curation` |
| `localStorage` | Browser API | Key `edog-qa-state` for crash recovery. Key `edog-qa-recent-prs` for PR history. | `panel.open.empty` (restore), all stages (save) |

---

*End of P3 State Matrix -- QA Testing Panel Shell*
