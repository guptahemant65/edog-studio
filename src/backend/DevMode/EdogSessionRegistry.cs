// <copyright file="EdogSessionRegistry.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Linq;

    /// <summary>
    /// Tracks active EDOG sessions on this capacity for the Session Guard
    /// pre-deploy collision check. Identity is OS user + machine name —
    /// everyone authenticates as the same Fabric service principal, so
    /// AAD identity is useless for disambiguation.
    ///
    /// Lifecycle:
    ///   - Client connects to <see cref="EdogPlaygroundHub"/>.
    ///   - Frontend immediately calls the EdogIdentify RPC with machine/osUser
    ///     plus current workspace/lakehouse context.
    ///   - <see cref="Register"/> stores the entry keyed by SignalR connectionId.
    ///   - On disconnect (clean or dropped), <see cref="Unregister"/> removes it.
    ///   - <c>/api/edog/sessions</c> returns the snapshot to other engineers
    ///     probing this capacity before they deploy.
    ///
    /// Thread-safe. Never throws — Session Guard must not be able to crash
    /// the host service.
    /// </summary>
    internal static class EdogSessionRegistry
    {
        private static readonly ConcurrentDictionary<string, EdogSessionEntry> Sessions
            = new ConcurrentDictionary<string, EdogSessionEntry>(StringComparer.Ordinal);

        private static string capacityId;
        private static string capacityName;
        private static string capacitySku;
        private static string deployWorkspaceId;
        private static string deployArtifactId;
        private static readonly object ContextLock = new object();

        /// <summary>
        /// Set once at host startup (or lazily by the API handler) with the
        /// capacity identity. Safe to call multiple times — last write wins.
        /// </summary>
        public static void SetCapacityInfo(string id, string name, string sku)
        {
            lock (ContextLock)
            {
                capacityId = Sanitize(id);
                capacityName = Sanitize(name);
                capacitySku = Sanitize(sku);
            }
        }

        /// <summary>
        /// Store the deployment context (workspace + artifact) so that every
        /// <see cref="Register"/> call can auto-fill empty IDs. Called once
        /// from <see cref="EdogDevModeRegistrar.RegisterAll"/> after reading
        /// edog-config.json. Safe to call multiple times — last write wins.
        /// </summary>
        public static void SetDeploymentContext(string workspaceId, string artifactId)
        {
            var ws = Sanitize(workspaceId);
            var art = Sanitize(artifactId);

            lock (ContextLock)
            {
                deployWorkspaceId = ws;
                deployArtifactId = art;
            }

            // Backfill: any session registered before this call may have
            // null/empty IDs (race: SignalR connects before RegisterAll).
            // Atomic replacement — snapshot existing, create new entry.
            if (string.IsNullOrEmpty(ws) && string.IsNullOrEmpty(art))
            {
                return;
            }

            foreach (var kvp in Sessions)
            {
                var old = kvp.Value;
                var needsWs = string.IsNullOrEmpty(old.WorkspaceId) && !string.IsNullOrEmpty(ws);
                var needsArt = string.IsNullOrEmpty(old.LakehouseId) && !string.IsNullOrEmpty(art);
                if (!needsWs && !needsArt)
                {
                    continue;
                }

                var updated = new EdogSessionEntry
                {
                    ConnectionId = old.ConnectionId,
                    Machine = old.Machine,
                    OsUser = old.OsUser,
                    LakehouseId = needsArt ? art : old.LakehouseId,
                    LakehouseName = old.LakehouseName,
                    WorkspaceId = needsWs ? ws : old.WorkspaceId,
                    WorkspaceName = old.WorkspaceName,
                    ConnectedSince = old.ConnectedSince,
                    LastActivity = old.LastActivity,
                };
                Sessions.TryUpdate(kvp.Key, updated, old);
            }
        }

        /// <summary>
        /// Register or refresh a session entry. Called from EdogPlaygroundHub
        /// when a client sends the EdogIdentify RPC. If the same connectionId
        /// identifies more than once, the last call wins (overwrite).
        /// </summary>
        public static void Register(
            string connectionId,
            string machine,
            string osUser,
            string lakehouseId,
            string lakehouseName,
            string workspaceId,
            string workspaceName)
        {
            if (string.IsNullOrEmpty(connectionId))
            {
                return;
            }

            try
            {
                // Auto-fill empty workspace/artifact from deployment context
                // so callers don't need to know about the config source.
                string fillWs;
                string fillArt;
                lock (ContextLock)
                {
                    fillWs = deployWorkspaceId;
                    fillArt = deployArtifactId;
                }

                var now = DateTime.UtcNow;
                var existing = Sessions.TryGetValue(connectionId, out var prior) ? prior : null;
                var entry = new EdogSessionEntry
                {
                    ConnectionId = connectionId,
                    Machine = Sanitize(machine),
                    OsUser = Sanitize(osUser),
                    LakehouseId = string.IsNullOrEmpty(lakehouseId) ? fillArt : Sanitize(lakehouseId),
                    LakehouseName = Sanitize(lakehouseName),
                    WorkspaceId = string.IsNullOrEmpty(workspaceId) ? fillWs : Sanitize(workspaceId),
                    WorkspaceName = Sanitize(workspaceName),
                    ConnectedSince = existing?.ConnectedSince ?? now,
                    LastActivity = now,
                };
                Sessions[connectionId] = entry;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] EdogSessionRegistry.Register error: {ex.Message}");
            }
        }

        /// <summary>
        /// Remove the deploy-time placeholder entry for a given machine+user.
        /// Called from <see cref="EdogPlaygroundHub.EdogIdentify"/> when the
        /// real SignalR session supersedes the deploy-time entry.
        /// </summary>
        public static void RemoveDeployEntry(string machine, string osUser)
        {
            if (string.IsNullOrEmpty(machine) || string.IsNullOrEmpty(osUser))
            {
                return;
            }

            try
            {
                var key = $"deploy-{machine}-{osUser}";
                Sessions.TryRemove(key, out _);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] EdogSessionRegistry.RemoveDeployEntry error: {ex.Message}");
            }
        }

        /// <summary>
        /// Remove a session entry. Called from <see cref="Hub.OnDisconnectedAsync"/>.
        /// Safe to call for an unknown connectionId.
        /// </summary>
        public static void Unregister(string connectionId)
        {
            if (string.IsNullOrEmpty(connectionId))
            {
                return;
            }

            try
            {
                Sessions.TryRemove(connectionId, out _);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] EdogSessionRegistry.Unregister error: {ex.Message}");
            }
        }

        /// <summary>
        /// Bump the LastActivity timestamp for a connection. Called on
        /// significant RPCs so stale dropped connections can be distinguished
        /// from active ones. No-op for unknown connections.
        /// </summary>
        public static void TouchActivity(string connectionId)
        {
            if (string.IsNullOrEmpty(connectionId))
            {
                return;
            }

            try
            {
                if (Sessions.TryGetValue(connectionId, out var entry))
                {
                    entry.LastActivity = DateTime.UtcNow;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] EdogSessionRegistry.TouchActivity error: {ex.Message}");
            }
        }

        /// <summary>
        /// Build a snapshot of the current registry state for the
        /// <c>/api/edog/sessions</c> probe endpoint. Never throws.
        /// </summary>
        public static EdogSessionSnapshot GetSnapshot()
        {
            try
            {
                string id;
                string name;
                string sku;
                lock (ContextLock)
                {
                    id = capacityId;
                    name = capacityName;
                    sku = capacitySku;
                }

                var sessions = Sessions.Values
                    .OrderBy(s => s.ConnectedSince)
                    .ToArray();

                return new EdogSessionSnapshot
                {
                    CapacityId = id,
                    CapacityName = name,
                    CapacitySku = sku,
                    Sessions = sessions,
                    Error = string.IsNullOrEmpty(id) ? "capacity_not_configured" : null,
                };
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] EdogSessionRegistry.GetSnapshot error: {ex.Message}");
                return new EdogSessionSnapshot
                {
                    CapacityId = null,
                    CapacityName = null,
                    CapacitySku = null,
                    Sessions = Array.Empty<EdogSessionEntry>(),
                    Error = "snapshot_failed",
                };
            }
        }

        /// <summary>
        /// Strip control characters and clamp length so a hostile machine
        /// name or OS user can't poison logs / JSON responses.
        /// </summary>
        private static string Sanitize(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return value;
            }

            var chars = value.Where(c => !char.IsControl(c)).Take(256).ToArray();
            return new string(chars);
        }
    }

    /// <summary>
    /// One row in the registry. Mutable LastActivity so TouchActivity is
    /// allocation-free on the hot path.
    /// </summary>
    public sealed class EdogSessionEntry
    {
        public string ConnectionId { get; set; }
        public string Machine { get; set; }
        public string OsUser { get; set; }
        public string LakehouseId { get; set; }
        public string LakehouseName { get; set; }
        public string WorkspaceId { get; set; }
        public string WorkspaceName { get; set; }
        public DateTime ConnectedSince { get; set; }
        public DateTime LastActivity { get; set; }
    }

    /// <summary>
    /// Wire-shape returned by <c>/api/edog/sessions</c>.
    /// </summary>
    public sealed class EdogSessionSnapshot
    {
        public string CapacityId { get; set; }
        public string CapacityName { get; set; }
        public string CapacitySku { get; set; }
        public IReadOnlyList<EdogSessionEntry> Sessions { get; set; }

        /// <summary>Non-null when the snapshot is degraded (e.g. capacity not configured).</summary>
        public string Error { get; set; }
    }
}
