# Response Viewer — Component Spec

> **Status:** DRAFT
> **Owner:** Pixel (Frontend)
> **Reviewer:** Sentinel
> **Depends On:** `spec.md` §3 (Response Viewer), `research/p0-foundation.md` §1 (existing CSS audit)
> **State Matrix:** `../states/response-viewer.md` (to be created in Phase 3)

---

## 1. Component Overview

The Response Viewer is the bottom panel of the API Playground's main area, directly below the Request Builder. It renders the full HTTP response after the engineer sends a request — status code, timing, size, response body, response headers, and cookies.

**Primary responsibilities:**

1. Display HTTP status code as a color-coded badge
2. Show response timing (ms) and payload size (KB)
3. Render the response body in Pretty (collapsible JSON tree) or Raw (pre-formatted) mode
4. List response headers as key-value pairs
5. List response cookies (parsed from `Set-Cookie` headers)
6. Provide "Copy Response" and "Download as File" actions
7. Handle states: empty (no request sent), loading (request in-flight), success, error, truncated (>500KB)

**Design lineage:** Chrome DevTools Network tab response viewer (status + timing + tabs), Postman response panel (Pretty/Raw toggle, timing badge), Insomnia (collapsible JSON, copy actions).

**Module:** `ResponseViewer` class inside `src/frontend/js/api-playground.js` (or extracted to `src/frontend/js/response-viewer.js` if the playground module exceeds 500 lines).

**Existing CSS:** `src/frontend/css/api-playground.css` lines 46–72 provide a scaffold (`.api-response-section`, `.api-response-header`, `.api-response-status`, `.api-response-timing`, `.api-response-body`). This spec extends that scaffold significantly.

---

## 2. Visual Specification

### 2.1 Layout Within API Playground

```
┌──────────────────────────────────────────────────────────────┬──────────┐
│                       REQUEST BUILDER                        │          │
│  [GET ▾] [https://api.fabric.microsoft.com/v1/...________]  │          │
│  [Headers] [Body]                           [Send] [cURL]   │ Sidebar  │
├──────────────────────────────────────────────────────────────┤ (History │
│                       RESPONSE VIEWER                        │  + Saved │
│  ┌─────────────────────────────────────────────────────────┐ │  Reqs)  │
│  │ Status │ Timing │ Size │        [Copy] [Download]       │ │          │
│  ├─────────────────────────────────────────────────────────┤ │          │
│  │ [Body] [Headers] [Cookies]        [Pretty | Raw]       │ │          │
│  ├─────────────────────────────────────────────────────────┤ │          │
│  │                                                         │ │          │
│  │  Response content area                                  │ │          │
│  │  (JSON tree / raw text / header list / cookies)         │ │          │
│  │                                                         │ │          │
│  └─────────────────────────────────────────────────────────┘ │          │
└──────────────────────────────────────────────────────────────┴──────────┘
```

### 2.2 Empty State (No Request Sent Yet)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                                                             │
│                        ▷ Send a request                     │
│                    to see the response here                 │
│                                                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Centered vertically and horizontally. `▷` symbol in `--text-muted`. Text in `--text-muted`, `--text-sm`.

### 2.3 Loading State

