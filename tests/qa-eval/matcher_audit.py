"""F27 P9 T4-A — matcher sensitivity audit (offline, zero LLM cost).

Question this script answers:
    "Are our recall numbers an artifact of matcher hyperparameters, or
     would they hold under reasonable perturbations of the matcher?"

It re-scores the existing gold-corpus actual.json captures (whatever is on
disk right now — at HEAD this is the T2-locked baseline) under four
independent sweeps, all reading the SAME captures:

  1. SPAN_EXPANSION_N sweep — knee analysis at N ∈ {0, 3, 5, 10, 15, 20, 30, 50, 100}.
     Current production N=15. Audit asks: does macro_recall plateau, or
     is it still climbing? A still-climbing curve means the scorer is
     under-credentialing real matches.

  2. Matcher sweep — greedy vs bipartite at production N.
     Bipartite must dominate greedy on cardinality (recall); confirms
     pair-theft is not occurring.

  3. Constraint relaxation — drop category, drop verb, drop both.
     If macro_recall jumps when we drop the verb constraint, the LLM is
     emitting semantically-correct scenarios under wrong verbs (recall
     LEFT ON THE TABLE by matcher strictness; not a model defect).

  4. Min-overlap threshold — require ≥1, ≥2, ≥3 expanded-line overlap.
     Tests how much "thin grounding" is propping up the headline number.

If macro_recall moves > 5 pp under any reasonable perturbation, the
matcher itself is the recall lever — re-tune matcher first, retire
expensive LLM interventions until corpus reaches n ≥ 15 (T4-C).

Run from edog-studio repo root::

    python tests/qa-eval/matcher_audit.py
    python tests/qa-eval/matcher_audit.py --json   # machine output
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Score_eval lives in the same package; import surgically.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import score_eval as se

# ────────────────────────────────────────────────────────────────────────────
# Custom matchers for the constraint-relaxation sweep.
# ────────────────────────────────────────────────────────────────────────────


def _bipartite_relaxed(
    expected: list[se.ExpectedScenario],
    actuals: list[se.ActualScenario],
    *,
    require_category: bool,
    require_verb: bool,
    min_overlap: int,
) -> tuple[list[se.MatchPair], list[se.ExpectedScenario], list[se.ActualScenario]]:
    """Bipartite max-cardinality match with configurable hard constraints.

    Mirrors ``score_eval._bipartite_match`` but with knobs."""
    if not expected or not actuals:
        return ([], list(expected), list(actuals))

    n_e, n_a = len(expected), len(actuals)
    tiers = [[(0, 0)] * n_a for _ in range(n_e)]
    valid = [[False] * n_a for _ in range(n_e)]
    for ei, e in enumerate(expected):
        for ai, a in enumerate(actuals):
            if require_category and a.category != e.category:
                continue
            if require_verb and a.verb != e.verb:
                continue
            pair = se._max_overlap_tiered(e, a)
            if pair[1] < min_overlap:
                continue
            tiers[ei][ai] = pair
            valid[ei][ai] = True

    t = min(n_e, n_a)
    max_orig = max((tiers[ei][ai][0] for ei in range(n_e) for ai in range(n_a)), default=0)
    max_exp = max((tiers[ei][ai][1] for ei in range(n_e) for ai in range(n_a)), default=0)
    MAX_TIE = 1_001_000
    EXP_BASE = max(1, t * MAX_TIE + 1)
    ORIG_BASE = max(1, t * max_exp * EXP_BASE + 1)
    CARD_BASE = max(1, t * max_orig * ORIG_BASE + 1)

    cost = [[0] * n_a for _ in range(n_e)]
    for ei in range(n_e):
        for ai in range(n_a):
            if not valid[ei][ai]:
                continue
            o, x = tiers[ei][ai]
            tie = (1000 - ei) * 1000 + (1000 - ai)
            cost[ei][ai] = CARD_BASE + o * ORIG_BASE + x * EXP_BASE + tie

    from scipy.optimize import linear_sum_assignment

    row_ind, col_ind = linear_sum_assignment(cost, maximize=True)

    used_actual: set[int] = set()
    matched: list[se.MatchPair] = []
    for ei, ai in zip(row_ind, col_ind, strict=True):
        if not valid[ei][ai]:
            continue
        o, x = tiers[ei][ai]
        matched.append(
            se.MatchPair(
                expected=expected[ei],
                actual=actuals[ai],
                overlap_count=x,
                original_overlap_count=o,
            )
        )
        used_actual.add(ai)

    matched_ids = {m.expected.id for m in matched}
    missed = [e for e in expected if e.id not in matched_ids]
    unmatched = [a for ai, a in enumerate(actuals) if ai not in used_actual]
    return matched, missed, unmatched


# ────────────────────────────────────────────────────────────────────────────
# Driver
# ────────────────────────────────────────────────────────────────────────────


def _load_corpus(span_n: int) -> dict[str, tuple[list[se.ExpectedScenario], list[se.ActualScenario]]]:
    """Load all PRs under the given span-expansion N. Returns {pr_dir_name: (expected, actuals)}."""
    out: dict[str, tuple[list[se.ExpectedScenario], list[se.ActualScenario]]] = {}
    for pr_dir in se.discover_pr_dirs():
        _curator_state, expected, _ = se.load_expected(pr_dir)
        if not expected:
            continue
        actuals, _ = se.load_actual(pr_dir, span_expansion_n=span_n)
        out[pr_dir.name] = (expected, actuals)
    return out


def _score_corpus(
    corpus: dict[str, tuple[list[se.ExpectedScenario], list[se.ActualScenario]]],
    *,
    matcher: str = "bipartite",
    require_category: bool = True,
    require_verb: bool = True,
    min_overlap: int = 1,
) -> dict[str, Any]:
    pr_scores: list[se.PrScore] = []
    for pr, (expected, actuals) in corpus.items():
        if matcher == "custom":
            matched, missed, unmatched = _bipartite_relaxed(
                expected,
                actuals,
                require_category=require_category,
                require_verb=require_verb,
                min_overlap=min_overlap,
            )
            # Build a PrScore using the same arithmetic as score_pr.
            actual_by_stage = {stage: 0 for stage in se.VALID_STAGES}
            for a in actuals:
                if a.stage in actual_by_stage:
                    actual_by_stage[a.stage] += 1
            matched_per_stage = {stage: 0 for stage in se.VALID_STAGES}
            for m in matched:
                if m.actual.stage in matched_per_stage:
                    matched_per_stage[m.actual.stage] += 1
            recall = se._safe_div(len(matched), len(expected))
            precision = {
                s: se._safe_div(matched_per_stage[s], actual_by_stage[s])
                for s in se.VALID_STAGES
            }
            total_actual = sum(actual_by_stage.values())
            prec_high = se._safe_div(len(matched), total_actual)
            val_p = precision["validated"]
            f1 = se._safe_div(2 * val_p * recall, val_p + recall) if (val_p + recall) else 0.0
            f1_high = (
                se._safe_div(2 * prec_high * recall, prec_high + recall)
                if (prec_high + recall) else 0.0
            )
            p_exp = [e for e in expected if e.criticality in {"P0", "P1"}]
            p_match = [m for m in matched if m.expected.criticality in {"P0", "P1"}]
            p_recall = se._safe_div(len(p_match), len(p_exp))
            pr_scores.append(
                se.PrScore(
                    pr_number=pr,
                    expected_total=len(expected),
                    actual_total_by_stage=actual_by_stage,
                    matched=matched,
                    missed_expected=missed,
                    unmatched_actual=unmatched,
                    recall=recall,
                    precision_by_stage=precision,
                    precision_highest_stage=prec_high,
                    f1_validated=f1,
                    f1_highest_stage=f1_high,
                    p0_p1_recall=p_recall,
                )
            )
        else:
            pr_scores.append(se.score_pr(pr, expected, actuals, matcher=matcher))

    agg = se.aggregate(pr_scores)
    return {
        "macro_recall": agg["macro"]["recall"],
        "macro_precision_highest": agg["macro"]["precision_highest_stage"],
        "macro_f1_highest": agg["macro"]["f1_highest_stage"],
        "per_pr_recall": {p.pr_number: p.recall for p in pr_scores},
        "per_pr_matched": {p.pr_number: len(p.matched) for p in pr_scores},
        "per_pr_expected": {p.pr_number: p.expected_total for p in pr_scores},
    }


def run_audit() -> dict[str, Any]:
    PROD_N = se.SPAN_EXPANSION_DEFAULT_N  # 15

    # ── Sweep 1: span_expansion_n knee curve ──
    span_sweep: list[dict[str, Any]] = []
    for n in [0, 3, 5, 10, 15, 20, 30, 50, 100]:
        corpus = _load_corpus(n)
        s = _score_corpus(corpus, matcher="bipartite")
        s["span_n"] = n
        span_sweep.append(s)

    # ── Sweep 2: greedy vs bipartite at production N ──
    corpus_prod = _load_corpus(PROD_N)
    matcher_sweep = {
        "bipartite": _score_corpus(corpus_prod, matcher="bipartite"),
        "greedy": _score_corpus(corpus_prod, matcher="greedy"),
    }

    # ── Sweep 3: constraint relaxation at production N ──
    relax_sweep = {
        "strict_baseline": _score_corpus(corpus_prod, matcher="custom",
                                         require_category=True, require_verb=True, min_overlap=1),
        "drop_verb": _score_corpus(corpus_prod, matcher="custom",
                                   require_category=True, require_verb=False, min_overlap=1),
        "drop_category": _score_corpus(corpus_prod, matcher="custom",
                                       require_category=False, require_verb=True, min_overlap=1),
        "drop_both": _score_corpus(corpus_prod, matcher="custom",
                                   require_category=False, require_verb=False, min_overlap=1),
    }

    # ── Sweep 4: min-overlap threshold at production N ──
    overlap_sweep = {
        f"min_overlap_{k}": _score_corpus(corpus_prod, matcher="custom",
                                          require_category=True, require_verb=True,
                                          min_overlap=k)
        for k in [1, 2, 3, 5]
    }

    return {
        "production_span_n": PROD_N,
        "production_matcher": se.MATCHER_DEFAULT,
        "span_sweep": span_sweep,
        "matcher_sweep": matcher_sweep,
        "relax_sweep": relax_sweep,
        "overlap_sweep": overlap_sweep,
    }


def _fmt_pct(x: float) -> str:
    return f"{x*100:5.1f}%"


def print_human(audit: dict[str, Any]) -> None:
    print()
    print("════════════════════════════════════════════════════════════════")
    print(" F27 P9 T4-A — Matcher Sensitivity Audit (offline)")
    print("════════════════════════════════════════════════════════════════")
    print(f" Production: span_n={audit['production_span_n']}, matcher={audit['production_matcher']}")
    print()

    print("──── 1. Span-expansion knee curve (bipartite) ────")
    print(f"  {'N':>4}  {'recall':>8}  {'prec_high':>10}  {'F1_high':>8}")
    base_recall = next(s["macro_recall"] for s in audit["span_sweep"] if s["span_n"] == audit["production_span_n"])
    for s in audit["span_sweep"]:
        mark = " ← prod" if s["span_n"] == audit["production_span_n"] else ""
        delta = (s["macro_recall"] - base_recall) * 100
        print(f"  {s['span_n']:>4}  {_fmt_pct(s['macro_recall'])}  {_fmt_pct(s['macro_precision_highest'])}  "
              f"{_fmt_pct(s['macro_f1_highest'])}   Δrecall vs prod = {delta:+5.1f} pp{mark}")
    print()

    print("──── 2. Greedy vs bipartite (at production N) ────")
    for name, s in audit["matcher_sweep"].items():
        mark = " ← prod" if name == audit["production_matcher"] else ""
        print(f"  {name:<10}  recall={_fmt_pct(s['macro_recall'])}  "
              f"prec_high={_fmt_pct(s['macro_precision_highest'])}  "
              f"F1={_fmt_pct(s['macro_f1_highest'])}{mark}")
    print()

    print("──── 3. Constraint relaxation (at production N, bipartite) ────")
    base = audit["relax_sweep"]["strict_baseline"]["macro_recall"]
    for name, s in audit["relax_sweep"].items():
        delta = (s["macro_recall"] - base) * 100
        print(f"  {name:<18}  recall={_fmt_pct(s['macro_recall'])}  "
              f"prec_high={_fmt_pct(s['macro_precision_highest'])}   Δrecall = {delta:+5.1f} pp")
    print()

    print("──── 4. Min-overlap threshold (at production N, strict cat+verb) ────")
    for name, s in audit["overlap_sweep"].items():
        print(f"  {name:<18}  recall={_fmt_pct(s['macro_recall'])}  "
              f"prec_high={_fmt_pct(s['macro_precision_highest'])}")
    print()

    # ── Interpretation guide ──
    print("──── Diagnostic ────")
    span_max = max(s["macro_recall"] for s in audit["span_sweep"])
    span_at_prod = next(s["macro_recall"] for s in audit["span_sweep"]
                        if s["span_n"] == audit["production_span_n"])
    span_headroom = (span_max - span_at_prod) * 100
    drop_verb_lift = (audit["relax_sweep"]["drop_verb"]["macro_recall"] - base) * 100
    drop_cat_lift = (audit["relax_sweep"]["drop_category"]["macro_recall"] - base) * 100
    print(f"  Span-N headroom (best - prod):     {span_headroom:+5.1f} pp")
    print(f"  Recall lift from dropping verb:    {drop_verb_lift:+5.1f} pp")
    print(f"  Recall lift from dropping cat:     {drop_cat_lift:+5.1f} pp")
    flags: list[str] = []
    if abs(span_headroom) > 5:
        flags.append("  ⚠ span_n still has > 5 pp headroom — sweep further or retune knee.")
    if drop_verb_lift > 5:
        flags.append("  ⚠ verb-strictness costs > 5 pp recall — Architect/Editor verb taxonomy mismatch.")
    if drop_cat_lift > 5:
        flags.append("  ⚠ category-strictness costs > 5 pp recall — category alias map is incomplete.")
    if flags:
        for f in flags:
            print(f)
    else:
        print("  ✓ All matcher knobs within ±5 pp tolerance. Matcher is calibrated.")
    print()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--json", action="store_true", help="emit JSON instead of human text")
    p.add_argument("--output", type=Path, help="write JSON report to file")
    args = p.parse_args(argv)
    audit = run_audit()
    if args.output:
        args.output.write_text(json.dumps(audit, indent=2), encoding="utf-8")
    if args.json:
        print(json.dumps(audit, indent=2))
    else:
        print_human(audit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
