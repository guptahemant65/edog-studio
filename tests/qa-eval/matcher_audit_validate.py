"""Print side-by-side details for the 11 newly-recovered category-drift pairs.

Reads expected.json + actual.json per PR, prints title/description for
each pair so a human reviewer can stamp each one as "truly equivalent"
or "coincidental overlap".
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_eval as se
from matcher_audit import _bipartite_relaxed, _load_corpus


def _load_raw(pr_dir: Path, fname: str) -> dict:
    with (pr_dir / fname).open(encoding="utf-8") as fh:
        return json.load(fh)


def main() -> int:
    corpus = _load_corpus(se.SPAN_EXPANSION_DEFAULT_N)

    pr_dirs = {p.name: p for p in se.discover_pr_dirs()}

    print()
    print("════════════════════════════════════════════════════════════════")
    print(" T4-A — Pair-by-pair validation of category-drift recoveries")
    print("════════════════════════════════════════════════════════════════")
    print()

    pair_count = 0
    for pr_name, (expected, actuals) in corpus.items():
        strict, _, _ = _bipartite_relaxed(
            expected, actuals,
            require_category=True, require_verb=True, min_overlap=1,
        )
        relaxed, _, _ = _bipartite_relaxed(
            expected, actuals,
            require_category=False, require_verb=True, min_overlap=1,
        )
        strict_keys = {(m.expected.id, m.actual.id) for m in strict}
        new = [m for m in relaxed if (m.expected.id, m.actual.id) not in strict_keys]
        if not new:
            continue

        # Load raw JSON to grab titles/descriptions.
        pr_dir = pr_dirs[pr_name]
        expected_raw = {s["id"]: s for s in _load_raw(pr_dir, "expected.json")["scenarios"]}
        actual_raw = {s["id"]: s for s in _load_raw(pr_dir, "actual.json")["scenarios"]}

        strict_matched_exp = {m.expected.id for m in strict}

        for m in new:
            pair_count += 1
            rec = "NEWLY-RECOVERED" if m.expected.id not in strict_matched_exp else "REASSIGNED"
            e_raw = expected_raw[m.expected.id]
            a_raw = actual_raw[m.actual.id]

            print(f"--- Pair #{pair_count} [{rec}] {pr_name} ---")
            print(f"  EXPECTED  {m.expected.id}  cat={m.expected.category}  verb={m.expected.verb}  crit={m.expected.criticality}")
            print(f"    title: {e_raw.get('title','')[:160]}")
            for g in e_raw.get('grounding', []):
                print(f"    @ {g.get('path','')}:{g.get('side','')}:{g.get('lines',[])}")
            print(f"  ACTUAL    {m.actual.id}  topic={a_raw.get('topic','')}  cat={m.actual.category}  verb={m.actual.verb}  stage={m.actual.stage}")
            for g in a_raw.get('grounding_changed_lines', []):
                print(f"    @ {g.get('path','')}:{g.get('side','')}:{g.get('lines',[])}")
            print(f"    overlap: orig={m.original_overlap_count}, expanded={m.overlap_count}")
            print()

    print(f"Total pairs (newly-recovered + reassigned): {pair_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
