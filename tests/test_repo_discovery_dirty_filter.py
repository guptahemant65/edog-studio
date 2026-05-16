"""Regression tests for the EDOG-aware dirty-files filter in
repo_discovery.validate_repo.

The "+N dirty" indicator on the EDOG Studio topbar used to count every
line of `git status --porcelain` from the FLT repo. After a deploy that
includes 9 patched files + ~40 untracked DevMode/*.cs files, this made
the indicator permanently show ~49 even when the user hadn't touched
anything. These tests pin the filter behaviour so the indicator only
reflects USER changes from now on.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from scripts import repo_discovery

PROJECT_DIR = Path(__file__).resolve().parents[1]


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", *args],
        cwd=str(repo),
        stderr=subprocess.DEVNULL,
    ).decode()


@pytest.fixture
def fake_flt_repo(tmp_path: Path) -> Path:
    """Minimal repo with FLT marker layout + an initial commit."""
    repo = tmp_path / "flt"
    (repo / "Service" / "Microsoft.LiveTable.Service" / "DevMode").mkdir(parents=True)
    (repo / "Service" / "Microsoft.LiveTable.Service.EntryPoint" / "WorkloadParameters" / "Rollouts").mkdir(
        parents=True
    )
    workload_app = repo / "Service" / "Microsoft.LiveTable.Service" / "WorkloadApp.cs"
    workload_app.write_text("// original\n", encoding="utf-8")
    user_file = repo / "Service" / "Microsoft.LiveTable.Service" / "Controllers.cs"
    user_file.write_text("// user file\n", encoding="utf-8")
    subprocess.check_call(["git", "init", "-q"], cwd=str(repo))
    subprocess.check_call(["git", "config", "user.email", "t@t"], cwd=str(repo))
    subprocess.check_call(["git", "config", "user.name", "t"], cwd=str(repo))
    subprocess.check_call(["git", "add", "."], cwd=str(repo))
    subprocess.check_call(["git", "commit", "-q", "-m", "init"], cwd=str(repo))
    return repo


def test_parse_porcelain_path_simple():
    assert repo_discovery._parse_porcelain_path(" M Service/foo.cs") == "Service/foo.cs"
    assert repo_discovery._parse_porcelain_path("?? Service/bar.cs") == "Service/bar.cs"
    assert repo_discovery._parse_porcelain_path("MM Service/baz.cs") == "Service/baz.cs"


def test_parse_porcelain_path_rename():
    line = "R  Service/old.cs -> Service/new.cs"
    assert repo_discovery._parse_porcelain_path(line) == "Service/new.cs"


def test_parse_porcelain_path_quoted():
    line = ' M "Service/path with spaces.cs"'
    assert repo_discovery._parse_porcelain_path(line) == "Service/path with spaces.cs"


def test_parse_porcelain_path_too_short():
    assert repo_discovery._parse_porcelain_path("") is None
    assert repo_discovery._parse_porcelain_path("MM") is None


def test_is_edog_managed_devmode_dir():
    assert repo_discovery._is_edog_managed("Service/Microsoft.LiveTable.Service/DevMode/EdogLogServer.cs", set())


def test_is_edog_managed_patched_file():
    patched = {"Service/Microsoft.LiveTable.Service/WorkloadApp.cs"}
    assert repo_discovery._is_edog_managed("Service/Microsoft.LiveTable.Service/WorkloadApp.cs", patched)


def test_is_edog_managed_user_file():
    assert not repo_discovery._is_edog_managed("Service/Microsoft.LiveTable.Service/Controllers.cs", set())


def test_validate_repo_filters_devmode_untracked(fake_flt_repo: Path, monkeypatch):
    # No edog-changes.patch -> patched set is empty
    monkeypatch.setattr(
        repo_discovery,
        "EDOG_PATCH_FILE",
        fake_flt_repo / ".nonexistent.patch",
    )
    # Drop 3 untracked DevMode files (what edog does on deploy)
    devmode = fake_flt_repo / "Service" / "Microsoft.LiveTable.Service" / "DevMode"
    for name in ("EdogLogServer.cs", "EdogTopicRouter.cs", "EdogPlaygroundHub.cs"):
        (devmode / name).write_text("// edog\n", encoding="utf-8")

    result = repo_discovery.validate_repo(fake_flt_repo)
    assert result["valid"] is True
    assert result["gitDirtyTotal"] == 3
    assert result["gitDirtyEdog"] == 3
    assert result["gitDirty"] == 0


def test_validate_repo_filters_patched_modifications(fake_flt_repo: Path, tmp_path: Path, monkeypatch):
    """A modified file listed in .edog-changes.patch should be filtered out."""
    # Place patch file OUTSIDE the fake repo so it doesn't appear as untracked
    patch_file = tmp_path / "patch_outside" / ".edog-changes.patch"
    patch_file.parent.mkdir()
    patch_file.write_text(
        "diff --git a/Service/Microsoft.LiveTable.Service/WorkloadApp.cs "
        "b/Service/Microsoft.LiveTable.Service/WorkloadApp.cs\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(repo_discovery, "EDOG_PATCH_FILE", patch_file)

    # Modify the edog-patched file
    (fake_flt_repo / "Service" / "Microsoft.LiveTable.Service" / "WorkloadApp.cs").write_text(
        "// patched by edog\n", encoding="utf-8"
    )
    result = repo_discovery.validate_repo(fake_flt_repo)
    assert result["gitDirtyTotal"] == 1
    assert result["gitDirtyEdog"] == 1
    assert result["gitDirty"] == 0


def test_validate_repo_counts_real_user_changes(fake_flt_repo: Path, monkeypatch):
    """User edits to non-edog files MUST still surface in gitDirty."""
    monkeypatch.setattr(
        repo_discovery,
        "EDOG_PATCH_FILE",
        fake_flt_repo / ".nonexistent.patch",
    )
    # Drop edog files (filtered)
    (fake_flt_repo / "Service" / "Microsoft.LiveTable.Service" / "DevMode" / "EdogX.cs").write_text(
        "// edog\n", encoding="utf-8"
    )
    # User-edited file (NOT filtered)
    (fake_flt_repo / "Service" / "Microsoft.LiveTable.Service" / "Controllers.cs").write_text(
        "// user change\n", encoding="utf-8"
    )

    result = repo_discovery.validate_repo(fake_flt_repo)
    assert result["gitDirtyTotal"] == 2
    assert result["gitDirtyEdog"] == 1
    assert result["gitDirty"] == 1


def test_validate_repo_clean_tree(fake_flt_repo: Path):
    result = repo_discovery.validate_repo(fake_flt_repo)
    assert result["gitDirtyTotal"] == 0
    assert result["gitDirtyEdog"] == 0
    assert result["gitDirty"] == 0


def test_edog_patched_paths_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(repo_discovery, "EDOG_PATCH_FILE", tmp_path / ".no.patch")
    assert repo_discovery._edog_patched_paths() == set()


def test_edog_patched_paths_parses_multiple(tmp_path, monkeypatch):
    patch = tmp_path / ".edog-changes.patch"
    patch.write_text(
        "diff --git a/Service/a.cs b/Service/a.cs\n"
        "--- a/Service/a.cs\n"
        "+++ b/Service/a.cs\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        "+new\n"
        "diff --git a/Service/b.cs b/Service/b.cs\n"
        "--- a/Service/b.cs\n"
        "+++ b/Service/b.cs\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        "+new\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(repo_discovery, "EDOG_PATCH_FILE", patch)
    assert repo_discovery._edog_patched_paths() == {"Service/a.cs", "Service/b.cs"}
