# History & Saved Requests — Component Spec

> **Feature:** F09 API Playground — Section P1.4 History & Saved Requests
> **Status:** SPEC — READY FOR REVIEW
> **Author:** Pixel (Frontend) + Sana Reeves (Architecture)
> **Date:** 2026-04-14
> **Depends On:** `spec.md` §3 (Layout), `p0-foundation.md` §1.1 (CSS audit), `api-playground.css`
> **Feeds Into:** `states/history-saved.md`, `architecture.md` §4 (Storage Model)

---

## 1. Component Overview

The History & Saved Requests sidebar is a 280px-wide right panel in the API Playground. It serves two functions:

1. **History** — An auto-recording flight recorder of every request/response pair. Newest first. Circular buffer of 50 entries in localStorage. One click to replay any past request.
2. **Saved Requests** — A named, categorized library of frequently-used API calls. Pre-populated with common FLT/Fabric endpoints (from the endpoint catalog). Users can save custom requests, rename, delete, and organize.

**Design principle:** Every API call the engineer ever made is one click away from replay. Saved requests eliminate the "what was that endpoint URL?" problem forever. This sidebar is always visible when the API Playground is open — it is the engineer's muscle memory.

### 1.1 Relationship to Other Components

| Component | Interaction |
|-----------|-------------|
| Request Builder | History click / Saved click → populates method, URL, headers, body |
| Response Viewer | History entries store the response snapshot (status, timing, preview) |
| Endpoint Catalog | Built-in saved requests sourced from catalog data |
| ApiPlayground (parent) | Sidebar toggle state, event bus for `request-completed` |

---

## 2. Visual Specification

### 2.1 Sidebar — Expanded (Default)

```
┌─────────────────────────────────┐
│ ◀ │  HISTORY              Clear │ ← Section header (collapsible)
├─────────────────────────────────┤
│ ┌─[Filter: All Methods ▾]────┐  │ ← Filter bar
│ └────────────────────────────┘  │
│                                 │
│  GET  /v1/workspaces/...  200   │ ← History entry (hover → actions)
│       342ms · 2m ago            │
│                                 │
│  POST /v1/.../runDAG      202   │
│       1.2s · 15m ago            │
│                                 │
│  GET  /v1/.../config      401   │
│       89ms · 1h ago             │
│                                 │
│  ⋯ (scrollable, max 50)        │
│                                 │
├─────────────────────────────────┤
│ ▸ │  SAVED REQUESTS     + Save  │ ← Section header (collapsible)
├─────────────────────────────────┤
│                                 │
│  ▸ Fabric (4)                   │ ← Group header (collapsible)
│    GET  List Workspaces         │
│    GET  Get Workspace           │
│    GET  List Lakehouses         │
│    GET  Get Lakehouse           │
│                                 │
│  ▸ FLT (6)                      │
│    GET  Get Config              │
│    POST Run DAG                 │
│    GET  DAG Status              │
│    GET  List Iterations         │
│    GET  Execution Metrics       │
│    POST Cancel Execution        │
│                                 │
│  ▸ Maintenance (2)              │
│    POST Clear Cache             │
│    GET  Health Check            │
│                                 │
│  ▸ Custom (0)                   │
│    (empty — save a request)     │
│                                 │
└─────────────────────────────────┘
```

### 2.2 Sidebar — Collapsed

```
┌──┐
│▶ │ ← 36px collapsed strip, click or Ctrl+H to expand
│  │
│  │
│  │
│  │
│  │
│  │
│  │
│  │
│  │
└──┘
```

- Collapsed width: **36px**
- Shows only the expand chevron (▶) centered vertically
- Tooltip on hover: "Show History & Saved (Ctrl+H)"

### 2.3 History Entry — Anatomy

```
┌─────────────────────────────────┐
│ GET   /v1/workspaces/abc...  200│ ← Row 1: method pill + truncated URL + status badge
│       342ms · 2m ago        ★ ⋯│ ← Row 2: timing + relative time + save + more
└─────────────────────────────────┘
```

| Element | Position | Style |
|---------|----------|-------|
| Method pill | Left, row 1 | 3-char uppercase, monospace, colored background |
| URL | Center, row 1 | Truncated with ellipsis, `--text-dim`, monospace |
| Status badge | Right, row 1 | 3-digit code, colored text, monospace |
| Duration | Left, row 2 | `--text-muted`, monospace, e.g. "342ms" |
| Separator | Row 2 | " · " (middle dot) |
| Relative time | Center, row 2 | `--text-muted`, e.g. "2m ago" |
| Save button | Right, row 2 | ★ (star outline), appears on hover |
| More menu | Far right, row 2 | ⋯ (ellipsis), appears on hover |

### 2.4 Saved Request Entry — Anatomy

```
┌─────────────────────────────────┐
│ GET  List Workspaces          ⋯ │ ← Method pill + name + more menu (hover)
└─────────────────────────────────┘
```

| Element | Position | Style |
|---------|----------|-------|
| Method pill | Left | Same color scheme as history |
| Name | Center | `--text`, regular weight, truncated with ellipsis |
| Built-in icon | Right of name | ◆ (small, `--text-muted`) for built-in entries |
| More menu | Far right | ⋯, appears on hover. Built-in: Copy only. Custom: Edit, Delete, Copy. |

---

## 3. Data Model

### 3.1 localStorage Keys

| Key | Purpose | Max Size |
|-----|---------|----------|
| `edog-api-history` | Request/response history | ~500KB (50 entries × ~10KB avg) |
| `edog-api-saved` | Saved/named requests | ~100KB (generous) |
| `edog-api-sidebar-state` | Collapse state + section toggles | <1KB |

### 3.2 History Entry Schema

```jsonc
// edog-api-history — Array, max 50 entries, newest first
[
  {
    "id": "a1b2c3d4-...",          // crypto.randomUUID()
    "method": "GET",               // GET | POST | PUT | PATCH | DELETE
    "url": "https://api.fabric.microsoft.com/v1/workspaces",
    "headers": [
      { "key": "Authorization", "value": "Bearer eyJ..." },
      { "key": "Content-Type", "value": "application/json" }
    ],
    "body": null,                  // string | null — raw body text
    "response": {
      "status": 200,               // HTTP status code
      "statusText": "OK",          // HTTP status text
      "duration": 342,             // ms (integer)
      "bodySize": 12480,           // bytes (response body size)
      "bodyPreview": "{ \"value\": [...] }"  // first 500 chars of response body
    },
    "timestamp": "2026-04-14T10:30:00Z"  // ISO 8601 UTC
  }
]
```

