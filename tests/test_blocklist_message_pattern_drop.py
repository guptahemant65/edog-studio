"""
Bucket C — narrow message-pattern drop for known platform Warning noise.

Bug history:

The blocklist deliberately bypasses Errors and Warnings so real failures
are never hidden. In dev mode the AppInsights metric pipeline can't
initialize its dimensions, so every component emits the warning::

    Failed to create metric:<name> in namespace <ns> because platform
    dimensions could not be initialized (code=0, message=Dimension
    values are not set ...)

Two sibling messages from the same root cause::

    Initialization of ServiceMetric platform dimensions failed because
    the context is not initialized

    Cannot retrieve SSL protocol since http response message content
    stream is null

These three message patterns produce hundreds of Warning-level entries
per DAG run. They are NOT failures we care about — they are dev-mode
infrastructure noise that bypasses the blocklist precisely because
they happen to be tagged Warning.

Fix: introduce a NARROW message-pattern drop list in
``edog-blocklist.json`` under the key ``messageBlocked``. Patterns are
matched against the message body (not the codeMarker) for
Warning/Error entries. The override is explicit and bounded — each
pattern requires a reason, sanity tests prove real failure messages
are NOT matched.

@author Pixel — EDOG Studio hivemind
"""

from __future__ import annotations

import json
import pathlib
import re

import pytest

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
INTERCEPTOR_PATH = PROJECT_ROOT / "src" / "backend" / "DevMode" / "EdogLogInterceptor.cs"
BLOCKLIST_FILTER_PATH = PROJECT_ROOT / "src" / "backend" / "DevMode" / "BlocklistFilter.cs"
BLOCKLIST_JSON = PROJECT_ROOT / "src" / "backend" / "DevMode" / "edog-blocklist.json"


