# C01: Code Understanding Engine — P1 Component Deep Spec

> **Author:** Sana (Architecture & FLT Internals)
> **Date:** 2025-07-10
> **Status:** Draft
> **Parent:** F27 QA Testing — `docs/specs/features/F27-qa-testing/spec.md` §3
> **Depends on:** P0 Foundation (`research/p0-foundation.md`), Viability Analysis (`research/viability-analysis.md`)

---

## 1. Component Overview

The Code Understanding Engine is the intelligence core of F27. Given a PR diff, it produces three outputs:

1. **Stimulus suggestions** — which entry points trigger the changed code (reverse call-graph traversal)
2. **Expectation suggestions** — what should happen when that code runs correctly
3. **Impact zones** — clusters of affected code for scenario grouping

### Five-Layer Architecture

| Layer | Tool | Role | Latency | C# Depth |
|-------|------|------|---------|----------|
| L1 | code-review-graph (16K stars) | Structural blast radius via recursive SQL CTE BFS | <1s | Syntax only |
| L2 | Graphify (45K stars) | Knowledge graph with NetworkX, community detection | <2s | Syntax only |
| L3 | OmniSharp / Roslyn | Semantic enrichment — call hierarchy, find implementations, type resolution | 15-30s warm-up, <500ms per query after | Full semantic |
| L4 | GPT-5.4-pro | LLM reasoning over graph + semantic data | 5-10s per query | Reads + infers |
| L5 | Runtime DI Registry (`EdogDiRegistryCapture.cs`) | Ground truth for interface-to-implementation mappings | Instant (static snapshot) | Actual wiring |

### Master Data Flow

```
PR Diff (ADO REST API)
  |
  +---> L1: code-review-graph ---> structural edges (files, functions, direct calls)
  +---> L2: Graphify ------------> knowledge graph (communities, field refs, inheritance)
  |           |
  |           v
  |     Merged Structural Graph
  |           |
  |           v
  +---> L3: OmniSharp -----------> semantic enrichment (interface dispatch, call hierarchy)
  |           |
  |           v
  +---> L5: Runtime DI ----------> validate interface-to-impl mappings
  |           |
  |           v
  |     Validated Enriched Graph
  |           |
  |           v
  +---> L4: GPT-5.4-pro --------> reason over validated graph
              |
              +---> Stimulus suggestions
              +---> Expectation suggestions
              +---> Impact zone clusters
```

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C02: Scenario Curation UI** | Receives generated scenarios, stimulus suggestions, and impact zones for user review |
| **C03: Scenario Executor** | Consumes finalized scenarios (post-curation) with stimulus specs and expectation lists |
| **C04: Expectation Matcher** | Receives typed expectations with topic/matcher definitions to evaluate at runtime |
| **C05: PR Integration** | Provides diff input; receives scenario results for PR comment formatting |
| **C06: SignalR Protocol** | Engine progress events streamed to frontend via `QaAnalysisProgress` messages |

---

## 2. Scenarios

---

### S01: Graph Construction from PR Diff (L1 + L2)

**ID:** `C01-S01`
**One-liner:** Build a merged structural graph from the PR diff using code-review-graph and Graphify.

**Description:**
When the user provides a PR URL, the engine fetches the unified diff via the ADO REST API, then runs two parallel graph construction passes. L1 (code-review-graph) uses recursive SQL CTE BFS to trace direct call edges from every changed function, producing a file-level and function-level blast radius. L2 (Graphify) builds a NetworkX knowledge graph with community detection, field references, and inheritance edges. The two graphs are merged by node identity (file:method pairs) into a single structural graph with both direct-call and semantic-relationship edges.

**Technical Mechanism:**
```python
# Pseudocode: Graph construction pipeline
async def build_structural_graph(pr_diff: UnifiedDiff) -> MergedGraph:
    # Parse diff into changed symbols
    changed_symbols = parse_diff_to_symbols(pr_diff)
    # [file_path, method_name, change_type, lines_changed]

    # L1: code-review-graph — recursive SQL CTE BFS
    # Uses SQLite with CTE for transitive closure
    l1_future = asyncio.create_task(
        code_review_graph.trace_blast_radius(
            changed_symbols,
            max_depth=4,           # 4 levels of callers
            include_tests=True,    # include test files for coverage gap detection
        )
    )

    # L2: Graphify — NetworkX knowledge graph
    l2_future = asyncio.create_task(
        graphify.build_knowledge_graph(
            repo_path=FLT_SOLUTION_ROOT,
            changed_files=[s.file_path for s in changed_symbols],
            algorithms=["community_detection", "field_references", "inheritance"],
        )
    )

    l1_graph, l2_graph = await asyncio.gather(l1_future, l2_future)

    # Merge by node identity (file:method)
    merged = MergedGraph()
    merged.add_edges(l1_graph.edges, edge_type="direct_call")
    merged.add_edges(l2_graph.edges, edge_type="semantic_relationship")
    merged.communities = l2_graph.communities  # Louvain community clusters
    merged.mark_changed_nodes(changed_symbols)

    return merged
```

**Source Code Paths:**
- `src/backend/DevMode/EdogTopicRouter.cs:26-44` — topic initialization (graph events publish to a new `qa` topic)
- `src/backend/DevMode/EdogDiRegistryCapture.cs:33-107` — DI snapshot consumed as graph annotation
- `src/backend/DevMode/EdogDevModeRegistrar.cs:25-63` — registration point for graph engine startup

**Edge Cases:**
- **Empty diff:** PR has only config/documentation changes. Graph is empty. Engine skips to LLM with reduced context, generates config-validation scenarios only.
- **Massive diff (100+ files):** L2 community detection isolates high-impact clusters. Engine processes top-N communities (configurable, default 10) and flags remaining as "low-priority uncovered."
- **Binary files in diff:** Graph tools ignore non-parseable files. Engine logs a warning and continues with parseable subset.
- **Renamed files:** code-review-graph tracks renames via git diff `--find-renames`. Graphify needs explicit rename mapping to avoid duplicate nodes.
- **Circular dependencies:** BFS terminates at `max_depth=4`. Cycles detected via visited-set. Circular nodes flagged in graph metadata.

**Interactions:**
- **C02 (Curation UI):** Merged graph rendered as impact zone visualization for user context.
- **C05 (PR Integration):** Graph edge count and community count included in PR comment summary.

**Revert/Undo:**
Graph is ephemeral — computed per analysis run, stored in memory. No persistent state to revert. Re-running analysis regenerates the graph from scratch.

**Priority:** P0 — Foundation for all downstream analysis. Nothing works without the graph.

---

### S02: Semantic Enrichment via OmniSharp (L3)

**ID:** `C01-S02`
**One-liner:** Enrich the structural graph with Roslyn semantic data: call hierarchy, interface implementations, type resolution.

**Description:**
After the merged structural graph is built, L3 (OmniSharp/Roslyn) adds semantic edges that L1 and L2 cannot compute. This includes resolving interface dispatch (which concrete class implements `IRetryPolicy`?), tracing virtual/abstract override chains, resolving generic type parameters, and finding LINQ expression trees that reference changed types. OmniSharp runs as an LSP server against the FLT `.sln` file, using standard LSP protocol requests. The warm-up cost (15-30s) is amortized by pre-warming when Connected phase starts.

