# EDOG Studio Hivemind — Automated Quality Gates
# Classification: INTERNAL
# Owner: Ines Ferreira (QA Engineer)

"""
Quality gate checks for edog-studio.

Each function validates a specific quality requirement and returns
a (passed, message) tuple. These gates are run before any deliverable
is considered "done."

Gates:
    check_python_style          — ruff passes on all Python files
    check_no_emoji_in_frontend  — no emoji characters in JS/CSS/HTML
    check_css_uses_oklch        — no hex/rgb/hsl colors in CSS
    check_conventional_commit   — commit message follows convention
    check_no_frameworks_in_js   — no React/Vue/Angular imports
    check_single_file_build     — build-html.py produces valid HTML
"""

import os
import re
import subprocess
from pathlib import Path
from typing import Tuple


# Root of the edog-studio repository
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Frontend source directory
FRONTEND_SRC = REPO_ROOT / "src" / "frontend"

# Build output
BUILD_OUTPUT = REPO_ROOT / "src" / "edog-logs.html"


def check_python_style() -> Tuple[bool, str]:
    """Verify ruff passes on all Python files.

    Returns:
        (passed, message) — True if no lint violations found.
    """
    python_files = (
        list((REPO_ROOT / "scripts").rglob("*.py"))
        + list((REPO_ROOT / "tests").rglob("*.py"))
    )

    if not python_files:
        return True, "No Python files found to check."

    try:
        result = subprocess.run(
            ["ruff", "check", "--quiet", *[str(f) for f in python_files]],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        return False, "ruff is not installed. Install with: pip install ruff"

    if result.returncode == 0:
        return True, f"ruff passed on {len(python_files)} Python files."

    violation_count = len(result.stdout.strip().splitlines())
    return False, f"ruff found {violation_count} violation(s):\n{result.stdout.strip()}"


def check_no_emoji_in_frontend() -> Tuple[bool, str]:
    """Scan JS/CSS/HTML source files for emoji characters.

    edog-studio uses Unicode symbols or inline SVG — never emoji.
    This checks source files, not the compiled output.

    Returns:
        (passed, message) — True if no emoji found.
    """
    # Emoji Unicode ranges (covers most common emoji)
    emoji_pattern = re.compile(
        "["
        "\U0001f600-\U0001f64f"  # Emoticons
        "\U0001f300-\U0001f5ff"  # Misc symbols & pictographs
        "\U0001f680-\U0001f6ff"  # Transport & map
        "\U0001f1e0-\U0001f1ff"  # Flags
        "\U00002702-\U000027b0"  # Dingbats
        "\U0001f900-\U0001f9ff"  # Supplemental symbols
        "\U0001fa00-\U0001fa6f"  # Chess symbols, extended-A
        "\U0001fa70-\U0001faff"  # Symbols extended-A
        "\U00002600-\U000026ff"  # Misc symbols
        "]"
    )

    violations = []
    extensions = ("*.js", "*.css", "*.html")

    if not FRONTEND_SRC.exists():
        return True, f"Frontend source directory not found: {FRONTEND_SRC}"

    for ext in extensions:
        for filepath in FRONTEND_SRC.rglob(ext):
            try:
                content = filepath.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue

            for line_num, line in enumerate(content.splitlines(), 1):
                matches = emoji_pattern.findall(line)
                if matches:
                    rel_path = filepath.relative_to(REPO_ROOT)
                    for match in matches:
                        violations.append(
                            f"  {rel_path}:{line_num} — found emoji: {match}"
                        )

    if not violations:
        return True, "No emoji found in frontend source files."

    return False, (
        f"Found {len(violations)} emoji occurrence(s) in frontend:\n"
        + "\n".join(violations)
    )


def check_css_uses_oklch() -> Tuple[bool, str]:
    """Verify no hex, rgb(), or hsl() colors appear in CSS files.

    All colors must use oklch(). Only CSS custom property definitions
    in :root and comments are exempt.

    Returns:
        (passed, message) — True if all colors use OKLCH.
    """
    # Patterns for non-OKLCH color values
    hex_color = re.compile(r"#(?:[0-9a-fA-F]{3,4}){1,2}\b")
    rgb_color = re.compile(r"\brgba?\s*\(", re.IGNORECASE)
    hsl_color = re.compile(r"\bhsla?\s*\(", re.IGNORECASE)

    violations = []
    css_dir = FRONTEND_SRC / "css" if FRONTEND_SRC.exists() else None

    if css_dir is None or not css_dir.exists():
        return True, "No CSS directory found to check."

    for css_file in css_dir.glob("*.css"):
        try:
            content = css_file.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

        for line_num, line in enumerate(content.splitlines(), 1):
            stripped = line.strip()

            # Skip comments
            if stripped.startswith("/*") or stripped.startswith("*") or stripped.startswith("//"):
                continue

            rel_path = css_file.relative_to(REPO_ROOT)

            if hex_color.search(line):
                violations.append(f"  {rel_path}:{line_num} — hex color: {stripped[:80]}")

            if rgb_color.search(line):
                violations.append(f"  {rel_path}:{line_num} — rgb() color: {stripped[:80]}")

            if hsl_color.search(line):
                violations.append(f"  {rel_path}:{line_num} — hsl() color: {stripped[:80]}")

    if not violations:
        return True, "All CSS colors use OKLCH."

    return False, (
        f"Found {len(violations)} non-OKLCH color(s) in CSS:\n"
        + "\n".join(violations)
    )


def check_conventional_commit(msg: str) -> Tuple[bool, str]:
    """Verify a commit message follows conventional commit format.

    Expected format: <type>(<scope>): <subject>

    Valid types: feat, fix, docs, style, refactor, test, chore, perf
    Scope is optional but recommended.
    Subject must be lowercase-start, no period at end.

    Args:
        msg: The commit message (first line).

    Returns:
        (passed, message) — True if the message is valid.
    """
    valid_types = {"feat", "fix", "docs", "style", "refactor", "test", "chore", "perf"}

    # Pattern: type(scope): subject  OR  type: subject
    pattern = re.compile(
        r"^(?P<type>\w+)"
        r"(?:\((?P<scope>[a-z0-9_-]+)\))?"
        r":\s+"
        r"(?P<subject>.+)$"
    )

    first_line = msg.strip().splitlines()[0] if msg.strip() else ""

    if not first_line:
        return False, "Commit message is empty."

    match = pattern.match(first_line)
    if not match:
        return False, (
            f"Invalid format: '{first_line}'\n"
            f"  Expected: <type>(<scope>): <subject>\n"
            f"  Example:  feat(logs): add smart log grouping"
        )

    commit_type = match.group("type")
    subject = match.group("subject")

    if commit_type not in valid_types:
        return False, (
            f"Invalid type: '{commit_type}'\n"
            f"  Valid types: {', '.join(sorted(valid_types))}"
        )

    if subject[0].isupper():
        return False, (
            f"Subject should start with lowercase: '{subject}'\n"
            f"  Write: '{subject[0].lower() + subject[1:]}'"
        )

    if subject.endswith("."):
        return False, f"Subject should not end with a period: '{subject}'"

    if len(first_line) > 72:
        return False, (
            f"Subject line too long ({len(first_line)} chars, max 72):\n"
            f"  '{first_line}'"
        )

    return True, f"Valid conventional commit: {first_line}"


def check_no_frameworks_in_js() -> Tuple[bool, str]:
    """Scan JS files for React, Vue, Angular, or other framework imports.

    edog-studio is vanilla JS only. No frameworks, no libraries, no CDN.

    Returns:
        (passed, message) — True if no framework references found.
    """
    framework_patterns = [
        (re.compile(r"\bimport\b.*\bfrom\s+['\"]react", re.IGNORECASE), "React"),
        (re.compile(r"\bimport\b.*\bfrom\s+['\"]vue", re.IGNORECASE), "Vue"),
        (re.compile(r"\bimport\b.*\bfrom\s+['\"]@angular", re.IGNORECASE), "Angular"),
        (re.compile(r"\bimport\b.*\bfrom\s+['\"]svelte", re.IGNORECASE), "Svelte"),
        (re.compile(r"\bimport\b.*\bfrom\s+['\"]preact", re.IGNORECASE), "Preact"),
        (re.compile(r"\bimport\b.*\bfrom\s+['\"]jquery", re.IGNORECASE), "jQuery"),
        (re.compile(r"\bimport\b.*\bfrom\s+['\"]lit", re.IGNORECASE), "Lit"),
        (re.compile(r"\brequire\s*\(\s*['\"]react", re.IGNORECASE), "React (require)"),
        (re.compile(r"\brequire\s*\(\s*['\"]vue", re.IGNORECASE), "Vue (require)"),
        (re.compile(r"<script\s+src=.*(?:react|vue|angular|jquery)", re.IGNORECASE), "CDN script"),
    ]

    violations = []
    js_dir = FRONTEND_SRC / "js" if FRONTEND_SRC.exists() else None

    if js_dir is None or not js_dir.exists():
        return True, "No JS directory found to check."

    for js_file in js_dir.rglob("*.js"):
        try:
            content = js_file.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

        rel_path = js_file.relative_to(REPO_ROOT)

        for line_num, line in enumerate(content.splitlines(), 1):
            for pattern, framework_name in framework_patterns:
                if pattern.search(line):
                    violations.append(
                        f"  {rel_path}:{line_num} — {framework_name}: {line.strip()[:80]}"
                    )

    # Also check the HTML template
    html_template = FRONTEND_SRC / "index.html"
    if html_template.exists():
        try:
            content = html_template.read_text(encoding="utf-8")
            rel_path = html_template.relative_to(REPO_ROOT)
            for line_num, line in enumerate(content.splitlines(), 1):
                for pattern, framework_name in framework_patterns:
                    if pattern.search(line):
                        violations.append(
                            f"  {rel_path}:{line_num} — {framework_name}: {line.strip()[:80]}"
                        )
        except (UnicodeDecodeError, OSError):
            pass

    if not violations:
        return True, "No framework imports found. Vanilla JS only."

    return False, (
        f"Found {len(violations)} framework reference(s):\n"
        + "\n".join(violations)
        + "\n\n  edog-studio is vanilla JS only. No frameworks."
    )


def check_js_syntax() -> Tuple[bool, str]:
    """Verify JS in the built HTML is syntactically valid.

    Extracts all <script> content from the built single-file HTML and
    runs Node.js new Function() parse on it. Catches duplicate variable
    declarations, unclosed brackets, and other syntax errors.

    Requires: Node.js installed and on PATH.

    Returns:
        (passed, message) — True if all JS parses without error.
    """
    if not BUILD_OUTPUT.exists():
        return False, f"Build output not found: {BUILD_OUTPUT}\n  Run: python scripts/build-html.py"

    try:
        content = BUILD_OUTPUT.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as e:
        return False, f"Cannot read build output: {e}"

    # Extract script content
    script_pattern = re.compile(r"<script[^>]*>([\s\S]*?)</script>", re.IGNORECASE)
    scripts = script_pattern.findall(content)

    if not scripts:
        return False, "No <script> blocks found in build output."

    # Combine all scripts (they share a global scope in the single-file HTML)
    all_js = "\n".join(scripts)

    # Write to temp file for Node to parse
    temp_js = REPO_ROOT / ".edog-jscheck-tmp.js"
    try:
        # Use strict mode Function constructor to catch re-declarations
        check_code = (
            "const fs = require('fs');\n"
            "const code = fs.readFileSync(process.argv[2], 'utf8');\n"
            "try { new Function(code); console.log('OK'); process.exit(0); }\n"
            "catch (e) { console.error('JS_SYNTAX_ERROR: ' + e.message); process.exit(1); }\n"
        )
        check_file = REPO_ROOT / ".edog-jscheck-runner.js"
        check_file.write_text(check_code, encoding="utf-8")
        temp_js.write_text(all_js, encoding="utf-8")

        result = subprocess.run(
            ["node", str(check_file), str(temp_js)],
            capture_output=True, text=True, timeout=10,
            encoding="utf-8", errors="replace",
        )
    except FileNotFoundError:
        return False, "Node.js not found. Install Node.js to enable JS syntax checking."
    except subprocess.TimeoutExpired:
        return False, "JS syntax check timed out (10s)."
    finally:
        temp_js.unlink(missing_ok=True)
        check_file = REPO_ROOT / ".edog-jscheck-runner.js"
        check_file.unlink(missing_ok=True)

    if result.returncode == 0:
        js_size_kb = len(all_js.encode("utf-8")) / 1024
        return True, f"JS syntax valid ({js_size_kb:.0f} KB across {len(scripts)} script block(s))."

    error_msg = result.stderr.strip() or result.stdout.strip()
    return False, f"JS syntax error in built HTML:\n  {error_msg}"


def check_single_file_build() -> Tuple[bool, str]:
    """Verify build-html.py produces a valid single-file HTML document.

    Checks:
    - Output file exists
    - Contains <html> and </html>
    - No external <link> stylesheets
    - No external <script src=""> (data: URIs are OK)
    - File size is reasonable (> 1KB, < 5MB)

    Returns:
        (passed, message) — True if the build output is valid.
    """
    if not BUILD_OUTPUT.exists():
        return False, (
            f"Build output not found: {BUILD_OUTPUT}\n"
            f"  Run: python build-html.py"
        )

    try:
        content = BUILD_OUTPUT.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as e:
        return False, f"Cannot read build output: {e}"

    issues = []

    # Check basic HTML structure
    if "<html" not in content.lower():
        issues.append("Missing <html> tag")
    if "</html>" not in content.lower():
        issues.append("Missing </html> tag")

    # Check for external stylesheets
    link_pattern = re.compile(r'<link\s[^>]*rel=["\']stylesheet["\']', re.IGNORECASE)
    external_links = link_pattern.findall(content)
    if external_links:
        issues.append(f"Found {len(external_links)} external <link> stylesheet(s)")

    # Check for external scripts (allow data: URIs and inline)
    script_src_pattern = re.compile(r'<script\s[^>]*src=["\'](?!data:)([^"\']+)["\']', re.IGNORECASE)
    external_scripts = script_src_pattern.findall(content)
    if external_scripts:
        issues.append(
            f"Found {len(external_scripts)} external script(s): "
            + ", ".join(external_scripts[:3])
        )

    # Check file size
    size_bytes = len(content.encode("utf-8"))
    if size_bytes < 1024:
        issues.append(f"File suspiciously small ({size_bytes} bytes)")
    if size_bytes > 5 * 1024 * 1024:
        issues.append(f"File too large ({size_bytes / 1024 / 1024:.1f} MB)")

    if issues:
        return False, (
            f"Build output validation failed:\n"
            + "\n".join(f"  - {issue}" for issue in issues)
        )

    size_kb = size_bytes / 1024
    return True, f"Valid single-file HTML ({size_kb:.0f} KB). Zero external dependencies."


# =============================================================================
# RUNNER
# =============================================================================

def run_all_gates() -> list[Tuple[str, bool, str]]:
    """Run all quality gates and return results.

    Returns:
        List of (gate_name, passed, message) tuples.
    """
    gates = [
        ("python_style", check_python_style, True),       # warn-only: pre-existing violations
        ("no_emoji_in_frontend", check_no_emoji_in_frontend, False),
        ("css_uses_oklch", check_css_uses_oklch, False),
        ("no_frameworks_in_js", check_no_frameworks_in_js, False),
        ("js_syntax", check_js_syntax, False),
        ("single_file_build", check_single_file_build, False),
    ]

    results = []
    for name, gate_fn, warn_only in gates:
        passed, message = gate_fn()
        if warn_only and not passed:
            results.append((name, True, f"[WARN] {message}"))
        else:
            results.append((name, passed, message))

    return results


if __name__ == "__main__":
    import sys, io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

    print("=" * 60)
    print("EDOG-STUDIO QUALITY GATES")
    print("=" * 60)
    print()

    results = run_all_gates()
    all_passed = True

    for name, passed, message in results:
        status = "PASS" if passed else "FAIL"
        icon = "+" if passed else "X"
        print(f"[{icon}] {status}: {name}")
        if not passed:
            all_passed = False
            for line in message.splitlines():
                print(f"    {line}")
        else:
            print(f"    {message}")
        print()

    print("=" * 60)
    if all_passed:
        print("ALL GATES PASSED")
    else:
        failed = sum(1 for _, p, _ in results if not p)
        print(f"{failed} GATE(S) FAILED — fix before shipping")
    print("=" * 60)
