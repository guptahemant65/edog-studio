"""Tests for FLT type manifest and retry patterns config.

Validates that:
  1. data/flt-type-manifest.json is valid JSON, has expected structure,
     and every interceptor entry has the required fields.
  2. data/retry-patterns.json is valid JSON, has expected structure,
     and every strategy rule has the required fields.
  3. The validate_flt_types.py script detects missing types correctly.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

PROJECT_DIR = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PROJECT_DIR / "data" / "flt-type-manifest.json"
RETRY_PATH = PROJECT_DIR / "data" / "retry-patterns.json"


# ── flt-type-manifest.json ────────────────────────────────────────────


class TestFltTypeManifest:
    @pytest.fixture()
    def manifest(self) -> dict:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_manifest_exists(self):
        assert MANIFEST_PATH.exists(), "data/flt-type-manifest.json missing"

    def test_manifest_is_valid_json(self):
        json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_interceptors_present(self, manifest):
        assert "interceptors" in manifest
        assert len(manifest["interceptors"]) > 0

    def test_interceptor_required_fields(self, manifest):
        for entry in manifest["interceptors"]:
            assert "name" in entry, f"Missing 'name' in interceptor entry: {entry}"
            assert "fltInterface" in entry, f"Missing 'fltInterface' in: {entry['name']}"
            assert "shortName" in entry, f"Missing 'shortName' in: {entry['name']}"
            assert "wrapper" in entry, f"Missing 'wrapper' in: {entry['name']}"

    def test_no_duplicate_names(self, manifest):
        names = [e["name"] for e in manifest["interceptors"]]
        assert len(names) == len(set(names)), f"Duplicate interceptor names: {names}"

    def test_additional_dependencies_have_required_fields(self, manifest):
        for entry in manifest.get("additionalDependencies", []):
            assert "name" in entry
            assert "fltType" in entry or "fltInterface" in entry
            assert "shortName" in entry

    def test_wrapper_names_match_devmode_files(self, manifest):
        """Every wrapper class should be defined somewhere in DevMode .cs files."""
        devmode_dir = PROJECT_DIR / "src" / "backend" / "DevMode"
        all_cs_content = ""
        for p in devmode_dir.glob("*.cs"):
            all_cs_content += p.read_text(encoding="utf-8", errors="replace")
        for entry in manifest["interceptors"]:
            wrapper = entry["wrapper"]
            assert f"class {wrapper}" in all_cs_content, (
                f"Wrapper class {wrapper} (interceptor '{entry['name']}') not found "
                f"in any .cs file under src/backend/DevMode/"
            )


# ── retry-patterns.json ──────────────────────────────────────────────


class TestRetryPatterns:
    @pytest.fixture()
    def config(self) -> dict:
        return json.loads(RETRY_PATH.read_text(encoding="utf-8"))

    def test_file_exists(self):
        assert RETRY_PATH.exists(), "data/retry-patterns.json missing"

    def test_valid_json(self):
        json.loads(RETRY_PATH.read_text(encoding="utf-8"))

    def test_patterns_section_present(self, config):
        assert "patterns" in config
        assert len(config["patterns"]) > 0

    def test_each_pattern_has_regex(self, config):
        for name, pat in config["patterns"].items():
            assert "regex" in pat, f"Pattern '{name}' missing 'regex'"
            assert "description" in pat, f"Pattern '{name}' missing 'description'"

    def test_strategy_classifiers_present(self, config):
        assert "strategyClassifiers" in config
        rules = config["strategyClassifiers"].get("rules", [])
        assert len(rules) > 0

    def test_strategy_rules_have_strategy(self, config):
        for rule in config["strategyClassifiers"]["rules"]:
            assert "strategy" in rule, f"Rule missing 'strategy': {rule}"

    def test_has_default_strategy_rule(self, config):
        rules = config["strategyClassifiers"]["rules"]
        defaults = [r for r in rules if r.get("default")]
        assert len(defaults) == 1, "Expected exactly one default strategy rule"

    def test_throttle_indicators_present(self, config):
        throttle = config.get("throttleIndicators", {})
        assert "statusCodes" in throttle
        assert "substrings" in throttle
        assert 429 in throttle["statusCodes"]


# ── validate_flt_types.py logic ──────────────────────────────────────


class TestValidateFltTypesScript:
    def test_scan_detects_missing_type(self, tmp_path):
        """Validator should flag types not found in a repo with no .cs files."""
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "validate_flt_types",
            PROJECT_DIR / "scripts" / "validate_flt_types.py",
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        # tmp_path has no .cs files → all FLT types should be missing
        missing = mod.validate(tmp_path)
        # Should find at least the FLT-sourced types (non-external, non-platform)
        assert len(missing) > 0, "Expected missing types in empty repo"

    def test_scan_finds_type_in_cs_file(self, tmp_path):
        """Validator should NOT flag types that exist in .cs files."""
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "validate_flt_types",
            PROJECT_DIR / "scripts" / "validate_flt_types.py",
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        # Create a Service dir with a .cs file declaring IFeatureFlighter
        service = tmp_path / "Service" / "Test"
        service.mkdir(parents=True)
        (service / "IFeatureFlighter.cs").write_text(
            "public interface IFeatureFlighter { bool IsEnabled(string name); }\n"
        )

        declared = mod._scan_declared_types(tmp_path)
        assert "IFeatureFlighter" in declared
