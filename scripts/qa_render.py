"""Deterministic TUI renderer for the FLT PR Scenario Validator.

The skill's UI *is* its terminal output. `reference/presentation.md` is the prose
contract and `docs/design/mocks/flt-pr-scenario-validator-tui-v3.html` is the
visual design — but nothing converted run state into the exact terminal text, so
whether the designed TUI appeared depended on the agent hand-typing it. Under
tool-call pressure that failed (raw JSON leaked into the transcript instead).

This module closes that gap: each beat's output is a pure function of structured
state, emitting the contract's exact blocks (Unicode marks only, never emoji, no
color — the medium is plain Markdown in a chat transcript, so state is carried by
**symbol + word + layout**). The skill calls these and prints the result verbatim,
so the TUI is guaranteed and identical regardless of which model runs it.

Symbols (presentation.md §2): ◆ headline · ▸ doing/asking · ✓ good · ✕ broken ·
▲ needs attention · ◇ side note · ▣ locked · ◌ never ran · ▹ queued · · separator.
"""

from __future__ import annotations

# Status → (mark, word). The honesty contract (§5/§6): a test-setup problem is
# never a pass/fail; a broken case is never a check mark; "never ran" is hollow.
_STATUS = {
    "pass": ("\u2713", "PASS"),
    "broken": ("\u2717", "BROKEN"),
    "suspected": ("\u25b2", "SUSPECTED"),
    "cant": ("\u25b2", "COULDN'T CHECK"),
    "never": ("\u25cc", "NEVER RAN"),
}
_LABEL_W = 13  # width of the "<mark> <WORD>" column, so descriptions align

I1 = "  "  # one indent level (two spaces, per the contract)
I2 = "    "
I3 = "      "
_DOT = "\u00b7"
_MID = " \u00b7 "  # named so it never sits as a backslash escape inside an f-string {expr}


def _cite(text: str, cite: str | None) -> str:
    return f"{text}  ({cite})" if cite else text


def headline(step: int, total: int, title: str) -> str:
    """`◆ Step 2 of 7 · Understand the change` — opens every beat."""
    return f"\u25c6 Step {step} of {total} \u00b7 {title}"


def action(text: str) -> str:
    """`▸ Reading the diff…` — an action underway."""
    return f"\u25b8 {text}"


def gate(question: str, options: str) -> str:
    """`▸ Run this plan?   edit · y to start` — a decision; always name the choices."""
    return f"\u25b8 {question}   {options}"


def fact(text: str, *, mark: str = "pass", cite: str | None = None, indent: str = I1) -> str:
    """A single result/fact line: `  ✓ text  (cite)`."""
    glyph = _STATUS.get(mark, (mark, ""))[0]
    return f"{indent}{glyph} {_cite(text, cite)}"


def status_row(status: str, desc: str, *, cite: str | None = None) -> str:
    """A verdict/result row: `  ✓ PASS        desc  (cite)`.

    The status label column is fixed-width so descriptions line up; the mark and
    word always pair (never color-only).
    """
    glyph, word = _STATUS[status]
    label = f"{glyph} {word}".ljust(_LABEL_W)
    return f"{I1}{label} {_cite(desc, cite)}"


def tool_checks_line(tool: str, checks: list[str]) -> str:
    """The dim `tool: … · checks: …` line under a case (presentation.md §3)."""
    return f"{I3}tool: {tool} {_DOT} checks: {_MID.join(checks)}"


def _case_lines(case: dict, *, planned: bool) -> list[str]:
    out: list[str] = []
    if planned:
        out.append(f"{I1}{case['title']}")
    else:
        out.append(status_row(case["status"], case["title"], cite=case.get("cite")))
    out.append(tool_checks_line(case["tool"], case.get("checks", [])))
    if case.get("note"):
        out.append(f"{I3}{case['note']}")
    for d in case.get("detail", []):
        out.append(f"{I3}{d['label']}:  {_cite(d['text'], d.get('cite'))}")
    if case.get("evidence_ref"):
        out.append(f"{I3}\u25b8 show raw output  \u00b7  {case['evidence_ref']}")
    return out


def _category_blocks(categories: list[dict], *, planned: bool) -> list[str]:
    lines: list[str] = []
    for cat in categories:
        n = len(cat["cases"])
        suffix = f"  \u00b7 {cat['suffix']}" if cat.get("suffix") else ""
        lines.append(f"{cat['name']} ({n}){suffix}")
        for case in cat["cases"]:
            lines.extend(_case_lines(case, planned=planned))
    return lines


def plan(categories: list[dict]) -> str:
    """The editable test plan (Beat 3): category groups, each case with tool+checks.

    The caller appends the `▸ Run this plan?` gate.
    """
    return "\n".join(_category_blocks(categories, planned=True))


