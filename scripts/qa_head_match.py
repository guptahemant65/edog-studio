"""Confirm the deployed FLT runs the PR commit, ignoring EDOG's injection set.

A mismatch is a HARNESS failure, not a verdict on the change: EDOG injects its
own DevMode files at deploy time, so the working tree is always "dirty" with a
known set that must be ignored when checking HEAD.
"""

from __future__ import annotations


def compare(*, pr_commit: str, deployed_commit: str, dirty_files: set[str], injected: set[str]) -> dict:
    if pr_commit != deployed_commit:
        return {"match": False, "reason": "commit_mismatch"}
    unexpected = {f for f in dirty_files if f not in injected}
    if unexpected:
        return {"match": False, "reason": "unexpected_dirty", "files": sorted(unexpected)}
    return {"match": True, "reason": "ok"}
