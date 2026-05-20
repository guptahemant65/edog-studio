// SPDX-License-Identifier: MIT
// F27 — Contract test for the API Surface section rendered into the
// Architect system-user message by EdogQaLlmProvider.
//
// The dev-server (`scripts/flt_catalog.py`) emits each endpoint as a
// camelCase JSON object with keys `method` / `urlTemplate` / `name` /
// `description`. Earlier versions of the C# prompt renderer looked up
// `verb` / `url_template` / `summary` instead — none of which appear
// in the catalog — so every endpoint rendered as `? ?` and the LNT001
// path-in-catalog linter rule built its templates HashSet from empty
// strings (silently dead). The shape of that bug was invisible from
// the outside because the Architect still produced *some* scenarios
// from the other context sections.
//
// This harness builds a small PrContext containing one ApiCatalog
// endpoint that mirrors the actual dev-server JSON shape, drives
// EdogQaLlmProvider.AppendContractSectionsInternal end-to-end, and
// reports whether the rendered prompt contains the verb + path + name
// + the MUST-match rule line. It also exercises EdogQaScenarioLinter
// LNT001_PathInCatalog with a scenario whose path does not match any
// catalog template, and reports whether the rule fires.
//
// Emits one HARNESS-JSON-BEGIN/END block consumed by the pytest
// wrapper tests/test_qa_api_surface_render.py.

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Text;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class ApiSurfaceRenderHarness
    {
        public static Task<int> RunAsync(CancellationToken ct)
        {
            var report = new Dictionary<string, object>();
            try
            {
                report["renderer"] = RunRendererCase();
                report["linter"] = RunLinterCase();
                report["ok"] = true;
            }
            catch (Exception ex)
            {
                report["ok"] = false;
                report["error"] = $"{ex.GetType().Name}: {ex.Message}";
                report["stack"] = ex.StackTrace;
            }

            Console.WriteLine("---HARNESS-JSON-BEGIN---");
            Console.WriteLine(JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine("---HARNESS-JSON-END---");
            return Task.FromResult(0);
        }

        // ─── Renderer ────────────────────────────────────────────

        private static Dictionary<string, object> RunRendererCase()
        {
            // Build an apiCatalog endpoint whose keys mirror the actual
            // dev-server JSON shape from scripts/flt_catalog.py.
            var endpoint = new Dictionary<string, object>
            {
                ["id"] = "get-livetable-insights-summary",
                ["name"] = "Get Insights Summary",
                ["method"] = "GET",
                ["urlTemplate"] = "/liveTable/insights/summary",
                ["fullPath"] = "/v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable/insights/summary",
                ["group"] = "liveTable",
                ["tokenType"] = "mwc",
                ["controller"] = "LiveTableInsightsController",
                ["description"] = "Returns the 7d-vs-prior-7d insights summary.",
            };

            var ctx = new PrContext
            {
                Title = "[Insights] strict startTime/endTime contract",
                Description = "(test fixture)",
                ApiCatalog = new ApiCatalogContext
                {
                    Controllers = new List<string> { "LiveTableInsightsController" },
                    Endpoints = new List<Dictionary<string, object>> { endpoint },
                    Truncated = false,
                },
            };

            var sb = new StringBuilder();
            EdogQaLlmProvider.AppendContractSectionsInternal(sb, ctx);
            var rendered = sb.ToString();

            return new Dictionary<string, object>
            {
                ["rendered_length"] = rendered.Length,
                ["contains_section_header"] = rendered.Contains("# API Surface"),
                ["contains_verb"] = rendered.Contains("GET"),
                ["contains_url_template"] = rendered.Contains("/liveTable/insights/summary"),
                ["contains_name"] = rendered.Contains("Get Insights Summary"),
                ["contains_must_match_rule"] = rendered.Contains("MUST match one of these endpoints exactly"),
                // Negative checks: the broken shape would have rendered "? ?"
                // bullet lines and never the actual data.
                ["contains_placeholder_question_marks"] = rendered.Contains("- `? ?`") || rendered.Contains("- `? ? "),
            };
        }

        // ─── Linter ──────────────────────────────────────────────

        private static Dictionary<string, object> RunLinterCase()
        {
            var endpoint = new Dictionary<string, object>
            {
                ["method"] = "GET",
                ["urlTemplate"] = "/liveTable/insights/summary",
            };

            var ctx = new PrContext
            {
                ApiCatalog = new ApiCatalogContext
                {
                    Controllers = new List<string> { "LiveTableInsightsController" },
                    Endpoints = new List<Dictionary<string, object>> { endpoint },
                },
            };

            // A scenario whose path is NOT in the catalog → LNT001 should fire.
            var bad = new Scenario
            {
                Id = "scn-bad",
                Title = "Path not in catalog",
                Stimulus = new Stimulus
                {
                    Type = StimulusType.HttpRequest,
                    HttpRequest = new HttpRequestSpec
                    {
                        Method = "GET",
                        Path = "/totally/made/up/path",
                    },
                },
                Expectations = new List<Expectation>(),
            };

            // A scenario whose path IS in the catalog → LNT001 must NOT fire.
            var good = new Scenario
            {
                Id = "scn-good",
                Title = "Path matches catalog",
                Stimulus = new Stimulus
                {
                    Type = StimulusType.HttpRequest,
                    HttpRequest = new HttpRequestSpec
                    {
                        Method = "GET",
                        Path = "/liveTable/insights/summary",
                    },
                },
                Expectations = new List<Expectation>(),
            };

            var findings = EdogQaScenarioLinter.Lint(new List<Scenario> { bad, good }, ctx);
            var lnt001 = new List<Dictionary<string, object>>();
            foreach (var f in findings)
            {
                if (f.Code == "LNT001_PathInCatalog")
                {
                    lnt001.Add(new Dictionary<string, object>
                    {
                        ["scenarioId"] = f.ScenarioId,
                        ["severity"] = f.Severity.ToString(),
                        ["message"] = f.Message,
                    });
                }
            }

            return new Dictionary<string, object>
            {
                ["total_findings"] = findings.Count,
                ["lnt001_findings"] = lnt001,
                ["lnt001_fires_on_bad"] = lnt001.Exists(f => (string)f["scenarioId"] == "scn-bad"),
                ["lnt001_fires_on_good"] = lnt001.Exists(f => (string)f["scenarioId"] == "scn-good"),
            };
        }
    }
}
