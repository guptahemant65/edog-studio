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
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH = REPO_ROOT / "tests" / "qa-eval" / "ground-truth"
FLOORS_PATH = REPO_ROOT / "tests" / "qa-eval" / "score_floors.json"
ALIASES_PATH = REPO_ROOT / "tests" / "qa-eval" / "topic_aliases.json"
BASELINE_PATH = REPO_ROOT / "tests" / "qa-eval" / "baseline.json"

# ─── T1i: deterministic span expansion ────────────────────────────────────
# The V2 Architect anchors `evidence.newLine` at the first line of a `+` hunk
# run (e.g. line 185 for a behaviour whose curator-graded body lives at lines
# 193-198). Three rounds of T1h prompt-tuning failed to override this bias.
# T1i compensates by deriving an *effective* line span at score time:
#     effective = {newLine, newLine+1, ..., min(newLine + N, hunk_end)}
# where the bound `hunk_end` is the last new-line number of the unified-diff
# hunk that contains `newLine` (so expansion never bridges unrelated regions).
#
# A 2-tier overlap tiebreaker — prefer matches with original-line overlap over
# matches that only land via expansion — preserves the pre-T1i baseline pair
# set, eliminating greedy-reallocation "pair theft" that would otherwise count
# as a no-op in aggregate but trade one semantically-correct match for another.
#
# Shadow-eval (commit b037c59 + 3-PR corpus) at T1i selected N=5 as the
# greedy-safe knee. T1j replaces greedy with global bipartite matching
# (see MATCHER_DEFAULT below) and the safe knee moves up to N=15:
#     N=0    → recall 0.542 / prec_highest 0.613  (pre-T1i baseline)
#     N=3-10 → recall 0.583 / prec_highest 0.661  (+0.042 / +0.048)
#     N=15+  → recall 0.639 / prec_highest 0.716  (+0.097 / +0.103) ← chosen
# At N=15+ PR-976609 unlocks one additional match (s05) that requires
# expansion past N=10. N=20/30 saturate at the same values. Bipartite
# guarantees no greedy-reallocation pair theft, so the N=15 lift is real
# (not the "1 stolen pair" artifact T1i shadow flagged for greedy).

SPAN_EXPANSION_DEFAULT_N = 15

# ─── T1j: global bipartite matcher ────────────────────────────────────────
# The T1i 2-tier overlap tiebreaker stops greedy-reallocation pair theft only
# while iteration order is over expected. At N >= 7 a different expected E'
# earlier in expected.json could claim an actual A before E gets a chance —
# even though E would have had a strictly higher (orig, exp) tuple on A. T1j
# replaces the greedy `iterate-over-expected` loop with a globally optimal
# maximum-weight bipartite matching (scipy.optimize.linear_sum_assignment).
#
# The objective is CARDINALITY-FIRST then ORIGINAL-OVERLAP then EXPANDED-OVERLAP
# then a deterministic tiebreaker on declared order. Cardinality must dominate
# overlap totals so the matcher never trades two weak matches for one strong
# match (which would reduce recall). Tier bases are sized against matrix-wide
# totals (not per-cell) so the dominance holds when summed across all
# assignments:
#
#     CARD_BASE   > T * MAX_ORIG * ORIG_BASE       (T ≤ matrix dim ≤ 200)
#     ORIG_BASE   > T * MAX_EXP  * EXP_BASE
#     EXP_BASE    > T * MAX_TIE
#     MAX_TIE     ≈ 1e6 (e_idx, a_idx ≤ 999)
#
# Forbidden cells (category/verb mismatch OR exp_overlap = 0) get weight 0 —
# no cardinality bonus AND no tiebreaker so they can never be picked over a
# valid match. Post-assignment we discard any pair with weight 0, which
# correctly handles the case where scipy assigns a forbidden cell to satisfy
# matrix dimensions (e.g. |E| > |A|).
#
# Default matcher = "bipartite". The legacy "greedy" matcher is retained
# behind `--matcher greedy` for audit-trail reproducibility of T1i scores.

MATCHER_DEFAULT = "bipartite"
MATCHER_CHOICES = ("bipartite", "greedy")

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


# ─── T4-A: category-cluster matcher calibration ───────────────────────────
# The T4-A matcher sensitivity audit (offline, zero LLM cost) measured a
# +19 pp macro_recall gap between strict category matching and category-
# relaxed matching on the n=6 gold corpus (0.577 -> 0.767). 11/11 newly-
# recovered pairs hand-validated as TRUE semantic equivalents — pairs
# where the LLM grounds at the same file/line as the curator but
# classifies the scenario through a different lens:
#   curator's labels: describe WHAT BEHAVIOR is being tested
#                     ("declares MLV_DATA_CORRUPTED enum" = HappyPath
#                      because adding a constant is a nominal-flow contract)
#   Architect labels: describe WHAT KIND OF CODE PATH the diff introduces
#                     (the same line, new-error-code-added, is EdgeCase
#                      or ErrorPath through the diff lens)
# Both lenses are legitimate. The matcher's job is scenario-level
# equivalence, so {HappyPath, EdgeCase, ErrorPath, Regression} cluster
# into one "behavioral" key for match purposes. ``Performance`` stays in
# its own cluster (structurally different — latency/throughput
# assertion, not behaviour).
#
# Category LABEL accuracy is reported separately (``category_label_accuracy``)
# so we still see if Architect picks the curator's exact label across
# matched pairs.
#
# Pass ``--strict-category`` to disable the cluster and reproduce
# pre-T4-A audit-trail scores byte-for-byte.

_CATEGORY_ALIASES_PATH = REPO_ROOT / "tests" / "qa-eval" / "category_aliases.json"


def _load_category_clusters() -> dict[str, str]:
    """Build a {category_label: cluster_id} map from category_aliases.json.

    The JSON shape:
        {"clusters": {"behavioral": ["HappyPath", "EdgeCase", ...], ...}}
    Every category in VALID_CATEGORIES must appear in exactly one cluster.
    """
    if not _CATEGORY_ALIASES_PATH.exists():
        return {c: c for c in VALID_CATEGORIES}
    with _CATEGORY_ALIASES_PATH.open(encoding="utf-8") as fh:
        blob = json.load(fh)
    clusters = blob.get("clusters", {})
    mapping: dict[str, str] = {}
    for cluster_id, members in clusters.items():
        for label in members:
            mapping[label] = cluster_id
    return mapping


