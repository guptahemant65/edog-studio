// <copyright file="EdogQaInvariantExtractor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Globalization;
    using System.Linq;
    using System.Security.Cryptography;
    using System.Text;
    using System.Text.RegularExpressions;

    /// <summary>
    /// Extracts <see cref="CodeInvariant"/>s from a unified PR diff (F27
    /// QA Testing "pinnacle" quality, item 2).
    ///
    /// <para>Why: the LLM scenario generator was historically given only
    /// diff text + impact graph + DI registrations. It had to <em>infer</em>
    /// numeric constants, temporal thresholds, comparison predicates, and
    /// error contracts from raw diff text every time — which is exactly
    /// where it under-tested. By pre-extracting these as structured
    /// invariants, the prompt can name them explicitly and the linter
    /// (item 5) can verify the generated scenarios cover each of them.</para>
    ///
    /// <para>Design: deliberately regex-based rather than Roslyn-based —
    /// DevMode/ does not take a Roslyn dependency (OmniSharp is the only
    /// semantic layer here, and it works on the whole solution, not on
    /// diff hunks). Regex on added-lines is enough for the
    /// well-bounded patterns we care about:</para>
    /// <list type="bullet">
    ///   <item><c>numeric_constant</c> — added/changed <c>const int Foo = N</c>.</item>
    ///   <item><c>comparison_predicate</c> — added/changed inequality / equality
    ///     expression referencing a numeric constant or a value/MS literal.</item>
    ///   <item><c>temporal_threshold</c> — <c>TimeSpan.FromX(N)</c>,
    ///     <c>DateTimeOffset.UtcNow.AddX(N)</c>, <c>DateTime.UtcNow.AddX(N)</c>.</item>
    ///   <item><c>explicit_error</c> — <c>throw new {Type}Exception(message)</c>.</item>
    ///   <item><c>added_parameter</c> / <c>removed_parameter</c> — detected on
    ///     method-signature lines via line-pair comparison.</item>
    /// </list>
    ///
    /// <para>All entry points are <see langword="static"/> and pure. The
    /// extractor never throws — malformed input yields an empty list with
    /// the failure recorded in <paramref name="warnings"/>.</para>
    /// </summary>
    public static class EdogQaInvariantExtractor
    {
        // Cap the output so a pathological diff cannot blow the prompt budget.
        private const int MaxInvariants = 60;
        private const int MaxLineLength = 400;

        // ──────────────────────────────────────────────────────────
        // Regex patterns. All anchored to the start of a content line
        // after the diff prefix has been stripped by the caller.
        // ──────────────────────────────────────────────────────────

        /// <summary>
        /// Matches a C# const numeric declaration:
        /// <c>{access?} const {numeric-type} {Name} = {value};</c>
        /// where numeric-type ∈ {int, long, double, float, decimal, short, byte}.
        /// </summary>
        private static readonly Regex NumericConstRe = new(
            @"\b(?:public|private|internal|protected|static|readonly|\s)*?\bconst\s+" +
            @"(?<type>int|long|double|float|decimal|short|byte|uint|ulong|ushort|sbyte)\s+" +
            @"(?<name>[A-Za-z_]\w*)\s*=\s*(?<value>-?\d+(?:\.\d+)?(?:[fFmMdDlL])?)",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>
        /// Matches <c>TimeSpan.From{Days|Hours|Minutes|Seconds|Milliseconds|Ticks}(N)</c>
        /// where N is either a numeric literal or a single identifier.
        /// </summary>
        private static readonly Regex TimeSpanFromRe = new(
            @"\bTimeSpan\.From(?<unit>Days|Hours|Minutes|Seconds|Milliseconds|Ticks)\(\s*" +
            @"(?<arg>-?\d+(?:\.\d+)?|[A-Za-z_]\w*)\s*\)",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>
        /// Matches <c>{DateTime|DateTimeOffset}.UtcNow.Add{Days|Hours|Minutes|Seconds}(N)</c>.
        /// Used to detect default-window thresholds (e.g. "now - 7d").
        /// </summary>
        private static readonly Regex DateTimeAddRe = new(
            @"\b(?:DateTime|DateTimeOffset)\.UtcNow\.Add(?<unit>Days|Hours|Minutes|Seconds)\(\s*" +
            @"(?<arg>-?\d+(?:\.\d+)?|[A-Za-z_]\w*)\s*\)",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>
        /// Matches <c>throw new {Type}Exception("...")</c> or
        /// <c>throw new {Type}Exception($"...{}...")</c>. The exception
        /// type and message text are captured.
        /// </summary>
        private static readonly Regex ThrowRe = new(
            @"\bthrow\s+new\s+(?<exType>[A-Za-z_][\w\.]*Exception)\s*\(\s*" +
            @"(?:\$?""(?<message>[^""\\]*(?:\\.[^""\\]*)*)"")?",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>
        /// Matches an inequality / equality predicate involving a constant
        /// or a token that looks like an upper-bound symbol (PascalCase ending
        /// in "Days|Hours|Limit|Max|Min|Count|Size|Length"). We intentionally
        /// stay conservative to avoid false positives — boilerplate
        /// <c>if (x == null)</c> is NOT captured. Generic-type usages like
        /// <c>Task&lt;int&gt;</c> are filtered out by requiring the rhs to be
        /// either a numeric literal or a capitalized symbol that ends in one
        /// of the recognized magnitude suffixes.
        /// </summary>
        private static readonly Regex ComparisonRe = new(
            @"(?<lhs>[A-Za-z_][\w\.\(\)\[\]]*)\s*(?<op><=|>=|==|!=|<|>)\s*" +
            @"(?<rhs>-?\d+(?:\.\d+)?|[A-Z][A-Za-z0-9_]*(?:Days|Hours|Minutes|Seconds|Limit|Max|Min|Count|Size|Length))\b",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>
        /// Matches a method signature like
        /// <c>public async Task&lt;X&gt; Foo(...)</c>.
        /// Captures method name only; used to align added/removed lines
        /// when detecting parameter-list changes.
        /// </summary>
        private static readonly Regex MethodSignatureRe = new(
            @"\b(?:public|protected|internal|private)\s+(?:static\s+|virtual\s+|override\s+|async\s+)*" +
            @"(?:[\w<>?,\.\s]+?)\s+(?<name>[A-Za-z_]\w*)\s*\(",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>
        /// Matches a parameter declaration inside a method's parameter list:
        /// optional attributes (e.g. <c>[FromQuery]</c>, <c>[Required]</c>),
        /// type, name, optional default value.
        /// </summary>
        private static readonly Regex ParamRe = new(
            @"(?:\[[^\]]+\]\s*)*" +
            @"(?<type>[A-Za-z_][\w<>?,\.\s]*?)\s+(?<name>[A-Za-z_]\w*)\s*(?:=\s*[^,)]+)?",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        // ──────────────────────────────────────────────────────────
        // Public API
        // ──────────────────────────────────────────────────────────

        /// <summary>
        /// Extract invariants from a unified diff. Returns an empty list
        /// (with a warning) if the input is null/empty or any regex throws.
        /// Capped at <see cref="MaxInvariants"/> entries; oldest-wins truncation
        /// is intentional — invariants near the top of a diff are usually the
        /// most signal-rich (smaller setup code, more meaningful additions).
        /// </summary>
        /// <param name="unifiedDiff">The raw unified diff text.</param>
        /// <param name="warnings">Out-parameter for failure annotations.</param>
        /// <returns>List of extracted invariants.</returns>
        public static List<CodeInvariant> Extract(string unifiedDiff, out List<string> warnings)
        {
            warnings = new List<string>();
            var invariants = new List<CodeInvariant>();
            if (string.IsNullOrEmpty(unifiedDiff))
            {
                warnings.Add("invariant_extractor: empty_diff");
                return invariants;
            }

            try
            {
                var hunks = ParseHunks(unifiedDiff);
                foreach (var hunk in hunks)
                {
                    ExtractFromHunk(hunk, invariants);
                    if (invariants.Count >= MaxInvariants) break;
                }

                // Deduplicate by (Kind, Symbol, Value, File, Line) and assign IDs.
                invariants = invariants
                    .GroupBy(i => $"{i.Kind}|{i.Symbol}|{i.Value}|{i.File}|{i.Line}")
                    .Select(g => g.First())
                    .Take(MaxInvariants)
                    .ToList();
                foreach (var inv in invariants)
                {
                    if (string.IsNullOrEmpty(inv.Id))
                    {
                        inv.Id = $"inv-{inv.Kind}-{ShortHash($"{inv.Kind}|{inv.Symbol}|{inv.Value}|{inv.File}|{inv.Line}")}";
                    }
                }
            }
            catch (Exception ex)
            {
                warnings.Add($"invariant_extractor_failed: {ex.GetType().Name}: {ex.Message}");
            }

            return invariants;
        }

        /// <summary>
        /// Render invariants as a markdown block suitable for inclusion in the
        /// LLM user message. Empty input yields an empty string so the prompt
        /// stays clean when extraction returned nothing.
        /// </summary>
        public static string RenderForPrompt(IReadOnlyList<CodeInvariant> invariants)
        {
            if (invariants == null || invariants.Count == 0) return string.Empty;

            var sb = new StringBuilder();
            sb.AppendLine("# Code Invariants Detected in Diff");
            sb.AppendLine();
            sb.AppendLine(
                "These structural facts were extracted from the diff. The scenario " +
                "set MUST cover each one with an appropriate technique (boundary " +
                "triplet for numeric/temporal thresholds, counterfactual for " +
                "removed/added parameters, error-path for explicit_error, " +
                "equivalence partitioning for comparison_predicate).");
            sb.AppendLine();

            foreach (var inv in invariants)
            {
                var loc = !string.IsNullOrEmpty(inv.File)
                    ? $"{inv.File}:{inv.Line}"
                    : "(location unknown)";
                switch (inv.Kind)
                {
                    case "numeric_constant":
                        sb.AppendLine($"- [{inv.Id}] **numeric_constant** `{inv.Symbol} = {inv.Value}` @ {loc}");
                        break;
                    case "temporal_threshold":
                        sb.AppendLine($"- [{inv.Id}] **temporal_threshold** `{inv.Predicate}` @ {loc}");
                        break;
                    case "comparison_predicate":
                        sb.AppendLine($"- [{inv.Id}] **comparison_predicate** `{inv.Predicate}` @ {loc}");
                        break;
                    case "explicit_error":
                        sb.AppendLine($"- [{inv.Id}] **explicit_error** `{inv.Symbol}` → \"{inv.Predicate}\" @ {loc}");
                        break;
                    case "added_parameter":
                        sb.AppendLine($"- [{inv.Id}] **added_parameter** `{inv.Symbol}` on `{inv.Predicate}` @ {loc}");
                        break;
                    case "removed_parameter":
                        sb.AppendLine($"- [{inv.Id}] **removed_parameter** `{inv.Symbol}` on `{inv.Predicate}` @ {loc}");
                        break;
                    default:
                        sb.AppendLine($"- [{inv.Id}] **{inv.Kind}** `{inv.Symbol ?? inv.Predicate}` @ {loc}");
                        break;
                }
            }
            sb.AppendLine();
            return sb.ToString();
        }

        // ──────────────────────────────────────────────────────────
        // Hunk parsing
        // ──────────────────────────────────────────────────────────

        /// <summary>A parsed diff hunk for a single file region.</summary>
        private sealed class Hunk
        {
            public string File { get; set; }
            public int NewStart { get; set; }
            public List<HunkLine> Lines { get; } = new();
        }

        private readonly struct HunkLine
        {
            public HunkLine(char marker, string text, int newLineNumber)
            {
                Marker = marker;
                Text = text;
                NewLineNumber = newLineNumber;
            }
            public char Marker { get; }      // '+', '-', or ' '
            public string Text { get; }
            public int NewLineNumber { get; }
        }

        /// <summary>
        /// Parse a unified diff into hunks. Handles:
        ///   - File headers <c>--- a/...</c> and <c>+++ b/...</c>
        ///   - Hunk headers <c>@@ -A,B +C,D @@ ...</c>
        ///   - Context, addition, and deletion lines
        /// Skips binary-file markers and unparseable headers silently.
        /// </summary>
        private static List<Hunk> ParseHunks(string unifiedDiff)
        {
            var hunks = new List<Hunk>();
            string currentFile = null;
            Hunk currentHunk = null;
            int newLineNumber = 0;

            foreach (var rawLine in unifiedDiff.Split('\n'))
            {
                var line = rawLine.TrimEnd('\r');
                if (line.Length > MaxLineLength)
                {
                    // Truncate pathologically long lines (minified files, base64 blobs).
                    line = line.Substring(0, MaxLineLength);
                }

                if (line.StartsWith("+++ b/") || line.StartsWith("+++ B/"))
                {
                    currentFile = line.Substring(6);
                    currentHunk = null;
                }
                else if (line.StartsWith("+++ /dev/null"))
                {
                    currentFile = null;
                    currentHunk = null;
                }
                else if (line.StartsWith("--- "))
                {
                    // a/ header — discard; the +++ header is authoritative.
                    currentHunk = null;
                }
                else if (line.StartsWith("@@"))
                {
                    var m = Regex.Match(line, @"@@ -\d+(?:,\d+)? \+(?<newStart>\d+)(?:,\d+)? @@");
                    if (m.Success && currentFile != null)
                    {
                        var newStart = int.Parse(m.Groups["newStart"].Value, CultureInfo.InvariantCulture);
                        currentHunk = new Hunk { File = currentFile, NewStart = newStart };
                        hunks.Add(currentHunk);
                        newLineNumber = newStart - 1;
                    }
                    else
                    {
                        currentHunk = null;
                    }
                }
                else if (currentHunk != null && line.Length > 0)
                {
                    var marker = line[0];
                    if (marker != '+' && marker != '-' && marker != ' ')
                    {
                        // "\ No newline at end of file" and similar — skip.
                        continue;
                    }
                    var text = line.Substring(1);
                    if (marker != '-')
                    {
                        newLineNumber++;
                    }
                    currentHunk.Lines.Add(new HunkLine(marker, text, marker == '-' ? 0 : newLineNumber));
                }
            }

            return hunks;
        }

        // ──────────────────────────────────────────────────────────
        // Per-pattern extraction
        // ──────────────────────────────────────────────────────────

        private static void ExtractFromHunk(Hunk hunk, List<CodeInvariant> output)
        {
            for (int i = 0; i < hunk.Lines.Count; i++)
            {
                if (output.Count >= MaxInvariants) return;
                var hl = hunk.Lines[i];
                if (hl.Marker != '+') continue;
                var text = hl.Text;
                if (string.IsNullOrWhiteSpace(text)) continue;

                ScanLineForInvariants(text, hunk.File, hl.NewLineNumber, output);
            }

            // Parameter add/remove: pair up adjacent '-'/'+' lines that look
            // like method signatures with the same name. Conservative — only
            // matches when both lines have a recognizable signature for the
            // same method name.
            ScanParameterChanges(hunk, output);
        }

        private static void ScanLineForInvariants(
            string text, string file, int line, List<CodeInvariant> output)
        {
            // numeric_constant
            var mNum = NumericConstRe.Match(text);
            if (mNum.Success)
            {
                output.Add(new CodeInvariant
                {
                    Kind = "numeric_constant",
                    Symbol = mNum.Groups["name"].Value,
                    Value = mNum.Groups["value"].Value,
                    Predicate = $"{mNum.Groups["type"].Value} {mNum.Groups["name"].Value} = {mNum.Groups["value"].Value}",
                    File = file,
                    Line = line,
                });
            }

            // temporal_threshold via TimeSpan.From*
            foreach (Match m in TimeSpanFromRe.Matches(text))
            {
                output.Add(new CodeInvariant
                {
                    Kind = "temporal_threshold",
                    Symbol = $"TimeSpan.From{m.Groups["unit"].Value}",
                    Value = m.Groups["arg"].Value,
                    Predicate = m.Value,
                    File = file,
                    Line = line,
                });
            }

            // temporal_threshold via DateTime{Offset}.UtcNow.Add*
            foreach (Match m in DateTimeAddRe.Matches(text))
            {
                output.Add(new CodeInvariant
                {
                    Kind = "temporal_threshold",
                    Symbol = $"UtcNow.Add{m.Groups["unit"].Value}",
                    Value = m.Groups["arg"].Value,
                    Predicate = m.Value,
                    File = file,
                    Line = line,
                });
            }

            // explicit_error via throw new {Type}Exception(message?)
            var mThrow = ThrowRe.Match(text);
            if (mThrow.Success)
            {
                output.Add(new CodeInvariant
                {
                    Kind = "explicit_error",
                    Symbol = mThrow.Groups["exType"].Value,
                    Predicate = mThrow.Groups["message"].Success ? mThrow.Groups["message"].Value : string.Empty,
                    File = file,
                    Line = line,
                });
            }

            // comparison_predicate — only emit when not already part of an
            // explicit_error or null-check (heuristic: predicate must contain
            // a digit or an ALL-CAPS-ISH identifier on at least one side).
            foreach (Match m in ComparisonRe.Matches(text))
            {
                var rhs = m.Groups["rhs"].Value;
                var lhs = m.Groups["lhs"].Value;
                if (lhs.Equals("null", StringComparison.OrdinalIgnoreCase)
                    || rhs.Equals("null", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                output.Add(new CodeInvariant
                {
                    Kind = "comparison_predicate",
                    Symbol = $"{lhs}_{m.Groups["op"].Value}_{rhs}",
                    Predicate = $"{lhs} {m.Groups["op"].Value} {rhs}",
                    File = file,
                    Line = line,
                });
            }
        }

        /// <summary>
        /// Detect parameter-list changes by pairing adjacent '-' and '+'
        /// method-signature lines with the same method name. Returns
        /// <c>added_parameter</c> / <c>removed_parameter</c> entries.
        /// </summary>
        private static void ScanParameterChanges(Hunk hunk, List<CodeInvariant> output)
        {
            // Collect signatures per marker.
            var minus = new Dictionary<string, (int line, string paramList)>(StringComparer.Ordinal);
            var plus = new Dictionary<string, (int line, string paramList)>(StringComparer.Ordinal);

            foreach (var hl in hunk.Lines)
            {
                if (output.Count >= MaxInvariants) return;
                var m = MethodSignatureRe.Match(hl.Text);
                if (!m.Success) continue;
                var name = m.Groups["name"].Value;
                var paramList = ExtractParamList(hl.Text);
                if (paramList == null) continue;
                if (hl.Marker == '-' && !minus.ContainsKey(name))
                {
                    minus[name] = (hl.NewLineNumber, paramList);
                }
                else if (hl.Marker == '+' && !plus.ContainsKey(name))
                {
                    plus[name] = (hl.NewLineNumber, paramList);
                }
            }

            foreach (var kv in plus)
            {
                if (!minus.TryGetValue(kv.Key, out var minusEntry)) continue;
                var added = ParamSet(kv.Value.paramList);
                var removed = ParamSet(minusEntry.paramList);

                foreach (var p in added)
                {
                    if (removed.Contains(p)) continue;
                    output.Add(new CodeInvariant
                    {
                        Kind = "added_parameter",
                        Symbol = p,
                        Predicate = kv.Key,
                        File = hunk.File,
                        Line = kv.Value.line,
                    });
                    if (output.Count >= MaxInvariants) return;
                }
                foreach (var p in removed)
                {
                    if (added.Contains(p)) continue;
                    output.Add(new CodeInvariant
                    {
                        Kind = "removed_parameter",
                        Symbol = p,
                        Predicate = kv.Key,
                        File = hunk.File,
                        Line = kv.Value.line,
                    });
                    if (output.Count >= MaxInvariants) return;
                }
            }
        }

        /// <summary>
        /// Extract the parameter list substring from a method signature line —
        /// the slice between the matching parentheses after the method name.
        /// Returns null when the parentheses cannot be balanced (e.g. the
        /// signature continues on the next line).
        /// </summary>
        private static string ExtractParamList(string signatureLine)
        {
            int open = signatureLine.IndexOf('(');
            if (open < 0) return null;
            int depth = 0;
            for (int i = open; i < signatureLine.Length; i++)
            {
                var c = signatureLine[i];
                if (c == '(') depth++;
                else if (c == ')')
                {
                    depth--;
                    if (depth == 0)
                    {
                        return signatureLine.Substring(open + 1, i - open - 1);
                    }
                }
            }
            return null;
        }

        /// <summary>
        /// Convert a parameter list into a set of parameter <em>names</em>.
        /// Conservative: a name that includes an attribute/type prefix is
        /// stripped to bare-name only.
        /// </summary>
        private static HashSet<string> ParamSet(string paramList)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            if (string.IsNullOrWhiteSpace(paramList)) return result;
            foreach (var raw in SplitParameters(paramList))
            {
                var m = ParamRe.Match(raw.Trim());
                if (m.Success)
                {
                    result.Add(m.Groups["name"].Value);
                }
            }
            return result;
        }

        /// <summary>
        /// Split a parameter list on commas while respecting nested generics
        /// (<c>Dictionary&lt;string, int&gt;</c>) and attribute brackets
        /// (<c>[FromQuery(Name="x")]</c>).
        /// </summary>
        private static IEnumerable<string> SplitParameters(string paramList)
        {
            int start = 0;
            int angleDepth = 0;
            int bracketDepth = 0;
            int parenDepth = 0;
            for (int i = 0; i < paramList.Length; i++)
            {
                var c = paramList[i];
                if (c == '<') angleDepth++;
                else if (c == '>') angleDepth = Math.Max(0, angleDepth - 1);
                else if (c == '[') bracketDepth++;
                else if (c == ']') bracketDepth = Math.Max(0, bracketDepth - 1);
                else if (c == '(') parenDepth++;
                else if (c == ')') parenDepth = Math.Max(0, parenDepth - 1);
                else if (c == ',' && angleDepth == 0 && bracketDepth == 0 && parenDepth == 0)
                {
                    yield return paramList.Substring(start, i - start);
                    start = i + 1;
                }
            }
            if (start < paramList.Length)
            {
                yield return paramList.Substring(start);
            }
        }

        /// <summary>
        /// Stable short hash for invariant IDs. SHA-256 truncated to 6 hex chars —
        /// not for security, just for uniqueness within a single PR's invariant set.
        /// </summary>
        private static string ShortHash(string s)
        {
            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(s ?? string.Empty));
            var sb = new StringBuilder(6);
            for (int i = 0; i < 3; i++) sb.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
            return sb.ToString();
        }
    }
}
