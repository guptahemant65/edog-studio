using System.Text.Json;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.MSBuild;

// PreciseEngine — the cross-file "what reaches this code" tool (semantic Roslyn).
//
// Loads ONE FLT project via MSBuild and answers, for a changed symbol:
//   - references: every place it's used (file:line + the enclosing method = the caller)
//   - entry-ish: the enclosing controller/hook method names (the door to trigger it)
// This is the PRECISE, cross-file half of Beat 2 (the fast syntax scanner does the
// same-file/flag/signal half). Warm-up is slow on a big project; the skill calls it
// lazily, only when it needs a cross-file fact.
//
// Usage: PreciseEngine --project <csproj> --symbol <name> [--max N]

string? proj = null, symbolName = null;
int max = 40;
for (int i = 0; i < args.Length - 1; i++)
{
    switch (args[i])
    {
        case "--project": proj = args[i + 1]; break;
        case "--symbol": symbolName = args[i + 1]; break;
        case "--max": int.TryParse(args[i + 1], out max); break;
    }
}
if (proj is null || symbolName is null)
{
    Console.Error.WriteLine("usage: PreciseEngine --project <csproj> --symbol <name> [--max N]");
    return 2;
}

if (!MSBuildLocator.IsRegistered)
    MSBuildLocator.RegisterDefaults();

var sw = System.Diagnostics.Stopwatch.StartNew();
using var ws = MSBuildWorkspace.Create();
var failures = new List<string>();
ws.WorkspaceFailed += (_, e) =>
{
    if (e.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure)
        failures.Add(e.Diagnostic.Message);
};

Project project;
Compilation? compilation;
try
{
    project = await ws.OpenProjectAsync(proj);
    compilation = await project.GetCompilationAsync();
}
catch (Exception ex)
{
    Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = ex.Message, failures }));
    return 1;
}
long loadMs = sw.ElapsedMilliseconds;
if (compilation is null)
{
    Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = "no compilation", loadMs, failures }));
    return 1;
}

var matches = new List<ISymbol>();
foreach (var t in AllTypes(compilation.GlobalNamespace))
{
    if (t.Name == symbolName) matches.Add(t);
    foreach (var m in t.GetMembers())
        if (m.Name == symbolName && m.Kind is SymbolKind.Method) matches.Add(m);
}

var results = new List<object>();
foreach (var sym in matches.Take(3))
{
    var refs = await SymbolFinder.FindReferencesAsync(sym, ws.CurrentSolution);
    var locs = new List<object>();
    var callers = new HashSet<string>();
    foreach (var r in refs)
        foreach (var loc in r.Locations)
        {
            if (locs.Count >= max) break;
            var span = loc.Location.GetLineSpan();
            var caller = EnclosingMethod(loc);
            if (caller is not null) callers.Add(caller);
            locs.Add(new { file = Path.GetFileName(span.Path), line = span.StartLinePosition.Line + 1, caller });
        }
    results.Add(new { symbol = sym.ToDisplayString(), kind = sym.Kind.ToString(), referenceCount = locs.Count, callers = callers.ToList(), references = locs });
}

Console.WriteLine(JsonSerializer.Serialize(
    new { ok = true, loadMs, projectLoadFailures = failures.Count, symbolsFound = matches.Count, results },
    new JsonSerializerOptions { WriteIndented = true }));
return 0;

static IEnumerable<INamedTypeSymbol> AllTypes(INamespaceSymbol ns)
{
    foreach (var t in ns.GetTypeMembers()) yield return t;
    foreach (var child in ns.GetNamespaceMembers())
        foreach (var t in AllTypes(child)) yield return t;
}

static string? EnclosingMethod(ReferenceLocation loc)
{
    var tree = loc.Location.SourceTree;
    if (tree is null) return null;
    var node = tree.GetRoot().FindNode(loc.Location.SourceSpan);
    var method = node.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault();
    if (method is not null) return method.Identifier.Text;
    var ctor = node.Ancestors().OfType<ConstructorDeclarationSyntax>().FirstOrDefault();
    return ctor?.Identifier.Text;
}
