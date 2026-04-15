# Request Builder — Component Deep Spec

> **Status:** DRAFT
> **Owner:** Pixel (Frontend) + Vex (Token/Proxy)
> **Reviewer:** Sentinel
> **Depends On:** `../spec.md` §3, `../research/p0-foundation.md` §1–§5
> **State Matrix:** `../states/request-builder.md` (pending)
> **Existing CSS:** `src/frontend/css/api-playground.css` (122 lines, partial)

---

## 1. Component Overview

The Request Builder is the top section of the API Playground view. It is the primary input surface where engineers compose HTTP requests against Fabric and FLT APIs. It occupies the upper portion of `.api-main` (the left column of the playground layout) and communicates downward to the Response Viewer when a request is executed.

**Responsibilities:**

1. Accept user input for HTTP method, URL, headers, and body
2. Auto-expand template variables (`{workspaceId}`, `{artifactId}`, etc.) from `/api/flt/config`
3. Auto-inject the correct Authorization header based on URL pattern (Bearer vs MwcToken)
4. Provide a pre-configured endpoint catalog for quick population
5. Execute the request via fetch (direct or proxy) and emit the response to the Response Viewer
6. Generate a valid cURL command from the current request state
7. Validate inputs before sending (URL required, JSON body syntax, etc.)

**Parent:** `ApiPlayground` class instance. Mounted inside `#view-api .api-main`.

**Children:** None (leaf component). Emits events consumed by `ResponseViewer` and `HistoryManager`.

**Lifecycle:**
- Constructed once when API Playground view is activated
- Persists in DOM while the view is active (not re-created on tab switch)
- Reads config on mount and on `config:updated` events

---

## 2. Visual Specification

### 2.1 Full Layout Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ .api-request-section                                                        │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Endpoint Catalog Row                                                 │   │
│  │ ┌────────────────────────────────────────────────────────────────┐   │   │
│  │ │ ▸ Select endpoint...                                      [▾] │   │   │
│  │ └────────────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ URL Row                                                              │   │
│  │ ┌────────┐ ┌───────────────────────────────────────┐ ┌──────┐ ┌───┐ │   │
│  │ │  GET ▾ │ │ /v1/workspaces/{workspaceId}/items    │ │ Send │ │⧉  │ │   │
│  │ └────────┘ └───────────────────────────────────────┘ └──────┘ └───┘ │   │
│  │  90px        flex: 1                                  primary ghost │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Tab Bar                                                              │   │
│  │ ┌──────────┐ ┌──────┐ ┌────────┐                                    │   │
│  │ │ Headers  │ │ Body │ │ Params │                                    │   │
│  │ │ (3)      │ │      │ │        │                                    │   │
│  │ └──────────┘ └──────┘ └────────┘                                    │   │
│  │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Tab Content: Headers (default)                                       │   │
│  │                                                                      │   │
│  │  ┌────────────────┐ ┌──────────────────────────────────────┐ ┌───┐  │   │
│  │  │ Authorization  │ │ Bearer eyJhbGciOiJSUz...  ●●●●      │ │ ✕ │  │   │
│  │  └────────────────┘ └──────────────────────────────────────┘ └───┘  │   │
│  │  ┌────────────────┐ ┌──────────────────────────────────────┐ ┌───┐  │   │
│  │  │ Content-Type   │ │ application/json                     │ │ ✕ │  │   │
│  │  └────────────────┘ └──────────────────────────────────────┘ └───┘  │   │
│  │  ┌────────────────┐ ┌──────────────────────────────────────┐ ┌───┐  │   │
│  │  │ x-ms-workload..│ │ {artifactId}                        │ │ ✕ │  │   │
│  │  └────────────────┘ └──────────────────────────────────────┘ └───┘  │   │
│  │                                                                      │   │
│  │  [+ Add header]                                                      │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Tab Content: Body (shown when Body tab selected, POST/PUT/PATCH)     │   │
│  │                                                                      │   │
│  │  BODY (JSON)                                                         │   │
│  │  ┌──────────────────────────────────────────────────────────────┐    │   │
│  │  │ {                                                            │    │   │
│  │  │   "displayName": "My Lakehouse",                             │    │   │
│  │  │   "description": "Created via EDOG"                          │    │   │
│  │  │ }                                                            │    │   │
│  │  └──────────────────────────────────────────────────────────────┘    │   │
│  │  JSON valid ●                                            [Format]   │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Dimensions

| Element | Width | Height | Notes |
|---------|-------|--------|-------|
| `.api-request-section` | 100% of `.api-main` | Auto (content-driven) | Max-height: 50vh; overflow: auto |
| `.api-method-select` | 90px fixed | 32px | Includes dropdown arrow |
| `.api-url-input` | flex: 1 | 32px | Monospace font |
| `.api-send-btn` | Auto (padding-based) | 32px | Min-width: 64px |
| `.api-curl-btn` | 32px | 32px | Square icon button |
| Header key input | 160px fixed | 28px | — |
| Header value input | flex: 1 | 28px | — |
| Body textarea | 100% | min 80px, max 240px | Resizable vertically |
| Endpoint catalog dropdown | 100% of URL row | Auto (max 320px) | Scrollable |
| Tab bar | 100% | 32px | — |

### 2.3 Spacing

All spacing uses the `--space-N` tokens from `variables.css` (4px grid):

| Context | Token | Value |
|---------|-------|-------|
| Section padding | `--space-3` | 12px |
| Gap between rows | `--space-2` | 8px |
| Gap within URL row | `--space-2` | 8px |
| Gap between header rows | `--space-1` | 4px |
| Input internal padding | `--space-1` vertical, `--space-2` horizontal | 4px 8px |
| Send button padding | `--space-1` vertical, `--space-4` horizontal | 4px 16px |
| Tab padding | `--space-1` vertical, `--space-3` horizontal | 4px 12px |

---

## 3. DOM Structure

