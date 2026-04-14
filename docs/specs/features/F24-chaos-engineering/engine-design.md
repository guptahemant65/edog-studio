# ChaosRule Engine Design

> **Author:** Sana Reeves (Architect)
> **Status:** P2.4 COMPLETE — Industry Study + Synthesized Rule Model + Final Engine Architecture
> **Date:** 2025-07-25 (P2.1–P2.4 appended)
> **Depends On:** `EdogHttpPipelineHandler` (DelegatingHandler), `EdogTopicRouter`, `EdogPlaygroundHub`

---

## Section 1: Industry Study

Six tools studied, each representing a different facet of HTTP interception and chaos engineering. For each: rule format, predicates, actions, lifecycle, safety, and UX.

---

### 1.1 Burp Suite (PortSwigger)

**What it is:** Professional web security testing proxy. Intercepts browser ↔ server traffic. The gold standard for manual HTTP interception with rule-based automation.

#### Rule Definition Format

Burp uses two rule systems:

1. **Match and Replace Rules** — declarative string/regex substitution applied automatically to all proxied traffic.
2. **Interception Rules** — boolean predicate chains that decide which requests/responses to pause for manual editing.

**Match and Replace** rules are defined as:
```
{ type, match, replace, regex: bool, enabled: bool, comment }
```

Where `type` is one of:
- `Request header` / `Response header`
- `Request body` / `Response body`
- `Request first line` (method + URL)
- `Request param name` / `Request param value`

**Interception Rules** use boolean combinator chains:
```
Rule 1: [AND/OR] [match_type] [matches/does_not_match] [value]
Rule 2: [AND/OR] [match_type] [matches/does_not_match] [value]
```

Match types: domain name, IP address, protocol, HTTP method, URL, file extension, request/response headers, body content, listener port, proxy listener address.

#### Predicate System

| Predicate | Scope | Notes |
|-----------|-------|-------|
| URL regex | Request | Full URL or path pattern |
| Domain | Request | Hostname matching |
| IP address | Request | Destination IP |
| HTTP method | Request | GET, POST, etc. |
| File extension | Request | `.js`, `.css`, etc. |
| Header name:value | Request/Response | Regex on header line |
| Body content | Request/Response | Regex on body |
| Status code | Response | Numeric match |
| Protocol | Request | HTTP vs HTTPS |
| Listener port | Meta | Which Burp listener received it |
| In-scope | Meta | Whether URL is in the project's target scope |

**Key insight:** Burp combines predicates with **AND/OR boolean operators** in ordered chains. Rules are evaluated top-down, combined with the chosen operator. This is more expressive than simple AND-all.

#### Action System

- **Match and Replace:** Regex find-replace on headers, body, URL, params. Supports capture groups (`$1`, `$2`) in replacement strings.
- **Interception:** Pause traffic for manual editing (then forward, drop, or modify).
- **Response Modification:** Automatic HTML rewriting (unhide fields, remove JS, strip TLS, remove cookies).
- **Script Mode:** Full Java-based scripting for complex transformations (Pro feature).

#### Lifecycle

Rules are project-scoped. Enabled/disabled via checkbox per rule. Order matters — rules execute top-down. No versioning, no expiry, no firing limits.

#### Safety

- **Scope system:** Rules can be limited to "in-scope items only" — a user-defined set of target domains/paths. This prevents accidental modification of out-of-scope traffic.
- **TLS pass-through:** Excluded hosts bypass interception entirely.
- **No auto-revert.** Burp assumes the user is in control. If you break something, you fix it manually.

#### UX

GUI-first. Table of rules with checkboxes, drag-to-reorder. Inline test function to preview match results. Script mode for power users. No API, no config file export (rules are in the project file).

**What EDOG should steal:**
- ✅ The `type` field (request header, response body, etc.) that scopes where the match runs — reduces false positives
- ✅ Boolean AND/OR rule combinators for complex predicates
- ✅ Regex with capture groups in replacements
- ✅ "In-scope" concept → map to HttpClient name filter
- ✅ Inline test/preview before activating a rule
- ❌ Manual interception (pause for editing) — doesn't fit automated DelegatingHandler model

---

### 1.2 mitmproxy

**What it is:** Open-source Python-scriptable HTTPS proxy. The programmable Swiss Army knife of HTTP interception.

#### Rule Definition Format

mitmproxy has two complementary systems:

1. **Filter Expressions** — a terse DSL for selecting flows (used in CLI, UI, and scripts)
2. **Addon Scripts** — Python classes with hook methods (`request()`, `response()`, `error()`) that receive the full `HTTPFlow` object for arbitrary read/write

**Filter DSL syntax:**
```
~u regex       URL match
~d regex       Domain match
~m regex       Method match
~h regex       Any header (request or response)
~hq regex      Request header only
~hs regex      Response header only
~b regex       Body (request or response)
~bq regex      Request body only
~bs regex      Response body only
~c int         Response status code
~t regex       Content-Type header
~tq regex      Request Content-Type
~ts regex      Response Content-Type
~s             Has response (completed flow)
~q             Request only (no response yet)
~e             Error flow
~a             Asset (CSS, JS, images, fonts)
~dst regex     Destination address
~src regex     Source address
~marked        Marked flows
~comment regex Flow comment
```

**Combinators:** `!` (not), `&` (and), `|` (or), `(...)` (grouping). Default operator is `&`.

#### Predicate System

The richest predicate system of any tool studied:

| Predicate | Operator | Phase |
|-----------|----------|-------|
| URL | `~u` | Request |
| Domain | `~d` | Request |
| Method | `~m` | Request |
| Request header | `~hq` | Request |
| Response header | `~hs` | Response |
| Request body | `~bq` | Request |
| Response body | `~bs` | Response |
| Status code | `~c` | Response |
| Content-Type | `~t`, `~tq`, `~ts` | Both |
| Source/Dest address | `~src`, `~dst` | Connection |
| Asset type | `~a` | Response |
| Flow state | `~s`, `~q`, `~e` | Meta |

**Key insight:** mitmproxy separates **request-phase** and **response-phase** predicates explicitly (e.g., `~hq` vs `~hs`). This maps perfectly to EDOG's two-phase rule evaluation.

#### Action System

In addon scripts, **anything goes** — the full `HTTPFlow` object is mutable:

```python
def request(flow: http.HTTPFlow):
    flow.request.headers["X-Injected"] = "true"     # Add header
    flow.request.url = flow.request.url.replace(     # Rewrite URL
        "prod", "staging")
    flow.response = http.Response.make(503, b"down") # Short-circuit: forge response

def response(flow: http.HTTPFlow):
    flow.response.status_code = 200                  # Change status
    flow.response.headers["Cache-Control"] = "no-store"
    import json
    data = json.loads(flow.response.content)
    data["items"] = data["items"][:5]                # Modify JSON body
    flow.response.content = json.dumps(data).encode()
```

Actions are not enumerated — they're arbitrary code. This is powerful but not declarative.

#### Lifecycle

Scripts are loaded at startup or hot-reloaded. Filters are ephemeral (typed into the UI/CLI). No persistence model, no rule versioning, no firing limits. The user manages state.

#### Safety

- **No built-in safety.** mitmproxy is a power tool. If your script throws an exception, the flow continues unmodified (safe default). But there's no kill switch, no blast radius control, no auto-revert.
- **Replay:** Flows can be saved and replayed, providing a manual recovery path.

#### UX

Three interfaces: interactive terminal UI (`mitmproxy`), web UI (`mitmweb`), headless dump (`mitmdump`). Filter expressions work everywhere. Scripts are Python files loaded via `-s script.py`.

**What EDOG should steal:**
- ✅ The filter DSL syntax — terse, composable, powerful. Best predicate language studied.
- ✅ Explicit request-phase vs response-phase predicate separation (`~hq` vs `~hs`)
- ✅ Logical combinators with grouping (`!`, `&`, `|`, `(...)`)
- ✅ The `HTTPFlow` object model — request + response + metadata in one context object
- ❌ Arbitrary scripting — EDOG needs declarative rules for safety and serialization
- ❌ No lifecycle management — EDOG needs firing limits, auto-disable, expiry

---

### 1.3 Charles Proxy

**What it is:** Commercial GUI HTTP proxy popular with mobile and web developers. Known for excellent UX around common interception tasks.

#### Rule Definition Format

Charles uses **four separate tools**, each with its own rule model:

1. **Map Remote** — URL → URL rewriting (redirect requests to a different server)
   ```
   From: { protocol, host, port, path, query }
   To:   { protocol, host, port, path, query }
   ```
   Supports wildcards (`*`) in any field. Preserves unspecified fields.

2. **Map Local** — URL → local file (serve responses from disk)
   ```
   Location: { protocol, host, port, path, query }  → File: /path/to/file.json
   ```

3. **Rewrite** — header/body/URL transformation rules, grouped into named sets
   ```
   Set: "API Rewrites"
     Location: { protocol, host, port, path }    ← scoping
     Rules: [
       { type: "Modify Header", where: "Response", match: { name, value }, replace: { name, value } },
       { type: "Body", where: "Response", match: "oldValue", replace: "newValue", regex: true },
       { type: "Add Header", where: "Request", name: "X-Debug", value: "true" },
     ]
   ```
   Rewrite types: Add/Modify/Remove Header, Host, Path, URL, Query Param, Response Status, Body.

4. **Breakpoints** — pause request/response for manual editing
   ```
   { scheme, host, port, path, query, enabled, request: bool, response: bool }
   ```

#### Predicate System

| Predicate | Map Remote | Map Local | Rewrite | Breakpoints |
|-----------|-----------|-----------|---------|-------------|
| Protocol (HTTP/HTTPS) | ✓ | ✓ | ✓ | ✓ |
| Host | ✓ (wildcard) | ✓ (wildcard) | ✓ (wildcard) | ✓ |
| Port | ✓ | ✓ | ✓ | ✓ |
| Path | ✓ (wildcard) | ✓ (wildcard) | ✓ (wildcard) | ✓ |
| Query string | ✓ (wildcard) | ✓ | — | ✓ |

**Key insight:** Charles scopes rules by **location** (protocol + host + port + path) separately from the **action**. This clean separation makes it easy to say "for all requests to this API, do X." The Location concept is like EDOG's `UrlPattern + HttpClientNameFilter` combined.

#### Action System

Each tool has a fixed action:
- Map Remote: redirect to different URL
- Map Local: serve file from disk
- Rewrite: string replacement (add/modify/remove) on headers, body, URL, status
- Breakpoints: pause for manual inspection

#### Lifecycle

Rules are persisted in Charles settings (XML). Each tool can be enabled/disabled globally. Individual rules have enable/disable checkboxes. No firing limits, no expiry, no versioning. Charles persists across sessions.

#### Safety

- **Each tool is independently togglable.** You can disable all Rewrite rules without affecting Map Remote.
- **Breakpoints are interactive** — you see the request/response before it continues, preventing blind damage.
- **No auto-revert, no kill switch, no firing limits.**

#### UX

Excellent GUI. Each tool has its own dialog with clear location/action separation. Named rule sets in Rewrite for grouping. Import/export of rules. The UX communicates "where does this apply" (location) separately from "what does it do" (action) — reducing user error.

**What EDOG should steal:**
- ✅ **Location + Action separation** — define WHERE the rule applies, then WHAT it does, as two distinct concepts
- ✅ **Named rule sets** (Rewrite tool) — group related rules together (e.g., "Simulate OneLake Failures")
- ✅ **Per-tool enable/disable** — in EDOG, enable/disable by category
- ✅ **Wildcard matching on URL components** — simpler than regex for common cases
- ❌ Separate tools for each action type — EDOG unifies these into one ChaosRule

---

### 1.4 Gremlin (Chaos Engineering Platform)

**What it is:** Enterprise chaos engineering SaaS. Orchestrates fault injection across infrastructure (hosts, containers, Kubernetes). Not HTTP-specific, but defines the gold standard for chaos experiment lifecycle and safety.

#### Rule Definition Format

Gremlin calls rules **Experiments**. An experiment is:
```
{
  target: { type, tags, percent_to_impact },
  experiment: { category, type, configuration },
  duration: seconds,
  schedule: { type: "immediate" | "once" | "recurring", ... }
}
```

**Categories:**
- **Resource:** CPU, Memory, Disk, IO, GPU
- **Network:** Blackhole, Latency, Packet Loss, DNS
- **State:** Shutdown, Time Travel, Process Killer

**Network Latency example:**
```json
{
  "target": {
    "type": "host",
    "tags": { "service": "api-gateway", "env": "staging" },
    "percent": 50
  },
  "experiment": {
    "category": "network",
    "type": "latency",
    "args": {
      "ms": 500,
      "jitter": 100,
      "ports": "443,8080",
      "hostnames": "onelake.dfs.fabric.microsoft.com"
    }
  },
  "duration": 300
}
```

#### Predicate System (Targeting)

Gremlin's "predicates" are **target selectors**, not HTTP-level filters:

| Selector | Scope | Notes |
|----------|-------|-------|
| Tags | Infrastructure | Key-value pairs on hosts/containers |
| Percent to impact | Blast radius | Random subset of matching targets |
| Kubernetes selectors | K8s | Labels, namespaces, deployments |
| Exact targets | Infrastructure | Specific host/container IDs |
| Include new targets | Dynamic | Auto-include targets that appear during experiment |

**Key insight:** Gremlin separates **what to attack** (experiment type + config) from **where to attack** (target selectors) from **how much to attack** (blast radius %). This three-axis model is excellent.

#### Action System

Each experiment type has its own configuration schema:

| Type | Configuration |
|------|--------------|
| Latency | `ms`, `jitter`, `ports`, `hostnames` |
| Blackhole | `ports`, `hostnames`, `ipAddresses` |
| Packet Loss | `percent`, `corrupt` |
| CPU | `cores`, `percent` |
| Shutdown | `delay`, `reboot` |
| Process Killer | `process`, `group`, `signal` |

Actions are **not composable** — you run one experiment type at a time. For multi-fault scenarios, Gremlin uses **Scenarios** (ordered/branching experiment sequences).

#### Lifecycle

The most sophisticated lifecycle of any tool studied:

```
[Draft] → [Scheduled] → [Initializing] → [Running] → [Completed]
                                             │
                                             ├──→ [Halted] (by Health Check or user)
                                             └──→ [Failed]
```

- **Scenarios** sequence multiple experiments with Health Checks between each step.
- **Health Checks** are continuous probes that auto-halt the scenario if the system is unhealthy.
- **Scheduling:** One-time, recurring, or random-within-window.
- **Duration:** Every experiment has a mandatory end time. No indefinite experiments.

#### Safety — The Gold Standard

| Mechanism | How It Works |
|-----------|-------------|
| **Mandatory duration** | Every experiment must specify how long it runs. Auto-reverts when done. |
| **Health Checks** | Continuous probes (every 10s) that halt experiments if the system is unhealthy. |
| **Blast radius %** | Limit impact to N% of matching targets — never all-or-nothing. |
| **Auto-revert** | All experiments are automatically reversed when they end (or are halted). |
| **Halt button** | One-click stop on any running experiment. |
| **External action rollback** | Pre-experiment setup steps get automatic rollback steps. |
| **Tag-based targeting** | Cannot target exact instances in Scenarios — forces tag-based selection for safety. |
| **Percent to impact** | Random subset targeting prevents accidentally hitting everything. |

**Key insight:** Gremlin's safety model is built on the principle that **every experiment is temporary and reversible by default**. You must opt OUT of safety, not opt IN.

#### UX

Web app with visual blast radius graph. Scenario builder with drag-and-drop experiment sequencing. Health Check library. API + CLI for automation. Rich experiment history with observations and notes.

