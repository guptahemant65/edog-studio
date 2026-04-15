# P2 — Frontend Architecture: F16 New Infrastructure Wizard

> **Author:** Sana (Principal Architect)
> **Feature:** F16 — New Infrastructure Wizard
> **Phase:** P2 (Architecture)
> **Status:** COMPLETE
> **Date:** 2025-07-20
> **Depends On:** P0 (Foundation Research — COMPLETE), P1 (Component Deep Specs — COMPLETE)
> **Consumers:** Pixel (Implementation), Vex (Backend Integration), Sentinel (Test Plan)
> **Document Size:** ~139KB / 3,283 lines (comprehensive — intended as the single implementation reference)

---

## Document Map

| Section | Title | Purpose |
|---------|-------|---------|
| §1 | [System Overview](#1-system-overview) | Component hierarchy, dependency graph, file layout, shell integration |
| §2 | [Wizard State Management](#2-wizard-state-management) | Central state object, ownership matrix, data flow, validation, dirty tracking |
| §3 | [Component Communication Architecture](#3-component-communication-architecture) | Event system, complete event catalog (48 events), lifecycle patterns |
| §4 | [DAG Data Model & Operations](#4-dag-data-model--operations) | Canonical graph representation, CRUD, cycle detection, topological sort, serialization |
| §5 | [Canvas Rendering Architecture](#5-canvas-rendering-architecture) | SVG layers, coordinate transforms, zoom/pan, hit testing, rendering pipeline |
| §6 | [Code Generation Engine](#6-code-generation-engine) | Topological sort → cell ordering, template registry, assembly pipeline |
| §7 | [Memory Management & Lifecycle](#7-memory-management--lifecycle) | Creation/destruction, cleanup, memory budgets, GC strategy |
| §8 | [Error Architecture](#8-error-architecture) | Classification, propagation, boundaries, recovery patterns |
| §9 | [Performance Budget](#9-performance-budget) | Target metrics, component budgets, critical path, lazy loading |
| §10 | [Testing Architecture](#10-testing-architecture) | Unit strategy, integration scenarios, canvas testing, mock factories |

---

## Design Principles (Non-Negotiable)

These principles govern every architectural decision in this document. They are derived from ADR-002 (Vanilla JS), ADR-003 (Single HTML), the EDOG Design Bible, and CEO directives.

1. **Vanilla ES6 classes** — No React, no Vue, no framework. Every component is an ES6 class with explicit lifecycle methods. (ADR-002)
2. **Single HTML output** — All JS/CSS inlined via `python scripts/build-html.py`. No external bundles, no dynamic imports at runtime. (ADR-003)
3. **Callback-based communication** — Components communicate via typed callbacks and a lightweight event emitter. No global Redux/MobX store.
4. **SVG-native canvas** — Pure SVG with `<foreignObject>` for rich node content. No Canvas 2D API, no JointJS (MVP decision per C04 spec). No React Flow.
5. **Command pattern for undo** — Delta-based reversible commands, not full state snapshots.
6. **On-demand code generation** — Code preview regenerates on user action (Refresh click), never automatically.
7. **Client-orchestrated execution** — The browser is the orchestrator for the 6-step pipeline. No SSE, no WebSocket for execution. Sequential `fetch()` calls.
8. **Design Bible supremacy** — `docs/design/design-bible-*.html` is the visual authority. OKLCH color tokens, 4px grid spacing, Inter/Cascadia Code fonts.

---

## 1. System Overview

### 1.1 Component Hierarchy Tree

The wizard is a **tree of 14 components** rooted at `InfraWizardDialog`. Parent components own child lifecycle (creation, destruction, event wiring). Children never reference siblings directly — all cross-component communication flows through the parent or the event bus.

```
InfraWizardDialog (C01) ──────────────── MODAL SHELL
│   Owns: overlay, dialog chrome, stepper, footer, page container,
│         minimize/restore, resize/drag, focus trap, state object
│
├── [Internal] StepperBar
│   ├── StepCircle[0..4] ─────────────── 5 numbered circles
│   └── StepConnector[0..3] ──────────── 4 progress line segments
│
├── [Internal] FooterBar
│   ├── BackButton ────────────────────── Ghost style, hidden on page 0
│   └── NextButton ────────────────────── Primary/"Lock In & Create" on page 3
│
├── InfraSetupPage (C02) ─────────────── PAGE 0: workspace/capacity/lakehouse/notebook
│   └── [Internal] CapacityDropdown ──── Async-loaded capacity list
│
├── ThemeSchemaPage (C03) ────────────── PAGE 1: theme card grid + schema toggles
│   ├── [Internal] ThemeCardGrid ─────── 6 radio cards (3×2)
│   └── [Internal] SchemaToggleGroup ─── dbo (locked) + bronze/silver/gold toggles
│
├── DagCanvasPage ────────────────────── PAGE 2: composite host (not a separate C-number)
│   ├── NodePalette (C05) ────────────── Left sidebar: 3 draggable node type cards
│   │   └── [Internal] NodeCounter ──── "N / 100 nodes" display
│   │
│   ├── DagCanvas (C04) ─────────────── SVG canvas: zoom/pan, grid, node/connection layers
│   │   ├── DagNode[] (C06) ─────────── Individual node SVG groups (0..100 instances)
│   │   │   ├── [Internal] NodeBody ─── foreignObject HTML: icon, name, type badge, schema badge
│   │   │   ├── [Internal] InputPort ── Top-center 10px circle (MLV nodes only)
│   │   │   ├── [Internal] OutputPort ─ Bottom-center 10px circle
│   │   │   └── [Internal] NodePopover  Click-to-edit: name, type dropdown, schema dropdown, delete
│   │   │
│   │   └── ConnectionManager (C07) ── SVG connection paths (Bezier curves + arrowheads)
│   │       ├── [Internal] ConnectionPath[] ── One <path> per connection
│   │       └── [Internal] PreviewPath ─────── Temp path during drag-to-connect
│   │
│   ├── CodePreviewPanel (C08) ──────── Right sidebar: generated code preview
│   │   ├── [Internal] CodeBlock ────── Syntax-highlighted code with line numbers
│   │   └── [Internal] ResizeHandle ─── Drag to resize panel width
│   │
│   ├── AutoLayoutEngine (C13) ──────── Stateless computation: Dagre layout + topological sort
│   │
│   └── UndoRedoManager (C14) ────────── Command stack: undo/redo for all canvas mutations
│       └── [Internal] CommandStack ──── Dual stack (undo[50] + redo[])
│
├── ReviewSummary (C09) ─────────────── PAGE 3: read-only summary + mini-DAG + template save
│   ├── [Internal] InfraSummaryCard ─── Workspace/capacity/lakehouse/notebook summary
│   ├── [Internal] ThemeSummaryCard ─── Theme + schemas summary
│   ├── [Internal] DagSummaryCard ───── Node counts by type, connection count
│   ├── [Internal] MiniDagRenderer ──── Simplified read-only SVG DAG
│   └── [Internal] ConfirmationBanner ─ "You're about to create..." text
│
├── ExecutionPipeline (C10) ─────────── PAGE 4: GitHub Actions-style execution monitor
│   ├── [Internal] PipelineStep[0..5] ─ 6 step rows (create workspace → run notebook)
│   │   ├── StepStatusIcon ────────────── Spinner/checkmark/error icon
│   │   ├── StepInfo ──────────────────── Name + elapsed timer
│   │   ├── StepExpandToggle ──────────── Chevron for log expansion
│   │   └── StepDetail ────────────────── Collapsible API response log
│   ├── [Internal] PipelineSummary ────── Post-completion footer ("Done! Click to navigate")
│   └── [Internal] ErrorPanel ─────────── Failure overlay: error message + retry + rollback
│
├── FloatingBadge (C11) ─────────────── OVERLAY: minimized execution progress pill
│   ├── [Internal] StatusDot ──────────── 8px pulsing circle
│   ├── [Internal] ProgressText ───────── "Step 3/6 — Creating Lakehouse"
│   └── [Internal] MicroProgressBar ──── 32px inline progress bar
│
└── TemplateManager (C12) ───────────── SERVICE: save/load/delete template CRUD
    ├── [Internal] SaveDialog ─────────── Template naming modal
    ├── [Internal] LoadDialog ─────────── Template list with load/delete actions
    └── [Internal] DeleteConfirmDialog ── Confirmation before delete
```

### 1.2 Module Dependency Graph

Dependencies flow **downward and inward**. No circular dependencies. The graph below shows runtime dependencies (what each component needs to function), not event subscriptions.

```
                    ┌─────────────────────────────┐
                    │     FabricApiClient          │ ◄── Existing module (api-client.js)
                    │  (workspace, lakehouse,      │     Shared singleton from main.js
                    │   notebook, capacity APIs)   │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │   InfraWizardDialog (C01)    │ ◄── Root. Owns WizardState.
                    │   Creates all child pages.   │     Receives apiClient in constructor.
                    └──┬───┬───┬───┬───┬───┬───┬──┘
                       │   │   │   │   │   │   │
          ┌────────────┘   │   │   │   │   │   └──────────────────┐
          │                │   │   │   │   │                      │
    ┌─────▼────┐   ┌──────▼───▼───▼───▼───▼──────┐         ┌─────▼──────┐
    │ C02      │   │   DagCanvasPage (composite)   │         │ C09        │
    │ InfraSet │   │                               │         │ ReviewSum  │
    │ upPage   │   │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ │         │ mary       │
    └──────────┘   │  │C04 │ │C05 │ │C08 │ │C13 │ │         └────────────┘
                   │  │Dag │ │Node│ │Code│ │Auto │ │
    ┌──────────┐   │  │Canv│ │Pal │ │Prev│ │Lay  │ │    ┌────────────┐
    │ C03      │   │  └─┬──┘ └────┘ └────┘ └────┘ │    │ C10        │
    │ ThemeSch │   │    │                          │    │ Execution  │
    │ emaPage  │   │  ┌─▼──┐ ┌────┐               │    │ Pipeline   │
    └──────────┘   │  │C06 │ │C07 │               │    └─────┬──────┘
                   │  │Dag │ │Conn│               │          │
                   │  │Node│ │Mgr │               │    ┌─────▼──────┐
                   │  └────┘ └────┘               │    │ C11        │
                   │                    ┌────┐    │    │ Floating   │
                   │                    │C14 │    │    │ Badge      │
                   │                    │Undo│    │    └────────────┘
                   │                    │Redo│    │
                   │                    └────┘    │    ┌────────────┐
                   └──────────────────────────────┘    │ C12        │
                                                       │ Template   │
                                                       │ Manager    │
                                                       └────────────┘
```

**Dependency matrix** (rows depend on columns):

| Component | C01 | C02 | C03 | C04 | C05 | C06 | C07 | C08 | C09 | C10 | C11 | C12 | C13 | C14 | ApiClient |
|-----------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----------|
| **C01** InfraWizardDialog | — | ● | ● | ● | ● | | | ● | ● | ● | ● | ● | | | ● |
| **C02** InfraSetupPage | | — | | | | | | | | | | | | | ● |
| **C03** ThemeSchemaPage | | | — | | | | | | | | | | | | |
| **C04** DagCanvas | | | | — | | ● | ● | | | | | | ● | ● | |
| **C05** NodePalette | | | | ● | — | | | | | | | | | | |
| **C06** DagNode | | | | | | — | | | | | | | | | |
| **C07** ConnectionManager | | | | | | ● | — | | | | | | | | |
| **C08** CodePreviewPanel | | | | ● | | | ● | — | | | | | ● | | |
| **C09** ReviewSummary | | | | | | | | | — | | | ● | ● | | |
| **C10** ExecutionPipeline | | | | | | | | | | — | ● | | | | ● |
| **C11** FloatingBadge | | | | | | | | | | | — | | | | |
| **C12** TemplateManager | | | | | | | | | | | | — | | | ● |
| **C13** AutoLayoutEngine | | | | | | | | | | | | | — | | |
| **C14** UndoRedoManager | | | | | | | | | | | | | | — | |

**Legend:** ● = runtime dependency (constructor injection or method call)

### 1.3 File Structure Plan

Every new file lives under `src/frontend/`. The build system (`scripts/build-html.py`) inlines all JS and CSS into a single HTML output.

```
src/frontend/
├── js/
│   ├── infra-wizard/                          ◄── NEW DIRECTORY (wizard module)
│   │   ├── infra-wizard-dialog.js             ◄── C01: Modal shell, stepper, footer, page nav
│   │   ├── infra-setup-page.js                ◄── C02: Workspace/capacity/lakehouse/notebook form
│   │   ├── theme-schema-page.js               ◄── C03: Theme card grid + schema toggles
│   │   ├── dag-canvas.js                      ◄── C04: SVG canvas, zoom/pan, grid, node container
│   │   ├── node-palette.js                    ◄── C05: Left sidebar, drag source, node counter
│   │   ├── dag-node.js                        ◄── C06: Individual node SVG, ports, popover
│   │   ├── connection-manager.js              ◄── C07: Connection paths, drag-to-connect, cycle detection
│   │   ├── code-preview-panel.js              ◄── C08: Right sidebar, code gen, syntax highlight
│   │   ├── review-summary.js                  ◄── C09: Summary cards, mini-DAG, confirmation
│   │   ├── execution-pipeline.js              ◄── C10: 6-step pipeline, progress, retry, rollback
│   │   ├── floating-badge.js                  ◄── C11: Minimized execution pill
│   │   ├── template-manager.js                ◄── C12: Save/load/delete template CRUD
│   │   ├── auto-layout-engine.js              ◄── C13: Dagre integration, topological sort
│   │   ├── undo-redo-manager.js               ◄── C14: Command pattern, dual stack
│   │   ├── code-generation-engine.js          ◄── Shared: SQL/PySpark template rendering
│   │   ├── wizard-event-bus.js                ◄── Shared: Lightweight typed event emitter
│   │   ├── wizard-validator.js                ◄── Shared: Per-page + cross-page validation
│   │   └── theme-data.js                      ◄── Shared: 6 theme sample data definitions
│   │
│   └── [existing files unchanged]
│
├── css/
│   ├── infra-wizard.css                       ◄── All wizard CSS (single file, prefixed .iw-*)
│   └── [existing files unchanged]
│
└── [existing files unchanged]
```

**File count:** 18 new JS files + 1 new CSS file = **19 new files**

**Estimated line counts:**

| File | Est. LOC | Rationale |
|------|----------|-----------|
| `infra-wizard-dialog.js` | ~800 | Modal chrome, stepper, page transitions, resize/drag, minimize |
| `infra-setup-page.js` | ~400 | 4 form fields, capacity dropdown async load, auto-name sync |
| `theme-schema-page.js` | ~350 | 6 theme cards, schema toggles, selection management |
| `dag-canvas.js` | ~900 | SVG init, zoom/pan, grid, drop target, context menu, selection |
| `node-palette.js` | ~300 | 3 cards, drag ghost, double-click, command palette shortcut |
| `dag-node.js` | ~600 | SVG foreignObject, ports, popover, drag, rename, type/schema |
| `connection-manager.js` | ~700 | Bezier paths, drag-to-connect, cycle detection, hit testing |
| `code-preview-panel.js` | ~500 | Collapsible panel, code gen, syntax highlight, line numbers |
| `review-summary.js` | ~450 | Summary cards, mini-DAG SVG, confirmation banner, edit links |
| `execution-pipeline.js` | ~1200 | 6-step orchestrator, timers, logs, retry, rollback, minimize |
| `floating-badge.js` | ~200 | Fixed pill, status dot, progress text, click-to-restore |
| `template-manager.js` | ~400 | Save/load/delete dialogs, backend HTTP, name validation |
| `auto-layout-engine.js` | ~350 | Dagre wrapper, topological sort (Kahn's), viewport fit calc |
| `undo-redo-manager.js` | ~400 | Command interface, dual stack, 50-level limit, batch commands |
| `code-generation-engine.js` | ~600 | Topological sort, 18 templates (6 themes × 3 types), cell assembly |
| `wizard-event-bus.js` | ~80 | Typed EventEmitter with on/off/emit/once |
| `wizard-validator.js` | ~300 | Per-field, per-page, cross-page validation rules |
| `theme-data.js` | ~400 | 6 themes × 5 tables × 10 rows sample data |
| `infra-wizard.css` | ~1200 | All wizard styles, .iw-* prefix, design bible tokens |
| **Total** | **~9,130** | |

### 1.4 Integration with Existing EDOG Studio Shell

The wizard plugs into the existing application at three points. No existing files require structural changes — only additive modifications.

#### 1.4.1 Entry Points (workspace-explorer.js)

```javascript
// ─── workspace-explorer.js additions (3 entry points) ─────────────

// Entry 1: Context menu on workspace node (primary)
_showContextMenu(e, nodeData) {
  // ... existing menu items ...
  if (nodeData.isWorkspace) {
    items.push({
      label: 'Create Infrastructure...',
      cls: 'accent',
      icon: '◆',
      action: () => this._openInfraWizard(nodeData.workspace)
    });
  }
}

// Entry 2: Empty state CTA (when no workspaces exist)
_renderEmptyState() {
  // ... existing empty state ...
  // Add: <button class="ws-btn-primary" onclick="...">Create your first test environment</button>
}

// Entry 3: Workspace content area action bar
_showWorkspaceContent(ws) {
  // ... existing content ...
  // Add: <button class="ws-btn-secondary" id="ws-new-env-btn">New Environment</button>
}

// Shared wizard launcher
_openInfraWizard(workspace = null) {
  if (InfraWizardDialog.isAnyOpen()) {
    this._toast('A wizard is already open', 'warning');
    return;
  }
  const wizard = new InfraWizardDialog(this._api, {
    preselectedWorkspace: workspace
  });
  wizard.onComplete = (result) => {
    this._selectWorkspace(result.workspace);
    this.loadWorkspaces();
    this._toast(`Environment "${result.workspace.displayName}" created`, 'success');
  };
  wizard.open();
}
```

#### 1.4.2 Command Palette Integration (command-palette.js)

```javascript
// Add to command registry
{ label: 'New Environment (Wizard)', icon: '◆', shortcut: 'Ctrl+Shift+N',
  action: () => window.edogViewer?.workspaceExplorer?._openInfraWizard() }
```

#### 1.4.3 main.js Initialization

```javascript
// In EdogLogViewer constructor — NO initialization needed.
// InfraWizardDialog is lazily created on demand (not at startup).
// The class is available globally because it's inlined in the single HTML.
```

#### 1.4.4 CSS Variable Extensions (variables.css)

```css
/* ─── F16 Wizard Tokens ─── */
--z-wizard-overlay: 500;       /* Above toast (400), above command palette (300) */
--z-wizard-dialog: 501;        /* Above overlay */
--z-wizard-popover: 502;       /* Node popover above dialog */
--z-wizard-badge: 490;         /* Floating badge below overlay but above everything else */

--iw-dialog-width: 920px;
--iw-dialog-height: 680px;
--iw-dialog-min-width: 640px;
--iw-dialog-min-height: 480px;

--iw-node-width: 180px;
--iw-node-height: 72px;

--iw-color-sql-table: oklch(0.62 0.18 250);      /* Blue */
--iw-color-sql-mlv: oklch(0.55 0.22 290);         /* Purple */
--iw-color-pyspark-mlv: oklch(0.68 0.18 70);      /* Orange */

--iw-color-sql-table-bg: oklch(0.95 0.03 250);
--iw-color-sql-mlv-bg: oklch(0.95 0.04 290);
--iw-color-pyspark-mlv-bg: oklch(0.95 0.04 70);

--iw-schema-dbo: oklch(0.55 0.15 250);            /* Blue */
--iw-schema-bronze: oklch(0.60 0.14 55);           /* Bronze/copper */
--iw-schema-silver: oklch(0.65 0.04 260);          /* Silver/grey */
--iw-schema-gold: oklch(0.70 0.16 85);             /* Gold */

--iw-transition-page: 350ms cubic-bezier(0.4, 0, 0.2, 1);
--iw-transition-spring: 500ms cubic-bezier(0.34, 1.56, 0.64, 1);
--iw-transition-smooth: 300ms cubic-bezier(0.4, 0, 0.2, 1);
```

---

## 2. Wizard State Management

### 2.1 Central WizardState Object

The `WizardState` is the single source of truth for all wizard data across all 5 pages. It is owned by `InfraWizardDialog` (C01), passed by reference to all child pages, and serialized for template save/load. Navigation between pages NEVER clears state.

```typescript
/**
 * Central wizard state — owned by InfraWizardDialog (C01).
 * Passed to all child page components by reference.
 * Serialized by TemplateManager (C12) for save/load.
 * Frozen (Object.freeze) before passing to ExecutionPipeline (C10).
 */
interface WizardState {
  // ─── Page 0: Infrastructure Setup (C02) ───
  workspaceName: string;                          // e.g. "brave_turing_42"
  workspaceNameManuallyEdited: boolean;           // false = auto-generated, true = user typed
  capacityId: string | null;                      // selected capacity GUID (null = not selected)
  capacityDisplayName: string;                    // "F4 — East US (Running)" for display
  capacitySku: string;                            // "F4" for review summary
  capacityRegion: string;                         // "East US" for review summary
  lakehouseName: string;                          // e.g. "brave_turing_42_lh"
  lakehouseNameManuallyEdited: boolean;           // if true, don't auto-sync from workspace name
  notebookName: string;                           // e.g. "brave_turing_42_nb"
  notebookNameManuallyEdited: boolean;            // if true, don't auto-sync from workspace name

  // ─── Page 1: Theme & Schema (C03) ───
  theme: ThemeId | null;                          // null = not selected (blocks Next)
  schemas: SchemaSet;                             // which schemas are enabled

  // ─── Page 2: DAG Canvas (C04-C08, C13-C14) ───
  nodes: DagNodeData[];                           // all nodes on canvas
  connections: ConnectionData[];                  // all directed edges between nodes
  nextNodeId: number;                             // monotonic counter for node IDs
  nextConnectionId: number;                       // monotonic counter for connection IDs
  viewport: ViewportState;                        // canvas pan/zoom (not serialized to template)

  // ─── Page 3: Review (C09) ───
  // No unique state — derived entirely from pages 0-2

  // ─── Page 4: Execution (C10) ───
  execution: ExecutionState | null;               // null until "Lock In & Create" pressed

  // ─── Meta ───
  currentPage: number;                            // 0-4, current wizard page index
  highestVisitedPage: number;                     // highest page index user has reached
  createdAt: number;                              // Date.now() when wizard opened
  templateName: string | null;                    // non-null if loaded from template
  templateId: string | null;                      // template ID if loaded
  dirty: boolean;                                 // true if any field touched since open/load
}

// ─── Supporting Types ───

type ThemeId = 'ecommerce' | 'sales' | 'iot' | 'hr' | 'finance' | 'healthcare';

interface SchemaSet {
  dbo: true;              // ALWAYS true — non-removable, hardcoded
  bronze: boolean;        // user-toggled
  silver: boolean;        // user-toggled
  gold: boolean;          // user-toggled
}

interface DagNodeData {
  id: string;                                     // "node-1", "node-2", ...
  name: string;                                   // user-editable, e.g. "orders"
  type: 'sql-table' | 'sql-mlv' | 'pyspark-mlv';
  schema: 'dbo' | 'bronze' | 'silver' | 'gold';
  x: number;                                      // canvas position (top-left corner)
  y: number;
  width: number;                                   // default 180
  height: number;                                  // default 72
  sequenceNumber: number;                          // auto-name counter per type
  createdAt: number;                               // Date.now() for tiebreaking
}

interface ConnectionData {
  id: string;                                      // "conn-1", "conn-2", ...
  sourceNodeId: string;                            // parent/upstream node
  targetNodeId: string;                            // child/downstream node
}

interface ViewportState {
  panX: number;                                    // canvas-space translation
  panY: number;
  zoom: number;                                    // 0.25 to 4.0 (25% to 400%)
}

interface ExecutionState {
  status: 'running' | 'completed' | 'failed' | 'rolling-back';
  currentStepIndex: number;                        // 0-based
  steps: ExecutionStep[];
  startedAt: number;
  completedAt: number | null;
  error: ExecutionError | null;
  createdResources: CreatedResource[];             // for rollback tracking
  artifacts: ExecutionArtifacts;                   // IDs collected during execution
}

interface ExecutionStep {
  id: string;                                      // 'create-workspace' | 'assign-capacity' | etc.
  label: string;                                   // "Create Workspace"
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  detail: string | null;                           // API response summary for log panel
  error: string | null;
}

interface ExecutionError {
  stepId: string;
  message: string;
  httpStatus: number | null;
  responseBody: string | null;
  canRetry: boolean;
}

interface CreatedResource {
  type: 'workspace' | 'capacity-assignment' | 'lakehouse' | 'notebook';
  id: string;
  name: string;
  workspaceId: string;
}

interface ExecutionArtifacts {
  workspaceId: string | null;
  lakehouseId: string | null;
  notebookId: string | null;
}
```

### 2.2 State Ownership Matrix

Each state field has exactly ONE writer (the component that mutates it) and one or more readers. This prevents write conflicts and makes data flow traceable.

| State Field | Writer (Mutator) | Readers | When Written |
|-------------|-----------------|---------|--------------|
| `workspaceName` | C02-InfraSetupPage | C01, C09, C10 | On input blur |
| `workspaceNameManuallyEdited` | C02-InfraSetupPage | C02 (internal) | On first user keystroke |
| `capacityId` | C02-InfraSetupPage | C01, C09, C10 | On dropdown select |
| `capacityDisplayName` | C02-InfraSetupPage | C09 | On dropdown select |
| `capacitySku` | C02-InfraSetupPage | C09 | On dropdown select |
| `capacityRegion` | C02-InfraSetupPage | C09 | On dropdown select |
| `lakehouseName` | C02-InfraSetupPage | C01, C09, C10 | On input blur or auto-sync |
| `lakehouseNameManuallyEdited` | C02-InfraSetupPage | C02 (internal) | On first user keystroke |
| `notebookName` | C02-InfraSetupPage | C01, C09, C10 | On input blur or auto-sync |
| `notebookNameManuallyEdited` | C02-InfraSetupPage | C02 (internal) | On first user keystroke |
| `theme` | C03-ThemeSchemaPage | C04, C06, C08, C09, C10 | On card click |
| `schemas` | C03-ThemeSchemaPage | C04, C06, C08, C09 | On toggle click |
| `nodes` | C04-DagCanvas | C07, C08, C09, C10, C13, C14 | On add/remove/move/edit node |
| `connections` | C07-ConnectionManager | C04, C08, C09, C10, C13 | On add/remove connection |
| `nextNodeId` | C04-DagCanvas | C04 (internal) | On node creation |
| `nextConnectionId` | C07-ConnectionManager | C07 (internal) | On connection creation |
| `viewport` | C04-DagCanvas | C04 (internal) | On zoom/pan |
| `execution` | C10-ExecutionPipeline | C01, C11 | During pipeline execution |
| `currentPage` | C01-InfraWizardDialog | All children | On page navigation |
| `highestVisitedPage` | C01-InfraWizardDialog | C01 (stepper) | On forward navigation |
| `createdAt` | C01-InfraWizardDialog | C09, C12 | On wizard open |
| `templateName` | C12-TemplateManager | C01, C09 | On template load/save |
| `templateId` | C12-TemplateManager | C12 (internal) | On template load |
| `dirty` | C01-InfraWizardDialog | C01, C12 | On any state mutation |

### 2.3 State Flow Across Pages

Data flows forward (Page 0 → 1 → 2 → 3 → 4) through the shared `WizardState` object. Each page reads from upstream pages and writes its own fields. The state object is never cloned between pages — it's a single shared reference.

```
Page 0 (InfraSetupPage)
  WRITES: workspaceName, capacityId, lakehouseName, notebookName
  READS:  (nothing from other pages)
  │
  ▼ state.workspaceName, state.lakehouseName flow forward
  │
Page 1 (ThemeSchemaPage)
  WRITES: theme, schemas
  READS:  (nothing from other pages)
  │
  ▼ state.theme, state.schemas flow forward
  │
Page 2 (DagCanvasPage)
  WRITES: nodes, connections, nextNodeId, nextConnectionId, viewport
  READS:  state.theme (for code generation templates)
          state.schemas (for node schema dropdowns — dbo + selected schemas)
  │
  ▼ All state flows forward
  │
Page 3 (ReviewSummary)
  WRITES: (nothing — read-only page)
  READS:  ALL fields from pages 0-2 for display
          Runs cross-page validation
  │
  ▼ Entire state frozen with Object.freeze()
  │
Page 4 (ExecutionPipeline)
  WRITES: execution (status, steps, artifacts, createdResources)
  READS:  Frozen copy of pages 0-2 state as ExecutionContext
```

**Cross-page data dependencies (critical flow):**

1. **ThemeSchemaPage → DagCanvas:** When schemas change on Page 1, DagCanvas must update the available schemas in node popover dropdowns. If a node references a schema that was deselected, it reverts to `dbo`.

2. **ThemeSchemaPage → CodePreviewPanel:** Theme selection determines which sample data templates are used in code generation.

3. **DagCanvas → ReviewSummary:** Node and connection arrays are read to render the mini-DAG and compute summary statistics.

4. **All Pages → ExecutionPipeline:** The execution context is assembled from all pages' state, frozen, and passed as an immutable input to the pipeline.

### 2.4 Validation Pipeline

Validation runs at three levels, triggered at different times:

#### Level 1: Field-Level Validation (on blur)

Runs when the user leaves a form field. Provides immediate inline feedback.

```javascript
/**
 * Field validators — return null if valid, error string if invalid.
 * Called on input blur events.
 */
const FIELD_VALIDATORS = {
  workspaceName: (value) => {
    if (!value.trim()) return 'Workspace name is required';
    if (value.length > 256) return 'Name must be 256 characters or fewer';
    if (!/^[a-zA-Z0-9_ ]+$/.test(value)) return 'Only letters, numbers, spaces, and underscores';
    return null;
  },
  lakehouseName: (value) => {
    if (!value.trim()) return 'Lakehouse name is required';
    if (value.length > 256) return 'Name must be 256 characters or fewer';
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value)) return 'Must start with a letter, only letters/numbers/underscores';
    return null;
  },
  notebookName: (value) => {
    if (!value.trim()) return 'Notebook name is required';
    if (value.length > 256) return 'Name must be 256 characters or fewer';
    return null;
  },
  nodeName: (value) => {
    if (!value.trim()) return 'Node name is required';
    if (value.length > 63) return 'Name must be 63 characters or fewer';
    if (!/^[a-z][a-z0-9_]*$/.test(value)) return 'Lowercase letters, numbers, underscores; must start with letter';
    return null;
  }
};
```

#### Level 2: Page-Level Validation (on Next click)

Runs when the user clicks Next. Blocks forward navigation if validation fails. Returns a `PageValidationResult`.

```javascript
/**
 * Page validators — return { valid: boolean, errors: string[] }.
 * Called by InfraWizardDialog before allowing page transition.
 */
const PAGE_VALIDATORS = {
  // Page 0: Infrastructure Setup
  0: (state) => {
    const errors = [];
    if (!state.workspaceName.trim()) errors.push('Workspace name is required');
    if (!state.capacityId) errors.push('Select a capacity');
    if (!state.lakehouseName.trim()) errors.push('Lakehouse name is required');
    if (!state.notebookName.trim()) errors.push('Notebook name is required');
    return { valid: errors.length === 0, errors };
  },

  // Page 1: Theme & Schema
  1: (state) => {
    const errors = [];
    if (!state.theme) errors.push('Select a data theme');
    // schemas always valid (dbo is always true)
    return { valid: errors.length === 0, errors };
  },

  // Page 2: DAG Canvas
  2: (state) => {
    const errors = [];
    if (state.nodes.length === 0) errors.push('Add at least one node to the DAG');
    // Check all MLV nodes have at least one parent
    const nodeIds = new Set(state.nodes.map(n => n.id));
    const childIds = new Set(state.connections.map(c => c.targetNodeId));
    for (const node of state.nodes) {
      if ((node.type === 'sql-mlv' || node.type === 'pyspark-mlv') && !childIds.has(node.id)) {
        errors.push(`MLV node "${node.name}" has no parent connections`);
      }
      // Check node name validity
      const nameError = FIELD_VALIDATORS.nodeName(node.name);
      if (nameError) errors.push(`Node "${node.name}": ${nameError}`);
      // Check schema is still available
      if (node.schema !== 'dbo' && !state.schemas[node.schema]) {
        errors.push(`Node "${node.name}" uses schema "${node.schema}" which is not enabled`);
      }
    }
    // Check for duplicate node names within the same schema
    const nameSchemaSet = new Set();
    for (const node of state.nodes) {
      const key = `${node.schema}.${node.name}`;
      if (nameSchemaSet.has(key)) {
        errors.push(`Duplicate name: ${key} — each name must be unique within its schema`);
      }
      nameSchemaSet.add(key);
    }
    return { valid: errors.length === 0, errors };
  },

  // Page 3: Review (always valid — it's read-only)
  3: (state) => {
    return { valid: true, errors: [] };
  }
};
```

#### Level 3: Cross-Page Validation (on Review page mount)

Runs when the user lands on Page 3 (Review). Catches cross-page inconsistencies.

```javascript
/**
 * Cross-page validation — catches inconsistencies between pages.
 * Runs on ReviewSummary mount. Blocks "Lock In & Create" if errors found.
 */
function validateCrossPage(state) {
  const errors = [];
  const warnings = [];

  // Schema consistency: nodes reference only enabled schemas
  const enabledSchemas = new Set(['dbo']);
  if (state.schemas.bronze) enabledSchemas.add('bronze');
  if (state.schemas.silver) enabledSchemas.add('silver');
  if (state.schemas.gold) enabledSchemas.add('gold');
  for (const node of state.nodes) {
    if (!enabledSchemas.has(node.schema)) {
      errors.push(`Node "${node.name}" uses disabled schema "${node.schema}"`);
    }
  }

  // DAG integrity: no orphaned connections
  const nodeIdSet = new Set(state.nodes.map(n => n.id));
  for (const conn of state.connections) {
    if (!nodeIdSet.has(conn.sourceNodeId)) errors.push(`Connection references missing source node ${conn.sourceNodeId}`);
    if (!nodeIdSet.has(conn.targetNodeId)) errors.push(`Connection references missing target node ${conn.targetNodeId}`);
  }

  // Theme + nodes: warn if no PySpark nodes (fmlv import unnecessary)
  const hasPySpark = state.nodes.some(n => n.type === 'pyspark-mlv');
  // (info only, not an error)

  return { valid: errors.length === 0, errors, warnings };
}
```

### 2.5 Dirty Detection

Dirty tracking determines whether to show an "unsaved changes" confirmation when the user presses Escape or clicks the close button.

```javascript
/**
 * Dirty detection strategy:
 * - `dirty` flag starts as `false` on wizard open
 * - Set to `true` on ANY state mutation (field edit, node add, connection draw, etc.)
 * - Reset to `false` after successful template save
 * - NOT reset after execution (execution is a different concern)
 *
 * Implementation: InfraWizardDialog wraps the state object in a Proxy
 * that sets `dirty = true` on any property set.
 */
_createDirtyProxy(state) {
  const dialog = this;
  return new Proxy(state, {
    set(target, property, value) {
      if (target[property] !== value) {
        target.dirty = true;
      }
      target[property] = value;
      return true;
    }
  });
}
```

**Close confirmation logic:**

```javascript
_handleClose() {
  if (this._state.execution?.status === 'running') {
    // During execution: close = minimize (execution continues)
    this.minimize();
    return;
  }
  if (this._state.dirty && !this._state.execution) {
    // Unsaved changes: show confirmation
    if (!confirm('You have unsaved changes. Close the wizard?')) return;
  }
  this.close();
}
```

### 2.6 Template Hydration

When a user loads a template, the `TemplateManager` (C12) populates the entire `WizardState` from the template's saved snapshot. The hydration process:

```javascript
/**
 * Template hydration flow:
 * 1. TemplateManager loads template JSON from backend
 * 2. TemplateManager validates template against current schema version
 * 3. TemplateManager calls wizardDialog.hydrateFromTemplate(template)
 * 4. InfraWizardDialog overwrites WizardState fields from template
 * 5. Each page component re-reads state on next activate()
 *
 * What IS saved in templates (and thus hydrated):
 *   - workspaceName, lakehouseName, notebookName (as starting points)
 *   - theme, schemas
 *   - nodes (full array with positions, types, schemas, names)
 *   - connections (full array)
 *   - nextNodeId, nextConnectionId
 *
 * What is NOT saved (and thus NOT hydrated):
 *   - capacityId (capacity selection is runtime-dependent)
 *   - viewport (zoom/pan is session-only)
 *   - execution (never saved)
 *   - dirty flag (reset to false after hydration)
 *   - currentPage (reset to 0 after hydration)
 */
hydrateFromTemplate(template) {
  // Merge template data into state
  Object.assign(this._state, {
    workspaceName: template.workspaceName,
    workspaceNameManuallyEdited: true,  // treated as manual since it came from template
    lakehouseName: template.lakehouseName,
    lakehouseNameManuallyEdited: true,
    notebookName: template.notebookName,
    notebookNameManuallyEdited: true,
    theme: template.theme,
    schemas: { ...template.schemas },
    nodes: template.nodes.map(n => ({ ...n })),  // deep copy
    connections: template.connections.map(c => ({ ...c })),
    nextNodeId: template.nextNodeId,
    nextConnectionId: template.nextConnectionId,
    templateName: template.name,
    templateId: template.id,
    dirty: false,
    currentPage: 0,
    highestVisitedPage: 0,
  });

  // Reset capacity (must be re-selected at runtime)
  this._state.capacityId = null;
  this._state.capacityDisplayName = '';

  // Reset execution
  this._state.execution = null;

  // Notify all pages to re-read state
  this._eventBus.emit('state:hydrated', { source: 'template' });
}
```

---

## 3. Component Communication Architecture

### 3.1 Event System Design

The wizard uses a **lightweight typed EventEmitter** for cross-component communication. This is a custom implementation (not DOM CustomEvent) for three reasons: (1) typed payloads with documentation, (2) no DOM bubbling overhead, (3) easy cleanup on wizard destruction.

```javascript
/**
 * WizardEventBus — Lightweight typed event emitter.
 * One instance per wizard session. Destroyed when wizard closes.
 *
 * Design choice: Custom EventEmitter over DOM CustomEvent because:
 * - No DOM bubbling (events are wizard-internal, not page-level)
 * - Typed payload contracts (documented per event)
 * - Easy cleanup: destroy() removes all listeners in one call
 * - No risk of collisions with existing EDOG DOM events
 */
class WizardEventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event — Event name from the event catalog
   * @param {Function} handler — Callback receiving the event payload
   * @returns {Function} Unsubscribe function
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event)?.delete(handler);
  }

  /**
   * Subscribe to an event for one invocation only.
   * @param {string} event
   * @param {Function} handler
   */
  once(event, handler) {
    const unsub = this.on(event, (payload) => {
      unsub();
      handler(payload);
    });
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} event — Event name
   * @param {*} payload — Event-specific payload
   */
  emit(event, payload) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[WizardEventBus] Error in handler for "${event}":`, err);
      }
    }
  }

  /**
   * Remove all listeners. Called on wizard destruction.
   */
  destroy() {
    this._listeners.clear();
  }
}
```

**Wiring pattern:** `InfraWizardDialog` creates the event bus and passes it to all children:

```javascript
class InfraWizardDialog {
  constructor(apiClient, options = {}) {
    this._api = apiClient;
    this._eventBus = new WizardEventBus();
    this._state = this._createInitialState();

    // Child components receive eventBus + state reference
    this._infraSetupPage = new InfraSetupPage(this._state, this._eventBus, this._api);
    this._themeSchemaPage = new ThemeSchemaPage(this._state, this._eventBus);
    this._dagCanvas = new DagCanvas(this._state, this._eventBus);
    // ... etc
  }
}
```

### 3.2 Event Catalog

Every event in the system, organized by emitter. **48 events total** across 14 components.

#### 3.2.1 InfraWizardDialog (C01) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 1 | `wizard:opened` | `{ timestamp: number }` | C01 | — | Wizard dialog opened and visible |
| 2 | `wizard:closed` | `{ dirty: boolean }` | C01 | C12 | Wizard dialog closed (not minimized) |
| 3 | `wizard:minimized` | `{ executionStep: number }` | C01 | C11 | Dialog hidden, FloatingBadge created |
| 4 | `wizard:restored` | `{ fromBadge: boolean }` | C01 | C11 | Dialog restored from FloatingBadge |
| 5 | `wizard:page-changing` | `{ from: number, to: number, direction: 'forward'  \| 'backward' }` | C01 | All pages | About to transition pages (before animation) |
| 6 | `wizard:page-changed` | `{ page: number, direction: 'forward' \| 'backward' }` | C01 | All pages | Page transition complete (after animation) |
| 7 | `state:hydrated` | `{ source: 'template' \| 'initial' }` | C01 | All pages | State was bulk-updated (template load or reset) |

#### 3.2.2 InfraSetupPage (C02) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 8 | `setup:workspace-name-changed` | `{ name: string, manual: boolean }` | C02 | C01 (dirty) | Workspace name field changed |
| 9 | `setup:capacity-selected` | `{ id: string, name: string, sku: string, region: string }` | C02 | C01 (dirty) | Capacity dropdown selection changed |
| 10 | `setup:lakehouse-name-changed` | `{ name: string, manual: boolean }` | C02 | C01 (dirty) | Lakehouse name changed |
| 11 | `setup:notebook-name-changed` | `{ name: string, manual: boolean }` | C02 | C01 (dirty) | Notebook name changed |
| 12 | `setup:capacities-loaded` | `{ capacities: Capacity[], count: number }` | C02 | — | Capacity list fetched from API |
| 13 | `setup:validation-changed` | `{ valid: boolean, errors: string[] }` | C02 | C01 (Next btn) | Page validation state updated |

#### 3.2.3 ThemeSchemaPage (C03) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 14 | `theme:selected` | `{ themeId: ThemeId, themeName: string }` | C03 | C04, C08, C09 | Theme card clicked |
| 15 | `schema:toggled` | `{ schema: string, enabled: boolean, allSchemas: SchemaSet }` | C03 | C04, C06, C08, C09 | Schema toggle changed |
| 16 | `theme:validation-changed` | `{ valid: boolean, errors: string[] }` | C03 | C01 (Next btn) | Page validation state updated |

#### 3.2.4 DagCanvas (C04) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 17 | `canvas:node-added` | `{ node: DagNodeData, source: 'palette' \| 'context-menu' \| 'keyboard' }` | C04 | C05, C08, C14 | Node created on canvas |
| 18 | `canvas:node-removed` | `{ node: DagNodeData, cascadedConnections: string[] }` | C04 | C05, C07, C08, C14 | Node deleted (with cascaded connection IDs) |
| 19 | `canvas:node-moved` | `{ nodeId: string, fromX: number, fromY: number, toX: number, toY: number }` | C04 | C07, C14 | Node drag-move completed |
| 20 | `canvas:node-selected` | `{ nodeIds: string[], append: boolean }` | C04 | C06, C07 | Node selection changed |
| 21 | `canvas:node-deselected` | `{ nodeIds: string[] }` | C04 | C06, C07 | Nodes deselected |
| 22 | `canvas:selection-cleared` | `{}` | C04 | C06, C07 | All nodes/connections deselected |
| 23 | `canvas:zoom-changed` | `{ zoom: number, panX: number, panY: number }` | C04 | — | Viewport transform updated |
| 24 | `canvas:context-menu` | `{ x: number, y: number, target: 'canvas' \| 'node' \| 'connection' }` | C04 | — | Right-click context menu opened |
| 25 | `canvas:drop-received` | `{ type: string, canvasX: number, canvasY: number }` | C04 | C05 | Drop event from NodePalette processed |
| 26 | `canvas:validation-changed` | `{ valid: boolean, errors: string[] }` | C04 | C01 (Next btn) | Page 2 validation state updated |
| 27 | `canvas:node-limit-reached` | `{ current: number, max: number }` | C04 | C05 | 100-node limit hit |

#### 3.2.5 NodePalette (C05) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 28 | `palette:drag-started` | `{ type: string }` | C05 | C04 | Drag from palette started |
| 29 | `palette:drag-ended` | `{ type: string, dropped: boolean }` | C05 | C04 | Drag from palette ended |
| 30 | `palette:quick-add` | `{ type: string }` | C05 | C04 | Double-click quick-add |

#### 3.2.6 DagNode (C06) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 31 | `node:renamed` | `{ nodeId: string, oldName: string, newName: string }` | C06 | C04, C08, C14 | Node name changed in popover |
| 32 | `node:type-changed` | `{ nodeId: string, oldType: string, newType: string }` | C06 | C04, C07, C08, C14 | Node type changed in popover |
| 33 | `node:schema-changed` | `{ nodeId: string, oldSchema: string, newSchema: string }` | C06 | C04, C08, C14 | Node schema changed in popover |
| 34 | `node:delete-requested` | `{ nodeId: string }` | C06 | C04 | Delete button clicked in popover |
| 35 | `node:popover-opened` | `{ nodeId: string }` | C06 | C04 | Node popover editor opened |
| 36 | `node:popover-closed` | `{ nodeId: string }` | C06 | C04 | Node popover editor closed |
| 37 | `node:port-drag-started` | `{ nodeId: string, portId: 'out', portX: number, portY: number }` | C06 | C07 | Output port drag initiated |

#### 3.2.7 ConnectionManager (C07) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 38 | `connection:created` | `{ connection: ConnectionData, source: DagNodeData, target: DagNodeData }` | C07 | C04, C08, C14 | New connection established |
| 39 | `connection:removed` | `{ connectionId: string, sourceNodeId: string, targetNodeId: string }` | C07 | C04, C08, C14 | Connection deleted |
| 40 | `connection:selected` | `{ connectionId: string }` | C07 | C04 | Connection clicked/selected |
| 41 | `connection:rejected` | `{ reason: 'cycle' \| 'self-loop' \| 'duplicate' \| 'invalid-port', sourceId: string, targetId: string }` | C07 | C04 | Connection attempt rejected |
| 42 | `connection:drag-preview` | `{ sourceNodeId: string, mouseX: number, mouseY: number }` | C07 | C06 | Connection drag in progress (for port highlighting) |

#### 3.2.8 CodePreviewPanel (C08) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 43 | `preview:refreshed` | `{ lineCount: number, cellCount: number, timestamp: number }` | C08 | — | Code regenerated successfully |
| 44 | `preview:error` | `{ error: string }` | C08 | — | Code generation failed |
| 45 | `preview:toggled` | `{ expanded: boolean }` | C08 | C04 | Panel collapsed/expanded (affects canvas width) |

#### 3.2.9 ExecutionPipeline (C10) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 46 | `execution:started` | `{ totalSteps: number }` | C10 | C01, C11 | Pipeline execution began |
| 47 | `execution:step-started` | `{ stepIndex: number, stepId: string, label: string }` | C10 | C01, C11 | Individual step began |
| 48 | `execution:step-completed` | `{ stepIndex: number, stepId: string, durationMs: number, detail: string }` | C10 | C01, C11 | Individual step succeeded |
| 49 | `execution:step-failed` | `{ stepIndex: number, stepId: string, error: ExecutionError }` | C10 | C01, C11 | Individual step failed |
| 50 | `execution:completed` | `{ totalDurationMs: number, artifacts: ExecutionArtifacts }` | C10 | C01, C11 | All steps completed successfully |
| 51 | `execution:failed` | `{ error: ExecutionError, completedSteps: number }` | C10 | C01, C11 | Pipeline failed (unrecoverable or user-declined retry) |
| 52 | `execution:rollback-started` | `{ resources: CreatedResource[] }` | C10 | C01, C11 | Rollback cleanup initiated |
| 53 | `execution:rollback-completed` | `{ cleaned: string[], failed: string[] }` | C10 | C01, C11 | Rollback finished |
| 54 | `execution:retry` | `{ fromStep: number }` | C10 | C01 | Retry from failed step |

#### 3.2.10 FloatingBadge (C11) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 55 | `badge:clicked` | `{}` | C11 | C01 | User clicked badge to restore wizard |
| 56 | `badge:dismissed` | `{}` | C11 | C01 | User dismissed a completed/failed badge |

#### 3.2.11 TemplateManager (C12) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 57 | `template:saved` | `{ id: string, name: string }` | C12 | C01, C09 | Template saved successfully |
| 58 | `template:loaded` | `{ id: string, name: string }` | C12 | C01 | Template loaded into state |
| 59 | `template:deleted` | `{ id: string, name: string }` | C12 | C01 | Template deleted |
| 60 | `template:load-error` | `{ error: string }` | C12 | C01 | Template load failed |

#### 3.2.12 AutoLayoutEngine (C13) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 61 | `layout:computed` | `{ positions: Map<string, {x,y}>, boundingBox: {x,y,w,h} }` | C13 | C04 | Layout positions calculated |
| 62 | `layout:applied` | `{ animated: boolean, durationMs: number }` | C04 | C08 | Layout positions applied to DOM |

#### 3.2.13 UndoRedoManager (C14) Events

| # | Event Name | Payload Type | Emitter | Consumers | Description |
|---|-----------|-------------|---------|-----------|-------------|
| 63 | `undo:executed` | `{ commandType: string, description: string }` | C14 | C04, C07 | Undo performed |
| 64 | `redo:executed` | `{ commandType: string, description: string }` | C14 | C04, C07 | Redo performed |
| 65 | `undo:state-changed` | `{ canUndo: boolean, canRedo: boolean, undoDescription: string \| null, redoDescription: string \| null }` | C14 | C04 (toolbar) | Undo/redo availability changed |

### 3.3 Parent-Child Communication Patterns

**Pattern 1: Props Down** — Parent passes data to child via constructor parameters and method calls.

```javascript
// C01 → C02: Pass state reference and event bus
this._infraSetupPage = new InfraSetupPage(this._state, this._eventBus, this._api);
this._infraSetupPage.activate();  // direct method call to show page
```

**Pattern 2: Events Up** — Children emit events; parents listen and react.

```javascript
// C02 → C01: Validation result flows up via event
this._eventBus.on('setup:validation-changed', ({ valid }) => {
  this._updateNextButtonState(valid);
});
```

**Pattern 3: Sibling Coordination** — Siblings communicate exclusively through the event bus. No direct references.

```javascript
// C03 (ThemeSchemaPage) emits → C06 (DagNode) consumes
// C03 and C06 never reference each other
this._eventBus.on('schema:toggled', ({ allSchemas }) => {
  this._updateAvailableSchemas(allSchemas);
});
```

### 3.4 Cross-Component Coordination Flows

#### Flow 1: Schema Change Propagation

When the user toggles a schema on Page 1, it must propagate to DagNode dropdowns on Page 2.

```
ThemeSchemaPage (C03)
  │ user toggles "silver" OFF
  │
  ├─ emit('schema:toggled', { schema: 'silver', enabled: false, allSchemas: {...} })
  │
  ├──▸ DagCanvas (C04) listens:
  │     └─ Updates _transientState.availableSchemas
  │     └─ For each node where schema === 'silver':
  │         ├─ Revert node.schema to 'dbo'
  │         └─ Update node visual badge
  │
  ├──▸ CodePreviewPanel (C08) listens:
  │     └─ Sets isStale = true (needs refresh)
  │
  └──▸ ReviewSummary (C09) listens:
        └─ Will re-read schemas on next activate()
```

#### Flow 2: Node Creation from Palette

```
NodePalette (C05)
  │ user drags "SQL MLV" card
  │
  ├─ emit('palette:drag-started', { type: 'sql-mlv' })
  │    └──▸ DagCanvas (C04): shows drop zone highlights
  │
  │ user drops on canvas at (screenX, screenY)
  │
  ├─ DagCanvas (C04):
  │    ├─ screenToCanvas(screenX, screenY) → (canvasX, canvasY)
  │    ├─ Creates AddNodeCommand
  │    ├─ UndoRedoManager.execute(command)
  │    ├─ command.execute():
  │    │   ├─ Creates DagNode instance
  │    │   ├─ Appends SVG group to nodes layer
  │    │   └─ Adds node to state.nodes[]
  │    ├─ emit('canvas:node-added', { node, source: 'palette' })
  │    │    ├──▸ NodePalette (C05): updates node counter
  │    │    └──▸ CodePreviewPanel (C08): sets isStale = true
  │    └─ emit('undo:state-changed', { canUndo: true, ... })
  │
  └─ emit('palette:drag-ended', { type: 'sql-mlv', dropped: true })
       └──▸ DagCanvas (C04): removes drop zone highlights
```

#### Flow 3: Execution Pipeline with Minimize

```
ReviewSummary (C09)
  │ user clicks "Lock In & Create"
  │
  ├─ InfraWizardDialog (C01):
  │    ├─ Freezes state (Object.freeze on execution context)
  │    ├─ Navigates to Page 4
  │    └─ ExecutionPipeline.start(executionContext)
  │
  ├─ ExecutionPipeline (C10):
  │    ├─ emit('execution:started', { totalSteps: 6 })
  │    ├─ Sequential API calls:
  │    │   ├─ Step 0: POST /metadata/folders → workspaceId
  │    │   │   emit('execution:step-completed', { stepIndex: 0, ... })
  │    │   ├─ Step 1: POST /workspaces/{id}/assignToCapacity
  │    │   │   emit('execution:step-completed', { stepIndex: 1, ... })
  │    │   ├─ Step 2: POST /workspaces/{id}/lakehouses
  │    │   │   ...
  │    │   └─ Step 5: POST /items/{nbId}/jobs/instances?jobType=RunNotebook
  │    │
  │    │ user clicks X button during Step 3
  │    │
  │    ├─ InfraWizardDialog (C01):
  │    │   ├─ minimize() — dialog hides with exit animation
  │    │   └─ Creates FloatingBadge (C11)
  │    │
  │    ├─ FloatingBadge (C11):
  │    │   ├─ Listens to execution:step-* events
  │    │   ├─ Updates "Step 4/6 — Creating Notebook"
  │    │   └─ On click: emit('badge:clicked')
  │    │        └──▸ C01.restore() — dialog reappears
  │    │
  │    └─ emit('execution:completed', { totalDurationMs, artifacts })
  │         ├──▸ C01: enables "Done" button with navigation link
  │         └──▸ C11: shows completion state, click to dismiss
```

### 3.5 Lifecycle Management

All page components follow the `activate()`/`deactivate()` lifecycle pattern established by the existing EDOG tab system.

```javascript
/**
 * Page lifecycle contract.
 * Every page component (C02-C10) implements these methods.
 */
class WizardPage {
  /**
   * Called when the page becomes visible (navigated to).
   * - Re-read state (may have changed on other pages)
   * - Start animations, bind page-specific keyboard shortcuts
   * - Focus first interactive element
   */
  activate() { }

  /**
   * Called when the page becomes hidden (navigated away).
   * - Pause animations, unbind page-specific keyboard shortcuts
   * - Close popovers, dismiss tooltips
   * - Do NOT clear state (state persists across pages)
   */
  deactivate() { }

  /**
   * Called when the wizard is destroyed (closed, not minimized).
   * - Remove all event listeners
   * - Remove all DOM elements created by this page
   * - Clear all timers/intervals
   * - Null out all references (aid GC)
   */
  destroy() { }

  /**
   * Called to validate this page before forward navigation.
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate() { return { valid: true, errors: [] }; }
}
```

**Lifecycle sequence for page transition:**

```
User clicks "Next" on Page 1 →
  1. C01 calls PAGE_VALIDATORS[1](state) → { valid: true }
  2. C01 calls currentPage.deactivate()    // ThemeSchemaPage.deactivate()
  3. C01 emits 'wizard:page-changing', { from: 1, to: 2, direction: 'forward' }
  4. C01 plays slide-left animation (350ms)
  5. C01 calls nextPage.activate()           // DagCanvasPage composite activate
  6. C01 updates stepper visual (circle 2 filled, connector 1 filled)
  7. C01 emits 'wizard:page-changed', { page: 2, direction: 'forward' }
  8. C01 updates highestVisitedPage = max(highestVisitedPage, 2)
```

---

## 4. DAG Data Model & Operations

### 4.1 Canonical DAG Representation

The DAG is stored as two parallel arrays in `WizardState`: `nodes[]` and `connections[]`. This flat representation was chosen over an adjacency-list or adjacency-matrix because:
- Serializes naturally to JSON (template save/load)
- Array operations (add/remove/filter) are O(1) amortized
- No circular references to worry about during serialization
- Both arrays are small (max 100 nodes, max ~500 connections)

```javascript
/**
 * Runtime DAG accessor — built lazily from the flat arrays.
 * Provides O(1) lookups that the flat arrays cannot.
 * Rebuilt after any mutation (add/remove node or connection).
 */
class DagGraph {
  constructor(nodes, connections) {
    /** @type {Map<string, DagNodeData>} */
    this._nodeMap = new Map(nodes.map(n => [n.id, n]));

    /** @type {Map<string, ConnectionData>} */
    this._connectionMap = new Map(connections.map(c => [c.id, c]));

    /** Forward adjacency: nodeId → Set of child nodeIds */
    this._children = new Map();

    /** Reverse adjacency: nodeId → Set of parent nodeIds */
    this._parents = new Map();

    // Initialize empty sets for all nodes
    for (const node of nodes) {
      this._children.set(node.id, new Set());
      this._parents.set(node.id, new Set());
    }

    // Build adjacency from connections
    for (const conn of connections) {
      this._children.get(conn.sourceNodeId)?.add(conn.targetNodeId);
      this._parents.get(conn.targetNodeId)?.add(conn.sourceNodeId);
    }
  }

  getNode(id)            { return this._nodeMap.get(id); }
  getConnection(id)      { return this._connectionMap.get(id); }
  getChildren(nodeId)    { return this._children.get(nodeId) ?? new Set(); }
  getParents(nodeId)     { return this._parents.get(nodeId) ?? new Set(); }
  getRoots()             { return [...this._parents.entries()].filter(([, p]) => p.size === 0).map(([id]) => id); }
  getLeaves()            { return [...this._children.entries()].filter(([, c]) => c.size === 0).map(([id]) => id); }
  get nodeCount()        { return this._nodeMap.size; }
  get connectionCount()  { return this._connectionMap.size; }
  getAllNodeIds()         { return [...this._nodeMap.keys()]; }
  getAllConnections()     { return [...this._connectionMap.values()]; }
}
```

### 4.2 Node CRUD Operations with Validation

All node mutations flow through `DagCanvas.addNode()` / `removeNode()` / `updateNode()`, which create `Command` objects and route them through the `UndoRedoManager`. The canvas NEVER mutates `state.nodes` directly.

#### Add Node

```javascript
/**
 * AddNodeCommand — reversible command for node creation.
 *
 * Validation (pre-execute):
 *   1. Node count < 100 (hard limit)
 *   2. Node type is valid ('sql-table' | 'sql-mlv' | 'pyspark-mlv')
 *   3. Canvas position is within reasonable bounds
 *
 * Execute:
 *   1. Generate unique ID: `node-${state.nextNodeId++}`
 *   2. Generate auto-name based on type: table_N, mlv_N, spark_N
 *   3. Create DagNodeData with defaults
 *   4. Push to state.nodes[]
 *   5. Create DagNode SVG element on canvas
 *   6. Rebuild DagGraph
 *   7. Emit 'canvas:node-added'
 *
 * Undo:
 *   1. Remove node from state.nodes[]
 *   2. Remove DagNode SVG element from canvas
 *   3. Cascade-remove all connections to/from this node
 *   4. Rebuild DagGraph
 *   5. Emit 'canvas:node-removed'
 */
class AddNodeCommand {
  constructor(canvas, type, canvasX, canvasY, overrides = {}) {
    this._canvas = canvas;
    this._type = type;
    this._x = canvasX;
    this._y = canvasY;
    this._overrides = overrides;
    this._createdNode = null;
    this._cascadedConnections = [];
  }

  get type() { return 'add-node'; }
  get description() { return `Add ${this._type} node`; }

  execute() {
    const state = this._canvas._state;
    if (state.nodes.length >= 100) throw new Error('Node limit (100) reached');

    const id = `node-${state.nextNodeId++}`;
    const seq = state.nodes.filter(n => n.type === this._type).length + 1;
    const prefix = { 'sql-table': 'table', 'sql-mlv': 'mlv', 'pyspark-mlv': 'spark' }[this._type];

    this._createdNode = {
      id,
      name: this._overrides.name ?? `${prefix}_${seq}`,
      type: this._type,
      schema: this._overrides.schema ?? 'dbo',
      x: this._x,
      y: this._y,
      width: 180,
      height: 72,
      sequenceNumber: seq,
      createdAt: Date.now(),
    };

    state.nodes.push(this._createdNode);
    this._canvas._renderNode(this._createdNode);
    this._canvas._rebuildGraph();
    this._canvas._eventBus.emit('canvas:node-added', {
      node: { ...this._createdNode },
      source: this._overrides._source ?? 'palette'
    });

    return this._createdNode;
  }

  undo() {
    const state = this._canvas._state;
    const idx = state.nodes.findIndex(n => n.id === this._createdNode.id);
    if (idx !== -1) state.nodes.splice(idx, 1);

    // Cascade-remove connections
    this._cascadedConnections = state.connections.filter(
      c => c.sourceNodeId === this._createdNode.id || c.targetNodeId === this._createdNode.id
    );
    state.connections = state.connections.filter(
      c => c.sourceNodeId !== this._createdNode.id && c.targetNodeId !== this._createdNode.id
    );

    this._canvas._removeNodeElement(this._createdNode.id);
    this._cascadedConnections.forEach(c => this._canvas._connectionMgr.removeConnectionElement(c.id));
    this._canvas._rebuildGraph();
    this._canvas._eventBus.emit('canvas:node-removed', {
      node: { ...this._createdNode },
      cascadedConnections: this._cascadedConnections.map(c => c.id)
    });
  }
}
```

### 4.3 Connection CRUD with Cycle Detection

Connections are owned by `ConnectionManager` (C07). Every connection mutation passes through cycle detection BEFORE being committed.

#### Cycle Detection Algorithm (DFS-based)

```javascript
/**
 * Cycle detection — determines if adding edge (source → target) would create a cycle.
 *
 * Algorithm: DFS from target node. If we can reach source node by following
 * existing forward edges from target, then adding source→target creates a cycle.
 *
 * Time complexity: O(V + E) where V = nodes, E = edges
 * Space complexity: O(V) for visited set
 *
 * This runs BEFORE the connection is created, not after.
 * At 100 nodes and ~500 edges, this completes in <1ms.
 */
function wouldCreateCycle(graph, sourceNodeId, targetNodeId) {
  // Special case: self-loop
  if (sourceNodeId === targetNodeId) return true;

  // DFS from target — can we reach source?
  const visited = new Set();
  const stack = [targetNodeId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === sourceNodeId) return true;  // Cycle detected!
    if (visited.has(current)) continue;
    visited.add(current);

    // Follow forward edges (children of current node)
    for (const childId of graph.getChildren(current)) {
      if (!visited.has(childId)) {
        stack.push(childId);
      }
    }
  }

  return false;  // No cycle — safe to add
}
```

#### Connection Validation Rules (Complete Enumeration)

```javascript
/**
 * Connection validation — ALL rules checked before creating a connection.
 * Returns { valid: boolean, reason: string | null }
 */
function validateConnection(graph, sourceNodeId, targetNodeId, connections) {
  // Rule 1: No self-loops
  if (sourceNodeId === targetNodeId) {
    return { valid: false, reason: 'self-loop' };
  }

  // Rule 2: No duplicate connections (same source → same target)
  const isDuplicate = connections.some(
    c => c.sourceNodeId === sourceNodeId && c.targetNodeId === targetNodeId
  );
  if (isDuplicate) {
    return { valid: false, reason: 'duplicate' };
  }

  // Rule 3: No reverse duplicate (target → source already exists)
  const isReverseDuplicate = connections.some(
    c => c.sourceNodeId === targetNodeId && c.targetNodeId === sourceNodeId
  );
  if (isReverseDuplicate) {
    return { valid: false, reason: 'reverse-duplicate' };
  }

  // Rule 4: Source must have output port (all node types have output ports)
  const sourceNode = graph.getNode(sourceNodeId);
  if (!sourceNode) return { valid: false, reason: 'invalid-source' };

  // Rule 5: Target must have input port (SQL Tables do NOT have input ports)
  const targetNode = graph.getNode(targetNodeId);
  if (!targetNode) return { valid: false, reason: 'invalid-target' };
  if (targetNode.type === 'sql-table') {
    return { valid: false, reason: 'sql-table-no-input' };
  }

  // Rule 6: No cycles (DFS check)
  if (wouldCreateCycle(graph, sourceNodeId, targetNodeId)) {
    return { valid: false, reason: 'cycle' };
  }

  return { valid: true, reason: null };
}
```

### 4.4 Topological Sort (Kahn's Algorithm)

Topological sort is used for two purposes: (1) ordering notebook cells so parents are defined before children, and (2) determining auto-layout rank assignment.

```javascript
/**
 * Topological sort using Kahn's algorithm (BFS-based).
 *
 * Returns: Ordered array of node IDs, roots first, leaves last.
 * Throws: Error if cycle detected (should never happen — cycle
 *         prevention is enforced at connection-creation time).
 *
 * Tiebreaking within the same topological level:
 *   1. Node type priority: sql-table (0) < sql-mlv (1) < pyspark-mlv (2)
 *   2. Creation timestamp (earlier first)
 *   This ensures deterministic, intuitive cell ordering.
 *
 * Time complexity: O(V + E)
 * Space complexity: O(V)
 */
function topologicalSort(nodes, connections) {
  // Build in-degree map
  const inDegree = new Map();
  const adjacency = new Map();  // forward adjacency: nodeId → [childIds]

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const conn of connections) {
    adjacency.get(conn.sourceNodeId)?.push(conn.targetNodeId);
    inDegree.set(conn.targetNodeId, (inDegree.get(conn.targetNodeId) ?? 0) + 1);
  }

  // Priority queue for tiebreaking: [inDegree=0 nodes], sorted by type then createdAt
  const typePriority = { 'sql-table': 0, 'sql-mlv': 1, 'pyspark-mlv': 2 };
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const queue = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) queue.push(nodeId);
  }

  // Sort initial queue by type priority, then creation time
  queue.sort((a, b) => {
    const na = nodeMap.get(a), nb = nodeMap.get(b);
    const typeDiff = typePriority[na.type] - typePriority[nb.type];
    if (typeDiff !== 0) return typeDiff;
    return na.createdAt - nb.createdAt;
  });

  const result = [];
  let processed = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    result.push(current);
    processed++;

    // Process children: decrement in-degree, add to queue if becomes 0
    const nextBatch = [];
    for (const childId of adjacency.get(current) ?? []) {
      const newDegree = inDegree.get(childId) - 1;
      inDegree.set(childId, newDegree);
      if (newDegree === 0) nextBatch.push(childId);
    }

    // Sort new entries before adding to queue (maintain tiebreaking)
    nextBatch.sort((a, b) => {
      const na = nodeMap.get(a), nb = nodeMap.get(b);
      const typeDiff = typePriority[na.type] - typePriority[nb.type];
      if (typeDiff !== 0) return typeDiff;
      return na.createdAt - nb.createdAt;
    });

    queue.push(...nextBatch);
  }

  // Safety check: if processed < nodes.length, there's a cycle
  if (processed < nodes.length) {
    throw new Error(`Cycle detected in DAG: processed ${processed} of ${nodes.length} nodes`);
  }

  return result;
}
```

### 4.5 Serialization Formats

The DAG data is serialized in three different formats for three different consumers:

#### Format 1: Template Serialization (for C12-TemplateManager)

```javascript
/**
 * Template format — everything needed to reconstitute the wizard state.
 * Stored in edog-templates.json.
 */
function serializeForTemplate(state) {
  return {
    workspaceName: state.workspaceName,
    lakehouseName: state.lakehouseName,
    notebookName: state.notebookName,
    theme: state.theme,
    schemas: { ...state.schemas },
    nodes: state.nodes.map(n => ({
      id: n.id, name: n.name, type: n.type, schema: n.schema,
      x: n.x, y: n.y, width: n.width, height: n.height,
      sequenceNumber: n.sequenceNumber, createdAt: n.createdAt,
    })),
    connections: state.connections.map(c => ({
      id: c.id, sourceNodeId: c.sourceNodeId, targetNodeId: c.targetNodeId,
    })),
    nextNodeId: state.nextNodeId,
    nextConnectionId: state.nextConnectionId,
  };
}
```

#### Format 2: Review Summary (for C09-ReviewSummary)

```javascript
/**
 * Review format — human-readable summary for the review page.
 */
function serializeForReview(state) {
  const graph = new DagGraph(state.nodes, state.connections);
  return {
    infrastructure: {
      workspaceName: state.workspaceName,
      capacityName: state.capacityDisplayName,
      lakehouseName: state.lakehouseName,
      notebookName: state.notebookName,
    },
    theme: state.theme,
    schemas: Object.entries(state.schemas).filter(([, v]) => v).map(([k]) => k),
    dag: {
      totalNodes: state.nodes.length,
      sqlTables: state.nodes.filter(n => n.type === 'sql-table').length,
      sqlMlvs: state.nodes.filter(n => n.type === 'sql-mlv').length,
      pysparkMlvs: state.nodes.filter(n => n.type === 'pyspark-mlv').length,
      connections: state.connections.length,
      rootNodes: graph.getRoots().length,
      leafNodes: graph.getLeaves().length,
    },
    resourceSummary: `1 workspace, 1 capacity assignment, 1 lakehouse, 1 notebook with ${state.nodes.length} cells`,
  };
}
```

#### Format 3: Execution Payload (for C10-ExecutionPipeline)

```javascript
/**
 * Execution format — frozen context for the pipeline.
 * Includes topologically sorted notebook cells.
 */
function serializeForExecution(state) {
  const sortedNodeIds = topologicalSort(state.nodes, state.connections);
  const cells = generateNotebookCells(state, sortedNodeIds);  // See §6

  return Object.freeze({
    workspaceName: state.workspaceName,
    capacityId: state.capacityId,
    lakehouseName: state.lakehouseName,
    enableSchemas: true,
    notebookName: state.notebookName,
    notebookCells: cells,
    schemas: Object.entries(state.schemas).filter(([, v]) => v).map(([k]) => k),
  });
}
```

### 4.6 DAG Validation Rules (Complete Enumeration)

| # | Rule | When Checked | Error Message |
|---|------|-------------|---------------|
| V1 | No self-loops | Connection creation | "Cannot connect a node to itself" |
| V2 | No duplicate edges | Connection creation | "Connection already exists" |
| V3 | No reverse duplicates | Connection creation | "Reverse connection exists (would create cycle)" |
| V4 | No cycles (DFS) | Connection creation | "Connection would create a cycle" |
| V5 | SQL Tables have no input port | Connection creation (target check) | "Plain SQL Tables cannot have parent connections" |
| V6 | All MLV nodes have ≥1 parent | Page 2 Next validation | "MLV node '{name}' has no parent connections" |
| V7 | Max 100 nodes | Node creation | "Maximum 100 nodes allowed" |
| V8 | Unique names within schema | Page 2 Next validation | "Duplicate name: {schema}.{name}" |
| V9 | Valid node names | Page 2 Next validation | "Node '{name}': {validation error}" |
| V10 | Node schema must be enabled | Page 2 Next validation + schema toggle | "Node '{name}' uses disabled schema" |
| V11 | At least one node exists | Page 2 Next validation | "Add at least one node to the DAG" |
| V12 | All connection endpoints valid | Cross-page validation (review) | "Connection references missing node" |

---

## 5. Canvas Rendering Architecture

### 5.1 SVG Layer Structure

The DAG canvas uses a layered SVG structure where each layer serves a specific purpose. Layers are ordered by z-index (earlier in DOM = further back).

```
<svg class="dag-canvas-svg" width="100%" height="100%">
  <!--
    Layer 0: Background — grid dots that move with pan/zoom
    Rendered as a repeating SVG pattern, not individual elements.
  -->
  <defs>
    <pattern id="dag-grid-pattern" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="10" cy="10" r="1" fill="oklch(0.85 0 0)" />
    </pattern>
    <marker id="dag-arrowhead" viewBox="0 0 10 8" refX="10" refY="4"
            markerWidth="10" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 4 L 0 8 z" fill="oklch(0.60 0.05 250)" />
    </marker>
    <marker id="dag-arrowhead-selected" viewBox="0 0 10 8" refX="10" refY="4"
            markerWidth="10" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 4 L 0 8 z" fill="var(--accent)" />
    </marker>
  </defs>

  <rect class="dag-grid-bg" width="10000" height="10000" x="-5000" y="-5000"
        fill="url(#dag-grid-pattern)" />

  <!--
    Root transform group — ALL content lives inside this <g>.
    Single transform = single GPU compositing layer = 60fps zoom/pan.
    Transform: scale(zoom) translate(panX, panY)
  -->
  <g class="dag-root-transform" transform="scale(1) translate(0, 0)">

    <!--
      Layer 1: Connections — SVG <path> elements for edges.
      BELOW nodes so nodes are always clickable on top of edges.
    -->
    <g class="dag-layer-connections" id="dag-connections-layer">
      <!-- ConnectionManager renders paths here -->
      <!-- <path class="dag-connection" d="M ... C ..." marker-end="url(#dag-arrowhead)" /> -->
    </g>

    <!--
      Layer 1.5: Connection preview — temp path during drag-to-connect.
      Separate from connections layer for easy cleanup.
    -->
    <g class="dag-layer-preview" id="dag-preview-layer">
      <!-- Single preview path during drag-to-connect -->
    </g>

    <!--
      Layer 2: Nodes — SVG <g> groups with <foreignObject> for rich HTML.
      ABOVE connections so clicks hit nodes first.
    -->
    <g class="dag-layer-nodes" id="dag-nodes-layer">
      <!-- DagNode instances render here -->
      <!-- Each node is a <g class="dag-node" data-node-id="node-1"> -->
    </g>

    <!--
      Layer 3: Selection — marquee rectangle during multi-select drag.
      ABOVE nodes so it's always visible.
    -->
    <g class="dag-layer-selection" id="dag-selection-layer">
      <!-- <rect class="dag-marquee" x="..." y="..." width="..." height="..." /> -->
    </g>

  </g>

  <!--
    Layer 4: Overlays — zoom controls, context menu.
    OUTSIDE the transform group so they stay fixed in screen space.
  -->
  <g class="dag-layer-overlays">
    <!-- Zoom controls are HTML elements, not SVG — positioned via CSS -->
  </g>
</svg>
```

### 5.2 Coordinate System: Screen to Canvas Transform Pipeline

Every mouse/pointer interaction requires converting screen coordinates (browser viewport) to canvas coordinates (SVG internal space). The pipeline:

```
Screen Space (clientX, clientY)          — Browser viewport pixels
       │
       ▼ subtract SVG element offset
SVG-Relative Space (relX, relY)          — Pixels relative to <svg> top-left
       │
       ▼ divide by zoom
Unzoomed Space (relX/zoom, relY/zoom)    — Canvas units at 1:1
       │
       ▼ subtract pan offset
Canvas Space (canvasX, canvasY)          — Absolute position on infinite canvas
```

**Implementation (pseudocode with actual formulas):**

```javascript
/**
 * Screen → Canvas coordinate transform.
 *
 * This is the most-called function in the entire canvas system.
 * It MUST be fast — no DOM queries, no layout recalc.
 * The SVG bounding rect is cached and invalidated only on resize.
 */
screenToCanvas(clientX, clientY) {
  // Cache SVG rect (invalidate on window resize)
  if (!this._svgRect) this._svgRect = this._svgEl.getBoundingClientRect();

  const relX = clientX - this._svgRect.left;
  const relY = clientY - this._svgRect.top;

  const canvasX = (relX / this._viewport.zoom) - this._viewport.panX;
  const canvasY = (relY / this._viewport.zoom) - this._viewport.panY;

  return { canvasX, canvasY };
}

/**
 * Canvas → Screen coordinate transform.
 * Used for positioning HTML overlays (popovers, tooltips) at node positions.
 */
canvasToScreen(canvasX, canvasY) {
  if (!this._svgRect) this._svgRect = this._svgEl.getBoundingClientRect();

  const clientX = (canvasX + this._viewport.panX) * this._viewport.zoom + this._svgRect.left;
  const clientY = (canvasY + this._viewport.panY) * this._viewport.zoom + this._svgRect.top;

  return { clientX, clientY };
}
```

### 5.3 Zoom/Pan Implementation

#### Zoom at Cursor (scroll wheel)

The zoom must be centered on the cursor position. This means the canvas point under the cursor stays fixed as the zoom level changes.

```javascript
/**
 * Zoom centered on cursor position.
 *
 * Algorithm:
 * 1. Record the canvas-space point under the cursor BEFORE zoom
 * 2. Apply new zoom level
 * 3. Compute what screen-space position that canvas point would now be at
 * 4. Adjust pan so the canvas point is still under the cursor
 *
 * This creates the "zoom into what you're looking at" behavior
 * that Figma, Google Maps, and every good zoomable canvas uses.
 */
_handleWheel(event) {
  event.preventDefault();

  // 1. Get canvas point under cursor BEFORE zoom change
  const { canvasX, canvasY } = this.screenToCanvas(event.clientX, event.clientY);

  // 2. Compute new zoom level
  const delta = -event.deltaY * 0.001;  // Normalize scroll speed
  const oldZoom = this._viewport.zoom;
  const newZoom = Math.max(0.25, Math.min(4.0, oldZoom * (1 + delta)));

  // 3. Apply new zoom
  this._viewport.zoom = newZoom;

  // 4. Adjust pan so (canvasX, canvasY) stays under cursor
  //    Derivation:
  //    screenX = (canvasX + panX) * zoom + svgRect.left
  //    We want screenX to equal event.clientX after zoom change.
  //    So: panX_new = (event.clientX - svgRect.left) / newZoom - canvasX
  const svgRect = this._svgRect;
  this._viewport.panX = (event.clientX - svgRect.left) / newZoom - canvasX;
  this._viewport.panY = (event.clientY - svgRect.top) / newZoom - canvasY;

  // 5. Apply transform (single DOM write)
  this._applyViewportTransform();

  // 6. Emit event for zoom display update
  this._eventBus.emit('canvas:zoom-changed', {
    zoom: newZoom, panX: this._viewport.panX, panY: this._viewport.panY
  });
}

/**
 * Apply viewport transform to the root <g> element.
 * This is a SINGLE DOM write — the only place pan/zoom affect rendering.
 * Using scale-then-translate order (SVG transform convention).
 */
_applyViewportTransform() {
  const { panX, panY, zoom } = this._viewport;
  this._rootTransformGroup.setAttribute(
    'transform',
    `scale(${zoom}) translate(${panX}, ${panY})`
  );
}
```

#### Pan (Space+Drag or Middle Mouse)

```javascript
/**
 * Pan implementation — space+drag or middle-mouse drag.
 * Operates in screen-pixel deltas, converted to canvas units.
 */
_startPan(clientX, clientY) {
  this._transient.panState = {
    startClientX: clientX,
    startClientY: clientY,
    startPanX: this._viewport.panX,
    startPanY: this._viewport.panY,
  };
  this._transient.interactionMode = 'panning';
  this._svgEl.style.cursor = 'grabbing';
}

_updatePan(clientX, clientY) {
  const pan = this._transient.panState;
  if (!pan) return;

  // Delta in screen pixels → convert to canvas units by dividing by zoom
  const dx = (clientX - pan.startClientX) / this._viewport.zoom;
  const dy = (clientY - pan.startClientY) / this._viewport.zoom;

  this._viewport.panX = pan.startPanX + dx;
  this._viewport.panY = pan.startPanY + dy;
  this._applyViewportTransform();
}

_endPan() {
  this._transient.panState = null;
  this._transient.interactionMode = 'idle';
  this._svgEl.style.cursor = '';
}
```

### 5.4 Hit Testing Strategy

Hit testing determines what the user clicked on. The priority order (highest to lowest) determines which element "wins" when overlapping.

```javascript
/**
 * Hit test hierarchy (highest priority first):
 *
 * 1. Node popover (HTML overlay, not SVG — handled by DOM event bubbling)
 * 2. Node port (10px SVG circle with 16px hit area)
 * 3. Node body (foreignObject HTML content)
 * 4. Connection path (SVG <path> with expanded 8px stroke hit area)
 * 5. Selection marquee (if in progress — swallows all hits)
 * 6. Empty canvas (deselect all)
 *
 * Implementation: We do NOT manually iterate elements.
 * Instead, we use CSS pointer-events and SVG stacking order:
 * - Nodes are ABOVE connections in DOM order → clicks hit nodes first
 * - Ports have pointer-events: all and a larger invisible hit circle (16px radius)
 * - Connections use stroke-width: 8px with opacity: 0 for the hit area
 * - Empty canvas clicks fall through to the <svg> element's click handler
 */

// Port hit area: invisible larger circle around the visible 5px port
// <circle class="dag-port-hitarea" r="16" pointer-events="all" fill="transparent" />
// <circle class="dag-port-visual"  r="5"  pointer-events="none" />

// Connection hit area: invisible wider path behind the visible path
// <path class="dag-connection-hitarea" stroke-width="12" stroke="transparent" pointer-events="stroke" />
// <path class="dag-connection-visual"  stroke-width="2"  pointer-events="none" />
```

### 5.5 Rendering Pipeline

```
State Mutation (e.g., node added)
       │
       ▼
Command.execute() — updates state arrays
       │
       ▼
_renderNode(nodeData) or _renderConnection(connData)
       │ Creates/updates specific SVG elements
       │ Does NOT re-render the entire canvas
       │
       ▼
_rebuildGraph() — rebuilds DagGraph accessor (O(V+E), <1ms at 100 nodes)
       │
       ▼
Event emission (canvas:node-added, etc.)
       │ Consumers may trigger their own renders
       │ (e.g., CodePreviewPanel sets isStale flag)
       │
       ▼
requestAnimationFrame — batches visual updates
       │ Multiple rapid mutations (e.g., auto-layout) are batched
       │ into a single frame
       │
       ▼
_applyViewportTransform() — single DOM write for zoom/pan
```

**Key principle:** No mutation causes a full canvas re-render. Every operation targets the specific SVG elements affected. The only "full render" happens on initial load and template hydration.

### 5.6 Performance Architecture

| Operation | Budget | Strategy |
|-----------|--------|----------|
| Node add | <5ms | Single SVG group creation + foreignObject |
| Node move (drag) | <8ms/frame | Update single `<g>` transform + connected paths |
| Connection draw preview | <4ms/frame | Update single `<path>` d attribute |
| Zoom/pan | <2ms/frame | Single `<g>` transform attribute update (GPU composited) |
| Auto-layout (100 nodes) | <50ms compute, 300ms animate | Dagre compute off-screen, then animate with RAF |
| Full re-render (template load) | <100ms | Batch DOM creation, append all at once |
| Connection Bezier calculation | <0.1ms per path | Cached control points, recalculated only on endpoint move |

**requestAnimationFrame batching:**

```javascript
/**
 * Batch multiple DOM updates into a single animation frame.
 * Used during auto-layout animation and rapid drag operations.
 */
_scheduleRender() {
  if (this._renderScheduled) return;
  this._renderScheduled = true;
  requestAnimationFrame(() => {
    this._renderScheduled = false;
    this._flushPendingUpdates();
  });
}
```

**DOM recycling for node deletion:** When a node is deleted, its SVG group is removed from the DOM immediately (no pool/recycling). At max 100 nodes, the overhead of createElement is negligible and recycling adds complexity without measurable benefit.

---

## 6. Code Generation Engine

### 6.1 Topological Sort to Cell Ordering Algorithm

The code generation engine transforms the visual DAG into a linear sequence of notebook cells. The ordering algorithm:

```
Input: nodes[], connections[], theme
Output: NotebookCell[] (ordered, ready for API submission)

Step 1: Topological sort (Kahn's algorithm — see §4.4)
        → ordered node IDs: [roots first, leaves last]

Step 2: Inject pip install cell (conditional)
        IF any node.type === 'pyspark-mlv':
          cells.unshift({ type: 'code', language: 'python', content: '!pip install fmlv' })

Step 3: For each nodeId in topological order:
        → Look up node data (name, type, schema)
        → Look up parent nodes (from connections where targetNodeId === nodeId)
        → Select code template based on node.type
        → Fill template with: node.name, node.schema, parent names, theme-specific columns/data
        → Create NotebookCell { type: 'code', language, content }

Step 4: Return cells[]
```

### 6.2 Code Template Registry

The code generation engine uses a template registry organized by node type. Each template is a function that receives context and returns a code string.

```javascript
/**
 * Code template registry.
 *
 * Structure: TEMPLATES[nodeType] = (context) => string
 *
 * Each template function receives:
 *   - node: { name, schema, type }
 *   - parents: { name, schema }[] (upstream nodes)
 *   - theme: ThemeId
 *   - themeData: { columns: ColumnDef[], sampleRows: any[][] }
 *
 * Returns: Complete cell code string (SQL or Python)
 */
const CODE_TEMPLATES = {
  /**
   * Plain SQL Table — CREATE TABLE + INSERT with themed sample data.
   */
  'sql-table': ({ node, theme, themeData }) => {
    const tableDef = themeData.getTableDefinition(theme, node.name);
    const columns = tableDef.columns;
    const rows = tableDef.sampleRows;

    const columnDefs = columns.map(c => `    ${c.name} ${c.sqlType}`).join(',\n');
    const rowValues = rows.map(row =>
      `    (${row.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ')})`
    ).join(',\n');

    return `%%sql
CREATE TABLE IF NOT EXISTS ${node.schema}.${node.name} (
${columnDefs}
);
INSERT INTO ${node.schema}.${node.name} VALUES
${rowValues};`;
  },

  /**
   * SQL MLV — CREATE MATERIALIZED LAKE VIEW with SELECT from parents.
   * Note: MATERIALIZED LAKE VIEW, NOT MATERIALIZED VIEW (Fabric-specific).
   */
  'sql-mlv': ({ node, parents, theme, themeData }) => {
    if (parents.length === 0) {
      return `%%sql
-- WARNING: MLV "${node.name}" has no parent connections.
-- Connect a source table or another MLV as input.
CREATE MATERIALIZED LAKE VIEW ${node.schema}.${node.name} AS
SELECT 1 AS placeholder;`;
    }

    if (parents.length === 1) {
      const parent = parents[0];
      return `%%sql
CREATE MATERIALIZED LAKE VIEW ${node.schema}.${node.name} AS
SELECT *
FROM ${parent.schema}.${parent.name};`;
    }

    // Multiple parents: JOIN pattern
    const primary = parents[0];
    const joins = parents.slice(1).map((p, i) => {
      const alias = String.fromCharCode(98 + i); // b, c, d, ...
      return `JOIN ${p.schema}.${p.name} ${alias} ON a.id = ${alias}.id`;
    }).join('\n');

    return `%%sql
CREATE MATERIALIZED LAKE VIEW ${node.schema}.${node.name} AS
SELECT a.*
FROM ${primary.schema}.${primary.name} a
${joins};`;
  },

  /**
   * PySpark MLV — @fmlv.materialized_lake_view decorator with DataFrame.
   */
  'pyspark-mlv': ({ node, parents, theme, themeData }) => {
    const tableDef = themeData.getTableDefinition(theme, node.name);
    const columns = tableDef?.columns ?? [
      { name: 'id', sparkType: 'IntegerType', nullable: false },
      { name: 'name', sparkType: 'StringType', nullable: true },
      { name: 'value', sparkType: 'DecimalType', nullable: true },
    ];
    const rows = tableDef?.sampleRows ?? [];

    const imports = [
      'import fmlv',
      'from pyspark.sql.types import StructType, StructField, ' +
        [...new Set(columns.map(c => c.sparkType))].join(', '),
      'from datetime import datetime',
    ].join('\n');

    const schemaFields = columns.map(c =>
      `        StructField("${c.name}", ${c.sparkType}(), ${c.nullable})`
    ).join(',\n');

    const dataRows = rows.length > 0
      ? rows.map(r => `        (${r.map(v => typeof v === 'string' ? `"${v}"` : v).join(', ')})`).join(',\n')
      : '        (1, "sample_1", 100.00)';

    const funcName = node.name.replace(/[^a-z0-9_]/g, '_');

    return `${imports}

@fmlv.materialized_lake_view(name="${node.schema}.${node.name}")
def ${funcName}():
    schema = StructType([
${schemaFields}
    ])
    data = [
${dataRows}
    ]
    df = spark.createDataFrame(data, schema=schema)
    return df`;
  },
};
```

### 6.3 Theme Data Definitions

Each theme defines column schemas and 10 sample rows per table name. The theme data module exports a lookup function.

```javascript
/**
 * Theme data structure — 6 themes × ~5 table templates each.
 *
 * Each table template defines:
 *   - columns: [{ name, sqlType, sparkType, nullable }]
 *   - sampleRows: [[value, value, ...], ...] (10 rows)
 *
 * Table templates are keyed by common names. If a node name
 * doesn't match any template key, a generic fallback is used.
 */
const THEME_DATA = {
  ecommerce: {
    orders:     { columns: [...], sampleRows: [...] },
    customers:  { columns: [...], sampleRows: [...] },
    products:   { columns: [...], sampleRows: [...] },
    categories: { columns: [...], sampleRows: [...] },
    reviews:    { columns: [...], sampleRows: [...] },
  },
  sales: {
    leads:      { columns: [...], sampleRows: [...] },
    campaigns:  { columns: [...], sampleRows: [...] },
    deals:      { columns: [...], sampleRows: [...] },
    accounts:   { columns: [...], sampleRows: [...] },
    activities: { columns: [...], sampleRows: [...] },
  },
  iot: {
    devices:    { columns: [...], sampleRows: [...] },
    readings:   { columns: [...], sampleRows: [...] },
    alerts:     { columns: [...], sampleRows: [...] },
    locations:  { columns: [...], sampleRows: [...] },
    thresholds: { columns: [...], sampleRows: [...] },
  },
  hr: {
    employees:   { columns: [...], sampleRows: [...] },
    departments: { columns: [...], sampleRows: [...] },
    payroll:     { columns: [...], sampleRows: [...] },
    attendance:  { columns: [...], sampleRows: [...] },
    reviews:     { columns: [...], sampleRows: [...] },
  },
  finance: {
    transactions: { columns: [...], sampleRows: [...] },
    accounts:     { columns: [...], sampleRows: [...] },
    invoices:     { columns: [...], sampleRows: [...] },
    payments:     { columns: [...], sampleRows: [...] },
    budgets:      { columns: [...], sampleRows: [...] },
  },
  healthcare: {
    patients:      { columns: [...], sampleRows: [...] },
    appointments:  { columns: [...], sampleRows: [...] },
    prescriptions: { columns: [...], sampleRows: [...] },
    labs:          { columns: [...], sampleRows: [...] },
    providers:     { columns: [...], sampleRows: [...] },
  },
};

/**
 * Get table definition for a node name within a theme.
 * Falls back to generic table definition if name doesn't match.
 */
function getTableDefinition(theme, nodeName) {
  const themeData = THEME_DATA[theme];
  if (!themeData) return GENERIC_TABLE_DEF;
  return themeData[nodeName] ?? GENERIC_TABLE_DEF;
}

const GENERIC_TABLE_DEF = {
  columns: [
    { name: 'id', sqlType: 'INT', sparkType: 'IntegerType', nullable: false },
    { name: 'name', sqlType: 'STRING', sparkType: 'StringType', nullable: true },
    { name: 'value', sqlType: 'DECIMAL(10,2)', sparkType: 'DecimalType', nullable: true },
    { name: 'created_at', sqlType: 'TIMESTAMP', sparkType: 'TimestampType', nullable: true },
  ],
  sampleRows: [
    [1, 'sample_1', 100.00, '2024-01-01T00:00:00'],
    [2, 'sample_2', 200.00, '2024-01-02T00:00:00'],
    // ... 10 rows total
  ],
};
```

### 6.4 Cell Assembly Pipeline

The complete pipeline that transforms a DAG into notebook cells:

```javascript
/**
 * Generate notebook cells from wizard state.
 *
 * @param {WizardState} state — Full wizard state
 * @param {string[]} sortedNodeIds — Topologically sorted node IDs (from §4.4)
 * @returns {NotebookCell[]} — Ordered cells for notebook API
 */
function generateNotebookCells(state, sortedNodeIds) {
  const cells = [];
  const graph = new DagGraph(state.nodes, state.connections);
  const nodeMap = new Map(state.nodes.map(n => [n.id, n]));

  // Step 1: PySpark dependency cell (conditional)
  const hasPySpark = state.nodes.some(n => n.type === 'pyspark-mlv');
  if (hasPySpark) {
    cells.push({
      type: 'code',
      language: 'python',
      content: '!pip install fmlv',
      metadata: { cellType: 'dependency', nodeId: null },
    });
  }

  // Step 2: Generate cells in topological order
  for (const nodeId of sortedNodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;

    // Get parent nodes for this node
    const parentIds = [...graph.getParents(nodeId)];
    const parents = parentIds.map(pid => nodeMap.get(pid)).filter(Boolean);

    // Select and fill template
    const templateFn = CODE_TEMPLATES[node.type];
    const content = templateFn({
      node: { name: node.name, schema: node.schema, type: node.type },
      parents: parents.map(p => ({ name: p.name, schema: p.schema })),
      theme: state.theme,
      themeData: { getTableDefinition },
    });

    const language = node.type === 'pyspark-mlv' ? 'python' : 'sql';

    cells.push({
      type: 'code',
      language,
      content,
      metadata: { cellType: node.type, nodeId: node.id, nodeName: node.name },
    });
  }

  return cells;
}
```

### 6.5 Code Preview vs Execution Payload

The same `generateNotebookCells()` function serves both consumers, but the output is formatted differently:

| Aspect | Code Preview (C08) | Execution Payload (C10) |
|--------|-------------------|------------------------|
| **Consumer** | CodePreviewPanel | ExecutionPipeline → Fabric API |
| **Trigger** | User clicks Refresh button | User clicks "Lock In & Create" |
| **Format** | Concatenated string with cell separators | Array of cell objects for `updateDefinition` API |
| **Syntax highlighting** | Yes (token-level HTML spans) | No (raw text) |
| **Line numbers** | Yes | No |
| **Stale indicator** | Yes (shows warning if DAG changed since last refresh) | N/A (always fresh — generated at execution time) |
| **Error handling** | Show inline error in preview panel | Abort execution with validation error |

```javascript
// Preview format (for CodePreviewPanel)
function formatForPreview(cells) {
  return cells.map((cell, i) => {
    const header = `# ── Cell ${i + 1}: ${cell.metadata?.nodeName ?? 'dependency'} ──`;
    return `${header}\n${cell.content}`;
  }).join('\n\n');
}

// Execution format (for Fabric updateDefinition API)
function formatForExecution(cells) {
  return cells.map(cell => ({
    source: cell.content,
    cell_type: 'code',
    metadata: {
      language: cell.language === 'sql' ? 'sparksql' : 'python',
    },
    outputs: [],
    execution_count: null,
  }));
}
```

---

## 7. Memory Management & Lifecycle

### 7.1 Component Creation/Destruction Lifecycle

The wizard follows a strict creation → active → destroyed lifecycle. Components are not recycled — they are created fresh each time the wizard opens.

```
Wizard Opens
│
├─ C01.open()
│   ├─ Create overlay + dialog DOM (document.body.appendChild)
│   ├─ Create WizardState object
│   ├─ Create WizardEventBus
│   ├─ Create ALL page components:
│   │   ├─ new InfraSetupPage(state, eventBus, apiClient)
│   │   ├─ new ThemeSchemaPage(state, eventBus)
│   │   ├─ new DagCanvas(state, eventBus)
│   │   ├─ new NodePalette(state, eventBus, dagCanvas)
│   │   ├─ new ConnectionManager(state, eventBus, dagCanvas)
│   │   ├─ new CodePreviewPanel(state, eventBus, dagCanvas)
│   │   ├─ new ReviewSummary(state, eventBus)
│   │   ├─ new ExecutionPipeline(state, eventBus, apiClient)
│   │   ├─ new FloatingBadge(state, eventBus) ← created but hidden
│   │   ├─ new TemplateManager(state, eventBus, apiClient)
│   │   ├─ new AutoLayoutEngine()
│   │   └─ new UndoRedoManager(eventBus)
│   │
│   ├─ Wire event listeners (keyboard shortcuts, window resize)
│   ├─ Activate Page 0 (InfraSetupPage)
│   └─ Play entrance animation
│
Wizard Active (user interacts)
│
│ [Page transitions: deactivate current → animate → activate next]
│ [Minimize: hide dialog, show FloatingBadge]
│ [Restore: hide FloatingBadge, show dialog]
│
Wizard Closes
│
├─ C01.destroy()
│   ├─ Deactivate current page
│   ├─ Destroy ALL child components (in reverse creation order):
│   │   ├─ undoRedoManager.destroy()  — clears command stacks
│   │   ├─ autoLayoutEngine.destroy() — (no-op, stateless)
│   │   ├─ templateManager.destroy()  — closes any open dialogs
│   │   ├─ floatingBadge.destroy()    — removes DOM element
│   │   ├─ executionPipeline.destroy() — cancels active timers
│   │   ├─ reviewSummary.destroy()    — removes DOM
│   │   ├─ codePreviewPanel.destroy() — removes DOM
│   │   ├─ connectionManager.destroy() — removes SVG paths
│   │   ├─ nodePalette.destroy()      — removes DOM
│   │   ├─ dagCanvas.destroy()        — removes SVG element + all nodes
│   │   ├─ themeSchemaPage.destroy()  — removes DOM
│   │   └─ infraSetupPage.destroy()   — removes DOM
│   │
│   ├─ eventBus.destroy()            — clears all listener maps
│   ├─ Remove keyboard listeners (document.removeEventListener)
│   ├─ Remove window resize listener
│   ├─ Remove dialog DOM from document.body
│   ├─ Remove overlay DOM from document.body
│   ├─ Null out all component references (aid GC)
│   └─ Set static flag: InfraWizardDialog._instance = null
```

### 7.2 Event Listener Cleanup Strategy

Every component follows this pattern for listener management:

```javascript
class SomeComponent {
  constructor(state, eventBus) {
    /** @type {Function[]} — Unsubscribe functions for event bus listeners */
    this._unsubscribers = [];

    /** @type {Array<[Element, string, Function]>} — DOM listener records */
    this._domListeners = [];
  }

  _addBusListener(event, handler) {
    const unsub = this._eventBus.on(event, handler);
    this._unsubscribers.push(unsub);
  }

  _addDomListener(element, event, handler, options) {
    element.addEventListener(event, handler, options);
    this._domListeners.push([element, event, handler, options]);
  }

  destroy() {
    // 1. Unsubscribe all event bus listeners
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];

    // 2. Remove all DOM listeners
    for (const [el, evt, fn, opts] of this._domListeners) {
      el.removeEventListener(evt, fn, opts);
    }
    this._domListeners = [];

    // 3. Remove owned DOM elements
    this._el?.remove();
    this._el = null;
  }
}
```

### 7.3 SVG DOM Cleanup on Canvas Operations

When nodes or connections are removed, their SVG elements are immediately removed from the DOM:

```javascript
// Node removal — remove SVG <g> group and all children
_removeNodeElement(nodeId) {
  const el = this._svgEl.querySelector(`[data-node-id="${nodeId}"]`);
  if (el) el.remove();  // Removes <g> + all child SVG/foreignObject elements
}

// Connection removal — remove SVG <path> elements (visual + hit area)
removeConnectionElement(connectionId) {
  const els = this._svgEl.querySelectorAll(`[data-connection-id="${connectionId}"]`);
  els.forEach(el => el.remove());
}
```

**No element pooling.** With max 100 nodes, the cost of `document.createElementNS()` is negligible (<0.5ms per node). Pooling adds complexity without measurable benefit at this scale.

### 7.4 Undo Stack Memory Budget

The UndoRedoManager limits memory consumption through two mechanisms:

1. **Stack depth limit: 50 commands.** When the undo stack exceeds 50, the oldest command is silently discarded (shift from front).

2. **Per-command memory analysis:**

| Command Type | Typical Memory | Worst Case |
|-------------|---------------|------------|
| `AddNodeCommand` | ~200 bytes (node data snapshot) | ~300 bytes |
| `RemoveNodeCommand` | ~200 bytes + ~100 bytes per cascaded connection | ~5 KB (node with 50 connections) |
| `MoveNodeCommand` | ~80 bytes (before/after x,y) | ~80 bytes |
| `RenameNodeCommand` | ~100 bytes (before/after name) | ~200 bytes |
| `ChangeTypeCommand` | ~60 bytes (before/after type enum) | ~60 bytes |
| `ChangeSchemaCommand` | ~60 bytes (before/after schema enum) | ~60 bytes |
| `AddConnectionCommand` | ~100 bytes (connection data) | ~100 bytes |
| `RemoveConnectionCommand` | ~100 bytes (connection data) | ~100 bytes |
| `AutoLayoutCommand` | ~80 bytes per node (before/after positions) | ~8 KB (100 nodes) |
| `BatchCommand` | Sum of children | ~10 KB (multi-select delete of 20 nodes) |

**Total worst-case memory: 50 commands × ~10 KB = ~500 KB.** This is negligible.

### 7.5 Template Cache Management

`TemplateManager` (C12) maintains a client-side cache of the template list to avoid redundant backend calls:

```javascript
class TemplateManager {
  constructor(state, eventBus, apiClient) {
    /** Cached template list from last fetch. null = not fetched. */
    this._templateCache = null;

    /** Timestamp of last cache refresh */
    this._cacheTimestamp = 0;

    /** Cache TTL: 30 seconds (templates change infrequently) */
    this._cacheTTL = 30_000;
  }

  async _getTemplates() {
    const now = Date.now();
    if (this._templateCache && (now - this._cacheTimestamp) < this._cacheTTL) {
      return this._templateCache;
    }
    const response = await this._api._fabricGet('/api/templates/list');
    this._templateCache = response.templates;
    this._cacheTimestamp = now;
    return this._templateCache;
  }

  _invalidateCache() {
    this._templateCache = null;
    this._cacheTimestamp = 0;
  }
}
```

### 7.6 Garbage Collection on Wizard Close

When `InfraWizardDialog.destroy()` runs, the following GC-preparation steps ensure no memory leaks:

```javascript
destroy() {
  // 1. Stop execution timers (if any)
  this._executionPipeline?.destroy();  // clears setInterval for step timers

  // 2. Destroy all children (removes DOM listeners, event bus subscriptions)
  this._children.forEach(child => child.destroy());
  this._children = [];

  // 3. Destroy event bus (clears all listener Maps)
  this._eventBus.destroy();
  this._eventBus = null;

  // 4. Clear state object references
  this._state.nodes = [];
  this._state.connections = [];
  this._state.execution = null;
  this._state = null;

  // 5. Remove DOM from body (releases DOM tree for GC)
  this._overlayEl?.remove();
  this._dialogEl?.remove();
  this._overlayEl = null;
  this._dialogEl = null;

  // 6. Remove document-level listeners
  document.removeEventListener('keydown', this._keydownHandler);
  window.removeEventListener('resize', this._resizeHandler);

  // 7. Clear singleton reference
  InfraWizardDialog._instance = null;
}
```

**Post-destroy memory profile:** The entire wizard (14 components, up to 100 nodes, undo stack, template cache) should be fully GC-eligible after `destroy()`. No lingering references, no orphaned closures, no detached DOM trees.

---

## 8. Error Architecture

### 8.1 Error Classification

All errors in the wizard fall into four categories, each with distinct handling:

| Category | Examples | Severity | User-Facing? | Recovery |
|----------|----------|----------|-------------|----------|
| **Validation** | Empty workspace name, MLV with no parents, duplicate names | WARNING | Yes (inline) | Fix the field |
| **Runtime** | Canvas render failure, code gen template error, undo corruption | ERROR | Yes (toast) | Retry operation or reload wizard |
| **Network** | Fetch timeout, 500 from Fabric API, CORS block, offline | ERROR | Yes (step error panel) | Retry from failed step |
| **API** | 409 workspace name conflict, 403 insufficient permissions, 429 rate limit | ERROR | Yes (step error panel) | Fix conflict/permissions, retry |

### 8.2 Error Propagation

Errors originate in child components and propagate upward through the event bus and callback returns:

```
Error Origin                          Surface to User
────────────                          ───────────────
Field validator (C02/C03)        →    Inline error text below field
  └─ emit 'setup:validation-changed'  →    Next button disabled + tooltip

Canvas operation (C04/C06/C07)   →    Toast notification (2.5s auto-dismiss)
  └─ console.error() for debugging     →    No modal, no disruption

Code generation (C08)            →    Error panel inside CodePreviewPanel
  └─ emit 'preview:error'             →    Red banner: "Code generation failed: ..."

Connection validation (C07)      →    Visual feedback on canvas
  └─ emit 'connection:rejected'        →    Red flash on target port + tooltip

Execution API call (C10)         →    Step error panel (expandable)
  └─ emit 'execution:step-failed'     →    Error message + HTTP status + response body
  └─ Retry button visible              →    "Retry from Step N" affordance
  └─ Rollback option visible           →    "Rollback Created Resources" button

Network failure (C10/C02)        →    Toast + retry affordance
  └─ navigator.onLine check            →    "You appear to be offline" toast
  └─ Timeout after 30s                 →    "Request timed out — check network"
```

### 8.3 Error Boundary Per Component

Each component wraps its critical operations in try/catch to prevent cascading failures:

```javascript
/**
 * Error boundary pattern — used in every component method that
 * interacts with external data or the DOM.
 *
 * Principle: A failure in one component (e.g., code preview)
 * must NEVER crash the entire wizard. The failing component
 * degrades gracefully; other components continue working.
 */

// In CodePreviewPanel:
_regenerateCode() {
  try {
    this._state.generationStatus = 'generating';
    const cells = generateNotebookCells(this._wizardState, sortedNodeIds);
    this._displayCode(cells);
    this._state.generationStatus = 'idle';
  } catch (err) {
    console.error('[CodePreviewPanel] Code generation failed:', err);
    this._state.generationStatus = 'error';
    this._state.generationError = err.message;
    this._showError(`Code generation failed: ${err.message}`);
    this._eventBus.emit('preview:error', { error: err.message });
    // Panel shows error state — canvas continues working normally
  }
}

// In DagCanvas (node rendering):
_renderNode(nodeData) {
  try {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    // ... SVG construction ...
    this._nodesLayer.appendChild(group);
  } catch (err) {
    console.error(`[DagCanvas] Failed to render node ${nodeData.id}:`, err);
    // Skip this node's rendering — other nodes unaffected
    // The node data is still in state.nodes[] and will be retried on next render
  }
}

// In ExecutionPipeline (API calls):
async _executeStep(step, context, artifacts) {
  try {
    step.status = 'running';
    step.startedAt = Date.now();
    this._renderStep(step);
    this._eventBus.emit('execution:step-started', { stepIndex: step.index, stepId: step.id, label: step.label });

    const result = await this._apiCallForStep(step, context, artifacts);

    step.status = 'done';
    step.completedAt = Date.now();
    step.durationMs = step.completedAt - step.startedAt;
    step.detail = JSON.stringify(result, null, 2);
    this._renderStep(step);
    this._eventBus.emit('execution:step-completed', { stepIndex: step.index, stepId: step.id, durationMs: step.durationMs, detail: step.detail });

    return result;
  } catch (err) {
    step.status = 'failed';
    step.completedAt = Date.now();
    step.durationMs = step.completedAt - step.startedAt;
    step.error = err.message;

    const executionError = {
      stepId: step.id,
      message: err.message,
      httpStatus: err.status ?? null,
      responseBody: err.body ?? null,
      canRetry: this._isRetryable(err),
    };

    this._renderStep(step);
    this._eventBus.emit('execution:step-failed', { stepIndex: step.index, stepId: step.id, error: executionError });
    throw err;  // Propagate to pipeline orchestrator
  }
}
```

### 8.4 Global Error Handler

A global error handler catches any uncaught exceptions within the wizard context:

```javascript
/**
 * Global wizard error handler.
 * Attached as window.onerror + window.onunhandledrejection
 * during wizard open, removed on wizard close.
 */
_attachGlobalErrorHandler() {
  this._originalOnError = window.onerror;
  this._originalOnRejection = window.onunhandledrejection;

  window.onerror = (message, source, lineno, colno, error) => {
    if (this._isWizardError(source)) {
      console.error('[InfraWizard] Uncaught error:', error);
      this._showErrorToast(`Unexpected error: ${message}`);
      return true;  // Prevent default browser error UI
    }
    // Not a wizard error — pass through to original handler
    return this._originalOnError?.(message, source, lineno, colno, error);
  };

  window.onunhandledrejection = (event) => {
    console.error('[InfraWizard] Unhandled promise rejection:', event.reason);
    this._showErrorToast(`Unexpected error: ${event.reason?.message ?? 'Unknown'}`);
  };
}

_detachGlobalErrorHandler() {
  window.onerror = this._originalOnError;
  window.onunhandledrejection = this._originalOnRejection;
}
```

### 8.5 Recovery Patterns

| Error Scenario | Recovery Pattern | User Action |
|---------------|-----------------|-------------|
| **Workspace name conflict (409)** | Show error on Step 1, allow user to go back and rename | Click Back to Page 0, change name, retry |
| **Capacity permission denied (403)** | Show error with details, suggest checking permissions | User contacts admin, then retries |
| **Lakehouse creation failed** | Rollback workspace creation, show error | Click "Retry" or "Rollback" |
| **Notebook write failed** | Retry from current step (workspace + lakehouse already created) | Click "Retry from Step 5" |
| **Notebook run timeout** | Show warning — resources created, notebook exists but not run | User can manually run notebook in Fabric |
| **Network offline** | Show offline banner, disable all API calls, queue retry | Wait for connectivity, click retry |
| **Template load corruption** | Show validation error, refuse to load, suggest deleting template | Delete corrupt template, re-create |
| **Canvas render error** | Skip failed node render, show toast, log error | Reload wizard (close + re-open) |
| **Code generation error** | Show error in preview panel, highlight problematic node | Fix node configuration, click Refresh |
| **Undo stack corruption** | Clear undo stack, show toast | Undo history lost, continue editing |

**Rollback Strategy (Execution Pipeline):**

```javascript
/**
 * Rollback created resources on execution failure.
 *
 * Rollback order is REVERSE of creation order:
 *   notebook → lakehouse → capacity-assignment → workspace
 *
 * Best-effort: if a rollback step fails, log the error and continue.
 * Show user which resources were cleaned up and which remain orphaned.
 */
async _rollback(createdResources) {
  this._state.execution.status = 'rolling-back';
  this._eventBus.emit('execution:rollback-started', { resources: [...createdResources] });

  const cleaned = [];
  const failed = [];

  // Reverse order
  for (const resource of [...createdResources].reverse()) {
    try {
      switch (resource.type) {
        case 'notebook':
          await this._api.deleteNotebook(resource.workspaceId, resource.id);
          break;
        case 'lakehouse':
          await this._api.deleteLakehouse(resource.workspaceId, resource.id);
          break;
        case 'workspace':
          await this._api.deleteWorkspace(resource.id);
          break;
        // capacity-assignment: no delete API — assignment is automatic
      }
      cleaned.push(resource.id);
    } catch (err) {
      console.error(`[Rollback] Failed to delete ${resource.type} ${resource.id}:`, err);
      failed.push(resource.id);
    }
  }

  this._eventBus.emit('execution:rollback-completed', { cleaned, failed });

  if (failed.length > 0) {
    this._showRollbackWarning(failed);
  }
}
```

---

## 9. Performance Budget

### 9.1 Target Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Wizard first paint** | <200ms | Time from `wizard.open()` to dialog visible |
| **Page transition** | 350ms (animation) + <50ms (setup) | Time from Next click to new page interactive |
| **Node add** | <5ms | Time from drop event to node visible on canvas |
| **Node drag (60fps)** | <8ms/frame | Frame budget during node drag |
| **Connection draw (60fps)** | <4ms/frame | Frame budget during connection preview |
| **Zoom/pan (60fps)** | <2ms/frame | Frame budget during scroll/drag |
| **Auto-layout compute** | <50ms (100 nodes) | Dagre computation time |
| **Auto-layout animate** | 300ms | Staggered position animation |
| **Code generation** | <100ms (100 nodes) | Time to generate all cells |
| **Template load** | <200ms | Time from load click to canvas populated |
| **Memory ceiling** | <15MB | Total wizard memory footprint (DOM + JS heap) |
| **Animation fps** | 60fps | All animations (transitions, drag, zoom) |

### 9.2 Component-Level Budgets

| Component | Max DOM Nodes | Max Event Listeners | Max Memory |
|-----------|--------------|--------------------|-----------:|
| **C01** InfraWizardDialog | 50 (chrome) | 15 (keyboard, resize, click) | 1 KB |
| **C02** InfraSetupPage | 30 (form fields) | 12 (input, blur, change) | 5 KB (capacity list) |
| **C03** ThemeSchemaPage | 25 (cards + toggles) | 10 (click) | 1 KB |
| **C04** DagCanvas | 10 (SVG structure) + 100×6 (nodes) = 610 | 8 (wheel, pointer, keyboard) | 50 KB (SVG DOM) |
| **C05** NodePalette | 15 (cards + counter) | 8 (drag, click, keyboard) | 1 KB |
| **C06** DagNode (per instance) | 6 (SVG group + foreignObject + ports) | 4 (click, drag, hover) | 0.5 KB |
| **C07** ConnectionManager | 500 (max connection paths) | 3 (hover, click) | 20 KB (path data) |
| **C08** CodePreviewPanel | 50 (code lines + chrome) | 5 (click, resize, scroll) | 30 KB (generated code) |
| **C09** ReviewSummary | 80 (summary cards + mini-DAG) | 6 (click) | 5 KB |
| **C10** ExecutionPipeline | 40 (step rows + logs) | 8 (click, expand) | 10 KB (log text) |
| **C11** FloatingBadge | 5 (pill elements) | 2 (click, hover) | 0.5 KB |
| **C12** TemplateManager | 30 (dialog + list items) | 6 (click, input) | 5 KB (cache) |
| **C13** AutoLayoutEngine | 0 (no DOM) | 0 (no listeners) | 2 KB (transient) |
| **C14** UndoRedoManager | 0 (no DOM) | 2 (keyboard shortcuts) | 100 KB (50 commands) |
| **Total (max)** | ~1,500 | ~95 | ~230 KB |

### 9.3 Critical Path Optimization

The critical path is the sequence of operations that the user perceives as latency. These MUST be fast:

```
┌─────────────────────────────────────────────────────┐
│ CRITICAL PATH (must be <200ms total)                │
│                                                     │
│ 1. wizard.open() → Create DOM (30ms)               │
│ 2. Append to body + style calc (20ms)              │
│ 3. Entrance animation start (0ms — CSS triggers)   │
│ 4. Load capacities (async — does NOT block paint)   │
│ 5. Focus first field (5ms)                         │
│                                                     │
│ Total to first paint: ~50ms                        │
│ (animation runs for additional 500ms but UI is      │
│  interactive immediately)                           │
└─────────────────────────────────────────────────────┘
```

**What MUST be fast (synchronous path):**
1. Dialog DOM creation and append: <30ms
2. SVG canvas initialization (Page 2): <20ms
3. Node creation from drop: <5ms
4. Connection creation from port-drag: <3ms
5. Zoom/pan transform update: <2ms

**What CAN be async/lazy (off critical path):**
1. Capacity list fetch: starts on Page 0 mount, renders when complete
2. Code generation: on-demand only (Refresh click)
3. Auto-layout computation: user-triggered, shows loading state
4. Template list fetch: starts on template dialog open
5. Mini-DAG rendering on review page: renders after page transition animation

### 9.4 Lazy Loading Strategy

Components are instantiated eagerly (at wizard open) but render lazily (only when their page activates):

```javascript
/**
 * Lazy rendering strategy:
 *
 * Phase 1 — Wizard open (instant):
 *   - Create ALL component instances (JS objects, no DOM)
 *   - Wire event bus subscriptions
 *
 * Phase 2 — Page activation (lazy):
 *   - Component.activate() creates its DOM elements
 *   - DOM is appended to the page container
 *   - First activation = full render
 *   - Subsequent activations = re-read state, update existing DOM
 *
 * Phase 3 — Page deactivation (cleanup):
 *   - Component.deactivate() pauses animations, unbinds shortcuts
 *   - DOM remains in memory (not removed) for instant re-activation
 *   - DOM IS removed only on wizard.destroy()
 */

// Example: DagCanvas lazy initialization
class DagCanvas {
  constructor(state, eventBus) {
    this._state = state;
    this._eventBus = eventBus;
    this._initialized = false;  // DOM not yet created
    this._svgEl = null;
  }

  activate() {
    if (!this._initialized) {
      this._initializeSVG();    // Create SVG DOM (only once)
      this._initialized = true;
    }
    this._bindKeyboardShortcuts();
    this._updateFromState();    // Re-read state (schemas may have changed on Page 1)
    this._applyViewportTransform();
  }

  deactivate() {
    this._unbindKeyboardShortcuts();
    this._closeAllPopovers();
  }
}
```

**What is NOT lazy loaded:**
- `WizardEventBus` — created immediately (near-zero cost)
- `WizardState` — created immediately (single object)
- `UndoRedoManager` — created immediately (needs to be ready for any page)
- `AutoLayoutEngine` — stateless, created immediately

---

## 10. Testing Architecture

### 10.1 Unit Test Strategy Per Component

Every component gets a dedicated test file in `tests/frontend/infra-wizard/`. Tests run via the existing test infrastructure (`make test`).

| Component | Test File | Key Test Areas | Est. Tests |
|-----------|-----------|----------------|-----------|
| **C01** InfraWizardDialog | `test-infra-wizard-dialog.js` | Open/close lifecycle, page navigation, stepper state, minimize/restore, focus trap, escape handling, singleton enforcement | 25 |
| **C02** InfraSetupPage | `test-infra-setup-page.js` | Field validation (workspace name, lakehouse name), auto-name sync, capacity dropdown population, manual edit detection | 15 |
| **C03** ThemeSchemaPage | `test-theme-schema-page.js` | Theme card selection (single select), schema toggle (dbo locked), state propagation | 12 |
| **C04** DagCanvas | `test-dag-canvas.js` | SVG initialization, node add/remove, coordinate conversion, zoom limits (0.25-4.0), pan bounds, context menu, selection (single/multi/marquee), drop target | 30 |
| **C05** NodePalette | `test-node-palette.js` | Drag start/end events, quick-add (double-click), node counter, disabled state at 100 nodes, collapse/expand | 10 |
| **C06** DagNode | `test-dag-node.js` | Rendering (3 types × correct visuals), port visibility, popover open/close, rename validation, type change, schema change, delete | 20 |
| **C07** ConnectionManager | `test-connection-manager.js` | Connection creation, cycle detection (5 graph topologies), self-loop rejection, duplicate rejection, SQL Table target rejection, hit testing, Bezier path computation | 25 |
| **C08** CodePreviewPanel | `test-code-preview-panel.js` | Code generation (all 3 types), topological ordering, multi-parent JOIN, PySpark decorator, pip install cell injection, syntax highlighting tokens | 20 |
| **C09** ReviewSummary | `test-review-summary.js` | Summary card content, node count accuracy, mini-DAG rendering, cross-page validation, edit link navigation | 12 |
| **C10** ExecutionPipeline | `test-execution-pipeline.js` | Step state machine, timer accuracy, retry from failed step, rollback sequence, artifact collection, minimize during execution | 20 |
| **C11** FloatingBadge | `test-floating-badge.js` | Progress text updates, status dot states, click-to-restore, entrance/exit animation triggers, dismiss on completion | 8 |
| **C12** TemplateManager | `test-template-manager.js` | Save with name validation, load with hydration, delete with confirmation, cache invalidation, version compatibility | 15 |
| **C13** AutoLayoutEngine | `test-auto-layout-engine.js` | Dagre layout computation, topological sort (Kahn's), cycle detection, disconnected subgraphs, single node, empty graph, 100-node performance | 18 |
| **C14** UndoRedoManager | `test-undo-redo-manager.js` | Execute/undo/redo for all command types, stack limit (50), redo clear on new action, batch commands, empty stack safety | 15 |
| **Shared** | `test-wizard-event-bus.js` | on/off/emit/once, destroy clears all, error in handler doesn't crash, multiple listeners | 8 |
| **Shared** | `test-wizard-validator.js` | All field validators, all page validators, cross-page validator | 20 |
| **Shared** | `test-code-generation-engine.js` | All 3 template types × 6 themes, multi-parent scenarios, empty DAG, pip install conditional | 25 |
| **Total** | | | **~298** |

### 10.2 Integration Test Scenarios

Integration tests verify multi-component flows end-to-end. These test scenarios exercise the event bus, state propagation, and component coordination.

| # | Scenario | Components Involved | What's Tested |
|---|----------|-------------------|---------------|
| IT-01 | **Full wizard happy path** | C01→C02→C03→C04→C05→C06→C07→C08→C09→C10 | Open wizard → fill Page 0 → select theme + schemas → add 3 nodes with connections → review → execute (mocked APIs) → completion |
| IT-02 | **Schema change cascades to DAG nodes** | C03→C04→C06 | Select bronze+silver on Page 1 → add node with schema=silver → go back to Page 1 → deselect silver → go to Page 2 → verify node reverted to dbo |
| IT-03 | **Template round-trip** | C12→C01→C02→C03→C04 | Create a DAG → save as template → close wizard → open wizard → load template → verify all state restored (nodes, connections, theme, schemas, names) |
| IT-04 | **Undo/redo through node operations** | C04→C06→C07→C14 | Add node → add second node → connect them → undo (connection removed) → undo (second node removed) → redo (second node restored) → redo (connection restored) |
| IT-05 | **Execution failure + retry** | C10→C01→C11 | Start execution → mock Step 3 failure → verify Steps 1-2 show done → retry from Step 3 → verify Steps 1-2 skipped → mock success → verify completion |
| IT-06 | **Minimize during execution** | C01→C10→C11 | Start execution → close dialog (X) → verify FloatingBadge appears → verify execution continues → click badge → verify dialog restores at correct page |
| IT-07 | **100-node limit enforcement** | C04→C05 | Add 100 nodes → verify palette shows disabled state → verify right-click menu "Add Node" is disabled → verify quick-add rejected → remove 1 node → verify palette re-enables |
| IT-08 | **Cycle detection across complex graph** | C04→C07 | Build diamond topology (A→B, A→C, B→D, C→D) → verify all connections accepted → try D→A → verify rejected with 'cycle' reason → try D→B → verify rejected |
| IT-09 | **Code preview accuracy** | C04→C06→C07→C08→C13 | Build 5-node DAG with mixed types → click Refresh → verify cell order matches topological sort → verify SQL Table cells before MLV cells → verify pip install cell present (PySpark node exists) |
| IT-10 | **Dirty detection + close confirmation** | C01→C02 | Open wizard → type in workspace name → press Escape → verify confirmation dialog → cancel → verify wizard still open → confirm → verify wizard closed |

### 10.3 Canvas Interaction Testing Approach

Canvas interactions (drag, zoom, click on SVG elements) require synthetic pointer events:

```javascript
/**
 * Canvas test helper — simulates pointer interactions on the SVG canvas.
 *
 * Usage:
 *   const canvas = new DagCanvas(state, eventBus);
 *   await canvas.init();
 *   const helper = new CanvasTestHelper(canvas);
 *
 *   // Simulate node drop from palette
 *   helper.simulateDrop('sql-table', 200, 150);
 *
 *   // Simulate node drag
 *   helper.simulateNodeDrag('node-1', { fromX: 200, fromY: 150, toX: 400, toY: 300 });
 *
 *   // Simulate connection draw
 *   helper.simulateConnectionDraw('node-1', 'out', 'node-2', 'in');
 *
 *   // Simulate zoom
 *   helper.simulateZoom(1.5, { clientX: 400, clientY: 300 });
 */
class CanvasTestHelper {
  constructor(canvas) {
    this._canvas = canvas;
    this._svg = canvas._svgEl;
  }

  /**
   * Simulate a drop event from the palette onto the canvas.
   */
  simulateDrop(nodeType, clientX, clientY) {
    const dropEvent = new DragEvent('drop', {
      clientX, clientY, bubbles: true,
      dataTransfer: new DataTransfer(),
    });
    dropEvent.dataTransfer.setData('application/x-dag-node-type', nodeType);
    this._svg.dispatchEvent(dropEvent);
  }

  /**
   * Simulate dragging a node from one position to another.
   */
  simulateNodeDrag(nodeId, { fromX, fromY, toX, toY }) {
    const nodeEl = this._svg.querySelector(`[data-node-id="${nodeId}"]`);
    nodeEl.dispatchEvent(new PointerEvent('pointerdown', { clientX: fromX, clientY: fromY, bubbles: true }));
    // Simulate movement in 10 steps for realistic drag
    for (let i = 1; i <= 10; i++) {
      const x = fromX + (toX - fromX) * (i / 10);
      const y = fromY + (toY - fromY) * (i / 10);
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
    }
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: toX, clientY: toY }));
  }

  /**
   * Simulate drawing a connection between two nodes.
   */
  simulateConnectionDraw(sourceNodeId, sourcePort, targetNodeId, targetPort) {
    const sourcePortEl = this._svg.querySelector(
      `[data-node-id="${sourceNodeId}"] [data-port-id="${sourcePort}"]`
    );
    const targetPortEl = this._svg.querySelector(
      `[data-node-id="${targetNodeId}"] [data-port-id="${targetPort}"]`
    );

    const sourceRect = sourcePortEl.getBoundingClientRect();
    const targetRect = targetPortEl.getBoundingClientRect();

    sourcePortEl.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: sourceRect.left + sourceRect.width / 2,
      clientY: sourceRect.top + sourceRect.height / 2,
      bubbles: true,
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.top + targetRect.height / 2,
    }));
    targetPortEl.dispatchEvent(new PointerEvent('pointerup', {
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.top + targetRect.height / 2,
      bubbles: true,
    }));
  }

  /**
   * Simulate scroll-to-zoom at a specific screen position.
   */
  simulateZoom(targetZoom, { clientX, clientY }) {
    const currentZoom = this._canvas._viewport.zoom;
    const delta = (targetZoom - currentZoom) / currentZoom / 0.001;
    this._svg.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -delta,
      clientX, clientY,
      bubbles: true,
    }));
  }
}
```

### 10.4 Mock Data Factories

Test fixtures for consistent, reproducible test data:

```javascript
/**
 * Mock data factories for wizard testing.
 *
 * Usage:
 *   const state = MockFactory.createWizardState();
 *   const node = MockFactory.createNode({ type: 'sql-mlv', name: 'customer_360' });
 *   const graph = MockFactory.createDiamondGraph();
 */
