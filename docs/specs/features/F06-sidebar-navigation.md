# Feature 6: Sidebar Navigation

> **Phase:** MVP
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS) + Mika Tanaka (CSS)
> **Spec:** docs/specs/features/F06-sidebar-navigation.md
> **Design Ref:** docs/specs/design-spec-v2.md §6

### Problem

The current mock sidebar has 6 view tabs but no phase awareness — connected-only views (Logs, DAG, Spark) are clickable even when no service is running, leading to empty/broken states.

### Objective

Phase-aware sidebar that enables/disables views based on connection state, with keyboard shortcuts (1-6) and active view indicator.

### Owner

**Primary:** Zara Okonkwo (JS) + Mika Tanaka (CSS)
**Reviewers:** Kael Andersen (UX interaction)

### Inputs

- State manager with phase tracking (from Feature 2's deploy flow)
- HTML structure: `#sidebar` with `data-phase` attributes on each button already exists
- Design system: sidebar icon specs (36×36 hit area, `--radius-md`, active/disabled states)

### Outputs

- **Files modified:**
  - `src/frontend/js/sidebar.js` — Add phase-aware enable/disable, keyboard binding
  - `src/frontend/css/sidebar.css` — Disabled state styles, active indicator refinements

### Technical Design

**Frontend — `sidebar.js`:**

```
class Sidebar {
  constructor(sidebarEl, stateManager)

  init()                              // Bind keyboard shortcuts, read initial phase
  switchView(viewId)                  // Hide current view, show target, update active state
  updatePhase(phase)                  // 'disconnected' | 'deploying' | 'connected'
  _enableView(viewId)                 // Remove disabled class, add click handler
  _disableView(viewId)               // Add disabled class, remove click handler

  _bindKeyboardShortcuts()
  // Key 1 → workspace, 2 → logs, 3 → dag, 4 → spark, 5 → api, 6 → environment
  // Only fire if no input/textarea is focused
}
```

**Phase logic:**

```
disconnected:
  View 1 (Workspace): enabled, default active
  View 2 (Logs): disabled → shows "Connect to enable" empty state
  View 3 (DAG): disabled → shows "Connect to enable" empty state
  View 4 (Spark): disabled → shows "Connect to enable" empty state
  View 5 (API): enabled (uses bearer token)
  View 6 (Environment): enabled

connected:
  All views enabled
  Logs view starts receiving WebSocket data
```

**CSS — Disabled state:**

```css
.sidebar-icon[disabled] {
  opacity: 0.3;
  pointer-events: none;
  cursor: not-allowed;
}
```

### Acceptance Criteria

- [ ] Sidebar shows 6 icon buttons in correct order per spec
- [ ] Keyboard shortcuts 1-6 switch views (when no input is focused)
- [ ] Active view has accent-colored left border indicator
- [ ] In disconnected phase: views 2, 3, 4 are visually disabled (opacity 0.3)
- [ ] Disabled views show "Connect to a Lakehouse to enable this view" empty state
- [ ] Empty state includes a link/button to navigate to Workspace Explorer
- [ ] After deploy completes, disabled views transition to enabled
- [ ] View switch is instant (0ms, no animation per design system)
- [ ] Bottom of sidebar shows token status dot (green/amber/red/gray)
- [ ] Sidebar width is exactly 52px per design system

### Dependencies

- **Feature 2 (Deploy):** Phase transitions drive enable/disable logic
- **Feature 5 (Top Bar):** Token status dot mirrors top bar token health

### Risks

| Risk | Mitigation |
|------|------------|
| Keyboard shortcuts conflict with browser shortcuts | Only use number keys 1-6 (not Ctrl+N). Check for focus state before handling. |

### Moonshot Vision

V2+: Sidebar badges showing notification counts per view. Collapsible sidebar with labels. Custom view ordering via drag-and-drop.

