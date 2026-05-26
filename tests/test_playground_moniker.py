"""Regression tests for the API Playground MWC-mode moniker header.

Background
----------
FLT controllers scope execution by the ``x-ms-workload-resource-moniker``
header, which MWC infrastructure pulls into ``CustomerCapacityAsyncLocalContext``
(workload-fabriclivetable/Service/Microsoft.LiveTable.Service/Common/Constants.cs:473,
.../MoveToWcl/RequestExecution/ExecutionContextManager.cs:95).

Without this header on the MWC-mode playground dispatch, controllers ran with
an empty moniker context and returned empty arrays (``nodes: []``, ``edges: []``)
for getLatestDag while DAG Studio's own proxy path (which sets the header)
returned the populated DAG.

These tests pin:
  1. The MWC branch of _serve_playground_dispatch wires in art_id as moniker.
  2. The bearer branch does NOT auto-add moniker (goes via Fabric FE, which is
     responsible for forwarding moniker downstream).
  3. A user-supplied moniker is not silently overwritten.

Verified live 2026-05-26: Playground/MWC getLatestDag returned nodes:[] before
the fix; returned populated DAG after the fix.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

DEV_SERVER = Path(__file__).resolve().parent.parent / "scripts" / "dev-server.py"


@pytest.fixture(scope="module")
def src() -> str:
    return DEV_SERVER.read_text(encoding="utf-8")


def _slice_function(src: str, func_signature: str) -> str:
    """Return the body of a Python function up to the next def at the same indent.

    Cheap parser sufficient for asserting wiring strings exist within a method.
    Handles both top-level (``def name(``) and methods (``    def name(``).
    """
    start = src.index(func_signature)
    rest = src[start + len(func_signature):]
    # Indent of next def must match the function's own indent.
    indent = ""
    for ch in func_signature:
        if ch == " ":
            indent += " "
        else:
            break
    pattern = re.compile(r"\n" + re.escape(indent) + r"def ")
    m = pattern.search(rest)
    return func_signature + (rest[: m.start()] if m else rest)


def test_serve_playground_dispatch_mwc_branch_sets_moniker(src: str):
    """MWC branch must auto-add x-ms-workload-resource-moniker = art_id."""
    body = _slice_function(src, "    def _serve_playground_dispatch(self):")
    assert 'token_type == "mwc"' in body, (
        "MWC branch guard missing from _serve_playground_dispatch"
    )
    assert "x-ms-workload-resource-moniker" in body, (
        "MWC playground dispatch does not set the moniker header — FLT will "
        "run with empty moniker context and return empty catalog arrays."
    )
    assert "art_id" in body, "art_id must be the value passed as moniker"


def test_serve_playground_dispatch_moniker_respects_user_override(src: str):
    """If caller already supplied a moniker header in sanitized_headers, the
    auto-add must not clobber it (case-insensitive check)."""
    body = _slice_function(src, "    def _serve_playground_dispatch(self):")
    # The guard must check whether the user already provided this header.
    # Two acceptable patterns: explicit ``not any(... lower() == ...)`` or a
    # case-insensitive ``in`` check against sanitized_headers.
    assert (
        "not any(k.lower() == \"x-ms-workload-resource-moniker\"" in body
        or "not any(k.lower() == 'x-ms-workload-resource-moniker'" in body
    ), (
        "Moniker auto-add must respect a user-supplied override from "
        "sanitized_headers (otherwise playground-as-debug-tool is hobbled)."
    )


def test_proxy_to_flt_still_sets_moniker(src: str):
    """Regression guard: DAG Studio's primary proxy path must keep setting the
    moniker. If this ever drops, DAG Studio returns nodes:[] silently."""
    body = _slice_function(src, "    def _proxy_to_flt(self, method=\"GET\"):")
    assert 'add_header("x-ms-workload-resource-moniker", art_id)' in body, (
        "_proxy_to_flt must set x-ms-workload-resource-moniker — losing this "
        "header silently returns empty DAG arrays."
    )


def test_all_capacity_calls_share_moniker_invariant(src: str):
    """Every place we POST/GET against /webapi/capacities/{cap}/workloads/LiveTable
    must set the moniker. This is a structural check: count the capacity URLs
    and count the moniker header lines and assert they line up.

    Note: This counts *occurrences*. Each capacity URL composition must be
    paired with a moniker set within ~30 lines (same function body)."""
    capacity_url_re = re.compile(
        r'f"\{host\}/webapi/capacities/\{cap_id\}/workloads/LiveTable'
    )
    moniker_re = re.compile(r"x-ms-workload-resource-moniker")

    capacity_matches = list(capacity_url_re.finditer(src))
    assert len(capacity_matches) >= 3, (
        "Expected at least 3 capacity-URL compositions; check refactor didn't "
        "delete callsites."
    )

    # For each capacity URL, the same function body should contain the moniker.
    for m in capacity_matches:
        # Look forward up to 2500 chars within the same method (rough body size).
        window = src[m.start(): m.start() + 2500]
        # Truncate at next "    def " (start of next method) to stay in-scope.
        next_def = window.find("\n    def ")
        if next_def != -1:
            window = window[:next_def]
        assert moniker_re.search(window), (
            f"Capacity URL at offset {m.start()} has no moniker header set "
            f"within its function body. FLT will return empty catalog scans."
        )