const MockFactory = {
  /**
   * Create a complete WizardState with sensible defaults.
   * Override any field by passing partial state.
   */
  createWizardState(overrides = {}) {
    return {
      workspaceName: 'test_workspace_42',
      workspaceNameManuallyEdited: false,
      capacityId: 'cap-001',
      capacityDisplayName: 'F4 — East US (Running)',
      capacitySku: 'F4',
      capacityRegion: 'East US',
      lakehouseName: 'test_workspace_42_lh',
      lakehouseNameManuallyEdited: false,
      notebookName: 'test_workspace_42_nb',
      notebookNameManuallyEdited: false,
      theme: 'ecommerce',
      schemas: { dbo: true, bronze: false, silver: false, gold: false },
      nodes: [],
      connections: [],
      nextNodeId: 1,
      nextConnectionId: 1,
      viewport: { panX: 0, panY: 0, zoom: 1.0 },
      execution: null,
      currentPage: 0,
      highestVisitedPage: 0,
      createdAt: Date.now(),
      templateName: null,
      templateId: null,
      dirty: false,
      ...overrides,
    };
  },

  /**
   * Create a single DagNodeData with defaults.
   */
  createNode(overrides = {}) {
    const type = overrides.type ?? 'sql-table';
    const id = overrides.id ?? `node-${Math.random().toString(36).slice(2, 8)}`;
    return {
      id,
      name: overrides.name ?? `${type === 'sql-table' ? 'table' : type === 'sql-mlv' ? 'mlv' : 'spark'}_1`,
      type,
      schema: overrides.schema ?? 'dbo',
      x: overrides.x ?? 100,
      y: overrides.y ?? 100,
      width: 180,
      height: 72,
      sequenceNumber: 1,
      createdAt: Date.now(),
      ...overrides,
    };
  },

  /**
   * Create a connection between two nodes.
   */
  createConnection(sourceId, targetId, overrides = {}) {
    return {
      id: overrides.id ?? `conn-${sourceId}-${targetId}`,
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      ...overrides,
    };
  },

  /**
   * Create a diamond-shaped DAG topology:
   *       A (sql-table)
   *      / \
   *     B   C (sql-mlv)
   *      \ /
   *       D (pyspark-mlv)
   */
  createDiamondGraph() {
    const nodes = [
      this.createNode({ id: 'node-a', name: 'orders', type: 'sql-table', x: 300, y: 50 }),
      this.createNode({ id: 'node-b', name: 'order_summary', type: 'sql-mlv', x: 150, y: 200 }),
      this.createNode({ id: 'node-c', name: 'order_details', type: 'sql-mlv', x: 450, y: 200 }),
      this.createNode({ id: 'node-d', name: 'combined_view', type: 'pyspark-mlv', x: 300, y: 350 }),
    ];
    const connections = [
      this.createConnection('node-a', 'node-b'),
      this.createConnection('node-a', 'node-c'),
      this.createConnection('node-b', 'node-d'),
      this.createConnection('node-c', 'node-d'),
    ];
    return { nodes, connections };
  },

  /**
   * Create a linear chain DAG: A → B → C → D
   */
  createLinearChain(length = 4) {
    const types = ['sql-table', 'sql-mlv', 'sql-mlv', 'pyspark-mlv'];
    const nodes = [];
    const connections = [];
    for (let i = 0; i < length; i++) {
      nodes.push(this.createNode({
        id: `node-${i}`,
        name: `step_${i}`,
        type: types[i % types.length],
        x: 300,
        y: 50 + i * 120,
      }));
      if (i > 0) {
        connections.push(this.createConnection(`node-${i-1}`, `node-${i}`));
      }
    }
    return { nodes, connections };
  },

  /**
   * Create a wide fan-out DAG: 1 root → N children
   */
  createFanOut(childCount = 5) {
    const nodes = [this.createNode({ id: 'root', name: 'source', type: 'sql-table', x: 300, y: 50 })];
    const connections = [];
    for (let i = 0; i < childCount; i++) {
      const id = `child-${i}`;
      nodes.push(this.createNode({ id, name: `derived_${i}`, type: 'sql-mlv', x: 100 + i * 150, y: 200 }));
      connections.push(this.createConnection('root', id));
    }
    return { nodes, connections };
  },

  /**
   * Create mock capacity list (for InfraSetupPage tests).
   */
  createCapacityList() {
    return [
      { id: 'cap-001', displayName: 'F4 — East US', sku: 'F4', region: 'East US', state: 'Active' },
      { id: 'cap-002', displayName: 'F8 — West US', sku: 'F8', region: 'West US', state: 'Active' },
      { id: 'cap-003', displayName: 'F2 — North EU', sku: 'F2', region: 'North Europe', state: 'Paused' },
    ];
  },

  /**
   * Create mock API responses for execution pipeline tests.
   */
  createMockApiResponses() {
    return {
      createWorkspace: { id: 'ws-mock-001', displayName: 'test_workspace_42' },
      assignCapacity: { status: 202 },
      createLakehouse: { id: 'lh-mock-001', displayName: 'test_workspace_42_lh' },
      createNotebook: { id: 'nb-mock-001', displayName: 'test_workspace_42_nb' },
      updateDefinition: { status: 200 },
      runNotebook: { id: 'job-mock-001', status: 'Completed' },
    };
  },
};
```

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **Canvas space** | The infinite coordinate system of the SVG canvas. Nodes live here. Unaffected by zoom/pan. |
| **Screen space** | Browser viewport coordinates (clientX/clientY). What the user physically sees. |
| **Viewport** | The window into canvas space defined by zoom + pan. |
| **Command** | A reversible action object (GoF Command pattern) for undo/redo. |
| **DagGraph** | Runtime accessor providing O(1) lookups over the flat node/connection arrays. |
| **Theme** | One of 6 data domains (ecommerce, sales, iot, hr, finance, healthcare) that determines sample data. |
| **Schema** | A Fabric lakehouse schema (dbo, bronze, silver, gold) used as a namespace prefix for tables/views. |
| **MLV** | Materialized Lake View — a Fabric-specific DDL extension. NOT "Materialized View." |
| **LRO** | Long-Running Operation — an async API pattern (HTTP 202) requiring polling. |
| **Kahn's algorithm** | BFS-based topological sort that processes nodes in order of decreasing in-degree. |
| **Dagre** | A JavaScript library implementing the Sugiyama algorithm for layered graph layout. |
| **Sugiyama** | A graph drawing algorithm that arranges DAGs in horizontal layers with minimal edge crossings. |
| **foreignObject** | An SVG element that allows embedding HTML content inside an SVG group. |

## Appendix B: Decision Log

| # | Decision | Alternative Considered | Why This Choice |
|---|----------|----------------------|-----------------|
| D1 | Vanilla SVG (no library) for MVP | JointJS Core | Zero dependency risk, total control, 100 nodes trivial for raw SVG. JointJS is backup if hand-rolled proves too costly. |
| D2 | Custom EventEmitter (not DOM CustomEvent) | DOM CustomEvent | No bubbling overhead, typed payloads, easy destroy(), no collision with existing events |
| D3 | Command pattern (not snapshot) for undo | Full state snapshots | ~100× less memory per undo level, architectural clarity, extensible |
| D4 | Client-orchestrated execution (not SSE) | Server-Sent Events | Simpler — no server state needed. Browser orchestrates sequential fetch() calls. Matches spec requirement. |
| D5 | Single CSS file (not per-component) | CSS-per-component | Build system inlines everything. Single file with .iw-* prefix is simpler and matches existing pattern (deploy.css, workspace.css) |
| D6 | Flat arrays (not adjacency list) for DAG storage | Adjacency list/matrix | Natural JSON serialization, simple CRUD, O(1) amortized array ops, small scale (100 nodes) |
| D7 | Eager instantiation + lazy rendering | Full lazy loading | Event bus subscriptions needed before page is visible. Object creation is cheap; DOM creation is expensive. |
| D8 | 50-level undo limit | Unlimited | Industry standard (Figma, Photoshop). Worst-case 500KB is negligible. |
| D9 | Kahn's algorithm for topological sort | DFS-based sort | BFS approach naturally supports tiebreaking with priority queue. Matches Dagre's internal algorithm. |
| D10 | On-demand code preview (not real-time) | Auto-refresh on every change | Spec requirement. Avoids distracting flicker during rapid editing. User controls when to regenerate. |

## Appendix C: Open Questions

| # | Question | Impact | Resolution Path |
|---|----------|--------|----------------|
| Q1 | Should the wizard support browser tab refresh during execution? | HIGH — orphaned resources risk | Decision: No localStorage persistence for V1. Document as known limitation. |
| Q2 | What happens when capacity list returns empty? | MEDIUM — blocks Page 0 | Show "No capacities available" with link to create capacity (Coming Soon placeholder). |
| Q3 | Should node names auto-update when theme changes? | LOW — UX polish | Decision: No. Node names are user-editable once created. Theme only affects sample data, not names. |
| Q4 | How should the wizard handle very small viewports (<640px width)? | LOW — rare for dev tool | Show "Minimum viewport width required" message. Do not attempt responsive layout for the DAG canvas. |

---

*End of P2 Frontend Architecture — F16 New Infrastructure Wizard*
*Sana, Principal Architect — EDOG Studio*
