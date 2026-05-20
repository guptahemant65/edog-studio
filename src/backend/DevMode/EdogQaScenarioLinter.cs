// <copyright file="EdogQaScenarioLinter.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Security.Cryptography;
    using System.Text;
    using System.Text.Json;

    /// <summary>
    /// Severity of a lint finding. The convention is:
    /// <list type="bullet">
    ///   <item><c>Error</c> — the scenario is unusable; the curator MUST fix or discard it.
    ///     Examples: hallucinated endpoint path, missing technique, empty grounding.</item>
    ///   <item><c>Warning</c> — the scenario will execute but its quality is below
    ///     the contract bar. Examples: counterfactual missing EventAbsent assertion,
    ///     boundary triplet that is actually a doublet.</item>
    ///   <item><c>Info</c> — informational signal (style, hint); no action required.</item>
    /// </list>
    /// </summary>
    [System.Text.Json.Serialization.JsonConverter(typeof(System.Text.Json.Serialization.JsonStringEnumConverter))]
    public enum LintSeverity
    {
        Info,
        Warning,
        Error
    }

    /// <summary>
    /// A single lint finding. Findings are batch-level (no scenario) when
    /// they describe a coverage gap (an invariant with no addressing scenario),
    /// otherwise they target a specific scenario via <see cref="ScenarioId"/>.
    /// </summary>
    public sealed class LintFinding
    {
        /// <summary>Stable rule identifier of the form "LNT###_PascalCase".</summary>
        public string Code { get; set; }

        /// <summary>Severity classification — see <see cref="LintSeverity"/>.</summary>
        public LintSeverity Severity { get; set; }

        /// <summary>Human-readable message. Includes the offending value verbatim where applicable.</summary>
        public string Message { get; set; }

        /// <summary>Scenario this finding targets, or null for batch-level findings.</summary>
        public string ScenarioId { get; set; }

        /// <summary>Invariant ID this finding references, when applicable.</summary>
        public string InvariantId { get; set; }
    }

    /// <summary>
    /// Deterministic post-LLM scenario validator (F27 "pinnacle" item 5).
    ///
    /// <para>The LLM, even with PR-A's contract context + invariant grounding +
    /// few-shot exemplars, will occasionally drift: misspell a path, skip the
    /// technique field, fabricate a file:line reference, leave a boundary
    /// triplet at two scenarios, forget the EventAbsent half of a counterfactual.
    /// The linter is the layer that catches that drift before the scenarios
    /// reach the curation UI.</para>
    ///
    /// <para>All rules are pure functions of <c>(scenarios, prContext)</c>;
    /// no I/O, no LLM call-back, no Roslyn. This keeps the linter fast (a few
    /// ms per batch), reproducible (same input always yields same findings),
    /// and easy to unit-test from Python via shape assertions.</para>
    ///
    /// <para>Rule catalog:</para>
    /// <list type="table">
    ///   <listheader><term>Code</term><description>What it checks</description></listheader>
    ///   <item><term>LNT001_PathInCatalog</term><description>HTTP stimulus path matches an endpoint URL template from <see cref="PrContext.ApiCatalog"/>.</description></item>
    ///   <item><term>LNT002_InvariantCoverage</term><description>Every detected invariant is cited by at least one scenario.</description></item>
    ///   <item><term>LNT003_TechniqueRequired</term><description><c>Scenario.Technique</c> is set to a value other than <c>NotSpecified</c>.</description></item>
    ///   <item><term>LNT004_GroundingEvidenceMissing</term><description><c>Scenario.GroundingEvidence</c> has at least one entry with non-empty file and reason.</description></item>
    ///   <item><term>LNT005_GroundingFileInDiff</term><description>Each evidence file appears in <see cref="PrContext"/> (best effort — matches against the catalog controllers and invariant file set).</description></item>
    ///   <item><term>LNT006_BoundaryTripletComplete</term><description>If a scenario uses technique <c>BoundaryTriplet</c>, the batch must contain at least 3 such scenarios citing at least one shared invariant.</description></item>
    ///   <item><term>LNT007_CounterfactualHasAbsent</term><description>Counterfactual scenarios must include at least one <c>EventAbsent</c> expectation.</description></item>
    ///   <item><term>LNT008_EvidenceConsistency</term><description>If <see cref="GroundingEvidence.InvariantId"/> is set, it must appear in the scenario's <see cref="Scenario.InvariantsAddressed"/>.</description></item>
    ///   <item><term>LNT009_NoDuplicateStimulus</term><description>No two scenarios share the same (method, path, body-hash) tuple.</description></item>
    ///   <item><term>LNT010_TruthTableCells</term><description>When two or more <c>added_parameter</c> invariants exist, the batch must contain at least four scenarios of technique <c>TruthTable</c> covering the 2x2 grid (or 2^N for N=3).</description></item>
    /// </list>
    ///
    /// <para>The linter never throws; rule evaluation failures are caught and
    /// emitted as <c>LNT999_RuleFailed</c> warnings so a buggy rule does not
    /// gate scenario delivery.</para>
    /// </summary>
    public static class EdogQaScenarioLinter
    {
        private const int MaxFindings = 200;

        /// <summary>
        /// Run all rules against the scenario batch and return the
        /// findings list. Stable ordering: findings are returned in
        /// rule-code order, then scenario-id order, so consumers can
        /// diff two lint runs deterministically.
        /// </summary>
        /// <param name="scenarios">The scenarios to validate. Null or empty yields an empty findings list.</param>
        /// <param name="context">PR context with <see cref="PrContext.Invariants"/> and <see cref="PrContext.ApiCatalog"/>. Null is acceptable; rules that depend on missing context skip.</param>
        /// <returns>Findings, deduplicated and stably ordered, capped at <see cref="MaxFindings"/> entries.</returns>
        public static List<LintFinding> Lint(IReadOnlyList<Scenario> scenarios, PrContext context)
        {
            var findings = new List<LintFinding>();
            if (scenarios == null || scenarios.Count == 0) return findings;

            // LNT001 — path matches catalog
            SafeRun("LNT001", findings, () => CheckPathInCatalog(scenarios, context, findings));

            // LNT002 — invariant coverage
            SafeRun("LNT002", findings, () => CheckInvariantCoverage(scenarios, context, findings));

            // LNT003 — technique set
            SafeRun("LNT003", findings, () => CheckTechniqueRequired(scenarios, findings));

            // LNT004 — grounding evidence non-empty
            SafeRun("LNT004", findings, () => CheckGroundingEvidence(scenarios, findings));

            // LNT005 — grounding file present in diff context
            SafeRun("LNT005", findings, () => CheckGroundingFileInDiff(scenarios, context, findings));

            // LNT006 — boundary triplet completeness
            SafeRun("LNT006", findings, () => CheckBoundaryTripletComplete(scenarios, findings));

            // LNT007 — counterfactual has EventAbsent
            SafeRun("LNT007", findings, () => CheckCounterfactualHasAbsent(scenarios, findings));

            // LNT008 — evidence-invariant consistency
            SafeRun("LNT008", findings, () => CheckEvidenceConsistency(scenarios, findings));

            // LNT009 — duplicate stimulus
            SafeRun("LNT009", findings, () => CheckDuplicateStimulus(scenarios, findings));

            // LNT010 — truth-table cell count
            SafeRun("LNT010", findings, () => CheckTruthTableCells(scenarios, context, findings));

            // Stable order + cap.
            return findings
                .OrderBy(f => f.Code, StringComparer.Ordinal)
                .ThenBy(f => f.ScenarioId ?? string.Empty, StringComparer.Ordinal)
                .ThenBy(f => f.Message ?? string.Empty, StringComparer.Ordinal)
                .Take(MaxFindings)
                .ToList();
        }

        // ──────────────────────────────────────────────────────────
        // Rule implementations
        // ──────────────────────────────────────────────────────────

        /// <summary>LNT001 — HTTP stimulus paths must match catalog endpoints.</summary>
        private static void CheckPathInCatalog(
            IReadOnlyList<Scenario> scenarios, PrContext ctx, List<LintFinding> findings)
        {
            var catalog = ctx?.ApiCatalog?.Endpoints;
            if (catalog == null || catalog.Count == 0) return;

            // Build a normalized template set: "/api/v1/foo/{id}/bar".
            // The dev-server emits the camelCase key `urlTemplate` for each
            // endpoint (see scripts/flt_catalog.py). Earlier versions of
            // this rule looked up only the snake form `url_template`, which
            // never matched — so this entire check was silently dead.
            // Keep snake forms as last-ditch fallbacks for future shapes.
            var templates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var ep in catalog)
            {
                if (ep == null) continue;
                var template = TryGetString(ep, "urlTemplate")
                            ?? TryGetString(ep, "url_template")
                            ?? TryGetString(ep, "path");
                if (!string.IsNullOrEmpty(template))
                {
                    templates.Add(template);
                }
            }
            if (templates.Count == 0) return;

            foreach (var s in scenarios)
            {
                var http = s?.Stimulus?.HttpRequest;
                if (http?.Path == null) continue;

                // Strip query string before template comparison.
                var bare = http.Path.Split('?')[0];
                if (!MatchesAnyTemplate(bare, templates))
                {
                    findings.Add(new LintFinding
                    {
                        Code = "LNT001_PathInCatalog",
                        Severity = LintSeverity.Error,
                        ScenarioId = s.Id,
                        Message = $"stimulus.path '{http.Path}' does not match any endpoint in the API catalog. " +
                                  $"Allowed templates (truncated): {string.Join(", ", templates.Take(5))}",
                    });
                }
            }
        }

        /// <summary>LNT002 — every detected invariant must be cited.</summary>
        private static void CheckInvariantCoverage(
            IReadOnlyList<Scenario> scenarios, PrContext ctx, List<LintFinding> findings)
        {
            var invariants = ctx?.Invariants;
            if (invariants == null || invariants.Count == 0) return;

            var cited = new HashSet<string>(StringComparer.Ordinal);
            foreach (var s in scenarios)
            {
                if (s?.InvariantsAddressed == null) continue;
                foreach (var id in s.InvariantsAddressed)
                {
                    if (!string.IsNullOrEmpty(id)) cited.Add(id);
                }
            }

            foreach (var inv in invariants)
            {
                if (string.IsNullOrEmpty(inv?.Id)) continue;
                if (!cited.Contains(inv.Id))
                {
                    findings.Add(new LintFinding
                    {
                        Code = "LNT002_InvariantCoverage",
                        Severity = LintSeverity.Warning,
                        InvariantId = inv.Id,
                        Message = $"Invariant {inv.Id} ({inv.Kind} {inv.Symbol ?? inv.Predicate}) " +
                                  "is not addressed by any scenario.",
                    });
                }
            }
        }

        /// <summary>LNT003 — technique must be explicitly set.</summary>
        private static void CheckTechniqueRequired(
            IReadOnlyList<Scenario> scenarios, List<LintFinding> findings)
        {
            foreach (var s in scenarios)
            {
                if (s == null) continue;
                if (s.Technique == ScenarioTechnique.NotSpecified)
                {
                    findings.Add(new LintFinding
                    {
                        Code = "LNT003_TechniqueRequired",
                        Severity = LintSeverity.Error,
                        ScenarioId = s.Id,
                        Message = "Scenario.technique is NotSpecified. Set to one of: " +
                                  "BoundaryTriplet, Counterfactual, TruthTable, EquivalencePartition, " +
                                  "ErrorPath, RegressionGuard, HappyPath.",
                    });
                }
            }
        }

        /// <summary>LNT004 — grounding evidence must be non-empty.</summary>
        private static void CheckGroundingEvidence(
            IReadOnlyList<Scenario> scenarios, List<LintFinding> findings)
        {
            foreach (var s in scenarios)
            {
                if (s == null) continue;
                var hasUsable = s.GroundingEvidence != null
                    && s.GroundingEvidence.Any(e =>
                        e != null
                        && !string.IsNullOrWhiteSpace(e.File)
                        && !string.IsNullOrWhiteSpace(e.Reason));
                if (!hasUsable)
                {
                    findings.Add(new LintFinding
                    {
                        Code = "LNT004_GroundingEvidenceMissing",
                        Severity = LintSeverity.Error,
                        ScenarioId = s.Id,
                        Message = "Scenario.groundingEvidence is empty or contains no usable entries. " +
                                  "Each scenario must cite at least one file:line range from the diff.",
                    });
                }
            }
        }

        /// <summary>LNT005 — every evidence.file should appear in the diff or catalog.</summary>
        private static void CheckGroundingFileInDiff(
            IReadOnlyList<Scenario> scenarios, PrContext ctx, List<LintFinding> findings)
        {
            // Build the set of files we know are in the PR. Sources:
            //   - PrContext.Invariants[*].File (from EdogQaInvariantExtractor)
            //   - PrContext.PriorTests[*].File (test files for changed controllers)
            //   - PrContext.ApiCatalog.Controllers (controller class names, fuzzy match)
            var knownFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (ctx?.Invariants != null)
            {
                foreach (var inv in ctx.Invariants)
                {
                    if (!string.IsNullOrEmpty(inv?.File)) knownFiles.Add(inv.File);
                }
            }
            if (ctx?.PriorTests != null)
            {
                foreach (var pt in ctx.PriorTests)
                {
                    if (!string.IsNullOrEmpty(pt?.File)) knownFiles.Add(pt.File);
                }
            }
            // If we have no diff-side files at all, skip the rule entirely
            // rather than emit false positives. The contract data was
            // unavailable; this is a degradation, not a scenario defect.
            if (knownFiles.Count == 0) return;

            var controllerNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (ctx?.ApiCatalog?.Controllers != null)
            {
                foreach (var c in ctx.ApiCatalog.Controllers)
                {
                    if (!string.IsNullOrEmpty(c)) controllerNames.Add(c);
                }
            }

            foreach (var s in scenarios)
            {
                if (s?.GroundingEvidence == null) continue;
                foreach (var ev in s.GroundingEvidence)
                {
                    if (ev == null || string.IsNullOrWhiteSpace(ev.File)) continue;
                    if (knownFiles.Contains(ev.File)) continue;
                    // Fuzzy controller match: evidence file ends with "{controller}.cs"
                    if (controllerNames.Any(c => ev.File.EndsWith($"{c}.cs", StringComparison.OrdinalIgnoreCase)))
                    {
                        continue;
                    }
                    findings.Add(new LintFinding
                    {
                        Code = "LNT005_GroundingFileInDiff",
                        Severity = LintSeverity.Warning,
                        ScenarioId = s.Id,
                        Message = $"GroundingEvidence.file '{ev.File}' does not match any file in the diff " +
                                  "or any controller in the API catalog. Possible hallucination.",
                    });
                }
            }
        }

        /// <summary>LNT006 — boundary triplet must have at least 3 scenarios sharing an invariant.</summary>
        private static void CheckBoundaryTripletComplete(
            IReadOnlyList<Scenario> scenarios, List<LintFinding> findings)
        {
            // Bucket BoundaryTriplet scenarios by each invariant they cite.
            var bucket = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var s in scenarios)
            {
                if (s == null || s.Technique != ScenarioTechnique.BoundaryTriplet) continue;
                if (s.InvariantsAddressed == null || s.InvariantsAddressed.Count == 0) continue;
                foreach (var id in s.InvariantsAddressed)
                {
                    if (string.IsNullOrEmpty(id)) continue;
                    if (!bucket.TryGetValue(id, out var list))
                    {
                        list = new List<string>();
                        bucket[id] = list;
                    }
                    list.Add(s.Id);
                }
            }

            foreach (var kv in bucket)
            {
                if (kv.Value.Count >= 3) continue;
                // For each BoundaryTriplet scenario in this bucket, emit a finding
                // so the UI shows the gap on every related card.
                foreach (var scnId in kv.Value)
                {
                    findings.Add(new LintFinding
                    {
                        Code = "LNT006_BoundaryTripletComplete",
                        Severity = LintSeverity.Warning,
                        ScenarioId = scnId,
                        InvariantId = kv.Key,
                        Message = $"BoundaryTriplet for invariant {kv.Key} only has {kv.Value.Count} scenario(s); " +
                                  "expected 3 (just-below / at / just-above the boundary).",
                    });
                }
            }
        }

        /// <summary>LNT007 — counterfactual scenarios must have an EventAbsent assertion.</summary>
        private static void CheckCounterfactualHasAbsent(
            IReadOnlyList<Scenario> scenarios, List<LintFinding> findings)
        {
            foreach (var s in scenarios)
            {
                if (s == null || s.Technique != ScenarioTechnique.Counterfactual) continue;
                var hasAbsent = s.Expectations != null
                    && s.Expectations.Any(e => e?.Type == ExpectationType.EventAbsent);
                if (!hasAbsent)
                {
                    findings.Add(new LintFinding
                    {
                        Code = "LNT007_CounterfactualHasAbsent",
                        Severity = LintSeverity.Warning,
                        ScenarioId = s.Id,
                        Message = "Counterfactual scenario has no EventAbsent expectation. " +
                                  "A counterfactual is only meaningful when it asserts that something does NOT happen.",
                    });
                }
            }
        }

        /// <summary>LNT008 — GroundingEvidence.InvariantId must appear in InvariantsAddressed.</summary>
        private static void CheckEvidenceConsistency(
            IReadOnlyList<Scenario> scenarios, List<LintFinding> findings)
        {
            foreach (var s in scenarios)
            {
                if (s?.GroundingEvidence == null) continue;
                var addressed = s.InvariantsAddressed ?? new List<string>();
                foreach (var ev in s.GroundingEvidence)
                {
                    if (ev == null || string.IsNullOrEmpty(ev.InvariantId)) continue;
                    if (!addressed.Contains(ev.InvariantId))
                    {
                        findings.Add(new LintFinding
                        {
                            Code = "LNT008_EvidenceConsistency",
                            Severity = LintSeverity.Warning,
                            ScenarioId = s.Id,
                            InvariantId = ev.InvariantId,
                            Message = $"GroundingEvidence.invariantId '{ev.InvariantId}' is not in the scenario's " +
                                      "invariantsAddressed list. Inconsistent citation.",
                        });
                    }
                }
            }
        }

        /// <summary>LNT009 — no two scenarios share the same (method, path, body-hash).</summary>
        private static void CheckDuplicateStimulus(
            IReadOnlyList<Scenario> scenarios, List<LintFinding> findings)
        {
            var seen = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var s in scenarios)
            {
                var key = StimulusKey(s?.Stimulus);
                if (key == null) continue;
                if (seen.TryGetValue(key, out var firstId))
                {
                    findings.Add(new LintFinding
                    {
                        Code = "LNT009_NoDuplicateStimulus",
                        Severity = LintSeverity.Warning,
                        ScenarioId = s.Id,
                        Message = $"Stimulus is identical to scenario '{firstId}'. Each scenario should " +
                                  "exercise a distinct path or input.",
                    });
                }
                else
                {
                    seen[key] = s.Id;
                }
            }
        }

        /// <summary>LNT010 — truth-table technique requires 2^N scenarios for N added_parameter invariants.</summary>
        private static void CheckTruthTableCells(
            IReadOnlyList<Scenario> scenarios, PrContext ctx, List<LintFinding> findings)
        {
            // Only fires when the diff actually introduced >=2 added_parameter invariants.
            var addedParamIds = ctx?.Invariants?
                .Where(i => i?.Kind == "added_parameter" && !string.IsNullOrEmpty(i.Id))
                .Select(i => i.Id)
                .Distinct(StringComparer.Ordinal)
                .ToList() ?? new List<string>();
            if (addedParamIds.Count < 2) return;

            var truthTableScenarios = scenarios
                .Where(s => s?.Technique == ScenarioTechnique.TruthTable)
                .ToList();

            // Each added_param invariant should appear in InvariantsAddressed of
            // at least one TruthTable scenario, AND the batch should have at
            // least 2^min(N,3) cells.
            int requiredCells = (int)Math.Pow(2, Math.Min(addedParamIds.Count, 3));
            if (truthTableScenarios.Count >= requiredCells) return;

            findings.Add(new LintFinding
            {
                Code = "LNT010_TruthTableCells",
                Severity = LintSeverity.Warning,
                Message = $"{addedParamIds.Count} added_parameter invariants present but only " +
                          $"{truthTableScenarios.Count} TruthTable scenario(s); expected >= {requiredCells} " +
                          "to cover the truth-table grid.",
            });
        }

        // ──────────────────────────────────────────────────────────
        // Helpers
        // ──────────────────────────────────────────────────────────

        /// <summary>
        /// Match a request path against a URL template, treating <c>{name}</c>
        /// segments as wildcards. Returns true when every literal segment in
        /// the template matches the corresponding request segment and the
        /// segment counts are equal.
        /// </summary>
        private static bool MatchesAnyTemplate(string path, HashSet<string> templates)
        {
            if (string.IsNullOrEmpty(path)) return false;
            var pathSegments = path.Trim('/').Split('/');
            foreach (var template in templates)
            {
                var tplSegments = template.Trim('/').Split('/');
                if (tplSegments.Length != pathSegments.Length) continue;
                bool match = true;
                for (int i = 0; i < tplSegments.Length; i++)
                {
                    var seg = tplSegments[i];
                    // Wildcard: starts with '{' and ends with '}'.
                    if (seg.Length >= 2 && seg[0] == '{' && seg[seg.Length - 1] == '}') continue;
                    if (!string.Equals(seg, pathSegments[i], StringComparison.OrdinalIgnoreCase))
                    {
                        match = false;
                        break;
                    }
                }
                if (match) return true;
            }
            return false;
        }

        /// <summary>
        /// Build a stable string key for stimulus deduplication. Keys are
        /// shape-aware: HTTP uses method+path+body-hash, SignalR uses hub+method+args-hash,
        /// etc. Returns null when the stimulus does not carry enough data to
        /// hash safely (a missing path on an HttpRequest stimulus, say).
        /// </summary>
        private static string StimulusKey(Stimulus stim)
        {
            if (stim == null) return null;
            switch (stim.Type)
            {
                case StimulusType.HttpRequest:
                    var http = stim.HttpRequest;
                    if (http?.Path == null) return null;
                    return $"http|{(http.Method ?? "GET").ToUpperInvariant()}|{http.Path}|{ShortHash(JsonSerialize(http.Body))}";
                case StimulusType.SignalRBroadcast:
                    var sr = stim.SignalRBroadcast;
                    if (sr?.Method == null) return null;
                    return $"signalr|{sr.Hub}|{sr.Method}|{ShortHash(JsonSerialize(sr.Args))}";
                case StimulusType.DagTrigger:
                    var dag = stim.DagTrigger;
                    if (dag == null) return null;
                    return $"dag|{dag.IterationId}|{string.Join(",", dag.NodeFilter ?? new List<string>())}";
                case StimulusType.FileEvent:
                    var fe = stim.FileEvent;
                    return fe?.Path == null ? null : $"file|{fe.Path}";
                case StimulusType.TimerTick:
                    var tt = stim.TimerTick;
                    return tt == null ? null : $"timer|{tt.TickSource}|{tt.Topic}";
                case StimulusType.DiInvocation:
                    var di = stim.DiInvocation;
                    if (di?.Method == null) return null;
                    return $"direct|{di.ServiceType}|{di.Method}|{ShortHash(JsonSerialize(di.Args))}";
                default:
                    return null;
            }
        }

        private static string JsonSerialize(object o)
        {
            if (o == null) return string.Empty;
            try
            {
                return JsonSerializer.Serialize(o);
            }
            catch
            {
                return o.ToString() ?? string.Empty;
            }
        }

        private static string ShortHash(string s)
        {
            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(s ?? string.Empty));
            var sb = new StringBuilder(8);
            for (int i = 0; i < 4; i++) sb.Append(bytes[i].ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
            return sb.ToString();
        }

        private static string TryGetString(Dictionary<string, object> dict, string key)
        {
            if (dict == null || !dict.TryGetValue(key, out var v) || v == null) return null;
            if (v is string s) return s;
            if (v is JsonElement je)
            {
                return je.ValueKind == JsonValueKind.String ? je.GetString() : je.ToString();
            }
            return v.ToString();
        }

        /// <summary>
        /// Execute a rule under a try/catch so a buggy rule cannot poison the
        /// entire lint pass. Failures surface as <c>LNT999_RuleFailed</c>
        /// warnings carrying the offending rule code.
        /// </summary>
        private static void SafeRun(string ruleCode, List<LintFinding> findings, Action body)
        {
            try
            {
                body();
            }
            catch (Exception ex)
            {
                findings.Add(new LintFinding
                {
                    Code = "LNT999_RuleFailed",
                    Severity = LintSeverity.Warning,
                    Message = $"Rule {ruleCode} threw {ex.GetType().Name}: {ex.Message}",
                });
            }
        }
    }
}
