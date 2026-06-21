"""Presentation linter — catch hand-composed / leaked TUI before it's shown.

The skill's terminal output IS the product, and the recurring failure is the
model typing boxes by hand or letting raw tool output (JSON, curl dumps,
tracebacks) leak into the transcript instead of rendering via ``qa_render``. A
prompt can't mechanically force rendering, but this makes a violation
*detectable*: the model runs its drafted beat output through ``lint`` and fixes
every finding before showing it.

Rules (grounded in ``reference/presentation.md``):
  * no raw tool output (JSON / curl / tracebacks)            -> error
  * no emoji (Unicode marks only)                            -> error
  * no box-drawing characters (layout is by indent)          -> error
  * status words only from the fixed set                     -> error
  * no internal jargon on user-facing lines (DAG/MLV ok)     -> warn
  * a result line (✓/✕) should trail a source citation       -> warn
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass

# The only marks the contract allows (presentation.md §2).
ALLOWED_MARKS = set("◆▸✓✕▲◇▣◌▹…·")
# Fixed status vocabulary (presentation.md §5).
STATUS_WORDS = {"PASS", "BROKEN", "SUSPECTED", "COULDN'T CHECK", "NEVER RAN"}
# Other all-caps phrases the contract legitimately uses near a mark.
ALLOWED_PHRASES = {"NEEDS A HUMAN", "OUT OF DATE", "FLAKY", "COULDN'T CHECK"}
# Internal jargon banned on user-facing lines (presentation.md §0). DAG + MLV are
# the only allowed domain words.
BANNED_JARGON = [
    "oracle", "blast radius", "harness", "idempotent", "attribution", "norefresh",
    "cascade-skip", "fitness", "stimulus", "invariant", "interceptor", "merge-base",
    "di binding", "dependency injection", "heartbeat", "teardown ledger", "bearer token",
]
_RESULT_MARKS = ("✓", "✕")
_BOX_DRAWING = re.compile(r"[\u2500-\u257F]")  # ─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ╔ … (not our marks)
_EMOJI = re.compile(
    "[" "\U0001F000-\U0001FAFF" "\U00002600-\U000027BF" "\U0001F1E6-\U0001F1FF"
    "\U00002B00-\U00002BFF" "\U0000FE0F" "]"
)
# Looks-like-raw-JSON: a quoted key followed by a colon, or a lone structural brace line.
_JSON_KV = re.compile(r'"[\w$]+"\s*:')
_TRACEBACK = re.compile(r"Traceback \(most recent call last\)|File \".*\", line \d+")
_ALLCAPS_WORD = re.compile("\\b[A-Z][A-Z'\u2019 ]{2,}\\b")


@dataclass
class Finding:
    line: int
    severity: str  # "error" | "warn"
    rule: str
    detail: str


def _strip(line: str) -> str:
    return line.strip()


def lint(text: str) -> list[Finding]:
    """Return all presentation violations in `text` (a drafted beat block)."""
    findings: list[Finding] = []
    for i, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip()
        low = line.lower()

        # raw tool output ---------------------------------------------------
        stripped = _strip(line)
        if stripped in ("{", "}", "[", "]", "},", "],") or stripped.startswith(("{", "[{", '"')):
            findings.append(Finding(i, "error", "raw_json", "looks like raw JSON — render via qa_render, don't paste tool output"))
        elif _JSON_KV.search(line):
            findings.append(Finding(i, "error", "raw_json", 'contains a "key": value pair — raw tool output leaked'))
        elif _TRACEBACK.search(line):
            findings.append(Finding(i, "error", "raw_traceback", "a traceback leaked into user output"))
        elif "curl " in low or low.startswith("http/"):
            findings.append(Finding(i, "error", "raw_curl", "raw curl/HTTP dump in user output"))

        # emoji / box drawing ----------------------------------------------
        if any(_EMOJI.match(c) and c not in ALLOWED_MARKS for c in line):
            findings.append(Finding(i, "error", "emoji", "emoji used — Unicode marks only"))
        if _BOX_DRAWING.search(line):
            findings.append(Finding(i, "error", "box_drawing", "box-drawing character — lay out by indentation, not drawn tables"))

        # status vocabulary -------------------------------------------------
        for m in _ALLCAPS_WORD.finditer(line):
            word = m.group().strip()
            # ignore short acronyms / the allowed domain words and headings
            if word in ("DAG", "MLV", "PR", "EDOG", "FLT", "ON", "OFF", "API", "GET", "POST", "JSON", "ADO"):
                continue
            if any(mark in line for mark in (*_RESULT_MARKS, "▲", "◌")) and word not in STATUS_WORDS and word not in ALLOWED_PHRASES:
                findings.append(Finding(i, "warn", "status_word", f"'{word}' is not a fixed status word ({', '.join(sorted(STATUS_WORDS))})"))

        # jargon ------------------------------------------------------------
        for term in BANNED_JARGON:
            if term in low:
                findings.append(Finding(i, "warn", "jargon", f"internal jargon '{term}' on a user-facing line — say it plainly"))

        # citation on result lines -----------------------------------------
        if any(line.lstrip().startswith(mark) for mark in _RESULT_MARKS) and "(" not in line:
            findings.append(Finding(i, "warn", "no_citation", "a result line should trail its source, e.g. (run #1402)"))

    return findings


def errors(findings: list[Finding]) -> list[Finding]:
    return [f for f in findings if f.severity == "error"]


def format_findings(findings: list[Finding]) -> str:
    if not findings:
        return "clean — no presentation violations"
    return "\n".join(f"  line {f.line}  [{f.severity}] {f.rule}: {f.detail}" for f in findings)


def _main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Lint a drafted beat block for presentation violations")
    ap.add_argument("--file", help="read the draft from a file (default: stdin)")
    ap.add_argument("--strict", action="store_true", help="exit 1 on warnings too, not just errors")
    args = ap.parse_args()

    if args.file:
        with open(args.file, encoding="utf-8") as fh:
            text = fh.read()
    else:
        text = sys.stdin.read()
    findings = lint(text)
    print(format_findings(findings))
    bad = findings if args.strict else errors(findings)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(_main())
