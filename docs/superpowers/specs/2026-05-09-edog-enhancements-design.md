# EDOG Studio — Six Enhancements Design Spec

**Date**: 2026-05-09
**Author**: Sana (architecture) + Pixel (frontend) — EDOG Studio hivemind
**Status**: Draft
**Mockup**: `docs/design/mocks/deploy-strip-footer-mockup.html`

---

## Overview

Six enhancements to EDOG Studio's developer experience:

| ID | Feature | Scope |
|----|---------|-------|
| F1 | Deploy Context Strip | Frontend + backend API |
| F2 | Last Deployed Commit SHA | Backend API + F1 integration |
| F3 | Footer Status Bar + Feedback | Frontend + backend API |
| F4 | Unified Toast Notification System | Frontend (replaces 4+ implementations) |
| F5 | Coverage Tracker & Skill Scheduler | Frontend + backend + embedded SkillRunner |
| F6 | Distribution: Skill-Based Installer | Design only (FMLV-DevSkills repo) |

---

## F1+F2: Deploy Context Strip

### Purpose

When FLT is deployed and running, show persistent infrastructure context (tenant, capacity, workspace, lakehouse, commit) in a strip below the topbar. Replaces the ephemeral hover-only deploy tooltip with always-visible context.

### Design

A notification strip in `.notification-zone`, inserted before `#file-change-bar`. Uses a breadcrumb hierarchy pattern — no labels, values speak for themselves.

**Layout:**
```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [● Connected]   contoso › F64 › FLT-Dev › lh-main   │  abc123f Fix DAG retry   │
└──────────────────────────────────────────────────────────────────────────────────┘
  pill badge        breadcrumb path                       commit chip      timestamp
```

**Visual treatment:**
- 38px height, `var(--surface)` background
- Left edge: 3px green border with `box-shadow` glow (green, 12px spread)
- Gradient wash: `linear-gradient(90deg, rgba(24,160,88,0.04), transparent 40%)` via `::after`
- "Connected" pill: rounded badge with green tint background + 1px green border
- Green dot: 7px, animated `pulseGlow` with outer glow ring
- Breadcrumb: `contoso › F64 › FLT-Dev › lh-main` — workspace + lakehouse are bold, tenant + capacity are dimmed
- Commit chip: SHA in accent purple mono, commit message truncated, hover lifts with purple border + shadow
- Enter animation: `stripSlideDown` 360ms spring curve

**Behavior:**
- Hidden by default (`display: none`)
- Shown when `config.studioPhase === 'running'` (data from existing `/api/flt/config` poll)
- Hidden on disconnect/crash/stop
- Not dismissable — represents active deploy context
- Commit SHA tooltip on hover: full SHA, full message, author email

### HTML

```html
<div class="notification-zone">
  <div id="deploy-context-strip" class="deploy-strip"></div>  <!-- NEW -->
  <div id="file-change-bar" class="file-change-bar"></div>
  <!-- existing bars -->
</div>
```

### Data Source

Existing `/api/flt/config` and `/api/studio/status` endpoints already return tenant, capacity, workspace, lakehouse. Commit SHA requires a new field:

**Backend change**: During deploy, capture `git rev-parse HEAD` and `git log -1 --format=%s` from the FLT repo. Add to `/api/studio/status` response:

```json
{
  "deployTarget": {
    "lakehouseName": "lh-main",
    "workspaceId": "...",
    "capacityId": "F64",
    "tenantName": "contoso",
    "commitSha": "abc123f7e4b9d2c1a0f3e5d7b9c1a3f5e7d9b2c4",
    "commitMessage": "fix: resolve DAG retry timeout on F64 capacities",
    "commitAuthor": "hemant.gupta@contoso.com"
  }
}
```

### New Files

| File | Purpose |
|------|---------|
| `src/frontend/js/deploy-strip.js` | `DeployContextStrip` class |
| `src/frontend/css/deploy-strip.css` | Strip styles (from approved mockup) |

### Integration

