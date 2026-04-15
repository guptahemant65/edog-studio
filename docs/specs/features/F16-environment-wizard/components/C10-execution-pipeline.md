# C10-ExecutionPipeline — Component Deep Spec

> **Component ID**: C10  
> **Parent Feature**: F16 — New Environment Wizard  
> **Wizard Page**: Page 5 of 5 — Execution & Results  
> **Owner Agent**: Pixel (primary), Vex (API integration)  
> **Priority**: P1 — Core Execution Engine  
> **Status**: Draft  
> **Spec Version**: 1.0.0  
> **Last Updated**: 2025-07-14  
> **Estimated Complexity**: XL (~1200–1500 LOC)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [State Machine](#4-state-machine)
5. [Scenarios](#5-scenarios)
6. [Visual Spec](#6-visual-spec)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Error Handling](#8-error-handling)
9. [Performance](#9-performance)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Overview

### 1.1 Purpose

The `ExecutionPipeline` component is the heart of F16's Page 5 — the final wizard page where all user-configured environment parameters are transformed into real Fabric resources through a sequential, observable, retry-capable execution pipeline. It provides a **GitHub Actions–style progress view** that visualizes each API call as a discrete step in a vertical pipeline, showing real-time status, elapsed timers, expandable log output, and clear error messaging.

This is NOT a passive spinner. It is a fully interactive execution monitor that gives users transparency into exactly what is happening, what has succeeded, what is running, and what (if anything) has failed. The design philosophy is borrowed directly from GitHub Actions, where each step in a CI/CD pipeline is a collapsible row with status indicators, timing information, and log output.

### 1.2 Design Philosophy

The execution view embodies three core principles drawn from the P0 wizard research:

1. **Transparency Over Opacity**: Every API call is visible. No "please wait" black boxes. The user sees "Creating Workspace..." → "✓ Workspace Created (2.3s)" in real time.

2. **Resilience Over Brittleness**: Network failures, API errors, and timeouts are expected, not exceptional. Every step has retry logic. Failed steps show actionable error messages. The pipeline supports "Retry from Failed Step" — skipping all previously completed steps.

3. **Progressive Disclosure**: Running steps are auto-expanded with live log output. Completed steps are collapsed with a green checkmark and duration badge. Failed steps are auto-expanded with error details and a retry button. Pending steps show a muted indicator.

### 1.3 Component Relationships

```
┌─────────────────────────────────────────────────────────────┐
│  WizardShell (C01)                                          │
│  ├── WizardStepper (C02) — shows Page 5 active              │
│  └── Page 5 Container                                       │
│      └── ExecutionPipeline (C10) ◄── THIS COMPONENT         │
│          ├── PipelineStep × 6 (internal subcomponent)        │
│          │   ├── StepStatusIcon                              │
│          │   ├── StepInfo (name + elapsed timer)             │
│          │   ├── StepExpandToggle                            │
│          │   └── StepDetail (expandable log panel)           │
│          ├── PipelineSummary (post-completion footer)         │
│          ├── FloatingBadge (C11) — minimized state           │
│          └── ErrorPanel (failure state overlay)              │
│              ├── ErrorMessage                                │
│              ├── RetryButton                                 │
│              └── RollbackButton                              │
└─────────────────────────────────────────────────────────────┘
```

### 1.4 Dependencies

| Dependency | Type | Purpose |
|------------|------|---------|
| `FabricApiClient` (`api-client.js`) | Runtime | All 6 API calls route through this client |
| `WizardShell` (C01) | Parent | Provides execution context, handles page transitions |
| `WizardStepper` (C02) | Sibling | Shows Page 5 as active during execution |
| `FloatingBadge` (C11) | Child | Minimized execution view when wizard is closed mid-run |
| `WizardDataBus` (C03) | Data | Receives finalized wizard config (workspace name, capacity, notebook cells, etc.) |
| `EventBus` | Runtime | Publishes execution events for external consumers (sidebar, deploy-flow integration) |
| `NotebookCellBuilder` (C09) | Data | Provides topologically sorted cell definitions for notebook content |
| `dev-server.py` proxy | Infra | Routes `/api/fabric/*` requests with Bearer token injection |

### 1.5 What This Component Does NOT Do

- **Does NOT collect user input** — all configuration is finalized on Pages 1–4.
- **Does NOT support cancel mid-execution** — CEO requirement. The close (✕) button during execution triggers minimize-to-badge, NOT cancellation.
- **Does NOT use SSE/WebSocket** — unlike the existing `DeployFlow` class which uses Server-Sent Events, the execution pipeline is **client-orchestrated**. Each step is a sequential `fetch()` call. The browser IS the orchestrator.
- **Does NOT parallelize API calls** — all 6 steps are strictly sequential. Step N+1 depends on artifacts from Step N (e.g., workspace ID from Step 1 is needed by Steps 2–6).
- **Does NOT persist state to localStorage** — if the browser tab is closed mid-execution, the pipeline state is lost. Created resources may be orphaned (documented in Error Handling §8).

### 1.6 Key Terminology

| Term | Definition |
|------|------------|
| **Pipeline** | The complete sequence of 6 API steps that create an environment |
| **Step** | A single API operation (e.g., "Create Workspace") with its own status, timer, and log |
| **Execution Context** | The immutable configuration object passed from WizardDataBus containing all user inputs |
| **Artifact** | A resource ID returned by a successful step (e.g., `workspaceId`, `notebookId`) — consumed by subsequent steps |
| **Rollback Manifest** | A list of created resources tracked during execution, used for cleanup on unrecoverable failure |
| **LRO** | Long-Running Operation — an async API pattern (HTTP 202) that requires polling for completion |
| **Retry from Failed** | Re-executing the pipeline starting at the failed step, skipping all previously completed steps |
| **Minimize** | Collapsing the wizard to a floating badge while execution continues in the background |

---


## 2. Data Model

All data structures are documented using TypeScript-style interfaces for clarity and type safety. The actual implementation uses vanilla JS classes (per ADR-002), but these interfaces define the expected shape of all data flowing through the component.

### 2.1 Execution Context (Input)

The execution context is the immutable configuration object assembled from Pages 1–4 of the wizard via `WizardDataBus`. It contains everything needed to execute all 6 pipeline steps.

```typescript
/**
 * ExecutionContext — immutable input to the pipeline.
 * Assembled by WizardDataBus from Pages 1–4.
 * Frozen with Object.freeze() before pipeline start.
 */
interface ExecutionContext {
  /** Display name for the new workspace (from Page 1) */
  workspaceName: string;

  /** Optional description for the workspace */
  workspaceDescription: string;

  /** Capacity GUID to assign (from Page 2 CapacityPicker) */
  capacityId: string;

  /** Display name for the lakehouse (from Page 3) */
  lakehouseName: string;

  /** Whether to enable schema support on the lakehouse — ALWAYS true */
  enableSchemas: true;

  /** Display name for the notebook (from Page 3) */
  notebookName: string;

  /** Optional description for the notebook */
  notebookDescription: string;

  /**
   * Topologically sorted notebook cells from C09-NotebookCellBuilder.
   * Each cell contains the Spark SQL/PySpark code to execute.
   */
  notebookCells: NotebookCell[];

  /** Default Spark pool name for notebook execution (from Page 2) */
  sparkPoolName?: string;

  /** Timestamp when the wizard reached Page 5 */
  submittedAt: number;
}

/**
 * NotebookCell — a single cell in the notebook definition.
 * Cells are topologically sorted by C09 to respect table dependencies.
 */
interface NotebookCell {
  /** Unique cell identifier (e.g., "cell-create-dimCustomer") */
  id: string;

  /** Cell execution order (0-based, set by topological sort) */
  order: number;

  /** The Spark SQL or PySpark code for this cell */
  code: string;

  /** Cell language: "sparksql" | "pyspark" */
  language: 'sparksql' | 'pyspark';

  /** Human-readable label (e.g., "Create dimCustomer table") */
  label: string;

  /** Table dependencies this cell requires (for topological ordering) */
  dependsOn: string[];
}
```

### 2.2 Pipeline State

The pipeline state is the mutable core of the execution engine. It tracks the overall pipeline status, per-step state, execution artifacts, and rollback information.

```typescript
/**
 * PipelineState — the complete mutable state of the execution engine.
 * This is the single source of truth for all UI rendering decisions.
 */
interface PipelineState {
  /** Current overall pipeline status */
  status: PipelineStatus;

  /** The 6 pipeline steps with individual state */
  steps: StepState[];

  /** Artifacts collected from successful steps — consumed by later steps */
  artifacts: ExecutionArtifacts;

  /** Resources created so far — used for rollback on failure */
  rollbackManifest: RollbackManifest;

  /** Pipeline-level timing */
  timing: {
    /** Timestamp when pipeline execution started */
    startedAt: number | null;

    /** Timestamp when pipeline completed (success or failure) */
    completedAt: number | null;

    /** Total elapsed milliseconds (updated by timer interval) */
    elapsedMs: number;
  };

  /** Index of the currently executing step (0–5), or null if not running */
  activeStepIndex: number | null;

  /** Number of retry attempts on the current execution */
  retryCount: number;

  /** Maximum retry attempts per step before declaring unrecoverable */
  maxRetriesPerStep: number;

  /** Whether the wizard is minimized to floating badge */
  isMinimized: boolean;

  /** Error details if pipeline is in failed state */
  error: PipelineError | null;
}

/**
 * PipelineStatus — overall pipeline lifecycle states.
 *
 * State transitions:
 *   idle → executing → succeeded
 *   idle → executing → failed → retrying → executing → ...
 *   idle → executing → failed → rolling_back → rolled_back
 *   idle → executing → failed → rollback_failed
 */
type PipelineStatus =
  | 'idle'           // Initial state before execution starts
  | 'executing'      // Pipeline is actively running steps
  | 'succeeded'      // All 6 steps completed successfully
  | 'failed'         // A step failed, awaiting user action (retry or rollback)
  | 'retrying'       // User triggered "Retry from Failed Step"
  | 'rolling_back'   // Automatic or manual rollback in progress
  | 'rolled_back'    // Rollback completed successfully
  | 'rollback_failed'; // Rollback itself failed (worst case)
```

### 2.3 Step State

Each of the 6 pipeline steps has its own state object tracking status, timing, log output, and retry information.

```typescript
/**
 * StepState — individual state for each pipeline step.
 * There are exactly 6 StepState objects in PipelineState.steps[].
 */
interface StepState {
  /** Step index (0–5) */
  index: number;

  /** Step identifier matching the StepDefinition */
  id: StepId;

  /** Human-readable step name (e.g., "Create Workspace") */
  name: string;

  /** Current step status */
  status: StepStatus;

  /** Step-level timing */
  timing: {
    /** Timestamp when this step started executing */
    startedAt: number | null;

    /** Timestamp when this step completed (success or failure) */
    completedAt: number | null;

    /** Elapsed milliseconds for this step */
    elapsedMs: number;

    /** Formatted elapsed string (e.g., "2.3s", "1m 04s") */
    elapsedFormatted: string;
  };

  /** Log entries for the expandable detail panel */
  logs: LogEntry[];

  /** Whether the detail panel is expanded in the UI */
  isExpanded: boolean;

  /** Number of retry attempts on THIS step */
  retryCount: number;

  /** Error details if this step failed */
  error: StepError | null;

  /** HTTP status code from the API response (for diagnostics) */
  httpStatus: number | null;

  /** Whether this step was skipped during a retry (already completed) */
  skipped: boolean;
}

/**
 * StepStatus — per-step lifecycle states.
 *
 * Visual mapping:
 *   pending  → ○ (gray circle)
 *   running  → ◐ (accent, animated spinner)
 *   succeeded → ● (green circle)
 *   failed   → ✕ (red cross)
 *   skipped  → ◌ (dimmed, dashed circle)
 */
type StepStatus =
  | 'pending'    // Waiting to execute
  | 'running'    // Currently executing
  | 'succeeded'  // Completed successfully
  | 'failed'     // Failed (may be retried)
  | 'skipped';   // Skipped during retry (previously completed)

/**
 * StepId — unique identifier for each pipeline step.
 * Used for lookup, event emission, and rollback mapping.
 */
type StepId =
  | 'create-workspace'
  | 'assign-capacity'
  | 'create-lakehouse'
  | 'create-notebook'
  | 'write-cells'
  | 'execute-notebook';
```

### 2.4 Step Definition Registry

The step definition registry is a static configuration array that defines the 6 pipeline steps — their names, API details, artifact extraction, and rollback information. This is the "blueprint" that the execution engine follows.

```typescript
/**
 * StepDefinition — static configuration for a pipeline step.
 * These are defined once and never mutated.
 */
interface StepDefinition {
  /** Step identifier */
  id: StepId;

  /** Step index (0–5) */
  index: number;

  /** Human-readable name shown in the UI */
  name: string;

  /** Longer description shown in the step detail panel */
  description: string;

  /** HTTP method for the API call */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';

  /**
   * URL template for the API endpoint.
   * Supports {variable} interpolation from artifacts.
   * Example: "/v1/workspaces/{workspaceId}/lakehouses"
   */
  urlTemplate: string;

  /**
   * Function to build the request body from execution context + artifacts.
   * Returns null for steps with no body (e.g., GET requests).
   */
  buildBody: (ctx: ExecutionContext, artifacts: ExecutionArtifacts) => object | null;

  /**
   * Function to extract artifacts from a successful response.
   * Returns a partial ExecutionArtifacts object merged into the pipeline state.
   */
  extractArtifacts: (response: any) => Partial<ExecutionArtifacts>;

  /**
   * Expected HTTP status code(s) for success.
   * Most steps expect 200 or 201; async steps expect 202.
   */
  expectedStatus: number[];

  /**
   * Whether this step is a Long-Running Operation (LRO).
   * If true, the step returns 202 and requires polling for completion.
   */
  isLRO: boolean;

  /**
   * Polling configuration for LRO steps.
   * Only relevant when isLRO is true.
   */
  lroConfig?: LROConfig;

  /**
   * Whether this step creates a resource that should be tracked
   * in the rollback manifest.
   */
  createsResource: boolean;

  /**
   * Resource type for rollback manifest tracking.
   * Used to determine the correct DELETE endpoint during rollback.
   */
  resourceType?: RollbackResourceType;

  /**
   * Maximum time (ms) to wait for this step before timeout.
   * Includes LRO polling time for async steps.
   */
  timeoutMs: number;

  /**
   * Number of automatic retries before declaring step failure.
   * Separate from user-initiated "Retry from Failed Step".
   */
  autoRetries: number;

  /**
   * Delay between automatic retries (ms).
   * Uses exponential backoff: delay * 2^attemptNumber.
   */
  retryDelayMs: number;
}

/**
 * LROConfig — configuration for Long-Running Operation polling.
 */
interface LROConfig {
  /** Polling interval in milliseconds */
  pollIntervalMs: number;

  /** Maximum polling duration before timeout (ms) */
  maxPollDurationMs: number;

  /**
   * Function to extract the polling URL from the initial 202 response.
   * Typically reads the Location header.
   */
  extractPollUrl: (response: Response, artifacts: ExecutionArtifacts) => string;

  /**
   * Function to determine if the LRO has completed.
   * Returns the terminal status or null if still in progress.
   */
  checkCompletion: (pollResponse: any) => LROResult | null;
}

/**
 * LROResult — terminal result of a Long-Running Operation.
 */
interface LROResult {
  /** Whether the LRO completed successfully */
  succeeded: boolean;

  /** Status string from the API (e.g., "Completed", "Failed") */
  status: string;

  /** Response payload from the final poll */
  payload: any;

  /** Error message if failed */
  errorMessage?: string;
}
```

### 2.5 Execution Artifacts

Artifacts are resource identifiers collected from successful steps and consumed by subsequent steps. This object grows as the pipeline progresses.

```typescript
/**
 * ExecutionArtifacts — resource IDs collected during pipeline execution.
 * Each step may produce artifacts consumed by later steps.
 * Also used for rollback (knowing what resources to delete).
 */
interface ExecutionArtifacts {
  /** Workspace GUID from Step 1 (Create Workspace) */
  workspaceId: string | null;

  /** Workspace object ID (may differ from GUID in metadata API) */
  workspaceObjectId: string | null;

  /** Capacity GUID confirmed by Step 2 (Assign Capacity) */
  capacityId: string | null;

  /** Lakehouse GUID from Step 3 (Create Lakehouse) */
  lakehouseId: string | null;

  /** Notebook GUID from Step 4 (Create Notebook) */
  notebookId: string | null;

  /** Job instance ID from Step 6 (Execute Notebook) — for LRO polling */
  jobInstanceId: string | null;

  /** Final notebook run status from LRO polling */
  notebookRunStatus: string | null;

  /**
   * Workspace URL for post-success navigation.
   * Constructed from workspaceId: `/groups/{workspaceId}`
   */
  workspaceUrl: string | null;
}
```

### 2.6 Rollback Manifest

The rollback manifest tracks every resource created during pipeline execution so they can be cleaned up in reverse order if an unrecoverable failure occurs.

```typescript
/**
 * RollbackManifest — tracks created resources for cleanup.
 * Resources are added in creation order and deleted in reverse order.
 */
interface RollbackManifest {
  /** Ordered list of created resources */
  resources: RollbackResource[];

  /** Whether a rollback has been attempted */
  rollbackAttempted: boolean;

  /** Results of each rollback step */
  rollbackResults: RollbackResult[];
}

/**
 * RollbackResource — a single resource that can be rolled back.
 */
interface RollbackResource {
  /** Resource type determines the DELETE endpoint */
  type: RollbackResourceType;

  /** Resource GUID */
  id: string;

  /** Human-readable name for log output */
  displayName: string;

  /** The step that created this resource */
  createdByStep: StepId;

  /** Timestamp when the resource was created */
  createdAt: number;

  /** Parent workspace ID (needed for sub-resource DELETE URLs) */
  parentWorkspaceId?: string;
}

/**
 * RollbackResourceType — enumeration of resource types that can be rolled back.
 * Maps to specific DELETE API endpoints.
 */
type RollbackResourceType = 'workspace' | 'lakehouse' | 'notebook';

/**
 * RollbackResult — outcome of attempting to delete a resource during rollback.
 */
interface RollbackResult {
  /** The resource that was targeted for deletion */
  resource: RollbackResource;

  /** Whether the deletion succeeded */
  succeeded: boolean;

  /** HTTP status code from the DELETE call */
  httpStatus: number | null;

  /** Error message if deletion failed */
  errorMessage?: string;

  /** Elapsed time for the DELETE call */
  elapsedMs: number;
}
```

### 2.7 Log Entry

Log entries are structured messages displayed in the expandable detail panel for each step.

```typescript
/**
 * LogEntry — a single log line in a step's detail panel.
 * Rendered as monospace text with optional severity coloring.
 */
interface LogEntry {
  /** Timestamp when the log entry was created */
  timestamp: number;

  /** Log severity level — affects text color in the UI */
  level: 'info' | 'success' | 'warning' | 'error' | 'debug';

  /** The log message text */
  message: string;

  /**
   * Optional structured data attached to the log entry.
   * Rendered as a collapsed JSON block in the detail panel.
   */
  data?: Record<string, any>;
}
```

### 2.8 Pipeline Error

```typescript
/**
 * PipelineError — detailed error information when the pipeline fails.
 * Used to render the error panel and determine available recovery actions.
 */
interface PipelineError {
  /** The step that failed */
  failedStepId: StepId;

  /** The step index (0–5) */
  failedStepIndex: number;

  /** Human-readable error message */
  message: string;

  /** Raw error from the API response or network failure */
  rawError: string;

  /** HTTP status code if available */
  httpStatus: number | null;

  /** Whether this error is retryable */
  isRetryable: boolean;

  /** Whether rollback is recommended */
  shouldRollback: boolean;

  /** Suggested action for the user */
  suggestedAction: 'retry' | 'rollback' | 'manual';

  /** Number of retries already attempted */
  retryAttempts: number;

  /** Timestamp when the error occurred */
  occurredAt: number;

  /**
   * Error category for grouping and handling.
   * Determines the error panel messaging and available actions.
   */
  category: ErrorCategory;
}

/**
 * ErrorCategory — classification of pipeline errors.
 * Each category has different retry/rollback behavior.
 */
type ErrorCategory =
  | 'network'          // Network failure (fetch error, DNS, timeout)
  | 'auth'             // 401/403 — token expired or insufficient permissions
  | 'conflict'         // 409 — resource already exists
  | 'not_found'        // 404 — dependency resource not found
  | 'rate_limit'       // 429 — API rate limiting
  | 'server_error'     // 5xx — Fabric API server error
  | 'validation'       // 400 — invalid request body
  | 'lro_timeout'      // LRO polling exceeded maxPollDurationMs
  | 'lro_failed'       // LRO completed with Failed status
  | 'unknown';         // Unclassified error
```

### 2.9 Callback and Event Types

```typescript
/**
 * PipelineCallbacks — callback functions provided by the parent (WizardShell).
 * These are the primary communication channel from ExecutionPipeline to its parent.
 */
interface PipelineCallbacks {
  /** Called when pipeline execution starts */
  onStart: () => void;

  /**
   * Called on every state change (step start, step complete, error, etc.).
   * Receives the full pipeline state for the parent to react to.
   */
  onUpdate: (state: PipelineState) => void;

  /** Called when all 6 steps complete successfully */
  onSuccess: (artifacts: ExecutionArtifacts) => void;

  /** Called when a step fails */
  onFailure: (error: PipelineError) => void;

  /** Called when the user clicks "Retry from Failed Step" */
  onRetry: (fromStepIndex: number) => void;

  /** Called when rollback starts */
  onRollbackStart: () => void;

  /** Called when rollback completes (success or failure) */
  onRollbackComplete: (manifest: RollbackManifest) => void;

  /** Called when the user minimizes the wizard during execution */
  onMinimize: () => void;

  /** Called when the user restores the wizard from the floating badge */
  onRestore: () => void;

  /** Called when the user clicks "Navigate to Workspace" after success */
  onNavigate: (workspaceUrl: string) => void;
}

/**
 * PipelineEvent — events emitted via EventBus for external consumers.
 * These events allow the sidebar, deploy-flow, and other components
 * to react to pipeline state changes without tight coupling.
 */
interface PipelineEvent {
  /** Event type identifier */
  type: PipelineEventType;

  /** Full pipeline state snapshot at the time of the event */
  state: PipelineState;

  /** Timestamp of the event */
  timestamp: number;

  /** Optional additional data specific to the event type */
  detail?: Record<string, any>;
}

type PipelineEventType =
  | 'pipeline:start'
  | 'pipeline:step:start'
  | 'pipeline:step:complete'
  | 'pipeline:step:failed'
  | 'pipeline:step:retry'
  | 'pipeline:success'
  | 'pipeline:failed'
  | 'pipeline:rollback:start'
  | 'pipeline:rollback:complete'
  | 'pipeline:minimize'
  | 'pipeline:restore';
```

---


## 3. API Surface

### 3.1 Constructor

```javascript
/**
 * ExecutionPipeline — GitHub Actions-style execution view.
 *
 * @param {HTMLElement} container - Parent DOM element to render into
 * @param {ExecutionContext} context - Immutable wizard configuration
 * @param {PipelineCallbacks} callbacks - Event callbacks for parent communication
 * @param {object} options - Optional configuration overrides
 */
class ExecutionPipeline {
  constructor(container, context, callbacks, options = {}) {
    /** @type {HTMLElement} */
    this._container = container;

    /** @type {ExecutionContext} Frozen on construction */
    this._context = Object.freeze(structuredClone(context));

    /** @type {PipelineCallbacks} */
    this._callbacks = callbacks;

    /** @type {PipelineOptions} */
    this._options = { ...ExecutionPipeline.DEFAULTS, ...options };

    /** @type {PipelineState} */
    this._state = this._createInitialState();

    /** @type {StepDefinition[]} */
    this._stepDefinitions = this._buildStepRegistry();

    /** @type {number|null} Timer interval ID */
    this._timerInterval = null;

    /** @type {AbortController|null} For cancelling in-flight fetch */
    this._abortController = null;

    /** @type {FabricApiClient} */
    this._apiClient = null; // Injected via setApiClient()

    this._render();
  }
}
```

### 3.2 Static Defaults

```javascript
ExecutionPipeline.DEFAULTS = {
  /** Maximum retries per step before declaring failure */
  maxRetriesPerStep: 3,

  /** Base retry delay in milliseconds (exponential backoff) */
  retryDelayMs: 1000,

  /** Timer update interval in milliseconds */
  timerIntervalMs: 100,

  /** Default timeout per step in milliseconds (30 seconds) */
  defaultTimeoutMs: 30_000,

  /** LRO polling interval in milliseconds */
  lroPollIntervalMs: 3000,

  /** Maximum LRO polling duration (5 minutes) */
  maxLroPollDurationMs: 300_000,

  /** Whether to auto-start execution on construction */
  autoStart: true,

  /** Whether to auto-expand the running step */
  autoExpandRunning: true,

  /** Whether to auto-expand failed steps */
  autoExpandFailed: true,

  /** Whether to collapse completed steps */
  collapseCompleted: true,

  /** Stagger delay for step entrance animations (ms per step) */
  staggerDelayMs: 50,

  /** Animation duration for step entrance (ms) */
  entranceAnimationMs: 300,

  /** Step detail panel expand/collapse animation duration (ms) */
  expandAnimationMs: 200,

  /** Minimum step display time before auto-collapsing (ms) */
  minStepDisplayMs: 500,
};
```

### 3.3 Public Methods

```javascript
/**
 * Start pipeline execution.
 * Executes all 6 steps sequentially. If called during a retry,
 * resumes from the failed step index.
 *
 * @returns {Promise<ExecutionArtifacts>} Resolves with artifacts on success
 * @throws {PipelineError} Rejects with error details on failure
 *
 * Usage:
 *   const pipeline = new ExecutionPipeline(container, context, callbacks);
 *   try {
 *     const artifacts = await pipeline.start();
 *     console.log('Environment created:', artifacts.workspaceId);
 *   } catch (error) {
 *     console.error('Pipeline failed:', error.message);
 *   }
 */
async start() → Promise<ExecutionArtifacts>

/**
 * Retry execution from the failed step.
 * All steps before the failed step are marked as 'skipped'.
 * The failed step is reset to 'pending' and re-executed.
 *
 * @throws {Error} If pipeline is not in 'failed' state
 *
 * Preconditions:
 *   - Pipeline status must be 'failed'
 *   - At least one step must have failed
 *   - retryCount must be less than maxRetriesPerStep
 *
 * Postconditions:
 *   - Pipeline status transitions to 'retrying' then 'executing'
 *   - Failed step is reset to 'pending'
 *   - Completed steps are marked as 'skipped'
 *   - Timer restarts
 */
async retryFromFailed() → Promise<ExecutionArtifacts>

/**
 * Initiate rollback of all created resources.
 * Deletes resources in reverse creation order using the rollback manifest.
 *
 * @returns {Promise<RollbackManifest>} Resolves with rollback results
 *
 * Preconditions:
 *   - Pipeline status must be 'failed' or 'rollback_failed'
 *   - rollbackManifest.resources must have at least one entry
 *
 * Postconditions:
 *   - Pipeline status transitions to 'rolling_back' then 'rolled_back' or 'rollback_failed'
 *   - All successfully created resources are deleted (best-effort)
 *   - Rollback results are recorded in the manifest
 */
async rollback() → Promise<RollbackManifest>

/**
 * Minimize the execution view to a floating badge.
 * Execution continues in the background. The badge shows
 * current step progress (e.g., "3/6 Creating Notebook").
 *
 * @emits pipeline:minimize
 *
 * Postconditions:
 *   - state.isMinimized = true
 *   - FloatingBadge (C11) is created/updated
 *   - Timer continues running
 *   - API calls continue executing
 */
minimize() → void

/**
 * Restore the execution view from the floating badge.
 * Re-renders the full pipeline UI with current state.
 *
 * @emits pipeline:restore
 *
 * Postconditions:
 *   - state.isMinimized = false
 *   - Full pipeline UI is re-rendered
 *   - Current step state is reflected (running animation, etc.)
 */
restore() → void

/**
 * Inject the FabricApiClient instance.
 * Must be called before start() if autoStart is false.
 *
 * @param {FabricApiClient} client - The API client instance
 */
setApiClient(client) → void

/**
 * Get the current pipeline state.
 * Returns a deep clone to prevent external mutation.
 *
 * @returns {PipelineState} Deep clone of current state
 */
getState() → PipelineState

/**
 * Get the execution artifacts.
 * Only meaningful after at least one step has completed.
 *
 * @returns {ExecutionArtifacts} Current artifacts
 */
getArtifacts() → ExecutionArtifacts

/**
 * Get the rollback manifest.
 * Lists all resources created during this execution.
 *
 * @returns {RollbackManifest} Current rollback manifest
 */
getRollbackManifest() → RollbackManifest

/**
 * Destroy the component and clean up resources.
 * Stops timers, aborts in-flight requests, removes DOM.
 *
 * IMPORTANT: Does NOT cancel execution or rollback resources.
 * If called during execution, in-flight fetch is aborted but
 * resources already created are NOT cleaned up.
 *
 * Usage:
 *   // Before removing the wizard
 *   pipeline.destroy();
 */
destroy() → void
```

### 3.4 Internal Methods (Private)

These methods are prefixed with `_` per project convention and are not part of the public API. They are documented here for implementation guidance.

```javascript
/** Create the initial PipelineState object */
_createInitialState() → PipelineState

/** Build the step definition registry from static config */
_buildStepRegistry() → StepDefinition[]

/** Execute a single step by index */
async _executeStep(stepIndex: number) → Promise<void>

/** Execute an LRO step with polling */
async _executeLROStep(stepDef: StepDefinition, stepState: StepState) → Promise<any>

/** Poll an LRO endpoint until completion or timeout */
async _pollLRO(pollUrl: string, lroConfig: LROConfig, stepState: StepState) → Promise<LROResult>

/** Perform a single API call with timeout and abort support */
async _apiCall(method: string, url: string, body?: object) → Promise<Response>

/** Interpolate URL template with artifact values */
_interpolateUrl(template: string, artifacts: ExecutionArtifacts) → string

/** Add a log entry to a step */
_addLog(stepIndex: number, level: string, message: string, data?: object) → void

/** Update step state and trigger re-render */
_updateStep(stepIndex: number, updates: Partial<StepState>) → void

/** Update pipeline state and notify callbacks */
_updateState(updates: Partial<PipelineState>) → void

/** Start the elapsed timer interval */
_startTimer() → void

/** Stop the elapsed timer interval */
_stopTimer() → void

/** Format elapsed milliseconds to human-readable string */
_formatElapsed(ms: number) → string

/** Classify an error into an ErrorCategory */
_classifyError(error: Error, httpStatus?: number) → ErrorCategory

/** Determine if an error is retryable based on category */
_isRetryable(category: ErrorCategory) → boolean

/** Calculate retry delay with exponential backoff */
_calculateRetryDelay(attemptNumber: number) → number

/** Add a resource to the rollback manifest */
_trackResource(type: RollbackResourceType, id: string, name: string, stepId: StepId) → void

/** Delete a single resource during rollback */
async _deleteResource(resource: RollbackResource) → Promise<RollbackResult>

/** Render the complete pipeline UI */
_render() → void

/** Re-render only the changed step (targeted DOM update) */
_renderStep(stepIndex: number) → void

/** Render the step status icon based on status */
_renderStatusIcon(status: StepStatus) → HTMLElement

/** Render the pipeline summary footer */
_renderSummary() → void

/** Render the error panel */
_renderErrorPanel(error: PipelineError) → void

/** Emit a pipeline event via EventBus */
_emitEvent(type: PipelineEventType, detail?: object) → void

/** Apply entrance animation stagger to steps */
_animateEntrance() → void

/** Scroll the container to keep the active step visible */
_scrollToActiveStep() → void
```

### 3.5 Step Definition Registry (Concrete Values)

The step registry defines the exact API configuration for each of the 6 pipeline steps. This is a static data structure — no logic, just configuration.

```javascript
const STEP_REGISTRY = [
  // ─── Step 0: Create Workspace ───────────────────────────────────
  {
    id: 'create-workspace',
    index: 0,
    name: 'Create Workspace',
    description: 'Creating a new Fabric workspace for your environment',
    method: 'POST',
    urlTemplate: '/metadata/folders',
    buildBody: (ctx, _artifacts) => ({
      capacityObjectId: ctx.capacityId,
      displayName: ctx.workspaceName,
      description: ctx.workspaceDescription || '',
      isServiceApp: false,
      datasetStorageMode: 1,
    }),
    extractArtifacts: (response) => ({
      // metadata API returns array; first item has objectId
      workspaceId: response[0]?.objectId ?? response[0]?.id,
      workspaceObjectId: response[0]?.objectId,
    }),
    expectedStatus: [200, 201],
    isLRO: false,
    createsResource: true,
    resourceType: 'workspace',
    timeoutMs: 30_000,
    autoRetries: 2,
    retryDelayMs: 1000,
  },

  // ─── Step 1: Assign Capacity ────────────────────────────────────
  {
    id: 'assign-capacity',
    index: 1,
    name: 'Assign Capacity',
    description: 'Assigning selected capacity to the workspace',
    method: 'POST',
    urlTemplate: '/v1/workspaces/{workspaceId}/assignToCapacity',
    buildBody: (ctx, _artifacts) => ({
      capacityId: ctx.capacityId,
    }),
    extractArtifacts: (_response) => ({
      capacityId: null, // Already have this from context
    }),
    expectedStatus: [200, 202],
    isLRO: false, // 202 but completes quickly, no polling needed
    createsResource: false, // Capacity assignment is reversed by workspace deletion
    timeoutMs: 30_000,
    autoRetries: 2,
    retryDelayMs: 2000,
  },

  // ─── Step 2: Create Lakehouse ───────────────────────────────────
  {
    id: 'create-lakehouse',
    index: 2,
    name: 'Create Lakehouse',
    description: 'Creating the lakehouse with schema support enabled',
    method: 'POST',
    urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses',
    buildBody: (ctx, _artifacts) => ({
      displayName: ctx.lakehouseName,
      enableSchemas: true, // Non-negotiable per spec
    }),
    extractArtifacts: (response) => ({
      lakehouseId: response.id,
    }),
    expectedStatus: [200, 201],
    isLRO: false,
    createsResource: true,
    resourceType: 'lakehouse',
    timeoutMs: 60_000, // Lakehouse creation can be slow
    autoRetries: 2,
    retryDelayMs: 2000,
  },

  // ─── Step 3: Create Notebook ────────────────────────────────────
  {
    id: 'create-notebook',
    index: 3,
    name: 'Create Notebook',
    description: 'Creating the setup notebook',
    method: 'POST',
    urlTemplate: '/v1/workspaces/{workspaceId}/notebooks',
    buildBody: (ctx, _artifacts) => ({
      displayName: ctx.notebookName,
      description: ctx.notebookDescription || 'Auto-generated by EDOG Studio',
    }),
    extractArtifacts: (response) => ({
      notebookId: response.id,
    }),
    expectedStatus: [201],
    isLRO: false,
    createsResource: true,
    resourceType: 'notebook',
    timeoutMs: 30_000,
    autoRetries: 2,
    retryDelayMs: 1000,
  },

  // ─── Step 4: Write Notebook Cells ───────────────────────────────
  {
    id: 'write-cells',
    index: 4,
    name: 'Write Notebook Cells',
    description: 'Writing table creation cells to the notebook',
    method: 'POST',
    urlTemplate: '/v1/workspaces/{workspaceId}/notebooks/{notebookId}/updateDefinition',
    buildBody: (ctx, _artifacts) => ({
      definition: {
        parts: [
          {
            path: 'notebook-content.py',
            payloadType: 'InlineBase64',
            payload: _buildNotebookPayload(ctx.notebookCells),
          },
        ],
      },
    }),
    extractArtifacts: (_response) => ({}), // No new artifacts
    expectedStatus: [200],
    isLRO: false,
    createsResource: false, // Cells are part of the notebook, not a separate resource
    timeoutMs: 30_000,
    autoRetries: 2,
    retryDelayMs: 1000,
  },

  // ─── Step 5: Execute Notebook ───────────────────────────────────
  {
    id: 'execute-notebook',
    index: 5,
    name: 'Execute Notebook',
    description: 'Running the notebook to create all lakehouse tables',
    method: 'POST',
    urlTemplate: '/v1/workspaces/{workspaceId}/items/{notebookId}/jobs/instances?jobType=RunNotebook',
    buildBody: (_ctx, _artifacts) => null, // No body for job trigger
    extractArtifacts: (response) => ({
      jobInstanceId: response?.id ?? null,
    }),
    expectedStatus: [202], // LRO — returns Location header
    isLRO: true,
    lroConfig: {
      pollIntervalMs: 3000,
      maxPollDurationMs: 300_000, // 5 minutes max
      extractPollUrl: (_response, artifacts) =>
        `/v1/workspaces/${artifacts.workspaceId}/items/${artifacts.notebookId}/jobs/instances/${artifacts.jobInstanceId}`,
      checkCompletion: (pollResponse) => {
        const status = pollResponse?.status;
        if (status === 'Completed') return { succeeded: true, status, payload: pollResponse };
        if (status === 'Failed') return { succeeded: false, status, payload: pollResponse, errorMessage: pollResponse?.failureReason?.message || 'Notebook execution failed' };
        if (status === 'Cancelled') return { succeeded: false, status, payload: pollResponse, errorMessage: 'Notebook execution was cancelled' };
        return null; // Still in progress (NotStarted, InProgress)
      },
    },
    createsResource: false, // The job is transient, not a resource to rollback
    timeoutMs: 300_000, // 5 minutes for notebook execution
    autoRetries: 1, // Only 1 auto-retry for execution (expensive operation)
    retryDelayMs: 5000,
  },
];
```

---


## 4. State Machine

### 4.1 Pipeline-Level State Machine

The pipeline state machine governs the overall lifecycle of the execution engine. All transitions are triggered by internal events — there is no external state manipulation.

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    │              ┌─────────┐                 │
                    │    ┌────────►│succeeded│                 │
                    │    │         └─────────┘                 │
                    │    │ all 6 OK                             │
                    │    │                                     │
  ┌────┐  start()  │ ┌──┴──────┐  step fails   ┌──────┐      │
  │idle│──────────►│ │executing│──────────────►│failed│      │
  └────┘           │ └──┬──────┘               └──┬───┘      │
                    │    │                         │           │
                    │    │ minimized               │ retry()   │
                    │    ▼                         ▼           │
                    │ (continues                ┌────────┐    │
                    │  in background)            │retrying│    │
                    │                            └──┬─────┘    │
                    │                               │          │
                    │                    start from │          │
                    │                    failed step│          │
                    │                               ▼          │
                    │                         ┌──────────┐     │
                    │                         │executing │─────┘
                    │                         └──────────┘
                    │
                    │  rollback()          ┌────────────┐
                    │  from 'failed' ─────►│rolling_back│
                    │                      └─────┬──────┘
                    │                            │
                    │              ┌─────────┐   │   ┌───────────────┐
                    │              │rolled_  ◄───┘   │rollback_      │
                    │              │back    │  OK     │failed         │
                    │              └────────┘  │     └───────────────┘
                    │                          │ fail
                    │                          └──────────────────────┘
                    │
                    └──────────────────────────────────────────┘
```

### 4.2 Formal Transition Table (Pipeline Level)

| Current State | Event | Next State | Guard Condition | Side Effects |
|---------------|-------|------------|-----------------|--------------|
| `idle` | `start()` called | `executing` | context is valid, apiClient is set | Start timer, emit `pipeline:start`, begin Step 0 |
| `executing` | Step N succeeds, N < 5 | `executing` | — | Update step status, emit `pipeline:step:complete`, begin Step N+1 |
| `executing` | Step 5 succeeds | `succeeded` | — | Stop timer, emit `pipeline:success`, render summary, call `onSuccess` |
| `executing` | Step N fails, retries exhausted | `failed` | step.retryCount >= maxRetriesPerStep | Stop timer on step, emit `pipeline:step:failed` then `pipeline:failed`, render error panel |
| `executing` | Step N fails, retries remaining | `executing` | step.retryCount < step.autoRetries | Increment retryCount, wait backoff delay, re-execute step N |
| `failed` | `retryFromFailed()` called | `retrying` | retryCount < maxRetriesPerStep | Reset failed step to pending, mark completed steps as skipped |
| `retrying` | Internal transition | `executing` | — | Restart timer, resume from failed step index |
| `failed` | `rollback()` called | `rolling_back` | rollbackManifest has resources | Emit `pipeline:rollback:start`, begin reverse deletion |
| `rolling_back` | All deletes succeed | `rolled_back` | — | Emit `pipeline:rollback:complete`, render rollback summary |
| `rolling_back` | Any delete fails | `rollback_failed` | — | Emit `pipeline:rollback:complete` (with failures), render rollback error |
| Any | `destroy()` called | (destroyed) | — | Stop timer, abort fetch, remove DOM, null references |

### 4.3 Step-Level State Machine

Each of the 6 steps has its own state machine that operates within the pipeline-level state machine.

```
  ┌───────┐  pipeline reaches    ┌───────┐   API call    ┌─────────┐
  │pending│─────this step───────►│running│──succeeds────►│succeeded│
  └───────┘                      └───┬───┘               └─────────┘
                                     │
                                     │ API call fails
                                     ▼
                                 ┌──────┐  auto-retry   ┌───────┐
                                 │failed│──(internal)──►│running│
                                 └──┬───┘               └───────┘
                                    │
                                    │ retries exhausted
                                    ▼
                                 ┌──────┐
                                 │failed│ (terminal for this step)
                                 └──────┘

  ┌───────┐  retry from later    ┌───────┐
  │pending│─────step called─────►│skipped│ (step was already completed)
  └───────┘                      └───────┘
```

### 4.4 Step-Level Transition Table

| Current | Event | Next | Guard | Side Effects |
|---------|-------|------|-------|--------------|
| `pending` | Pipeline reaches this step | `running` | Previous step succeeded or skipped | Start step timer, expand step, add log "Starting...", emit `pipeline:step:start` |
| `running` | API returns success status | `succeeded` | HTTP status in expectedStatus | Stop step timer, record duration, extract artifacts, add log "Completed in Xs", collapse step, emit `pipeline:step:complete` |
| `running` | API returns error, retries remaining | `running` | retryCount < autoRetries | Increment retryCount, add log "Retrying (attempt N)...", wait backoff, re-call API |
| `running` | API returns error, retries exhausted | `failed` | retryCount >= autoRetries | Stop step timer, add error log, expand step, emit `pipeline:step:failed` |
| `running` | Network timeout | `failed` | elapsed > timeoutMs | Abort fetch, add timeout log, emit `pipeline:step:failed` |
| `running` | LRO poll returns InProgress | `running` | elapsed < maxPollDurationMs | Add log "Polling... (status: InProgress)", continue polling |
| `running` | LRO poll returns Completed | `succeeded` | — | Same as API success |
| `running` | LRO poll returns Failed | `failed` | — | Same as API error with retries exhausted |
| `running` | LRO poll timeout | `failed` | elapsed > maxPollDurationMs | Add timeout log, emit `pipeline:step:failed` with category 'lro_timeout' |
| `succeeded` | Retry from later step | `skipped` | retryFromFailed() called | Visual indicator changes to dimmed |
| `failed` | retryFromFailed() for THIS step | `pending` | — | Reset retryCount, clear error, clear logs, collapse step |

### 4.5 Minimize/Restore State Transitions

The minimize/restore feature allows the user to close the wizard during execution while the pipeline continues running in the background. The floating badge (C11) shows progress.

```
  ┌───────────────┐  user clicks X    ┌──────────────┐
  │ Full Pipeline  │ ─────during──────► │ Minimized    │
  │ View (wizard)  │   execution       │ (badge only) │
  └───────────────┘                    └──────┬───────┘
         ▲                                     │
         │  user clicks badge                  │
         └─────────────────────────────────────┘
```

**Minimize behavior:**
- Pipeline execution CONTINUES in the background (JS event loop)
- Timer CONTINUES counting
- DOM is NOT destroyed — just hidden (display: none on wizard, display: flex on badge)
- `_state.isMinimized` = `true`
- FloatingBadge (C11) is updated with current step info
- Callback `onMinimize()` is invoked

**Restore behavior:**
- Full pipeline UI is re-shown (display: block on wizard, display: none on badge)
- Current step state is reflected (running animation, timer, expanded panels)
- `_state.isMinimized` = `false`
- Callback `onRestore()` is invoked

### 4.6 Post-Execution State Transitions

After the pipeline reaches a terminal state (`succeeded`, `rolled_back`, or `rollback_failed`), the UI enters a static display mode with available actions.

**On `succeeded`:**
- All steps show green checkmarks
- Total elapsed time displayed in summary footer
- "Navigate to Workspace" button appears
- "Create Another" button appears (resets wizard to Page 1)
- Clicking navigate calls `onNavigate(artifacts.workspaceUrl)`

**On `failed`:**
- Failed step shows red ✕ with auto-expanded error details
- All steps after the failed step remain as gray ○ (pending)
- Error panel appears below the pipeline with:
  - Error message (human-readable)
  - Raw error details (collapsible)
  - "Retry from Failed Step" button (if error is retryable)
  - "Rollback & Start Over" button
  - "Close" button (minimizes to badge with error state)

**On `rolled_back`:**
- Pipeline shows all steps as dimmed with "Rolled back" status
- Summary shows which resources were deleted
- "Start Over" button appears (resets wizard to Page 1)

**On `rollback_failed`:**
- Pipeline shows rollback attempt results
- Warning panel lists resources that could NOT be deleted
- Manual cleanup instructions provided
- "Try Rollback Again" button
- "Close" button

---


## 5. Scenarios

### 5.1 Happy Path — All 6 Steps Succeed

**Preconditions:**
- User has completed Pages 1–4 with valid configuration
- Fabric API is reachable and authenticated
- Selected capacity has available resources
- Workspace name is unique

**Sequence:**

```
Time  Pipeline           Step 0              Step 1              Step 2              Step 3              Step 4              Step 5
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
T+0s  idle→executing     pending→running     pending             pending             pending             pending             pending
      Timer starts       Expand, show log
      Emit start event   Log: "Creating workspace 'MyEnv'..."

T+2s                     API 200 received    pending→running     pending             pending             pending             pending
                         running→succeeded   Expand, show log
                         Collapse            Log: "Assigning capacity..."
                         Log: "✓ 2.1s"       Extract: wsId

T+3s                                         API 202 received    pending→running     pending             pending             pending
                                             running→succeeded   Expand, show log
                                             Collapse            Log: "Creating lakehouse..."
                                             Log: "✓ 1.2s"

T+6s                                                             API 201 received    pending→running     pending             pending
                                                                 running→succeeded   Expand, show log
                                                                 Collapse            Log: "Creating notebook..."
                                                                 Log: "✓ 3.4s"      Extract: lhId

T+7s                                                                                 API 201 received    pending→running     pending
                                                                                     running→succeeded   Expand, show log
                                                                                     Collapse            Log: "Writing cells..."
                                                                                     Log: "✓ 1.1s"      Extract: nbId

T+8s                                                                                                     API 200 received    pending→running
                                                                                                         running→succeeded   Expand, show log
                                                                                                         Collapse            Log: "Executing notebook..."
                                                                                                         Log: "✓ 0.9s"      API returns 202

T+8s                                                                                                                         LRO started
to                                                                                                                           Poll every 3s
T+25s                                                                                                                        Log: "Status: InProgress"
                                                                                                                             Log: "Status: InProgress"
                                                                                                                             Log: "Status: Completed"

T+25s executing→succeeded                                                                                                   running→succeeded
      Timer stops                                                                                                            Collapse
      Emit success                                                                                                           Log: "✓ 17.2s"
      Render summary
      Total: 25.3s
```

**Postconditions:**
- All 6 steps show green ● with individual durations
- Summary footer shows total elapsed time
- "Navigate to Workspace" button is active
- All artifacts populated (workspaceId, lakehouseId, notebookId, etc.)
- Rollback manifest has 3 resources (workspace, lakehouse, notebook)
- Callbacks: onStart → 6× onUpdate → onSuccess

### 5.2 Failure at Step 0 (Create Workspace) — Name Conflict

**Scenario:** User tries to create a workspace with a name that already exists.

**Trigger:** Step 0 returns HTTP 409 Conflict.

**Sequence:**

```
T+0s  idle→executing     pending→running
      Timer starts       Log: "Creating workspace 'MyEnv'..."

T+1s                     API 409 received
                         Auto-retry 1 of 2
                         Log: "⚠ Conflict (409). Retrying in 1s..."
                         Wait 1000ms

T+2s                     Auto-retry attempt 2
                         Log: "Creating workspace 'MyEnv'... (attempt 2)"

T+3s                     API 409 again
                         Auto-retry 2 of 2
                         Log: "⚠ Conflict (409). Retrying in 2s..."
                         Wait 2000ms

T+5s                     Auto-retry attempt 3
                         Log: "Creating workspace 'MyEnv'... (attempt 3)"

T+6s                     API 409 again
                         Retries exhausted
                         running→failed
                         Log: "✕ Failed: Workspace name 'MyEnv' already exists"

T+6s  executing→failed
      Timer stops
      Error panel shown:
        Message: "A workspace named 'MyEnv' already exists."
        Suggested action: "Go back to Page 1 and choose a different name."
        Buttons: [Retry] [Go Back to Page 1]
```

**Key decisions:**
- 409 is categorized as `'conflict'` — retryable but unlikely to succeed without user action
- No rollback needed because no resources were created
- Error panel suggests going back to Page 1 to change the workspace name
- The "Go Back" action preserves all other wizard state

### 5.3 Failure at Step 3 (Create Notebook) — Server Error

**Scenario:** Fabric API returns 500 Internal Server Error during notebook creation.

**Trigger:** Step 3 returns HTTP 500.

**Sequence:**

```
T+0s   Steps 0-2 complete successfully
       Artifacts: { workspaceId: "ws-123", lakehouseId: "lh-456" }
       Rollback manifest: [workspace, lakehouse]

T+7s   Step 3: pending→running
       Log: "Creating notebook 'Setup-Tables'..."

T+8s   API 500 received
       Auto-retry 1 of 2
       Log: "⚠ Server error (500). Retrying in 1s..."

T+10s  Auto-retry attempt 2 → API 500 again
       Auto-retry 2 of 2
       Log: "⚠ Server error (500). Retrying in 2s..."

T+13s  Auto-retry attempt 3 → API 500 again
       Retries exhausted
       Step 3: running→failed
       Pipeline: executing→failed

       Error panel:
         Message: "Failed to create notebook. Fabric API returned 500."
         Category: server_error
         Is retryable: YES
         Buttons: [Retry from Step 3] [Rollback & Start Over]
```

**Postconditions:**
- Steps 0-2 remain as green ● (succeeded)
- Step 3 shows red ✕ (failed) with expanded error log
- Steps 4-5 remain as gray ○ (pending)
- "Retry from Step 3" is available because server errors are transient
- "Rollback & Start Over" will delete lakehouse then workspace

### 5.4 Failure at Step 5 (Execute Notebook) — LRO Timeout

**Scenario:** Notebook execution takes longer than the 5-minute maximum poll duration.

**Trigger:** LRO polling exceeds `maxPollDurationMs` (300,000ms).

**Sequence:**

```
T+0s    Steps 0-4 complete successfully (all resources created)
T+10s   Step 5: pending→running
        Log: "Executing notebook 'Setup-Tables'..."
        API returns 202, LRO begins

T+13s   Poll 1: status = "NotStarted"
        Log: "Notebook job queued..."

T+16s   Poll 2: status = "InProgress"
        Log: "Notebook running... (6s)"

...     Polling continues every 3 seconds
        Log updates showing elapsed time

T+310s  Poll timeout reached (300s = 5 minutes)
        Step 5: running→failed
        Log: "✕ Notebook execution timed out after 5m 00s"
        Pipeline: executing→failed

        Error panel:
          Message: "Notebook execution did not complete within 5 minutes."
          Category: lro_timeout
          Is retryable: YES (notebook may have just been slow)
          Note: "The notebook may still be running in Fabric.
                 You can check status in the Fabric portal."
          Buttons: [Retry Execution] [Rollback & Start Over]
```

**Key decisions:**
- LRO timeout does NOT trigger automatic rollback — the notebook may complete on its own
- User can retry (re-submits the notebook job) or rollback
- All 3 resources (workspace, lakehouse, notebook) are in the rollback manifest
- Note: Notebook execution step is expensive — only 1 auto-retry allowed

### 5.5 Retry from Failed Step

**Preconditions:**
- Pipeline is in `failed` state
- At least one step has `succeeded` status
- User clicks "Retry from Failed Step" button

**Scenario:** Steps 0-2 succeeded, Step 3 failed, user clicks Retry.

**Sequence:**

```
BEFORE RETRY:
  Step 0: ● succeeded (2.1s)     → stays succeeded
  Step 1: ● succeeded (1.2s)     → stays succeeded
  Step 2: ● succeeded (3.4s)     → stays succeeded
  Step 3: ✕ failed               → reset to ○ pending
  Step 4: ○ pending              → stays pending
  Step 5: ○ pending              → stays pending

AFTER retryFromFailed():
  Pipeline: failed → retrying → executing
  activeStepIndex: 3 (resume from failed step)
  retryCount: 1

  Step 0: ● succeeded → ◌ skipped (dimmed, shows "2.1s" from original run)
  Step 1: ● succeeded → ◌ skipped
  Step 2: ● succeeded → ◌ skipped
  Step 3: ○ pending → ◐ running (re-executing)
  Step 4: ○ pending (waiting)
  Step 5: ○ pending (waiting)

RE-EXECUTION:
  T+0s  Step 3: pending→running
        Log: "Creating notebook 'Setup-Tables'... (retry attempt 1)"
        Previous error logs are cleared

  T+1s  Step 3: API 201 received → running→succeeded
        Log: "✓ Notebook created (1.1s)"

  T+2s  Step 4: pending→running
        ... continues normally through Step 5

  T+20s Pipeline: executing→succeeded
        All 6 steps completed (3 skipped + 3 executed)
```

**Key behaviors:**
- Skipped steps retain their original timing badges but are visually dimmed
- The overall timer shows only the retry duration, not cumulative
- Artifacts from skipped steps are preserved (workspaceId, lakehouseId still available)
- If the retry also fails, the retry count increments and the error panel returns

### 5.6 Full Rollback

**Preconditions:**
- Pipeline is in `failed` state
- Rollback manifest has resources to delete
- User clicks "Rollback & Start Over" button

**Scenario:** Steps 0-2 succeeded, Step 3 failed, user chooses rollback.

**Sequence:**

```
ROLLBACK MANIFEST (reverse order):
  1. Delete lakehouse  (lh-456 in ws-123)
  2. Delete workspace  (ws-123)

Note: Capacity assignment is reversed by workspace deletion.
Note: No notebook was created (Step 3 failed), so nothing to delete for Step 3.

ROLLBACK EXECUTION:
  Pipeline: failed → rolling_back

  T+0s  Rollback Step 1: DELETE /v1/workspaces/ws-123/lakehouses/lh-456
        Log: "Deleting lakehouse 'SalesLH'..."

  T+1s  DELETE returns 200
        Log: "✓ Lakehouse deleted"

  T+2s  Rollback Step 2: DELETE /v1/workspaces/ws-123
        Log: "Deleting workspace 'MyEnv'..."

  T+3s  DELETE returns 200
        Log: "✓ Workspace deleted"

  T+3s  Pipeline: rolling_back → rolled_back
        Emit pipeline:rollback:complete

  UI:
    All pipeline steps shown as dimmed (◌)
    Summary: "All resources have been cleaned up."
    Button: [Start Over] → resets wizard to Page 1
```

### 5.7 Rollback Failure

**Scenario:** During rollback, one of the DELETE calls fails.

**Sequence:**

```
ROLLBACK:
  T+0s  Delete lakehouse → 200 OK ✓
  T+1s  Delete workspace → 500 Server Error ✕

  Pipeline: rolling_back → rollback_failed

  UI:
    Warning panel (yellow background):
      "Some resources could not be deleted automatically."
      "The following resources need manual cleanup:"
      ┌──────────┬──────────┬────────────┐
      │ Resource │ Name     │ Status     │
      ├──────────┼──────────┼────────────┤
      │ Lakehouse│ SalesLH  │ ✓ Deleted  │
      │ Workspace│ MyEnv    │ ✕ Failed   │
      └──────────┴──────────┴────────────┘
      "To manually delete: Open Fabric portal → Workspaces → MyEnv → Delete"

    Buttons: [Try Rollback Again] [Close]
```

### 5.8 Minimize During Execution

**Scenario:** User clicks the close (✕) button on the wizard while Step 3 is running.

**Sequence:**

```
T+0s  User is on Page 5, Steps 0-2 complete, Step 3 running
      User clicks wizard close button (✕)

      NOT a cancel. CEO requirement: "Close during execution = minimize."

      Pipeline.minimize() called:
        _state.isMinimized = true
        Wizard container: display: none
        FloatingBadge appears: display: flex

      FloatingBadge shows:
        ┌─────────────────────────────┐
        │ ◐ 3/6 Creating Notebook...  │
        └─────────────────────────────┘
        Position: fixed, bottom-right
        Z-index: 10000

T+1s  Step 3 completes in background
      FloatingBadge updates:
        ┌─────────────────────────────┐
        │ ◐ 4/6 Writing Cells...      │
        └─────────────────────────────┘

T+5s  Pipeline completes all steps
      FloatingBadge updates to success state:
        ┌─────────────────────────────┐
        │ ● Done! Click to view       │
        └─────────────────────────────┘
        Background: green accent

T+Ns  User clicks the badge
      Pipeline.restore() called:
        _state.isMinimized = false
        Wizard container: display: block
        FloatingBadge: display: none
        Full pipeline shown in succeeded state
```

### 5.9 Minimize During Failure

**Scenario:** Pipeline fails while minimized.

**Sequence:**

```
  FloatingBadge was showing:
    ┌─────────────────────────────┐
    │ ◐ 5/6 Running Notebook...   │
    └─────────────────────────────┘

  Step 5 fails (LRO returns Failed):

  FloatingBadge updates to error state:
    ┌─────────────────────────────┐
    │ ✕ Failed at step 5          │
    └─────────────────────────────┘
    Background: red accent
    Subtle pulse animation to draw attention

  User clicks badge → wizard restores showing the error panel
```

### 5.10 Post-Success Navigation

**Scenario:** All 6 steps completed, user clicks "Navigate to Workspace."

**Sequence:**

```
  Pipeline in succeeded state.
  Summary footer shows:
    ┌─────────────────────────────────────────────────────┐
    │ ✓ Environment created successfully!                  │
    │ Total time: 25.3s                                   │
    │                                                     │
    │ Workspace: MyEnv                                    │
    │ Lakehouse: SalesLH                                  │
    │ Notebook:  Setup-Tables (executed successfully)      │
    │                                                     │
    │ [Navigate to Workspace]  [Create Another Environment]│
    └─────────────────────────────────────────────────────┘

  User clicks [Navigate to Workspace]:
    1. callbacks.onNavigate(artifacts.workspaceUrl) is called
    2. WizardShell closes the wizard
    3. Sidebar explorer navigates to the new workspace
    4. Workspace contents (lakehouse, notebook) are visible

  User clicks [Create Another Environment]:
    1. Pipeline is destroyed
    2. WizardShell resets to Page 1
    3. All previous inputs are cleared
    4. User can configure a new environment from scratch
```

### 5.11 Empty Notebook Cells Edge Case

**Scenario:** User reaches Page 5 with zero notebook cells (no tables configured).

**Behavior:**
- Steps 0-3 execute normally (workspace, capacity, lakehouse, notebook created)
- Step 4 (Write Cells): Writes a single comment cell: `# No table definitions configured`
- Step 5 (Execute Notebook): Skipped — no cells to execute
  - Status: `skipped` with log "No cells to execute — notebook is empty"
- Pipeline succeeds with 5 executed + 1 skipped

### 5.12 Network Disconnect Mid-Execution

**Scenario:** User loses internet connectivity during Step 2 execution.

**Sequence:**

```
T+0s  Steps 0-1 complete
T+5s  Step 2: running, fetch() in progress
T+6s  Network drops → fetch() rejects with TypeError: Failed to fetch

      Auto-retry 1: wait 2s → retry → same error
      Auto-retry 2: wait 4s → retry → same error
      Auto-retry 3: wait 8s → retry → same error (or timeout)

      Step 2: running→failed
      Category: 'network'
      Message: "Network connection lost. Please check your internet and retry."
      Is retryable: YES

      Error panel:
        "Unable to reach Fabric API. Please check your network connection."
        [Retry from Step 2] [Rollback & Start Over]

      If network recovers, user clicks [Retry from Step 2]:
        Steps 0-1: skipped (already completed)
        Step 2: pending→running → succeeds
        Steps 3-5: execute normally
```

---


## 6. Visual Spec

### 6.1 Layout Structure

The execution pipeline uses a vertical step list layout inspired by GitHub Actions. Each step is a horizontal row with a vertical connector line on the left.

```
┌─ .execution-pipeline ────────────────────────────────────────────────┐
│                                                                       │
│  ┌─ .pipeline-header ──────────────────────────────────────────────┐  │
│  │ Creating Your Environment                    Total: ◐ 12.4s    │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌─ .pipeline-steps ───────────────────────────────────────────────┐  │
│  │                                                                  │  │
│  │  ┌─ .pipeline-step[data-status="succeeded"] ─────────────────┐  │  │
│  │  │ ● Create Workspace                              2.1s  ▸  │  │  │
│  │  │ │                                                         │  │  │
│  │  │ ├─ .step-detail (collapsed) ─────────────────────────────┤  │  │
│  │  │ │  ✓ Workspace 'MyEnv' created (id: ws-abc123)          │  │  │
│  │  │ └───────────────────────────────────────────────────────┘  │  │
│  │  └───────────────────────────────────────────────────────────┘  │  │
│  │  │ (connector line)                                             │  │
│  │  ┌─ .pipeline-step[data-status="succeeded"] ─────────────────┐  │  │
│  │  │ ● Assign Capacity                               1.2s  ▸  │  │  │
│  │  │ │                                                         │  │  │
│  │  │ ├─ .step-detail (collapsed) ─────────────────────────────┤  │  │
│  │  │ │  ✓ Capacity assigned to workspace                     │  │  │
│  │  │ └───────────────────────────────────────────────────────┘  │  │
│  │  └───────────────────────────────────────────────────────────┘  │  │
│  │  │                                                              │  │
│  │  ┌─ .pipeline-step[data-status="running"] ───────────────────┐  │  │
│  │  │ ◐ Create Lakehouse                        ◐ 3.4s  ▾  │  │  │
│  │  │ │                                                         │  │  │
│  │  │ ├─ .step-detail (expanded) ──────────────────────────────┤  │  │
│  │  │ │  Creating lakehouse 'SalesLH'...                       │  │  │
│  │  │ │  Enabling schema support...                            │  │  │
│  │  │ └───────────────────────────────────────────────────────┘  │  │
│  │  └───────────────────────────────────────────────────────────┘  │  │
│  │  │                                                              │  │
│  │  ┌─ .pipeline-step[data-status="pending"] ───────────────────┐  │  │
│  │  │ ○ Create Notebook                                     ▸  │  │  │
│  │  └───────────────────────────────────────────────────────────┘  │  │
│  │  │                                                              │  │
│  │  ┌─ .pipeline-step[data-status="pending"] ───────────────────┐  │  │
│  │  │ ○ Write Notebook Cells                                ▸  │  │  │
│  │  └───────────────────────────────────────────────────────────┘  │  │
│  │  │                                                              │  │
│  │  ┌─ .pipeline-step[data-status="pending"] ───────────────────┐  │  │
│  │  │ ○ Execute Notebook                                    ▸  │  │  │
│  │  └───────────────────────────────────────────────────────────┘  │  │
│  │                                                                  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌─ .pipeline-summary (only on completion) ────────────────────────┐  │
│  │ ✓ Environment created successfully!  Total: 25.3s               │  │
│  │ [Navigate to Workspace]  [Create Another]                        │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### 6.2 CSS Classes and Design Tokens

All CSS classes and design tokens are derived from the CEO-approved mock (`infra-wizard.html`) and the project design system (`docs/DESIGN_SYSTEM.md`).

```css
/* ═══════════════════════════════════════════════════════════
   C10-ExecutionPipeline — CSS Specification
   All colors in OKLCH per project convention (ADR-002)
   4px spacing grid per design system
   ═══════════════════════════════════════════════════════════ */

/* ─── Container ───────────────────────────────────────────── */
.execution-pipeline {
  display: flex;
  flex-direction: column;
  gap: 0; /* Steps are connected by vertical lines */
  padding: 24px; /* 6 × 4px grid */
  max-width: 640px;
  margin: 0 auto;
}

/* ─── Header ──────────────────────────────────────────────── */
.pipeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid oklch(0.3 0 0 / 0.15);
}

.pipeline-header__title {
  font-size: 16px;
  font-weight: 600;
  color: oklch(0.93 0 0); /* --text-primary */
}

.pipeline-header__timer {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: oklch(0.6 0 0); /* --text-secondary */
}

.pipeline-header__timer--running {
  color: oklch(0.7 0.15 280); /* --accent: #6d5cff equivalent */
}

/* ─── Step Container ──────────────────────────────────────── */
.pipeline-step {
  position: relative;
  padding-left: 40px; /* Room for status icon + connector line */
  padding-bottom: 8px;
  margin-bottom: 0;
}

/* Vertical connector line between steps */
.pipeline-step::before {
  content: '';
  position: absolute;
  left: 11px; /* Center of 24px icon */
  top: 24px; /* Below the icon */
  bottom: -8px;
  width: 2px;
  background: oklch(0.3 0 0 / 0.2); /* Subtle connector */
}

/* Last step has no connector line extending below */
.pipeline-step:last-child::before {
  display: none;
}

/* Connector line color changes based on status */
.pipeline-step[data-status="succeeded"]::before {
  background: oklch(0.65 0.18 155); /* --status-succeeded green */
}

.pipeline-step[data-status="running"]::before {
  background: oklch(0.7 0.15 280); /* --accent purple */
}

.pipeline-step[data-status="failed"]::before {
  background: oklch(0.6 0.2 25); /* --status-failed red */
}

/* ─── Step Status Icon ────────────────────────────────────── */
.step-status {
  position: absolute;
  left: 0;
  top: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  z-index: 1; /* Above connector line */
  background: oklch(0.15 0 0); /* Dark background matching wizard bg */
}

/* Pending: empty circle */
.step-status--pending {
  border: 2px solid oklch(0.4 0 0);
  color: oklch(0.4 0 0);
}

/* Running: accent circle with animated spinner */
.step-status--running {
  border: 2px solid oklch(0.7 0.15 280);
  color: oklch(0.7 0.15 280);
}

.step-status--running .spinner {
  width: 14px;
  height: 14px;
  border: 2px solid oklch(0.7 0.15 280 / 0.3);
  border-top-color: oklch(0.7 0.15 280);
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}

/* Succeeded: solid green circle with checkmark */
.step-status--succeeded {
  background: oklch(0.65 0.18 155);
  border: none;
  color: oklch(0.15 0 0);
}

/* Failed: solid red circle with X */
.step-status--failed {
  background: oklch(0.6 0.2 25);
  border: none;
  color: oklch(0.95 0 0);
}

/* Skipped: dashed border circle (dimmed) */
.step-status--skipped {
  border: 2px dashed oklch(0.35 0 0);
  color: oklch(0.35 0 0);
  opacity: 0.6;
}

/* ─── Step Info ───────────────────────────────────────────── */
.step-info {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 24px;
  cursor: pointer;
  user-select: none;
}

.step-name {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
  color: oklch(0.85 0 0);
}

.pipeline-step[data-status="pending"] .step-name {
  color: oklch(0.5 0 0);
}

.pipeline-step[data-status="skipped"] .step-name {
  color: oklch(0.4 0 0);
  text-decoration: line-through;
  text-decoration-color: oklch(0.3 0 0);
}

.step-time {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: oklch(0.55 0 0);
  min-width: 48px;
  text-align: right;
}

.step-time--counting {
  color: oklch(0.7 0.15 280);
  animation: pulse-opacity 1.5s ease-in-out infinite;
}

/* ─── Step Expand Toggle ──────────────────────────────────── */
.step-expand {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: oklch(0.45 0 0);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  transition: transform 200ms ease, color 200ms ease;
  font-size: 12px;
}

.step-expand:hover {
  color: oklch(0.7 0 0);
}

.step-expand--expanded {
  transform: rotate(90deg);
}

/* ─── Step Detail Panel ───────────────────────────────────── */
.step-detail {
  max-height: 0;
  overflow: hidden;
  transition: max-height 200ms ease, padding 200ms ease;
  margin-left: 0;
  margin-top: 0;
}

.step-detail--expanded {
  max-height: 200px;
  overflow-y: auto;
  padding-top: 8px;
  padding-bottom: 8px;
}

.step-detail__log {
  font-family: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.5;
  color: oklch(0.65 0 0);
  padding: 8px 12px;
  background: oklch(0.12 0 0);
  border-radius: 6px;
  border: 1px solid oklch(0.2 0 0);
}

/* Log entry severity colors */
.log-entry--info    { color: oklch(0.65 0 0); }
.log-entry--success { color: oklch(0.65 0.18 155); }
.log-entry--warning { color: oklch(0.75 0.15 85); }
.log-entry--error   { color: oklch(0.6 0.2 25); }
.log-entry--debug   { color: oklch(0.45 0 0); }

/* ─── Pipeline Summary Footer ─────────────────────────────── */
.pipeline-summary {
  margin-top: 24px;
  padding: 20px;
  border-radius: 8px;
  background: oklch(0.15 0.02 155 / 0.15);
  border: 1px solid oklch(0.65 0.18 155 / 0.3);
}

.pipeline-summary--failed {
  background: oklch(0.15 0.02 25 / 0.15);
  border-color: oklch(0.6 0.2 25 / 0.3);
}

.pipeline-summary__title {
  font-size: 15px;
  font-weight: 600;
  color: oklch(0.65 0.18 155);
  margin-bottom: 8px;
}

.pipeline-summary__details {
  font-size: 13px;
  color: oklch(0.7 0 0);
  line-height: 1.6;
}

.pipeline-summary__actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

/* ─── Error Panel ─────────────────────────────────────────── */
.pipeline-error {
  margin-top: 16px;
  padding: 16px;
  border-radius: 8px;
  background: oklch(0.13 0.01 25);
  border: 1px solid oklch(0.6 0.2 25 / 0.3);
}

.pipeline-error__message {
  font-size: 14px;
  font-weight: 500;
  color: oklch(0.6 0.2 25);
  margin-bottom: 8px;
}

.pipeline-error__raw {
  font-family: monospace;
  font-size: 12px;
  color: oklch(0.55 0 0);
  padding: 8px;
  background: oklch(0.1 0 0);
  border-radius: 4px;
  margin-bottom: 12px;
  max-height: 120px;
  overflow-y: auto;
}

.pipeline-error__actions {
  display: flex;
  gap: 12px;
}

/* ─── Floating Badge (C11 reference) ──────────────────────── */
.floating-badge {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 10000; /* Above everything */
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 20px;
  background: oklch(0.2 0 0);
  border: 1px solid oklch(0.3 0 0);
  box-shadow: 0 4px 12px oklch(0 0 0 / 0.4);
  cursor: pointer;
  transition: background 200ms ease, border-color 200ms ease;
  font-size: 13px;
  color: oklch(0.8 0 0);
  min-width: 200px;
  height: 40px;
}

.floating-badge:hover {
  background: oklch(0.25 0 0);
  border-color: oklch(0.4 0 0);
}

.floating-badge--running {
  border-color: oklch(0.7 0.15 280 / 0.5);
}

.floating-badge--succeeded {
  border-color: oklch(0.65 0.18 155 / 0.5);
  background: oklch(0.15 0.03 155);
}

.floating-badge--failed {
  border-color: oklch(0.6 0.2 25 / 0.5);
  background: oklch(0.15 0.03 25);
  animation: pulse-border 2s ease-in-out infinite;
}

.badge-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.badge-dot--running {
  background: oklch(0.7 0.15 280);
  animation: pulse-opacity 1.5s ease-in-out infinite;
}

.badge-dot--succeeded {
  background: oklch(0.65 0.18 155);
}

.badge-dot--failed {
  background: oklch(0.6 0.2 25);
}

.badge-progress {
  flex: 1;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ─── Animations ──────────────────────────────────────────── */
@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes pulse-opacity {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes pulse-border {
  0%, 100% { border-color: oklch(0.6 0.2 25 / 0.5); }
  50% { border-color: oklch(0.6 0.2 25 / 0.9); }
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Staggered entrance for pipeline steps */
.pipeline-step:nth-child(1) { animation: slideUp 300ms ease forwards; animation-delay: 0ms; }
.pipeline-step:nth-child(2) { animation: slideUp 300ms ease forwards; animation-delay: 50ms; }
.pipeline-step:nth-child(3) { animation: slideUp 300ms ease forwards; animation-delay: 100ms; }
.pipeline-step:nth-child(4) { animation: slideUp 300ms ease forwards; animation-delay: 150ms; }
.pipeline-step:nth-child(5) { animation: slideUp 300ms ease forwards; animation-delay: 200ms; }
.pipeline-step:nth-child(6) { animation: slideUp 300ms ease forwards; animation-delay: 250ms; }

/* ─── Buttons ─────────────────────────────────────────────── */
.pipeline-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: background 150ms ease, opacity 150ms ease;
}

.pipeline-btn--primary {
  background: oklch(0.7 0.15 280);
  color: oklch(0.95 0 0);
}

.pipeline-btn--primary:hover {
  background: oklch(0.75 0.15 280);
}

.pipeline-btn--secondary {
  background: oklch(0.25 0 0);
  color: oklch(0.75 0 0);
  border: 1px solid oklch(0.35 0 0);
}

.pipeline-btn--secondary:hover {
  background: oklch(0.3 0 0);
}

.pipeline-btn--danger {
  background: oklch(0.55 0.18 25);
  color: oklch(0.95 0 0);
}

.pipeline-btn--danger:hover {
  background: oklch(0.6 0.18 25);
}

.pipeline-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

### 6.3 Status Icon Specification

Status icons use Unicode symbols (per project rule: no emoji).

| Status | Symbol | Font Size | Color (OKLCH) | Background | Notes |
|--------|--------|-----------|---------------|------------|-------|
| `pending` | ○ (empty circle) | 14px | `oklch(0.4 0 0)` | none | Rendered via border only |
| `running` | (spinner) | — | `oklch(0.7 0.15 280)` | none | CSS `@keyframes spin` on child `.spinner` div |
| `succeeded` | ✓ (checkmark) | 12px | `oklch(0.15 0 0)` | `oklch(0.65 0.18 155)` | Solid green circle with dark checkmark |
| `failed` | ✕ (cross) | 12px | `oklch(0.95 0 0)` | `oklch(0.6 0.2 25)` | Solid red circle with white cross |
| `skipped` | ◌ (dashed circle) | 14px | `oklch(0.35 0 0)` | none | Rendered via dashed border, 60% opacity |

### 6.4 Responsive Behavior

The execution pipeline has limited responsive requirements since it lives inside the wizard modal (640px max-width). However, certain adjustments apply:

```css
/* Narrow wizard (below 480px content width) */
@media (max-width: 480px) {
  .execution-pipeline {
    padding: 16px;
  }

  .step-time {
    display: none; /* Hide individual step times to save space */
  }

  .pipeline-summary__actions {
    flex-direction: column;
  }
}
```

### 6.5 Dark Mode (Default)

The execution pipeline is designed for EDOG Studio's dark theme (the ONLY theme). All colors use OKLCH and are calibrated for dark backgrounds (`oklch(0.12–0.18 ...)`).

There is NO light mode variant. The wizard background is approximately `oklch(0.14 0.005 280)` and all text/icon colors are designed for this dark context.

### 6.6 Z-Index Layering

```
Layer                          Z-Index     Element
─────────────────────────────────────────────────────
Pipeline container             auto        .execution-pipeline
Step detail panel              auto        .step-detail
Error panel                    auto        .pipeline-error
Wizard modal                   500         .wizard-shell (from --z-wizard)
Floating badge                 10000       .floating-badge
```

---


## 7. Keyboard & Accessibility

### 7.1 ARIA Roles and Attributes

The execution pipeline uses semantic ARIA roles to ensure screen readers can convey the pipeline structure and real-time status updates.

```html
<!-- Pipeline container -->
<div class="execution-pipeline"
     role="region"
     aria-label="Environment creation pipeline"
     aria-live="polite"
     aria-busy="true"> <!-- true while executing -->

  <!-- Pipeline header with live timer -->
  <div class="pipeline-header">
    <h3 class="pipeline-header__title" id="pipeline-title">
      Creating Your Environment
    </h3>
    <span class="pipeline-header__timer"
          role="timer"
          aria-label="Total elapsed time"
          aria-live="off"> <!-- Timer updates too frequently for live -->
      12.4s
    </span>
  </div>

  <!-- Step list -->
  <ol class="pipeline-steps"
      role="list"
      aria-label="Pipeline steps">

    <!-- Individual step -->
    <li class="pipeline-step"
        role="listitem"
        data-status="succeeded"
        aria-label="Step 1: Create Workspace — Succeeded in 2.1 seconds">

      <!-- Status icon (decorative, info conveyed by aria-label) -->
      <span class="step-status step-status--succeeded"
            role="img"
            aria-hidden="true">✓</span>

      <!-- Step info row (clickable to expand/collapse) -->
      <button class="step-info"
              aria-expanded="false"
              aria-controls="step-0-detail"
              type="button">
        <span class="step-name">Create Workspace</span>
        <span class="step-time" aria-label="Duration: 2.1 seconds">2.1s</span>
        <span class="step-expand" aria-hidden="true">▸</span>
      </button>

      <!-- Expandable detail panel -->
      <div class="step-detail"
           id="step-0-detail"
           role="log"
           aria-label="Step 1 log output"
           aria-live="polite"
           hidden> <!-- Hidden when collapsed -->
        <div class="step-detail__log">
          <div class="log-entry log-entry--success">
            ✓ Workspace 'MyEnv' created (id: ws-abc123)
          </div>
        </div>
      </div>
    </li>

    <!-- Running step has different ARIA -->
    <li class="pipeline-step"
        role="listitem"
        data-status="running"
        aria-label="Step 3: Create Lakehouse — Running for 3.4 seconds"
        aria-current="step"> <!-- Indicates the active step -->

      <span class="step-status step-status--running"
            role="img"
            aria-hidden="true">
        <span class="spinner"></span>
      </span>

      <button class="step-info"
              aria-expanded="true"
              aria-controls="step-2-detail"
              type="button">
        <span class="step-name">Create Lakehouse</span>
        <span class="step-time step-time--counting"
              aria-label="Elapsed: 3.4 seconds and counting">3.4s</span>
        <span class="step-expand step-expand--expanded" aria-hidden="true">▸</span>
      </button>

      <div class="step-detail step-detail--expanded"
           id="step-2-detail"
           role="log"
           aria-label="Step 3 log output — live"
           aria-live="polite">
        <div class="step-detail__log">
          <div class="log-entry log-entry--info">Creating lakehouse 'SalesLH'...</div>
          <div class="log-entry log-entry--info">Enabling schema support...</div>
        </div>
      </div>
    </li>
  </ol>
</div>
```

### 7.2 Screen Reader Announcements

The pipeline uses `aria-live` regions to announce status changes without requiring focus movement.

| Event | Announcement Text | `aria-live` | Region |
|-------|------------------|-------------|--------|
| Pipeline starts | "Creating your environment. Step 1 of 6: Create Workspace." | `assertive` | Pipeline container |
| Step completes | "Step 1 completed: Create Workspace. 2.1 seconds. Starting step 2: Assign Capacity." | `polite` | Pipeline container |
| Step fails | "Step 3 failed: Create Lakehouse. Error: Server error. Retry options available." | `assertive` | Pipeline container |
| All steps succeed | "Environment created successfully! Total time: 25.3 seconds." | `assertive` | Pipeline container |
| Retry starts | "Retrying from step 3: Create Lakehouse." | `assertive` | Pipeline container |
| Rollback starts | "Rolling back created resources." | `assertive` | Pipeline container |
| Rollback complete | "Rollback complete. All resources have been deleted." | `assertive` | Pipeline container |
| LRO polling update | (No announcement — too frequent. Status available on focus.) | — | — |

**Implementation:**

```javascript
/**
 * Announce a message to screen readers via a live region.
 * Uses a dedicated visually-hidden element to avoid layout disruption.
 *
 * @param {string} message - The announcement text
 * @param {'polite'|'assertive'} priority - Announcement priority
 */
_announce(message, priority = 'polite') {
  const announcer = this._container.querySelector('.sr-announcer');
  announcer.setAttribute('aria-live', priority);
  // Clear and re-set to force re-announcement of identical messages
  announcer.textContent = '';
  requestAnimationFrame(() => {
    announcer.textContent = message;
  });
}
```

```css
/* Visually hidden but accessible to screen readers */
.sr-announcer {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

### 7.3 Keyboard Navigation

| Key | Context | Action |
|-----|---------|--------|
| `Tab` | Pipeline | Move focus to next interactive element (step buttons, action buttons) |
| `Shift+Tab` | Pipeline | Move focus to previous interactive element |
| `Enter` / `Space` | Step info button | Toggle step detail panel expand/collapse |
| `Enter` / `Space` | "Retry from Failed Step" button | Trigger retry |
| `Enter` / `Space` | "Rollback & Start Over" button | Trigger rollback |
| `Enter` / `Space` | "Navigate to Workspace" button | Trigger navigation |
| `Enter` / `Space` | Floating badge | Restore wizard from minimized state |
| `Escape` | Wizard (during execution) | Minimize to floating badge (NOT cancel) |
| `Escape` | Wizard (post-execution) | Close wizard |
| `ArrowDown` | Step list | Move focus to next step (optional enhancement) |
| `ArrowUp` | Step list | Move focus to previous step (optional enhancement) |
| `Home` | Step list | Move focus to first step (optional enhancement) |
| `End` | Step list | Move focus to last step (optional enhancement) |

### 7.4 Focus Management

Focus management ensures keyboard users always know where they are and what happened.

| Event | Focus Target | Rationale |
|-------|-------------|-----------|
| Pipeline starts | First step (Step 0) | User sees execution begin |
| Step starts | Newly running step | Follows the action |
| Step fails | Failed step's info button | User can expand for details |
| Error panel appears | "Retry" button (or first action button) | Most common action after failure |
| Pipeline succeeds | "Navigate to Workspace" button | Primary post-success action |
| Minimize | Floating badge | Only interactive element after minimize |
| Restore | Previously focused element or active step | Return to context |
| Rollback complete | "Start Over" button | Primary post-rollback action |

```javascript
/**
 * Move focus to a specific element with a visual focus indicator.
 * Uses requestAnimationFrame to ensure the element is rendered.
 *
 * @param {HTMLElement} element - The element to focus
 */
_moveFocus(element) {
  if (!element) return;
  requestAnimationFrame(() => {
    element.focus({ preventScroll: false });
    // Scroll into view if needed
    element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}
```

### 7.5 Reduced Motion

For users with `prefers-reduced-motion: reduce`, all animations are disabled or simplified:

```css
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
    /* Fallback: static indicator */
    border-color: oklch(0.7 0.15 280);
    background: oklch(0.7 0.15 280 / 0.2);
  }

  .step-time--counting {
    animation: none;
  }

  .pipeline-step {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }

  .step-detail {
    transition: none;
  }

  .step-expand {
    transition: none;
  }

  .floating-badge--failed {
    animation: none;
  }
}
```

### 7.6 Color Contrast Compliance

All color combinations meet WCAG 2.1 AA contrast requirements (4.5:1 for text, 3:1 for UI components):

| Element | Foreground (OKLCH) | Background (OKLCH) | Contrast Ratio | WCAG |
|---------|-------------------|-------------------|----------------|------|
| Step name (active) | `oklch(0.85 0 0)` | `oklch(0.14 0 0)` | 8.1:1 | AAA |
| Step name (pending) | `oklch(0.5 0 0)` | `oklch(0.14 0 0)` | 3.4:1 | AA (large) |
| Step time | `oklch(0.55 0 0)` | `oklch(0.14 0 0)` | 3.8:1 | AA |
| Log text | `oklch(0.65 0 0)` | `oklch(0.12 0 0)` | 4.6:1 | AA |
| Success text | `oklch(0.65 0.18 155)` | `oklch(0.14 0 0)` | 5.2:1 | AA |
| Error text | `oklch(0.6 0.2 25)` | `oklch(0.14 0 0)` | 4.1:1 | AA |
| Button text | `oklch(0.95 0 0)` | `oklch(0.7 0.15 280)` | 5.8:1 | AA |

---

## 8. Error Handling

### 8.1 Error Classification Matrix

Every possible error from the 6 pipeline steps is classified into a category that determines the UI behavior, retry eligibility, and suggested user action.

| HTTP Status | Category | Retryable | Auto-Retry | Suggested Action | Example |
|-------------|----------|-----------|------------|------------------|---------|
| — (no response) | `network` | Yes | Yes (3×) | "Check your internet connection and retry." | `fetch()` throws TypeError |
| 400 | `validation` | No | No | "The request was invalid. Please go back and check your inputs." | Invalid workspace name |
| 401 | `auth` | Yes (1×) | Yes (1×) | "Your session may have expired. Please refresh and try again." | Token expired |
| 403 | `auth` | No | No | "You don't have permission to create resources in this capacity." | Insufficient Fabric permissions |
| 404 | `not_found` | No | No | "A required resource was not found. This may indicate a configuration issue." | Workspace deleted externally |
| 409 | `conflict` | No | No | "A resource with this name already exists. Go back and choose a different name." | Workspace name conflict |
| 429 | `rate_limit` | Yes | Yes (3×) | "API rate limit reached. Waiting before retry..." | Too many requests |
| 500 | `server_error` | Yes | Yes (3×) | "Fabric API encountered an error. Retrying..." | Transient server issue |
| 502 | `server_error` | Yes | Yes (3×) | "Fabric API is temporarily unavailable." | Gateway error |
| 503 | `server_error` | Yes | Yes (3×) | "Fabric API is temporarily unavailable." | Service unavailable |
| 504 | `server_error` | Yes | Yes (2×) | "Request timed out. Retrying..." | Gateway timeout |
| LRO Failed | `lro_failed` | Yes (1×) | No | "Notebook execution failed. Check the notebook for errors." | Notebook runtime error |
| LRO Timeout | `lro_timeout` | Yes (1×) | No | "Notebook execution timed out. It may still be running in Fabric." | Execution exceeds 5min |

### 8.2 Error Classification Logic

```javascript
/**
 * Classify an error into an ErrorCategory based on the HTTP status
 * and error type. This determines retry behavior and user messaging.
 *
 * @param {Error} error - The caught error (may be TypeError for network)
 * @param {number|null} httpStatus - The HTTP status code if available
 * @returns {ErrorCategory}
 */
_classifyError(error, httpStatus) {
  // Network errors (fetch failure, DNS, CORS, etc.)
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return 'network';
  }

  // AbortError from timeout
  if (error.name === 'AbortError') {
    return 'network'; // Treat timeout as network issue
  }

  // HTTP status-based classification
  if (httpStatus) {
    if (httpStatus === 400) return 'validation';
    if (httpStatus === 401) return 'auth';
    if (httpStatus === 403) return 'auth';
    if (httpStatus === 404) return 'not_found';
    if (httpStatus === 409) return 'conflict';
    if (httpStatus === 429) return 'rate_limit';
    if (httpStatus >= 500) return 'server_error';
  }

  return 'unknown';
}

/**
 * Determine if an error category is eligible for automatic retry.
 *
 * @param {ErrorCategory} category - The error category
 * @returns {boolean}
 */
_isRetryable(category) {
  const retryableCategories = ['network', 'rate_limit', 'server_error', 'lro_timeout'];
  return retryableCategories.includes(category);
}
```

### 8.3 Retry Strategy

The pipeline uses exponential backoff with jitter for automatic retries:

```javascript
/**
 * Calculate retry delay with exponential backoff and jitter.
 *
 * Formula: baseDelay * 2^attemptNumber + random(0, baseDelay/2)
 *
 * Examples (baseDelay = 1000ms):
 *   Attempt 0: 1000 + random(0, 500) = ~1000–1500ms
 *   Attempt 1: 2000 + random(0, 500) = ~2000–2500ms
 *   Attempt 2: 4000 + random(0, 500) = ~4000–4500ms
 *
 * @param {number} attemptNumber - Zero-based attempt number
 * @param {number} baseDelay - Base delay in milliseconds
 * @returns {number} Delay in milliseconds
 */
_calculateRetryDelay(attemptNumber, baseDelay = 1000) {
  const exponentialDelay = baseDelay * Math.pow(2, attemptNumber);
  const jitter = Math.random() * (baseDelay / 2);
  return Math.min(exponentialDelay + jitter, 30_000); // Cap at 30 seconds
}
```

**Rate limit special handling:**

For HTTP 429 responses, the retry delay is read from the `Retry-After` header if present:

```javascript
if (httpStatus === 429) {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const delaySeconds = parseInt(retryAfter, 10);
    if (!isNaN(delaySeconds)) {
      return delaySeconds * 1000;
    }
  }
  // Fallback to exponential backoff with longer base
  return this._calculateRetryDelay(attemptNumber, 5000);
}
```

### 8.4 Per-Step Error Handling Details

#### Step 0: Create Workspace

| Error | Category | Handling |
|-------|----------|---------|
| 409 Conflict | `conflict` | "Workspace 'X' already exists. Go back and choose a different name." No auto-retry. |
| 400 Invalid name | `validation` | "Workspace name contains invalid characters." No auto-retry. |
| 403 Forbidden | `auth` | "You don't have permission to create workspaces." No auto-retry. |

#### Step 1: Assign Capacity

| Error | Category | Handling |
|-------|----------|---------|
| 404 Workspace not found | `not_found` | Critical — workspace from Step 0 disappeared. Should never happen. |
| 400 Invalid capacity | `validation` | "Selected capacity is no longer available." |
| 403 Forbidden | `auth` | "You don't have permission to assign this capacity." |

#### Step 2: Create Lakehouse

| Error | Category | Handling |
|-------|----------|---------|
| 409 Conflict | `conflict` | "Lakehouse 'X' already exists in this workspace." |
| 400 enableSchemas issue | `validation` | "Failed to enable schemas on lakehouse." Add to rollback manifest note. |

#### Step 3: Create Notebook

| Error | Category | Handling |
|-------|----------|---------|
| 409 Conflict | `conflict` | "Notebook 'X' already exists in this workspace." |
| 500 Server error | `server_error` | Auto-retry 3×. Transient Fabric issues are common for notebook creation. |

#### Step 4: Write Notebook Cells

| Error | Category | Handling |
|-------|----------|---------|
| 400 Bad definition | `validation` | "Notebook content format is invalid." Likely a bug in cell serialization. |
| 404 Notebook not found | `not_found` | "Notebook was not found. It may have been deleted." |
| 413 Payload too large | `validation` | "Notebook content exceeds size limit. Try reducing the number of tables." |

#### Step 5: Execute Notebook

| Error | Category | Handling |
|-------|----------|---------|
| 202 then LRO Failed | `lro_failed` | "Notebook execution failed." Show failure reason from LRO response. |
| 202 then LRO Timeout | `lro_timeout` | "Execution timed out after 5 minutes. The notebook may still be running." |
| 409 Job conflict | `conflict` | "A notebook job is already running. Wait for it to complete." |

### 8.5 Rollback Error Handling

Rollback itself can fail. Each DELETE call in the rollback sequence is independent — a failure in one does NOT stop the remaining deletions.

```javascript
/**
 * Execute rollback — delete all created resources in reverse order.
 * Best-effort: continues even if individual deletions fail.
 *
 * @returns {Promise<RollbackManifest>}
 */
async rollback() {
  this._updateState({ status: 'rolling_back' });
  this._emitEvent('pipeline:rollback:start');

  const resources = [...this._state.rollbackManifest.resources].reverse();
  const results = [];

  for (const resource of resources) {
    const result = await this._deleteResource(resource);
    results.push(result);

    // Log the result
    if (result.succeeded) {
      this._addLog(resource.createdByStep, 'info',
        `✓ Deleted ${resource.type} '${resource.displayName}'`);
    } else {
      this._addLog(resource.createdByStep, 'error',
        `✕ Failed to delete ${resource.type} '${resource.displayName}': ${result.errorMessage}`);
    }
  }

  this._state.rollbackManifest.rollbackAttempted = true;
  this._state.rollbackManifest.rollbackResults = results;

  const allSucceeded = results.every(r => r.succeeded);
  this._updateState({
    status: allSucceeded ? 'rolled_back' : 'rollback_failed'
  });

  this._callbacks.onRollbackComplete(this._state.rollbackManifest);
  this._emitEvent('pipeline:rollback:complete', {
    allSucceeded,
    results,
  });

  return this._state.rollbackManifest;
}
```

### 8.6 Rollback DELETE Endpoints

| Resource Type | DELETE Endpoint | Expected Status | Notes |
|---------------|----------------|-----------------|-------|
| `notebook` | `DELETE /v1/workspaces/{wsId}/notebooks/{nbId}` | 200 | Delete first (least important) |
| `lakehouse` | `DELETE /v1/workspaces/{wsId}/lakehouses/{lhId}` | 200 | Delete second |
| `workspace` | `DELETE /v1/workspaces/{wsId}` | 200 | Delete last (also removes capacity assignment) |

**Important:** Deleting the workspace implicitly removes the capacity assignment, so there is no need to explicitly un-assign capacity during rollback.

### 8.7 Orphaned Resource Handling

If the browser tab is closed during pipeline execution, created resources become orphaned. The pipeline does NOT persist state to localStorage (design decision).

**Mitigation strategies:**
1. **Warning on close:** The pipeline adds a `beforeunload` event listener during execution to warn the user before closing the tab.
2. **Documentation:** The error panel for "Navigate to Fabric portal" provides links for manual cleanup.
3. **Future enhancement:** A "Cleanup" feature could scan for orphaned resources (not in scope for V1).

```javascript
/**
 * Prevent accidental tab close during execution.
 * Shows browser's native "Leave page?" dialog.
 */
_addBeforeUnloadGuard() {
  this._beforeUnloadHandler = (e) => {
    if (this._state.status === 'executing' || this._state.status === 'rolling_back') {
      e.preventDefault();
      e.returnValue = ''; // Required for Chrome
    }
  };
  window.addEventListener('beforeunload', this._beforeUnloadHandler);
}

_removeBeforeUnloadGuard() {
  if (this._beforeUnloadHandler) {
    window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    this._beforeUnloadHandler = null;
  }
}
```

### 8.8 Timeout Configuration Per Step

Each step has a tailored timeout based on expected API response times:

| Step | Default Timeout | Rationale |
|------|----------------|-----------|
| Create Workspace | 30s | Usually completes in 1-3s |
| Assign Capacity | 30s | Async (202) but typically fast |
| Create Lakehouse | 60s | Can be slow (10-30s observed) |
| Create Notebook | 30s | Usually completes in 1-2s |
| Write Cells | 30s | Depends on payload size |
| Execute Notebook | 300s (5min) | LRO — execution time varies widely |

```javascript
/**
 * Execute a fetch with timeout via AbortController.
 *
 * @param {string} url - The API URL
 * @param {RequestInit} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response>}
 * @throws {AbortError} If the request times out
 */
async _fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

---


## 9. Performance

### 9.1 Timer Implementation

The pipeline uses a high-frequency timer (`setInterval` at 100ms) for smooth elapsed-time display on the running step. This is more responsive than the 1-second interval used by the existing `DeployFlow` class.

**Design rationale:** A 1-second timer creates a noticeable "jump" when the display updates. A 100ms timer provides smooth counting that feels real-time while still being efficient (10 DOM updates/second is negligible for a single text node).

```javascript
/**
 * Start the elapsed timer interval.
 * Updates both the pipeline-level and active step timers.
 * Uses performance.now() for sub-millisecond accuracy.
 */
_startTimer() {
  if (this._timerInterval) return; // Already running

  this._timerInterval = setInterval(() => {
    const now = performance.now();

    // Update pipeline elapsed time
    if (this._state.timing.startedAt) {
      this._state.timing.elapsedMs = now - this._state.timing.startedAt;
    }

    // Update active step elapsed time
    const activeIdx = this._state.activeStepIndex;
    if (activeIdx !== null) {
      const step = this._state.steps[activeIdx];
      if (step.timing.startedAt) {
        step.timing.elapsedMs = now - step.timing.startedAt;
        step.timing.elapsedFormatted = this._formatElapsed(step.timing.elapsedMs);
      }
    }

    // Targeted DOM update — only update the timer text nodes
    this._updateTimerDisplay();
  }, this._options.timerIntervalMs);
}

/**
 * Stop the elapsed timer.
 */
_stopTimer() {
  if (this._timerInterval) {
    clearInterval(this._timerInterval);
    this._timerInterval = null;
  }
}

/**
 * Update only the timer text in the DOM.
 * This is a surgical update — no full re-render, no layout thrashing.
 * Only touches .step-time and .pipeline-header__timer elements.
 */
_updateTimerDisplay() {
  // Pipeline total timer
  const headerTimer = this._container.querySelector('.pipeline-header__timer');
  if (headerTimer) {
    headerTimer.textContent = this._formatElapsed(this._state.timing.elapsedMs);
  }

  // Active step timer
  const activeIdx = this._state.activeStepIndex;
  if (activeIdx !== null) {
    const stepEl = this._container.querySelector(
      `.pipeline-step[data-index="${activeIdx}"] .step-time`
    );
    if (stepEl) {
      stepEl.textContent = this._state.steps[activeIdx].timing.elapsedFormatted;
    }
  }
}
```

### 9.2 Elapsed Time Formatting

```javascript
/**
 * Format elapsed milliseconds to a human-readable string.
 *
 * Rules:
 *   < 1000ms  → "0.Xs" (one decimal, e.g., "0.3s")
 *   < 10000ms → "X.Xs" (one decimal, e.g., "3.4s")
 *   < 60000ms → "XXs" (no decimal, e.g., "45s")
 *   >= 60000ms → "Xm XXs" (e.g., "1m 04s", "5m 00s")
 *
 * @param {number} ms - Elapsed milliseconds
 * @returns {string} Formatted string
 */
_formatElapsed(ms) {
  if (ms < 1000) {
    return (ms / 1000).toFixed(1) + 's';
  }
  if (ms < 10_000) {
    return (ms / 1000).toFixed(1) + 's';
  }
  if (ms < 60_000) {
    return Math.floor(ms / 1000) + 's';
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}
```

### 9.3 DOM Update Strategy

The pipeline uses a **targeted DOM update** strategy rather than full re-renders. This is critical for performance because:

1. The timer updates 10 times per second — full re-renders would cause layout thrashing
2. Log entries are appended, not re-rendered — prevents scroll position loss
3. Step status changes only affect the specific step's DOM subtree

**Update granularity:**

| Event | DOM Update Scope | Method |
|-------|-----------------|--------|
| Timer tick | 2 text nodes (header timer + active step timer) | `_updateTimerDisplay()` |
| New log entry | Append child to `.step-detail__log` | `_appendLogEntry()` |
| Step status change | Single `.pipeline-step` element | `_renderStep(index)` |
| Step expand/collapse | Single `.step-detail` element | Toggle class + `hidden` attr |
| Pipeline complete | Summary footer + all step statuses | `_renderSummary()` + `_renderStep()` for each |
| Error panel | Append error panel to container | `_renderErrorPanel()` |

```javascript
/**
 * Append a log entry to a step's detail panel.
 * Uses direct DOM manipulation for efficiency — no re-render.
 *
 * @param {number} stepIndex - The step index (0-5)
 * @param {LogEntry} entry - The log entry to append
 */
_appendLogEntry(stepIndex, entry) {
  const logContainer = this._container.querySelector(
    `#step-${stepIndex}-detail .step-detail__log`
  );
  if (!logContainer) return;

  const div = document.createElement('div');
  div.className = `log-entry log-entry--${entry.level}`;
  div.textContent = entry.message;

  // Add timestamp prefix
  const time = document.createElement('span');
  time.className = 'log-entry__time';
  time.textContent = this._formatLogTime(entry.timestamp);
  div.prepend(time);

  logContainer.appendChild(div);

  // Auto-scroll to bottom if user hasn't manually scrolled up
  const detail = logContainer.closest('.step-detail');
  if (detail) {
    const isScrolledToBottom =
      detail.scrollHeight - detail.scrollTop <= detail.clientHeight + 20;
    if (isScrolledToBottom) {
      detail.scrollTop = detail.scrollHeight;
    }
  }
}
```

### 9.4 Memory Management

The pipeline must be carefully managed to prevent memory leaks, especially during long-running LRO polling.

**Cleanup checklist (in `destroy()`):**

```javascript
destroy() {
  // 1. Stop timer interval
  this._stopTimer();

  // 2. Abort any in-flight fetch request
  if (this._abortController) {
    this._abortController.abort();
    this._abortController = null;
  }

  // 3. Remove beforeunload guard
  this._removeBeforeUnloadGuard();

  // 4. Clear all references
  this._callbacks = null;
  this._apiClient = null;
  this._context = null;
  this._state = null;
  this._stepDefinitions = null;

  // 5. Remove DOM
  if (this._container) {
    this._container.innerHTML = '';
    this._container = null;
  }

  // 6. Remove floating badge if minimized
  const badge = document.querySelector('.floating-badge');
  if (badge) {
    badge.remove();
  }
}
```

### 9.5 Log Management

Log entries accumulate during execution. For long-running LRO polling, this could mean hundreds of "Polling... (status: InProgress)" entries. The pipeline caps log entries per step.

```javascript
/** Maximum log entries per step before oldest are removed */
static MAX_LOG_ENTRIES = 100;

_addLog(stepIndex, level, message, data) {
  const step = this._state.steps[stepIndex];
  const entry = {
    timestamp: Date.now(),
    level,
    message,
    data: data || undefined,
  };

  step.logs.push(entry);

  // Evict oldest entries if limit exceeded
  if (step.logs.length > ExecutionPipeline.MAX_LOG_ENTRIES) {
    const removed = step.logs.splice(0, step.logs.length - ExecutionPipeline.MAX_LOG_ENTRIES);
    // Update DOM: remove oldest log entry elements
    this._evictOldLogEntries(stepIndex, removed.length);
  }

  // Append to DOM
  this._appendLogEntry(stepIndex, entry);
}
```

### 9.6 LRO Polling Optimization

The LRO polling for notebook execution (Step 5) uses an adaptive polling interval that backs off over time:

```javascript
/**
 * Adaptive LRO polling with backoff.
 *
 * - First 30 seconds: poll every 3 seconds (normal interval)
 * - 30s–60s: poll every 5 seconds
 * - 60s–180s: poll every 10 seconds
 * - 180s+: poll every 15 seconds
 *
 * This reduces API load for long-running notebooks while
 * still providing responsive feedback for quick executions.
 */
_getAdaptivePollInterval(elapsedMs) {
  if (elapsedMs < 30_000) return 3000;
  if (elapsedMs < 60_000) return 5000;
  if (elapsedMs < 180_000) return 10_000;
  return 15_000;
}
```

### 9.7 Performance Budgets

| Metric | Budget | Measurement |
|--------|--------|-------------|
| Initial render time | < 50ms | Time from constructor to first paint |
| Timer jank | < 16ms per update | `_updateTimerDisplay()` execution time |
| Log append | < 5ms per entry | `_appendLogEntry()` execution time |
| Step transition | < 100ms | Status change to visual update |
| Memory (peak) | < 5MB | Total pipeline instance memory |
| DOM nodes | < 200 | Total nodes in pipeline subtree |

### 9.8 Network Request Optimization

- **No parallel requests**: All 6 steps are sequential — no concurrent fetch calls
- **Single AbortController**: One controller per step, aborted on timeout or destroy
- **No keepalive**: Standard fetch — connection handling is left to the browser
- **No retry queue**: Retries are inline (await delay, then re-call), not queued
- **Request deduplication**: Not needed — each step executes exactly once (or once per retry)

---


## 10. Implementation Notes

### 10.1 Execution Engine Pseudocode

The core execution engine is the `start()` method — a sequential loop over the step definitions with per-step error handling, retry logic, and artifact propagation.

```javascript
/**
 * PSEUDOCODE: Core pipeline execution engine.
 *
 * This is the main loop that drives the entire pipeline.
 * Each step is executed sequentially. Artifacts from early steps
 * are consumed by later steps. Errors trigger the retry/failure flow.
 */
async start() {
  // ── Validation ──────────────────────────────────────────
  if (!this._apiClient) throw new Error('API client not set. Call setApiClient() first.');
  if (this._state.status !== 'idle' && this._state.status !== 'retrying') {
    throw new Error(`Cannot start pipeline in ${this._state.status} state`);
  }

  // ── Determine starting step ─────────────────────────────
  const startIndex = this._state.status === 'retrying'
    ? this._state.activeStepIndex  // Resume from failed step
    : 0;                            // Start from beginning

  // ── Initialize pipeline state ───────────────────────────
  this._state.status = 'executing';
  this._state.timing.startedAt = performance.now();
  this._startTimer();
  this._addBeforeUnloadGuard();
  this._callbacks.onStart();
  this._emitEvent('pipeline:start');

  // ── Announce to screen reader ───────────────────────────
  this._announce(
    `Creating your environment. Step ${startIndex + 1} of 6: ${this._stepDefinitions[startIndex].name}.`,
    'assertive'
  );

  // ── Sequential step execution ───────────────────────────
  try {
    for (let i = startIndex; i < 6; i++) {
      const stepDef = this._stepDefinitions[i];
      const stepState = this._state.steps[i];

      // Skip already-completed steps during retry
      if (stepState.status === 'skipped' || stepState.status === 'succeeded') {
        continue;
      }

      // ── Begin step ────────────────────────────────────
      this._state.activeStepIndex = i;
      this._updateStep(i, {
        status: 'running',
        timing: { startedAt: performance.now(), completedAt: null, elapsedMs: 0, elapsedFormatted: '0.0s' },
      });

      // Auto-expand running step, collapse others
      if (this._options.autoExpandRunning) {
        this._collapseAllSteps();
        this._expandStep(i);
      }

      this._addLog(i, 'info', `${stepDef.description}...`);
      this._emitEvent('pipeline:step:start', { stepIndex: i, stepId: stepDef.id });
      this._scrollToActiveStep();

      // ── Execute with retry loop ───────────────────────
      let succeeded = false;
      let lastError = null;

      for (let attempt = 0; attempt <= stepDef.autoRetries; attempt++) {
        try {
          if (attempt > 0) {
            // Retry delay with exponential backoff
            const delay = this._calculateRetryDelay(attempt - 1, stepDef.retryDelayMs);
            this._addLog(i, 'warning', `Retrying in ${(delay / 1000).toFixed(1)}s... (attempt ${attempt + 1})`);
            await this._sleep(delay);
          }

          // ── Build request ─────────────────────────────
          const url = this._interpolateUrl(stepDef.urlTemplate, this._state.artifacts);
          const body = stepDef.buildBody(this._context, this._state.artifacts);

          this._addLog(i, 'debug', `${stepDef.method} ${url}`);

          // ── API call ──────────────────────────────────
          let response;
          if (stepDef.isLRO) {
            response = await this._executeLROStep(stepDef, stepState);
          } else {
            response = await this._executeSimpleStep(stepDef, url, body);
          }

          // ── Extract artifacts ─────────────────────────
          const newArtifacts = stepDef.extractArtifacts(response);
          Object.assign(this._state.artifacts, newArtifacts);

          // ── Track resource for rollback ────────────────
          if (stepDef.createsResource && stepDef.resourceType) {
            const resourceId = this._getResourceId(stepDef.resourceType, newArtifacts);
            if (resourceId) {
              this._trackResource(
                stepDef.resourceType,
                resourceId,
                this._getResourceName(stepDef, this._context),
                stepDef.id
              );
            }
          }

          // ── Step succeeded ────────────────────────────
          const elapsed = performance.now() - stepState.timing.startedAt;
          this._updateStep(i, {
            status: 'succeeded',
            timing: {
              ...stepState.timing,
              completedAt: performance.now(),
              elapsedMs: elapsed,
              elapsedFormatted: this._formatElapsed(elapsed),
            },
            httpStatus: response?._httpStatus || 200,
          });

          this._addLog(i, 'success', `✓ Completed in ${this._formatElapsed(elapsed)}`);

          // Collapse completed step
          if (this._options.collapseCompleted) {
            this._collapseStep(i);
          }

          this._emitEvent('pipeline:step:complete', { stepIndex: i, stepId: stepDef.id });

          // Announce to screen reader
          const nextStep = i < 5 ? ` Starting step ${i + 2}: ${this._stepDefinitions[i + 1].name}.` : '';
          this._announce(
            `Step ${i + 1} completed: ${stepDef.name}. ${this._formatElapsed(elapsed)}.${nextStep}`,
            'polite'
          );

          this._callbacks.onUpdate(this._state);
          succeeded = true;
          break; // Exit retry loop

        } catch (error) {
          lastError = error;
          stepState.retryCount = attempt + 1;

          const httpStatus = error.httpStatus || null;
          const category = this._classifyError(error, httpStatus);

          if (attempt < stepDef.autoRetries && this._isRetryable(category)) {
            this._addLog(i, 'warning',
              `⚠ ${error.message} (${httpStatus || 'network error'}). Retrying...`);
            continue; // Auto-retry
          }

          // ── All retries exhausted — step failed ─────
          throw error; // Propagate to outer catch
        }
      }

      if (!succeeded) {
        throw lastError;
      }
    }

    // ── All 6 steps completed ─────────────────────────────
    this._state.status = 'succeeded';
    this._state.timing.completedAt = performance.now();
    this._state.timing.elapsedMs = this._state.timing.completedAt - this._state.timing.startedAt;
    this._state.activeStepIndex = null;
    this._stopTimer();
    this._removeBeforeUnloadGuard();

    // Build workspace URL for navigation
    this._state.artifacts.workspaceUrl = `/groups/${this._state.artifacts.workspaceId}`;

    this._renderSummary();
    this._callbacks.onSuccess(this._state.artifacts);
    this._emitEvent('pipeline:success');

    this._announce(
      `Environment created successfully! Total time: ${this._formatElapsed(this._state.timing.elapsedMs)}.`,
      'assertive'
    );

    return this._state.artifacts;

  } catch (error) {
    // ── Pipeline failed ─────────────────────────────────
    const activeIdx = this._state.activeStepIndex;
    const httpStatus = error.httpStatus || null;
    const category = this._classifyError(error, httpStatus);

    this._updateStep(activeIdx, {
      status: 'failed',
      error: {
        message: error.message,
        rawError: error.stack || String(error),
        httpStatus,
        category,
      },
      httpStatus,
    });

    // Auto-expand failed step
    if (this._options.autoExpandFailed) {
      this._expandStep(activeIdx);
    }

    this._addLog(activeIdx, 'error', `✕ ${error.message}`);

    const pipelineError = {
      failedStepId: this._stepDefinitions[activeIdx].id,
      failedStepIndex: activeIdx,
      message: this._getUserFriendlyMessage(category, error),
      rawError: error.stack || String(error),
      httpStatus,
      isRetryable: this._isRetryable(category),
      shouldRollback: activeIdx > 0, // Only suggest rollback if resources were created
      suggestedAction: this._isRetryable(category) ? 'retry' : (activeIdx > 0 ? 'rollback' : 'manual'),
      retryAttempts: this._state.retryCount,
      occurredAt: Date.now(),
      category,
    };

    this._state.status = 'failed';
    this._state.error = pipelineError;
    this._stopTimer();

    this._renderErrorPanel(pipelineError);
    this._callbacks.onFailure(pipelineError);
    this._emitEvent('pipeline:failed', { error: pipelineError });

    this._announce(
      `Step ${activeIdx + 1} failed: ${this._stepDefinitions[activeIdx].name}. ${pipelineError.message}. Retry options available.`,
      'assertive'
    );

    throw pipelineError;
  }
}
```

### 10.2 LRO Polling Implementation

```javascript
/**
 * PSEUDOCODE: Execute a Long-Running Operation step.
 *
 * 1. Make the initial API call (expects 202 response)
 * 2. Extract the poll URL from the response or construct from artifacts
 * 3. Poll at adaptive intervals until completion or timeout
 * 4. Return the final response payload
 *
 * @param {StepDefinition} stepDef - The step definition
 * @param {StepState} stepState - The mutable step state
 * @returns {Promise<object>} The final LRO response
 */
async _executeLROStep(stepDef, stepState) {
  const { lroConfig } = stepDef;
  const url = this._interpolateUrl(stepDef.urlTemplate, this._state.artifacts);
  const body = stepDef.buildBody(this._context, this._state.artifacts);

  // ── Initial request ───────────────────────────────────
  const initialResponse = await this._fetchWithTimeout(
    `/api/fabric${url}`,
    {
      method: stepDef.method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    },
    stepDef.timeoutMs
  );

  if (!stepDef.expectedStatus.includes(initialResponse.status)) {
    const errorBody = await initialResponse.text();
    const error = new Error(`Expected ${stepDef.expectedStatus.join('/')}, got ${initialResponse.status}`);
    error.httpStatus = initialResponse.status;
    error.responseBody = errorBody;
    throw error;
  }

  // ── Extract job instance ID from response ─────────────
  let responseData;
  try {
    responseData = await initialResponse.json();
  } catch {
    responseData = {};
  }

  // Extract artifacts (e.g., jobInstanceId) from the initial response
  const initialArtifacts = stepDef.extractArtifacts(responseData);
  Object.assign(this._state.artifacts, initialArtifacts);

  // ── Build poll URL ────────────────────────────────────
  // Try Location header first, then construct from config
  const locationHeader = initialResponse.headers.get('Location');
  const pollUrl = locationHeader
    ? locationHeader
    : lroConfig.extractPollUrl(initialResponse, this._state.artifacts);

  this._addLog(stepState.index, 'info', 'Job submitted. Polling for completion...');

  // ── Polling loop ──────────────────────────────────────
  const pollStartTime = performance.now();

  while (true) {
    const pollElapsed = performance.now() - pollStartTime;

    // Check timeout
    if (pollElapsed > lroConfig.maxPollDurationMs) {
      const error = new Error(
        `Operation timed out after ${this._formatElapsed(pollElapsed)}`
      );
      error.category = 'lro_timeout';
      throw error;
    }

    // Wait for adaptive interval
    const interval = this._getAdaptivePollInterval(pollElapsed);
    await this._sleep(interval);

    // Poll
    const pollResponse = await this._fetchWithTimeout(
      `/api/fabric${pollUrl}`,
      { method: 'GET' },
      30_000
    );

    const pollData = await pollResponse.json();
    const result = lroConfig.checkCompletion(pollData);

    if (result) {
      if (result.succeeded) {
        this._addLog(stepState.index, 'info', `Job completed (status: ${result.status})`);
        return result.payload;
      } else {
        const error = new Error(result.errorMessage || `Operation failed (status: ${result.status})`);
        error.category = 'lro_failed';
        error.httpStatus = null; // LRO failure is not an HTTP error
        throw error;
      }
    }

    // Still in progress
    this._addLog(stepState.index, 'debug',
      `Polling... status: ${pollData.status || 'unknown'} (${this._formatElapsed(pollElapsed)})`
    );
  }
}
```

### 10.3 Retry From Failed Step Implementation

```javascript
/**
 * PSEUDOCODE: Retry pipeline execution from the failed step.
 *
 * Preconditions:
 *   - Pipeline status is 'failed'
 *   - At least one step has failed
 *   - retryCount < maxRetriesPerStep
 *
 * Steps:
 *   1. Mark completed steps as 'skipped'
 *   2. Reset the failed step to 'pending'
 *   3. Increment pipeline retryCount
 *   4. Transition to 'retrying' state
 *   5. Call start() which resumes from the failed step
 */
async retryFromFailed() {
  if (this._state.status !== 'failed') {
    throw new Error('Cannot retry: pipeline is not in failed state');
  }

  const failedIndex = this._state.error.failedStepIndex;

  if (this._state.retryCount >= this._options.maxRetriesPerStep) {
    throw new Error(`Maximum retries (${this._options.maxRetriesPerStep}) exceeded`);
  }

  // ── Mark completed steps as skipped ─────────────────
  for (let i = 0; i < failedIndex; i++) {
    if (this._state.steps[i].status === 'succeeded') {
      this._updateStep(i, { status: 'skipped', skipped: true });
    }
  }

  // ── Reset failed step ───────────────────────────────
  this._updateStep(failedIndex, {
    status: 'pending',
    error: null,
    retryCount: 0,
    logs: [],
    isExpanded: false,
    httpStatus: null,
    timing: { startedAt: null, completedAt: null, elapsedMs: 0, elapsedFormatted: '' },
  });

  // ── Reset pending steps after the failed step ───────
  for (let i = failedIndex + 1; i < 6; i++) {
    this._updateStep(i, {
      status: 'pending',
      error: null,
      retryCount: 0,
      logs: [],
      isExpanded: false,
      httpStatus: null,
      timing: { startedAt: null, completedAt: null, elapsedMs: 0, elapsedFormatted: '' },
    });
  }

  // ── Transition to retrying ──────────────────────────
  this._state.retryCount++;
  this._state.status = 'retrying';
  this._state.error = null;
  this._state.activeStepIndex = failedIndex;

  // Remove error panel
  const errorPanel = this._container.querySelector('.pipeline-error');
  if (errorPanel) errorPanel.remove();

  this._callbacks.onRetry(failedIndex);
  this._emitEvent('pipeline:step:retry', { stepIndex: failedIndex });

  // ── Resume execution ────────────────────────────────
  return this.start(); // start() checks for 'retrying' state and resumes
}
```

### 10.4 Rollback Implementation

```javascript
/**
 * PSEUDOCODE: Full rollback of created resources.
 *
 * Deletes resources in REVERSE creation order:
 *   1. Notebook (if created)
 *   2. Lakehouse (if created)
 *   3. Workspace (if created — also removes capacity assignment)
 *
 * Each DELETE is independent. Failures do NOT stop remaining deletions.
 */
async rollback() {
  if (this._state.status !== 'failed' && this._state.status !== 'rollback_failed') {
    throw new Error('Cannot rollback: pipeline is not in failed state');
  }

  const manifest = this._state.rollbackManifest;
  if (manifest.resources.length === 0) {
    throw new Error('Nothing to rollback: no resources were created');
  }

  // ── Begin rollback ──────────────────────────────────
  this._updateState({ status: 'rolling_back' });
  this._callbacks.onRollbackStart();
  this._emitEvent('pipeline:rollback:start');

  this._announce('Rolling back created resources.', 'assertive');

  // ── Delete in reverse order ─────────────────────────
  const resources = [...manifest.resources].reverse();
  const results = [];

  for (const resource of resources) {
    this._addLog(this._getStepIndex(resource.createdByStep), 'info',
      `Deleting ${resource.type} '${resource.displayName}'...`);

    const result = await this._deleteResource(resource);
    results.push(result);

    if (result.succeeded) {
      this._addLog(this._getStepIndex(resource.createdByStep), 'success',
        `✓ Deleted ${resource.type} '${resource.displayName}' (${this._formatElapsed(result.elapsedMs)})`);
    } else {
      this._addLog(this._getStepIndex(resource.createdByStep), 'error',
        `✕ Failed to delete ${resource.type}: ${result.errorMessage}`);
    }
  }

  // ── Record results ──────────────────────────────────
  manifest.rollbackAttempted = true;
  manifest.rollbackResults = results;

  const allSucceeded = results.every(r => r.succeeded);
  this._updateState({
    status: allSucceeded ? 'rolled_back' : 'rollback_failed',
  });

  // ── Render rollback summary ─────────────────────────
  this._renderRollbackSummary(results, allSucceeded);

  this._callbacks.onRollbackComplete(manifest);
  this._emitEvent('pipeline:rollback:complete', { allSucceeded, results });

  if (allSucceeded) {
    this._announce('Rollback complete. All resources have been deleted.', 'assertive');
  } else {
    const failedCount = results.filter(r => !r.succeeded).length;
    this._announce(
      `Rollback completed with ${failedCount} error(s). Some resources need manual cleanup.`,
      'assertive'
    );
  }

  return manifest;
}

/**
 * Delete a single resource during rollback.
 *
 * @param {RollbackResource} resource - The resource to delete
 * @returns {Promise<RollbackResult>}
 */
async _deleteResource(resource) {
  const startTime = performance.now();

  try {
    let url;
    switch (resource.type) {
      case 'notebook':
        url = `/v1/workspaces/${resource.parentWorkspaceId}/notebooks/${resource.id}`;
        break;
      case 'lakehouse':
        url = `/v1/workspaces/${resource.parentWorkspaceId}/lakehouses/${resource.id}`;
        break;
      case 'workspace':
        url = `/v1/workspaces/${resource.id}`;
        break;
      default:
        throw new Error(`Unknown resource type: ${resource.type}`);
    }

    const response = await this._fetchWithTimeout(
      `/api/fabric${url}`,
      { method: 'DELETE' },
      30_000
    );

    const elapsed = performance.now() - startTime;

    if (response.ok) {
      return {
        resource,
        succeeded: true,
        httpStatus: response.status,
        elapsedMs: elapsed,
      };
    } else {
      const errorBody = await response.text();
      return {
        resource,
        succeeded: false,
        httpStatus: response.status,
        errorMessage: `HTTP ${response.status}: ${errorBody}`,
        elapsedMs: elapsed,
      };
    }
  } catch (error) {
    return {
      resource,
      succeeded: false,
      httpStatus: null,
      errorMessage: error.message,
      elapsedMs: performance.now() - startTime,
    };
  }
}
```

### 10.5 Notebook Payload Construction

The notebook payload for Step 4 (Write Cells) requires converting the topologically-sorted cells array into the Fabric notebook definition format.

```javascript
/**
 * Build the notebook payload from sorted cells.
 * The payload is a base64-encoded JSON string matching the
 * format returned by GET /notebooks/{id}/getDefinition.
 *
 * Each cell becomes an entry in the notebook's cell array.
 * Cells are ordered by their topological sort index.
 *
 * @param {NotebookCell[]} cells - Topologically sorted cells from C09
 * @returns {string} Base64-encoded notebook content
 */
function _buildNotebookPayload(cells) {
  const notebookJson = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      language_info: {
        name: 'python',
      },
      a]365ComputeOptions: null,
      trident: {
        lakehouse: {
          default_lakehouse_name: '', // Set by runtime
          default_lakehouse_workspace_id: '', // Set by runtime
        },
      },
    },
    cells: cells.map((cell, index) => ({
      cell_type: 'code',
      source: cell.code,
      metadata: {
        microsoft: {
          language: cell.language === 'sparksql' ? 'sparksql' : 'python',
        },
        collapsed: false,
      },
      outputs: [],
      execution_count: null,
      id: cell.id || `cell-${index}`,
    })),
  };

  // Base64 encode
  const jsonString = JSON.stringify(notebookJson, null, 2);
  return btoa(unescape(encodeURIComponent(jsonString)));
}
```

### 10.6 URL Interpolation

```javascript
/**
 * Interpolate URL template with artifact values.
 * Replaces {variableName} placeholders with values from the artifacts object.
 *
 * Example:
 *   template: "/v1/workspaces/{workspaceId}/notebooks/{notebookId}"
 *   artifacts: { workspaceId: "ws-123", notebookId: "nb-456" }
 *   result: "/v1/workspaces/ws-123/notebooks/nb-456"
 *
 * @param {string} template - URL with {variable} placeholders
 * @param {ExecutionArtifacts} artifacts - Current artifacts
 * @returns {string} Interpolated URL
 * @throws {Error} If a required variable is missing from artifacts
 */
