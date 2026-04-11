# F03 Favorites / Named Environments — Complete UX State Matrix

> **Feature:** F03 Favorites / Named Environments
> **Status:** Spec complete, not yet implemented
> **Owner:** Kael (UX) + Zara (JS) + Elena (persistence)
> **Last Updated:** 2025-07-14
> **States Documented:** 95+

---

## How to Read This Document

Every state is documented as:
```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

States are grouped by panel and category. Each state has a unique ID for reference in code reviews and bug reports (e.g., "this violates F03-FAV-015").

**Relationship to F01:** The Favorites section lives inside the Tree Panel defined in F01 (below the workspace list). States here extend the F01 tree panel and reference F01 state IDs (TREE-*, CONTENT-*) for navigation handoffs.

---

## 1. FAVORITES SECTION (Bottom of Tree Panel)

### 1.1 Section Chrome & Layout

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-001 | Section visible (empty) | Page load, no favorites saved | "★ FAVORITES" header (dimmed star, uppercase, var(--text-3)). Below: "No favorites yet" dimmed text + "Right-click a lakehouse and choose Add to Favorites" help text. Section height: auto-collapse to ~48px | FAV-010 |
| FAV-002 | Section visible (populated) | Page load, 1+ favorites in storage | "★ FAVORITES" header (filled star, var(--accent)). Count badge: "3" next to header. List of favorite items below, each 32px row. Section takes remaining space below workspace tree | FAV-010, FAV-020 |
| FAV-003 | Section collapsed | User clicks ▾ toggle on FAVORITES header | Header row only: "▸ ★ FAVORITES (3)". All favorite items hidden. Workspace tree gets more vertical space. Collapse state persisted to localStorage | FAV-004 |
| FAV-004 | Section expanded | User clicks ▸ toggle on FAVORITES header | Header changes to "▾ ★ FAVORITES (3)". Items animate in with staggered slide-down (50ms per item). Scroll position restored | FAV-002 |
| FAV-005 | Section divider | Always, when section exists | Thin horizontal rule (1px, var(--border-1)) between workspace tree and favorites section. 8px padding above/below divider | — |
| FAV-006 | Section resize | Drag divider between tree and favorites | Cursor changes to row-resize. Workspace tree and favorites section resize proportionally. Min heights: tree 120px, favorites 80px. Ratio persisted to localStorage | FAV-002 |
| FAV-007 | Section scroll (many items) | 8+ favorites (exceed visible area) | Favorites list becomes independently scrollable. Thin scrollbar (4px, var(--surface-3)). Header stays sticky at top of section. Scroll shadows at top/bottom edges when content overflows | FAV-002 |
| FAV-008 | Section first-run hint | First time any favorite is added (tracked in localStorage) | After first add, one-time tooltip over Favorites section: "Your favorites live here. Click to navigate, drag to reorder." Auto-dismisses after 5s or on click. Not shown again | FAV-002 |

### 1.2 Favorite Item Display

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-010 | Favorite item (idle) | Favorites populated | Row: filled star icon (var(--accent), 12px) + custom name (truncated with ellipsis if >25ch) + workspace badge (small, dimmed, right-aligned). Tooltip on hover shows full: "{name} — {workspace} / {lakehouse}" | FAV-011, FAV-012, FAV-013, FAV-020 |
| FAV-011 | Favorite item (hover) | Mouse enters favorite row | Row background: var(--surface-2). Three action buttons slide in from right (0→1 opacity, 100ms): ✎ (rename), ▶ (deploy), ✕ (remove). Workspace badge shifts left to make room. Cursor: pointer | FAV-012, FAV-030, FAV-060, FAV-050 |
| FAV-012 | Favorite item (selected) | Click on favorite name (not action button) | Row background: var(--accent-dim). Left border: 3px solid var(--accent). Tree panel scrolls to and expands the workspace containing this lakehouse. Content panel loads lakehouse. Inspector shows lakehouse summary. Previously selected tree item deselects | TREE-012, CONTENT-020, INSPECTOR-015 |
| FAV-013 | Favorite item (keyboard focus) | Tab/arrow key navigation reaches item | Focus ring: 2px solid var(--accent) with glow. Screen reader: "{name}, favorite, {position} of {total}. Press Enter to navigate, Delete to remove, F2 to rename." | FAV-012 (Enter), FAV-050 (Delete), FAV-030 (F2) |
| FAV-014 | Favorite item (active environment) | This favorite matches the currently deployed lakehouse | Row has subtle accent-left-bar (3px, var(--accent)). Small "● Active" badge after name (green dot + text, var(--success)). Star icon pulses gently once on deploy completion | FAV-010 |
| FAV-015 | Favorite item (stale) | Referenced workspace/lakehouse was deleted or no longer found | Star icon changes to ⚠ (warning, var(--warning)). Name shown with strikethrough (text-decoration: line-through, 50% opacity). Tooltip: "This favorite references a workspace that no longer exists". Only action button visible: ✕ (remove). Click on name → FAV-016 | FAV-016, FAV-050 |
| FAV-016 | Stale favorite clicked | User clicks a stale favorite | Toast (warning): "'{name}' could not be found — the workspace or lakehouse may have been deleted." Two actions: [Remove Favorite] [Keep Anyway]. If removed → FAV-050 flow. If kept → FAV-010 (stays with stale indicator) | FAV-050, FAV-010 |
| FAV-017 | Favorite item (no access) | User lost RBAC access to referenced workspace | Lock icon (🔒) replaces star. Name dimmed (60% opacity). Tooltip: "You no longer have access to this workspace". Click → toast: "Access denied — ask a workspace admin to restore your permissions." [Remove] [Keep] actions | FAV-050, FAV-010 |
| FAV-018 | Favorite item (different tenant) | Favorite's tenantId differs from current session | Tenant badge after name: small pill "T:Contoso" (var(--surface-3) bg). Tooltip: "This favorite is in a different tenant. Switching will require re-authentication." | FAV-070 |

---

## 2. ADDING FAVORITES

### 2.1 Entry Points

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-020 | Context menu entry | Right-click lakehouse in tree (TREE-071) | Context menu includes: "★ Add to Favorites" with star icon. Positioned after "Open in Fabric", before divider. Keyboard shortcut hint: Ctrl+D (right-aligned, dimmed) | FAV-023 |
| FAV-021 | Star icon in content header | Lakehouse selected in content panel (CONTENT-020) | Empty star outline (☆) button in header action bar, after [Deploy] button. Tooltip: "Add to Favorites (Ctrl+D)". If already favorited: filled star (★) with tooltip "Remove from Favorites" | FAV-023 or FAV-050 |
| FAV-022 | Keyboard shortcut | Ctrl+D when lakehouse is selected | Same as clicking star in content header. If no lakehouse selected: no-op (shortcut ignored silently) | FAV-023 |
| FAV-022a | Context menu (already favorited) | Right-click a lakehouse that is already in favorites | Context menu shows "★ Remove from Favorites" instead of "Add to Favorites". Star is filled. Selecting this triggers FAV-050 remove flow | FAV-050 |

### 2.2 Add Flow

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-023 | Name input dialog | Any add entry point triggered | Inline popover anchored below the trigger (context menu position or star button). Contains: "Save as Favorite" label, text input pre-filled with "{lakehouse} @ {workspace}" (all text selected), [Save] (accent) + [Cancel] buttons. Input auto-focused. Keyboard: Enter to save, Escape to cancel | FAV-024, FAV-025, FAV-026, FAV-027 |
| FAV-024 | Name validation — empty | User clears input and presses Enter | Input border turns red (var(--error)). Error text below input: "Name cannot be empty". [Save] button disabled. Focus stays on input | FAV-023 |
| FAV-025 | Name validation — too long | Name exceeds 64 characters | Character counter appears: "64/64" in red. Input border turns red. Error: "Name must be 64 characters or fewer". Typing is not blocked but [Save] disabled | FAV-023 |
| FAV-026 | Name validation — duplicate | Name matches existing favorite (case-insensitive) | Input border turns amber (var(--warning)). Warning text: "A favorite named '{name}' already exists. Save anyway?" [Save] remains enabled — allows duplicates with auto-suffix | FAV-028 |
| FAV-027 | Add cancelled | Escape or [Cancel] clicked | Popover dismisses (100ms fade-out). No changes. Star remains unfilled | FAV-010 or FAV-021 |
| FAV-028 | Add saving | User presses Enter or clicks [Save] with valid name | [Save] button shows spinner, input disabled. Writing to .edog-session.json. Typically <50ms (local file) | FAV-029 or FAV-029a |
| FAV-029 | Add success | Persistence write succeeds | Popover dismisses. Star fills with bounce animation (scale 1→1.3→1, 300ms, cubic-bezier(0.34,1.56,0.64,1)). New item appears in Favorites section with slide-in from left (200ms). Toast: "★ Added '{name}' to favorites". If Favorites section was collapsed, it auto-expands. Count badge increments with roll animation | FAV-002 |
| FAV-029a | Add failed | Persistence write fails (disk full, permissions) | Toast (error): "Could not save favorite — check file permissions for .edog-session.json". Popover stays open for retry. [Save] re-enables | FAV-028 (retry) |
| FAV-029b | Duplicate auto-suffix | User confirms save despite duplicate name warning | Saved as "{name} (2)". If "{name} (2)" exists, uses "(3)", etc. Toast shows actual saved name: "★ Added '{name} (2)' to favorites" | FAV-002 |

---

## 3. MANAGING FAVORITES

### 3.1 Rename

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-030 | Rename start | Click ✎ button on hover, F2 on focused favorite, or right-click → Rename | Favorite name text replaced with inline input. Input: accent border, glow ring, pre-filled with current name, all text selected. Action buttons hidden. Keyboard hints below: "Enter to save · Esc to cancel" | FAV-031, FAV-032, FAV-033 |
| FAV-031 | Rename validation | User types empty or >64 char name | Same validation as FAV-024 / FAV-025 — red border, error text, save disabled | FAV-030 |
| FAV-032 | Rename saving | Enter pressed with valid name | Input disabled, micro-spinner in input. Write to .edog-session.json | FAV-034, FAV-035 |
| FAV-033 | Rename cancelled | Escape or click outside input | Input reverts to original name. No changes persisted. Row returns to idle state | FAV-010 |
| FAV-034 | Rename success | Persistence write succeeds | Input morphs back to text (150ms). New name displayed. Toast: "Renamed to '{newName}'" with [Undo] (5s timeout). If this favorite is the active environment, top bar name also updates | FAV-010 |
| FAV-035 | Rename failed | Persistence write error | Toast (error): "Could not rename — file write failed". Input stays open with new name for retry | FAV-032 (retry) |
| FAV-036 | Rename undo | [Undo] clicked within 5s of rename | Name reverts to previous value. Write to storage. Toast: "Reverted to '{oldName}'". If revert fails: "Could not undo — favorite is now '{newName}'" | FAV-010 |

### 3.2 Remove

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-050 | Remove initiated | Click ✕ button, Delete key, right-click → Remove, or toggle filled star in content header | Favorite row gets red tint (rgba(error, 0.06)). Confirmation toast: "Remove '{name}' from favorites?" [Remove] (red) [Cancel]. Toast auto-dismisses in 5s (cancel = keep) | FAV-051, FAV-052 |
| FAV-051 | Remove confirmed | Click [Remove] on toast | Item fades out + slides right (200ms). Row height collapses. Star in content header unfills (if this lakehouse is currently selected). Write to .edog-session.json. Count badge decrements with roll animation. If last favorite removed → FAV-001 (empty state). Toast: "Removed '{name}'" with [Undo] (5s) | FAV-001 or FAV-002 |
| FAV-052 | Remove cancelled | Click [Cancel] or toast auto-dismisses | Red tint removed. Favorite stays. Row returns to idle | FAV-010 |
| FAV-053 | Remove undo | [Undo] clicked within 5s | Favorite re-inserted at original position with slide-in animation. Write to storage. Toast: "Restored '{name}'". Star refills if lakehouse is selected. Count badge increments | FAV-002 |
| FAV-054 | Remove undo failed | Undo persistence write fails | Toast (error): "Could not restore favorite". Favorite stays removed | FAV-001 or FAV-002 |

### 3.3 Reorder

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-040 | Drag start | Mouse down + drag on favorite row (not on action buttons) | Row lifts (translateY -1px, shadow deepens). Ghost row follows cursor. Original position shows dashed placeholder (2px dashed var(--border-2), 32px height). Other items shift to make room with 150ms ease-out animation. Cursor: grabbing | FAV-041, FAV-042 |
| FAV-041 | Drag over | Ghost row moves over another favorite | Target items slide up/down smoothly (150ms) to show insertion point. Blue insertion line (2px solid var(--accent)) appears between items at drop position | FAV-043 |
| FAV-042 | Drag cancelled | Escape during drag, or drop outside favorites section | Ghost row snaps back to original position (200ms ease). Placeholder disappears. No reorder | FAV-002 |
| FAV-043 | Drop | Mouse up over valid position | Ghost row settles into new position (200ms ease). All items reflow smoothly. New order persisted to .edog-session.json. No toast (reorder is silent, low-ceremony) | FAV-002 |
| FAV-044 | Keyboard reorder | Alt+↑ or Alt+↓ on focused favorite | Item swaps position with neighbor. Smooth 150ms position animation. Screen reader: "Moved '{name}' to position {n} of {total}". New order persisted | FAV-002 |

### 3.4 Clear All

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-055 | Clear all initiated | Right-click FAVORITES header → "Clear All Favorites" | Destructive confirmation dialog (modal overlay, not toast): "Clear all {n} favorites?" + "This cannot be undone." [Clear All] (red, filled) + [Cancel] (outline). Background dims. Focus trapped in dialog | FAV-056, FAV-057 |
| FAV-056 | Clear all confirmed | Click [Clear All] | All favorites fade out simultaneously (200ms). Section transitions to empty state (FAV-001). Write empty array to .edog-session.json. Toast: "Cleared {n} favorites". No undo (destructive) | FAV-001 |
| FAV-057 | Clear all cancelled | Click [Cancel] or Escape | Dialog dismisses. Favorites unchanged | FAV-002 |

### 3.5 Favorites Context Menu

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-058 | Context menu (favorite item) | Right-click on a favorite row | Menu: ▶ Deploy from Favorite · Navigate to Lakehouse · ── · ✎ Rename (F2) · ★ Remove from Favorites (Del) · ── · Copy Config JSON · Export Favorite | FAV-060, FAV-012, FAV-030, FAV-050, FAV-080 |
| FAV-059 | Context menu (favorites header) | Right-click on FAVORITES section header | Menu: Collapse Section · ── · Import Favorites... · Export All Favorites · ── · Clear All Favorites (red text) | FAV-003, FAV-081, FAV-080, FAV-055 |

---

## 4. DEPLOY FROM FAVORITE

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-060 | Deploy triggered | Click ▶ button on hover, or context menu "Deploy from Favorite" | Favorite row pulses accent once. Navigation: tree expands to workspace → selects lakehouse → content panel loads → deploy flow starts (CONTENT-060). Favorite row shows "Deploying..." in dimmed text below name | CONTENT-060 |
| FAV-061 | Deploy completes | Deploy flow reaches CONTENT-066 | Favorite row gains "● Active" badge (FAV-014). Top bar shows environment name (if Named Environment). Previous active favorite loses its badge. Toast from deploy flow shows favorite name: "Deployed '{favName}' successfully" | FAV-014 |
| FAV-062 | Deploy fails | Deploy flow reaches any failure state (CONTENT-067–071) | Favorite row "Deploying..." text clears. Error handling deferred to deploy flow states in F01. Favorite stays intact, no badge change | FAV-010 |
| FAV-063 | Quick-switch deploy | Click ▶ on a different favorite while already deployed | Confirmation: "Switch from '{current}' to '{target}'? The running service will restart." [Switch] [Cancel]. If confirmed: full re-deploy. If cancelled: no-op | CONTENT-073 → CONTENT-060 |

---

## 5. NAMED ENVIRONMENTS (Advanced)

### 5.1 Environment Data Model

A Named Environment extends a Favorite with additional configuration:
```
{ name, workspaceId, artifactId, capacityId, tenantId, configOverrides: { featureFlags: {}, buildArgs: [], envVars: {} } }
```

### 5.2 Environment States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| ENV-001 | Save as environment | Right-click lakehouse → "Save as Named Environment" or ✎ in favorites popover → "Save with config..." toggle | Extended dialog: all fields from FAV-023 plus collapsible "Advanced Configuration" section. Fields: Capacity Override (dropdown), Feature Flag Overrides (key-value editor), Build Args (text), Env Vars (key-value editor). [Save Environment] [Save as Favorite Only] [Cancel] | ENV-002, FAV-028 |
| ENV-002 | Environment saved | User fills config and clicks [Save Environment] | Saved to .edog-session.json under `environments` key (separate from plain favorites). Item in favorites section shows env icon (◆) instead of star (★). Tooltip shows config summary: "3 flag overrides, 1 env var" | FAV-002 |
| ENV-003 | Environment active | This environment is currently deployed | Top bar shows environment name in accent pill: "◆ Dev" or "◆ Staging". Pill has dropdown caret → click shows quick-switch menu (ENV-005). Sidebar environment indicator: green dot + name | ENV-005 |
| ENV-004 | Environment indicator (top bar) | Deployed with named environment | Top bar, right of breadcrumb: accent-bordered pill showing "◆ {envName}". Click → dropdown. Hover → tooltip: "Active environment: {name} — {workspace}/{lakehouse}, capacity: {cap}" | ENV-005 |
| ENV-005 | Quick-switch menu | Click environment pill in top bar | Dropdown menu listing all named environments. Active one has checkmark (✓). Each row: ◆ icon + name + workspace badge. Click different env → ENV-006. [Manage Environments...] link at bottom → scrolls tree to favorites section | ENV-006, FAV-002 |
| ENV-006 | Environment switch initiated | Select different environment from quick-switch | If same tenant: confirmation "Switch to '{target}'? Service will restart." [Switch] [Cancel]. If different tenant: ENV-007. If confirmed: full re-deploy with environment config applied | CONTENT-060, ENV-007 |
| ENV-007 | Cross-tenant switch | Target environment has different tenantId | Extra warning: "Switching to '{target}' requires re-authentication to tenant '{tenantName}'." + "Your current session for '{currentTenant}' will end." [Switch & Re-authenticate] [Cancel]. If confirmed: triggers re-auth flow (TOKEN-005 → F00 onboarding) then auto-deploys | TOKEN-005, CONTENT-060 |
| ENV-008 | Environment diff | Hover comparison icon between active and target env in quick-switch menu | Tooltip table comparing configs: rows for Capacity, Tenant, Feature Flags (count), Build Args, Env Vars. Differences highlighted in amber. "2 differences" summary | ENV-006 |
| ENV-009 | Environment config view | Click ◆ icon on favorite item in tree | Inspector panel (right) shows "ENVIRONMENT CONFIG" sections: **General** (name, workspace, lakehouse, capacity) + **Feature Flags** (overrides table) + **Build Args** (list) + **Env Vars** (key-value, values masked with •••, click to reveal). [Edit] button for each section | INSPECTOR-*, ENV-010 |
| ENV-010 | Environment config edit | Click [Edit] in environment config view | Inspector section becomes editable. Key-value pairs get +/- buttons. Flag overrides get toggle switches. [Save] [Cancel] at section bottom. Changes write to .edog-session.json. If this is the active environment: "Config changed — re-deploy to apply" banner | ENV-002 |

---

## 6. PERSISTENCE & SYNC

### 6.1 Storage States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| PERSIST-001 | Initial load from storage | Page load | Favorites loaded from .edog-session.json (file-based) or localStorage (browser-only fallback). Load is synchronous-blocking before tree renders. If file not found: empty favorites, no error | FAV-001 or FAV-002 |
| PERSIST-002 | Storage file missing | .edog-session.json doesn't exist on first run | File created automatically with `{ "favorites": [], "environments": [] }` on first add. No user prompt. Silent creation | FAV-001 |
| PERSIST-003 | Storage file corrupted | JSON parse error on load | Console warning: "Could not parse .edog-session.json — starting with empty favorites". Corrupted file backed up to .edog-session.json.bak. Fresh empty state. Toast (warning, first load only): "Favorites file was corrupted and has been reset. A backup was saved." | FAV-001 |
| PERSIST-004 | Storage file locked | Another process has file lock (rare) | Retry 3 times with 100ms backoff. If still locked: toast (warning): "Could not save — file is locked by another process. Changes will persist on next successful write." In-memory state is correct; file just not updated yet | FAV-002 |
| PERSIST-005 | Browser refresh | User refreshes page (F5, Ctrl+R) | Favorites survive — loaded from .edog-session.json on startup. Active environment badge resets (not deployed). Collapse/expand state restored from localStorage. Scroll position reset to top | FAV-002 |
| PERSIST-006 | Server restart | dev-server.py restarted | Favorites survive — stored in file, not server memory. WebSocket reconnects silently. Active environment badge resets (service no longer running). Tree reloads but favorites section stays | FAV-002 |
| PERSIST-007 | Write debounce | Multiple rapid changes (reorder, rename, remove) | Writes debounced: 300ms after last change. In-memory state is always current. If page closes before debounce fires: changes lost (acceptable, <300ms window). Warning in console only | — |

### 6.2 Import / Export

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FAV-080 | Export favorites | Context menu "Export All Favorites" on section header, or individual "Export Favorite" on item | Browser downloads JSON file: `edog-favorites-{date}.json`. File contains favorites array + environments array. Toast: "Exported {n} favorites to file" | — |
| FAV-081 | Import dialog | Context menu "Import Favorites..." on section header | OS file picker opens (accept: .json). User selects file | FAV-082, FAV-083, FAV-084 |
| FAV-082 | Import validation | File selected | File parsed. Validation: is valid JSON? Has `favorites` array? Each item has required fields (name, workspaceId, artifactId)? If invalid → FAV-084 | FAV-083 or FAV-084 |
| FAV-083 | Import preview | Valid file parsed | Preview dialog: "Import {n} favorites?" + list showing each name. Checkboxes to include/exclude individual items. Duplicates flagged with amber: "'{name}' already exists — will be renamed to '{name} (2)'". [Import Selected] [Cancel] | FAV-085, FAV-027 |
| FAV-084 | Import invalid | File is not valid favorites JSON | Toast (error): "Invalid favorites file — expected JSON with a 'favorites' array". File picker dismisses | FAV-002 |
| FAV-085 | Import success | User confirms import | New favorites appended to existing list (not replaced). Each new item slides in with stagger animation. Toast: "Imported {n} favorites". Count badge updates. If section was collapsed, auto-expands | FAV-002 |
| FAV-086 | Import merge conflict | Imported items reference same workspaceId+artifactId as existing favorites | Amber warning per conflicting item in preview: "Same lakehouse as existing favorite '{existingName}'". User can still import (creates near-duplicate with different name) | FAV-083 |

---

## 7. EDGE CASES

### 7.1 Scale & Limits

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-001 | Many favorites (20+) | User has accumulated 20+ favorites | Favorites section scrollable. Virtual scroll not needed (items are lightweight, 32px each). Search/filter input appears at top of favorites section: "Filter favorites..." | EDGE-002 |
| EDGE-002 | Favorites filter active | User types in favorites filter input | Real-time filter: matching favorites visible (match text bold), non-matching hidden. Counter: "3 of 24 favorites". Escape or ✕ clears filter | FAV-002 |
| EDGE-003 | 50+ favorites warning | User adds 50th favorite | One-time toast (info): "You have {n} favorites. Consider organizing with named environments or removing unused ones." Not shown again after dismissal | FAV-002 |
| EDGE-004 | Favorite with very long name | Name is 64 chars (max) | Name truncated with ellipsis in tree row. Full name visible in tooltip. Rename input scrolls horizontally for long text | FAV-010 |
| EDGE-005 | Multiple favorites, same lakehouse | User adds same lakehouse twice with different names (e.g., "Dev" and "Dev w/ flags") | Both appear in list. No conflict. Each can have different environment config. Both show same workspace badge. Deploying either navigates to same lakehouse | FAV-010 |

### 7.2 Access & Auth

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-010 | Stale workspace reference | Workspace deleted in Fabric portal while favorite exists | On next tree load: workspace not found in API response. Favorite marked stale (FAV-015). Star → ⚠. Stale check runs on every tree refresh, not continuously | FAV-015 |
| EDGE-011 | Stale lakehouse reference | Lakehouse deleted but workspace exists | Tree loads workspace successfully but lakehouse not in children. Favorite marked stale. If user clicks: navigates to workspace but cannot select lakehouse. Toast: "Lakehouse '{name}' no longer exists in '{workspace}'" | FAV-015 |
| EDGE-012 | Access revoked | RBAC changed — user lost workspace access | On tree load: workspace returns 403. Favorite shows lock icon (FAV-017). Other favorites unaffected. Stale check is per-favorite, not global | FAV-017 |
| EDGE-013 | Capacity changed | Favorite references capacityId that was reassigned | Deploy from favorite may fail at step 1 (MWC token). Error: "Capacity '{id}' is no longer assigned to this workspace." Favorite stays valid — capacity is informational, not critical for navigation | CONTENT-067 |
| EDGE-014 | Tenant switch edge | User has favorites across 3 tenants | Each favorite shows tenant badge if tenantId differs from current. Quick-switch menu groups by tenant with dividers: "── Contoso ──" header. Switching tenant always requires re-auth confirmation | ENV-007 |

### 7.3 Concurrent & Timing

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-020 | Add during deploy | User tries to add a favorite while deploy is in progress | Normal add flow — deploy is independent. Favorite appears in section. If deploy target matches new favorite, badge updates when deploy completes | FAV-029 |
| EDGE-021 | Remove active environment | User removes the favorite that is currently deployed | Remove proceeds normally. "● Active" badge lost. Top bar environment pill removes (200ms fade). Service keeps running — only the favorite bookmark is removed. Toast includes: "Service is still running" | FAV-051 |
| EDGE-022 | Rename active environment | User renames the currently active environment | Rename proceeds. Top bar environment pill updates to new name in real-time. Service unaffected | FAV-034 |
| EDGE-023 | Rapid add-remove | User adds a favorite then immediately removes it (<300ms, within debounce window) | In-memory state is consistent (favorite removed). Debounced write fires with final state (no favorite). No orphan data. Both toasts may stack: "Added..." then "Removed..." — second toast replaces first | FAV-001 or FAV-002 |
| EDGE-024 | Token expires during add | Bearer expires while saving favorite | Favorite save is local (file/localStorage) — no API call needed. Add always succeeds regardless of token state. Token expiry only affects navigation/deploy | FAV-029 |

---

## 8. KEYBOARD SHORTCUTS (F03-specific)

| Key | Action | Context |
|-----|--------|---------|
| `Ctrl+D` | Add/remove current lakehouse to/from favorites | Lakehouse selected in tree or content panel |
| `Ctrl+Shift+F` | Jump focus to Favorites section | Global (not in input) |
| `↑` / `↓` | Navigate favorite items | Favorites section focused |
| `Enter` | Navigate to favorite (select in tree + load content) | Favorite item focused |
| `F2` | Start rename on focused favorite | Favorite item focused |
| `Delete` | Initiate remove on focused favorite | Favorite item focused |
| `Alt+↑` / `Alt+↓` | Reorder favorite (move up/down) | Favorite item focused |
| `Escape` | Cancel rename / dismiss popover / clear filter | Any active input in favorites |
| `Ctrl+E` | Open environment quick-switch menu (if any environments exist) | Global (not in input) |

---

## 9. SCREEN READER ANNOUNCEMENTS

| Event | Announcement |
|-------|-------------|
| Section load (empty) | "Favorites section. No favorites saved." |
| Section load (populated) | "Favorites section. {n} favorites." |
| Favorite added | "Added {name} to favorites. {total} favorites total." |
| Favorite removed | "Removed {name} from favorites. {remaining} favorites remaining." |
| Favorite renamed | "Favorite renamed to {newName}." |
| Favorite reordered | "Moved {name} to position {n} of {total}." |
| Favorite navigated | "Navigating to {name}. Loading workspace {workspace}, lakehouse {lakehouse}." |
| Deploy from favorite | "Deploying from favorite {name}." |
| Stale favorite detected | "Warning: favorite {name} references a workspace or lakehouse that no longer exists." |
| No-access favorite | "Favorite {name}: access denied. Workspace access has been revoked." |
| Environment switch | "Switching environment to {name}. Re-authentication may be required." |
| Rename start | "Renaming favorite {name}. Type new name, Enter to save, Escape to cancel." |
| Clear all confirm | "Confirm clearing all {n} favorites. This cannot be undone." |
| Import complete | "Imported {n} favorites." |

---

## 10. ANIMATION TIMING REFERENCE

| Animation | Duration | Easing | Use |
|-----------|----------|--------|-----|
| Star fill (add) | 300ms | cubic-bezier(0.34,1.56,0.64,1) | Star icon bounce on add |
| Star unfill (remove) | 200ms | ease-out | Star icon shrink on remove |
| Item slide-in | 200ms | ease-out | New favorite appears |
| Item fade-out + slide | 200ms | ease-in | Favorite removed |
| Stagger (multi-item) | 50ms per item | ease-out | Section expand, import |
| Hover row background | 80ms | ease-out | Surface-2 transition |
| Action buttons reveal | 100ms | ease-out | 0→1 opacity on hover |
| Inline rename morph | 150ms | ease | Name ↔ input transition |
| Drag ghost | continuous | none | Follow cursor |
| Drop settle | 200ms | ease | Ghost → final position |
| Reorder shift | 150ms | ease-out | Items making room during drag |
| Section collapse/expand | 200ms | ease | Height animation |
| Count badge roll | 200ms | ease-out | Number increment/decrement |
| Toast stack replace | 150ms | ease | Rapid action toast swap |
| Environment pill appear | 200ms | ease-out | Top bar pill on deploy |
| Environment pill remove | 200ms | ease-in | Top bar pill on remove |

---

## 11. RESPONSIVE BEHAVIOR

| Breakpoint | Layout Change |
|------------|--------------|
| >1400px | Favorites section visible at bottom of tree panel (260px width). Full action buttons on hover. |
| 1000–1400px | Favorites section compressed (220px). Action buttons icon-only (no labels). Workspace badge hidden — shown in tooltip only. |
| <1000px | Tree is slide-out panel. Favorites section at bottom of slide-out. Tap-and-hold for context menu (no hover actions). |
| <768px | Not supported — same as F01 message: "EDOG Playground requires a desktop browser (1000px+)" |

---

*"95 states. Every star click is intentional. Every switch is safe. Every stale reference is caught."*

— F03 Favorites / Named Environments UX Specification