**What EDOG should steal:**
- ✅ **Mandatory duration** — every ChaosRule must have a TTL or max firings
- ✅ **Health Checks / steady-state probes** — if FLT starts crashing, auto-disable all rules
- ✅ **Blast radius as a percentage** — map to `probability` field on ChaosRule
- ✅ **Auto-revert on expiry** — rules self-disable when their duration expires
- ✅ **Halt/kill switch** — one-click disable all rules
- ✅ **Rich lifecycle states** — draft, active, paused, expired, halted
- ✅ **Experiment history with observations** — audit log of what fired and what happened

---

### 1.5 Toxiproxy (Shopify)

**What it is:** TCP proxy for simulating network conditions in test/CI environments. Simple, API-driven, deterministic. Used at Shopify since 2014.

#### Rule Definition Format

Toxiproxy uses a two-level model:

1. **Proxy** — a named TCP tunnel: `{ name, listen, upstream, enabled }`
2. **Toxic** — a fault injected into a proxy: `{ name, type, stream, toxicity, attributes }`

```json
// Proxy
{ "name": "mysql_master", "listen": "127.0.0.1:22220", "upstream": "127.0.0.1:3306", "enabled": true }

// Toxic on that proxy
{ "name": "latency_downstream", "type": "latency", "stream": "downstream", "toxicity": 0.8, "attributes": { "latency": 1000, "jitter": 200 } }
```

#### Predicate System

Toxiproxy has **no predicate system at the traffic level**. The proxy itself is the predicate — by routing your application through a specific proxy, you've already scoped the traffic. The only filter is:

| Filter | Type | Notes |
|--------|------|-------|
| Proxy name | Structural | All traffic through this proxy is affected |
| Stream direction | `upstream` or `downstream` | Client→Server vs Server→Client |
| Toxicity | 0.0–1.0 | Probability the toxic applies |

**Key insight:** Toxiproxy's brilliance is in its simplicity. No regex, no URL matching, no header filters. The proxy IS the scope. This is analogous to EDOG's `HttpClientNameFilter` — scoping by named HttpClient rather than by URL pattern.

#### Action System (Toxic Types)

| Type | Attributes | Effect |
|------|-----------|--------|
| `latency` | `latency` (ms), `jitter` (ms) | Delay data transmission |
| `bandwidth` | `rate` (KB/s) | Throttle throughput |
| `slow_close` | `delay` (ms) | Delay TCP close |
| `timeout` | `timeout` (ms) | Stop all data, close after timeout (0 = never close) |
| `reset_peer` | `timeout` (ms) | TCP RST after timeout |
| `slicer` | `average_size`, `size_variation`, `delay` (μs) | Fragment packets |
| `limit_data` | `bytes` | Close after N bytes transmitted |

#### Lifecycle

Extremely simple:
```
[Created] → [Active] → [Removed]
```

- Toxics are created via `POST /proxies/{name}/toxics` and removed via `DELETE`.
- Proxies can be disabled (`enabled: false`) which drops all connections.
- `POST /reset` removes ALL toxics and re-enables ALL proxies — the global kill switch.

#### Safety

| Mechanism | How It Works |
|-----------|-------------|
| **`POST /reset`** | Global reset: remove all toxics, enable all proxies. One API call. |
| **`toxicity` field** | Probability (0.0–1.0) that a toxic applies to any given connection. |
| **Proxy disable** | Set `enabled: false` to take down a specific proxy. |
| **No persistence** | Toxics are in-memory. Restart the server = clean slate. |

**Key insight:** The lack of persistence IS a safety mechanism. If anything goes wrong, restart the proxy server and everything resets. For EDOG: rules should be easy to blow away completely.

#### UX

Pure API. No GUI. CLI tool (`toxiproxy-cli`) for quick operations. Config file for proxy definitions (JSON array). Toxics are only managed via API — not in config files.

**What EDOG should steal:**
- ✅ **`toxicity` (probability) field** — already in our `ChaosRule.Probability`
- ✅ **`stream` (upstream/downstream)** → maps to request-phase vs response-phase
- ✅ **`POST /reset` global kill switch** → `ClearAllChaosRules()` already designed
- ✅ **Simple toxic attribute model** — each type has its own typed config, not a generic bag
- ✅ **In-memory with no persistence** as a safety default (opt-in to persistence)
- ✅ **Proxy-as-predicate** → validate our `HttpClientNameFilter` as a first-class filter

---

### 1.6 Chaos Toolkit

**What it is:** Open-source chaos engineering framework. Defines an open JSON specification for chaos experiments with hypothesis-driven methodology.

#### Rule Definition Format

Chaos Toolkit experiments are JSON documents following a formal spec:

```json
{
  "title": "OneLake write latency doesn't break DAG scheduling",
  "description": "Verify that 3s write latency to OneLake doesn't starve downstream DAG nodes",
  "tags": ["onelake", "dag", "latency"],
  "contributions": { "reliability": "high", "scalability": "medium" },

  "steady-state-hypothesis": {
    "title": "DAG completes within 60s",
    "probes": [
      {
        "type": "probe",
        "name": "dag-completion-time",
        "provider": { "type": "http", "url": "http://localhost:5555/api/dag/status" },
        "tolerance": { "type": "range", "range": [0, 60000] }
      }
    ]
  },

  "method": [
    {
      "type": "action",
      "name": "inject-onelake-latency",
      "provider": { "type": "http", "url": "http://localhost:5556/chaos/rules", "method": "POST" },
      "pauses": { "after": 30 }
    },
    {
      "type": "probe",
      "name": "check-dag-still-running",
      "provider": { "type": "http", "url": "http://localhost:5555/api/dag/status" }
    }
  ],

  "rollbacks": [
    {
      "type": "action",
      "name": "remove-latency-rule",
      "provider": { "type": "http", "url": "http://localhost:5556/chaos/rules/all", "method": "DELETE" }
    }
  ]
}
```

#### Key Concepts

| Concept | Purpose | Mapping to EDOG |
|---------|---------|----------------|
| **Steady-State Hypothesis** | Define "normal" before the experiment. If not met, don't run. | Pre-flight check: is FLT running? Are APIs responsive? |
| **Probes** | Read-only observations. Check system state. | EDOG health checks: `/api/health`, DAG status, log error rate |
| **Actions** | Mutating operations. Inject faults. | Create/enable ChaosRules |
| **Rollbacks** | Undo actions. Always run, even on failure. | `ClearAllChaosRules()`, disable specific rules |
| **Tolerances** | Acceptance criteria for probes (exact value, range, regex, jsonpath) | Could validate: "error count < 5", "P99 latency < 10s" |
| **Pauses** | Wait between steps. Let the fault propagate. | Delay between enabling rule and checking impact |
| **Contributions** | Tags: reliability, security, scalability | Rule categories in EDOG |

#### Predicate System

Chaos Toolkit doesn't have HTTP-level predicates — it delegates fault injection to external tools (Gremlin, Toxiproxy, custom scripts). Its "predicates" are the **tolerance** system on probes:

| Tolerance Type | Syntax | Use |
|----------------|--------|-----|
| Exact value | `"tolerance": true` | Boolean check |
| Range | `"tolerance": [4, 9]` | Numeric bounds |
| Regex | `"tolerance": { "type": "regex", "pattern": "[0-9]{3}" }` | String pattern |
| JSONPath | `"tolerance": { "type": "jsonpath", "path": "$.status" }` | Structured data |
| Probe | `"tolerance": { "type": "probe", ... }` | Custom validation |

#### Action System

Actions are executed via **providers** — pluggable execution backends:
- **Python provider:** Call a Python function
- **HTTP provider:** Make an HTTP request
- **Process provider:** Run a shell command

This makes Chaos Toolkit a *meta-framework* — it orchestrates experiments but delegates the actual fault injection to other tools.

#### Lifecycle

```
[Defined] → [Steady-State Check] → [Method Execution] → [Steady-State Re-check] → [Rollbacks] → [Complete]
                  │                                              │
                  └─ Fail: Abort (don't run method)              └─ Fail: Deviation detected → Rollback
```

**Key insight:** The **hypothesis-method-rollback** structure is the scientific method applied to chaos engineering. Before you inject a fault, you verify the system is healthy. After, you verify again. Deviations are data, not failures.

#### Safety

| Mechanism | How It Works |
|-----------|-------------|
| **Steady-state hypothesis** | Experiment won't start if the system isn't already healthy |
| **Mandatory rollbacks** | Always run, even if the experiment fails or times out |
| **Tolerance validation** | Probes must pass acceptance criteria — experiments fail explicitly |
| **Controls** | Out-of-band capabilities applied during execution (logging, notifications) |
| **Contributions** | Tag experiments by what they test (reliability, security) for portfolio coverage |

#### UX

Config file (JSON or YAML). CLI: `chaos run experiment.json`. No GUI (though third-party UIs exist). Results are JSON reports. Designed for CI/CD integration.

**What EDOG should steal:**
- ✅ **Hypothesis-method-rollback pattern** — structure chaos experiments as: verify → inject → observe → revert
- ✅ **Steady-state probes** — check FLT health before enabling rules
- ✅ **Mandatory rollbacks** — every rule activation should have a corresponding deactivation
- ✅ **Tolerance system** — rich validation for health checks (range, regex, jsonpath)
- ✅ **Experiment-as-document** — a ChaosRule set (ruleset) should be exportable/importable as JSON
- ✅ **Contributions/tags** — categorize rules for portfolio visibility

---

## Section 2: Synthesized Rule Model

### Design Principles (Extracted From Industry)

| # | Principle | Source | Application to EDOG |
|---|-----------|--------|-------------------|
| 1 | **Predicate + Action separation** | All tools | `ChaosRule` = `predicates[]` + `action` |
| 2 | **Phase-aware matching** | mitmproxy, Burp | Request-phase vs response-phase predicates and actions |
| 3 | **Location scoping** | Charles, Burp | HttpClient name + URL pattern as "location" |
| 4 | **Probabilistic control** | Toxiproxy, Gremlin | `probability` (0.0–1.0) per rule |
| 5 | **Mandatory duration** | Gremlin | Every rule has a TTL or `maxFirings` |
| 6 | **Auto-revert** | Gremlin, Chaos Toolkit | Rules self-disable on expiry; rollback is default |
| 7 | **Kill switch** | Toxiproxy, Gremlin | One-click disable-all, always accessible |
| 8 | **Health-gated execution** | Gremlin, Chaos Toolkit | Auto-disable rules if FLT becomes unhealthy |
| 9 | **Rich lifecycle** | Gremlin | draft → active → paused → expired → deleted |
| 10 | **Typed action configs** | Toxiproxy | Each action type has its own schema, not a generic bag |
| 11 | **Composable filter DSL** | mitmproxy | Boolean combinators for complex predicate logic |
| 12 | **Exportable experiments** | Chaos Toolkit | Rulesets are JSON documents, shareable across environments |

---

### Rule JSON Schema

```json
{
  "$schema": "https://edog-studio.dev/schemas/chaos-rule-v1.json",
  "type": "object",
  "required": ["id", "name", "predicate", "action"],
  "properties": {

    "id": {
      "type": "string",
      "description": "Unique ID. Kebab-case, descriptive. e.g., 'delay-onelake-writes-3s'",
      "pattern": "^[a-z0-9][a-z0-9-]*$"
    },

    "name": {
      "type": "string",
      "description": "Human-readable name shown in the UI. e.g., 'Delay OneLake Writes 3s'"
    },

    "description": {
      "type": "string",
      "description": "What this rule tests and why. Shown in rule detail panel."
    },

    "category": {
      "type": "string",
      "enum": ["request-surgery", "response-forgery", "traffic-control", "security-probing", "observability", "advanced"],
      "description": "UI grouping category per F24 spec."
    },

    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Freeform tags for filtering/search. e.g., ['onelake', 'latency', 'dag']"
    },

    "predicate": {
      "$ref": "#/definitions/Predicate",
      "description": "When this rule fires. Compound predicate with AND/OR combinators."
    },

    "action": {
      "$ref": "#/definitions/Action",
      "description": "What this rule does when it fires."
    },

    "phase": {
      "type": "string",
      "enum": ["request", "response", "both"],
      "default": "request",
      "description": "Pipeline phase: evaluated before SendAsync (request), after (response), or both."
    },

    "priority": {
      "type": "integer",
      "default": 100,
      "minimum": 0,
      "maximum": 999,
      "description": "Execution order. Lower = first. Rules at same priority execute in creation order."
    },

    "enabled": {
      "type": "boolean",
      "default": false,
      "description": "Active rules are evaluated on every request. New rules start DISABLED for safety."
    },

    "probability": {
      "type": "number",
      "minimum": 0.0,
      "maximum": 1.0,
      "default": 1.0,
      "description": "Probability of firing when predicate matches. 0.5 = 50% of matching requests."
    },

    "limits": {
      "type": "object",
      "description": "Firing limits. At least one MUST be set (enforced by engine, not schema).",
      "properties": {
        "maxFirings": {
          "type": "integer",
          "minimum": 0,
          "description": "Max total firings. 0 = unlimited. Rule auto-disables after reaching limit."
        },
        "maxRatePerSecond": {
          "type": "number",
          "minimum": 0,
          "description": "Max firings/sec. Excess matches are passed through unmodified."
        },
        "ttlSeconds": {
          "type": "integer",
          "minimum": 0,
          "description": "Rule auto-disables after N seconds from first activation. 0 = no TTL."
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "description": "Absolute expiry timestamp (UTC). Rule auto-disables after this time."
        }
      }
    },

    "lifecycle": {
      "type": "object",
      "description": "Read-only metadata managed by the engine.",
      "properties": {
        "state": {
          "type": "string",
          "enum": ["draft", "active", "paused", "expired", "disabled-by-safety", "deleted"],
          "description": "Current lifecycle state."
        },
        "createdAt": { "type": "string", "format": "date-time" },
        "activatedAt": { "type": "string", "format": "date-time" },
        "lastFiredAt": { "type": "string", "format": "date-time" },
        "fireCount": { "type": "integer" },
        "disableReason": {
          "type": "string",
          "description": "Why the rule was disabled. e.g., 'maxFirings reached', 'safety: FLT crash detected', 'user paused'"
        }
      }
    },

    "audit": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "timestamp": { "type": "string", "format": "date-time" },
          "event": { "type": "string" },
          "detail": { "type": "string" }
        }
      },
      "description": "Append-only audit trail: created, enabled, fired, paused, expired, deleted."
    }
  },

  "definitions": {

    "Predicate": {
      "description": "A compound predicate. Can be a single condition or a boolean combination.",
      "oneOf": [
        { "$ref": "#/definitions/ConditionPredicate" },
        { "$ref": "#/definitions/CompoundPredicate" }
      ]
    },

    "ConditionPredicate": {
      "type": "object",
      "required": ["field", "op", "value"],
      "properties": {
        "field": {
          "type": "string",
          "enum": [
            "url", "method", "httpClientName",
            "requestHeader", "responseHeader",
            "requestBody", "responseBody",
            "statusCode", "contentType",
            "durationMs"
          ],
          "description": "What to match against."
        },
        "op": {
          "type": "string",
          "enum": ["equals", "not_equals", "matches", "not_matches", "contains", "not_contains", "gt", "lt", "gte", "lte", "exists", "not_exists"],
          "description": "Comparison operator."
        },
        "value": {
          "description": "Value to compare. String for regex/contains, number for numeric ops, string for header name (with 'exists')."
        },
        "key": {
          "type": "string",
          "description": "For header/param fields: the header name. e.g., field='requestHeader', key='Content-Type', op='contains', value='json'"
        }
      }
    },

    "CompoundPredicate": {
      "type": "object",
      "required": ["operator", "conditions"],
      "properties": {
        "operator": {
          "type": "string",
          "enum": ["and", "or", "not"],
          "description": "Boolean combinator."
        },
        "conditions": {
          "type": "array",
          "items": { "$ref": "#/definitions/Predicate" },
          "description": "Nested predicates. For 'not', exactly one element."
        }
      }
    },

    "Action": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "delay",
            "modifyRequestHeader", "modifyRequestBody", "rewriteUrl",
            "blockRequest", "redirectRequest",
            "modifyResponseStatus", "modifyResponseHeader", "modifyResponseBody",
            "delayResponse", "forgeResponse", "dropConnection",
            "throttleBandwidth",
            "recordTraffic", "tagRequest"
          ]
        },
        "config": {
          "description": "Type-specific configuration. See Action Types table."
        }
      }
    }
  }
}
```

