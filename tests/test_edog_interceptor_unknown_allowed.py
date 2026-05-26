"""
EdogLogInterceptor — Unknown-component allowlist regression test.

Locks in the post-mortem 2026-05-26 fix: in DevMode, a log whose extracted
component falls through to "Unknown" must NOT be silently dropped by the
allowlist filter. Pre-fix behaviour was to mark "Unknown" as non-FLT and
drop it (line 322-325), which killed every internal `Tracer.LogSanitized*`
call without a `[BracketedComponent]` prefix — i.e., 95%+ of FLT's own
internal logging — the moment the allowlist file existed on disk.

The semantic contract this guards:

    IsFltComponent("Unknown") == true when hasAllowlist == true

Implemented as a source-grep test because the interceptor is C# and the
Python test suite has no .NET test harness; the existing pattern in this
repo (see test_framework_endpoints_lint.py, test_qa_signalr_contract.py,
test_signalr_migration.py) is to assert structural invariants against the
C# source string.
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


def _isfltcomponent_body(source: str) -> str:
    """Return the body of the IsFltComponent method.

    We can't use a naive `\\{ .*? \\}` regex because the method has nested
    braces (foreach loop). Slice from the method's opening brace to the
    start of the next `private` / `public` / `internal` member.
    """
    match = re.search(r"private\s+bool\s+IsFltComponent\s*\(string\s+component\s*\)\s*\{", source)
    assert match, "IsFltComponent method not found"
    after_brace = match.end()
    # Find the next method declaration after this one — its body ends just before that.
    next_member = re.search(
        r"\n\s*(private|public|internal|protected)\s+",
        source[after_brace:],
    )
    end = after_brace + next_member.start() if next_member else len(source)
    return source[after_brace:end]


class TestUnknownComponentAllowed:
    """Unknown-component logs must pass the allowlist filter."""

    def test_isfltcomponent_returns_true_for_unknown(self, interceptor_source: str) -> None:
        """Body of IsFltComponent must contain a Unknown -> true branch."""
        body = _isfltcomponent_body(interceptor_source)
        assert re.search(
            r'component\s*==\s*"Unknown".*?return\s+true', body, re.DOTALL
        ), (
            'IsFltComponent must explicitly return true for component == "Unknown" '
            "(post-mortem 2026-05-26 — without this, untagged FLT internal logs are "
            "dropped the moment edog-flt-components.json exists on disk)."
        )

    def test_unknown_not_paired_with_return_false(self, interceptor_source: str) -> None:
        """The buggy `component == \"Unknown\"` -> return false branch is gone."""
        body = _isfltcomponent_body(interceptor_source)
        assert not re.search(
            r"IsNullOrEmpty\s*\(\s*component\s*\)\s*\|\|\s*component\s*==\s*\"Unknown\"",
            body,
        ), (
            'Found the pre-fix branch that pairs IsNullOrEmpty(component) || component=="Unknown" '
            "with return false. That branch killed every internal Tracer.LogSanitized* call "
            "lacking a [BracketedComponent] prefix. Treat Unknown as a separate branch."
        )

    def test_empty_component_still_returns_false(self, interceptor_source: str) -> None:
        """Empty/null component (defensive — should never happen) still rejected."""
        body = _isfltcomponent_body(interceptor_source)
        assert re.search(
            r"IsNullOrEmpty\s*\(\s*component\s*\).*?return\s+false", body, re.DOTALL
        ), "IsNullOrEmpty(component) -> return false branch must remain"
