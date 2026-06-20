# FLT PR Scenario Validator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Copilot CLI skill that validates an FLT pull request end-to-end against a live EDOG environment — resolving the PR, understanding the change, picking a locked target, deploying, running grounded scenarios, citing every claim to a verified trace event, posting to the PR, and cleaning up after itself.

**Architecture:** Brain/body split. The **skill** (Opus 4.8, `skills/flt-pr-scenario-validator/`) is the brain — it reads code, derives scenarios, drives EDOG over HTTP, correlates signals, narrates the verdict. **EDOG** is the body — deploy, stimulus, observation, plus a set of new **Python support primitives** (`scripts/qa_*.py`) that make the dangerous parts safe and deterministic (locked target, teardown ledger, single-validation lock, invariant checks, evidence verification). The skill never policies itself — every guardrail is enforced at the tool boundary in Python.

**Tech Stack:** Python 3.12 (stdlib + `urllib3` already vendored) for EDOG primitives and the dev-server; pytest for tests; Markdown for the skill definition; vanilla JS/SVG for the Phase 3 HTML report. No new heavy dependencies.

**Source spec:** `docs/superpowers/specs/2026-06-20-flt-pr-scenario-validator-design.md`

---

## File Structure

### New Python primitives (`scripts/`) — TDD'd
| File | Responsibility |
|------|----------------|
| `scripts/qa_pr_diff.py` | Fetch + parse a PR's clean diff from the ADO REST API; extract changed files, hunks, and changed symbols. |
| `scripts/qa_head_match.py` | Verify the deployed FLT commit equals the PR commit, ignoring EDOG's known injection set. |
| `scripts/qa_run_lock.py` | Global single-validation lock (file-based, PID-stamped, survives skill death). |
| `scripts/qa_teardown_ledger.py` | Append-before-act ledger of mutating actions; reverse-replay for cleanup. |
| `scripts/qa_targets.py` | Enriched workspace/lakehouse/capacity listing + locked-target record. |
| `scripts/qa_invariants.py` | Deterministic invariant checks over a response/log/trace snapshot. |
| `scripts/qa_verdict.py` | Verdict + cited-claim data model; evidence verification pass; JSON serialization. |
| `scripts/qa_trace_bundle.py` | (Phase 3) Assemble the unified, unsampled, stable-ID trace bundle. |
| `scripts/qa_watchdog.py` | (Phase 4) Independent dead-man's-switch that reverses the ledger on budget/silence. |

### Modified EDOG files
| File | Change |
|------|--------|
| `edog.py` | Add `qa` subcommand group with `--cleanup` (Phase 1) and the watchdog hook (Phase 4). |
| `scripts/dev-server.py` | Add `GET /api/qa/trace-bundle` (Phase 3); wire run-lock + ledger status endpoints (Phase 1). |

### The skill (`skills/flt-pr-scenario-validator/`)
| File | Responsibility |
|------|----------------|
| `skills/flt-pr-scenario-validator/SKILL.md` | The agent instructions: persona, journey, guardrails, grounding protocol, tool usage. |
| `skills/flt-pr-scenario-validator/reference/flt-model.md` | Always-loaded FLT mental model (DAG, iteration ID, MWC token, capacity routing, 11 interceptors, deploy lifecycle). |
| `skills/flt-pr-scenario-validator/reference/tools.md` | The EDOG HTTP tool surface (every endpoint the skill calls, with examples). |
| `skills/flt-pr-scenario-validator/reference/scenarios.md` | Scenario taxonomy + plain-language patterns per change type. |
| `skills/flt-pr-scenario-validator/install.py` | Symlink the repo skill into user-global `~/.copilot/skills/`. |

### Tests (`tests/`)
One `tests/test_qa_<module>.py` per primitive, mirroring the module names above.

---

# PHASE 1 — MVP

> Ships the working core: resolve a PR → understand the change → lock a target → deploy → run happy/edge/perf scenarios → evidence-cited verdict → PR post → cleanup. No chaos, no auto-investigation, no HTML report yet.

## Task 1: Single-validation lock

**Files:**
- Create: `scripts/qa_run_lock.py`
- Test: `tests/test_qa_run_lock.py`

The FLT environment is a singleton (one instance on :5557). Two concurrent validations would deploy competing branches and clash. This lock is **heartbeat-based** (not PID-based) because the skill orchestrates across turns and is not one persistent process: the holder refreshes a heartbeat each turn; a lock whose heartbeat is older than `stale_after` seconds is reclaimable.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_run_lock.py
import time
from pathlib import Path
import pytest
from scripts import qa_run_lock


@pytest.fixture
def lock_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(qa_run_lock, "LOCK_PATH", tmp_path / "run.lock")
    return tmp_path


def test_acquire_when_free_returns_ok(lock_dir):
    ok, holder = qa_run_lock.acquire("run-1", "PR#1")
    assert ok is True
    assert holder["runId"] == "run-1"


