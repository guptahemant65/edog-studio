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
LIB_DIR = os.path.join(PROJECT_DIR, "lib")
OUTPUT_FILE = os.path.join(PROJECT_DIR, "src", "edog-logs.html")

# CSS modules — order matters (variables first, then layout, then components)
CSS_MODULES = [
    "css/variables.css",
    "css/shimmer.css",
    "css/layout.css",
    "css/topbar.css",
    "css/sidebar.css",
    "css/workspace.css",
    "css/deploy.css",
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
    "css/notebook.css",
    "css/environment.css",
    "css/token-inspector.css",
    "css/runtime.css",
    "css/logs-enhancements.css",
    "css/tab-telemetry.css",
    "css/tab-sysfiles.css",
    "css/tab-spark.css",
    "css/tab-tokens.css",
    "css/tab-caches.css",
    "css/tab-http.css",
    "css/tab-retries.css",
    "css/tab-flags.css",
    "css/tab-di.css",
    "css/tab-perf.css",
    "css/tab-nexus.css",
    "css/mock-components.css",
    "css/onboarding.css",
]

# Vendor libraries — inlined BEFORE our JS modules (order matters)
LIB_MODULES = [
    "signalr.min.js",
]

# JS modules — order matters (dependencies first, then features, then main)
JS_MODULES = [
    "js/mock-data.js",
    "js/error-codes-data.js",
    "js/state.js",
    "js/signalr-manager.js",
    "js/api-client.js",
    "js/notebook-parser.js",
    "js/notebook-view.js",
    "js/error-decoder.js",
    "js/renderer.js",
    "js/filters.js",
    "js/detail-panel.js",
    "js/summary.js",
    "js/auto-detect.js",
    "js/smart-context.js",
    "js/error-intel.js",
    "js/error-timeline.js",
    "js/anomaly.js",
    "js/dag-layout.js",
    "js/dag-graph.js",
    "js/dag-gantt.js",
    "js/dag-studio.js",
    "js/control-panel.js",
    "js/topbar.js",
    "js/deploy-flow.js",
    "js/sidebar.js",
    "js/runtime-view.js",
    "js/logs-enhancements.js",
    "js/tab-telemetry.js",
    "js/tab-sysfiles.js",
    "js/tab-spark.js",
    "js/tab-tokens.js",
    "js/tab-caches.js",
    "js/tab-http.js",
    "js/tab-retries.js",
    "js/tab-flags.js",
    "js/tab-di.js",
    "js/tab-perf.js",
    "js/tab-nexus.js",
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


def read_lib(filename):
    """Read a vendor library from lib/ directory."""
    full_path = os.path.join(LIB_DIR, filename)
    if not os.path.exists(full_path):
        print(f"  WARNING: Missing vendor lib: {filename}")
        return f"/* VENDOR LIB NOT FOUND: {filename} */\n"
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

    # Assemble JS — vendor libraries first, then our modules
    js_parts = []
    for lib in LIB_MODULES:
        content = read_lib(lib)
        js_parts.append(f"// === lib/{lib} ===")
        js_parts.append(content)
        print(f"  LIB: lib/{lib} ({len(content)} bytes)")
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
    total_lib = sum(len(read_lib(m)) for m in LIB_MODULES)
    total_js = sum(len(read_file(m)) for m in JS_MODULES)
    print(f"\n  Total CSS: {total_css:,} bytes ({len(CSS_MODULES)} modules)")
    print(f"  Total LIB: {total_lib:,} bytes ({len(LIB_MODULES)} vendor libs)")
    print(f"  Total JS:  {total_js:,} bytes ({len(JS_MODULES)} modules)")
    print(f"  Output:    {os.path.getsize(OUTPUT_FILE):,} bytes")
    print("  Done!")


if __name__ == "__main__":
    build()