```
┌─────────────────────────────────────────────────────────────┐
│  ●●● Sending...                                  [Cancel]   │
├─────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────┐  │
│  │  ████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │  │
│  │  ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │  │
│  │  ████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░  │  │
│  │  ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │  │
│  │  ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Shimmer skeleton lines (reuses project skeleton tokens `--skel-base`, `--skel-shine`, `--skel-speed`). Cancel button aborts the fetch.

### 2.4 Success State — Body Tab (Pretty Mode)

```
┌─────────────────────────────────────────────────────────────┐
│  200 OK   342ms   12.4 KB              [Copy] [Download ▾] │
├─────────────────────────────────────────────────────────────┤
│  [Body]  Headers  Cookies              [Pretty | Raw]       │
├─────────────────────────────────────────────────────────────┤
│  {                                                          │
│    ▸ "workspaces": [ ... 3 items ],                         │
│      "continuationToken": null,                             │
│      "continuationUri": null                                │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
```

Active tab underlined with `--accent`. Status badge has colored background. Timing colored by threshold.

### 2.5 Success State — Body Tab (Raw Mode)

```
┌─────────────────────────────────────────────────────────────┐
│  200 OK   342ms   12.4 KB              [Copy] [Download ▾] │
├─────────────────────────────────────────────────────────────┤
│  [Body]  Headers  Cookies              [Pretty | Raw]       │
├─────────────────────────────────────────────────────────────┤
│  {"workspaces":[{"id":"12345678-1234-1234-1234-123456789abc │
│  ","displayName":"SalesWorkspace","type":"Workspace","capac  │
│  ityId":"ABCDEF12"}],"continuationToken":null,"continuation │
│  Uri":null}                                                 │
└─────────────────────────────────────────────────────────────┘
```

Monospace, `white-space: pre-wrap`. No syntax coloring. No collapsing.

### 2.6 Success State — Headers Tab

```
┌─────────────────────────────────────────────────────────────┐
│  200 OK   342ms   12.4 KB              [Copy] [Download ▾] │
├─────────────────────────────────────────────────────────────┤
│   Body  [Headers]  Cookies             [Pretty | Raw]       │
├─────────────────────────────────────────────────────────────┤
│  content-type          application/json; charset=utf-8      │
│  x-ms-request-id       a1b2c3d4-e5f6-7890-abcd-ef1234567890│
│  x-ms-ratelimit-remaining  99                               │
│  date                  Mon, 14 Apr 2026 18:30:00 GMT        │
│  content-length        12701                                │
└─────────────────────────────────────────────────────────────┘
```

Two-column layout. Header names in `--text-muted` lowercase. Values in `--text`. Click a row to copy `name: value`.

### 2.7 Success State — Cookies Tab

```
┌─────────────────────────────────────────────────────────────┐
│  200 OK   342ms   12.4 KB              [Copy] [Download ▾] │
├─────────────────────────────────────────────────────────────┤
│   Body   Headers  [Cookies]            [Pretty | Raw]       │
├─────────────────────────────────────────────────────────────┤
│  Name      Value                       Domain     HttpOnly  │
│  ─────────────────────────────────────────────────────────  │
│  session   abc123def456                .fabric..  Yes       │
│  _ga       GA1.2.1234567890.1234567890 .microsoft No       │
│  ─────────────────────────────────────────────────────────  │
│  No cookies (if response has no Set-Cookie headers)         │
└─────────────────────────────────────────────────────────────┘
```

### 2.8 Error State

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│          ◆ Network Error                                    │
│                                                             │
│          Could not connect to the server.                   │
│          Check that EDOG dev-server is running              │
│          on port 5555.                                      │
│                                                             │
│          [Retry]                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Red diamond `◆` icon. Error title bold. Description in `--text-muted`. Retry button.

### 2.9 Truncated State (>500KB)

```
┌─────────────────────────────────────────────────────────────┐
│  200 OK   1,842ms   2.1 MB             [Copy] [Download ▾] │
├─────────────────────────────────────────────────────────────┤
│  [Body]  Headers  Cookies              [Pretty | Raw]       │
├─────────────────────────────────────────────────────────────┤
│  {                                                          │
│    ▸ "data": [ ... 10,000 items ],                          │
│    ...                                                      │
│  }                                                          │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│  Response truncated at 500 KB (full size: 2.1 MB)           │
│  [Download Full Response]                                   │
└─────────────────────────────────────────────────────────────┘
```

Amber dashed divider. Truncation notice in `--level-warning` color. Download link saves full response.

---

## 3. DOM Structure

### 3.1 Complete HTML Skeleton

```html
<section class="api-response-section" role="region" aria-label="API Response">

  <!-- Metadata bar: status, timing, size, actions -->
  <div class="api-response-header">
    <span class="api-response-status" role="status" aria-live="polite"
          data-status-class="">
      <!-- e.g., "200 OK" -->
    </span>
    <span class="api-response-timing" aria-label="Response time">
      <!-- e.g., "342ms" -->
    </span>
    <span class="api-response-size" aria-label="Response size">
      <!-- e.g., "12.4 KB" -->
    </span>
    <div class="api-response-actions">
      <button class="api-response-copy-btn" type="button"
              aria-label="Copy response body to clipboard"
              title="Copy response">
        Copy
      </button>
      <button class="api-response-download-btn" type="button"
              aria-label="Download response as file"
              title="Download response">
        Download ▾
      </button>
    </div>
  </div>

  <!-- Tab bar -->
  <div class="api-response-tabs" role="tablist" aria-label="Response sections">
    <button class="api-response-tab active" role="tab"
            id="resp-tab-body" aria-controls="resp-panel-body"
            aria-selected="true" tabindex="0">
      Body
    </button>
    <button class="api-response-tab" role="tab"
            id="resp-tab-headers" aria-controls="resp-panel-headers"
            aria-selected="false" tabindex="-1">
      Headers
    </button>
    <button class="api-response-tab" role="tab"
            id="resp-tab-cookies" aria-controls="resp-panel-cookies"
            aria-selected="false" tabindex="-1">
      Cookies
    </button>

    <!-- Pretty/Raw toggle (visible only when Body tab is active) -->
    <div class="api-response-view-toggle" role="radiogroup"
         aria-label="Response body view mode">
      <button class="api-view-toggle-btn active" role="radio"
              aria-checked="true" data-view="pretty">
        Pretty
      </button>
      <button class="api-view-toggle-btn" role="radio"
              aria-checked="false" data-view="raw">
        Raw
      </button>
    </div>
  </div>

  <!-- Tab panels -->
  <div class="api-response-content">

    <!-- Body panel -->
    <div class="api-response-panel active" role="tabpanel"
         id="resp-panel-body" aria-labelledby="resp-tab-body"
         tabindex="0">

      <!-- Pretty view: JSON tree rendered by JsonTree component -->
      <div class="api-response-pretty" data-active="true">
        <!-- JsonTree component renders here -->
      </div>

      <!-- Raw view: pre-formatted text -->
      <pre class="api-response-raw" data-active="false"
           tabindex="0"><code><!-- raw response text --></code></pre>
    </div>

    <!-- Headers panel -->
    <div class="api-response-panel" role="tabpanel"
         id="resp-panel-headers" aria-labelledby="resp-tab-headers"
         tabindex="0" hidden>
      <table class="api-response-header-table" role="grid"
             aria-label="Response headers">
        <thead class="sr-only">
          <tr>
            <th scope="col">Header Name</th>
            <th scope="col">Header Value</th>
          </tr>
        </thead>
        <tbody>
          <!-- Rows generated dynamically -->
          <!-- <tr class="api-response-header-row" tabindex="0"
                   aria-label="content-type: application/json">
                 <td class="api-response-header-name">content-type</td>
                 <td class="api-response-header-value">application/json</td>
               </tr> -->
        </tbody>
      </table>
    </div>

    <!-- Cookies panel -->
    <div class="api-response-panel" role="tabpanel"
         id="resp-panel-cookies" aria-labelledby="resp-tab-cookies"
         tabindex="0" hidden>
      <table class="api-response-cookie-table" role="grid"
             aria-label="Response cookies">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Value</th>
            <th scope="col">Domain</th>
            <th scope="col">Path</th>
            <th scope="col">HttpOnly</th>
            <th scope="col">Secure</th>
          </tr>
        </thead>
        <tbody>
          <!-- Rows generated dynamically -->
        </tbody>
      </table>
    </div>
  </div>

  <!-- Empty state overlay (visible when no request has been sent) -->
  <div class="api-response-empty" role="status" aria-live="polite">
    <span class="api-response-empty-icon">▷</span>
    <span class="api-response-empty-text">Send a request to see the response here</span>
  </div>

  <!-- Loading state overlay -->
  <div class="api-response-loading" role="status" aria-live="polite"
       aria-label="Sending request" hidden>
    <div class="api-response-loading-header">
      <span class="api-response-loading-dots">●●●</span>
      <span class="api-response-loading-label">Sending...</span>
      <button class="api-response-cancel-btn" type="button"
              aria-label="Cancel request">
        Cancel
      </button>
    </div>
    <div class="api-response-skeleton">
      <div class="skel-line" style="width: 65%"></div>
      <div class="skel-line" style="width: 40%"></div>
      <div class="skel-line" style="width: 80%"></div>
      <div class="skel-line" style="width: 55%"></div>
      <div class="skel-line" style="width: 30%"></div>
    </div>
  </div>

  <!-- Error state overlay -->
  <div class="api-response-error" role="alert" aria-live="assertive" hidden>
    <span class="api-response-error-icon">◆</span>
    <span class="api-response-error-title"><!-- e.g., "Network Error" --></span>
    <span class="api-response-error-desc"><!-- e.g., "Could not connect..." --></span>
    <button class="api-response-retry-btn" type="button">Retry</button>
  </div>

  <!-- Truncation banner (appended to body panel when response > 500KB) -->
  <!-- <div class="api-response-truncation" role="status" aria-live="polite">
    <span class="api-response-truncation-text">
      Response truncated at 500 KB (full size: 2.1 MB)
    </span>
    <button class="api-response-download-full-btn" type="button">
      Download Full Response
    </button>
  </div> -->

</section>
```

### 3.2 Class Naming Convention

All classes prefixed with `api-response-` to namespace within the API Playground feature. This avoids collision with other features.

### 3.3 ARIA Roles Summary

| Element | Role | ARIA Attribute | Purpose |
|---------|------|----------------|---------|
| `.api-response-section` | `region` | `aria-label="API Response"` | Landmark for screen readers |
| `.api-response-status` | `status` | `aria-live="polite"` | Announces status code changes |
| `.api-response-tabs` | `tablist` | `aria-label="Response sections"` | Tab navigation |
| `.api-response-tab` | `tab` | `aria-selected`, `aria-controls` | Individual tab |
| `.api-response-panel` | `tabpanel` | `aria-labelledby` | Tab content |
| `.api-response-view-toggle` | `radiogroup` | `aria-label="Response body view mode"` | Pretty/Raw switch |
| `.api-view-toggle-btn` | `radio` | `aria-checked` | Toggle option |
| `.api-response-empty` | `status` | `aria-live="polite"` | Empty state announcement |
| `.api-response-loading` | `status` | `aria-live="polite"` | Loading announcement |
| `.api-response-error` | `alert` | `aria-live="assertive"` | Error announcement (immediate) |
| `.api-response-header-table` | `grid` | `aria-label="Response headers"` | Header list navigation |
| `.api-response-truncation` | `status` | `aria-live="polite"` | Truncation notice |

---

## 4. CSS Specification

### 4.1 Existing CSS (Already in `api-playground.css`)

The following classes already exist and will be **extended, not replaced**:

| Class | Current Definition | Extensions Needed |
|-------|-------------------|-------------------|
| `.api-response-section` | Flex column, `overflow: hidden`, `background: var(--bg)` | Add `position: relative` for overlay positioning |
| `.api-response-header` | Flex row, gap, padding, border-bottom, surface bg | Add `flex-wrap: wrap`, `min-height: 40px` |
| `.api-response-status` | Padding, radius, mono font, weight 600 | Add `.s1xx`, `.s3xx` variants. Add transition. |
| `.api-response-status.s2xx` | Green tint bg, green text | No change |
| `.api-response-status.s4xx` | Amber tint bg, amber text | No change |
| `.api-response-status.s5xx` | Red tint bg, red text | No change |
| `.api-response-timing` | XS mono text, muted color | Add color variants for timing thresholds |
| `.api-response-body` | Flex 1, overflow auto, mono XS, pre-wrap | Rename content → repurpose as `.api-response-content` |

### 4.2 New CSS Classes — Metadata Bar

```css
/* ── Response metadata bar ── */
.api-response-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  min-height: 40px;
  flex-wrap: wrap;
}

/* Status badge variants */
.api-response-status {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--space-2);
  border-radius: 2px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: 600;
  line-height: 1.4;
  transition: background var(--transition-fast), color var(--transition-fast);
  white-space: nowrap;
  user-select: all;              /* click to select status text */
}

.api-response-status.s1xx {
  background: rgba(107, 114, 128, 0.12);
  color: #6b7280;
}
.api-response-status.s2xx {
  background: rgba(5, 150, 105, 0.12);
  color: #059669;
}
.api-response-status.s3xx {
  background: rgba(37, 99, 235, 0.12);
  color: #2563eb;
}
.api-response-status.s4xx {
  background: rgba(217, 119, 6, 0.12);
  color: #d97706;
}
.api-response-status.s5xx {
  background: rgba(220, 38, 38, 0.12);
  color: #dc2626;
}

/* Dark theme overrides for status badge */
[data-theme="dark"] .api-response-status.s1xx {
  background: rgba(107, 114, 128, 0.20);
  color: #9ca3af;
}
[data-theme="dark"] .api-response-status.s2xx {
  background: rgba(5, 150, 105, 0.20);
  color: #34d399;
}
[data-theme="dark"] .api-response-status.s3xx {
  background: rgba(37, 99, 235, 0.20);
  color: #60a5fa;
}
[data-theme="dark"] .api-response-status.s4xx {
  background: rgba(217, 119, 6, 0.20);
  color: #fbbf24;
}
[data-theme="dark"] .api-response-status.s5xx {
  background: rgba(220, 38, 38, 0.20);
  color: #f87171;
}
```

### 4.3 New CSS Classes — Timing & Size

```css
/* Response timing */
.api-response-timing {
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  line-height: 1.4;
  white-space: nowrap;
}

.api-response-timing.timing-fast {
  color: #059669;            /* green — <500ms */
}
.api-response-timing.timing-medium {
  color: #d97706;            /* amber — 500ms–2000ms */
}
.api-response-timing.timing-slow {
  color: #dc2626;            /* red — >2000ms */
}

[data-theme="dark"] .api-response-timing.timing-fast  { color: #34d399; }
[data-theme="dark"] .api-response-timing.timing-medium { color: #fbbf24; }
[data-theme="dark"] .api-response-timing.timing-slow   { color: #f87171; }

/* Response size */
.api-response-size {
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  color: var(--text-muted);
  line-height: 1.4;
  white-space: nowrap;
}
```

### 4.4 New CSS Classes — Action Buttons

```css
/* Action button group — right-aligned in metadata bar */
.api-response-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.api-response-copy-btn,
.api-response-download-btn {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-dim);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--transition-fast),
              border-color var(--transition-fast),
              color var(--transition-fast);
}

.api-response-copy-btn:hover,
.api-response-download-btn:hover {
  background: var(--surface-3);
  border-color: var(--border-bright);
  color: var(--text);
}

.api-response-copy-btn:focus-visible,
.api-response-download-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-glow);
}

/* Copy success feedback — brief text swap */
.api-response-copy-btn.copied {
  color: #059669;
  border-color: rgba(5, 150, 105, 0.3);
  background: rgba(5, 150, 105, 0.06);
}
[data-theme="dark"] .api-response-copy-btn.copied {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.3);
  background: rgba(52, 211, 153, 0.08);
}

