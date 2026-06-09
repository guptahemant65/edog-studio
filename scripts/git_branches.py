"""Pure git operations for the FLT branch switcher.

No HTTP, no studio state. Every git call is best-effort with a timeout and
never raises. The HTTP layer (dev-server.py) owns the phase guard and config
resolution; this module owns the git mechanics.
"""

from __future__ import annotations

import subprocess
import time
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


def _user_dirty_paths(repo_path: str, edog_patched: set[str]) -> list[str]:
    """Repo-relative paths with working-tree/index changes that are NOT
    EDOG-managed. Untracked files are included."""
    code, out, _ = _run_git(repo_path, ["status", "--porcelain", "-uall"])
    if code != 0:
        return []
    paths: list[str] = []
    for raw in out.splitlines():
        if len(raw) < 4:
            continue
        path = raw[3:].strip().replace("\\", "/")
        if path in edog_patched:
            continue
        paths.append(path)
    return paths


def stash_apply(repo_path: str, ref: str) -> dict:
    """Apply (not pop) a stash ref onto the current tree."""
    if not ref:
        return {"ok": False, "error": "missing_ref"}
    code, _, err = _run_git(repo_path, ["stash", "apply", ref])
    if code != 0:
        return {"ok": False, "error": "apply_failed", "message": err.strip()}
    return {"ok": True}


def checkout_branch(
    repo_path: str, branch: str, on_dirty: str, edog_patched: set[str]
) -> dict:
    """Switch to *branch*, handling the user's non-EDOG dirty changes.

    on_dirty:
      - "stash":   stash only user paths under a named ref (recoverable).
      - "carry":   leave changes; plain checkout (fails if it would conflict).
      - "discard": restore user tracked paths to HEAD before checkout.

    Returns {ok, branch, leftBranch, stashed, error?, message?}. On any
    checkout failure the working tree is left as git left it and ok=False.
    """
    if on_dirty not in {"stash", "carry", "discard"}:
        return {"ok": False, "error": "bad_on_dirty"}
    if not branch_exists(repo_path, branch):
        return {"ok": False, "error": "unknown_branch"}

    left, _ = get_current_branch(repo_path)
    user_paths = _user_dirty_paths(repo_path, edog_patched)
    stashed_ref: str | None = None

    if user_paths and on_dirty == "stash":
        ts = time.strftime("%Y%m%dT%H%M%S")
        msg = f"edog-switch/{left}->{branch}/{ts}"
        code, _, err = _run_git(
            repo_path, ["stash", "push", "-u", "-m", msg, "--", *user_paths]
        )
        if code != 0:
            return {
                "ok": False,
                "error": "stash_failed",
                "message": err.strip(),
                "leftBranch": left,
            }
        stashed_ref = "stash@{0}"
    elif user_paths and on_dirty == "discard":
        # Restore only tracked user paths; untracked user files are left alone.
        _run_git(repo_path, ["checkout", "--", *user_paths])

    code, _, err = _run_git(repo_path, ["checkout", branch])
    if code != 0:
        return {
            "ok": False,
            "error": "checkout_conflict",
            "message": err.strip(),
            "leftBranch": left,
            "stashed": stashed_ref,
        }
    return {
        "ok": True,
        "branch": branch,
        "leftBranch": left,
        "stashed": stashed_ref,
    }
