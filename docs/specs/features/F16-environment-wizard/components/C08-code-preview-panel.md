# C08 — CodePreviewPanel: Component Deep Spec

> **Component:** C08-CodePreviewPanel
> **Feature:** F16 — New Infra Wizard
> **Page:** Page 3 (DAG Canvas)
> **Complexity:** MEDIUM
> **Authors:** Pixel (JS/CSS) + Vex (Code Generation Engine)
> **Status:** P1 — COMPLETE
> **Depends On:** P0.3 (Notebook Content Format), DagCanvas (C4), DagNode (C6), ConnectionManager (C7)

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

CodePreviewPanel is a **collapsible side panel** anchored to the right edge of the DAG canvas on Page 3 of the Infra Wizard. It displays a **live, syntax-highlighted preview** of the auto-generated notebook code that will be created from the current DAG topology. The panel translates the visual graph into concrete Fabric notebook cells — Plain SQL tables, SQL Materialized Lake Views, and PySpark MLVs — in topologically sorted order, giving the user immediate visual confirmation that their DAG configuration is producing the expected output before they proceed to the Review and Execution pages.

### 1.2 Scope Boundary

**CodePreviewPanel owns:**

| Responsibility | Description |
|---------------|-------------|
| Panel chrome | Collapsible container, header bar, resize handle, toggle button |
| Code generation | Topological sort of DAG, template rendering for 3 node types |
| Syntax highlighting | Token-level colorization of SQL keywords, strings, comments, identifiers, types |
| Line numbers | Numbered gutter alongside code content |
| Copy to clipboard | One-click copy of full generated code |
| Refresh | On-demand regeneration (user clicks Refresh button) |
| Panel state | Remembers open/closed state and width during wizard session |

**CodePreviewPanel does NOT own:**

| Responsibility | Owner |
|---------------|-------|
| DAG topology data (nodes, edges) | DagCanvas (C4) |
| Node properties (name, type, schema) | DagNode (C6) |
| Connection data (parent-child relationships) | ConnectionManager (C7) |
| Theme selection and sample data schemas | ThemeSchemaPage (C3) |
| Canvas viewport, zoom, pan | DagCanvas (C4) |
| Notebook cell format for API submission | ExecutionPipeline (C10) |
| Template save/load | TemplateManager (C12) |

### 1.3 Design Reference

- **Mock:** `mocks/infra-wizard.html` — Page 3 right panel (lines 1214-1261)
- **Design System:** EDOG Design Bible 4b — monospace code blocks, panel patterns
- **Industry Reference:** VS Code minimap-style preview, dbt Cloud SQL preview panel, Databricks notebook cell preview

### 1.4 Core Design Principles

1. **On-demand, not real-time.** Code regenerates ONLY when the user clicks Refresh. This is a deliberate design choice — continuous regeneration on every node add/move/rename would be distracting and computationally wasteful for complex DAGs.

2. **Read-only preview.** The user cannot edit code in the panel. The code is auto-generated from the DAG topology. Custom code editing is a non-goal for V1 (per spec §14).

3. **Space-efficient.** The panel is collapsible and resizable to avoid stealing canvas real estate. The default width (280px) is a deliberate trade-off between readability and canvas space.

4. **Correct by construction.** The generated code must ALWAYS be valid Fabric notebook content. If any node has incomplete configuration, the panel shows a clear placeholder rather than broken code.

---

## 2. Data Model

### 2.1 Panel State

```javascript
/**
 * @typedef {Object} CodePreviewPanelState
 * @property {'collapsed' | 'expanded'} panelState - Current visibility
 * @property {number} panelWidth - Current width in pixels (min: 220, max: 480, default: 280)
 * @property {boolean} isResizing - True while user drags the resize handle
 * @property {string} generatedCode - Full raw text of generated code (no HTML)
 * @property {string} highlightedHtml - Syntax-highlighted HTML for rendering
 * @property {number} lineCount - Total number of lines in generated code
 * @property {number} scrollTop - Current scroll position (restored on refresh)
 * @property {'idle' | 'generating' | 'error'} generationStatus - Code generation status
 * @property {string|null} generationError - Error message if generation failed
 * @property {number|null} lastGeneratedAt - Timestamp of last successful generation
 * @property {boolean} isStale - True if DAG has changed since last generation
 */
```

### 2.2 DAG Input Model (received from DagCanvas)

```javascript
/**
 * @typedef {Object} DagNode
 * @property {string} id - Unique node identifier (e.g., 'node_1', 'node_2')
 * @property {string} name - User-visible name (e.g., 'orders', 'customer_360')
 * @property {'sql-table' | 'sql-mlv' | 'pyspark-mlv'} type - Node type
 * @property {'dbo' | 'bronze' | 'silver' | 'gold'} schema - Assigned schema
 * @property {number} x - Canvas x position (for ordering hints, not used in code gen)
 * @property {number} y - Canvas y position (for ordering hints, not used in code gen)
 */

/**
 * @typedef {Object} DagEdge
 * @property {string} id - Unique edge identifier
 * @property {string} sourceId - Parent node ID (output port)
 * @property {string} targetId - Child node ID (input port)
 */

/**
 * @typedef {Object} DagTopology
 * @property {DagNode[]} nodes - All nodes on canvas
 * @property {DagEdge[]} edges - All connections between nodes
 */
```

### 2.3 Theme Data Model (received from ThemeSchemaPage)

```javascript
/**
 * @typedef {Object} ThemeConfig
 * @property {string} themeId - One of: 'ecommerce', 'sales', 'iot', 'hr', 'finance', 'healthcare'
 * @property {string[]} enabledSchemas - e.g., ['dbo', 'bronze', 'silver', 'gold']
 */
```

### 2.4 Generated Cell Model

```javascript
/**
 * @typedef {Object} GeneratedCell
 * @property {number} cellIndex - 1-based cell number
 * @property {string} nodeId - Source node ID (null for pip install cell)
 * @property {string} nodeName - Node display name
 * @property {string} nodeSchema - Schema prefix
 * @property {'sql-table' | 'sql-mlv' | 'pyspark-mlv' | 'pip-install'} cellType
 * @property {string} rawCode - Raw code text (no highlighting)
 * @property {string[]} parentNames - Fully qualified parent table names for MLV cells
 */
```

### 2.5 Syntax Token Model

```javascript
/**
 * @typedef {Object} SyntaxToken
 * @property {'keyword' | 'type' | 'string' | 'comment' | 'identifier' | 'function' | 'decorator' | 'number' | 'operator' | 'divider' | 'plain'} tokenType
 * @property {string} text - Raw text content of the token
 */
```

### 2.6 Theme Sample Data Registry

Each theme provides a mapping from table name patterns to column definitions and sample rows.

```javascript
/**
 * @typedef {Object} ThemeTableTemplate
 * @property {string} tableName - Canonical table name (e.g., 'orders')
 * @property {ColumnDef[]} columns - Column definitions
 * @property {Array<Array<any>>} sampleRows - 10 rows of themed sample data
 */

/**
 * @typedef {Object} ColumnDef
 * @property {string} name - Column name
 * @property {string} sqlType - SQL type (INT, STRING, DECIMAL(10,2), TIMESTAMP, etc.)
 * @property {string} pysparkType - PySpark type class (IntegerType, StringType, etc.)
 * @property {boolean} nullable - Whether column allows nulls
 */
```

---

## 3. API Surface

### 3.1 Class Definition

```javascript
class CodePreviewPanel {
  /**
   * @param {HTMLElement} containerEl - The .dag-layout container (Page 3 root)
   * @param {Object} options
   * @param {Function} options.getDagTopology - () => DagTopology — retrieves current DAG state
   * @param {Function} options.getThemeConfig - () => ThemeConfig — retrieves current theme/schema config
   */
  constructor(containerEl, options) { ... }
}
```

### 3.2 Public Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `init()` | `init()` | `void` | Creates DOM elements, attaches event listeners, applies initial state |
| `expand()` | `expand()` | `void` | Opens the panel with slide animation |
| `collapse()` | `collapse()` | `void` | Closes the panel with slide animation |
| `toggle()` | `toggle()` | `void` | Toggles between expanded/collapsed |
| `refresh()` | `refresh()` | `void` | Regenerates code from current DAG topology |
| `copyToClipboard()` | `async copyToClipboard()` | `Promise<boolean>` | Copies raw code to clipboard, returns success |
| `getGeneratedCode()` | `getGeneratedCode()` | `string` | Returns raw generated code text (for ReviewSummary / ExecutionPipeline) |
| `getGeneratedCells()` | `getGeneratedCells()` | `GeneratedCell[]` | Returns structured cell array (for notebook API submission) |
| `isExpanded()` | `isExpanded()` | `boolean` | Returns current panel visibility state |
| `markStale()` | `markStale()` | `void` | Called by DagCanvas when topology changes; shows stale indicator |
| `setWidth(px)` | `setWidth(px: number)` | `void` | Programmatically set panel width |
| `getWidth()` | `getWidth()` | `number` | Returns current panel width in pixels |
| `destroy()` | `destroy()` | `void` | Removes DOM, detaches listeners, cleans up |

### 3.3 Callbacks / Event Hooks

| Callback | Signature | Description |
|----------|-----------|-------------|
| `onToggle` | `(isExpanded: boolean) => void` | Fired when panel expands/collapses (DagCanvas uses to adjust viewport) |
| `onRefresh` | `(cellCount: number) => void` | Fired after successful code regeneration |
| `onCopy` | `(success: boolean) => void` | Fired after copy-to-clipboard attempt |
| `onError` | `(error: string) => void` | Fired when code generation encounters an error |

### 3.4 Integration API — How Other Components Call CodePreviewPanel

```javascript
// DagCanvas notifies CodePreviewPanel when topology changes:
dagCanvas.onTopologyChange = () => {
  codePreviewPanel.markStale();
};

// ReviewSummary reads generated code for the summary page:
const cells = codePreviewPanel.getGeneratedCells();
const rawCode = codePreviewPanel.getGeneratedCode();

// ExecutionPipeline reads cells for notebook API submission:
const cells = codePreviewPanel.getGeneratedCells();
// Each cell maps to a notebook cell in the updateDefinition API body

// InfraWizardDialog tells CodePreviewPanel to auto-refresh when entering Page 3:
wizardDialog.onPageChange = (pageIndex) => {
  if (pageIndex === 2) { // Page 3 (0-indexed)
    codePreviewPanel.refresh();
  }
};
```

---

## 4. State Machine

### 4.1 Panel Visibility States

```
                    ┌──────────────────────┐
                    │                      │
       ┌────────────▶   COLLAPSED          │
       │            │   width: 0           │
       │            │   opacity: 0         │
       │            │   toggle shows "▸"   │
       │            └──────────┬───────────┘
       │                       │
       │                toggle()
       │                       │
       │            ┌──────────▼───────────┐
       │            │                      │
       └────────────┤   EXPANDED           │
         toggle()   │   width: panelWidth  │
                    │   opacity: 1         │
                    │   toggle shows "◂"   │
                    └──────────────────────┘
```

**Initial state:** `EXPANDED` (panel starts visible on first visit to Page 3).

**Persistence:** Panel state (expanded/collapsed + width) is stored in the wizard session state and restored when the user navigates back to Page 3 from other pages.

### 4.2 Code Generation States

```
                    ┌──────────────────────┐
                    │                      │
       ┌────────────▶      IDLE            │◄──────────────────┐
       │            │   No code generated  │                   │
       │            │   Shows placeholder  │                   │
       │            └──────────┬───────────┘                   │
       │                       │                               │
       │               refresh() called                        │
       │                       │                               │
       │            ┌──────────▼───────────┐                   │
       │            │                      │                   │
       │            │    GENERATING        │                   │
       │            │   Shows spinner      │                   │
       │            │   Button disabled    │                   │
       │            └──────┬──────┬────────┘                   │
       │                   │      │                            │
       │              success    error                         │
       │                   │      │                            │
       │    ┌──────────────▼┐    ┌▼─────────────────┐          │
       │    │               │    │                  │          │
       │    │   GENERATED   │    │   ERROR          │          │
       │    │  Shows code   │    │  Shows error msg │          │
       │    │  + line nums  │    │  + retry button  │          │
       │    └───────┬───────┘    └────────┬─────────┘          │
       │            │                     │                    │
       │      refresh() called     refresh() called            │
       │            │                     │                    │
       │            └─────────┬───────────┘                    │
       │                      │                                │
       │               ┌──────▼───────────┐                    │
       │               │                  │                    │
       │               │   STALE          │────refresh()───────┘
       │               │  Shows code      │
       │               │  + stale badge   │
       │               └──────────────────┘
       │                      ▲
       │                      │
       │               markStale() called
       │               (DAG topology changed)
       │                      │
       └──────────────────────┘
```

