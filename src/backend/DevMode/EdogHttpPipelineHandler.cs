// <copyright file="EdogHttpPipelineHandler.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Net.Http;
    using System.Net.Http.Headers;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.ServicePlatform.Telemetry;

    /// <summary>
    /// DelegatingHandler that captures the full HTTP request/response cycle for all HttpClient calls.
    /// Publishes HttpRequestEvent to the "http" topic via <see cref="EdogTopicRouter"/>.
    /// SECURITY: Authorization headers redacted. SAS tokens stripped from URLs.
    /// Response bodies truncated to 4KB.
    /// </summary>
    public class EdogHttpPipelineHandler : DelegatingHandler
    {
        private const int MaxBodyPreviewBytes = 4096;
        private const long MaxBufferableBytes = 10_485_760; // 10MB — skip buffering for huge responses

        private static readonly Regex SasTokenPattern = new(
            @"(?<=[\?&])(sig|se|st|sp|spr|sv|sr|sdd)=[^&]*",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private readonly string _httpClientName;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogHttpPipelineHandler"/> class.
        /// </summary>
        /// <param name="httpClientName">Named HttpClient identifier from HttpClientNames.</param>
        public EdogHttpPipelineHandler(string httpClientName)
        {
            _httpClientName = httpClientName ?? string.Empty;
        }

        /// <inheritdoc/>
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            // STEP 1: Snapshot request details BEFORE the call (objects may be disposed later)
            var method = request.Method.Method;
            var url = RedactUrl(request.RequestUri?.ToString());
            var requestHeaders = RedactRequestHeaders(request.Headers, request.Content?.Headers);
            var correlationId = ExtractCorrelationId(request.Headers);

            // Capture request body preview + size for POST/PUT/PATCH
            string requestBodyPreview = null;
            long requestSizeBytes = 0;
            try
            {
                if (request.Content != null)
                {
                    requestSizeBytes = request.Content.Headers.ContentLength ?? 0;
                    var ct = request.Content.Headers.ContentType;
                    if (ct != null && (ct.MediaType?.Contains("json") == true || ct.MediaType?.Contains("text") == true))
                    {
                        var body = await request.Content.ReadAsStringAsync().ConfigureAwait(false);
                        requestSizeBytes = requestSizeBytes > 0 ? requestSizeBytes : System.Text.Encoding.UTF8.GetByteCount(body);
                        requestBodyPreview = body.Length > MaxBodyPreviewBytes ? body.Substring(0, MaxBodyPreviewBytes) : body;
                    }
                }
            }
            catch { /* non-fatal */ }

            // F27 P5 Stage 2: consult the QA HTTP fault store. When a chaos
            // rule matches the outbound URI we either synthesize a fake
            // error response, inject a delay before forwarding, or throw a
            // cancellation. The store is empty in production (no scenario
            // pushed a rule) so the lookup short-circuits on _flatRules
            // length zero.
            HttpFaultEntry chaosFault = null;
            if (request.RequestUri != null)
            {
                EdogHttpFaultStore.TryMatchFault(request.RequestUri.AbsoluteUri, out chaosFault);
            }

            // Timeout fault: publish a synthetic event so the studio UI
            // can show the cancelled request, then throw without ever
            // calling base.SendAsync.
            if (chaosFault != null
                && string.Equals(chaosFault.Fault, "timeout", StringComparison.OrdinalIgnoreCase))
            {
                PublishHttpEvent(
                    method, url, statusCode: 0, durationMs: 0,
                    requestHeaders: requestHeaders, responseHeaders: null,
                    responseBodyPreview: null, correlationId: correlationId,
                    requestBodyPreview: requestBodyPreview,
                    requestSizeBytes: requestSizeBytes, responseSizeBytes: 0,
                    chaosFault: chaosFault, synthesized: true);

                throw new TaskCanceledException(
                    $"[QA chaos] Simulated timeout for '{chaosFault.TargetSubstring}' " +
                    $"(scenario {chaosFault.ScenarioId}).");
            }

            // F28 — MITM request-phase. Runs AFTER the chaos store (F27 P5 takes
            // precedence). On a breakpoint match we park here until the user
            // responds via MitmResumeBreakpoint, or the timeout fires.
            // Non-breakpoint actions (block/forge/modify/passthrough) execute
            // inline with no UI pause. All wrapped in try/catch — MITM must
            // never crash the handler.
            MitmRule mitmRequestRule = null;
            string mitmRequestInterceptId = null;
            MitmDecision mitmRequestDecision = null;
            HttpResponseMessage mitmForgedResponse = null;
            string mitmAction = null;
            MitmPhase mitmPhase = MitmPhase.Request;
            double mitmDurationMsPaused = 0;

            try
            {
                if (chaosFault == null
                    && MitmCoordinator.ShouldPauseRequest(request, _httpClientName, out mitmRequestRule)
                    && mitmRequestRule != null)
                {
                    mitmRequestInterceptId = "int-" + Guid.NewGuid().ToString("N");
                    var pauseStartTicks = Stopwatch.GetTimestamp();
                    var reqSnap = new MitmInterceptSnapshot
                    {
                        InterceptId = mitmRequestInterceptId,
                        RuleId = mitmRequestRule.Id,
                        RuleName = mitmRequestRule.Name,
                        Phase = MitmPhase.Request,
                        OwnerConnectionId = mitmRequestRule.OwnerConnectionId,
                        CreatedAtUtc = DateTimeOffset.UtcNow,
                        Request = new MitmRequestSnapshot
                        {
                            Method = method,
                            Url = url,
                            Headers = requestHeaders,
                            Body = requestBodyPreview,
                            BodyBytes = requestSizeBytes,
                            BodyTruncated = requestBodyPreview != null
                                && requestBodyPreview.Length >= MaxBodyPreviewBytes,
                            HttpClientName = _httpClientName,
                            CorrelationId = correlationId,
                        },
                    };
                    mitmRequestDecision = await MitmCoordinator.AwaitDecisionAsync(
                        mitmRequestInterceptId, reqSnap, mitmRequestRule, cancellationToken)
                        .ConfigureAwait(false);
                    mitmDurationMsPaused =
                        (Stopwatch.GetTimestamp() - pauseStartTicks) * 1000.0 / Stopwatch.Frequency;

                    switch (mitmRequestDecision?.Verdict)
                    {
                        case "modify":
                            ApplyRequestModifications(request, mitmRequestDecision.Modifications);
                            mitmAction = "modified";
                            break;
                        case "block":
                            if (mitmRequestDecision.Block != null)
                                mitmForgedResponse = mitmRequestDecision.Block.Materialize(request);
                            mitmAction = "blocked";
                            break;
                        case "forge":
                            if (mitmRequestDecision.Forge != null)
                                mitmForgedResponse = mitmRequestDecision.Forge.Materialize(request);
                            mitmAction = "forged";
                            break;
                        case "forward":
                        default:
                            mitmAction = "passthrough-tagged";
                            break;
                    }
                }
                else if (chaosFault == null && mitmRequestRule != null)
                {
                    // Non-breakpoint rule matched — execute inline without pausing.
                    mitmForgedResponse = ApplyNonBreakpointAction(request, mitmRequestRule, out mitmAction);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] MITM request-phase error: {ex.Message}");
            }

            // STEP 2: Call original with timing — or synthesize / delay
            var sw = Stopwatch.StartNew();
            HttpResponseMessage response;
            var synthesized = false;

            try
            {
                if (mitmForgedResponse != null)
                {
                    response = mitmForgedResponse;
                    synthesized = true;
                }
                else if (chaosFault != null
                    && string.Equals(chaosFault.Fault, "http_error", StringComparison.OrdinalIgnoreCase))
                {
                    response = SynthesizeErrorResponse(request, chaosFault);
                    synthesized = true;
                }
                else if (chaosFault != null
                    && string.Equals(chaosFault.Fault, "latency", StringComparison.OrdinalIgnoreCase))
                {
                    if (chaosFault.LatencyMs > 0)
                    {
                        await Task.Delay(chaosFault.LatencyMs, cancellationToken).ConfigureAwait(false);
                    }
                    response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (Exception sendEx)
            {
                // H1 fix: failed HTTP calls (DNS, timeout, socket reset,
                // cert error) used to escape silently — base.SendAsync
                // threw, the catch at line 220-ish never fired because
                // we never reached it, and the HTTP tab showed nothing.
                // Now we publish a synthetic event tagged with success=false
                // before rethrowing. FLT behaviour is preserved exactly:
                // the exception still propagates to the original caller.
                sw.Stop();
                PublishHttpEvent(
                    method, url, statusCode: 0,
                    durationMs: Math.Round(sw.Elapsed.TotalMilliseconds, 2),
                    requestHeaders: requestHeaders, responseHeaders: null,
                    responseBodyPreview: null, correlationId: correlationId,
                    requestBodyPreview: requestBodyPreview,
                    requestSizeBytes: requestSizeBytes, responseSizeBytes: 0,
                    chaosFault: chaosFault, synthesized: synthesized,
                    success: false,
                    errorMessage: sendEx.Message,
                    errorType: sendEx.GetType().FullName);
                throw;
            }

            sw.Stop();

            // STEP 3: Capture response and publish
            try
            {
                var statusCode = (int)response.StatusCode;
                var responseHeaders = CaptureHeaders(response.Headers, response.Content?.Headers);
                var bodyPreview = await CaptureBodyPreview(response.Content).ConfigureAwait(false);
                var responseSizeBytes = response.Content?.Headers.ContentLength ?? 0;

                // F28 — MITM response-phase. Skipped when the request was already
                // short-circuited (block/forge at request-phase). v1 only supports
                // "forward" and "modify" verdicts here; forge/block on the response
                // phase are validated out at rule-insert time by MitmRuleStore.
                MitmRule mitmResponseRule = null;
                string mitmResponseInterceptId = null;
                try
                {
                    if (mitmForgedResponse == null
                        && MitmCoordinator.ShouldPauseResponse(
                            response, mitmRequestRule, request, _httpClientName, out mitmResponseRule)
                        && mitmResponseRule != null)
                    {
                        mitmResponseInterceptId = "int-" + Guid.NewGuid().ToString("N");
                        var pauseStartTicks = Stopwatch.GetTimestamp();
                        var rspSnap = new MitmInterceptSnapshot
                        {
                            InterceptId = mitmResponseInterceptId,
                            RuleId = mitmResponseRule.Id,
                            RuleName = mitmResponseRule.Name,
                            Phase = MitmPhase.Response,
                            OwnerConnectionId = mitmResponseRule.OwnerConnectionId,
                            CreatedAtUtc = DateTimeOffset.UtcNow,
                            Request = new MitmRequestSnapshot
                            {
                                Method = method,
                                Url = url,
                                Headers = requestHeaders,
                                Body = requestBodyPreview,
                                BodyBytes = requestSizeBytes,
                                HttpClientName = _httpClientName,
                                CorrelationId = correlationId,
                            },
                            Response = new MitmResponseSnapshot
                            {
                                StatusCode = statusCode,
                                Headers = responseHeaders,
                                Body = bodyPreview,
                                BodyBytes = responseSizeBytes,
                                BodyTruncated = bodyPreview != null
                                    && bodyPreview.Length >= MaxBodyPreviewBytes,
                                DurationMs = Math.Round(sw.Elapsed.TotalMilliseconds, 2),
                            },
                        };
                        var rspDecision = await MitmCoordinator.AwaitDecisionAsync(
                            mitmResponseInterceptId, rspSnap, mitmResponseRule, cancellationToken)
                            .ConfigureAwait(false);
                        mitmDurationMsPaused +=
                            (Stopwatch.GetTimestamp() - pauseStartTicks) * 1000.0 / Stopwatch.Frequency;

                        if (rspDecision?.Verdict == "modify")
                        {
                            ApplyResponseModifications(response, rspDecision.Modifications);
                            mitmAction = "response-modified";
                            mitmPhase = MitmPhase.Response;
                            // Refresh captured fields so the published event reflects the edit
                            responseHeaders = CaptureHeaders(response.Headers, response.Content?.Headers);
                            bodyPreview = await CaptureBodyPreview(response.Content).ConfigureAwait(false);
                            responseSizeBytes = response.Content?.Headers.ContentLength ?? 0;
                        }
                        else if (mitmAction == null)
                        {
                            mitmAction = "passthrough-tagged";
                            mitmPhase = MitmPhase.Response;
                        }
                    }
                }
                catch (Exception mex)
                {
                    Debug.WriteLine($"[EDOG] MITM response-phase error: {mex.Message}");
                }

                // Pick the most recent MITM context for annotation on the http event.
                var mitmRuleForEvent = mitmResponseRule ?? mitmRequestRule;
                var mitmInterceptIdForEvent = mitmResponseInterceptId ?? mitmRequestInterceptId;
                var mitmVerdictForEvent = mitmRequestDecision?.Verdict;

                PublishHttpEvent(
                    method, url, statusCode,
                    Math.Round(sw.Elapsed.TotalMilliseconds, 2),
                    requestHeaders, responseHeaders, bodyPreview, correlationId,
                    requestBodyPreview, requestSizeBytes, responseSizeBytes,
                    chaosFault: chaosFault, synthesized: synthesized,
                    mitmAction: mitmAction,
                    mitmRule: mitmRuleForEvent,
                    mitmInterceptId: mitmInterceptIdForEvent,
                    mitmVerdict: mitmVerdictForEvent,
                    mitmPhase: mitmPhase,
                    mitmDurationMsPaused: mitmDurationMsPaused);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] HttpPipelineHandler error: {ex.Message}");
            }

            // STEP 4: Return original response (real or synthesized)
            return response;
        }

        /// <summary>
        /// Builds a fake <see cref="HttpResponseMessage"/> from a QA
        /// chaos rule. Used by Stage 2 HTTP fault injection so a scenario's
        /// failure-path assertion can fire without an actual broken upstream.
        /// </summary>
        private static HttpResponseMessage SynthesizeErrorResponse(
            HttpRequestMessage request, HttpFaultEntry fault)
        {
            var statusCode = fault.StatusCode >= 100 && fault.StatusCode <= 599
                ? fault.StatusCode
                : 500;
            var body = fault.ResponseBody ?? string.Empty;
            return new HttpResponseMessage((System.Net.HttpStatusCode)statusCode)
            {
                RequestMessage = request,
                ReasonPhrase = $"QA chaos: {fault.Fault}",
                Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
            };
        }

        /// <summary>
        /// Publishes an http topic event, optionally tagged with chaos
        /// metadata when the request was intercepted by the QA fault store.
        /// On the no-fault path the wire shape is identical to the
        /// pre-Stage-2 baseline — the <c>chaos</c> property is omitted
        /// entirely rather than emitted as <c>null</c> so existing topic
        /// consumers see no change.
        /// </summary>
        private void PublishHttpEvent(
            string method,
            string url,
            int statusCode,
            double durationMs,
            Dictionary<string, string> requestHeaders,
            Dictionary<string, string> responseHeaders,
            string responseBodyPreview,
            string correlationId,
            string requestBodyPreview,
            long requestSizeBytes,
            long responseSizeBytes,
            HttpFaultEntry chaosFault,
            bool synthesized,
            string mitmAction = null,
            MitmRule mitmRule = null,
            string mitmInterceptId = null,
            string mitmVerdict = null,
            MitmPhase mitmPhase = MitmPhase.Request,
            double mitmDurationMsPaused = 0,
            // H1 fix — failure capture fields. Default success=true keeps
            // every existing call site unchanged on the happy path.
            bool success = true,
            string errorMessage = null,
            string errorType = null)
        {
            try
            {
                // H2 fix — read ambient context at publish time so every
                // http event tags the RAID and (best-effort) iteration of
                // the request that triggered the call. Same pattern as
                // EdogFileSystemInterceptor + EdogAdditionalTelemetryInterceptor.
                var rootActivityId = MonitoredScope.RootActivityId.ToString();
                var iterationId = EdogLogInterceptor.TryGetIterationForRootActivity(rootActivityId);

                // Fast path: no chaos, no mitm, no failure → pre-F27/F28
                // wire shape PLUS the new rootActivityId/iterationId fields
                // and the success=true marker (additive; existing consumers
                // ignore unknown keys).
                if (chaosFault == null && mitmAction == null && success)
                {
                    EdogTopicRouter.Publish("http", new
                    {
                        method,
                        url,
                        statusCode,
                        durationMs,
                        requestHeaders,
                        responseHeaders,
                        responseBodyPreview,
                        requestBodyPreview,
                        requestSizeBytes,
                        responseSizeBytes,
                        httpClientName = _httpClientName,
                        correlationId,
                        rootActivityId,
                        iterationId,
                        success = true,
                    });
                    return;
                }

                // Either chaos, mitm, or failure (or any combination). Build
                // a dictionary so we can conditionally include `chaos`/`mitm`
                // without emitting nulls.
                var payload = new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    ["method"] = method,
                    ["url"] = url,
                    ["statusCode"] = statusCode,
                    ["durationMs"] = durationMs,
                    ["requestHeaders"] = requestHeaders,
                    ["responseHeaders"] = responseHeaders,
                    ["responseBodyPreview"] = responseBodyPreview,
                    ["requestBodyPreview"] = requestBodyPreview,
                    ["requestSizeBytes"] = requestSizeBytes,
                    ["responseSizeBytes"] = responseSizeBytes,
                    ["httpClientName"] = _httpClientName,
                    ["correlationId"] = correlationId,
                    ["rootActivityId"] = rootActivityId,
                    ["iterationId"] = iterationId,
                    ["success"] = success,
                };

                if (!success)
                {
                    payload["errorMessage"] = errorMessage;
                    payload["errorType"] = errorType;
                }

                if (chaosFault != null)
                {
                    payload["chaos"] = new
                    {
                        fault = chaosFault.Fault,
                        scenarioId = chaosFault.ScenarioId,
                        target = chaosFault.TargetSubstring,
                        synthesized,
                    };
                }

                if (mitmAction != null)
                {
                    payload["mitm"] = new
                    {
                        ruleId = mitmRule?.Id,
                        ruleName = mitmRule?.Name,
                        interceptId = mitmInterceptId,
                        action = mitmAction,
                        phase = mitmPhase.ToString().ToLowerInvariant(),
                        verdict = mitmVerdict,
                        durationMsPaused = Math.Round(mitmDurationMsPaused, 2),
                    };
                }

                EdogTopicRouter.Publish("http", payload);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] HttpPipelineHandler publish error: {ex.Message}");
            }
        }

        // ──────────────────────────────────────────────────────────────
        // F28 MITM helpers — request/response mutation + non-breakpoint actions.
        // All wrapped in try/catch; failures degrade to "no mutation applied".
        // ──────────────────────────────────────────────────────────────

        /// <summary>Mutates the live <see cref="HttpRequestMessage"/> in place per the supplied modifications.</summary>
        private static void ApplyRequestModifications(HttpRequestMessage req, MitmModifications mods)
        {
            if (req == null || mods == null) return;
            try
            {
                if (!string.IsNullOrEmpty(mods.Method))
                {
                    req.Method = new HttpMethod(mods.Method);
                }

                if (!string.IsNullOrEmpty(mods.Url))
                {
                    if (Uri.TryCreate(mods.Url, UriKind.RelativeOrAbsolute, out var newUri))
                        req.RequestUri = newUri;
                }

                if (mods.RemoveHeaders != null)
                {
                    foreach (var h in mods.RemoveHeaders)
                    {
                        if (string.IsNullOrEmpty(h)) continue;
                        req.Headers.Remove(h);
                        req.Content?.Headers.Remove(h);
                    }
                }

                if (mods.SetHeaders != null)
                {
                    foreach (var kv in mods.SetHeaders)
                    {
                        if (string.IsNullOrEmpty(kv.Key)) continue;
                        req.Headers.Remove(kv.Key);
                        if (!req.Headers.TryAddWithoutValidation(kv.Key, kv.Value))
                        {
                            req.Content?.Headers.Remove(kv.Key);
                            req.Content?.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
                        }
                    }
                }

                if (mods.Body != null)
                {
                    // BE-005: Dispose old content to avoid stream/buffer leak on each modify.
                    var oldContent = req.Content;
                    var existingCt = oldContent?.Headers.ContentType;
                    req.Content = new System.Net.Http.StringContent(mods.Body);
                    if (existingCt != null) req.Content.Headers.ContentType = existingCt;
                    oldContent?.Dispose();
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] MITM ApplyRequestModifications error: {ex.Message}");
            }
        }

        /// <summary>Mutates the live <see cref="HttpResponseMessage"/> in place per the supplied modifications.</summary>
        private static void ApplyResponseModifications(HttpResponseMessage rsp, MitmModifications mods)
        {
            if (rsp == null || mods == null) return;
            try
            {
                if (mods.RemoveHeaders != null)
                {
                    foreach (var h in mods.RemoveHeaders)
                    {
                        if (string.IsNullOrEmpty(h)) continue;
                        rsp.Headers.Remove(h);
                        rsp.Content?.Headers.Remove(h);
                    }
                }

                if (mods.SetHeaders != null)
                {
                    foreach (var kv in mods.SetHeaders)
                    {
                        if (string.IsNullOrEmpty(kv.Key)) continue;
                        rsp.Headers.Remove(kv.Key);
                        if (!rsp.Headers.TryAddWithoutValidation(kv.Key, kv.Value))
                        {
                            rsp.Content?.Headers.Remove(kv.Key);
                            rsp.Content?.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
                        }
                    }
                }

                if (mods.Body != null)
                {
                    // BE-005: Dispose old content to avoid stream/buffer leak on each modify.
                    var oldContent = rsp.Content;
                    var existingCt = oldContent?.Headers.ContentType;
                    rsp.Content = new System.Net.Http.StringContent(mods.Body);
                    if (existingCt != null) rsp.Content.Headers.ContentType = existingCt;
                    oldContent?.Dispose();
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] MITM ApplyResponseModifications error: {ex.Message}");
            }
        }

        /// <summary>
        /// Executes a non-breakpoint MITM action (block/forge/modify/passthrough) inline.
        /// Returns a materialized response for block/forge or null when the request should
        /// proceed (possibly mutated for modify). Sets <paramref name="action"/> to the
        /// mitm.action label that will appear on the published http event.
        /// </summary>
        private static HttpResponseMessage ApplyNonBreakpointAction(
            HttpRequestMessage req, MitmRule rule, out string action)
        {
            action = "passthrough-tagged";
            try
            {
                switch (rule?.Action)
                {
                    case MitmBlockAction blk:
                        action = "blocked";
                        return new MitmForgePayload
                        {
                            StatusCode = blk.StatusCode,
                            Body = blk.Body,
                            Headers = blk.Headers,
                        }.Materialize(req);

                    case MitmForgeAction fg:
                        action = "forged";
                        return new MitmForgePayload
                        {
                            StatusCode = fg.StatusCode,
                            Body = fg.Body,
                            Headers = fg.Headers,
                            ReasonPhrase = fg.ReasonPhrase,
                        }.Materialize(req);

                    case MitmModifyAction mod:
                        ApplyRequestModifications(req, new MitmModifications
                        {
                            Url = mod.ReplacementUrl,
                            SetHeaders = mod.SetHeaders,
                            RemoveHeaders = mod.RemoveHeaders,
                            Body = mod.ReplacementBody,
                        });
                        action = "modified";
                        return null;

                    case MitmPassthroughAction _:
                        action = "passthrough-tagged";
                        return null;
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] MITM ApplyNonBreakpointAction error: {ex.Message}");
            }

            return null;
        }

        /// <summary>
        /// Strips SAS token parameters from URLs. Replaces sig, se, st, sp, etc. with [redacted].
        /// </summary>
        private static string RedactUrl(string url)
        {
            if (string.IsNullOrEmpty(url)) return url;
            try
            {
                if (!url.Contains("sig=")) return url;
                return SasTokenPattern.Replace(url, "$1=[redacted]");
            }
            catch
            {
                return url;
            }
        }

        /// <summary>
        /// Captures request headers with Authorization value replaced by [redacted].
        /// </summary>
        private static Dictionary<string, string> RedactRequestHeaders(
            HttpRequestHeaders requestHeaders, HttpContentHeaders contentHeaders)
        {
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                if (requestHeaders != null)
                {
                    foreach (var h in requestHeaders)
                    {
                        headers[h.Key] = h.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
                            ? "[redacted]"
                            : string.Join(", ", h.Value);
                    }
                }

                if (contentHeaders != null)
                {
                    foreach (var h in contentHeaders)
                        headers[h.Key] = string.Join(", ", h.Value);
                }
            }
            catch
            {
                // Header enumeration failed — return partial results
            }

            return headers;
        }

        /// <summary>
        /// Captures response headers. No redaction needed — responses don't contain auth secrets.
        /// </summary>
        private static Dictionary<string, string> CaptureHeaders(
            HttpResponseHeaders responseHeaders, HttpContentHeaders contentHeaders)
        {
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                if (responseHeaders != null)
                {
                    foreach (var h in responseHeaders)
                        headers[h.Key] = string.Join(", ", h.Value);
                }

                if (contentHeaders != null)
                {
                    foreach (var h in contentHeaders)
                        headers[h.Key] = string.Join(", ", h.Value);
                }
            }
            catch
            {
                // Header enumeration failed — return partial results
            }

            return headers;
        }

        /// <summary>
        /// Extracts correlation ID from common Microsoft correlation request headers.
        /// </summary>
        private static string ExtractCorrelationId(HttpRequestHeaders headers)
        {
            string[] correlationHeaders =
            {
                "x-ms-correlation-id",
                "x-ms-request-id",
                "x-ms-client-request-id",
                "Request-Id",
            };

            foreach (var name in correlationHeaders)
            {
                if (headers.TryGetValues(name, out var vals))
                    return string.Join(", ", vals);
            }

            return null;
        }

        /// <summary>
        /// Reads first 4KB of response body without consuming the stream.
        /// Uses LoadIntoBufferAsync so the content remains readable for the actual consumer.
        /// Skips binary content and payloads larger than 10MB.
        /// </summary>
        private static async Task<string> CaptureBodyPreview(HttpContent content)
        {
            if (content == null) return null;

            try
            {
                // Skip oversized payloads to avoid memory pressure
                if (content.Headers.ContentLength > MaxBufferableBytes)
                    return "[body >10MB, skipped]";

                // Skip binary content types
                if (!IsTextContent(content.Headers.ContentType?.MediaType))
                    return null;

                // Buffer the content so the stream supports seeking
                await content.LoadIntoBufferAsync().ConfigureAwait(false);
                var stream = await content.ReadAsStreamAsync().ConfigureAwait(false);
                if (!stream.CanSeek) return null;

                var position = stream.Position;
                stream.Position = 0;

                var buffer = new byte[MaxBodyPreviewBytes];
                var bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);

                // Reset stream position for the real consumer
                stream.Position = position;

                if (bytesRead == 0) return null;
                return System.Text.Encoding.UTF8.GetString(buffer, 0, bytesRead);
            }
            catch
            {
                // Stream already consumed, disposed, or not readable — non-fatal
                return null;
            }
        }

        /// <summary>
        /// Returns true for media types that are human-readable text.
        /// </summary>
        private static bool IsTextContent(string mediaType)
        {
            if (string.IsNullOrEmpty(mediaType)) return true; // assume text if not specified
            return mediaType.Contains("json") || mediaType.Contains("xml") ||
                   mediaType.Contains("text") || mediaType.Contains("html") ||
                   mediaType.Contains("javascript") || mediaType.Contains("form-urlencoded");
        }
    }
}
