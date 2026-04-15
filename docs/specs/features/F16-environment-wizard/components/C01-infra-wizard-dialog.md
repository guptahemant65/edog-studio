# C01 — InfraWizardDialog: Component Deep Spec

> **Component ID:** C01
> **Feature:** F16 — New Infrastructure Wizard
> **Priority:** P1.1
> **Complexity:** HIGH
> **Owner:** Pixel (JS/CSS) + Vex (lifecycle/API integration)
> **Depends On:** P0 (Foundation Research — COMPLETE)
> **Status:** SPEC — DRAFT
> **Design Ref:** Mock `mocks/infra-wizard.html` (CEO-approved visual contract)
> **Reusability:** HIGH — leverages command-palette modal, onboarding overlay, deploy-flow stepper CSS, carousel navigation

---

## 1. Component Overview

### 1.1 Responsibility

InfraWizardDialog is the **modal shell** that contains the entire New Infrastructure Wizard experience. It owns every pixel of the dialog chrome — overlay, container, title bar, stepper, page transitions, footer buttons, minimize/restore — but delegates all page content to child page components (C02–C10).

Think of it as a **window manager** for a 5-page wizard application. It manages the frame; children manage the content.

### 1.2 Component ID & Classification

| Property | Value |
|----------|-------|
| **ID** | `C01-InfraWizardDialog` |
| **CSS Prefix** | `.iw-` (infra-wizard) |
| **JS Class** | `InfraWizardDialog` |
| **File** | `src/frontend/js/infra-wizard.js` |
| **CSS File** | `src/frontend/css/infra-wizard.css` |
| **DOM Mount** | Dynamic — `document.body.appendChild()` (like onboarding overlay) |
| **Z-Index** | `--z-wizard: 500` (above toast at 400, above command palette at 300) |
| **Singleton** | Yes — only one wizard instance can exist at a time |

### 1.3 Responsibility Boundary

**InfraWizardDialog OWNS:**

| Responsibility | Details |
|---------------|---------|
| Modal overlay | Backdrop blur 8px + rgba overlay at 18% opacity |
| Dialog container | 920×680 default, resizable, draggable |
| Title bar | Icon + "New Infrastructure" title + close button |
| Drag hint | 36×4px pill centered above title bar |
| Horizontal stepper | 5 numbered circles with connecting progress lines |
| Step connector fill animations | CSS transition on `scaleX` for connector `.fill` elements |
| Page container | `position: relative` host for absolutely-positioned page slots |
| Page slide transitions | `slideLeft` for forward, `slideRight` for back |
| Footer bar | Back / Next / "Lock In & Create" contextual buttons |
| Wizard state management | Central state object shared with all child pages |
| Step validation gates | Blocks forward navigation until current page validates |
| Minimize-to-FloatingBadge | Animate dialog to badge, create FloatingBadge (C11) |
| Restore-from-FloatingBadge | Destroy badge, animate dialog back |
| Dialog entrance/exit animation | `scale(0.94) translateY(16px)` with spring curve |
| Overlay entrance/exit | `blur(0→8px) + opacity(0→0.18)` over 400ms |
| Concurrent wizard blocking | Rejects `open()` if another wizard is running |
| Escape key handling | Close with confirmation if dirty |
| Focus trap | Tab cycling within dialog boundary |
| Session position/size memory | Remember last size/position for re-open |
| Resize handles | 8px edge / 12px corner hit areas |
| Drag constraints | 48px header minimum visible at viewport edges |

**InfraWizardDialog DOES NOT OWN:**

| Delegated To | Component |
|-------------|-----------|
| Page 1 form fields (workspace, capacity, lakehouse, notebook) | C02 — InfraSetupPage |
| Page 2 theme picker grid + schema toggles | C03 — ThemeSchemaPage |
| Page 3 DAG canvas, nodes, connections, palette | C04–C08 — DagCanvas, NodePalette, DagNode, ConnectionManager, CodePreviewPanel |
| Page 4 review summary + mini-DAG | C09 — ReviewSummary |
| Page 5 execution pipeline steps + log expansion | C10 — ExecutionPipeline |
| Floating badge rendering + progress | C11 — FloatingBadge |
| Template save/load/delete | C12 — TemplateManager |
| Auto-layout algorithm | C13 — AutoLayoutEngine |
| Undo/redo state management | C14 — UndoRedoManager |
| Fabric API calls | `FabricApiClient` (existing, `api-client.js`) |

### 1.4 Parent/Child Tree

```
InfraWizardDialog (C01)          ← THIS SPEC
├── StepperBar                    ← Internal sub-component (not a separate C-number)
│   ├── StepCircle[0..4]
│   └── StepConnector[0..3]
├── PageContainer
│   ├── InfraSetupPage (C02)     ← Page 0
│   ├── ThemeSchemaPage (C03)    ← Page 1
│   ├── DagCanvasPage            ← Page 2 (hosts C04–C08)
│   │   ├── DagCanvas (C04)
│   │   ├── NodePalette (C05)
│   │   ├── DagNode[] (C06)
│   │   ├── ConnectionManager (C07)
│   │   └── CodePreviewPanel (C08)
│   ├── ReviewSummary (C09)      ← Page 3
│   └── ExecutionPipeline (C10)  ← Page 4
├── FooterBar                    ← Internal sub-component
│   ├── BackButton
│   └── NextButton / LockInButton
└── FloatingBadge (C11)          ← Created on minimize, destroyed on restore
```

### 1.5 Integration Points

**How the wizard is opened** (from `WorkspaceExplorer`):

```javascript
// workspace-explorer.js — context menu on workspace
_openInfraWizard() {
  const wizard = new InfraWizardDialog(this._api);
  wizard.onComplete = (result) => {
    this._selectWorkspace(result.workspace);
    this.loadWorkspaces();
  };
  wizard.open();
}
```

Three entry points identified in code audit:
1. **Context menu** on workspace → "Create Infrastructure..." (primary)
2. **Empty state CTA** when no workspaces → "Create your first test environment"
3. **Command palette** → fuzzy match on "infra" / "wizard" / "environment"

---

## 2. Data Model

### 2.1 Wizard State (Central State Object)

The wizard maintains a single state object that all child pages read from and write to. Navigation never clears state. The dialog owns this object; pages receive a reference.

```typescript
/** Central wizard state — owned by InfraWizardDialog, shared with all pages */
interface WizardState {
  // ─── Page 1: Infrastructure Setup ───
  workspaceName: string;                    // e.g. "brave_turing_42"
  workspaceNameManuallyEdited: boolean;     // tracks if user manually typed
  capacityId: string | null;                // selected capacity GUID
  capacityDisplayName: string;              // "F4 — East US (Running)"
  lakehouseName: string;                    // e.g. "brave_turing_42_lh"
  lakehouseNameManuallyEdited: boolean;     // if true, don't auto-sync from workspace name
  notebookName: string;                     // e.g. "brave_turing_42_nb"
  notebookNameManuallyEdited: boolean;

  // ─── Page 2: Theme & Schema ───
  theme: ThemeId | null;                    // 'ecommerce' | 'sales' | 'iot' | 'hr' | 'finance' | 'healthcare'
  schemas: SchemaSet;                       // { dbo: true, bronze: boolean, silver: boolean, gold: boolean }

  // ─── Page 3: DAG Canvas ───
  nodes: DagNodeState[];                    // all nodes on canvas
  connections: ConnectionState[];           // all edges between nodes
  nextNodeId: number;                       // monotonically increasing node ID counter

  // ─── Page 4: Review ───
  // (derived from pages 1–3, no new state)

  // ─── Page 5: Execution ───
  execution: ExecutionState | null;         // null until "Lock In & Create" pressed

  // ─── Meta ───
  createdAt: number;                        // Date.now() when wizard opened
  templateName: string | null;              // if loaded from template
  dirty: boolean;                           // true if any field has been touched
}

type ThemeId = 'ecommerce' | 'sales' | 'iot' | 'hr' | 'finance' | 'healthcare';

interface SchemaSet {
  dbo: true;              // always true, non-removable
  bronze: boolean;
  silver: boolean;
  gold: boolean;
}

interface DagNodeState {
  id: number;                               // unique within wizard session
  name: string;                             // user-editable, e.g. "orders"
  type: 'sql-table' | 'sql-mlv' | 'pyspark-mlv';
  schema: 'dbo' | 'bronze' | 'silver' | 'gold';
  x: number;                                // canvas position (px, relative to canvas origin)
  y: number;
  width: number;                            // measured after render (default: 140)
  height: number;                           // measured after render (default: ~60)
  selected: boolean;
}

interface ConnectionState {
  id: string;                               // `${sourceId}-${targetId}`
  sourceNodeId: number;
  targetNodeId: number;
}

interface ExecutionState {
  status: 'running' | 'completed' | 'failed' | 'rolling-back';
  currentStepIndex: number;                 // 0-based
  steps: ExecutionStep[];
  startedAt: number;                        // Date.now()
  completedAt: number | null;
  error: ExecutionError | null;
  createdResources: CreatedResource[];      // for rollback tracking
}

interface ExecutionStep {
  id: string;                               // 'create-workspace' | 'assign-capacity' | etc.
  label: string;                            // "Create Workspace"
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  detail: string | null;                    // API response summary
  error: string | null;                     // error message if failed
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
  workspaceId: string;                      // all resources belong to one workspace
}
```

### 2.2 Step Definition

```typescript
/** Static step definitions — the 5 wizard pages */
interface StepDefinition {
  index: number;            // 0–4
  id: string;               // 'setup' | 'theme' | 'build' | 'review' | 'deploy'
  label: string;            // Display label for stepper circle
  pageElementId: string;    // DOM id of the page container
  canNavigateBack: boolean; // Can user click this step in stepper to jump back?
  footerConfig: FooterConfig;
}

interface FooterConfig {
  showBack: boolean;
  showNext: boolean;
  nextLabel: string;                // "Next →" | "Lock In & Create ▶"
  nextClass: string;                // "btn-primary" | "btn-create"
  showFooter: boolean;              // false on Page 5 (execution)
}

const STEPS: StepDefinition[] = [
  {
    index: 0, id: 'setup', label: 'Setup',
    pageElementId: 'iw-page-0',
    canNavigateBack: true,
    footerConfig: { showBack: false, showNext: true, nextLabel: 'Next →', nextClass: 'btn-primary', showFooter: true }
  },
  {
    index: 1, id: 'theme', label: 'Theme',
    pageElementId: 'iw-page-1',
    canNavigateBack: true,
    footerConfig: { showBack: true, showNext: true, nextLabel: 'Next →', nextClass: 'btn-primary', showFooter: true }
  },
  {
    index: 2, id: 'build', label: 'Build',
    pageElementId: 'iw-page-2',
    canNavigateBack: true,
    footerConfig: { showBack: true, showNext: true, nextLabel: 'Next →', nextClass: 'btn-primary', showFooter: true }
  },
  {
    index: 3, id: 'review', label: 'Review',
    pageElementId: 'iw-page-3',
    canNavigateBack: true,
    footerConfig: { showBack: true, showNext: true, nextLabel: 'Lock In & Create ▶', nextClass: 'btn-create', showFooter: true }
  },
  {
    index: 4, id: 'deploy', label: 'Deploy',
    pageElementId: 'iw-page-4',
    canNavigateBack: false,
    footerConfig: { showBack: false, showNext: false, nextLabel: '', nextClass: '', showFooter: false }
  },
];
```

