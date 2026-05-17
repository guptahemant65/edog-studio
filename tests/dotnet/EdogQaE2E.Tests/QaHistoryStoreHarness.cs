// <copyright file="QaHistoryStoreHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P7 — End-to-end behavioural harness for the run-history store.
//
// Validates EdogQaRunStore against its production contract:
//
//   1. Add + reload across a simulated process restart preserves data
//      (EnsureLoaded re-reads from disk into a fresh in-memory mirror).
//   2. Eviction at the 100-record cap drops the oldest by CompletedAt.
//   3. Corrupt JSON is quarantined to qa-runs.corrupt-<ts>.json and the
//      store starts empty rather than throwing.
//   4. Orphaned .tmp files left by an interrupted writer are cleaned up.
//   5. Comparison matches by ScenarioHash when present, falls back to
//      ScenarioId with a degraded-confidence warning otherwise.
//   6. PrId=0 runs compared together emit the unscoped warning.
//   7. Schema migration: an unknown future SchemaVersion quarantines the
//      file rather than overwriting it.
//
// Emits a single JSON block delimited by HARNESS-JSON-BEGIN / END.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class QaHistoryStoreHarness
    {
        public static Task<int> RunAsync(CancellationToken ct)
        {
            // Force an isolated working directory so we never pollute the
            // user's real LocalAppData store. The store re-reads the env
            // var only on the first ResolveStoragePath call, so we set it
            // BEFORE the first reset triggers any path resolution.
            var workDir = Path.Combine(Path.GetTempPath(),
                "edog-qa-history-harness-" + Guid.NewGuid().ToString("n").Substring(0, 8));
            Directory.CreateDirectory(workDir);
            Environment.SetEnvironmentVariable("EDOG_QA_HISTORY_DIR", workDir);

            var results = new Dictionary<string, object>();
            try
            {
                EdogQaRunStore.ResetForTesting();
                Environment.SetEnvironmentVariable("EDOG_QA_HISTORY_DIR", workDir);
                results["resolved_path"] = EdogQaRunStore.ResolveStoragePath();

                results["round_trip"] = RunRoundTrip();
                EdogQaRunStore.ResetForTesting();
                Environment.SetEnvironmentVariable("EDOG_QA_HISTORY_DIR", workDir);

                results["eviction_cap"] = RunEvictionCap();
                EdogQaRunStore.ResetForTesting();
                Environment.SetEnvironmentVariable("EDOG_QA_HISTORY_DIR", workDir);

                results["corruption_quarantine"] = RunCorruptionQuarantine(workDir);
                EdogQaRunStore.ResetForTesting();
                Environment.SetEnvironmentVariable("EDOG_QA_HISTORY_DIR", workDir);

                results["orphan_tmp_cleanup"] = RunOrphanTmpCleanup(workDir);
                EdogQaRunStore.ResetForTesting();
                Environment.SetEnvironmentVariable("EDOG_QA_HISTORY_DIR", workDir);

                results["hash_match_priority"] = RunHashMatchPriority();
                EdogQaRunStore.ResetForTesting();
                Environment.SetEnvironmentVariable("EDOG_QA_HISTORY_DIR", workDir);

                results["id_fallback_warning"] = RunIdFallbackWarning();
                EdogQaRunStore.ResetForTesting();
                Environment.SetEnvironmentVariable("EDOG_QA_HISTORY_DIR", workDir);

                results["unscoped_warning"] = RunUnscopedWarning();
                EdogQaRunStore.ResetForTesting();
                Environment.SetEnvironmentVariable("EDOG_QA_HISTORY_DIR", workDir);

                results["future_schema_quarantine"] = RunFutureSchemaQuarantine(workDir);
            }
            finally
            {
                EdogQaRunStore.ResetForTesting();
                try { Directory.Delete(workDir, recursive: true); } catch { /* best effort */ }
            }

            EmitJson(results);
            return Task.FromResult(0);
        }

        private static object RunRoundTrip()
        {
            var seed = DateTimeOffset.UtcNow.AddMinutes(-10);
            EdogQaRunStore.Add(BuildRecord("run-A", 100, seed.AddMinutes(0), "Passed"));
            EdogQaRunStore.Add(BuildRecord("run-B", 100, seed.AddMinutes(1), "Failed"));
            EdogQaRunStore.Add(BuildRecord("run-C", 200, seed.AddMinutes(2), "Passed"));
            EdogQaRunStore.FlushNow();

            // Simulate process restart by clearing in-memory state without
            // deleting the file. Reflection because the in-memory mirror
            // is private — we want to test the LOAD path, not bypass it.
            typeof(EdogQaRunStore)
                .GetField("_loaded",
                    System.Reflection.BindingFlags.NonPublic |
                    System.Reflection.BindingFlags.Static)
                ?.SetValue(null, false);
            var recordsField = typeof(EdogQaRunStore)
                .GetField("_records",
                    System.Reflection.BindingFlags.NonPublic |
                    System.Reflection.BindingFlags.Static);
            if (recordsField?.GetValue(null) is System.Collections.IList list) list.Clear();

            EdogQaRunStore.EnsureLoaded();
            var all = EdogQaRunStore.List(null, 100, 0);
            var pr100 = EdogQaRunStore.List(100, 100, 0);
            return new
            {
                total = all.Count,
                ordered_ids = string.Join(",", all.Select(r => r.RunId)),
                pr100_count = pr100.Count,
                first_run_id_after_reload = all.FirstOrDefault()?.RunId,
            };
        }

        private static object RunEvictionCap()
        {
            var seed = DateTimeOffset.UtcNow.AddDays(-1);
            for (int i = 0; i < 105; i++)
            {
                EdogQaRunStore.Add(BuildRecord(
                    "run-evict-" + i.ToString("D3"),
                    prId: 1,
                    completedAt: seed.AddMinutes(i),
                    status: "Passed"));
            }
            var all = EdogQaRunStore.List(null, 200, 0);
            return new
            {
                total = all.Count,
                newest_id = all.FirstOrDefault()?.RunId,
                oldest_id = all.LastOrDefault()?.RunId,
            };
        }

        private static object RunCorruptionQuarantine(string workDir)
        {
            var path = EdogQaRunStore.ResolveStoragePath();
            File.WriteAllText(path, "{ this is not: valid json,,,");
            try
            {
                EdogQaRunStore.EnsureLoaded();
            }
            catch (Exception ex)
            {
                return new { unexpected_throw = ex.GetType().Name + ": " + ex.Message };
            }
            var quarantined = Directory.GetFiles(workDir, "qa-runs.json.corrupt-*.json");
            return new
            {
                still_started_empty = EdogQaRunStore.List(null, 100, 0).Count,
                quarantined_count = quarantined.Length,
                original_exists = File.Exists(path),
            };
        }

        private static object RunOrphanTmpCleanup(string workDir)
        {
            var path = EdogQaRunStore.ResolveStoragePath();
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, "interrupted write");
            EdogQaRunStore.EnsureLoaded();
            return new { orphan_remaining = File.Exists(tmp) };
        }

        private static object RunHashMatchPriority()
        {
            // Two runs with the SAME scenario hash but DIFFERENT scenario ids.
            // The matcher should treat them as the same scenario and report
            // only a status flip, not "added/removed".
            var seed = DateTimeOffset.UtcNow.AddHours(-2);
            var hashA = EdogQaRunStore.ComputeScenarioHash("scn-x-001", "Title X", "happy_path");
            var baseRun = new QaRunRecord
            {
                RunId = "run-hash-base",
                PrId = 42,
                CompletedAt = seed,
                Summary = new QaRunSummaryData { Total = 1, Passed = 1 },
                OverallPass = true,
                Scenarios = new List<QaScenarioRecord>
                {
                    new QaScenarioRecord
                    {
                        ScenarioId = "scn-x-001",
                        ScenarioHash = hashA,
                        Title = "Title X",
                        Category = "happy_path",
                        Status = "Passed",
                    }
                },
            };
            var targetRun = new QaRunRecord
            {
                RunId = "run-hash-target",
                PrId = 42,
                CompletedAt = seed.AddMinutes(1),
                Summary = new QaRunSummaryData { Total = 1, Failed = 1 },
                OverallPass = false,
                Scenarios = new List<QaScenarioRecord>
                {
                    new QaScenarioRecord
                    {
                        // Different id, SAME hash → matched by hash.
                        ScenarioId = "scn-renamed-001",
                        ScenarioHash = hashA,
                        Title = "Title X",
                        Category = "happy_path",
                        Status = "Failed",
                    }
                },
            };
            EdogQaRunStore.Add(baseRun);
            EdogQaRunStore.Add(targetRun);
            var cmp = EdogQaRunStore.Compare("run-hash-base", "run-hash-target");
            return new
            {
                success = cmp.Success,
                added = cmp.AddedInTarget.Count,
                removed = cmp.RemovedFromTarget.Count,
                flips = cmp.StatusFlips.Count,
                flip_base = cmp.StatusFlips.FirstOrDefault()?.BaseStatus,
                flip_target = cmp.StatusFlips.FirstOrDefault()?.TargetStatus,
                warning_count = cmp.Warnings.Count,
            };
        }

        private static object RunIdFallbackWarning()
        {
            // Two runs WITHOUT scenario hash → fall back to ScenarioId match.
            // Must emit the degraded-confidence warning.
            var seed = DateTimeOffset.UtcNow.AddHours(-3);
            EdogQaRunStore.Add(new QaRunRecord
            {
                RunId = "run-idfb-base",
                PrId = 7,
                CompletedAt = seed,
                Summary = new QaRunSummaryData { Total = 1, Passed = 1 },
                OverallPass = true,
                Scenarios = new List<QaScenarioRecord>
                {
                    new QaScenarioRecord { ScenarioId = "scn-no-hash", Title = "T", Category = "happy_path", Status = "Passed" }
                },
            });
            EdogQaRunStore.Add(new QaRunRecord
            {
                RunId = "run-idfb-target",
                PrId = 7,
                CompletedAt = seed.AddMinutes(1),
                Summary = new QaRunSummaryData { Total = 1, Failed = 1 },
                OverallPass = false,
                Scenarios = new List<QaScenarioRecord>
                {
                    new QaScenarioRecord { ScenarioId = "scn-no-hash", Title = "T", Category = "happy_path", Status = "Failed" }
                },
            });
            var cmp = EdogQaRunStore.Compare("run-idfb-base", "run-idfb-target");
            return new
            {
                success = cmp.Success,
                flips = cmp.StatusFlips.Count,
                warning_count = cmp.Warnings.Count,
                first_warning_mentions_hash = cmp.Warnings.Any(w => w.Contains("hash", StringComparison.OrdinalIgnoreCase)),
            };
        }

        private static object RunUnscopedWarning()
        {
            var seed = DateTimeOffset.UtcNow.AddHours(-4);
            EdogQaRunStore.Add(BuildRecord("run-unsc-base", prId: 0, completedAt: seed, status: "Passed"));
            EdogQaRunStore.Add(BuildRecord("run-unsc-target", prId: 0, completedAt: seed.AddMinutes(1), status: "Passed"));
            var cmp = EdogQaRunStore.Compare("run-unsc-base", "run-unsc-target");
            return new
            {
                success = cmp.Success,
                warning_count = cmp.Warnings.Count,
                mentions_unscoped = cmp.Warnings.Any(w => w.Contains("not PR-scoped", StringComparison.OrdinalIgnoreCase)),
            };
        }

        private static object RunFutureSchemaQuarantine(string workDir)
        {
            var path = EdogQaRunStore.ResolveStoragePath();
            // Write a file whose schemaVersion is in the future. The store
            // should quarantine it and start empty rather than overwrite.
            var futureEnvelope = new
            {
                schemaVersion = EdogQaRunStore.CurrentSchemaVersion + 100,
                flushedAtUtc = DateTimeOffset.UtcNow,
                runs = new[] { new { runId = "future-run", prId = 1 } },
            };
            File.WriteAllText(path, JsonSerializer.Serialize(futureEnvelope, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            }));

            EdogQaRunStore.EnsureLoaded();
            var quarantined = Directory.GetFiles(workDir, "qa-runs.json.corrupt-*.json");
            return new
            {
                quarantined_count = quarantined.Length,
                started_empty = EdogQaRunStore.List(null, 100, 0).Count,
            };
        }

        private static QaRunRecord BuildRecord(string runId, int prId, DateTimeOffset completedAt, string status)
        {
            return new QaRunRecord
            {
                RunId = runId,
                PrId = prId,
                PrTitle = "PR #" + prId,
                StartedAt = completedAt.AddSeconds(-5),
                CompletedAt = completedAt,
                TotalDurationMs = 5000,
                CancelledByUser = false,
                Summary = new QaRunSummaryData { Total = 1, Passed = status == "Passed" ? 1 : 0, Failed = status == "Failed" ? 1 : 0 },
                OverallPass = status == "Passed",
                Scenarios = new List<QaScenarioRecord>
                {
                    new QaScenarioRecord
                    {
                        ScenarioId = "scn-" + runId,
                        ScenarioHash = EdogQaRunStore.ComputeScenarioHash("scn-" + runId, "Title " + runId, "happy_path"),
                        Title = "Title " + runId,
                        Category = "happy_path",
                        Status = status,
                    }
                },
            };
        }

        private static void EmitJson(object payload)
        {
            var opts = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                WriteIndented = true,
            };
            Console.WriteLine("---HARNESS-JSON-BEGIN---");
            Console.WriteLine(JsonSerializer.Serialize(payload, opts));
            Console.WriteLine("---HARNESS-JSON-END---");
        }
    }
}
