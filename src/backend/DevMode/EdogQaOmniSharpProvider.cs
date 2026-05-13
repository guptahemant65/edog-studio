// <copyright file="EdogQaOmniSharpProvider.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.IO;
    using System.Linq;
    using System.Net;
    using System.Net.Http;
    using System.Net.Sockets;
    using System.Text;
    using System.Text.Json;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Threading.Tasks;

    /// <summary>
    /// L3: Semantic enrichment provider using OmniSharp/Roslyn.
    /// Manages an OmniSharp subprocess with HTTP API for LSP-style queries.
    /// Falls back to regex-based analysis if OmniSharp is unavailable.
    /// </summary>
    internal sealed class EdogQaOmniSharpProvider : IOmniSharpProvider, IDisposable
    {
        private readonly HttpClient httpClient = new HttpClient();
        private Process omniSharpProcess;
        private int omniSharpPort;
        private string baseUrl;
        private bool isReady;
        private bool useFallback;
        private string sourceRoot;
        private readonly SemaphoreSlim initLock = new SemaphoreSlim(1, 1);
        private bool disposed;

        public bool IsReady => this.isReady;

        public async Task WarmUpAsync(string solutionPath, CancellationToken cancellationToken = default)
        {
            await this.initLock.WaitAsync(cancellationToken);
            try
            {
                if (this.isReady)
                {
                    return;
                }

                this.sourceRoot = Path.GetDirectoryName(solutionPath) ?? Environment.CurrentDirectory;

                var omniSharpPath = this.FindOmniSharpBinary();
                if (string.IsNullOrEmpty(omniSharpPath))
                {
                    Console.WriteLine("[EDOG] OmniSharp binary not found. Falling back to regex-based analysis.");
                    this.useFallback = true;
                    this.isReady = true;
                    return;
                }

                this.omniSharpPort = this.GetFreePort();
                this.baseUrl = $"http://localhost:{this.omniSharpPort}";

                Console.WriteLine($"[EDOG] Starting OmniSharp on port {this.omniSharpPort}...");

                var startInfo = new ProcessStartInfo
                {
                    FileName = omniSharpPath,
                    Arguments = $"--hostPID {Process.GetCurrentProcess().Id} -s \"{solutionPath}\" --port {this.omniSharpPort}",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };

                this.omniSharpProcess = Process.Start(startInfo);
                if (this.omniSharpProcess == null)
                {
                    Console.WriteLine("[EDOG] Failed to start OmniSharp process. Using fallback mode.");
                    this.useFallback = true;
                    this.isReady = true;
                    return;
                }

                var ready = await this.WaitForReadyAsync(cancellationToken);
                if (ready)
                {
                    Console.WriteLine("[EDOG] OmniSharp ready.");
                    this.isReady = true;
                    this.useFallback = false;
                }
                else
                {
                    Console.WriteLine("[EDOG] OmniSharp failed to become ready. Using fallback mode.");
                    this.KillProcess();
                    this.useFallback = true;
                    this.isReady = true;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] WarmUp error: {ex.Message}. Using fallback mode.");
                this.useFallback = true;
                this.isReady = true;
            }
            finally
            {
                this.initLock.Release();
            }
        }

        public async Task EnrichGraphAsync(
            CodeGraph graph,
            List<ChangedSymbol> changedSymbols,
            int maxConcurrentQueries = 4,
            CancellationToken cancellationToken = default)
        {
            if (!this.isReady)
            {
                return;
            }

            var semaphore = new SemaphoreSlim(maxConcurrentQueries, maxConcurrentQueries);
            var tasks = new List<Task>();

            foreach (var symbol in changedSymbols)
            {
                var task = Task.Run(async () =>
                {
                    await semaphore.WaitAsync(cancellationToken);
                    try
                    {
                        await this.EnrichSymbolAsync(graph, symbol, cancellationToken);
                    }
                    finally
                    {
                        semaphore.Release();
                    }
                }, cancellationToken);

                tasks.Add(task);
            }

            await Task.WhenAll(tasks);
        }

        public async Task<List<string>> FindImplementationsAsync(
            string interfaceType,
            CancellationToken cancellationToken = default)
        {
            if (!this.isReady)
            {
                return new List<string>();
            }

            if (this.useFallback)
            {
                return await this.FindImplementationsFallbackAsync(interfaceType, cancellationToken);
            }

            try
            {
                var symbols = await this.FindSymbolsAsync(interfaceType, cancellationToken);
                var implementations = new HashSet<string>();

                foreach (var symbol in symbols)
                {
                    var impls = await this.GetImplementationsViaOmniSharpAsync(
                        symbol.FileName,
                        symbol.Line,
                        symbol.Column,
                        cancellationToken);

                    foreach (var impl in impls)
                    {
                        implementations.Add(impl);
                    }
                }

                return implementations.ToList();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] FindImplementations error: {ex.Message}");
                return new List<string>();
            }
        }

        public async Task<List<CallerInfo>> GetIncomingCallsAsync(
            string filePath,
            string methodName,
            int maxDepth = 4,
            CancellationToken cancellationToken = default)
        {
            if (!this.isReady)
            {
                return new List<CallerInfo>();
            }

            if (this.useFallback)
            {
                return await this.GetIncomingCallsFallbackAsync(methodName, cancellationToken);
            }

            try
            {
                var symbols = await this.FindSymbolsAsync(methodName, cancellationToken);
                var callers = new List<CallerInfo>();

                foreach (var symbol in symbols.Where(s => s.FileName.Contains(Path.GetFileName(filePath))))
                {
                    var usages = await this.FindUsagesAsync(
                        symbol.FileName,
                        symbol.Line,
                        symbol.Column,
                        cancellationToken);

                    foreach (var usage in usages)
                    {
                        callers.Add(new CallerInfo
                        {
                            File = usage.FileName,
                            Method = usage.ContainingMethod ?? "Unknown",
                            Line = usage.Line,
                            ContainingType = usage.ContainingType ?? "Unknown"
                        });
                    }
                }

                return callers.Take(maxDepth * 10).ToList();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] GetIncomingCalls error: {ex.Message}");
                return new List<CallerInfo>();
            }
        }

        public void Dispose()
        {
            if (this.disposed)
            {
                return;
            }

            this.KillProcess();
            this.httpClient?.Dispose();
            this.initLock?.Dispose();
            this.disposed = true;
        }

        private async Task EnrichSymbolAsync(CodeGraph graph, ChangedSymbol symbol, CancellationToken cancellationToken)
        {
            try
            {
                if (this.useFallback)
                {
                    await this.EnrichSymbolFallbackAsync(graph, symbol, cancellationToken);
                    return;
                }

                var symbols = await this.FindSymbolsAsync(symbol.Method, cancellationToken);
                var targetSymbol = symbols.FirstOrDefault(s => s.FileName.Contains(Path.GetFileName(symbol.File)));

                if (targetSymbol == null)
                {
                    return;
                }

                var nodeId = $"{symbol.File}:{symbol.Method}";
                if (!graph.Nodes.TryGetValue(nodeId, out var node))
                {
                    node = new GraphNode
                    {
                        Id = nodeId,
                        File = symbol.File,
                        Method = symbol.Method,
                        NodeType = "method"
                    };
                    graph.AddNode(node);
                }

                var implementations = await this.GetImplementationsViaOmniSharpAsync(
                    targetSymbol.FileName,
                    targetSymbol.Line,
                    targetSymbol.Column,
                    cancellationToken);

                foreach (var impl in implementations)
                {
                    var implNodeId = $"impl:{impl}";
                    var implNode = new GraphNode
                    {
                        Id = implNodeId,
                        File = "unknown",
                        Method = impl,
                        NodeType = "implementation"
                    };

                    if (!graph.Nodes.ContainsKey(implNodeId))
                    {
                        graph.AddNode(implNode);
                    }

                    graph.AddEdge(new GraphEdge
                    {
                        Source = node.Id,
                        Target = implNodeId,
                        EdgeType = "interface_dispatch",
                        Source_ = "l3"
                    });
                }

                var usages = await this.FindUsagesAsync(
                    targetSymbol.FileName,
                    targetSymbol.Line,
                    targetSymbol.Column,
                    cancellationToken);

                foreach (var usage in usages.Take(20))
                {
                    var callerNodeId = $"{usage.FileName}:{usage.ContainingMethod ?? "Unknown"}";
                    var callerNode = new GraphNode
                    {
                        Id = callerNodeId,
                        File = usage.FileName,
                        Method = usage.ContainingMethod ?? "Unknown",
                        NodeType = "method"
                    };

                    if (!graph.Nodes.ContainsKey(callerNodeId))
                    {
                        graph.AddNode(callerNode);
                    }

                    graph.AddEdge(new GraphEdge
                    {
                        Source = callerNodeId,
                        Target = node.Id,
                        EdgeType = "semantic_call",
                        Source_ = "l3"
                    });
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] EnrichSymbol error for {symbol.Method}: {ex.Message}");
            }
        }

        private async Task<bool> WaitForReadyAsync(CancellationToken cancellationToken)
        {
            var timeout = TimeSpan.FromSeconds(60);
            var stopwatch = Stopwatch.StartNew();

            while (stopwatch.Elapsed < timeout)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    return false;
                }

                try
                {
                    var response = await this.httpClient.GetAsync(
                        $"{this.baseUrl}/checkreadystatus",
                        cancellationToken);

                    if (response.IsSuccessStatusCode)
                    {
                        return true;
                    }
                }
                catch
                {
                    // Not ready yet
                }

                await Task.Delay(1000, cancellationToken);
            }

            return false;
        }

        private async Task<List<OmniSharpSymbol>> FindSymbolsAsync(string filter, CancellationToken cancellationToken)
        {
            var payload = new { Filter = filter };
            var response = await this.PostOmniSharpAsync("/findsymbols", payload, cancellationToken);

            if (string.IsNullOrEmpty(response))
            {
                return new List<OmniSharpSymbol>();
            }

            var result = JsonSerializer.Deserialize<FindSymbolsResponse>(response);
            return result?.QuickFixes ?? new List<OmniSharpSymbol>();
        }

        private async Task<List<string>> GetImplementationsViaOmniSharpAsync(
            string fileName,
            int line,
            int column,
            CancellationToken cancellationToken)
        {
            var payload = new { FileName = fileName, Line = line, Column = column };
            var response = await this.PostOmniSharpAsync("/findimplementations", payload, cancellationToken);

            if (string.IsNullOrEmpty(response))
            {
                return new List<string>();
            }

            var result = JsonSerializer.Deserialize<FindImplementationsResponse>(response);
            return result?.QuickFixes?.Select(qf => qf.Text ?? "Unknown").Distinct().ToList() ?? new List<string>();
        }

        private async Task<List<UsageInfo>> FindUsagesAsync(
            string fileName,
            int line,
            int column,
            CancellationToken cancellationToken)
        {
            var payload = new { FileName = fileName, Line = line, Column = column };
            var response = await this.PostOmniSharpAsync("/findusages", payload, cancellationToken);

            if (string.IsNullOrEmpty(response))
            {
                return new List<UsageInfo>();
            }

            var result = JsonSerializer.Deserialize<FindUsagesResponse>(response);
            return result?.QuickFixes ?? new List<UsageInfo>();
        }

        private async Task<string> PostOmniSharpAsync(string endpoint, object payload, CancellationToken cancellationToken)
        {
            try
            {
                var json = JsonSerializer.Serialize(payload);
                var content = new StringContent(json, Encoding.UTF8, "application/json");

                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, cts.Token);

                var response = await this.httpClient.PostAsync($"{this.baseUrl}{endpoint}", content, linked.Token);
                response.EnsureSuccessStatusCode();

                return await response.Content.ReadAsStringAsync();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] OmniSharp API error ({endpoint}): {ex.Message}");
                return null;
            }
        }

        private async Task<List<string>> FindImplementationsFallbackAsync(string interfaceType, CancellationToken cancellationToken)
        {
            var implementations = new HashSet<string>();
            var pattern = new Regex(@"class\s+(\w+)\s*:\s*[^{]*\b" + Regex.Escape(interfaceType) + @"\b", RegexOptions.Compiled);

            await Task.Run(() =>
            {
                var csFiles = Directory.GetFiles(this.sourceRoot, "*.cs", SearchOption.AllDirectories);
                foreach (var file in csFiles)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        break;
                    }

                    try
                    {
                        var content = File.ReadAllText(file);
                        var matches = pattern.Matches(content);
                        foreach (Match match in matches)
                        {
                            implementations.Add(match.Groups[1].Value);
                        }
                    }
                    catch
                    {
                        // Skip unreadable files
                    }
                }
            }, cancellationToken);

            return implementations.ToList();
        }

        private async Task<List<CallerInfo>> GetIncomingCallsFallbackAsync(string methodName, CancellationToken cancellationToken)
        {
            var callers = new List<CallerInfo>();
            var pattern = new Regex(@"\." + Regex.Escape(methodName) + @"\s*\(", RegexOptions.Compiled);

            await Task.Run(() =>
            {
                var csFiles = Directory.GetFiles(this.sourceRoot, "*.cs", SearchOption.AllDirectories);
                foreach (var file in csFiles)
                {
                    if (cancellationToken.IsCancellationRequested || callers.Count >= 50)
                    {
                        break;
                    }

                    try
                    {
                        var lines = File.ReadAllLines(file);
                        for (int i = 0; i < lines.Length; i++)
                        {
                            if (pattern.IsMatch(lines[i]))
                            {
                                callers.Add(new CallerInfo
                                {
                                    File = file,
                                    Method = "Unknown (regex scan)",
                                    Line = i + 1,
                                    ContainingType = "Unknown"
                                });
                            }
                        }
                    }
                    catch
                    {
                        // Skip unreadable files
                    }
                }
            }, cancellationToken);

            return callers;
        }

        private async Task EnrichSymbolFallbackAsync(CodeGraph graph, ChangedSymbol symbol, CancellationToken cancellationToken)
        {
            var callers = await this.GetIncomingCallsFallbackAsync(symbol.Method, cancellationToken);

            var nodeId = $"{symbol.File}:{symbol.Method}";
            if (!graph.Nodes.TryGetValue(nodeId, out var node))
            {
                node = new GraphNode
                {
                    Id = nodeId,
                    File = symbol.File,
                    Method = symbol.Method,
                    NodeType = "method"
                };
                graph.AddNode(node);
            }

            foreach (var caller in callers.Take(10))
            {
                var callerNodeId = $"{caller.File}:{caller.Method}";
                var callerNode = new GraphNode
                {
                    Id = callerNodeId,
                    File = caller.File,
                    Method = caller.Method,
                    NodeType = "method"
                };

                if (!graph.Nodes.ContainsKey(callerNodeId))
                {
                    graph.AddNode(callerNode);
                }

                graph.AddEdge(new GraphEdge
                {
                    Source = callerNodeId,
                    Target = node.Id,
                    EdgeType = "semantic_call",
                    Source_ = "l3"
                });
            }
        }

        private string FindOmniSharpBinary()
        {
            var envPath = Environment.GetEnvironmentVariable("OMNISHARP_PATH");
            if (!string.IsNullOrEmpty(envPath) && File.Exists(envPath))
            {
                return envPath;
            }

            var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var candidates = new[]
            {
                Path.Combine(userProfile, ".dotnet", "tools", "omnisharp.exe"),
                Path.Combine(userProfile, ".dotnet", "tools", "omnisharp"),
                Path.Combine(userProfile, ".omnisharp", "omnisharp.exe"),
                Path.Combine(userProfile, ".omnisharp", "omnisharp"),
                "omnisharp.exe",
                "omnisharp"
            };

            foreach (var candidate in candidates)
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                var fullPath = this.FindInPath(candidate);
                if (fullPath != null)
                {
                    return fullPath;
                }
            }

            return null;
        }

        private string FindInPath(string fileName)
        {
            var pathVar = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(pathVar))
            {
                return null;
            }

            var paths = pathVar.Split(Path.PathSeparator);
            foreach (var path in paths)
            {
                try
                {
                    var fullPath = Path.Combine(path, fileName);
                    if (File.Exists(fullPath))
                    {
                        return fullPath;
                    }
                }
                catch
                {
                    // Skip invalid paths
                }
            }

            return null;
        }

        private int GetFreePort()
        {
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            socket.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            return ((IPEndPoint)socket.LocalEndPoint).Port;
        }

        private void KillProcess()
        {
            if (this.omniSharpProcess == null)
            {
                return;
            }

            try
            {
                if (!this.omniSharpProcess.HasExited)
                {
                    this.omniSharpProcess.Kill(entireProcessTree: true);
                    this.omniSharpProcess.WaitForExit(5000);
                }

                this.omniSharpProcess.Dispose();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Error killing OmniSharp process: {ex.Message}");
            }
            finally
            {
                this.omniSharpProcess = null;
            }
        }

        private class OmniSharpSymbol
        {
            public string FileName { get; set; }
            public int Line { get; set; }
            public int Column { get; set; }
            public string Text { get; set; }
        }

        private class UsageInfo
        {
            public string FileName { get; set; }
            public int Line { get; set; }
            public int Column { get; set; }
            public string ContainingMethod { get; set; }
            public string ContainingType { get; set; }
        }

        private class FindSymbolsResponse
        {
            public List<OmniSharpSymbol> QuickFixes { get; set; }
        }

        private class FindImplementationsResponse
        {
            public List<OmniSharpSymbol> QuickFixes { get; set; }
        }

        private class FindUsagesResponse
        {
            public List<UsageInfo> QuickFixes { get; set; }
        }
    }
}