### 2.3 Dialog Geometry State

```typescript
/** Tracks dialog position, size, and session memory */
interface DialogGeometry {
  x: number;               // top-left x (px from viewport left)
  y: number;               // top-left y (px from viewport top)
  width: number;           // current width (px)
  height: number;          // current height (px)
  centered: boolean;       // true if dialog hasn't been moved
  maximized: boolean;      // reserved for future
}

const DEFAULT_GEOMETRY: DialogGeometry = {
  x: -1,       // -1 signals "center on open"
  y: -1,
  width: 920,
  height: 680,
  centered: true,
  maximized: false,
};

const MIN_WIDTH = 640;
const MAX_WIDTH_VW = 0.90;    // 90vw
const MIN_HEIGHT = 480;
const MAX_HEIGHT_VH = 0.88;   // 88vh (matches mock)
const DRAG_MARGIN = 48;       // px of header that must remain visible
```

---

## 3. API Surface

### 3.1 Constructor

```javascript
/**
 * @param {FabricApiClient} apiClient — existing api-client.js instance
 * @param {object} [options] — optional configuration
 * @param {WizardState} [options.initialState] — pre-fill state (from template or resume)
 * @param {number} [options.startPage] — page index to open on (default: 0)
 */
constructor(apiClient, options = {})
```

### 3.2 Public Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `open()` | `open(): void` | `void` | Creates DOM, appends to body, plays entrance animation, traps focus. Throws if another wizard is open. |
| `close()` | `close(): void` | `void` | Plays exit animation, removes DOM, releases focus trap. If execution is running, minimizes instead. |
| `minimize()` | `minimize(): void` | `void` | Hides dialog (exit animation), creates FloatingBadge (C11), keeps execution running. |
| `restore()` | `restore(): void` | `void` | Destroys FloatingBadge, shows dialog (entrance animation), restores to last page. |
| `getState()` | `getState(): WizardState` | `WizardState` | Returns read-only snapshot of current wizard state. |
| `goToPage(index)` | `goToPage(index: number): void` | `void` | Navigate to specific page index (0–4). Validates current page first if moving forward. |
| `destroy()` | `destroy(): void` | `void` | Forcefully removes all DOM, cancels timers, removes event listeners. Emergency cleanup. |
| `isOpen()` | `isOpen(): boolean` | `boolean` | Returns `true` if dialog is currently visible (not minimized, not closed). |
| `isMinimized()` | `isMinimized(): boolean` | `boolean` | Returns `true` if dialog is minimized to badge. |
| `isExecuting()` | `isExecuting(): boolean` | `boolean` | Returns `true` if execution pipeline is running. |

### 3.3 Callbacks (Properties)

| Callback | Signature | When Fired |
|----------|-----------|------------|
| `onComplete` | `(result: { workspace: object, lakehouse: object, notebook: object }) => void` | After execution pipeline completes successfully. |
| `onClose` | `() => void` | After dialog is closed (not minimized). |
| `onMinimize` | `() => void` | After dialog is minimized to badge. |
| `onRestore` | `() => void` | After dialog is restored from badge. |
| `onPageChange` | `(fromIndex: number, toIndex: number) => void` | After page transition completes. |
| `onStateChange` | `(state: WizardState) => void` | After any wizard state mutation. |
| `onError` | `(error: { step: string, message: string }) => void` | On execution failure (in addition to in-dialog error UI). |

### 3.4 Static Members

```javascript
/** Singleton guard — tracks the active wizard instance */
static _activeInstance = null;

/** Check if a wizard is currently open or minimized */
static isActive() {
  return InfraWizardDialog._activeInstance !== null;
}

/** Get the active instance (for command palette integration) */
static getActive() {
  return InfraWizardDialog._activeInstance;
}
```

### 3.5 Events Consumed (Listened)

| Event | Source | Handler |
|-------|--------|---------|
| `keydown` (Escape) | `document` | Close/minimize depending on execution state |
| `keydown` (Tab) | Dialog root | Focus trap cycling |
| `keydown` (Ctrl+Enter) | Dialog root | Trigger Next/Create action from any field |
| `keydown` (Alt+←) | Dialog root | Navigate to previous page |
| `keydown` (Alt+→) | Dialog root | Navigate to next page |
| `pointerdown` on title bar | Dialog header | Begin drag |
| `pointermove` | `document` (during drag) | Update dialog position |
| `pointerup` | `document` (during drag) | End drag |
| `pointerdown` on resize edges | Resize hit areas | Begin resize |
| `dblclick` on title bar | Dialog header | Re-center dialog |
| `click` on step circle | Stepper | Jump to completed step |
| `click` on Next button | Footer | `_handleNext()` |
| `click` on Back button | Footer | `_handleBack()` |
| `click` on Close button | Title bar | `_handleClose()` |
| `click` on overlay | Overlay | Blocked — no action (click-outside does NOT close) |
| `resize` | `window` | Constrain dialog position within viewport |

### 3.6 Events Emitted to Child Pages

