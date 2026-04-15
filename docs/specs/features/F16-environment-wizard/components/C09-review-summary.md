# C09-ReviewSummary — Component Deep Spec

> **Component ID:** C09  
> **Parent Feature:** F16 — New Infrastructure Wizard  
> **Wizard Page:** 4 of 4 (Review & Confirm)  
> **Spec Version:** 1.0  
> **Status:** Draft  
> **Author:** Sana (Architecture) + Pixel (Visual) + Vex (Backend)  
> **Last Updated:** 2025-01-XX  

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

C09-ReviewSummary is the final confirmation gate of the New Infrastructure Wizard (F16). It presents a comprehensive, read-only summary of every decision the user made across Pages 1-3 before committing to the irreversible `POST /api/environments` call. This component is the last line of defense against misconfiguration — a mismatched capacity SKU, a missing schema, or an unintended node topology will be caught here or not at all.

The component follows the **Azure Portal review pattern** (as documented in the F16 wizard research, §4): group selections by wizard step, provide per-section Edit affordances that navigate back to the relevant page, and execute a final cross-step validation sweep before enabling the primary action.

### 1.2 Responsibilities

| Responsibility | Description |
|---|---|
| **Data Aggregation** | Collect and normalize wizard state from Pages 1-3 into a structured review model |
| **Summary Rendering** | Display Infrastructure, Configuration, and DAG Topology summaries in a two-column layout |
| **Cross-Step Validation** | Run a final consistency check (e.g., schemas referenced in nodes exist in selected schemas) |
| **Edit Navigation** | Each section provides a clickable affordance to navigate back to its source page |
| **Mini-DAG Visualization** | Render a compact, read-only version of the DAG topology from Page 3 |
| **Confirmation Gate** | Display what will be created (counts of resources) and require explicit user acknowledgment |
| **Template Save** | Offer optional "Save as Template" before execution |
| **Action Dispatch** | Transform the "Next" footer button into "Lock In & Create ▸" with pulse animation |

### 1.3 Key Design Decisions

- **Two-column 50/50 grid** (CEO-approved mock) — left column for textual summary + confirmation, right column for mini-DAG visualization. The wizard research recommended 60/40 but the CEO-approved mock uses `1fr 1fr` and that is authoritative.
- **Read-only presentation** — no inline editing on the review page. Modifications require navigating back to the source page via Edit links. This follows the Azure pattern and reduces complexity.
- **Mini-DAG is decorative-informational** — it provides spatial context but is not interactive. Nodes are not draggable or clickable. The full DAG editor lives on Page 3 (C07-DagCanvas).
- **Final validation is synchronous** — validation runs on mount and blocks the "Lock In & Create" button if errors are found. There is no server round-trip for validation; it is purely client-side cross-checking.
- **Template save is optional and non-blocking** — the user can save the current configuration as a template before or after creation. The template save flow does not gate the primary action.

### 1.4 Component Classification

| Attribute | Value |
|---|---|
| **Reusability** | MEDIUM — workspace inspector pattern (3-column property display) exists in codebase |
| **Complexity** | HIGH — aggregates state from 3 pages, renders mini-DAG, manages validation + template save |
| **Risk** | HIGH — last gate before irreversible environment creation |
| **Dependencies** | C04-SchemaSelector (schema data), C07-DagCanvas (node/connection data), C12-WizardShell (navigation, state) |
| **DOM Weight** | MEDIUM — ~150-250 elements depending on node count |
| **Render Budget** | 200ms initial render including mini-DAG SVG generation |

### 1.5 Relationship to Other Components

```
C12-WizardShell (parent — provides wizard state, navigation, footer control)
  └── C09-ReviewSummary (this component — Page 4 content)
        ├── reads from: C01-WorkspacePicker state (workspace, capacity, lakehouse, notebook)
        ├── reads from: C04-SchemaSelector state (theme, schemas)
        ├── reads from: C07-DagCanvas state (nodes, connections, topologicalOrder)
        ├── renders: Mini-DAG (simplified C07 output)
        ├── triggers: C12-WizardShell.setFooterAction("Lock In & Create ▸")
        └── emits: review:confirmed → C12-WizardShell → POST /api/environments
```

---

## 2. Data Model

### 2.1 Input Data — Wizard State Aggregation

C09 does not own any persistent state. It receives the complete wizard state from C12-WizardShell and transforms it into a review-oriented data model. The wizard state arrives as a single object containing selections from all three preceding pages.

#### 2.1.1 Page 1 Data — Infrastructure Selections

```javascript
/**
 * @typedef {Object} InfrastructureSelections
 * @property {string} workspaceName        — Display name of the selected Fabric workspace
 *                                            Example: "brave_turing_42"
 * @property {string} workspaceId          — GUID of the selected workspace
 *                                            Example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 * @property {string} capacityId           — GUID of the assigned capacity
 *                                            Example: "cap-001-east-us"
 * @property {string} capacityName         — Display name of the capacity
 *                                            Example: "F4"
 * @property {string} capacitySku          — SKU tier of the capacity
 *                                            Example: "F4"
 * @property {string} capacityRegion       — Azure region of the capacity
 *                                            Example: "East US"
 * @property {string} lakehouseName        — Name of the lakehouse to create or attach
 *                                            Example: "lh_production"
 * @property {boolean} lakehouseHasSchema  — Whether the lakehouse has schema support enabled
 *                                            Drives the "schema ✓" chip display
 * @property {string} notebookName         — Name of the notebook to create or attach
 *                                            Example: "nb_etl_pipeline"
 */
```

#### 2.1.2 Page 2 Data — Configuration Selections

```javascript
/**
 * @typedef {Object} ConfigurationSelections
 * @property {ThemeSelection} selectedTheme    — The chosen DAG theme
 * @property {string[]} selectedSchemas        — Array of selected schema names
 *                                               Always includes 'dbo'; optionally 'bronze', 'silver', 'gold'
 *                                               Example: ['dbo', 'bronze', 'silver', 'gold']
 */

/**
 * @typedef {Object} ThemeSelection
 * @property {string} id                       — Theme identifier
 *                                               Example: "medallion"
 * @property {string} name                     — Display name
 *                                               Example: "Medallion Architecture"
 * @property {string} icon                     — Unicode symbol for the theme
 *                                               Example: "◆"
 * @property {TableDefinition[]} tables        — Array of table definitions generated by this theme
 */

/**
 * @typedef {Object} TableDefinition
 * @property {string} name                     — Table name (e.g., "raw_events")
 * @property {string} schema                   — Schema assignment (e.g., "bronze")
 * @property {string} type                     — Table type: "source" | "transform" | "sink"
 * @property {ColumnDefinition[]} columns      — Column definitions for the table
 */
```

#### 2.1.3 Page 3 Data — DAG Topology

```javascript
/**
 * @typedef {Object} DagTopology
 * @property {DagNode[]} nodes                 — All nodes in the DAG
 * @property {DagConnection[]} connections     — All edges in the DAG
 * @property {string[]} topologicalOrder       — Node IDs in execution order
 */

/**
 * @typedef {Object} DagNode
 * @property {string} id                       — Unique node identifier
 *                                               Example: "node-001"
 * @property {string} name                     — Display name of the node
 *                                               Example: "raw_events"
 * @property {string} type                     — Node type: "source" | "transform" | "sink"
 * @property {string} schema                   — Schema assignment: "dbo" | "bronze" | "silver" | "gold"
 * @property {{x: number, y: number}} position — Canvas position (used for mini-DAG layout)
 * @property {Object} [metadata]               — Optional metadata (column count, description, etc.)
 */

/**
 * @typedef {Object} DagConnection
 * @property {string} sourceId                 — ID of the source node
 * @property {string} targetId                 — ID of the target node
 * @property {string} [label]                  — Optional edge label
 */
```

### 2.2 Internal Review Model

C09 transforms the raw wizard state into a structured review model optimized for rendering and validation.

```javascript
/**
 * @typedef {Object} ReviewModel
 * @property {ReviewSection[]} sections        — Ordered array of review sections
 * @property {MiniDagModel} miniDag            — Processed DAG data for mini visualization
 * @property {ConfirmationSummary} confirmation — Resource creation summary
 * @property {ValidationResult} validation     — Cross-step validation results
 * @property {number} timestamp                — When the review model was generated
 */

/**
 * @typedef {Object} ReviewSection
 * @property {string} id                       — Section identifier: "infrastructure" | "configuration"
 * @property {string} title                    — Display title: "Infrastructure" | "Configuration"
 * @property {number} sourcePageIndex          — Wizard page index (0-based) for Edit navigation
 * @property {ReviewRow[]} rows                — Key-value pairs to display
 */

/**
 * @typedef {Object} ReviewRow
 * @property {string} label                    — Left-side label text (e.g., "Workspace")
 * @property {string|ReviewValueChip[]} value  — Right-side value — either plain text or chip array
 * @property {string} [icon]                   — Optional Unicode icon prefix
 * @property {string} [valueClass]             — Optional CSS class for value styling
 *                                               Example: "accent" for theme name
 * @property {string} [chipVariant]            — For chip values: "schema" | "count" | "status"
 */

/**
 * @typedef {Object} ReviewValueChip
 * @property {string} text                     — Chip display text (e.g., "dbo", "Bronze")
 * @property {string} variant                  — Chip style variant: "default" | "schema" | "status"
 * @property {string} [color]                  — Optional OKLCH color override for schema chips
 */
```

### 2.3 Mini-DAG Rendering Model

The mini-DAG is a simplified, read-only visualization of the DAG topology from Page 3. It uses a scaled-down coordinate system and simplified node rendering compared to the full C07-DagCanvas.

```javascript
/**
 * @typedef {Object} MiniDagModel
 * @property {MiniNode[]} nodes                — Positioned nodes for SVG rendering
 * @property {MiniEdge[]} edges                — Cubic bezier paths connecting nodes
 * @property {{width: number, height: number}} viewBox — SVG viewBox dimensions
 * @property {number} scale                    — Scale factor from full DAG to mini-DAG
 *                                               Typically 0.3-0.5 depending on node count
 */

/**
 * @typedef {Object} MiniNode
 * @property {string} id                       — Node ID (matches DagNode.id)
 * @property {string} name                     — Truncated display name (max 12 chars)
 * @property {string} type                     — Node type for shape rendering
 * @property {string} schema                   — Schema for color coding
 * @property {string} schemaAbbrev             — 3-letter abbreviation: "dbo" | "brz" | "slv" | "gld"
 * @property {number} x                        — Scaled x position in mini-DAG
 * @property {number} y                        — Scaled y position in mini-DAG
 * @property {number} width                    — Node width in mini-DAG (typically 80-100px)
 * @property {number} height                   — Node height in mini-DAG (typically 28-32px)
 */

/**
 * @typedef {Object} MiniEdge
 * @property {string} sourceId                 — Source node ID
 * @property {string} targetId                 — Target node ID
 * @property {string} path                     — SVG cubic bezier path data (d attribute)
 *                                               Generated from source/target positions
 *                                               Example: "M 50 20 C 100 20, 100 60, 150 60"
 */
```

### 2.4 Confirmation Summary Model

```javascript
/**
 * @typedef {Object} ConfirmationSummary
 * @property {ResourceCount[]} resources       — What will be created
 * @property {string} confirmationText         — Human-readable summary text
 * @property {boolean} isValid                 — Whether all cross-step validations passed
 */

/**
 * @typedef {Object} ResourceCount
 * @property {string} label                    — Resource type label (e.g., "Lakehouse tables")
 * @property {number} count                    — Number of resources
 * @property {string} [qualifier]              — Optional qualifier (e.g., "across 4 schemas")
 */
```

### 2.5 Template Save Model