- `topbar.js` calls `window.edogDeployStrip.update(config)` after each config poll
- `DeployContextStrip` renders into `#deploy-context-strip`
- Commit tooltip managed by the strip class (positioned via `getBoundingClientRect`)

---

## F3: Footer Status Bar + Feedback

### Purpose

A VS Code-style status bar pinned to the bottom of the viewport. Always visible. Provides phase indicator, coverage badge (F5 integration), feedback link, and version info. **Replaces the sidebar footer** (phase dot + token ring at lines 93-103 of index.html).

### Design

**Layout (3 zones):**
```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ● Connected                        Coverage: 72% L · 65% B · 80% M    Feedback ◆  v0.9.2 │
└──────────────────────────────────────────────────────────────────────────────────┘
  left: phase                         center: coverage badge (F5)        right: feedback + version
```

- Height: 24px, fixed to bottom of viewport
- Background: `var(--surface)`, `border-top: 1px solid var(--border)`
- Font: 11px `var(--font-body)`, color `var(--text-dim)`
- z-index: 100 (same level as topbar)

**Left zone:**
- Phase dot (colored) + label: "Disconnected" / "Connected" / "Deploying"
- Dot colors: green (connected), amber (deploying), gray (disconnected)

**Center zone:**
- Coverage badge (F5 integration point)
- Shows `--` when no coverage data
- Clickable → opens coverage drawer

**Right zone:**
- "Feedback ◆" button — subtle hover effect
- EDOG version label from `window.EDOG_VERSION` or `/api/edog/health`

### Feedback Mechanism

Click "Feedback ◆" → backend `POST /api/studio/feedback`:

```json
{
  "title": "User-entered title",
  "body": "User-entered description",
  "labels": ["feedback"]
}
```

Backend executes: `gh issue create --repo guptahemant65/edog-studio --title "..." --body "..."` via subprocess.

**Fallback**: If `gh` CLI not available, `window.open('https://github.com/guptahemant65/edog-studio/issues/new?template=feedback.md')`.

**Success**: Toast (F4) → "Feedback submitted — issue #42 created"

### Sidebar Footer Removal

The current sidebar footer (`.sidebar-footer` containing `.phase-row` and `.sidebar-token-health`) is removed. The footer bar assumes its responsibilities:
- Phase indicator moves to footer bar left zone
- Token health info moves to the topbar (already partially there as token countdown)

### HTML

```html
<!-- After .cockpit-body closing div -->
<footer id="status-bar" class="status-bar">
  <div class="sb-left">
    <span class="sb-phase-dot" id="sb-phase-dot"></span>
    <span class="sb-phase-label" id="sb-phase-label">Disconnected</span>
  </div>
  <div class="sb-center">
    <button class="sb-coverage" id="sb-coverage" title="Click for coverage details">--</button>
  </div>
  <div class="sb-right">
    <button class="sb-feedback" id="sb-feedback" title="Send feedback">Feedback ◆</button>
    <span class="sb-version" id="sb-version"></span>
  </div>
</footer>
```

### New Files

| File | Purpose |
|------|---------|
| `src/frontend/js/status-bar.js` | `StatusBar` class |
| `src/frontend/css/status-bar.css` | Footer bar styles |

### Integration

- `StatusBar` listens for phase changes from `topbar.js` config polling
- Coverage badge updated by `CoverageTracker` (F5)
- Feedback button opens a small modal → submits via API
- Version fetched once from `/api/edog/health` on init

---

## F4: Unified Toast Notification System

### Purpose

Replace 4+ fragmented toast implementations with a single global system.

### Existing Implementations (to be replaced)

| Location | Method | Notes |
|----------|--------|-------|
| `main.js:1249-1295` | `export-toast` class | Creates div, appends to body |
| `mock-renderer.js:1596` | `_showToast(msg)` | Instance method |
| `notebook-view.js:1161` | `_showToast(message, type)` | Supports 4 variants |
| `tab-telemetry.js:1174` | `_showToast(msg, icon)` | Yet another variant |
| `infra-wizard.js:226` | `window.edogToast` call | References non-existent global |
| `tab-spark.js:1137` | `window.edogToast` call | References non-existent global |

