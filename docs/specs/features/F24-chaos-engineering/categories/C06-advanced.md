# C06: Advanced — Power-User Features

> **Author:** Sana Reeves (Architect)
> **Status:** SPEC COMPLETE
> **Date:** 2025-07-22
> **Category:** Advanced (DSL, response cache, cascading simulation, fuzzing, presets, scheduling)
> **Depends On:** `spec.md` (master), `interceptor-audit.md` (P0.1+P0.2), `engine-design.md` (rule model)
> **Priority:** P2 — Layer 8 in implementation order (after all C01–C05 features ship)

---

## Overview

C06 is the power-user layer. It composes primitives from C01–C05 into higher-order constructs:
a DSL that replaces point-and-click rule building, preset scenarios that bundle multiple
rules into one-click outage simulations, scheduled chaos with wall-clock triggers, a response
cache for offline development, cascading failure chains that model real dependency graphs, and
a bit-flip fuzzer for binary corruption testing.

These features share a design principle: **composition over invention**. Every C06 feature
decomposes into ChaosRule primitives already defined in C01–C05. The DSL is syntactic sugar
over ChaosRule JSON. Presets are named rule bundles. Cascading sims are ordered rule
activations with health-gated transitions. Nothing here requires new action types in the
engine — only new orchestration above it.

**Target user:** The FLT engineer who has used the Chaos Panel for a week, built 20+ rules
manually, and now wants to work faster, share scenarios, and simulate multi-service outages
without clicking through the Rule Builder 8 times.

---

## Table of Contents

