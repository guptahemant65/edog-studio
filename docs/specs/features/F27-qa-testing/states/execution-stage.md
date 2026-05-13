# P3 State Matrix — Execution Stage

> **Feature:** F27 QA Testing Panel
> **Stage:** S06 Execution (Stage 4 in panel flow)
> **Author:** Pixel (Frontend)
> **Depends on:** C03 (Execution Engine), C04 (Assertion Engine), C06-S06 (Frontend Panel), SignalR Protocol (§1.3, §2.2)
> **Priority:** P3

---

## Overview

The Execution Stage is the most visually dynamic surface in the QA panel. It renders real-time scenario execution: a scenario queue sidebar, expectation stacked cards with sweep animations, a live interceptor event feed, and verdict banners. The engine runs the eight-phase loop (ISOLATE → SETUP → MARK → STIMULATE → CAPTURE → EVALUATE → TEARDOWN → REPORT) per scenario, emitting SignalR events that drive every visual transition in this matrix.

**SignalR events consumed:**

| Event | Triggers |
|-------|----------|
| `QaRunStarted` | `exec.idle` → `exec.starting` |
| `QaScenarioStarted` | `exec.starting`/`exec.between` → `exec.scenario.setup` |
| `QaScenarioPhaseChanged` | Phase sub-state transitions within active scenario |
| `QaExpectationMatched` (status: passed) | `exec.scenario.exp.pending` → `exec.scenario.exp.matched` |
| `QaExpectationMatched` (status: failed) | `exec.scenario.exp.pending` → `exec.scenario.exp.failed` |
| `QaExpectationMatched` (status: unmatched) | `exec.scenario.exp.pending` → `exec.scenario.exp.timeout` |
| `QaScenarioCompleted` | → `exec.scenario.complete.*` |
| `QaRunCompleted` | → `exec.complete` |
| `QaError` (recoverable: false) | → `exec.crashed` |
| `QaError` (recoverable: true) | Inline error toast, execution continues |

---

## ASCII Reference: Expectation Card Stack

```
┌─────────────────────────────────────────────────────────────────────┐
│ EXPECTATIONS                                              0 / 4    │
├─────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ 1  ○  PUT request to correct OneLake path                     │ │  ← pending
│ └─────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ 2  ○  File content matches expected parquet schema             │ │  ← pending
│ └─────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ 3  ○  No error events on fileop topic                         │ │  ← pending
│ └─────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ 4  ○  DAG node status transitions to Completed                │ │  ← pending
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

After match (card 1 matched at 0.8s):

┌─────────────────────────────────────────────────────────────────────┐
│ EXPECTATIONS                                              1 / 4    │
├─────────────────────────────────────────────────────────────────────┤
│ ┌═══════════════════════════════════════════════════════════════════┐│
│ │ 1  ✓  PUT request to correct OneLake path                 0.8s ││  ← pass (green sweep)
│ └═══════════════════════════════════════════════════════════════════┘│
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ 2  ○  File content matches expected parquet schema             │ │  ← pending
│ └─────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ 3  ○  No error events on fileop topic                         │ │  ← pending
│ └─────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ 4  ○  DAG node status transitions to Completed                │ │  ← pending
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

After fail (card 3 failed):

│ ┌░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┐│
│ │ 3  ✕  No error events on fileop topic               FAILED    ││  ← fail (red sweep + shake)
│ └░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┘│
```

**Legend:** `○` dashed-circle (pending), `✓` solid check (pass), `✕` cross (fail), `═` green sweep fill, `░` red sweep fill

---

