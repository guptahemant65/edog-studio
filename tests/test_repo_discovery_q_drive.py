"""Guardrail: the first-time repo scan must reach the devbox Q:\\ drive.

Microsoft Dev Box guarantees a dedicated local dev drive at Q:\\ where repos
are cloned (not under C:\\Users). ``find_flt_repos`` is otherwise home-rooted,
so without an explicit Q:\\ root a devbox user gets an empty auto-scan. These
tests pin Q:\\ coverage AND the existence-gating that keeps it a no-op on a
normal (no-Q:) machine.
"""

from __future__ import annotations

from pathlib import Path

from scripts import repo_discovery


def _make_flt_repo(parent: Path, name: str) -> Path:
    """Create a minimal dir tree carrying the FLT marker (no git needed —
    find_flt_repos only checks is_flt_repo, i.e. the marker path)."""
    repo = parent / name
    (repo / repo_discovery.FLT_MARKER).mkdir(parents=True)
    return repo


def _empty_home(tmp_path: Path, monkeypatch) -> Path:
    """Point home + cwd at an empty dir so only the Q:\\ root can match."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.chdir(home)
    return home


def test_scan_finds_repo_on_devbox_q_drive(tmp_path, monkeypatch):
    """A repo under the (faked) Q:\\src must be auto-detected even when C:-home
    is empty. Mutation check: drop the Q:\\ entries from priority+fallback and
    `found` comes back empty, failing this assert."""
    _empty_home(tmp_path, monkeypatch)

    fake_q = tmp_path / "q"
    (fake_q / "src").mkdir(parents=True)
    repo = _make_flt_repo(fake_q / "src", "workload-fabriclivetable")
    monkeypatch.setattr(repo_discovery, "DEVBOX_DRIVE_ROOT", fake_q)

    result = repo_discovery.find_flt_repos()

    assert result["found"], "devbox Q:\\ repo was not auto-detected"
    assert str(repo.resolve()) in result["found"]


def test_scan_finds_repo_cloned_at_q_root(tmp_path, monkeypatch):
    """Bare clone at Q:\\<repo> (not under Q:\\src) is still found via the Q:\\
    root in the priority list / broad fallback."""
    _empty_home(tmp_path, monkeypatch)

    fake_q = tmp_path / "q"
    fake_q.mkdir()
    repo = _make_flt_repo(fake_q, "workload-fabriclivetable")
    monkeypatch.setattr(repo_discovery, "DEVBOX_DRIVE_ROOT", fake_q)

    result = repo_discovery.find_flt_repos()

    assert str(repo.resolve()) in result["found"]


def test_scan_no_op_when_q_drive_absent(tmp_path, monkeypatch):
    """On a non-devbox machine Q:\\ doesn't exist — the scan must not crash and
    must simply find nothing (existence-gating)."""
    _empty_home(tmp_path, monkeypatch)
    monkeypatch.setattr(repo_discovery, "DEVBOX_DRIVE_ROOT", tmp_path / "no-such-drive")

    result = repo_discovery.find_flt_repos()

    assert result["found"] == []
    assert result["timedOut"] is False


def test_scan_prefers_home_over_q_drive(tmp_path, monkeypatch):
    """When a repo exists under C:-home, it's found first (home roots precede
    the Q:\\ root) — devbox support must not regress the laptop common case."""
    home = _empty_home(tmp_path, monkeypatch)
    home_repo = _make_flt_repo(home / "source" / "repos", "workload-fabriclivetable")
    (home / "source" / "repos").mkdir(parents=True, exist_ok=True)

    fake_q = tmp_path / "q"
    (fake_q / "src").mkdir(parents=True)
    _make_flt_repo(fake_q / "src", "workload-fabriclivetable")
    monkeypatch.setattr(repo_discovery, "DEVBOX_DRIVE_ROOT", fake_q)

    result = repo_discovery.find_flt_repos()

    assert str(home_repo.resolve()) in result["found"]