### 4.3 State Transition Table

| Current State | Event | Next State | Side Effects |
|--------------|-------|------------|-------------|
| `IDLE` | `refresh()` | `GENERATING` | Read DAG topology, start code gen |
| `GENERATING` | Generation succeeds | `GENERATED` | Render highlighted code, update line numbers |
| `GENERATING` | Generation fails | `ERROR` | Show error message, enable retry |
| `GENERATED` | `refresh()` | `GENERATING` | Preserve scroll position, regenerate |
| `GENERATED` | `markStale()` | `STALE` | Show stale indicator badge |
| `STALE` | `refresh()` | `GENERATING` | Clear stale badge, regenerate |
| `ERROR` | `refresh()` | `GENERATING` | Clear error, retry generation |
| Any | `collapse()` | Same (+ COLLAPSED) | Panel slides out, state preserved |
| Any | `expand()` | Same (+ EXPANDED) | Panel slides in, state preserved |
| Any | `copyToClipboard()` | Same | Copy raw code to clipboard |

### 4.4 Resize Sub-State

```
                    ┌──────────────────────┐
                    │                      │
                    │    NOT_RESIZING       │◄──────────┐
                    │                      │           │
                    └──────────┬───────────┘           │
                               │                       │
                        mousedown on                   │
                        resize handle                  │
                               │                       │
                    ┌──────────▼───────────┐           │
                    │                      │           │
                    │     RESIZING         │───mouseup──┘
                    │   cursor: col-resize │
                    │   live width update  │
                    │                      │
                    └──────────────────────┘
```

---

## 5. Scenarios

### 5.1 First Visit — Panel Shows Placeholder

**Given:** User navigates to Page 3 for the first time.
**When:** Page 3 activates.
**Then:**
1. Panel is in `EXPANDED` state (default 280px wide).
2. Code area shows placeholder text:
   ```
   Click "Refresh" to generate
   code preview from your DAG.
   ```
3. Refresh button is enabled.
4. Copy button is disabled (no code to copy).
5. Line numbers gutter shows "—".
6. Toggle button shows "◂" (pointing left, indicating panel can collapse).

### 5.2 First Refresh — Empty DAG

**Given:** Panel is showing placeholder, DAG canvas has zero nodes.
**When:** User clicks Refresh.
**Then:**
1. Generation completes immediately.
2. Code area shows:
   ```
   -- No nodes on canvas.
   -- Add nodes from the palette to generate code.
   ```
3. Line count: 2.
4. Copy button is disabled.

### 5.3 Refresh — Single SQL Table Node

**Given:** DAG has one node: `orders` (sql-table, bronze schema). Theme: E-Commerce.
**When:** User clicks Refresh.
**Then:**
1. Generated code:
   ```sql
   -- ═══════════════════════════════════════════════
   -- Cell 1: orders (SQL Table) [bronze]
   -- ═══════════════════════════════════════════════
   %%sql
   CREATE TABLE IF NOT EXISTS bronze.orders (
       order_id INT,
       customer_id INT,
       product_id INT,
       quantity INT,
       unit_price DECIMAL(10,2),
       total_amount DECIMAL(10,2),
       order_date TIMESTAMP,
       status STRING,
       shipping_address STRING,
       payment_method STRING
   );

   INSERT INTO bronze.orders VALUES
       (1001, 1, 101, 2, 29.99, 59.98, '2024-01-15T10:30:00', 'completed', '123 Main St, Seattle, WA', 'credit_card'),
       (1002, 2, 102, 1, 49.99, 49.99, '2024-01-15T11:45:00', 'completed', '456 Oak Ave, Portland, OR', 'paypal'),
       (1003, 3, 103, 3, 15.50, 46.50, '2024-01-16T09:15:00', 'processing', '789 Pine Rd, San Francisco, CA', 'credit_card'),
       (1004, 1, 104, 1, 199.99, 199.99, '2024-01-16T14:20:00', 'shipped', '123 Main St, Seattle, WA', 'debit_card'),
       (1005, 4, 101, 5, 29.99, 149.95, '2024-01-17T08:00:00', 'completed', '321 Elm Blvd, Denver, CO', 'credit_card'),
       (1006, 5, 105, 2, 74.99, 149.98, '2024-01-17T16:30:00', 'cancelled', '654 Birch Ln, Austin, TX', 'paypal'),
       (1007, 2, 103, 1, 15.50, 15.50, '2024-01-18T10:00:00', 'completed', '456 Oak Ave, Portland, OR', 'credit_card'),
       (1008, 6, 106, 4, 12.99, 51.96, '2024-01-18T13:45:00', 'processing', '987 Cedar Dr, Chicago, IL', 'debit_card'),
       (1009, 3, 102, 2, 49.99, 99.98, '2024-01-19T11:30:00', 'shipped', '789 Pine Rd, San Francisco, CA', 'credit_card'),
       (1010, 7, 107, 1, 89.99, 89.99, '2024-01-19T15:00:00', 'completed', '135 Maple Way, Boston, MA', 'paypal');
   ```
2. Line numbers: 1-24.
3. Copy button is enabled.
4. Syntax highlighting applied (see §6.5).

### 5.4 Refresh — Multi-Node DAG with All 3 Types

**Given:** DAG from the mock — 3 SQL tables (bronze), 2 SQL MLVs (silver), 1 PySpark MLV (gold). Theme: E-Commerce.
**When:** User clicks Refresh.
**Then:**
1. Cell ordering (topological sort):
   - Cell 0: `!pip install fmlv` (because PySpark MLV exists)
   - Cell 1: `orders` (SQL Table, bronze) — no parents, source
   - Cell 2: `customers` (SQL Table, bronze) — no parents, source
   - Cell 3: `products` (SQL Table, bronze) — no parents, source
   - Cell 4: `order_summary` (SQL MLV, silver) — parents: orders, customers
   - Cell 5: `product_metrics` (SQL MLV, silver) — parent: products
   - Cell 6: `customer_360` (PySpark MLV, gold) — parents: order_summary, product_metrics

2. Each cell is separated by a divider comment:
   ```
   -- ═══════════════════════════════════════════════
   ```

3. The pip install cell appears ONLY because `customer_360` is a PySpark MLV.

4. SQL MLV cells reference parent tables by fully-qualified name:
   ```sql
   CREATE MATERIALIZED LAKE VIEW silver.order_summary AS
   SELECT o.*, c.name AS customer_name, c.email AS customer_email
   FROM bronze.orders o
   JOIN bronze.customers c ON o.customer_id = c.customer_id;
   ```

5. PySpark MLV cell includes full decorator:
   ```python
   import fmlv
   from pyspark.sql.types import StructType, StructField, StringType, IntegerType, DecimalType, TimestampType
   from datetime import datetime

   @fmlv.materialized_lake_view(name="gold.customer_360")
   def customer_360():
       schema = StructType([
           StructField("customer_id", IntegerType(), False),
           StructField("customer_name", StringType(), True),
           StructField("total_orders", IntegerType(), True),
           StructField("total_spent", DecimalType(10, 2), True),
           StructField("avg_order_value", DecimalType(10, 2), True),
           StructField("top_product", StringType(), True),
           StructField("customer_tier", StringType(), True),
           StructField("last_order_date", TimestampType(), True),
           StructField("created_at", TimestampType(), True),
           StructField("region", StringType(), True),
       ])
       data = [
           (1, "Alice Johnson", 15, Decimal("1249.85"), Decimal("83.32"), "Wireless Headphones", "gold", datetime(2024,1,19), datetime(2024,1,1), "West"),
           (2, "Bob Smith", 8, Decimal("524.90"), Decimal("65.61"), "Smart Watch", "silver", datetime(2024,1,18), datetime(2024,1,2), "Northwest"),
           # ... 8 more rows
       ]
       df = spark.createDataFrame(data, schema=schema)
       return df
   ```

### 5.5 Refresh — DAG with Only SQL Nodes (No PySpark)

**Given:** DAG has 2 SQL tables + 1 SQL MLV. No PySpark MLV nodes.
**When:** User clicks Refresh.
**Then:**
1. No `!pip install fmlv` cell generated.
2. Cell 1: First SQL table.
3. Cell 2: Second SQL table.
4. Cell 3: SQL MLV.

### 5.6 Panel Collapse and Expand

**Given:** Panel is expanded, showing generated code.
**When:** User clicks toggle button (the "◂" tab on the left edge of the panel).
**Then:**
1. Panel animates width from `panelWidth` → 0 over 250ms with `ease-out`.
2. Panel opacity fades from 1 → 0 over 200ms.
3. Toggle button text changes from "◂" to "▸".
4. Toggle button position transitions from `right: {panelWidth}px` to `right: 0`.
5. DagCanvas viewport adjusts to fill the freed space via `onToggle(false)`.

**When:** User clicks toggle button again ("▸").
**Then:**
1. Panel animates width from 0 → `panelWidth` over 250ms with `ease-out`.
2. Panel opacity fades from 0 → 1 over 200ms.
3. Toggle button text changes from "▸" to "◂".
4. Previous scroll position is restored.
5. DagCanvas viewport adjusts via `onToggle(true)`.

### 5.7 Panel Resize via Drag Handle

**Given:** Panel is expanded at default 280px width.
**When:** User mousedowns on the left-edge resize handle and drags left.
**Then:**
1. Cursor changes to `col-resize` across entire document.
2. Panel width updates in real-time following cursor position.
3. Width is clamped: min 220px, max 480px.
4. Code content reflows within new width (monospace, `white-space: pre-wrap`).
5. DagCanvas viewport adjusts in real-time.
6. On mouseup, resize completes, cursor returns to normal.

### 5.8 Copy to Clipboard

**Given:** Panel has generated code visible.
**When:** User clicks the Copy button (clipboard icon in panel header).
**Then:**
1. Raw code text (without HTML highlighting) is written to clipboard via `navigator.clipboard.writeText()`.
2. Copy button icon briefly changes to a checkmark (✓) for 1.5 seconds.
3. A subtle green flash appears on the button background.
4. Button returns to clipboard icon after 1.5 seconds.

### 5.9 Stale Indicator

**Given:** Panel shows generated code from a previous Refresh.
**When:** User adds/removes/renames/reconnects a node on the DAG canvas (any topology change).
**Then:**
1. `markStale()` is called by DagCanvas.
2. A small badge appears next to the panel title: "Stale" in a muted warning chip.
3. Refresh button gains a subtle pulse animation to draw attention.
4. Existing code remains visible (NOT cleared).

**When:** User clicks Refresh.
**Then:**
1. Stale badge disappears.
2. Code regenerates from updated topology.
3. Refresh button pulse stops.

### 5.10 Navigate Away and Return

**Given:** Panel is collapsed and has generated code from a previous session.
**When:** User navigates to Page 4 (Review) and then back to Page 3.
**Then:**
1. Panel restores to collapsed state.
2. Previously generated code is still available (not cleared).
3. If topology changed while on Page 4 (not possible in current flow, but defensive), stale indicator shows.

### 5.11 DAG with Cycle (Defensive — Should Not Happen)

**Given:** ConnectionManager should prevent cycles, but defensively...
**When:** `refresh()` is called and the topological sort detects a cycle.
**Then:**
1. Generation state transitions to `ERROR`.
2. Error message shown: "Cannot generate code: circular dependency detected between nodes."
3. The cycle is identified: "Cycle: A → B → C → A" (best-effort).
4. Refresh button remains enabled for retry after user fixes the cycle.