## Full-Stage ASCII Wireframe

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  ● ● ● ○ ○ ○ ○ ○                                 Scenario 3 of 8    [Cancel]   │
├───────────┬──────────────────────────────────────────────────────────────────────┤
│ SCENARIO  │  WriteFileAsync writes to correct OneLake path                      │
│ QUEUE     │  HAPPY  ·  4 expectations  ·  ~15s timeout                          │
│           │                                                                     │
│ ✓ 1  3.2s│  ┌───────────────────────────────────────────────────────────────┐   │
│ ✓ 2  1.1s│  │ EXPECTATIONS                                       2 / 4    │   │
│ ▸ 3  ··· │  ├───────────────────────────────────────────────────────────────┤   │
│ ○ 4      │  │ ═══ 1  ✓  PUT to OneLake path                       0.8s    │   │
│ ○ 5      │  │ ═══ 2  ✓  Content matches parquet schema             1.4s    │   │
│ ○ 6      │  │ --- 3  ○  No error events on fileop                          │   │
│ ○ 7      │  │ --- 4  ○  DAG node → Completed                              │   │
│ ○ 8      │  └───────────────────────────────────────────────────────────────┘   │
│           │                                                                     │
│           │  ┌───────────────────────────────────────────────────────────────┐   │
│           │  │ ● LIVE EVENTS                                                │   │
│           │  │ 14:35:01.2  fileop  WriteFile /Tables/Table1/part-001.pqt    │   │
│           │  │ 14:35:01.4  http    PUT 201 dfs.fabric.microsoft.com/...     │   │
│           │  │ 14:35:02.1  dag     NodeStatus Table1 → Running              │   │
│           │  │ 14:35:03.8  log     [INFO] MaterializeNode completed         │   │
│           │  └───────────────────────────────────────────────────────────────┘   │
└───────────┴──────────────────────────────────────────────────────────────────────┘
```

---

## State Definitions

### 1. `exec.idle`

| Field | Value |
|-------|-------|
| **State name** | `exec.idle` |
| **Entry conditions** | Panel transitions to Execution Stage (S06). `QaStartRun` has been invoked but `QaRunStarted` not yet received. OR: stage is mounted before run begins. |
| **Exit conditions** | `QaRunStarted` event received. |
| **Visual description** | Full-stage skeleton. Sidebar shows scenario queue with all items in `pending` (○ icon). Main panel shows "Waiting for execution to start..." with a subtle pulsing dot. Stepper dots all grey. Cancel button disabled. |
| **Keyboard shortcuts** | `Escape` — return to Curation stage (only if run not yet started). |
| **Data requirements** | `scenarioList[]` from curation submission, `runId`, `correlationId`. |
| **Transitions** | → `exec.starting` on `QaRunStarted`. → `exec.crashed` on `QaError(recoverable: false)`. |
| **Error recovery** | If no `QaRunStarted` within 10s of `QaStartRun` invocation, show "Run did not start. Check FLT connection." with Retry button. Retry re-invokes `QaStartRun`. |

```
Sidebar                    Main
┌───────────┐  ┌──────────────────────────────────┐
│ ○ Scn 1   │  │                                  │
│ ○ Scn 2   │  │   ● Waiting for execution        │
│ ○ Scn 3   │  │     to start...                   │
│ ○ Scn 4   │  │                                  │
└───────────┘  └──────────────────────────────────┘
```

---

### 2. `exec.starting`

| Field | Value |
|-------|-------|
| **State name** | `exec.starting` |
| **Entry conditions** | `QaRunStarted` event received with `scenarioCount`, `scenarioIds`, `options`. |
| **Exit conditions** | First `QaScenarioStarted` event received. |
| **Visual description** | Stepper header populates: "Scenario 1 of N". Sidebar items confirmed against server list. Cancel button enables. Brief initialization bar (indeterminate, 200ms CSS animation). Main panel text: "Initializing run — N scenarios queued". |
| **Keyboard shortcuts** | `Escape` — triggers cancel confirmation dialog. |
| **Data requirements** | `QaRunStarted` payload: `scenarioCount`, `scenarioIds[]`, `options.stopOnFirstFailure`, `options.interScenarioDelayMs`. |
| **Transitions** | → `exec.scenario.setup` on `QaScenarioStarted`. → `exec.cancelling` on user cancel. → `exec.crashed` on `QaError(recoverable: false)`. |
| **Error recovery** | If no `QaScenarioStarted` within 5s, show warning toast "First scenario taking longer than expected..." — no auto-cancel. |

---

### 3. `exec.scenario.setup`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.setup` |
| **Entry conditions** | `QaScenarioStarted` received. Phase = `isolate` initially. Subsequent `QaScenarioPhaseChanged` with `phase: "setup"`. |
| **Exit conditions** | `QaScenarioPhaseChanged` with `phase: "mark"` or `phase: "stimulate"`. |
| **Visual description** | Sidebar: current scenario shows ▸ (running indicator, amber). Main panel populates: scenario title, category badge (`HAPPY`/`EDGE`/`CHAOS`/`ERROR`), expectation count, timeout. Expectation cards render in stacked layout, all `pending` (○ dashed circle). Sub-header: "Setting up — applying chaos rules, flag overrides...". Phase indicator pill: `SETUP`. |
| **Keyboard shortcuts** | `Escape` — cancel confirmation. `1`-`9` — jump focus to expectation card N. |
| **Data requirements** | `QaScenarioStarted` payload: `scenarioId`, `scenarioIndex`, `totalScenarios`, `title`, `category`, `expectationCount`. Expectation details from curated scenario model. |
| **Transitions** | → `exec.scenario.stimulus` on `QaScenarioPhaseChanged(phase: "stimulate")`. → `exec.scenario.teardown` on setup failure (`QaError` with `CHAOS_SETUP_FAILED`). |
| **Error recovery** | On `CHAOS_SETUP_FAILED`: show inline error banner "Setup failed — chaos rule injection failed. Skipping to teardown." Scenario marked `skipped` after teardown. |

```
┌───────────┬──────────────────────────────────────────┐
│ ✓ 1  3.2s │  WriteFileAsync writes to correct path   │
│ ▸ 2  ···  │  HAPPY · 4 expectations · ~15s timeout   │
│ ○ 3       │  ┌──────────────────────────────────────┐│
│ ○ 4       │  │ SETUP  Applying chaos rules...       ││
│            │  └──────────────────────────────────────┘│
│            │  ┌──────────────────────────────────────┐│
│            │  │ EXPECTATIONS                  0 / 4  ││
│            │  │ --- 1  ○  PUT to OneLake path        ││
│            │  │ --- 2  ○  Content matches schema     ││
│            │  │ --- 3  ○  No error events            ││
│            │  │ --- 4  ○  DAG node → Completed       ││
│            │  └──────────────────────────────────────┘│
└───────────┴──────────────────────────────────────────┘
```