The dialog communicates with child pages via direct method calls on page component instances (following the codebase's existing pattern — no event bus):

```javascript
// Each page component implements this interface:
interface WizardPageComponent {
  /** Called when page becomes active (entering view) */
  activate(state: WizardState): void;

  /** Called when page is leaving view */
  deactivate(): void;

  /** Validate page state. Returns null if valid, or error message string if invalid. */
  validate(): string | null;

  /** Collect page state into the wizard state object */
  collectState(state: WizardState): void;

  /** Return the root DOM element for this page */
  getElement(): HTMLElement;

  /** Called when wizard state changes from another page */
  onStateUpdate(state: WizardState): void;

  /** Cleanup — remove event listeners, timers, etc. */
  destroy(): void;
}
```

---

## 4. State Machine

### 4.1 States

```
┌─────────────────────────────────────────────────────────────────┐
│                    InfraWizardDialog States                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [closed] ──── open() ──→ [initializing]                       │
│                                  │                              │
│                           (DOM created,                         │
│                            entrance anim)                       │
│                                  │                              │
│                                  ▼                              │
│                            [page-0-active]                      │
│                            (Setup page)                         │
│                                  │                              │
│                            next ─┤─ back                        │
│                                  ▼                              │
│                            [page-1-active]                      │
│                            (Theme page)                         │
│                                  │                              │
│                            next ─┤─ back                        │
│                                  ▼                              │
│                            [page-2-active]                      │
│                            (Build/DAG page)                     │
│                                  │                              │
│                            next ─┤─ back                        │
│                                  ▼                              │
│                            [page-3-active]                      │
│                            (Review page)                        │
│                                  │                              │
│                       "Lock In & Create" ─┤─ back               │
│                                  ▼                              │
│                            [page-4-active]                      │
│                            (Executing)                          │
│                                  │                              │
│                        ┌─────────┼─────────┐                    │
│                        ▼         ▼         ▼                    │
│                  [minimized] [completed] [error]                │
│                      │                      │                   │
│                   restore                 retry                 │
│                      │                      │                   │
│                      ▼                      ▼                   │
│                [page-4-active]       [page-4-active]            │
│                                      (re-run from              │
│                                       failed step)             │
│                                                                 │
│  Any state except [page-4-active] ──── close() ──→ [closed]   │
│  [page-4-active] ──── close() ──→ [minimized]                 │
│  [completed] ──── close() ──→ [closed]                         │
│  [error] ──── close() ──→ [closing-confirm]                    │
│  [closing-confirm] ──── confirm ──→ [closed]                   │
│  [closing-confirm] ──── cancel ──→ (previous state)            │
│                                                                 │
│  Any [page-N-active] with dirty=true ──                        │
│       close() ──→ [closing-confirm]                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 State Definitions

| State | Description | Allowed Actions |
|-------|-------------|-----------------|
| `closed` | No DOM exists. Wizard is not active. | `open()` |
| `initializing` | DOM is being created, entrance animation playing. | None — wait for animation to complete (~450ms). |
| `page-0-active` | Page 1 (Setup) is visible and interactive. | Next, Close, Escape, drag, resize. |
| `page-1-active` | Page 2 (Theme) is visible and interactive. | Next, Back, Close, Escape, step-click, drag, resize. |
| `page-2-active` | Page 3 (Build/DAG) is visible and interactive. | Next, Back, Close, Escape, step-click, drag, resize. All DAG canvas interactions. |
| `page-3-active` | Page 4 (Review) is visible and interactive. | "Lock In & Create", Back, Close, Escape, step-click, drag, resize. Save as Template. |
| `page-4-active` | Page 5 (Execution) is visible. Pipeline is running. | Minimize. Close → minimize. No Back. No cancel. |
| `minimized` | Dialog DOM is hidden. FloatingBadge is visible. Execution continues in background. | Restore (click badge). |
| `completed` | Page 5 shows all steps done. Success state. | Close, "Navigate to workspace" CTA. |
| `error` | Page 5 shows a failed step with error details. | Retry, Close (with rollback confirmation), Minimize. |
| `rolling-back` | Execution failed and rollback is in progress. Automated cleanup of created resources. | None — user must wait. |
| `closing-confirm` | Confirmation dialog is showing ("Discard wizard?" or "Execution is running, minimize instead?"). | Confirm (discard/close), Cancel (return to wizard). |

### 4.3 Transitions with Guards

```typescript
type Transition = {
  from: State;
  to: State;
  trigger: string;
  guard?: () => boolean;
  action?: () => void;
};

const TRANSITIONS: Transition[] = [
  // ─── Opening ───
  {
    from: 'closed',
    to: 'initializing',
    trigger: 'open()',
    guard: () => !InfraWizardDialog.isActive(),    // singleton guard
    action: () => { createDOM(); playEntranceAnimation(); }
  },
  {
    from: 'initializing',
    to: 'page-0-active',
    trigger: 'entrance-animation-complete',
    action: () => { activatePage(0); trapFocus(); }
  },

  // ─── Forward navigation ───
  {
    from: 'page-0-active',
    to: 'page-1-active',
    trigger: 'next-click',
    guard: () => pages[0].validate() === null,      // page must validate
    action: () => { pages[0].collectState(state); slideTransition(0, 1, 'forward'); }
  },
  {
    from: 'page-1-active',
    to: 'page-2-active',
    trigger: 'next-click',
    guard: () => pages[1].validate() === null,
    action: () => { pages[1].collectState(state); slideTransition(1, 2, 'forward'); }
  },
  {
    from: 'page-2-active',
    to: 'page-3-active',
    trigger: 'next-click',
    guard: () => pages[2].validate() === null,
    action: () => { pages[2].collectState(state); slideTransition(2, 3, 'forward'); }
  },
  {
    from: 'page-3-active',
    to: 'page-4-active',
    trigger: 'lock-in-click',
    guard: () => pages[3].validate() === null,
    action: () => { pages[3].collectState(state); slideTransition(3, 4, 'forward'); startExecution(); }
  },

  // ─── Backward navigation ───
  {
    from: 'page-1-active',
    to: 'page-0-active',
    trigger: 'back-click',
    guard: () => true,      // always allowed
    action: () => { pages[1].collectState(state); slideTransition(1, 0, 'backward'); }
  },
  {
    from: 'page-2-active',
    to: 'page-1-active',
    trigger: 'back-click',
    guard: () => true,
    action: () => { pages[2].collectState(state); slideTransition(2, 1, 'backward'); }
  },
  {
    from: 'page-3-active',
    to: 'page-2-active',
    trigger: 'back-click',
    guard: () => true,
    action: () => { pages[3].collectState(state); slideTransition(3, 2, 'backward'); }
  },

  // ─── Step-click navigation (jump to completed step) ───
  {
    from: 'page-N-active',  // any page > target
    to: 'page-M-active',    // M < N (completed step)
    trigger: 'step-circle-click(M)',
    guard: (M) => M < currentPage && stepIsCompleted(M),
    action: (M) => { collectCurrentPage(); slideTransition(currentPage, M, 'backward'); }
  },

  // ─── Minimize / Restore ───
  {
    from: 'page-4-active',
    to: 'minimized',
    trigger: 'minimize-click OR close-click-during-execution',
    guard: () => state.execution?.status === 'running',
    action: () => { hideDialog(); createFloatingBadge(); }
  },
  {
    from: 'minimized',
    to: 'page-4-active',
    trigger: 'badge-click',
    action: () => { destroyFloatingBadge(); showDialog(); }
  },

  // ─── Execution completion ───
  {
    from: 'page-4-active',
    to: 'completed',
    trigger: 'execution-all-steps-done',
    action: () => { showCompletionUI(); fireOnComplete(); }
  },
  {
    from: 'minimized',
    to: 'completed',
    trigger: 'execution-all-steps-done-while-minimized',
    action: () => { updateBadgeToComplete(); }
  },

  // ─── Execution failure ───
  {
    from: 'page-4-active',
    to: 'error',
    trigger: 'execution-step-failed',
    action: () => { showErrorUI(); fireOnError(); }
  },

  // ─── Retry ───
  {
    from: 'error',
    to: 'page-4-active',
    trigger: 'retry-click',
    action: () => { retryFromFailedStep(); }
  },

  // ─── Rollback ───
  {
    from: 'error',
    to: 'rolling-back',
    trigger: 'close-confirmed-with-rollback',
    action: () => { startRollback(); }
  },
  {
    from: 'rolling-back',
    to: 'closed',
    trigger: 'rollback-complete',
    action: () => { removeDOM(); releaseSingleton(); }
  },

  // ─── Close ───
  {
    from: 'page-N-active (N < 4)',
    to: 'closing-confirm',
    trigger: 'close-click OR escape',
    guard: () => state.dirty === true,
    action: () => { showCloseConfirmation(); }
  },
  {
    from: 'page-N-active (N < 4)',
    to: 'closed',
    trigger: 'close-click OR escape',
    guard: () => state.dirty === false,    // nothing entered yet
    action: () => { playExitAnimation(); removeDOM(); releaseSingleton(); }
  },
  {
    from: 'closing-confirm',
    to: 'closed',
    trigger: 'confirm-discard',
    action: () => { playExitAnimation(); removeDOM(); releaseSingleton(); }
  },
  {
    from: 'closing-confirm',
    to: 'previous-state',
    trigger: 'cancel-close',
    action: () => { hideCloseConfirmation(); }
  },
  {
    from: 'completed',
    to: 'closed',
    trigger: 'close-click',
    action: () => { playExitAnimation(); removeDOM(); releaseSingleton(); }
  },
];
```

### 4.4 State Invariants

| Invariant | Description |
|-----------|-------------|
| **Singleton** | `InfraWizardDialog._activeInstance` is either `null` or the one active dialog. `open()` throws if non-null. |
| **Forward requires validation** | `goToPage(N+1)` always calls `pages[N].validate()` first. If validation returns a non-null error string, transition is blocked and the error is shown inline. |
| **Back never validates** | Backward navigation always succeeds. No data is lost. |
| **Execution blocks navigation** | Once `page-4-active` is entered, Back button is hidden, step circles are non-clickable, and close → minimize. |
| **Dirty tracking** | `state.dirty` is set to `true` on the first user input event in any page. Reset to `false` only when wizard is closed cleanly. |
| **Focus trap active** | While dialog is open (not minimized), Tab and Shift+Tab cycle within the dialog's focusable elements. |
| **Only one transition at a time** | Page transitions use a `_transitioning` lock flag that prevents concurrent goToPage calls during the 360ms animation. |

---

## 5. Scenarios

### 5.1 Open Wizard (Happy Path)

**Trigger:** User right-clicks a workspace → "Create Infrastructure..."

```pseudocode
FUNCTION open():
  // Guard: singleton check
  IF InfraWizardDialog._activeInstance IS NOT NULL:
    // Flash the existing wizard badge or dialog
    InfraWizardDialog._activeInstance.restore();
    RETURN;

  // Guard: API client check
  IF NOT apiClient.hasBearerToken():
    showToast("Authentication required — connect to Fabric first", "error");
    RETURN;

  // Register singleton
  InfraWizardDialog._activeInstance = this;
  this._state = createDefaultState();

  // Apply initial state (from template or options)
  IF options.initialState:
    Object.assign(this._state, options.initialState);

  // Create DOM tree
  this._overlayEl = createElement('div', { class: 'iw-overlay' });
  this._dialogEl = createElement('div', { class: 'iw-dialog' });
  this._overlayEl.appendChild(this._dialogEl);
  
  // Build internal structure
  this._renderTitleBar();
  this._renderStepper();
  this._renderPageContainer();
  this._renderFooter();

  // Create page components
  this._pages = [
    new InfraSetupPage(this._state, this._api),
    new ThemeSchemaPage(this._state),
    new DagCanvasPage(this._state),
    new ReviewSummary(this._state),
    new ExecutionPipeline(this._state, this._api),
  ];

  // Mount pages into container
  this._pages.forEach((page, i) => {
    const el = page.getElement();
    el.id = `iw-page-${i}`;
    el.classList.add('iw-page');
    IF i === 0: el.classList.add('active');
    this._pageContainerEl.appendChild(el);
  });

  // Set initial dialog geometry
  this._geometry = loadSessionGeometry() OR { ...DEFAULT_GEOMETRY };
  this._applyGeometry();

  // Mount to DOM
  document.body.appendChild(this._overlayEl);

  // Play entrance animation (450ms spring)
  // Overlay: overlayIn animation (400ms)
  // Dialog: dialogIn animation (450ms spring)

  // After animation completes:
  setTimeout(() => {
    this._machineState = 'page-0-active';
    this._pages[0].activate(this._state);
    this._setupFocusTrap();
    this._bindKeyboardShortcuts();
    this._bindDragHandlers();
    this._bindResizeHandlers();
  }, 450);
```

### 5.2 Navigate Forward (Next Button)

**Trigger:** User clicks "Next →" on Page 1

```pseudocode
FUNCTION _handleNext():
  IF this._transitioning: RETURN;   // animation lock

  currentIndex = this._currentPage;
  targetIndex = currentIndex + 1;

  IF targetIndex >= TOTAL_PAGES: RETURN;

  // Special case: Page 3 "Lock In & Create"
  IF currentIndex === 3:
    this._handleLockInAndCreate();
    RETURN;

  // Validate current page
  validationError = this._pages[currentIndex].validate();
  IF validationError IS NOT NULL:
    this._showValidationError(validationError);
    // Shake the Next button (subtle feedback)
    this._nextBtn.classList.add('iw-shake');
    setTimeout(() => this._nextBtn.classList.remove('iw-shake'), 400);
    RETURN;

  // Collect state from current page
  this._pages[currentIndex].collectState(this._state);
  this._state.dirty = true;

  // Perform slide transition
  this._slideTransition(currentIndex, targetIndex, 'forward');
```

### 5.3 Navigate Backward (Back Button)

**Trigger:** User clicks "← Back" on Page 2

```pseudocode
FUNCTION _handleBack():
  IF this._transitioning: RETURN;
  IF this._currentPage === 0: RETURN;       // no back on page 0
  IF this._currentPage === 4: RETURN;       // no back during execution

  currentIndex = this._currentPage;
  targetIndex = currentIndex - 1;

  // Collect current page state (preserve data)
  this._pages[currentIndex].collectState(this._state);

  // Perform slide transition (backward direction)
  this._slideTransition(currentIndex, targetIndex, 'backward');
```

### 5.4 Slide Transition (Internal)

```pseudocode
FUNCTION _slideTransition(fromIndex, toIndex, direction):
  this._transitioning = true;

  leavingPage = this._pageContainerEl.children[fromIndex];
  enteringPage = this._pageContainerEl.children[toIndex];

  // Set exit transform based on direction
  IF direction === 'forward':
    leavingPage.style.transform = 'translateX(-60px)';     // slide left
    enteringPage.style.transform = 'translateX(60px)';     // enter from right
  ELSE:
    leavingPage.style.transform = 'translateX(60px)';      // slide right
    enteringPage.style.transform = 'translateX(-60px)';    // enter from left

  leavingPage.style.opacity = '0';
  leavingPage.classList.remove('active');

  // Deactivate leaving page
  this._pages[fromIndex].deactivate();

  // Begin enter animation on next frame
  requestAnimationFrame(() => {
    enteringPage.classList.add('active');
    enteringPage.style.transform = 'translateX(0)';
    enteringPage.style.opacity = '1';
  });

  // Update stepper
  this._updateStepper(toIndex);

  // Update footer
  this._updateFooter(toIndex);

  // Update current page
  this._currentPage = toIndex;

  // After transition completes (360ms from mock's --t-page)
  setTimeout(() => {
    // Clean up leaving page styles
    leavingPage.style.transform = '';
    leavingPage.style.opacity = '';

    // Activate entering page
    this._pages[toIndex].activate(this._state);

    // Fire callback
    IF this.onPageChange:
      this.onPageChange(fromIndex, toIndex);

    this._transitioning = false;
  }, 360);
```

### 5.5 Click Completed Step (Jump Back)

**Trigger:** User is on Page 3 (Build), clicks completed step circle "1" (Setup)

```pseudocode
FUNCTION _handleStepClick(targetIndex):
  IF this._transitioning: RETURN;
  IF targetIndex === this._currentPage: RETURN;   // already on this page
  IF targetIndex >= this._currentPage: RETURN;     // can't jump forward
  IF this._currentPage === 4: RETURN;              // no navigation during execution

  // Verify step is actually completed
  IF NOT this._stepIsCompleted(targetIndex): RETURN;

  // Collect current page state
  this._pages[this._currentPage].collectState(this._state);

  // Slide backward to target
  this._slideTransition(this._currentPage, targetIndex, 'backward');
```

### 5.6 Minimize to FloatingBadge

**Trigger:** User clicks "Minimize" during execution (Page 5), or clicks Close (X) during execution

```pseudocode
FUNCTION minimize():
  IF NOT this.isExecuting(): RETURN;   // only during execution

  // Record current dialog geometry for restore
  this._preMinimizeGeometry = { ...this._geometry };

  // Animate dialog exit
  this._dialogEl.style.transition = 'transform 300ms var(--ease), opacity 300ms var(--ease)';
  this._dialogEl.style.transform = 'scale(0.8) translateY(40px)';
  this._dialogEl.style.opacity = '0';

  // Fade overlay
  this._overlayEl.style.transition = 'backdrop-filter 300ms, background 300ms';
  this._overlayEl.style.backdropFilter = 'blur(0px)';
  this._overlayEl.style.background = 'rgba(0,0,0,0)';

  setTimeout(() => {
    // Hide overlay and dialog (keep in DOM)
    this._overlayEl.style.display = 'none';

    // Release focus trap (user can interact with main app)
    this._releaseFocusTrap();
    this._unbindKeyboardShortcuts();

    // Create FloatingBadge
    this._badge = new FloatingBadge({
      environmentName: this._state.workspaceName,
      execution: this._state.execution,
      onClick: () => this.restore(),
    });
    this._badge.mount();

    this._machineState = 'minimized';
    IF this.onMinimize: this.onMinimize();
  }, 300);
```

### 5.7 Restore from FloatingBadge

**Trigger:** User clicks the floating badge pill

```pseudocode
FUNCTION restore():
  IF this._machineState !== 'minimized': RETURN;

  // Destroy badge
  this._badge.destroy();
  this._badge = null;

  // Show overlay and dialog
  this._overlayEl.style.display = '';

  // Reset dialog to pre-minimize state
  this._dialogEl.style.transform = 'scale(0.94) translateY(16px)';
  this._dialogEl.style.opacity = '0';

  requestAnimationFrame(() => {
    // Play entrance animation
    this._overlayEl.style.backdropFilter = 'blur(8px)';
    this._overlayEl.style.background = 'rgba(0,0,0,0.18)';

    this._dialogEl.style.transition = 'transform 450ms var(--spring), opacity 450ms var(--spring)';
    this._dialogEl.style.transform = 'scale(1) translateY(0)';
    this._dialogEl.style.opacity = '1';
  });

  setTimeout(() => {
    // Re-establish focus trap
    this._setupFocusTrap();
    this._bindKeyboardShortcuts();

    // Sync execution state (may have progressed while minimized)
    this._pages[4].onStateUpdate(this._state);

    this._machineState = this._state.execution?.status === 'completed'
      ? 'completed'
      : this._state.execution?.status === 'failed'
        ? 'error'
        : 'page-4-active';

    IF this.onRestore: this.onRestore();
  }, 450);
```

### 5.8 Close During Execution

**Trigger:** User clicks Close (X) button while execution pipeline is running on Page 5

```pseudocode
FUNCTION _handleClose():
  IF this.isExecuting():
    // Cannot cancel execution — minimize instead
    this.minimize();
    RETURN;

  IF this._machineState === 'rolling-back':
    // Cannot close during rollback — show toast
    showToast("Rollback in progress — please wait", "warning");
    RETURN;

  IF this._machineState === 'completed':
    // Clean close after successful execution
    this._playExitAndDestroy();
    RETURN;

  IF this._state.dirty:
    // Show confirmation dialog
    this._showCloseConfirmation();
    RETURN;

  // Clean state, no data entered — close immediately
  this._playExitAndDestroy();
```

### 5.9 Close Confirmation Dialog

```pseudocode
FUNCTION _showCloseConfirmation():
  // Create inline confirmation card (not a separate modal — uses the deploy switch confirm pattern)
  confirmEl = createElement('div', { class: 'iw-confirm-overlay' });
  confirmEl.innerHTML = `
    <div class="iw-confirm-card">
      <div class="iw-confirm-title">Discard wizard?</div>
      <div class="iw-confirm-message">
        You have unsaved configuration. Closing will discard all changes.
      </div>
      <div class="iw-confirm-actions">
        <button class="btn btn-ghost" data-action="cancel">Cancel</button>
        <button class="btn btn-primary" style="background:var(--status-fail);" data-action="discard">
          Discard & Close
        </button>
      </div>
    </div>
  `;

  confirmEl.querySelector('[data-action="cancel"]').onclick = () => {
    confirmEl.remove();
    this._machineState = this._previousState;
  };

  confirmEl.querySelector('[data-action="discard"]').onclick = () => {
    confirmEl.remove();
    this._playExitAndDestroy();
  };

  this._dialogEl.appendChild(confirmEl);
  this._machineState = 'closing-confirm';
```

### 5.10 Validation Failure

**Trigger:** User clicks "Next →" on Page 1 without selecting a capacity

```pseudocode
// In _handleNext() — when validation fails:

validationError = this._pages[0].validate();
// Returns: "Please select a capacity"

IF validationError IS NOT NULL:
  // 1. Disable Next button temporarily
  this._nextBtn.disabled = true;
  this._nextBtn.setAttribute('title', validationError);

  // 2. Show error toast (using existing _toast pattern)
  this._showToast(validationError, 'error');

  // 3. Tell the page to highlight the invalid field
  this._pages[0].highlightError(validationError);

  // 4. Shake animation on Next button
  this._nextBtn.classList.add('iw-shake');
  setTimeout(() => {
    this._nextBtn.classList.remove('iw-shake');
    this._nextBtn.disabled = false;
    this._nextBtn.removeAttribute('title');
  }, 600);
```

### 5.11 Lock In & Create (Start Execution)

**Trigger:** User clicks "Lock In & Create ▶" on Page 4 (Review)

```pseudocode
FUNCTION _handleLockInAndCreate():
  // Final validation sweep (all pages)
  FOR i FROM 0 TO 3:
    error = this._pages[i].validate();
    IF error IS NOT NULL:
      this._showToast(`Step ${i + 1} has issues: ${error}`, 'error');
      // Jump back to problematic page
      this._slideTransition(this._currentPage, i, 'backward');
      RETURN;

  // Freeze the stepper — no more clickable steps
  this._freezeStepper();

  // Transition to Page 5
  this._slideTransition(3, 4, 'forward');

  // Initialize execution state
  this._state.execution = {
    status: 'running',
    currentStepIndex: 0,
    steps: [
      { id: 'create-workspace', label: 'Create Workspace', status: 'pending', ... },
      { id: 'assign-capacity', label: 'Assign Capacity', status: 'pending', ... },
      { id: 'create-lakehouse', label: 'Create Lakehouse', status: 'pending', ... },
      { id: 'create-notebook', label: 'Create Notebook', status: 'pending', ... },
      { id: 'write-cells', label: 'Write Cells', status: 'pending', ... },
      { id: 'run-notebook', label: 'Run Notebook', status: 'pending', ... },
    ],
    startedAt: Date.now(),
    completedAt: null,
    error: null,
    createdResources: [],
  };

  // Hide footer (no Back/Next on execution page)
  this._footerEl.style.display = 'none';

  // Tell ExecutionPipeline to start
  this._pages[4].startExecution(this._state);
```

### 5.12 Drag Dialog

**Trigger:** User mousedown on title bar and drags

```pseudocode
FUNCTION _onTitleBarPointerDown(e):
  // Only left mouse button
  IF e.button !== 0: RETURN;
  // Don't drag if clicking close button or step circle
  IF e.target.closest('.iw-close-btn') OR e.target.closest('.iw-step-circle'): RETURN;

  e.preventDefault();
  this._dragging = true;
  this._dragStartX = e.clientX - this._geometry.x;
  this._dragStartY = e.clientY - this._geometry.y;

  this._dialogEl.style.cursor = 'grabbing';
  this._geometry.centered = false;

  // Bind move/up to document
  document.addEventListener('pointermove', this._onDragMove);
  document.addEventListener('pointerup', this._onDragEnd);

FUNCTION _onDragMove(e):
  IF NOT this._dragging: RETURN;

  newX = e.clientX - this._dragStartX;
  newY = e.clientY - this._dragStartY;

  // Constrain: at least DRAG_MARGIN px of header visible
  maxX = window.innerWidth - DRAG_MARGIN;
  maxY = window.innerHeight - DRAG_MARGIN;
  newX = Math.max(-this._geometry.width + DRAG_MARGIN, Math.min(newX, maxX));
  newY = Math.max(0, Math.min(newY, maxY));

  this._geometry.x = newX;
  this._geometry.y = newY;
  this._applyGeometry();

FUNCTION _onDragEnd():
  this._dragging = false;
  this._dialogEl.style.cursor = '';
  document.removeEventListener('pointermove', this._onDragMove);
  document.removeEventListener('pointerup', this._onDragEnd);
  saveSessionGeometry(this._geometry);
```

### 5.13 Resize Dialog

**Trigger:** User mousedown on edge/corner resize handle

```pseudocode
FUNCTION _onResizeStart(e, direction):
  // direction is one of: 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'
  e.preventDefault();
  this._resizing = true;
  this._resizeDir = direction;
  this._resizeStartX = e.clientX;
  this._resizeStartY = e.clientY;
  this._resizeStartGeo = { ...this._geometry };

  document.addEventListener('pointermove', this._onResizeMove);
  document.addEventListener('pointerup', this._onResizeEnd);

FUNCTION _onResizeMove(e):
  IF NOT this._resizing: RETURN;

  dx = e.clientX - this._resizeStartX;
  dy = e.clientY - this._resizeStartY;
  g = this._resizeStartGeo;
  maxW = window.innerWidth * MAX_WIDTH_VW;
  maxH = window.innerHeight * MAX_HEIGHT_VH;

  // Calculate new dimensions based on direction
  IF this._resizeDir includes 'e':
    this._geometry.width = Math.min(maxW, Math.max(MIN_WIDTH, g.width + dx));
  IF this._resizeDir includes 'w':
    newW = Math.min(maxW, Math.max(MIN_WIDTH, g.width - dx));
    this._geometry.x = g.x + (g.width - newW);
    this._geometry.width = newW;
  IF this._resizeDir includes 's':
    this._geometry.height = Math.min(maxH, Math.max(MIN_HEIGHT, g.height + dy));
  IF this._resizeDir includes 'n':
    newH = Math.min(maxH, Math.max(MIN_HEIGHT, g.height - dy));
    this._geometry.y = g.y + (g.height - newH);
    this._geometry.height = newH;

  this._geometry.centered = false;
  this._applyGeometry();

FUNCTION _onResizeEnd():
  this._resizing = false;
  this._resizeDir = null;
  document.removeEventListener('pointermove', this._onResizeMove);
  document.removeEventListener('pointerup', this._onResizeEnd);
  saveSessionGeometry(this._geometry);
```

### 5.14 Double-Click Title Bar (Re-center)

```pseudocode
FUNCTION _onTitleBarDblClick():
  this._geometry.x = (window.innerWidth - this._geometry.width) / 2;
  this._geometry.y = (window.innerHeight - this._geometry.height) / 2;
  this._geometry.centered = true;

  // Smooth transition
  this._dialogEl.style.transition = 'left 300ms var(--ease), top 300ms var(--ease)';
  this._applyGeometry();
  setTimeout(() => { this._dialogEl.style.transition = ''; }, 300);
```

### 5.15 Escape Key

```pseudocode
FUNCTION _onKeyDown(e):
  IF e.key === 'Escape':
    e.preventDefault();
    e.stopPropagation();
    this._handleClose();
    RETURN;

  IF e.key === 'Tab':
    this._handleFocusTrap(e);
    RETURN;

  // Ctrl+Enter → Next/Create
  IF e.ctrlKey AND e.key === 'Enter':
    IF this._machineState.startsWith('page-') AND this._currentPage < 4:
      this._handleNext();
    RETURN;

  // Alt+← → Back
  IF e.altKey AND e.key === 'ArrowLeft':
    this._handleBack();
    RETURN;

  // Alt+→ → Next
  IF e.altKey AND e.key === 'ArrowRight':
    IF this._currentPage < 4:
      this._handleNext();
    RETURN;
```

### 5.16 Window Resize (Viewport Change)

```pseudocode
FUNCTION _onWindowResize():
  maxW = window.innerWidth * MAX_WIDTH_VW;
  maxH = window.innerHeight * MAX_HEIGHT_VH;

  // Clamp dialog size
  IF this._geometry.width > maxW:
    this._geometry.width = maxW;
  IF this._geometry.height > maxH:
    this._geometry.height = maxH;

  // Re-center if it was centered
  IF this._geometry.centered:
    this._geometry.x = (window.innerWidth - this._geometry.width) / 2;
    this._geometry.y = (window.innerHeight - this._geometry.height) / 2;
  ELSE:
    // Ensure dialog is still visible
    IF this._geometry.x + this._geometry.width < DRAG_MARGIN:
      this._geometry.x = DRAG_MARGIN - this._geometry.width;
    IF this._geometry.y + 56 > window.innerHeight:   // 56 = header height
      this._geometry.y = window.innerHeight - 56;

  this._applyGeometry();
```

### 5.17 Open Wizard While Another Is Running (Blocked)

```pseudocode
// User tries to open wizard from context menu while execution is running

FUNCTION open():
  IF InfraWizardDialog._activeInstance IS NOT NULL:
    existingWizard = InfraWizardDialog._activeInstance;

    IF existingWizard.isMinimized():
      // Restore the minimized wizard
      existingWizard.restore();
    ELSE IF existingWizard.isOpen():
      // Flash the existing dialog
      existingWizard._dialogEl.classList.add('iw-attention');
      setTimeout(() => existingWizard._dialogEl.classList.remove('iw-attention'), 600);

    // Show toast explaining the block
    showToast("A wizard is already running — one at a time", "warning");
    RETURN;
```

### 5.18 Execution Failure + Retry

```pseudocode
// ExecutionPipeline (C10) calls back when a step fails

FUNCTION _onExecutionStepFailed(stepIndex, error):
  this._state.execution.status = 'failed';
  this._state.execution.error = {
    stepId: this._state.execution.steps[stepIndex].id,
    message: error.message,
    httpStatus: error.status || null,
    responseBody: error.body || null,
    canRetry: true,
  };

  this._machineState = 'error';

  // Update badge if minimized
  IF this._badge:
    this._badge.showError(error.message);

  IF this.onError:
    this.onError({ step: this._state.execution.steps[stepIndex].label, message: error.message });

// User clicks "Retry" on the failed step
FUNCTION _onRetryClick():
  failedIndex = this._state.execution.currentStepIndex;

  // Reset failed step to pending
  this._state.execution.steps[failedIndex].status = 'pending';
  this._state.execution.steps[failedIndex].error = null;
  this._state.execution.error = null;
  this._state.execution.status = 'running';

  this._machineState = 'page-4-active';

  // Re-start execution from failed step (skips completed steps)
  this._pages[4].retryFromStep(failedIndex);
```

### 5.19 Template Load on Open

```pseudocode
// User opens wizard with a pre-loaded template

constructor(apiClient, { initialState: templateState }) {
  ...
}

open():
  ...
  // After DOM creation, if initialState provided:
  IF this._state.templateName:
    // All form fields are pre-filled from template
    // User lands on Page 1 with everything filled in
    // They can review and modify before proceeding
    this._state.dirty = false;  // template isn't "dirty" — it's a starting point
```

---

## 6. Visual Specification

### 6.1 CSS Class Hierarchy

All InfraWizardDialog CSS classes use the `iw-` prefix to avoid collisions with existing EDOG Studio styles. The mock uses unprefixed classes (`.overlay`, `.dialog`, etc.) — the implementation MUST prefix these to prevent style bleed.

```
.iw-overlay                          ← Fixed fullscreen overlay
  .iw-dialog                         ← Dialog container (positioned)
    .iw-header                        ← Title bar
      .iw-drag-hint                   ← Centered pill drag indicator
      .iw-title                       ← Icon + "New Infrastructure"
        .iw-title-icon                ← SVG layers icon
      .iw-close-btn                   ← ✕ button
    .iw-stepper                       ← Horizontal step indicator
      .iw-step-group                  ← Step circle + label wrapper
        .iw-step-item                 ← Click target
          .iw-step-circle             ← Numbered circle
            .iw-step-num              ← Number text
            .iw-step-check            ← Checkmark (hidden until completed)
        .iw-step-label                ← "Setup" / "Theme" / etc.
      .iw-step-connector              ← Connecting line between circles
        .iw-step-connector-fill       ← Animated fill
    .iw-page-container                ← Relative container for pages
      .iw-page                        ← Each page (absolute, stacked)
        .iw-page-content              ← Scrollable content area
    .iw-footer                        ← Navigation buttons
      .iw-back-btn                    ← "← Back"
      .iw-next-btn                    ← "Next →" / "Lock In & Create ▶"
    .iw-confirm-overlay               ← Close confirmation card overlay
      .iw-confirm-card
    .iw-resize-handle-n               ← Top edge
    .iw-resize-handle-s               ← Bottom edge
    .iw-resize-handle-e               ← Right edge
    .iw-resize-handle-w               ← Left edge
    .iw-resize-handle-ne              ← Top-right corner
    .iw-resize-handle-nw              ← Top-left corner
    .iw-resize-handle-se              ← Bottom-right corner
    .iw-resize-handle-sw              ← Bottom-left corner
```

### 6.2 Layout Rules

```css
/* Overlay */
.iw-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-wizard, 500);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
  background: rgba(0, 0, 0, 0.18);
  animation: iw-overlayIn 400ms var(--ease) both;
}

