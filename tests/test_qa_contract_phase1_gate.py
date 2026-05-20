from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLAN_SPEC = REPO_ROOT / "docs" / "specs" / "features" / "F27-qa-testing" / "p10-executable-stimulus-contract.md"


def test_phase1_depends_on_flt_contract_tag() -> None:
    src = PLAN_SPEC.read_text(encoding="utf-8")
    assert "flt/qa-contract-v1.0" in src