/* Download button hidden when response ≤ 500KB and not explicitly needed */
.api-response-download-btn[hidden] { display: none; }
```

### 4.5 New CSS Classes — Tab Bar

```css
/* Tab bar container */
.api-response-tabs {
  display: flex;
  align-items: center;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  min-height: 32px;
  gap: 0;
}

/* Individual tab buttons */
.api-response-tab {
  padding: var(--space-2) var(--space-3);
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-muted);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--transition-fast),
              border-color var(--transition-fast);
  position: relative;
  top: 1px;                         /* overlap container border */
}

.api-response-tab:hover {
  color: var(--text-dim);
}

.api-response-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.api-response-tab:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-glow);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}

/* Pretty/Raw toggle — right-aligned within tab bar */
.api-response-view-toggle {
  margin-left: auto;
  display: flex;
  align-items: center;
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

/* Hidden when Body tab is not active */
.api-response-view-toggle[hidden] { display: none; }

.api-view-toggle-btn {
  padding: 2px var(--space-2);
  border: none;
  background: none;
  color: var(--text-muted);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition-fast),
              color var(--transition-fast);
  line-height: 1.4;
}

.api-view-toggle-btn:hover {
  background: var(--surface-2);
  color: var(--text-dim);
}

.api-view-toggle-btn.active {
  background: var(--accent-dim);
  color: var(--accent);
  font-weight: 600;
}

.api-view-toggle-btn:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-glow);
}

/* Divider between Pretty and Raw buttons */
.api-view-toggle-btn + .api-view-toggle-btn {
  border-left: 1px solid var(--border-bright);
}
```

### 4.6 New CSS Classes — Content Panels

```css
/* Content area — fills remaining vertical space */
.api-response-content {
  flex: 1;
  overflow: hidden;
  position: relative;
}

/* Individual panel */
.api-response-panel {
  display: none;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--space-3);
}

.api-response-panel.active {
  display: block;
}

/* Pretty view container (JSON tree mounts here) */
.api-response-pretty {
  display: none;
  min-height: 0;
}
.api-response-pretty[data-active="true"] {
  display: block;
}

/* Raw view */
.api-response-raw {
  display: none;
  margin: 0;
  padding: 0;
  background: none;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
  tab-size: 2;
  overflow-x: auto;
}
.api-response-raw[data-active="true"] {
  display: block;
}
.api-response-raw code {
  font-family: inherit;
  font-size: inherit;
  color: inherit;
}
```

### 4.7 New CSS Classes — Headers Table

```css
/* Response headers table */
.api-response-header-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-xs);
}

.api-response-header-table thead.sr-only {
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

.api-response-header-row {
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.api-response-header-row:hover {
  background: var(--surface-2);
}

.api-response-header-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-glow);
}

.api-response-header-name {
  padding: var(--space-1) var(--space-2);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-weight: 500;
  white-space: nowrap;
  vertical-align: top;
  width: 200px;
  max-width: 200px;
  text-transform: lowercase;
}

.api-response-header-value {
  padding: var(--space-1) var(--space-2);
  color: var(--text);
  font-family: var(--font-mono);
  word-break: break-all;
  vertical-align: top;
}
```

### 4.8 New CSS Classes — Cookies Table

```css
/* Response cookies table */
.api-response-cookie-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-xs);
}

.api-response-cookie-table thead th {
  padding: var(--space-1) var(--space-2);
  text-align: left;
  font-weight: 600;
  color: var(--text-muted);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border-bright);
  white-space: nowrap;
}

