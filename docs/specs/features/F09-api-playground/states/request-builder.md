# Request Builder — State Matrix

> **Feature:** F09 — API Playground
> **Component:** `RequestBuilder`
> **States:** 13
> **Author:** Pixel (Frontend) + Sana (Architecture)
> **Status:** SPEC — READY FOR REVIEW
> **Date:** 2025-07-28
> **Parent:** `ApiPlayground` class, mounted inside `#view-api .api-main`
> **Children:** None (leaf component). Emits events consumed by `ResponseViewer` and `HistoryManager`.
> **Source:** `src/frontend/js/api-playground.js`, `src/frontend/css/api-playground.css`
> **Depends On:** `../components/request-builder.md`, `../spec.md` §3, `../research/p0-foundation.md` §1–§5

---

## 1. State Inventory

| # | State | Description |
|---|-------|-------------|
| S01 | `idle` | Empty form, ready for input. Initial state after mount. |
| S02 | `editing` | User is typing in URL, headers, or body. Any field focused or modified. |
| S03 | `endpoint-selected` | Endpoint from catalog auto-populated all fields (method, URL, headers, body template). |
| S04 | `sending` | Request in flight. Send button shows spinner, all inputs disabled. |
| S05 | `validating` | Pre-send validation running (missing URL, invalid JSON body, missing auth). |
| S06 | `validation-error` | Validation failed. Shake animation on invalid fields, error highlights, inline messages. |
| S07 | `token-expired` | Auth token expired mid-session. Refresh prompt banner visible. |
| S08 | `no-config` | `/api/flt/config` unavailable. Template variables cannot expand. Limited functionality warning. |
| S09 | `method-GET` | GET selected. Body tab hidden. |
| S10 | `method-POST` | POST selected. Body tab visible, Content-Type auto-set to `application/json`. |
| S11 | `method-PUT` | PUT selected. Body tab visible, Content-Type auto-set to `application/json`. |
| S12 | `method-PATCH` | PATCH selected. Body tab visible, Content-Type auto-set to `application/json`. |
| S13 | `method-DELETE` | DELETE selected. Body tab hidden. |

---

## 2. State Transition Diagram

