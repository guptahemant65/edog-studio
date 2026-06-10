"""Guardrail: find_flt_repos must scan ALL priority dirs and dedup results.

The first-run silent-wrong-repo bug had two cooperating causes. This file pins
the discovery half: ``find_flt_repos`` used to ``break`` out of the priority-dir
loop the moment ANY single dir yielded a hit. So a decoy clone in an *earlier*
priority dir (e.g. ~/source/repos) hid the user's real repo in a *later* one
(e.g. ~/work), and the caller, seeing exactly one result, auto-selected the
wrong path with no prompt.

These tests assert the scan aggregates across every priority dir and dedups by
resolved path. Mutation check: restore ``if found or timed_out: break`` in the
priority loop and ``test_scan_aggregates_across_priority_dirs`` goes red (the
later repo disappears).
"""

from __future__ import annotations

from pathlib import Path

from scripts import repo_discovery


def _make_flt_repo(parent: Path, name: str) -> Path:
    """Create a minimal dir tree carrying the FLT marker (find_flt_repos only
    checks is_flt_repo, i.e. the marker path — no real git needed)."""
    repo = parent / name
    (repo / repo_discovery.FLT_MARKER).mkdir(parents=True)
    return repo


def _empty_home(tmp_path: Path, monkeypatch) -> Path:
    """Point home + cwd at an empty dir and disable the Q:\\ devbox root so the
    test controls exactly which roots can match."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.chdir(home)
    monkeypatch.setattr(repo_discovery, "DEVBOX_DRIVE_ROOT", tmp_path / "no-such-drive")
    return home


def test_scan_aggregates_across_priority_dirs(tmp_path, monkeypatch):
    """A repo in a LATER priority dir must surface even when an EARLIER priority
    dir already matched. This is the core break-on-first regression."""
    home = _empty_home(tmp_path, monkeypatch)

    decoy = _make_flt_repo(home / "source" / "repos", "decoy-fork")
    real = _make_flt_repo(home / "work", "workload-fabriclivetable")

    result = repo_discovery.find_flt_repos()

    found = result["found"]
    assert str(decoy.resolve()) in found, "earlier-dir repo missing"
    assert str(real.resolve()) in found, "later-dir repo was hidden by break-on-first"
    assert len(found) >= 2


def test_scan_dedups_overlapping_roots(tmp_path, monkeypatch):
    """When two priority roots resolve to the same repo (e.g. cwd == a scanned
    dir), the repo must appear exactly once."""
    home = _empty_home(tmp_path, monkeypatch)

    repos_dir = home / "source" / "repos"
    repo = _make_flt_repo(repos_dir, "workload-fabriclivetable")
    # cwd points INTO the same dir that source/repos scans -> overlap.
    monkeypatch.chdir(repos_dir)

    result = repo_discovery.find_flt_repos()

    found = result["found"]
    rp = str(repo.resolve())
    assert found.count(rp) == 1, f"repo appeared {found.count(rp)} times, want 1"