.api-response-cookie-table tbody td {
  padding: var(--space-1) var(--space-2);
  font-family: var(--font-mono);
  color: var(--text);
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.api-response-cookie-table tbody tr:hover {
  background: var(--surface-2);
}

/* Cookie value — truncate long values */
.api-response-cookie-value {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Boolean columns */
.api-response-cookie-bool {
  color: var(--text-muted);
  text-align: center;
  white-space: nowrap;
}

/* Empty cookies state */
.api-response-cookies-empty {
  padding: var(--space-6);
  text-align: center;
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-style: italic;
}
```

### 4.9 New CSS Classes — Empty State

```css
/* Empty state — centered content */
.api-response-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  z-index: 1;
}

.api-response-empty-icon {
  font-size: 28px;
  color: var(--text-muted);
  opacity: 0.5;
  line-height: 1;
}

.api-response-empty-text {
  font-size: var(--text-sm);
  color: var(--text-muted);
  font-family: var(--font-body);
  text-align: center;
  max-width: 240px;
  line-height: 1.5;
}
```

### 4.10 New CSS Classes — Loading State

```css
/* Loading overlay */
.api-response-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  z-index: 2;
  padding: var(--space-3);
}

.api-response-loading[hidden] { display: none; }

.api-response-loading-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-3);
}

.api-response-loading-dots {
  font-size: var(--text-sm);
  color: var(--accent);
  letter-spacing: 2px;
  animation: resp-dot-pulse 1.2s ease-in-out infinite;
}

@keyframes resp-dot-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.3; }
}

.api-response-loading-label {
  font-size: var(--text-sm);
  color: var(--text-muted);
  font-family: var(--font-body);
}

.api-response-cancel-btn {
  margin-left: auto;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-dim);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition-fast),
              color var(--transition-fast);
}

.api-response-cancel-btn:hover {
  background: var(--surface-3);
  color: var(--level-error);
}

.api-response-cancel-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-glow);
}

/* Skeleton shimmer lines */
.api-response-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) 0;
}

.skel-line {
  height: 12px;
  border-radius: var(--skel-radius);
  background: var(--skel-base);
  background-image: linear-gradient(
    90deg,
    var(--skel-base) 0%,
    var(--skel-shine) 40%,
    var(--skel-shine) 60%,
    var(--skel-base) 100%
  );
  background-size: 200% 100%;
  animation: resp-shimmer var(--skel-speed) ease-in-out infinite;
}

@keyframes resp-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

### 4.11 New CSS Classes — Error State

```css
/* Error overlay */
.api-response-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  z-index: 2;
  background: var(--bg);
  padding: var(--space-6);
}

.api-response-error[hidden] { display: none; }

.api-response-error-icon {
  font-size: 24px;
  color: var(--level-error);
  line-height: 1;
}

.api-response-error-title {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text);
  font-family: var(--font-body);
  text-align: center;
}

.api-response-error-desc {
  font-size: var(--text-sm);
  color: var(--text-muted);
  font-family: var(--font-body);
  text-align: center;
  max-width: 320px;
  line-height: 1.5;
}

.api-response-retry-btn {
  margin-top: var(--space-2);
  padding: var(--space-1) var(--space-4);
  background: var(--accent);
  color: var(--text-on-accent);
  border: none;
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.api-response-retry-btn:hover { opacity: 0.9; }

.api-response-retry-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-glow);
}
```

### 4.12 New CSS Classes — Truncation Banner

```css
/* Truncation notice — appended at bottom of body panel */
.api-response-truncation {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  margin-top: var(--space-3);
  border-top: 2px dashed var(--level-warning);
  background: rgba(217, 119, 6, 0.04);
}

[data-theme="dark"] .api-response-truncation {
  background: rgba(240, 180, 41, 0.06);
}

.api-response-truncation-text {
  font-size: var(--text-xs);
  color: var(--level-warning);
  font-family: var(--font-body);
  flex: 1;
}

.api-response-download-full-btn {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--level-warning);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--level-warning);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--transition-fast);
}

.api-response-download-full-btn:hover {
  background: rgba(217, 119, 6, 0.08);
}

.api-response-download-full-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.2);
}
```

### 4.13 Utility Classes

```css
/* Screen reader only */
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

---

## 5. States

### 5.1 State Machine

```
                    ┌──────────┐
                    │  EMPTY   │ ← initial state
                    └────┬─────┘
                         │ user clicks Send
                    ┌────▾─────┐
              ┌─────│ LOADING  │─────┐
              │     └────┬─────┘     │
              │          │           │
         cancel/     success    error/timeout
         abort          │           │
              │     ┌────▾─────┐    │
              │     │ SUCCESS  │    │
              │     └────┬─────┘    │
              │          │          │
              │    >500KB?     ┌────▾─────┐
              │     ┌────▾──┐  │  ERROR   │
              │     │TRUNC. │  └──────────┘
              │     └───────┘
              │
              └──── returns to EMPTY (no — returns to last state)
```

**State transitions:**

| From | To | Trigger | Visual Change |
|------|----|---------|---------------|
| EMPTY | LOADING | `send()` called | Empty overlay hides, loading overlay shows |
| LOADING | SUCCESS | Fetch resolves with HTTP response | Loading hides, metadata bar + tabs + content show |
| LOADING | ERROR | Fetch rejects (network, CORS, abort) | Loading hides, error overlay shows |
| LOADING | ERROR (timeout) | `AbortController` fires at 30s | Loading hides, timeout error shows |
| LOADING | EMPTY | Cancel clicked | Loading hides, empty overlay shows |
| SUCCESS | LOADING | New `send()` called | Content area replaced by loading |
| SUCCESS + TRUNCATED | LOADING | New `send()` called | Same as above |
| ERROR | LOADING | Retry clicked or new `send()` | Error hides, loading shows |
| ERROR | LOADING | New `send()` called | Same |
| ANY | EMPTY | Explicit reset (clear response) | Everything hides, empty shows |

### 5.2 State: EMPTY

- **Visible elements:** `.api-response-empty` overlay only
- **Hidden elements:** metadata bar, tab bar, content panels, loading, error
- **Screen reader:** `aria-live="polite"` announces "Send a request to see the response here"
- **Entry condition:** Initial render, or user explicitly clears response

### 5.3 State: LOADING

- **Visible elements:** `.api-response-loading` overlay with shimmer skeleton + cancel button
- **Hidden elements:** metadata bar, tab bar, content panels, empty, error
- **Screen reader:** `aria-live="polite"` announces "Sending request"
- **Timing:** Start a `performance.now()` timer for response timing calculation
- **AbortController:** Create new `AbortController`, pass `signal` to `fetch()`
- **Cancel behavior:** Call `controller.abort()`, transition to previous state (EMPTY if first request, or previous SUCCESS/ERROR)
- **Auto-timeout:** `setTimeout` at 30,000ms calls `controller.abort()` with timeout reason

### 5.4 State: SUCCESS

- **Visible elements:** metadata bar (status + timing + size + actions), tab bar, active panel content
- **Hidden elements:** empty overlay, loading overlay, error overlay
- **Screen reader:** `aria-live="polite"` announces "Response received: {status} {statusText}, {timing}ms"
- **Default tab:** Body tab selected, Pretty mode active
- **Data stored:** Full response object retained in memory for tab switching and copy/download

### 5.5 State: ERROR

- **Visible elements:** `.api-response-error` overlay with icon, title, description, retry button
- **Hidden elements:** metadata bar, tab bar, content panels, empty, loading
- **Screen reader:** `aria-live="assertive"` announces error title and description immediately
- **Retry button:** Re-sends the exact same request (method, URL, headers, body)

### 5.6 State: TRUNCATED

- **Base state:** SUCCESS (all metadata bar + tabs visible)
- **Additional element:** `.api-response-truncation` banner appended to bottom of body panel
- **Body content:** First 500KB of response rendered (Pretty or Raw)
- **Full response:** Stored as `Blob` in memory for download
- **Download button:** Always visible in metadata bar when truncated

### 5.7 State: TIMEOUT

- **Subtype of ERROR**
- **Icon:** `◆` (red)
- **Title:** "Request Timed Out"
- **Description:** "The request did not complete within 30 seconds. The server may be slow or unreachable."
- **Retry button:** Present

---

## 6. Tab System

### 6.1 Tab Configuration

| Tab ID | Label | Panel ID | Default | Keyboard Shortcut |
|--------|-------|----------|---------|-------------------|
| `resp-tab-body` | Body | `resp-panel-body` | Yes (selected on load) | — |
| `resp-tab-headers` | Headers | `resp-panel-headers` | No | — |
| `resp-tab-cookies` | Cookies | `resp-panel-cookies` | No | — |

### 6.2 Tab Behavior

**Activation:**
- Click a tab → `aria-selected="true"`, add `.active` class, show corresponding panel
- Previous tab → `aria-selected="false"`, remove `.active`, hide panel (`hidden` attribute)
- Tab panels use `hidden` attribute (not `display: none`) for accessibility

**Pretty/Raw Toggle:**
- Visible only when Body tab is active. Set `hidden` attribute when Body tab is not active.
- Pretty mode: Show `.api-response-pretty`, hide `.api-response-raw`
- Raw mode: Show `.api-response-raw`, hide `.api-response-pretty`
- Toggle state persists across tab switches within the same response (not across new requests)
- Default: Pretty mode

**Keyboard navigation (WAI-ARIA Tabs pattern):**

| Key | Action |
|-----|--------|
| `ArrowRight` | Move focus to next tab (wraps from last to first) |
| `ArrowLeft` | Move focus to previous tab (wraps from first to last) |
| `Home` | Move focus to first tab |
| `End` | Move focus to last tab |
| `Enter` / `Space` | Activate focused tab (tabs use manual activation) |
| `Tab` | Move focus from tab bar into the active panel content |
| `Shift+Tab` | Move focus from panel content back to the active tab |

**Tab index management:**
- Active tab: `tabindex="0"`
- Inactive tabs: `tabindex="-1"`
- Active panel: `tabindex="0"` (receives focus on `Tab` from tab bar)
- Inactive panels: not in tab order (`hidden` attribute)

### 6.3 Pretty/Raw Toggle Keyboard

| Key | Action |
|-----|--------|
| `ArrowRight` / `ArrowLeft` | Move between Pretty and Raw |
| `Enter` / `Space` | Activate the focused option |

Follows WAI-ARIA Radio Group pattern since `role="radiogroup"` is used.

### 6.4 Cookie Count Badge

When the Cookies tab has content, append a count badge:

```html
<button class="api-response-tab" ...>
  Cookies <span class="api-response-tab-badge">3</span>
