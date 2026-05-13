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
        private const int HttpTimeoutSeconds = 120;
        private const string DevServerProxyUrl = "http://localhost:5555/api/openai-proxy/chat";

        private readonly HttpClient _httpClient;
        private readonly string _endpoint;
        private readonly string _apiKey;
        private readonly string _apiVersion;
        private readonly string _deployment;
        private readonly bool _isConfigured;
        private readonly bool _useProxy;

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
                return new List<Scenario>();
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
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] LLM generation failed for zone {request.Zone.ZoneId}: {ex.Message}");
                return new List<Scenario>();
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
  ""timeoutMs"": 30000
}

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
                max_tokens = 16000,
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
                throw new HttpRequestException(
                    $"Azure OpenAI API error {response.StatusCode}: {errorBody}");
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
        /// Returns empty list on malformed JSON (logs warning).
        /// </summary>
        private static List<Scenario> ParseResponse(string responseContent, string zoneId)
        {
            try
            {
                var options = new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                    Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
                };

                using var doc = JsonDocument.Parse(responseContent);
                if (!doc.RootElement.TryGetProperty("scenarios", out var scenariosArray))
                {
                    Console.WriteLine("[EDOG] LLM response missing 'scenarios' array");
                    return new List<Scenario>();
                }

                var scenarios = new List<Scenario>();
                foreach (var scenarioElement in scenariosArray.EnumerateArray())
                {
                    try
                    {
                        var scenario = JsonSerializer.Deserialize<LlmScenarioResponse>(
                            scenarioElement.GetRawText(), options);

                        if (scenario == null) continue;

                        // Map to domain Scenario model
                        var domainScenario = MapToDomainScenario(scenario, zoneId);
                        scenarios.Add(domainScenario);
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[EDOG] Failed to parse scenario: {ex.Message}");
                    }
                }

                return scenarios;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Failed to parse LLM response: {ex.Message}");
                return new List<Scenario>();
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
                    SchemaVersion = 1
                }
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
        }
    }
}
