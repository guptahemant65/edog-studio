// <copyright file="EdogFaultedNodeException.cs" company="Microsoft">
// Copyright (c) Microsoft. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using Microsoft.LiveTable.Service.DataModel.GTS;
    using Microsoft.LiveTable.Service.ErrorMapping;

    /// <summary>
    /// Typed exception thrown by the EDOG-patched faulted-node block in
    /// <c>DagExecutionHandlerV2</c> in place of the original untyped
    /// <c>System.Exception</c>.
    ///
    /// The original (un-patched) FLT code at <c>DagExecutionHandlerV2.cs:351</c> throws a
    /// bare <c>new Exception(errorMessage)</c> after pre-setting
    /// <c>resultCode = MLV_DAG_HAS_FAULTED_NODES</c>. The outer catch then short-circuits
    /// <c>MapExceptionToErrorInfo</c> via its
    /// <c>if (string.IsNullOrEmpty(resultCode))</c> guard. Net effect: every
    /// faulted-node failure surfaces as <c>MLV_DAG_HAS_FAULTED_NODES</c> with
    /// <c>exceptionType=System.Exception</c>, regardless of which per-node error
    /// actually triggered it.
    ///
    /// The EDOG patches:
    ///   1. Replace the untyped throw with <c>throw new EdogFaultedNodeException(...)</c>
    ///      carrying the first faulted node's <see cref="ErrorCode"/>.
    ///   2. Extend the outer-catch guard so it ALSO runs the mapper when the
    ///      exception is an <see cref="EdogFaultedNodeException"/> — the legacy
    ///      pre-set paths (SETTINGS_FORMAT_ERROR, SETTINGS_RETRIEVAL_ERROR, etc.)
    ///      continue to short-circuit as before.
    ///   3. Add a branch to <c>MapExceptionToErrorInfo</c> that recognizes this
    ///      exception and returns its carried code/message/status verbatim.
    ///
    /// Net effect: faulted-node failures route through the mapper and surface
    /// their originating per-node code instead of being collapsed to the generic
    /// <c>MLV_DAG_HAS_FAULTED_NODES</c>.
    /// </summary>
    internal sealed class EdogFaultedNodeException : Exception
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="EdogFaultedNodeException"/> class.
        /// </summary>
        /// <param name="message">The composed user-facing error message.</param>
        /// <param name="statusCode">The HTTP status code to surface (4xx user, 5xx system).</param>
        /// <param name="errorCode">The originating per-node FLT error code.</param>
        /// <param name="errorSource">The error source (User vs System).</param>
        /// <param name="innerException">Optional inner exception (typically null for the faulted-node aggregation case).</param>
        public EdogFaultedNodeException(
            string message,
            int statusCode,
            ErrorCode errorCode,
            ErrorSource errorSource,
            Exception innerException = null)
            : base(message, innerException)
        {
            this.StatusCode = statusCode;
            this.ErrorCode = errorCode;
            this.ErrorSource = errorSource;
        }

        /// <summary>Gets the HTTP status code to surface.</summary>
        public int StatusCode { get; }

        /// <summary>Gets the originating per-node FLT error code.</summary>
        public ErrorCode ErrorCode { get; }

        /// <summary>Gets the error source classification.</summary>
        public ErrorSource ErrorSource { get; }
    }
}