---

### 4. `exec.scenario.stimulus`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.stimulus` |
| **Entry conditions** | `QaScenarioPhaseChanged` with `phase: "stimulate"`. |
| **Exit conditions** | `QaScenarioPhaseChanged` with `phase: "capture"`. |
| **Visual description** | Phase pill changes to `STIMULATE` (amber pulse). Sub-header: detail text from event (e.g., "Delivering stimulus: POST /liveTableSchedule/runDAG/current"). Expectation cards remain `pending`. Event feed may show the stimulus request itself if it hits the `http` topic. |
| **Keyboard shortcuts** | `Escape` — cancel confirmation. |
| **Data requirements** | `QaScenarioPhaseChanged` payload: `phase`, `detail`, `phaseDurationMs`. |
| **Transitions** | → `exec.scenario.capturing` on `QaScenarioPhaseChanged(phase: "capture")`. → `exec.scenario.teardown` on stimulus failure (`QaError` with `STIMULUS_DELIVERY_FAILED`). |
| **Error recovery** | On `STIMULUS_DELIVERY_FAILED`: show inline banner "Stimulus failed — [detail]. Scenario will be marked as crashed." Transition to teardown. |

---

### 5. `exec.scenario.capturing`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.capturing` |
| **Entry conditions** | `QaScenarioPhaseChanged` with `phase: "capture"`. |
| **Exit conditions** | `QaScenarioPhaseChanged` with `phase: "evaluate"`. |
| **Visual description** | Phase pill: `CAPTURE` (green pulse — active listening). This is the primary real-time phase. Live event feed activates: interceptor events stream in with topic badges, timestamps, and data previews. Events that match an expectation get a highlight flash (100ms amber → fade). Expectation cards transition individually as `QaExpectationMatched` events arrive. Counter increments: "1/4" → "2/4". A countdown timer shows remaining capture window (derived from scenario timeout). Event feed uses virtual scroll: batch DOM updates every 100ms via `requestAnimationFrame`, render visible rows + 10-row buffer. |
| **Keyboard shortcuts** | `Escape` — cancel confirmation. `E` — toggle event feed expand/collapse. `F` — filter events (opens topic filter dropdown). |
| **Data requirements** | Live `QaExpectationMatched` events. Interceptor events from `QaSubscribeExecution` stream. Scenario timeout for countdown. |
| **Transitions** | → `exec.scenario.exp.pending` / `.matched` / `.failed` — individual card sub-states (parallel, one per expectation). → `exec.scenario.teardown` on `QaScenarioPhaseChanged(phase: "evaluate")` then `(phase: "teardown")`. → `exec.scenario.exp.timeout` if capture window expires with unmatched expectations. |
| **Error recovery** | On `CAPTURE_TIMEOUT`: remaining pending expectations transition to `exec.scenario.exp.timeout`. On high-frequency events (>100/s): throttled rendering ensures no frame drops. If event count exceeds 500, show "N events captured" summary row instead of individual rows for oldest events. |

---

### 6. `exec.scenario.exp.pending`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.exp.pending` |
| **Entry conditions** | Scenario enters `exec.scenario.setup` — all expectation cards initialize in this state. |
| **Exit conditions** | `QaExpectationMatched` received for this expectation ID, OR capture window expires. |
| **Visual description** | Card shows: number, dashed circle `○` icon (CSS `border: 1.5px dashed var(--text-muted)`), expectation description text, empty time slot. Background is default card color (`var(--surface-2)`). No `::after` pseudo-element sweep. |
| **Keyboard shortcuts** | `Enter` on focused card — expand to show matcher details (topic, field predicates). |
| **Data requirements** | `expectationId`, `description`, `type` (event_present, event_absent, etc.), `topic`. |
| **Transitions** | → `exec.scenario.exp.matched` on `QaExpectationMatched(status: "passed")`. → `exec.scenario.exp.failed` on `QaExpectationMatched(status: "failed")`. → `exec.scenario.exp.timeout` on `QaExpectationMatched(status: "unmatched")` or capture window expiry. |
| **Error recovery** | None — this is a waiting state. If the scenario completes without any match event for this expectation, treat as timeout. |

```
┌─────────────────────────────────────────────────────┐
│ 1  ○  PUT request to correct OneLake path           │  bg: var(--surface-2)
└─────────────────────────────────────────────────────┘     icon: dashed circle
```

---

### 7. `exec.scenario.exp.matched`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.exp.matched` |
| **Entry conditions** | `QaExpectationMatched` received with `status: "passed"` for this expectation. |
| **Exit conditions** | Terminal — no further transitions for this card within the scenario. |
| **Visual description** | **Sweep animation:** CSS `::after` pseudo-element with `background: var(--ok-dim)` scales from `scaleX(0)` to `scaleX(1)` over 500ms with `transform-origin: left` and `var(--ease)` timing. Icon transitions: dashed circle → solid `✓` with `checkPop` keyframe animation (scale 0 → 1.3 → 1 over 300ms, `ease-out`). Time badge appears: "0.8s" (from `matchLatencyMs / 1000`, rounded to 1 decimal). Counter updates: "N/M". Screen reader: `aria-live` region announces "Expectation N passed at Xms". |
| **Keyboard shortcuts** | `Enter` on focused card — expand to show matched event evidence (topic, data snapshot). |
| **Data requirements** | `QaExpectationMatched` payload: `expectationId`, `status: "passed"`, `matchLatencyMs`, `matchedEvent { topic, data }`, `description`. |
| **Transitions** | None — terminal state for this card. |
| **Error recovery** | If duplicate `QaExpectationMatched` for same ID arrives: ignore (idempotent). |

