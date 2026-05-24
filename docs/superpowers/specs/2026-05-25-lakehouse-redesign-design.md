# Lakehouse Detail View Redesign — Design Spec

**Date:** 2026-05-25
**Author:** Pixel (frontend agent)
**Status:** Draft

## Summary

Redesign the lakehouse detail view to match the quality bar set by the workspace hero card, adding an overview stats strip and replacing the side inspector panel with an inline detail drawer that expands per-row.

## Scope

**In scope:**
- Hero card (transplant from workspace view)
- Overview stats strip (4-stat grid)
- Action bar (same pattern, lakehouse-specific buttons)
- Schema-grouped tables with inline detail drawer (replaces inspector)
- MLV card grid section
- Empty state

**Out of scope:**
- DAG Studio integration
- SQL Endpoint page
- Table data preview / sample rows loading (existing behavior preserved)
- Deploy progress UI (unchanged)

## Design Decisions

### D1: Hero card pattern — transplant, not reinvent

The workspace view's `.ws-hero` card is the gold standard. The lakehouse hero uses the exact same structure:
- 3px accent left bar
- Gradient background (surface → surface-2)
- Name at 24px/700, GUID chip with click-to-copy, env pill (PPE/PROD), status pill with breathing animation
- Capacity sub-card nested inside the hero (icon, name, SKU pill, ID, region)
- Icon-only action buttons in top-right (rename, open-in-fabric, clone) — 30×30, radius-md, transparent bg
- Activity timestamp row at bottom

### D2: Overview stats strip — new element

A 4-column grid below the hero showing aggregate lakehouse metrics:

| Stat | Source | Fallback |
|------|--------|----------|
| Tables | `tables.length` | Always available from `getLatestDag` |
| Schemas | `Set(tables.map(t => t.schemaName)).size` | Always available |
| Total Rows | `sum(tables.map(t => t.rowCount))` | Shimmer → "—" until enriched |
| Total Size | `sum(tables.map(t => t.sizeBytes))` | Shimmer → "—" until enriched |

Each stat card has a 2px colored left accent (accent/teal/blue/amber) for visual distinctness. Values use mono font.

### D3: Inline detail drawer replaces inspector panel

**Current:** Clicking a table row selects it and populates a right-side `ws-inspector-panel` (fixed-width, steals horizontal space, disconnected from the row).

**New:** Clicking a table row expands an inline detail drawer directly below the row. The drawer contains:

**Left column (200px) — Table Info KV:**
- Name, Type, Format, Schema, Location, Last Modified
- Uses the `ws-insp-title` + `ws-insp-kv` patterns (3px accent left border on title)

**Right column (flex) — Column Schema:**
- Wrapping chip grid (auto-fill, minmax 180px)
- Each chip: `name` (mono, weight 500) + `type` (mono, muted) + optional `NULL` indicator
- Title: "Schema (N columns)" with 3px teal left border

**Footer row — Actions:**
- "View DDL" / "Sample Rows" / "Copy Path" — text links separated by 1px vertical dividers
- View DDL triggers the existing `_handlePreviewLoad` flow
- Sample Rows triggers the existing sample-rows modal
- Copy Path copies the OneLake table path

**Behavior:**
- Only one drawer open at a time (opening a new one collapses the previous)
- Expand/collapse chevron (▸) in the first column, rotates 90° when expanded
- Schema is auto-loaded on expand (same `_autoLoadSchema` flow), shown as shimmer until ready
- Keyboard: Enter/Space on focused row toggles drawer

### D4: Action bar

Same `.ws-v2-actions` pattern. Buttons:

| Button | Style | Condition |
|--------|-------|-----------|
| Deploy | `btn-primary` (gradient) | Always visible |
| Stop Service | `btn-danger` (outline) | Only when FLT is running |
| API Explorer | `btn-ghost` | Always (right-aligned) |
| SQL Endpoint | `btn-ghost` | Always (right-aligned) |

### D5: MLV cards section

Shown only when the lakehouse contains materialized lake views. Uses the existing `.ws-mlv-card` + `.ws-mlv-grid` pattern (3-col grid). Each card shows:
- View name (mono, weight 600)
- Schema + last refresh time
- Status dot + label (succeeded/failed/pending)
- 3px left accent colored by status
- Failed cards get error tint background