**Field constraints:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `id` | string (UUID) | Yes | `crypto.randomUUID()` |
| `method` | string | Yes | One of: GET, POST, PUT, PATCH, DELETE |
| `url` | string | Yes | Full URL as entered by user |
| `headers` | array | Yes | Array of `{ key, value }`. May be empty `[]`. |
| `body` | string \| null | Yes | null for GET/DELETE. String for POST/PUT/PATCH. |
| `response.status` | integer | Yes | HTTP status code (100–599) |
| `response.statusText` | string | Yes | HTTP status text |
| `response.duration` | integer | Yes | Milliseconds, 0 if unmeasured |
| `response.bodySize` | integer | Yes | Bytes. 0 if empty body. |
| `response.bodyPreview` | string | Yes | First 500 chars. Empty string if no body. |
| `timestamp` | string (ISO 8601) | Yes | UTC timestamp of request completion |

### 3.3 Saved Request Schema

```jsonc
// edog-api-saved — Array, ordered by display position
[
  {
    "id": "f1e2d3c4-...",          // crypto.randomUUID()
    "name": "List Workspaces",     // User-visible name
    "group": "Fabric",             // Group/category key
    "method": "GET",
    "url": "https://api.fabric.microsoft.com/v1/workspaces",
    "headers": [
      { "key": "Authorization", "value": "{{bearerToken}}" }
    ],
    "body": null,
    "isBuiltIn": true              // true = from endpoint catalog, false = user-created
  }
]
```

**Field constraints:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `id` | string (UUID) | Yes | `crypto.randomUUID()` |
| `name` | string | Yes | 1–80 chars. Unique within group. |
| `group` | string | Yes | One of: "Fabric", "FLT", "Maintenance", "Custom" |
| `method` | string | Yes | One of: GET, POST, PUT, PATCH, DELETE |
| `url` | string | Yes | May contain template vars like `{{workspaceId}}` |
| `headers` | array | Yes | Array of `{ key, value }`. Values may use `{{varName}}`. |
| `body` | string \| null | Yes | May contain template vars |
| `isBuiltIn` | boolean | Yes | `true` for catalog entries, `false` for user-created |

### 3.4 Sidebar State Schema

```jsonc
// edog-api-sidebar-state
{
  "collapsed": false,                    // sidebar collapsed?
  "historySectionExpanded": true,        // history section open?
  "savedSectionExpanded": true,          // saved section open?
  "groupsExpanded": {                    // per-group collapsed state
    "Fabric": true,
    "FLT": true,
    "Maintenance": false,
    "Custom": true
  },
  "historyFilter": "ALL"                // current method filter
}
```

### 3.5 Groups (Canonical Order)

| # | Group Key | Display Label | Source |
|---|-----------|---------------|--------|
| 1 | `Fabric` | Fabric | Built-in catalog |
| 2 | `FLT` | FLT | Built-in catalog |
| 3 | `Maintenance` | Maintenance | Built-in catalog |
| 4 | `Custom` | Custom | User-created only |

Groups are always rendered in this order. Custom is always last.

---

## 4. DOM Structure

### 4.1 Sidebar Container

```html
<aside class="api-sidebar" role="complementary" aria-label="History and Saved Requests"
       data-collapsed="false">

  <!-- Collapse toggle (visible in both states) -->
  <button class="api-sidebar-toggle" aria-label="Collapse sidebar" aria-expanded="true"
          title="Toggle sidebar (Ctrl+H)">
    <span class="toggle-icon">◀</span>
  </button>

  <!-- Scrollable content wrapper (hidden when collapsed) -->
  <div class="api-sidebar-content">

    <!-- ── History Section ── -->
    <section class="api-sidebar-section api-history-section" aria-labelledby="history-heading">
      <header class="api-sidebar-header">
        <button class="api-section-toggle" aria-expanded="true" aria-controls="history-list">
          <span class="section-chevron">▾</span>
          <h3 class="api-sidebar-title" id="history-heading">History</h3>
          <span class="api-history-count" aria-label="3 entries">3</span>
        </button>
        <button class="api-history-clear" aria-label="Clear all history"
                title="Clear history">Clear</button>
      </header>

      <!-- Filter bar -->
      <div class="api-history-filter" role="toolbar" aria-label="Filter history">
        <select class="api-history-filter-select" aria-label="Filter by HTTP method">
          <option value="ALL">All Methods</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>
      </div>

      <!-- History list -->
      <ul id="history-list" class="api-history-list" role="listbox"
          aria-label="Request history" tabindex="0">

        <li class="api-history-item" role="option" aria-selected="false"
            data-id="a1b2c3d4-..." tabindex="-1">
          <div class="history-item-row1">
            <span class="method-pill method-get" aria-label="GET method">GET</span>
            <span class="history-url" title="https://api.fabric.microsoft.com/v1/workspaces">
              /v1/workspaces
            </span>
            <span class="history-status s2xx" aria-label="Status 200 OK">200</span>
          </div>
          <div class="history-item-row2">
            <span class="history-duration">342ms</span>
            <span class="history-sep" aria-hidden="true"> · </span>
            <time class="history-time" datetime="2026-04-14T10:30:00Z"
                  aria-label="April 14, 2026, 10:30 AM">2m ago</time>
            <div class="history-actions">
              <button class="history-save-btn" aria-label="Save this request"
                      title="Save as named request">★</button>
              <button class="history-more-btn" aria-label="More actions"
                      aria-haspopup="menu" title="More actions">⋯</button>
            </div>
          </div>
        </li>

        <!-- ... more items ... -->
      </ul>
    </section>

    <!-- ── Saved Requests Section ── -->
    <section class="api-sidebar-section api-saved-section" aria-labelledby="saved-heading">
      <header class="api-sidebar-header">
        <button class="api-section-toggle" aria-expanded="true" aria-controls="saved-list">
          <span class="section-chevron">▾</span>
          <h3 class="api-sidebar-title" id="saved-heading">Saved Requests</h3>
        </button>
        <button class="api-saved-add" aria-label="Save current request"
                title="Save current request">+ Save</button>
      </header>

      <!-- Saved list with groups -->
      <div id="saved-list" class="api-saved-list">

        <!-- Group: Fabric -->
        <div class="api-saved-group" data-group="Fabric">
          <button class="api-saved-group-toggle" aria-expanded="true"
                  aria-controls="saved-group-fabric">
            <span class="section-chevron">▾</span>
            <span class="api-sidebar-group-label">Fabric</span>
            <span class="api-group-count">4</span>
          </button>
          <ul id="saved-group-fabric" class="api-saved-group-items" role="listbox"
              aria-label="Fabric saved requests">
            <li class="api-saved-item" role="option" data-id="f1e2d3c4-..."
                tabindex="-1">
              <span class="method-pill method-get">GET</span>
              <span class="saved-name" title="List Workspaces">List Workspaces</span>
              <span class="saved-builtin" aria-label="Built-in request">◆</span>
              <button class="saved-more-btn" aria-label="More actions for List Workspaces"
                      aria-haspopup="menu">⋯</button>
            </li>
            <!-- ... more items ... -->
          </ul>
        </div>

        <!-- ... more groups ... -->
      </div>
    </section>

  </div>
</aside>
```

