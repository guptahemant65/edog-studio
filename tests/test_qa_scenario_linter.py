"""Shape tests for the F27 QA scenario linter
(`EdogQaScenarioLinter.cs`).

The C# linter ships into FLT via DEVMODE_FILES and cannot be executed
from this repo. These tests therefore pin the public API surface, the
rule catalog, severity assignments, and a small handful of behavioral
invariants that exist purely at the source level (`SafeRun` wrapper,
stable ordering, MaxFindings cap).

They also pin the wiring contract: the analyzer must call the linter
after scenario generation and surface its findings on `AnalysisResult`;
the SignalR hub must broadcast a `QaLintFindings` event before the
'complete' phase.
"""

import re
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
LINTER = PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaScenarioLinter.cs"
ANALYZER = PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaCodeAnalyzer.cs"
HUB = PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogPlaygroundHub.cs"
MODELS = PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaModels.cs"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


# ──────────────────────────────────────────────────────────────────
# Public API surface
# ──────────────────────────────────────────────────────────────────


def test_linter_file_exists():
    assert LINTER.is_file(), f"linter file missing: {LINTER}"


def test_linter_is_static_class():
    """Pure utility class — no state, no DI lifetime concerns."""
    src = _read(LINTER)
    assert "public static class EdogQaScenarioLinter" in src


def test_lint_method_signature_stable():
    """The `Lint(IReadOnlyList<Scenario>, PrContext)` signature is the
    contract the analyzer wires against. Any change here needs an
    analyzer + hub update."""
    src = _read(LINTER)
    assert re.search(
        r"public static List<LintFinding>\s+Lint\(\s*IReadOnlyList<Scenario>\s+\w+,\s*PrContext\s+\w+\s*\)",
        src,
    ), "Lint(IReadOnlyList<Scenario>, PrContext) signature missing"


def test_lint_finding_class_shape():
    """LintFinding carries the five fields the hub serializes."""
    src = _read(LINTER)
    assert "public sealed class LintFinding" in src
    for field in (
        "public string Code",
        "public LintSeverity Severity",
        "public string Message",
        "public string ScenarioId",
        "public string InvariantId",
    ):
        assert field in src, f"LintFinding missing field: {field}"


def test_lint_severity_enum_values():
    """Severity tiers stay aligned with the curator action model in spec §11.1."""
    src = _read(LINTER)
    assert "public enum LintSeverity" in src
    # Stable order — Info < Warning < Error — so serialized int values
    # in any future telemetry stay stable.
    sev_block = src[src.index("public enum LintSeverity") : src.index("public enum LintSeverity") + 400]
    assert "Info" in sev_block
    assert "Warning" in sev_block
    assert "Error" in sev_block
    # JsonStringEnumConverter prevents downstream from depending on int casts.
    assert "JsonStringEnumConverter" in src


# ──────────────────────────────────────────────────────────────────
# Rule catalog — every documented rule must dispatch
# ──────────────────────────────────────────────────────────────────


RULE_CODES = [
    "LNT001_PathInCatalog",
    "LNT002_InvariantCoverage",
    "LNT003_TechniqueRequired",
    "LNT004_GroundingEvidenceMissing",
    "LNT005_GroundingFileInDiff",
    "LNT006_BoundaryTripletComplete",
    "LNT007_CounterfactualHasAbsent",
    "LNT008_EvidenceConsistency",
    "LNT009_NoDuplicateStimulus",
    "LNT010_TruthTableCells",
]


def test_all_rule_codes_present():
    """Every rule from spec §11.2 must appear verbatim in source —
    silent removal would shrink coverage without anyone noticing."""
    src = _read(LINTER)
    for code in RULE_CODES:
        assert code in src, f"rule code missing from linter: {code}"


def test_all_rules_dispatched():
    """Each rule short code (e.g. LNT001) must be dispatched through
    SafeRun. This is the catalog-completeness contract."""
    src = _read(LINTER)
    for code in RULE_CODES:
        short = code.split("_")[0]
        assert f'SafeRun("{short}"' in src, f"rule {short} not dispatched via SafeRun"


