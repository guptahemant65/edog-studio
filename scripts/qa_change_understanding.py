"""Beat 2 orchestrator — turn a raw change into a grounded understanding.

Ties together the deterministic pieces the skill leans on so Beat 2 stops
guessing:

  * qa_pr_diff       — what changed (files, symbols, flags added/removed)
  * ChangeScanner    — gates (flags) + the SIGNAL FOOTPRINT (the 11 streams)
  * qa_flag_gates    — each gating flag's REAL EDOG state (FM `test` env)
  * PreciseEngine    — what REACHES the changed code (callers -> entry points)

It assembles a structured "change understanding" + a Beat-5 WATCH-CHECKLIST
(the signals to confirm at run time). Honest by construction: the static
footprint is the EXPECTED evidence; the live run (Beat 5) is the judge, and an
expected-but-absent signal is a finding, never a silent pass.

Pure assembly functions are unit-tested; the DLL runners are thin I/O.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

try:
    import qa_flag_gates
except ModuleNotFoundError:  # pragma: no cover - import-context shim
    from scripts import qa_flag_gates

PROJECT_DIR = Path(__file__).parent.parent
_CODEGRAPH = PROJECT_DIR / "scripts" / "qa_codegraph"
_SCANNER_DLL = _CODEGRAPH / "ChangeScanner" / "bin" / "Release" / "net9.0" / "ChangeScanner.dll"
_PRECISE_DLL = _CODEGRAPH / "PreciseEngine" / "bin" / "Release" / "net9.0" / "PreciseEngine.dll"
_VOCAB = _CODEGRAPH / "signal_vocabulary.json"


# ── thin runners (I/O) ──────────────────────────────────────────────────────

def run_scanner(files: list[str], symbols: list[str], *, dll: Path = _SCANNER_DLL, vocab: Path = _VOCAB) -> dict:
    """Run the fast Roslyn scanner: gates + signal footprint. Degrades honestly."""
    if not dll.exists() or not files:
        return {"available": dll.exists(), "filesScanned": 0, "sites": [], "signals": []}
    cmd = ["dotnet", str(dll), "--files", ";".join(files), "--symbols", ",".join(symbols)]
    if vocab.exists():
        cmd += ["--vocab", str(vocab)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
        data = json.loads(proc.stdout)
        data["available"] = True
        return data
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        return {"available": False, "reason": str(exc)[:200], "filesScanned": 0, "sites": [], "signals": []}


def run_precise(project: str, symbol: str, *, dll: Path = _PRECISE_DLL, max_refs: int = 40) -> dict:
    """Ask the precise engine what reaches `symbol`. Lazy/optional; honest on miss."""
    if not dll.exists() or not project:
        return {"ok": False, "reason": "precise engine not built or no project", "results": []}
    try:
        proc = subprocess.run(
            ["dotnet", str(dll), "--project", project, "--symbol", symbol, "--max", str(max_refs)],
            capture_output=True, text=True, timeout=300, check=False,
        )
        return json.loads(proc.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        return {"ok": False, "reason": str(exc)[:200], "results": []}


# ── pure assembly ───────────────────────────────────────────────────────────

def gate_picture(scanner_out: dict, parsed_diff: dict, *, fm_cache: Path | None = None) -> list[dict]:
    """Resolve each gating flag's REAL EDOG state (reuses qa_flag_gates)."""
    kwargs = {"fm_cache": fm_cache} if fm_cache is not None else {}
    gates = qa_flag_gates.gating_flags(scanner_out)
    new = set(qa_flag_gates.new_flags_in_diff(parsed_diff))
    out = []
    for flag in sorted(set(gates) | new):
        st = qa_flag_gates.edog_state(flag, **kwargs)
        out.append({
            "flag": flag,
            "gatesChangedCode": flag in gates,
            "sites": gates.get(flag, []),
            "newInPr": flag in new,
            "edogState": st["state"],
            "note": st.get("note", ""),
        })
    return out


def watch_checklist(scanner_out: dict) -> list[dict]:
    """Turn the signal footprint into Beat 5's watch-list: each stream + where to
    confirm it + a couple of evidence anchors. This is what Beat 5 must observe;
    an expected-but-absent signal becomes a finding."""
    out = []
    for sig in scanner_out.get("signals", []):
        anchors = []
        for h in sig.get("hits", [])[:3]:
            label = h.get("message") or h.get("evidence")
            anchors.append(f"{label} ({h['file']}:{h['line']})")
        out.append({"stream": sig["stream"], "watch": sig.get("watch", ""), "anchors": anchors})
    return out


def entry_points(precise_results: list[dict]) -> list[dict]:
    """Per changed symbol, the methods that reach it (the door to trigger it)."""
    out = []
    for r in precise_results:
        out.append({
            "symbol": r.get("symbol", ""),
            "reachedBy": r.get("callers", []),
            "referenceCount": r.get("referenceCount", 0),
        })
    return out


