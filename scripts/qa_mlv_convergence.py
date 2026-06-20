"""MLV convergence -- did the materialized output come out correct?

FLT's core promise: the stored Materialized Lake View must equal what you'd get
by recomputing its defining query from scratch over the current sources -- no
matter whether the refresh took the incremental or the full path (incremental
MUST converge to full). This oracle compares the materialized rows against an
independent full recompute of the SELECT (the skill runs the SELECT in its own
Spark/notebook session and passes both row sets here). It is the strongest, most
direct check that a change did not silently corrupt the data.

The comparison is a multiset (order-independent) equality -- a row present N
times in one side must be present N times in the other. For SQL that is not
deterministic (``current_timestamp``, ``rand``, nondeterministic ``order by``
+ ``limit``) or for live, still-changing sources, exact comparison is invalid,
so the oracle DEGRADES to schema + row-count checks and reports that it could
not prove correctness -- it never fakes a pass.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field


@dataclass
class ConvergenceResult:
    converged: bool | None  # True/False for exact; None when degraded (couldn't prove)
    mode: str  # "exact" | "degraded"
    detail: str
    missing: int = 0  # rows in the recompute but not in the materialized output
    extra: int = 0  # rows in the materialized output but not in the recompute
    evidence: list[str] = field(default_factory=list)


def _row_key(row: dict) -> tuple:
    # Order-independent, hashable representation of a row.
    return tuple(sorted((str(k), repr(v)) for k, v in row.items()))


def _columns(rows: list[dict]) -> set[str]:
    cols: set[str] = set()
    for r in rows:
        cols.update(r.keys())
    return cols


def converge(
    materialized: list[dict],
    recompute: list[dict],
    *,
    deterministic: bool = True,
    evidence_ids: list[str] | None = None,
) -> ConvergenceResult:
    """Compare the materialized MLV output to an independent recompute of its SELECT.

    ``deterministic=False`` (non-deterministic view SQL or live sources) forces
    the degraded schema+rowcount path -- correctness is reported as unproven, not
    passed.
    """
    evidence = list(evidence_ids or [])

    if not deterministic:
        cols_match = _columns(materialized) == _columns(recompute)
        detail = (
            "non-deterministic SQL or live sources -- compared schema + row count only "
            f"(columns {'match' if cols_match else 'DIFFER'}; "
            f"rows {len(materialized)} vs {len(recompute)})"
        )
        return ConvergenceResult(None, "degraded", detail, evidence=evidence)

    mat = Counter(_row_key(r) for r in materialized)
    rec = Counter(_row_key(r) for r in recompute)
    missing = sum((rec - mat).values())  # expected (in recompute) but absent
    extra = sum((mat - rec).values())  # present in output but not expected
    converged = missing == 0 and extra == 0
    detail = (
        f"materialized output equals a full recompute of the SELECT ({len(materialized)} rows match)"
        if converged
        else f"DRIFT -- {missing} expected row(s) missing, {extra} unexpected row(s) present"
    )
    return ConvergenceResult(converged, "exact", detail, missing, extra, evidence)