### 4.2 Class Name Index

| Class | Element | Purpose |
|-------|---------|---------|
| `.api-sidebar` | `<aside>` | Root sidebar container |
| `.api-sidebar[data-collapsed="true"]` | `<aside>` | Collapsed state |
| `.api-sidebar-toggle` | `<button>` | Collapse/expand toggle |
| `.api-sidebar-content` | `<div>` | Scrollable content wrapper |
| `.api-sidebar-section` | `<section>` | History or Saved section |
| `.api-sidebar-header` | `<header>` | Section header bar |
| `.api-section-toggle` | `<button>` | Section collapse toggle |
| `.api-sidebar-title` | `<h3>` | Section title (HISTORY / SAVED REQUESTS) |
| `.api-history-list` | `<ul>` | History entries container |
| `.api-history-item` | `<li>` | Single history entry |
| `.api-history-item.selected` | `<li>` | Currently-loaded history entry |
| `.method-pill` | `<span>` | Method badge (GET/POST/...) |
| `.method-get` | `.method-pill` | Green GET badge |
| `.method-post` | `.method-pill` | Blue POST badge |
| `.method-put` | `.method-pill` | Orange PUT badge |
| `.method-patch` | `.method-pill` | Yellow PATCH badge |
| `.method-delete` | `.method-pill` | Red DELETE badge |
| `.history-url` | `<span>` | Truncated URL text |
| `.history-status` | `<span>` | Status code badge |
| `.history-status.s2xx` | `<span>` | Green success status |
| `.history-status.s4xx` | `<span>` | Amber client error status |
| `.history-status.s5xx` | `<span>` | Red server error status |
| `.history-duration` | `<span>` | Duration text |
| `.history-time` | `<time>` | Relative timestamp |
| `.history-actions` | `<div>` | Hover-revealed action buttons |
| `.history-save-btn` | `<button>` | Save star button |
| `.history-more-btn` | `<button>` | More actions (⋯) button |
| `.api-saved-list` | `<div>` | Saved requests container |
| `.api-saved-group` | `<div>` | Group container |
| `.api-saved-group-toggle` | `<button>` | Group collapse toggle |
| `.api-saved-group-items` | `<ul>` | Group's request list |
| `.api-saved-item` | `<li>` | Single saved request entry |
| `.saved-name` | `<span>` | Request display name |
| `.saved-builtin` | `<span>` | Built-in indicator (◆) |
| `.saved-more-btn` | `<button>` | More actions for saved entry |
| `.api-history-filter` | `<div>` | Filter toolbar |
| `.api-history-filter-select` | `<select>` | Method filter dropdown |
| `.api-history-count` | `<span>` | Entry count badge |
| `.api-group-count` | `<span>` | Group item count |
| `.api-history-clear` | `<button>` | Clear history button |
| `.api-saved-add` | `<button>` | Add/save button |

---

## 5. CSS Specification

### 5.1 Sidebar Layout

```css
/* ── Sidebar Container ── */
.api-sidebar {
  width: 280px;
  min-width: 280px;
  border-left: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width var(--transition-normal), min-width var(--transition-normal);
  position: relative;
}

.api-sidebar[data-collapsed="true"] {
  width: 36px;
  min-width: 36px;
}

.api-sidebar[data-collapsed="true"] .api-sidebar-content {
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
}

.api-sidebar-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  opacity: 1;
  transition: opacity var(--transition-fast);
}

/* Thin scrollbar */
.api-sidebar-content::-webkit-scrollbar { width: 4px; }
.api-sidebar-content::-webkit-scrollbar-track { background: transparent; }
.api-sidebar-content::-webkit-scrollbar-thumb {
  background: var(--border-bright);
  border-radius: var(--radius-full);
}
```

### 5.2 Sidebar Toggle

```css
.api-sidebar-toggle {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  z-index: 1;
  font-size: var(--text-xs);
  transition: color var(--transition-fast), background var(--transition-fast);
}

.api-sidebar-toggle:hover {
  color: var(--text);
  background: var(--surface-2);
}

.api-sidebar[data-collapsed="true"] .api-sidebar-toggle {
  left: 50%;
  transform: translateX(-50%);
  top: 50%;
  margin-top: -12px;
}

.api-sidebar[data-collapsed="true"] .toggle-icon {
  transform: rotate(180deg);   /* ◀ becomes ▶ */
}
```

### 5.3 Section Headers

```css
.api-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  padding-left: 36px;              /* leave room for sidebar toggle on first section */
  border-bottom: 1px solid var(--border);
  min-height: 36px;
}

.api-saved-section .api-sidebar-header {
  padding-left: var(--space-3);    /* no toggle offset on second section */
}

.api-section-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0;
}

.api-section-toggle:hover { color: var(--text); }

.api-sidebar-title {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0;
  line-height: 1;
}

.section-chevron {
  font-size: var(--text-xs);
  transition: transform var(--transition-fast);
  display: inline-block;
}

.api-section-toggle[aria-expanded="false"] .section-chevron {
  transform: rotate(-90deg);       /* ▾ becomes ▸ */
}

.api-history-count, .api-group-count {
  font-size: 9px;
  color: var(--text-muted);
  background: var(--surface-3);
  padding: 0 var(--space-1);
  border-radius: var(--radius-full);
  min-width: 16px;
  text-align: center;
  line-height: 16px;
  font-weight: 500;
  font-family: var(--font-mono);
}

.api-history-clear, .api-saved-add {
  font-size: var(--text-xs);
  color: var(--text-muted);
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  transition: color var(--transition-fast), background var(--transition-fast);
}

.api-history-clear:hover { color: var(--level-error); background: var(--row-error-tint); }
.api-saved-add:hover { color: var(--accent); background: var(--accent-dim); }
```

### 5.4 Method Pills

```css
.method-pill {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  padding: 1px var(--space-1);
  border-radius: 2px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  line-height: 14px;
  min-width: 32px;
  text-align: center;
  flex-shrink: 0;
}

/* Method color map — backgrounds use 12% opacity, text uses full color */
.method-get    { background: rgba(24, 160, 88, 0.12);  color: var(--status-succeeded); }
.method-post   { background: rgba(45, 127, 249, 0.12); color: var(--level-message); }
.method-put    { background: rgba(229, 148, 12, 0.12); color: var(--level-warning); }
.method-patch  { background: rgba(229, 148, 12, 0.08); color: var(--level-warning); }
.method-delete { background: rgba(229, 69, 59, 0.12);  color: var(--level-error); }
```