### API

```js
// Simple (covers 90% of use cases):
window.edogToast(message, variant);

// Full options:
window.edogToast(message, variant, options);

// Programmatic control:
window.edogToastManager.dismiss(id);
window.edogToastManager.clear();
```

**Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `message` | `string` | required | Toast content |
| `variant` | `string` | `'info'` | `'info'` / `'success'` / `'warning'` / `'error'` |
| `options.duration` | `number` | `4000` | Auto-dismiss ms. `0` = sticky. |
| `options.action` | `object` | `null` | `{ label: string, onClick: function }` |
| `options.id` | `string` | auto | Dedup key — same ID resets timer |

### Variants

| Variant | Left accent color | Icon | Use case |
|---------|-------------------|------|----------|
| `info` | `var(--accent)` | none | Neutral updates |
| `success` | `var(--status-succeeded)` | none | Completions |
| `warning` | `var(--status-cancelled)` | none | Expiring tokens, stale data |
| `error` | `var(--status-failed)` | none | Failures |

### Visual Design

```
┌──────────────────────────────────────┐
│▌ Deploy succeeded               ✕   │
│▌                          [Undo]    │
└──────────────────────────────────────┘
 3px left accent       action button
```

- Position: fixed bottom-right, 20px from edges
- Width: 320px
- Background: `var(--surface)`, `border: 1px solid var(--border)`, `border-radius: 8px`
- Shadow: `var(--shadow-md)` (compound: ambient + key)
- Font: 12px `var(--font-body)`, color `var(--text)`
- 3px left border in variant color
- Dismiss: ✕ button, top-right

### Behavior

- Max 3 visible, excess queued FIFO
- Stack upward (newest at bottom)
- Enter: `slideInRight` (translateX(100%) → 0, 300ms ease-out)
- Exit: `slideOutRight` (→ translateX(100%), 200ms ease-in) on dismiss or timeout
- Dedup: Same `id` won't stack — resets timer, updates message if changed
- Global: Toasts persist across view switches (fixed to viewport, not content area)

### New Files

| File | Purpose |
|------|---------|
| `src/frontend/js/toast.js` | `ToastManager` class + `window.edogToast` |
| `src/frontend/css/toast.css` | Toast styles + animations |

### Migration

All existing `_showToast()` / `showToast()` calls replaced with `window.edogToast()`. Old implementations deleted. Files affected:
- `main.js` — remove `export-toast` class
- `mock-renderer.js` — replace `_showToast` method
- `notebook-view.js` — replace `_showToast` method
- `tab-telemetry.js` — replace `_showToast` method
- `infra-wizard.js` — already calls `window.edogToast` (now it works)
- `tab-spark.js` — already calls `window.edogToast` (now it works)

---

## F5: Coverage Tracker & Skill Scheduler

### Purpose

Show test coverage metrics (line, branch, method) for the FLT codebase in the footer bar. Provide a way to invoke a Copilot CLI skill to generate tests for low-coverage files. Track coverage lift after the skill runs.

### Architecture

No external dependencies (no Daemon Foundry). EDOG embeds a lightweight SkillRunner that spawns `flt-playground` as a subprocess.

```
dotnet test --collect:"XPlat Code Coverage"
           │
           ▼
  TestResults/{guid}/coverage.cobertura.xml
           │
           ▼
  EDOG Backend: POST /api/studio/coverage/scan
  → glob TestResults/*/coverage.cobertura.xml
  → take newest by mtime
  → parse Cobertura XML → extract metrics
           │
           ▼
  Frontend: GET /api/studio/coverage
  → Footer badge: "72% L · 65% B · 80% M"
  → Click → Coverage Drawer
           │
           ▼
  "Improve Coverage" button
  → POST /api/studio/coverage/improve
  → SkillRunner spawns flt-playground
  → Skill generates tests for lowest-coverage files
           │
           ▼
  Poll: GET /api/studio/coverage/runs/{id}
  → Toast: "Skill running..." → "Complete — re-run tests"
           │
           ▼
  Engineer re-runs tests → new coverage
  → Delta: "72% → 78% (+6%)"
```

