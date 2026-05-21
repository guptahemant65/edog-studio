# F16 Import from Lakehouse — Design Spec

**Date:** 2026-05-21
**Author:** Sana (architecture) + Pixel (frontend)
**Feature:** F16 — Environment Wizard, DAG Canvas (Page 2)

---

## 1. Problem

Users with existing lakehouses (tables, MLVs, schemas) must manually recreate
their topology node by node in the wizard. There's no way to say "I already
have this lakehouse — build the DAG from what's there."

## 2. Solution

A new preset card "Import from Lakehouse" that:
1. Opens a workspace/lakehouse browser
2. Fetches the lakehouse's tables + metadata
3. Shows a cherry-pick checklist with auto-detected types and schemas
4. Imports selected tables as DAG nodes with connections replicated from
   actual MLV `sourceEntities` metadata

## 3. Data Available from Fabric APIs

| API | Returns | Used For |
|-----|---------|----------|
| `listWorkspaces()` | All accessible workspaces | Workspace picker |
| `listTables(wsId, lhId)` | Table list with names | Basic table listing |
| `listTablesViaCapacity(wsId, lhId, capId)` | Tables with schema info | Schema-enabled lakehouses |
| **`getLatestDag()`** | **Full DAG: nodes + dependencies + types in one call** | **Primary source for import** |
| `listLakehouses(wsId)` | Lakehouses in a workspace | Lakehouse picker |

### Key insight: `getLatestDag()` has everything

The FLT API `/liveTable/getLatestDag?showExtendedLineage=true` returns:
```js
{
  nodes: [  // or nodeDefinitions / dagNodes
    {
      name: "slv_orders_clean",
      type: "SqlMaterializedView",   // or nodeType / NodeType
      dependencies: ["raw_orders", "raw_customers"],  // upstream connections!
      // ... schema, refreshMode, etc.
    },
    ...
  ]
}
```

Each node has `dependencies` (or `inputNodes`) — the actual upstream node
names. This gives us the ENTIRE connection graph in one call. No need to
fetch per-table metadata.

The control-panel already parses this flexibly (see `control-panel.js:241-263`):
- `nodes` / `nodeDefinitions` / `dagNodes` / `Nodes`
- `dependencies` / `Dependencies` / `inputNodes` / `InputNodes`
- `type` / `Type` / `nodeType` / `NodeType`

### Fallback: table listing

`getLatestDag()` requires an FLT-connected lakehouse (has the MWC token).
For lakehouses without FLT running, fall back to `listTables()` + 
`listTablesViaCapacity()` for node discovery (no connections in this case).

## 4. Connection Replication Strategy

**Primary (FLT connected):** Parse `getLatestDag()` response. Each node's
`dependencies` array contains the names of upstream nodes. For each 
dependency that maps to an imported node, create a connection.

**Fallback (no FLT):** Use `getTableMetadata()` per MLV which returns
`sourceEntities`. Slower (N API calls vs 1) but works without FLT.

## 4. UI Flow

### 4.1 Preset Card

New card in the preset overlay grid:

```
┌──────────────────────┐
│  [↓ import icon]     │
│                      │
│  Import from         │
│  Lakehouse           │
│                      │
│  Replicate an        │
│  existing topology   │
│                      │
│  [Browse...]         │
└──────────────────────┘
```

Badge: "Advanced". Clicking it opens the import dialog.

### 4.2 Import Dialog (3 steps)

Rendered as an inline panel that replaces the preset overlay (same space,
same dismiss behavior).

**Step 1: Pick Lakehouse**
```
┌─────────────────────────────────────────────┐
│ Import from Lakehouse                   [✕] │
├─────────────────────────────────────────────┤
│ Workspace:  [ Select workspace...     ▾ ]   │
│ Lakehouse:  [ Select lakehouse...     ▾ ]   │
│                                             │
│                          [ Next → ]         │
└─────────────────────────────────────────────┘
```

- Workspace dropdown: populated from `listWorkspaces()`
- Lakehouse dropdown: populated from listing lakehouses in selected workspace
- Both async with loading spinners

