"""Guardrails for force-OFF feature-flag overrides on the *human* control plane.

Background: the dev-server override store + dev-server POST handler + catalog
builder once rejected ``value == false`` outright ("force-ON only, V1-terminal").
That product decision was reversed — a developer must be able to force a flag
OFF to exercise its disabled code path, exactly as they can force one ON.

These tests pin the reversed behavior so a future refactor can't silently
re-introduce a force-OFF guard. They ALSO pin the one place that intentionally
stays force-ON only: the automated QA-chaos path
(``EdogFeatureOverrideStore.MergeOverrides``), so the asymmetry stays a
deliberate, documented choice rather than an accident.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import feature_overrides  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_store():
    """Each test starts from an empty override map."""
    feature_overrides._internal_force_reset()
    yield
    feature_overrides._internal_force_reset()


# --------------------------------------------------------------------------- #
# Behavioral guardrails — the Python control-plane store.
# --------------------------------------------------------------------------- #


def test_set_override_force_off_is_stored():
    """force-OFF (value=False) must persist as False — NOT be coerced or rejected.

    Mutation check: re-introducing ``if value is not True: raise`` makes this
    raise ValueError instead of returning a snapshot, failing the test.
    """
    snapshot, revision = feature_overrides.set_override("FltSomeFlag", False)
    assert snapshot["FltSomeFlag"] is False
    assert revision == 1

    snap, _rev, _hash = feature_overrides.get_snapshot()
    assert snap["FltSomeFlag"] is False


def test_set_override_force_on_still_works():
    snapshot, _ = feature_overrides.set_override("FltSomeFlag", True)
    assert snapshot["FltSomeFlag"] is True


def test_hash_serializes_force_off_symmetrically():
    """Hash must distinguish force-ON from force-OFF (key=true vs key=false).

    This is what lets the FLT round-trip integrity check accept a force-OFF
    push. If force-OFF silently serialized as 'true', ON and OFF would collide.
    """
    on_hash = feature_overrides.compute_hash({"FltSomeFlag": True})
    off_hash = feature_overrides.compute_hash({"FltSomeFlag": False})
    assert on_hash != off_hash


def test_set_override_rejects_non_bool():
    """The value contract is still strict — only real booleans pass."""
    with pytest.raises(ValueError):
        feature_overrides.set_override("FltSomeFlag", "false")  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Source guardrails — the gates that were removed must STAY removed.
# --------------------------------------------------------------------------- #


def test_dev_server_post_handler_has_no_force_off_gate():
    src = (SCRIPTS_DIR / "dev-server.py").read_text(encoding="utf-8")
    assert "force_off_not_supported" not in src, (
        "The dev-server override POST handler must accept value=false; the "
        "force-OFF rejection gate was removed deliberately."
    )


def test_catalog_honors_boolean_override_value():
    """Catalog effective state must follow the forced bool, not hard-code True."""
    src = (SCRIPTS_DIR / "feature_flags_catalog.py").read_text(encoding="utf-8")
    assert "effective = bool(overrides_snapshot.get(wire_key))" in src, (
        "Catalog must stamp effectiveForMyWorkspace from the override's actual "
        "boolean value so force-OFF renders as OFF."
    )


# --------------------------------------------------------------------------- #
# The deliberate asymmetry — QA-chaos path stays force-ON only.
# --------------------------------------------------------------------------- #


def test_qa_merge_path_stays_force_on_only():
    """``MergeOverrides`` (automated QA engine) must keep rejecting force-OFF.

    Human control plane = symmetric (ON/OFF). Automated chaos engine =
    force-ON only by design. This protects that distinction from a careless
    "make it consistent" refactor.
    """
    store_src = (ROOT / "src" / "backend" / "DevMode" / "EdogFeatureOverrideStore.cs").read_text(encoding="utf-8")
    assert "Force-OFF is not supported" in store_src
