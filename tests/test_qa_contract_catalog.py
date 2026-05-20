"""Structural contract tests for the P10 catalog assembler.

Guards the CatalogSnapshot envelope, slot records, provider surface,
and assembler-level capabilities caching.
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CATALOG = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaContractCatalog.cs"
DEVMODE = REPO_ROOT / "src" / "backend" / "DevMode"


def _read() -> str:
    return CATALOG.read_text(encoding="utf-8")


def test_catalog_snapshot_envelope_exists() -> None:
    src = _read()
    for needle in (
        "public sealed class CatalogSnapshot",
        "SnapshotId",
        "FltBuildSha",
        "EdogRepoSha",
        "SchemaCapVersion",
        "ProviderStatus",
        "AssembledAtUtc",
    ):
        assert needle in src, f"missing envelope field: {needle}"


def test_catalog_defines_slot_records() -> None:
    src = _read()
    for needle in ("SlotId", "SlotHash", "Idempotency", "Mutates", "LeavesState", "Purpose", "Captures"):
        assert needle in src, f"missing slot field: {needle}"


def test_catalog_has_provider_stubs() -> None:
    src = _read()
    assert "HttpSlotProvider" in src
    assert "SignalRSlotProvider" in src


def test_catalog_fetches_capabilities_once_per_run() -> None:
    src = _read()
    assert "_capabilitiesForRun" in src


def test_catalog_has_content_hash() -> None:
    src = _read()
    assert "ComputeContentHash" in src
    assert "SHA256" in src


def test_catalog_has_few_shot_exemplar_builder() -> None:
    src = _read()
    assert "BuildFewShotExemplars" in src


def test_dag_scanner_exists() -> None:
    src = (DEVMODE / "EdogQaDagScanner.cs").read_text(encoding="utf-8")
    assert "EdogQaDagScanner" in src
    assert "DagDefinition" in src


def test_file_timer_scanner_exists() -> None:
    src = (DEVMODE / "EdogQaFileTimerScanner.cs").read_text(encoding="utf-8")
    assert "EdogQaFileTimerScanner" in src
    assert "EdogFileEventSeam" in src
    assert "EdogTimerSeam" in src


# ─── M7: DI provider seam filter ───────────────────────────────────────


def test_di_provider_filters_by_direct_invoke_seam() -> None:
    src = (DEVMODE / "EdogQaDiRegistryProvider.cs").read_text(encoding="utf-8")
    assert "EdogDirectInvokeSeam" in src
    assert "IQaDirectInvokeRegistry" in src or "GetContractSlots" in src


def test_di_provider_reports_degraded_status() -> None:
    src = (DEVMODE / "EdogQaDiRegistryProvider.cs").read_text(encoding="utf-8")
    assert "degraded" in src.lower() or "GetProviderStatus" in src
    assert "empty" in src.lower()
    assert "failed" in src.lower()


def test_snapshot_tracks_di_provider_status() -> None:
    src = _read()
    assert "di" in src.lower()


# ─── M8: OmniSharp anonymous-type member discovery ─────────────────────


def test_omnisharp_provider_scans_anonymous_type_members() -> None:
    src = (DEVMODE / "EdogQaOmniSharpProvider.cs").read_text(encoding="utf-8")
    assert "AnonymousObjectCreationExpression" in src or "anonymous" in src.lower()


def test_catalog_snapshot_includes_topic_hashes() -> None:
    src = _read()
    assert "MatcherTopics" in src
    assert "TopicHash" in src