---

### Predicate Types

Predicates are structured conditions that can be combined with boolean logic.

#### Leaf Predicates (ConditionPredicate)

| Field | Operators | Phase | Example |
|-------|-----------|-------|---------|
| `url` | `matches`, `contains`, `equals` | Request | `{ "field": "url", "op": "matches", "value": "onelake\\.dfs\\.fabric\\.microsoft\\.com/.*" }` |
| `method` | `equals`, `not_equals` | Request | `{ "field": "method", "op": "equals", "value": "PUT" }` |
| `httpClientName` | `equals`, `matches` | Request | `{ "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" }` |
| `requestHeader` | `equals`, `contains`, `matches`, `exists` | Request | `{ "field": "requestHeader", "key": "Content-Type", "op": "contains", "value": "json" }` |
| `responseHeader` | `equals`, `contains`, `matches`, `exists` | Response | `{ "field": "responseHeader", "key": "x-ms-request-id", "op": "exists" }` |
| `requestBody` | `matches`, `contains` | Request | `{ "field": "requestBody", "op": "contains", "value": "\"tableName\":" }` |
| `responseBody` | `matches`, `contains` | Response | `{ "field": "responseBody", "op": "contains", "value": "\"error\":" }` |
| `statusCode` | `equals`, `gt`, `lt`, `gte`, `lte` | Response | `{ "field": "statusCode", "op": "gte", "value": 500 }` |
| `contentType` | `contains`, `equals` | Both | `{ "field": "contentType", "op": "contains", "value": "json" }` |
| `durationMs` | `gt`, `lt`, `gte`, `lte` | Response | `{ "field": "durationMs", "op": "gt", "value": 5000 }` |

#### Compound Predicates

```json
// AND: All OneLake PUTs
{
  "operator": "and",
  "conditions": [
    { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
    { "field": "method", "op": "equals", "value": "PUT" }
  ]
}

// OR: Any error response
{
  "operator": "or",
  "conditions": [
    { "field": "statusCode", "op": "gte", "value": 500 },
    { "field": "responseBody", "op": "contains", "value": "\"error\":" }
  ]
}

// NOT: Everything except health checks
{
  "operator": "not",
  "conditions": [
    { "field": "url", "op": "contains", "value": "/health" }
  ]
}

// Nested: OneLake writes OR Fabric API writes, but not health checks
{
  "operator": "and",
  "conditions": [
    {
      "operator": "or",
      "conditions": [
        { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
        { "field": "httpClientName", "op": "equals", "value": "FabricApiClient" }
      ]
    },
    { "field": "method", "op": "equals", "value": "PUT" },
    {
      "operator": "not",
      "conditions": [
        { "field": "url", "op": "contains", "value": "/health" }
      ]
    }
  ]
}
```

---

### Action Types

Each action type has a typed `config` object. Inspired by Toxiproxy's per-type attribute model.

#### Request-Phase Actions

| Type | Config Schema | Effect |
|------|--------------|--------|
| `delay` | `{ "delayMs": int, "jitterMs": int }` | `await Task.Delay(delayMs ± random(jitterMs))` before `base.SendAsync()` |
| `modifyRequestHeader` | `{ "operation": "set\|add\|remove", "name": str, "value": str }` | Add, replace, or remove a request header |
| `modifyRequestBody` | `{ "find": str, "replace": str, "regex": bool }` | Find-replace on request body. Supports regex with capture groups ($1) |
| `rewriteUrl` | `{ "find": str, "replace": str, "regex": bool }` | Find-replace on the request URL |
| `blockRequest` | `{ "statusCode": int, "body": str, "headers": {} }` | Short-circuit: return canned response without calling real service |
| `redirectRequest` | `{ "targetUrl": str, "preserveHeaders": bool }` | Forward request to a different URL |

#### Response-Phase Actions

| Type | Config Schema | Effect |
|------|--------------|--------|
| `modifyResponseStatus` | `{ "statusCode": int }` | Replace HTTP status code |
| `modifyResponseHeader` | `{ "operation": "set\|add\|remove", "name": str, "value": str }` | Add, replace, or remove a response header |
| `modifyResponseBody` | `{ "find": str, "replace": str, "regex": bool }` | Find-replace on response body |
| `delayResponse` | `{ "delayMs": int, "jitterMs": int }` | Hold response before returning to FLT |
| `forgeResponse` | `{ "statusCode": int, "body": str, "headers": {}, "contentType": str }` | Replace entire response with fabricated one |
| `dropConnection` | `{ "errorMessage": str }` | Throw `HttpRequestException` to simulate connection failure |

#### Traffic Control Actions

| Type | Config Schema | Effect |
|------|--------------|--------|
| `throttleBandwidth` | `{ "bytesPerSecond": int }` | Trickle response body at specified rate |

#### Observability Actions

| Type | Config Schema | Effect |
|------|--------------|--------|
| `recordTraffic` | `{ "sessionName": str }` | Full request/response capture to named recording session |
| `tagRequest` | `{ "tags": { "key": "value" } }` | Attach metadata to the request for later filtering |

---

### Lifecycle States

```
                    ┌─────────────────────────────────────────────┐
                    │              User creates rule               │
                    └─────────────────┬───────────────────────────┘
                                      │
                                      ▼
                               ┌─────────────┐
                               │    DRAFT     │  Rule exists but is not evaluated.
                               │              │  Can be edited freely.
                               └──────┬───────┘
                                      │ user clicks "Enable"
                                      ▼
                               ┌─────────────┐
                    ┌──────────│   ACTIVE     │──────────┐
                    │          │              │          │
                    │          └──────┬───────┘          │
                    │                 │                  │
           user clicks          fires normally      limit reached
            "Pause"               (publishes         OR TTL expired
                    │             ChaosEvents)       OR expiresAt hit
                    ▼                                    │
             ┌─────────────┐                             ▼
             │   PAUSED    │                      ┌─────────────┐
             │             │                      │   EXPIRED    │
             └──────┬──────┘                      │              │
                    │ user clicks "Resume"        └──────────────┘
                    │                                    │
                    └──────► back to ACTIVE               │ user can clone
                                                         │ to new DRAFT
                    ┌─────────────────────────────────────┘
                    │
                    │  safety system detects FLT crash / error spike
                    ▼
             ┌──────────────────┐
             │ DISABLED-BY-SAFETY│  Auto-disabled. disableReason explains why.
             │                  │  User must manually re-enable after investigation.
             └──────────────────┘

             ┌─────────────┐
             │   DELETED    │  Soft-deleted. Kept in audit log. Not evaluated.
             │              │  Can be undeleted within 24 hours.
             └─────────────┘
```

**State Transitions:**

| From | To | Trigger |
|------|----|---------|
| — | `draft` | User creates rule (UI, API, or import) |
| `draft` | `active` | User enables rule |
| `draft` | `deleted` | User deletes draft |
| `active` | `paused` | User pauses rule |
| `active` | `expired` | `maxFirings` reached, `ttlSeconds` elapsed, or `expiresAt` passed |
| `active` | `disabled-by-safety` | Safety system triggers (FLT crash, error spike, kill switch) |
| `active` | `deleted` | User deletes active rule |
| `paused` | `active` | User resumes rule |
| `paused` | `deleted` | User deletes paused rule |
| `expired` | `draft` | User clones expired rule to new draft |
| `expired` | `deleted` | User deletes expired rule |
| `disabled-by-safety` | `active` | User explicitly re-enables after investigation |
| `disabled-by-safety` | `deleted` | User deletes |
| `deleted` | `draft` | User undeletes (within 24h) |

---

### Safety Mechanisms

Synthesis of the best safety patterns from Gremlin, Toxiproxy, and Chaos Toolkit.

#### 1. Kill Switch (From Toxiproxy `POST /reset`, Gremlin Halt)

```
One-click disable ALL active rules. Always accessible.
```

- **SignalR method:** `ClearAllChaosRules()` — already in our protocol
- **Keyboard shortcut:** `Ctrl+Shift+K` (Kill all chaos rules)
- **UI:** Red emergency button always visible when ANY rule is active
- **Implementation:** `ChaosRuleStore.ClearAll()` — atomic swap to empty list

#### 2. Mandatory Limits (From Gremlin mandatory duration)

```
Every ACTIVE rule MUST have at least one limit set:
  - maxFirings > 0, OR
  - ttlSeconds > 0, OR
  - expiresAt is set
```

The engine refuses to activate a rule with no limits. This prevents "I turned on a rule Friday and forgot about it over the weekend" scenarios.

**Exception:** Rules in `draft` state don't need limits (they're not evaluated). The UI enforces limits at the `draft → active` transition.

#### 3. FLT Health Guard (From Gremlin Health Checks, Chaos Toolkit Steady-State)

The engine monitors FLT health. If it detects problems, it auto-disables all chaos rules:

| Signal | Detection | Action |
|--------|-----------|--------|
| FLT process crash | Process monitor in `edog.py` | Disable all rules, set state = `disabled-by-safety` |
| HTTP error spike | >50% of requests returning 5xx for 10s | Disable all rules |
| Unhandled exception in rule execution | `try/catch` in rule executor | Disable the specific rule that threw |

The `disabled-by-safety` state requires **explicit user action** to re-enable. The engine won't silently re-enable rules after a crash.

#### 4. Probability Ceiling (From Toxiproxy toxicity, Gremlin blast radius)

New rules default to `probability: 1.0`, but the UI recommends starting at `0.1` (10%) for destructive actions like `blockRequest`, `dropConnection`, and `forgeResponse`.

The engine publishes a warning event to the `chaos` topic when a destructive rule is enabled at `probability: 1.0`:
```json
{ "type": "safety-warning", "ruleId": "block-all-onelake", "message": "Destructive rule at 100% probability. Consider reducing." }
```

#### 5. Audit Log (From Gremlin experiment history)

Every state change is logged to the rule's `audit` array:

```json
[
  { "timestamp": "2026-07-22T14:30:00Z", "event": "created", "detail": "Rule created via UI" },
  { "timestamp": "2026-07-22T14:31:00Z", "event": "enabled", "detail": "User activated. limits: maxFirings=50, ttlSeconds=300" },
  { "timestamp": "2026-07-22T14:31:05Z", "event": "fired", "detail": "Matched PUT onelake.dfs.fabric.microsoft.com/... (fire #1)" },
  { "timestamp": "2026-07-22T14:36:00Z", "event": "expired", "detail": "TTL reached (300s). Auto-disabled." }
]
```

The audit log is published to the `chaos` topic in real-time and persisted with the rule JSON.

#### 6. Rule Validation (From Burp inline test)

Before enabling a rule, the engine validates:
- Predicate compiles (regex is valid, field names are correct)
- Action config is complete (required fields present, types correct)
- At least one limit is set
- No conflicting rules (e.g., two rules that both `blockRequest` and `forgeResponse` on the same predicate)

Validation errors are returned to the frontend before the rule is activated.

#### 7. Safe Defaults (From Toxiproxy in-memory model)

| Default | Why |
|---------|-----|
| `enabled: false` | New rules don't fire until explicitly enabled |
| `probability: 1.0` | Explicit — but UI warns for destructive actions |
| `maxFirings: 0` (unlimited) | Must be overridden before activation |
| No persistence by default | Rules live in memory. Restart EDOG = clean slate. Opt-in to persistence. |
| Destructive actions require confirmation | UI shows a confirmation dialog for `blockRequest`, `dropConnection`, `forgeResponse` |

---

### C# Implementation Sketch for DelegatingHandler

```csharp
// How the synthesized model maps to EdogHttpPipelineHandler

protected override async Task<HttpResponseMessage> SendAsync(
    HttpRequestMessage request, CancellationToken ct)
{
    // ── FAST PATH: No rules active ──
    var rules = ChaosRuleStore.ActiveSnapshot; // volatile read, lock-free
    if (rules.Count == 0)
        return await base.SendAsync(request, ct);

    // ── BUILD CONTEXT ──
    var ctx = new ChaosEvalContext
    {
        Request = request,
        HttpClientName = _httpClientName,
        Url = request.RequestUri?.ToString(),
        Method = request.Method.Method,
    };

    // ── REQUEST PHASE ──
    foreach (var rule in rules.Where(r => r.Phase is "request" or "both"))
    {
        if (PredicateEngine.Evaluate(rule.Predicate, ctx)
            && GateCheck.PassesAll(rule))              // probability, rate, maxFirings
        {
            var result = await ActionExecutor.ExecuteRequest(rule.Action, ctx, ct);
            rule.RecordFiring(ctx);                    // increment counter, audit log
            TopicRouter.Publish("chaos", ChaosEvent.From(rule, ctx, "request"));

            if (result.ShortCircuit)                   // blockRequest, forgeResponse
                return result.Response;
        }
    }

    // ── FORWARD TO REAL SERVICE ──
    var sw = Stopwatch.StartNew();
    var response = await base.SendAsync(ctx.Request, ct);
    sw.Stop();
    ctx.Response = response;
    ctx.DurationMs = sw.Elapsed.TotalMilliseconds;

    // ── RESPONSE PHASE ──
    foreach (var rule in rules.Where(r => r.Phase is "response" or "both"))
    {
        if (PredicateEngine.Evaluate(rule.Predicate, ctx)
            && GateCheck.PassesAll(rule))
        {
            response = await ActionExecutor.ExecuteResponse(rule.Action, ctx, response, ct);
            rule.RecordFiring(ctx);
            TopicRouter.Publish("chaos", ChaosEvent.From(rule, ctx, "response"));
        }
    }

    return response;
}
```

**PredicateEngine.Evaluate** recursively evaluates `CompoundPredicate` trees:

```csharp
static bool Evaluate(Predicate pred, ChaosEvalContext ctx) => pred switch
{
    ConditionPredicate cp => EvalCondition(cp, ctx),
    CompoundPredicate { Operator: "and" } cp => cp.Conditions.All(c => Evaluate(c, ctx)),
    CompoundPredicate { Operator: "or" } cp  => cp.Conditions.Any(c => Evaluate(c, ctx)),
    CompoundPredicate { Operator: "not" } cp => !Evaluate(cp.Conditions[0], ctx),
    _ => false
};
```

**Performance:** Compiled `Regex` instances are cached per rule. Predicate tree evaluation is O(depth × conditions). For typical rules (2–5 conditions, depth 2–3), this is sub-microsecond. The `rules.Count == 0` fast path ensures zero overhead when no chaos rules are active.

---

### Comparison: Our Model vs. Each Tool

| Capability | Burp | mitmproxy | Charles | Gremlin | Toxiproxy | Chaos Toolkit | **EDOG** |
|-----------|------|-----------|---------|---------|-----------|---------------|----------|
| Compound predicates (AND/OR/NOT) | ✓ (AND/OR) | ✓ (full) | ✗ | N/A | ✗ | N/A | **✓ (full)** |
| Request/Response phase separation | Partial | ✓ | Per tool | N/A | ✓ (stream) | N/A | **✓** |
| URL regex matching | ✓ | ✓ | Wildcard | N/A | ✗ | N/A | **✓** |
| Header matching | ✓ | ✓ | ✗ | N/A | ✗ | N/A | **✓** |
| Body matching | ✓ | ✓ | ✗ | N/A | ✗ | N/A | **✓** |
| Named client filter | N/A | N/A | N/A | Tags | Proxy name | N/A | **✓ (httpClientName)** |
| Probability/toxicity | ✗ | ✗ | ✗ | Blast radius % | ✓ (0–1) | ✗ | **✓ (0–1)** |
| Mandatory duration/limits | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | **✓** |
| Auto-revert/expiry | ✗ | ✗ | ✗ | ✓ | ✗ (restart) | ✓ (rollback) | **✓** |
| Health-gated execution | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | **✓** |
| Kill switch | ✗ | ✗ | ✗ | ✓ | ✓ (reset) | ✗ | **✓** |
| Typed action configs | ✓ (per type) | N/A (code) | ✓ (per tool) | ✓ | ✓ | ✓ (providers) | **✓** |
| Audit log | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ (journal) | **✓** |
| Export/import rules | Project file | ✗ | ✗ | Scenario JSON | Config JSON | Experiment JSON | **✓ (JSON)** |
| Zero-overhead fast path | ✗ | ✗ | ✗ | N/A | ✓ (<100μs) | N/A | **✓ (0ms)** |

