"""Diagnose WHICH pairs unlock under category-relaxation.

Lists every (expected, actual) match that:
  - matches when category constraint is dropped, AND
  - does NOT match under the strict (cat+verb) bipartite rule.

These are the alias candidates: pairs where the LLM emitted a
semantically-correct scenario under a different category label than
the curator used. We feed this list into a category-aliasing pass.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import score_eval as se
from matcher_audit import _bipartite_relaxed, _load_corpus


def main() -> int:
    corpus = _load_corpus(se.SPAN_EXPANSION_DEFAULT_N)
    print()
    print("════════════════════════════════════════════════════════════════")
    print(" T4-A — category-strictness alias candidates")
    print("════════════════════════════════════════════════════════════════")
    print()
    print(" Each row: pair that the matcher REJECTS today because category")
    print(" differs, but matches once we drop category strictness. These are")
    print(" the targets for `category_aliases.json`.")
    print()

    total = 0
    drift_pairs: list[tuple[str, str, str, str, str, int, int]] = []

    for pr, (expected, actuals) in corpus.items():
        strict_pairs, _, _ = _bipartite_relaxed(
            expected, actuals,
            require_category=True, require_verb=True, min_overlap=1,
        )
        relaxed_pairs, _, _ = _bipartite_relaxed(
            expected, actuals,
            require_category=False, require_verb=True, min_overlap=1,
        )
        strict_ids = {(m.expected.id, m.actual.id) for m in strict_pairs}
        relaxed_ids = {(m.expected.id, m.actual.id) for m in relaxed_pairs}
        new_ids = relaxed_ids - strict_ids

        # Expected matched-under-strict?  (so we know which are "newly recovered")
        strict_matched_exp = {m.expected.id for m in strict_pairs}

        new_pairs = [m for m in relaxed_pairs if (m.expected.id, m.actual.id) in new_ids]
        if not new_pairs:
            continue
        print(f"  PR-{pr}")
        for m in new_pairs:
            recovered = "NEWLY-RECOVERED" if m.expected.id not in strict_matched_exp else "REASSIGNED"
            print(f"    [{recovered}] expected={m.expected.id} cat={m.expected.category!r:<22}")
            print(f"                  actual  ={m.actual.id} cat={m.actual.category!r:<22} verb={m.actual.verb!r}")
            print(f"                  overlap_orig={m.original_overlap_count}, overlap_exp={m.overlap_count}")
            drift_pairs.append((
                pr, m.expected.id, m.expected.category, m.actual.category,
                m.actual.verb, m.original_overlap_count, m.overlap_count,
            ))
            if m.expected.id not in strict_matched_exp:
                total += 1
        print()

    print("──── Category drift summary ────")
    drift: dict[tuple[str, str], int] = {}
    for _, _, exp_cat, act_cat, _, _, _ in drift_pairs:
        key = (exp_cat, act_cat)
        drift[key] = drift.get(key, 0) + 1
    for (exp_cat, act_cat), cnt in sorted(drift.items(), key=lambda kv: -kv[1]):
        print(f"   {cnt:>2}x   {act_cat!r:<24} → expected curator label {exp_cat!r}")
    print()
    print(f" Net newly-recovered matches if we alias these: {total}")


if __name__ == "__main__":
    raise SystemExit(main())