```
                          ┌─────────────────────────────────────────────────────────────┐
                          │              METHOD STATES (always one active)               │
                          │                                                             │
                          │  ┌───────────┐  ┌────────────┐  ┌───────────┐               │
                          │  │ method-GET │  │ method-POST│  │ method-PUT│               │
                          │  │   (S09)    │  │   (S10)    │  │   (S11)   │               │
                          │  └─────┬─────┘  └─────┬──────┘  └─────┬─────┘               │
                          │        │              │               │                     │
                          │        │◄── dropdown ──┤◄── dropdown ──┤                     │
                          │        │── selection ──►│── selection ──►                     │
                          │        │              │               │                     │
                          │  ┌─────┴──────┐  ┌────┴────────┐                            │
                          │  │method-PATCH│  │method-DELETE│                             │
                          │  │   (S12)    │  │    (S13)    │                             │
                          │  └────────────┘  └─────────────┘                            │
                          │                                                             │
                          │  All method states interconnect via dropdown selection.      │
                          │  Any method ──[select method]──► Any other method.           │
                          └─────────────────────────────────────────────────────────────┘
                                              │ (always active alongside states below)
                                              │
    ┌─────────────────────────────────────────────────────────────────────────────────────────┐
    │                           PRIMARY LIFECYCLE STATES                                      │
    │                                                                                         │
    │                                                                                         │
    │   ┌───────┐  field focus   ┌─────────┐  click Send   ┌────────────┐                     │
    │   │ idle  │───────────────►│ editing │───────────────►│ validating │                     │
    │   │ (S01) │                │  (S02)  │◄──────────────┐│   (S05)    │                     │
    │   └───┬───┘                └────┬────┘  clear all    └──────┬─────┘                     │
    │       │                         │       fields              │                           │
    │       │  select endpoint        │                      ┌────┴────┐                      │
    │       │                         │                      │         │                      │
    │       │                    ┌────┴──────────────┐  pass │    fail │                      │
    │       │                    │ endpoint-selected │       │         │                      │
    │       └───────────────────►│      (S03)        │       │    ┌────┴────────────┐         │
    │                            └────┬──────────────┘       │    │validation-error │         │
    │                                 │                      │    │     (S06)       │         │
    │                                 │ user edits           │    └────┬────────────┘         │
    │                                 │ any field            │         │                      │
    │                                 ▼                      │         │ user fixes            │
    │                            ┌──────────┐                │         │ invalid fields        │
    │                            │ editing  │◄───────────────┘─────────┘                      │
    │                            │  (S02)   │                                                 │
    │                            └────┬─────┘                                                 │
    │                                 │                                                       │
    │                            (validation passed)                                          │
    │                                 │                                                       │
    │                                 ▼                                                       │
    │                            ┌──────────┐   response     ┌──────────┐                     │
    │                            │ sending  │───received─────►│ editing  │                     │
    │                            │  (S04)   │   or error      │  (S02)   │                     │
    │                            └──────────┘                └──────────┘                     │
    │                                                                                         │
    └─────────────────────────────────────────────────────────────────────────────────────────┘

    ┌─────────────────────────────────────────────────────────────────────────────────────────┐
    │                           OVERLAY STATES (independent layer)                            │
    │                                                                                         │
    │   ┌───────────────┐                          ┌─────────────┐                            │
    │   │ token-expired │                          │  no-config  │                            │
    │   │    (S07)      │                          │    (S08)    │                            │
    │   └───────┬───────┘                          └──────┬──────┘                            │
    │           │                                         │                                   │
    │           │ Can activate/deactivate at any           │ Can activate/deactivate at any    │
    │           │ time, independently of primary           │ time, independently of primary    │
    │           │ lifecycle states above.                  │ lifecycle states above.            │
    │           │                                         │                                   │
    │           │ ──[token expires]──► active              │ ──[config fetch fails]──► active  │
    │           │ ──[token refreshed]──► inactive          │ ──[config becomes avail]──► off   │
    │           │                                         │                                   │
    └─────────────────────────────────────────────────────────────────────────────────────────┘

    Detailed primary-state transitions:

    idle ──[field focus / keystroke]──────────────────────────────► editing
    idle ──[select endpoint from catalog]────────────────────────► endpoint-selected
    editing ──[click Send / Ctrl+Enter]──────────────────────────► validating
    editing ──[select endpoint from catalog]─────────────────────► endpoint-selected
    editing ──[clear all fields / reset]─────────────────────────► idle
    endpoint-selected ──[user edits any field]───────────────────► editing
    endpoint-selected ──[click Send / Ctrl+Enter]────────────────► validating
    endpoint-selected ──[select different endpoint]──────────────► endpoint-selected
    validating ──[all checks pass]───────────────────────────────► sending
    validating ──[any check fails]───────────────────────────────► validation-error
    validation-error ──[user fixes all invalid fields]───────────► editing
    validation-error ──[user clicks Send again]──────────────────► validating
    sending ──[response received / network error / timeout]──────► editing
    sending ──[token expires during send]────────────────────────► editing + token-expired
```

---

## 3. State Matrix Table

### 3.1 Primary Lifecycle States

