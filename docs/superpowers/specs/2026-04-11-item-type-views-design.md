# Type-Specific Item Views — Design Spec

> **Date:** 2026-04-11
> **Author:** Kael Andersen (UX) + Zara Okonkwo (JS) + Donna (coordinator)
> **Status:** Draft — awaiting review

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