_CATEGORY_CLUSTER = _load_category_clusters()


def _category_key(category: str, *, strict: bool = False) -> str:
    """Return the matcher-side category key.

    Default uses the cluster id from ``category_aliases.json``;
    ``strict=True`` falls back to the raw label (pre-T4-A behaviour)."""
    if strict:
        return category
    return _CATEGORY_CLUSTER.get(category, category)


# ─── Verb enumeration (matcher secondary key) ─────────────────────────────

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
    side (``left``/``right``) + a frozenset of changed line numbers.

    T1i adds ``original_lines``: when the scorer applies hunk-bounded forward
    span expansion, ``lines`` carries the *effective* (expanded) span used for
    overlap and ``original_lines`` carries the pre-expansion set. The 2-tier
    overlap tiebreaker uses both: prefer matches with original-line overlap
    over matches that only land via expansion."""

    path: str
    side: str
    lines: frozenset[int]
    original_lines: frozenset[int] = frozenset()

    def __post_init__(self) -> None:
        # When original_lines isn't supplied (expected-side or legacy callers),
        # treat the effective set as the original set so 2-tier overlap reduces
        # to the pre-T1i single-tier behaviour.
        if not self.original_lines:
            object.__setattr__(self, "original_lines", self.lines)

    def overlap(self, other: ChangedLineSet) -> int:
        """Return the count of shared changed-line numbers when paths +
        sides match, else 0. Path comparison is case-insensitive because
        diff producers emit different casings on Windows clones."""
        if self.path.lower() != other.path.lower():
            return 0
        if self.side != other.side:
            return 0
        return len(self.lines & other.lines)

    def overlap_tiered(self, other: ChangedLineSet) -> tuple[int, int]:
        """Return ``(original_overlap, expanded_overlap)``. Both are 0 when
        paths or sides differ. The greedy matcher uses tuple comparison so
        ``(1, 3)`` beats ``(0, 8)`` — a single original-line match outranks
        any number of expansion-only matches, which preserves baseline pairs
        across span-expansion changes (no greedy reallocation pair theft)."""
        if self.path.lower() != other.path.lower():
            return (0, 0)
        if self.side != other.side:
            return (0, 0)
        return (
            len(self.original_lines & other.original_lines),
            len(self.lines & other.lines),
        )


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
    overlap_count: int  # effective (expanded) overlap — backward-compat field
    original_overlap_count: int = 0  # T1i: pre-expansion overlap (tiebreaker tier 1)


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
    precision_highest_stage: float = 0.0
    f1_validated: float = 0.0
    f1_highest_stage: float = 0.0
    p0_p1_recall: float = 0.0
    # T4-A diagnostic: of MATCHED pairs, what fraction agree on the raw
    # category label (HappyPath vs EdgeCase etc.)?  When the matcher
    # clusters categories, this stays as a separate quality lens so we
    # still see if the Architect is picking the curator's exact label.
    category_label_accuracy: float = 0.0

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
            "precision_highest_stage": round(self.precision_highest_stage, 4),
            "f1_validated": round(self.f1_validated, 4),
            "f1_highest_stage": round(self.f1_highest_stage, 4),
            "p0_p1_recall": round(self.p0_p1_recall, 4),
            "category_label_accuracy": round(self.category_label_accuracy, 4),
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


def load_actual(
    pr_dir: Path,
    span_expansion_n: int = SPAN_EXPANSION_DEFAULT_N,
) -> tuple[list[ActualScenario], list[str]]:
    """Return (actuals, errors).

    Actuals come from ``capture_v2_actuals.py`` (operator script, T1f-b
    slice) which dumps the V2 pipeline's emitted scenarios to
    ``actual.json`` in the same directory as ``expected.json``. Missing
    ``actual.json`` is not an error here — it just means the PR has no
    measured score yet.

    T1i (``span_expansion_n > 0``): each right-side grounding entry's
    line set is forward-expanded by up to ``span_expansion_n`` lines,
    bounded by the unified-diff hunk that contains the original anchor
    line. The original (pre-expansion) line set is preserved on
    ``ChangedLineSet.original_lines`` so the matcher can apply a 2-tier
    overlap tiebreaker. ``span_expansion_n=0`` is the pre-T1i behaviour.
    """
    actual_path = pr_dir / "actual.json"
    if not actual_path.exists():
        return [], []
    with actual_path.open(encoding="utf-8") as fh:
        blob = json.load(fh)

    hunks: dict[str, list[tuple[int, int]]] = {}
    if span_expansion_n > 0:
        hunks = _load_diff_hunks(pr_dir)

    actuals: list[ActualScenario] = []
    errors: list[str] = []
    for i, s_blob in enumerate(blob.get("scenarios", [])):
        a = ActualScenario.from_json(s_blob)
        if a.stage not in VALID_STAGES:
            errors.append(
                f"{pr_dir.name}.actual[{i}].stage {a.stage!r} not in {sorted(VALID_STAGES)}",
            )
        if span_expansion_n > 0 and hunks:
            a.grounding = _expand_grounding(a.grounding, hunks, span_expansion_n)
        actuals.append(a)
    return actuals, errors


# ─── T1i: diff-hunk parsing + forward span expansion ─────────────────────


_HUNK_HEADER_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def _load_diff_hunks(pr_dir: Path) -> dict[str, list[tuple[int, int]]]:
    """Parse ``diff.patch`` in ``pr_dir`` into ``{path_lower: [(new_start, new_len), ...]}``.

    Path keys are lower-cased to match ``ChangedLineSet`` Windows case-fold
    semantics. Hunk entries are unified-diff ``@@ -A,B +C,D @@`` headers
    interpreted as: the new file gains a span of ``D`` lines starting at
    line number ``C``. Zero-length (``+C,0``) hunks (pure deletions) are
    skipped because they contribute no right-side anchor lines.

    Missing diff.patch returns an empty dict; expansion silently no-ops on
    files not present in the diff (defensive: an architect-emitted evidence
    line outside any hunk is left at its original anchor)."""
    diff_path = pr_dir / "diff.patch"
    if not diff_path.exists():
        return {}
    hunks: dict[str, list[tuple[int, int]]] = defaultdict(list)
    current_path: str | None = None
    with diff_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("+++ b/"):
                current_path = line[6:].strip().lower()
                continue
            if line.startswith("+++ /dev/null"):
                current_path = None
                continue
            if line.startswith("+++ "):
                current_path = line[4:].strip().lower()
                continue
            if current_path is None:
                continue
            m = _HUNK_HEADER_RE.match(line)
            if m:
                new_start = int(m.group(1))
                new_len = int(m.group(2)) if m.group(2) else 1
                if new_len > 0:
                    hunks[current_path].append((new_start, new_len))
    return dict(hunks)


def _expand_grounding(
    grounding: list[ChangedLineSet],
    hunks: dict[str, list[tuple[int, int]]],
    n: int,
) -> list[ChangedLineSet]:
    """Return a parallel list with each right-side entry's ``lines`` forward-expanded.

    Only ``side='right'`` entries are expanded — left-side (deletion)
    expansion has no equivalent semantic boundary in the new file. The
    original line set is preserved on ``ChangedLineSet.original_lines``.
    """
    out: list[ChangedLineSet] = []
    for g in grounding:
        if g.side != "right" or n <= 0:
            out.append(g)
            continue
        path_l = g.path.lower()
        hunks_for_path = hunks.get(path_l, [])
        if not hunks_for_path:
            out.append(g)
            continue
        original = g.lines
        expanded: set[int] = set(original)
        for anchor in original:
            for new_start, new_len in hunks_for_path:
                hunk_end = new_start + new_len - 1
                if new_start <= anchor <= hunk_end:
                    expanded.update(range(anchor, min(anchor + n, hunk_end) + 1))
                    break
        out.append(
            ChangedLineSet(
                path=g.path,
                side=g.side,
                lines=frozenset(expanded),
                original_lines=original,
            )
        )
    return out


# ─── Matcher ──────────────────────────────────────────────────────────────


def _max_overlap(expected: ExpectedScenario, actual: ActualScenario) -> int:
    """Maximum effective changed-line overlap across all grounding pairs.

    Returns 0 if no path+side pair matches. This is the deterministic
    grounding gate: an actual scenario that cites the same file but
    different changed lines than expected gets overlap=0 and is
    treated as a miss for that expected scenario.

    Backward-compat wrapper retained for tests; the matcher itself uses
    ``_max_overlap_tiered`` so the T1i 2-tier tiebreaker can run."""
    best = 0
    for e_g in expected.grounding:
        for a_g in actual.grounding:
            best = max(best, e_g.overlap(a_g))
    return best


def _max_overlap_tiered(expected: ExpectedScenario, actual: ActualScenario) -> tuple[int, int]:
    """Maximum ``(original_overlap, expanded_overlap)`` across grounding pairs.

    T1i 2-tier tiebreaker: tuple comparison ranks `(1, 3)` above `(0, 8)`
    so a single original-line match always outranks any number of
    expansion-only matches. This preserves baseline pairs across
    span-expansion changes (no greedy reallocation pair theft)."""
    best = (0, 0)
    for e_g in expected.grounding:
        for a_g in actual.grounding:
            best = max(best, e_g.overlap_tiered(a_g))
    return best


def match_scenarios(
    expected: list[ExpectedScenario],
    actuals: list[ActualScenario],
    matcher: str = MATCHER_DEFAULT,
    *,
    strict_category: bool = False,
) -> tuple[list[MatchPair], list[ExpectedScenario], list[ActualScenario]]:
    """Match expected → actual scenarios under the chosen matcher.

    Returns ``(matched, missed_expected, unmatched_actual)``. Both matchers
    enforce the same hard compatibility constraint: category-cluster (T4-A:
    {HappyPath, EdgeCase, ErrorPath, Regression} collapse into 'behavioral';
    ``Performance`` stays in its own cluster) must match AND verb must match
    AND post-expansion overlap must be ≥ 1.

    Pass ``strict_category=True`` to use the raw category label (pre-T4-A
    behaviour, retained for audit-trail reproducibility).

    matcher='bipartite' (T1j default): globally optimal max-weight matching
    via ``scipy.optimize.linear_sum_assignment`` with a cardinality-first
    integer-encoded objective (matches > original_overlap > expanded_overlap
    > deterministic tiebreaker on declared order). Cannot reduce match count
    below greedy; eliminates pair theft.

    matcher='greedy' (T1i legacy): iterate-over-expected greedy with 2-tier
    (original, expanded) overlap tiebreaker. Retained for audit-trail
    reproducibility of pre-T1j scores. May exhibit pair theft at high N."""
    if matcher == "bipartite":
        return _bipartite_match(expected, actuals, strict_category=strict_category)
    if matcher == "greedy":
        return _greedy_match(expected, actuals, strict_category=strict_category)
    raise ValueError(f"unknown matcher {matcher!r}; choose from {MATCHER_CHOICES}")


def _greedy_match(
    expected: list[ExpectedScenario],
    actuals: list[ActualScenario],
    *,
    strict_category: bool = False,
) -> tuple[list[MatchPair], list[ExpectedScenario], list[ActualScenario]]:
    """T1i greedy iterate-over-expected matcher with 2-tier overlap tiebreaker.

    Preserved verbatim for audit-trail reproducibility of pre-T1j scores."""
    used_actual: set[int] = set()
    matched: list[MatchPair] = []
    missed: list[ExpectedScenario] = []

    for e in expected:
        best_idx = -1
        best_pair = (0, 0)
        e_cat = _category_key(e.category, strict=strict_category)
        for ai, a in enumerate(actuals):
            if ai in used_actual:
                continue
            if _category_key(a.category, strict=strict_category) != e_cat:
                continue
            if a.verb != e.verb:
                continue
            pair = _max_overlap_tiered(e, a)
            if pair[1] == 0:
                continue
            if pair > best_pair:
                best_pair = pair
                best_idx = ai
        if best_idx >= 0:
            matched.append(
                MatchPair(
                    expected=e,
                    actual=actuals[best_idx],
                    overlap_count=best_pair[1],
                    original_overlap_count=best_pair[0],
                )
            )
            used_actual.add(best_idx)
        else:
            missed.append(e)

    unmatched = [a for ai, a in enumerate(actuals) if ai not in used_actual]
    return matched, missed, unmatched


def _bipartite_match(
    expected: list[ExpectedScenario],
    actuals: list[ActualScenario],
    *,
    strict_category: bool = False,
) -> tuple[list[MatchPair], list[ExpectedScenario], list[ActualScenario]]:
    """T1j globally optimal max-weight bipartite matcher.

    Builds an integer cost matrix with a cardinality-first encoding and
    solves via scipy.optimize.linear_sum_assignment(maximize=True). The
    encoding (see header) guarantees:
      1. Total match count is maximized (no recall regression vs greedy).
      2. Among max-cardinality matchings, total original-line overlap wins.
      3. Among those, total expanded-line overlap wins.
      4. Ties broken deterministically by (earlier-declared expected then
         earlier-declared actual).
    Forbidden cells (category/verb mismatch OR exp_overlap == 0) get weight
    0; scipy may still place an assignment there to satisfy dimensions, so
    we post-filter assignments with weight 0."""
    if not expected or not actuals:
        return ([], list(expected), list(actuals))

    # ── 1. compute (orig, exp) and validity per cell ─────────────────────
    n_e = len(expected)
    n_a = len(actuals)
    tiers = [[(0, 0)] * n_a for _ in range(n_e)]
    valid = [[False] * n_a for _ in range(n_e)]
    for ei, e in enumerate(expected):
        e_cat = _category_key(e.category, strict=strict_category)
        for ai, a in enumerate(actuals):
            if _category_key(a.category, strict=strict_category) != e_cat or a.verb != e.verb:
                continue
            pair = _max_overlap_tiered(e, a)
            if pair[1] == 0:
                continue
            tiers[ei][ai] = pair
            valid[ei][ai] = True

    # ── 2. size tier bases against matrix-wide totals ────────────────────
    # MAX_TIE upper bound: (e_idx, a_idx) ≤ 999 ⇒ (1000-e_idx)*1000 + (1000-a_idx) < 1_001_000.
    # T = min(n_e, n_a) is the upper bound on assignments.
    t = min(n_e, n_a)
    max_orig = 0
    max_exp = 0
    for ei in range(n_e):
        for ai in range(n_a):
            o, x = tiers[ei][ai]
            if o > max_orig:
                max_orig = o
            if x > max_exp:
                max_exp = x
    MAX_TIE = 1_001_000
    EXP_BASE = max(1, t * MAX_TIE + 1)
    ORIG_BASE = max(1, t * max_exp * EXP_BASE + 1)
    CARD_BASE = max(1, t * max_orig * ORIG_BASE + 1)

    # ── 3. build the cost matrix ─────────────────────────────────────────
    # Use plain Python int lists; scipy will accept them and promote.
    cost: list[list[int]] = [[0] * n_a for _ in range(n_e)]
    for ei in range(n_e):
        for ai in range(n_a):
            if not valid[ei][ai]:
                continue
            o, x = tiers[ei][ai]
            tie = (1000 - ei) * 1000 + (1000 - ai)
            cost[ei][ai] = CARD_BASE + o * ORIG_BASE + x * EXP_BASE + tie

    # ── 4. solve ────────────────────────────────────────────────────────
    try:
        from scipy.optimize import linear_sum_assignment
    except ImportError as e:  # pragma: no cover - scoped to dev environments
        raise RuntimeError(
            "T1j bipartite matcher requires scipy (>=1.10). "
            "Install via `pip install -r requirements-dev.txt` or pass "
            "`--matcher greedy` to fall back to the T1i scorer."
        ) from e
    row_ind, col_ind = linear_sum_assignment(cost, maximize=True)

    # ── 5. post-filter forbidden assignments + canonicalize order ────────
    used_actual: set[int] = set()
    matched: list[MatchPair] = []
    for ei, ai in zip(row_ind, col_ind, strict=True):
        if not valid[ei][ai]:
            continue
        o, x = tiers[ei][ai]
        matched.append(
            MatchPair(
                expected=expected[ei],
                actual=actuals[ai],
                overlap_count=x,
                original_overlap_count=o,
            )
        )
        used_actual.add(ai)

    # Sort matched by declared-expected order so the audit trail is stable
    # regardless of scipy's internal row iteration.
    expected_index: dict[str, int] = {e.id: i for i, e in enumerate(expected)}
    matched.sort(key=lambda m: expected_index[m.expected.id])

    matched_expected_ids = {m.expected.id for m in matched}
    missed = [e for e in expected if e.id not in matched_expected_ids]
    unmatched = [a for ai, a in enumerate(actuals) if ai not in used_actual]
    return matched, missed, unmatched


# ─── Scoring ──────────────────────────────────────────────────────────────


def _safe_div(num: float, den: float) -> float:
    return num / den if den > 0 else 0.0


def score_pr(
    pr_number: str,
    expected: list[ExpectedScenario],
    actuals: list[ActualScenario],
    matcher: str = MATCHER_DEFAULT,
    *,
    strict_category: bool = False,
) -> PrScore:
    matched, missed, unmatched = match_scenarios(
        expected,
        actuals,
        matcher=matcher,
        strict_category=strict_category,
    )

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
        stage: _safe_div(matched_per_stage[stage], actual_by_stage[stage]) for stage in VALID_STAGES
    }

    # T1f-c: highest-stage precision — matched ÷ total scenarios produced
    # (sum across all stages). Because we tag each scenario at its highest
    # reached stage exactly once, this denominator is the count of every
    # distinct scenario the V2 pipeline emitted. This is the honest
    # corpus-wide precision number; the per-stage breakdown above is for
    # diagnosing WHERE precision drops happen. The `validated` headline
    # is structurally 0 under highest-stage tagging when every Validator-
    # accepted scenario also survives the Projector — `precision_highest_stage`
    # is the gate-meaningful number.
    total_actual = sum(actual_by_stage.values())
    total_matched_count = len(matched)
    precision_highest = _safe_div(total_matched_count, total_actual)

    # F1 on the headline (validated) stage.
    val_p = precision["validated"]
    f1 = _safe_div(2 * val_p * recall, val_p + recall) if (val_p + recall) > 0 else 0.0
    # F1 on highest-stage precision — the gate-meaningful pair.
    f1_high = (
        _safe_div(2 * precision_highest * recall, precision_highest + recall)
        if (precision_highest + recall) > 0
        else 0.0
    )

    # P0+P1 recall — must-pass criticality bucket.
    p0_p1_expected = [e for e in expected if e.criticality in {"P0", "P1"}]
    p0_p1_matched = [m for m in matched if m.expected.criticality in {"P0", "P1"}]
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
        precision_highest_stage=precision_highest,
        f1_validated=f1,
        f1_highest_stage=f1_high,
        p0_p1_recall=p0_p1_recall,
        category_label_accuracy=_safe_div(
            sum(1 for m in matched if m.expected.category == m.actual.category),
            len(matched),
        ),
    )


def aggregate(pr_scores: list[PrScore]) -> dict[str, Any]:
    if not pr_scores:
        return {
            "pr_count": 0,
            "macro": {
                "recall": 0.0,
                "precision_validated": 0.0,
                "precision_highest_stage": 0.0,
                "f1_validated": 0.0,
                "f1_highest_stage": 0.0,
                "p0_p1_recall": 0.0,
                "category_label_accuracy": 0.0,
            },
            "micro": {
                "recall": 0.0,
                "precision_validated": 0.0,
                "precision_highest_stage": 0.0,
            },
        }

    # Macro: each PR weighted equally.
    macro_recall = sum(p.recall for p in pr_scores) / len(pr_scores)
    macro_prec = sum(p.precision_by_stage["validated"] for p in pr_scores) / len(pr_scores)
    macro_prec_high = sum(p.precision_highest_stage for p in pr_scores) / len(pr_scores)
    macro_f1 = sum(p.f1_validated for p in pr_scores) / len(pr_scores)
    macro_f1_high = sum(p.f1_highest_stage for p in pr_scores) / len(pr_scores)
    macro_p0 = sum(p.p0_p1_recall for p in pr_scores) / len(pr_scores)
    # T4-A: average across PRs that have at least one matched pair; PRs
    # with zero matches don't contribute (denominator 0). If every PR has
    # zero matches the metric is 0.0 by convention.
    prs_with_matches = [p for p in pr_scores if p.matched]
    macro_cat_label = (
        sum(p.category_label_accuracy for p in prs_with_matches) / len(prs_with_matches) if prs_with_matches else 0.0
    )

    # Micro: each scenario weighted equally.
    total_expected = sum(p.expected_total for p in pr_scores)
    total_matched = sum(len(p.matched) for p in pr_scores)
    total_validated_actual = sum(p.actual_total_by_stage["validated"] for p in pr_scores)
    total_matched_validated = sum(len([m for m in p.matched if m.actual.stage == "validated"]) for p in pr_scores)
    # T1f-c: highest-stage micro — total matched ÷ total scenarios produced
    # across the corpus. This is what the corpus-level precision floor
    # should gate against.
    total_actual_highest = sum(sum(p.actual_total_by_stage.values()) for p in pr_scores)

    return {
        "pr_count": len(pr_scores),
        "macro": {
            "recall": round(macro_recall, 4),
            "precision_validated": round(macro_prec, 4),
            "precision_highest_stage": round(macro_prec_high, 4),
            "f1_validated": round(macro_f1, 4),
            "f1_highest_stage": round(macro_f1_high, 4),
            "p0_p1_recall": round(macro_p0, 4),
            "category_label_accuracy": round(macro_cat_label, 4),
        },
        "micro": {
            "recall": round(_safe_div(total_matched, total_expected), 4),
            "precision_validated": round(_safe_div(total_matched_validated, total_validated_actual), 4),
            "precision_highest_stage": round(_safe_div(total_matched, total_actual_highest), 4),
        },
    }


# ─── Stability metric (Vex 2026) ─────────────────────────────────────────
#
# Answers the question: "if I run the same PR through the Architect N
# times, do I get the same scenarios back?". Reads per-PR
# ``actual_run_<i>.json`` fixtures (same schema as ``actual.json``) and
# compares them pairwise:
#
#   - title_jaccard:    overlap of normalized scenario titles (we use the
#                       ``topic`` field — the canonical title in this
#                       schema) across each pair of runs
#   - evidence_jaccard: overlap of ``(file_lower, line)`` evidence tuples
#                       across each pair of runs
#   - category_cosine:  cosine similarity of category-count vectors
#   - overall:          0.4 * title + 0.4 * evidence + 0.2 * category
#
# Per-PR scores are averaged over all distinct pairs (i, j) with i<j.
# Corpus stability = mean across PRs that contributed >= 2 runs.
#
# Operator workflow: capture N runs by invoking ``capture_v2_actuals.py``
# repeatedly with ``--run-index 1..N`` (which writes ``actual_run_<i>.json``
# alongside ``actual.json``), then run::
#
#     python tests/qa-eval/score_eval.py --stability-runs 3
#
# When ``--stability-runs`` is 1 (default) the section is omitted entirely
# so the existing report shape is unchanged for non-stability callers.

STABILITY_TITLE_WEIGHT = 0.4
STABILITY_EVIDENCE_WEIGHT = 0.4
STABILITY_CATEGORY_WEIGHT = 0.2
STABILITY_DEFAULT_FLOOR = 0.0


_TITLE_NORM_RE = re.compile(r"\s+")


def _normalize_title(raw: str) -> str:
    """Lowercase + collapse whitespace so trivial wording drift doesn't tank Jaccard."""
    if not raw:
        return ""
    return _TITLE_NORM_RE.sub(" ", raw.strip().lower())