</button>
```

```css
.api-response-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-left: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-3);
  color: var(--text-muted);
  font-size: 9px;
  font-weight: 600;
  font-family: var(--font-mono);
  line-height: 1;
}
```

---

## 7. Response Metadata

### 7.1 Status Badge

**Data source:** `response.status` (number) and `response.statusText` (string) from the Fetch API Response object.

**Display format:** `{status} {statusText}` — e.g., `200 OK`, `404 Not Found`, `500 Internal Server Error`.

**Status class assignment:**

```javascript
_getStatusClass(status) {
  if (status >= 100 && status < 200) return 's1xx';
  if (status >= 200 && status < 300) return 's2xx';
  if (status >= 300 && status < 400) return 's3xx';
  if (status >= 400 && status < 500) return 's4xx';
  if (status >= 500 && status < 600) return 's5xx';
  return '';
}
```

**Status text fallback:** If `response.statusText` is empty (common in HTTP/2), use a lookup table:

| Code | Fallback Text |
|------|--------------|
| 200 | OK |
| 201 | Created |
| 204 | No Content |
| 301 | Moved Permanently |
| 302 | Found |
| 304 | Not Modified |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 405 | Method Not Allowed |
| 409 | Conflict |
| 429 | Too Many Requests |
| 500 | Internal Server Error |
| 502 | Bad Gateway |
| 503 | Service Unavailable |
| 504 | Gateway Timeout |

For unlisted codes, display the number only (e.g., `418`).

### 7.2 Response Timing

**Measurement:** Record `performance.now()` immediately before `fetch()` call. Record again when response headers arrive (`response` object available). Calculate: `endTime - startTime`.

**Display format:**
- Under 1 second: `{N}ms` (integer, no decimal) — e.g., `342ms`
- 1–10 seconds: `{N.N}s` (one decimal) — e.g., `2.3s`
- Over 10 seconds: `{N}s` (integer) — e.g., `15s`

**Color thresholds:**

| Range | CSS Class | Color (Light) | Color (Dark) |
|-------|-----------|---------------|--------------|
| < 500ms | `.timing-fast` | `#059669` (green) | `#34d399` |
| 500ms – 2000ms | `.timing-medium` | `#d97706` (amber) | `#fbbf24` |
| > 2000ms | `.timing-slow` | `#dc2626` (red) | `#f87171` |

### 7.3 Response Size

**Measurement:** Calculate from `response.headers.get('content-length')` if available. If not (e.g., chunked encoding), calculate from the actual body text: `new Blob([bodyText]).size`.

**Display format:**

| Size | Format | Example |
|------|--------|---------|
| < 1024 bytes | `{N} B` | `512 B` |
| 1 KB – 999.9 KB | `{N.N} KB` (one decimal) | `12.4 KB` |
| 1 MB – 999.9 MB | `{N.N} MB` (one decimal) | `2.1 MB` |

**Size calculation function:**

```javascript
_formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

---

## 8. Content Rendering

### 8.1 Content-Type Detection

Determine rendering strategy from the `Content-Type` response header:

| Content-Type Pattern | Renderer | Pretty Mode |
|---------------------|----------|-------------|
| `application/json`, `*+json` | JSON Tree (Pretty) / Raw text | Yes — collapsible tree |
| `text/html` | Escaped HTML with syntax hints | No — raw only, Pretty disabled |
| `text/xml`, `application/xml`, `*+xml` | Escaped XML with indentation | No — raw only, Pretty disabled |
| `text/plain` | Plain pre-formatted text | No — raw only, Pretty disabled |
| `application/octet-stream` | Binary placeholder message | N/A |
| Other / missing | Plain pre-formatted text | No — raw only, Pretty disabled |

### 8.2 JSON Rendering (Pretty Mode)

Delegates to the **JSON Tree** component (spec: `components/json-tree.md`). The Response Viewer:

1. Parses the response body as JSON: `JSON.parse(bodyText)`
2. If parsing succeeds: passes the parsed object to `JsonTree.render(data, container)`
3. If parsing fails: falls back to Raw mode, shows parse error banner

**JSON parse error banner:**

```html
<div class="api-response-parse-error">
  <span class="api-response-parse-error-icon">◆</span>
  <span class="api-response-parse-error-text">
    Invalid JSON at position {N}: {error.message}
  </span>
</div>
```

```css
.api-response-parse-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-2);
  background: rgba(220, 38, 38, 0.06);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--level-error);
}

.api-response-parse-error-icon {
  color: var(--level-error);
  font-size: var(--text-sm);
  flex-shrink: 0;
}

