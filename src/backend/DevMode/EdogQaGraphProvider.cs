// <copyright file="EdogQaGraphProvider.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Threading.Tasks;

    /// <summary>
    /// Real L1+L2 structural graph provider that builds a code graph from C# source files
    /// using file-based regex analysis. Implements BFS blast radius from changed symbols
    /// and cross-file relationship detection (inheritance, interfaces, field refs).
    /// </summary>
    internal sealed class EdogQaGraphProvider : IGraphProvider
    {
        private static readonly Regex ClassRegex = new Regex(
            @"(?:public|internal|private)?\s*(?:sealed|abstract|static)?\s*class\s+(\w+)",
            RegexOptions.Compiled);

        private static readonly Regex InterfaceRegex = new Regex(
            @"(?:public|internal)?\s*interface\s+(I\w+)",
            RegexOptions.Compiled);

        private static readonly Regex MethodRegex = new Regex(
            @"(?:public|private|protected|internal|static|async|override|virtual)\s+[\w<>,\s]+\s+(\w+)\s*\(",
            RegexOptions.Compiled);

        private static readonly Regex ConstructorRegex = new Regex(
            @"(?:public|private|protected|internal)\s+(\w+)\s*\(",
            RegexOptions.Compiled);

        private static readonly Regex MethodCallRegex = new Regex(
            @"(\w+)\.(\w+)\(",
            RegexOptions.Compiled);

        private static readonly Regex InheritanceRegex = new Regex(
            @"class\s+(\w+)\s*:\s*([\w<>,\s]+)",
            RegexOptions.Compiled);

        private static readonly Regex FieldRefRegex = new Regex(
            @"(?:private|protected|internal|public)\s+(?:readonly\s+)?(?:static\s+)?(I?\w+)\s+\w+",
            RegexOptions.Compiled);

        private static readonly Regex NamespaceRegex = new Regex(
            @"namespace\s+([\w\.]+)",
            RegexOptions.Compiled);

        private readonly ConcurrentDictionary<string, ParsedFile> _fileCache = new();
        private string _sourceRoot;

        /// <summary>
        /// Builds a structural code graph from changed symbols using L1 call graph + L2 cross-file relationships.
        /// </summary>
        /// <param name="changedSymbols">List of changed symbols from PR diff.</param>
        /// <param name="maxDepth">Maximum BFS depth for blast radius expansion.</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        /// <returns>Complete code graph with nodes, edges, and community assignments.</returns>
        public async Task<CodeGraph> BuildStructuralGraphAsync(
            List<ChangedSymbol> changedSymbols,
            int maxDepth = 4,
            CancellationToken cancellationToken = default)
        {
            Console.WriteLine($"[EDOG] Building structural graph for {changedSymbols.Count} changed symbols (maxDepth={maxDepth})");

            // Phase 1: Find source root
            _sourceRoot = FindSourceRoot();
            if (_sourceRoot == null)
            {
                Console.WriteLine("[EDOG] WARNING: Could not find source root, using CWD");
                _sourceRoot = Directory.GetCurrentDirectory();
            }
            else
            {
                Console.WriteLine($"[EDOG] Source root: {_sourceRoot}");
            }

            var graph = new CodeGraph();

            // Phase 2: Parse changed files and build initial nodes
            var changedNodes = await ParseChangedFilesAsync(changedSymbols, graph, cancellationToken);
            Console.WriteLine($"[EDOG] Parsed {changedNodes.Count} changed nodes");

            // Phase 3: BFS blast radius expansion
            await ExpandBlastRadiusAsync(changedNodes, graph, maxDepth, cancellationToken);
            Console.WriteLine($"[EDOG] Graph expanded to {graph.Nodes.Count} nodes");

            // Phase 4: L2 cross-file relationships
            await BuildCrossFileRelationshipsAsync(graph, cancellationToken);
            Console.WriteLine($"[EDOG] Added L2 relationships, total edges: {graph.Edges.Count}");

            // Phase 5: Community detection
            AssignCommunities(graph);
            Console.WriteLine($"[EDOG] Assigned {graph.Communities.Count} communities");

            return graph;
        }

        /// <summary>
        /// Finds the source root by checking EDOG_FLT_SOURCE_ROOT env var or walking up for .sln file.
        /// </summary>
        private static string FindSourceRoot()
        {
            // 1. Check env var
            var envRoot = Environment.GetEnvironmentVariable("EDOG_FLT_SOURCE_ROOT");
            if (!string.IsNullOrEmpty(envRoot) && Directory.Exists(envRoot))
            {
                return envRoot;
            }

            // 2. Walk up from CWD looking for .sln
            var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
            while (dir != null)
            {
                if (dir.GetFiles("*.sln").Length > 0)
                {
                    return dir.FullName;
                }

                dir = dir.Parent;
            }

            return null;
        }

        /// <summary>
        /// Parses all changed files and adds their symbols to the graph.
        /// </summary>
        private async Task<List<GraphNode>> ParseChangedFilesAsync(
            List<ChangedSymbol> changedSymbols,
            CodeGraph graph,
            CancellationToken cancellationToken)
        {
            var changedNodes = new List<GraphNode>();
            var filesToParse = changedSymbols.Select(s => s.File).Distinct().ToList();

            // Parse files in parallel (4 concurrent)
            var semaphore = new SemaphoreSlim(4);
            var tasks = filesToParse.Select(async file =>
            {
                await semaphore.WaitAsync(cancellationToken);
                try
                {
                    var parsed = await ParseFileAsync(file, cancellationToken);
                    if (parsed != null)
                    {
                        return (file, parsed);
                    }
                }
                finally
                {
                    semaphore.Release();
                }

                return (file, null);
            });

            var results = await Task.WhenAll(tasks);

            // Build nodes and edges from parsed files
            foreach (var (file, parsed) in results)
            {
                if (parsed == null) continue;

                foreach (var symbol in parsed.Symbols)
                {
                    var nodeId = $"{file}:{symbol.Name}";
                    var node = new GraphNode
                    {
                        Id = nodeId,
                        File = file,
                        Method = symbol.Name,
                        NodeType = symbol.Type,
                        IsChanged = true
                    };

                    graph.AddNode(node);
                    changedNodes.Add(node);

                    // Add call edges from this symbol
                    foreach (var call in symbol.Calls)
                    {
                        var targetId = $"{file}:{call}"; // Same file for now, cross-file in L2
                        graph.AddEdge(new GraphEdge
                        {
                            Source = nodeId,
                            Target = targetId,
                            EdgeType = "direct_call",
                            Weight = 1.0
                        });
                    }
                }
            }

            return changedNodes;
        }

        /// <summary>
        /// Parses a C# file and extracts symbols and calls.
        /// </summary>
        private async Task<ParsedFile> ParseFileAsync(string filePath, CancellationToken cancellationToken)
        {
            if (_fileCache.TryGetValue(filePath, out var cached))
            {
                return cached;
            }

            var fullPath = Path.IsPathRooted(filePath) ? filePath : Path.Combine(_sourceRoot, filePath);
            fullPath = Path.GetFullPath(fullPath);

            // Prevent directory traversal outside source root
            if (!fullPath.StartsWith(Path.GetFullPath(_sourceRoot), StringComparison.OrdinalIgnoreCase))
            {
                Console.WriteLine($"[EDOG] WARNING: Path traversal blocked: {filePath}");
                return null;
            }

            if (!File.Exists(fullPath))
            {
                Console.WriteLine($"[EDOG] WARNING: File not found: {fullPath}");
                return null;
            }

            if (!fullPath.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            // Skip common vendor/generated directories
            if (fullPath.Contains("\\bin\\") || fullPath.Contains("\\obj\\") ||
                fullPath.Contains("\\packages\\") || fullPath.Contains("\\node_modules\\"))
            {
                return null;
            }

            try
            {
                var content = await File.ReadAllTextAsync(fullPath, cancellationToken);
                var parsed = ParseFileContent(filePath, content);
                _fileCache[filePath] = parsed;
                return parsed;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] ERROR parsing {fullPath}: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Parses file content and extracts symbols, calls, inheritance, etc.
        /// </summary>
        private ParsedFile ParseFileContent(string filePath, string content)
        {
            var parsed = new ParsedFile { FilePath = filePath };

            // Extract namespace
            var nsMatch = NamespaceRegex.Match(content);
            if (nsMatch.Success)
            {
                parsed.Namespace = nsMatch.Groups[1].Value;
            }

            // Extract classes
            foreach (Match match in ClassRegex.Matches(content))
            {
                var className = match.Groups[1].Value;
                parsed.Symbols.Add(new SymbolInfo
                {
                    Name = className,
                    Type = "class"
                });
            }

            // Extract interfaces
            foreach (Match match in InterfaceRegex.Matches(content))
            {
                var interfaceName = match.Groups[1].Value;
                parsed.Symbols.Add(new SymbolInfo
                {
                    Name = interfaceName,
                    Type = "interface"
                });
            }

            // Extract methods
            foreach (Match match in MethodRegex.Matches(content))
            {
                var methodName = match.Groups[1].Value;
                if (methodName != "class" && methodName != "interface")
                {
                    var symbol = new SymbolInfo
                    {
                        Name = methodName,
                        Type = "method"
                    };

                    // Extract calls from method body (crude: get text after method declaration)
                    var startIdx = match.Index;
                    var endIdx = content.IndexOf('}', startIdx);
                    if (endIdx > startIdx)
                    {
                        var methodBody = content.Substring(startIdx, endIdx - startIdx);
                        foreach (Match callMatch in MethodCallRegex.Matches(methodBody))
                        {
                            var calledMethod = callMatch.Groups[2].Value;
                            symbol.Calls.Add(calledMethod);
                        }
                    }

                    parsed.Symbols.Add(symbol);
                }
            }

            // Extract constructors
            foreach (Match match in ConstructorRegex.Matches(content))
            {
                var ctorName = match.Groups[1].Value;
                parsed.Symbols.Add(new SymbolInfo
                {
                    Name = ctorName,
                    Type = "method"
                });
            }

            // Extract inheritance relationships
            foreach (Match match in InheritanceRegex.Matches(content))
            {
                var className = match.Groups[1].Value;
                var bases = match.Groups[2].Value.Split(',').Select(b => b.Trim()).ToList();
                parsed.Inheritance[className] = bases;
            }

            // Extract field references
            foreach (Match match in FieldRefRegex.Matches(content))
            {
                var typeName = match.Groups[1].Value;
                parsed.FieldRefs.Add(typeName);
            }

            return parsed;
        }

        /// <summary>
        /// Expands the graph via BFS from changed nodes up to maxDepth.
        /// </summary>
        private async Task ExpandBlastRadiusAsync(
            List<GraphNode> changedNodes,
            CodeGraph graph,
            int maxDepth,
            CancellationToken cancellationToken)
        {
            var visited = new HashSet<string>(changedNodes.Select(n => n.Id));
            var queue = new Queue<(GraphNode node, int depth)>();

            foreach (var node in changedNodes)
            {
                queue.Enqueue((node, 0));
            }

            while (queue.Count > 0)
            {
                var (currentNode, depth) = queue.Dequeue();

                if (depth >= maxDepth)
                {
                    continue;
                }

                // Get outgoing edges (calls from this node)
                var outgoing = graph.GetOutgoingEdges(currentNode.Id);
                foreach (var edge in outgoing)
                {
                    if (visited.Contains(edge.Target))
                    {
                        continue;
                    }

                    visited.Add(edge.Target);

                    // If target node doesn't exist, try to create it
                    if (!graph.Nodes.ContainsKey(edge.Target))
                    {
                        var (file, method) = ParseNodeId(edge.Target);
                        if (file != null)
                        {
                            await ParseFileAsync(file, cancellationToken);

                            // Try to find the node now
                            if (graph.Nodes.ContainsKey(edge.Target))
                            {
                                queue.Enqueue((graph.Nodes[edge.Target], depth + 1));
                            }
                        }
                    }
                    else
                    {
                        queue.Enqueue((graph.Nodes[edge.Target], depth + 1));
                    }
                }

                // Get incoming edges (calls to this node)
                var incoming = graph.GetIncomingEdges(currentNode.Id);
                foreach (var edge in incoming)
                {
                    if (visited.Contains(edge.Source))
                    {
                        continue;
                    }

                    visited.Add(edge.Source);

                    if (!graph.Nodes.ContainsKey(edge.Source))
                    {
                        var (file, method) = ParseNodeId(edge.Source);
                        if (file != null)
                        {
                            await ParseFileAsync(file, cancellationToken);

                            if (graph.Nodes.ContainsKey(edge.Source))
                            {
                                queue.Enqueue((graph.Nodes[edge.Source], depth + 1));
                            }
                        }
                    }
                    else
                    {
                        queue.Enqueue((graph.Nodes[edge.Source], depth + 1));
                    }
                }
            }
        }

        /// <summary>
        /// Builds L2 cross-file relationships: inheritance, interface implementation, field references.
        /// </summary>
        private async Task BuildCrossFileRelationshipsAsync(CodeGraph graph, CancellationToken cancellationToken)
        {
            // Get all C# files in source tree (limit to 500 files)
            var csFiles = Directory.EnumerateFiles(_sourceRoot, "*.cs", SearchOption.AllDirectories)
                .Where(f => !f.Contains("\\bin\\") && !f.Contains("\\obj\\") &&
                            !f.Contains("\\packages\\") && !f.Contains("\\node_modules\\"))
                .Take(500)
                .ToList();

            Console.WriteLine($"[EDOG] Scanning {csFiles.Count} files for L2 relationships");

            // Parse all files in parallel
            var semaphore = new SemaphoreSlim(4);
            var tasks = csFiles.Select(async file =>
            {
                await semaphore.WaitAsync(cancellationToken);
                try
                {
                    var relativePath = Path.GetRelativePath(_sourceRoot, file).Replace('\\', '/');
                    return await ParseFileAsync(relativePath, cancellationToken);
                }
                finally
                {
                    semaphore.Release();
                }
            });

            var parsedFiles = (await Task.WhenAll(tasks)).Where(p => p != null).ToList();

            // Build cross-file edges
            foreach (var parsed in parsedFiles)
            {
                // Inheritance edges
                foreach (var (className, bases) in parsed.Inheritance)
                {
                    var sourceId = $"{parsed.FilePath}:{className}";

                    foreach (var baseType in bases)
                    {
                        // Try to find the base type in other files
                        var targetFile = parsedFiles.FirstOrDefault(pf =>
                            pf.Symbols.Any(s => s.Name == baseType));

                        if (targetFile != null)
                        {
                            var targetId = $"{targetFile.FilePath}:{baseType}";
                            var edgeType = baseType.StartsWith("I") ? "interface_dispatch" : "inheritance";

                            graph.AddEdge(new GraphEdge
                            {
                                Source = sourceId,
                                Target = targetId,
                                EdgeType = edgeType,
                                Weight = 2.0 // Higher weight for structural relationships
                            });

                            // Ensure nodes exist
                            if (!graph.Nodes.ContainsKey(sourceId))
                            {
                                graph.AddNode(new GraphNode
                                {
                                    Id = sourceId,
                                    File = parsed.FilePath,
                                    Method = className,
                                    NodeType = "class"
                                });
                            }

                            if (!graph.Nodes.ContainsKey(targetId))
                            {
                                graph.AddNode(new GraphNode
                                {
                                    Id = targetId,
                                    File = targetFile.FilePath,
                                    Method = baseType,
                                    NodeType = baseType.StartsWith("I") ? "interface" : "class"
                                });
                            }
                        }
                    }
                }

                // Field reference edges
                var containingClass = parsed.Symbols.FirstOrDefault(s => s.Type == "class")?.Name;
                if (containingClass != null)
                {
                    var sourceId = $"{parsed.FilePath}:{containingClass}";

                    foreach (var fieldType in parsed.FieldRefs)
                    {
                        var targetFile = parsedFiles.FirstOrDefault(pf =>
                            pf.Symbols.Any(s => s.Name == fieldType));

                        if (targetFile != null)
                        {
                            var targetId = $"{targetFile.FilePath}:{fieldType}";

                            graph.AddEdge(new GraphEdge
                            {
                                Source = sourceId,
                                Target = targetId,
                                EdgeType = "field_reference",
                                Weight = 1.5
                            });

                            if (!graph.Nodes.ContainsKey(targetId))
                            {
                                graph.AddNode(new GraphNode
                                {
                                    Id = targetId,
                                    File = targetFile.FilePath,
                                    Method = fieldType,
                                    NodeType = fieldType.StartsWith("I") ? "interface" : "class"
                                });
                            }
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Assigns community labels based on namespace and file structure.
        /// </summary>
        private void AssignCommunities(CodeGraph graph)
        {
            var communityMap = new Dictionary<string, string>();

            foreach (var node in graph.Nodes.Values)
            {
                // Get namespace from parsed file
                if (_fileCache.TryGetValue(node.File, out var parsed) && !string.IsNullOrEmpty(parsed.Namespace))
                {
                    // Use last part of namespace as community
                    var parts = parsed.Namespace.Split('.');
                    var community = parts.Length > 0 ? parts[^1] : "default";
                    node.Community = community;
                    communityMap[node.Id] = community;
                }
                else
                {
                    // Fallback: use file directory
                    var dir = Path.GetDirectoryName(node.File) ?? "root";
                    var community = dir.Replace("\\", "/").Split('/').LastOrDefault() ?? "default";
                    node.Community = community;
                    communityMap[node.Id] = community;
                }
            }

            graph.Communities = communityMap;
        }

        /// <summary>
        /// Parses node ID into (file, method) tuple.
        /// </summary>
        private (string file, string method) ParseNodeId(string nodeId)
        {
            var parts = nodeId.Split(':');
            if (parts.Length == 2)
            {
                return (parts[0], parts[1]);
            }

            return (null, null);
        }

        /// <summary>
        /// Represents a parsed C# file with symbols and relationships.
        /// </summary>
        private sealed class ParsedFile
        {
            public string FilePath { get; set; }
            public string Namespace { get; set; }
            public List<SymbolInfo> Symbols { get; set; } = new();
            public Dictionary<string, List<string>> Inheritance { get; set; } = new();
            public List<string> FieldRefs { get; set; } = new();
        }

        /// <summary>
        /// Represents a symbol (class, method, interface) extracted from source.
        /// </summary>
        private sealed class SymbolInfo
        {
            public string Name { get; set; }
            public string Type { get; set; } // "class", "method", "interface"
            public List<string> Calls { get; set; } = new();
        }
    }
}
