"""Deterministic invariants -- absolute truths, no baseline. Each cites the
evidence ids it relied on. ``report_only`` = surfaced but never a failure.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_SECRET_RE = re.compile(r"(Bearer\s+[A-Za-z0-9._-]{12,}|MwcToken\s+\S{12,}|eyJ[A-Za-z0-9._-]{20,})")

# FLT's terminal DAG/node states. Grounded in the FLT source, not guessed:
# LiveTableMaintenanceController.cs:257 "Only terminal statuses (Completed,
# Failed, Cancelled, Skipped) are allowed", and LiveTableInsightsController.cs:118
# / :938 "terminal ... completed, failed, cancelled, skipped". Omitting Skipped
# (as an earlier hardcode did) makes a skipped-terminal node read as "did not
# terminate" -> a false verdict. Polled status may be translated (Skipped ->
# Cancelled per SchedulerRunStatus), so a raw Skipped may not always reach here,
# but completeness is strictly safer. Injectable so a PR that changes the enum
# can supply the deployed set rather than fighting a baked-in literal.
TERMINAL_DAG_STATES = ("Completed", "Failed", "Cancelled", "Skipped")


@dataclass
class Finding:
    name: str
    ok: bool
    detail: str = ""
    evidence: list[str] = field(default_factory=list)
    report_only: bool = False


def check_no_5xx(resp: dict) -> Finding:
    s = int(resp.get("status", 0))
    return Finding(
        "no_5xx",
        not (500 <= s < 600),
        f"status {s}",
        [resp["evidenceId"]] if resp.get("evidenceId") else [],
    )


def check_no_secret_in_logs(lines: list[dict]) -> Finding:
    hits = [entry["id"] for entry in lines if _SECRET_RE.search(entry.get("text", ""))]
    return Finding("no_secret_in_logs", not hits, "secret in logs" if hits else "clean", hits)


def check_dag_terminates(dag: dict, *, terminal_states: tuple[str, ...] = TERMINAL_DAG_STATES) -> Finding:
    state = dag.get("state", "")
    timed_out = bool(dag.get("timedOut"))
    ok = state in terminal_states and not timed_out
    return Finding(
        "dag_terminates",
        ok,
        f"state {state}",
        [dag["evidenceId"]] if dag.get("evidenceId") else [],
    )


def check_perf_bound(*, elapsed: float, bound: float | None, source: str | None, evidence_id: str) -> Finding:
    if bound is None:
        return Finding(
            "perf_bound",
            True,
            f"{elapsed:.1f}s (no bound -- observed only)",
            [evidence_id],
            report_only=True,
        )
    return Finding("perf_bound", elapsed <= bound, f"{elapsed:.1f}s vs {bound}s ({source})", [evidence_id])
