# F01 Workspace Explorer — Complete UX State Matrix

> **Feature:** F01 Workspace Explorer
> **Status:** Implementation in progress
> **Owner:** Zara (JS) + Mika (CSS) + Kael (UX)
> **Last Updated:** 2026-04-11
> **States Documented:** 150+

---

## How to Read This Document

Every state is documented as:
```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

States are grouped by panel and category. Each state has a unique ID for reference in code reviews and bug reports (e.g., "this violates F01-TREE-015").

---

## 1. TREE PANEL (Left, 260px)

### 1.1 Loading & Data States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-001 | Initial load / shimmer | Page load, API call starts | 8 shimmer skeleton rows (circle + 2 lines each), "WORKSPACES" header with refresh + create buttons | TREE-002 or TREE-003 |
| TREE-002 | Workspaces loaded | API returns 200 | 14 workspace rows, each with ▸ toggle + name. Sorted alphabetically. Shimmer fades out, real content fades in (300ms crossfade) | TREE-010 (hover), TREE-020 (expand) |
| TREE-003 | Zero workspaces | API returns empty array | Icon (empty folder) + "No workspaces found" + "Create your first workspace" text + [Create Workspace] button | TREE-040 (create) |
| TREE-004 | Load failed | API returns 4xx/5xx or network error | Error icon + "Could not load workspaces" + error detail + [Retry] button | TREE-001 (retry) |
| TREE-005 | Load failed (server down) | dev-server.py not running | Full-panel overlay: "Cannot reach EDOG server" + "Is dev-server.py running?" + [Retry] | TREE-001 (retry) |
| TREE-006 | Load slow (>3s) | Network latency | Shimmer continues + "Taking longer than usual..." text appears below shimmer at 3s mark | TREE-002 |
| TREE-007 | 500+ workspaces | API returns large dataset | First 50 render immediately, virtual scroll for rest. "Showing 50 of 532" counter at bottom of tree + search input appears at top | TREE-050 (search) |

### 1.2 Item Interaction States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-010 | Item hover | Mouse enters tree row | Row background: var(--surface-2). Inline action buttons slide in from right: ✎ (rename) + ✕ (delete). Buttons have 0 → 1 opacity, 100ms | TREE-011, TREE-012, TREE-013 |
| TREE-011 | Item hover exit | Mouse leaves tree row | Row background reverts. Action buttons fade out (100ms) | TREE-002 |
| TREE-012 | Item selected | Click on item name (not toggle) | Row background: var(--accent-dim). Left border: 3px solid var(--accent). Previously selected item deselects. Content panel updates. | CONTENT-* |
| TREE-013 | Item right-click | Right-click on any tree item | Context menu appears at click position. Menu items depend on item type (see TREE-070). Click outside or Escape dismisses. | TREE-070 |
| TREE-014 | Item keyboard focus | Tab navigation reaches item | Focus ring: 2px solid var(--accent) with glow. Item name readable by screen reader: "{name}, {type}, under {workspace}" | TREE-012 (Enter), TREE-030 (F2) |
| TREE-015 | Item keyboard select | Enter on focused item | Same as TREE-012 | CONTENT-* |

### 1.3 Expand / Collapse

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-020 | Expanding workspace | Click ▸ toggle or Arrow Right | Toggle changes ▸ to ▾. Shimmer children (3 skeleton rows) appear below with staggered slide-in animation (50ms delay each) | TREE-021 or TREE-023 |
| TREE-021 | Workspace expanded | Children loaded | Real children appear: Lakehouses (green dot), Notebooks (blue book icon), Pipelines (orange zigzag), etc. Each child slides in staggered. Non-lakehouse items dimmed (60% opacity) | TREE-010 |
| TREE-022 | Workspace expanded, empty | Children array empty | "No items in this workspace" text, dimmed, under the workspace row | TREE-002 |
| TREE-023 | Expand failed | Children API returns error | Inline error below workspace: "Could not load items" + small [Retry] link. Toggle reverts to ▸ | TREE-020 (retry) |
| TREE-024 | Collapsing workspace | Click ▾ toggle or Arrow Left | Toggle changes ▾ to ▸. Children animate out with reverse stagger (last item first, 50ms delay). Height collapses smoothly | TREE-002 |
| TREE-025 | Quick toggle | Click expand then immediately collapse | Cancel pending API call. Collapse immediately. No error shown | TREE-002 |
| TREE-026 | Rapid navigation | Click lakehouse A, quickly click lakehouse B | Cancel A's table load. Show B's content. No stale data from A appears. Debounce: 200ms before starting load | CONTENT-* |

### 1.4 Inline Rename

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-030 | Rename start | Click ✎ button, F2 key, or context menu "Rename" | Name text replaced with input field. Input has: accent border, glow ring (box-shadow), pre-filled with current name, all text selected. Action buttons hidden. Keyboard hints: Enter to save, Esc to cancel | TREE-031, TREE-032, TREE-033 |
| TREE-031 | Rename saving | User presses Enter | Input replaced with spinner + "Renaming..." text. Input disabled. API call in progress | TREE-034 or TREE-035 |
| TREE-032 | Rename cancelled | User presses Escape or clicks away | Input reverts to original name text. No API call made. Action buttons return on next hover | TREE-002 |
| TREE-033 | Rename validation | User types empty name or invalid chars | Red border on input. Error text below: "Name cannot be empty" or "Invalid characters". Submit disabled | TREE-030 |
| TREE-034 | Rename success | API returns 200 | Spinner disappears. New name shown. Success toast: "Renamed to '{newName}'" with [Undo] button (5s timeout). Content panel header updates if this item was selected | TREE-002 |
| TREE-035 | Rename failed (409 conflict) | API returns 409 | Error toast: "Name already exists". Input stays open with the conflicting name highlighted. User can type a different name. [Cancel] available | TREE-030 |
| TREE-036 | Rename failed (403 permission) | API returns 403 | Error toast: "You don't have permission to rename this item". Input closes, original name restored | TREE-002 |
| TREE-037 | Rename failed (500 server) | API returns 5xx | Error toast: "Server error: could not rename" with [Retry] button. Input stays open | TREE-031 (retry) |
| TREE-038 | Rename failed (network) | Network error | Error toast: "Network error — check connection" with [Retry]. Input stays open | TREE-031 (retry) |
| TREE-039 | Rename undo | User clicks [Undo] on success toast within 5s | API call to rename back to original name. If undo succeeds: "Reverted to '{oldName}'". If undo fails: "Could not undo — item is now '{newName}'" | TREE-002 |

### 1.5 Create Operations

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-040 | Create workspace start | Click "+" button in WORKSPACES header | Dashed-border row appears at top of tree with "+" icon + input field + keyboard hints (Enter/Esc). Input auto-focused | TREE-041, TREE-042, TREE-043 |
| TREE-041 | Create workspace saving | User presses Enter with valid name | Input disabled, spinner appears. "Creating..." text | TREE-044 or TREE-045 |
| TREE-042 | Create workspace cancelled | Escape or click away | Dashed row disappears. Tree unchanged | TREE-002 |
| TREE-043 | Create workspace validation | Empty name or invalid chars | Red border + error text. Submit blocked | TREE-040 |
| TREE-044 | Create workspace success | API returns 201 | Dashed row transforms into real workspace row with slide-in animation + green flash. Workspace auto-expands. Success toast: "Created workspace '{name}'" with [Undo] (5s). Tree scrolls to show new item | TREE-002 |
| TREE-045 | Create workspace failed (409) | Name already exists | Error toast: "Workspace '{name}' already exists". Input stays open, name highlighted | TREE-040 |
| TREE-046 | Create workspace failed (other) | API error | Error toast with specific message. Input stays open for retry | TREE-041 (retry) |
| TREE-047 | Create lakehouse start | Context menu "Create Lakehouse" on workspace | Dashed-border row appears as first child under workspace (auto-expand if collapsed). Input focused | TREE-048 |
| TREE-048 | Create lakehouse saving | Enter with valid name | Same pattern as TREE-041 | TREE-049 or TREE-050 |
| TREE-049 | Create lakehouse success | API 201 | New lakehouse row slides in with green dot. Content panel shows new lakehouse. Toast: "Created lakehouse '{name}'" with [Undo] | TREE-002 |
| TREE-050 | Create lakehouse failed | API error | Same error patterns as workspace create | TREE-047 |

### 1.6 Delete Operations

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-060 | Delete initiated | Click ✕ button, Delete key, or context menu "Delete" | Item gets subtle red tint (rgba(red, 0.04) background). Confirmation toast appears: ⚠ "Delete '{name}'? This cannot be undone." [Delete] (red) [Cancel] | TREE-061, TREE-062 |
| TREE-061 | Delete confirmed | Click [Delete] on toast | Toast changes to "Deleting..." with spinner. Item pulses red. API call in progress | TREE-063, TREE-064 |
| TREE-062 | Delete cancelled | Click [Cancel] or toast auto-dismisses (5s) | Red tint removed. Item restored to normal state | TREE-002 |
| TREE-063 | Delete success | API returns 200/204 | Item fades out + slides right (200ms). Height collapses smoothly. If this item was selected, content panel clears to placeholder. Toast: "Deleted '{name}'" with [Undo] (5s). Children also removed if workspace | CONTENT-001 |
| TREE-064 | Delete failed (403) | No permission | Error toast: "You don't have permission to delete this item". Red tint removed. Item stays | TREE-002 |
| TREE-065 | Delete failed (children) | Workspace has items | Error toast: "Cannot delete: workspace has {n} items. Delete items first." | TREE-002 |
| TREE-066 | Delete failed (network) | Network error | Error toast: "Network error" with [Retry]. Red tint stays | TREE-061 (retry) |
| TREE-067 | Delete undo | Click [Undo] within 5s | If undo supported: re-create via API + restore in tree. If not: "Undo not available for delete" | TREE-002 |

### 1.7 Context Menu

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-070 | Context menu (workspace) | Right-click workspace | Menu: Expand/Collapse · Copy ID · Open in Fabric · ── · Create Lakehouse · Rename (F2) · Delete (Del) | TREE-* |
| TREE-071 | Context menu (lakehouse) | Right-click lakehouse | Menu: ▶ Deploy to this Lakehouse · Copy ID · Open in Fabric · ── · Add to Favorites · Clone Environment · Rename (F2) · Delete (Del) | TREE-*, CONTENT-* |
| TREE-072 | Context menu (other item) | Right-click notebook/pipeline/etc | Menu: Copy ID · Open in Fabric · ── · Rename (F2) | TREE-030 |
| TREE-073 | Context menu dismiss | Click outside, Escape, or select item | Menu fades out (100ms). If item selected, triggers corresponding action | TREE-002 |
| TREE-074 | Context menu keyboard | Arrow keys in menu | Items highlight. Enter selects. Menu items have keyboard shortcut hints (right-aligned, dimmed) | TREE-* |

### 1.8 Search & Filter

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-080 | Search active | Ctrl+F in tree, or tree has >50 items | Search input appears at top of tree below header. Magnifying glass icon + clear button. Placeholder: "Filter workspaces..." | TREE-081, TREE-082 |
| TREE-081 | Search filtering | User types in search input | Real-time filter: matching items visible (match text highlighted in bold), non-matching items hidden. Expand state preserved. Counter: "4 of 14 workspaces" | TREE-083 |
| TREE-082 | Search no results | No items match search text | All items hidden. "No items match '{query}'" message + [Clear search] button | TREE-080 (clear) |
| TREE-083 | Search cleared | Click ✕ in search or Escape | Full tree restored. Expand/collapse state preserved. Search input clears | TREE-002 |

### 1.9 Favorites

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-090 | Favorites empty | Initial state | "★ FAVORITES" section at bottom of tree. "No favorites yet" dimmed text | TREE-091 |
| TREE-091 | Add favorite | Context menu "Add to Favorites" | Star fills animation (empty → filled with bounce). Lakehouse appears in Favorites section with green dot + name. Toast: "Added to favorites" | TREE-092 |
| TREE-092 | Favorites populated | 1+ favorites saved | Favorites listed at bottom. Click → navigates to workspace + selects lakehouse. Right-click → Remove from Favorites | TREE-012 |
| TREE-093 | Remove favorite | Right-click favorite → Remove | Star empties. Item removed from favorites with fade-out. Toast: "Removed from favorites" | TREE-090 or TREE-092 |

### 1.10 Token States During Tree Operations

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TREE-100 | Token expires during browse | Bearer token expires while scrolling tree | Silent re-auth in background. No visual interruption. If re-auth succeeds: nothing changes. If re-auth fails: see TREE-101 | TREE-002 or TREE-101 |
| TREE-101 | Token re-auth failed | Silent CBA fails (cert revoked, PPE down) | Top banner: "Session expired. Could not re-authenticate." [Sign in] button → triggers full onboarding | F00 onboarding |
| TREE-102 | Token expires during rename | Token expires mid-API-call | Rename fails → error toast: "Session expired during rename. Re-authenticating..." → auto-retry after re-auth succeeds → if retry succeeds: success toast. If retry fails: error with manual retry | TREE-034 or TREE-037 |
| TREE-103 | Token expires during delete | Token expires mid-delete | Similar to TREE-102 but for delete. If delete was already processed server-side: item is gone. If not: item stays with retry option | TREE-063 or TREE-066 |

---

## 2. CONTENT PANEL (Center, flex)

### 2.1 Placeholder States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CONTENT-001 | Nothing selected | Initial load, or after delete clears selection | Large muted icon (folder outline) + "Select a workspace or lakehouse" + "Browse the tree on the left to get started" | CONTENT-010 or CONTENT-020 |
| CONTENT-002 | First-run hint | First time user opens F01 (tracked in localStorage) | Same as CONTENT-001 but with animated arrow pointing left toward tree: "← Click a workspace to explore" | CONTENT-001 (after first interaction) |

### 2.2 Workspace Selected

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CONTENT-010 | Workspace content loading | Workspace clicked in tree | Shimmer: header skeleton + 3 item rows skeleton | CONTENT-011 |
| CONTENT-011 | Workspace content loaded | Data ready | Header: workspace name (large), full GUID (click-to-copy), capacity badge (F2 PPE), region badge (West US 2). Action buttons: [Open in Fabric] [Rename] [Copy ID]. Items table: Name, Type, Last Modified. Sorted by type (Lakehouses first) | TREE-012, CONTENT-020 |
| CONTENT-012 | Workspace content error | API failed | Error state: icon + "Could not load workspace details" + [Retry] | CONTENT-010 (retry) |

### 2.3 Lakehouse Selected

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CONTENT-020 | Lakehouse header | Lakehouse clicked in tree | Header: name (large), full GUID (copy), env badge, region badge, "Modified 30m ago", health badge (● Healthy). Actions: [▶ Deploy to this Lakehouse] [Open in Fabric] [Rename] [Clone Environment]. Below header: TABLES section + MLV section | CONTENT-030 |
| CONTENT-021 | Lakehouse header (no capacity) | Capacity is null | Header: same but no env/region badges. "No capacity assigned" muted text instead | CONTENT-020 |

### 2.4 Tables Section

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CONTENT-030 | Tables loading | Lakehouse selected | "TABLES" section header (no count yet). Shimmer: table header skeleton + 5 row skeletons. Each row: circle + 2 lines | CONTENT-031, CONTENT-033, CONTENT-034 |
| CONTENT-031 | Tables loaded | API returns table list | "TABLES 7" header with count badge. Full data table: Name | Type | Format | Rows | Size. Rows + Size cells may show mini-shimmer if batchGetTableDetails still loading | CONTENT-035 |
| CONTENT-032 | Tables enriched | batchGetTableDetails returns | Rows + Size cells update: shimmer → actual numbers. Numbers animate in (countUp effect) | CONTENT-031 |
| CONTENT-033 | Tables empty | API returns empty array | "TABLES 0" header. "No tables in this lakehouse" + "Tables appear after data is written" help text | — |
| CONTENT-034 | Tables failed (public API) | Public API returns 400 (schema-enabled) | Automatic fallback to MWC capacity host. User sees: shimmer continues, no error shown during fallback. If fallback also fails: CONTENT-036 | CONTENT-031 or CONTENT-036 |
| CONTENT-035 | Tables failed (MWC 502) | Capacity host returns 502 | "Could not load tables" + "Capacity host unavailable (502). The capacity may be restarting." + [Retry] + [Check Capacity Status] link | CONTENT-030 (retry) |
| CONTENT-036 | Tables failed (generic) | Any other error | "Could not load tables" + error message + [Retry] button | CONTENT-030 (retry) |
| CONTENT-037 | Tables failed (auth) | MWC token generation failed | "Authentication error: could not generate MWC token" + [Re-authenticate] → triggers silent CBA → auto-retries | CONTENT-030 |
| CONTENT-038 | 500 tables | Large dataset | Virtual scroll: first 50 visible, scroll loads more. "Showing 50 of 500" counter + "Load all" link. Sticky header stays while scrolling | CONTENT-031 |

### 2.5 Table Interactions

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CONTENT-040 | Table row hover | Mouse enters row | Row background: rgba(accent, 0.03). Subtle left border hint | CONTENT-041 |
| CONTENT-041 | Table row selected | Click on row | Row background: var(--accent-dim). Left border: 3px solid accent. Inspector updates with table details | INSPECTOR-020 |
| CONTENT-042 | Table sort ascending | Click column header | Header shows ▲ indicator in accent color. Rows reorder with smooth position animation (200ms). Other columns show neutral ▲▼ | CONTENT-031 |
| CONTENT-043 | Table sort descending | Click same column header again | Header shows ▼. Rows reorder again | CONTENT-031 |
| CONTENT-044 | Table sort neutral | Click same column third time | Sort cleared, original order restored. All columns show neutral ▲▼ | CONTENT-031 |
| CONTENT-045 | Table text filter | Type in table filter input | Rows filter in real-time. Non-matching rows fade out (150ms). "Showing 3 of 7" counter. Matching text highlighted in row | CONTENT-031 |
| CONTENT-046 | Table multi-select | Shift+click or Ctrl+click rows | Multiple rows get accent background. Batch action bar appears above table: "3 selected" + [Export CSV] [Copy Names] [Deselect All] | CONTENT-047 |
| CONTENT-047 | Table export | Click [Export CSV] | Browser downloads CSV file. Toast: "Exported 3 tables to CSV" | CONTENT-031 |
| CONTENT-048 | Table row right-click | Right-click a table row | Context menu: Copy Name · Copy as JSON · Export Row · Open in Inspector | CONTENT-041, INSPECTOR-020 |

### 2.6 MLV Definitions Section

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CONTENT-050 | MLV loading | After tables load (Phase 2 only) | "MLV DEFINITIONS" header. 3 shimmer cards (placeholder with title + badge skeleton) | CONTENT-051 |
| CONTENT-051 | MLV loaded | API returns definitions | Cards: each shows name, type badge (SQL / PySpark), refresh mode (Auto / Manual), last run time, status badge (Succeeded ✓ / Failed ✕ / Running ●). Click card → Inspector shows MLV detail | INSPECTOR-030 |
| CONTENT-052 | MLV empty | No MLV definitions | "No materialized views defined" + help text | — |
| CONTENT-053 | MLV (Phase 1) | Not connected to FLT | "MLV DEFINITIONS" header + "Deploy to view MLV definitions" with lock icon. Dimmed section | CONTENT-020 |
| CONTENT-054 | MLV card hover | Mouse enters card | Card lifts (translateY -2px) + shadow deepens. Border color transitions to accent | INSPECTOR-030 |
| CONTENT-055 | MLV failed status | Card shows "Failed" | Red border flash on card. Status badge red: "Failed". Tooltip on hover: "Failed at 10:42 — NullReferenceException" | INSPECTOR-030 |

### 2.7 Deploy Flow

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CONTENT-060 | Deploy started | Click [▶ Deploy to this Lakehouse] | Button changes to "Deploying..." with spinner. Progress section appears below header: 5-step horizontal stepper + linear progress bar + step detail text | CONTENT-061 |
| CONTENT-061 | Deploy step 1 | MWC token acquisition | Step 1 circle: accent with pulse ring. Label: "Fetching MWC token..." Progress bar: indeterminate shimmer. [Cancel] button available | CONTENT-062 or CONTENT-067 |
| CONTENT-062 | Deploy step 2 | Patching code | Step 1: green ✓. Step 2: accent pulse. Label: "Patching code — 3 files..." Progress: 40% | CONTENT-063 or CONTENT-068 |
| CONTENT-063 | Deploy step 3 | Building | Step 1-2: green ✓. Step 3: accent. Label: "Building FLT service..." Progress: 60%. Small terminal output area showing build log (last 5 lines, monospace, dark bg) | CONTENT-064 or CONTENT-069 |
| CONTENT-064 | Deploy step 4 | Launching | Steps 1-3: green ✓. Step 4: accent. Label: "Launching service..." Progress: 80% | CONTENT-065 or CONTENT-070 |
| CONTENT-065 | Deploy step 5 | Waiting for ready | Steps 1-4: green ✓. Step 5: accent. Label: "Waiting for service ready..." Progress: 90% + pinging animation | CONTENT-066 or CONTENT-071 |
| CONTENT-066 | Deploy complete | Service responds to ping | All 5 steps: green ✓. Progress: 100% green. "Deployed successfully" text. Phase 2 transition: sidebar Logs/DAG/Spark icons enable with cascade animation (200ms stagger). Top bar status → green "Running 0m01s". Token countdown starts. Success toast with confetti-style accent dots | TREE-002 (Phase 2) |
| CONTENT-067 | Deploy step 1 failed | MWC token error | Step 1: red ✕. Label: "Failed: Capacity is throttled" + error detail. Progress bar: red. [Retry] [Cancel] buttons | CONTENT-061 (retry) |
| CONTENT-068 | Deploy step 2 failed | Patch conflict | Step 2: red ✕. Label: "Patch conflict: GTSBasedSparkClient.cs has changed" + [Force Re-patch] [Cancel] | CONTENT-062 (force) |
| CONTENT-069 | Deploy step 3 failed | Build error | Step 3: red ✕. Label: "Build failed" + first compiler error (file:line:message). [Open in VS Code] link + [Retry] [Cancel] | CONTENT-063 (retry) |
| CONTENT-070 | Deploy step 4 failed | Port in use | Step 4: red ✕. Label: "Port 5555 already in use by PID 12345" + [Kill & Retry] [Cancel] | CONTENT-064 (kill+retry) |
| CONTENT-071 | Deploy step 5 failed | Service timeout | Step 5: red ✕. Label: "Service started but not responding after 30s" + [Check Logs] [Retry] [Cancel] | CONTENT-065 (retry) |
| CONTENT-072 | Deploy cancelled | Click [Cancel] at any step | All progress resets. Patched files reverted. Button returns to "▶ Deploy to this Lakehouse". Toast: "Deploy cancelled" | CONTENT-020 |
| CONTENT-073 | Re-deploy | Already in Phase 2, click Deploy again | Confirmation: "Already deployed. Re-deploy will restart the service." [Re-deploy] [Cancel]. If confirmed: starts from step 1 | CONTENT-060 |

### 2.8 Non-Lakehouse Item Selected

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CONTENT-080 | Item content | Notebook/Pipeline/etc selected | Header: item name, full GUID (copy), type badge (Notebook / Pipeline / etc), "Modified 2h ago". Actions: [Open in Fabric] [Rename]. No tables section. Simple detail view | INSPECTOR-040 |

---

## 3. INSPECTOR PANEL (Right, 300px)

### 3.1 Placeholder States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INSPECTOR-001 | Nothing selected | Initial state, or after item deleted | "INSPECTOR" header + large muted icon (magnifying glass) + "Select an item to inspect" + "Click any workspace, lakehouse, or table to see details here" | INSPECTOR-010 |

### 3.2 Workspace Inspector

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INSPECTOR-010 | Workspace info | Workspace selected in tree | Section "WORKSPACE INFO": Name, full ID (copy), Capacity name + ID, Region, Item count by type (e.g., "3 Lakehouses · 5 Notebooks · 2 Pipelines"), Created date, Last modified | — |

### 3.3 Lakehouse Inspector (no table selected)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INSPECTOR-015 | Lakehouse summary | Lakehouse selected, no table clicked | Section "LAKEHOUSE INFO": Name, full ID, Workspace name, Capacity, Region, Table count, SQL endpoint (if available), OneLake path. Quick actions: [Copy SQL Endpoint] [Copy OneLake Path] | INSPECTOR-020 |

### 3.4 Table Inspector

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INSPECTOR-020 | Table info loading | Table row clicked | Shimmer: 3 key-value pairs + column list skeleton | INSPECTOR-021 |
| INSPECTOR-021 | Table info loaded | getTableDetails returns | Three sections with accent-bar dividers: **TABLE INFO** (Name, Type [MATERIALIZED_LAKE_VIEW/MANAGED/EXTERNAL], Format [Delta/Parquet], Location [OneLake path], Rows, Size) + **SCHEMA** (column table: Name | Type | Nullable, with count badge "8 columns") + **PREVIEW** (loading or loaded) | INSPECTOR-025 |
| INSPECTOR-022 | Table info failed | API error | "Could not load table details" + [Retry] | INSPECTOR-020 (retry) |
| INSPECTOR-023 | Table info — long location | OneLake path is 200+ chars | Path shown in monospace, word-break: break-all. Full path visible. Click to copy | — |
| INSPECTOR-024 | Table info — 200 columns | Large schema | Schema table becomes scrollable (max-height 400px), independent scroll from main inspector | — |

### 3.5 Table Preview

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INSPECTOR-025 | Preview loading | Auto-triggered after schema loads | "PREVIEW" section header + shimmer (3 row skeleton). "Loading first 3 rows..." | INSPECTOR-026, INSPECTOR-027 |
| INSPECTOR-026 | Preview loaded | previewAsync returns | Compact data table: column headers from schema, 3 rows of actual data. Monospace. "First 3 rows" label. [Load more] link for additional rows | — |
| INSPECTOR-027 | Preview failed | previewAsync timeout or error | "Preview unavailable" + muted text: "Table may be empty or preview timed out" + [Retry] | INSPECTOR-025 (retry) |
| INSPECTOR-028 | Preview — empty table | Table has 0 rows | "PREVIEW" section + "Table is empty (0 rows)" | — |

### 3.6 MLV Inspector

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INSPECTOR-030 | MLV detail | MLV card clicked | Sections: **MLV INFO** (Name, Type [SQL/PySpark], Schema, Refresh Mode [Auto/Manual]) + **LAST EXECUTION** (Status badge, Start time, Duration, Error if failed) + **DEFINITION** (SQL code block or "PySpark notebook: {name}" link) + **SCHEDULE** (Cron expression decoded: "Every 30 minutes", next run time) | — |
| INSPECTOR-031 | MLV detail — failed execution | Last run failed | LAST EXECUTION section: red status badge "Failed", error message in red text, "View Logs" link → switches to Logs view filtered by this MLV's timeframe | F04 Logs view |

### 3.7 Non-Lakehouse Item Inspector

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| INSPECTOR-040 | Item info | Notebook/Pipeline selected | Section "ITEM INFO": Name, Type, full ID (copy), Workspace, Last Modified, Description (if available). Actions: [Open in Fabric] | — |

---

## 4. CROSS-CUTTING STATES

### 4.1 Network & Connection

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| NET-001 | Network offline | WiFi drops | Top banner (red): "Network offline — operations will fail until connection is restored" + auto-dismiss when network returns. All pending API calls show retry. Tree/content/inspector freeze on last known data | NET-002 |
| NET-002 | Network restored | Connection returns | Banner auto-dismisses with slide-up. Stale panels auto-refresh. Toast: "Connection restored" | TREE-002 |
| NET-003 | Server down | dev-server.py crashes | Health check fails after 3 retries. Full-page overlay: "EDOG server is not responding" + "Restart with: python scripts/dev-server.py" + [Retry Connection] | NET-002 |
| NET-004 | Slow response | API takes >3s | In affected panel: shimmer continues + "Taking longer than usual..." text. Global: no banner (individual panels handle their own slow state) | — |
| NET-005 | API rate limited (429) | Fabric returns 429 | Toast: "Rate limited by Fabric API. Retrying in {n}s" with countdown. Affected operation retries automatically. Other operations unaffected | — |

### 4.2 Token States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TOKEN-001 | Bearer valid | Token has >10 min remaining | Token chip in top bar: green dot + "42:18" countdown. Sidebar token dot: green | — |
| TOKEN-002 | Bearer expiring | Token has 5-10 min remaining | Token chip: amber dot + countdown. Sidebar dot: amber. No interruption — just visual warning | TOKEN-003 |
| TOKEN-003 | Bearer expiring critical | Token has <5 min remaining | Token chip: red dot + countdown + pulse animation. Sidebar dot: red pulse | TOKEN-004 |
| TOKEN-004 | Bearer expired | Token TTL reaches 0 | Silent re-auth triggered automatically. If succeeds: TOKEN-001 seamlessly. If fails: TOKEN-005 | TOKEN-001 or TOKEN-005 |
| TOKEN-005 | Re-auth failed | Silent CBA fails | Top banner (red pulse): "Session expired — could not re-authenticate" + [Sign In] button. All API calls blocked until re-auth. Tree shows stale data with "Stale" indicator | F00 onboarding |

### 4.3 Keyboard Shortcuts (F01-specific)

| Key | Action | Context |
|-----|--------|---------|
| `1` | Switch to Workspace Explorer | Global (not in input) |
| `↑` / `↓` | Navigate tree items | Tree panel focused |
| `→` | Expand workspace | Tree item focused |
| `←` | Collapse workspace | Tree item focused |
| `Enter` | Select item | Tree item focused |
| `F2` | Start rename | Tree item focused |
| `Delete` | Start delete | Tree item focused |
| `Ctrl+C` | Copy item ID | Tree item focused |
| `Ctrl+F` | Open tree search | Tree panel focused |
| `Escape` | Cancel current operation / close search / dismiss context menu | Any |
| `Tab` | Move focus: tree → content → inspector → tree | Global |
| `Shift+Click` | Multi-select table rows | Content table |
| `Ctrl+Click` | Toggle table row selection | Content table |

### 4.4 Screen Reader Announcements

| Event | Announcement |
|-------|-------------|
| Page load | "EDOG Playground, Workspace Explorer. 14 workspaces loaded." |
| Workspace expand | "{name} expanded. 6 items: 2 lakehouses, 3 notebooks, 1 pipeline." |
| Item selected | "{name}, {type}, selected. Details shown in inspector." |
| Table loaded | "{n} tables loaded for {lakehouse name}." |
| Rename start | "Renaming {name}. Type new name, press Enter to save, Escape to cancel." |
| Rename success | "Renamed to {newName}." |
| Delete confirm | "Confirm deletion of {name}. Press Enter to delete, Escape to cancel." |
| Delete success | "{name} deleted." |
| Error | "Error: {message}. Retry button available." |
| Toast | "{type}: {message}." |
| Deploy step | "Deploy step {n} of 5: {step name}." |
| Deploy complete | "Deployment complete. Service is running." |

### 4.5 Animation Timing Reference

| Animation | Duration | Easing | Use |
|-----------|----------|--------|-----|
| Hover state | 80-120ms | ease-out | Background, border, color changes |
| Active press | 60ms | ease | scale(0.97) |
| Focus ring appear | 0ms | instant | box-shadow glow |
| Content crossfade | 150ms out + 200ms in | ease | Panel content swap |
| Tree item stagger | 50ms per item | ease-out | Expand/collapse children |
| Shimmer sweep | 1.5s | ease-in-out | infinite | Loading skeleton |
| Toast slide-in | 200ms | ease-out | Notification appear |
| Toast slide-out | 150ms | ease-in | Notification dismiss |
| Context menu appear | 100ms | cubic-bezier(0.34,1.56,0.64,1) | Scale from origin |
| Context menu dismiss | 80ms | ease-in | Fade out |
| Inline rename morph | 150ms | ease | Name → input transition |
| Progress step complete | 300ms | cubic-bezier(0.34,1.56,0.64,1) | Checkmark pop |
| Delete fade-out | 200ms | ease-in | Item removal |
| Create slide-in | 250ms | ease-out | New item appear |
| Badge count update | 200ms | ease-out | Number roll |
| Sort reorder | 200ms | ease-out | Row position change |
| Panel resize | continuous | none | Follow mouse |
| Phase 2 transition | 200ms per icon × 3 stagger | ease-out | Sidebar icons enable |

---

## 5. RESPONSIVE BEHAVIOR

| Breakpoint | Layout Change |
|------------|--------------|
| >1400px | Full 3-panel: tree (260px) + content (flex) + inspector (300px) |
| 1000-1400px | tree (220px) + content (flex) + inspector collapses to bottom drawer (click to expand, 250px tall) |
| <1000px | Content only. Tree becomes slide-out panel (hamburger icon in top-left). Inspector as bottom drawer |
| <768px | Not supported — show message "EDOG Playground requires a desktop browser (1000px+)" |

---

*"150 states. Zero blank screens. Zero 'what happened?' moments."*

— F01 Workspace Explorer UX Specification
