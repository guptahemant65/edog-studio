"""Fetch + parse a PR's clean unified diff (ADO): changed files (with +/- line
counts), changed symbols, config-value facts, and feature-flag references split
into introduced (added) vs removed. Blast radius MUST use this, never a
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
    files: list[dict] = []
    by_path: dict[str, dict] = {}
    symbols: list[dict] = []
    facts: list[dict] = []
    flags_added: set[str] = set()
    flags_removed: set[str] = set()
    seen: set[tuple[str, str]] = set()
    current: dict | None = None
    for line in diff_text.splitlines():
        fm = _FILE_RE.match(line)
        if fm:
            current = {"path": fm.group("b"), "added": 0, "removed": 0}
            files.append(current)
            by_path[current["path"]] = current
            continue
        is_add = line.startswith("+") and not line.startswith("++")
        is_del = line.startswith("-") and not line.startswith("--")
        if line.startswith("@@"):
            # Hunk header: trailing context names the enclosing class/method.
            text = line.split("@@")[-1]
        elif is_add or is_del:
            text = line[1:]
            if current is not None:
                current["added" if is_add else "removed"] += 1
        else:
            continue
        for rx, kind in ((_CLASS_RE, "type"), (_METHOD_RE, "method")):
            for sm in rx.finditer(text):
                key = (kind, sm.group("name"))
                if key not in seen:
                    seen.add(key)
                    symbols.append({"kind": kind, "name": sm.group("name")})
        for cm in _CONST_RE.finditer(text):
            facts.append({"name": cm.group("name"), "value": cm.group("value")})
        for flag in _FLAG_RE.finditer(text):
            name = flag.group("name")
            if is_add:
                flags_added.add(name)
            elif is_del:
                flags_removed.add(name)
            else:  # hunk-header context counts as a plain reference, not a change
                flags_added.add(name)
                flags_removed.add(name)
    union = sorted(flags_added | flags_removed)
    # A flag only on + lines is newly introduced/used; only on - lines is removed;
    # on both (or in context) it was merely touched, not introduced or removed.
    return {
        "files": files,
        "symbols": symbols,
        "config_facts": facts,
        "feature_flags": union,
        "feature_flags_added": sorted(flags_added - flags_removed),
        "feature_flags_removed": sorted(flags_removed - flags_added),
    }


def fetch_and_parse(pr_url: str, *, client: Callable[[str], str]) -> dict:
    res = parse_diff(client(pr_url))
    res["prUrl"] = pr_url
    return res