### 5.5 History Entry

```css
.api-history-list {
  list-style: none;
  padding: var(--space-1) 0;
  margin: 0;
}

.api-history-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.api-history-item:hover {
  background: var(--surface-2);
}

.api-history-item.selected {
  background: var(--accent-dim);
  border-left-color: var(--accent);
}

.api-history-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  border-radius: var(--radius-sm);
}

.history-item-row1 {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 18px;
}

.history-url {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.history-status {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
  flex-shrink: 0;
  min-width: 28px;
  text-align: right;
}

.history-status.s2xx { color: var(--status-succeeded); }
.history-status.s4xx { color: var(--level-warning); }
.history-status.s5xx { color: var(--level-error); }

.history-item-row2 {
  display: flex;
  align-items: center;
  gap: 0;
  font-size: 9px;
  color: var(--text-muted);
  min-height: 16px;
}

.history-duration {
  font-family: var(--font-mono);
}

.history-sep {
  margin: 0 var(--space-1);
}

.history-time {
  font-family: var(--font-body);
}

.history-actions {
  margin-left: auto;
  display: flex;
  gap: var(--space-1);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.api-history-item:hover .history-actions,
.api-history-item:focus-within .history-actions {
  opacity: 1;
}

.history-save-btn, .history-more-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: var(--text-xs);
  padding: 2px var(--space-1);
  border-radius: var(--radius-sm);
  line-height: 1;
}

.history-save-btn:hover { color: var(--level-warning); }
.history-more-btn:hover { color: var(--text); background: var(--surface-3); }
```

### 5.6 Filter Bar

```css
.api-history-filter {
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border);
}

.api-history-filter-select {
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  cursor: pointer;
}

.api-history-filter-select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--shadow-glow);
}
```

### 5.7 Saved Request Items

```css
.api-saved-group {
  border-bottom: 1px solid var(--border);
}

.api-saved-group:last-child {
  border-bottom: none;
}

.api-saved-group-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--font-body);
}

.api-sidebar-group-label {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-weight: 500;
  flex: 1;
  text-align: left;
}

.api-saved-group-items {
  list-style: none;
  padding: 0 0 var(--space-1) 0;
  margin: 0;
}

.api-saved-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  padding-left: var(--space-6);         /* indented under group header */
  cursor: pointer;
  border-radius: 0;
  transition: background var(--transition-fast);
}

.api-saved-item:hover {
  background: var(--surface-2);
}

.api-saved-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.saved-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--text);
}

.saved-builtin {
  font-size: 8px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.saved-more-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: var(--text-xs);
  padding: 2px var(--space-1);
  border-radius: var(--radius-sm);
  line-height: 1;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.api-saved-item:hover .saved-more-btn,
.api-saved-item:focus-within .saved-more-btn {
  opacity: 1;
}

.saved-more-btn:hover { color: var(--text); background: var(--surface-3); }
```

### 5.8 Context Menu (Shared)

```css
.api-context-menu {
  position: fixed;
  z-index: var(--z-dropdown);
  min-width: 160px;
  padding: var(--space-1) 0;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  font-family: var(--font-body);
}

.api-context-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  color: var(--text);
  cursor: pointer;
  background: none;
  border: none;
  width: 100%;
  text-align: left;
  transition: background var(--transition-fast);
}

.api-context-menu-item:hover {
  background: var(--accent-dim);
}

.api-context-menu-item.destructive {
  color: var(--level-error);
}

.api-context-menu-item.destructive:hover {
  background: var(--row-error-tint);
}

.api-context-menu-sep {
  height: 1px;
  background: var(--border);
  margin: var(--space-1) 0;
}
```

### 5.9 Empty States

```css
.api-sidebar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  text-align: center;
}

.api-sidebar-empty-icon {
  font-size: 24px;
  color: var(--text-muted);
  opacity: 0.5;
}

.api-sidebar-empty-text {
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: 1.5;
}
```

### 5.10 Save Dialog (Inline)

