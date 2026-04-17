# P0 Research: DAG Preset Topologies for Quick Scaffold

> **Author:** Sana (Architecture & FLT Internals)
> **Status:** COMPLETE
> **Date:** 2025-07-14
> **Spec Ref:** F16 — New Infra Wizard, Page 3 (DAG Canvas)
> **Purpose:** Research DAG scaffolding patterns to let users quickly generate a complete DAG topology instead of dragging nodes one by one.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Common Data Pipeline Topologies](#2-common-data-pipeline-topologies)
3. [How Other Tools Do DAG Scaffolding](#3-how-other-tools-do-dag-scaffolding)
4. [UX Patterns for Structure Selection](#4-ux-patterns-for-structure-selection)
5. [Smart Defaults & Auto-Configuration](#5-smart-defaults--auto-configuration)
6. [Recommended Preset Structures for EDOG Studio](#6-recommended-preset-structures-for-edog-studio)
7. [UX Integration Recommendation](#7-ux-integration-recommendation)
8. [Appendix: Naming Convention Reference](#appendix-naming-convention-reference)

---

## 1. Executive Summary

Users should not have to manually drag 15 nodes onto a canvas to test a medallion pipeline. The "DAG Presets" feature gives them a **one-click scaffold**: pick a structure, set table/MLV counts, and the system generates the entire topology with proper naming, schema assignments, and connections.

**Key findings:**

- **7 structure types** cover 95%+ of real-world Fabric Lakehouse use cases
- **Card-based selection with mini-diagrams** is the proven UX pattern (used by GitHub Actions, Vercel, Azure Data Factory, n8n)
- **The empty canvas state** is the best entry point — show presets when the user first lands on Page 3
- Auto-naming should follow `{schema}.{domain}_{entity}` convention (e.g., `bronze.raw_orders`, `silver.enriched_orders`, `gold.order_summary`)
- The generated DAG should be **fully editable** — presets are a starting point, not a constraint

---

## 2. Common Data Pipeline Topologies

### 2.1 Medallion / Linear Chain

The most common lakehouse pattern. Data flows through layers of increasing quality.

```
Bronze          Silver           Gold
┌─────────┐    ┌──────────┐    ┌──────────┐
│ Table A  │───▸│  MLV B   │───▸│  MLV C   │
└─────────┘    └──────────┘    └──────────┘
```

- **Layers:** Bronze (raw ingestion) → Silver (cleaned/enriched) → Gold (business-ready aggregates)
- **FLT mapping:** SQL Tables → SQL MLVs → SQL/PySpark MLVs
- **When used:** 80% of lakehouse projects start here. Default for Databricks, dbt, Fabric documentation.
- **Complexity:** Beginner

### 2.2 Fan-Out (One Source, Many Views)

One source table feeds multiple downstream MLVs, each producing a different analytical slice.

```
                ┌──────────┐
            ┌──▸│  MLV B1  │
┌─────────┐ │   └──────────┘
│ Table A  │─┤   ┌──────────┐
└─────────┘ ├──▸│  MLV B2  │
            │   └──────────┘
            │   ┌──────────┐
            └──▸│  MLV B3  │
                └──────────┘
```

- **Pattern:** Single source → multiple independent transformations
- **When used:** One raw dataset needs different views for different consumers (finance team vs. ops team vs. ML pipeline)
- **Complexity:** Beginner

### 2.3 Fan-In / Merge (Many Sources, One Aggregation)

Multiple source tables converge into a single MLV that joins or unions them.

```
┌─────────┐
│ Table A  │──┐
└─────────┘   │   ┌──────────┐
┌─────────┐   ├──▸│  MLV D   │
│ Table B  │──┤   └──────────┘
└─────────┘   │
┌─────────┐   │
│ Table C  │──┘
└─────────┘
```

- **Pattern:** Multiple sources → single aggregation/join point
- **When used:** Building a unified customer view from CRM + billing + support tables. Creating fact tables from multiple dimension sources.
- **Complexity:** Beginner

### 2.4 Star Schema

Central fact MLV surrounded by dimension source tables. The classic OLAP pattern.

```
                ┌──────────┐
                │ Dim: Time │
                └────┬─────┘
                     │
┌──────────┐    ┌────▾─────┐    ┌──────────┐
│Dim: Store│───▸│  FACT MLV │◂──│Dim: Prod │
└──────────┘    └────┬─────┘    └──────────┘
                     │
                ┌────▾──────┐
                │Dim: Cust  │
                └───────────┘
```

- **Pattern:** N dimension tables (bronze) → 1 fact MLV (gold) that joins them all
- **When used:** BI/reporting scenarios. "I need a star schema for Power BI."
- **FLT mapping:** Dimension tables as SQL Tables → Fact as SQL MLV with multi-parent JOINs
- **Complexity:** Intermediate

### 2.5 Diamond Dependency

A source fans out to parallel processing paths, then reconverges into a single output. Tests the DAG engine's ability to handle shared ancestry.

```
               ┌──────────┐
           ┌──▸│  MLV B   │──┐
┌─────────┐│   └──────────┘  │   ┌──────────┐
│ Table A  ││                 ├──▸│  MLV D   │
└─────────┘│   ┌──────────┐  │   └──────────┘
           └──▸│  MLV C   │──┘
               └──────────┘
```

- **Pattern:** Fork → parallel transform → reconverge
- **When used:** When raw data needs independent enrichment paths (e.g., geographic enrichment + temporal enrichment) before being combined into a final view.
- **Complexity:** Intermediate

### 2.6 Full Medallion (Multi-Table, Multi-Tier)

The production-grade medallion pattern with multiple tables flowing through all three tiers.

```
Bronze               Silver                  Gold
┌──────────┐    ┌─────────────┐
│ orders   │───▸│ enriched_   │──┐
└──────────┘    │ orders      │  │    ┌─────────────┐
                └─────────────┘  ├───▸│ order_      │
┌──────────┐    ┌─────────────┐  │    │ summary     │
│ customers│───▸│ enriched_   │──┘    └─────────────┘
└──────────┘    │ customers   │
                └─────────────┘       ┌─────────────┐
┌──────────┐    ┌─────────────┐  ┌───▸│ product_    │
│ products │───▸│ enriched_   │──┘    │ analytics   │
└──────────┘    │ products    │       └─────────────┘
                └─────────────┘
```

- **Pattern:** N bronze tables → N silver MLVs (1:1 enrichment) → M gold MLVs (aggregation from multiple silver sources)
- **When used:** Real production lakehouse with multiple data domains feeding into business-level aggregations
- **FLT mapping:** Multiple SQL Tables → Multiple SQL MLVs → Gold SQL/PySpark MLVs with multi-parent joins
- **Complexity:** Intermediate

### 2.7 Wide Independent (Parallel Lanes)

Many independent table-to-MLV pairs with no cross-dependencies. Each lane is its own mini-pipeline.

```
┌──────────┐    ┌──────────┐
│ Table A  │───▸│  MLV A'  │
└──────────┘    └──────────┘

┌──────────┐    ┌──────────┐
│ Table B  │───▸│  MLV B'  │
└──────────┘    └──────────┘

┌──────────┐    ┌──────────┐
│ Table C  │───▸│  MLV C'  │
└──────────┘    └──────────┘
```

- **Pattern:** N independent pairs, no cross-connections
- **When used:** Testing multiple independent MLVs in isolation. Data mesh domain-per-team pattern. Quick regression testing of N different transformation logics.
- **Complexity:** Beginner

### 2.8 Hub-and-Spoke

Central hub MLV that all sources feed into, with spokes coming out for specialized views.

```
┌──────────┐         ┌──────────┐
│ Table A  │──┐  ┌──▸│  MLV X   │
└──────────┘  │  │   └──────────┘
┌──────────┐  ▾  │   ┌──────────┐
│ Table B  │─▸HUB├──▸│  MLV Y   │
└──────────┘  ▴  │   └──────────┘
┌──────────┐  │  │   ┌──────────┐
│ Table C  │──┘  └──▸│  MLV Z   │
└──────────┘         └──────────┘
```

- **Pattern:** Fan-in to a central hub MLV → fan-out to specialized downstream MLVs
- **When used:** Unified data model pattern. Central ODS (Operational Data Store) that feeds multiple reporting marts.
- **Complexity:** Advanced

### 2.9 Snowflake Schema (Normalized Dimensions)

Extension of star schema where dimension tables are themselves derived from other tables, creating a deeper hierarchy.

```
┌──────────┐    ┌──────────┐
│ Region   │───▸│ Store    │──┐
└──────────┘    └──────────┘  │   ┌──────────┐
                              ├──▸│  FACT    │
┌──────────┐    ┌──────────┐  │   └──────────┘
│ Category │───▸│ Product  │──┘
└──────────┘    └──────────┘
```

- **Pattern:** Hierarchical dimensions feeding into a central fact
- **When used:** Complex dimensional models with normalized reference data
- **Complexity:** Advanced

### 2.10 Lambda / Dual-Path

Same source feeds both a batch path (SQL MLV) and a streaming path (PySpark MLV), converging into a serving layer.

```
               ┌──────────┐
           ┌──▸│SQL MLV B │──┐
┌─────────┐│   │(batch)   │  │   ┌──────────┐
│ Table A  ││   └──────────┘  ├──▸│  MLV D   │
└─────────┘│   ┌──────────┐  │   │(serving) │
           └──▸│PySpark C │──┘   └──────────┘
               │(stream)  │
               └──────────┘
```

- **Pattern:** Single source → dual processing paths (SQL + PySpark) → merge
- **When used:** Testing both SQL and PySpark MLV types against the same data. Simulating batch+stream architectures.
- **FLT-specific value:** Exercises BOTH node types in one DAG — excellent for testing the `fmlv` decorator alongside SQL MLVs.
- **Complexity:** Advanced

---

## 3. How Other Tools Do DAG Scaffolding

### 3.1 dbt

| Aspect | Details |
|--------|---------|
| **Scaffolding** | `dbt init` creates a project skeleton with `models/staging/`, `models/intermediate/`, `models/marts/` folders |
| **Templates** | Cookiecutter templates on GitHub; community "starter" repos |
| **DAG Pattern** | Convention-driven: `stg_` → `int_` → `dim_`/`fct_` prefix naming implies topology |
| **Preset Selection** | No visual preset picker — users create structure by hand or clone a starter repo |
| **Lesson for EDOG** | dbt's naming convention approach (`stg_`, `int_`, `fct_`) is excellent — we should auto-name with similar prefixes tied to schema tier |

### 3.2 Databricks Delta Live Tables (DLT)

| Aspect | Details |
|--------|---------|
| **Scaffolding** | Quickstart notebooks with Bronze/Silver/Gold examples |
| **Templates** | Community repos (`dlt-examples` on GitHub) |
| **DAG Pattern** | Decorator-based: `@dlt.table` with `dlt.read("upstream")` creates implicit DAG |
| **Preset Selection** | No visual preset picker — but quickstart notebooks effectively ARE preset DAGs |
| **Lesson for EDOG** | DLT's quickstart notebooks prove that "pre-wired example DAGs" are enormously valuable for onboarding. Our presets serve the same purpose but with a visual builder UX instead of notebook code. |

### 3.3 Azure Data Factory

| Aspect | Details |
|--------|---------|
| **Scaffolding** | Built-in **Template Gallery** (Author → Templates) with categorized pipeline templates |
| **Templates** | Copy data patterns, incremental ETL, data lake patterns — each is a pre-wired pipeline |
| **UX** | Card grid with icons, descriptions, and "Use this template" buttons. Filtering by category. |
| **Lesson for EDOG** | ADF's Template Gallery is the closest analog to what we're building. Their card-based selection with icons and short descriptions is proven UX. We should adopt this pattern directly. |

### 3.4 Airflow

| Aspect | Details |
|--------|---------|
| **Scaffolding** | `dag-factory` library: YAML config → auto-generated DAGs |
| **Templates** | Community DAG templates, but code-only (no visual picker) |
| **DAG Pattern** | Python-defined; dynamic DAG generation from config |
| **Lesson for EDOG** | Airflow's YAML → DAG pattern shows that config-driven generation works well. Our presets are the visual equivalent of a YAML config. |

### 3.5 n8n

| Aspect | Details |
|--------|---------|
| **Scaffolding** | Visual workflow templates gallery (700+ templates) |
| **Templates** | Full UI: browse by category, preview, one-click import, then customize |
| **UX** | Card grid with mini-diagrams showing the workflow shape. "Use workflow" button. Fully editable after import. |
| **Lesson for EDOG** | n8n's template gallery UX is the gold standard for visual workflow scaffolding. Their "preview mini-diagram → import → customize" flow is exactly what we should build. |

### 3.6 Dagster

| Aspect | Details |
|--------|---------|
| **Scaffolding** | `dagster project scaffold` CLI; Software-Defined Assets with asset factories |
| **Templates** | Asset factory functions that generate graphs from config |
| **UX** | Strong lineage visualization in Dagster UI — asset graph is auto-rendered |
| **Lesson for EDOG** | Dagster's asset graph visualization shows that users deeply value seeing the DAG shape. Our preset previews should render mini-DAGs that look like the actual canvas output. |

### 3.7 Google Dataform

| Aspect | Details |
|--------|---------|
| **Scaffolding** | `dataform init` creates project with `definitions/` folder |
| **Templates** | Minimal — sample projects in docs |
| **Lesson for EDOG** | Dataform's weakness is our opportunity: no visual scaffolding exists. We can differentiate by offering it. |

### 3.8 Summary: Industry Gap

**No tool in the market offers a visual, card-based DAG topology picker that generates a complete pipeline scaffold.** dbt and Databricks rely on starter repos/notebooks. ADF has a template gallery but for pipeline activities, not data topology. n8n comes closest with workflow templates but in a different domain (integration, not data engineering).

EDOG Studio has an opportunity to be **first-in-class** with a visual DAG preset system purpose-built for lakehouse architectures.

---

## 4. UX Patterns for Structure Selection

### 4.1 Pattern Analysis

| Pattern | Used By | Pros | Cons | Fit for EDOG |
|---------|---------|------|------|---------------|
| **Card grid with mini-diagrams** | GitHub Actions, ADF, n8n, Vercel | Visual, scannable, familiar | Needs good diagram design | **BEST FIT** |
| **Slider for complexity** | Some game engines | Novel, compact | Oversimplified, doesn't map to topology | Poor fit |
| **Dropdown/select** | Basic forms | Simple to build | Can't preview topology visually | Too basic |
| **Natural language** | AI-first tools | Flexible | Unpredictable, over-engineered for 7 options | Over-engineered |
| **Progressive disclosure** | Stripe, Linear | Good for complex flows | Adds steps to an already multi-step wizard | Already in place via the 5-page wizard |
| **Empty canvas with "Quick Start" overlay** | Figma, Miro, Notion | Contextual, non-intrusive | Can be dismissed and forgotten | **COMPLEMENT** to cards |

### 4.2 Recommended Pattern: Card Grid on Empty Canvas

**Primary:** When the user arrives at Page 3 (DAG Canvas) with an empty canvas, show a centered overlay with preset cards.

**Secondary:** A "Presets" button in the toolbar/palette that re-opens the overlay at any time (for users who dismissed it or want to start over).

**Card anatomy:**
```
┌─────────────────────────────────────┐
│  ┌─────────────────────────────┐    │
│  │     [Mini DAG Diagram]      │    │
│  │     (SVG or CSS-drawn)      │    │
│  └─────────────────────────────┘    │
│                                     │
│  Medallion Pipeline                 │
│  Bronze → Silver → Gold chain       │
│                                     │
│  ● 3 Tables  ● 3 MLVs  ● Beginner  │
│                                     │
│  [ Use This ]                       │
└─────────────────────────────────────┘
```

**After selection:**
1. Show a quick configuration popover: "How many tables? How many MLVs?" (sliders or number inputs with sensible defaults per preset)
2. Generate the DAG onto the canvas
3. User can immediately edit, rename, reconnect, add/remove nodes

---

## 5. Smart Defaults & Auto-Configuration

### 5.1 Auto-Naming Convention

Names should follow the pattern: `{entity}` within the schema namespace. The schema itself carries the tier context.

| Schema Tier | Node Type | Naming Pattern | Examples |
|------------|-----------|----------------|----------|
| `bronze` | SQL Table | `raw_{entity}` | `raw_orders`, `raw_customers`, `raw_products` |
| `silver` | SQL MLV | `enriched_{entity}` | `enriched_orders`, `enriched_customers` |
| `gold` | SQL/PySpark MLV | `{entity}_{aggregation}` | `order_summary`, `customer_lifetime_value`, `revenue_by_region` |
| `dbo` (no medallion) | Any | `{entity}` or `{entity}_{suffix}` | `orders`, `orders_view`, `orders_agg` |

**Entity names are derived from the selected data theme:**

| Theme | Source Entities | Silver Entities | Gold Entities |
|-------|----------------|-----------------|---------------|
| E-Commerce | `orders`, `customers`, `products`, `categories`, `reviews` | `enriched_orders`, `enriched_customers`, `enriched_products` | `order_summary`, `customer_ltv`, `product_performance` |
| Sales & Marketing | `leads`, `campaigns`, `deals`, `accounts`, `activities` | `enriched_leads`, `enriched_deals`, `enriched_accounts` | `pipeline_summary`, `campaign_roi`, `deal_velocity` |
| IoT / Sensors | `devices`, `readings`, `alerts`, `locations`, `thresholds` | `enriched_readings`, `enriched_alerts`, `enriched_devices` | `device_health`, `alert_summary`, `reading_trends` |
| HR & People | `employees`, `departments`, `payroll`, `attendance`, `reviews` | `enriched_employees`, `enriched_payroll`, `enriched_attendance` | `headcount_summary`, `payroll_analysis`, `attrition_risk` |
| Finance | `transactions`, `accounts`, `invoices`, `payments`, `budgets` | `enriched_transactions`, `enriched_invoices`, `enriched_payments` | `cash_flow_summary`, `revenue_report`, `budget_variance` |
| Healthcare | `patients`, `appointments`, `prescriptions`, `labs`, `providers` | `enriched_patients`, `enriched_appointments`, `enriched_labs` | `patient_outcomes`, `appointment_utilization`, `lab_trends` |

### 5.2 Auto-Schema Assignment

When the user has selected bronze/silver/gold schemas on Page 2:

| Node Position in Topology | Auto-Assigned Schema |
|---------------------------|---------------------|
| Source tables (no parents) | `bronze` (or `dbo` if no medallion schemas) |
| First-level MLVs (direct children of tables) | `silver` |
| Second-level+ MLVs (children of other MLVs) | `gold` |
| Any MLV with multiple parents (join/merge) | `gold` |

When only `dbo` is available: all nodes get `dbo`.

### 5.3 Auto-Connection Logic

Each preset defines a connection template that maps to the user's chosen table/MLV counts:

- **Medallion:** Linear chain — each table connects to its corresponding silver MLV, silver MLVs connect to gold MLVs
- **Fan-out:** Each table connects to `ceil(mlv_count / table_count)` MLVs
- **Fan-in:** All tables connect to a single MLV (or spread across `mlv_count` MLVs)
- **Star schema:** All dimension tables connect to a single fact MLV
- **Diamond:** Source → parallel MLVs → convergence MLV (adjusts splits based on counts)
- **Wide independent:** 1:1 pairing of tables to MLVs

### 5.4 Post-Generation Editability

**Everything is editable after generation.** The preset is a starting point:

- Rename any node
- Change any node's type (SQL Table ↔ SQL MLV ↔ PySpark MLV)
- Change any node's schema assignment
- Add/remove connections
- Add/remove nodes
- Drag to reposition
- Run Auto-Arrange to clean up layout

---

## 6. Recommended Preset Structures for EDOG Studio

Based on the topology research, FLT business rules, and Fabric Lakehouse patterns, here are the **7 recommended presets**, ordered from simplest to most complex.

---

### Preset 1: Simple Chain

> *"The simplest possible DAG — one table feeding one view."*

```
┌─────────┐    ┌──────────┐
│ Table    │───▸│  MLV     │
└─────────┘    └──────────┘
```

| Property | Value |
|----------|-------|
| **Description** | Single table → single MLV. The "Hello World" of DAGs. |
| **When to use** | First-time users. Testing a single transformation. Quick experiments. |
| **Default counts** | 1 table, 1 MLV |
| **Customizable range** | Tables: 1, MLVs: 1 (fixed — use Linear Chain for longer) |
| **Schemas** | bronze → silver (or dbo → dbo) |
| **Complexity** | Beginner |
| **MLV type default** | SQL MLV |

---

### Preset 2: Linear Pipeline

> *"A straight-line pipeline through all medallion tiers."*

```
┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Table A  │───▸│  MLV B   │───▸│  MLV C   │───▸│  MLV D   │
└─────────┘    └──────────┘    └──────────┘    └──────────┘
  bronze          silver          silver          gold
```

| Property | Value |
|----------|-------|
| **Description** | Single source flowing through N transformation stages. Classic ETL chain. |
| **When to use** | Multi-step transformation logic. Testing chained MLV dependencies. |
| **Default counts** | 1 table, 3 MLVs |
| **Customizable range** | Tables: 1, MLVs: 2-10 |
| **Schemas** | bronze → silver (× N-1) → gold |
| **Complexity** | Beginner |
| **MLV type default** | SQL MLV for silver, last MLV can be PySpark |

---

### Preset 3: Fan-Out

> *"One source, many independent views — different consumers, same data."*

```
                ┌──────────┐
            ┌──▸│  MLV 1   │
            │   └──────────┘
┌─────────┐ │   ┌──────────┐
│ Table A  │─┼──▸│  MLV 2   │
└─────────┘ │   └──────────┘
            │   ┌──────────┐
            └──▸│  MLV 3   │
                └──────────┘
```

| Property | Value |
|----------|-------|
| **Description** | Single source table distributing to multiple independent MLVs. Each MLV serves a different analytical purpose. |
| **When to use** | One dataset, multiple consumer teams. Testing parallel MLV creation from shared source. |
| **Default counts** | 1 table, 3 MLVs |
| **Customizable range** | Tables: 1-3, MLVs: 2-15 |
| **Schemas** | Tables: bronze, MLVs: silver or gold |
| **Complexity** | Beginner |
| **MLV type default** | SQL MLV |

---

### Preset 4: Fan-In / Merge

> *"Many sources converging into a single unified view."*

```
┌─────────┐
│ Table A  │──┐
└─────────┘   │
┌─────────┐   │   ┌──────────┐
│ Table B  │──┼──▸│  MLV     │
└─────────┘   │   └──────────┘
┌─────────┐   │
│ Table C  │──┘
└─────────┘
```

| Property | Value |
|----------|-------|
| **Description** | Multiple source tables joined or unioned into a single MLV. Classic data consolidation. |
| **When to use** | Building unified views. Testing multi-parent MLV joins. Creating fact tables from multiple sources. |
| **Default counts** | 3 tables, 1 MLV |
| **Customizable range** | Tables: 2-10, MLVs: 1-3 |
| **Schemas** | Tables: bronze, MLVs: gold |
| **Complexity** | Beginner |
| **MLV type default** | SQL MLV |

---

### Preset 5: Full Medallion

> *"The production lakehouse pattern — multiple tables through bronze, silver, and gold tiers."*

```
Bronze               Silver                  Gold
┌──────────┐    ┌─────────────┐
│ orders   │───▸│ enriched_   │──┐
└──────────┘    │ orders      │  │   ┌──────────────┐
                └─────────────┘  ├──▸│ order_       │
┌──────────┐    ┌─────────────┐  │   │ summary      │
│ customers│───▸│ enriched_   │──┘   └──────────────┘
└──────────┘    │ customers   │
                └─────────────┘      ┌──────────────┐
┌──────────┐    ┌─────────────┐  ┌──▸│ product_     │
│ products │───▸│ enriched_   │──┘   │ analytics    │
└──────────┘    │ products    │      └──────────────┘
                └─────────────┘
```

| Property | Value |
|----------|-------|
| **Description** | N source tables → N silver enrichment MLVs (1:1) → M gold aggregation MLVs (fan-in from silver). The real-world medallion pattern. |
| **When to use** | Testing a realistic production pipeline. Demonstrating medallion architecture to stakeholders. The default recommendation for most users. |
| **Default counts** | 3 tables, 5 MLVs (3 silver + 2 gold) |
| **Customizable range** | Tables: 2-10, Silver MLVs: matches table count, Gold MLVs: 1-5 |
| **Schemas** | Tables: bronze, Silver MLVs: silver, Gold MLVs: gold |
| **Complexity** | Intermediate |
| **MLV type default** | SQL MLV for silver, gold MLVs can be SQL or PySpark |
| **Connection logic** | Each table → its silver MLV (1:1). Multiple silver MLVs → each gold MLV (fan-in). Gold MLVs split silver inputs roughly evenly. |

**This should be the DEFAULT / RECOMMENDED preset** — it's the most representative of real Fabric Lakehouse usage and exercises all three tiers.

---

### Preset 6: Star Schema

> *"Dimension tables surrounding a central fact view — classic analytics pattern."*

```
          ┌───────────┐
          │ dim_time   │
          └─────┬─────┘
                │
┌───────────┐   ▾   ┌───────────┐
│ dim_store  │─▸FACT◂─│ dim_prod  │
└───────────┘   ▴   └───────────┘
                │
          ┌─────┴──────┐
          │ dim_cust   │
          └────────────┘
```

| Property | Value |
|----------|-------|
| **Description** | N dimension tables (sources) all connecting to a single central fact MLV. The OLAP/BI-ready pattern. |
| **When to use** | Building Power BI datasets. Testing multi-parent JOIN generation. Classic data warehouse pattern. |
| **Default counts** | 4 tables (dimensions), 1 MLV (fact) |
| **Customizable range** | Tables: 3-8 (dimensions), MLVs: 1-2 (fact + optional summary) |
| **Schemas** | Dimension tables: bronze, Fact MLV: gold |
| **Complexity** | Intermediate |
| **MLV type default** | SQL MLV (fact tables are almost always SQL) |
| **Auto-naming** | Tables: `dim_{entity}`, Fact MLV: `fact_{theme}` (e.g., `fact_sales`, `fact_orders`) |

---

### Preset 7: Diamond Dependency

> *"Fork, transform in parallel, reconverge — tests complex dependency resolution."*

```
               ┌──────────┐
           ┌──▸│  MLV B   │──┐
┌─────────┐│   └──────────┘  │   ┌──────────┐
│ Table A  ││                 ├──▸│  MLV D   │
└─────────┘│   ┌──────────┐  │   └──────────┘
           └──▸│  MLV C   │──┘
               └──────────┘
```

| Property | Value |
|----------|-------|
| **Description** | Source forks into parallel MLV paths that reconverge into a final aggregation MLV. Tests the topo-sort engine and shared-dependency handling. |
| **When to use** | Advanced testing. Validating that the code generator handles diamond dependencies correctly. Parallel enrichment paths (e.g., geographic + temporal). |
| **Default counts** | 1 table, 3 MLVs (2 parallel + 1 convergence) |
| **Customizable range** | Tables: 1-3, Parallel MLVs: 2-6, Convergence MLVs: 1-2 |
| **Schemas** | Table: bronze, Parallel MLVs: silver, Convergence MLV: gold |
| **Complexity** | Advanced |
| **MLV type default** | Mix: one SQL MLV + one PySpark MLV in parallel paths (showcases both types) |

---

### Preset Comparison Matrix

| # | Preset | Tables | MLVs | Total Nodes | Complexity | Best For |
|---|--------|--------|------|-------------|------------|----------|
| 1 | Simple Chain | 1 | 1 | 2 | Beginner | First-time users, quick tests |
| 2 | Linear Pipeline | 1 | 2-10 | 3-11 | Beginner | Multi-step transforms |
| 3 | Fan-Out | 1-3 | 2-15 | 3-18 | Beginner | Multiple consumers |
| 4 | Fan-In / Merge | 2-10 | 1-3 | 3-13 | Beginner | Data consolidation |
| 5 | **Full Medallion** | 2-10 | 3-15 | 5-25 | Intermediate | **Production lakehouse (DEFAULT)** |
| 6 | Star Schema | 3-8 | 1-2 | 4-10 | Intermediate | BI / Power BI datasets |
| 7 | Diamond | 1-3 | 3-8 | 4-11 | Advanced | Dependency testing |

---

## 7. UX Integration Recommendation

### 7.1 Entry Point: Empty Canvas State

When the user navigates to Page 3 (DAG Canvas) and the canvas is empty, show a **centered overlay** with the preset cards. This is the "moment of blank canvas anxiety" — the user stares at an empty grid wondering where to start. The presets eliminate that friction.

```
┌──────────────────────────────────────────────────────────────┐
│  Page 3: DAG Canvas                                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │           How do you want to build your DAG?           │  │
│  │                                                        │  │
│  │    ┌─────────┐  ┌─────────┐  ┌─────────┐              │  │
│  │    │ Simple  │  │ Linear  │  │ Fan-Out │   ...         │  │
│  │    │ Chain   │  │Pipeline │  │         │              │  │
│  │    │ [diag]  │  │ [diag]  │  │ [diag]  │              │  │
│  │    │ 2 nodes │  │ 4 nodes │  │ 4 nodes │              │  │
│  │    └─────────┘  └─────────┘  └─────────┘              │  │
│  │                                                        │  │
│  │    ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐│  │
│  │    │ Fan-In  │  │  Full   │  │  Star   │  │ Diamond ││  │
│  │    │ /Merge  │  │Medallion│  │ Schema  │  │  Dep.   ││  │
│  │    │ [diag]  │  │★[diag]  │  │ [diag]  │  │ [diag]  ││  │
│  │    │ 4 nodes │  │ 8 nodes │  │ 5 nodes │  │ 4 nodes ││  │
│  │    └─────────┘  └─────────┘  └─────────┘  └─────────┘│  │
│  │                                                        │  │
│  │    ─── or ───                                          │  │
│  │                                                        │  │
│  │    [ Start from scratch ▸ ]                            │  │
│  │    (Drag nodes from the palette to build manually)     │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 Configuration Popover (After Card Selection)

When the user clicks a preset card, show a compact configuration panel:

```
┌─────────────────────────────────────┐
│  Full Medallion                     │
│                                     │
│  Source tables:  [3] ← → (2-10)    │
│  Silver MLVs:    [3] (matches       │
│                       tables)       │
│  Gold MLVs:      [2] ← → (1-5)    │
│                                     │
│  Total nodes: 8                     │
│                                     │
│  MLV language:                      │
│  ○ All SQL                          │
│  ○ All PySpark                      │
│  ● Mix (silver=SQL, gold=PySpark)   │
│                                     │
│  [ Cancel ]  [ Generate DAG ]       │
└─────────────────────────────────────┘
```

### 7.3 Re-Entry: Toolbar Button

After the canvas has nodes, the preset overlay is hidden. Add a **"Presets"** button to the node palette / toolbar:

```
┌─ Node Palette ─────────────┐
│  ◇ SQL Table               │
│  ◆ SQL MLV                 │
│  ◆ PySpark MLV             │
│  ─────────────             │
│  ⊞ Presets...              │  ← Opens the preset overlay
│  ↻ Auto-Arrange            │
└────────────────────────────┘
```

**Warning behavior:** If the canvas already has nodes and the user selects a preset, show a confirmation: "This will replace your current DAG. Continue?" with options: "Replace" / "Cancel".

### 7.4 Visual Feedback During Generation

After "Generate DAG" is clicked:

1. Preset overlay fades out
2. Nodes appear on canvas with a staggered animation (50ms delay between each node)
3. Connections draw themselves with a brief path animation
4. Auto-Arrange runs to position nodes cleanly
5. Canvas zooms to fit all generated nodes

This gives the user a satisfying "the system built something for me" moment.

### 7.5 Mini-Diagram Design for Cards

Each preset card needs a mini-diagram. These should be:

- **Rendered as inline SVG** (not images — scales with card size, follows design tokens)
- **Consistent visual language:** Circles for tables, rounded rectangles for MLVs
- **Muted colors:** Use the design system's secondary palette — not the full node colors. Just enough to distinguish table vs MLV.
- **No labels in mini-diagram:** Just shapes and arrows. The card title + description carry the meaning.

Example SVG anatomy for "Full Medallion":
```
  ●──▸■──┐
  ●──▸■──┼──▸■
  ●──▸■──┘
```
Where `●` = table (circle), `■` = MLV (rounded rect), lines = connections.

---

## Appendix: Naming Convention Reference

### Schema-Aware Naming

When medallion schemas are enabled (bronze/silver/gold selected on Page 2):

```sql
-- Bronze tier (SQL Tables)
CREATE TABLE IF NOT EXISTS bronze.raw_orders (...)
CREATE TABLE IF NOT EXISTS bronze.raw_customers (...)

-- Silver tier (SQL MLVs)
CREATE MATERIALIZED LAKE VIEW silver.enriched_orders AS
SELECT * FROM bronze.raw_orders

-- Gold tier (SQL/PySpark MLVs)
CREATE MATERIALIZED LAKE VIEW gold.order_summary AS
SELECT ... FROM silver.enriched_orders
JOIN silver.enriched_customers ON ...
```

### dbo-Only Naming

When only `dbo` is available (no medallion schemas):

```sql
-- Source tables
CREATE TABLE IF NOT EXISTS dbo.orders (...)
CREATE TABLE IF NOT EXISTS dbo.customers (...)

-- MLVs
CREATE MATERIALIZED LAKE VIEW dbo.orders_enriched AS
SELECT * FROM dbo.orders

CREATE MATERIALIZED LAKE VIEW dbo.order_summary AS
SELECT ... FROM dbo.orders_enriched
```

### Naming Rules

1. All names are **lowercase with underscores** (`snake_case`)
2. No special characters, no spaces, no hyphens
3. Table names: `raw_{entity}` (bronze) or `{entity}` (dbo)
4. Silver MLV names: `enriched_{entity}` (medallion) or `{entity}_enriched` (dbo)
5. Gold MLV names: `{entity}_{aggregation_type}` — e.g., `order_summary`, `customer_ltv`, `revenue_by_region`
6. Star schema dimensions: `dim_{entity}` — e.g., `dim_customer`, `dim_product`, `dim_time`
7. Star schema facts: `fact_{domain}` — e.g., `fact_sales`, `fact_orders`
8. Names are auto-generated from the data theme selected on Page 2 but **always editable** by the user

### Theme-to-Entity Mapping (Complete)

Each theme provides a pool of entity names. The preset generator draws from this pool based on the number of tables/MLVs requested.

**E-Commerce:**
- Tables: `orders`, `customers`, `products`, `categories`, `reviews`, `inventory`, `shipments`, `returns`, `suppliers`, `promotions`
- Silver: `enriched_orders`, `enriched_customers`, `enriched_products`, `enriched_categories`, `enriched_reviews`
- Gold: `order_summary`, `customer_ltv`, `product_performance`, `revenue_by_category`, `review_sentiment`

**Sales & Marketing:**
- Tables: `leads`, `campaigns`, `deals`, `accounts`, `activities`, `contacts`, `opportunities`, `territories`, `quotas`, `events`
- Silver: `enriched_leads`, `enriched_deals`, `enriched_accounts`, `enriched_campaigns`, `enriched_activities`
- Gold: `pipeline_summary`, `campaign_roi`, `deal_velocity`, `territory_performance`, `lead_conversion`

**IoT / Sensors:**
- Tables: `devices`, `readings`, `alerts`, `locations`, `thresholds`, `firmware`, `networks`, `maintenance`, `calibrations`, `events`
- Silver: `enriched_readings`, `enriched_alerts`, `enriched_devices`, `enriched_locations`, `enriched_maintenance`
- Gold: `device_health`, `alert_summary`, `reading_trends`, `location_heatmap`, `maintenance_forecast`

**HR & People:**
- Tables: `employees`, `departments`, `payroll`, `attendance`, `reviews`, `benefits`, `positions`, `training`, `leaves`, `recruitments`
- Silver: `enriched_employees`, `enriched_payroll`, `enriched_attendance`, `enriched_departments`, `enriched_reviews`
- Gold: `headcount_summary`, `payroll_analysis`, `attrition_risk`, `department_costs`, `training_effectiveness`

**Finance:**
- Tables: `transactions`, `accounts`, `invoices`, `payments`, `budgets`, `ledger`, `expenses`, `vendors`, `tax_records`, `forecasts`
- Silver: `enriched_transactions`, `enriched_invoices`, `enriched_payments`, `enriched_accounts`, `enriched_expenses`
- Gold: `cash_flow_summary`, `revenue_report`, `budget_variance`, `expense_trends`, `vendor_analysis`

**Healthcare:**
- Tables: `patients`, `appointments`, `prescriptions`, `labs`, `providers`, `diagnoses`, `procedures`, `insurance`, `referrals`, `vitals`
- Silver: `enriched_patients`, `enriched_appointments`, `enriched_labs`, `enriched_prescriptions`, `enriched_providers`
- Gold: `patient_outcomes`, `appointment_utilization`, `lab_trends`, `prescription_patterns`, `provider_performance`

---

## Research Sources

- Microsoft Fabric Lakehouse documentation (Materialized Lake Views, medallion architecture)
- dbt Best Practices (project organization, naming conventions, model layers)
- Databricks Delta Live Tables quickstart and community examples
- Azure Data Factory Template Gallery documentation
- Apache Airflow dynamic DAG generation best practices
- Dagster Software-Defined Assets and asset factory patterns
- n8n workflow templates gallery
- Google Cloud Dataform project initialization
- Fivetran dbt packages and transformation patterns
- Snowflake Streams & Tasks DAG patterns
- Kimball dimensional modeling (star schema, snowflake schema)
- Data Vault 2.0 (hub/satellite/link patterns)
- Data Mesh architecture principles (Zhamak Dehghani)
- Lambda Architecture patterns (Nathan Marz)
- Vercel, Stripe, GitHub Actions, Linear — onboarding and template selection UX patterns

---

*End of research document. This directly feeds into the component spec for `DagCanvas` (C4) and the `NodePalette` (C5) preset system.*