**Step 2: Select Tables**
```
┌─────────────────────────────────────────────┐
│ Import from Lakehouse              [← Back] │
├─────────────────────────────────────────────┤
│ Found 12 tables in "sales_lakehouse"        │
│                                             │
│ [✓] Select All                              │
│                                             │
│ Schema: bronze (3)                          │
│   [✓] ◇ raw_orders         table            │
│   [✓] ◇ raw_customers      table            │
│   [ ] ◇ raw_products       table            │
│                                             │
│ Schema: silver (4)                          │
│   [✓] ◆ orders_clean       sql-mlv          │
│   [✓] ◆ customers_clean    sql-mlv          │
│   [ ] ◆ products_clean     sql-mlv          │
│   [ ] ◆ inventory_agg      sql-mlv          │
│                                             │
│ Schema: gold (2)                            │
│   [✓] ◆ revenue_metrics    pyspark-mlv      │
│   [ ] ◆ exec_dashboard     sql-mlv          │
│                                             │
│              [ Import 6 selected ]          │
└─────────────────────────────────────────────┘
```

- Grouped by schema
- Type auto-detected: tables with `sourceEntities`/`viewText` = MLV, otherwise = sql-table
- PySpark detection: if metadata indicates PySpark language → pyspark-mlv
- Checkboxes for each table
- "Select All" toggle
- Import button shows count

**Step 3: Import executes** (no separate UI — happens on click)
- Creates nodes for each selected table
- Fetches metadata for each MLV to get `sourceEntities`
- Creates connections based on `sourceEntities`
- Auto-layouts the result
- Dismisses the import panel
- Shows toast: "Imported 6 tables with 4 connections"

## 5. Node Type Detection

**From `getLatestDag()` response (primary):**

| DAG node `type` field | Canvas Node Type |
|----------------------|-----------------|
| `SqlMaterializedView` / `sql_materialized_view` | `sql-mlv` |
| `PySparkMaterializedView` / `pyspark_materialized_view` | `pyspark-mlv` |
| `Table` / `Source` / `sql_table` / unknown | `sql-table` |

**From `getTableMetadata()` fallback:**

| Metadata Signal | Node Type |
|-----------------|-----------|
| Has `sourceEntities` + `viewText` | `sql-mlv` |
| Has `sourceEntities` + PySpark indicator | `pyspark-mlv` |
| Has `allColumns` but no `sourceEntities` | `sql-table` |
| Metadata unavailable | `sql-table` (default) |

## 6. Connection Replication

**Primary path (FLT connected):**
1. Call `getLatestDag()` — returns all nodes with `dependencies` arrays
2. For each node, `dependencies` lists upstream node names
3. If both the node AND its dependency were imported → create connection
4. One API call. Zero per-node fetching.

**Fallback path (no FLT):**
1. For each imported MLV, call `getTableMetadata(wsId, lhId, schema, name)`
2. Read `sourceEntities` array (e.g., `["bronze.raw_orders"]`)
3. Parse `schema.tableName`, match to imported nodes → create connection
4. N API calls (one per MLV). Slower but works without FLT running.

**Resolution rules:**
| Scenario | Behavior |
|----------|----------|
| Dependency maps to imported node | Connection created |
| Dependency NOT imported | Silently skipped |
| Dependency in different lakehouse | Skipped (cross-LH not supported) |
| Circular reference | Ignored (canvas has cycle prevention) |
| Empty/missing dependencies | No connections for this node |

## 7. State Matrix

| # | State | Import Dialog | Preset Overlay | Canvas |
|---|-------|--------------|----------------|--------|
| I0 | Initial | Hidden | Visible | Empty |
| I1 | Card clicked | Step 1 visible | Hidden | Empty |
| I2 | Workspace selected | Step 1 (LH loading) | Hidden | Empty |
| I3 | Lakehouse selected | Step 1 (Next enabled) | Hidden | Empty |
| I4 | Tables loading | Step 2 (spinner) | Hidden | Empty |
| I5 | Tables listed | Step 2 (checklist) | Hidden | Empty |
| I6 | Importing | Step 2 (progress) | Hidden | Empty |
| I7 | Done | Dismissed | Dismissed | Populated |
| IX | Cancelled (✕) | Dismissed | Visible (if empty) | Unchanged |

