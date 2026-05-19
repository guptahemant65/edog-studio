"""F27 P2 — DevMode C# build gate.

Compiles every C# file under ``src/backend/DevMode/`` against the *real*
FLT-produced DLLs and asserts zero errors. This catches compile-time
breakage in the DevMode files BEFORE they are deployed into FLT, where a
compile error means FLT itself refuses to start.

How it works
------------
The build is driven by ``tests/_csbuild/EdogDevModeBuild.csproj``:

* It uses ``Microsoft.NET.Sdk`` with target ``net8.0`` and the
  ``Microsoft.AspNetCore.App`` shared framework (no NuGet restore needed).
* It compiles ``../../src/backend/DevMode/*.cs`` via a ``<Compile Include>``
  glob — the same set of files ``edog.py``'s ``DEVMODE_FILES`` deploys.
* It references FLT's compiled DLLs via ``<HintPath>``-based ``<Reference>``
  items wired up in an MSBuild ``BeforeTargets="ResolveAssemblyReferences"``
  target.
* It sets ``<AssemblyName>Microsoft.LiveTable.Service</AssemblyName>`` so
  that FLT's ``[assembly: InternalsVisibleTo("Microsoft.LiveTable.Service")]``
  in ``FriendlyAssemblies.cs`` grants the build access to FLT's ``internal``
  types (the deployed DevMode files are compiled INTO that same assembly
  in production, so this matches reality).

The test is **gated on local FLT availability**. CI integration is deferred
to F27 P9 — for now the gate runs as part of the local developer pre-commit
gauntlet. The test skips with a clear message when FLT is not found instead
of failing.

FLT bin discovery (in priority order):
  1. ``EDOG_FLT_BIN`` env var
  2. ``~/newrepo/workload-fabriclivetable/Service/Microsoft.LiveTable.Service.EntryPoint/bin/Debug/net8.0/win-x64``

What this catches
-----------------
* C# syntax errors in any DEVMODE file.
* Type/method renames in FLT that break our interceptors / hub.
* Missing using directives.
* Constructor signature mismatches between our wrappers and FLT interfaces.
* Stale references to removed FLT types.

What this does NOT catch
------------------------
* Runtime errors (DI registration, null refs, deadlocks).
* Behavioural regressions (P3 integration tests cover those).
* Issues that only manifest under the FLT EntryPoint host (.NET AppDomain
  isolation, hosting model, etc.).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

# ─── Path setup ───────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[1]
CSBUILD_DIR = REPO_ROOT / "tests" / "_csbuild"
CSPROJ = CSBUILD_DIR / "EdogDevModeBuild.csproj"

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

# A successful build emits this canonical message on stderr/stdout.
# We allow these warning codes since they're cosmetic for a compile-only
# verification step:
#   MSB3277 — assembly version conflict (FLT bin is a self-contained
#     deployment with version-mixed dependencies; harmless when compiling).
#   MSB3246 — native (non-managed) DLL caught by our reference glob lacks
#     metadata. Affects e.g. SqlClient SNI shim DLLs. The build still
#     succeeds; the compiler just couldn't read the PE image, which is
#     correct because those are runtime-only native interop binaries.
ALLOWED_WARNING_CODES = frozenset({"MSB3277", "MSB3246"})


# ─── Helpers ──────────────────────────────────────────────────────────────


def _find_flt_bin() -> Path | None:
    """Locate FLT's compiled bin dir.

    Order: EDOG_FLT_BIN env var → default ~/newrepo/... clone.
    Returns None if neither contains Microsoft.LiveTable.Service.dll.
    """
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


def _classify_warnings(stdout: str) -> tuple[list[str], list[str]]:
    """Split build output warnings into (allowed, unexpected).

    A warning line looks like::

        C:\\…\\file.cs(L,C): warning CSnnnn: …
        C:\\…\\file.targets(L,C): warning MSBnnnn: …

    We split on the warning code immediately after ``warning ``.
    """
    allowed: list[str] = []
    unexpected: list[str] = []
    for line in stdout.splitlines():
        if "warning" not in line.lower():
            continue
        # Be tolerant of leading/trailing whitespace in MSBuild's multiline format.
        marker_index = line.lower().find("warning ")
        if marker_index < 0:
            continue
        # The code starts immediately after "warning ".
        after_marker = line[marker_index + len("warning ") :].lstrip()
        code = after_marker.split(":", 1)[0].split()[0] if after_marker else ""
        if code in ALLOWED_WARNING_CODES:
            allowed.append(line.strip())
        elif code.startswith(("CS", "MSB")):
            unexpected.append(line.strip())
    return allowed, unexpected


# ─── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def build_environment() -> dict:
    """Resolve dotnet + FLT bin once per test module."""
    if not CSPROJ.exists():
        pytest.fail(f"Build project missing: {CSPROJ}")

    dotnet = _find_dotnet()
    if dotnet is None:
        pytest.skip("`dotnet` CLI is not on PATH — install the .NET 8 SDK.")

    flt_bin = _find_flt_bin()
    if flt_bin is None:
        pytest.skip(
            "FLT bin not found. Set EDOG_FLT_BIN, or clone+build the "
            "workload-fabriclivetable repo to its default location at "
            f"{DEFAULT_FLT_BIN}. CI integration for this gate lands in "
            "F27 P9.",
        )

    return {"dotnet": dotnet, "flt_bin": flt_bin, "csproj": CSPROJ}


@pytest.fixture(scope="module")
def build_result(build_environment) -> subprocess.CompletedProcess:
    """Run the C# build exactly once per session and share the output."""
    env = build_environment
    cmd = [
        env["dotnet"],
        "build",
        str(env["csproj"]),
        f"-p:FltBin={env['flt_bin']}",
        "--nologo",
        "--verbosity",
        "minimal",
    ]
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=300,
        cwd=CSBUILD_DIR,
    )


