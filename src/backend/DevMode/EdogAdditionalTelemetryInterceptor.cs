// <copyright file="EdogAdditionalTelemetryInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using Microsoft.LiveTable.Service.Telemetry;
    using Microsoft.ServicePlatform.Exceptions.Core;
    using Microsoft.ServicePlatform.Telemetry;

    /// <summary>
    /// Decorator that intercepts ILiveTableAdditionalTelemetryReporter calls
    /// and forwards them to EdogLogServer as TelemetryEvent records tagged
    /// with Channel="additional".
    ///
    /// Why this exists: FLT has TWO telemetry channels and Studio was only
    /// capturing one. The SSR channel (ICustomLiveTableTelemetryReporter) is
    /// the standardized server-reporting path — controller-attribute events,
    /// RunDag-level activities. The Additional channel
    /// (ILiveTableAdditionalTelemetryReporter) is explicitly for "details
    /// that can not go into SSR" — per-node NodeExecution events,
    /// DagExecutionHandlerV2 feature-usage, all controller feature-usage.
    /// Without this interceptor those events landed only as Tracer log lines,
    /// losing their semantic ("this is a structured telemetry event with
    /// these key-value pairs") and getting buried in the log stream.
    ///
    /// Status semantics: Additional events are fire-and-forget — emitted
    /// once per occurrence, no started/completed pairing. We stamp
    /// ActivityStatus="Completed" so the Telemetry tab treats them as
    /// terminal cards (not running). If a real status is present in the
    /// details dictionary (e.g. NodeStatus="Failed"), we map it.
    ///
    /// Forwarding: every call is forwarded to the inner reporter unchanged
    /// so the original telemetry flow (LogSanitizedMessage → ASTrace /
    /// telemetry pipeline) is preserved. Studio is a sidecar, not a
    /// replacement.
    /// </summary>
    internal sealed class EdogAdditionalTelemetryInterceptor : ILiveTableAdditionalTelemetryReporter
    {
        private static readonly System.Text.RegularExpressions.Regex GuidSuffixRegex =
            new System.Text.RegularExpressions.Regex(
                @"[|\-]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
                System.Text.RegularExpressions.RegexOptions.Compiled);

        private readonly ILiveTableAdditionalTelemetryReporter inner;
        private readonly EdogLogServer edogLogServer;

        public EdogAdditionalTelemetryInterceptor(
            ILiveTableAdditionalTelemetryReporter inner, EdogLogServer server)
        {
            this.inner = inner ?? throw new ArgumentNullException(nameof(inner));
            this.edogLogServer = server ?? throw new ArgumentNullException(nameof(server));
        }

        /// <summary>
        /// Intercepts an Additional telemetry emit, forwards a TelemetryEvent
        /// (Channel="additional") to EdogLogServer, then forwards the original
        /// call to the inner reporter.
        /// </summary>
        public void EmitTelemetry(
            string eventId,
            string correlationId,
            IReadOnlyDictionary<string, string> telemetryDetails)
        {
            try
            {
                // Copy details (the inner reporter mutates its copy by adding
                // CorrelationId/TrainVersion — keep ours pristine).
                var attributes = new Dictionary<string, string>();
                if (telemetryDetails != null)
                {
                    foreach (var kvp in telemetryDetails)
                    {
                        attributes[kvp.Key] = kvp.Value;
                    }
                }

                // Match SSR enrichment: stamp CustomerTenantId / CapacityObjectId
                // / ClusterName so dashboards can filter Additional events by
                // tenant/capacity the same way they filter SSR events.
                try
                {
                    var tenantIdCtx = ExecutionContext.GetProperty("CustomerTenantId");
                    if (tenantIdCtx != null) attributes["CustomerTenantId"] = tenantIdCtx.ToString();
                    var capacityCtx = ExecutionContext.GetProperty("CustomerCapacityObjectId");
                    if (capacityCtx != null) attributes["CustomerCapacityObjectId"] = capacityCtx.ToString();
                    var clusterName = ServiceExecutionContext.ExecutionEnvironment?.ClusterName;
                    if (!string.IsNullOrEmpty(clusterName)) attributes["ClusterName"] = clusterName;
                }
                catch { /* ExecutionContext not always available */ }

                var effectiveCorrelationId = string.IsNullOrEmpty(correlationId)
                    ? MonitoredScope.RootActivityId.ToString()
                    : correlationId;

                // Status — Additional channel events are fire-and-forget
                // feature-usage emissions; the FLT API
                // (ILiveTableAdditionalTelemetryReporter.EmitTelemetry) has
                // NO status parameter. Stamping any status here would be
                // invention. We used to fish for NodeStatus / ActivityStatus
                // / Status / OperationStatus / Outcome in attributes and
                // fall back to "Completed" — that lie caused the Telemetry
                // tab to report still-running RunDag activities as
                // 'succeeded' (frontend aliased 'Completed' → 'succeeded').
                // Now: emit empty string and mark the event IsMirror=true
                // so the frontend resolves lifecycle from the paired SSR
                // event with the same correlationId.
                var status = string.Empty;

                // Duration — same rationale. Pending durationMs ~= time-
                // to-HTTP-202 on the SSR side; on the Additional side we
                // genuinely don't know how long anything took. Leave 0;
                // the frontend reads the SSR mirror's durationMs.
                long durationMs = 0;

                // ResultCode stays opportunistic — some Failed payloads
                // include a code worth preserving for the rare honest case.
                // NOTE: every Additional event IS a true mirror of an SSR
                // event sharing this correlationId + activityName (FLT
                // NodeExecutor.cs:390 EmitStandardizedServerReporting + :417
                // EmitTelemetry, same args; DagExecutionHandlerV2 likewise).
                // There is NO Additional-only activity — Studio's Telemetry
                // tab drops Additional rows at ingest and reads lifecycle from
                // the SSR twin. Preserving ResultCode here costs nothing.
                string resultCode = null;
                foreach (var key in new[] { "ResultCode", "ErrorCode", "FailureCode", "SubCode" })
                {
                    if (attributes.TryGetValue(key, out var rc) && !string.IsNullOrEmpty(rc))
                    {
                        resultCode = rc;
                        break;
                    }
                }

                var telemetryEvent = new TelemetryEvent(
                    timestamp: DateTime.UtcNow,
                    activityName: eventId ?? string.Empty,
                    activityStatus: status,
                    durationMs: durationMs,
                    resultCode: resultCode,
                    correlationId: effectiveCorrelationId,
                    attributes: attributes,
                    userId: string.Empty);

                telemetryEvent.Channel = "additional";
                telemetryEvent.EventId = eventId;
                telemetryEvent.IsMirror = true;

                // IterationId resolution — same priority as SSR:
                //   1. attributes.IterationId (call sites push this via
                //      MonitoredScope.AddCustomData for DAG/node-scoped work)
                //   2. trailing GUID on the correlationId (async format
                //      "rootActivityId|iterationId" or sync "rootActivityId-iterationId")
                if (attributes.TryGetValue("IterationId", out var iidFromAttrs)
                    && !string.IsNullOrEmpty(iidFromAttrs)
                    && iidFromAttrs != "00000000-0000-0000-0000-000000000000"
                    && Guid.TryParse(iidFromAttrs, out _))
                {
                    telemetryEvent.IterationId = iidFromAttrs;
                }
                else
                {
                    var guidMatch = GuidSuffixRegex.Match(effectiveCorrelationId);
                    if (guidMatch.Success)
                    {
                        telemetryEvent.IterationId = guidMatch.Groups[1].Value;
                    }
                }

                // Mirror SSR behavior: register the rootActivityId → iterationId
                // mapping so plain log lines that share this correlationId can
                // inherit the iteration in the Logs tab.
                if (!string.IsNullOrEmpty(telemetryEvent.IterationId))
                {
                    EdogLogInterceptor.RegisterRootActivityMapping(
                        effectiveCorrelationId, telemetryEvent.IterationId);
                }

                this.edogLogServer.AddTelemetry(telemetryEvent);

                WriteColoredConsoleOutput(eventId);
            }
            catch
            {
                // Never throw from interception — original flow continues.
            }

            try
            {
                this.inner.EmitTelemetry(eventId, correlationId, telemetryDetails);
            }
            catch
            {
                // Don't suppress inner exceptions — they may be important.
                throw;
            }
        }

        private static void WriteColoredConsoleOutput(string eventId)
        {
            try
            {
                var message = $"[TELEMETRY+] Event: {eventId ?? "Unknown"} (mirror — see SSR for lifecycle)";
                var originalColor = Console.ForegroundColor;
                Console.ForegroundColor = ConsoleColor.Cyan;
                Console.WriteLine(message);
                Console.ForegroundColor = originalColor;
            }
            catch
            {
                // Ignore console output errors
            }
        }
    }
}
