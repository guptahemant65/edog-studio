# Notebook IDE + Item Type Views — Design Spec v2

> **Date:** 2026-04-11
> **Author:** Full hivemind — Kael (UX), Zara (JS), Mika (CSS), Elena (Python), Dev (FLT), Donna (coord)
> **Status:** Draft v2 — incorporates CEO feedback on depth and FLT workflow understanding
> **Supersedes:** v1 (rejected — lacked depth, proposed disconnected screens, missed notebook IDE workflow)

## CEO Feedback (verbatim)
- "Notebooks have cells too — see the design bible"
- "There's no API that only works when deployed. EDOG DevMode is a relay service."
- "Embedded mini notebook IDE — view cells, edit inline, run against Spark session, see output"
- "Full cell editing (add/delete/reorder cells, save back) — this is the MLV creation workflow, it's core"
- "Inside the workspace explorer content panel"
- "Environments are what you attach when you want to run a MLV or notebook (Spark session). Default env + custom envs."
- "Don't worry about 3-panel layout. Change whatever gives best experience."

## Architecture Understanding (Corrected)

**Phase 1 ≠ "limited APIs".** ALL Fabric APIs work in both phases via bearer token. Phase 2 only changes WHERE FLT request processing happens (cloud → local relay). The sidebar's disabled icons (Logs/DAG/Spark) are disabled because there's no local FLT service to capture data FROM, not because APIs are missing.

This means: Notebook create, read, edit, run, and environment management ALL work in Phase 1.

---

## API Surface (Verified against PPE)

| Operation | Method | Endpoint | Status |
|-----------|--------|----------|--------|
| List notebooks | GET | `/workspaces/{ws}/notebooks` | ✅ Returns properties (defaultLakehouse, attachedEnvironment) |
| Read cells | POST→LRO | `/notebooks/{id}/getDefinition` → poll → `/result` | ✅ Returns base64 `notebook-content.sql` with cell markers |
| Write cells | POST | `/notebooks/{id}/updateDefinition` | ✅ Accepts definition payload |
| Create notebook | POST | `/workspaces/{ws}/notebooks` | ✅ 201 with name+description |
| Delete notebook | DELETE | `/notebooks/{id}` | ✅ 200 |
| Run notebook | POST→LRO | `/items/{id}/jobs/instances?jobType=RunNotebook` | ✅ 202 → poll status |
| Cancel run | POST | `/jobs/instances/{jobId}/cancel` | ✅ 202 |
| Run status | GET | `/items/{id}/jobs/instances/{jobId}` | ✅ status, failureReason, startTime, endTime |
| Cell-by-cell exec | POST (MwcToken) | `{capHost}/webapi/capacities/{cap}/workloads/Notebook/Data/Automatic/api/workspaces/{ws}/artifacts/{nb}/jupyterApi/versions/1/api/sessions` | ✅ Creates Jupyter kernel session (synapse_pyspark) |
| Kernel specs | GET (MwcToken) | `{capHost}/.../jupyterApi/versions/1/api/kernelspecs` | ✅ Lists available kernels |
| Spark settings | GET (MwcToken) | `{capHost}/.../workloads/SparkCore/SparkCoreService/Automatic/v1/workspaces/{ws}/sparkSettings` | ✅ Current Spark config |
| Notebook WebSocket | WSS (MwcToken) | `wss://{capHost}/.../workloads/Notebook/AzNBProxy/Automatic/workspaces/{ws}/api/proxy/ws/tinymgr/lobby` | ✅ Real-time notebook communication |
| List environments | GET | `/workspaces/{ws}/environments` | ✅ Returns publishDetails, Spark component status |
| Environment detail | GET | `/environments/{id}` | ✅ Full properties |

### Notebook Content Format
```
-- Fabric notebook source
-- METADATA ********************
-- META { "kernel_info": { "name": "synapse_pyspark" }, "dependencies": { "lakehouse": {...}, "environment": {...} } }

-- MARKDOWN ********************
-- # Heading
-- Description text

-- CELL ********************
SQL code here (default language = sparksql)

-- METADATA ********************
-- META { "language": "sparksql", "language_group": "synapse_pyspark" }

-- CELL ********************
-- MAGIC %%pyspark
-- MAGIC python_code_here

-- METADATA ********************
-- META { "language": "python", "language_group": "synapse_pyspark" }
```

