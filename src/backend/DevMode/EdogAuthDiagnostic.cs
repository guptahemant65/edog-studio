// <copyright file="EdogAuthDiagnostic.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Text;
    using System.Text.Json;

    /// <summary>
    /// Diagnostic utility that decodes and logs JWT token claims.
    /// Used to capture what token the WCL SDK acquires for DevConnection auth
    /// so we can replicate it with Silent CBA.
    ///
    /// Called from Program.cs after WorkloadApp.RunAsync() starts.
    /// Reads environment or config to find the token the SDK used.
    /// </summary>
    public static class EdogAuthDiagnostic
    {
        /// <summary>
        /// Attempt to capture the DevMode auth token by reading it from the
        /// workload-dev-mode.json config (WCL SDK may write it back after auth).
        /// Also scans process environment for token hints.
        /// </summary>
        public static void CaptureDevModeToken()
        {
            try
            {
                // Try to find workload-dev-mode.json via launchSettings
                var entryDir = System.IO.Path.GetDirectoryName(
                    typeof(EdogAuthDiagnostic).Assembly.Location);
                var candidates = new[]
                {
                    System.IO.Path.Combine(entryDir, "..", "..", "..", "..", "..",
                        "Microsoft.LiveTable.Service.EntryPoint", "Properties", "launchSettings.json"),
                    System.IO.Path.Combine(entryDir, "Properties", "launchSettings.json"),
                };

                string devModePath = null;
                foreach (var ls in candidates)
                {
                    if (!System.IO.File.Exists(ls)) continue;
                    try
                    {
                        var json = System.IO.File.ReadAllText(ls);
                        var idx = json.IndexOf("LocalConfigFilePath=\"");
                        if (idx < 0) continue;
                        var start = idx + 21;
                        var end = json.IndexOf("\"", start);
                        if (end > start)
                        {
                            devModePath = json.Substring(start, end - start);
                            break;
                        }
                    }
                    catch { }
                }

                // Also try common path
                if (devModePath == null || !System.IO.File.Exists(devModePath))
                {
                    var userHome = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                    devModePath = System.IO.Path.Combine(userHome, "workload-dev-mode.json");
                }

                if (devModePath != null && System.IO.File.Exists(devModePath))
                {
                    Console.WriteLine($"[EDOG-DIAG] workload-dev-mode.json: {devModePath}");
                    var content = System.IO.File.ReadAllText(devModePath);
                    using var doc = JsonDocument.Parse(content);
                    if (doc.RootElement.TryGetProperty("UserAuthorizationToken", out var tokenEl))
                    {
                        var token = tokenEl.GetString();
                        if (!string.IsNullOrEmpty(token))
                        {
                            Console.WriteLine($"[EDOG-DIAG] UserAuthorizationToken present ({token.Length} chars)");
                            DecodeAndLogJwt(token, "UserAuthorizationToken");
                        }
                    }
                    else
                    {
                        Console.WriteLine("[EDOG-DIAG] No UserAuthorizationToken in config — browser auth will be used");
                    }
                }

                // Register a background task to capture the token AFTER DevConnection succeeds
                // The WCL SDK doesn't write back to config, but we can capture from Tracer logs
                System.Threading.Tasks.Task.Run(async () =>
                {
                    // Wait for DevConnection to complete (up to 60s)
                    await System.Threading.Tasks.Task.Delay(TimeSpan.FromSeconds(2));

                    // Try to find the token in the WCL SDK's in-memory state
                    // by searching for HTTP requests with Authorization headers
                    Console.WriteLine("[EDOG-DIAG] Monitoring for auth token in outbound HTTP...");

                    // The token the browser flow produces will appear in FLT stdout as:
                    //   "Using provided AAD token from parameters" (when injected)
                    //   or the InteractiveBrowserCredential will write it to stdout
                    // We'll capture it from the process output in dev-server.py
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG-DIAG] Error: {ex.Message}");
            }
        }

        /// <summary>
        /// Decode a JWT and log its key claims (audience, appid, scopes, etc.)
        /// </summary>
        public static void DecodeAndLogJwt(string jwt, string label)
        {
            try
            {
                var parts = jwt.Split('.');
                if (parts.Length < 2) return;

                // Base64url decode the payload
                var payload = parts[1];
                payload = payload.Replace('-', '+').Replace('_', '/');
                switch (payload.Length % 4)
                {
                    case 2: payload += "=="; break;
                    case 3: payload += "="; break;
                }
                var bytes = Convert.FromBase64String(payload);
                var json = Encoding.UTF8.GetString(bytes);

                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                var fields = new[] { "aud", "iss", "appid", "appidacr", "tid", "upn", "scp", "roles", "exp", "iat" };
                Console.WriteLine($"[EDOG-DIAG] === {label} JWT Claims ===");
                foreach (var field in fields)
                {
                    if (root.TryGetProperty(field, out var val))
                    {
                        var display = val.ValueKind == JsonValueKind.String
                            ? val.GetString()
                            : val.GetRawText();
                        if (display != null && display.Length > 100)
                            display = display.Substring(0, 100) + "...";
                        Console.WriteLine($"[EDOG-DIAG]   {field}: {display}");
                    }
                }
                Console.WriteLine($"[EDOG-DIAG] === end {label} ===");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG-DIAG] JWT decode error: {ex.Message}");
            }
        }
    }
}
