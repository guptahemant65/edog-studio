# Feature 16: New Infra Wizard

> **Status:** P0 (Foundation Research) — NOT STARTED
> **Phase:** V2
> **Owner:** Vex (Python/C#) + Pixel (JS/CSS)
> **Design Ref:** Design Bible 4b, Overlay 25A
> **SOP:** hivemind/FEATURE_DEV_SOP.md

---

## 1. Product Vision

A full-screen modal wizard that creates a complete Fabric test environment from scratch — workspace, capacity, lakehouse, notebook with a visual DAG of materialized lake views — all configured through a drag-and-drop DAG builder. Users design their data pipeline topology visually, pick a data theme, choose schemas, and the wizard auto-generates everything: SQL tables, SQL MLVs, PySpark MLVs, all wired together in a single notebook. One click from "nothing" to "running DAG."

**This is NOT a simple stepper.** It's an Environment Factory with:
- 5-page multi-step wizard inside a resizable/draggable modal dialog
- Visual DAG canvas with drag-and-drop node placement and arrow connections
- 3 node types: SQL MLV, PySpark MLV, Plain SQL table
- Medallion architecture support (dbo + bronze/silver/gold schemas)
- 6 data themes for auto-generated sample code (10 rows per table)
- GitHub Actions-style execution pipeline with step-by-step progress
- Template system for saving/loading/deleting complete DAG configurations
- Minimizable to floating badge during long-running execution
- Full rollback on failure, retry from failed step

---

## 2. The 5 Wizard Pages

### Page 1 — Infrastructure Setup

| Field | Details |
|-------|---------|
| **Workspace Name** | Text input with random placeholder (Docker-style: `brave_turing_42`). Underscores allowed. If name exists → show error, ask rename. |
| **Capacity** | Dropdown of existing capacities (from `GET /v1.0/myorg/capacities`). Shows name, SKU, region, state. |
| **Capacity Creation** | Inline form (COMING SOON — UI present, disabled): name + SKU dropdown (F2/F4/F8/F16/F32/F64) + region dropdown |
| **Lakehouse Name** | Auto-generated from workspace name. User can edit. ALWAYS schema-enabled (`enableSchemas: true`) — hardcoded, non-negotiable. |
| **Notebook Name** | Auto-generated from lakehouse name. User can edit. |

### Page 2 — Theme & Schema Setup

**Data Theme** (one per environment, mandatory selection):

| # | Theme | Sample Tables |
|---|-------|--------------|
| 1 | **E-Commerce** | orders, customers, products, categories, reviews |
| 2 | **Sales & Marketing** | leads, campaigns, deals, accounts, activities |
| 3 | **IoT / Sensors** | devices, readings, alerts, locations, thresholds |
| 4 | **HR & People** | employees, departments, payroll, attendance, reviews |
| 5 | **Finance** | transactions, accounts, invoices, payments, budgets |
| 6 | **Healthcare** | patients, appointments, prescriptions, labs, providers |

**Schema Setup:**
- `dbo` is ALWAYS present (mandatory, not removable)
- Optional prompt: "Do you want additional schemas?"
- If yes → multi-select from: **Bronze**, **Silver**, **Gold**
- Can select 1, 2, or all 3
- Each node on the DAG canvas gets a schema dropdown (dbo + selected schemas)

### Page 3 — DAG Canvas (The Big One)

**Canvas:**
- White/clean background (follows design bible)
- Zoom & pan: scroll to zoom, drag empty space to pan
- Auto-layout button: "Auto Arrange" snaps messy DAGs into clean layout
- Undo/redo: Ctrl+Z / Ctrl+Y

**Node Palette** (sidebar or best-practice placement — research needed):
- 3 draggable node types:
  1. ◇ Plain SQL Table (source/leaf nodes)
  2. ◆ SQL MLV (materialized view via SQL)
  3. ◆ PySpark MLV (materialized view via PySpark decorator)

**Node Operations** (via click → popover/panel):
- Rename (auto-generated name, user can edit)
- Change type (SQL MLV ↔ PySpark MLV ↔ Plain SQL)
- Change schema (dropdown: dbo, bronze, silver, gold — based on Page 2 selection)
- Delete (auto-removes all connections to/from this node)

**Connections:**
- Drag arrow from one node to another
- Multiple parents per node allowed
- Multiple root nodes allowed
- Free-form topology — NO medallion enforcement (bronze→gold, gold→gold, anything goes)
- Max 100 nodes on canvas
- Auto-generated SQL references parent node table names

**Code Preview Panel:**
- Alongside the canvas (right side or bottom)
- Shows auto-generated notebook code
- Updates on demand (refresh button, NOT real-time)
- Minimizable to save canvas space

### Page 4 — Review Summary

- Full summary of everything configured:
  - Workspace name, capacity, lakehouse, notebook
  - Theme selected
  - Schemas enabled
  - Read-only mini DAG visualization
  - Node count by type (e.g., "3 SQL tables, 5 SQL MLVs, 2 PySpark MLVs")
  - Confirmation text: "You're about to create: 1 workspace, 1 capacity assignment, 1 lakehouse, 1 notebook with N cells, forming an N-node DAG"
- User can go **BACK** to edit any previous page
- "Save as Template" option before executing
- **"Lock In & Create"** button to start execution

### Page 5 — Execution Pipeline

- GitHub Actions-style progress view:
  - Each step: ⏳ Pending → ● Running → ✓ Done / ✕ Failed
  - Timer showing elapsed time per step
  - Expandable to show API response details
- **Pipeline steps:** Create Workspace → Assign Capacity → Create Lakehouse → Create Notebook → Write Cells → Run Notebook
- User CANNOT cancel mid-execution
- **On failure:** Full rollback (delete everything created) + show error with details
- **On retry:** "Retry" button on failed step → skips already-completed steps
- **Minimizable:** Dialog shrinks to floating badge/pill: "Step 3/5 — Creating Lakehouse ●"
- When minimized, user can do other things in EDOG Studio (non-blocking)
- Clicking badge reopens full dialog at current stage
- Close (X) during execution = minimize (keeps running)
- **Post-creation:** "Done! Click to navigate" → opens workspace in explorer panel

---

## 3. Notebook Cell Structure

All nodes go into ONE notebook. Cells are **topologically sorted** (parents defined before children).

### Cell Order

1. `!pip install fmlv` — ONLY if PySpark MLV nodes exist (first cell)
2. Plain SQL table cells (source/leaf nodes)
3. MLV cells in topological dependency order

### Plain SQL Table Cell

```sql
%%sql
CREATE TABLE IF NOT EXISTS {schema}.{table_name} (
    id INT,
    name STRING,
    value DECIMAL(10,2),
    created_at TIMESTAMP
);
INSERT INTO {schema}.{table_name} VALUES
    (1, 'sample_1', 100.00, '2024-01-01T00:00:00'),
    ... (10 rows total, themed)
```

### SQL MLV Cell

```sql
%%sql
CREATE MATERIALIZED LAKE VIEW {schema}.{mlv_name} AS
SELECT * FROM {schema}.{parent_table_1}
-- JOINs added if multiple parents:
-- JOIN {schema}.{parent_table_2} ON ...
```

### PySpark MLV Cell

```python
import fmlv
from pyspark.sql.types import StructType, StructField, StringType, IntegerType, TimestampType
from datetime import datetime

@fmlv.materialized_lake_view(name="{schema}.{mlv_name}")
def {mlv_name}():
    schema = StructType([
        StructField("id", IntegerType(), False),
        StructField("name", StringType(), True),
        # ... themed columns
    ])
    data = [
        (1, "sample_1", ...),
        # ... 10 rows, themed
    ]
    df = spark.createDataFrame(data, schema=schema)
    return df
```

**Sample data:** 10 rows per table/MLV, themed based on user's theme selection.

---

## 4. Template System

| Aspect | Details |
|--------|---------|
| **What's saved** | DAG topology + node names + node types + node count + theme + schemas — everything |
| **Naming** | User picks name, placeholder suggestion provided |
| **Storage** | Separate local file (project-level, e.g., `edog-templates.json`) |
| **Loading** | From wizard start screen → picks template → pre-fills ALL 4 config pages |
| **Deleting** | User can delete templates later (UX placement TBD) |

---

## 5. Dialog UX

| Property | Value |
|----------|-------|
| **Type** | Modal overlay (blocks background interaction) |
| **Resizable** | Yes, within bounds (not to extent that disturbs main UI) |
| **Draggable** | Yes, with title bar |
| **Dimensions** | Industry standard (~80% viewport width × 85% height, min constraints) |
| **Step indicator** | Top of dialog: "Step 2 of 5" or progress breadcrumb |
| **Navigation** | Multi-page with Next/Back buttons |
| **Design quality** | Design Bible 4b, Overlay 25A — extraordinary level |

---

## 6. Schemas (Medallion Architecture)

- `dbo` is ALWAYS created by default (mandatory)
- User optionally adds: **Bronze**, **Silver**, **Gold** (multi-select)
- Each node on DAG canvas has schema dropdown
- Connections are free-form — no enforcement of bronze→silver→gold flow
- Generated code uses full schema prefix: `dbo.table_name`, `bronze.table_name`
- Schema creation is part of the wizard's execution pipeline

---

## 7. API Endpoints

| # | Operation | Method | Endpoint | Auth | Status |
|---|-----------|--------|----------|------|--------|
| A1 | Create workspace | POST | `/metadata/folders` | Bearer | ✅ Verified |
| A2 | Assign capacity | POST | `/v1/workspaces/{wsId}/assignToCapacity` | Bearer | ✅ Verified (202) |
| A3 | List capacities | GET | `/v1.0/myorg/capacities` | Bearer | ✅ Verified |
| A4 | Create lakehouse | POST | `/v1/workspaces/{wsId}/lakehouses` | Bearer | ⚠️ Not tested |
| A5 | Create notebook | POST | `/v1/workspaces/{wsId}/notebooks` | Bearer | ✅ Verified |
| A6 | Write cells | POST | `.../notebooks/{nbId}/updateDefinition` | Bearer | ✅ Verified |
| A7 | Run notebook | POST | `.../items/{nbId}/jobs/instances?jobType=RunNotebook` | Bearer | ✅ LRO |
| A8 | Create capacity | TBD | Coming Soon (likely ARM API) | Bearer | ⬜ TBD |

---

## 8. Edge Cases & Hard Rules

| Rule | Details |
|------|---------|
| Workspace name collision | Show error, ask user to rename |
| Multiple environments | Allowed — run wizard multiple times for different test setups |
| Concurrent wizards | BLOCKED — can't open new wizard while previous creation is running |
| Cancel mid-execution | NOT ALLOWED — user must wait or minimize |
| Close dialog during execution | Treated as minimize (execution continues) |
| Lakehouse schemas | ALWAYS `enableSchemas: true` — non-negotiable |
| Data theme | One theme per environment, mandatory selection |
| Max nodes | 100 on canvas |
| dbo schema | Always present, cannot be removed |
| Rollback on failure | Full cleanup — delete everything created, back to zero |
| Retry on failure | "Retry" button → skips completed steps |
| Post-creation navigation | Opens created workspace in explorer panel |
| `fmlv` pip install | Only added if PySpark MLV nodes exist |
| Cell ordering | Topologically sorted — parents before children |

---

## 9. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Notebook updateDefinition body format undocumented | HIGH | Reverse-engineer from getDefinition output |
| Notebook run is LRO — polling UX needed | MEDIUM | GitHub Actions-style progress with polling |
| Capacity creation API not available in Fabric | HIGH | Mark "Coming Soon" in UI, support existing capacity selection |
| Lakehouse creation with schemas not tested | MEDIUM | Test `POST .../lakehouses` with `{ enableSchemas: true }` |
| DAG canvas performance with 100 nodes | MEDIUM | Virtual rendering, debounced layout |
| Template file corruption | LOW | JSON schema validation on load |
| Rollback failures (partial cleanup) | MEDIUM | Best-effort cleanup + show manual cleanup instructions |
| fmlv package not available in target Fabric env | MEDIUM | Add version pinning, document prerequisites |

---

## 10. Dependencies

- **F01 Workspace Explorer** — wizard trigger lives in explorer panel
- **F02 Deploy to Lakehouse** — notebook run uses similar LRO polling patterns
- **F09 API Playground** — shares api-client.js for Fabric API calls
- **F08 DAG Studio** — DAG canvas patterns may be reusable
- **Design Bible 4b** — dialog and overlay design reference

---

## 11. Components (14 total)

| # | Component | Description | Complexity |
|---|-----------|-------------|------------|
| C1 | **InfraWizardDialog** | Modal container — resize, drag, step navigation, minimize | HIGH |
| C2 | **InfraSetupPage** | Workspace/capacity/lakehouse/notebook form (Page 1) | MEDIUM |
| C3 | **ThemeSchemaPage** | Theme picker grid + schema multi-select (Page 2) | MEDIUM |
| C4 | **DagCanvas** | Visual node placement, connection drawing, zoom/pan (Page 3) | VERY HIGH |
| C5 | **NodePalette** | Sidebar with draggable node types | MEDIUM |
| C6 | **DagNode** | Individual node on canvas — rename, type, schema, delete | HIGH |
| C7 | **ConnectionManager** | Arrow drawing between nodes, path routing | HIGH |
| C8 | **CodePreviewPanel** | Auto-generated notebook code preview, minimizable | MEDIUM |
| C9 | **ReviewSummary** | Read-only summary of all config + mini DAG view (Page 4) | MEDIUM |
| C10 | **ExecutionPipeline** | GitHub Actions-style progress view (Page 5) | HIGH |
| C11 | **FloatingBadge** | Minimized execution status pill/badge | LOW |
| C12 | **TemplateManager** | Save/load/delete DAG templates | MEDIUM |
| C13 | **AutoLayoutEngine** | Snap nodes into clean DAG arrangement | HIGH |
| C14 | **UndoRedoManager** | Ctrl+Z/Y state management for canvas | MEDIUM |

---

## 12. Prep Checklist

### Phase 0: Foundation Research

| # | Task | Owner | Output | Status |
|---|------|-------|--------|--------|
| P0.1 | Code audit — workspace-explorer.js, deploy-flow.js, api-client.js, dag-studio specs | Pixel+Vex | `research/p0-foundation.md` §1 | ⬜ |
| P0.2 | API verification — test A1-A7 endpoints, document exact request/response bodies | Vex | `research/p0-foundation.md` §2 | ⬜ |
| P0.3 | Notebook content format — reverse-engineer updateDefinition body for multi-cell notebooks | Vex | `research/p0-foundation.md` §3 | ⬜ |
| P0.4 | Industry research — visual DAG builder UX patterns (dbt Cloud, Airflow, Prefect, Dagster, n8n, Retool) | Sana | `research/p0-foundation.md` §4 | ⬜ |
| P0.5 | Industry research — modal wizard patterns (Stripe, Vercel, Linear, Notion, Figma) | Sana | `research/p0-foundation.md` §5 | ⬜ |
| P0.6 | Canvas interaction research — node palette drag-and-drop vs click-to-place vs context menu | Pixel | `research/p0-foundation.md` §6 | ⬜ |
| P0.7 | Schema creation API verification — can we create bronze/silver/gold via API? | Vex | `research/p0-foundation.md` §7 | ⬜ |
| P0.8 | Lakehouse creation with enableSchemas — test and document | Vex | `research/p0-foundation.md` §8 | ⬜ |

### Phase 1: Component Deep Specs

| # | Component | Output | States (est.) | Depends On | Status |
|---|-----------|--------|---------------|-----------|--------|
| P1.1 | InfraWizardDialog | `components/infra-wizard-dialog.md` | 12 | P0 | ⬜ |
| P1.2 | InfraSetupPage | `components/infra-setup-page.md` | 8 | P0.2 | ⬜ |
| P1.3 | ThemeSchemaPage | `components/theme-schema-page.md` | 6 | P0 | ⬜ |
| P1.4 | DagCanvas | `components/dag-canvas.md` | 15+ | P0.4, P0.6 | ⬜ |
| P1.5 | NodePalette | `components/node-palette.md` | 4 | P0.6 | ⬜ |
| P1.6 | DagNode | `components/dag-node.md` | 10 | P0.4 | ⬜ |
| P1.7 | ConnectionManager | `components/connection-manager.md` | 8 | P0.4 | ⬜ |
| P1.8 | CodePreviewPanel | `components/code-preview-panel.md` | 5 | P0.3 | ⬜ |
| P1.9 | ReviewSummary | `components/review-summary.md` | 4 | P1.1-P1.8 | ⬜ |
| P1.10 | ExecutionPipeline | `components/execution-pipeline.md` | 10 | P0.2 | ⬜ |
| P1.11 | FloatingBadge | `components/floating-badge.md` | 4 | P1.10 | ⬜ |
| P1.12 | TemplateManager | `components/template-manager.md` | 6 | P1.4 | ⬜ |
| P1.13 | AutoLayoutEngine | `components/auto-layout-engine.md` | 3 | P0.4 | ⬜ |
| P1.14 | UndoRedoManager | `components/undo-redo-manager.md` | 4 | P1.4 | ⬜ |

### Phase 2: Architecture

| # | Task | Owner | Output | Depends On | Status |
|---|------|-------|--------|-----------|--------|
| P2.1 | InfraWizard class design — page state machine, data flow, dialog lifecycle | Pixel | `architecture.md` §1 | P1 | ⬜ |
| P2.2 | DAG data model — node graph, topological sort, code generation engine | Pixel+Vex | `architecture.md` §2 | P1.4-P1.7 | ⬜ |
| P2.3 | API orchestration — sequential pipeline, rollback strategy, retry mechanics | Vex | `architecture.md` §3 | P1.10 | ⬜ |
| P2.4 | Template persistence — file format, schema validation, load/save/delete | Vex | `architecture.md` §4 | P1.12 | ⬜ |
| P2.5 | Canvas rendering — node layout, arrow path routing, virtual rendering for scale | Pixel | `architecture.md` §5 | P1.4, P1.13 | ⬜ |
| P2.6 | Code generation — SQL/PySpark template engine, theme data mapping | Vex | `architecture.md` §6 | P0.3, P1.8 | ⬜ |

### Phase 3: State Matrices

| # | Component | Output | States (est.) | Depends On | Status |
|---|-----------|--------|---------------|-----------|--------|
| P3.1 | InfraWizardDialog | `states/infra-wizard-dialog.md` | 12 | P2.1 | ⬜ |
| P3.2 | InfraSetupPage | `states/infra-setup-page.md` | 8 | P2.1 | ⬜ |
| P3.3 | ThemeSchemaPage | `states/theme-schema-page.md` | 6 | P2.1 | ⬜ |
| P3.4 | DagCanvas | `states/dag-canvas.md` | 15+ | P2.2, P2.5 | ⬜ |
| P3.5 | DagNode | `states/dag-node.md` | 10 | P2.2 | ⬜ |
| P3.6 | ConnectionManager | `states/connection-manager.md` | 8 | P2.2 | ⬜ |
| P3.7 | ExecutionPipeline | `states/execution-pipeline.md` | 10 | P2.3 | ⬜ |
| P3.8 | TemplateManager | `states/template-manager.md` | 6 | P2.4 | ⬜ |

### Phase 4: Interactive Mocks

| # | Mock | Output | Depends On | Status |
|---|------|--------|-----------|--------|
| P4.1 | Full wizard (all 5 pages) | `mocks/infra-wizard.html` | P3 | ⬜ |
| P4.2 | DAG canvas standalone | `mocks/dag-canvas.html` | P3.4-P3.6 | ⬜ |
| P4.3 | Execution pipeline | `mocks/execution-pipeline.html` | P3.7 | ⬜ |

---

## 13. Implementation Order (AFTER all prep is done)

```
Layer 0: InfraWizardDialog — modal shell, resize/drag, page navigation, step indicator
Layer 1: InfraSetupPage — workspace/capacity/lakehouse/notebook form
Layer 2: ThemeSchemaPage — theme picker grid, schema multi-select
Layer 3: DagCanvas core — node placement, selection, deletion, zoom/pan
Layer 4: NodePalette — drag-and-drop node types
Layer 5: ConnectionManager — arrow drawing, path routing
Layer 6: DagNode — node popover (rename, type, schema, delete)
Layer 7: AutoLayoutEngine — topological layout algorithm
Layer 8: UndoRedoManager — canvas state snapshots
Layer 9: CodePreviewPanel — auto-generated code display
Layer 10: Code generation engine — SQL/PySpark templates, theme data
Layer 11: ReviewSummary — config summary, mini DAG view
Layer 12: TemplateManager — save/load/delete
Layer 13: ExecutionPipeline — API orchestration, progress UI, rollback
Layer 14: FloatingBadge — minimized state
Layer 15: Integration — wire into workspace-explorer.js, error recovery, polish
```

---

## 14. Non-Goals (V1)

- Custom code editing (user writes their own SQL/PySpark) — auto-generated only
- Environment cloning (that's F20)
- Batch environment creation
- Custom Spark configuration
- Cross-workspace DAGs
- Import DAG from existing notebook