def results(categories: list[dict]) -> str:
    """The per-case results (Beat 5/7): each case its status row + tool+checks echo."""
    return "\n".join(_category_blocks(categories, planned=False))


def change_summary(s: dict) -> str:
    """The `◆ What changed in this PR` box (Beat 2): flags, files, behaviour, API change."""
    lines = ["\u25c6 What changed in this PR"]
    flags = s.get("flags", {})
    if any(flags.get(k) for k in ("added", "removed", "used")):
        lines.append(f"{I1}Feature flags")
        for f in flags.get("added", []):
            lines.append(f"{I2}+  New      {f['name']} \u2014 {f.get('note', '')}".rstrip(" \u2014"))
        for f in flags.get("removed", []):
            lines.append(f"{I2}\u2212  Removed  {f['name']} \u2014 {f.get('note', '')}".rstrip(" \u2014"))
        for f in flags.get("used", []):
            lines.append(f"{I2}\u00b7  Uses     {f['name']} \u2014 {f.get('note', '')}".rstrip(" \u2014"))
    files = s.get("files", [])
    if files:
        lines.append(f"{I1}Files ({len(files)})")
        pw = max(len(f["path"]) for f in files)
        churns = {id(f): f"+{f['added']} / \u2212{f['removed']}" for f in files}
        cw = max(len(c) for c in churns.values())
        for f in files:
            lines.append(f"{I2}{f['path']:<{pw}}   {churns[id(f)]:<{cw}}   {f.get('note', '')}".rstrip())
    does = s.get("does", [])
    if does:
        lines.append(f"{I1}What the code does now")
        for d in does:
            lines.append(f"{I2}\u00b7 {_cite(d['text'], d.get('cite'))}")
    api = s.get("api_change")
    if api:
        if api["kind"] == "breaking":
            lines.append(f"{I1}API change        \u25b2 breaking \u2014 {api['text']}")
        else:
            lines.append(f"{I1}API change        safe \u2014 {api['text']}")
    if s.get("security"):
        lines.append(f"{I1}Who's allowed in  \u25b2 NEEDS A HUMAN \u2014 {s['security']}")
    elif api:
        lines.append(f"{I1}Who's allowed in  no change \u2014 safe")
    for oor in s.get("out_of_reach", []):
        lines.append(f"{I1}Out of reach      {oor}   \u25b2")
    return "\n".join(lines)


def locked_target(workspace: str, lakehouse: str, capacity: str) -> str:
    """The `▣ Test target locked` box (Beat 4) — GUIDs only, never display names."""
    return "\n".join([
        "\u25a3 Test target locked",
        f"{I1}Workspace  {workspace}",
        f"{I1}Storage    {lakehouse}",
        f"{I1}Capacity   {capacity}",
        f"{I1}I can only touch this one target, and I only delete what I create.",
    ])


def menu(rows: list[dict]) -> str:
    """A selectable target menu (Beat 4): `key  name   meta`."""
    out = []
    for row in rows:
        risk = "   \u25b2" if row.get("risk") in ("has_data", "prod_like") else ""
        out.append(f"{I1}{row['key']}  {row['name']:<24} {row.get('meta', '')}{risk}".rstrip())
    return "\n".join(out)


def verdict(*, meta: dict, categories: list[dict], reviewer: dict, confidence: str) -> str:
    """The full results block (Beat 7): reviewer read, per-case results, totals."""
    cases = [c for cat in categories for c in cat["cases"]]
    total = len(cases)
    n = {k: sum(1 for c in cases if c["status"] == k) for k in _STATUS}
    parts = [f"{n['pass']} passed"]
    if n["broken"]:
        parts.append(f"{n['broken']} broken")
    if n["suspected"]:
        parts.append(f"{n['suspected']} suspected")
    if n["cant"]:
        parts.append(f"{n['cant']} couldn't check")
    if n["never"]:
        parts.append(f"{n['never']} never ran")

    lines = [
        f"\u25c6 Validation results \u2014 PR {meta['pr']} \"{meta['title']}\"",
        f"{I1}checked commit {meta['commit']} \u00b7 run {meta['run']} \u00b7 took {meta['took']}",
        "",
        f"{I1}What this means for the reviewer",
        f"{I2}Watch         {reviewer.get('watch', '')}",
        f"{I2}Looks safe    {reviewer.get('looks_safe', '')}",
        f"{I2}Your call     {reviewer.get('your_call', '')}",
        "",
        results(categories),
        "",
        f"{I1}What I tested  {total} cases {_DOT} {_MID.join(parts)}",
        f"{I1}How sure       {confidence}",
    ]
    return "\n".join(lines)