_interpolateUrl(template, artifacts) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = artifacts[key];
    if (value === null || value === undefined) {
      throw new Error(`Missing artifact '${key}' for URL template: ${template}`);
    }
    return encodeURIComponent(value);
  });
}
```

### 10.7 SimpleStep Execution (Non-LRO)

```javascript
/**
 * Execute a non-LRO step (simple request-response).
 *
 * @param {StepDefinition} stepDef - Step definition
 * @param {string} url - Interpolated API URL
 * @param {object|null} body - Request body
 * @returns {Promise<object>} Parsed response JSON
 */
async _executeSimpleStep(stepDef, url, body) {
  const response = await this._fetchWithTimeout(
    `/api/fabric${url}`,
    {
      method: stepDef.method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    },
    stepDef.timeoutMs
  );

  if (!stepDef.expectedStatus.includes(response.status)) {
    let errorBody;
    try {
      errorBody = await response.text();
    } catch {
      errorBody = 'Unable to read response body';
    }

    const error = new Error(
      `${stepDef.name} failed: HTTP ${response.status}${errorBody ? ` — ${errorBody.substring(0, 200)}` : ''}`
    );
    error.httpStatus = response.status;
    error.responseBody = errorBody;
    throw error;
  }

  // Parse response
  let data;
  try {
    data = await response.json();
  } catch {
    data = {}; // Some endpoints return empty body on success
  }

  // Attach HTTP status for diagnostics
  data._httpStatus = response.status;
  return data;
}
```

### 10.8 Utility: Sleep with Abort Support

```javascript
/**
 * Promise-based sleep that can be aborted.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
_sleep(ms) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(resolve, ms);

    // If the pipeline is destroyed during sleep, reject
    if (this._abortController) {
      this._abortController.signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}
```

### 10.9 Render Methods

```javascript
/**
 * Initial render of the pipeline UI.
 * Creates the DOM structure for all 6 steps and the header.
 */
