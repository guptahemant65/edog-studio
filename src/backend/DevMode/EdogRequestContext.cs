// <copyright file="EdogRequestContext.cs" company="Microsoft">
// Copyright (c) Microsoft. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Threading;
    using Microsoft.LiveTable.Service.DataModel.Dag.Execution;
    using Microsoft.LiveTable.Service.ReliableOperations;

    /// <summary>
    /// AsyncLocal context identifying the currently-executing DAG request iteration.
    ///
    /// Established by the EDOG request context patches in DagExecutionHandlerV2 in two
    /// stages because the dag-derived fields (WorkspaceId, ArtifactId, MlvName) are not
    /// available at <c>ExecuteAsync</c> entry — they're computed inside the try block
    /// after async work that may fetch an MLVExecutionDefinition:
    ///
    ///   1. <see cref="Begin"/> runs at the top of <c>ExecuteAsync</c> with what's
    ///      knowable from the <see cref="ReliableOperationMetadata"/> alone:
    ///      <see cref="IterationId"/>, <see cref="TenantId"/>, <see cref="StartedAt"/>.
    ///
    ///   2. <see cref="Enrich"/> runs after <c>dagExecutionContext</c> is computed and
    ///      populates <see cref="WorkspaceId"/>, <see cref="ArtifactId"/>,
    ///      <see cref="MlvName"/>. Idempotent — safe to call twice; later writes win.
    ///
    ///   3. <see cref="End"/> runs in the existing <c>finally</c> block, clears the
    ///      AsyncLocal, and (eventually) raises the request-ended signal that
    ///      <c>OnRequestEnd</c>-disarm rules will subscribe to.
    ///
    /// Read by the fault matching engine to scope rules to a request iteration —
    /// independent of, and parent to, the per-node <see cref="EdogNodeExecutionContext"/>.
    ///
    /// Each request's async call chain carries its own independent context.
    /// </summary>
    internal sealed class EdogRequestContext
    {
        private static readonly AsyncLocal<EdogRequestContext> _current = new();

        /// <summary>
        /// Gets the context for the current async execution flow.
        /// Null when no request is executing (e.g., outside <c>ExecuteAsync</c>).
        /// </summary>
        public static EdogRequestContext Current => _current.Value;

        /// <summary>Operation/iteration identifier (from <c>metadata.OpId</c>).</summary>
        public Guid IterationId { get; private set; }

        /// <summary>Tenant identifier (from <c>metadata.TenantId</c>).</summary>
        public Guid TenantId { get; private set; }

        /// <summary>UTC timestamp the request started.</summary>
        public DateTime StartedAt { get; private set; }

        /// <summary>Workspace identifier — null until <see cref="Enrich"/> runs.</summary>
        public Guid? WorkspaceId { get; private set; }

        /// <summary>Artifact (Lakehouse) identifier — null until <see cref="Enrich"/> runs.</summary>
        public Guid? ArtifactId { get; private set; }

        /// <summary>DAG/MLV name — null until <see cref="Enrich"/> runs.</summary>
        public string MlvName { get; private set; }

        /// <summary>True after <see cref="Enrich"/> has run on this context.</summary>
        public bool EnrichmentApplied => this.WorkspaceId.HasValue;

        /// <summary>
        /// Establishes a new request context for this async flow.
        /// Called from <c>DagExecutionHandlerV2.ExecuteAsync</c> entry, before any
        /// async work. Sets only the fields knowable from metadata; dag-derived
        /// fields stay null until <see cref="Enrich"/> runs.
        /// </summary>
        /// <param name="metadata">The reliable operation metadata.</param>
        /// <param name="iterationId">The iteration identifier (typically <c>metadata.OpId</c>).</param>
        public static void Begin(ReliableOperationMetadata metadata, Guid iterationId)
        {
            try
            {
                _current.Value = new EdogRequestContext
                {
                    IterationId = iterationId,
                    TenantId = metadata?.TenantId ?? default,
                    StartedAt = DateTime.UtcNow,
                };
            }
            catch
            {
                // Non-fatal — never block DAG execution from context setup.
            }
        }

        /// <summary>
        /// Enriches the current context with dag-derived fields once
        /// <c>dagExecutionContext</c> is available. Idempotent — re-enriching
        /// with a different context simply overwrites. No-op if
        /// <see cref="Current"/> is null (Begin was not called).
        /// </summary>
        /// <param name="dagExecutionContext">The resolved DAG execution context.</param>
        public static void Enrich(DagExecutionContext dagExecutionContext)
        {
            try
            {
                var ctx = _current.Value;
                if (ctx == null || dagExecutionContext == null)
                {
                    return;
                }

                ctx.WorkspaceId = dagExecutionContext.WorkspaceId;
                ctx.ArtifactId = dagExecutionContext.LakehouseId;
                ctx.MlvName = dagExecutionContext.DagName;
            }
            catch
            {
                // Non-fatal.
            }
        }

        /// <summary>
        /// Ends the request context for this async flow. Called from the
        /// existing <c>finally</c> block of <c>DagExecutionHandlerV2.ExecuteAsync</c>.
        /// Clears the AsyncLocal so subsequent unrelated flows on this thread
        /// don't accidentally inherit the context.
        /// </summary>
        public static void End()
        {
            try
            {
                _current.Value = null;
            }
            catch
            {
                // Non-fatal.
            }
        }
    }
}