**Animation specification:**

```css
/* Sweep fill */
.exp-card::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: scaleX(0);
  transform-origin: left;
  z-index: 0;
  border-radius: inherit;
}
.exp-card.pass::after {
  background: var(--ok-dim);           /* ~rgba(74, 222, 128, 0.12) */
  transform: scaleX(1);
  transition: transform 500ms var(--ease);
}

/* Check icon pop */
@keyframes checkPop {
  0%   { transform: scale(0); opacity: 0; }
  60%  { transform: scale(1.3); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
.exp-card-icon.pass {
  animation: checkPop 300ms ease-out forwards;
  color: var(--ok);                    /* #4ade80 */
}
```

```
┌═════════════════════════════════════════════════════════════┐
│ 1  ✓  PUT request to correct OneLake path            0.8s  │  bg sweep: var(--ok-dim)
└═════════════════════════════════════════════════════════════┘     icon: solid ✓ (checkPop)
```

---

### 8. `exec.scenario.exp.failed`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.exp.failed` |
| **Entry conditions** | `QaExpectationMatched` received with `status: "failed"` for this expectation. |
| **Exit conditions** | Terminal — no further transitions for this card within the scenario. |
| **Visual description** | **Sweep animation:** CSS `::after` with `background: var(--fail-dim)` scales from `scaleX(0)` to `scaleX(1)` over 300ms (faster than pass — urgency). Icon transitions: dashed circle → solid `✕` with `shake` keyframe animation (translateX oscillation over 400ms). Badge: "FAILED" in `var(--fail)` color. If `closestMiss` present, a subtle "closest miss" link appears below the card on hover/focus. Screen reader: announces "Expectation N failed — [failureReason]". |
| **Keyboard shortcuts** | `Enter` on focused card — expand to show failure details: `failureReason`, `closestMiss` event data, expected vs. observed diff. |
| **Data requirements** | `QaExpectationMatched` payload: `expectationId`, `status: "failed"`, `failureReason`, `closestMiss { topic, data }`, `description`. |
| **Transitions** | None — terminal state for this card. |
| **Error recovery** | If duplicate event: ignore. |

**Animation specification:**

```css
.exp-card.fail::after {
  background: var(--fail-dim);         /* ~rgba(248, 113, 113, 0.12) */
  transform: scaleX(1);
  transition: transform 300ms var(--ease);
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20%      { transform: translateX(-4px); }
  40%      { transform: translateX(4px); }
  60%      { transform: translateX(-3px); }
  80%      { transform: translateX(2px); }
}
.exp-card-icon.fail {
  animation: shake 400ms ease-out;
  color: var(--fail);                  /* #f87171 */
}
```

```
┌░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┐
│ 3  ✕  No error events on fileop topic              FAILED    │  bg sweep: var(--fail-dim)
└░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┘     icon: ✕ (shake)
```

---

### 9. `exec.scenario.exp.timeout`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.exp.timeout` |
| **Entry conditions** | `QaExpectationMatched` received with `status: "unmatched"`, OR capture window expires with this expectation still pending. |
| **Exit conditions** | Terminal — no further transitions for this card within the scenario. |
| **Visual description** | Card background: `var(--warn-dim)` (amber tint). Icon: `○` remains dashed but turns amber. Badge: "TIMED OUT" in `var(--warn)`. No sweep animation — instead a slow fade-in of the amber background over 600ms. The dashed circle icon gains a subtle pulse (1s loop, 2 cycles, then stops). |
| **Keyboard shortcuts** | `Enter` on focused card — expand to show "No matching event observed within capture window. N events were evaluated on topic [topic]." |
| **Data requirements** | `expectationId`, scenario timeout value, events-evaluated count for this expectation's topic. |
| **Transitions** | None — terminal state. |
| **Error recovery** | None. |

**Animation specification:**

```css
.exp-card.timeout {
  background: var(--warn-dim);         /* ~rgba(251, 191, 36, 0.10) */
  transition: background 600ms ease-in;
}
.exp-card-icon.timeout {
  color: var(--warn);                  /* #fbbf24 */
  animation: pulse 1s ease-in-out 2;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}
```

```
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│ 4  ○  DAG node → Completed                       TIMED OUT  │  bg: var(--warn-dim)
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘     icon: amber dashed ○
```

---