---

### Summary of Key Decisions

| Decision | Rationale |
|----------|-----------|
| **Compound predicates with AND/OR/NOT** over flat field list | Flat fields (our current model) can't express "OneLake OR Fabric, but not health checks." Compound predicates handle this. Stolen from mitmproxy. |
| **Typed action configs** over generic `Dictionary<string, object>` | Each action type has a known schema. TypeScript-style typed configs enable validation, autocomplete, and documentation. Stolen from Toxiproxy. |
| **Mandatory limits on active rules** | Prevents "forgot to turn it off" disasters. The single most important safety mechanism. Stolen from Gremlin. |
| **`enabled: false` by default** | New rules require explicit activation. Safe default. Common across all tools. |
| **Phase field (`request`/`response`/`both`)** | Explicit phase assignment replaces the implicit "is this action a request or response action?" logic. Clearer for both engine and user. From mitmproxy's `~q`/`~s` operators. |
| **Health guard auto-disable** | If FLT crashes while chaos rules are active, rules auto-disable. User must re-enable manually. From Gremlin Health Checks + Chaos Toolkit steady-state hypothesis. |
| **Audit trail per rule** | Every state change logged. Enables post-mortem analysis. From Gremlin experiment history. |
| **JSON export/import** | Rules are shareable documents. A team member can export their chaos scenario and share it. From Chaos Toolkit experiment JSON. |

---

*Sana Reeves — "The best rule engine is one that's hard to misuse and easy to undo."*

---
---

# PART 2: Final Engine Architecture (P2.1 – P2.4)

> **Author:** Sana Reeves (Architect)
> **Status:** FINAL — Ready for Implementation
> **Date:** 2025-07-25
> **Supersedes:** The "Synthesized Rule Model" sketch above (Section 2) was the P0.3 preview. Everything below is the **definitive** specification. Where this section conflicts with the preview, this section wins.

---

## Section 2: ChaosRule Data Model (P2.1)

### 2.1 Final JSON Schema

This is the canonical schema. It incorporates every action type from C01–C06 and every predicate from the interceptor audit. A rule is the atomic unit of chaos: one predicate tree, one action (possibly composite), one set of limits.

```json
{
  "$schema": "https://edog-studio.dev/schemas/chaos-rule-v2.json",
  "type": "object",
  "required": ["id", "name", "predicate", "action"],
  "properties": {

    "id": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9-]{0,63}$",
      "description": "Unique, kebab-case identifier. Max 64 chars. e.g., 'delay-onelake-writes-3s'. Preset-generated rules use prefix 'preset-{presetId}--{ruleSlug}'."
    },

    "name": {
      "type": "string",
      "maxLength": 120,
      "description": "Human-readable name displayed in the Chaos Panel rule list and audit log."
    },

    "description": {
      "type": "string",
      "maxLength": 500,
      "description": "What this rule tests and why. Shown in rule detail panel and audit entries."
    },

    "category": {
      "type": "string",
      "enum": [
        "request-surgery",
        "response-forgery",
        "traffic-control",
        "security-probing",
        "observability",
        "advanced"
      ],
      "description": "UI grouping per F24 spec categories C01–C06."
    },

    "tags": {
      "type": "array",
      "items": { "type": "string", "maxLength": 40 },
      "maxItems": 20,
      "description": "Freeform tags for filtering/search. e.g., ['onelake', 'latency', 'dag']."
    },

    "predicate": {
      "$ref": "#/definitions/Predicate",
      "description": "When this rule fires. Compound predicate with AND/OR/NOT combinators."
    },

    "action": {
      "$ref": "#/definitions/Action",
      "description": "What this rule does when it fires. Single action or composite (AD-06)."
    },

    "phase": {
      "type": "string",
      "enum": ["request", "response", "both"],
      "default": "request",
      "description": "Pipeline phase. 'request' = before base.SendAsync(). 'response' = after. 'both' = evaluated in both phases (required for composite actions spanning phases)."
    },

    "priority": {
      "type": "integer",
      "default": 100,
      "minimum": 0,
      "maximum": 999,
      "description": "Execution order within the same phase. Lower = evaluated first. Rules at the same priority execute in creation order (stable sort by createdAt). Reserved ranges: 0–9 = system (cache, presets), 10–99 = high-priority user rules, 100–999 = normal."
    },

    "enabled": {
      "type": "boolean",
      "default": false,
      "description": "Active rules are evaluated on every request. New rules start DISABLED for safety — the engine refuses to create a rule with enabled=true via the API."
    },

    "probability": {
      "type": "number",
      "minimum": 0.0,
      "maximum": 1.0,
      "default": 1.0,
      "description": "Probability of firing when predicate matches. 0.5 = 50% of matching requests. Evaluated per-request via Random.Shared."
    },

    "limits": {
      "type": "object",
      "description": "Firing limits. At least one MUST be set before transitioning to 'active' state. Engine rejects activation if all limits are zero/null.",
      "properties": {
        "maxFirings": {
          "type": "integer",
          "minimum": 0,
          "default": 0,
          "description": "Max total firings. 0 = unlimited. Rule auto-transitions to 'expired' after reaching this count. Counter uses Interlocked.Increment (atomic, lock-free)."
        },
        "maxRatePerSecond": {
          "type": "number",
          "minimum": 0,
          "description": "Max firings per second. Excess matches pass through unmodified (rule is not evaluated, not counted). Implemented via sliding-window token bucket."
        },
        "ttlSeconds": {
          "type": "integer",
          "minimum": 0,
          "default": 0,
          "description": "Rule auto-expires N seconds after first activation (transition from draft→active). 0 = no TTL. Timer starts when lifecycle.activatedAt is set."
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "description": "Absolute UTC expiry timestamp. Rule auto-expires after this instant. Takes precedence over ttlSeconds if both are set."
        }
      }
    },

    "lifecycle": {
      "type": "object",
      "readOnly": true,
      "description": "Engine-managed metadata. Clients MUST NOT set these fields on create/update — the engine owns them.",
      "properties": {
        "state": {
          "type": "string",
          "enum": ["draft", "active", "paused", "expired", "disabled-by-safety", "deleted"],
          "default": "draft",
          "description": "Current lifecycle state. See state machine in Section 2, P0.3 sketch."
        },
        "createdAt":     { "type": "string", "format": "date-time" },
        "updatedAt":     { "type": "string", "format": "date-time" },
        "activatedAt":   { "type": "string", "format": "date-time", "description": "When the rule last transitioned to 'active'. TTL timer starts here." },
        "lastFiredAt":   { "type": "string", "format": "date-time" },
        "fireCount":     { "type": "integer", "default": 0, "description": "Total times this rule has fired across all activations." },
        "disableReason": { "type": "string", "description": "Why the rule was auto-disabled. e.g., 'maxFirings reached (50/50)', 'safety: FLT crash detected', 'safety: kill switch activated'" },
        "version":       { "type": "integer", "default": 1, "description": "Monotonic version counter. Incremented on every mutation. Used for optimistic concurrency in the REST API." }
      }
    },

    "source": {
      "type": "string",
      "enum": ["ui", "api", "dsl", "preset", "import"],
      "default": "ui",
      "description": "How this rule was created. Used for filtering and audit."
    }
  },

  "definitions": {

    "Predicate": {
      "description": "A compound predicate tree. Leaf = ConditionPredicate, Branch = CompoundPredicate.",
      "oneOf": [
        { "$ref": "#/definitions/ConditionPredicate" },
        { "$ref": "#/definitions/CompoundPredicate" }
      ]
    },

    "ConditionPredicate": {
      "type": "object",
      "required": ["field", "op", "value"],
      "properties": {
        "field": {
          "type": "string",
          "enum": [
            "url",
            "method",
            "httpClientName",
            "requestHeader",
            "responseHeader",
            "requestBody",
            "responseBody",
            "statusCode",
            "contentType",
            "durationMs"
          ]
        },
        "op": {
          "type": "string",
          "enum": [
            "equals", "not_equals",
            "matches", "not_matches",
            "contains", "not_contains",
            "gt", "lt", "gte", "lte",
            "exists", "not_exists"
          ]
        },
        "value": {
          "description": "Comparison target. String for text ops, number for numeric ops, null for exists/not_exists."
        },
        "key": {
          "type": "string",
          "description": "Sub-key for structured fields. For requestHeader/responseHeader: the header name (e.g., 'Content-Type'). Not used for other fields."
        }
      }
    },

    "CompoundPredicate": {
      "type": "object",
      "required": ["operator", "conditions"],
      "properties": {
        "operator": {
          "type": "string",
          "enum": ["and", "or", "not"]
        },
        "conditions": {
          "type": "array",
          "items": { "$ref": "#/definitions/Predicate" },
          "description": "Child predicates. For 'not', exactly 1 element. For 'and'/'or', 2+ elements."
        }
      }
    },

    "Action": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "delay",
            "modifyRequestHeader",
            "modifyRequestBody",
            "rewriteUrl",
            "blockRequest",
            "redirectRequest",
            "methodOverride",
            "modifyResponseStatus",
            "modifyResponseHeader",
            "modifyResponseBody",
            "delayResponse",
            "forgeResponse",
            "dropConnection",
            "throttleBandwidth",
            "recordTraffic",
            "tagRequest",
            "cacheReplay",
            "composite"
          ]
        },
        "config": {
          "description": "Type-specific configuration object. Schema per action type below."
        }
      }
    }
  }
}
```

### 2.2 Predicate Types — Complete Reference

Every leaf predicate maps to a field extractable from `HttpRequestMessage`, `HttpResponseMessage`, or the EDOG pipeline context. Compound predicates compose leaves with boolean logic.

#### 2.2.1 Leaf Predicates (ConditionPredicate)

| Field | Valid Operators | Phase | Extraction Source | JSON Example |
|-------|----------------|-------|-------------------|--------------|
| `url` | `equals`, `not_equals`, `matches`, `not_matches`, `contains`, `not_contains` | Request | `request.RequestUri.ToString()` | `{ "field": "url", "op": "matches", "value": "onelake\\.dfs\\.fabric\\.microsoft\\.com" }` |
| `method` | `equals`, `not_equals` | Request | `request.Method.Method` (uppercase) | `{ "field": "method", "op": "equals", "value": "PUT" }` |
| `httpClientName` | `equals`, `not_equals`, `matches`, `contains` | Request | `_httpClientName` field on `EdogHttpPipelineHandler` instance, set by `EdogHttpClientFactoryWrapper.CreateClient(name)` | `{ "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" }` |
| `requestHeader` | `equals`, `not_equals`, `matches`, `contains`, `exists`, `not_exists` | Request | `request.Headers` + `request.Content?.Headers`. Requires `key` for the header name. For `exists`/`not_exists`, `value` is ignored. | `{ "field": "requestHeader", "key": "Authorization", "op": "contains", "value": "MwcToken" }` |
| `responseHeader` | `equals`, `not_equals`, `matches`, `contains`, `exists`, `not_exists` | Response | `response.Headers` + `response.Content?.Headers`. Requires `key`. | `{ "field": "responseHeader", "key": "Retry-After", "op": "exists" }` |
| `requestBody` | `matches`, `contains`, `not_contains` | Request | `await request.Content.ReadAsStringAsync()`. Cached per evaluation cycle. **Max 64KB scanned** — larger bodies match on the first 64KB only. Binary bodies (non-text Content-Type) always evaluate to `false`. | `{ "field": "requestBody", "op": "contains", "value": "\"tableName\":" }` |
| `responseBody` | `matches`, `contains`, `not_contains` | Response | `await response.Content.ReadAsStringAsync()`. Buffered (see Section 3). Max 64KB scanned. | `{ "field": "responseBody", "op": "contains", "value": "\"error\":" }` |
| `statusCode` | `equals`, `not_equals`, `gt`, `lt`, `gte`, `lte` | Response | `(int)response.StatusCode` | `{ "field": "statusCode", "op": "gte", "value": 500 }` |
| `contentType` | `equals`, `contains`, `matches` | Both | Request phase: `request.Content?.Headers.ContentType?.MediaType`. Response phase: `response.Content?.Headers.ContentType?.MediaType`. | `{ "field": "contentType", "op": "contains", "value": "json" }` |
| `durationMs` | `gt`, `lt`, `gte`, `lte` | Response | `stopwatch.Elapsed.TotalMilliseconds` measured across `base.SendAsync()` | `{ "field": "durationMs", "op": "gt", "value": 5000 }` |

**Phase enforcement:** If a rule's `phase` is `"request"` but its predicate references a response-phase field (`statusCode`, `responseHeader`, `responseBody`, `durationMs`), the engine logs a validation warning and the predicate evaluates to `false` for that field (safe default — rule won't fire on nonsense).

#### 2.2.2 Compound Predicates

Compound predicates combine leaves into boolean trees. Max nesting depth: **8 levels** (enforced at validation time — deeper trees are rejected).

| Operator | Semantics | Min Children | Max Children | JSON Example |
|----------|-----------|-------------|-------------|--------------|
| `and` | All children must be `true` | 2 | 16 | `{ "operator": "and", "conditions": [ ... ] }` |
| `or` | At least one child must be `true` | 2 | 16 | `{ "operator": "or", "conditions": [ ... ] }` |
| `not` | Single child must be `false` | 1 | 1 | `{ "operator": "not", "conditions": [ { "field": "url", "op": "contains", "value": "/health" } ] }` |

**Short-circuit evaluation:** `and` stops at first `false`, `or` stops at first `true`. This is important for performance — put cheap predicates (method, httpClientName) before expensive ones (requestBody regex).

**Full example — "OneLake writes OR Fabric API writes, excluding health checks":**

```json
{
  "operator": "and",
  "conditions": [
    {
      "operator": "or",
      "conditions": [
        { "field": "httpClientName", "op": "equals", "value": "OneLakeRestClient" },
        { "field": "httpClientName", "op": "equals", "value": "DatalakeDirectoryClient" },
        { "field": "httpClientName", "op": "equals", "value": "PbiSharedApiClient" }
      ]
    },
    {
      "operator": "or",
      "conditions": [
        { "field": "method", "op": "equals", "value": "PUT" },
        { "field": "method", "op": "equals", "value": "POST" },
        { "field": "method", "op": "equals", "value": "DELETE" }
      ]
    },
    {
      "operator": "not",
      "conditions": [
        { "field": "url", "op": "contains", "value": "/health" }
      ]
    }
  ]
}
```

#### 2.2.3 Predicate Matching Operators — Behavior Specification

| Operator | Input Types | Behavior | Null/Missing Handling |
|----------|------------|----------|----------------------|
| `equals` | string↔string, int↔int | Case-sensitive exact match. For numeric fields, parsed as `int`/`double`. | Missing field → `false` |
| `not_equals` | same | `!equals` | Missing field → `true` (absent ≠ value) |
| `matches` | string↔regex | .NET `Regex` with `RegexOptions.Compiled \| RegexOptions.Singleline`. Timeout: **50ms** per evaluation (prevents ReDoS). | Missing/null → `false` |
| `not_matches` | string↔regex | `!matches` | Missing/null → `true` |
| `contains` | string↔string | `field.Contains(value, StringComparison.OrdinalIgnoreCase)`. Case-insensitive. | Missing/null → `false` |
| `not_contains` | string↔string | `!contains` | Missing/null → `true` |
| `gt`, `lt`, `gte`, `lte` | number↔number | Numeric comparison. Field value parsed as `double`. | Missing/null → `false` |
| `exists` | any | `true` if the field (or header key) is present and non-null. `value` is ignored. | N/A |
| `not_exists` | any | `true` if the field (or header key) is absent or null. | N/A |

