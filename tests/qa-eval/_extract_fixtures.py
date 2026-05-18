"""F27 P9 T1a — extract gold-corpus PR fixtures from the local FLT clone.

This is a developer utility (not a test). It reads a small list of PR
metadata, walks the local FLT git clone, and writes a normalized fixture
under ``tests/qa-eval/ground-truth/PR-NNNNNN/`` containing:

- ``pr.json``      — title, base/head SHAs, file list, author, capture timestamp
- ``diff.patch``   — full unified diff (the LLM input)
- ``expected.json`` — empty placeholder (human curator fills in)
- ``notes.md``     — curator notes stub

Run from the edog-studio repo root::

    python tests/qa-eval/_extract_fixtures.py

Idempotent: safe to re-run. Overwrites ``pr.json`` and ``diff.patch`` (those
are deterministic snapshots of the clone) but never overwrites
``expected.json`` or ``notes.md`` once curated.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FLT_REPO = Path.home() / "newrepo" / "workload-fabriclivetable"
GROUND_TRUTH = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"


# (pr_number, ref_or_sha, base_ref_or_sha, short_description)
PRS = [
    (
        "977882",
        "refs/pr/977882",
        "74c538b15da7954aa7b132e0135fa73f8e447347",
        "Insights date contract v2.0.6",
    ),
    (
        "976609",
        "74c538b1",
        "74c538b1^",
        "Add refreshPolicyDistribution to /trends API",
    ),
    (
        "975848",
        "42b1c616",
        "42b1c616^",
        "Add refreshPolicyDistribution to /summary API",
    ),
    # F27 P9 T1k — corpus augmentation to validate the bipartite N=15 knee
    # against diverse change shapes (current 3-PR corpus is monoculture:
    # all Insights /summary or /trends controllers). The trio below covers:
    #   - PR-960543: ERROR-CODE CATALOG (17 files, MLV_DATA_CORRUPTED +
    #     MLV_ENTITY_NOT_FOUND + ~half-dozen call-site migrations)
    #   - PR-955910: SCHEDULER / TRIGGER ORCHESTRATION (7 files, multi-
    #     schedule refresh trigger model + validation + persistence)
    #   - PR-966141: ERROR-CLASSIFICATION LOGIC (2 files, IsUserError()
    #     classification of HttpStatusCode.BadRequest — tiny semantic
    #     diff stress-tests scorer on minimal grounding)
    (
        "960543",
        "ab6b718a",
        "ab6b718a^",
        "Data integrity error codes (MLV_DATA_CORRUPTED, MLV_ENTITY_NOT_FOUND)",
    ),
    (
        "955910",
        "ea9f451d",
        "ea9f451d^",
        "[RefreshTriggers] Enable Multi-schedule support",
    ),
    (
        "966141",
        "f96896ca",
        "f96896ca^",
        "Classify HttpStatusCode.BadRequest as user error in IsUserError()",
    ),
]


def git(args: list[str], *, cwd: Path = FLT_REPO) -> str:
    proc = subprocess.run(
        ["git", "--no-pager", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed in {cwd}: {proc.stderr.strip()}"
        )
    return proc.stdout


def extract_one(pr_num: str, ref: str, base_ref: str, desc: str) -> None:
    out_dir = GROUND_TRUTH / f"PR-{pr_num}"
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"--- PR {pr_num}: {desc} ---")

    head_sha = git(["rev-parse", ref]).strip()
    base_sha = git(["rev-parse", base_ref]).strip()
    subject = git(["log", "-1", "--format=%s", ref]).strip()
    author_email = git(["log", "-1", "--format=%ae", ref]).strip()
    authored_date = git(["log", "-1", "--format=%aI", ref]).strip()

    # File list (status + path)
    files_raw = git(["diff", "--name-status", f"{base_sha}..{head_sha}"])
    files: list[dict[str, str]] = []
    for line in files_raw.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t", 1)
        if len(parts) == 2:
            files.append({"status": parts[0].strip(), "path": parts[1].strip()})

    # Full unified diff
    diff_text = git(["diff", "--no-color", f"{base_sha}..{head_sha}"])
    diff_path = out_dir / "diff.patch"
    diff_path.write_text(diff_text, encoding="utf-8")

    # pr.json (metadata, always rewritten — deterministic from git)
    meta = {
        "pr_number": pr_num,
        "pr_url": (
            "https://dev.azure.com/powerbi/MWC/_git/workload-fabriclivetable"
            f"/pullrequest/{pr_num}"
        ),
        "repo": "workload-fabriclivetable",
        "title": subject,
        "description": desc,
        "base_sha": base_sha,
        "head_sha": head_sha,
        "author_email": author_email,
        "authored_date": authored_date,
        "files_changed": len(files),
        "files": files,
        "diff_path": "diff.patch",
        "diff_size_bytes": len(diff_text.encode("utf-8")),
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "captured_from": f"{FLT_REPO} (local clone)",
    }
    (out_dir / "pr.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # expected.json (placeholder — NEVER overwrite if a curator has touched it)
    expected_path = out_dir / "expected.json"
    if not expected_path.exists():
        expected = {
            "schema_version": "1.0",
            "pr_number": pr_num,
            "curator": "PENDING_HUMAN_GRADING",
            "curated_at": None,
            "scenarios": [],
            "notes": (
                "Hand-grade required: list the scenarios a production-grade LLM "
                "SHOULD generate for this PR. Each scenario must include id, "
                "title, category, grounding (file + side + hunkId + newLine), "
                "assertions, and a confidence floor. See "
                "docs/specs/features/F27-qa-testing/p9-production-grade-llm.md "
                "§4 for the schema."
            ),
        }
        expected_path.write_text(
            json.dumps(expected, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print("  → wrote expected.json (placeholder)")
    else:
        with expected_path.open(encoding="utf-8") as fh:
            existing = json.load(fh)
        if existing.get("curator") == "PENDING_HUMAN_GRADING":
            # No human edits yet — safe to refresh in case schema changed.
            print("  → expected.json exists (still PENDING_HUMAN_GRADING) — leaving as-is")
        else:
            print("  → expected.json exists and has been curated — leaving untouched")

    # notes.md (placeholder — NEVER overwrite once humans have edited)
    notes_path = out_dir / "notes.md"
    if not notes_path.exists():
        notes_path.write_text(
            f"""# PR {pr_num} — Curator Notes