_render() {
  this._container.innerHTML = '';
  this._container.setAttribute('role', 'region');
  this._container.setAttribute('aria-label', 'Environment creation pipeline');
  this._container.classList.add('execution-pipeline');

  // Screen reader announcer (visually hidden)
  const announcer = document.createElement('div');
  announcer.className = 'sr-announcer';
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('role', 'status');
  this._container.appendChild(announcer);

  // Header
  const header = document.createElement('div');
  header.className = 'pipeline-header';
  header.innerHTML = `
    <h3 class="pipeline-header__title" id="pipeline-title">Creating Your Environment</h3>
    <span class="pipeline-header__timer" role="timer" aria-label="Total elapsed time" aria-live="off">0.0s</span>
  `;
  this._container.appendChild(header);

  // Steps container
  const stepsContainer = document.createElement('ol');
  stepsContainer.className = 'pipeline-steps';
  stepsContainer.setAttribute('role', 'list');
  stepsContainer.setAttribute('aria-label', 'Pipeline steps');

  for (let i = 0; i < 6; i++) {
    const stepEl = this._createStepElement(i);
    stepsContainer.appendChild(stepEl);
  }

  this._container.appendChild(stepsContainer);
}

/**
 * Create DOM element for a single pipeline step.
 *
 * @param {number} index - Step index (0-5)
 * @returns {HTMLElement}
 */