@pytest.fixture(scope="module")
def blocklist_data() -> dict:
    return json.loads(BLOCKLIST_JSON.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def message_patterns(blocklist_data: dict) -> list[re.Pattern[str]]:
    raw = blocklist_data.get("messageBlocked", [])
    return [re.compile(e["pattern"], re.IGNORECASE) for e in raw if e.get("pattern")]


def _is_message_blocked(msg: str, patterns: list[re.Pattern[str]]) -> bool:
    return any(p.search(msg) for p in patterns)


class TestMessageBlocklistSchema:
    """JSON exposes a messageBlocked array with the expected shape."""

    def test_message_blocked_array_present(self, blocklist_data: dict) -> None:
        assert "messageBlocked" in blocklist_data, (
            "edog-blocklist.json must declare a messageBlocked array even if empty"
        )
        assert isinstance(blocklist_data["messageBlocked"], list)

    def test_message_blocked_entries_have_pattern_and_reason(self, blocklist_data: dict) -> None:
        for i, entry in enumerate(blocklist_data.get("messageBlocked", [])):
            assert isinstance(entry, dict), f"messageBlocked[{i}] must be an object"
            assert entry.get("pattern"), f"messageBlocked[{i}] missing 'pattern'"
            assert entry.get("reason"), (
                f"messageBlocked[{i}] missing 'reason' — every message-level "
                f"override MUST document why this Warning/Error is safe to drop"
            )

    def test_message_blocked_patterns_compile(self, blocklist_data: dict) -> None:
        for i, entry in enumerate(blocklist_data.get("messageBlocked", [])):
            try:
                re.compile(entry["pattern"])
            except re.error as e:
                pytest.fail(f"messageBlocked[{i}] pattern is invalid regex: {e}")


# ── Known dev-mode noise — these MUST be blocked ────────────────────────────


class TestDevModeNoiseIsBlocked:
    """The three known dev-mode AppInsights/SSL chatter messages are dropped."""

    @pytest.mark.parametrize(
        "msg",
        [
            "Failed to create metric:ConcurrentOperations in namespace OperationCounters because platform dimensions could not be initialized (code=0, message=Dimension values are not set (edog.pbidedicated.windows-int.net;N/A; _Node_1;...))",
            "Failed to create metric:AverageDurationOfCompletedOperations in namespace OperationCounters because platform dimensions could not be initialized (code=0, message=...)",
            "Failed to create metric:PbiClient_latency in namespace DependencyMonitoring because platform dimensions could not be initialized",
            "Failed to create metric:PbiClient_availablity in namespace DependencyMonitoring because platform dimensions could not be initialized",
            "Initialization of ServiceMetric platform dimensions failed because the context is not initialized",
            "Cannot retrieve SSL protocol since http response message content stream is null",
        ],
    )
    def test_appinsights_noise_blocked(
        self, message_patterns: list[re.Pattern[str]], msg: str
    ) -> None:
        assert _is_message_blocked(msg, message_patterns), (
            f"Dev-mode noise message must be blocked: {msg[:120]}..."
        )


class TestRound2DevModeNoiseBlocked:
    """Second round of message-pattern drops (2026-06-07).

    Each pattern was validated against live noise survivors after v7 deploy.
    The 'corresponding row' column in each parametrize entry below names the
    Drop List Row in Donna's analysis (table of 7 patterns dropping 124 entries).
    """

    @pytest.mark.parametrize(
        "msg, row",
        [
            # Row 2 — Cert store gap (dev-mode). 23 entries observed.
            ("Could not find certificate with CN 'test.s2s.pbidedicated.windows-int.net'.", "cert"),
            ("Could not find certificate with CN 'edog.deployment.pbidedicated.windows-int.net'.", "cert"),
            ("Could not find certificate with CN 'edog.mwctoken.pbidedicated.windows-int.net'.", "cert"),
            ("Could not find certificate with CN 'edog.mwctokenencryption.pbidedicated.windows-int.net'.", "cert"),
            ("Could not find certificate with CN 'edog.signedpayload.pbidedicated.windows-int.net'.", "cert"),
            ("Could not find certificate with CN 'edog.mdsmonitoring.pbidedicated.windows-int.net'.", "cert"),
            ("Could not find certificate with CN 'edog.mdmmonitoring.pbidedicated.windows-int.net'.", "cert"),
            ("Could not find certificate with CN 'livetable.workload.localhost.pbidedicated.windows-int.net'.", "cert"),
            # Row 3 — DependencyMonitoring failed-to-report. 20 entries.
            ("[DependencyMonitoring] Failed to report availablity value for PbiClient_availablity", "depmon"),
            ("[DependencyMonitoring] Failed to report latency value for PbiClient_latency", "depmon"),
            ("[DependencyMonitoring] Failed to report availablity value for Redis_availablity", "depmon"),
            ("[DependencyMonitoring] Failed to report latency value for Redis_latency", "depmon"),
            ("[DependencyMonitoring] Failed to report availablity value for AAD_availablity", "depmon"),
            # Row 4 — Throttling-skipped middleware chatter. 12 entries.
            ("Throttling is skipped for the route via SkipThrottlingAttribute", "throttle-skip"),
            # Row 5 — Invalid throttling-delay header. 11 entries.
            ("x-ms-workload-throttling-delay header value  is invalid", "throttle-delay"),
            ("x-ms-workload-throttling-delay header value is invalid", "throttle-delay"),
            # Row 6 — Serializer init benign warning. 7+ entries.
            ('{"code":"InternalError","subCode":0,"message":"Type \'Microsoft.ServicePlatform.Utilities.IFlightDelegateCaller\' with name \'\' was not registered in the container before resolution","timeStamp":"2026-06-06T21:07:27.2742631Z"}', "serializer-init"),
            ("Flight 'MWC_SerializerLockFreeImplementation' evaluation failed with exception. Defaulting to legacy implementation.", "serializer-init"),
            # Row 7 — CertifiedEvents partial type load. 3 entries.
            ("Partial type load for assembly Microsoft.CertifiedEvents.Server: 2 loader exception(s). Scanning 104 loaded type(s).", "certified-events"),
            # Row 1 — AuthenticationEngine noise. 48 entries (mix of 4 message shapes).
            ("Authentication failed 'PlatformServicePrincipalAadAuthenticator`1' on controller", "auth"),
            ("oid claim is not present in AuthenticationContext", "auth"),
            ("upn claim is not present in AuthenticationContext", "auth"),
            ("oid claim is missing for app cb4dc29f-0bf4-402a-8b30-7511498ed654. Ignoring in P3SAuthorization", "auth"),
            ("oid claim is missing for app 00000009-0000-0000-c000-000000000000. Ignoring in P3SAuthorization", "auth"),
            # ── Round 3 (2026-06-07) — Noise INSIDE FLT-baseline components ─
            # These bypass component blocklist because their raw codeMarker
            # (LiveTableController-*, LiveTable-OL-FSRequest-*) is FLT signal.
            # The message itself is pure ServicePlatform / WCL chatter.
            #
            # IMPORTANT: this requires the interceptor to call IsMessageBlocked
            # UNCONDITIONALLY (not only for isError). See
            # TestInterceptorConsultsMessageFilterUnconditionally below.
            ("Initializing ServiceMetric platform dimensions", "metric-init-chatter"),
            ("Set the 'x-ms-root-activity-id' request header.", "raid-header-chatter"),
            # Round 4 — JSON-shaped InternalError from Orchestrator controller probes.
            # Fires from WorkloadInitialization during dev-mode bootstrap when
            # the orchestrator-side controller isn't reachable / responds non-2xx.
            ('{"code":"InternalError","subCode":0,"message":"Received non-success response from the Orchestrator(OrchestratorController.GetCapacity)","timeStamp":"2026-06-06T21:24:25Z"}', "orch-non-success"),
            ('{"code":"InternalError","subCode":0,"message":"Received non-success response from the Orchestrator(SomeOtherEndpoint)"}', "orch-non-success"),
            # ── Round 5 (2026-06-07) — post-correlator noise sweep ─────────
            # These survived through component blocklist because their level
            # is Warning (or the component is FLT-baseline), but the message
            # itself is pure dev-mode chatter.
            ("Artifact operation audit context is set.", "audit-context-noop"),
            ("Caller identity is not set for SecurityAuditCallerIdentityType.ObjectID", "audit-caller-noop"),
            ("LiveTable additional telemetry details", "telemetry-reporter-noop"),
            # Round 5 fix — existing oid-claim pattern handled only the
            # "Ignoring in P3SAuthorization" suffix; live traffic showed
            # "Ignoring in PPE" too. Both must drop.
            ("oid claim is missing for app cb4dc29f-0bf4-402a-8b30-7511498ed654. Ignoring in PPE", "oid-missing-ppe"),
            ("oid claim is missing for app 00000009-0000-0000-c000-000000000000. Ignoring in PPE", "oid-missing-ppe"),
        ],
    )
    def test_round2_noise_blocked(
        self, message_patterns: list[re.Pattern[str]], msg: str, row: str
    ) -> None:
        assert _is_message_blocked(msg, message_patterns), (
            f"[{row}] Round-2 noise message must be blocked: {msg[:120]}..."
        )


# ── CRITICAL sanity guard — real FLT failures MUST NOT be muzzled ───────────


class TestRealFltFailuresAreNotMuzzled:
    """Sentinel guard: no messageBlocked pattern may match a real FLT failure.

    If any of these fail, the override is over-broad and a real production
    failure could be silently dropped. ALL of these must continue to pass.
    """

    @pytest.mark.parametrize(
        "msg",
        [
            # MLV error codes (must pass through)
            "MLV_SPARK_SESSION_ACQUISITION_FAILED: Failed to acquire Spark session after 4 retries",
            "MLV_DAG_HAS_FAULTED_NODES: 2 nodes faulted during DAG construction",
            "MLV_SOURCE_ENTITY_NOT_FOUND: Source entity 'bronze.orders' not found in catalog",
            "MLV_RUNTIME_ERROR: Failed to execute MLV",
            # Node execution failures
            "Node 'dbo.data_view' failed with error: An internal error occurred.",
            "Failed to execute node 'dbo.summary' with final status Failed",
            "[Artifact: cd654090-..., Iteration: 28f7c245-..., TransformationId: 7efe79df-..., Node name: dbo.data_view] GTS error message: 'An internal error occurred.'",
            # Generic infra failures we DO want to see
            "Failed to retrieve token from MWC token manager",
            "OneLake REST request failed: 403 Forbidden",
            "Connection to GTS service refused",
            "DAG execution cancelled by user",
            # Edge cases that look superficially similar to the noise patterns
            "Failed to create transform for node 'X' — invalid SQL",
            "Initialization of Spark session failed because cluster unavailable",
            "Cannot retrieve table metadata since lakehouse is not accessible",
            # ── Round 2 sanity additions (2026-06-07) ────────────────────
            # Cert chain — different shape from "Could not find certificate with CN '..'"
            "CertificateKeyNotSupportedException: The certificate key 'workload.livetable' is not supported.",
            "Certificate validation failed for endpoint https://example.pbidedicated.windows-int.net/",
            "Certificate 'workload.livetable' has expired",
            # DependencyMonitoring — substring '[DependencyMonitoring]' may appear in non-noise contexts
            "[DependencyMonitoring] Failed to record retry — Spark cluster timeout",
            "[DependencyMonitoring] Critical dependency 'GTS' unavailable",
            # Throttling — real throttling decisions vs the no-op middleware chatter
            "Throttling DECISION: capacity B282D2F6 throttled (CU=98%)",
            "Capacity throttling triggered — 5 requests rejected",
            # Auth — real auth failures vs the platform-claim no-op warnings
            "Authentication failed for user 'hemant@example.com' on POST /runDAG — invalid token",
            "Authorization denied for action runDAG on lakehouse cd654090",
            "Authentication failed because S2S token has expired",
            # JSON-shaped real errors that mention InternalError but aren't the serializer-init noise
            '{"code":"MLV_LINEAGE_CREATION_FAILURE","subCode":0,"message":"Failed to build DAG","exceptionType":"InternalError"}',
            '{"code":"InternalError","message":"GTS submit returned 500"}',
            # InternalError envelopes that are NOT the orchestrator-probe noise
            '{"code":"InternalError","subCode":0,"message":"Received non-success response from GTS: 500"}',
            '{"code":"InternalError","subCode":0,"message":"Received non-success response from OneLake REST"}',
            # Type-load — real type load failures vs the CertifiedEvents partial-load chatter
            "Type load exception in assembly Microsoft.LiveTable.Service.Core: missing reference",
            # ── Round 5 sanity additions (2026-06-07) ───────────────────
            # Audit / caller identity — pattern targets the no-op middleware shape;
            # real audit failures use a different shape.
            "Artifact operation audit context FAILED to set due to invalid context.",
            "Caller identity validation failed for protected endpoint",
            # Telemetry reporter — pattern is anchored exact-match; any decorated
            # variant or real failure with similar wording should pass.
            "LiveTable additional telemetry details could not be flushed: timeout",
            "Failed to emit LiveTable additional telemetry details",
            # oid PPE — pattern is structured; real auth denials with different shape pass.
            "oid claim verification failed for app cb4dc29f-...: token expired",
        ],
    )
    def test_real_failure_not_blocked(
        self, message_patterns: list[re.Pattern[str]], msg: str
    ) -> None:
        assert not _is_message_blocked(msg, message_patterns), (
            f"OVER-BROAD MESSAGE PATTERN — this message would have been silently "
            f"muzzled even though it is a real failure: {msg!r}. "
            f"Tighten the messageBlocked regex to exclude this case."
        )


# ── Source-level guards: C# wires the message filter into the bypass path ──


class TestBlocklistFilterApiSurface:
    """BlocklistFilter exposes IsMessageBlocked for message-body matching."""

    def test_is_message_blocked_method_exists(self) -> None:
        src = BLOCKLIST_FILTER_PATH.read_text(encoding="utf-8")
        assert "IsMessageBlocked" in src, (
            "BlocklistFilter must expose IsMessageBlocked(string message) for "
            "the EdogLogInterceptor warning-bypass override path"
        )

    def test_message_patterns_loaded(self) -> None:
        src = BLOCKLIST_FILTER_PATH.read_text(encoding="utf-8")
        # The loader must read the messageBlocked array from the JSON.
        assert "messageBlocked" in src, (
            "BlocklistFilter.Load must consume the messageBlocked JSON array"
        )


class TestInterceptorConsultsMessageFilter:
    """EdogLogInterceptor's isError-bypass MUST first call IsMessageBlocked."""

    def test_interceptor_calls_is_message_blocked(self) -> None:
        src = INTERCEPTOR_PATH.read_text(encoding="utf-8")
        # Strip comments to avoid documentation-only references satisfying the guard.
        stripped = re.sub(r"//[^\n]*", "", src)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        assert "IsMessageBlocked" in stripped, (
            "EdogLogInterceptor.TraceEvent must call IsMessageBlocked(message) "
            "even for Errors/Warnings so known dev-mode Warning noise is dropped"
        )


class TestInterceptorConsultsMessageFilterUnconditionally:
    """Round-3 (2026-06-07): IsMessageBlocked must apply to ALL levels.

    Earlier rounds wired IsMessageBlocked only inside the isError branch
    (Warning/Error bypass override). Round 3 added Verbose/Message-level
    drops for noise emitted from FLT-baseline components (e.g.
    'Initializing ServiceMetric platform dimensions' from
    LiveTableController-* components — the component is FLT signal, the
    message is platform chatter).

    Source-level guard: the message-blocklist check must appear outside
    or before any 'if (isError)' wrapper.
    """

    def test_message_blocked_is_unconditional(self) -> None:
        src = INTERCEPTOR_PATH.read_text(encoding="utf-8")
        # Find every call site of IsMessageBlocked and the line range.
        lines = src.splitlines()
        call_sites = [i for i, ln in enumerate(lines) if "IsMessageBlocked" in ln]
        assert call_sites, "IsMessageBlocked must be called from the interceptor"

        # At least one call site must NOT be inside an `if (isError && ...)`
        # short-circuit. We accept either:
        #   (a) a standalone `if (BlocklistFilter.Instance.IsMessageBlocked(message))`
        #   (b) any IsMessageBlocked call where the immediately surrounding
        #       if-condition does NOT mention isError.
        # The strictest, simplest check: look for the exact unconditional shape.
        unconditional_shapes = (
            "if (BlocklistFilter.Instance.IsMessageBlocked(message))",
            "if (BlocklistFilter.Instance.IsMessageBlocked(message)\n",
        )
        joined = "\n".join(lines)
        assert any(shape in joined for shape in unconditional_shapes), (
            "Round-3 requires an UNCONDITIONAL `if (BlocklistFilter.Instance."
            "IsMessageBlocked(message))` check — separate from the isError "
            "bypass — so noise emitted by FLT-baseline components at "
            "Verbose/Message level can be dropped too."
        )