### Embedded SkillRunner (`src/edog/skill_runner.py`)

A lightweight Python class (~60 lines) that spawns Copilot CLI as a subprocess:

```python
class SkillRunner:
    """Spawns flt-playground subprocess to run Copilot CLI skills."""

    def start_run(self, prompt: str, cwd: str, model: str = "claude-sonnet-4-5") -> RunInfo:
        """Spawn flt-playground with prompt, return run handle."""
        # subprocess.Popen(["flt-playground", "-p", prompt,
        #   "--model", model, "--output-format", "json",
        #   "--allow-all-tools", "--add-dir", cwd])

    def get_run(self, run_id: str) -> RunInfo:
        """Return run status: queued | running | success | error."""

    def cancel_run(self, run_id: str) -> bool:
        """Kill the subprocess."""
```

**RunInfo fields**: `run_id`, `status`, `pid`, `started_at`, `finished_at`, `exit_code`, `log_path`

**In-memory tracking**: Simple dict `{run_id: RunInfo}`. No persistence needed — runs are short-lived.

**Spawn command**:
```
flt-playground -p "<prompt>" --model claude-sonnet-4-5 --output-format json --no-auto-update --allow-all-tools --add-dir <flt_repo_path>
```

### Coverage Skill Prompt (constructed by EDOG)

```
You are a test coverage improvement agent.

Read the coverage report at: {coverage_xml_path}

The current coverage metrics are:
- Line: {line_pct}%
- Branch: {branch_pct}%
- Method: {method_pct}%

Focus on the {N} files with the lowest coverage (listed below):
{lowest_coverage_files}

Use the fabriclivetable-test-coverage skill to generate unit tests
that improve line, branch, and method coverage for these files.

Write the generated tests to the appropriate test project directory.
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/studio/coverage` | Return parsed coverage metrics (line/branch/method %) + file breakdown |
| `POST` | `/api/studio/coverage/scan` | Re-scan FLT repo for latest Cobertura XML, parse, cache |
| `POST` | `/api/studio/coverage/improve` | Trigger skill via SkillRunner. Body: `{ "fileCount": 5 }` |
| `GET` | `/api/studio/coverage/runs/{id}` | Poll skill run status |

### Coverage Drawer (right slide-in panel)

Triggered by clicking the footer coverage badge. Similar to Token Inspector drawer pattern.

**Contents:**
- Summary header: 3 large metric badges (Line %, Branch %, Method %)
- Delta row (if previous data exists): "+6% line, +3% branch, +2% method"
- File-level breakdown table, sorted by lowest coverage:
  - Columns: File path, Line %, Branch %, Method %
  - Color-coded: red (<50%), amber (50-80%), green (>80%)
- Action buttons:
  - "Rescan" → `POST /api/studio/coverage/scan`
  - "Improve Coverage" → `POST /api/studio/coverage/improve` → triggers skill
- Active run indicator: if skill is running, show spinner + "Generating tests..."

### Configuration

```yaml
# .edog.yaml or config section
coverage:
  flt_repo_path: "C:/Users/.../workload-fabriclivetable"
  test_results_glob: "TestResults/*/coverage.cobertura.xml"
  skill_model: "claude-sonnet-4-5"
  improve_file_count: 5  # how many lowest-coverage files to target
```

### New Files

| File | Purpose |
|------|---------|
| `src/edog/skill_runner.py` | `SkillRunner` class — subprocess management |
| `src/edog/coverage_parser.py` | Cobertura XML parser → metrics extraction |
| `src/frontend/js/coverage-tracker.js` | `CoverageTracker` class + drawer UI |
| `src/frontend/css/coverage-tracker.css` | Badge, drawer, table styles |
| Backend routes in `edog.py` | 4 new `/api/studio/coverage/*` endpoints |

---

## F6: Distribution — Skill-Based Installer (Design Only)