### D6: Empty state

When the lakehouse has zero tables, show the `.ws-empty-state` pattern: centered column with faded lakehouse icon, "No tables yet" title, descriptive text. No action button (deploy is in the action bar).

## CSS Changes

All new CSS classes use the `ws-` prefix (consistent with existing workspace CSS). New classes:

```
/* Hero card — same structure as ws-hero, no new prefix needed */
/* Stats strip */
.ws-lh-stats-grid
.ws-lh-stat
.ws-lh-stat-num
.ws-lh-stat-label

/* Detail drawer */
.ws-lh-detail-drawer
.ws-lh-detail-content
.ws-lh-detail-meta
.ws-lh-detail-schema
.ws-lh-col-grid
.ws-lh-col-chip
.ws-lh-detail-footer
.ws-lh-detail-action

/* Expand chevron in table */
.ws-expand-chevron
```

All values use design tokens (`--space-*`, `--text-*`, `--surface-*`, `--border-*`, `--radius-*`, `--accent-*`). No hardcoded colors or sizes outside the token system.

## JS Changes

### `workspace-explorer.js`

**`_showLakehouseContent(lh, ws)` — rewrite:**
1. Build hero card HTML (name, GUID, env pill, status pill, capacity sub-card, icon actions, activity)
2. Build stats strip (tables count, schemas count, total rows, total size — with shimmer for unenriched)
3. Build action bar (deploy, stop, API explorer, SQL endpoint)
4. Build schema-grouped tables (existing `_renderTablesBySchema` logic, add expand chevron column)
5. Build MLV section (if any MLVs exist)
6. Bind row-click to toggle detail drawer

**`_showTableInspector(table)` — deprecate:**
- Remove the inspector panel from lakehouse view
- Inspector remains for non-lakehouse item types (if any use it)

**New method `_toggleTableDrawer(row, table)`:**
1. Collapse any open drawer
2. If clicking the already-open row, just collapse (toggle off)
3. Otherwise, create drawer HTML below the row
4. Auto-load schema if not cached
5. Bind footer action handlers (DDL, sample rows, copy path)

**New method `_renderStatsStrip(tables)`:**
1. Count tables, count unique schemas
2. Sum rows and sizes (skip null/undefined)
3. Return HTML grid with 4 stat cards
4. If rows/size not yet enriched, return shimmer skeletons

**Existing `_renderTablesBySchema()` — modify:**
- Add expand chevron as first column in thead and tbody
- Add `data-table-id` attribute to each row for drawer targeting
- Selected row class changes from inspector-driven to drawer-driven

### Event flow

```
Row click → _toggleTableDrawer(row, table)
  → collapse previous drawer (if any)
  → insert drawer <tr> after clicked row
  → if !table.schema → _autoLoadSchema(table) → on success, re-render drawer schema section
  → bind footer actions
```

## Tokens Used

All from existing `variables.css`:
- Surfaces: `--surface`, `--surface-2`, `--surface-3`
- Text: `--text`, `--text-dim`, `--text-muted`
- Accent: `--accent`, `--accent-dim`
- Border: `--border`, `--border-bright`
- Radius: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-full`
- Spacing: `--space-1` through `--space-8`
- Typography: `--text-xs` through `--text-xl`, `--font-body`, `--font-mono`
- Shadows: `--shadow-sm`
- Status: `--status-succeeded`, `--status-failed`
- Transitions: `--transition-fast` (80ms ease-out)

No new tokens required.

## Accessibility

- Detail drawer toggle via Enter/Space on focused row
- Chevron uses `aria-expanded` attribute
- Drawer region has `role="region"` and `aria-label="Table details for {name}"`
- Focus moves into drawer on expand, returns to row on collapse
- Column chips are not interactive (no focus trap)
- All icon buttons have `title` attributes (existing pattern)

## Testing Impact

- Existing table rendering tests need updated snapshots (new chevron column)
- New unit tests for `_toggleTableDrawer` behavior
- New unit tests for `_renderStatsStrip` with enriched and unenriched data
- Inspector panel removal should not break other views that don't use it

## Mockup Reference

Full interactive mockup served via visual companion (port 60126) during brainstorming session.
