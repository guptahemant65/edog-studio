# F16 Enhanced Presets: Preset + Batch Palette Hybrid

**Date:** 2026-05-21
**Author:** Sana (architecture) + Pixel (frontend)
**Feature:** F16 — Environment Wizard, DAG Canvas (Page 2)

---

## 1. Problem

Current presets are rigid — "Medallion" always creates exactly 7 nodes. Users who need
15 bronze tables, 5 silver views, and 2 gold aggregates must click the palette 22 times,
one node at a time. The palette has no batch-add capability.

## 2. Solution: Preset + Batch Palette Hybrid

Two complementary changes:

**A. Presets stay as quick-seed templates** — click a card, get a starting topology.
No configuration step. Names are edited later on the canvas via the node popover.

**B. Palette gains parameterized batch-add** — each node type (SQL Table, SQL MLV,
PySpark MLV) expands into a config form with count, schema, and naming pattern.
One click deploys N nodes, auto-laid out and ready for connections.

Together: preset seeds the skeleton, palette fills it out.

## 3. Batch Palette Design

### 3.1 Palette Item States

Each palette item has two modes:

```
COLLAPSED (default):
  ┌──────────────────────┐
  │ ◇ SQL Table     [+]  │   ← click [+] to add one (current behavior)
  │                  [▾]  │   ← click [▾] to expand batch config
  └──────────────────────┘

EXPANDED:
  ┌──────────────────────┐
  │ ◇ SQL Table     [▴]  │
  ├──────────────────────┤
  │ Count:    [- 3 +]    │   ← stepper (1–20, clamped to remaining capacity)
  │ Schema:   [bronze ▾] │   ← dropdown, filtered by medallion level
  │ Pattern:  [raw_{n}]  │   ← naming template, {n} = sequence number
  │                      │
  │     [ Add 3 nodes ]  │   ← primary action button
  └──────────────────────┘
```

### 3.2 Parameters

| Parameter | Type | Default | Constraints |
|-----------|------|---------|-------------|
| Count | stepper | 1 | min=1, max=min(20, remaining capacity) |
| Schema | dropdown | first enabled schema | only schemas enabled by medallion level |
| Pattern | text input | type-specific (see below) | must contain `{n}` |

**Default naming patterns:**
- SQL Table: `raw_{n}`
- SQL MLV: `view_{n}`
- PySpark MLV: `transform_{n}`

**Pattern with schema prefix:** When a medallion schema is selected, the pattern
auto-prefixes with the schema prefix (e.g., `brz_raw_{n}` for bronze).
User can override.

### 3.3 Generated Names

Pattern `raw_{n}` with count=3 generates: `raw_1`, `raw_2`, `raw_3`.

If `raw_1` already exists on canvas, sequence skips: `raw_2`, `raw_3`, `raw_4`.
Name uniqueness is enforced against ALL existing nodes, not just same-type.

### 3.4 Capacity Guard

Max nodes = 100.

- Stepper max is dynamically clamped: `min(20, 100 - currentNodeCount)`
- When canvas is at 100 nodes, the entire batch form is disabled with a message
- At 90+ nodes, the "Add N nodes" button shows remaining count: "Add 3 (7 left)"

## 4. State Matrix

### 4.1 Canvas States

| # | Canvas | Preset Overlay | Palette | Batch Form |
|---|--------|---------------|---------|------------|
| S0 | Empty (0 nodes) | Visible | Visible | Collapsed |
| S1 | Preset applied | Hidden (dismissed) | Visible | Collapsed |
| S2 | Nodes from manual add | Hidden (dismissed) | Visible | Collapsed |
| S3 | Batch form open | Hidden or N/A | Visible | Expanded |
| S4 | At capacity (100) | Hidden | Visible (disabled) | Disabled |
| S5 | Near capacity (90+) | Hidden | Visible (warning) | Clamped count |

### 4.2 State Transitions

```
S0 ──[click preset card]──→ S1
S0 ──[click "Start from scratch"]──→ S2 (empty but dismissed)
S0 ──[click palette +]──→ S2
S0 ──[click palette ▾]──→ S3
S1 ──[click palette ▾]──→ S3
S2 ──[click palette ▾]──→ S3
S3 ──[click "Add N"]──→ S1/S2 (form collapses, nodes on canvas)
S3 ──[click ▴]──→ S1/S2 (form collapses, no change)
S* ──[node count hits 100]──→ S4
S* ──[node count hits 90]──→ S5
S4 ──[delete nodes below 100]──→ S1/S2
```