**Parsing rules:**
- `-- CELL **` = code cell boundary
- `-- MARKDOWN **` = markdown cell boundary
- `-- METADATA **` followed by `-- META {...}` = cell metadata (language, etc.)
- `-- MAGIC %%pyspark` / `-- MAGIC %%sql` = language override for the cell
- Lines starting with `-- MAGIC ` = code lines in Python cells (strip `-- MAGIC ` prefix)
- Lines without `-- MAGIC` prefix in a CELL = SQL code
- Top-level `-- METADATA **` (first one) = notebook-level metadata (kernel, dependencies)

---

## Feature 1: Notebook IDE (Center Panel)

### Layout
When user clicks a Notebook in the tree, the **entire center panel** transforms into a notebook IDE. The 3-panel layout may shift:
- Left: Tree panel stays (260px) — provides navigation context
- Center: **Notebook IDE** (full remaining width) — replaces content+inspector
- Inspector panel: **Collapses** — notebook is the primary focus. Cell metadata shows inline.

Alternatively, if the user wants the inspector, they can toggle it back. But default = notebook takes full center+right area.

### Notebook IDE Anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│ NOTEBOOK TOOLBAR                                                │
│ [Notebook 1] ▾ NB badge  [▶ Run All] [+ Cell] [⟲ Refresh]     │
│ Default LH: TestLH · Env: testenv · Kernel: synapse_pyspark    │
│ [SQL ▾] [Python] [Markdown] ← new cell type selector           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ ┌─ CELL 1 ─ Markdown ──────────────────────────────────────────┐│
│ │ # Create materialized lake views                             ││
│ │ 1. Use this notebook to create materialized lake views.      ││
│ │ 2. Select Run all to run the notebook.                       ││
│ │                                           [✎ Edit] [🗑 Del] ││
│ └──────────────────────────────────────────────────────────────┘│
│                          [+ Add Cell]                           │
│ ┌─ CELL 2 ─ SparkSQL ─────────────────────── [▶ Run] [⋯] ────┐│
│ │  1 │ CREATE MATERIALIZED lake VIEW dbo.mvFromOne             ││
│ │  2 │ AS SELECT * from dbo.numTen;                            ││
│ │  3 │                                                         ││
│ │  4 │ CREATE MATERIALIZED lake VIEW dbo.mvFromMV              ││
│ │  5 │ AS SELECT * from dbo.mvFromOne;                         ││
│ │  6 │                                                         ││
│ │  7 │ INSERT INTO dbo.numTen (number)                         ││
│ │  8 │ VALUES (6), (7), (8), (9), (10)...;                     ││
│ │    │                                            [Show more ▾]││
│ ├──────────────────────────────────────────────────────────────┤│
│ │ Output: (none — click ▶ Run to execute)                      ││
│ └──────────────────────────────────────────────────────────────┘│
│                          [+ Add Cell]                           │
│ ┌─ CELL 3 ─ Python ───────────────────────── [▶ Run] [⋯] ────┐│
│ │  1 │ from notebookutils import mssparkutils                  ││
│ │  2 │ import zlib, json                                       ││
│ │  3 │                                                         ││
│ │  4 │ file_path = "Tables/dbo/mvfromone.test/..."             ││
│ │  5 │ local_path = "/tmp/table.json.gz"                       ││
│ │    │                                                         ││
│ └──────────────────────────────────────────────────────────────┘│
│                          [+ Add Cell]                           │
│ ... more cells ...                                              │
│                                                                 │
│ ┌─ RUN STATUS ─────────────────────────────────────────────────┐│
│ │ Last run: 2026-04-11 09:52 · Status: ● NotStarted           ││
│ │ [▶ Run All] [Cancel]                                         ││
│ └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Cell Components (per design bible §20b)

**Code Cell:**
- Header: `In [N]:` + language badge (SparkSQL=amber, Python=green) + [▶ Run] + [⋯ More]
- Code area: Mono font, line numbers in gutter, editable `<textarea>` or contenteditable
- Output area: Shows after run completes (for full-notebook run, output comes from job result)
- Hover: Border highlights accent
- More menu: [Copy] [Delete] [Move Up] [Move Down] [Change Language]

**Markdown Cell:**
- Rendered view (default): Formatted markdown with accent-dim left border
- Edit mode (click ✎): Raw markdown editor
- No line numbers, no run button

**Between-cell Add Button:**
- `[+ Add Cell]` button between every pair of cells
- Click → dropdown: [SQL Cell] [Python Cell] [Markdown Cell]

