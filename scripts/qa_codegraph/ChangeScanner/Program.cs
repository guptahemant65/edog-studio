using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

// ChangeScanner — server-free Roslyn syntax pass.
//
// One pass over the changed files produces, for Beat 2:
//   1. GATES   — for each changed symbol's use site, the feature-flag guard(s)
//                that wrap it (walks up to the enclosing IsEnabled(FeatureNames.X)).
//   2. SIGNALS — the change's observable "footprint": which evidence streams it
//                touches (log, telemetry, spark, onelake/file, token, retry,
//                capacity, cache, catalog, dag), matched against an EXTENSIBLE
//                vocabulary file. This becomes Beat 5's watch-checklist; the
//                runtime interceptors are the judge.
//
// Usage:
//   ChangeScanner --files "a.cs;b.cs" --symbols "TypeA,MethodB" --vocab path.json
//   ChangeScanner --source-root <dir> --symbols "..." --vocab path.json
//
// Syntax-only: no MSBuild, no restore. Cross-file precision (callers, etc.) is a
// separate semantic engine.

string? filesArg = null, symbolsArg = null, sourceRoot = null, vocabPath = null;
for (int i = 0; i < args.Length - 1; i++)
{
    switch (args[i])
    {
        case "--files": filesArg = args[i + 1]; break;
        case "--symbols": symbolsArg = args[i + 1]; break;
        case "--source-root": sourceRoot = args[i + 1]; break;
        case "--vocab": vocabPath = args[i + 1]; break;
    }
}

var symbols = (symbolsArg ?? "")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
    .ToHashSet();

