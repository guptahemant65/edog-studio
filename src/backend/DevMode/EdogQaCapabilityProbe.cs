// <copyright file="EdogQaCapabilityProbe.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.IO;
    using System.Net.Http;
    using System.Text;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaCapabilityProbe — F27 P9 §3.6 startup capability probe
    //
    // The production-grade LLM scenario generation pipeline depends on
    // four Azure OpenAI deployment capabilities that are NOT universal:
    //
    //   1. Deployment exists and is reachable          (AOAI_DEPLOYMENT_NOT_FOUND)
    //   2. Responses API (vs Chat Completions only)    (AOAI_RESPONSES_API_UNAVAILABLE)
    //   3. JSON Schema strict-mode constrained decoding (AOAI_JSON_SCHEMA_STRICT_UNSUPPORTED)
    //   4. Reasoning effort parameter accepted          (AOAI_REASONING_UNSUPPORTED)
    //
    // Different tenants / regions / SKUs expose different subsets. The V2
    // pipeline uses TWO deployments (Architect + Editor) with different
    // capability requirements:
    //   • Architect — reasoning-capable. Needs all four.
    //   • Editor    — formatter, no reasoning required. Needs only (1)–(3).
    //
    // <see cref="IsAzureOpenAiReadyForV2"/> is true only when BOTH probes
    // confirm the required capabilities for their respective role.
    //
    // ── Awaitable lifecycle (F27 P9 T4-followup) ───────────────────────
    // <see cref="EnsureStarted"/> kicks off the dual probe at host startup
    // (called from the registrar). <see cref="WaitForResultAsync"/> lets
    // the first analyzer request bound a wait on the probe completing —
    // first-run-after-cold-start no longer falls into legacy just because
    // the probe hadn't finished yet.
    //
    // ── Implementation status ─────────────────────────────────────────
    // ProbeOnceAsync performs a real handshake against Azure OpenAI:
    //   • POST {endpoint}/openai/responses?api-version=… with strict
    //     json_schema constrained decoding + reasoning.effort=low.
    //   • HTTP 200 + status="completed" + parseable {"ok":true} payload
    //     promotes ResponsesApiAvailable + JsonSchemaStrictSupported.
    //   • Presence of usage.output_tokens_details.reasoning_tokens
    //     promotes ReasoningSupported (skipped for Editor role).
    //   • All required-for-role ⇒ IsReady=true.
    //
    // Network + config failures map to stable error codes (below) so
    // the orchestrator can render an actionable inline error and the
    // operator can recover without console diving.
    //
    // ── Tests ─────────────────────────────────────────────────────────
    // ProbeOnceAsync accepts an explicit <see cref="ProbeConfig"/> and
    // never touches the cache — the harness pattern in
    // tests/dotnet/EdogQaE2E.Tests/CapabilityProbeHarness.cs uses it to
    // exercise all branches via an injected HttpMessageHandler without
    // any live network call.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Process-wide capability probe for the Azure OpenAI deployment that
    /// backs the F27 P9 LLM scenario generation pipeline. Gates the rollout
    /// of <see cref="EdogQaFeatureFlags.LlmV2"/>.
    /// </summary>
    internal static class EdogQaCapabilityProbe
    {
        // ── Error codes (wire-stable) ──────────────────────────────────

        /// <summary>Emitted when the configured deployment name resolves to no model.</summary>
        internal const string ErrorCodeDeploymentNotFound = "AOAI_DEPLOYMENT_NOT_FOUND";

        /// <summary>Emitted when /openai/responses returns 404 / unsupported version.</summary>
        internal const string ErrorCodeResponsesApiUnavailable = "AOAI_RESPONSES_API_UNAVAILABLE";

        /// <summary>Emitted when <c>text.format.type = "json_schema"</c> is rejected.</summary>
        internal const string ErrorCodeJsonSchemaStrictUnsupported = "AOAI_JSON_SCHEMA_STRICT_UNSUPPORTED";

        /// <summary>Emitted when <c>reasoning.effort</c> is rejected or the deployment is not reasoning-capable.</summary>
        internal const string ErrorCodeReasoningUnsupported = "AOAI_REASONING_UNSUPPORTED";

        /// <summary>Emitted when no endpoint or no API key is configured.</summary>
        internal const string ErrorCodeConfigMissing = "PROBE_CONFIG_MISSING";

        /// <summary>Emitted when the HTTP call throws (transport / DNS / TLS / timeout).</summary>
        internal const string ErrorCodeNetworkError = "PROBE_NETWORK_ERROR";

        /// <summary>Emitted when the response body is HTTP 200 but not parseable as the expected Responses-API shape.</summary>
        internal const string ErrorCodeResponseUnparseable = "PROBE_RESPONSE_UNPARSEABLE";

        private static readonly TimeSpan ArchitectFirstTokenTimeout = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan ArchitectTotalTimeout = TimeSpan.FromSeconds(60);

        // ── Probe inputs ───────────────────────────────────────────────

        /// <summary>Role being probed. Editor does not require reasoning capability.</summary>
        internal enum ProbeRole
        {
            /// <summary>Architect — reasoning-capable model. All four capabilities required.</summary>
            Architect = 0,

            /// <summary>Editor — formatter, no reasoning needed. Capabilities 1–3 required.</summary>
            Editor = 1,
        }

        /// <summary>Explicit probe configuration. Production callers use the env-driven overload; tests inject a <see cref="ProbeConfig"/> directly.</summary>
        internal sealed class ProbeConfig
        {
            public string Endpoint { get; set; }

            public string ApiKey { get; set; }

            public string Deployment { get; set; }

            public string ApiVersion { get; set; }

            /// <summary>
            /// Role being probed. Defaults to <see cref="ProbeRole.Architect"/> for
            /// backwards compatibility with single-config callers (tests, legacy
            /// <see cref="ProbeAsync(HttpClient, CancellationToken)"/>).
            /// </summary>
            public ProbeRole Role { get; set; } = ProbeRole.Architect;
        }

        // ── Result type ────────────────────────────────────────────────

        /// <summary>Outcome of a single probe attempt.</summary>
        internal sealed class ProbeResult
        {
            /// <summary>True only when all required-for-role capabilities are confirmed (see <see cref="Role"/>).</summary>
            public bool IsReady { get; set; }

            /// <summary>Role probed (Architect = needs reasoning, Editor = does not).</summary>
            public ProbeRole Role { get; set; } = ProbeRole.Architect;

            /// <summary>Deployment name probed.</summary>
            public string Deployment { get; set; }

            /// <summary>Endpoint URL probed (host only, never logged with key).</summary>
            public string EndpointHost { get; set; }

            /// <summary>API version probed.</summary>
            public string ApiVersion { get; set; }

            /// <summary>True if /openai/responses returned a usable response.</summary>
            public bool ResponsesApiAvailable { get; set; }

            /// <summary>True if a strict json_schema request was honoured (output matched schema).</summary>
            public bool JsonSchemaStrictSupported { get; set; }

            /// <summary>True if usage.output_tokens_details.reasoning_tokens was reported. Required for Architect role only.</summary>
            public bool ReasoningSupported { get; set; }

            /// <summary>Largest <c>max_output_tokens</c> the deployment accepted without rejection.</summary>
            public int MaxOutputTokensVerified { get; set; }

            /// <summary>Stable error codes accumulated during this probe.</summary>
            public List<string> Errors { get; set; } = new();

            /// <summary>Wall-clock time when probe completed.</summary>
            public DateTimeOffset ProbedAt { get; set; }

            /// <summary>Round-trip duration of the probe request, milliseconds.</summary>
            public long ElapsedMilliseconds { get; set; }
        }

        /// <summary>Outcome of the combined dual probe (Architect + Editor).</summary>
        internal sealed class DualProbeResult
        {
            /// <summary>Probe outcome for the Architect deployment (reasoning-capable).</summary>
            public ProbeResult Architect { get; set; }

            /// <summary>Probe outcome for the Editor deployment (formatter, no reasoning required).</summary>
            public ProbeResult Editor { get; set; }

            /// <summary>True only when BOTH probes confirm their required-for-role capabilities.</summary>
            public bool IsReady { get; set; }

            /// <summary>Wall-clock time when the dual probe completed.</summary>
            public DateTimeOffset ProbedAt { get; set; }

            /// <summary>Total wall-clock time for both probes, milliseconds.</summary>
            public long ElapsedMilliseconds { get; set; }

            /// <summary>
            /// Combined error codes, prefixed with the role they originated from.
            /// Empty when <see cref="IsReady"/> is true.
            /// </summary>
            public List<string> Errors { get; set; } = new();

            /// <summary>
            /// Human-readable one-line reason summarising the dual outcome.
            /// Suitable for the QA panel readiness pill. Never null.
            /// </summary>
            public string Reason { get; set; } = string.Empty;
        }

        /// <summary>Lifecycle state of the dual probe. Mirrors what the QA panel renders.</summary>
        internal enum ProbeState
        {
            /// <summary>Probe has not been kicked off yet (process just started).</summary>
            NotStarted = 0,

            /// <summary><see cref="EnsureStarted"/> has been called; dual probe is in flight.</summary>
            InProgress = 1,

            /// <summary>Dual probe completed; both Architect + Editor confirmed ready.</summary>
            Ready = 2,

            /// <summary>Dual probe completed; at least one role is not ready (see <see cref="LastDualResult"/>.Errors).</summary>
            Failed = 3,
        }

        // ── Cache ──────────────────────────────────────────────────────

        // ── Legacy single-result cache (kept for back-compat with ProbeAsync) ──
        private static ProbeResult _cached;
        private static readonly SemaphoreSlim _gate = new(1, 1);

        // ── Dual-probe lifecycle (F27 P9 T4-followup) ──────────────────
        private static DualProbeResult _dualCached;
        private static Task<DualProbeResult> _dualTask;
        private static readonly object _dualGate = new();

        /// <summary>The cached single-config probe result if <see cref="ProbeAsync"/> has run; otherwise null.</summary>
        internal static ProbeResult LastResult => Volatile.Read(ref _cached);

        /// <summary>The cached dual probe result if <see cref="EnsureStarted"/> has been called and completed; otherwise null.</summary>
        internal static DualProbeResult LastDualResult => Volatile.Read(ref _dualCached);

        /// <summary>
        /// True only when the dual probe has completed AND both Architect + Editor
        /// roles confirm their required-for-role capabilities. Until then (probe
        /// not started, in-flight, or failed), the orchestrator MUST treat
        /// <see cref="EdogQaFeatureFlags.LlmV2"/> with appropriate fallback
        /// semantics (see <see cref="LlmV2Mode"/>).
        /// </summary>
        internal static bool IsAzureOpenAiReadyForV2 => Volatile.Read(ref _dualCached)?.IsReady == true;

        /// <summary>Current dual-probe lifecycle state.</summary>
        internal static ProbeState State
        {
            get
            {
                var t = Volatile.Read(ref _dualTask);
                if (t == null) return ProbeState.NotStarted;
                if (!t.IsCompleted) return ProbeState.InProgress;
                var d = Volatile.Read(ref _dualCached);
                return d?.IsReady == true ? ProbeState.Ready : ProbeState.Failed;
            }
        }

        /// <summary>
        /// Clears the cached results. Tests only — production must not call this.
        /// </summary>
        internal static void ResetForTest()
        {
            lock (_dualGate)
            {
                Volatile.Write(ref _cached, null);
                Volatile.Write(ref _dualCached, null);
                Volatile.Write(ref _dualTask, null);
            }
        }

        // ── Production entry point (env-driven, cached) ────────────────

        /// <summary>
        /// Runs the capability probe at most once per process and returns
        /// the cached result. Configuration is read from environment
        /// variables (AZURE_OPENAI_PRO_* preferred, AZURE_OPENAI_* fallback).
        /// </summary>
        /// <param name="httpClient">Shared HttpClient — supplied by the registrar.</param>
        /// <param name="ct">Cancellation token (typically host shutdown).</param>
        internal static async Task<ProbeResult> ProbeAsync(HttpClient httpClient, CancellationToken ct)
        {
            var cached = Volatile.Read(ref _cached);
            if (cached != null) return cached;

            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                cached = Volatile.Read(ref _cached);
                if (cached != null) return cached;

                var cfg = ReadConfigFromEnv();
                var result = await ProbeOnceAsync(httpClient, cfg, ct).ConfigureAwait(false);
                Volatile.Write(ref _cached, result);
                return result;
            }
            finally
            {
                _gate.Release();
            }
        }

        // ── Test entry point (explicit config, no cache) ───────────────

        /// <summary>
        /// Runs a single probe attempt against the supplied config without
        /// touching the process-wide cache. Used by the test harness to
        /// exercise each capability branch with an injected
        /// <see cref="HttpMessageHandler"/>.
        /// </summary>
        internal static async Task<ProbeResult> ProbeOnceAsync(
            HttpClient httpClient,
            ProbeConfig cfg,
            CancellationToken ct)
        {
            if (httpClient == null) throw new ArgumentNullException(nameof(httpClient));
            cfg ??= new ProbeConfig();

            var deployment = string.IsNullOrWhiteSpace(cfg.Deployment) ? "gpt-5.4" : cfg.Deployment.Trim();
            var apiVersion = string.IsNullOrWhiteSpace(cfg.ApiVersion) ? "2025-04-01-preview" : cfg.ApiVersion.Trim();
            var endpoint = (cfg.Endpoint ?? string.Empty).Trim();
            var apiKey = (cfg.ApiKey ?? string.Empty).Trim();

            var result = new ProbeResult
            {
                IsReady = false,
                Role = cfg.Role,
                Deployment = deployment,
                EndpointHost = SafeHost(endpoint),
                ApiVersion = apiVersion,
                ResponsesApiAvailable = false,
                JsonSchemaStrictSupported = false,
                ReasoningSupported = false,
                MaxOutputTokensVerified = 0,
                ProbedAt = DateTimeOffset.UtcNow,
                ElapsedMilliseconds = 0,
            };

            if (string.IsNullOrWhiteSpace(endpoint) || string.IsNullOrWhiteSpace(apiKey))
            {
                // Diagnostic: dump which env vars FLT actually sees so the operator
                // can tell whether the .env propagation worked (launcher issue) or
                // whether the .env itself is missing the keys (config issue).
                string Probe(string name) =>
                    string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(name)) ? "no" : "YES";
                var diag =
                    "ARCHITECT_ENDPOINT=" + Probe("AZURE_OPENAI_ARCHITECT_ENDPOINT") +
                    ", PRO_ENDPOINT=" + Probe("AZURE_OPENAI_PRO_ENDPOINT") +
                    ", ENDPOINT=" + Probe("AZURE_OPENAI_ENDPOINT") +
                    ", ARCHITECT_KEY=" + Probe("AZURE_OPENAI_ARCHITECT_API_KEY") +
                    ", PRO_KEY=" + Probe("AZURE_OPENAI_PRO_API_KEY") +
                    ", KEY=" + Probe("AZURE_OPENAI_API_KEY");
                result.Errors.Add(ErrorCodeConfigMissing
                    + " — set AZURE_OPENAI_PRO_ENDPOINT + AZURE_OPENAI_PRO_API_KEY"
                    + " (or AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY) and restart."
                    + " [FLT process env: " + diag + "]");
                return result;
            }

            const int RequestedMaxOutputTokens = 2048;
            var url = $"{endpoint.TrimEnd('/')}/openai/responses?api-version={apiVersion}";
            var requestBody = BuildProbeRequestBody(deployment, RequestedMaxOutputTokens, cfg.Role);

            using var request = new HttpRequestMessage(HttpMethod.Post, url);
            request.Headers.Add("api-key", apiKey);
            request.Content = new StringContent(requestBody, Encoding.UTF8, "application/json");

            using var timeoutCts = cfg.Role == ProbeRole.Architect
                ? CancellationTokenSource.CreateLinkedTokenSource(ct)
                : null;
            if (timeoutCts != null)
            {
                timeoutCts.CancelAfter(ArchitectTotalTimeout);
            }
            var requestToken = timeoutCts?.Token ?? ct;

            var sw = Stopwatch.StartNew();
            HttpResponseMessage response;
            string responseBody;
            try
            {
                var completion = cfg.Role == ProbeRole.Architect
                    ? HttpCompletionOption.ResponseHeadersRead
                    : HttpCompletionOption.ResponseContentRead;
                response = await httpClient.SendAsync(request, completion, requestToken).ConfigureAwait(false);
                responseBody = response.Content == null
                    ? string.Empty
                    : await ReadProbeResponseBodyAsync(response, cfg.Role, requestToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                sw.Stop();
                result.ElapsedMilliseconds = sw.ElapsedMilliseconds;
                var timeoutDetail = cfg.Role == ProbeRole.Architect
                    ? "Architect probe timed out waiting for first token or total completion."
                    : "Probe timed out.";
                result.Errors.Add(ErrorCodeNetworkError + " — " + timeoutDetail);
                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();
                result.ElapsedMilliseconds = sw.ElapsedMilliseconds;
                result.Errors.Add(ErrorCodeNetworkError + " — " + ex.GetType().Name + ": " + Truncate(ex.Message, 240));
                return result;
            }
            finally
            {
                sw.Stop();
                result.ElapsedMilliseconds = sw.ElapsedMilliseconds;
            }

            using (response)
            {
                if (!response.IsSuccessStatusCode)
                {
                    ClassifyHttpError((int)response.StatusCode, responseBody, result);
                    return result;
                }

                // HTTP 200 — parse the Responses-API envelope.
                if (!TryParseProbeResponse(responseBody, RequestedMaxOutputTokens, result))
                {
                    // Errors already populated by TryParseProbeResponse.
                    return result;
                }

                // Editor role does NOT require reasoning capability — gpt-5.4-mini
                // (the default Editor deployment) intentionally has no reasoning
                // and its job is pure formatting under strict json_schema.
                var requireReasoning = cfg.Role == ProbeRole.Architect;
                result.IsReady =
                    result.ResponsesApiAvailable
                    && result.JsonSchemaStrictSupported
                    && (!requireReasoning || result.ReasoningSupported)
                    && result.MaxOutputTokensVerified > 0;

                return result;
            }
        }

        // ── Dual probe (production) ───────────────────────────────────

        /// <summary>
        /// Kicks off the dual probe (Architect + Editor) if it has not been
        /// started yet. Idempotent and thread-safe — multiple calls share
        /// the same in-flight task. Returns immediately; callers that need
        /// the result use <see cref="WaitForResultAsync"/>.
        /// </summary>
        /// <param name="httpClient">Shared HttpClient — supplied by the registrar.</param>
        /// <param name="ct">Cancellation token (typically host shutdown).</param>
        internal static Task<DualProbeResult> EnsureStarted(HttpClient httpClient, CancellationToken ct)
        {
            if (httpClient == null) throw new ArgumentNullException(nameof(httpClient));
            var existing = Volatile.Read(ref _dualTask);
            if (existing != null) return existing;

            lock (_dualGate)
            {
                existing = Volatile.Read(ref _dualTask);
                if (existing != null) return existing;

                var t = Task.Run(() => ProbeAllAsync(httpClient, ct), ct);
                Volatile.Write(ref _dualTask, t);
                return t;
            }
        }

        /// <summary>
        /// Awaits the dual probe up to <paramref name="timeout"/>. Returns the
        /// completed <see cref="DualProbeResult"/>, or null if the timeout
        /// elapsed before the probe finished (the probe is NOT cancelled —
        /// it continues running and a subsequent call may observe the result).
        /// Callers MUST call <see cref="EnsureStarted"/> first.
        /// </summary>
        internal static async Task<DualProbeResult> WaitForResultAsync(TimeSpan timeout, CancellationToken ct)
        {
            var t = Volatile.Read(ref _dualTask);
            if (t == null) return null;
            if (t.IsCompleted) return t.Result;

            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var delay = Task.Delay(timeout, linked.Token);
            var winner = await Task.WhenAny(t, delay).ConfigureAwait(false);
            if (winner == delay) return null;
            linked.Cancel();
            return t.Result;
        }

        /// <summary>
        /// Runs the dual probe end-to-end. Reads Architect + Editor configs
        /// from environment (with the precedence documented on
        /// <see cref="EdogQaLlmClient.ReadArchitectConfigFromEnv"/> /
        /// <see cref="EdogQaLlmClient.ReadEditorConfigFromEnv"/>), invokes
        /// <see cref="ProbeOnceAsync"/> for each, and combines into a
        /// <see cref="DualProbeResult"/>. Both probes run sequentially —
        /// running in parallel against a small set of Azure capacities
        /// invites 429s; cost of two probes is &lt; $0.001 either way.
        /// </summary>
        private static async Task<DualProbeResult> ProbeAllAsync(HttpClient httpClient, CancellationToken ct)
        {
            var sw = Stopwatch.StartNew();
            var dual = new DualProbeResult
            {
                ProbedAt = DateTimeOffset.UtcNow,
            };

            try
            {
                var architectCfg = ReadArchitectProbeConfigFromEnv();
                dual.Architect = await ProbeOnceAsync(httpClient, architectCfg, ct).ConfigureAwait(false);

                var editorCfg = ReadEditorProbeConfigFromEnv();
                dual.Editor = await ProbeOnceAsync(httpClient, editorCfg, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                dual.Errors.Add(ErrorCodeNetworkError + " — dual probe threw: " + ex.GetType().Name + ": " + Truncate(ex.Message, 200));
            }
            finally
            {
                sw.Stop();
                dual.ElapsedMilliseconds = sw.ElapsedMilliseconds;
            }

            var aReady = dual.Architect?.IsReady == true;
            var eReady = dual.Editor?.IsReady == true;
            dual.IsReady = aReady && eReady;

            if (dual.Architect?.Errors != null)
            {
                foreach (var e in dual.Architect.Errors) dual.Errors.Add("ARCHITECT: " + e);
            }
            if (dual.Editor?.Errors != null)
            {
                foreach (var e in dual.Editor.Errors) dual.Errors.Add("EDITOR: " + e);
            }

            dual.Reason = BuildDualReason(dual);
            if (dual.Architect?.IsReady != true && dual.Editor?.IsReady == true)
            {
                var reasonCode = dual.Architect?.Errors != null && dual.Architect.Errors.Count > 0
                    ? dual.Architect.Errors[0]
                    : ErrorCodeReasoningUnsupported;
                EdogQaTelemetry.EmitContractEvent(
                    EdogQaTelemetry.EventArchitectFallback,
                    dual.Architect?.Deployment ?? string.Empty,
                    reasonCode,
                    dual.Reason);
            }
            Volatile.Write(ref _dualCached, dual);
            return dual;
        }

        private static string BuildDualReason(DualProbeResult dual)
        {
            if (dual.IsReady)
            {
                return $"V2 ready — Architect={dual.Architect.Deployment} Editor={dual.Editor.Deployment} ({dual.ElapsedMilliseconds}ms).";
            }
            var aReady = dual.Architect?.IsReady == true;
            var eReady = dual.Editor?.IsReady == true;

            string Detail(string role, ProbeResult r)
            {
                if (r == null) return $"{role}: <no result>";
                var dep = string.IsNullOrEmpty(r.Deployment) ? "?" : r.Deployment;
                if (r.Errors != null && r.Errors.Count > 0)
                {
                    return $"{role} (deployment={dep}): {string.Join(" | ", r.Errors)}";
                }
                return $"{role} (deployment={dep}): unknown failure";
            }

            if (!aReady && !eReady)
            {
                return "V2 unavailable — both probes failed. "
                    + Detail("ARCHITECT", dual.Architect) + " ;; "
                    + Detail("EDITOR", dual.Editor);
            }
            if (!aReady) return "V2 unavailable — " + Detail("ARCHITECT", dual.Architect) + " (Editor OK).";
            return "V2 unavailable — " + Detail("EDITOR", dual.Editor) + " (Architect OK).";
        }

        private static ProbeConfig ReadArchitectProbeConfigFromEnv()
        {
            return new ProbeConfig
            {
                Role = ProbeRole.Architect,
                Endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ARCHITECT_ENDPOINT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_ENDPOINT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
                    ?? string.Empty,
                ApiKey = Environment.GetEnvironmentVariable("AZURE_OPENAI_ARCHITECT_API_KEY")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_API_KEY")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_KEY")
                    ?? string.Empty,
                Deployment = Environment.GetEnvironmentVariable("AZURE_OPENAI_ARCHITECT_DEPLOYMENT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_DEPLOYMENT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_DEPLOYMENT")
                    ?? EdogQaLlmClient.DefaultArchitectDeployment,
                ApiVersion = Environment.GetEnvironmentVariable("AZURE_OPENAI_ARCHITECT_API_VERSION")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_API_VERSION")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_VERSION")
                    ?? EdogQaLlmClient.DefaultApiVersion,
            };
        }

        private static ProbeConfig ReadEditorProbeConfigFromEnv()
        {
            // Editor's fallback chain does NOT include PRO — see
            // EdogQaLlmClient.ReadEditorConfigFromEnv. The launcher
            // (edog.py) aliases PRO → base on subprocess env so the
            // Editor reaches the same endpoint when EDITOR_* are unset.
            return new ProbeConfig
            {
                Role = ProbeRole.Editor,
                Endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_EDITOR_ENDPOINT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
                    ?? string.Empty,
                ApiKey = Environment.GetEnvironmentVariable("AZURE_OPENAI_EDITOR_API_KEY")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_KEY")
                    ?? string.Empty,
                Deployment = Environment.GetEnvironmentVariable("AZURE_OPENAI_EDITOR_DEPLOYMENT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_DEPLOYMENT")
                    ?? EdogQaLlmClient.DefaultEditorDeployment,
                ApiVersion = Environment.GetEnvironmentVariable("AZURE_OPENAI_EDITOR_API_VERSION")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_VERSION")
                    ?? EdogQaLlmClient.DefaultApiVersion,
            };
        }

        // ── Helpers ────────────────────────────────────────────────────

        private static ProbeConfig ReadConfigFromEnv()
        {
            return new ProbeConfig
            {
                Endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_ENDPOINT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
                    ?? string.Empty,
                ApiKey = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_API_KEY")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_KEY")
                    ?? string.Empty,
                Deployment = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_DEPLOYMENT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_DEPLOYMENT")
                    ?? "gpt-5.4",
                ApiVersion = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_API_VERSION")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_VERSION")
                    ?? "2025-04-01-preview",
            };
        }

        private static string BuildProbeRequestBody(string deployment, int maxOutputTokens, ProbeRole role)
        {
            // Strict json_schema with a trivial {ok:boolean} contract is
            // the minimum surface that proves all four capabilities work
            // together. The user prompt is deliberately small to keep
            // probe cost negligible (~$0.0005 against gpt-5.4 mini).
            var reasoningEffort = role == ProbeRole.Architect ? "medium" : "low";
            var payload = new
            {
                model = deployment,
                input = new[]
                {
                    new
                    {
                        role = "user",
                        content = "You are a deployment probe. Reply with the JSON object that matches the schema. Set ok to true.",
                    },
                },
                reasoning = new { effort = reasoningEffort },
                max_output_tokens = maxOutputTokens,
                text = new
                {
                    format = new
                    {
                        type = "json_schema",
                        name = "edog_probe",
                        strict = true,
                        schema = new
                        {
                            type = "object",
                            properties = new
                            {
                                ok = new { type = "boolean" },
                            },
                            required = new[] { "ok" },
                            additionalProperties = false,
                        },
                    },
                },
            };

            return JsonSerializer.Serialize(payload);
        }

        private static async Task<string> ReadProbeResponseBodyAsync(HttpResponseMessage response, ProbeRole role, CancellationToken ct)
        {
            if (response?.Content == null)
            {
                return string.Empty;
            }

            if (role != ProbeRole.Architect)
            {
                return await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            }

            await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var firstTokenCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            firstTokenCts.CancelAfter(ArchitectFirstTokenTimeout);

            var prefix = new byte[1];
            var firstRead = await stream.ReadAsync(prefix.AsMemory(0, 1), firstTokenCts.Token).ConfigureAwait(false);
            if (firstRead == 0)
            {
                return string.Empty;
            }

            await using var buffer = new MemoryStream();
            await buffer.WriteAsync(prefix.AsMemory(0, firstRead), ct).ConfigureAwait(false);
            await stream.CopyToAsync(buffer, ct).ConfigureAwait(false);
            return Encoding.UTF8.GetString(buffer.ToArray());
        }

        private static void ClassifyHttpError(int statusCode, string body, ProbeResult result)
        {
            body ??= string.Empty;
            var bodyLower = body.ToLowerInvariant();

            if (statusCode == 404)
            {
                // Two flavours: deployment name unknown vs Responses API not enabled.
                if (bodyLower.Contains("deploymentnotfound")
                    || bodyLower.Contains("deployment not found")
                    || bodyLower.Contains("the api deployment for this resource does not exist"))
                {
                    result.Errors.Add(ErrorCodeDeploymentNotFound
                        + $" — deployment '{result.Deployment}' is not provisioned in this resource.");
                    return;
                }

                result.Errors.Add(ErrorCodeResponsesApiUnavailable
                    + " — POST /openai/responses returned 404."
                    + " The Responses API requires api-version=2025-04-01-preview (or later)"
                    + " and an Azure OpenAI deployment that supports it.");
                return;
            }

            if (statusCode == 400)
            {
                if (bodyLower.Contains("text.format")
                    || bodyLower.Contains("json_schema")
                    || bodyLower.Contains("response_format")
                    || bodyLower.Contains("structured output"))
                {
                    result.Errors.Add(ErrorCodeJsonSchemaStrictUnsupported
                        + " — text.format.type=\"json_schema\" with strict=true was rejected. "
                        + Truncate(body, 200));
                    return;
                }

                if (bodyLower.Contains("reasoning"))
                {
                    result.Errors.Add(ErrorCodeReasoningUnsupported
                        + " — reasoning.effort was rejected. " + Truncate(body, 200));
                    return;
                }

                result.Errors.Add(ErrorCodeNetworkError
                    + $" — HTTP 400. " + Truncate(body, 240));
                return;
            }

            // Generic catch-all (401/403/429/5xx etc.). These are not
            // capability failures; map to NETWORK_ERROR so the orchestrator
            // can render a clear "transient" message and the operator can
            // retry without redeploying.
            result.Errors.Add(ErrorCodeNetworkError
                + $" — HTTP {statusCode}. " + Truncate(body, 240));
        }

        private static bool TryParseProbeResponse(string body, int requestedMaxOutputTokens, ProbeResult result)
        {
            if (string.IsNullOrWhiteSpace(body))
            {
                result.Errors.Add(ErrorCodeResponseUnparseable + " — empty response body on HTTP 200.");
                return false;
            }

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(body);
            }
            catch (Exception ex)
            {
                result.Errors.Add(ErrorCodeResponseUnparseable
                    + " — could not parse response JSON: " + Truncate(ex.Message, 200));
                return false;
            }

            using (doc)
            {
                var root = doc.RootElement;

                // The Responses-API envelope must have a "status" and an "output" array.
                if (!root.TryGetProperty("status", out var statusElement)
                    || statusElement.ValueKind != JsonValueKind.String
                    || !root.TryGetProperty("output", out var outputElement)
                    || outputElement.ValueKind != JsonValueKind.Array)
                {
                    result.Errors.Add(ErrorCodeResponseUnparseable
                        + " — Responses-API envelope missing 'status' or 'output'.");
                    return false;
                }

                var status = statusElement.GetString();
                if (!string.Equals(status, "completed", StringComparison.OrdinalIgnoreCase))
                {
                    result.Errors.Add(ErrorCodeResponseUnparseable
                        + $" — status was '{status}', expected 'completed'.");
                    return false;
                }

                // ResponsesApiAvailable is true as soon as we got a valid envelope back.
                result.ResponsesApiAvailable = true;

                // Extract the assistant message text and verify it parses as our schema.
                var messageText = ExtractFirstMessageText(outputElement);
                if (!string.IsNullOrWhiteSpace(messageText)
                    && TryParseSchemaPayload(messageText, out var ok))
                {
                    // Strict schema honoured ⇒ ok must be a boolean and the JSON must parse.
                    result.JsonSchemaStrictSupported = ok;
                }
                else
                {
                    result.Errors.Add(ErrorCodeJsonSchemaStrictUnsupported
                        + " — model did not emit a JSON payload matching the requested schema."
                        + " message text was: " + Truncate(messageText ?? "<null>", 200));
                    // Continue — we still want to learn about reasoning support.
                }

                // Reasoning support: usage.output_tokens_details.reasoning_tokens must be present.
                if (root.TryGetProperty("usage", out var usage)
                    && usage.ValueKind == JsonValueKind.Object
                    && usage.TryGetProperty("output_tokens_details", out var details)
                    && details.ValueKind == JsonValueKind.Object
                    && details.TryGetProperty("reasoning_tokens", out var reasoningTokens)
                    && reasoningTokens.ValueKind == JsonValueKind.Number)
                {
                    result.ReasoningSupported = true;
                }
                else
                {
                    result.Errors.Add(ErrorCodeReasoningUnsupported
                        + " — usage.output_tokens_details.reasoning_tokens not reported."
                        + " The deployment is not a reasoning model OR did not include the field.");
                }

                // The probe completed with the requested ceiling not rejected.
                result.MaxOutputTokensVerified = requestedMaxOutputTokens;

                return true;
            }
        }

        private static string ExtractFirstMessageText(JsonElement outputArray)
        {
            foreach (var item in outputArray.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                if (!item.TryGetProperty("type", out var typeElement)
                    || typeElement.ValueKind != JsonValueKind.String) continue;
                if (typeElement.GetString() != "message") continue;
                if (!item.TryGetProperty("content", out var content)
                    || content.ValueKind != JsonValueKind.Array) continue;

                foreach (var contentItem in content.EnumerateArray())
                {
                    if (contentItem.ValueKind != JsonValueKind.Object) continue;
                    if (!contentItem.TryGetProperty("text", out var textElement)) continue;
                    if (textElement.ValueKind != JsonValueKind.String) continue;
                    return textElement.GetString();
                }
            }

            return null;
        }

        private static bool TryParseSchemaPayload(string text, out bool okValue)
        {
            okValue = false;
            try
            {
                using var doc = JsonDocument.Parse(text);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
                if (!doc.RootElement.TryGetProperty("ok", out var okElement)) return false;
                if (okElement.ValueKind == JsonValueKind.True) { okValue = true; return true; }
                if (okElement.ValueKind == JsonValueKind.False) { okValue = false; return true; }
                return false;
            }
            catch
            {
                return false;
            }
        }

        private static string SafeHost(string endpoint)
        {
            if (string.IsNullOrWhiteSpace(endpoint)) return string.Empty;
            try
            {
                var u = new Uri(endpoint.TrimEnd('/') + "/");
                return u.Host;
            }
            catch
            {
                return string.Empty;
            }
        }

        private static string Truncate(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return s ?? string.Empty;
            if (s.Length <= max) return s;
            return s.Substring(0, max) + "…";
        }
    }
}

