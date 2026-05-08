"""
Gate 2 — Build pipeline integration test.

Verifies that build-html.py correctly inlines all CSS and JS modules
into the single-file output. Catches missing module registrations,
broken file references, and placeholder substitution failures.

@author Sentinel — EDOG Studio hivemind
"""

import os
import subprocess
import sys
import pytest

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_SCRIPT = os.path.join(PROJECT_DIR, "scripts", "build-html.py")
OUTPUT_FILE = os.path.join(PROJECT_DIR, "src", "edog-logs.html")

# Expected module counts (update when adding new modules)
EXPECTED_CSS_MODULES = 41
EXPECTED_JS_MODULES = 65
EXPECTED_LIB_MODULES = 1

# F16 Phase 2 wizard modules that MUST be present
F16_JS_MODULES = [
    "wizard-event-bus.js",
    "wizard-code-gen.js",
    "wizard-auto-layout.js",
    "wizard-undo-redo.js",
    "wizard-dag-node.js",
    "wizard-connection-mgr.js",
    "wizard-dag-canvas.js",
    "wizard-node-palette.js",
    "wizard-code-preview.js",
    "wizard-dag-canvas-page.js",
    "wizard-review-summary.js",
    "wizard-template-mgr.js",
    "wizard-execution.js",
    "wizard-floating-badge.js",
]

F16_CSS_MODULE = "infra-wizard.css"


@pytest.fixture(scope="module")
def build_output():
    """Run build and return output HTML content."""
    result = subprocess.run(
        [sys.executable, BUILD_SCRIPT],
        capture_output=True,
        text=True,
        cwd=PROJECT_DIR,
    )
    assert result.returncode == 0, f"Build failed:\n{result.stderr}"
    assert os.path.exists(OUTPUT_FILE), "Output file not created"

    with open(OUTPUT_FILE, encoding="utf-8") as f:
        return f.read()


class TestBuildIntegrity:
    """Verify the build pipeline produces correct output."""

    def test_build_succeeds(self, build_output):
        """Build script exits cleanly and produces output."""
        assert len(build_output) > 100_000, "Output suspiciously small"

    def test_no_missing_module_warnings(self, build_output):
        """No MODULE NOT FOUND comments in output."""
        assert "MODULE NOT FOUND" not in build_output

    def test_no_placeholder_remnants(self, build_output):
        """CSS and JS placeholders were replaced."""
        assert "/* __CSS_MODULES__ */" not in build_output
        assert "/* __JS_MODULES__ */" not in build_output

    def test_css_module_count(self, build_output):
        """All CSS modules are inlined."""
        css_markers = build_output.count("/* === css/")
        assert css_markers == EXPECTED_CSS_MODULES, (
            f"Expected {EXPECTED_CSS_MODULES} CSS modules, found {css_markers}"
        )

    def test_js_module_count(self, build_output):
        """All JS modules are inlined."""
        js_markers = build_output.count("// === js/")
        assert js_markers == EXPECTED_JS_MODULES, (
            f"Expected {EXPECTED_JS_MODULES} JS modules, found {js_markers}"
        )

    def test_lib_module_count(self, build_output):
        """All vendor libraries are inlined."""
        lib_markers = build_output.count("// === lib/")
        assert lib_markers == EXPECTED_LIB_MODULES, (
            f"Expected {EXPECTED_LIB_MODULES} lib modules, found {lib_markers}"
        )

    def test_f16_wizard_modules_present(self, build_output):
        """Every F16 Phase 2 wizard JS module is inlined."""
        for module in F16_JS_MODULES:
            marker = f"// === js/{module} ==="
            assert marker in build_output, f"Missing F16 module: {module}"

    def test_f16_css_present(self, build_output):
        """F16 wizard CSS module is inlined."""
        assert f"/* === css/{F16_CSS_MODULE} ===" in build_output

    def test_module_order_dependencies_first(self, build_output):
        """Wizard modules appear before infra-wizard.js (dependency order)."""
        wizard_pos = build_output.find("// === js/infra-wizard.js ===")
        assert wizard_pos > 0, "infra-wizard.js not found"

        for module in F16_JS_MODULES:
            if module == "infra-wizard.js":
                continue
            mod_pos = build_output.find(f"// === js/{module} ===")
            assert mod_pos < wizard_pos, (
                f"{module} must appear before infra-wizard.js"
            )

    def test_output_is_valid_html(self, build_output):
        """Output starts with HTML doctype/tag."""
        trimmed = build_output.strip()
        assert trimmed.startswith("<!DOCTYPE html>") or trimmed.startswith("<html"), (
            "Output doesn't look like valid HTML"
        )

    def test_output_has_style_and_script_tags(self, build_output):
        """Output contains style and script blocks."""
        assert "<style>" in build_output or "<style " in build_output
        assert "<script>" in build_output or "<script " in build_output

    def test_key_classes_present(self, build_output):
        """Key F16 CSS classes and JS classes are in output."""
        assert "WizardEventBus" in build_output
        assert "DagCanvas" in build_output
        assert "ExecutionPipeline" in build_output
        assert "FloatingBadge" in build_output
        assert "ReviewSummaryPage" in build_output
        assert ".iw-dag-canvas" in build_output
        assert ".iw-badge" in build_output