def assemble(parsed_diff: dict, scanner_out: dict, precise_results: list[dict], *,
             fm_cache: Path | None = None) -> dict:
    """The full Beat-2 change understanding."""
    gates = gate_picture(scanner_out, parsed_diff, fm_cache=fm_cache)
    checklist = watch_checklist(scanner_out)
    entries = entry_points(precise_results)
    notes = [
        "The signal list is the EXPECTED footprint from reading the code — the Beat 5 run is the "
        "judge of what actually fires; an expected-but-absent signal is a finding, not a pass.",
        "Gates shown are the feature-flag guards found statically; other conditions "
        "(manifest/config/internal checks) may also gate the code and are confirmed by the run.",
    ]
    return {
        "change": {
            "files": [f["path"] for f in parsed_diff.get("files", [])],
            "symbols": [s["name"] for s in parsed_diff.get("symbols", [])],
            "flagsAdded": parsed_diff.get("feature_flags_added", []),
            "flagsRemoved": parsed_diff.get("feature_flags_removed", []),
        },
        "gates": gates,
        "watchChecklist": checklist,
        "entryPoints": entries,
        "scannerAvailable": scanner_out.get("available", False),
        "honestNotes": notes,
    }


# ── plain-language render (reuses qa_render where possible) ──────────────────

def render_plain(cu: dict) -> str:
    """A plain-language Beat 2 summary for the terminal."""
    L = []
    L.append("\u25c6 What changed, and what it touches")
    ch = cu["change"]
    L.append(f"  Files ({len(ch['files'])}) \u00b7 symbols: {', '.join(ch['symbols'][:6]) or '(none)'}")
    if ch["flagsAdded"]:
        L.append(f"  New flags: {', '.join(ch['flagsAdded'])}")

    if cu["gates"]:
        L.append("  Turned on by")
        for g in cu["gates"]:
            state = {"on": "ON", "off": "OFF", "empty": "off", "partial": "depends on workspace", "unknown": "unknown"}.get(g["edogState"], g["edogState"])
            tail = f"  \u2014 {g['note']}" if g["note"] else ""
            L.append(f"    \u00b7 {g['flag']}: {state} for EDOG{tail}")

    if cu["entryPoints"]:
        L.append("  Reached through (how to trigger it)")
        for e in cu["entryPoints"]:
            if e["reachedBy"]:
                L.append(f"    \u00b7 {e['symbol'].split('.')[-1]} \u2190 {', '.join(e['reachedBy'][:5])}")

    if cu["watchChecklist"]:
        L.append("  Watch these when it runs (Beat 5 checklist)")
        for w in cu["watchChecklist"]:
            L.append(f"    \u00b7 {w['stream']:<13} {w['watch']}")
    L.append("  \u25c7 expected from reading the code; the live run is the judge \u2014 a missing one is a finding.")
    return "\n".join(L)


# ── CLI ─────────────────────────────────────────────────────────────────────

def _main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Beat 2: grounded change understanding")
    ap.add_argument("--diff-file", help="path to a unified diff (else read --files/--symbols directly)")
    ap.add_argument("--files", default="", help="semicolon-separated changed .cs files (already on disk)")
    ap.add_argument("--symbols", default="", help="comma-separated changed symbols")
    ap.add_argument("--added-flags", default="", help="comma-separated flags newly added in the PR")
    ap.add_argument("--project", default="", help="csproj for the precise engine (optional)")
    ap.add_argument("--entry-symbols", default="", help="comma-separated symbols to trace 'what reaches it'")
    ap.add_argument("--json", action="store_true", help="emit the structured understanding as JSON")
    args = ap.parse_args()

    try:
        import qa_pr_diff
    except ModuleNotFoundError:
        from scripts import qa_pr_diff

    files = [f for f in args.files.split(";") if f]
    symbols = [s for s in args.symbols.split(",") if s]
    added = [f for f in args.added_flags.split(",") if f]

    if args.diff_file:
        parsed = qa_pr_diff.parse_diff(Path(args.diff_file).read_text(encoding="utf-8"))
    else:
        parsed = {"files": [{"path": f} for f in files],
                  "symbols": [{"name": s} for s in symbols],
                  "feature_flags_added": added, "feature_flags_removed": []}

    try:
        import qa_codegraph_build
    except ModuleNotFoundError:
        from scripts import qa_codegraph_build
    qa_codegraph_build.ensure_built("ChangeScanner")
    if args.project and args.entry_symbols:
        qa_codegraph_build.ensure_built("PreciseEngine")

    scanner_out = run_scanner(files, symbols)
    precise_results = []
    if args.project and args.entry_symbols:
        for sym in [s for s in args.entry_symbols.split(",") if s]:
            r = run_precise(args.project, sym)
            precise_results.extend(r.get("results", []))
    cu = assemble(parsed, scanner_out, precise_results)
    if args.json:
        print(json.dumps(cu, indent=2, ensure_ascii=False))
    else:
        print(render_plain(cu))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
