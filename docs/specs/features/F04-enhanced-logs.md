# Feature 4: Enhanced Logs (Breakpoints + Bookmarks)

> **Phase:** MVP
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS)
> **Spec:** docs/specs/features/F04-enhanced-logs.md
> **Design Ref:** docs/specs/design-spec-v2.md §4

### Problem

FLT produces thousands of log entries per DAG execution. Engineers can filter by level/component, but they cannot visually mark patterns they're hunting for (e.g., "highlight all SparkSession logs") or save specific entries for later comparison.

### Objective

Add regex-based log breakpoints (visual highlighting, no auto-pause) and log bookmarks (pin entries, export, navigate) to the existing Logs view.

### Owner

**Primary:** Zara Okonkwo (JS breakpoints + bookmarks)
**Reviewers:** Kael Andersen (UX for breakpoint/bookmark UI), Mika Tanaka (CSS for highlight strip + drawer)

### Inputs

- Existing `renderer.js` — renders log entries in virtual scroll
- Existing `filters.js` — level/component/text filtering
- Existing `#breakpoints-bar` and `#bookmarks-drawer` containers in `index.html`

### Outputs

- **Files modified:**
  - `src/frontend/js/renderer.js` — Add breakpoint matching per entry, bookmark gutter star
  - `src/frontend/css/logs.css` — Breakpoint highlight strip, bookmark star styles
  - `src/frontend/css/detail.css` — Bookmarks drawer refinements
  - `src/frontend/js/main.js` — Wire breakpoint and bookmark keyboard shortcuts

### Technical Design

**Breakpoints — `renderer.js` additions:**

```
class BreakpointManager {
  constructor()

  breakpoints: Map<id, {regex: RegExp, color: string, label: string}>

  addBreakpoint(regexStr, color)      // Compile regex, assign color, add to map
  removeBreakpoint(id)
  matchEntry(logText)                 // Returns matching breakpoint or null
  renderBreakpointBar(barEl)          // Pill per breakpoint with × remove button
  renderAddForm()                     // Inline: regex input + color picker + Add btn
}

// In renderer.renderLogEntry():
const bp = breakpointManager.matchEntry(entry.message);
if (bp) {
  rowEl.style.borderLeft = `3px solid ${bp.color}`;
  rowEl.classList.add('breakpoint-hit');
}
```

**Bookmarks — `renderer.js` additions:**

```
class BookmarkManager {
  constructor(drawerEl)

  bookmarks: Map<entryId, LogEntry>

  toggleBookmark(entry)               // Pin/unpin
  isBookmarked(entryId)               // Check state
  renderDrawerList()                   // Populate #bm-list
  scrollToEntry(entryId)              // Scroll main log view to bookmarked entry
  exportBookmarks(format)             // 'json' or 'html'

  renderGutterStar(entryId)           // ★ (filled) or ☆ (empty) in gutter column
}
```

**CSS — Breakpoint highlight:**

```css
.log-entry.breakpoint-hit {
  border-left: 3px solid var(--breakpoint-color);  /* dynamic per breakpoint */
  background: rgba(var(--breakpoint-color-rgb), 0.04);
}

.breakpoints-bar .bp-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
```

### Acceptance Criteria

- [ ] "+" button in breakpoints bar opens inline form (regex input + color picker)
- [ ] Adding a breakpoint applies visual highlight to all matching existing log entries
- [ ] New log entries arriving via WebSocket are checked against active breakpoints
- [ ] Breakpoint pills shown in bar with × button to remove
- [ ] Maximum 10 active breakpoints (UI shows limit message)
- [ ] Breakpoints persist for the session (not across restarts)
- [ ] Each log row has a star gutter icon (☆ empty, ★ filled on click)
- [ ] Bookmarked entries appear in the right-side bookmarks drawer
- [ ] Clicking a bookmarked entry in the drawer scrolls the main log to that entry
- [ ] "Export Bookmarks" generates JSON file with all bookmarked entries
- [ ] Bookmarks survive log clearing but not session restart
- [ ] Invalid regex shows inline validation error (no crash)
- [ ] Performance: breakpoint matching adds < 1ms overhead per log entry

### Dependencies

- None — Logs view and renderer already exist and work

### Risks

| Risk | Mitigation |
|------|------------|
| Complex regex causes performance regression | Pre-compile regex. If match takes >5ms, warn user. Limit regex complexity. |
| Too many bookmarks causes drawer slowness | Cap at 200 bookmarks. Oldest auto-removed with warning. |

### Moonshot Vision

V2+: Conditional breakpoints (match + level filter). Break-on-first-match mode (auto-pause stream). Share breakpoint sets as importable JSON. Bookmark annotations (user comments on entries).