```javascript
/**
 * @typedef {Object} TemplateSaveRequest
 * @property {string} name                     — Template name (user-provided)
 * @property {string} [description]            — Optional description
 * @property {Object} infrastructure           — Page 1 selections (sanitized — no workspace-specific IDs)
 * @property {Object} configuration            — Page 2 selections (theme + schemas)
 * @property {Object} dagTopology              — Page 3 topology (nodes + connections)
 * @property {string} createdAt                — ISO 8601 timestamp
 * @property {string} version                  — Template format version (e.g., "1.0")
 */

/**
 * @typedef {Object} TemplateSaveResponse
 * @property {string} templateId               — Server-assigned template ID
 * @property {string} name                     — Confirmed template name
 * @property {string} savedAt                  — ISO 8601 timestamp
 * @property {boolean} success                 — Whether save succeeded
 * @property {string} [error]                  — Error message if save failed
 */
```

### 2.6 Validation Model

```javascript
/**
 * @typedef {Object} ValidationResult
 * @property {boolean} isValid                 — Overall validation status
 * @property {ValidationError[]} errors        — Blocking errors (prevent creation)
 * @property {ValidationWarning[]} warnings    — Non-blocking warnings (allow creation with caution)
 */

/**
 * @typedef {Object} ValidationError
 * @property {string} code                     — Error code (e.g., "SCHEMA_MISMATCH")
 * @property {string} message                  — Human-readable error description
 * @property {string} section                  — Which review section the error relates to
 * @property {number} sourcePageIndex          — Which wizard page to navigate to for fixing
 * @property {string} [field]                  — Specific field causing the error
 */

/**
 * @typedef {Object} ValidationWarning
 * @property {string} code                     — Warning code (e.g., "HIGH_NODE_COUNT")
 * @property {string} message                  — Human-readable warning description
 * @property {string} section                  — Which review section the warning relates to
 */
```

---

## 3. API Surface

### 3.1 Constructor

```javascript
/**
 * C09-ReviewSummary
 * 
 * Review and confirmation component for the New Infrastructure Wizard.
 * Renders a two-column summary of all wizard selections with mini-DAG
 * visualization and cross-step validation.
 * 
 * @param {HTMLElement} container — Parent element to mount into
 * @param {Object} options — Configuration options
 * @param {Object} options.wizardState — Complete wizard state from C12-WizardShell
 * @param {Function} options.onNavigateToPage — Callback to navigate to a specific wizard page
 * @param {Function} options.onConfirm — Callback when user confirms creation
 * @param {Function} options.onTemplateSave — Callback when user saves as template
 * @param {EventBus} options.eventBus — Shared event bus instance
 */
constructor(container, options)
```

### 3.2 Public Methods

#### 3.2.1 Lifecycle Methods

```javascript
/**
 * Initialize the component. Builds the review model from wizard state,
 * runs cross-step validation, renders the two-column layout, and
 * generates the mini-DAG SVG.
 * 
 * Called by C12-WizardShell when navigating to Page 4.
 * 
 * @returns {void}
 * @fires review:mounted
 * @fires review:validation-complete
 */
mount()

/**
 * Tear down the component. Removes event listeners, clears the DOM,
 * and releases the mini-DAG SVG reference.
 * 
 * Called by C12-WizardShell when navigating away from Page 4.
 * 
 * @returns {void}
 * @fires review:unmounted
 */
unmount()

/**
 * Re-render the component with fresh wizard state. Called when the user
 * navigates back from an Edit action and returns to Page 4 with
 * potentially modified state.
 * 
 * @param {Object} wizardState — Updated wizard state
 * @returns {void}
 * @fires review:refreshed
 * @fires review:validation-complete
 */
refresh(wizardState)
```

#### 3.2.2 Query Methods

```javascript
/**
 * Get the current validation result. Returns the most recent
 * cross-step validation including errors and warnings.
 * 
 * @returns {ValidationResult} — Current validation state
 */
getValidationResult()

/**
 * Get the current review model. Returns the structured review data
 * used for rendering. Useful for template save serialization.
 * 
 * @returns {ReviewModel} — Current review model
 */
getReviewModel()

/**
 * Check whether the component is in a valid state for creation.
 * Returns true only if validation passed and no blocking errors exist.
 * 
 * @returns {boolean} — Whether creation can proceed
 */
isReadyForCreation()

/**
 * Get the resource creation manifest. Returns the structured data
 * that will be sent to POST /api/environments.
 * 
 * @returns {EnvironmentCreateRequest} — Creation payload
 */
getCreationManifest()
```

#### 3.2.3 Action Methods

```javascript
/**
 * Programmatically trigger the Edit action for a specific section.
 * Navigates back to the source wizard page for that section.
 * 
 * @param {string} sectionId — "infrastructure" | "configuration" | "dag"
 * @returns {void}
 * @fires review:edit-navigate
 */
navigateToEdit(sectionId)

/**
 * Open the template save dialog. Displays a modal or inline form
 * for the user to name and optionally describe the template.
 * 
 * @returns {void}
 * @fires review:template-dialog-opened
 */
openTemplateSaveDialog()

/**
 * Close the template save dialog without saving.
 * 
 * @returns {void}
 * @fires review:template-dialog-closed
 */
closeTemplateSaveDialog()

/**
 * Execute the template save with the given name and description.
 * 
 * @param {string} name — Template name
 * @param {string} [description] — Optional template description
 * @returns {Promise<TemplateSaveResponse>}
 * @fires review:template-saving
 * @fires review:template-saved
 * @fires review:template-save-failed
 */
async saveAsTemplate(name, description)

/**
 * Force re-run cross-step validation. Normally validation runs
 * automatically on mount/refresh, but this allows manual re-validation
 * after external state changes.
 * 
 * @returns {ValidationResult}
 * @fires review:validation-complete
 */
revalidate()
```

### 3.3 Events

C09 communicates with C12-WizardShell and other components through a shared EventBus. All events are namespaced under `review:`.

#### 3.3.1 Lifecycle Events

| Event | Payload | Description |
|---|---|---|
| `review:mounted` | `{ timestamp: number }` | Component has been initialized and rendered |
| `review:unmounted` | `{ timestamp: number }` | Component has been torn down |
| `review:refreshed` | `{ timestamp: number, changedSections: string[] }` | Component re-rendered after Edit return |

#### 3.3.2 Validation Events

| Event | Payload | Description |
|---|---|---|
| `review:validation-complete` | `{ result: ValidationResult }` | Cross-step validation has finished |
| `review:validation-error-clicked` | `{ error: ValidationError }` | User clicked on a validation error message |

#### 3.3.3 Navigation Events

| Event | Payload | Description |
|---|---|---|
| `review:edit-navigate` | `{ sectionId: string, targetPage: number }` | User clicked Edit link, navigating back |
| `review:section-focused` | `{ sectionId: string }` | A review section received focus |

#### 3.3.4 Confirmation Events

| Event | Payload | Description |
|---|---|---|
| `review:confirmed` | `{ manifest: EnvironmentCreateRequest }` | User confirmed creation (Lock In & Create clicked) |
| `review:confirmation-blocked` | `{ errors: ValidationError[] }` | Creation blocked due to validation errors |

#### 3.3.5 Template Events

| Event | Payload | Description |
|---|---|---|
| `review:template-dialog-opened` | `{ timestamp: number }` | Template save dialog opened |
| `review:template-dialog-closed` | `{ timestamp: number }` | Template save dialog closed without saving |
| `review:template-saving` | `{ name: string }` | Template save request in progress |
| `review:template-saved` | `{ response: TemplateSaveResponse }` | Template saved successfully |
| `review:template-save-failed` | `{ error: string }` | Template save failed |

### 3.4 CSS Custom Properties (Component-Level Overrides)

C09 inherits design tokens from the root `:root` scope but exposes the following component-level custom properties for theming and layout control:

```css
.review-summary {
  /* Layout */
  --review-grid-gap: var(--sp-6);          /* 24px — gap between columns */
  --review-section-gap: var(--sp-4);       /* 16px — gap between sections */
  --review-row-height: var(--sp-8);        /* 32px — minimum row height */
  
  /* Mini-DAG */
  --mini-dag-height: 280px;               /* Fixed height for mini-DAG container */
  --mini-dag-bg: var(--surface-2);         /* Background color */
  --mini-dag-grid-size: 16px;             /* Dot grid spacing */
  --mini-dag-grid-color: var(--border-subtle); /* Dot grid color */
  --mini-dag-node-font: 9px var(--font-mono); /* Node label font */
  --mini-dag-badge-font: 7px var(--font-mono); /* Badge label font */
  
  /* Confirmation */
  --confirm-bg: var(--accent-dim);         /* Confirmation box background */
  --confirm-border: var(--accent);         /* Confirmation box border */
  
  /* Animation */
  --review-fade-duration: 400ms;           /* Section fade-in duration */
  --review-fade-delay: 100ms;             /* Stagger delay per section */
  --mini-dag-scale-duration: 500ms;        /* Mini-DAG scale-in duration */
  --mini-dag-scale-delay: 200ms;          /* Mini-DAG entrance delay */
  --pulse-duration: 2s;                    /* Create button pulse cycle */
}
```

### 3.5 DOM Structure Contract

The following DOM structure is guaranteed and can be relied upon by external CSS and integration tests:

```html
<div class="review-summary" data-component="C09" role="region" aria-label="Review and confirm">
  <div class="review-grid">
    <!-- Left Column -->
    <div class="review-left-column">
      <!-- Infrastructure Section -->
      <section class="review-section" data-section="infrastructure" aria-labelledby="review-infra-title">
        <div class="review-section-header">
          <h3 class="review-section-title" id="review-infra-title">Infrastructure</h3>
          <button class="review-edit-link" data-target-page="0" aria-label="Edit infrastructure settings">
            Edit
          </button>
        </div>
        <div class="review-rows" role="list">
          <div class="review-row" role="listitem">
            <span class="review-label">Workspace</span>
            <span class="review-value">brave_turing_42</span>
          </div>
          <div class="review-row" role="listitem">
            <span class="review-label">Capacity</span>
            <span class="review-value">F4 — East US</span>
          </div>
          <div class="review-row" role="listitem">
            <span class="review-label">Lakehouse</span>
            <span class="review-value">
              lh_production
              <span class="review-chip review-chip--status" aria-label="Schema support enabled">schema ✓</span>
            </span>
          </div>
          <div class="review-row" role="listitem">
            <span class="review-label">Notebook</span>
            <span class="review-value">nb_etl_pipeline</span>
          </div>
        </div>
      </section>

      <!-- Configuration Section -->
      <section class="review-section" data-section="configuration" aria-labelledby="review-config-title">
        <div class="review-section-header">
          <h3 class="review-section-title" id="review-config-title">Configuration</h3>
          <button class="review-edit-link" data-target-page="1" aria-label="Edit configuration settings">
            Edit
          </button>
        </div>
        <div class="review-rows" role="list">
          <div class="review-row" role="listitem">
            <span class="review-label">Theme</span>
            <span class="review-value review-value--accent">◆ Medallion Architecture</span>
          </div>
          <div class="review-row" role="listitem">
            <span class="review-label">Schemas</span>
            <span class="review-value">
              <span class="review-chip review-chip--schema">dbo</span>
              <span class="review-chip review-chip--schema">Bronze</span>
              <span class="review-chip review-chip--schema">Silver</span>
              <span class="review-chip review-chip--schema">Gold</span>
            </span>
          </div>
          <div class="review-row" role="listitem">
            <span class="review-label">Nodes</span>
            <span class="review-value">
              <span class="review-count">3</span> source ·
              <span class="review-count">4</span> transform ·
              <span class="review-count">2</span> sink
            </span>
          </div>
        </div>
      </section>

      <!-- Confirmation Box -->
      <div class="review-confirm" role="alert" aria-live="polite">
        <p class="review-confirm-text">
          This will create <span class="count">1</span> lakehouse,
          <span class="count">1</span> notebook, and
          <span class="count">9</span> tables across
          <span class="count">4</span> schemas.
        </p>
      </div>

      <!-- Template Save Button -->
      <button class="btn btn-accent-outline review-save-template"
              aria-label="Save current configuration as a reusable template">
        Save as Template
      </button>
    </div>

    <!-- Right Column -->
    <div class="review-right-column">
      <section class="review-section review-section--dag" data-section="dag" aria-labelledby="review-dag-title">
        <div class="review-section-header">
          <h3 class="review-section-title" id="review-dag-title">DAG Topology</h3>
          <button class="review-edit-link" data-target-page="2" aria-label="Edit DAG topology">
            Edit
          </button>
        </div>
        <div class="review-mini-dag" role="img" aria-label="DAG topology visualization showing 9 nodes and their connections">
          <svg class="mini-dag-svg" viewBox="0 0 400 280">
            <!-- Generated edges (cubic bezier paths) -->
            <!-- Generated nodes (rect + text + badge) -->
          </svg>
        </div>
      </section>
    </div>
  </div>

  <!-- Validation Errors (conditional) -->
  <div class="review-validation-errors" role="alert" aria-live="assertive" hidden>
    <!-- Rendered only when validation fails -->
  </div>
</div>
```

