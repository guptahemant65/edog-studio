// <copyright file="MitmRule.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Text.RegularExpressions;
    using System.Threading;

    // ──────────────────────────────────────────────
    // MitmRule — Immutable rule shape for HTTP MITM
    // ──────────────────────────────────────────────

    /// <summary>
    /// Immutable snapshot of a single MITM rule. Stored in <see cref="MitmRuleStore"/>,
    /// exchanged over <c>MitmCreateRule</c> / <c>MitmListRules</c> / topic events.
    /// Equality is <see cref="Id"/>-based; same Id on insert = last-writer-wins.
    /// </summary>
    internal sealed class MitmRule
    {
        public string Id { get; init; }
        public string Name { get; init; }
        public string OwnerConnectionId { get; init; }
        public bool Enabled { get; init; }
        public int Priority { get; init; }
        public MitmMatch Match { get; init; }
        public MitmAction Action { get; init; }
        public DateTimeOffset CreatedAtUtc { get; init; }
    }

    // ──────────────────────────────────────────────
    // MitmMatch — Predicate that decides if a rule fires
    // ──────────────────────────────────────────────

    /// <summary>
    /// Predicate block on a <see cref="MitmRule"/>. All non-null fields must match
    /// for the rule to fire. Null fields are wildcards.
    /// </summary>
    internal sealed class MitmMatch
    {
        /// <summary>URL pattern to match against the absolute request URI.</summary>
        public MitmUrlPattern UrlPattern { get; init; }

        /// <summary>HTTP methods to match. Empty or null = any method.</summary>
        public string[] Methods { get; init; }

        /// <summary>Named HttpClient filter. Null = any client.</summary>
        public string HttpClientName { get; init; }

        /// <summary>Which suspension point this rule applies to.</summary>
        public MitmPhase Phase { get; init; }
    }

    // ──────────────────────────────────────────────
    // MitmUrlPattern — URL matching with compile-once regex
    // ──────────────────────────────────────────────

    /// <summary>
    /// URL matching predicate. <see cref="Compiled"/> is populated exactly once
    /// at rule insert time when <see cref="Kind"/> is <see cref="MitmUrlMatchKind.Regex"/>.
    /// The reader hot path never calls <c>new Regex(...)</c>.
    /// </summary>
    internal sealed class MitmUrlPattern
    {
        public MitmUrlMatchKind Kind { get; init; }
        public string Value { get; init; }

        /// <summary>Pre-compiled regex. Only populated when Kind == Regex. Match timeout = 50ms.</summary>
        public Regex Compiled { get; init; }
    }

    // ──────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────

    internal enum MitmUrlMatchKind
    {
        Substring,
        Regex,
        Exact,
    }

    internal enum MitmPhase
    {
        Request,
        Response,
    }

    internal enum MitmActionType
    {
        Breakpoint,
        Block,
        Forge,
        Modify,
        Passthrough,
    }

    // ──────────────────────────────────────────────
    // MitmAction — Action hierarchy
    // ──────────────────────────────────────────────

    /// <summary>Base class for MITM rule actions. Discriminated by <see cref="Type"/>.</summary>
    internal abstract class MitmAction
    {
        public MitmActionType Type { get; init; }
    }

    /// <summary>Pause the request and await a frontend decision (forward/modify/block/forge).</summary>
    internal sealed class MitmBreakpointAction : MitmAction
    {
        /// <summary>Timeout in ms before auto-forwarding. Clamped to [1000, 60000].</summary>
        public int TimeoutMs { get; init; } = 30_000;
    }

    /// <summary>Drop the request and return an error response to the caller.</summary>
    internal sealed class MitmBlockAction : MitmAction
    {
        public int StatusCode { get; init; } = 503;
        public string Body { get; init; }
        public Dictionary<string, string> Headers { get; init; }
    }

    /// <summary>Short-circuit with a fabricated response (never calls the real server).</summary>
    internal sealed class MitmForgeAction : MitmAction
    {
        public int StatusCode { get; init; } = 200;
        public string Body { get; init; }
        public Dictionary<string, string> Headers { get; init; }
        public string ReasonPhrase { get; init; }
    }

    /// <summary>Modify the request before forwarding to the real server.</summary>
    internal sealed class MitmModifyAction : MitmAction
    {
        /// <summary>Replacement URL. Null = unchanged.</summary>
        public string ReplacementUrl { get; init; }

        /// <summary>Headers to set (add or overwrite).</summary>
        public Dictionary<string, string> SetHeaders { get; init; }

        /// <summary>Header names to remove.</summary>
        public string[] RemoveHeaders { get; init; }

        /// <summary>Replacement body content. Null = unchanged.</summary>
        public string ReplacementBody { get; init; }
    }

    /// <summary>Matches but does nothing — used to silence broader rules for specific URLs.</summary>
    internal sealed class MitmPassthroughAction : MitmAction { }

    // ──────────────────────────────────────────────
    // MitmRuleRuntime — Mutable counters (sibling to immutable MitmRule)
    // ──────────────────────────────────────────────

    /// <summary>
    /// Runtime mutable state for a rule. Separated from <see cref="MitmRule"/>
    /// so the immutable snapshot is never mutated. All mutations use <see cref="Interlocked"/>.
    /// </summary>
    internal sealed class MitmRuleRuntime
    {
        /// <summary>Number of times this rule has fired. Incremented atomically.</summary>
        public long FireCount;

        /// <summary>Last time this rule fired (best-effort, not synchronized).</summary>
        public DateTimeOffset? LastFiredAtUtc;

        /// <summary>Atomically increment fire count and stamp last-fired time.</summary>
        public void RecordFiring()
        {
            Interlocked.Increment(ref FireCount);
            LastFiredAtUtc = DateTimeOffset.UtcNow;
        }
    }
}