### 5.12 Node with No Name (Incomplete Configuration)

**Given:** A node exists on the canvas with an empty name.
**When:** User clicks Refresh.
**Then:**
1. The node's cell is generated with a placeholder name:
   ```sql
   -- Cell 3: unnamed_node_3 (SQL Table) [dbo]
   -- ⚠ This node has no name. Rename it on the canvas.
   ```
2. A warning is shown in the header: "1 node has incomplete configuration."

---

## 6. Visual Spec

### 6.1 Panel Layout

```
┌──────────────────────────────────────────────────────────┐
│  DAG Canvas                                         │ ◂ │ ← Toggle button (20×40px)
│                                                     │   │
│                                                     │ R │ ← Resize handle (4px wide)
│                                                     │ e │
│                                                     │ s │ ┌──────────────────────┐
│                                                     │ i │ │ CODE PREVIEW   ↻  📋 │ ← Header bar
│                                                     │ z │ ├──────────────────────┤
│                                                     │ e │ │ 1 │ -- ════════════  │ ← Line numbers
│                                                     │   │ │ 2 │ -- Cell 1: ...   │    + code area
│                                                     │   │ │ 3 │ -- ════════════  │
│                                                     │   │ │ 4 │ %%sql            │
│                                                     │   │ │ 5 │ CREATE TABLE ... │
│                                                     │   │ │ 6 │   bronze.orders  │
│                                                     │   │ │ 7 │   (              │
│                                                     │   │ │ 8 │     id INT,      │
│                                                     │   │ │ . │     ...          │
│                                                     │   │ │ . │                  │
│                                                     │   │ └──────────────────────┘
└──────────────────────────────────────────────────────┘    ← 280px default width
```

### 6.2 Panel Dimensions

| Property | Value | Notes |
|----------|-------|-------|
| Default width | 280px | Matches mock `.code-panel { width: 260px }` — increased for readability |
| Minimum width | 220px | Narrower loses readability at `10px` font |
| Maximum width | 480px | Wider than half the dialog is wasteful |
| Header height | 44px | `padding: var(--sp-3) var(--sp-4)` — 12px + 20px content + 12px |
| Toggle button width | 20px | Fixed, positioned at panel left edge |
| Toggle button height | 40px | Vertically centered on canvas |
| Resize handle width | 4px | Invisible until hover, then shows `col-resize` cursor |
| Line number gutter width | 36px | Fits up to 3-digit line numbers |
| Code padding (left) | 12px | After line number gutter |
| Code padding (right) | 12px | Before panel edge |

### 6.3 Panel Styling (CSS)

```css
/* ═══════════════════════════════════════════════════════════
   CODE PREVIEW PANEL — C08
   ═══════════════════════════════════════════════════════════ */

.code-panel {
  width: 280px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  transition: width 250ms var(--ease-out), opacity 200ms var(--ease);
  overflow: hidden;
  position: relative;
  min-width: 0;  /* Allow flex shrink to 0 */
}

.code-panel.collapsed {
  width: 0;
  opacity: 0;
  border-left: none;
  pointer-events: none;  /* Prevent interaction when invisible */
}

/* ── Header ── */
.code-panel-header {
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  min-height: 44px;
  gap: var(--sp-2);
}

.code-panel-title {
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  white-space: nowrap;
}

.code-panel-title .stale-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--r-full);
  background: var(--status-warn-dim);
  color: var(--status-warn);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  animation: fadeIn 200ms var(--ease);
}

.code-panel-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.code-panel-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
  transition: all var(--t-fast) var(--ease);
  background: var(--surface-2);
  border: none;
  cursor: pointer;
}

.code-panel-btn:hover {
  background: var(--surface-3);
  color: var(--text);
}

.code-panel-btn:active {
  transform: scale(0.95);
}

.code-panel-btn.refreshing {
  pointer-events: none;
  opacity: 0.5;
}

.code-panel-btn.refreshing svg {
  animation: spin 0.8s linear infinite;
}

.code-panel-btn.stale-pulse {
  animation: pulseAccent 2s ease-in-out infinite;
}

.code-panel-btn.copy-success {
  color: var(--status-ok);
  background: var(--status-ok-dim);
}

/* ── Code Body ── */
.code-panel-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  position: relative;
}

/* ── Line Numbers Gutter ── */
.code-gutter {
  width: 36px;
  flex-shrink: 0;
  padding: var(--sp-3) 0;
  text-align: right;
  user-select: none;
  border-right: 1px solid var(--border);
  background: var(--surface-2);
}

.code-gutter-line {
  font-family: var(--mono);
  font-size: var(--text-xs);
  line-height: 1.7;
  color: var(--text-muted);
  padding-right: var(--sp-2);
  opacity: 0.5;
}

/* ── Code Content ── */
.code-content {
  flex: 1;
  padding: var(--sp-3);
  overflow-x: auto;
}

.code-block {
  font-family: var(--mono);
  font-size: var(--text-xs);  /* 10px */
  line-height: 1.7;
  color: var(--text-dim);
  white-space: pre;
  word-break: normal;
  tab-size: 4;
  margin: 0;
}

/* ── Syntax Highlighting Token Classes ── */
.code-block .tok-kw {    /* SQL/Python keywords */
  color: var(--accent);
  font-weight: 500;
}

.code-block .tok-type {  /* SQL type names */
  color: #2d7ff9;
  font-weight: 400;
}

.code-block .tok-str {   /* String literals */
  color: var(--status-ok);
}

.code-block .tok-cm {    /* Comments */
  color: var(--text-muted);
  font-style: italic;
}

.code-block .tok-fn {    /* Function names / identifiers */
  color: #2d7ff9;
}

.code-block .tok-dec {   /* Decorators (@fmlv...) */
  color: var(--status-warn);
  font-weight: 500;
}

.code-block .tok-num {   /* Numeric literals */
  color: #e06c60;
}

.code-block .tok-op {    /* Operators (=, ., *, etc.) */
  color: var(--text-dim);
}

.code-block .tok-div {   /* Divider comments (═══) */
  color: var(--border-bright);
  font-style: normal;
}

/* ── Toggle Button ── */
.code-panel-toggle {
  position: absolute;
  right: 280px;           /* Tracks panel width */
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 40px;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-right: none;
  border-radius: var(--r-sm) 0 0 var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
  transition: all var(--t-fast) var(--ease);
  z-index: 5;
  user-select: none;
}

.code-panel-toggle:hover {
  background: var(--surface-2);
  color: var(--text);
}

.code-panel-toggle.collapsed-pos {
  right: 0;
}

/* ── Resize Handle ── */
.code-panel-resize {
  position: absolute;
  left: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  z-index: 6;
  background: transparent;
  transition: background var(--t-fast) var(--ease);
}

.code-panel-resize:hover,
.code-panel-resize.active {
  background: var(--accent);
}

/* ── Placeholder (no code yet) ── */
.code-panel-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: center;
  padding: var(--sp-6);
}

.code-panel-placeholder-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--r-md);
  background: var(--surface-2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 18px;
}

/* ── Error State ── */
.code-panel-error {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  color: var(--status-fail);
  font-size: var(--text-sm);
  text-align: center;
  padding: var(--sp-6);
}
```

### 6.4 Collapse/Expand Animation Specification

| Property | Expand | Collapse |
|----------|--------|----------|
| Panel `width` | 0 → `panelWidth` | `panelWidth` → 0 |
| Panel `opacity` | 0 → 1 | 1 → 0 |
| Duration | 250ms | 250ms |
| Easing | `cubic-bezier(0, 0, 0.2, 1)` (`--ease-out`) | `cubic-bezier(0, 0, 0.2, 1)` |
| Toggle button `right` | 0 → `panelWidth`px | `panelWidth`px → 0 |
| Toggle button text | "▸" → "◂" | "◂" → "▸" |
| Toggle button transition | 250ms `--ease-out` | 250ms `--ease-out` |
| Canvas viewport | Shrinks to accommodate | Expands to fill |

**Sequence:**

1. **Expand:** Panel `width` transitions → toggle button `right` tracks width → content fades in at 150ms mark → scroll position restored at 250ms.
2. **Collapse:** Content fades out immediately → panel `width` transitions → toggle button `right` tracks width → canvas fills space.

### 6.5 Syntax Highlighting Token Specification

The syntax highlighter is a **lexer-based tokenizer** — NOT a full parser. It processes code line-by-line, applying regex-based token rules to produce `<span class="tok-*">` wrapped text.

#### Token Categories

