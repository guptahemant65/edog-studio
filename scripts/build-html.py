#!/usr/bin/env python3
"""
Build script for EDOG Studio.

Assembles modular CSS and JS files into a single self-contained edog-logs.html.
Source: src/frontend/ (index.html shell + css/ + js/)
Output: src/edog-logs.html (single file served by EdogLogServer)

Usage:
    python scripts/build-html.py
    python scripts/build-html.py --watch   # Rebuild on file changes (future)
"""

import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
SRC_DIR = os.path.join(PROJECT_DIR, "src", "frontend")
OUTPUT_FILE = os.path.join(PROJECT_DIR, "src", "edog-logs.html")

# CSS modules — order matters (variables first, then layout, then components)
CSS_MODULES = [
    "css/variables.css",
    "css/shimmer.css",
    "css/layout.css",
    "css/topbar.css",
    "css/sidebar.css",
    "css/workspace.css",
    "css/filters.css",
    "css/logs.css",
    "css/telemetry.css",
    "css/detail.css",
    "css/summary.css",
    "css/smart.css",
    "css/control.css",
    "css/command-palette.css",
    "css/dag.css",
    "css/spark.css",
    "css/api-playground.css",
    "css/environment.css",
    "css/token-inspector.css",
    "css/mock-components.css",
    "css/onboarding.css",
]

# JS modules — order matters (dependencies first, then features, then main)
JS_MODULES = [
    "js/mock-data.js",
    "js/state.js",
    "js/websocket.js",
    "js/api-client.js",
    "js/renderer.js",
    "js/filters.js",
    "js/detail-panel.js",
    "js/summary.js",
    "js/auto-detect.js",
    "js/smart-context.js",
    "js/error-intel.js",
    "js/anomaly.js",
    "js/control-panel.js",
    "js/topbar.js",
    "js/sidebar.js",
    "js/workspace-explorer.js",
    "js/command-palette.js",
    "js/mock-renderer.js",
    "js/onboarding.js",
    "js/main.js",
]


def read_file(path):
    """Read a file and return its contents."""
    full_path = os.path.join(SRC_DIR, path)
    if not os.path.exists(full_path):
        print(f"  WARNING: Missing module: {path}")
        return f"/* MODULE NOT FOUND: {path} */\n"
    with open(full_path, encoding="utf-8") as f:
        return f.read()


def build():
    """Assemble all modules into a single HTML file."""
    print("Building EDOG Log Viewer...")
    print(f"  Source: {SRC_DIR}")
    print(f"  Output: {OUTPUT_FILE}")

    # Read the HTML shell
    shell = read_file("index.html")
    if "/* __CSS_MODULES__ */" not in shell:
        print("ERROR: index.html missing /* __CSS_MODULES__ */ placeholder")
        sys.exit(1)
    if "/* __JS_MODULES__ */" not in shell:
        print("ERROR: index.html missing /* __JS_MODULES__ */ placeholder")
        sys.exit(1)

    # Assemble CSS
    css_parts = []
    for module in CSS_MODULES:
        content = read_file(module)
        css_parts.append(f"    /* === {module} === */")
        css_parts.append(content)
        print(f"  CSS: {module} ({len(content)} bytes)")
    all_css = "\n".join(css_parts)

    # Assemble JS
    js_parts = []
    for module in JS_MODULES:
        content = read_file(module)
        js_parts.append(f"// === {module} ===")
        js_parts.append(content)
        print(f"  JS:  {module} ({len(content)} bytes)")
    all_js = "\n".join(js_parts)

    # Replace placeholders
    output = shell.replace("/* __CSS_MODULES__ */", all_css)
    output = output.replace("/* __JS_MODULES__ */", all_js)

    # Write output
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(output)

    total_css = sum(len(read_file(m)) for m in CSS_MODULES)
    total_js = sum(len(read_file(m)) for m in JS_MODULES)
    print(f"\n  Total CSS: {total_css:,} bytes ({len(CSS_MODULES)} modules)")
    print(f"  Total JS:  {total_js:,} bytes ({len(JS_MODULES)} modules)")
    print(f"  Output:    {os.path.getsize(OUTPUT_FILE):,} bytes")
    print("  Done!")


if __name__ == "__main__":
    build()
