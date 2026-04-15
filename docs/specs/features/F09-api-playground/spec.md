# Feature 09: API Playground

> **Status:** P0-P4 PREP COMPLETE — Ready for P5 (Implementation)
> **Phase:** V1.1
> **Owner:** Pixel (JS/CSS), Vex (proxy/backend)
> **Design Ref:** `docs/specs/design-spec-v2.md` §8
> **SOP:** `hivemind/FEATURE_DEV_SOP.md`

---

## 1. Problem

Engineers constantly run cURL commands against Fabric and FLT APIs — testing endpoints, debugging responses, checking DAG state. They maintain personal notes of endpoint URLs, manually manage token headers, and lose context between sessions.

## 2. Objective

A built-in API playground with request builder, response viewer, pre-configured FLT/Fabric endpoint library, history, and batch runner. Works in both phases — bearer token for Fabric APIs (disconnected), MWC token for FLT-specific endpoints (connected).

## 3. What User Sees

### Layout: Three-panel (design-spec-v2 §8)

- **Top — Request Builder:** Method selector, URL with template variables, headers editor, body editor, Send + Copy as cURL
- **Bottom — Response Viewer:** Status badge (color-coded), timing, response headers (collapsible), JSON body with syntax coloring and collapsible nodes, raw text toggle
- **Right Sidebar — History + Saved:** Last 20 requests, saved/named requests, endpoint catalog, batch runner

### Key Interactions

- Pre-configured endpoint dropdown auto-populates method, URL, headers
- Template variables (`{workspaceId}`, `{artifactId}`, `{capacityId}`) auto-expand from config
- Authorization header auto-filled with current token (bearer or MWC)
- JSON response with collapsible tree + syntax coloring
- Copy as cURL generates valid command
- History stored in localStorage (last 50 requests)
- Click history entry to re-populate request builder

## 4. Existing Code

- `src/frontend/css/api-playground.css` — 122-line basic layout (exists)
- `src/frontend/index.html` line 268 — empty state placeholder
- `src/frontend/js/api-client.js` — existing API client (token management, fetch wrappers)
- `src/backend/DevMode/EdogApiProxy.cs` — backend proxy for API calls
- `src/backend/DevMode/EdogTokenInterceptor.cs` — token capture
- `src/backend/DevMode/EdogLogServer.cs` — serves config at `/api/flt/config`
- No JS module exists yet

## 5. Acceptance Criteria

- [ ] Method selector dropdown with GET/POST/PUT/PATCH/DELETE
- [ ] URL field with template variable auto-expansion
- [ ] Pre-configured endpoint dropdown with common FLT and Fabric APIs
- [ ] Authorization header auto-filled with current token
- [ ] "Send" button executes request and shows response below
- [ ] Response shows status badge (color-coded), timing, headers, JSON body
- [ ] JSON body is collapsible with syntax coloring
- [ ] "Copy as cURL" generates valid cURL command to clipboard
- [ ] Request history stored in localStorage (last 50)
- [ ] Click history entry to re-populate request builder
- [ ] Works in disconnected mode (bearer token for Fabric APIs)
- [ ] Switches to MWC token for FLT-specific endpoints when connected
- [ ] Large responses truncated at 500KB with download link

## 6. Risks

| Risk | Mitigation |
|------|------------|
| CORS calling Fabric APIs from localhost | Proxy through EdogApiProxy. Add proxy endpoint if needed. |
| Large response bodies slow JSON renderer | Truncate at 500KB. "Download as file" link. Virtual scrolling for JSON tree. |
| Token expiry during request | Show clear error with "Token expired — refresh" action. |

## 7. Moonshot (V2+)

- Batch runner for sequential API calls
- Request chaining (response of A → input of B)
- WebSocket testing mode
- GraphQL explorer for Fabric APIs
- Environment variables / collections (Postman-style)

---

## 8. Prep Checklist

### Phase 0: Foundation Research

