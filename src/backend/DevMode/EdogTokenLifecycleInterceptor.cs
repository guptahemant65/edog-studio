// <copyright file="EdogTokenLifecycleInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Diagnostics;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.TokenManagement;

    /// <summary>
    /// Decorator that wraps <see cref="ITokenManager"/> to intercept all token lifecycle operations.
    /// Publishes events to the "token" topic via <see cref="EdogTopicRouter"/>.
    /// Thread-safe. Zero overhead on caller — publish failures never propagate to FLT.
    /// SECURITY: Never captures or publishes raw token values. Only metadata (audience, tenant, duration, IDs).
    /// </summary>
    internal class EdogTokenLifecycleInterceptor : ITokenManager
    {
        private readonly ITokenManager _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogTokenLifecycleInterceptor"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="ITokenManager"/> to delegate to.</param>
        public EdogTokenLifecycleInterceptor(ITokenManager inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public async Task<string> GetOboTokenForTridentLakeAsync(Guid tenantId, string mwcToken)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var token = await _inner.GetOboTokenForTridentLakeAsync(tenantId, mwcToken).ConfigureAwait(false);
                sw.Stop();

                PublishEvent(new
                {
                    @event = "OboExchange",
                    provider = "TokenManager",
                    audience = "TridentLake",
                    tenantId = tenantId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return token;
            }
            catch (Exception ex)
            {
                sw.Stop();

                PublishEvent(new
                {
                    @event = "OboExchange",
                    provider = "TokenManager",
                    audience = "TridentLake",
                    tenantId = tenantId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<string> GetTokenAsync(Guid lakehouseId, Guid iterationId, CancellationToken ct = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var token = await _inner.GetTokenAsync(lakehouseId, iterationId, ct).ConfigureAwait(false);
                sw.Stop();

                // Infer cache behavior from timing:
                // < 5ms strongly suggests cache hit; > 100ms suggests refresh
                var cacheInference = sw.ElapsedMilliseconds < 5 ? "hit"
                    : sw.ElapsedMilliseconds > 100 ? "refresh" : "uncertain";

                PublishEvent(new
                {
                    @event = "TokenAcquired",
                    provider = "TokenManager",
                    method = "GetTokenAsync",
                    lakehouseId = lakehouseId.ToString(),
                    iterationId = iterationId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    cacheInference,
                });

                return token;
            }
            catch (Exception ex)
            {
                sw.Stop();

                PublishEvent(new
                {
                    @event = "TokenAcquired",
                    provider = "TokenManager",
                    method = "GetTokenAsync",
                    lakehouseId = lakehouseId.ToString(),
                    iterationId = iterationId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    cacheInference = "error",
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public void CacheToken(Guid lakehouseId, Guid iterationId, string userToken)
        {
            try
            {
                _inner.CacheToken(lakehouseId, iterationId, userToken);
            }
            catch (Exception ex)
            {
                PublishEvent(new
                {
                    @event = "TokenCached",
                    lakehouseId = lakehouseId.ToString(),
                    iterationId = iterationId.ToString(),
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }

            PublishEvent(new
            {
                @event = "TokenCached",
                lakehouseId = lakehouseId.ToString(),
                iterationId = iterationId.ToString(),
                success = true,
            });
        }

        /// <inheritdoc/>
        public bool UpdateCachedToken(Guid lakehouseId, Guid iterationId, string userToken)
        {
            try
            {
                var result = _inner.UpdateCachedToken(lakehouseId, iterationId, userToken);

                PublishEvent(new
                {
                    @event = "TokenRefreshAttempt",
                    lakehouseId = lakehouseId.ToString(),
                    iterationId = iterationId.ToString(),
                    refreshed = result,
                });

                return result;
            }
            catch (Exception ex)
            {
                PublishEvent(new
                {
                    @event = "TokenRefreshAttempt",
                    lakehouseId = lakehouseId.ToString(),
                    iterationId = iterationId.ToString(),
                    refreshed = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public void DeleteCachedToken(Guid lakehouseId, Guid iterationId)
        {
            try
            {
                _inner.DeleteCachedToken(lakehouseId, iterationId);
            }
            catch (Exception ex)
            {
                PublishEvent(new
                {
                    @event = "TokenEvicted",
                    lakehouseId = lakehouseId.ToString(),
                    iterationId = iterationId.ToString(),
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }

            PublishEvent(new
            {
                @event = "TokenEvicted",
                lakehouseId = lakehouseId.ToString(),
                iterationId = iterationId.ToString(),
                success = true,
            });
        }

        /// <inheritdoc/>
        public DateTime CalculateExpiryTime(string mwcToken)
        {
            // Pure computation — pass-through, no publish needed
            return _inner.CalculateExpiryTime(mwcToken);
        }

        /// <summary>
        /// Publishes a token lifecycle event to the "token" topic. Never throws.
        /// </summary>
        private static void PublishEvent(object eventData)
        {
            try
            {
                EdogTopicRouter.Publish("token", eventData);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] TokenLifecycleInterceptor publish error: {ex.Message}");
            }
        }
    }
}
