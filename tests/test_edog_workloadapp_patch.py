"""Tests for the EDOG WorkloadApp.cs split-anchor patch (Phase 2a).

The single patch was failing 10 of 12 interceptors at runtime because
`EdogDevModeRegistrar.RegisterAll()` was invoked during the constructor —
before `WorkloadContextInitializer.InitializeAsync()` had wired up the MWC
platform services (`IWorkloadContext`, `IParametersProvider`, etc.) that
the interceptors depend on. These tests pin the new two-anchor patch
behaviour:

  • Patch A (telemetry wrap) stays at the constructor anchor.
  • Patch B (Tracer reset + RegisterAll) runs at a new post-InitializeAsync
    anchor (the `DependencyHandler.Resolve<IReliableOperationsManager>()`
    line) so MWC platform services are resolvable when interceptors load.

Roundtrip: apply → revert must equal the original byte-for-byte.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

PROJECT_DIR = Path(__file__).resolve().parents[1]
EDOG_PY = PROJECT_DIR / "edog.py"

# Synthetic minimal WorkloadApp.cs containing only the two anchors. Avoids
# coupling the tests to a specific FLT checkout that may evolve.
_SAMPLE = """\
namespace Microsoft.LiveTable.Service
{
    public class WorkloadApp
    {
        public WorkloadApp()
        {
            // Telemetry
            WireUp.RegisterSingletonType<ICustomLiveTableTelemetryReporter, CustomLiveTableTelemetryReporter>();
        }

