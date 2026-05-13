# P3 State Matrix: Code Analysis Stage (C06-S04)

> **Pixel** -- Senior Frontend Engineer
> Parent: C06 Frontend Panel, Stage S04
> Engine ref: C01 Code Understanding Engine (five-layer architecture)
> Protocol ref: SignalR `QaAnalysisProgress`, `QaAnalysisCancelled`, `QaScenarioGenerated`

---

## Stage Overview

The Code Analysis Stage visualises real-time progress as the five-layer engine
processes a PR diff. Three UI tracks (Structural, Semantic, Scenario Gen) map to
the backend phases. Each track transitions independently through
PENDING --> RUNNING --> DONE | ERROR. The stage auto-advances to Curation when
all required layers complete, or offers partial-result recovery when some fail.

### Backend Phase --> UI Track Mapping

```
Backend phases (SignalR phaseIndex)     UI tracks
-------------------------------------  ----------------------
0  fetching_diff                        (pre-track, global)
1  roslyn_blast_radius  (L1+L2)  -----> Track 1: Structural
2  semantic_analysis    (L3)     -----> Track 2: Semantic
3  di_validation        (L5)     -----> Track 2: Semantic (sub-step)
4  scenario_generation  (L4)     -----> Track 3: Scenario Gen
5  complete                             (post-track, global)
```

---

## State Catalogue (14 states)

### S01 -- `analysis.starting`

| Field | Value |
|-------|-------|
| **State name** | `analysis.starting` |
| **Entry conditions** | User clicked "Analyze" in PR Selection stage (S03). `StartQAAnalysis` invoked on SignalR hub. |
| **Exit conditions** | First `QaAnalysisProgress` event received with `phase: "fetching_diff"`, OR 10s timeout with no event. |
| **Visual description** | Three track cards render with staggered 100ms entry animation. All badges show PENDING (muted). A single-line status reads "Fetching PR diff..." with a pulsing dot. No progress bars filled yet. |
| **Keyboard shortcuts** | `Escape` -- cancel analysis (confirm dialog). `Ctrl+Shift+Q` -- open QA panel debug log. |
| **Data requirements** | `prNumber: number`, `correlationId: string` (generated client-side), SignalR connection active. |
| **Transitions** | --> `analysis.graph.building` (on `phase: "roslyn_blast_radius"` event) | --> `analysis.failed` (on connection error or 10s timeout with no response) | --> `analysis.cancelled` (on user Escape + confirm) |
| **Error recovery** | If SignalR disconnects, show reconnect banner. On reconnect invoke `GetQAAnalysisStatus` to restore. If no event after 10s, transition to `analysis.failed` with "Backend did not respond." |

```
+-------------------------------------------------------+
| QA Testing                                    [x]     |
|-------------------------------------------------------|
|  [1 PR]--(2 Analyze)--[3 Curate]--[4 Run]--[5 Report] |
|         ~~~~~~~~~~                                     |
|                                                        |
|  Fetching PR diff...  .                                |
|                                                        |
|  +---------------------------------------------------+ |
|  | +- Structural Graph                      PENDING  | |
|  | |  [                                           ]  | |
|  | |                                                 | |
|  +---------------------------------------------------+ |
|  +---------------------------------------------------+ |
|  | +- Semantic Enrichment                   PENDING  | |
|  | |  [                                           ]  | |
|  | |                                                 | |
|  +---------------------------------------------------+ |
|  +---------------------------------------------------+ |
|  | +- Scenario Generation                   PENDING  | |
|  | |  [                                           ]  | |
|  | |                                                 | |
|  +---------------------------------------------------+ |
|                                          [Cancel]      |
+-------------------------------------------------------+
```

---

### S02 -- `analysis.graph.building`

