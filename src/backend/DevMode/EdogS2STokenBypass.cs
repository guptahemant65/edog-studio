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
    /// DevMode safety net for IS2STokenProvider that handles the case where
    /// the workload S2S certificate is expired or otherwise broken. For each
    /// CBA-mintable resource (currently storage.azure.com and PBI Shared),
    /// the bypass calls the real provider FIRST: a working FLT 1P cert mints
    /// a token with the trusted appid that OneLake's trusted-workload allowlist
    /// requires. Only if the real provider throws does the bypass fall back to
    /// the dev-server CBA endpoint. This keeps non-dev-mode behavior intact
    /// when the cert is healthy and only diverges when it must.
    ///
    /// History: the bypass originally called CBA FIRST, on the assumption that
    /// CBA tokens were functionally equivalent for dev-mode storage reads. They
    /// are not — CBA mints carry the dev-server's appid (FabricSparkCST,
    /// ea0616ba-...) which OneLake rejects with 401 "Untrusted client ID" when
    /// the trusted-workload allowlist is enforced. Once the AME cert was
    /// renewed in the EDOG cluster, the always-on CBA path started poisoning
    /// every DAG refresh (FLT swallows the 401 silently and reports empty
    /// catalogs). Inner-first restores correctness in the healthy-cert case
    /// while preserving the expired-cert safety net.
    ///
    /// Resources NOT in the bypass allowlist still delegate to the real
    /// provider unchanged.
    /// </summary>
    internal sealed class EdogS2STokenBypass : IS2STokenProvider
    {
        private const string DevServerEndpoint = "http://localhost:5555/api/edog/s2s-token";
        private const string StorageResource = "https://storage.azure.com";
        private const string PbiSharedResource = "https://analysis.windows.net/powerbi/api";

        // GTSFirstPartyApplicationId from Test.json (PPE). GTSBasedSparkClient.GenerateS2STokenForGTSWorkloadAsync
        // passes this bare GUID as the target audience to mint an S2S token used to call the Gateway Token
        // Service when runDAG triggers a Spark job. Without the real FLT 1P cert on the dev box, the inner
        // provider throws S2SAuthenticationException — CBA mint is the only DevMode escape hatch. NB: CBA
        // tokens carry the dev-server's appid (FabricSparkCST, ea0616ba-...) so this only works if GTS's
        // appid allowlist accepts FabricSparkCST in the target ring; otherwise the call will fail at GTS
        // with a clearer error than the AAD-side throw and the POC will need a real workload cert.
        private const string GtsResource = "82d3be98-d7ff-4d38-8592-8c417b6df004";

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
        /// Target-audience S2S — bypass for storage.azure.com, PBI Shared, and
        /// the GTS first-party application ID. Other audiences fall through to
        /// the real provider. This is the previously-uncovered path called by
        /// CatalogHandler (storage), and by GTSBasedSparkClient when runDAG
        /// triggers a Spark job (GTS).
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
            // Inner-first: a valid FLT 1P cert mints a token with the trusted
            // appid. CBA mint is only the safety net for the expired-cert case.
            try
            {
                var innerResult = await _inner.GetS2STokenForPbiSharedAsync().ConfigureAwait(false);
                if (innerResult != null)
                {
                    return innerResult;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] S2S Bypass: PBI Shared inner failed ({ex.Message}), falling back to CBA mint");
            }

            var token = await GetCachedOrMintAsync(PbiSharedResource, CancellationToken.None).ConfigureAwait(false);
            if (!string.IsNullOrEmpty(token))
            {
                return new AuthenticationHeaderValue("Bearer", token);
            }
            return null;
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
                || string.Equals(canonicalAudience, PbiSharedResource, StringComparison.OrdinalIgnoreCase)
                || string.Equals(canonicalAudience, GtsResource, StringComparison.OrdinalIgnoreCase);
        }

        private async Task<string> GetTokenViaCbaOrFallbackAsync(
            string resource,
            Func<Task<string>> innerCall,
            CancellationToken cancellationToken)
        {
            // Inner-first contract:
            //   1. Call the real provider. If it returns a non-empty token,
            //      use that — it carries the FLT 1P appid that OneLake's
            //      trusted-workload allowlist requires.
            //   2. If the real provider throws (e.g. S2SAuthenticationException
            //      when the AME cert is expired), fall back to the dev-server
            //      CBA mint. CBA tokens carry the dev-server appid which OneLake
            //      rejects (Untrusted client ID), but this still preserves the
            //      original cert-expired use case for other consumers (e.g.
            //      OneLakeRestClient where the strip handler removes the bad
            //      header before the wire).
            //   3. If the real provider returns null/empty, propagate that —
            //      FLT call sites with an IsNullOrEmpty check (e.g.
            //      OnelakeBasedFileSystem) will skip adding the header.
            try
            {
                var innerToken = await innerCall().ConfigureAwait(false);
                if (!string.IsNullOrEmpty(innerToken))
                {
                    return innerToken;
                }
                Console.WriteLine($"[EDOG] S2S Bypass: inner returned empty for {resource}, passing through");
                return innerToken;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] S2S Bypass: inner failed for {resource} ({ex.Message}), falling back to CBA mint");
            }

            return await GetCachedOrMintAsync(resource, cancellationToken).ConfigureAwait(false);
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
