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


def _edog_surface_batch(
    repo_path: str, branches: list[str], edog_patched: set[str], baseline: str = "HEAD"
) -> dict[str, list[str]]:
    """Map each branch -> the edog-patched files that differ from *baseline*.

    Replaces a per-branch ``git diff`` (N subprocess spawns) with a single
    ``git cat-file --batch-check`` process: we ask for the blob OID of every
    (ref, file) pair at once and a file is "touched" when its OID on the branch
    differs from the baseline (HEAD). No-op ({}) when *edog_patched* is empty.
    """
    files = sorted(edog_patched)
    if not files or not branches or not repo_path or not Path(repo_path).is_dir():
        return {}

    # Build one query line per (ref, file). First block is the baseline, then
    # one block per branch — order is preserved in --batch-check output.
    refs = [baseline, *branches]
    query = "\n".join(f"{ref}:{f}" for ref in refs for f in files) + "\n"

    _MISSING = "\x00missing"  # sentinel that can never equal a real OID

    try:
        result = subprocess.run(
            ["git", "cat-file", "--batch-check=%(objectname)"],
            cwd=repo_path,
            input=query,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return {}
    if result.returncode != 0:
        return {}

    out_lines = result.stdout.splitlines()
    expected = len(refs) * len(files)
    if len(out_lines) != expected:
        return {}

    def _oid(line: str) -> str:
        # "<oid>" on success, or "<spec> missing" when the path is absent.
        return _MISSING if line.endswith("missing") else line.split()[0]

    oids = [_oid(line) for line in out_lines]
    base = oids[: len(files)]  # baseline block

    surface: dict[str, list[str]] = {}
    for bi, branch in enumerate(branches):
        block = oids[(bi + 1) * len(files) : (bi + 2) * len(files)]
        touched = [files[fi] for fi in range(len(files)) if block[fi] != base[fi]]
        if touched:
            surface[branch] = touched
    return surface


# Tab-separated for-each-ref format. Field order:
#   name \t relative-date \t author \t ahead-behind \t subject
# The %(ahead-behind:HEAD) token computes each ref's ahead/behind relative to
# HEAD in a SINGLE for-each-ref call. This replaces a per-branch fan-out of two
# `git rev-list --count` subprocesses each (2N process spawns), which made the
# branch list take ~28s on a 100-branch repo. Subject is last because it is free
# text and may itself contain tabs (we re-join the trailing fields for it).
# Requires git >= 2.41 for the ahead-behind token; older git yields an empty
# field, which _parse_ahead_behind safely treats as (0, 0).
_REF_FORMAT = (
    "%(refname:short)%09%(committerdate:relative)%09"
    "%(authorname)%09%(ahead-behind:HEAD)%09%(contents:subject)"
)


def _parse_ahead_behind(token: str) -> tuple[int, int]:
    """Parse a `%(ahead-behind:HEAD)` token ("<ahead> <behind>") into ints.

    Returns (0, 0) for empty/malformed tokens (older git, unborn refs).
    """
    parts = token.split()
    if len(parts) != 2:
        return (0, 0)
    try:
        return (int(parts[0]), int(parts[1]))
    except ValueError:
        return (0, 0)


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
        ahead, behind = _parse_ahead_behind(parts[3])
        subject = "\t".join(parts[4:]) if len(parts) >= 5 else ""
        rows.append(
            {
                "name": parts[0].strip(),
                "relativeDate": parts[1].strip(),
                "author": parts[2].strip(),
                "subject": subject.strip(),
                "ahead": ahead,
                "behind": behind,
            }
        )
    return rows


def _enrich(
    repo_path: str, rows: list[dict], current: str, edog_patched: set[str]
) -> list[dict]:
    """Add edog-surface fields to each ref row.

    ahead/behind are already populated by ``_list_refs`` via the single
    for-each-ref ``ahead-behind`` token; the edog-surface diff for every branch
    is resolved in one ``git cat-file --batch-check`` call. So this whole
    enrichment costs O(1) git processes regardless of branch count.
    """
    targets = [r["name"] for r in rows if r["name"] != current]
    surface = _edog_surface_batch(repo_path, targets, edog_patched)
    for r in rows:
        if r["name"] == current:
            r["ahead"], r["behind"] = 0, 0
            r["touchesEdogSurface"] = False
            r["edogSurfaceFiles"] = []
            continue
        r.setdefault("ahead", 0)
        r.setdefault("behind", 0)
        touched = surface.get(r["name"], [])
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
        "unpushed": count_unpushed(repo_path),
        "stashes": count_stashes(repo_path),
        "userDirty": len(_user_dirty_paths(repo_path, edog_patched)),
        "edogDirty": _count_edog_dirty(repo_path, edog_patched),
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


def _count_edog_dirty(repo_path: str, edog_patched: set[str]) -> int:
    """Count porcelain entries that ARE EDOG-managed (the complement of
    _user_dirty_paths)."""
    code, out, _ = _run_git(repo_path, ["status", "--porcelain", "-uall"])
    if code != 0:
        return 0
    n = 0
    for raw in out.splitlines():
        if len(raw) < 4:
            continue
        path = raw[3:].strip().replace("\\", "/")
        if path in edog_patched:
            n += 1
    return n


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
        _, sha, _ = _run_git(repo_path, ["rev-parse", "stash@{0}"])
        sha = sha.strip()
        if sha:
            stashed_ref = sha
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
