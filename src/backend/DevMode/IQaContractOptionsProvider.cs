// <copyright file="IQaContractOptionsProvider.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System.Collections.Immutable;

    // ═══════════════════════════════════════════════════════════════════
    // IQaContractOptionsProvider — revision-snapshot options surface
    //
    // Replaces EdogQaFeatureFlags with immutable contract snapshots so
    // generation, execution, and UI reads stay consistent across config
    // reloads.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Immutable snapshot of QA contract options captured at run start.
    /// </summary>
    public sealed class QaContractOptions
    {
        public long Revision { get; init; }

        public bool Enabled { get; init; }

        public IImmutableSet<string> DisabledKinds { get; init; } = ImmutableHashSet<string>.Empty;

        public bool FewShotEnabled { get; init; }

        public string ControlToken { get; init; }
    }

    /// <summary>
    /// Provides immutable QA contract option snapshots with monotonic
    /// revision tracking.
    /// </summary>
    public interface IQaContractOptionsProvider
    {
        QaContractOptions Current { get; }

        QaContractOptions CaptureSnapshot();
    }
}