### Notebook Toolbar
- **Title**: Notebook name (editable inline)
- **Run All**: Calls `/items/{id}/jobs/instances?jobType=RunNotebook` → polls for completion
- **Add Cell**: Dropdown for new cell type
- **Refresh**: Re-fetches cells from API (discard unsaved changes with confirm)
- **Context row**: Default Lakehouse (clickable → navigates to LH), Attached Environment (clickable), Kernel info
- **Save**: Calls `updateDefinition` to write cells back to Fabric
- **Dirty indicator**: Shows when cells have been modified but not saved

### Cell Editing
- Click on code area → becomes editable (contenteditable or textarea)
- Tab key inserts spaces (not focus change)
- Ctrl+S saves the notebook
- Ctrl+Enter runs the current cell (if cell-by-cell available) or runs all
- Cell reorder: drag handle on left, or keyboard Ctrl+↑/↓

### Run Notebook Flow
1. User clicks [▶ Run All]
2. If unsaved changes → prompt "Save and run?" → save first
3. POST to Job Scheduler → get job ID
4. Show progress bar in toolbar: "Running... ◐"
5. Poll job status every 5s
6. On completion: show ● Success (green) or ● Failed (red) with failure reason
7. If failed: highlight the error in the status bar
8. Note: No per-cell output available from Job Scheduler (it runs the whole notebook). Output would need Livy which isn't available.

### Save Flow
1. Serialize cells back to `notebook-content.sql` format
2. Base64 encode
3. POST to `/notebooks/{id}/updateDefinition` with definition payload
4. Show toast: "Saved ✓" or "Save failed: {error}"

---

## Feature 2: Environment Context (Attached to Notebooks)

### What Environments Actually Are
Environments are **Spark execution contexts** — they define:
- Spark libraries (Python packages, Jar files)
- Spark settings (executor memory, cores, etc.)

When running a notebook, it uses the attached environment's Spark config. Users can:
- Use the default environment (auto-created per workspace)
- Create custom environments with specific library versions
- Attach different environments to different notebooks

### In the Workspace Explorer
When clicking an Environment in the tree:
- Show environment name, ID, description
- **Publish status**: Success/Running/Failed with component breakdown (Spark Libraries, Spark Settings)
- **Attached notebooks**: List which notebooks in this workspace use this environment
- **Spark config summary**: Library count, settings summary
- Actions: [Open in Fabric] [Rename] [Republish] [Delete]

### In the Notebook IDE
The notebook toolbar shows the attached environment as a clickable chip:
- `[Env: testenv ▾]` — click to see dropdown of available environments
- Switch environment → updates the notebook's `attachedEnvironment` property
- Visual indicator if the environment is in "Running" publish state (amber pulse)

---

## Feature 3: Generic Item Views

For items without rich APIs (SQLEndpoint, Report, SemanticModel, Pipeline):
- Clean header: name + type badge + full GUID
- Description if available
- Key-value info card
- [Open in Fabric] as primary action
- "More details available in Microsoft Fabric" subtle link
- Inspector panel shows item metadata

These are intentionally minimal — we're a FLT dev cockpit, not a Fabric portal clone.

---

## Implementation Plan

### Phase A: Notebook IDE (Core — 8 tasks)
1. **Server**: New endpoint `/api/fabric/notebook-content` — handles getDefinition LRO
2. **Server**: New endpoint `/api/fabric/notebook-save` — handles updateDefinition
3. **Server**: New endpoint `/api/fabric/notebook-run` — handles job scheduler + status polling
4. **Parser**: JS module to parse/serialize `notebook-content.sql` ↔ cell array
5. **CSS**: Notebook cell styles per §20b (nb-cell, nb-code, nb-output, nb-cell-header)
6. **JS**: NotebookView class — renders cells, handles editing, toolbar
7. **JS**: Cell editing (contenteditable, tab handling, dirty tracking)
8. **JS**: Run flow (save → run → poll → status display)

### Phase B: Environment + Generic Views (3 tasks)
9. **JS**: Environment content view (publish status, components, attached notebooks)
10. **JS**: Generic item content view (info card, Open in Fabric)
11. **CSS**: Environment and generic item styles

### Phase C: Integration (2 tasks)
12. **JS**: Wire notebook IDE into workspace-explorer._showItemContent dispatcher
13. **JS**: Environment switching in notebook toolbar

---

