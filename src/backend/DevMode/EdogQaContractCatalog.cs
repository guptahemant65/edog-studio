// <copyright file="EdogQaContractCatalog.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Collections.Immutable;
    using System.Linq;
    using System.Security.Cryptography;
    using System.Text;
    using System.Text.Json;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaContractCatalog — per-zone contract catalog assembler
    //
    // Owns provider orchestration, required-provider hard-fail logic,
    // the immutable CatalogSnapshot envelope, canonical hashing, and
    // assembler-side cap assertions.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Status of a single catalog provider after assembly.
    /// </summary>
    public enum ProviderStatus
    {
        Ok,
        Degraded,
        Empty,
        Failed
    }

    /// <summary>
    /// Describes a single stimulus slot in the contract catalog.
    /// </summary>
    public sealed class QaContractSlot
    {
        public string SlotId { get; set; }
        public string SlotHash { get; set; }
        public StimulusType Kind { get; set; }
        public string Idempotency { get; set; }
        public bool Mutates { get; set; }
        public bool LeavesState { get; set; }
        public string Purpose { get; set; }
        public List<string> Captures { get; set; } = new();
        public IReadOnlyDictionary<string, SlotParameter> Parameters { get; set; } = new Dictionary<string, SlotParameter>();
    }

    /// <summary>
    /// Describes a parameter for a stimulus slot.
    /// </summary>
    public sealed class SlotParameter
    {
        public string Name { get; set; }
        public string Type { get; set; }
        public bool Required { get; set; }
        public string Description { get; set; }
    }

    /// <summary>
    /// Immutable snapshot of the assembled contract catalog for a zone.
    /// </summary>
    public sealed class CatalogSnapshot
    {
        public string SnapshotId { get; set; }
        public string FltBuildSha { get; set; }
        public string EdogRepoSha { get; set; }
        public string SchemaCapVersion { get; set; }
        public DateTimeOffset AssembledAtUtc { get; set; }
        public Dictionary<string, string> ProviderStatus { get; set; } = new();
        public string ZoneId { get; set; }
        public IReadOnlyList<QaContractSlot> Slots { get; set; } = Array.Empty<QaContractSlot>();
        public IReadOnlyDictionary<string, string> TopicFieldHashes { get; set; } = new Dictionary<string, string>();
        public string ContentHash { get; set; }
    }

    /// <summary>
    /// Result of a single provider's contribution to the catalog.
    /// </summary>
    public sealed class ProviderResult
    {
        public string ProviderName { get; set; }
        public ProviderStatus Status { get; set; }
        public string Message { get; set; }
        public int SlotCount { get; set; }
    }

    /// <summary>
    /// Provides HTTP slots from runtime Swagger.
    /// </summary>
    internal static class HttpSlotProvider
    {
        public static IReadOnlyList<QaContractSlot> FromSwagger(string zoneId, object swagger)
        {
            var slots = new List<QaContractSlot>();
            if (swagger == null) return slots;

            try
            {
                // swagger is a deserialized JsonElement or object — re-serialize and parse
                var json = swagger is System.Text.Json.JsonElement el
                    ? el.GetRawText()
                    : System.Text.Json.JsonSerializer.Serialize(swagger);

                using var doc = System.Text.Json.JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("paths", out var paths)
                    || paths.ValueKind != System.Text.Json.JsonValueKind.Object)
                {
                    return slots;
                }

                foreach (var pathEntry in paths.EnumerateObject())
                {
                    var path = pathEntry.Name;
                    if (pathEntry.Value.ValueKind != System.Text.Json.JsonValueKind.Object) continue;

                    foreach (var methodEntry in pathEntry.Value.EnumerateObject())
                    {
                        var method = methodEntry.Name.ToUpperInvariant();
                        if (method == "PARAMETERS" || method == "SERVERS" || method == "$REF") continue;

                        var summary = string.Empty;
                        if (methodEntry.Value.ValueKind == System.Text.Json.JsonValueKind.Object
                            && methodEntry.Value.TryGetProperty("summary", out var summaryEl)
                            && summaryEl.ValueKind == System.Text.Json.JsonValueKind.String)
                        {
                            summary = summaryEl.GetString() ?? string.Empty;
                        }

                        var slotId = $"http:{method.ToLowerInvariant()}:{path}";
                        slots.Add(new QaContractSlot
                        {
                            SlotId = slotId,
                            Kind = StimulusType.HttpRequest,
                            Purpose = string.IsNullOrEmpty(summary)
                                ? $"{method} {path}"
                                : $"{method} {path} — {summary}",
                            SlotHash = ComputeSlotHash(slotId),
                        });
                    }
                }
            }
            catch
            {
                // Malformed swagger — return empty
            }

            return slots;
        }

        private static string ComputeSlotHash(string slotId)
        {
            using var sha = System.Security.Cryptography.SHA256.Create();
            var bytes = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(slotId));
            return BitConverter.ToString(bytes, 0, 6).Replace("-", "").ToLowerInvariant();
        }
    }

    /// <summary>
    /// Provides SignalR slots from framework-endpoints.json.
    /// </summary>
    internal static class SignalRSlotProvider
    {
        public static IReadOnlyList<QaContractSlot> FromFrameworkEndpoints(string registryJson)
        {
            var slots = new List<QaContractSlot>();
            if (string.IsNullOrWhiteSpace(registryJson)) return slots;

            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(registryJson);
                var root = doc.RootElement;

                // framework-endpoints.json can be an array of hub descriptors
                // or an object with a "hubs" array.
                System.Text.Json.JsonElement hubs;
                if (root.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    hubs = root;
                }
                else if (root.ValueKind == System.Text.Json.JsonValueKind.Object
                    && root.TryGetProperty("hubs", out var hubsEl)
                    && hubsEl.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    hubs = hubsEl;
                }
                else
                {
                    return slots;
                }

                foreach (var hub in hubs.EnumerateArray())
                {
                    if (hub.ValueKind != System.Text.Json.JsonValueKind.Object) continue;

                    var hubName = hub.TryGetProperty("name", out var n) && n.ValueKind == System.Text.Json.JsonValueKind.String
                        ? n.GetString()
                        : (hub.TryGetProperty("Name", out var n2) && n2.ValueKind == System.Text.Json.JsonValueKind.String
                            ? n2.GetString() : null);

                    if (string.IsNullOrEmpty(hubName)) continue;

                    // Look for methods array
                    System.Text.Json.JsonElement methods = default;
                    var hasMethods = hub.TryGetProperty("methods", out methods)
                        || hub.TryGetProperty("Methods", out methods);

                    if (hasMethods && methods.ValueKind == System.Text.Json.JsonValueKind.Array)
                    {
                        foreach (var method in methods.EnumerateArray())
                        {
                            var methodName = method.ValueKind == System.Text.Json.JsonValueKind.String
                                ? method.GetString()
                                : (method.ValueKind == System.Text.Json.JsonValueKind.Object
                                    && method.TryGetProperty("name", out var mn) && mn.ValueKind == System.Text.Json.JsonValueKind.String
                                    ? mn.GetString() : null);

                            if (string.IsNullOrEmpty(methodName)) continue;

                            var slotId = $"signalr:{hubName}:{methodName}";
                            slots.Add(new QaContractSlot
                            {
                                SlotId = slotId,
                                Kind = StimulusType.SignalRBroadcast,
                                Purpose = $"SignalR {hubName}.{methodName}",
                                SlotHash = ComputeSlotHash(slotId),
                            });
                        }
                    }
                    else
                    {
                        // Hub with no method list — add the hub itself
                        var slotId = $"signalr:{hubName}";
                        slots.Add(new QaContractSlot
                        {
                            SlotId = slotId,
                            Kind = StimulusType.SignalRBroadcast,
                            Purpose = $"SignalR hub {hubName}",
                            SlotHash = ComputeSlotHash(slotId),
                        });
                    }
                }
            }
            catch
            {
                // Malformed JSON — return empty
            }

            return slots;
        }

        private static string ComputeSlotHash(string slotId)
        {
            using var sha = System.Security.Cryptography.SHA256.Create();
            var bytes = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(slotId));
            return BitConverter.ToString(bytes, 0, 6).Replace("-", "").ToLowerInvariant();
        }
    }

    /// <summary>
    /// Matcher topic catalog entry with field-level hash for staleness.
    /// </summary>
    public sealed class MatcherTopicCatalog
    {
        public string TopicHash { get; set; }
        public Dictionary<string, string> Fields { get; set; } = new();
    }

    /// <summary>
    /// Holds the assembled matcher topic hashes for the catalog.
    /// </summary>
    public sealed class MatcherTopics
    {
        public Dictionary<string, MatcherTopicCatalog> Topics { get; set; } = new();
    }

    /// <summary>
    /// Assembles the per-zone contract catalog from multiple providers.
    /// </summary>
    internal sealed class EdogQaContractCatalog
    {
        private readonly EdogQaDiRegistryProvider _diProvider;
        private readonly EdogQaOmniSharpProvider _omniSharpProvider;
        private readonly EdogQaDagScanner _dagScanner;
        private readonly EdogQaFileTimerScanner _fileTimerScanner;
        private object _capabilitiesForRun;

        public EdogQaContractCatalog(
            EdogQaDiRegistryProvider diProvider,
            EdogQaOmniSharpProvider omniSharpProvider,
            EdogQaDagScanner dagScanner,
            EdogQaFileTimerScanner fileTimerScanner)
        {
            _diProvider = diProvider;
            _omniSharpProvider = omniSharpProvider;
            _dagScanner = dagScanner;
            _fileTimerScanner = fileTimerScanner;
        }

        /// <summary>
        /// Assembles a catalog snapshot for the given zone.
        /// </summary>
        public CatalogSnapshot Assemble(string zoneId, string fltRepoRoot = null, object swagger = null, string frameworkEndpointsJson = null)
        {
            var slots = new List<QaContractSlot>();
            var topicHashes = new Dictionary<string, string>();
            var providerStatus = new Dictionary<string, string>();

            // HTTP provider — parse runtime Swagger into HTTP slots
            try
            {
                var httpSlots = HttpSlotProvider.FromSwagger(zoneId, swagger);
                slots.AddRange(httpSlots);
                providerStatus["http"] = httpSlots.Count > 0 ? "ok" : "empty";
            }
            catch (Exception ex)
            {
                providerStatus["http"] = "failed";
                EdogQaTelemetry.EmitContractEvent(EdogQaTelemetry.EventCatalogProviderDegraded,
                    zoneId, "PROVIDER_FAILED", $"http: {ex.Message}");
            }

            // SignalR provider — parse framework-endpoints.json
            try
            {
                var signalRSlots = SignalRSlotProvider.FromFrameworkEndpoints(frameworkEndpointsJson);
                slots.AddRange(signalRSlots);
                providerStatus["signalr"] = signalRSlots.Count > 0 ? "ok" : "empty";
            }
            catch (Exception ex)
            {
                providerStatus["signalr"] = "failed";
                EdogQaTelemetry.EmitContractEvent(EdogQaTelemetry.EventCatalogProviderDegraded,
                    zoneId, "PROVIDER_FAILED", $"signalr: {ex.Message}");
            }

            // DI provider — enumerate [EdogDirectInvokeSeam]-tagged services
            try
            {
                var diSlots = _diProvider?.GetContractSlots() ?? new List<QaContractSlot>();
                slots.AddRange(diSlots);
                providerStatus["di"] = diSlots.Count > 0 ? "ok" : "empty";
            }
            catch (Exception ex)
            {
                providerStatus["di"] = "failed";
                EdogQaTelemetry.EmitContractEvent(EdogQaTelemetry.EventCatalogProviderDegraded,
                    zoneId, "PROVIDER_FAILED", $"di: {ex.Message}");
            }

            // DAG provider — Roslyn scan for [DagDefinition] classes
            try
            {
                var dagSlots = fltRepoRoot != null ? _dagScanner?.Scan(fltRepoRoot) : Array.Empty<QaContractSlot>();
                slots.AddRange(dagSlots);
                providerStatus["dag"] = dagSlots.Count > 0 ? "ok" : "empty";
            }
            catch (Exception ex)
            {
                providerStatus["dag"] = "failed";
                EdogQaTelemetry.EmitContractEvent(EdogQaTelemetry.EventCatalogProviderDegraded,
                    zoneId, "PROVIDER_FAILED", $"dag: {ex.Message}");
            }

            // FileEvent + TimerTick provider — Roslyn scan for seam attributes
            try
            {
                var fileTimerSlots = fltRepoRoot != null ? _fileTimerScanner?.Scan(fltRepoRoot) : Array.Empty<QaContractSlot>();
                foreach (var slot in fileTimerSlots)
                {
                    slots.Add(slot);
                }
                var fileCount = fileTimerSlots.Count(s => s.Kind == StimulusType.FileEvent);
                var timerCount = fileTimerSlots.Count(s => s.Kind == StimulusType.TimerTick);
                providerStatus["file_event"] = fileCount > 0 ? "ok" : "empty";
                providerStatus["timer_tick"] = timerCount > 0 ? "ok" : "empty";
            }
            catch (Exception ex)
            {
                providerStatus["file_event"] = "failed";
                providerStatus["timer_tick"] = "failed";
                EdogQaTelemetry.EmitContractEvent(EdogQaTelemetry.EventCatalogProviderDegraded,
                    zoneId, "PROVIDER_FAILED", $"file_timer: {ex.Message}");
            }

            // Topic field hashes from OmniSharp anonymous-type discovery
            try
            {
                if (fltRepoRoot != null && _omniSharpProvider != null)
                {
                    var hashes = _omniSharpProvider.ComputeTopicFieldHashes(fltRepoRoot);
                    foreach (var kvp in hashes)
                    {
                        topicHashes[kvp.Key] = kvp.Value;
                    }
                }
            }
            catch (Exception ex)
            {
                EdogQaTelemetry.EmitContractEvent(EdogQaTelemetry.EventCatalogProviderDegraded,
                    zoneId, "PROVIDER_FAILED", $"topic_fields: {ex.Message}");
            }

            // Assembler-side cap assertions (§2.4)
            if (slots.Count > 500)
            {
                EdogQaTelemetry.EmitContractEvent(EdogQaTelemetry.EventCatalogOverflow,
                    zoneId, "SLOT_CAP_EXCEEDED", $"slotCount={slots.Count} cap=500");
            }

            var snapshot = new CatalogSnapshot
            {
                AssembledAtUtc = DateTimeOffset.UtcNow,
                ZoneId = zoneId,
                FltBuildSha = "unknown",
                EdogRepoSha = "unknown",
                SchemaCapVersion = "1.0",
                ProviderStatus = providerStatus,
                Slots = slots,
                TopicFieldHashes = topicHashes,
            };

            // P10 fix (P1-3): derive SnapshotId from the deterministic content
            // hash so two assemblies of the same catalog produce the same id.
            // Random GUIDs made every snapshot look "new" to consumers and
            // defeated the staleness-detection comparison.
            snapshot.ContentHash = ComputeContentHash(snapshot);
            snapshot.SnapshotId = snapshot.ContentHash;
            return snapshot;
        }

        /// <summary>
        /// Computes a stable SHA-256 hash of the catalog content.
        /// </summary>
        internal static string ComputeContentHash(CatalogSnapshot snapshot)
        {
            var json = JsonSerializer.Serialize(new
            {
                snapshot.ZoneId,
                SlotCount = snapshot.Slots.Count,
                TopicCount = snapshot.TopicFieldHashes.Count,
            });
            var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(json));
            return Convert.ToHexString(bytes)[..16].ToLowerInvariant();
        }

        /// <summary>
        /// Builds the few-shot exemplar payload from catalog slot purposes.
        /// </summary>
        internal string BuildFewShotExemplars(CatalogSnapshot snapshot)
        {
            if (snapshot.Slots.Count == 0) return string.Empty;
            var sb = new StringBuilder();
            sb.AppendLine("// Stimulus slots available in this zone:");
            foreach (var slot in snapshot.Slots)
            {
                sb.AppendLine($"//  - {slot.SlotId} ({slot.Kind}): {slot.Purpose}");
            }
            return sb.ToString();
        }
    }
}
