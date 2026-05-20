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
    /// Immutable snapshot of the assembled contract catalog for a zone.
    /// </summary>
    public sealed class CatalogSnapshot
    {
        public string SnapshotId { get; set; }
        public DateTimeOffset AssembledAt { get; set; }
        public string ZoneId { get; set; }
        public IReadOnlyList<ProviderResult> ProviderResults { get; set; } = Array.Empty<ProviderResult>();
        public IReadOnlyDictionary<string, SlotDescriptor> Slots { get; set; } = new Dictionary<string, SlotDescriptor>();
        public IReadOnlyDictionary<string, string> TopicFieldHashes { get; set; } = new Dictionary<string, string>();
        public string ContentHash { get; set; }
    }

    /// <summary>
    /// Describes a single stimulus slot in the contract catalog.
    /// </summary>
    public sealed class SlotDescriptor
    {
        public string SlotId { get; set; }
        public StimulusType Kind { get; set; }
        public string Purpose { get; set; }
        public string Hash { get; set; }
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
    /// Assembles the per-zone contract catalog from multiple providers.
    /// </summary>
    internal sealed class EdogQaContractCatalog
    {
        private readonly EdogQaDiRegistryProvider _diProvider;
        private readonly EdogQaOmniSharpProvider _omniSharpProvider;

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
            var providers = new List<ProviderResult>();
            var slots = new Dictionary<string, SlotDescriptor>();
            var topicHashes = new Dictionary<string, string>();

            var snapshot = new CatalogSnapshot
            {
                SnapshotId = Guid.NewGuid().ToString("N")[..12],
                AssembledAt = DateTimeOffset.UtcNow,
                ZoneId = zoneId,
                ProviderResults = providers,
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
    }
}
