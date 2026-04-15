# P3 State Matrices — C08-CodePreviewPanel & C09-ReviewSummary

> **Feature:** F16 — New Infrastructure Wizard
> **Phase:** P3 (State Matrices)
> **Components:** C08-CodePreviewPanel, C09-ReviewSummary
> **Author:** Pixel (JS/CSS) + Sana (Architecture)
> **Status:** COMPLETE
> **Source Specs:** `components/C08-code-preview-panel.md`, `components/C09-review-summary.md`

---

## Table of Contents

1. [C08 — CodePreviewPanel States](#c08--codepreviewpanel-states)
2. [C09 — ReviewSummary States](#c09--reviewsummary-states)
3. [Cross-Component Interactions](#cross-component-interactions)

---

# C08 — CodePreviewPanel States

> Panel on the right edge of the DAG Canvas (Page 3).
> Collapsible, resizable, on-demand code generation with syntax highlighting.

## Master State Diagram

```
                    ┌──────────────────────────────────────────────────┐
                    │              PANEL VISIBILITY                     │
                    │  ┌───────────┐   toggle()  ┌──────────────────┐  │
                    │  │ COLLAPSED │◄───────────►│    EXPANDED      │  │
                    │  └───────────┘  (via C08.3 │                  │  │
                    │       ▲         expanding/  │ ┌──────────────┐│  │
                    │       │         collapsing)  │ │ RESIZE SUB  ││  │
                    │       │                     │ └──────────────┘│  │
                    │       │                     └──────────────────┘  │
                    └──────────────────────────────────────────────────┘
                                         │
                    ┌────────────────────┼──────────────────────────────┐
                    │       CODE GENERATION (orthogonal)                │
                    │  IDLE ──► GENERATING ──► GENERATED ──► STALE     │
                    │                    └──► ERROR                     │
                    └──────────────────────────────────────────────────┘
                                         │
                    ┌────────────────────┼──────────────────────────────┐
                    │       CONTENT / CLIPBOARD (orthogonal)            │
                    │  EMPTY | HAS_CODE | SCROLLED                     │
                    │  COPY_IDLE | COPIED | COPY_FAILED                │
                    └──────────────────────────────────────────────────┘
```

---

### C08.1 — Panel.Collapsed

| Field | Value |
|-------|-------|
| **State ID** | `C08.panel.collapsed` |
| **Entry Conditions** | Initial load when returning from other page with collapsed memory; user clicks toggle while expanded; `Escape` pressed while panel focused; `Ctrl+Shift+C` pressed while expanded |
| **Exit Conditions** | `toggle()` called → `C08.panel.expanding`; `Ctrl+Shift+C` → `C08.panel.expanding` |
| **Visual Description** | Panel has zero width, fully invisible. Only the toggle tab (▸) is visible, flush against the right edge of the canvas. The DagCanvas viewport fills the full width. |
| **Active DOM Elements** | **Visible:** `.code-panel-toggle` (shows "▸", `right: 0`). **Hidden:** `.code-panel` (`width: 0`, `opacity: 0`, `pointer-events: none`), all header buttons, code body, gutter, resize handle. |
| **Keyboard Shortcuts** | `Ctrl+Shift+C` → expand panel. `Tab` to toggle button → `Enter`/`Space` → expand. |
| **Data Requirements** | `panelState: 'collapsed'` in wizard session state. Previously generated code (if any) retained in memory. |
| **Transitions** | `toggle()` / `Ctrl+Shift+C` / `Enter` on toggle btn → `C08.panel.expanding` |
| **Error Recovery** | N/A — collapsed is a stable idle state. |
| **Animation** | None in this state. Toggle button has `transition: all var(--t-fast) var(--ease)` for hover highlight. |

---

### C08.2 — Panel.Expanding

| Field | Value |
|-------|-------|
| **State ID** | `C08.panel.expanding` |
| **Entry Conditions** | `toggle()` called from `C08.panel.collapsed`; `Ctrl+Shift+C` while collapsed. |
| **Exit Conditions** | Animation completes (250ms) → `C08.panel.expanded` |
| **Visual Description** | Panel width animates from 0 → `panelWidth` (default 280px). Content fades in starting at the 150ms mark. Toggle button tracks the expanding edge, text transitions from "▸" to "◂". Canvas shrinks to accommodate. |
| **Active DOM Elements** | **Animating:** `.code-panel` (`width` transitioning, `opacity` transitioning). `.code-panel-toggle` (`right` tracking width). **Disabled:** all interactive elements inside panel during transition. |
| **Keyboard Shortcuts** | None active during animation — input buffered. |
| **Data Requirements** | `panelWidth` from session state (default 280px). |
| **Transitions** | Transition-end event → `C08.panel.expanded`. (Cannot be interrupted — toggle during expand is queued.) |
| **Error Recovery** | If transition is interrupted (e.g., page navigation), snap to expanded state immediately. |
| **Animation** | `width: 0 → panelWidth` — 250ms `cubic-bezier(0, 0, 0.2, 1)`. `opacity: 0 → 1` — 200ms `var(--ease)`. Toggle `right: 0 → panelWidth` — 250ms `var(--ease-out)`. Content fade-in at 150ms mark. Scroll position restored at 250ms. `@prefers-reduced-motion: reduce` → instant snap, no transition. |

---

### C08.3 — Panel.Expanded

| Field | Value |
|-------|-------|
| **State ID** | `C08.panel.expanded` |
| **Entry Conditions** | Expanding animation completes; first visit to Page 3 (default state); return to Page 3 with expanded memory. |
| **Exit Conditions** | `toggle()` → `C08.panel.collapsing`; `Escape` (panel focused) → `C08.panel.collapsing`; `Ctrl+Shift+C` → `C08.panel.collapsing`; mousedown on resize handle → `C08.panel.resizing` |
| **Visual Description** | Panel fully visible at `panelWidth`. Header shows "CODE PREVIEW" title, Refresh (↻) and Copy (📋) buttons. Code body area shows either placeholder, generated code, or error depending on code-generation sub-state. Toggle button shows "◂". Resize handle visible on hover (left edge, 4px). |
| **Active DOM Elements** | **Visible:** `.code-panel` (full width+opacity), `.code-panel-header`, `.code-panel-title`, `.code-panel-actions` (Refresh btn, Copy btn), `.code-panel-body` (code or placeholder), `.code-gutter` (if code present), `.code-panel-toggle` ("◂"), `.code-panel-resize`. **Conditional:** `.stale-badge` (if stale), `.code-panel-error` (if error). |
| **Keyboard Shortcuts** | `Ctrl+Shift+C` → collapse. `Ctrl+Shift+R` → refresh code. `Escape` (panel focused) → collapse, return focus to canvas. `Tab` → Refresh btn → Copy btn → Code body. `Ctrl+A` (code body focused) → select all. `Ctrl+C` (text selected) → copy selection. |
| **Data Requirements** | `panelState: 'expanded'`, `panelWidth`, current code-generation sub-state data. |
| **Transitions** | `toggle()` / `Escape` / `Ctrl+Shift+C` → `C08.panel.collapsing`. Resize handle mousedown → `C08.panel.resizing`. |
| **Error Recovery** | N/A — stable state. |
| **Animation** | Resize handle: `background: transparent → var(--accent)` on hover, `var(--t-fast) var(--ease)`. Button hover: `background: var(--surface-2) → var(--surface-3)`, active: `scale(0.95)`. |

---

### C08.4 — Panel.Collapsing

| Field | Value |
|-------|-------|
| **State ID** | `C08.panel.collapsing` |
| **Entry Conditions** | `toggle()` called from `C08.panel.expanded`; `Escape` while panel focused; `Ctrl+Shift+C` while expanded. |
| **Exit Conditions** | Animation completes (250ms) → `C08.panel.collapsed` |
| **Visual Description** | Content fades out immediately. Panel width animates from `panelWidth` → 0. Toggle button tracks the collapsing edge, text transitions from "◂" to "▸". Canvas expands to fill freed space. |
| **Active DOM Elements** | **Animating:** `.code-panel` (width + opacity transitioning). `.code-panel-toggle` (`right` tracking width). **Disabled:** all interactive elements. |
| **Keyboard Shortcuts** | None active during animation. |
| **Data Requirements** | Current `panelWidth` for animation start point. |
| **Transitions** | Transition-end → `C08.panel.collapsed`. Focus returns to canvas. DagCanvas receives `onToggle(false)`. |
| **Error Recovery** | If interrupted by page navigation, snap to collapsed. |
| **Animation** | Content opacity: immediate fade. `width: panelWidth → 0` — 250ms `var(--ease-out)`. `opacity: 1 → 0` — 200ms `var(--ease)`. Toggle `right: panelWidth → 0` — 250ms `var(--ease-out)`. `@prefers-reduced-motion: reduce` → instant snap. |

---

### C08.5 — Panel.Resizing

| Field | Value |
|-------|-------|
| **State ID** | `C08.panel.resizing` |
| **Entry Conditions** | `mousedown` on `.code-panel-resize` handle while panel is expanded. |
| **Exit Conditions** | `mouseup` anywhere → `C08.panel.expanded` (with new width) |
| **Visual Description** | Cursor changes to `col-resize` across the entire document. Panel width follows the mouse position in real-time. Resize handle has accent color background (`.active`). Code content reflows within new width. Canvas viewport adjusts in real-time. |
| **Active DOM Elements** | **Active:** `.code-panel-resize.active` (accent background). Document body cursor override. **Updating:** `.code-panel` width (clamped 220px–480px). `.code-panel-toggle` `right` tracking. DagCanvas viewport. |
| **Keyboard Shortcuts** | `Escape` → cancel resize, revert to previous width, → `C08.panel.expanded`. |
| **Data Requirements** | `isResizing: true`. Starting width, cursor start-x, min/max constraints (220px, 480px). |
| **Transitions** | `mouseup` → `C08.panel.expanded` (new width persisted to session). `Escape` → `C08.panel.expanded` (original width restored). |
| **Error Recovery** | If mouse leaves the window during drag, treat as mouseup at last known position. Clamp enforced on every frame. |
| **Animation** | No CSS transitions during resize — direct width assignment per `mousemove` for real-time response. Handle `background: var(--accent)` while `.active`. |

---

### C08.6 — CodeGen.Idle

| Field | Value |
|-------|-------|
| **State ID** | `C08.codegen.idle` |
| **Entry Conditions** | First visit to Page 3 (no code generated yet); component initialization. |
| **Exit Conditions** | `refresh()` called → `C08.codegen.generating` |
| **Visual Description** | Code area shows centered placeholder: icon (40×40 rounded square, `var(--surface-2)` bg) + text "Click 'Refresh' to generate code preview from your DAG." in muted gray. Line number gutter shows "—". |
| **Active DOM Elements** | **Visible:** `.code-panel-placeholder`, `.code-panel-placeholder-icon`. **Disabled:** Copy button (no code to copy). **Enabled:** Refresh button. **Hidden:** `.code-block`, `.code-gutter` (line numbers), `.stale-badge`. |
| **Keyboard Shortcuts** | `Ctrl+Shift+R` → trigger refresh. `Enter`/`Space` on Refresh button → trigger refresh. |
| **Data Requirements** | `generationStatus: 'idle'`, `generatedCode: ''`, `lastGeneratedAt: null`. |
| **Transitions** | `refresh()` → `C08.codegen.generating` |
| **Error Recovery** | N/A — stable initial state. |
| **Animation** | None. |

---

### C08.7 — CodeGen.Generating

| Field | Value |
|-------|-------|
| **State ID** | `C08.codegen.generating` |
| **Entry Conditions** | `refresh()` called from any code-gen state (idle, generated, stale, error). Auto-refresh on Page 3 entry (via `wizardDialog.onPageChange`). |
| **Exit Conditions** | Generation succeeds → `C08.codegen.generated`; generation fails → `C08.codegen.error` |
| **Visual Description** | Refresh button shows spinning icon (SVG rotates). Refresh button is disabled (`pointer-events: none`, `opacity: 0.5`). If previous code exists, it remains visible (not cleared). If no previous code, placeholder remains. Stale badge hidden during generation. |
| **Active DOM Elements** | **Visible:** `.code-panel-btn.refreshing` (spinner). Previous code or placeholder. **Disabled:** Refresh button, Copy button. **Hidden:** `.stale-badge`. |
| **Keyboard Shortcuts** | `Ctrl+Shift+R` — ignored (already generating). Copy shortcuts — ignored. |
| **Data Requirements** | `generationStatus: 'generating'`. DAG topology from `getDagTopology()`. Theme config from `getThemeConfig()`. `scrollTop` preserved for restoration. |
| **Transitions** | Success (code generated, highlighted) → `C08.codegen.generated`. Cycle detected / error → `C08.codegen.error`. |
| **Error Recovery** | If page navigation occurs during generation, cancel in-flight work — no partial DOM update. |
| **Animation** | Refresh icon: `@keyframes spin` — `rotate(0deg) → rotate(360deg)`, 0.8s `linear infinite`. `@prefers-reduced-motion: reduce` → static "..." text replaces spinner. |

---

### C08.8 — CodeGen.Generated

| Field | Value |
|-------|-------|
| **State ID** | `C08.codegen.generated` |
| **Entry Conditions** | Code generation completes successfully. |
| **Exit Conditions** | `refresh()` → `C08.codegen.generating`; `markStale()` (DAG topology changed) → `C08.codegen.stale` |
| **Visual Description** | Full syntax-highlighted code displayed in `.code-block` with monospace font (JetBrains Mono, 10px, line-height 1.7). Line number gutter shows 1-based numbers in muted color at 50% opacity. Cells separated by divider comments (`═══`). Code is read-only, selectable. |
| **Active DOM Elements** | **Visible:** `.code-gutter` with `.code-gutter-line` per line, `.code-content` with `.code-block` (syntax-highlighted HTML with `.tok-*` spans). **Enabled:** Refresh button, Copy button. **Hidden:** `.code-panel-placeholder`, `.code-panel-error`, `.stale-badge`. |
| **Keyboard Shortcuts** | `Ctrl+Shift+R` → refresh. `Ctrl+A` (code body focused) → select all. `Ctrl+C` (text selected) → copy selection. Copy button (`Enter`/`Space`) → `copyToClipboard()`. |
| **Data Requirements** | `generationStatus: 'idle'` (generation complete), `generatedCode` (raw text), `highlightedHtml` (rendered HTML), `lineCount`, `lastGeneratedAt` (timestamp), `scrollTop` (restored). |
| **Transitions** | `refresh()` → `C08.codegen.generating`. `markStale()` → `C08.codegen.stale`. `copyToClipboard()` → triggers clipboard sub-state. |
| **Error Recovery** | N/A — stable state with valid code. |
| **Animation** | Code body rendered via `requestAnimationFrame` for batched DOM update. Scroll position restored after render. |

---

### C08.9 — CodeGen.Stale

| Field | Value |
|-------|-------|
| **State ID** | `C08.codegen.stale` |
| **Entry Conditions** | `markStale()` called by DagCanvas after any topology change (node add/remove/rename/reconnect/type change/schema change). |
| **Exit Conditions** | `refresh()` → `C08.codegen.generating` |
| **Visual Description** | Previously generated code remains fully visible and scrollable. A "STALE" badge appears next to panel title (pill shape, `var(--status-warn-dim)` bg, `var(--status-warn)` text, 9px uppercase). Refresh button gains a subtle pulse animation (`pulseAccent 2s ease-in-out infinite`) to draw user attention. |
| **Active DOM Elements** | **Visible:** All generated code elements, `.stale-badge` (animated fade-in, 200ms). **Modified:** `.code-panel-btn.stale-pulse` on Refresh button. **Enabled:** Refresh button (pulsing), Copy button (copies stale code). |
| **Keyboard Shortcuts** | `Ctrl+Shift+R` → refresh (clears stale). Copy shortcuts still work on stale code. |
| **Data Requirements** | `isStale: true`. Previous `generatedCode` and `highlightedHtml` retained. |
| **Transitions** | `refresh()` → `C08.codegen.generating` (clears stale badge, stops pulse). |
| **Error Recovery** | Multiple `markStale()` calls are idempotent — badge shown once, no stacking. |
| **Animation** | Stale badge entrance: `@keyframes fadeIn` — 200ms `var(--ease)`. Refresh button pulse: `@keyframes pulseAccent` — 2s `ease-in-out infinite`. `@prefers-reduced-motion: reduce` → badge appears instantly, no pulse. |

---

### C08.10 — CodeGen.Error

| Field | Value |
|-------|-------|
| **State ID** | `C08.codegen.error` |
| **Entry Conditions** | Code generation fails — cycle detected, stack overflow in topo sort, unknown node type, corrupted DAG data. |
| **Exit Conditions** | `refresh()` → `C08.codegen.generating` (retry) |
| **Visual Description** | Code area replaced by centered error display: error icon (✕ in red), title "Generation Failed", error message text, and a "Retry" button. Background remains `.code-panel` surface color. |
| **Active DOM Elements** | **Visible:** `.code-panel-error`, `.code-panel-error-icon` (✕), `.code-panel-error-title`, `.code-panel-error-msg`, Retry button inside error area. **Enabled:** Refresh button (in header), Retry button (in error area). **Disabled:** Copy button (no valid code). **Hidden:** `.code-block`, `.code-gutter`, `.code-panel-placeholder`. |
| **Keyboard Shortcuts** | `Ctrl+Shift+R` → retry. `Enter`/`Space` on Retry button → retry. `Tab` → Refresh btn → Retry btn. |
| **Data Requirements** | `generationStatus: 'error'`, `generationError` (human-readable message, e.g., "Circular dependency detected between nodes: A → B → C → A"). |
| **Transitions** | `refresh()` or Retry click → `C08.codegen.generating`. |
| **Error Recovery** | Error message always includes actionable guidance. Cycle errors name the involved nodes. Retry is always available. Screen reader: `aria-live="polite"` announces error. |
| **Animation** | Error area entrance: `fadeIn 200ms var(--ease)`. |

---

### C08.11 — Content.Empty

| Field | Value |
|-------|-------|
| **State ID** | `C08.content.empty` |
| **Entry Conditions** | `refresh()` called when DAG canvas has zero nodes. |
| **Exit Conditions** | User adds nodes + calls `refresh()` → `C08.content.has-code` (via generating → generated) |
| **Visual Description** | Code area shows a two-line comment: `-- No nodes on canvas.` / `-- Add nodes from the palette to generate code.` Line count: 2. Displayed with syntax highlighting (comment token class `.tok-cm`, italic, muted). |
| **Active DOM Elements** | **Visible:** `.code-block` (2-line comment), `.code-gutter` (lines 1-2). **Disabled:** Copy button (empty code is not useful to copy). **Enabled:** Refresh button. |
| **Keyboard Shortcuts** | Standard panel shortcuts. Copy disabled. |
| **Data Requirements** | `generatedCode` = 2-line comment string. `lineCount: 2`. DAG topology: `{ nodes: [], edges: [] }`. |
| **Transitions** | `refresh()` → `C08.codegen.generating`. `markStale()` → `C08.codegen.stale` (shows stale badge over the empty message). |
| **Error Recovery** | N/A — valid state for an empty DAG. |
| **Animation** | None. |

---

### C08.12 — Content.HasCode

| Field | Value |
|-------|-------|
| **State ID** | `C08.content.has-code` |
| **Entry Conditions** | Successful generation with ≥1 DAG node. |
| **Exit Conditions** | Refresh with empty DAG → `C08.content.empty`. Scroll → `C08.content.scrolled`. |
| **Visual Description** | Full syntax-highlighted notebook code. Cells in topological order, separated by `═══` divider comments. Pip install cell appears first if PySpark MLV nodes exist. Each cell has a header comment: `-- Cell N: name (Type) [schema]`. Line numbers in gutter. Scrollbar visible if content exceeds viewport. |
| **Active DOM Elements** | **Visible:** `.code-gutter` (numbered), `.code-content` > `.code-block` (highlighted). All token classes active: `.tok-kw`, `.tok-type`, `.tok-str`, `.tok-cm`, `.tok-fn`, `.tok-dec`, `.tok-num`, `.tok-op`, `.tok-div`. **Enabled:** Copy button, Refresh button. |
| **Keyboard Shortcuts** | All standard panel shortcuts. `Ctrl+A` selects all code. `Ctrl+C` copies selection. |
| **Data Requirements** | `generatedCode` (raw), `highlightedHtml`, `lineCount`, `generatedCells[]` array. Theme sample data loaded. |
| **Transitions** | User scrolls → `C08.content.scrolled`. `refresh()` → `C08.codegen.generating`. `markStale()` → `C08.codegen.stale`. |
| **Error Recovery** | Nodes with empty names get placeholder: `unnamed_node_{id}` + warning comment. |
| **Animation** | None — static content. Scroll is native browser scrolling at 60fps. |

---

### C08.13 — Content.Scrolled

| Field | Value |
|-------|-------|
| **State ID** | `C08.content.scrolled` |
| **Entry Conditions** | User scrolls the code body (`.code-panel-body`) away from scrollTop=0. |
| **Exit Conditions** | User scrolls back to top → `C08.content.has-code`. `refresh()` → preserves scrollTop, regenerates, restores position. |
| **Visual Description** | Identical to `has-code` but with a non-zero `scrollTop`. Line numbers and code content are scrolled in sync (flex sibling scroll lock). A subtle top shadow may appear on the header border to indicate scroll depth. |
| **Active DOM Elements** | Same as `C08.content.has-code`. `scrollTop` tracked and persisted. |
| **Keyboard Shortcuts** | Same as `C08.content.has-code`. Arrow keys scroll within focused code body. |
| **Data Requirements** | `scrollTop` (persisted across refresh and panel collapse/expand). |
| **Transitions** | Scroll to top → `C08.content.has-code`. `refresh()` → `C08.codegen.generating` (preserves + restores scrollTop). `collapse()` → scrollTop saved, restored on expand. |
| **Error Recovery** | If scrollTop exceeds content height after refresh (code became shorter), clamp to max scrollTop. |
| **Animation** | Native browser scrolling. Scroll position restoration on refresh is instant (no smooth scroll). |

---

### C08.14 — Clipboard.Idle

| Field | Value |
|-------|-------|
| **State ID** | `C08.clipboard.idle` |
| **Entry Conditions** | Default state. Returns from `copied` after 1.5s timeout. Returns from `copy-failed` after 1.5s timeout. |
| **Exit Conditions** | `copyToClipboard()` succeeds → `C08.clipboard.copied`. `copyToClipboard()` fails → `C08.clipboard.copy-failed`. |
| **Visual Description** | Copy button shows clipboard icon in default muted color. Normal hover/active states. |
| **Active DOM Elements** | **Visible:** Copy button (`.code-panel-btn`) with clipboard SVG icon. **State:** default appearance — `color: var(--text-muted)`, `background: var(--surface-2)`. |
| **Keyboard Shortcuts** | `Enter`/`Space` on Copy button → `copyToClipboard()`. |
| **Data Requirements** | `generatedCode` must be non-empty for button to be enabled. |
| **Transitions** | Copy success → `C08.clipboard.copied`. Copy failure → `C08.clipboard.copy-failed`. |
| **Error Recovery** | N/A. |
| **Animation** | Standard button hover: `background: var(--surface-3)`, `color: var(--text)`. Active: `scale(0.95)`. |

---

### C08.15 — Clipboard.Copied

| Field | Value |
|-------|-------|
| **State ID** | `C08.clipboard.copied` |
| **Entry Conditions** | `navigator.clipboard.writeText()` resolves successfully, or `document.execCommand('copy')` fallback returns `true`. |
| **Exit Conditions** | 1500ms timeout → `C08.clipboard.idle` |
| **Visual Description** | Copy button icon changes from clipboard to checkmark (✓). Button gains green success styling: `color: var(--status-ok)`, `background: var(--status-ok-dim)`. A subtle green flash on the button background. Screen reader announces "Code copied to clipboard". |
| **Active DOM Elements** | **Modified:** Copy button → `.code-panel-btn.copy-success` (checkmark icon, green colors). |
| **Keyboard Shortcuts** | Button is still focusable but re-clicking during success state re-triggers copy. |
| **Data Requirements** | Raw `generatedCode` text was written to clipboard. |
| **Transitions** | 1500ms `setTimeout` → `C08.clipboard.idle` (revert icon + colors). Another `copyToClipboard()` → restarts 1500ms timer. |
| **Error Recovery** | N/A — success state. |
| **Animation** | Icon swap: instant. Background flash: `var(--status-ok-dim)` → `var(--surface-2)` over 300ms. `@prefers-reduced-motion: reduce` → no flash, instant color change for 1.5s then revert. |

---

### C08.16 — Clipboard.CopyFailed

| Field | Value |
|-------|-------|
| **State ID** | `C08.clipboard.copy-failed` |
| **Entry Conditions** | Both `navigator.clipboard.writeText()` and `document.execCommand('copy')` fallback fail (insecure context, permission denied). |
| **Exit Conditions** | 1500ms timeout → `C08.clipboard.idle` |
| **Visual Description** | Copy button briefly shows failure state. A tooltip appears: "Select code and press Ctrl+C to copy." Screen reader announces "Failed to copy code to clipboard". |
| **Active DOM Elements** | **Modified:** Copy button shows brief error indicator. Tooltip (positioned above button) visible for 3 seconds. |
| **Keyboard Shortcuts** | `Ctrl+A` then `Ctrl+C` — manual fallback hint provided to user. |
| **Data Requirements** | `onCopy(false)` callback fired. |
| **Transitions** | 1500ms → `C08.clipboard.idle`. Tooltip auto-dismisses after 3s. |
| **Error Recovery** | Fallback path: hidden textarea select+execCommand attempted before reaching this state. Tooltip instructs manual copy. |
| **Animation** | Tooltip entrance: `fadeIn 150ms var(--ease)`. Tooltip exit: `fadeOut 150ms` at 3s mark. |

---

### C08.17 — Refresh.Idle

| Field | Value |
|-------|-------|
| **State ID** | `C08.refresh.idle` |
| **Entry Conditions** | Default state. Returns after refresh completes (success or error). |
| **Exit Conditions** | `refresh()` triggered → `C08.refresh.refreshing` |
| **Visual Description** | Refresh button shows static refresh icon (↻). Default muted color. Standard hover/active interactions. If stale, button has pulse animation (`stale-pulse` class). |
| **Active DOM Elements** | **Visible:** Refresh button (`.code-panel-btn`), standard appearance. **Conditional:** `.stale-pulse` class if in stale code-gen state. |
| **Keyboard Shortcuts** | `Ctrl+Shift+R` → refresh. `Enter`/`Space` on button → refresh. |
| **Data Requirements** | None specific. |
| **Transitions** | Click / shortcut → `C08.refresh.refreshing`. |
| **Error Recovery** | N/A. |
| **Animation** | Stale pulse: `@keyframes pulseAccent` — 2s `ease-in-out infinite` (only when code-gen is stale). |

---

### C08.18 — Refresh.Refreshing

| Field | Value |
|-------|-------|
| **State ID** | `C08.refresh.refreshing` |
| **Entry Conditions** | `refresh()` called. Code generation pipeline starts. |
| **Exit Conditions** | Generation completes (success/error) → `C08.refresh.idle` |
| **Visual Description** | Refresh button icon spins continuously. Button dimmed (`opacity: 0.5`), non-interactive (`pointer-events: none`). |
| **Active DOM Elements** | **Modified:** `.code-panel-btn.refreshing` — spinning SVG, dimmed, disabled. |
| **Keyboard Shortcuts** | `Ctrl+Shift+R` — ignored. Button not focusable. |
| **Data Requirements** | In-flight code generation operation. |
| **Transitions** | Generation success → `C08.refresh.idle` + `C08.codegen.generated`. Generation error → `C08.refresh.idle` + `C08.codegen.error`. |
| **Error Recovery** | If page navigates away during spin, generation is cancelled, state resets to idle. |
| **Animation** | `@keyframes spin` — `rotate(360deg)`, 0.8s `linear infinite`. `@prefers-reduced-motion: reduce` → static "..." text replaces spinner. |

---

### C08.19 — LineNumbers.Visible

| Field | Value |
|-------|-------|
| **State ID** | `C08.linenums.visible` |
| **Entry Conditions** | Panel expanded and code-gen state is `generated`, `stale`, or `empty` (always visible when panel is open and code body is shown). |
| **Exit Conditions** | Panel collapses → hidden with panel. |
| **Visual Description** | Left gutter (36px wide) with right border, `var(--surface-2)` background. Each line number right-aligned in JetBrains Mono 10px, `var(--text-muted)` at 50% opacity. Line numbers scroll in sync with code content (flex sibling). Shows "—" when in idle state (no generated code). |
| **Active DOM Elements** | **Visible:** `.code-gutter` with `.code-gutter-line` × `lineCount`. |
| **Keyboard Shortcuts** | Not independently interactive. |
| **Data Requirements** | `lineCount` from last generation. |
| **Transitions** | Code body scrolls → gutter scrolls in sync. Panel collapse → hidden. Refresh → re-rendered with new line count. |
| **Error Recovery** | If lineCount exceeds 9999, gutter width auto-expands (unlikely at 100-node max). |
| **Animation** | None — static rendering. Scroll is native. |

---

## C08 State Transition Summary

```
┌──────────────┐     toggle()     ┌──────────────┐
│  COLLAPSED   │◄────────────────►│  EXPANDING   │
│   C08.1      │  (via C08.4)     │   C08.2      │
└──────────────┘                  └──────┬───────┘
       ▲                                 │ 250ms
       │                                 ▼
       │         toggle()         ┌──────────────┐     mousedown      ┌──────────────┐
       └──────────────────────────│  EXPANDED    │────────────────────►│  RESIZING    │
              (via C08.4)         │   C08.3      │◄────────────────────│   C08.5      │
                                  └──────────────┘     mouseup         └──────────────┘

CODE GENERATION (orthogonal — runs inside any panel-visible state):

┌──────────┐  refresh()  ┌─────────────┐  success  ┌─────────────┐  markStale()  ┌──────────┐
│   IDLE   │────────────►│ GENERATING  │──────────►│  GENERATED  │─────────────►│  STALE   │
│  C08.6   │             │   C08.7     │           │   C08.8     │              │  C08.9   │
└──────────┘             └──────┬──────┘           └──────┬──────┘              └────┬─────┘
                                │ error                    │ refresh()               │ refresh()
                                ▼                          ▼                         ▼
                         ┌──────────────┐           ┌─────────────┐          ┌─────────────┐
                         │   ERROR      │           │ GENERATING  │          │ GENERATING  │
                         │  C08.10      │──refresh()►│   C08.7     │◄─────────│   C08.7     │
                         └──────────────┘           └─────────────┘          └─────────────┘

CLIPBOARD (orthogonal):

┌──────────┐  success   ┌──────────┐  1500ms  ┌──────────┐
│   IDLE   │───────────►│  COPIED  │─────────►│   IDLE   │
│  C08.14  │            │  C08.15  │          │  C08.14  │
│          │  failure   ┌──────────┐  1500ms  │          │
│          │───────────►│  FAILED  │─────────►│          │
└──────────┘            │  C08.16  │          └──────────┘
                        └──────────┘
```

---
---

# C09 — ReviewSummary States

> Page 4 of the wizard — final review and confirmation gate before environment creation.
> Two-column layout: left (summary + confirmation), right (mini-DAG).

## Master State Diagram

```
┌──────────────┐
│  UNMOUNTED   │ C09.1
└──────┬───────┘
       │ mount()
       ▼
┌──────────────┐
│  ENTERING    │ C09.2 — fade-in animation + validation
└──────┬───────┘
       │ render complete + validation
       ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   INVALID    │     │    READY     │     │   WARNING    │
│   C09.4      │     │    C09.5     │     │   C09.6      │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                     │                     │
       │ edit click    Lock In click          Lock In click
       ▼                     ▼                     ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ NAV.EDITING  │     │ LOCK.CONFIRM │     │ LOCK.CONFIRM │
│   C09.11     │     │   C09.12     │     │   C09.12     │
└──────┬───────┘     └──────┬───────┘     └──────────────┘
       │ return               │ confirmed
       ▼                     ▼
┌──────────────┐     ┌──────────────┐
│  ENTERING    │     │  CONFIRMED   │ → Page 5 (Execution)
│   C09.2      │     │   C09.13     │
└──────────────┘     └──────────────┘

TEMPLATE SAVE (orthogonal sub-machine — any active state):
  IDLE → DIALOG_OPEN → NAMING → SAVING → SAVED / SAVE_ERROR → IDLE
```

---

### C09.1 — Page.Unmounted

| Field | Value |
|-------|-------|
| **State ID** | `C09.page.unmounted` |
| **Entry Conditions** | Component not yet initialized. User is on Pages 1–3. `unmount()` called after navigating away. |
| **Exit Conditions** | `mount()` → `C09.page.entering` |
| **Visual Description** | No DOM present for C09. Page 4 content area is empty or shows previous page content. |
| **Active DOM Elements** | None — `.review-summary` not in DOM. |
| **Keyboard Shortcuts** | None (C09 not active). |
| **Data Requirements** | None. Wizard state held by C12-WizardShell. |
| **Transitions** | C12-WizardShell calls `mount()` when user navigates to Page 4 → `C09.page.entering`. |
| **Error Recovery** | N/A. |
| **Animation** | None. |

---

### C09.2 — Page.Entering

| Field | Value |
|-------|-------|
| **State ID** | `C09.page.entering` |
| **Entry Conditions** | `mount()` called by WizardShell. Also re-entry after `refresh(updatedState)` from edit return. |
| **Exit Conditions** | Render complete + validation complete → `C09.page.ready` or `C09.page.warning` or `C09.page.invalid`. If `unmount()` during enter → `C09.page.unmounted`. |
| **Visual Description** | Two-column grid materializes. Sections fade in sequentially (100ms stagger per section). Mini-DAG scales in on the right (500ms ease, 200ms delay). Footer transforms: "Next →" becomes "Lock In & Create ▸". Cross-step validation runs synchronously. |
| **Active DOM Elements** | **Animating:** `.review-section` × 3 (fadeIn 400ms staggered). `.review-mini-dag` (scaleIn 500ms, 200ms delay). `.review-confirm` (fadeIn). **Disabled:** "Lock In & Create ▸" button (spinner while validating). All Edit links disabled during animation. Template save button disabled. |
| **Keyboard Shortcuts** | None active until animation + validation complete. Input is buffered. |
| **Data Requirements** | Complete wizard state from C12-WizardShell: `InfrastructureSelections`, `ConfigurationSelections`, `DagTopology`. ReviewModel built from state. `ConfirmationSummary` computed. |
| **Transitions** | Validation passed (no errors, no warnings) → `C09.page.ready`. Validation warnings only → `C09.page.warning`. Validation errors → `C09.page.invalid`. `unmount()` during enter → `C09.page.unmounted` (cancel all). |
| **Error Recovery** | If `unmount()` fires during validation (rapid page switching), cancel all in-flight work, clear DOM, no leaked operations. |
| **Animation** | Section 1 (Infrastructure): `fadeIn 400ms ease 100ms both`. Section 2 (Configuration): `fadeIn 400ms ease 200ms both`. Section 3 (DAG): `fadeIn 400ms ease 300ms both`. Mini-DAG: `scaleIn 500ms ease 200ms both`. `@prefers-reduced-motion: reduce` → all instant, no animation. |

---

### C09.3 — Page.Active (Idle)

| Field | Value |
|-------|-------|
| **State ID** | `C09.page.active` |
| **Entry Conditions** | All entrance animations complete. Validation has resolved to ready, warning, or invalid. User is on Page 4 not interacting with any sub-flow. |
| **Exit Conditions** | User interacts with any control → transitions to the relevant sub-state. |
| **Visual Description** | Full two-column layout rendered. Left: Infrastructure section, Configuration section, Confirmation box, Template save button. Right: Mini-DAG with dot-grid background. Footer: "← Back" and "Lock In & Create ▸" (enabled/disabled per validation). Focus is on the first section heading (initial) or the last edited section's Edit button (after edit return). |
| **Active DOM Elements** | **Visible:** All `.review-section` elements, `.review-confirm`, `.review-save-template` btn, `.review-mini-dag`, `.review-grid`. **Conditional:** `.review-validation-errors` (if invalid), `.review-validation-warnings` (if warnings). **Enabled/Disabled:** "Lock In & Create" per validation result. |
| **Keyboard Shortcuts** | `Tab` → cycle through Edit links → Template save → footer buttons. `Ctrl+Enter` → trigger Lock In (if enabled). `Escape` → wizard close confirmation. `Alt+←` → back to Page 3. `Enter` on Edit link → navigate to source page. |
| **Data Requirements** | `ReviewModel`, `ValidationResult`, `ConfirmationSummary`, `MiniDagModel`. |
| **Transitions** | Edit link click → `C09.nav.item-hovered` → `C09.nav.item-clicked`. Template save → `C09.template.dialog-open`. Lock In click → `C09.lockin.confirm`. `Alt+←` → `C09.page.unmounted` (WizardShell navigates). |
| **Error Recovery** | N/A — stable idle state. |
| **Animation** | None — all entrance animations complete. Pulse on "Lock In & Create" button if in ready/warning state. |

---

### C09.4 — Summary.InfrastructureSummary

| Field | Value |
|-------|-------|
| **State ID** | `C09.summary.infrastructure` |
| **Entry Conditions** | Always rendered when page is active. First section to fade in (100ms delay). |
| **Exit Conditions** | Edit link clicked → `C09.nav.item-clicked` (target: Page 1). Page unmount → destroyed. |
| **Visual Description** | Card with "INFRASTRUCTURE" title (uppercase, 13px, weight 600) and "Edit" link (accent color, 11px). Four rows: Workspace (mono value), Capacity (name — region), Lakehouse (name + "schema ✓" chip), Notebook (mono value). Each row: label left-aligned (muted), value right-aligned (mono, primary color). |
| **Active DOM Elements** | **Visible:** `.review-section[data-section="infrastructure"]`, `.review-section-header`, `.review-section-title#review-infra-title`, `.review-edit-link[data-target-page="0"]`, `.review-rows` with 4 `.review-row` items. `.review-chip.review-chip--status` on lakehouse row ("schema ✓"). |
| **Keyboard Shortcuts** | `Enter` on Edit link → navigate to Page 1. `Tab` → focus moves to next section Edit link. |
| **Data Requirements** | `workspaceName`, `capacityName`, `capacitySku`, `capacityRegion`, `lakehouseName`, `lakehouseHasSchema`, `notebookName` from wizard state. |
| **Transitions** | Edit click → emits `review:edit-navigate { sectionId: 'infrastructure', targetPage: 0 }` → `C09.nav.item-clicked`. After edit return, section may get `.review-section--changed` class. |
| **Error Recovery** | Missing values display "—" placeholder in muted text. |
| **Animation** | Entrance: `fadeIn 400ms ease 100ms both` (translateY 8px → 0, opacity 0 → 1). Change highlight on edit return: `sectionHighlight 1500ms ease-out` (border accent → border default, box-shadow accent-dim → none). |

---

### C09.5 — Summary.DAGSummary

| Field | Value |
|-------|-------|
| **State ID** | `C09.summary.dag` |
| **Entry Conditions** | Always rendered when page is active. Third section to fade in (300ms delay). Includes mini-DAG. |
| **Exit Conditions** | Edit link clicked → `C09.nav.item-clicked` (target: Page 3). Page unmount → destroyed. |
| **Visual Description** | Right column. Card with "DAG TOPOLOGY" title and "Edit" link. Below: mini-DAG container (280px height, dot-grid background, SVG visualization). Nodes rendered as small rectangles (80–100×28–32px) with truncated labels (max 12 chars) and 3-letter schema badges (dbo/brz/slv/gld). Edges as cubic bezier paths. For empty DAG: placeholder text "No nodes defined. The DAG topology is empty. [Edit DAG]". |
| **Active DOM Elements** | **Visible:** `.review-section.review-section--dag`, `.review-mini-dag` with `.mini-dag-svg` (SVG with `.mini-node` groups, `.mini-edge` paths, `.mini-badge` text). **For empty DAG:** placeholder text instead of SVG. **Accessible:** `role="img"` with descriptive `aria-label` on mini-dag container. SVG is `aria-hidden="true"`. |
| **Keyboard Shortcuts** | `Enter` on Edit link → navigate to Page 3. Mini-DAG is not keyboard navigable (decorative). |
| **Data Requirements** | `MiniDagModel` with positioned nodes, bezier edge paths, viewBox dimensions, scale factor. Node/edge data from `DagTopology`. Schema colors for badge rendering. |
| **Transitions** | Edit click → `C09.nav.item-clicked` (targetPage: 2). Edit return → mini-DAG re-renders with updated topology + `sectionHighlight` animation. |
| **Error Recovery** | Node count >200 → simplified cluster view. Scale factor auto-computed to fit container. |
| **Animation** | Mini-DAG entrance: `@keyframes scaleIn` — `opacity: 0, scale(0.95)` → `opacity: 1, scale(1)`, 500ms ease, 200ms delay. `@prefers-reduced-motion: reduce` → instant. |

---

### C09.6 — Summary.Checklist (Confirmation)

| Field | Value |
|-------|-------|
| **State ID** | `C09.summary.checklist` |
| **Entry Conditions** | Always rendered in left column after the Configuration section. |
| **Exit Conditions** | Page unmount → destroyed. Content updates on edit return via `refresh()`. |
| **Visual Description** | Accent-tinted box (`var(--accent-dim)` bg, `var(--accent)` border, rounded). Text: "This will create **1** lakehouse, **1** notebook, and **N** tables across **M** schemas." Count values in bold mono accent color. `role="alert"` with `aria-live="polite"`. Below: "Save as Template" button (outline accent, full width). |
| **Active DOM Elements** | **Visible:** `.review-confirm` with `.review-confirm-text`, `.count` spans (bold, accent, mono). `.review-save-template` button below. |
| **Keyboard Shortcuts** | `Tab` to "Save as Template" → `Enter`/`Space` opens template dialog. |
| **Data Requirements** | `ConfirmationSummary.resources[]` (resource counts), `ConfirmationSummary.confirmationText`. Computed from wizard state: node count by type, schema count, lakehouse/notebook. |
| **Transitions** | "Save as Template" click → `C09.template.dialog-open`. Content updates when wizard state changes (edit return). |
| **Error Recovery** | Zero nodes → text reads "1 lakehouse and 1 notebook with no tables." |
| **Animation** | Entrance: `fadeIn 400ms ease` (part of left column stagger). Count values have no special animation. |

---

### C09.7 — MiniDAG.Rendering

| Field | Value |
|-------|-------|
| **State ID** | `C09.minidag.rendering` |
| **Entry Conditions** | Component mounting — SVG generation starts after ReviewModel is built. Also on `refresh()` after edit return when DAG changed. |
| **Exit Conditions** | SVG computed and injected → `C09.minidag.rendered`. Empty DAG → `C09.minidag.empty`. |
| **Visual Description** | Mini-DAG container visible with dot-grid background but SVG not yet populated. Brief — typically <200ms. May show a subtle shimmer placeholder if generation takes >100ms (unlikely). |
| **Active DOM Elements** | **Visible:** `.review-mini-dag` container (background visible). **Empty:** `.mini-dag-svg` (no child elements yet). |
| **Keyboard Shortcuts** | None (mini-DAG is decorative). |
| **Data Requirements** | `DagTopology` from wizard state. Canvas positions for layout computation. Scale factor calculation. |
| **Transitions** | SVG generated → `C09.minidag.rendered`. No nodes → `C09.minidag.empty`. |
| **Error Recovery** | If SVG generation fails (corrupt position data), show empty state with error note. 200ms render budget — if exceeded, show available nodes and log warning. |
| **Animation** | Container has `scaleIn` animation running (started at mount). SVG appears within the scaling container. |

---

### C09.8 — MiniDAG.Rendered

| Field | Value |
|-------|-------|
| **State ID** | `C09.minidag.rendered` |
| **Entry Conditions** | SVG generation complete, ≥1 node in DAG. |
| **Exit Conditions** | Edit return with DAG changes → `C09.minidag.rendering` (re-generate). Page unmount → destroyed. |
| **Visual Description** | Complete mini-DAG SVG visible. Nodes as rounded rectangles with label text and schema badge. Edges as smooth cubic bezier curves (`stroke: var(--border)`, width 1.5). Dot-grid background visible through gaps. Nodes color-coded by schema: dbo (muted), bronze (warm), silver (cool), gold (rich). Not interactive — cursor: default on nodes. |
| **Active DOM Elements** | **Visible:** `.mini-dag-svg` with `viewBox` set. `.mini-node` groups (rect + label + badge) × nodeCount. `.mini-edge` paths × edgeCount. **Accessible:** container `role="img"`, `aria-label` describes node count and architecture pattern. |
| **Keyboard Shortcuts** | None — decorative. |
| **Data Requirements** | `MiniDagModel` fully computed: positioned `MiniNode[]`, bezier `MiniEdge[]`, `viewBox`, `scale`. |
| **Transitions** | `refresh()` with changed DAG → `C09.minidag.rendering`. Unchanged DAG → no-op (skip re-render). |
| **Error Recovery** | N/A — stable rendered state. |
| **Animation** | Entrance: part of parent `scaleIn 500ms ease 200ms`. No ongoing animation. |

---

### C09.9 — MiniDAG.Empty

| Field | Value |
|-------|-------|
| **State ID** | `C09.minidag.empty` |
| **Entry Conditions** | DAG topology has 0 nodes and 0 connections. |
| **Exit Conditions** | Edit return with nodes added → `C09.minidag.rendering`. |
| **Visual Description** | Mini-DAG container shows centered placeholder text: "No nodes defined." / "The DAG topology is empty." with an "Edit DAG" link (accent color). Dot-grid background still visible. |
| **Active DOM Elements** | **Visible:** `.review-mini-dag` (background only). Placeholder text centered. "Edit DAG" link (`.review-edit-link` pointing to Page 3). **Hidden:** `.mini-dag-svg`. |
| **Keyboard Shortcuts** | `Tab` to "Edit DAG" link → `Enter` navigates to Page 3. |
| **Data Requirements** | Empty `DagTopology`: `{ nodes: [], connections: [] }`. |
| **Transitions** | "Edit DAG" click → `C09.nav.item-clicked` (targetPage: 2). |
| **Error Recovery** | Creation is still allowed (warning state) — environment created without tables. |
| **Animation** | Container `scaleIn` plays normally. Placeholder text fades in with container. |

---

### C09.10 — Template.Idle

| Field | Value |
|-------|-------|
| **State ID** | `C09.template.idle` |
| **Entry Conditions** | Default state. Returns from `saved` after auto-close (1500ms). Returns from `save-error` after user clicks Cancel. Returns from `dialog-open` after user clicks Cancel. |
| **Exit Conditions** | "Save as Template" button clicked → `C09.template.dialog-open` |
| **Visual Description** | "Save as Template" button in left column, below confirmation box. Outline style: transparent bg, accent border/text. Full width. Normal hover state (accent-dim bg on hover). Disabled when page is in INVALID state or during CONFIRMING. |
| **Active DOM Elements** | **Visible:** `.review-save-template` (`.btn-accent-outline`). **State:** enabled (ready/warning) or disabled (invalid/confirming). After save success: button text shows "Saved ✓" for 3 seconds then reverts. |
| **Keyboard Shortcuts** | `Enter`/`Space` → open template dialog. |
| **Data Requirements** | `isReadyForCreation()` check for enabled/disabled state. |
| **Transitions** | Click / `Enter` → `C09.template.dialog-open`. |
| **Error Recovery** | N/A. |
| **Animation** | Standard button hover: `background-color 150ms ease`. Focus: `outline: 2px solid var(--accent), offset 2px`. |

---

### C09.11 — Template.DialogOpen

| Field | Value |
|-------|-------|
| **State ID** | `C09.template.dialog-open` |
| **Entry Conditions** | User clicks "Save as Template" or presses `Enter` on the button. |
| **Exit Conditions** | User starts typing name → `C09.template.naming`. User clicks Cancel / presses `Escape` → `C09.template.idle`. |
| **Visual Description** | Modal overlay (50% black backdrop). Centered dialog card (max 420px wide): title "Save as Template" (16px, weight 600), empty name input (placeholder "Template name"), empty description textarea (placeholder "Optional description"), Cancel and "Save Template" buttons. Focus trap active. Name input auto-focused. |
| **Active DOM Elements** | **Visible:** `.review-template-dialog` (backdrop + card). `.review-template-dialog-content` with title, name input, description textarea, Cancel btn, Save btn. **Focus:** name input (auto-focused). **Disabled:** "Save Template" button (name is empty). |
| **Keyboard Shortcuts** | `Escape` → close dialog, return focus to "Save as Template" button. `Tab` → name input → description → Cancel → Save. `Enter` on Save (if enabled) → save. |
| **Data Requirements** | `review:template-dialog-opened` event fired. |
| **Transitions** | User types in name input → `C09.template.naming`. Cancel / `Escape` → `C09.template.idle`. |
| **Error Recovery** | Focus trap prevents interaction with elements behind backdrop. |
| **Animation** | Dialog entrance: `fadeIn 200ms ease`. Backdrop: instant. `@prefers-reduced-motion: reduce` → instant. |

---

### C09.12 — Template.Naming

| Field | Value |
|-------|-------|
| **State ID** | `C09.template.naming` |
| **Entry Conditions** | User types ≥1 character in the template name input. |
| **Exit Conditions** | User clicks "Save Template" or presses `Enter` → `C09.template.saving`. User clears name → `C09.template.dialog-open`. Cancel / `Escape` → `C09.template.idle`. |
| **Visual Description** | Same as dialog-open but "Save Template" button is now enabled (name is non-empty). Name input shows user-entered text with accent border on focus. Character count hint visible if approaching max (64 chars). |
| **Active DOM Elements** | **Modified:** "Save Template" button → enabled. Name input has value. **Optional:** character count near input if length > 50. |
| **Keyboard Shortcuts** | `Enter` → save (if name valid). `Escape` → close dialog. `Tab` → cycle dialog elements. |
| **Data Requirements** | Template name (1–64 chars, required). Description (0–256 chars, optional). |
| **Transitions** | Save click / `Enter` → `C09.template.saving`. Name cleared → `C09.template.dialog-open`. Cancel / `Escape` → `C09.template.idle`. |
| **Error Recovery** | Name >64 chars → input truncated, red border, error text "Maximum 64 characters". |
| **Animation** | Input focus: `border-color: var(--accent)`, `box-shadow: 0 0 0 2px var(--accent-dim)` — 150ms transition. |

---

### C09.13 — Template.Saving

| Field | Value |
|-------|-------|
| **State ID** | `C09.template.saving` |
| **Entry Conditions** | User clicks "Save Template" with valid name. `saveAsTemplate(name, description)` called. |
| **Exit Conditions** | Save succeeds → `C09.template.saved`. Save fails → `C09.template.save-error`. |
| **Visual Description** | Dialog still visible. "Save Template" button shows spinner, disabled. Name and description inputs become read-only. Cancel button disabled. Backdrop remains. |
| **Active DOM Elements** | **Modified:** "Save Template" button → spinner + disabled. Name/description inputs → read-only. Cancel → disabled. |
| **Keyboard Shortcuts** | `Escape` → ignored during save. All interactions blocked. |
| **Data Requirements** | `TemplateSaveRequest` in-flight. `review:template-saving { name }` event fired. |
| **Transitions** | `onTemplateSave` resolves → `C09.template.saved`. Rejects → `C09.template.save-error`. |
| **Error Recovery** | Network timeout after 10s → auto-transition to `save-error` with timeout message. |
| **Animation** | Save button spinner: same `@keyframes spin` as C08. |

---

### C09.14 — Template.Saved

| Field | Value |
|-------|-------|
| **State ID** | `C09.template.saved` |
| **Entry Conditions** | `onTemplateSave` Promise resolves successfully. |
| **Exit Conditions** | 1500ms auto-close → `C09.template.idle` |
| **Visual Description** | Dialog briefly shows success state: checkmark icon (✓) + "Template saved" text replaces the form. Green-tinted background. Auto-dismisses after 1500ms. After dialog closes, "Save as Template" button text changes to "Saved ✓" for 3 seconds. |
| **Active DOM Elements** | **Visible:** Success indicator in dialog (replacing form). Then dialog closes → button shows "Saved ✓". |
| **Keyboard Shortcuts** | `Escape` or `Enter` → dismiss immediately. |
| **Data Requirements** | `TemplateSaveResponse` with `templateId`, `name`, `savedAt`. `review:template-saved` event fired. Screen reader: "Template '{name}' saved successfully." |
| **Transitions** | 1500ms timeout → dialog closes → `C09.template.idle`. Button text reverts after 3s. |
| **Error Recovery** | N/A — success state. |
| **Animation** | Success icon: `scaleIn 200ms ease`. Dialog dismiss: `fadeOut 200ms`. |

---

### C09.15 — Template.SaveError

| Field | Value |
|-------|-------|
| **State ID** | `C09.template.save-error` |
| **Entry Conditions** | `onTemplateSave` Promise rejects (network error, server error, duplicate name, timeout). |
| **Exit Conditions** | User clicks "Retry" → `C09.template.saving`. User clicks "Cancel" / `Escape` → `C09.template.idle`. |
| **Visual Description** | Dialog shows error state: error message "Failed to save template: {error description}" in red text. "Retry" and "Cancel" buttons replace the original Save/Cancel. Name and description inputs re-enabled (user can modify before retry). |
| **Active DOM Elements** | **Visible:** Error message text (red). Retry button (enabled). Cancel button (enabled). Name/description inputs (editable again). |
| **Keyboard Shortcuts** | `Escape` → close (cancel). `Enter` on Retry → retry save. `Tab` → name → description → Retry → Cancel. |
| **Data Requirements** | Error message from rejection. `review:template-save-failed { error }` event fired. Screen reader: "Failed to save template. {error}". |
| **Transitions** | Retry → `C09.template.saving`. Cancel / `Escape` → `C09.template.idle`. |
| **Error Recovery** | User can edit name (e.g., fix duplicate name) before retrying. Retry uses updated input values. |
| **Animation** | Error message entrance: `fadeIn 150ms`. |

---

### C09.16 — Navigation.ItemHovered

| Field | Value |
|-------|-------|
| **State ID** | `C09.nav.item-hovered` |
| **Entry Conditions** | Mouse enters an Edit link or keyboard focus lands on an Edit link. |
| **Exit Conditions** | Mouse leaves → return to `C09.page.active`. Click → `C09.nav.item-clicked`. `Tab` away → return to `C09.page.active`. |
| **Visual Description** | Edit link gets hover styling: `background: var(--accent-dim)`, no text decoration. The parent section card may gain a subtle border accent to indicate "this section is editable". A tooltip or title attribute shows "Click to edit — returns to page N". |
| **Active DOM Elements** | **Modified:** `.review-edit-link:hover` or `:focus-visible` (accent-dim bg, no underline). Section border subtle accent. |
| **Keyboard Shortcuts** | `Enter`/`Space` → click (navigate). `Tab` → next element. `Escape` → wizard close. |
| **Data Requirements** | `data-target-page` attribute on the Edit link. |
| **Transitions** | Click / `Enter` → `C09.nav.item-clicked`. Mouse leave / blur → `C09.page.active`. |
| **Error Recovery** | N/A. |
| **Animation** | `background-color: 150ms ease` transition on hover. `outline: 2px solid var(--accent), offset 2px` on focus-visible. |

---

### C09.17 — Navigation.ItemClicked

| Field | Value |
|-------|-------|
| **State ID** | `C09.nav.item-clicked` |
| **Entry Conditions** | User clicks an Edit link or presses `Enter` on a focused Edit link. |
| **Exit Conditions** | WizardShell navigates to target page → C09 transitions to editing state. |
| **Visual Description** | Brief — the Edit link shows a pressed/active state. C09 fires `review:edit-navigate` event. `_lastEditSection` is recorded for focus restoration on return. WizardShell begins page transition. |
| **Active DOM Elements** | **Modified:** clicked Edit link shows active state. **Event:** `review:edit-navigate { sectionId, targetPage }` dispatched. |
| **Keyboard Shortcuts** | N/A — transitioning. |
| **Data Requirements** | `sectionId` from `data-section` attribute. `targetPage` from `data-target-page`. `_lastEditSection` stored. |
| **Transitions** | Immediate → WizardShell navigates → C09 enters `C09.nav.editing`. Screen reader: "Navigating to {section} settings for editing." |
| **Error Recovery** | If navigation fails (shouldn't happen), stay on Page 4. |
| **Animation** | Edit link active state: standard button press feedback. |

---

### C09.18 — Navigation.Editing

| Field | Value |
|-------|-------|
| **State ID** | `C09.nav.editing` |
| **Entry Conditions** | WizardShell navigated to target page after Edit link click. C09 remains mounted but hidden. |
| **Exit Conditions** | User navigates forward back to Page 4 → `refresh(updatedState)` called → `C09.page.entering` (re-validation). |
| **Visual Description** | C09 is not visible (WizardShell shows the target page). C09 remains in memory with last known state. |
| **Active DOM Elements** | C09 DOM exists but is hidden (display: none or WizardShell page switching hides it). |
| **Keyboard Shortcuts** | None — C09 not active. |
| **Data Requirements** | `_lastEditSection` stored. Previous `ReviewModel` retained. |
| **Transitions** | WizardShell calls `refresh(updatedWizardState)` when user returns → `C09.page.entering`. Focus will be restored to the edited section's Edit button. Changed section gets `review-section--changed` highlight animation. |
| **Error Recovery** | If user navigates to a page other than the edit target (e.g., goes further back), C09 still re-validates on return. |
| **Animation** | None while hidden. On return: changed sections get `@keyframes sectionHighlight` — border accent → default, box-shadow → none, 1500ms `ease-out`. |

---

### C09.19 — LockIn.Enabled

| Field | Value |
|-------|-------|
| **State ID** | `C09.lockin.enabled` |
| **Entry Conditions** | Validation passed (ready state) or validation has only warnings (warning state). Footer button configured by C09. |
| **Exit Conditions** | Click → `C09.lockin.confirm`. Validation re-run (after edit return) may disable. |
| **Visual Description** | "Lock In & Create ▸" button in wizard footer. Accent background, white text, bold 13px. `pulseAccent` animation: box-shadow pulses 0 → 6px accent glow → 0 over 2s cycle. Hover: `translateY(-1px)` + larger shadow. Active: `translateY(0)` + smaller shadow. |
| **Active DOM Elements** | **Visible:** `.btn-create` in footer (managed by C12-WizardShell, configured by C09). `aria-label="Lock in configuration and create environment"`. |
| **Keyboard Shortcuts** | `Ctrl+Enter` (global on Page 4) → trigger confirm. `Enter`/`Space` when focused → trigger confirm. `Tab` to reach from other elements. |
| **Data Requirements** | `isReadyForCreation() === true`. |
| **Transitions** | Click / `Ctrl+Enter` / `Enter` → `C09.lockin.confirm`. Edit return re-validation → may go to `C09.lockin.disabled`. |
| **Error Recovery** | N/A. |
| **Animation** | `@keyframes pulseAccent` — `box-shadow: 0 0 0 0 var(--accent-glow)` → `0 0 0 6px transparent`, 2s `ease-in-out infinite`. Hover: `transform 150ms ease, box-shadow 150ms ease`. `@prefers-reduced-motion: reduce` → `animation: none`, no pulse. |

---

### C09.20 — LockIn.Disabled

| Field | Value |
|-------|-------|
| **State ID** | `C09.lockin.disabled` |
| **Entry Conditions** | Validation found blocking errors (INVALID state). During template save. During confirming. |
| **Exit Conditions** | Edit return → re-validation passes → `C09.lockin.enabled`. Template save completes → `C09.lockin.enabled` (if validation was OK). |
| **Visual Description** | "Lock In & Create ▸" button dimmed: `opacity: 0.5`, `cursor: not-allowed`, no pulse animation. `title="Fix validation errors before creating"`. `disabled` + `aria-disabled="true"`. |
| **Active DOM Elements** | **Visible:** `.btn-create:disabled` (dimmed, no animation). `aria-label="Cannot create environment — fix validation errors first"`. |
| **Keyboard Shortcuts** | `Ctrl+Enter` → screen reader announces "Cannot create environment. Fix validation errors first." Button cannot receive focus via Tab in disabled state. |
| **Data Requirements** | `isReadyForCreation() === false`. `ValidationResult.errors[]` non-empty. |
| **Transitions** | Edit return + re-validation passes → `C09.lockin.enabled`. |
| **Error Recovery** | Validation error banner provides clickable fix links that navigate to source pages. |
| **Animation** | None — `animation: none`, `transform: none`. |

---

### C09.21 — LockIn.Confirm

| Field | Value |
|-------|-------|
| **State ID** | `C09.lockin.confirm` |
| **Entry Conditions** | User clicks "Lock In & Create ▸" or presses `Ctrl+Enter` while button is enabled. |
| **Exit Conditions** | Confirmation dispatched → `C09.lockin.confirmed`. Dispatch fails → return to `C09.lockin.enabled`. |
| **Visual Description** | Button enters loading state: text may change to "Creating..." or show a spinner. All Edit links disabled. Template save button disabled. Back button disabled. C09 fires `review:confirmed` with the creation manifest. |
| **Active DOM Elements** | **Modified:** `.btn-create` → loading state (spinner or "Creating..."). **Disabled:** all Edit links, Template save, Back button. |
| **Keyboard Shortcuts** | All disabled — action in progress. `Escape` → ignored (cannot cancel once confirmed). |
| **Data Requirements** | `EnvironmentCreateRequest` manifest built from `getCreationManifest()`. `review:confirmed { manifest }` event fired. |
| **Transitions** | WizardShell receives event, dispatches to execution → `C09.lockin.confirmed`. If dispatch fails (shouldn't happen — local event) → `C09.lockin.enabled`. |
| **Error Recovery** | If the event dispatch itself fails, re-enable button and show error toast. |
| **Animation** | Button spinner (if used). Disable transition on all interactive elements. |

---

### C09.22 — LockIn.Confirmed

| Field | Value |
|-------|-------|
| **State ID** | `C09.lockin.confirmed` |
| **Entry Conditions** | `review:confirmed` event successfully dispatched. WizardShell transitions to Page 5 (Execution). |
| **Exit Conditions** | Terminal state — C09 will be unmounted as WizardShell moves to Page 5. |
| **Visual Description** | Brief — WizardShell immediately transitions to the Execution Pipeline page (C10). C09 may show a brief "confirmed" flash before being replaced. Screen reader: "Environment creation initiated. Please wait." |
| **Active DOM Elements** | All hidden/replacing as WizardShell navigates to Page 5. |
| **Keyboard Shortcuts** | None — page transitioning. |
| **Data Requirements** | N/A — handoff complete. |
| **Transitions** | WizardShell unmounts C09 → `C09.page.unmounted`. |
| **Error Recovery** | N/A — terminal. Execution errors handled by C10. |
| **Animation** | Page transition managed by WizardShell. |

---

### C09.23 — Confirmation.Visible

| Field | Value |
|-------|-------|
| **State ID** | `C09.confirmation.visible` |
| **Entry Conditions** | Page entering animation completes. Confirmation text computed from wizard state. |
| **Exit Conditions** | Only destroyed on page unmount. Content updates on `refresh()`. |
| **Visual Description** | Accent-tinted box: "This will create **1** lakehouse, **1** notebook, and **N** tables across **M** schemas." `role="alert"` + `aria-live="polite"` — screen readers announce changes. Count values bold, mono, accent-colored. |
| **Active DOM Elements** | `.review-confirm` (always visible when page active). `.review-confirm-text` with `.count` spans. |
| **Keyboard Shortcuts** | Not interactive — read-only announcement region. |
| **Data Requirements** | `ConfirmationSummary.confirmationText`, computed resource counts. |
| **Transitions** | `refresh()` → text updates (screen reader re-announces via `aria-live`). |
| **Error Recovery** | Dynamic text always recomputed from current wizard state. |
| **Animation** | Entrance with parent section. Content change: text swap is instant, `aria-live` handles announcement timing. |

---

### C09.24 — Confirmation.Acknowledged

| Field | Value |
|-------|-------|
| **State ID** | `C09.confirmation.acknowledged` |
| **Entry Conditions** | User clicks "Lock In & Create ▸" — implicit acknowledgment of the confirmation text. |
| **Exit Conditions** | Terminal — transitions to `C09.lockin.confirmed`. |
| **Visual Description** | Confirmation box remains visible but the user has implicitly acknowledged it by clicking the create button. No visual change to the box itself — the button state change is the acknowledgment indicator. |
| **Active DOM Elements** | Same as `C09.confirmation.visible` but all controls are now in confirming/disabled state. |
| **Keyboard Shortcuts** | None — confirming in progress. |
| **Data Requirements** | Acknowledgment is implicit via the Lock In action. |
| **Transitions** | Immediate → `C09.lockin.confirmed` flow. |
| **Error Recovery** | N/A. |
| **Animation** | None. |

---

## C09 State Transition Summary

```
MAIN LIFECYCLE:
┌────────────┐  mount()   ┌────────────┐  validation   ┌───────────────┐
│ UNMOUNTED  │───────────►│ ENTERING   │──────────────►│ READY / WARN  │
│   C09.1    │            │   C09.2    │  errors       │ / INVALID     │
└────────────┘            └────────────┘               │ C09.3-6       │
       ▲                        ▲                       └───────┬───────┘
       │ unmount                │ refresh                       │
       │                        │ (edit return)                 │
       │                  ┌─────┴──────┐   edit click    ┌──────▼───────┐
       │                  │  EDITING   │◄────────────────│ ITEM CLICKED │
       │                  │  C09.18    │                 │   C09.17     │
       │                  └────────────┘                 └──────────────┘
       │
       │                                    Lock In click
       │                  ┌────────────┐◄───────────────┐
       └──────────────────│ CONFIRMED  │                │
          (Page 5)        │  C09.22    │◄───┌───────────┤
                          └────────────┘    │  CONFIRM  │
                                            │  C09.21   │
                                            └───────────┘

TEMPLATE SAVE (orthogonal):
┌──────────┐  click    ┌─────────────┐  typing  ┌──────────┐  save   ┌──────────┐
│   IDLE   │─────────►│ DIALOG OPEN │────────►│  NAMING  │───────►│  SAVING  │
│  C09.10  │          │   C09.11    │         │  C09.12  │        │  C09.13  │
└──────────┘◄─────────└─────────────┘         └──────────┘        └────┬─────┘
       ▲    cancel/esc                                                  │
       │                                                          success/fail
       │         ┌──────────┐  1500ms  ┌────────────┐                   │
       └─────────│  SAVED   │◄────────│    or      │◄──────────────────┘
       │         │  C09.14  │         │ SAVE ERROR │
       │         └──────────┘         │  C09.15    │
       └──────────────────────────────└────────────┘
              cancel/esc

LOCK-IN BUTTON (orthogonal):
┌──────────┐  validation pass   ┌──────────┐  click     ┌──────────┐
│ DISABLED │──────────────────►│ ENABLED  │──────────►│ CONFIRM  │──►CONFIRMED
│  C09.20  │◄──────────────────│  C09.19  │           │  C09.21  │
└──────────┘  validation fail   └──────────┘           └──────────┘
```

---
---

# Cross-Component Interactions

## C08 → C09 Data Flow

| Trigger | Source | Target | Data |
|---------|--------|--------|------|
| Page 3 → Page 4 navigation | C08.getGeneratedCells() | C09 ReviewModel build | `GeneratedCell[]` for code summary |
| Page 3 → Page 4 navigation | C08.getGeneratedCode() | C09 ReviewModel build | Raw code string for stats |
| Edit return to Page 3 | C09 fires `review:edit-navigate` | C08 receives page activation | C08 auto-refreshes on Page 3 entry |

## C09 → WizardShell Coordination

| Trigger | C09 State | WizardShell Action |
|---------|-----------|-------------------|
| Mount | `C09.page.entering` | Footer transforms to "Lock In & Create ▸" |
| Validation complete | `C09.page.ready/warning/invalid` | Footer button enabled/disabled |
| Edit navigate | `C09.nav.item-clicked` | Navigate to target page |
| Confirm | `C09.lockin.confirm` | Dispatch `POST /api/environments` |
| Confirmed | `C09.lockin.confirmed` | Navigate to Page 5 (Execution) |

## Keyboard Shortcut Registry (Page 3 + Page 4)

| Shortcut | Page 3 (C08 active) | Page 4 (C09 active) |
|----------|---------------------|---------------------|
| `Ctrl+Shift+C` | Toggle code panel | N/A |
| `Ctrl+Shift+R` | Refresh code preview | N/A |
| `Ctrl+Enter` | N/A | Lock In & Create |
| `Escape` | Collapse panel (if focused) | Close wizard / close template dialog |
| `Alt+←` | Back to Page 2 | Back to Page 3 |
| `Tab` | Cycle panel elements | Cycle review elements |