| Field | Value |
|-------|-------|
| **State name** | `analysis.graph.building` |
| **Entry conditions** | `QaAnalysisProgress` received with `phase: "roslyn_blast_radius"`, `phaseIndex: 1`. |
| **Exit conditions** | Next progress event with `phase: "semantic_analysis"` (phaseIndex 2) arrives, OR error event for this track. |
| **Visual description** | Track 1 badge flips to RUNNING (accent pulse animation). Progress bar fills via `percentComplete`. Subtitle cycles through step text from `detail` field ("Parsing diff...", "Resolving symbols...", "Tracing call graph..."). Tracks 2-3 remain PENDING. |
| **Keyboard shortcuts** | `Escape` -- cancel. `D` -- toggle detail panel (shows filesAnalyzed, linesChanged from metrics). |
| **Data requirements** | `percentComplete: number`, `detail: string`, `metrics.filesAnalyzed`, `metrics.linesChanged`. |
| **Transitions** | --> `analysis.graph.complete` (on receipt of `phase: "semantic_analysis"` event, implying L1+L2 done) | --> `analysis.partial` (on error event with `recoverable: true`) | --> `analysis.failed` (on error event with `recoverable: false`) | --> `analysis.cancelled` (on user cancel) |
| **Error recovery** | Individual track error: mark Track 1 as ERROR, show "Structural analysis failed" in subtitle. If recoverable, offer "Continue without structural graph?" button. |

```
+---------------------------------------------------+
| ◆ Structural Graph                      RUNNING   |
|   [=========>                                  ]   |
|   Tracing call graph... 12 files, 340 lines        |
+---------------------------------------------------+
| ◇ Semantic Enrichment                   PENDING   |
|   [                                            ]   |
|                                                    |
+---------------------------------------------------+
| ● Scenario Generation                   PENDING   |
|   [                                            ]   |
|                                                    |
+---------------------------------------------------+
```

---

### S03 -- `analysis.graph.complete`

| Field | Value |
|-------|-------|
| **State name** | `analysis.graph.complete` |
| **Entry conditions** | `QaAnalysisProgress` with `phase: "semantic_analysis"` received (implies L1+L2 finished). |
| **Exit conditions** | Immediate -- this is a transient state that updates Track 1 visuals then yields to `analysis.semantic.loading`. Duration <200ms. |
| **Visual description** | Track 1 bar snaps to 100%. Badge flips to DONE (green). Subtitle shows summary: "3 impact zones, 47 call sites." Completion shimmer plays once on Track 1 card. Track 2 badge flips to RUNNING simultaneously. |
| **Keyboard shortcuts** | Same as S02. |
| **Data requirements** | `metrics.impactZonesFound` from the last Track 1 progress event. |
| **Transitions** | --> `analysis.semantic.loading` (immediate, automatic) |
| **Error recovery** | N/A -- transient state. |

```
+---------------------------------------------------+
| ◆ Structural Graph                         DONE   |
|   [============================================]   |
|   3 impact zones, 47 call sites                    |
+---------------------------------------------------+
```

---

### S04 -- `analysis.semantic.loading`

| Field | Value |
|-------|-------|
| **State name** | `analysis.semantic.loading` |
| **Entry conditions** | `QaAnalysisProgress` with `phase: "semantic_analysis"` received. OmniSharp warm-up in progress. |
| **Exit conditions** | Progress update with detail indicating enrichment has begun (percentComplete > phase start baseline), OR timeout (60s). |
| **Visual description** | Track 2 badge shows RUNNING with pulse. Subtitle reads "Warming up OmniSharp..." Progress bar shows indeterminate shimmer (CSS `an-bar-shimmer` class). Elapsed timer appears after 10s: "(12s elapsed)". After 30s, muted note: "Semantic analysis can take up to 60s on first run." |
| **Keyboard shortcuts** | `Escape` -- cancel. `S` -- skip semantic layer (confirms: "Continue without semantic enrichment? Accuracy may be reduced.") |
| **Data requirements** | `metrics.elapsedMs` for timer display. |
| **Transitions** | --> `analysis.semantic.enriching` (on progress update showing enrichment started) | --> `analysis.semantic.complete` (on `phase: "di_validation"` event, skipping straight through) | --> `analysis.timeout` (if 60s elapses with no enrichment progress) | --> `analysis.partial` (if user chooses to skip) | --> `analysis.cancelled` (on user cancel) |
| **Error recovery** | If OmniSharp fails to start, backend sends error event. Track 2 shows "OmniSharp unavailable -- continuing with structural graph only." Auto-transitions to `analysis.partial` after 3s. |

