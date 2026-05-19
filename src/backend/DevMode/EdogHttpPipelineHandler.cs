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

            // STEP 2: Call original with timing — or synthesize / delay
            var sw = Stopwatch.StartNew();
            HttpResponseMessage response;
            var synthesized = false;

            if (chaosFault != null
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
            sw.Stop();

            // STEP 3: Capture response and publish
            try
            {
                var statusCode = (int)response.StatusCode;
                var responseHeaders = CaptureHeaders(response.Headers, response.Content?.Headers);
                var bodyPreview = await CaptureBodyPreview(response.Content).ConfigureAwait(false);
                var responseSizeBytes = response.Content?.Headers.ContentLength ?? 0;

                PublishHttpEvent(
                    method, url, statusCode,
                    Math.Round(sw.Elapsed.TotalMilliseconds, 2),
                    requestHeaders, responseHeaders, bodyPreview, correlationId,
                    requestBodyPreview, requestSizeBytes, responseSizeBytes,
                    chaosFault: chaosFault, synthesized: synthesized);
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
                Content = new StringContent(body),
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
            bool synthesized)
        {
            try
            {
                if (chaosFault != null)
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
                        chaos = new
                        {
                            fault = chaosFault.Fault,
                            scenarioId = chaosFault.ScenarioId,
                            target = chaosFault.TargetSubstring,
                            synthesized,
                        },
                    });
                }
                else
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
                    });
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] HttpPipelineHandler publish error: {ex.Message}");
            }
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