### 2.3 Action Types — Complete Reference

Every action type has a typed `config` object. The table below is the **exhaustive** list. Each entry references the category spec that defined it.

#### 2.3.1 Request-Phase Actions

| Type | Source Spec | Config Schema | Phase | Short-Circuits? | Effect |
|------|------------|--------------|-------|----------------|--------|
| `delay` | C01 RS-01 | `{ delayMs: int, jitterMs?: int }` | request | No | `await Task.Delay(Clamp(delayMs + Random(-jitterMs, jitterMs), 0, 30000), ct)` before `base.SendAsync()`. Cancellation-aware. Max capped at 30s by engine. |
| `modifyRequestHeader` | C01 RS-05, C04 SP-01 | `{ operation: "set"\|"add"\|"remove", name: string, value?: string, transform?: string, jwtMutation?: JwtMutationConfig }` | request | No | `set` = replace or add. `add` = append (multi-value). `remove` = delete header. `transform: "replace_scheme"` swaps auth scheme (SP-01). `transform: "jwt_mutate"` modifies JWT claims (SP-02). |
| `modifyRequestBody` | C01 RS-03 | `{ find: string, replace: string, regex?: bool }` | request | No | Read body → find-replace → write back. If `regex: true`, uses `Regex.Replace` with capture groups (`$1`). Body is re-encoded with original Content-Type. Content-Length header updated. |
| `rewriteUrl` | C01 RS-02 | `{ find: string, replace: string, regex?: bool }` | request | No | `request.RequestUri = new Uri(Regex.Replace(url, find, replace))`. Updates Host header if domain changes. |
| `blockRequest` | C03 TC-01/TC-02 | `{ statusCode?: int, body?: string, headers?: dict, simulateTimeout?: bool, timeoutMs?: int, errorMessage?: string }` | request | **Yes** | If `simulateTimeout: true`: `await Task.Delay(timeoutMs, ct)` then throw `TaskCanceledException(msg, new TimeoutException(msg))`. Otherwise: return `new HttpResponseMessage((HttpStatusCode)statusCode) { Content = ... }` without calling `base.SendAsync()`. |
| `redirectRequest` | C01 RS-04 | `{ targetUrl: string, preserveHeaders?: bool }` | request | No | Replace `request.RequestUri`. If `preserveHeaders: false`, strip `Authorization` and `Cookie` headers (security: don't leak creds to redirect target). Default: `preserveHeaders: true`. |
| `methodOverride` | C01 RS-07 | `{ method: string }` | request | No | `request.Method = new HttpMethod(method)`. Validates method is a known HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS). |

#### 2.3.2 Response-Phase Actions

| Type | Source Spec | Config Schema | Phase | Short-Circuits? | Effect |
|------|------------|--------------|-------|----------------|--------|
| `modifyResponseStatus` | C02 RF-01 | `{ statusCode: int }` | response | No | `response.StatusCode = (HttpStatusCode)statusCode; response.ReasonPhrase = statusCode.ToString()`. Body is NOT modified — the mismatch between body and status is the interesting test. |
| `modifyResponseHeader` | C02 RF-02 | `{ operation: "set"\|"add"\|"remove", name: string, value?: string }` | response | No | Same semantics as `modifyRequestHeader` but on `response.Headers` / `response.Content.Headers`. |
| `modifyResponseBody` | C02 RF-02 | `{ find: string, replace: string, regex?: bool }` | response | No | Read response body → find-replace → write back as new `StringContent`. Content-Length updated. Used for field-level JSON mutation (e.g., `"rowCount":\d+` → `"rowCount":0`). |
| `delayResponse` | C02 RF-09, C03 TC-06 | `{ delayMs: int, jitterMs?: int }` | response | No | `await Task.Delay(...)` after `base.SendAsync()` but before returning response to FLT. Simulates slow network on the return path. |
| `forgeResponse` | C02 RF-03 | `{ statusCode: int, body?: string, headers?: dict, contentType?: string }` | request* | **Yes** | Constructs a complete `HttpResponseMessage` from config. Skips `base.SendAsync()` entirely — the real service is never contacted. *Evaluates predicate in request phase but produces a response. |
| `dropConnection` | C03 TC-04 | `{ errorMessage?: string, afterBytes?: int }` | response | No | If `afterBytes` is set: wraps response stream — after N bytes, throws `IOException(errorMessage)`. If not set: throws `HttpRequestException(errorMessage)` immediately. |

#### 2.3.3 Traffic Control Actions

| Type | Source Spec | Config Schema | Phase | Short-Circuits? | Effect |
|------|------------|--------------|-------|----------------|--------|
| `throttleBandwidth` | C03 TC-03 | `{ bytesPerSecond: int, direction?: "response" }` | response | No | Wraps `response.Content` stream with `ThrottledReadStream` that reads in chunks with `Task.Delay` between chunks to maintain target throughput. Currently response-direction only. |

#### 2.3.4 Observability Actions

| Type | Source Spec | Config Schema | Phase | Short-Circuits? | Effect |
|------|------------|--------------|-------|----------------|--------|
| `recordTraffic` | C05 OB-01 | `{ sessionName: string }` | both | No | Captures full request + response to the named `RecordingSession`. Appends a `RecordingEntry` (see C05 § 1.3) to the JSONL file. Non-blocking — write is queued to a background channel. |
| `tagRequest` | C05 OB-02 | `{ tags: { [key: string]: string } }` | request | No | Attaches key-value metadata to the `ChaosEvalContext`. Tags are propagated to the `_edog` extension in `RecordingEntry` and to the `chaos` topic event. No modification to the request itself. |

#### 2.3.5 Advanced Actions

| Type | Source Spec | Config Schema | Phase | Short-Circuits? | Effect |
|------|------------|--------------|-------|----------------|--------|
| `cacheReplay` | C06 AD-02 | `{ mode: "replay"\|"hybrid", sessionName: string, missBehavior: "return504"\|"passthrough", staleTolerance?: string }` | request | **Yes** (on cache hit) | Looks up `CacheKey` in named session. Hit → returns cached response (short-circuit). Miss → behavior depends on `missBehavior`. See C06 AD-02 for full spec. |
| `composite` | C06 AD-06 | `{ actions: Action[], executionOrder?: "sequential", stopOnError?: bool }` | both | Depends on children | Executes child actions in array order. Request-phase children run before `base.SendAsync()`, response-phase children run after. If any child short-circuits, remaining request-phase children still execute but `base.SendAsync()` is skipped. Max 8 children. No nesting. See C06 AD-06 § Execution Semantics. |

### 2.4 Metadata Fields

| Field | Type | Mutable? | Description |
|-------|------|----------|-------------|
| `id` | string | Immutable after creation | Kebab-case unique identifier. Set once at creation. |
| `name` | string | Yes | Human-readable display name. Max 120 chars. |
| `description` | string | Yes | Explains what the rule tests. Max 500 chars. |
| `enabled` | bool | Yes (via API) | Shorthand for `lifecycle.state == "active"`. Setting `enabled: true` triggers the `draft → active` transition (with limit validation). |
| `createdAt` | datetime | Engine-managed | Set once when rule is created. ISO 8601 UTC. |
| `lifecycle.state` | enum | Engine-managed | Current state in the lifecycle state machine. |
| `lifecycle.fireCount` | int | Engine-managed | Atomic counter. Incremented by `Interlocked.Increment` on every firing. Reset to 0 when rule is cloned. |
| `lifecycle.lastFiredAt` | datetime | Engine-managed | Updated on every firing. Used by the UI to show "last fired 3s ago". |
| `lifecycle.version` | int | Engine-managed | Optimistic concurrency version. Every mutation (state change, field update, firing) increments this. API returns 409 Conflict if the client's version doesn't match. |
| `source` | enum | Immutable | How this rule was created: `ui`, `api`, `dsl`, `preset`, `import`. |
| `category` | enum | Yes | C01–C06 category for UI grouping. |
| `tags` | string[] | Yes | Freeform tags. Max 20 tags, 40 chars each. |
| `priority` | int | Yes | Execution order. 0–999. |
| `probability` | float | Yes | Firing probability. 0.0–1.0. |

---

## Section 3: Rule Evaluation Engine (P2.2)

### 3.1 Algorithm — Step by Step

The evaluation engine lives inside `EdogHttpPipelineHandler.SendAsync()`. Every outbound HTTP request passes through this method. The engine must be **zero-cost when no rules are active** and **predictable when rules are active**.

#### 3.1.1 Complete Evaluation Flow

```
EdogHttpPipelineHandler.SendAsync(request, ct)
│
├─ 1. FAST PATH CHECK
│     snapshot = _ruleSnapshot   // volatile read, no lock
│     if snapshot.IsEmpty → return await base.SendAsync(request, ct)
│
├─ 2. BUILD EVALUATION CONTEXT
│     ctx = new ChaosEvalContext {
│       Request, HttpClientName, Url, Method,
│       RequestHeaders, RequestContentType, Timestamp
│     }
│
├─ 3. REQUEST-PHASE EVALUATION
│     shortCircuitResponse = null
│     for each rule in snapshot.RequestPhaseRules:  // sorted by priority ASC
│       if !rule.Enabled → skip
│       if !PredicateEvaluator.Evaluate(rule.Predicate, ctx) → skip
│       if !GateCheck.Passes(rule, ctx) → skip     // probability, rate, maxFirings
│       result = await ActionExecutor.ExecuteRequest(rule.Action, ctx, ct)
│       rule.RecordFiring(ctx)                      // atomic increment + audit
│       PublishChaosEvent(rule, ctx, "request")
│       if result.ShortCircuit:
│         shortCircuitResponse = result.Response
│         break                                     // first short-circuit wins
│
├─ 4. FORWARD TO REAL SERVICE (or short-circuit)
│     if shortCircuitResponse != null:
│       response = shortCircuitResponse
│     else:
│       sw = Stopwatch.StartNew()
│       response = await base.SendAsync(ctx.Request, ct)
│       sw.Stop()
│
├─ 5. ENRICH CONTEXT WITH RESPONSE DATA
│     ctx.Response = response
│     ctx.StatusCode = (int)response.StatusCode
│     ctx.DurationMs = sw.Elapsed.TotalMilliseconds
│     ctx.ResponseHeaders = response.Headers
│     ctx.ResponseContentType = response.Content?.Headers.ContentType?.MediaType
│
├─ 6. RESPONSE-PHASE EVALUATION
│     for each rule in snapshot.ResponsePhaseRules:  // sorted by priority ASC
│       if !rule.Enabled → skip
│       if !PredicateEvaluator.Evaluate(rule.Predicate, ctx) → skip
│       if !GateCheck.Passes(rule, ctx) → skip
│       response = await ActionExecutor.ExecuteResponse(rule.Action, ctx, response, ct)
│       rule.RecordFiring(ctx)
│       PublishChaosEvent(rule, ctx, "response")
│       // No short-circuit in response phase — all matching rules fire
│
└─ 7. RETURN
      return response
```

#### 3.1.2 Critical Design Decisions

**First-match short-circuit in request phase:** When a request-phase rule short-circuits (e.g., `blockRequest`, `forgeResponse`), lower-priority request-phase rules do NOT fire. Rationale: if a blackhole blocks the request, a delay rule on the same request is pointless. The user controls which rule "wins" via the `priority` field.

**All-match in response phase:** ALL matching response-phase rules fire, in priority order. Each rule receives the (possibly already mutated) response from the previous rule. This enables composition: rule A flips the status code, rule B adds a header, rule C modifies the body. If the user wants only-one-fires semantics, they use mutually exclusive predicates.

**`forgeResponse` special case:** Although `forgeResponse` produces a response, it evaluates during the **request phase** (before `base.SendAsync()`). It short-circuits: the real service is never contacted. Any response-phase rules then operate on the forged response, not a real one.

### 3.2 Matching Semantics

#### 3.2.1 Within a Single Rule

Predicates within a rule are combined by the boolean tree structure:

- **`and`**: ALL child conditions must be true.
- **`or`**: ANY child condition must be true.
- **`not`**: The single child must be false.

If a rule has a single leaf predicate (no `operator`/`conditions`), it is evaluated directly. This is syntactic sugar for a one-element `and`.

#### 3.2.2 Multiple Rules Matching the Same Request

| Phase | Matching Strategy | Rationale |
|-------|-------------------|-----------|
| Request | **First short-circuit wins.** Non-short-circuiting rules all fire. | A `delay` + `modifyRequestHeader` on the same request is valid composition. But `blockRequest` + `forgeResponse` can't both win — first one by priority takes it. |
| Response | **All matching rules fire** in priority order. | Response mutations compose: status flip + header add + body modify is a common pattern. |

#### 3.2.3 Priority Tie-Breaking

When two rules have the same `priority` value:
1. Sort by `lifecycle.createdAt` ascending (older rule first).
2. If `createdAt` is identical (batch import), sort by `id` alphabetically.

This provides **stable, deterministic ordering** — the same set of rules always evaluates in the same order.

### 3.3 Performance

#### 3.3.1 Complexity Analysis

| Path | Cost | Notes |
|------|------|-------|
| **Fast path** (no active rules) | **O(1)** — one volatile read, one branch | `_ruleSnapshot.IsEmpty` is a precomputed boolean on the immutable snapshot. |
| **Rule iteration** | **O(N)** where N = active rules in the relevant phase | Sequential scan. No indexing — N is expected to be < 50 in typical use. |
| **Predicate evaluation** | **O(D × C)** where D = tree depth, C = conditions per level | Short-circuit evaluation. Typical: D=2, C=3 → 6 comparisons. |
| **String comparisons** | O(L) where L = string length | `contains` / `equals` are substring/exact match. |
| **Regex evaluation** | O(L) amortized with compiled regex | `Regex` instances compiled once per rule (on creation), cached in the snapshot. 50ms timeout per evaluation prevents ReDoS. |
| **Body reads** | O(min(bodySize, 64KB)) | Body is read once, cached in `ChaosEvalContext`. Capped at 64KB to prevent large-allocation GC pressure. |

**Budget:** The chaos evaluation for a typical 10-rule setup with 2–3 conditions each adds **< 100μs** of overhead per request. This is unmeasurable against FLT's HTTP round-trip latencies (50ms–5000ms).

#### 3.3.2 Lock-Free Snapshot Reads

```
                    ┌──────────────────────────────────────────┐
                    │         ChaosRuleStore (singleton)         │
                    │                                            │
                    │  volatile ChaosRuleSnapshot _snapshot;     │
                    │                                            │
                    │  On Mutation:                               │
                    │    1. Clone current rules list              │
                    │    2. Apply mutation to clone               │
                    │    3. Build new ChaosRuleSnapshot           │
                    │    4. Volatile write: _snapshot = newSnap   │
                    │                                            │
                    │  On Read (every SendAsync):                 │
                    │    var snap = _snapshot;  // volatile read  │
                    │    // Use snap for entire evaluation        │
                    │    // No lock needed — snapshot immutable   │
                    └──────────────────────────────────────────┘
```

**Why this works:** `ChaosRuleSnapshot` is immutable. Once constructed, its fields never change. The `volatile` keyword ensures that the read of `_snapshot` in `SendAsync` always sees the latest write from the mutation thread. Multiple `SendAsync` calls can read the same snapshot concurrently without synchronization.

**Memory:** Each snapshot holds a `ReadOnlyCollection<ChaosRule>` plus pre-computed indexes (`RequestPhaseRules`, `ResponsePhaseRules`, `IsEmpty`). Typical memory: < 10KB for 50 rules. Old snapshots are collected by GC after all in-flight `SendAsync` calls referencing them complete.

