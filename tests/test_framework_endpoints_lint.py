"""SF-005 lint: framework-endpoints.json covers every non-controller route
that the FLT workload exposes via middleware (UseSwagger / UseSwaggerUI /
MapHub).

Strategy:
  1. Grep the FLT source for the registration calls.
  2. For each match, assert framework-endpoints.json has an entry whose
     `controller` field references the originating call (string match).

The point of this test is to fail noisily if FLT adds a new framework
route (e.g. someone adds a SignalR hub for live DAG events) so the
edog-studio Playground stays in sync.

This test is SKIPPED when the FLT repo is not present on disk so it
doesn't break CI on machines without the workload checkout.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

# Default location relative to this repo's parent — matches the docs in
# AGENTS.md / README ("FLT repo is in newrepo dir only").
_DEFAULT_FLT_DIRS = [
    Path(__file__).resolve().parents[2] / "workload-fabriclivetable",
    Path(__file__).resolve().parents[2] / "workload-livetable",
]
_FRAMEWORK_FILE = Path(__file__).resolve().parents[1] / "data" / "framework-endpoints.json"


def _resolve_flt_repo() -> Path | None:
    """Return the FLT repo path, or None if unavailable."""
    env = os.environ.get("EDOG_FLT_REPO")
    if env:
        p = Path(env)
        if p.is_dir():
            return p
    for candidate in _DEFAULT_FLT_DIRS:
        if candidate.is_dir():
            return candidate
    return None


def _flt_source_files(repo: Path) -> list[Path]:
    """Return all .cs files under the Service/ tree (skips test/bin/obj)."""
    out: list[Path] = []
    root = repo / "Service"
    if not root.is_dir():
        return out
    for p in root.rglob("*.cs"):
        if any(seg in {"bin", "obj", "TestResults"} for seg in p.parts):
            continue
        out.append(p)
    return out


_PATTERNS = {
    "swagger_spec": re.compile(r"\bapp\.UseSwagger\s*\(\s*\)"),
    "swagger_ui": re.compile(r"\bapp\.UseSwaggerUI\s*\("),
    "signalr_hub": re.compile(r"\bMapHub\s*<"),
}


@pytest.fixture(scope="module")
def flt_repo() -> Path:
    p = _resolve_flt_repo()
    if p is None:
        pytest.skip(
            "FLT repo not found in expected location — skipping framework-endpoints "
            "lint. Set EDOG_FLT_REPO to override."
        )
    return p


@pytest.fixture(scope="module")
def framework_doc() -> dict:
    return json.loads(_FRAMEWORK_FILE.read_text(encoding="utf-8"))


def _scan(repo: Path, pattern: re.Pattern) -> list[Path]:
    hits: list[Path] = []
    for src in _flt_source_files(repo):
        try:
            if pattern.search(src.read_text(encoding="utf-8-sig", errors="replace")):
                hits.append(src)
        except OSError:
            continue
    return hits


class TestFrameworkEndpointsCoverage:
    def test_swagger_spec_registered_iff_entry_present(self, flt_repo, framework_doc):
        hits = _scan(flt_repo, _PATTERNS["swagger_spec"])
        has_spec_entry = any(e["kind"] == "spec" for e in framework_doc["endpoints"])
        if hits:
            assert has_spec_entry, (
                f"FLT registers UseSwagger() in {len(hits)} file(s) "
                f"({[p.name for p in hits]}) but data/framework-endpoints.json "
                "has no kind=spec entry. Add one."
            )
        else:
            assert not has_spec_entry, (
                "data/framework-endpoints.json declares a kind=spec entry but "
                "no app.UseSwagger() call was found in FLT. Remove it or fix "
                "the spec pattern in this test."
            )

    def test_swagger_ui_registered_iff_entry_present(self, flt_repo, framework_doc):
        hits = _scan(flt_repo, _PATTERNS["swagger_ui"])
        has_ui_entry = any(e["kind"] == "ui" for e in framework_doc["endpoints"])
        if hits:
            assert has_ui_entry, (
                f"FLT registers UseSwaggerUI() in {len(hits)} file(s) "
                "but data/framework-endpoints.json has no kind=ui entry."
            )
        else:
            assert not has_ui_entry, (
                "data/framework-endpoints.json declares a kind=ui entry but "
                "no app.UseSwaggerUI() call was found in FLT."
            )

    def test_signalr_hubs_registered_iff_entries_present(self, flt_repo, framework_doc):
        hits = _scan(flt_repo, _PATTERNS["signalr_hub"])
        signalr_entries = [e for e in framework_doc["endpoints"] if e["kind"] == "signalr"]
        if hits and not signalr_entries:
            pytest.fail(
                f"FLT registers MapHub<...> in {len(hits)} file(s) "
                f"({[p.name for p in hits]}) but data/framework-endpoints.json "
                "has no kind=signalr entries. Add one per hub."
            )
        if signalr_entries and not hits:
            pytest.fail(
                "data/framework-endpoints.json declares kind=signalr entries but no MapHub<...> call was found in FLT."
            )