def test_acquire_when_held_by_fresh_run_is_refused(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    ok, holder = qa_run_lock.acquire("run-2", "PR#2")
    assert ok is False
    assert holder["runId"] == "run-1"  # reports the current holder


def test_stale_lock_is_reclaimed(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    # force the heartbeat into the past
    qa_run_lock._write({"runId": "run-1", "pr": "PR#1",
                        "startedAt": 0.0, "heartbeat": 0.0})
    ok, holder = qa_run_lock.acquire("run-2", "PR#2", stale_after=60)
    assert ok is True
    assert holder["runId"] == "run-2"


def test_heartbeat_keeps_lock_fresh(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    qa_run_lock.heartbeat("run-1")
    assert qa_run_lock.status()["runId"] == "run-1"


def test_release_frees_the_lock(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    qa_run_lock.release("run-1")
    assert qa_run_lock.status() is None
    ok, _ = qa_run_lock.acquire("run-2", "PR#2")
    assert ok is True


def test_release_by_non_holder_is_ignored(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    qa_run_lock.release("run-2")  # not the holder
    assert qa_run_lock.status()["runId"] == "run-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_qa_run_lock.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'scripts.qa_run_lock'` (or attribute errors).

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/qa_run_lock.py
"""Global single-validation lock for the FLT PR Scenario Validator.

Heartbeat-based: the skill orchestrates across turns and is not a single
persistent process, so liveness is tracked by a heartbeat timestamp the
holder refreshes each turn. A lock whose heartbeat is older than
``stale_after`` seconds is considered abandoned and may be reclaimed.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
LOCK_PATH = PROJECT_DIR / ".edog-qa" / "run.lock"
DEFAULT_STALE_AFTER = 1800  # 30 minutes


def _read() -> dict | None:
    try:
        return json.loads(LOCK_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _write(record: dict) -> None:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCK_PATH.write_text(json.dumps(record))


def status() -> dict | None:
    """Return the current lock holder record, or None if free."""
    return _read()


def acquire(run_id: str, pr: str, *, stale_after: int = DEFAULT_STALE_AFTER) -> tuple[bool, dict]:
    """Try to acquire the validation lock.

    Returns (True, our_record) on success, or (False, current_holder) if a
    non-stale lock is already held by a different run.
    """
    now = time.time()
    held = _read()
    if held and held.get("runId") != run_id:
        age = now - float(held.get("heartbeat", 0.0))
        if age < stale_after:
            return False, held
    record = {"runId": run_id, "pr": pr, "startedAt": now, "heartbeat": now}
    _write(record)
    return True, record


def heartbeat(run_id: str) -> bool:
    """Refresh the heartbeat if we hold the lock. Returns True if refreshed."""
    held = _read()
    if not held or held.get("runId") != run_id:
        return False
    held["heartbeat"] = time.time()
    _write(held)
    return True


def release(run_id: str) -> None:
    """Release the lock, but only if we are the holder."""
    held = _read()
    if held and held.get("runId") == run_id:
        LOCK_PATH.unlink(missing_ok=True)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_qa_run_lock.py -v`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add scripts/qa_run_lock.py tests/test_qa_run_lock.py
git commit -m "feat(qa): heartbeat-based single-validation lock

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Teardown ledger

**Files:**
- Create: `scripts/qa_teardown_ledger.py`
- Test: `tests/test_qa_teardown_ledger.py`

Every mutating action (flag override, chaos rule, created infra, deployed branch) is **appended to the ledger before it executes**, so cleanup can reverse it even if the skill crashed. The ledger is a JSONL file owned by EDOG; each entry records the action, how to reverse it, and whether it's been reversed. `reverse_all` replays unreversed entries in LIFO order, tolerating individual failures.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_teardown_ledger.py
from pathlib import Path
import pytest
from scripts import qa_teardown_ledger as ledger


@pytest.fixture
def run(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "QA_ROOT", tmp_path / ".edog-qa")
    return "run-1"


def test_record_then_pending_lists_entry(run):
    ledger.record(run, "flag_override", {"flag": "FLTFoo"}, reverse={"op": "flag_clear", "flag": "FLTFoo"})
    pending = ledger.pending(run)
    assert len(pending) == 1
    assert pending[0]["action"] == "flag_override"
    assert pending[0]["reversed"] is False


def test_reverse_all_runs_lifo_and_marks_reversed(run):
    calls = []
    ledger.record(run, "a", {}, reverse={"op": "undo_a"})
    ledger.record(run, "b", {}, reverse={"op": "undo_b"})

    def handler(rev):
        calls.append(rev["op"])
        return True

    result = ledger.reverse_all(run, handler)
    assert calls == ["undo_b", "undo_a"]   # LIFO
    assert result["reversed"] == 2 and result["failed"] == 0
    assert ledger.pending(run) == []        # nothing left pending


def test_reverse_tolerates_handler_failure(run):
    ledger.record(run, "a", {}, reverse={"op": "undo_a"})
    ledger.record(run, "b", {}, reverse={"op": "undo_b"})

    def handler(rev):
        return rev["op"] != "undo_b"   # undo_b fails

    result = ledger.reverse_all(run, handler)
    assert result["reversed"] == 1 and result["failed"] == 1
    # the failed one remains pending for a later cleanup retry
    assert [p["reverse"]["op"] for p in ledger.pending(run)] == ["undo_b"]


def test_ledger_survives_reload(run):
    ledger.record(run, "a", {}, reverse={"op": "undo_a"})
    # simulate a fresh process: nothing cached, read from disk
    assert len(ledger.pending(run)) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_qa_teardown_ledger.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

```python
# scripts/qa_teardown_ledger.py
"""Append-before-act teardown ledger.

Every mutating action is appended here *before* it executes, so cleanup can
reverse it even after a crash. JSONL, one entry per line, owned by EDOG and
replayable by ``edog qa --cleanup`` independent of the skill process.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Callable

PROJECT_DIR = Path(__file__).parent.parent
QA_ROOT = PROJECT_DIR / ".edog-qa"


def _ledger_path(run_id: str) -> Path:
    return QA_ROOT / "runs" / run_id / "ledger.jsonl"


def record(run_id: str, action: str, detail: dict, *, reverse: dict) -> str:
    """Append a mutating action and how to reverse it. Returns the entry id."""
    path = _ledger_path(run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "id": uuid.uuid4().hex[:12],
        "ts": time.time(),
        "action": action,
        "detail": detail,
        "reverse": reverse,
        "reversed": False,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")
    return entry["id"]


def _load(run_id: str) -> list[dict]:
    path = _ledger_path(run_id)
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def _rewrite(run_id: str, entries: list[dict]) -> None:
    path = _ledger_path(run_id)
    path.write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")


def pending(run_id: str) -> list[dict]:
    """Return entries not yet successfully reversed, in record order."""
    return [e for e in _load(run_id) if not e["reversed"]]


def reverse_all(run_id: str, handler: Callable[[dict], bool]) -> dict:
    """Reverse all pending entries LIFO. ``handler(reverse_spec) -> bool``.

    Marks each reversed on success; leaves failures pending for retry.
    Returns {"reversed": int, "failed": int}.
    """
    entries = _load(run_id)
    reversed_n = failed_n = 0
    for entry in reversed(entries):  # LIFO
        if entry["reversed"]:
            continue
        ok = False
        try:
            ok = handler(entry["reverse"])
        except Exception:
            ok = False
        if ok:
            entry["reversed"] = True
            reversed_n += 1
        else:
            failed_n += 1
    _rewrite(run_id, entries)
    return {"reversed": reversed_n, "failed": failed_n}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_qa_teardown_ledger.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Mutation-test the LIFO guarantee**

Temporarily change `for entry in reversed(entries)` to `for entry in entries`. Run the test. Expected: `test_reverse_all_runs_lifo_and_marks_reversed` FAILS on the `calls == ["undo_b", "undo_a"]` assertion. Restore `reversed(...)`, confirm green. This proves the test actually guards LIFO ordering.

- [ ] **Step 6: Commit**

```bash
git add scripts/qa_teardown_ledger.py tests/test_qa_teardown_ledger.py
git commit -m "feat(qa): append-before-act teardown ledger with LIFO reversal

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: PR diff fetch + changed-symbol extraction

**Files:** Create `scripts/qa_pr_diff.py`; Test `tests/test_qa_pr_diff.py`

Blast radius comes from the **clean ADO PR diff**, never `git diff` on the deploy-patched tree. The network fetch is injected so the parser is offline-testable.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_pr_diff.py
from scripts import qa_pr_diff

SAMPLE_DIFF = """diff --git a/Service/Retry/RetryPolicy.cs b/Service/Retry/RetryPolicy.cs
--- a/Service/Retry/RetryPolicy.cs
+++ b/Service/Retry/RetryPolicy.cs
@@ -140,6 +140,6 @@ public class ExponentialRetryPolicy
-        const int maxRetries = 5;
+        const int maxRetries = 3;
diff --git a/Service/Token/TokenManager.cs b/Service/Token/TokenManager.cs
--- a/Service/Token/TokenManager.cs
+++ b/Service/Token/TokenManager.cs
@@ -10,3 +10,4 @@ public class TokenManager
+        public void MintEarly() { }
"""

def test_parse_lists_changed_files():
    res = qa_pr_diff.parse_diff(SAMPLE_DIFF)
    assert {f["path"] for f in res["files"]} == {
        "Service/Retry/RetryPolicy.cs", "Service/Token/TokenManager.cs"}

def test_parse_extracts_changed_symbols():
    names = {s["name"] for s in qa_pr_diff.parse_diff(SAMPLE_DIFF)["symbols"]}
    assert "ExponentialRetryPolicy" in names and "MintEarly" in names

def test_parse_extracts_numeric_constant_facts():
    facts = {(f["name"], f["value"]) for f in qa_pr_diff.parse_diff(SAMPLE_DIFF)["config_facts"]}
    assert ("maxRetries", "3") in facts

def test_fetch_uses_injected_client():
    seen = {}
    res = qa_pr_diff.fetch_and_parse("https://dev.azure.com/x/_git/r/pullrequest/982144",
                                     client=lambda u: seen.update(url=u) or SAMPLE_DIFF)
    assert "pullrequest/982144" in seen["url"] and len(res["files"]) == 2
```

- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_qa_pr_diff.py -v` → `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# scripts/qa_pr_diff.py
"""Fetch + parse a PR's clean unified diff (ADO): changed files, symbols,
config-value facts. Blast radius MUST use this, never a patched-tree git diff.
"""
from __future__ import annotations
import re
from typing import Callable

_FILE_RE = re.compile(r"^diff --git a/.+? b/(?P<b>.+)$", re.MULTILINE)
_CLASS_RE = re.compile(r"\b(?:class|interface|record|struct)\s+(?P<name>[A-Z]\w+)")
_METHOD_RE = re.compile(r"\b(?:public|private|internal|protected)\s+[\w<>\[\],\s]+?\s+(?P<name>[A-Z]\w+)\s*\(")
_CONST_RE = re.compile(r"\b(?:const\s+\w+|int|long|double|var)\s+(?P<name>\w+)\s*=\s*(?P<value>\d+)")

def parse_diff(diff_text: str) -> dict:
    files = [{"path": m.group("b")} for m in _FILE_RE.finditer(diff_text)]
    symbols, facts, seen = [], [], set()
    for line in diff_text.splitlines():
        if line.startswith("+") and not line.startswith("++"):
            added = line[1:]
        elif line.startswith("-") and not line.startswith("--"):
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
    return {"files": files, "symbols": symbols, "config_facts": facts}

def fetch_and_parse(pr_url: str, *, client: Callable[[str], str]) -> dict:
    res = parse_diff(client(pr_url))
    res["prUrl"] = pr_url
    return res
```

- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_qa_pr_diff.py -v` → 4 passed.
- [ ] **Step 5: Commit** — `git add scripts/qa_pr_diff.py tests/test_qa_pr_diff.py && git commit -m "feat(qa): clean PR-diff fetch + symbol/config-fact extraction"` (add the Co-authored-by trailer).

---

## Task 4: Invariant checker library

**Files:** Create `scripts/qa_invariants.py`; Test `tests/test_qa_invariants.py`

Deterministic absolute-truth checks, no baseline. Each returns a `Finding` with cited evidence. `report_only` marks observations (e.g. perf with no declared bound) that are surfaced but never counted as failures.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_invariants.py
from scripts import qa_invariants as inv

def test_no_5xx(): 
    assert inv.check_no_5xx({"status": 200, "evidenceId": "evt#1"}).ok
    assert not inv.check_no_5xx({"status": 503, "evidenceId": "evt#9"}).ok

def test_no_secret_in_logs():
    f = inv.check_no_secret_in_logs([{"id": "log#2", "text": "Authorization: Bearer eyJabc.def.ghi"}])
    assert not f.ok and f.evidence == ["log#2"]

def test_dag_terminates():
    assert inv.check_dag_terminates({"state": "Completed", "evidenceId": "e"}).ok
    assert not inv.check_dag_terminates({"state": "Running", "timedOut": True, "evidenceId": "e"}).ok

def test_perf_bound():
    assert inv.check_perf_bound(elapsed=4.2, bound=30, source="x", evidence_id="e").ok
    f = inv.check_perf_bound(elapsed=4.2, bound=None, source=None, evidence_id="e")
    assert f.ok and f.report_only
```

- [ ] **Step 2: Run to verify fail** — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# scripts/qa_invariants.py
"""Deterministic invariants — absolute truths, no baseline. Each cites the
evidence ids it relied on. report_only = surfaced but never a failure."""
from __future__ import annotations
import re
from dataclasses import dataclass, field

_SECRET_RE = re.compile(r"(Bearer\s+[A-Za-z0-9._-]{12,}|MwcToken\s+\S{12,}|eyJ[A-Za-z0-9._-]{20,})")

@dataclass
class Finding:
    name: str; ok: bool; detail: str = ""
    evidence: list[str] = field(default_factory=list); report_only: bool = False

def check_no_5xx(resp: dict) -> Finding:
    s = int(resp.get("status", 0))
    return Finding("no_5xx", not (500 <= s < 600), f"status {s}",
                   [resp["evidenceId"]] if resp.get("evidenceId") else [])

def check_no_secret_in_logs(lines: list[dict]) -> Finding:
    hits = [l["id"] for l in lines if _SECRET_RE.search(l.get("text", ""))]
    return Finding("no_secret_in_logs", not hits, "secret in logs" if hits else "clean", hits)

def check_dag_terminates(dag: dict) -> Finding:
    state, to = dag.get("state", ""), bool(dag.get("timedOut"))
    ok = state in ("Completed", "Failed", "Cancelled") and not to
    return Finding("dag_terminates", ok, f"state {state}", [dag["evidenceId"]] if dag.get("evidenceId") else [])

def check_perf_bound(*, elapsed: float, bound: float | None, source: str | None, evidence_id: str) -> Finding:
    if bound is None:
        return Finding("perf_bound", True, f"{elapsed:.1f}s (no bound — observed only)", [evidence_id], report_only=True)
    return Finding("perf_bound", elapsed <= bound, f"{elapsed:.1f}s vs {bound}s ({source})", [evidence_id])
```

- [ ] **Step 4: Run to verify pass** — 4 passed.
- [ ] **Step 5: Commit** — `feat(qa): deterministic invariant checker library`.

---

## Task 5: Verdict model + evidence verification pass

**Files:** Create `scripts/qa_verdict.py`; Test `tests/test_qa_verdict.py`

The epistemic guardrail in code: facts must cite real bundle event ids; inferences must chain to a kept grounded fact. Everything else is dropped.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_verdict.py
from scripts import qa_verdict as v
BUNDLE = {"evt#1": {}, "evt#2": {}}

def test_grounded_fact_kept():
    out = v.verify([v.Claim("retry 5x", ["evt#2"], "fact")], BUNDLE)
    assert out[0].verified

def test_missing_evidence_dropped():
    assert v.verify([v.Claim("x", ["evt#999"], "fact")], BUNDLE) == []

def test_fact_without_evidence_rejected():
    assert v.verify([v.Claim("x", [], "fact")], BUNDLE) == []

def test_inference_must_chain_to_fact():
    fact = v.Claim("retry 5x", ["evt#2"], "fact")
    good = v.Claim("regression", [], "inference", supports=["retry 5x"])
    orphan = v.Claim("vibes", [], "inference", supports=[])
    texts = {c.text for c in v.verify([fact, good, orphan], BUNDLE)}
    assert "regression" in texts and "vibes" not in texts

def test_json_round_trip():
    out = v.verify([v.Claim("200 OK", ["evt#1"], "fact")], BUNDLE)
    blob = v.Verdict("happy", "pass", out).to_json()
    assert blob["status"] == "pass" and blob["claims"][0]["verified"]
```

- [ ] **Step 2: Run to verify fail** — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# scripts/qa_verdict.py
"""Verdict + cited-claim model with a deterministic verification pass.
Facts must cite real bundle ids; inferences must chain to a kept fact."""
from __future__ import annotations
from dataclasses import dataclass, field

@dataclass
class Claim:
    text: str
    evidence: list[str] = field(default_factory=list)
    kind: str = "fact"
    supports: list[str] = field(default_factory=list)
    verified: bool = False

def verify(claims: list[Claim], bundle: dict) -> list[Claim]:
    kept_facts = []
    for c in claims:
        if c.kind == "fact" and c.evidence and all(e in bundle for e in c.evidence):
            c.verified = True
            kept_facts.append(c)
    fact_texts = {c.text for c in kept_facts}
    kept = list(kept_facts)
    for c in claims:
        if c.kind == "inference" and any(s in fact_texts for s in c.supports):
            c.verified = True
            kept.append(c)
    order = {id(c): i for i, c in enumerate(claims)}
    kept.sort(key=lambda c: order[id(c)])
    return kept

@dataclass
class Verdict:
    scenario: str; status: str
    claims: list[Claim] = field(default_factory=list)
    attribution: str = "change"
    def to_json(self) -> dict:
        return {"scenario": self.scenario, "status": self.status, "attribution": self.attribution,
                "claims": [{"text": c.text, "kind": c.kind, "evidence": c.evidence, "verified": c.verified}
                           for c in self.claims]}
```

- [ ] **Step 4: Run to verify pass** — 5 passed.
- [ ] **Step 5: Mutation-test** — change the fact guard to `if True:`; confirm `test_missing_evidence_dropped` + `test_fact_without_evidence_rejected` FAIL; restore; green. Proves the anti-hallucination wall.
- [ ] **Step 6: Commit** — `feat(qa): verdict model + evidence verification pass`.

---

## Task 6: HEAD-match check + enriched targets

**Files:** Create `scripts/qa_head_match.py`, `scripts/qa_targets.py`; Test `tests/test_qa_head_match.py`, `tests/test_qa_targets.py`

`qa_head_match` confirms the deployed FLT runs the PR commit, ignoring EDOG's injection set (else HEAD always mismatches post-deploy). `qa_targets` builds the enriched, risk-annotated menu and the locked tuple.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_qa_head_match.py
from scripts import qa_head_match as hm
INJ = {"Service/DevMode/EdogLogInterceptor.cs", "Service/Program.cs"}

def test_match_when_only_injected_differ():
    assert hm.compare(pr_commit="a", deployed_commit="a", dirty_files={"Service/Program.cs"}, injected=INJ)["match"]

def test_mismatch_on_commit():
    r = hm.compare(pr_commit="a", deployed_commit="b", dirty_files=set(), injected=INJ)
    assert not r["match"] and r["reason"] == "commit_mismatch"

def test_mismatch_on_unexpected_dirty():
    r = hm.compare(pr_commit="a", deployed_commit="a", dirty_files={"Service/Retry/RetryPolicy.cs"}, injected=INJ)
    assert not r["match"] and r["reason"] == "unexpected_dirty"
```

```python
# tests/test_qa_targets.py
from scripts import qa_targets as t
RAW = {"value": [
    {"id": "ws-a", "displayName": "robust_goodfellow_18", "capacitySku": "F4",
     "lakehouses": [{"id": "lh1", "displayName": "rg_lh", "hasData": False}]},
    {"id": "ws-b", "displayName": "prod-mirror-eastus", "capacitySku": "F64",
     "lakehouses": [{"id": "lh2", "displayName": "pm_lh", "hasData": True}]}]}

def test_risk_flags():
    by = {m["workspace"]: m for m in t.build_menu(RAW)}
    assert by["robust_goodfellow_18"]["risk"] == "safe"
    assert by["prod-mirror-eastus"]["risk"] == "prod_like"

def test_lock_addressability():
    locked = t.lock_target(workspace="ws-a", lakehouse="lh1", capacity="c", created=False)
    assert t.is_addressable(locked, "ws-a", "lh1") and not t.is_addressable(locked, "ws-b", "lh2")
```

- [ ] **Step 2: Run to verify fail** — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# scripts/qa_head_match.py
"""Confirm the deployed FLT runs the PR commit, ignoring EDOG's injection set.
A mismatch is a HARNESS failure, not a verdict on the change."""
from __future__ import annotations

def compare(*, pr_commit: str, deployed_commit: str, dirty_files: set[str], injected: set[str]) -> dict:
    if pr_commit != deployed_commit:
        return {"match": False, "reason": "commit_mismatch"}
    unexpected = {f for f in dirty_files if f not in injected}
    if unexpected:
        return {"match": False, "reason": "unexpected_dirty", "files": sorted(unexpected)}
    return {"match": True, "reason": "ok"}
```

```python
# scripts/qa_targets.py
"""Enriched Fabric target menu + locked-target record. Risk drives posture:
'safe' empty lakehouse = full freedom; 'prod_like'/has-data = gated."""
from __future__ import annotations
_PROD = ("prod", "live", "mirror")

def _risk(name: str, has_data: bool) -> str:
    if any(h in name.lower() for h in _PROD):
        return "prod_like"
    return "has_data" if has_data else "safe"

def build_menu(raw: dict) -> list[dict]:
    out = []
    for ws in raw.get("value", []):
        for lh in ws.get("lakehouses", []):
            out.append({"workspace": ws["displayName"], "workspaceId": ws["id"],
                        "lakehouse": lh["displayName"], "lakehouseId": lh["id"],
                        "sku": ws.get("capacitySku", ""), "hasData": bool(lh.get("hasData")),
                        "risk": _risk(ws["displayName"], bool(lh.get("hasData")))})
    return out

def lock_target(*, workspace: str, lakehouse: str, capacity: str, created: bool) -> dict:
    return {"workspace": workspace, "lakehouse": lakehouse, "capacity": capacity, "created": created}

def is_addressable(locked: dict, workspace: str, lakehouse: str) -> bool:
    return locked["workspace"] == workspace and locked["lakehouse"] == lakehouse
```

- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_qa_head_match.py tests/test_qa_targets.py -v` → 5 passed.
- [ ] **Step 5: Commit** — `feat(qa): HEAD-match check + enriched locked-target menu`.

---

## Task 7: Scenario-aware infra spec (required-vs-available diff)

**Files:** Create `scripts/qa_infra_spec.py`; Test `tests/test_qa_infra_spec.py`

Aggregates each scenario's `infra requirements` into one required spec, then diffs it against what an existing target actually has — producing the "here's what's missing" list that drives Beat 4's recommend-fresh path.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_infra_spec.py
from scripts import qa_infra_spec as spec

SCENARIOS = [
    {"infra": {"lakehouses": 1, "tables": ["orders"], "mlvs": 1}},
    {"infra": {"lakehouses": 1, "tables": ["orders", "customers"], "mlvs": 2}},
]

def test_aggregate_takes_the_max_and_union():
    req = spec.required(SCENARIOS)
    assert req["lakehouses"] == 1
    assert set(req["tables"]) == {"orders", "customers"}
    assert req["mlvs"] == 2

def test_fitness_lists_missing_pieces():
    req = spec.required(SCENARIOS)
    have = {"lakehouses": 1, "tables": ["orders"], "mlvs": 0}
    gap = spec.fitness(req, have)
    assert gap["fits"] is False
    assert "customers" in gap["missing"]["tables"]
    assert gap["missing"]["mlvs"] == 2

def test_fitness_passes_when_satisfied():
    req = spec.required(SCENARIOS)
    have = {"lakehouses": 2, "tables": ["orders", "customers", "extra"], "mlvs": 3}
    assert spec.fitness(req, have)["fits"] is True
```

- [ ] **Step 2: Run to verify fail** — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# scripts/qa_infra_spec.py
"""Derive the required-infra spec from the scenario plan, and diff it against
an existing target's actual infra to produce the 'what's missing' list."""
from __future__ import annotations

def required(scenarios: list[dict]) -> dict:
    lakehouses = mlvs = 0
    tables: set[str] = set()
    for s in scenarios:
        infra = s.get("infra", {})
        lakehouses = max(lakehouses, int(infra.get("lakehouses", 0)))
        mlvs = max(mlvs, int(infra.get("mlvs", 0)))
        tables.update(infra.get("tables", []))
    return {"lakehouses": lakehouses, "tables": sorted(tables), "mlvs": mlvs}

def fitness(req: dict, have: dict) -> dict:
    missing_tables = [t for t in req["tables"] if t not in set(have.get("tables", []))]
    missing_mlvs = max(0, req["mlvs"] - int(have.get("mlvs", 0)))
    missing_lh = max(0, req["lakehouses"] - int(have.get("lakehouses", 0)))
    fits = not missing_tables and missing_mlvs == 0 and missing_lh == 0
    return {"fits": fits, "missing": {"tables": missing_tables, "mlvs": missing_mlvs, "lakehouses": missing_lh}}
```

- [ ] **Step 4: Run to verify pass** — 3 passed.
- [ ] **Step 5: Commit** — `feat(qa): scenario-aware required-infra spec + fitness diff`.

---

## Task 8: `edog --qa-cleanup` standalone reverser

**Files:** Create `scripts/qa_cleanup.py`; Modify `edog.py`; Test `tests/test_qa_cleanup_cli.py`

Reverses a run's ledger even if the skill is gone (the orphaned-capacity guard). Each reverse `op` maps to a concrete EDOG action; unknown ops are failures (left pending), never crashes.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_cleanup_cli.py
from scripts import qa_teardown_ledger as ledger, qa_cleanup

def test_cleanup_reverses_pending(monkeypatch, tmp_path):
    monkeypatch.setattr(ledger, "QA_ROOT", tmp_path / ".edog-qa")
    ledger.record("r1", "flag_override", {"flag": "F"}, reverse={"op": "flag_clear", "flag": "F"})
    done = []
    monkeypatch.setattr(qa_cleanup, "REVERSERS", {"flag_clear": lambda s: done.append(s["flag"]) or True})
    assert qa_cleanup.run("r1")["reversed"] == 1 and done == ["F"]

def test_unknown_op_is_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(ledger, "QA_ROOT", tmp_path / ".edog-qa")
    ledger.record("r1", "x", {}, reverse={"op": "nope"})
    monkeypatch.setattr(qa_cleanup, "REVERSERS", {})
    assert qa_cleanup.run("r1")["failed"] == 1
```

- [ ] **Step 2: Run to verify fail** — `ModuleNotFoundError: scripts.qa_cleanup`.

- [ ] **Step 3: Implement**

```python
# scripts/qa_cleanup.py
"""Reverse a QA run's teardown ledger, independent of the skill process.
Unknown ops count as failures (left pending) rather than crashing."""
from __future__ import annotations
import urllib.request
from scripts import qa_run_lock, qa_teardown_ledger as ledger

def _flag_clear(s: dict) -> bool:
    req = urllib.request.Request(
        f"http://127.0.0.1:5555/api/edog/feature-flags/overrides/{s['flag']}", method="DELETE")
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status < 400

def _capacity_delete(s: dict) -> bool:
    req = urllib.request.Request(
        f"http://127.0.0.1:5555/api/fabric/capacities/{s['capacityId']}", method="DELETE")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status < 400

def _worktree_remove(s: dict) -> bool:
    import subprocess
    return subprocess.run(["git", "worktree", "remove", "--force", s["path"]],
                          capture_output=True).returncode == 0

REVERSERS = {
    "flag_clear": _flag_clear,
    "capacity_delete": _capacity_delete,
    "worktree_remove": _worktree_remove,
    "chaos_remove": lambda s: True,   # wired in Phase 2
    "lock_release": lambda s: True,
}

def run(run_id: str) -> dict:
    def handler(rev: dict) -> bool:
        fn = REVERSERS.get(rev.get("op"))
        return fn(rev) if fn else False
    result = ledger.reverse_all(run_id, handler)
    qa_run_lock.release(run_id)
    return result
```

- [ ] **Step 4: Wire `edog.py`** — add `parser.add_argument("--qa-cleanup", metavar="RUNID", help="Reverse a QA run's teardown ledger")`; in dispatch before the default launch: `if args.qa_cleanup: from scripts import qa_cleanup; r = qa_cleanup.run(args.qa_cleanup); print(f"  Cleanup: reversed {r['reversed']}, failed {r['failed']}"); sys.exit(0 if r['failed']==0 else 1)`.
- [ ] **Step 5: Run + smoke** — `python -m pytest tests/test_qa_cleanup_cli.py -v` → 2 passed; `python edog.py --qa-cleanup nope` → `Cleanup: reversed 0, failed 0`.
- [ ] **Step 6: Commit** — `feat(qa): edog --qa-cleanup standalone ledger reverser`.

---

## Task 9: Skill skeleton + repo→user-global install

**Files:** Create `skills/flt-pr-scenario-validator/SKILL.md`, `skills/flt-pr-scenario-validator/install.py`; Test `tests/test_qa_skill_install.py`

The skill is versioned in the repo and symlinked into user-global so it stays in sync with its dependencies.

- [ ] **Step 1: Write the failing test** (validates the skill file exists and has the required front-matter sections)

```python
# tests/test_qa_skill_install.py
from pathlib import Path
SKILL = Path("skills/flt-pr-scenario-validator/SKILL.md")

def test_skill_file_exists():
    assert SKILL.exists()

def test_skill_declares_required_sections():
    text = SKILL.read_text(encoding="utf-8")
    for heading in ("# FLT PR Scenario Validator", "## The Journey", "## Guardrails",
                    "## Grounding Protocol", "## Tool Surface"):
        assert heading in text, f"missing: {heading}"

def test_reference_docs_exist():
    base = Path("skills/flt-pr-scenario-validator/reference")
    for f in ("flt-model.md", "tools.md", "scenarios.md"):
        assert (base / f).exists(), f"missing reference/{f}"
```

- [ ] **Step 2: Run to verify fail** — assertion error (files don't exist yet).
- [ ] **Step 3: Create `SKILL.md`** with these sections (content authored in Tasks 10–12): `# FLT PR Scenario Validator`, `## When to use`, `## The Journey` (the seven beats, each naming its gate + the tools/primitives it calls), `## Guardrails` (lock, locked-target, ledger, evidence-first — referencing the `qa_*` primitives), `## Grounding Protocol` (every claim cites a trace event; run `qa_verdict.verify`), `## Tool Surface` (pointer to `reference/tools.md`), `## Cross-turn state` (persist to `.edog-qa/runs/{runId}/state.json`; fire-and-poll).
- [ ] **Step 4: Create `install.py`**

```python
# skills/flt-pr-scenario-validator/install.py
"""Symlink this repo skill into user-global ~/.copilot/skills/."""
from pathlib import Path
import os

def main() -> None:
    src = Path(__file__).parent.resolve()
    dst = Path.home() / ".copilot" / "skills" / "flt-pr-scenario-validator"
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    os.symlink(src, dst, target_is_directory=True)
    print(f"  Linked {dst} -> {src}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run to verify pass** — `python -m pytest tests/test_qa_skill_install.py -v` → 3 passed (after Task 10 creates the reference docs; sequence Task 10 before re-running).
- [ ] **Step 6: Commit** — `feat(qa): skill skeleton + user-global install`.

---

## Task 10: Reference docs — FLT model, tools, scenarios

**Files:** Create `skills/flt-pr-scenario-validator/reference/flt-model.md`, `…/tools.md`, `…/scenarios.md`

- [ ] **Step 1:** `flt-model.md` — the always-loaded mental model: DAG / iteration-ID / MWC token / capacity routing / the 11 interceptors / deploy lifecycle / ports (5555 dev-server, 5557 FLT). ≤2 pages.
- [ ] **Step 2:** `tools.md` — the EDOG HTTP tool surface, one row per endpoint the skill calls (from §4 of the spec) with a concrete `curl` example each. **Primary stimulus = `POST /api/playground/dispatch`** (dispatch any catalogued endpoint) + `/api/playground/catalog` + `/api/contract/capabilities`. Plus: config, health, ado-proxy/pr-diff + **pr-comment**, fabric/workspaces+lakehouses+capacities, command/deploy + deploy-stream, flt-proxy/runDAG + getDAGExecStatus, **notebook session trio (also the table/MLV seeding path)**, feature-flags/overrides, logs, telemetry, **`/api/executions`** (DAG history+timing), interceptors-status, **`/api/onelake/table-preview-rows`+`table-metadata` (verify output landed)**, **`/api/playground/swagger/spec` (schema validation)**.
- [ ] **Step 3:** `scenarios.md` — **the generation protocol**: the change-type → scenario-pattern catalog (the table from spec §7), and for each pattern a worked example showing the six scenario fields (`title · category · stimulus · observations · invariants · infra requirements`). Include: (a) the **infra-seeding recipe** — `create-session → execute-cell: CREATE TABLE … → execute-cell: CREATE MATERIALIZED LAKE VIEW silver.<name> AS SELECT … FROM <table> → close-session` (verified path; record each create to the ledger); (b) **output verification** — DAG scenarios must check `/api/onelake/table-preview-rows` that the write landed correctly, not just that the run completed; (c) **stimulus via `/api/playground/dispatch`** as the default.
- [ ] **Step 4: Validate** — `python -m pytest tests/test_qa_skill_install.py -v` → 3 passed.
- [ ] **Step 5: Commit** — `docs(qa): skill reference docs (flt-model, tools, scenarios)`.

---

## Task 11: SKILL.md — journey orchestration & guardrail wiring

**Files:** Modify `skills/flt-pr-scenario-validator/SKILL.md`

Write the operational instructions the agent follows, mapping each beat to its primitives and gates. No code — this is the agent's playbook. Cover, in order: Beat 1 (lock → resolve PR via git/ADO → start server after PR), Beat 2 (clean-diff understanding via `qa_pr_diff` + repo grep), Beat 3 (generate per `scenarios.md`, present editable plan), Beat 4 (derive `qa_infra_spec.required`, user picks existing/new, existing → `qa_infra_spec.fitness` + "what's missing", new → seed tailored infra recording each create to the ledger, `qa_targets.lock_target`), Beat 5 (worktree checkout recorded to ledger → deploy → `qa_head_match` → run happy/edge/perf, observe, `qa_invariants`), Beat 6 (retry-once/flag-flip/correlate; honest "suspected" when unconfirmable), Beat 7 (`qa_verdict` → markdown PR comment → cleanup auto-on-pass / offer-keep-on-fail → `qa_cleanup.run`). Explicitly instruct: heartbeat the lock each turn; persist state each turn; never address a target outside the locked tuple; every claim must cite a trace event and pass `qa_verdict.verify`.

- [ ] **Step 1:** Author the seven-beat orchestration section.
- [ ] **Step 2: Validate structure** — `python -m pytest tests/test_qa_skill_install.py -v` → 3 passed.
- [ ] **Step 3: Commit** — `docs(qa): SKILL.md journey orchestration + guardrail wiring`.

---

## Task 12: End-to-end smoke (manual, gated)

**Files:** none (manual verification script in the plan)

- [ ] **Step 1:** Install the skill: `python skills/flt-pr-scenario-validator/install.py`.
- [ ] **Step 2:** On a branch with a tiny open test PR, invoke the skill and confirm Beat 1: lock acquired (`.edog-qa/run.lock` exists), PR resolved, server started only after PR found.
- [ ] **Step 3:** Confirm Beats 2–4 produce a grounded map, an editable plan, and an infra fitness result without touching any target until locked.
- [ ] **Step 4:** Confirm Beat 5 creates a worktree (`.edog-qa/worktrees/{runId}`), deploys, HEAD-matches, and runs scenarios; Beat 7 posts a markdown PR comment and, on pass, runs cleanup leaving zero orphaned state (`git worktree list` clean, no leftover flag overrides).
- [ ] **Step 5:** Kill the skill mid-run, then run `python edog.py --qa-cleanup {runId}` and confirm the ledger fully reverses (orphan-recovery guard).
- [ ] **Step 6: Commit** any fixes found during smoke.

---

# PHASE 2 — FAILURE INJECTION & AUTO-INVESTIGATION

> Adds the chaos-driven scenarios and the confirm-the-root-cause loop. Upgrades Phase-1 "suspected" verdicts to "confirmed".

- **Task 13:** **Chaos REST shim** — error-sim/chaos is SignalR-only today (no `/api/error-sim` routes); the curl-based skill can't reach it. Add `POST /api/error-sim/rule` + `DELETE /api/error-sim/rule/{id}` in `dev-server.py` that forwards to the existing hub (`ErrorSimAddRule`/`ErrorSimRemoveRule`), TDD the forward. Then wire it into the ledger as a stimulus + `chaos_remove` reverse op.
- **Task 14:** Failure-injection scenario patterns in `scenarios.md` (inject transient 429 → assert backoff ≤ `maxRetries`; inject token-expiry → assert graceful handling).
- **Task 15:** Auto-investigation loop in SKILL.md — on a suspicious signal, design a confirming experiment (inject fault / flip flag), re-run the scenario in isolation, compare, and emit a *confirmed* root cause with cited evidence.
- **Task 16:** Destructive-op gating — `qa_targets` risk + extra confirmation before any write/chaos against a reused has-data lakehouse; TDD the gate.

---

# PHASE 3 — TRACE BUNDLE, VERIFICATION AT SCALE & HTML REPORT

> The unified evidence ledger and the rich causal-board report.

- **Task 17:** `GET /api/qa/trace-bundle?since&correlationId` in `dev-server.py` — unify logs + telemetry + 11 interceptor streams + DAG state into one **unsampled, stable-ID** snapshot. TDD the assembler (`scripts/qa_trace_bundle.py`) against fixture streams.
- **Task 18:** Point `qa_verdict.verify` at the real bundle; add the "absence requires unsampled completeness" downgrade rule (TDD).
- **Task 19:** The causal-board HTML report — adapt the committed `docs/design/mocks/flt-pr-scenario-validator-journey.html` companion report surface; render real run data; link from the PR comment.

---

# PHASE 4 — PROVISIONING POLISH & DEAD-MAN'S-SWITCH

- **Task 20:** `scripts/qa_watchdog.py` — independent process that reverses the ledger on budget-exceeded or heartbeat-silence; TDD the trigger logic with a fake clock.
- **Task 21:** Resource ceilings (max wall-clock, max capacities=0 default, max DAG triggers) enforced at the tool boundary; TDD.
- **Task 22:** Fresh-infra provisioning polish — robust seed-table/MLV creation with retries and full ledger coverage.

---

## Self-Review

**1. Spec coverage.** Every §6 beat maps to a task: Beat 1 → T1/T9/T11; Beat 2 → T3/T11; Beat 3 → T10(scenarios)/T11; Beat 4 → T6/T7/T11; Beat 5 → T6(head-match)/T4(ledger worktree)/T11; Beat 6 → T5(verify)/T11 + Phase 2 T15; Beat 7 → T5/T8/T11. Guardrails (§9): lock T1, ledger T2, cleanup T8, locked-target T6, verification T5. Grounding (§2): T4 invariants, T5 verification, T3 facts.

**2. Placeholder scan.** Phase 1 (T1–T12) carries complete code in every implementation step. Phases 2–4 are deliberately task-level outlines (the design spec is authoritative; their internals depend on Phase-1 reality and will be elaborated when reached) — this is flagged, not hidden.

**3. Type consistency.** `Finding`, `Claim`, `Verdict`, `lock_target/is_addressable`, `record/pending/reverse_all`, `required/fitness`, `compare`, `acquire/heartbeat/release` are referenced consistently across tasks and the SKILL.md wiring (T11).

**4. Ambiguity.** Cross-turn state file (`.edog-qa/runs/{runId}/state.json`) and worktree path (`.edog-qa/worktrees/{runId}`) are named explicitly so T11 and T12 agree.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-20-flt-pr-scenario-validator.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**




