# Response Viewer — State Matrix

> **Feature:** F09 — API Playground
> **Component:** `ResponseViewer` (bottom panel of the API Playground main area)
> **Total states:** 11
> **Author:** Pixel (Frontend Engineer)
> **Depends On:** `spec.md` §Request/Response lifecycle
> **Status:** SPEC COMPLETE

---

## Table of Contents

1. [State Inventory](#1-state-inventory)
2. [State Transition Diagram](#2-state-transition-diagram)
3. [State Matrix Table](#3-state-matrix-table)
4. [Compound States](#4-compound-states)
5. [Edge Cases](#5-edge-cases)

---

## Legend

Each state entry in the matrix follows this structure:

| Field              | Description                                                  |
|--------------------|--------------------------------------------------------------|
| **State**          | Unique state identifier                                      |
| **Trigger (enter)**| What causes entry into this state                            |
| **Visual Changes** | Exact UI description — badge color, layout, content          |
| **Actions Available** | All buttons/interactions the user can perform              |
| **Trigger (exit)** | What causes exit from this state                             |
| **Notes**          | Implementation details, caveats, edge-case handling          |

---

## 1. State Inventory

1. **`empty`** — No request has been sent yet; the viewer shows a centered placeholder.
2. **`loading`** — A request is in flight; shimmer skeleton animates over the content area.
3. **`success-2xx`** — HTTP 200–299 received; green status badge, full response rendered.
4. **`redirect-3xx`** — HTTP 300–399 received; blue/cyan status badge, redirect info shown.
5. **`client-error-4xx`** — HTTP 400–499 received; amber/orange status badge, error body shown.
6. **`server-error-5xx`** — HTTP 500–599 received; red status badge, error body shown.
7. **`network-error`** — Connection-level failure (no HTTP status); error icon and message.
8. **`cors-blocked`** — CORS error detected (opaque response or `TypeError`); explanation card shown.
9. **`timeout`** — Request exceeded the 30 s timeout; elapsed time shown with retry option.
10. **`truncated`** — Response body exceeds 500 KB; partial render with download link.
11. **`parse-error`** — Content-Type declares JSON but body is not valid JSON; raw body with error.

---

## 2. State Transition Diagram

```
                          ┌──────────┐
                          │  empty   │ ◄── initial state
                          └────┬─────┘
                               │ user clicks "Send"
                               ▾
           ┌───────────────────────────────────────────┐
           │              loading                      │
           │  (cancels any previous in-flight request) │
           └───┬──────┬──────┬──────┬──────┬──────┬────┘
               │      │      │      │      │      │
      HTTP 2xx │ 3xx  │ 4xx  │ 5xx  │ net  │ cors │  timeout
               │      │      │      │ err  │ err  │
               ▾      ▾      ▾      ▾      ▾      ▾      ▾
        ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
        │success-  │ │redirect- │ │client-   │ │server-   │
        │  2xx     │ │  3xx     │ │error-4xx │ │error-5xx │
        └──────────┘ └──────────┘ └──────────┘ └──────────┘
               ┌──────────┐ ┌──────────┐ ┌──────────┐
               │ network- │ │  cors-   │ │ timeout  │
               │  error   │ │ blocked  │ │          │
               └──────────┘ └──────────┘ └──────────┘

        ── overlay modifiers (can combine with response states) ──

               ┌──────────┐       ┌──────────┐
               │truncated │       │parse-    │
               │(>500 KB) │       │error     │
               └──────────┘       └──────────┘

        ── any response/error state ──▸ loading (user sends new request)

Detailed transitions:

  ┌────────────────────────────────────────────────────────────────┐
  │                                                                │
  │  empty ───[Send]───▸ loading                                   │
  │                                                                │
  │  loading ──┬──[HTTP 200–299]───────▸ success-2xx               │
  │            ├──[HTTP 300–399]───────▸ redirect-3xx              │
  │            ├──[HTTP 400–499]───────▸ client-error-4xx          │
  │            ├──[HTTP 500–599]───────▸ server-error-5xx          │
  │            ├──[fetch threw]────────▸ network-error             │
  │            ├──[opaque / TypeError]─▸ cors-blocked              │
  │            └──[30 s elapsed]───────▸ timeout                   │
  │                                                                │
  │  success-2xx ──────[body > 500 KB]──▸ success-2xx + truncated  │
  │  success-2xx ──────[invalid JSON]───▸ success-2xx + parse-error│
  │  client-error-4xx ─[invalid JSON]───▸ client-error-4xx        │
  │                                        + parse-error           │
  │                                                                │
  │  (any non-empty state) ──[Send]───▸ loading                    │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘
```

**Key observations:**
- `empty` is the only initial state — entered once at component construction.
- `loading` is the single gateway state; all response/error states transition FROM `loading`.
- All non-empty states can transition back to `loading` when the user sends a new request.
- `truncated` and `parse-error` are overlay modifiers — they combine with a response state, never appear alone.

---

## 3. State Matrix Table

| State | Trigger (enter) | Visual Changes | Actions Available | Trigger (exit) | Notes |
|-------|-----------------|----------------|-------------------|----------------|-------|
| **`empty`** | Component constructed; no request sent yet. | Centered placeholder in content area: muted icon (64×64 px, `--color-text-tertiary`) depicting a response/document outline. Below icon: "Send a request to see the response" in `--color-text-secondary` (14 px, 400 weight). Status bar hidden. Tab bar visible but dimmed (Body, Headers, Cookies). No badge, no timing, no size. Background: `--color-surface-primary`. | None — viewer is passive. Tabs are visible but clicking them is a no-op (no data to show). | User clicks "Send" in the Request Builder → `loading`. | Remains in this state until the very first request. After any request completes, the viewer never returns to `empty` — it shows the last response. |
| **`loading`** | User clicks "Send" or presses `Ctrl+Enter` in the Request Builder. If a previous request was in flight, it is aborted first (`AbortController.abort()`). | Shimmer/skeleton animation fills the content area: 4–6 horizontal placeholder bars (12 px height, `--color-surface-tertiary`, opacity oscillates 0.3–0.6 over 1.5 s). Status bar appears: left side shows spinner (16 px animated SVG) + "Sending..." in `--color-text-secondary`. Badge area blank. Timing shows elapsed counter ticking (e.g., "0.3 s"). Size shows "—". Tab bar visible, all tabs disabled (`pointer-events: none`, opacity 0.5). Previous response content cleared. | **Cancel** — abort the in-flight request (returns to previous response state or `empty` if first request). | HTTP response received → one of `success-2xx`, `redirect-3xx`, `client-error-4xx`, `server-error-5xx`. Fetch threw → `network-error`. Opaque response / TypeError → `cors-blocked`. 30 s timer fires → `timeout`. User cancels → previous state. | The elapsed timer starts at 0 on entry and is captured as final timing when a response arrives. Previous response data is discarded on entry. |
| **`success-2xx`** | HTTP response status 200–299 received from fetch. | **Status badge:** Green background (`oklch(0.75 0.18 145)`), white text, shows status code + reason (e.g., "200 OK", "201 Created", "204 No Content"). **Timing:** final elapsed time in ms (e.g., "142 ms"). **Size:** response body size in KB (e.g., "3.2 KB"), or "0 B" for empty body. **Tabs:** Body (active by default), Headers, Cookies — all enabled. **Body tab:** Pretty mode (default) renders JSON tree with collapsible nodes, syntax-highlighted keys/values. Raw mode shows monospace plain text. **Headers tab:** key-value list of response headers, zebra-striped rows. **Cookies tab:** parsed Set-Cookie headers in a table (Name, Value, Domain, Path, Expires, Secure, HttpOnly). | **Copy Response** — copies body text to clipboard. **Download as File** — saves body as `.json` or `.txt`. **Pretty/Raw toggle** — switches body rendering mode. **Collapse All / Expand All** — in Pretty mode, controls JSON tree. **Tab switching** — Body, Headers, Cookies. **Search in response** (`Ctrl+F`) — filters/highlights in body. | User clicks "Send" → `loading`. | If Content-Type is not `application/json`, Body tab defaults to Raw mode. Pretty mode is only available for JSON responses. |
| **`redirect-3xx`** | HTTP response status 300–399 received. | **Status badge:** Blue/cyan background (`oklch(0.72 0.14 230)`), white text, shows code + reason (e.g., "301 Moved Permanently", "302 Found", "304 Not Modified"). **Timing and size** displayed as in `success-2xx`. **Headers tab:** `Location` header row highlighted with accent background (`oklch(0.72 0.14 230 / 0.15)`) and a trailing arrow icon (▸) indicating redirect target. **Body tab:** shows redirect body if present (often empty HTML or JSON). **Cookies tab:** shows Set-Cookie if present. | **Copy Response** — copies body. **Download as File** — saves body. **Pretty/Raw toggle** — if body is JSON. **Copy Location URL** — copies the Location header value. **Tab switching** and **Search**. | User clicks "Send" → `loading`. | 304 Not Modified has no body — Body tab shows "No content (304)" message. The `Location` header highlight is the key differentiator from `success-2xx`. |
| **`client-error-4xx`** | HTTP response status 400–499 received. | **Status badge:** Amber/orange background (`oklch(0.78 0.16 75)`), dark text (`#1a1a0a`), shows code + reason (e.g., "400 Bad Request", "401 Unauthorized", "403 Forbidden", "404 Not Found", "422 Unprocessable Entity", "429 Too Many Requests"). **Timing and size** displayed. **Body tab:** shows error response body — often a JSON error object with `message`, `code`, `details` fields. Pretty mode highlights error fields in amber. **Headers tab:** standard list, `WWW-Authenticate` header highlighted for 401. **Cookies tab:** standard. | **Copy Response** — copies body. **Download as File**. **Pretty/Raw toggle**. **Tab switching** and **Search**. | User clicks "Send" → `loading`. | 401 errors may include a `WWW-Authenticate` header hint — highlight it in the Headers tab. 429 may include `Retry-After` — show as a note above the body: "Retry after N seconds". |
| **`server-error-5xx`** | HTTP response status 500–599 received. | **Status badge:** Red background (`oklch(0.65 0.22 25)`), white text, shows code + reason (e.g., "500 Internal Server Error", "502 Bad Gateway", "503 Service Unavailable"). **Timing and size** displayed. **Body tab:** shows error response body. If body contains a stack trace (detected by multiline text with "at " lines), render in monospace with `--color-surface-secondary` background and left red border (4 px). Otherwise render as standard body (Pretty/Raw). **Headers tab and Cookies tab:** standard. | **Copy Response** — copies body. **Download as File**. **Pretty/Raw toggle** (if JSON). **Copy Stack Trace** — visible only when stack trace detected. **Tab switching** and **Search**. | User clicks "Send" → `loading`. | Stack trace detection: search body for lines matching `/^\s+at\s+/m`. If ≥ 3 lines match, render as stack trace block. |
| **`network-error`** | `fetch()` threw an error (not an HTTP response). Common causes: `ECONNREFUSED`, `ENETUNREACH`, DNS resolution failure, `ERR_CONNECTION_RESET`. | **Status bar:** No badge (no HTTP status). Shows error icon (⚠, 16 px, `--color-danger`) + "Network Error" in red text. Timing shows elapsed time until failure. Size shows "—". **Content area:** Centered error card (max-width 400 px, `--color-surface-secondary` background, 8 px border-radius). Error icon (48 px, `--color-danger`). Title: "Connection Failed" (16 px, 600 weight). Message: the error string (e.g., "ECONNREFUSED 127.0.0.1:5000") in monospace, `--color-text-secondary`. Suggestion text below: "Check that the server is running and accessible." **Tabs:** all disabled — no response data exists. | **Retry** — re-sends the identical request (equivalent to clicking "Send" again). **Copy Error** — copies the error message string. | User clicks "Send" or "Retry" → `loading`. | No tab content is available because no HTTP response was received. The Retry button is a convenience — it fires the same request configuration. |
| **`cors-blocked`** | `fetch()` returned an opaque response (`response.type === 'opaque'`) or threw a `TypeError` with a CORS-related message. | **Status bar:** No badge. Shows shield icon (🛡 as inline SVG, 16 px, `--color-warning`) + "CORS Blocked" in amber text. Timing shows elapsed time. Size shows "—". **Content area:** CORS explanation card (max-width 480 px, `--color-surface-secondary` background, amber left border 4 px). Title: "Cross-Origin Request Blocked" (16 px, 600 weight). Body text (14 px): "The browser blocked this request due to CORS policy. The target server does not include the required `Access-Control-Allow-Origin` header." **Suggestion box** (inset card, `--color-surface-tertiary`): "▸ If you control the server, add CORS headers. ▸ Use a proxy or tunnel to bypass CORS in development." **Tabs:** all disabled. | **Retry** — re-sends the request. **Copy Error** — copies the CORS explanation. | User clicks "Send" or "Retry" → `loading`. | CORS detection heuristic: `response.type === 'opaque'` (from `no-cors` mode) OR `TypeError` message contains "CORS" or "Failed to fetch" when the request was cross-origin. |
| **`timeout`** | Internal 30 s timer (`setTimeout`) fires before `fetch()` resolves. The in-flight request is aborted via `AbortController.abort()`. | **Status bar:** No badge. Shows clock icon (⏱ as inline SVG, 16 px, `--color-warning`) + "Timeout" in amber text. Timing shows "30,000 ms" (the timeout threshold). Size shows "—". **Content area:** Centered timeout card (max-width 400 px). Clock icon (48 px, `--color-warning`). Title: "Request Timed Out" (16 px, 600 weight). Message: "The request did not receive a response within 30 seconds." in `--color-text-secondary`. Elapsed time: "Elapsed: 30.0 s" in monospace. **Tabs:** all disabled. | **Retry** — re-sends the identical request. **Copy Error** — copies timeout message. | User clicks "Send" or "Retry" → `loading`. | The 30 s timeout is configurable via a future settings panel but hardcoded for now. The abort signal is shared with the `fetch()` call — the browser cancels the TCP connection. |
| **`truncated`** | Response body size exceeds 500 KB (512,000 bytes). Applied as an overlay modifier on top of `success-2xx`, `client-error-4xx`, or `server-error-5xx`. | **Banner** at the top of the Body tab content: amber background strip (`oklch(0.78 0.16 75 / 0.15)`), 40 px height. Left: warning icon (▲) + "Response truncated — showing first 500 KB of {totalSize}". Right: "Download full response" link (underlined, `--color-accent`). **Body content:** rendered normally for the first 500 KB. Content is cut at the last complete line/JSON-node boundary. A subtle fade-to-transparent gradient at the bottom (last 48 px). **Headers and Cookies tabs:** unaffected — full data shown. | **Download full response** — saves the complete body as a file. **Copy Response** — copies only the truncated (visible) portion. All other actions from the parent state remain. | User clicks "Send" → `loading`. Download link is always available. | Truncation boundary: cut at the last newline (`\n`) before 512,000 bytes to avoid splitting a line. For JSON Pretty mode, collapse all nodes beyond the 500 KB point. |
| **`parse-error`** | Response `Content-Type` header includes `application/json` (or `+json` suffix) but `JSON.parse()` throws a `SyntaxError`. Applied as an overlay on `success-2xx` or `client-error-4xx`. | **Banner** at top of Body tab: red-tinted background strip (`oklch(0.65 0.22 25 / 0.12)`), 40 px height. Left: error icon (✕) + "JSON parse error: {error.message}" (e.g., "Unexpected token < at position 0"). Right: "Showing raw body" label. **Body content:** forced to Raw mode — monospace text, no Pretty toggle available. Raw body displayed in full. Pretty/Raw toggle is replaced with a disabled "Pretty" button and tooltip: "Cannot parse — body is not valid JSON". **Headers and Cookies tabs:** unaffected. | **Copy Response** — copies raw body text. **Download as File** — saves raw body. **Tab switching** and **Search**. Pretty mode disabled. | User clicks "Send" → `loading`. | Common cause: server returns HTML error page (e.g., nginx 502) with `Content-Type: application/json`. The parse error message from `SyntaxError` is shown verbatim. |

---

## 4. Compound States

### 4.1 Overlay Modifier Model

`truncated` and `parse-error` are **overlay modifiers** — they do not replace the parent HTTP response state but augment it. The parent state controls the status badge, timing, and size. The overlay adds a banner and modifies Body tab behavior.

### 4.2 Compatibility Matrix

Which overlays can combine with which response states:

| Parent State         | + `truncated` | + `parse-error` | + `truncated` + `parse-error` |
|----------------------|:-------------:|:----------------:|:-----------------------------:|
| `empty`              |       ✕       |        ✕         |               ✕               |
| `loading`            |       ✕       |        ✕         |               ✕               |
| `success-2xx`        |       ✓       |        ✓         |               ✓               |
| `redirect-3xx`       |       ✓       |        ✕         |               ✕               |
| `client-error-4xx`   |       ✓       |        ✓         |               ✓               |
| `server-error-5xx`   |       ✓       |        ✕         |               ✕               |
| `network-error`      |       ✕       |        ✕         |               ✕               |
| `cors-blocked`       |       ✕       |        ✕         |               ✕               |
| `timeout`            |       ✕       |        ✕         |               ✕               |

**Rules:**
- `truncated` can apply to any state that has a response body (`success-2xx`, `redirect-3xx`, `client-error-4xx`, `server-error-5xx`).
- `parse-error` can apply only when the response claims `Content-Type: application/json` but the body is invalid. In practice this occurs with `success-2xx` and `client-error-4xx`. Server errors (5xx) typically return HTML error pages and do not claim JSON content type; redirects (3xx) rarely have JSON bodies.
- `truncated` + `parse-error` together: the body is >500 KB AND not valid JSON. Show both banners (truncated banner above parse-error banner). Raw mode forced. Download link available.

### 4.3 Pretty/Raw Mode Interaction

The Body tab has a Pretty/Raw toggle. This is an orthogonal state that combines with any response state:

| Parent State         | Pretty Mode Available | Raw Mode Available | Default Mode |
|----------------------|:---------------------:|:------------------:|:------------:|
| `success-2xx`        | ✓ (if JSON)           | ✓                  | Pretty       |
| `redirect-3xx`       | ✓ (if JSON)           | ✓                  | Raw          |
| `client-error-4xx`   | ✓ (if JSON)           | ✓                  | Pretty       |
| `server-error-5xx`   | ✓ (if JSON)           | ✓                  | Raw          |
| any + `parse-error`  | ✕ (forced off)        | ✓                  | Raw          |
| any + `truncated`    | ✓ (partial tree)      | ✓                  | Raw          |

**Pretty mode** requires:
1. Content-Type includes `application/json` or `+json`.
2. `JSON.parse()` succeeds (no `parse-error` overlay).
3. If `truncated`, only the truncated portion is parsed — nodes beyond the cut point are collapsed.

### 4.4 Tab Availability by State

| State                | Body Tab | Headers Tab | Cookies Tab |
|----------------------|:--------:|:-----------:|:-----------:|
| `empty`              | disabled | disabled    | disabled    |
| `loading`            | disabled | disabled    | disabled    |
| `success-2xx`        | ✓        | ✓           | ✓           |
| `redirect-3xx`       | ✓        | ✓           | ✓           |
| `client-error-4xx`   | ✓        | ✓           | ✓           |
| `server-error-5xx`   | ✓        | ✓           | ✓           |
| `network-error`      | disabled | disabled    | disabled    |
| `cors-blocked`       | disabled | disabled    | disabled    |
| `timeout`            | disabled | disabled    | disabled    |

Tabs are disabled for error states that produce no HTTP response (`network-error`, `cors-blocked`, `timeout`). The error card replaces the entire tabbed content area.

---

## 5. Edge Cases

### 5.1 New Request While Loading

**Scenario:** User clicks "Send" while a previous request is still in flight.

**Behavior:**
1. The previous request's `AbortController` is called with `.abort()`.
2. The fetch promise rejects with `AbortError` — this is NOT treated as a `network-error`.
3. The `loading` state restarts: elapsed timer resets to 0, skeleton re-renders.
4. The new request proceeds independently.

**Invariant:** At most one request is in flight at any time.

### 5.2 Zero-Byte Response Body

**Scenario:** HTTP 200 or 204 response with `Content-Length: 0` or empty body.

**Behavior:**
- Status badge shows normally (e.g., "204 No Content" or "200 OK").
- Size shows "0 B".
- Body tab shows centered message: "Empty response body" in `--color-text-tertiary`.
- Pretty/Raw toggle hidden (nothing to render).
- Headers and Cookies tabs function normally.

### 5.3 Binary / Non-Text Response

**Scenario:** Response Content-Type is `image/png`, `application/octet-stream`, `application/pdf`, etc.

**Behavior:**
- Status badge and timing render normally.
- Body tab shows: "Binary response ({Content-Type})" in `--color-text-secondary`.
- Below that: file size and a "Download" button.
- No inline preview — the content is not rendered in the Body tab.
- Pretty/Raw toggle hidden.
- Headers and Cookies tabs function normally.

### 5.4 Partial Response + Network Error

**Scenario:** Server starts sending a response (headers + partial body) but the connection drops mid-transfer.

**Behavior:**
- `fetch()` rejects with a network error after the `Response` object was created.
- If headers were received, show `network-error` state but include a secondary note: "Partial response received — {bytesReceived} bytes before connection lost."
- Headers tab may be available (if headers were fully received).
- Body tab disabled (partial body is unreliable).

### 5.5 Boundary Status Codes

Status codes at category boundaries are classified strictly by range:

| Code | Range    | State              | Badge Color  |
|------|----------|--------------------|--------------|
| 199  | < 200    | — (not expected)   | grey         |
| 200  | 200–299  | `success-2xx`      | green        |
| 299  | 200–299  | `success-2xx`      | green        |
| 300  | 300–399  | `redirect-3xx`     | blue/cyan    |
| 399  | 300–399  | `redirect-3xx`     | blue/cyan    |
| 400  | 400–499  | `client-error-4xx` | amber/orange |
| 499  | 400–499  | `client-error-4xx` | amber/orange |
| 500  | 500–599  | `server-error-5xx` | red          |
| 599  | 500–599  | `server-error-5xx` | red          |

Codes outside 100–599 (e.g., non-standard 999) are treated as `server-error-5xx` with a grey badge and the text "{code} Unknown Status".

### 5.6 Missing Content-Type Header

**Scenario:** Response has no `Content-Type` header at all.

**Behavior:**
- Attempt to detect content type by inspecting the first bytes of the body:
  - If the body starts with `{` or `[` (after trimming whitespace), attempt `JSON.parse()`. If it succeeds, treat as JSON and enable Pretty mode.
  - Otherwise, treat as plain text (Raw mode only).
- Headers tab shows all received headers (Content-Type row absent).
- No `parse-error` overlay is applied since the server did not claim JSON — if the sniffed JSON parse fails, simply show Raw mode without an error banner.

### 5.7 Recovery from Error States

**Scenario:** The viewer is in `network-error`, `cors-blocked`, or `timeout` and the user clicks "Send" (or "Retry") to send a new request.

**Behavior:**
1. State transitions to `loading` immediately.
2. The error card is replaced by the shimmer skeleton.
3. If the new request succeeds, the viewer enters the appropriate response state.
4. If the new request also fails, the viewer enters the new error state (which may be the same or different).
5. There is no "error history" — only the latest result is shown.

**Invariant:** The viewer always reflects the most recent request/response cycle. Previous results are not preserved or accessible.

---

## State Count Summary

| Category         | States | IDs                                                            |
|------------------|:------:|----------------------------------------------------------------|
| Initial          |   1    | `empty`                                                        |
| Transient        |   1    | `loading`                                                      |
| HTTP response    |   4    | `success-2xx`, `redirect-3xx`, `client-error-4xx`, `server-error-5xx` |
| Non-HTTP error   |   3    | `network-error`, `cors-blocked`, `timeout`                     |
| Overlay modifier |   2    | `truncated`, `parse-error`                                     |
| **Total**        | **11** |                                                                |
