// SPDX-License-Identifier: MIT
// F27 P9 T1c-a-2 — V2 → Engine DTO Projector.
//
// Bridges the LLM client's generation-only DTOs (which carry opaque
// `StimulusSpec` / `MatcherSpec` JSON strings) to the engine's typed
// `Scenario` shape that EdogQaExecutionEngine + downstream
// stations consume. This is the LAST station before scenarios are
// either curated, executed, or shadow-compared.
//
// Defense-in-depth: the Validator (T1c-a-1) treats the spec strings as
// opaque; the Projector OPENS them and enforces typed-shape invariants
// (e.g. HttpRequest needs Path; SignalRBroadcast needs Hub+Method; Matcher
// must have at least one of Exact/Contains/Regex/Range/Exists). Failures
// surface as QuarantineReason records using the same shape Validator
// uses, so the orchestrator can merge both lists into one report.
//
// All projection failures are bound to the scenario that produced them;
// the Projector does NOT throw. Same inputs ⇒ same output.

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text;
    using System.Text.Json;

    /// <summary>
    /// Pure static projection from LLM client's <c>GeneratedScenario</c>
    /// to engine <c>Scenario</c>. Consumes the Validator's
    /// AcceptedScenarios + the Architect plan; emits typed engine
    /// scenarios with the audit trail (<c>SourceEvidenceId</c>) forward-
    /// carried on each GroundingEvidence.
    /// </summary>
    internal static class EdogQaScenarioProjector
    {
        // ──────────────────────────────────────────────────────────────
        // Wire-stable failure codes. The orchestrator + UI inline-error
        // renderer read these by exact string match; renaming = breaking.
        // ──────────────────────────────────────────────────────────────

        public const string CodeStimulusSpecMalformed     = "PROJECTION_STIMULUS_SPEC_MALFORMED";
        public const string CodeStimulusSpecMissingField  = "PROJECTION_STIMULUS_SPEC_MISSING_FIELD";
        public const string CodeStimulusSpecFieldType     = "PROJECTION_STIMULUS_SPEC_FIELD_TYPE";
        public const string CodeMatcherSpecMalformed      = "PROJECTION_MATCHER_SPEC_MALFORMED";
        public const string CodeMatcherSpecEmpty          = "PROJECTION_MATCHER_SPEC_EMPTY";
        public const string CodeEnumParseFailed           = "PROJECTION_ENUM_PARSE_FAILED";
        public const string CodeGroundingRefUnresolved    = "PROJECTION_GROUNDING_REF_UNRESOLVED";

        // ──────────────────────────────────────────────────────────────
        // Output shape — reuses Validator's QuarantineReason +
        // QuarantinedScenario so the orchestrator can merge cleanly.
        // ──────────────────────────────────────────────────────────────

        public sealed class ProjectionResult
        {
            /// <summary>Engine-shape scenarios successfully projected.</summary>
            public List<Scenario> Projected { get; set; } = new();

            /// <summary>Scenarios whose payload could not be parsed into
            /// the engine's typed shape. Each carries the original
            /// GeneratedScenario + one or more QuarantineReasons.</summary>
            public List<EdogQaScenarioValidator.QuarantinedScenario> Rejected { get; set; } = new();

            /// <summary>Informational diagnostics emitted during projection
            /// (e.g. stimulus-spec stub fallbacks). NOT a rejection signal —
            /// the orchestrator forwards these to the browser console via
            /// the diagnostic-message channel so developers can see when
            /// scenarios were silently stubbed.</summary>
            public List<string> Diagnostics { get; set; } = new();
        }

        // ──────────────────────────────────────────────────────────────
        // Entry point.
        // ──────────────────────────────────────────────────────────────

        /// <summary>
        /// Project a batch of Validator-accepted scenarios to engine
        /// shape. Same inputs ⇒ same output. Never throws — parse
        /// failures surface as <see cref="ProjectionResult.Rejected"/>.
        /// </summary>
        /// <param name="plan">Architect plan. Used for grounding evidence
        /// pool lookups. Must be non-null.</param>
        /// <param name="accepted">Validator-accepted scenarios. May be
        /// empty; must not be null.</param>
        public static ProjectionResult Project(
            EdogQaLlmClient.ArchitectPlan plan,
            IReadOnlyList<EdogQaScenarioValidator.AcceptedScenario> accepted,
            CatalogSnapshot catalogSnapshot = null)
        {
            if (plan == null) throw new ArgumentNullException(nameof(plan));
            if (accepted == null) throw new ArgumentNullException(nameof(accepted));

            var evidenceById = (plan.GroundingEvidence ?? new())
                .Where(e => !string.IsNullOrWhiteSpace(e?.EvidenceId))
                .GroupBy(e => e.EvidenceId, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

            // F27 P11 / LNT009 fix: index the Architect's stimuliRequired by
            // st-N id so the projector can repair stub stimuli from the
            // Analyst's toolingHint when the Editor's stimulusSpec failed to
            // parse as JSON. This is defense-in-depth — the Editor SHOULD
            // populate a concrete stimulusSpec from the same stimuliRequired
            // entry, but a stub fallback that copies the shape across every
            // scenario is what produces the "all 20 scenarios share the same
            // HTTP stimulus" LNT009 symptom.
            var stimuliById = new Dictionary<string, EdogQaLlmClient.StimulusRequirement>(StringComparer.Ordinal);
            if (plan.TestingGuidance?.StimuliRequired != null)
            {
                foreach (var st in plan.TestingGuidance.StimuliRequired)
                {
                    if (st != null && !string.IsNullOrWhiteSpace(st.Id) && !stimuliById.ContainsKey(st.Id))
                    {
                        stimuliById[st.Id] = st;
                    }
                }
            }

            var result = new ProjectionResult();
            foreach (var acc in accepted)
            {
                var reasons = new List<EdogQaScenarioValidator.QuarantineReason>();
                var projected = ProjectOne(acc, evidenceById, stimuliById, reasons, result.Diagnostics);
                if (reasons.Count > 0)
                {
                    result.Rejected.Add(new EdogQaScenarioValidator.QuarantinedScenario
                    {
                        Scenario = acc.Scenario,
                        Reasons = reasons,
                    });
                }
                else
                {
                    // Fill catalogHashes deterministically from the runtime
                    // catalog snapshot AFTER the Editor produces scenarios.
                    // The Editor cannot compute SHA hashes; asking it to
                    // copy them out of the prompt produces matcherTopicHashes
                    // = [] and immediate GROUNDING_SLOT_MISMATCH quarantines.
                    // Doing it here is deterministic and unconditional —
                    // same plan + same accepted scenarios + same snapshot
                    // ⇒ same hashes on the output.
                    FillCatalogHashes(projected, catalogSnapshot);
                    result.Projected.Add(projected);
                }
            }

            return result;
        }

        // ──────────────────────────────────────────────────────────────
        // Catalog-hash filling. The Editor is no longer asked to produce
        // these; the projector fills them from the same CatalogSnapshot
        // the Architect/Editor saw in the CATALOG REFERENCES prompt block.
        // Same inputs ⇒ same hashes. No catalog ⇒ no fill (leave whatever
        // the Editor emitted, which is the empty shape per the prompt).
        // ──────────────────────────────────────────────────────────────

        private static void FillCatalogHashes(Scenario scenario, CatalogSnapshot snapshot)
        {
            if (scenario == null || snapshot == null)
            {
                return;
            }

            var hashes = scenario.CatalogHashes ?? new CatalogHashes();
            hashes.CatalogSnapshotId = snapshot.SnapshotId ?? string.Empty;
            hashes.StimulusSlotHash = hashes.StimulusSlotHash ?? string.Empty;
            hashes.MatcherTopicHashes = hashes.MatcherTopicHashes != null
                ? new Dictionary<string, string>(hashes.MatcherTopicHashes, StringComparer.Ordinal)
                : new Dictionary<string, string>(StringComparer.Ordinal);

            // Stimulus slot hash: match the scenario's typed stimulus
            // against catalog slots by kind + path/method. The catalog's
            // Purpose / SlotId carry the route info for HTTP slots;
            // non-HTTP stimuli match purely by kind when only one slot
            // of that kind exists. When no unique match is possible the
            // hash is left empty — validators handle empty as "ungrounded
            // for this dimension" rather than as a contradiction.
            if (scenario.Stimulus != null && snapshot.Slots != null && snapshot.Slots.Count > 0)
            {
                var stimKind = scenario.Stimulus.Type;
                var probe = ExtractStimulusProbe(scenario.Stimulus);

                QaContractSlot match = null;
                if (!string.IsNullOrEmpty(probe))
                {
                    foreach (var slot in snapshot.Slots)
                    {
                        if (slot == null) continue;
                        if (slot.Kind != stimKind) continue;
                        var purpose = slot.Purpose ?? string.Empty;
                        var slotId = slot.SlotId ?? string.Empty;
                        if (purpose.IndexOf(probe, StringComparison.OrdinalIgnoreCase) >= 0
                            || slotId.IndexOf(probe, StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            match = slot;
                            break;
                        }
                    }
                }

                if (match == null)
                {
                    QaContractSlot solo = null;
                    int kindCount = 0;
                    foreach (var slot in snapshot.Slots)
                    {
                        if (slot == null || slot.Kind != stimKind) continue;
                        kindCount++;
                        solo = slot;
                        if (kindCount > 1) { solo = null; break; }
                    }
                    if (solo != null) match = solo;
                }

                if (match != null && !string.IsNullOrEmpty(match.SlotHash))
                {
                    hashes.StimulusSlotHash = match.SlotHash;
                }
            }

            // Matcher topic hashes: every expectation's topic that appears
            // in the catalog's TopicFieldHashes is added. Missing topics
            // are silently skipped (validator's gate decides if missing
            // entries fail the scenario).
            if (snapshot.TopicFieldHashes != null
                && snapshot.TopicFieldHashes.Count > 0
                && scenario.Expectations != null)
            {
                foreach (var exp in scenario.Expectations)
                {
                    if (exp == null) continue;
                    var topic = exp.Topic;
                    if (string.IsNullOrEmpty(topic)) continue;
                    if (hashes.MatcherTopicHashes.ContainsKey(topic)) continue;
                    if (snapshot.TopicFieldHashes.TryGetValue(topic, out var hash)
                        && !string.IsNullOrEmpty(hash))
                    {
                        hashes.MatcherTopicHashes[topic] = hash;
                    }
                }
            }

            scenario.CatalogHashes = hashes;
        }

        private static string ExtractStimulusProbe(Stimulus stimulus)
        {
            if (stimulus == null) return null;
            if (stimulus.HttpRequest != null && !string.IsNullOrEmpty(stimulus.HttpRequest.Path))
            {
                return stimulus.HttpRequest.Path;
            }
            if (stimulus.SignalRBroadcast != null)
            {
                var hub = stimulus.SignalRBroadcast.Hub ?? string.Empty;
                var method = stimulus.SignalRBroadcast.Method ?? string.Empty;
                var combined = (hub + "/" + method).Trim('/');
                return combined.Length > 0 ? combined : null;
            }
            if (stimulus.DagTrigger != null)
            {
                if (stimulus.DagTrigger.NodeFilter != null && stimulus.DagTrigger.NodeFilter.Count > 0)
                {
                    return stimulus.DagTrigger.NodeFilter[0];
                }
                if (!string.IsNullOrEmpty(stimulus.DagTrigger.IterationId))
                {
                    return stimulus.DagTrigger.IterationId;
                }
            }
            if (stimulus.FileEvent != null && !string.IsNullOrEmpty(stimulus.FileEvent.Path))
            {
                return stimulus.FileEvent.Path;
            }
            if (stimulus.TimerTick != null && !string.IsNullOrEmpty(stimulus.TimerTick.TickSource))
            {
                return stimulus.TimerTick.TickSource;
            }
            if (stimulus.DiInvocation != null && !string.IsNullOrEmpty(stimulus.DiInvocation.ServiceType))
            {
                return stimulus.DiInvocation.ServiceType;
            }
            return null;
        }


        internal static Scenario ProjectTyped(Scenario source)
        {
            if (source == null)
            {
                return null;
            }

            return new Scenario
            {
                Id = source.Id,
                Title = source.Title,
                Description = source.Description,
                Category = source.Category,
                Priority = source.Priority,
                ImpactZone = source.ImpactZone,
                Lifecycle = source.Lifecycle,
                Setup = source.Setup != null ? new List<SetupStep>(source.Setup) : new List<SetupStep>(),
                Stimulus = CloneStimulus(source.Stimulus),
                Expectations = source.Expectations != null ? new List<Expectation>(source.Expectations) : new List<Expectation>(),
                Matchers = CloneMatchers(source.Matchers),
                Teardown = source.Teardown != null ? new List<TeardownStep>(source.Teardown) : new List<TeardownStep>(),
                TimeoutMs = source.TimeoutMs,
                CatalogHashes = CloneCatalogHashes(source.CatalogHashes),
                Metadata = CloneMetadata(source.Metadata),
                Technique = source.Technique,
                InvariantsAddressed = source.InvariantsAddressed != null
                    ? new List<string>(source.InvariantsAddressed)
                    : new List<string>(),
                GroundingEvidence = CloneGroundingEvidence(source.GroundingEvidence),
            };
        }

        // ──────────────────────────────────────────────────────────────
        // Per-scenario projection. Accumulates reasons into the provided
        // list; returns null if any reason was emitted.
        // ──────────────────────────────────────────────────────────────

        private static Scenario ProjectOne(
            EdogQaScenarioValidator.AcceptedScenario accepted,
            IReadOnlyDictionary<string, EdogQaLlmClient.ArchitectGroundingEvidence> evidenceById,
            IReadOnlyDictionary<string, EdogQaLlmClient.StimulusRequirement> stimuliById,
            List<EdogQaScenarioValidator.QuarantineReason> reasons,
            List<string> diagnostics)
        {
            var src = accepted.Scenario;

            // Enums — Validator should have already screened these, but we
            // re-check defensively so a missed gate doesn't turn into a
            // silent .NET ArgumentException at parse time.
            if (!Enum.TryParse<ScenarioCategory>(src.Category, true, out var category))
            {
                reasons.Add(MakeReason(CodeEnumParseFailed, "Category", null,
                    $"Category '{src.Category}' is not a valid ScenarioCategory enum value."));
                return null;
            }
            if (!Enum.TryParse<ScenarioTechnique>(src.Technique, true, out var technique))
            {
                reasons.Add(MakeReason(CodeEnumParseFailed, "Technique", null,
                    $"Technique '{src.Technique}' is not a valid ScenarioTechnique enum value."));
                return null;
            }
            if (!Enum.TryParse<StimulusType>(src.StimulusType, true, out var stimulusType))
            {
                reasons.Add(MakeReason(CodeEnumParseFailed, "StimulusType", null,
                    $"StimulusType '{src.StimulusType}' is not a valid StimulusType enum value."));
                return null;
            }

            // Stimulus payload — discriminated union, exactly one typed
            // payload non-null on the resulting Stimulus.
            // P10/P11: stimulusSpec may be descriptive text rather than JSON.
            // When it fails JSON parsing, build a minimal stub from stimulusType
            // so the scenario can still be projected and curated.
            var stimulus = new Stimulus { Type = stimulusType };
            using (var stimulusDoc = TryParseJson(src.StimulusSpec, out var stimulusParseFail))
            {
                if (stimulusParseFail != null)
                {
                    // StimulusSpec is not JSON — build a stub from stimulusType.
                    // The curator can fill in the concrete details. Log the
                    // degradation but don't reject the scenario.
                    var specSnippet = (src.StimulusSpec?.Length > 80 ? src.StimulusSpec.Substring(0, 80) + "..." : src.StimulusSpec ?? "(null)");
                    var diagMsg = $"Projector: stimulusSpec not JSON for '{src.Id}' — "
                        + $"building stub {stimulusType} stimulus. Spec was: " + specSnippet;
                    Console.WriteLine($"[QA-DIAG] {diagMsg}");
                    diagnostics?.Add(diagMsg);

                    // LNT009 defense-in-depth: if the scenario references a
                    // stimulusId from the Architect's stimuliRequired and that
                    // entry's toolingHint contains a JSON snippet describing
                    // the concrete shape, parse it and use those values to
                    // populate the stub. This stops every fallback scenario
                    // collapsing onto the same {GET /api/unknown} skeleton.
                    JsonElement? guidanceShape = null;
                    if (!string.IsNullOrWhiteSpace(src.StimulusId)
                        && stimuliById != null
                        && stimuliById.TryGetValue(src.StimulusId, out var stimReq)
                        && !string.IsNullOrWhiteSpace(stimReq?.ToolingHint))
                    {
                        using var hintDoc = TryParseJson(stimReq.ToolingHint, out var hintFail);
                        if (hintFail == null && hintDoc.RootElement.ValueKind == JsonValueKind.Object)
                        {
                            guidanceShape = hintDoc.RootElement.Clone();
                            diagnostics?.Add(
                                $"Projector: stimulusSpec stub for '{src.Id}' enriched from stimuliRequired '{src.StimulusId}'.");
                        }
                    }

                    switch (stimulusType)
                    {
                        case StimulusType.HttpRequest:
                            stimulus.HttpRequest = BuildHttpStubFromGuidance(guidanceShape);
                            break;
                        case StimulusType.SignalRBroadcast:
                            stimulus.SignalRBroadcast = BuildSignalRStubFromGuidance(guidanceShape);
                            break;
                        case StimulusType.DagTrigger:
                            stimulus.DagTrigger = BuildDagStubFromGuidance(guidanceShape);
                            break;
                        case StimulusType.FileEvent:
                            stimulus.FileEvent = BuildFileStubFromGuidance(guidanceShape);
                            break;
                        case StimulusType.TimerTick:
                            stimulus.TimerTick = BuildTimerStubFromGuidance(guidanceShape);
                            break;
                        case StimulusType.DiInvocation:
                            stimulus.DiInvocation = BuildDiStubFromGuidance(guidanceShape);
                            break;
                    }
                }
                else
                {
                    var root = stimulusDoc.RootElement;
                    switch (stimulusType)
                    {
                        case StimulusType.HttpRequest:
                            stimulus.HttpRequest = ProjectHttpRequest(root, reasons);
                            break;
                        case StimulusType.SignalRBroadcast:
                            stimulus.SignalRBroadcast = ProjectSignalRBroadcast(root, reasons);
                            break;
                        case StimulusType.DagTrigger:
                            stimulus.DagTrigger = ProjectDagTrigger(root, reasons);
                            break;
                        case StimulusType.FileEvent:
                            stimulus.FileEvent = ProjectFileEvent(root, reasons);
                            break;
                        case StimulusType.TimerTick:
                            stimulus.TimerTick = ProjectTimerTick(root, reasons);
                            break;
                        case StimulusType.DiInvocation:
                            stimulus.DiInvocation = ProjectDiInvocation(root, reasons);
                            break;
                    }
                }
            }

            if (reasons.Count > 0) return null;

            // Expectations — each carries its own MatcherSpec.
            // When the scenario has typed matchers[], the Editor emits
            // descriptive text (not JSON) in the legacy expectations[*].matcherSpec
            // field. Skip the JSON parse in that case — the typed matchers path
            // below handles matching. When typed matchers are absent (transition
            // period), parse matcherSpec as the legacy {exact, contains, regex,
            // range, exists} JSON object.
            var hasTypedMatchers = src.Matchers != null && src.Matchers.Count > 0;
            var expectations = new List<Expectation>();
            for (var i = 0; i < src.Expectations.Count; i++)
            {
                var expSrc = src.Expectations[i];
                if (!Enum.TryParse<ExpectationType>(expSrc.Type, true, out var expType))
                {
                    reasons.Add(MakeReason(CodeEnumParseFailed,
                        $"expectations[{i}].type", null,
                        $"Expectation type '{expSrc.Type}' is not a valid enum value."));
                    continue;
                }

                if (hasTypedMatchers)
                {
                    // Skip matcherSpec parsing. Build an internal LegacyMatcher
                    // from the typed matchers array by topic so the assertion
                    // engine can evaluate them.
                    var legacyMatcher = BuildLegacyMatcherFromTyped(src.Matchers, expSrc.Topic);
                    var vacuous = IsVacuous(legacyMatcher);
                    expectations.Add(new Expectation
                    {
                        Id = $"exp-{i + 1}",
                        Type = expType,
                        Topic = expSrc.Topic,
                        Matcher = vacuous ? null : legacyMatcher,
                        Description = expSrc.Rationale,
                        VacuousLegacy = vacuous,
                    });
                    continue;
                }

                using var matcherDoc = TryParseJson(expSrc.MatcherSpec, out var matcherFail);
                if (matcherFail != null)
                {
                    reasons.Add(MakeReason(CodeMatcherSpecMalformed,
                        $"expectations[{i}].matcherSpec", null, matcherFail));
                    continue;
                }

                var matcher = ProjectMatcher(matcherDoc.RootElement, i, reasons);
                if (matcher == null) continue;

                expectations.Add(new Expectation
                {
                    Id = $"exp-{i + 1}",
                    Type = expType,
                    Topic = expSrc.Topic,
                    Matcher = matcher,
                    Description = expSrc.Rationale,
                });
            }

            var typedMatchers = ProjectTypedMatchers(src.Matchers, reasons);

            if (reasons.Count > 0) return null;

            // Grounding evidence — resolve refs against Architect plan,
            // forward-carry SourceEvidenceId for the audit trail.
            var grounding = new List<GroundingEvidence>();
            foreach (var refId in src.GroundingEvidenceRefs ?? new List<string>())
            {
                if (!evidenceById.TryGetValue(refId, out var arch))
                {
                    // Validator should have caught this; treat as defensive.
                    reasons.Add(MakeReason(CodeGroundingRefUnresolved,
                        "groundingEvidenceRefs", refId,
                        $"Evidence reference '{refId}' was accepted by the Validator but is not present in the Architect plan."));
                    continue;
                }
                grounding.Add(new GroundingEvidence
                {
                    File = arch.RepoRelativePath,
                    StartLine = arch.NewLine,
                    EndLine = arch.NewLine,
                    Reason = arch.Reason,
                    SourceEvidenceId = arch.EvidenceId,
                });
            }

            if (reasons.Count > 0) return null;

            // Structural-fix #2: translate Editor-emitted featureFlagOverrides
            // into the run-time enforcement surface. For HttpRequest stimuli we
            // add `X-Feature-Flag-Override: <FlagName>=<Value>` headers (one
            // per override) so the gateway interceptor can apply them
            // mechanically. For DiInvocation stimuli we synthesize
            // FlagOverride setup steps so EdogQaExecutionEngine's
            // FlagOverrideStore takes effect before the call. The declarative
            // list is also carried verbatim on the projected Scenario so the
            // curator UI and audit trail can render the intent independently
            // of the rendered mechanism.
            var flagOverridesSource = src.FeatureFlagOverrides ?? new List<EdogQaLlmClient.FlagOverride>();
            var flagOverridesProjected = new List<FlagOverride>();
            var setupSteps = new List<SetupStep>();

            // Clear any LLM-generated flag header before projecting — the
            // projector rebuilds it from featureFlagOverrides. Without this,
            // the LLM's header and the projector's header stack up to produce
            // duplicates like "Flag=false, Flag=false".
            if (flagOverridesSource.Count > 0
                && stimulusType == StimulusType.HttpRequest
                && stimulus.HttpRequest?.Headers != null)
            {
                stimulus.HttpRequest.Headers.Remove("X-Feature-Flag-Override");
            }

            foreach (var fo in flagOverridesSource)
            {
                if (fo == null || string.IsNullOrWhiteSpace(fo.FlagName)) continue;
                var rawValue = fo.Value ?? string.Empty;
                flagOverridesProjected.Add(new FlagOverride { FlagName = fo.FlagName, Value = rawValue });

                if (stimulusType == StimulusType.HttpRequest && stimulus.HttpRequest != null)
                {
                    stimulus.HttpRequest.Headers ??= new Dictionary<string, string>();
                    var headerKey = "X-Feature-Flag-Override";
                    var headerValue = $"{fo.FlagName}={rawValue}";
                    if (stimulus.HttpRequest.Headers.TryGetValue(headerKey, out var existing) && !string.IsNullOrEmpty(existing))
                    {
                        // Multiple overrides — append comma-separated so a
                        // single header carries the full set without clobbering.
                        stimulus.HttpRequest.Headers[headerKey] = existing + ", " + headerValue;
                    }
                    else
                    {
                        stimulus.HttpRequest.Headers[headerKey] = headerValue;
                    }
                }
                else if (stimulusType == StimulusType.DiInvocation)
                {
                    // FlagOverrideSpec.Value is a bool — coerce the string
                    // payload defensively. "true"/"1"/"on"/"yes" → true;
                    // anything else → false. The capability registry only
                    // supports force-ON today, so an explicit false falls
                    // back to the no-op path and the unavailable telemetry
                    // counter increments — which is the documented behaviour.
                    var boolValue = string.Equals(rawValue, "true", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(rawValue, "1", StringComparison.Ordinal)
                        || string.Equals(rawValue, "on", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(rawValue, "yes", StringComparison.OrdinalIgnoreCase);
                    setupSteps.Add(new SetupStep
                    {
                        Type = SetupStepType.FlagOverride,
                        FlagOverride = new FlagOverrideSpec
                        {
                            FlagName = fo.FlagName,
                            Value = boolValue,
                        },
                    });
                }
            }

            return new Scenario
            {
                Id = src.Id,
                Title = src.Title,
                Description = src.Description,
                Category = category,
                Priority = src.Priority,
                ImpactZone = src.ImpactZone,
                Lifecycle = ScenarioLifecycle.Generated,
                Technique = technique,
                Stimulus = stimulus,
                Setup = setupSteps,
                Expectations = expectations,
                Matchers = typedMatchers,
                TimeoutMs = src.TimeoutMs > 0 ? src.TimeoutMs : 30_000,
                CatalogHashes = CloneCatalogHashes(src.CatalogHashes),
                Metadata = new ScenarioMetadata
                {
                    Confidence = accepted.CalibratedConfidence,
                    GeneratedBy = "ai",
                    GeneratedAt = DateTimeOffset.UtcNow,
                },
                GroundingEvidence = grounding,
                InvariantsAddressed = src.InvariantsAddressed != null && src.InvariantsAddressed.Count > 0
                    ? new List<string>(src.InvariantsAddressed)
                    : new List<string>(),
                FeatureFlagOverrides = flagOverridesProjected,
                StimulusId = src.StimulusId,
            };
        }

        // ──────────────────────────────────────────────────────────────
        // Per-stimulus-type parsers. Each returns null on failure
        // after pushing a reason into the list.
        // ──────────────────────────────────────────────────────────────

        private static HttpRequestSpec ProjectHttpRequest(
            JsonElement root,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
        {
            var spec = new HttpRequestSpec();
            if (TryGetString(root, "path", out var path)) spec.Path = NormalizeHttpPath(path);
            else
            {
                reasons.Add(MakeReason(CodeStimulusSpecMissingField, "stimulusSpec.path", null,
                    "HttpRequest stimulus requires a 'path' field."));
                return null;
            }
            if (TryGetString(root, "method", out var method) && !string.IsNullOrWhiteSpace(method))
                spec.Method = method;
            if (TryGetString(root, "contentType", out var contentType) && !string.IsNullOrWhiteSpace(contentType))
                spec.ContentType = contentType;
            if (root.TryGetProperty("body", out var body) && body.ValueKind != JsonValueKind.Null)
                spec.Body = ExtractValue(body);
            if (root.TryGetProperty("headers", out var headers) && headers.ValueKind == JsonValueKind.Object)
            {
                foreach (var h in headers.EnumerateObject())
                {
                    if (h.Value.ValueKind == JsonValueKind.String)
                    {
                        // Strip fake auth headers the LLM generates —
                        // the flt-proxy handles real authentication.
                        if (string.Equals(h.Name, "Authorization", StringComparison.OrdinalIgnoreCase))
                            continue;
                        spec.Headers[h.Name] = h.Value.GetString();
                    }
                }
            }
            return spec;
        }

        /// <summary>
        /// Normalizes LLM-generated HTTP paths to controller-relative form.
        /// Strips /v1/workspaces/{id}/lakehouses/{id} prefixes, zero-GUIDs,
        /// placeholder GUIDs (11111111-..., 22222222-...), and template vars.
        /// Output: /liveTable/insights/summary (what the flt-proxy expects).
        /// </summary>
        private static string NormalizeHttpPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;

            // Fast path: already controller-relative
            var controllerPrefixes = new[] { "/liveTable", "/liveTableSchedule", "/liveTableMaintanance" };
            if (path.StartsWith("/liveTable", StringComparison.OrdinalIgnoreCase))
                return path;

            // Strip /v1/workspaces/{id}/lakehouses/{id} prefix by finding
            // the first known controller segment
            foreach (var prefix in controllerPrefixes)
            {
                var idx = path.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
                if (idx >= 0)
                    return path.Substring(idx);
            }

            // Fallback: strip /v1/workspaces/.../lakehouses/.../ generically
            var lakehouseIdx = path.IndexOf("/lakehouses/", StringComparison.OrdinalIgnoreCase);
            if (lakehouseIdx >= 0)
            {
                // Skip past /lakehouses/{guid-or-template}/
                var afterLh = lakehouseIdx + 12; // "/lakehouses/"
                var nextSlash = path.IndexOf('/', afterLh);
                if (nextSlash > 0)
                    return path.Substring(nextSlash);
            }

            return path;
        }

        private static SignalRBroadcastSpec ProjectSignalRBroadcast(
            JsonElement root,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
        {
            var spec = new SignalRBroadcastSpec();
            if (!TryGetString(root, "hub", out var hub))
            {
                reasons.Add(MakeReason(CodeStimulusSpecMissingField, "stimulusSpec.hub", null,
                    "SignalRBroadcast stimulus requires a 'hub' field."));
                return null;
            }
            if (!TryGetString(root, "method", out var method))
            {
                reasons.Add(MakeReason(CodeStimulusSpecMissingField, "stimulusSpec.method", null,
                    "SignalRBroadcast stimulus requires a 'method' field."));
                return null;
            }
            spec.Hub = hub;
            spec.Method = method;
            if (TryGetString(root, "connectionId", out var connId)) spec.ConnectionId = connId;
            if (root.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in args.EnumerateArray()) spec.Args.Add(ExtractValue(a));
            }
            return spec;
        }

        private static DagTriggerSpec ProjectDagTrigger(
            JsonElement root,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
        {
            var spec = new DagTriggerSpec();
            spec.IterationId = TryGetString(root, "iterationId", out var iter) ? iter : "current";
            if (root.TryGetProperty("nodeFilter", out var filter) && filter.ValueKind == JsonValueKind.Array)
            {
                spec.NodeFilter = new List<string>();
                foreach (var n in filter.EnumerateArray())
                {
                    if (n.ValueKind == JsonValueKind.String) spec.NodeFilter.Add(n.GetString());
                }
            }
            return spec;
        }

        private static FileEventSpec ProjectFileEvent(
            JsonElement root,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
        {
            var spec = new FileEventSpec();
            if (!TryGetString(root, "path", out var path))
            {
                reasons.Add(MakeReason(CodeStimulusSpecMissingField, "stimulusSpec.path", null,
                    "FileEvent stimulus requires a 'path' field."));
                return null;
            }
            spec.Path = path;
            if (TryGetString(root, "content", out var content)) spec.Content = content;
            if (TryGetString(root, "encoding", out var enc) && !string.IsNullOrWhiteSpace(enc))
                spec.Encoding = enc;
            if (root.TryGetProperty("cleanup", out var cleanup) &&
                (cleanup.ValueKind == JsonValueKind.True || cleanup.ValueKind == JsonValueKind.False))
            {
                spec.Cleanup = cleanup.GetBoolean();
            }
            return spec;
        }

        private static TimerTickSpec ProjectTimerTick(
            JsonElement root,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
        {
            var spec = new TimerTickSpec();
            if (!TryGetString(root, "tickSource", out var src))
            {
                reasons.Add(MakeReason(CodeStimulusSpecMissingField, "stimulusSpec.tickSource", null,
                    "TimerTick stimulus requires a 'tickSource' field."));
                return null;
            }
            spec.TickSource = src;
            if (TryGetString(root, "topic", out var topic) && !string.IsNullOrWhiteSpace(topic))
                spec.Topic = topic;
            if (root.TryGetProperty("maxWaitMs", out var wait) && wait.ValueKind == JsonValueKind.Number)
                spec.MaxWaitMs = wait.GetInt32();
            return spec;
        }

        private static DiInvocationSpec ProjectDiInvocation(
            JsonElement root,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
        {
            var spec = new DiInvocationSpec();
            if (!TryGetString(root, "serviceType", out var st))
            {
                reasons.Add(MakeReason(CodeStimulusSpecMissingField, "stimulusSpec.serviceType", null,
                    "DiInvocation stimulus requires a 'serviceType' field."));
                return null;
            }
            if (!TryGetString(root, "method", out var method))
            {
                reasons.Add(MakeReason(CodeStimulusSpecMissingField, "stimulusSpec.method", null,
                    "DiInvocation stimulus requires a 'method' field."));
                return null;
            }
            spec.ServiceType = st;
            spec.Method = method;
            if (root.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in args.EnumerateArray()) spec.Args.Add(ExtractValue(a));
            }
            return spec;
        }

        // ──────────────────────────────────────────────────────────────
        // Matcher parser. Accepts the 5 dictionary branches +
        // optional timeWindow/count/order side-fields if the Editor
        // emits them (the engine carries those on Expectation directly,
        // not on Matcher).
        // ──────────────────────────────────────────────────────────────

        // ──────────────────────────────────────────────────────────────
        // P10: Convert typed matchers → legacy LegacyMatcher for a
        // specific expectation topic. Groups all typed matchers whose
        // topicField starts with the expectation's topic into a single
        // LegacyMatcher so the assertion engine can evaluate them.
        // ──────────────────────────────────────────────────────────────

        private static LegacyMatcher BuildLegacyMatcherFromTyped(
            IReadOnlyList<EdogQaLlmClient.GeneratedMatcher> typedMatchers,
            string expectationTopic)
        {
            if (typedMatchers == null || typedMatchers.Count == 0)
                return new LegacyMatcher();

            var exact = new Dictionary<string, object>();
            var exists = new List<string>();
            var range = new Dictionary<string, RangeBounds>();
            var contains = new Dictionary<string, string>();

            foreach (var tm in typedMatchers)
            {
                if (tm == null) continue;
                var field = tm.TopicField ?? string.Empty;

                // Match matchers to this expectation by topic prefix.
                // topicField format is "topic.field" or just "field".
                if (!string.IsNullOrEmpty(expectationTopic)
                    && !field.StartsWith(expectationTopic + ".", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(field, expectationTopic, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (!Enum.TryParse<MatcherAssertion>(tm.Assertion, true, out var assertion))
                    continue;

                var extractedValue = ExtractTypedMatcherValue(tm.Value);

                switch (assertion)
                {
                    case MatcherAssertion.Equals:
                        if (extractedValue != null)
                            exact[field] = extractedValue;
                        break;
                    case MatcherAssertion.Exists:
                        exists.Add(field);
                        break;
                    case MatcherAssertion.InRange:
                        range[field] = ExtractTypedRangeBounds(tm.Value);
                        break;
                    // P10 fix (P1-1): NotEquals / ContainsAll / OneOf / Length
                    // have no faithful legacy representation — collapsing them
                    // into Exact / Contains silently reversed or weakened the
                    // semantics. The typed-matcher path
                    // (EvaluateContractMatchers) handles these correctly, so
                    // we deliberately omit them from the legacy projection.
                    case MatcherAssertion.NotEquals:
                    case MatcherAssertion.ContainsAll:
                    case MatcherAssertion.OneOf:
                    case MatcherAssertion.Length:
                        break;
                }
            }

            var matcher = new LegacyMatcher();
            if (exact.Count > 0) matcher.Exact = exact;
            if (exists.Count > 0) matcher.Exists = exists;
            if (range.Count > 0) matcher.Range = range;
            if (contains.Count > 0) matcher.Contains = contains;
            return matcher;
        }

        /// <summary>
        /// Returns true when a LegacyMatcher has all predicate fields null/empty,
        /// meaning it would match every event (vacuous acceptance).
        /// </summary>
        private static bool IsVacuous(LegacyMatcher matcher)
        {
            if (matcher == null) return true;
            return matcher.Exact == null
                && matcher.Contains == null
                && matcher.Regex == null
                && matcher.Range == null
                && matcher.Exists == null;
        }

        private static object ExtractTypedMatcherValue(JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Object) return null;
            // New schema only: `literal` carries the concrete payload.
            if (value.TryGetProperty("literal", out var lit))
            {
                return lit.ValueKind switch
                {
                    JsonValueKind.String => lit.GetString(),
                    JsonValueKind.Number => lit.TryGetInt64(out var l) ? (object)l : lit.GetDouble(),
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    _ => lit.GetRawText(),
                };
            }
            if (value.TryGetProperty("expected", out var exp))
            {
                return exp.ValueKind == JsonValueKind.True;
            }
            return null;
        }

        private static RangeBounds ExtractTypedRangeBounds(JsonElement value)
        {
            var bounds = new RangeBounds();
            if (value.ValueKind == JsonValueKind.Object)
            {
                if (value.TryGetProperty("min", out var min) && min.ValueKind == JsonValueKind.Number)
                    bounds.Min = min.GetDouble();
                if (value.TryGetProperty("max", out var max) && max.ValueKind == JsonValueKind.Number)
                    bounds.Max = max.GetDouble();
                // P10 fix (P1-2): preserve inclusivity flags from the typed payload.
                if (value.TryGetProperty("minInclusive", out var minInc) && minInc.ValueKind == JsonValueKind.False)
                    bounds.MinInclusive = false;
                if (value.TryGetProperty("maxInclusive", out var maxInc) && maxInc.ValueKind == JsonValueKind.False)
                    bounds.MaxInclusive = false;
            }
            return bounds;
        }

        private static LegacyMatcher ProjectMatcher(
            JsonElement root,
            int expIndex,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
        {
            if (root.ValueKind != JsonValueKind.Object)
            {
                reasons.Add(MakeReason(CodeMatcherSpecMalformed,
                    $"expectations[{expIndex}].matcherSpec", null,
                    "MatcherSpec must be a JSON object."));
                return null;
            }

            var matcher = new LegacyMatcher();
            var anyBranch = false;

            if (root.TryGetProperty("exact", out var exact) && exact.ValueKind == JsonValueKind.Object)
            {
                matcher.Exact = new Dictionary<string, object>();
                foreach (var p in exact.EnumerateObject()) matcher.Exact[p.Name] = ExtractValue(p.Value);
                anyBranch |= matcher.Exact.Count > 0;
            }
            if (root.TryGetProperty("contains", out var contains) && contains.ValueKind == JsonValueKind.Object)
            {
                matcher.Contains = new Dictionary<string, string>();
                foreach (var p in contains.EnumerateObject())
                {
                    if (p.Value.ValueKind == JsonValueKind.String)
                        matcher.Contains[p.Name] = p.Value.GetString();
                }
                anyBranch |= matcher.Contains.Count > 0;
            }
            if (root.TryGetProperty("regex", out var regex) && regex.ValueKind == JsonValueKind.Object)
            {
                matcher.Regex = new Dictionary<string, string>();
                foreach (var p in regex.EnumerateObject())
                {
                    if (p.Value.ValueKind == JsonValueKind.String)
                        matcher.Regex[p.Name] = p.Value.GetString();
                }
                anyBranch |= matcher.Regex.Count > 0;
            }
            if (root.TryGetProperty("range", out var range) && range.ValueKind == JsonValueKind.Object)
            {
                matcher.Range = new Dictionary<string, RangeBounds>();
                foreach (var p in range.EnumerateObject())
                {
                    if (p.Value.ValueKind != JsonValueKind.Object) continue;
                    var bounds = new RangeBounds();
                    if (p.Value.TryGetProperty("min", out var min) && min.ValueKind == JsonValueKind.Number)
                        bounds.Min = min.GetDouble();
                    if (p.Value.TryGetProperty("max", out var max) && max.ValueKind == JsonValueKind.Number)
                        bounds.Max = max.GetDouble();
                    // P10 fix (P1-2): preserve inclusivity flags.
                    if (p.Value.TryGetProperty("minInclusive", out var minInc) && minInc.ValueKind == JsonValueKind.False)
                        bounds.MinInclusive = false;
                    if (p.Value.TryGetProperty("maxInclusive", out var maxInc) && maxInc.ValueKind == JsonValueKind.False)
                        bounds.MaxInclusive = false;
                    matcher.Range[p.Name] = bounds;
                }
                anyBranch |= matcher.Range.Count > 0;
            }
            if (root.TryGetProperty("exists", out var exists) && exists.ValueKind == JsonValueKind.Array)
            {
                matcher.Exists = new List<string>();
                foreach (var f in exists.EnumerateArray())
                {
                    if (f.ValueKind == JsonValueKind.String) matcher.Exists.Add(f.GetString());
                }
                anyBranch |= matcher.Exists.Count > 0;
            }

            if (!anyBranch)
            {
                reasons.Add(MakeReason(CodeMatcherSpecEmpty,
                    $"expectations[{expIndex}].matcherSpec", null,
                    "Matcher must declare at least one of: exact, contains, regex, range, exists."));
                return null;
            }

            return matcher;
        }

        private static List<Matcher> ProjectTypedMatchers(
            IReadOnlyList<EdogQaLlmClient.GeneratedMatcher> source,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
        {
            var projected = new List<Matcher>();
            if (source == null || source.Count == 0)
            {
                return projected;
            }

            for (var i = 0; i < source.Count; i++)
            {
                var matcher = source[i];
                if (matcher == null)
                {
                    reasons.Add(MakeReason(CodeMatcherSpecEmpty, $"matchers[{i}]", null, "Typed matcher entry is null."));
                    continue;
                }

                if (!Enum.TryParse<MatcherAssertion>(matcher.Assertion, true, out var assertion))
                {
                    reasons.Add(MakeReason(CodeEnumParseFailed, $"matchers[{i}].assertion", null,
                        $"Matcher assertion '{matcher.Assertion}' is not a valid MatcherAssertion enum value."));
                    continue;
                }

                var value = ProjectMatcherValue(matcher.Value, assertion, i, reasons);
                if (value == null)
                {
                    continue;
                }

                projected.Add(new Matcher
                {
                    TopicField = matcher.TopicField,
                    Assertion = assertion,
                    Value = value,
                });
            }

            return projected;
        }

        private static MatcherValue ProjectMatcherValue(
            JsonElement root,
            MatcherAssertion assertion,
            int index,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
        {
            if (root.ValueKind != JsonValueKind.Object)
            {
                reasons.Add(MakeReason(CodeMatcherSpecMalformed, $"matchers[{index}].value", null,
                    "Typed matcher value payload must be a JSON object."));
                return null;
            }

            // Single-shape matcher value: requires a `kind` discriminator.
            // The legacy {type, value} payload is no longer accepted — the
            // projector emits MATCHER_SPEC_MALFORMED when it sees one.
            var kind = ReadMatcherValueKind(root);
            if (string.IsNullOrEmpty(kind))
            {
                reasons.Add(MakeReason(CodeMatcherSpecMalformed, $"matchers[{index}].value.kind", null,
                    "Typed matcher value payload must declare a 'kind' discriminator."));
                return null;
            }

            switch (assertion)
            {
                case MatcherAssertion.Equals:
                case MatcherAssertion.NotEquals:
                    if (!root.TryGetProperty("literal", out var scalarValue))
                    {
                        reasons.Add(MakeReason(CodeMatcherSpecEmpty, $"matchers[{index}].value.literal", null,
                            "Scalar matcher values require a 'literal' field."));
                        return null;
                    }

                    return new ScalarMatcherValue { Type = kind, Value = ExtractValue(scalarValue) };

                case MatcherAssertion.Exists:
                    // P10 fix (P1-6): the spec says Exists is value-agnostic —
                    // the assertion checks presence, not a specific boolean.
                    // Default `expected` to true (i.e. "must exist") when the
                    // field is missing rather than quarantining the scenario.
                    if (!root.TryGetProperty("expected", out var expected))
                    {
                        return new BooleanMatcherValue { Type = kind, Expected = true };
                    }
                    if (expected.ValueKind != JsonValueKind.True && expected.ValueKind != JsonValueKind.False)
                    {
                        reasons.Add(MakeReason(CodeMatcherSpecEmpty, $"matchers[{index}].value.expected", null,
                            "Exists matcher 'expected' must be a boolean when provided."));
                        return null;
                    }

                    return new BooleanMatcherValue { Type = kind, Expected = expected.GetBoolean() };

                case MatcherAssertion.InRange:
                    return new RangeMatcherValue
                    {
                        Type = kind,
                        Min = root.TryGetProperty("min", out var min) && min.ValueKind == JsonValueKind.Number ? min.GetDouble() : null,
                        Max = root.TryGetProperty("max", out var max) && max.ValueKind == JsonValueKind.Number ? max.GetDouble() : null,
                        MinInclusive = !root.TryGetProperty("minInclusive", out var minInc) || minInc.ValueKind != JsonValueKind.False,
                        MaxInclusive = !root.TryGetProperty("maxInclusive", out var maxInc) || maxInc.ValueKind != JsonValueKind.False,
                    };

                case MatcherAssertion.ContainsAll:
                case MatcherAssertion.OneOf:
                    var items = new List<object>();
                    if (root.TryGetProperty("items", out var itemsElement) && itemsElement.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in itemsElement.EnumerateArray())
                        {
                            items.Add(ExtractValue(item));
                        }
                    }

                    return new ArrayMatcherValue { Type = kind, Items = items };

                case MatcherAssertion.Length:
                    return new LengthMatcherValue
                    {
                        Type = kind,
                        Min = root.TryGetProperty("min", out var lenMin) && lenMin.ValueKind == JsonValueKind.Number ? lenMin.GetInt32() : null,
                        Max = root.TryGetProperty("max", out var lenMax) && lenMax.ValueKind == JsonValueKind.Number ? lenMax.GetInt32() : null,
                    };

                default:
                    return null;
            }
        }

        /// <summary>
        /// Reads the <c>kind</c> discriminator (e.g. <c>"string_literal"</c>)
        /// from a typed matcher value payload. Returns null when the field is
        /// absent — the projector rejects such payloads outright.
        /// </summary>
        private static string ReadMatcherValueKind(JsonElement root)
        {
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (root.TryGetProperty("kind", out var kindElement) && kindElement.ValueKind == JsonValueKind.String)
            {
                return kindElement.GetString();
            }
            return null;
        }

        private static List<Matcher> CloneMatchers(IReadOnlyList<Matcher> source)
        {
            if (source == null || source.Count == 0)
            {
                return new List<Matcher>();
            }

            return source.Select(m => m == null ? null : new Matcher
            {
                TopicField = m.TopicField,
                Assertion = m.Assertion,
                Value = CloneMatcherValue(m.Value),
            }).ToList();
        }

        private static MatcherValue CloneMatcherValue(MatcherValue value)
        {
            return value switch
            {
                ScalarMatcherValue scalar => new ScalarMatcherValue { Type = scalar.Type, Value = scalar.Value },
                RangeMatcherValue range => new RangeMatcherValue
                {
                    Type = range.Type,
                    Min = range.Min,
                    Max = range.Max,
                    MinInclusive = range.MinInclusive,
                    MaxInclusive = range.MaxInclusive,
                },
                ArrayMatcherValue array => new ArrayMatcherValue
                {
                    Type = array.Type,
                    Items = array.Items != null ? new List<object>(array.Items) : new List<object>(),
                },
                BooleanMatcherValue boolean => new BooleanMatcherValue { Type = boolean.Type, Expected = boolean.Expected },
                LengthMatcherValue length => new LengthMatcherValue { Type = length.Type, Min = length.Min, Max = length.Max },
                _ => null,
            };
        }

        private static CatalogHashes CloneCatalogHashes(CatalogHashes source)
        {
            if (source == null)
            {
                return null;
            }

            return new CatalogHashes
            {
                StimulusSlotHash = source.StimulusSlotHash,
                CatalogSnapshotId = source.CatalogSnapshotId,
                MatcherTopicHashes = source.MatcherTopicHashes != null
                    ? new Dictionary<string, string>(source.MatcherTopicHashes, StringComparer.Ordinal)
                    : new Dictionary<string, string>(StringComparer.Ordinal),
            };
        }

        private static ScenarioMetadata CloneMetadata(ScenarioMetadata source)
        {
            if (source == null)
            {
                return new ScenarioMetadata();
            }

            return new ScenarioMetadata
            {
                GeneratedBy = source.GeneratedBy,
                Confidence = source.Confidence,
                RelatedPRFiles = source.RelatedPRFiles != null ? new List<string>(source.RelatedPRFiles) : new List<string>(),
                Tags = source.Tags != null ? new List<string>(source.Tags) : new List<string>(),
                SchemaVersion = source.SchemaVersion,
                GeneratedAt = source.GeneratedAt,
                CuratedBy = source.CuratedBy,
                CuratedAt = source.CuratedAt,
            };
        }

        private static List<GroundingEvidence> CloneGroundingEvidence(IReadOnlyList<GroundingEvidence> source)
        {
            if (source == null || source.Count == 0)
            {
                return new List<GroundingEvidence>();
            }

            return source.Select(e => e == null ? null : new GroundingEvidence
            {
                File = e.File,
                StartLine = e.StartLine,
                EndLine = e.EndLine,
                Reason = e.Reason,
                InvariantId = e.InvariantId,
                SourceEvidenceId = e.SourceEvidenceId,
            }).ToList();
        }

        private static Stimulus CloneStimulus(Stimulus source)
        {
            if (source == null)
            {
                return null;
            }

            return new Stimulus
            {
                Type = source.Type,
                HttpRequest = source.HttpRequest == null ? null : new HttpRequestSpec
                {
                    Method = source.HttpRequest.Method,
                    Path = source.HttpRequest.Path,
                    Headers = source.HttpRequest.Headers != null ? new Dictionary<string, string>(source.HttpRequest.Headers, StringComparer.Ordinal) : new Dictionary<string, string>(StringComparer.Ordinal),
                    Body = source.HttpRequest.Body,
                    ContentType = source.HttpRequest.ContentType,
                },
                SignalRBroadcast = source.SignalRBroadcast == null ? null : new SignalRBroadcastSpec
                {
                    Hub = source.SignalRBroadcast.Hub,
                    Method = source.SignalRBroadcast.Method,
                    ConnectionId = source.SignalRBroadcast.ConnectionId,
                    Args = source.SignalRBroadcast.Args != null ? new List<object>(source.SignalRBroadcast.Args) : new List<object>(),
                },
                DagTrigger = source.DagTrigger == null ? null : new DagTriggerSpec
                {
                    IterationId = source.DagTrigger.IterationId,
                    NodeFilter = source.DagTrigger.NodeFilter != null ? new List<string>(source.DagTrigger.NodeFilter) : null,
                },
                FileEvent = source.FileEvent == null ? null : new FileEventSpec
                {
                    Path = source.FileEvent.Path,
                    Content = source.FileEvent.Content,
                    Encoding = source.FileEvent.Encoding,
                    Cleanup = source.FileEvent.Cleanup,
                },
                TimerTick = source.TimerTick == null ? null : new TimerTickSpec
                {
                    TickSource = source.TimerTick.TickSource,
                    Topic = source.TimerTick.Topic,
                    MaxWaitMs = source.TimerTick.MaxWaitMs,
                },
                DiInvocation = source.DiInvocation == null ? null : new DiInvocationSpec
                {
                    ServiceType = source.DiInvocation.ServiceType,
                    Method = source.DiInvocation.Method,
                    Args = source.DiInvocation.Args != null ? new List<object>(source.DiInvocation.Args) : new List<object>(),
                },
            };
        }

        // ──────────────────────────────────────────────────────────────
        // Helpers.
        // ──────────────────────────────────────────────────────────────

        // LNT009 defense-in-depth: build stub stimuli from the Architect's
        // testingGuidance.stimuliRequired[*].toolingHint when the Editor's
        // stimulusSpec failed to parse. Each helper reads the well-known
        // shape fields (path, method, headers, body, contentType, hub, etc.)
        // off the guidance object and falls back to "unknown" when absent.
        // The guidance object is the toolingHint parsed as a JSON object.

        private static HttpRequestSpec BuildHttpStubFromGuidance(JsonElement? guidance)
        {
            var spec = new HttpRequestSpec { Method = "GET", Path = "/api/unknown" };
            if (guidance == null) return spec;
            var g = guidance.Value;
            if (TryGetString(g, "method", out var method)) spec.Method = method;
            if (TryGetString(g, "path", out var path)) spec.Path = path;
            if (TryGetString(g, "contentType", out var ct)) spec.ContentType = ct;
            if (g.TryGetProperty("headers", out var headersEl) && headersEl.ValueKind == JsonValueKind.Object)
            {
                foreach (var p in headersEl.EnumerateObject())
                {
                    spec.Headers[p.Name] = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : p.Value.ToString();
                }
            }
            if (g.TryGetProperty("body", out var bodyEl) && bodyEl.ValueKind != JsonValueKind.Undefined && bodyEl.ValueKind != JsonValueKind.Null)
            {
                spec.Body = JsonSerializer.Deserialize<object>(bodyEl.GetRawText());
            }
            return spec;
        }

        private static SignalRBroadcastSpec BuildSignalRStubFromGuidance(JsonElement? guidance)
        {
            var spec = new SignalRBroadcastSpec { Hub = "unknown", Method = "unknown" };
            if (guidance == null) return spec;
            var g = guidance.Value;
            if (TryGetString(g, "hub", out var hub)) spec.Hub = hub;
            if (TryGetString(g, "method", out var method)) spec.Method = method;
            return spec;
        }

        private static DagTriggerSpec BuildDagStubFromGuidance(JsonElement? guidance)
        {
            var spec = new DagTriggerSpec { IterationId = "unknown" };
            if (guidance == null) return spec;
            var g = guidance.Value;
            if (TryGetString(g, "iterationId", out var iter)) spec.IterationId = iter;
            return spec;
        }

        private static FileEventSpec BuildFileStubFromGuidance(JsonElement? guidance)
        {
            var spec = new FileEventSpec { Path = "unknown" };
            if (guidance == null) return spec;
            var g = guidance.Value;
            if (TryGetString(g, "path", out var p)) spec.Path = p;
            return spec;
        }

        private static TimerTickSpec BuildTimerStubFromGuidance(JsonElement? guidance)
        {
            var spec = new TimerTickSpec { TickSource = "unknown" };
            if (guidance == null) return spec;
            var g = guidance.Value;
            if (TryGetString(g, "tickSource", out var ts)) spec.TickSource = ts;
            return spec;
        }

        private static DiInvocationSpec BuildDiStubFromGuidance(JsonElement? guidance)
        {
            var spec = new DiInvocationSpec { ServiceType = "unknown", Method = "unknown" };
            if (guidance == null) return spec;
            var g = guidance.Value;
            if (TryGetString(g, "serviceType", out var st)) spec.ServiceType = st;
            if (TryGetString(g, "method", out var method)) spec.Method = method;
            return spec;
        }

        private static JsonDocument TryParseJson(string text, out string error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(text))
            {
                error = "Spec is empty.";
                return JsonDocument.Parse("{}");
            }
            try
            {
                return JsonDocument.Parse(text);
            }
            catch (JsonException)
            {
                // LLM sometimes emits Python-style single-quoted dicts
                // instead of valid JSON. Normalize before failing, taking
                // care not to corrupt apostrophes inside string values
                // (e.g. {'error':'can\'t connect'}).
                var normalized = NormalizeSingleQuotedJson(text);
                try
                {
                    return JsonDocument.Parse(normalized);
                }
                catch (JsonException ex2)
                {
                    error = $"Spec is not valid JSON: {ex2.Message}";
                    return JsonDocument.Parse("{}");
                }
            }
        }

        /// <summary>
        /// Convert a Python-style single-quoted JSON-ish string into valid
        /// JSON. Walks the input char by char and only flips a quote when
        /// it is acting as a string delimiter, leaving apostrophes inside
        /// the body of a single-quoted string intact. Escaped pairs
        /// (e.g. <c>\'</c>) are passed through unchanged. If the original
        /// delimiter was a single quote, embedded raw double quotes are
        /// escaped so the result remains parseable.
        /// </summary>
        private static string NormalizeSingleQuotedJson(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            var sb = new StringBuilder(text.Length);
            bool inString = false;
            char stringDelim = '\0';
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (inString)
                {
                    if (c == '\\' && i + 1 < text.Length)
                    {
                        // Escaped character — pass through both.
                        sb.Append(c);
                        sb.Append(text[++i]);
                        continue;
                    }
                    if (c == stringDelim)
                    {
                        // Closing delimiter — always emit as double-quote.
                        sb.Append('"');
                        inString = false;
                        continue;
                    }
                    // Inside a single-quoted string a raw double-quote
                    // would terminate the resulting JSON string prematurely,
                    // so escape it.
                    if (stringDelim == '\'' && c == '"')
                    {
                        sb.Append('\\').Append('"');
                        continue;
                    }
                    sb.Append(c);
                }
                else
                {
                    if (c == '\'' || c == '"')
                    {
                        sb.Append('"');
                        inString = true;
                        stringDelim = c;
                        continue;
                    }
                    sb.Append(c);
                }
            }
            return sb.ToString();
        }

        private static bool TryGetString(JsonElement obj, string name, out string value)
        {
            value = null;
            if (obj.ValueKind != JsonValueKind.Object) return false;
            if (!obj.TryGetProperty(name, out var prop)) return false;
            if (prop.ValueKind != JsonValueKind.String) return false;
            value = prop.GetString();
            return !string.IsNullOrEmpty(value);
        }

        private static object ExtractValue(JsonElement el)
        {
            switch (el.ValueKind)
            {
                case JsonValueKind.String: return el.GetString();
                case JsonValueKind.Number:
                    if (el.TryGetInt64(out var l)) return l;
                    return el.GetDouble();
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Null: return null;
                case JsonValueKind.Array:
                {
                    var list = new List<object>();
                    foreach (var item in el.EnumerateArray()) list.Add(ExtractValue(item));
                    return list;
                }
                case JsonValueKind.Object:
                {
                    var dict = new Dictionary<string, object>();
                    foreach (var p in el.EnumerateObject()) dict[p.Name] = ExtractValue(p.Value);
                    return dict;
                }
                default: return el.GetRawText();
            }
        }

        private static EdogQaScenarioValidator.QuarantineReason MakeReason(
            string code, string fieldPath, string evidenceId, string message)
        {
            return new EdogQaScenarioValidator.QuarantineReason
            {
                Code = code,
                Message = message,
                FieldPath = fieldPath,
                EvidenceId = evidenceId,
            };
        }
    }
}
