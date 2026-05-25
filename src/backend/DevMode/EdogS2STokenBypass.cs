// <copyright file="EdogS2STokenBypass.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
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
    /// has expired. Intercepts every public method that requests a token for
    /// a CBA-mintable resource (currently storage.azure.com and PBI Shared)
    /// and serves it from the dev-server CBA endpoint instead of the broken
    /// AME cert path. Resources NOT in the bypass allowlist still delegate
    /// to the real provider so non-affected paths keep working untouched.
    ///
    /// Why this matters: the OneLake bypass alone (GetS2STokenForOneLakeAsync)
    /// is not enough — CatalogHandler.GetCatalogObjectsAsync (called on every
    /// LiveTableController.GetLatestDagAsync poll, which the studio hits every
    /// few seconds) calls GetS2STokenForTargetAudienceAsync(storage.azure.com)
    /// through the same provider. Without intercepting that method, every DAG
    /// refresh after deploy fails with S2SAuthenticationException.
    ///
    /// When the expired cert is eventually renewed, the bypass is harmless —
    /// CBA tokens are functionally equivalent for dev-mode storage reads.
    /// </summary>
    internal sealed class EdogS2STokenBypass : IS2STokenProvider
    {
        private const string DevServerEndpoint = "http://localhost:5555/api/edog/s2s-token";
        private const string StorageResource = "https://storage.azure.com";
        private const string PbiSharedResource = "https://analysis.windows.net/powerbi/api";
        private const int CacheBufferMinutes = 5;

        private static readonly HttpClient _httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(3),
        };

        // Per-resource token cache so the OneLake-via-OneLakeAsync path and
        // the OneLake-via-TargetAudience path share the same minted token.
        // Keyed by the canonical resource string (no trailing slash, no scope).
        private readonly ConcurrentDictionary<string, CachedToken> _tokenCache =
            new ConcurrentDictionary<string, CachedToken>(StringComparer.OrdinalIgnoreCase);

        private readonly IS2STokenProvider _inner;

        public EdogS2STokenBypass(IS2STokenProvider inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            Console.WriteLine("[EDOG] S2S Token Bypass active — storage.azure.com + PBI Shared via CBA dev-server");
        }

        // ── Public IS2STokenProvider surface ─────────────────────────────────

        /// <summary>OneLake storage token — CBA bypass (always intercepted).</summary>
        public async Task<string> GetS2STokenForOneLakeAsync(CancellationToken cancellationToken)
        {
            return await GetTokenViaCbaOrFallbackAsync(
                StorageResource,
                () => _inner.GetS2STokenForOneLakeAsync(cancellationToken),
                cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        /// Target-audience S2S — bypass for storage.azure.com and PBI Shared
        /// (the only two resources our dev-server can mint). Other audiences
        /// (e.g. GTS first-party app ID) fall through to the real provider.
        /// This is the previously-uncovered path called by CatalogHandler.
        /// </summary>
        public async Task<string> GetS2STokenForTargetAudienceAsync(string targetAudience)
        {
            var canonical = CanonicalizeAudience(targetAudience);
            Console.WriteLine($"[EDOG] S2S Bypass: GetS2STokenForTargetAudienceAsync called rawAudience='{targetAudience}' canonical='{canonical}' cbaMintable={IsCbaMintable(canonical)}");
            if (IsCbaMintable(canonical))
            {
                return await GetTokenViaCbaOrFallbackAsync(
                    canonical,
                    () => _inner.GetS2STokenForTargetAudienceAsync(targetAudience),
                    CancellationToken.None).ConfigureAwait(false);
            }
            return await _inner.GetS2STokenForTargetAudienceAsync(targetAudience).ConfigureAwait(false);
        }

        /// <summary>
        /// Tenant-scoped target-audience S2S — same allowlist logic. The CBA
        /// cert lives in the workload's home tenant; for dev-mode all reads
        /// resolve there too, so the tenantId argument is informational.
        /// Cross-tenant access would still fall through to the inner provider
        /// because the audience check happens first, but if a cross-tenant
        /// storage.azure.com call ever shows up it would (correctly) be served
        /// the same home-tenant CBA token — which is the dev-mode contract.
        /// </summary>
        public async Task<string> GetS2STokenForTargetAudienceAndTenantAsync(string targetAudience, string tenantId)
        {
            var canonical = CanonicalizeAudience(targetAudience);
            if (IsCbaMintable(canonical))
            {
                return await GetTokenViaCbaOrFallbackAsync(
                    canonical,
                    () => _inner.GetS2STokenForTargetAudienceAndTenantAsync(targetAudience, tenantId),
                    CancellationToken.None).ConfigureAwait(false);
            }
            return await _inner.GetS2STokenForTargetAudienceAndTenantAsync(targetAudience, tenantId).ConfigureAwait(false);
        }

        /// <summary>
        /// PBI Shared token — CBA bypass (the resource is in the dev-server
        /// allowlist). Wraps the raw token in AuthenticationHeaderValue to
        /// match the inner contract.
        /// </summary>
        public async Task<AuthenticationHeaderValue> GetS2STokenForPbiSharedAsync()
        {
            try
            {
                var token = await GetCachedOrMintAsync(PbiSharedResource, CancellationToken.None).ConfigureAwait(false);
                if (!string.IsNullOrEmpty(token))
                {
                    return new AuthenticationHeaderValue("Bearer", token);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] S2S Bypass: PBI Shared CBA failed ({ex.Message}), falling back to inner");
            }
            return await _inner.GetS2STokenForPbiSharedAsync().ConfigureAwait(false);
        }

        // ── Methods delegated unchanged (no CBA-mintable resource involved) ──

        public Task<string> GetS2STokenForMWCRolloutAsync(CancellationToken cancellationToken)
            => _inner.GetS2STokenForMWCRolloutAsync(cancellationToken);

        public Task<string> GetStorageServiceMwcTokenAsync(
            string tenantObjectId, string workspaceObjectId,
            ArtifactServiceTokenRequest artifactServiceTokenRequest)
            => _inner.GetStorageServiceMwcTokenAsync(tenantObjectId, workspaceObjectId, artifactServiceTokenRequest);

        public Task<string> GetOboTokenForTargetAudienceAsync(
            string userToken, string tenantId, string targetAudience,
            CancellationToken cancellationToken)
            => _inner.GetOboTokenForTargetAudienceAsync(userToken, tenantId, targetAudience, cancellationToken);

        // ── Private helpers ──────────────────────────────────────────────────

        private static string CanonicalizeAudience(string audience)
        {
            if (string.IsNullOrEmpty(audience)) return audience;
            // Strip trailing slash and ".default" / "/.default" scope suffix
            // so "https://storage.azure.com", "https://storage.azure.com/",
            // and "https://storage.azure.com/.default" all hit the same key.
            var trimmed = audience.Trim();
            if (trimmed.EndsWith("/.default", StringComparison.OrdinalIgnoreCase))
            {
                trimmed = trimmed.Substring(0, trimmed.Length - "/.default".Length);
            }
            else if (trimmed.EndsWith(".default", StringComparison.OrdinalIgnoreCase))
            {
                trimmed = trimmed.Substring(0, trimmed.Length - ".default".Length);
            }
            if (trimmed.EndsWith("/", StringComparison.Ordinal))
            {
                trimmed = trimmed.Substring(0, trimmed.Length - 1);
            }
            return trimmed;
        }

        private static bool IsCbaMintable(string canonicalAudience)
        {
            return string.Equals(canonicalAudience, StorageResource, StringComparison.OrdinalIgnoreCase)
                || string.Equals(canonicalAudience, PbiSharedResource, StringComparison.OrdinalIgnoreCase);
        }

        private async Task<string> GetTokenViaCbaOrFallbackAsync(
            string resource,
            Func<Task<string>> innerCall,
            CancellationToken cancellationToken)
        {
            try
            {
                var token = await GetCachedOrMintAsync(resource, cancellationToken).ConfigureAwait(false);
                if (!string.IsNullOrEmpty(token))
                {
                    return token;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] S2S Bypass: CBA failed for {resource} ({ex.Message}), falling back to inner");
            }
            // Fallback to the real provider — will likely fail if cert is expired,
            // but at least the error surface stays consistent with non-dev mode.
            return await innerCall().ConfigureAwait(false);
        }

        private async Task<string> GetCachedOrMintAsync(string resource, CancellationToken cancellationToken)
        {
            if (_tokenCache.TryGetValue(resource, out var cached) &&
                DateTime.UtcNow < cached.Expiry.AddMinutes(-CacheBufferMinutes))
            {
                Console.WriteLine($"[EDOG] S2S Bypass: cache HIT for {resource} (expiresUtc={cached.Expiry:o})");
                return cached.Token;
            }
            var (token, expiry) = await MintCbaTokenAsync(resource, cancellationToken).ConfigureAwait(false);
            if (!string.IsNullOrEmpty(token))
            {
                _tokenCache[resource] = new CachedToken(token, expiry);
                Console.WriteLine($"[EDOG] S2S Bypass: token acquired via CBA for {resource}");
            }
            return token;
        }

        private async Task<(string token, DateTime expiry)> MintCbaTokenAsync(string resource, CancellationToken cancellationToken)
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

            var expiry = DateTime.UtcNow.AddMinutes(55);
            if (root.TryGetProperty("expiresOn", out var expiresOnProp) && expiresOnProp.ValueKind == JsonValueKind.Number)
            {
                var unixSeconds = expiresOnProp.GetInt64();
                expiry = DateTimeOffset.FromUnixTimeSeconds(unixSeconds).UtcDateTime;
            }

            return (token, expiry);
        }

        private readonly struct CachedToken
        {
            public CachedToken(string token, DateTime expiry)
            {
                Token = token;
                Expiry = expiry;
            }
            public string Token { get; }
            public DateTime Expiry { get; }
        }
    }
}