/* Dialog — default 920×680, resizable */
.iw-dialog {
  width: min(920px, 88vw);
  height: min(680px, 88vh);
  min-width: 640px;
  min-height: 480px;
  background: var(--surface);
  border-radius: var(--r-xl);           /* 14px */
  box-shadow: var(--shadow-dialog);     /* 0 24px 80px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.08) */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  position: absolute;                    /* positioned via JS for drag/resize */
  animation: iw-dialogIn 450ms var(--spring) both;
}

/* Title bar — 56px height, drag handle */
.iw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-4) var(--sp-6);      /* 16px 24px */
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
  min-height: 56px;
  cursor: grab;
  user-select: none;
  position: relative;
}

.iw-header:active {
  cursor: grabbing;
}

/* Drag hint pill */
.iw-drag-hint {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-3);
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
}

/* Title */
.iw-title {
  font-size: var(--text-lg);            /* 15px */
  font-weight: 700;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: var(--sp-2);                     /* 8px */
}

.iw-title-icon {
  width: 18px;
  height: 18px;
  color: var(--accent);
  flex-shrink: 0;
}

/* Close button */
.iw-close-btn {
  width: 32px;
  height: 32px;
  border-radius: var(--r-md);           /* 6px */
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 16px;
  transition: all var(--t-fast) var(--ease);   /* 80ms */
}

