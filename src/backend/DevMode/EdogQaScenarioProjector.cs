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

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
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
            IReadOnlyList<EdogQaScenarioValidator.AcceptedScenario> accepted)
        {
            if (plan == null) throw new ArgumentNullException(nameof(plan));
            if (accepted == null) throw new ArgumentNullException(nameof(accepted));

            var evidenceById = (plan.GroundingEvidence ?? new())
                .Where(e => !string.IsNullOrWhiteSpace(e?.EvidenceId))
                .GroupBy(e => e.EvidenceId, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

            var result = new ProjectionResult();
            foreach (var acc in accepted)
            {
                var reasons = new List<EdogQaScenarioValidator.QuarantineReason>();
                var projected = ProjectOne(acc, evidenceById, reasons);
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
                    result.Projected.Add(projected);
                }
            }

            return result;
        }

        // ──────────────────────────────────────────────────────────────
        // Per-scenario projection. Accumulates reasons into the provided
        // list; returns null if any reason was emitted.
        // ──────────────────────────────────────────────────────────────

        private static Scenario ProjectOne(
            EdogQaScenarioValidator.AcceptedScenario accepted,
            IReadOnlyDictionary<string, EdogQaLlmClient.ArchitectGroundingEvidence> evidenceById,
            List<EdogQaScenarioValidator.QuarantineReason> reasons)
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
            var stimulus = new Stimulus { Type = stimulusType };
            using (var stimulusDoc = TryParseJson(src.StimulusSpec, out var stimulusParseFail))
            {
                if (stimulusParseFail != null)
                {
                    reasons.Add(MakeReason(CodeStimulusSpecMalformed, "stimulusSpec", null, stimulusParseFail));
                    return null;
                }

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

            if (reasons.Count > 0) return null;

            // Expectations — each carries its own MatcherSpec.
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
                Expectations = expectations,
                TimeoutMs = src.TimeoutMs > 0 ? src.TimeoutMs : 30_000,
                Metadata = new ScenarioMetadata
                {
                    Confidence = accepted.CalibratedConfidence,
                    GeneratedBy = "ai",
                    GeneratedAt = DateTimeOffset.UtcNow,
                },
                GroundingEvidence = grounding,
                InvariantsAddressed = new List<string>(),
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
            if (TryGetString(root, "path", out var path)) spec.Path = path;
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
                        spec.Headers[h.Name] = h.Value.GetString();
                }
            }
            return spec;
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

        // ──────────────────────────────────────────────────────────────
        // Helpers.
        // ──────────────────────────────────────────────────────────────

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
            catch (JsonException ex)
            {
                error = $"Spec is not valid JSON: {ex.Message}";
                return JsonDocument.Parse("{}");
            }
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