---

## 4. State Machine

### 4.1 Component States

C09-ReviewSummary operates as a finite state machine with the following states:

```
                    ┌──────────────┐
                    │   UNMOUNTED  │
                    └──────┬───────┘
                           │ mount()
                           ▼
                    ┌──────────────┐
              ┌─────│  VALIDATING  │─────┐
              │     └──────┬───────┘     │
              │            │             │
         errors found   all clear    warnings only
              │            │             │
              ▼            ▼             ▼
     ┌────────────┐  ┌──────────┐  ┌───────────┐
     │   INVALID  │  │   READY  │  │  WARNING   │
     └─────┬──────┘  └────┬─────┘  └─────┬─────┘
           │               │              │
           │    "Lock In & Create" click  │
           │               │              │
           │               ▼              │
           │        ┌──────────────┐      │
           │        │  CONFIRMING  │◄─────┘
           │        └──────┬───────┘
           │               │
           │          confirm()
           │               │
           │               ▼
           │        ┌──────────────┐
           │        │  CONFIRMED   │
           │        └──────────────┘
           │
           │  Edit link click (any state except CONFIRMED)
           ▼
    ┌──────────────┐
    │  EDITING     │ (navigated away — component remains mounted but inactive)
    └──────┬───────┘
           │ return from edit (refresh)
           ▼
    ┌──────────────┐
    │  VALIDATING  │ (re-entry — validates fresh state)
    └──────────────┘
```

### 4.2 State Definitions

| State | Description | Create Button | Edit Links | Template Save |
|---|---|---|---|---|
| `UNMOUNTED` | Component not yet initialized | N/A | N/A | N/A |
| `VALIDATING` | Running cross-step validation | Disabled (spinner) | Disabled | Disabled |
| `READY` | All validations passed, ready for creation | Enabled (pulse animation) | Enabled | Enabled |
| `WARNING` | Warnings present but no blocking errors | Enabled (pulse animation) | Enabled | Enabled |
| `INVALID` | Blocking validation errors found | Disabled (dimmed) | Enabled | Disabled |
| `CONFIRMING` | User clicked Create, waiting for confirmation | Loading state | Disabled | Disabled |
| `CONFIRMED` | Creation request dispatched | Hidden | Hidden | Hidden |
| `EDITING` | User navigated to edit a previous page | N/A (not visible) | N/A | N/A |

### 4.3 State Transitions

```javascript
const STATE_TRANSITIONS = {
  UNMOUNTED: {
    mount: 'VALIDATING',
  },
  VALIDATING: {
    validationPassed: 'READY',
    validationWarnings: 'WARNING',
    validationFailed: 'INVALID',
  },
  READY: {
    confirm: 'CONFIRMING',
    editNavigate: 'EDITING',
    refresh: 'VALIDATING',
  },
  WARNING: {
    confirm: 'CONFIRMING',
    editNavigate: 'EDITING',
    refresh: 'VALIDATING',
  },
  INVALID: {
    editNavigate: 'EDITING',
    refresh: 'VALIDATING',
  },
  CONFIRMING: {
    confirmed: 'CONFIRMED',
    confirmFailed: 'READY',  // or WARNING — restore previous valid state
  },
  CONFIRMED: {
    // Terminal state — no transitions out
  },
  EDITING: {
    returnFromEdit: 'VALIDATING',
    unmount: 'UNMOUNTED',
  },
};
```

### 4.4 Template Save Sub-State Machine

The template save flow runs as an independent sub-state machine that does not affect the main component state:

```
┌──────────┐    openDialog()    ┌──────────────┐
│  IDLE    │──────────────────►│  DIALOG_OPEN  │
└──────────┘                    └──────┬───────┘
     ▲                                 │
     │  closeDialog()                  │ save()
     │  or saved()                     ▼
     │                          ┌──────────────┐
     │◄─────────────────────────│   SAVING     │
     │                          └──────┬───────┘
     │                                 │
     │                          success / failure
     │                                 │
     │                                 ▼
     │                          ┌──────────────┐
     └──────────────────────────│ SAVE_RESULT  │
                                └──────────────┘
```

| Template State | Description | Dialog Visible | Save Button |
|---|---|---|---|
| `IDLE` | No template dialog visible | No | N/A |
| `DIALOG_OPEN` | Template name/description form visible | Yes | Enabled |
| `SAVING` | Template save request in flight | Yes | Disabled (spinner) |
| `SAVE_RESULT` | Save succeeded or failed — shows result | Yes (briefly) | Shows result icon |

### 4.5 Footer Button State Coordination

C09 coordinates with C12-WizardShell to transform the wizard footer when Page 4 is active:

```javascript
// On mount — transform footer
wizardShell.setFooterConfig({
  nextButton: {
    label: 'Lock In & Create ▸',
    className: 'btn-create',
    disabled: false,  // updated by validation result
    onClick: () => this.handleConfirm(),
  },
  backButton: {
    label: '← Back',
    visible: true,
  },
});

// On validation complete — update footer
wizardShell.updateFooterButton('next', {
  disabled: !this.isReadyForCreation(),
  title: this.isReadyForCreation() 
    ? 'Create the environment' 
    : 'Fix validation errors before creating',
});
```

---

## 5. Scenarios

### 5.1 Primary Flow — Happy Path

**Scenario: User reviews and confirms a standard Medallion Architecture environment**

1. User completes Pages 1-3 of the wizard with valid selections
2. User clicks "Next" on Page 3 (DAG topology)
3. C12-WizardShell navigates to Page 4, mounts C09-ReviewSummary
4. C09 receives complete wizard state from C12-WizardShell
5. C09 transforms wizard state into ReviewModel
6. C09 runs cross-step validation — all checks pass
7. C09 renders two-column layout:
   - Left: Infrastructure section (4 rows) + Configuration section (3 rows) + Confirmation box + Template save button
   - Right: DAG Topology section with mini-DAG SVG
8. C09 fires `review:validation-complete` with `{ result: { isValid: true } }`
9. C09 requests footer transformation: "Next →" becomes "Lock In & Create ▸" with `btn-create` class and `pulseAccent` animation
10. Sections fade in sequentially (100ms stagger) via `fadeIn 400ms ease`
11. Mini-DAG scales in with `scaleIn 500ms ease 200ms`
12. User reviews all sections, sees confirmation text: "This will create 1 lakehouse, 1 notebook, and 9 tables across 4 schemas."
13. User clicks "Lock In & Create ▸"
14. C09 transitions to CONFIRMING state
15. C09 fires `review:confirmed` with the creation manifest
16. C12-WizardShell dispatches `POST /api/environments`

**Expected Duration:** Under 300ms from page transition to fully rendered review

### 5.2 Edit Flow — Navigate Back and Return

**Scenario: User notices incorrect capacity and edits Page 1**

1. User is on Page 4 reviewing their selections
2. User sees "Capacity: F4 — East US" but needs F8
3. User clicks "Edit" link on the Infrastructure section header
4. C09 fires `review:edit-navigate` with `{ sectionId: "infrastructure", targetPage: 0 }`
5. C12-WizardShell navigates back to Page 1 (C01-WorkspacePicker)
6. C09 transitions to EDITING state (component remains mounted but hidden)
7. User changes capacity from F4 to F8 on Page 1
8. User navigates forward through Pages 2 and 3 (no changes needed)
9. User arrives back at Page 4
10. C12-WizardShell calls `C09.refresh(updatedWizardState)`
11. C09 transitions from EDITING to VALIDATING
12. C09 re-builds ReviewModel with new capacity
13. C09 re-runs cross-step validation
14. C09 re-renders — Infrastructure section now shows "F8 — East US"
15. C09 fires `review:refreshed` with `{ changedSections: ["infrastructure"] }`

**Key Behavior:** Only the changed section should visually highlight (subtle flash animation) to draw attention to the modification.

### 5.3 Edit Flow — DAG Topology Edit

**Scenario: User wants to add a node to the DAG**

1. User is on Page 4, reviews the mini-DAG visualization
2. User notices a missing transform node
3. User clicks "Edit" on the DAG Topology section
4. C09 fires `review:edit-navigate` with `{ sectionId: "dag", targetPage: 2 }`
5. C12-WizardShell navigates to Page 3 (C07-DagCanvas)
6. User adds the missing transform node and connections
7. User navigates to Page 4
8. C09 refreshes with updated DAG topology
9. Mini-DAG re-renders with the new node
10. Node count in Configuration section updates (e.g., "4 transform" → "5 transform")
11. Confirmation text updates (e.g., "9 tables" → "10 tables")

### 5.4 Validation Failure — Schema Mismatch

**Scenario: Nodes reference schemas that were deselected on Page 2**

1. User originally selected all 4 schemas (dbo, bronze, silver, gold) on Page 2
2. User built DAG nodes assigned to all 4 schemas on Page 3
3. User navigated back to Page 2 and deselected "gold" schema
4. User returned to Page 4
5. C09 runs cross-step validation
6. Validation finds: 2 nodes are assigned to "gold" schema which is no longer selected
7. C09 transitions to INVALID state
8. Validation error banner appears at bottom of review:
   ```
   ⚠ 2 nodes reference the "gold" schema which is not selected.
     Navigate to Configuration to fix. [Edit Configuration]
   ```
9. "Lock In & Create ▸" button is disabled (dimmed, no pulse animation)
10. Error message includes clickable "Edit Configuration" link → navigates to Page 2
11. After fixing schemas and returning, validation re-runs and passes

### 5.5 Validation Warning — High Node Count

**Scenario: DAG has more than 50 nodes**

1. User built a large DAG with 65 nodes on Page 3
2. On Page 4, cross-step validation runs
3. Validation produces warning: "Large DAG (65 nodes) may impact performance. Consider splitting into multiple environments."
4. C09 transitions to WARNING state
5. Warning banner appears (yellow/amber, non-blocking):
   ```
   ⚡ Large DAG (65 nodes) may impact performance.
     Consider splitting into multiple environments.
   ```
6. "Lock In & Create ▸" button remains enabled (pulse animation active)
7. User can proceed with creation despite the warning

### 5.6 Template Save — Success

**Scenario: User saves configuration as template before creating**

1. User is on Page 4 in READY state
2. User clicks "Save as Template" button
3. Template save dialog opens (modal overlay or inline expansion)
4. Dialog shows:
   - Text input: "Template Name" (required, max 64 chars)
   - Text area: "Description" (optional, max 256 chars)
   - "Save Template" button + "Cancel" button
