// <copyright file="EdogS2STokenBypass.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Net.Http;
    using System.Net.Http.Headers;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;

    using Microsoft.LiveTable.Service.TridentIntegration.PartnerAuthorization;
    using Microsoft.MWC.Workload.Client.Library.DataModel.MwcToken;
    using Microsoft.MWC.Workload.Client.Library.Utils.WebApi;

    /// <summary>
    /// DevMode bypass for IS2STokenProvider when the workload S2S certificate
    /// has expired. Intercepts <see cref="GetS2STokenForOneLakeAsync"/> and
    /// mints a CBA user-delegated token via the dev-server instead.
    ///
    /// All other methods delegate to the real S2STokenProvider — we only
    /// bypass the known-broken path (OneLake storage token) to minimize blast
    /// radius. The CBA token works because Admin1CBA is a workspace admin
    /// with OneLake access, and OneLake accepts both user and S2S tokens.
    ///
    /// When the expired cert is eventually renewed, the bypass is harmless —
    /// CBA tokens are functionally equivalent for dev-mode OneLake reads.
    /// </summary>
    internal sealed class EdogS2STokenBypass : IS2STokenProvider
    {
        private const string DevServerEndpoint = "http://localhost:5555/api/edog/s2s-token";
        private const string StorageResource = "https://storage.azure.com";

        private static readonly HttpClient _httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(3),
        };

        private readonly IS2STokenProvider _inner;

        // Simple in-memory token cache to avoid repeated HTTP calls.
        // CBA tokens have ~1h TTL — refresh when <5 min remaining.
        private string _cachedOneLakeToken;
        private DateTime _cachedOneLakeExpiry = DateTime.MinValue;
        private readonly object _cacheLock = new object();
        private const int CacheBufferMinutes = 5;

        public EdogS2STokenBypass(IS2STokenProvider inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            Console.WriteLine("[EDOG] S2S Token Bypass active — OneLake tokens via CBA dev-server");
        }

        /// <summary>OneLake storage token — CBA bypass (the known failing path).</summary>
        public async Task<string> GetS2STokenForOneLakeAsync(CancellationToken cancellationToken)
        {
            // Check cache first
            lock (_cacheLock)
            {
                if (_cachedOneLakeToken != null &&
                    DateTime.UtcNow < _cachedOneLakeExpiry.AddMinutes(-CacheBufferMinutes))
                {
                    return _cachedOneLakeToken;
                }
            }

            // Try CBA bypass via dev-server
            try
            {
                var token = await MintCbaTokenAsync(StorageResource, cancellationToken).ConfigureAwait(false);
                if (!string.IsNullOrEmpty(token))
                {
                    Console.WriteLine("[EDOG] S2S Bypass: OneLake token acquired via CBA");
                    return token;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] S2S Bypass: CBA failed ({ex.Message}), falling back to inner");
            }

            // Fallback to real provider (will likely fail if cert is expired)
            return await _inner.GetS2STokenForOneLakeAsync(cancellationToken).ConfigureAwait(false);
        }

        // ── All other methods delegate to the real provider ──────────────────

        public Task<string> GetS2STokenForMWCRolloutAsync(CancellationToken cancellationToken)
            => _inner.GetS2STokenForMWCRolloutAsync(cancellationToken);

        public Task<string> GetStorageServiceMwcTokenAsync(
            string tenantObjectId, string workspaceObjectId,
            ArtifactServiceTokenRequest artifactServiceTokenRequest)
            => _inner.GetStorageServiceMwcTokenAsync(tenantObjectId, workspaceObjectId, artifactServiceTokenRequest);

        public Task<string> GetS2STokenForTargetAudienceAndTenantAsync(string targetAudience, string tenantId)
            => _inner.GetS2STokenForTargetAudienceAndTenantAsync(targetAudience, tenantId);

        public Task<string> GetS2STokenForTargetAudienceAsync(string targetAudience)
            => _inner.GetS2STokenForTargetAudienceAsync(targetAudience);

        public Task<AuthenticationHeaderValue> GetS2STokenForPbiSharedAsync()
            => _inner.GetS2STokenForPbiSharedAsync();

        public Task<string> GetOboTokenForTargetAudienceAsync(
            string userToken, string tenantId, string targetAudience,
            CancellationToken cancellationToken)
            => _inner.GetOboTokenForTargetAudienceAsync(userToken, tenantId, targetAudience, cancellationToken);

        // ── Private helpers ──────────────────────────────────────────────────

        private async Task<string> MintCbaTokenAsync(string resource, CancellationToken cancellationToken)
        {
            var url = $"{DevServerEndpoint}?resource={Uri.EscapeDataString(resource)}";
            using var response = await _httpClient.GetAsync(url, cancellationToken).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                var errorBody = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                throw new InvalidOperationException(
                    $"Dev-server S2S mint returned {(int)response.StatusCode}: {errorBody}");
            }

            var json = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var token = root.GetProperty("token").GetString();
            if (string.IsNullOrEmpty(token))
            {
                throw new InvalidOperationException("Dev-server returned empty token");
            }

            // Cache the token
            if (root.TryGetProperty("expiresOn", out var expiresOnProp))
            {
                var unixSeconds = expiresOnProp.GetInt64();
                var expiry = DateTimeOffset.FromUnixTimeSeconds(unixSeconds).UtcDateTime;
                lock (_cacheLock)
                {
                    _cachedOneLakeToken = token;
                    _cachedOneLakeExpiry = expiry;
                }
            }

            return token;
        }
    }
}