def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    union = a | b
    if not union:
        return 1.0
    return len(a & b) / len(union)


def _cosine(vec_a: dict[str, int], vec_b: dict[str, int]) -> float:
    if not vec_a and not vec_b:
        return 1.0
    keys = set(vec_a) | set(vec_b)
    dot = sum(vec_a.get(k, 0) * vec_b.get(k, 0) for k in keys)
    norm_a = sum(v * v for v in vec_a.values()) ** 0.5
    norm_b = sum(v * v for v in vec_b.values()) ** 0.5
    if norm_a == 0 or norm_b == 0:
        # One side has no scenarios — degenerate. Treat as "match" only if
        # both sides are empty (handled above), else "no overlap".
        return 0.0
    return dot / (norm_a * norm_b)


def _load_stability_run(path: Path) -> dict[str, Any]:
    """Extract title set / evidence tuple set / category histogram from one run fixture."""
    with path.open(encoding="utf-8") as fh:
        blob = json.load(fh)
    titles: set[str] = set()
    evidence: set[tuple[str, int]] = set()
    categories: dict[str, int] = defaultdict(int)
    for scn in blob.get("scenarios", []):
        title = _normalize_title(str(scn.get("topic") or scn.get("title") or ""))
        if title:
            titles.add(title)
        cat = str(scn.get("category") or "").strip()
        if cat:
            categories[cat] += 1
        for g in scn.get("grounding_changed_lines", []) or []:
            file_key = str(g.get("path") or "").lower()
            for line in g.get("lines", []) or []:
                try:
                    evidence.add((file_key, int(line)))
                except (TypeError, ValueError):
                    continue
    return {"titles": titles, "evidence": evidence, "categories": dict(categories)}