.api-response-parse-error-text {
  font-size: var(--text-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}
```

**JSON Tree contract (expected interface from `json-tree.md`):**

```javascript
class JsonTree {
  /**
   * @param {*} data — parsed JSON value (object, array, primitive)
   * @param {HTMLElement} container — DOM node to render into
   * @param {Object} [options]
   * @param {number} [options.maxDepth=Infinity] — auto-collapse beyond this depth
   * @param {number} [options.initialCollapsedDepth=2] — collapse nodes deeper than this on first render
   * @param {boolean} [options.copyOnClick=true] — click a value to copy it
   */
  render(data, container, options) { }

  /** Expand all nodes */
  expandAll() { }

  /** Collapse all nodes */
  collapseAll() { }

  /** Destroy and clean up */
  destroy() { }
}
```

### 8.3 JSON Rendering (Raw Mode)

Pretty-print with 2-space indentation:

```javascript
const rawText = JSON.stringify(parsedJson, null, 2);
```

If the body is not valid JSON, show the raw response text as-is.

### 8.4 HTML Rendering

- Show raw HTML source (escaped, not rendered as DOM)
- Use `<pre><code>` wrapper
- No syntax highlighting in V1 (future: basic tag coloring)
- Pretty/Raw toggle disabled (hidden) for HTML responses

### 8.5 XML Rendering

- Show raw XML source
- If not already indented, attempt basic indentation (regex-based, not a full parser):
  - Insert newlines before `</` and `<` tags
  - Apply 2-space indentation per nesting level
- Pretty/Raw toggle disabled for XML responses

### 8.6 Plain Text Rendering

- Show raw text in `<pre><code>` wrapper
- No processing
- Pretty/Raw toggle disabled

### 8.7 Binary / Unknown Content

When `Content-Type` indicates a binary format (e.g., `application/octet-stream`, `image/*`, `application/pdf`):

```html
<div class="api-response-binary">
  <span class="api-response-binary-icon">◇</span>
  <span class="api-response-binary-text">
    Binary response ({contentType}, {size})
  </span>
  <button class="api-response-download-btn">Download</button>
</div>
```

```css
.api-response-binary {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  color: var(--text-muted);
}

.api-response-binary-icon {
  font-size: 28px;
  opacity: 0.5;
}

.api-response-binary-text {
  font-size: var(--text-sm);
  font-family: var(--font-body);
}
```

### 8.8 Empty Body (204 No Content / 0-byte response)

When the response body is empty:

```html
<div class="api-response-no-body">
  <span class="api-response-no-body-text">No response body</span>
</div>
```

```css
.api-response-no-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-8);
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-style: italic;
  font-family: var(--font-body);
}
```

---

## 9. Truncation Logic

### 9.1 Threshold

**Constant:** `RESPONSE_TRUNCATION_LIMIT = 512000` (500 KB = 500 × 1024 bytes)

### 9.2 Detection

After receiving the full response body text:

```javascript
const bodyText = await response.text();
const bodySize = new Blob([bodyText]).size;

if (bodySize > RESPONSE_TRUNCATION_LIMIT) {
  this._handleTruncatedResponse(bodyText, bodySize);
} else {
  this._handleNormalResponse(bodyText, bodySize);
}
```

### 9.3 Truncated Response Handling

1. **Store full response** as a `Blob` in memory: `this._fullResponseBlob = new Blob([bodyText], { type: contentType })`
2. **Truncate for display:** Take the first 500KB of the string: `bodyText.substring(0, RESPONSE_TRUNCATION_LIMIT)`
3. **JSON truncation caveat:** If the body is JSON, the truncated string will be invalid JSON. In this case:
   - Pretty mode: Show parse error banner + truncation notice. Do NOT attempt to render partial JSON in the tree.
   - Raw mode: Show the truncated raw text (valid or not). Append `\n... [truncated]` at the end.
4. **Show truncation banner** (`.api-response-truncation`) at the bottom of the body panel
5. **Show Download button** in metadata bar (always visible for truncated responses)

### 9.4 Size Display for Truncated Responses

The `.api-response-size` element shows the **full** response size (not truncated size). This is important so the engineer knows the actual payload size.

### 9.5 Download Full Response

When "Download Full Response" (truncation banner) or "Download" (metadata bar) is clicked:

```javascript
_downloadResponse() {
  const blob = this._fullResponseBlob || new Blob([this._bodyText], { type: this._contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = this._generateFilename();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

### 9.6 Filename Generation

```javascript
_generateFilename() {
  const ext = this._getExtensionForContentType(this._contentType);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `response-${timestamp}${ext}`;
}

_getExtensionForContentType(contentType) {
  if (!contentType) return '.txt';
  if (contentType.includes('json')) return '.json';
  if (contentType.includes('xml'))  return '.xml';
  if (contentType.includes('html')) return '.html';
  if (contentType.includes('csv'))  return '.csv';
  return '.txt';
}
```

Example filename: `response-2026-04-14T18-30-00.json`

---

## 10. Copy/Download Actions

### 10.1 Copy Response

**What is copied:** Depends on the active tab.

| Active Tab | Copy Content |
|-----------|-------------|
| Body (Pretty) | Pretty-printed JSON (`JSON.stringify(parsed, null, 2)`) or raw body text if not JSON |
| Body (Raw) | Raw response body text |
| Headers | All headers as `name: value\n` pairs |
| Cookies | All cookies as `name=value; domain=...; path=...\n` pairs |

**Implementation:**

```javascript
async _copyResponse() {
  const text = this._getCopyText();
  try {
    await navigator.clipboard.writeText(text);
    this._showCopyFeedback();
  } catch (err) {
    // Fallback for older browsers / non-HTTPS
    this._fallbackCopy(text);
  }
}
```

**Copy feedback:**

1. Button text changes from "Copy" to "Copied" (or from icon to checkmark if using icons)
2. Button gets `.copied` class (green tint)
3. After 2000ms, revert to original state

```javascript
_showCopyFeedback() {
  const btn = this._copyBtn;
  const originalText = btn.textContent;
  btn.textContent = 'Copied';
  btn.classList.add('copied');
  clearTimeout(this._copyTimeout);
  this._copyTimeout = setTimeout(() => {
    btn.textContent = originalText;
    btn.classList.remove('copied');
  }, 2000);
}
```

**Fallback copy** (for environments where `navigator.clipboard` is unavailable):

```javascript
_fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
  this._showCopyFeedback();
}
```

### 10.2 Download Response

**Visibility rules:**
- **Always visible** when response is truncated (>500KB)
- **Visible on hover/focus** of the metadata bar for non-truncated responses (optional UX improvement)
- **Always visible** if the response size exceeds 100KB (even if not truncated, large responses benefit from download)

**Download behavior:** See §9.5 for implementation.

**Dropdown menu (Download ▾):**

When clicked, show a small dropdown with options:

| Option | Action |
|--------|--------|
| Download as {ext} | Download with auto-detected extension |
| Download as .txt | Force download as plain text |
| Download as .json | Force download as JSON (even if content-type is not JSON) |

```css
.api-response-download-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 2px;
  min-width: 160px;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  z-index: var(--z-dropdown);
  padding: var(--space-1) 0;
}

.api-response-download-menu[hidden] { display: none; }

.api-response-download-option {
  display: block;
  width: 100%;
  padding: var(--space-1) var(--space-3);
  border: none;
  background: none;
  color: var(--text);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.api-response-download-option:hover {
  background: var(--surface-2);
}

.api-response-download-option:focus-visible {
  outline: none;
  background: var(--accent-dim);
  color: var(--accent);
}
```

---

## 11. Error States

### 11.1 Error Classification

The Response Viewer must distinguish between different failure modes and present targeted messaging:

| Error Type | Detection | Title | Description | Retry? |
|-----------|-----------|-------|-------------|--------|
| Network Error | `fetch()` throws `TypeError` | Network Error | Could not connect to the server. Check that EDOG dev-server is running on port 5555. | Yes |
| CORS Blocked | `fetch()` throws with opaque response or `TypeError` + no `response.status` | CORS Blocked | The server did not include CORS headers. Try routing through the EDOG proxy (/api/fabric/*). | Yes |
| Timeout | `AbortController` signal aborted after 30s | Request Timed Out | The request did not complete within 30 seconds. The server may be slow or unreachable. | Yes |
| Abort (user) | `AbortController` signal aborted by user cancel | *(no error shown)* | *(returns to previous state)* | N/A |
| DNS Failure | `fetch()` throws `TypeError` + name resolution hint | DNS Resolution Failed | Could not resolve hostname. Check the URL and your network connection. | Yes |
| Token Expired | HTTP 401 response with expired token indicator | Token Expired | Your authentication token has expired. Refresh it to continue. | Yes (with "Refresh Token" action) |

### 11.2 Error Detection Logic

```javascript
async _sendRequest(method, url, headers, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), 30000);

  this._showLoading();

  try {
    const startTime = performance.now();
    const response = await fetch(url, {
      method,
      headers,
      body: body || undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const endTime = performance.now();
    const timing = Math.round(endTime - startTime);

    const bodyText = await response.text();
    this._showSuccess(response, bodyText, timing);
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      if (err.message === 'timeout' || controller.signal.reason === 'timeout') {
        this._showError('timeout');
      } else {
        // User cancelled — return to previous state
        this._restorePreviousState();
      }
    } else if (err instanceof TypeError) {
      // Network error or CORS
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
        this._showError('network');
      } else {
        this._showError('network');
      }
    } else {
      this._showError('unknown', err.message);
    }
  }
}
```

### 11.3 CORS Error Disambiguation

CORS errors in the browser are intentionally opaque (security). The Response Viewer cannot definitively distinguish CORS from network errors. Heuristic:

1. If the URL starts with `http://` or `https://` and does NOT start with `/api/` (not proxied), AND the error is a `TypeError`, assume CORS.
2. If the URL starts with `/api/` (proxied through EDOG), assume network error.
3. Display the CORS message with the suggestion to use the proxy.

### 11.4 Token Expired Error

When the response status is 401:

```javascript
_isTokenExpired(response) {
  const wwwAuth = response.headers.get('www-authenticate') || '';
  return response.status === 401 && (
    wwwAuth.includes('expired') ||
    wwwAuth.includes('invalid_token')
  );
}
```

If detected, show a specialized error:

- **Title:** "Token Expired"
- **Description:** "Your authentication token has expired. Refresh it to continue."
- **Actions:** [Retry] [Refresh Token]
- "Refresh Token" triggers `window.dispatchEvent(new CustomEvent('edog:refresh-token'))` which the main app handles

### 11.5 0-Byte Response (Successful but Empty)

**NOT an error.** A response with status 200/204 and empty body is a valid success case. Render as:

- Status badge: `200 OK` or `204 No Content` (green)
- Timing: measured normally
- Size: `0 B`
- Body tab: Shows "No response body" placeholder (see §8.8)
- Headers/Cookies tabs: Still show any returned headers/cookies

---

## 12. Loading Animation

### 12.1 Skeleton Shimmer

Uses the project's standard skeleton loading pattern (from `variables.css`):

**Tokens used:**
- `--skel-base`: Background color for skeleton lines (`#e8eaef` light / `#1e2230` dark)
- `--skel-shine`: Shimmer highlight color (`rgba(255,255,255,0.5)` light / `rgba(255,255,255,0.06)` dark)
- `--skel-speed`: Animation duration (`1.5s`)
- `--skel-radius`: Border radius for skeleton lines (`6px`)

**Skeleton layout:**
- 5 horizontal lines of varying widths to suggest content shape
- Line heights: 12px
- Line widths: 65%, 40%, 80%, 55%, 30% (staggered to look natural)
- Gap between lines: `var(--space-2)` (8px)
- Lines animate with `resp-shimmer` keyframes (gradient slide left to right)

### 12.2 Dot Pulse Animation

The `●●●` dots in the loading header pulse with `resp-dot-pulse` keyframes:

```
@keyframes resp-dot-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.3; }
}
```

- Duration: 1.2s
- Easing: `ease-in-out`
- Repeat: `infinite`
- Color: `var(--accent)` (purple)

### 12.3 Elapsed Timer (Optional Enhancement)

While loading, show elapsed time next to "Sending...":

```
●●● Sending... 2.3s                                [Cancel]
```

Updated every 100ms via `requestAnimationFrame` or `setInterval`:

```javascript
_startElapsedTimer() {
  this._loadingStart = performance.now();
  this._elapsedInterval = setInterval(() => {
    const elapsed = performance.now() - this._loadingStart;
    this._loadingLabel.textContent = `Sending... ${(elapsed / 1000).toFixed(1)}s`;
  }, 100);
}

_stopElapsedTimer() {
  clearInterval(this._elapsedInterval);
  this._elapsedInterval = null;
}
```

### 12.4 Transition Between States

| Transition | Animation |
|-----------|-----------|
| EMPTY → LOADING | Empty overlay fades out (`opacity 1→0`, 80ms), loading overlay fades in (`opacity 0→1`, 80ms) |
| LOADING → SUCCESS | Loading overlay fades out, metadata bar + tab bar + content appear immediately (no fade — instant for perceived speed) |
| LOADING → ERROR | Loading overlay fades out, error overlay fades in |
| SUCCESS → LOADING | Content area replaced instantly by loading overlay (no fade — user expects immediate feedback) |

```css
.api-response-empty,
.api-response-loading,
.api-response-error {
  transition: opacity var(--transition-fast);
}

/* State toggle via JS: add/remove .is-visible class */
.api-response-empty:not(.is-visible),
.api-response-loading:not(.is-visible),
.api-response-error:not(.is-visible) {
  opacity: 0;
  pointer-events: none;
}
```

---

## 13. Accessibility

### 13.1 ARIA Live Regions

| Element | `aria-live` | When Announced | Announcement Text |
|---------|-------------|---------------|-------------------|
| `.api-response-status` | `polite` | Response received | "{status} {statusText}" (e.g., "200 OK") |
| `.api-response-empty` | `polite` | Initial render / clear | "Send a request to see the response here" |
| `.api-response-loading` | `polite` | Request sent | "Sending request" |
| `.api-response-error` | `assertive` | Error occurred | "{errorTitle}. {errorDescription}" |
| `.api-response-truncation` | `polite` | Truncated response | "Response truncated at 500 KB. Download link available." |

### 13.2 Keyboard Navigation Map

**Full keyboard flow through the Response Viewer:**

```
1. [Tab from Request Builder] → Focus enters metadata bar
2. Metadata bar: Copy button → Download button (Tab order)
3. [Tab] → Focus enters tab bar (first tab or active tab)
4. Tab bar: ArrowLeft/ArrowRight to move between tabs
5. [Tab] → Focus enters Pretty/Raw toggle (if Body tab active)
6. Toggle: ArrowLeft/ArrowRight to switch Pretty/Raw
7. [Tab] → Focus enters active panel content
8. Panel content:
   - JSON tree: arrow keys to navigate nodes, Enter to expand/collapse
   - Headers table: arrow keys to move between rows, Enter to copy
   - Cookies table: arrow keys to move between rows
9. [Tab] → Focus exits Response Viewer to next focusable element
```

### 13.3 Focus Management on State Changes

| State Change | Focus Target |
|-------------|-------------|
| EMPTY → LOADING | Cancel button receives focus |
| LOADING → SUCCESS | Status badge receives focus (screen reader announces status) |
| LOADING → ERROR | Error title receives focus (screen reader announces via `aria-live="assertive"`) |
| ERROR → LOADING (Retry) | Cancel button receives focus |
| Tab switch | Active panel receives focus |

### 13.4 Screen Reader Announcements

Use a visually-hidden live region for supplementary announcements:

```html
<div class="sr-only" role="status" aria-live="polite" id="resp-sr-announce">
  <!-- Dynamic announcements injected here -->
</div>
```

Announcements:

| Event | Text |
|-------|------|
| Response received | "Response received: 200 OK, 342 milliseconds, 12.4 kilobytes" |
| Response error | "Request failed: Network Error" |
| Copy success | "Response copied to clipboard" |
| Download started | "Response download started" |
| Tab switched | "Switched to Headers tab" (supplement for tabs that aren't auto-announced) |

### 13.5 Color Contrast

All status badge colors meet WCAG 2.1 AA contrast ratio (4.5:1 for text):

| Badge | Foreground | Background | Contrast (Light) | Contrast (Dark) |
|-------|-----------|-----------|-------------------|-----------------|
| 1xx | `#6b7280` | `rgba(107,114,128,0.12)` | 5.0:1 vs white | 5.2:1 vs dark |
| 2xx | `#059669` | `rgba(5,150,105,0.12)` | 4.6:1 vs white | 7.1:1 vs dark |
| 3xx | `#2563eb` | `rgba(37,99,235,0.12)` | 4.7:1 vs white | 5.4:1 vs dark |
| 4xx | `#d97706` | `rgba(217,119,6,0.12)` | 4.5:1 vs white | 8.2:1 vs dark |
| 5xx | `#dc2626` | `rgba(220,38,38,0.12)` | 5.1:1 vs white | 5.7:1 vs dark |

### 13.6 Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  .api-response-loading-dots {
    animation: none;
    opacity: 1;
  }

  .skel-line {
    animation: none;
    background-image: none;
  }

  .api-response-empty,
  .api-response-loading,
  .api-response-error {
    transition: none;
  }
}
```

### 13.7 High Contrast Mode

```css
@media (forced-colors: active) {
  .api-response-status {
    border: 1px solid currentColor;
  }

  .api-response-tab.active {
    border-bottom-color: LinkText;
  }

  .api-response-copy-btn,
  .api-response-download-btn,
  .api-response-cancel-btn,
  .api-response-retry-btn {
    border: 1px solid ButtonText;
  }

  .skel-line {
    background: GrayText;
    animation: none;
  }
}
```

---

## 14. API Surface (Public Methods)

The `ResponseViewer` class exposes these methods to the parent `ApiPlayground` module:

```javascript
class ResponseViewer {
  /**
   * @param {HTMLElement} container — the .api-response-section element
   */
  constructor(container) { }

