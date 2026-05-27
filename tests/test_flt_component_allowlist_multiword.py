"""Regression test for the FLT component allowlist scanner.

Locks in the 2026-05-27 fix: the bracket regex in ``scan_flt_components``
must capture multi-word tags such as ``[Token Manager]``, ``[DAG Execution]``,
``[Reliable Ops]``. Pre-fix the character class only matched
``[A-Za-z0-9_]`` so any tag with an internal space was silently dropped,
which in turn caused ``EdogLogInterceptor`` to filter out every log line
from those components in DevMode (TokenManager retries, DAG runtime, reliable
ops, OneLake IO, GTS parsing, etc.).
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
EDOG_PY = REPO_ROOT / "edog.py"


@pytest.fixture(scope="module")
def edog_module():
    spec = importlib.util.spec_from_file_location("edog", EDOG_PY)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _extract_bracket_pattern() -> re.Pattern:
    """Pull the bracket_pattern literal out of edog.py so tests stay in sync."""
    source = EDOG_PY.read_text(encoding="utf-8")
    # Match: bracket_pattern = re.compile(r'<anything-not-single-quote>')
    match = re.search(r"bracket_pattern\s*=\s*re\.compile\(\s*r'([^']+)'\s*\)", source)
    assert match, "bracket_pattern assignment not found in edog.py"
    return re.compile(match.group(1))


class TestBracketPatternAllowsSpaces:
    def test_pattern_matches_token_manager(self) -> None:
        pattern = _extract_bracket_pattern()
        sample = '$"[Token Manager] GetToken request unsuccessful attempt 1"'
        m = pattern.search(sample)
        assert m, (
            "bracket_pattern in edog.py must capture multi-word tags like "
            "'[Token Manager]'. Without this, EdogLogInterceptor filters every "
            "TokenManager log line in DevMode (regression 2026-05-27)."
        )
        assert m.group(1).strip() == "Token Manager"

    def test_pattern_matches_other_multiword_tags(self) -> None:
        pattern = _extract_bracket_pattern()
        samples = {
            "DAG Execution": '$"[DAG Execution] Starting DAG"',
            "Reliable Ops": '$"[Reliable Ops] Registering operation"',
            "OneLake IO": '$"[OneLake IO] Reading file"',
            "GTS Parsing": '$"[GTS Parsing] Parsing response"',
        }
        for expected, sample in samples.items():
            m = pattern.search(sample)
            assert m, f"pattern failed to capture {expected!r}"
            assert m.group(1).strip() == expected

    def test_pattern_still_matches_single_word_tags(self) -> None:
        pattern = _extract_bracket_pattern()
        for tag in ("DevMode", "Catalog", "OneLake", "WES"):
            sample = f'$"[{tag}] message"'
            m = pattern.search(sample)
            assert m, f"single-word tag {tag!r} no longer matches"
            assert m.group(1).strip() == tag

    def test_pattern_rejects_garbage_brackets(self) -> None:
        """Empty / single-char / lowercase-prose tags must not pollute allowlist."""
        pattern = _extract_bracket_pattern()
        rejected = [
            '"[]"',
            '"[][] foo"',
            '"[X]"',
            '"[ ]"',
            '"[123]"',
            '"[hello world] just prose"',
            '"[lowercase]"',
        ]
        for sample in rejected:
            m = pattern.search(sample)
            assert m is None, f"pattern should not match {sample!r}, got {m.group(0) if m else None!r}"


class TestScannerOutputContainsMultiwordTags:
    """End-to-end: running the scanner against the real FLT repo must yield
    the multi-word tags. Skips if the FLT repo isn't checked out next to
    edog-studio (CI / fresh clones)."""

    @pytest.fixture(scope="class")
    def flt_repo(self) -> Path:
        candidate = REPO_ROOT.parent / "workload-fabriclivetable"
        if not candidate.exists():
            pytest.skip(f"FLT repo not present at {candidate}")
        return candidate

    def test_token_manager_in_generated_allowlist(self, edog_module, flt_repo: Path, tmp_path: Path, monkeypatch) -> None:
        edog_module.scan_flt_components(flt_repo)
        out_file = flt_repo / "Service" / "Microsoft.LiveTable.Service" / "DevMode" / "edog-flt-components.json"
        assert out_file.exists()
        import json

        data = json.loads(out_file.read_text(encoding="utf-8"))
        components = set(data.get("components", []))
        for expected in ("Token Manager", "DAG Execution", "Reliable Ops"):
            assert expected in components, (
                f"{expected!r} missing from generated allowlist; bracket regex "
                f"in edog.py likely dropped it. Found {len(components)} components."
            )