> **Note**: This feature is design/plan only. Implementation deferred.

### Purpose

Replace the current `install.ps1` one-liner with a Copilot CLI skill that handles install, update, and launch of EDOG Studio. Target: FLT team (~15 engineers, all Windows, all have `flt-playground` installed).

### Skill Location

FMLV-DevSkills repo at `plugins/livetable/skills/edog-studio-setup/instructions.md`

### Skill Behavior

The skill responds to intents: "install edog studio", "update edog", "launch edog", "edog status".

**Idempotent flow:**

```
1. Check: does ~/.edog/version.json exist?
   ├─ No → INSTALL
   │   a. Query GitHub Releases API for latest edog-studio release
   │   b. Download release archive (.zip)
   │   c. Extract to ~/.edog/
   │   d. Create Python venv: python -m venv ~/.edog/.venv
   │   e. Install deps: ~/.edog/.venv/pip install -e ~/.edog
   │   f. Add ~/.edog to PATH (user-level, if not present)
   │   g. Write version.json: { "version": "0.9.3", "installed_at": "..." }
   │   h. Launch: edog serve (background process)
   │   i. Report: "EDOG Studio v0.9.3 installed and running at http://localhost:5555"
   │
   └─ Yes → CHECK VERSION
       a. Read local version from version.json
       b. Query GitHub Releases API for latest
       c. Compare semver
       ├─ Stale → UPDATE (download, extract, pip install, rewrite version.json, relaunch)
       └─ Current → CHECK IF RUNNING
           ├─ Running → "EDOG Studio v0.9.3 already running at http://localhost:5555"
           └─ Not running → Launch: edog serve → "Launched at http://localhost:5555"
```

### Auto-Update on Launch (EDOG-side)

EDOG's `edog serve` command checks for updates on startup:

1. Non-blocking call to GitHub Releases API (5s timeout)
2. If new version available → toast in UI: "Update available: v0.9.3 → v0.9.4 [Update now]"
3. Click "Update now" → `POST /api/studio/self-update` → backend downloads new release, restarts process
4. If API unreachable → silent, no toast

### New Files (in EDOG Studio repo)

| File | Purpose |
|------|---------|
| `src/edog/self_update.py` | Update check + apply logic |
| Backend endpoint in `edog.py` | `POST /api/studio/self-update` |

### New Files (in FMLV-DevSkills repo — separate PR)

| File | Purpose |
|------|---------|
| `plugins/livetable/skills/edog-studio-setup/instructions.md` | Skill prompt |

---

## Cross-Cutting Concerns

### Build Impact

All new JS/CSS files must be included in `scripts/build-html.py` inlining (ADR-003: single HTML file).

New files to inline:
- `deploy-strip.js` + `deploy-strip.css`
- `status-bar.js` + `status-bar.css`
- `toast.js` + `toast.css`
- `coverage-tracker.js` + `coverage-tracker.css`

### Initialization Order

```
1. ToastManager (F4)     — first, so other modules can toast
2. StatusBar (F3)        — creates footer bar
3. DeployContextStrip (F1) — creates strip (hidden)
4. CoverageTracker (F5)  — registers with StatusBar
5. TopBar (existing)     — config poll feeds deploy strip + status bar
```

### Sidebar Footer Removal

Remove `.sidebar-footer` from index.html (lines 93-103). The footer status bar (F3) replaces its responsibilities:
- Phase indicator → footer bar left zone
- Token health → stays in topbar (already there as countdown)

### Error Handling

- Coverage scan fails (no XML found) → toast warning, badge shows "--"
- Skill run fails (non-zero exit) → toast error with exit code
- Feedback submission fails (no `gh` CLI) → fallback to browser open
- Config poll fails → deploy strip stays hidden, footer shows "Disconnected"

### Testing

- F4 (Toast): Unit tests for dedup, queue, auto-dismiss timing
- F5 (Coverage): Unit tests for Cobertura XML parser, SkillRunner spawn/track
- F1-F3: Manual visual verification against approved mockup