| Token Class | CSS Class | Color | Font | Matches |
|-------------|-----------|-------|------|---------|
| **SQL Keyword** | `.tok-kw` | `var(--accent)` (#6d5cff) | weight 500 | `SELECT`, `FROM`, `WHERE`, `JOIN`, `ON`, `AS`, `CREATE`, `TABLE`, `IF`, `NOT`, `EXISTS`, `INSERT`, `INTO`, `VALUES`, `MATERIALIZED`, `LAKE`, `VIEW`, `AND`, `OR`, `IN`, `IS`, `NULL`, `ORDER`, `BY`, `GROUP`, `HAVING`, `LIMIT`, `UNION`, `ALL`, `DISTINCT`, `CASE`, `WHEN`, `THEN`, `ELSE`, `END`, `LEFT`, `RIGHT`, `INNER`, `OUTER`, `FULL`, `CROSS` |
| **Python Keyword** | `.tok-kw` | `var(--accent)` (#6d5cff) | weight 500 | `import`, `from`, `def`, `return`, `class`, `if`, `else`, `elif`, `for`, `while`, `True`, `False`, `None`, `and`, `or`, `not`, `in`, `is`, `lambda`, `with`, `as`, `pass`, `raise`, `try`, `except`, `finally` |
| **Magic/Cell** | `.tok-kw` | `var(--accent)` (#6d5cff) | weight 500 | `%%sql`, `!pip` |
| **SQL Type** | `.tok-type` | `#2d7ff9` (blue) | weight 400 | `INT`, `INTEGER`, `BIGINT`, `SMALLINT`, `TINYINT`, `FLOAT`, `DOUBLE`, `DECIMAL`, `STRING`, `VARCHAR`, `CHAR`, `BOOLEAN`, `DATE`, `TIMESTAMP`, `BINARY`, `ARRAY`, `MAP`, `STRUCT` |
| **PySpark Type** | `.tok-type` | `#2d7ff9` (blue) | weight 400 | `IntegerType`, `LongType`, `FloatType`, `DoubleType`, `DecimalType`, `StringType`, `BooleanType`, `TimestampType`, `DateType`, `BinaryType`, `ArrayType`, `MapType`, `StructType`, `StructField` |
| **String Literal** | `.tok-str` | `var(--status-ok)` (#18a058) | normal | Single-quoted: `'...'`, Double-quoted: `"..."` |
| **Comment** | `.tok-cm` | `var(--text-muted)` (#8e95a5) | italic | `--` to end of line (SQL), `#` to end of line (Python) |
| **Divider** | `.tok-div` | `var(--border-bright)` | normal | `-- ═══` patterns (section dividers) |
| **Decorator** | `.tok-dec` | `var(--status-warn)` (#e5940c) | weight 500 | `@fmlv.materialized_lake_view(...)`, any `@identifier` |
| **Numeric Literal** | `.tok-num` | `#e06c60` (red) | normal | Integer: `123`, Decimal: `123.45`, Negative: `-123` |
| **Function/Identifier** | `.tok-fn` | `#2d7ff9` (blue) | normal | Identifiers immediately followed by `(`, e.g., `spark.createDataFrame(`, `Decimal(` |
| **Operator** | `.tok-op` | `var(--text-dim)` | normal | `=`, `.`, `*`, `(`, `)`, `,`, `;` |
| **Plain Text** | (none) | `var(--text-dim)` | normal | Everything else |

#### Tokenizer Rules (Ordered by Priority)

The tokenizer processes each line left-to-right, applying rules in priority order. First match wins.

```javascript
const TOKEN_RULES = [
  // 1. Divider comments (must match before regular comments)
  { pattern: /^--\s*[═━─]{3,}.*$/,          class: 'tok-div' },

  // 2. Comments (SQL -- and Python #)
  { pattern: /--.*$/,                         class: 'tok-cm' },
  { pattern: /#.*$/,                          class: 'tok-cm' },

  // 3. String literals (single and double quoted, handles escapes)
  { pattern: /'(?:[^'\\]|\\.)*'/,             class: 'tok-str' },
  { pattern: /"(?:[^"\\]|\\.)*"/,             class: 'tok-str' },

  // 4. Decorators
  { pattern: /@[\w.]+(?:\([^)]*\))?/,         class: 'tok-dec' },

  // 5. Magic commands (%%sql, !pip)
  { pattern: /^%%\w+/,                        class: 'tok-kw' },
  { pattern: /^!pip\b/,                       class: 'tok-kw' },

  // 6. PySpark types (before general identifiers)
  { pattern: /\b(StructType|StructField|IntegerType|LongType|FloatType|DoubleType|DecimalType|StringType|BooleanType|TimestampType|DateType|BinaryType|ArrayType|MapType)\b/,
    class: 'tok-type' },

  // 7. SQL types (word boundary, case insensitive)
  { pattern: /\b(INT|INTEGER|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE|DECIMAL|STRING|VARCHAR|CHAR|BOOLEAN|DATE|TIMESTAMP|BINARY|ARRAY|MAP|STRUCT)\b/i,
    class: 'tok-type' },

  // 8. SQL keywords (word boundary, case insensitive)
  { pattern: /\b(SELECT|FROM|WHERE|JOIN|ON|AS|CREATE|TABLE|IF|NOT|EXISTS|INSERT|INTO|VALUES|MATERIALIZED|LAKE|VIEW|AND|OR|IN|IS|NULL|ORDER|BY|GROUP|HAVING|LIMIT|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|LEFT|RIGHT|INNER|OUTER|FULL|CROSS)\b/i,
    class: 'tok-kw' },

  // 9. Python keywords
  { pattern: /\b(import|from|def|return|class|if|else|elif|for|while|True|False|None|and|or|not|in|is|lambda|with|as|pass|raise|try|except|finally|install)\b/,
    class: 'tok-kw' },

  // 10. Numeric literals
  { pattern: /-?\b\d+(?:\.\d+)?\b/,          class: 'tok-num' },

  // 11. Function calls (identifier followed by open paren)
  { pattern: /\b(\w+)(?=\()/,                 class: 'tok-fn' },
];
```

#### Tokenizer Algorithm

```javascript
/**
 * Tokenizes a single line of code into highlighted HTML.
 * @param {string} line - Raw code line
 * @returns {string} - HTML with <span class="tok-*"> wrappers
 */
function tokenizeLine(line) {
  let result = '';
  let pos = 0;

  while (pos < line.length) {
    let matched = false;

    for (const rule of TOKEN_RULES) {
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags || '');
      regex.lastIndex = 0;
      const remaining = line.slice(pos);
      const match = remaining.match(regex);

      if (match && match.index === 0) {
        result += `<span class="${rule.class}">${escapeHtml(match[0])}</span>`;
        pos += match[0].length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      result += escapeHtml(line[pos]);
      pos++;
    }
  }

  return result;
}

/**
 * Tokenizes full code block.
 * @param {string} code - Complete raw code string
 * @returns {{ html: string, lineCount: number }}
 */
function highlightCode(code) {
  const lines = code.split('\n');
  const htmlLines = lines.map(line => tokenizeLine(line));
  return {
    html: htmlLines.join('\n'),
    lineCount: lines.length,
  };
}
```

### 6.6 Typography

| Element | Font | Size | Weight | Color |
|---------|------|------|--------|-------|
| Panel title "CODE PREVIEW" | Inter | 10px (`--text-xs`) | 700 | `var(--text-muted)` |
| Refresh/Copy button icons | — | 12px | — | `var(--text-muted)` |
| Line numbers | JetBrains Mono | 10px (`--text-xs`) | 400 | `var(--text-muted)` at 50% opacity |
| Code text | JetBrains Mono | 10px (`--text-xs`) | 400 | Per token class (see §6.5) |
| Placeholder text | Inter | 12px (`--text-sm`) | 400 | `var(--text-muted)` |
| Error text | Inter | 12px (`--text-sm`) | 500 | `var(--status-fail)` |
| Stale badge | Inter | 9px | 600 | `var(--status-warn)` |

### 6.7 Dark Theme Adaptation

The panel uses CSS custom properties exclusively, so dark theme is automatic via `[data-theme="dark"]` overrides:

| Token | Light | Dark |
|-------|-------|------|
| Keywords | `#6d5cff` | `#8577ff` (brighter) |
| Types | `#2d7ff9` | `#5a9fff` |
| Strings | `#18a058` | `#2bc06c` |
| Comments | `#8e95a5` | `#5a6070` |
| Decorators | `#e5940c` | `#f0a830` |
| Numbers | `#e06c60` | `#f08070` |
| Plain text | `#5a6070` | `#a0a8b8` |
| Gutter bg | `var(--surface-2)` | `var(--surface-2)` (auto) |
| Panel bg | `var(--surface)` | `var(--surface)` (auto) |

---

## 7. Keyboard & Accessibility

### 7.1 Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+Shift+C` | Page 3 active | Toggle code preview panel |
| `Ctrl+Shift+R` | Panel expanded | Refresh code preview |
| `Escape` | Panel expanded, panel focused | Collapse panel, return focus to canvas |
| `Tab` | Panel focused | Move focus: Refresh → Copy → Code body |
| `Ctrl+A` | Code body focused | Select all code text |
| `Ctrl+C` | Code body focused, text selected | Copy selected text to clipboard |

### 7.2 Focus Management

```
┌─────────────────────────────────────────┐
│  Tab Order within Panel:                │
│                                         │
│  1. Toggle button (tab-focusable)       │
│  2. Refresh button                      │
│  3. Copy button                         │
│  4. Code body (scrollable, selectable)  │
│                                         │
│  Shift+Tab: reverse order               │
│  Escape from any: collapse panel        │
└─────────────────────────────────────────┘
```

**Focus trap:** The panel does NOT trap focus. Tab past the last element (Code body) continues to the next focusable element outside the panel (canvas controls).

### 7.3 ARIA Attributes

```html
<div class="code-panel"
     role="complementary"
     aria-label="Code Preview Panel"
     aria-expanded="true">

  <div class="code-panel-header" role="toolbar" aria-label="Code preview controls">
    <span class="code-panel-title" id="code-panel-title">Code Preview</span>
    <div class="code-panel-actions">
      <button class="code-panel-btn"
              aria-label="Refresh code preview"
              aria-describedby="code-panel-title"
              title="Refresh">
        <!-- refresh icon -->
      </button>
      <button class="code-panel-btn"
              aria-label="Copy code to clipboard"
              title="Copy">
        <!-- clipboard icon -->
      </button>
    </div>
  </div>

  <div class="code-panel-body"
       role="region"
       aria-label="Generated code preview"
       aria-live="polite"
       tabindex="0">
    <pre class="code-block"
         role="textbox"
         aria-readonly="true"
         aria-multiline="true">
      <!-- highlighted code -->
    </pre>
  </div>
</div>

<button class="code-panel-toggle"
        aria-label="Toggle code preview panel"
        aria-expanded="true"
        aria-controls="code-panel">
  ◂
</button>
```

### 7.4 Screen Reader Announcements

| Event | Announcement |
|-------|-------------|
| Panel expand | "Code preview panel expanded" |
| Panel collapse | "Code preview panel collapsed" |
| Refresh complete | "Code preview refreshed. {N} cells generated, {M} lines of code." |
| Refresh error | "Code preview error: {error message}" |
| Copy success | "Code copied to clipboard" |
| Copy failure | "Failed to copy code to clipboard" |
| Stale indicator | "Code preview is stale. Click Refresh to update." |

### 7.5 Reduced Motion

When `prefers-reduced-motion: reduce` is active:

- Panel collapse/expand: instant (no transition).
- Stale badge pulse: disabled.
- Copy success flash: disabled.
- Refresh spinner: replaced with static "..." text.

```css
@media (prefers-reduced-motion: reduce) {
  .code-panel {
    transition: none;
  }
  .code-panel-toggle {
    transition: none;
  }
  .code-panel-btn.stale-pulse {
    animation: none;
  }
  .code-panel-btn.copy-success {
    animation: none;
  }
}
```

---

## 8. Error Handling

### 8.1 Error Taxonomy

| Error | Cause | Severity | User Impact | Recovery |
|-------|-------|----------|-------------|----------|
| **Cycle detected** | Invalid DAG topology (should be prevented by ConnectionManager) | ERROR | Cannot generate code | Fix cycle on canvas, then Refresh |
| **Empty DAG** | No nodes on canvas | INFO | Shows "no nodes" message | Add nodes, then Refresh |
| **Incomplete node** | Node has no name or missing required fields | WARNING | Generates code with placeholders | Complete node config, then Refresh |
| **Unknown node type** | Corrupted node data | ERROR | Skip node, log warning | Should not happen; defensive |
| **Theme data missing** | Theme not selected (Page 2 skipped?) | WARNING | Uses generic sample data | Return to Page 2, select theme |
| **Too many nodes** | >100 nodes on canvas | WARNING | May be slow; generates anyway | Reduce node count |
| **Clipboard API unavailable** | Insecure context or browser restriction | WARNING | Copy button fails silently | Show fallback: select-all hint |
| **Stack overflow in topo sort** | Extremely deep DAG (>500 levels) | ERROR | Generation fails | Unlikely at 100-node limit |

### 8.2 Error Display

**Error in code area:**
```html
<div class="code-panel-error">
  <div class="code-panel-error-icon">✕</div>
  <div class="code-panel-error-title">Generation Failed</div>
  <div class="code-panel-error-msg">{error message}</div>
  <button class="code-panel-btn" aria-label="Retry">Retry</button>
</div>
```

**Warning in header (non-blocking):**
```html
<span class="code-panel-warning-badge">
  ▲ 2 warnings
</span>
```

Clicking the warning badge scrolls to the first warning comment in the code body.

### 8.3 Clipboard Fallback

If `navigator.clipboard.writeText()` is unavailable or fails:

1. Create a hidden `<textarea>` with the raw code.
2. Select all text in the textarea.
3. Execute `document.execCommand('copy')`.
4. Remove the textarea.
5. If that also fails, show tooltip: "Select code and press Ctrl+C to copy."

```javascript
async copyToClipboard() {
  const code = this._state.generatedCode;
  if (!code) return false;

  try {
    await navigator.clipboard.writeText(code);
    return true;
  } catch {
    // Fallback for insecure contexts
    const textarea = document.createElement('textarea');
    textarea.value = code;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(textarea);
    textarea.select();
    let success = false;
    try {
      success = document.execCommand('copy');
    } catch { /* ignore */ }
    document.body.removeChild(textarea);
    return success;
  }
}
```

---

## 9. Performance

### 9.1 Performance Budgets

| Metric | Budget | Notes |
|--------|--------|-------|
| Code generation (10 nodes) | < 5ms | Topological sort + template rendering |
| Code generation (50 nodes) | < 20ms | Linear in node count |
| Code generation (100 nodes) | < 50ms | Max node count per spec |
| Syntax highlighting (500 lines) | < 10ms | Regex-based line tokenizer |
| Syntax highlighting (2000 lines) | < 40ms | 100 nodes × ~20 lines each |
| Panel collapse/expand | < 1 frame (16ms) | CSS transition only, no JS layout |
| Copy to clipboard | < 5ms | Direct text copy, no serialization |
| DOM render (highlighted code) | < 20ms | Single `innerHTML` assignment |
| Resize handle drag | < 1 frame per move | Width update only, no code re-render |
| Scroll performance | 60fps | Native browser scrolling |

### 9.2 Optimization Strategies

#### 9.2.1 Lazy Generation

Code is generated ONLY on explicit `refresh()` call, never automatically. This means:
- Adding/removing/moving nodes has zero performance impact on the panel.
- The panel can safely exist while the user builds complex DAGs.
- The user controls when the potentially expensive generation runs.

#### 9.2.2 Incremental DOM Update

Instead of replacing the entire code body on every refresh:

```javascript
refresh() {
  const { code, cells } = this._generateCode();

  // Compare with previous generation
  if (code === this._state.generatedCode) {
    return; // No change, skip DOM update
  }

  const { html, lineCount } = highlightCode(code);

  // Batch DOM update
  requestAnimationFrame(() => {
    this._codeEl.innerHTML = html;
    this._renderLineNumbers(lineCount);
    this._restoreScrollPosition();
  });

  this._state.generatedCode = code;
  this._state.highlightedHtml = html;
  this._state.lineCount = lineCount;
}
```

#### 9.2.3 Virtual Scrolling (Stretch Goal for Very Long Code)

For DAGs with 50+ nodes generating 1000+ lines, consider virtual scrolling:
- Only render visible lines + a small overscan buffer (±20 lines).
- Use fixed line height (17px at `10px font-size × 1.7 line-height`) for precise scroll math.
- This is a stretch goal — at 100 nodes max, the code is ~2000 lines, which DOM handles fine.

**Decision:** V1 uses full DOM rendering. Virtual scrolling only if performance testing shows jank.

#### 9.2.4 Memoized Theme Data

Theme sample data (10 rows per table) is generated once per theme selection and cached:

```javascript
// Cache key: themeId + nodeName + schema
const cacheKey = `${themeId}:${schema}.${nodeName}`;
if (this._sampleDataCache.has(cacheKey)) {
  return this._sampleDataCache.get(cacheKey);
}
```

### 9.3 Memory Budget

| Component | Estimated Memory |
|-----------|-----------------|
| Panel DOM (expanded) | ~50 KB |
| Raw code string (100 nodes) | ~80 KB |
| Highlighted HTML (100 nodes) | ~200 KB (span wrappers add ~2.5× overhead) |
| Sample data cache (6 themes × 5 tables) | ~30 KB |
| Line number elements (2000 lines) | ~80 KB |
| **Total** | **~440 KB** |

---

## 10. Implementation Notes

### 10.1 Topological Sort Algorithm

The code generator must output cells in **topological order** — a node's definition must appear before any node that references it. This is the exact cell ordering that the Fabric notebook requires for correct execution.

#### Algorithm: Kahn's Algorithm (BFS-based)

Kahn's algorithm is preferred over DFS-based topological sort because:
1. It naturally detects cycles (if the output count ≠ node count, there's a cycle).
2. It produces a deterministic order when combined with a tie-breaking comparator.
3. It's iterative (no recursion, no stack overflow risk for deep DAGs).

```
FUNCTION topologicalSort(nodes, edges):
    // Build adjacency and in-degree maps
    inDegree = MAP<nodeId, number>  -- initialized to 0 for each node
    children = MAP<nodeId, Set<nodeId>>  -- adjacency list

    FOR each edge IN edges:
        inDegree[edge.targetId] += 1
        children[edge.sourceId].add(edge.targetId)

    // Initialize queue with zero in-degree nodes (source/root nodes)
    queue = PRIORITY_QUEUE()  -- ordered by: type priority, then name alphabetically
    FOR each node IN nodes:
        IF inDegree[node.id] == 0:
            queue.enqueue(node)

    // Process
    sorted = []
    WHILE queue IS NOT empty:
        node = queue.dequeue()
        sorted.push(node)

        FOR each childId IN children[node.id]:
            inDegree[childId] -= 1
            IF inDegree[childId] == 0:
                childNode = findNode(childId)
                queue.enqueue(childNode)

    // Cycle detection
    IF sorted.length != nodes.length:
        // Remaining nodes form a cycle
        cycleNodes = nodes.filter(n => !sorted.includes(n))
        THROW CycleDetectedError(cycleNodes)

    RETURN sorted
```

#### Tie-Breaking Order (Deterministic Output)

When multiple nodes have the same topological rank (zero in-degree simultaneously), they are ordered by:

1. **Type priority:** `sql-table` (0) → `sql-mlv` (1) → `pyspark-mlv` (2)
2. **Schema priority:** `dbo` (0) → `bronze` (1) → `silver` (2) → `gold` (3)
3. **Name alphabetically:** `customers` before `orders`

This ensures the same DAG always generates the same code, regardless of the order nodes were placed on the canvas.

### 10.2 Code Generation Templates

#### 10.2.1 Pip Install Cell (Conditional)

Generated ONLY if at least one `pyspark-mlv` node exists in the DAG.

```
!pip install fmlv
```

- This is always Cell 0 (first cell) when present.
- It is a raw text cell, not a `%%sql` or `%%python` cell.
- No syntax highlighting applied (the `!pip` keyword is highlighted, `install` and `fmlv` are plain text).

#### 10.2.2 Plain SQL Table Cell Template

```
%%sql
CREATE TABLE IF NOT EXISTS {schema}.{table_name} (
    {col1_name} {COL1_TYPE},
    {col2_name} {COL2_TYPE},
    ...
    {colN_name} {COLN_TYPE}
);

INSERT INTO {schema}.{table_name} VALUES
    ({row1_val1}, {row1_val2}, ..., {row1_valN}),
    ({row2_val1}, {row2_val2}, ..., {row2_valN}),
    ...
    ({row10_val1}, {row10_val2}, ..., {row10_valN});
```

**Rules:**
- `{schema}` is the node's assigned schema (`dbo`, `bronze`, `silver`, `gold`).
- `{table_name}` is the node's name.
- Columns and sample data come from the theme registry (see §10.4).
- If the node name matches a known theme table (e.g., `orders` in E-Commerce), use that theme's columns.
- If the node name does NOT match a known theme table, use a generic template:
  ```sql
  CREATE TABLE IF NOT EXISTS {schema}.{name} (
      id INT,
      name STRING,
      value DECIMAL(10,2),
      category STRING,
      status STRING,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      description STRING,
      is_active BOOLEAN,
      tags STRING
  );
  ```
- Always exactly 10 rows of sample data.
- String values are single-quoted.
- Timestamps are ISO 8601 format: `'2024-01-15T10:30:00'`.
- `DECIMAL` values have 2 decimal places.

#### 10.2.3 SQL MLV Cell Template — Single Parent

```
%%sql
CREATE MATERIALIZED LAKE VIEW {schema}.{mlv_name} AS
SELECT *
FROM {parent_schema}.{parent_name};
```

**CRITICAL:** It is `CREATE MATERIALIZED LAKE VIEW` — NOT `CREATE MATERIALIZED VIEW`. The word `LAKE` is mandatory. This is Fabric-specific syntax.

#### 10.2.4 SQL MLV Cell Template — Multiple Parents (JOIN)

```
%%sql
CREATE MATERIALIZED LAKE VIEW {schema}.{mlv_name} AS
SELECT {alias1}.*, {alias2}.{col1} AS {qualified_col1}
FROM {parent1_schema}.{parent1_name} {alias1}
JOIN {parent2_schema}.{parent2_name} {alias2}
    ON {alias1}.id = {alias2}.{fk_col};
```

**JOIN generation rules:**
- First parent is the "base" table (alias `a`).
- Subsequent parents are JOINed (aliases `b`, `c`, `d`, ...).
- JOIN condition uses a heuristic: `ON a.id = b.{first_parent_name}_id`
  - e.g., if parent is `orders`, the FK column is `order_id`.
  - If no plausible FK column exists, use: `ON a.id = b.id` (fallback).
- Only the first 3 columns of secondary parents are selected (with qualified names to avoid collisions).

**Example with 3 parents:**

```sql
%%sql
CREATE MATERIALIZED LAKE VIEW gold.customer_360 AS
SELECT a.*, b.name AS customer_name, b.email AS customer_email,
       c.product_name, c.category AS product_category
FROM silver.order_summary a
JOIN bronze.customers b
    ON a.customer_id = b.id
JOIN silver.product_metrics c
    ON a.product_id = c.id;
```

#### 10.2.5 PySpark MLV Cell Template — Single Parent

```python
import fmlv
from pyspark.sql.types import StructType, StructField, {TypeImports}
from datetime import datetime
from decimal import Decimal

@fmlv.materialized_lake_view(name="{schema}.{mlv_name}")
def {mlv_name}():
    schema = StructType([
        StructField("{col1_name}", {Col1Type}(), {nullable1}),
        StructField("{col2_name}", {Col2Type}(), {nullable2}),
        ...
    ])
    data = [
        ({row1_vals}),
        ({row2_vals}),
        ...
        ({row10_vals}),
    ]
    df = spark.createDataFrame(data, schema=schema)
    return df
```

**Rules:**
- `{TypeImports}` is a deduplicated, sorted list of PySpark type classes used in the schema.
- The `datetime` import is only included if `TimestampType` or `DateType` is used.
- The `Decimal` import is only included if `DecimalType` is used.
- The function name is the node name (sanitized: replace hyphens with underscores, strip non-alphanumeric).
- The decorator `name` argument uses the fully qualified `{schema}.{mlv_name}`.
- PySpark string values use double quotes (Python convention).
- Timestamps use `datetime(2024, 1, 15, 10, 30, 0)` constructor.
- Decimals use `Decimal("29.99")` constructor.

#### 10.2.6 PySpark MLV Cell Template — Multiple Parents

For PySpark MLVs with multiple parents, the code references parents via `spark.sql()`:

```python
import fmlv
from pyspark.sql.types import StructType, StructField, {TypeImports}
from datetime import datetime
from decimal import Decimal

@fmlv.materialized_lake_view(name="{schema}.{mlv_name}")
def {mlv_name}():
    # Read from parent tables
    {parent1_alias} = spark.sql("SELECT * FROM {parent1_schema}.{parent1_name}")
    {parent2_alias} = spark.sql("SELECT * FROM {parent2_schema}.{parent2_name}")

    # Join parent data
    df = {parent1_alias}.join(
        {parent2_alias},
        on="{join_key}",
        how="inner"
    )
    return df
```

#### 10.2.7 Cell Divider

Between every cell, insert a divider comment:

```
-- ═══════════════════════════════════════════════
-- Cell {N}: {node_name} ({type_label}) [{schema}]
-- ═══════════════════════════════════════════════
```

The divider uses the Unicode box-drawing character `═` (U+2550), exactly 47 characters wide. The cell header includes the 1-based cell number, node name, human-readable type label (`SQL Table`, `SQL MLV`, `PySpark MLV`), and the schema in square brackets.

### 10.3 Full Code Generation Pipeline

```
┌─────────────────┐
│  getDagTopology()│ ──── Read current nodes + edges from DagCanvas
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ topologicalSort()│ ──── Kahn's algorithm, returns ordered node list
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ checkPySparkMLV()│ ──── If any pyspark-mlv nodes exist, prepend pip install cell
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ FOR each node:   │
│  generateCell()  │ ──── Template selection based on node type
│  getParents()    │ ──── Look up parent nodes from edges
│  getThemeData()  │ ──── Look up columns + sample data from theme registry
│  formatCell()    │ ──── Apply template with substitution
│  addDivider()    │ ──── Insert ═══ divider before each cell
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ joinCells()      │ ──── Concatenate all cells with newlines
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ highlightCode()  │ ──── Tokenize + wrap with span classes
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ renderDOM()      │ ──── Insert into code body + render line numbers
└─────────────────┘
```

### 10.4 Theme Data Registry — Complete Templates

The theme registry maps theme IDs to table definitions. When a node's name matches a known table in the selected theme, the generator uses that table's columns and sample data. When a node name does NOT match, a generic fallback template is used.

#### E-Commerce Theme (`ecommerce`)

| Table Name | Columns |
|-----------|---------|
| `orders` | `order_id INT`, `customer_id INT`, `product_id INT`, `quantity INT`, `unit_price DECIMAL(10,2)`, `total_amount DECIMAL(10,2)`, `order_date TIMESTAMP`, `status STRING`, `shipping_address STRING`, `payment_method STRING` |
| `customers` | `customer_id INT`, `name STRING`, `email STRING`, `phone STRING`, `address STRING`, `city STRING`, `state STRING`, `tier STRING`, `signup_date TIMESTAMP`, `is_active BOOLEAN` |
| `products` | `product_id INT`, `product_name STRING`, `category STRING`, `brand STRING`, `unit_price DECIMAL(10,2)`, `stock_quantity INT`, `weight DECIMAL(5,2)`, `rating DECIMAL(2,1)`, `created_at TIMESTAMP`, `is_available BOOLEAN` |
| `categories` | `category_id INT`, `category_name STRING`, `parent_category STRING`, `description STRING`, `display_order INT`, `icon_url STRING`, `is_active BOOLEAN`, `product_count INT`, `created_at TIMESTAMP`, `updated_at TIMESTAMP` |
| `reviews` | `review_id INT`, `product_id INT`, `customer_id INT`, `rating INT`, `title STRING`, `body STRING`, `helpful_votes INT`, `verified_purchase BOOLEAN`, `review_date TIMESTAMP`, `status STRING` |

#### Sales & Marketing Theme (`sales`)

| Table Name | Columns |
|-----------|---------|
| `leads` | `lead_id INT`, `company_name STRING`, `contact_name STRING`, `email STRING`, `phone STRING`, `source STRING`, `status STRING`, `estimated_value DECIMAL(10,2)`, `created_at TIMESTAMP`, `assigned_to STRING` |
| `campaigns` | `campaign_id INT`, `campaign_name STRING`, `channel STRING`, `budget DECIMAL(10,2)`, `spent DECIMAL(10,2)`, `start_date TIMESTAMP`, `end_date TIMESTAMP`, `status STRING`, `target_audience STRING`, `conversion_rate DECIMAL(5,2)` |
| `deals` | `deal_id INT`, `lead_id INT`, `deal_name STRING`, `stage STRING`, `amount DECIMAL(10,2)`, `probability INT`, `close_date TIMESTAMP`, `owner STRING`, `created_at TIMESTAMP`, `notes STRING` |
| `accounts` | `account_id INT`, `account_name STRING`, `industry STRING`, `revenue DECIMAL(12,2)`, `employee_count INT`, `region STRING`, `tier STRING`, `contract_start TIMESTAMP`, `contract_end TIMESTAMP`, `is_active BOOLEAN` |
| `activities` | `activity_id INT`, `deal_id INT`, `activity_type STRING`, `subject STRING`, `description STRING`, `duration_min INT`, `outcome STRING`, `performed_by STRING`, `activity_date TIMESTAMP`, `follow_up_date TIMESTAMP` |

#### IoT / Sensors Theme (`iot`)

| Table Name | Columns |
|-----------|---------|
| `devices` | `device_id INT`, `device_name STRING`, `device_type STRING`, `manufacturer STRING`, `model STRING`, `firmware_version STRING`, `location_id INT`, `status STRING`, `installed_at TIMESTAMP`, `last_seen TIMESTAMP` |
| `readings` | `reading_id INT`, `device_id INT`, `metric_name STRING`, `value DECIMAL(10,4)`, `unit STRING`, `quality STRING`, `reading_time TIMESTAMP`, `batch_id INT`, `is_anomaly BOOLEAN`, `processed_at TIMESTAMP` |
| `alerts` | `alert_id INT`, `device_id INT`, `alert_type STRING`, `severity STRING`, `message STRING`, `threshold_value DECIMAL(10,4)`, `actual_value DECIMAL(10,4)`, `triggered_at TIMESTAMP`, `acknowledged_at TIMESTAMP`, `resolved_at TIMESTAMP` |
| `locations` | `location_id INT`, `location_name STRING`, `building STRING`, `floor INT`, `zone STRING`, `latitude DECIMAL(9,6)`, `longitude DECIMAL(9,6)`, `environment_type STRING`, `capacity INT`, `is_active BOOLEAN` |
| `thresholds` | `threshold_id INT`, `device_type STRING`, `metric_name STRING`, `min_value DECIMAL(10,4)`, `max_value DECIMAL(10,4)`, `warning_level DECIMAL(10,4)`, `critical_level DECIMAL(10,4)`, `unit STRING`, `updated_at TIMESTAMP`, `updated_by STRING` |

#### HR & People Theme (`hr`)

| Table Name | Columns |
|-----------|---------|
| `employees` | `employee_id INT`, `first_name STRING`, `last_name STRING`, `email STRING`, `department_id INT`, `job_title STRING`, `hire_date TIMESTAMP`, `salary DECIMAL(10,2)`, `manager_id INT`, `is_active BOOLEAN` |
| `departments` | `department_id INT`, `department_name STRING`, `manager_id INT`, `budget DECIMAL(12,2)`, `headcount INT`, `location STRING`, `cost_center STRING`, `parent_dept_id INT`, `created_at TIMESTAMP`, `is_active BOOLEAN` |
| `payroll` | `payroll_id INT`, `employee_id INT`, `pay_period STRING`, `base_salary DECIMAL(10,2)`, `bonus DECIMAL(10,2)`, `deductions DECIMAL(10,2)`, `net_pay DECIMAL(10,2)`, `tax_amount DECIMAL(10,2)`, `pay_date TIMESTAMP`, `status STRING` |
| `attendance` | `attendance_id INT`, `employee_id INT`, `date TIMESTAMP`, `check_in TIMESTAMP`, `check_out TIMESTAMP`, `hours_worked DECIMAL(4,2)`, `status STRING`, `overtime_hours DECIMAL(4,2)`, `location STRING`, `notes STRING` |
| `reviews` | `review_id INT`, `employee_id INT`, `reviewer_id INT`, `review_period STRING`, `overall_rating INT`, `goals_met INT`, `goals_total INT`, `strengths STRING`, `improvements STRING`, `review_date TIMESTAMP` |

#### Finance Theme (`finance`)

| Table Name | Columns |
|-----------|---------|
| `transactions` | `transaction_id INT`, `account_id INT`, `transaction_type STRING`, `amount DECIMAL(12,2)`, `currency STRING`, `category STRING`, `description STRING`, `merchant STRING`, `transaction_date TIMESTAMP`, `is_reconciled BOOLEAN` |
| `accounts` | `account_id INT`, `account_name STRING`, `account_type STRING`, `balance DECIMAL(12,2)`, `currency STRING`, `institution STRING`, `routing_number STRING`, `opened_date TIMESTAMP`, `status STRING`, `owner STRING` |
| `invoices` | `invoice_id INT`, `customer_id INT`, `invoice_number STRING`, `amount DECIMAL(12,2)`, `tax_amount DECIMAL(10,2)`, `total DECIMAL(12,2)`, `due_date TIMESTAMP`, `paid_date TIMESTAMP`, `status STRING`, `line_items INT` |
| `payments` | `payment_id INT`, `invoice_id INT`, `amount DECIMAL(12,2)`, `payment_method STRING`, `reference_number STRING`, `payer_name STRING`, `payer_email STRING`, `processed_at TIMESTAMP`, `status STRING`, `notes STRING` |
| `budgets` | `budget_id INT`, `department STRING`, `category STRING`, `fiscal_year INT`, `quarter INT`, `planned_amount DECIMAL(12,2)`, `actual_amount DECIMAL(12,2)`, `variance DECIMAL(12,2)`, `status STRING`, `updated_at TIMESTAMP` |

#### Healthcare Theme (`healthcare`)

| Table Name | Columns |
|-----------|---------|
| `patients` | `patient_id INT`, `first_name STRING`, `last_name STRING`, `date_of_birth TIMESTAMP`, `gender STRING`, `blood_type STRING`, `phone STRING`, `email STRING`, `insurance_id STRING`, `primary_provider_id INT` |
| `appointments` | `appointment_id INT`, `patient_id INT`, `provider_id INT`, `appointment_type STRING`, `scheduled_time TIMESTAMP`, `duration_min INT`, `status STRING`, `location STRING`, `notes STRING`, `created_at TIMESTAMP` |
| `prescriptions` | `prescription_id INT`, `patient_id INT`, `provider_id INT`, `medication_name STRING`, `dosage STRING`, `frequency STRING`, `start_date TIMESTAMP`, `end_date TIMESTAMP`, `refills_remaining INT`, `is_active BOOLEAN` |
| `labs` | `lab_id INT`, `patient_id INT`, `test_name STRING`, `test_code STRING`, `result_value DECIMAL(10,4)`, `unit STRING`, `reference_range STRING`, `status STRING`, `ordered_date TIMESTAMP`, `result_date TIMESTAMP` |
| `providers` | `provider_id INT`, `first_name STRING`, `last_name STRING`, `specialty STRING`, `npi_number STRING`, `phone STRING`, `email STRING`, `department STRING`, `hire_date TIMESTAMP`, `is_accepting_patients BOOLEAN` |

### 10.5 Generic Fallback Template

When a node's name does NOT match any known table in the selected theme, use this generic template:

```javascript
const GENERIC_COLUMNS = [
  { name: 'id',          sqlType: 'INT',            pysparkType: 'IntegerType',   nullable: false },
  { name: 'name',        sqlType: 'STRING',         pysparkType: 'StringType',    nullable: true  },
  { name: 'value',       sqlType: 'DECIMAL(10,2)',  pysparkType: 'DecimalType',   nullable: true  },
  { name: 'category',    sqlType: 'STRING',         pysparkType: 'StringType',    nullable: true  },
  { name: 'status',      sqlType: 'STRING',         pysparkType: 'StringType',    nullable: true  },
  { name: 'created_at',  sqlType: 'TIMESTAMP',      pysparkType: 'TimestampType', nullable: true  },
  { name: 'updated_at',  sqlType: 'TIMESTAMP',      pysparkType: 'TimestampType', nullable: true  },
  { name: 'description', sqlType: 'STRING',         pysparkType: 'StringType',    nullable: true  },
  { name: 'is_active',   sqlType: 'BOOLEAN',        pysparkType: 'BooleanType',   nullable: true  },
  { name: 'tags',        sqlType: 'STRING',         pysparkType: 'StringType',    nullable: true  },
];

const GENERIC_SAMPLE_DATA = [
  [1, 'item_alpha',    100.00, 'primary',   'active',    '2024-01-01T00:00:00', '2024-01-15T10:30:00', 'First item',     true,  'a,b'],
  [2, 'item_beta',     250.50, 'secondary', 'active',    '2024-01-02T00:00:00', '2024-01-16T11:00:00', 'Second item',    true,  'b,c'],
  [3, 'item_gamma',    75.25,  'primary',   'inactive',  '2024-01-03T00:00:00', '2024-01-17T09:15:00', 'Third item',     false, 'a'],
  [4, 'item_delta',    420.00, 'tertiary',  'active',    '2024-01-04T00:00:00', '2024-01-18T14:20:00', 'Fourth item',    true,  'c,d'],
  [5, 'item_epsilon',  33.99,  'primary',   'pending',   '2024-01-05T00:00:00', '2024-01-19T08:00:00', 'Fifth item',     true,  'a,b,c'],
  [6, 'item_zeta',     189.75, 'secondary', 'active',    '2024-01-06T00:00:00', '2024-01-20T16:30:00', 'Sixth item',     true,  'd'],
  [7, 'item_eta',      55.00,  'tertiary',  'cancelled', '2024-01-07T00:00:00', '2024-01-21T10:00:00', 'Seventh item',   false, 'b'],
  [8, 'item_theta',    310.25, 'primary',   'active',    '2024-01-08T00:00:00', '2024-01-22T13:45:00', 'Eighth item',    true,  'a,c'],
  [9, 'item_iota',     67.50,  'secondary', 'active',    '2024-01-09T00:00:00', '2024-01-23T11:30:00', 'Ninth item',     true,  'b,d'],
  [10,'item_kappa',    145.00, 'tertiary',  'pending',   '2024-01-10T00:00:00', '2024-01-24T15:00:00', 'Tenth item',     true,  'a'],
];
```

### 10.6 DOM Structure

```html
<div class="code-panel" id="codePanel" role="complementary" aria-label="Code Preview Panel" aria-expanded="true">
  <!-- Resize handle (left edge) -->
  <div class="code-panel-resize" id="codePanelResize"></div>

  <!-- Header -->
  <div class="code-panel-header" role="toolbar" aria-label="Code preview controls">
    <span class="code-panel-title" id="codePanelTitle">
      Code Preview
      <!-- Stale badge (hidden by default) -->
      <span class="stale-badge" id="staleBadge" hidden>Stale</span>
    </span>
    <div class="code-panel-actions">
      <button class="code-panel-btn" id="refreshBtn" aria-label="Refresh code preview" title="Refresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
          <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
        </svg>
      </button>
      <button class="code-panel-btn" id="copyBtn" aria-label="Copy code to clipboard" title="Copy" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>
    </div>
  </div>

  <!-- Code body -->
  <div class="code-panel-body" id="codePanelBody">
    <!-- Line numbers gutter -->
    <div class="code-gutter" id="codeGutter" aria-hidden="true">
      <!-- Generated: <div class="code-gutter-line">1</div> per line -->
    </div>

    <!-- Code content -->
    <div class="code-content" id="codeContent" role="region" aria-label="Generated code preview" tabindex="0">
      <pre class="code-block" id="codeBlock" role="textbox" aria-readonly="true" aria-multiline="true">
        <!-- Generated: syntax-highlighted HTML -->
      </pre>
    </div>
  </div>

  <!-- Placeholder (shown when no code generated) -->
  <div class="code-panel-placeholder" id="codePlaceholder">
    <div class="code-panel-placeholder-icon">{ }</div>
    <div>Click <strong>Refresh</strong> to generate<br>code preview from your DAG.</div>
  </div>

  <!-- Error (shown on generation failure) -->
  <div class="code-panel-error" id="codeError" hidden>
    <div class="code-panel-error-icon">✕</div>
    <div class="code-panel-error-title">Generation Failed</div>
    <div class="code-panel-error-msg" id="codeErrorMsg"></div>
    <button class="code-panel-btn" id="retryBtn" aria-label="Retry code generation">Retry</button>
  </div>
</div>

<!-- Toggle button (positioned outside panel, inside dag-canvas-wrapper) -->
<button class="code-panel-toggle" id="codePanelToggle"
        aria-label="Toggle code preview panel"
        aria-expanded="true"
        aria-controls="codePanel"
        title="Toggle code preview">◂</button>
```

### 10.7 File Structure

```
src/frontend/js/
  infra-wizard/
    code-preview-panel.js    ← Main class (C08)
    code-generator.js        ← Code generation engine (topological sort + templates)
    syntax-highlighter.js    ← Tokenizer + HTML renderer
    theme-data-registry.js   ← Theme sample data definitions (all 6 themes)

src/frontend/css/
  infra-wizard/
    code-preview-panel.css   ← All panel styles (or inlined via build)
```

### 10.8 Class Skeleton

```javascript
// code-preview-panel.js

class CodePreviewPanel {
  /** @type {HTMLElement} */ _el;
  /** @type {HTMLElement} */ _toggleEl;
  /** @type {HTMLElement} */ _codeBlockEl;
  /** @type {HTMLElement} */ _gutterEl;
  /** @type {HTMLElement} */ _placeholderEl;
  /** @type {HTMLElement} */ _errorEl;
  /** @type {HTMLElement} */ _refreshBtn;
  /** @type {HTMLElement} */ _copyBtn;
  /** @type {HTMLElement} */ _staleBadge;
  /** @type {HTMLElement} */ _resizeHandle;

  /** @type {CodePreviewPanelState} */ _state;
  /** @type {Function} */ _getDagTopology;
  /** @type {Function} */ _getThemeConfig;
  /** @type {Map<string, object>} */ _sampleDataCache;

  // Callbacks
  /** @type {Function|null} */ onToggle = null;
  /** @type {Function|null} */ onRefresh = null;
  /** @type {Function|null} */ onCopy = null;
  /** @type {Function|null} */ onError = null;

  constructor(containerEl, options) {
    this._getDagTopology = options.getDagTopology;
    this._getThemeConfig = options.getThemeConfig;
    this._sampleDataCache = new Map();
    this._state = {
      panelState: 'expanded',
      panelWidth: 280,
      isResizing: false,
      generatedCode: '',
      highlightedHtml: '',
      lineCount: 0,
      scrollTop: 0,
      generationStatus: 'idle',
      generationError: null,
      lastGeneratedAt: null,
      isStale: false,
    };
  }

  init() {
    this._createDOM();
    this._attachListeners();
    this._render();
  }

  expand() {
    this._state.panelState = 'expanded';
    this._el.classList.remove('collapsed');
    this._toggleEl.innerHTML = '◂';
    this._toggleEl.classList.remove('collapsed-pos');
    this._toggleEl.style.right = `${this._state.panelWidth}px`;
    this._toggleEl.setAttribute('aria-expanded', 'true');
    this._el.setAttribute('aria-expanded', 'true');
    if (this.onToggle) this.onToggle(true);
  }

  collapse() {
    this._state.scrollTop = this._el.querySelector('.code-panel-body')?.scrollTop ?? 0;
    this._state.panelState = 'collapsed';
    this._el.classList.add('collapsed');
    this._toggleEl.innerHTML = '▸';
    this._toggleEl.classList.add('collapsed-pos');
    this._toggleEl.style.right = '0';
    this._toggleEl.setAttribute('aria-expanded', 'false');
    this._el.setAttribute('aria-expanded', 'false');
    if (this.onToggle) this.onToggle(false);
  }

  toggle() {
    if (this._state.panelState === 'expanded') {
      this.collapse();
    } else {
      this.expand();
    }
  }

  refresh() {
    this._state.generationStatus = 'generating';
    this._state.isStale = false;
    this._renderRefreshState();

    try {
      const topology = this._getDagTopology();
      const themeConfig = this._getThemeConfig();
      const { code, cells } = generateCode(topology, themeConfig, this._sampleDataCache);
      const { html, lineCount } = highlightCode(code);

      this._state.generatedCode = code;
      this._state.highlightedHtml = html;
      this._state.lineCount = lineCount;
      this._state.generationStatus = 'idle';
      this._state.generationError = null;
      this._state.lastGeneratedAt = Date.now();
      this._cells = cells;

      this._renderCode();
      if (this.onRefresh) this.onRefresh(cells.length);
    } catch (err) {
      this._state.generationStatus = 'error';
      this._state.generationError = err.message;
      this._renderError();
      if (this.onError) this.onError(err.message);
    }
  }

  async copyToClipboard() { /* see §8.3 */ }

  getGeneratedCode() { return this._state.generatedCode; }

  getGeneratedCells() { return this._cells || []; }

  isExpanded() { return this._state.panelState === 'expanded'; }

  markStale() {
    this._state.isStale = true;
    this._staleBadge.hidden = false;
    this._refreshBtn.classList.add('stale-pulse');
  }

  setWidth(px) {
    this._state.panelWidth = Math.max(220, Math.min(480, px));
    this._el.style.width = `${this._state.panelWidth}px`;
    if (this._state.panelState === 'expanded') {
      this._toggleEl.style.right = `${this._state.panelWidth}px`;
    }
  }

  getWidth() { return this._state.panelWidth; }

  destroy() {
    this._detachListeners();
    this._el.remove();
    this._toggleEl.remove();
  }

  // --- Private methods ---
  _createDOM() { /* see §10.6 */ }
  _attachListeners() { /* toggle, refresh, copy, resize handle */ }
  _detachListeners() { /* cleanup */ }
  _render() { /* initial render */ }
  _renderCode() { /* update code body + line numbers */ }
  _renderLineNumbers(count) { /* generate gutter divs */ }
  _renderRefreshState() { /* spinner on refresh btn */ }
  _renderError() { /* show error, hide code */ }
  _restoreScrollPosition() { /* restore after refresh */ }

  // Resize handlers
  _onResizeStart(e) { /* mousedown on handle */ }
  _onResizeMove(e) { /* mousemove during drag */ }
  _onResizeEnd(e) { /* mouseup */ }
}
```

### 10.9 Integration Wiring

```javascript
// In InfraWizardDialog (C1), during Page 3 initialization:

const codePreviewPanel = new CodePreviewPanel(
  document.querySelector('.dag-layout'),
  {
    getDagTopology: () => dagCanvas.getTopology(),
    getThemeConfig: () => themeSchemaPage.getConfig(),
  }
);
codePreviewPanel.init();

// Wire topology change notifications
dagCanvas.onTopologyChange = () => {
  codePreviewPanel.markStale();
};

// Wire panel toggle to canvas viewport adjustment
codePreviewPanel.onToggle = (isExpanded) => {
  dagCanvas.adjustViewport(isExpanded ? codePreviewPanel.getWidth() : 0);
};

// Auto-refresh when entering Page 3
wizardDialog.onPageActivate = (pageIndex) => {
  if (pageIndex === 2) {
    codePreviewPanel.refresh();
  }
};

// ReviewSummary (C9) reads from panel
const cells = codePreviewPanel.getGeneratedCells();
const code = codePreviewPanel.getGeneratedCode();
```

### 10.10 Testing Strategy

| Test Category | Test Cases | Priority |
|--------------|------------|----------|
| **Topological sort** | Empty graph, single node, linear chain (A→B→C), diamond (A→B,C→D), wide fan-out, wide fan-in, multiple roots, cycle detection | P0 |
| **Code generation — SQL Table** | All 6 themes × 5 tables = 30 test cases for correct columns + sample data | P0 |
| **Code generation — SQL MLV** | Single parent, 2 parents (JOIN), 3+ parents, cross-schema references | P0 |
| **Code generation — PySpark MLV** | Single parent, multiple parents, correct imports, decorator syntax | P0 |
| **Pip install conditional** | Present when PySpark MLV exists, absent when only SQL nodes | P0 |
| **Cell ordering** | Topological correctness across all DAG shapes | P0 |
| **`MATERIALIZED LAKE VIEW`** | Must be `LAKE VIEW`, never just `VIEW` — regression test | P0 |
| **Syntax highlighting** | All token types produce correct CSS classes | P1 |
| **Panel toggle** | Expand, collapse, remembers state across page navigation | P1 |
| **Panel resize** | Min/max clamping, live update, persists width | P1 |
| **Copy to clipboard** | Success path, fallback path, empty code guard | P1 |
| **Stale indicator** | Appears on topology change, clears on refresh | P1 |
| **Edge cases** | 100 nodes, node with empty name, node with special characters in name | P2 |
| **Performance** | 100-node generation under 50ms, highlighting under 40ms | P2 |
| **A11y** | Screen reader announcements, keyboard navigation, focus management | P2 |

### 10.11 Dependencies

| Dependency | Type | Direction | Notes |
|-----------|------|-----------|-------|
| DagCanvas (C4) | Runtime | C4 → C8 | Provides `getTopology()`, calls `markStale()` |
| DagNode (C6) | Data | C6 → C8 | Node data model (name, type, schema) |
| ConnectionManager (C7) | Data | C7 → C8 | Edge data model (source, target) |
| ThemeSchemaPage (C3) | Data | C3 → C8 | Theme ID, enabled schemas |
| InfraWizardDialog (C1) | Lifecycle | C1 → C8 | Page activation, destroy on wizard close |
| ReviewSummary (C9) | Consumer | C8 → C9 | Reads `getGeneratedCells()` for summary |
| ExecutionPipeline (C10) | Consumer | C8 → C10 | Reads `getGeneratedCells()` for notebook API |
| UndoRedoManager (C14) | Notification | C14 → C8 | Undo/redo triggers `markStale()` |

### 10.12 Open Questions (Resolved)

| # | Question | Resolution | Rationale |
|---|----------|-----------|-----------|
| Q1 | Auto-refresh vs. manual refresh? | **Manual (on-demand).** | Spec §3 explicitly says "Updates on demand (refresh button, NOT real-time)." Prevents jank during rapid DAG editing. |
| Q2 | Panel position: right side or bottom? | **Right side.** | Mock shows right-side panel. Right-side preserves horizontal canvas space for left-to-right DAG flow. |
| Q3 | Should code be editable? | **No.** | Spec §14 explicitly lists "Custom code editing" as a non-goal for V1. |
| Q4 | Should we use a code editor library (CodeMirror, Monaco)? | **No.** | ADR-002 (vanilla JS only). Our syntax highlighting needs are simple (read-only, one-way rendering). A 100KB+ editor library is overkill. |
| Q5 | How to handle theme mismatch (node name doesn't match theme tables)? | **Generic fallback template.** | §10.5 defines a 10-column generic schema used when node names don't match any known theme table. |
| Q6 | PySpark MLV with multiple parents — JOIN or spark.sql? | **spark.sql() reads.** | PySpark doesn't have natural JOIN syntax like SQL. Reading parent tables via `spark.sql()` is the idiomatic Fabric pattern. |
| Q7 | Line numbers: absolute or per-cell? | **Absolute (continuous 1-N).** | Consistent with VS Code / notebook conventions. Easier to reference in error messages. |

### 10.13 Risks & Mitigations

| Risk | Severity | Probability | Mitigation |
|------|----------|------------|------------|
| `CREATE MATERIALIZED LAKE VIEW` typo as `MATERIALIZED VIEW` | HIGH | MEDIUM | Automated regression test, string constant (never inline) |
| Theme data doesn't match real Fabric table schemas | LOW | HIGH | Theme data is sample/demo — not production schemas |
| Topological sort performance on 100-node graph | LOW | LOW | Kahn's algorithm is O(V+E), trivial at 100 nodes |
| Generated code exceeds notebook cell size limits | MEDIUM | LOW | Fabric notebook cells support large content; 10-row inserts are small |
| Browser clipboard API blocked in iframe/insecure context | MEDIUM | MEDIUM | Fallback to `document.execCommand('copy')` (see §8.3) |
| Font rendering differs across OS (JetBrains Mono fallback) | LOW | MEDIUM | Font stack includes Cascadia Code, Consolas as fallbacks |

---

## Appendix A: Complete Generated Code Example

For the mock DAG (3 SQL tables + 2 SQL MLVs + 1 PySpark MLV, E-Commerce theme):

```
-- ═══════════════════════════════════════════════
-- Cell 0: pip install (PySpark dependency)
-- ═══════════════════════════════════════════════
!pip install fmlv

-- ═══════════════════════════════════════════════
-- Cell 1: orders (SQL Table) [bronze]
-- ═══════════════════════════════════════════════
%%sql
CREATE TABLE IF NOT EXISTS bronze.orders (
    order_id INT,
    customer_id INT,
    product_id INT,
    quantity INT,
    unit_price DECIMAL(10,2),
    total_amount DECIMAL(10,2),
    order_date TIMESTAMP,
    status STRING,
    shipping_address STRING,
    payment_method STRING
);

INSERT INTO bronze.orders VALUES
    (1001, 1, 101, 2, 29.99, 59.98, '2024-01-15T10:30:00', 'completed', '123 Main St, Seattle, WA', 'credit_card'),
    (1002, 2, 102, 1, 49.99, 49.99, '2024-01-15T11:45:00', 'completed', '456 Oak Ave, Portland, OR', 'paypal'),
    (1003, 3, 103, 3, 15.50, 46.50, '2024-01-16T09:15:00', 'processing', '789 Pine Rd, San Francisco, CA', 'credit_card'),
    (1004, 1, 104, 1, 199.99, 199.99, '2024-01-16T14:20:00', 'shipped', '123 Main St, Seattle, WA', 'debit_card'),
    (1005, 4, 101, 5, 29.99, 149.95, '2024-01-17T08:00:00', 'completed', '321 Elm Blvd, Denver, CO', 'credit_card'),
    (1006, 5, 105, 2, 74.99, 149.98, '2024-01-17T16:30:00', 'cancelled', '654 Birch Ln, Austin, TX', 'paypal'),
    (1007, 2, 103, 1, 15.50, 15.50, '2024-01-18T10:00:00', 'completed', '456 Oak Ave, Portland, OR', 'credit_card'),
    (1008, 6, 106, 4, 12.99, 51.96, '2024-01-18T13:45:00', 'processing', '987 Cedar Dr, Chicago, IL', 'debit_card'),
    (1009, 3, 102, 2, 49.99, 99.98, '2024-01-19T11:30:00', 'shipped', '789 Pine Rd, San Francisco, CA', 'credit_card'),
    (1010, 7, 107, 1, 89.99, 89.99, '2024-01-19T15:00:00', 'completed', '135 Maple Way, Boston, MA', 'paypal');

-- ═══════════════════════════════════════════════
-- Cell 2: customers (SQL Table) [bronze]
-- ═══════════════════════════════════════════════
%%sql
CREATE TABLE IF NOT EXISTS bronze.customers (
    customer_id INT,
    name STRING,
    email STRING,
    phone STRING,
    address STRING,
    city STRING,
    state STRING,
    tier STRING,
    signup_date TIMESTAMP,
    is_active BOOLEAN
);

INSERT INTO bronze.customers VALUES
    (1, 'Alice Johnson', 'alice@example.com', '555-0101', '123 Main St', 'Seattle', 'WA', 'gold', '2023-06-15T00:00:00', true),
    (2, 'Bob Smith', 'bob@example.com', '555-0102', '456 Oak Ave', 'Portland', 'OR', 'silver', '2023-07-20T00:00:00', true),
    (3, 'Carol Davis', 'carol@example.com', '555-0103', '789 Pine Rd', 'San Francisco', 'CA', 'gold', '2023-08-10T00:00:00', true),
    (4, 'David Wilson', 'david@example.com', '555-0104', '321 Elm Blvd', 'Denver', 'CO', 'bronze', '2023-09-05T00:00:00', true),
    (5, 'Eva Martinez', 'eva@example.com', '555-0105', '654 Birch Ln', 'Austin', 'TX', 'silver', '2023-10-01T00:00:00', false),
    (6, 'Frank Brown', 'frank@example.com', '555-0106', '987 Cedar Dr', 'Chicago', 'IL', 'bronze', '2023-11-12T00:00:00', true),
    (7, 'Grace Lee', 'grace@example.com', '555-0107', '135 Maple Way', 'Boston', 'MA', 'gold', '2023-12-08T00:00:00', true),
    (8, 'Henry Kim', 'henry@example.com', '555-0108', '246 Walnut Ct', 'Miami', 'FL', 'silver', '2024-01-03T00:00:00', true),
    (9, 'Iris Chen', 'iris@example.com', '555-0109', '579 Spruce Ave', 'New York', 'NY', 'bronze', '2024-01-10T00:00:00', true),
    (10, 'Jack Taylor', 'jack@example.com', '555-0110', '802 Ash Blvd', 'Los Angeles', 'CA', 'gold', '2024-01-14T00:00:00', true);

-- ═══════════════════════════════════════════════
-- Cell 3: products (SQL Table) [bronze]
-- ═══════════════════════════════════════════════
%%sql
CREATE TABLE IF NOT EXISTS bronze.products (
    product_id INT,
    product_name STRING,
    category STRING,
    brand STRING,
    unit_price DECIMAL(10,2),
    stock_quantity INT,
    weight DECIMAL(5,2),
    rating DECIMAL(2,1),
    created_at TIMESTAMP,
    is_available BOOLEAN
);

INSERT INTO bronze.products VALUES
    (101, 'Wireless Headphones', 'Electronics', 'AudioMax', 29.99, 500, 0.35, 4.5, '2023-01-10T00:00:00', true),
    (102, 'Smart Watch', 'Electronics', 'TechWear', 49.99, 300, 0.12, 4.2, '2023-02-15T00:00:00', true),
    (103, 'USB-C Cable 3-Pack', 'Accessories', 'ConnectPro', 15.50, 2000, 0.15, 4.7, '2023-03-01T00:00:00', true),
    (104, 'Bluetooth Speaker', 'Electronics', 'SoundBlast', 199.99, 150, 1.20, 4.8, '2023-04-20T00:00:00', true),
    (105, 'Laptop Stand', 'Accessories', 'ErgoPro', 74.99, 400, 2.50, 4.3, '2023-05-05T00:00:00', true),
    (106, 'Phone Case', 'Accessories', 'ShieldMax', 12.99, 5000, 0.05, 4.1, '2023-06-12T00:00:00', true),
    (107, 'Mechanical Keyboard', 'Electronics', 'KeyCraft', 89.99, 250, 0.90, 4.6, '2023-07-18T00:00:00', true),
    (108, 'Webcam HD', 'Electronics', 'ClearView', 45.00, 350, 0.20, 4.0, '2023-08-22T00:00:00', false),
    (109, 'Desk Organizer', 'Office', 'NeatDesk', 34.99, 600, 1.80, 3.9, '2023-09-30T00:00:00', true),
    (110, 'Wireless Mouse', 'Electronics', 'ClickPro', 24.99, 800, 0.10, 4.4, '2023-10-15T00:00:00', true);

-- ═══════════════════════════════════════════════
-- Cell 4: order_summary (SQL MLV) [silver]
-- ═══════════════════════════════════════════════
%%sql
CREATE MATERIALIZED LAKE VIEW silver.order_summary AS
SELECT o.order_id, o.total_amount, o.order_date, o.status,
       c.name AS customer_name, c.email AS customer_email, c.tier AS customer_tier
FROM bronze.orders o
JOIN bronze.customers c
    ON o.customer_id = c.customer_id;

-- ═══════════════════════════════════════════════
-- Cell 5: product_metrics (SQL MLV) [silver]
-- ═══════════════════════════════════════════════
%%sql
CREATE MATERIALIZED LAKE VIEW silver.product_metrics AS
SELECT *
FROM bronze.products;

-- ═══════════════════════════════════════════════
-- Cell 6: customer_360 (PySpark MLV) [gold]
-- ═══════════════════════════════════════════════
import fmlv
from pyspark.sql.types import StructType, StructField, IntegerType, StringType, DecimalType, TimestampType
from datetime import datetime
from decimal import Decimal

@fmlv.materialized_lake_view(name="gold.customer_360")
def customer_360():
    # Read from parent tables
    order_summary = spark.sql("SELECT * FROM silver.order_summary")
    product_metrics = spark.sql("SELECT * FROM silver.product_metrics")

    # Join parent data
    df = order_summary.join(
        product_metrics,
        on="product_id",
        how="inner"
    )
    return df
```

---

## Appendix B: Token Highlighting Visual Reference

Rendered appearance of the code preview with token classes applied:

```
Line   │ Code (color-coded)
───────┼──────────────────────────────────────────────────────
  1    │ [div]-- ═══════════════════════════════════════════════[/div]
  2    │ [cm]-- Cell 1: orders (SQL Table) [bronze][/cm]
  3    │ [div]-- ═══════════════════════════════════════════════[/div]
  4    │ [kw]%%sql[/kw]
  5    │ [kw]CREATE TABLE IF NOT EXISTS[/kw] bronze.orders (
  6    │     order_id [type]INT[/type],
  7    │     customer_id [type]INT[/type],
  8    │     total_amount [type]DECIMAL[/type]([num]10[/num],[num]2[/num]),
  9    │     order_date [type]TIMESTAMP[/type],
 10    │     status [type]STRING[/type]
 11    │ );
 12    │
 13    │ [kw]INSERT INTO[/kw] bronze.orders [kw]VALUES[/kw]
 14    │     ([num]1001[/num], [num]1[/num], [str]'completed'[/str], [str]'2024-01-15T10:30:00'[/str]),
 15    │     ...
```

Token legend:
- `[kw]` = `.tok-kw` (accent purple, weight 500)
- `[type]` = `.tok-type` (blue)
- `[str]` = `.tok-str` (green)
- `[cm]` = `.tok-cm` (muted, italic)
- `[div]` = `.tok-div` (border color, non-italic)
- `[num]` = `.tok-num` (red)
- `[dec]` = `.tok-dec` (amber, weight 500)
- `[fn]` = `.tok-fn` (blue)

---

*Spec complete. Total coverage: panel chrome, code generation for all 3 node types with all variants, topological sort algorithm, syntax highlighting tokenizer, resize/collapse animations, accessibility, error handling, performance budgets, and full integration API.*