### 10. `exec.scenario.teardown`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.teardown` |
| **Entry conditions** | `QaScenarioPhaseChanged` with `phase: "teardown"`. |
| **Exit conditions** | `QaScenarioPhaseChanged` with `phase: "report"`, OR `QaScenarioCompleted` received. |
| **Visual description** | Phase pill: `TEARDOWN` (muted). Sub-header: "Cleaning up — removing chaos rules, restoring flags...". Expectation cards frozen in their terminal states. Event feed continues but new events render dimmed (opacity 0.5). Sidebar item remains ▸ but with a subtle wind-down animation (spinner slows). |
| **Keyboard shortcuts** | `Escape` — cancel confirmation (cancel takes effect after teardown completes). |
| **Data requirements** | `QaScenarioPhaseChanged` payload for teardown phase. |
| **Transitions** | → `exec.scenario.complete.pass` / `.fail` / `.partial` on `QaScenarioCompleted`. → `exec.crashed` on `QaError(TEARDOWN_INCOMPLETE, recoverable: false)`. |
| **Error recovery** | On `TEARDOWN_INCOMPLETE` (recoverable: true): show amber warning toast "Teardown incomplete — some chaos rules may persist. Check F24 panel." Continue to scenario complete. |

---

### 11. `exec.scenario.complete.pass`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.complete.pass` |
| **Entry conditions** | `QaScenarioCompleted` received with `result.verdict: "passed"`. |
| **Exit conditions** | 500ms delay expires (inter-scenario gap) → next scenario or run complete. |
| **Visual description** | Verdict banner slides in from bottom (200ms, `ease-out`): green background, `✓` icon, "PASSED", duration badge (e.g., "3.2s"). Sidebar item: ▸ → `✓` with green color. Duration appears: "3.2s". Counter updates: "2 / 4". Summary stat: "Scenario 3 of 8". Event feed stops streaming. |
| **Keyboard shortcuts** | `Enter` — skip to next scenario (bypass 500ms gap). |
| **Data requirements** | `QaScenarioCompleted` payload: `result.verdict`, `result.durationMs`, `runProgress { completed, passed, failed, remaining }`. |
| **Transitions** | → `exec.between` after verdict display (auto, 500ms). → `exec.complete` if this was the last scenario. |
| **Error recovery** | None — this is a success state. |

```
┌──────────────────────────────────────────────────────────────┐
│              ✓    PASSED                           3.2s      │  bg: var(--ok-dim)
└──────────────────────────────────────────────────────────────┘
```

---

### 12. `exec.scenario.complete.fail`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.complete.fail` |
| **Entry conditions** | `QaScenarioCompleted` received with `result.verdict: "failed"`. |
| **Exit conditions** | 500ms delay expires → next scenario or run complete. OR if `options.stopOnFirstFailure: true`, → `exec.complete`. |
| **Visual description** | Verdict banner: red background, `✕` icon, "FAILED", duration badge. Sidebar item: ▸ → `✕` with red color. Duration appears. If `stopOnFirstFailure`, additional text: "Run stopped — stopOnFirstFailure enabled". Failed expectation cards remain expanded showing failure details. |
| **Keyboard shortcuts** | `Enter` — skip to next scenario. `D` — expand failure details in main panel. |
| **Data requirements** | `QaScenarioCompleted` payload. Failed expectations with `failureReason` and `closestMiss`. |
| **Transitions** | → `exec.between` after verdict display (auto, 500ms). → `exec.complete` if last scenario or `stopOnFirstFailure`. |
| **Error recovery** | None. |

```
┌──────────────────────────────────────────────────────────────┐
│              ✕    FAILED                           8.4s      │  bg: var(--fail-dim)
└──────────────────────────────────────────────────────────────┘
```

---

### 13. `exec.scenario.complete.partial`

| Field | Value |
|-------|-------|
| **State name** | `exec.scenario.complete.partial` |
| **Entry conditions** | `QaScenarioCompleted` received with `result.verdict: "partial"` or `"timed_out"`. |
| **Exit conditions** | 500ms delay expires → next scenario or run complete. |
| **Visual description** | Verdict banner: amber background, `◆` icon, "PARTIAL — 2 of 4 expectations matched", duration badge. Sidebar item: ▸ → `◆` with amber color. Timed-out expectations show amber "TIMED OUT" badges. Matched expectations retain their green state. |
| **Keyboard shortcuts** | `Enter` — skip to next scenario. `D` — expand details. |
| **Data requirements** | `QaScenarioCompleted` payload with mix of passed/timed-out expectations. |
| **Transitions** | → `exec.between` after verdict display. → `exec.complete` if last scenario. |
| **Error recovery** | None. |

```
┌──────────────────────────────────────────────────────────────┐
│          ◆    PARTIAL  2 / 4 matched               15.0s    │  bg: var(--warn-dim)
└──────────────────────────────────────────────────────────────┘
```

---

### 14. `exec.between`

| Field | Value |
|-------|-------|
| **State name** | `exec.between` |
| **Entry conditions** | Current scenario verdict displayed for 500ms (inter-scenario gap per `options.interScenarioDelayMs`, default 500ms). |
| **Exit conditions** | Gap timer expires AND next `QaScenarioStarted` received. |
| **Visual description** | Previous scenario's verdict banner remains visible but fades to 60% opacity. Main panel shows brief transition: "Next: [scenario title]" with a thin progress bar (500ms, linear fill left-to-right). Sidebar: next scenario's row gains a subtle glow/highlight to indicate it's up next. |
| **Keyboard shortcuts** | `Enter` — skip gap, immediately transition to next scenario (sends no server command — just UI). |
| **Data requirements** | Next scenario's `title` from the curated list. `interScenarioDelayMs` from run options. |
| **Transitions** | → `exec.scenario.setup` on next `QaScenarioStarted`. → `exec.complete` if no more scenarios. → `exec.cancelling` on user cancel. |
| **Error recovery** | If `QaScenarioStarted` not received within `interScenarioDelayMs + 3000ms`, show warning: "Next scenario delayed...". Do not auto-cancel. |