.iw-close-btn:hover {
  background: var(--surface-3);
  color: var(--text);
}

/* Stepper bar */
.iw-stepper {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5) var(--sp-8);      /* 20px 32px */
  gap: 0;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

/* Step circle — 30px diameter */
.iw-step-circle {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);            /* 12px */
  font-weight: 600;
  border: 2px solid var(--surface-3);
  color: var(--text-muted);
  background: var(--surface);
  transition: all 300ms var(--ease);
  position: relative;
  flex-shrink: 0;
}

/* Active step — accent border + pulse */
.iw-step-item.active .iw-step-circle {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-dim);
  animation: iw-pulseAccent 2s ease-in-out infinite;
}

/* Completed step — green fill + checkmark */
.iw-step-item.completed .iw-step-circle {
  border-color: var(--status-ok);
  background: var(--status-ok);
  color: white;
  cursor: pointer;
}

.iw-step-item.completed .iw-step-circle:hover {
  transform: scale(1.1);
}

.iw-step-item.completed .iw-step-num { display: none; }
.iw-step-item.completed .iw-step-check {
  display: block;
  animation: iw-checkPop 300ms var(--spring) both;
}

/* Step connector — 56px line */
.iw-step-connector {
  width: 56px;
  height: 2px;
  background: var(--surface-3);
  margin: 0 var(--sp-1);               /* 4px */
  position: relative;
  overflow: hidden;
  border-radius: 1px;
  flex-shrink: 0;
}

.iw-step-connector-fill {
  position: absolute;
  inset: 0;
  background: var(--status-ok);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 500ms var(--ease);
}

.iw-step-connector.filled .iw-step-connector-fill {
  transform: scaleX(1);
}

/* Step label */
.iw-step-label {
  font-size: var(--text-xs);            /* 10px */
  color: var(--text-muted);
  margin-top: 4px;
  text-align: center;
  font-weight: 500;
  letter-spacing: 0.02em;
  transition: color var(--t-fast) var(--ease);
}

.iw-step-item.active .iw-step-label {
  color: var(--accent);
  font-weight: 600;
}

.iw-step-item.completed .iw-step-label {
  color: var(--status-ok);
}

/* Page container */
.iw-page-container {
  flex: 1;
  overflow: hidden;
  position: relative;
}

/* Each page — absolutely positioned, stacked */
.iw-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  opacity: 0;
  pointer-events: none;
  transition: opacity 300ms var(--ease), transform 360ms var(--ease);
  transform: translateX(60px);
  overflow-y: auto;
}

.iw-page.active {
  opacity: 1;
  pointer-events: all;
  transform: translateX(0);
}

.iw-page.exit-left {
  transform: translateX(-60px);
  opacity: 0;
}

.iw-page.exit-right {
  transform: translateX(60px);
  opacity: 0;
}

.iw-page-content {
  flex: 1;
  padding: var(--sp-6) var(--sp-8);     /* 24px 32px */
}

/* Footer */
.iw-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-4) var(--sp-6);      /* 16px 24px */
  border-top: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

/* Resize handles — invisible hit areas */
.iw-resize-handle-n, .iw-resize-handle-s {
  position: absolute;
  left: 12px;
  right: 12px;
  height: 8px;
  cursor: ns-resize;
  z-index: 10;
}
.iw-resize-handle-n { top: -4px; }
.iw-resize-handle-s { bottom: -4px; }

.iw-resize-handle-e, .iw-resize-handle-w {
  position: absolute;
  top: 12px;
  bottom: 12px;
  width: 8px;
  cursor: ew-resize;
  z-index: 10;
}
.iw-resize-handle-e { right: -4px; }
.iw-resize-handle-w { left: -4px; }