### Transitions
```
I0 ──[click Import card]──→ I1
I1 ──[select workspace]──→ I2
I2 ──[lakehouses loaded, select one]──→ I3
I3 ──[click Next]──→ I4
I4 ──[tables loaded]──→ I5
I5 ──[click Import N]──→ I6
I6 ──[done]──→ I7
I* ──[click ✕ or Back to I0]──→ IX
IX ──[canvas empty]──→ I0 (preset overlay reappears)
```

## 8. Edge Cases

### 8.1 API/Network Errors

| Scenario | Behavior |
|----------|----------|
| `listWorkspaces()` fails | Show error in dropdown: "Failed to load workspaces" |
| `listLakehouses()` fails | Show error in LH dropdown, workspace remains selected |
| `listTables()` fails | Show error message in step 2 area, Back button works |
| `getTableMetadata()` fails for one table | Skip that table's connections, import node anyway |
| Auth expired mid-flow | Show "Session expired" toast, dialog stays open for retry |

### 8.2 Empty/Edge States

| Scenario | Behavior |
|----------|----------|
| Workspace has 0 lakehouses | Dropdown shows "No lakehouses found" |
| Lakehouse has 0 tables | Step 2 shows "This lakehouse has no tables" |
| User selects 0 tables | Import button disabled |
| All tables are MLVs (no source tables) | Import works, no connections (no sources to connect from) |
| Import would exceed 100 node limit | Clamp: "Can import 12 of 18 selected (88 slots available)" |

### 8.3 Duplicate Handling

| Scenario | Behavior |
|----------|----------|
| Canvas already has a node named "raw_orders" | Skip duplicate, import others, toast: "Skipped 1 duplicate" |
| Import same lakehouse twice | Second import skips all existing names |

### 8.4 Schema-Enabled vs Non-Schema Lakehouses

| Lakehouse Type | Behavior |
|---------------|----------|
| Schema-enabled (bronze/silver/gold) | Use `listTablesViaCapacity()`, group by actual schema |
| Non-schema (dbo only) | Use `listTables()`, all under "dbo" group |

### 8.5 Connection Resolution

| Scenario | Behavior |
|----------|----------|
| MLV sources table that's imported | Connection created |
| MLV sources table that's NOT imported | Silently skipped |
| MLV sources table in different lakehouse | Skipped (cross-LH references not supported) |
| Circular reference in sourceEntities | Ignored (canvas already has cycle prevention) |
| sourceEntities is empty or missing | No connections for this node |

## 9. Performance

| Concern | Mitigation |
|---------|-----------|
| Listing 500+ tables in large lakehouse | Paginate or cap at 200 with "showing first 200" message |
| Fetching metadata for 50 selected MLVs | Parallel fetch with concurrency limit (5 at a time) |
| Creating 50 nodes + connections | Wrap in single `batchOperation()` |

## 10. Files to Modify

| File | Change |
|------|--------|
| `wizard-dag-presets.js` | Add "Import from Lakehouse" card to `DAG_PRESETS_DATA` |
| `wizard-dag-canvas-page.js` | Wire import flow, pass API client |
| New: `wizard-import-lakehouse.js` | Import dialog component (workspace picker, table checklist, import logic) |
| `infra-wizard.css` | Import dialog styles |
| `scripts/build-html.py` | Add new JS file to build manifest (if not auto-discovered) |

## 11. What We're NOT Doing

- **Cross-lakehouse import** — importing from multiple lakehouses at once
- **Incremental re-import** — "refresh" to sync changes from source lakehouse
- **Column-level mapping** — we import tables as nodes, not their column schemas
- **Modifying the source lakehouse** — this is read-only; we just replicate the topology
