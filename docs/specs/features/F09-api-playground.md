# Feature 9: API Playground

> **Phase:** V1.1
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS)
> **Spec:** docs/specs/features/F09-api-playground.md
> **Design Ref:** docs/specs/design-spec-v2.md §9

### Problem

Engineers constantly run cURL commands against Fabric and FLT APIs — testing endpoints, debugging responses, checking DAG state. They maintain personal notes of endpoint URLs and have to manually manage token headers.

### Objective

A built-in API playground with request builder, response viewer, pre-configured FLT/Fabric endpoint library, history, and batch runner.

### Owner

**Primary:** Zara Okonkwo (JS)
**Reviewers:** Dev Patel (API endpoint catalog), Kael Andersen (UX), Mika Tanaka (CSS)

### Inputs

- Bearer token (Phase 1) and MWC token (Phase 2) from `/api/flt/config`
- Template variables: `{workspaceId}`, `{artifactId}`, `{capacityId}` from config
- Pre-configured endpoint catalog (Fabric APIs + FLT APIs + Maintenance APIs)

### Outputs

- **Files modified:**
  - `src/frontend/js/api-playground.js` — New class (replacing empty-state placeholder)
  - `src/frontend/css/api-playground.css` — Request builder, response viewer, history panel
  - `src/frontend/index.html` — Replace `#view-api` placeholder content

### Technical Design

**JS — `api-playground.js`:**

```
class ApiPlayground {
  constructor(viewEl, apiClient, stateManager)

  // Request builder
  setMethod(method)                    // GET/POST/PUT/PATCH/DELETE
  setUrl(url)                          // With template variable expansion
  setHeaders(headers)                  // Key-value, auto-fill Authorization
  setBody(jsonStr)                     // For POST/PUT/PATCH
  async sendRequest()                  // fetch() with timing measurement

  // Response viewer
  renderResponse(status, headers, body, duration)
  renderJsonTree(jsonObj)              // Collapsible JSON with syntax coloring

  // History + saved
  addToHistory(request, response)     // localStorage, max 50 entries
  saveRequest(name, request)          // Named request in localStorage
  loadFromHistory(index)              // Re-populate builder
  copyAsCurl()                        // Generate cURL command string

  // Endpoint catalog
  loadCatalog()                       // Pre-configured FLT + Fabric endpoints
  selectEndpoint(endpoint)            // Auto-populate method, URL, headers

  // Batch runner (future)
  queueRequest(request)
  async runBatch()
}
```

### Acceptance Criteria

- [ ] Method selector dropdown with GET/POST/PUT/PATCH/DELETE
- [ ] URL field with template variable auto-expansion (`{workspaceId}` etc.)
- [ ] Pre-configured endpoint dropdown with common FLT and Fabric APIs
- [ ] Authorization header auto-filled with current token
- [ ] "Send" button executes request and shows response below
- [ ] Response shows status badge (color-coded), timing, headers, JSON body
- [ ] JSON body is collapsible with syntax coloring
- [ ] "Copy as cURL" generates valid cURL command to clipboard
- [ ] Request history stored in localStorage (last 50 requests)
- [ ] Click history entry to re-populate request builder
- [ ] Works in disconnected mode (bearer token for Fabric APIs)
- [ ] Switches to MWC token for FLT-specific endpoints when connected

### Dependencies

- **Feature 5 (Top Bar):** Token health visible to know which token is available
- EdogApiProxy must serve both tokens

### Risks

| Risk | Mitigation |
|------|------------|
| CORS issues calling Fabric APIs from localhost | Fabric APIs may require proxy through edog.py/EdogLogServer. Add proxy endpoint if needed. |
| Large response bodies slow down JSON renderer | Truncate at 500KB. Show "Response too large — download as file" link. |

### Moonshot Vision

V2+: Batch runner for sequential API calls. Request chaining (use response of A as input to B). WebSocket testing mode. GraphQL explorer for Fabric APIs.