# ─── Tests ────────────────────────────────────────────────────────────────


def test_csproj_is_well_formed() -> None:
    """The build project must exist and contain the key compile-include."""
    content = CSPROJ.read_text(encoding="utf-8")
    assert "<TargetFramework>net8.0</TargetFramework>" in content
    assert "Microsoft.AspNetCore.App" in content
    # The compile-include must glob DevMode/*.cs to pick up every deployed file.
    assert r"..\..\src\backend\DevMode\*.cs" in content
    # The assembly name must match FLT's so InternalsVisibleTo grants access.
    assert "<AssemblyName>Microsoft.LiveTable.Service</AssemblyName>" in content


def test_devmode_files_compile_cleanly(build_result) -> None:
    """The full DevMode directory must compile with 0 errors."""
    if build_result.returncode != 0:
        # Trim to the last 4 KB so the failure message is readable.
        tail_stdout = build_result.stdout[-4000:]
        tail_stderr = build_result.stderr[-2000:]
        pytest.fail(
            "DevMode C# build failed.\n"
            f"--- exit code: {build_result.returncode}\n"
            f"--- stdout (last 4K):\n{tail_stdout}\n"
            f"--- stderr (last 2K):\n{tail_stderr}",
        )


def test_no_unexpected_warnings(build_result) -> None:
    """Warnings outside the allow-list indicate real source-level regressions.

    The allow-list is ``ALLOWED_WARNING_CODES`` — currently just MSB3277
    (assembly version conflict, benign for compile-only verification).
    """
    _, unexpected = _classify_warnings(build_result.stdout)
    assert not unexpected, (
        "DevMode build emitted warnings outside the allow-list. Either fix "
        "the warning at the source or add the code to "
        "ALLOWED_WARNING_CODES with a comment explaining why.\n" + "\n".join(unexpected[:20]),
    )


def test_devmode_files_count_matches_deploy_list() -> None:
    """Sanity: the number of .cs files we compile should equal the number
    of entries in edog.py's DEVMODE_FILES. If a new file is added to one
    side and not the other, this guard fires."""
    devmode_dir = REPO_ROOT / "src" / "backend" / "DevMode"
    actual = sorted(p.name for p in devmode_dir.glob("*.cs"))

    edog_py = (REPO_ROOT / "edog.py").read_text(encoding="utf-8")
    # Lines like:  "EdogQaTelemetry": SERVICE_PATH / "DevMode/EdogQaTelemetry.cs",
    import re

    registered = sorted(
        set(re.findall(r'"DevMode/([\w]+\.cs)"', edog_py)),
    )
    assert actual == registered, (
        f"DevMode/*.cs files do not match edog.py DEVMODE_FILES:\n  on disk:    {actual}\n  registered: {registered}"
    )
