"""Fetch + parse a PR's clean unified diff (ADO): changed files, symbols,
config-value facts, and feature-flag refs. Blast radius MUST use this, never a
patched-tree git diff.
"""

from __future__ import annotations

import re
from collections.abc import Callable

_FILE_RE = re.compile(r"^diff --git a/.+? b/(?P<b>.+)$", re.MULTILINE)
_CLASS_RE = re.compile(r"\b(?:class|interface|record|struct)\s+(?P<name>[A-Z]\w+)")
_METHOD_RE = re.compile(r"\b(?:public|private|internal|protected)\s+[\w<>\[\],\s]+?\s+(?P<name>[A-Z]\w+)\s*\(")
_CONST_RE = re.compile(r"\b(?:const\s+\w+|int|long|double|var)\s+(?P<name>\w+)\s*=\s*(?P<value>\d+)")
_FLAG_RE = re.compile(r"\bFeatureNames\.(?P<name>[A-Z]\w+)")


def parse_diff(diff_text: str) -> dict:
    files = [{"path": m.group("b")} for m in _FILE_RE.finditer(diff_text)]
    symbols: list[dict] = []
    facts: list[dict] = []
    flags: set[str] = set()
    seen: set[tuple[str, str]] = set()
    for line in diff_text.splitlines():
        if line.startswith("@@"):
            # Hunk header: the trailing context (after the 2nd @@) names the
            # enclosing class/method the change lives in -> attribute it.
            added = line.split("@@")[-1]
        elif (line.startswith("+") and not line.startswith("++")) or (
            line.startswith("-") and not line.startswith("--")
        ):
            added = line[1:]
        else:
            continue
        for rx, kind in ((_CLASS_RE, "type"), (_METHOD_RE, "method")):
            for sm in rx.finditer(added):
                key = (kind, sm.group("name"))
                if key not in seen:
                    seen.add(key)
                    symbols.append({"kind": kind, "name": sm.group("name")})
        for cm in _CONST_RE.finditer(added):
            facts.append({"name": cm.group("name"), "value": cm.group("value")})
        for fm in _FLAG_RE.finditer(added):
            flags.add(fm.group("name"))
    return {
        "files": files,
        "symbols": symbols,
        "config_facts": facts,
        "feature_flags": sorted(flags),
    }


def fetch_and_parse(pr_url: str, *, client: Callable[[str], str]) -> dict:
    res = parse_diff(client(pr_url))
    res["prUrl"] = pr_url
    return res
