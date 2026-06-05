// <copyright file="EdogNodeExecutionContext.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Threading;

    /// <summary>
    /// AsyncLocal context identifying the currently-executing DAG node.
    /// Set by the EDOG node execution wrapper patch in DagExecutionHandlerV2
    /// (inside the per-node Task.Run), read by EdogHttpPipelineHandler to
    /// scope fault injection rules to the correct node during parallel execution.
    /// Each parallel node's async call chain carries its own independent context.
    /// </summary>
    internal sealed class EdogNodeExecutionContext
    {
        private static readonly AsyncLocal<EdogNodeExecutionContext> _current = new();

        /// <summary>
        /// Gets or sets the context for the current async execution flow.
        /// Null when no node is executing (e.g., during DAG construction).
        /// </summary>
        public static EdogNodeExecutionContext Current
        {
            get => _current.Value;
            set => _current.Value = value;
        }

        /// <summary>Node identifier (typically the node name in FLT's DAG model).</summary>
        public string NodeId { get; init; }

        /// <summary>Human-readable node name.</summary>
        public string NodeName { get; init; }

        /// <summary>DAG name/identifier this node belongs to.</summary>
        public string DagId { get; init; }

        /// <summary>Execution iteration identifier.</summary>
        public Guid IterationId { get; init; }
    }
}