        public async Task RunAsync(IPlatformBridge platformBridge)
        {
            this.workloadContext = await WorkloadContextInitializer.InitializeAsync(
                platformBridge,
                this,
                initializationCallback: async workloadContext =>
                {
                    WireUp.RegisterInstance(workloadContext.MonikerManager);
                });

            DependencyHandler.Resolve<IReliableOperationsManager>();
            HashSet<ITypedReliableOperationHandler> reliableOpHandlers = new ()
            {
                WireUp.Resolve<DagExecutionHandlerV2>(),
            };
        }
    }
}
"""


@pytest.fixture(scope="module")
def edog():
    spec = importlib.util.spec_from_file_location("edog_workloadapp_patch", EDOG_PY)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(EDOG_PY.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.pop(0)
    return mod


# ── Apply ────────────────────────────────────────────────────────────────


def test_apply_returns_three_tuple(edog):
    """Caller in apply_all_changes unpacks (content, status, warnings)."""
    result = edog.apply_log_viewer_registration_workloadapp_cs(_SAMPLE)
    assert isinstance(result, tuple) and len(result) == 3


def test_apply_both_patches_land(edog):
    new_content, status, warnings = edog.apply_log_viewer_registration_workloadapp_cs(_SAMPLE)
    assert status == "applied"
    assert warnings == []
    assert "EdogTelemetryInterceptor" in new_content
    assert "EdogDevModeRegistrar.RegisterAll()" in new_content


def test_apply_register_all_runs_after_initialize_async(edog):
    """The whole point of this patch. RegisterAll() must be invoked AFTER
    WorkloadContextInitializer.InitializeAsync() has wired the MWC platform
    services. If this regresses, 10/12 interceptors fail again silently."""
    new_content, _, _ = edog.apply_log_viewer_registration_workloadapp_cs(_SAMPLE)
    ia_pos = new_content.find("WorkloadContextInitializer.InitializeAsync")
    ra_pos = new_content.find("EdogDevModeRegistrar.RegisterAll()")
    rom_pos = new_content.find("DependencyHandler.Resolve<IReliableOperationsManager>()")
    assert ia_pos > 0, "InitializeAsync anchor missing"
    assert ra_pos > ia_pos, "RegisterAll() must come after InitializeAsync()"
    assert rom_pos > ra_pos, "ReliableOperationsManager anchor must remain after RegisterAll()"


def test_apply_telemetry_wrap_at_constructor_anchor(edog):
    """Telemetry wrap stays at the constructor anchor (no MWC services needed)."""
    new_content, _, _ = edog.apply_log_viewer_registration_workloadapp_cs(_SAMPLE)
    tw_pos = new_content.find("EdogTelemetryInterceptor")
    ia_pos = new_content.find("WorkloadContextInitializer.InitializeAsync")
    assert tw_pos > 0
    assert tw_pos < ia_pos, "Telemetry wrap should remain at constructor (pre-InitializeAsync)"


# ── Idempotency ──────────────────────────────────────────────────────────


def test_apply_twice_is_already_applied(edog):
    once, _, _ = edog.apply_log_viewer_registration_workloadapp_cs(_SAMPLE)
    twice, status, warnings = edog.apply_log_viewer_registration_workloadapp_cs(once)
    assert status == "already_applied"
    assert warnings == []
    assert twice == once


# ── Partial application (one anchor missing) ─────────────────────────────


def test_apply_only_constructor_anchor_present(edog):
    only_a = "WireUp.RegisterSingletonType<ICustomLiveTableTelemetryReporter, CustomLiveTableTelemetryReporter>();"
    new_content, status, warnings = edog.apply_log_viewer_registration_workloadapp_cs(only_a)
    assert status == "applied"
    assert "EdogTelemetryInterceptor" in new_content
    assert any("post-InitializeAsync" in w for w in warnings)


def test_apply_only_post_init_anchor_present(edog):
    only_b = "DependencyHandler.Resolve<IReliableOperationsManager>();"
    new_content, status, warnings = edog.apply_log_viewer_registration_workloadapp_cs(only_b)
    assert status == "applied"
    assert "EdogDevModeRegistrar.RegisterAll()" in new_content
    assert any("constructor anchor" in w for w in warnings)


def test_apply_no_anchors_reports_pattern_not_found(edog):
    new_content, status, warnings = edog.apply_log_viewer_registration_workloadapp_cs("public class Foo {}")
    assert status == "pattern_not_found"
    assert len(warnings) == 2
    assert new_content == "public class Foo {}"


# ── Roundtrip ────────────────────────────────────────────────────────────


def test_roundtrip_byte_for_byte(edog):
    """apply → revert must restore the original exactly. Without this the
    patch leaves drift across deploys (extra blank lines, indent damage)
    that compounds and eventually breaks compilation."""
    patched, _, _ = edog.apply_log_viewer_registration_workloadapp_cs(_SAMPLE)
    reverted = edog.revert_log_viewer_registration_workloadapp_cs(patched)
    assert reverted == _SAMPLE


def test_revert_handles_legacy_single_anchor_format(edog):
    """A repo patched by the previous edog.py (everything at the constructor
    anchor) must still revert cleanly so older checkouts remain serviceable."""
    legacy_patched = _SAMPLE.replace(
        "WireUp.RegisterSingletonType<ICustomLiveTableTelemetryReporter, CustomLiveTableTelemetryReporter>();",
        (
            "// EDOG DevMode - Wrap telemetry reporter with web log viewer interceptor\n"
            "            WireUp.RegisterInstance<ICustomLiveTableTelemetryReporter>(\n"
            "                new Microsoft.LiveTable.Service.DevMode.EdogTelemetryInterceptor(\n"
            "                    new CustomLiveTableTelemetryReporter(),\n"
            "                    WireUp.Resolve<Microsoft.LiveTable.Service.DevMode.EdogLogServer>()));\n"
            "\n"
            "            // EDOG DevMode - Re-set Tracer test logger after platform init\n"
            "            // (must be set here, inside RunAsync, so it persists after PlatformLogger is configured)\n"
            "            Microsoft.ServicePlatform.Telemetry.Tracer.SetStructuredTestLogger(\n"
            "                new Microsoft.LiveTable.Service.DevMode.EdogLogInterceptor(\n"
            "                    WireUp.Resolve<Microsoft.LiveTable.Service.DevMode.EdogLogServer>()));\n"
            "\n"
            "            // EDOG DevMode - Register all runtime interceptors (Phase 2)\n"
            "            Microsoft.LiveTable.Service.DevMode.EdogDevModeRegistrar.RegisterAll();"
        ),
    )
    reverted = edog.revert_log_viewer_registration_workloadapp_cs(legacy_patched)
    assert reverted == _SAMPLE