## Design Principles (from CEO)
1. **This is a dev cockpit, not a portal** — optimize for the FLT developer workflow
2. **MLV creation is core** — Notebook IDE is not a nice-to-have, it's the primary creation tool
3. **Environments are execution contexts** — they matter because they affect how notebooks run
4. **All APIs work in both phases** — no artificial feature gating
5. **Change the layout if it gives better UX** — don't force 3-panel if notebook needs more space

## Problem

When a user clicks a non-lakehouse item (Notebook, Environment, SQLEndpoint, Report, SemanticModel, Pipeline) in the workspace explorer, the content panel shows a bare stub: name, type badge, GUID, and "Open in Fabric". No metadata, no relationships, no context. The inspector panel stays empty.

Meanwhile, Lakehouses get a rich view: tables with row counts, schema, deploy button, badges. The quality gap is jarring.

## Available Data (from Fabric APIs)

### Common (all items via `/workspaces/{id}/items`)
- `displayName`, `id`, `type`, `description`, `workspaceId`

### Notebook (via `/workspaces/{id}/notebooks`)
- `properties.attachedEnvironment` → linked Environment {itemId, workspaceId}
- `properties.defaultLakehouse` → linked Lakehouse {itemId, workspaceId}
- `properties.primaryWarehouse` → linked Warehouse (nullable)

### Environment (via `/workspaces/{id}/environments`)
- `properties.publishDetails.state` → "Success" / "Running" / "Failed"
- `properties.publishDetails.targetVersion` → version GUID
- `properties.publishDetails.startTime` / `endTime`
- `properties.publishDetails.componentPublishInfo.sparkLibraries.state`
- `properties.publishDetails.componentPublishInfo.sparkSettings.state`

### SQLEndpoint, Report, SemanticModel, Pipeline
- Only common fields available via public API in Phase 1

---

## Design

### Approach: Type-Aware Content Cards

Replace the generic `_showItemContent()` with a dispatcher that renders type-specific content cards. Each card type has:

1. **Rich header** (same pattern as lakehouse): Name + type badge + GUID (full, copyable) + description
2. **Action bar**: Type-appropriate actions (Open in Fabric is always first)
3. **Relationship cards**: Linked items shown as clickable cards (click navigates to that item)
4. **Properties section**: Type-specific metadata in key-value pairs
5. **Inspector panel**: Always populated with item details when selected

### Notebook View

```
┌──────────────────────────────────────────────────┐
│ Notebook 1                                        │
│ Notebook  e1952851-641f-4dc6-8fae-3ac5a67aa3e4   │
│ "New notebook"                                    │
│                                                   │
│ [▶ Open in Fabric] [✎ Rename] [🗑 Delete]         │
│                                                   │
│ ┌─ LINKED ITEMS ────────────────────────────────┐ │
│ │                                               │ │
│ │  ┌──────────────────┐  ┌──────────────────┐   │ │
│ │  │ 🟢 TestLH         │  │ ⚙ testenv        │   │ │
│ │  │ Default Lakehouse │  │ Attached Env     │   │ │
│ │  │ LH · a96fdc44...  │  │ ENV · 124f4731.. │   │ │
│ │  │ → Click to view   │  │ → Click to view  │   │ │
│ │  └──────────────────┘  └──────────────────┘   │ │
│ │                                               │ │
│ └───────────────────────────────────────────────┘ │
│                                                   │
│ ┌─ NOTEBOOK INFO ───────────────────────────────┐ │
│ │ Default Lakehouse  TestLH                     │ │
│ │ Attached Env       testenv                    │ │
│ │ Primary Warehouse  —                          │ │
│ │ Description        New notebook               │ │
│ └───────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

**Linked Item Cards:**
- Each relationship renders as a small clickable card
- Shows: colored dot + item name, relationship label, type badge + ID prefix
- Click navigates to that item in the tree (expand workspace → select item)
- If the linked item isn't in the current workspace's children, show as dimmed with tooltip

**Inspector Panel (right):**
When a Notebook is selected, the inspector shows:
- Item Info (Name, ID, Type, Workspace, Description)
- Linked Resources (Default Lakehouse, Attached Environment)
- Workspace context

### Environment View

```
┌──────────────────────────────────────────────────┐
│ testenv                                           │
│ Environment  124f4731-ba1c-4921-a038-5f3a63371fc4│
│                                                   │
│ [▶ Open in Fabric] [✎ Rename] [🗑 Delete]         │
│                                                   │
│ ┌─ PUBLISH STATUS ──────────────────────────────┐ │
│ │ State          ● Success                      │ │
│ │ Version        95ee2731...                     │ │
│ │ Published      2026-03-31 17:36                │ │
│ │ Duration       1.6s                            │ │
│ │                                               │ │
│ │ Components:                                   │ │
│ │   Spark Libraries   ● Success                 │ │
│ │   Spark Settings    ● Success                 │ │
│ └───────────────────────────────────────────────┘ │
│                                                   │
│ ┌─ ENVIRONMENT INFO ────────────────────────────┐ │
│ │ Description    Environment                    │ │
│ │ Workspace      FMLVWS                         │ │
│ └───────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