**Title:** {subject}
**Base:** `{base_sha}`
**Head:** `{head_sha}`
**Files changed:** {len(files)}

## Change-shape classification

_Pending: classify per F27 P9 §6 (controller / retry / DAG / schema / config)._

## Expected scenarios (hand-grade)

_Pending: enumerate the scenarios a production-grade LLM SHOULD generate
for this diff, with grounding evidence. These become `expected.json`._

## Rejected alternatives

_Pending: scenarios the LLM might generate that should be rejected
(over-grounded, hallucinated, irrelevant, low-value)._

## Notes

_Pending._
""",
            encoding="utf-8",
        )
        print("  → wrote notes.md (placeholder)")

    diff_kb = round(len(diff_text.encode("utf-8")) / 1024, 1)
    print(f"  → {out_dir.relative_to(REPO_ROOT)} (diff.patch={diff_kb}KB, {len(files)} files)")


def main() -> int:
    if not FLT_REPO.exists():
        print(f"FLT clone not found at {FLT_REPO}", file=sys.stderr)
        return 2
    GROUND_TRUTH.mkdir(parents=True, exist_ok=True)
    for pr_num, ref, base, desc in PRS:
        try:
            extract_one(pr_num, ref, base, desc)
        except Exception as exc:
            print(f"  ERROR extracting PR {pr_num}: {exc}", file=sys.stderr)
            return 1

    # Summary
    print("\n--- Summary ---")
    total_files = 0
    total_diff_bytes = 0
    for pr_num, *_ in PRS:
        meta_path = GROUND_TRUTH / f"PR-{pr_num}" / "pr.json"
        if not meta_path.exists():
            continue
        with meta_path.open(encoding="utf-8") as fh:
            meta = json.load(fh)
        total_files += meta["files_changed"]
        total_diff_bytes += meta["diff_size_bytes"]
        print(
            f"  PR {pr_num}: {meta['files_changed']:2d} files, "
            f"{round(meta['diff_size_bytes']/1024, 1):>5} KB diff"
        )
    print(
        f"  TOTAL:    {total_files:2d} files, "
        f"{round(total_diff_bytes/1024, 1):>5} KB diff "
        f"across {len(PRS)} PRs"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