```
+---------------------------------------------------+
| ◇ Semantic Enrichment                   RUNNING   |
|   [~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~]  |
|   Warming up OmniSharp...  (15s elapsed)           |
|   Semantic analysis can take up to 60s             |
+---------------------------------------------------+
```

---

### S05 -- `analysis.semantic.enriching`

| Field | Value |
|-------|-------|
| **State name** | `analysis.semantic.enriching` |
| **Entry conditions** | Progress event indicates OmniSharp warm-up complete and enrichment queries executing. |
| **Exit conditions** | `QaAnalysisProgress` with `phase: "di_validation"` (phaseIndex 3) received. |
| **Visual description** | Track 2 progress bar fills deterministically. Subtitle cycles: "Resolving interface dispatch...", "Tracing call hierarchy...", "Enriching type info..." Badge remains RUNNING. |
| **Keyboard shortcuts** | `Escape` -- cancel. `D` -- toggle detail panel. |
| **Data requirements** | `percentComplete`, `detail` string from progress events. |
| **Transitions** | --> `analysis.semantic.complete` (on `phase: "di_validation"` event) | --> `analysis.partial` (on track error, recoverable) | --> `analysis.failed` (on track error, unrecoverable) | --> `analysis.cancelled` (on user cancel) |
| **Error recovery** | Partial solution load: if some projects fail, backend sends progress with reduced metrics. Subtitle appends "(partial -- 3/5 projects loaded)". Analysis continues with available data. |

```
+---------------------------------------------------+
| ◇ Semantic Enrichment                   RUNNING   |
|   [=======================>                    ]   |
|   Resolving interface dispatch... 8/12 methods     |
+---------------------------------------------------+
```

---

### S06 -- `analysis.semantic.complete`

| Field | Value |
|-------|-------|
| **State name** | `analysis.semantic.complete` |
| **Entry conditions** | `QaAnalysisProgress` with `phase: "di_validation"` received (L3 done, L5 starting). |
| **Exit conditions** | Transient (<200ms). Updates Track 2 visuals, then DI validation runs as a sub-step within Track 2 before yielding to LLM. |
| **Visual description** | Track 2 bar at ~85% (DI validation is the final sub-step). Badge stays RUNNING. Subtitle changes to "Validating DI registrations..." |
| **Keyboard shortcuts** | Same as S05. |
| **Data requirements** | None beyond phase transition event. |
| **Transitions** | --> `analysis.di.validating` (immediate) |
| **Error recovery** | N/A -- transient. |

---

### S07 -- `analysis.di.validating`

| Field | Value |
|-------|-------|
| **State name** | `analysis.di.validating` |
| **Entry conditions** | `QaAnalysisProgress` with `phase: "di_validation"` (phaseIndex 3). Backend is querying `EdogDiRegistryCapture` for ground-truth interface-to-impl mappings. |
| **Exit conditions** | `QaAnalysisProgress` with `phase: "scenario_generation"` (phaseIndex 4) received. |
| **Visual description** | Track 2 bar fills to ~95%. Subtitle: "Validating DI registrations... 23 interfaces resolved". This is a sub-step of Track 2 (Semantic). Badge still RUNNING. In disconnected phase, this step is skipped -- subtitle shows "DI validation skipped (not connected)". |
| **Keyboard shortcuts** | `Escape` -- cancel. |
| **Data requirements** | `detail` string, `metrics` (if backend includes DI-specific counts). |
| **Transitions** | --> `analysis.scenarios.generating` (on `phase: "scenario_generation"` event; Track 2 completes to DONE simultaneously) | --> `analysis.partial` (DI registry unavailable -- disconnected phase) | --> `analysis.cancelled` (on user cancel) |
| **Error recovery** | DI registry unavailable (disconnected phase): Track 2 completes with warning badge. Subtitle: "Semantic done (DI validation skipped)". Analysis continues -- L5 results omitted from graph. |

```
+---------------------------------------------------+
| ◆ Structural Graph                         DONE   |
|   [============================================]   |
|   3 impact zones, 47 call sites                    |
+---------------------------------------------------+
| ◇ Semantic Enrichment                   RUNNING   |
|   [========================================>   ]   |
|   Validating DI registrations... 23 interfaces     |
+---------------------------------------------------+
| ● Scenario Generation                   PENDING   |
|   [                                            ]   |
|                                                    |
+---------------------------------------------------+
```

