"""F27 P9 T1f-a — deterministic gold-corpus scorer.

The eval harness's first scoring station. Reads hand-graded
``expected.json`` (curator's ideal scenario set) and ``actual.json``
(scenarios the V2 pipeline emitted on the same PR), matches them by
``(category, verb, changed-line-overlap)`` PRIMARY key, and emits
per-PR + aggregate recall / precision / F1.

Design notes (Sentinel-approved 2026-05-18):

- **Deterministic-first.** No LLM-as-judge in this slice. The LLM-judge
  ensemble lands in T1f-d; the deterministic floor is the regression
  gate that doesn't depend on the very models we're measuring.

- **Match key is ``(category, verb, changed-line overlap > 0)``.** Topic
  strings are free-text from the LLM and brittle to compare; categories
  and verbs are constrained enumerations. Changed-line overlap (NOT
  same-file overlap) is the grounding gate: an actual scenario must
  cite at least one of the expected scenario's changed lines to count
  as a match. Same-file-different-line evidence is treated as a miss.

- **Tiebreaker is max changed-line overlap count.** When multiple
  actuals match one expected on (category, verb), the actual with the
  largest changed-line overlap wins; the others remain unmatched and
  contribute to a precision penalty.

- **Two-pass curator discipline.** Each expected scenario carries a
  ``discovered_by`` field: ``diff_inspection`` for pass-1 blind grades,
  ``v2_review`` for items added in pass-2 (only when the curator
  agrees they should have been written from the diff alone).

- **Acceptance floors are configurable.** ``score_floors.json`` carries
  both absolute floors (``corpus_recall_min`` etc.) and regression
  guards (``max_recall_drop`` vs the last committed baseline). The
  ``enforcement`` key controls whether ``--strict`` exits non-zero.

- **Macro-average headline; micro-average reported.** Each PR is
  weighted equally in the corpus-level recall/precision. Micro
  (each scenario weighted equally) is reported as a secondary metric.

- **Precision is reported separately for each pipeline stage**:
  ``emitted`` (what the Editor produced before validation),
  ``validated`` (what survived the Validator + Projector — headline
  metric, this is what would be shown to a user), and ``projected``
  (alias of validated for now; the engine-format conversion stage
  doesn't filter further but the slot is reserved for future stages).

Run from the edog-studio repo root::

    python tests/qa-eval/score_eval.py             # human-readable
    python tests/qa-eval/score_eval.py --json      # machine-readable
    python tests/qa-eval/score_eval.py --strict    # exit 1 if floors fail
    python tests/qa-eval/score_eval.py --output report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"
FLOORS_PATH = REPO_ROOT / "tests" / "qa-eval" / "score_floors.json"
ALIASES_PATH = REPO_ROOT / "tests" / "qa-eval" / "topic_aliases.json"
BASELINE_PATH = REPO_ROOT / "tests" / "qa-eval" / "baseline.json"

# ─── Domain enumerations ──────────────────────────────────────────────────
# Mirrors src/backend/DevMode/EdogQaModels.cs ScenarioCategory + ExpectationType.
# Kept in lock-step with the C# enums by tests/test_qa_eval_score.py — if the
# C# enum gains/loses a value, the source-grep test fires and forces an update
# here BEFORE the curator regrades any expected.json.

VALID_CATEGORIES = frozenset(
    {
        "HappyPath",
        "ErrorPath",
        "EdgeCase",
        "Regression",
        "Performance",
    }
)

# 'verb' on the gold-corpus side maps to the primary ExpectationType the
# scenario asserts. The matcher uses this as the secondary key after
# category, before grounding-overlap as the tiebreaker.
VALID_VERBS = frozenset(
    {
        "EventPresent",
        "EventAbsent",
        "EventCount",
        "EventOrder",
        "Timing",
        "FieldMatch",
    }
)

VALID_CRITICALITIES = frozenset({"P0", "P1", "P2"})
VALID_DISCOVERY = frozenset({"diff_inspection", "v2_review"})
VALID_STAGES = frozenset({"emitted", "validated", "projected"})

# ─── Schemas + dataclasses ────────────────────────────────────────────────


@dataclass(frozen=True)
class ChangedLineSet:
    """Grounding bound: file path (case-insensitive compare on Windows) +
    side (``left``/``right``) + a frozenset of changed line numbers."""

    path: str
    side: str
    lines: frozenset[int]

    def overlap(self, other: ChangedLineSet) -> int:
        """Return the count of shared changed-line numbers when paths +
        sides match, else 0. Path comparison is case-insensitive because
        diff producers emit different casings on Windows clones."""
        if self.path.lower() != other.path.lower():
            return 0
        if self.side != other.side:
            return 0
        return len(self.lines & other.lines)


@dataclass
class ExpectedScenario:
    """A curator-graded scenario; the gold-truth side of the match."""

    id: str
    behavior_key: str
    category: str
    verb: str
    title: str
    grounding: list[ChangedLineSet]
    criticality: str
    discovered_by: str
    rationale: str

    @classmethod
    def from_json(cls, blob: dict[str, Any]) -> ExpectedScenario:
        grounding = [
            ChangedLineSet(
                path=g["path"],
                side=g.get("side", "right"),
                lines=frozenset(int(line) for line in g["lines"]),
            )
            for g in blob.get("grounding_changed_lines", [])
        ]
        return cls(
            id=str(blob.get("id", "")),
            behavior_key=str(blob.get("behavior_key", "")),
            category=str(blob.get("category", "")),
            verb=str(blob.get("verb", "")),
            title=str(blob.get("title", "")),
            grounding=grounding,
            criticality=str(blob.get("criticality", "P2")),
            discovered_by=str(blob.get("discovered_by", "diff_inspection")),
            rationale=str(blob.get("rationale", "")),
        )

    def validate(self, prefix: str) -> list[str]:
        errors: list[str] = []
        if not self.id:
            errors.append(f"{prefix}: empty id")
        if self.category not in VALID_CATEGORIES:
            errors.append(f"{prefix}: invalid category {self.category!r}")
        if self.verb not in VALID_VERBS:
            errors.append(f"{prefix}: invalid verb {self.verb!r}")
        if self.criticality not in VALID_CRITICALITIES:
            errors.append(
                f"{prefix}: invalid criticality {self.criticality!r}",
            )
        if self.discovered_by not in VALID_DISCOVERY:
            errors.append(
                f"{prefix}: invalid discovered_by {self.discovered_by!r}",
            )
        if not self.grounding:
            errors.append(f"{prefix}: at least one grounding_changed_lines entry required")
        for gi, g in enumerate(self.grounding):
            if g.side not in {"left", "right"}:
                errors.append(f"{prefix}: grounding[{gi}].side must be 'left' or 'right'")
            if not g.lines:
                errors.append(f"{prefix}: grounding[{gi}].lines is empty")
        return errors


@dataclass
class ActualScenario:
    """A scenario the V2 pipeline emitted; the actual side of the match.

    Fields mirror the canonical ``Scenario`` shape from
    ``EdogQaModels.cs`` after ``EdogQaScenarioProjector``."""

    id: str
    topic: str
    category: str
    verb: str
    grounding: list[ChangedLineSet]
    stage: str  # one of VALID_STAGES — which pipeline gate this scenario passed

    @classmethod
    def from_json(cls, blob: dict[str, Any]) -> ActualScenario:
        grounding = [
            ChangedLineSet(
                path=g["path"],
                side=g.get("side", "right"),
                lines=frozenset(int(line) for line in g.get("lines", [])),
            )
            for g in blob.get("grounding_changed_lines", [])
        ]
        return cls(
            id=str(blob.get("id", "")),
            topic=str(blob.get("topic", "")),
            category=str(blob.get("category", "")),
            verb=str(blob.get("verb", "")),
            grounding=grounding,
            stage=str(blob.get("stage", "validated")),
        )


@dataclass
class MatchPair:
    expected: ExpectedScenario
    actual: ActualScenario
    overlap_count: int


@dataclass
class PrScore:
    pr_number: str
    expected_total: int
    actual_total_by_stage: dict[str, int]
    matched: list[MatchPair] = field(default_factory=list)
    missed_expected: list[ExpectedScenario] = field(default_factory=list)
    unmatched_actual: list[ActualScenario] = field(default_factory=list)

    # Computed at the end of `score_pr`.
    recall: float = 0.0
    precision_by_stage: dict[str, float] = field(default_factory=dict)
    f1_validated: float = 0.0
    p0_p1_recall: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "pr_number": self.pr_number,
            "expected_total": self.expected_total,
            "actual_total": self.actual_total_by_stage,
            "matched_count": len(self.matched),
            "missed_expected_ids": [m.id for m in self.missed_expected],
            "unmatched_actual_ids": [a.id for a in self.unmatched_actual],
            "recall": round(self.recall, 4),
            "precision": {k: round(v, 4) for k, v in self.precision_by_stage.items()},
            "f1_validated": round(self.f1_validated, 4),
            "p0_p1_recall": round(self.p0_p1_recall, 4),
        }


# ─── Loaders ──────────────────────────────────────────────────────────────


def load_expected(pr_dir: Path) -> tuple[str | None, list[ExpectedScenario], list[str]]:
    """Return (curator_state, scenarios, errors).

    Backward compatible with the v1.0 scaffold shape
    ``{schema_version: '1.0', curator: 'PENDING_HUMAN_GRADING', scenarios: []}``:
    that returns ``curator_state='PENDING_HUMAN_GRADING'`` and empty
    scenarios — a PR in that state is excluded from corpus aggregates
    (skipped) and reported separately.
    """
    expected_path = pr_dir / "expected.json"
    if not expected_path.exists():
        return None, [], [f"{pr_dir.name}: expected.json missing"]
    with expected_path.open(encoding="utf-8") as fh:
        blob = json.load(fh)

    schema_version = str(blob.get("schema_version", "1.0"))
    if schema_version not in {"1.0", "2.0"}:
        return None, [], [f"{pr_dir.name}: unsupported schema_version {schema_version!r}"]

    if schema_version == "1.0":
        # T0/T1a scaffold — no graded scenarios, return placeholder state.
        curator_state = str(blob.get("curator", "PENDING_HUMAN_GRADING"))
        return curator_state, [], []

    curator_state = str(blob.get("curator_state", "PENDING_HUMAN_GRADING"))
    scenarios: list[ExpectedScenario] = []
    errors: list[str] = []
    for i, s_blob in enumerate(blob.get("scenarios", [])):
        s = ExpectedScenario.from_json(s_blob)
        errors.extend(s.validate(prefix=f"{pr_dir.name}.expected[{i}]"))
        scenarios.append(s)
    return curator_state, scenarios, errors


def load_actual(pr_dir: Path) -> tuple[list[ActualScenario], list[str]]:
    """Return (actuals, errors).

    Actuals come from ``capture_v2_actuals.py`` (operator script, T1f-b
    slice) which dumps the V2 pipeline's emitted scenarios to
    ``actual.json`` in the same directory as ``expected.json``. Missing
    ``actual.json`` is not an error here — it just means the PR has no
    measured score yet.
    """
    actual_path = pr_dir / "actual.json"
    if not actual_path.exists():
        return [], []
    with actual_path.open(encoding="utf-8") as fh:
        blob = json.load(fh)
    actuals: list[ActualScenario] = []
    errors: list[str] = []
    for i, s_blob in enumerate(blob.get("scenarios", [])):
        a = ActualScenario.from_json(s_blob)
        if a.stage not in VALID_STAGES:
            errors.append(
                f"{pr_dir.name}.actual[{i}].stage {a.stage!r} not in {sorted(VALID_STAGES)}",
            )
        actuals.append(a)
    return actuals, errors


# ─── Matcher ──────────────────────────────────────────────────────────────


def _max_overlap(expected: ExpectedScenario, actual: ActualScenario) -> int:
    """Maximum changed-line overlap across all grounding pairs.

    Returns 0 if no path+side pair matches. This is the deterministic
    grounding gate: an actual scenario that cites the same file but
    different changed lines than expected gets overlap=0 and is
    treated as a miss for that expected scenario."""
    best = 0
    for e_g in expected.grounding:
        for a_g in actual.grounding:
            best = max(best, e_g.overlap(a_g))
    return best


def match_scenarios(
    expected: list[ExpectedScenario],
    actuals: list[ActualScenario],
) -> tuple[list[MatchPair], list[ExpectedScenario], list[ActualScenario]]:
    """Greedy max-overlap match by ``(category, verb)`` then changed-line overlap.

    Returns ``(matched, missed_expected, unmatched_actual)`` where matched
    is a list of ``MatchPair``, missed_expected is the subset of expected
    that found no compatible actual, and unmatched_actual is the subset of
    actuals not consumed by any match (false-positive precision penalty)."""
    used_actual: set[int] = set()
    matched: list[MatchPair] = []
    missed: list[ExpectedScenario] = []

    # We iterate expected in declared order (so PRs can pin a stable preferred
    # match order if two expecteds compete for the same actual — first declared wins).
    for e in expected:
        # Candidate pool: actuals with same category + verb + unused.
        best_idx = -1
        best_overlap = 0
        for ai, a in enumerate(actuals):
            if ai in used_actual:
                continue
            if a.category != e.category:
                continue
            if a.verb != e.verb:
                continue
            overlap = _max_overlap(e, a)
            if overlap > best_overlap:
                best_overlap = overlap
                best_idx = ai
        if best_idx >= 0:
            matched.append(MatchPair(expected=e, actual=actuals[best_idx], overlap_count=best_overlap))
            used_actual.add(best_idx)
        else:
            missed.append(e)

    unmatched = [a for ai, a in enumerate(actuals) if ai not in used_actual]
    return matched, missed, unmatched


# ─── Scoring ──────────────────────────────────────────────────────────────


def _safe_div(num: float, den: float) -> float:
    return num / den if den > 0 else 0.0


def score_pr(
    pr_number: str,
    expected: list[ExpectedScenario],
    actuals: list[ActualScenario],
) -> PrScore:
    matched, missed, unmatched = match_scenarios(expected, actuals)

    actual_by_stage: dict[str, int] = {stage: 0 for stage in VALID_STAGES}
    for a in actuals:
        if a.stage in actual_by_stage:
            actual_by_stage[a.stage] += 1

    matched_per_stage: dict[str, int] = {stage: 0 for stage in VALID_STAGES}
    for m in matched:
        if m.actual.stage in matched_per_stage:
            matched_per_stage[m.actual.stage] += 1

    expected_total = len(expected)
    recall = _safe_div(len(matched), expected_total)

    # Precision per stage: matched ÷ actuals-at-or-above-that-stage. Since
    # 'projected' ⊆ 'validated' ⊆ 'emitted' in semantic order, we compute
    # precision against each stage's actual count separately so a precision
    # drop at the 'validated' stage signals the Validator is letting too
    # much through. Today we tag each actual scenario with exactly one
    # stage = where in the pipeline it lives; the headline is 'validated'.
    precision: dict[str, float] = {
        stage: _safe_div(matched_per_stage[stage], actual_by_stage[stage])
        for stage in VALID_STAGES
    }

    # F1 on the headline (validated) stage.
    val_p = precision["validated"]
    f1 = _safe_div(2 * val_p * recall, val_p + recall) if (val_p + recall) > 0 else 0.0

    # P0+P1 recall — must-pass criticality bucket.
    p0_p1_expected = [e for e in expected if e.criticality in {"P0", "P1"}]
    p0_p1_matched = [
        m for m in matched if m.expected.criticality in {"P0", "P1"}
    ]
    p0_p1_recall = _safe_div(len(p0_p1_matched), len(p0_p1_expected))

    return PrScore(
        pr_number=pr_number,
        expected_total=expected_total,
        actual_total_by_stage=actual_by_stage,
        matched=matched,
        missed_expected=missed,
        unmatched_actual=unmatched,
        recall=recall,
        precision_by_stage=precision,
        f1_validated=f1,
        p0_p1_recall=p0_p1_recall,
    )


def aggregate(pr_scores: list[PrScore]) -> dict[str, Any]:
    if not pr_scores:
        return {
            "pr_count": 0,
            "macro": {"recall": 0.0, "precision_validated": 0.0, "f1_validated": 0.0, "p0_p1_recall": 0.0},
            "micro": {"recall": 0.0, "precision_validated": 0.0},
        }

    # Macro: each PR weighted equally.
    macro_recall = sum(p.recall for p in pr_scores) / len(pr_scores)
    macro_prec = sum(p.precision_by_stage["validated"] for p in pr_scores) / len(pr_scores)
    macro_f1 = sum(p.f1_validated for p in pr_scores) / len(pr_scores)
    macro_p0 = sum(p.p0_p1_recall for p in pr_scores) / len(pr_scores)

    # Micro: each scenario weighted equally.
    total_expected = sum(p.expected_total for p in pr_scores)
    total_matched = sum(len(p.matched) for p in pr_scores)
    total_validated_actual = sum(p.actual_total_by_stage["validated"] for p in pr_scores)
    total_matched_validated = sum(
        len([m for m in p.matched if m.actual.stage == "validated"]) for p in pr_scores
    )

    return {
        "pr_count": len(pr_scores),
        "macro": {
            "recall": round(macro_recall, 4),
            "precision_validated": round(macro_prec, 4),
            "f1_validated": round(macro_f1, 4),
            "p0_p1_recall": round(macro_p0, 4),
        },
        "micro": {
            "recall": round(_safe_div(total_matched, total_expected), 4),
            "precision_validated": round(
                _safe_div(total_matched_validated, total_validated_actual), 4
            ),
        },
    }


# ─── Floor enforcement ────────────────────────────────────────────────────


def load_floors() -> dict[str, Any]:
    if not FLOORS_PATH.exists():
        return {"absolute": {}, "regression": {}, "enforcement": "report_only"}
    with FLOORS_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def evaluate_floors(
    aggregate_blob: dict[str, Any],
    floors: dict[str, Any],
    pr_scores: list[PrScore],
) -> tuple[str, list[str]]:
    """Return ``('PASS' | 'DEGRADED' | 'FAIL', violations)``.

    ``DEGRADED`` means at least one regression-guard tripped but no
    absolute floor breached. ``FAIL`` means at least one absolute floor
    breached. Regression guards require a prior baseline.json with
    aggregate numbers; absent prior baseline = no regression check."""
    absolute = floors.get("absolute", {})
    violations: list[str] = []

    macro = aggregate_blob.get("macro", {})
    if macro.get("recall", 0.0) < absolute.get("corpus_recall_min", 0.0):
        violations.append(
            f"corpus_recall {macro.get('recall', 0.0)} < min {absolute['corpus_recall_min']}",
        )
    if macro.get("precision_validated", 0.0) < absolute.get("corpus_precision_min", 0.0):
        violations.append(
            f"corpus_precision_validated {macro.get('precision_validated', 0.0)} "
            f"< min {absolute['corpus_precision_min']}",
        )
    if macro.get("p0_p1_recall", 0.0) < absolute.get("p0_p1_recall_min", 0.0):
        violations.append(
            f"corpus_p0_p1_recall {macro.get('p0_p1_recall', 0.0)} "
            f"< min {absolute['p0_p1_recall_min']}",
        )
    for p in pr_scores:
        if p.recall < absolute.get("per_pr_recall_min", 0.0):
            violations.append(
                f"PR-{p.pr_number} recall {p.recall} < per_pr min {absolute['per_pr_recall_min']}",
            )

    if violations:
        return "FAIL", violations
    return "PASS", []


# ─── CLI ─────────────────────────────────────────────────────────────────


def discover_pr_dirs() -> list[Path]:
    if not GROUND_TRUTH.exists():
        return []
    return sorted(
        d for d in GROUND_TRUTH.iterdir() if d.is_dir() and d.name.startswith("PR-")
    )


def build_report(pr_dirs: list[Path]) -> dict[str, Any]:
    pr_scores: list[PrScore] = []
    pending_grading: list[str] = []
    ungraded: list[str] = []
    schema_errors: list[str] = []

    for pr_dir in pr_dirs:
        pr_number = pr_dir.name.removeprefix("PR-")
        curator_state, expected, errs = load_expected(pr_dir)
        schema_errors.extend(errs)

        if curator_state in {"PENDING_HUMAN_GRADING", None}:
            pending_grading.append(pr_number)
            continue
        if not expected:
            ungraded.append(pr_number)
            continue

        actuals, a_errs = load_actual(pr_dir)
        schema_errors.extend(a_errs)
        pr_scores.append(score_pr(pr_number, expected, actuals))

    agg = aggregate(pr_scores)
    floors = load_floors()
    verdict, violations = evaluate_floors(agg, floors, pr_scores)

    return {
        "schema_version": "1.0",
        "verdict": verdict,
        "floor_violations": violations,
        "enforcement": floors.get("enforcement", "report_only"),
        "aggregate": agg,
        "prs_scored": [p.to_json() for p in pr_scores],
        "prs_pending_grading": pending_grading,
        "prs_ungraded": ungraded,
        "schema_errors": schema_errors,
    }


def print_human(report: dict[str, Any]) -> None:
    agg = report["aggregate"]
    print(f"F27 P9 eval report — verdict: {report['verdict']}")
    print(f"  PRs scored: {agg['pr_count']}")
    print(f"  PRs pending grading: {len(report['prs_pending_grading'])}")
    print(f"  PRs ungraded (schema=2.0, scenarios=[]): {len(report['prs_ungraded'])}")
    print()
    print("  Macro-average (each PR weighted equally):")
    print(f"    recall:               {agg['macro']['recall']:.3f}")
    print(f"    precision (validated): {agg['macro']['precision_validated']:.3f}")
    print(f"    F1 (validated):       {agg['macro']['f1_validated']:.3f}")
    print(f"    P0+P1 recall:         {agg['macro']['p0_p1_recall']:.3f}")
    print()
    print("  Micro-average (each scenario weighted equally):")
    print(f"    recall:               {agg['micro']['recall']:.3f}")
    print(f"    precision (validated): {agg['micro']['precision_validated']:.3f}")
    print()
    if report["floor_violations"]:
        print("  Floor violations:")
        for v in report["floor_violations"]:
            print(f"    - {v}")
        print()
    if report["schema_errors"]:
        print("  Schema errors:")
        for e in report["schema_errors"][:10]:
            print(f"    - {e}")
        if len(report["schema_errors"]) > 10:
            print(f"    ... and {len(report['schema_errors']) - 10} more")
        print()
    print("  Per-PR detail:")
    for pr in report["prs_scored"]:
        print(
            f"    PR-{pr['pr_number']}: "
            f"recall={pr['recall']:.3f} "
            f"precision_validated={pr['precision']['validated']:.3f} "
            f"p0_p1_recall={pr['p0_p1_recall']:.3f} "
            f"expected={pr['expected_total']} actual_validated={pr['actual_total']['validated']}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="F27 P9 deterministic gold-corpus scorer")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero if verdict != PASS (overrides 'report_only' enforcement)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="write report JSON to this path (in addition to stdout)",
    )
    args = parser.parse_args(argv)

    pr_dirs = discover_pr_dirs()
    if not pr_dirs:
        print(f"No PR fixtures found under {GROUND_TRUTH}", file=sys.stderr)
        return 2

    report = build_report(pr_dirs)

    if args.output is not None:
        args.output.write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    if args.json:
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        print_human(report)

    floors = load_floors()
    enforcement = floors.get("enforcement", "report_only")
    if (args.strict or enforcement == "strict") and report["verdict"] != "PASS":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
