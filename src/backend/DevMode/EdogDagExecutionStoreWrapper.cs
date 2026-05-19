// <copyright file="EdogDagExecutionStoreWrapper.cs" company="Microsoft">
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
    using Microsoft.LiveTable.Service.DataModel;
    using Microsoft.LiveTable.Service.DataModel.Dag;
    using Microsoft.LiveTable.Service.DataModel.Dag.Execution;
    using Microsoft.LiveTable.Service.Persistence.Fs;
    using Microsoft.LiveTable.Service.ReliableOperations;
    using Microsoft.LiveTable.Service.Store;

    /// <summary>
    /// Decorator that wraps <see cref="IDagExecutionStore"/> to surface real cache
    /// operations (Get/Set/Evict) to the EDOG "cache" topic via
    /// <see cref="EdogCacheInterceptor.RecordCacheEvent"/>.
    ///
    /// <para>Cache mapping:</para>
    /// <list type="bullet">
    ///   <item><c>OnDagExecutionRequestAsync</c> → Set (new execution instance entered in cache)</item>
    ///   <item><c>SaveDagForExecutionAsync</c> → Set (DAG saved into store)</item>
    ///   <item><c>GetDagExecutionInstanceAsync</c> → Get (hit/miss inferred from null result)</item>
    ///   <item><c>FinishDagExecutionInstanceAsync</c> → Evict (cache entry retired)</item>
    ///   <item><c>TryLockDagTypeForExecutionAsync</c> → Set (lock acquired / failed)</item>
    ///   <item><c>ForceUnlockDAGExecutionAsync</c> → Evict (lock released)</item>
    /// </list>
    ///
    /// <para><b>Critical:</b> Behavior is preserved verbatim. We never modify arguments,
    /// never swallow exceptions from <c>_inner</c>, and never alter lock semantics —
    /// <see cref="DagExecutionStore"/> uses internal <c>AsyncLock</c>/<c>SharedMemoryCache</c>
    /// invariants that the decorator must not perturb. We only time, publish, and delegate.
    /// Every event-publish is wrapped in its own try/catch so a telemetry failure can never
    /// break FLT.</para>
    /// </summary>
    internal sealed class EdogDagExecutionStoreWrapper : IDagExecutionStore
    {
        private const string CacheName = "DagExecutionStore";

        private readonly IDagExecutionStore _inner;

        public EdogDagExecutionStoreWrapper(IDagExecutionStore inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        // ── Cache-relevant methods ──────────────────────────────────────────────

        /// <inheritdoc/>
        public async Task<DagExecutionInstance> OnDagExecutionRequestAsync(
            DagExecutionContext dagExecContext,
            Guid? mlvExecutionDefinitionId = null,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.OnDagExecutionRequestAsync(
                    dagExecContext, mlvExecutionDefinitionId, cancellationToken)
                    .ConfigureAwait(false);
                sw.Stop();
                SafeRecord("Set", BuildIterationKey(dagExecContext), null, sw.Elapsed.TotalMilliseconds);
                return result;
            }
            catch
            {
                sw.Stop();
                SafeRecord("Set", BuildIterationKey(dagExecContext), null, sw.Elapsed.TotalMilliseconds, evictionReason: "Failed");
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task SaveDagForExecutionAsync(
            DagExecutionContext dagExecContext,
            Dag dag,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                await _inner.SaveDagForExecutionAsync(dagExecContext, dag, cancellationToken)
                    .ConfigureAwait(false);
                sw.Stop();
                SafeRecord("Set", BuildIterationKey(dagExecContext), null, sw.Elapsed.TotalMilliseconds);
            }
            catch
            {
                sw.Stop();
                SafeRecord("Set", BuildIterationKey(dagExecContext), null, sw.Elapsed.TotalMilliseconds, evictionReason: "Failed");
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<bool> TryLockDagTypeForExecutionAsync(
            DagExecutionContext dagExecContext,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            bool acquired = false;
            try
            {
                acquired = await _inner.TryLockDagTypeForExecutionAsync(dagExecContext, cancellationToken)
                    .ConfigureAwait(false);
                sw.Stop();
                SafeRecord(
                    "Set",
                    BuildDagNameKey(dagExecContext),
                    null,
                    sw.Elapsed.TotalMilliseconds,
                    evictionReason: acquired ? null : "LockNotAcquired");
                return acquired;
            }
            catch
            {
                sw.Stop();
                SafeRecord("Set", BuildDagNameKey(dagExecContext), null, sw.Elapsed.TotalMilliseconds, evictionReason: "Failed");
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<DagExecutionInstance> GetDagExecutionInstanceAsync(
            DagExecutionContext dagExecContext,
            bool checkOnlyInCache = false,
            bool addToCacheIfMissing = false,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.GetDagExecutionInstanceAsync(
                    dagExecContext, checkOnlyInCache, addToCacheIfMissing, cancellationToken)
                    .ConfigureAwait(false);
                sw.Stop();

                // Hit/miss inference:
                //   checkOnlyInCache=true  → pure cache probe; null == miss, non-null == hit.
                //   checkOnlyInCache=false → may have fallen through to persistence; we still
                //                            report the outer outcome (null == miss overall).
                string hitOrMiss = result != null ? "Hit" : "Miss";
                SafeRecord("Get", BuildIterationKey(dagExecContext), hitOrMiss, sw.Elapsed.TotalMilliseconds);
                return result;
            }
            catch
            {
                sw.Stop();
                SafeRecord("Get", BuildIterationKey(dagExecContext), "Miss", sw.Elapsed.TotalMilliseconds, evictionReason: "Failed");
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task FinishDagExecutionInstanceAsync(
            DagExecutionContext dagExecContext,
            DagExecutionInstance dagExecInstance,
            CancellationToken cancellationtoken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                await _inner.FinishDagExecutionInstanceAsync(dagExecContext, dagExecInstance, cancellationtoken)
                    .ConfigureAwait(false);
                sw.Stop();
                SafeRecord("Evict", BuildIterationKey(dagExecContext), null, sw.Elapsed.TotalMilliseconds, evictionReason: "ExecutionFinished");
            }
            catch
            {
                sw.Stop();
                SafeRecord("Evict", BuildIterationKey(dagExecContext), null, sw.Elapsed.TotalMilliseconds, evictionReason: "Failed");
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task ForceUnlockDAGExecutionAsync(
            Guid workspaceId,
            Guid lakehouseId,
            string dagName,
            Guid lockedIterationId,
            string tenantId,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                await _inner.ForceUnlockDAGExecutionAsync(
                    workspaceId, lakehouseId, dagName, lockedIterationId, tenantId, cancellationToken)
                    .ConfigureAwait(false);
                sw.Stop();
                SafeRecord(
                    "Evict",
                    $"{workspaceId}:{lakehouseId}:{dagName ?? string.Empty}",
                    null,
                    sw.Elapsed.TotalMilliseconds,
                    evictionReason: "LockReleased");
            }
            catch
            {
                sw.Stop();
                SafeRecord(
                    "Evict",
                    $"{workspaceId}:{lakehouseId}:{dagName ?? string.Empty}",
                    null,
                    sw.Elapsed.TotalMilliseconds,
                    evictionReason: "Failed");
                throw;
            }
        }

        // ── Delegate-only methods (persistence reads / file-system helpers) ─────

        /// <inheritdoc/>
        public Task<(List<DagExecutionIteration> Items, string ContinuationToken)> GetDagExecutionIterationsAsync(
            ListDagExecutionIterationsRequestFilters listDagExecutionIterationsRequestFilters,
            CancellationToken cancellationToken = default)
            => _inner.GetDagExecutionIterationsAsync(listDagExecutionIterationsRequestFilters, cancellationToken);

        /// <inheritdoc/>
        public Task<Guid?> GetLockedIterationIdAsync(
            Guid workspaceId,
            Guid lakehouseId,
            string dagName,
            string tenantId,
            CancellationToken cancellationToken = default)
            => _inner.GetLockedIterationIdAsync(workspaceId, lakehouseId, dagName, tenantId, cancellationToken);

        /// <inheritdoc/>
        public Task<List<Guid>> GetAllLockedIterationIdsAsync(
            Guid workspaceId,
            Guid lakehouseId,
            string tenantId,
            CancellationToken cancellationToken = default)
            => _inner.GetAllLockedIterationIdsAsync(workspaceId, lakehouseId, tenantId, cancellationToken);

        /// <inheritdoc/>
        public Task CopyDagExecutionMetricsAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            Guid iterationId,
            string targetUserPath,
            string mwcToken,
            CancellationToken cancellationToken = default)
            => _inner.CopyDagExecutionMetricsAsync(
                tenantId, workspaceId, lakehouseId, iterationId, targetUserPath, mwcToken, cancellationToken);

        /// <inheritdoc/>
        public Task<bool> ForceUpdateDagExecutionStatusAsync(
            Guid workspaceId,
            Guid lakehouseId,
            string dagName,
            Guid iterationId,
            string tenantId,
            DagExecutionStatus targetStatus,
            CancellationToken cancellationToken = default)
            => _inner.ForceUpdateDagExecutionStatusAsync(
                workspaceId, lakehouseId, dagName, iterationId, tenantId, targetStatus, cancellationToken);

        /// <inheritdoc/>
        public Task<DagExecutionContext> RegenerateDagExecutionContextAsync(
            ReliableOperationMetadata metadata,
            CancellationToken cancellationToken = default)
            => _inner.RegenerateDagExecutionContextAsync(metadata, cancellationToken);

        /// <inheritdoc/>
        public Task<List<Guid>> GetIndexFolderDefinitionIdsAsync(
            Guid workspaceId,
            Guid lakehouseId,
            string tenantId,
            IReadOnlyList<Guid> candidateDefinitionIds = null,
            CancellationToken cancellationToken = default)
            => _inner.GetIndexFolderDefinitionIdsAsync(
                workspaceId, lakehouseId, tenantId, candidateDefinitionIds, cancellationToken);

        /// <inheritdoc/>
        public Task<bool> DeleteIndexFolderAsync(
            Guid workspaceId,
            Guid lakehouseId,
            string tenantId,
            Guid mlvDefinitionId,
            IFileSystem fs = null,
            CancellationToken cancellationToken = default)
            => _inner.DeleteIndexFolderAsync(
                workspaceId, lakehouseId, tenantId, mlvDefinitionId, fs, cancellationToken);

        /// <inheritdoc/>
        public IFileSystem CreateDagExecFileSystem(
            Guid workspaceId,
            Guid lakehouseId,
            string tenantId,
            CancellationToken cancellationToken = default)
            => _inner.CreateDagExecFileSystem(workspaceId, lakehouseId, tenantId, cancellationToken);

        // ── Helpers ─────────────────────────────────────────────────────────────

        private static string BuildIterationKey(DagExecutionContext ctx)
        {
            if (ctx == null) return "unknown";
            try
            {
                return $"{ctx.WorkspaceId}:{ctx.LakehouseId}:{ctx.IterationId}";
            }
            catch
            {
                return "unknown";
            }
        }

        private static string BuildDagNameKey(DagExecutionContext ctx)
        {
            if (ctx == null) return "unknown";
            try
            {
                return $"{ctx.WorkspaceId}:{ctx.LakehouseId}:{ctx.DagName ?? string.Empty}";
            }
            catch
            {
                return "unknown";
            }
        }

        private static void SafeRecord(
            string operation,
            string key,
            string hitOrMiss,
            double durationMs,
            string evictionReason = null)
        {
            try
            {
                EdogCacheInterceptor.RecordCacheEvent(
                    CacheName,
                    operation,
                    key,
                    hitOrMiss: hitOrMiss,
                    durationMs: durationMs,
                    evictionReason: evictionReason);
            }
            catch
            {
                // Telemetry must never break FLT.
            }
        }
    }
}
