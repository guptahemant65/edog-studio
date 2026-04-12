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

            // STEP 2: Call original with timing
            var sw = Stopwatch.StartNew();
            var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            sw.Stop();

            // STEP 3: Capture response and publish
            try
            {
                var statusCode = (int)response.StatusCode;
                var responseHeaders = CaptureHeaders(response.Headers, response.Content?.Headers);
                var bodyPreview = await CaptureBodyPreview(response.Content).ConfigureAwait(false);

                EdogTopicRouter.Publish("http", new
                {
                    method,
                    url,
                    statusCode,
                    durationMs = Math.Round(sw.Elapsed.TotalMilliseconds, 2),
                    requestHeaders,
                    responseHeaders,
                    responseBodyPreview = bodyPreview,
                    httpClientName = _httpClientName,
                    correlationId,
                });
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] HttpPipelineHandler error: {ex.Message}");
            }

            // STEP 4: Return original response UNMODIFIED
            return response;
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