_createStepElement(index) {
  const stepDef = this._stepDefinitions[index];
  const stepState = this._state.steps[index];

  const li = document.createElement('li');
  li.className = 'pipeline-step';
  li.setAttribute('role', 'listitem');
  li.setAttribute('data-index', index);
  li.setAttribute('data-status', stepState.status);
  li.setAttribute('aria-label',
    `Step ${index + 1}: ${stepDef.name} — ${this._getStatusLabel(stepState.status)}`
  );

  // Status icon
  const statusIcon = document.createElement('span');
  statusIcon.className = `step-status step-status--${stepState.status}`;
  statusIcon.setAttribute('role', 'img');
  statusIcon.setAttribute('aria-hidden', 'true');
  statusIcon.innerHTML = this._getStatusIconContent(stepState.status);
  li.appendChild(statusIcon);

  // Step info button (clickable to expand/collapse)
  const infoBtn = document.createElement('button');
  infoBtn.className = 'step-info';
  infoBtn.type = 'button';
  infoBtn.setAttribute('aria-expanded', String(stepState.isExpanded));
  infoBtn.setAttribute('aria-controls', `step-${index}-detail`);

  infoBtn.innerHTML = `
    <span class="step-name">${stepDef.name}</span>
    <span class="step-time" aria-label="Duration">${stepState.timing.elapsedFormatted || ''}</span>
    <span class="step-expand" aria-hidden="true">▸</span>
  `;

  infoBtn.addEventListener('click', () => this._toggleStep(index));
  li.appendChild(infoBtn);

  // Detail panel
  const detail = document.createElement('div');
  detail.className = 'step-detail';
  detail.id = `step-${index}-detail`;
  detail.setAttribute('role', 'log');
  detail.setAttribute('aria-label', `Step ${index + 1} log output`);
  if (!stepState.isExpanded) {
    detail.hidden = true;
  }

  const logContainer = document.createElement('div');
  logContainer.className = 'step-detail__log';
  detail.appendChild(logContainer);
  li.appendChild(detail);

  return li;
}
```

### 10.10 Floating Badge Integration

The `ExecutionPipeline` creates and manages the `FloatingBadge` (C11) when the wizard is minimized.

```javascript
/**
 * Create or update the floating badge.
 * The badge is a fixed-position pill in the bottom-right corner.
 */