```css
.api-save-dialog {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.api-save-dialog-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.api-save-dialog-input {
  flex: 1;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-size: var(--text-xs);
  font-family: var(--font-body);
}

.api-save-dialog-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--shadow-glow);
}

.api-save-dialog-group {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-dim);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  min-width: 90px;
}

.api-save-dialog-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.api-save-dialog-cancel, .api-save-dialog-confirm {
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  cursor: pointer;
}

.api-save-dialog-cancel {
  background: none;
  color: var(--text-muted);
}

.api-save-dialog-confirm {
  background: var(--accent);
  color: var(--text-on-accent);
}

.api-save-dialog-confirm:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

---

## 6. History Behavior

### 6.1 Auto-Recording

Every completed request from the Request Builder is automatically added to history.

**Trigger:** The parent `ApiPlayground` class fires a `request-completed` event after every send.

**Recording flow:**

| Step | Action |
|------|--------|
| 1 | `ApiPlayground.send()` completes (success or error response) |
| 2 | `ApiPlayground` emits `request-completed` with `{ method, url, headers, body, response }` |
| 3 | `HistorySidebar.onRequestCompleted(event)` receives the event |
| 4 | Construct history entry with `crypto.randomUUID()`, current timestamp |
| 5 | Truncate `response.body` to 500 chars → `bodyPreview` |
| 6 | Prepend to history array (newest first) |
| 7 | If array length > 50, pop the oldest entry (circular buffer) |
| 8 | Write to `localStorage.setItem('edog-api-history', JSON.stringify(array))` |
| 9 | Render new entry at top of list with slide-in animation (150ms ease-out) |

**What is NOT recorded:**

- Requests that fail to send (network error before any response). These show a toast but are not history entries.
- Requests while the Send button is still in loading state (debounce — can't double-send).

### 6.2 Circular Buffer

| Property | Value |
|----------|-------|
| Max entries | 50 |
| Eviction | Oldest first (FIFO) |
| Implementation | `if (history.length > 50) history.pop()` after each prepend |
| Storage key | `edog-api-history` |

**Buffer full indicator:** None. Silently evicts. The user sees only the most recent 50.

### 6.3 Click to Replay

Clicking a history entry re-populates the Request Builder with that request's data.

| Step | Action |
|------|--------|
| 1 | User clicks history entry |
| 2 | Entry gets `.selected` class (accent left border + dim accent background) |
| 3 | Previously selected entry loses `.selected` |
| 4 | Emit `replay-request` event with `{ method, url, headers, body }` from the history entry |
| 5 | Request Builder receives event and populates: method dropdown, URL input, headers table, body textarea |
| 6 | Response Viewer is NOT updated (the old response is stale — user must re-send) |
| 7 | Focus moves to the Send button |

**Double-click:** Same as click + auto-send. The request is immediately re-executed.

### 6.4 Save from History

Clicking the ★ button on a history entry opens the inline save dialog.

| Step | Action |
|------|--------|
| 1 | User clicks ★ on a history entry |
| 2 | Save dialog slides open below the section header |
| 3 | Name field auto-populated: URL's last path segment, title-cased (e.g. "/v1/workspaces" → "Workspaces") |
| 4 | Group defaults to "Custom" |
| 5 | User edits name, selects group, clicks "Save" |
| 6 | Validate: name is non-empty, 1–80 chars |
| 7 | Create saved request entry from history data (method, URL, headers, body) |
| 8 | `isBuiltIn: false` |
| 9 | Append to the selected group in `edog-api-saved` |
| 10 | Write to localStorage |
| 11 | Close save dialog, render new entry in saved list |
| 12 | Toast: "Saved as '{name}'" (2s auto-dismiss) |

### 6.5 Clear History

| Step | Action |
|------|--------|
| 1 | User clicks "Clear" button in history header |
| 2 | Confirmation: inline prompt replaces the history list: "Clear all history? This cannot be undone." with [Cancel] [Clear] buttons |
| 3 | User clicks "Clear" |
| 4 | `localStorage.removeItem('edog-api-history')` |
| 5 | In-memory array set to `[]` |
| 6 | Render empty state |
| 7 | Confirmation prompt dismissed |

**Cancel:** Returns to normal history list. No changes.

### 6.6 Relative Time Formatting

| Age | Format | Example |
|-----|--------|---------|
| < 60s | "just now" | "just now" |
| < 60min | "{N}m ago" | "12m ago" |
| < 24h | "{N}h ago" | "3h ago" |
| < 7d | "{N}d ago" | "2d ago" |
| >= 7d | Short date | "Apr 7" |
| >= 1y | Date with year | "Dec 3, 2025" |

**Refresh:** Relative times update every 30s via a single `setInterval` that batch-updates all visible `<time>` elements. Uses `requestAnimationFrame` to coalesce DOM writes.

### 6.7 Duration Formatting

| Duration (ms) | Format | Example |
|---------------|--------|---------|
| < 1000 | `{N}ms` | "342ms" |
| 1000–59999 | `{s.d}s` | "1.2s" |
| 60000+ | `{m}m {s}s` | "2m 7s" |

### 6.8 Status Code Classification

| Range | CSS Class | Color Variable | Visual |
|-------|-----------|----------------|--------|
| 200–299 | `.s2xx` | `--status-succeeded` (green) | Green text |
| 300–399 | `.s3xx` | `--level-message` (blue) | Blue text |
| 400–499 | `.s4xx` | `--level-warning` (amber) | Amber text |
| 500–599 | `.s5xx` | `--level-error` (red) | Red text |

### 6.9 New Entry Animation

When a new history entry is added:

1. Entry element created with `height: 0; opacity: 0; overflow: hidden`
2. On next frame: `height: auto; opacity: 1` with `transition: height 150ms ease-out, opacity 150ms ease-out`
3. If the list is scrolled away from the top, a "New request ▲" pill appears pinned at the top of the list. Clicking it scrolls to top.

---

## 7. Saved Requests Behavior

### 7.1 Built-in Requests

On first load (no `edog-api-saved` in localStorage), the sidebar initializes with built-in requests sourced from the endpoint catalog.

**Initialization flow:**

| Step | Action |
|------|--------|
| 1 | Check `localStorage.getItem('edog-api-saved')` |
| 2 | If null: load built-in catalog from `BUILTIN_ENDPOINTS` constant |
| 3 | Generate UUIDs for each, set `isBuiltIn: true` |
| 4 | Write to localStorage |
| 5 | On subsequent loads: read from localStorage (user may have modified order or added custom) |

**Built-in entries cannot be deleted or renamed.** The ⋯ menu for built-in entries shows only:
- Copy as cURL
- Duplicate (creates a custom copy)

### 7.2 Built-in Endpoint Catalog

| Group | # | Method | Name | URL Pattern |
|-------|---|--------|------|-------------|
| Fabric | 1 | GET | List Workspaces | `/v1/workspaces` |
| Fabric | 2 | GET | Get Workspace | `/v1/workspaces/{{workspaceId}}` |
| Fabric | 3 | GET | List Lakehouses | `/v1/workspaces/{{workspaceId}}/lakehouses` |
| Fabric | 4 | GET | Get Lakehouse | `/v1/workspaces/{{workspaceId}}/lakehouses/{{artifactId}}` |
| FLT | 1 | GET | Get Config | `/api/flt/config` |
| FLT | 2 | POST | Run DAG | `/v1/workspaces/{{workspaceId}}/lakehouses/{{artifactId}}/liveTable/runDAG` |
| FLT | 3 | GET | DAG Status | `/v1/workspaces/{{workspaceId}}/lakehouses/{{artifactId}}/liveTable/getDAGExecutionStatus` |
| FLT | 4 | GET | List Iterations | `/v1/workspaces/{{workspaceId}}/lakehouses/{{artifactId}}/liveTable/listDAGExecutionIterationIds` |
| FLT | 5 | GET | Execution Metrics | `/v1/workspaces/{{workspaceId}}/lakehouses/{{artifactId}}/liveTable/getDAGExecMetrics/{{iterationId}}` |
| FLT | 6 | POST | Cancel Execution | `/v1/workspaces/{{workspaceId}}/lakehouses/{{artifactId}}/liveTable/cancelDAGExecution` |
| Maintenance | 1 | POST | Clear Cache | `/v1/workspaces/{{workspaceId}}/lakehouses/{{artifactId}}/liveTable/clearMLVCache` |
| Maintenance | 2 | GET | Health Check | `/api/edog/health` |

**Template variables** (e.g. `{{workspaceId}}`) are resolved at send time from the current FLT config (`/api/flt/config` response).

### 7.3 Create (Save New Request)

Two entry points:

**A. "Save" from history** (§6.4 above)

**B. "+ Save" button in saved section header:**

| Step | Action |
|------|--------|
| 1 | User clicks "+ Save" |
| 2 | Save dialog opens at top of saved section |
| 3 | Name and Group fields are empty/default |
| 4 | Current Request Builder state (method, URL, headers, body) is captured |
| 5 | User enters name, selects group (dropdown: Fabric, FLT, Maintenance, Custom) |
| 6 | User clicks "Save" |
| 7 | Validate name: non-empty, 1–80 chars |
| 8 | Create entry with `isBuiltIn: false` |
| 9 | Append to selected group |
| 10 | Write to localStorage |
| 11 | Render in group, close dialog |

### 7.4 Click to Load

Clicking a saved request populates the Request Builder.

| Step | Action |
|------|--------|
| 1 | User clicks a saved request entry |
| 2 | Emit `load-saved-request` event with `{ method, url, headers, body }` |
| 3 | Request Builder populates all fields |
| 4 | Template variables in URL/headers/body remain as `{{varName}}` — they are resolved at send time |
| 5 | Focus moves to the URL input (user may want to edit before sending) |

### 7.5 Edit Name (Custom Only)

| Step | Action |
|------|--------|
| 1 | User clicks ⋯ → "Rename" on a custom saved entry |
| 2 | Name text becomes an editable input field (inline edit) |
| 3 | Input pre-populated with current name, text selected |
| 4 | `Enter` or blur: save new name |
| 5 | `Escape`: cancel edit, revert to original name |
| 6 | Validate: non-empty, 1–80 chars |
| 7 | Update entry in `edog-api-saved`, write to localStorage |

### 7.6 Delete (Custom Only)

| Step | Action |
|------|--------|
| 1 | User clicks ⋯ → "Delete" on a custom saved entry |
| 2 | Confirmation: entry text turns red, "Delete?" prompt appears inline with [Cancel] [Delete] |
| 3 | User clicks "Delete" |
| 4 | Remove entry from array |
| 5 | Write to localStorage |
| 6 | Entry slides out (150ms ease-in animation) |
| 7 | If group is now empty, show group empty state |

### 7.7 Duplicate

Available for both built-in and custom entries.

| Step | Action |
|------|--------|
| 1 | User clicks ⋯ → "Duplicate" |
| 2 | Create new entry with `name: "{original} (copy)"`, `group: "Custom"`, `isBuiltIn: false` |
| 3 | Copy method, URL, headers, body from original |
| 4 | Append to Custom group |
| 5 | Write to localStorage |
| 6 | Scroll to the new entry, briefly highlight it (accent background pulse, 1s) |

### 7.8 Group Collapse/Expand

Each group header is a toggle button.

- Click group header → toggle `aria-expanded` on the button
- Collapsed: `<ul>` is hidden (`display: none` — no animation, instant)
- Expanded: `<ul>` is visible
- State persisted in `edog-api-sidebar-state.groupsExpanded`

### 7.9 Drag to Reorder (V2)

**Not in V1.** Marked for V2 implementation. Custom entries within a group can be reordered by drag-and-drop. Built-in entries maintain their catalog order and cannot be reordered.

---

## 8. Sidebar Toggle

### 8.1 Toggle Behavior

| Action | Result |
|--------|--------|
| Click toggle button (◀/▶) | Collapse or expand sidebar |
| `Ctrl+H` (keyboard shortcut) | Toggle sidebar |
| Collapse | Width animates 280px → 36px (150ms ease-out) |
| Expand | Width animates 36px → 280px (150ms ease-out) |

### 8.2 Animation Sequence

**Collapse:**

| Time | Action |
|------|--------|
| 0ms | Set `data-collapsed="true"` on `.api-sidebar` |
| 0ms | Content `opacity: 0` (instant via CSS transition) |
| 0–150ms | Width transitions 280px → 36px |
| 150ms | Content `pointer-events: none` (prevents interaction with invisible content) |
| 150ms | Toggle icon becomes ▶ (via CSS `transform: rotate(180deg)`) |
| 150ms | Toggle `aria-expanded="false"`, `aria-label="Expand sidebar"` |

**Expand:**

| Time | Action |
|------|--------|
| 0ms | Set `data-collapsed="false"` on `.api-sidebar` |
| 0ms | Content `pointer-events: auto` |
| 0–150ms | Width transitions 36px → 280px |
| 80ms | Content `opacity: 1` (starts fading in halfway through expand) |
| 150ms | Toggle icon becomes ◀ |
| 150ms | Toggle `aria-expanded="true"`, `aria-label="Collapse sidebar"` |
| 150ms | Focus returns to previously focused element inside sidebar, or first item |

### 8.3 State Persistence

Collapse state is stored in `edog-api-sidebar-state.collapsed`. On page load:
- Read state from localStorage
- If `collapsed === true`, render in collapsed state immediately (no animation on load)
- Default: expanded (`collapsed: false`)

### 8.4 Keyboard Shortcut

| Shortcut | Action | Context |
|----------|--------|---------|
| `Ctrl+H` | Toggle sidebar collapse/expand | API Playground tab active |

**Registration:** The shortcut is registered when the API Playground tab becomes active and unregistered when the user switches to another tab. This prevents conflicts with browser `Ctrl+H` (history) — the playground intercepts only when active.

---

## 9. Search/Filter

### 9.1 Method Filter

The filter dropdown in the history section filters visible entries by HTTP method.

| Value | Behavior |
|-------|----------|
| `ALL` | Show all entries (default) |
| `GET` | Show only GET requests |
| `POST` | Show only POST requests |
| `PUT` | Show only PUT requests |
| `PATCH` | Show only PATCH requests |
| `DELETE` | Show only DELETE requests |

**Implementation:** Client-side filter. All 50 entries remain in memory and localStorage. Filter toggles `display: none` on non-matching `<li>` elements.

### 9.2 Filter Persistence

The active filter is stored in `edog-api-sidebar-state.historyFilter`. On page load, the filter is restored.

### 9.3 URL Text Filter (V1.1)

A text input above the method filter allows typing to filter by URL substring.

```
┌─────────────────────────────────┐
│ [🔍 Filter requests...       ] │ ← Text input
│ [All Methods ▾]                 │ ← Method dropdown
├─────────────────────────────────┤
│ (filtered results)              │
└─────────────────────────────────┘
```

- **Debounce:** 200ms after last keystroke before filtering
- **Match:** Case-insensitive substring match against `entry.url`
- **Combined:** Both text filter AND method filter apply (logical AND)
- **Clear:** ✕ button inside the input clears the text filter

### 9.4 Status Filter (V1.1)

An additional dropdown or pill bar to filter by status code range:

| Option | Matches |
|--------|---------|
| All | No filter |
| Success (2xx) | 200–299 |
| Client Error (4xx) | 400–499 |
| Server Error (5xx) | 500–599 |

**V1 scope:** Only method filter is in V1. Text and status filters are V1.1.

### 9.5 Empty Filter Results

When filters produce zero matches:

```
┌─────────────────────────────────┐
│                                 │
│       No matching requests      │
│                                 │
│   Try a different filter.       │
│                                 │
│          [Clear Filter]         │
│                                 │
└─────────────────────────────────┘
```

"Clear Filter" resets method dropdown to "All Methods" and clears any text filter.

---

## 10. Context Menu

### 10.1 History Entry Context Menu

Right-clicking a history entry (or clicking the ⋯ button) opens a context menu:

| # | Label | Icon | Action |
|---|-------|------|--------|
| 1 | Copy as cURL | — | Generate cURL command, copy to clipboard |
| 2 | Copy URL | — | Copy the full URL to clipboard |
| 3 | — | — | Separator |
| 4 | Save As... | ★ | Open save dialog with this request's data |
| 5 | — | — | Separator |
| 6 | Delete | — | Remove this single entry from history |

### 10.2 Saved Request Context Menu — Custom

| # | Label | Icon | Action |
|---|-------|------|--------|
| 1 | Copy as cURL | — | Generate cURL command, copy to clipboard |
| 2 | Copy URL | — | Copy the full URL to clipboard |
| 3 | — | — | Separator |
| 4 | Rename | — | Inline rename (§7.5) |
| 5 | Duplicate | — | Create copy in Custom group (§7.7) |
| 6 | — | — | Separator |
| 7 | Delete | — | Remove with confirmation (§7.6). Destructive style. |

### 10.3 Saved Request Context Menu — Built-in

| # | Label | Icon | Action |
|---|-------|------|--------|
| 1 | Copy as cURL | — | Generate cURL command, copy to clipboard |
| 2 | Copy URL | — | Copy the full URL to clipboard |
| 3 | — | — | Separator |
| 4 | Duplicate | — | Create editable copy in Custom group |

**No rename or delete for built-in entries.**

### 10.4 Copy as cURL Generation

```
curl -X {METHOD} '{URL}' \
  -H '{Header-Key}: {Header-Value}' \
  -H '{Header-Key}: {Header-Value}' \
  -d '{body}'