---

### S08 -- `analysis.scenarios.generating`

| Field | Value |
|-------|-------|
| **State name** | `analysis.scenarios.generating` |
| **Entry conditions** | `QaAnalysisProgress` with `phase: "scenario_generation"` (phaseIndex 4). Track 2 flips to DONE. Track 3 activates. `QaScenarioGenerated` events begin streaming. |
| **Exit conditions** | `QaAnalysisProgress` with `phase: "complete"` (phaseIndex 5) received. |
| **Visual description** | Track 2 badge flips to DONE, shimmer plays. Track 3 badge flips to RUNNING. Progress bar fills as scenarios stream in. Subtitle shows live count: "Generating scenarios... 5/~12". A mini scenario list appears below Track 3 showing titles as they arrive (fade-in, max 4 visible, scroll). |
| **Keyboard shortcuts** | `Escape` -- cancel. `Tab` -- focus scenario preview list. `Arrow Down/Up` -- scroll preview list. |
| **Data requirements** | `QaScenarioGenerated` events: `scenarioIndex`, `totalExpected`, `scenario.title`, `scenario.category`. `percentComplete` from `QaAnalysisProgress`. |
| **Transitions** | --> `analysis.complete` (on `phase: "complete"` event) | --> `analysis.partial` (on error during generation, some scenarios produced) | --> `analysis.failed` (on error, zero scenarios produced) | --> `analysis.cancelled` (on user cancel) |
| **Error recovery** | If LLM times out mid-generation, backend sends error event. If scenarioIndex > 0, transition to `analysis.partial` with whatever was generated. If 0 scenarios, transition to `analysis.failed`. |

```
+---------------------------------------------------+
| ◆ Structural Graph                         DONE   |
|   [============================================]   |
|   3 impact zones, 47 call sites                    |
+---------------------------------------------------+
| ◇ Semantic Enrichment                      DONE   |
|   [============================================]   |
|   Enriched 12 methods, 23 DI registrations         |
+---------------------------------------------------+
| ● Scenario Generation                   RUNNING   |
|   [========================>                   ]   |
|   Generating scenarios... 5/~12                    |
|                                                    |
|   +-----------------------------------------------+|
|   |  1. WriteFileAsync writes correct path   OK   ||
|   |  2. Retry policy exponential backoff     OK   ||
|   |  3. DAG node transitions to Completed    OK   ||
|   |  4. Error handling for timeout           OK   ||
|   |  5. Cache invalidation on write           .   ||
|   +-----------------------------------------------+|
+---------------------------------------------------+
```

---

### S09 -- `analysis.complete`

| Field | Value |
|-------|-------|
| **State name** | `analysis.complete` |
| **Entry conditions** | `QaAnalysisProgress` with `phase: "complete"`, `percentComplete: 100`. All three tracks show DONE. |
| **Exit conditions** | Auto-advance to Curation stage (S05) after 800ms celebration delay. |
| **Visual description** | All three track badges green DONE. Track 3 subtitle: "8 scenarios, 22 expectations generated." Global status line: "Analysis complete -- advancing to curation..." with a brief checkmark animation. Toast: "Analysis complete -- 8 scenarios generated" (success). Pipeline progress bar segment 2 fills. |
| **Keyboard shortcuts** | `Enter` -- skip delay, advance to Curation immediately. |
| **Data requirements** | Final `QaAnalysisProgress` metrics, total scenario count from accumulated `QaScenarioGenerated` events. |
| **Transitions** | --> Curation stage (S05) (automatic after 800ms, or on Enter) |
| **Error recovery** | N/A -- terminal success state for this stage. |

```
+---------------------------------------------------+
| ◆ Structural Graph                         DONE   |
|   [============================================]   |
|   3 impact zones, 47 call sites                    |
+---------------------------------------------------+
| ◇ Semantic Enrichment                      DONE   |
|   [============================================]   |
|   Enriched 12 methods, 23 DI registrations         |
+---------------------------------------------------+
| ● Scenario Generation                      DONE   |
|   [============================================]   |
|   8 scenarios, 22 expectations generated           |
+---------------------------------------------------+
|                                                    |
|  Analysis complete -- advancing to curation...     |
+---------------------------------------------------+
```