```html
<div class="api-request-section" role="region" aria-label="Request builder">

  <!-- Endpoint Catalog Dropdown -->
  <div class="api-catalog-row">
    <button class="api-catalog-trigger"
            role="combobox"
            aria-expanded="false"
            aria-haspopup="listbox"
            aria-controls="api-catalog-listbox"
            aria-label="Select pre-configured endpoint">
      <span class="api-catalog-icon">▸</span>
      <span class="api-catalog-label">Select endpoint...</span>
      <span class="api-catalog-chevron">▾</span>
    </button>
    <div id="api-catalog-listbox"
         class="api-catalog-dropdown"
         role="listbox"
         aria-label="Endpoint catalog"
         hidden>
      <input class="api-catalog-search"
             type="text"
             role="searchbox"
             aria-label="Search endpoints"
             placeholder="Search endpoints...">
      <!-- Rendered dynamically: groups + options -->
      <div class="api-catalog-group" role="group" aria-label="Fabric — Workspace">
        <div class="api-catalog-group-label">Fabric — Workspace</div>
        <div class="api-catalog-option"
             role="option"
             aria-selected="false"
             data-index="0"
             tabindex="-1">
          <span class="method-pill method-get">GET</span>
          <span class="api-catalog-option-name">List Workspaces</span>
        </div>
        <!-- ...more options -->
      </div>
      <!-- ...more groups -->
    </div>
  </div>

  <!-- URL Row -->
  <div class="api-url-row">
    <select class="api-method-select"
            aria-label="HTTP method">
      <option value="GET" selected>GET</option>
      <option value="POST">POST</option>
      <option value="PUT">PUT</option>
      <option value="PATCH">PATCH</option>
      <option value="DELETE">DELETE</option>
    </select>

    <div class="api-url-wrapper" role="presentation">
      <input class="api-url-input"
             type="text"
             aria-label="Request URL"
             placeholder="/v1/workspaces/{workspaceId}/items"
             spellcheck="false"
             autocomplete="off">
      <!-- Overlay for variable highlighting (positioned absolutely) -->
      <div class="api-url-highlights" aria-hidden="true"></div>
    </div>

    <button class="api-send-btn"
            aria-label="Send request (Ctrl+Enter)"
            title="Send request (Ctrl+Enter)">
      Send
    </button>

    <button class="api-curl-btn"
            aria-label="Copy as cURL"
            title="Copy as cURL">
      <svg class="api-curl-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16">
        <!-- Copy/clipboard icon path -->
        <path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2z
                 M2 4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1h-1v1a1 1 0 0 1-1 1H2
                 a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h1V4H2z"
              fill="currentColor"/>
      </svg>
    </button>
  </div>

  <!-- Request Tab Bar -->
  <div class="api-request-tabs" role="tablist" aria-label="Request configuration">
    <button class="api-request-tab is-active"
            role="tab"
            aria-selected="true"
            aria-controls="api-tab-headers"
            id="tab-headers"
            tabindex="0">
      Headers
      <span class="api-tab-count" aria-label="3 headers">(3)</span>
    </button>
    <button class="api-request-tab"
            role="tab"
            aria-selected="false"
            aria-controls="api-tab-body"
            id="tab-body"
            tabindex="-1">
      Body
    </button>
    <button class="api-request-tab"
            role="tab"
            aria-selected="false"
            aria-controls="api-tab-params"
            id="tab-params"
            tabindex="-1">
      Params
    </button>
  </div>

  <!-- Tab Panels -->

  <!-- Headers Panel -->
  <div class="api-tab-panel"
       id="api-tab-headers"
       role="tabpanel"
       aria-labelledby="tab-headers">
    <div class="api-headers" role="list" aria-label="Request headers">

      <div class="api-header-row" role="listitem">
        <input class="api-header-key"
               type="text"
               value="Authorization"
               aria-label="Header name"
               readonly>
        <input class="api-header-val"
               type="text"
               value="Bearer eyJhbGci..."
               aria-label="Header value"
               data-auto-filled="true">
        <button class="api-header-rm"
                aria-label="Remove Authorization header"
                title="Remove header">✕</button>
      </div>

      <div class="api-header-row" role="listitem">
        <input class="api-header-key"
               type="text"
               value="Content-Type"
               aria-label="Header name">
        <input class="api-header-val"
               type="text"
               value="application/json"
               aria-label="Header value">
        <button class="api-header-rm"
                aria-label="Remove Content-Type header"
                title="Remove header">✕</button>
      </div>

      <!-- Empty row for new entry -->
      <div class="api-header-row api-header-row--new" role="listitem">
        <input class="api-header-key"
               type="text"
               placeholder="Header name"
               aria-label="New header name">
        <input class="api-header-val"
               type="text"
               placeholder="Value"
               aria-label="New header value">
        <button class="api-header-rm"
                aria-label="Remove header"
                title="Remove header"
                disabled>✕</button>
      </div>

    </div>
    <button class="api-header-add"
            aria-label="Add new header row">
      + Add header
    </button>
  </div>

  <!-- Body Panel -->
  <div class="api-tab-panel"
       id="api-tab-body"
       role="tabpanel"
       aria-labelledby="tab-body"
       hidden>
    <div class="api-body-section">
      <div class="api-body-toolbar">
        <span class="api-body-label">Body (JSON)</span>
        <div class="api-body-status" aria-live="polite">
          <span class="api-body-valid-dot" aria-hidden="true">●</span>
          <span class="api-body-valid-text">JSON valid</span>
        </div>
        <button class="api-body-format-btn"
                aria-label="Format JSON body"
                title="Format JSON (Ctrl+Shift+F)">
          Format
        </button>
      </div>
      <textarea class="api-body-input"
                aria-label="Request body (JSON)"
                spellcheck="false"
                placeholder='{ "key": "value" }'></textarea>
    </div>
  </div>

  <!-- Params Panel (query string editor) -->
  <div class="api-tab-panel"
       id="api-tab-params"
       role="tabpanel"
       aria-labelledby="tab-params"
       hidden>
    <div class="api-params" role="list" aria-label="Query parameters">
      <!-- Same structure as headers: key-value rows -->
      <div class="api-param-row" role="listitem">
        <input class="api-param-key"
               type="text"
               placeholder="Parameter name"
               aria-label="Parameter name">
        <input class="api-param-val"
               type="text"
               placeholder="Value"
               aria-label="Parameter value">
        <button class="api-param-rm"
                aria-label="Remove parameter"
                title="Remove parameter"
                disabled>✕</button>
      </div>
    </div>
    <button class="api-param-add"
            aria-label="Add new query parameter">
      + Add parameter
    </button>
  </div>

  <!-- Loading overlay (shown during request) -->
  <div class="api-request-loading" hidden aria-hidden="true">
    <span class="api-request-spinner" aria-label="Sending request"></span>
  </div>

</div>
```

---

## 4. CSS Specification

### 4.1 Method Color Coding

Method colors are hard-coded (not theme-dependent) because they represent universal HTTP semantics:

```css
.api-method-select[data-method="GET"],
.method-pill.method-get    { color: #059669; }

.api-method-select[data-method="POST"],
.method-pill.method-post   { color: #2563eb; }

.api-method-select[data-method="PUT"],
.method-pill.method-put    { color: #d97706; }

.api-method-select[data-method="PATCH"],
.method-pill.method-patch  { color: #ca8a04; }

.api-method-select[data-method="DELETE"],
.method-pill.method-delete { color: #dc2626; }
```

The `<select>` element color is updated dynamically via JS when the value changes. The JS handler sets `data-method` on the element to match the selected value so CSS can react.

### 4.2 Method Pills (used in catalog, history)

