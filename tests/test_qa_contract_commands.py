from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MAKEFILE = REPO_ROOT / "Makefile"


def test_make_targets_exist_for_contract_work() -> None:
    src = MAKEFILE.read_text(encoding="utf-8")
    for needle in ("ruff check .", "pytest --cov", "scripts/build-html.py"):
        assert needle in src
