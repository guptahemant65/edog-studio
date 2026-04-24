// <copyright file="EdogNexusSessionStore.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.IO;
    using System.Text.Json;
    using System.Threading;

    // ──────────────────────────────────────────────
    // NexusSessionEnvelope — Versioned on-disk wrapper
    // ──────────────────────────────────────────────

    /// <summary>
    /// Versioned envelope for the Nexus session file.
    /// Carries schema version for forward-compatible deserialization.
    /// </summary>
    internal sealed class NexusSessionEnvelope
    {
        /// <summary>Schema version for forward compatibility. Unknown versions are discarded.</summary>
        public int SchemaVersion { get; set; }

        /// <summary>UTC timestamp when this envelope was written to disk.</summary>
        public DateTimeOffset FlushedAtUtc { get; set; }

        /// <summary>The snapshot payload.</summary>
        public NexusSnapshot Snapshot { get; set; }
    }

    // ──────────────────────────────────────────────
    // EdogNexusSessionStore — Session persistence for Nexus state
    // ──────────────────────────────────────────────

    /// <summary>
    /// Persists <see cref="NexusSnapshot"/> to disk so the Nexus dependency graph
    /// survives FLT process restarts. Fire-and-forget writes; reads only at startup.
    /// <para>
    /// Thread-safe (last writer wins). Never throws — all I/O errors are swallowed
    /// with <c>[EDOG]</c> diagnostic output. File older than 30 minutes is auto-pruned.
    /// </para>
    /// </summary>
    public static class EdogNexusSessionStore
    {
        private const int SchemaVersion = 1;
        private const int MaxAgeMinutes = 30;

        private static readonly string FilePath = Path.Combine(
            Path.GetTempPath(), "edog-nexus-session.json");

        private static readonly object WriteLock = new();

        private static readonly JsonSerializerOptions JsonOpts = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
        };

        /// <summary>
        /// Saves a snapshot to disk for reconnection hydration.
        /// Fire-and-forget — never blocks the caller, never throws.
        /// Uses atomic temp-file rename to prevent corruption from partial writes.
        /// </summary>
        /// <param name="snapshot">The Nexus graph snapshot to persist.</param>
        public static void SaveSnapshot(NexusSnapshot snapshot)
        {
            if (snapshot == null) return;

            // Fire-and-forget on ThreadPool — never block the aggregator
            ThreadPool.QueueUserWorkItem(_ =>
            {
                // Single writer — skip if previous write still in progress
                if (!Monitor.TryEnter(WriteLock)) return;
                try
                {
                    var envelope = new NexusSessionEnvelope
                    {
                        SchemaVersion = SchemaVersion,
                        FlushedAtUtc = DateTimeOffset.UtcNow,
                        Snapshot = snapshot,
                    };

                    var tempPath = FilePath + ".tmp";
                    var json = JsonSerializer.Serialize(envelope, JsonOpts);
                    File.WriteAllText(tempPath, json);
                    File.Move(tempPath, FilePath, overwrite: true);
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[EDOG] Nexus session save failed (non-fatal): {ex.Message}");
                }
                finally
                {
                    Monitor.Exit(WriteLock);
                }
            });
        }

        /// <summary>
        /// Loads the last persisted snapshot from disk.
        /// Returns <c>null</c> if no file exists, the file is stale (older than 30 minutes),
        /// the schema version is unrecognized, or deserialization fails.
        /// Called once at startup for reconnection hydration — never throws.
        /// </summary>
        /// <returns>The restored <see cref="NexusSnapshot"/>, or <c>null</c>.</returns>
        public static NexusSnapshot LoadSnapshot()
        {
            try
            {
                // Clean up orphaned temp files from interrupted writes
                CleanupTempFile();

                if (!File.Exists(FilePath))
                    return null;

                // Auto-cleanup: discard files older than MaxAgeMinutes
                var fileInfo = new FileInfo(FilePath);
                if (fileInfo.LastWriteTimeUtc < DateTime.UtcNow.AddMinutes(-MaxAgeMinutes))
                {
                    Console.WriteLine("[EDOG] Nexus session file expired (>30 min). Starting clean.");
                    TryDeleteFile(FilePath);
                    return null;
                }

                var json = File.ReadAllText(FilePath);
                var envelope = JsonSerializer.Deserialize<NexusSessionEnvelope>(json, JsonOpts);

                if (envelope == null)
                {
                    Console.WriteLine("[EDOG] Nexus session file had null envelope. Starting clean.");
                    TryDeleteFile(FilePath);
                    return null;
                }

                if (envelope.SchemaVersion != SchemaVersion)
                {
                    Console.WriteLine($"[EDOG] Nexus session schema v{envelope.SchemaVersion} != expected v{SchemaVersion}. Starting clean.");
                    TryDeleteFile(FilePath);
                    return null;
                }

                // Double-check age via envelope timestamp (more accurate than file mtime)
                if (envelope.FlushedAtUtc < DateTimeOffset.UtcNow.AddMinutes(-MaxAgeMinutes))
                {
                    Console.WriteLine("[EDOG] Nexus session data expired (>30 min). Starting clean.");
                    TryDeleteFile(FilePath);
                    return null;
                }

                Console.WriteLine("[EDOG] Nexus session restored from disk");
                return envelope.Snapshot;
            }
            catch (JsonException ex)
            {
                Console.WriteLine($"[EDOG] Nexus session file corrupt ({ex.Message}). Starting clean.");
                TryDeleteFile(FilePath);
                return null;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Nexus session load failed (non-fatal): {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Clears stored session state by deleting the persistence file.
        /// </summary>
        public static void Clear()
        {
            try
            {
                TryDeleteFile(FilePath);
                CleanupTempFile();
                Console.WriteLine("[EDOG] Nexus session cleared");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Nexus session clear failed (non-fatal): {ex.Message}");
            }
        }

        /// <summary>
        /// Deletes a file if it exists. Best-effort — never throws.
        /// </summary>
        private static void TryDeleteFile(string path)
        {
            try
            {
                if (File.Exists(path))
                    File.Delete(path);
            }
            catch
            {
                // Best effort — file may be locked by antivirus or another process
            }
        }

        /// <summary>
        /// Removes orphaned .tmp files from interrupted writes.
        /// </summary>
        private static void CleanupTempFile()
        {
            TryDeleteFile(FilePath + ".tmp");
        }
    }
}