**Technical Mechanism:**
```json
{
  "lsp_queries_per_changed_symbol": [
    {
      "method": "callHierarchy/incomingCalls",
      "purpose": "Find all callers of this method (reverse call graph)",
      "max_depth": 4,
      "note": "Resolves through interface dispatch — if method is on IFoo, finds callers of all IFoo implementations"
    },
    {
      "method": "callHierarchy/outgoingCalls",
      "purpose": "What does this method call? (forward call graph for expectation generation)",
      "max_depth": 2
    },
    {
      "method": "textDocument/implementation",
      "purpose": "Which classes implement this interface?",
      "when": "changed_symbol is interface member or abstract method"
    },
    {
      "method": "textDocument/references",
      "purpose": "All usages of this symbol across the solution",
      "when": "changed_symbol is a public type or constant"
    },
    {
      "method": "textDocument/definition",
      "purpose": "Resolve a symbol to its definition (for type information)",
      "when": "graph edge target is unresolved"
    }
  ],
  "omnisharp_config": {
    "solution_path": "workload-fabriclivetable.sln",
    "launch_mode": "background_process",
    "protocol": "lsp_over_stdio",
    "warm_up_trigger": "connected_phase_start",
    "timeout_per_query_ms": 5000,
    "max_concurrent_queries": 4
  }
}
```

**Source Code Paths:**
- `src/backend/DevMode/EdogDevModeRegistrar.cs:25-63` — `RegisterAll()` is the hook point for OmniSharp pre-warm on Connected phase start
- `src/backend/DevMode/EdogDiRegistryCapture.cs:149-160` — `IsEdogIntercepted()` switch map provides known interface-to-wrapper mappings that supplement Roslyn results
- `src/backend/DevMode/TopicEvent.cs:17-30` — enrichment results published as `TopicEvent` on the `qa` topic for progress tracking

**Edge Cases:**
- **OmniSharp fails to start:** Solution file not found, or Roslyn crashes on malformed code. Fallback: engine continues with L1+L2 structural graph only. Quality degrades (~70-80% accuracy vs ~95%). UI shows warning: "Semantic analysis unavailable — results may have reduced accuracy."
- **OmniSharp warm-up exceeds 60s:** Timeout. Engine proceeds without semantic enrichment. Log event published. User can retry manually.
- **Partial solution load:** Some projects in `.sln` fail to compile. OmniSharp still provides partial results for loadable projects. Engine tracks which files have semantic coverage and which don't.
- **Extension methods:** Roslyn resolves extension method calls via `textDocument/references` on the static class. Engine must follow the `this` parameter type to find the real target.
- **Generic type resolution:** `IRepository<T>` may have multiple implementations. Roslyn's `textDocument/implementation` returns all. Engine uses L5 (DI registry) to disambiguate which one is actually wired.
- **LINQ expressions:** `callHierarchy` may not trace through LINQ lambda bodies. Engine falls back to `textDocument/references` for types used inside LINQ expressions.

**Interactions:**
- **C01-S01 (Graph Construction):** Consumes merged structural graph, adds semantic edges.
- **C01-S05 (DI Registry):** Uses DI mappings to disambiguate interface implementations found by Roslyn.
- **C01-S03 (Reverse Call-Graph):** Semantic edges enable accurate reverse traversal through interfaces.

**Revert/Undo:**
Enrichment is additive — original structural edges preserved. Semantic edges tagged with `source: "roslyn"` and can be filtered out to revert to structural-only analysis.

**Priority:** P0 — Required for accurate interface resolution. Without L3, engine can't trace through DI-injected call paths.

---

### S03: Reverse Call-Graph Traversal (Finding Entry Points)

**ID:** `C01-S03`
**One-liner:** Traverse the enriched graph upward from changed code to find API entry points that trigger it.

**Description:**
Given a changed method deep in the call stack, this scenario traces callers upward through the enriched graph (structural + semantic edges) to find top-level entry points: API controllers, SignalR hub methods, DAG trigger endpoints, file event handlers, and timer-based schedulers. Each discovered entry point is classified by stimulus type (`http_request`, `signalr_invoke`, `dag_trigger`, `file_event`, `timer_tick`, `direct_invoke`). When multiple entry points exist, the engine ranks them by directness (shortest path = most direct stimulus) and coverage (which entry point exercises the most changed code).

**Technical Mechanism:**
```python
# Pseudocode: Reverse call-graph BFS
def find_entry_points(graph: EnrichedGraph, changed_node: str) -> list[EntryPoint]:
    visited = set()
    queue = deque([(changed_node, 0, [changed_node])])  # (node, depth, path)
    entry_points = []

    while queue:
        node, depth, path = queue.popleft()
        if depth > 4:
            continue
        if node in visited:
            continue
        visited.add(node)

        # Check if this node is an entry point
        stimulus_type = classify_entry_point(node)
        if stimulus_type:
            entry_points.append(EntryPoint(
                node=node,
                stimulus_type=stimulus_type,
                depth=depth,
                path=path,
                directness_score=1.0 / (depth + 1),
            ))
            continue  # Don't traverse above entry points

        # Traverse all incoming edges (callers)
        for caller in graph.incoming_edges(node):
            queue.append((caller, depth + 1, path + [caller]))

    # Rank by directness and coverage
    return sorted(entry_points, key=lambda e: e.directness_score, reverse=True)

def classify_entry_point(node: str) -> str | None:
    """Classify a graph node as a stimulus entry point."""
    if node.matches("*Controller.*") and has_http_attribute(node):
        return "http_request"
    if node.matches("*Hub.*") and has_hubmethod_attribute(node):
        return "signalr_invoke"
    if node.matches("*DagController.RunDAG*"):
        return "dag_trigger"
    if node.matches("*IFileSystemWatcher.*"):
        return "file_event"
    if node.matches("*IHostedService.*") or node.matches("*Timer*Callback*"):
        return "timer_tick"
    return None  # Not an entry point — keep traversing
```

**Source Code Paths:**
- `src/backend/DevMode/EdogDagExecutionInterceptor.cs:31-132` — `EdogDagExecutionHook` identifies DAG entry points (`ExecuteAsync` at line 43)
- `src/backend/DevMode/EdogHttpPipelineHandler.cs:46-87` — `SendAsync` captures HTTP entry point evidence (method, URL, correlation)
- `src/backend/DevMode/EdogFltOpsInterceptor.cs:55-168` — `EdogRefreshTriggersWrapper` identifies refresh trigger entry points

**Edge Cases:**
- **No entry point found within depth 4:** Changed code is deeply internal (utility, helper). Engine flags as `direct_invoke` stimulus — resolve service from DI and call method directly.
- **Multiple paths to same entry point:** Deduplicate by entry point identity, keep shortest path.
- **Conditional reachability:** Code inside `catch` blocks, `if (featureFlag)` branches, or retry handlers. Engine annotates path with conditions. LLM (L4) generates setup steps to reach the conditional path (e.g., inject fault for catch-block code, override flag for gated code).
- **Async/await chains:** Roslyn's call hierarchy follows `async` continuations. Engine must handle `Task<T>` unwrapping and `ConfigureAwait(false)` elision.
- **Event-driven invocation:** Code triggered by pub/sub events (not direct method calls). L2 (Graphify) field-reference edges may capture event handler registrations. Falls back to LLM reasoning if graph can't trace.

**Interactions:**
- **C01-S07 (Stimulus Generation):** Entry points are the primary input for stimulus generation.
- **C01-S09 (Impact Zone Clustering):** Entry points define the "top" of each impact zone.
- **C02 (Curation UI):** Entry points displayed with call-path visualization for user validation.

**Revert/Undo:**
Traversal results are computed, not persisted. Re-run analysis to regenerate.

