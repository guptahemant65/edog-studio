# F07 Command Palette — Complete UX State Matrix

> **Feature:** F07 Command Palette (Ctrl+K)
> **Status:** Spec complete, not yet implemented
> **Owner:** Zara (JS) + Mika (CSS) + Kael (UX)
> **Last Updated:** 2025-07-18
> **States Documented:** 120+

---

## How to Read This Document

Every state is documented as:
```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

States are grouped by lifecycle phase and category. Each state has a unique ID for reference in code reviews and bug reports (e.g., "this violates F07-OPEN-003").

---

## 1. OPEN / CLOSE LIFECYCLE

### 1.1 Opening the Palette

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| OPEN-001 | Palette opens (keyboard) | Ctrl+K pressed anywhere | Backdrop fades in (rgba(0,0,0,0.20), 150ms). Palette card fades in + scales from 95% → 100% (200ms spring, ease-out). Card: 520px wide, centered horizontally, top 20vh. Frosted glass background (backdrop-filter: blur(16px)). Input auto-focused with blinking cursor | EMPTY-001, RECENT-001 |
| OPEN-002 | Palette opens (toolbar button) | Click command palette icon in top bar | Same animation as OPEN-001. Button shows pressed state during open | EMPTY-001, RECENT-001 |
| OPEN-003 | Palette opens (sidebar trigger) | Click "Search" item in sidebar nav | Same animation as OPEN-001 | EMPTY-001, RECENT-001 |
| OPEN-004 | Already open — refocus | Ctrl+K pressed while palette is open | No new palette. Existing input field re-focuses, selects all text (if any). Subtle pulse animation on card border (100ms) | EMPTY-001, SEARCH-* |
| OPEN-005 | Open with prefill | Ctrl+K from context with hint (e.g., right-click "Search for this") | Palette opens with search text pre-filled. Results immediately visible for the pre-filled query | SEARCH-001 |
| OPEN-006 | Open during transition | Ctrl+K pressed while view is animating (e.g., panel resizing) | Palette opens normally. Running transitions complete underneath the backdrop | EMPTY-001 |

### 1.2 Closing the Palette

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CLOSE-001 | Close via Escape | Escape key pressed | Palette fades out + scales 100% → 95% (150ms). Backdrop fades out (150ms). Focus returns to previously focused element | — (palette destroyed) |
| CLOSE-002 | Close via backdrop click | Click on backdrop (outside palette card) | Same animation as CLOSE-001 | — |
| CLOSE-003 | Close via result selection | Enter on highlighted result, or click result | Palette closes immediately (no fade — instant, to feel responsive). Action executes. See EXEC-* | EXEC-* |
| CLOSE-004 | Close via Ctrl+K toggle | Ctrl+K pressed while palette is open | Palette closes with same animation as CLOSE-001. Acts as toggle | — |
| CLOSE-005 | Close during search | Escape while search text is present | First Escape clears search text, restores recent items. Second Escape closes palette | RECENT-001 or — |
| CLOSE-006 | Close during loading | Escape while a category is still filtering | Palette closes immediately. Any pending filter work is cancelled | — |
| CLOSE-007 | Close via Tab out | Focus leaves palette (e.g., screen reader user tabs past last element) | Palette does NOT close — focus wraps to input (focus trap). aria-modal="true" enforces this | EMPTY-001 |

### 1.3 Focus Management

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FOCUS-001 | Focus on open | Palette opens | Input field receives focus. No other element in the page is focusable (focus trap active). Previously focused element stored for restore | EMPTY-001 |
| FOCUS-002 | Focus restore on close | Palette closes | Focus returns to the element that was focused before palette opened. If that element no longer exists (e.g., view changed), focus goes to main content area | — |
| FOCUS-003 | Focus trap cycling | Tab from last result or footer hint | Focus wraps back to input field. Shift+Tab from input wraps to last result | FOCUS-001 |
| FOCUS-004 | Focus trap with no results | Tab when "No results" is shown | Focus stays on input (only focusable element). Tab does nothing | EMPTY-001 |

---

## 2. EMPTY STATE (Just Opened)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EMPTY-001 | Empty with history | Palette opens, user has prior search/command history | Input: empty, focused, placeholder "Search commands, workspaces, tables…". Below: "RECENT" section header (muted, uppercase). 5 most recent items, each with icon + name + category badge. Footer: "↑↓ navigate · Enter select · Esc close" (muted) | SEARCH-001 (type), NAV-001 (arrow), EXEC-001 (Enter on recent) |
| EMPTY-002 | Empty without history | Palette opens, no prior usage (first time) | Input: empty, focused. Below: full-width placeholder illustration (subtle, muted): "Type to search workspaces, commands, tables…". No results list. Footer keyboard hints still visible | SEARCH-001 (type) |
| EMPTY-003 | Empty after clearing search | User clears input (backspace all, or Ctrl+A then Delete) | Palette returns to same state as EMPTY-001 or EMPTY-002 depending on history. Results list smoothly crossfades from search results to recent items (150ms) | SEARCH-001 (type) |

### 2.1 Recent Items

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| RECENT-001 | Recent items displayed | Palette opens with history | Up to 5 items in recency order (most recent first). Each item shows: category icon (workspace/command/table/flag) + name + muted meta (e.g., "Command" or "in SalesData-WS"). First item highlighted | NAV-001, EXEC-001 |
| RECENT-002 | Recent item hover | Mouse enters a recent item | Row background: var(--surface-2). If different from keyboard-highlighted item, highlight moves to hovered item | EXEC-001 |
| RECENT-003 | Recent item selected | Enter or click on recent item | Item executes (same as search result selection — see EXEC-*). Item moves to top of recent list (MRU update). Palette closes | EXEC-* |
| RECENT-004 | Recent list overflow | User has used 100+ items historically | Only last 5 shown. Older items pruned from localStorage. No "Show more" — recents are always ≤5 | RECENT-001 |
| RECENT-005 | Recent item stale | Recent item references deleted workspace/table | Item still shown but with strikethrough name + "(Not found)" badge. Selecting it shows toast: "This item no longer exists" and removes it from recents | EMPTY-001 |

---

## 3. SEARCH & RESULTS

### 3.1 Search Input

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SEARCH-001 | Typing begins | User types first character | Results area immediately replaces recent items (no debounce — client-side filter runs synchronously). Search icon in input changes to spinner for 1 frame then back (visual acknowledgment). Total results badge appears: "N results" | RESULTS-001 |
| SEARCH-002 | Typing continues | User types additional characters | Results update on every keystroke. Filtering is synchronous and instant (<5ms for typical datasets). Results smoothly reflow (items that no longer match fade out, new matches fade in) | RESULTS-001 |
| SEARCH-003 | Input cleared (backspace) | User backspaces to empty | Crossfade back to recent items (EMPTY-001 or EMPTY-002). Results badge disappears | EMPTY-001 |
| SEARCH-004 | Input cleared (Ctrl+A + Delete) | Select-all then delete | Same as SEARCH-003 | EMPTY-001 |
| SEARCH-005 | Paste into input | Ctrl+V with text | Pasted text treated as search query. Results update immediately. If pasted text is very long (>200 chars), input scrolls horizontally — no overflow, no line break | RESULTS-001 |
| SEARCH-006 | Paste URL/JSON | Ctrl+V with complex string | Treated as literal text search. Special characters (braces, colons, slashes) matched literally. No crash, no regex interpretation | RESULTS-001 or NORESULT-001 |
| SEARCH-007 | Special regex characters | User types `.*+?^${}()|[]\` | All treated as literal characters. No regex engine invoked. Internal implementation uses escaped string in indexOf/includes | RESULTS-001 or NORESULT-001 |
| SEARCH-008 | Very long input | User types or pastes 200+ characters | Input field scrolls horizontally. Text does not wrap. Caret stays visible (scrolls with text). No truncation. Results still filter normally (though likely no matches) | NORESULT-001 |
| SEARCH-009 | Input with leading/trailing spaces | User types " sales " | Spaces are trimmed for matching but preserved in input display. "sales" matches "sales_transactions" | RESULTS-001 |

### 3.2 Fuzzy Matching

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FUZZY-001 | Substring match | "sales" typed | Matches: "sales_transactions" (table), "SalesData-LH" (lakehouse), "SalesWorkspace" (workspace). Matched characters highlighted in bold within result text | RESULTS-001 |
| FUZZY-002 | Transposition match | "gitch" typed | Matches: "Git: Checkout" (command). Fuzzy algorithm tolerates character transposition. Match score lower than exact match — appears lower in results | RESULTS-001 |
| FUZZY-003 | Abbreviation match | "dagrun" typed | Matches: "Run DAG" (command). Consecutive character matching across word boundaries. "dag" matches "DAG", "run" matches "Run" | RESULTS-001 |
| FUZZY-004 | Acronym match | "ws" typed | Matches: "Workspace Explorer" (command), "WestSalesData" (workspace). First-letter-of-word matching weighted highly | RESULTS-001 |
| FUZZY-005 | Case-insensitive match | "RUN dag" typed | Matches: "Run DAG" (command). Search is always case-insensitive | RESULTS-001 |
| FUZZY-006 | Multi-field match | "prod" typed | Matches against name + description + keywords. "Production Config" (name match) scores higher than "Set environment to prod" (description match) | RESULTS-001 |
| FUZZY-007 | Highlight characters | Any match | Matched characters within result name are rendered in bold (font-weight: 600) + accent color. Non-matched characters remain normal weight | RESULTS-001 |
| FUZZY-008 | Score ordering | Multiple matches across categories | Results within each category sorted by match score (best first). Exact prefix match > word-start match > substring match > transposition match | RESULTS-001 |

### 3.3 Grouped Results

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| RESULTS-001 | Results with multiple categories | Search matches items in 2+ categories | Results grouped under category headers. Order: COMMANDS → WORKSPACES → LAKEHOUSES → TABLES → FEATURE FLAGS → LOGS. Each header: uppercase text, muted color, sticky within scroll | NAV-001 |
| RESULTS-002 | Results single category | Search only matches one category | Single category header shown. Results listed below. No unnecessary visual noise from empty categories | NAV-001 |
| RESULTS-003 | Category: WORKSPACES | Match found in workspace names | Header: "WORKSPACES" with folder icon. Each result: folder icon + workspace name (match highlighted) + item count badge ("14 items", muted) | NAV-001, EXEC-010 |
| RESULTS-004 | Category: LAKEHOUSES | Match found in lakehouse names | Header: "LAKEHOUSES" with green dot icon. Each result: green dot + lakehouse name (highlighted) + parent workspace name (muted, right-aligned) | NAV-001, EXEC-011 |
| RESULTS-005 | Category: TABLES | Match found in table names | Header: "TABLES" with grid icon. Each result: grid icon + table name (highlighted) + lakehouse name (muted) + row count if available ("1.2M rows", muted) | NAV-001, EXEC-012 |
| RESULTS-006 | Category: COMMANDS | Match found in command registry | Header: "COMMANDS" with terminal icon. Each result: terminal icon + command name (highlighted) + keyboard shortcut if any (right-aligned, kbd style). Disabled commands shown with muted text | NAV-001, EXEC-020 |
| RESULTS-007 | Category: FEATURE FLAGS | Match found in flag names | Header: "FEATURE FLAGS" with flag icon. Each result: flag icon + flag name (highlighted) + status badge: "Enabled" (green) / "Disabled" (muted) / "Overridden" (amber) | NAV-001, EXEC-030 |
| RESULTS-008 | Category: LOGS (connected) | Match found in log messages, connected mode | Header: "LOGS" with scroll icon. Each result: severity icon (● color-coded) + truncated message (highlighted match, max 80 chars) + timestamp (muted, relative: "2m ago") | NAV-001, EXEC-040 |
| RESULTS-009 | Category: LOGS (disconnected) | User searches while in Phase 1 | LOGS category does not appear at all. No "Logs unavailable" message — the category simply doesn't exist in disconnected mode | RESULTS-001 |
| RESULTS-010 | Category truncation | Category has >5 matching results | First 5 results shown. Below them: "Show all N results ▸" link in accent color. Clicking expands to show all (max 50, then virtual scroll) | RESULTS-011 |
| RESULTS-011 | Category expanded | User clicks "Show all N results" | Category expands in-place. Other categories pushed down. Results area may now scroll. "Show all" link changes to "Show less ▴" | RESULTS-010 |
| RESULTS-012 | Total results badge | Any search with results | Top-right of results area: "23 results" badge (muted pill). Updates on every keystroke as results change | — |

### 3.4 No Results

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| NORESULT-001 | No matches found | Search text matches nothing | Results area shows: magnifying glass icon (muted, 48px) + "No results for '{query}'" (query in accent color, max 40 chars displayed with ellipsis) + "Try a different search term" (muted). Keyboard hints still visible in footer | SEARCH-001 (edit query), EMPTY-001 (clear) |
| NORESULT-002 | No matches — partial category | Search matches commands but no data items | Only matching categories shown. Empty categories silently omitted — not shown as "0 results" | RESULTS-001 |
| NORESULT-003 | No matches — typo hint | Search close to a known term (Levenshtein ≤2) | Below "No results": "Did you mean '{suggestion}'?" as clickable link. Clicking replaces search text and triggers new search | SEARCH-001 |

---

## 4. KEYBOARD NAVIGATION

### 4.1 Arrow Key Navigation

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| NAV-001 | First result auto-highlighted | Results appear (from typing or opening with history) | First result in first category has highlight: accent-tinted background (var(--accent-dim)), left border 3px accent. aria-activedescendant set on input pointing to this element | NAV-002, EXEC-* |
| NAV-002 | Arrow Down — next result | ↓ pressed | Highlight moves to next result. If at last result in category, moves to first result of next category (skipping category header). Results area scrolls to keep highlighted item visible | NAV-003 |
| NAV-003 | Arrow Down — wrap to top | ↓ pressed on last result in last category | Highlight wraps to first result of first category. Scroll position resets to top | NAV-002 |
| NAV-004 | Arrow Up — previous result | ↑ pressed | Highlight moves to previous result. If at first result in category, moves to last result of previous category | NAV-005 |
| NAV-005 | Arrow Up — wrap to bottom | ↑ pressed on first result of first category | Highlight wraps to last result of last category. Scroll jumps to bottom | NAV-004 |
| NAV-006 | Arrow Down from input (no highlight) | ↓ pressed when input focused, no highlight active | Highlight moves to first result. Text cursor stays in input (input retains focus for continued typing) | NAV-002 |
| NAV-007 | Tab — jump to next category | Tab pressed while results are shown | Highlight jumps to first result of next category. If on last category, wraps to first. Category header briefly pulses accent (100ms) to indicate jump | NAV-008 |
| NAV-008 | Shift+Tab — jump to prev category | Shift+Tab pressed | Highlight jumps to first result of previous category. If on first, wraps to last category | NAV-007 |
| NAV-009 | Home — first result | Home key pressed | Highlight jumps to first result of first category. Scroll to top | NAV-002 |
| NAV-010 | End — last result | End key pressed | Highlight jumps to last result of last category. Scroll to bottom | NAV-004 |
| NAV-011 | Navigation preserves input focus | Any arrow/Tab navigation | Input field retains focus (user can continue typing). Arrow keys are intercepted by palette, not by input field cursor. Input text selection (if any) is cleared on first arrow key | SEARCH-001 |

### 4.2 Mouse Navigation

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| NAV-020 | Mouse hover result | Mouse moves over a result row | Highlight moves from keyboard-selected item to hovered item. Both visual highlight and aria-activedescendant update | EXEC-* |
| NAV-021 | Mouse hover then keyboard | Mouse hovers item A, then ↓ pressed | Highlight moves from mouse-hovered item A to the item below A (keyboard takes over). Mouse hover is suppressed until mouse moves again | NAV-002 |
| NAV-022 | Mouse click result | Click on any result row | Result executes immediately (see EXEC-*). Palette closes | EXEC-* |
| NAV-023 | Mouse click category header | Click on "WORKSPACES" header | No action. Headers are non-interactive. Click does nothing. No highlight change | — |
| NAV-024 | Scroll via mouse wheel | Mouse wheel in results area | Results scroll. Highlight does NOT follow scroll (stays on same item, may scroll out of view). If user uses keyboard after scrolling, highlight scrolls back into view | NAV-001 |

---

## 5. RESULT ACTIONS & EXECUTION

### 5.1 Navigation Results

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EXEC-010 | Select workspace | Enter/click on workspace result | Palette closes instantly. Sidebar tree navigates to workspace: auto-expands tree path, scrolls to item, selects it. Content panel updates. If workspace was collapsed in tree, it expands with animation | F01-TREE-012 |
| EXEC-011 | Select lakehouse | Enter/click on lakehouse result | Palette closes. Tree: parent workspace expands (if collapsed) → lakehouse selected → content panel shows lakehouse details. Multi-step navigation happens in sequence (expand 200ms → select 100ms) | F01-CONTENT-020 |
| EXEC-012 | Select table | Enter/click on table result | Palette closes. Tree: workspace expands → lakehouse expands → lakehouse selected. Content panel: tables section scrolls to matching table row, row briefly highlights with accent pulse (300ms). Inspector opens if not already visible | F01-CONTENT-041 |
| EXEC-013 | Navigate to stale item | Selected workspace/lakehouse/table no longer exists | Palette closes. Tree attempts navigation → item not found. Toast: "'{name}' was not found — it may have been deleted". Item removed from recents | — |

### 5.2 Command Execution

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EXEC-020 | Execute instant command | Enter/click on non-async command (e.g., "Toggle Theme") | Palette closes. Command executes immediately. Effect visible (theme changes). No toast needed for visual commands | — |
| EXEC-021 | Execute async command | Enter/click on long-running command (e.g., "Run DAG") | Palette closes. Content area shows progress indicator for the operation. Toast: "Running DAG…" with spinner. See EXEC-025 for completion | EXEC-025, EXEC-026 |
| EXEC-022 | Execute command with confirmation | Enter/click on destructive command (e.g., "Cancel DAG", "Force Unlock") | Palette closes. Confirmation toast appears: ⚠ "Cancel the running DAG?" [Cancel DAG] (red) [Keep Running]. User must confirm before execution | EXEC-023, EXEC-024 |
| EXEC-023 | Confirmation accepted | User clicks confirm button on toast | Command executes. Toast updates: "Cancelling DAG…" with spinner → "DAG cancelled" on success | EXEC-025, EXEC-026 |
| EXEC-024 | Confirmation rejected | User clicks cancel/dismiss on toast | No action taken. Toast dismisses. UI returns to prior state | — |
| EXEC-025 | Async command succeeds | Long-running command completes | Toast updates: spinner → checkmark icon. "DAG completed successfully". Toast auto-dismisses after 5s | — |
| EXEC-026 | Async command fails | Long-running command returns error | Toast updates: spinner → error icon (red). "DAG run failed: {error message}". Toast stays until dismissed. [Retry] button if applicable | EXEC-021 (retry) |
| EXEC-027 | Execute disabled command | Enter/click on greyed-out command | Nothing happens. No palette close. Toast: "This command requires a deployed environment. Deploy first." Highlight stays on disabled item. Subtle shake animation on the item (150ms) | — |
| EXEC-028 | Command with side-effect | "Clear Logs", "Export Logs", etc. | Palette closes. Action executes. Toast confirms: "Logs cleared" or "Exported 1,247 log entries to edog-logs-{timestamp}.json" | — |
| EXEC-029 | Execute "Refresh" commands | "Refresh Workspaces", "Refresh Tables" | Palette closes. Target data re-fetches. Loading shimmer in the relevant panel. No extra toast if the refresh is fast (<500ms). Toast: "Refreshed" if >500ms | — |

### 5.3 Feature Flag Navigation

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EXEC-030 | Select feature flag | Enter/click on feature flag result | Palette closes. View switches to Environment view (if not already). Flag list scrolls to matching flag. Flag row highlights with accent pulse (300ms). If flag panel was collapsed, it expands | F-Environment |
| EXEC-031 | Select overridden flag | Enter/click on flag with local override | Same as EXEC-030. Flag row shows override indicator (amber dot). Override details visible in inspector | F-Environment |

### 5.4 Log Entry Navigation

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EXEC-040 | Select log entry | Enter/click on log result | Palette closes. View switches to Logs view (if not already). Log list scrolls to the matching entry. Entry row highlights with accent pulse (300ms) + brief glow. Surrounding context visible (±5 entries) | F-Logs |
| EXEC-041 | Select log — not in current filter | Log entry exists but current log filter hides it | Palette closes. Log filter temporarily cleared to show the entry. Toast: "Filter cleared to show this entry" with [Restore filter] button | F-Logs |

---

## 6. COMMAND REGISTRY & DISABLED STATES

### 6.1 Command Availability

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CMD-001 | Phase 1 commands (disconnected) | Palette open in disconnected mode | Available: Refresh Workspaces, Toggle Theme, Open Settings, Deploy to Lakehouse, Export, Search Workspaces. Disabled (greyed): Run DAG, Cancel DAG, Restart Service, Force Unlock, Clear Logs. Disabled items show "(Deploy first)" hint in muted text | EXEC-027 (disabled), EXEC-020 (enabled) |
| CMD-002 | Phase 2 commands (connected) | Palette open in connected mode | All commands available. Run DAG, Cancel DAG etc. show as fully enabled with accent icons. Phase 1 commands also available | EXEC-020, EXEC-021 |
| CMD-003 | DAG running — command context | DAG is currently executing | "Cancel DAG" command shows "● Running" status badge (green dot). "Run DAG" command shows "(Already running)" hint, disabled | EXEC-022 |
| CMD-004 | No DAG running | DAG idle | "Run DAG" fully enabled. "Cancel DAG" disabled with "(No DAG running)" hint | EXEC-021 |
| CMD-005 | Deploy in progress | Deploy command executing | "Deploy to Lakehouse" shows spinner icon + "(Deploying…)" hint. Not clickable again. Other commands remain available | EXEC-027 |
| CMD-006 | Shortcut hints on commands | Any command with a keyboard shortcut | Shortcut displayed right-aligned in result row: kbd-styled badge (e.g., `Ctrl+Shift+R` for Refresh). Muted background, monospace font | — |

### 6.2 Context-Aware Command Ordering

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CTX-001 | Context: Workspace Explorer | Palette opened while on Workspace Explorer | COMMANDS category: "Deploy to this Lakehouse" pinned at top (if lakehouse selected), followed by "Refresh Workspaces", "Create Workspace" | EXEC-020 |
| CTX-002 | Context: Logs view | Palette opened while on Logs view | COMMANDS category: "Clear Logs", "Export Logs", "Toggle Auto-scroll" pinned at top | EXEC-028 |
| CTX-003 | Context: DAG Studio | Palette opened while on DAG Studio | COMMANDS category: "Run DAG", "Cancel DAG", "Refresh DAG" pinned at top | EXEC-021 |
| CTX-004 | Context: Environment view | Palette opened while on Environment view | COMMANDS category: "Refresh Flags", "Reset Overrides", "Create PR for Flags" pinned at top | EXEC-020 |
| CTX-005 | Recent commands weighted | User has history | Recently used commands appear higher in results when search matches multiple commands equally. MRU score is a tiebreaker, not a primary sort factor | RESULTS-006 |

---

## 7. LOADING & PERFORMANCE

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| PERF-001 | Instant open | Ctrl+K pressed | Palette appears in <100ms. All source data (workspace tree, command registry, feature flags) already in memory. No loading spinner on open | EMPTY-001 |
| PERF-002 | Instant search — small dataset | Type with <100 workspaces, <50 tables | Results appear within same frame (0ms perceived). No flicker, no intermediate "loading" state | RESULTS-001 |
| PERF-003 | Search — medium dataset | Type with 500 workspaces, 200 tables | Filtering completes in <5ms. Results appear instantly. No visible lag between keystroke and result update | RESULTS-001 |
| PERF-004 | Search — large log corpus | Search with 100K log entries in connected mode | Log category may take 30–50ms to filter. Other categories appear instantly. LOGS results append shortly after (single repaint). No spinner — too fast for one | RESULTS-008 |
| PERF-005 | Search — huge dataset edge case | 2000+ workspaces (extreme) | Filtering uses indexed data structure (pre-built on data load). Results still appear in <16ms (within single animation frame). Category truncation (5 per group) ensures render is fast regardless of match count | RESULTS-010 |
| PERF-006 | Data refreshed while palette open | Background refresh updates workspace tree | Results update live. If user is mid-search, results re-filter with new data. New items appear; deleted items vanish. No visual disruption — smooth diff-based update | RESULTS-001 |
| PERF-007 | Memory — recent items | localStorage read on open | Recent items loaded from localStorage synchronously on palette open. Read is <1ms. If localStorage is corrupted/empty, gracefully falls back to EMPTY-002 | RECENT-001, EMPTY-002 |

---

## 8. VISUAL STATES & STYLING

### 8.1 Palette Chrome

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| VIS-001 | Backdrop overlay | Palette visible | Full-viewport overlay behind palette card. Background: oklch(0% 0 0 / 0.20). Prevents interaction with page beneath. Click on backdrop = close | CLOSE-002 |
| VIS-002 | Palette card | Palette visible | Card: 520px wide, auto height (max 480px with scroll). Border-radius: 12px. Background: oklch(18% 0.01 260 / 0.85) with backdrop-filter: blur(16px) saturate(1.8). Border: 1px solid oklch(30% 0.01 260 / 0.5). Box-shadow: 0 24px 48px oklch(0% 0 0 / 0.3) | — |
| VIS-003 | Input field | Palette visible | Height: 48px. Full width minus padding. Left: search icon (magnifying glass, 16px, muted). Right: "Ctrl+K" kbd badge (when empty) or clear button ✕ (when text present). Font: 15px, system font. No visible border — seamless with card. Bottom border: 1px solid var(--border-subtle) | — |
| VIS-004 | Input focus ring | Always when palette open | Input always has focus appearance: bottom border accent color. No outer focus ring (it's always focused). Cursor: blinking bar | — |

### 8.2 Result Item States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| VIS-010 | Result item — default | In results list, not highlighted | Row height: 40px. Left: category icon (16px). Center: name (14px, weight 400) + meta text (12px, muted, right of name or below on narrow). Right: shortcut badge or category tag. Padding: 0 16px. Background: transparent | VIS-011, VIS-012 |
| VIS-011 | Result item — highlighted (keyboard) | Arrow key moves highlight to this item | Background: var(--accent-dim) (oklch(65% 0.15 250 / 0.08)). Left border: 3px solid var(--accent). Name text weight: 500. Smooth transition (100ms) | EXEC-* |
| VIS-012 | Result item — hover (mouse) | Mouse enters row | Same as VIS-011 but without left border (lighter treatment). Background: var(--surface-2) | EXEC-* |
| VIS-013 | Result item — disabled | Command not available in current phase | Opacity: 0.4. Icon greyed. Name has muted color. Hint text appended: "(Deploy first)" or "(No DAG running)". Cursor: default (not pointer). No highlight on hover/keyboard | EXEC-027 |
| VIS-014 | Result item — match highlight | Fuzzy match characters found | Matched characters: font-weight 600 + color var(--accent). Wraps matched chars in `<mark>` with custom styling. Non-matched chars remain weight 400, normal color | — |

### 8.3 Category Headers

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| VIS-020 | Category header | Results grouped by category | Height: 28px. Font: 11px, uppercase, letter-spacing 0.08em, weight 600. Color: var(--text-3) (muted). Left padding: 16px. Icon: category icon (12px, same muted color). Non-interactive (no hover state, no click action). Sticky within scroll container | — |
| VIS-021 | Category header with count | Category has truncated results (>5) | Same as VIS-020 but with count badge: "(12)" right of text, same muted style | — |

### 8.4 Footer

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| VIS-030 | Keyboard hints footer | Palette open | Bottom of card: 32px height. Background: slightly darker than card (oklch(15% 0.01 260 / 0.5)). Text: "↑↓ navigate · Enter select · Esc close" in 11px, muted. Separated from results by 1px border | — |
| VIS-031 | Results count in footer | Search active with results | Left side of footer: "23 results" text. Right side: keyboard hints. Both 11px, muted | — |

### 8.5 Scrolling

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| VIS-040 | Results fit without scroll | ≤10 results, all visible | No scrollbar. Full results visible. Card height adjusts to content (auto) | — |
| VIS-041 | Results need scroll | >10 results or expanded category | Thin custom scrollbar (6px, rounded, var(--surface-3)). Scrollbar only visible when scrolling or hovering results area. Max card height: 480px. Results area scrolls, input + footer stay fixed | — |
| VIS-042 | Keyboard scroll tracking | Arrow navigation moves highlight below visible area | Results area auto-scrolls to keep highlighted item visible. Scroll is smooth (scroll-behavior: smooth). Highlighted item centered vertically when possible, with ≥2 items of context above/below | — |

---

## 9. Z-INDEX & LAYERING

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| LAYER-001 | Palette over content | Palette opened normally | Palette backdrop: z-index 900. Palette card: z-index 901. Above all sidebars (z-100), panels (z-10), toasts (z-800). Below nothing — palette is top layer | — |
| LAYER-002 | Palette over modal | Palette opened while modal/drawer is open | Palette takes priority. Modal/drawer remains open underneath backdrop (dimmed). Closing palette reveals modal again. Escape closes palette first, then modal on second press | CLOSE-001 |
| LAYER-003 | Palette over context menu | Palette opened while context menu is visible | Context menu dismisses first (instant). Palette opens. No conflict | OPEN-001 |
| LAYER-004 | Toast during palette | Command execution shows toast after palette closes | Toast appears at z-index 950 (above backdrop, which is already fading). Toast visible during close animation. If palette is re-opened, toast stays above backdrop | — |

---

## 10. EDGE CASES & ERROR HANDLING

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-001 | Open during deploy | Ctrl+K while deploy in progress | Palette opens normally. "Deploy to Lakehouse" command shows "(Deploying… 45%)" with progress indicator. Not clickable | CMD-005 |
| EDGE-002 | Open with no data loaded | Ctrl+K before workspace tree has loaded | Palette opens. Commands category available. Workspace/Lakehouse/Table categories empty (but no error — they just have no items to search). "Type to search commands…" adjusted placeholder | RESULTS-006 |
| EDGE-003 | Data loads while palette open | Workspace tree finishes loading while palette is open | Categories dynamically appear. If user had a search query, it re-runs against the new data. Results smoothly expand to include new categories | RESULTS-001 |
| EDGE-004 | Rapid open/close | Ctrl+K pressed 5 times quickly | Toggle behavior. Even-count presses = closed, odd = open. No animation queuing — each toggle cancels the previous animation. No visual artifacts | OPEN-001 or CLOSE-001 |
| EDGE-005 | Open at different viewport sizes | Window narrower than 520px + padding | Palette width: min(520px, calc(100vw - 32px)). Horizontal padding: 16px each side. Card remains centered. Results text truncates with ellipsis if needed | VIS-002 |
| EDGE-006 | Open in narrow viewport | Viewport <400px wide | Palette fills nearly full width (calc(100vw - 32px)). Font sizes unchanged. Shortcut badges hidden (not enough room). Meta text wraps below name | VIS-010 |
| EDGE-007 | Result item with very long name | Workspace/table name >80 chars | Name truncated with ellipsis at container width. Full name shown in title attribute (native tooltip on hover). Highlighted match chars still visible even in truncated portion if match is within visible range | VIS-010 |
| EDGE-008 | Network loss during command | "Run DAG" selected, network fails mid-execution | Palette already closed. Toast shows spinner → error: "Network error: could not reach service" with [Retry]. Retry re-executes the command | EXEC-026 |
| EDGE-009 | Token expires while palette open | Auth token expires during palette session | Palette stays open and functional (all data is client-side). When user selects a command that requires API call, silent re-auth triggers first. If re-auth fails, toast: "Session expired" | EXEC-026 |
| EDGE-010 | Multiple browser tabs | Two tabs open with EDOG Studio | Each tab has independent palette state. Ctrl+K opens in focused tab only. Recent items sync via localStorage on next open (storage event listener) | RECENT-001 |
| EDGE-011 | Palette open + window resize | User resizes browser while palette is open | Palette re-centers smoothly (CSS centering, no JS). Width adjusts if viewport becomes smaller than 520px. Results reflow. No flicker | VIS-002 |
| EDGE-012 | Browser back/forward while open | Browser navigation while palette is open | Palette closes. Navigation proceeds. No history entry created by palette itself (palette does not push history state) | CLOSE-001 |

---

## 11. ACCESSIBILITY

### 11.1 ARIA & Semantics

| ID | State | Trigger | What User Sees / Screen Reader Announces | Next States |
|----|-------|---------|------------------------------------------|-------------|
| A11Y-001 | Dialog role | Palette opens | Container: `role="dialog"`, `aria-modal="true"`, `aria-label="Command palette"`. Focus trapped within dialog | FOCUS-001 |
| A11Y-002 | Input labeling | Palette opens, input focused | Input: `role="combobox"`, `aria-expanded="true"`, `aria-controls="palette-results"`, `aria-label="Search commands, workspaces, tables"`, `aria-autocomplete="list"` | — |
| A11Y-003 | Results list role | Results appear | Results container: `role="listbox"`, `id="palette-results"`. Each result: `role="option"`, unique `id` | — |
| A11Y-004 | Category groups | Grouped results displayed | Each category group: `role="group"`, `aria-label="{Category Name}"`. Category header: `role="presentation"` (decorative, not interactive) | — |
| A11Y-005 | Active descendant | Arrow navigation moves highlight | Input: `aria-activedescendant="{highlighted-item-id}"`. Screen reader announces: "{item name}, {category}, {position} of {count}" | NAV-001 |
| A11Y-006 | Result count announcement | Search produces results | `aria-live="polite"` region announces: "{N} results found" on each search change. Debounced to 300ms to avoid spamming announcements | — |
| A11Y-007 | No results announcement | Search produces zero results | `aria-live="polite"` announces: "No results found for {query}" | — |
| A11Y-008 | Disabled item announcement | Keyboard navigates to disabled command | Screen reader announces: "{command name}, disabled, {reason}" (e.g., "Run DAG, disabled, deploy first") | — |
| A11Y-009 | Dialog close announcement | Palette closes | Focus returns to trigger element. Screen reader announces the newly focused element (standard focus behavior) | — |

### 11.2 Keyboard Accessibility

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| A11Y-010 | Full keyboard operation | User has no mouse | Every action achievable via keyboard: open (Ctrl+K), search (type), navigate (↑↓), jump categories (Tab/Shift+Tab), select (Enter), close (Esc). No mouse-only interactions | — |
| A11Y-011 | Focus visible always | Any keyboard interaction | Focus indicator always visible: accent color highlight on results, focus ring on input. No reliance on hover states for discoverability | — |
| A11Y-012 | Escape key layering | Escape pressed with search text | First Escape: clears search (not announced, just visual). Second Escape: closes palette (screen reader announces return to prior context) | EMPTY-001 or CLOSE-001 |
| A11Y-013 | Type-ahead preserved | Arrow navigation then typing | Typing always goes to input (input never loses logical focus). User can arrow through results, then immediately type more characters without clicking input | SEARCH-001 |

### 11.3 Reduced Motion

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| A11Y-020 | Reduced motion — open | `prefers-reduced-motion: reduce` active | No scale animation. Palette appears instantly (opacity 0 → 1 only, no transform). Backdrop appears instantly | EMPTY-001 |
| A11Y-021 | Reduced motion — close | `prefers-reduced-motion: reduce` active | No scale animation. Palette disappears instantly. Backdrop disappears instantly | — |
| A11Y-022 | Reduced motion — highlights | `prefers-reduced-motion: reduce` active | Highlight changes are instant (no transition). Scroll tracking is instant (no smooth scroll). Match character highlighting still works (not animation) | — |
| A11Y-023 | Reduced motion — result transitions | `prefers-reduced-motion: reduce` active | Results appear/disappear instantly when filtering. No fade in/out. Category expansion is instant | — |

---

## 12. THEME & APPEARANCE

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| THEME-001 | Dark theme (default) | System/user preference is dark | Card background: oklch(18% 0.01 260 / 0.85). Text: oklch(90% 0 0). Muted text: oklch(55% 0 0). Border: oklch(30% 0.01 260 / 0.5). Accent: oklch(65% 0.15 250). Backdrop: oklch(0% 0 0 / 0.20) | — |
| THEME-002 | Light theme | User toggles to light theme | Card background: oklch(98% 0.005 260 / 0.90). Text: oklch(15% 0 0). Muted text: oklch(50% 0 0). Border: oklch(80% 0.005 260 / 0.5). Accent: oklch(50% 0.18 250). Backdrop: oklch(0% 0 0 / 0.15) | — |
| THEME-003 | Theme toggle via palette | User opens palette → selects "Toggle Theme" | Palette closes. Theme switches. If user re-opens palette, it uses new theme immediately | — |

---

## State Count Summary

| Category | Count |
|----------|-------|
| 1. Open/Close Lifecycle | 17 |
| 2. Empty State & Recents | 8 |
| 3. Search & Results | 30 |
| 4. Keyboard Navigation | 16 |
| 5. Result Actions & Execution | 19 |
| 6. Command Registry & Disabled States | 11 |
| 7. Loading & Performance | 7 |
| 8. Visual States & Styling | 16 |
| 9. Z-Index & Layering | 4 |
| 10. Edge Cases & Error Handling | 12 |
| 11. Accessibility | 13 |
| 12. Theme & Appearance | 3 |
| **Total** | **156** |

---

## Cross-References

| This State | Depends On / References |
|------------|------------------------|
| EXEC-010, EXEC-011, EXEC-012 | F01 Workspace Explorer (TREE-012, CONTENT-020, CONTENT-041) |
| EXEC-030, EXEC-031 | F-Environment view (feature flags panel) |
| EXEC-040, EXEC-041 | F-Logs view (log scroll + filter) |
| EXEC-021, CMD-003 | F-DAG Studio (DAG execution state) |
| CMD-001, CMD-002 | ADR-001 two-phase lifecycle |
| EDGE-009 | F00 onboarding (token re-auth flow) |
| RECENT-001 through RECENT-005 | localStorage persistence layer |
| PERF-001 through PERF-005 | In-memory data architecture per ADR-003 |
