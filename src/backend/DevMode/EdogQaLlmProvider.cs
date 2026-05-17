// <copyright file="EdogQaLlmProvider.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Net.Http;
    using System.Text;
    using System.Text.Json;
    using System.Text.Json.Serialization;
    using System.Threading;
    using System.Threading.Tasks;

    /// <summary>
    /// L4 LLM provider for generating QA scenarios by calling Azure OpenAI Chat Completions API.
    /// Reads configuration from environment variables and constructs structured prompts
    /// from enriched code graph data, DI registrations, and interface resolutions.
    /// </summary>
    internal sealed class EdogQaLlmProvider : ILlmProvider, IDisposable
    {
        private const int MaxDiffChars = 8000;
        private const int HttpTimeoutSeconds = 300;
        private const string DevServerProxyUrl = "http://localhost:5555/api/openai-proxy/chat";

        // F27 "pinnacle" contract-section caps (item 1). Each section is
        // independently capped so a single huge field cannot starve the
        // others of token budget. Total contract overhead capped at ~12K
        // chars, leaving ample room for diff + graph + DI sections.
        private const int MaxPrDescriptionChars = 2000;
        private const int MaxAcceptanceCriteriaCharsPerWorkItem = 800;
        private const int MaxWorkItemsRendered = 3;
        private const int MaxSpecExcerptChars = 2500;
        private const int MaxSpecExcerptsRendered = 2;
        private const int MaxCatalogEndpointsRendered = 40;
        private const int MaxPriorTestMethodsRendered = 60;

        private readonly HttpClient _httpClient;
        private readonly string _endpoint;
        private readonly string _apiKey;
        private readonly string _apiVersion;
        private readonly string _deployment;
        private readonly bool _isConfigured;
        private readonly bool _useProxy;

        /// <summary>
        /// Test-only seam used by the F27 P4 E2E classification harness.
        /// Allows the harness to swap in an <see cref="HttpClient"/> backed
        /// by a fake <see cref="HttpMessageHandler"/> so the timeout / 4xx
        /// / 5xx / parse classification matrix can be exercised without
        /// binding to a real port or hitting Azure OpenAI.
        ///
        /// Production code must use the parameterless constructor.
        /// </summary>
        internal EdogQaLlmProvider(HttpClient httpClient, bool useProxy = false, string endpoint = null, string apiKey = null)
        {
            _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
            _useProxy = useProxy;
            _endpoint = endpoint ?? "https://test.invalid/";
            _apiKey = apiKey ?? "test";
            _apiVersion = "test-version";
            _deployment = "test-deployment";
            _isConfigured = true;
        }

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogQaLlmProvider"/> class.
        /// Reads Azure OpenAI configuration from environment variables.
        /// Falls back to dev-server proxy when env vars are missing.
        /// </summary>
        public EdogQaLlmProvider()
        {
            // Try PRO endpoint first, fall back to base
            _endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_ENDPOINT")
                ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT");

            _apiKey = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_API_KEY")
                ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_KEY");

            _apiVersion = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_API_VERSION")
                ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_VERSION")
                ?? "2025-03-01-preview";

            _deployment = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_DEPLOYMENT")
                ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_DEPLOYMENT")
                ?? "gpt-5.4-pro";

            var hasDirectCreds = !string.IsNullOrEmpty(_endpoint) && !string.IsNullOrEmpty(_apiKey);

            if (hasDirectCreds)
            {
                _isConfigured = true;
                _useProxy = false;
                _httpClient = new HttpClient
                {
                    Timeout = TimeSpan.FromSeconds(HttpTimeoutSeconds)
                };
                Console.WriteLine($"[EDOG] LLM provider configured (direct): endpoint={_endpoint}, deployment={_deployment}");
            }
            else
            {
                // No direct creds — use dev-server proxy which reads from donna-app/.env
                _isConfigured = true;
                _useProxy = true;
                _httpClient = new HttpClient
                {
                    Timeout = TimeSpan.FromSeconds(HttpTimeoutSeconds)
                };
                Console.WriteLine($"[EDOG] LLM provider configured (proxy): {DevServerProxyUrl}");
            }
        }

        /// <summary>
        /// Generate test scenarios for a single impact zone using Azure OpenAI.
        /// Returns empty list if not configured or on errors (logs warnings).
        /// </summary>
        /// <param name="request">Structured prompt input with zone, graph, DI, and diff context.</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        /// <returns>List of AI-generated scenarios with stimuli and expectations.</returns>
        public async Task<List<Scenario>> GenerateScenariosAsync(
            LlmPromptRequest request,
            CancellationToken cancellationToken = default)
        {
            if (!_isConfigured)
            {
                EdogQaTelemetry.IncrementLlmError();
                throw new LlmProviderException(
                    LlmProviderErrorKind.Auth,
                    "LLM provider not configured. Set AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY (or PRO equivalents) " +
                    "or run the dev-server proxy that proxies to a configured donna-app/.env.",
                    retryable: false);
            }

            try
            {
                var systemPrompt = BuildSystemPrompt();
                var userMessage = BuildUserMessage(request);

                var response = await CallAzureOpenAIAsync(systemPrompt, userMessage, cancellationToken);
                var scenarios = ParseResponse(response, request.Zone.ZoneId);

                Console.WriteLine($"[EDOG] Generated {scenarios.Count} scenarios for zone {request.Zone.ZoneId}");
                return scenarios;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // User-initiated cancellation — let it bubble untouched.
                throw;
            }
            catch (LlmProviderException)
            {
                // Already classified by ParseResponse / classifier — rethrow without re-wrapping.
                EdogQaTelemetry.IncrementLlmError();
                throw;
            }
            catch (Exception ex)
            {
                EdogQaTelemetry.IncrementLlmError();
                var classified = LlmProviderExceptionClassifier.Classify(ex, cancellationToken);
                Console.WriteLine($"[EDOG] LLM generation failed for zone {request.Zone.ZoneId} " +
                                  $"({classified.KindCode}): {classified.Message}");
                throw classified;
            }
        }

        // ──────────────────────────────────────────────
        // System Prompt Construction
        // ──────────────────────────────────────────────

        /// <summary>
        /// Build the system prompt that instructs the LLM on its task and output format.
        /// </summary>
        private static string BuildSystemPrompt()
        {
            return @"You are an expert test scenario generator for FabricLiveTable (FLT), a C# service in Microsoft Fabric that provides materialized views over data lakes.

Your task is to analyze code changes and generate precise, executable test scenarios. Each scenario consists of:
1. **Stimulus**: How to trigger the system (HTTP request, SignalR call, DAG trigger, file event, timer tick, or direct service invocation)
2. **Expectations**: What events to observe in EDOG interceptor topic buffers (http, retry, cache, log, dag, flt-ops, etc.)

**CRITICAL REQUIREMENTS:**

**Stimulus Types:**
- HttpRequest: HTTP call to FLT Kestrel API (method, path, headers, body)
- SignalrInvoke: SignalR hub method invocation (hub, method, args)
- DagTrigger: Trigger DAG execution (iterationId, nodeFilter)
- FileEvent: Create file in OneLake watched path (path, content, encoding)
- TimerTick: Wait for timer-based event (tickSource, topic, maxWaitMs)
- DirectInvoke: Invoke DI service method directly (serviceType, method, args)

**Expectation Types:**
- EventPresent: Event must appear in topic buffer
- EventAbsent: Event must NOT appear
- EventCount: Count must match min/max/exact
- EventOrder: Event must appear after another expectation
- Timing: Event must appear within time window (withinMs, afterMs)
- FieldMatch: Event fields must match exact/contains/regex/range predicates

**Matcher Fields:**
- Exact: {field: value} for exact equality (case-sensitive)
- Contains: {field: substring} for substring match (case-insensitive)
- Regex: {field: pattern} for regex match
- Range: {field: {min?, max?}} for numeric range
- Exists: [field1, field2] for presence check

**Topic Context:**
Use the provided ValidTopics list to choose which interceptor topics to query. Common topics:
- http: HTTP request/response events (statusCode, path, method, durationMs)
- retry: Retry policy events (attemptNumber, delayMs, outcome)
- cache: Cache hit/miss events (key, operation, hit)
- dag: DAG node execution (nodeId, status, durationMs)
- flt-ops: FLT-specific operations (operation, tableName, status)
- log: Structured log entries (level, message, context)

**Output Format:**
Return JSON with a 'scenarios' array. Each scenario:
{
  ""title"": ""100-char max, describes what is being tested"",
  ""description"": ""500-char max, explains the test rationale and expected behavior"",
  ""category"": ""HappyPath|ErrorPath|EdgeCase|Regression|Performance"",
  ""priority"": 1-5 (1=critical, 5=nice-to-have),
  ""confidence"": 0.0-1.0 (your certainty this scenario is valid),
  ""stimulus"": {
    ""type"": ""HttpRequest"",
    ""httpRequest"": {
      ""method"": ""POST"",
      ""path"": ""/api/v1/..."",
      ""headers"": {},
      ""body"": {}
    }
  },
  ""expectations"": [
    {
      ""id"": ""exp-1"",
      ""type"": ""EventPresent"",
      ""topic"": ""http"",
      ""matcher"": {
        ""exact"": { ""statusCode"": 200 },
        ""contains"": { ""path"": ""/api"" }
      },
      ""timeWindow"": { ""withinMs"": 5000 },
      ""description"": ""HTTP 200 response within 5s""
    }
  ],
  ""timeoutMs"": 30000,
  ""technique"": ""BoundaryTriplet|Counterfactual|TruthTable|EquivalencePartition|ErrorPath|RegressionGuard|HappyPath"",
  ""invariantsAddressed"": [""inv-numeric_constant-abc123""],
  ""groundingEvidence"": [
    {
      ""file"": ""Service/.../LiveTableInsightsController.cs"",
      ""startLine"": 47,
      ""endLine"": 63,
      ""reason"": ""Window-validation guard added in PR; this scenario covers the just-above-cap path."",
      ""invariantId"": ""inv-numeric_constant-abc123""
    }
  ]
}

**Required new fields (F27 pinnacle):**
- `technique`: which test-design technique generated this scenario. Required, non-NotSpecified. See TECHNIQUES section below for mapping from invariant kind.
- `invariantsAddressed`: list of invariant IDs (from the ""Code Invariants Detected in Diff"" section in the user message) this scenario covers. At least one entry required when any invariants were detected. Multi-invariant scenarios (e.g. a boundary triplet that also exercises the matching explicit_error throw) cite all relevant IDs.
- `groundingEvidence`: list of {file, startLine, endLine, reason, invariantId?} entries anchoring the scenario to the diff. At least one entry required. `reason` is a short justification (max 240 chars); `invariantId` is optional and must match an entry in `invariantsAddressed` when present.

**Priority Guidance:**
- Focus on ERROR PATHS and EDGE CASES (80% weight)
- Happy paths should be minority (20% weight)
- Use the code graph to identify:
  - Null checks → generate null input scenarios
  - Exception handlers → generate fault injection scenarios
  - Interface boundaries → generate interface contract violations
  - Retry logic → generate transient failure scenarios
  - Cache paths → generate cache invalidation scenarios

**Use DI Context:**
- Interface resolutions show actual runtime implementations
- Generate expectations that validate interface dispatch behavior
- Use 'confidence' scores from interface resolutions to adjust your confidence

**NEVER:**
- Hallucinate API endpoints not in the code change
- Generate expectations for topics not in ValidTopics
- Use ambiguous matchers (always specify exact fields to match)
- Generate duplicate scenarios (each should test a distinct path)

**TECHNIQUES (apply these to invariants surfaced in the user message):**

The user message will include a ""Code Invariants Detected in Diff"" section. For each invariant kind, use the matching technique below. Each invariant ID (e.g. ""inv-numeric_constant-abc123"") MUST be cited in at least one scenario's description.

1. *numeric_constant* / *temporal_threshold* → **Boundary triplet**: emit three scenarios — at the boundary, just below (valid), and just above (invalid). Example: const ""MaxStrictDateRangeDays = 60"" with a guard ""endTime - startTime > TimeSpan.FromDays(60)"" yields scenarios with 59-day, 60-day, and 61-day windows.

2. *removed_parameter* → **Counterfactual**: emit a scenario sending the removed parameter and assert the new behavior (silently ignored OR rejected — pick based on the PR description / AC; if ambiguous, lean ""silently ignored"" because OpenAPI removal is non-breaking by convention).

3. *added_parameter* (multiple on same method) → **Truth-table grid**: for two added parameters with null-defaultable types, emit the full 2x2 — (null,null), (null,set), (set,null), (set,set). For three params emit a curated 2^3 subset of the four most-distinct cells.

4. *comparison_predicate* → **Equivalence partition** plus boundary: at least one scenario in each side of the comparison (e.g. ""x > MaxLimit"" produces ""x = MaxLimit"" boundary plus ""x = MaxLimit + 1"" failure plus ""x = 0"" baseline).

5. *explicit_error* → **Error-path coverage**: one scenario that triggers the throw site exactly, with EventPresent assertion on the http event having statusCode matching the exception's HTTP mapping and body.message containing the literal error text.

**FEW-SHOT EXEMPLARS:**

Below are abbreviated example outputs for the most common invariant patterns. They show shape and rigor — your real output will differ in path, fields, and topic specifics.

Example A — Boundary triplet around ""inv-numeric_constant-MaxStrictDateRangeDays=60"":
{
  ""scenarios"": [
    {
      ""title"": ""59-day window: just below 60-day cap returns 200"",
      ""description"": ""Boundary-below test for inv-numeric_constant-MaxStrictDateRangeDays. Covers the largest accepted window per the new strict-range guard."",
      ""category"": ""EdgeCase"",
      ""priority"": 2,
      ""technique"": ""BoundaryTriplet"",
      ""invariantsAddressed"": [""inv-numeric_constant-MaxStrictDateRangeDays""],
      ""groundingEvidence"": [{ ""file"": ""Service/.../LiveTableInsightsController.cs"", ""startLine"": 47, ""endLine"": 63, ""reason"": ""Strict-range guard added; this is the just-below-cap path."", ""invariantId"": ""inv-numeric_constant-MaxStrictDateRangeDays"" }],
      ""stimulus"": { ""type"": ""HttpRequest"", ""httpRequest"": { ""method"": ""GET"", ""path"": ""/api/v1/insights/summary?startTime=2025-03-13T00:00:00Z&endTime=2025-05-11T00:00:00Z"" }},
      ""expectations"": [{ ""id"": ""exp-1"", ""type"": ""EventPresent"", ""topic"": ""http"", ""matcher"": { ""exact"": { ""statusCode"": 200 }}, ""timeWindow"": { ""withinMs"": 5000 }}]
    },
    {
      ""title"": ""60-day window: exactly at cap returns 200"",
      ""description"": ""Boundary-exact test for inv-numeric_constant-MaxStrictDateRangeDays. The guard uses '>' not '>=' so 60d must succeed."",
      ""category"": ""EdgeCase"",
      ""priority"": 1,
      ""technique"": ""BoundaryTriplet"",
      ""invariantsAddressed"": [""inv-numeric_constant-MaxStrictDateRangeDays""],
      ""groundingEvidence"": [{ ""file"": ""Service/.../LiveTableInsightsController.cs"", ""startLine"": 47, ""endLine"": 63, ""reason"": ""Boundary equality; '>' guard means 60d is still valid."", ""invariantId"": ""inv-numeric_constant-MaxStrictDateRangeDays"" }],
      ""stimulus"": { ""type"": ""HttpRequest"", ""httpRequest"": { ""method"": ""GET"", ""path"": ""/api/v1/insights/summary?startTime=2025-03-12T00:00:00Z&endTime=2025-05-11T00:00:00Z"" }},
      ""expectations"": [{ ""id"": ""exp-1"", ""type"": ""EventPresent"", ""topic"": ""http"", ""matcher"": { ""exact"": { ""statusCode"": 200 }}, ""timeWindow"": { ""withinMs"": 5000 }}]
    },
    {
      ""title"": ""61-day window: one day over cap returns 400"",
      ""description"": ""Boundary-above test for inv-numeric_constant-MaxStrictDateRangeDays. Covers inv-explicit_error BadRequestException 'Date range cannot exceed' from the same change."",
      ""category"": ""ErrorPath"",
      ""priority"": 1,
      ""technique"": ""BoundaryTriplet"",
      ""invariantsAddressed"": [""inv-numeric_constant-MaxStrictDateRangeDays"", ""inv-explicit_error-BadRequestException""],
      ""groundingEvidence"": [{ ""file"": ""Service/.../LiveTableInsightsController.cs"", ""startLine"": 47, ""endLine"": 63, ""reason"": ""Throw site under the strict-range guard; exercises both invariants."", ""invariantId"": ""inv-explicit_error-BadRequestException"" }],
      ""stimulus"": { ""type"": ""HttpRequest"", ""httpRequest"": { ""method"": ""GET"", ""path"": ""/api/v1/insights/summary?startTime=2025-03-11T00:00:00Z&endTime=2025-05-11T00:00:00Z"" }},
      ""expectations"": [{ ""id"": ""exp-1"", ""type"": ""EventPresent"", ""topic"": ""http"", ""matcher"": { ""exact"": { ""statusCode"": 400 }, ""contains"": { ""body.message"": ""cannot exceed"" }}, ""timeWindow"": { ""withinMs"": 5000 }}]
    }
  ]
}

Example B — Counterfactual for ""inv-removed_parameter-dateRange"":
{
  ""scenarios"": [
    {
      ""title"": ""Legacy dateRange query param is silently ignored"",
      ""description"": ""Counterfactual for inv-removed_parameter-dateRange. Confirms backward-compatible behavior: clients still sending '?dateRange=last7d' get the default 7-day window response (no 400, no error echo)."",
      ""category"": ""Regression"",
      ""priority"": 2,
      ""technique"": ""Counterfactual"",
      ""invariantsAddressed"": [""inv-removed_parameter-dateRange""],
      ""groundingEvidence"": [{ ""file"": ""Service/.../LiveTableInsightsController.cs"", ""startLine"": 33, ""endLine"": 41, ""reason"": ""dateRange [FromQuery] parameter removed in this PR; verify legacy callers don't 400."", ""invariantId"": ""inv-removed_parameter-dateRange"" }],
      ""stimulus"": { ""type"": ""HttpRequest"", ""httpRequest"": { ""method"": ""GET"", ""path"": ""/api/v1/insights/summary?dateRange=last7d"" }},
      ""expectations"": [
        { ""id"": ""exp-1"", ""type"": ""EventPresent"", ""topic"": ""http"", ""matcher"": { ""exact"": { ""statusCode"": 200 }}, ""timeWindow"": { ""withinMs"": 5000 }},
        { ""id"": ""exp-2"", ""type"": ""EventAbsent"", ""topic"": ""log"", ""matcher"": { ""contains"": { ""message"": ""dateRange"" }, ""exact"": { ""level"": ""Error"" }}}
      ]
    }
  ]
}

Example C — 2x2 truth table for ""inv-added_parameter-startTime"" and ""inv-added_parameter-endTime"":
{
  ""scenarios"": [
    {
      ""title"": ""Both startTime and endTime omitted: defaults to last 7 days"",
      ""description"": ""Truth-table cell (null,null). Covers default-window resolution."",
      ""category"": ""HappyPath"", ""priority"": 2,
      ""technique"": ""TruthTable"",
      ""invariantsAddressed"": [""inv-added_parameter-startTime"", ""inv-added_parameter-endTime""],
      ""groundingEvidence"": [{ ""file"": ""Service/.../LiveTableInsightsController.cs"", ""startLine"": 33, ""endLine"": 41, ""reason"": ""Method signature gained startTime and endTime; this cell exercises both-null."" }],
      ""stimulus"": { ""type"": ""HttpRequest"", ""httpRequest"": { ""method"": ""GET"", ""path"": ""/api/v1/insights/summary"" }},
      ""expectations"": [{ ""id"": ""exp-1"", ""type"": ""EventPresent"", ""topic"": ""http"", ""matcher"": { ""exact"": { ""statusCode"": 200 }}}]
    },
    {
      ""title"": ""Only endTime set: startTime backfilled as endTime - 7d"",
      ""description"": ""Truth-table cell (null,set). Verifies asymmetric default behavior."",
      ""category"": ""EdgeCase"", ""priority"": 2,
      ""technique"": ""TruthTable"",
      ""invariantsAddressed"": [""inv-added_parameter-startTime"", ""inv-added_parameter-endTime""],
      ""groundingEvidence"": [{ ""file"": ""Service/.../LiveTableInsightsController.cs"", ""startLine"": 33, ""endLine"": 41, ""reason"": ""(null,set) cell; covers endTime-only resolution path."" }],
      ""stimulus"": { ""type"": ""HttpRequest"", ""httpRequest"": { ""method"": ""GET"", ""path"": ""/api/v1/insights/summary?endTime=2025-05-11T00:00:00Z"" }},
      ""expectations"": [{ ""id"": ""exp-1"", ""type"": ""EventPresent"", ""topic"": ""http"", ""matcher"": { ""exact"": { ""statusCode"": 200 }}}]
    },
    {
      ""title"": ""Only startTime set: endTime forward-filled as startTime + 7d"",
      ""description"": ""Truth-table cell (set,null). Mirror of the (null,set) case."",
      ""category"": ""EdgeCase"", ""priority"": 2,
      ""technique"": ""TruthTable"",
      ""invariantsAddressed"": [""inv-added_parameter-startTime"", ""inv-added_parameter-endTime""],
      ""groundingEvidence"": [{ ""file"": ""Service/.../LiveTableInsightsController.cs"", ""startLine"": 33, ""endLine"": 41, ""reason"": ""(set,null) cell; covers startTime-only resolution path."" }],
      ""stimulus"": { ""type"": ""HttpRequest"", ""httpRequest"": { ""method"": ""GET"", ""path"": ""/api/v1/insights/summary?startTime=2025-05-04T00:00:00Z"" }},
      ""expectations"": [{ ""id"": ""exp-1"", ""type"": ""EventPresent"", ""topic"": ""http"", ""matcher"": { ""exact"": { ""statusCode"": 200 }}}]
    },
    {
      ""title"": ""Both set: explicit window honored without modification"",
      ""description"": ""Truth-table cell (set,set). Verifies pass-through when caller fully specifies the window."",
      ""category"": ""HappyPath"", ""priority"": 2,
      ""technique"": ""TruthTable"",
      ""invariantsAddressed"": [""inv-added_parameter-startTime"", ""inv-added_parameter-endTime""],
      ""groundingEvidence"": [{ ""file"": ""Service/.../LiveTableInsightsController.cs"", ""startLine"": 33, ""endLine"": 41, ""reason"": ""(set,set) cell; verifies pass-through without modification."" }],
      ""stimulus"": { ""type"": ""HttpRequest"", ""httpRequest"": { ""method"": ""GET"", ""path"": ""/api/v1/insights/summary?startTime=2025-05-01T00:00:00Z&endTime=2025-05-08T00:00:00Z"" }},
      ""expectations"": [{ ""id"": ""exp-1"", ""type"": ""EventPresent"", ""topic"": ""http"", ""matcher"": { ""exact"": { ""statusCode"": 200 }}}]
    }
  ]
}

Return ONLY valid JSON, no markdown, no explanation text.";
        }

        // ──────────────────────────────────────────────
        // User Message Construction
        // ──────────────────────────────────────────────

        /// <summary>
        /// Build the structured user message from the LlmPromptRequest context.
        /// </summary>
        private static string BuildUserMessage(LlmPromptRequest request)
        {
            var sb = new StringBuilder();

            // Section 1: Impact Zone Summary
            sb.AppendLine("# Impact Zone Analysis");
            sb.AppendLine();
            sb.AppendLine($"**Zone ID:** {request.Zone.ZoneId}");
            sb.AppendLine($"**Community:** {request.Zone.Community ?? "unknown"}");
            sb.AppendLine();

            sb.AppendLine("**Primary Change:**");
            var primary = request.Zone.PrimaryChange;
            var startLine = primary?.LinesChanged?.Count > 0 ? primary.LinesChanged.Min() : 0;
            var endLine = primary?.LinesChanged?.Count > 0 ? primary.LinesChanged.Max() : 0;
            sb.AppendLine($"- File: {primary?.File ?? "unknown"}");
            if (!string.IsNullOrEmpty(primary?.Method))
                sb.AppendLine($"- Method: {primary.Method}");
            sb.AppendLine(startLine > 0
                ? $"- Lines: {startLine}-{endLine}"
                : "- Lines: unknown");
            sb.AppendLine($"- Change Type: {primary?.ChangeType ?? "unknown"}");
            sb.AppendLine();

            // Affected callers
            if (request.Zone.AffectedCallers.Count > 0)
            {
                sb.AppendLine($"**Affected Callers ({request.Zone.AffectedCallers.Count}):**");
                foreach (var caller in request.Zone.AffectedCallers.Take(10))
                {
                    sb.AppendLine($"- {caller.Method} (file: {caller.File})");
                }
                if (request.Zone.AffectedCallers.Count > 10)
                    sb.AppendLine($"... and {request.Zone.AffectedCallers.Count - 10} more");
                sb.AppendLine();
            }

            // Affected interfaces
            if (request.Zone.AffectedInterfaces.Count > 0)
            {
                sb.AppendLine($"**Affected Interfaces ({request.Zone.AffectedInterfaces.Count}):**");
                foreach (var iface in request.Zone.AffectedInterfaces.Take(10))
                {
                    sb.AppendLine($"- {iface}");
                }
                if (request.Zone.AffectedInterfaces.Count > 10)
                    sb.AppendLine($"... and {request.Zone.AffectedInterfaces.Count - 10} more");
                sb.AppendLine();
            }

            // Interceptor topics
            if (request.Zone.InterceptorTopics.Count > 0)
            {
                sb.AppendLine($"**Interceptor Topics ({request.Zone.InterceptorTopics.Count}):**");
                sb.AppendLine($"{string.Join(", ", request.Zone.InterceptorTopics)}");
                sb.AppendLine();
            }

            // Entry points with stimulus types
            if (request.Zone.EntryPoints.Count > 0)
            {
                sb.AppendLine($"**Entry Points ({request.Zone.EntryPoints.Count}):**");
                foreach (var ep in request.Zone.EntryPoints.Take(10))
                {
                    sb.AppendLine($"- {ep.Node} → stimulus: {ep.StimulusType}");
                }
                if (request.Zone.EntryPoints.Count > 10)
                    sb.AppendLine($"... and {request.Zone.EntryPoints.Count - 10} more");
                sb.AppendLine();
            }

            // ──────────────────────────────────────────────────────────
            // F27 "pinnacle" Sections 1.5a–1.5d — contract context (item 1).
            // Skipped silently when request.PrContext is null; sections
            // within emit a "[unavailable: reason]" marker when the
            // dev-server reported a fetch failure for that specific field.
            // ──────────────────────────────────────────────────────────
            AppendContractSections(sb, request.PrContext);

            // Section 2: Diff Content (truncated)
            sb.AppendLine("# Code Diff");
            sb.AppendLine();
            var diffContent = request.DiffContent ?? "";
            if (diffContent.Length > MaxDiffChars)
            {
                diffContent = diffContent.Substring(0, MaxDiffChars) + "\n... [truncated]";
            }
            sb.AppendLine("```diff");
            sb.AppendLine(diffContent);
            sb.AppendLine("```");
            sb.AppendLine();

            // Section 3: Graph Summary
            if (request.Graph != null)
            {
                sb.AppendLine("# Code Graph Summary");
                sb.AppendLine();
                sb.AppendLine($"**Nodes:** {request.Graph.Nodes.Count}");
                sb.AppendLine($"**Edges:** {request.Graph.Edges.Count}");
                sb.AppendLine($"**Communities:** {request.Graph.Communities.Values.Distinct().Count()}");
                sb.AppendLine();

                // Show some key nodes
                var keyNodes = request.Graph.Nodes.Values
                    .Where(n => request.Graph.GetIncomingEdges(n.Id).Count > 2)
                    .OrderByDescending(n => request.Graph.GetIncomingEdges(n.Id).Count)
                    .Take(5)
                    .ToList();

                if (keyNodes.Count > 0)
                {
                    sb.AppendLine("**Key Nodes (high fan-in):**");
                    foreach (var node in keyNodes)
                    {
                        var inDegree = request.Graph.GetIncomingEdges(node.Id).Count;
                        sb.AppendLine($"- {node.Id} (callers: {inDegree})");
                    }
                    sb.AppendLine();
                }
            }

            // Section 4: DI Context
            if (request.DiRegistrations.Count > 0)
            {
                sb.AppendLine("# DI Registrations");
                sb.AppendLine();
                foreach (var di in request.DiRegistrations.Take(15))
                {
                    sb.AppendLine($"- {di.ServiceType} → {di.ImplementationType} ({di.Lifetime})");
                }
                if (request.DiRegistrations.Count > 15)
                    sb.AppendLine($"... and {request.DiRegistrations.Count - 15} more");
                sb.AppendLine();
            }

            // Section 5: Interface Resolutions
            if (request.InterfaceResolutions.Count > 0)
            {
                sb.AppendLine("# Interface Resolutions");
                sb.AppendLine();
                foreach (var res in request.InterfaceResolutions.Take(15))
                {
                    sb.AppendLine($"- {res.InterfaceType} → {res.ImplementationType}");
                    sb.AppendLine($"  Source: {res.Source}, Confidence: {res.Confidence:F2}");
                }
                if (request.InterfaceResolutions.Count > 15)
                    sb.AppendLine($"... and {request.InterfaceResolutions.Count - 15} more");
                sb.AppendLine();
            }

            // Section 6: Valid Topics
            if (request.ValidTopics.Count > 0)
            {
                sb.AppendLine("# Valid Interceptor Topics");
                sb.AppendLine();
                sb.AppendLine($"Use ONLY these topics in expectations: {string.Join(", ", request.ValidTopics)}");
                sb.AppendLine();
            }

            return sb.ToString();
        }

        // ──────────────────────────────────────────────────────────
        // F27 "Pinnacle" Contract Sections (item 1)
        // ──────────────────────────────────────────────────────────

        /// <summary>
        /// Append PR contract context sections (PR Description, Work Item
        /// Acceptance Criteria, Linked Spec Excerpts, API Catalog, Prior
        /// Tests) to the user message.
        /// </summary>
        /// <remarks>
        /// All sections are independently degraded — an empty/missing field
        /// is silently skipped. The header for each section is only emitted
        /// when the field has content, so the prompt stays clean when the
        /// dev-server couldn't fetch anything (e.g. no PR URL, no ADO auth).
        ///
        /// Per-field caps enforced here are a defence-in-depth complement
        /// to the dev-server's own caps in <c>_collect_pr_context_extras</c>.
        /// </remarks>
        private static void AppendContractSections(StringBuilder sb, PrContext ctx)
        {
            if (ctx == null) return;

            // Section 1.5a — PR Description
            if (!string.IsNullOrWhiteSpace(ctx.Description))
            {
                sb.AppendLine("# Pull Request Contract");
                sb.AppendLine();
                if (!string.IsNullOrWhiteSpace(ctx.Title))
                {
                    sb.AppendLine($"**Title:** {ctx.Title}");
                }
                if (!string.IsNullOrWhiteSpace(ctx.Author))
                {
                    sb.AppendLine($"**Author:** {ctx.Author}");
                }
                sb.AppendLine();
                sb.AppendLine("**Description:**");
                sb.AppendLine(Truncate(ctx.Description, MaxPrDescriptionChars));
                sb.AppendLine();
            }

            // Section 1.5b — Work Item Acceptance Criteria
            if (ctx.WorkItems != null && ctx.WorkItems.Count > 0)
            {
                sb.AppendLine("# Linked Work Items (acceptance criteria are authoritative)");
                sb.AppendLine();
                var workItemsToRender = ctx.WorkItems
                    .Where(w => w != null)
                    .Take(MaxWorkItemsRendered)
                    .ToList();
                foreach (var wi in workItemsToRender)
                {
                    sb.AppendLine($"## WI #{wi.Id} — {wi.Title ?? "(no title)"} [{wi.State ?? "unknown"}]");
                    if (!string.IsNullOrWhiteSpace(wi.AcceptanceCriteria))
                    {
                        sb.AppendLine();
                        sb.AppendLine("**Acceptance Criteria:**");
                        sb.AppendLine(Truncate(wi.AcceptanceCriteria, MaxAcceptanceCriteriaCharsPerWorkItem));
                    }
                    else
                    {
                        sb.AppendLine();
                        sb.AppendLine("_[no acceptance criteria recorded on this work item]_");
                    }
                    sb.AppendLine();
                }
                if (ctx.WorkItems.Count > MaxWorkItemsRendered)
                {
                    sb.AppendLine($"_... and {ctx.WorkItems.Count - MaxWorkItemsRendered} more work item(s) omitted_");
                    sb.AppendLine();
                }
            }

            // Section 1.5c — Linked Spec Excerpts (ADO-hosted markdown)
            if (ctx.LinkedSpecExcerpts != null && ctx.LinkedSpecExcerpts.Count > 0)
            {
                sb.AppendLine("# Linked Specification Excerpts");
                sb.AppendLine();
                var specsToRender = ctx.LinkedSpecExcerpts
                    .Where(s => s != null && !string.IsNullOrWhiteSpace(s.Content))
                    .Take(MaxSpecExcerptsRendered)
                    .ToList();
                foreach (var spec in specsToRender)
                {
                    sb.AppendLine($"## {spec.Url}");
                    sb.AppendLine();
                    sb.AppendLine("```markdown");
                    sb.AppendLine(Truncate(spec.Content, MaxSpecExcerptChars));
                    sb.AppendLine("```");
                    sb.AppendLine();
                }
                if (ctx.LinkedSpecExcerpts.Count > MaxSpecExcerptsRendered)
                {
                    sb.AppendLine($"_... and {ctx.LinkedSpecExcerpts.Count - MaxSpecExcerptsRendered} more spec link(s) omitted_");
                    sb.AppendLine();
                }
            }

            // Section 1.5d — API Surface (FLT controller endpoints from catalog)
            if (ctx.ApiCatalog != null
                && ctx.ApiCatalog.Endpoints != null
                && ctx.ApiCatalog.Endpoints.Count > 0)
            {
                sb.AppendLine("# API Surface (changed controllers)");
                sb.AppendLine();
                if (ctx.ApiCatalog.Controllers != null && ctx.ApiCatalog.Controllers.Count > 0)
                {
                    sb.AppendLine($"**Controllers in diff:** {string.Join(", ", ctx.ApiCatalog.Controllers)}");
                    sb.AppendLine();
                }
                sb.AppendLine("**Endpoints (verb, path, summary):**");
                var rendered = 0;
                foreach (var ep in ctx.ApiCatalog.Endpoints)
                {
                    if (ep == null) continue;
                    if (rendered >= MaxCatalogEndpointsRendered) break;
                    var verb = TryGetString(ep, "verb") ?? "?";
                    var path = TryGetString(ep, "url_template") ?? TryGetString(ep, "path") ?? "?";
                    var summary = TryGetString(ep, "summary") ?? TryGetString(ep, "name") ?? "";
                    if (!string.IsNullOrEmpty(summary))
                    {
                        sb.AppendLine($"- `{verb} {path}` — {summary}");
                    }
                    else
                    {
                        sb.AppendLine($"- `{verb} {path}`");
                    }
                    rendered++;
                }
                if (ctx.ApiCatalog.Truncated || ctx.ApiCatalog.Endpoints.Count > MaxCatalogEndpointsRendered)
                {
                    sb.AppendLine($"_... endpoint list truncated_");
                }
                sb.AppendLine();
                sb.AppendLine("**RULE: stimulus.path MUST match one of these endpoints exactly.**");
                sb.AppendLine();
            }

            // Section 1.5e — Prior Tests
            if (ctx.PriorTests != null && ctx.PriorTests.Count > 0)
            {
                sb.AppendLine("# Prior Test Coverage (avoid duplicates; complement, do not replace)");
                sb.AppendLine();
                foreach (var pt in ctx.PriorTests)
                {
                    if (pt == null || pt.Methods == null || pt.Methods.Count == 0) continue;
                    sb.AppendLine($"## {pt.File} ({pt.Controller})");
                    sb.AppendLine();
                    var methodsRendered = 0;
                    foreach (var m in pt.Methods)
                    {
                        if (methodsRendered >= MaxPriorTestMethodsRendered) break;
                        if (string.IsNullOrWhiteSpace(m)) continue;
                        sb.AppendLine($"- {m}");
                        methodsRendered++;
                    }
                    if (pt.TotalMethods > methodsRendered)
                    {
                        sb.AppendLine($"_... {pt.TotalMethods - methodsRendered} more test methods omitted_");
                    }
                    sb.AppendLine();
                }
            }

            // Section 1.5f — Code Invariants extracted from the diff
            // (F27 item 2). Rendered via the extractor's helper so the
            // markdown layout stays in one place.
            if (ctx.Invariants != null && ctx.Invariants.Count > 0)
            {
                var invariantsBlock = EdogQaInvariantExtractor.RenderForPrompt(ctx.Invariants);
                if (!string.IsNullOrEmpty(invariantsBlock))
                {
                    sb.Append(invariantsBlock);
                }
            }
        }

        /// <summary>Cap a string at <paramref name="max"/> chars, appending an explicit truncation marker.</summary>
        private static string Truncate(string s, int max)
        {
            if (string.IsNullOrEmpty(s) || s.Length <= max) return s ?? string.Empty;
            return s.Substring(0, max) + "\n... [truncated]";
        }

        /// <summary>Read a string-valued entry from a loosely-typed catalog dictionary.</summary>
        private static string TryGetString(Dictionary<string, object> dict, string key)
        {
            if (dict == null) return null;
            if (!dict.TryGetValue(key, out var v) || v == null) return null;
            if (v is string s) return s;
            // JsonElement support (when the catalog is deserialized as JsonElement).
            if (v is System.Text.Json.JsonElement je)
            {
                if (je.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    return je.GetString();
                }
                return je.ToString();
            }
            return v.ToString();
        }

        // ──────────────────────────────────────────────
        // Azure OpenAI API Call
        // ──────────────────────────────────────────────

        /// <summary>
        /// Call Azure OpenAI Chat Completions API with structured JSON response.
        /// </summary>
        private async Task<string> CallAzureOpenAIAsync(
            string systemPrompt,
            string userMessage,
            CancellationToken cancellationToken)
        {
            string url;
            if (_useProxy)
            {
                url = DevServerProxyUrl;
            }
            else
            {
                url = $"{_endpoint.TrimEnd('/')}/openai/deployments/{_deployment}/chat/completions?api-version={_apiVersion}";
            }

            var requestBody = new
            {
                messages = new[]
                {
                    new { role = "system", content = systemPrompt },
                    new { role = "user", content = userMessage }
                },
                temperature = 0.3,
                // gpt-5.4-pro is a reasoning model — internal reasoning tokens
                // count against the same budget as visible output. The F27
                // system prompt + per-zone context is large, so a tight
                // ceiling (e.g. 8192) was being fully consumed by reasoning
                // and returning content="" with finish_reason="length" or
                // "stop", which the parser correctly rejected as empty.
                // 32768 leaves comfortable headroom for both reasoning and
                // the JSON output (typically 1-3K visible tokens).
                max_tokens = 32768,
                // Hint reasoning-capable models (gpt-5.*) to use medium
                // reasoning effort. Cheaper non-reasoning deployments
                // ignore this field, so it's safe to always send.
                reasoning_effort = "medium",
                response_format = new { type = "json_object" }
            };

            var requestJson = JsonSerializer.Serialize(requestBody, new JsonSerializerOptions
            {
                WriteIndented = false
            });

            using var request = new HttpRequestMessage(HttpMethod.Post, url);
            if (!_useProxy)
            {
                request.Headers.Add("api-key", _apiKey);
            }
            request.Content = new StringContent(requestJson, Encoding.UTF8, "application/json");

            var sw = System.Diagnostics.Stopwatch.StartNew();
            var response = await _httpClient.SendAsync(request, cancellationToken);
            sw.Stop();

            if (!response.IsSuccessStatusCode)
            {
                var errorBody = await response.Content.ReadAsStringAsync();
                // Pass the actual status code to HttpRequestException so
                // LlmProviderExceptionClassifier can map 401/403→auth,
                // 429→rate_limit, 5xx→network-retryable. Before P4 the
                // status code was only in the message string, so the
                // classifier had no structured signal.
                throw new HttpRequestException(
                    $"Azure OpenAI API error {(int)response.StatusCode}: {errorBody}",
                    inner: null,
                    statusCode: response.StatusCode);
            }

            var responseJson = await response.Content.ReadAsStringAsync();
            
            // Log token usage if available
            LogTokenUsage(responseJson);

            // Extract content from response
            using var doc = JsonDocument.Parse(responseJson);
            var content = doc.RootElement
                .GetProperty("choices")[0]
                .GetProperty("message")
                .GetProperty("content")
                .GetString();

            // Diagnostic: when the model returns no content, surface the
            // finish_reason so empty-output investigations (e.g. reasoning
            // models burning the entire budget on internal reasoning) are
            // visible in the FLT console instead of just emitting a generic
            // "content was empty" further upstream.
            if (string.IsNullOrEmpty(content))
            {
                string finishReason = null;
                try
                {
                    finishReason = doc.RootElement
                        .GetProperty("choices")[0]
                        .GetProperty("finish_reason")
                        .GetString();
                }
                catch { }
                Console.WriteLine(
                    $"[EDOG] LLM returned empty content (finish_reason={finishReason ?? "?"}, " +
                    $"elapsed={sw.ElapsedMilliseconds}ms). If this is a reasoning model, " +
                    $"max_tokens may be insufficient for reasoning + output.");
            }

            Console.WriteLine($"[EDOG] LLM call completed in {sw.ElapsedMilliseconds}ms");
            return content;
        }

        /// <summary>
        /// Log token usage from Azure OpenAI response.
        /// </summary>
        private static void LogTokenUsage(string responseJson)
        {
            try
            {
                using var doc = JsonDocument.Parse(responseJson);
                if (doc.RootElement.TryGetProperty("usage", out var usage))
                {
                    var promptTokens = usage.GetProperty("prompt_tokens").GetInt32();
                    var completionTokens = usage.GetProperty("completion_tokens").GetInt32();
                    var totalTokens = usage.GetProperty("total_tokens").GetInt32();
                    Console.WriteLine($"[EDOG] Token usage: {promptTokens} prompt + {completionTokens} completion = {totalTokens} total");
                }
            }
            catch
            {
                // Token usage logging is best-effort
            }
        }

        // ──────────────────────────────────────────────
        // Response Parsing
        // ──────────────────────────────────────────────

        /// <summary>
        /// Parse LLM JSON response into Scenario objects.
        ///
        /// F27 P4: throws <see cref="LlmProviderException"/> with kind
        /// <c>Parse</c> when the contract is violated (invalid JSON,
        /// missing <c>scenarios</c> array, empty array, all entries
        /// fail to map). The hub maps this into a typed QaError so the
        /// studio surfaces an actionable message rather than silently
        /// triggering the synthetic fallback.
        /// </summary>
        private static List<Scenario> ParseResponse(string responseContent, string zoneId)
        {
            if (string.IsNullOrWhiteSpace(responseContent))
            {
                throw LlmProviderExceptionClassifier.Parse(
                    $"LLM response content was empty for zone {zoneId}.");
            }

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(responseContent);
            }
            catch (JsonException jex)
            {
                throw LlmProviderExceptionClassifier.Parse(
                    $"LLM response was not valid JSON for zone {zoneId}: {jex.Message}");
            }

            using (doc)
            {
                if (!doc.RootElement.TryGetProperty("scenarios", out var scenariosArray))
                {
                    throw LlmProviderExceptionClassifier.Parse(
                        $"LLM response for zone {zoneId} is missing the required 'scenarios' array.");
                }

                if (scenariosArray.ValueKind != JsonValueKind.Array)
                {
                    throw LlmProviderExceptionClassifier.Parse(
                        $"LLM response 'scenarios' field for zone {zoneId} must be a JSON array, " +
                        $"got {scenariosArray.ValueKind}.");
                }

                var options = new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                    Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
                };

                var scenarios = new List<Scenario>();
                var entryCount = 0;
                var mapErrors = new List<string>();
                foreach (var scenarioElement in scenariosArray.EnumerateArray())
                {
                    entryCount++;
                    try
                    {
                        var scenario = JsonSerializer.Deserialize<LlmScenarioResponse>(
                            scenarioElement.GetRawText(), options);

                        if (scenario == null) continue;

                        var domainScenario = MapToDomainScenario(scenario, zoneId);
                        scenarios.Add(domainScenario);
                    }
                    catch (Exception ex)
                    {
                        mapErrors.Add(ex.Message);
                        Console.WriteLine($"[EDOG] Failed to parse scenario: {ex.Message}");
                    }
                }

                if (entryCount > 0 && scenarios.Count == 0)
                {
                    var detail = mapErrors.Count > 0 ? mapErrors[0] : "unknown mapping failure";
                    throw LlmProviderExceptionClassifier.Parse(
                        $"LLM returned {entryCount} scenario entries for zone {zoneId} but " +
                        $"none could be mapped to the domain model. First error: {detail}.");
                }

                return scenarios;
            }
        }

        /// <summary>
        /// Map LLM response DTO to domain Scenario model.
        /// </summary>
        private static Scenario MapToDomainScenario(LlmScenarioResponse response, string zoneId)
        {
            var scenario = new Scenario
            {
                Id = GenerateScenarioId(response.Title),
                Title = response.Title?.Substring(0, Math.Min(response.Title.Length, 120)),
                Description = response.Description?.Substring(0, Math.Min(response.Description.Length, 500)),
                Category = response.Category,
                Priority = Math.Clamp(response.Priority, 1, 5),
                ImpactZone = zoneId,
                Lifecycle = ScenarioLifecycle.Generated,
                Stimulus = response.Stimulus,
                Expectations = response.Expectations ?? new List<Expectation>(),
                TimeoutMs = response.TimeoutMs > 0 ? response.TimeoutMs : 30_000,
                Metadata = new ScenarioMetadata
                {
                    GeneratedBy = "ai",
                    Confidence = Math.Clamp(response.Confidence, 0.0, 1.0),
                    GeneratedAt = DateTimeOffset.UtcNow,
                    SchemaVersion = 2
                },

                // F27 item 3 + 6: taxonomy and grounding flow straight from
                // the LLM DTO. Defaults (NotSpecified / empty lists) are
                // intentional — the linter (item 5) raises explicit findings
                // for missing values rather than silently filling them in.
                Technique = response.Technique,
                InvariantsAddressed = response.InvariantsAddressed ?? new List<string>(),
                GroundingEvidence = response.GroundingEvidence ?? new List<GroundingEvidence>(),
            };

            return scenario;
        }

        /// <summary>
        /// Generate scenario ID from title: scn-{slug}-{hash}.
        /// </summary>
        private static string GenerateScenarioId(string title)
        {
            if (string.IsNullOrEmpty(title))
                return $"scn-unknown-{Guid.NewGuid().ToString().Substring(0, 4)}";

            // Create slug from title
            var slug = title.ToLowerInvariant()
                .Replace(" ", "-")
                .Replace("_", "-");
            
            // Remove non-alphanumeric except hyphens
            slug = new string(slug.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray());
            
            // Truncate and add hash
            slug = slug.Substring(0, Math.Min(slug.Length, 40));
            var hash = Math.Abs(title.GetHashCode()).ToString("x4");
            
            return $"scn-{slug}-{hash}";
        }

        // ──────────────────────────────────────────────
        // DTOs for LLM Response Parsing
        // ──────────────────────────────────────────────

        public void Dispose()
        {
            _httpClient?.Dispose();
        }

        private sealed class LlmScenarioResponse
        {
            public string Title { get; set; }
            public string Description { get; set; }
            public ScenarioCategory Category { get; set; }
            public int Priority { get; set; }
            public double Confidence { get; set; }
            public Stimulus Stimulus { get; set; }
            public List<Expectation> Expectations { get; set; }
            public int TimeoutMs { get; set; }

            // F27 item 3 — taxonomy
            public ScenarioTechnique Technique { get; set; }
            public List<string> InvariantsAddressed { get; set; }

            // F27 item 6 — grounding evidence
            public List<GroundingEvidence> GroundingEvidence { get; set; }
        }
    }
}