**Priority:** P0 — Without entry points, the engine cannot generate stimuli. Core algorithm.

---

### S04: Interface Resolution (Which Impl for Which Interface)

**ID:** `C01-S04`
**One-liner:** Resolve which concrete implementation backs each interface in the changed code's call path.

**Description:**
C# code heavily uses interfaces for DI injection. When the graph shows `SomeService` calls `IRetryPolicy.Execute()`, the engine must determine which concrete class implements `IRetryPolicy` in the running FLT process. This uses a three-tier resolution strategy: (1) L5 Runtime DI Registry provides ground truth for registered services, (2) L3 Roslyn provides all possible implementations via `textDocument/implementation`, (3) L1+L2 structural analysis provides fallback heuristics (same-namespace, naming convention). The resolved implementation determines which code path the stimulus will actually exercise.

**Technical Mechanism:**
```python
# Pseudocode: Three-tier interface resolution
def resolve_interface(
    interface_type: str,
    di_registry: DiSnapshot,
    roslyn: OmniSharpClient,
    graph: MergedGraph,
) -> InterfaceResolution:

    # Tier 1: Runtime DI Registry (ground truth)
    di_mapping = di_registry.get(interface_type)
    if di_mapping:
        return InterfaceResolution(
            interface=interface_type,
            implementation=di_mapping.implementation_type,
            source="runtime_di",
            confidence=1.0,
            lifetime=di_mapping.lifetime,  # Singleton, Scoped, Transient
            is_edog_intercepted=di_mapping.is_edog_intercepted,
        )

    # Tier 2: Roslyn — find all implementations
    implementations = roslyn.find_implementations(interface_type)
    if len(implementations) == 1:
        return InterfaceResolution(
            interface=interface_type,
            implementation=implementations[0],
            source="roslyn_unique",
            confidence=0.95,
        )
    elif len(implementations) > 1:
        # Multiple impls — try to disambiguate via naming convention
        likely = [i for i in implementations if not i.startswith("Mock") and not i.startswith("Test")]
        if len(likely) == 1:
            return InterfaceResolution(
                interface=interface_type,
                implementation=likely[0],
                source="roslyn_filtered",
                confidence=0.8,
            )
        # Can't disambiguate — return all candidates
        return InterfaceResolution(
            interface=interface_type,
            implementation=likely[0] if likely else implementations[0],
            source="roslyn_ambiguous",
            confidence=0.5,
            alternatives=implementations,
        )

    # Tier 3: Structural fallback
    return InterfaceResolution(
        interface=interface_type,
        implementation=None,
        source="unresolved",
        confidence=0.0,
    )
```

**Source Code Paths:**
- `src/backend/DevMode/EdogDiRegistryCapture.cs:33-107` — `CaptureRegistrations()` publishes all known DI registrations to the `di` topic with `serviceType`, `implementationType`, `lifetime`, `isEdogIntercepted`, `originalImplementation` fields
- `src/backend/DevMode/EdogDiRegistryCapture.cs:149-160` — `IsEdogIntercepted()` switch map: `IFeatureFlighter`, `ISqlEndpointMetadataCache`, `ISparkClientFactory`, `ICustomLiveTableTelemetryReporter`, `IWorkloadResourceMetricsReporter`
- `src/backend/DevMode/EdogDiRegistryCapture.cs:165-175` — `GetEdogWrapperName()` maps interface types to EDOG wrapper class names
- `src/backend/DevMode/EdogTopicRouter.cs:73-94` — `Publish("di", ...)` publishes DI registration events at line 126 of `EdogDiRegistryCapture.cs`

**Edge Cases:**
- **Interface not in DI registry:** `EdogDiRegistryCapture` only captures a static subset of registrations (hardcoded list from `WorkloadApp.cs`). Unknown interfaces fall to Tier 2 (Roslyn). P0 foundation notes this as a gap: "Static hardcoded service list — can drift from reality."
- **EDOG-intercepted service:** When `isEdogIntercepted=true`, the actual runtime type is the EDOG wrapper (e.g., `EdogFeatureFlighterWrapper`), not the original implementation. Engine must trace through the wrapper to the inner delegate for call-graph accuracy.
- **Open generics:** `IRepository<T>` resolved differently for `IRepository<User>` vs `IRepository<Order>`. Roslyn can resolve closed generic types; DI registry captures open registrations. Engine must match generic arguments.
- **Conditional registration:** Some services registered inside `if (IsDevMode)` blocks. Runtime DI snapshot reflects the actual Connected-phase registrations, which includes DevMode overrides.
- **Decorator pattern:** `IRetryPolicy` might be wrapped by `LoggingRetryPolicy` wrapping `ExponentialRetryPolicy`. DI registry shows only the outermost registration. Roslyn can trace the chain via constructor injection analysis.

**Interactions:**
- **C01-S02 (OmniSharp):** Roslyn provides the implementation candidates that DI registry disambiguates.
- **C01-S03 (Reverse Call-Graph):** Resolved interfaces enable accurate traversal through DI-injected call paths.
- **C01-S06 (LLM Prompt):** Resolution confidence scores inform LLM about certainty of each graph edge.

**Revert/Undo:**
Resolution results are ephemeral graph annotations. No persistent state.

**Priority:** P0 — Interface resolution is the primary differentiator between ~70% and ~95% accuracy.

---

### S05: DI Registry Integration (L5 Validation)

**ID:** `C01-S05`
**One-liner:** Use the runtime DI registry snapshot as ground truth to validate and supplement graph edges.

**Description:**
The `EdogDiRegistryCapture` component publishes a snapshot of all known DI registrations to the `di` topic when `RegisterAll()` runs during Connected phase startup. The Code Understanding Engine consumes this snapshot to: (a) validate that Roslyn-inferred interface-to-impl mappings match actual runtime wiring, (b) discover EDOG-intercepted services (which add observation points), (c) identify registration lifetime (Singleton/Scoped/Transient) which affects stateful behavior in scenarios, and (d) detect services registered in the "Constructor" vs "PostResolve" phase, which affects initialization ordering.

**Technical Mechanism:**
```python
# Pseudocode: DI registry consumption
class DiRegistryClient:
    def __init__(self, topic_router):
        self.snapshot = {}

    def load_from_topic(self):
        """Read DI registration events from the 'di' topic buffer."""
        buffer = topic_router.get_buffer("di")
        if not buffer:
            return  # DI capture not yet run

        for event in buffer.get_snapshot():
            reg = event.data
            self.snapshot[reg["serviceType"]] = DiRegistration(
                service_type=reg["serviceType"],
                implementation_type=reg["implementationType"],
                lifetime=reg["lifetime"],
                is_edog_intercepted=reg["isEdogIntercepted"],
                original_implementation=reg["originalImplementation"],
                registration_phase=reg["registrationPhase"],
            )

    def validate_graph_edge(self, interface: str, inferred_impl: str) -> ValidationResult:
        """Check if a Roslyn-inferred mapping matches runtime reality."""
        reg = self.snapshot.get(interface)
        if not reg:
            return ValidationResult(status="unregistered", confidence_delta=0)
        if reg.original_implementation == inferred_impl:
            return ValidationResult(status="confirmed", confidence_delta=+0.3)
        else:
            return ValidationResult(
                status="conflict",
                confidence_delta=-0.4,
                actual=reg.implementation_type,
                note=f"Roslyn says {inferred_impl}, DI says {reg.implementation_type}",
            )
```

