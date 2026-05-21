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

| API | Requires | Returns | Used For |
|-----|----------|---------|----------|
| `listWorkspaces()` | Bearer token | All accessible workspaces | Workspace picker |
| `listTables(wsId, lhId)` | Bearer token | Table list with names | Fallback for non-FLT LH |
| `listTablesViaCapacity(wsId, lhId, capId)` | Bearer token | Tables with schema info | Fallback for schema LH |
| `getTableMetadata(wsId, lhId, schema, table)` | Bearer token | MLVs: `sourceEntities`. Tables: `allColumns` | Fallback connection data |
| **`generatemwctoken`** | **Bearer + wsId + lhId + capId** | **MWC token + host URL** | **Acquire token for ANY lakehouse** |
| **`getLatestDag()`** | **MWC token** | **Full DAG: nodes + dependencies + types** | **Primary import source** |
| Fabric list lakehouses | Bearer token | Lakehouses in a workspace | Lakehouse picker |

### Key insight: MWC tokens can be acquired for ANY lakehouse

`generatemwctoken` is a Fabric metadata endpoint — it only needs a bearer
token + workspace/lakehouse/capacity IDs. No "connected mode" required.
The dev-server already handles this in `_get_mwc_token()` with per-tuple
caching.

This means `getLatestDag()` is the **primary path for ALL lakehouses**:
1. User picks workspace → lakehouse
2. Look up lakehouse's capacity ID (from workspace/capacity APIs)
3. Acquire MWC token via `generatemwctoken` (dev-server caches it)
4. Call `getLatestDag()` through FLT proxy with that token
5. One call → full DAG with nodes, types, connections, schemas

### Fallback: table listing + per-table metadata

If `getLatestDag()` fails (no FLT running on that lakehouse, token error,
lakehouse has never had MLVs defined), fall back to:
1. `listTables()` / `listTablesViaCapacity()` → node listing
2. `getTableMetadata()` per selected MLV → `sourceEntities` for connections

## 4. Connection Replication Strategy

**Primary (all lakehouses — via on-demand MWC token):**
1. Acquire MWC token for the target lakehouse
2. Call `getLatestDag()` → returns all nodes with `dependencies` arrays
3. For each node, `dependencies` lists upstream node names
4. If both the node AND its dependency were imported → create connection
5. One API call. Zero per-node fetching.

The control-panel already parses the DAG response flexibly (see
`control-panel.js:241-263`):
- `nodes` / `nodeDefinitions` / `dagNodes` / `Nodes`
- `dependencies` / `Dependencies` / `inputNodes` / `InputNodes`
- `type` / `Type` / `nodeType` / `NodeType`

**Fallback (no FLT service on lakehouse):**
1. For each selected MLV, call `getTableMetadata(wsId, lhId, schema, name)`
2. Read `sourceEntities` array (e.g., `["bronze.raw_orders"]`)
3. Parse `schema.tableName`, match to imported nodes → create connection
4. N API calls (one per MLV). Slower but works without FLT.

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
| `listLakehouses()` fails | Show error in LH dropdown, workspace stays selected |
| `generatemwctoken` fails (no capacity) | Fall back to table listing + metadata path |
| `getLatestDag()` fails (no FLT on LH) | Fall back to table listing + metadata path, toast: "No DAG found — importing from table catalog" |
| `getLatestDag()` returns empty/null | Fall back to table listing |
| `listTables()` fails (fallback also fails) | Show error in step 2, Back button works |
| `getTableMetadata()` fails for one table | Skip that table's connections, import node anyway, toast warning |
| Auth expired mid-flow | Show "Session expired" toast, dialog stays open for retry |
| Timeout on metadata fetch | Skip after 10s, import node without connections |
| Capacity ID unknown for lakehouse | Try `listCapacities()` to find it; if still unknown, skip MWC path, use fallback |

### 8.2 Empty/Edge States

| Scenario | Behavior |
|----------|----------|
| Workspace has 0 lakehouses | Dropdown: "No lakehouses found" |
| Lakehouse has 0 tables | Step 2: "This lakehouse has no tables" |
| User selects 0 tables | Import button disabled |
| All tables are MLVs (no sources) | Import works, connections between MLVs only |
| Import would exceed 100 node limit | Clamp: "Can import 12 of 18 (88 slots left)" |
| User has 100+ workspaces | Dropdown with search/filter, cap at 200 |

### 8.3 Duplicate Handling

| Scenario | Behavior |
|----------|----------|
| Canvas already has "raw_orders" | Skip duplicate, import others, toast: "Skipped 1 duplicate" |
| Import same lakehouse twice | Second import skips all existing names |
| Different lakehouse, same table names | Import creates nodes (names may clash — prefix with LH name?) |

### 8.4 Schema Considerations

| Scenario | Behavior |
|----------|----------|
| Schema-enabled lakehouse (bronze/silver/gold) | Use `listTablesViaCapacity()`, group by actual schema |
| Non-schema lakehouse (dbo only) | Use `listTables()`, all under "dbo" group |
| Medallion level mismatch — importing gold tables but wizard medallion=1 (bronze only) | Auto-upgrade medallion level to accommodate imported schemas. Toast: "Medallion level raised to include gold" |
| Schema in lakehouse not in wizard schema set | Add the schema, update medallion level |

### 8.5 Connection Resolution

| Scenario | Behavior |
|----------|----------|
| MLV → imported source table | Connection created |
| MLV → source NOT imported | Silently skipped |
| MLV → source in different lakehouse | Skipped (cross-LH not supported) |
| Circular reference | Ignored (canvas cycle prevention) |
| `sourceEntities` empty/missing | No connections for this node |
| `sourceEntities` uses fully qualified name (`schema.table`) | Parse both schema-prefixed and bare names |
| Duplicate connection (same src→tgt already exists) | Canvas `addConnection` dedup handles this |

### 8.6 Canvas State Interactions

| Scenario | Behavior |
|----------|----------|
| Canvas already has nodes from preset/manual | Import ADDS (appends), doesn't replace |
| Import card clicked while batch form is open | Close batch form, open import dialog |
| User navigates away (page 1) mid-import dialog | Dialog dismisses, state NOT preserved |
| User clicks Back from step 2 to step 1 | Preserve workspace/LH selection |
| Import while another import is in progress | Disabled (import button shows spinner) |

### 8.7 Performance

| Concern | Mitigation |
|---------|-----------|
| 500+ tables in lakehouse | Show first 200 with "200 of 523 shown" + search filter |
| Metadata fetch for 50 MLVs | Parallel with concurrency=5, progress indicator |
| Creating 50+ nodes + connections | Single `batchOperation()`, autoLayout at end |
| Slow workspace listing (100+ WS) | Show spinner, cache result for session |

### 8.8 Special Characters

| Scenario | Behavior |
|----------|----------|
| Table name has spaces: `"raw orders"` | Preserve as-is in node name |
| Table name has brackets: `[raw_orders]` | Strip brackets for node name |
| Table name has dots: `dbo.raw_orders` | Split on dot, use table part as name, schema part as schema |

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