---

### 15. `exec.cancelling`

| Field | Value |
|-------|-------|
| **State name** | `exec.cancelling` |
| **Entry conditions** | User clicks Cancel button OR presses `Escape` and confirms in dialog. `QaCancelRun` invoked. |
| **Exit conditions** | `QaRunCompleted` received with `cancelledByUser: true`. |
| **Visual description** | Cancel button changes to "Cancelling..." (disabled, spinner icon). Banner overlay on main panel: "Cancelling — completing current scenario teardown...". Sidebar: remaining ○ items dim to 30% opacity with "SKIPPED" label. Current scenario (if any) continues through its teardown phase normally. Progress text: "Cancelling after scenario N of M". |
| **Keyboard shortcuts** | None — waiting for server confirmation. |
| **Data requirements** | `correlationId`, `runId` for `QaCancelRun`. Current scenario index for progress display. |
| **Transitions** | → `exec.cancelled` on `QaRunCompleted(cancelledByUser: true)`. → `exec.crashed` on `QaError(recoverable: false)` during teardown. |
| **Error recovery** | If `QaRunCompleted` not received within 30s of cancel request, show "Cancel may have failed. FLT may still be running the scenario." with Force Cancel button (kills the run without teardown — last resort). |

```
┌──────────────────────────────────────────────────────────────────────┐
│  ● ● ● ▸ ○ ○ ○ ○                     Cancelling after 4 of 8       │
├───────────┬──────────────────────────────────────────────────────────┤
│ ✓ 1  3.2s│  ┌────────────────────────────────────────────────────┐  │
│ ✓ 2  1.1s│  │  Cancelling — completing teardown for scenario 4  │  │
│ ✕ 3  8.4s│  └────────────────────────────────────────────────────┘  │
│ ▸ 4  ··· │                                                          │
│  5 SKIP  │                                                          │
│  6 SKIP  │                                                          │
│  7 SKIP  │                                                          │
│  8 SKIP  │                                                          │
└───────────┴──────────────────────────────────────────────────────────┘
```

---

### 16. `exec.cancelled`

| Field | Value |
|-------|-------|
| **State name** | `exec.cancelled` |
| **Entry conditions** | `QaRunCompleted` received with `cancelledByUser: true`. |
| **Exit conditions** | User clicks "View Results" (partial) or "Back to Curation". |
| **Visual description** | Full-width amber banner: "Run cancelled by user — N of M scenarios completed". Summary: "X passed, Y failed, Z skipped". Two action buttons: "View Partial Results" (primary) and "Back to Curation" (secondary). Sidebar shows final state: completed scenarios with ✓/✕, remaining marked "SKIPPED" in muted text. |
| **Keyboard shortcuts** | `Enter` — View Partial Results. `Escape` — Back to Curation. |
| **Data requirements** | `QaRunCompleted` payload: `summary { total, passed, failed, skipped }`, `cancelledByUser: true`. |
| **Transitions** | → Results Stage (S07) on "View Partial Results". → Curation Stage (S05) on "Back to Curation". |
| **Error recovery** | None — terminal state for execution. |

---

### 17. `exec.complete`

| Field | Value |
|-------|-------|
| **State name** | `exec.complete` |
| **Entry conditions** | `QaRunCompleted` received with `cancelledByUser: false`. All scenarios have completed. |
| **Exit conditions** | Auto-transition to Results Stage (S07) after 1500ms display. |
| **Visual description** | Full-width summary banner with confetti-style subtle animation for all-pass runs. Text: "Run complete — N / M scenarios passed · Xs total". For all-pass: green banner, "ALL PASSED" with brief celebration (3 floating ✓ particles, 800ms, `prefers-reduced-motion` respects). For mixed: neutral banner with pass/fail counts. Progress bar reaches 100%. "Preparing results..." text with loading spinner before auto-transition. |
| **Keyboard shortcuts** | `Enter` — skip to results immediately. |
| **Data requirements** | `QaRunCompleted` payload: `summary`, `totalDurationMs`, `performance`. |
| **Transitions** | → Results Stage (S07) — auto after 1500ms, or immediately on `Enter`. |
| **Error recovery** | If auto-transition fails (S07 mount error), show "View Results" manual button as fallback. |

```
All pass:
┌══════════════════════════════════════════════════════════════════════┐
│  ✓  ALL PASSED   8 / 8 scenarios  ·  42.3s total                   │
│                                                                     │
│     Preparing results...                                            │
└══════════════════════════════════════════════════════════════════════┘

Mixed:
┌──────────────────────────────────────────────────────────────────────┐
│  Run complete — 7 / 8 scenarios passed  ·  1 failed  ·  38.1s      │
│                                                                     │
│     Preparing results...                                            │
└──────────────────────────────────────────────────────────────────────┘
```

