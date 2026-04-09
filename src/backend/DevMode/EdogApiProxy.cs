// <copyright file="EdogApiProxy.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.IO;
    using System.Text;
    using System.Text.Json;
    using System.Threading.Tasks;
    using Microsoft.AspNetCore.Http;

    /// <summary>
    /// Serves EDOG config, MWC token, and bearer (AAD/Entra) token
    /// to the Command Center frontend. The browser calls Fabric APIs
    /// directly with the provided tokens.
    /// </summary>
    internal sealed class EdogApiProxy
    {
        private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

        private readonly string configDir;

        public EdogApiProxy(string configDirectory)
        {
            this.configDir = configDirectory;
        }

        public async Task HandleConfig(HttpContext context)
        {
            context.Response.ContentType = "application/json";
            try
            {
                var config = await ReadConfig();
                if (config == null)
                {
                    await WriteError(context, 503, "config_not_found", "edog-config.json not found");
                    return;
                }

                var token = ReadToken();
                double expiryMinutes = 0;
                bool tokenExpired = true;
                string mwcToken = null;
                string fabricBaseUrl = null;

                if (token != null)
                {
                    expiryMinutes = Math.Max(0, Math.Floor((token.Value.ExpiryUtc - DateTime.UtcNow).TotalMinutes));
                    tokenExpired = false;
                    mwcToken = token.Value.Token;
                    fabricBaseUrl = BuildBaseUrl(config);
                }

                var bearerTokenInfo = ReadBearerToken();
                string bearerToken = bearerTokenInfo?.Token;
                string phase = mwcToken != null ? "connected" : "disconnected";

                await context.Response.WriteAsync(JsonSerializer.Serialize(new
                {
                    workspaceId = config.WorkspaceId,
                    artifactId = config.ArtifactId,
                    capacityId = config.CapacityId,
                    tokenExpiryMinutes = (int)expiryMinutes,
                    tokenExpired,
                    mwcToken,
                    fabricBaseUrl,
                    bearerToken,
                    phase
                }, JsonOpts));
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] HandleConfig error: {ex}");
                await WriteError(context, 500, "internal_error", ex.Message);
            }
        }

        private static async Task WriteError(HttpContext context, int statusCode, string error, string message)
        {
            context.Response.StatusCode = statusCode;
            await context.Response.WriteAsync(JsonSerializer.Serialize(new { error, message }, JsonOpts));
        }

        private static string BuildBaseUrl(EdogConfig config)
        {
            return $"https://{config.CapacityId}.pbidedicated.windows-int.net/webapi/capacities/{config.CapacityId}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{config.WorkspaceId}/lakehouses/{config.ArtifactId}";
        }

        private async Task<EdogConfig> ReadConfig()
        {
            var path = Path.Combine(configDir, "edog-config.json");
            try
            {
                var json = await File.ReadAllTextAsync(path);
                var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                return new EdogConfig
                {
                    WorkspaceId = root.GetProperty("workspace_id").GetString(),
                    ArtifactId = root.GetProperty("artifact_id").GetString(),
                    CapacityId = root.GetProperty("capacity_id").GetString()
                };
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Failed to read config: {ex.Message}");
                return null;
            }
        }

        private TokenInfo? ReadToken()
        {
            var path = Path.Combine(configDir, ".edog-token-cache");
            try
            {
                var raw = File.ReadAllText(path).Trim();
                var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(raw));

                var separatorIndex = decoded.IndexOf('|');
                if (separatorIndex < 0)
                {
                    Console.WriteLine("[EDOG] Token cache has invalid format (no | separator)");
                    return null;
                }

                var expiryStr = decoded.Substring(0, separatorIndex);
                var token = decoded.Substring(separatorIndex + 1);

                if (!double.TryParse(expiryStr, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var expiryUnix))
                {
                    Console.WriteLine("[EDOG] Token cache has invalid expiry timestamp");
                    return null;
                }

                var expiryUtc = DateTimeOffset.FromUnixTimeSeconds((long)expiryUnix).UtcDateTime;
                var now = DateTime.UtcNow;

                // 5-minute buffer matching edog.py's logic
                if (now >= expiryUtc.AddSeconds(-300))
                {
                    Console.WriteLine("[EDOG] Token expired or expiring within 5 minutes");
                    return null;
                }

                return new TokenInfo { Token = token, ExpiryUtc = expiryUtc };
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Failed to read token: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Reads the cached bearer (AAD/Entra) token from .edog-bearer-cache.
        /// Format is identical to the MWC token cache: base64(timestamp|token).
        /// Used by the frontend to call Fabric public APIs directly.
        /// </summary>
        private TokenInfo? ReadBearerToken()
        {
            var path = Path.Combine(configDir, ".edog-bearer-cache");
            try
            {
                var raw = File.ReadAllText(path).Trim();
                var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(raw));

                var separatorIndex = decoded.IndexOf('|');
                if (separatorIndex < 0)
                {
                    Console.WriteLine("[EDOG] Bearer token cache has invalid format (no | separator)");
                    return null;
                }

                var expiryStr = decoded.Substring(0, separatorIndex);
                var token = decoded.Substring(separatorIndex + 1);

                if (!double.TryParse(expiryStr, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var expiryUnix))
                {
                    Console.WriteLine("[EDOG] Bearer token cache has invalid expiry timestamp");
                    return null;
                }

                var expiryUtc = DateTimeOffset.FromUnixTimeSeconds((long)expiryUnix).UtcDateTime;
                var now = DateTime.UtcNow;

                // 5-minute buffer matching edog.py's logic
                if (now >= expiryUtc.AddSeconds(-300))
                {
                    Console.WriteLine("[EDOG] Bearer token expired or expiring within 5 minutes");
                    return null;
                }

                return new TokenInfo { Token = token, ExpiryUtc = expiryUtc };
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Failed to read bearer token: {ex.Message}");
                return null;
            }
        }

        private class EdogConfig
        {
            public string WorkspaceId { get; set; }
            public string ArtifactId { get; set; }
            public string CapacityId { get; set; }
        }

        private struct TokenInfo
        {
            public string Token { get; set; }
            public DateTime ExpiryUtc { get; set; }
        }
    }
}