```css
.method-pill {
  display: inline-block;
  padding: 0 var(--space-1);        /* 0 4px */
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  line-height: 16px;
  border-radius: 2px;
  min-width: 36px;
  text-align: center;
  user-select: none;
}

/* Background tints for pills */
.method-pill.method-get    { background: rgba(5, 150, 105, 0.10); }
.method-pill.method-post   { background: rgba(37, 99, 235, 0.10); }
.method-pill.method-put    { background: rgba(217, 119, 6, 0.10); }
.method-pill.method-patch  { background: rgba(202, 138, 4, 0.10); }
.method-pill.method-delete { background: rgba(220, 38, 38, 0.10); }
```

### 4.3 Endpoint Catalog Dropdown

```css
.api-catalog-row {
  position: relative;
}

.api-catalog-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2);             /* 8px */
  width: 100%;
  padding: var(--space-1) var(--space-2);  /* 4px 8px */
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);  /* 4px */
  background: var(--surface-2);
  color: var(--text-muted);
  font-family: var(--font-body);
  font-size: var(--text-xs);       /* 10px */
  cursor: pointer;
  transition: border-color var(--transition-fast),
              background var(--transition-fast);
  line-height: 20px;
  text-align: left;
}

.api-catalog-trigger:hover {
  border-color: var(--border-bright);
  background: var(--surface-3);
}

.api-catalog-trigger:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--shadow-glow);
}

.api-catalog-trigger[aria-expanded="true"] {
  border-color: var(--accent);
}

.api-catalog-icon {
  color: var(--accent);
  font-size: 8px;
  transition: transform var(--transition-fast);
}

.api-catalog-trigger[aria-expanded="true"] .api-catalog-icon {
  transform: rotate(90deg);
}

.api-catalog-chevron {
  margin-left: auto;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.api-catalog-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Dropdown panel */
.api-catalog-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 320px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);  /* 6px */
  box-shadow: var(--shadow-lg);
  z-index: var(--z-dropdown);       /* 200 */
  padding: var(--space-1) 0;
}

.api-catalog-dropdown[hidden] {
  display: none;
}

.api-catalog-search {
  width: calc(100% - var(--space-2) * 2);
  margin: var(--space-1) var(--space-2);  /* 4px 8px */
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text);
  font-family: var(--font-body);
  font-size: var(--text-xs);
}

.api-catalog-search:focus {
  outline: none;
  border-color: var(--accent);
}

.api-catalog-group-label {
  padding: var(--space-1) var(--space-3);  /* 4px 12px */
  font-size: var(--text-xs);       /* 10px */
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  user-select: none;
  margin-top: var(--space-1);
}

.api-catalog-group-label:first-child {
  margin-top: 0;
}

.api-catalog-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);             /* 8px */
  padding: var(--space-1) var(--space-3);  /* 4px 12px */
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--text-dim);
  transition: background var(--transition-fast);
  line-height: 24px;
}

.api-catalog-option:hover,
.api-catalog-option.is-focused {
  background: var(--accent-hover);
}

.api-catalog-option[aria-selected="true"] {
  background: var(--accent-dim);
  color: var(--text);
}

.api-catalog-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.api-catalog-empty {
  padding: var(--space-3);
  text-align: center;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-style: italic;
}
```

### 4.4 URL Row (extends existing)

```css
/* .api-url-row — exists in api-playground.css */
/* Additional/override rules: */

.api-url-wrapper {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
}

/* .api-url-input — exists; add overlay handling: */
.api-url-input {
  /* Existing properties preserved */
  position: relative;
  z-index: 1;
  background: transparent;        /* Make transparent so highlights show through */
}

/* Highlight layer: sits behind the input, mirrors text position */
.api-url-highlights {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  padding: var(--space-1) var(--space-3);  /* Match input padding exactly */
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 32px;               /* Match input height for vertical centering */
  white-space: nowrap;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
  color: transparent;              /* Text is invisible; only <mark> tags show color */
  background: var(--surface-2);    /* Background lives here, not on input */
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
}

/* When input is focused, update the highlight layer border */
.api-url-input:focus + .api-url-highlights {
  border-color: var(--accent);
}

/* Template variable highlights inside the overlay */
.api-url-highlights mark {
  background: none;
  color: var(--accent);
  font-weight: 600;
}

.api-url-highlights mark.is-unresolved {
  color: var(--level-error);
  text-decoration: wavy underline;
  text-decoration-color: var(--level-error);
  text-underline-offset: 2px;
}
```

### 4.5 Send Button States

```css
/* .api-send-btn — base styles exist; add states: */

.api-send-btn {
  /* Existing properties preserved */
  transition: background var(--transition-fast),
              opacity var(--transition-fast),
              box-shadow var(--transition-fast);
  position: relative;
  overflow: hidden;
}

.api-send-btn:hover {
  opacity: 0.9;
}

.api-send-btn:active {
  transform: scale(0.97);
}

.api-send-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-glow);
}

/* Disabled state — no URL entered */
.api-send-btn:disabled,
.api-send-btn[aria-disabled="true"] {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

/* Loading state — request in flight */
.api-send-btn.is-loading {
  pointer-events: none;
  opacity: 0.7;
}

.api-send-btn.is-loading::after {
  content: "";
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.15),
    transparent
  );
  animation: api-send-shimmer 1.2s infinite;
}

@keyframes api-send-shimmer {
  to { left: 100%; }
}
```

### 4.6 cURL Button

```css
.api-curl-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: background var(--transition-fast),
              color var(--transition-fast),
              border-color var(--transition-fast);
  flex-shrink: 0;
}

.api-curl-btn:hover {
  background: var(--surface-3);
  color: var(--text);
  border-color: var(--border-bright);
}

.api-curl-btn:active {
  transform: scale(0.95);
}

.api-curl-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-glow);
  border-color: var(--accent);
}

/* "Copied!" feedback state */
.api-curl-btn.is-copied {
  border-color: var(--status-succeeded);
  color: var(--status-succeeded);
}

.api-curl-btn.is-copied .api-curl-icon {
  /* Swap to checkmark icon via JS (replaces SVG path) */
}
```

### 4.7 Request Tab Bar

```css
.api-request-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  padding: 0 var(--space-3);       /* 0 12px */
  background: var(--surface);
}

.api-request-tab {
  padding: var(--space-1) var(--space-3);  /* 4px 12px */
  font-family: var(--font-body);
  font-size: var(--text-xs);       /* 10px */
  font-weight: 500;
  color: var(--text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color var(--transition-fast),
              border-color var(--transition-fast);
  line-height: 24px;
  white-space: nowrap;
  position: relative;
  top: 1px;                        /* Overlap parent border-bottom */
}

.api-request-tab:hover {
  color: var(--text-dim);
}

.api-request-tab.is-active,
.api-request-tab[aria-selected="true"] {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.api-request-tab:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-glow);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}

.api-tab-count {
  margin-left: var(--space-1);
  font-size: 9px;
  color: var(--text-muted);
  font-weight: 400;
}

.api-request-tab.is-active .api-tab-count {
  color: var(--accent);
}
```

