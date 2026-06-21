"""Tests for Beat 1 change resolution (scripts/qa_resolve_change.py).

The git resolution is exercised against a REAL throwaway git repo (branch path);
input classification is pure. ADO (`az`) lookups are I/O and not tested here.
"""

import subprocess

import pytest

from scripts import qa_resolve_change as rc

# ── input classification (pure) ─────────────────────────────────────────────

def test_classify_pr_url():
    c = rc.classify_input("https://dev.azure.com/powerbi/MWC/_git/workload-fabriclivetable/pullrequest/985969")
    assert c["kind"] == "pr_url" and c["prId"] == "985969"


def test_classify_pr_number():
    assert rc.classify_input("985969") == {"kind": "pr_number", "prId": "985969", "raw": "985969"}


def test_classify_branch_and_strips_refs_heads():
    assert rc.classify_input("users/guptahemant/cdf-card-impl")["kind"] == "branch"
    assert rc.classify_input("refs/heads/feature/x")["branch"] == "feature/x"


# ── git resolution (real temp repo) ─────────────────────────────────────────

def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "r"
    r.mkdir()
    _git(r, "init", "-q", "-b", "main")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "user.name", "t")
    (r / "a.txt").write_text("base\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-q", "-m", "base")
    # branch that adds a file + changes a.txt
    _git(r, "checkout", "-q", "-b", "feature")
    (r / "a.txt").write_text("base\nchanged\n")
    (r / "b.cs").write_text("class B {}\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-q", "-m", "feature change")
    _git(r, "checkout", "-q", "main")
    return r


def test_resolve_branch_diff_against_main(repo):
    res = rc.resolve_branch(str(repo), "feature", base="main")
    assert res["ok"] is True
    assert res["source"] == "branch"
    assert set(res["changedFiles"]) == {"a.txt", "b.cs"}
    assert "class B {}" in res["diff"]
    assert res["sourceRef"] == "feature"  # no origin remote -> local branch


def test_resolve_branch_missing_is_honest(repo):
    res = rc.resolve_branch(str(repo), "does-not-exist", base="main")
    assert res["ok"] is False
    assert "not found" in res["reason"]


def test_diff_between_uses_merge_base(repo):
    # advance main AFTER feature branched; merge-base diff must NOT include main's new file
    _git(repo, "checkout", "-q", "main")
    (repo / "c.txt").write_text("only on main\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "main moves on")
    d = rc.diff_between(str(repo), "main", "feature")
    assert d["ok"] is True
    assert "c.txt" not in d["changedFiles"]      # merge-base excludes main-only changes
    assert set(d["changedFiles"]) == {"a.txt", "b.cs"}


def test_find_source_ref_prefers_local_when_no_remote(repo):
    assert rc.find_source_ref(str(repo), "feature") == "feature"
    assert rc.find_source_ref(str(repo), "nope") is None


def test_short_ref():
    assert rc._short_ref("refs/heads/users/x/foo") == "users/x/foo"
    assert rc._short_ref(None) == ""