def _discover_stability_runs(pr_dir: Path, max_runs: int) -> list[Path]:
    """Return up to ``max_runs`` ``actual_run_*.json`` paths sorted by index."""
    runs: list[tuple[int, Path]] = []
    pattern = re.compile(r"^actual_run_(\d+)\.json$")
    for p in pr_dir.iterdir():
        if not p.is_file():
            continue
        m = pattern.match(p.name)
        if not m:
            continue
        runs.append((int(m.group(1)), p))
    runs.sort(key=lambda t: t[0])
    return [p for _, p in runs[:max_runs]]


def compute_pr_stability(pr_dir: Path, max_runs: int) -> dict[str, Any] | None:
    """Compute stability across the per-PR ``actual_run_*.json`` fixtures.

    Returns ``None`` when fewer than 2 runs are available (stability is
    undefined for a single sample). The caller is expected to surface
    that via the schema_errors / report payload so the operator knows
    to capture more runs.
    """
    paths = _discover_stability_runs(pr_dir, max_runs)
    if len(paths) < 2:
        return None
    runs = [_load_stability_run(p) for p in paths]
    pair_titles: list[float] = []
    pair_evidence: list[float] = []
    pair_categories: list[float] = []
    for i in range(len(runs)):
        for j in range(i + 1, len(runs)):
            pair_titles.append(_jaccard(runs[i]["titles"], runs[j]["titles"]))
            pair_evidence.append(_jaccard(runs[i]["evidence"], runs[j]["evidence"]))
            pair_categories.append(_cosine(runs[i]["categories"], runs[j]["categories"]))
    title = sum(pair_titles) / len(pair_titles)
    evidence = sum(pair_evidence) / len(pair_evidence)
    category = sum(pair_categories) / len(pair_categories)
    overall = (
        STABILITY_TITLE_WEIGHT * title + STABILITY_EVIDENCE_WEIGHT * evidence + STABILITY_CATEGORY_WEIGHT * category
    )
    return {
        "runs_compared": len(runs),
        "run_files": [p.name for p in paths],
        "title_jaccard": round(title, 4),
        "evidence_jaccard": round(evidence, 4),
        "category_cosine": round(category, 4),
        "overall": round(overall, 4),
    }