---

### 18. `exec.crashed`

| Field | Value |
|-------|-------|
| **State name** | `exec.crashed` |
| **Entry conditions** | `QaError` with `recoverable: false` received (e.g., `FLT_PROCESS_UNRESPONSIVE`, `INTERNAL_ERROR`). OR SignalR disconnects during execution (connection lost). |
| **Exit conditions** | User clicks "View Partial Results" or "Retry Run" or "Back to Curation". |
| **Visual description** | Red full-width crash banner: "Execution interrupted — [error message]". If SignalR disconnect: "Connection lost — FLT may have crashed. Waiting for reconnect..." with reconnect spinner (up to 15s). If reconnect succeeds, query run status via `QaGetRunDetail` and resume appropriate state. If reconnect fails, show final crash state. Three action buttons: "Retry Run" (re-invokes `QaStartRun` with same scenarios), "View Partial Results" (if any scenarios completed), "Back to Curation". Sidebar shows completed scenarios with their verdicts, crashed scenario with `✕ CRASHED`, remaining as `SKIPPED`. |
| **Keyboard shortcuts** | `R` — Retry Run. `Enter` — View Partial Results. `Escape` — Back to Curation. |
| **Data requirements** | `QaError` payload: `errorCode`, `message`, `scenarioId`, `phase`, `severity`, `detail`. Partial results from completed scenarios (cached client-side from `QaScenarioCompleted` events). |
| **Transitions** | → `exec.idle` on "Retry Run". → Results Stage (S07) on "View Partial Results". → Curation Stage (S05) on "Back to Curation". → Resume appropriate state on SignalR reconnect + successful status query. |
| **Error recovery** | SignalR auto-reconnect (built into `SignalRManager`): exponential backoff 0s → 2s → 10s → 30s (4 attempts). On reconnect, invoke `QaGetRunDetail(runId)` to get current state. If run completed while disconnected, transition to `exec.complete`. If run still active, resume from current scenario. If retry fails 3 times, show "Retry limit reached. Start a fresh run from Curation." |

```
┌░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┐
│  ✕  Execution interrupted                                           │
│     FLT_PROCESS_UNRESPONSIVE: FLT stopped responding during         │
│     scenario "Retry on 429 throttle" (phase: capture)               │
│                                                                     │
│     [ Retry Run ]   [ View Partial Results ]   [ Back to Curation ] │
└░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┘
```

---

## Transition Diagram

```
                          QaStartRun invoked
                                │
                                ▼
                        ┌───────────────┐
                        │   exec.idle   │
                        └───────┬───────┘
                     QaRunStarted│
                                ▼
                       ┌────────────────┐
                       │ exec.starting  │
                       └───────┬────────┘
                  QaScenarioStarted
                               │
              ┌────────────────▼────────────────────────────────────────┐
              │                SCENARIO LOOP                            │
              │                                                        │
              │  ┌──────────────────────┐                              │
              │  │ exec.scenario.setup  │ ◄── QaScenarioStarted        │
              │  └──────────┬───────────┘                              │
              │    phase: stimulate                                     │
              │             ▼                                           │
              │  ┌────────────────────────┐                            │
              │  │ exec.scenario.stimulus │                            │
              │  └──────────┬─────────────┘                            │
              │    phase: capture                                       │
              │             ▼                                           │
              │  ┌──────────────────────────┐                          │
              │  │ exec.scenario.capturing  │ ←── events streaming     │
              │  └──────────┬───────────────┘                          │
              │             │                                           │
              │    ┌────────┼──────────┐  (per expectation, parallel)  │
              │    ▼        ▼          ▼                                │
              │ ┌───────┐┌───────┐┌─────────┐                         │
              │ │matched││failed ││ timeout  │                         │
              │ └───────┘└───────┘└─────────┘                         │
              │             │                                           │
              │    phase: teardown                                      │
              │             ▼                                           │
              │  ┌────────────────────────┐                            │
              │  │ exec.scenario.teardown │                            │
              │  └──────────┬─────────────┘                            │
              │    QaScenarioCompleted                                  │
              │             │                                           │
              │    ┌────────┼──────────┐                               │
              │    ▼        ▼          ▼                                │
              │ ┌──────┐┌──────┐┌─────────┐                           │
              │ │ pass ││ fail ││ partial  │                           │
              │ └──┬───┘└──┬───┘└────┬────┘                           │
              │    └────────┼────────┘                                 │
              │             ▼                                           │
              │    ┌─────────────────┐                                 │
              │    │  exec.between   │ ── 500ms gap                    │
              │    └────────┬────────┘                                 │
              │             │  more scenarios? ──── YES ──► loop back  │
              │             │                                           │
              └─────────────┼───────────────────────────────────────────┘
                            │ NO (or stopOnFirstFailure)
                            ▼
                   ┌─────────────────┐
                   │  exec.complete  │ ── auto 1500ms ──► Results (S07)
                   └─────────────────┘

  CANCEL PATH (any state):
  ┌────────────────────────────────────────────────┐
  │  User presses Escape / clicks Cancel           │
  │       ▼                                        │
  │  ┌──────────────────┐    QaRunCompleted        │
  │  │ exec.cancelling  │ ──────────────────►      │
  │  └──────────────────┘  (cancelledByUser:true)  │
  │                              ▼                 │
  │                     ┌────────────────┐         │
  │                     │ exec.cancelled │         │
  │                     └────────────────┘         │
  └────────────────────────────────────────────────┘

  CRASH PATH (any state):
  ┌────────────────────────────────────────────────┐
  │  QaError(recoverable: false) / SignalR drop    │
  │       ▼                                        │
  │  ┌─────────────────┐                           │
  │  │  exec.crashed   │                           │
  │  └─────────────────┘                           │
  └────────────────────────────────────────────────┘
```