5. User enters: Name = "Standard Medallion ETL", Description = "4-schema medallion with 9 tables"
6. User clicks "Save Template"
7. C09 fires `review:template-saving` with `{ name: "Standard Medallion ETL" }`
8. C09 sends template save request via `options.onTemplateSave(templateData)`
9. Save succeeds — C09 fires `review:template-saved` with response
10. Dialog briefly shows success state (checkmark icon + "Template saved")
11. Dialog auto-closes after 1500ms
12. "Save as Template" button text changes to "Saved ✓" for 3 seconds, then reverts

### 5.7 Template Save — Failure

**Scenario: Template save fails due to network error**

1. User fills in template name and clicks "Save Template"
2. Network request fails (timeout, server error, duplicate name)
3. C09 fires `review:template-save-failed` with error details
4. Dialog shows error state:
   - Error message: "Failed to save template: [error description]"
   - "Retry" button + "Cancel" button
5. User can retry or cancel — creation flow is not affected

### 5.8 Empty DAG — Minimal Configuration

**Scenario: User skipped Page 3 (no nodes added)**

1. User completed Pages 1-2 but did not add any nodes on Page 3
2. On Page 4, C09 receives DAG topology with 0 nodes and 0 connections
3. C09 renders:
   - Infrastructure section: normal (4 rows)
   - Configuration section: Theme + Schemas shown, Nodes row shows "0 nodes"
   - DAG Topology section: Mini-DAG area shows empty state:
     ```
     No nodes defined.
     The DAG topology is empty. [Edit DAG]
     ```
   - Confirmation text: "This will create 1 lakehouse and 1 notebook with no tables."
4. Validation may produce a warning: "No nodes in DAG topology. Environment will be created without tables."
5. Creation is still allowed (warning state, not invalid)

### 5.9 Keyboard-Only Flow

**Scenario: User navigates and confirms using only keyboard**

1. Page 4 loads — focus moves to first focusable element (Infrastructure "Edit" link)
2. User presses Tab to cycle through:
   - Infrastructure "Edit" link
   - Configuration "Edit" link
   - Confirmation box (read-only, aria-live)
   - "Save as Template" button
   - DAG Topology "Edit" link
3. User presses Ctrl+Enter at any point → triggers "Lock In & Create"
4. If user presses Enter on an "Edit" link → navigates to that page
5. If user presses Escape → wizard close confirmation dialog
6. If user presses Alt+← → navigates to Page 3 (Back)

### 5.10 Screen Reader Flow

**Scenario: VoiceOver/NVDA user reviews the summary**

1. Screen reader announces: "Review and confirm, region"
2. User navigates by heading: "Infrastructure, heading level 3"
3. Screen reader reads list items:
   - "Workspace, brave_turing_42"
   - "Capacity, F4, East US"
   - "Lakehouse, lh_production, Schema support enabled"
   - "Notebook, nb_etl_pipeline"
4. User reaches "Edit, button, Edit infrastructure settings"
5. User navigates to Configuration section, similar pattern
6. User reaches confirmation: "alert, This will create 1 lakehouse, 1 notebook, and 9 tables across 4 schemas"
7. User reaches DAG Topology — screen reader announces: "DAG topology visualization showing 9 nodes and their connections, image"
8. The mini-DAG SVG has `role="img"` with a descriptive `aria-label` — it is not traversable
9. User reaches "Lock In & Create" button (if enabled)

### 5.11 Rapid Page Switching

**Scenario: User quickly navigates between pages 3 and 4**

1. User is on Page 3, clicks Next → Page 4 mounts
2. User immediately clicks Back → Page 4 unmounts before validation completes
3. C09 must handle unmount during VALIDATING state gracefully
4. No pending operations should leak (cancel any in-flight validation)
5. User clicks Next again → Page 4 mounts fresh
6. New validation run starts from scratch

### 5.12 Large DAG — Performance Scenario

**Scenario: DAG with 100+ nodes**

1. User created a DAG with 120 nodes and 180 connections on Page 3
2. On Page 4, C09 must render the mini-DAG within 200ms budget
3. Mini-DAG layout algorithm applies scaling:
   - Original canvas: e.g., 2400x1600px
   - Mini-DAG container: 400x280px
   - Scale factor: ~0.17
4. Node labels are truncated to fit mini scale
5. Edge paths are simplified (reduce control point complexity)
6. If node count exceeds 200, mini-DAG shows a simplified cluster view instead of individual nodes
7. Confirmation text dynamically counts: "This will create 1 lakehouse, 1 notebook, and 120 tables across 4 schemas."

---

## 6. Visual Spec

### 6.1 Layout

The review page uses a two-column CSS Grid layout as defined in the CEO-approved mock:

```css
.review-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;     /* 50/50 split — CEO-approved */
  gap: var(--sp-6);                    /* 24px */
  padding: var(--sp-4);                /* 16px */
  align-items: start;                  /* Columns align to top */
}
```

**Responsive Behavior:**

```css
/* Tablet breakpoint — stack columns */
@media (max-width: 768px) {
  .review-grid {
    grid-template-columns: 1fr;
    gap: var(--sp-4);
  }
  
  .review-mini-dag {
    --mini-dag-height: 200px;  /* Reduced height on mobile */
  }
}
```

**Column Layout:**

| Column | Content | Notes |
|---|---|---|
| Left (`review-left-column`) | Infrastructure section, Configuration section, Confirmation box, Template save button | Stacked vertically with `var(--sp-4)` gap |
| Right (`review-right-column`) | DAG Topology section with mini-DAG | Full height, sticky top if scrollable |

### 6.2 Review Sections

Each review section follows a consistent card-like pattern:

```css
.review-section {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);      /* 8px */
  padding: var(--sp-4);                  /* 16px */
  animation: fadeIn 400ms ease var(--_stagger-delay, 0ms) both;
}

/* Stagger delays — set via inline style or nth-child */
.review-section:nth-child(1) { --_stagger-delay: 100ms; }
.review-section:nth-child(2) { --_stagger-delay: 200ms; }
```

**Section Header:**

```css
.review-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--sp-3);            /* 12px */
  padding-bottom: var(--sp-2);           /* 8px */
  border-bottom: 1px solid var(--border-subtle);
}

.review-section-title {
  font-size: var(--text-sm);             /* 13px */
  font-weight: 600;
  color: var(--text-1);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0;
}

.review-edit-link {
  font-size: var(--text-xs);             /* 11px */
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--radius-sm);
  transition: background-color 150ms ease;
}

.review-edit-link:hover {
  background: var(--accent-dim);
  text-decoration: none;
}

.review-edit-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

### 6.3 Review Rows

```css
.review-rows {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);                      /* 8px */
}

.review-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: var(--sp-8);              /* 32px */
  padding: var(--sp-1) 0;
}

.review-label {
  font-size: var(--text-sm);             /* 13px */
  color: var(--text-2);                  /* Muted label color */
  flex-shrink: 0;
  min-width: 100px;
}

.review-value {
  font-size: var(--text-sm);             /* 13px */
  color: var(--text-1);                  /* Primary text color */
  font-family: var(--font-mono);
  text-align: right;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.review-value--accent {
  color: var(--accent);                  /* Theme name gets accent color */
  font-weight: 500;
}
```

### 6.4 Chips and Badges

```css
.review-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-full);     /* Pill shape */
  font-size: var(--text-xs);             /* 11px */
  font-family: var(--font-mono);
  line-height: 1.2;
}

.review-chip--schema {
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border-subtle);
}

.review-chip--status {
  background: oklch(0.45 0.15 145 / 0.15);  /* Green-tinted */
  color: oklch(0.45 0.15 145);               /* Green text */
  font-size: 10px;
}

.review-count {
  font-weight: 700;
  color: var(--text-1);
  font-family: var(--font-mono);
}
```

### 6.5 Confirmation Box

```css
.review-confirm {
  background: var(--accent-dim);           /* Accent-tinted background */
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  padding: var(--sp-3) var(--sp-4);
  margin-top: var(--sp-3);
}

.review-confirm-text {
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.6;
  margin: 0;
}

.review-confirm .count {
  font-weight: 700;
  color: var(--accent);
  font-family: var(--font-mono);
}
```

### 6.6 Mini-DAG Visualization

```css
.review-mini-dag {
  height: var(--mini-dag-height, 280px);
  background: var(--surface-2);
  border-radius: var(--radius-md);
  overflow: hidden;
  position: relative;
  
  /* Dot grid background pattern */
  background-image: radial-gradient(
    circle at center,
    var(--border-subtle) 1px,
    transparent 1px
  );
  background-size: 16px 16px;
  
  animation: scaleIn 500ms ease 200ms both;
}

.mini-dag-svg {
  width: 100%;
  height: 100%;
}

/* Mini-DAG edge paths */
.mini-edge {
  fill: none;
  stroke: var(--border);
  stroke-width: 1.5;
  stroke-linecap: round;
}

/* Mini-DAG nodes */
.mini-node {
  cursor: default;
}

.mini-node-rect {
  fill: var(--surface-1);
  stroke: var(--border);
  stroke-width: 1;
  rx: 4;
  ry: 4;
}

.mini-node-label {
  font: var(--mini-dag-node-font, 9px var(--font-mono));
  fill: var(--text-1);
  text-anchor: middle;
  dominant-baseline: central;
}

/* Schema-colored badges */
.mini-badge {
  font: var(--mini-dag-badge-font, 7px var(--font-mono));
  text-transform: uppercase;
  border-radius: var(--radius-full);
}

.mini-badge--dbo {
  fill: var(--text-2);
}

.mini-badge--bronze {
  fill: oklch(0.65 0.15 55);              /* Warm bronze */
}

.mini-badge--silver {
  fill: oklch(0.70 0.02 240);             /* Cool silver */
}

.mini-badge--gold {
  fill: oklch(0.75 0.15 85);              /* Rich gold */
}
```

### 6.7 "Lock In & Create" Button

The wizard footer's "Next" button transforms when Page 4 is active:

```css
.btn-create {
  background: var(--accent);
  color: white;
  font-weight: 700;
  font-size: var(--text-sm);
  padding: var(--sp-2) var(--sp-5);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  box-shadow: var(--shadow-md);
  animation: pulseAccent 2s ease-in-out infinite;
  transition: transform 150ms ease, box-shadow 150ms ease;
}

.btn-create:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-lg);
}

.btn-create:active {
  transform: translateY(0);
  box-shadow: var(--shadow-sm);
}

.btn-create:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  animation: none;
  transform: none;
}

@keyframes pulseAccent {
  0%, 100% {
    box-shadow: 0 0 0 0 var(--accent-glow);
  }
  50% {
    box-shadow: 0 0 0 6px transparent;
  }
}
```

### 6.8 "Save as Template" Button

```css
.review-save-template {
  margin-top: var(--sp-3);
  width: 100%;
}

.btn-accent-outline {
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  padding: var(--sp-2) var(--sp-4);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease;
}

.btn-accent-outline:hover {
  background: var(--accent-dim);
}

.btn-accent-outline:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.btn-accent-outline:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

### 6.9 Animations

#### 6.9.1 Section Entrance — fadeIn

```css
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

Applied to `.review-section` elements with staggered delays:
- Section 1 (Infrastructure): 100ms delay
- Section 2 (Configuration): 200ms delay
- Section 3 (DAG Topology): 300ms delay

#### 6.9.2 Mini-DAG Entrance — scaleIn

```css
@keyframes scaleIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
```

Applied to `.review-mini-dag` with 200ms delay.

#### 6.9.3 Create Button Pulse — pulseAccent

```css
@keyframes pulseAccent {
  0%, 100% {
    box-shadow: 0 0 0 0 var(--accent-glow);
  }
  50% {
    box-shadow: 0 0 0 6px transparent;
  }
}
```

Applied to `.btn-create` with `2s ease-in-out infinite`.

#### 6.9.4 Section Change Highlight

When a section's data changes after an Edit return:

```css
@keyframes sectionHighlight {
  0% {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-dim);
  }
  100% {
    border-color: var(--border);
    box-shadow: none;
  }
}