def aggregate_stability(per_pr: dict[str, dict[str, Any]], floor: float, runs_requested: int) -> dict[str, Any]:
    """Macro-average per-PR stability into a single corpus-level block."""
    if not per_pr:
        return {
            "runs": runs_requested,
            "title_jaccard": 0.0,
            "evidence_jaccard": 0.0,
            "category_cosine": 0.0,
            "overall": 0.0,
            "floor": floor,
            "prs_with_stability": 0,
            "per_pr": {},
        }
    n = len(per_pr)
    title = sum(s["title_jaccard"] for s in per_pr.values()) / n
    evidence = sum(s["evidence_jaccard"] for s in per_pr.values()) / n
    category = sum(s["category_cosine"] for s in per_pr.values()) / n
    overall = sum(s["overall"] for s in per_pr.values()) / n
    return {
        "runs": runs_requested,
        "title_jaccard": round(title, 4),
        "evidence_jaccard": round(evidence, 4),
        "category_cosine": round(category, 4),
        "overall": round(overall, 4),
        "floor": floor,
        "prs_with_stability": n,
        "per_pr": per_pr,
    }


# ─── Architect determinism finding ───────────────────────────────────────
#
# The stability metric measures the *symptom* (runs disagree). The most
# common *cause* is an LLM call whose temperature isn't pinned. We grep
# the C# Architect/Analyst request-body builders here as a build-time
# audit so an unpinned temperature shows up next to the stability score
# instead of being something an operator has to remember to check.

