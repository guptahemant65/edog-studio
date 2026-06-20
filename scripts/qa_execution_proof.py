"""Execution proof -- did the changed code actually run during a scenario?

Coverage is *measured from the trace*, never declared. FLT wraps operations in
named ``CodeMarker`` scopes (``Monitoring/CodeMarkers.cs``) which the EDOG log
interceptor surfaces as ``CurrentCodeMarkerName``. A changed symbol counts as
proven-run only when its enclosing code-marker (or an interceptor surface or a
log line tied to it) appears in the captured trace. This is the primary kill for
the false PASS where a scenario "passes" without ever reaching the new code.

Three honest outcomes, scope-level (not line-level):
- ``proven``         -- a marker/surface/log tied to the symbol fired (cited).
- ``not_exercised``  -- the symbol HAS a known surface, but it did not fire.
- ``no_surface``     -- the symbol has no observable surface (a pure internal
                        helper); it cannot be proven to run by any stimulus, so
                        we say so plainly rather than fake coverage.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Proof:
    symbol: str
    status: str  # "proven" | "not_exercised" | "no_surface"
    via: str = ""  # "code_marker" | "log" | ""
    evidence: list[str] = field(default_factory=list)


def _event_text(event: dict) -> str:
    return " ".join(str(event.get(k) or "") for k in ("codeMarker", "surface", "text"))


def prove(symbols: list[dict], trace: list[dict]) -> list[Proof]:
    """Decide, per changed symbol, whether the trace proves it ran.

    ``symbols``: ``[{"name": str, "kind": str, "marker": str | None}]`` where
    ``marker`` is the enclosing CodeMarker the skill found by reading the code
    (``None`` for a symbol with no observable surface).
    ``trace``: ``[{"id": str, "codeMarker": str?, "surface": str?, "text": str?}]``.
    """
    out: list[Proof] = []
    for sym in symbols:
        name = sym["name"]
        marker = sym.get("marker")
        if marker:
            fired = [e["id"] for e in trace if e.get("codeMarker") == marker]
            if fired:
                out.append(Proof(name, "proven", "code_marker", fired))
                continue
            mentioned = [e["id"] for e in trace if marker in _event_text(e)]
            if mentioned:
                out.append(Proof(name, "proven", "log", mentioned))
                continue
            out.append(Proof(name, "not_exercised", "", []))
        else:
            mentioned = [e["id"] for e in trace if name in _event_text(e)]
            if mentioned:
                out.append(Proof(name, "proven", "log", mentioned))
            else:
                out.append(Proof(name, "no_surface", "", []))
    return out


def summary(proofs: list[Proof]) -> dict:
    """Roll up per-symbol proofs into counts for the coverage line."""
    counts = {"proven": 0, "not_exercised": 0, "no_surface": 0}
    for p in proofs:
        counts[p.status] = counts.get(p.status, 0) + 1
    return counts
