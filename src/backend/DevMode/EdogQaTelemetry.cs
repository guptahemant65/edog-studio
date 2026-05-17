// <copyright file="EdogQaTelemetry.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Threading;

    /// <summary>
    /// In-process telemetry counters for the QA Testing feature (F27).
    ///
    /// Tracks every fallback path, stub invocation, LLM call, and pipeline completion
    /// so that the studio UI, integration tests, and operators can detect when the
    /// engine is silently degrading. All counters are thread-safe via
    /// <see cref="Interlocked"/>; readers receive a coherent immutable snapshot
    /// via <see cref="Snapshot"/>.
    ///
    /// This class is the observability foundation for F27 P0. It does NOT
    /// emit SignalR events itself — the hub reads the snapshot and surfaces
    /// fallbacks via existing <c>QaAnalysisWarning</c> events plus the new
    /// <c>QaGetTelemetry</c> hub method.
    /// </summary>
    internal static class EdogQaTelemetry
    {
        private static long _syntheticScenariosFallbackCount;
        private static long _stubLlmProviderCallCount;
        private static long _stubOmniSharpProviderCallCount;
        private static long _stubGraphProviderCallCount;
        private static long _graphStubConnectivityEdgeCount;
        private static long _chaosNoOpCount;
        private static long _flagOverrideNoOpCount;
        private static long _llmCallCount;
        private static long _llmErrorCount;
        private static long _analysisStartedCount;
        private static long _analysisCompletedCount;
        private static long _runStartedCount;
        private static long _runCompletedCount;

        private static readonly DateTimeOffset _startedAt = DateTimeOffset.UtcNow;

        // ── Increment helpers (thread-safe) ────────────────────────────

        public static void IncrementSyntheticScenariosFallback() => Interlocked.Increment(ref _syntheticScenariosFallbackCount);

        public static void IncrementStubLlmProviderCall() => Interlocked.Increment(ref _stubLlmProviderCallCount);

        public static void IncrementStubOmniSharpProviderCall() => Interlocked.Increment(ref _stubOmniSharpProviderCallCount);

        public static void IncrementStubGraphProviderCall() => Interlocked.Increment(ref _stubGraphProviderCallCount);

        public static void IncrementGraphStubConnectivityEdge() => Interlocked.Increment(ref _graphStubConnectivityEdgeCount);

        public static void IncrementChaosNoOp() => Interlocked.Increment(ref _chaosNoOpCount);

        public static void IncrementFlagOverrideNoOp() => Interlocked.Increment(ref _flagOverrideNoOpCount);

        public static void IncrementLlmCall() => Interlocked.Increment(ref _llmCallCount);

        public static void IncrementLlmError() => Interlocked.Increment(ref _llmErrorCount);

        public static void IncrementAnalysisStarted() => Interlocked.Increment(ref _analysisStartedCount);

        public static void IncrementAnalysisCompleted() => Interlocked.Increment(ref _analysisCompletedCount);

        public static void IncrementRunStarted() => Interlocked.Increment(ref _runStartedCount);

        public static void IncrementRunCompleted() => Interlocked.Increment(ref _runCompletedCount);

        // ── Snapshot ───────────────────────────────────────────────────

        /// <summary>
        /// Capture an immutable snapshot of the current telemetry counters.
        /// Safe to call from any thread.
        /// </summary>
        public static QaTelemetrySnapshot Snapshot()
        {
            return new QaTelemetrySnapshot
            {
                StartedAt = _startedAt,
                CapturedAt = DateTimeOffset.UtcNow,
                SyntheticScenariosFallbackCount = Interlocked.Read(ref _syntheticScenariosFallbackCount),
                StubLlmProviderCallCount = Interlocked.Read(ref _stubLlmProviderCallCount),
                StubOmniSharpProviderCallCount = Interlocked.Read(ref _stubOmniSharpProviderCallCount),
                StubGraphProviderCallCount = Interlocked.Read(ref _stubGraphProviderCallCount),
                GraphStubConnectivityEdgeCount = Interlocked.Read(ref _graphStubConnectivityEdgeCount),
                ChaosNoOpCount = Interlocked.Read(ref _chaosNoOpCount),
                FlagOverrideNoOpCount = Interlocked.Read(ref _flagOverrideNoOpCount),
                LlmCallCount = Interlocked.Read(ref _llmCallCount),
                LlmErrorCount = Interlocked.Read(ref _llmErrorCount),
                AnalysisStartedCount = Interlocked.Read(ref _analysisStartedCount),
                AnalysisCompletedCount = Interlocked.Read(ref _analysisCompletedCount),
                RunStartedCount = Interlocked.Read(ref _runStartedCount),
                RunCompletedCount = Interlocked.Read(ref _runCompletedCount),
            };
        }

        /// <summary>
        /// Reset every counter to zero. Test-only — not exposed via SignalR.
        /// </summary>
        public static void ResetForTesting()
        {
            Interlocked.Exchange(ref _syntheticScenariosFallbackCount, 0);
            Interlocked.Exchange(ref _stubLlmProviderCallCount, 0);
            Interlocked.Exchange(ref _stubOmniSharpProviderCallCount, 0);
            Interlocked.Exchange(ref _stubGraphProviderCallCount, 0);
            Interlocked.Exchange(ref _graphStubConnectivityEdgeCount, 0);
            Interlocked.Exchange(ref _chaosNoOpCount, 0);
            Interlocked.Exchange(ref _flagOverrideNoOpCount, 0);
            Interlocked.Exchange(ref _llmCallCount, 0);
            Interlocked.Exchange(ref _llmErrorCount, 0);
            Interlocked.Exchange(ref _analysisStartedCount, 0);
            Interlocked.Exchange(ref _analysisCompletedCount, 0);
            Interlocked.Exchange(ref _runStartedCount, 0);
            Interlocked.Exchange(ref _runCompletedCount, 0);
        }
    }
}