| # | Scenario | One-liner | Priority |
|---|----------|-----------|----------|
| AD-01 | [Chaos DSL](#ad-01-chaos-dsl) | Write rules as code: `WHEN url ~ /spark/ AND method == POST THEN delay 5s FOR 30%` | P2 |
| AD-02 | [Response Cache Mode](#ad-02-response-cache-mode) | Serve recorded responses, making FLT work "offline" | P2 |
| AD-03 | [Cascading Failure Simulation](#ad-03-cascading-failure-simulation) | Define failure chains: "if OneLake fails → token refresh storm → Spark timeout" | P2 |
| AD-04 | [Bit-Flip Fuzzer](#ad-04-bit-flip-fuzzer) | Randomly flip bits in response bodies to test deserialization resilience | P2 |
| AD-05 | [Preset Scenarios](#ad-05-preset-scenarios) | One-click: "Simulate OneLake outage", "Simulate Spark shortage" | P1 |
| AD-06 | [Rule Composition](#ad-06-rule-composition) | Combine rules: "delay 2s AND inject 429 AND corrupt body" | P2 |
| AD-07 | [Scheduled Chaos](#ad-07-scheduled-chaos) | "At 2:30 PM, enable rule X for 5 minutes" | P2 |
| AD-08 | [Waterfall Timeline](#ad-08-waterfall-timeline) | Chrome DevTools-style waterfall for all requests in a DAG execution | P1 |

---

## AD-01: Chaos DSL

### Description

A terse, text-based language for defining chaos rules — inspired by mitmproxy's filter
expressions (`~u`, `~m`, `~c`) and Toxiproxy's toxic model. The DSL compiles to ChaosRule
JSON, enabling engineers to define rules in a code editor, paste them into a REPL, store them
in `.chaos` files, and share them via chat/PR descriptions.

The DSL is **not** a replacement for the GUI Rule Builder. It's a parallel input path for
power users — the same way mitmproxy's filter expressions coexist with its web UI.

### Why This Matters

A senior FLT engineer testing retry logic currently clicks through 8 form fields to create one
rule. With the DSL, they type one line:

```
WHEN url ~ /onelake/ AND method == PUT THEN delay 3s PROB 50% FOR 5m
```

That's 65 characters vs. 8 form interactions. At 20+ rules per test session, the DSL pays for
itself in the first hour.

### Syntax Specification

#### Grammar (EBNF)

```ebnf
chaos_statement  = rule_def | preset_ref | comment ;
comment          = "#" { any_char } ;

rule_def         = "WHEN" predicate_expr "THEN" action_expr { modifier } ;

predicate_expr   = predicate_term { ("AND" | "OR") predicate_term } ;
predicate_term   = [ "NOT" ] predicate_atom | "(" predicate_expr ")" ;
predicate_atom   = field operator value ;

field            = "url" | "method" | "status" | "client" | "header" | "body"
                 | "req.header" | "res.header" | "req.body" | "res.body"
                 | "duration" | "content-type" ;

operator         = "==" | "!=" | "~" | "!~" | ">" | "<" | ">=" | "<="
                 | "contains" | "exists" ;

value            = quoted_string | number | regex_literal ;
quoted_string    = '"' { any_char } '"' | "'" { any_char } "'" ;
regex_literal    = "/" { any_char } "/" ;
number           = digit { digit } [ "." digit { digit } ] ;

action_expr      = action { "+" action } ;
action           = action_type action_args ;

action_type      = "delay" | "status" | "block" | "forge" | "drop" | "throttle"
                 | "header" | "body" | "rewrite" | "redirect" | "record" | "tag" ;

action_args      = { value | key_value } ;
key_value        = identifier "=" value ;

modifier         = prob_mod | limit_mod | ttl_mod | phase_mod | name_mod | sched_mod ;
prob_mod         = "PROB" percentage ;
limit_mod        = "LIMIT" number ;
ttl_mod          = "FOR" duration ;
phase_mod        = "ON" ("request" | "response" | "both") ;
name_mod         = "AS" quoted_string ;
sched_mod        = "AT" time_spec ;

percentage       = number "%" ;
duration         = number ("s" | "m" | "h") ;
time_spec        = time_literal [ "FOR" duration ] ;
time_literal     = digit digit ":" digit digit [ ":" digit digit ] ;
```

#### Operator Mapping

| DSL Operator | ChaosRule `op` | Notes |
|--------------|----------------|-------|
| `==` | `equals` | Exact string/number match |
| `!=` | `not_equals` | Negated equality |
| `~` | `matches` | Regex match |
| `!~` | `not_matches` | Negated regex |
| `>` / `<` / `>=` / `<=` | `gt` / `lt` / `gte` / `lte` | Numeric comparisons |
| `contains` | `contains` | Substring match |
| `exists` | `exists` | Header/field existence check |

#### Field Mapping

| DSL Field | ChaosRule `field` | Shorthand |
|-----------|-------------------|-----------|
| `url` | `url` | — |
| `method` | `method` | — |
| `status` | `statusCode` | Response-phase only |
| `client` | `httpClientName` | Named HttpClient |
| `header` | `requestHeader` (req phase) / `responseHeader` (res phase) | Needs `key` via `.` syntax |
| `req.header` | `requestHeader` | Explicit request phase |
| `res.header` | `responseHeader` | Explicit response phase |
| `body` | `requestBody` (req) / `responseBody` (res) | Phase-dependent |
| `req.body` | `requestBody` | Explicit |
| `res.body` | `responseBody` | Explicit |
| `duration` | `durationMs` | Converted: `5s` → `5000` |
| `content-type` | `contentType` | — |

#### Header Key Syntax

Headers use dot notation: `req.header.Content-Type == "application/json"`.
The parser splits on the first two dots: `req` (phase) `.` `header` (field) `.` `Content-Type` (key).

### DSL Examples with JSON Equivalents

#### Example 1: Delay OneLake writes

```
WHEN url ~ /onelake\.dfs/ AND method == PUT THEN delay 3s PROB 50% FOR 5m AS "Delay OneLake writes"
```

Compiles to:

```json
{
  "id": "delay-onelake-writes",
  "name": "Delay OneLake writes",
  "phase": "request",
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "url", "op": "matches", "value": "onelake\\.dfs" },
      { "field": "method", "op": "equals", "value": "PUT" }
    ]
  },
  "action": { "type": "delay", "config": { "delayMs": 3000, "jitterMs": 0 } },
  "probability": 0.5,
  "limits": { "ttlSeconds": 300 },
  "enabled": false
}
```

#### Example 2: Forge 429 on Spark calls

```
WHEN client == "GTSBasedSparkClient" AND method == PUT THEN status 429 + header "Retry-After" = "30" PROB 30% LIMIT 10
```

Compiles to two composed actions (see AD-06):

```json
{
  "id": "forge-429-spark",
  "name": "Forge 429 on Spark calls",
  "phase": "response",
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "GTSBasedSparkClient" },
      { "field": "method", "op": "equals", "value": "PUT" }
    ]
  },
  "action": {
    "type": "composite",
    "config": {
      "actions": [
        { "type": "modifyResponseStatus", "config": { "statusCode": 429 } },
        { "type": "modifyResponseHeader", "config": { "operation": "set", "name": "Retry-After", "value": "30" } }
      ]
    }
  },
  "probability": 0.3,
  "limits": { "maxFirings": 10 }
}
```

#### Example 3: Complex cascading predicate

```
WHEN (client == "OneLakeRestClient" OR client == "DatalakeDirectoryClient") AND NOT url contains "/health" THEN drop FOR 2m AS "OneLake blackhole"
```

#### Example 4: Response-phase body mutation

```
WHEN url ~ /lakehouses/ AND status == 200 THEN body find="rowCount\":\d+" replace="rowCount\":0" ON response FOR 3m
```

#### Example 5: Scheduled chaos (combines with AD-07)

```
WHEN url ~ /spark/ THEN delay 10s PROB 100% AT 14:30 FOR 5m AS "Afternoon Spark slowdown"
```

### DSL REPL (UI Integration)

The Chaos Panel gets a **DSL Editor** tab alongside the visual Rule Builder:

```
┌─ Chaos Panel ──────────────────────────────────────────────┐
│ [Rule Builder]  [DSL Editor]  [Active Rules]  [Traffic]    │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  # OneLake resilience test                                 │
│  WHEN client == "OneLakeRestClient" THEN delay 5s FOR 3m  │
│  WHEN client == "OneLakeRestClient" THEN status 503 ▏      │
│    PROB 20% FOR 3m                                         │
│                                                            │
│  ──────────────────────────────────────────────────────    │
│  [▸ Parse]  [▸ Parse & Enable]  2 rules parsed, 0 errors  │
│                                                            │
│  Preview:                                                  │
│  ● delay-onelake-5s        delay 5s     OneLakeRestClient  │
│  ● status-503-onelake      status 503   OneLakeRestClient  │
└────────────────────────────────────────────────────────────┘
```

**UX Flow:**

1. User types DSL statements in the editor (multi-line, with syntax highlighting)
2. Clicks **Parse** → compiler validates, shows parsed rules in the preview pane below
3. Parse errors are shown inline with red underlines and error messages
4. Clicks **Parse & Enable** → rules are created AND activated in one step
5. Each parsed rule appears in the Active Rules list with a `[DSL]` badge
6. User can click a parsed rule to open it in the visual Rule Builder for fine-tuning

**Keyboard shortcut:** `Ctrl+Enter` in the DSL editor = Parse & Enable.

### `.chaos` File Format

Engineers can save DSL scripts as `.chaos` files (plain text, one statement per line):

```
# File: onelake-resilience.chaos
# Author: sanar@microsoft.com
# Description: Test DAG behavior when OneLake is degraded

WHEN client == "OneLakeRestClient" THEN delay 5s FOR 10m AS "OneLake slow writes"
WHEN client == "DatalakeDirectoryClient" AND method == GET THEN status 503 PROB 20% FOR 10m AS "OneLake read failures"
WHEN url ~ /lakehouses/.*?/jobs/ THEN block status=503 body='{"error":"Service Unavailable"}' FOR 10m AS "Table maintenance blocked"
```

Files are loaded via:
- **Drag & drop** onto the DSL Editor
- **File picker** button in the editor toolbar
- **CLI:** `edog chaos load onelake-resilience.chaos` (future: edog.py integration)

### Compiler Implementation

The DSL compiler is a **frontend-only** JavaScript module. It runs entirely in the browser:

```
DSL text → Lexer → Token stream → Parser → AST → Codegen → ChaosRule JSON[]
```

**Why frontend-only:** The DSL is syntactic sugar. The engine only understands ChaosRule JSON.
Compiling in the browser means: (a) instant feedback, (b) no round-trip to C#, (c) the engine
stays simple. The compiler is ~400 lines of vanilla JS.

**Error recovery:** The parser uses panic-mode recovery — on error, it skips to the next
newline and continues parsing. This means a file with 10 rules and 1 syntax error still
produces 9 valid rules + 1 error diagnostic.

### Implementation Complexity

| Component | Size Estimate | Owner |
|-----------|--------------|-------|
| Lexer (tokenizer) | ~150 LOC JS | Pixel |
| Parser (AST builder) | ~200 LOC JS | Pixel |
| Codegen (AST → JSON) | ~100 LOC JS | Pixel |
| Syntax highlighter (CodeMirror-free) | ~80 LOC JS + CSS | Pixel |
| DSL Editor panel UI | ~120 LOC JS + CSS | Pixel |
| `.chaos` file load/save | ~50 LOC JS | Pixel |
| **Total** | **~700 LOC** | **Pixel** |

### Edge Cases

- **Regex in values:** The `/` delimiter is used: `url ~ /onelake\.dfs/`. Escaping: `\/` for
  literal slashes inside the regex.
- **Quoted strings with spaces:** `AS "My Rule Name"` — double or single quotes.
- **Duration ambiguity:** `5s` = 5 seconds, `5m` = 5 minutes, `5h` = 5 hours. No bare numbers
  for durations — `delay 5` is a parse error, must be `delay 5s`.
- **Empty THEN:** `WHEN url ~ /test/ THEN` is a parse error. At least one action required.
- **Multiple actions:** `+` separator: `THEN delay 3s + status 429 + header "Retry-After" = "5"`.
- **Line continuation:** Long rules can span lines with trailing `\`:
  ```
  WHEN client == "OneLakeRestClient" \
    AND method == PUT \
    THEN delay 5s FOR 3m
  ```

### Interactions with Other Features

- **AD-05 (Presets):** Presets can be defined as `.chaos` files.
- **AD-06 (Rule Composition):** The `+` syntax in `THEN` clauses creates composite actions.
- **AD-07 (Scheduling):** The `AT` modifier integrates scheduling into DSL.
- **C01–C05:** Every DSL statement compiles to rules using existing action types.

### Revert

DSL-created rules are ChaosRules with a `source: "dsl"` tag. They appear in Active Rules
and can be disabled/deleted individually or via the kill switch (`Ctrl+Shift+K`).

---

## AD-02: Response Cache Mode

### Description

Record all HTTP traffic during a live FLT session, then replay recorded responses without a
network connection. This makes FLT "work offline" — the engineer can develop, debug, and test
against cached responses from a previous session without needing PPE access, VPN, or running
services.

This is Charles Proxy's **Map Local** feature — but operating inside the FLT process, with
exact URL+method matching and content-addressable storage.

### Why This Matters

FLT engineers frequently lose productivity to:
1. **PPE outages** — shared PPE environments go down, blocking local development
2. **VPN disconnects** — corporate VPN drops during debugging sessions
3. **Rate limits** — repeatedly hitting OneLake APIs during development burns through quotas
4. **Slow iteration** — every code change requires a live round-trip to external services

Response Cache Mode decouples development from live services. Record once, replay indefinitely.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Response Cache Mode                         │
│                                                              │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │ Request   │────▶│ Cache Lookup │────▶│ Cache Hit?   │    │
│  │ Arrives   │     │ (key hash)   │     │              │    │
│  └──────────┘     └──────────────┘     └──────┬───────┘    │
│                                           Yes │  │ No       │
│                                               ▼  ▼          │
│                                    ┌─────────┐  ┌────────┐  │
│                                    │ Return  │  │Forward │  │
│                                    │ Cached  │  │to Real │  │
│                                    │Response │  │Service │  │
│                                    └─────────┘  └───┬────┘  │
│                                                     │       │
│                                                     ▼       │
│                                              ┌────────────┐ │
│                                              │ Store in   │ │
│                                              │ Cache      │ │
│                                              └────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Cache Key Design

The cache key determines when a cached response matches an incoming request. Too loose = wrong
responses served. Too strict = cache misses on every request.

```
CacheKey = SHA256( Method + "|" + NormalizedUrl + "|" + BodyHash + "|" + RelevantHeaders )
```

**Normalization rules:**

| Component | Normalization | Why |
|-----------|--------------|-----|
| URL | Strip SAS tokens (`sig=`, `se=`, `st=`, `sp=`, `spr=`, `sv=`, `sr=`, `sdd=`), strip `x-ms-date` params, sort query params | SAS tokens change every request; param order is non-deterministic |
| Method | Uppercase | Canonical form |
| Body | SHA256 hash of body bytes | Content-addressable; identical payloads match |
| Headers | Only: `Accept`, `Content-Type`, `x-ms-version` | Auth headers change constantly; these affect response shape |

**Key examples:**

```
GET|https://onelake.dfs.fabric.microsoft.com/{workspace}?directory=Tables&resource=filesystem|e3b0c4|application/json
→ SHA256 → "a1b2c3d4..."

PUT|https://onelake.dfs.fabric.microsoft.com/{workspace}/Tables/my_table/part-00000.parquet|9f86d0|application/octet-stream
→ SHA256 → "e5f6g7h8..."
```

### Cache Storage Format

Responses are stored as JSON files in a `.edog-cache/` directory, organized by session:

```
.edog-cache/
├── sessions/
│   ├── 2025-07-22T14-30-00_onelake-dev/
│   │   ├── manifest.json              ← index of all cached entries
│   │   ├── entries/
│   │   │   ├── a1b2c3d4.json          ← cache entry (metadata + response)
│   │   │   ├── e5f6g7h8.json
│   │   │   └── ...
│   │   └── blobs/
│   │       ├── 9f86d081.bin           ← large response bodies (>64KB)
│   │       └── ...
│   └── 2025-07-21T09-00-00_full-dag/
│       └── ...
└── active → sessions/2025-07-22T14-30-00_onelake-dev/  ← symlink to active cache
```

**Cache entry format:**

```json
{
  "key": "a1b2c3d4e5f6g7h8i9j0",
  "request": {
    "method": "GET",
    "url": "https://onelake.dfs.fabric.microsoft.com/{workspaceId}?directory=Tables&resource=filesystem",
    "headers": { "Accept": "application/json", "x-ms-version": "2021-06-08" },
    "bodyHash": null
  },
  "response": {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json",
      "x-ms-request-id": "abc-123",
      "x-ms-version": "2021-06-08"
    },
    "body": "{\"paths\":[{\"name\":\"Tables/customers\",\"isDirectory\":true},...]}",
    "bodyBlobRef": null
  },
  "metadata": {
    "recordedAt": "2025-07-22T14:31:05.123Z",
    "responseTimeMs": 245,
    "httpClientName": "DatalakeDirectoryClient",
    "hitCount": 0,
    "lastServedAt": null
  }
}
```

### Cache Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **Record** | Forward all requests to real services. Store every response. | Building the cache during a live session |
| **Replay** | Serve cached responses. Never hit real services. 504 for cache misses. | Offline development, VPN-free coding |
| **Hybrid** | Serve cached responses when available. Forward cache misses to real services and cache the response. | Gradual cache warming during development |
| **Disabled** | Normal operation. No caching. | Default state |

### ChaosRule JSON

Response Cache Mode is implemented as a special rule type — a `forgeResponse` action that
reads from the cache store:

```json
{
  "id": "response-cache-replay",
  "name": "Response Cache: Replay Mode",
  "category": "advanced",
  "phase": "request",
  "predicate": { "field": "url", "op": "matches", "value": ".*" },
  "action": {
    "type": "cacheReplay",
    "config": {
      "mode": "replay",
      "sessionName": "2025-07-22T14-30-00_onelake-dev",
      "missBehavior": "return504",
      "staleTolerance": "7d"
    }
  },
  "probability": 1.0,
  "limits": { "maxFirings": 0 },
  "priority": 0,
  "enabled": true
}
```

> **Note:** `cacheReplay` is a new action type unique to C06. It's the one exception to the
> "no new action types" principle — response caching is fundamentally different from other
> chaos actions because it reads from persistent storage rather than generating a response
> from config.

### C# Mechanism

In `EdogHttpPipelineHandler.SendAsync()`, the cache action intercepts before `base.SendAsync()`:

```csharp
// Inside ActionExecutor.ExecuteRequest for cacheReplay:
var cacheKey = CacheKeyBuilder.Build(request, httpClientName);
var cached = await CacheStore.LookupAsync(cacheKey, sessionName);

if (cached != null)
{
    // Cache HIT — return stored response without network call
    cached.Metadata.HitCount++;
    cached.Metadata.LastServedAt = DateTime.UtcNow;
    TopicRouter.Publish("chaos", new { type = "cache-hit", key = cacheKey, url = request.RequestUri });
    return new ActionResult { ShortCircuit = true, Response = cached.ToHttpResponseMessage() };
}

// Cache MISS
switch (config.MissBehavior)
{
    case "return504":
        return new ActionResult {
            ShortCircuit = true,
            Response = new HttpResponseMessage(HttpStatusCode.GatewayTimeout) {
                Content = new StringContent($"{{\"error\":\"Cache miss\",\"url\":\"{request.RequestUri}\"}}")
            }
        };
    case "passthrough":
        return new ActionResult { ShortCircuit = false }; // Forward to real service
    default:
        return new ActionResult { ShortCircuit = false };
}
```

### FLT Code Paths Affected

| Call Pattern | Source | Cached? | Notes |
|-------------|--------|---------|-------|
| OneLake directory listing | `OneLakeRestClient.ListDirsAsync` via `OneLakeRestClient` named client | Yes | Pagination: each page is a separate cache entry |
| OneLake file read/write | `OnelakeBasedFileSystem.*` via `DatalakeDirectoryClient` | Yes | Binary blobs stored in `blobs/` directory |
| Fabric API calls | `FabricApiClient.*` via `PbiSharedApiClient` | Yes | Workspace/lakehouse metadata |
| Spark submit/status/cancel | `GTSBasedSparkClient.*` | **Gap** | WCL SDK bypass — not intercepted. See GAP-1 in interceptor-audit.md |
| Notebook content | `NotebookApiClient.*` | **Gap** | WCL SDK bypass — not intercepted. See GAP-2 |

### UX Flow

1. **Start recording:** User clicks `●  Record` in the Chaos Panel toolbar. Status indicator
   turns red. A session name is auto-generated (`YYYY-MM-DDTHH-mm-ss_description`).
2. **Work normally:** User runs DAGs, browses catalogs, tests APIs. All responses are cached
   silently in the background.
3. **Stop recording:** User clicks `■ Stop`. Manifest is written. Stats shown: "247 responses
   cached, 12.4 MB, 3m 22s session."
4. **Switch to replay:** User clicks `▸ Replay` and selects a session from the dropdown.
   A warning banner appears: `⚠ CACHE MODE — Responses are from 2025-07-22 14:30. Live
   services are NOT being contacted.`
5. **Develop offline:** User disconnects VPN, continues working. Cached responses are served.
   Cache misses return 504 with a helpful error message identifying the missing URL.
6. **Exit replay:** User clicks `✕ Stop Replay`. Normal operation resumes.

### Edge Cases

- **Cache key collision:** SHA256 collision probability is negligible (~1 in 2^128). No
  mitigation needed.
- **Large responses:** Bodies >64KB are stored as separate blob files. The entry JSON contains
  a `bodyBlobRef` instead of inline `body`.
- **Binary responses** (Parquet files, protobuf): Stored as-is in `blobs/`. Content-Type
  preserved. No text conversion.
- **Streaming responses:** Not supported in V1. Responses are fully buffered before caching.
  `Transfer-Encoding: chunked` is stored as a complete body.
- **Stale cache entries:** `staleTolerance` config (default `7d`). Entries older than this
  are still served but with a `X-Edog-Cache-Age: stale` header added.
- **Cache poisoning:** The cache records whatever the real service returned — including errors.
  If you recorded a 500 error, replay serves that 500. Use cache management UI to delete
  individual entries.
- **Pagination tokens:** OneLake uses continuation tokens in response headers. These are
  cached with the response. On replay, the continuation token in the cached response points
  to the next cached page — which works if the full pagination sequence was recorded.

### Implementation Complexity

| Component | Size Estimate | Owner |
|-----------|--------------|-------|
| `CacheKeyBuilder` (C#) | ~80 LOC | Vex |
| `CacheStore` (C# file I/O) | ~200 LOC | Vex |
| `cacheReplay` action handler (C#) | ~100 LOC | Vex |
| `cacheRecord` middleware (C#) | ~80 LOC | Vex |
| Cache management REST API (C#) | ~120 LOC | Vex |
| Cache UI (session list, stats, controls) | ~200 LOC JS + CSS | Pixel |
| **Total** | **~780 LOC** | **Vex + Pixel** |

### Revert

Disable the `response-cache-replay` rule or click `✕ Stop Replay`. Cache files persist on
disk for future use. `edog cache clear` deletes all cached sessions.

---

## AD-03: Cascading Failure Simulation

### Description

Define failure chains that model real-world cascading outages:

> "When OneLake becomes unavailable, FLT's token refresh fails because the OBO token call
> uses OneLake credentials, which causes Spark jobs to fail because they can't get fresh
> tokens, which causes the DAG scheduler to enter backoff mode."

This is the chaos engineering equivalent of a domino topple — but controlled, observable, and
reversible.

### Why This Matters

Real production incidents are never single-fault. The P0 outages that wake people at 3 AM are
cascading failures where Service A's degradation triggers Service B's timeout, which causes
Service C's retry storm, which overwhelms Service D. FLT has at least 4 known cascading
failure paths (see below). Testing them requires activating rules in sequence with
health-gated transitions.

### Cascade Model

A cascade is an ordered list of **stages**, each with:
- A set of chaos rules to activate
- A **trigger condition** (time-based or health-probe-based) that advances to the next stage
- A **steady-state check** that must pass before the stage activates (from Chaos Toolkit)

```json
{
  "id": "onelake-cascade",
  "name": "OneLake Full Outage Cascade",
  "description": "Simulates cascading failure when OneLake becomes unavailable",
  "stages": [
    {
      "id": "stage-1-onelake-slow",
      "name": "OneLake latency spike",
      "rules": ["delay-onelake-5s"],
      "trigger": { "type": "time", "delaySeconds": 0 },
      "steadyState": { "probe": "flt-process-alive" },
      "duration": "60s"
    },
    {
      "id": "stage-2-onelake-errors",
      "name": "OneLake starts returning 503",
      "rules": ["delay-onelake-5s", "onelake-503-50pct"],
      "trigger": {
        "type": "healthProbe",
        "condition": "errorRate > 20%",
        "target": "OneLakeRestClient",
        "evaluateEvery": "5s"
      },
      "steadyState": { "probe": "flt-process-alive" },
      "duration": "60s"
    },
    {
      "id": "stage-3-token-fail",
      "name": "Token refresh fails (OBO depends on OneLake creds)",
      "rules": ["delay-onelake-5s", "onelake-503-50pct", "token-refresh-timeout"],
      "trigger": { "type": "time", "delaySeconds": 30 },
      "steadyState": { "probe": "flt-process-alive" },
      "duration": "60s"
    },
    {
      "id": "stage-4-spark-cascade",
      "name": "Spark jobs fail (no valid token)",
      "rules": ["delay-onelake-5s", "onelake-503-50pct", "token-refresh-timeout", "spark-401"],
      "trigger": { "type": "time", "delaySeconds": 15 },
      "steadyState": { "probe": "flt-process-alive" },
      "duration": "120s"
    }
  ],
  "rollback": {
    "onComplete": "disable-all-rules",
    "onSafetyTrip": "disable-all-rules",
    "onUserAbort": "disable-all-rules"
  },
  "safetyLimits": {
    "maxDuration": "600s",
    "haltOnFltCrash": true,
    "haltOnErrorRate": 95
  }
}
```

### Trigger Types

| Type | Config | Advances When |
|------|--------|--------------|
| `time` | `delaySeconds` | N seconds after previous stage activated |
| `healthProbe` | `condition`, `target`, `evaluateEvery` | Health probe condition becomes true |
| `trafficPattern` | `field`, `op`, `value`, `windowSeconds` | Traffic matches pattern over time window |
| `ruleFireCount` | `ruleId`, `count` | A specific rule has fired N times |

**Health probe conditions (for `healthProbe` triggers):**

```
errorRate > 20%           # Percentage of 5xx responses for target client
p99Latency > 5000         # 99th percentile latency in ms
fireCount("rule-id") > 10 # A specific rule's fire count
consecutiveErrors > 5     # Sequential errors without success
```

### Known FLT Cascading Failure Paths

These are derived from the FLT codebase analysis and interceptor audit:

#### Cascade 1: OneLake Full Outage

```
OneLake 503 → File system ops fail → Catalog resolution fails → DAG scheduler can't
build execution plan → All nodes fail with CatalogException
```

**FLT code path:**
- `OnelakeBasedFileSystem.*` → `RequestFailedException` → `LakeHouseMetastoreClientV2.GetCatalogObjectsAsync()` fails
- `CatalogHandler.GetCatalogObjectsAsync()` → `CatalogException(HttpStatusCode.ServiceUnavailable)`
- `DagExecutionHandlerV2` → cannot build node graph → iteration fails

**Preset rules:**
```
WHEN client == "OneLakeRestClient" THEN status 503 PROB 80% FOR 5m AS "OneLake unavailable"
WHEN client == "DatalakeDirectoryClient" THEN delay 10s + status 503 PROB 60% FOR 5m AS "File ops failing"
```

#### Cascade 2: Token Refresh Storm

```
MWC token expires → Token refresh fails (AAD throttling) → All authenticated calls fail →
Retry storms amplify load → Circuit breaker should trip but doesn't
```

**FLT code path:**
- `TokenManager.GetTokenAsync()` → retries `MaxRetriesToGetMwcToken` times with `TimeDelayBetweenGetToken` delay
- `GTSBasedSparkClient.GenerateMWCV1TokenForGTSWorkloadAsync()` → token generation fails
- `BaseTokenProvider.RefreshTokenAsync()` → lock contention on `AsyncLock`
- All calls through `PbiSharedApiClient` → 401 → retry → more 401s

**Preset rules:**
```
WHEN req.header.Authorization exists THEN header remove "Authorization" PROB 30% FOR 5m AS "Token strip"
WHEN status == 401 THEN forge status=401 body='{"error":"token_expired"}' PROB 50% FOR 5m AS "Auth failure"
```

#### Cascade 3: Spark Capacity Throttling

```
Spark returns 430 (capacity throttle) → Retry policy enters backoff → Node execution
stalls → DAG scheduler declares timeout → Downstream nodes never start
```

**FLT code path:**
- `GTSBasedSparkClient.SendTransformRequestAsync()` → 430 response → `Retriable = true, RetryAfter = delay`
- `RetryPolicyProviderV2.CreateSparkTransformSubmitRetryPolicy()` → exponential backoff
- `NodeExecutor.ExecuteNodeAsync()` → polling loop stalls → timeout
- `DagExecutionHandlerV2` → downstream nodes blocked by upstream timeout

**Preset rules (via Spark interception after GAP-1 is closed):**
```
WHEN client == "GTSBasedSparkClient" AND method == PUT THEN status 430 + header "Retry-After" = "60" PROB 40% FOR 5m AS "Spark throttle"
```

#### Cascade 4: Catalog Poisoning

```
OneLake returns corrupted metadata → Catalog builds wrong table schema → Spark job
executes with wrong columns → Silent data corruption
```

**FLT code path:**
- `LakeHouseMetastoreClientV2` → `ReadFileAsStringAsync()` returns corrupted JSON
- `CatalogHandler.GetCatalogObjectsAsync()` → `JsonException` or wrong table definitions
- DAG builds node graph with incorrect table metadata
- Spark SQL executes against wrong schema

**Preset rules:**
```
WHEN client == "DatalakeDirectoryClient" AND url contains "/_delta_log/" THEN body find='"numRecords":\d+' replace='"numRecords":0' ON response FOR 3m AS "Corrupt delta metadata"
```

### UX Flow

1. **Open Cascade Builder:** New tab in Chaos Panel: `[Cascades]`
2. **Visual timeline:** Horizontal timeline showing stages as connected blocks
   ```
   [Stage 1: OneLake Slow] ──30s──▸ [Stage 2: 503 Errors] ──30s──▸ [Stage 3: Token Fail] ──15s──▸ [Stage 4: Spark Cascade]
        delay 5s (60s)                 + 503 50% (60s)              + token timeout (60s)           + spark 401 (120s)
   ```
3. **Configure stage:** Click a stage block → side panel shows rules, trigger, duration
4. **Run cascade:** Click `▸ Run Cascade` → confirmation dialog with total duration estimate
5. **Live progress:** Active stage is highlighted green. Upcoming stages are grey. Completed
   stages are dimmed. Health probe status shown in real-time.
6. **Abort:** `■ Abort Cascade` → all rules disabled immediately, rollback executed
7. **Post-mortem:** After cascade completes, a summary panel shows: which stages activated,
   rule fire counts, error rates per stage, and a timeline overlay on the Traffic Monitor

### Composition Rules

- A cascade can reference any existing ChaosRule by ID
- Rules accumulate across stages (Stage 2 includes Stage 1's rules + its own)
- A stage can remove a previous stage's rule by prefixing with `-`: `rules: ["-delay-onelake-5s", "onelake-503"]`
- Cascades can be nested: a stage's "rules" can include another cascade ID (max depth: 3)
- Only one cascade can be active at a time (safety constraint)

### Safety

| Mechanism | Behavior |
|-----------|----------|
| **Max duration** | Cascade has a hard time limit (`maxDuration`). After this, all rules are disabled regardless of stage progress. |
| **Stage steady-state** | Each stage runs its `steadyState` probe before activating. If the system is already unhealthy, the cascade halts. |
| **FLT crash guard** | If `haltOnFltCrash` is true and the FLT process dies, the cascade aborts and all rules are disabled. |
| **Error rate ceiling** | If total error rate exceeds `haltOnErrorRate`%, the cascade aborts. |
| **Kill switch** | `Ctrl+Shift+K` aborts any running cascade and disables all rules. |
| **Single cascade** | Only one cascade can run at a time. Starting a new one aborts the previous. |

### Implementation Complexity

| Component | Size Estimate | Owner |
|-----------|--------------|-------|
| Cascade orchestrator (C# background task) | ~300 LOC | Vex |
| Health probe system (C# polling) | ~150 LOC | Vex |
| Cascade model + JSON schema | ~80 LOC | Sana |
| SignalR messages (cascade events) | ~60 LOC | Vex |
| Cascade Builder UI (timeline + stages) | ~350 LOC JS + CSS | Pixel |
| Cascade templates (4 known paths) | ~200 LOC JSON | Sana |
| **Total** | **~1140 LOC** | **Vex + Pixel + Sana** |

### Revert

Abort the cascade. All rules from all stages are disabled. Rollback action executes. Cascade
state moves to `completed` or `aborted`.

---

## AD-04: Bit-Flip Fuzzer

### Description

Randomly flip bits in response bodies before FLT processes them. Tests deserialization
resilience, null-coalescing paths, and exception handling for corrupted payloads.

### Why This Matters

FLT deserializes JSON from 4+ external services (`Newtonsoft.Json` and `System.Text.Json`).
A single corrupted byte in a OneLake response body can crash the catalog parser, corrupt the
DAG execution state, or silently produce wrong results. The bit-flip fuzzer finds these paths
systematically.

### ChaosRule JSON

```json
{
  "id": "bitflip-onelake-responses",
  "name": "Bit-flip fuzzer: OneLake responses",
  "category": "advanced",
  "phase": "response",
  "predicate": {
    "operator": "and",
    "conditions": [
      { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
      { "field": "statusCode", "op": "equals", "value": 200 },
      { "field": "contentType", "op": "contains", "value": "json" }
    ]
  },
  "action": {
    "type": "fuzz",
    "config": {
      "strategy": "bitflip",
      "intensity": 0.001,
      "targetRegion": "body",
      "preserveLength": true,
      "seed": 42,
      "excludePatterns": ["\"continuationToken\""]
    }
  },
  "probability": 0.2,
  "limits": { "maxFirings": 50, "ttlSeconds": 300 }
}
```

### Fuzzing Strategies

| Strategy | Config | Effect |
|----------|--------|--------|
| `bitflip` | `intensity` (0.0–1.0) | Flip `intensity * body.length` random bits. 0.001 = 1 bit per 1000 bytes. |
| `byteReplace` | `intensity`, `replaceByte` | Replace random bytes with specified value. Default `0x00` (null bytes). |
| `truncate` | `position` (0.0–1.0) | Cut the response body at `position * length`. 0.5 = halfway. |
| `shuffle` | `blockSize` | Shuffle `blockSize`-byte blocks within the body. Destroys JSON structure. |
| `duplicate` | `region` (start, end) | Duplicate a byte range, creating an oversized response. |

### C# Mechanism

```csharp
// Inside ActionExecutor.ExecuteResponse for 'fuzz' action:
var bodyBytes = await response.Content.ReadAsByteArrayAsync();
var rng = new Random(config.Seed ?? Environment.TickCount);

switch (config.Strategy)
{
    case "bitflip":
        int flips = Math.Max(1, (int)(bodyBytes.Length * config.Intensity));
        for (int i = 0; i < flips; i++)
        {
            int pos = rng.Next(bodyBytes.Length);
            int bit = rng.Next(8);
            bodyBytes[pos] ^= (byte)(1 << bit);
        }
        break;
    // ... other strategies
}

response.Content = new ByteArrayContent(bodyBytes);
response.Content.Headers.ContentType = originalContentType;
```

### FLT Code Paths Affected

| Deserialization Site | File | Method | Impact of Corruption |
|---------------------|------|--------|---------------------|
| OneLake path listing | `OneLakeRestClient.cs` | `ListDirsAsync` → `JsonSerializer.Deserialize<PathList>()` | `JsonException` → retry loop → eventual failure |
| Delta log parsing | `LakeHouseMetastoreClientV2.cs` | Gzip decompress + JSON parse | `InvalidDataException` or `JsonException` → `CatalogException` |
| Spark transform response | `GTSBasedSparkClient.cs` | `DeserializeContent<T>()` | `JsonException` → node execution failure → DAG retry |
| Fabric API responses | `FabricApiClient.cs` | `JsonSerializer.Deserialize<T>()` | `JsonException` → `InvalidOperationException` |
| Table maintenance response | `FabricApiClient.cs` | `HandleLongRunningOperationAsync()` | Polling loop confusion → timeout |

### DSL Syntax

```
WHEN client == "DatalakeDirectoryClient" AND status == 200 THEN fuzz bitflip intensity=0.001 seed=42 PROB 20% LIMIT 50 FOR 5m AS "Fuzz OneLake responses"
```

### Edge Cases

- **Binary responses:** Parquet/protobuf files are binary — bit flips cause different
  failure modes (CRC mismatch, invalid headers). The fuzzer works on raw bytes regardless
  of content type.
- **Gzip-compressed bodies:** FLT decompresses some responses (delta logs). The fuzzer
  operates on the wire-format bytes, so flipping bits in gzip data produces decompression
  errors, not JSON errors. This is a valid test (tests error handling at the decompression
  layer).
- **Seed reproducibility:** Setting `seed` ensures identical corruption patterns across runs
  for debugging. The seed + fire count determines the exact bytes flipped.
- **Exclude patterns:** `excludePatterns` prevents corruption in specific JSON fields (e.g.,
  continuation tokens that would break pagination).

### Implementation Complexity

| Component | Size Estimate | Owner |
|-----------|--------------|-------|
| Fuzz action handler (C#, 5 strategies) | ~200 LOC | Vex |
| Fuzz config validation | ~40 LOC | Vex |
| Fuzz stats collector (bits flipped, exceptions triggered) | ~60 LOC | Vex |
| **Total** | **~300 LOC** | **Vex** |

### Revert

Disable the rule. Responses return to normal immediately. No persistent state is modified by
fuzzing — only in-flight responses are corrupted.

---

## AD-05: Preset Scenarios

### Description

One-click activation of named failure scenarios that combine multiple chaos rules into a
coherent outage simulation. Each preset is a curated bundle of rules that together simulate a
real-world failure mode.

### Why This Matters

Creating 4–6 rules to simulate "OneLake is down" takes 5 minutes in the Rule Builder. A
preset does it in one click. More importantly, presets encode **institutional knowledge** about
failure modes — the exact combination of symptoms that appear during a real OneLake outage,
not just "return 503."

### Preset Format

```json
{
  "id": "preset-onelake-outage",
  "name": "Simulate OneLake Outage",
  "description": "Full OneLake service outage affecting file ops, catalog, and directory listing. Tests FLT's degraded-mode behavior and user-facing error messages.",
  "category": "infrastructure",
  "icon": "◆",
  "severity": "high",
  "estimatedDuration": "5m",
  "tags": ["onelake", "outage", "p0"],
  "rules": [
    {
      "id": "preset-onelake-outage--blackhole-writes",
      "name": "[OneLake Outage] Blackhole all writes",
      "phase": "request",
      "predicate": {
        "operator": "and",
        "conditions": [
          { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
          { "field": "method", "op": "not_equals", "value": "GET" }
        ]
      },
      "action": { "type": "blockRequest", "config": { "statusCode": 503, "body": "{\"error\":{\"code\":\"ServiceUnavailable\",\"message\":\"The service is temporarily unavailable. Please retry.\"}}" } },
      "probability": 1.0,
      "limits": { "ttlSeconds": 300 }
    },
    {
      "id": "preset-onelake-outage--slow-reads",
      "name": "[OneLake Outage] Slow reads + intermittent 503",
      "phase": "request",
      "predicate": {
        "operator": "and",
        "conditions": [
          { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
          { "field": "method", "op": "equals", "value": "GET" }
        ]
      },
      "action": {
        "type": "composite",
        "config": {
          "actions": [
            { "type": "delay", "config": { "delayMs": 8000, "jitterMs": 3000 } },
            { "type": "modifyResponseStatus", "config": { "statusCode": 503 } }
          ]
        }
      },
      "probability": 0.6,
      "limits": { "ttlSeconds": 300 }
    },
    {
      "id": "preset-onelake-outage--listing-fail",
      "name": "[OneLake Outage] Directory listing returns 503",
      "phase": "response",
      "predicate": {
        "operator": "and",
        "conditions": [
          { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
          { "field": "url", "op": "contains", "value": "resource=filesystem" }
        ]
      },
      "action": { "type": "forgeResponse", "config": { "statusCode": 503, "body": "{\"error\":{\"code\":\"ServiceUnavailable\"}}", "contentType": "application/json" } },
      "probability": 0.8,
      "limits": { "ttlSeconds": 300 }
    },
    {
      "id": "preset-onelake-outage--token-expire",
      "name": "[OneLake Outage] Force token re-acquisition (simulates credential impact)",
      "phase": "response",
      "predicate": {
        "operator": "and",
        "conditions": [
          { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" },
          { "field": "url", "op": "contains", "value": "/workspaces/" }
        ]
      },
      "action": { "type": "modifyResponseStatus", "config": { "statusCode": 401 } },
      "probability": 0.3,
      "limits": { "ttlSeconds": 300, "maxFirings": 10 }
    }
  ],
  "observeAfter": [
    "Check DAG status — should show degraded or failed nodes",
    "Check log panel — should show OneLake retry messages",
    "Check error rate dashboard — should spike to >50%"
  ]
}
```

### Built-In Presets

| # | Preset | Rules | Tests | Severity |
|---|--------|-------|-------|----------|
| 1 | **Simulate OneLake Outage** | Blackhole writes + slow reads + listing fail + token expire | Degraded mode, error messages, retry storms | High |
| 2 | **Simulate Spark Capacity Shortage** | 430 throttle on submit + slow status polling + 429 storm | Backoff behavior, node timeout, DAG rescheduling | High |
| 3 | **Simulate Fabric API Downtime** | 503 on all PbiSharedApiClient calls + delay 10s | Workspace/lakehouse resolution failure, metadata staleness | Medium |
| 4 | **Simulate Token Refresh Storm** | Strip auth headers 30% + forge 401 50% + delay token endpoints | Token cache behavior, lock contention, retry amplification | High |
| 5 | **Simulate Slow Network** | Delay 2s all requests + throttle bandwidth 50KB/s | Timeout handling, UI responsiveness during latency | Low |
| 6 | **Simulate Catalog Corruption** | Fuzz delta log responses + truncate metadata + empty body on catalog calls | JSON parsing, schema validation, null handling | Medium |
| 7 | **Simulate Intermittent Failures** | 20% random 500 on all clients | Retry policy effectiveness, partial failure resilience | Low |
| 8 | **Simulate Regional Failover** | Rewrite OneLake endpoint URL + delay 5s + 503 20% | Endpoint resolution, failover logic, cross-region latency | Medium |

### UX Flow

```
┌─ Chaos Panel ─ Presets ──────────────────────────────────────┐
│                                                               │
│  ◆ INFRASTRUCTURE                                             │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ● Simulate OneLake Outage               [▸ Activate]   │  │
│  │   4 rules · 5m duration · HIGH severity                 │  │
│  │   Tests: degraded mode, retry storms, error messages    │  │
│  ├─────────────────────────────────────────────────────────┤  │
│  │ ● Simulate Spark Capacity Shortage      [▸ Activate]   │  │
│  │   3 rules · 5m duration · HIGH severity                 │  │
│  │   Tests: backoff, node timeout, DAG rescheduling        │  │
│  ├─────────────────────────────────────────────────────────┤  │
│  │ ● Simulate Fabric API Downtime          [▸ Activate]   │  │
│  │   2 rules · 5m duration · MEDIUM severity               │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ◆ SECURITY                                                   │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ● Simulate Token Refresh Storm          [▸ Activate]   │  │
│  │   3 rules · 5m duration · HIGH severity                 │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ◆ CUSTOM                                                     │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ + Create Preset from Active Rules                       │  │
│  │ + Import Preset (.chaos-preset.json)                    │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

1. **Browse presets:** Organized by category (Infrastructure, Security, Custom)
2. **Preview:** Click preset name → expands to show all contained rules with descriptions
3. **Activate:** Click `▸ Activate` → confirmation dialog showing all rules + total duration
4. **Running indicator:** Active preset shows green pulse + countdown timer
5. **Observe:** After activation, `observeAfter` checklist is shown as a floating reminder
6. **Deactivate:** Click `■ Stop` → all preset rules disabled immediately
7. **Create custom:** Button to snapshot current active rules into a new preset
8. **Share:** Export as `.chaos-preset.json` → import on another machine

### DSL Integration

Presets can be activated from the DSL:

```
PRESET "Simulate OneLake Outage" FOR 5m
PRESET "Simulate Spark Capacity Shortage" PROB 50% FOR 10m
```

### Composition Rules

- Activating a preset creates all its rules as a group (atomically)
- Deactivating a preset disables all its rules (atomically)
- Individual rules within a preset CAN be disabled/modified after activation
- Multiple presets CAN be active simultaneously (rules accumulate, conflicts resolved by priority)
- Preset rules are tagged with `presetId` for grouped management

### Implementation Complexity

| Component | Size Estimate | Owner |
|-----------|--------------|-------|
| Preset model + JSON schema | ~60 LOC | Sana |
| Preset store (load/save/activate/deactivate) | ~150 LOC C# | Vex |
| 8 built-in preset definitions | ~400 LOC JSON | Sana |
| Preset UI (list, preview, activate, create) | ~250 LOC JS + CSS | Pixel |
| Preset import/export | ~60 LOC JS | Pixel |
| **Total** | **~920 LOC** | **Sana + Vex + Pixel** |

### Revert

Deactivate the preset. All rules are disabled atomically. Preset definition is not deleted.

---

## AD-06: Rule Composition

### Description

Combine multiple actions into a single rule's `THEN` clause. Instead of creating 3 separate
rules for "delay 2s AND inject 429 AND add Retry-After header," compose them into one rule
that fires atomically.

### Why This Matters

Real failure modes aren't single-symptom. A 429 response always includes a `Retry-After`
header and often arrives after a brief delay. Three separate rules for these three effects
means three independent probability rolls — the user might get a 429 without the Retry-After,
or a delay without the 429. Composition ensures correlated effects fire together.

### ChaosRule JSON

The `composite` action type wraps multiple actions:

```json
{
  "id": "realistic-429-onelake",
  "name": "Realistic 429 with Retry-After and delay",
  "phase": "both",
  "predicate": {
    "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient"
  },
  "action": {
    "type": "composite",
    "config": {
      "actions": [
        { "type": "delay", "config": { "delayMs": 500, "jitterMs": 200 } },
        { "type": "modifyResponseStatus", "config": { "statusCode": 429 } },
        { "type": "modifyResponseHeader", "config": { "operation": "set", "name": "Retry-After", "value": "30" } },
        { "type": "modifyResponseBody", "config": { "find": ".*", "replace": "{\"error\":{\"code\":\"TooManyRequests\",\"message\":\"Rate limit exceeded\"}}", "regex": true } }
      ],
      "executionOrder": "sequential",
      "stopOnError": true
    }
  },
  "probability": 0.3,
  "limits": { "maxFirings": 20, "ttlSeconds": 300 }
}
```

### Execution Semantics

| Property | Behavior |
|----------|----------|
| `sequential` | Actions execute in array order. Each action receives the output of the previous. |
| `stopOnError` | If an action throws, remaining actions are skipped. The partial result is returned. |
| **Phase mixing** | A composite can include both request-phase and response-phase actions. Request actions run before `base.SendAsync()`, response actions run after. |
| **Short-circuit** | If any action sets `ShortCircuit = true` (e.g., `blockRequest`, `forgeResponse`), remaining request-phase actions still execute, but `base.SendAsync()` is skipped and response-phase actions operate on the forged response. |

### C# Mechanism

```csharp
// CompositeActionExecutor.cs
public async Task<ActionResult> Execute(CompositeConfig config, ChaosEvalContext ctx, CancellationToken ct)
{
    var result = new ActionResult();
    var requestActions = config.Actions.Where(a => IsRequestPhase(a.Type));
    var responseActions = config.Actions.Where(a => IsResponsePhase(a.Type));

    // Execute request-phase actions
    foreach (var action in requestActions)
    {
        try
        {
            var subResult = await ActionExecutor.ExecuteRequest(action, ctx, ct);
            if (subResult.ShortCircuit) result.ShortCircuit = true;
            if (subResult.Response != null) result.Response = subResult.Response;
        }
        catch when (config.StopOnError) { break; }
    }

    // If short-circuited, response-phase actions operate on the forged response
    if (!result.ShortCircuit)
    {
        // Caller proceeds to base.SendAsync(), then calls us again for response phase
        result.PendingResponseActions = responseActions.ToList();
    }
    else
    {
        // Execute response-phase actions on the forged response
        foreach (var action in responseActions)
        {
            try
            {
                result.Response = await ActionExecutor.ExecuteResponse(action, ctx, result.Response, ct);
            }
            catch when (config.StopOnError) { break; }
        }
    }

    return result;
}
```

### DSL Syntax

The `+` operator in `THEN` clauses creates composite actions:

```
WHEN client == "OneLakeRestClient" THEN delay 500ms + status 429 + header "Retry-After" = "30" PROB 30% LIMIT 20 FOR 5m
```

### Composition Constraints

| Constraint | Rule | Reason |
|-----------|------|--------|
| Max actions per composite | 8 | Performance: each action adds overhead |
| No nested composites | Composite cannot contain another composite | Complexity: flat is better than nested |
| Phase consistency | Request + response actions in one composite is allowed but must be explicit (`phase: "both"`) | Clarity: user must acknowledge cross-phase behavior |
| Conflicting actions | `blockRequest` + `redirect` in same composite = validation error | Ambiguous: both try to short-circuit |
| `forgeResponse` position | Must be the last response-phase action in the composite | After forging, further response modifications are valid but `forgeResponse` replaces everything |

### Implementation Complexity

| Component | Size Estimate | Owner |
|-----------|--------------|-------|
| `CompositeActionExecutor` (C#) | ~120 LOC | Vex |
| Composite validation (conflict detection) | ~60 LOC | Vex |
| DSL `+` operator parsing | ~30 LOC JS (in existing parser) | Pixel |
| Rule Builder "Add Action" UI | ~80 LOC JS + CSS | Pixel |
| **Total** | **~290 LOC** | **Vex + Pixel** |

### Revert

Disable the composite rule. All constituent actions stop firing together.

---

## AD-07: Scheduled Chaos

### Description

Schedule chaos rules to activate at specific wall-clock times. "At 2:30 PM, enable this rule
for 5 minutes" — enabling timed experiments, lunch-break chaos, and coordination with team
members working in different time zones.

### Why This Matters

Two use cases drive this:

1. **Coordinated testing:** "I'll trigger the OneLake outage preset at 2:30 PM. Watch the
   DAG logs and tell me what you see." The engineer sets up the schedule, then both people
   observe the results live.
2. **Unattended chaos:** "I want to test how FLT behaves under intermittent failures over
   the next hour while I'm in a meeting." Schedule 3 different failure patterns at 15-minute
   intervals, review the results after.

### Schedule Model

```json
{
  "id": "sched-afternoon-spark-slow",
  "name": "Afternoon Spark slowdown",
  "type": "one-time",
  "schedule": {
    "activateAt": "2025-07-22T14:30:00",
    "timezone": "local",
    "duration": "5m"
  },
  "rules": ["delay-spark-10s", "spark-429-20pct"],
  "notification": {
    "beforeActivation": "30s",
    "message": "Scheduled chaos 'Afternoon Spark slowdown' activating in 30 seconds"
  }
}
```

### Schedule Types

| Type | Config | Behavior |
|------|--------|----------|
| `one-time` | `activateAt`, `duration` | Activate at specified time, disable after duration |
| `recurring` | `cron`, `duration` | Cron-style schedule: `"*/15 * * * *"` = every 15 min |
| `random-window` | `windowStart`, `windowEnd`, `duration`, `count` | Activate `count` times at random moments within the window |

#### One-Time Schedule

```json
{
  "type": "one-time",
  "schedule": {
    "activateAt": "2025-07-22T14:30:00",
    "timezone": "local",
    "duration": "5m"
  }
}
```

#### Recurring Schedule

```json
{
  "type": "recurring",
  "schedule": {
    "cron": "*/15 * * * *",
    "timezone": "local",
    "duration": "2m",
    "maxOccurrences": 4
  }
}
```

Every 15 minutes, activate rules for 2 minutes. Stop after 4 occurrences.

#### Random Window Schedule

```json
{
  "type": "random-window",
  "schedule": {
    "windowStart": "2025-07-22T13:00:00",
    "windowEnd": "2025-07-22T17:00:00",
    "timezone": "local",
    "duration": "3m",
    "count": 3,
    "minGap": "15m"
  }
}
```

Activate 3 times at random moments between 1 PM and 5 PM, each lasting 3 minutes, with at
least 15 minutes between activations. The exact times are determined at creation (using a
seeded RNG) and shown to the user for transparency.

### ChaosRule Integration

Scheduling adds a `schedule` field to the rule's `limits` object:

```json
{
  "id": "delay-spark-10s",
  "name": "Delay Spark calls 10s",
  "predicate": { "field": "httpClientName", "op": "equals", "value": "GTSBasedSparkClient" },
  "action": { "type": "delay", "config": { "delayMs": 10000, "jitterMs": 2000 } },
  "enabled": false,
  "limits": {
    "ttlSeconds": 300,
    "schedule": {
      "type": "one-time",
      "activateAt": "2025-07-22T14:30:00",
      "timezone": "local"
    }
  }
}
```

The rule starts `enabled: false`. The scheduler activates it at `activateAt` and deactivates
it after `ttlSeconds`.

### C# Mechanism

The scheduler is a lightweight `IHostedService` background task:

```csharp
public class ChaosScheduler : BackgroundService
{
    private readonly ChaosRuleStore _store;
    private readonly SortedSet<ScheduledEvent> _timeline = new();

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var now = DateTime.Now; // Local time
            var due = _timeline.Where(e => e.TriggerTime <= now).ToList();

            foreach (var evt in due)
            {
                if (evt.Action == ScheduleAction.Activate)
                {
                    _store.EnableRule(evt.RuleId);
                    TopicRouter.Publish("chaos", new { type = "schedule-activated", ruleId = evt.RuleId });
                }
                else // Deactivate
                {
                    _store.DisableRule(evt.RuleId);
                    TopicRouter.Publish("chaos", new { type = "schedule-deactivated", ruleId = evt.RuleId });
                }
                _timeline.Remove(evt);
            }

            await Task.Delay(1000, ct); // Check every second
        }
    }
}
```

### DSL Syntax

```
# One-time
WHEN url ~ /spark/ THEN delay 10s AT 14:30 FOR 5m AS "Afternoon Spark test"

# Recurring (every 15 min)
WHEN url ~ /onelake/ THEN status 503 PROB 20% EVERY 15m FOR 2m LIMIT 4 AS "Periodic OneLake test"

# Random window (implicit via BETWEEN)
WHEN client == "FabricApiClient" THEN delay 5s BETWEEN 13:00-17:00 FOR 3m COUNT 3 AS "Random Fabric delays"
```

### UX Flow

```
┌─ Schedule Panel ───────────────────────────────────────────┐
│                                                             │
│  Upcoming                                                   │
│  ───────                                                    │
│  14:30:00  ● Afternoon Spark slowdown (5m)     [✕ Cancel]  │
│  14:45:00  ● Periodic OneLake test #1 (2m)     [✕ Cancel]  │
│  15:00:00  ● Periodic OneLake test #2 (2m)     [✕ Cancel]  │
│  15:12:34  ● Random Fabric delays #1 (3m)      [✕ Cancel]  │
│                                                             │
│  History                                                    │
│  ───────                                                    │
│  14:15:00  ✓ Quick latency test (2m) — completed            │
│  14:00:00  ✓ Initial smoke test (1m) — completed            │
│                                                             │
│  [+ Schedule New]                                           │
└─────────────────────────────────────────────────────────────┘
```

1. **Schedule creation:** Via Rule Builder (add schedule to any rule), DSL (`AT` modifier),
   or dedicated Schedule panel
2. **Timeline view:** Shows upcoming scheduled events as a vertical timeline
3. **Pre-activation notification:** 30 seconds before activation, a toast notification
   appears: `⚠ Scheduled chaos 'Afternoon Spark slowdown' activating in 30s`
4. **Active indicator:** During scheduled chaos, the top bar shows a countdown:
   `⏱ Chaos active: 4:32 remaining`
5. **Cancel:** Any scheduled event can be cancelled before activation
6. **History:** Completed scheduled events show in the history with fire counts and duration

### Edge Cases

- **Past time:** Scheduling a rule for a time that has already passed → immediate activation
  with a warning: `Schedule time is in the past. Activating immediately.`
- **Overlapping schedules:** Two schedules that overlap in time → both activate. Rules
  accumulate (same as enabling multiple rules manually).
- **EDOG restart:** Schedules are stored in-memory by default. If EDOG restarts, pending
  schedules are lost. Optional persistence to `.edog-schedules.json` for recovery.
- **Timezone:** All times are local by default. UTC can be specified via `timezone: "utc"`.
- **Recurring limit:** `maxOccurrences` is required for recurring schedules to prevent
  forgotten infinite loops.

### Implementation Complexity

| Component | Size Estimate | Owner |
|-----------|--------------|-------|
| `ChaosScheduler` background service (C#) | ~150 LOC | Vex |
| Schedule model + JSON schema | ~60 LOC | Sana |
| Recurring schedule (cron parsing) | ~100 LOC C# | Vex |
| Random window calculator | ~50 LOC C# | Vex |
| SignalR schedule events | ~40 LOC | Vex |
| Schedule UI (timeline, create, cancel) | ~200 LOC JS + CSS | Pixel |
| DSL schedule modifiers (`AT`, `EVERY`, `BETWEEN`) | ~50 LOC JS | Pixel |
| **Total** | **~650 LOC** | **Vex + Pixel + Sana** |

### Revert

Cancel the schedule. If already activated, use the standard rule disable or kill switch.

---

## AD-08: Waterfall Timeline

### Description

Chrome DevTools-style waterfall visualization for all HTTP requests made during a single DAG
execution. Shows request timing, parallelism, dependencies, and which chaos rules affected
each request.

### Why This Matters

A DAG execution makes 50–200 HTTP calls across OneLake, Spark, Fabric API, and catalog
services. Understanding the timing and dependencies of these calls is critical for:
- Identifying the critical path (which call is the bottleneck?)
- Seeing chaos rule impact (the delayed requests are visually obvious)
- Debugging cascading failures (which call failed first, and what happened after?)

### Architecture

The waterfall consumes data already published to the `http` topic by `EdogHttpPipelineHandler`.
No new interceptor work required — only a frontend visualization module.

### Data Model

Each waterfall entry is a `TopicEvent` from the `http` topic, augmented with chaos metadata:

```json
{
  "sequenceId": 42,
  "timestamp": "2025-07-22T14:31:05.123Z",
  "topic": "http",
  "data": {
    "method": "PUT",
    "url": "https://onelake.dfs.fabric.microsoft.com/...",
    "statusCode": 200,
    "durationMs": 245,
    "httpClientName": "DatalakeDirectoryClient",
    "correlationId": "abc-123"
  },
  "chaosMetadata": {
    "rulesMatched": ["delay-onelake-5s"],
    "actionsApplied": ["delay:5000ms"],
    "originalDurationMs": null,
    "wasShortCircuited": false
  }
}
```

### Waterfall UI

```
┌─ Waterfall Timeline ── DAG Execution abc-123 ──────────────────────────────────────────┐
│                                                                                         │
│  Time  0s    2s    4s    6s    8s    10s   12s   14s   16s   18s   20s                 │
│  ──────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼──                │
│                                                                                         │
│  GET  /catalogs/tables     ████████░░ 3.2s                                              │
│  GET  /catalogs/shortcuts  ████░░ 1.8s                                                  │
│  PUT  /spark/transform/n1       ██████████████████████████████ 12.4s  ⚡ delay-5s        │
│  PUT  /spark/transform/n2       ████████████████████████ 10.1s  ⚡ delay-5s              │
│  GET  /spark/status/n1                                    ██░░ 0.8s                     │
│  GET  /spark/status/n1                                      ██░░ 0.9s                   │
│  GET  /spark/status/n2                                    ████░░ 1.2s                   │
│  GET  /spark/status/n2                                        ██░░ 0.7s                 │
│  PUT  /onelake/result/n1                                        ████████░░ 3.5s         │
│  PUT  /onelake/result/n2                                            ██████░░ 2.8s       │
│                                                                                         │
│  Legend: ████ = network  ░░ = waiting  ⚡ = chaos rule applied                           │
│  Total: 20.1s · 10 requests · 2 chaos-affected · 0 errors                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Visual encoding:**

| Element | Visual | Meaning |
|---------|--------|---------|
| Solid bar | `████` | Active network time |
| Faded bar | `░░` | Time waiting (queued or delayed by chaos) |
| Lightning icon | `⚡` | Chaos rule was applied to this request |
| Red bar | `████` | Request resulted in error (4xx/5xx) |
| Green bar | `████` | Successful request (2xx) |
| Amber bar | `████` | Slow request (>P95 for this endpoint) |
| Vertical line | `│` | DAG stage boundary |
| Horizontal gap | ` ` | Idle time between requests |

### Interaction

- **Hover:** Shows tooltip with full URL, status code, duration, headers, chaos rules
- **Click:** Opens detail panel with full request/response headers + body preview
- **Filter:** Dropdown to filter by `httpClientName`, status code range, or chaos-affected only
- **Zoom:** Mouse wheel zooms the timeline. Drag to pan.
- **Auto-scroll:** When a DAG is actively running, the timeline auto-scrolls to show new
  requests. Click anywhere to pin the view.

### Correlation with DAG Nodes

Requests are grouped by DAG node using the `correlationId` or `iterationId` from the
`http` and `perf` topics:

```
┌─ Node: customer_table ──────────────────────────────────────────┐
│  PUT  /spark/transform/c1  ████████████████ 8.2s  ⚡ delay-5s   │
│  GET  /spark/status/c1            ██░░ 0.9s                     │
│  GET  /spark/status/c1              ██░░ 0.8s (Succeeded)       │
│  PUT  /onelake/result/c1              ████████░░ 3.5s           │
└──────────────────────────────────────────────────────────────────┘
┌─ Node: order_table ─────────────────────────────────────────────┐
│  PUT  /spark/transform/o1  ████████████ 6.1s  ⚡ delay-5s       │
│  GET  /spark/status/o1          ████░░ 1.2s                     │
│  GET  /spark/status/o1            ██░░ 0.7s (Succeeded)         │
│  PUT  /onelake/result/o1            ██████░░ 2.8s               │
└──────────────────────────────────────────────────────────────────┘
```

### Implementation Complexity

| Component | Size Estimate | Owner |
|-----------|--------------|-------|
| Waterfall renderer (Canvas 2D) | ~350 LOC JS | Pixel |
| Request grouping by DAG node | ~80 LOC JS | Pixel |
| Tooltip + detail panel | ~120 LOC JS + CSS | Pixel |
| Zoom/pan interaction | ~100 LOC JS | Pixel |
| Chaos metadata overlay | ~60 LOC JS | Pixel |
| SignalR subscription + buffering | ~50 LOC JS | Pixel |
| **Total** | **~760 LOC** | **Pixel** |

### Revert

N/A — observability-only feature. No state to revert.

---

## Cross-Cutting Concerns

### Feature Interactions

| Feature A | Feature B | Interaction | Resolution |
|-----------|-----------|-------------|------------|
| DSL (AD-01) | Presets (AD-05) | Presets can be defined as `.chaos` files | DSL compiler handles `PRESET` statements |
| DSL (AD-01) | Scheduling (AD-07) | `AT` modifier in DSL | Parser maps to schedule model |
| DSL (AD-01) | Composition (AD-06) | `+` in THEN clause | Parser creates composite action |
| Response Cache (AD-02) | Presets (AD-05) | "Offline Development" preset activates cache mode | Preset includes `cacheReplay` rule |
| Cascading (AD-03) | Presets (AD-05) | Cascades reference preset rules by ID | Cascade stage can reference a preset |
| Cascading (AD-03) | Scheduling (AD-07) | Cascade can be scheduled to start at a specific time | Schedule wraps cascade activation |
| Fuzzer (AD-04) | Composition (AD-06) | Fuzz + delay in one composite rule | Composite can include fuzz action |
| Waterfall (AD-08) | All chaos features | All chaos actions are visible in waterfall | Chaos metadata overlay on every request |

### Conflict Resolution

When multiple features interact, conflicts are resolved by:

1. **Priority:** Lower `priority` value wins (0 = highest)
2. **Phase:** Request-phase rules always execute before response-phase
3. **Short-circuit:** First `blockRequest` or `forgeResponse` wins. Later short-circuit
   actions see the forged response, not the real one.
4. **Composite atomicity:** Actions within a composite are guaranteed to fire together.
   External rules cannot interleave.

### Performance Budget

| Feature | Hot Path Overhead | Cold Path | Memory |
|---------|-------------------|-----------|--------|
| DSL (AD-01) | 0 (compiles to JSON, same as GUI rules) | Compile: <50ms for 100 rules | Compiler: ~50KB JS |
| Response Cache (AD-02) | Cache lookup: ~1ms (SHA256 + file I/O) | Cache write: ~5ms per response | Proportional to cache size |
| Cascading (AD-03) | Health probe: ~1ms every 5s | Stage transition: ~10ms | Cascade state: <1KB |
| Fuzzer (AD-04) | Byte manipulation: <1ms for typical JSON | — | Zero (modifies in-place) |
| Presets (AD-05) | 0 (presets are just rule groups) | Activation: ~5ms for 8 rules | Preset definitions: ~10KB |
| Composition (AD-06) | N × single action cost | — | Composite config: <1KB |
| Scheduling (AD-07) | Timer check: <1ms every 1s | — | Schedule list: <1KB |
| Waterfall (AD-08) | 0 (reads existing `http` topic data) | Render: <16ms per frame (Canvas 2D) | DOM-free (Canvas), ~2KB per request entry |

**Total C06 overhead in hot path (all features active):** <5ms. Within the 10ms budget from
`engine-design.md § 3.2`.

---

## Implementation Order

```
Phase 1 (P1 priority):
  AD-05: Preset Scenarios        ← Highest value, simplest to build
  AD-08: Waterfall Timeline      ← Observability-only, no engine changes

Phase 2 (P2 priority, after C01-C05 ship):
  AD-06: Rule Composition        ← Needed by DSL and presets
  AD-01: Chaos DSL               ← Depends on AD-06 for + syntax
  AD-07: Scheduled Chaos         ← Independent module

Phase 3 (P2 priority, after Phase 2):
  AD-02: Response Cache Mode     ← New action type, needs cache infra
  AD-03: Cascading Failure Sim   ← Needs orchestrator + health probes
  AD-04: Bit-Flip Fuzzer         ← New action type, simple implementation
```

Each phase is independently shippable. Phase 1 delivers immediate value with minimal
engine changes. Phase 2 adds power-user input methods. Phase 3 adds advanced simulation
capabilities.

---

## Open Questions (For CEO Review)

| # | Question | Options | Sana's Recommendation |
|---|----------|---------|----------------------|
| 1 | Should the DSL be a priority before all C01-C05 categories ship? | (a) Yes, DSL is a productivity multiplier. (b) No, GUI first, DSL later. | **(b)** — DSL is sugar over rules. Ship the rules first. |
| 2 | Response Cache: should cached sessions persist across EDOG restarts? | (a) Yes, always persist. (b) Opt-in persistence. (c) Memory-only. | **(b)** — Opt-in. Default is ephemeral for safety. |
| 3 | Cascading sims: max cascade depth? | (a) 4 stages. (b) 8 stages. (c) Unlimited. | **(b)** — 8 stages covers every known FLT cascade path. |
| 4 | Scheduled chaos: support for recurring schedules in V1? | (a) Yes, full cron. (b) One-time only in V1. | **(b)** — One-time in V1. Recurring adds complexity. |
| 5 | Presets: should users be able to modify built-in presets? | (a) Yes, editable. (b) Read-only, clone to customize. | **(b)** — Clone. Preserves institutional knowledge in originals. |

---

## Summary

C06 is the layer where chaos engineering stops being a feature and becomes a **workflow**.
The DSL makes rule creation fast. Presets make failure simulation accessible. Cascades make
multi-service outage testing possible. Scheduling enables unattended experiments. Response
cache enables offline development. And the waterfall makes it all observable.

Every C06 feature decomposes into C01–C05 primitives. The engine doesn't need to know about
DSL syntax or preset definitions or cascade orchestration. It just evaluates ChaosRules —
the same rules it already knows. C06 is pure orchestration and UX.

**Total estimated implementation:** ~5,490 LOC across 8 features, 3 owners.

---

*"Composition is the architect's superpower. Build small, compose large, observe everything."*

— Sana Reeves, EDOG Studio Architect