.iw-resize-handle-ne, .iw-resize-handle-nw,
.iw-resize-handle-se, .iw-resize-handle-sw {
  position: absolute;
  width: 12px;
  height: 12px;
  z-index: 11;
}
.iw-resize-handle-ne { top: -4px; right: -4px; cursor: nesw-resize; }
.iw-resize-handle-nw { top: -4px; left: -4px; cursor: nwse-resize; }
.iw-resize-handle-se { bottom: -4px; right: -4px; cursor: nwse-resize; }
.iw-resize-handle-sw { bottom: -4px; left: -4px; cursor: nesw-resize; }
```

### 6.3 Animation Keyframes

All keyframes are namespaced with `iw-` to avoid collisions with existing EDOG Studio animations.

```css
/* ─── Overlay entrance ─── */
@keyframes iw-overlayIn {
  from {
    backdrop-filter: blur(0px);
    background: rgba(0, 0, 0, 0);
  }
  to {
    backdrop-filter: blur(8px);
    background: rgba(0, 0, 0, 0.18);
  }
}
/* Duration: 400ms | Easing: var(--ease) */

/* ─── Dialog entrance (spring bounce) ─── */
@keyframes iw-dialogIn {
  from {
    opacity: 0;
    transform: scale(0.94) translateY(16px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
/* Duration: 450ms | Easing: var(--spring) cubic-bezier(0.34, 1.56, 0.64, 1) */

/* ─── Dialog exit ─── */
@keyframes iw-dialogOut {
  from {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
  to {
    opacity: 0;
    transform: scale(0.94) translateY(16px);
  }
}
/* Duration: 250ms | Easing: var(--ease) */

/* ─── Overlay exit ─── */
@keyframes iw-overlayOut {
  from {
    backdrop-filter: blur(8px);
    background: rgba(0, 0, 0, 0.18);
  }
  to {
    backdrop-filter: blur(0px);
    background: rgba(0, 0, 0, 0);
  }
}
/* Duration: 300ms | Easing: var(--ease) */

/* ─── Step circle pulse (active step) ─── */
@keyframes iw-pulseAccent {
  0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); }
  50% { box-shadow: 0 0 0 6px transparent; }
}
/* Duration: 2s | Easing: ease-in-out | Iteration: infinite */

/* ─── Checkmark pop (completed step) ─── */
@keyframes iw-checkPop {
  0% { transform: scale(0); }
  60% { transform: scale(1.2); }
  100% { transform: scale(1); }
}
/* Duration: 300ms | Easing: var(--spring) */

/* ─── Page content stagger (form groups slide up) ─── */
@keyframes iw-slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
/* Duration: 400ms | Easing: var(--ease) | Delay: staggered per nth-child */

/* ─── Shake (validation failure on Next button) ─── */
@keyframes iw-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-4px); }
  40% { transform: translateX(4px); }
  60% { transform: translateX(-3px); }
  80% { transform: translateX(2px); }
}
/* Duration: 400ms | Easing: ease-out */

/* ─── Attention flash (when user tries to open duplicate wizard) ─── */
@keyframes iw-attention {
  0%, 100% { box-shadow: var(--shadow-dialog); }
  50% { box-shadow: var(--shadow-dialog), 0 0 0 4px var(--accent-glow); }
}
/* Duration: 600ms | Easing: ease-in-out */

/* ─── Connector fill (step completion line fill) ─── */
/* Handled via CSS transition on scaleX, not keyframe */

/* ─── Content stagger on page enter ─── */
.iw-page.active .iw-stagger-1 { animation: iw-slideUp 400ms var(--ease) 50ms both; }
.iw-page.active .iw-stagger-2 { animation: iw-slideUp 400ms var(--ease) 100ms both; }
.iw-page.active .iw-stagger-3 { animation: iw-slideUp 400ms var(--ease) 150ms both; }
.iw-page.active .iw-stagger-4 { animation: iw-slideUp 400ms var(--ease) 200ms both; }
.iw-page.active .iw-stagger-5 { animation: iw-slideUp 400ms var(--ease) 250ms both; }
```

### 6.4 Transition Choreography

| Transition | Elements Animated | Duration | Easing | Notes |
|-----------|-------------------|----------|--------|-------|
| **Open wizard** | Overlay: blur 0→8px + opacity. Dialog: scale 0.94→1 + translateY 16→0. | Overlay: 400ms. Dialog: 450ms. | Overlay: `var(--ease)`. Dialog: `var(--spring)`. | Dialog starts 50ms after overlay begins. |
| **Close wizard** | Dialog: scale 1→0.94 + translateY 0→16 + opacity 1→0. Overlay: blur 8→0 + opacity. | Dialog: 250ms. Overlay: 300ms (starts 100ms after dialog). | `var(--ease)` | DOM removed after overlay completes. |
| **Page forward** | Leaving page: translateX 0→-60px + opacity 1→0. Entering page: translateX 60→0px + opacity 0→1. | 360ms (`--t-page`). | `var(--ease)` | Header/footer/stepper do NOT animate. |
| **Page backward** | Leaving: translateX 0→60px. Entering: translateX -60→0px. | 360ms. | `var(--ease)` | Reverse direction of forward. |
| **Step complete** | Circle: border/bg color transition + checkPop. Connector: scaleX 0→1. | Circle: 300ms. Connector: 500ms. | Circle: `var(--spring)`. Connector: `var(--ease)`. | Sequential: circle first, then connector. |
| **Minimize** | Dialog: scale 1→0.8 + translateY 0→40 + opacity 1→0. Overlay: blur+opacity to 0. | 300ms. | `var(--ease)` | Badge appears after dialog hides. |
| **Restore** | Dialog: scale 0.94→1 + translateY 16→0. Overlay: blur+opacity back. | 450ms. | `var(--spring)` | Same as open animation. |
| **Validation shake** | Next button: horizontal shake (-4, 4, -3, 2, 0). | 400ms. | `ease-out` | Tactile feedback for blocked action. |

### 6.5 Button Variants

```css
/* Primary Next button */
.iw-next-btn.btn-primary {
  background: var(--accent);
  color: white;
  padding: var(--sp-2) var(--sp-5);        /* 8px 20px */
  box-shadow: 0 1px 3px rgba(109, 92, 255, 0.2);
}

.iw-next-btn.btn-primary:hover {
  background: #5e4de6;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(109, 92, 255, 0.3);
}

.iw-next-btn.btn-primary:active {
  transform: translateY(0);
}

.iw-next-btn.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

/* "Lock In & Create" button (Page 4 Review) */
.iw-next-btn.btn-create {
  background: var(--accent);
  color: white;
  padding: var(--sp-3) var(--sp-6);        /* 12px 24px */
  font-size: var(--text-md);
  font-weight: 700;
  border-radius: var(--r-md);
  box-shadow: 0 2px 8px rgba(109, 92, 255, 0.25);
}

.iw-next-btn.btn-create:hover {
  background: #5e4de6;
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(109, 92, 255, 0.35);
}

/* Ghost Back button */
.iw-back-btn {
  color: var(--text-dim);
  border: 1px solid var(--border-bright);
}

.iw-back-btn:hover {
  background: var(--surface-2);
  color: var(--text);
  border-color: rgba(0, 0, 0, 0.18);
}
```

### 6.6 Design Token Additions

The following tokens must be added to `variables.css` for F16:

```css
:root {
  --z-wizard: 500;             /* Above toast (400), above command palette (300) */
  --z-wizard-badge: 600;       /* FloatingBadge above wizard overlay */
  --shadow-dialog: 0 24px 80px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.08);
  --t-page: 360ms;             /* Page transition duration */
}
```

---

## 7. Keyboard & Accessibility

### 7.1 Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Escape` | Dialog open, not executing | Close (with confirmation if dirty) |
| `Escape` | Dialog open, executing | Minimize to badge |
| `Tab` | Dialog open | Cycle focus forward within dialog (trapped) |
| `Shift+Tab` | Dialog open | Cycle focus backward within dialog (trapped) |
| `Ctrl+Enter` | Any page (0–3) | Trigger Next/Create button |
| `Alt+←` | Any page (1–3) | Go to previous page |
| `Alt+→` | Any page (0–3) | Go to next page (validates first) |
| `Enter` | Focus on Next/Back button | Activate button |
| `Space` | Focus on step circle | Navigate to that step (if completed) |

### 7.2 Focus Trap Implementation

```pseudocode
FUNCTION _setupFocusTrap():
  // Find all focusable elements within the dialog
  focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
                      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]';

  this._getFocusableElements = () => {
    return Array.from(this._dialogEl.querySelectorAll(focusableSelector))
      .filter(el => el.offsetParent !== null);   // visible only
  };

FUNCTION _handleFocusTrap(e):
  // e is a Tab keydown event
  focusable = this._getFocusableElements();
  IF focusable.length === 0: RETURN;

  firstEl = focusable[0];
  lastEl = focusable[focusable.length - 1];

  IF e.shiftKey:
    // Shift+Tab — if on first element, wrap to last
    IF document.activeElement === firstEl:
      e.preventDefault();
      lastEl.focus();
  ELSE:
    // Tab — if on last element, wrap to first
    IF document.activeElement === lastEl:
      e.preventDefault();
      firstEl.focus();
```

### 7.3 ARIA Roles & Attributes

```html
<!-- Overlay -->
<div class="iw-overlay" role="presentation" aria-hidden="false">

  <!-- Dialog -->
  <div class="iw-dialog"
       role="dialog"
       aria-modal="true"
       aria-labelledby="iw-dialog-title"
       aria-describedby="iw-dialog-desc">

    <!-- Title -->
    <div class="iw-header">
      <h2 class="iw-title" id="iw-dialog-title">
        <svg ...>...</svg>
        New Infrastructure
      </h2>
      <button class="iw-close-btn"
              aria-label="Close wizard"
              title="Close">✕</button>
    </div>

    <!-- Stepper -->
    <nav class="iw-stepper" aria-label="Wizard steps">
      <div class="iw-step-group">
        <button class="iw-step-item active"
                role="tab"
                aria-selected="true"
                aria-label="Step 1: Setup (current)"
                tabindex="0">
          <div class="iw-step-circle" aria-hidden="true">
            <span class="iw-step-num">1</span>
            <span class="iw-step-check">✓</span>
          </div>
        </button>
        <span class="iw-step-label" aria-hidden="true">Setup</span>
      </div>
      <!-- ... repeat for steps 2-5 ... -->
    </nav>

    <!-- Page container -->
    <div class="iw-page-container"
         role="tabpanel"
         aria-labelledby="iw-step-{currentIndex}">
      <!-- pages -->
    </div>

    <!-- Footer -->
    <div class="iw-footer" role="navigation" aria-label="Wizard navigation">
      <button class="iw-back-btn" aria-label="Go back to previous step">← Back</button>
      <button class="iw-next-btn" aria-label="Proceed to next step">Next →</button>
    </div>
  </div>
</div>
```

### 7.4 Focus Management

| Event | Focus Behavior |
|-------|---------------|
| **Dialog opens** | Focus moves to first focusable element in Page 1 (workspace name input). |
| **Page transition** | After 360ms transition, focus moves to first focusable element in the new page. |
| **Close confirmation appears** | Focus moves to "Cancel" button (safe default). |
| **Dialog closes** | Focus returns to the element that triggered the wizard open (the context menu trigger). |
| **Minimize** | Focus trap released. Focus returns to main app. |
| **Restore** | Focus trap re-established. Focus moves to appropriate element on current page. |
| **Validation failure** | Focus moves to the first invalid field on the page. |

### 7.5 Screen Reader Announcements

