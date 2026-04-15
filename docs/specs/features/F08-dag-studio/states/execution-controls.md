# Execution Controls — Complete UX State Matrix

> **Feature:** F08 DAG Studio — Section 2.2 Execution Controls
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Frontend Engineer) + Sana Reeves (Architecture)
> **Date:** 2026-07-30
> **Depends On:** `components/execution-controls.md`, `p0-foundation.md` (APIs 4–9, 15), `auto-detect.js`
> **States Documented:** 68

---

## How to Read This Document

Every state is documented as:

```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

Prefix key:
- `EC-IDLE-*` — Idle / ready-to-run states
- `EC-RUN-*` — Run DAG lifecycle (trigger, optimistic, confirm, error, revert)
- `EC-EXEC-*` — Active execution monitoring
- `EC-CNCL-*` — Cancel lifecycle (confirm, API, timeout)
- `EC-REF-*` — Refresh DAG lifecycle
- `EC-LOCK-*` — Lock detection + force unlock lifecycle
- `EC-SET-*` — Settings panel lifecycle
- `EC-DEF-*` — MLV Execution Definitions dropdown
- `EC-KBD-*` — Keyboard shortcut states

---

## 1. IDLE STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-IDLE-001 | Initial load | DAG Studio view activated, no prior execution | Toolbar renders: [▸ Run DAG ▾] enabled (primary accent), [Cancel] hidden, [↻ Refresh] enabled, [Force Unlock] hidden, [⚙ Settings] enabled. Status indicator: grey dot + "Idle". MLV Definition dropdown: "Full DAG" selected. All buttons at full opacity. | EC-RUN-001, EC-REF-001, EC-SET-001, EC-DEF-001 |
| EC-IDLE-002 | Post-completion idle | Execution completed successfully | [▸ Run DAG ▾] enabled. [Cancel] hidden. Status: green dot + "Completed" + duration "1m 23s". Duration freezes at final value. Run button label: "Run DAG" (or "Run: {defName}" if definition selected). Last iteration ID stored for cancel reference. | EC-RUN-001, EC-REF-001 |
| EC-IDLE-003 | Post-failure idle | Execution failed | [▸ Run DAG ▾] enabled. [Cancel] hidden. Status: red dot + "Failed" + truncated error code (e.g., "MLV_RUNTIME_ERROR"). Tooltip on status: full error message. Run button has subtle urgency — no visual change but context implies retry. | EC-RUN-001, EC-REF-001 |
| EC-IDLE-004 | Post-cancel idle | Execution was cancelled | [▸ Run DAG ▾] enabled. [Cancel] hidden. Status: amber dot + "Cancelled". | EC-RUN-001, EC-REF-001 |
| EC-IDLE-005 | DAG not loaded | DAG Studio activated but `getLatestDag` hasn't returned yet | [▸ Run DAG ▾] disabled (no DAG to run). [Cancel] hidden. [↻ Refresh] shows spinner. Status: grey dot + "Loading DAG...". Settings enabled (independent of DAG load). | EC-IDLE-001 (on load success), EC-IDLE-006 (on load error) |
| EC-IDLE-006 | DAG load failed | `getLatestDag` returned error | [▸ Run DAG ▾] disabled. Status: red dot + "DAG load failed". Toast with error details. [↻ Refresh] enabled for retry. | EC-REF-001 (user retries) |

---

## 2. RUN DAG STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-RUN-001 | Run clicked | User clicks [▸ Run DAG] or presses `Ctrl+Enter` | **Optimistic transition — immediate.** Run button: disabled, text → "Running...", opacity 40%. Cancel button: slides in (160ms), enabled. Status: pulsing blue dot + "Running" + timer starts at `0:00`. UUID generated via `crypto.randomUUID()`. `_runInFlight` flag set to prevent double-click. Dropdown caret disabled. | EC-RUN-002, EC-RUN-003 |
| EC-RUN-002 | Run API success | POST `/liveTableSchedule/runDAG/{uuid}` returns 202 Accepted | No visual change (optimistic UI already shows running state). Console log: "DAG execution started: {uuid}". `_runInFlight` cleared. History list: new row appears at top with status "Running". AutoDetector begins tracking this iteration ID. | EC-EXEC-001 |
| EC-RUN-003 | Run API error — auth | POST returns 401 or 403 | **Revert optimistic UI.** Run button: re-enabled, text → "Run DAG". Cancel: slides out. Status: reverts to previous state (idle/completed/failed/cancelled). Timer stops and resets. Toast: "Authentication failed — token may be expired. Try refreshing your session." `_runInFlight` cleared. | EC-IDLE-001 through EC-IDLE-004 (previous state) |
| EC-RUN-004 | Run API error — not found | POST returns 404 | Revert optimistic UI (same as EC-RUN-003). Toast: "DAG not found — this lakehouse may not have any MLVs defined. Try refreshing the DAG." | EC-IDLE-* (previous) |
| EC-RUN-005 | Run API error — conflict | POST returns 409 | Revert optimistic UI. Toast: "Another execution is already in progress. Wait for it to complete or cancel it." Status may transition to EC-EXEC-001 if the conflict is a currently running execution we weren't tracking. | EC-IDLE-* (previous), EC-EXEC-001 |
| EC-RUN-006 | Run API error — rate limit | POST returns 429 | Revert optimistic UI. Toast: "Rate limited by FLT service — wait {retryAfter}s before trying again." If `Retry-After` header present, show countdown in toast. | EC-IDLE-* (previous) |
| EC-RUN-007 | Run API error — server | POST returns 500 | Revert optimistic UI. Toast: "FLT service error — check service logs for details." | EC-IDLE-* (previous) |
| EC-RUN-008 | Run API error — network | Fetch throws (network error, timeout) | Revert optimistic UI. Toast: "Cannot reach FLT service — is it running? Check localhost connection." | EC-IDLE-* (previous) |
| EC-RUN-009 | Run debounce — double click | User clicks Run while `_runInFlight` is true | Click ignored. No visual feedback (button already disabled). Console warn: "Run already in flight, ignoring." | (stays in current state) |

---

## 3. ACTIVE EXECUTION STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-EXEC-001 | Execution running | AutoDetector fires `onExecutionDetected` or `onExecutionUpdated` with status "running" | Status: pulsing blue dot + "Running" + live timer. Timer increments every 1s. Cancel button: visible and enabled. Run button: disabled. Graph nodes begin animating (blue pulse on running nodes). Gantt bars grow rightward. | EC-EXEC-002, EC-EXEC-003, EC-EXEC-004, EC-CNCL-001 |
| EC-EXEC-002 | Execution completed | AutoDetector reports status "completed" | Status: green dot + "Completed" + final duration "1m 23s". Timer stops. Cancel button: slides out (160ms fade). Run button: re-enabled. Graph: all nodes show final status. Gantt: all bars finalized. Toast: "DAG execution completed — {completedNodes}/{totalNodes} nodes succeeded." History: running row updates to completed in-place. | EC-IDLE-002 |
| EC-EXEC-003 | Execution failed | AutoDetector reports status "failed" | Status: red dot + "Failed" + error summary (first error code). Timer stops. Cancel: slides out. Run: re-enabled. Graph: failed nodes glow red. Toast: "DAG execution failed — {failedCount} node(s) failed. Click for details." History: row updates to failed. | EC-IDLE-003 |
| EC-EXEC-004 | Execution not started | AutoDetector or API returns status "notStarted" | Status: grey dot + "Not Started" (queued). Timer: not started. Cancel: visible and enabled (can cancel queued execution). Run: disabled. This state occurs when the DAG engine queues the execution but hasn't begun processing yet. | EC-EXEC-001 (starts), EC-CNCL-001 (user cancels) |
| EC-EXEC-005 | Execution progress update | AutoDetector fires `onExecutionUpdated` with new node completion | Status indicator: no change (still "Running" + timer). But: node count in status tooltip updates: "12/30 nodes completed". Graph: completed node turns green. Gantt: bar gets final color/width. No full-toolbar re-render — only affected sub-elements update. | EC-EXEC-001 (continues), EC-EXEC-002/003 (finishes) |
| EC-EXEC-006 | Execution stalled | No `onExecutionUpdated` for > 120s during a running execution | No automatic state change. Subtle indicator: timer text color shifts to amber after 2 minutes of silence. Tooltip: "No updates received for {N}s — execution may be stalled." User can Cancel or wait. | EC-EXEC-001 (update resumes), EC-CNCL-001 |

---

## 4. CANCEL STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-CNCL-001 | Cancel clicked — popover shown | User clicks [⊘ Cancel] or presses `Ctrl+.` | Confirmation popover appears below Cancel button (280px wide). Content: "Cancel this DAG execution?" + iteration ID (truncated) + running time + completed node count. Two buttons: [Cancel Execution] (destructive, red) + [Keep Running] (ghost). Focus moves to "Cancel Execution" button. Popover has `role="alertdialog"`. Background: semi-transparent scrim (10% opacity). | EC-CNCL-002, EC-CNCL-006 |
| EC-CNCL-002 | Cancel confirmed | User clicks [Cancel Execution] or presses `Enter` in popover | Popover closes. Cancel button: disabled, text → "Cancelling...". Status: pulsing amber dot + "Cancelling..." + timer continues. Run button: remains disabled. Graph: running nodes transition to pulsing amber. | EC-CNCL-003, EC-CNCL-004 |
| EC-CNCL-003 | Cancel API success | GET `/liveTableSchedule/cancelDAG/{iterationId}` returns 200 with status | If returned status is `"cancelled"`: immediate transition to EC-IDLE-004. If returned status is `"cancelling"`: remain in EC-CNCL-002 visual state, AutoDetector will report final transition. Timer continues. Console log: "Cancel acknowledged: {status}". | EC-IDLE-004, EC-CNCL-005 (timeout) |
| EC-CNCL-004 | Cancel API error | Cancel API returns 4xx/5xx or network error | Toast: "Cancel request failed — the execution may still be running. You can retry in a few seconds." Cancel button: re-enabled after 5s delay (prevent spam). Status: remains "Cancelling..." (do NOT revert to "Running" — cancel may have partially processed). | EC-CNCL-001 (retry), EC-EXEC-001 (if execution completes independently) |
| EC-CNCL-005 | Cancel timeout | 60s elapsed in cancelling state with no AutoDetector status update | Toast: "Cancellation is taking longer than expected. The execution may be stuck. Consider using Force Unlock." If lock is detected on next poll: EC-LOCK-001 activates, Force Unlock button appears. Timer continues counting. | EC-LOCK-001, EC-IDLE-004 (if cancel eventually succeeds) |
| EC-CNCL-006 | Cancel dismissed | User clicks [Keep Running], presses `Escape`, or clicks outside popover | Popover closes (160ms fade). All buttons return to their pre-popover state. Execution continues. No API call made. Focus returns to Cancel button. | EC-EXEC-001 |
| EC-CNCL-007 | Cancel during "not started" | User cancels while execution is queued (notStarted) | Same flow as EC-CNCL-001→002→003. Usually resolves faster since no Spark jobs to terminate. | EC-IDLE-004 |

---

## 5. REFRESH DAG STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-REF-001 | Refresh initiated | User clicks [↻ Refresh] or presses `F5` | Refresh button: icon replaced with 12px spinning loader. Text: "Refreshing..." (if there's room, otherwise just spinner). Button debounced — additional clicks ignored until fetch completes. `event.preventDefault()` on F5 to block browser refresh (only when DAG Studio is active view). | EC-REF-002, EC-REF-003 |
| EC-REF-002 | Refresh success — no topology change | API returns same nodes/edges as current | Spinner stops. Icon returns to ↻. Toast: "DAG refreshed" (auto-dismiss 2s). No graph re-layout (same topology). Node data updated in place (e.g., `lastRefreshTime`, `errorMessage`). MLV execution definitions re-fetched silently. | EC-IDLE-* (current state preserved) |
| EC-REF-003 | Refresh success — topology changed | API returns different node count or edge set | Spinner stops. Graph re-layout with Sugiyama algorithm. New nodes: highlighted with green pulse (2s). Removed nodes: fade out (300ms) if no execution overlay; kept with "removed" dashed border if execution is active. Camera preserves current zoom + pan offset. Node positions animate to new locations (300ms ease-out). Toast: "DAG refreshed — {N} new nodes, {M} removed". | EC-IDLE-* (current state preserved) |
| EC-REF-004 | Refresh error — auth | API returns 401/403 | Spinner stops, icon returns. Toast: "Authentication failed — try refreshing your session token." Existing graph remains visible (do not clear). | EC-IDLE-* (unchanged) |
| EC-REF-005 | Refresh error — not found | API returns 404 | Spinner stops. Toast: "DAG not found — no MLVs may be defined in this lakehouse." Existing graph remains. | EC-IDLE-* (unchanged) |
| EC-REF-006 | Refresh error — server/network | API returns 500 or network error | Spinner stops. Toast: "Failed to refresh DAG — check FLT service." Existing graph remains. | EC-IDLE-* (unchanged) |
| EC-REF-007 | Refresh during execution | User refreshes while execution is running | Same as EC-REF-001 but: execution overlay (node statuses, timing) is preserved. New nodes from refresh that don't exist in current execution show as "Pending" (grey). Nodes in execution but removed from new definition show with dashed border + "removed" label. No interruption to the running execution. | EC-EXEC-001 (execution continues) |
| EC-REF-008 | Refresh debounce | User clicks Refresh while a fetch is already in flight | Click ignored. Button remains in spinner state. Console log: "Refresh already in flight." | (stays in current state) |

---

## 6. LOCK DETECTION & FORCE UNLOCK STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-LOCK-001 | Lock detected — young | Polling returns locked iteration ID with age < 5 minutes | No visual change. Lock stored internally. Force Unlock button remains hidden. This may be a legitimately running execution. | EC-LOCK-002 (ages past 5m), EC-LOCK-005 (lock clears) |
| EC-LOCK-002 | Lock detected — stale | Lock age exceeds 5 minutes | Force Unlock button fades in (300ms) with amber pulse animation to draw attention. Status: red lock icon + "Locked" + "47m ago" (lock age). Run button: disabled. Cancel button: hidden (nothing to cancel — the execution is stuck, not running). Toast (one-time): "DAG execution lock detected — execution may be stuck." | EC-LOCK-003 |
| EC-LOCK-003 | Force Unlock clicked — confirmation | User clicks [🔓 Force Unlock] or `Ctrl+Shift+U` | Modal dialog appears (420px). Content: lock iteration ID, lock age, explanation of consequences. Two buttons: [Force Unlock] (warning amber) + [Cancel] (ghost). Focus on "Force Unlock". Modal overlay: semi-transparent scrim, click-outside does NOT close (intentional safety). `role="dialog"`, `aria-modal="true"`. | EC-LOCK-004, EC-LOCK-006 |
| EC-LOCK-004 | Force Unlock confirmed — API call | User clicks [Force Unlock] in dialog | Dialog: "Unlocking..." replaces button text. Spinner shown. POST `/liveTableMaintanance/forceUnlockDAGExecution/{lockedIterationId}`. | EC-LOCK-005, EC-LOCK-007 |
| EC-LOCK-005 | Force Unlock success | API returns 200 "Force unlocked Dag" | Dialog closes. Force Unlock button fades out. Status: transitions to grey dot + "Idle". Run button: re-enabled. Toast: "DAG execution lock cleared. You can now run the DAG." Internal lock state cleared. | EC-IDLE-001 |
| EC-LOCK-006 | Force Unlock dismissed | User clicks [Cancel] in dialog or presses `Escape` | Dialog closes (160ms fade). Force Unlock button remains visible. All other toolbar state unchanged. | EC-LOCK-002 |
| EC-LOCK-007 | Force Unlock error — no lock | API returns 400 ("no lock to clear") | Dialog shows error inline: "No lock found — it may have already been cleared." Button text: "Close". Click Close → dismiss dialog + hide Force Unlock button + poll immediately to confirm. | EC-IDLE-001 |
| EC-LOCK-008 | Force Unlock error — auth | API returns 401 | Dialog shows error: "Insufficient permissions to force unlock. Contact an admin." Button: "Close". | EC-LOCK-002 |
| EC-LOCK-009 | Force Unlock error — server | API returns 500 | Dialog shows error: "Force unlock failed. Try again or restart the FLT service." Button: [Retry] + [Close]. Retry re-sends the same request. | EC-LOCK-003 (retry), EC-LOCK-002 (close) |
| EC-LOCK-010 | Lock polling error | Lock detection poll returns error | Silent — do not show toast or UI change. Log to console: "Lock poll failed: {error}". Retry on next 30s interval. Prevent toast spam from intermittent network issues. | (current state unchanged) |
| EC-LOCK-011 | Lock cleared externally | Poll returns empty/null after previously detecting a lock | Force Unlock button fades out (160ms). Status: transitions based on actual execution state (idle if nothing running, or back to running if an execution resumed). Toast: "Lock cleared" (only if Force Unlock button was visible). | EC-IDLE-001, EC-EXEC-001 |

---

## 7. SETTINGS PANEL STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-SET-001 | Settings opened | Click [⚙ Settings] or `Ctrl+,` | Slide-out panel (360px) from right side. Overlays DAG graph (does not push). Close button (✕) in panel header. Panel slides in from right (200ms ease-out). Focus moves to first form field. | EC-SET-002, EC-SET-006 |
| EC-SET-002 | Settings loading | Panel opened, fetching current settings | Panel body: 3 field skeletons (shimmer placeholders). Header: "DAG Settings" + loading spinner (12px). Fields disabled until loaded. | EC-SET-003, EC-SET-005 |
| EC-SET-003 | Settings loaded | `GET /liveTable/settings` returns 200 | Fields populate: Parallel Node Limit (number + slider at current value), Refresh Mode (radio: Optimal/Full, current selected), Environment (dropdown with current selection). Skeletons replaced by actual fields (160ms crossfade). All fields enabled and editable. | EC-SET-004 |
| EC-SET-004 | Settings field changed | User modifies any field (blur, Enter, slider release) | Changed field: subtle highlight (accent left border, 2px). Auto-save triggers after 500ms debounce. Small "Saving..." text below field. PATCH request sent with only the changed field(s). | EC-SET-004a (save success), EC-SET-004b (save error) |
| EC-SET-004a | Settings save success | PATCH returns 200 with updated `DagSettingsResponseBody` | "Saving..." text replaced by "Saved ✓" (green, fades after 2s). Field highlight fades. Server response values used to confirm (in case server normalized the value). Gantt parallel limit marker updates if `parallelNodeLimit` changed. | EC-SET-003 |
| EC-SET-004b | Settings save error | PATCH returns 4xx/5xx or network error | Field border turns red. "Saving..." replaced by "Failed to save — [retry]". Click "retry" re-sends the PATCH. Field value reverts to last known good value. Error text persists until retry succeeds or panel closes. | EC-SET-004 (retry) |
| EC-SET-005 | Settings load error | GET returns error | Panel body: error message + [Retry] button. "Failed to load settings — {error message}". Retry re-fetches. | EC-SET-002 (retry) |
| EC-SET-006 | Settings closed | Click ✕, press `Escape`, or `Ctrl+,` toggle | Panel slides out to right (200ms ease-out). Focus returns to Settings button. Any unsaved changes are lost (fields auto-save, so this is rare). | EC-IDLE-* (current execution state) |
| EC-SET-007 | Settings — parallel limit slider interaction | User drags the parallel limit slider | Slider thumb follows cursor. Number input updates in real-time. Tick marks at 2, 5, 10, 15, 25. Value clamped to [2, 25] integer range. Auto-save triggers on mouseup/touchend (not during drag). | EC-SET-004 (on release) |
| EC-SET-008 | Settings — environment dropdown | User opens environment dropdown | Dropdown lists available environments fetched from a separate API (or from cached workspace data). Current selection highlighted. If no environments available: "No environments configured" with link to Fabric portal. | EC-SET-004 (on selection) |

---

## 8. MLV EXECUTION DEFINITIONS STATES

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EC-DEF-001 | Dropdown closed | Default state | Run button shows split: [▸ Run DAG ▾] or [▸ Run: {name} ▾]. Caret (▾) area: 28px clickable zone on right side of button. Main button area: triggers run. Caret area: opens dropdown. | EC-DEF-002 |
| EC-DEF-002 | Dropdown opened | Click caret (▾) or `Alt+↓` on focused Run button | Dropdown appears below Run button (240px wide, max-height 320px). Items: "Full DAG" (bold if selected) + named definitions + divider + "Create new...". Current selection has accent checkmark (✓). `role="listbox"`, `aria-activedescendant`. Focus on current selection. | EC-DEF-003, EC-DEF-005, EC-DEF-006 |
| EC-DEF-003 | Definition selected | Click a definition row or press `Enter` on focused row | Dropdown closes. Run button label updates: "Run DAG" (Full DAG) or "Run: {name}" (truncated 18ch). Selection stored in `localStorage`. Next Run uses this definition. | EC-DEF-001 |
| EC-DEF-004 | Dropdown — keyboard navigation | Arrow keys while dropdown open | Focus ring moves between items. `↑`/`↓` cycles through list. `Home`/`End` jump to first/last. `Escape` closes without selection. Type-ahead: typing characters filters visible items. | EC-DEF-003, EC-DEF-001 (escape) |
| EC-DEF-005 | Create new — dialog opened | Click "Create new..." | Modal dialog: Name (text input, required), Description (textarea, optional), Selected MLVs (checkbox list of executable nodes), Execution Mode (radio group). Focus on Name input. Submit: "Create" (accent) + "Cancel" (ghost). | EC-DEF-007, EC-DEF-006 |
| EC-DEF-006 | Dropdown/dialog dismissed | Click outside, `Escape` | Dropdown/dialog closes. No selection change. | EC-DEF-001 |
| EC-DEF-007 | Create definition — submitting | User fills form and clicks "Create" | Validation: Name required + unique, at least 1 MLV selected. On pass: "Create" button → "Creating..." + spinner. POST `/liveTable/mlvExecutionDefinitions`. | EC-DEF-008, EC-DEF-009 |
| EC-DEF-008 | Create definition — success | POST returns 201 | Dialog closes. Dropdown data refreshed with new definition. New definition auto-selected. Run button label updates. Toast: "Definition '{name}' created." | EC-DEF-001 |
| EC-DEF-009 | Create definition — error | POST returns error | Inline error in dialog: "Failed to create definition — {message}". Form fields preserved. "Create" button re-enabled. | EC-DEF-005 (fix and retry) |
| EC-DEF-010 | Dropdown — loading | Definitions not yet fetched (first open) | Dropdown shows: skeleton rows (3 shimmer bars) + "Loading definitions...". Fetch initiated. On success: skeleton replaced. On error: "Failed to load — using Full DAG" + "Full DAG" option only. | EC-DEF-002 |
| EC-DEF-011 | Dropdown — no definitions | API returns empty list | Dropdown shows: "Full DAG" (only option) + divider + "Create new...". No named definitions to choose from. | EC-DEF-005 |

---

## 9. KEYBOARD SHORTCUT STATES

| ID | State | Trigger | What User Sees | Behavior |
|----|-------|---------|----------------|----------|
| EC-KBD-001 | Ctrl+Enter — Run | `Ctrl+Enter` pressed, DAG Studio active | Same as EC-RUN-001. Visual: Run button flashes briefly (accent pulse, 200ms) to confirm shortcut registered. | Executes Run flow if Run button is enabled. No-op if disabled. |
| EC-KBD-002 | Ctrl+. — Cancel | `Ctrl+.` pressed during execution | Same as EC-CNCL-001. Cancel button flashes. Popover opens with focus on confirm. | Opens cancel popover if Cancel button is visible and enabled. No-op otherwise. |
| EC-KBD-003 | F5 — Refresh | `F5` pressed, DAG Studio active | Same as EC-REF-001. `event.preventDefault()` blocks browser refresh. Refresh button flashes. | Refresh DAG if DAG Studio is the active view. If other view active: browser refresh (normal). |
| EC-KBD-004 | Ctrl+Shift+U — Force Unlock | Shortcut pressed while Force Unlock visible | Same as EC-LOCK-003. Force Unlock button flashes. Modal opens. | Opens confirmation modal. No-op if Force Unlock button is hidden. |
| EC-KBD-005 | Ctrl+, — Settings toggle | `Ctrl+,` pressed | If settings closed: opens (EC-SET-001). If settings open: closes (EC-SET-006). Panel toggles. | Toggle settings panel. |
| EC-KBD-006 | Escape — dismiss overlays | `Escape` pressed | Closes the topmost overlay in priority: (1) Force Unlock modal, (2) Cancel popover, (3) Settings panel, (4) Definition dropdown, (5) Node selection on graph. Only one layer dismissed per Escape press. | Cascade dismiss — one layer at a time. |
| EC-KBD-007 | Shortcut blocked — input focused | User is typing in a text input / textarea | All execution control shortcuts suppressed. `Ctrl+Enter` does not trigger Run. `F5` does not trigger Refresh. Standard text editing shortcuts function normally. | Shortcuts only active when no text input has focus. Exception: `Escape` always works (for overlay dismiss). |

---

## 10. TRANSITION ANIMATIONS

| Transition | Animation | Duration | Easing |
|------------|-----------|----------|--------|
| Button enabled → disabled | Opacity 1.0 → 0.4 | 160ms | `var(--ease-standard)` = `cubic-bezier(0.4, 0, 0.2, 1)` |
| Button disabled → enabled | Opacity 0.4 → 1.0 | 160ms | `var(--ease-standard)` |
| Cancel button appear | `translateX(-8px)` → `translateX(0)` + opacity 0 → 1 | 160ms | `var(--ease-standard)` |
| Cancel button disappear | Opacity 1 → 0 + `translateX(-8px)` | 160ms | `var(--ease-standard)` |
| Force Unlock appear | Opacity 0 → 1 + amber border pulse (2 cycles) | 300ms | ease-out |
| Force Unlock disappear | Opacity 1 → 0 | 160ms | `var(--ease-standard)` |
| Settings panel open | `translateX(360px)` → `translateX(0)` | 200ms | ease-out |
| Settings panel close | `translateX(0)` → `translateX(360px)` | 200ms | ease-in |
| Status dot color change | Background-color crossfade | 300ms | linear |
| Status dot start pulsing | `@keyframes status-pulse` activates | 1500ms loop | ease-in-out |
| Status dot stop pulsing | Pulse stops, opacity snaps to 1.0 | 0ms (instant) | — |
| Timer start | Counter appears, first tick at 1s | — | — |
| Timer stop | Counter freezes at final value | — | — |
| Popover appear | Opacity 0 → 1 + `translateY(-4px)` → `translateY(0)` | 160ms | ease-out |
| Popover disappear | Opacity 1 → 0 + `translateY(-4px)` | 120ms | ease-in |
| Modal appear | Scrim opacity 0 → 0.5 + dialog `scale(0.95)` → `scale(1)` + opacity | 200ms | ease-out |
| Modal disappear | Reverse of appear | 160ms | ease-in |
| Dropdown appear | Opacity 0 → 1 + `translateY(-4px)` → `translateY(0)`, max-height 0 → 320px | 160ms | ease-out |
| Dropdown disappear | Opacity 1 → 0 | 120ms | ease-in |
| Shortcut button flash | Background-color pulse (accent → transparent) | 200ms | ease-out |

---

## 11. ERROR STATE SUMMARY

Every error state includes: what went wrong, what the user sees, and how to recover.

| State ID | Error | Visual | Recovery |
|----------|-------|--------|----------|
| EC-RUN-003 | Auth failure on Run | Toast + revert to previous | Refresh session token |
| EC-RUN-004 | DAG not found on Run | Toast + revert | Refresh DAG definition |
| EC-RUN-005 | Conflict on Run | Toast + revert | Wait for current execution |
| EC-RUN-006 | Rate limit on Run | Toast with countdown + revert | Wait for retry-after period |
| EC-RUN-007 | Server error on Run | Toast + revert | Check FLT service |
| EC-RUN-008 | Network error on Run | Toast + revert | Check FLT service running |
| EC-CNCL-004 | Cancel API error | Toast, stay cancelling | Retry after 5s |
| EC-CNCL-005 | Cancel timeout | Toast, suggest Force Unlock | Force Unlock or wait |
| EC-REF-004 | Auth on Refresh | Toast, keep existing graph | Refresh session |
| EC-REF-005 | Not found on Refresh | Toast, keep existing graph | Check lakehouse |
| EC-REF-006 | Server/network on Refresh | Toast, keep existing graph | Check FLT service |
| EC-LOCK-007 | No lock to clear | Dialog inline error | Lock may have auto-cleared |
| EC-LOCK-008 | Auth on Force Unlock | Dialog inline error | Contact admin |
| EC-LOCK-009 | Server on Force Unlock | Dialog inline error + retry | Retry or restart FLT |
| EC-LOCK-010 | Lock poll error | Silent (console only) | Auto-retries on next poll |
| EC-SET-004b | Settings save error | Field error + revert | Retry link |
| EC-SET-005 | Settings load error | Panel error + retry button | Retry |
| EC-DEF-009 | Create definition error | Dialog inline error | Fix and retry |
| EC-DEF-010 | Definitions fetch error | Dropdown fallback to "Full DAG" | Retry on next open |

---

*"68 states. Zero ambiguity. Every pixel accounted for."*