---

### S10 -- `analysis.partial`

| Field | Value |
|-------|-------|
| **State name** | `analysis.partial` |
| **Entry conditions** | One or more layers failed but at least one produced usable data. Backend sends `QaAnalysisProgress` with `phase: "complete"` and error metadata, OR user chose to skip a layer. |
| **Exit conditions** | User clicks "Continue with partial results" or "Retry failed layers" or "Cancel". |
| **Visual description** | Completed tracks show DONE (green). Failed tracks show WARN (amber badge). A warning card appears below tracks: "Partial analysis -- some layers failed. Results may have reduced accuracy." Two action buttons: "Continue with N scenarios" (primary), "Retry" (secondary). Coverage estimate shown: "~80% accuracy (semantic layer unavailable)". |
| **Keyboard shortcuts** | `Enter` -- continue with partial results. `R` -- retry failed layers. `Escape` -- cancel analysis. |
| **Data requirements** | Per-track status, partial scenario list, error messages for failed tracks. |
| **Transitions** | --> Curation stage (S05) (on "Continue") | --> `analysis.semantic.loading` or `analysis.graph.building` (on "Retry", re-runs only failed layers) | --> `analysis.cancelled` (on user cancel) |
| **Error recovery** | Retry re-invokes only the failed layers via `connection.invoke('RetryQAAnalysisLayers', failedLayers)`. If retry also fails, return to this state with updated error detail. |

```
+---------------------------------------------------+
| ◆ Structural Graph                         DONE   |
|   [============================================]   |
|   3 impact zones, 47 call sites                    |
+---------------------------------------------------+
| ◇ Semantic Enrichment                      WARN   |
|   [======================                      ]   |
|   OmniSharp timed out -- semantic data partial     |
+---------------------------------------------------+
| ● Scenario Generation                      DONE   |
|   [============================================]   |
|   5 scenarios generated (reduced accuracy)         |
+---------------------------------------------------+
|                                                    |
|  /!\ Partial analysis -- accuracy ~80%             |
|  Semantic enrichment failed. Scenarios lack         |
|  interface resolution and DI validation.            |
|                                                    |
|  [Continue with 5 scenarios]    [Retry]   [Cancel] |
+---------------------------------------------------+
```

---

### S11 -- `analysis.failed`

| Field | Value |
|-------|-------|
| **State name** | `analysis.failed` |
| **Entry conditions** | All tracks failed, OR a critical pre-requisite failed (diff fetch, SignalR disconnect with no recovery), OR zero scenarios generated. |
| **Exit conditions** | User clicks "Try Again", "Create Manual Scenarios", or navigates back to PR Selection. |
| **Visual description** | All track badges show ERROR (red) or mixed ERROR/DONE. Full-width error card replaces track area: heading "Analysis Failed", error summary, stack-trace toggle for technical detail (collapsed by default). Three action buttons. |
| **Keyboard shortcuts** | `Enter` -- try again. `M` -- create manual scenarios. `Escape` or `Backspace` -- go back to PR Selection. |
| **Data requirements** | Error messages per track, `QaAnalysisCancelled` event with `reason: "error"`, `phasesCompleted` count. |
| **Transitions** | --> `analysis.starting` (on "Try Again") | --> Curation stage (S05) with empty scenario list (on "Create Manual") | --> PR Selection stage (S03) (on back navigation) |
| **Error recovery** | "Try Again" re-invokes `StartQAAnalysis` from scratch. If failure persists after 3 retries, show "Persistent failure" message with link to diagnostic logs. |

```
+-------------------------------------------------------+
|                                                        |
|   /!\ Analysis Failed                                 |
|                                                        |
|   The code understanding engine could not process      |
|   this PR. 0 of 3 analysis tracks completed.           |
|                                                        |
|   Error: OmniSharp failed to load solution             |
|          /path/to/FabricLiveTable.sln                  |
|                                                        |
|   [v Show technical details]                           |
|                                                        |
|   [Try Again]   [Create Manual Scenarios]   [<- Back]  |
|                                                        |
+-------------------------------------------------------+
```

---

### S12 -- `analysis.cancelled`