```pseudocode
// Live region for dynamic announcements
<div id="iw-live-region" aria-live="polite" aria-atomic="true" class="sr-only"></div>

FUNCTION _announce(message):
  liveRegion = document.getElementById('iw-live-region');
  liveRegion.textContent = message;

// Usage:
_announce("Step 2 of 5: Theme selection");        // on page change
_announce("Validation error: please select a capacity");  // on validation failure
_announce("Creating workspace — step 1 of 6");     // on execution start
_announce("Wizard minimized. Click badge to restore."); // on minimize
```

### 7.6 Reduced Motion Support

```css
@media (prefers-reduced-motion: reduce) {
  .iw-overlay,
  .iw-dialog,
  .iw-page,
  .iw-step-circle,
  .iw-step-connector-fill,
  .iw-next-btn,
  .iw-back-btn {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }

  .iw-step-item.active .iw-step-circle {
    animation: none;
    box-shadow: 0 0 0 3px var(--accent-glow);   /* static glow instead of pulse */
  }
}
```

---

## 8. Error Handling

### 8.1 Error Taxonomy

| Error Category | Trigger | User-Facing Message | Recovery |
|---------------|---------|---------------------|----------|
| **Auth missing** | `open()` called without bearer token | "Authentication required — connect to Fabric first" | Toast notification. Do not open wizard. |
| **Concurrent wizard** | `open()` called while another wizard is active | "A wizard is already running — one at a time" | Toast + flash/restore existing wizard. |
| **Validation: empty workspace name** | Next click on Page 1, name is blank | "Workspace name is required" | Highlight field, focus field. |
| **Validation: invalid workspace name** | Name contains invalid characters | "Workspace name can only contain letters, numbers, and underscores" | Highlight field, focus field. |
| **Validation: no capacity selected** | Next click on Page 1, no capacity | "Please select a capacity" | Highlight dropdown, focus dropdown. |
| **Validation: no theme selected** | Next click on Page 2, no theme | "Please select a data theme" | Flash theme grid. |
| **Validation: empty DAG** | Next click on Page 3, no nodes on canvas | "Add at least one node to the DAG canvas" | Flash empty canvas area. |
| **Validation: disconnected graph** | Next on Page 3, orphaned MLV nodes with no parents | "Some MLV nodes have no parent connections — all MLVs need at least one source" | Highlight orphaned nodes in red. |
| **Execution: workspace name conflict** | Create Workspace API returns 409 | "Workspace 'X' already exists — go back and choose a different name" | Show "Back to Setup" button on error panel. Auto-navigate to Page 1 if user clicks. |
| **Execution: capacity quota exceeded** | Assign Capacity API returns 403 | "Capacity quota exceeded — the selected capacity cannot accept more workspaces" | Show "Back to Setup" button. |
| **Execution: lakehouse creation failed** | Create Lakehouse API returns 4xx/5xx | "Failed to create lakehouse: {error detail}" | Retry button on failed step. |
| **Execution: notebook creation failed** | Create Notebook API returns 4xx/5xx | "Failed to create notebook: {error detail}" | Retry button on failed step. |
| **Execution: cell write failed** | Update Definition API returns 4xx/5xx | "Failed to write notebook cells: {error detail}" | Retry button on failed step. |
| **Execution: notebook run timeout** | LRO polling exceeds 10 minutes | "Notebook execution timed out after 10 minutes" | Retry button. Show partial results if available. |
| **Execution: notebook run failed** | LRO returns failed status | "Notebook execution failed: {failure reason}" | Show failure details. Retry button. |
| **Execution: network error** | fetch() throws TypeError | "Network error — check your connection and try again" | Retry button. |
| **Rollback: partial cleanup** | Delete workspace/lakehouse fails during rollback | "Rollback partially failed — some resources may need manual cleanup: {resource list}" | Show list of resources that were not cleaned up. |
| **Template: load failed** | Template JSON parse error | "Template file is corrupted — delete and recreate" | Offer to delete the corrupted template. |
| **Template: save failed** | Backend write error | "Failed to save template — check disk space" | Retry option. |

### 8.2 Error Display Patterns

**Inline field validation (Pages 1–3):**
```pseudocode
// Error text appears directly below the invalid field
// Uses the existing .form-hint pattern but in error color
<div class="iw-field-error" style="color: var(--status-fail); font-size: var(--text-xs);">
  Workspace name can only contain letters, numbers, and underscores
</div>
```

**Page-level validation toast (when Next is blocked):**
```pseudocode
// Brief toast at top of page container
<div class="iw-validation-toast" role="alert">
  <span class="iw-toast-icon">!</span>
  <span class="iw-toast-msg">Please select a data theme</span>
</div>
// Auto-dismiss after 3 seconds
```

**Execution step error (Page 5):**
```pseudocode
// Failed step auto-expands with error detail
<div class="iw-step-error">
  <div class="iw-error-summary">
    <strong>Failed:</strong> Create Lakehouse
  </div>
  <div class="iw-error-detail">
    POST /v1/workspaces/{wsId}/lakehouses
    <span class="iw-error-status">409 Conflict</span>
    Lakehouse 'brave_turing_42_lh' already exists in this workspace.
  </div>
  <div class="iw-error-actions">
    <button class="btn btn-ghost">Back to Setup</button>
    <button class="btn btn-primary">Retry Step</button>
  </div>
</div>
```

### 8.3 Error Recovery Matrix

| Error State | Recovery Option 1 | Recovery Option 2 | Automatic Action |
|-------------|-------------------|-------------------|------------------|
| Validation failure | Fix field, retry Next | — | Focus invalid field |
| Workspace name conflict | Edit name, retry | — | Navigate to Page 1 |
| API error during execution | Retry from failed step | Close (triggers rollback) | Auto-expand failed step detail |
| Network error | Retry (same step) | Minimize, try later | Show retry countdown (30s) |
| Rollback failure | Show manual cleanup guide | — | Log failed cleanup resources |
| Timeout | Retry | Close | Show elapsed time |

---

## 9. Performance

### 9.1 Rendering Budget

| Metric | Budget | Rationale |
|--------|--------|-----------|
| **Dialog open (DOM creation + mount)** | < 50ms | User expects instant response to click. |
| **Page transition (slide animation)** | 360ms (fixed by design) | CSS-driven, no JS render during animation. |
| **Stepper update** | < 5ms | Small DOM mutations (class toggles). |
| **Footer update** | < 2ms | Single innerHTML or class swap. |
| **Full wizard state serialization** | < 10ms | For template save, JSON.stringify of state. |
| **Validation (per page)** | < 20ms | Synchronous field checks, no API calls (except workspace name uniqueness which is async). |

### 9.2 DOM Node Budget

| Component | Estimated Nodes | Notes |
|-----------|-----------------|-------|
| Overlay | 1 | Single div |
| Dialog container | 1 | Single div |
| Title bar | ~8 | Title text, icon SVG, close button, drag hint |
| Stepper | ~35 | 5 × (group + circle + num + check + label) + 4 × (connector + fill) |
| Page container | 1 | Wrapper div |
| Pages (5 empty shells) | 5 | Page divs (content is child component responsibility) |
| Footer | ~5 | Container + back btn + next btn + spacer |
| Resize handles | 8 | One per edge/corner |
| **Total (dialog chrome only)** | **~64** | Excludes page content |

The wizard dialog chrome adds ~64 DOM nodes. Each page component adds its own nodes on top of this. The heaviest page is the DAG canvas (Page 3), which is capped at 100 nodes × ~8 DOM elements per node = ~800 plus SVG paths. Total wizard DOM at maximum capacity: ~1,200 nodes (well within performance budget).

### 9.3 Memory Budget

| Item | Size | Notes |
|------|------|-------|
| WizardState object | < 50KB | At 100 nodes max. |
| DOM tree (dialog chrome) | ~20KB | Minimal. |
| Event listeners | ~15 (dialog-level) | Keyboard, drag, resize, click handlers. |
| Timers | 1–2 | Elapsed time counter during execution. |

### 9.4 Animation Performance

All animations use **GPU-accelerated properties only**: `transform`, `opacity`, `box-shadow`. No animations trigger layout or paint (no `width`, `height`, `top`, `left` animations on the dialog during transitions — those are handled via `transform`).

Exception: resize is applied via `width`/`height` style changes. This is intentional — resize is a user-initiated continuous action, not an animation, and the dialog content needs to reflow. Use `requestAnimationFrame` to batch resize updates.

---

## 10. Implementation Notes

### 10.1 Reusability from Code Audit

Based on the P0 code audit (`research/p0-code-audit.md`), InfraWizardDialog has **HIGH reusability** (§4 Reusability Matrix, row C1):

| Existing Pattern | Source File | What to Reuse | Adaptation |
|-----------------|-------------|---------------|------------|
| **Modal overlay + backdrop blur** | `command-palette.js` lines ~490–520, `command-palette.css` `.cp-backdrop` | Overlay pattern: fixed inset, backdrop-filter, z-index stacking | Change `rgba(0,0,0,0.3)` to `rgba(0,0,0,0.18)`. Add blur increase from 4px→8px. |
| **Dialog entrance animation** | `deploy.css` `.deploy-dialog-scale` (spring curve) | Scale + fade entrance with spring easing | Change to `scale(0.94) + translateY(16px)` per mock. |
| **Stepper CSS** | `deploy.css` `.deploy-step`, `.step-icon-wrap`, `.step-connector` | Circle + connector progress pattern with done/active/failed states | Adjust circle size from 36px→30px. Change to 5 horizontal steps. Add step labels. |
| **Carousel navigation** | `onboarding.js` `_goToSlide()` | Toggle `.active` class on indexed children | Extend with directional slide animations (the carousel only does dots, no slide). |
| **Close/Escape handling** | `command-palette.js` Escape listener | Document keydown → close pattern | Add dirty-state confirmation dialog. |
| **Callback pattern** | `deploy-flow.js` `this.onUpdate` | Property-based callbacks for inter-module communication | Same pattern: `this.onComplete`, `this.onClose`, etc. |
| **Template literals for DOM** | All modules | `innerHTML = \`...\`` pattern | Same approach for all wizard DOM generation. |
| **Elapsed timer** | `deploy-flow.js` `_startElapsedTimer()` | `setInterval` + `_startTime` for duration display | Reuse directly for execution pipeline per-step timers. |

**What's genuinely new (no existing pattern):**

| Feature | Notes |
|---------|-------|
| Resize handles | No existing module supports resize. Build from scratch with `pointerdown`/`pointermove`/`pointerup` on invisible hit areas. |
| Drag via title bar | No drag-and-drop exists. Use `pointer` events on `.iw-header`, constrain to viewport. |
| Minimize-to-badge transition | Entirely new animation pattern. Dialog scales down + fades, badge slides up from bottom-right. |
| Multi-page navigation with slide transitions | Onboarding has carousel dots, but no directional slide. Build slide-left/slide-right from scratch. |
| Focus trap | No focus management exists in codebase. Implement from scratch following WAI-ARIA dialog pattern. |
| Session geometry persistence | No dialog position/size memory. Use `sessionStorage` for current session. |

### 10.2 File Structure

```
src/frontend/
├── css/
│   └── infra-wizard.css          ← All wizard chrome styles (overlay, dialog, stepper, footer, resize)
├── js/
│   └── infra-wizard.js           ← InfraWizardDialog class + page orchestration
```

