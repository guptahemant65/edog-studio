// <copyright file="EdogQaRunStore.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.IO;
    using System.Linq;
    using System.Security.Cryptography;
    using System.Text;
    using System.Text.Json;
    using System.Threading;

    // ──────────────────────────────────────────────
    // F27 P7 — Server-Side History + Run-to-Run Comparison
    //
    // Persists QA run summaries to disk so history survives FLT process
    // restarts. Storage is a single JSON file, atomically rewritten via
    // a .tmp + File.Move dance. SQLite was rejected because adding a
    // managed-only dependency to a DevMode-injected assembly fights
    // FLT's transitive package surface; at the 100-record cap the file
    // is small enough (<1 MB worst case) that a full rewrite is cheap.
    //
    // Storage location (priority order):
    //   1. $EDOG_QA_HISTORY_DIR (escape hatch for tests + portability)
    //   2. %LocalAppData%\edog-studio\
    //   3. fall back to the OS temp dir if both above are unwritable
    //
    // Failure mode contract:
    //   - All I/O errors are caught + logged; persistence NEVER fails the
    //     surrounding QA run.
    //   - Corrupt or future-versioned files are quarantined to
    //     "qa-runs.corrupt-{ts}.json" and the store starts empty.
    //   - Orphaned ".tmp" files left by an interrupted write are deleted
    //     at hydrate time.
    // ──────────────────────────────────────────────

    /// <summary>
    /// Versioned on-disk envelope. Carries <see cref="SchemaVersion"/> so
    /// future field additions can migrate forward via
    /// <see cref="EdogQaRunStore.MigrateIfNeeded"/>.
    /// </summary>
    public sealed class QaRunStoreEnvelope
    {
        /// <summary>Schema version this file was written under.</summary>
        public int SchemaVersion { get; set; }

        /// <summary>UTC timestamp when this envelope was last written.</summary>
        public DateTimeOffset FlushedAtUtc { get; set; }

        /// <summary>Persisted run records, newest-first.</summary>
        public List<QaRunRecord> Runs { get; set; } = new();
    }

    /// <summary>
    /// Disk-backed store for QA run records. Static + thread-safe.
    /// </summary>
    public static class EdogQaRunStore
    {
        /// <summary>Current schema version. Bump when adding fields that need migration.</summary>
        public const int CurrentSchemaVersion = 10; // p10

        /// <summary>Maximum number of runs kept on disk (oldest evicted).</summary>
        public const int MaxRecords = 100;

        private static readonly object _stateLock = new();
        private static readonly object _writeLock = new();

        private static readonly JsonSerializerOptions JsonOpts = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
        };

        // In-memory mirror of the on-disk file. Sorted newest-first by CompletedAt.
        private static readonly List<QaRunRecord> _records = new();
        private static volatile bool _loaded;
        private static string _resolvedPath;

        /// <summary>
        /// Resolves the on-disk path, lazily creating the parent directory.
        /// Honoured priority: <c>EDOG_QA_HISTORY_DIR</c> → <c>%LocalAppData%\edog-studio</c>
        /// → OS temp dir. Path is cached after first resolution.
        /// </summary>
        public static string ResolveStoragePath()
        {
            if (_resolvedPath != null) return _resolvedPath;

            string dir = null;
            try
            {
                var fromEnv = Environment.GetEnvironmentVariable("EDOG_QA_HISTORY_DIR");
                if (!string.IsNullOrWhiteSpace(fromEnv))
                {
                    dir = fromEnv;
                }
                else
                {
                    dir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "edog-studio");
                }
                Directory.CreateDirectory(dir);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] QaRunStore primary location unwritable ({ex.Message}); falling back to temp.");
                dir = Path.Combine(Path.GetTempPath(), "edog-studio");
                try { Directory.CreateDirectory(dir); } catch { /* best effort */ }
            }

            _resolvedPath = Path.Combine(dir, "qa-runs.json");
            Debug.WriteLine($"[EDOG] QaRunStore resolved path: {_resolvedPath}");
            return _resolvedPath;
        }

        /// <summary>
        /// Loads the on-disk file into the in-memory mirror (idempotent).
        /// First caller wins via double-checked lock under <see cref="_stateLock"/>.
        /// Corrupt or future-versioned files are quarantined so the store
        /// always starts in a known-good state.
        /// </summary>
        public static void EnsureLoaded()
        {
            if (_loaded) return;
            lock (_stateLock)
            {
                if (_loaded) return;
                LoadFromDiskUnsafe();
                _loaded = true;
            }
        }

        /// <summary>
        /// Adds a freshly-completed run record. Evicts the oldest entry
        /// when the cap is exceeded, then asynchronously persists. The
        /// caller never blocks on disk I/O — the in-memory list is
        /// updated immediately and the file write is queued on the
        /// thread pool. Persistence failure is non-fatal.
        /// </summary>
        public static void Add(QaRunRecord record)
        {
            if (record == null) return;
            if (string.IsNullOrEmpty(record.RunId)) return;

            EnsureLoaded();
            NormalizeRecordForPersistence(record);

            lock (_stateLock)
            {
                var existingIdx = _records.FindIndex(r => r.RunId == record.RunId);
                if (existingIdx >= 0)
                {
                    _records[existingIdx] = record;
                }
                else
                {
                    _records.Insert(0, record);
                }
                SortAndCapUnsafe();
            }

            QueueFlush();
        }

        /// <summary>
        /// Returns up to <paramref name="limit"/> run records optionally
        /// filtered by PR id, newest first. <c>prId == 0</c> is treated
        /// as "unscoped" and matches only other unscoped runs.
        /// </summary>
        public static List<QaRunRecord> List(int? prId, int limit, int offset)
        {
            EnsureLoaded();
            limit = Math.Clamp(limit, 1, MaxRecords);
            offset = Math.Max(0, offset);
            lock (_stateLock)
            {
                IEnumerable<QaRunRecord> q = _records;
                if (prId.HasValue)
                {
                    int requested = prId.Value;
                    q = q.Where(r => r.PrId == requested);
                }
                return q.Skip(offset).Take(limit).ToList();
            }
        }

        /// <summary>
        /// Returns the full record for <paramref name="runId"/> or null
        /// when the run is unknown.
        /// </summary>
        public static QaRunRecord Get(string runId)
        {
            if (string.IsNullOrEmpty(runId)) return null;
            EnsureLoaded();
            lock (_stateLock)
            {
                return _records.FirstOrDefault(r => r.RunId == runId);
            }
        }

        /// <summary>
        /// Returns a snapshot of every persisted run as a
        /// <see cref="QaRunSummary"/> (the wire shape the hub already
        /// returns from <c>QaGetRunHistory</c>). Used by
        /// <c>QaHubState</c> at hydration time so process-restart history
        /// survives.
        /// </summary>
        public static List<QaRunSummary> ListAllSummaries()
        {
            EnsureLoaded();
            lock (_stateLock)
            {
                return _records.Select(ToSummary).ToList();
            }
        }

        /// <summary>
        /// Diffs <c>baseRunId</c> against <c>targetRunId</c>. Match key
        /// is <see cref="QaScenarioRecord.ScenarioHash"/> when present on
        /// both sides; otherwise falls back to
        /// <see cref="QaScenarioRecord.ScenarioId"/> and emits a warning.
        /// Unknown runs yield a failed comparison with <c>Error</c> set.
        /// </summary>
        internal static void MigrateToP10(QaRunRecord record)
        {
            if (record == null)
            {
                return;
            }

            record.Scenarios ??= new List<QaScenarioRecord>();
            var quarantinedAny = false;

            foreach (var scenario in record.Scenarios)
            {
                if (scenario == null)
                {
                    continue;
                }

                scenario.Status = NormalizeVerdictStatus(scenario.Status);

                if (scenario.Matchers == null || scenario.Matchers.Count == 0)
                {
                    scenario.Lifecycle = ScenarioLifecycle.Archived.ToString();
                    scenario.IsPreContractQuarantined = true;
                    scenario.QuarantineReason = "pre-contract-quarantined";
                    scenario.ErrorSummary ??= "pre-contract-quarantined";
                    scenario.Status ??= ScenarioVerdict.Inconclusive.ToString();
                    quarantinedAny = true;
                }
            }

            if (quarantinedAny)
            {
                record.IsPreContractQuarantined = true;
                record.QuarantineReason = "p10: pre-contract-quarantined";
            }
        }

        public static QaRunComparison Compare(string baseRunId, string targetRunId)
        {
            var result = new QaRunComparison
            {
                BaseRunId = baseRunId,
                TargetRunId = targetRunId,
            };

            if (string.IsNullOrEmpty(baseRunId) || string.IsNullOrEmpty(targetRunId))
            {
                result.Error = "Both baseRunId and targetRunId are required.";
                return result;
            }
            if (baseRunId == targetRunId)
            {
                result.Error = "Cannot compare a run to itself.";
                return result;
            }

            var baseRun = Get(baseRunId);
            var targetRun = Get(targetRunId);
            if (baseRun == null) { result.Error = $"Base run '{baseRunId}' not found."; return result; }
            if (targetRun == null) { result.Error = $"Target run '{targetRunId}' not found."; return result; }

            var baseScenarios = baseRun.Scenarios ?? new List<QaScenarioRecord>();
            var targetScenarios = targetRun.Scenarios ?? new List<QaScenarioRecord>();

            var anyMissingHash = baseScenarios.Concat(targetScenarios)
                .Any(s => string.IsNullOrEmpty(s?.ScenarioHash));
            if (anyMissingHash)
            {
                result.Warnings.Add(
                    "One or both runs lack scenario hashes; matched by scenarioId only. " +
                    "Status flips may reflect edits to the scenario definition rather than runtime regressions.");
            }
            if (baseRun.PrId == 0 && targetRun.PrId == 0)
            {
                result.Warnings.Add(
                    "Runs are not PR-scoped (prId=0). Comparison is meaningful only if both " +
                    "runs targeted the same code state.");
            }
            else if (baseRun.PrId != targetRun.PrId)
            {
                result.Warnings.Add(
                    $"Runs target different PRs (base #{baseRun.PrId} vs target #{targetRun.PrId}).");
            }

            string KeyOf(QaScenarioRecord s) => !string.IsNullOrEmpty(s.ScenarioHash)
                ? "h:" + s.ScenarioHash
                : "i:" + (s.ScenarioId ?? string.Empty);

            var baseByKey = baseScenarios
                .Where(s => s != null)
                .GroupBy(KeyOf)
                .ToDictionary(g => g.Key, g => g.First());
            var targetByKey = targetScenarios
                .Where(s => s != null)
                .GroupBy(KeyOf)
                .ToDictionary(g => g.Key, g => g.First());

            foreach (var kv in targetByKey)
            {
                if (!baseByKey.ContainsKey(kv.Key))
                {
                    result.AddedInTarget.Add(kv.Value);
                }
            }
            foreach (var kv in baseByKey)
            {
                if (!targetByKey.TryGetValue(kv.Key, out var tgt))
                {
                    result.RemovedFromTarget.Add(kv.Value);
                    continue;
                }
                var baseStatus = kv.Value.Status ?? string.Empty;
                var targetStatus = tgt.Status ?? string.Empty;
                if (!string.Equals(baseStatus, targetStatus, StringComparison.OrdinalIgnoreCase))
                {
                    result.StatusFlips.Add(new QaScenarioFlip
                    {
                        ScenarioId = tgt.ScenarioId,
                        ScenarioHash = tgt.ScenarioHash,
                        Title = tgt.Title,
                        BaseStatus = baseStatus,
                        TargetStatus = targetStatus,
                    });
                }
            }

            result.Success = true;
            return result;
        }

        /// <summary>
        /// Computes the canonical scenario hash from the fields that
        /// identify a scenario's content. Stable across runs of the
        /// same PR + analyzer output; sensitive enough that an edited
        /// title/category yields a different hash (which surfaces as
        /// "added/removed" instead of "flip" — correct semantically).
        /// </summary>
        public static string ComputeScenarioHash(string scenarioId, string title, string category)
        {
            var seed = (scenarioId ?? string.Empty) + "|"
                + (title ?? string.Empty) + "|"
                + (category ?? string.Empty);
            using var sha = SHA1.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(seed));
            var sb = new StringBuilder(32);
            for (int i = 0; i < 8; i++) sb.Append(bytes[i].ToString("x2"));
            return sb.ToString();
        }

        /// <summary>
        /// Clears the in-memory mirror and deletes the on-disk file.
        /// Test-only — invoked by harness <c>--reset</c> commands.
        /// </summary>
        public static void ResetForTesting()
        {
            // Drain any in-flight flush from a previous test so it cannot
            // race-rewrite the file we are about to delete. Without this,
            // `_flushPendingFlag` being 1 from a prior test can resurrect
            // the file we just quarantined.
            Interlocked.Exchange(ref _flushPendingFlag, 0);
            lock (_writeLock) { /* fence — wait for active writer */ }
            lock (_stateLock)
            {
                _records.Clear();
                _loaded = false;
                _resolvedPath = null;
            }
            try
            {
                var path = ResolveStoragePath();
                if (File.Exists(path)) File.Delete(path);
                var tmp = path + ".tmp";
                if (File.Exists(tmp)) File.Delete(tmp);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] QaRunStore reset failed (non-fatal): {ex.Message}");
            }
        }

        // ──────────────────────────────────────────────
        // Internal helpers
        // ──────────────────────────────────────────────

        private static void LoadFromDiskUnsafe()
        {
            var path = ResolveStoragePath();
            CleanupOrphanTemp(path);

            if (!File.Exists(path))
            {
                _records.Clear();
                return;
            }

            try
            {
                var json = File.ReadAllText(path);
                if (string.IsNullOrWhiteSpace(json))
                {
                    _records.Clear();
                    return;
                }
                var envelope = JsonSerializer.Deserialize<QaRunStoreEnvelope>(json, JsonOpts);
                if (envelope == null)
                {
                    _records.Clear();
                    return;
                }
                envelope = MigrateIfNeeded(envelope, path);
                _records.Clear();
                if (envelope?.Runs != null) _records.AddRange(envelope.Runs);
                SortAndCapUnsafe();
            }
            catch (JsonException ex)
            {
                QuarantineCorruptFile(path, ex.Message);
                _records.Clear();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] QaRunStore load failed (non-fatal): {ex.Message}");
                _records.Clear();
            }
        }

        /// <summary>
        /// Schema migration entry point. Today only v1 exists; future
        /// versions chain through a switch on <see cref="QaRunStoreEnvelope.SchemaVersion"/>.
        /// Files written by a NEWER edog-studio than the current binary
        /// are quarantined rather than overwritten so a downgrade does
        /// not silently lose history.
        /// </summary>
        public static QaRunStoreEnvelope MigrateIfNeeded(QaRunStoreEnvelope envelope, string sourcePath)
        {
            if (envelope == null) return null;
            if (envelope.SchemaVersion == CurrentSchemaVersion) return envelope;
            if (envelope.SchemaVersion > CurrentSchemaVersion)
            {
                Debug.WriteLine(
                    $"[EDOG] QaRunStore file at {sourcePath} is schemaVersion={envelope.SchemaVersion} " +
                    $"but binary supports {CurrentSchemaVersion}. Quarantining; starting empty.");
                QuarantineCorruptFile(sourcePath, $"unknown-future-schema-{envelope.SchemaVersion}");
                return new QaRunStoreEnvelope { SchemaVersion = CurrentSchemaVersion };
            }

            // Older versions: chain forward migrations here as fields are
            // added in future commits. p10 archives pre-contract scenarios and
            // preserves Stale/Inconclusive verdict strings plus CatalogHashes.
            switch (envelope.SchemaVersion)
            {
                case 0:
                case 1:
                    if (envelope.Runs != null)
                    {
                        foreach (var run in envelope.Runs)
                        {
                            MigrateToP10(run);
                        }
                    }

                    envelope.SchemaVersion = CurrentSchemaVersion;
                    break;
            }

            return envelope;
        }

        private static void NormalizeRecordForPersistence(QaRunRecord record)
        {
            if (record == null)
            {
                return;
            }

            record.Scenarios ??= new List<QaScenarioRecord>();
            foreach (var scenario in record.Scenarios)
            {
                if (scenario == null)
                {
                    continue;
                }

                scenario.Status = NormalizeVerdictStatus(scenario.Status);
                if (scenario.IsPreContractQuarantined)
                {
                    scenario.QuarantineReason ??= "pre-contract-quarantined";
                }
            }

            if (record.IsPreContractQuarantined)
            {
                record.QuarantineReason ??= "p10: pre-contract-quarantined";
            }
        }

        private static string NormalizeVerdictStatus(string status)
        {
            return status?.Trim() switch
            {
                nameof(ScenarioVerdict.Stale) => nameof(ScenarioVerdict.Stale),
                "stale" => nameof(ScenarioVerdict.Stale),
                nameof(ScenarioVerdict.Inconclusive) => nameof(ScenarioVerdict.Inconclusive),
                "inconclusive" => nameof(ScenarioVerdict.Inconclusive),
                _ => status,
            };
        }

        private static void QuarantineCorruptFile(string path, string reason)
        {
            try
            {
                var quarantine = path + ".corrupt-" + DateTimeOffset.UtcNow.ToUnixTimeSeconds() + ".json";
                File.Move(path, quarantine, overwrite: true);
                Debug.WriteLine($"[EDOG] QaRunStore quarantined corrupt file ({reason}) → {quarantine}");
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] QaRunStore quarantine failed: {ex.Message}");
            }
        }

        private static void CleanupOrphanTemp(string path)
        {
            try
            {
                var tmp = path + ".tmp";
                if (File.Exists(tmp))
                {
                    File.Delete(tmp);
                    Debug.WriteLine($"[EDOG] QaRunStore cleaned orphaned temp file at {tmp}");
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] QaRunStore orphan cleanup failed: {ex.Message}");
            }
        }

        private static void SortAndCapUnsafe()
        {
            _records.Sort((a, b) => b.CompletedAt.CompareTo(a.CompletedAt));
            while (_records.Count > MaxRecords) _records.RemoveAt(_records.Count - 1);
        }

        // Set to 1 when a caller wants the disk image refreshed. A writer
        // loops until the flag is clear so a late Add() that arrives while
        // a flush is in progress cannot be silently dropped (which would
        // leave the newest run unpersisted across restart).
        private static int _flushPendingFlag;

        private static void QueueFlush()
        {
            Interlocked.Exchange(ref _flushPendingFlag, 1);
            ThreadPool.QueueUserWorkItem(_ =>
            {
                if (!Monitor.TryEnter(_writeLock)) return;
                try
                {
                    while (Interlocked.Exchange(ref _flushPendingFlag, 0) == 1)
                    {
                        QaRunStoreEnvelope envelope;
                        lock (_stateLock)
                        {
                            envelope = new QaRunStoreEnvelope
                            {
                                SchemaVersion = CurrentSchemaVersion,
                                FlushedAtUtc = DateTimeOffset.UtcNow,
                                Runs = new List<QaRunRecord>(_records),
                            };
                        }
                        try
                        {
                            FlushEnvelopeUnsafe(envelope);
                        }
                        catch (Exception ex)
                        {
                            Debug.WriteLine($"[EDOG] QaRunStore flush failed (non-fatal): {ex.Message}");
                        }
                    }
                }
                finally
                {
                    Monitor.Exit(_writeLock);
                }
            });
        }

        /// <summary>
        /// Synchronous flush. Called from <see cref="QueueFlush"/> on a
        /// thread-pool thread and from harness <c>--flush</c> commands
        /// in tests. Must be invoked under <see cref="_writeLock"/>.
        /// </summary>
        public static void FlushNow()
        {
            QaRunStoreEnvelope envelope;
            lock (_stateLock)
            {
                envelope = new QaRunStoreEnvelope
                {
                    SchemaVersion = CurrentSchemaVersion,
                    FlushedAtUtc = DateTimeOffset.UtcNow,
                    Runs = new List<QaRunRecord>(_records),
                };
            }
            lock (_writeLock)
            {
                FlushEnvelopeUnsafe(envelope);
            }
        }

        private static void FlushEnvelopeUnsafe(QaRunStoreEnvelope envelope)
        {
            var path = ResolveStoragePath();
            var tmp = path + ".tmp";
            try
            {
                var json = JsonSerializer.Serialize(envelope, JsonOpts);
                File.WriteAllText(tmp, json);
                File.Move(tmp, path, overwrite: true);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] QaRunStore write failed (non-fatal): {ex.Message}");
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* best effort */ }
            }
        }

        private static QaRunSummary ToSummary(QaRunRecord record)
        {
            return new QaRunSummary
            {
                RunId = record.RunId,
                PrId = record.PrId,
                PrTitle = record.PrTitle ?? string.Empty,
                StartedAt = record.StartedAt,
                CompletedAt = record.CompletedAt,
                TotalDurationMs = record.TotalDurationMs,
                Summary = record.Summary,
                OverallPass = record.OverallPass,
            };
        }
    }
}