_updateFloatingBadge() {
  let badge = document.querySelector('.floating-badge');

  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'floating-badge';
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.setAttribute('aria-label', 'Restore environment creation wizard');
    badge.addEventListener('click', () => this.restore());
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.restore();
      }
    });
    document.body.appendChild(badge);
  }

  // Update badge content based on pipeline state
  const { status, activeStepIndex, steps } = this._state;

  if (status === 'executing' && activeStepIndex !== null) {
    const step = steps[activeStepIndex];
    const completedCount = steps.filter(s => s.status === 'succeeded' || s.status === 'skipped').length;

    badge.className = 'floating-badge floating-badge--running';
    badge.innerHTML = `
      <span class="badge-dot badge-dot--running"></span>
      <span class="badge-progress">${completedCount}/6 ${step.name || 'Running'}...</span>
    `;
    badge.setAttribute('aria-label',
      `Environment creation in progress. ${completedCount} of 6 steps complete. Currently: ${step.name}. Click to restore.`
    );
  } else if (status === 'succeeded') {
    badge.className = 'floating-badge floating-badge--succeeded';
    badge.innerHTML = `
      <span class="badge-dot badge-dot--succeeded"></span>
      <span class="badge-progress">Done! Click to view</span>
    `;
    badge.setAttribute('aria-label', 'Environment created successfully. Click to view details.');
  } else if (status === 'failed') {
    const failedStep = this._state.error?.failedStepId || 'unknown';
    badge.className = 'floating-badge floating-badge--failed';
    badge.innerHTML = `
      <span class="badge-dot badge-dot--failed"></span>
      <span class="badge-progress">Failed at step ${(this._state.error?.failedStepIndex || 0) + 1}</span>
    `;
    badge.setAttribute('aria-label',
      `Environment creation failed at step ${(this._state.error?.failedStepIndex || 0) + 1}. Click to view error details.`
    );
  }
}
```

### 10.11 FabricApiClient Method Requirements

The following methods must exist on `FabricApiClient` for the pipeline to function. Methods marked "EXISTING" are already implemented. Methods marked "NEW" must be added.

| Method | Status | Step | Notes |
|--------|--------|------|-------|
| `createWorkspace(name, description, capacityId)` | EXISTING (needs enhancement) | 0 | Add capacityId parameter to metadata API call |
| `assignCapacity(wsId, capacityId)` | **NEW** | 1 | POST to `/v1/workspaces/{wsId}/assignToCapacity` |
| `createLakehouse(wsId, name, enableSchemas)` | EXISTING (needs enhancement) | 2 | Add `enableSchemas` parameter |
| `createNotebook(wsId, name, description)` | **NEW** | 3 | POST to `/v1/workspaces/{wsId}/notebooks` |
| `updateNotebookDefinition(wsId, nbId, definition)` | EXISTING (`saveNotebookContent`) | 4 | Already implemented as `saveNotebookContent` |
| `runNotebook(wsId, nbId)` | EXISTING | 5 | Returns 202 with job instance |
| `getNotebookRunStatus(wsId, nbId, jobId)` | EXISTING | 5 (poll) | Returns job status |
| `deleteWorkspace(wsId)` | EXISTING | Rollback | — |
| `deleteLakehouse(wsId, lhId)` | **NEW** | Rollback | DELETE endpoint |
| `deleteNotebook(wsId, nbId)` | **NEW** (but uses generic `deleteItem`) | Rollback | DELETE endpoint |
| `listCapacities()` | **NEW** | Pre-req (Page 2) | Not used by C10 directly but needed for wizard |

**Summary: 4 new methods needed, 2 existing methods need enhancement.**

### 10.12 File Structure

```
src/
  modules/
    wizard/
      execution-pipeline.js    ← Main component (~800–1000 LOC)
      execution-pipeline.css   ← All CSS from §6.2 (~300 LOC)
      step-definitions.js      ← Step registry from §3.5 (~200 LOC)
      notebook-payload.js      ← Payload builder from §10.5 (~60 LOC)
      pipeline-constants.js    ← Error messages, defaults (~80 LOC)
