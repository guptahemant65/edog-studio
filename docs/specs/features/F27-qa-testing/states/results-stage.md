# P3 State Matrix — Results Stage (C06-S07)

**Feature:** F27 QA Testing
**Component:** C06 Frontend Panel — S07 Results Stage
**Author:** Pixel (Frontend)
**Priority:** P3
**States:** 16

---

## Table of Contents

1. [State Inventory](#state-inventory)
2. [State Definitions](#state-definitions)
3. [Transition Diagram](#transition-diagram)
4. [ASCII Wireframes](#ascii-wireframes)
5. [Keyboard Shortcut Summary](#keyboard-shortcut-summary)
6. [Data Contract Summary](#data-contract-summary)

---

## State Inventory

| # | State ID | Short Description |
|---|----------|-------------------|
| 1 | `results.loading` | Aggregating results from `QaScenarioCompleted` events |
| 2 | `results.summary` | Overview dashboard — pass/fail ring, counts, actions |
| 3 | `results.all-pass` | All scenarios passed — summary with celebration variant |
| 4 | `results.has-failures` | One or more non-pass verdicts — failures prominent |
| 5 | `results.card.collapsed` | Scenario result card in closed (header-only) state |
| 6 | `results.card.expanded` | Scenario card open — expectations, diff, diagnostics |
| 7 | `results.card.events` | Event timeline sub-view inside an expanded card |
| 8 | `results.preview` | PR comment preview modal (rendered markdown) |
| 9 | `results.posting` | Posting results to ADO PR thread |
| 10 | `results.posted` | Successfully posted — shows thread link |
| 11 | `results.post-failed` | ADO API error — retry / clipboard fallback |
| 12 | `results.rerunning` | Transitioning back to execution stage |
| 13 | `results.comparing` | Side-by-side comparison with a previous run |
| 14 | `results.exporting` | Generating JUnit XML or JSON export |
| 15 | `results.export-complete` | Export finished — download link ready |
| 16 | `results.history` | Run history list for the current PR |

---

## State Definitions

### S01: `results.loading`

| Field | Value |
|-------|-------|
| **State name** | `results.loading` |
| **Entry conditions** | `QaRunCompleted` event received on the `qa` SignalR topic, OR all `QaScenarioCompleted` events received and run summary assembled by `ResultsController`. Previous stage must be `executing` (or reconnect recovery via `QaGetRunDetail`). |
| **Exit conditions** | `QaRunResult` fully assembled in `QaPanelState.lastResult` with all scenario results populated from the accumulated `QaScenarioCompleted` events. `summary.overallPass` determines target state. |
| **Visual description** | Spinner centered in results area. Label: "Aggregating results..." with a progress fraction "12/12 scenarios". If partial (reconnect), shows "Recovering results..." instead. No action buttons visible. |
| **Keyboard shortcuts** | None — transient state, typically <500ms. |
| **Data requirements** | `QaRunResult` (assembling). Individual `QaScenarioResult` objects from the execution stage already in `QaPanelState.scenarios`. `QaRunSummary` from `QaRunCompleted` event. `QaPerformanceReport` from same event. |
| **Transitions** | `results.all-pass` — when `summary.overallPass === true` (zero failures, zero crashes). `results.has-failures` — when `summary.overallPass === false`. `results.summary` — fallback if verdict cannot be determined (edge: cancelled run with zero scenarios executed). |
| **Error recovery** | If `QaRunCompleted` never arrives (backend crash): 10s timeout, then call `QaGetRunDetail(runId)`. If that also fails, show inline error "Results incomplete — execution may have crashed" with "View partial results" button that forces transition to `results.has-failures` with whatever scenario data is available. |

---

### S02: `results.summary`

| Field | Value |
|-------|-------|
| **State name** | `results.summary` |
| **Entry conditions** | Run completed but with ambiguous verdict (e.g., cancelled with zero executed scenarios, or all scenarios skipped). Fallback from `results.loading` when `summary.total === 0` or `cancelledByUser === true` before any scenario ran. |
| **Exit conditions** | User clicks "Re-run All" or "Back to Scenarios". Or navigates to history. |
| **Visual description** | Summary header with zeroed counts. Badge: "NO RESULTS" (muted). Ring SVG empty (gray stroke only). Body text: "Run was cancelled before any scenarios executed." Footer: [ Re-run All ] [ Back to Scenarios ]. |
| **Keyboard shortcuts** | `R` — Re-run All. `Escape` — Back to Scenarios (curation stage). |
| **Data requirements** | `QaRunResult` with `summary.total === 0` or `cancelledByUser === true`. |
| **Transitions** | `results.rerunning` — on "Re-run All". Curation stage — on "Back to Scenarios" (stage transition to `curating`). |
| **Error recovery** | N/A — this is itself a recovery state. |

---

### S03: `results.all-pass`

| Field | Value |
|-------|-------|
| **State name** | `results.all-pass` |
| **Entry conditions** | `results.loading` completed with `summary.overallPass === true`. All scenarios have `verdict === 'passed'`. |
| **Exit conditions** | User initiates any action: post to PR, re-run, export, compare, or navigate away. |
| **Visual description** | Summary header with green accent. Large number: "12 / 12". Label: "scenarios passed". Badge: "ALL PASSED" (green background `var(--ok)`). Ring SVG fully green. Coverage bar 100% green. Stats line: "12 passed ● 0 failed ● 32.4s total". Below: collapsed scenario cards (all green checkmarks). Footer actions: [ Post to PR ] (primary) [ Re-run All ] (ghost) [ Export ] (ghost). "Post to PR" is prominent since all-pass is the ideal posting moment. |
| **Keyboard shortcuts** | `P` — Post to PR (opens preview first). `R` — Re-run All. `E` — Export results. `H` — Toggle run history. `J` / `K` — Navigate between scenario cards. `Enter` — Expand focused card. `1`-`9` — Jump to scenario card by index. |
| **Data requirements** | `QaRunResult` fully populated. All `QaScenarioResult` entries with `verdict === 'passed'`. `QaPerformanceReport` for stats. PR metadata (`prId`, `prTitle`, `prUrl`) for post button. |
| **Transitions** | `results.preview` — on `P` or click "Post to PR". `results.rerunning` — on `R` or click "Re-run All". `results.exporting` — on `E` or click "Export". `results.comparing` — on "Compare" (if run history exists). `results.card.expanded` — on card click or `Enter`. `results.history` — on `H` or click history icon. |
| **Error recovery** | N/A — display-only state with no failure modes. |

---

### S04: `results.has-failures`

| Field | Value |
|-------|-------|
| **State name** | `results.has-failures` |
| **Entry conditions** | `results.loading` completed with `summary.overallPass === false`. At least one scenario has verdict `failed`, `timed_out`, `crashed`, or `partial`. |
| **Exit conditions** | User initiates any action: post to PR, re-run, re-run failed, export, compare, or navigate away. |
| **Visual description** | Summary header with red accent on the failure count. Large number: "10 / 12". Label: "scenarios passed". Badge: "FAILED" (red background `var(--fail)`). Ring SVG partial (green arc + red arc proportional to pass/fail). Coverage bar split green/red. Stats line: "10 passed ● 1 failed ● 1 timed out ● 2m 23s total". Scenario cards: failed/timed-out cards auto-expanded at top, passed cards collapsed below. Footer actions: [ Re-run Failed ] (primary — `var(--fail)` accent) [ Post to PR ] (ghost) [ Re-run All ] (ghost) [ Export ] (ghost). "Re-run Failed" is prominent since fixing failures is the priority. |
| **Keyboard shortcuts** | `F` — Re-run Failed only. `P` — Post to PR (opens preview). `R` — Re-run All. `E` — Export results. `H` — Toggle run history. `J` / `K` — Navigate between scenario cards. `Enter` — Expand/collapse focused card. `N` — Jump to next failed card. `Shift+N` — Jump to previous failed card. `1`-`9` — Jump to card by index. |
| **Data requirements** | `QaRunResult` fully populated. Mixed verdicts in `QaScenarioResult[]`. `QaExpectationResult[]` with failure details for non-pass scenarios. `closestMiss` and `failureReason` fields populated by C05-S05 diagnostics. `QaPerformanceReport`. PR metadata. |
| **Transitions** | `results.preview` — on `P`. `results.rerunning` — on `F` (failed only) or `R` (all). `results.exporting` — on `E`. `results.comparing` — on "Compare". `results.card.expanded` — on card click or `Enter`. `results.history` — on `H`. |
| **Error recovery** | If scenario results are incomplete (some `QaScenarioCompleted` events missed during disconnect), show banner: "Some results may be incomplete — [Refresh]". Refresh calls `QaGetRunDetail(runId)` and rehydrates. |

---

### S05: `results.card.collapsed`

| Field | Value |
|-------|-------|
| **State name** | `results.card.collapsed` |
| **Entry conditions** | Default state for passed scenario cards in `results.has-failures`. All cards start collapsed in `results.all-pass`. Failed cards may be collapsed by user after initial auto-expand. |
| **Exit conditions** | User clicks the card header, presses `Enter` on focused card, or presses `1`-`9` to jump to a card. |
| **Visual description** | Single-line row: [ icon ] [ scenario title ] [ category badge ] [ duration ]. Icon: green checkmark for passed, red cross for failed, orange clock for timed_out, yellow triangle for partial, skull for crashed. Category badge: "HAPPY" / "ERROR" / "EDGE" / "PERF" with category-specific color. Duration right-aligned. `aria-expanded="false"` on the header button. |
| **Keyboard shortcuts** | `Enter` — Expand this card (transition to `results.card.expanded`). `Space` — Same as Enter. `J` — Move focus to next card. `K` — Move focus to previous card. |
| **Data requirements** | `QaScenarioResult.scenarioId`, `.title`, `.category`, `.verdict`, `.durationMs`. |
| **Transitions** | `results.card.expanded` — on click/Enter/Space. |
| **Error recovery** | N/A — pure display state. |

---

### S06: `results.card.expanded`

| Field | Value |
|-------|-------|
| **State name** | `results.card.expanded` |
| **Entry conditions** | User expands a collapsed card. Failed cards auto-expand on initial render in `results.has-failures`. |
| **Exit conditions** | User collapses the card (click header, press `Escape`), or navigates to event timeline. |
| **Visual description** | Card header (same as collapsed but `aria-expanded="true"`). Below header: expectation list. Each expectation row: [ status icon ] [ description ] [ match latency ]. For failed expectations: diff panel shows "EXPECTED" vs "OBSERVED" columns (see wireframe). `closestMiss` event rendered in the OBSERVED column. `failureReason` as a text block below the diff. If `errorMessage` is non-null (crashed scenario): red banner with the error text. Footer of expanded card: [ View Events ] button to show event timeline. Max-height on diff panel with overflow scroll; "Show more" expander if >20 expectation lines. |
| **Keyboard shortcuts** | `Escape` — Collapse card (return to `results.card.collapsed`). `T` — Open event timeline (`results.card.events`). `Tab` / `Shift+Tab` — Navigate between expectation rows within the card. `C` — Copy failure details to clipboard. |
| **Data requirements** | `QaScenarioResult` with full `expectations[]` array. Each `QaExpectationResult` with `.status`, `.description`, `.matchedEvent`, `.closestMiss`, `.failureReason`, `.matchLatencyMs`. `.errorMessage` for crashed scenarios. |
| **Transitions** | `results.card.collapsed` — on Escape or header click. `results.card.events` — on `T` or "View Events" click. |
| **Error recovery** | If `expectations` array is empty (crashed before evaluation): show "Scenario crashed before expectations could be evaluated" with the `errorMessage`. If `closestMiss` is null on a failed expectation: show "No similar events captured" instead of the OBSERVED column. |

---

### S07: `results.card.events`

| Field | Value |
|-------|-------|
| **State name** | `results.card.events` |
| **Entry conditions** | User clicks "View Events" or presses `T` from an expanded card. Evidence data loaded via `QaGetRunDetail` if not already in memory (the `QaScenarioCompleted` SignalR event does NOT include `capturedEvents` — only `eventsCaptured` count). |
| **Exit conditions** | User closes the timeline (Escape), or collapses the parent card. |
| **Visual description** | Replaces the expectation list inside the expanded card with a vertical timeline. Each event: timestamp (relative to scenario start), topic badge, one-line summary of the event data. Events that matched an expectation are highlighted green. Events identified as `closestMiss` are highlighted amber. Filter bar at top: filter by topic (dropdown), search events (text input). Event count shown: "47 events captured". Timeline is virtualized — only visible events rendered (performance for 50K event scenarios). |
| **Keyboard shortcuts** | `Escape` — Back to expanded card (expectations view). `F` — Focus the filter/search input. `J` / `K` — Scroll through events. `/` — Open search within events. |
| **Data requirements** | Full `capturedEvents[]` array for the scenario. Loaded via `QaGetRunDetail(runId)` RPC on first access (lazy load). `QaExpectationResult[].matchedEvent.sequenceId` for highlighting matched events. `QaExpectationResult[].closestMiss.sequenceId` for amber highlighting. |
| **Transitions** | `results.card.expanded` — on Escape (back to expectations view). `results.card.collapsed` — if parent card is collapsed while in events view. |
| **Error recovery** | If `QaGetRunDetail` fails (network error): show "Failed to load event timeline — [Retry]" inline. If evidence sidecar file is missing (deleted by retention cleanup): "Event data no longer available (run older than 30 days)." |

---

### S08: `results.preview`

| Field | Value |
|-------|-------|
| **State name** | `results.preview` |
| **Entry conditions** | User presses `P` or clicks "Post to PR" from `results.all-pass` or `results.has-failures`. PR metadata (`prId`, `prUrl`) must be available in `QaPanelState`. |
| **Exit conditions** | User confirms "Post" (transitions to `results.posting`), cancels (returns to previous state), or copies to clipboard. |
| **Visual description** | Modal overlay with dark scrim. Title: "PR Comment Preview". Body: rendered markdown preview matching the ADO comment format from C05-S03 (header, summary table, failure details in collapsible sections, unobservable paths, performance table, footer). Below preview: [ Post to PR ] (primary) [ Copy to Clipboard ] (ghost) [ Cancel ] (ghost). Preview is scrollable if content exceeds viewport. Character count shown: "2,847 / 150,000 chars" (ADO limit). |
| **Keyboard shortcuts** | `Enter` — Post to PR. `Escape` — Cancel / close modal. `Ctrl+C` — Copy to clipboard (when modal focused). |
| **Data requirements** | `QaRunResult` for formatting. PR metadata (`prId`, `prTitle`, `prUrl`). Formatted markdown string from `_renderCommentPreview(results)`. Character count for ADO limit check. |
| **Transitions** | `results.posting` — on "Post to PR" click or `Enter`. Previous state (`results.all-pass` or `results.has-failures`) — on Cancel/Escape. (stays in `results.preview`) — on "Copy to Clipboard" (toast confirmation, modal stays open). |
| **Error recovery** | If markdown generation fails (malformed data): show raw JSON fallback with warning "Preview rendering failed — raw data shown". If character count exceeds 130,000: show warning "Comment may be truncated for large PRs" and auto-truncate failure details to top 5. |

---

### S09: `results.posting`

| Field | Value |
|-------|-------|
| **State name** | `results.posting` |
| **Entry conditions** | User confirmed "Post to PR" from `results.preview`. SignalR RPC `connection.invoke('PostQAResults', prNumber, results)` initiated. |
| **Exit conditions** | RPC returns success (thread ID) or failure (error). |
| **Visual description** | Modal remains open. "Post to PR" button replaced with spinner + "Posting...". Cancel and Copy buttons disabled. Small progress text: "Creating PR comment thread..." then "Setting PR status check..." (two-step from C05-S04). |
| **Keyboard shortcuts** | None — transient state, buttons disabled. `Escape` blocked during posting. |
| **Data requirements** | Active SignalR connection. Valid PAT with `Code (Read)` + `Pull Request Threads (Read & Write)` scope. `prId` and formatted markdown. |
| **Transitions** | `results.posted` — on success. `results.post-failed` — on error. |
| **Error recovery** | 15s timeout on the RPC call. If exceeded: transition to `results.post-failed` with "Request timed out". |

---

### S10: `results.posted`

| Field | Value |
|-------|-------|
| **State name** | `results.posted` |
| **Entry conditions** | `PostQAResults` RPC returned successfully with a `threadId`. |
| **Exit conditions** | User dismisses the modal or clicks the thread link. Auto-dismiss after 5s if no interaction. |
| **Visual description** | Modal shows success state. Green checkmark icon. "Results posted to PR #12345". Link: "View comment thread" (opens ADO PR in browser). "PR status updated: EDOG QA — [PASSED/FAILED]". Footer: [ Done ] (primary) [ View in PR ] (ghost, opens link). |
| **Keyboard shortcuts** | `Enter` or `Escape` — Dismiss modal, return to results dashboard. `V` — Open PR thread link in browser. |
| **Data requirements** | `threadId` from the API response. `prUrl` for constructing the direct link. |
| **Transitions** | `results.all-pass` or `results.has-failures` — on dismiss (returns to whichever dashboard variant was active). |
| **Error recovery** | N/A — success state. If the "View in PR" link fails to open: toast "Could not open browser. URL copied to clipboard." |

---

### S11: `results.post-failed`

| Field | Value |
|-------|-------|
| **State name** | `results.post-failed` |
| **Entry conditions** | `PostQAResults` RPC returned an error. Common causes: 401/403 (PAT expired or insufficient scope), 404 (PR not found / repo mismatch), network error, timeout. |
| **Exit conditions** | User retries, copies to clipboard, or dismisses. |
| **Visual description** | Modal shows error state. Red warning icon. Error message: specific text based on HTTP status. 401/403: "PAT needs Code (Read) + Pull Request Threads (Read & Write) scope." 404: "PR #12345 not found. Verify the PR is still open." Network: "Network error. Check connectivity." Timeout: "Request timed out after 15s." Footer: [ Retry ] (primary) [ Copy to Clipboard ] (ghost) [ Cancel ] (ghost). The formatted markdown is preserved — clipboard fallback always works. |
| **Keyboard shortcuts** | `R` — Retry posting. `C` — Copy markdown to clipboard. `Escape` — Dismiss modal. |
| **Data requirements** | Error details from the failed RPC. Original formatted markdown (preserved for retry/clipboard). `prId` for retry. |
| **Transitions** | `results.posting` — on Retry. `results.preview` — on Cancel (back to preview with markdown still loaded). `results.all-pass` or `results.has-failures` — on Escape (dismiss entirely). |
| **Error recovery** | Retry uses the same markdown (no re-render). If retry also fails: increment attempt counter shown in UI "Attempt 2 of 3". After 3 failures: disable Retry, show "Copy to clipboard and post manually" as the primary action. Store pending markdown to `~/.edog/qa/results/{runId}-pending-post.md` for later retry. |

---

### S12: `results.rerunning`

| Field | Value |
|-------|-------|
| **State name** | `results.rerunning` |
| **Entry conditions** | User clicked "Re-run All" or "Re-run Failed" from the results dashboard. |
| **Exit conditions** | Stage transition to curation (`curating`) or execution (`executing`) complete. |
| **Visual description** | Brief transition overlay: "Preparing re-run..." with spinner. For "Re-run Failed": text shows "Re-running 2 failed scenarios". For "Re-run All": "Re-running all 12 scenarios". Duration: typically <1s. |
| **Keyboard shortcuts** | None — transient state. |
| **Data requirements** | For "Re-run Failed": list of `scenarioId` values where `verdict !== 'passed'`. For "Re-run All": full `scenarios[]` from the original run. Current results preserved in `QaPanelState.lastResult` for comparison after re-run. |
| **Transitions** | Curation stage (`curating`) — for "Re-run Failed" (pre-selects failed scenarios in curation). Execution stage (`executing`) — for "Re-run All" if user opts to skip curation (Shift+R shortcut). |
| **Error recovery** | If stage transition fails (SignalR disconnect during transition): show toast "Re-run failed — connection lost" and return to previous results state. Results data is preserved. |

---

### S13: `results.comparing`

| Field | Value |
|-------|-------|
| **State name** | `results.comparing` |
| **Entry conditions** | User clicked "Compare" from results dashboard and selected a previous run from history. Requires at least 2 runs for the same PR (current + one historical). |
| **Exit conditions** | User closes the comparison view. |
| **Visual description** | Split view: left column = current run, right column = selected previous run. Header shows run IDs and timestamps. Per-scenario rows: status icon for each run side-by-side. Regressions highlighted: scenario that passed previously but failed now gets a red "REGRESSION" badge. Fixes highlighted: scenario that failed previously but passed now gets a green "FIXED" badge. New scenarios (not in previous run) marked "NEW". Summary delta at top: "+2 passed, -1 failed" style diff. |
| **Keyboard shortcuts** | `Escape` — Close comparison, return to results dashboard. `J` / `K` — Navigate scenario rows. `Enter` — Expand a scenario to see both runs' expectation details. `[` / `]` — Switch which historical run to compare against (if multiple exist). |
| **Data requirements** | Current `QaRunResult`. Historical `QaRunResult` loaded via `QaGetRunDetail(runId)`. Scenario ID matching between runs (by `scenarioId` field). Regression detection logic from C05-S07. |
| **Transitions** | `results.all-pass` or `results.has-failures` — on Escape (return to dashboard). `results.history` — on clicking "Choose different run" link. |
| **Error recovery** | If historical run cannot be loaded (deleted by retention): "Run data no longer available (older than 30 days)". Falls back to results dashboard. |

---

### S14: `results.exporting`

| Field | Value |
|-------|-------|
| **State name** | `results.exporting` |
| **Entry conditions** | User pressed `E` or clicked "Export" from results dashboard. Format selection dropdown shown: JUnit XML, JSON, Markdown. |
| **Exit conditions** | Export generation complete (transition to `results.export-complete`) or user cancels. |
| **Visual description** | Small dropdown overlay near the Export button with format options. On selection: button shows spinner + "Generating JUnit XML...". Export happens client-side (no RPC needed — data already in memory). |
| **Keyboard shortcuts** | `1` — JUnit XML. `2` — JSON. `3` — Markdown. `Escape` — Cancel format selection. |
| **Data requirements** | `QaRunResult` in memory. JUnit XML schema for test suite/test case mapping. |
| **Transitions** | `results.export-complete` — on successful generation. Previous results state — on Cancel. |
| **Error recovery** | Export is client-side, unlikely to fail. If `QaRunResult` is malformed: toast "Export failed — invalid result data" and return to dashboard. |

---

### S15: `results.export-complete`

| Field | Value |
|-------|-------|
| **State name** | `results.export-complete` |
| **Entry conditions** | Export file generated successfully. Blob URL created. |
| **Exit conditions** | User clicks download link, or state auto-clears after 10s. |
| **Visual description** | Toast notification: "Export ready — [Download JUnit XML]". Download link triggers browser save dialog. Toast auto-dismisses after 10s. File naming: `edog-qa-{runId}.{xml|json|md}`. |
| **Keyboard shortcuts** | `D` — Trigger download. `Escape` — Dismiss toast. |
| **Data requirements** | Generated file as Blob URL. File name. File size for display. |
| **Transitions** | Previous results state — toast dismisses, no state change needed. |
| **Error recovery** | If blob URL creation fails (memory pressure): fall back to copying content to clipboard with toast "Copied to clipboard (download unavailable)". |

---

### S16: `results.history`

| Field | Value |
|-------|-------|
| **State name** | `results.history` |
| **Entry conditions** | User pressed `H` or clicked the history icon from results dashboard. Triggers `QaGetRunHistory` RPC with current `prId`. |
| **Exit conditions** | User selects a run to compare, closes the panel, or navigates to a specific historical run. |
| **Visual description** | Side panel slides in from right (320px wide). Header: "Run History — PR #12345". List of past runs: each row shows run ID, timestamp, verdict badge, pass/fail counts, duration. Current run highlighted with "CURRENT" badge. Clicking a historical run opens `results.comparing`. Empty state: "No previous runs for this PR." Loading state: skeleton rows while `QaGetRunHistory` resolves. |
| **Keyboard shortcuts** | `Escape` — Close history panel. `J` / `K` — Navigate history list. `Enter` — Select run for comparison. |
| **Data requirements** | `QaRunSummary[]` from `QaGetRunHistory` RPC. Current `prId`. Each summary: `runId`, `startedAt`, `summary.total`, `summary.passed`, `summary.failed`, `overallPass`. |
| **Transitions** | `results.comparing` — on selecting a historical run. Previous results state — on Escape/close. |
| **Error recovery** | If `QaGetRunHistory` fails: show "Failed to load history — [Retry]" inline. If returns empty: "No previous runs for this PR" (not an error). |

---

## Transition Diagram

```
                           QaRunCompleted
                                |
                                v
                      +------------------+
                      | results.loading  |
                      +------------------+
                       /        |        \
            overallPass    cancelled/   overallPass
              =true       zero runs     =false
                /           |              \
               v            v               v
    +-----------------+ +---------+ +--------------------+
    | results.all-pass| | results | | results.has-failures|
    |                 | | .summary| |                    |
    +-----------------+ +---------+ +--------------------+
         |   |   |   |       |        |   |   |   |   |
         |   |   |   |       |        |   |   |   |   |
         |   |   |   +-------+--------+   |   |   |   |
         |   |   |           |            |   |   |   |
         |   |   |     card click/Enter   |   |   |   |
         |   |   |           |            |   |   |   |
         |   |   |           v            |   |   |   |
         |   |   |  +------------------+  |   |   |   |
         |   |   |  | .card.collapsed  |<-+   |   |   |
         |   |   |  +------------------+      |   |   |
         |   |   |     |          ^           |   |   |
         |   |   |  Enter/click  Esc          |   |   |
         |   |   |     v          |           |   |   |
         |   |   |  +------------------+      |   |   |
         |   |   |  | .card.expanded   |      |   |   |
         |   |   |  +------------------+      |   |   |
         |   |   |     |          ^           |   |   |
         |   |   |    T/View     Esc          |   |   |
         |   |   |   Events       |           |   |   |
         |   |   |     v          |           |   |   |
         |   |   |  +------------------+      |   |   |
         |   |   |  | .card.events     |      |   |   |
         |   |   |  +------------------+      |   |   |
         |   |   |                            |   |   |
         |   |   +------- P (Post to PR) -----+   |   |
         |   |               |                    |   |
         |   |               v                    |   |
         |   |     +------------------+           |   |
         |   |     | results.preview  |           |   |
         |   |     +------------------+           |   |
         |   |        |            |              |   |
         |   |     Confirm      Cancel            |   |
         |   |        v            |              |   |
         |   |     +------------------+           |   |
         |   |     | results.posting  |           |   |
         |   |     +------------------+           |   |
         |   |       |            |               |   |
         |   |    success       error             |   |
         |   |       v            v               |   |
         |   |  +----------+ +---------------+    |   |
         |   |  | .posted  | | .post-failed  |    |   |
         |   |  +----------+ +---------------+    |   |
         |   |       |            |               |   |
         |   |    dismiss    retry/dismiss         |   |
         |   |       |            |               |   |
         |   |       v            v               |   |
         |   |   (back to dashboard)              |   |
         |   |                                    |   |
         |   +-------- R / F (Re-run) ------------+   |
         |               |                            |
         |               v                            |
         |     +------------------+                   |
         |     | results.rerunning|                   |
         |     +------------------+                   |
         |               |                            |
         |         (stage transition                   |
         |          to curating/executing)             |
         |                                            |
         +-------- E (Export) -------------------------+
         |               |
         |               v
         |     +------------------+
         |     | results.exporting|
         |     +------------------+
         |               |
         |            complete
         |               v
         |     +---------------------+
         |     | results.export-     |
         |     |        complete     |
         |     +---------------------+
         |               |
         |          auto-dismiss
         |               v
         |         (back to dashboard)
         |
         +-------- H (History) ---------+
                       |                |
                       v                |
              +------------------+      |
              | results.history  |      |
              +------------------+      |
                       |                |
                  select run            |
                       v                |
              +------------------+      |
              | results.comparing|------+
              +------------------+   Esc
```

---

## ASCII Wireframes

### Summary Dashboard — All Pass Variant

```
+----------------------------------------------------------------------+
|  RESULTS                                                   [H] [X]   |
+----------------------------------------------------------------------+
|                                                                      |
|   +------------------------------------------------------------+     |
|   |                                                      ____  |     |
|   |   12 / 12              ALL PASSED                   /    \ |     |
|   |   scenarios passed                                 | //// ||     |
|   |                                                    | //// ||     |
|   |   12 passed ● 0 failed ● 32.4s total               \____/ |     |
|   |   [========================================] 100%    ring  |     |
|   +------------------------------------------------------------+     |
|                                                                      |
|   +------------------------------------------------------------+     |
|   | [checkmark] WriteFileAsync writes to correct path   HAPPY  3.2s |
|   +------------------------------------------------------------+     |
|   | [checkmark] OneLake 429 triggers backoff retry      ERROR  8.4s |
|   +------------------------------------------------------------+     |
|   | [checkmark] Concurrent writes serialize correctly   EDGE  12.1s |
|   +------------------------------------------------------------+     |
|   | [checkmark] WriteFileAsync completes within SLA     PERF   5.2s |
|   +------------------------------------------------------------+     |
|   :  ... (8 more collapsed cards)                                :   |
|                                                                      |
|   +------------------------------------------------------------+     |
|   | [ Post to PR ]    [ Re-run All ]    [ Export ]             |     |
|   +------------------------------------------------------------+     |
+----------------------------------------------------------------------+
```

### Summary Dashboard — Has Failures Variant

```
+----------------------------------------------------------------------+
|  RESULTS                                                   [H] [X]   |
+----------------------------------------------------------------------+
|                                                                      |
|   +------------------------------------------------------------+     |
|   |                                                      ____  |     |
|   |   10 / 12              FAILED                       /    \ |     |
|   |   scenarios passed                                 | ///  ||     |
|   |                                                    | / XX ||     |
|   |   10 passed ● 1 failed ● 1 timed out ● 2m 23s      \____/ |     |
|   |   [================================    ====] 83%     ring  |     |
|   +------------------------------------------------------------+     |
|                                                                      |
|   FAILED (2)                                                         |
|   +------------------------------------------------------------+     |
|   | [cross] OneLake 429 triggers backoff retry   ERROR   30.0s |     |
|   |   +--------------------------------------------------------+     |
|   |   |  exp-1  [checkmark]  PUT request initiated       210ms |     |
|   |   |  exp-2  [checkmark]  429 response intercepted    340ms |     |
|   |   |  exp-3  [cross]      Retry with backoff               |     |
|   |   |         +------------------------------------------+  |     |
|   |   |         | EXPECTED          | OBSERVED             |  |     |
|   |   |         |-------------------+----------------------|  |     |
|   |   |         | HTTP 201 after    | HTTP 500 to same URL |  |     |
|   |   |         | retry attempts    | (stale token, no     |  |     |
|   |   |         |                   |  refresh triggered)  |  |     |
|   |   |         +------------------------------------------+  |     |
|   |   |  Suggestion: Check MaxRetryAttempts config value.     |     |
|   |   |                                    [ View Events ]    |     |
|   |   +--------------------------------------------------------+     |
|   +------------------------------------------------------------+     |
|   | [clock] Large file write with partition   ERROR   60.0s  > |     |
|   +------------------------------------------------------------+     |
|                                                                      |
|   PASSED (10)                                                        |
|   +------------------------------------------------------------+     |
|   | [checkmark] WriteFileAsync writes to correct path  HAPPY  3.2s  |
|   +------------------------------------------------------------+     |
|   :  ... (9 more collapsed cards)                                :   |
|                                                                      |
|   +------------------------------------------------------------+     |
|   | [ Re-run Failed ]  [ Post to PR ]  [ Re-run All ] [ Export ]|    |
|   +------------------------------------------------------------+     |
+----------------------------------------------------------------------+
```

### Failure Detail Card — Expanded

```
+----------------------------------------------------------------------+
| [cross] scn-retry-on-429-throttle                   ERROR    30.0s   |
|   OneLake 429 triggers exponential backoff retry                     |
+----------------------------------------------------------------------+
|                                                                      |
|   Expectations (3)                                                   |
|   +-----------------------------------------------------------------+|
|   | [checkmark] exp-1  PUT request to OneLake initiated     210ms   ||
|   +-----------------------------------------------------------------+|
|   | [checkmark] exp-2  429 response intercepted by handler  340ms   ||
|   +-----------------------------------------------------------------+|
|   | [cross]    exp-3  HTTP 201 after retry attempts           --    ||
|   |                                                                 ||
|   |  +----------------------------+-----------------------------+   ||
|   |  | EXPECTED                   | OBSERVED                    |   ||
|   |  |----------------------------+-----------------------------|   ||
|   |  | statusCode == 201          | statusCode: 500             |   ||
|   |  | url contains               | url: "https://dfs.fabric    |   ||
|   |  |   "dfs.fabric.microsoft    |   .microsoft.com/..."       |   ||
|   |  |    .com"                   |                             |   ||
|   |  | Token refresh triggered    | No token refresh event      |   ||
|   |  |   before retry             |   captured                  |   ||
|   |  | Retry uses fresh token     | Retry used stale token      |   ||
|   |  |   in Authorization header  |   (expired 200ms prior)     |   ||
|   |  +----------------------------+-----------------------------+   ||
|   |                                                                 ||
|   |  Suggestion: Check if retry count exceeds MaxRetryAttempts      ||
|   |  config value. The retry interceptor recorded 3 attempts but    ||
|   |  the 429 > retry > success chain did not complete.              ||
|   +-----------------------------------------------------------------+|
|                                                                      |
|   47 events captured                                                 |
|   [ View Events ]    [ Copy Failure Details ]                        |
+----------------------------------------------------------------------+
```

### PR Comment Preview Modal

```
+----------------------------------------------------------------------+
|                                                                      |
|   +--------------------------------------------------------------+   |
|   |  PR Comment Preview                              [X] Close   |   |
|   +--------------------------------------------------------------+   |
|   |                                                              |   |
|   |  ## EDOG QA Testing Results                                  |   |
|   |                                                              |   |
|   |  **PR:** #12345 -- Fix WriteFileAsync retry logic            |   |
|   |  **Run:** 2025-06-15 14:30 UTC | Duration: 2m 23s            |   |
|   |                                                              |   |
|   |  ### Summary: 10/12 PASSED ● 1 FAILED ● 1 TIMED OUT         |   |
|   |                                                              |   |
|   |  | # | Scenario           | Result   | Duration |            |   |
|   |  |---|--------------------+----------+----------|            |   |
|   |  | 1 | WriteFileAsync ... | ● PASS   | 8.4s     |            |   |
|   |  | 2 | OneLake 429 ...   | ● FAIL   | 30.0s    |            |   |
|   |  : ... (scrollable)                              :            |   |
|   |                                                              |   |
|   |  > FAIL -- scn-retry-on-429-throttle              [expand]   |   |
|   |  > TIMEOUT -- scn-large-file-partition             [expand]   |   |
|   |                                                              |   |
|   |  *Generated by EDOG Studio F27*                              |   |
|   +--------------------------------------------------------------+   |
|   |  2,847 / 150,000 chars                                       |   |
|   |  [ Post to PR ]     [ Copy to Clipboard ]     [ Cancel ]     |   |
|   +--------------------------------------------------------------+   |
|                                                                      |
+----------------------------------------------------------------------+
```

---

## Keyboard Shortcut Summary

| Key | Context | Action |
|-----|---------|--------|
| `P` | Dashboard | Open PR comment preview |
| `R` | Dashboard | Re-run all scenarios |
| `F` | Dashboard (has failures) | Re-run failed scenarios only |
| `Shift+R` | Dashboard | Re-run all, skip curation |
| `E` | Dashboard | Open export format picker |
| `H` | Dashboard | Toggle run history panel |
| `J` | Dashboard / History / Events | Move focus down |
| `K` | Dashboard / History / Events | Move focus up |
| `N` | Dashboard (has failures) | Jump to next failed card |
| `Shift+N` | Dashboard (has failures) | Jump to previous failed card |
| `1`-`9` | Dashboard | Jump to scenario card by index |
| `Enter` | Collapsed card | Expand card |
| `Enter` | Preview modal | Post to PR |
| `Enter` | History panel | Select run for comparison |
| `Escape` | Expanded card | Collapse card |
| `Escape` | Events view | Back to expanded card |
| `Escape` | Any modal | Close modal |
| `Escape` | History / Comparison | Close panel |
| `Space` | Collapsed card | Expand card (same as Enter) |
| `T` | Expanded card | Open event timeline |
| `C` | Expanded card | Copy failure details |
| `V` | Posted modal | Open PR thread in browser |
| `D` | Export complete toast | Trigger download |
| `/` | Events view | Search events |
| `[` / `]` | Comparison view | Switch historical run |

---

## Data Contract Summary

| State | Primary Data | SignalR RPC | Lazy Loaded |
|-------|-------------|-------------|-------------|
| `results.loading` | `QaScenarioCompleted[]`, `QaRunCompleted` | -- | No |
| `results.summary` | `QaRunResult` (empty) | -- | No |
| `results.all-pass` | `QaRunResult` | -- | No |
| `results.has-failures` | `QaRunResult` | -- | No |
| `results.card.collapsed` | `QaScenarioResult` | -- | No |
| `results.card.expanded` | `QaScenarioResult.expectations[]` | -- | No |
| `results.card.events` | `capturedEvents[]` | `QaGetRunDetail` | **Yes** |
| `results.preview` | Formatted markdown string | -- | No |
| `results.posting` | Markdown + `prId` | `PostQAResults` | No |
| `results.posted` | `threadId` from response | -- | No |
| `results.post-failed` | Error details + markdown | -- | No |
| `results.rerunning` | `scenarioId[]` (failed) | -- | No |
| `results.comparing` | 2x `QaRunResult` | `QaGetRunDetail` | **Yes** |
| `results.exporting` | `QaRunResult` | -- | No |
| `results.export-complete` | Blob URL | -- | No |
| `results.history` | `QaRunSummary[]` | `QaGetRunHistory` | **Yes** |

---

*Pixel out. 16 states, 4 wireframes, full transition map. Every button has a keyboard shortcut, every error has a recovery path.*