```

**Rules:**
- Method: `-X GET` (omitted for GET if no body), `-X POST`, etc.
- URL: single-quoted
- Each header: separate `-H` flag, single-quoted
- Body: `-d` flag with single-quoted body. Omitted if body is null/empty.
- Template variables (in saved requests): left as `{{varName}}` — user replaces manually
- Single quotes in values: escaped as `'\''`
- Line continuations: ` \` on each line except last

**Clipboard feedback:** After copy, the ⋯ button briefly shows a checkmark (200ms), then reverts.

### 10.5 Context Menu Positioning

- Opens at the cursor position (right-click) or anchored below the ⋯ button (click)
- If menu would overflow below viewport: open upward
- If menu would overflow right: shift left
- Closes on: click outside, `Escape`, scroll, another context menu opening

### 10.6 Context Menu DOM

```html
<div class="api-context-menu" role="menu" aria-label="History entry actions">
  <button class="api-context-menu-item" role="menuitem">Copy as cURL</button>
  <button class="api-context-menu-item" role="menuitem">Copy URL</button>
  <div class="api-context-menu-sep" role="separator"></div>
  <button class="api-context-menu-item" role="menuitem">Save As...</button>
  <div class="api-context-menu-sep" role="separator"></div>
  <button class="api-context-menu-item destructive" role="menuitem">Delete</button>