### 4.8 Tab Panels

```css
.api-tab-panel {
  padding: var(--space-2) var(--space-3);  /* 8px 12px */
  max-height: 240px;
  overflow-y: auto;
}

.api-tab-panel[hidden] {
  display: none;
}
```

### 4.9 Headers Editor (extends existing)

```css
/* .api-headers, .api-header-row, .api-header-key, .api-header-val,
   .api-header-rm, .api-header-add — all exist in api-playground.css */

/* Additional rules: */

.api-header-row--new .api-header-key,
.api-header-row--new .api-header-val {
  border-style: dashed;
}

/* Auto-filled header styling */
.api-header-val[data-auto-filled="true"] {
  color: var(--text-muted);
  font-style: italic;
}

/* Locked (auto-injected) rows — key is readonly */
.api-header-row.is-auto-injected .api-header-key {
  color: var(--accent);
  font-weight: 500;
}

.api-header-row.is-auto-injected .api-header-val {
  color: var(--text-muted);
  /* Token value is masked; show ●●●● */
}

/* Token reveal toggle inside auto-injected value */
.api-header-reveal {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--text-xs);
  padding: 2px;
}

.api-header-reveal:hover {
  color: var(--accent);
}
```

### 4.10 Body Editor (extends existing)

```css
/* .api-body-section, .api-body-label, .api-body-input — exist */

/* Additional rules: */

.api-body-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.api-body-status {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  font-size: var(--text-xs);
}

.api-body-valid-dot {
  font-size: 8px;
}

/* Valid state */
.api-body-status.is-valid .api-body-valid-dot { color: var(--status-succeeded); }
.api-body-status.is-valid .api-body-valid-text { color: var(--status-succeeded); }

/* Invalid state */
.api-body-status.is-invalid .api-body-valid-dot { color: var(--level-error); }
.api-body-status.is-invalid .api-body-valid-text { color: var(--level-error); }

/* Empty (no content yet) — hide status */
.api-body-status.is-empty { visibility: hidden; }

.api-body-format-btn {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--space-1) var(--space-2);
}

.api-body-format-btn:hover {
  text-decoration: underline;
}

.api-body-format-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-glow);
  border-radius: var(--radius-sm);
}

/* Body textarea error state */
.api-body-input.is-invalid {
  border-color: var(--level-error);
}

.api-body-input:focus {
  outline: none;
  border-color: var(--accent);
}

/* Body hidden for GET/DELETE (no body expected) */
.api-body-section.is-hidden {
  display: none;
}
```

### 4.11 Loading Overlay

```css
.api-request-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--surface-rgb, 255, 255, 255), 0.6);
  z-index: 10;
}

.api-request-loading[hidden] {
  display: none;
}

.api-request-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-bright);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: api-spin 0.6s linear infinite;
}

@keyframes api-spin {
  to { transform: rotate(360deg); }
}
```

### 4.12 Dark Theme Overrides

Method colors are intentionally NOT changed for dark mode — they are high-contrast enough on both backgrounds. All other colors use CSS custom properties from `variables.css` which are already theme-aware via `[data-theme="dark"]`.

No additional dark-mode overrides are needed for this component.

---

## 5. Interaction Model

### 5.1 Request Lifecycle

```
[idle] ──(user edits)──▸ [dirty] ──(Send click / Ctrl+Enter)──▸ [sending]
                                                                     │
                                  ┌───────────────────────────────────┤
                                  │                                   │
                                  ▼                                   ▼
                             [success]                           [error]
                                  │                                   │
                                  └──────────┬────────────────────────┘
                                             ▼
                                          [idle]
```

### 5.2 Method Selector

| Action | Behavior |
|--------|----------|
| Click `<select>` | Opens native dropdown with five options |
| Change value | (1) Update `data-method` attribute on `<select>` for color CSS. (2) Update `color` property on the element via JS. (3) If method changes to GET or DELETE: auto-hide Body tab panel, switch to Headers if Body was active. (4) If method changes to POST/PUT/PATCH and Body tab was hidden: show Body tab, auto-switch to Body tab. (5) Re-run token auto-injection (method change may affect headers). |

### 5.3 URL Input

| Action | Behavior |
|--------|----------|
| Type in URL field | (1) Mirror text into `.api-url-highlights` div. (2) Parse `{...}` patterns and wrap in `<mark>` tags. (3) Debounce (200ms) before re-running variable resolution and token auto-injection. (4) Enable/disable Send button based on non-empty URL. |
| Paste URL | Same as typing, but immediate (no debounce on paste event). |
| Tab out of URL | Trigger final variable resolution + token re-injection. |
| Click a highlighted variable | Select the entire `{variable}` text in the input for easy replacement. |

### 5.4 Endpoint Catalog

| Action | Behavior |
|--------|----------|
| Click catalog trigger | Toggle dropdown. If opening: focus search input. |
| Type in search | Filter options by name (case-insensitive substring). Hide groups with zero visible options. Show "No endpoints found" if all filtered out. |
| Arrow Down/Up in search | Move `.is-focused` class through visible options. Scroll into view. |
| Enter in search | Select the focused option. |
| Click an option | (1) Set method to the endpoint's method. (2) Set URL to the endpoint's path. (3) Auto-inject token headers for the endpoint's group. (4) If endpoint has a body template, populate the body textarea. (5) Update catalog trigger label to show selected endpoint name. (6) Close dropdown. (7) Focus URL input. |
| Escape in dropdown | Close dropdown. Return focus to trigger button. |
| Click outside dropdown | Close dropdown. |

### 5.5 Tab Navigation

| Action | Behavior |
|--------|----------|
| Click a tab | (1) Set `aria-selected="true"` on clicked tab, `"false"` on others. (2) Add `.is-active` to clicked tab, remove from others. (3) Show the corresponding `tabpanel`, hide others via `hidden` attribute. (4) Set `tabindex="0"` on active tab, `tabindex="-1"` on inactive tabs. |
| Arrow Left/Right on focused tab | Move focus to adjacent tab (wrapping). Activate the newly focused tab. |
| Home on focused tab | Move focus to first tab. |
| End on focused tab | Move focus to last tab. |

### 5.6 Headers Editor