var files = new List<string>();
if (!string.IsNullOrEmpty(filesArg))
    files.AddRange(filesArg.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
else if (!string.IsNullOrEmpty(sourceRoot) && Directory.Exists(sourceRoot))
    files.AddRange(Directory.EnumerateFiles(sourceRoot, "*.cs", SearchOption.AllDirectories));

var vocab = LoadVocab(vocabPath);

var sites = new List<object>();
var signalHits = new Dictionary<string, (string Watch, List<object> Hits, HashSet<string> Seen)>();
int scanned = 0;

void AddHit(string stream, string watch, string kind, string evidence, string file, int line, string? message = null)
{
    if (!signalHits.TryGetValue(stream, out var entry))
    {
        entry = (watch, new List<object>(), new HashSet<string>());
        signalHits[stream] = entry;
    }
    var dedup = $"{kind}|{evidence}|{Path.GetFileName(file)}|{line}";
    if (entry.Seen.Add(dedup) && entry.Hits.Count < 15)
        entry.Hits.Add(message is null
            ? new { kind, evidence, file = Path.GetFileName(file), line }
            : new { kind, evidence, file = Path.GetFileName(file), line, message });
}

foreach (var file in files)
{
    if (!File.Exists(file)) continue;
    scanned++;
    string text;
    SyntaxNode root;
    try
    {
        text = File.ReadAllText(file);
        root = CSharpSyntaxTree.ParseText(text).GetRoot();
    }
    catch { continue; }

    // ── gates: changed-symbol use sites + their feature-flag guards ─────────
    foreach (var c in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
    {
        var tn = TypeName(c.Type);
        if (tn != null && symbols.Contains(tn)) sites.Add(Site(tn, "construction", file, c, root));
    }
    foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
    {
        var m = MethodName(inv.Expression);
        if (m != null && symbols.Contains(m)) sites.Add(Site(m, "call", file, inv, root));
    }

    // ── signals: usings (coarse), calls (precise), raw text ─────────────────
    foreach (var u in root.DescendantNodes().OfType<UsingDirectiveSyntax>())
    {
        var ns = u.Name?.ToString() ?? "";
        int line = u.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
        foreach (var (stream, v) in vocab)
            foreach (var pat in v.Usings)
                if (ns.Contains(pat)) AddHit(stream, v.Watch, "namespace", ns, file, line);
    }
    foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
    {
        var expr = inv.Expression.ToString();
        int line = inv.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
        foreach (var (stream, v) in vocab)
        {
            bool matched = false;
            foreach (var pat in v.Calls)
                if (expr.Contains(pat))
                {
                    string? msg = v.CaptureMessage ? FirstMessageArg(inv) : null;
                    AddHit(stream, v.Watch, "call", pat, file, line, msg);
                    matched = true;
                    break;
                }
            if (matched) break; // one stream per invocation is enough
        }
    }
    var lines = text.Split('\n');
    foreach (var (stream, v) in vocab)
        foreach (var pat in v.Text)
            for (int li = 0; li < lines.Length; li++)
                if (lines[li].Contains(pat)) { AddHit(stream, v.Watch, "text", pat, file, li + 1); break; }
}

var signals = signalHits
    .OrderBy(kv => kv.Key)
    .Select(kv => (object)new { stream = kv.Key, watch = kv.Value.Watch, hits = kv.Value.Hits })
    .ToList();

Console.WriteLine(JsonSerializer.Serialize(
    new { filesScanned = scanned, sites, signals },
    new JsonSerializerOptions { WriteIndented = true }));

return 0;

// ── vocab loading ───────────────────────────────────────────────────────────

static Dictionary<string, (string Watch, List<string> Calls, List<string> Usings, List<string> Text, bool CaptureMessage)>
    LoadVocab(string? path)
{
    var result = new Dictionary<string, (string, List<string>, List<string>, List<string>, bool)>();
    path ??= DefaultVocabPath();
    if (path is null || !File.Exists(path)) return result;
    try
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        if (!doc.RootElement.TryGetProperty("streams", out var streams)) return result;
        foreach (var s in streams.EnumerateObject())
        {
            var e = s.Value;
            string watch = e.TryGetProperty("watch", out var w) ? (w.GetString() ?? "") : "";
            bool cap = e.TryGetProperty("capture_message", out var cm) && cm.ValueKind == JsonValueKind.True;
            result[s.Name] = (watch, StrList(e, "calls"), StrList(e, "usings"), StrList(e, "text"), cap);
        }
    }
    catch { /* malformed vocab -> no signals, never crash */ }
    return result;
}

static List<string> StrList(JsonElement e, string prop)
{
    var list = new List<string>();
    if (e.TryGetProperty(prop, out var arr) && arr.ValueKind == JsonValueKind.Array)
        foreach (var item in arr.EnumerateArray())
            if (item.GetString() is { Length: > 0 } str) list.Add(str);
    return list;
}

static string? DefaultVocabPath()
{
    var dir = AppContext.BaseDirectory;
    for (int i = 0; i < 6 && dir != null; i++)
    {
        var cand = Path.Combine(dir, "signal_vocabulary.json");
        if (File.Exists(cand)) return cand;
        dir = Directory.GetParent(dir)?.FullName;
    }
    return null;
}

// ── syntax helpers ──────────────────────────────────────────────────────────

static string? TypeName(TypeSyntax t) => t switch
{
    IdentifierNameSyntax id => id.Identifier.Text,
    GenericNameSyntax gen => gen.Identifier.Text,
    QualifiedNameSyntax q => q.Right.Identifier.Text,
    _ => null,
};

static string? MethodName(ExpressionSyntax e) => e switch
{
    MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text,
    IdentifierNameSyntax id => id.Identifier.Text,
    _ => null,
};

static string? FirstMessageArg(InvocationExpressionSyntax inv)
{
    var first = inv.ArgumentList.Arguments.FirstOrDefault()?.Expression;
    string? raw = first switch
    {
        LiteralExpressionSyntax lit => lit.Token.ValueText,
        InterpolatedStringExpressionSyntax interp => interp.ToString(),
        _ => null,
    };
    if (raw is null) return null;
    return raw.Length > 120 ? raw[..120] + "\u2026" : raw;
}

static string? FlagFromInvocation(InvocationExpressionSyntax inv)
{
    if (MethodName(inv.Expression) != "IsEnabled") return null;
    var first = inv.ArgumentList.Arguments.FirstOrDefault()?.Expression;
    if (first is MemberAccessExpressionSyntax ma &&
        ma.Expression is IdentifierNameSyntax owner &&
        owner.Identifier.Text == "FeatureNames")
        return ma.Name.Identifier.Text;
    return null;
}

static string? FlagFromLocal(SyntaxNode root, string name)
{
    foreach (var d in root.DescendantNodes().OfType<VariableDeclaratorSyntax>())
    {
        if (d.Identifier.Text != name || d.Initializer is null) continue;
        foreach (var inv in d.Initializer.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>())
        {
            var f = FlagFromInvocation(inv);
            if (f != null) return f;
        }
    }
    return null;
}

static object Site(string symbol, string kind, string file, SyntaxNode node, SyntaxNode root)
{
    int line = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
    var gates = new List<object>();
    var seen = new HashSet<string>();
    foreach (var ifs in node.Ancestors().OfType<IfStatementSyntax>())
    {
        foreach (var inv in ifs.Condition.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>())
        {
            var f = FlagFromInvocation(inv);
            if (f != null && seen.Add(f)) gates.Add(new { flag = f, via = "inline guard" });
        }
        foreach (var id in ifs.Condition.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
        {
            var f = FlagFromLocal(root, id.Identifier.Text);
            if (f != null && seen.Add(f)) gates.Add(new { flag = f, via = $"local '{id.Identifier.Text}'" });
        }
    }
    return new { symbol, kind, file = Path.GetFileName(file), fullPath = file, line, gatedBy = gates };
}