```

### 10.13 Testing Strategy

Testing is detailed in a separate document, but key areas include:

| Test Category | Priority | Approach |
|---------------|----------|----------|
| State machine transitions | P0 | Unit tests for every transition in §4.2 |
| Retry logic | P0 | Unit tests with mock fetch for each error category |
| Rollback sequence | P0 | Unit tests verifying reverse-order deletion |
| LRO polling | P0 | Unit tests with mock polling responses |
| Timer accuracy | P1 | Unit tests with fake timers |
| DOM rendering | P1 | Snapshot tests for each step status |
| Keyboard navigation | P1 | Integration tests with keyboard events |
| Screen reader announcements | P2 | Check `aria-live` region content |
| Floating badge | P2 | Integration tests for minimize/restore |
| Edge cases (empty cells, network drop) | P1 | Unit tests for each scenario in §5 |

### 10.14 Implementation Order

The recommended implementation order minimizes blocking dependencies:

```
Phase 1 (Foundation):
  1. pipeline-constants.js — defaults, error messages
  2. step-definitions.js — step registry
  3. notebook-payload.js — payload builder

Phase 2 (Core Engine):
  4. execution-pipeline.js — constructor, state init, _render()
  5. execution-pipeline.js — _executeStep(), _executeSimpleStep()
  6. execution-pipeline.js — _executeLROStep(), _pollLRO()
  7. execution-pipeline.js — start() orchestration loop

