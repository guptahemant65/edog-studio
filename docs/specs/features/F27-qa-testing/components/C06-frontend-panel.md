# C06: Frontend Panel — Component Deep Spec

> **Author:** Pixel (Senior Frontend Engineer)
> **Feature:** F27 QA Testing
> **Status:** P1 Design Complete
> **Date:** 2025-07-10
> **Design Reference:** `docs/specs/features/F27-qa-testing/mocks/qa-panel-exploration.html`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [S01: Panel Registration](#s01-panel-registration)
3. [S02: Stage Navigation](#s02-stage-navigation)
4. [S03: PR Input Stage](#s03-pr-input-stage)
5. [S04: Code Analysis Stage](#s04-code-analysis-stage)
6. [S05: Scenario Curation Stage](#s05-scenario-curation-stage)
7. [S06: Execution Stage](#s06-execution-stage)
8. [S07: Results Stage](#s07-results-stage)
9. [S08: SignalR Integration](#s08-signalr-integration)
10. [S09: State Management](#s09-state-management)
11. [S10: Keyboard Navigation](#s10-keyboard-navigation)
12. [S11: Responsive Layout](#s11-responsive-layout)
13. [S12: Error States](#s12-error-states)
14. [S13: Stage Transitions](#s13-stage-transitions)
15. [S14: Virtual Scrolling](#s14-virtual-scrolling)
16. [S15: Dark Theme](#s15-dark-theme)
17. [CSS Architecture](#css-architecture)
18. [JS Class Architecture](#js-class-architecture)

---

## 1. Architecture Overview

### File Layout

```
src/frontend/js/qa-panel.js          — QATestingPanel class (primary module)
src/frontend/js/qa-panel-state.js    — QAPanelState class (state management)
src/frontend/css/qa-panel.css        — All QA panel styles
```

All files are inlined into the single HTML output by `python scripts/build-html.py` (ADR-003).

### Class Diagram

```
EdogLogViewer (main.js:94)
  ├── sidebar: Sidebar (sidebar.js:20)
  │     └── switchView('qa') → activates QA panel
  ├── ws: SignalRManager (signalr-manager.js:16)
  │     ├── .on(topic, cb)          — Phase 3 topic event bus
  │     ├── .subscribeTopic(topic)  — ChannelReader streaming
  │     └── .connection.invoke()    — RPC to EdogPlaygroundHub
  └── qaPanel: QATestingPanel (qa-panel.js — NEW)
        ├── state: QAPanelState (qa-panel-state.js — NEW)
        ├── signalr: SignalRManager (shared ref from main.js)
        ├── stageManager: StageManager (internal)
        ├── prInput: PRInputController (internal)
        ├── analysis: AnalysisController (internal)
        ├── curation: CurationController (internal)
        ├── execution: ExecutionController (internal)
        ├── results: ResultsController (internal)
        └── virtualScroll: QAVirtualScroll (internal, for curation list)
```

### Integration Points with Existing Code

| Existing Module | Integration | Reference |
|-----------------|------------|-----------|
| `EdogLogViewer` | Instantiates `QATestingPanel`, passes `this.ws` | `src/frontend/js/main.js:94` |
| `Sidebar` | Registers `'qa'` view, fires `onViewChange('qa')` | `src/frontend/js/sidebar.js:78` |
| `SignalRManager` | `.on()` / `.subscribeTopic()` for QA event streaming | `src/frontend/js/signalr-manager.js:171-212` |
| `LogViewerState` | Not extended — QA uses its own `QAPanelState` | `src/frontend/js/state.js:125` |
| `Renderer` | Not reused — QA has custom DOM for each stage | `src/frontend/js/renderer.js:1` |
| `RuntimeView` | QA panel is a peer view, not a sub-tab of Runtime | `src/frontend/js/runtime-view.js` |

---

## S01: Panel Registration

**ID:** `C06-S01`
**One-liner:** QA Testing panel registers with the main orchestrator as a sidebar-navigable view.

### Description

The QA Testing panel must register itself with the existing `EdogLogViewer` orchestration system so that clicking the QA sidebar icon (◉) activates the panel. Registration follows the same pattern as DAG Studio: lazy-initialized on first activation, with `activate()` / `deactivate()` lifecycle hooks. The panel container is a top-level `<div>` sibling to the workspace, runtime, and DAG views, toggled via `display: none/flex`.

### Technical Mechanism

**In `main.js` constructor (after line ~136):**

```js
// QA Testing Panel (lazy-initialized on first view activation)
this.qaPanel = null;
```

**In `main.js` init() (after line ~222, register with sidebar):**

```js
// Wire QA panel activation into sidebar view switching
// Inside _onViewChange(viewId):
case 'qa':
  if (!this.qaPanel) {
    this.qaPanel = new QATestingPanel(
      document.getElementById('qa-panel-root'),
      this.ws,
      this.apiClient
    );
    this.qaPanel.init();
  }
  this.qaPanel.activate();
  break;
```

**In HTML template (peer to existing view containers):**

```html
<div id="qa-panel-root" class="view-container qa-view" style="display:none">
  <!-- Pipeline progress bar -->
  <div class="qa-pipeline" id="qaPipeline"></div>
  <!-- Stage containers -->
  <div class="qa-content" id="qaContent">
    <div class="qa-stage" id="qaStage1"></div>
    <div class="qa-stage" id="qaStage2"></div>
    <div class="qa-stage" id="qaStage3"></div>
    <div class="qa-stage qa-stage-exec" id="qaStage4"></div>
    <div class="qa-stage" id="qaStage5"></div>
  </div>
</div>
```

**In `sidebar.js` — add nav item:**

```html
<div class="nav-item" data-view="qa" title="QA Testing (Ctrl+6)">
  <span class="nav-icon">◉</span>
  <span class="nav-label">QA Testing</span>
</div>
```

### Source Code Path

- Panel instantiation: `src/frontend/js/main.js:136` (constructor) + `src/frontend/js/main.js:239` (`_onViewChange`)
- Sidebar nav item: `src/frontend/js/sidebar.js:47-48` (init reads `data-view` attributes)
- View container: `src/frontend/html/index.html` (template, inlined by build)
- QA Panel class: `src/frontend/js/qa-panel.js:1` (new file)

### Edge Cases

- **Double activation:** `activate()` must be idempotent — calling it twice must not re-render or re-subscribe to SignalR topics.
- **Phase mismatch:** QA Testing requires Connected phase (FLT running). If in Disconnected phase, show a phase gate message ("Connect to FLT to use QA Testing") instead of the pipeline.
- **SignalR not connected:** If `ws.status !== 'connected'` on activation, display a connection banner and auto-retry. Do not block the PR Input stage (it uses REST, not SignalR).
- **DAG Studio conflict:** DAG Studio and QA panel can both be instantiated. They must not compete for SignalR subscriptions. Each uses `.on()` / `.off()` scoping.

### Interactions with Other Components

- **C01 (Code Analysis Engine):** No direct interaction — C01 runs on backend. QA panel receives results via SignalR.
- **C02 (Scenario Generator):** Receives generated scenarios via SignalR `QA.ScenariosGenerated` event.
- **C03 (Execution Engine):** Sends execution commands via `connection.invoke('StartQARun', ...)`.
- **C04 (Assertion Engine):** Receives expectation match events via SignalR `QA.ExpectationMatched`.
- **C05 (PR Integration):** Calls backend API to post PR comments; receives preview markdown.

### Revert/Undo Mechanism

- `deactivate()` unsubscribes from all QA SignalR topics, pauses any running timers.
- State is preserved in `QAPanelState` across activate/deactivate cycles.
- Switching away during execution does NOT cancel execution — it continues in background.

### Priority

**P0** — Without registration, no QA panel exists.

---

## S02: Stage Navigation

**ID:** `C06-S02`
**One-liner:** Five-stage linear pipeline with forward progression, controlled back-navigation, and execution lock.

### Description

The QA workflow is a 5-stage pipeline: PR Input → Analyzing → Curation → Execution → Results. Stages are strictly linear — you cannot skip ahead. Back-navigation is allowed to completed stages (e.g., from Curation back to PR Input to change the PR). During execution (stage 4), navigation is locked — user cannot leave until execution completes, times out, or is cancelled. The pipeline bar at the top provides both visual progress and click-to-navigate for completed stages.

### Technical Mechanism

**Pipeline DOM (rendered by `StageManager.renderPipeline()`):**

```html
<div class="qa-pipeline">
  <div class="pipe-track">
    <!-- Repeated for stages 1-5 -->
    <div class="pipe-step active" data-stage="1" tabindex="0"
         role="tab" aria-selected="true" aria-label="PR Input (stage 1 of 5)">
      <div class="pipe-node">1</div>
      <div class="pipe-label">PR Input</div>
    </div>
    <div class="pipe-line" data-line="1"></div>
    <!-- ... stages 2-5 ... -->
  </div>
</div>
```

**State machine:**

```
STAGES = ['input', 'analyzing', 'curation', 'execution', 'results']

Transitions:
  input      → analyzing     (on: PR selected + "Analyze" clicked)
  analyzing  → curation      (on: all 3 analysis tracks complete)
  curation   → execution     (on: "Run Approved" with >= 1 approved)
  execution  → results       (on: all scenarios complete/failed/timed-out)

Back-navigation:
  curation   → input         (allowed: user wants different PR)
  results    → curation      (allowed: user wants to re-run subset)
  results    → input         (allowed: user wants different PR)
  execution  → *             (BLOCKED: locked until complete)

Forward skip:
  input      → curation      (BLOCKED: must analyze first)
  input      → execution     (BLOCKED: must curate first)
```

**StageManager pseudocode:**

```js
class StageManager {
  constructor(containerEl) {
    this._current = 0;      // index into STAGES
    this._maxReached = 0;   // highest stage reached
    this._locked = false;   // true during execution
    this._stageEls = [];    // cached DOM references
    this._pipeSteps = [];   // pipeline step elements
  }

  goTo(stageIndex) {
    if (this._locked && stageIndex !== 3) return;       // execution lock
    if (stageIndex > this._maxReached) return;           // no skipping ahead
    if (stageIndex === this._current) return;            // idempotent
    this._stageEls[this._current].classList.remove('visible');
    this._stageEls[stageIndex].classList.add('visible');
    this._current = stageIndex;
    this._updatePipeline();
    this.onStageChange?.(stageIndex);                    // notify parent
  }

  advance(stageIndex) {
    this._maxReached = Math.max(this._maxReached, stageIndex);
    this.goTo(stageIndex);
  }
}
```

### Source Code Path

- `src/frontend/js/qa-panel.js` — `StageManager` inner class
- Pipeline DOM: rendered in `QATestingPanel.init()`, inserted into `#qaPipeline`
- Stage containers: `#qaStage1` through `#qaStage5`

### Edge Cases

- **Execution in progress + browser close:** State persisted to `localStorage` key `edog-qa-state`. On re-open, if execution was in progress, show "Execution was interrupted" banner in results with partial data.
- **Re-analyzing:** Going back to stage 1 from stage 3 clears scenarios. Confirmation dialog: "Going back will discard generated scenarios. Continue?"
- **Empty curation:** "Run Approved" button disabled when `approvedCount === 0`.
- **Rapid clicking:** `goTo()` debounced with `requestAnimationFrame` to prevent double-transition.

### Interactions with Other Components

- **C01-C04:** Stage transitions are triggered by backend events. `analyzing → curation` fires when C01+C02 signal completion. `execution → results` fires when C03 signals all-done.
- **C05:** "Post to PR" button only appears in stage 5.

### Revert/Undo Mechanism

- Back-navigation restores the previous stage's DOM (preserved in memory, not re-rendered).
- Going back from curation to input shows confirmation before clearing scenario data.
- Going back from results to curation re-enables "Run Approved" with previous selections.

### Priority

**P0** — Core navigation framework for the entire feature.

---

## S03: PR Input Stage

**ID:** `C06-S03`
**One-liner:** PR URL/number input with validation, recent PRs list, and PR detail card rendering.

### Description

Stage 1 presents a centered input field for entering a PR URL or number, a list of recently analyzed PRs (persisted in `localStorage`), and a PR detail card that appears after validation. The input accepts: full ADO URLs (`https://dev.azure.com/powerbi/MWC/_git/.../pullrequest/{id}`), short PR numbers (`#12345` or `12345`), or branch-auto-detected PR (shown as a banner above the input). Validation is instant (regex for format) plus async (API call to verify PR exists and fetch metadata). The "Analyze" button advances to stage 2.

### Technical Mechanism

**DOM structure:**

```html
<div class="qa-stage visible" id="qaStage1">
  <div class="s1-wrap">
    <div class="sec-h">PULL REQUEST</div>
    <div class="s1-input-wrap">
      <span class="s1-input-icon">◇</span>
      <input class="s1-input" id="qaPrInput" type="text"
             placeholder="Enter PR # or URL..."
             autocomplete="off"
             aria-label="Pull request number or URL"
             role="searchbox">
    </div>
    <!-- Validation error (hidden by default) -->
    <div class="qa-input-error" id="qaPrError" role="alert" aria-live="polite"></div>

    <div class="sec-h" style="margin-top:var(--s5)">RECENT PRS</div>
    <div class="s1-recent" id="qaRecentPRs" role="listbox"
         aria-label="Recent pull requests"></div>

    <div id="qaPrCard" style="display:none"></div>
  </div>
</div>
```

**Input validation pseudocode:**

```js
class PRInputController {
  _parsePRInput(raw) {
    const trimmed = raw.trim();

    // Full ADO URL
    const urlMatch = trimmed.match(
      /dev\.azure\.com\/[^/]+\/[^/]+\/_git\/[^/]+\/pullrequest\/(\d+)/
    );
    if (urlMatch) return { type: 'url', prNumber: parseInt(urlMatch[1]) };

    // Short form: #12345 or 12345
    const numMatch = trimmed.match(/^#?(\d{1,6})$/);
    if (numMatch) return { type: 'number', prNumber: parseInt(numMatch[1]) };

    return null; // invalid
  }

  async _fetchPRDetails(prNumber) {
    // POST to EDOG backend → backend calls ADO REST API
    const resp = await fetch(`/api/qa/pr/${prNumber}`);
    if (!resp.ok) throw new Error(`PR #${prNumber} not found`);
    return resp.json();
    // Returns: { number, title, author, files[], additions, deletions, createdAt }
  }
}
```

**Recent PRs storage:**

```js
// localStorage key: 'edog-qa-recent-prs'
// Format: JSON array, max 10 entries, newest first
[
  { number: 14823, title: "Fix retry logic...", analyzedAt: "2025-07-10T..." },
  { number: 14801, title: "Add Spark session...", analyzedAt: "2025-07-09T..." }
]
```

### Source Code Path

- Controller: `src/frontend/js/qa-panel.js` — `PRInputController` inner class
- Input element: `#qaPrInput` in HTML template
- API call: `src/frontend/js/api-client.js` — extend `FabricApiClient` with `fetchPRDetails()`
- Recent PRs: `localStorage` key `edog-qa-recent-prs`

### Edge Cases

- **Invalid format:** Show inline error "Enter a PR number (e.g., #12345) or ADO URL" below input. Input border turns `var(--fail)`.
- **PR not found (404):** Show inline error "PR #12345 not found. Check the number and try again."
- **Network failure:** Show inline error "Could not reach EDOG backend. Check connection."
- **Very long URL:** Input truncates display with ellipsis; full URL preserved in value.
- **Paste event:** `paste` listener triggers immediate validation (don't wait for Enter).
- **Branch auto-detect:** If `git branch` matches an open PR, show a banner: "Detected PR #14823 from current branch `feature/retry-fix`" with "Use this PR" button.

### Interactions with Other Components

- **C01 (Code Analysis):** "Analyze" button triggers `connection.invoke('StartQAAnalysis', prNumber)`, which starts C01 on the backend.
- **C05 (PR Integration):** PR metadata is shared — fetched once here, reused in results stage for comment posting.

### Revert/Undo Mechanism

- Input is clearable with the `Escape` key (clears text, hides PR card).
- Recent PRs list is persistent; individual items removable via hover ✕ button.
- Selecting a different PR replaces the current PR card.

### Priority

**P0** — Entry point for the entire workflow.

---

## S04: Code Analysis Stage

**ID:** `C06-S04`
**One-liner:** Three parallel analysis tracks (Roslyn, Graphify, GPT) with animated progress bars and status updates.

### Description

Stage 2 shows three analysis tracks running in parallel. Each track has: an icon, name, progress bar, status badge (PENDING → RUNNING → DONE), and a subtitle showing current step text. Progress updates arrive via SignalR events. When all three tracks complete, the stage auto-advances to Curation. The three tracks correspond to the backend's code understanding pipeline: L1-L2 structural analysis (Roslyn + Graphify), L3 semantic enrichment, and L4 scenario generation (GPT-5.4-pro).

### Technical Mechanism

**DOM structure per track:**

```html
<div class="an-track" role="status" aria-label="Roslyn Blast Radius analysis">
  <div class="an-top">
    <div class="an-icon roslyn">◆</div>
    <div class="an-name">Roslyn Blast Radius</div>
    <div class="an-status pending" aria-live="polite">PENDING</div>
  </div>
  <div class="an-bar-wrap" role="progressbar"
       aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
    <div class="an-bar roslyn-bar" style="width:0"></div>
  </div>
  <div class="an-sub" aria-live="polite"></div>
</div>
```

**SignalR events consumed:**

```
QA.AnalysisProgress → { track: 'roslyn'|'graphify'|'gpt', progress: 0-100,
                         step: string, status: 'pending'|'running'|'done',
                         detail?: string }
QA.AnalysisComplete → { impactZones: Zone[], scenarioCount: number }
QA.AnalysisError    → { track: string, error: string, recoverable: boolean }
```

**AnalysisController pseudocode:**

```js
class AnalysisController {
  constructor(containerEl, signalr) {
    this._tracks = new Map(); // 'roslyn'|'graphify'|'gpt' → DOM refs
    this._completedCount = 0;
  }

  start(prNumber) {
    this._renderTracks();
    this._completedCount = 0;

    this.signalr.on('qa', (event) => {
      if (event.Data?.type === 'AnalysisProgress') {
        this._updateTrack(event.Data);
      }
      if (event.Data?.type === 'AnalysisComplete') {
        this.onComplete?.(event.Data);
      }
    });

    // Trigger analysis on backend
    this.signalr.connection.invoke('StartQAAnalysis', prNumber);
  }

  _updateTrack(data) {
    const track = this._tracks.get(data.track);
    if (!track) return;
    track.bar.style.width = data.progress + '%';
    track.barWrap.setAttribute('aria-valuenow', data.progress);
    track.status.className = 'an-status ' + data.status;
    track.status.textContent = data.status.toUpperCase();
    if (data.step) track.sub.textContent = data.step;
    if (data.status === 'done') {
      this._completedCount++;
      if (data.detail) track.sub.textContent = data.detail;
    }
  }
}
```

### Source Code Path

- Controller: `src/frontend/js/qa-panel.js` — `AnalysisController` inner class
- SignalR subscription: uses `SignalRManager.on('qa', cb)` from `src/frontend/js/signalr-manager.js:171`
- Backend trigger: `connection.invoke('StartQAAnalysis', prNumber)` → handled by `EdogPlaygroundHub`

### Edge Cases

- **One track fails, others succeed:** Show failed track with red status badge "ERROR" and error message in subtitle. Display "Continue with partial analysis?" button that advances to curation with whatever data was gathered.
- **All tracks fail:** Show full-width error card with "Analysis Failed" heading, error details, and "Try Again" + "Create Manual Scenarios" buttons.
- **SignalR disconnects mid-analysis:** Show reconnection banner. On reconnect, request analysis status via `connection.invoke('GetQAAnalysisStatus')`.
- **Very slow analysis (>60s):** Show elapsed time counter and "This is taking longer than expected" note after 45s.
- **User navigates away and back:** If analysis is still running, restore progress bars to last known position.

### Interactions with Other Components

- **C01 (Code Analysis Engine):** Direct consumer of C01's progress events.
- **C02 (Scenario Generator):** `QA.AnalysisComplete` event includes generated scenarios, bridging C01→C02→C06.
- **C06-S02:** Auto-advances to stage 3 on completion.

### Revert/Undo Mechanism

- Going back to stage 1 during analysis sends `connection.invoke('CancelQAAnalysis')`.
- Analysis is not resumable — going back and re-analyzing starts fresh.

### Priority

**P0** — Blocks scenario generation display.

---

## S05: Scenario Curation Stage

**ID:** `C06-S05`
**One-liner:** Scenario card list grouped by impact zone with approve/reject/edit/bulk actions and inline editor.

### Description

Stage 3 displays generated scenarios grouped under collapsible impact zone headers. Each scenario is a card row showing: approval checkbox, title, category badge, priority, topic pills, expectation count, estimated duration, and edit/delete action buttons. Users approve scenarios for execution (all approved by default). The inline editor opens below a card to modify name, description, category, priority, setup steps, and expectations. Bulk actions include "Approve All" and "Run Approved N". A coverage gap warning appears when the analysis engine detected untestable code paths.

### Technical Mechanism

**Top-level DOM:**

```html
<div class="qa-stage" id="qaStage3">
  <div class="s3-top">
    <div class="s3-meta" id="qaS3Meta">
      <!-- "3 impact zones ▸ 8 scenarios ▸ 22 expectations" -->
    </div>
    <div class="s3-actions">
      <button class="btn-primary btn-sm" id="qaBtnApproveAll"
              aria-label="Approve all scenarios">Approve All</button>
      <button class="btn-ghost btn-sm" id="qaBtnRunApproved"
              aria-label="Run approved scenarios">
        Run Approved <span class="s3-count" id="qaApprovedCount">0</span>
      </button>
    </div>
  </div>
  <!-- Coverage gap warning (conditional) -->
  <div class="gap-warn" id="qaGapWarn" role="alert" style="display:none"></div>
  <!-- Scenario zones container (virtual scroll wrapper for >50 scenarios) -->
  <div id="qaCurationZones" role="list" aria-label="Test scenarios by impact zone"></div>
</div>
```

**Scenario row DOM (per scenario):**

```html
<div class="sc-row" data-id="scn-001" role="listitem"
     aria-label="WriteFileAsync writes to correct OneLake path">
  <div class="sc-main">
    <div class="sc-check" role="checkbox" aria-checked="false"
         tabindex="0" aria-label="Approve scenario">✓</div>
    <div class="sc-info">
      <div class="sc-title-row">
        <span class="sc-name">WriteFileAsync writes to correct OneLake path</span>
        <span class="sc-cat happy">HAPPY</span>
        <span class="sc-priority">P1</span>
        <span class="sc-meta-text">4 exp</span>
        <span class="sc-meta-text">~15s</span>
      </div>
      <div class="sc-topics">
        <span class="sc-topic fileop">fileop</span>
        <span class="sc-topic http">http</span>
      </div>
    </div>
    <div class="sc-actions">
      <button class="sc-act" aria-label="Edit scenario" title="Edit">✎</button>
      <button class="sc-act del" aria-label="Remove scenario" title="Remove">✕</button>
    </div>
  </div>
  <div class="sc-editor" aria-hidden="true">
    <!-- Inline editor (collapsed by default) -->
  </div>
</div>
```

**CurationController core logic:**

```js
class CurationController {
  constructor(containerEl, state) {
    this._approved = new Set();    // scenario IDs
    this._rejected = new Set();    // scenario IDs
    this._editingId = null;        // currently open editor
    this._zones = [];              // impact zone data from analysis
    this._scenarios = [];          // scenario array from backend
  }

  renderZones(zones, scenarios) {
    this._zones = zones;
    this._scenarios = scenarios;
    // Auto-approve all on initial render
    scenarios.forEach(sc => this._approved.add(sc.id));
    // Render zone groups with scenario rows
    this._container.innerHTML = '';
    for (const zone of zones) {
      const zoneScenarios = scenarios.filter(s => s.impactZone === zone.zoneId);
      this._renderZone(zone, zoneScenarios);
    }
    this._updateMeta();
    this._updateApprovedCount();
  }

  toggleApprove(scenarioId) {
    if (this._rejected.has(scenarioId)) return;
    if (this._approved.has(scenarioId)) {
      this._approved.delete(scenarioId);
    } else {
      this._approved.add(scenarioId);
    }
    this._updateCheckbox(scenarioId);
    this._updateApprovedCount();
  }

  rejectScenario(scenarioId) {
    this._rejected.add(scenarioId);
    this._approved.delete(scenarioId);
    // Animate row out: opacity 0.3, scale 0.95, grayscale, pointer-events:none
    this._updateApprovedCount();
  }
}
```

### Source Code Path

- Controller: `src/frontend/js/qa-panel.js` — `CurationController` inner class
- Scenario data model: follows `spec.md:§4.1` JSON schema (`id`, `title`, `category`, `expectations[]`)
- Zone data: from `QA.AnalysisComplete` event payload

### Edge Cases

- **Zero scenarios generated:** Show empty state card: "No scenarios could be generated for this PR. The changed code may not be observable through interceptors." With "Create Manual Scenario" button.
- **100+ scenarios:** Virtual scroll kicks in (see S14). Only DOM-renders visible rows + buffer.
- **All scenarios rejected:** "Run Approved" button disabled. Meta text updates to "0 scenarios selected".
- **Editor save validation:** Scenario must have at least 1 expectation. Name must be non-empty (max 120 chars). Toast error on validation failure.
- **Concurrent edit:** Only one editor open at a time. Opening a new editor auto-closes the previous one.
- **Zone collapse:** Collapsing a zone hides all its scenario rows. Approved/rejected state is preserved.

### Interactions with Other Components

- **C02 (Scenario Generator):** Receives scenario data. Editor changes stay local until execution (backend receives curated list at execution start).
- **C03 (Execution Engine):** "Run Approved" sends `connection.invoke('StartQARun', approvedScenarios[])`.
- **C06-S06:** Passes approved scenario list to ExecutionController.

### Revert/Undo Mechanism

- Rejected scenarios have a 5s undo toast: "Scenario removed. [Undo]". Undo restores the row.
- "Approve All" is reversible by individually un-checking scenarios.
- Editor "Cancel" discards all unsaved changes and restores original values.
- Going back to stage 1 from curation shows confirmation dialog before clearing.

### Priority

**P0** — Core user interaction for scenario management.

---

## S06: Execution Stage

**ID:** `C06-S06`
**One-liner:** Split-pane execution view with scenario queue sidebar, expectation stacked cards with sweep animations, live event feed, and verdict banner.

### Description

Stage 4 is a two-column layout: a narrow sidebar (240px) showing the scenario queue with status indicators, and a main panel showing the currently executing scenario's details. The main panel contains: scenario title and description, the expectation tracker (stacked cards that animate with a sweep fill as expectations match), a live event feed showing interceptor events in real-time, and a verdict banner (pass/fail) when the scenario completes. A mini-stepper above the sidebar shows dot indicators for all scenarios. Scenarios execute sequentially with 500ms isolation gaps.

### Technical Mechanism

**DOM structure:**

```html
<div class="qa-stage qa-stage-exec" id="qaStage4">
  <div class="exec-wrap">
    <!-- Sidebar: scenario queue -->
    <div class="exec-sidebar" id="qaExecSidebar">
      <div class="eq-header">SCENARIO QUEUE</div>
      <div class="exec-stepper" id="qaExecStepper" role="tablist"
           aria-label="Scenario execution progress">
        <!-- Dot per scenario: .es-dot.pending|running|pass|fail -->
      </div>
      <!-- Scenario list items -->
      <div class="eq-item pending" role="tab" aria-selected="false">
        <span class="eq-icon">○</span>
        <span class="eq-name">WriteFileAsync writes to correct path</span>
        <span class="eq-dur"></span>
      </div>
    </div>

    <!-- Main: active scenario -->
    <div class="exec-main" id="qaExecMain">
      <div class="exec-title">WriteFileAsync writes to correct OneLake path</div>
      <div class="exec-sub">
        <span class="sc-cat happy">HAPPY</span>
        <span>4 expectations</span>
        <span>~15s timeout</span>
      </div>

      <!-- Expectation stacked cards -->
      <div class="exp-stack">
        <div class="exp-stack-head">
          <span class="exp-stack-label">EXPECTATIONS</span>
          <span class="exp-stack-stat">0 / 4</span>
        </div>
        <div class="exp-cards" role="list" aria-label="Expectation results">
          <div class="exp-card" role="listitem">
            <span class="exp-card-num">1</span>
            <span class="exp-card-icon"></span>
            <span class="exp-card-name">PUT request to correct OneLake path</span>
            <span class="exp-card-time"></span>
          </div>
          <!-- Repeat for each expectation -->
        </div>
      </div>

      <!-- Live event feed -->
      <div class="ev-feed" aria-label="Live interceptor events">
        <div class="ev-header">
          <span class="ev-header-dot"></span> LIVE EVENTS
        </div>
        <div class="ev-list" id="qaEvList" role="log" aria-live="polite"></div>
      </div>

      <!-- Verdict banner (hidden until scenario completes) -->
      <div class="verdict pass" style="display:none" role="alert">
        <div class="verdict-icon">✓</div>
        <div class="verdict-text">PASSED</div>
        <div class="verdict-dur">3.2s</div>
      </div>
    </div>
  </div>
</div>
```

**Expectation sweep animation mechanism:**

```js
// When an ExpectationMatched event arrives:
_onExpectationMatched(expId, matchTime) {
  const card = this._expCards.get(expId);
  if (!card) return;

  // 1. Add pass/fail class — triggers CSS ::after scaleX(1) sweep
  card.el.classList.add('pass');

  // 2. Icon pops with checkPop animation
  card.icon.classList.add('pass');

  // 3. Show match time
  card.time.textContent = matchTime + 'ms';

  // 4. Update counter
  this._matchedCount++;
  this._statEl.textContent = this._matchedCount + ' / ' + this._totalExp;

  // 5. Screen reader announcement
  this._announce(`Expectation ${expId} passed at ${matchTime}ms`);
}
```

**CSS for sweep fill (from mock):**

```css
.exp-card::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: scaleX(0);
  transform-origin: left;
  z-index: 0;
}
.exp-card.pass::after {
  background: var(--ok-dim);
  transform: scaleX(1);
  transition: transform 500ms var(--ease);
}
.exp-card.fail::after {
  background: var(--fail-dim);
  transform: scaleX(1);
  transition: transform 300ms var(--ease);
}
```

**SignalR events consumed during execution:**

```
QA.ScenarioStarted    → { scenarioId, timestamp }
QA.InterceptorEvent   → { scenarioId, topic, timestamp, data, matchedExpId? }
QA.ExpectationMatched → { scenarioId, expectationId, passed, matchTimeMs, evidence }
QA.ScenarioCompleted  → { scenarioId, passed, durationMs, results[] }
QA.RunComplete        → { totalPassed, totalFailed, totalDuration }
```

### Source Code Path

- Controller: `src/frontend/js/qa-panel.js` — `ExecutionController` inner class
- SignalR events: `SignalRManager.on('qa', cb)` at `src/frontend/js/signalr-manager.js:171`
- Sweep animation CSS: `src/frontend/css/qa-panel.css` — `.exp-card::after` transition
- Event feed: virtual scroll for high-frequency event streams (reuses pattern from `renderer.js:9`)

### Edge Cases

- **Scenario timeout:** After `scenario.timeout` ms, show timer badge turning red. Card shows "TIMED OUT" with amber status.
- **FLT crash during execution:** SignalR disconnects. Show "Connection lost — FLT may have crashed. Waiting for reconnect..." banner. On reconnect, query execution status.
- **High-frequency events (>100/s):** Event feed uses throttled rendering — batch DOM updates every 100ms via `requestAnimationFrame`. Only render visible rows + 10 row buffer.
- **Zero expectations matched:** Verdict banner shows "FAILED — No expectations matched" with debugging hints.
- **User tries to navigate away:** Show confirmation: "Execution in progress. Leaving will NOT cancel it, but you'll lose the live view."

### Interactions with Other Components

- **C03 (Execution Engine):** Receives all execution lifecycle events. Sends `connection.invoke('StartQARun', scenarios)` to initiate.
- **C04 (Assertion Engine):** `QA.ExpectationMatched` events drive the sweep animation.
- **C06-S07:** On `QA.RunComplete`, auto-advances to results stage.

### Revert/Undo Mechanism

- Execution cannot be undone, but can be cancelled via "Cancel Run" button (sends `connection.invoke('CancelQARun')`).
- Cancellation completes the current scenario (doesn't abort mid-stimulus) and skips remaining.
- After cancel, advances to results with partial data.

### Priority

**P0** — Core execution visualization.

---

## S07: Results Stage

**ID:** `C06-S07`
**One-liner:** Summary dashboard with pass/fail ring chart, per-scenario expandable result cards, failure diff panel, and PR comment preview.

### Description

Stage 5 shows execution results: a summary card (total pass/fail counts, ring SVG, total duration), followed by expandable result cards for each scenario. Failed scenarios show a diff panel comparing expected vs. observed values. A footer contains "Post Results to PR" and "Re-run Failed" buttons. The PR comment preview shows a formatted markdown preview of what will be posted.

### Technical Mechanism

**Summary card DOM:**

```html
<div class="res-summary" role="region" aria-label="Results summary">
  <div>
    <div class="res-big">7<span style="font-size:var(--lg);color:var(--text-muted)"> / 8</span></div>
    <div class="res-label">scenarios passed</div>
  </div>
  <div class="res-info">
    <div class="res-badge pass">PASSED</div>
    <div class="res-stats">
      <span class="ok">7 passed</span>
      <span class="dot">●</span>
      <span class="fail">1 failed</span>
      <span class="dot">●</span>
      <span>32.4s total</span>
    </div>
    <!-- Coverage bar -->
    <div class="cov-bar">
      <div class="cov-pass" style="width:87.5%"></div>
      <div class="cov-fail" style="width:12.5%"></div>
    </div>
  </div>
  <div class="res-ring-wrap">
    <svg width="56" height="56" viewBox="0 0 56 56" role="img"
         aria-label="7 of 8 passed (87.5%)">
      <circle cx="28" cy="28" r="22" fill="none"
              stroke="var(--surface-3)" stroke-width="4"/>
      <circle cx="28" cy="28" r="22" fill="none"
              stroke="var(--ok)" stroke-width="4"
              stroke-linecap="round"
              style="--circ:138.2;--offset:17.3"
              stroke-dasharray="138.2"
              stroke-dashoffset="17.3"
              transform="rotate(-90 28 28)"/>
    </svg>
  </div>
</div>
```

**Per-scenario result row (expandable):**

```html
<div class="res-row" role="region" aria-label="Scenario result">
  <div class="res-row-head" tabindex="0" role="button"
       aria-expanded="false" aria-label="Toggle scenario details">
    <div class="res-icon pass">✓</div>
    <div class="res-name">WriteFileAsync writes to correct path</div>
    <span class="res-cat happy">HAPPY</span>
    <span class="res-dur">3.2s</span>
  </div>
  <div class="res-expand">
    <div class="res-exp-list">
      <div class="res-exp">
        <div class="res-exp-icon pass">✓</div>
        <span class="res-exp-name">PUT request to correct OneLake path</span>
        <span class="res-exp-dur">210ms</span>
      </div>
      <!-- ... more expectations ... -->
    </div>
  </div>
</div>
```

**Failed scenario diff panel:**

```html
<div class="diff-panel">
  <div>
    <div class="diff-col-head expected">EXPECTED</div>
    <div class="diff-line green">Token refresh triggered before retry</div>
    <div class="diff-line green">Retry uses fresh token in Authorization header</div>
  </div>
  <div>
    <div class="diff-col-head observed">OBSERVED</div>
    <div class="diff-line red">No token refresh event captured</div>
    <div class="diff-line red">Retry used stale token (expired 200ms prior)</div>
  </div>
</div>
```

**PR Comment Preview — rendered in a modal:**

```js
_renderCommentPreview(results) {
  // Formats as ADO-compatible markdown
  // Uses § symbol for structured sections
  // Includes: summary table, failed scenario details, EDOG link
  return `## QA Testing Results — PR #${results.prNumber}\n\n` +
    `| Metric | Value |\n|---|---|\n` +
    `| Scenarios | ${results.passed}/${results.total} passed |\n` +
    `| Duration | ${results.totalDuration} |\n` +
    `| Coverage | ${results.coveragePct}% of impacted code |\n\n` +
    // ... failure details ...
    `\n> Generated by EDOG Studio F27 QA Testing`;
}
```

### Source Code Path

- Controller: `src/frontend/js/qa-panel.js` — `ResultsController` inner class
- Ring SVG: inline SVG with CSS animation `ringDraw` from design tokens
- Diff panel: dark-theme-only fixed background `#1e1e2e` (Catppuccin Mocha)
- PR comment API: `connection.invoke('PostQAResults', prNumber, results)`

### Edge Cases

- **All pass:** Ring is full green. Summary badge says "ALL PASSED". "Post to PR" prominent.
- **All fail:** Ring is full red. Summary badge says "ALL FAILED". "Re-run All" prominent instead of "Post to PR".
- **No execution data (crash recovery):** Show partial results with "Execution was interrupted" banner.
- **Very long failure diff:** Diff panel max-height with scroll. Truncate at 20 lines with "Show more" expander.
- **PR comment post failure:** Toast error "Failed to post to PR. Check ADO permissions." with "Copy to clipboard" fallback.

### Interactions with Other Components

- **C03 (Execution Engine):** Consumes final `QA.RunComplete` payload.
- **C04 (Assertion Engine):** Failed expectation evidence populates the diff panel.
- **C05 (PR Integration):** "Post Results to PR" triggers C05's API call.
- **C06-S05:** "Re-run Failed" navigates back to curation with only failed scenarios selected.

### Revert/Undo Mechanism

- "Re-run Failed" pre-selects failed scenarios and navigates to curation.
- "Re-run All" resets to curation with all previously approved scenarios.
- Results are preserved in `QAPanelState` — navigating away and back restores them.

### Priority

**P0** — Final output of the entire feature.

---

## S08: SignalR Integration

**ID:** `C06-S08`
**One-liner:** QA panel subscribes to the `qa` topic via the Phase 3 event bus for all real-time communication.

### Description

The QA panel uses the existing `SignalRManager` Phase 3 topic event bus (`.on()`, `.subscribeTopic()`) to receive all backend events. It subscribes to a dedicated `qa` topic that carries all QA-specific events (analysis progress, scenario data, execution events, results). The panel also uses `connection.invoke()` for RPC calls (start analysis, start execution, cancel, post results). All subscriptions are registered on `activate()` and unregistered on `deactivate()` to avoid memory leaks and ghost handlers.

### Technical Mechanism

**Subscription lifecycle:**

```js
class QATestingPanel {
  activate() {
    // Subscribe to QA topic via Phase 3 event bus
    this._qaHandler = (event) => this._handleQAEvent(event);
    this.signalr.on('qa', this._qaHandler);
    this.signalr.subscribeTopic('qa');
  }

  deactivate() {
    // Unsubscribe to prevent ghost handlers
    if (this._qaHandler) {
      this.signalr.off('qa', this._qaHandler);
      this._qaHandler = null;
    }
    // Note: do NOT unsubscribeTopic if execution is running
    if (!this.state.isExecuting) {
      this.signalr.unsubscribeTopic('qa');
    }
  }

  _handleQAEvent(event) {
    const data = event.Data || event.data || event;
    switch (data.type) {
      case 'AnalysisProgress':  this.analysis.handleProgress(data); break;
      case 'AnalysisComplete':  this._onAnalysisComplete(data);     break;
      case 'AnalysisError':     this.analysis.handleError(data);    break;
      case 'ScenarioStarted':   this.execution.handleStart(data);   break;
      case 'InterceptorEvent':  this.execution.handleEvent(data);   break;
      case 'ExpectationMatched':this.execution.handleMatch(data);   break;
      case 'ScenarioCompleted': this.execution.handleComplete(data);break;
      case 'RunComplete':       this._onRunComplete(data);          break;
    }
  }
}
```

**RPC calls (invoke):**

| Method | Direction | Payload |
|--------|-----------|---------|
| `StartQAAnalysis` | Client → Hub | `{ prNumber: int }` |
| `GetQAAnalysisStatus` | Client → Hub | `{}` → returns current progress |
| `StartQARun` | Client → Hub | `{ scenarios: Scenario[] }` |
| `CancelQARun` | Client → Hub | `{}` |
| `PostQAResults` | Client → Hub | `{ prNumber, results }` |
| `GetQACommentPreview` | Client → Hub | `{ results }` → returns markdown |

### Source Code Path

- Event bus: `src/frontend/js/signalr-manager.js:171` (`.on()` method)
- Topic streaming: `src/frontend/js/signalr-manager.js:186` (`.subscribeTopic()`)
- Reconnect: `src/frontend/js/signalr-manager.js:147` (`._resubscribeAll()`)
- QA handler: `src/frontend/js/qa-panel.js` — `_handleQAEvent()`

### Edge Cases

- **Reconnect during execution:** `_resubscribeAll()` in `signalr-manager.js:147` re-streams the `qa` topic. QA panel must handle duplicate events (idempotent by `sequenceId`).
- **Stale events after reconnect:** Snapshot replay may include events already processed. Use `TopicEvent.SequenceId` to deduplicate (track `_lastSeenSeq`).
- **Topic not registered on backend:** If `qa` topic doesn't exist (backend not updated), `subscribeTopic` fails silently. Show "QA backend not available" banner.
- **High event throughput:** During execution, events can arrive at >100/s. Batch UI updates per `requestAnimationFrame` cycle.

### Interactions with Other Components

- **C01-C05:** All backend components communicate to C06 exclusively through SignalR events on the `qa` topic.
- **Existing topics (http, log, etc.):** QA panel does NOT subscribe to individual interceptor topics. The backend filters and forwards relevant events through the `qa` topic with `InterceptorEvent` wrapper.

### Revert/Undo Mechanism

- `deactivate()` cleans up all listeners.
- On SignalR permanent disconnect, panel falls back to polling via REST: `GET /api/qa/status`.

### Priority

**P0** — Communication backbone for all real-time features.

---

## S09: State Management

**ID:** `C06-S09`
**One-liner:** Dedicated `QAPanelState` class with scenario data, execution state, and `localStorage` persistence — separate from `LogViewerState`.

### Description

The QA panel maintains its own state object (`QAPanelState`) rather than extending the existing `LogViewerState`. This separation is intentional: QA state is structured around scenarios and workflow stages, not ring buffers and log entries. State is persisted to `localStorage` for crash recovery and session continuity. The state object is the single source of truth — all controllers read from and write to it.

### Technical Mechanism

```js
class QAPanelState {
  constructor() {
    // Workflow
    this.currentStage = 0;         // 0-4 (index into STAGES)
    this.maxStage = 0;             // highest stage reached
    this.prNumber = null;          // selected PR number
    this.prDetails = null;         // PR metadata from API

    // Analysis
    this.analysisStatus = 'idle';  // 'idle'|'running'|'complete'|'error'
    this.impactZones = [];         // Zone[] from analysis
    this.scenarios = [];           // Scenario[] from generation

    // Curation
    this.approved = new Set();     // scenario IDs approved for execution
    this.rejected = new Set();     // scenario IDs rejected
    this.edits = new Map();        // scenarioId → edited fields

    // Execution
    this.isExecuting = false;
    this.executionQueue = [];      // ordered scenario IDs for execution
    this.currentScenarioIdx = -1;  // index in executionQueue
    this.scenarioResults = new Map(); // scenarioId → result object
    this.eventLog = [];            // interceptor events during execution

    // Results
    this.runResult = null;         // { totalPassed, totalFailed, totalDuration }

    // Persistence
    this._storageKey = 'edog-qa-state';
    this._lastSeenSeq = -1;       // dedup for SignalR reconnect
  }

  /** Persist critical state for crash recovery. */
  save() {
    const snapshot = {
      currentStage: this.currentStage,
      prNumber: this.prNumber,
      isExecuting: this.isExecuting,
      executionQueue: this.executionQueue,
      currentScenarioIdx: this.currentScenarioIdx,
      scenarioResults: [...this.scenarioResults.entries()],
      _lastSeenSeq: this._lastSeenSeq,
      timestamp: Date.now()
    };
    try {
      localStorage.setItem(this._storageKey, JSON.stringify(snapshot));
    } catch { /* quota exceeded — non-fatal */ }
  }

  /** Restore state after crash/reload. */
  restore() {
    try {
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return false;
      const snapshot = JSON.parse(raw);
      // Only restore if < 1 hour old
      if (Date.now() - snapshot.timestamp > 3600000) return false;
      Object.assign(this, {
        currentStage: snapshot.currentStage,
        prNumber: snapshot.prNumber,
        isExecuting: false, // never resume execution automatically
        executionQueue: snapshot.executionQueue,
        currentScenarioIdx: snapshot.currentScenarioIdx,
        scenarioResults: new Map(snapshot.scenarioResults),
        _lastSeenSeq: snapshot._lastSeenSeq
      });
      return true;
    } catch { return false; }
  }

  reset() {
    this.currentStage = 0;
    this.maxStage = 0;
    this.prNumber = null;
    this.prDetails = null;
    this.analysisStatus = 'idle';
    this.impactZones = [];
    this.scenarios = [];
    this.approved.clear();
    this.rejected.clear();
    this.edits.clear();
    this.isExecuting = false;
    this.executionQueue = [];
    this.currentScenarioIdx = -1;
    this.scenarioResults.clear();
    this.eventLog = [];
    this.runResult = null;
    this._lastSeenSeq = -1;
    localStorage.removeItem(this._storageKey);
  }
}
```

### Source Code Path

- Class: `src/frontend/js/qa-panel-state.js` (new file)
- Consumed by: `QATestingPanel`, all controllers
- Persistence: `localStorage` key `edog-qa-state`

### Edge Cases

- **`localStorage` quota exceeded:** `save()` wraps in try/catch. Non-fatal — state is in-memory anyway.
- **Corrupted stored state:** `restore()` catches parse errors and returns `false`.
- **Stale state (>1 hour):** Discard — the FLT process has likely restarted.
- **Multiple tabs:** Each tab has independent QA state. No cross-tab sync (would add complexity without clear benefit).

### Interactions with Other Components

- **`LogViewerState` (`state.js:125`):** Completely separate. QA state does not read or write log ring buffers.
- **All controllers:** Reference `this.state` (the `QAPanelState` instance) for reads and writes.

### Revert/Undo Mechanism

- `reset()` clears all state and removes `localStorage` entry.
- Individual undo (rejected scenarios) is handled by controllers, not state.

### Priority

**P0** — Foundation for all stateful behavior.

---

## S10: Keyboard Navigation

**ID:** `C06-S10`
**One-liner:** Complete keyboard navigation with Tab ordering, stage shortcuts, scenario actions, and focus management.

### Description

Every interactive element in the QA panel is keyboard-accessible. Stage shortcuts (1-5 keys) navigate the pipeline. Scenario rows support Enter to toggle approve, E to edit, Delete/Backspace to reject. Focus management ensures logical tab order within each stage. Modal dialogs trap focus. The help overlay (?) shows all available shortcuts.

### Technical Mechanism

**Global keyboard handler (attached on `activate()`):**

```js
_bindKeyboard() {
  this._keyHandler = (e) => {
    // Ignore if typing in input/textarea
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    switch (e.key) {
      case '1': case '2': case '3': case '4': case '5':
        this.stageManager.goTo(parseInt(e.key) - 1);
        break;
      case 'a': case 'A':
        if (this.state.currentStage === 2) this.curation.approveAll();
        break;
      case 'r': case 'R':
        if (this.state.currentStage === 2) this.curation.runApproved();
        break;
      case '?':
        this._toggleHelp();
        break;
      case 'Escape':
        this._handleEscape();
        break;
    }
  };
  document.addEventListener('keydown', this._keyHandler);
}
```

**Tab order per stage:**

| Stage | Tab sequence |
|-------|-------------|
| 1 (PR Input) | Input field → Recent PR items → PR card "Analyze" button |
| 2 (Analyzing) | (No interactive elements — auto-advancing) |
| 3 (Curation) | "Approve All" → "Run Approved" → First scenario checkbox → Edit → Delete → Next scenario... |
| 4 (Execution) | Sidebar scenario items → "Cancel Run" button |
| 5 (Results) | Result rows (Enter to expand) → "Re-run Failed" → "Post to PR" → "Copy to Clipboard" |

**Focus management on stage transition:**

```js
_onStageChange(stageIndex) {
  // Move focus to first focusable element in new stage
  requestAnimationFrame(() => {
    const stage = this._stageEls[stageIndex];
    const first = stage.querySelector(
      'input, button:not([disabled]), [tabindex="0"]'
    );
    if (first) first.focus();
  });
}
```

**ARIA announcements:**

```js
_announce(message) {
  // Uses a visually-hidden live region for screen readers
  let region = document.getElementById('qa-sr-announce');
  if (!region) {
    region = document.createElement('div');
    region.id = 'qa-sr-announce';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.className = 'sr-only'; // visually hidden
    document.body.appendChild(region);
  }
  region.textContent = message;
}
```

### Source Code Path

- Keyboard handler: `src/frontend/js/qa-panel.js` — `_bindKeyboard()`
- Focus management: `src/frontend/js/qa-panel.js` — `_onStageChange()`
- ARIA region: dynamically created `#qa-sr-announce`
- `:focus-visible` styles: `src/frontend/css/qa-panel.css`

### Edge Cases

- **Focus trap in modal:** Help overlay and confirmation dialogs trap focus (Tab cycles within modal, Escape closes).
- **Stage shortcuts during execution:** 1-3, 5 are blocked (only 4 is active stage). Keypress does nothing, no error.
- **Input focus vs shortcut conflict:** Shortcuts only fire when focus is NOT in an input/textarea/select.
- **Screen reader mode:** All dynamic content uses `aria-live` regions. Stage transitions announce "Now on stage N: Name".

### Interactions with Other Components

- **Sidebar keyboard:** Sidebar has its own keyboard shortcuts (Ctrl+1 through Ctrl+5 for views). QA stage shortcuts (1-5) only fire when QA view is active.
- **Command palette:** Ctrl+K opens command palette (existing). QA-specific commands registered: "QA: Analyze PR", "QA: Run Tests", "QA: Post Results".

### Revert/Undo Mechanism

- Escape key cascades: close editor → close modal → clear input → go back one stage.
- All keyboard actions are reversible through the same keyboard (toggle approve, etc.).

### Priority

**P1** — Required for accessibility compliance but not blocking initial render.

---

## S11: Responsive Layout

**ID:** `C06-S11`
**One-liner:** Three breakpoints adapt the QA panel for wide, medium, and narrow viewports within the panel system.

### Description

The QA panel adapts to the available width (which depends on sidebar expansion state and browser width). Three breakpoints handle layout changes. The execution stage's split-pane is the most complex responsive case — it stacks vertically on narrow viewports.

### Technical Mechanism

**Breakpoints (from approved mock):**

```css
/* Wide: > 1100px — default layout */

/* Medium: 900-1100px */
@media (max-width: 1100px) {
  .exec-sidebar { width: 200px; min-width: 200px; }
}

/* Narrow: 700-900px */
@media (max-width: 900px) {
  .exec-sidebar { width: 180px; min-width: 180px; }
  .res-summary { flex-wrap: wrap; gap: var(--s3); }
  .res-ring-wrap { margin-left: 0; }
}

/* Very narrow: < 700px */
@media (max-width: 700px) {
  .exec-wrap { flex-direction: column; }
  .exec-sidebar {
    width: 100%; min-width: 0;
    max-height: 120px;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .s1-wrap { margin-top: var(--s5); }
  .pipe-line { width: 32px; }
}
```

**4px grid enforcement:**

All spacing values use custom properties that are multiples of 4px:

```css
--s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px;
--s5: 20px; --s6: 24px; --s8: 32px;
```

### Source Code Path

- Responsive rules: `src/frontend/css/qa-panel.css` — `@media` queries
- Spacing tokens: inherited from design system (`docs/design/design-bible-*.html`)

### Edge Cases

- **Sidebar expanded (224px) on narrow viewport:** Available width shrinks. Pipeline steps may need horizontal scroll.
- **Pipeline steps overflow:** At <600px, pipeline labels truncate or hide. Dots remain.
- **Scenario editor on narrow:** Editor grid changes from 2-col to 1-col below 700px.

### Interactions with Other Components

- **Sidebar:** Sidebar expand/collapse changes available width. QA panel uses CSS `flex: 1` to fill remaining space.

### Revert/Undo Mechanism

Not applicable (layout is reactive to viewport, no user action to revert).

### Priority

**P2** — EDOG Studio is primarily a desktop tool. Narrow viewport is edge case.

---

## S12: Error States

**ID:** `C06-S12`
**One-liner:** Graceful degradation for connection loss, analysis failure, execution timeout, and backend unavailability.

### Description

Every stage has defined error states with user-facing messages, recovery actions, and fallback behaviors. Errors never leave the user stuck — there is always a "try again" or "do it manually" escape hatch.

### Technical Mechanism

**Error state catalog:**

| Error | Stage | UI Treatment | Recovery |
|-------|-------|-------------|----------|
| SignalR disconnect | Any | Banner: "Connection lost. Reconnecting..." + spinner | Auto-reconnect (built into SignalR). After 30s: "Reconnect failed. [Retry]" |
| PR not found | 1 | Inline error below input (red text) | User corrects input |
| Analysis track failure | 2 | Track shows red "ERROR" badge + error message in subtitle | "Continue with partial analysis?" or "Try Again" |
| All analysis failed | 2 | Full error card | "Try Again" or "Create Manual Scenarios" |
| Scenario generation empty | 3 | Empty state card | "Create Manual Scenario" button |
| Execution timeout | 4 | Timer badge turns red, verdict shows "TIMED OUT" | Auto-proceeds to next scenario |
| FLT crash | 4 | "Connection lost" banner | On reconnect: resume or show partial results |
| PR comment post failed | 5 | Toast error | "Copy to clipboard" fallback |
| Backend QA module missing | Any | Full-panel banner: "QA Testing requires EDOG backend v2.1+" | Disabled state |

**Error banner component:**

```html
<div class="qa-error-banner" role="alert">
  <span class="qa-error-icon">▲</span>
  <span class="qa-error-text">Connection lost. Reconnecting...</span>
  <button class="btn-ghost btn-sm qa-error-action">Retry</button>
</div>
```

### Source Code Path

- Error banner: `src/frontend/js/qa-panel.js` — `_showError()` / `_hideError()`
- SignalR reconnect: `src/frontend/js/signalr-manager.js:81-97` (reconnecting/reconnected handlers)
- Timeout handling: `ExecutionController._onScenarioTimeout()`

### Edge Cases

- **Multiple simultaneous errors:** Stack vertically. Dismiss with ✕ button.
- **Error during stage transition animation:** Queue the error display for after animation completes (250ms).
- **Persistent errors:** After 3 consecutive failures of same type, suggest "Check EDOG backend logs" with link.

### Interactions with Other Components

- **SignalR reconnect:** QA panel re-subscribes to `qa` topic on reconnect via `_resubscribeAll()`.
- **Toast system:** Shares the existing toast system (`src/frontend/js/toast.js`).

### Revert/Undo Mechanism

- Errors are dismissible. Underlying state is preserved (not corrupted by error display).
- "Try Again" re-invokes the failed operation with same parameters.

### Priority

**P1** — Critical for production robustness but not blocking initial demo.

---

## S13: Stage Transitions

**ID:** `C06-S13`
**One-liner:** Animated stage transitions with fade/slide effects and loading skeleton states.

### Description

Stage transitions use CSS animations for smooth visual feedback. Entering stages use `fadeIn` (250ms) with optional `slideUp` for content. The pipeline bar animates step completion (node turns green, connecting line fills). Loading skeletons (shimmer animations) appear during data-dependent rendering (PR card loading, scenario list hydrating).

### Technical Mechanism

**Stage visibility toggle:**

```css
.qa-stage {
  display: none;
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--s6);
}

.qa-stage.visible {
  display: block;
  animation: fadeIn 250ms var(--ease) 80ms both;
  opacity: 0;
}

/* Execution stage uses flex layout */
.qa-stage-exec.visible {
  display: flex;
  animation: fadeIn 250ms var(--ease) 80ms both;
  opacity: 0;
}
```

**Pipeline step animation:**

```css
.pipe-step.completed .pipe-node {
  background: var(--ok);
  border-color: var(--ok);
  color: #fff;
  /* Transition from default state */
  transition: all 300ms var(--ease);
}

.pipe-step.active .pipe-node {
  border-color: var(--accent);
  color: var(--accent);
  animation: pulseAccent 2s infinite;
}

.pipe-line.done {
  background: var(--ok);
  transition: background 400ms var(--ease);
}
```

**Loading skeleton shimmer:**

```css
.qa-skeleton {
  background: linear-gradient(
    90deg,
    var(--surface-3) 25%,
    var(--surface-2) 50%,
    var(--surface-3) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--r-m);
}
```

### Source Code Path

- Stage CSS: `src/frontend/css/qa-panel.css` — `.qa-stage`, `.qa-stage.visible`
- Pipeline CSS: `src/frontend/css/qa-panel.css` — `.pipe-step`, `.pipe-line`
- Animations: defined at file top, matching mock's keyframes
- Skeleton: `src/frontend/css/qa-panel.css` — `.qa-skeleton`

### Edge Cases

- **Rapid stage changes:** CSS animation interruption handled by `animation-fill-mode: both` — no flicker.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` disables all animations, uses instant transitions.
- **Stage re-entry:** Re-entering a previously visited stage re-triggers the entry animation.

### Interactions with Other Components

- Uses same animation keyframes as existing EDOG Studio design system (from mock).
- `--ease`, `--spring`, `--eo` timing functions from design tokens.

### Revert/Undo Mechanism

Not applicable (transitions are visual-only, no state change).

### Priority

**P1** — Important for perceived quality but not functional.

---

## S14: Virtual Scrolling

**ID:** `C06-S14`
**One-liner:** Virtual scroll for scenario lists exceeding 50 items, recycling DOM rows for O(1) render cost.

### Description

When the code understanding engine generates 50+ scenarios (possible for large PRs touching many code paths), the curation stage uses virtual scrolling to maintain 60fps performance. The implementation follows the same pattern as the existing `Renderer` class in `renderer.js` — a `RowPool` that recycles DOM elements, positioned absolutely within a sentinel-height container. Only visible rows + a 10-row buffer above/below are rendered.

### Technical Mechanism

```js
class QAVirtualScroll {
  constructor(containerEl, rowHeight = 64) {
    this._container = containerEl;
    this._rowHeight = rowHeight;     // scenario row height (px)
    this._pool = [];                 // recycled DOM elements
    this._poolSize = 30;             // visible + buffer
    this._items = [];                // scenario data array
    this._scrollTop = 0;
    this._rafId = null;
  }

  setItems(items) {
    this._items = items;
    // Set sentinel height for scroll track
    this._container.style.height = (items.length * this._rowHeight) + 'px';
    this._render();
  }

  _render() {
    const scrollTop = this._container.parentElement.scrollTop;
    const viewportHeight = this._container.parentElement.clientHeight;
    const startIdx = Math.max(0, Math.floor(scrollTop / this._rowHeight) - 5);
    const endIdx = Math.min(
      this._items.length,
      Math.ceil((scrollTop + viewportHeight) / this._rowHeight) + 5
    );

    // Release rows outside visible range
    // Acquire/update rows in visible range
    for (let i = startIdx; i < endIdx; i++) {
      const row = this._acquireRow();
      this._populateRow(row, this._items[i]);
      row.style.transform = `translateY(${i * this._rowHeight}px)`;
    }
  }

  // Trigger: threshold = 50 items
  static THRESHOLD = 50;
}
```

**Activation threshold:**

```js
// In CurationController.renderZones():
if (totalScenarios > QAVirtualScroll.THRESHOLD) {
  this._virtualScroll = new QAVirtualScroll(this._container);
  this._virtualScroll.setItems(flatScenarios);
} else {
  // Direct DOM rendering (simple path)
  this._renderDirect(zones, scenarios);
}
```

### Source Code Path

- Virtual scroll: `src/frontend/js/qa-panel.js` — `QAVirtualScroll` inner class
- Pattern reference: `src/frontend/js/renderer.js:9` (`RowPool` class)
- Container: `#qaCurationZones` with `overflow-y: auto`

### Edge Cases

- **Scenario height varies (editor open):** When inline editor is open, that row's height changes. Virtual scroll must track variable heights or use a fixed-height approach where editors open in a modal instead.
- **Zone headers in virtual list:** Zone headers are sticky elements interspersed with scenario rows. Implementation uses a flat list with type discriminator: `{ type: 'zone-header' | 'scenario', data: ... }`.
- **Approve/reject changes item count:** Rejected scenarios are visually collapsed (height → 0 with animation) then removed from the virtual list on next render cycle.
- **Scroll restoration:** When navigating back to curation, restore previous scroll position from `QAPanelState`.

### Interactions with Other Components

- **`RowPool` in `renderer.js:9`:** Same pattern, different implementation (scenario rows have different DOM structure than log rows). No code sharing — separate pool.
- **CurationController:** Delegates rendering to `QAVirtualScroll` when threshold is exceeded.

### Revert/Undo Mechanism

Not applicable (virtual scroll is a rendering optimization, not a user action).

### Priority

**P2** — Only needed for large PRs. Most PRs generate 5-30 scenarios.

---

## S15: Dark Theme

**ID:** `C06-S15`
**One-liner:** Full dark theme support using existing CSS custom properties with `[data-theme=dark]` selector.

### Description

The QA panel inherits the EDOG Studio dark theme system. All colors use CSS custom properties defined in `:root` (light) and `[data-theme=dark]` (dark). The panel adds no hardcoded colors. The diff panel in results uses a fixed dark background (`#1e1e2e`, Catppuccin Mocha) regardless of theme, as code diffs are always dark-on-dark.

### Technical Mechanism

**Token usage (all QA-specific styles):**

```css
/* All QA panel styles use tokens, never hardcoded values */
.qa-stage     { color: var(--text); background: var(--bg); }
.sc-row       { background: var(--surface); border: 1px solid var(--border-bright); }
.sc-row:hover { box-shadow: var(--sh-m); }
.sc-cat.happy { background: var(--ok-dim); color: var(--ok); }
.sc-cat.error { background: var(--fail-dim); color: var(--fail); }
.btn-primary  { background: var(--accent); color: #fff; }
```

**Dark-specific overrides (from mock):**

```css
[data-theme=dark] .sc-row:hover {
  box-shadow: var(--sh-m), 0 0 0 1px var(--border-bright);
}

[data-theme=dark] .zone-header:hover {
  filter: brightness(1.08);  /* instead of 0.97 in light */
}

[data-theme=dark] .gap-text code {
  background: rgba(255,255,255,0.08);  /* instead of rgba(0,0,0,0.05) */
}
```

**Diff panel (always dark):**

```css
.diff-panel {
  background: #1e1e2e;  /* Fixed dark — code diffs are always dark */
  color: #cdd6f4;
}
.diff-line.green { color: #a6e3a1; }
.diff-line.red   { color: #f38ba8; }
```

### Source Code Path

- Token definitions: `src/frontend/css/tokens.css` (or inline in HTML template `:root` block)
- Dark overrides: `src/frontend/css/qa-panel.css` — `[data-theme=dark]` selectors
- Theme toggle: existing mechanism in `src/frontend/js/main.js` or topbar

### Edge Cases

- **High contrast mode:** CSS custom properties allow system-level overrides. No `!important` used.
- **Print mode:** `@media print` hides sidebar, pipeline, toast. Stages render as block.
- **Theme toggle during execution:** Instant — all transitions use CSS custom properties.

### Interactions with Other Components

- **Theme toggle:** Existing `data-theme` attribute on `<html>`. QA panel is a passive consumer.
- **Design bible:** All tokens match `docs/design/design-bible-*.html` part 1 token system.

### Revert/Undo Mechanism

Not applicable (theme is a global setting, not QA-specific).

### Priority

**P1** — Dark theme is default for many developers. Must look correct from day one.

---

## CSS Architecture

### File Organization

All QA panel styles live in `src/frontend/css/qa-panel.css`, organized by stage:

```css
/* ========== QA PANEL: TOKENS & BASE ========== */
/* ========== QA PANEL: PIPELINE BAR ========== */
/* ========== QA PANEL: STAGE 1 — PR INPUT ========== */
/* ========== QA PANEL: STAGE 2 — ANALYZING ========== */
/* ========== QA PANEL: STAGE 3 — CURATION ========== */
/* ========== QA PANEL: STAGE 4 — EXECUTION ========== */
/* ========== QA PANEL: STAGE 5 — RESULTS ========== */
/* ========== QA PANEL: ERROR STATES ========== */
/* ========== QA PANEL: TRANSITIONS ========== */
/* ========== QA PANEL: DARK OVERRIDES ========== */
/* ========== QA PANEL: RESPONSIVE ========== */
/* ========== QA PANEL: PRINT ========== */
```

### Naming Convention

All QA-specific classes are prefixed or scoped to avoid collision with existing styles:

- Pipeline: `.pipe-*` (shared with mock, no conflict)
- Stages: `.s1-*`, `.s2-*`, `.s3-*` (stage-specific)
- Scenario: `.sc-*` (scenario cards)
- Editor: `.ed-*` (inline editor)
- Execution: `.exec-*`, `.exp-*`, `.ev-*`, `.eq-*`
- Results: `.res-*`, `.diff-*`, `.cov-*`
- QA-specific: `.qa-*` (new classes unique to QA panel)

### Custom Properties Used

All from the existing design token system (no new tokens needed):

| Token | Usage |
|-------|-------|
| `--bg`, `--surface`, `--surface-2`, `--surface-3` | Backgrounds |
| `--border`, `--border-bright` | Borders |
| `--text`, `--text-dim`, `--text-muted` | Typography |
| `--accent`, `--accent-dim`, `--accent-glow` | Interactive elements |
| `--ok`, `--ok-dim`, `--ok-glow` | Pass/success states |
| `--fail`, `--fail-dim`, `--fail-glow` | Fail/error states |
| `--warn`, `--warn-dim` | Warning states |
| `--blue`, `--purple`, `--teal` + dim variants | Category badges |
| `--font`, `--mono` | Font families |
| `--xs` through `--xxl` | Font sizes |
| `--s1` through `--s8` | Spacing (4px grid) |
| `--r-s` through `--r-f` | Border radii |
| `--sh-s` through `--sh-xl` | Shadows |
| `--ease`, `--spring`, `--eo` | Timing functions |
| `--tf`, `--tn` | Transition durations |

---

## JS Class Architecture

### Primary Class: `QATestingPanel`

```js
class QATestingPanel {
  /**
   * @param {HTMLElement} rootEl    — #qa-panel-root container
   * @param {SignalRManager} signalr — shared SignalR connection
   * @param {FabricApiClient} api   — shared API client
   */
  constructor(rootEl, signalr, api) {
    this._root = rootEl;
    this.signalr = signalr;
    this.api = api;
    this.state = new QAPanelState();

    // Sub-controllers (initialized in init())
    this.stageManager = null;
    this.prInput = null;
    this.analysis = null;
    this.curation = null;
    this.execution = null;
    this.results = null;

    // SignalR handler ref (for cleanup)
    this._qaHandler = null;
  }

  init() {
    // Render initial DOM skeleton
    this._renderShell();

    // Initialize sub-controllers
    this.stageManager = new StageManager(this._root);
    this.prInput = new PRInputController(
      document.getElementById('qaStage1'), this.signalr, this.api
    );
    this.analysis = new AnalysisController(
      document.getElementById('qaStage2'), this.signalr
    );
    this.curation = new CurationController(
      document.getElementById('qaStage3'), this.state
    );
    this.execution = new ExecutionController(
      document.getElementById('qaStage4'), this.signalr, this.state
    );
    this.results = new ResultsController(
      document.getElementById('qaStage5'), this.signalr, this.state
    );

    // Wire stage transitions
    this.stageManager.onStageChange = (idx) => this._onStageChange(idx);
    this.prInput.onAnalyze = (prNum) => this._startAnalysis(prNum);
    this.analysis.onComplete = (data) => this._onAnalysisComplete(data);
    this.curation.onRun = (scenarios) => this._startExecution(scenarios);
    this.execution.onComplete = (result) => this._onRunComplete(result);

    // Keyboard shortcuts
    this._bindKeyboard();

    // Attempt state restoration (crash recovery)
    if (this.state.restore()) {
      this._restoreUI();
    }
  }

  activate() {
    this._root.style.display = 'flex';
    this._qaHandler = (event) => this._handleQAEvent(event);
    this.signalr.on('qa', this._qaHandler);
    this.signalr.subscribeTopic('qa');
  }

  deactivate() {
    this._root.style.display = 'none';
    if (this._qaHandler) {
      this.signalr.off('qa', this._qaHandler);
      this._qaHandler = null;
    }
    if (!this.state.isExecuting) {
      this.signalr.unsubscribeTopic('qa');
    }
  }

  destroy() {
    this.deactivate();
    document.removeEventListener('keydown', this._keyHandler);
    this.state.save();
  }
}
```

### Performance Budget

| Operation | Budget | Mechanism |
|-----------|--------|-----------|
| Stage transition | < 16ms JS + 250ms CSS animation | `requestAnimationFrame` for DOM mutation |
| Scenario row render | < 1ms per row | Pre-built DOM template, property assignment |
| Expectation sweep animation | < 16ms trigger + 500ms CSS | CSS-only animation, JS just adds class |
| Event feed append (100 events/s) | < 16ms per batch | Batch DOM appends in RAF, max 10 rows/frame |
| Virtual scroll render | < 8ms for full viewport | Row recycling, `translateY` positioning |
| State persistence | < 5ms | JSON.stringify of lightweight snapshot |

### Accessibility Summary

| Requirement | Implementation |
|-------------|---------------|
| Focus visible | `button:focus-visible` → `outline: 2px solid var(--accent)` |
| Screen reader | `aria-live="polite"` on dynamic regions, `role` attributes on all interactive elements |
| Keyboard nav | Full tab order, stage shortcuts, Escape cascading |
| Reduced motion | `@media (prefers-reduced-motion: reduce)` disables all animations |
| Color contrast | All text/background combos meet WCAG AA (verified against design tokens) |
| Semantic HTML | `role="list"`, `role="listitem"`, `role="tab"`, `role="alert"`, `role="progressbar"` |

---

*End of C06 Frontend Panel Component Deep Spec.*
*Author: Pixel. All code references verified against `src/frontend/js/` source tree.*