_ARCHITECT_CLIENT_PATH = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaLlmClient.cs"
_REQUEST_BODY_BUILDERS = (
    "BuildAnalystRequestBody",
    "BuildArchitectRequestBody",
    "BuildEditorRequestBody",
)


def audit_architect_temperature() -> dict[str, Any]:
    """Inspect EdogQaLlmClient.cs and report whether temperature is pinned.

    Returns ``{"available": False}`` when the C# source is missing
    (e.g. running the harness against a partial checkout)."""
    if not _ARCHITECT_CLIENT_PATH.exists():
        return {"available": False, "reason": "EdogQaLlmClient.cs not found"}

    src = _ARCHITECT_CLIENT_PATH.read_text(encoding="utf-8")
    findings: dict[str, dict[str, Any]] = {}
    for builder in _REQUEST_BODY_BUILDERS:
        # Find the builder's body — from the method signature to the next
        # top-level closing brace. We use a simple heuristic: take the
        # next 60 lines after the signature, which comfortably covers
        # each builder in the current source.
        idx = src.find(builder + "(")
        if idx < 0:
            findings[builder] = {"present": False}
            continue
        snippet = src[idx : idx + 4000]
        # Pinned == an explicit ``temperature = 0`` (or 0.0) in the payload.
        pinned = bool(re.search(r"\btemperature\s*=\s*0(?:\.0+)?\b", snippet))
        # Mentioned-but-not-pinned == any temperature reference in the snippet.
        mentioned = bool(re.search(r"\btemperature\b", snippet))
        findings[builder] = {
            "present": True,
            "temperature_pinned_to_zero": pinned,
            "temperature_mentioned": mentioned,
        }
    any_unpinned = any(f.get("present") and not f.get("temperature_pinned_to_zero") for f in findings.values())
    return {
        "available": True,
        "source": _ARCHITECT_CLIENT_PATH.relative_to(REPO_ROOT).as_posix(),
        "builders": findings,
        "all_pinned": not any_unpinned,
        "note": (
            "Architect/Analyst/Editor request bodies do not set 'temperature' "
            "explicitly — the deployment default applies. Pin to 0 if "
            "stability.overall drifts below floor."
        )
        if any_unpinned
        else "All request-body builders pin temperature to 0.",
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
    stability: dict[str, Any] | None = None,
) -> tuple[str, list[str]]:
    """Return ``('PASS' | 'DEGRADED' | 'FAIL', violations)``.

    ``DEGRADED`` means at least one regression-guard tripped but no
    absolute floor breached. ``FAIL`` means at least one absolute floor
    breached. Regression guards require a prior baseline.json with
    aggregate numbers; absent prior baseline = no regression check.

    When ``stability`` is provided and its ``overall`` < its ``floor``,
    a stability violation is appended — the harness fails because we
    can't trust scores that drift between runs."""
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
    # T1f-c: highest-stage precision floor — this is the gate-meaningful
    # one because the `validated` bucket is structurally empty under our
    # highest-stage tagging. Macro precision_highest_stage = average of
    # per-PR (matched / total-actual-scenarios) across the corpus.
    if macro.get("precision_highest_stage", 0.0) < absolute.get("corpus_precision_highest_stage_min", 0.0):
        violations.append(
            f"corpus_precision_highest_stage {macro.get('precision_highest_stage', 0.0)} "
            f"< min {absolute['corpus_precision_highest_stage_min']}",
        )
    if macro.get("p0_p1_recall", 0.0) < absolute.get("p0_p1_recall_min", 0.0):
        violations.append(
            f"corpus_p0_p1_recall {macro.get('p0_p1_recall', 0.0)} < min {absolute['p0_p1_recall_min']}",
        )
    for p in pr_scores:
        if p.recall < absolute.get("per_pr_recall_min", 0.0):
            violations.append(
                f"PR-{p.pr_number} recall {p.recall} < per_pr min {absolute['per_pr_recall_min']}",
            )
        # T1f-c: per-PR highest-stage precision floor.
        if p.precision_highest_stage < absolute.get("per_pr_precision_highest_stage_min", 0.0):
            violations.append(
                f"PR-{p.pr_number} precision_highest_stage {round(p.precision_highest_stage, 4)} "
                f"< per_pr min {absolute['per_pr_precision_highest_stage_min']}",
            )

    if violations:
        return "FAIL", violations
    if stability and stability.get("prs_with_stability", 0) > 0:
        overall = float(stability.get("overall", 0.0))
        floor = float(stability.get("floor", 0.0))
        if overall < floor:
            return "FAIL", [
                f"stability_overall {overall} < floor {floor} "
                f"(prs_with_stability={stability.get('prs_with_stability', 0)})",
            ]
    return "PASS", []


