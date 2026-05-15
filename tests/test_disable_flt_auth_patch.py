"""Regression tests for ``edog.apply_disable_flt_auth_test_json``.

History: the original patcher hard-coded ``"FabricPublicApiHost"`` as the
assumed-last property in the rollouts Test.json. That broke silently when
the FLT team added a property after it (``"FabricPublicApiAudience"``),
producing a "pattern not found" warning that left auth bypass un-applied.

These tests pin the structural-tail anchor used by the rewritten patcher
so the same class of break is caught immediately rather than weeks later
during chaos testing.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("edog", str(_ROOT / "edog.py"))
edog = importlib.util.module_from_spec(_spec)
sys.path.insert(0, str(_ROOT))
_cwd = os.getcwd()
try:
    os.chdir(_ROOT)
    _spec.loader.exec_module(edog)
finally:
    os.chdir(_cwd)


# ── Layout fixtures ────────────────────────────────────────────────────────

LEGACY_LAYOUT = (
    "{\n"
    '  "parameters": {\n'
    '    "IsSwaggerEnabled": true,\n'
    '    "FabricPublicApiHost": "powerbiapi.analysis-df.windows.net"\n'
    "  }\n"
    "}\n"
)

CURRENT_LAYOUT = (
    "{\n"
    '  "parameters": {\n'
    '    "IsSwaggerEnabled": true,\n'
    '    "FabricPublicApiHost": "powerbiapi.analysis-df.windows.net",\n'
    '    "FabricPublicApiAudience": "https://analysis.windows-int.net/powerbi/api"\n'
    "  }\n"
    "}\n"
)

ARRAY_TAIL_LAYOUT = (
    "{\n"
    '  "parameters": {\n'
    '    "FirstPartyAcceptedAudiences": [ "f10a234d-51d4-434e-9324-0553112ff091" ]\n'
    "  }\n"
    "}\n"
)

ALREADY_APPLIED = (
    "{\n"
    '  "parameters": {\n'
    '    "IsSwaggerEnabled": true,\n'
    '    "DisableFLTAuth": true\n'
    "  }\n"
    "}\n"
)

MALFORMED = "not a json object at all"


# ── apply: structural tail must match regardless of which property is last ──


class TestApplyAnchor:
    def test_legacy_layout_fabric_public_api_host_last(self):
        new, status = edog.apply_disable_flt_auth_test_json(LEGACY_LAYOUT)
        assert status == "applied"
        assert '"DisableFLTAuth": true' in new
        # Trailing comma added after the previously-last property
        assert '"FabricPublicApiHost": "powerbiapi.analysis-df.windows.net",' in new

    def test_current_layout_new_property_appended_upstream(self):
        """Regression: this exact layout (Audience after Host) failed in
        the hard-coded patcher and produced "pattern not found"."""
        new, status = edog.apply_disable_flt_auth_test_json(CURRENT_LAYOUT)
        assert status == "applied", "patcher must adapt when FLT adds new tail properties"
        assert '"DisableFLTAuth": true' in new
        assert '"FabricPublicApiAudience": "https://analysis.windows-int.net/powerbi/api",' in new
        # Insertion goes after the *real* last property, not the legacy anchor
        host_idx = new.index('"FabricPublicApiHost"')
        audience_idx = new.index('"FabricPublicApiAudience"')
        bypass_idx = new.index('"DisableFLTAuth"')
        assert host_idx < audience_idx < bypass_idx

    def test_array_value_as_tail(self):
        """Last property's value is a JSON array — anchor must still match
        on the closing ']'."""
        new, status = edog.apply_disable_flt_auth_test_json(ARRAY_TAIL_LAYOUT)
        assert status == "applied"
        assert '"DisableFLTAuth": true' in new

    def test_already_applied(self):
        new, status = edog.apply_disable_flt_auth_test_json(ALREADY_APPLIED)
        assert status == "already_applied"
        assert new == ALREADY_APPLIED

    def test_malformed_returns_pattern_not_found(self):
        new, status = edog.apply_disable_flt_auth_test_json(MALFORMED)
        assert status == "pattern_not_found"
        assert new == MALFORMED


# ── revert: must reverse apply byte-for-byte ───────────────────────────────


class TestRevertRoundTrip:
    def test_legacy_round_trip(self):
        applied, _ = edog.apply_disable_flt_auth_test_json(LEGACY_LAYOUT)
        reverted = edog.revert_disable_flt_auth_test_json(applied)
        assert reverted == LEGACY_LAYOUT

    def test_current_round_trip(self):
        applied, _ = edog.apply_disable_flt_auth_test_json(CURRENT_LAYOUT)
        reverted = edog.revert_disable_flt_auth_test_json(applied)
        assert reverted == CURRENT_LAYOUT

    def test_array_tail_round_trip(self):
        applied, _ = edog.apply_disable_flt_auth_test_json(ARRAY_TAIL_LAYOUT)
        reverted = edog.revert_disable_flt_auth_test_json(applied)
        assert reverted == ARRAY_TAIL_LAYOUT


# ── produced JSON parses (with comments stripped) ──────────────────────────


class TestProducedJsonValid:
    """The slice we generate must produce valid JSON shape — verifying we
    didn't break commas or introduce duplicate keys. Fixtures intentionally
    omit ``//`` comments so we can parse with the stdlib json module
    directly (the real FLT file uses JSONC but parser concerns are out of
    scope for the patch-anchor regression we're guarding here)."""

    def test_legacy_layout_yields_parseable_json(self):
        import json
        new, _ = edog.apply_disable_flt_auth_test_json(LEGACY_LAYOUT)
        parsed = json.loads(new)
        params = parsed["parameters"]
        assert params["DisableFLTAuth"] is True
        assert params["FabricPublicApiHost"] == "powerbiapi.analysis-df.windows.net"

    def test_current_layout_yields_parseable_json(self):
        import json
        new, _ = edog.apply_disable_flt_auth_test_json(CURRENT_LAYOUT)
        parsed = json.loads(new)
        params = parsed["parameters"]
        assert params["DisableFLTAuth"] is True
        assert params["FabricPublicApiAudience"] == "https://analysis.windows-int.net/powerbi/api"
        assert params["FabricPublicApiHost"] == "powerbiapi.analysis-df.windows.net"
