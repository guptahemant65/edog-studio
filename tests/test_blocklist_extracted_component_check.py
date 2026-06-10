"""
The blocklist must match against the EXTRACTED component name too, not
just the raw ``MonitoredScope.CurrentCodeMarkerName``.

Bug history:

After the WCL-prefix fix (test_blocklist_matches_wcl_prefix.py), live
inspection showed a new dominant noise bucket: 228 of 398 entries with
``component = "Unknown"`` and ``rawCodeMarker = ""``. These are
framework/startup logs emitted outside any ``MonitoredScope``: workload
startup, feature-flight resolution, serializer init.

``EdogLogInterceptor.ExtractComponent`` derives a useful display name
when raw is empty by parsing the message body (strategies 1 & 2).
The blocklist, however, only looks at the raw codeMarker — so it can
never match these entries, and they ship to the frontend.

Two failure modes:
  1. Raw is empty AND the message has no [Bracket]/CompoundCase prefix
     → display name = "Unknown" (228 entries observed)
  2. Raw is empty BUT message DOES have a CompoundCase prefix (e.g.
     ``WorkloadEnvironmentProvider: ...``) → display name is useful but
     blocklist still sees empty raw (~50 entries spread across 8+
     distinct components)

Fix: extend the interceptor to consult the blocklist with BOTH the
raw codeMarker AND the extracted component. JSON patterns can then
target either form. Source-level guard: ``IsBlocked(component)`` must
be called somewhere downstream of ``ExtractComponent``.

@author Pixel — EDOG Studio hivemind
"""

from __future__ import annotations

import json
import pathlib
import re

import pytest

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
INTERCEPTOR_PATH = PROJECT_ROOT / "src" / "backend" / "DevMode" / "EdogLogInterceptor.cs"
BLOCKLIST_JSON = PROJECT_ROOT / "src" / "backend" / "DevMode" / "edog-blocklist.json"


@pytest.fixture(scope="module")
def interceptor_source() -> str:
    return INTERCEPTOR_PATH.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def compiled_patterns() -> list[re.Pattern[str]]:
    raw = json.loads(BLOCKLIST_JSON.read_text(encoding="utf-8"))
    out: list[re.Pattern[str]] = []
    for entry in raw.get("blocked", []):
        pat = entry.get("pattern")
        if pat:
            out.append(re.compile(pat, re.IGNORECASE))
    return out


def _is_blocked(name: str, patterns: list[re.Pattern[str]]) -> bool:
    return any(p.search(name) for p in patterns)


class TestInterceptorChecksExtractedComponent:
    """C# source guard: IsBlocked is called against the extracted component."""

    def test_interceptor_consults_blocklist_with_component(self, interceptor_source: str) -> None:
        # Strip comments so a documentation reference doesn't satisfy the guard.
        stripped = re.sub(r"//[^\n]*", "", interceptor_source)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        # The fix should produce one of these idiomatic forms. We accept either
        # an explicit second IsBlocked(component) call or a combined expression
        # so future refactors don't break the guard for cosmetic reasons.
        # Strong assertion: the literal component-form call must be present.
        assert "IsBlocked(component)" in stripped, (
            "EdogLogInterceptor.TraceEvent must consult the blocklist against the "
            "extracted component name too (not just the raw codeMarker). Without "
            "this, framework-emitted logs with empty raw codeMarker ('Unknown' "
            "in the UI) cannot be filtered at source."
        )


class TestExtractedComponentNamesAreBlocked:
    """Newly-blocklisted display names — verify the JSON patterns match."""

    @pytest.mark.parametrize(
        "extracted_component, why",
        [
            ("Unknown", "228 entries with empty raw codeMarker fall back to 'Unknown'"),
            ("WorkloadEnvironmentProvider", "extracted via CompoundPascalCase prefix from message"),
            ("StartupConfigurationProvider", "platform startup chatter"),
            ("GetUserAadAuthenticator", "platform auth chatter"),
            ("CustomerPrincipalAuthenticator", "platform auth chatter"),
            ("WorkloadCertificateUtils", "platform cert chatter"),
            ("StartWorkloadEndpoint", "WCL- prefixed; covered by ^(WCL-)?StartWorkloadEndpoint"),
            ("WCL-StartWorkloadEndpoint", "raw form"),
            ("PrivateLinkCaching", "WCL- prefixed verbose chatter"),
            ("WCL-PrivateLinkCaching", "raw form"),
            ("RealTimeConsumptionService-UpdateMinimumSmoothingWindowFeatureFlight", "verbose"),
            ("SignedPayloadHandlerContinuousUpdates", "verbose"),
            ("MwcTokenHandlerContinuousUpdates", "platform token rotation chatter"),
        ],
    )
    def test_pattern_blocks(
        self,
        compiled_patterns: list[re.Pattern[str]],
        extracted_component: str,
        why: str,
    ) -> None:
        assert _is_blocked(extracted_component, compiled_patterns), (
            f"{extracted_component!r} should be blocked. Context: {why}."
        )


class TestFltComponentsStillSafe:
    """Sanity guard: the newly-added patterns must not over-reach into FLT signal."""

    @pytest.mark.parametrize(
        "raw_or_extracted_name",
        [
            "LiveTableController-Get",
            "LiveTableSchedulerRunController-MVRefresh",
            "DagExecutionHandlerV2",
            "NodeExecutor",
            "DqMetricsBatchWrite",
            "InsightsTableCreation",
            "OneLakeRestClient",
            "LTWorkload-FeatureFlightProvider-IsEnabled",
        ],
    )
    def test_flt_component_not_blocked(
        self,
        compiled_patterns: list[re.Pattern[str]],
        raw_or_extracted_name: str,
    ) -> None:
        assert not _is_blocked(raw_or_extracted_name, compiled_patterns), (
            f"{raw_or_extracted_name!r} is a legitimate FLT component and MUST NOT be blocked."
        )
