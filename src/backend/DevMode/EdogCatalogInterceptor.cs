// <copyright file="EdogCatalogInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.Catalog;
    using Microsoft.LiveTable.Service.DataModel;
    using Microsoft.LiveTable.Service.DataModel.Catalog;

    /// <summary>
    /// Decorator that wraps <see cref="ICatalogHandler"/> to intercept catalog discovery operations.
    /// Publishes start/complete/fail events to the "catalog" topic via <see cref="EdogTopicRouter"/>.
    /// Captures entity counts (MVs, tables, shortcuts, faulted) without exposing sensitive data.
    /// Thread-safe. Zero overhead on caller — publish failures never propagate to FLT.
    /// </summary>
    internal class EdogCatalogInterceptor : ICatalogHandler
    {
        private readonly ICatalogHandler _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogCatalogInterceptor"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="ICatalogHandler"/> to delegate to.</param>
        public EdogCatalogInterceptor(ICatalogHandler inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public async Task<List<Table>> GetCatalogObjectsAsync(
            Guid tenantId,
            Guid workspaceId,
            Guid artifactId,
            string workspaceName,
            string artifactName,
            string mwcToken,
            CancellationToken ct = default,
            MLVExecutionDefinition mlvExecDefinition = null,
            bool showExtendedLineage = false)
        {
            var sw = Stopwatch.StartNew();

            PublishEvent(new
            {
                @event = "CatalogDiscoveryStarted",
                workspaceId = workspaceId.ToString(),
                artifactId = artifactId.ToString(),
                artifactName,
                hasMLVFilter = mlvExecDefinition != null,
                extendedLineage = showExtendedLineage,
            });

            try
            {
                var tables = await _inner.GetCatalogObjectsAsync(
                    tenantId, workspaceId, artifactId,
                    workspaceName, artifactName, mwcToken,
                    ct, mlvExecDefinition, showExtendedLineage).ConfigureAwait(false);

                sw.Stop();

                // Count entity types from results
                int mvCount = 0, tableCount = 0, shortcutCount = 0, faultedCount = 0;
                if (tables != null)
                {
                    foreach (var t in tables)
                    {
                        // IsFaulted is stored in Properties dictionary, not a direct property
                        bool isFaulted = t.Properties?.ContainsKey("IsFaulted") == true
                            && string.Equals(t.Properties["IsFaulted"], "true", StringComparison.OrdinalIgnoreCase);

                        if (isFaulted)
                        {
                            faultedCount++;
                        }
                        else if (t.IsShortcut == true)
                        {
                            shortcutCount++;
                        }
                        else if (t.IsMaterializedLakeView())
                        {
                            mvCount++;
                        }
                        else
                        {
                            tableCount++;
                        }
                    }
                }

                PublishEvent(new
                {
                    @event = "CatalogDiscoveryCompleted",
                    workspaceId = workspaceId.ToString(),
                    artifactId = artifactId.ToString(),
                    artifactName,
                    durationMs = sw.ElapsedMilliseconds,
                    totalEntities = tables?.Count ?? 0,
                    mvCount,
                    tableCount,
                    shortcutCount,
                    faultedCount,
                    hasMLVFilter = mlvExecDefinition != null,
                    extendedLineage = showExtendedLineage,
                });

                return tables;
            }
            catch (Exception ex)
            {
                sw.Stop();

                var errorMsg = ex.Message;
                if (errorMsg != null && errorMsg.Length > 500)
                {
                    errorMsg = errorMsg.Substring(0, 500);
                }

                PublishEvent(new
                {
                    @event = "CatalogDiscoveryFailed",
                    workspaceId = workspaceId.ToString(),
                    artifactId = artifactId.ToString(),
                    artifactName,
                    durationMs = sw.ElapsedMilliseconds,
                    errorType = ex.GetType().Name,
                    errorMessage = errorMsg,
                });

                throw;
            }
        }

        /// <summary>
        /// Publishes a catalog event to the "catalog" topic. Never throws.
        /// </summary>
        private static void PublishEvent(object eventData)
        {
            try
            {
                EdogTopicRouter.Publish("catalog", eventData);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] CatalogInterceptor publish error: {ex.Message}");
            }
        }
    }
}