</div>
```

---

## 11. Empty States

### 11.1 No History Yet

Shown when `edog-api-history` is empty or missing.

```
┌─────────────────────────────────┐
│                                 │
│           ○ (muted)             │
│                                 │
│     No requests yet             │
│                                 │
│   Send a request to see it      │
│   appear here.                  │
│                                 │
└─────────────────────────────────┘
```

**DOM:**

```html
<div class="api-sidebar-empty" role="status">
  <span class="api-sidebar-empty-icon" aria-hidden="true">○</span>
  <span class="api-sidebar-empty-text">
    No requests yet<br>
    Send a request to see it appear here.
  </span>
</div>
```

**Behavior:** As soon as the first request completes, the empty state is replaced with the first history entry (slide-in animation).

### 11.2 No Saved Requests

Shown only if the built-in catalog somehow fails to load AND no user-saved requests exist. This should be extremely rare.

```
┌─────────────────────────────────┐
│                                 │
│           ◇ (muted)             │
│                                 │
│   No saved requests             │
│                                 │
│   Click "+ Save" or save from   │
│   history to add requests.      │
│                                 │
└─────────────────────────────────┘
```

### 11.3 Empty Group

When a group has zero entries (only possible for "Custom" in normal usage):

```
│  ▸ Custom (0)                   │
│    No custom requests yet       │ ← Muted text, indented
```

**DOM:**

```html
<li class="api-saved-empty" aria-label="No custom requests">
  <span class="api-sidebar-empty-text">No custom requests yet</span>
