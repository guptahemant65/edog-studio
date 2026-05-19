#!/usr/bin/env python3
"""F27 P9 T4-C-prep — pick FLT PR candidates for gold-corpus expansion.

Walks a local clone of the FabricLiveTable workload repo, discovers
recent merge commits, classifies each by change-shape (controller /
DAG / schema / config / test-only / docs / infra) using path
heuristics, and emits a deterministic, stratified selection that fills
diversity-bucket gaps relative to the existing graded corpus under
``tests/qa-eval/ground-truth/PR-*/``.

The output is ``tests/qa-eval/corpus_candidates.json`` — a manifest
recording every considered PR, its scoring, the selection decision,
and a per-bucket rationale. The manifest is the audit trail; the
fixture dirs (``tests/qa-eval/ground-truth/PR-NNN/``) are the truth.

This script makes NO outbound network calls and NO LLM calls. It only
reads the FLT git repo and writes JSON. Run it before
``capture_pr_fixture.py``.

Usage::

    python tests/qa-eval/pick_corpus_candidates.py \
        --flt-repo C:/Users/USER/newrepo/workload-fabriclivetable \
        --since "2 months ago" \
        --target-additions 9 \
        --output tests/qa-eval/corpus_candidates.json

Deterministic: same FLT repo state + same flags + same existing corpus
state yields byte-identical output (no random sampling — selection is
sort-stable + bucket-fill greedy).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH_DIR = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"
DEFAULT_OUTPUT = REPO_ROOT / "tests" / "qa-eval" / "corpus_candidates.json"
DEFAULT_FLT_REPO = Path("C:/Users/guptahemant/newrepo/workload-fabriclivetable")

SCHEMA_VERSION = "1.0"

MERGE_PATTERNS = (
    re.compile(r"^Merged PR (\d+):\s*(.+)$"),
    re.compile(r"^Merge pull request (\d+) from .* into \w+$"),
    re.compile(r"^Merge pull request (\d+)\b\s*(.*)$"),
)


@dataclass
class FileChange:
    path: str
    additions: int
    deletions: int


@dataclass
class PrCandidate:
    pr_number: str
    merge_commit_sha: str
    title: str
    authored_date: str
    files_changed: int
    additions: int
    deletions: int
    diff_size_bytes: int
    change_shape: str
    subsystem: str
    files: list[FileChange] = field(default_factory=list)
    # Bucket coordinates used for stratification:
    files_bucket: str = ""
    size_bucket: str = ""
    # Selection bookkeeping:
    selected: bool = False
    rejection_reason: str = ""
    selection_rationale: str = ""


# ── git helpers ────────────────────────────────────────────────────


def _run_git(repo: Path, *args: str) -> str:
    cmd = ["git", "-C", str(repo), "-c", "core.autocrlf=false", "-c", "diff.external=", *args]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git command failed (exit {proc.returncode}): {' '.join(cmd)}\nstderr: {(proc.stderr or '')[-2000:]}"
        )
    return proc.stdout or ""


def _list_merge_commits(repo: Path, since: str) -> list[tuple[str, str, str]]:
    """Return [(sha, authored_iso, title), ...] for PR-merge commits.

    ADO squash-merges (single parent) — we identify them by title
    prefix ('Merged PR NNN:' or 'Merge pull request NNN'), not by
    --merges, since squash merges have one parent.
    """
    out = _run_git(
        repo,
        "log",
        f"--since={since}",
        "--pretty=format:%H%x1f%aI%x1f%s",
    )
    rows: list[tuple[str, str, str]] = []
    for line in out.splitlines():
        parts = line.split("\x1f", 2)
        if len(parts) == 3 and _parse_pr_number(parts[2]) is not None:
            rows.append((parts[0], parts[1], parts[2]))
    return rows


def _parse_pr_number(title: str) -> str | None:
    for pattern in MERGE_PATTERNS:
        m = pattern.match(title)
        if m:
            return m.group(1)
    return None


def _numstat(repo: Path, sha: str) -> list[FileChange]:
    """Read per-file additions/deletions for a merge's first-parent diff."""
    out = _run_git(
        repo,
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--numstat",
        f"{sha}^1",
        sha,
    )
    files: list[FileChange] = []
    for line in out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        try:
            adds = int(parts[0]) if parts[0] != "-" else 0
            dels = int(parts[1]) if parts[1] != "-" else 0
        except ValueError:
            adds = dels = 0
        files.append(FileChange(path=parts[2], additions=adds, deletions=dels))
    return files


