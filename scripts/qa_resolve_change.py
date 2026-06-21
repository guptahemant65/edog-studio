"""Beat 1 — resolve a change to validate from a branch *or* a PR, server-free.

The skill used to require a PR and resolve it through EDOG's ado-proxy (which
needs the server up). Beat 1 is now branch-first and needs no server:

  PR exists for the branch?  -> use the PR (az metadata + git diff). Done.
  No PR?                      -> origin/<branch>, else the local branch,
                             -> git diff against the default branch's merge-base.

The git diff is the true state of the change at this point (nothing is deployed
yet, so a plain diff is correct). The result feeds qa_pr_diff + Beat 2. The EDOG
server is started later (Beat 4), only when real infrastructure is needed.

The git resolution is deterministic and unit-tested; the ADO (`az`) lookups are
thin I/O.
"""

from __future__ import annotations

import json
import re
import subprocess

# ADO defaults for the FLT repo (powerbi/MWC/workload-fabriclivetable).
DEFAULT_ORG = "https://dev.azure.com/powerbi"
DEFAULT_PROJECT = "MWC"
DEFAULT_REPO = "workload-fabriclivetable"
DEFAULT_BASE = "origin/main"  # FLT default branch (single remote: origin)

_PR_URL_RE = re.compile(r"/pull[rR]equest/(?P<id>\d+)")


# ── input classification (pure) ─────────────────────────────────────────────

def classify_input(s: str) -> dict:
    """Decide whether `s` is a PR URL, a bare PR number, or a branch name."""
    s = s.strip()
    m = _PR_URL_RE.search(s)
    if m:
        return {"kind": "pr_url", "prId": m.group("id"), "raw": s}
    if s.isdigit():
        return {"kind": "pr_number", "prId": s, "raw": s}
    # strip a refs/heads/ prefix if present; otherwise it's a branch name
    branch = s[len("refs/heads/"):] if s.startswith("refs/heads/") else s
    return {"kind": "branch", "branch": branch, "raw": s}


# ── git (deterministic core) ────────────────────────────────────────────────

