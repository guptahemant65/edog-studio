"""Structural contract tests for the P10 QA contract model surface.

Guards the presence of new enum values, typed matcher vocabulary,
catalog hash envelope, and contract matcher records in EdogQaModels.cs.
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MODELS = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaModels.cs"


def _read() -> str:
    return MODELS.read_text(encoding="utf-8")


def test_models_define_contract_matcher_surface() -> None:
    src = _read()
    for needle in (
        "public enum MatcherAssertion",
        "Equals",
        "NotEquals",
        "Exists",
        "InRange",
        "ContainsAll",
        "OneOf",
        "Length",
        "public abstract class MatcherValue",
    ):
        assert needle in src, f"missing matcher surface element: {needle}"


def test_models_define_typed_matcher_value_variants() -> None:
    src = _read()
    for needle in (
        "public sealed class ScalarMatcherValue",
        "public sealed class RangeMatcherValue",
        "public sealed class ArrayMatcherValue",
        "public sealed class BooleanMatcherValue",
        "public sealed class LengthMatcherValue",
    ):
        assert needle in src, f"missing matcher value type: {needle}"


def test_models_define_catalog_hashes_payload() -> None:
    src = _read()
    for needle in (
        "public sealed class CatalogHashes",
        "StimulusSlotHash",
        "MatcherTopicHashes",
        "CatalogSnapshotId",
    ):
        assert needle in src, f"missing catalog hash element: {needle}"


def test_models_define_contract_matcher_record() -> None:
    src = _read()
    for needle in (
        "public sealed class Matcher",
        "TopicField",
        "MatcherAssertion Assertion",
        "MatcherValue Value",
    ):
        assert needle in src, f"missing matcher record element: {needle}"


def test_scenario_has_matchers_and_catalog_hashes() -> None:
    src = _read()
    assert "public List<Matcher> Matchers" in src
    assert "public CatalogHashes CatalogHashes" in src


def test_renamed_stimulus_types_present() -> None:
    src = _read()
    for kind in ("HttpRequest", "SignalRBroadcast", "DagTrigger", "FileEvent", "TimerTick", "DiInvocation"):
        assert kind in src, f"missing renamed stimulus type: {kind}"
    # Old names must be gone from enum
    assert "SignalrInvoke," not in src
    assert "DirectInvoke\n" not in src or "DirectInvoke}" not in src


def test_stale_and_inconclusive_verdicts_present() -> None:
    src = _read()
    assert "Stale" in src
    assert "Inconclusive" in src