| Field | Value |
|-------|-------|
| **State name** | `analysis.cancelled` |
| **Entry conditions** | User pressed Escape and confirmed cancellation. `CancelQAAnalysis` invoked on SignalR hub. `QaAnalysisCancelled` event received with `reason: "user_cancelled"`. |
| **Exit conditions** | User clicks "Analyze Again" or navigates back. |
| **Visual description** | All tracks freeze at current progress. Badges that were RUNNING flip to CANCELLED (grey). Inline message: "Analysis cancelled." Two buttons: "Analyze Again" (re-run), "Back to PR Selection" (navigate back). No toast -- cancellation is quiet. |
| **Keyboard shortcuts** | `Enter` -- analyze again. `Escape` or `Backspace` -- back to PR Selection. |
| **Data requirements** | `QaAnalysisCancelled` event, `phasesCompleted` count. |
| **Transitions** | --> `analysis.starting` (on "Analyze Again") | --> PR Selection stage (S03) (on back navigation) |
| **Error recovery** | If `CancelQAAnalysis` invocation fails (SignalR issue), client-side marks state as cancelled anyway. Backend will eventually time out and clean up. |

```
+---------------------------------------------------+
| ◆ Structural Graph                         DONE   |
|   [============================================]   |
|   3 impact zones, 47 call sites                    |
+---------------------------------------------------+
| ◇ Semantic Enrichment                  CANCELLED   |
|   [=============>                              ]   |
|   Cancelled during warm-up                         |
+---------------------------------------------------+
| ● Scenario Generation                  CANCELLED   |
|   [                                            ]   |
|                                                    |
+---------------------------------------------------+
|                                                    |
|  Analysis cancelled.                               |
|  [Analyze Again]              [<- Back]            |
+---------------------------------------------------+
```

---

### S13 -- `analysis.timeout`

| Field | Value |
|-------|-------|
| **State name** | `analysis.timeout` |
| **Entry conditions** | Total analysis time exceeds 120s, OR a single layer exceeds its timeout (OmniSharp: 60s, LLM: 30s, graph: 15s). Backend sends `QaAnalysisCancelled` with `reason: "timeout"`. |
| **Exit conditions** | User clicks "Retry", "Continue with partial results" (if any), or navigates back. |
| **Visual description** | Timed-out track badge flips to TIMEOUT (amber). Elapsed time displayed prominently: "Analysis timed out after 2m 04s." If partial data exists, "Continue with partial results" is offered. |
| **Keyboard shortcuts** | `Enter` -- retry. `C` -- continue with partial (if available). `Escape` -- back. |
| **Data requirements** | `QaAnalysisCancelled` event with `reason: "timeout"`, `phasesCompleted`, elapsed time. |
| **Transitions** | --> `analysis.starting` (on "Retry") | --> `analysis.partial` (on "Continue", if partial data available) | --> PR Selection stage (S03) (on back navigation) |
| **Error recovery** | Retry resets all timers. If timeout recurs, suggest: "Large PR detected. Consider splitting into smaller PRs for faster analysis." |

```
+---------------------------------------------------+
| ◆ Structural Graph                         DONE   |
|   [============================================]   |
|   3 impact zones, 47 call sites                    |
+---------------------------------------------------+
| ◇ Semantic Enrichment                   TIMEOUT   |
|   [========================>                   ]   |
|   OmniSharp warm-up exceeded 60s                   |
+---------------------------------------------------+
| ● Scenario Generation                   PENDING   |
|   [                                            ]   |
|   (blocked -- waiting on semantic)                 |
+---------------------------------------------------+
|                                                    |
|  Analysis timed out after 1m 12s.                  |
|  Semantic enrichment did not complete in time.      |
|                                                    |
|  [Retry]   [Continue with partial results]  [Back] |
+---------------------------------------------------+
```

---

### S14 -- `analysis.reconnecting`