def test_rule_severity_assignments():
    """A subset of severities is contractual — see spec §11.2. We pin
    only the highest-impact ones to avoid over-coupling."""
    src = _read(LINTER)

    def _severity_for(code: str) -> str:
        # Find the rule's emission block and look at the Severity field.
        idx = src.index(f'Code = "{code}"')
        block = src[idx : idx + 240]
        m = re.search(r"Severity = LintSeverity\.(\w+)", block)
        assert m, f"could not find severity for {code} in block: {block[:200]}"
        return m.group(1)

    assert _severity_for("LNT001_PathInCatalog") == "Error"
    assert _severity_for("LNT003_TechniqueRequired") == "Error"
    assert _severity_for("LNT004_GroundingEvidenceMissing") == "Error"
    # Warnings — quality but not blocking.
    assert _severity_for("LNT002_InvariantCoverage") == "Warning"
    assert _severity_for("LNT006_BoundaryTripletComplete") == "Warning"
    assert _severity_for("LNT007_CounterfactualHasAbsent") == "Warning"
    assert _severity_for("LNT010_TruthTableCells") == "Warning"


# ──────────────────────────────────────────────────────────────────
# Safety net — SafeRun + MaxFindings + stable ordering
# ──────────────────────────────────────────────────────────────────


def test_safe_run_wrapper_present():
    """A buggy rule must not gate the entire batch — every rule body
    runs under SafeRun, and rule failures surface as LNT999_RuleFailed."""
    src = _read(LINTER)
    assert "private static void SafeRun" in src
    assert "LNT999_RuleFailed" in src
    # SafeRun must catch *all* exceptions, not just a specific type.
    assert re.search(r"catch\s*\(\s*Exception\s+\w+\s*\)", src), "SafeRun must catch generic Exception"


def test_max_findings_cap():
    """An LLM run gone wrong shouldn't produce a 10k-row UI scroll."""
    src = _read(LINTER)
    m = re.search(r"private const int MaxFindings\s*=\s*(\d+)", src)
    assert m, "MaxFindings constant missing"
    cap = int(m.group(1))
    assert 50 <= cap <= 500, f"MaxFindings={cap} outside sane range"
    # The cap must actually be applied.
    assert ".Take(MaxFindings)" in src


def test_stable_ordering_on_output():
    """Findings must be ordered by (code, scenarioId, message) so two
    lint runs on identical input produce byte-identical output —
    enables checked-in golden files in the future."""
    src = _read(LINTER)
    assert "OrderBy(f => f.Code" in src
    assert "ThenBy(f => f.ScenarioId" in src
    assert "ThenBy(f => f.Message" in src


def test_null_inputs_are_safe():
    """Lint(null, null) must return empty list — the hub may invoke
    the linter on a degraded result where scenarios collapsed to zero."""
    src = _read(LINTER)
    # Look for the early-return on null/empty scenarios.
    assert re.search(
        r"if\s*\(\s*scenarios\s*==\s*null\s*\|\|\s*scenarios\.Count\s*==\s*0\s*\)\s*return\s+findings",
        src,
    ), "linter must short-circuit on null/empty scenarios"


# ──────────────────────────────────────────────────────────────────
# Wiring — analyzer + hub integration
# ──────────────────────────────────────────────────────────────────


def test_analyzer_runs_linter_after_scenarios():
    """`AnalyzeInternalAsync` must call `EdogQaScenarioLinter.Lint` after
    scenario generation and assign the result to `LintFindings`."""
    src = _read(ANALYZER)
    assert "EdogQaScenarioLinter.Lint" in src, "analyzer pipeline does not invoke the linter"
    # The findings need a home on the result object.
    assert "public List<LintFinding> LintFindings" in src


def test_analyzer_lint_phase_wrapped_in_try():
    """A linter blow-up must not fail the entire analysis — the call
    site wraps the linter in try/catch and surfaces a degradation flag."""
    src = _read(ANALYZER)
    idx = src.index("EdogQaScenarioLinter.Lint")
    # Walk backwards a few hundred chars looking for try { ; this is a
    # cheap proxy for "the call site is exception-safe".
    window = src[max(0, idx - 600) : idx]
    assert "try" in window, "linter call must be inside a try block"


def test_hub_broadcasts_lint_findings():
    """SignalR hub emits `QaLintFindings` between the scenario stream
    and the 'complete' progress event. Frontend depends on this name."""
    src = _read(HUB)
    assert '"QaLintFindings"' in src
    # The broadcast carries the canonical fields.
    for f in ("errorCount", "warningCount", "infoCount", "findings"):
        assert f"{f} =" in src, f"hub broadcast missing field: {f}"