.review-section--changed {
  animation: sectionHighlight 1500ms ease-out;
}
```

#### 6.9.5 Prefers-Reduced-Motion

```css
@media (prefers-reduced-motion: reduce) {
  .review-section,
  .review-mini-dag,
  .btn-create,
  .review-section--changed {
    animation: none !important;
    transition: none !important;
  }
}
```

### 6.10 Validation Error Banner

```css
.review-validation-errors {
  margin-top: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  background: oklch(0.35 0.15 25 / 0.1);   /* Red-tinted bg */
  border: 1px solid oklch(0.55 0.2 25);     /* Red border */
  border-radius: var(--radius-md);
}

.review-validation-error {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
  font-size: var(--text-sm);
  color: oklch(0.55 0.2 25);               /* Red text */
}

.review-validation-error + .review-validation-error {
  border-top: 1px solid oklch(0.55 0.2 25 / 0.2);
}

.review-validation-error-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.review-validation-error-fix {
  color: var(--accent);
  cursor: pointer;
  background: none;
  border: none;
  font-size: var(--text-xs);
  padding: var(--sp-1);
  text-decoration: underline;
}
```

### 6.11 Validation Warning Banner

```css
.review-validation-warnings {
  margin-top: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  background: oklch(0.50 0.15 85 / 0.1);   /* Amber-tinted bg */
  border: 1px solid oklch(0.65 0.15 85);    /* Amber border */
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: oklch(0.65 0.15 85);               /* Amber text */
}
```

### 6.12 Template Save Dialog

```css
.review-template-dialog {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: oklch(0 0 0 / 0.5);          /* Backdrop */
  z-index: var(--z-modal);
  animation: fadeIn 200ms ease;
}

.review-template-dialog-content {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-5);
  width: min(420px, 90vw);
  box-shadow: var(--shadow-xl);
}

.review-template-dialog-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 var(--sp-4);
}

.review-template-input {
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-1);
  font-size: var(--text-sm);
  font-family: var(--font-mono);
  margin-bottom: var(--sp-3);
}

.review-template-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

.review-template-textarea {
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-0);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-1);
  font-size: var(--text-sm);
  min-height: 80px;
  resize: vertical;
  margin-bottom: var(--sp-4);
}

.review-template-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
```

### 6.13 Typography Summary

| Element | Font | Size | Weight | Color | Family |
|---|---|---|---|---|---|
| Section title | System | `var(--text-sm)` (13px) | 600 | `var(--text-1)` | Sans-serif |
| Row label | System | `var(--text-sm)` (13px) | 400 | `var(--text-2)` | Sans-serif |
| Row value | Mono | `var(--text-sm)` (13px) | 400 | `var(--text-1)` | `var(--font-mono)` |
| Chip text | Mono | `var(--text-xs)` (11px) | 400 | varies | `var(--font-mono)` |
| Confirm text | System | `var(--text-sm)` (13px) | 400 | `var(--text-1)` | Sans-serif |
| Confirm count | Mono | `var(--text-sm)` (13px) | 700 | `var(--accent)` | `var(--font-mono)` |
| Mini-DAG node | Mono | 9px | 400 | `var(--text-1)` | `var(--font-mono)` |
| Mini-DAG badge | Mono | 7px | 400 | varies by schema | `var(--font-mono)` |
| Edit link | System | `var(--text-xs)` (11px) | 400 | `var(--accent)` | Sans-serif |
| Create button | System | `var(--text-sm)` (13px) | 700 | white | Sans-serif |
| Template button | System | `var(--text-sm)` (13px) | 500 | `var(--accent)` | Sans-serif |

### 6.14 Spacing Grid

All spacing follows the 4px grid system (`--sp-1` = 4px):

| Token | Value | Usage |
|---|---|---|
| `--sp-1` | 4px | Row vertical padding, chip internal padding |
| `--sp-2` | 8px | Row gap, edit link padding, chip horizontal padding, button padding |
| `--sp-3` | 12px | Section header bottom margin, confirm margin, warning padding |
| `--sp-4` | 16px | Grid padding, section padding, section gap, confirm padding, dialog content margin |
| `--sp-5` | 20px | Button horizontal padding, dialog padding |
| `--sp-6` | 24px | Grid column gap |
| `--sp-8` | 32px | Row minimum height |

### 6.15 Color Palette (OKLCH)

All colors use OKLCH as required by EDOG Studio design system:

| Token | Value | Usage |
|---|---|---|
| `--surface-0` | `oklch(0.15 0.01 250)` | Input backgrounds |
| `--surface-1` | `oklch(0.20 0.01 250)` | Section backgrounds |
| `--surface-2` | `oklch(0.25 0.01 250)` | Mini-DAG background |
| `--text-1` | `oklch(0.90 0.01 250)` | Primary text |
| `--text-2` | `oklch(0.60 0.01 250)` | Label text (muted) |
| `--accent` | `oklch(0.70 0.18 250)` | Theme value, edit links, chips |
| `--accent-dim` | `oklch(0.70 0.18 250 / 0.1)` | Confirm bg, hover states |
| `--accent-glow` | `oklch(0.70 0.18 250 / 0.4)` | Pulse animation |
| `--border` | `oklch(0.35 0.01 250)` | Section borders, node strokes |
| `--border-subtle` | `oklch(0.28 0.01 250)` | Dot grid, header separator |

---

## 7. Keyboard & Accessibility

### 7.1 Focus Management

#### 7.1.1 Initial Focus on Mount

When Page 4 becomes active, focus is managed as follows:

1. C12-WizardShell transitions to Page 4
2. C09 mounts and renders
3. After render completes (next animation frame), focus moves to the first section heading:
   ```javascript
   requestAnimationFrame(() => {
     const firstTitle = this.container.querySelector('.review-section-title');
     if (firstTitle) {
       firstTitle.setAttribute('tabindex', '-1');
       firstTitle.focus({ preventScroll: true });
     }
   });
   ```
4. This ensures screen readers announce the page context before the user starts tabbing

#### 7.1.2 Tab Order

The tab order follows visual layout (left-to-right, top-to-bottom):

```
1.  Infrastructure section "Edit" button
2.  Configuration section "Edit" button
3.  "Save as Template" button
4.  DAG Topology section "Edit" button
5.  (Footer) "← Back" button (managed by C12-WizardShell)
6.  (Footer) "Lock In & Create ▸" button (managed by C12-WizardShell)
```

**Notes:**
- Review rows are **not** focusable — they are read-only display elements
- The confirmation box uses `aria-live="polite"` and is not in the tab order
- The mini-DAG SVG is **not** focusable — it uses `role="img"` with a descriptive label
- Validation error fix links are focusable when validation errors are displayed

#### 7.1.3 Focus Restoration After Edit

When the user navigates away via an "Edit" link and returns:

1. C09 tracks which section initiated the Edit via `this._lastEditSection`
2. On return (refresh), focus moves to the Edit button of the section that was edited:
   ```javascript
   const editBtn = this.container.querySelector(
     `.review-section[data-section="${this._lastEditSection}"] .review-edit-link`
   );
   if (editBtn) editBtn.focus();
   ```
3. The edited section receives the `review-section--changed` animation to visually confirm the update

#### 7.1.4 Focus Trapping in Template Dialog

When the template save dialog is open:

1. Focus trap is activated — Tab cycles only within the dialog
2. Focus order within dialog:
   ```
   1. Template name input (auto-focused on open)
   2. Description textarea
   3. "Cancel" button
   4. "Save Template" button
   ```
3. Escape key closes the dialog and returns focus to "Save as Template" button
4. On dialog close, focus trap is released

### 7.2 Keyboard Shortcuts

| Key | Context | Action |
|---|---|---|
| `Tab` | Any | Move focus to next focusable element |
| `Shift+Tab` | Any | Move focus to previous focusable element |
| `Enter` | Edit button focused | Navigate to source page for editing |
| `Enter` | "Save as Template" focused | Open template save dialog |
| `Ctrl+Enter` | Page 4 active (any focus) | Trigger "Lock In & Create" (if enabled) |
| `Escape` | Template dialog open | Close template dialog |
| `Escape` | Page 4 (no dialog) | Trigger wizard close confirmation |
| `Alt+←` | Page 4 active | Navigate to Page 3 (Back) |
| `Alt+→` | Not applicable on Page 4 | No action (Page 4 is the last page) |

#### 7.2.1 Ctrl+Enter Handling

The `Ctrl+Enter` shortcut is a global accelerator for the creation action:

```javascript
handleKeyDown(event) {
  if (event.ctrlKey && event.key === 'Enter') {
    event.preventDefault();
    if (this.isReadyForCreation()) {
      this.handleConfirm();
    } else {
      // Announce to screen reader that creation is blocked
      this._announceToScreenReader(
        'Cannot create environment. Fix validation errors first.'
      );
    }
  }
}
```

### 7.3 ARIA Attributes

#### 7.3.1 Component Root

```html
<div class="review-summary"
     data-component="C09"
     role="region"
     aria-label="Review and confirm environment configuration">
```

#### 7.3.2 Review Sections

```html
<section class="review-section"
         data-section="infrastructure"
         aria-labelledby="review-infra-title">
  <h3 class="review-section-title" id="review-infra-title">Infrastructure</h3>
  <!-- ... -->
</section>
```

Each section uses `aria-labelledby` pointing to its heading `id`.

#### 7.3.3 Review Rows

```html
<div class="review-rows" role="list" aria-label="Infrastructure settings">
  <div class="review-row" role="listitem">
    <span class="review-label" id="review-label-workspace">Workspace</span>
    <span class="review-value" aria-labelledby="review-label-workspace">brave_turing_42</span>
  </div>
</div>
```

Each row uses `role="listitem"` within a `role="list"` container. Values are associated with their labels via `aria-labelledby`.

#### 7.3.4 Edit Buttons

```html
<button class="review-edit-link"
        data-target-page="0"
        aria-label="Edit infrastructure settings — returns to page 1">
  Edit
</button>
```

Edit buttons have descriptive `aria-label` text that explains the navigation target.

#### 7.3.5 Chips

```html
<span class="review-chip review-chip--schema" role="status">Bronze</span>
<span class="review-chip review-chip--status" aria-label="Schema support enabled">schema ✓</span>
```

Status chips use `aria-label` for the full semantic meaning. Schema chips are self-describing.

#### 7.3.6 Confirmation Box

```html
<div class="review-confirm" role="alert" aria-live="polite">
  <p class="review-confirm-text">
    This will create <span class="count" aria-label="1 lakehouse">1</span> lakehouse,
    <span class="count" aria-label="1 notebook">1</span> notebook, and
    <span class="count" aria-label="9 tables">9</span> tables across
    <span class="count" aria-label="4 schemas">4</span> schemas.
  </p>
</div>
```

The confirmation box uses `role="alert"` and `aria-live="polite"` so screen readers announce changes when the content updates (e.g., after Edit return).

#### 7.3.7 Mini-DAG

```html
<div class="review-mini-dag"
     role="img"
     aria-label="DAG topology visualization showing 9 nodes connected in a medallion architecture pattern with bronze, silver, and gold layers">
  <svg class="mini-dag-svg" aria-hidden="true">
    <!-- SVG content is decorative — hidden from screen readers -->
  </svg>
</div>
```

The mini-DAG container uses `role="img"` with a comprehensive `aria-label` that describes the topology. The SVG itself is `aria-hidden="true"` because the individual SVG elements are not meaningful to screen readers.

#### 7.3.8 Validation Errors

```html
<div class="review-validation-errors" role="alert" aria-live="assertive">
  <div class="review-validation-error">
    <span class="review-validation-error-icon" aria-hidden="true">⚠</span>
    <span>2 nodes reference the "gold" schema which is not selected.</span>
    <button class="review-validation-error-fix"
            aria-label="Fix schema mismatch — navigate to configuration page">
      Edit Configuration
    </button>
  </div>
