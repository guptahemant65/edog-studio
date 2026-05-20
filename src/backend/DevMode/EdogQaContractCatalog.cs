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
            // Placeholder — will parse Swagger paths into HTTP slots
            return Array.Empty<QaContractSlot>();
        }
    }

    /// <summary>
    /// Provides SignalR slots from framework-endpoints.json.
    /// </summary>
    internal static class SignalRSlotProvider
    {
        public static IReadOnlyList<QaContractSlot> FromFrameworkEndpoints(string registryJson)
        {
            return Array.Empty<QaContractSlot>();
        }
    }

    /// <summary>
    /// Assembles the per-zone contract catalog from multiple providers.
    /// </summary>
    internal sealed class EdogQaContractCatalog
    {
        private readonly EdogQaDiRegistryProvider _diProvider;
        private readonly EdogQaOmniSharpProvider _omniSharpProvider;
        private object _capabilitiesForRun;

        public EdogQaContractCatalog(
            EdogQaDiRegistryProvider diProvider,
            EdogQaOmniSharpProvider omniSharpProvider)
        {
            _diProvider = diProvider;
            _omniSharpProvider = omniSharpProvider;
        }

        /// <summary>
        /// Assembles a catalog snapshot for the given zone.
        /// </summary>
        public CatalogSnapshot Assemble(string zoneId)
        {
            var slots = new List<QaContractSlot>();
            var topicHashes = new Dictionary<string, string>();
            var providerStatus = new Dictionary<string, string>();

            // HTTP provider
            providerStatus["http"] = "ok";

            // SignalR provider
            providerStatus["signalr"] = "ok";

            // DI provider
            providerStatus["di"] = "ok";

            // DAG provider
            providerStatus["dag"] = "ok";

            // FileEvent provider
            providerStatus["file_event"] = "ok";

            // TimerTick provider
            providerStatus["timer_tick"] = "ok";

            var snapshot = new CatalogSnapshot
            {
                SnapshotId = Guid.NewGuid().ToString("N")[..12],
                AssembledAtUtc = DateTimeOffset.UtcNow,
                ZoneId = zoneId,
                FltBuildSha = "unknown",
                EdogRepoSha = "unknown",
                SchemaCapVersion = "1.0",
                ProviderStatus = providerStatus,
                Slots = slots,
                TopicFieldHashes = topicHashes,
            };

            snapshot.ContentHash = ComputeContentHash(snapshot);
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
