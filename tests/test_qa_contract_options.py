"""Structural contract tests for the P10 contract options provider.

Guards the IQaContractOptionsProvider interface and implementation shape.
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OPTIONS = REPO_ROOT / "src" / "backend" / "DevMode" / "IQaContractOptionsProvider.cs"
FLAGS = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaFeatureFlags.cs"


def test_options_provider_declares_snapshot_shape() -> None:
    src = OPTIONS.read_text(encoding="utf-8") if OPTIONS.exists() else ""
    for needle in (
        "public sealed class QaContractOptions",
        "public long Revision",
        "public bool Enabled",
        "public IImmutableSet<string> DisabledKinds",
        "public bool FewShotEnabled",
        "public string ControlToken",
        "public interface IQaContractOptionsProvider",
    ):
        assert needle in src, f"missing options shape element: {needle}"


def test_options_provider_has_current_and_capture() -> None:
    src = OPTIONS.read_text(encoding="utf-8")
    assert "QaContractOptions Current" in src
    assert "QaContractOptions CaptureSnapshot()" in src


def test_feature_flags_file_references_options_monitor_not_lazy() -> None:
    src = FLAGS.read_text(encoding="utf-8")
    assert "IOptionsMonitor<QaContractOptions>" in src


def test_feature_flags_has_provider_implementation() -> None:
    src = FLAGS.read_text(encoding="utf-8")
    assert "EdogQaContractOptionsProvider" in src
    assert "IQaContractOptionsProvider" in src


def test_provider_uses_monotonic_revision() -> None:
    src = FLAGS.read_text(encoding="utf-8")
    assert "Interlocked.Increment" in src
    assert "_revision" in src
