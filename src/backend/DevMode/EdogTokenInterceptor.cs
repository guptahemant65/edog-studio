// <copyright file="EdogTokenInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Net.Http;
    using System.Reflection;
    using System.Text;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;

    /// <summary>
    /// DelegatingHandler that captures authentication header metadata from all HTTP requests.
    /// Publishes TokenEvent to the "token" topic via <see cref="EdogTopicRouter"/>.
    /// SECURITY: Raw token values are NEVER captured or published. Only metadata
    /// (type, audience, expiry). Authorization header values always redacted.
    /// </summary>
    public class EdogTokenInterceptor : DelegatingHandler
    {
        private readonly string _httpClientName;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogTokenInterceptor"/> class.
        /// </summary>
        /// <param name="httpClientName">Named HttpClient identifier from HttpClientNames.</param>
        public EdogTokenInterceptor(string httpClientName)
        {
            _httpClientName = httpClientName ?? string.Empty;
        }

        /// <inheritdoc/>
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            // STEP 1: Call original FIRST — interceptor is transparent
            var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

            // STEP 2: Extract auth header metadata (NEVER the raw token)
            try
            {
                var authHeader = request.Headers.Authorization;
                if (authHeader != null && !string.IsNullOrEmpty(authHeader.Scheme))
                {
                    var scheme = authHeader.Scheme;
                    var tokenType = ClassifyTokenType(scheme);
                    string audience = null;
                    string expiryUtc = null;
                    string issuedUtc = null;

                    if (scheme.Equals("Bearer", StringComparison.OrdinalIgnoreCase) &&
                        !string.IsNullOrEmpty(authHeader.Parameter))
                    {
                        DecodeJwtMetadata(authHeader.Parameter, out audience, out expiryUtc, out issuedUtc);
                    }

                    // STEP 3: Publish to "token" topic — non-blocking, thread-safe
                    EdogTopicRouter.Publish("token", new
                    {
                        tokenType,
                        scheme,
                        audience,
                        expiryUtc,
                        issuedUtc,
                        httpClientName = _httpClientName,
                        endpoint = request.RequestUri?.PathAndQuery,
                    });
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] TokenInterceptor error: {ex.Message}");
            }

            // STEP 4: Return original response UNMODIFIED
            return response;
        }

        /// <summary>
        /// Classifies token type from the Authorization header scheme.
        /// </summary>
        private static string ClassifyTokenType(string scheme)
        {
            if (string.IsNullOrEmpty(scheme)) return "Unknown";
            if (scheme.Equals("Bearer", StringComparison.OrdinalIgnoreCase)) return "Bearer";
            if (scheme.Equals("MwcToken", StringComparison.OrdinalIgnoreCase)) return "MwcToken";
            if (scheme.IndexOf("S2S", StringComparison.OrdinalIgnoreCase) >= 0) return "S2S";
            return scheme;
        }

        /// <summary>
        /// Decodes JWT payload (2nd base64url segment) to extract audience and expiry.
        /// SECURITY: Only reads metadata claims — aud, exp, iat. Raw token is never stored.
        /// </summary>
        private static void DecodeJwtMetadata(
            string token, out string audience, out string expiryUtc, out string issuedUtc)
        {
            audience = null;
            expiryUtc = null;
            issuedUtc = null;

            try
            {
                var parts = token.Split('.');
                if (parts.Length < 2) return;

                var payloadBytes = Base64UrlDecode(parts[1]);
                if (payloadBytes == null) return;

                using var doc = JsonDocument.Parse(payloadBytes);
                var root = doc.RootElement;

                // "aud" can be a string or an array of strings
                if (root.TryGetProperty("aud", out var aud))
                {
                    audience = aud.ValueKind == JsonValueKind.Array && aud.GetArrayLength() > 0
                        ? aud[0].GetString()
                        : aud.ValueKind == JsonValueKind.String
                            ? aud.GetString()
                            : null;
                }

                if (root.TryGetProperty("exp", out var exp) && exp.TryGetInt64(out var expVal))
                {
                    expiryUtc = DateTimeOffset.FromUnixTimeSeconds(expVal)
                        .UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ");
                }

                if (root.TryGetProperty("iat", out var iat) && iat.TryGetInt64(out var iatVal))
                {
                    issuedUtc = DateTimeOffset.FromUnixTimeSeconds(iatVal)
                        .UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ");
                }
            }
            catch
            {
                // Malformed JWT or non-JWT Bearer token — silently ignore
            }
        }

        /// <summary>
        /// Decodes a base64url-encoded string (no padding, URL-safe chars).
        /// </summary>
        private static byte[] Base64UrlDecode(string input)
        {
            try
            {
                var s = input.Replace('-', '+').Replace('_', '/');
                switch (s.Length % 4)
                {
                    case 2: s += "=="; break;
                    case 3: s += "="; break;
                }
                return Convert.FromBase64String(s);
            }
            catch
            {
                return null;
            }
        }
    }

    /// <summary>
    /// Wraps <see cref="IHttpClientFactory"/> to inject EDOG DelegatingHandlers
    /// (<see cref="EdogTokenInterceptor"/> + <see cref="EdogHttpPipelineHandler"/>)
    /// into every HttpClient pipeline. All named HttpClients (and any future ones)
    /// are automatically intercepted.
    /// Thread-safe — each CreateClient call builds a fresh handler chain.
    /// </summary>
    public class EdogHttpClientFactoryWrapper : IHttpClientFactory
    {
        private readonly IHttpClientFactory _inner;

        /// <summary>
        /// FieldInfo for HttpMessageInvoker._handler — used to extract the inner
        /// handler pipeline from factory-created HttpClients. Cached for performance.
        /// </summary>
        private static readonly FieldInfo s_handlerField =
            typeof(HttpMessageInvoker).GetField(
                "_handler",
                BindingFlags.Instance | BindingFlags.NonPublic);

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogHttpClientFactoryWrapper"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="IHttpClientFactory"/> to delegate to.</param>
        public EdogHttpClientFactoryWrapper(IHttpClientFactory inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <summary>
        /// Creates an HttpClient with EDOG interceptor handlers injected into the pipeline.
        /// Chain: EdogTokenInterceptor → EdogHttpPipelineHandler → original handler pipeline.
        /// Falls back to the original client if handler injection fails.
        /// </summary>
        /// <param name="name">The named HttpClient to create.</param>
        /// <returns>An HttpClient with EDOG handlers in the pipeline.</returns>
        public HttpClient CreateClient(string name)
        {
            var originalClient = _inner.CreateClient(name);

            try
            {
                var innerHandler = s_handlerField?.GetValue(originalClient) as HttpMessageHandler;
                if (innerHandler == null) return originalClient;

                // Build EDOG handler chain: Token → HTTP Pipeline → original pipeline
                var httpPipeline = new EdogHttpPipelineHandler(name) { InnerHandler = innerHandler };
                var tokenInterceptor = new EdogTokenInterceptor(name) { InnerHandler = httpPipeline };

                var client = new HttpClient(tokenInterceptor, disposeHandler: false);

                // Preserve client configuration from the original factory setup
                if (originalClient.BaseAddress != null)
                    client.BaseAddress = originalClient.BaseAddress;
                client.Timeout = originalClient.Timeout;

                return client;
            }
            catch (Exception ex)
            {
                // Never break FLT — return original unwrapped client on failure
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] HttpClientFactoryWrapper.CreateClient failed for '{name}': {ex.Message}");
                return originalClient;
            }
        }
    }
}
