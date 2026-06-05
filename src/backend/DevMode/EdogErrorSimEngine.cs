// <copyright file="EdogErrorSimEngine.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Linq;
    using System.Reflection;
    using System.Text.Json;

    // ═══════════════════════════════════════════════════════════════════
    // EdogErrorSimEngine — Error Code Simulator orchestrator (F-ESIM).
    //
    // Translates a high-level "inject error code X on node Y" request into
    // the right low-level injection primitive, picking one of 4 channels
    // based on the error code's Phase / Channel metadata in
    // <see cref="EdogErrorCodeCatalog"/>:
    //
    //   Channel 1 — GTS Status Forge (HTTP 200 + Failed state JSON)
    //               For NODE_EXECUTION errors raised by the user's Spark
    //               job. The GTS poll endpoint returns 200 OK with an
    //               errorDetails block — FLT then surfaces the MLV_* code
    //               via its normal failure path.
    //
    //   Channel 2 — GTS Submit Forge (HTTP 429 / 430 / 4xx / 5xx)
    //               For GTS_SUBMIT errors raised before any Spark code
    //               runs — throttling, capacity exhaustion, submission
    //               rejection. The status code itself drives the FLT
    //               branch that maps to the MLV_* code.
    //
    //   Channel 3 — Pre-GTS Node State Injection (reflection)
    //               For PRE_GTS errors raised during DAG construction —
    //               cycle detection, missing column, schema mismatch.
    //               There is no HTTP call to intercept, so we mutate the
    //               DAG node's IsFaulted / FLTErrorCode / ErrorMessage
    //               directly via reflection after the DAG is built but
    //               before execution begins.
    //
    //   Channel 4 — Exception Injection (TaskCanceledException)
    //               For timeout-class errors. Wired through the HTTP
    //               pipeline handler's existing "timeout" fault family.
    //
    // The engine maintains two stores:
    //   _activeRules — every live rule, surfaced to the frontend's
    //                  "Active rules" pane and used by RemoveRule /
    //                  ComputeBlastRadius / GetActiveRules.
    //   _preGtsRules — Channel 3 rules only. The HTTP pipeline can't see
    //                  them (they don't fire on HTTP), so ApplyPreGtsFaults
    //                  is called by the edog.py DAG construction hook to
    //                  apply them via reflection.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Immutable record of an active error simulator rule. Kept in sync
    /// with the underlying <see cref="EdogHttpFaultStore"/> entry (or the
    /// pre-GTS reflection list) so the frontend can list / dismiss rules
    /// without consulting the lower-level store.
    /// </summary>
    internal sealed class ErrorSimRule
    {
        public string RuleId { get; init; }
        public string NodeId { get; init; }
        public string NodeName { get; init; }
        public string NodeKind { get; init; }
        public string ErrorCode { get; init; }
        public ErrorCodeEntry CatalogEntry { get; init; }
        public DateTime CreatedAt { get; init; }
    }

    /// <summary>
    /// Error Code Simulator engine. Coordinates 4 injection channels:
    /// Channel 1: GTS Status Forge (HTTP 200 + error JSON) — NODE_EXECUTION
    /// Channel 2: GTS Submit Forge (HTTP 429/430/500) — GTS_SUBMIT
    /// Channel 3: Node State Injection (set node.IsFaulted) — PRE_GTS
    /// Channel 4: Exception Injection (TaskCanceledException) — timeout
    /// </summary>
    internal static class EdogErrorSimEngine
    {
        // Active rules: ruleId -> ErrorSimRule (all channels).
        private static readonly ConcurrentDictionary<string, ErrorSimRule> _activeRules = new();

        // Channel 3 rules (pre-GTS node state injection) — stored separately
        // because they apply during DAG construction, not during HTTP calls.
        private static readonly ConcurrentDictionary<string, ErrorSimRule> _preGtsRules = new();

        private const string GtsTargetSubstring = "customTransformExecution";

        // ── Public API ────────────────────────────────────────────────

        /// <summary>
        /// Adds a new error simulator rule for the given node. Looks up
        /// the catalog entry for <paramref name="errorCode"/>, validates
        /// the node kind, then dispatches to the appropriate injection
        /// channel.
        /// </summary>
        /// <returns>
        /// JSON describing the created rule, or a JSON error object on
        /// failure (unknown code, incompatible node kind, etc.).
        /// </returns>
        public static string AddRule(string nodeId, string nodeName, string nodeKind, string errorCode)
        {
            // Normalize empty strings to null — null means "any node" in the fault store
            if (string.IsNullOrEmpty(nodeId)) nodeId = null;
            if (string.IsNullOrEmpty(nodeName)) nodeName = nodeId;
            if (string.IsNullOrEmpty(nodeKind)) nodeKind = null;

            if (string.IsNullOrEmpty(errorCode))
            {
                return ErrorJson("error_code_required", "errorCode is required");
            }

            var entry = EdogErrorCodeCatalog.GetByCode(errorCode);
            if (entry == null)
            {
                return ErrorJson("unknown_error_code", $"Error code '{errorCode}' not found in catalog");
            }

            if (!string.IsNullOrEmpty(nodeKind)
                && entry.NodeKinds != null
                && entry.NodeKinds.Length > 0
                && !entry.NodeKinds.Any(k => string.Equals(k, nodeKind, StringComparison.OrdinalIgnoreCase)))
            {
                return ErrorJson(
                    "incompatible_node_kind",
                    $"Error code '{errorCode}' is not valid for node kind '{nodeKind}'. " +
                    $"Allowed: {string.Join(", ", entry.NodeKinds)}");
            }

            var ruleId = "esim-" + Guid.NewGuid().ToString("N").Substring(0, 8);

            var rule = new ErrorSimRule
            {
                RuleId = ruleId,
                NodeId = nodeId,
                NodeName = nodeName,
                NodeKind = nodeKind,
                ErrorCode = errorCode,
                CatalogEntry = entry,
                CreatedAt = DateTime.UtcNow,
            };

            _activeRules[ruleId] = rule;

            switch (entry.Channel)
            {
                case 1: // GTS Status Forge — HTTP 200 + Failed state JSON
                {
                    var body = BuildGtsStatusForgeBody(entry);
                    EdogHttpFaultStore.AddErrorSimRule(
                        ruleId, nodeId, GtsTargetSubstring, "http_error", 200, body);
                    break;
                }

                case 2: // GTS Submit Forge — non-200 HTTP error
                {
                    var body = BuildGtsSubmitErrorBody(entry);
                    var status = entry.HttpStatus > 0 ? entry.HttpStatus : 500;
                    EdogHttpFaultStore.AddErrorSimRule(
                        ruleId, nodeId, GtsTargetSubstring, "http_error", status, body);
                    break;
                }

                case 3: // Pre-GTS — applied via reflection by ApplyPreGtsFaults
                {
                    _preGtsRules[ruleId] = rule;
                    break;
                }

                case 4: // Exception injection — TaskCanceledException
                {
                    EdogHttpFaultStore.AddErrorSimRule(
                        ruleId, nodeId, GtsTargetSubstring, "timeout", 0, null);
                    break;
                }

                default:
                    _activeRules.TryRemove(ruleId, out _);
                    return ErrorJson(
                        "unknown_channel",
                        $"Error code '{errorCode}' has unknown channel {entry.Channel}");
            }

            return SerializeRule(rule);
        }

        /// <summary>
        /// Removes a rule by ID. Idempotent — silently succeeds even if
        /// the rule is not present.
        /// </summary>
        public static string RemoveRule(string ruleId)
        {
            if (string.IsNullOrEmpty(ruleId))
            {
                return ErrorJson("rule_id_required", "ruleId is required");
            }

            _activeRules.TryRemove(ruleId, out _);
            _preGtsRules.TryRemove(ruleId, out _);
            EdogHttpFaultStore.RemoveErrorSimRule(ruleId);

            return "{\"removed\":\"" + JsonEncode(ruleId) + "\"}";
        }

        /// <summary>
        /// Clears every active rule across all channels.
        /// </summary>
        public static string ClearAll()
        {
            var count = _activeRules.Count;
            _activeRules.Clear();
            _preGtsRules.Clear();
            EdogHttpFaultStore.ClearErrorSimRules();
            return "{\"cleared\":" + count + "}";
        }

        /// <summary>
        /// Returns every active rule as a JSON array, newest first.
        /// </summary>
        public static string GetActiveRules()
        {
            var rules = _activeRules.Values
                .OrderByDescending(r => r.CreatedAt)
                .ToList();

            var sb = new System.Text.StringBuilder();
            sb.Append('[');
            for (int i = 0; i < rules.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(SerializeRule(rules[i]));
            }
            sb.Append(']');
            return sb.ToString();
        }

        /// <summary>
        /// Returns the catalog JSON unchanged (delegates to
        /// <see cref="EdogErrorCodeCatalog.GetCatalogJson"/>).
        /// </summary>
        public static string GetCatalogJson() => EdogErrorCodeCatalog.GetCatalogJson();

        /// <summary>
        /// Applies every Channel 3 (pre-GTS) rule to the freshly-built
        /// DAG by mutating the matching node via reflection. Called by
        /// the edog.py DAG-construction patch immediately after the DAG
        /// is built but before execution begins.
        /// </summary>
        /// <param name="dag">FLT Dag instance (passed as <c>object</c>
        /// because the DevMode assembly cannot reference the FLT Dag
        /// type directly).</param>
        /// <param name="dagExecInstance">Optional FLT DagExecutionInstance.
        /// When provided, we reflect <c>IterationId</c> off it and stamp
        /// the synthetic <c>NodeExecution Failed</c> telemetry with that
        /// id so the frontend's iteration-scoped filter accepts it.
        /// Null is tolerated for backward compatibility with older patch
        /// sites; in that case the telemetry is emitted without an
        /// IterationId and the frontend's "no-iteration filter" branch
        /// accepts it (best-effort).</param>
        public static void ApplyPreGtsFaults(object dag, object dagExecInstance = null)
        {
            if (dag == null || _preGtsRules.IsEmpty) return;

            var nodes = TryGetNodesEnumerable(dag);
            if (nodes == null) return;

            // Snapshot node list once — we may iterate multiple times for
            // multiple rules.
            var nodeList = new List<object>();
            foreach (var n in nodes)
            {
                if (n != null) nodeList.Add(n);
            }
            if (nodeList.Count == 0) return;

            string iterationId = TryGetIterationId(dagExecInstance);

            foreach (var rule in _preGtsRules.Values)
            {
                var target = FindNodeByName(nodeList, rule.NodeName)
                             ?? FindNodeByName(nodeList, rule.NodeId);
                if (target == null) continue;

                InjectNodeFault(target, rule, iterationId);
            }
        }

        private static string TryGetIterationId(object dagExecInstance)
        {
            if (dagExecInstance == null) return null;
            try
            {
                var prop = dagExecInstance.GetType().GetProperty(
                    "IterationId",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                var value = prop?.GetValue(dagExecInstance);
                if (value == null) return null;
                var s = value.ToString();
                return string.IsNullOrEmpty(s) ? null : s;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Returns a JSON object describing the blast radius for the
        /// given rule: which error code was injected, on which channel,
        /// and the FLT code path that will surface it. Downstream node
        /// impact is reserved for a future revision (empty array today).
        /// </summary>
        public static string ComputeBlastRadius(string ruleId)
        {
            if (string.IsNullOrEmpty(ruleId)
                || !_activeRules.TryGetValue(ruleId, out var rule))
            {
                return ErrorJson("rule_not_found", $"No active rule with id '{ruleId}'");
            }

            var entry = rule.CatalogEntry;
            var sb = new System.Text.StringBuilder();
            sb.Append('{');
            sb.Append("\"ruleId\":\"").Append(JsonEncode(rule.RuleId)).Append('"');
            sb.Append(",\"nodeId\":\"").Append(JsonEncode(rule.NodeId)).Append('"');
            sb.Append(",\"nodeName\":\"").Append(JsonEncode(rule.NodeName)).Append('"');
            sb.Append(",\"errorCode\":\"").Append(JsonEncode(entry.Code)).Append('"');
            sb.Append(",\"description\":\"").Append(JsonEncode(entry.Description)).Append('"');
            sb.Append(",\"phase\":\"").Append(JsonEncode(entry.Phase)).Append('"');
            sb.Append(",\"channel\":").Append(entry.Channel);
            sb.Append(",\"channelName\":\"").Append(JsonEncode(ChannelName(entry.Channel))).Append('"');
            sb.Append(",\"errorSource\":\"").Append(JsonEncode(entry.ErrorSource)).Append('"');
            sb.Append(",\"fltCodePath\":\"").Append(JsonEncode(entry.FltCodePath)).Append('"');
            sb.Append(",\"downstreamNodes\":[]");
            sb.Append('}');
            return sb.ToString();
        }

        /// <summary>Test-only: drop every rule and reset the engine.</summary>
        public static void ResetForTesting()
        {
            _activeRules.Clear();
            _preGtsRules.Clear();
            EdogHttpFaultStore.ClearErrorSimRules();
        }

        // ── Internals ─────────────────────────────────────────────────

        private static string BuildGtsStatusForgeBody(ErrorCodeEntry entry)
        {
            // GTS poll response shape: HTTP 200 with "Failed" state and an
            // "error" block (DataMember Name="error" on TransformExecutionResponse.ErrorDetails).
            // FLT reads error.errorCode and surfaces it as the MLV_* code.
            var sb = new System.Text.StringBuilder();
            sb.Append('{');
            sb.Append("\"id\":\"00000000-0000-0000-0000-000000000000\"");
            sb.Append(",\"state\":\"Failed\"");
            sb.Append(",\"error\":{");
            sb.Append("\"errorCode\":\"").Append(JsonEncode(entry.Code)).Append('"');
            sb.Append(",\"message\":\"").Append(JsonEncode(entry.Description ?? entry.Code)).Append('"');
            sb.Append(",\"errorSource\":\"").Append(JsonEncode(entry.ErrorSource ?? "System")).Append('"');
            sb.Append('}');
            sb.Append('}');
            return sb.ToString();
        }

        private static string BuildGtsSubmitErrorBody(ErrorCodeEntry entry)
        {
            // GTS submit error shape: non-200 HTTP with an "error" envelope.
            var sb = new System.Text.StringBuilder();
            sb.Append("{\"error\":{");
            sb.Append("\"code\":\"").Append(JsonEncode(ShortGtsCode(entry))).Append('"');
            sb.Append(",\"message\":\"").Append(JsonEncode(entry.Description ?? entry.Code)).Append('"');
            sb.Append("}}");
            return sb.ToString();
        }

        private static string ShortGtsCode(ErrorCodeEntry entry)
        {
            // GTS uses short PascalCase codes ("TooManyRequests"). The
            // exact string isn't load-bearing for fault injection — FLT
            // branches on the HTTP status code — but we pick a sensible
            // default per status so the body looks realistic in traces.
            return entry.HttpStatus switch
            {
                429 => "TooManyRequests",
                430 => "CapacityThrottling",
                400 => "BadRequest",
                401 => "Unauthorized",
                403 => "Forbidden",
                404 => "NotFound",
                408 => "RequestTimeout",
                500 => "InternalServerError",
                502 => "BadGateway",
                503 => "ServiceUnavailable",
                504 => "GatewayTimeout",
                _ => "Error",
            };
        }

        private static string ChannelName(int channel) => channel switch
        {
            1 => "GTS Status Forge",
            2 => "GTS Submit Forge",
            3 => "Pre-GTS Node State Injection",
            4 => "Exception Injection",
            _ => "Unknown",
        };

        private static IEnumerable TryGetNodesEnumerable(object dag)
        {
            // Look for a "Nodes" property on the DAG. FLT's Dag class
            // exposes Nodes as IReadOnlyList<Node>.
            var prop = dag.GetType().GetProperty(
                "Nodes",
                BindingFlags.Public | BindingFlags.Instance);
            if (prop == null) return null;

            return prop.GetValue(dag) as IEnumerable;
        }

        private static object FindNodeByName(List<object> nodes, string name)
        {
            if (string.IsNullOrEmpty(name)) return null;

            foreach (var node in nodes)
            {
                var nameProp = node.GetType().GetProperty(
                    "Name", BindingFlags.Public | BindingFlags.Instance);
                if (nameProp == null) continue;

                var actual = nameProp.GetValue(node) as string;
                if (string.Equals(actual, name, StringComparison.OrdinalIgnoreCase))
                {
                    return node;
                }
            }
            return null;
        }

        private static void InjectNodeFault(object node, ErrorSimRule rule, string iterationId = null)
        {
            var nodeType = node.GetType();
            var entry = rule.CatalogEntry;

            var isFaultedProp = nodeType.GetProperty(
                "IsFaulted",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            isFaultedProp?.SetValue(node, true);

            var errorMessageProp = nodeType.GetProperty(
                "ErrorMessage",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            errorMessageProp?.SetValue(node, entry.Description ?? entry.Code);

            // FLTErrorCode is a nullable enum (ErrorCode?). Parse the
            // catalog code into the enum value via reflection so we
            // don't need a compile-time reference to the enum type.
            var errorCodeProp = nodeType.GetProperty(
                "FLTErrorCode",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (errorCodeProp != null)
            {
                var enumType = Nullable.GetUnderlyingType(errorCodeProp.PropertyType)
                               ?? errorCodeProp.PropertyType;
                if (enumType.IsEnum)
                {
                    try
                    {
                        var enumValue = Enum.Parse(enumType, entry.Code, ignoreCase: true);
                        errorCodeProp.SetValue(node, enumValue);
                    }
                    catch (ArgumentException)
                    {
                        // Catalog code not present in FLT's enum — leave
                        // FLTErrorCode null; the message + IsFaulted flag
                        // are still enough for the failure to surface.
                    }
                }
            }

            // Emit synthetic NodeExecution Failed telemetry so the EDOG Studio UI
            // can see this pre-GTS injection. The node will never actually run —
            // FLT aborts the entire DAG via MLV_DAG_HAS_FAULTED_NODES once it
            // sees IsFaulted=true on any node — so no real NodeExecution telemetry
            // is ever emitted for the targeted node. Without this synthetic emit
            // the frontend leaves the node in 'pending' / "Not Started" with no
            // error code, even though the backend correctly injected the fault.
            // The frontend's ExecutionStateManager subscribes to the "telemetry"
            // topic and treats {activityName=NodeExecution, activityStatus=Failed}
            // exactly the same as a real FLT-emitted failure.
            try
            {
                EmitSyntheticNodeFailedTelemetry(node, entry, iterationId);
            }
            catch
            {
                // Telemetry is best-effort — never break DAG construction.
            }
        }

        private static void EmitSyntheticNodeFailedTelemetry(
            object node, ErrorCodeEntry entry, string iterationId)
        {
            var nodeType = node.GetType();
            var nodeIdProp = nodeType.GetProperty(
                "NodeId", BindingFlags.Public | BindingFlags.Instance);
            var nameProp = nodeType.GetProperty(
                "Name", BindingFlags.Public | BindingFlags.Instance);
            string nodeIdStr = nodeIdProp?.GetValue(node)?.ToString() ?? string.Empty;
            string nodeName = nameProp?.GetValue(node) as string ?? string.Empty;

            var attributes = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["NodeId"] = nodeIdStr,
                ["NodeName"] = nodeName,
                ["nodeId"] = nodeIdStr,
                ["nodeName"] = nodeName,
                ["ErrorCode"] = entry?.Code ?? string.Empty,
                ["errorCode"] = entry?.Code ?? string.Empty,
                ["ErrorSource"] = entry?.ErrorSource ?? "System",
                ["InjectedBy"] = "EdogErrorSim",
                ["Channel"] = "3",
            };
            if (!string.IsNullOrEmpty(iterationId))
            {
                attributes["IterationId"] = iterationId;
                attributes["iterationId"] = iterationId;
            }

            var telemetryEvent = new TelemetryEvent(
                DateTime.UtcNow,
                "NodeExecution",
                "Failed",
                0L,
                entry?.Code ?? string.Empty,
                string.Empty,
                attributes,
                string.Empty);
            if (!string.IsNullOrEmpty(iterationId))
            {
                telemetryEvent.IterationId = iterationId;
            }

            EdogTopicRouter.Publish("telemetry", telemetryEvent);
        }

        private static string SerializeRule(ErrorSimRule rule)
        {
            var entry = rule.CatalogEntry;
            var sb = new System.Text.StringBuilder();
            sb.Append('{');
            sb.Append("\"ruleId\":\"").Append(JsonEncode(rule.RuleId)).Append('"');
            sb.Append(",\"nodeId\":\"").Append(JsonEncode(rule.NodeId)).Append('"');
            sb.Append(",\"nodeName\":\"").Append(JsonEncode(rule.NodeName)).Append('"');
            sb.Append(",\"nodeKind\":\"").Append(JsonEncode(rule.NodeKind)).Append('"');
            sb.Append(",\"errorCode\":\"").Append(JsonEncode(rule.ErrorCode)).Append('"');
            sb.Append(",\"phase\":\"").Append(JsonEncode(entry?.Phase)).Append('"');
            sb.Append(",\"channel\":").Append(entry?.Channel ?? 0);
            sb.Append(",\"category\":\"").Append(JsonEncode(entry?.Category)).Append('"');
            sb.Append(",\"description\":\"").Append(JsonEncode(entry?.Description)).Append('"');
            sb.Append(",\"errorSource\":\"").Append(JsonEncode(entry?.ErrorSource)).Append('"');
            sb.Append(",\"httpStatus\":").Append(entry?.HttpStatus ?? 0);
            sb.Append(",\"fltCodePath\":\"").Append(JsonEncode(entry?.FltCodePath)).Append('"');
            sb.Append(",\"createdAt\":\"").Append(rule.CreatedAt.ToString("o")).Append('"');
            sb.Append('}');
            return sb.ToString();
        }

        private static string ErrorJson(string code, string message)
        {
            return "{\"error\":{\"code\":\"" + JsonEncode(code)
                + "\",\"message\":\"" + JsonEncode(message) + "\"}}";
        }

        private static string JsonEncode(string s)
        {
            if (s == null) return string.Empty;
            var sb = new System.Text.StringBuilder(s.Length + 8);
            foreach (var c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"':  sb.Append("\\\""); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else
                            sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
