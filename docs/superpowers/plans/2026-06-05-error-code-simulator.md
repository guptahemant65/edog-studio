# Error Code Simulator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Error Code Simulator integrated into DAG Studio that lets engineers right-click a node, pick any FLT error code, run the DAG, and observe the real failure behavior.

**Architecture:** 4 injection channels — GTS status forge (HTTP 200 + error JSON), GTS submit forge (HTTP 429/430/500), Node state injection (set `node.IsFaulted` for pre-GTS errors), Exception injection (timeout). AsyncLocal per-node context via `EdogNodeExecutorWrapper` patch. Frontend: context menu on DAG nodes → categorized error picker → active injections panel → blast radius drawer.

**Tech Stack:** C# (backend interceptors + patches), vanilla JS + CSS (frontend), Python (edog.py patches + tests)

**Key References:**
- Design spec: `docs/superpowers/specs/2026-06-05-error-code-simulator-design.md`
- FLT ErrorCode enum: `workload-fabriclivetable/Service/Microsoft.LiveTable.Service/ErrorMapping/ErrorCode.cs` (115 members)
- FLT ErrorRegistry: `workload-fabriclivetable/Service/Microsoft.LiveTable.Service/ErrorMapping/ErrorRegistry.cs`
- FLT execution flow: `DagExecutionHandlerV2.cs` → `NodeExecutor.cs` → `GTSBasedSparkClient.cs`
- Existing fault store: `src/backend/DevMode/EdogHttpFaultStore.cs`
- Existing pipeline handler: `src/backend/DevMode/EdogHttpPipelineHandler.cs`
- Existing node wrapper (dead code): `src/backend/DevMode/EdogDagExecutionInterceptor.cs:140`
- Existing spark wrapper: `src/backend/DevMode/EdogSparkClientWrapper.cs`
- DAG Studio frontend: `src/frontend/js/dag-studio.js`, `src/frontend/js/dag-graph.js`
- Design system tokens: `docs/DESIGN_SYSTEM.md`

---

## Task 1: Error Code Catalog (C# static data)

**Files:**
- Create: `src/backend/DevMode/EdogErrorCodeCatalog.cs`
- Test: `tests/test_error_code_catalog_completeness.py`

The catalog is the source of truth — every error code, its phase, injection channel, errorSource, description, and injection recipe. Frontend reads this via SignalR.

- [ ] **Step 1: Write the completeness test**

```python
# tests/test_error_code_catalog_completeness.py
"""
Structural test: every ErrorCode enum member in the FLT repo must have
a corresponding entry in EdogErrorCodeCatalog.cs.
"""
import pathlib, re, pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
FLT_ERRORCODE = REPO.parent / "workload-fabriclivetable" / "Service" / "Microsoft.LiveTable.Service" / "ErrorMapping" / "ErrorCode.cs"
CATALOG = REPO / "src" / "backend" / "DevMode" / "EdogErrorCodeCatalog.cs"

@pytest.fixture(scope="module")
def flt_enum_members():
    if not FLT_ERRORCODE.exists():
        pytest.skip("FLT repo not present")
    src = FLT_ERRORCODE.read_text(encoding="utf-8")
    # Match all enum members — lines like "        MLV_TOO_MANY_REQUESTS,"
    return set(re.findall(r"^\s+((?:MLV|FMLV|FLT|DAG|DELTA)_\w+)", src, re.MULTILINE))

@pytest.fixture(scope="module")
def catalog_entries():
    assert CATALOG.exists(), "EdogErrorCodeCatalog.cs missing"
    src = CATALOG.read_text(encoding="utf-8")
    # Match quoted error code strings in catalog entries
    return set(re.findall(r'"((?:MLV|FMLV|FLT|DAG|DELTA)_\w+)"', src))

def test_every_flt_enum_has_catalog_entry(flt_enum_members, catalog_entries):
    """Every ErrorCode enum member must appear in the catalog."""
    # Normalize: FMLV_X and FLT_X are duplicates of MLV_X — only check MLV_ canonical form
    canonical = set()
    for m in flt_enum_members:
        if m.startswith("FMLV_"):
            canonical.add("MLV_" + m[5:])
        elif m.startswith("FLT_"):
            canonical.add("MLV_" + m[4:])
        else:
            canonical.add(m)
    missing = canonical - catalog_entries
    assert not missing, f"ErrorCode members missing from EdogErrorCodeCatalog: {sorted(missing)}"
```