def _diff_size(repo: Path, sha: str) -> int:
    out = _run_git(
        repo,
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--unified=3",
        f"{sha}^1",
        sha,
    )
    return len(out.encode("utf-8"))


# ── classification ─────────────────────────────────────────────────


def _classify_change_shape(files: list[FileChange]) -> str:
    """Bucket a PR by what KIND of change it represents.

    Heuristic-first, dominant-class wins (>=60%% of files). Falls back
    to 'mixed' when no class dominates. Order of checks matters:
    docs/test/generated are short-circuit excluders so a PR that is
    almost all tests can't masquerade as a 'controller' change.
    """
    if not files:
        return "empty"

    paths = [f.path.lower() for f in files]
    total = len(paths)

    def frac(predicate) -> float:
        return sum(1 for p in paths if predicate(p)) / total

    # Docs / generated / dependency PRs — heavily downranked.
    if frac(lambda p: p.endswith((".md", ".txt", ".html")) or "/docs/" in p) >= 0.6:
        return "docs"

    # Config / dependency files: package version files, build config, CI/workflow JSON.
    # Dependabot PRs and CI-only PRs land here. Catches Directory.Packages.props,
    # Directory.Build.props, *.csproj, swagger contracts, and anything under .github/.
    def _is_config(p: str) -> bool:
        name = p.rsplit("/", 1)[-1]
        if name.startswith("directory."):
            return True
        return (
            p.endswith((".swagger.json", "swagger.json", ".csproj", ".props", ".targets", ".sln"))
            or p.startswith(".github/")
            or "/.github/" in p
        )

    if frac(_is_config) >= 0.6:
        return "generated_or_config"
    if frac(lambda p: "test" in p or p.endswith("tests.cs")) >= 0.6:
        return "test_only"

    # Production-code classifications. Multiple may match; first wins.
    if frac(lambda p: "controller" in p or "/api/" in p or "endpoint" in p) >= 0.3:
        return "controller"
    if frac(lambda p: "/dag/" in p or "scheduler" in p or "/execution/" in p or "orchestrat" in p) >= 0.3:
        return "dag"
    if frac(lambda p: "/datamodel/" in p or "schema" in p or "/models/" in p or "datacontract" in p) >= 0.3:
        return "schema"
    if frac(lambda p: "config" in p or "featureflag" in p or "flightconfig" in p or "/settings/" in p) >= 0.3:
        return "config"
    if frac(lambda p: "error" in p or "exception" in p or "/errorcode" in p) >= 0.3:
        return "error_handling"
    if frac(lambda p: "/cache" in p or "perf" in p or "/throughput" in p or "/latency" in p) >= 0.3:
        return "performance"
    if frac(lambda p: "/auth" in p or "token" in p or "/security/" in p) >= 0.3:
        return "auth_security"
    if frac(lambda p: "/devmode/" in p or "/diagnostics/" in p or "/telemetry/" in p) >= 0.3:
        return "infra"

    return "mixed"


def _subsystem(files: list[FileChange]) -> str:
    """Top-of-tree subsystem the bulk of files lives under."""
    if not files:
        return "unknown"
    buckets: dict[str, int] = {}
    for f in files:
        parts = f.path.split("/")
        head = parts[0] if parts else "root"
        buckets[head] = buckets.get(head, 0) + 1
    return max(buckets.items(), key=lambda kv: (kv[1], kv[0]))[0]


def _bucket_files(count: int) -> str:
    if count <= 1:
        return "1_file"
    if count <= 5:
        return "2-5_files"
    if count <= 15:
        return "6-15_files"
    return "16+_files"


def _bucket_size(size_bytes: int) -> str:
    if size_bytes < 5_000:
        return "small_<5KB"
    if size_bytes < 50_000:
        return "medium_5-50KB"
    return "large_50KB+"


# ── existing corpus ───────────────────────────────────────────────


