"""Phase-guard decision for the branch-switch endpoints."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _load_git_branches():
    spec = importlib.util.spec_from_file_location(
        "git_branches", SCRIPTS / "git_branches.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_phase_allows_switch_pre_deploy():
    gb = _load_git_branches()
    assert gb.phase_allows_switch("idle") is True
    assert gb.phase_allows_switch("stopped") is True
    assert gb.phase_allows_switch("crashed") is True


def test_phase_blocks_switch_while_live():
    gb = _load_git_branches()
    assert gb.phase_allows_switch("deploying") is False
    assert gb.phase_allows_switch("running") is False


def test_phase_unknown_is_blocked_safely():
    gb = _load_git_branches()
    # Unknown/empty phase must fail closed (treat as not-allowed).
    assert gb.phase_allows_switch("") is False
    assert gb.phase_allows_switch(None) is False
