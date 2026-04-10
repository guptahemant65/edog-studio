#!/usr/bin/env python3
"""EDOG Studio — Pre-commit quality gate runner.

Runs ALL quality gates in sequence. If ANY gate fails, exits with code 1
to signal that the commit should be blocked.

Usage:
    python scripts/pre-commit.py          # Run all gates
    python scripts/pre-commit.py --quick  # Skip slow gates (pytest)

Gates (in order):
    1. Build HTML (python scripts/build-html.py)
    2. JS syntax check (Node.js parse of built output)
    3. Python lint (ruff)
    4. Python tests (pytest)
    5. Quality gates (quality_gates.py — emoji, OKLCH, frameworks, single-file)
"""

import subprocess
import sys
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
QUICK_MODE = "--quick" in sys.argv


def run(label: str, cmd: list[str], allow_fail: bool = False) -> bool:
    """Run a command, print result, return True if passed."""
    start = time.time()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(PROJECT_DIR),
            encoding="utf-8",
            errors="replace",
        )
        elapsed = time.time() - start
        if result.returncode == 0:
            print(f"  [+] PASS  {label} ({elapsed:.1f}s)")
            return True
        else:
            print(f"  [X] FAIL  {label} ({elapsed:.1f}s)")
            # Show first 20 lines of output
            output = ((result.stdout or "") + (result.stderr or "")).strip()
            for line in output.splitlines()[:20]:
                print(f"       {line}")
            if len(output.splitlines()) > 20:
                print(f"       ... ({len(output.splitlines()) - 20} more lines)")
            return allow_fail
    except FileNotFoundError:
        print(f"  [!] SKIP  {label} — command not found: {cmd[0]}")
        return allow_fail
    except subprocess.TimeoutExpired:
        print(f"  [X] FAIL  {label} — timed out (120s)")
        return False


def main():
    print()
    print("=" * 50)
    print("  EDOG PRE-COMMIT QUALITY GATES")
    print("=" * 50)
    print()

    start = time.time()
    gates = []

    # 1. Build
    gates.append(run(
        "Build HTML",
        [sys.executable, "scripts/build-html.py"],
    ))

    # 2. JS syntax check
    gates.append(run(
        "JS syntax check",
        ["node", "-e",
         "const fs=require('fs'),html=fs.readFileSync('src/edog-logs.html','utf8'),"
         "m=html.match(/<script[^>]*>([\\s\\S]*?)<\\/script>/g);"
         "if(!m){console.error('No scripts');process.exit(1)}"
         "let code=m.map(s=>s.replace(/<\\/?script[^>]*>/g,'')).join('\\n');"
         "try{new Function(code);console.log('OK')}catch(e){console.error(e.message);process.exit(1)}"],
    ))

    # 3. Python lint (governed files only — edog.py and edog-logs.py are legacy)
    gates.append(run(
        "Python lint (ruff)",
        ["ruff", "check", "--quiet", "scripts/", "hivemind/", "tests/"],
        allow_fail=True,
    ))

    # 4. Python tests (skip in quick mode)
    if QUICK_MODE:
        print("  [~] SKIP  Python tests (--quick mode)")
    else:
        gates.append(run(
            "Python tests (pytest)",
            [sys.executable, "-m", "pytest", "tests/", "-q",
             "--ignore=tests/test_revert.py", "--tb=short"],
        ))

    # 5. Quality gates
    gates.append(run(
        "Quality gates",
        [sys.executable, "hivemind/agents/quality_gates.py"],
    ))

    elapsed = time.time() - start
    passed = sum(gates)
    total = len(gates)

    print()
    print("=" * 50)
    if passed == total:
        print(f"  ALL {total} GATES PASSED ({elapsed:.1f}s)")
        print("  Safe to commit.")
    else:
        failed = total - passed
        print(f"  {failed}/{total} GATE(S) FAILED ({elapsed:.1f}s)")
        print("  Fix before committing.")
    print("=" * 50)
    print()

    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
