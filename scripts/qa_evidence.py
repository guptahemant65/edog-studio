"""Per-case raw-evidence store: save the full tool output, replay it on demand.

A terminal cannot fold text, so the skill stays quiet by default and saves each
ran case's full output here as the run happens. The citation on a verdict line
(``request #1455``, ``run #1402``) is the lookup key: ``show #1455`` replays that
case's saved block verbatim — the captured bytes, never re-fabricated. A case the
run never reached has no block, and that is said plainly rather than invented.

One JSON record per case at ``.edog-qa/runs/{runId}/evidence/{key}.json`` holding
the printable block plus its kind and one-line summary. See the rendering contract
``reference/presentation.md`` §8.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
QA_ROOT = PROJECT_DIR / ".edog-qa"

#: Shown verbatim when a requested case produced no output (it never ran).
NO_OUTPUT_MSG = "nothing ran here, so there's no output to show"

# Citation labels that prefix an id (``request #1455``) and are dropped so that
# every form of the same citation — "request #1455", "#1455", "1455" — maps to
# the one key the user actually types after ``show``.
_LABELS = ("request", "run", "token", "write", "iteration")


def _evidence_dir(run_id: str) -> Path:
    return QA_ROOT / "runs" / run_id / "evidence"


def normalize_ref(ref: str) -> str:
    """Collapse any form of a citation to its stable filename key.

    ``"request #1455"``, ``"#1455"`` and ``"1455"`` all yield ``"1455"`` so the
    skill can save under the verdict's citation and find it from what the user
    types after ``show``. A named ref (``"contract"``) slugifies to itself.
    """
    s = ref.strip().lower().lstrip("#").strip()
    for label in _LABELS:
        if s.startswith(label) and s[len(label) :][:1] in ("", " ", "#", "-"):
            s = s[len(label) :]
            break
    s = s.strip().lstrip("#").strip()
    slug = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return slug or "evidence"


def path(run_id: str, ref: str) -> Path:
    """Absolute path to a case's evidence record (may not yet exist)."""
    return _evidence_dir(run_id) / f"{normalize_ref(ref)}.json"


def save(run_id: str, ref: str, block: str, *, kind: str, summary: str = "") -> str:
    """Persist a case's printable raw output. Returns the lookup key.

    ``block`` is the captured, tool-shaped output rendered once at capture time
    (so replay never re-derives it). ``kind`` is the tool (``api`` / ``dag`` /
    ``log`` / ``contract`` / ``flag``); ``summary`` is the one-line gist.
    """
    key = normalize_ref(ref)
    p = _evidence_dir(run_id) / f"{key}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ref": ref,
        "key": key,
        "kind": kind,
        "summary": summary,
        "block": block,
        "saved_at": time.time(),
    }
    p.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return key


def load(run_id: str, ref: str) -> dict | None:
    """Return a case's full evidence record, or ``None`` if nothing was saved."""
    p = path(run_id, ref)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def show(run_id: str, ref: str) -> str:
    """Return a case's saved block for printing, or the honest no-output line."""
    record = load(run_id, ref)
    return record["block"] if record else NO_OUTPUT_MSG


def list_refs(run_id: str) -> list[dict]:
    """List saved cases (``ref``/``key``/``kind``/``summary``), oldest first."""
    d = _evidence_dir(run_id)
    if not d.exists():
        return []
    out = []
    for p in d.glob("*.json"):
        rec = json.loads(p.read_text(encoding="utf-8"))
        out.append({k: rec.get(k) for k in ("ref", "key", "kind", "summary", "saved_at")})
    out.sort(key=lambda r: r.get("saved_at") or 0)
    return [{k: r[k] for k in ("ref", "key", "kind", "summary")} for r in out]