</div>
```

Validation errors use `aria-live="assertive"` so they are announced immediately when they appear.

#### 7.3.9 Create Button State

```html
<!-- Enabled state -->
<button class="btn btn-create"
        aria-label="Lock in configuration and create environment">
  Lock In & Create ▸
</button>

<!-- Disabled state -->
<button class="btn btn-create"
        disabled
        aria-disabled="true"
        aria-label="Cannot create environment — fix validation errors first"
        title="Fix validation errors before creating">
  Lock In & Create ▸
</button>
```

When disabled, both `disabled` attribute and `aria-disabled="true"` are set, with an explanatory label.

### 7.4 Screen Reader Announcements

C09 uses a visually hidden live region for programmatic announcements:

```html
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true"
     id="review-announcements">
  <!-- Programmatic announcements injected here -->
</div>
```

```css
.sr-only {
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

#### Announcements Table

| Trigger | Announcement Text |
|---|---|
| Component mounted | "Review page loaded. Review your infrastructure configuration before creating." |
| Validation passed | "All settings validated successfully. Ready to create environment." |
| Validation failed | "Validation errors found. {N} issues require attention before creating." |
| Validation warning | "Validation complete with {N} warnings. You may proceed with creation." |
| Edit navigation | "Navigating to {section name} settings for editing." |
| Return from edit | "{Section name} updated. Review changes before proceeding." |
| Template saved | "Template '{name}' saved successfully." |
| Template save failed | "Failed to save template. {error}" |
| Ctrl+Enter blocked | "Cannot create environment. Fix {N} validation errors first." |
| Creation confirmed | "Environment creation initiated. Please wait." |

### 7.5 Color Contrast Compliance

All color combinations meet WCAG 2.1 AA contrast requirements (minimum 4.5:1 for normal text, 3:1 for large text):

| Foreground | Background | Ratio | Passes |
|---|---|---|---|
| `--text-1` (L:0.90) | `--surface-1` (L:0.20) | 14.7:1 | AA ✓ |
| `--text-2` (L:0.60) | `--surface-1` (L:0.20) | 6.2:1 | AA ✓ |
| `--accent` (L:0.70) | `--surface-1` (L:0.20) | 9.1:1 | AA ✓ |
| White (L:1.00) | `--accent` (L:0.70) | 4.9:1 | AA ✓ |
| Error red (L:0.55) | Error bg (L:0.35) | 4.6:1 | AA ✓ |
| Warning amber (L:0.65) | Warning bg (L:0.50) | 4.8:1 | AA ✓ |

### 7.6 High Contrast Mode

```css
@media (forced-colors: active) {
  .review-section {
    border: 2px solid ButtonText;
  }
  
  .review-edit-link {
    color: LinkText;
    text-decoration: underline;
  }
  
  .review-chip {
    border: 1px solid ButtonText;
  }
  
  .review-confirm {
    border: 2px solid Highlight;
  }
  
  .btn-create {
    background: ButtonFace;
    color: ButtonText;
    border: 2px solid ButtonText;
  }
  
  .review-validation-errors {
    border: 2px solid Mark;
  }
  
  .mini-node-rect {
    stroke: ButtonText;
    stroke-width: 2;
  }
  
  .mini-edge {
    stroke: ButtonText;
    stroke-width: 2;
  }
}
```

---

## 8. Error Handling

### 8.1 Cross-Step Validation Rules

C09 runs a comprehensive validation sweep when mounting or refreshing. These validations check consistency between data from different wizard pages:

#### 8.1.1 Schema Consistency Check (CRITICAL)

**Rule:** Every schema referenced by a DAG node must exist in the selected schemas list.

```javascript
validateSchemaConsistency(wizardState) {
  const selectedSchemas = new Set(wizardState.configuration.selectedSchemas);
  const errors = [];
  
  for (const node of wizardState.dagTopology.nodes) {
    if (!selectedSchemas.has(node.schema)) {
      errors.push({
        code: 'SCHEMA_MISMATCH',
        message: `Node "${node.name}" references schema "${node.schema}" which is not selected.`,
        section: 'configuration',
        sourcePageIndex: 1,
        field: `nodes.${node.id}.schema`,
      });
    }
  }
  
  return errors;
}
```

**Severity:** BLOCKING — prevents creation  
**Fix action:** Navigate to Page 2 (Configuration) to add missing schemas, or Page 3 (DAG) to reassign nodes

#### 8.1.2 DAG Connectivity Check (WARNING)

**Rule:** All nodes should be reachable from at least one source node. Orphaned nodes are allowed but warned about.

```javascript
validateDagConnectivity(wizardState) {
  const { nodes, connections } = wizardState.dagTopology;
  const warnings = [];
  
  if (nodes.length === 0) {
    warnings.push({
      code: 'EMPTY_DAG',
      message: 'No nodes defined. Environment will be created without tables.',
      section: 'dag',
    });
    return warnings;
  }
  
  const connectedNodeIds = new Set();
  // BFS from source nodes
  const sourceNodes = nodes.filter(n => n.type === 'source');
  const queue = [...sourceNodes.map(n => n.id)];
  
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (connectedNodeIds.has(nodeId)) continue;
    connectedNodeIds.add(nodeId);
    
    for (const conn of connections) {
      if (conn.sourceId === nodeId && !connectedNodeIds.has(conn.targetId)) {
        queue.push(conn.targetId);
      }
    }
  }
  
  const orphanedNodes = nodes.filter(n => !connectedNodeIds.has(n.id));
  if (orphanedNodes.length > 0) {
    warnings.push({
      code: 'ORPHANED_NODES',
      message: `${orphanedNodes.length} node(s) are not connected to any source: ${orphanedNodes.map(n => n.name).join(', ')}`,
      section: 'dag',
    });
  }
  
  return warnings;
}
```

**Severity:** WARNING — allows creation  
**Fix action:** Navigate to Page 3 (DAG) to add connections or remove orphaned nodes

#### 8.1.3 Node Count Check (WARNING)

**Rule:** DAGs with more than 50 nodes generate a performance warning.

```javascript
validateNodeCount(wizardState) {
  const nodeCount = wizardState.dagTopology.nodes.length;
  const warnings = [];
  
  if (nodeCount > 50) {
    warnings.push({
      code: 'HIGH_NODE_COUNT',
      message: `Large DAG (${nodeCount} nodes) may impact performance. Consider splitting into multiple environments.`,
      section: 'dag',
    });
  }
  
  return warnings;
}
```

**Severity:** WARNING — allows creation  
**Threshold:** 50 nodes

#### 8.1.4 Capacity-Region Compatibility Check (CRITICAL)

**Rule:** The selected capacity region must support Fabric Lakehouse with schema features.

```javascript
validateCapacityRegion(wizardState) {
  const errors = [];
  const { capacityRegion, lakehouseHasSchema } = wizardState.infrastructure;
  
  if (lakehouseHasSchema && !SCHEMA_SUPPORTED_REGIONS.includes(capacityRegion)) {
    errors.push({
      code: 'REGION_SCHEMA_UNSUPPORTED',
      message: `Schema support is not available in "${capacityRegion}". Choose a different capacity or disable schema support.`,
      section: 'infrastructure',
      sourcePageIndex: 0,
      field: 'capacityRegion',
    });
  }
  
  return errors;
}
```

**Severity:** BLOCKING — prevents creation

#### 8.1.5 Duplicate Node Name Check (WARNING)

**Rule:** Node names within the same schema should be unique.

```javascript
validateDuplicateNodeNames(wizardState) {
  const warnings = [];
  const namesBySchema = new Map();
  
  for (const node of wizardState.dagTopology.nodes) {
    const key = `${node.schema}:${node.name}`;
    if (namesBySchema.has(key)) {
      warnings.push({
        code: 'DUPLICATE_NODE_NAME',
        message: `Duplicate node name "${node.name}" in schema "${node.schema}".`,
        section: 'dag',
      });
    }
    namesBySchema.set(key, true);
  }
  
  return warnings;
}
```

**Severity:** WARNING — allows creation

#### 8.1.6 Cyclic Dependency Check (CRITICAL)

**Rule:** The DAG must be acyclic. Cycles prevent topological ordering.

```javascript
validateNoCycles(wizardState) {
  const errors = [];
  const { nodes, connections } = wizardState.dagTopology;
  
  // Kahn's algorithm for cycle detection
  const inDegree = new Map(nodes.map(n => [n.id, 0]));
  const adjacency = new Map(nodes.map(n => [n.id, []]));
  
  for (const conn of connections) {
    inDegree.set(conn.targetId, (inDegree.get(conn.targetId) || 0) + 1);
    adjacency.get(conn.sourceId)?.push(conn.targetId);
  }
  
  const queue = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }
  
  let processed = 0;
  while (queue.length > 0) {
    const nodeId = queue.shift();
    processed++;
    for (const neighbor of (adjacency.get(nodeId) || [])) {
      const newDegree = inDegree.get(neighbor) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }
  
  if (processed < nodes.length) {
    errors.push({
      code: 'CYCLIC_DEPENDENCY',
      message: 'DAG contains cycles. Remove circular dependencies between nodes.',
      section: 'dag',
      sourcePageIndex: 2,
    });
  }
  
  return errors;
}
```

**Severity:** BLOCKING — prevents creation

### 8.2 Validation Execution Order

```javascript
runValidation(wizardState) {
  const errors = [];
  const warnings = [];
  
  // Critical checks (blocking)
  errors.push(...this.validateSchemaConsistency(wizardState));
  errors.push(...this.validateCapacityRegion(wizardState));
  errors.push(...this.validateNoCycles(wizardState));
  
  // Warning checks (non-blocking)
  warnings.push(...this.validateDagConnectivity(wizardState));
  warnings.push(...this.validateNodeCount(wizardState));
  warnings.push(...this.validateDuplicateNodeNames(wizardState));
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}
```

### 8.3 Error Display Rules

| Error Count | Display |
|---|---|
| 0 errors, 0 warnings | No banner — READY state |
| 0 errors, 1+ warnings | Warning banner (amber) — WARNING state |
| 1+ errors, any warnings | Error banner (red) — INVALID state. Warnings suppressed until errors are fixed. |
| 1 error | Single error message with inline fix link |
| 2-5 errors | Stacked error messages, each with fix link |
| 6+ errors | First 5 shown + "and N more issues" summary |

### 8.4 Runtime Error Handling

#### 8.4.1 Missing Wizard State

If C09 mounts with incomplete or null wizard state:

```javascript
mount() {
  if (!this.options.wizardState) {
    this._renderErrorState('Configuration data is missing. Please go back and complete all steps.');
    return;
  }
  
  const requiredFields = [
    'infrastructure.workspaceName',
    'infrastructure.capacityId',
    'configuration.selectedTheme',
    'configuration.selectedSchemas',
  ];
  
  for (const field of requiredFields) {
    if (!this._getNestedValue(this.options.wizardState, field)) {
      this._renderErrorState(`Missing required field: ${field}. Please go back and complete this step.`);
      return;
    }
  }
  
  // Proceed with normal mount
  this._buildReviewModel();
}
```

#### 8.4.2 Mini-DAG Rendering Failure

If SVG generation fails (malformed position data, missing nodes):

```javascript
renderMiniDag(dagTopology) {
  try {
    const model = this._buildMiniDagModel(dagTopology);
    const svg = this._generateSvg(model);
    this.miniDagContainer.innerHTML = '';
    this.miniDagContainer.appendChild(svg);
  } catch (error) {
    console.error('[C09] Mini-DAG render failed:', error);
    this.miniDagContainer.innerHTML = `
      <div class="mini-dag-error" role="alert">
        <p>Unable to render DAG visualization.</p>
        <button class="review-edit-link" data-target-page="2">Edit DAG</button>
      </div>
    `;
  }
}
```

#### 8.4.3 Template Save Network Errors

```javascript
async saveAsTemplate(name, description) {
  this._setTemplateState('SAVING');
  
  try {
    const response = await this.options.onTemplateSave({
      name,
      description,
      infrastructure: this._sanitizeInfraForTemplate(),
      configuration: this.reviewModel.wizardState.configuration,
      dagTopology: this.reviewModel.wizardState.dagTopology,
      version: '1.0',
      createdAt: new Date().toISOString(),
    });
    
    this._setTemplateState('SAVE_RESULT');
    this._showTemplateSuccess(response);
  } catch (error) {
    this._setTemplateState('SAVE_RESULT');
    this._showTemplateError(
      error.message || 'Failed to save template. Please try again.'
    );
  }
}
```

#### 8.4.4 Confirmation Dispatch Failure

If `review:confirmed` event dispatch fails or C12-WizardShell rejects the manifest:

```javascript
handleConfirm() {
  if (!this.isReadyForCreation()) {
    this._announceToScreenReader('Cannot create environment. Fix validation errors first.');
    return;
  }
  
  this._setState('CONFIRMING');
  
  try {
    const manifest = this.getCreationManifest();
    this.options.onConfirm(manifest);
    this._setState('CONFIRMED');
  } catch (error) {
    console.error('[C09] Confirmation failed:', error);
    this._setState(this._previousValidState);
    this._announceToScreenReader('Environment creation failed. Please try again.');
  }
}
```

### 8.5 Graceful Degradation Matrix

| Failure | Impact | Fallback |
|---|---|---|
| Mini-DAG SVG render fails | Visual only | Show "Unable to render" message with Edit link |
| Template save API unavailable | Non-critical | Disable "Save as Template" button with tooltip |
| One review row value is undefined | Display gap | Show "—" placeholder, add console warning |
| Animation fails (old browser) | Visual only | Content renders without animation |
| Cross-step validation throws | Risk of invalid creation | Block creation, show generic error |
| Wizard state partially null | Cannot render | Show full-page error with "Go back" button |

---

## 9. Performance

### 9.1 Performance Budget

| Metric | Budget | Measurement |
|---|---|---|
| **Time to Interactive (TTI)** | < 200ms | From page transition start to all sections rendered and focusable |
| **Mini-DAG Render** | < 100ms | SVG generation + DOM insertion for the mini-DAG |
| **Validation Sweep** | < 50ms | All cross-step validation rules executed |
| **Review Model Build** | < 20ms | Transform wizard state into ReviewModel |
| **Total Paint** | < 300ms | All content visible including animations started |
| **Memory** | < 5MB | Total component memory footprint |
| **DOM Nodes** | < 300 | Total DOM elements including SVG |

### 9.2 Mini-DAG Rendering Optimization

The mini-DAG is the most performance-sensitive part of C09. It must render a potentially complex SVG visualization within the 100ms budget.

#### 9.2.1 Scaling Strategy

```javascript
/**
 * Calculate the scale factor and viewport for the mini-DAG.
 * 
 * Strategy:
 * 1. Find the bounding box of all nodes in the full DAG
 * 2. Add padding (10% on each side)
 * 3. Calculate scale to fit within the mini-DAG container
 * 4. Apply minimum node size constraints
 */
calculateMiniDagLayout(nodes, containerWidth, containerHeight) {
  if (nodes.length === 0) return null;
  
  // Find bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + 160);  // Assume full node width
    maxY = Math.max(maxY, node.position.y + 60);   // Assume full node height
  }
  
  // Add 10% padding
  const dagWidth = (maxX - minX) * 1.2;
  const dagHeight = (maxY - minY) * 1.2;
  const offsetX = minX - (maxX - minX) * 0.1;
  const offsetY = minY - (maxY - minY) * 0.1;
  
  // Scale to fit container
  const scaleX = containerWidth / dagWidth;
  const scaleY = containerHeight / dagHeight;
  const scale = Math.min(scaleX, scaleY, 0.6);  // Cap at 60% to prevent too-large rendering
  
  return { scale, offsetX, offsetY, dagWidth, dagHeight };
}
```

#### 9.2.2 Node Count Thresholds

| Node Count | Rendering Strategy |
|---|---|
| 0 | Empty state — "No nodes defined" message |
| 1-20 | Full detail — node labels, schema badges, edge paths |
| 21-50 | Reduced detail — node labels truncated to 8 chars, badges as dots |
| 51-100 | Simplified — nodes as colored dots (by schema), edges as straight lines |
| 101-200 | Cluster view — group nodes by schema, show schema clusters with counts |
| 201+ | Statistics only — show node/edge counts, no visualization |

```javascript
getMiniDagRenderMode(nodeCount) {
  if (nodeCount === 0) return 'empty';
  if (nodeCount <= 20) return 'full';
  if (nodeCount <= 50) return 'reduced';
  if (nodeCount <= 100) return 'simplified';
  if (nodeCount <= 200) return 'clustered';
  return 'statistics';
}
```

#### 9.2.3 SVG Generation Optimization

```javascript
generateMiniDagSvg(model) {
  // Use DocumentFragment for batch DOM creation
  const fragment = document.createDocumentFragment();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${model.viewBox.width} ${model.viewBox.height}`);
  svg.setAttribute('class', 'mini-dag-svg');
  svg.setAttribute('aria-hidden', 'true');
  
  // Render edges first (below nodes in z-order)
  const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  edgeGroup.setAttribute('class', 'mini-edges');
  
  for (const edge of model.edges) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', edge.path);
    path.setAttribute('class', 'mini-edge');
    edgeGroup.appendChild(path);
  }
  svg.appendChild(edgeGroup);
  
  // Render nodes
  const nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  nodeGroup.setAttribute('class', 'mini-nodes');
  
  for (const node of model.nodes) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'mini-node');
    g.setAttribute('transform', `translate(${node.x}, ${node.y})`);
    
    // Node rectangle
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', node.width);
    rect.setAttribute('height', node.height);
    rect.setAttribute('class', 'mini-node-rect');
    g.appendChild(rect);
    
    // Node label (only in full/reduced modes)
    if (model.renderMode === 'full' || model.renderMode === 'reduced') {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', node.width / 2);
      text.setAttribute('y', node.height / 2);
      text.setAttribute('class', 'mini-node-label');
      text.textContent = node.name;
      g.appendChild(text);
    }
    
    // Schema badge (only in full mode)
    if (model.renderMode === 'full') {
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      badge.setAttribute('x', node.width - 4);
      badge.setAttribute('y', -4);
      badge.setAttribute('class', `mini-badge mini-badge--${node.schema}`);
      badge.textContent = node.schemaAbbrev;
      g.appendChild(badge);
    }
    
    nodeGroup.appendChild(g);
  }
  svg.appendChild(nodeGroup);
  
  fragment.appendChild(svg);
  return fragment;
}
```

#### 9.2.4 Edge Path Generation

Cubic bezier paths for edges, with simplified calculations for the mini-DAG:

```javascript
generateEdgePath(sourceNode, targetNode) {
  const sx = sourceNode.x + sourceNode.width;
  const sy = sourceNode.y + sourceNode.height / 2;
  const tx = targetNode.x;
  const ty = targetNode.y + targetNode.height / 2;
  
  // Control point offset — 40% of horizontal distance
  const cpOffset = Math.abs(tx - sx) * 0.4;
  
  return `M ${sx} ${sy} C ${sx + cpOffset} ${sy}, ${tx - cpOffset} ${ty}, ${tx} ${ty}`;
}
```

### 9.3 Review Model Build Optimization

```javascript
buildReviewModel(wizardState) {
  // Single-pass through wizard state — no redundant iterations
  const infra = wizardState.infrastructure;
  const config = wizardState.configuration;
  const dag = wizardState.dagTopology;
  
  // Pre-compute node counts by type (single pass)
  const nodeCounts = { source: 0, transform: 0, sink: 0 };
  for (const node of dag.nodes) {
    nodeCounts[node.type] = (nodeCounts[node.type] || 0) + 1;
  }
  
  // Build sections
  const sections = [
    {
      id: 'infrastructure',
      title: 'Infrastructure',
      sourcePageIndex: 0,
      rows: [
        { label: 'Workspace', value: infra.workspaceName },
        { label: 'Capacity', value: `${infra.capacitySku} — ${infra.capacityRegion}` },
        { 
          label: 'Lakehouse', 
          value: infra.lakehouseName,
          chips: infra.lakehouseHasSchema 
            ? [{ text: 'schema ✓', variant: 'status' }] 
            : [],
        },
        { label: 'Notebook', value: infra.notebookName },
      ],
    },
    {
      id: 'configuration',
      title: 'Configuration',
      sourcePageIndex: 1,
      rows: [
        { 
          label: 'Theme', 
          value: `${config.selectedTheme.icon} ${config.selectedTheme.name}`,
          valueClass: 'accent',
        },
        {
          label: 'Schemas',
          chips: config.selectedSchemas.map(s => ({
            text: s.charAt(0).toUpperCase() + s.slice(1),
            variant: 'schema',
          })),
        },
        {
          label: 'Nodes',
          value: Object.entries(nodeCounts)
            .filter(([, count]) => count > 0)
            .map(([type, count]) => `${count} ${type}`)
            .join(' · '),
        },
      ],
    },
  ];
  
  // Build confirmation summary
  const tableCount = dag.nodes.length;
  const schemaCount = config.selectedSchemas.length;
  const confirmation = {
    resources: [
      { label: 'Lakehouse', count: 1 },
      { label: 'Notebook', count: 1 },
      { label: 'Tables', count: tableCount, qualifier: `across ${schemaCount} schemas` },
    ],
    confirmationText: `This will create 1 lakehouse, 1 notebook, and ${tableCount} tables across ${schemaCount} schemas.`,
    isValid: true,  // Updated after validation
  };
  
  return { sections, confirmation, timestamp: Date.now() };
}
```

### 9.4 Lazy Initialization

Components that are not immediately needed are initialized lazily:

```javascript
mount() {
  // Phase 1: Render text content (immediate — under 50ms)
  this._renderSections();
  this._renderConfirmation();
  
  // Phase 2: Run validation (immediate — under 50ms)
  const validationResult = this.revalidate();
  
  // Phase 3: Render mini-DAG (deferred to next frame — under 100ms)
  requestAnimationFrame(() => {
    this._renderMiniDag();
  });
  
  // Phase 4: Setup template save (deferred — lazy)
  // Template dialog DOM is not created until user clicks "Save as Template"
}
```

### 9.5 Memory Management

```javascript
unmount() {
  // Remove event listeners
  this._removeKeyboardListeners();
  this._removeResizeObserver();
  
  // Clear SVG reference (can be large for complex DAGs)
  if (this.miniDagSvg) {
    this.miniDagSvg.remove();
    this.miniDagSvg = null;
  }
  
  // Clear template dialog if open
  if (this.templateDialog) {
    this.templateDialog.remove();
    this.templateDialog = null;
  }
  
  // Clear review model
  this.reviewModel = null;
  
  // Clear DOM
  this.container.innerHTML = '';
}
```

### 9.6 Resize Handling

The mini-DAG must re-render when the container resizes (e.g., browser window resize):

```javascript
setupResizeObserver() {
  this._resizeObserver = new ResizeObserver(
    this._debounce((entries) => {
      for (const entry of entries) {
        if (entry.target === this.miniDagContainer) {
          this._renderMiniDag();
        }
      }
    }, 250)  // Debounce at 250ms
  );
  
  this._resizeObserver.observe(this.miniDagContainer);
}
```

### 9.7 Performance Monitoring

```javascript
_measurePerformance(label, fn) {
  if (typeof performance === 'undefined') return fn();
  
  const start = performance.now();
  const result = fn();
  const duration = performance.now() - start;
  
  if (duration > 100) {
    console.warn(`[C09] ${label} took ${duration.toFixed(1)}ms (budget: 100ms)`);
  }
  
  return result;
}
```

---

## 10. Implementation Notes

### 10.1 File Structure

```
src/
  components/
    review-summary/
      ReviewSummary.js          — Main component class
      ReviewSummaryModel.js     — Data model builder (§2.2)
      ReviewSummaryValidator.js — Cross-step validation (§8.1)
      MiniDagRenderer.js        — Mini-DAG SVG generator (§9.2)
      TemplateSaveDialog.js     — Template save modal (§4.4)
      review-summary.css        — Component styles (§6) — inlined at build