def _git(repo: str, *args: str) -> tuple[int, str, str]:
    # Decode as UTF-8 (git's output encoding), not the Windows locale (cp1252),
    # which crashes on diffs containing non-cp1252 bytes.
    proc = subprocess.run(["git", "-C", repo, "--no-pager", *args],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
    return proc.returncode, proc.stdout, proc.stderr


def _rev_parse(repo: str, ref: str) -> str | None:
    code, out, _ = _git(repo, "rev-parse", "--verify", "--quiet", ref)
    return out.strip() if code == 0 and out.strip() else None


def find_source_ref(repo: str, branch: str) -> str | None:
    """Prefer the remote branch (authoritative), else the local branch."""
    for ref in (f"origin/{branch}", branch):
        if _rev_parse(repo, ref):
            return ref
    return None


def diff_between(repo: str, base_ref: str, head_ref: str) -> dict:
    """Three-dot (merge-base) diff: the changes `head_ref` introduces over `base_ref`.

    Returns sourceCommit, baseCommit (the merge-base), the unified diff text, and
    the changed-file list. The merge-base matches what a PR shows, so the branch
    path and the PR path produce the same shape.
    """
    head = _rev_parse(repo, head_ref)
    if head is None:
        return {"ok": False, "reason": f"cannot resolve ref '{head_ref}'"}
    code, mb, err = _git(repo, "merge-base", base_ref, head_ref)
    if code != 0 or not mb.strip():
        return {"ok": False, "reason": f"no merge-base of '{base_ref}' and '{head_ref}': {err.strip()}"}
    base = mb.strip()
    _, diff, _ = _git(repo, "diff", f"{base}...{head}")
    _, names, _ = _git(repo, "diff", "--name-only", f"{base}...{head}")
    files = [f.strip() for f in names.splitlines() if f.strip()]
    return {"ok": True, "sourceCommit": head, "baseCommit": base, "diff": diff, "changedFiles": files}


def resolve_branch(repo: str, branch: str, *, base: str = DEFAULT_BASE) -> dict:
    """No-PR path: diff the branch against the default branch's merge-base."""
    src = find_source_ref(repo, branch)
    if src is None:
        return {"ok": False, "source": "branch", "branch": branch,
                "reason": f"branch '{branch}' not found locally or on origin"}
    d = diff_between(repo, base, src)
    if not d.get("ok"):
        return {"ok": False, "source": "branch", "branch": branch, **d}
    return {"ok": True, "source": "branch", "branch": branch, "sourceRef": src, "baseRef": base, **d}


# ── ADO (`az`) lookups (I/O) ────────────────────────────────────────────────

def _az_json(args: list[str]) -> object | None:
    try:
        proc = subprocess.run(["az", *args, "-o", "json"], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def find_open_pr(branch: str, *, org: str = DEFAULT_ORG, project: str = DEFAULT_PROJECT,
                 repo_name: str = DEFAULT_REPO) -> dict | None:
    """Return the active PR whose source branch is `branch`, or None."""
    rows = _az_json(["repos", "pr", "list", "--org", org, "--project", project,
                     "--repository", repo_name, "--source-branch", branch, "--status", "active"])
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


def pr_metadata(pr_id: str, *, org: str = DEFAULT_ORG) -> dict | None:
    pr = _az_json(["repos", "pr", "show", "--id", str(pr_id), "--org", org])
    return pr if isinstance(pr, dict) else None


def _short_ref(ref_name: str | None) -> str:
    """refs/heads/users/x/foo -> users/x/foo."""
    if not ref_name:
        return ""
    return ref_name[len("refs/heads/"):] if ref_name.startswith("refs/heads/") else ref_name


def resolve_pr(pr: dict, repo: str) -> dict:
    """PR path: combine az metadata with a git diff (source vs target merge-base)."""
    pr_id = pr.get("pullRequestId") or pr.get("codeReviewId")
    title = pr.get("title", "")
    author = (pr.get("createdBy") or {}).get("displayName", "")
    source_branch = _short_ref(pr.get("sourceRefName"))
    target_branch = _short_ref(pr.get("targetRefName")) or "main"
    src = find_source_ref(repo, source_branch) or source_branch
    base = f"origin/{target_branch}" if _rev_parse(repo, f"origin/{target_branch}") else target_branch
    d = diff_between(repo, base, src)
    out = {"ok": d.get("ok", False), "source": "pr", "prId": pr_id, "title": title,
           "author": author, "sourceBranch": source_branch, "targetBranch": target_branch,
           "sourceRef": src, "baseRef": base}
    out.update(d)
    return out


# ── orchestration ───────────────────────────────────────────────────────────

def resolve(user_input: str, repo: str, *, org: str = DEFAULT_ORG, project: str = DEFAULT_PROJECT,
            repo_name: str = DEFAULT_REPO, base: str = DEFAULT_BASE) -> dict:
    """PR-first, branch-fallback resolution. Server-free."""
    cls = classify_input(user_input)

    if cls["kind"] in ("pr_url", "pr_number"):
        pr = pr_metadata(cls["prId"], org=org)
        if pr is None:
            return {"ok": False, "reason": f"PR {cls['prId']} not found via az", "input": cls}
        return resolve_pr(pr, repo)

    # a branch: prefer its open PR, else diff the branch directly
    branch = cls["branch"]
    pr = find_open_pr(branch, org=org, project=project, repo_name=repo_name)
    if pr is not None:
        return resolve_pr(pr, repo)
    return resolve_branch(repo, branch, base=base)


def _main() -> int:
    import argparse

    try:
        from qa_io import ensure_utf8
    except ModuleNotFoundError:
        from scripts.qa_io import ensure_utf8
    ensure_utf8()

    ap = argparse.ArgumentParser(description="Beat 1: resolve a branch or PR to validate (server-free)")
    ap.add_argument("input", help="a branch name, a PR number, or a PR URL")
    ap.add_argument("--repo", required=True, help="path to the FLT git repo")
    ap.add_argument("--base", default=DEFAULT_BASE, help="default branch to diff against (no-PR path)")
    ap.add_argument("--show-diff", action="store_true", help="include the full diff text")
    args = ap.parse_args()

    res = resolve(args.input, args.repo, base=args.base)
    if not args.show_diff:
        res.pop("diff", None)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(_main())