### 4.3 Preset Overlay vs Batch Form

Only one can be active. If preset overlay is visible (S0) and user clicks
palette expand (▾), the preset overlay dismisses. Rationale: user chose
manual mode over presets.

## 5. Edge Cases

### 5.1 Name Collisions

| Scenario | Behavior |
|----------|----------|
| Pattern `raw_{n}`, `raw_1` exists | Skip to `raw_2` |
| Pattern `raw_{n}`, `raw_1`, `raw_2`, `raw_3` exist | Start from `raw_4` |
| All names `raw_1`..`raw_100` exist | Show error "All names in pattern are taken" |
| User clears pattern to empty | Disable "Add" button, show validation hint |
| Pattern without `{n}` (e.g., `orders`) | Append sequence: `orders_1`, `orders_2`... |

### 5.2 Schema Edge Cases

| Scenario | Behavior |
|----------|----------|
| Medallion level = 0 (none) | Schema dropdown shows only "dbo" |
| Medallion level = 1 (bronze) | Dropdown: dbo, bronze |
| Medallion level = 3 (all) | Dropdown: dbo, bronze, silver, gold |
| User changes medallion AFTER batch config open | Dropdown re-filters on page re-activate |
| Schema selected in dropdown no longer valid | Reset to first available |

### 5.3 Capacity Edge Cases

| Scenario | Behavior |
|----------|----------|
| 95 nodes on canvas, count stepper at 10 | Clamp to 5, show "(5 remaining)" |
| 100 nodes, click palette ▾ | Form shows "Canvas is full" message, no inputs |
| Batch add would exceed limit mid-operation | Add as many as possible, toast with count |
| Delete nodes then try again | Stepper re-reads canvas count, unlocks |

### 5.4 Undo/Redo

| Scenario | Behavior |
|----------|----------|
| Batch add 5 nodes, undo | All 5 removed in single undo step |
| Batch add 5 nodes, undo, redo | All 5 restored in single redo step |
| Batch add, then manually delete 2, undo | Manual deletes are separate undo steps |

Implementation: wrap batch add in `canvas.batchOperation(fn)` — the existing
mechanism that suppresses intermediate events and groups operations.

### 5.5 Auto-Layout After Batch Add

After batch add, call `canvas.autoLayout()` to position new nodes cleanly.
If the canvas already has nodes, only layout the newly-added nodes to avoid
disrupting existing topology.

**Decision needed:** Should auto-layout move ALL nodes or just new ones?
Recommendation: layout ALL — partial layout creates awkward gaps. User
can undo if they don't like the result.

## 6. UI Components Changed

| Component | Change |
|-----------|--------|
| `wizard-node-palette.js` | Add expand/collapse, batch form, count stepper, schema dropdown, pattern input |
| `wizard-dag-canvas.js` | No change (addNode + batchOperation already support this) |
| `wizard-dag-presets.js` | Minor: dismiss overlay when palette expand is clicked |
| `wizard-dag-canvas-page.js` | Wire new palette events, pass schema info |
| `infra-wizard.css` | Batch form styles, expanded palette item styles |

## 7. Data Flow

```
User configures batch form
        │
        ▼
  Palette._batchAdd(type, count, schema, pattern)
        │
        ▼
  canvas.batchOperation(function() {
    for (i = 0; i < count; i++) {
      var name = resolveUniqueName(pattern, i, existingNames);
      canvas.addNode(type, null, { name: name, schema: schema });
    }
  })
        │
        ▼
  canvas.autoLayout()
        │
        ▼
  EventBus → NODE_ADDED (fires once per node, batched)
        │
        ▼
  Presets._updateVisibility() → hides overlay (nodeCount > 0)
  Palette._updateNodeCount() → updates counter
  CodePreview._refresh() → regenerates code
```

## 8. What We're NOT Doing

- **Removing single-node workflows** — click-to-add `[+]` and drag-to-position
  remain untouched. Batch form is additive, not a replacement. Users who prefer
  dragging nodes one at a time onto the canvas still do exactly that.
- **Parameterized preset cards** — rejected. Presets stay simple click-to-seed.
- **Auto-connection after batch add** — too opinionated. User wires manually.
- **Name editing before build** — rejected. Edit on canvas via popover.
- **Custom user-saved presets/templates** — future feature, out of scope.
- **Batch drag-drop** — dragging a group of nodes from palette to canvas.
  Batch nodes are placed via auto-layout. Single-node drag-to-position remains.