</li>
```

### 11.4 Filter Yields No Results

See §9.5 above.

---

## 12. Storage Management

### 12.1 localStorage Size Monitoring

| Metric | Threshold | Action |
|--------|-----------|--------|
| Total `edog-api-history` size | > 400KB | Reduce `bodyPreview` length to 200 chars on oldest 25 entries |
| Total `edog-api-history` size | > 450KB | Evict oldest entries until under 400KB |
| `edog-api-saved` size | > 80KB | Warning log to console (should never happen with normal use) |
| localStorage quota exceeded | `QuotaExceededError` | Evict oldest 10 history entries, retry write |

### 12.2 Write Error Handling

```javascript
try {
  localStorage.setItem('edog-api-history', JSON.stringify(history));
} catch (e) {
  if (e instanceof DOMException && e.name === 'QuotaExceededError') {
    // Evict oldest 10 entries
    history.splice(-10);
    // Retry
    try {
      localStorage.setItem('edog-api-history', JSON.stringify(history));
    } catch (e2) {
      // Give up — keep in-memory only, warn user
      console.warn('[API History] localStorage full. History will not persist.');
    }
  }
}
```

### 12.3 Data Validation on Load

On page load, validate localStorage data before using it:

| Check | Failure Action |
|-------|----------------|
| `JSON.parse` succeeds | If parse fails: reset to `[]` (history) or built-in catalog (saved) |
| Array type check | If not array: reset |
| Each entry has required fields (`id`, `method`, `url`) | Skip malformed entries, log warning |
| `method` is one of GET/POST/PUT/PATCH/DELETE | Skip entry |
| `timestamp` is valid ISO 8601 (history) | Default to current time |
| `response.status` is integer 100–599 (history) | Default to 0 |

**Never crash on corrupt localStorage.** Log a warning and recover gracefully.

### 12.4 Migration Strategy

If the schema changes in a future version:

1. Add a `version` field to the stored data wrapper:
   ```jsonc
   { "version": 1, "entries": [...] }
   ```
2. On load, check version. If missing or old, run migration function.
3. Migration functions are idempotent and forward-only.

**V1 note:** V1 stores as a bare array (no version wrapper). The first migration (when needed) will detect the bare array format and wrap it.

### 12.5 Body Preview Truncation

Response body previews are truncated to prevent localStorage bloat:

| Scenario | `bodyPreview` Length |
|----------|---------------------|
| Normal response | First 500 chars |
| Large response (> 500KB body) | First 200 chars |
| Binary response | `"(binary response, {N} bytes)"` |
| Empty response | `""` |

Truncation indicator: if truncated, append `"..."` to the preview string.

### 12.6 Sensitive Data

**Headers containing tokens (Authorization, Cookie, etc.) are stored in history.** This is acceptable because:
- EDOG Studio runs on localhost only
- Tokens are short-lived (5-minute expiry)
- Users can clear history at any time
- No data leaves the machine

A future enhancement could mask token values in stored history (e.g., `"Bearer eyJ...XXXX"`).

---

## 13. Accessibility

### 13.1 ARIA Roles and Landmarks

| Element | Role | ARIA Attributes |
|---------|------|-----------------|
| `.api-sidebar` | `complementary` | `aria-label="History and Saved Requests"` |
| `.api-sidebar-toggle` | (button) | `aria-label`, `aria-expanded` |
| `.api-section-toggle` | (button) | `aria-expanded`, `aria-controls` |
| `.api-history-list` | `listbox` | `aria-label="Request history"` |
| `.api-history-item` | `option` | `aria-selected`, `aria-label` (computed) |
| `.api-saved-group-items` | `listbox` | `aria-label="{Group} saved requests"` |
| `.api-saved-item` | `option` | `aria-label` (computed from method + name) |
| `.api-context-menu` | `menu` | `aria-label` |
| `.api-context-menu-item` | `menuitem` | — |
| `.api-context-menu-sep` | `separator` | — |
| `.api-history-filter` | `toolbar` | `aria-label="Filter history"` |
| `.api-sidebar-empty` | `status` | — (announced by screen readers) |

### 13.2 Computed ARIA Labels

History entries need meaningful labels for screen readers:

```javascript
// Example computed label
`GET /v1/workspaces, status 200, 342 milliseconds, 2 minutes ago`
```

Saved entries:

```javascript
// Example computed label
`GET List Workspaces, Fabric group, built-in`
```

### 13.3 Keyboard Navigation

| Shortcut | Context | Action |
|----------|---------|--------|
| `Tab` | Sidebar | Move between sidebar toggle, filter, history list, saved list |
| `↑` / `↓` | History list focused | Move focus between history entries |
| `↑` / `↓` | Saved list focused | Move focus between saved entries (within and across groups) |
| `Enter` | History entry focused | Load request into Request Builder |
| `Enter` | Saved entry focused | Load request into Request Builder |
| `Space` | History entry focused | Toggle entry selection (visual feedback only) |
| `Delete` | History entry focused | Remove entry (with confirmation) |
| `Escape` | Context menu open | Close context menu |
| `Escape` | Save dialog open | Close save dialog |
| `Escape` | Inline rename active | Cancel rename |
| `Ctrl+H` | API Playground active | Toggle sidebar |
| `Home` | List focused | Focus first entry |
| `End` | List focused | Focus last entry |

### 13.4 Focus Management

| Event | Focus Moves To |
|-------|---------------|
| Sidebar expands | First focusable element in sidebar (filter or first entry) |
| Sidebar collapses | Toggle button |
| Save dialog opens | Name input field |
| Save dialog closes | The ★ button that triggered it |
| Context menu opens | First menu item |
| Context menu closes | The ⋯ button that triggered it |
| Entry deleted | Next entry in list, or previous if last was deleted |
| Inline rename starts | The input field |
| Inline rename ends | The renamed entry |

### 13.5 Screen Reader Announcements

| Event | Announcement | Method |
|-------|-------------|--------|
| New history entry added | "New request recorded: {method} {url-tail}, status {code}" | `aria-live="polite"` region |
| History cleared | "History cleared" | `aria-live="polite"` |
| Request saved | "Request saved as {name}" | `aria-live="polite"` |
| Entry deleted | "{name} deleted" | `aria-live="polite"` |
| Filter changed | "{N} requests shown" | `aria-live="polite"` |
| Sidebar toggled | "Sidebar {expanded/collapsed}" | `aria-live="polite"` |
| Copy to clipboard | "Copied to clipboard" | `aria-live="assertive"` |

### 13.6 Color Contrast

All method pills and status badges meet WCAG AA contrast requirements (4.5:1 for normal text):

| Element | Foreground | Background | Ratio (Light) | Ratio (Dark) |
|---------|-----------|------------|---------------|--------------|
| GET pill | `--status-succeeded` #18a058 | 12% green tint | >4.5:1 | >4.5:1 |
| POST pill | `--level-message` #2d7ff9 | 12% blue tint | >4.5:1 | >4.5:1 |
| PUT pill | `--level-warning` #e5940c | 12% orange tint | >4.5:1 | >4.5:1 |
| DELETE pill | `--level-error` #e5453b | 12% red tint | >4.5:1 | >4.5:1 |
| Status 2xx | `--status-succeeded` | transparent | >4.5:1 on --surface | >4.5:1 on --surface |
| Status 4xx | `--level-warning` | transparent | >4.5:1 on --surface | >4.5:1 on --surface |
| Status 5xx | `--level-error` | transparent | >4.5:1 on --surface | >4.5:1 on --surface |

### 13.7 Motion Preferences

```css
@media (prefers-reduced-motion: reduce) {
  .api-sidebar,
  .api-sidebar-content,
  .api-history-item,
  .api-saved-item,
  .section-chevron,
  .toggle-icon {
    transition: none !important;
  }
}
```

All animations (slide-in, collapse, pulse) are disabled when the user has `prefers-reduced-motion: reduce` set. State changes still occur; only the visual transition is skipped.

---

## 14. Performance

| Metric | Target | Strategy |
|--------|--------|----------|
| Initial render (50 history + 14 saved) | < 50ms | Simple DOM creation, no virtual scroll needed |
| History entry render | < 1ms | Pre-built template, append to DOM |
| localStorage read | < 10ms | 50 entries ≈ 50KB JSON parse |
| localStorage write | < 10ms | Single `setItem` call |
| Filter toggle | < 5ms | `display: none` toggle, no re-render |
| Context menu open | < 16ms (1 frame) | Pre-built DOM, position calculation only |
| Sidebar collapse/expand | 150ms | CSS transition, no JS animation |
| Relative time refresh (30s interval) | < 5ms | Batch read of timestamps, batch write of `textContent` |

---

*"Every request ever made is one click from replay. Every endpoint worth remembering is already saved. The sidebar is the engineer's muscle memory, always there, never in the way."*