def _existing_corpus() -> dict[str, dict[str, Any]]:
    """Read pr.json from each existing PR-*/ dir.

    Returns {pr_number: {change_shape, files_bucket, size_bucket, title}}
    for stratification — we want NEW PRs to fill UNDER-REPRESENTED buckets.
    """
    out: dict[str, dict[str, Any]] = {}
    if not GROUND_TRUTH_DIR.exists():
        return out
    for pr_dir in sorted(GROUND_TRUTH_DIR.iterdir()):
        if not pr_dir.is_dir():
            continue
        pr_json = pr_dir / "pr.json"
        if not pr_json.exists():
            continue
        try:
            blob = json.loads(pr_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        pr_number = str(blob.get("pr_number") or pr_dir.name.removeprefix("PR-"))
        files_count = blob.get("files_changed") or len(blob.get("files") or [])
        size_bytes = blob.get("diff_size_bytes") or 0
        out[pr_number] = {
            "title": blob.get("title", ""),
            "files_bucket": _bucket_files(int(files_count)),
            "size_bucket": _bucket_size(int(size_bytes)),
        }
    return out


# ── selection ──────────────────────────────────────────────────────


def _select(candidates: list[PrCandidate], existing: dict, target: int) -> None:
    """Greedy bucket-fill: keep adding the candidate that fills the
    most under-represented (change_shape, files_bucket, size_bucket)
    cell. Deterministic — sort_key tiebreaks by PR number.
    """
    # Start by counting existing-corpus coverage per change_shape (we
    # don't classify the existing 6 by shape here since their pr.json
    # doesn't carry it — treat them as baseline 'mixed' for fairness).
    shape_count: dict[str, int] = {}
    files_count: dict[str, int] = {}
    size_count: dict[str, int] = {}
    for meta in existing.values():
        files_count[meta["files_bucket"]] = files_count.get(meta["files_bucket"], 0) + 1
        size_count[meta["size_bucket"]] = size_count.get(meta["size_bucket"], 0) + 1

    # Hard-reject docs-only / test-only / empty / generated_or_config —
    # they don't validate the production-code scorer pipeline.
    HARD_REJECT = {"docs", "test_only", "empty", "generated_or_config"}
    pool: list[PrCandidate] = []
    for c in candidates:
        if c.change_shape in HARD_REJECT:
            c.rejection_reason = f"hard_reject:{c.change_shape}"
            continue
        # Reject empty diffs — git diff merge^1..merge can be empty for
        # ff-only or revert merges.
        if c.files_changed == 0 or c.diff_size_bytes < 200:
            c.rejection_reason = "rejected:empty_or_trivial_diff"
            continue
        pool.append(c)

    # Greedy fill. Score = sum of (1 / (1 + count_in_bucket)) for each
    # of the three bucket dimensions. Higher = fills more underrep cells.
    def score(c: PrCandidate) -> tuple[float, int]:
        s = 0.0
        s += 1.0 / (1.0 + shape_count.get(c.change_shape, 0))
        s += 1.0 / (1.0 + files_count.get(c.files_bucket, 0))
        s += 1.0 / (1.0 + size_count.get(c.size_bucket, 0))
        return (s, -int(c.pr_number))  # ties: prefer LARGER pr_number (recent)

    selected_count = 0
    # Make selection deterministic by working on a sorted-by-pr copy
    # so equal-score candidates are picked in the same order every run.
    pool_sorted = sorted(pool, key=lambda c: -int(c.pr_number))
    while selected_count < target and pool_sorted:
        best = max(pool_sorted, key=score)
        best.selected = True
        best.selection_rationale = (
            f"fills shape={best.change_shape} "
            f"(count_was={shape_count.get(best.change_shape, 0)}); "
            f"files_bucket={best.files_bucket} "
            f"(count_was={files_count.get(best.files_bucket, 0)}); "
            f"size_bucket={best.size_bucket} "
            f"(count_was={size_count.get(best.size_bucket, 0)})"
        )
        shape_count[best.change_shape] = shape_count.get(best.change_shape, 0) + 1
        files_count[best.files_bucket] = files_count.get(best.files_bucket, 0) + 1
        size_count[best.size_bucket] = size_count.get(best.size_bucket, 0) + 1
        pool_sorted.remove(best)
        selected_count += 1

    # Mark the rest as not-selected (with reason). Don't drop them —
    # the manifest's job is full audit trail.
    for c in pool_sorted:
        c.selection_rationale = "not_selected:bucket_fill_complete"


# ── main ───────────────────────────────────────────────────────────


def discover_candidates(flt_repo: Path, since: str) -> list[PrCandidate]:
    rows = _list_merge_commits(flt_repo, since)
    existing_numbers = set(_existing_corpus().keys())
    candidates: list[PrCandidate] = []
    for sha, authored, title in rows:
        pr_number = _parse_pr_number(title)
        if pr_number is None:
            continue
        if pr_number in existing_numbers:
            continue  # already in corpus
        try:
            files = _numstat(flt_repo, sha)
            size = _diff_size(flt_repo, sha)
        except RuntimeError:
            # Some merges have no diff against ^1 (octopus, ff). Skip.
            continue
        c = PrCandidate(
            pr_number=pr_number,
            merge_commit_sha=sha,
            title=title.strip(),
            authored_date=authored,
            files_changed=len(files),
            additions=sum(f.additions for f in files),
            deletions=sum(f.deletions for f in files),
            diff_size_bytes=size,
            change_shape=_classify_change_shape(files),
            subsystem=_subsystem(files),
            files=files,
            files_bucket=_bucket_files(len(files)),
            size_bucket=_bucket_size(size),
        )
        candidates.append(c)
    return candidates


def build_manifest(
    flt_repo: Path,
    since: str,
    target_additions: int,
) -> dict[str, Any]:
    candidates = discover_candidates(flt_repo, since)
    existing = _existing_corpus()
    _select(candidates, existing, target_additions)

    selected = [c for c in candidates if c.selected]
    rejected = [c for c in candidates if not c.selected]

    def _candidate_to_json(c: PrCandidate) -> dict[str, Any]:
        d = asdict(c)
        # Trim files list to keep manifest readable — full file list lives
        # in pr.json once capture runs.
        d["files"] = [asdict(f) for f in c.files[:10]]
        d["files_truncated"] = len(c.files) > 10
        return d

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "phase": "T4-C-prep",
        "flt_repo_path": str(flt_repo),
        "since_filter": since,
        "target_additions": target_additions,
        "discovered_count": len(candidates),
        "selected_count": len(selected),
        "rejected_count": len(rejected),
        "existing_corpus_size": len(existing),
        "existing_corpus_prs": sorted(existing.keys(), key=int),
        "selected": [_candidate_to_json(c) for c in selected],
        "rejected": [_candidate_to_json(c) for c in rejected],
        "notes": (
            "Selection methodology: stratified greedy bucket-fill across three "
            "diversity dimensions (change_shape, files_bucket, size_bucket). "
            "Hard-rejects: docs-only, test-only, generated_or_config, empty/trivial diffs. "
            "Tiebreaker for equal-score candidates: prefer larger pr_number (more recent). "
            "Deterministic: same FLT repo state + same flags yields byte-identical output. "
            "This is T4-C-prep — selection is curated, NOT yet graded. Each selected PR "
            "must pass curator hand-grading before its expected.json transitions from "
            "PENDING_HUMAN_GRADING to GRADED_PASS_1 and joins the scored corpus."
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Pick FLT PR candidates for gold-corpus expansion (T4-C-prep).")
    ap.add_argument(
        "--flt-repo", type=Path, default=DEFAULT_FLT_REPO, help=f"Path to local FLT clone (default: {DEFAULT_FLT_REPO})"
    )
    ap.add_argument("--since", default="2 months ago", help="git log --since filter (default: '2 months ago')")
    ap.add_argument(
        "--target-additions", type=int, default=9, help="Number of new PRs to pick (default: 9 -> total corpus 15)"
    )
    ap.add_argument(
        "--output", type=Path, default=DEFAULT_OUTPUT, help=f"Manifest output path (default: {DEFAULT_OUTPUT})"
    )
    args = ap.parse_args()

    if not args.flt_repo.exists():
        print(f"ERROR: FLT repo not found at {args.flt_repo}", file=sys.stderr)
        return 2

    manifest = build_manifest(args.flt_repo, args.since, args.target_additions)
    args.output.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Discovered: {manifest['discovered_count']}")
    print(f"Selected:   {manifest['selected_count']}")
    print(f"Rejected:   {manifest['rejected_count']}")
    print(f"Wrote:      {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