### 3.4 C# Class Design

#### 3.4.1 `ChaosRuleSnapshot` (Immutable, Thread-Safe)

```csharp
/// <summary>
/// Immutable snapshot of all active chaos rules. Created on every mutation,
/// read by every SendAsync call. Never locked.
/// </summary>
internal sealed class ChaosRuleSnapshot
{
    public static readonly ChaosRuleSnapshot Empty = new(Array.Empty<ChaosRule>());

    public ChaosRuleSnapshot(IReadOnlyList<ChaosRule> allRules)
    {
        AllRules = allRules;
        RequestPhaseRules = allRules
            .Where(r => r.Enabled && r.Phase is "request" or "both")
            .OrderBy(r => r.Priority)
            .ThenBy(r => r.Lifecycle.CreatedAt)
            .ToArray();
        ResponsePhaseRules = allRules
            .Where(r => r.Enabled && r.Phase is "response" or "both")
            .OrderBy(r => r.Priority)
            .ThenBy(r => r.Lifecycle.CreatedAt)
            .ToArray();
        IsEmpty = RequestPhaseRules.Length == 0 && ResponsePhaseRules.Length == 0;
    }

    public IReadOnlyList<ChaosRule> AllRules { get; }
    public ChaosRule[] RequestPhaseRules { get; }
    public ChaosRule[] ResponsePhaseRules { get; }
    public bool IsEmpty { get; }
}
```

#### 3.4.2 `ChaosPredicateEvaluator` (Static, Stateless)

```csharp
/// <summary>
/// Evaluates predicate trees against a request/response context.
/// All methods are static and thread-safe.
/// </summary>
internal static class ChaosPredicateEvaluator
{
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(50);

    public static bool Evaluate(Predicate predicate, ChaosEvalContext ctx)
    {
        return predicate switch
        {
            ConditionPredicate cp => EvaluateCondition(cp, ctx),
            CompoundPredicate { Operator: "and" } cp =>
                cp.Conditions.All(c => Evaluate(c, ctx)),
            CompoundPredicate { Operator: "or" } cp =>
                cp.Conditions.Any(c => Evaluate(c, ctx)),
            CompoundPredicate { Operator: "not" } cp =>
                !Evaluate(cp.Conditions[0], ctx),
            _ => false  // Unknown predicate type → safe default: don't fire
        };
    }

    private static bool EvaluateCondition(ConditionPredicate cp, ChaosEvalContext ctx)
    {
        string? fieldValue = ExtractField(cp.Field, cp.Key, ctx);

        return cp.Op switch
        {
            "equals"       => string.Equals(fieldValue, cp.Value?.ToString(),
                                StringComparison.OrdinalIgnoreCase),
            "not_equals"   => !string.Equals(fieldValue, cp.Value?.ToString(),
                                StringComparison.OrdinalIgnoreCase),
            "contains"     => fieldValue?.Contains(cp.Value?.ToString() ?? "",
                                StringComparison.OrdinalIgnoreCase) == true,
            "not_contains" => fieldValue?.Contains(cp.Value?.ToString() ?? "",
                                StringComparison.OrdinalIgnoreCase) != true,
            "matches"      => fieldValue != null && TryRegexMatch(fieldValue,
                                cp.Value?.ToString() ?? "", cp.CompiledRegex),
            "not_matches"  => fieldValue == null || !TryRegexMatch(fieldValue,
                                cp.Value?.ToString() ?? "", cp.CompiledRegex),
            "gt"           => CompareNumeric(fieldValue, cp.Value) > 0,
            "lt"           => CompareNumeric(fieldValue, cp.Value) < 0,
            "gte"          => CompareNumeric(fieldValue, cp.Value) >= 0,
            "lte"          => CompareNumeric(fieldValue, cp.Value) <= 0,
            "exists"       => fieldValue != null,
            "not_exists"   => fieldValue == null,
            _ => false
        };
    }

    private static string? ExtractField(string field, string? key, ChaosEvalContext ctx)
    {
        return field switch
        {
            "url"             => ctx.Url,
            "method"          => ctx.Method,
            "httpClientName"  => ctx.HttpClientName,
            "requestHeader"   => ctx.GetRequestHeader(key),
            "responseHeader"  => ctx.GetResponseHeader(key),
            "requestBody"     => ctx.GetRequestBodyPreview(),   // lazy, cached, 64KB max
            "responseBody"    => ctx.GetResponseBodyPreview(),  // lazy, cached, 64KB max
            "statusCode"      => ctx.StatusCode?.ToString(),
            "contentType"     => ctx.Phase == "request"
                                    ? ctx.RequestContentType
                                    : ctx.ResponseContentType,
            "durationMs"      => ctx.DurationMs?.ToString("F2"),
            _ => null
        };
    }

    private static bool TryRegexMatch(string input, string pattern, Regex? compiled)
    {
        try
        {
            var regex = compiled ?? new Regex(pattern,
                RegexOptions.Compiled | RegexOptions.Singleline, RegexTimeout);
            return regex.IsMatch(input);
        }
        catch (RegexMatchTimeoutException)
        {
            // ReDoS protection: regex took >50ms. Treat as non-match.
            return false;
        }
    }

    private static int CompareNumeric(string? fieldValue, object? target)
    {
        if (fieldValue == null || target == null) return -1; // null < anything
        if (!double.TryParse(fieldValue, out var a)) return -1;
        if (!double.TryParse(target.ToString(), out var b)) return -1;
        return a.CompareTo(b);
    }
}
```

#### 3.4.3 `ChaosGateCheck` (Probability + Rate + MaxFirings)

```csharp
/// <summary>
/// Gates whether a predicate-matched rule should actually fire.
/// Checks probability, rate limit, and max firings — in that order (cheapest first).
/// </summary>
internal static class ChaosGateCheck
{
    public static bool Passes(ChaosRule rule, ChaosEvalContext ctx)
    {
        // 1. Probability gate
        if (rule.Probability < 1.0)
        {
            if (Random.Shared.NextDouble() >= rule.Probability)
                return false;
        }

        // 2. Max firings gate
        if (rule.Limits.MaxFirings > 0)
        {
            int current = rule.Lifecycle.FireCount;
            if (current >= rule.Limits.MaxFirings)
            {
                // Auto-expire: CAS to prevent double-transition
                rule.TryTransitionTo("expired", "maxFirings reached");
                return false;
            }
        }

        // 3. Rate limit gate (token bucket)
        if (rule.Limits.MaxRatePerSecond > 0)
        {
            if (!rule.RateLimiter.TryAcquire())
                return false;
        }

        // 4. TTL / expiresAt gate
        if (rule.IsExpired(ctx.Timestamp))
        {
            rule.TryTransitionTo("expired", $"TTL expired after {rule.Limits.TtlSeconds}s");
            return false;
        }

        return true;
    }
}
```

#### 3.4.4 `ChaosEvalContext` (Per-Request, Mutable)

```csharp
/// <summary>
/// Mutable context built per-request. Carries request data through the evaluation pipeline.
/// NOT shared across requests. Created in SendAsync, discarded when SendAsync returns.
/// </summary>
internal sealed class ChaosEvalContext
{
    // === Set before request-phase evaluation ===
    public HttpRequestMessage Request { get; set; }
    public string HttpClientName { get; set; }
    public string Url { get; set; }
    public string Method { get; set; }
    public string? RequestContentType { get; set; }
    public DateTimeOffset Timestamp { get; set; } = DateTimeOffset.UtcNow;
    public string Phase { get; set; } = "request";

    // === Set after base.SendAsync() ===
    public HttpResponseMessage? Response { get; set; }
    public int? StatusCode { get; set; }
    public double? DurationMs { get; set; }
    public string? ResponseContentType { get; set; }

    // === Lazy body caching ===
    private string? _requestBodyCache;
    private bool _requestBodyRead;

    public string? GetRequestBodyPreview()
    {
        if (_requestBodyRead) return _requestBodyCache;
        _requestBodyRead = true;
        if (Request.Content == null) return null;
        var mediaType = Request.Content.Headers.ContentType?.MediaType ?? "";
        if (!mediaType.Contains("json") && !mediaType.Contains("xml")
            && !mediaType.Contains("text")) return null; // skip binary
        // ReadAsStringAsync is safe here — content is buffered by DelegatingHandler
        var body = Request.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        _requestBodyCache = body.Length > 65536 ? body[..65536] : body;
        return _requestBodyCache;
    }

    // === Header access ===
    public string? GetRequestHeader(string? key)
    {
        if (key == null) return null;
        if (Request.Headers.TryGetValues(key, out var vals))
            return string.Join(", ", vals);
        if (Request.Content?.Headers.TryGetValues(key, out var cvals) == true)
            return string.Join(", ", cvals);
        return null;
    }

    public string? GetResponseHeader(string? key)
    {
        if (key == null || Response == null) return null;
        if (Response.Headers.TryGetValues(key, out var vals))
            return string.Join(", ", vals);
        if (Response.Content?.Headers.TryGetValues(key, out var cvals) == true)
            return string.Join(", ", cvals);
        return null;
    }

    // Response body cached similarly to request body — omitted for brevity.
    // Same pattern: lazy read, 64KB cap, binary skip.
}
```

#### 3.4.5 Integration Point: `EdogHttpPipelineHandler.SendAsync()`

This is the **exact code** that goes into the existing `EdogHttpPipelineHandler`. It replaces the current read-only passthrough with chaos-aware evaluation:

```csharp
protected override async Task<HttpResponseMessage> SendAsync(
    HttpRequestMessage request, CancellationToken cancellationToken)
{
    // ═══ FAST PATH: No chaos rules active ═══
    // Single volatile read. If empty, zero overhead — straight to base.SendAsync().
    var snapshot = ChaosRuleStore.Instance.CurrentSnapshot; // volatile field read
    if (snapshot.IsEmpty)
    {
        return await CaptureAndSend(request, cancellationToken);
    }

    // ═══ BUILD CONTEXT ═══
    var ctx = new ChaosEvalContext
    {
        Request = request,
        HttpClientName = _httpClientName,
        Url = request.RequestUri?.ToString() ?? "",
        Method = request.Method.Method,
        RequestContentType = request.Content?.Headers.ContentType?.MediaType,
    };

    // ═══ REQUEST PHASE ═══
    HttpResponseMessage? shortCircuitResponse = null;

    foreach (var rule in snapshot.RequestPhaseRules)
    {
        if (ChaosPredicateEvaluator.Evaluate(rule.Predicate, ctx)
            && ChaosGateCheck.Passes(rule, ctx))
        {
            try
            {
                var result = await ChaosActionExecutor.ExecuteRequestAsync(
                    rule.Action, ctx, cancellationToken);

                Interlocked.Increment(ref rule.Lifecycle._fireCount);
                rule.Lifecycle.LastFiredAt = DateTimeOffset.UtcNow;
                EdogTopicRouter.Publish("chaos",
                    ChaosEvent.Fired(rule, ctx, "request"));

                if (result.ShortCircuit && result.Response != null)
                {
                    shortCircuitResponse = result.Response;
                    break; // First short-circuit wins
                }
            }
            catch (Exception ex)
            {
                // Rule execution failed — disable the specific rule, continue pipeline
                rule.TryTransitionTo("disabled-by-safety",
                    $"Unhandled exception in request action: {ex.GetType().Name}: {ex.Message}");
                EdogTopicRouter.Publish("chaos",
                    ChaosEvent.Error(rule, ctx, ex));
            }
        }
    }

    // ═══ FORWARD TO REAL SERVICE (or return short-circuit response) ═══
    HttpResponseMessage response;
    if (shortCircuitResponse != null)
    {
        response = shortCircuitResponse;
        ctx.DurationMs = 0; // No real network call
    }
    else
    {
        var sw = Stopwatch.StartNew();
        response = await CaptureAndSend(ctx.Request, cancellationToken);
        sw.Stop();
        ctx.DurationMs = sw.Elapsed.TotalMilliseconds;
    }

    // ═══ ENRICH CONTEXT ═══
    ctx.Response = response;
    ctx.StatusCode = (int)response.StatusCode;
    ctx.ResponseContentType = response.Content?.Headers.ContentType?.MediaType;
    ctx.Phase = "response";

    // ═══ RESPONSE PHASE ═══
    foreach (var rule in snapshot.ResponsePhaseRules)
    {
        if (ChaosPredicateEvaluator.Evaluate(rule.Predicate, ctx)
            && ChaosGateCheck.Passes(rule, ctx))
        {
            try
            {
                response = await ChaosActionExecutor.ExecuteResponseAsync(
                    rule.Action, ctx, response, cancellationToken);
                ctx.Response = response; // Update for next rule in chain

                Interlocked.Increment(ref rule.Lifecycle._fireCount);
                rule.Lifecycle.LastFiredAt = DateTimeOffset.UtcNow;
                EdogTopicRouter.Publish("chaos",
                    ChaosEvent.Fired(rule, ctx, "response"));
            }
            catch (Exception ex)
            {
                rule.TryTransitionTo("disabled-by-safety",
                    $"Unhandled exception in response action: {ex.GetType().Name}: {ex.Message}");
                EdogTopicRouter.Publish("chaos",
                    ChaosEvent.Error(rule, ctx, ex));
                // Response is unchanged — FLT gets the unmodified response
            }
        }
    }

    return response;
}

/// <summary>
/// Existing capture logic (publish to http topic) + base.SendAsync().
/// Factored out so both fast-path and chaos-path share the same capture code.
/// </summary>
private async Task<HttpResponseMessage> CaptureAndSend(
    HttpRequestMessage request, CancellationToken ct)
{
    // ... existing EdogHttpPipelineHandler capture logic unchanged ...
    return await base.SendAsync(request, ct);
}
```

---

## Section 4: Rule Store (P2.3)

### 4.1 Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                     ChaosRuleStore                         │
│                     (Singleton)                            │
│                                                            │
│  ┌─────────────────────┐    ┌───────────────────────────┐ │
│  │  In-Memory Rules    │    │  volatile _snapshot        │ │
│  │  List<ChaosRule>    │    │  ChaosRuleSnapshot         │ │
│  │  (mutation target)  │    │  (read by every SendAsync) │ │
│  └────────┬────────────┘    └───────────────────────────┘ │
│           │                          ▲                     │
│           │  On any mutation:        │                     │
│           │  1. lock(_mutateLock)    │                     │
│           │  2. Apply change         │                     │
│           │  3. Build new snapshot ──┘                     │
│           │  4. Volatile write _snapshot                   │
│           │  5. Queue async file persist                   │
│           │  6. Publish to "chaos" topic                   │
│                                                            │
│  ┌─────────────────────┐    ┌───────────────────────────┐ │
│  │  FileSystemWatcher  │    │  Preset Registry          │ │
│  │  (hot-reload)       │    │  (built-in + user)        │ │
│  └─────────────────────┘    └───────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 4.2 CRUD Operations

All mutations go through `ChaosRuleStore` methods. Every method acquires `_mutateLock`, applies the change, builds a new `ChaosRuleSnapshot`, and volatile-writes it.

#### 4.2.1 Method Signatures