**Publish Status Card:**
- State shown as colored dot: green=Success, amber=Running, red=Failed
- Version GUID (copyable)
- Time range (start → end, with duration)
- Component breakdown: each Spark component with its own status dot

### Generic Item View (SQLEndpoint, Report, SemanticModel, Pipeline)

For items without rich API data:
```
┌──────────────────────────────────────────────────┐
│ TestLH                                            │
│ SQLEndpoint  9a7d37d8-2aef-4d5f-bdcd-18665791f5f0│
│                                                   │
│ [▶ Open in Fabric] [✎ Rename] [🗑 Delete]         │
│                                                   │
│ ┌─ ITEM INFO ───────────────────────────────────┐ │
│ │ Type           SQLEndpoint                    │ │
│ │ Description    —                              │ │
│ │ Workspace      FMLVWS                         │ │
│ │ ID             9a7d37d8-2aef-...              │ │
│ └───────────────────────────────────────────────┘ │
│                                                   │
│   More details available in Fabric ↗              │
└──────────────────────────────────────────────────┘
```

---

## Architecture

### JS Changes

**`api-client.js`** — Add 2 new methods:
- `listNotebooks(workspaceId)` → GET `/api/fabric/workspaces/{id}/notebooks`
- `listEnvironments(workspaceId)` → GET `/api/fabric/workspaces/{id}/environments`

**`workspace-explorer.js`** — Replace `_showItemContent()`:
```
_showItemContent(item, ws) → dispatcher:
  if Notebook → _showNotebookContent(item, ws)
  if Environment → _showEnvironmentContent(item, ws)
  else → _showGenericItemContent(item, ws)
```

Each type-specific method:
1. Renders the rich header (reuse `_buildContentHeader()` helper)
2. Fetches type-specific data if not cached (`_notebookCache`, `_environmentCache`)
3. Renders relationship cards and property sections
4. Populates inspector with item details

**Caching:** Type-specific API calls are cached per workspace in `_notebookCache[wsId]` and `_environmentCache[wsId]`. First click on any notebook triggers a single list call; subsequent clicks use the cache.

### CSS Changes

**`workspace.css`** — Add styles for:
- `.ws-linked-cards` — flexbox row of relationship cards
- `.ws-linked-card` — individual card (border, padding, hover, click)
- `.ws-publish-status` — environment publish status section
- `.ws-status-dot` — colored status indicator
- `.ws-item-info` — key-value section for generic items

### Data Flow

```
User clicks Notebook in tree
  → _selectItem(item, ws)
    → _showNotebookContent(item, ws)
      → Check _notebookCache[ws.id]
        → Cache miss: fetch /workspaces/{id}/notebooks → cache all
      → Find this notebook in cache → get properties
      → Render header + linked item cards + notebook info
      → Resolve linked item names (find in _children[ws.id])
      → Populate inspector panel
```

---

## Scope

**In scope (this spec):**
- Notebook content view with linked items (lakehouse, environment)
- Environment content view with publish status
- Generic item view (for SQLEndpoint, Report, SemanticModel, Pipeline)
- Inspector panel population for all item types
- Type-specific API caching
- Click-to-navigate from linked item cards

**Out of scope:**
- Notebook cell content/preview (requires Phase 2 / git integration)
- Environment editing (library management, Spark config)
- Pipeline run history / scheduling
- SQL query execution from SQLEndpoint view
- Report rendering / preview

---

## Quality Bar

- Would an FLT engineer clicking "Notebook 1" see useful context at a glance?
- Can they quickly navigate to the linked lakehouse or environment?
- Does the empty state for items without rich data feel intentional (not broken)?
- All GUIDs full and copyable, all actions have icons, keyboard accessible
