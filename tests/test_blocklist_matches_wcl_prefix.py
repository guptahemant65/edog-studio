"""
Blocklist patterns must match the RAW codeMarkerName, not the post-stripped
frontend display name.

Bug history:

EdogLogInterceptor calls ``BlocklistFilter.Instance.IsBlocked(rawCodeMarker)``
where ``rawCodeMarker = MonitoredScope.CurrentCodeMarkerName``. The raw form
for WCL-instrumented components is prefixed with ``WCL-`` (e.g.
``WCL-IncomingRequest``, ``WCL-WorkloadInitialization``, ``WCL-PbiClientRequest``).

The frontend strips the ``WCL-`` prefix before displaying (see
``EdogLogInterceptor.ExtractComponent``). The blocklist patterns were
authored using the post-stripped names — ``^IncomingRequest`` etc. — and
therefore NEVER matched the raw form. Result: ~70% of platform noise that
the blocklist was supposed to drop at the source was leaving the FLT
process every iteration.

Live evidence (5360-entry buffer captured 2026-06-07):
  - 946 ``IncomingRequest`` (rawCodeMarker = ``WCL-IncomingRequest``)
  - 834 ``WorkloadInitialization`` (raw = ``WCL-WorkloadInitialization``)
  - 261 ``PbiClientRequest`` (raw = ``WCL-PbiClientRequest``)
  - 183 ``FabricAccessContext-WorkloadClientRequest`` (raw = ``WCL-FabricAccessContext-...``)
  - ... 3741 total non-FLT entries (69.8% of the buffer)

Fix: rewrite the affected patterns to accept the optional ``WCL-`` prefix,
e.g. ``^(WCL-)?IncomingRequest``. Source-level guard: the dominant
WCL-prefixed components must each have a pattern that, applied against
``WCL-<name>``, returns True.

@author Pixel — EDOG Studio hivemind
"""

from __future__ import annotations

import json
import pathlib
import re

import pytest

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
BLOCKLIST_JSON = PROJECT_ROOT / "src" / "backend" / "DevMode" / "edog-blocklist.json"


@pytest.fixture(scope="module")
def compiled_patterns() -> list[re.Pattern[str]]:
    raw = json.loads(BLOCKLIST_JSON.read_text(encoding="utf-8"))
    out: list[re.Pattern[str]] = []
    for entry in raw.get("blocked", []):
        pat = entry.get("pattern")
        if pat:
            # Mirror BlocklistFilter.cs flags: IgnoreCase | CultureInvariant.
            out.append(re.compile(pat, re.IGNORECASE))
    return out


def _is_blocked(name: str, patterns: list[re.Pattern[str]]) -> bool:
    return any(p.search(name) for p in patterns)


class TestBlocklistMatchesWclPrefixedRawNames:
    """Each WCL-prefixed dominant noise emitter must be blocked at the source."""

    @pytest.mark.parametrize(
        "raw_code_marker, observed_count",
        [
            # Counts from a live 5360-entry buffer captured 2026-06-07.
            # Each of these slipped through the original allowlist-shaped
            # blocklist because ^IncomingRequest doesn't match WCL-IncomingRequest.
            ("WCL-IncomingRequest", 946),
            ("WCL-WorkloadInitialization", 834),
            ("WCL-PbiClientRequest", 261),
            ("WCL-FabricAccessContext", 183),
            ("WCL-FabricAccessContext-WorkloadClientRequest", 183),
            ("WCL-MwcAccessInfoProvider", 72),
            ("WCL-MwcAccessInfoProvider-GetMwcS2SAccessInfo", 72),
            ("WCL-AuthenticationEngine", 60),
            ("WCL-ReportUsageMetrics", 48),
            ("WCL-DependencyMonitoring", 32),
            ("WCL-OneLakeRequestTracing", 48),
        ],
    )
    def test_wcl_prefixed_noise_is_blocked(
        self,
        compiled_patterns: list[re.Pattern[str]],
        raw_code_marker: str,
        observed_count: int,
    ) -> None:
        assert _is_blocked(raw_code_marker, compiled_patterns), (
            f"{raw_code_marker!r} (observed {observed_count}x in live buffer) "
            f"is not matched by any blocklist pattern. The raw codeMarkerName "
            f"includes the WCL- prefix; the blocklist must accept it."
        )

    @pytest.mark.parametrize(
        "raw_code_marker",
        [
            # Components observed in live traffic that are NOT yet in the
            # blocklist and are pure platform noise. Adding them costs nothing
            # and drops further bandwidth.
            "WorkloadEnvironmentProvider",
            "OrchestratorControllerProxy-GenerateMwcToken",
            "GenerateMwcTokenV2Internally",
            "RedisPerformOperationAsync",
            # MwcAccessInfoProvider-GetPbiS2SAccessInfo — already covered by
            # ^(WCL-)?MwcAccessInfoProvider via the WCL fix above.
        ],
    )
    def test_newly_added_noise_is_blocked(
        self,
        compiled_patterns: list[re.Pattern[str]],
        raw_code_marker: str,
    ) -> None:
        assert _is_blocked(raw_code_marker, compiled_patterns), (
            f"{raw_code_marker!r} is pure platform noise observed in live "
            f"traffic. Add a blocklist pattern for it."
        )


class TestFltComponentsStillPassThrough:
    """Sanity guard: the FLT components we actually want to see must NOT be blocked."""

    @pytest.mark.parametrize(
        "raw_code_marker",
        [
            "LiveTableController-Get",
            "LiveTableController-GetLatestDAG",
            "LiveTableSchedulerRunController-MVRefresh",
            "LiveTableSchedulerRunController-GetDAGExecStatus",
            "LiveTable-OL-FSRequest-ListAll",
            "LiveTable-OL-FSRequest-GetFileMetadata",
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
        raw_code_marker: str,
    ) -> None:
        assert not _is_blocked(raw_code_marker, compiled_patterns), (
            f"{raw_code_marker!r} is a legitimate FLT component and MUST NOT "
            f"be blocked at source. A blocklist pattern is over-broad."
        )