| State | Trigger (enter) | Visual Changes | Actions Available | Trigger (exit) | Notes |
|-------|-----------------|----------------|-------------------|----------------|-------|
| **S01: idle** | Component mount; user clicks "Clear" / "Reset" | Empty URL input with placeholder "Enter request URL or select an endpoint...". Method dropdown shows GET. Tab bar shows Headers (empty, 0 count) and Params tabs. Body tab hidden (GET default). Send button enabled but muted (`oklch(0.55 0 0)` gray). cURL button (`⧉`) disabled. No validation indicators. Endpoint catalog dropdown shows "Select endpoint..." | Select endpoint from catalog; click method dropdown; focus URL field; type in URL; click any tab; keyboard shortcut `Ctrl+N` (new request) | Field focus or keystroke → `editing`; endpoint selected → `endpoint-selected` | Default method is GET. Auth header not yet injected (no URL to match against). Config template variables not relevant until URL contains `{...}` placeholders. |
| **S02: editing** | User focuses or types in any input field (URL, header key/value, body textarea, params) | Active field has `oklch(0.7 0.15 250)` blue focus ring (2px). URL input shows typed text. Header count badge updates in tab bar (e.g., "Headers (3)"). If body tab open and content typed, JSON validity indicator appears: green `●` for valid, red `●` for invalid. Template variables in URL highlighted with `oklch(0.8 0.15 85)` amber background when `/api/flt/config` is available. Send button fully opaque and primary-colored. cURL button enabled. | Click Send (`Ctrl+Enter`); click cURL copy (`⧉`); add/remove headers; switch tabs (Headers / Body / Params); change method; select endpoint from catalog; format body JSON (`Ctrl+Shift+F`); clear all fields; undo (`Ctrl+Z`) / redo (`Ctrl+Shift+Z`) | Click Send → `validating`; select endpoint → `endpoint-selected`; clear all → `idle` | Most time is spent here. Body tab visibility depends on current method state. Auto-complete suggestions appear for header names (common Fabric headers). Template variable expansion happens on blur or on Send. |
| **S03: endpoint-selected** | User selects an endpoint from the catalog dropdown | All fields flash briefly with `oklch(0.9 0.05 250)` highlight to indicate auto-population. Method dropdown updates (e.g., POST). URL field populated with full path including template variables (e.g., `/v1/workspaces/{workspaceId}/items`). Headers auto-populated with required headers for this endpoint. Body tab appears if method is POST/PUT/PATCH with a JSON template pre-filled. Body template variables shown in amber highlight. Catalog dropdown shows selected endpoint name with `●` indicator. Toast: "Endpoint loaded: Create Item" (2s auto-dismiss). | Edit any populated field; click Send; click cURL copy; switch tabs; select a different endpoint; clear all fields; modify auto-populated headers | User edits any field → `editing`; click Send → `validating`; select different endpoint → `endpoint-selected` (re-populate) | Selecting an endpoint overwrites ALL current fields without confirmation. This is intentional — the catalog is a starting point, not a merge. If the user has unsaved edits, a subtle "Fields replaced" indicator appears. Auth header is auto-injected based on URL pattern matching. |
| **S04: sending** | Validation passes and fetch is initiated | Send button text changes to spinner animation (CSS `@keyframes spin`, 16px inline SVG). Send button disabled (`pointer-events: none`, `oklch(0.45 0 0)` dimmed). All input fields get `readonly` attribute. URL input, header inputs, body textarea all dimmed to `oklch(0.7 0 0)` text color. Tab switching still allowed (read-only viewing). Method dropdown disabled. Endpoint catalog disabled. A thin progress bar animates across the top of `.api-request-section` (`oklch(0.7 0.15 250)` blue, indeterminate). Elapsed time counter appears next to Send button: "1.2s..." | Switch tabs (read-only); cancel request (if supported — `AbortController`); view current headers/body (read-only) | Response received → `editing`; network error → `editing` (with error emitted to ResponseViewer); timeout (30s default) → `editing` (with timeout error); token expires during send → `editing` + `token-expired` overlay | Request is made via `fetch()` with `AbortController`. The response (status, headers, body, timing) is emitted as `api:response` event consumed by `ResponseViewer`. On error, an `api:error` event is emitted instead. Elapsed time measured via `performance.now()`. Fields return to full opacity and editability on exit. |
| **S05: validating** | User clicks Send button or presses `Ctrl+Enter` | Brief validation pass (< 50ms typically, synchronous). No visible UI change — this state is transient. If validation takes observable time (async token check), a subtle pulse animation appears on the Send button. | None — transient state, no user interaction possible | All checks pass → `sending`; any check fails → `validation-error` | Validation checks (in order): (1) URL is non-empty, (2) URL is well-formed (no spaces, valid path), (3) if body tab visible, body is valid JSON (or empty), (4) if auth required, token is present and not expired, (5) no duplicate header keys. Each check produces a specific error message. Validation is fail-fast — first failure stops the chain. |
| **S06: validation-error** | Any validation check fails during `validating` | Invalid fields highlighted with `oklch(0.65 0.25 25)` red border (2px). CSS shake animation on first invalid field (150ms, `translateX(±4px)`). Inline error message appears directly below each invalid field in `oklch(0.65 0.25 25)` red text (12px). If URL empty: "URL is required" below URL input. If invalid JSON: "Invalid JSON: [parse error detail]" below body textarea, with line/column reference. If missing auth: "Authorization header required for this endpoint" below headers section. Send button shows error state — red tint for 1s, then returns to normal. Error count badge on relevant tab: e.g., "Body (1 error)". | Fix invalid fields (typing clears error on that field); click Send again (re-validates); switch tabs to see errors on other tabs; change method; select endpoint (overwrites and clears errors) | User fixes all invalid fields → `editing`; user clicks Send again → `validating` (re-run); select endpoint → `endpoint-selected` (clears errors) | Errors are cleared per-field as the user types (debounced 300ms). If all errors are resolved, the state automatically transitions to `editing`. The shake animation only plays on the *first* validation failure — subsequent Send clicks show errors without re-shaking. Tab badges persist until the error in that tab is fixed. |