```

### 10.2 Class Structure

```javascript
/**
 * C09-ReviewSummary
 * 
 * Main component class. Orchestrates model building, validation,
 * rendering, and user interactions.
 */
class ReviewSummary {
  /** @type {HTMLElement} */
  container;
  
  /** @type {Object} */
  options;
  
  /** @type {ReviewModel|null} */
  reviewModel = null;
  
  /** @type {ValidationResult|null} */
  validationResult = null;
  
  /** @type {string} */
  state = 'UNMOUNTED';
  
  /** @type {string|null} */
  _lastEditSection = null;
  
  /** @type {string} */
  _previousValidState = 'READY';
  
  /** @type {SVGElement|null} */
  miniDagSvg = null;
  
  /** @type {TemplateSaveDialog|null} */
  templateDialog = null;
  
  /** @type {ResizeObserver|null} */
  _resizeObserver = null;
  
  /** @type {AbortController|null} */
  _abortController = null;
  
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this._abortController = new AbortController();
  }
  
  mount() { /* ... */ }
  unmount() { /* ... */ }
  refresh(wizardState) { /* ... */ }
  getValidationResult() { /* ... */ }
  getReviewModel() { /* ... */ }
  isReadyForCreation() { /* ... */ }
  getCreationManifest() { /* ... */ }
  navigateToEdit(sectionId) { /* ... */ }
  openTemplateSaveDialog() { /* ... */ }
  closeTemplateSaveDialog() { /* ... */ }
  async saveAsTemplate(name, description) { /* ... */ }
  revalidate() { /* ... */ }
  
  // Private methods
  _buildReviewModel() { /* ... */ }
  _renderSections() { /* ... */ }
  _renderConfirmation() { /* ... */ }
  _renderMiniDag() { /* ... */ }
  _renderValidationErrors() { /* ... */ }
  _renderValidationWarnings() { /* ... */ }
  _setState(newState) { /* ... */ }
  _setupKeyboardListeners() { /* ... */ }
  _removeKeyboardListeners() { /* ... */ }
  _setupResizeObserver() { /* ... */ }
  _removeResizeObserver() { /* ... */ }
  _announceToScreenReader(message) { /* ... */ }
  _handleEditClick(event) { /* ... */ }
  _handleConfirm() { /* ... */ }
  _sanitizeInfraForTemplate() { /* ... */ }
  _getNestedValue(obj, path) { /* ... */ }
  _renderErrorState(message) { /* ... */ }
  _debounce(fn, delay) { /* ... */ }
  _measurePerformance(label, fn) { /* ... */ }
}
```

### 10.3 Dependencies

| Dependency | Purpose | Notes |
|---|---|---|
| **C12-WizardShell** | Parent component — provides wizard state, navigation, footer control | Direct dependency — C09 is mounted by C12 |
| **C07-DagCanvas** | DAG node/connection data structure definitions | Data dependency — C09 reads C07's output |
| **C04-SchemaSelector** | Schema data structure and color mappings | Data dependency — C09 reads C04's output |
| **EventBus** | Inter-component communication | Shared utility — used for `review:*` events |
| **MiniDagRenderer** | SVG generation for the compact DAG view | Internal dependency — new module |
| **ReviewSummaryValidator** | Cross-step validation logic | Internal dependency — new module |
| **TemplateSaveDialog** | Template save modal component | Internal dependency — new module |

### 10.4 Reuse from Existing Codebase

Based on the code audit (p0-code-audit.md), the following existing patterns can be reused:

| Existing Pattern | Reuse in C09 | Adaptation Needed |
|---|---|---|
| **Workspace Inspector** (3-column property display) | Review rows layout (label-value pairs) | Simplify to 2-column (label + value), add chips |
| **Template literal rendering** | Section and row HTML generation | Apply to ReviewModel structure |
| **EventBus** | Component communication | Use existing `review:` namespace |
| **DAG renderer** (C07) | Mini-DAG SVG generation | Scale down, simplify, remove interactivity |
| **Modal dialog pattern** | Template save dialog | Apply existing focus trap and backdrop logic |
| **Debounce utility** | Resize handler | Use existing debounce from utilities |

### 10.5 CSS Integration

All C09 CSS must be written as a `<style>` block in the component or as a standalone CSS file that gets inlined during the build step (`python scripts/build-html.py`). Following EDOG Studio conventions:

- All colors in OKLCH
- All spacing using `--sp-N` tokens (4px grid)
- All border-radius using `--radius-*` tokens
- All shadows using `--shadow-*` tokens
- All font sizes using `--text-*` tokens
- No emoji — Unicode symbols only (●, ▸, ◆, ✕, ⋯)
- Class names use BEM-like convention with component prefix: `.review-*`

### 10.6 Testing Strategy

#### 10.6.1 Unit Tests

| Test Suite | Coverage Target | Key Tests |
|---|---|---|
| `ReviewSummaryModel.test.js` | 95%+ | Model building from all wizard state variants |
| `ReviewSummaryValidator.test.js` | 100% | All validation rules, edge cases, error codes |
| `MiniDagRenderer.test.js` | 90%+ | SVG generation, scaling, render modes |
| `TemplateSaveDialog.test.js` | 90%+ | Dialog lifecycle, form validation, save/cancel |

#### 10.6.2 Key Test Cases

```javascript
// ReviewSummaryValidator tests
describe('validateSchemaConsistency', () => {
  it('passes when all node schemas exist in selected schemas', () => { /* ... */ });
  it('fails when a node references an unselected schema', () => { /* ... */ });
  it('handles empty node list', () => { /* ... */ });
  it('handles empty schema list', () => { /* ... */ });
  it('reports correct sourcePageIndex for fix navigation', () => { /* ... */ });
});

