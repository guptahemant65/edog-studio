# Feature 7: Command Palette (Ctrl+K)

> **Phase:** MVP
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS)
> **Spec:** docs/specs/features/F07-command-palette.md
> **Design Ref:** docs/specs/design-spec-v2.md §7

### Problem

Power users (senior engineers) want keyboard-first navigation. Finding a specific lakehouse, running a DAG command, or jumping to a feature flag currently requires mouse-clicking through the UI.

### Objective

A floating command palette (Ctrl+K) with fuzzy search across workspaces, lakehouses, tables, commands, and feature flags. Arrow-key navigable, Enter to select.

### Owner

**Primary:** Zara Okonkwo (JS command matching + rendering)
**Reviewers:** Kael Andersen (UX interaction), Mika Tanaka (CSS overlay)

### Inputs

- In-memory state: workspace tree data, loaded log entries, command registry
- HTML structure: `#command-palette` container exists in `index.html`
- Existing `command-palette.js` and `command-palette.css` modules

### Outputs

- **Files modified:**
  - `src/frontend/js/command-palette.js` — Full implementation with fuzzy matching
  - `src/frontend/css/command-palette.css` — Refinements for result grouping, active highlight

### Technical Design

**Frontend — `command-palette.js`:**

```
class CommandPalette {
  constructor(overlayEl, stateManager, workspaceExplorer)

  open()                              // Show overlay, focus input, populate initial results
  close()                             // Hide overlay, clear input
  toggle()                            // Open if closed, close if open

  registerCommand(id, label, category, action, condition)
  // condition: () => boolean — whether command is available in current phase

  search(query)                       // Fuzzy match across all sources
  renderResults(matches)              // Grouped by category: Workspaces, Commands, Flags...
  selectResult(index)                 // Execute action for selected result
  navigateResults(direction)          // Arrow up/down

  _fuzzyMatch(query, text)            // Simple substring + initial-letter matching
  _getWorkspaceResults(query)         // Match against loaded workspace/lakehouse names
  _getCommandResults(query)           // Match against registered commands
  _getLogResults(query)               // Match against log messages (connected mode)

  // Keyboard handling
  _onKeydown(e)                       // Arrow keys, Enter, Escape
}
```

**Built-in commands registry:**

```javascript
const COMMANDS = [
  { id: 'run-dag',       label: 'Run DAG',             category: 'Commands', phase: 'connected' },
  { id: 'cancel-dag',    label: 'Cancel DAG',           category: 'Commands', phase: 'connected' },
  { id: 'restart',       label: 'Restart Service',      category: 'Commands', phase: 'connected' },
  { id: 'force-unlock',  label: 'Force Unlock DAG',     category: 'Commands', phase: 'connected' },
  { id: 'refresh-dag',   label: 'Refresh DAG',          category: 'Commands', phase: 'connected' },
  { id: 'refresh-token', label: 'Refresh Token',        category: 'Commands', phase: 'both' },
  { id: 'export-logs',   label: 'Export Logs to JSON',  category: 'Commands', phase: 'connected' },
  { id: 'clear-logs',    label: 'Clear Logs',           category: 'Commands', phase: 'connected' },
  { id: 'toggle-theme',  label: 'Toggle Theme',         category: 'Commands', phase: 'both' },
  { id: 'go-workspace',  label: 'Go to Workspace Explorer', category: 'Navigation', phase: 'both' },
  { id: 'go-logs',       label: 'Go to Logs',           category: 'Navigation', phase: 'connected' },
  { id: 'go-dag',        label: 'Go to DAG Studio',     category: 'Navigation', phase: 'connected' },
  { id: 'go-spark',      label: 'Go to Spark Inspector', category: 'Navigation', phase: 'connected' },
  { id: 'go-api',        label: 'Go to API Playground',  category: 'Navigation', phase: 'both' },
  { id: 'go-env',        label: 'Go to Environment',     category: 'Navigation', phase: 'both' },
];
```

### Acceptance Criteria

- [ ] Ctrl+K opens command palette overlay (centered, ~520px wide)
- [ ] Ctrl+K toggles (opens if closed, closes if open)
- [ ] Escape closes the palette
- [ ] Clicking backdrop closes the palette
- [ ] Input field auto-focused on open
- [ ] Results grouped by category: Workspaces, Lakehouses, Commands, Navigation
- [ ] Arrow up/down navigates results with visual highlight
- [ ] Enter executes selected result action
- [ ] Fuzzy matching works (typing "dag" matches "Go to DAG Studio" and "Run DAG")
- [ ] Connected-only commands hidden when disconnected
- [ ] Workspace/lakehouse results navigate to that item in the tree
- [ ] Command results execute the command (e.g., "Toggle Theme" toggles theme)
- [ ] Results render within 50ms of keystroke (client-side matching only)
- [ ] Maximum 20 visible results (scrollable if more)
- [ ] Command palette respects z-index hierarchy (above all other UI elements)

### Dependencies

- **Feature 1 (Workspace Explorer):** Workspace data needed for search results
- **Feature 6 (Sidebar):** Navigation commands trigger view switches

### Risks

| Risk | Mitigation |
|------|------------|
| Ctrl+K conflicts with browser's address bar shortcut in some browsers | Test in Edge and Chrome. If conflict, fall back to Ctrl+Shift+K or Ctrl+P (with note). |
| Large dataset (many workspaces) makes fuzzy search slow | Search is in-memory string matching. Even 1000 items is < 1ms. No concern. |

### Moonshot Vision

V2+: Recent commands history. Custom user shortcuts. Plugin commands (extensions can register commands). Inline preview of results (show lakehouse details on hover). Multi-step commands (wizards triggered from palette).