### 3.2 Overlay States

| State | Trigger (enter) | Visual Changes | Actions Available | Trigger (exit) | Notes |
|-------|-----------------|----------------|-------------------|----------------|-------|
| **S07: token-expired** | Auth token TTL exceeded; 401 response received from a send attempt; `auth:token-expired` event from auth module | Amber warning banner appears at the top of `.api-request-section`: "Authorization token expired. [Refresh token]" with `oklch(0.85 0.18 85)` amber background and `oklch(0.3 0 0)` text. Send button disabled with tooltip "Token expired — refresh to continue". Auth header value in headers tab shows `[EXPIRED]` badge in red. Inputs remain editable (user can still compose request). cURL copy still works (generates cURL with expired token and a `# WARNING: token expired` comment). | Click [Refresh token] button (triggers re-auth flow); edit fields (composing next request); copy cURL; select endpoint; switch method | Token refreshed successfully → overlay removed, return to underlying state; user navigates away from API Playground | This is an overlay — it coexists with `idle`, `editing`, `endpoint-selected`, or `validation-error`. The banner persists across method switches and endpoint selections. If the user clicks Send while token-expired, the `validating` state catches it and produces a "missing auth" validation error (check #4). Refresh flow uses the same Playwright-based token acquisition from `auth-manager.js`. |
| **S08: no-config** | Fetch to `/api/flt/config` returns error (404, 500, network error); FLT not running; disconnected phase | Amber info banner below the endpoint catalog row: "FLT config unavailable — template variables will not expand. Connect to FLT to enable full functionality." with `oklch(0.9 0.1 85)` light amber background. Template variable placeholders in URL (e.g., `{workspaceId}`) render as plain text with dashed underline instead of amber highlight. Tooltip on hover over any `{...}` variable: "Variable cannot be resolved — FLT config not available". Endpoint catalog still works but populated templates will contain unexpanded `{...}` variables. A small `⚠` icon appears next to the URL input. | All normal actions available (edit, send, copy cURL, select endpoint). User can manually replace `{...}` placeholders with actual values. Retry config fetch via "Retry" link in banner. | Config becomes available (successful fetch or `config:updated` event) → overlay removed, template variables expand, banner dismissed with fade-out | This state is expected during the Disconnected phase (before FLT is running). The user can still make requests — they just need to manually fill in IDs. When config becomes available, any `{...}` variables in the current URL are immediately expanded. The banner includes a "Dismiss" link to hide it (sets a session flag, banner reappears on next mount). |

### 3.3 Method States

| State | Trigger (enter) | Visual Changes | Actions Available | Trigger (exit) | Notes |
|-------|-----------------|----------------|-------------------|----------------|-------|
| **S09: method-GET** | Component mount (default); user selects GET from method dropdown | Method dropdown displays "GET" with `oklch(0.7 0.15 145)` green accent. Tab bar shows: Headers, Params. **Body tab hidden** — removed from DOM, not just hidden (no residual body content sent). If switching from POST/PUT/PATCH, body content is *preserved in memory* but not visible. Content-Type header auto-removed if it was auto-set. | All standard editing actions; switch method; send request; copy cURL (no `--data` flag) | Select POST → `method-POST`; select PUT → `method-PUT`; select PATCH → `method-PATCH`; select DELETE → `method-DELETE` | GET is the default method on mount. Body content preserved in memory when switching away from body-capable methods, so switching GET → POST → GET → POST retains the body. URL params tab parsing: if URL contains `?key=value`, the Params tab auto-populates. |
| **S10: method-POST** | User selects POST from method dropdown | Method dropdown displays "POST" with `oklch(0.7 0.15 250)` blue accent. Tab bar shows: Headers, **Body**, Params. Body tab becomes visible (if previously hidden). Content-Type header auto-injected: `application/json` (if not already present). If switching from GET/DELETE, body tab appears with either restored content (if previously edited) or empty textarea with placeholder "Enter request body (JSON)...". JSON validity indicator visible at bottom of body area. | All standard editing actions; type in body textarea; format JSON (`Ctrl+Shift+F`); switch method; send request; copy cURL (includes `--data` flag with body) | Select GET → `method-GET`; select PUT → `method-PUT`; select PATCH → `method-PATCH`; select DELETE → `method-DELETE` | Auto-injected Content-Type has a small `auto` badge to distinguish it from user-set headers. User can change or remove it. If body is empty on Send, the request is still sent as POST with empty body (valid HTTP). |
| **S11: method-PUT** | User selects PUT from method dropdown | Method dropdown displays "PUT" with `oklch(0.7 0.18 55)` orange accent. Tab bar shows: Headers, **Body**, Params. Behavior identical to POST for body visibility and Content-Type auto-injection. | Same as `method-POST` | Select GET → `method-GET`; select POST → `method-POST`; select PATCH → `method-PATCH`; select DELETE → `method-DELETE` | PUT semantics imply full resource replacement. No UI distinction from POST other than method label and color — the user is responsible for the correct body shape. |
| **S12: method-PATCH** | User selects PATCH from method dropdown | Method dropdown displays "PATCH" with `oklch(0.7 0.12 300)` purple accent. Tab bar shows: Headers, **Body**, Params. Behavior identical to POST for body visibility and Content-Type auto-injection. | Same as `method-POST` | Select GET → `method-GET`; select POST → `method-POST`; select PUT → `method-PUT`; select DELETE → `method-DELETE` | PATCH semantics imply partial update. Content-Type could be `application/merge-patch+json` in some Fabric APIs — the user must set this manually if needed. Auto-injection still defaults to `application/json`. |
| **S13: method-DELETE** | User selects DELETE from method dropdown | Method dropdown displays "DELETE" with `oklch(0.65 0.25 25)` red accent. Tab bar shows: Headers, Params. **Body tab hidden** — same behavior as GET. Content-Type header auto-removed if it was auto-set. | Same as `method-GET` | Select GET → `method-GET`; select POST → `method-POST`; select PUT → `method-PUT`; select PATCH → `method-PATCH` | Some APIs accept a body on DELETE, but this is non-standard. If a user needs to send a body with DELETE, they must switch to POST and manually set the method override header. This is a deliberate simplification. |

---

## 4. Compound States

States in the Request Builder operate on three independent axes:

- **Method axis** — exactly one of S09–S13 is always active
- **Lifecycle axis** — exactly one of S01–S06 is active at any time
- **Overlay axis** — S07 and S08 can independently activate/deactivate

This produces compound states like `method-POST + editing + token-expired`.

### 4.1 Compound State Compatibility Matrix

The matrix below indicates whether two states can be simultaneously active (`✓`), cannot coexist (`✕`), or are mutually exclusive by definition (`─`).

```
              │ idle │ edit │ ep-sel│ send │ valid│ v-err│ tk-exp│ no-cfg│ GET │ POST│ PUT │PATCH│ DEL │
──────────────┼──────┼──────┼───────┼──────┼──────┼──────┼───────┼───────┼─────┼─────┼─────┼─────┼─────┤
idle     S01  │  ─   │  ✕   │   ✕   │  ✕   │  ✕   │  ✕   │  ✓   │   ✓   │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
edit     S02  │  ✕   │  ─   │   ✕   │  ✕   │  ✕   │  ✕   │  ✓   │   ✓   │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
ep-sel   S03  │  ✕   │  ✕   │   ─   │  ✕   │  ✕   │  ✕   │  ✓   │   ✓   │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
send     S04  │  ✕   │  ✕   │   ✕   │  ─   │  ✕   │  ✕   │  ✓   │   ✓   │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
valid    S05  │  ✕   │  ✕   │   ✕   │  ✕   │  ─   │  ✕   │  ✓   │   ✓   │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
v-err    S06  │  ✕   │  ✕   │   ✕   │  ✕   │  ✕   │  ─   │  ✓   │   ✓   │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
tk-exp   S07  │  ✓   │  ✓   │   ✓   │  ✓   │  ✓   │  ✓   │  ─   │   ✓   │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
no-cfg   S08  │  ✓   │  ✓   │   ✓   │  ✓   │  ✓   │  ✓   │  ✓   │   ─   │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │
GET      S09  │  ✓   │  ✓   │   ✓   │  ✓   │  ✓   │  ✓   │  ✓   │   ✓   │  ─  │  ✕  │  ✕  │  ✕  │  ✕  │
POST     S10  │  ✓   │  ✓   │   ✓   │  ✓   │  ✓   │  ✓   │  ✓   │   ✓   │  ✕  │  ─  │  ✕  │  ✕  │  ✕  │
PUT      S11  │  ✓   │  ✓   │   ✓   │  ✓   │  ✓   │  ✓   │  ✓   │   ✓   │  ✕  │  ✕  │  ─  │  ✕  │  ✕  │
PATCH    S12  │  ✓   │  ✓   │   ✓   │  ✓   │  ✓   │  ✓   │  ✓   │   ✓   │  ✕  │  ✕  │  ✕  │  ─  │  ✕  │
DEL      S13  │  ✓   │  ✓   │   ✓   │  ✓   │  ✓   │  ✓   │  ✓   │   ✓   │  ✕  │  ✕  │  ✕  │  ✕  │  ─  │
```

**Legend:**
- `✓` — Can coexist simultaneously
- `✕` — Mutually exclusive (cannot coexist)
- `─` — Same state (n/a)

### 4.2 Common Compound State Examples

| Compound State | Description | UI Behavior |
|----------------|-------------|-------------|
| `method-GET` + `idle` | Mount state. GET selected, no input yet. | Default appearance. Body tab hidden. Empty URL placeholder. |
| `method-POST` + `editing` | User typing a POST request body. | Body tab visible with JSON editor. Validity indicator active. Content-Type auto-set. |
| `method-POST` + `validation-error` | POST body has invalid JSON syntax. | Body tab shows red border on textarea. Inline error: "Invalid JSON: Unexpected token at line 3, column 8". Tab badge: "Body (1 error)". |
| `method-GET` + `editing` + `token-expired` | User editing URL, but token has expired. | Amber banner at top. URL input editable with blue focus ring. Send button disabled with tooltip. cURL copy still works. |
| `method-PUT` + `endpoint-selected` + `no-config` | Endpoint selected from catalog, but FLT config unavailable. | All fields populated from endpoint template. `{workspaceId}` and `{artifactId}` shown as plain text with dashed underline. Amber "FLT config unavailable" banner visible. User must manually replace variables before sending. |
| `method-POST` + `sending` + `token-expired` | Token expired during an in-flight request. | Spinner on Send button. All inputs disabled/dimmed. Amber token-expired banner appears. When response returns (likely 401), both overlays are visible. |
| `method-DELETE` + `validation-error` + `no-config` | Delete request failed validation while config is unavailable. | Red highlights on invalid fields. Amber config banner visible. Body tab hidden. Both banners stack vertically (config banner above, validation errors inline). |
| `method-GET` + `idle` + `no-config` + `token-expired` | Fresh mount with no config and expired token. | Both amber banners visible (stacked). Empty form. Send button disabled. User must refresh token and either wait for config or manually fill URLs. |
| `method-PATCH` + `editing` + `no-config` | User manually composing a PATCH request without config. | Body tab visible. Template variables show dashed underline. User typing actual IDs instead of `{...}` variables. Config warning banner visible but non-blocking. |

---

## 5. Edge Cases

### 5.1 Method Switch While Sending

**Scenario:** User somehow triggers a method switch during `sending` state.

**Behavior:** Not possible. The method dropdown is disabled (`pointer-events: none`) during `sending`. The dropdown click handler checks `this._state === 'sending'` and returns early. Even if programmatically triggered, the method change is queued and applied only after the request completes and the state returns to `editing`.

**Recovery:** None needed — the guard prevents the impossible transition.

---

### 5.2 Config Becomes Available After Being Unavailable

**Scenario:** User is in `no-config` + `editing` state. FLT starts and `/api/flt/config` becomes available, emitting `config:updated` event.

**Behavior:**
1. `no-config` overlay is dismissed (banner fades out over 200ms).
2. Current URL is scanned for `{...}` template variables.
3. Any matching variables are immediately expanded in-place (e.g., `{workspaceId}` → `abc-123-def`).
4. Expanded variables are highlighted with amber background to indicate substitution.
5. A toast confirms: "Config loaded — 3 variables expanded" (2s auto-dismiss).
6. Auth header is re-evaluated against the now-available config (correct token type selected).

**Edge case within edge case:** If the user has partially typed over a `{...}` placeholder (e.g., URL is `/v1/workspaces/{work`), the partial variable is not expanded. Only complete `{variableName}` patterns are matched.

---

### 5.3 Token Expires During a Send

**Scenario:** User is in `sending` state. Auth token TTL expires while the request is in flight.

**Behavior:**
1. The in-flight request continues — the token was already sent in the header.
2. The `token-expired` overlay activates (banner appears at top).
3. If the server returns 401 Unauthorized, the response is displayed normally in `ResponseViewer`.
4. State transitions: `sending` → `editing` + `token-expired`.
5. Send button becomes disabled (token-expired guard).
6. User must click [Refresh token] before sending the next request.

**Note:** The request is NOT automatically retried with a refreshed token. The user sees the 401 response and can manually refresh + resend.

---

### 5.4 User Selects Endpoint While Editing

**Scenario:** User has typed a custom URL and headers, then selects an endpoint from the catalog.

**Behavior:**
1. ALL fields are overwritten with the endpoint template values (method, URL, headers, body).
2. Previous edits are lost (pushed onto the undo stack — `Ctrl+Z` restores them as a single batch).
3. State transitions: `editing` → `endpoint-selected`.
4. A brief highlight flash on all populated fields confirms the replacement.
5. If the user had unsaved body content, it is preserved in the undo stack but NOT in the "method switch memory" (that only preserves body content across method switches, not endpoint selections).

**Confirmation dialog:** None. The undo stack provides the safety net. Rationale: endpoint selection is a deliberate action from a dropdown — accidental clicks are unlikely, and a confirmation dialog would slow down the common workflow of trying different endpoints.

---

### 5.5 Recovery from Validation Error

**Scenario:** User is in `validation-error` state and wants to clear the errors.

**Recovery paths:**
1. **Fix the specific field** — typing in a field with a red error clears that field's error after 300ms debounce. Once ALL errors are cleared, state automatically transitions to `editing`.
2. **Click Send again** — re-runs validation. If the same errors exist, the shake animation does NOT replay (only on first failure). If new errors appear, those shake. If all fixed, transitions to `sending`.
3. **Select an endpoint** — overwrites all fields, clears all validation errors, transitions to `endpoint-selected`.
4. **Clear all / Reset** — clears all fields and errors, transitions to `idle`.
5. **Switch method** — does NOT clear validation errors on other fields (e.g., switching from POST to GET hides the body tab and clears body-related errors, but a "URL required" error persists).

**What does NOT clear errors:**
- Switching tabs (errors persist, tab badge stays)
- Focusing a field without typing
- Scrolling
- Toggling between Headers / Params tabs

---

### 5.6 Rapid Method Switching

**Scenario:** User rapidly clicks through GET → POST → PUT → PATCH → DELETE → GET in quick succession.

**Behavior:**
1. Each method switch is processed synchronously — no debounce on method changes.
2. Body content is preserved in memory across all transitions (stored as `this._preservedBody`).
3. Content-Type header additions and removals are tracked: auto-injected headers are added/removed, but user-set Content-Type headers are never auto-removed.
4. The Body tab appears and disappears based on the current method (no animation — instant show/hide to avoid visual jitter during rapid switching).
5. Final state reflects the last selected method.
6. No performance issue — method switching is DOM-light (show/hide tab, update dropdown text and accent color).

**Edge case:** If the user switches method while the body textarea has focus, focus is moved to the URL input (since the body tab may be hidden). On return to a body-capable method, focus remains on URL — the user must explicitly re-focus the body.

---

### 5.7 Sending with Unexpanded Template Variables

**Scenario:** User is in `no-config` state and clicks Send with a URL containing `{workspaceId}`.

**Behavior:**
1. Validation passes — template variables in URLs are not a validation error (the user might intentionally have literal braces in a URL, though unlikely).
2. The request is sent with the literal `{workspaceId}` in the URL.
3. The server will likely return 400 or 404.
4. The response is displayed normally.
5. No special warning beyond the existing `no-config` banner.

**Rationale:** Blocking sends on unexpanded variables would be too aggressive — the user may be testing error handling or using an API that accepts literal braces.

---

### 5.8 Double-Click on Send Button

**Scenario:** User double-clicks the Send button quickly.

**Behavior:**
1. First click triggers `validating` → `sending`. Send button becomes disabled.
2. Second click is a no-op — the button is already disabled (`pointer-events: none` and `disabled` attribute set synchronously in the click handler before any async work).
3. Only one request is sent.

**Implementation:** The click handler sets `this._sending = true` as its first statement, and the DOM update (`button.disabled = true`) happens in the same microtask.

---

### 5.9 Empty URL Send Attempt

**Scenario:** User clicks Send with an empty URL field.

**Behavior:**
1. `validating` → `validation-error`.
2. URL input gets red border and shake animation.
3. Inline error: "URL is required".
4. Focus is moved to the URL input.
5. Send button shows brief red tint (1s).
6. No request is sent.

---

### 5.10 Endpoint Selection in Sending State

**Scenario:** User tries to select a new endpoint from the catalog while a request is in flight.

**Behavior:** Not possible. The endpoint catalog dropdown is disabled during `sending` state (same guard as method dropdown). The selection is blocked until the response returns and the state exits `sending`.

---

### 5.11 Token Refresh During Editing

**Scenario:** Token is refreshed (via [Refresh token] button or automatic background refresh) while user is editing.

**Behavior:**
1. `token-expired` overlay is dismissed (banner fades out over 200ms).
2. Auth header in the headers tab is updated with the new token value.
3. If the new token is a different type (Bearer vs MwcToken), the header name is also updated.
4. Send button becomes re-enabled.
5. User's current field focus is NOT interrupted — the auth header update happens silently.
6. Toast: "Token refreshed" (1.5s auto-dismiss).

---

### 5.12 Concurrent Overlay Activation

**Scenario:** Both `token-expired` and `no-config` activate simultaneously (FLT goes down, taking both config and auth with it).

**Behavior:**
1. Both banners appear, stacked vertically.
2. `no-config` banner is on top (closer to the endpoint catalog row).
3. `token-expired` banner is below it.
4. Both are independently dismissable / resolvable.
5. The combined height of both banners compresses the available space for the form — the form area scrolls if needed.
6. Send button is disabled (token-expired takes precedence as the blocking condition).

---

### 5.13 Impossible States

The following state combinations should never occur. If detected at runtime, log an error to the console and force-transition to a safe state.

| Impossible Combination | Why | Recovery |
|------------------------|-----|----------|
| `sending` + `idle` | Cannot be sending without having edited or selected something | Force → `editing` |
| `sending` + `validation-error` | Validation must pass before sending begins | Force → `validation-error` (cancel send) |
| `validating` + `sending` | Sequential, not concurrent | Force → `sending` (validation already passed) |
| No method state active | Exactly one method must always be active | Force → `method-GET` |
| Multiple method states active | Methods are mutually exclusive | Force → last selected method, deactivate others |
| `idle` + `validation-error` | Cannot have validation errors with no input | Force → `idle` (clear errors) |