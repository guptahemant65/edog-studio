# JSON Tree Renderer — Deep Component Spec

> **Component:** `JsonTreeRenderer`
> **Owner:** Pixel (Frontend Engineer)
> **Source file:** `src/frontend/js/json-tree.js` (new)
> **CSS file:** `src/frontend/css/json-tree.css` (new)
> **Parent:** Response Viewer ("Pretty" mode tab)
> **Dependencies:** P0 foundation (design tokens, toast system)
> **Status:** SPEC COMPLETE — ready for implementation

---

## Table of Contents

1. [Component Overview](#1-component-overview)
2. [Visual Specification](#2-visual-specification)
3. [Data Model](#3-data-model)
4. [DOM Structure](#4-dom-structure)
5. [CSS Specification](#5-css-specification)
6. [Rendering Algorithm](#6-rendering-algorithm)
7. [Collapse/Expand Behavior](#7-collapseexpand-behavior)
8. [Syntax Coloring](#8-syntax-coloring)
9. [Copy Behavior](#9-copy-behavior)
10. [Path Breadcrumb](#10-path-breadcrumb)
11. [Search](#11-search)
12. [Virtualization](#12-virtualization)
13. [Performance Budgets](#13-performance-budgets)
14. [Accessibility](#14-accessibility)

---

## 1. Component Overview

The JSON Tree Renderer is a collapsible, syntax-colored tree view for JSON data. It is the primary visualization for API responses in the F09 API Playground's Response Viewer "Pretty" mode.

### Design Principles

- **DOM-based rendering** — every node is a real DOM element, not a string template. This enables native event handling, accessibility attributes, and efficient partial updates.
- **Recursive structure** — the tree mirrors JSON structure exactly. Objects and arrays create nested containers; primitives are leaf nodes.
- **Lazy rendering** — large payloads (>1000 nodes) are rendered progressively; very large payloads (>5000 nodes) use viewport-based virtualization.
- **Theme-aware** — all colors reference CSS custom properties that flip between light and dark modes via `[data-theme]`.

### Public API

```javascript
class JsonTreeRenderer {
  /**
   * @param {HTMLElement} container — parent element to render into
   * @param {object} options — configuration
   * @param {number} [options.initialDepth=2] — expand to this depth on first render
   * @param {boolean} [options.showLineNumbers=true]
   * @param {boolean} [options.showBreadcrumb=true]
   * @param {number} [options.virtualizationThreshold=5000] — node count before virtualizing
   * @param {number} [options.batchThreshold=1000] — node count before rAF batching
   */
  constructor(container, options = {}) {}

  /** Parse and render JSON. Accepts string or parsed object. */
  render(json) {}

  /** Expand all nodes */
  expandAll() {}

  /** Collapse all nodes */
  collapseAll() {}

  /** Expand tree to depth N (0 = root collapsed, 1 = root children visible, ...) */
  expandToLevel(n) {}

  /** Search for text in keys and values. Returns match count. */
  search(query) {}

  /** Clear search highlights */
  clearSearch() {}

  /** Jump to next/previous search match */
  nextMatch() {}
  prevMatch() {}

  /** Destroy the component, remove event listeners, free memory */
  destroy() {}

  /** @returns {number} total node count in current tree */
  get nodeCount() {}

  /** @returns {number} rendered DOM node count (may be less if virtualized) */
  get renderedCount() {}
}
```

---

## 2. Visual Specification

### Expanded State (depth 2)

```
┌─ JSON Tree Toolbar ─────────────────────────────────────────────┐
│ [Expand All] [Collapse All] [Level: ◂ 2 ▸]  🔍 Search...       │
├─────────────────────────────────────────────────────────────────┤
│  1 │ ▾ {                                              ← bracket │
│  2 │     "status":  200,                   ← key: accent        │
│  3 │     "message": "OK",                  ← string: green      │
│  4 │   ▾ "value": [                        ← array, expanded    │
│  5 │     ▾ {                                                     │
│  6 │         "id":          "abc-123",                           │
│  7 │         "displayName": "My Table",                          │
│  8 │         "rowCount":    42000,          ← number: blue       │
│  9 │         "isActive":    true,           ← boolean: orange    │
│ 10 │         "deletedAt":   null,           ← null: gray         │
│ 11 │       }                                                     │
│ 12 │     ▸ { ... } (6 keys)                ← collapsed object   │
│ 13 │     ▸ { ... } (6 keys)                                     │
│ 14 │     ]                                                       │
│ 15 │   }                                                         │
├─────────────────────────────────────────────────────────────────┤
│ Path: $.value[0].displayName        [click to copy]   ← hover  │
└─────────────────────────────────────────────────────────────────┘
```

### Collapsed State

```
│  4 │   ▸ "value": [ ... ] (23 items)       ← collapsed array   │
```

### Color Legend

| Element      | CSS Variable          | Light                      | Dark                       |
|--------------|-----------------------|----------------------------|----------------------------|
| Key          | `--jt-key`            | `oklch(0.49 0.22 289)`     | `oklch(0.72 0.16 289)`     |
| String       | `--jt-string`         | `oklch(0.55 0.18 164)`     | `oklch(0.78 0.14 164)`     |
| Number       | `--jt-number`         | `oklch(0.52 0.19 260)`     | `oklch(0.72 0.16 260)`     |
| Boolean      | `--jt-boolean`        | `oklch(0.58 0.16 75)`      | `oklch(0.82 0.13 75)`      |
| Null         | `--jt-null`           | `var(--text-muted)`        | `var(--text-muted)`        |
| Bracket      | `--jt-bracket`        | `var(--text-muted)`        | `var(--text-muted)`        |
| Punctuation  | `--jt-punctuation`    | `var(--text-muted)`        | `var(--text-muted)`        |
| Search match | `--jt-search-bg`      | `oklch(0.85 0.14 85)`      | `oklch(0.45 0.14 85 / 0.5)`|
| Active match | `--jt-search-active`  | `oklch(0.72 0.18 85)`      | `oklch(0.60 0.18 85 / 0.7)`|
| Hover line   | `--jt-hover-bg`       | `var(--accent-hover)`      | `var(--accent-hover)`      |

> **Note:** All colors use OKLCH per EDOG Studio design system. Hex equivalents in the
> task description are reference targets — the OKLCH values above are the canonical spec.

### Spacing & Indentation

- **Indent per level:** 20px (`var(--jt-indent, 20px)`)
- **Line height:** 22px (`var(--jt-line-height, 22px)`)
- **Gutter width:** 48px (line numbers, right-aligned, muted)
- **Toggle indicator width:** 16px
- **Horizontal padding:** `var(--space-2)` left, `var(--space-4)` right
- **Font:** `var(--font-mono)` at `var(--text-sm)`

---

## 3. Data Model

### 3.1 Internal Node Structure

Each JSON value is parsed into a `JTNode` — a plain object (not a class instance, to keep memory low for large trees).

```javascript
/**
 * @typedef {Object} JTNode
 * @property {string} id — unique ID, e.g. "root.value[0].id"
 * @property {'object'|'array'|'string'|'number'|'boolean'|'null'} type
 * @property {string|null} key — the property name (null for array items and root)
 * @property {*} value — raw value (primitives) or null (containers)
 * @property {JTNode[]|null} children — child nodes for objects/arrays, null for primitives
 * @property {number} depth — 0 for root
 * @property {number} index — position in parent (for arrays), -1 for object keys
 * @property {number} childCount — for containers: number of direct children
 * @property {number} descendantCount — total nodes in subtree (for perf decisions)
 * @property {boolean} collapsed — current collapse state
 * @property {string} path — JSONPath string, e.g. "$.value[0].id"
 * @property {HTMLElement|null} el — reference to rendered DOM element (null if virtualized out)
 */
```

### 3.2 Parse Algorithm

```
FUNCTION parseJson(raw):
    IF raw is string:
        data = JSON.parse(raw)
        sourceSize = raw.length
    ELSE:
        data = raw
        sourceSize = JSON.stringify(raw).length

    IF sourceSize > 512000:  // 500KB
        emit 'large-response' event
        // caller decides whether to proceed or offer download

    nodeCount = 0
    root = buildNode(data, null, "$", 0, -1)
    RETURN { root, nodeCount, sourceSize }

FUNCTION buildNode(value, key, path, depth, index):
    nodeCount += 1
    node = {
        id: generateId(),
        key: key,
        depth: depth,
        index: index,
        path: path,
        collapsed: depth >= initialDepth,
        el: null,
        value: null,
        children: null,
        childCount: 0,
        descendantCount: 0
    }

    type = detectType(value)
    node.type = type

    IF type == 'object':
        keys = Object.keys(value)
        node.childCount = keys.length
        node.children = []
        FOR EACH k IN keys:
            childPath = path + "." + escapeKey(k)
            child = buildNode(value[k], k, childPath, depth + 1, -1)
            node.children.push(child)
            node.descendantCount += child.descendantCount + 1
    ELSE IF type == 'array':
        node.childCount = value.length
        node.children = []
        FOR i = 0 TO value.length - 1:
            childPath = path + "[" + i + "]"
            child = buildNode(value[i], null, childPath, depth + 1, i)
            node.children.push(child)
            node.descendantCount += child.descendantCount + 1
    ELSE:
        node.value = value   // string, number, boolean, null

    RETURN node
```

### 3.3 Type Detection

```javascript
function detectType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'object') return 'object';
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string'; // fallback: coerce to string
}
```

### 3.4 Path Escaping

Keys containing dots or brackets are escaped:

```javascript
function escapeKey(key) {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) return key;
  return '["' + key.replace(/"/g, '\\"') + '"]';
}
```

Example paths:
- `$.value[0].displayName` — normal dotted path
- `$["weird.key"][0]` — key containing a dot
- `$.items[3]["key with spaces"]` — key with spaces

---

## 4. DOM Structure

### 4.1 Container

```html
<div class="jt-root" role="tree" aria-label="JSON response tree">
  <!-- Toolbar -->
  <div class="jt-toolbar" role="toolbar" aria-label="JSON tree controls">
    <button class="jt-btn" data-action="expand-all" aria-label="Expand all">Expand All</button>
    <button class="jt-btn" data-action="collapse-all" aria-label="Collapse all">Collapse All</button>
    <div class="jt-level-control" role="group" aria-label="Expand to level">
      <button class="jt-btn jt-btn--icon" data-action="level-down" aria-label="Decrease level">◂</button>
      <span class="jt-level-display" aria-live="polite">Level 2</span>
      <button class="jt-btn jt-btn--icon" data-action="level-up" aria-label="Increase level">▸</button>
    </div>
    <div class="jt-search-box">
      <input class="jt-search-input" type="search" placeholder="Search..."
        aria-label="Search JSON" />
      <span class="jt-search-count" aria-live="polite"></span>
      <button class="jt-btn jt-btn--icon" data-action="search-prev" aria-label="Previous match">↑</button>
      <button class="jt-btn jt-btn--icon" data-action="search-next" aria-label="Next match">↓</button>
    </div>
  </div>

  <!-- Scrollable tree body -->
  <div class="jt-body" role="none" tabindex="0">
    <!-- Tree lines rendered here -->
  </div>

  <!-- Breadcrumb bar (bottom) -->
  <div class="jt-breadcrumb" aria-live="polite">
    <span class="jt-breadcrumb-path"></span>
    <button class="jt-btn jt-btn--ghost" data-action="copy-path" aria-label="Copy path">Copy</button>
  </div>
</div>
```

### 4.2 Object Node (expanded)

```html
<div class="jt-line jt-line--container" data-depth="0" data-path="$"
     role="treeitem" aria-expanded="true" aria-level="1"
     aria-label="root object, 3 keys">
  <span class="jt-gutter">1</span>
  <span class="jt-indent" style="width: 0px"></span>
  <span class="jt-toggle" aria-hidden="true">▾</span>
  <span class="jt-bracket jt-bracket--open">{</span>
</div>
<!-- children lines follow -->
<div class="jt-line jt-line--close" data-depth="0">
  <span class="jt-gutter">15</span>
  <span class="jt-indent" style="width: 0px"></span>
  <span class="jt-bracket jt-bracket--close">}</span>
</div>
```

### 4.3 Object Node (collapsed)

```html
<div class="jt-line jt-line--container jt-line--collapsed" data-depth="1" data-path="$.value[1]"
     role="treeitem" aria-expanded="false" aria-level="2"
     aria-label="object, 6 keys, collapsed">
  <span class="jt-gutter">12</span>
  <span class="jt-indent" style="width: 20px"></span>
  <span class="jt-toggle" aria-hidden="true">▸</span>
  <span class="jt-bracket jt-bracket--open">{</span>
  <span class="jt-preview"> ... </span>
  <span class="jt-bracket jt-bracket--close">}</span>
  <span class="jt-count">(6 keys)</span>
</div>
```

### 4.4 Array Node (expanded)

```html
<div class="jt-line jt-line--container" data-depth="1" data-path="$.value"
     role="treeitem" aria-expanded="true" aria-level="2"
     aria-label="value array, 23 items">
  <span class="jt-gutter">4</span>
  <span class="jt-indent" style="width: 20px"></span>
  <span class="jt-toggle" aria-hidden="true">▾</span>
  <span class="jt-key">"value"</span>
  <span class="jt-punctuation">: </span>
  <span class="jt-bracket jt-bracket--open">[</span>
</div>
<!-- children lines follow -->
<div class="jt-line jt-line--close" data-depth="1">
  <span class="jt-gutter">14</span>
  <span class="jt-indent" style="width: 20px"></span>
  <span class="jt-bracket jt-bracket--close">]</span>
</div>
```

### 4.5 Array Node (collapsed)

```html
<div class="jt-line jt-line--container jt-line--collapsed" data-depth="1" data-path="$.value"
     role="treeitem" aria-expanded="false" aria-level="2"
     aria-label="value array, 23 items, collapsed">
  <span class="jt-gutter">4</span>
  <span class="jt-indent" style="width: 20px"></span>
  <span class="jt-toggle" aria-hidden="true">▸</span>
  <span class="jt-key">"value"</span>
  <span class="jt-punctuation">: </span>
  <span class="jt-bracket jt-bracket--open">[</span>
  <span class="jt-preview"> ... </span>
  <span class="jt-bracket jt-bracket--close">]</span>
  <span class="jt-count">(23 items)</span>
</div>
```

### 4.6 Primitive Nodes

**String value:**

```html
<div class="jt-line jt-line--leaf" data-depth="2" data-path="$.value[0].displayName"
     role="treeitem" aria-level="3">
  <span class="jt-gutter">7</span>
  <span class="jt-indent" style="width: 40px"></span>
  <span class="jt-key" data-copy-path="$.value[0].displayName">"displayName"</span>
  <span class="jt-punctuation">: </span>
  <span class="jt-value jt-value--string" data-copy-value='"My Table"'>"My Table"</span>
  <span class="jt-punctuation">,</span>
</div>
```

**Number value:**

```html
<div class="jt-line jt-line--leaf" data-depth="2" data-path="$.value[0].rowCount"
     role="treeitem" aria-level="3">
  <span class="jt-gutter">8</span>
  <span class="jt-indent" style="width: 40px"></span>
  <span class="jt-key">"rowCount"</span>
  <span class="jt-punctuation">: </span>
  <span class="jt-value jt-value--number" data-copy-value="42000">42000</span>
  <span class="jt-punctuation">,</span>
</div>
```

**Boolean value:**

```html
<div class="jt-line jt-line--leaf" data-depth="2" data-path="$.value[0].isActive"
     role="treeitem" aria-level="3">
  <span class="jt-gutter">9</span>
  <span class="jt-indent" style="width: 40px"></span>
  <span class="jt-key">"isActive"</span>
  <span class="jt-punctuation">: </span>
  <span class="jt-value jt-value--boolean" data-copy-value="true">true</span>
  <span class="jt-punctuation">,</span>
</div>
```

**Null value:**

```html
<div class="jt-line jt-line--leaf" data-depth="2" data-path="$.value[0].deletedAt"
     role="treeitem" aria-level="3">
  <span class="jt-gutter">10</span>
  <span class="jt-indent" style="width: 40px"></span>
  <span class="jt-key">"deletedAt"</span>
  <span class="jt-punctuation">: </span>
  <span class="jt-value jt-value--null" data-copy-value="null">null</span>
</div>
```

### 4.7 Trailing Comma Rule

- Every property/element line gets a trailing comma **except** the last child in its parent container.
- The comma is rendered as `<span class="jt-punctuation">,</span>`.
- Closing brackets never have commas; the parent's next-sibling line handles its own comma.

---

## 5. CSS Specification

### 5.1 CSS Custom Properties (Scoped to `.jt-root`)

```css
.jt-root {
  /* ── Layout ── */
  --jt-indent: 20px;
  --jt-line-height: 22px;
  --jt-gutter-width: 48px;
  --jt-toggle-width: 16px;

  /* ── Syntax Colors (light) ── */
  --jt-key:          oklch(0.49 0.22 289);
  --jt-string:       oklch(0.55 0.18 164);
  --jt-number:       oklch(0.52 0.19 260);
  --jt-boolean:      oklch(0.58 0.16 75);
  --jt-null:         var(--text-muted);
  --jt-bracket:      var(--text-muted);
  --jt-punctuation:  var(--text-muted);

  /* ── Interactive ── */
  --jt-hover-bg:     var(--accent-hover);
  --jt-search-bg:    oklch(0.85 0.14 85);
  --jt-search-active: oklch(0.72 0.18 85);
  --jt-copy-flash:   oklch(0.85 0.14 164 / 0.3);

  /* ── Timing ── */
  --jt-transition:   160ms cubic-bezier(0.4, 0, 0.2, 1);
  --jt-collapse-dur: 120ms;
}

[data-theme="dark"] .jt-root {
  --jt-key:          oklch(0.72 0.16 289);
  --jt-string:       oklch(0.78 0.14 164);
  --jt-number:       oklch(0.72 0.16 260);
  --jt-boolean:      oklch(0.82 0.13 75);
  --jt-search-bg:    oklch(0.45 0.14 85 / 0.5);
  --jt-search-active: oklch(0.60 0.18 85 / 0.7);
  --jt-copy-flash:   oklch(0.60 0.14 164 / 0.3);
}
```

### 5.2 Root & Layout

```css
.jt-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--jt-line-height);
  overflow: hidden;
  position: relative;
}

.jt-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
  overscroll-behavior: contain;
}
```

### 5.3 Toolbar

```css
.jt-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.jt-btn {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-1);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: background var(--jt-transition), border-color var(--jt-transition);
}

.jt-btn:hover {
  background: var(--accent-hover);
  border-color: var(--accent);
}

.jt-btn--icon {
  padding: var(--space-1);
  min-width: 24px;
  text-align: center;
}

.jt-btn--ghost {
  border: none;
  background: transparent;
  color: var(--text-muted);
}

.jt-btn--ghost:hover {
  color: var(--accent);
}

.jt-level-control {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.jt-level-display {
  min-width: 48px;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.jt-search-box {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}

.jt-search-input {
  width: 160px;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-0);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.jt-search-input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.jt-search-count {
  font-size: var(--text-xs);
  color: var(--text-muted);
  min-width: 48px;
}
```

### 5.4 Tree Lines

```css
.jt-line {
  display: flex;
  align-items: baseline;
  min-height: var(--jt-line-height);
  padding-right: var(--space-4);
  white-space: pre;
  cursor: default;
  position: relative;
}

.jt-line:hover {
  background: var(--jt-hover-bg);
}

.jt-gutter {
  width: var(--jt-gutter-width);
  text-align: right;
  padding-right: var(--space-3);
  color: var(--text-muted);
  opacity: 0.5;
  user-select: none;
  flex-shrink: 0;
}

.jt-indent {
  flex-shrink: 0;
}

.jt-toggle {
  width: var(--jt-toggle-width);
  text-align: center;
  cursor: pointer;
  user-select: none;
  color: var(--text-muted);
  flex-shrink: 0;
  transition: transform var(--jt-collapse-dur);
}

.jt-toggle:hover {
  color: var(--accent);
}

/* Leaf lines have no toggle, but need the same space for alignment */
.jt-line--leaf .jt-toggle {
  visibility: hidden;
}
```

### 5.5 Syntax Token Styles

```css
.jt-key {
  color: var(--jt-key);
  cursor: pointer;
}

.jt-key:hover {
  text-decoration: underline;
  text-decoration-style: dotted;
}

.jt-value--string  { color: var(--jt-string); }
.jt-value--number  { color: var(--jt-number); }
.jt-value--boolean { color: var(--jt-boolean); }
.jt-value--null    { color: var(--jt-null); font-style: italic; }

.jt-value {
  cursor: pointer;
}

.jt-value:hover {
  text-decoration: underline;
  text-decoration-style: dotted;
}

.jt-bracket      { color: var(--jt-bracket); }
.jt-punctuation   { color: var(--jt-punctuation); }
```

### 5.6 Collapse & Preview

```css
.jt-line--collapsed .jt-children {
  display: none;
}

.jt-preview {
  color: var(--text-muted);
  font-style: italic;
}

.jt-count {
  color: var(--text-muted);
  font-size: var(--text-xs);
  margin-left: var(--space-1);
}
```

### 5.7 Search Highlighting

```css
.jt-search-hit {
  background: var(--jt-search-bg);
  border-radius: 2px;
  padding: 0 1px;
}

.jt-search-hit--active {
  background: var(--jt-search-active);
  outline: 2px solid var(--jt-search-active);
  outline-offset: 1px;
}

.jt-line--search-match {
  background: var(--jt-hover-bg);
}
```

### 5.8 Copy Flash Animation

```css
@keyframes jt-copy-flash {
  0%   { background: var(--jt-copy-flash); }
  100% { background: transparent; }
}

.jt-value--copied,
.jt-key--copied {
  animation: jt-copy-flash 400ms ease-out;
}
```

### 5.9 Breadcrumb Bar

```css
.jt-breadcrumb {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--border);
  font-size: var(--text-xs);
  color: var(--text-muted);
  flex-shrink: 0;
  min-height: 24px;
}

.jt-breadcrumb-path {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### 5.10 Large Response Warning

```css
.jt-warning {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: oklch(0.85 0.14 85 / 0.15);
  border-bottom: 1px solid oklch(0.72 0.16 85 / 0.3);
  font-size: var(--text-xs);
  color: var(--text);
}

[data-theme="dark"] .jt-warning {
  background: oklch(0.35 0.10 85 / 0.2);
  border-color: oklch(0.50 0.12 85 / 0.3);
}

.jt-warning-icon {
  color: oklch(0.72 0.16 85);
  flex-shrink: 0;
}
```

### 5.11 Virtualization Placeholder

```css
.jt-virtual-spacer {
  /* Height set dynamically via JS to represent off-screen nodes */
  width: 100%;
  pointer-events: none;
}
```

---

## 6. Rendering Algorithm

### 6.1 Entry Point

```
FUNCTION render(json):
    { root, nodeCount, sourceSize } = parseJson(json)
    this._root = root
    this._nodeCount = nodeCount
    this._sourceSize = sourceSize

    // Clear previous tree
    this._body.innerHTML = ''
    this._lineNumber = 0
    this._flatLines = []     // ordered list of all visible lines (for search, virtualization)
    this._nodeMap = new Map() // path → JTNode (for fast lookup)

    // Show warning for large responses
    IF sourceSize > 512000:
        this._showLargeWarning(sourceSize)

    // Choose rendering strategy
    IF nodeCount <= 1000:
        this._renderImmediate(root)
    ELSE IF nodeCount <= 5000:
        this._renderBatched(root)
    ELSE:
        this._renderVirtualized(root)

    // Set initial level display
    this._updateLevelDisplay()
```

### 6.2 Immediate Rendering (≤1000 nodes)

Builds entire DOM synchronously in one frame.

```
FUNCTION _renderImmediate(root):
    fragment = document.createDocumentFragment()
    this._renderNode(root, fragment, true)
    this._body.appendChild(fragment)

FUNCTION _renderNode(node, parent, isLast):
    this._nodeMap.set(node.path, node)

    IF node.type == 'object' OR node.type == 'array':
        _renderContainerNode(node, parent, isLast)
    ELSE:
        _renderLeafNode(node, parent, isLast)

FUNCTION _renderContainerNode(node, parent, isLast):
    this._lineNumber += 1
    openBracket = node.type == 'object' ? '{' : '['
    closeBracket = node.type == 'object' ? '}' : ']'

    // Opening line
    openLine = _createLine('container', node)
    openLine.appendChild(_createGutter(this._lineNumber))
    openLine.appendChild(_createIndent(node.depth))
    toggle = _createToggle(node.collapsed)
    openLine.appendChild(toggle)

    IF node.key != null:
        openLine.appendChild(_createKey(node.key, node.path))
        openLine.appendChild(_createPunctuation(': '))

    openLine.appendChild(_createBracket(openBracket, 'open'))

    IF node.collapsed:
        openLine.classList.add('jt-line--collapsed')
        openLine.appendChild(_createPreview())
        openLine.appendChild(_createBracket(closeBracket, 'close'))
        countLabel = node.type == 'object'
            ? '(' + node.childCount + ' key' + (node.childCount != 1 ? 's' : '') + ')'
            : '(' + node.childCount + ' item' + (node.childCount != 1 ? 's' : '') + ')'
        openLine.appendChild(_createCount(countLabel))
        IF NOT isLast:
            openLine.appendChild(_createPunctuation(','))
    parent.appendChild(openLine)
    this._flatLines.push({ node, el: openLine, type: 'open' })
    node.el = openLine

    // Children (only if expanded)
    IF NOT node.collapsed:
        childrenContainer = document.createElement('div')
        childrenContainer.className = 'jt-children'
        childrenContainer.setAttribute('role', 'group')

        FOR i = 0 TO node.children.length - 1:
            child = node.children[i]
            childIsLast = (i == node.children.length - 1)
            this._renderNode(child, childrenContainer, childIsLast)

        parent.appendChild(childrenContainer)

        // Closing line
        this._lineNumber += 1
        closeLine = _createLine('close', node)
        closeLine.appendChild(_createGutter(this._lineNumber))
        closeLine.appendChild(_createIndent(node.depth))
        closeLine.appendChild(_createToggleSpacer())  // empty space to align with toggle
        closeLine.appendChild(_createBracket(closeBracket, 'close'))
        IF NOT isLast:
            closeLine.appendChild(_createPunctuation(','))
        parent.appendChild(closeLine)
        this._flatLines.push({ node, el: closeLine, type: 'close' })

FUNCTION _renderLeafNode(node, parent, isLast):
    this._lineNumber += 1
    line = _createLine('leaf', node)
    line.appendChild(_createGutter(this._lineNumber))
    line.appendChild(_createIndent(node.depth))
    line.appendChild(_createToggleSpacer())  // empty space for alignment

    IF node.key != null:
        line.appendChild(_createKey(node.key, node.path))
        line.appendChild(_createPunctuation(': '))

    line.appendChild(_createValue(node))

    IF NOT isLast:
        line.appendChild(_createPunctuation(','))

    parent.appendChild(line)
    this._flatLines.push({ node, el: line, type: 'leaf' })
    node.el = line
```

### 6.3 DOM Element Factories

```
FUNCTION _createLine(type, node):
    div = document.createElement('div')
    div.className = 'jt-line jt-line--' + type
    div.dataset.depth = node.depth
    div.dataset.path = node.path

    IF type != 'close':
        div.setAttribute('role', 'treeitem')
        div.setAttribute('aria-level', node.depth + 1)
        IF node.type == 'object' OR node.type == 'array':
            div.setAttribute('aria-expanded', String(!node.collapsed))
            label = (node.key || 'root') + ' ' + node.type + ', ' + node.childCount
                + (node.type == 'object' ? ' keys' : ' items')
            IF node.collapsed: label += ', collapsed'
            div.setAttribute('aria-label', label)
    RETURN div

FUNCTION _createGutter(lineNum):
    span = document.createElement('span')
    span.className = 'jt-gutter'
    span.textContent = lineNum
    RETURN span

FUNCTION _createIndent(depth):
    span = document.createElement('span')
    span.className = 'jt-indent'
    span.style.width = (depth * parseInt(getComputedStyle(root).getPropertyValue('--jt-indent'))) + 'px'
    RETURN span

FUNCTION _createToggle(collapsed):
    span = document.createElement('span')
    span.className = 'jt-toggle'
    span.setAttribute('aria-hidden', 'true')
    span.textContent = collapsed ? '▸' : '▾'
    RETURN span

FUNCTION _createToggleSpacer():
    span = document.createElement('span')
    span.className = 'jt-toggle'
    span.style.visibility = 'hidden'
    span.textContent = '▾'
    RETURN span

FUNCTION _createKey(key, path):
    span = document.createElement('span')
    span.className = 'jt-key'
    span.dataset.copyPath = path
    span.textContent = '"' + key + '"'
    RETURN span

FUNCTION _createValue(node):
    span = document.createElement('span')
    span.className = 'jt-value jt-value--' + node.type

    IF node.type == 'string':
        span.textContent = '"' + node.value + '"'
        span.dataset.copyValue = JSON.stringify(node.value)
    ELSE IF node.type == 'null':
        span.textContent = 'null'
        span.dataset.copyValue = 'null'
    ELSE:
        span.textContent = String(node.value)
        span.dataset.copyValue = String(node.value)

    RETURN span

FUNCTION _createBracket(char, position):
    span = document.createElement('span')
    span.className = 'jt-bracket jt-bracket--' + position
    span.textContent = char
    RETURN span

FUNCTION _createPunctuation(text):
    span = document.createElement('span')
    span.className = 'jt-punctuation'
    span.textContent = text
    RETURN span

FUNCTION _createPreview():
    span = document.createElement('span')
    span.className = 'jt-preview'
    span.textContent = ' ... '
    RETURN span

FUNCTION _createCount(label):
    span = document.createElement('span')
    span.className = 'jt-count'
    span.textContent = label
    RETURN span
```

### 6.4 Batched Rendering (1001–5000 nodes)

Uses `requestAnimationFrame` to render in chunks of ~200 nodes per frame, keeping the main thread responsive.

```
FUNCTION _renderBatched(root):
    CONST BATCH_SIZE = 200
    queue = [{ node: root, parent: this._body, isLast: true }]
    processed = 0

    FUNCTION processBatch():
        startTime = performance.now()
        count = 0

        WHILE queue.length > 0 AND count < BATCH_SIZE:
            { node, parent, isLast } = queue.shift()
            this._renderNodeWithQueue(node, parent, isLast, queue)
            count += 1

        IF queue.length > 0:
            requestAnimationFrame(processBatch)
        ELSE:
            this._onRenderComplete()

    requestAnimationFrame(processBatch)

FUNCTION _renderNodeWithQueue(node, parent, isLast, queue):
    // Same as _renderNode but instead of recursing into children,
    // push them onto the queue for the next batch
    this._nodeMap.set(node.path, node)

    IF node.type == 'object' OR node.type == 'array':
        // Render open line (same as _renderContainerNode)
        // But for children, push each onto queue instead of recursing:
        IF NOT node.collapsed:
            childrenContainer = createChildrenContainer()
            parent.appendChild(childrenContainer)
            FOR i = 0 TO node.children.length - 1:
                queue.push({
                    node: node.children[i],
                    parent: childrenContainer,
                    isLast: (i == node.children.length - 1)
                })
            // Closing bracket pushed after all children
            queue.push({ node: node, parent: parent, isLast: isLast, type: 'close' })
    ELSE:
        _renderLeafNode(node, parent, isLast)
```

---

## 7. Collapse/Expand Behavior

### 7.1 Toggle Single Node

Triggered by clicking the toggle indicator (`▾`/`▸`) or the opening bracket.

```
FUNCTION _toggleNode(node):
    node.collapsed = !node.collapsed

    IF node.collapsed:
        // 1. Remove children container from DOM
        childrenEl = node.el.nextElementSibling  // the .jt-children div
        IF childrenEl AND childrenEl.classList.contains('jt-children'):
            closingLine = childrenEl.nextElementSibling  // the closing bracket line
            childrenEl.remove()
            IF closingLine: closingLine.remove()

        // 2. Add preview + count inline on the opening line
        node.el.classList.add('jt-line--collapsed')
        node.el.appendChild(_createPreview())
        node.el.appendChild(_createBracket(closingChar(node), 'close'))
        node.el.appendChild(_createCount(countLabel(node)))

        // 3. Update ARIA
        node.el.setAttribute('aria-expanded', 'false')

        // 4. Update toggle text
        node.el.querySelector('.jt-toggle').textContent = '▸'

    ELSE:
        // 1. Remove inline preview/count/closing bracket
        node.el.classList.remove('jt-line--collapsed')
        removeInlinePreview(node.el)

        // 2. Render children into new container
        childrenContainer = document.createElement('div')
        childrenContainer.className = 'jt-children'
        childrenContainer.setAttribute('role', 'group')
        FOR i = 0 TO node.children.length - 1:
            this._renderNode(node.children[i], childrenContainer, i == node.children.length - 1)
        node.el.after(childrenContainer)

        // 3. Render closing line
        closeLine = _createClosingLine(node)
        childrenContainer.after(closeLine)

        // 4. Update ARIA and toggle
        node.el.setAttribute('aria-expanded', 'true')
        node.el.querySelector('.jt-toggle').textContent = '▾'

    // 5. Rebuild _flatLines and re-number
    this._rebuildFlatLines()
    this._renumberGutters()
```

### 7.2 Expand All

```
FUNCTION expandAll():
    _walkTree(this._root, (node) => {
        IF (node.type == 'object' OR node.type == 'array') AND node.collapsed:
            node.collapsed = false
    })
    // Full re-render is cheaper than toggling each node individually
    this._body.innerHTML = ''
    this._lineNumber = 0
    this._flatLines = []
    this._renderImmediate(this._root)  // or batched if > 1000 nodes
```

### 7.3 Collapse All

```
FUNCTION collapseAll():
    _walkTree(this._root, (node) => {
        IF node.type == 'object' OR node.type == 'array':
            node.collapsed = true
    })
    // Keep root expanded for usability
    this._root.collapsed = false

    this._body.innerHTML = ''
    this._lineNumber = 0
    this._flatLines = []
    this._renderImmediate(this._root)
```

### 7.4 Expand to Level N

```
FUNCTION expandToLevel(n):
    _walkTree(this._root, (node) => {
        IF node.type == 'object' OR node.type == 'array':
            node.collapsed = node.depth >= n
    })
    this._body.innerHTML = ''
    this._lineNumber = 0
    this._flatLines = []
    this._renderImmediate(this._root)
    this._updateLevelDisplay()
```

The level control in the toolbar shows the current target level and provides `◂`/`▸` buttons to decrement/increment. Range: 0 (root collapsed) to `maxDepth` (everything expanded).

### 7.5 Walk Helper

```
FUNCTION _walkTree(node, callback):
    callback(node)
    IF node.children:
        FOR child IN node.children:
            _walkTree(child, callback)
```

---

## 8. Syntax Coloring

### 8.1 Type Detection and Color Application

Colors are applied via CSS class modifiers on `<span>` elements. The renderer never sets inline `color:` styles — all coloring is through class → CSS variable mappings.

| JSON Type | CSS Class           | CSS Variable       |
|-----------|---------------------|---------------------|
| Key       | `.jt-key`           | `--jt-key`          |
| String    | `.jt-value--string` | `--jt-string`       |
| Number    | `.jt-value--number` | `--jt-number`       |
| Boolean   | `.jt-value--boolean`| `--jt-boolean`      |
| Null      | `.jt-value--null`   | `--jt-null`         |
| Bracket   | `.jt-bracket`       | `--jt-bracket`      |
| Comma     | `.jt-punctuation`   | `--jt-punctuation`  |

### 8.2 Theme Switching

All color variables are defined twice — once in `.jt-root` (light theme defaults) and once in `[data-theme="dark"] .jt-root` (dark overrides). Theme switching is automatic: EDOG Studio toggles `data-theme` on `<html>`, and CSS cascade handles the rest.

No JavaScript is needed for theme switching. The CSS custom property values change and all rendered elements update instantly.

### 8.3 String Value Special Cases

Long strings (>80 characters) are truncated in the tree with an ellipsis and a "show more" affordance:

```
FUNCTION _formatStringValue(value):
    IF value.length > 80:
        truncated = value.substring(0, 77) + '...'
        // Render truncated, store full value in data-full-value
        // Click to expand inline
    ELSE:
        // Render as-is
```

URLs within string values are rendered with a subtle underline and are clickable (open in default browser).

### 8.4 Number Formatting

Numbers are displayed as-is from the JSON source (no locale formatting). Very large numbers (>15 digits) or scientific notation are preserved exactly.

---

## 9. Copy Behavior

### 9.1 Click Value to Copy

Clicking any `.jt-value` element copies its raw value to the clipboard.

```
FUNCTION _handleValueClick(event):
    target = event.target.closest('.jt-value')
    IF NOT target: RETURN

    value = target.dataset.copyValue
    navigator.clipboard.writeText(value).then(() => {
        // Flash animation
        target.classList.add('jt-value--copied')
        target.addEventListener('animationend', () => {
            target.classList.remove('jt-value--copied')
        }, { once: true })

        // Show toast
        showToast('Copied: ' + truncate(value, 40))
    })
```

### 9.2 Click Key to Copy Path

Clicking any `.jt-key` element copies the full JSONPath to the clipboard.

```
FUNCTION _handleKeyClick(event):
    target = event.target.closest('.jt-key')
    IF NOT target: RETURN

    path = target.dataset.copyPath
    navigator.clipboard.writeText(path).then(() => {
        target.classList.add('jt-key--copied')
        target.addEventListener('animationend', () => {
            target.classList.remove('jt-key--copied')
        }, { once: true })

        showToast('Copied path: ' + path)
    })
```

### 9.3 Copy Subtree

Right-click on a container node's opening bracket opens a context action (not a browser context menu — an inline dropdown):

- **Copy value** — copies the JSON subtree (pretty-printed with 2-space indent) to clipboard
- **Copy path** — copies the JSONPath
- **Copy as compact** — copies the subtree as single-line JSON

```
FUNCTION _copySubtree(node, format):
    subtreeData = reconstructValue(node)
    IF format == 'pretty':
        text = JSON.stringify(subtreeData, null, 2)
    ELSE:
        text = JSON.stringify(subtreeData)
    navigator.clipboard.writeText(text)
    showToast('Copied ' + node.childCount + ' items')
```

### 9.4 Toast Notification

Uses the global EDOG Studio toast system (existing `showToast(message, duration)` function). Duration: 2000ms. Position: bottom-right.

---

## 10. Path Breadcrumb

### 10.1 Display

The breadcrumb bar at the bottom of the JSON tree shows the full JSONPath of the currently hovered node.

```
FUNCTION _handleLineHover(event):
    line = event.target.closest('.jt-line')
    IF NOT line: RETURN

    path = line.dataset.path
    IF NOT path: RETURN

    this._breadcrumbPath.textContent = path
    this._breadcrumbCopyBtn.dataset.path = path
```

### 10.2 Path Format

Paths follow JSONPath dot-notation with bracket escaping for special keys:

| Hover Target                 | Displayed Path                      |
|------------------------------|--------------------------------------|
| Root object                  | `$`                                  |
| First-level key "status"     | `$.status`                           |
| Array item at index 0        | `$.value[0]`                         |
| Nested property              | `$.value[0].displayName`             |
| Key with dot in name         | `$["weird.key"]`                     |
| Key with spaces              | `$.items[3]["key with spaces"]`      |

### 10.3 Click to Copy

Clicking the "Copy" button next to the breadcrumb copies the displayed path.

```
FUNCTION _handleBreadcrumbCopy():
    path = this._breadcrumbPath.textContent
    IF path:
        navigator.clipboard.writeText(path)
        showToast('Copied path: ' + path)
```

### 10.4 Mouseleave Behavior

When the cursor leaves the tree body, the breadcrumb clears after a 300ms delay (to prevent flicker when moving between lines).

---

## 11. Search

### 11.1 Activation

- **Keyboard shortcut:** `Ctrl+F` (or `Cmd+F` on macOS) when the JSON tree body has focus.
- **Toolbar input:** Always visible in the toolbar. Clicking focuses it.
- `Ctrl+F` focuses the search input. If already focused, selects all text.

### 11.2 Search Algorithm

Search is debounced (200ms after last keystroke). It searches both keys and values as plain text (case-insensitive).

```
FUNCTION search(query):
    this.clearSearch()
    IF NOT query OR query.length < 2: RETURN 0

    query = query.toLowerCase()
    this._searchMatches = []
    this._searchIndex = -1

    _walkTree(this._root, (node) => {
        // Search in key
        IF node.key AND node.key.toLowerCase().includes(query):
            this._searchMatches.push({ node, target: 'key' })

        // Search in value (primitives only)
        IF node.value !== null AND node.value !== undefined:
            valueStr = String(node.value).toLowerCase()
            IF valueStr.includes(query):
                this._searchMatches.push({ node, target: 'value' })
    })

    // Ensure all matched nodes are visible (expand ancestors)
    FOR match IN this._searchMatches:
        this._ensureVisible(match.node)

    // Re-render if any nodes were expanded
    IF anyExpansionChanged:
        this._fullRerender()

    // Apply highlight classes
    FOR match IN this._searchMatches:
        el = match.node.el
        IF NOT el: CONTINUE
        targetSpan = match.target == 'key'
            ? el.querySelector('.jt-key')
            : el.querySelector('.jt-value')
        IF targetSpan:
            this._highlightText(targetSpan, query)

    // Jump to first match
    IF this._searchMatches.length > 0:
        this._searchIndex = 0
        this._activateMatch(0)

    // Update count display
    this._searchCountEl.textContent = this._searchMatches.length + ' matches'

    RETURN this._searchMatches.length
```

### 11.3 Text Highlighting

Matching substring within a key or value `<span>` is wrapped in a `<mark class="jt-search-hit">` element.

```
FUNCTION _highlightText(span, query):
    text = span.textContent
    lowerText = text.toLowerCase()
    index = lowerText.indexOf(query)

    IF index == -1: RETURN

    // Split text node into before, match, after
    before = text.substring(0, index)
    match = text.substring(index, index + query.length)
    after = text.substring(index + query.length)

    span.textContent = ''
    IF before: span.appendChild(document.createTextNode(before))
    mark = document.createElement('mark')
    mark.className = 'jt-search-hit'
    mark.textContent = match
    span.appendChild(mark)
    IF after: span.appendChild(document.createTextNode(after))
```

### 11.4 Match Navigation

```
FUNCTION nextMatch():
    IF this._searchMatches.length == 0: RETURN
    this._deactivateMatch(this._searchIndex)
    this._searchIndex = (this._searchIndex + 1) % this._searchMatches.length
    this._activateMatch(this._searchIndex)

FUNCTION prevMatch():
    IF this._searchMatches.length == 0: RETURN
    this._deactivateMatch(this._searchIndex)
    this._searchIndex = (this._searchIndex - 1 + this._searchMatches.length) % this._searchMatches.length
    this._activateMatch(this._searchIndex)

FUNCTION _activateMatch(index):
    match = this._searchMatches[index]
    el = match.node.el
    IF NOT el: RETURN

    // Add active class to the <mark>
    mark = el.querySelector('.jt-search-hit')
    IF mark: mark.classList.add('jt-search-hit--active')

    // Scroll into view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })

    // Update counter display
    this._searchCountEl.textContent = (index + 1) + '/' + this._searchMatches.length

FUNCTION _deactivateMatch(index):
    match = this._searchMatches[index]
    el = match.node.el
    IF NOT el: RETURN
    mark = el.querySelector('.jt-search-hit--active')
    IF mark: mark.classList.remove('jt-search-hit--active')
```

### 11.5 Ensure Visibility

When a search match is inside a collapsed subtree, all ancestors must be expanded:

```
FUNCTION _ensureVisible(node):
    // Walk up the tree via path segments to find collapsed ancestors
    ancestors = this._getAncestors(node)
    anyChanged = false
    FOR ancestor IN ancestors:
        IF ancestor.collapsed:
            ancestor.collapsed = false
            anyChanged = true
    RETURN anyChanged
```

### 11.6 Keyboard Bindings in Search

| Key         | Action                           |
|-------------|----------------------------------|
| `Enter`     | Jump to next match               |
| `Shift+Enter` | Jump to previous match        |
| `Escape`    | Clear search, return focus to tree body |

---

## 12. Virtualization

### 12.1 Strategy

For trees exceeding `virtualizationThreshold` (default: 5000 visible nodes), only DOM elements within the viewport (plus a buffer zone) are rendered. Off-screen nodes are represented by spacer `<div>` elements with calculated heights.

### 12.2 Architecture

```
┌─────────────────────────────────┐
│         Top Spacer              │  height = hiddenTopNodes × lineHeight
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │  Rendered Line 1            │ │
│ │  Rendered Line 2            │ │  Visible viewport + buffer
│ │  ...                        │ │  (buffer = 50 lines above + 50 below)
│ │  Rendered Line N            │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│        Bottom Spacer            │  height = hiddenBottomNodes × lineHeight
└─────────────────────────────────┘
```

### 12.3 Flat Line Index

Before virtualization, the tree is flattened into an ordered list of all potentially visible lines (respecting current collapse state):

```
FUNCTION _buildFlatIndex():
    this._virtualLines = []
    _flattenNode(this._root)

FUNCTION _flattenNode(node):
    // Opening line
    this._virtualLines.push({ node, type: 'open' })

    IF NOT node.collapsed AND node.children:
        FOR child IN node.children:
            _flattenNode(child)
        // Closing line
        this._virtualLines.push({ node, type: 'close' })
```

### 12.4 Scroll Handler

```
FUNCTION _onScroll():
    scrollTop = this._body.scrollTop
    viewportHeight = this._body.clientHeight
    lineHeight = parseInt(getComputedStyle(this._rootEl).getPropertyValue('--jt-line-height'))

    totalLines = this._virtualLines.length
    firstVisible = Math.floor(scrollTop / lineHeight)
    lastVisible = Math.ceil((scrollTop + viewportHeight) / lineHeight)

    // Buffer: render 50 extra lines above and below
    CONST BUFFER = 50
    renderStart = Math.max(0, firstVisible - BUFFER)
    renderEnd = Math.min(totalLines - 1, lastVisible + BUFFER)

    // Skip re-render if range hasn't changed significantly (hysteresis of 10 lines)
    IF Math.abs(renderStart - this._lastRenderStart) < 10
       AND Math.abs(renderEnd - this._lastRenderEnd) < 10:
        RETURN

    this._lastRenderStart = renderStart
    this._lastRenderEnd = renderEnd

    // Clear and re-render
    fragment = document.createDocumentFragment()

    // Top spacer
    topSpacer = document.createElement('div')
    topSpacer.className = 'jt-virtual-spacer'
    topSpacer.style.height = (renderStart * lineHeight) + 'px'
    fragment.appendChild(topSpacer)

    // Render visible lines
    FOR i = renderStart TO renderEnd:
        vLine = this._virtualLines[i]
        el = this._renderVirtualLine(vLine, i + 1)
        fragment.appendChild(el)

    // Bottom spacer
    bottomSpacer = document.createElement('div')
    bottomSpacer.className = 'jt-virtual-spacer'
    bottomSpacer.style.height = ((totalLines - renderEnd - 1) * lineHeight) + 'px'
    fragment.appendChild(bottomSpacer)

    this._body.innerHTML = ''
    this._body.appendChild(fragment)
```

### 12.5 Scroll Debouncing

The scroll handler uses `requestAnimationFrame` to coalesce rapid scroll events:

```
FUNCTION _attachScrollHandler():
    this._scrollRAF = null
    this._body.addEventListener('scroll', () => {
        IF this._scrollRAF: cancelAnimationFrame(this._scrollRAF)
        this._scrollRAF = requestAnimationFrame(() => this._onScroll())
    }, { passive: true })
```

### 12.6 Collapse/Expand in Virtualized Mode

When a node is toggled in virtualized mode:

1. Update `node.collapsed` in the data model.
2. Rebuild `_virtualLines` (the flat index).
3. Adjust scroll position to keep the toggled node in view.
4. Trigger `_onScroll()` to re-render the visible window.

This avoids DOM manipulation of potentially thousands of nodes.

---

## 13. Performance Budgets

### 13.1 Render Time Targets

| Scenario                | Target     | Maximum     |
|-------------------------|------------|-------------|
| < 100 nodes             | < 5ms      | 10ms        |
| 100–1000 nodes          | < 30ms     | 50ms        |
| 1000–5000 nodes         | < 100ms    | 200ms       |
| 5000–50000 nodes        | < 200ms    | 500ms       |
| > 50000 nodes           | < 300ms    | 1000ms      |

*Measured from `render()` call to first visible frame (using `performance.mark`/`performance.measure`).*

### 13.2 Memory Limits

| Component               | Budget                            |
|--------------------------|-----------------------------------|
| JTNode tree (data model) | ~100 bytes per node              |
| DOM elements (immediate) | ~500 bytes per rendered line     |
| DOM elements (virtual)   | Max 500 rendered lines at a time |
| Flat line index          | ~40 bytes per entry              |
| Total for 50K node tree  | < 15MB                           |

### 13.3 Scroll Performance

- Scroll handler must complete in < 4ms (fits within 16ms frame budget with room for paint).
- No forced layout/reflow during scroll. All width/height reads cached.
- `will-change: transform` on `.jt-body` for compositor-accelerated scroll.
- `contain: content` on `.jt-body` to isolate layout recalculations.

### 13.4 Interaction Latency

| Action                    | Target    |
|---------------------------|-----------|
| Toggle single node        | < 16ms    |
| Expand all (1000 nodes)   | < 100ms   |
| Collapse all              | < 50ms    |
| Search (1000 nodes)       | < 50ms    |
| Search (10000 nodes)      | < 200ms   |
| Copy to clipboard         | < 5ms     |
| Path breadcrumb update    | < 1ms     |

### 13.5 Measurement Strategy

```javascript
_measureRender(label, fn) {
  const mark = `jt-${label}-start`;
  performance.mark(mark);
  fn();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      performance.measure(`jt-${label}`, mark);
      const entry = performance.getEntriesByName(`jt-${label}`)[0];
      if (entry.duration > this._budgets[label]) {
        console.warn(`[JsonTree] ${label} took ${entry.duration.toFixed(1)}ms (budget: ${this._budgets[label]}ms)`);
      }
    });
  });
}
```

---

## 14. Accessibility

### 14.1 ARIA Roles and Properties

| Element              | Role         | ARIA Properties                                    |
|----------------------|--------------|----------------------------------------------------|
| `.jt-root`           | `tree`       | `aria-label="JSON response tree"`                  |
| `.jt-toolbar`        | `toolbar`    | `aria-label="JSON tree controls"`                  |
| `.jt-line` (container) | `treeitem` | `aria-expanded`, `aria-level`, `aria-label`        |
| `.jt-line` (leaf)    | `treeitem`   | `aria-level`                                       |
| `.jt-children`       | `group`      | (groups child treeitems)                           |
| `.jt-search-count`   | —            | `aria-live="polite"` (announces match count)       |
| `.jt-breadcrumb`     | —            | `aria-live="polite"` (announces hovered path)      |
| `.jt-level-display`  | —            | `aria-live="polite"` (announces level changes)     |

### 14.2 Keyboard Navigation

The tree body (`.jt-body`) is focusable via `tabindex="0"`. When focused, the following keys are active:

| Key              | Action                                                      |
|------------------|--------------------------------------------------------------|
| `↓`              | Move focus to next visible treeitem                          |
| `↑`              | Move focus to previous visible treeitem                      |
| `→`              | If collapsed container: expand. If expanded: move to first child. If leaf: no-op. |
| `←`              | If expanded container: collapse. If collapsed/leaf: move to parent. |
| `Enter`          | Toggle expand/collapse on container. Copy value on leaf.     |
| `Space`          | Same as Enter                                                |
| `Home`           | Move focus to first treeitem                                 |
| `End`            | Move focus to last visible treeitem                          |
| `*` (asterisk)   | Expand all siblings at current level                         |
| `Ctrl+C`         | Copy value of focused node                                   |
| `Ctrl+F`         | Focus search input                                           |
| `Escape`         | Clear search / return focus to tree body                     |

### 14.3 Focus Management

```
FUNCTION _handleKeyDown(event):
    IF event.key == 'ArrowDown':
        event.preventDefault()
        this._moveFocus(1)
    ELSE IF event.key == 'ArrowUp':
        event.preventDefault()
        this._moveFocus(-1)
    ELSE IF event.key == 'ArrowRight':
        event.preventDefault()
        node = this._getFocusedNode()
        IF node AND (node.type == 'object' OR node.type == 'array'):
            IF node.collapsed:
                this._toggleNode(node)
            ELSE IF node.children.length > 0:
                this._setFocus(node.children[0])
    ELSE IF event.key == 'ArrowLeft':
        event.preventDefault()
        node = this._getFocusedNode()
        IF node AND (node.type == 'object' OR node.type == 'array') AND NOT node.collapsed:
            this._toggleNode(node)
        ELSE:
            parent = this._getParentNode(node)
            IF parent: this._setFocus(parent)
    ELSE IF event.key == 'Home':
        event.preventDefault()
        this._setFocus(this._root)
    ELSE IF event.key == 'End':
        event.preventDefault()
        lastVisible = this._getLastVisibleNode()
        this._setFocus(lastVisible)

FUNCTION _moveFocus(direction):
    // Use _flatLines to find next/prev visible treeitem
    currentIndex = this._flatLines.findIndex(l => l.el == this._focusedEl)
    newIndex = currentIndex + direction
    IF newIndex >= 0 AND newIndex < this._flatLines.length:
        entry = this._flatLines[newIndex]
        // Skip 'close' lines — they're not focusable treeitems
        WHILE entry.type == 'close':
            newIndex += direction
            IF newIndex < 0 OR newIndex >= this._flatLines.length: RETURN
            entry = this._flatLines[newIndex]
        this._setFocus(entry.node)

FUNCTION _setFocus(node):
    IF this._focusedEl:
        this._focusedEl.removeAttribute('data-focused')
        this._focusedEl.setAttribute('tabindex', '-1')

    IF node.el:
        node.el.setAttribute('data-focused', '')
        node.el.setAttribute('tabindex', '0')
        node.el.focus({ preventScroll: false })
        this._focusedEl = node.el
```

### 14.4 Focus Styling

```css
.jt-line[data-focused] {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--jt-hover-bg);
}
```

### 14.5 Screen Reader Announcements

- Expanding a node: the `aria-expanded` attribute change triggers screen reader announcement.
- Search results: `aria-live="polite"` on the count element announces "N matches" when search completes.
- Breadcrumb: `aria-live="polite"` announces the path when hovering (throttled to avoid excessive announcements — updates at most once per 500ms).
- Level changes: `aria-live="polite"` on level display announces "Level N" when using level controls.

### 14.6 Color Contrast

All syntax colors meet WCAG 2.1 AA contrast ratio (≥4.5:1 for normal text) against both light and dark backgrounds:

| Token    | Light BG Ratio | Dark BG Ratio |
|----------|----------------|---------------|
| Key      | 5.2:1          | 4.8:1         |
| String   | 5.8:1          | 4.6:1         |
| Number   | 6.1:1          | 4.7:1         |
| Boolean  | 4.9:1          | 5.3:1         |
| Null     | 4.5:1          | 4.5:1         |

---

## Appendix A: Event Delegation

All click, hover, and keyboard events are delegated from the root element. No per-node event listeners.

```javascript
_attachEvents() {
  // Single click handler on root
  this._rootEl.addEventListener('click', (e) => {
    const toggle = e.target.closest('.jt-toggle');
    if (toggle) return this._handleToggleClick(e);

    const key = e.target.closest('.jt-key');
    if (key) return this._handleKeyClick(e);

    const value = e.target.closest('.jt-value');
    if (value) return this._handleValueClick(e);

    const bracket = e.target.closest('.jt-bracket');
    if (bracket) return this._handleBracketClick(e);

    const action = e.target.closest('[data-action]');
    if (action) return this._handleToolbarAction(e, action.dataset.action);
  });

  // Hover delegation on tree body
  this._body.addEventListener('mouseover', (e) => this._handleLineHover(e));
  this._body.addEventListener('mouseleave', () => this._handleMouseLeave());

  // Keyboard on tree body
  this._body.addEventListener('keydown', (e) => this._handleKeyDown(e));

  // Search input
  this._searchInput.addEventListener('input',
    debounce((e) => this.search(e.target.value), 200));
  this._searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) this.prevMatch();
    else if (e.key === 'Enter') this.nextMatch();
    else if (e.key === 'Escape') {
      this.clearSearch();
      this._body.focus();
    }
  });

  // Ctrl+F intercept
  this._body.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      this._searchInput.focus();
      this._searchInput.select();
    }
  });
}
```

## Appendix B: Lifecycle & Cleanup

```javascript
destroy() {
  // Cancel any pending rAF
  if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
  if (this._batchRAF) cancelAnimationFrame(this._batchRAF);

  // Clear DOM
  this._rootEl.innerHTML = '';

  // Null out references
  this._root = null;
  this._nodeMap.clear();
  this._flatLines = [];
  this._virtualLines = [];
  this._searchMatches = [];
  this._focusedEl = null;

  // Remove from parent (if still attached)
  if (this._rootEl.parentNode) {
    this._rootEl.parentNode.removeChild(this._rootEl);
  }
}
```

## Appendix C: Integration with Response Viewer

The Response Viewer owns the `JsonTreeRenderer` instance. It creates one when switching to "Pretty" mode and destroys it when switching to "Raw" mode or receiving a new response.

```javascript
// In ResponseViewer module:
_showPrettyMode(jsonString) {
  if (this._jsonTree) this._jsonTree.destroy();
  this._jsonTree = new JsonTreeRenderer(this._prettyContainer, {
    initialDepth: 2,
    showLineNumbers: true,
    showBreadcrumb: true
  });
  this._jsonTree.render(jsonString);
}

_showRawMode(text) {
  if (this._jsonTree) {
    this._jsonTree.destroy();
    this._jsonTree = null;
  }
  this._rawContainer.textContent = text;
}
```

The `JsonTreeRenderer` emits no custom events and has no external dependencies beyond the global `showToast()` function and EDOG Studio CSS custom properties.
