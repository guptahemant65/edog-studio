"""Pure git operations for the FLT branch switcher.

No HTTP, no studio state. Every git call is best-effort with a timeout and
never raises. The HTTP layer (dev-server.py) owns the phase guard and config
resolution; this module owns the git mechanics.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

# Phases during which the working tree is bound to a running/deploying FLT
# build. Switching the branch under it would make the displayed branch lie
# about what is executing, so we refuse.
LOCKED_PHASES = frozenset({"deploying", "running"})
# Phases where switching is safe (pre-deploy or torn down).
ALLOWED_PHASES = frozenset({"idle", "stopped", "crashed"})


def phase_allows_switch(phase: str | None) -> bool:
    """True only for explicitly-allowed pre-deploy phases. Fails closed."""
    return phase in ALLOWED_PHASES


def _run_git(
    repo_path: str, args: list[str], timeout: int = 15
) -> tuple[int, str, str]:
    """Run ``git <args>`` in *repo_path*. Returns (code, stdout, stderr).

    Never raises: transport/timeout failures return (1, "", "<reason>").
    """
    if not repo_path or not Path(repo_path).is_dir():
        return (1, "", "invalid repo path")
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
        return (result.returncode, result.stdout, result.stderr)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return (1, "", str(exc))


def get_current_branch(repo_path: str) -> tuple[str, bool]:
    """Return (name, detached). On detached HEAD, name is the short SHA."""
    code, out, _ = _run_git(repo_path, ["rev-parse", "--abbrev-ref", "HEAD"])
    name = out.strip()
    if code != 0:
        return ("", False)
    if name == "HEAD":
        _, sha, _ = _run_git(repo_path, ["rev-parse", "--short", "HEAD"])
        return (sha.strip(), True)
    return (name, False)


def _ahead_behind(repo_path: str, current: str, target: str) -> tuple[int, int]:
    """(ahead, behind) of *target* relative to *current*.

    ahead  = commits in target not in current.
    behind = commits in current not in target.
    """

    def _count(rng: str) -> int:
        code, out, _ = _run_git(repo_path, ["rev-list", "--count", rng])
        if code != 0:
            return 0
        try:
            return int(out.strip())
        except ValueError:
            return 0

    ahead = _count(f"{current}..{target}")
    behind = _count(f"{target}..{current}")
    return (ahead, behind)


def _edog_surface_diff(
    repo_path: str, current: str, target: str, edog_patched: set[str]
) -> list[str]:
    """Files in *edog_patched* that differ between *current* and *target*.

    Predicts whether EDOG's patch will apply cleanly when the user next
    deploys on *target*. No-op (empty) when *edog_patched* is empty
    (e.g. never deployed, so .edog-changes.patch is absent).
    """
    if not edog_patched or current == target:
        return []
    args = ["diff", "--name-only", current, target, "--", *sorted(edog_patched)]
    code, out, _ = _run_git(repo_path, args)
    if code != 0:
        return []
    return [line.strip() for line in out.splitlines() if line.strip()]


# Tab-separated for-each-ref format: name \t relative-date \t author \t subject
_REF_FORMAT = (
    "%(refname:short)%09%(committerdate:relative)%09"
    "%(authorname)%09%(contents:subject)"
)


def _list_refs(repo_path: str, ref_glob: str) -> list[dict]:
    """Parse `git for-each-ref` rows for a ref namespace (sorted recent-first)."""
    code, out, _ = _run_git(
        repo_path,
        [
            "for-each-ref",
            "--sort=-committerdate",
            f"--format={_REF_FORMAT}",
            ref_glob,
        ],
    )
    if code != 0:
        return []
    rows: list[dict] = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        rows.append(
            {
                "name": parts[0].strip(),
                "relativeDate": parts[1].strip(),
                "author": parts[2].strip(),
                "subject": parts[3].strip(),
            }
        )
    return rows


def _enrich(
    repo_path: str, rows: list[dict], current: str, edog_patched: set[str]
) -> list[dict]:
    """Add ahead/behind + edog-surface fields to each ref row."""
    for r in rows:
        if r["name"] == current:
            r["ahead"], r["behind"] = 0, 0
            r["touchesEdogSurface"] = False
            r["edogSurfaceFiles"] = []
            continue
        r["ahead"], r["behind"] = _ahead_behind(repo_path, current, r["name"])
        touched = _edog_surface_diff(repo_path, current, r["name"], edog_patched)
        r["touchesEdogSurface"] = bool(touched)
        r["edogSurfaceFiles"] = touched
    return rows


def list_branches(
    repo_path: str, edog_patched: set[str], include_remote: bool = False
) -> dict:
    """Return {current, detached, local:[row], remote:[row]}.

    Caller is responsible for fetching first when include_remote is True.
    """
    current, detached = get_current_branch(repo_path)
    local = _enrich(
        repo_path, _list_refs(repo_path, "refs/heads/"), current, edog_patched
    )
    remote: list[dict] = []
    if include_remote:
        remote = _enrich(
            repo_path,
            _list_refs(repo_path, "refs/remotes/"),
            current,
            edog_patched,
        )
    return {
        "current": current,
        "detached": detached,
        "local": local,
        "remote": remote,
    }


def branch_exists(repo_path: str, branch: str) -> bool:
    """True if *branch* resolves as a local or remote ref."""
    if not branch:
        return False
    code, _, _ = _run_git(
        repo_path, ["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"]
    )
    if code == 0:
        return True
    code, _, _ = _run_git(
        repo_path,
        ["rev-parse", "--verify", "--quiet", f"refs/remotes/{branch}"],
    )
    return code == 0


def count_unpushed(repo_path: str) -> int:
    """Commits on the current branch not present on its upstream. 0 if no
    upstream is configured."""
    code, out, _ = _run_git(repo_path, ["rev-list", "--count", "@{u}..HEAD"])
    if code != 0:
        return 0
    try:
        return int(out.strip())
    except ValueError:
        return 0


def count_stashes(repo_path: str) -> int:
    """Number of entries in the stash list."""
    code, out, _ = _run_git(repo_path, ["stash", "list"])
    if code != 0:
        return 0
    return sum(1 for line in out.splitlines() if line.strip())


def fetch_remotes(repo_path: str) -> bool:
    """Run `git fetch --all --prune`. Returns True on success."""
    code, _, _ = _run_git(
        repo_path, ["fetch", "--all", "--prune"], timeout=60
    )
    return code == 0
