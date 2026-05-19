"""F27 P9 T1a — gold-corpus evaluation harness scaffold.

Reads the hand-curated ground-truth fixtures under
``tests/qa-eval/ground-truth/PR-*/`` and reports their shape. T1a ships
only the corpus loader and the baseline scaffold; the real run path
(loading the legacy LLM pipeline, scoring against ``expected.json``,
writing ``baseline.json``) is wired in T1b once the V2 client exists.

Run from the edog-studio repo root::

    python tests/qa-eval/run_eval.py            # show corpus stats
    python tests/qa-eval/run_eval.py --json     # machine-readable summary

The companion ``baseline.json`` is the leaderboard the V2 pipeline must
beat. It is created empty by T1a and populated when T1b lands.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"
BASELINE_PATH = REPO_ROOT / "tests" / "qa-eval" / "baseline.json"


def load_corpus() -> list[dict]:
    """Return one entry per ``ground-truth/PR-*`` directory, sorted by PR id."""
    entries: list[dict] = []
    if not GROUND_TRUTH.exists():
        return entries

    for pr_dir in sorted(GROUND_TRUTH.iterdir()):
        if not pr_dir.is_dir() or not pr_dir.name.startswith("PR-"):
            continue
        meta_path = pr_dir / "pr.json"
        if not meta_path.exists():
            continue
        diff_path = pr_dir / "diff.patch"
        expected_path = pr_dir / "expected.json"

        with meta_path.open(encoding="utf-8") as fh:
            meta = json.load(fh)
        expected = None
        if expected_path.exists():
            with expected_path.open(encoding="utf-8") as fh:
                expected = json.load(fh)

        entries.append(
            {
                "pr_number": meta.get("pr_number"),
                "title": meta.get("title"),
                "files_changed": meta.get("files_changed"),
                "diff_bytes": meta.get("diff_size_bytes") or (diff_path.stat().st_size if diff_path.exists() else 0),
                "expected_status": (expected or {}).get("curator", "PENDING_HUMAN_GRADING"),
                "expected_scenarios": len((expected or {}).get("scenarios", []) or []),
                "dir": pr_dir.relative_to(REPO_ROOT).as_posix(),
            }
        )
    return entries


def ensure_baseline(corpus: list[dict]) -> dict:
    """Read the baseline JSON or create the placeholder scaffold."""
    if BASELINE_PATH.exists():
        with BASELINE_PATH.open(encoding="utf-8") as fh:
            return json.load(fh)

    scaffold = {
        "schema_version": "1.0",
        "captured_at": None,
        "pipeline": "legacy_chat_completions",
        "status": "PENDING_T1B",
        "notes": (
            "Baseline is the legacy pipeline's score against this corpus — the "
            "floor the V2 pipeline (F27 P9 T1b/T1c) must beat. T1a ships only "
            "the scaffold; run_eval.py will populate this once the V2 client "
            "lands and the expected.json files are hand-graded."
        ),
        "prs": [
            {
                "pr_number": entry["pr_number"],
                "recall": None,
                "precision": None,
                "grounding_violations": None,
                "scenarios_generated": None,
            }
            for entry in corpus
        ],
    }
    BASELINE_PATH.write_text(json.dumps(scaffold, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return scaffold


def main() -> int:
    parser = argparse.ArgumentParser(description="F27 P9 gold-corpus eval scaffold")
    parser.add_argument("--json", action="store_true", help="emit machine-readable summary")
    args = parser.parse_args()

    corpus = load_corpus()
    baseline = ensure_baseline(corpus)

    if args.json:
        summary = {
            "corpus_size": len(corpus),
            "total_diff_bytes": sum(e["diff_bytes"] for e in corpus),
            "total_files": sum(e["files_changed"] or 0 for e in corpus),
            "pending_human_grading": sum(1 for e in corpus if e["expected_status"] == "PENDING_HUMAN_GRADING"),
            "corpus": corpus,
            "baseline_status": baseline.get("status"),
        }
        json.dump(summary, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    if not corpus:
        print(f"No PRs found under {GROUND_TRUTH.relative_to(REPO_ROOT)}.")
        print("Run `python tests/qa-eval/_extract_fixtures.py` to populate.")
        return 1

    print(f"F27 P9 gold corpus — {len(corpus)} PR(s):\n")
    print(f"  {'PR':>7}  {'Files':>5}  {'Diff':>7}  {'Expected':>9}  Title")
    print(f"  {'-' * 7}  {'-' * 5}  {'-' * 7}  {'-' * 9}  {'-' * 40}")
    for entry in corpus:
        diff_kb = round((entry["diff_bytes"] or 0) / 1024, 1)
        title = (entry["title"] or "")[:60]
        status = "PENDING" if entry["expected_status"] == "PENDING_HUMAN_GRADING" else "OK"
        print(f"  {entry['pr_number']:>7}  {entry['files_changed']:>5}  {diff_kb:>5}KB  {status:>9}  {title}")

    pending = sum(1 for e in corpus if e["expected_status"] == "PENDING_HUMAN_GRADING")
    print()
    print(f"  Hand-grading pending: {pending} / {len(corpus)}")
    print(f"  Baseline status:      {baseline.get('status', 'unknown')}")
    print()
    print("  Next step (T1b): wire the V2 LLM client + populate baseline.json")
    print("  from the legacy pipeline so the V2 path has a real floor to beat.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