| # | Task | Owner | Output | Status |
|---|------|-------|--------|--------|
| P0.1 | Existing code audit — api-client.js, EdogApiProxy.cs, EdogTokenInterceptor.cs, EdogLogServer.cs, api-playground.css, index.html placeholder | Vex | `research/p0-foundation.md` §1 | ✅ DONE |
| P0.2 | Data source mapping — /api/flt/config response schema, token types (bearer vs MWC), proxy endpoint capabilities, CORS behavior | Vex | `research/p0-foundation.md` §2 | ✅ DONE |
| P0.3 | FLT + Fabric API catalog — all known endpoints, methods, URL patterns, required tokens, example responses | Sana | `research/p0-foundation.md` §3 | ✅ DONE |
| P0.4 | Industry research — Postman, Insomnia, Hoppscotch, Bruno, Thunder Client patterns and UX innovations | Sana | `research/p0-foundation.md` §4 | ✅ DONE |

### Phase 1: Component Deep Specs

| # | Component | Output | States (est.) | Depends On | Status |
|---|-----------|--------|---------------|-----------|--------|
| P1.1 | Request Builder | `components/request-builder.md` (64KB) | 12 | P0 | ✅ DONE |
| P1.2 | Response Viewer | `components/response-viewer.md` (76KB) | 10 | P0 | ✅ DONE |
| P1.3 | Endpoint Catalog | `components/endpoint-catalog.md` (67KB) | 8 | P0.3 | ✅ DONE |
| P1.4 | History & Saved Requests | `components/history-saved.md` (59KB) | 10 | P0 | ✅ DONE |
| P1.5 | JSON Tree Renderer | `components/json-tree.md` (62KB) | 8 | P0.4 | ✅ DONE |

### Phase 2: Architecture

| # | Task | Owner | Output | Depends On | Status |
|---|------|-------|--------|-----------|--------|
| P2.1 | ApiPlayground class design — lifecycle, module wiring, state management | Pixel | `architecture.md` §1 | P1 | ✅ DONE |
| P2.2 | Endpoint catalog data model — JSON schema, categories, template variables | Sana | `architecture.md` §2 | P1.3 | ✅ DONE |
| P2.3 | Proxy integration — request routing, CORS handling, token injection | Vex | `architecture.md` §3 | P0.2 | ✅ DONE |
| P2.4 | Storage model — localStorage schema, history limits, saved request format | Pixel | `architecture.md` §4 | P1.4 | ✅ DONE |

### Phase 3: State Matrices

| # | Component | Output | States (est.) | Depends On | Status |
|---|-----------|--------|---------------|-----------|--------|
| P3.1 | Request Builder | `states/request-builder.md` (41KB) | 13 | P2.1 | ✅ DONE |
| P3.2 | Response Viewer | `states/response-viewer.md` (27KB) | 11 | P2.1 | ✅ DONE |
| P3.3 | Endpoint Catalog | `states/endpoint-catalog.md` (30KB) | 7 | P2.2 | ✅ DONE |
| P3.4 | History & Saved | `states/history-saved.md` (34KB) | 9 | P2.4 | ✅ DONE |
| P3.5 | JSON Tree | `states/json-tree.md` (40KB) | 11 | P2.1 | ✅ DONE |

### Phase 4: Interactive Mocks

| # | Mock | Output | Depends On | Status |
|---|------|--------|-----------|--------|
| P4.1 | API Playground (full view) | `mocks/api-playground.html` (87KB) | P3 | ✅ DONE |

### Phase 5: Implementation Checklist

*(To be defined after P4 approval)*

---

## 9. Implementation Order (AFTER all prep is done)

```
Layer 0: JSON Tree Renderer — collapsible, syntax-colored, virtualized
Layer 1: Request Builder — method, URL, headers, body, template variables
Layer 2: Response Viewer — status badge, timing, headers, JSON tree, raw toggle
Layer 3: Endpoint Catalog — categorized FLT/Fabric/Maintenance endpoints
Layer 4: History & Saved — localStorage CRUD, replay, save/name
Layer 5: Proxy Integration — CORS handling, token injection, error mapping
Layer 6: Batch Runner (V2) — queue, sequential execution, results
Layer 7: Keyboard Shortcuts + Accessibility
```