The InfraWizardDialog class goes in `infra-wizard.js`. Child page components (C02–C10) will be in the same file or split into `dag-engine.js` and `code-gen.js` per the code audit recommendation (§5.3).

### 10.3 Build Integration

Add to `scripts/build-html.py`:

**CSS_MODULES** — insert after `onboarding.css`:
```python
"css/infra-wizard.css",
```

**JS_MODULES** — insert before `main.js`:
```python
"js/infra-wizard.js",
```

### 10.4 Z-Index Stack

```
Layer 0:   Main app (sidebar, tabs, content)         z-index: 0–100
Layer 1:   Dropdowns, context menus                  z-index: 200
Layer 2:   Command palette                           z-index: 300
Layer 3:   Toast notifications                       z-index: 400
Layer 4:   ████ Infra Wizard overlay + dialog ████   z-index: 500  ← NEW
Layer 5:   ████ Floating Badge ████                  z-index: 600  ← NEW
Layer 6:   Onboarding overlay (first-run only)       z-index: 9000
```

### 10.5 Priority & Implementation Order

InfraWizardDialog is **Layer 0** in the implementation order (§13 of master spec). It must be built first because all 14 child components mount inside it. Implement in this order:

1. **Skeleton dialog** — overlay + container + title bar + close button (no resize, no drag)
2. **Stepper** — 5 circles + connectors + active/completed states
3. **Page container** — 5 empty page slots with slide transitions
4. **Footer** — Back/Next buttons with contextual label switching
5. **Navigation logic** — goToPage(), validation gate, state collection
6. **Drag** — pointer events on title bar
7. **Resize** — pointer events on edge/corner handles
8. **Minimize/restore** — hide/show with FloatingBadge creation
9. **Focus trap** — Tab cycling, Escape handling
10. **Session geometry** — save/load position/size to sessionStorage
11. **Close confirmation** — dirty state dialog
12. **Keyboard shortcuts** — Ctrl+Enter, Alt+arrows
13. **ARIA** — roles, labels, live region announcements
14. **Reduced motion** — prefers-reduced-motion media query

### 10.6 Testing Checklist

| Test | Type | Description |
|------|------|-------------|
| Open/close lifecycle | Unit | Verify DOM creation and removal, singleton guard. |
| Forward navigation with validation | Unit | Mock page validation, verify blocked/allowed transitions. |
| Backward navigation preserves state | Unit | Set state on page, navigate back, verify state intact. |
| Step click jump-back | Unit | Complete steps 1–3, click step 1, verify navigation. |
| Slide transition direction | Visual | Forward → slideLeft, backward → slideRight. |
| Minimize/restore | Integration | Minimize during execution, verify badge appears, click badge, verify dialog restores. |
| Close during execution | Integration | Verify close → minimize (not destroy). |
| Close with dirty state | Integration | Enter data, press Escape, verify confirmation dialog. |
| Close with clean state | Integration | Open wizard, immediately press Escape, verify instant close. |
| Drag within viewport | Manual | Drag dialog to edges, verify 48px header constraint. |
| Resize min/max | Manual | Resize to min (640×480), verify content doesn't break. Resize to max (90vw×90vh). |
| Double-click re-center | Manual | Drag dialog off-center, double-click title bar, verify re-center. |
| Focus trap | A11y | Tab through dialog, verify focus doesn't escape to background. |
| Escape key | A11y | Press Escape at each state, verify correct behavior. |
| Screen reader | A11y | Navigate with NVDA/VoiceOver, verify announcements. |
| Concurrent wizard block | Integration | Open wizard, try to open second, verify block + toast. |
| Window resize | Integration | Resize browser window, verify dialog stays within bounds. |
| Reduced motion | A11y | Enable prefers-reduced-motion, verify no animations. |
| Performance: open time | Perf | Measure DOM creation + mount < 50ms. |
| Performance: transition | Perf | Measure no dropped frames during 360ms page slide. |

### 10.7 Open Questions (None — All Resolved)

All design decisions for InfraWizardDialog have been resolved through the P0 research:

| Question | Resolution | Source |
|----------|------------|--------|
| Horizontal vs vertical stepper? | **Horizontal** — numbered circles with connecting line | P0.5 §1.1, industry consensus |
| Click-outside behavior? | **Blocked** — no close on click-outside | P0.5 §2.2, Azure pattern |
| Dialog dimensions? | **920×680 default** (mock uses `min(920px, 88vw)` × `min(680px, 88vh)`) | P0.5 §2.1, mock line 150 |
| Backdrop style? | **blur(8px) + rgba(0,0,0,0.18)** | Mock line 130, 142–143 |
| Page transition style? | **Directional slide + fade, 360ms** | P0.5 §1.4, mock line 248 (`--t-page: 360ms`) |
| Stepper clickable? | **Yes, completed steps only** | P0.5 §1.1, mock lines 1543–1548 |
| Minimize target? | **FloatingBadge (C11)** — bottom-right pill | P0.5 §6, mock lines 774–795 |
| Close during execution? | **Minimize, not close** | Master spec §8 rule "Close dialog during execution = minimize" |
| Entrance animation? | **scale(0.94) translateY(16px) with spring curve** | Mock line 131 (`dialogIn` keyframe), line 154 (`450ms var(--spring)`) |
| Footer button labels? | Pages 1–3: "Next →", Page 4: "Lock In & Create ▶", Page 5: hidden | Mock lines 1525–1538 |

---

## Appendix A: Mock HTML Cross-Reference

This table maps spec elements to specific lines in the CEO-approved mock (`mocks/infra-wizard.html`) to ensure pixel-perfect fidelity.

| Spec Element | Mock CSS Lines | Mock HTML Lines | Mock JS Lines |
|-------------|---------------|-----------------|---------------|
| Overlay | 139–144 (`.overlay`) | 852 (`<div class="overlay">`) | — |
| Dialog container | 149–157 (`.dialog`) | 853 (`<div class="dialog">`) | — |
| Title bar | 160–184 (`.dialog-header`, `.dialog-title`, `.close-btn`) | 856–863 | — |
| Drag hint | 168–171 (`.drag-hint`) | 857 | — |
| Stepper | 188–235 (`.stepper`, `.step-*`) | 866–901 | 1509–1519 (step update) |
| Step circles | 198–216 (`.step-circle`, states) | 868–900 | 1543–1548 (click handler) |
| Step connectors | 224–234 (`.step-connector`, `.fill`) | 873, 880, 887, 894 | 1515–1519 (fill toggle) |
| Page container | 240–242 (`.page-container`) | 904 | — |
| Page transition | 243–261 (`.page`, `.active`, `.exit-left`) | — | 1486–1522 (`goToPage()`) |
| Page content padding | 258–260 (`.page-content`) | 908 | — |
| Footer | 265–270 (`.dialog-footer`) | 1431–1435 | 1525–1538 (`updateFooter()`) |
| Btn primary | 278–284 (`.btn-primary`) | 1434 | — |
| Btn ghost (Back) | 286–289 (`.btn-ghost`) | 1432 | — |
| Btn create | 295–301 (`.btn-create`) | — (dynamically set) | 1529 |
| Overlay entrance anim | 130 (`@keyframes overlayIn`) | — | — |
| Dialog entrance anim | 131 (`@keyframes dialogIn`) | — | — |
| Check pop anim | 122 (`@keyframes checkPop`) | — | — |
| Connector fill anim | — (CSS transition on `scaleX`) | — | — |
| Slide left | 113 (`@keyframes slideLeft`) | — | 1495 (exit-left) |
| Slide right | 114 (`@keyframes slideRight`) | — | 1496 (exit-right) |
| Pulse accent | 117 (`@keyframes pulseAccent`) | — | — |
| Content stagger | 813–824 (`.page.active .form-group:nth-child`) | — | — |
| Floating badge | 774–795 (`.floating-badge`, `.badge-*`) | 1416–1424 | — |
| Badge slide anim | 125 (`@keyframes badgeSlide`) | — | — |

## Appendix B: Design Token Reference

All design tokens used by InfraWizardDialog, sourced from the mock's `:root` block (lines 15–90):

| Token | Value | Usage |
|-------|-------|-------|
| `--surface` | `#ffffff` | Dialog background, header/footer background |
| `--surface-2` | `#f8f9fb` | Hover states, secondary backgrounds |
| `--surface-3` | `#ebedf0` | Drag hint, inactive step borders, resize handle bg |
| `--border` | `rgba(0,0,0,0.06)` | Dialog border, header/footer dividers |
| `--border-bright` | `rgba(0,0,0,0.12)` | Button borders, step circle inactive border |
| `--text` | `#1a1d23` | Primary text, title |
| `--text-dim` | `#5a6070` | Back button text, secondary labels |
| `--text-muted` | `#8e95a5` | Close button, step labels, inactive step numbers |
| `--accent` | `#6d5cff` | Active step, Next button bg, title icon |
| `--accent-dim` | `rgba(109,92,255,0.07)` | Active step circle background |
| `--accent-glow` | `rgba(109,92,255,0.15)` | Step pulse glow, focus ring |
| `--status-ok` | `#18a058` | Completed step circle, connector fill |
| `--status-ok-glow` | `rgba(24,160,88,0.15)` | Completed step glow |
| `--status-fail` | `#e5453b` | Error messages, discard button |
| `--r-md` | `6px` | Button border-radius, close button radius |
| `--r-xl` | `14px` | Dialog border-radius |
| `--r-full` | `100px` | Badge pill radius |
| `--sp-1` through `--sp-10` | `4px` through `40px` | 4px grid spacing |
| `--shadow-dialog` | `0 24px 80px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.08)` | Dialog elevation |
| `--ease` | `cubic-bezier(0.4, 0, 0.2, 1)` | Standard easing |
| `--spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Spring/bounce easing |
| `--t-fast` | `80ms` | Button hover transitions |
| `--t-normal` | `150ms` | Standard transitions |
| `--t-page` | `360ms` | Page slide transition duration |
| `--font` | `'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif` | All text |
| `--text-xs` | `10px` | Step labels |
| `--text-sm` | `12px` | Step circle numbers |
| `--text-md` | `13px` | Button text |
| `--text-lg` | `15px` | Dialog title |

## Appendix C: State Transition Quick Reference

```
closed ──open()──→ initializing ──450ms──→ page-0-active
                                           ↕ next/back
                                          page-1-active
                                           ↕ next/back
                                          page-2-active
                                           ↕ next/back
                                          page-3-active
                                           ↓ lock-in
                                          page-4-active ──success──→ completed ──close──→ closed
                                           ↓ minimize      ↓ fail
                                          minimized       error ──retry──→ page-4-active
                                           ↓ badge-click    ↓ close
                                          page-4-active   rolling-back ──done──→ closed

Any page (dirty) ──close/escape──→ closing-confirm ──confirm──→ closed
                                                    ──cancel──→ (previous)
Any page (clean) ──close/escape──→ closed
page-4-active    ──close/escape──→ minimized (execution continues)
```

---

*Spec authored by Pixel (JS/CSS) + Sana (Architecture Review)*
*Cross-reviewed against P0.1 Code Audit and P0.5 Wizard Research*
*Mock reference: `mocks/infra-wizard.html` (CEO-approved visual contract)*