| Field | Value |
|-------|-------|
| **State name** | `analysis.reconnecting` |
| **Entry conditions** | SignalR connection lost during any active analysis state. |
| **Exit conditions** | Connection restored and `GetQAAnalysisStatus` response received, OR reconnection fails after 30s. |
| **Visual description** | Amber banner overlays top of track area: "Connection lost -- reconnecting..." with animated spinner. All track animations pause (CSS `animation-play-state: paused`). Progress bars freeze at last known position. After 15s, banner updates: "Still reconnecting... (15s)". |
| **Keyboard shortcuts** | `Escape` -- give up and cancel. |
| **Data requirements** | Last known state of all tracks (cached in `AnalysisController`). |
| **Transitions** | --> (previous active state) (on successful reconnect + status sync) | --> `analysis.failed` (on reconnection failure after 30s) | --> `analysis.cancelled` (on user Escape) |
| **Error recovery** | On reconnect, `GetQAAnalysisStatus` returns current phase + progress. Controller replays missed state transitions. If analysis finished while disconnected, jump straight to `analysis.complete` or `analysis.partial`. |

```
+-------------------------------------------------------+
| /!\ Connection lost -- reconnecting...          (8s)  |
|-------------------------------------------------------|
| ◆ Structural Graph                         DONE       |
|   [============================================]       |
| ◇ Semantic Enrichment                   RUNNING       |
|   [=============>              ]   (paused)            |
| ● Scenario Generation                   PENDING       |
|   [                                            ]       |
+-------------------------------------------------------+
```

---

## Transition Diagram

```
                          +-------------------+
                          | analysis.starting |
                          | (S01)             |
                          +---------+---------+
                                    |
                      QaAnalysisProgress
                      phase: roslyn_blast_radius
                                    |
                                    v
                     +------------------------+
                     | analysis.graph.building|
                     | (S02)                  |
                     +-----------+------------+
                                 |
                       phase: semantic_analysis
                                 |
                                 v
                     +------------------------+
                     | analysis.graph.complete|  (transient)
                     | (S03)                  |
                     +-----------+------------+
                                 |
                                 v
                     +---------------------------+
                     | analysis.semantic.loading  |
                     | (S04) OmniSharp warm-up    |
                     +-----------+---------------+
                                 |
                          warm-up done
                                 |
                                 v
                     +-----------------------------+
                     | analysis.semantic.enriching  |
                     | (S05)                        |
                     +-----------+-----------------+
                                 |
                       phase: di_validation
                                 |
                                 v
                     +------------------------------+
                     | analysis.semantic.complete    |  (transient)
                     | (S06)                         |
                     +-----------+------------------+
                                 |
                                 v
                     +------------------------+
                     | analysis.di.validating |
                     | (S07) L5 runtime DI    |
                     +-----------+------------+
                                 |
                      phase: scenario_generation
                                 |
                                 v
                     +-------------------------------+
                     | analysis.scenarios.generating  |
                     | (S08) L4 LLM streaming         |
                     +-----------+-------------------+
                                 |
                         phase: complete
                                 |
                                 v
                        +------------------+           +-----------------+
                        | analysis.complete|---------->| Curation (S05)  |
                        | (S09)            |  800ms    | (next stage)    |
                        +------------------+           +-----------------+


    === Error / interrupt branches (from ANY active state) ===

    any active state --[user Escape + confirm]--> analysis.cancelled (S12)
    any active state --[timeout exceeded]-------> analysis.timeout (S13)
    any active state --[SignalR disconnect]------> analysis.reconnecting (S14)
    any active state --[partial failure]--------> analysis.partial (S10)
    any active state --[total failure]----------> analysis.failed (S11)

    analysis.partial --[Continue]---------------> Curation (S05)
    analysis.partial --[Retry]-----------------> (failed layer's start state)
    analysis.failed  --[Try Again]-------------> analysis.starting (S01)
    analysis.failed  --[Create Manual]---------> Curation (S05, empty)
    analysis.cancelled --[Analyze Again]-------> analysis.starting (S01)
    analysis.timeout --[Retry]-----------------> analysis.starting (S01)
    analysis.timeout --[Continue partial]------> analysis.partial (S10)
    analysis.reconnecting --[restored]---------> (previous active state)
    analysis.reconnecting --[failed 30s]-------> analysis.failed (S11)
```

---

## SignalR Event --> State Mapping