- [ ] **Step 2: Run test — confirm it fails (catalog doesn't exist yet)**

```
cd C:\Users\guptahemant\newrepo\edog-studio
python -m pytest tests/test_error_code_catalog_completeness.py -v
```
Expected: FAIL — `EdogErrorCodeCatalog.cs missing`

- [ ] **Step 3: Create the catalog**

Create `src/backend/DevMode/EdogErrorCodeCatalog.cs` with a static class containing ALL 81 deduplicated error codes (after removing FMLV_/FLT_ duplicates). Each entry must include:
- `Code` — canonical MLV_ name (plus DELTA_TABLE_NOT_FOUND, DAG_EXECUTION_SKIPPED)
- `Phase` — CATALOG_RESOLVE / DAG_CONSTRUCTION / PRE_EXECUTION_VALIDATION / GTS_SUBMIT / GTS_POLL / NODE_EXECUTION / POST_EXECUTION / INGEST
- `Channel` — 1 (GTS_STATUS_FORGE) / 2 (GTS_SUBMIT_FORGE) / 3 (NODE_STATE_INJECTION) / 4 (EXCEPTION_INJECTION)
- `ErrorSource` — User / System (from `NodeExecutionUtils.DetermineErrorSource`)
- `Category` — auth / throttling / execution / resource / validation / concurrency / dag / ingest / pyspark / constraint / schema / system
- `NodeKinds` — which node types this applies to: `["sql","pyspark","ingest"]` or a subset
- `Description` — one-liner from ErrorRegistry
- `UserMessage` — the full message template from ErrorRegistry
- `HttpStatus` — for Channels 1+2: the HTTP status to forge (200 for Channel 1, 429/430/500 for Channel 2)
- `ResponseBodyTemplate` — for Channel 1: the GTS TransformExecutionResponse JSON template
- `FltCodePath` — which file:method handles this error in FLT (static, for blast radius display)

Structure as a `static readonly` array of `ErrorCodeEntry` records with a `GetByCode(string code)` lookup method.

For **Channel 1 (GTS Status Forge)** entries, the response body template is:
```json
{"id":"{{transformationId}}","state":"Failed","errorDetails":{"errorCode":"MLV_xxx","message":"{{message}}","errorSource":"{{errorSource}}"}}
```

For **Channel 2 (GTS Submit Forge)** entries, specify `HttpStatus` (429, 430, 500, 400).

For **Channel 3 (Node State Injection)** entries, no HTTP response needed — just the error code and message to set on `node.IsFaulted`.

For **Channel 4 (Exception)**, specify exception type (`TaskCanceledException`).

Also include a `GetCatalogJson()` method that serializes the catalog to JSON for the frontend.

- [ ] **Step 4: Run test — confirm it passes**

```
python -m pytest tests/test_error_code_catalog_completeness.py -v
```
Expected: PASS

- [ ] **Step 5: Build HTML to confirm no JS/CSS breakage**

```
python scripts/build-html.py
```

- [ ] **Step 6: Commit**

```
git add src/backend/DevMode/EdogErrorCodeCatalog.cs tests/test_error_code_catalog_completeness.py
git commit -m "feat(chaos): error code catalog — 81 FLT errors with phase, channel, injection recipe"
```

---

## Task 2: Wire up EdogNodeExecutorWrapper (C# patch)

**Files:**
- Modify: `src/backend/DevMode/EdogDagExecutionInterceptor.cs` (add AsyncLocal)
- Modify: `edog.py` (add `patch_node_executor_wrapper` + revert)
- Test: `tests/test_node_executor_wrapper_patch.py`

The `EdogNodeExecutorWrapper` at `EdogDagExecutionInterceptor.cs:140` exists but is dead code. FLT creates `new NodeExecutor(...)` directly at `DagExecutionHandlerV2.cs:1013`. We need a patch in `edog.py` that rewrites that line to wrap with our decorator, AND we need to add the `AsyncLocal` context to the wrapper.

- [ ] **Step 1: Write the patch test**

```python
# tests/test_node_executor_wrapper_patch.py
"""Structural test: EdogNodeExecutorWrapper must set/clear AsyncLocal context."""
import pathlib, re, pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
INTERCEPTOR = REPO / "src" / "backend" / "DevMode" / "EdogDagExecutionInterceptor.cs"

@pytest.fixture()
def source():
    return INTERCEPTOR.read_text(encoding="utf-8")

def test_async_local_declared(source):
    assert "AsyncLocal<EdogNodeExecutionContext>" in source or "AsyncLocal" in source, \
        "EdogNodeExecutorWrapper must declare AsyncLocal for per-node context"

def test_async_local_set_in_execute(source):
    # Find ExecuteNodeAsync body
    match = re.search(r"public\s+async\s+Task\s+ExecuteNodeAsync", source)
    assert match, "ExecuteNodeAsync not found"
    body_start = source.index("{", match.end())
    assert "EdogNodeExecutionContext" in source[body_start:body_start+500], \
        "ExecuteNodeAsync must set EdogNodeExecutionContext before calling _inner"

def test_async_local_cleared_in_finally(source):
    assert re.search(r"finally\s*\{[^}]*EdogNodeExecutionContext.*?null", source, re.DOTALL), \
        "ExecuteNodeAsync must clear EdogNodeExecutionContext in finally block"
```

- [ ] **Step 2: Run test — confirm it fails**

- [ ] **Step 3: Create `EdogNodeExecutionContext.cs`**

Create `src/backend/DevMode/EdogNodeExecutionContext.cs`:

```csharp
#nullable disable
#pragma warning disable
namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Threading;

    /// <summary>
    /// AsyncLocal context that identifies the currently-executing DAG node.
    /// Set by EdogNodeExecutorWrapper.ExecuteNodeAsync, read by EdogHttpPipelineHandler
    /// to scope fault injection rules to the correct node during parallel execution.
    /// </summary>
    internal sealed class EdogNodeExecutionContext
    {
        private static readonly AsyncLocal<EdogNodeExecutionContext> _current = new();

        public static EdogNodeExecutionContext Current
        {
            get => _current.Value;
            set => _current.Value = value;
        }

        public string NodeId { get; init; }
        public string NodeName { get; init; }
        public string DagId { get; init; }
        public Guid IterationId { get; init; }
    }
}
```

- [ ] **Step 4: Modify `EdogNodeExecutorWrapper.ExecuteNodeAsync` to set/clear AsyncLocal**

In `src/backend/DevMode/EdogDagExecutionInterceptor.cs`, modify `ExecuteNodeAsync()` (line 165):

```csharp
public async Task ExecuteNodeAsync(CancellationToken ct)
{
    EdogNodeExecutionContext.Current = new EdogNodeExecutionContext
    {
        NodeId = _nodeId,
        NodeName = _nodeId, // nodeId is the name in FLT's DAG model
        DagId = _dagId,
        IterationId = _iterationId,
    };

    PublishEvent(new { @event = "NodeStarted", nodeId = _nodeId, ... });

    var sw = Stopwatch.StartNew();
    try
    {
        await _inner.ExecuteNodeAsync(ct).ConfigureAwait(false);
        sw.Stop();
        PublishEvent(new { @event = "NodeCompleted", ... });
    }
    catch (Exception ex)
    {
        sw.Stop();
        PublishEvent(new { @event = "NodeFailed", ... });
        throw;
    }
    finally
    {
        EdogNodeExecutionContext.Current = null;
    }
}
```

- [ ] **Step 5: Add `patch_node_executor_wrapper` to `edog.py`**

Add a new patch function that targets `DagExecutionHandlerV2.cs`. The patch replaces:
```csharp
var nodeExecutor = new NodeExecutor(
    dagExecInstance, node, sparkClient, ...);
await nodeExecutor.ExecuteNodeAsync(cts.Token);
```
with:
```csharp
var nodeExecutor = new NodeExecutor(
    dagExecInstance, node, sparkClient, ...);
var wrappedExecutor = new Microsoft.LiveTable.Service.DevMode.EdogNodeExecutorWrapper(
    nodeExecutor, node.Name, dagExecInstance.Dag?.Name ?? "", metadata.OpId);
await wrappedExecutor.ExecuteNodeAsync(cts.Token);
```

Follow the exact same pattern as `patch_dag_execution_hook` in edog.py. Add the call in `apply_all_changes` and `revert_all_changes`.

- [ ] **Step 6: Run tests**

```
python -m pytest tests/test_node_executor_wrapper_patch.py -v
python -m pytest tests/ -x --tb=short -q
```

- [ ] **Step 7: Build HTML**

```
python scripts/build-html.py
```

- [ ] **Step 8: Commit**

```
git add -A
git commit -m "feat(chaos): wire up EdogNodeExecutorWrapper + AsyncLocal per-node context"
```

---

## Task 3: Extend Fault Store for Error Simulator Rules

**Files:**
- Modify: `src/backend/DevMode/EdogHttpFaultStore.cs`
- Modify: `src/backend/DevMode/EdogHttpPipelineHandler.cs`
- Test: `tests/test_error_sim_fault_store.py`

Extend the existing fault store to support node-scoped rules, mutable firing state, and Channel 1 (GTS status forge with custom response body).

- [ ] **Step 1: Write tests for node-scoped fault matching**

Test that:
- A rule with `NodeId = "silver.view_a"` only fires when `EdogNodeExecutionContext.Current.NodeId == "silver.view_a"`
- A rule with `NodeId = null` fires regardless of context (DAG-level)
- Mutable `FaultRuleState.Enabled` can be toggled without rebuilding the frozen snapshot
- A rule with `Fault = "gts_status_forge"` returns HTTP 200 with the configured `ResponseBody`

- [ ] **Step 2: Modify `HttpFaultEntry` — add fields**

Add to the existing `HttpFaultEntry` class:
- `public string NodeId { get; init; }` — null = fire for any node
- `public string RuleId { get; init; }` — unique ID for mutable state lookup
- `public string Channel { get; init; }` — "gts_status_forge", "gts_submit_forge", "node_state", "exception"

- [ ] **Step 3: Add `FaultRuleState` + `_ruleStates` dictionary**

```csharp
internal sealed class FaultRuleState
{
    public volatile bool Enabled = true;
    public int FireCount;
}

private static readonly ConcurrentDictionary<string, FaultRuleState> _ruleStates = new();
```

- [ ] **Step 4: Modify `TryMatchFault` to check AsyncLocal node context**

```csharp
public static bool TryMatchFault(string absoluteUri, out HttpFaultEntry match)
{
    match = null;
    var rules = _flatRules;
    if (rules.Length == 0) return false;

    var nodeCtx = EdogNodeExecutionContext.Current;
    string currentNodeId = nodeCtx?.NodeId;

    for (int i = 0; i < rules.Length; i++)
    {
        var rule = rules[i];

        // Node scoping: if rule targets a specific node, skip unless context matches
        if (rule.NodeId != null && (currentNodeId == null || !string.Equals(rule.NodeId, currentNodeId, StringComparison.OrdinalIgnoreCase)))
            continue;

        // URL matching (existing logic)
        if (absoluteUri.IndexOf(rule.TargetSubstring, StringComparison.OrdinalIgnoreCase) < 0)
            continue;

        // Mutable state: check enabled
        if (_ruleStates.TryGetValue(rule.RuleId, out var state) && !state.Enabled)
            continue;

        // Increment fire count
        if (state != null) Interlocked.Increment(ref state.FireCount);

        match = rule;
        return true;
    }
    return false;
}
```

- [ ] **Step 5: Modify `EdogHttpPipelineHandler` — support `gts_status_forge` fault type**

In `SendAsync`, after the existing `http_error` / `latency` / `timeout` handling, add:

```csharp
if (chaosFault != null
    && string.Equals(chaosFault.Fault, "gts_status_forge", StringComparison.OrdinalIgnoreCase))
{
    // Channel 1: Forge GTS status response (HTTP 200 + error body)
    var forgedResponse = new HttpResponseMessage(System.Net.HttpStatusCode.OK)
    {
        Content = new StringContent(
            chaosFault.ResponseBody ?? "{}",
            System.Text.Encoding.UTF8,
            "application/json"),
    };
    // Publish event so UI shows the injection
    PublishHttpEvent(method, url, statusCode: 200, ...chaosFault, synthesized: true);
    return forgedResponse;
}
```

- [ ] **Step 6: Run tests**

- [ ] **Step 7: Build HTML**

- [ ] **Step 8: Commit**

```
git commit -m "feat(chaos): extend fault store — node-scoped rules + GTS status forge channel"
```

---

## Task 4: Error Simulation Engine (C# orchestrator)

**Files:**
- Create: `src/backend/DevMode/EdogErrorSimEngine.cs`

The engine coordinates all 4 channels. It receives commands from SignalR (add/remove rules), translates error codes into fault store entries using the catalog, and handles Channel 3 (node state injection).

- [ ] **Step 1: Create `EdogErrorSimEngine.cs`**

Key methods:
- `AddRule(string nodeId, string errorCode)` — looks up catalog entry, creates appropriate fault rule in `EdogHttpFaultStore` or stores Channel 3 rule internally
- `RemoveRule(string ruleId)` — removes from fault store + internal state
- `ClearAll()` — removes all rules
- `GetActiveRules()` — returns current rules for frontend display
- `ApplyPreGtsFaults(Dag dag)` — for Channel 3: iterates active pre-GTS rules, sets `node.IsFaulted` via reflection on matching nodes
- `OnNodeTerminal(string nodeId)` — called when a node reaches terminal state, cleans up rules
- `ComputeBlastRadius(string ruleId, DagTopology topology)` — computes downstream impact

For Channel 3 (`ApplyPreGtsFaults`), use reflection to set `Node.IsFaulted`, `Node.FLTErrorCode`, `Node.ErrorMessage` (all have `internal set`):
```csharp
var prop = typeof(Node).GetProperty("IsFaulted", BindingFlags.Instance | BindingFlags.Public);
prop.SetValue(node, true);
```

- [ ] **Step 2: Commit**

```
git commit -m "feat(chaos): error simulation engine — 4-channel orchestrator"
```

---

## Task 5: Pre-GTS Fault Injection Patch (edog.py)

**Files:**
- Modify: `edog.py` (add `patch_error_sim_pre_gts_hook`)

This patch inserts a call to `EdogErrorSimEngine.ApplyPreGtsFaults(dag)` in `DagExecutionHandlerV2.cs` AFTER `CreateAndSaveDagForExecutionAsync` returns (line ~218) but BEFORE the faulted-node check at line 338.

- [ ] **Step 1: Write the patch function**

Target marker: after `dagExecInstance = await dagExecutionStore.GetDagExecutionInstanceAsync(dagExecutionContext, addToCacheIfMissing: true);` (line 217) and before `Dag dag = dagExecInstance.Dag;` (line 220).

Insert:
```csharp
// EDOG DevMode — Error Simulator: inject pre-GTS faults into DAG nodes
try { Microsoft.LiveTable.Service.DevMode.EdogErrorSimEngine.ApplyPreGtsFaults(dagExecInstance.Dag); }
catch { /* non-fatal — never block DAG execution */ }
```

Follow exact same pattern as `patch_dag_execution_hook`.

- [ ] **Step 2: Add revert function**

- [ ] **Step 3: Wire into `apply_all_changes` / `revert_all_changes`**

- [ ] **Step 4: Test edog.py parses**

```
python -c "import ast; ast.parse(open('edog.py', encoding='utf-8').read()); print('OK')"
```

- [ ] **Step 5: Commit**

```
git commit -m "feat(chaos): pre-GTS fault injection patch for DagExecutionHandlerV2"
```

---

## Task 6: SignalR Hub Methods

**Files:**
- Modify: `src/backend/DevMode/EdogPlaygroundHub.cs`
- Test: `tests/test_error_sim_signalr_contract.py`

Add hub methods for error simulator CRUD.

- [ ] **Step 1: Write contract test**

Structural test: `EdogPlaygroundHub.cs` must contain methods `ErrorSimAddRule`, `ErrorSimRemoveRule`, `ErrorSimClearAll`, `ErrorSimGetCatalog`, `ErrorSimGetActiveRules`.

- [ ] **Step 2: Add hub methods to `EdogPlaygroundHub.cs`**

- `ErrorSimGetCatalog()` → returns `EdogErrorCodeCatalog.GetCatalogJson()` — the full catalog for the frontend picker
- `ErrorSimAddRule(string nodeId, string nodeName, string nodeKind, string errorCode)` → calls `EdogErrorSimEngine.AddRule(...)`, returns rule object
- `ErrorSimRemoveRule(string ruleId)` → calls `EdogErrorSimEngine.RemoveRule(...)`
- `ErrorSimClearAll()` → calls `EdogErrorSimEngine.ClearAll()`
- `ErrorSimGetActiveRules()` → returns `EdogErrorSimEngine.GetActiveRules()`

- [ ] **Step 3: Run tests + build**

- [ ] **Step 4: Commit**

```
git commit -m "feat(chaos): SignalR hub methods for error simulator CRUD"
```

---

## Task 7: Frontend — Error Code Picker Modal

**Files:**
- Create: `src/frontend/js/error-sim.js`
- Create: `src/frontend/css/error-sim.css`
- Modify: `src/frontend/js/dag-graph.js` (add contextmenu event)
- Modify: `src/frontend/js/dag-studio.js` (wire up error-sim module)

- [ ] **Step 1: Add `contextmenu` event to `dag-graph.js`**

In `DagCanvasRenderer`, add `this.onNodeContextMenu = null` callback. In the node element creation (line ~240), add:
```javascript
el.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    if (self.onNodeContextMenu) self.onNodeContextMenu(nodeId, e.clientX, e.clientY);
});
```

- [ ] **Step 2: Create `error-sim.js` — ErrorSimulator class**

Module structure:
- `ErrorSimulator` class with `init(hub, dagStudio)` method
- `_catalog` — loaded from `hub.invoke('ErrorSimGetCatalog')` on init
- `_activeRules` — Map of ruleId → rule
- `showPicker(nodeId, nodeName, nodeKind, x, y)` — opens the error code picker modal at click position
- `_renderPicker(nodeId, nodeName, nodeKind)` — builds modal HTML with categorized, searchable error codes filtered by `nodeKind`
- `_onErrorCodeSelected(nodeId, errorCode)` — calls hub to add rule
- `_renderActiveRules()` — renders the injection rules panel below DAG
- `_renderBlastRadius(data)` — renders the post-execution blast radius drawer
- `getNodeBadge(nodeId)` — returns "⚡" badge HTML if node has active injection

Categories in picker (from catalog):
- Group by `category` field
- Filter by `nodeKinds` matching the selected node's `kind`
- Search filters on code name + description

- [ ] **Step 3: Create `error-sim.css`**

Follow design system tokens:
- Modal: 520px wide, `--surface` bg, `--radius-md` border, `--shadow-dialog` shadow
- Error entries: `--text-sm` code, `--text-xs` description, severity dot (user=`--level-warning`, system=`--status-failed`, transient=`--accent`)
- Active rules panel: table with `--surface-2` header
- Blast radius drawer: 440px slide-in from right, `--transition-normal`
- Node badge: `⚡` in `--status-failed` color with pulse animation

- [ ] **Step 4: Wire into `dag-studio.js`**

- Create `ErrorSimulator` instance in `DagStudio` constructor
- Set `this._dagGraph.onNodeContextMenu = (nodeId, x, y) => this._errorSim.showPicker(nodeId, ...)`
- Render active injections panel in the toolbar area
- On execution complete, check for blast radius data and render drawer
- Modify `_renderNode` or node badge rendering to show ⚡ for injected nodes

- [ ] **Step 5: Build and test**

```
python scripts/build-html.py
```

- [ ] **Step 6: Commit**

```
git commit -m "feat(chaos): error code picker UI + active injections panel + blast radius drawer"
```

---

## Task 8: Integration Test + Full Suite Validation

**Files:**
- Create: `tests/test_error_sim_integration.py`

- [ ] **Step 1: Write integration test**

Test the full flow:
- Create a rule via `EdogErrorSimEngine.AddRule("node_a", "MLV_TOO_MANY_REQUESTS")`
- Verify fault store has the rule with correct URL pattern and node scope
- Simulate `EdogNodeExecutionContext.Current = { NodeId = "node_a" }`
- Call `EdogHttpFaultStore.TryMatchFault` with a GTS URL → should match
- Clear context, call again → should NOT match
- Test Channel 3: create pre-GTS rule, call `ApplyPreGtsFaults` on a mock DAG node, verify `IsFaulted` set

- [ ] **Step 2: Run full test suite**

```
python -m pytest tests/ --tb=short -q
```
Verify no regressions.

- [ ] **Step 3: Build HTML**

```
python scripts/build-html.py
```

- [ ] **Step 4: Commit**

```
git commit -m "test(chaos): integration tests for error simulator engine"
```

---

## Task 9: Final Polish + Push

- [ ] **Step 1: Run linter**

```
python -m ruff check . --fix
```

- [ ] **Step 2: Run full test suite one final time**

```
python -m pytest tests/ -q
```

- [ ] **Step 3: Push**

```
git push
```

---

## Dependency Order

```
Task 1 (Catalog) ──────────────────────┐
Task 2 (NodeExecutor patch) ───────────┤
Task 3 (Fault Store extension) ────────┼──→ Task 4 (Engine) ──→ Task 5 (Pre-GTS patch)
                                       │                         ↓
                                       └──→ Task 6 (SignalR) ──→ Task 7 (Frontend)
                                                                  ↓
                                                           Task 8 (Integration)
                                                                  ↓
                                                           Task 9 (Polish)
```

Tasks 1, 2, 3 can be done in parallel. Task 4 depends on 1+2+3. Tasks 5+6 depend on 4. Task 7 depends on 6. Task 8 depends on all.
