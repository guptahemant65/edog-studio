"""Tests for scripts/git_branches.py against a real temporary git repo."""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _load_git_branches():
    spec = importlib.util.spec_from_file_location(
        "git_branches", SCRIPTS / "git_branches.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
        encoding="utf-8",
    ).stdout


@pytest.fixture()
def git_repo(tmp_path: Path) -> Path:
    """A real git repo: default branch 'main' with one commit on a file
    'README.md', plus a 'feature' branch that adds a line."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@t.io")
    _git(repo, "config", "user.name", "Tester")
    (repo / "README.md").write_text("base\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "checkout", "-q", "-b", "feature")
    (repo / "README.md").write_text("base\nfeature\n", encoding="utf-8")
    _git(repo, "commit", "-q", "-am", "feature change")
    _git(repo, "checkout", "-q", "main")
    return repo


def test_run_git_returns_tuple(git_repo: Path):
    gb = _load_git_branches()
    code, out, err = gb._run_git(str(git_repo), ["rev-parse", "--abbrev-ref", "HEAD"])
    assert code == 0
    assert out.strip() == "main"


def test_run_git_failure_is_soft(git_repo: Path):
    gb = _load_git_branches()
    code, out, err = gb._run_git(str(git_repo), ["not-a-command"])
    assert code != 0  # never raises


def test_current_branch(git_repo: Path):
    gb = _load_git_branches()
    name, detached = gb.get_current_branch(str(git_repo))
    assert name == "main"
    assert detached is False


def test_detached_head(git_repo: Path):
    gb = _load_git_branches()
    sha = _git(git_repo, "rev-parse", "HEAD").strip()
    _git(git_repo, "checkout", "-q", sha)
    name, detached = gb.get_current_branch(str(git_repo))
    assert detached is True
    assert sha.startswith(name)  # short sha


def test_ahead_behind(git_repo: Path):
    gb = _load_git_branches()
    # 'feature' is 1 commit ahead of 'main'; 'main' is 0 ahead of 'feature'.
    ahead, behind = gb._ahead_behind(str(git_repo), "main", "feature")
    assert ahead == 1   # feature has 1 commit main lacks
    assert behind == 0  # main has 0 commits feature lacks


def test_edog_surface_diff_flags_touched_file(git_repo: Path):
    gb = _load_git_branches()
    # README.md differs between main and feature; treat it as an EDOG file.
    touched = gb._edog_surface_diff(
        str(git_repo), "main", "feature", {"README.md"}
    )
    assert touched == ["README.md"]


def test_edog_surface_diff_empty_set_is_noop(git_repo: Path):
    gb = _load_git_branches()
    assert gb._edog_surface_diff(str(git_repo), "main", "feature", set()) == []


def test_list_branches_rich_rows(git_repo: Path):
    gb = _load_git_branches()
    data = gb.list_branches(str(git_repo), edog_patched={"README.md"})
    assert data["current"] == "main"
    assert data["detached"] is False
    names = {r["name"] for r in data["local"]}
    assert names == {"main", "feature"}
    feat = next(r for r in data["local"] if r["name"] == "feature")
    assert feat["ahead"] == 1
    assert feat["behind"] == 0
    assert feat["subject"] == "feature change"
    assert feat["author"] == "Tester"
    assert feat["relativeDate"]  # non-empty relative string
    assert feat["touchesEdogSurface"] is True
    assert feat["edogSurfaceFiles"] == ["README.md"]
    # The current branch row never flags itself.
    main_row = next(r for r in data["local"] if r["name"] == "main")
    assert main_row["touchesEdogSurface"] is False
