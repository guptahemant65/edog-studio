// <copyright file="EdogFltOpsInterceptor.cs" company="Microsoft">
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
    using Microsoft.LiveTable.Service.Contracts.Api;
    using Microsoft.LiveTable.Service.Contracts.RefreshTrigger;
    using Microsoft.LiveTable.Service.Core.RefreshTrigger;
    using Microsoft.LiveTable.Service.DataModel;
    using Microsoft.LiveTable.Service.DataQuality.Model;
    using Microsoft.LiveTable.Service.DataQuality.StateManagement;
    using Microsoft.LiveTable.Service.Maintenance.MaintenanceHttp;
    using Microsoft.LiveTable.Service.Persistence;
    using Microsoft.LiveTable.Service.Persistence.Fs;

    // ──────────────────────────────────────────────────────────────
    //  Shared publish helper for all FLT Operations wrappers
    // ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Shared event publisher for all FLT Operations interceptors. Never throws.
    /// </summary>
    internal static class FltOpsEventHelper
    {
        internal static void PublishEvent(object eventData)
        {
            try
            {
                EdogTopicRouter.Publish("flt-ops", eventData);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] FltOpsInterceptor publish error: {ex.Message}");
            }
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  1. EdogRefreshTriggersWrapper
    // ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Decorator that wraps <see cref="IRefreshTriggersHandler"/> to intercept refresh trigger operations.
    /// Publishes events to the "flt-ops" topic via <see cref="EdogTopicRouter"/>.
    /// </summary>
    internal class EdogRefreshTriggersWrapper : IRefreshTriggersHandler
    {
        private readonly IRefreshTriggersHandler _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogRefreshTriggersWrapper"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="IRefreshTriggersHandler"/> to delegate to.</param>
        public EdogRefreshTriggersWrapper(IRefreshTriggersHandler inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public async Task<RefreshTriggerResponse> CreateOrUpdateFMLVRefreshActivatorAsync(
            Guid tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            RefreshTriggerRequest refreshTriggerReq,
            string mwcToken,
            CancellationToken cancellationToken)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.CreateOrUpdateFMLVRefreshActivatorAsync(
                    tenantId, workspaceId, lakehouseId,
                    refreshTriggerReq, mwcToken, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "RefreshTriggerUpserted",
                    operation = "RefreshTrigger",
                    action = "CreateOrUpdate",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    triggerId = result?.Id.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "RefreshTriggerFailed",
                    operation = "RefreshTrigger",
                    action = "CreateOrUpdate",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<List<RefreshTriggerResponse>> ListFMLVRefreshTriggersAsync(
            Guid tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            string mwcToken,
            CancellationToken cancellationToken)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.ListFMLVRefreshTriggersAsync(
                    tenantId, workspaceId, lakehouseId,
                    mwcToken, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "RefreshTriggerListed",
                    operation = "RefreshTrigger",
                    action = "List",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    count = result?.Count ?? 0,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "RefreshTriggerListFailed",
                    operation = "RefreshTrigger",
                    action = "List",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  2. EdogMLVDefinitionWrapper
    // ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Decorator that wraps <see cref="IMLVExecutionDefinitionPersistenceManager"/> to intercept MLV definition CRUD.
    /// Publishes events to the "flt-ops" topic via <see cref="EdogTopicRouter"/>.
    /// </summary>
    internal class EdogMLVDefinitionWrapper : IMLVExecutionDefinitionPersistenceManager
    {
        private readonly IMLVExecutionDefinitionPersistenceManager _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogMLVDefinitionWrapper"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="IMLVExecutionDefinitionPersistenceManager"/> to delegate to.</param>
        public EdogMLVDefinitionWrapper(IMLVExecutionDefinitionPersistenceManager inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public async Task<MLVExecutionDefinition> CreateAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            Guid id,
            MLVExecutionDefinitionRequest request,
            DateTime createdAt,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.CreateAsync(
                    tenantId, workspaceId, lakehouseId, id,
                    request, createdAt, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionCreated",
                    operation = "MLVDefinition",
                    action = "Create",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionCreateFailed",
                    operation = "MLVDefinition",
                    action = "Create",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<MLVExecutionDefinition> GetAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            Guid id,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.GetAsync(
                    tenantId, workspaceId, lakehouseId, id, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionRetrieved",
                    operation = "MLVDefinition",
                    action = "Get",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    found = result != null,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionGetFailed",
                    operation = "MLVDefinition",
                    action = "Get",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<MLVExecutionDefinition> UpdateAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            Guid id,
            MLVExecutionDefinitionRequest request,
            DateTime updatedAt,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.UpdateAsync(
                    tenantId, workspaceId, lakehouseId, id,
                    request, updatedAt, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionUpdated",
                    operation = "MLVDefinition",
                    action = "Update",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionUpdateFailed",
                    operation = "MLVDefinition",
                    action = "Update",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<bool> DeleteAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            Guid id,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var deleted = await _inner.DeleteAsync(
                    tenantId, workspaceId, lakehouseId, id, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionDeleted",
                    operation = "MLVDefinition",
                    action = "Delete",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    deleted,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return deleted;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionDeleteFailed",
                    operation = "MLVDefinition",
                    action = "Delete",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<List<MLVExecutionDefinition>> ListAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.ListAsync(
                    tenantId, workspaceId, lakehouseId, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionListed",
                    operation = "MLVDefinition",
                    action = "List",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    count = result?.Count ?? 0,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionListFailed",
                    operation = "MLVDefinition",
                    action = "List",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<MLVExecutionDefinition> GetRecoveryAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            Guid id,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.GetRecoveryAsync(
                    tenantId, workspaceId, lakehouseId, id, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionRecoveryRetrieved",
                    operation = "MLVDefinition",
                    action = "GetRecovery",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    found = result != null,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionRecoveryGetFailed",
                    operation = "MLVDefinition",
                    action = "GetRecovery",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<List<Guid>> ListRecoveryFileIdsAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.ListRecoveryFileIdsAsync(
                    tenantId, workspaceId, lakehouseId, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionRecoveryIdsListed",
                    operation = "MLVDefinition",
                    action = "ListRecoveryFileIds",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    count = result?.Count ?? 0,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionRecoveryIdsListFailed",
                    operation = "MLVDefinition",
                    action = "ListRecoveryFileIds",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<bool> DeleteRecoveryAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            Guid id,
            IFileSystem fs = null,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var deleted = await _inner.DeleteRecoveryAsync(
                    tenantId, workspaceId, lakehouseId, id, fs, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionRecoveryDeleted",
                    operation = "MLVDefinition",
                    action = "DeleteRecovery",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    deleted,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return deleted;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionRecoveryDeleteFailed",
                    operation = "MLVDefinition",
                    action = "DeleteRecovery",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    definitionId = id.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<IFileSystem> CreateMLVDefFileSystemAsync(
            string tenantId,
            Guid workspaceId,
            Guid lakehouseId,
            CancellationToken cancellationToken = default)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.CreateMLVDefFileSystemAsync(
                    tenantId, workspaceId, lakehouseId, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionFileSystemCreated",
                    operation = "MLVDefinition",
                    action = "CreateFileSystem",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MLVDefinitionFileSystemCreateFailed",
                    operation = "MLVDefinition",
                    action = "CreateFileSystem",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  3. EdogReportStateWrapper
    // ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Decorator that wraps <see cref="IReportStateManager"/> to intercept data quality report state operations.
    /// Publishes events to the "flt-ops" topic via <see cref="EdogTopicRouter"/>.
    /// </summary>
    internal class EdogReportStateWrapper : IReportStateManager
    {
        private readonly IReportStateManager _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogReportStateWrapper"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="IReportStateManager"/> to delegate to.</param>
        public EdogReportStateWrapper(IReportStateManager inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public async Task<bool> InitializeStateAsync(RequestContext context)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.InitializeStateAsync(context).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "DqReportInitialized",
                    operation = "DataQuality",
                    action = "InitializeState",
                    workspaceId = context?.WorkspaceId.ToString(),
                    lakehouseId = context?.LakehouseId?.ToString(),
                    initialized = result,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "DqReportInitialized",
                    operation = "DataQuality",
                    action = "InitializeState",
                    workspaceId = context?.WorkspaceId.ToString(),
                    lakehouseId = context?.LakehouseId?.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<bool> UpdateStateAsync(RequestContext context, ReportOperationState state)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.UpdateStateAsync(context, state).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "DqReportStateUpdated",
                    operation = "DataQuality",
                    action = "UpdateState",
                    workspaceId = context?.WorkspaceId.ToString(),
                    lakehouseId = context?.LakehouseId?.ToString(),
                    stateStatus = state?.Status.ToString(),
                    internalStatus = state?.InternalStatus.ToString(),
                    updated = result,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "DqReportStateUpdated",
                    operation = "DataQuality",
                    action = "UpdateState",
                    workspaceId = context?.WorkspaceId.ToString(),
                    lakehouseId = context?.LakehouseId?.ToString(),
                    stateStatus = state?.Status.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<(bool Success, ReportOperationState State)> TryGetStateAsync(RequestContext context)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.TryGetStateAsync(context).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "DqReportStateQueried",
                    operation = "DataQuality",
                    action = "TryGetState",
                    workspaceId = context?.WorkspaceId.ToString(),
                    lakehouseId = context?.LakehouseId?.ToString(),
                    found = result.Success,
                    stateStatus = result.Success ? result.State?.Status.ToString() : null,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "DqReportStateQueried",
                    operation = "DataQuality",
                    action = "TryGetState",
                    workspaceId = context?.WorkspaceId.ToString(),
                    lakehouseId = context?.LakehouseId?.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }

        /// <inheritdoc/>
        public async Task<bool> CloseAsync(RequestContext context)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var result = await _inner.CloseAsync(context).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "DqReportClosed",
                    operation = "DataQuality",
                    action = "Close",
                    workspaceId = context?.WorkspaceId.ToString(),
                    lakehouseId = context?.LakehouseId?.ToString(),
                    closed = result,
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return result;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "DqReportClosed",
                    operation = "DataQuality",
                    action = "Close",
                    workspaceId = context?.WorkspaceId.ToString(),
                    lakehouseId = context?.LakehouseId?.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  4. EdogTableMaintenanceFactoryWrapper
    // ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Decorator that wraps <see cref="ITableMaintenanceClientFactory"/> to intercept maintenance client creation.
    /// Publishes events to the "flt-ops" topic via <see cref="EdogTopicRouter"/>.
    /// </summary>
    internal class EdogTableMaintenanceFactoryWrapper : ITableMaintenanceClientFactory
    {
        private readonly ITableMaintenanceClientFactory _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogTableMaintenanceFactoryWrapper"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="ITableMaintenanceClientFactory"/> to delegate to.</param>
        public EdogTableMaintenanceFactoryWrapper(ITableMaintenanceClientFactory inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public async Task<ITableMaintenanceClient> CreateTableMaintenanceClientAsync(
            string mwcToken,
            Guid workspaceId,
            Guid lakehouseId,
            CancellationToken cancellationToken)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var client = await _inner.CreateTableMaintenanceClientAsync(
                    mwcToken, workspaceId, lakehouseId, cancellationToken).ConfigureAwait(false);
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MaintenanceClientCreated",
                    operation = "TableMaintenance",
                    action = "CreateClient",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = true,
                });

                return client;
            }
            catch (Exception ex)
            {
                sw.Stop();

                FltOpsEventHelper.PublishEvent(new
                {
                    @event = "MaintenanceClientFailed",
                    operation = "TableMaintenance",
                    action = "CreateClient",
                    workspaceId = workspaceId.ToString(),
                    lakehouseId = lakehouseId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    success = false,
                    errorType = ex.GetType().Name,
                });

                throw;
            }
        }
    }
}
