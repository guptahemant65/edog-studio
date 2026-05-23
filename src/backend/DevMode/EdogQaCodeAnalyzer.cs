// <copyright file="EdogQaCodeAnalyzer.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Net.Http;
    using System.Text;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Threading.Tasks;

    // ──────────────────────────────────────────────
    // Layer Provider Interfaces
    // ──────────────────────────────────────────────

    /// <summary>
    /// L1 + L2: Structural graph construction via code-review-graph and Graphify.
    /// Produces a merged graph of direct-call and semantic-relationship edges
    /// with Louvain community assignments from Graphify.
    /// </summary>
    public interface IGraphProvider
    {
        /// <summary>
        /// Build a merged structural graph from changed symbols using L1 (recursive SQL CTE BFS)
        /// and L2 (NetworkX knowledge graph with community detection) in parallel.
        /// </summary>
        /// <param name="changedSymbols">Symbols extracted from the PR diff.</param>
        /// <param name="maxDepth">Maximum BFS depth for blast radius (default 4).</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        /// <returns>Merged graph with structural and semantic-relationship edges.</returns>
        Task<CodeGraph> BuildStructuralGraphAsync(
            List<ChangedSymbol> changedSymbols,
            int maxDepth = 4,
            CancellationToken cancellationToken = default);
    }

    /// <summary>
    /// L3: Roslyn semantic enrichment via OmniSharp LSP.
    /// Adds interface dispatch, call hierarchy, and type resolution edges
    /// to an existing structural graph.
    /// </summary>
    public interface IOmniSharpProvider
    {
        /// <summary>
        /// Whether OmniSharp is warmed up and ready to serve queries.
        /// </summary>
        bool IsReady { get; }

        /// <summary>
        /// Pre-warm OmniSharp against the FLT solution file.
        /// Called once when Connected phase starts. Idempotent.
        /// </summary>
        Task WarmUpAsync(string solutionPath, CancellationToken cancellationToken = default);

        /// <summary>
        /// Enrich the graph with semantic edges for the given changed symbols.
        /// Uses callHierarchy/incomingCalls, textDocument/implementation,
        /// textDocument/references, and textDocument/definition LSP queries.
        /// </summary>
        /// <param name="graph">Graph to enrich in-place.</param>
        /// <param name="changedSymbols">Symbols to query for.</param>
        /// <param name="maxConcurrentQueries">Max parallel LSP queries (default 4).</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        Task EnrichGraphAsync(
            CodeGraph graph,
            List<ChangedSymbol> changedSymbols,
            int maxConcurrentQueries = 4,
            CancellationToken cancellationToken = default);

        /// <summary>
        /// Find all concrete implementations of an interface type.
        /// </summary>
        Task<List<string>> FindImplementationsAsync(
            string interfaceType,
            CancellationToken cancellationToken = default);

        /// <summary>
        /// Get incoming call hierarchy for a method (reverse call graph).
        /// </summary>
        Task<List<CallerInfo>> GetIncomingCallsAsync(
            string filePath,
            string methodName,
            int maxDepth = 4,
            CancellationToken cancellationToken = default);
    }

    /// <summary>
    /// L4: LLM reasoning over enriched graph data.
    /// Generates scenario specifications including stimuli and expectations.
    /// </summary>
    public interface ILlmProvider
    {
        /// <summary>
        /// Generate scenarios for a single impact zone using the enriched graph context.
        /// </summary>
        /// <param name="request">Structured prompt input with graph data, DI context, and diff.</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        /// <returns>List of generated scenarios with stimuli and expectations.</returns>
        Task<List<Scenario>> GenerateScenariosAsync(
            LlmPromptRequest request,
            CancellationToken cancellationToken = default);
    }

    /// <summary>
    /// L5: Runtime DI registry providing ground truth for interface-to-implementation mappings.
    /// Wraps <see cref="EdogDiRegistryCapture"/> and consumes snapshots from the "di" topic.
    /// </summary>
    public interface IDiRegistryProvider
    {
        /// <summary>
        /// Whether the DI registry has been captured (Connected phase active).
        /// </summary>
        bool IsAvailable { get; }

        /// <summary>
        /// Load the DI snapshot from the "di" topic buffer.
        /// </summary>
        void LoadSnapshot();

        /// <summary>
        /// Resolve an interface type to its runtime implementation.
        /// Returns null if the interface is not in the registry.
        /// </summary>
        DiRegistration Resolve(string interfaceType);

        /// <summary>
        /// Get all known DI registrations.
        /// </summary>
        List<DiRegistration> GetAll();

        /// <summary>
        /// Validate a Roslyn-inferred interface mapping against the runtime registry.
        /// </summary>
        InterfaceValidation ValidateMapping(string interfaceType, string inferredImpl);
    }

    // ──────────────────────────────────────────────
    // Supporting Models (analyzer-specific)
    // ──────────────────────────────────────────────

    /// <summary>
    /// In-memory code graph holding nodes and edges from all analysis layers.
    /// </summary>
    public sealed class CodeGraph
    {
        /// <summary>All nodes keyed by ID ("file:method").</summary>
        public Dictionary<string, GraphNode> Nodes { get; set; } = new();

        /// <summary>All edges in the graph.</summary>
        public List<GraphEdge> Edges { get; set; } = new();

        /// <summary>Louvain community assignments from Graphify (node ID → community).</summary>
        public Dictionary<string, string> Communities { get; set; } = new();

        /// <summary>Add a node to the graph. Overwrites if ID exists.</summary>
        public void AddNode(GraphNode node) => Nodes[node.Id] = node;

        /// <summary>Add an edge to the graph.</summary>
        public void AddEdge(GraphEdge edge) => Edges.Add(edge);

        /// <summary>Get all incoming edges (callers) for a node.</summary>
        public List<GraphEdge> GetIncomingEdges(string nodeId) =>
            Edges.Where(e => e.Target == nodeId).ToList();

        /// <summary>Get all outgoing edges (callees) for a node.</summary>
        public List<GraphEdge> GetOutgoingEdges(string nodeId) =>
            Edges.Where(e => e.Source == nodeId).ToList();
    }

    /// <summary>
    /// DI registration entry from <see cref="EdogDiRegistryCapture"/>.
    /// </summary>
    public sealed class DiRegistration
    {
        public string ServiceType { get; set; }
        public string ImplementationType { get; set; }
        public string Lifetime { get; set; }
        public bool IsEdogIntercepted { get; set; }
        public string OriginalImplementation { get; set; }
        public string RegistrationPhase { get; set; }
    }

    /// <summary>
    /// Result of validating a Roslyn-inferred mapping against runtime DI.
    /// </summary>
    public sealed class InterfaceValidation
    {
        /// <summary>"confirmed", "conflict", or "unregistered".</summary>
        public string Status { get; set; }

        /// <summary>Confidence adjustment: +0.3 for confirmed, -0.4 for conflict, 0 for unregistered.</summary>
        public double ConfidenceDelta { get; set; }

        /// <summary>Actual implementation from DI (non-null when Status is "conflict").</summary>
        public string ActualImplementation { get; set; }

        /// <summary>Diagnostic note for conflict cases.</summary>
        public string Note { get; set; }
    }

    /// <summary>
    /// Caller information from Roslyn call hierarchy.
    /// </summary>
    public sealed class CallerInfo
    {
        public string File { get; set; }
        public string Method { get; set; }
        public int Line { get; set; }
        public string ContainingType { get; set; }
    }

    /// <summary>
    /// Per-PR context fed to the LLM scenario generator (F27 QA Testing
    /// "pinnacle" quality gates — item 1: feed the contract).
    ///
    /// <para>All fields are best-effort and optional. The analyzer pipeline
    /// gracefully degrades when they are null/empty. Populated upstream of
    /// <see cref="EdogQaCodeAnalyzer.AnalyzeAsync(string, PrContext, CancellationToken, Action{AnalysisProgress})"/>
    /// — typically by <see cref="EdogPlaygroundHub"/> after fetching the
    /// enriched <c>/api/ado-proxy/pr-diff</c> response from the dev-server.</para>
    ///
    /// <para><b>Token-budget contract:</b> the dev-server applies a first
    /// round of caps (per-field byte limits) before returning. The
    /// <see cref="EdogQaLlmProvider"/> applies a second round of caps when
    /// rendering into the prompt. This double-cap is intentional — the
    /// network round-trip should not enable arbitrarily large payloads.</para>
    /// </summary>
    public sealed class PrContext
    {
        /// <summary>PR title, e.g. "Insights v2.0.6 strict date contract".</summary>
        public string Title { get; set; }

        /// <summary>PR author display name. Informational only.</summary>
        public string Author { get; set; }

        /// <summary>Plain-text PR description, HTML stripped by dev-server.</summary>
        public string Description { get; set; }

        /// <summary>Linked work items with acceptance criteria.</summary>
        public List<WorkItemSummary> WorkItems { get; set; } = new();

        /// <summary>Linked spec markdown excerpts (ADO-hosted only).</summary>
        public List<SpecExcerpt> LinkedSpecExcerpts { get; set; } = new();

        /// <summary>FLT API catalog filtered to controllers in the diff.</summary>
        public ApiCatalogContext ApiCatalog { get; set; }

        /// <summary>Existing test files for the changed controllers.</summary>
        public List<PriorTestFile> PriorTests { get; set; } = new();

        /// <summary>
        /// Code invariants extracted from the diff by
        /// <see cref="EdogQaInvariantExtractor"/> (F27 item 2). Populated
        /// by the analyzer rather than the dev-server, so this list is
        /// empty when received from the Hub and filled in during
        /// <see cref="EdogQaCodeAnalyzer.AnalyzeAsync(string, PrContext, CancellationToken, Action{AnalysisProgress})"/>.
        /// </summary>
        public List<CodeInvariant> Invariants { get; set; } = new();

        /// <summary>
        /// Best-effort warnings from the dev-server side. Surfaced as a
        /// degradation flag rather than blocking generation.
        /// </summary>
        public List<string> Warnings { get; set; } = new();
    }

    /// <summary>Work item summary for the LLM contract section.</summary>
    public sealed class WorkItemSummary
    {
        public long Id { get; set; }
        public string Title { get; set; }
        public string State { get; set; }
        public string AcceptanceCriteria { get; set; }
        public string DescriptionSnippet { get; set; }
    }

    /// <summary>Linked spec excerpt for the LLM contract section.</summary>
    public sealed class SpecExcerpt
    {
        public string Url { get; set; }
        public string Content { get; set; }
    }

    /// <summary>FLT API catalog filtered to changed controllers.</summary>
    public sealed class ApiCatalogContext
    {
        public List<string> Controllers { get; set; } = new();
        public List<Dictionary<string, object>> Endpoints { get; set; } = new();
        public bool Truncated { get; set; }
    }

    /// <summary>Prior test file for a changed controller.</summary>
    public sealed class PriorTestFile
    {
        public string File { get; set; }
        public string Controller { get; set; }
        public List<string> Methods { get; set; } = new();
        public int TotalMethods { get; set; }
    }

    /// <summary>
    /// A code invariant extracted from a PR diff (F27 item 2). Surfaced to
    /// the LLM so it can reason about what changed structurally rather than
    /// only what changed textually.
    ///
    /// <para>Each invariant is grounded in a specific file:line location so
    /// the linter (item 5) and the scenario generator can cross-reference
    /// them — e.g. "boundary triplet around <c>MaxStrictDateRangeDays=60</c>
    /// at LiveTableInsightsController.cs:24".</para>
    /// </summary>
    public sealed class CodeInvariant
    {
        /// <summary>
        /// Kind of invariant. One of:
        /// <c>numeric_constant</c>, <c>comparison_predicate</c>,
        /// <c>temporal_threshold</c>, <c>explicit_error</c>,
        /// <c>removed_parameter</c>, <c>added_parameter</c>.
        /// </summary>
        public string Kind { get; set; }

        /// <summary>Symbol name when applicable (e.g. constant identifier).</summary>
        public string Symbol { get; set; }

        /// <summary>Literal value when applicable (e.g. "60", "7").</summary>
        public string Value { get; set; }

        /// <summary>
        /// Predicate or signature text, e.g. "endTime - startTime &gt; TimeSpan.FromDays(60)"
        /// or a thrown error message.
        /// </summary>
        public string Predicate { get; set; }

        /// <summary>File path (relative) where the invariant was detected.</summary>
        public string File { get; set; }

        /// <summary>Approximate line number in the post-diff file.</summary>
        public int Line { get; set; }

        /// <summary>Stable identifier of the form "inv-{kind}-{hash6}". Set by the extractor.</summary>
        public string Id { get; set; }
    }

    /// <summary>
    /// Structured input for the LLM scenario generation prompt.
    /// </summary>
    public sealed class LlmPromptRequest
    {
        public ImpactZone Zone { get; set; }
        public string DiffContent { get; set; }
        public CodeGraph Graph { get; set; }
        public List<DiRegistration> DiRegistrations { get; set; } = new();
        public List<InterfaceResolution> InterfaceResolutions { get; set; } = new();
        public List<string> ValidTopics { get; set; } = new();

        /// <summary>
        /// Per-PR contract context (description, WI AC, OpenAPI catalog,
        /// prior tests). Optional — null when the dev-server did not return
        /// extras or the Hub did not pass any.
        /// </summary>
        public PrContext PrContext { get; set; }
    }

    /// <summary>
    /// Result of resolving an interface to a concrete implementation
    /// using the three-tier strategy (DI → Roslyn → structural fallback).
    /// </summary>
    public sealed class InterfaceResolution
    {
        public string InterfaceType { get; set; }
        public string ImplementationType { get; set; }

        /// <summary>"runtime_di", "roslyn_unique", "roslyn_filtered", "roslyn_ambiguous", "unresolved".</summary>
        public string Source { get; set; }

        public double Confidence { get; set; }
        public string Lifetime { get; set; }
        public bool IsEdogIntercepted { get; set; }
        public List<string> Alternatives { get; set; } = new();
    }

    /// <summary>
    /// Progress callback payload streamed to the frontend via SignalR.
    /// </summary>
    public sealed class AnalysisProgress
    {
        /// <summary>Current phase: "graph_construction", "semantic_enrichment", "di_validation", "llm_generation", "clustering".</summary>
        public string Phase { get; set; }

        /// <summary>Progress percentage [0, 100].</summary>
        public int PercentComplete { get; set; }

        /// <summary>Human-readable status message.</summary>
        public string Message { get; set; }

        /// <summary>Active degradation warnings.</summary>
        public List<string> Warnings { get; set; } = new();

        /// <summary>Elapsed time since analysis start.</summary>
        public long ElapsedMs { get; set; }
    }

    /// <summary>
    /// Full result of a code understanding analysis run.
    /// </summary>
    public sealed class AnalysisResult
    {
        public CodeGraph Graph { get; set; }
        public List<ImpactZone> ImpactZones { get; set; } = new();
        public List<Scenario> Scenarios { get; set; } = new();
        public List<InterfaceResolution> InterfaceResolutions { get; set; } = new();
        public List<string> DegradationFlags { get; set; } = new();
        public long TotalDurationMs { get; set; }

        /// <summary>
        /// Findings from the post-LLM <see cref="EdogQaScenarioLinter"/> (F27
        /// item 5). Always populated alongside <see cref="Scenarios"/>; an
        /// empty list means every scenario passed every rule. Severity-Error
        /// findings indicate scenarios the curator must fix or discard.
        /// </summary>
        public List<LintFinding> LintFindings { get; set; } = new();
    }

    // ──────────────────────────────────────────────
    // Code Understanding Orchestrator
    // ──────────────────────────────────────────────

    /// <summary>
    /// Orchestrates the five-layer code understanding pipeline for F27 QA Testing.
    ///
    /// <para><b>Pipeline:</b> PR diff → L1+L2 (parallel structural graph) → L3 (semantic enrichment)
    /// → L5 (DI validation) → L4 (LLM scenario generation).</para>
    ///
    /// <para><b>Error handling:</b> Each layer can fail independently. The orchestrator
    /// continues with partial data and reports degradation flags to the UI.</para>
    ///
    /// <para><b>Threading:</b> All public methods are async and support <see cref="CancellationToken"/>.
    /// L1+L2 run in parallel. L4 runs in parallel across impact zones.</para>
    /// </summary>
    public sealed class EdogQaCodeAnalyzer
    {
        private readonly IGraphProvider _graphProvider;
        private readonly IOmniSharpProvider _omniSharpProvider;
        private readonly ILlmProvider _llmProvider;
        private readonly IDiRegistryProvider _diRegistryProvider;
        private readonly Action<AnalysisProgress> _onProgress;

        // Per-call override for progress callback (set by Hub for real-time SignalR broadcast)
        private volatile Action<AnalysisProgress> _activeCallback;

        // 16 valid interceptor topics from EdogTopicRouter.Initialize()
        private static readonly List<string> ValidTopics = new()
        {
            "http", "token", "flag", "perf", "spark", "log",
            "telemetry", "retry", "cache", "fileop", "catalog",
            "dag", "flt-ops", "nexus", "di", "capacity"
        };

        /// <summary>
        /// Initializes the code understanding orchestrator with layer providers.
        /// </summary>
        /// <param name="graphProvider">L1+L2 structural graph provider.</param>
        /// <param name="omniSharpProvider">L3 Roslyn semantic enrichment provider.</param>
        /// <param name="llmProvider">L4 LLM reasoning provider.</param>
        /// <param name="diRegistryProvider">L5 runtime DI registry provider.</param>
        /// <param name="onProgress">Optional callback for UI progress updates.</param>
        public EdogQaCodeAnalyzer(
            IGraphProvider graphProvider,
            IOmniSharpProvider omniSharpProvider,
            ILlmProvider llmProvider,
            IDiRegistryProvider diRegistryProvider,
            Action<AnalysisProgress> onProgress = null)
        {
            _graphProvider = graphProvider ?? throw new ArgumentNullException(nameof(graphProvider));
            _omniSharpProvider = omniSharpProvider ?? throw new ArgumentNullException(nameof(omniSharpProvider));
            _llmProvider = llmProvider ?? throw new ArgumentNullException(nameof(llmProvider));
            _diRegistryProvider = diRegistryProvider ?? throw new ArgumentNullException(nameof(diRegistryProvider));
            _onProgress = onProgress ?? (_ => { });
        }

        /// <summary>
        /// Run the full five-layer code understanding pipeline against a PR diff.
        /// Gracefully degrades when individual layers fail.
        /// </summary>
        /// <param name="unifiedDiff">Raw unified diff text from ADO REST API.</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        /// <param name="progressOverride">Optional per-call progress callback (overrides constructor callback).</param>
        /// <returns>Analysis result with scenarios, impact zones, and degradation flags.</returns>
        /// <remarks>
        /// Compatibility overload. New callers should prefer the
        /// <see cref="AnalyzeAsync(string, PrContext, CancellationToken, Action{AnalysisProgress})"/>
        /// overload that accepts contract context (PR description, work-item
        /// acceptance criteria, API catalog, prior tests) for F27 QA Testing
        /// "pinnacle" quality.
        /// </remarks>
        public Task<AnalysisResult> AnalyzeAsync(
            string unifiedDiff,
            CancellationToken cancellationToken = default,
            Action<AnalysisProgress> progressOverride = null)
        {
            return AnalyzeAsync(unifiedDiff, prContext: null, cancellationToken: cancellationToken, progressOverride: progressOverride);
        }

        /// <summary>
        /// Run the full five-layer code understanding pipeline against a PR diff
        /// with contract context (F27 "pinnacle" quality, item 1).
        /// </summary>
        /// <param name="unifiedDiff">Raw unified diff text from ADO REST API.</param>
        /// <param name="prContext">Best-effort PR contract context. Null is acceptable; pipeline degrades gracefully.</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        /// <param name="progressOverride">Optional per-call progress callback (overrides constructor callback).</param>
        /// <returns>Analysis result with scenarios, impact zones, and degradation flags.</returns>
        public async Task<AnalysisResult> AnalyzeAsync(
            string unifiedDiff,
            PrContext prContext,
            CancellationToken cancellationToken = default,
            Action<AnalysisProgress> progressOverride = null)
        {
            _activeCallback = progressOverride;
            try
            {
                return await AnalyzeInternalAsync(unifiedDiff, prContext, cancellationToken);
            }
            finally
            {
                _activeCallback = null;
            }
        }

        private async Task<AnalysisResult> AnalyzeInternalAsync(
            string unifiedDiff,
            PrContext prContext,
            CancellationToken cancellationToken)
        {
            EdogQaTelemetry.IncrementAnalysisStarted();
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var result = new AnalysisResult();

            // Surface stub-provider usage as degradation flags up-front so the
            // studio UI shows a visible warning banner even before downstream
            // phases run. The flags flow through the existing QaAnalysisWarning
            // emitter in EdogPlaygroundHub (see "DegradationFlags" handling).
            if (_graphProvider is StubGraphProvider)
            {
                result.DegradationFlags.Add("stub_graph_provider_active");
            }
            if (_omniSharpProvider is StubOmniSharpProvider)
            {
                result.DegradationFlags.Add("stub_omnisharp_provider_active");
            }
            if (_llmProvider is StubLlmProvider)
            {
                result.DegradationFlags.Add("stub_llm_provider_active");
            }

            // Phase 1: Parse diff into changed symbols
            ReportProgress("diff_parsing", 5, "Parsing PR diff...");
            var changedSymbols = ParseDiff(unifiedDiff);
            Console.WriteLine($"[QA-DIAG] ParseDiff: {changedSymbols.Count} symbols from {unifiedDiff?.Length ?? 0} char diff");
            if (changedSymbols.Count == 0)
            {
                Console.WriteLine($"[QA-DIAG] *** EARLY EXIT — 0 changed symbols, returning empty result");
                ReportProgress("complete", 100, "No code changes detected in diff.");
                result.TotalDurationMs = sw.ElapsedMilliseconds;
                EdogQaTelemetry.IncrementAnalysisCompleted();
                return result;
            }

            // Phase 1b: Extract code invariants from the diff (F27 item 2).
            // The invariants ride on prContext so the LLM provider can render
            // them via the same channel as the PR contract; we lazily create
            // prContext when the caller passed null so the downstream code
            // need not null-check it again.
            ReportProgress("invariant_extraction", 10, "Extracting code invariants from diff...");
            prContext ??= new PrContext();
            var invariants = EdogQaInvariantExtractor.Extract(unifiedDiff, out var invariantWarnings);
            prContext.Invariants = invariants;
            if (invariantWarnings.Count > 0)
            {
                foreach (var w in invariantWarnings)
                {
                    prContext.Warnings.Add(w);
                }
            }

            // Phase 2: L1+L2 — structural graph (parallel)
            ReportProgress("graph_construction", 15, $"Building structural graph for {changedSymbols.Count} changed symbols...");
            result.Graph = await BuildStructuralGraphSafe(changedSymbols, result.DegradationFlags, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();

            // Phase 3: L3 — semantic enrichment
            ReportProgress("semantic_enrichment", 35, "Enriching graph with Roslyn semantic data...");
            await EnrichWithOmniSharpSafe(result.Graph, changedSymbols, result.DegradationFlags, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();

            // Phase 4: L5 — DI validation
            ReportProgress("di_validation", 55, "Validating interface mappings against runtime DI...");
            result.InterfaceResolutions = ValidateWithDiRegistrySafe(result.Graph, result.DegradationFlags);

            // Phase 5: Impact zone clustering
            ReportProgress("clustering", 65, "Clustering impact zones...");
            result.ImpactZones = ClusterImpactZones(result.Graph, changedSymbols);

            // Phase 6: Reverse call-graph traversal (find entry points per zone)
            ReportProgress("entry_points", 70, "Traversing reverse call graph for entry points...");
            foreach (var zone in result.ImpactZones)
            {
                zone.EntryPoints = FindEntryPoints(result.Graph, zone);
            }

            // Phase 7: L4 — LLM scenario generation (parallel per zone)
            Console.WriteLine($"[QA-DIAG] Phase 7: LLM generation for {result.ImpactZones.Count} zones");
            ReportProgress("llm_generation", 75, $"Generating scenarios for {result.ImpactZones.Count} impact zones...");
            result.Scenarios = await GenerateScenariosSafe(
                result.ImpactZones, result.Graph, result.InterfaceResolutions,
                unifiedDiff, prContext, result.DegradationFlags, cancellationToken);
            Console.WriteLine($"[QA-DIAG] Phase 7 done: {result.Scenarios.Count} scenarios generated");

            // Phase 8: Deterministic post-LLM lint (F27 item 5). Runs even if
            // upstream phases degraded — useful findings exist whenever at
            // least one scenario was produced. Failures here are reported as
            // LNT999_RuleFailed by the linter itself; we surface a single
            // degradation flag if the entire lint pass blew up.
            try
            {
                ReportProgress("lint", 92, $"Linting {result.Scenarios.Count} scenarios...");
                result.LintFindings = EdogQaScenarioLinter.Lint(result.Scenarios, prContext);
                var errorCount = result.LintFindings.Count(f => f.Severity == LintSeverity.Error);
                if (errorCount > 0)
                {
                    result.DegradationFlags.Add($"lint: {errorCount} scenario(s) flagged with Error-severity findings");
                }
            }
            catch (Exception ex)
            {
                result.DegradationFlags.Add($"lint_failed: {ex.GetType().Name}: {ex.Message}");
            }

            // Surface PR-context warnings (best-effort enrichment failures)
            // as degradation flags so the UI shows them next to LLM warnings.
            if (prContext?.Warnings != null && prContext.Warnings.Count > 0)
            {
                foreach (var w in prContext.Warnings)
                {
                    result.DegradationFlags.Add($"pr_context: {w}");
                }
            }

            // Done
            sw.Stop();
            result.TotalDurationMs = sw.ElapsedMilliseconds;
            ReportProgress("complete", 100, $"Analysis complete: {result.Scenarios.Count} scenarios in {result.ImpactZones.Count} zones ({sw.ElapsedMilliseconds}ms).");
            EdogQaTelemetry.IncrementAnalysisCompleted();

            return result;
        }

        // ──────────────────────────────────────────────
        // PR Diff Parsing
        // ──────────────────────────────────────────────

        /// <summary>
        /// Parse a unified diff into changed symbols (files, methods, line ranges).
        /// Uses regex-based extraction for C# method signatures.
        /// </summary>
        internal static List<ChangedSymbol> ParseDiff(string unifiedDiff)
        {
            var symbols = new List<ChangedSymbol>();
            if (string.IsNullOrWhiteSpace(unifiedDiff)) return symbols;

            string currentFile = null;
            string changeType = null;
            var currentLines = new List<int>();
            int lineNumber = 0;

            foreach (var rawLine in unifiedDiff.Split('\n'))
            {
                var line = rawLine.TrimEnd('\r');

                // Detect file headers: "--- a/path" and "+++ b/path"
                if (line.StartsWith("+++ b/") || line.StartsWith("+++ B/"))
                {
                    // Flush previous file
                    if (currentFile != null)
                    {
                        FlushFileSymbols(symbols, currentFile, changeType, currentLines);
                    }

                    currentFile = line.Substring(6);
                    changeType = "modified";
                    currentLines = new List<int>();
                    continue;
                }

                if (line.StartsWith("--- /dev/null"))
                {
                    changeType = "added";
                    continue;
                }

                if (line.StartsWith("+++ /dev/null"))
                {
                    changeType = "deleted";
                    continue;
                }

                // Parse hunk headers: @@ -old,count +new,count @@
                var hunkMatch = Regex.Match(line, @"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@");
                if (hunkMatch.Success)
                {
                    lineNumber = int.Parse(hunkMatch.Groups[1].Value);
                    continue;
                }

                // Track changed lines (added or modified)
                if (line.StartsWith("+") && !line.StartsWith("+++"))
                {
                    currentLines.Add(lineNumber);
                    lineNumber++;
                }
                else if (line.StartsWith("-") && !line.StartsWith("---"))
                {
                    // Deleted line — don't increment new-file line counter
                    currentLines.Add(lineNumber);
                }
                else
                {
                    lineNumber++;
                }
            }

            // Flush last file
            if (currentFile != null)
            {
                FlushFileSymbols(symbols, currentFile, changeType, currentLines);
            }

            return symbols;
        }

        private static void FlushFileSymbols(
            List<ChangedSymbol> symbols,
            string file,
            string changeType,
            List<int> lines)
        {
            // Only process C# files
            if (!file.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) return;

            symbols.Add(new ChangedSymbol
            {
                File = file,
                Method = ExtractMethodFromPath(file),
                ChangeType = changeType ?? "modified",
                LinesChanged = lines.Distinct().OrderBy(l => l).ToList(),
            });
        }

        private static string ExtractMethodFromPath(string filePath)
        {
            // Extract a class/method hint from the file name
            // e.g. "src/backend/DevMode/EdogRetryInterceptor.cs" → "EdogRetryInterceptor"
            var fileName = filePath;
            int lastSlash = filePath.LastIndexOfAny(new[] { '/', '\\' });
            if (lastSlash >= 0) fileName = filePath.Substring(lastSlash + 1);
            if (fileName.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                fileName = fileName.Substring(0, fileName.Length - 3);
            return fileName;
        }

        // ──────────────────────────────────────────────
        // Phase 2: Structural Graph (L1 + L2)
        // ──────────────────────────────────────────────

        private async Task<CodeGraph> BuildStructuralGraphSafe(
            List<ChangedSymbol> changedSymbols,
            List<string> degradationFlags,
            CancellationToken cancellationToken)
        {
            try
            {
                return await _graphProvider.BuildStructuralGraphAsync(changedSymbols, maxDepth: 4, cancellationToken);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                degradationFlags.Add("structural_graph_failed");
                PublishWarning($"Graph construction failed — using text-based fallback: {ex.Message}");
                return BuildFallbackGraph(changedSymbols);
            }
        }

        /// <summary>
        /// Text-based fallback graph when L1+L2 providers fail.
        /// Creates nodes from diff symbols without cross-file edges.
        /// </summary>
        private static CodeGraph BuildFallbackGraph(List<ChangedSymbol> changedSymbols)
        {
            var graph = new CodeGraph();
            foreach (var symbol in changedSymbols)
            {
                var nodeId = $"{symbol.File}:{symbol.Method}";
                graph.AddNode(new GraphNode
                {
                    Id = nodeId,
                    File = symbol.File,
                    Method = symbol.Method,
                    NodeType = "method",
                    IsChanged = true,
                });
            }
            return graph;
        }

        // ──────────────────────────────────────────────
        // Phase 3: Semantic Enrichment (L3)
        // ──────────────────────────────────────────────

        private async Task EnrichWithOmniSharpSafe(
            CodeGraph graph,
            List<ChangedSymbol> changedSymbols,
            List<string> degradationFlags,
            CancellationToken cancellationToken)
        {
            // Auto-warm OmniSharp on first use if not yet ready
            if (!_omniSharpProvider.IsReady)
            {
                var solutionPath = FindSolutionFile();
                if (solutionPath != null)
                {
                    try
                    {
                        Console.WriteLine($"[EDOG] Auto-warming OmniSharp with {solutionPath}...");
                        await _omniSharpProvider.WarmUpAsync(solutionPath, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[EDOG] OmniSharp warmup failed: {ex.Message}");
                    }
                }
            }

            if (!_omniSharpProvider.IsReady)
            {
                degradationFlags.Add("omnisharp_not_ready");
                PublishWarning("OmniSharp not warmed up — semantic analysis skipped. Accuracy may be reduced (~70-80%).");
                return;
            }

            try
            {
                await _omniSharpProvider.EnrichGraphAsync(graph, changedSymbols, maxConcurrentQueries: 4, cancellationToken);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                degradationFlags.Add("omnisharp_unavailable");
                PublishWarning($"Semantic analysis unavailable: {ex.Message}");
            }
        }

        // ──────────────────────────────────────────────
        // Phase 4: DI Validation (L5)
        // ──────────────────────────────────────────────

        private List<InterfaceResolution> ValidateWithDiRegistrySafe(
            CodeGraph graph,
            List<string> degradationFlags)
        {
            var resolutions = new List<InterfaceResolution>();

            // Find all interface nodes in the graph
            var interfaceNodes = graph.Nodes.Values
                .Where(n => n.NodeType == "interface")
                .ToList();

            // Load snapshot FIRST, then check availability
            try
            {
                _diRegistryProvider.LoadSnapshot();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG-QA] DI registry snapshot load failed: {ex.Message}");
            }

            if (!_diRegistryProvider.IsAvailable)
            {
                degradationFlags.Add("di_registry_unavailable");
                PublishWarning("DI registry unavailable (Disconnected phase) — interface resolutions unvalidated.");

                // Return unvalidated resolutions
                foreach (var node in interfaceNodes)
                {
                    resolutions.Add(new InterfaceResolution
                    {
                        InterfaceType = node.Method,
                        Source = "unresolved",
                        Confidence = 0.0,
                    });
                }
                return resolutions;
            }

            try
            {

                foreach (var node in interfaceNodes)
                {
                    resolutions.Add(ResolveInterface(node.Method));
                }

                // Also resolve interfaces found in graph edges (interface_dispatch type)
                var interfaceEdges = graph.Edges
                    .Where(e => e.EdgeType == "interface_dispatch")
                    .Select(e => e.Target)
                    .Distinct()
                    .Where(target => !interfaceNodes.Any(n => n.Id == target));

                foreach (var target in interfaceEdges)
                {
                    var interfaceName = target.Contains(":") ? target.Split(':').Last() : target;
                    if (resolutions.All(r => r.InterfaceType != interfaceName))
                    {
                        resolutions.Add(ResolveInterface(interfaceName));
                    }
                }
            }
            catch (Exception ex)
            {
                degradationFlags.Add("di_registry_error");
                PublishWarning($"DI registry validation failed: {ex.Message}");
            }

            return resolutions;
        }

        /// <summary>
        /// Three-tier interface resolution: DI registry → Roslyn → unresolved.
        /// </summary>
        private InterfaceResolution ResolveInterface(string interfaceType)
        {
            // Tier 1: Runtime DI Registry (ground truth, confidence 1.0)
            var diMapping = _diRegistryProvider.Resolve(interfaceType);
            if (diMapping != null)
            {
                return new InterfaceResolution
                {
                    InterfaceType = interfaceType,
                    ImplementationType = diMapping.ImplementationType,
                    Source = "runtime_di",
                    Confidence = 1.0,
                    Lifetime = diMapping.Lifetime,
                    IsEdogIntercepted = diMapping.IsEdogIntercepted,
                };
            }

            // Tier 2+3 delegated to OmniSharp (if available) — handled during enrichment
            // Return unresolved for now; OmniSharp enrichment may have already added edges
            return new InterfaceResolution
            {
                InterfaceType = interfaceType,
                Source = "unresolved",
                Confidence = 0.0,
            };
        }

        // ──────────────────────────────────────────────
        // Phase 5: Impact Zone Clustering
        // ──────────────────────────────────────────────

        /// <summary>
        /// Cluster changed code into logical impact zones using Graphify community detection,
        /// namespace boundaries, and shared entry points.
        /// </summary>
        internal static List<ImpactZone> ClusterImpactZones(
            CodeGraph graph,
            List<ChangedSymbol> changedSymbols)
        {
            // Group changed symbols by community assignment
            var communityGroups = new Dictionary<string, List<ChangedSymbol>>();
            foreach (var symbol in changedSymbols)
            {
                var nodeId = $"{symbol.File}:{symbol.Method}";
                var community = graph.Communities.TryGetValue(nodeId, out var c) ? c : "unclustered";
                if (!communityGroups.ContainsKey(community))
                    communityGroups[community] = new List<ChangedSymbol>();
                communityGroups[community].Add(symbol);
            }

            var zones = new List<ImpactZone>();
            int zoneIndex = 0;

            foreach (var (community, symbols) in communityGroups)
            {
                zoneIndex++;
                var zone = new ImpactZone
                {
                    ZoneId = $"zone-{zoneIndex:D3}",
                    PrimaryChange = symbols.First(),
                    Community = community,
                    AffectedCallers = FindAffectedCallers(graph, symbols, maxDepth: 4),
                    AffectedInterfaces = FindAffectedInterfaces(graph, symbols),
                    InterceptorTopics = InferRelevantTopics(graph, symbols),
                };

                // Merge small zones (<3 total nodes) into nearest neighbor
                int totalNodes = 1 + zone.AffectedCallers.Count;
                if (totalNodes < 3 && zones.Count > 0)
                {
                    MergeIntoNearest(zones, zone);
                    continue;
                }

                zones.Add(zone);
            }

            // Ensure at least one zone exists
            if (zones.Count == 0 && changedSymbols.Count > 0)
            {
                zones.Add(new ImpactZone
                {
                    ZoneId = "zone-001",
                    PrimaryChange = changedSymbols.First(),
                    Community = "default",
                });
            }

            return zones;
        }

        private static List<AffectedCaller> FindAffectedCallers(
            CodeGraph graph,
            List<ChangedSymbol> symbols,
            int maxDepth)
        {
            var callers = new List<AffectedCaller>();
            var visited = new HashSet<string>();

            foreach (var symbol in symbols)
            {
                var nodeId = $"{symbol.File}:{symbol.Method}";
                TraverseCallers(graph, nodeId, 0, maxDepth, visited, callers);
            }

            return callers.OrderBy(c => c.Depth).ToList();
        }

        private static void TraverseCallers(
            CodeGraph graph,
            string nodeId,
            int currentDepth,
            int maxDepth,
            HashSet<string> visited,
            List<AffectedCaller> callers)
        {
            if (currentDepth > maxDepth || !visited.Add(nodeId)) return;

            foreach (var edge in graph.GetIncomingEdges(nodeId))
            {
                if (graph.Nodes.TryGetValue(edge.Source, out var callerNode))
                {
                    callers.Add(new AffectedCaller
                    {
                        File = callerNode.File,
                        Method = callerNode.Method,
                        Depth = currentDepth + 1,
                        CallSite = $"edge:{edge.EdgeType}",
                    });
                    TraverseCallers(graph, edge.Source, currentDepth + 1, maxDepth, visited, callers);
                }
            }
        }

        private static List<string> FindAffectedInterfaces(CodeGraph graph, List<ChangedSymbol> symbols)
        {
            var interfaces = new HashSet<string>();
            foreach (var symbol in symbols)
            {
                var nodeId = $"{symbol.File}:{symbol.Method}";
                foreach (var edge in graph.GetIncomingEdges(nodeId).Concat(graph.GetOutgoingEdges(nodeId)))
                {
                    if (edge.EdgeType == "interface_dispatch")
                    {
                        if (graph.Nodes.TryGetValue(edge.Source, out var src) && src.NodeType == "interface")
                            interfaces.Add(src.Method);
                        if (graph.Nodes.TryGetValue(edge.Target, out var tgt) && tgt.NodeType == "interface")
                            interfaces.Add(tgt.Method);
                    }
                }
            }
            return interfaces.ToList();
        }

        private static List<string> InferRelevantTopics(CodeGraph graph, List<ChangedSymbol> symbols)
        {
            var topics = new HashSet<string>();
            foreach (var symbol in symbols)
            {
                var file = symbol.File.ToLowerInvariant();
                if (file.Contains("http") || file.Contains("pipeline")) topics.Add("http");
                if (file.Contains("retry")) topics.Add("retry");
                if (file.Contains("cache")) topics.Add("cache");
                if (file.Contains("dag")) topics.Add("dag");
                if (file.Contains("fileop") || file.Contains("filesystem") || file.Contains("onelake")) topics.Add("fileop");
                if (file.Contains("spark")) topics.Add("spark");
                if (file.Contains("token")) topics.Add("token");
                if (file.Contains("flag") || file.Contains("flighter")) topics.Add("flag");
                if (file.Contains("telemetry")) topics.Add("telemetry");
                if (file.Contains("log")) topics.Add("log");
                if (file.Contains("catalog")) topics.Add("catalog");
                if (file.Contains("fltops") || file.Contains("flt-ops")) topics.Add("flt-ops");
                if (file.Contains("perf")) topics.Add("perf");
                if (file.Contains("capacity")) topics.Add("capacity");
            }
            return topics.ToList();
        }

        private static void MergeIntoNearest(List<ImpactZone> zones, ImpactZone small)
        {
            // Merge into the zone with the most shared callers or same community
            var nearest = zones
                .OrderByDescending(z => z.Community == small.Community ? 1 : 0)
                .First();

            nearest.AffectedCallers.AddRange(small.AffectedCallers);
            nearest.AffectedInterfaces.AddRange(small.AffectedInterfaces);
            nearest.InterceptorTopics = nearest.InterceptorTopics.Union(small.InterceptorTopics).ToList();
        }

        // ──────────────────────────────────────────────
        // Phase 6: Reverse Call-Graph Traversal
        // ──────────────────────────────────────────────

        /// <summary>
        /// Traverse the enriched graph upward from changed code to find API entry points.
        /// Classifies each entry point by stimulus type and ranks by directness.
        /// </summary>
        internal static List<EntryPoint> FindEntryPoints(CodeGraph graph, ImpactZone zone)
        {
            var entryPoints = new List<EntryPoint>();
            var visited = new HashSet<string>();

            var startNodeId = $"{zone.PrimaryChange.File}:{zone.PrimaryChange.Method}";

            // BFS upward through callers
            var queue = new Queue<(string nodeId, int depth, List<string> path)>();
            queue.Enqueue((startNodeId, 0, new List<string> { startNodeId }));

            while (queue.Count > 0)
            {
                var (nodeId, depth, path) = queue.Dequeue();
                if (depth > 4 || !visited.Add(nodeId)) continue;

                // Check if this node is a stimulus entry point
                if (graph.Nodes.TryGetValue(nodeId, out var node))
                {
                    var stimulusType = ClassifyEntryPoint(node);
                    if (stimulusType.HasValue)
                    {
                        entryPoints.Add(new EntryPoint
                        {
                            Node = $"{node.File}:{node.Method}",
                            StimulusType = stimulusType.Value,
                            Depth = depth,
                            Path = new List<string>(path),
                            DirectnessScore = 1.0 / (depth + 1),
                        });
                        continue; // Don't traverse above entry points
                    }
                }

                // Enqueue all callers
                foreach (var edge in graph.GetIncomingEdges(nodeId))
                {
                    var newPath = new List<string>(path) { edge.Source };
                    queue.Enqueue((edge.Source, depth + 1, newPath));
                }
            }

            // If no entry point found, flag as di_invocation
            if (entryPoints.Count == 0 && zone.PrimaryChange != null)
            {
                entryPoints.Add(new EntryPoint
                {
                    Node = startNodeId,
                    StimulusType = StimulusType.DiInvocation,
                    Depth = 0,
                    Path = new List<string> { startNodeId },
                    DirectnessScore = 1.0,
                });
            }

            return entryPoints.OrderByDescending(e => e.DirectnessScore).ToList();
        }

        /// <summary>
        /// Classify a graph node as a stimulus entry point based on naming and semantic data.
        /// Returns null if the node is not an entry point.
        /// </summary>
        private static StimulusType? ClassifyEntryPoint(GraphNode node)
        {
            var method = node.Method ?? "";
            var file = node.File ?? "";
            var semanticData = node.SemanticData ?? new Dictionary<string, string>();

            // HTTP controller endpoints
            if ((file.Contains("Controller") || method.Contains("Controller"))
                && (semanticData.ContainsKey("HttpMethod") || HasHttpAttributeHint(method)))
            {
                return StimulusType.HttpRequest;
            }

            // SignalR hub methods
            if (file.Contains("Hub") || method.Contains("Hub"))
            {
                return StimulusType.SignalRBroadcast;
            }

            // DAG trigger endpoints
            if (method.Contains("RunDAG") || method.Contains("ExecuteDAG")
                || (file.Contains("Dag") && method.Contains("Execute")))
            {
                return StimulusType.DagTrigger;
            }

            // File event watchers
            if (method.Contains("FileSystemWatcher") || method.Contains("OnFileChanged")
                || semanticData.ContainsKey("FileWatcher"))
            {
                return StimulusType.FileEvent;
            }

            // Timer/hosted service callbacks
            if (method.Contains("TimerCallback") || method.Contains("ExecuteAsync")
                && (file.Contains("HostedService") || file.Contains("BackgroundService")))
            {
                return StimulusType.TimerTick;
            }

            return null;
        }

        private static bool HasHttpAttributeHint(string method)
        {
            // Common HTTP action method naming patterns
            return method.StartsWith("Get", StringComparison.OrdinalIgnoreCase)
                || method.StartsWith("Post", StringComparison.OrdinalIgnoreCase)
                || method.StartsWith("Put", StringComparison.OrdinalIgnoreCase)
                || method.StartsWith("Delete", StringComparison.OrdinalIgnoreCase)
                || method.StartsWith("Patch", StringComparison.OrdinalIgnoreCase);
        }

        // ──────────────────────────────────────────────
        // Phase 7: LLM Scenario Generation (L4)
        // ──────────────────────────────────────────────

        private async Task<List<Scenario>> GenerateScenariosSafe(
            List<ImpactZone> zones,
            CodeGraph graph,
            List<InterfaceResolution> resolutions,
            string diff,
            PrContext prContext,
            List<string> degradationFlags,
            CancellationToken cancellationToken)
        {
            var requestedMode = EdogQaFeatureFlags.LlmV2;
            Console.WriteLine($"[QA-DIAG] GenerateScenariosSafe: LlmV2Mode={requestedMode}, zones={zones.Count}");

            // Off — user explicitly opted out.Skip the probe (would just
            // burn ~$0.001 for no decision impact) and run legacy quiet.
            if (requestedMode == LlmV2Mode.Off)
            {
                Console.WriteLine($"[QA-DIAG] LlmV2=Off → running legacy");
                return await RunLegacyScenarioGenerationAsync(
                    zones, graph, resolutions, diff, prContext, degradationFlags, cancellationToken)
                    .ConfigureAwait(false);
            }

            // Auto / Shadow / On — wait briefly for the probe result.
            // WaitForResultAsync returns null on timeout WITHOUT cancelling
            // the underlying probe; a subsequent analyzer call will see
            // the result. The probe is kicked at registrar time so this
            // is normally an immediate completed-task return.
            EdogQaCapabilityProbe.DualProbeResult dual = null;
            try
            {
                dual = await EdogQaCapabilityProbe.WaitForResultAsync(
                    TimeSpan.FromSeconds(10), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                degradationFlags.Add("llm_v2_probe_wait_failed");
                PublishWarning($"LLM_V2 probe wait failed: {ex.GetType().Name}: {ex.Message}");
            }

            var probeReady = dual?.IsReady == true;
            var probeReason = dual?.Reason ?? "probe still in flight (10s window exceeded — first analysis after cold start may see this once)";
            Console.WriteLine($"[QA-DIAG] Probe result: ready={probeReady}, reason={probeReason}");
            if (dual?.Architect != null)
                Console.WriteLine($"[QA-DIAG]   Architect: ready={dual.Architect.IsReady}, deployment={dual.Architect.Deployment}, errors=[{string.Join(", ", dual.Architect.Errors ?? new List<string>())}]");
            if (dual?.Editor != null)
                Console.WriteLine($"[QA-DIAG]   Editor: ready={dual.Editor.IsReady}, deployment={dual.Editor.Deployment}, errors=[{string.Join(", ", dual.Editor.Errors ?? new List<string>())}]");

            // On — strict V2 with no legacy fallback. A probe failure here
            // surfaces as a typed LLM_NOT_READY error so the UI can show
            // an actionable diagnostic instead of silent legacy output.
            if (requestedMode == LlmV2Mode.On)
            {
                Console.WriteLine($"[QA-DIAG] LlmV2=On, probeReady={probeReady}");
                if (!probeReady)
                {
                    throw new LlmProviderException(
                        LlmProviderErrorKind.Configuration,
                        $"LLM_NOT_READY: EDOG_QA_LLM_V2=on but Azure OpenAI probe failed — {probeReason}",
                        retryable: false);
                }
                var v2 = await RunV2OrchestratorAsync(
                    zones, diff, prContext, degradationFlags, allowLegacyFallback: false, cancellationToken)
                    .ConfigureAwait(false);
                return v2; // allowLegacyFallback=false guarantees non-null
            }

            // Auto — prefer V2 if the probe passes, transparent fallback
            // to legacy with a loud warning if not. This is the default
            // when EDOG_QA_LLM_V2 is unset; closes the deployment hole
            // where every legacy run silently shipped degraded output.
            if (requestedMode == LlmV2Mode.Auto)
            {
                Console.WriteLine($"[QA-DIAG] LlmV2=Auto, probeReady={probeReady}");
                if (probeReady)
                {
                    Console.WriteLine($"[QA-DIAG] Running V2 orchestrator (Auto+probeReady)");
                    var v2 = await RunV2OrchestratorAsync(
                        zones, diff, prContext, degradationFlags, allowLegacyFallback: true, cancellationToken)
                        .ConfigureAwait(false);
                    if (v2 != null) return v2;
                    Console.WriteLine($"[QA-DIAG] V2 returned null → falling to legacy");
                }
                degradationFlags.Add("llm_v2_fallback_to_legacy");
                Console.WriteLine($"[QA-DIAG] FALLBACK to legacy: {probeReason}");
                PublishWarning(
                    "LEGACY_LLM_FALLBACK: V2 (Architect+Editor) unavailable — " + probeReason
                    + " — running legacy single-prompt scenario generation. Set EDOG_QA_LLM_V2=off to silence this warning, or fix the config to unlock V2.");
                return await RunLegacyScenarioGenerationAsync(
                    zones, graph, resolutions, diff, prContext, degradationFlags, cancellationToken)
                    .ConfigureAwait(false);
            }

            // Shadow — legacy is primary, V2 fires-and-forgets on the side
            // for comparison. V2 errors NEVER affect the prod result. We
            // gate against LlmV2Mode.Shadow explicitly here (rather than
            // relying on flow-through) so the wire-in pin-test can read
            // the literal and validate every mode is handled.
            if (requestedMode == LlmV2Mode.Shadow)
            {
                var legacy = await RunLegacyScenarioGenerationAsync(
                    zones, graph, resolutions, diff, prContext, degradationFlags, cancellationToken)
                    .ConfigureAwait(false);
                if (probeReady)
                {
                    _ = RunV2ShadowAsync(zones, diff, prContext, legacy.Count, cancellationToken);
                }
                return legacy;
            }

            // Defensive fallthrough — unrecognised mode behaves like Off.
            return await RunLegacyScenarioGenerationAsync(
                zones, graph, resolutions, diff, prContext, degradationFlags, cancellationToken)
                .ConfigureAwait(false);
        }

        /// <summary>
        /// Legacy per-zone parallel scenario generation. Preserves the
        /// pre-T1c-b behaviour byte-for-byte so Auto-fallback and Off
        /// paths produce identical output. Typed LlmProviderException
        /// bubbles up; unknown exceptions are logged + recorded as
        /// degradation but do not abort the run.
        /// </summary>
        private async Task<List<Scenario>> RunLegacyScenarioGenerationAsync(
            List<ImpactZone> zones,
            CodeGraph graph,
            List<InterfaceResolution> resolutions,
            string diff,
            PrContext prContext,
            List<string> degradationFlags,
            CancellationToken cancellationToken)
        {
            Console.WriteLine($"[QA-DIAG] RunLegacyScenarioGenerationAsync: {zones.Count} zones");
            var allScenarios = new List<Scenario>();

            var zonesToProcess = zones.Take(10).ToList();
            var tasks = zonesToProcess.Select(zone => GenerateScenariosForZoneSafe(
                zone, graph, resolutions, diff, prContext, degradationFlags, cancellationToken)).ToList();

            try
            {
                var results = await Task.WhenAll(tasks);
                foreach (var scenarios in results)
                {
                    allScenarios.AddRange(scenarios);
                }
            }
            catch (OperationCanceledException) { throw; }
            catch (LlmProviderException)
            {
                // F27 P4: typed LLM failures must reach the hub so it can
                // emit a typed QaError instead of silently dropping to
                // synthetic.
                throw;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[QA-DIAG] Legacy generation EXCEPTION: {ex.GetType().Name}: {ex.Message}");
                degradationFlags.Add("llm_failed");
                PublishWarning($"Scenario generation failed: {ex.Message}");
            }

            return PostProcessScenarios(allScenarios);
        }

        // ──────────────────────────────────────────────
        // F27 P9 T1c-b: V2 orchestrator integration
        // ──────────────────────────────────────────────

        /// <summary>
        /// Lazy process-shared HttpClient for the V2 orchestrator. Mirrors
        /// the EdogQaLlmProvider single-client-per-process pattern (we
        /// can't reach into DI from this analyzer). One-time creation is
        /// idempotent because Lazy{T} guarantees publication ordering.
        /// </summary>
        private static readonly Lazy<HttpClient> SharedHttpClient = new(
            () => new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(180),
            });

        private async Task<List<Scenario>> RunV2OrchestratorAsync(
            List<ImpactZone> zones,
            string diff,
            PrContext prContext,
            List<string> degradationFlags,
            bool allowLegacyFallback,
            CancellationToken cancellationToken)
        {
            Console.WriteLine($"[QA-DIAG] RunV2OrchestratorAsync: zones={zones.Count}, allowLegacyFallback={allowLegacyFallback}");
            var architectCfg = EdogQaLlmClient.ReadArchitectConfigFromEnv();
            var editorCfg = EdogQaLlmClient.ReadEditorConfigFromEnv();
            Console.WriteLine($"[QA-DIAG]   Architect: endpoint={(architectCfg.Endpoint != null ? "SET" : "NULL")}, key={(architectCfg.ApiKey != null ? "SET" : "NULL")}, dep={architectCfg.Deployment}");
            Console.WriteLine($"[QA-DIAG]   Editor: endpoint={(editorCfg.Endpoint != null ? "SET" : "NULL")}, key={(editorCfg.ApiKey != null ? "SET" : "NULL")}, dep={editorCfg.Deployment}");
            if (string.IsNullOrEmpty(architectCfg.Endpoint)
                || string.IsNullOrEmpty(architectCfg.ApiKey)
                || string.IsNullOrEmpty(editorCfg.Endpoint)
                || string.IsNullOrEmpty(editorCfg.ApiKey))
            {
                // Config gap discovered after the probe passed (race with
                // env mutation, partial alias) — Auto callers degrade to
                // legacy, On callers must hard-fail because they explicitly
                // refused the silent fallback.
                if (!allowLegacyFallback)
                {
                    throw new LlmProviderException(
                        LlmProviderErrorKind.Configuration,
                        "LLM_NOT_READY: V2 orchestrator missing Architect/Editor endpoint or api-key. "
                        + "Verify AZURE_OPENAI_ARCHITECT_* / AZURE_OPENAI_EDITOR_* (or the PRO/base "
                        + "fallback chain — see edog.py launcher aliasing) are present in the FLT process env.",
                        retryable: false);
                }
                degradationFlags.Add("llm_v2_config_missing");
                PublishWarning("LLM_V2_CONFIG_MISSING: Architect/Editor endpoint or api-key not configured; falling back to legacy path.");
                return null;
            }

            var orchestrator = new EdogQaScenarioOrchestrator(SharedHttpClient.Value);
            var config = new EdogQaScenarioOrchestrator.OrchestratorConfig
            {
                Architect = architectCfg,
                Editor = editorCfg,
                Validation = new EdogQaScenarioValidator.ValidationContext
                {
                    ValidTopics = ValidTopics,
                    ConfidenceCapIsInformational = true,
                },
            };

            // ── P10: assemble contract catalog for LLM prompt injection ──
            // Best-effort, run-scoped. Catalog assembly failure is non-fatal —
            // the orchestrator simply runs without enriched slot context.
            string slotPurposesText = string.Empty;
            string fewShotText = string.Empty;
            string catalogRefJson = string.Empty;
            var catalog = EdogQaServiceLocator.ContractCatalog;
            if (catalog != null)
            {
                try
                {
                    string swaggerJson = null;
                    string frameworkEndpointsJson = null;

                    // Swagger is required for HTTP route discovery. Without it,
                    // the Architect only sees DiInvocation entry points.
                    try
                    {
                        using var swaggerResponse = await SharedHttpClient.Value.GetAsync(
                            "http://localhost:5555/api/playground/swagger/spec", cancellationToken).ConfigureAwait(false);
                        if (swaggerResponse.IsSuccessStatusCode)
                        {
                            swaggerJson = await swaggerResponse.Content.ReadAsStringAsync().ConfigureAwait(false);
                            Console.WriteLine($"[QA-DIAG] Swagger fetched: {swaggerJson?.Length ?? 0} bytes");
                        }
                        else
                        {
                            Console.WriteLine($"[QA-DIAG] Swagger fetch failed: HTTP {(int)swaggerResponse.StatusCode}");
                        }
                    }
                    catch (Exception swaggerEx)
                    {
                        Console.WriteLine($"[QA-DIAG] Swagger fetch error: {swaggerEx.GetType().Name}: {swaggerEx.Message}");
                    }

                    if (string.IsNullOrEmpty(swaggerJson))
                    {
                        degradationFlags.Add("swagger_unavailable");
                        PublishWarning(
                            "SWAGGER_UNAVAILABLE: Could not fetch runtime swagger from /api/playground/swagger/spec. "
                            + "HTTP route discovery is disabled — all scenarios will use DiInvocation. "
                            + "Ensure FLT is running in Connected phase and the dev-server proxy is active.");
                    }

                    try
                    {
                        var fltBinPath = Environment.GetEnvironmentVariable("FLT_BIN_PATH") ?? string.Empty;
                        var fwPath = System.IO.Path.Combine(fltBinPath, "framework-endpoints.json");
                        if (System.IO.File.Exists(fwPath))
                        {
                            frameworkEndpointsJson = System.IO.File.ReadAllText(fwPath);
                        }
                    }
                    catch { /* framework endpoints unavailable */ }

                    var zoneId = zones.FirstOrDefault()?.ZoneId ?? "zone-00";

                    // Extract compact route summary from swagger instead of
                    // passing the full 167KB spec. The catalog assembler needs
                    // the full spec for slot hashing, but we also build a
                    // lightweight route list for the zone summary.
                    object swaggerObj = null;
                    if (!string.IsNullOrEmpty(swaggerJson))
                    {
                        try
                        {
                            swaggerObj = System.Text.Json.JsonSerializer.Deserialize<object>(swaggerJson);
                        }
                        catch { /* malformed swagger — treat as absent */ }
                    }

                    var snapshot = catalog.Assemble(zoneId, null, swaggerObj, frameworkEndpointsJson);

                    if (snapshot != null && snapshot.Slots != null && snapshot.Slots.Count > 0)
                    {
                        slotPurposesText = catalog.BuildFewShotExemplars(snapshot);

                        var selectedSlots = snapshot.Slots.Take(50).Select(s => new
                        {
                            slotId = s.SlotId,
                            kind = s.Kind.ToString(),
                            slotHash = s.SlotHash,
                            purpose = s.Purpose,
                        }).ToList();

                        var refPayload = new
                        {
                            catalogSnapshotId = snapshot.SnapshotId,
                            slotsIncluded = selectedSlots.Count,
                            slotsTotal = snapshot.Slots.Count,
                            slots = selectedSlots,
                            topicFieldHashes = snapshot.TopicFieldHashes?
                                .Select(kvp => new { topic = kvp.Key, hash = kvp.Value })
                                .ToList(),
                        };
                        catalogRefJson = System.Text.Json.JsonSerializer.Serialize(refPayload);
                    }

                    Console.WriteLine(
                        $"[QA-DIAG] Catalog assembled: {snapshot?.Slots?.Count ?? 0} slots, "
                        + $"snapshotId={snapshot?.SnapshotId ?? "null"}, "
                        + $"slotPurposes={slotPurposesText?.Length ?? 0} chars, "
                        + $"catalogRef={catalogRefJson?.Length ?? 0} chars");
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[QA-DIAG] Catalog assembly failed (non-fatal): {ex.GetType().Name}: {ex.Message}");
                    degradationFlags.Add("catalog_assembly_failed");
                }
            }
            else
            {
                Console.WriteLine("[QA-DIAG] ContractCatalog not available — catalog context will not be injected into LLM prompt");
            }

            // PA-1: split diff into impl vs test hunks so the Architect sees
            // impl as primary signal and test as secondary evidence. The
            // Validator continues to bind evidence against the FULL unified
            // diff (ZoneInput.UnifiedDiff below), so no grounding info is lost.
            var (implDiff, testDiff) = SplitDiffByPath(diff);

            // PE-1: render a trusted PR_INTENT block once; the Architect uses
            // it to orient on the central behavioural change before enumerating
            // peripheral edge cases. Empty when no PrContext metadata exists.
            var prIntentSummary = BuildPrIntentSummary(prContext);

            var inputs = zones.Take(10).Select((z, i) => new EdogQaScenarioOrchestrator.ZoneInput
            {
                ZoneId = string.IsNullOrEmpty(z.ZoneId) ? $"zone-{i:00}" : z.ZoneId,
                ZoneSummary = BuildZoneSummary(z, catalogRefJson),
                RedactedDiff = implDiff,
                UnifiedDiff = diff,
                TestDiff = testDiff,
                PrIntentSummary = prIntentSummary,
                BaseSha = string.Empty,
                HeadSha = string.Empty,
                SlotPurposesText = slotPurposesText,
                FewShotExemplarsText = fewShotText,
                CatalogReferenceJson = catalogRefJson,
            }).ToArray();

            var result = await orchestrator.RunAsync(inputs, config, progress: null, cancellationToken).ConfigureAwait(false);

            // ── Zone outcome diagnostics ──────────────────────────────
            // Surface per-zone outcomes so zero-scenario runs are debuggable
            // instead of silently returning an empty list.
            foreach (var zr in result.Zones)
            {
                Console.WriteLine(
                    $"[QA-DIAG] Zone '{zr.ZoneId}': outcome={zr.Outcome}, reason={zr.OutcomeReason}, "
                    + $"accepted={zr.Accepted?.Count ?? 0}, quarantined={zr.Quarantined?.Count ?? 0}, "
                    + $"errors=[{string.Join(", ", zr.Errors ?? new List<string>())}], "
                    + $"elapsed={zr.ElapsedMs}ms, cost=${zr.CostUsd:F6}, "
                    + $"repair={zr.RepairAttempts}x branch={zr.RepairBranch}");
            }
            Console.WriteLine(
                $"[QA-DIAG] Orchestrator totals: merged={result.MergedScenarios.Count}, "
                + $"projectionRejected={result.ProjectionRejected?.Count ?? 0}, "
                + $"duplicates={result.Duplicates?.Count ?? 0}, "
                + $"budget={result.BudgetGateTripped} ({result.BudgetGateReason})");

            // Log per-rejected-scenario reasons so the root cause is visible
            // in stdout even when the frontend only shows the aggregate.
            if (result.ProjectionRejected != null)
            {
                foreach (var rej in result.ProjectionRejected)
                {
                    var scnId = rej.Scenario?.Id ?? "(null)";
                    var codes = string.Join(", ", (rej.Reasons ?? new List<EdogQaScenarioValidator.QuarantineReason>())
                        .Select(r => $"{r.Code}: {r.Message}"));
                    Console.WriteLine($"[QA-DIAG] Projection rejected '{scnId}': {codes}");
                }
            }

            // When the orchestrator ran but produced zero merged scenarios,
            // surface the per-zone reason as a degradation flag so the hub
            // can emit an actionable error instead of the generic "configure
            // LLM provider" message. The flags are keyed so the hub can
            // discriminate failure mode.
            if (result.MergedScenarios.Count == 0 && result.Zones.Count > 0)
            {
                var totalAccepted = result.Zones.Sum(z => z.Accepted?.Count ?? 0);
                var totalQuarantined = result.Zones.Sum(z => z.Quarantined?.Count ?? 0);
                var totalProjectionRejected = result.ProjectionRejected?.Count ?? 0;
                var failedZones = result.Zones.Where(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.Failed).ToList();
                var skippedZones = result.Zones.Where(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.SkippedForBudget).ToList();
                var noTestableZones = result.Zones.Where(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.NoTestableChanges).ToList();

                if (failedZones.Count > 0)
                {
                    var firstError = failedZones[0].Errors?.FirstOrDefault() ?? failedZones[0].OutcomeReason ?? "unknown";
                    degradationFlags.Add("llm_v2_zone_failed");
                    PublishWarning(
                        $"LLM_V2_ZONE_FAILED: {failedZones.Count}/{result.Zones.Count} zone(s) failed pipeline "
                        + $"validation — {firstError}. The LLM was called but the response did not pass "
                        + "the Architect/Editor/Validator gates.");
                }
                else if (totalProjectionRejected > 0 && totalAccepted > 0)
                {
                    var firstRejection = result.ProjectionRejected?.FirstOrDefault();
                    var firstReason = firstRejection?.Reasons?.FirstOrDefault();
                    var reasonDetail = firstReason != null
                        ? $" First rejection: {firstReason.Code} — {firstReason.Message}"
                        : string.Empty;
                    degradationFlags.Add("llm_v2_projection_rejected");
                    PublishWarning(
                        $"LLM_V2_PROJECTION_REJECTED: {totalAccepted} scenario(s) accepted by validator "
                        + $"but all {totalProjectionRejected} rejected during projection.{reasonDetail}");
                }
                else if (totalQuarantined > 0 && totalAccepted == 0)
                {
                    // Surface the first quarantine reason for diagnosis
                    var firstQuarantine = result.Zones
                        .Where(z => z.Quarantined != null && z.Quarantined.Count > 0)
                        .SelectMany(z => z.Quarantined)
                        .FirstOrDefault();
                    var firstReason = firstQuarantine?.Reasons?.FirstOrDefault();
                    var reasonDetail = firstReason != null
                        ? $" First quarantine: {firstReason.Code} — {firstReason.Message}"
                        : string.Empty;

                    // Log all unique quarantine codes
                    var allCodes = result.Zones
                        .Where(z => z.Quarantined != null)
                        .SelectMany(z => z.Quarantined)
                        .SelectMany(q => q.Reasons ?? new List<EdogQaScenarioValidator.QuarantineReason>())
                        .Select(r => r.Code)
                        .Where(c => !string.IsNullOrEmpty(c))
                        .Distinct()
                        .ToList();
                    Console.WriteLine($"[QA-DIAG] Quarantine codes: [{string.Join(", ", allCodes)}]");

                    degradationFlags.Add("llm_v2_all_quarantined");
                    PublishWarning(
                        $"LLM_V2_ALL_QUARANTINED: Editor produced {totalQuarantined} scenario(s) but all "
                        + $"were quarantined by the validator.{reasonDetail}");
                }
                else if (skippedZones.Count == result.Zones.Count)
                {
                    degradationFlags.Add("llm_v2_budget_all_skipped");
                    PublishWarning(
                        $"LLM_V2_BUDGET_ALL_SKIPPED: All {skippedZones.Count} zone(s) were skipped because "
                        + $"the budget gate tripped ({result.BudgetGateReason}) before any zone could run.");
                }
                else if (noTestableZones.Count > 0 && noTestableZones.Count == result.Zones.Count)
                {
                    degradationFlags.Add("llm_v2_no_testable_changes");
                    PublishWarning(
                        $"LLM_V2_NO_TESTABLE_CHANGES: Architect determined all {noTestableZones.Count} zone(s) "
                        + "have no testable behavior changes (comment-only, whitespace, generated files).");
                }
            }

            if (result.BudgetGateTripped)
            {
                var skippedCount = result.Zones.Count(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.SkippedForBudget);
                if (skippedCount > 0)
                {
                    // Real degradation: zones were dropped to stay under budget.
                    // The reason from the orchestrator is e.g. "BUDGET_EXCEEDED_COST".
                    // The flag is already prefixed with "llm_v2_budget_", so strip
                    // the redundant leading "budget_" from the reason before
                    // appending — otherwise the UI would render the resulting
                    // QaAnalysisWarning as "Analysis degraded: llm v2 budget
                    // budget exceeded cost" (double "budget").
                    var reasonText = (result.BudgetGateReason ?? "exceeded").ToLowerInvariant();
                    if (reasonText.StartsWith("budget_", StringComparison.Ordinal))
                    {
                        reasonText = reasonText.Substring("budget_".Length);
                    }
                    degradationFlags.Add("llm_v2_budget_" + reasonText);
                    PublishWarning($"LLM_V2 budget tripped: {result.BudgetGateReason} — accepted {result.MergedScenarios.Count} scenario(s), {skippedCount} dropped to stay under budget.");
                }
                else
                {
                    // Gate tripped on the way out but no zones were actually
                    // skipped (e.g. the cap was reached on the final zone after
                    // all work had completed). Nothing was lost, so don't add a
                    // "degraded" flag or scream at the user; just log it so the
                    // signal is available for operators tuning the cap.
                    Console.WriteLine($"[EDOG-QA] LLM_V2 budget reached after completing all {result.MergedScenarios.Count} scenarios (reason: {result.BudgetGateReason}). No scenarios dropped.");
                }
            }

            return PostProcessScenarios(result.MergedScenarios.ToList());
        }

        private async Task RunV2ShadowAsync(
            List<ImpactZone> zones,
            string diff,
            PrContext prContext,
            int legacyScenarioCount,
            CancellationToken cancellationToken)
        {
            // Linked CTS with a bounded deadline so a hung V2 call can't
            // outlive the analysis. Caller cancellation propagates.
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            linked.CancelAfter(TimeSpan.FromSeconds(120));
            try
            {
                var v2Scenarios = await RunV2OrchestratorAsync(zones, diff, prContext, new List<string>(), allowLegacyFallback: true, linked.Token).ConfigureAwait(false);
                PublishWarning($"[shadow] LLM_V2 produced {(v2Scenarios?.Count ?? 0)} scenario(s); legacy produced {legacyScenarioCount}.");
            }
            catch (OperationCanceledException)
            {
                // Shadow timeout / caller cancel — silent.
            }
            catch (Exception ex)
            {
                PublishWarning($"[shadow] LLM_V2 failed silently: {ex.GetType().Name}: {ex.Message}");
            }
        }

        // ──────────────────────────────────────────────
        // PE-1 / PA-1 / PE-6: V2-prompt enrichment helpers
        // ──────────────────────────────────────────────

        /// <summary>
        /// PE-1: render a trusted PR_INTENT block for the Architect from the
        /// upstream <see cref="PrContext"/>. The block names the headline behavioural
        /// change so the model orients on it before enumerating peripheral
        /// edge cases. Returns an empty string when no usable metadata exists;
        /// the prompt builder then omits the entire block.
        /// </summary>
        internal static string BuildPrIntentSummary(PrContext prContext)
        {
            if (prContext == null) return string.Empty;

            var sb = new StringBuilder();
            if (!string.IsNullOrWhiteSpace(prContext.Title))
            {
                sb.Append("TITLE: ").AppendLine(prContext.Title.Trim());
            }
            if (!string.IsNullOrWhiteSpace(prContext.Description))
            {
                var desc = prContext.Description.Trim();
                if (desc.Length > 1200) desc = desc.Substring(0, 1200) + "…";
                sb.Append("DESCRIPTION: ").AppendLine(desc);
            }
            if (prContext.WorkItems != null && prContext.WorkItems.Count > 0)
            {
                sb.AppendLine("WORK_ITEMS:");
                foreach (var wi in prContext.WorkItems.Take(5))
                {
                    if (wi == null) continue;
                    var title = (wi.Title ?? string.Empty).Trim();
                    if (title.Length > 200) title = title.Substring(0, 200) + "…";
                    sb.Append("  - AB#").Append(wi.Id).Append(": ").AppendLine(title);
                }
            }
            return sb.ToString().TrimEnd();
        }

        /// <summary>
        /// PE-6: render a structured ZONE_SUMMARY that names the primary change,
        /// the up-to-5 highest-directness entry points, and the affected
        /// interfaces. Replaces the previous "community-id or method-name"
        /// summary that gave the Architect no orientation cue.
        /// </summary>
        internal static string BuildZoneSummary(ImpactZone z, string catalogRefJson = null)
        {
            if (z == null) return string.Empty;

            var sb = new StringBuilder();
            var primary = z.PrimaryChange?.Method ?? z.Community ?? "unknown";
            var primaryFile = z.PrimaryChange?.File;
            sb.Append("primary_change: ").Append(primary);
            if (!string.IsNullOrWhiteSpace(primaryFile)) sb.Append(" (").Append(primaryFile).Append(")");
            sb.AppendLine();

            var onlyDiInvocation = z.EntryPoints != null
                && z.EntryPoints.Count > 0
                && z.EntryPoints.All(ep => ep.StimulusType == StimulusType.DiInvocation);

            if (z.EntryPoints != null && z.EntryPoints.Count > 0)
            {
                sb.AppendLine("entry_points:");
                foreach (var ep in z.EntryPoints.Take(5))
                {
                    if (ep == null) continue;
                    var node = ep.Node ?? string.Empty;
                    sb.Append("  - ").Append(ep.StimulusType).Append(' ').Append(node)
                      .Append(" (depth=").Append(ep.Depth)
                      .Append(", directness=").Append(ep.DirectnessScore.ToString("F2", System.Globalization.CultureInfo.InvariantCulture))
                      .AppendLine(")");
                }
            }

            // When graph-based BFS only found DiInvocation, inject ALL
            // available stimulus types from the catalog so the Architect
            // knows which entry points exist beyond what the graph traced.
            if (onlyDiInvocation && !string.IsNullOrWhiteSpace(catalogRefJson))
            {
                try
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(catalogRefJson);
                    if (doc.RootElement.TryGetProperty("slots", out var slots)
                        && slots.ValueKind == System.Text.Json.JsonValueKind.Array)
                    {
                        var slotsByKind = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
                        foreach (var slot in slots.EnumerateArray())
                        {
                            var kind = slot.TryGetProperty("kind", out var k) && k.ValueKind == System.Text.Json.JsonValueKind.String
                                ? k.GetString() : null;
                            var slotId = slot.TryGetProperty("slotId", out var sid) && sid.ValueKind == System.Text.Json.JsonValueKind.String
                                ? sid.GetString() : null;
                            if (string.IsNullOrEmpty(kind) || string.IsNullOrEmpty(slotId)) continue;
                            if (!slotsByKind.TryGetValue(kind, out var list))
                            {
                                list = new List<string>();
                                slotsByKind[kind] = list;
                            }
                            list.Add(slotId);
                        }

                        if (slotsByKind.Count > 0)
                        {
                            sb.AppendLine("available_stimulus_types_from_catalog (prefer these over DiInvocation when the changed code is reachable through them):");
                            foreach (var kvp in slotsByKind)
                            {
                                sb.Append("  ").Append(kvp.Key).Append(" (").Append(kvp.Value.Count).AppendLine(" slots):");
                                foreach (var route in kvp.Value.Take(8))
                                    sb.Append("    - ").AppendLine(route);
                                if (kvp.Value.Count > 8)
                                    sb.Append("    ... and ").Append(kvp.Value.Count - 8).AppendLine(" more");
                            }
                        }
                    }
                }
                catch { /* catalog parse failure is non-fatal */ }
            }

            if (z.AffectedInterfaces != null && z.AffectedInterfaces.Count > 0)
            {
                sb.Append("affected_interfaces: ").AppendLine(string.Join(", ", z.AffectedInterfaces.Take(8)));
            }

            if (z.InterceptorTopics != null && z.InterceptorTopics.Count > 0)
            {
                sb.Append("inferred_topics: ").AppendLine(string.Join(", ", z.InterceptorTopics.Take(8)));
            }

            return sb.ToString().TrimEnd();
        }

        /// <summary>
        /// PA-1: split a unified diff into (impl, test) halves by classifying
        /// each <c>diff --git</c> block by its file path. A hunk is "test" when
        /// the path contains <c>/test/</c>, <c>/tests/</c>, ends with
        /// <c>Tests.cs</c>, or contains <c>.spec.</c>. Everything else (including
        /// unparseable preamble) goes to "impl" so the Architect never loses
        /// data even if the splitter degrades. The full diff is preserved
        /// upstream via <c>ZoneInput.UnifiedDiff</c> for Validator binding.
        /// </summary>
        internal static (string implDiff, string testDiff) SplitDiffByPath(string unifiedDiff)
        {
            if (string.IsNullOrEmpty(unifiedDiff)) return (string.Empty, string.Empty);

            // Walk the diff line-by-line; a new file block starts at "diff --git"
            // (preferred) or at the "+++ b/<path>" line (fallback for diffs that
            // omitted the git header). We append each line to whichever bucket
            // the current file path indicates.
            var implSb = new StringBuilder();
            var testSb = new StringBuilder();
            StringBuilder currentBucket = implSb; // preamble → impl (safe default)
            string currentPath = null;

            foreach (var rawLine in unifiedDiff.Split('\n'))
            {
                var line = rawLine.TrimEnd('\r');

                if (line.StartsWith("diff --git ", StringComparison.Ordinal))
                {
                    // Parse path from "diff --git a/<path> b/<path>"
                    currentPath = ExtractDiffGitPath(line);
                    currentBucket = ClassifyDiffPath(currentPath) ? testSb : implSb;
                }
                else if ((line.StartsWith("+++ b/", StringComparison.Ordinal)
                         || line.StartsWith("+++ B/", StringComparison.Ordinal))
                         && currentPath == null)
                {
                    // Fallback: no diff --git header (e.g. plain unified diff).
                    currentPath = line.Length > 6 ? line.Substring(6) : null;
                    currentBucket = ClassifyDiffPath(currentPath) ? testSb : implSb;
                }

                currentBucket.Append(line).Append('\n');
            }

            return (implSb.ToString(), testSb.ToString());
        }

        private static string ExtractDiffGitPath(string diffGitLine)
        {
            // "diff --git a/<path> b/<path>" — take the b-side path (post-change).
            var bMarker = " b/";
            var idx = diffGitLine.IndexOf(bMarker, StringComparison.Ordinal);
            if (idx < 0) return null;
            var path = diffGitLine.Substring(idx + bMarker.Length).Trim();
            return path.Length == 0 ? null : path;
        }

        private static bool ClassifyDiffPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            var p = path.Replace('\\', '/');
            var lower = p.ToLowerInvariant();
            if (lower.Contains("/test/") || lower.Contains("/tests/")) return true;
            if (lower.EndsWith("tests.cs", StringComparison.Ordinal)) return true;
            if (lower.EndsWith(".test.cs", StringComparison.Ordinal)) return true;
            if (lower.Contains(".spec.")) return true;
            if (lower.EndsWith(".spec.ts", StringComparison.Ordinal) || lower.EndsWith(".spec.js", StringComparison.Ordinal)) return true;
            return false;
        }

        private async Task<List<Scenario>> GenerateScenariosForZoneSafe(
            ImpactZone zone,
            CodeGraph graph,
            List<InterfaceResolution> resolutions,
            string diff,
            PrContext prContext,
            List<string> degradationFlags,
            CancellationToken cancellationToken)
        {
            var request = new LlmPromptRequest
            {
                Zone = zone,
                DiffContent = diff,
                Graph = graph,
                InterfaceResolutions = resolutions,
                DiRegistrations = _diRegistryProvider.IsAvailable
                    ? _diRegistryProvider.GetAll()
                    : new List<DiRegistration>(),
                ValidTopics = ValidTopics,
                PrContext = prContext,
            };

            try
            {
                EdogQaTelemetry.IncrementLlmCall();
                return await _llmProvider.GenerateScenariosAsync(request, cancellationToken);
            }
            catch (OperationCanceledException) { throw; }
            catch (LlmProviderException llmEx)
            {
                EdogQaTelemetry.IncrementLlmError();

                // F27 P4: only retry transient kinds (timeout, rate-limit,
                // 5xx-network). Auth/parse/4xx-client failures will not
                // succeed on retry — bubble immediately so the hub can
                // emit a typed QaError and the studio can render an
                // actionable message instead of pretending the work was
                // done with synthetic placeholders.
                if (!llmEx.Retryable)
                {
                    PublishWarning($"LLM failed for zone {zone.ZoneId} ({llmEx.KindCode}, non-retryable): {llmEx.Message}");
                    throw;
                }

                PublishWarning($"LLM retry for zone {zone.ZoneId} ({llmEx.KindCode}): {llmEx.Message}");

                try
                {
                    EdogQaTelemetry.IncrementLlmCall();
                    return await _llmProvider.GenerateScenariosAsync(request, cancellationToken);
                }
                catch (OperationCanceledException) { throw; }
                catch (LlmProviderException retryEx)
                {
                    EdogQaTelemetry.IncrementLlmError();
                    PublishWarning($"LLM retry exhausted for zone {zone.ZoneId} ({retryEx.KindCode}): {retryEx.Message}");
                    throw;
                }
                catch (Exception unexpected)
                {
                    EdogQaTelemetry.IncrementLlmError();
                    throw LlmProviderExceptionClassifier.Classify(unexpected, cancellationToken);
                }
            }
            catch (Exception ex)
            {
                // Defensive: any non-LlmProviderException reaching here is
                // a programming error in EdogQaLlmProvider (it should now
                // only ever throw typed). Classify on the way out so the
                // hub never sees a raw transport exception.
                EdogQaTelemetry.IncrementLlmError();
                PublishWarning($"LLM unexpected error for zone {zone.ZoneId}: {ex.Message}");
                throw LlmProviderExceptionClassifier.Classify(ex, cancellationToken);
            }
        }

        /// <summary>
        /// Post-process generated scenarios: validate topic references, assign IDs,
        /// strip invalid expectations that reference non-existent topics.
        /// </summary>
        private static List<Scenario> PostProcessScenarios(List<Scenario> scenarios)
        {
            int scenarioIndex = 0;
            foreach (var scenario in scenarios)
            {
                // Assign stable IDs if missing
                if (string.IsNullOrEmpty(scenario.Id))
                {
                    scenarioIndex++;
                    var slug = (scenario.Title ?? "untitled")
                        .ToLowerInvariant()
                        .Replace(' ', '-');
                    if (slug.Length > 40) slug = slug.Substring(0, 40);
                    var hash = Math.Abs(scenario.GetHashCode()).ToString("x4");
                    if (hash.Length > 4) hash = hash.Substring(0, 4);
                    scenario.Id = $"scn-{slug}-{hash}";
                }

                // Validate expectation topic references
                if (scenario.Expectations != null)
                {
                    scenario.Expectations = scenario.Expectations
                        .Where(e => string.IsNullOrEmpty(e.Topic) || ValidTopics.Contains(e.Topic))
                        .ToList();

                    // Assign expectation IDs
                    for (int i = 0; i < scenario.Expectations.Count; i++)
                    {
                        if (string.IsNullOrEmpty(scenario.Expectations[i].Id))
                            scenario.Expectations[i].Id = $"exp-{i + 1}";
                    }
                }

                // Set metadata defaults
                scenario.Metadata ??= new ScenarioMetadata();
                if (string.IsNullOrEmpty(scenario.Metadata.GeneratedBy))
                    scenario.Metadata.GeneratedBy = "ai";
                if (scenario.Metadata.GeneratedAt == default)
                    scenario.Metadata.GeneratedAt = DateTimeOffset.UtcNow;
            }

            return scenarios;
        }

        // ──────────────────────────────────────────────
        // Progress & Diagnostics
        // ──────────────────────────────────────────────

        private long _analysisStartMs;

        private void ReportProgress(string phase, int percent, string message, List<string> warnings = null)
        {
            if (percent <= 5) _analysisStartMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            var cb = _activeCallback ?? _onProgress;
            cb(new AnalysisProgress
            {
                Phase = phase,
                PercentComplete = percent,
                Message = message,
                Warnings = warnings ?? new List<string>(),
                ElapsedMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _analysisStartMs,
            });
        }

        private void PublishWarning(string message)
        {
            try
            {
                Console.WriteLine($"[EDOG-QA] ⚠ {message}");

                // Surface through progress callback so Hub can broadcast to frontend
                var cb = _activeCallback ?? _onProgress;
                cb(new AnalysisProgress
                {
                    Phase = "warning",
                    PercentComplete = -1,
                    Message = message,
                    Warnings = new List<string> { message },
                    ElapsedMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _analysisStartMs,
                });
            }
            catch
            {
                // Non-fatal — never let diagnostics crash the pipeline
            }
        }

        /// <summary>
        /// Walk up from CWD or EDOG_FLT_SOURCE_ROOT looking for a .sln file.
        /// </summary>
        private static string FindSolutionFile()
        {
            var envRoot = Environment.GetEnvironmentVariable("EDOG_FLT_SOURCE_ROOT");
            var startDir = !string.IsNullOrEmpty(envRoot) && Directory.Exists(envRoot)
                ? new DirectoryInfo(envRoot)
                : new DirectoryInfo(Directory.GetCurrentDirectory());

            var dir = startDir;
            while (dir != null)
            {
                var slnFiles = dir.GetFiles("*.sln");
                if (slnFiles.Length > 0)
                {
                    return slnFiles[0].FullName;
                }
                dir = dir.Parent;
            }

            return null;
        }
    }

    // ──────────────────────────────────────────────
    // Stub Implementations (placeholders for real tool integration)
    // ──────────────────────────────────────────────

    /// <summary>
    /// Stub L1+L2 graph provider. Returns a minimal graph from changed symbols.
    /// Replace with real code-review-graph + Graphify MCP tool integration.
    ///
    /// Increments <see cref="EdogQaTelemetry"/> on every call so the studio
    /// banner and integration tests can detect when the engine is running on
    /// stub graph data instead of the real provider.
    /// </summary>
    public sealed class StubGraphProvider : IGraphProvider
    {
        /// <inheritdoc />
        public Task<CodeGraph> BuildStructuralGraphAsync(
            List<ChangedSymbol> changedSymbols,
            int maxDepth = 4,
            CancellationToken cancellationToken = default)
        {
            EdogQaTelemetry.IncrementStubGraphProviderCall();
            var graph = new CodeGraph();
            GraphNode prevNode = null;

            foreach (var symbol in changedSymbols)
            {
                var nodeId = $"{symbol.File}:{symbol.Method}";
                var node = new GraphNode
                {
                    Id = nodeId,
                    File = symbol.File,
                    Method = symbol.Method,
                    NodeType = "method",
                    IsChanged = true,
                    Community = $"community-{Math.Abs(symbol.File.GetHashCode()) % 5}",
                };
                graph.AddNode(node);
                graph.Communities[nodeId] = node.Community;

                // Create edges between sequential symbols (stub connectivity).
                // Each fake edge increments telemetry so the UI can warn that
                // the graph is fabricated rather than derived from real call flow.
                if (prevNode != null)
                {
                    graph.AddEdge(new GraphEdge
                    {
                        Source = prevNode.Id,
                        Target = nodeId,
                        EdgeType = "direct_call",
                        Source_ = "l1",
                    });
                    EdogQaTelemetry.IncrementGraphStubConnectivityEdge();
                }
                prevNode = node;
            }

            return Task.FromResult(graph);
        }
    }

    /// <summary>
    /// Stub L3 OmniSharp provider. Returns no semantic enrichment.
    /// Replace with real OmniSharp LSP integration.
    ///
    /// Increments <see cref="EdogQaTelemetry"/> on each call so the studio
    /// banner and integration tests can detect when semantic enrichment was
    /// skipped entirely.
    /// </summary>
    public sealed class StubOmniSharpProvider : IOmniSharpProvider
    {
        /// <inheritdoc />
        public bool IsReady => false;

        /// <inheritdoc />
        public Task WarmUpAsync(string solutionPath, CancellationToken cancellationToken = default)
        {
            EdogQaTelemetry.IncrementStubOmniSharpProviderCall();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task EnrichGraphAsync(
            CodeGraph graph,
            List<ChangedSymbol> changedSymbols,
            int maxConcurrentQueries = 4,
            CancellationToken cancellationToken = default)
        {
            EdogQaTelemetry.IncrementStubOmniSharpProviderCall();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task<List<string>> FindImplementationsAsync(
            string interfaceType,
            CancellationToken cancellationToken = default)
        {
            EdogQaTelemetry.IncrementStubOmniSharpProviderCall();
            return Task.FromResult(new List<string>());
        }

        /// <inheritdoc />
        public Task<List<CallerInfo>> GetIncomingCallsAsync(
            string filePath,
            string methodName,
            int maxDepth = 4,
            CancellationToken cancellationToken = default)
        {
            EdogQaTelemetry.IncrementStubOmniSharpProviderCall();
            return Task.FromResult(new List<CallerInfo>());
        }
    }

    /// <summary>
    /// Stub L4 LLM provider. Returns empty scenario list.
    /// Replace with real GPT-5.4-pro integration.
    ///
    /// Each call increments <see cref="EdogQaTelemetry"/> and tags scenarios
    /// with <c>GeneratedBy = "stub_llm"</c> so the curation UI can render a
    /// PLACEHOLDER badge — users must never see these as real AI output.
    /// </summary>
    public sealed class StubLlmProvider : ILlmProvider
    {
        /// <inheritdoc />
        public Task<List<Scenario>> GenerateScenariosAsync(
            LlmPromptRequest request,
            CancellationToken cancellationToken = default)
        {
            EdogQaTelemetry.IncrementStubLlmProviderCall();

            // Return a placeholder scenario for each entry point in the zone
            var scenarios = new List<Scenario>();
            if (request.Zone?.EntryPoints == null) return Task.FromResult(scenarios);

            foreach (var entry in request.Zone.EntryPoints.Take(3))
            {
                scenarios.Add(new Scenario
                {
                    Title = $"Verify {request.Zone.PrimaryChange?.Method ?? "unknown"} via {entry.Node}",
                    Description = $"Stub scenario — triggers {entry.StimulusType} at {entry.Node} to exercise changed code.",
                    Category = ScenarioCategory.HappyPath,
                    Priority = 2,
                    ImpactZone = request.Zone.ZoneId,
                    Lifecycle = ScenarioLifecycle.Generated,
                    Stimulus = CreateStubStimulus(entry),
                    Expectations = new List<Expectation>
                    {
                        new Expectation
                        {
                            Type = ExpectationType.EventPresent,
                            Topic = request.Zone.InterceptorTopics?.FirstOrDefault() ?? "log",
                            Description = $"Event observed for {request.Zone.PrimaryChange?.Method ?? "changed code"}.",
                            Matcher = new LegacyMatcher(),
                        },
                    },
                    Metadata = new ScenarioMetadata
                    {
                        GeneratedBy = "stub_llm",
                        Confidence = 0.5,
                        GeneratedAt = DateTimeOffset.UtcNow,
                        RelatedPRFiles = request.Zone.PrimaryChange != null
                            ? new List<string> { request.Zone.PrimaryChange.File }
                            : new List<string>(),
                    },
                });
            }

            return Task.FromResult(scenarios);
        }

        private static Stimulus CreateStubStimulus(EntryPoint entry)
        {
            return entry.StimulusType switch
            {
                StimulusType.HttpRequest => new Stimulus
                {
                    Type = StimulusType.HttpRequest,
                    HttpRequest = new HttpRequestSpec
                    {
                        Method = "GET",
                        Path = $"/api/v1/stub/{entry.Node.Replace(":", "/")}",
                    },
                },
                StimulusType.DagTrigger => new Stimulus
                {
                    Type = StimulusType.DagTrigger,
                    DagTrigger = new DagTriggerSpec { IterationId = "current" },
                },
                StimulusType.SignalRBroadcast => new Stimulus
                {
                    Type = StimulusType.SignalRBroadcast,
                    SignalRBroadcast = new SignalRBroadcastSpec
                    {
                        Hub = "/hub/playground",
                        Method = entry.Node.Split(':').LastOrDefault() ?? "unknown",
                    },
                },
                _ => new Stimulus
                {
                    Type = StimulusType.DiInvocation,
                    DiInvocation = new DiInvocationSpec
                    {
                        ServiceType = entry.Node.Split(':').FirstOrDefault() ?? "unknown",
                        Method = entry.Node.Split(':').LastOrDefault() ?? "unknown",
                    },
                },
            };
        }
    }

    /// <summary>
    /// Stub L5 DI registry provider. Wraps <see cref="EdogDiRegistryCapture"/> topic data.
    /// Replace with real topic buffer consumption when Connected phase is active.
    /// </summary>
    public sealed class StubDiRegistryProvider : IDiRegistryProvider
    {
        private readonly Dictionary<string, DiRegistration> _snapshot = new();

        /// <inheritdoc />
        public bool IsAvailable => _snapshot.Count > 0;

        /// <inheritdoc />
        public void LoadSnapshot()
        {
            // In real implementation, read from EdogTopicRouter.GetBuffer("di")
            // Stub: pre-populate with known registrations from EdogDiRegistryCapture
            AddRegistration("IFeatureFlighter", "EdogFeatureFlighterWrapper", "Singleton", true, "FeatureFlighter");
            AddRegistration("ISqlEndpointMetadataCache", "EdogCacheInterceptor", "Singleton", true, "SqlEndpointMetadataCache");
            AddRegistration("ISparkClientFactory", "EdogSparkSessionInterceptor", "Singleton", true, "GTSBasedSparkClientFactory");
            AddRegistration("IRetryPolicy", "ExponentialRetryPolicy", "Singleton", false, "ExponentialRetryPolicy");
            AddRegistration("IOneLakeRestClient", "OneLakeRestClient", "Singleton", false, "OneLakeRestClient");
            AddRegistration("IDagExecutionStore", "DagExecutionStore", "Singleton", false, "DagExecutionStore");
            AddRegistration("IFabricApiClient", "FabricApiClient", "Singleton", false, "FabricApiClient");
        }

        /// <inheritdoc />
        public DiRegistration Resolve(string interfaceType) =>
            _snapshot.TryGetValue(interfaceType, out var reg) ? reg : null;

        /// <inheritdoc />
        public List<DiRegistration> GetAll() => _snapshot.Values.ToList();

        /// <inheritdoc />
        public InterfaceValidation ValidateMapping(string interfaceType, string inferredImpl)
        {
            var reg = Resolve(interfaceType);
            if (reg == null)
            {
                return new InterfaceValidation
                {
                    Status = "unregistered",
                    ConfidenceDelta = 0,
                };
            }

            if (reg.OriginalImplementation == inferredImpl || reg.ImplementationType == inferredImpl)
            {
                return new InterfaceValidation
                {
                    Status = "confirmed",
                    ConfidenceDelta = 0.3,
                };
            }

            return new InterfaceValidation
            {
                Status = "conflict",
                ConfidenceDelta = -0.4,
                ActualImplementation = reg.ImplementationType,
                Note = $"Roslyn says {inferredImpl}, DI says {reg.ImplementationType}",
            };
        }

        private void AddRegistration(
            string serviceType,
            string implType,
            string lifetime,
            bool intercepted,
            string originalImpl)
        {
            _snapshot[serviceType] = new DiRegistration
            {
                ServiceType = serviceType,
                ImplementationType = implType,
                Lifetime = lifetime,
                IsEdogIntercepted = intercepted,
                OriginalImplementation = originalImpl,
                RegistrationPhase = "Constructor",
            };
        }
    }
}