| Event | `phase` / `reason` | Target State |
|-------|---------------------|--------------|
| `QaAnalysisProgress` | `fetching_diff` | `analysis.starting` (update subtitle) |
| `QaAnalysisProgress` | `roslyn_blast_radius` | `analysis.graph.building` |
| `QaAnalysisProgress` | `semantic_analysis` | `analysis.graph.complete` --> `analysis.semantic.loading` |
| `QaAnalysisProgress` | `di_validation` | `analysis.semantic.complete` --> `analysis.di.validating` |
| `QaAnalysisProgress` | `scenario_generation` | `analysis.scenarios.generating` |
| `QaAnalysisProgress` | `complete` | `analysis.complete` |
| `QaScenarioGenerated` | -- | Updates scenario count in `analysis.scenarios.generating` |
| `QaAnalysisCancelled` | `user_cancelled` | `analysis.cancelled` |
| `QaAnalysisCancelled` | `timeout` | `analysis.timeout` |
| `QaAnalysisCancelled` | `error` | `analysis.failed` |
| `QaAnalysisCancelled` | `superseded` | `analysis.cancelled` (silent) |
| `QaAnalysisError` | `recoverable: true` | `analysis.partial` |
| `QaAnalysisError` | `recoverable: false` | `analysis.failed` |

---

## Timing Budget

```
Phase                     Expected     Timeout    Progress %
------------------------  ----------   --------   ----------
fetching_diff             1-3s         10s         0 -  5
roslyn_blast_radius       1-2s         15s         5 - 25
semantic_analysis          15-30s       60s        25 - 55
di_validation             <1s          10s        55 - 65
scenario_generation        5-15s        30s        65 - 95
complete                  instant      --         100

Total typical:            25-50s
Total worst case:         ~120s (before global timeout)
```

---

## Accessibility Requirements

| Requirement | Implementation |
|-------------|----------------|
| Track status announced | Each `.an-status` badge has `aria-live="polite"`. Screen reader announces "Structural Graph: RUNNING", "Semantic Enrichment: DONE", etc. |
| Progress bar | `role="progressbar"`, `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-label="Structural Graph progress"`. |
| Subtitle updates | `.an-sub` has `aria-live="polite"` for step text changes. Debounced to avoid excessive announcements (max 1 per 2s). |
| Error cards | `role="alert"` on error/warning containers. |
| Cancel confirmation | Modal dialog with `role="alertdialog"`, focus trapped, Escape to dismiss. |
| Keyboard navigation | `Tab` cycles focus: Cancel button --> track detail toggles --> action buttons. `Escape` always available for cancel. |
| Reduced motion | `@media (prefers-reduced-motion: reduce)` disables pulse, shimmer, and stagger animations. Progress bars still fill but with `transition: none`. |

---

## CSS Class Reference

| Class | State | Visual |
|-------|-------|--------|
| `.an-status.pending` | PENDING | Grey background, muted text |
| `.an-status.running` | RUNNING | Accent background, pulse animation |
| `.an-status.done` | DONE | Green background, static |
| `.an-status.warn` | WARN (partial) | Amber background, static |
| `.an-status.error` | ERROR | Red background, static |
| `.an-status.cancelled` | CANCELLED | Grey background, strikethrough text |
| `.an-status.timeout` | TIMEOUT | Amber background, clock icon |
| `.an-track.completed` | Track done | Shimmer sweep animation (once) |
| `.an-bar-shimmer` | Indeterminate | Gradient sweep animation (loop) |

---

## Implementation Notes

1. **State machine lives in `AnalysisController`** -- a plain JS class inside `qa-panel.js`.
   No external state library. State stored as `this._currentState` string.

2. **Progress events are idempotent** -- receiving a duplicate `phaseIndex` is ignored.
   The controller only advances forward (higher phaseIndex). Out-of-order events are
   queued and replayed in order.

3. **Scenario preview list** during `analysis.scenarios.generating` uses a simple
   `DocumentFragment` append pattern. Max 50 DOM nodes; older entries removed from top.

4. **Reconnection state sync** uses `GetQAAnalysisStatus` which returns the current
   `QaAnalysisProgress` event shape. The controller diffs against cached state and
   replays any missed transitions.

5. **No emoji** in any status text or UI labels. Use Unicode symbols:
   `/!\` for warnings, `-->` for arrows, checkmark via CSS `::after` content on `.done`.