---

## Animation Timing Summary

| Animation | Duration | Easing | Trigger |
|-----------|----------|--------|---------|
| Sweep fill (pass) | 500ms | `var(--ease)` | `.exp-card.pass::after` scaleX |
| Sweep fill (fail) | 300ms | `var(--ease)` | `.exp-card.fail::after` scaleX |
| Check icon pop | 300ms | `ease-out` | `@keyframes checkPop` |
| Fail icon shake | 400ms | `ease-out` | `@keyframes shake` |
| Timeout fade-in | 600ms | `ease-in` | Background color transition |
| Timeout pulse | 1000ms x2 | `ease-in-out` | `@keyframes pulse` on icon |
| Verdict banner slide-in | 200ms | `ease-out` | `translateY(20px)` → `translateY(0)` |
| Between-scenario progress bar | 500ms | `linear` | Width 0% → 100% |
| All-pass celebration particles | 800ms | `ease-out` | 3 floating ✓ elements |
| Cancel banner fade-in | 200ms | `ease-in` | Opacity 0 → 1 |

**`prefers-reduced-motion` override:** All animations collapse to instant transitions (0ms). Sweep fills apply immediately. Celebration particles disabled. Only state changes (color, icon) remain.

---

## Accessibility

| Requirement | Implementation |
|-------------|----------------|
| Screen reader announcements | `aria-live="polite"` region for expectation match/fail events. Format: "Expectation N [passed/failed] at Xms". |
| Scenario progress | `aria-label` on stepper: "Scenario N of M, N passed, N failed". Updated on each `QaScenarioCompleted`. |
| Expectation card focus | Each card is `role="listitem"` with `tabindex="0"`. Focus ring on `Tab`. `Enter` expands details. |
| Event feed | `role="log"`, `aria-live="polite"`. Throttled to max 1 announcement per 2s to avoid speech queue flooding. |
| Cancel confirmation | Modal dialog with `role="alertdialog"`. Focus trapped. `Escape` dismisses without cancelling. |
| Verdict banner | `role="alert"` — immediate announcement. |
| Color independence | All states have icon differentiation (○/✓/✕/◆) in addition to color. Text labels ("PASSED"/"FAILED"/"TIMED OUT") always visible. |

---

## Data Flow

```
QaStartRun (invoke)
    │
    ├── QaRunStarted ──────────────► exec.starting
    │                                    │
    ├── QaScenarioStarted ─────────► exec.scenario.setup
    │                                    │
    ├── QaScenarioPhaseChanged ────► setup → stimulus → capturing → teardown
    │       (8 per scenario)             │
    │                                    │ (during capture phase)
    ├── QaExpectationMatched ──────► exp.pending → exp.matched / exp.failed / exp.timeout
    │       (N per scenario)             │
    │                                    │
    ├── QaScenarioCompleted ───────► exec.scenario.complete.pass/fail/partial
    │       (1 per scenario)             │
    │                                    ├── exec.between (500ms)
    │                                    └── loop to next QaScenarioStarted
    │
    └── QaRunCompleted ────────────► exec.complete ──(1500ms)──► Results (S07)

QaCancelRun (invoke) ─────────────► exec.cancelling → exec.cancelled
QaError (recoverable: false) ─────► exec.crashed
```

---

## State Count Verification

| # | State | Category |
|---|-------|----------|
| 1 | `exec.idle` | Run lifecycle |
| 2 | `exec.starting` | Run lifecycle |
| 3 | `exec.scenario.setup` | Scenario phase |
| 4 | `exec.scenario.stimulus` | Scenario phase |
| 5 | `exec.scenario.capturing` | Scenario phase |
| 6 | `exec.scenario.exp.pending` | Expectation card |
| 7 | `exec.scenario.exp.matched` | Expectation card |
| 8 | `exec.scenario.exp.failed` | Expectation card |
| 9 | `exec.scenario.exp.timeout` | Expectation card |
| 10 | `exec.scenario.teardown` | Scenario phase |
| 11 | `exec.scenario.complete.pass` | Scenario verdict |
| 12 | `exec.scenario.complete.fail` | Scenario verdict |
| 13 | `exec.scenario.complete.partial` | Scenario verdict |
| 14 | `exec.between` | Run lifecycle |
| 15 | `exec.cancelling` | Cancellation |
| 16 | `exec.cancelled` | Cancellation |
| 17 | `exec.complete` | Run lifecycle |
| 18 | `exec.crashed` | Error |

**Total: 18 states** (minimum 15 required — exceeds by 3)