**Source Code Paths:**
- `src/backend/DevMode/EdogDiRegistryCapture.cs:33-107` — `CaptureRegistrations()` iterates all known registrations and publishes each to the `di` topic
- `src/backend/DevMode/EdogDiRegistryCapture.cs:113-143` — `PublishRegistration()` constructs the event payload: `serviceType`, `implementationType`, `lifetime`, `isEdogIntercepted`, `originalImplementation`, `registrationPhase`
- `src/backend/DevMode/EdogTopicRouter.cs:60-65` — `GetBuffer("di")` retrieves the DI topic buffer for snapshot reading
- `src/backend/DevMode/TopicEvent.cs:17-30` — DI events wrapped in standard `TopicEvent` envelope with `SequenceId`, `Timestamp`, `Topic`, `Data`
- `src/backend/DevMode/EdogDevModeRegistrar.cs:44` — `RegisterDiRegistryCapture()` call in `RegisterAll()` triggers the capture

**Edge Cases:**
- **DI capture not yet run:** Connected phase hasn't started. Engine operates without L5 validation (Disconnected phase). All interface resolutions marked as "unvalidated."
- **Registry drift:** New services added to `WorkloadApp.cs` but not to `EdogDiRegistryCapture`'s hardcoded list. P0 foundation identifies this gap. Mitigation: engine logs unresolved interfaces and suggests updating the capture list.
- **EDOG wrapper masking:** For intercepted services (e.g., `IFeatureFlighter` → `EdogFeatureFlighterWrapper`), the engine must record both the wrapper (for observation coverage) and the original impl (for call-graph traversal).
- **Transient vs Singleton lifetime:** Affects stateful scenario expectations. A Singleton service retains state across scenarios; Transient gets fresh instances. Engine annotates expectations with lifetime-aware notes.
- **Topic buffer overflow:** The `di` topic has a ring buffer of 100 entries. With ~35 known registrations (from source audit), overflow is unlikely. But if registrations are re-captured (idempotent call), older events evict.

**Interactions:**
- **C01-S04 (Interface Resolution):** DI registry is Tier 1 (highest confidence) in the resolution strategy.
- **C01-S06 (LLM Prompt):** DI registration data included in LLM context as "ground truth wiring."
- **C03 (Scenario Executor):** Lifetime information influences scenario isolation strategy.

**Revert/Undo:**
Read-only consumption of existing DI snapshot. No mutation. No revert needed.

**Priority:** P0 — Ground truth for interface-to-impl resolution. Required for Connected phase accuracy.

---

### S06: LLM Prompt Composition (Feeding Graph Data to GPT-5.4-pro)

**ID:** `C01-S06`
**One-liner:** Compose structured prompts that feed enriched graph data to GPT-5.4-pro for scenario reasoning.

