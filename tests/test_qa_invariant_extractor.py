"""Shape tests for the F27 QA invariant extractor
(`EdogQaInvariantExtractor.cs`).

The C# extractor is deployed into FLT via DEVMODE_FILES, not built
in this repo, so we cannot execute it from Python. Instead these tests
pin the public API surface and the regex pattern set against accidental
removal — the patterns are what produce the invariants the prompt
exemplars (item 4) and the linter (item 5) depend on.

They also pin a small behavioral contract — the dispatcher in
`RenderForPrompt` must have a markdown bullet for every invariant kind
listed in the CodeInvariant XML doc so a new kind cannot ship without
its rendering.
"""

import re
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
EXTRACTOR = PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaInvariantExtractor.cs"
ANALYZER = PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaCodeAnalyzer.cs"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# ──────────────────────────────────────────────────────────────────
# Public API surface
# ──────────────────────────────────────────────────────────────────


def test_extractor_file_exists():
    assert EXTRACTOR.is_file(), f"extractor missing: {EXTRACTOR}"


def test_extractor_is_static_class():
    """Pure utility class with static surface only — keeps it safe to
    call from any pipeline stage without lifetime concerns."""
    src = _read(EXTRACTOR)
    assert "public static class EdogQaInvariantExtractor" in src


def test_extract_method_signature_stable():
    """The Extract(string, out List<string>) signature is the contract the
    analyzer depends on. Changes here mean the analyzer needs an update."""
    src = _read(EXTRACTOR)
    pattern = (
        r"public\s+static\s+List<CodeInvariant>\s+Extract\(\s*"
        r"string\s+\w+,\s*out\s+List<string>\s+\w+\s*\)"
    )
    assert re.search(pattern, src), "Extract(string, out List<string>) signature missing"


def test_render_for_prompt_method_present():
    """The render helper is the single source of truth for invariant
    markdown shape — the LLM provider must use it rather than rolling
    its own format string."""
    src = _read(EXTRACTOR)
    assert "public static string RenderForPrompt(" in src


# ──────────────────────────────────────────────────────────────────
# Regex pattern set — these must all be present
# ──────────────────────────────────────────────────────────────────


def test_numeric_const_regex_present():
    """Detects `const int Foo = 60`. Used for boundary triplets."""
    src = _read(EXTRACTOR)
    assert "NumericConstRe" in src
    # Confirm the numeric types covered match the C# numeric primitives
    # we expect to see in FLT controllers (int, long, double, decimal).
    for ty in ("int", "long", "double", "decimal"):
        assert ty in src.split("NumericConstRe", 1)[1].split("RegexOptions")[0]


def test_timespan_from_regex_present():
    """Detects `TimeSpan.FromDays(N)` etc. — anchors temporal_threshold."""
    src = _read(EXTRACTOR)
    assert "TimeSpanFromRe" in src
    body = src.split("TimeSpanFromRe", 1)[1].split("RegexOptions")[0]
    for unit in ("Days", "Hours", "Minutes", "Seconds", "Milliseconds"):
        assert unit in body, f"TimeSpan.From{unit} missing from regex"


def test_datetime_add_regex_present():
    """Detects `UtcNow.AddDays(N)` — default-window thresholds."""
    src = _read(EXTRACTOR)
    assert "DateTimeAddRe" in src


def test_throw_regex_present():
    src = _read(EXTRACTOR)
    assert "ThrowRe" in src


def test_comparison_regex_present_and_excludes_null():
    """ComparisonRe must NOT capture `x == null` style boilerplate —
    that produces low-signal boundary scenarios."""
    src = _read(EXTRACTOR)
    assert "ComparisonRe" in src
    # The scanner has an explicit null filter; pin the guard.
    assert 'lhs.Equals("null"' in src or 'rhs.Equals("null"' in src


def test_method_signature_regex_present():
    """Needed to pair `-` and `+` method-signature lines for
    added_parameter / removed_parameter detection."""
    src = _read(EXTRACTOR)
    assert "MethodSignatureRe" in src


def test_param_regex_present_and_handles_attributes():
    """Parameters often have `[FromQuery]` or `[Required]` attributes;
    the regex must strip them off."""
    src = _read(EXTRACTOR)
    assert "ParamRe" in src
    # The leading attribute-stripping group.
    assert r"\[[^\]]+\]" in src


# ──────────────────────────────────────────────────────────────────
# Invariant kinds vs render dispatch
# ──────────────────────────────────────────────────────────────────


EXPECTED_KINDS = (
    "numeric_constant",
    "comparison_predicate",
    "temporal_threshold",
    "explicit_error",
    "added_parameter",
    "removed_parameter",
)


def test_extractor_emits_every_documented_kind():
    """Every kind named in the CodeInvariant XML doc must actually be
    produced somewhere in the extractor (via Kind = "..." assignment)."""
    src = _read(EXTRACTOR)
    for kind in EXPECTED_KINDS:
        assert f'Kind = "{kind}"' in src, f"extractor never emits kind={kind}"


def test_render_for_prompt_dispatches_every_kind():
    """RenderForPrompt's case dispatch must cover every kind. A missing
    case falls through to a generic bullet, which is acceptable but
    suppresses the rich symbol/value formatting — this guard makes the
    omission visible at PR review time."""
    src = _read(EXTRACTOR)
    render_block = src.split("RenderForPrompt", 1)[1].split("// ──────────", 1)[0]
    for kind in EXPECTED_KINDS:
        assert f'case "{kind}"' in render_block, f"render dispatch missing for: {kind}"


# ──────────────────────────────────────────────────────────────────
# Safety properties
# ──────────────────────────────────────────────────────────────────


def test_extractor_caps_output_size():
    """Pathological diffs cannot blow the prompt budget."""
    src = _read(EXTRACTOR)
    assert "MaxInvariants" in src
    # Confirm a sane upper bound (60 is the documented cap; allow re-tune
    # but reject values that would make the prompt unbounded).
    m = re.search(r"private\s+const\s+int\s+MaxInvariants\s*=\s*(\d+)", src)
    assert m is not None, "MaxInvariants constant not declared"
    cap = int(m.group(1))
    assert 10 <= cap <= 200, f"MaxInvariants={cap} out of sane range"


def test_extractor_caps_line_length():
    """Minified / base64 lines must be truncated before regex evaluation
    to avoid catastrophic backtracking."""
    src = _read(EXTRACTOR)
    assert "MaxLineLength" in src


def test_extractor_never_throws():
    """The Extract method must catch and surface as warnings — the
    pipeline cannot afford a regex exception failing the entire run."""
    src = _read(EXTRACTOR)
    body = src.split("public static List<CodeInvariant> Extract(", 1)[1]
    assert "catch (Exception" in body
    assert "invariant_extractor_failed" in body


# ──────────────────────────────────────────────────────────────────
# Analyzer integration
# ──────────────────────────────────────────────────────────────────


def test_analyzer_invokes_extractor_in_pipeline():
    """The analyzer must call the extractor inside AnalyzeInternalAsync,
    AND must store the result on prContext.Invariants so the prompt
    renderer can find it. Either half of this wiring breaks item 2
    silently — extraction succeeds, output is dropped on the floor."""
    src = _read(ANALYZER)
    assert "EdogQaInvariantExtractor.Extract(" in src
    assert "prContext.Invariants = invariants" in src


def test_analyzer_handles_null_prcontext():
    """The new AnalyzeAsync overload supports a null prContext for
    callers that have not built one yet (e.g., the 3-arg back-compat
    shim). The pipeline must lazily create one rather than NRE."""
    src = _read(ANALYZER)
    assert "prContext ??= new PrContext()" in src
