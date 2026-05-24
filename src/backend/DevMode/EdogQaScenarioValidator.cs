// SPDX-License-Identifier: MIT
// F27 P9 T1c-a — defense-in-depth validator for V2-generated scenarios.
//
// The Architect/Editor split + strict json_schema decoding in
// EdogQaLlmClient guarantees structural well-formedness — every emitted
// scenario matches the schema. What strict-mode CANNOT enforce is:
//   1. that referenced grounding evidence actually points at a changed
//      line in the diff the Architect was given (could be hallucinated);
//   2. length/range constraints (strict mode ignores minLength/maxLength
//      and numeric bounds — §3.2 of the spec is explicit);
//   3. topic-vocabulary membership (the schema has no way to encode
//      "Topic must be one of these 16 strings from the interceptor
//      registry");
//   4. confidence calibration (raw model self-confidence is biased,
//      G-Eval paper);
//   5. intra-batch duplicate scenarios (same stimulus + same expectations
//      from two different sketches).
//
// This file implements those five gates as a PURE STATIC FUNCTION —
// no I/O, no DI, no global state. Cross-zone dedup is deliberately
// OUT of scope here (T1c-b orchestrator handles it as a deterministic
// reducer over all per-zone ValidationResults; doing it per-zone would
// be order-dependent across parallel calls). The output is a structured
// ValidationResult whose Quarantined list carries every reason a
// scenario was rejected, with stable wire codes so the UI can render
// localised messages without string-matching English.
//
// Spec: docs/specs/features/F27-qa-testing/p9-production-grade-llm.md §3.2.
// Rubber-duck T1c review: optional EvidenceId on engine GroundingEvidence
// (adopted #7), QuarantineReason with stable code (adopted #10),
// ValidationContext rather than instance state (adopted #11), schema
// constraints gate present (adopted blocker #6), defer projector + typed
// payload re-parse to T1c-a-2.

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Globalization;
    using System.Linq;
    using System.Security.Cryptography;
    using System.Text;
    using System.Text.Json;

    /// <summary>
    /// Validates V2-generated scenarios against the diff, the Architect
    /// plan, and a fixed vocabulary of valid topics. Pure static function:
    /// <c>Validate(plan, scenarios, diff, context) → ValidationResult</c>.
    /// </summary>
    internal static class EdogQaScenarioValidator
    {
        // ──────────────────────────────────────────────────────────────
        // Stable wire codes for the curation UI + the eval harness. Wire-
        // stable: do NOT rename without updating consumers + the gauntlet
        // test that source-greps these constants. Code grouping matches
        // the five gates declared in spec §3.2.
        // ──────────────────────────────────────────────────────────────

        // Gate 1 — grounding existence in diff.
        public const string CodeGroundingRefUnknown        = "GROUNDING_REF_UNKNOWN";
        public const string CodeGroundingLineNotInDiff     = "GROUNDING_LINE_NOT_IN_DIFF";
        public const string CodeGroundingSideMismatch      = "GROUNDING_SIDE_MISMATCH";
        public const string CodeGroundingMissing           = "GROUNDING_MISSING";

        // Gate 2 — schema-constraints (the ones strict-mode silently allows).
        public const string CodeFieldEmpty                 = "FIELD_EMPTY";
        public const string CodeFieldTooLong               = "FIELD_TOO_LONG";
        public const string CodeFieldOutOfRange            = "FIELD_OUT_OF_RANGE";
        public const string CodeEnumValueInvalid           = "ENUM_VALUE_INVALID";
        public const string CodeExpectationsMissing        = "EXPECTATIONS_MISSING";
        public const string CodeMatcherValueTypeInvalid    = "MATCHER_VALUE_TYPE_INVALID";
        public const string CodeGroundingSlotMismatch      = "GROUNDING_SLOT_MISMATCH";

        // Gate 3 — valid topics.
        public const string CodeTopicUnknown               = "TOPIC_UNKNOWN";

        // Gate 4 — confidence calibration. Capping is INFORMATIONAL (not a
        // quarantine) but emitted as a reason so the UI shows why a
        // scenario's confidence dropped.
        public const string CodeConfidenceCapped           = "CONFIDENCE_CAPPED";

        // Gate 5 — intra-batch dedup.
        public const string CodeDuplicateInBatch           = "DUPLICATE_IN_BATCH";

        // Field-length contract (mirrors the engine Scenario doc comments).
        // Keep in sync with EdogQaModels.Scenario.Title / .Description /
        // .TimeoutMs invariants. If those change, this changes too.
        internal const int MaxTitleLength       = 120;
        internal const int MaxDescriptionLength = 500;
        internal const int MaxReasonLength      = 240;
        internal const int MinTimeoutMs         = 1_000;
        internal const int MaxTimeoutMs         = 120_000;
        internal const int MinPriority          = 1;
        internal const int MaxPriority          = 5;

        /// <summary>
        /// Gate 1 line-proximity tolerance. The Architect cites the
        /// approximate region of a change; the validator confirms the
        /// citation is within this many lines of a real changed line on
        /// the same (file, side). The LLM cannot count lines reliably in
        /// a 100K+ unified diff — exact-match here produces false-positive
        /// <c>GROUNDING_LINE_NOT_IN_DIFF</c> quarantines that the
        /// orchestrator immediately retries, burning tokens for no
        /// reason. Spec: §3.2 gate 1 (LNT-line-tolerance fix).
        /// </summary>
        internal const int LineProximityTolerance = 10;

        // Engine enum vocabularies — frozen here so the validator does not
        // take a runtime dependency on Enum.TryParse against the engine
        // type (would couple Architect-Editor JSON to engine member renames).
        // If a new technique / category / stimulus / expectation lands in
        // the engine, this list MUST be updated and the gauntlet test
        // (test_qa_validator_enum_vocabulary_parity) will fail until it is.
        internal static readonly HashSet<string> ValidCategories = new(StringComparer.OrdinalIgnoreCase)
        {
            "HappyPath", "ErrorPath", "EdgeCase", "Regression", "Performance",
        };

        internal static readonly HashSet<string> ValidTechniques = new(StringComparer.OrdinalIgnoreCase)
        {
            "BoundaryTriplet", "Counterfactual", "TruthTable", "EquivalencePartition",
            "ErrorPath", "RegressionGuard", "HappyPath",
            // NotSpecified intentionally omitted — Architect MUST commit to a technique.
        };

        internal static readonly HashSet<string> ValidStimulusTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            "HttpRequest", "SignalRBroadcast", "DagTrigger",
            "FileEvent", "TimerTick", "DiInvocation",
        };

        internal static readonly HashSet<string> ValidExpectationTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            "EventPresent", "EventAbsent", "EventCount",
            "EventOrder", "Timing", "FieldMatch",
        };

        // ──────────────────────────────────────────────────────────────
        // Context passed by the caller — pure data, no behaviour.
        // ──────────────────────────────────────────────────────────────

        /// <summary>
        /// Per-analysis input the validator needs to evaluate every gate.
        /// Construct once at the orchestrator boundary; pass the same
        /// instance to every per-zone <c>Validate</c> call so dedup hashes
        /// are stable across the analysis.
        /// </summary>
        public sealed class ValidationContext
        {
            /// <summary>Frozen list of interceptor topics. Topic gate compares
            /// case-insensitively. Constructed from
            /// <c>EdogQaCodeAnalyzer.ValidTopics</c>.</summary>
            public IReadOnlyList<string> ValidTopics { get; set; } = Array.Empty<string>();

            /// <summary>If false, the confidence cap (gate 4) is informational
            /// only; the scenario passes with the cap applied. If true (the
            /// default), capping does NOT quarantine — gate 4 never returns
            /// a fatal reason on its own. Reserved for future
            /// strict-confidence experiments.</summary>
            public bool ConfidenceCapIsInformational { get; set; } = true;
        }

        // ──────────────────────────────────────────────────────────────
        // Output shape.
        // ──────────────────────────────────────────────────────────────

        public sealed class QuarantineReason
        {
            /// <summary>Stable wire code; one of the <c>Code*</c> constants.</summary>
            public string Code { get; set; }

            /// <summary>Human-readable message for logs; UI should prefer the code.</summary>
            public string Message { get; set; }

            /// <summary>The Architect <c>evidenceId</c> the failure is bound
            /// to, if applicable; null otherwise.</summary>
            public string EvidenceId { get; set; }

            /// <summary>JSON-pointer-ish path inside the scenario object,
            /// e.g. <c>title</c>, <c>expectations[2].topic</c>. Null when
            /// the failure is scenario-wide.</summary>
            public string FieldPath { get; set; }
        }

        public sealed class QuarantinedScenario
        {
            public EdogQaLlmClient.GeneratedScenario Scenario { get; set; }

            public List<QuarantineReason> Reasons { get; set; } = new();
        }

        public sealed class AcceptedScenario
        {
            public EdogQaLlmClient.GeneratedScenario Scenario { get; set; }

            /// <summary>Deterministic semantic-hash digest used by the
            /// orchestrator's cross-zone reducer. SHA-256 over
            /// (StimulusType + canonical(StimulusSpec) +
            /// sorted(expectations canonical)). Hex-encoded, lower-case,
            /// 64 chars.</summary>
            public string SemanticHash { get; set; }

            /// <summary>Confidence after gate-4 calibration. Always in [0,1].
            /// Will be ≤ 0.7 if any of the scenario's grounding refs
            /// quarantined in gate 1.</summary>
            public double CalibratedConfidence { get; set; }

            /// <summary>Informational reasons attached to an accepted scenario
            /// (e.g. <c>CONFIDENCE_CAPPED</c>). The orchestrator + UI may
            /// surface these alongside the accepted scenario.</summary>
            public List<QuarantineReason> InformationalReasons { get; set; } = new();
        }

        public sealed class ValidationResult
        {
            public List<AcceptedScenario> Accepted { get; set; } = new();

            public List<QuarantinedScenario> Quarantined { get; set; } = new();

            /// <summary>Whole-batch errors that are not bindable to a single
            /// scenario (e.g. the Architect plan itself was null). Empty in
            /// the typical case.</summary>
            public List<QuarantineReason> BatchErrors { get; set; } = new();

            /// <summary>F27 P11: batch-scoped informational reasons that are NOT errors
            /// (e.g. <c>P11_COVERAGE_GAP</c> when a codePath has no addressing sketch,
            /// or <c>P11_COVERAGE_REPORT</c> summary lines). The orchestrator surfaces
            /// these as <c>OrchestratorEvent</c>s with kind <c>ZoneValidated</c>.</summary>
            public List<QuarantineReason> BatchInformationalReasons { get; set; } = new();
        }

        // ──────────────────────────────────────────────────────────────
        // Entry point.
        // ──────────────────────────────────────────────────────────────

        /// <summary>
        /// Validate the Editor's output against the Architect plan and the
        /// unified diff that produced both. Pure: same inputs ⇒ same output.
        /// </summary>
        /// <param name="plan">Architect plan (carries the trusted evidence
        /// pool by <c>evidenceId</c>). Must be non-null.</param>
        /// <param name="scenarios">Editor-emitted scenarios. May be empty;
        /// must not be null.</param>
        /// <param name="unifiedDiff">The diff the Architect was given.
        /// Re-parsed here to verify each evidence's (file, side, line)
        /// tuple actually points at a changed line.</param>
        /// <param name="context">Per-analysis vocabulary + dedup state.</param>
        public static ValidationResult Validate(
            EdogQaLlmClient.ArchitectPlan plan,
            IReadOnlyList<EdogQaLlmClient.GeneratedScenario> scenarios,
            string unifiedDiff,
            ValidationContext context)
            => Validate(plan, scenarios, unifiedDiff, context, testingGuidance: null);

        /// <summary>
        /// F27 P11 overload: accepts the Analyst-produced <paramref name="testingGuidance"/>
        /// directly. The Architect no longer carries testingGuidance on its plan (moved to
        /// the Analyst pass to free Architect output budget); coverage gates read from this
        /// parameter instead of <c>plan.TestingGuidance</c>. Pass <c>null</c> to fall back
        /// to legacy behavior (no coverage gate fires).
        /// </summary>
        public static ValidationResult Validate(
            EdogQaLlmClient.ArchitectPlan plan,
            IReadOnlyList<EdogQaLlmClient.GeneratedScenario> scenarios,
            string unifiedDiff,
            ValidationContext context,
            EdogQaLlmClient.TestingGuidance testingGuidance)
        {
            var result = new ValidationResult();

            if (plan == null)
            {
                result.BatchErrors.Add(new QuarantineReason
                {
                    Code = CodeGroundingMissing,
                    Message = "Architect plan is null — cannot validate any scenario.",
                });
                return result;
            }
            if (scenarios == null)
            {
                throw new ArgumentNullException(nameof(scenarios));
            }
            context ??= new ValidationContext();

            // Pre-compute the evidence-id → record lookup once (O(refs)).
            var evidenceById = BuildEvidenceLookup(plan);

            // Pre-compute the changed-line set once (O(diff bytes)).
            var changedLines = ParseChangedLines(unifiedDiff);

            // Per-(path,side) index of changed line numbers so the
            // proximity check (Gate 1) is O(k) per evidence ref against
            // only the changed lines for that file+side, instead of a
            // full scan of every changed line in the diff.
            var changedLineIndex = new Dictionary<(string Path, string Side), HashSet<int>>();
            foreach (var entry in changedLines)
            {
                var key = (entry.Path, entry.Side);
                if (!changedLineIndex.TryGetValue(key, out var lineSet))
                {
                    lineSet = new HashSet<int>();
                    changedLineIndex[key] = lineSet;
                }
                lineSet.Add(entry.Line);
            }

            // Topic-vocabulary lookup (case-insensitive).
            var validTopics = context.ValidTopics ?? Array.Empty<string>();
            var topicSet = new HashSet<string>(validTopics, StringComparer.OrdinalIgnoreCase);

            // Intra-batch dedup map: semantic hash → first scenario that
            // produced it. Subsequent collisions are quarantined.
            var seenHashes = new Dictionary<string, EdogQaLlmClient.GeneratedScenario>(StringComparer.Ordinal);

            foreach (var scenario in scenarios)
            {
                if (scenario == null) continue;

                var reasons = new List<QuarantineReason>();
                var informational = new List<QuarantineReason>();
                bool groundingFailed = false;

                // ── Gate 1: grounding existence in diff ──────────────────
                if (scenario.GroundingEvidenceRefs == null || scenario.GroundingEvidenceRefs.Count == 0)
                {
                    reasons.Add(new QuarantineReason
                    {
                        Code = CodeGroundingMissing,
                        Message = "Scenario has no grounding evidence refs.",
                        FieldPath = "groundingEvidenceRefs",
                    });
                    groundingFailed = true;
                }
                else
                {
                    for (int i = 0; i < scenario.GroundingEvidenceRefs.Count; i++)
                    {
                        var evidenceId = scenario.GroundingEvidenceRefs[i];
                        if (string.IsNullOrEmpty(evidenceId)
                            || !evidenceById.TryGetValue(evidenceId, out var evidence))
                        {
                            reasons.Add(new QuarantineReason
                            {
                                Code = CodeGroundingRefUnknown,
                                Message = $"Scenario references evidenceId '{evidenceId}' that is not in the Architect plan.",
                                EvidenceId = evidenceId,
                                FieldPath = $"groundingEvidenceRefs[{i}]",
                            });
                            groundingFailed = true;
                            continue;
                        }

                        var sideOk = string.Equals(evidence.Side, "left", StringComparison.OrdinalIgnoreCase)
                                  || string.Equals(evidence.Side, "right", StringComparison.OrdinalIgnoreCase);
                        if (!sideOk)
                        {
                            reasons.Add(new QuarantineReason
                            {
                                Code = CodeGroundingSideMismatch,
                                Message = $"Architect evidence '{evidenceId}' has invalid side '{evidence.Side}' (expected 'left' or 'right').",
                                EvidenceId = evidenceId,
                                FieldPath = $"groundingEvidence.side",
                            });
                            groundingFailed = true;
                            continue;
                        }

                        // Spec §4: newLine is the line "in the side's view".
                        // For side=left it is the pre-change line; for side
                        // =right it is the post-change line. The proximity
                        // check tolerates a small window around real changed
                        // lines because the LLM cannot count lines reliably
                        // in a large diff — exact-match would quarantine
                        // genuinely-grounded evidence whose citation is off
                        // by a handful of lines. See LineProximityTolerance.
                        var path = evidence.RepoRelativePath ?? string.Empty;
                        var side = evidence.Side?.ToLowerInvariant() ?? "right";
                        var citedLine = evidence.NewLine;
                        var withinTolerance = false;
                        if (changedLineIndex.TryGetValue((path, side), out var sideLines))
                        {
                            foreach (var dl in sideLines)
                            {
                                if (Math.Abs(dl - citedLine) <= LineProximityTolerance)
                                {
                                    withinTolerance = true;
                                    break;
                                }
                            }
                        }
                        if (!withinTolerance)
                        {
                            reasons.Add(new QuarantineReason
                            {
                                Code = CodeGroundingLineNotInDiff,
                                Message = $"Architect evidence '{evidenceId}' cites {evidence.RepoRelativePath}:{evidence.NewLine} (side={evidence.Side}) but the diff has no changed line within {LineProximityTolerance} lines on that side.",
                                EvidenceId = evidenceId,
                                FieldPath = $"groundingEvidence.newLine",
                            });
                            groundingFailed = true;
                        }
                    }
                }

                // ── Gate 2: schema-constraints ──────────────────────────
                ValidateLength(scenario.Title, MaxTitleLength, "title", reasons);
                ValidateLength(scenario.Description, MaxDescriptionLength, "description", reasons);
                ValidateRange(scenario.Priority, MinPriority, MaxPriority, "priority", reasons);
                ValidateRange(scenario.TimeoutMs, MinTimeoutMs, MaxTimeoutMs, "timeoutMs", reasons);

                ValidateEnumMembership(scenario.Category, ValidCategories, "category", reasons);
                ValidateEnumMembership(scenario.Technique, ValidTechniques, "technique", reasons);
                ValidateEnumMembership(scenario.StimulusType, ValidStimulusTypes, "stimulusType", reasons);

                if (string.IsNullOrWhiteSpace(scenario.StimulusSpec))
                {
                    reasons.Add(new QuarantineReason
                    {
                        Code = CodeFieldEmpty,
                        Message = "stimulusSpec must not be empty.",
                        FieldPath = "stimulusSpec",
                    });
                }

                if (scenario.Expectations == null || scenario.Expectations.Count == 0)
                {
                    reasons.Add(new QuarantineReason
                    {
                        Code = CodeExpectationsMissing,
                        Message = "Scenario must declare at least one expectation.",
                        FieldPath = "expectations",
                    });
                }
                else
                {
                    for (int i = 0; i < scenario.Expectations.Count; i++)
                    {
                        var exp = scenario.Expectations[i];
                        var pathPrefix = $"expectations[{i}]";

                        ValidateEnumMembership(exp.Type, ValidExpectationTypes, $"{pathPrefix}.type", reasons);

                        if (string.IsNullOrWhiteSpace(exp.MatcherSpec))
                        {
                            reasons.Add(new QuarantineReason
                            {
                                Code = CodeFieldEmpty,
                                Message = "matcherSpec must not be empty.",
                                FieldPath = $"{pathPrefix}.matcherSpec",
                            });
                        }

                        // Gate 3: topic vocabulary (inlined here so the
                        // FieldPath points at the right expectation index).
                        if (!string.IsNullOrEmpty(exp.Topic) && !topicSet.Contains(exp.Topic))
                        {
                            reasons.Add(new QuarantineReason
                            {
                                Code = CodeTopicUnknown,
                                Message = $"Expectation topic '{exp.Topic}' is not a registered interceptor topic.",
                                FieldPath = $"{pathPrefix}.topic",
                            });
                        }
                    }
                }

                ValidateTypedMatchers(scenario, topicSet, reasons);

                // ── Gate 4: confidence calibration ──────────────────────
                // Clamp to [0, 1] silently (clamping is mechanical, not a
                // user-facing fault). Cap at 0.7 if grounding failed; the
                // cap is informational — it lowers the scenario's surfaced
                // confidence but does NOT quarantine on its own.
                double clamped = double.IsNaN(scenario.Confidence) ? 0.0 : scenario.Confidence;
                if (clamped < 0.0) clamped = 0.0;
                if (clamped > 1.0) clamped = 1.0;

                double calibrated = clamped;
                if (groundingFailed && calibrated > 0.7)
                {
                    informational.Add(new QuarantineReason
                    {
                        Code = CodeConfidenceCapped,
                        Message = $"Confidence capped from {clamped:F2} to 0.70 because at least one grounding ref failed validation.",
                        FieldPath = "confidence",
                    });
                    calibrated = 0.7;
                }

                // ── Gate 5: intra-batch dedup ───────────────────────────
                // Compute the semantic hash even if upstream gates failed —
                // the orchestrator's reducer wants it for telemetry; but
                // only enforce dedup on scenarios that would otherwise
                // pass (don't double-penalise a quarantined scenario).
                var hash = ComputeSemanticHash(scenario);
                if (reasons.Count == 0 && seenHashes.TryGetValue(hash, out var first))
                {
                    reasons.Add(new QuarantineReason
                    {
                        Code = CodeDuplicateInBatch,
                        Message = $"Scenario duplicates an earlier accepted scenario (semanticHash={hash[..16]}, first sketch={first.Id}).",
                        FieldPath = null,
                    });
                }

                if (reasons.Count > 0)
                {
                    result.Quarantined.Add(new QuarantinedScenario
                    {
                        Scenario = scenario,
                        Reasons = reasons,
                    });
                }
                else
                {
                    seenHashes[hash] = scenario;
                    result.Accepted.Add(new AcceptedScenario
                    {
                        Scenario = scenario,
                        SemanticHash = hash,
                        CalibratedConfidence = calibrated,
                        InformationalReasons = informational,
                    });
                }
            }

            // ── F27 P11: batch-scoped coverage gate ─────────────────────
            // When the Architect emitted a testingGuidance block, surface
            // coverage gaps (Added codePaths and errorModes not addressed by
            // any accepted scenario) as BatchInformationalReasons. These are
            // advisory in Phase 1; the orchestrator surfaces them via
            // OrchestratorEvent { Kind=ZoneValidated }.
            //
            // GeneratedScenario doesn't yet carry the sketch's
            // addressesCodePathIds / addressesErrorModeIds (the orchestrator
            // copies them onto the projected Scenario after Validate). So we
            // resolve via SketchId → matching plan.ScenarioSketches entry.
            if (testingGuidance != null
                && plan.PlanOutcome == EdogQaLlmClient.PlanOutcomeTestable
                && result.Accepted.Count > 0)
            {
                var sketches = plan.ScenarioSketches ?? new List<EdogQaLlmClient.ScenarioSketch>();
                var sketchById = new Dictionary<string, EdogQaLlmClient.ScenarioSketch>(StringComparer.Ordinal);
                foreach (var s in sketches)
                {
                    if (s != null && !string.IsNullOrEmpty(s.SketchId)) sketchById[s.SketchId] = s;
                }
                var acceptedCodePathIds = new HashSet<string>(StringComparer.Ordinal);
                var acceptedErrorModeIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var a in result.Accepted)
                {
                    if (a?.Scenario == null) continue;
                    var sid = a.Scenario.SketchId;
                    if (string.IsNullOrEmpty(sid)) continue;
                    if (!sketchById.TryGetValue(sid, out var sketch) || sketch == null) continue;
                    if (sketch.AddressesCodePathIds != null)
                    {
                        foreach (var id in sketch.AddressesCodePathIds)
                        {
                            if (!string.IsNullOrWhiteSpace(id)) acceptedCodePathIds.Add(id);
                        }
                    }
                    if (sketch.AddressesErrorModeIds != null)
                    {
                        foreach (var id in sketch.AddressesErrorModeIds)
                        {
                            if (!string.IsNullOrWhiteSpace(id)) acceptedErrorModeIds.Add(id);
                        }
                    }
                }

                var codePaths = testingGuidance.CodePaths ?? new List<EdogQaLlmClient.CodePathItem>();
                var gapCount = 0;
                foreach (var cp in codePaths)
                {
                    if (cp == null || string.IsNullOrWhiteSpace(cp.Id)) continue;
                    if (string.Equals(cp.ChangeKind, "Added", StringComparison.Ordinal)
                        && !acceptedCodePathIds.Contains(cp.Id))
                    {
                        result.BatchInformationalReasons.Add(new QuarantineReason
                        {
                            Code = "P11_COVERAGE_GAP",
                            Message = $"codePath '{cp.Id}' (Added) is not covered by any accepted scenario.",
                        });
                        gapCount++;
                    }
                }

                var errorModes = testingGuidance.ErrorModesToTest ?? new List<EdogQaLlmClient.ErrorModeItem>();
                foreach (var em in errorModes)
                {
                    if (em == null || string.IsNullOrWhiteSpace(em.Id)) continue;
                    if (!acceptedErrorModeIds.Contains(em.Id))
                    {
                        result.BatchInformationalReasons.Add(new QuarantineReason
                        {
                            Code = "P11_COVERAGE_GAP",
                            Message = $"errorMode '{em.Id}' is not covered by any accepted scenario.",
                        });
                        gapCount++;
                    }
                }

                var totalAdded = 0;
                foreach (var cp in codePaths)
                {
                    if (cp != null && string.Equals(cp.ChangeKind, "Added", StringComparison.Ordinal)) totalAdded++;
                }
                result.BatchInformationalReasons.Add(new QuarantineReason
                {
                    Code = "P11_COVERAGE_REPORT",
                    Message = $"accepted={result.Accepted.Count}, addedCodePaths={totalAdded}, errorModes={errorModes.Count}, gaps={gapCount}.",
                });
            }

            return result;
        }

        // ──────────────────────────────────────────────────────────────
        // Helpers — all pure, deterministic, side-effect free.
        // ──────────────────────────────────────────────────────────────

        private static Dictionary<string, EdogQaLlmClient.ArchitectGroundingEvidence> BuildEvidenceLookup(
            EdogQaLlmClient.ArchitectPlan plan)
        {
            var map = new Dictionary<string, EdogQaLlmClient.ArchitectGroundingEvidence>(StringComparer.Ordinal);
            if (plan.GroundingEvidence == null) return map;
            foreach (var ev in plan.GroundingEvidence)
            {
                if (ev?.EvidenceId == null) continue;
                map[ev.EvidenceId] = ev;
            }
            return map;
        }

        /// <summary>
        /// Parse a unified diff into the set of <c>(repoRelativePath, side,
        /// lineNumber)</c> tuples that correspond to ACTUAL changed lines.
        /// Both pre-change (<c>side="left"</c>) and post-change
        /// (<c>side="right"</c>) projections are emitted; context lines are
        /// NOT included (gate 1 rejects evidence pointing at context).
        /// </summary>
        /// <remarks>
        /// This is a deliberately simple line-walker; it does not validate
        /// hunk headers exhaustively — a malformed hunk is treated as a
        /// no-op (the resulting tuple set is empty for that region and
        /// gate 1 surfaces the membership failure honestly). The
        /// orchestrator runs the Architect with the same diff parser so
        /// drift between "what was given" and "what Validator sees" is not
        /// possible.
        /// </remarks>
        internal static HashSet<(string Path, string Side, int Line)> ParseChangedLines(string unifiedDiff)
        {
            var result = new HashSet<(string, string, int)>();
            if (string.IsNullOrEmpty(unifiedDiff)) return result;

            string currentPath = null;
            int oldLine = 0;
            int newLine = 0;
            bool inHunk = false;

            foreach (var rawLine in unifiedDiff.Split('\n'))
            {
                var line = rawLine.TrimEnd('\r');

                // File header. We use the post-image path (+++ b/...) as
                // the canonical repo-relative path; rename detection is
                // out of scope for T1c-a.
                if (line.StartsWith("+++ ", StringComparison.Ordinal))
                {
                    var p = line.Substring(4).Trim();
                    if (p.StartsWith("b/", StringComparison.Ordinal)) p = p[2..];
                    if (p == "/dev/null") p = null;
                    currentPath = p;
                    inHunk = false;
                    continue;
                }
                if (line.StartsWith("--- ", StringComparison.Ordinal))
                {
                    inHunk = false;
                    continue;
                }

                // Hunk header — extract starting line numbers.
                if (line.StartsWith("@@", StringComparison.Ordinal))
                {
                    if (TryParseHunkHeader(line, out var oStart, out var nStart))
                    {
                        oldLine = oStart;
                        newLine = nStart;
                        inHunk = true;
                    }
                    else
                    {
                        inHunk = false;
                    }
                    continue;
                }

                if (!inHunk || currentPath == null) continue;

                if (line.StartsWith("+", StringComparison.Ordinal))
                {
                    result.Add((currentPath, "right", newLine));
                    newLine++;
                }
                else if (line.StartsWith("-", StringComparison.Ordinal))
                {
                    result.Add((currentPath, "left", oldLine));
                    oldLine++;
                }
                else if (line.StartsWith(" ", StringComparison.Ordinal) || line.Length == 0)
                {
                    // Context line — advance both counters, do NOT emit.
                    oldLine++;
                    newLine++;
                }
                else if (line.StartsWith("\\", StringComparison.Ordinal))
                {
                    // "\ No newline at end of file" — ignored.
                }
                else
                {
                    // Anything else terminates the hunk so we don't leak
                    // counters into the next file's contents.
                    inHunk = false;
                }
            }

            return result;
        }

        private static bool TryParseHunkHeader(string line, out int oldStart, out int newStart)
        {
            // Format: @@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@ <ctx>
            oldStart = 0;
            newStart = 0;
            int dashIdx = line.IndexOf('-');
            int plusIdx = line.IndexOf('+', dashIdx < 0 ? 0 : dashIdx);
            int closeIdx = line.IndexOf("@@", 2, StringComparison.Ordinal);
            if (dashIdx < 0 || plusIdx < 0 || closeIdx < plusIdx) return false;

            var oldPart = line.Substring(dashIdx + 1, plusIdx - dashIdx - 2).Trim();
            var newPart = line.Substring(plusIdx + 1, closeIdx - plusIdx - 2).Trim();

            // Strip the optional ",N" suffix.
            var oldFirst = oldPart.Split(',')[0];
            var newFirst = newPart.Split(',')[0];

            return int.TryParse(oldFirst, NumberStyles.Integer, CultureInfo.InvariantCulture, out oldStart)
                && int.TryParse(newFirst, NumberStyles.Integer, CultureInfo.InvariantCulture, out newStart);
        }

        private static void ValidateLength(string value, int maxLen, string fieldPath, List<QuarantineReason> sink)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                sink.Add(new QuarantineReason
                {
                    Code = CodeFieldEmpty,
                    Message = $"{fieldPath} must not be empty.",
                    FieldPath = fieldPath,
                });
                return;
            }
            if (value.Length > maxLen)
            {
                sink.Add(new QuarantineReason
                {
                    Code = CodeFieldTooLong,
                    Message = $"{fieldPath} length {value.Length} exceeds maximum {maxLen}.",
                    FieldPath = fieldPath,
                });
            }
        }

        private static void ValidateRange(int value, int min, int max, string fieldPath, List<QuarantineReason> sink)
        {
            if (value < min || value > max)
            {
                sink.Add(new QuarantineReason
                {
                    Code = CodeFieldOutOfRange,
                    Message = $"{fieldPath} value {value} is outside the inclusive range [{min}, {max}].",
                    FieldPath = fieldPath,
                });
            }
        }

        private static void ValidateTypedMatchers(
            EdogQaLlmClient.GeneratedScenario scenario,
            HashSet<string> topicSet,
            List<QuarantineReason> sink)
        {
            if (scenario?.Matchers == null || scenario.Matchers.Count == 0)
            {
                return;
            }

            var matcherTopicHashes = scenario.CatalogHashes?.MatcherTopicHashes;
            // P10 fix (P0-1): only enforce the catalog-grounding gate when the
            // scenario claims grounding (CatalogSnapshotId set). When the
            // snapshot is unavailable (LLM emitted empty hashes), degrade
            // gracefully — the scenario still runs but loses staleness
            // protection. The execution-engine preflight handles the
            // "snapshot available but hashes empty" mismatch.
            var hasGroundingClaim = !string.IsNullOrWhiteSpace(scenario.CatalogHashes?.CatalogSnapshotId);
            for (int i = 0; i < scenario.Matchers.Count; i++)
            {
                var matcher = scenario.Matchers[i];
                var pathPrefix = $"matchers[{i}]";
                if (matcher == null)
                {
                    sink.Add(new QuarantineReason
                    {
                        Code = CodeFieldEmpty,
                        Message = "matchers entries must not be null.",
                        FieldPath = pathPrefix,
                    });
                    continue;
                }

                if (string.IsNullOrWhiteSpace(matcher.TopicField))
                {
                    sink.Add(new QuarantineReason
                    {
                        Code = CodeFieldEmpty,
                        Message = "matcher.topicField must not be empty.",
                        FieldPath = $"{pathPrefix}.topicField",
                    });
                }
                else
                {
                    var topic = ExtractMatcherTopic(matcher.TopicField);
                    if (!string.IsNullOrWhiteSpace(topic) && topicSet.Count > 0 && !topicSet.Contains(topic))
                    {
                        sink.Add(new QuarantineReason
                        {
                            Code = CodeTopicUnknown,
                            Message = $"Matcher topic '{topic}' is not a registered interceptor topic.",
                            FieldPath = $"{pathPrefix}.topicField",
                        });
                    }

                    // Field-level validation: check full topicField against canonical registry
                    if (!string.IsNullOrWhiteSpace(matcher.TopicField)
                        && !EdogQaLlmClient.AllValidTopicFields.Contains(matcher.TopicField))
                    {
                        var fieldTopic = ExtractMatcherTopic(matcher.TopicField);
                        if (EdogQaLlmClient.WellModeledTopics.Contains(fieldTopic))
                        {
                            sink.Add(new QuarantineReason
                            {
                                Code = CodeTopicUnknown,
                                Message = $"Matcher topicField '{matcher.TopicField}' is not a valid field for topic '{fieldTopic}'. Valid fields: {string.Join(", ", EdogQaLlmClient.TopicFieldRegistry.GetValueOrDefault(fieldTopic, Array.Empty<string>()))}.",
                                FieldPath = $"{pathPrefix}.topicField",
                            });
                        }
                        // else: under-modeled topic — skip field validation (catalog incomplete)
                    }

                    if (hasGroundingClaim && (matcherTopicHashes == null || matcherTopicHashes.Count == 0))
                    {
                        sink.Add(new QuarantineReason
                        {
                            Code = CodeGroundingSlotMismatch,
                            Message = "Typed matchers require catalogHashes.matcherTopicHashes so the scenario stays grounded to the active catalog.",
                            FieldPath = "catalogHashes.matcherTopicHashes",
                        });
                    }
                    else if (hasGroundingClaim && matcherTopicHashes != null && !string.IsNullOrWhiteSpace(topic) && !matcherTopicHashes.ContainsKey(topic))
                    {
                        sink.Add(new QuarantineReason
                        {
                            Code = CodeGroundingSlotMismatch,
                            Message = $"Matcher topic '{topic}' is not present in catalogHashes.matcherTopicHashes.",
                            FieldPath = $"{pathPrefix}.topicField",
                        });
                    }
                }

                if (!IsMatcherValueCompatible(matcher.Assertion, matcher.Value))
                {
                    sink.Add(new QuarantineReason
                    {
                        Code = CodeMatcherValueTypeInvalid,
                        Message = $"Matcher assertion '{matcher.Assertion}' is incompatible with the supplied typed value payload.",
                        FieldPath = $"{pathPrefix}.value",
                    });
                }
            }
        }

        private static string ExtractMatcherTopic(string topicField)
        {
            if (string.IsNullOrWhiteSpace(topicField))
            {
                return string.Empty;
            }

            var separator = topicField.IndexOf('.');
            return separator > 0 ? topicField.Substring(0, separator) : topicField;
        }

        private static bool IsMatcherValueCompatible(string assertion, JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            // Single-shape matcher value: requires a `kind` discriminator
            // (e.g. `string_literal`, `range`, `exists`). The legacy
            // {type, value} payload is no longer accepted.
            string discriminator = null;
            if (value.TryGetProperty("kind", out var kindElement) && kindElement.ValueKind == JsonValueKind.String)
            {
                discriminator = kindElement.GetString();
            }

            if (string.IsNullOrEmpty(discriminator))
            {
                return false;
            }

            bool IsKind(params string[] allowed)
            {
                foreach (var a in allowed)
                {
                    if (string.Equals(discriminator, a, StringComparison.OrdinalIgnoreCase)) return true;
                }
                return false;
            }

            switch (assertion ?? string.Empty)
            {
                case "Exists":
                    return IsKind("exists") && value.TryGetProperty("expected", out _);
                case "InRange":
                    return IsKind("range")
                        && value.TryGetProperty("min", out _)
                        && value.TryGetProperty("max", out _);
                case "ContainsAll":
                case "OneOf":
                    return IsKind("array_literal")
                        && value.TryGetProperty("items", out _);
                case "Length":
                    return IsKind("length_bound")
                        && (value.TryGetProperty("min", out _) || value.TryGetProperty("max", out _));
                case "Equals":
                case "NotEquals":
                    return IsKind("string_literal", "integer_literal", "boolean_literal")
                        && value.TryGetProperty("literal", out _);
                default:
                    return true;
            }
        }

        private static void ValidateEnumMembership(string value, HashSet<string> allowed, string fieldPath, List<QuarantineReason> sink)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                sink.Add(new QuarantineReason
                {
                    Code = CodeFieldEmpty,
                    Message = $"{fieldPath} must not be empty.",
                    FieldPath = fieldPath,
                });
                return;
            }
            if (!allowed.Contains(value))
            {
                sink.Add(new QuarantineReason
                {
                    Code = CodeEnumValueInvalid,
                    Message = $"{fieldPath} value '{value}' is not a recognised vocabulary member.",
                    FieldPath = fieldPath,
                });
            }
        }

        /// <summary>
        /// Compute a deterministic SHA-256 of the scenario's behavioural
        /// identity: stimulus type + canonical stimulus payload + sorted
        /// canonicalised expectations. Title, description, confidence,
        /// grounding refs, and generated IDs are EXCLUDED — two scenarios
        /// with different titles but identical behaviour are duplicates
        /// (spec §3.2 step 4). Hex-encoded, lower-case.
        /// </summary>
        internal static string ComputeSemanticHash(EdogQaLlmClient.GeneratedScenario scenario)
        {
            var sb = new StringBuilder();
            sb.Append("stimulus|").Append(scenario.StimulusType ?? string.Empty).Append('|');
            sb.Append(CanonicalisePayload(scenario.StimulusSpec));

            if (scenario.Expectations != null && scenario.Expectations.Count > 0)
            {
                var rendered = scenario.Expectations
                    .Where(e => e != null)
                    .Select(e =>
                        new StringBuilder()
                            .Append("exp|")
                            .Append(e.Type ?? string.Empty).Append('|')
                            .Append(e.Topic ?? string.Empty).Append('|')
                            .Append(CanonicalisePayload(e.MatcherSpec))
                            .ToString())
                    .OrderBy(s => s, StringComparer.Ordinal)
                    .ToList();
                foreach (var r in rendered)
                {
                    sb.Append("||").Append(r);
                }
            }

            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
            var hex = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            return hex.ToString();
        }

        /// <summary>
        /// Best-effort canonicalisation for a JSON-as-string payload: parse,
        /// re-serialise with property names sorted by ordinal. Non-JSON input
        /// falls through as-is. Dedup correctness depends only on this being
        /// REPRODUCIBLE — not on it being a perfect JSON canonicaliser.
        /// </summary>
        private static string CanonicalisePayload(string maybeJson)
        {
            if (string.IsNullOrEmpty(maybeJson)) return string.Empty;
            try
            {
                using var doc = JsonDocument.Parse(maybeJson);
                using var ms = new System.IO.MemoryStream();
                using (var writer = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = false }))
                {
                    WriteCanonical(writer, doc.RootElement);
                }
                return Encoding.UTF8.GetString(ms.ToArray());
            }
            catch (JsonException)
            {
                return maybeJson;
            }
        }

        private static void WriteCanonical(Utf8JsonWriter writer, JsonElement element)
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.Object:
                    writer.WriteStartObject();
                    foreach (var prop in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                    {
                        writer.WritePropertyName(prop.Name);
                        WriteCanonical(writer, prop.Value);
                    }
                    writer.WriteEndObject();
                    break;
                case JsonValueKind.Array:
                    // Arrays preserve order — semantic order matters for e.g.
                    // method-argument lists. If a payload's array is order-
                    // insensitive, the Architect/Editor is expected to emit
                    // it sorted.
                    writer.WriteStartArray();
                    foreach (var item in element.EnumerateArray())
                    {
                        WriteCanonical(writer, item);
                    }
                    writer.WriteEndArray();
                    break;
                case JsonValueKind.String:
                    writer.WriteStringValue(element.GetString());
                    break;
                case JsonValueKind.Number:
                    writer.WriteRawValue(element.GetRawText(), skipInputValidation: true);
                    break;
                case JsonValueKind.True:
                    writer.WriteBooleanValue(true);
                    break;
                case JsonValueKind.False:
                    writer.WriteBooleanValue(false);
                    break;
                case JsonValueKind.Null:
                    writer.WriteNullValue();
                    break;
                default:
                    writer.WriteNullValue();
                    break;
            }
        }
    }
}