**Description:**
The LLM receives a carefully structured prompt containing: the PR diff, the enriched call graph (structural + semantic edges), interface resolution results with confidence scores, DI registration metadata, interceptor topic schemas (what's observable), the scenario JSON schema (output format), and contextual data from Graphify (historical bugs, coverage gaps, failure patterns). The prompt is composed per impact zone to stay within token budgets (~8K input, ~4K output). For large PRs with multiple impact zones, the engine makes parallel LLM calls.

**Technical Mechanism:**
```python
# Pseudocode: LLM prompt composition
def compose_prompt(
    zone: ImpactZone,
    diff: str,
    graph: EnrichedGraph,
    di_registry: DiSnapshot,
    graphify_context: GraphifyContext,
    interceptor_schema: dict,
    scenario_schema: dict,
) -> LLMPrompt:

    system_prompt = """
You are a senior QA engineer analyzing a code change in FabricLiveTable.
You have access to the following interceptor topics that capture events in real-time:
{interceptor_schema}

For each impact zone, generate test scenarios that verify the change works correctly.
Each scenario must have:
1. A clear STIMULUS (what triggers the behavior)
2. Explicit EXPECTATIONS (what interceptor events should appear)
3. Category (happy_path | error_path | edge_case | regression | performance)

Rules:
- Expectations must reference OBSERVABLE events (interceptor topics only)
- Every expectation must be binary verifiable (matched or not matched)
- Include timing constraints only when behavior is time-sensitive
- Generate absence assertions for error paths ("this error log should NOT appear")
- Reference the specific code change to justify why this scenario matters
- If the change affects retry logic, include a chaos scenario (inject failure -> verify retry)
- For interface-resolved calls with confidence < 0.8, add a NOTE to the scenario
"""

    user_content = f"""
## PR Diff (Impact Zone: {zone.id})
```diff
{truncate(diff, zone.relevant_files, max_tokens=3000)}
```

## Call Graph (depth 4 from changed code)
{format_graph_as_mermaid(graph, zone, max_nodes=50)}

## Interface Resolutions
{format_resolutions(zone.interface_resolutions)}

## DI Registrations (relevant)
{format_di_registrations(di_registry, zone.affected_services)}

## Historical Context (from Graphify)
- Community: {graphify_context.community}
- Recent bugs: {graphify_context.historical_bugs[:3]}
- Coverage gaps: {graphify_context.coverage_gaps[:5]}
- Known failure patterns: {graphify_context.failure_patterns[:3]}

## Output Format
Return a JSON array of Scenario objects matching this schema:
{scenario_schema}
"""

    return LLMPrompt(
        model="gpt-5.4-pro",
        system=system_prompt.format(interceptor_schema=interceptor_schema),
        user=user_content,
        temperature=0.3,      # Low temperature for deterministic output
        max_tokens=4096,
        response_format="json",
    )
```

**Source Code Paths:**
- `src/backend/DevMode/EdogTopicRouter.cs:26-44` — `Initialize()` registers all 16 topic names that map to the `Expectation.topic` enum in the scenario JSON schema (spec §4, line 392)
- `src/backend/DevMode/EdogDiRegistryCapture.cs:126-134` — DI registration event payload structure used in prompt's "DI Registrations" section
- `src/backend/DevMode/EdogHttpPipelineHandler.cs:67-78` — HTTP event payload fields used in the interceptor schema section of the prompt
- `src/backend/DevMode/EdogRetryInterceptor.cs:186-200` — Retry event payload fields used for chaos scenario generation prompting
- `src/backend/DevMode/EdogDagExecutionInterceptor.cs:92-107` — DAG terminal event fields used for DAG-related scenario prompting

**Edge Cases:**
- **Token budget exceeded:** Large impact zones with deep call graphs. Mitigation: truncate graph to highest-impact nodes (degree centrality), summarize instead of listing all edges. Max 50 nodes per zone in the prompt.
- **LLM returns invalid JSON:** Parse error on response. Retry once with explicit "Return ONLY valid JSON" instruction appended. If still fails, return empty scenario list with error flag.
- **LLM hallucinates non-existent interceptor topics:** Response references a topic not in the schema. Post-processing validation strips invalid scenarios and logs the hallucination.
- **LLM generates scenarios for unchanged code:** Relevance filter checks that every scenario references at least one changed file/method. Irrelevant scenarios flagged with low confidence.
- **Rate limiting:** GPT-5.4-pro may throttle concurrent requests. Engine queues with exponential backoff and max 3 retries per zone.
- **Prompt injection via diff content:** PR diff could contain adversarial text. Mitigation: diff content is wrapped in code fences and the system prompt establishes role firmly. No user-controllable instructions.

**Interactions:**
- **C01-S07 (Stimulus Generation):** LLM output includes stimulus specifications per scenario.
- **C01-S08 (Expectation Generation):** LLM output includes typed expectations per scenario.
- **C01-S09 (Impact Zones):** LLM groups scenarios by impact zone, feeding clustering.
- **C02 (Curation UI):** Generated scenarios streamed to UI as they arrive (SSE pattern).

**Revert/Undo:**
LLM calls are idempotent (same input → similar output with low temperature). Re-running regenerates. Previous results can be cached by input hash for comparison.

**Priority:** P0 — The LLM is the reasoning layer that converts graph data into actionable scenarios.

---

### S07: Stimulus Generation Pipeline

**ID:** `C01-S07`
**One-liner:** Transform entry points into executable stimulus specifications with HTTP method, URL, headers, and body.

**Description:**
For each entry point discovered by reverse call-graph traversal (S03), the engine generates a complete stimulus specification that the Scenario Executor (C03) can fire. This includes: (a) determining the HTTP method and URL pattern from controller attributes, (b) inferring required request body from action parameters, (c) generating valid test data from parameter types and constraints, (d) adding authentication headers from the token interceptor context, and (e) handling non-HTTP stimuli (SignalR invocations, DAG triggers, file events). The LLM (L4) is used for complex parameter inference where static analysis alone can't determine valid values.

**Technical Mechanism:**
```python
# Pseudocode: Stimulus generation
def generate_stimulus(entry_point: EntryPoint, graph: EnrichedGraph) -> Stimulus:
    if entry_point.stimulus_type == "http_request":
        # Extract from controller attributes
        route = extract_route_attribute(entry_point.node)  # [HttpPost("api/v1/runDAG/{id}")]
        method = extract_http_method(entry_point.node)      # POST
        params = extract_action_parameters(entry_point.node) # (Guid id, RunDagRequest body)

        return Stimulus(
            type="http_request",
            http_request={
                "method": method,
                "path": route,
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer {test_token}",
                },
                "body": generate_test_body(params),
            },
        )

    elif entry_point.stimulus_type == "dag_trigger":
        return Stimulus(
            type="dag_trigger",
            dag_trigger={
                "iterationId": "{current_iteration_id}",
                "nodeFilter": extract_relevant_nodes(entry_point, graph),
            },
        )

    elif entry_point.stimulus_type == "signalr_invoke":
        hub_method = extract_hub_method(entry_point.node)
        return Stimulus(
            type="signalr_invoke",
            signalr_invoke={
                "hub": "/hub/playground",
                "method": hub_method,
                "args": generate_test_args(entry_point.parameters),
            },
        )

    elif entry_point.stimulus_type == "file_event":
        watched_path = extract_watched_path(entry_point.node)
        return Stimulus(
            type="file_event",
            file_event={
                "path": watched_path,
                "operation": "write",
                "content": generate_test_file_content(entry_point),
            },
        )

    elif entry_point.stimulus_type == "direct_invoke":
        # No entry point — resolve from DI and call directly
        return Stimulus(
            type="direct_invoke",
            direct_invoke={
                "service_type": entry_point.nearest_interface,
                "method": entry_point.node.method_name,
                "args": generate_test_args(entry_point.parameters),
            },
        )
```

**Source Code Paths:**
- `src/backend/DevMode/EdogHttpPipelineHandler.cs:46-87` — HTTP stimulus delivery mirrors the captured HTTP pattern (method, URL, headers, body)
- `src/backend/DevMode/EdogDagExecutionInterceptor.cs:43-116` — DAG trigger stimulus maps to `ExecuteAsync` entry point on `EdogDagExecutionHook`
- `src/backend/DevMode/EdogFltOpsInterceptor.cs:55-168` — FLT operation stimuli map to wrapped service methods

**Edge Cases:**
- **Route parameter placeholders:** `{id}` in route templates need valid GUIDs. Engine generates random GUIDs or uses test fixtures.
- **Complex request bodies:** Deeply nested DTOs with validation attributes. LLM generates valid test data respecting `[Required]`, `[MaxLength]`, etc.
- **Authentication requirements:** Different endpoints may require different token scopes. Engine uses token interceptor data to infer required auth context.
- **Stimulus for catch-block code:** Changed code only reachable via exception paths. Stimulus includes setup step: F24 chaos rule to inject the required fault. Paired with `direct_invoke` fallback if no natural HTTP entry point.
- **No viable stimulus:** Code has no reachable entry point (dead code, unused utility). Engine flags scenario as "manual verification required" with `direct_invoke` as best-effort.

**Interactions:**
- **C01-S03 (Reverse Call-Graph):** Entry points are the input to stimulus generation.
- **C03 (Scenario Executor):** Consumes the `Stimulus` object and fires it against the live FLT process.
- **C02 (Curation UI):** User can edit stimulus parameters (URL, body, headers) before execution.

**Revert/Undo:**
Stimulus specs are generated, not executed here. No side effects. Re-generation replaces previous specs.

**Priority:** P0 — Without stimuli, scenarios cannot be executed.

---

### S08: Expectation Generation Pipeline

**ID:** `C01-S08`
**One-liner:** Generate typed expectations that verify code correctness by predicting observable interceptor events.

**Description:**
For each scenario, the engine generates expectations: typed assertions against interceptor topic events that will appear (or must NOT appear) when the stimulus runs. The LLM reads the changed code, understands what it SHOULD do, and formulates expectations referencing specific interceptor topics and event fields. Expectations fall into eight categories: structural (event present), value (field equals/contains/regex), count (N occurrences), sequence (ordered events), timing (duration bounds), return (method result), absence (event NOT present), and state (before/after comparison). Each expectation references a concrete topic from `EdogTopicRouter.Initialize()`.

**Technical Mechanism:**
```json
{
  "expectation_categories": {
    "structural": {
      "type": "event_present",
      "example": "HTTP interceptor captured a POST to /api/v1/runDAG",
      "topic": "http",
      "matcher": {"field_contains": {"field": "url", "value": "/runDAG"}}
    },
    "value": {
      "type": "field_match",
      "example": "HTTP status code is 200",
      "topic": "http",
      "matcher": {"field_equals": {"field": "statusCode", "value": 200}}
    },
    "count": {
      "type": "event_count",
      "example": "Exactly 3 retry events on 429 status",
      "topic": "retry",
      "count": {"exact": 3},
      "matcher": {"field_equals": {"field": "statusCode", "value": 429}}
    },
    "sequence": {
      "type": "event_order",
      "example": "DI resolution before HTTP call before SQL query",
      "ordered_expectations": ["exp-01", "exp-02", "exp-03"]
    },
    "timing": {
      "type": "timing",
      "example": "Total execution under 5000ms",
      "topic": "perf",
      "timeWindow": {"withinMs": 5000}
    },
    "absence": {
      "type": "event_absent",
      "example": "No error events in log topic with Level=Error",
      "topic": "log",
      "matcher": {"field_equals": {"field": "Level", "value": "Error"}}
    },
    "return_value": {
      "type": "field_match",
      "example": "GetStatus() returned Completed",
      "topic": "flt-ops",
      "matcher": {"field_equals": {"field": "success", "value": true}}
    },
    "state": {
      "type": "event_present",
      "example": "Cache updated after write operation",
      "topic": "cache",
      "matcher": {"field_equals": {"field": "operation", "value": "Set"}},
      "order": {"after": "exp-write-file"}
    }
  },
  "valid_topics": [
    "http", "token", "flag", "perf", "spark", "log",
    "telemetry", "retry", "cache", "fileop", "catalog",
    "dag", "flt-ops", "nexus", "di", "capacity"
  ]
}
```

**Source Code Paths:**
- `src/backend/DevMode/EdogTopicRouter.cs:26-44` — `Initialize()` defines the 16 valid topic names that expectations can reference
- `src/backend/DevMode/EdogRetryInterceptor.cs:186-200` — Retry event fields used for count-based expectations (`retryAttempt`, `totalAttempts`, `waitDurationMs`)
- `src/backend/DevMode/EdogCacheInterceptor.cs:46-56` — Cache event fields used for state expectations (`operation`, `hitOrMiss`, `key`)
- `src/backend/DevMode/EdogFileSystemInterceptor.cs:252-262` — File operation fields used for structural/value expectations (`operation`, `path`, `contentSizeBytes`)
- `src/backend/DevMode/EdogDagExecutionInterceptor.cs:167-207` — DAG node lifecycle fields used for sequence expectations (`@event`, `nodeId`, `status`)

**Edge Cases:**
- **Return value not captured:** P0 foundation identifies the return value gap (viability-analysis.md §3). Until `ReturnValue` and `ReturnType` fields are added to interceptor events, return-value expectations are limited to what's inferable from side effects.
- **Non-deterministic timing:** Performance expectations with tight bounds may flake on slow machines. Engine generates timing expectations with 2x safety margin and marks them as `category: "performance"` for separate failure treatment.
- **Log message format changes:** Regex-based log expectations are brittle. Engine prefers `field_contains` over `field_regex` where possible. Log expectations marked with confidence 0.7.
- **Topic not intercepted:** Changed code calls a service not wrapped by any interceptor (gap identified in P0: Spark usage post-creation, orchestrator calls). Engine flags as "unobservable" and generates structural expectations only.

**Interactions:**
- **C04 (Expectation Matcher):** Consumes typed `Expectation` objects and evaluates them against live topic events.
- **C01-S06 (LLM Prompt):** LLM generates expectations as part of scenario JSON output.
- **C02 (Curation UI):** User can add/edit/remove expectations per scenario.

**Revert/Undo:**
Generated expectations are data, not executed assertions. No side effects until scenario execution (C03).

**Priority:** P0 — Expectations define what "correct" means. Without them, tests have no assertions.

---

### S09: Impact Zone Clustering

**ID:** `C01-S09`
**One-liner:** Cluster affected code into logical impact zones using community detection and semantic proximity.

**Description:**
A PR may touch multiple unrelated subsystems (e.g., a refactor touching both OneLake storage and DAG execution). Impact zone clustering groups affected code into coherent units so that scenarios are organized by logical function rather than file proximity. The engine uses three signals: (a) L2 Graphify community detection (Louvain algorithm) groups code by structural modularity, (b) Roslyn namespace/project boundaries provide semantic grouping, (c) shared entry points (code reachable from the same API endpoint) group code by trigger. Each zone gets its own LLM prompt call for focused scenario generation.

**Technical Mechanism:**
```python
# Pseudocode: Impact zone clustering
def cluster_impact_zones(
    graph: EnrichedGraph,
    changed_nodes: list[str],
    communities: dict[str, str],  # node -> community_id (from Graphify Louvain)
) -> list[ImpactZone]:

    # Step 1: Group changed nodes by community
    community_groups = defaultdict(list)
    for node in changed_nodes:
        community_id = communities.get(node, "unclustered")
        community_groups[community_id].append(node)

    # Step 2: For each community group, find the blast radius
    zones = []
    for community_id, nodes in community_groups.items():
        zone = ImpactZone(
            id=f"zone-{len(zones)+1:03d}",
            community=community_id,
            primary_changes=nodes,
            affected_callers=find_affected_callers(graph, nodes, max_depth=4),
            affected_interfaces=find_affected_interfaces(graph, nodes),
            entry_points=find_entry_points(graph, nodes),
            interceptor_topics=infer_relevant_topics(graph, nodes),
        )

        # Merge small zones (< 3 nodes) into nearest neighbor
        if len(zone.primary_changes) + len(zone.affected_callers) < 3:
            nearest = find_nearest_zone(zones, zone, graph)
            if nearest:
                nearest.merge(zone)
                continue

        zones.append(zone)

    return zones

# Output per zone (matches spec §3.1 output format):
# {
#   "zoneId": "zone-001",
#   "primaryChange": { "file", "method", "changeType", "linesChanged" },
#   "affectedCallers": [{ "file", "method", "depth", "callSite" }],
#   "affectedInterfaces": ["IFileSystemClient", "IOneLakeWriter"],
#   "diRegistrations": ["services.AddScoped<IOneLakeWriter, OneLakeClient>()"],
#   "relatedTests": ["OneLakeClientTests.cs"],
#   "interceptorTopics": ["fileop", "http", "retry"]
#   }
```

**Source Code Paths:**
- `src/backend/DevMode/EdogDiRegistryCapture.cs:33-107` — DI registrations annotate zones with `diRegistrations` field showing actual service wiring
- `src/backend/DevMode/EdogTopicRouter.cs:26-44` — Topic names used to populate `interceptorTopics` per zone (which interceptors are relevant to each cluster)
- `src/backend/DevMode/EdogFltOpsInterceptor.cs:32-45` — `FltOpsEventHelper` operation categories inform zone naming (e.g., "OneLake Storage Layer", "DAG Execution")

**Edge Cases:**
- **Single-file PR:** All changed code in one file. One impact zone. No clustering needed.
- **Cross-cutting change:** Utility class used by all communities. Creates a "cross-cutting" zone that references multiple communities. LLM receives context from all affected communities.
- **No community assignment:** code-review-graph finds edges but Graphify can't assign community (disconnected subgraph). Falls back to namespace-based grouping.
- **Zone explosion:** PR touches 20+ communities. Engine limits to top 10 by change density (most changed nodes per community). Remaining flagged as "uncovered — manual review recommended."

**Interactions:**
- **C01-S06 (LLM Prompt):** Each zone gets its own LLM prompt call.
- **C02 (Curation UI):** Zones displayed as collapsible groups in the scenario list.
- **C05 (PR Integration):** Zone summary included in PR comment.

**Revert/Undo:**
Clustering is computed, not persisted. Re-analysis regenerates zones.

**Priority:** P1 — Important for organizing scenarios but not blocking. A flat list of scenarios (no zones) is functional if clustering fails.

---

### S10: Incremental Updates (Re-analyze on New Commits)

**ID:** `C01-S10`
**One-liner:** When new commits are pushed to the PR, incrementally update the analysis instead of re-running from scratch.

**Description:**
After initial analysis, the user may push new commits to the PR branch. Instead of discarding all work and re-analyzing from scratch, the engine computes a delta: which files changed between the previous and current diff, updates the graph incrementally (add/remove nodes and edges for changed files), re-runs semantic enrichment only for affected subgraphs, and asks the LLM to update (not regenerate) scenarios. User-curated edits (approved, deleted, modified scenarios) are preserved. New scenarios are generated only for newly affected impact zones.

**Technical Mechanism:**
```python
# Pseudocode: Incremental update pipeline
def incremental_update(
    previous_analysis: AnalysisResult,
    new_diff: UnifiedDiff,
    old_diff: UnifiedDiff,
) -> AnalysisResult:
    # Step 1: Compute delta between old and new diff
    added_files = new_diff.files - old_diff.files
    removed_files = old_diff.files - new_diff.files
    modified_files = {f for f in new_diff.files & old_diff.files
                      if new_diff.hunks(f) != old_diff.hunks(f)}

    delta_files = added_files | removed_files | modified_files

    if not delta_files:
        return previous_analysis  # No meaningful change

    # Step 2: Update graph
    graph = previous_analysis.graph.copy()
    for f in removed_files:
        graph.remove_nodes_in_file(f)
    for f in added_files | modified_files:
        new_symbols = parse_diff_to_symbols(new_diff, file_filter=[f])
        graph.update_nodes(new_symbols)
        # Re-run L3 enrichment for affected nodes only
        await enrich_with_omnisharp(graph, new_symbols)

    # Step 3: Re-cluster affected zones
    affected_zones = identify_affected_zones(previous_analysis.zones, delta_files)
    for zone in affected_zones:
        zone.refresh(graph)  # Re-compute callers, interfaces, topics

    # Step 4: LLM update — only for affected zones
    new_scenarios = []
    for zone in affected_zones:
        prompt = compose_update_prompt(zone, delta_files, previous_analysis.scenarios)
        new_scenarios.extend(await llm_generate(prompt))

    # Step 5: Merge with previous scenarios
    merged = merge_scenarios(
        previous=previous_analysis.scenarios,
        new=new_scenarios,
        user_edits=previous_analysis.user_edits,  # Preserved
        removed_zones=[z for z in previous_analysis.zones if z.all_files_removed(removed_files)],
    )

    return AnalysisResult(graph=graph, zones=affected_zones, scenarios=merged)
```

**Source Code Paths:**
- `src/backend/DevMode/TopicEvent.cs:19-20` — `SequenceId` enables gap detection between analysis runs (new events since last analysis)
- `src/backend/DevMode/EdogTopicRouter.cs:73-94` — `Publish()` events generated during incremental update use same topic infrastructure

**Edge Cases:**
- **Force push / rebase:** Diff base changes entirely. Delta computation unreliable. Fall back to full re-analysis. User edits preserved by scenario ID matching against unchanged scenarios.
- **File renamed + modified:** Git detects rename but content also changed. Engine treats as remove-old + add-new and migrates scenarios referencing the old file path.
- **All previous scenarios invalidated:** New commit removes the code that all scenarios tested. Engine archives old scenarios, generates entirely new set.
- **Merge conflicts in diff:** ADO API returns merge-conflict markers. Engine skips conflicted files and warns user.

**Interactions:**
- **C05 (PR Integration):** Fetches new diff from ADO API on commit push webhook.
- **C02 (Curation UI):** Shows delta indicator ("3 scenarios updated, 2 new, 1 removed").

**Revert/Undo:**
User can "Reset to Full Analysis" button to discard incremental state and re-run from scratch.

**Priority:** P1 — Significant UX improvement but not required for v1. Full re-analysis is functional (just slower).

---

### S11: Error Handling (OmniSharp Fails, LLM Times Out, Graph Too Large)

**ID:** `C01-S11`
**One-liner:** Graceful degradation when individual layers fail — engine continues with reduced accuracy rather than failing entirely.

**Description:**
Each layer can fail independently. The engine implements a degradation chain: if L3 (OmniSharp) fails, continue with L1+L2 structural analysis only (~70-80% accuracy). If L5 (DI Registry) is unavailable (Disconnected phase), skip runtime validation. If L4 (LLM) times out, retry once with reduced context, then offer manual scenario creation. If L1+L2 both fail (catastrophic), fall back to text-based diff parsing (regex method extraction). Every degradation step is communicated to the user via UI indicators and logged to the `qa` topic for diagnostics.

**Technical Mechanism:**
```python
# Pseudocode: Degradation chain
class EngineOrchestrator:
    async def analyze(self, pr_diff: UnifiedDiff) -> AnalysisResult:
        result = AnalysisResult()
        result.degradation_flags = []

        # L1 + L2: Structural graph (parallel)
        try:
            result.graph = await build_structural_graph(pr_diff)
        except GraphBuildError as e:
            result.degradation_flags.append("structural_graph_failed")
            result.graph = fallback_text_based_graph(pr_diff)  # Regex extraction
            self.publish_warning("Graph construction failed — using text-based fallback")

        # L3: Semantic enrichment
        try:
            await enrich_with_omnisharp(result.graph, timeout_s=60)
        except OmniSharpError as e:
            result.degradation_flags.append("omnisharp_unavailable")
            self.publish_warning(f"Semantic analysis unavailable: {e}")
            # Continue without semantic edges — structural graph still usable

        # L5: DI validation (Connected phase only)
        if self.is_connected_phase:
            try:
                validate_with_di_registry(result.graph)
            except DiRegistryError:
                result.degradation_flags.append("di_registry_unavailable")
                self.publish_warning("DI registry unavailable — interface resolutions unvalidated")

        # L4: LLM scenario generation
        try:
            result.scenarios = await generate_scenarios_with_llm(result.graph, timeout_s=30)
        except LLMTimeoutError:
            # Retry with reduced context
            try:
                result.scenarios = await generate_scenarios_with_llm(
                    result.graph, timeout_s=30, reduced_context=True
                )
                result.degradation_flags.append("llm_reduced_context")
            except LLMTimeoutError:
                result.degradation_flags.append("llm_failed")
                result.scenarios = []
                self.publish_warning("Scenario generation failed — create scenarios manually")

        # Always return something — never hard-fail
        return result

    def publish_warning(self, message: str):
        EdogTopicRouter.Publish("qa", {
            "event": "AnalysisDegradation",
            "message": message,
            "timestamp": datetime.utcnow(),
        })
```

**Source Code Paths:**
- `src/backend/DevMode/EdogTopicRouter.cs:73-94` — `Publish()` never-throw guarantee ensures degradation events are safely published without cascading failures
- `src/backend/DevMode/EdogDevModeRegistrar.cs:58-62` — Non-fatal error pattern: `catch (Exception ex) { Console.WriteLine(...) }` — engine follows same pattern
- `src/backend/DevMode/EdogDiRegistryCapture.cs:103-106` — DI capture failure pattern: `catch (Exception ex) { Console.WriteLine(...) }` — idempotent retry safe

**Edge Cases:**
- **All layers fail simultaneously:** Network outage or corrupted repo. Engine returns empty result with degradation flags. UI shows "Analysis failed — Create Manual Scenarios" CTA.
- **Partial OmniSharp results:** Solution partially loads (some projects fail). Engine marks which files have semantic coverage. Scenarios for uncovered files get lower confidence scores.
- **LLM returns partial results:** Response truncated mid-JSON. Engine attempts JSON repair (close open brackets). If repair fails, discards and retries.
- **Graph too large (>10K nodes):** L2 community detection limits to top communities by degree centrality. Remaining nodes pruned. Warning: "Large PR — analysis covers core changes only."

**Interactions:**
- **C02 (Curation UI):** Degradation flags displayed as warning banner ("Reduced accuracy — OmniSharp unavailable").
- **C06 (SignalR Protocol):** Degradation events streamed as `QaAnalysisWarning` messages.
- **C05 (PR Integration):** Degradation state included in PR comment ("Note: semantic analysis was unavailable for this run").

**Revert/Undo:**
User can re-trigger analysis after fixing the underlying issue (e.g., OmniSharp starts, LLM recovers). Fresh run replaces degraded results.

**Priority:** P0 — Resilience is non-negotiable. Engine must always return something.

---

### S12: Performance Characteristics (Latency Targets per Layer)

**ID:** `C01-S12`
**One-liner:** Define and enforce latency budgets for each layer to meet the 45-second total target.

**Description:**
The spec defines a p95 target of <45 seconds for scenario generation on a <500-line diff. This budget is allocated across layers with built-in parallelism. L1 and L2 run in parallel (max 2s). L3 warm-up is amortized (runs once on Connected phase start). L3 per-query enrichment runs in parallel across changed symbols (max 10s). L5 validation is instant (reads cached snapshot). L4 LLM runs in parallel across impact zones (max 15s per zone, zones parallelized). Deduplication and post-processing add ~2s. Total: ~29s typical, ~42s worst case.

**Technical Mechanism:**
```
Latency Budget (p95 target: <45s for <500-line diff)

Phase 1: Diff Fetch + Parse (sequential)
  ├── ADO REST API call: ~2s
  └── Diff parsing: <500ms
  Subtotal: ~2.5s

Phase 2: Structural Graph (parallel)
  ├── L1 code-review-graph: <1s
  └── L2 Graphify: <2s
  Subtotal: ~2s (parallel, wall-clock = max)

Phase 3: Semantic Enrichment (parallel per symbol)
  ├── L3 OmniSharp warm-up: 0s (pre-warmed on Connected phase start)
  ├── L3 per-symbol queries: <500ms each, 4 concurrent
  └── Typical PR (20 changed symbols): 20/4 * 500ms = ~2.5s
  Subtotal: ~3s (with overhead)

Phase 4: DI Validation (instant)
  └── L5 DI registry read: <50ms (in-memory snapshot)
  Subtotal: ~50ms

Phase 5: LLM Generation (parallel per zone)
  ├── L4 per-zone call: 10-15s
  ├── Typical PR (2-3 zones): 3 parallel calls
  └── Wall-clock: ~15s
  Subtotal: ~15s

Phase 6: Post-processing (sequential)
  ├── Deduplication: <500ms
  ├── Validation: <500ms
  └── Scenario formatting: <500ms
  Subtotal: ~1.5s

TOTAL (typical): ~24s
TOTAL (worst case, large PR): ~42s
TOTAL (exceeded budget): >45s → emit warning, continue
```

**Source Code Paths:**
- `src/backend/DevMode/TopicBuffer.cs:48-56` — `Write()` is O(1) (queue enqueue + channel write) — no bottleneck in event publishing
- `src/backend/DevMode/EdogTopicRouter.cs:73-94` — `Publish()` is thread-safe and non-blocking, supporting concurrent layer execution
- `src/backend/DevMode/EdogDiRegistryCapture.cs:33-36` — `CaptureRegistrations()` is idempotent with `_captured` flag — no redundant work on re-analysis

**Edge Cases:**
- **Cold OmniSharp (first analysis in session):** Add 15-30s warm-up. Total exceeds 45s target. UI shows progress: "Loading Roslyn workspace (first-time setup)..." with estimated remaining time.
- **Large PR (500+ lines, 50+ files):** Phase 5 dominates. Multiple zone calls hit LLM rate limits. Engine shows partial results as they arrive (streaming pattern) rather than waiting for all zones.
- **Slow LLM response:** Single zone call exceeds 30s timeout. Engine returns partial results for other zones and flags the timed-out zone.
- **Network latency spike:** ADO API call (Phase 1) slow. Engine caches previous diff and compares — if identical, skips re-fetch.

**Interactions:**
- **C06 (SignalR Protocol):** Phase progress streamed as `QaAnalysisProgress` events with phase name, percentage, and estimated remaining time.
- **C02 (Curation UI):** Progress indicator shows "Analyzing blast radius... → Building context graph... → Generating scenarios..."

**Revert/Undo:**
Not applicable — performance is a characteristic, not state.

**Priority:** P1 — Latency targets are aspirational for v1. Exceeding 45s is acceptable with proper progress indication. Optimization in v2.

---

## 3. Data Structures

### 3.1 Impact Zone (output of S01 + S09)

```json
{
  "zoneId": "zone-001",
  "community": "OneLake Storage Layer",
  "primaryChange": {
    "file": "src/Services/OneLakeClient.cs",
    "method": "WriteFileAsync",
    "changeType": "modified",
    "linesChanged": [142, 143, 155, 156, 157]
  },
  "affectedCallers": [
    {
      "file": "src/Services/LakehouseFileWriter.cs",
      "method": "FlushBufferAsync",
      "depth": 1,
      "callSite": "line 89"
    }
  ],
  "affectedInterfaces": ["IFileSystemClient", "IOneLakeWriter"],
  "interfaceResolutions": [
    {
      "interface": "IOneLakeWriter",
      "implementation": "OneLakeClient",
      "source": "runtime_di",
      "confidence": 1.0
    }
  ],
  "diRegistrations": ["services.AddScoped<IOneLakeWriter, OneLakeClient>()"],
  "relatedTests": ["OneLakeClientTests.cs", "LakehouseFileWriterTests.cs"],
  "interceptorTopics": ["fileop", "http", "retry"],
  "historicalBugs": [
    {"id": "BUG-4521", "title": "WriteFileAsync silent failure on 409 conflict"}
  ],
  "coverageGaps": ["No test for WriteFileAsync with >4MB payload"]
}
```

### 3.2 Interface Resolution (output of S04)

```json
{
  "interface": "IRetryPolicy",
  "implementation": "ExponentialRetryPolicy",
  "source": "runtime_di",
  "confidence": 1.0,
  "lifetime": "Singleton",
  "is_edog_intercepted": false,
  "original_implementation": "ExponentialRetryPolicy",
  "alternatives": [],
  "resolution_chain": [
    {"tier": "L5_runtime_di", "result": "ExponentialRetryPolicy", "confidence": 1.0}
  ]
}
```

### 3.3 Entry Point (output of S03)

```json
{
  "node": "DagController.RunDAG",
  "stimulus_type": "http_request",
  "depth": 3,
  "path": [
    "ExponentialRetryPolicy.Execute",
    "OneLakeWriter.WriteAsync",
    "DagExecutionEngine.ExecuteNode",
    "DagController.RunDAG"
  ],
  "directness_score": 0.25,
  "http_metadata": {
    "method": "POST",
    "route": "/liveTableSchedule/runDAG/{id}",
    "auth_required": true
  }
}
```

### 3.4 Engine Degradation State

```json
{
  "degradation_flags": ["omnisharp_unavailable"],
  "layers_active": ["L1", "L2", "L4"],
  "layers_failed": ["L3"],
  "layers_skipped": ["L5"],
  "accuracy_estimate": "70-80%",
  "warnings": [
    "Semantic analysis unavailable — interface resolutions are structural-only",
    "DI registry not loaded — Disconnected phase"
  ]
}
```

---

## 4. Open Questions

| # | Question | Impact | Owner |
|---|----------|--------|-------|
| 1 | How does OmniSharp handle the proprietary WireUp DI container? Standard Roslyn doesn't understand `WireUp.RegisterSingletonType`. | L3 may not trace DI-registered call paths. L5 compensates but only for known registrations. | Sana |
| 2 | Should the engine cache Roslyn workspace across analysis runs, or reload per-run? | Cache: faster incremental. Reload: accurate after code changes. Proposed: cache + invalidate on file change. | Vex |
| 3 | What is the LLM prompt stability across GPT-5.4-pro versions? | Prompt changes may alter scenario quality. Need regression suite for prompt evaluation. | Sana |
| 4 | How to handle conditional DI registrations (feature-flagged services)? | Wrong impl resolved if flag state at analysis time differs from test time. | Sana |
| 5 | Return value capture in interceptors — when will this be available? | Blocks return-value expectations (S08). Workaround: infer from side effects. | Vex |

---

## 5. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2025-07-10 | Sana | Initial P1 deep spec — 12 scenarios covering all five layers |
