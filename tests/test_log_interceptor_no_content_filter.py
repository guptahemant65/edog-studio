"""
EdogLogInterceptor — structural regression test: no server-side content filtering.

Post-mortem 2026-06-05: the allowlist-based noise filter silently dropped FLT logs
that didn't match the dynamically-generated component list or secondary heuristics.
After three failed fix attempts (each introducing different log-dropping bugs), the
entire server-side content filter was removed. ALL logs now flow through to the
frontend; component presets in filters.js handle user-controlled filtering.

This test asserts the structural invariant: TraceEvent() must not return early
based on message content, component name, or any allowlist. Only null-message
guard and error-storm dedup (identical error within 2s) are permitted returns.
"""

from __future__ import annotations

import pathlib
import re

import pytest

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
INTERCEPTOR_PATH = PROJECT_ROOT / "src" / "backend" / "DevMode" / "EdogLogInterceptor.cs"


@pytest.fixture()
def interceptor_source() -> str:
    assert INTERCEPTOR_PATH.exists(), "EdogLogInterceptor.cs missing"
    return INTERCEPTOR_PATH.read_text(encoding="utf-8")


def _trace_event_body(source: str) -> str:
    """Return the body of the TraceEvent method."""
    match = re.search(r"public\s+void\s+TraceEvent\s*\(", source)
    assert match, "TraceEvent method not found"
    # Find the opening brace
    brace_start = source.index("{", match.end())
    depth = 1
    i = brace_start + 1
    while depth > 0 and i < len(source):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
        i += 1
    return source[brace_start + 1 : i - 1]


class TestNoServerSideContentFiltering:
    """Server-side log interceptor must NOT filter based on content or component."""

    def test_no_allowlist_or_component_filter(self, interceptor_source: str) -> None:
        """No code declarations for allowlist, IsFltComponent, or fltComponentPrefixes."""
        # Strip comments (// and /* */) before checking — references in doc comments are fine
        stripped = re.sub(r"//[^\n]*", "", interceptor_source)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        for banned in (
            "IsFltComponent",
            "fltComponentPrefixes",
            "hasAllowlist",
            "LoadComponentAllowlist",
            "edog-flt-components",
        ):
            assert banned not in stripped, (
                f"Found code reference to '{banned}' in EdogLogInterceptor.cs — "
                "the server-side allowlist filter was removed (post-mortem 2026-06-05). "
                "All logs must flow through; frontend handles filtering."
            )

    def test_no_content_based_return_in_trace_event(self, interceptor_source: str) -> None:
        """TraceEvent must not return based on FltClassPrefixRegex (the old broken filter)."""
        body = _trace_event_body(interceptor_source)
        for banned_pattern in (
            r"FltClassPrefixRegex",
        ):
            assert not re.search(banned_pattern, body), (
                f"Found old content filter '{banned_pattern}' in TraceEvent body. "
                "The allowlist-based filter was removed (post-mortem 2026-06-05)."
            )

    def test_only_permitted_early_returns(self, interceptor_source: str) -> None:
        """TraceEvent should only return early for: null message, verbose rate-limit, duplicate error."""
        body = _trace_event_body(interceptor_source)
        # Find all `return;` statements (not `return <value>;`)
        returns = list(re.finditer(r"\breturn\s*;", body))
        # We expect exactly 3: null-message guard, verbose rate-limit, IsDuplicateError guard
        assert len(returns) == 3, (
            f"Expected exactly 3 early returns in TraceEvent (null guard + verbose rate-limit + dedup), "
            f"found {len(returns)}. Additional returns likely indicate content filtering."
        )

    def test_dedup_is_universal(self, interceptor_source: str) -> None:
        """Error storm dedup must apply to ALL components, not just non-FLT."""
        body = _trace_event_body(interceptor_source)
        assert "IsDuplicateError" in body, "Error storm dedup must be present"
        # Must NOT be guarded by the OLD isFlt / IsFltComponent check
        # Note: isFltLog (the verbose rate-limiter) is different — it's backpressure, not content filtering
        assert "IsFltComponent" not in body, (
            "Dedup must not use the old IsFltComponent method."
        )