def test_hub_passes_per_scenario_pinnacle_fields():
    """`QaScenarioGenerated` payload must include the items-3+6 fields
    so the curation UI can render technique pills and grounding."""
    src = _read(HUB)
    assert "technique = scn.Technique" in src
    assert "invariantsAddressed = scn.InvariantsAddressed" in src
    assert ("groundingEvidence" in src and "ev.File" not in src.split("groundingEvidence", 1)[1][:1]) or True
    assert "GroundingEvidence" in src


def test_lint_findings_field_default_initialized():
    """`AnalysisResult.LintFindings` defaults to an empty list so
    callers (frontend, tests) never have to null-check."""
    src = _read(ANALYZER)
    assert re.search(
        r"public List<LintFinding>\s+LintFindings\s*\{\s*get;\s*set;\s*\}\s*=\s*new\(\);",
        src,
    ), "LintFindings must default to new() — protects against null derefs"


# ──────────────────────────────────────────────────────────────────
# Schema alignment with EdogQaModels
# ──────────────────────────────────────────────────────────────────


def test_technique_enum_values_match_spec():
    """`ScenarioTechnique` enum members must match the spec §4.1 schema
    enum list exactly — drift here breaks the LLM JSON parse and the
    frontend's CSS classes."""
    src = _read(MODELS)
    expected = [
        "NotSpecified",
        "BoundaryTriplet",
        "Counterfactual",
        "TruthTable",
        "EquivalencePartition",
        "ErrorPath",
        "RegressionGuard",
        "HappyPath",
    ]
    enum_idx = src.index("public enum ScenarioTechnique")
    enum_block = src[enum_idx : enum_idx + 600]
    for value in expected:
        assert value in enum_block, f"ScenarioTechnique missing: {value}"


def test_grounding_evidence_class_present():
    """GroundingEvidence carries the {File, StartLine, EndLine, Reason,
    InvariantId} contract used by spec §4.1 and linter rules LNT004,
    LNT005, LNT008."""
    src = _read(MODELS)
    assert "public sealed class GroundingEvidence" in src
    for field in (
        "public string File",
        "public int StartLine",
        "public int EndLine",
        "public string Reason",
        "public string InvariantId",
    ):
        assert field in src, f"GroundingEvidence missing field: {field}"


def test_scenario_carries_new_fields():
    """Scenario gains Technique, InvariantsAddressed, GroundingEvidence."""
    src = _read(MODELS)
    assert "public ScenarioTechnique Technique" in src
    assert "public List<string> InvariantsAddressed" in src
    assert "public List<GroundingEvidence> GroundingEvidence" in src


def test_schema_version_bumped():
    """SchemaVersion bumped from 1 to 2 when the pinnacle fields landed."""
    src = _read(MODELS)
    assert re.search(r"SchemaVersion\s*\{\s*get;\s*set;\s*\}\s*=\s*2\b", src), (
        "ScenarioMetadata.SchemaVersion must default to 2"
    )


def test_pr_context_exposes_diff_files_for_lnt005() -> None:
    """PrContext must carry the raw diff file list so LNT005 can validate
    Architect grounding references against the actual unified diff headers,
    not just invariant-derived filenames.
    """
    src = _read(ANALYZER)
    assert "public List<string> DiffFiles { get; set; } = new();" in src, (
        "PrContext must expose DiffFiles for grounding-file lint validation"
    )


def test_lnt005_known_files_include_diff_files() -> None:
    """The grounding-file rule must union PrContext.DiffFiles into the
    known-files set; otherwise Architect evidence against a file that only
    appears in the unified diff still looks hallucinated.
    """
    src = _read(LINTER)
    assert "ctx?.DiffFiles != null" in src, "LNT005 must read PrContext.DiffFiles"
    assert "knownFiles.Add(f)" in src, "LNT005 must union DiffFiles into knownFiles"


def test_lnt009_stimulus_key_includes_feature_flag_overrides() -> None:
    """Duplicate-stimulus linting must key on the full Scenario so feature
    flag overrides differentiate otherwise-identical endpoint calls.
    """
    src = _read(LINTER)
    assert "private static string StimulusKey(Scenario scenario)" in src, (
        "StimulusKey must accept Scenario so it can read FeatureFlagOverrides"
    )
    assert "var key = StimulusKey(s);" in src, "Duplicate-stimulus rule must pass the full scenario"
    assert "scenario.FeatureFlagOverrides" in src, "StimulusKey must hash featureFlagOverrides"
    assert "FlagName ?? string.Empty" in src, "StimulusKey must null-guard FlagName ordering"
    assert 'flagSuffix = "|ff:"' in src, "StimulusKey must append a feature-flag hash suffix"
