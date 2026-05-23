// <copyright file="EdogQaModels.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Text.Json.Serialization;

    // ──────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────

    /// <summary>
    /// Classification category for a QA scenario.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ScenarioCategory
    {
        HappyPath,
        ErrorPath,
        EdgeCase,
        Regression,
        Performance
    }

    /// <summary>
    /// Lifecycle state of a scenario from generation through archival.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ScenarioLifecycle
    {
        Generated,
        Curated,
        Queued,
        Executing,
        Completed,
        Failed,
        TimedOut,
        Archived,
        Deleted
    }

    /// <summary>
    /// Test-design technique used to derive a scenario. Surfaced explicitly
    /// (F27 "pinnacle" item 3) so the linter can verify each invariant kind
    /// gets the appropriate technique, and the UI can show a coverage badge.
    ///
    /// <para>Maps to the TECHNIQUES table in <c>EdogQaLlmProvider</c>:</para>
    /// <list type="bullet">
    ///   <item><c>BoundaryTriplet</c> — three scenarios at-below/at/at-above a numeric or temporal threshold.</item>
    ///   <item><c>Counterfactual</c> — exercise removed parameters or
    ///     reverted code paths to confirm behavior change.</item>
    ///   <item><c>TruthTable</c> — exhaustive 2^N grid over N optional parameters.</item>
    ///   <item><c>EquivalencePartition</c> — one representative per input partition.</item>
    ///   <item><c>ErrorPath</c> — explicit throw-site or 4xx/5xx coverage.</item>
    ///   <item><c>RegressionGuard</c> — anchor for previously-broken behavior.</item>
    ///   <item><c>HappyPath</c> — canonical success case.</item>
    ///   <item><c>NotSpecified</c> — schema default; linter flags as <c>LNT003_TechniqueRequired</c>.</item>
    /// </list>
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ScenarioTechnique
    {
        NotSpecified,
        BoundaryTriplet,
        Counterfactual,
        TruthTable,
        EquivalencePartition,
        ErrorPath,
        RegressionGuard,
        HappyPath
    }

    /// <summary>
    /// Type of stimulus that triggers the system under test.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum StimulusType
    {
        HttpRequest,
        SignalRBroadcast,
        DagTrigger,
        FileEvent,
        TimerTick,
        DiInvocation
    }

    /// <summary>
    /// Type of setup step executed before a scenario stimulus.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum SetupStepType
    {
        ChaosRule,
        FlagOverride,
        StateSeed,
        Wait
    }

    /// <summary>
    /// Type of teardown step executed after scenario evaluation.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum TeardownStepType
    {
        RemoveChaosRule,
        RestoreFlag,
        CleanupState
    }

    /// <summary>
    /// Classification of expectation evaluated against captured events.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ExpectationType
    {
        EventPresent,
        EventAbsent,
        EventCount,
        EventOrder,
        Timing,
        FieldMatch
    }

    /// <summary>
    /// Overall verdict for a completed scenario execution.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ScenarioVerdict
    {
        Passed,
        Failed,
        Partial,
        TimedOut,
        Crashed,
        Skipped,
        Stale,
        Inconclusive
    }

    /// <summary>
    /// Outcome status of a single expectation evaluation.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ExpectationStatus
    {
        Passed,
        Failed,
        Unmatched,
        Skipped
    }

    /// <summary>
    /// Phases of the 8-phase execution loop state machine.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ExecutionPhase
    {
        Isolate,
        Setup,
        Mark,
        Stimulate,
        Capture,
        Evaluate,
        Teardown,
        Report
    }

    /// <summary>
    /// Assertion type for a matcher in the contract vocabulary.
    /// Replaces the legacy ExpectationType with a 7-type vocabulary.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum MatcherAssertion
    {
        Equals,
        NotEquals,
        Exists,
        InRange,
        ContainsAll,
        OneOf,
        Length
    }

    /// <summary>
    /// Abstract base for typed matcher values in the contract vocabulary.
    /// </summary>
    public abstract class MatcherValue
    {
        public string Type { get; set; }
    }

    /// <summary>
    /// Scalar matcher value (string, number, boolean).
    /// </summary>
    public sealed class ScalarMatcherValue : MatcherValue
    {
        public object Value { get; set; }
    }

    /// <summary>
    /// Range matcher value with min/max bounds.
    /// </summary>
    public sealed class RangeMatcherValue : MatcherValue
    {
        public double? Min { get; set; }
        public double? Max { get; set; }
        public bool MinInclusive { get; set; } = true;
        public bool MaxInclusive { get; set; } = true;
    }

    /// <summary>
    /// Array matcher value for containsAll/oneOf assertions.
    /// </summary>
    public sealed class ArrayMatcherValue : MatcherValue
    {
        public List<object> Items { get; set; } = new();
    }

    /// <summary>
    /// Boolean matcher value for exists assertions.
    /// </summary>
    public sealed class BooleanMatcherValue : MatcherValue
    {
        public bool Expected { get; set; }
    }

    /// <summary>
    /// Length matcher value for length assertions.
    /// </summary>
    public sealed class LengthMatcherValue : MatcherValue
    {
        public int? Min { get; set; }
        public int? Max { get; set; }
    }

    /// <summary>
    /// A single matcher in the contract vocabulary.
    /// </summary>
    public sealed class Matcher
    {
        public string TopicField { get; set; }
        public MatcherAssertion Assertion { get; set; }
        public MatcherValue Value { get; set; }
    }

    /// <summary>
    /// Per-scenario catalog hash envelope for staleness detection.
    /// </summary>
    public sealed class CatalogHashes
    {
        public string StimulusSlotHash { get; set; }
        public Dictionary<string, string> MatcherTopicHashes { get; set; } = new();
        public string CatalogSnapshotId { get; set; }
    }

    // ──────────────────────────────────────────────
    // Scenario Model
    // ──────────────────────────────────────────────

    /// <summary>
    /// Root scenario object. Contract between C01 (generator), C02 (curation),
    /// C03 (execution), C04 (assertion), and C06 (frontend).
    /// Pattern: scn-{slug}-{4-char-hash}, e.g. "scn-write-file-correct-path-a1b2"
    /// </summary>
    public sealed class Scenario
    {
        /// <summary>Unique scenario identifier, e.g. "scn-write-file-correct-path-a1b2".</summary>
        public string Id { get; set; }

        /// <summary>Human-readable title (max 120 chars).</summary>
        public string Title { get; set; }

        /// <summary>Detailed description (max 500 chars).</summary>
        public string Description { get; set; }

        /// <summary>Scenario classification category.</summary>
        public ScenarioCategory Category { get; set; }

        /// <summary>Priority: 1=critical, 5=nice-to-have.</summary>
        public int Priority { get; set; }

        /// <summary>Back-reference to Roslyn impact zone, e.g. "zone-001".</summary>
        public string ImpactZone { get; set; }

        /// <summary>Current lifecycle state.</summary>
        public ScenarioLifecycle Lifecycle { get; set; }

        /// <summary>Ordered setup steps executed before stimulus.</summary>
        public List<SetupStep> Setup { get; set; } = new();

        /// <summary>The stimulus that triggers the system under test.</summary>
        public Stimulus Stimulus { get; set; }

        /// <summary>Expectations evaluated against captured events.</summary>
        public List<Expectation> Expectations { get; set; } = new();

        /// <summary>Contract matchers replacing legacy expectations.</summary>
        public List<Matcher> Matchers { get; set; } = new();

        /// <summary>Ordered teardown steps executed after evaluation.</summary>
        public List<TeardownStep> Teardown { get; set; } = new();

        /// <summary>Execution timeout in milliseconds. Default 30s, min 1000, max 60000.</summary>
        public int TimeoutMs { get; set; } = 30_000;

        /// <summary>Catalog hashes for staleness detection.</summary>
        public CatalogHashes CatalogHashes { get; set; }

        /// <summary>Scenario metadata (generation info, tags, schema version).</summary>
        public ScenarioMetadata Metadata { get; set; } = new();

        /// <summary>
        /// Test-design technique used to derive this scenario (F27 item 3).
        /// MUST be set to a non-<see cref="ScenarioTechnique.NotSpecified"/>
        /// value or the linter raises <c>LNT003_TechniqueRequired</c>.
        /// </summary>
        public ScenarioTechnique Technique { get; set; } = ScenarioTechnique.NotSpecified;

        /// <summary>
        /// IDs of <c>CodeInvariant</c>s (from <see cref="EdogQaInvariantExtractor"/>)
        /// this scenario addresses (F27 item 3). At least one entry is required
        /// when the analyzer detected invariants; the linter raises
        /// <c>LNT002_InvariantCoverage</c> otherwise. Empty is allowed only when
        /// the diff produced no invariants (e.g. comment-only changes).
        /// </summary>
        public List<string> InvariantsAddressed { get; set; } = new();

        /// <summary>
        /// Evidence anchoring this scenario to the diff (F27 item 6). The LLM
        /// must populate at least one entry so reviewers can verify each
        /// scenario corresponds to a real code change. Empty raises
        /// <c>LNT004_GroundingEvidenceMissing</c>.
        /// </summary>
        public List<GroundingEvidence> GroundingEvidence { get; set; } = new();

        /// <summary>
        /// F27 P11: Architect-emitted codePath IDs (cp-*) this scenario addresses.
        /// Copied from the source ScenarioSketch by the orchestrator after
        /// validation. Empty when P11 is disabled or no paths apply.
        /// </summary>
        public List<string> AddressesCodePathIds { get; set; } = new();

        /// <summary>
        /// F27 P11: Architect-emitted errorMode IDs (em-*) this scenario addresses.
        /// Copied from the source ScenarioSketch by the orchestrator after
        /// validation. Empty when P11 is disabled or no error modes apply.
        /// </summary>
        public List<string> AddressesErrorModeIds { get; set; } = new();

        /// <summary>
        /// First-class feature-flag overrides this scenario depends on. The
        /// projector translates each entry into either an
        /// <c>X-Feature-Flag-Override</c> header on the HTTP stimulus or a
        /// <see cref="SetupStepType.FlagOverride"/> setup step on a
        /// DiInvocation stimulus, so the flag state is mechanically enforced
        /// in the run — not just described in the scenario title. Empty when
        /// the scenario does not depend on a specific flag value.
        /// </summary>
        public List<FlagOverride> FeatureFlagOverrides { get; set; } = new();
    }

    /// <summary>
    /// Declarative feature-flag override carried on a <see cref="Scenario"/>.
    /// The projector consumes these and renders them into the concrete
    /// override mechanism for the stimulus type (HTTP header or setup step).
    /// </summary>
    public sealed class FlagOverride
    {
        /// <summary>Name of the feature flag to override.</summary>
        public string FlagName { get; set; }

        /// <summary>Override value, encoded as a string so the LLM can emit "true"/"false" or richer literals without committing to a primitive type at the schema layer.</summary>
        public string Value { get; set; }
    }

    /// <summary>
    /// Metadata about scenario provenance and curation state.
    /// </summary>
    public sealed class ScenarioMetadata
    {
        /// <summary>How the scenario was created: "ai", "manual", "template".</summary>
        public string GeneratedBy { get; set; }

        /// <summary>AI confidence score [0.0, 1.0].</summary>
        public double Confidence { get; set; }

        /// <summary>PR files related to this scenario.</summary>
        public List<string> RelatedPRFiles { get; set; } = new();

        /// <summary>User-defined tags for filtering.</summary>
        public List<string> Tags { get; set; } = new();

        /// <summary>Schema version for forward compatibility. v2 added
        /// the F27 pinnacle fields: Technique, InvariantsAddressed, and
        /// GroundingEvidence on <see cref="Scenario"/>.</summary>
        public int SchemaVersion { get; set; } = 2;

        /// <summary>UTC timestamp when the scenario was generated.</summary>
        public DateTimeOffset GeneratedAt { get; set; }

        /// <summary>User who curated/approved the scenario, null if auto-approved.</summary>
        public string CuratedBy { get; set; }

        /// <summary>UTC timestamp when the scenario was curated.</summary>
        public DateTimeOffset? CuratedAt { get; set; }
    }

    /// <summary>
    /// A single anchoring point connecting a scenario to a specific span of
    /// the diff under test (F27 "pinnacle" item 6). Reviewers use this to
    /// confirm each generated scenario corresponds to a real code change,
    /// rather than being a plausible-sounding hallucination.
    ///
    /// <para>The LLM is required to emit at least one <see cref="GroundingEvidence"/>
    /// per scenario, citing the file and line range that motivates the test
    /// case. The linter rule <c>LNT004_GroundingEvidenceMissing</c> rejects
    /// scenarios with an empty list.</para>
    /// </summary>
    public sealed class GroundingEvidence
    {
        /// <summary>Repository-relative file path from the diff (e.g. <c>Service/.../LiveTableInsightsController.cs</c>).</summary>
        public string File { get; set; }

        /// <summary>First changed line in the file. Inclusive.</summary>
        public int StartLine { get; set; }

        /// <summary>Last changed line in the file. Inclusive. Same as <see cref="StartLine"/> for single-line citations.</summary>
        public int EndLine { get; set; }

        /// <summary>
        /// Short human-readable reason this slice motivates the scenario,
        /// e.g. "MaxStrictDateRangeDays constant introduces a 60-day cap".
        /// Max 240 chars.
        /// </summary>
        public string Reason { get; set; }

        /// <summary>
        /// Optional invariant ID this evidence anchors to. When set, it must
        /// match an entry in <see cref="Scenario.InvariantsAddressed"/> —
        /// the linter cross-checks consistency under <c>LNT008_EvidenceConsistency</c>.
        /// </summary>
        public string InvariantId { get; set; }

        /// <summary>
        /// Generation-time identifier of the Architect-emitted evidence record
        /// that produced this engine <see cref="GroundingEvidence"/> entry
        /// (F27 P9 §3.3, "evidence audit trail"). Set by
        /// <c>EdogQaScenarioProjector</c> when the V2 pipeline is on/shadow;
        /// null for legacy-bridge scenarios. Carrying the original
        /// <c>evidenceId</c> forward lets the curation UI render the audit
        /// path (Editor → Architect plan → this engine record) and lets the
        /// eval harness reconcile V2 output against the Architect plan log.
        /// </summary>
        public string SourceEvidenceId { get; set; }
    }

    // ──────────────────────────────────────────────
    // Setup / Teardown
    // ──────────────────────────────────────────────

    /// <summary>
    /// A single setup step. Exactly one of the spec properties is non-null,
    /// determined by <see cref="Type"/>.
    /// </summary>
    public sealed class SetupStep
    {
        /// <summary>Step type discriminator.</summary>
        public SetupStepType Type { get; set; }

        /// <summary>Chaos fault injection spec (when Type = ChaosRule).</summary>
        public ChaosRuleSpec ChaosRule { get; set; }

        /// <summary>Feature flag override spec (when Type = FlagOverride).</summary>
        public FlagOverrideSpec FlagOverride { get; set; }

        /// <summary>State seeding spec (when Type = StateSeed).</summary>
        public StateSeedSpec StateSeed { get; set; }

        /// <summary>Wait/delay spec (when Type = Wait).</summary>
        public WaitSpec Wait { get; set; }
    }

    /// <summary>
    /// Chaos fault injection configuration.
    /// </summary>
    public sealed class ChaosRuleSpec
    {
        /// <summary>URL pattern or service name to target.</summary>
        public string Target { get; set; }

        /// <summary>Fault type: "http_error", "latency", "timeout", "partial_response".</summary>
        public string Fault { get; set; }

        /// <summary>Fault-specific parameters (e.g. status code, delay ms).</summary>
        public Dictionary<string, object> Parameters { get; set; } = new();
    }

    /// <summary>
    /// Feature flag override for test isolation.
    /// </summary>
    public sealed class FlagOverrideSpec
    {
        /// <summary>Name of the feature flag to override.</summary>
        public string FlagName { get; set; }

        /// <summary>Override value.</summary>
        public bool Value { get; set; }
    }

    /// <summary>
    /// State seeding via HTTP request to pre-populate system state.
    /// </summary>
    public sealed class StateSeedSpec
    {
        /// <summary>HTTP method (GET, POST, PUT, etc.).</summary>
        public string Method { get; set; }

        /// <summary>Request URL.</summary>
        public string Url { get; set; }

        /// <summary>Request body payload.</summary>
        public object Body { get; set; }
    }

    /// <summary>
    /// Simple delay step for timing-sensitive setup.
    /// </summary>
    public sealed class WaitSpec
    {
        /// <summary>Duration to wait in milliseconds.</summary>
        public int DurationMs { get; set; }
    }

    /// <summary>
    /// A single teardown step executed after scenario evaluation.
    /// </summary>
    public sealed class TeardownStep
    {
        /// <summary>Teardown step type discriminator.</summary>
        public TeardownStepType Type { get; set; }
    }

    // ──────────────────────────────────────────────
    // Stimulus
    // ──────────────────────────────────────────────

    /// <summary>
    /// Stimulus definition. Exactly one spec property is non-null,
    /// determined by <see cref="Type"/>.
    /// </summary>
    public sealed class Stimulus
    {
        /// <summary>Stimulus type discriminator.</summary>
        public StimulusType Type { get; set; }

        /// <summary>HTTP request spec (when Type = HttpRequest).</summary>
        public HttpRequestSpec HttpRequest { get; set; }

        /// <summary>SignalR broadcast spec (when Type = SignalRBroadcast).</summary>
        public SignalRBroadcastSpec SignalRBroadcast { get; set; }

        /// <summary>DAG trigger spec (when Type = DagTrigger).</summary>
        public DagTriggerSpec DagTrigger { get; set; }

        /// <summary>File event spec (when Type = FileEvent).</summary>
        public FileEventSpec FileEvent { get; set; }

        /// <summary>Timer tick spec (when Type = TimerTick).</summary>
        public TimerTickSpec TimerTick { get; set; }

        /// <summary>DI service invocation spec (when Type = DiInvocation).</summary>
        public DiInvocationSpec DiInvocation { get; set; }
    }

    /// <summary>
    /// HTTP request stimulus configuration.
    /// </summary>
    public sealed class HttpRequestSpec
    {
        /// <summary>HTTP method. Defaults to GET.</summary>
        public string Method { get; set; } = "GET";

        /// <summary>Request path relative to FLT Kestrel.</summary>
        public string Path { get; set; }

        /// <summary>Additional HTTP headers.</summary>
        public Dictionary<string, string> Headers { get; set; } = new();

        /// <summary>Request body payload.</summary>
        public object Body { get; set; }

        /// <summary>Content type header. Defaults to application/json.</summary>
        public string ContentType { get; set; } = "application/json";
    }

    /// <summary>
    /// SignalR broadcast stimulus configuration.
    /// </summary>
    public sealed class SignalRBroadcastSpec
    {
        /// <summary>Target hub name.</summary>
        public string Hub { get; set; }

        /// <summary>Hub method to invoke.</summary>
        public string Method { get; set; }

        /// <summary>Method arguments.</summary>
        public List<object> Args { get; set; } = new();

        /// <summary>Target connection ID, null for broadcast.</summary>
        public string ConnectionId { get; set; }
    }

    /// <summary>
    /// DAG trigger stimulus configuration.
    /// </summary>
    public sealed class DagTriggerSpec
    {
        /// <summary>Iteration ID ("current" resolves at runtime).</summary>
        public string IterationId { get; set; }

        /// <summary>Node filter, null for full DAG execution.</summary>
        public List<string> NodeFilter { get; set; }
    }

    /// <summary>
    /// File event stimulus configuration.
    /// </summary>
    public sealed class FileEventSpec
    {
        /// <summary>OneLake watched path.</summary>
        public string Path { get; set; }

        /// <summary>File content (string or base64).</summary>
        public string Content { get; set; }

        /// <summary>Content encoding: "utf8" or "base64".</summary>
        public string Encoding { get; set; } = "utf8";

        /// <summary>Whether to delete the file in teardown.</summary>
        public bool Cleanup { get; set; } = true;
    }

    /// <summary>
    /// Timer tick stimulus configuration.
    /// </summary>
    public sealed class TimerTickSpec
    {
        /// <summary>Tick source name, e.g. "EvictionManager", "CacheRefresh".</summary>
        public string TickSource { get; set; }

        /// <summary>Topic to watch for tick event.</summary>
        public string Topic { get; set; } = "perf";

        /// <summary>Maximum time to wait for tick in milliseconds.</summary>
        public int MaxWaitMs { get; set; } = 10_000;
    }

    /// <summary>
    /// DI service invocation stimulus configuration.
    /// </summary>
    public sealed class DiInvocationSpec
    {
        /// <summary>DI service interface type name, e.g. "IOneLakeWriter".</summary>
        public string ServiceType { get; set; }

        /// <summary>Method name to invoke, e.g. "WriteFileAsync".</summary>
        public string Method { get; set; }

        /// <summary>Method arguments.</summary>
        public List<object> Args { get; set; } = new();
    }

    // ──────────────────────────────────────────────
    // Expectations
    // ──────────────────────────────────────────────

    /// <summary>
    /// Single expectation evaluated by C04 AssertionEngine against captured TopicEvents.
    /// All predicates within a Matcher use AND logic.
    /// </summary>
    public sealed class Expectation
    {
        /// <summary>Expectation identifier, e.g. "exp-1".</summary>
        public string Id { get; set; }

        /// <summary>Expectation type classification.</summary>
        public ExpectationType Type { get; set; }

        /// <summary>Topic to match against: "http", "retry", "cache", "log", etc.</summary>
        public string Topic { get; set; }

        /// <summary>Field-level matching criteria (AND logic). [LEGACY]</summary>
        public LegacyMatcher Matcher { get; set; }

        /// <summary>Optional time window constraints relative to T0.</summary>
        public TimeWindowSpec TimeWindow { get; set; }

        /// <summary>Optional event count constraints.</summary>
        public CountSpec Count { get; set; }

        /// <summary>Optional ordering constraints relative to other expectations.</summary>
        public OrderSpec Order { get; set; }

        /// <summary>Human-readable description of what this expectation verifies.</summary>
        public string Description { get; set; }
    }

    /// <summary>
    /// [LEGACY] Field-level matcher with multiple predicate types. Kept for
    /// backward compatibility with pre-P10 expectation payloads.
    /// </summary>
    public sealed class LegacyMatcher
    {
        /// <summary>Field→value pairs requiring exact equality. Case-sensitive.</summary>
        public Dictionary<string, object> Exact { get; set; }

        /// <summary>Field→substring pairs. Case-insensitive.</summary>
        public Dictionary<string, string> Contains { get; set; }

        /// <summary>Field→regex pairs.</summary>
        public Dictionary<string, string> Regex { get; set; }

        /// <summary>Field→{min?,max?} numeric range pairs.</summary>
        public Dictionary<string, RangeBounds> Range { get; set; }

        /// <summary>Fields that must be present and non-null.</summary>
        public List<string> Exists { get; set; }
    }

    /// <summary>
    /// Numeric range bounds for matcher range predicates.
    /// </summary>
    public sealed class RangeBounds
    {
        /// <summary>Minimum value, null if unbounded below.</summary>
        public double? Min { get; set; }

        /// <summary>Maximum value, null if unbounded above.</summary>
        public double? Max { get; set; }

        /// <summary>Whether <see cref="Min"/> is inclusive. Defaults to true.</summary>
        public bool MinInclusive { get; set; } = true;

        /// <summary>Whether <see cref="Max"/> is inclusive. Defaults to true.</summary>
        public bool MaxInclusive { get; set; } = true;
    }

    /// <summary>
    /// Time window constraints relative to scenario T0 (stimulus start).
    /// </summary>
    public sealed class TimeWindowSpec
    {
        /// <summary>Event must appear within N ms of T0.</summary>
        public int? WithinMs { get; set; }

        /// <summary>Event must appear at least N ms after T0.</summary>
        public int? AfterMs { get; set; }
    }

    /// <summary>
    /// Event count constraints for EventCount expectations.
    /// </summary>
    public sealed class CountSpec
    {
        /// <summary>Minimum number of matching events.</summary>
        public int? Min { get; set; }

        /// <summary>Maximum number of matching events.</summary>
        public int? Max { get; set; }

        /// <summary>Exact number of matching events required.</summary>
        public int? Exact { get; set; }
    }

    /// <summary>
    /// Ordering constraint for EventOrder expectations.
    /// </summary>
    public sealed class OrderSpec
    {
        /// <summary>This expectation's match must appear after the specified expectation ID.</summary>
        public string After { get; set; }
    }

    // ──────────────────────────────────────────────
    // Execution Results
    // ──────────────────────────────────────────────

    /// <summary>
    /// Result of dispatching a stimulus to the system under test.
    /// </summary>
    public sealed class StimulusResult
    {
        /// <summary>Whether the stimulus was dispatched successfully.</summary>
        public bool Success { get; set; }

        /// <summary>HTTP status code if applicable, null otherwise.</summary>
        public int? StatusCode { get; set; }

        /// <summary>Stimulus execution duration in milliseconds.</summary>
        public long DurationMs { get; set; }

        /// <summary>Truncated response body (4KB max).</summary>
        public string ResponsePreview { get; set; }

        /// <summary>Non-null on transport failure.</summary>
        public string Error { get; set; }

        /// <summary>Stimulus-type-specific metadata.</summary>
        public object Metadata { get; set; }
    }

    /// <summary>
    /// Per-expectation evaluation result.
    /// </summary>
    public sealed class ExpectationResult
    {
        /// <summary>Back-reference to the expectation ID.</summary>
        public string ExpectationId { get; set; }

        /// <summary>Human-readable expectation description.</summary>
        public string Description { get; set; }

        /// <summary>Evaluation outcome.</summary>
        public ExpectationStatus Status { get; set; }

        /// <summary>The TopicEvent that matched, null if Unmatched.</summary>
        public TopicEvent MatchedEvent { get; set; }

        /// <summary>Best-effort near-match for failures (closest miss).</summary>
        public TopicEvent ClosestMiss { get; set; }

        /// <summary>Failure reason, e.g. "Expected HTTP 201, observed HTTP 500".</summary>
        public string FailureReason { get; set; }

        /// <summary>Time from T0 to match in milliseconds.</summary>
        public long MatchLatencyMs { get; set; }
    }

    /// <summary>
    /// Per-scenario execution result.
    /// </summary>
    public sealed class ScenarioResult
    {
        /// <summary>Back-reference to the scenario ID.</summary>
        public string ScenarioId { get; set; }

        /// <summary>Scenario title for display.</summary>
        public string Title { get; set; }

        /// <summary>Scenario category as string.</summary>
        public string Category { get; set; }

        /// <summary>Overall scenario verdict.</summary>
        public ScenarioVerdict Verdict { get; set; }

        /// <summary>Total execution duration in milliseconds.</summary>
        public long DurationMs { get; set; }

        /// <summary>UTC timestamp when execution started.</summary>
        public DateTimeOffset StartedAt { get; set; }

        /// <summary>UTC timestamp when execution completed.</summary>
        public DateTimeOffset CompletedAt { get; set; }

        /// <summary>Per-expectation results.</summary>
        public List<ExpectationResult> Expectations { get; set; } = new();

        /// <summary>All TopicEvents captured during the recording window.</summary>
        public List<TopicEvent> CapturedEvents { get; set; } = new();

        /// <summary>Non-null only for Crashed/Skipped verdicts.</summary>
        public string ErrorMessage { get; set; }

        /// <summary>Number of events captured during the recording window.</summary>
        public int EventsCaptured { get; set; }

        /// <summary>Execution phase where a crash occurred.</summary>
        public ExecutionPhase FailedAtPhase { get; set; }
    }

    /// <summary>
    /// Aggregated run result containing all scenario outcomes.
    /// </summary>
    public sealed class RunResult
    {
        /// <summary>Run identifier, e.g. "run-20250615-143022".</summary>
        public string RunId { get; set; }

        /// <summary>Associated pull request ID.</summary>
        public int PrId { get; set; }

        /// <summary>Pull request title.</summary>
        public string PrTitle { get; set; }

        /// <summary>Pull request URL.</summary>
        public string PrUrl { get; set; }

        /// <summary>UTC timestamp when the run started.</summary>
        public DateTimeOffset StartedAt { get; set; }

        /// <summary>UTC timestamp when the run completed.</summary>
        public DateTimeOffset CompletedAt { get; set; }

        /// <summary>Total run duration in milliseconds.</summary>
        public long TotalDurationMs { get; set; }

        /// <summary>Aggregated pass/fail/skip counts.</summary>
        public RunSummary Summary { get; set; } = new();

        /// <summary>Per-scenario results.</summary>
        public List<ScenarioResult> Scenarios { get; set; } = new();

        /// <summary>Code paths that could not be observed (no interceptor coverage).</summary>
        public List<string> UnobservablePaths { get; set; } = new();

        /// <summary>Execution performance metrics.</summary>
        public PerformanceReport Performance { get; set; } = new();
    }

    /// <summary>
    /// Aggregated scenario verdict counts for a run.
    /// </summary>
    public sealed class RunSummary
    {
        /// <summary>Total number of scenarios in the run.</summary>
        public int Total { get; set; }

        /// <summary>Number of passed scenarios.</summary>
        public int Passed { get; set; }

        /// <summary>Number of failed scenarios.</summary>
        public int Failed { get; set; }

        /// <summary>Number of timed-out scenarios.</summary>
        public int TimedOut { get; set; }

        /// <summary>Number of partially-passed scenarios.</summary>
        public int Partial { get; set; }

        /// <summary>Number of crashed scenarios.</summary>
        public int Crashed { get; set; }

        /// <summary>Number of skipped scenarios.</summary>
        public int Skipped { get; set; }

        /// <summary>
        /// True only if every submitted scenario passed cleanly. A run with
        /// any Failed/Partial/Crashed/TimedOut/Skipped scenarios — or a zero-
        /// scenario "did nothing" run — is NOT a pass. F27 P8 tightened this
        /// from the old "Failed==0 && Crashed==0" definition that made the
        /// honesty-gate skip path falsely report green.
        /// </summary>
        public bool OverallPass => Total > 0 && Passed == Total;
    }

    /// <summary>
    /// Performance metrics for a completed run.
    /// </summary>
    public sealed class PerformanceReport
    {
        /// <summary>Duration of the slowest scenario in milliseconds.</summary>
        public long SlowestScenarioMs { get; set; }

        /// <summary>ID of the slowest scenario.</summary>
        public string SlowestScenarioId { get; set; }

        /// <summary>Average scenario duration in milliseconds.</summary>
        public long AverageScenarioMs { get; set; }

        /// <summary>Total execution time across all scenarios in milliseconds.</summary>
        public long TotalExecutionMs { get; set; }

        /// <summary>Overhead time (setup/teardown) in milliseconds.</summary>
        public long OverheadMs { get; set; }
    }

    // ──────────────────────────────────────────────
    // Code Understanding Models
    // ──────────────────────────────────────────────

    /// <summary>
    /// Impact zone identified by Roslyn code analysis. Groups a primary change
    /// with its affected callers, interfaces, and entry points.
    /// </summary>
    public sealed class ImpactZone
    {
        /// <summary>Unique zone identifier, e.g. "zone-001".</summary>
        public string ZoneId { get; set; }

        /// <summary>The primary code change that defines this zone.</summary>
        public ChangedSymbol PrimaryChange { get; set; }

        /// <summary>Methods that call into the changed code.</summary>
        public List<AffectedCaller> AffectedCallers { get; set; } = new();

        /// <summary>Interfaces implemented by or depending on the changed code.</summary>
        public List<string> AffectedInterfaces { get; set; } = new();

        /// <summary>DI registrations affected by the change.</summary>
        public List<string> DiRegistrations { get; set; } = new();

        /// <summary>Existing tests related to this zone.</summary>
        public List<string> RelatedTests { get; set; } = new();

        /// <summary>EDOG interceptor topics relevant to this zone.</summary>
        public List<string> InterceptorTopics { get; set; } = new();

        /// <summary>Graphify Louvain community name.</summary>
        public string Community { get; set; }

        /// <summary>Entry points reachable from external stimuli.</summary>
        public List<EntryPoint> EntryPoints { get; set; } = new();
    }

    /// <summary>
    /// A symbol (method/class) that was changed in the PR diff.
    /// </summary>
    public sealed class ChangedSymbol
    {
        /// <summary>File path containing the change.</summary>
        public string File { get; set; }

        /// <summary>Method or member name that changed.</summary>
        public string Method { get; set; }

        /// <summary>Type of change: "added", "modified", "deleted".</summary>
        public string ChangeType { get; set; }

        /// <summary>Line numbers that were modified.</summary>
        public List<int> LinesChanged { get; set; } = new();
    }

    /// <summary>
    /// A caller affected by a code change, with call-graph distance.
    /// </summary>
    public sealed class AffectedCaller
    {
        /// <summary>File path containing the caller.</summary>
        public string File { get; set; }

        /// <summary>Method name of the caller.</summary>
        public string Method { get; set; }

        /// <summary>Call-graph distance from the changed code.</summary>
        public int Depth { get; set; }

        /// <summary>Call site location, e.g. "line 89".</summary>
        public string CallSite { get; set; }
    }

    /// <summary>
    /// An external entry point reachable from a stimulus.
    /// </summary>
    public sealed class EntryPoint
    {
        /// <summary>Node identifier, e.g. "DagController.RunDAG".</summary>
        public string Node { get; set; }

        /// <summary>Type of stimulus that reaches this entry point.</summary>
        public StimulusType StimulusType { get; set; }

        /// <summary>Call-graph depth from entry to changed code.</summary>
        public int Depth { get; set; }

        /// <summary>Call path from entry point to changed code.</summary>
        public List<string> Path { get; set; } = new();

        /// <summary>Directness score: 1.0 / (depth + 1).</summary>
        public double DirectnessScore { get; set; }
    }

    /// <summary>
    /// Node in the code understanding graph (Graphify output).
    /// </summary>
    public sealed class GraphNode
    {
        /// <summary>Compound key: "file:method".</summary>
        public string Id { get; set; }

        /// <summary>Source file path.</summary>
        public string File { get; set; }

        /// <summary>Method or member name.</summary>
        public string Method { get; set; }

        /// <summary>Node type: "class", "method", "interface".</summary>
        public string NodeType { get; set; }

        /// <summary>Whether this node was changed in the PR diff.</summary>
        public bool IsChanged { get; set; }

        /// <summary>Graphify Louvain community assignment.</summary>
        public string Community { get; set; }

        /// <summary>Additional semantic data from Roslyn analysis.</summary>
        public Dictionary<string, string> SemanticData { get; set; } = new();
    }

    /// <summary>
    /// Edge in the code understanding graph (Graphify output).
    /// </summary>
    public sealed class GraphEdge
    {
        /// <summary>Source node ID.</summary>
        public string Source { get; set; }

        /// <summary>Target node ID.</summary>
        public string Target { get; set; }

        /// <summary>Edge type: "direct_call", "interface_dispatch", "field_ref", "override".</summary>
        public string EdgeType { get; set; }

        /// <summary>Analysis layer that added this edge: "l1", "l2", "l3", "l5".</summary>
        public string Source_ { get; set; }
    }

    // ──────────────────────────────────────────────
    // Crash Recovery State
    // ──────────────────────────────────────────────

    /// <summary>
    /// Persisted execution state for crash recovery. Written to disk after
    /// each scenario completes, enabling resumption on restart.
    /// </summary>
    public sealed class ExecutionState
    {
        /// <summary>Schema version for forward compatibility.</summary>
        public int Version { get; set; } = 1;

        /// <summary>Current run identifier.</summary>
        public string RunId { get; set; }

        /// <summary>UTC timestamp when the run started.</summary>
        public DateTimeOffset StartedAt { get; set; }

        /// <summary>Total number of scenarios in the run.</summary>
        public int TotalScenarios { get; set; }

        /// <summary>Scenarios that have already completed.</summary>
        public List<CompletedScenarioRef> CompletedScenarios { get; set; } = new();

        /// <summary>Scenario ID currently executing, null if between scenarios.</summary>
        public string CurrentScenario { get; set; }

        /// <summary>Current execution phase of the active scenario.</summary>
        public ExecutionPhase CurrentPhase { get; set; }

        /// <summary>Scenario IDs remaining to execute.</summary>
        public List<string> PendingScenarios { get; set; } = new();

        /// <summary>Path to the full scenarios JSON file on disk.</summary>
        public string ScenariosFilePath { get; set; }
    }

    /// <summary>
    /// Lightweight reference to a completed scenario for crash recovery state.
    /// </summary>
    public sealed class CompletedScenarioRef
    {
        /// <summary>Scenario ID.</summary>
        public string Id { get; set; }

        /// <summary>Result summary: "PASS", "FAIL", "TIMED_OUT".</summary>
        public string Result { get; set; }

        /// <summary>UTC timestamp when the scenario completed.</summary>
        public DateTimeOffset CompletedAt { get; set; }
    }
}
