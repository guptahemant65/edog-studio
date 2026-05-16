"""Shape tests for the F27 QA scenario LLM prompt
(`EdogQaLlmProvider.BuildSystemPrompt`).

These tests guard the structural contract of the system prompt — the
sections an LLM relies on to produce rigorous test matrices — against
accidental deletion or reordering during refactor. They do NOT run
the prompt against the model; that is integration-tested at FLT deploy
time. Each assertion is a single string-presence check so a failure
points exactly at the missing line.

If you intentionally renamed a section or replaced an exemplar, update
the matching assertion in this file in the same commit.
"""

from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
LLM_PROVIDER = PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaLlmProvider.cs"


def _read_source() -> str:
    return LLM_PROVIDER.read_text(encoding="utf-8")


# ──────────────────────────────────────────────────────────────────
# Section 1 — Outer prompt structure
# ──────────────────────────────────────────────────────────────────


def test_build_system_prompt_exists():
    """The method must exist and be private static so it stays a pure
    builder with no DI surface."""
    src = _read_source()
    assert "private static string BuildSystemPrompt()" in src


def test_prompt_declares_stimulus_types():
    """All 6 stimulus types from EdogQaModels must be enumerated so the
    LLM cannot invent a new one."""
    src = _read_source()
    for kind in (
        "HttpRequest",
        "SignalrInvoke",
        "DagTrigger",
        "FileEvent",
        "TimerTick",
        "DirectInvoke",
    ):
        assert f"- {kind}:" in src, f"missing stimulus enumeration: {kind}"


def test_prompt_declares_expectation_types():
    """All 6 expectation types must be enumerated."""
    src = _read_source()
    for kind in (
        "EventPresent",
        "EventAbsent",
        "EventCount",
        "EventOrder",
        "Timing",
        "FieldMatch",
    ):
        assert f"- {kind}:" in src, f"missing expectation enumeration: {kind}"


def test_prompt_ends_with_json_only_sentinel():
    """The terminal sentinel is what makes the LLM emit raw JSON without
    markdown fences. Loss of this line is a frequent regression."""
    src = _read_source()
    assert 'Return ONLY valid JSON, no markdown, no explanation text.";' in src


# ──────────────────────────────────────────────────────────────────
# Section 2 — TECHNIQUES table (item 4)
# ──────────────────────────────────────────────────────────────────


def test_techniques_section_present():
    src = _read_source()
    assert "**TECHNIQUES (apply these to invariants surfaced" in src


def test_techniques_cover_every_invariant_kind():
    """Each invariant kind emitted by EdogQaInvariantExtractor must have
    a corresponding technique entry — otherwise the LLM will see
    invariants in the user message it does not know how to handle."""
    src = _read_source()
    expected_kinds = (
        "numeric_constant",
        "temporal_threshold",
        "removed_parameter",
        "added_parameter",
        "comparison_predicate",
        "explicit_error",
    )
    for kind in expected_kinds:
        assert f"*{kind}*" in src, f"technique missing for invariant kind: {kind}"


def test_techniques_name_boundary_triplet_pattern():
    """Boundary triplet is the single most under-applied technique. Pin it."""
    src = _read_source()
    assert "Boundary triplet" in src
    assert "59-day, 60-day, and 61-day" in src


def test_techniques_name_counterfactual_pattern():
    src = _read_source()
    assert "Counterfactual" in src


def test_techniques_name_truth_table_pattern():
    src = _read_source()
    assert "Truth-table" in src


def test_invariant_id_citation_rule_present():
    """Every invariant ID must be cited in at least one scenario — this
    is the contract the linter (item 5) will enforce."""
    src = _read_source()
    assert 'Each invariant ID (e.g. ""inv-numeric_constant-abc123"") MUST be cited in at least one scenario' in src


# ──────────────────────────────────────────────────────────────────
# Section 3 — FEW-SHOT EXEMPLARS (item 4)
# ──────────────────────────────────────────────────────────────────


def test_exemplars_header_present():
    src = _read_source()
    assert "**FEW-SHOT EXEMPLARS:**" in src


def test_exemplar_a_boundary_triplet_has_three_cells():
    """Exemplar A must contain all three boundary scenarios so the LLM
    sees the full pattern, not a hint."""
    src = _read_source()
    assert "59-day window: just below 60-day cap returns 200" in src
    assert "60-day window: exactly at cap returns 200" in src
    assert "61-day window: one day over cap returns 400" in src


def test_exemplar_b_counterfactual_has_event_absent_assertion():
    """Counterfactual must demonstrate EventAbsent in addition to
    EventPresent — that is the half the LLM tends to forget."""
    src = _read_source()
    assert "Legacy dateRange query param is silently ignored" in src
    assert '""type"": ""EventAbsent""' in src


def test_exemplar_c_truth_table_has_four_cells():
    """All 2x2 cells must appear so the LLM internalizes the full grid."""
    src = _read_source()
    assert "Both startTime and endTime omitted: defaults to last 7 days" in src
    assert "Only endTime set: startTime backfilled" in src
    assert "Only startTime set: endTime forward-filled" in src
    assert "Both set: explicit window honored without modification" in src


def test_never_guardrails_still_present():
    """The exemplar block must not have displaced the NEVER guardrails."""
    src = _read_source()
    assert "**NEVER:**" in src
    assert "Hallucinate API endpoints not in the code change" in src


# ──────────────────────────────────────────────────────────────────
# Section 4 — User message contract sections (item 1)
# ──────────────────────────────────────────────────────────────────


def test_user_message_contains_contract_sections():
    """AppendContractSections must still render every section header so
    the LLM can locate PR description, AC, OpenAPI, prior tests, and
    invariants by anchor text."""
    src = _read_source()
    for header in (
        "# Pull Request Contract",
        "# Linked Work Items",
        "# Linked Specification Excerpts",
        "# API Surface (changed controllers)",
        "# Prior Test Coverage",
    ):
        assert header in src, f"contract section missing: {header}"


def test_api_surface_path_rule_present():
    """The path-match rule is the single biggest hallucination guard."""
    src = _read_source()
    assert "**RULE: stimulus.path MUST match one of these endpoints exactly.**" in src