describe('validateNoCycles', () => {
  it('passes for a valid DAG', () => { /* ... */ });
  it('fails for a graph with a direct cycle', () => { /* ... */ });
  it('fails for a graph with an indirect cycle', () => { /* ... */ });
  it('handles disconnected components', () => { /* ... */ });
  it('handles single-node graph', () => { /* ... */ });
});

// MiniDagRenderer tests
describe('getMiniDagRenderMode', () => {
  it('returns "empty" for 0 nodes', () => { /* ... */ });
  it('returns "full" for 1-20 nodes', () => { /* ... */ });
  it('returns "reduced" for 21-50 nodes', () => { /* ... */ });
  it('returns "simplified" for 51-100 nodes', () => { /* ... */ });
  it('returns "clustered" for 101-200 nodes', () => { /* ... */ });
  it('returns "statistics" for 201+ nodes', () => { /* ... */ });
});

describe('generateEdgePath', () => {
  it('generates valid SVG cubic bezier path', () => { /* ... */ });
  it('handles overlapping source and target nodes', () => { /* ... */ });
  it('handles large coordinate differences', () => { /* ... */ });
});

// ReviewSummary integration tests
describe('mount', () => {
  it('renders all sections in correct order', () => { /* ... */ });
  it('sets focus to first section title', () => { /* ... */ });
  it('transforms footer button to Lock In & Create', () => { /* ... */ });
  it('fires review:mounted event', () => { /* ... */ });
  it('runs validation and fires review:validation-complete', () => { /* ... */ });
});

describe('keyboard navigation', () => {
  it('Ctrl+Enter triggers confirmation when ready', () => { /* ... */ });
  it('Ctrl+Enter does not trigger when invalid', () => { /* ... */ });
  it('Escape in template dialog closes dialog', () => { /* ... */ });
  it('Tab cycles through focusable elements in correct order', () => { /* ... */ });
});
```

#### 10.6.3 Accessibility Tests

```javascript
describe('accessibility', () => {
  it('has no aXe violations', async () => {
    const results = await axe.run(container);
    expect(results.violations).toHaveLength(0);
  });
  
  it('all images have alt text or aria-label', () => { /* ... */ });
  it('all buttons have accessible names', () => { /* ... */ });
  it('focus order matches visual order', () => { /* ... */ });
  it('validation errors are announced via aria-live', () => { /* ... */ });
  it('color contrast meets WCAG AA requirements', () => { /* ... */ });
  it('respects prefers-reduced-motion', () => { /* ... */ });
  it('works in high contrast mode', () => { /* ... */ });
});
```

### 10.7 Migration Path

If this component needs to be extracted or reused in other wizards:

1. **Extract ReviewSection as standalone component** — the label-value pair rendering is generic enough to reuse in any property inspector or summary view
2. **Extract MiniDagRenderer** — can be reused anywhere a compact DAG visualization is needed (e.g., environment detail page, template preview)
3. **Extract ReviewSummaryValidator** — validation rules are specific to F16 wizard but the validation framework (error/warning classification, fix navigation) is reusable
4. **Template save dialog** — generic enough to reuse for any "save as template" flow

### 10.8 Known Constraints

| Constraint | Impact | Mitigation |
|---|---|---|
| Single HTML file build | All CSS must be inlineable | Component CSS uses standard selectors, no dynamic stylesheets |
| Vanilla JS only | No framework state management | Manual state machine with explicit transitions |
| No React/Vue | No virtual DOM diffing | Targeted DOM updates on refresh (only changed sections) |
| OKLCH colors | Limited browser support in older versions | Graceful fallback via `@supports` if needed |
| 4px spacing grid | All spacing must be multiples of 4 | Design tokens enforce this automatically |
| No emoji | Symbols like ✓ and ▸ must use Unicode | All symbols verified as cross-platform Unicode |

### 10.9 Open Questions

| # | Question | Status | Decision |
|---|---|---|---|
| 1 | Should template save block the creation flow? | DECIDED | No — template save is independent and non-blocking |
| 2 | Should the mini-DAG be interactive (clickable nodes)? | DECIDED | No — read-only visualization. Edit link navigates to full DAG |
| 3 | What is the maximum node count before refusing to render mini-DAG? | DECIDED | 200 nodes — above that, show statistics only |
| 4 | Should validation warnings require explicit acknowledgment? | DECIDED | No — warnings are shown but do not gate creation |
| 5 | Should the review page support inline editing? | DECIDED | No — all editing requires navigating back to source page |
| 6 | Should "Lock In & Create" have a double-confirm (are you sure?) dialog? | OPEN | TBD — depends on UX research feedback |
| 7 | Should template save include workspace-specific IDs? | DECIDED | No — templates are sanitized to be workspace-agnostic |

### 10.10 Related ADRs

| ADR | Relevance |
|---|---|
| ADR-001: Two-phase lifecycle | C09 operates in Disconnected phase (Fabric APIs) |
| ADR-002: Vanilla JS | C09 must use class-based vanilla JS modules |
| ADR-003: Single HTML file | C09 CSS/JS must be inlineable by build script |
| ADR-006: SignalR+MessagePack | Not directly used by C09 (no real-time data) |

### 10.11 Revision History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2025-01-XX | Sana + Pixel + Vex | Initial spec |

---

*End of C09-ReviewSummary Component Deep Spec*