Phase 3 (Error Handling):
  8. execution-pipeline.js — error classification, retry logic
  9. execution-pipeline.js — retryFromFailed()
  10. execution-pipeline.js — rollback(), _deleteResource()

Phase 4 (UI Polish):
  11. execution-pipeline.css — all visual styles
  12. execution-pipeline.js — timer, animations, expand/collapse
  13. execution-pipeline.js — minimize/restore, floating badge
  14. execution-pipeline.js — accessibility (announcements, focus)

Phase 5 (Integration):
  15. FabricApiClient enhancements (4 new methods + 2 updates)
  16. WizardShell integration (Page 5 mount/unmount)
  17. End-to-end testing with mock API
```

### 10.15 Open Questions and Unresolved Items

| # | Question | Impact | Status |
|---|----------|--------|--------|
| 1 | `enableSchemas: true` in lakehouse creation — does the API accept this field? | Step 2 may fail | ⚠️ NOT TESTED |
| 2 | Notebook `updateDefinition` — is the payload format correct (nbformat 4)? | Step 4 may produce malformed notebook | ⚠️ NEEDS VALIDATION |
| 3 | Capacity assignment (202 response) — does it require LRO polling or is it immediate? | Step 1 may need polling logic | ⚠️ NOT TESTED |
| 4 | Delete workspace/lakehouse endpoints — do they return 200 or 204? | Rollback success detection | ⚠️ NOT TESTED |
| 5 | Notebook execution — what happens if the Spark pool is busy? | Step 5 may queue for extended time | ❓ UNKNOWN |
| 6 | Maximum notebook cell count before updateDefinition fails (413)? | Step 4 payload size limit | ❓ UNKNOWN |
| 7 | Workspace name uniqueness — is it per-capacity or global? | Error messaging for Step 0 conflicts | ❓ UNKNOWN |

### 10.16 Dependencies on Other Components

| Component | What C10 Needs | When |
|-----------|---------------|------|
| C01 (WizardShell) | `mountPage5(container)` lifecycle hook, `onMinimize`/`onRestore` handlers | Integration (Phase 5) |
| C02 (WizardStepper) | Step 5 indicator shown as "active" during execution | Integration (Phase 5) |
| C03 (WizardDataBus) | Finalized `ExecutionContext` object with all user inputs | Start of execution |
| C09 (NotebookCellBuilder) | Topologically sorted `NotebookCell[]` array | Step 4 (Write Cells) |
| C11 (FloatingBadge) | Badge component for minimized state | Phase 4 (UI Polish) |

### 10.17 Reusability from Existing Codebase

The following patterns from the existing codebase should be reused or adapted:

| Pattern | Source | Adaptation |
|---------|--------|------------|
| Elapsed timer | `deploy-flow.js` | Same concept, 100ms interval instead of 1000ms |
| Step state machine | `deploy-flow.js` | Extended from 3 states to 5 states |
| API error handling | `api-client.js` | Extended with error classification and retry |
| CSS status colors | `variables.css` | Reuse `--status-succeeded`, `--status-failed` tokens |
| CSS spacing grid | Design system | Standard 4px grid |
| Event emission | `EventBus` | Standard pattern, new event types |
| Proxy routing | `dev-server.py` | All `/api/fabric/*` requests use existing proxy |

---

*End of C10-ExecutionPipeline Component Deep Spec*

*Spec Version: 1.0.0 | Generated: 2025-07-14 | Agents: Pixel (primary), Vex (API integration), Sana (architecture review), Sentinel (quality gate)*