```csharp
internal sealed class ChaosRuleStore
{
    // === Singleton ===
    public static ChaosRuleStore Instance { get; } = new();

    // === Snapshot (read by SendAsync — volatile, lock-free) ===
    private volatile ChaosRuleSnapshot _snapshot = ChaosRuleSnapshot.Empty;
    public ChaosRuleSnapshot CurrentSnapshot => _snapshot;

    // === Mutation lock (only one writer at a time) ===
    private readonly object _mutateLock = new();

    // === CRUD ===

    /// <summary>Create a new rule in 'draft' state. Returns the created rule with engine-managed fields populated.</summary>
    /// <exception cref="ArgumentException">If id is duplicate or schema validation fails.</exception>
    public ChaosRule Create(ChaosRuleCreateRequest request);

    /// <summary>Get a single rule by id. Returns null if not found.</summary>
    public ChaosRule? GetById(string id);

    /// <summary>Get all rules (all states including deleted, for admin/debug).</summary>
    public IReadOnlyList<ChaosRule> GetAll();

    /// <summary>Get active rules only (state == "active"). Same as CurrentSnapshot.AllRules but for API consumers.</summary>
    public IReadOnlyList<ChaosRule> GetActive();

    /// <summary>
    /// Update mutable fields (name, description, tags, category, predicate, action, phase, priority, probability, limits).
    /// Only allowed in 'draft' or 'paused' state. Returns 409 if version doesn't match.
    /// </summary>
    /// <exception cref="InvalidOperationException">If rule is in 'active' state — must pause first.</exception>
    /// <exception cref="ConcurrencyException">If version mismatch.</exception>
    public ChaosRule Update(string id, int expectedVersion, ChaosRuleUpdateRequest request);

    /// <summary>Soft-delete. Transitions to 'deleted' state. Rule is excluded from snapshots. Can be undeleted within 24h.</summary>
    public void Delete(string id);

    /// <summary>Undelete a soft-deleted rule (within 24h). Transitions back to 'draft'.</summary>
    /// <exception cref="InvalidOperationException">If rule was deleted more than 24h ago or is permanently purged.</exception>
    public ChaosRule Undelete(string id);

    /// <summary>
    /// Enable a rule: draft → active. Validates that at least one limit is set.
    /// Sets lifecycle.activatedAt, starts TTL timer.
    /// </summary>
    /// <exception cref="ValidationException">If no limits set, predicate invalid, or action config incomplete.</exception>
    public ChaosRule Enable(string id);

    /// <summary>Disable (pause) an active rule: active → paused.</summary>
    public ChaosRule Disable(string id);

    /// <summary>Resume a paused rule: paused → active. Re-validates limits (TTL may have expired while paused).</summary>
    public ChaosRule Resume(string id);

    /// <summary>Clone a rule. Creates a new draft with a new id, fireCount reset to 0, state = draft.</summary>
    public ChaosRule Clone(string sourceId, string? newId = null);

    // === Bulk Operations ===

    /// <summary>Kill switch. Transitions ALL active rules to 'disabled-by-safety'. Atomic snapshot swap to Empty.</summary>
    public void ClearAll(string reason = "Kill switch activated");

    /// <summary>Import rules from JSON array. Each rule is created as a new draft.</summary>
    public IReadOnlyList<ChaosRule> Import(string json);

    /// <summary>Export all rules (or filtered by tags/category) as JSON array.</summary>
    public string Export(string[]? tags = null, string? category = null);

    /// <summary>Load a preset by id. Creates all preset rules as drafts with source="preset".</summary>
    public IReadOnlyList<ChaosRule> LoadPreset(string presetId);

    // === Internal ===

    /// <summary>Rebuild snapshot from current rules list. Called after every mutation.</summary>
    private void RebuildSnapshot();

    /// <summary>Persist rules to disk asynchronously. Fire-and-forget on a background thread.</summary>
    private void QueuePersist();
}
```

#### 4.2.2 State Transition Validation

Every state transition is validated. Invalid transitions throw `InvalidOperationException`:

| Method | Valid Source States | Target State |
|--------|-------------------|--------------|
| `Enable` | `draft` | `active` |
| `Disable` | `active` | `paused` |
| `Resume` | `paused`, `disabled-by-safety` | `active` |
| `Delete` | any except `deleted` | `deleted` |
| `Undelete` | `deleted` (within 24h) | `draft` |
| `Clone` | any | new rule in `draft` |
| `ClearAll` | all `active` rules | `disabled-by-safety` |

### 4.3 Persistence

#### 4.3.1 File Format

Rules are persisted to `~/.edog-chaos-rules.json` (user home directory). The file contains the complete rule list as a JSON array:

```json
{
  "version": 2,
  "lastModified": "2025-07-25T14:30:00Z",
  "rules": [
    { /* ChaosRule JSON */ },
    { /* ChaosRule JSON */ }
  ]
}
```

**Why user home, not project directory:** Chaos rules are developer-specific, not project-specific. Different engineers testing the same FLT codebase want different chaos configurations. Also, rules may contain environment-specific values (URLs, client names) that shouldn't be committed to source control.

#### 4.3.2 Atomic Writes

```csharp
private void PersistToDisk(IReadOnlyList<ChaosRule> rules)
{
    var json = JsonSerializer.Serialize(new ChaosRuleFile
    {
        Version = 2,
        LastModified = DateTimeOffset.UtcNow,
        Rules = rules
    }, _jsonOptions);

    // Atomic write: write to temp file, then rename
    var tempPath = _filePath + ".tmp";
    File.WriteAllText(tempPath, json, Encoding.UTF8);
    File.Move(tempPath, _filePath, overwrite: true);
}
```

**Why atomic writes:** If EDOG crashes during a write, the temp file is incomplete but the original file is intact. On next startup, the original file is loaded. The `.tmp` file is cleaned up.

#### 4.3.3 Hot-Reload via FileSystemWatcher

```csharp
private FileSystemWatcher _watcher;

private void InitializeWatcher()
{
    _watcher = new FileSystemWatcher(
        Path.GetDirectoryName(_filePath)!,
        Path.GetFileName(_filePath))
    {
        NotifyFilter = NotifyFilters.LastWrite
    };

    _watcher.Changed += (_, _) =>
    {
        // Debounce: ignore events within 500ms of our own writes
        if (_lastWriteTime.AddMilliseconds(500) > DateTime.UtcNow)
            return;

        try
        {
            var json = File.ReadAllText(_filePath);
            var file = JsonSerializer.Deserialize<ChaosRuleFile>(json, _jsonOptions);
            if (file?.Rules != null)
            {
                lock (_mutateLock)
                {
                    _rules = file.Rules.ToList();
                    RebuildSnapshot();
                    EdogTopicRouter.Publish("chaos", new { type = "rules-reloaded",
                        count = _rules.Count, source = "file-watcher" });
                }
            }
        }
        catch (Exception ex)
        {
            EdogTopicRouter.Publish("chaos", new { type = "reload-error",
                message = ex.Message });
        }
    };

    _watcher.EnableRaisingEvents = true;
}
```

**Use case:** Engineer opens `~/.edog-chaos-rules.json` in VS Code, edits a rule's predicate, saves. The FileSystemWatcher detects the change, reloads rules, rebuilds snapshot. The updated rule takes effect on the next HTTP request — no restart needed.

#### 4.3.4 Startup Sequence

```
1. ChaosRuleStore constructor:
   a. If ~/.edog-chaos-rules.json exists:
      - Load and deserialize
      - All rules forced to 'draft' or 'paused' state (safety: never auto-activate on restart)
      - Build initial snapshot
   b. If file doesn't exist:
      - Start with empty rules list
      - Snapshot = ChaosRuleSnapshot.Empty
   c. Initialize FileSystemWatcher
   d. Load built-in presets into _presetRegistry (not into active rules)
```

**Safety:** Rules are NEVER active on startup. Even if a rule was `active` when EDOG was last shut down, it loads as `paused` (with `disableReason: "Restored from file — requires manual re-enable"`). This prevents "I restarted EDOG and my chaos rules were still running" accidents.

### 4.4 Preset Loading

Built-in presets (from C06 AD-05) are stored as embedded resources in the EDOG C# assembly:

```
src/backend/DevMode/ChaosPresets/
├── preset-onelake-outage.json
├── preset-spark-capacity.json
├── preset-fabric-api-down.json
├── preset-token-storm.json
├── preset-slow-network.json
├── preset-catalog-corruption.json
├── preset-intermittent-failures.json
└── preset-regional-failover.json
```

**Loading flow:**
1. `ChaosRuleStore.LoadPreset("preset-onelake-outage")` reads the embedded JSON.
2. Each rule in the preset's `rules` array is created as a new `draft` rule with `source: "preset"`.
3. Rule IDs are prefixed: `preset-onelake-outage--blackhole-writes`.
4. Limits from the preset definition are applied. The user can modify before enabling.
5. The user enables individual rules or all preset rules at once via `Enable("preset-onelake-outage--*")` (wildcard enable).

User-created presets are stored in `~/.edog-chaos-presets/` as JSON files, following the same schema as built-in presets.

---

## Section 5: Safety Mechanisms (P2.4)

### 5.1 Kill Switch

**The single most important safety mechanism.** One action disables all chaos. Always available, always fast.

#### Implementation

```csharp
// ChaosRuleStore.ClearAll() — the kill switch implementation
public void ClearAll(string reason = "Kill switch activated")
{
    lock (_mutateLock)
    {
        foreach (var rule in _rules.Where(r => r.Lifecycle.State == "active"))
        {
            rule.TryTransitionTo("disabled-by-safety", reason);
        }
        _snapshot = ChaosRuleSnapshot.Empty; // Volatile write — immediate effect
        QueuePersist();
        EdogTopicRouter.Publish("chaos", new
        {
            type = "kill-switch",
            reason,
            rulesDisabled = _rules.Count(r => r.Lifecycle.DisableReason == reason),
            timestamp = DateTimeOffset.UtcNow
        });
    }
}
```

#### Activation Paths

