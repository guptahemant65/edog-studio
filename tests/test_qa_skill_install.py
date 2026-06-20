from pathlib import Path

SKILL = Path("skills/flt-pr-scenario-validator/SKILL.md")


def test_skill_file_exists():
    assert SKILL.exists()


def test_skill_declares_required_sections():
    text = SKILL.read_text(encoding="utf-8")
    for heading in (
        "# FLT PR Scenario Validator",
        "## The Journey",
        "## Guardrails",
        "## Grounding Protocol",
        "## Tool Surface",
    ):
        assert heading in text, f"missing: {heading}"


def test_reference_docs_exist():
    base = Path("skills/flt-pr-scenario-validator/reference")
    for f in ("flt-model.md", "tools.md", "scenarios.md", "flt-subsystems.md"):
        assert (base / f).exists(), f"missing reference/{f}"