  /**
   * Show loading state. Called by ApiPlayground when Send is clicked.
   * @returns {AbortController} — caller can abort the request
   */
  showLoading() { }

  /**
   * Show success state with response data.
   * @param {Response} response — Fetch API Response object
   * @param {string} bodyText — full response body as text
   * @param {number} timingMs — request duration in milliseconds
   */
  showSuccess(response, bodyText, timingMs) { }

  /**
   * Show error state.
   * @param {'network'|'cors'|'timeout'|'token-expired'|'unknown'} type
   * @param {string} [message] — additional error message
   */
  showError(type, message) { }

  /**
   * Reset to empty state.
   */
  reset() { }

  /**
   * Set the retry callback (called when Retry button is clicked).
   * @param {Function} callback
   */
  onRetry(callback) { }

  /**
   * Clean up event listeners and timers.
   */
  destroy() { }
}
```

---

## 15. Edge Cases

### 15.1 Rapid Sequential Requests

If the user clicks Send while a previous request is still in flight:
1. Abort the previous request via its `AbortController`
2. Do NOT show an error for the aborted request
3. Show loading for the new request
4. The aborted request's response (if it arrives) is discarded

### 15.2 Response with No Content-Type Header

Treat as `text/plain`. Show raw text in the body panel.

### 15.3 Response with Content-Type Mismatch

If the `Content-Type` says `application/json` but the body is not valid JSON:
1. Show the JSON parse error banner
2. Fall back to Raw mode
3. Pretty mode is disabled (toggle button grayed out)

### 15.4 Very Long Header Values

Header values that exceed the panel width wrap naturally (`word-break: break-all`). No truncation.

### 15.5 Many Headers (>20)

All headers are rendered. No virtualization needed (headers rarely exceed 50 rows).

### 15.6 Unicode in Response Body

The raw view uses `white-space: pre-wrap` which correctly handles Unicode. The JSON tree must also handle Unicode strings (emoji, CJK, RTL text). No special handling needed — browser rendering handles this natively.

### 15.7 Large JSON Trees (>1000 nodes)

Delegated to the JSON Tree component (see `json-tree.md`). The Response Viewer's responsibility is limited to:
1. Checking body size against truncation threshold
2. Passing the parsed object to `JsonTree.render()`
3. The JSON Tree handles virtualization internally

### 15.8 Concurrent Responses (Future: Batch Runner)

In V1, only one response is displayed at a time. The batch runner (V2+) will need a response list view. The Response Viewer's `showSuccess()` API is designed to accept a single response — the batch runner will create multiple `ResponseViewer` instances or a `ResponseList` wrapper.

---

## 16. Performance Budget

| Metric | Target |
|--------|--------|
| Time to render response (< 50KB body) | < 50ms |
| Time to render response (50KB–500KB body) | < 200ms |
| Time to render truncated response (>500KB) | < 100ms (only first 500KB rendered) |
| Copy to clipboard | < 50ms |
| Tab switch | < 16ms (single frame) |
| Memory: stored response | 1× body size (raw text) + 1× parsed object (JSON only) + 1× Blob (truncated only) |

---

## 17. Dependencies

| Dependency | Type | Notes |
|-----------|------|-------|
| `JsonTree` component | Internal | Renders JSON body in Pretty mode. See `components/json-tree.md`. |
| `variables.css` | CSS tokens | All spacing, color, typography, skeleton tokens |
| `api-playground.css` | CSS scaffold | Existing styles extended by this spec |
| `api-client.js` | Data | Token retrieval for auto-fill (not used directly by Response Viewer) |
| Fetch API | Browser | Native `fetch()` for HTTP requests |
| Clipboard API | Browser | `navigator.clipboard.writeText()` for copy |
| Blob API | Browser | `new Blob()` for size calculation and download |
| URL API | Browser | `URL.createObjectURL()` for download |

---

## 18. Test Expectations

The state matrix (`../states/response-viewer.md`) will define exact test scenarios. Key areas:

| Area | Test Count (Est.) | Key Scenarios |
|------|-------------------|---------------|
| State transitions | 8 | EMPTY→LOADING, LOADING→SUCCESS, LOADING→ERROR, LOADING→CANCEL, etc. |
| Status badge | 6 | 1xx/2xx/3xx/4xx/5xx classes, empty statusText fallback |
| Timing colors | 3 | <500ms green, 500-2000ms amber, >2000ms red |
| Size formatting | 4 | Bytes, KB, MB, 0 bytes |
| Tab switching | 4 | Body/Headers/Cookies activation, Pretty/Raw toggle |
| Keyboard nav | 6 | Tab bar arrows, toggle arrows, Enter activation, focus management |
| Copy | 3 | Body copy, headers copy, clipboard fallback |
| Download | 3 | Auto-detected extension, forced extension, truncated download |
| Truncation | 3 | >500KB detection, banner display, download full |
| Error states | 5 | Network, CORS, timeout, token expired, unknown |
| Content types | 5 | JSON, HTML, XML, plain text, binary |
| JSON parse error | 2 | Invalid JSON, content-type mismatch |
| Accessibility | 5 | ARIA live announcements, keyboard flow, focus management |
| Edge cases | 4 | Rapid requests, no content-type, empty body, unicode |

**Total estimated tests: ~57**