| Path | Trigger | Latency | Implementation |
|------|---------|---------|----------------|
| **Keyboard** | `Ctrl+Shift+K` | < 50ms (local JS → SignalR → C#) | Frontend sends `hub.invoke("ClearAllChaosRules")` → `EdogPlaygroundHub` calls `ChaosRuleStore.ClearAll()` → volatile write to `_snapshot` → next `SendAsync` reads empty snapshot |
| **UI Button** | Red `⚠ KILL ALL CHAOS` button (always visible when rules active) | < 50ms | Same SignalR path as keyboard shortcut |
| **REST API** | `DELETE /api/chaos/rules/all` | < 10ms (direct HTTP) | `EdogLogServer` route handler calls `ChaosRuleStore.ClearAll()` |
| **Safety System** | Auto-triggered on FLT crash / error spike | < 1ms (in-process) | `ChaosHealthGuard.OnSafetyTrip()` calls `ChaosRuleStore.ClearAll()` directly |
| **CLI** | `edog chaos kill` (future) | < 100ms (HTTP to EDOG server) | `edog.py` sends `DELETE /api/chaos/rules/all` to port 5555 |

**Post-kill state:** All previously-active rules are in `disabled-by-safety` state with `disableReason: "Kill switch activated"`. The user must explicitly re-enable each rule after investigation. The snapshot is `ChaosRuleSnapshot.Empty` — the fast path in `SendAsync` immediately returns.

### 5.2 Auto-Disable on FLT Crash

If FLT throws an unhandled exception while chaos rules are active, the engine auto-disables all rules. This prevents a crash → restart → crash loop caused by persistent chaos rules.

#### Detection

```csharp
/// <summary>
/// Registered once at EDOG startup. Watches for unhandled exceptions in the FLT AppDomain.
/// </summary>
internal sealed class ChaosHealthGuard
{
    private static volatile bool _initialized;

    public static void Initialize()
    {
        if (_initialized) return;
        _initialized = true;

        // AppDomain-level handler — catches unhandled exceptions in any thread
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            if (ChaosRuleStore.Instance.CurrentSnapshot.IsEmpty)
                return; // No chaos rules active — not our problem

            ChaosRuleStore.Instance.ClearAll(
                $"safety: FLT unhandled exception detected — {args.ExceptionObject.GetType().Name}");
        };

        // TaskScheduler-level handler — catches unobserved Task exceptions
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            if (ChaosRuleStore.Instance.CurrentSnapshot.IsEmpty)
                return;

            ChaosRuleStore.Instance.ClearAll(
                $"safety: Unobserved task exception — {args.Exception.GetType().Name}");
            // Do NOT call args.SetObserved() — let the exception propagate normally
        };
    }
}
```

#### Process-Level Detection (edog.py)

`edog.py` monitors the FLT subprocess. If FLT exits unexpectedly while chaos rules were active:

```python
# In edog.py subprocess monitor:
if flt_process.returncode != 0 and chaos_rules_active:
    # FLT crashed with chaos rules active
    requests.delete(f"http://localhost:5555/api/chaos/rules/all",
                    params={"reason": f"FLT process exited with code {flt_process.returncode}"})
    log.warning("FLT crashed with chaos rules active — all rules disabled")
```

### 5.3 Max Firings (Per-Rule Counter)

Each rule has an atomic firing counter. When the counter reaches `maxFirings`, the rule auto-transitions to `expired`.

```csharp
// Inside ChaosGateCheck.Passes() — see Section 3.4.3
if (rule.Limits.MaxFirings > 0)
{
    // Interlocked.Increment returns the NEW value after increment
    int newCount = Interlocked.Increment(ref rule.Lifecycle._fireCount);
    if (newCount > rule.Limits.MaxFirings)
    {
        // We went over — decrement back (another thread may have also incremented)
        Interlocked.Decrement(ref rule.Lifecycle._fireCount);
        rule.TryTransitionTo("expired",
            $"maxFirings reached ({rule.Limits.MaxFirings}/{rule.Limits.MaxFirings})");
        return false;
    }
    // newCount <= MaxFirings — proceed
}
```

**Note:** The gate check in Section 3.4.3 shows a simplified version that reads first, then transitions. The implementation above is the thread-safe version using `Interlocked.Increment` to handle concurrent `SendAsync` calls that might both try to fire the Nth time.

**Edge case — concurrent firings at the boundary:** If `maxFirings = 10` and two threads both `Interlocked.Increment` simultaneously (counts 10 and 11), the thread that got 11 decrements back and returns `false`. The thread that got 10 proceeds. Result: exactly `maxFirings` firings, no more.

### 5.4 Duration TTL (Per-Rule Timer)

Each rule has a TTL (time-to-live) measured from activation time. When the TTL expires, the rule auto-transitions to `expired`.

```csharp
// In ChaosRule:
public bool IsExpired(DateTimeOffset now)
{
    if (Lifecycle.State != "active") return false;

    // Check absolute expiry
    if (Limits.ExpiresAt.HasValue && now >= Limits.ExpiresAt.Value)
        return true;

    // Check TTL from activation
    if (Limits.TtlSeconds > 0 && Lifecycle.ActivatedAt.HasValue)
    {
        var elapsed = (now - Lifecycle.ActivatedAt.Value).TotalSeconds;
        if (elapsed >= Limits.TtlSeconds)
            return true;
    }

    return false;
}
```

**TTL is checked on every request** (inside `ChaosGateCheck.Passes()`), not via a background timer. This means:
- If no requests flow while the TTL expires, the rule stays in `active` state until the next request arrives and triggers the check.
- This is acceptable — a rule with no matching traffic and an expired TTL is harmless (it won't fire).
- The UI polls rule status every 2 seconds and shows correct state regardless.

**Additional background sweep:** A `Timer` fires every 10 seconds to catch expired rules that haven't been checked by traffic:

```csharp
private readonly Timer _expiryTimer = new(_ =>
{
    var now = DateTimeOffset.UtcNow;
    bool anyExpired = false;
    foreach (var rule in _rules.Where(r => r.Lifecycle.State == "active"))
    {
        if (rule.IsExpired(now))
        {
            rule.TryTransitionTo("expired",
                rule.Limits.ExpiresAt.HasValue
                    ? $"Absolute expiry reached ({rule.Limits.ExpiresAt.Value:o})"
                    : $"TTL expired after {rule.Limits.TtlSeconds}s");
            anyExpired = true;
        }
    }
    if (anyExpired) RebuildSnapshot();
}, null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));
```

### 5.5 Health Guard

The health guard continuously monitors system health. If health degrades below thresholds while chaos rules are active, all rules are auto-disabled.

#### Monitored Signals

| Signal | Source | Threshold | Check Interval | Action |
|--------|--------|-----------|----------------|--------|
| **HTTP error rate** | `EdogTopicRouter` "http" topic — count of 5xx responses vs total | > 80% over a 10-second sliding window | Every 2s | `ClearAll("safety: HTTP error rate {rate}% > 80% threshold")` |
| **FLT process alive** | `edog.py` subprocess monitor | Process exit code ≠ 0 | Continuous (process wait) | `ClearAll("safety: FLT process exited")` |
| **Unhandled exceptions** | `AppDomain.UnhandledException` / `TaskScheduler.UnobservedTaskException` | Any unhandled exception | Event-driven | `ClearAll("safety: unhandled exception")` |
| **Chaos rule execution errors** | `try/catch` around each rule execution in `SendAsync` | 3 consecutive errors from the same rule | Per-request | Disable **that specific rule** (not all rules): `rule.TryTransitionTo("disabled-by-safety", ...)` |
| **Memory pressure** | `GC.GetGCMemoryInfo()` | > 90% of high-memory threshold | Every 30s | `ClearAll("safety: memory pressure — {used}MB / {total}MB")` |

#### Implementation

```csharp
internal sealed class ChaosHealthGuard
{
    private readonly SlidingWindowCounter _errorCounter = new(windowSeconds: 10);
    private readonly SlidingWindowCounter _totalCounter = new(windowSeconds: 10);
    private readonly Timer _healthCheckTimer;

    public ChaosHealthGuard()
    {
        // Subscribe to http topic for error rate tracking
        EdogTopicRouter.Subscribe("http", OnHttpEvent);

        _healthCheckTimer = new Timer(_ => CheckHealth(), null,
            TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));
    }

    private void OnHttpEvent(TopicEvent evt)
    {
        _totalCounter.Increment();
        if (evt.Data is { } data && data.TryGetValue("statusCode", out var sc)
            && sc is int code && code >= 500)
        {
            _errorCounter.Increment();
        }
    }

    private void CheckHealth()
    {
        if (ChaosRuleStore.Instance.CurrentSnapshot.IsEmpty)
            return; // No chaos rules active — nothing to guard

        // Error rate check
        int total = _totalCounter.Count;
        int errors = _errorCounter.Count;
        if (total >= 5) // Minimum sample size
        {
            double rate = (double)errors / total;
            if (rate > 0.80)
            {
                ChaosRuleStore.Instance.ClearAll(
                    $"safety: HTTP error rate {rate:P0} exceeds 80% threshold " +
                    $"({errors}/{total} in last 10s)");
            }
        }

        // Memory pressure check (every 15th interval = every 30s)
        if (_checkCount++ % 15 == 0)
        {
            var memInfo = GC.GetGCMemoryInfo();
            if (memInfo.MemoryLoadBytes > memInfo.HighMemoryLoadThresholdBytes * 0.9)
            {
                ChaosRuleStore.Instance.ClearAll(
                    $"safety: memory pressure — {memInfo.MemoryLoadBytes / 1_048_576}MB");
            }
        }
    }
}
```

### 5.6 Audit Log

Every rule state change and every rule firing is logged to `~/.edog-chaos-audit.jsonl` — a persistent, append-only log independent of the rule file.

#### Log Entry Format

```jsonc
// One JSON object per line. Each line is a complete, self-contained event.
{"ts":"2025-07-25T14:30:00.000Z","type":"rule.created","ruleId":"delay-onelake-3s","detail":"Created via UI","user":"sanar"}
{"ts":"2025-07-25T14:30:05.000Z","type":"rule.enabled","ruleId":"delay-onelake-3s","detail":"Activated. limits: maxFirings=50, ttlSeconds=300"}
{"ts":"2025-07-25T14:30:06.123Z","type":"rule.fired","ruleId":"delay-onelake-3s","detail":"Matched PUT https://onelake.dfs.fabric.microsoft.com/... (fire 1/50)","url":"https://onelake.dfs...","method":"PUT","client":"DatalakeDirectoryClient"}
{"ts":"2025-07-25T14:30:06.456Z","type":"rule.fired","ruleId":"delay-onelake-3s","detail":"Matched PUT https://onelake.dfs.fabric.microsoft.com/... (fire 2/50)","url":"https://onelake.dfs...","method":"PUT","client":"DatalakeDirectoryClient"}
{"ts":"2025-07-25T14:35:05.000Z","type":"rule.expired","ruleId":"delay-onelake-3s","detail":"TTL expired after 300s. fireCount=23/50"}
{"ts":"2025-07-25T14:40:00.000Z","type":"kill-switch","detail":"User activated kill switch via Ctrl+Shift+K","rulesDisabled":3}
{"ts":"2025-07-25T14:41:00.000Z","type":"safety.triggered","detail":"FLT unhandled exception detected — NullReferenceException","rulesDisabled":0}
```

#### Event Types

| Type | When | Key Fields |
|------|------|------------|
| `rule.created` | `Create()` | ruleId, source, user |
| `rule.enabled` | `Enable()` | ruleId, limits summary |
| `rule.disabled` | `Disable()` | ruleId |
| `rule.resumed` | `Resume()` | ruleId |
| `rule.updated` | `Update()` | ruleId, changed fields |
| `rule.deleted` | `Delete()` | ruleId |
| `rule.cloned` | `Clone()` | sourceId, newRuleId |
| `rule.fired` | Every firing | ruleId, url, method, client, fireCount |
| `rule.expired` | Auto-expire (maxFirings or TTL) | ruleId, reason, fireCount |
| `rule.error` | Exception during rule execution | ruleId, exceptionType, message |
| `kill-switch` | `ClearAll()` | reason, rulesDisabled |
| `safety.triggered` | Health guard auto-disable | signal, detail, rulesDisabled |
| `rules-reloaded` | File watcher reload | count, source |
| `preset.loaded` | `LoadPreset()` | presetId, rulesCreated |

#### Implementation

```csharp
internal static class ChaosAuditLog
{
    private static readonly string AuditFilePath =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".edog-chaos-audit.jsonl");

    private static readonly Channel<string> _writeChannel =
        Channel.CreateBounded<string>(new BoundedChannelOptions(10_000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true
        });

    static ChaosAuditLog()
    {
        // Background writer — reads from channel, appends to file
        Task.Run(async () =>
        {
            await using var writer = new StreamWriter(AuditFilePath, append: true, Encoding.UTF8);
            writer.AutoFlush = true;
            await foreach (var line in _writeChannel.Reader.ReadAllAsync())
            {
                await writer.WriteLineAsync(line);
            }
        });
    }

    public static void Log(object entry)
    {
        var json = JsonSerializer.Serialize(entry, _jsonOptions);
        _writeChannel.Writer.TryWrite(json); // Non-blocking. Drops oldest if channel full.

        // Also publish to chaos topic for live UI
        EdogTopicRouter.Publish("chaos", entry);
    }
}
```

**Performance:** Writing is fully async via `Channel<T>`. The `Log()` call is non-blocking — it enqueues a string and returns immediately. The background task handles file I/O. If the channel fills up (10K pending entries), oldest entries are dropped (chosen over blocking the HTTP pipeline).

**Rotation:** The audit log file is rotated daily by a background task. Files older than 7 days are deleted. Pattern: `~/.edog-chaos-audit.jsonl` (current), `~/.edog-chaos-audit.2025-07-24.jsonl` (previous).

### 5.7 Validation — Rule Safety Checks

Before a rule transitions to `active`, the engine runs a validation pass that rejects dangerous or malformed rules.

#### Validation Rules

```csharp
internal static class ChaosRuleValidator
{
    public static ValidationResult Validate(ChaosRule rule)
    {
        var errors = new List<string>();
        var warnings = new List<string>();

        // === Structural validation ===
        if (string.IsNullOrWhiteSpace(rule.Id))
            errors.Add("Rule id is required");
        if (rule.Id != null && !Regex.IsMatch(rule.Id, @"^[a-z0-9][a-z0-9-]{0,63}$"))
            errors.Add("Rule id must be kebab-case, max 64 chars");
        if (string.IsNullOrWhiteSpace(rule.Name))
            errors.Add("Rule name is required");
        if (rule.Predicate == null)
            errors.Add("Rule predicate is required");
        if (rule.Action == null)
            errors.Add("Rule action is required");

        // === Limit validation (required for activation) ===
        if (rule.Limits == null ||
            (rule.Limits.MaxFirings <= 0 &&
             rule.Limits.TtlSeconds <= 0 &&
             rule.Limits.ExpiresAt == null))
        {
            errors.Add("At least one limit must be set (maxFirings > 0, ttlSeconds > 0, or expiresAt)");
        }

        // === Predicate validation ===
        ValidatePredicate(rule.Predicate, errors, warnings, depth: 0);

        // === Action validation ===
        ValidateAction(rule.Action, rule.Phase, errors, warnings);

        // === Probability validation ===
        if (rule.Probability < 0.0 || rule.Probability > 1.0)
            errors.Add($"Probability must be 0.0–1.0, got {rule.Probability}");

        // === Destructive action warnings ===
        if (IsDestructiveAction(rule.Action) && rule.Probability >= 1.0)
            warnings.Add($"Destructive action '{rule.Action.Type}' at 100% probability. Consider reducing.");

        // === Broad predicate warning ===
        if (!HasNarrowPredicate(rule.Predicate))
            warnings.Add("Predicate matches all traffic (no httpClientName or URL filter). This will affect every HTTP call.");

        return new ValidationResult(errors, warnings);
    }

    private static void ValidatePredicate(Predicate pred, List<string> errors,
        List<string> warnings, int depth)
    {
        if (depth > 8)
        {
            errors.Add("Predicate nesting depth exceeds maximum of 8 levels");
            return;
        }

        if (pred is CompoundPredicate cp)
        {
            if (cp.Operator == "not" && cp.Conditions.Count != 1)
                errors.Add("'not' operator requires exactly 1 child condition");
            if (cp.Operator is "and" or "or" && cp.Conditions.Count < 2)
                errors.Add($"'{cp.Operator}' operator requires at least 2 child conditions");
            if (cp.Conditions.Count > 16)
                errors.Add($"Compound predicate has {cp.Conditions.Count} children (max 16)");
            foreach (var child in cp.Conditions)
                ValidatePredicate(child, errors, warnings, depth + 1);
        }
        else if (pred is ConditionPredicate leaf)
        {
            // Validate regex patterns
            if (leaf.Op is "matches" or "not_matches")
            {
                try
                {
                    _ = new Regex(leaf.Value?.ToString() ?? "",
                        RegexOptions.None, TimeSpan.FromMilliseconds(50));
                }
                catch (ArgumentException ex)
                {
                    errors.Add($"Invalid regex in predicate: {ex.Message}");
                }

                // ReDoS detection: reject patterns with nested quantifiers
                var pattern = leaf.Value?.ToString() ?? "";
                if (Regex.IsMatch(pattern, @"\(.+\+\).+\+|\(.+\*\).+\*"))
                    errors.Add($"Regex pattern may cause catastrophic backtracking (ReDoS): {pattern}");
            }

            // Validate field/op combinations
            if (leaf.Field is "requestHeader" or "responseHeader" &&
                string.IsNullOrEmpty(leaf.Key))
                errors.Add($"Header predicate requires 'key' field (header name)");
        }
    }

    private static void ValidateAction(Action action, string phase,
        List<string> errors, List<string> warnings)
    {
        switch (action.Type)
        {
            case "delay":
                var delay = action.Config?.Deserialize<DelayConfig>();
                if (delay == null) { errors.Add("delay action requires config"); break; }
                if (delay.DelayMs < 0)
                    errors.Add("delay.delayMs cannot be negative");
                if (delay.DelayMs > 30000)
                    warnings.Add($"delay.delayMs={delay.DelayMs}ms exceeds 30s cap — will be clamped");
                if (delay.JitterMs < 0)
                    errors.Add("delay.jitterMs cannot be negative");
                break;

            case "blockRequest":
                if (phase == "response")
                    errors.Add("blockRequest is a request-phase action but rule phase is 'response'");
                break;

            case "forgeResponse":
                if (phase == "response")
                    warnings.Add("forgeResponse fires in request phase (short-circuits). " +
                                 "Setting phase='response' means it will never trigger. Use phase='request' or 'both'.");
                break;

            case "modifyResponseStatus":
                var statusCfg = action.Config?.Deserialize<StatusConfig>();
                if (statusCfg?.StatusCode < 100 || statusCfg?.StatusCode > 599)
                    errors.Add("statusCode must be 100–599");
                break;

            case "throttleBandwidth":
                var bw = action.Config?.Deserialize<ThrottleConfig>();
                if (bw?.BytesPerSecond <= 0)
                    errors.Add("bytesPerSecond must be > 0");
                break;

            case "composite":
                var comp = action.Config?.Deserialize<CompositeConfig>();
                if (comp?.Actions == null || comp.Actions.Count == 0)
                    errors.Add("composite action requires at least one child action");
                if (comp?.Actions?.Count > 8)
                    errors.Add($"composite action has {comp.Actions.Count} children (max 8)");
                // Check for conflicting short-circuit actions
                var shortCircuitCount = comp?.Actions
                    ?.Count(a => a.Type is "blockRequest" or "forgeResponse") ?? 0;
                if (shortCircuitCount > 1)
                    errors.Add("composite action has multiple short-circuit actions " +
                               "(blockRequest/forgeResponse) — only the first will fire");
                break;
        }
    }

    private static bool IsDestructiveAction(Action action) =>
        action.Type is "blockRequest" or "dropConnection" or "forgeResponse";

    private static bool HasNarrowPredicate(Predicate pred)
    {
        // Returns true if predicate includes httpClientName or URL filter
        return pred switch
        {
            ConditionPredicate cp =>
                cp.Field is "httpClientName" or "url",
            CompoundPredicate { Operator: "and" } cp =>
                cp.Conditions.Any(HasNarrowPredicate),
            CompoundPredicate { Operator: "or" } cp =>
                cp.Conditions.All(HasNarrowPredicate),
            _ => false
        };
    }
}
```

#### Validation Timing

| When | What | Behavior on Failure |
|------|------|-------------------|
| `Create()` | Structural validation only (id format, required fields) | Reject creation with 400 Bad Request |
| `Update()` | Structural + predicate regex compilation | Reject update with 400 |
| `Enable()` | **Full validation** — structural + limits + regex + action config + ReDoS + phase consistency | Reject activation with 422 Unprocessable Entity. Rule stays in `draft`. |
| `Import()` | Structural per rule. Rules that fail validation are skipped with error report. | Partial import — valid rules created, invalid rules listed in error response. |

---

### Summary — Safety Mechanism Matrix

| Mechanism | Scope | Trigger | Latency | Recovery |
|-----------|-------|---------|---------|----------|
| **Kill switch** | All active rules | User (Ctrl+Shift+K, button, API) | < 50ms | Manual re-enable per rule |
| **FLT crash auto-disable** | All active rules | AppDomain.UnhandledException / process exit | < 1ms (in-process) | Manual re-enable after investigation |
| **Max firings** | Single rule | Atomic counter reaches limit | < 1μs (Interlocked) | Clone rule to reset counter |
| **Duration TTL** | Single rule | Timer or per-request check | < 10s (background sweep) | Clone rule with new TTL |
| **Health guard** | All active rules | HTTP error rate > 80% / memory pressure | < 2s (check interval) | Manual re-enable after investigation |
| **Per-rule error isolation** | Single rule | 3 consecutive execution errors | Immediate | Manual re-enable or delete |
| **Validation** | Single rule (at activation) | Regex, config, limits checks | Synchronous | Fix rule and re-attempt enable |
| **Audit log** | All rules, all events | Continuous | Non-blocking (async write) | Review log for post-mortem |
| **Safe defaults** | All rules | On creation | N/A | N/A — rules start disabled, no persistence on restart |

---

*Sana Reeves — "Every production-quality chaos system shares the same DNA: make it easy to break things, make it impossible to forget you're breaking things, and make it trivial to stop."*
