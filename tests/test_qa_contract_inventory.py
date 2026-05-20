from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SPEC = REPO_ROOT / "docs" / "specs" / "features" / "F27-qa-testing" / "p10-executable-stimulus-contract.md"


def test_appendix_a_lists_phase1_files() -> None:
    src = SPEC.read_text(encoding="utf-8")
    for path in (
        "EdogQaContractCatalog",
        "EdogQaDagScanner",
        "EdogQaFileTimerScanner",
        "EdogQaTelemetryRedactor",
        "IQaContractOptionsProvider",
        "qa-curation.js",
        "qa-analysis.js",
        "dev-server.py",
        "edog-config.template.json",
    ):
        assert path in src
