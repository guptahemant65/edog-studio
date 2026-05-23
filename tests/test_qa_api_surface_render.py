"""F27 — Contract test for the API Surface section rendered into the
Architect prompt + LNT001_PathInCatalog linter rule.

Both code sites used to look up the snake-case key ``url_template`` in
the apiCatalog payload, but the dev-server emits camelCase
``urlTemplate`` (and ``method`` / ``name`` instead of ``verb`` /
``summary``). As a result:

* :class:`EdogQaLlmProvider` rendered every endpoint as ``- ``? ?````
  in the Architect prompt — the Section 1.5d "API Surface (changed
  controllers)" header was emitted but the bullets were empty
  placeholders. The Architect lost all of its catalog grounding.
* :class:`EdogQaScenarioLinter`'s LNT001_PathInCatalog rule built its
  templates ``HashSet`` from empty strings — so the rule was silently
  dead. A scenario whose path didn't match any real endpoint passed
  the linter cleanly.

This test pins both lookups by running the C# harness against an
apiCatalog payload whose keys match the actual dev-server JSON shape
(``method`` / ``urlTemplate`` / ``name`` / ``description``) and
asserts the rendered prompt + the linter findings carry the expected
contract.

Gated on local FLT availability — same convention as
``test_qa_e2e.py``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PROJECT_DIR = REPO_ROOT / "tests" / "dotnet" / "EdogQaE2E.Tests"
CSPROJ = PROJECT_DIR / "EdogQaE2E.Tests.csproj"
BUILT_DLL = PROJECT_DIR / "bin" / "Debug" / "net8.0" / "Microsoft.LiveTable.Service.UnitTests.dll"

DEFAULT_FLT_BIN = (
    Path.home()
    / "newrepo"
    / "workload-fabriclivetable"
    / "Service"
    / "Microsoft.LiveTable.Service.EntryPoint"
    / "bin"
    / "Debug"
    / "net8.0"
    / "win-x64"
)

HARNESS_JSON_BEGIN = "---HARNESS-JSON-BEGIN---"
HARNESS_JSON_END = "---HARNESS-JSON-END---"


def _find_flt_bin() -> Path | None:
    env_value = os.environ.get("EDOG_FLT_BIN")
    if env_value:
        candidate = Path(env_value)
        if (candidate / "Microsoft.LiveTable.Service.dll").exists():
            return candidate
    if (DEFAULT_FLT_BIN / "Microsoft.LiveTable.Service.dll").exists():
        return DEFAULT_FLT_BIN
    return None


def _find_dotnet() -> str | None:
    return shutil.which("dotnet")


def _extract_json_block(stdout: str) -> dict:
    if HARNESS_JSON_BEGIN not in stdout or HARNESS_JSON_END not in stdout:
        raise AssertionError(
            f"Harness output missing JSON markers.\n--- stdout (last 4K):\n{stdout[-4000:]}",
        )
    begin = stdout.index(HARNESS_JSON_BEGIN) + len(HARNESS_JSON_BEGIN)
    end = stdout.index(HARNESS_JSON_END, begin)
    raw = stdout[begin:end].strip()
    return json.loads(raw)


@pytest.fixture(scope="module")
def harness_environment() -> dict:
    if not CSPROJ.exists():
        pytest.fail(f"E2E csproj missing: {CSPROJ}")
    dotnet = _find_dotnet()
    if dotnet is None:
        pytest.skip("`dotnet` CLI is not on PATH — install the .NET 8 SDK.")
    flt_bin = _find_flt_bin()
    if flt_bin is None:
        pytest.skip(
            "FLT bin not found. Set EDOG_FLT_BIN, or clone+build the "
            f"workload-fabriclivetable repo to {DEFAULT_FLT_BIN}.",
        )
    return {"dotnet": dotnet, "flt_bin": flt_bin}


@pytest.fixture(scope="module")
def built_harness(harness_environment) -> Path:
    env = harness_environment
    cmd = [
        env["dotnet"],
        "build",
        str(CSPROJ),
        f"-p:FltBin={env['flt_bin']}",
        "--nologo",
        "--verbosity",
        "minimal",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, cwd=PROJECT_DIR)
    if result.returncode != 0:
        pytest.fail(
            "E2E harness build failed.\n"
            f"--- exit code: {result.returncode}\n"
            f"--- stdout (last 4K):\n{result.stdout[-4000:]}\n"
            f"--- stderr (last 2K):\n{result.stderr[-2000:]}",
        )
    if not BUILT_DLL.exists():
        pytest.fail(f"Build succeeded but DLL not at expected path: {BUILT_DLL}")
    return BUILT_DLL


def _run(dotnet: str, dll: Path) -> dict:
    result = subprocess.run(
        [dotnet, str(dll), "api-surface-render"],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=dll.parent,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"Harness exited {result.returncode}.\n"
            f"--- stdout:\n{result.stdout[-4000:]}\n"
            f"--- stderr:\n{result.stderr[-2000:]}",
        )
    return _extract_json_block(result.stdout)


def test_api_surface_renderer_resolves_dev_server_key_names(
    harness_environment,
    built_harness,
) -> None:
    """The Architect prompt's API Surface section must surface the
    actual ``method`` / ``urlTemplate`` / ``name`` values from the
    dev-server catalog payload — not the dead snake-case lookups
    that produced ``? ?`` placeholders.
    """
    data = _run(harness_environment["dotnet"], built_harness)
    assert data["ok"] is True, data

    r = data["renderer"]
    assert r["contains_section_header"] is True, "API Surface section header missing from rendered prompt"
    assert r["contains_verb"] is True, "HTTP verb ('GET') missing — `method` key lookup is broken again"
    assert r["contains_url_template"] is True, (
        "urlTemplate ('/liveTable/insights/summary') missing — "
        "`urlTemplate` key lookup is broken again (was reading `url_template`)"
    )
    assert r["contains_name"] is True, (
        "Endpoint name ('Get Insights Summary') missing — `name` key lookup is broken again (was reading `summary`)"
    )
    assert r["contains_must_match_rule"] is True, "MUST-match-catalog rule line missing — Architect lost the grounding"
    assert r["contains_placeholder_question_marks"] is False, (
        "Rendered prompt still contains `? ?` placeholder bullets — the key-name lookup regressed"
    )


def test_linter_lnt001_path_in_catalog_uses_dev_server_key_names(
    harness_environment,
    built_harness,
) -> None:
    """LNT001_PathInCatalog must fire when stimulus.path is not in the
    catalog and stay silent when it is. The rule was silently dead
    until the linter's templates HashSet started reading the
    ``urlTemplate`` key instead of ``url_template``.
    """
    data = _run(harness_environment["dotnet"], built_harness)
    assert data["ok"] is True, data

    L = data["linter"]
    assert L["lnt001_fires_on_bad"] is True, (
        "LNT001_PathInCatalog did NOT fire on a scenario with a path "
        "not in the catalog — the rule is silently dead again. "
        f"Findings: {L['lnt001_findings']}"
    )
    assert L["lnt001_fires_on_good"] is False, (
        "LNT001_PathInCatalog over-fired on a scenario whose path matches the catalog. The templates set may be empty."
    )


def test_linter_lnt005_accepts_grounding_files_listed_in_diff_files(
    harness_environment,
    built_harness,
) -> None:
    """LNT005 must treat PrContext.DiffFiles as authoritative evidence that
    a file really is in the diff; otherwise Architect grounding on a file
    absent from invariant extraction still looks hallucinated.
    """
    data = _run(harness_environment["dotnet"], built_harness)
    assert data["ok"] is True, data

    L = data["linter"]
    assert L["lnt005_allows_diff_file"] is True, (
        "LNT005 still fired on a grounding file that was present in PrContext.DiffFiles. "
        f"Findings: {L['lnt005_diff_file_findings']}"
    )


def test_linter_lnt009_uses_feature_flag_overrides_in_dedupe_key(
    harness_environment,
    built_harness,
) -> None:
    """LNT009 should still fire on exact duplicate stimuli, but must stay
    silent when the only difference is featureFlagOverrides — those are
    mechanically distinct executions.
    """
    data = _run(harness_environment["dotnet"], built_harness)
    assert data["ok"] is True, data

    L = data["linter"]
    assert L["lnt009_fires_on_exact_duplicate"] is True, (
        f"Exact duplicate stimuli no longer fire LNT009. Findings: {L['lnt009_findings']}"
    )
    assert L["lnt009_fires_on_flag_distinct"] is False, (
        f"Scenarios that differ only by featureFlagOverrides still collide in LNT009. Findings: {L['lnt009_findings']}"
    )