# ─── CLI ─────────────────────────────────────────────────────────────────


def discover_pr_dirs() -> list[Path]:
    if not GROUND_TRUTH.exists():
        return []
    return sorted(d for d in GROUND_TRUTH.iterdir() if d.is_dir() and d.name.startswith("PR-"))


def build_report(
    pr_dirs: list[Path],
    span_expansion_n: int = SPAN_EXPANSION_DEFAULT_N,
    matcher: str = MATCHER_DEFAULT,
    *,
    strict_category: bool = False,
    stability_runs: int = 1,
) -> dict[str, Any]:
    pr_scores: list[PrScore] = []
    pending_grading: list[str] = []
    ungraded: list[str] = []
    schema_errors: list[str] = []

    for pr_dir in pr_dirs:
        pr_number = pr_dir.name.removeprefix("PR-")
        curator_state, expected, errs = load_expected(pr_dir)
        schema_errors.extend(errs)
        actual_exists = (pr_dir / "actual.json").exists()

        if curator_state in {"PENDING_HUMAN_GRADING", None}:
            # T4-C-prep: pending fixture must NOT carry actual.json —
            # half-promoted fixtures pollute the pipeline. Flag and skip.
            if actual_exists:
                schema_errors.append(
                    f"{pr_dir.name}: PENDING_HUMAN_GRADING fixture has actual.json — "
                    "either grade expected.json (set curator_state=GRADED_PASS_1) or "
                    "delete actual.json. Refusing to score a half-promoted fixture."
                )
            pending_grading.append(pr_number)
            continue
        if not expected:
            ungraded.append(pr_number)
            continue
        if not actual_exists:
            # Graded fixture but no LLM capture yet — record so the
            # operator knows to run capture_v2_actuals.py, but still
            # score against an empty actuals set (recall will be 0).
            schema_errors.append(
                f"{pr_dir.name}: graded expected.json present but actual.json missing — "
                "run `python tests/qa-eval/capture_v2_actuals.py --fixture "
                f"{pr_dir.name}` to capture the V2 pipeline output."
            )

        actuals, a_errs = load_actual(pr_dir, span_expansion_n=span_expansion_n)
        schema_errors.extend(a_errs)
        pr_scores.append(
            score_pr(
                pr_number,
                expected,
                actuals,
                matcher=matcher,
                strict_category=strict_category,
            )
        )

    agg = aggregate(pr_scores)
    floors = load_floors()

    stability_block: dict[str, Any] | None = None
    if stability_runs > 1:
        per_pr_stability: dict[str, dict[str, Any]] = {}
        for pr_dir in pr_dirs:
            pr_number = pr_dir.name.removeprefix("PR-")
            s = compute_pr_stability(pr_dir, stability_runs)
            if s is None:
                # Note: missing stability fixtures are a configuration
                # gap, not a scoring error. We surface it so the operator
                # knows to run capture_v2_actuals.py more times, but we
                # do not fail the harness on PRs that simply lack data.
                schema_errors.append(
                    f"{pr_dir.name}: --stability-runs={stability_runs} requested but fewer "
                    f"than 2 actual_run_*.json fixtures present (need at least 2 to "
                    f"measure stability). Run capture_v2_actuals.py --run-index N."
                )
                continue
            per_pr_stability[pr_number] = s
        floor = float(floors.get("stability", {}).get("floor", STABILITY_DEFAULT_FLOOR))
        stability_block = aggregate_stability(per_pr_stability, floor, stability_runs)
        stability_block["determinism_audit"] = audit_architect_temperature()

    verdict, violations = evaluate_floors(agg, floors, pr_scores, stability_block)

    return {
        "schema_version": "1.5",  # +stability block (Vex 2026)
        "verdict": verdict,
        "floor_violations": violations,
        "enforcement": floors.get("enforcement", "report_only"),
        "corpus_status": {
            # T4-C-prep: distinguishes graded (scored) from pending (skipped).
            # Sentinel must never see pending PRs counted in headline numbers.
            "graded_count": len(pr_scores),
            "pending_count": len(pending_grading),
            "ungraded_count": len(ungraded),
            "total_count": len(pr_scores) + len(pending_grading) + len(ungraded),
            "phase": "T4-C-prep" if pending_grading else "T4-A",
        },
        "span_expansion": {
            "forward_lines": span_expansion_n,
            "applied_to": "actual" if span_expansion_n > 0 else "none",
            "boundary": "hunk_end",
            "tiebreaker": "original_overlap_first" if span_expansion_n > 0 else "single_tier",
        },
        "matcher": {
            "algorithm": ("bipartite_linear_sum_assignment" if matcher == "bipartite" else "greedy_iterate_expected"),
            "objective": (
                "max_cardinality_then_original_overlap_then_expanded_overlap_then_declared_order"
                if matcher == "bipartite"
                else "greedy_max_2tier_overlap_per_expected"
            ),
            "category_key": "raw_label" if strict_category else "cluster_from_category_aliases.json",
            "version": "1.1" if not strict_category else "1.0",
        },
        "aggregate": agg,
        "stability": stability_block,
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
    span = report.get("span_expansion", {})
    if span and span.get("forward_lines", 0) > 0:
        print(f"  Span expansion: N={span['forward_lines']} (hunk-bounded, tiebreaker={span.get('tiebreaker', '?')})")
    matcher = report.get("matcher", {})
    if matcher:
        print(f"  Matcher: {matcher.get('algorithm', '?')} (v{matcher.get('version', '?')})")
    print()
    print("  Macro-average (each PR weighted equally):")
    print(f"    recall:               {agg['macro']['recall']:.3f}")
    print(f"    precision (validated): {agg['macro']['precision_validated']:.3f}")
    print(f"    precision (highest-stage): {agg['macro']['precision_highest_stage']:.3f}")
    print(f"    F1 (validated):       {agg['macro']['f1_validated']:.3f}")
    print(f"    F1 (highest-stage):   {agg['macro']['f1_highest_stage']:.3f}")
    print(f"    P0+P1 recall:         {agg['macro']['p0_p1_recall']:.3f}")
    print(
        f"    category_label_accuracy: {agg['macro'].get('category_label_accuracy', 0.0):.3f}  (of matched pairs, raw-label agreement)"
    )
    print()
    print("  Micro-average (each scenario weighted equally):")
    print(f"    recall:               {agg['micro']['recall']:.3f}")
    print(f"    precision (validated): {agg['micro']['precision_validated']:.3f}")
    print(f"    precision (highest-stage): {agg['micro']['precision_highest_stage']:.3f}")
    print()
    if report["floor_violations"]:
        print("  Floor violations:")
        for v in report["floor_violations"]:
            print(f"    - {v}")
        print()
    stab = report.get("stability")
    if stab:
        print("  Stability (across captured runs):")
        print(f"    runs requested:       {stab.get('runs', 0)}")
        print(f"    PRs with stability:   {stab.get('prs_with_stability', 0)}")
        print(f"    title_jaccard:        {stab.get('title_jaccard', 0.0):.3f}")
        print(f"    evidence_jaccard:     {stab.get('evidence_jaccard', 0.0):.3f}")
        print(f"    category_cosine:      {stab.get('category_cosine', 0.0):.3f}")
        print(f"    overall:              {stab.get('overall', 0.0):.3f}  (floor {stab.get('floor', 0.0):.3f})")
        audit = stab.get("determinism_audit") or {}
        if audit.get("available") and not audit.get("all_pinned", True):
            print(f"    determinism:          UNPINNED  ({audit.get('note', '')})")
        elif audit.get("available"):
            print("    determinism:          OK  (temperature pinned to 0)")
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
            f"precision_highest_stage={pr['precision_highest_stage']:.3f} "
            f"p0_p1_recall={pr['p0_p1_recall']:.3f} "
            f"expected={pr['expected_total']} "
            f"actual_total={sum(pr['actual_total'].values())}"
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
    parser.add_argument(
        "--span-expansion",
        type=int,
        default=SPAN_EXPANSION_DEFAULT_N,
        metavar="N",
        help=(
            "T1i: forward-expand each actual-side grounding line by up to N "
            "lines, bounded by the unified-diff hunk containing the anchor. "
            f"Default {SPAN_EXPANSION_DEFAULT_N}. Pass 0 to disable (pre-T1i behaviour)."
        ),
    )
    parser.add_argument(
        "--matcher",
        choices=MATCHER_CHOICES,
        default=MATCHER_DEFAULT,
        help=(
            "T1j: 'bipartite' (default) runs globally optimal max-weight "
            "bipartite matching with a cardinality-first objective; 'greedy' "
            "is the T1i iterate-over-expected matcher retained for "
            "audit-trail reproducibility."
        ),
    )
    parser.add_argument(
        "--strict-category",
        action="store_true",
        help=(
            "T4-A: use the raw category label (HappyPath/EdgeCase/etc.) "
            "instead of the cluster from category_aliases.json. Default "
            "(unset) collapses {HappyPath, EdgeCase, ErrorPath, Regression} "
            "into the 'behavioral' cluster for matcher cardinality; "
            "category_label_accuracy is reported separately. Pass this flag "
            "to reproduce pre-T4-A scores byte-for-byte."
        ),
    )
    parser.add_argument(
        "--stability-runs",
        type=int,
        default=1,
        metavar="N",
        help=(
            "Vex 2026: measure scenario-generation stability across N "
            "captured runs per PR. Reads actual_run_<i>.json fixtures "
            "(1..N) alongside actual.json and reports title Jaccard, "
            "evidence Jaccard, category cosine, and weighted overall "
            "(0.4/0.4/0.2). Default 1 skips stability entirely. "
            "Floor is configurable via score_floors.json#stability.floor."
        ),
    )
    args = parser.parse_args(argv)

    if args.stability_runs < 1:
        parser.error("--stability-runs must be >= 1")

    pr_dirs = discover_pr_dirs()
    if not pr_dirs:
        print(f"No PR fixtures found under {GROUND_TRUTH}", file=sys.stderr)
        return 2

    report = build_report(
        pr_dirs,
        span_expansion_n=args.span_expansion,
        matcher=args.matcher,
        strict_category=args.strict_category,
        stability_runs=args.stability_runs,
    )

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