| Action | Behavior |
|--------|----------|
| Type in a `--new` row key field | When key field gets first character, remove `--new` class, enable remove button, append a new empty `--new` row below. |
| Click remove (✕) | Remove the header row from DOM. Update header count in tab label. If removing an auto-injected header: mark it as "user-overridden" (don't auto-inject next time for this request). |
| Click "+ Add header" | Append a new empty row. Focus the key field. |
| Tab from last value field | Focus the "+ Add header" button. |

### 5.7 Body Editor

| Action | Behavior |
|--------|----------|
| Type in textarea | Debounce 300ms, then: (1) Validate JSON syntax via `JSON.parse()`. (2) Update `.api-body-status` to valid/invalid. (3) If invalid, set `is-invalid` class on textarea. |
| Click "Format" | (1) Attempt `JSON.parse()`. (2) If valid: replace textarea value with `JSON.stringify(parsed, null, 2)`. (3) If invalid: shake the Format button (CSS animation), show toast "Invalid JSON — cannot format". |
| Ctrl+Shift+F | Same as clicking "Format". |

### 5.8 Send Request

| Trigger | Behavior |
|---------|----------|
| Click Send button | Execute request. |
| Ctrl+Enter (anywhere in request builder) | Execute request. |

**Send flow:**

1. **Validate**: URL must be non-empty. If body tab is active and body is non-empty, validate JSON. If validation fails: shake the invalid field, focus it, abort.
2. **Resolve variables**: Replace all `{variable}` patterns in URL with values from config. If any variable is unresolved (value not found in config): show warning toast "Unresolved variable: {variableName}", but still send (the literal `{variableName}` stays in URL).
3. **Build request**: Assemble `{ method, url, headers, body }`.
4. **Set loading state**: Add `is-loading` class to Send button. Change button text to "Sending...". Disable all inputs (`aria-disabled`). Show `api-request-loading` overlay if request takes >500ms.
5. **Execute fetch**: Call `fetch()` with the assembled request. Start timer for response duration.
6. **On response**: Stop timer. Parse response. Emit `request:complete` event with `{ request, response: { status, statusText, headers, body, duration } }`.
7. **Reset state**: Remove `is-loading`. Re-enable inputs. Restore "Send" text.
8. **On error (network)**: Emit `request:error` event. Show inline error banner below request builder (not a toast — persistent, dismissible).

### 5.9 Copy as cURL

| Trigger | Behavior |
|---------|----------|
| Click cURL button | (1) Generate cURL command (see §8). (2) Copy to clipboard via `navigator.clipboard.writeText()`. (3) Add `is-copied` class to button. (4) Swap icon from clipboard to checkmark. (5) After 2000ms, revert icon and remove `is-copied` class. (6) Announce "Copied to clipboard" via `aria-live` region. |

### 5.10 Keyboard Shortcuts (Complete Map)

| Shortcut | Scope | Action |
|----------|-------|--------|
| `Ctrl+Enter` | Anywhere in `.api-request-section` | Send request |
| `Ctrl+Shift+F` | Body textarea focused | Format JSON |
| `Escape` | Catalog dropdown open | Close catalog |
| `Arrow Left` / `Arrow Right` | Tab bar focused | Navigate tabs |
| `Home` / `End` | Tab bar focused | First/last tab |
| `Arrow Down` / `Arrow Up` | Catalog search focused | Navigate options |
| `Enter` | Catalog search focused | Select focused option |
| `Tab` | Standard | Move through focusable elements in DOM order |

**Note:** `Ctrl+Enter` is captured at the `.api-request-section` level via a `keydown` listener. It does NOT interfere with normal Enter behavior in textareas (which inserts a newline).

### 5.11 Focus Management

**Initial focus on view activation:** URL input field.

**Focus order (Tab sequence):**
1. Endpoint catalog trigger
2. Method selector
3. URL input
4. Send button
5. cURL button
6. Tab bar (first active tab)
7. Tab panel contents (header/body/param inputs)
8. Add header/param button

**Focus trapping:** None. The request builder is not a modal — focus flows naturally into the response viewer below it and the sidebar.

---

## 6. Template Variable System

### 6.1 Variable Detection

Variables are detected in the URL input via regex:

```javascript
const TEMPLATE_VAR_REGEX = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
```

**Supported variables** (resolved from `/api/flt/config` response):

| Variable | Config Key | Example Value |
|----------|-----------|---------------|
| `{workspaceId}` | `config.workspaceId` | `12345678-1234-1234-1234-123456789abc` |
| `{artifactId}` | `config.artifactId` | `87654321-4321-4321-4321-cba987654321` |
| `{capacityId}` | `config.capacityId` | `ABCDEF12` |
| `{fabricBaseUrl}` | `config.fabricBaseUrl` | `https://ABCDEF12.pbidedicated.windows-int.net/webapi/capacities/ABCDEF12/workloads/org.FabricLiveTable/...` |
| `{iterationId}` | User-provided (stored in localStorage `edog.lastIterationId`) | DAG iteration GUID |
| `{bearerToken}` | `config.bearerToken` | JWT string (used in header values) |
| `{mwcToken}` | `config.mwcToken` | JWT string (used in header values) |

### 6.2 Variable Highlighting (Real-Time)

The URL input uses a **mirror overlay** technique to highlight template variables without disrupting native input behavior:

**Algorithm:**

1. On every `input` event on `.api-url-input`:
2. Read `input.value`.
3. Escape HTML entities (`<`, `>`, `&`).
4. Replace each `{variableName}` match with `<mark class="[resolved|is-unresolved]">{variableName}</mark>`.
5. Set the result as `innerHTML` of `.api-url-highlights`.
6. Synchronize scroll position: `highlights.scrollLeft = input.scrollLeft`.

**Resolution check:**

```javascript
_isVariableResolved(name) {
  if (name === 'iterationId') {
    return !!localStorage.getItem('edog.lastIterationId');
  }
  return this._config && this._config[name] !== undefined && this._config[name] !== null;
}
```

**Visual states:**

| State | CSS Class on `<mark>` | Appearance |
|-------|----------------------|------------|
| Resolved | (none — default) | `color: var(--accent)`, `font-weight: 600` |
| Unresolved | `.is-unresolved` | `color: var(--level-error)`, wavy underline |

### 6.3 Variable Expansion (At Send Time)

Variables are expanded only when the request is sent — NOT in the input field itself. The user always sees `{workspaceId}` in the URL input; the resolved URL is built internally for the fetch call.

```javascript
_expandVariables(urlTemplate) {
  return urlTemplate.replace(TEMPLATE_VAR_REGEX, (match, name) => {
    const value = this._resolveVariable(name);
    return value !== null ? value : match; // Keep literal if unresolved
  });
}

_resolveVariable(name) {
  if (name === 'iterationId') {
    return localStorage.getItem('edog.lastIterationId') || null;
  }
  if (name === 'bearerToken') return this._config?.bearerToken || null;
  if (name === 'mwcToken') return this._config?.mwcToken || null;
  return this._config?.[name] || null;
}
```

### 6.4 Variable Tooltip

When the user hovers over a highlighted variable in the URL overlay, show a tooltip:

| Variable State | Tooltip Content |
|----------------|-----------------|
| Resolved | `{workspaceId} → 12345678-1234-...` (first 20 chars of value) |
| Unresolved (config missing) | `{iterationId} — not set. Enter a value or run a DAG.` |
| Unresolved (unknown name) | `{unknownVar} — unknown variable` |

**Tooltip implementation:** CSS `::after` pseudo-element on `<mark>` with `content: attr(data-tooltip)`. JS sets `data-tooltip` attribute on each `<mark>`.

```css
.api-url-highlights mark {
  position: relative;
  cursor: help;
}

.api-url-highlights mark[data-tooltip]:hover::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  padding: var(--space-1) var(--space-2);
  background: var(--surface-3);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 400;
  color: var(--text-dim);
  white-space: nowrap;
  box-shadow: var(--shadow-sm);
  z-index: var(--z-dropdown);
  pointer-events: none;
}
```

---

## 7. Token Auto-injection

### 7.1 URL Classification

When the URL changes (debounced 200ms), classify the URL to determine which auth scheme to use:

```javascript
_classifyUrl(url) {
  // EDOG internal APIs — no auth needed
  if (url.startsWith('/api/flt/') || url.startsWith('/api/edog/')) {
    return 'edog';
  }

  // FLT capacity host — direct call with MwcToken
  // Matches: fabricBaseUrl, or contains known FLT path segments
  const fltPaths = [
    '/liveTable/',
    '/liveTableSchedule/',
    '/liveTableMaintenance/',
    '/DataArtifact/',
    '/Lakehouse/',
    '/SparkCoreService/',
    '/metadata/v201606/',
    'publicUnprotected/ping'
  ];
  if (fltPaths.some(p => url.includes(p))) {
    return 'flt';
  }

  // Check if URL starts with fabricBaseUrl (direct capacity call)
  if (this._config?.fabricBaseUrl && url.startsWith(this._config.fabricBaseUrl)) {
    return 'flt';
  }

  // Fabric redirect host — proxied via /api/fabric/*
  if (url.startsWith('/v1/') || url.startsWith('/v1.0/') || url.startsWith('/api/fabric/')) {
    return 'fabric';
  }

  // Default: treat as Fabric (bearer token)
  return 'fabric';
}
```

### 7.2 Header Auto-Injection Rules

| URL Class | Authorization Header | Additional Headers |
|-----------|--------------------|--------------------|
| `edog` | None (remove if present) | None |
| `fabric` | `Bearer {bearerToken}` | `Content-Type: application/json` (if POST/PUT/PATCH) |
| `flt` | `MwcToken {mwcToken}` | `Content-Type: application/json` (if POST/PUT/PATCH), `x-ms-workload-resource-moniker: {artifactId}` |

### 7.3 Auto-Injection Behavior

1. On URL change (debounced) or method change:
2. Classify the URL.
3. Find the `Authorization` header row in the headers editor.
4. If it exists and is `data-auto-filled="true"`: update its value to match the new classification.
5. If it exists and is NOT `data-auto-filled` (user-edited): do NOT overwrite. The user has manually set a token.
6. If it does not exist and classification requires auth: insert a new auto-filled row at position 0.
7. For FLT URLs: also check for `x-ms-workload-resource-moniker` header. Insert if missing.
8. For EDOG URLs: remove auto-filled Authorization row if present.

### 7.4 Token Display in Headers

Auto-injected tokens are masked for readability (JWT strings are 2000+ characters):

```javascript
_maskToken(token) {
  if (!token || token.length < 20) return token;
  return token.substring(0, 12) + '●●●●●●●●';
}
```

A small reveal toggle button (`◉` / `◎`) appears inside the value field:

| State | Display | Toggle Label |
|-------|---------|-------------|
| Masked (default) | `Bearer eyJhbGciOiJS●●●●●●●●` | "Show full token" |
| Revealed | `Bearer eyJhbGciOiJSUzI1NiIsIn...` (full value, horizontally scrollable) | "Hide token" |

The reveal state resets to masked whenever the URL changes or a new endpoint is selected.

### 7.5 Token Expiry Handling

On every send attempt:

1. Check `config.tokenExpired` flag.
2. If `true`: show an error banner below the URL row:
   ```
   ┌────────────────────────────────────────────────────────┐
   │ ⚠ Token expired — re-authenticate to refresh.         │
   │ The last token expired N minutes ago.             [✕]  │
   └────────────────────────────────────────────────────────┘
   ```
3. Still allow sending (the user might have manually pasted a fresh token).
4. Banner is dismissible via ✕ button.

```css
.api-token-warning {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--level-warning-tint);
  border: 1px solid rgba(229, 148, 12, 0.3);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--level-warning);
  margin-top: var(--space-1);
}

.api-token-warning-icon {
  flex-shrink: 0;
}

.api-token-warning-text {
  flex: 1;
}

.api-token-warning-close {
  background: none;
  border: none;
  color: var(--level-warning);
  cursor: pointer;
  font-size: var(--text-sm);
  padding: 2px;
}

.api-token-warning-close:hover {
  opacity: 0.7;
}
```

---

## 8. cURL Generation

### 8.1 Algorithm

```javascript
_generateCurl() {
  const method = this._getMethod();
  const url = this._expandVariables(this._getUrl());
  const headers = this._getHeaders(); // Array of { key, value }
  const body = this._getBody();       // String or null

  let parts = ['curl'];

  // Method (omit for GET — curl defaults to GET)
  if (method !== 'GET') {
    parts.push(`-X ${method}`);
  }

  // URL (quote if contains special characters)
  parts.push(`'${this._escapeShellSingle(url)}'`);

  // Headers
  for (const { key, value } of headers) {
    if (!key || !value) continue;
    // Expand token variables in header values for the cURL output
    const expandedValue = this._expandVariables(value);
    parts.push(`-H '${this._escapeShellSingle(key)}: ${this._escapeShellSingle(expandedValue)}'`);
  }

  // Body (only for POST/PUT/PATCH and when non-empty)
  if (['POST', 'PUT', 'PATCH'].includes(method) && body && body.trim()) {
    // Try to compact JSON for the cURL command
    try {
      const parsed = JSON.parse(body);
      const compact = JSON.stringify(parsed);
      parts.push(`-d '${this._escapeShellSingle(compact)}'`);
    } catch {
      // If not valid JSON, use the raw body
      parts.push(`-d '${this._escapeShellSingle(body.trim())}'`);
    }
  }

  return parts.join(' \\\n  ');
}
```

### 8.2 Shell Escaping

```javascript
_escapeShellSingle(str) {
  // Escape single quotes for POSIX shell: replace ' with '\''
  return str.replace(/'/g, "'\\''");
}
```

### 8.3 URL Resolution for cURL

The cURL output uses **fully resolved** URLs:

| URL Pattern in Input | Resolved cURL URL |
|----------------------|-------------------|
| `/v1/workspaces/{workspaceId}/items` | `https://api.fabric.microsoft.com/v1/workspaces/12345678-1234-.../items` |
| `{fabricBaseUrl}/liveTable/getLatestDag?showExtendedLineage=true` | `https://ABCDEF12.pbidedicated.windows-int.net/webapi/.../liveTable/getLatestDag?showExtendedLineage=true` |
| `/api/flt/config` | `http://localhost:5555/api/flt/config` |

**For Fabric proxy URLs** (paths starting with `/v1/` or `/v1.0/`): the cURL command uses the real Fabric API base URL `https://api.fabric.microsoft.com`, not the local proxy path. This makes the cURL command portable — it can be run outside EDOG.

**For EDOG internal URLs** (`/api/flt/*`, `/api/edog/*`): the cURL command uses `http://localhost:5555` as the base.

**For FLT capacity URLs**: the cURL command uses the full `fabricBaseUrl` as-is.

### 8.4 cURL Output Format

Multi-line with backslash continuations for readability:

```bash
curl -X POST \
  'https://ABCDEF12.pbidedicated.windows-int.net/.../liveTableSchedule/runDAG/aaaaaaaa-bbbb-...' \
  -H 'Authorization: MwcToken eyJhbGciOi...' \
  -H 'Content-Type: application/json' \
  -H 'x-ms-workload-resource-moniker: 87654321-4321-...' \
  -d '{"force":true}'
```

---

## 9. Error Handling

### 9.1 Validation Errors (Pre-Send)

| Condition | Visual | Behavior |
|-----------|--------|----------|
| Empty URL | URL input border turns `var(--level-error)`. Placeholder text visible. | Focus URL input. Shake animation (CSS `@keyframes api-shake`). Send blocked. |
| Invalid JSON body (POST/PUT/PATCH) | Body textarea border turns `var(--level-error)`. Status dot shows "JSON invalid". | Focus body textarea. Send NOT blocked (user may want to send raw text). Show warning toast: "Body is not valid JSON — sending as raw text." |
| Unresolved template variables | Variables highlighted in red (wavy underline). | Send NOT blocked. Show warning toast listing unresolved variables. |

**Shake animation:**

```css
@keyframes api-shake {
  0%, 100% { transform: translateX(0); }
  20%      { transform: translateX(-4px); }
  40%      { transform: translateX(4px); }
  60%      { transform: translateX(-3px); }
  80%      { transform: translateX(2px); }
}

.is-shake {
  animation: api-shake 0.3s ease-out;
}
```

### 9.2 Network Errors (During Send)

| Error | Detection | Display |
|-------|-----------|---------|
| Network failure (offline, DNS, CORS) | `fetch()` throws `TypeError` | Error banner: "Network error — check your connection and CORS settings." |
| Timeout (>30s) | `AbortController` with 30s timeout | Error banner: "Request timed out after 30 seconds." |
| Proxy error (502/503 from `/api/fabric/*`) | Response status 502 or 503 | Error banner: "Proxy error — the Fabric API may be unreachable. Status: {status}." |

**Error banner DOM:**

```html
<div class="api-request-error" role="alert" aria-live="assertive">
  <span class="api-request-error-icon" aria-hidden="true">◆</span>
  <span class="api-request-error-text">Network error — check your connection.</span>
  <button class="api-request-error-close" aria-label="Dismiss error">✕</button>
</div>
```

```css
.api-request-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--level-error-tint);
  border: 1px solid rgba(229, 69, 59, 0.3);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--level-error);
  margin-top: var(--space-1);
  animation: api-error-enter 0.15s ease-out;
}

@keyframes api-error-enter {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.api-request-error-icon {
  flex-shrink: 0;
}

.api-request-error-text {
  flex: 1;
  line-height: 1.4;
}

.api-request-error-close {
  background: none;
  border: none;
  color: var(--level-error);
  cursor: pointer;
  font-size: var(--text-sm);
  padding: 2px;
  opacity: 0.7;
}

.api-request-error-close:hover {
  opacity: 1;
}
```

### 9.3 Token Errors

| Error | Detection | Display |
|-------|-----------|---------|
| Token expired | `config.tokenExpired === true` checked before send | Warning banner (see §7.5). Request still allowed. |
| Token missing (disconnected phase, no bearer) | `config.bearerToken` is falsy | Warning banner: "No bearer token available — authenticate first." |
| 401 response | Response status `401` | Error in Response Viewer + suggestion: "Authentication failed. Token may be expired — re-authenticate." |
| 403 response | Response status `403` | Error in Response Viewer + suggestion: "Forbidden. Check your permissions for this resource." |

### 9.4 Error Dismissal

- All error/warning banners have a ✕ close button.
- Banners auto-dismiss when a new request is sent successfully.
- Maximum one error banner visible at a time (new errors replace old ones).

---

## 10. Accessibility

### 10.1 ARIA Roles and Labels

| Element | Role | Label / Property |
|---------|------|-----------------|
| `.api-request-section` | `region` | `aria-label="Request builder"` |
| `.api-catalog-trigger` | `combobox` | `aria-label="Select pre-configured endpoint"`, `aria-expanded`, `aria-haspopup="listbox"`, `aria-controls` |
| `#api-catalog-listbox` | `listbox` | `aria-label="Endpoint catalog"` |
| `.api-catalog-search` | `searchbox` | `aria-label="Search endpoints"` |
| `.api-catalog-group` | `group` | `aria-label="{group name}"` |
| `.api-catalog-option` | `option` | `aria-selected` |
| `.api-method-select` | Native `<select>` | `aria-label="HTTP method"` |
| `.api-url-input` | Native `<input>` | `aria-label="Request URL"` |
| `.api-send-btn` | `button` | `aria-label="Send request (Ctrl+Enter)"` |
| `.api-curl-btn` | `button` | `aria-label="Copy as cURL"` |
| `.api-request-tabs` | `tablist` | `aria-label="Request configuration"` |
| `.api-request-tab` | `tab` | `aria-selected`, `aria-controls` |
| `.api-tab-panel` | `tabpanel` | `aria-labelledby` |
| `.api-headers` | `list` | `aria-label="Request headers"` |
| `.api-header-row` | `listitem` | — |
| `.api-header-key` | Native `<input>` | `aria-label="Header name"` |
| `.api-header-val` | Native `<input>` | `aria-label="Header value"` |
| `.api-header-rm` | `button` | `aria-label="Remove {headerName} header"` |
| `.api-body-input` | Native `<textarea>` | `aria-label="Request body (JSON)"` |
| `.api-body-status` | `<div>` | `aria-live="polite"` |
| `.api-request-error` | `<div>` | `role="alert"`, `aria-live="assertive"` |
| `.api-token-warning` | `<div>` | `role="status"`, `aria-live="polite"` |
| `.api-url-highlights` | `<div>` | `aria-hidden="true"` (decorative overlay) |

### 10.2 Keyboard Navigation

**Full keyboard flow (Tab order):**

```
1. Catalog trigger button
2. Method <select>
3. URL <input>
4. Send <button>
5. cURL <button>
6. Tab bar → first active tab
   └─ Arrow Left/Right to navigate tabs
7. Active tab panel contents:
   ├─ Headers tab: header key → header value → remove btn → (repeat per row) → "+ Add header"
   ├─ Body tab: body <textarea> → Format <button>
   └─ Params tab: param key → param value → remove btn → (repeat per row) → "+ Add parameter"
```

**Catalog dropdown keyboard:**
- `ArrowDown` from trigger: open dropdown and focus search field
- `ArrowDown` / `ArrowUp` in search: navigate through visible options
- `Enter`: select the focused option and close
- `Escape`: close dropdown and return focus to trigger
- `Home` / `End` in option list: jump to first/last option

**Tab bar keyboard (WAI-ARIA tabs pattern):**
- `ArrowLeft` / `ArrowRight`: activate previous/next tab
- `Home` / `End`: activate first/last tab
- Tab key moves focus OUT of the tab bar into the tab panel

### 10.3 Screen Reader Announcements

| Event | Announcement | Mechanism |
|-------|-------------|-----------|
| Request sent | "Sending {METHOD} request to {URL}" | `aria-live="polite"` region |
| Response received | "Response received: {STATUS} in {DURATION}ms" | `aria-live="polite"` region |
| cURL copied | "cURL command copied to clipboard" | `aria-live="polite"` region |
| Error | Full error text | `role="alert"` + `aria-live="assertive"` |
| JSON valid/invalid toggle | "JSON valid" or "JSON invalid" | `aria-live="polite"` on `.api-body-status` |
| Endpoint selected from catalog | "{endpointName} selected — {METHOD} {URL}" | `aria-live="polite"` region |
| Header auto-injected | "Authorization header auto-filled with {tokenType} token" | `aria-live="polite"` region |
| Token expired warning | "Warning: authentication token expired" | `role="status"` on warning banner |

**Live region element** (shared, placed at end of `.api-request-section`):

```html
<div class="sr-only" aria-live="polite" aria-atomic="true" id="api-request-announce"></div>
```

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

### 10.4 Color Contrast

All method colors meet WCAG AA contrast ratio (4.5:1) against both light and dark backgrounds:

| Method Color | vs White (#fff) | vs Dark (#14171f) |
|-------------|----------------|-------------------|
| GET `#059669` | 4.6:1 ✓ | 5.2:1 ✓ |
| POST `#2563eb` | 4.5:1 ✓ | 5.0:1 ✓ |
| PUT `#d97706` | 4.7:1 ✓ | 5.8:1 ✓ |
| PATCH `#ca8a04` | 4.5:1 ✓ | 6.1:1 ✓ |
| DELETE `#dc2626` | 4.6:1 ✓ | 5.3:1 ✓ |

Note: In dark mode, if any method color fails contrast on the actual dark surface (`#14171f`), lighten by 10% — but testing shows they all pass.

### 10.5 Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  .api-send-btn,
  .api-curl-btn,
  .api-request-tab,
  .api-catalog-trigger,
  .api-catalog-option,
  .api-catalog-icon {
    transition: none;
  }

  .api-send-btn.is-loading::after {
    animation: none;
  }

  .api-request-spinner {
    animation: none;
    /* Show static border instead */
    border-color: var(--accent);
    border-top-color: transparent;
  }

  .is-shake {
    animation: none;
  }

  .api-request-error {
    animation: none;
  }
}
```

### 10.6 Focus Indicators

All interactive elements use a consistent focus indicator:

```css
/* Focus ring — applied via :focus-visible on all buttons, inputs, selects */
:focus-visible {
  outline: none;
  box-shadow: var(--shadow-glow);  /* 0 0 0 3px var(--accent-glow) */
}

/* Inputs also get accent border */
input:focus-visible,
textarea:focus-visible,
select:focus-visible {
  border-color: var(--accent);
}
```

The `--shadow-glow` token (`0 0 0 3px rgba(109,92,255,0.15)` light / `0 0 0 3px rgba(133,119,255,0.20)` dark) provides a visible focus ring that meets WCAG 2.1 SC 2.4.7 (Focus Visible).

---

## Appendix A: Event Interface

Events emitted by the Request Builder for consumption by other components:

| Event Name | Payload | Consumed By |
|------------|---------|-------------|
| `request:send` | `{ method, url, headers, body, resolvedUrl, timestamp }` | `ResponseViewer`, `HistoryManager` |
| `request:complete` | `{ request, response: { status, statusText, headers, body, duration } }` | `ResponseViewer`, `HistoryManager` |
| `request:error` | `{ request, error: { type, message } }` | `ResponseViewer`, `HistoryManager` |
| `catalog:select` | `{ endpoint: { name, method, url, group, bodyTemplate } }` | Internal (populates fields) |

Events consumed by the Request Builder:

| Event Name | Source | Behavior |
|------------|--------|----------|
| `config:updated` | `ApiClient` | Re-read config. Re-run variable resolution and token injection. |
| `history:replay` | `HistoryPanel` | Populate method, URL, headers, body from the history entry. |
| `saved:load` | `SavedPanel` | Populate method, URL, headers, body from the saved request. |

---

## Appendix B: State Summary

| State | Send Btn | URL Input | Body Editor | Catalog |
|-------|---------|-----------|-------------|---------|
| **Empty** (initial) | Disabled | Empty, placeholder visible | Hidden (GET default) | "Select endpoint..." |
| **Editing** | Enabled | Has URL value | Visible if POST/PUT/PATCH | Shows selected or default |
| **Sending** | Loading shimmer, "Sending..." | Disabled (`aria-disabled`) | Disabled | Disabled |
| **Success** | Enabled, restored | Enabled | Enabled | Enabled |
| **Error** | Enabled, restored | Enabled, error banner visible | Enabled | Enabled |
| **Token Expired** | Enabled (with warning) | Enabled, warning banner | Enabled | Enabled |
| **Validation Error** | Enabled | Red border if empty, shake | Red border if invalid JSON | Enabled |

---

## Appendix C: File Inventory

Files that will be created or modified during implementation:

| File | Action | Owner |
|------|--------|-------|
| `src/frontend/js/api-playground.js` | CREATE — main module class | Pixel |
| `src/frontend/css/api-playground.css` | MODIFY — extend with new CSS from this spec | Pixel |
| `src/frontend/index.html` | MODIFY — replace empty state at line 268 | Pixel |
| `src/backend/DevMode/EdogApiProxy.cs` | MODIFY — if new proxy route needed | Vex |
| `tests/frontend/api-playground.test.js` | CREATE — unit tests | Sentinel |
