"""Catalog-grounded failure attribution.

EDOG's error-sim-catalog tags every code with ``errorSource`` (User|System),
``category``, and ``httpStatus``. Whose fault a failure is must NOT be an LLM
guess -- it is read off this metadata so the harness-vs-test split (spec
SS9.B-5) is deterministic.

Rule: a User-sourced validation/auth failure is the change's fault; a
System-sourced failure (throttling, execution, capacity-routing, token expiry)
is the environment's. Anything we can't tag stays ``unknown`` (never silently a
verdict on the change).
"""

from __future__ import annotations


def classify(meta: dict) -> str:
    source = (meta.get("errorSource") or "").lower()
    if not source:
        return "unknown"
    if source == "system":
        # Environment-owned: throttling, execution, capacity routing, token expiry.
        return "infra"
    if source == "user":
        # Caller-shape fault: the change's request (validation/auth/contract) is
        # what triggered it, so it's attributable to the change under test.
        return "change"
    return "unknown"
