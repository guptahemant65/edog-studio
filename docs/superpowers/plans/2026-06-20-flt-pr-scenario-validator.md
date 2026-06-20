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
| `scripts/qa_contract_diff.py` | Diff two `dotnet swagger tofile`-generated OpenAPI specs (main vs PR) → `{changed, totalChanges, breaking[], changes[]}` with stable `ch-NNN` IDs. NOT the stale committed baseline. |
| `scripts/qa_error_classify.py` | Map a decoded error (`errorSource`/`category`/`httpStatus`) to an attribution tier (`change`/`infra`/`unknown`) from the error catalog. |
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

## Audit findings (folded in — verified against actual code)

Confirmed by reading the real handlers; the tasks below reflect them:
- **Deploy is config-driven** (`dev-server.py:2870`; `edog.py` headless-deploy has no repo arg, no checkout) → the worktree flow REPOINTS `config.flt_repo_path` to the worktree before deploy, restores after (ledger `config_restore`).
- **Fresh-infra seeding** needs a **schema-enabled lakehouse** + a **notebook artifact** first; DDL runs as Python `spark.sql(...)` on the `synapse_pyspark` kernel (`language` ignored); Spark cold-start ≤10min.
- **A SQL-created MLV is runnable via `runDAG`** with no separate `MLVExecutionDefinition` (FLT-owner verified); the skill generates a fresh GUID `iterationId`.
- **`/api/logs`,`/telemetry`,`/executions` are FLT-log-server proxies** — query interface is FLT-defined; discover at runtime, don't assume `?since=&level=`.
- **`/api/onelake/table-preview-rows` reads live Delta parquet** — verify a DAG wrote the right rows.
- **`/api/ado-proxy/pr-comment`** creates a real ADO thread (`{prUrl, markdown}`); **`pr-diff`** returns `sourceCommit` for HEAD-match.
- **Deploy injection set** (HEAD-match known set) = `edog.py` FILES + DevMode/*.
- **Chaos is SignalR-only** → Phase 2 adds a `POST /api/error-sim/rule` REST shim (Task 13).

**Second-pass audit (repo-wide mining — folded into Tasks 11a, 11b, 3, 6, 10, 11):**
- **Swagger contract-diff is a deterministic grounding source — but diff main vs PR via `dotnet swagger tofile`, NOT vs the committed baseline.** The committed `Swagger/Swagger.json` is updated infrequently and drifts, so `/api/playground/swagger/diff` (runtime-vs-committed) is misleading. Instead generate the swagger from the PR branch and from its merge-base (main) with **`dotnet swagger tofile` on each built assembly** (same generator both sides → apples-to-apples; main needs only a build, not a deploy) and diff the two → `{changed, totalChanges, breaking[], changes[]}` with stable `ch-NNN` IDs; removed/modified endpoints = breaking. New primitive `qa_contract_diff` (Task 7a, two-spec differ). Requires the `Swashbuckle.AspNetCore.Cli` tool available.
- **Flag-gating is a correctness gate — and flag STATE lives in the FM repo, not `FeatureNames.cs`.** A change behind `FeatureNames.<X>` is dormant until the flag is in the right state; the wrong state yields a **false PASS**. `FeatureNames.cs` holds only the C# const + its wire-key literal; actual state is in the **FM repo** (FMv2, EDOG sparse-clones to `~/.edog-cache/feature-management/`, `Features/**/*.json`, the `Id` field = real wire key, per-env `Enabled`/`Targets` pivot-evaluated). Four-step protocol: **(1)** `qa_pr_diff` (Task 3) surfaces `FeatureNames.` refs (const name); **(2)** resolve const → **wire key → FM `Id`** (override the wire key/Id, NOT the const name — they can differ → silent no-op → false PASS); **(3)** read effective state via `GET /api/edog/feature-flags/catalog` (`effectiveForMyWorkspace/locked/isOverridden`, resolved from the FM clone against test env + locked GUIDs); **(4)** `set_override(wireKey, bool)` (force-ON *or* force-OFF) via `POST /api/edog/feature-flags/overrides(/bulk)` (`X-EDOG-Control-Token`, success = `applied` hash+revision echo), then **re-read the catalog to confirm `effectiveForMyWorkspace` changed**. `locked`/`missing` flags can't be forced → harness limitation, not a verdict. SKILL.md (Task 11) runs the right direction (ON/OFF) per scenario.
- **Failure attribution is catalog-grounded, not guessed.** `error-sim-catalog.js` (115 codes: `errorSource` User/System · `category` · `httpStatus` · `fltCodePath`) + `error-decoder.js` → classify failure as change-attributable vs infra mechanically. New primitive `qa_error_classify` (Task 11b); feeds `qa_verdict.attribution` (Task 5) + the harness-vs-test split.
- **Token-expiry mid-run is handled, not feared.** Bearer (~1h, 5-min buffer) auto-refreshes iff a username/session is saved; MWC has a 15-min buffer. The skill checks `GET /api/edog/health → bearerExpiresIn` before long ops; 401/403 → re-auth; 404 → `capacity_routing_not_ready` (retryable). SKILL.md (Task 11) Beat-5 instruction.
- **Pin GUIDs, never names.** Name-based resolution can silently target the WRONG lakehouse (logs "backward compatibility mode"); the locked tuple is `(workspaceId, lakehouseId, capacityId)` GUIDs and the boundary check compares GUIDs (`qa_targets`, Task 6).
- **Config-repoint must not nuke tokens.** Saving config via `--config` deletes `.edog-token-cache`; the worktree repoint **edits `edog-config.json` directly** (ledger `config_restore`, Task 2) and preserves `.edog-session.json`/`.edog-*-cache`/the worktree's own `workload-dev-mode.json` (whose `CapacityGuid` must match the locked target).
- **Evidence-access reality (constrains Phase-1 grounding).** Real stable IDs exist today (`TopicEvent.SequenceId` per topic + payload `IterationId/CorrelationId/dagId/nodeId`), but the rich topic-event stream is **SignalR-primary**; REST gives `/api/logs`, `/telemetry`, `/stats`, `/executions`, `/interceptors-status`. So **Phase 1 grounds on logs/telemetry/onelake/http/swagger-diff/error-codes**; topic-event citation (`retry:#…`, `dag:#…`) is the **Phase-3 trace-bundle's** job (Task 17). Interceptors do **not** capture method return values — ground on captured fields only.

**Third-pass refinements (user review of the seven-beat journey — folded into Beat 1/3/5/6, Tasks 9, 7, 10, 11, 7a):**
- **Headless server start (Beat 1).** Default `python edog.py` opens the EDOG Studio webpage (`edog.py:5219 webbrowser.open`); the skill must NOT. Start the server headless — launch `scripts/dev-server.py` directly (it has no browser-open) or add an `edog --no-browser` flag (Task 9). API-only on :5555.
- **Scenarios carry preconditions + can be composite (Beat 3).** Beyond infra counts, a scenario declares **preconditions** — required **flag state** and **table/MLV properties** (set at seed time) — and may have **sub-scenarios** sharing infra plus a **complex multi-node DAG shape**. Grounded example (verified against FLT): the `CDFDisabled`-warning scenario needs **all three** — `FLTMLVWarnings`=ON, `FLTIRDeltaPhysicalCDFEnabled`=OFF, source table seeded with `delta.enableChangeDataFeed=false` — then the MLV falls back to full refresh and emits `NodeWarning{CDFDisabled}`, observed on `node.warnings` (NOT the output rows). `qa_infra_spec` (Task 7) must carry table properties + DAG shape; `scenarios.md` (Task 10) documents the eight-field model.
- **FLT-native structured outputs are first-class oracles (Beat 5).** A generic "did rows land" check is blind to FLT semantics — a CDF change leaves the output rows identical; the only signal is `node.warnings`. So observe + cite **`node.warnings` (`NodeWarning`), `refresh_policy`, `NodeExecutionMetrics` (added/dropped row counts, status, error_code/source), and the `sys_node_metrics`/`sys_run_metrics` insights tables** — alongside logs/onelake rows. (`Node.cs:207` exposes `warnings` on the DAG/node status; also in `node_exec_metrics.json`.)
- **Assert the API response body (Beat 5).** The stimulus call's response is first-class evidence — assert + cite the response body/output, not just status/logs (`scenarios.md` Task 10, SKILL.md Task 11).
- **Contract-diff is main-vs-PR, not vs committed baseline (Beat 5).** See the swagger bullet above; `qa_contract_diff` is a **two-spec differ** (Task 7a).
- **Fault injection → Phase N (timing TBD), not Phase 2.** All chaos/failure-injection work is deferred to an undetermined later phase (relabel Phase 2 header + Beat 6 honesty text).

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

def test_parse_surfaces_feature_flag_refs():
    diff = SAMPLE_DIFF + (
        "diff --git a/Service/Gating/Feature.cs b/Service/Gating/Feature.cs\n"
        "--- a/Service/Gating/Feature.cs\n+++ b/Service/Gating/Feature.cs\n"
        "@@ -1,2 +1,3 @@\n+        if (flights.IsEnabled(FeatureNames.FastMintEnabled)) Mint();\n")
    assert "FastMintEnabled" in set(qa_pr_diff.parse_diff(diff)["feature_flags"])

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
_FLAG_RE = re.compile(r"\bFeatureNames\.(?P<name>[A-Z]\w+)")

def parse_diff(diff_text: str) -> dict:
    files = [{"path": m.group("b")} for m in _FILE_RE.finditer(diff_text)]
    symbols, facts, flags, seen = [], [], set(), set()
    for line in diff_text.splitlines():
        if line.startswith("@@"):
            # Hunk header: the trailing context (after the 2nd @@) names the
            # enclosing class/method the change lives in -> attribute it.
            added = line.split("@@")[-1]
        elif line.startswith("+") and not line.startswith("++"):
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
        for fm in _FLAG_RE.finditer(added):
            flags.add(fm.group("name"))
    return {"files": files, "symbols": symbols, "config_facts": facts,
            "feature_flags": sorted(flags)}

def fetch_and_parse(pr_url: str, *, client: Callable[[str], str]) -> dict:
    res = parse_diff(client(pr_url))
    res["prUrl"] = pr_url
    return res
```

- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_qa_pr_diff.py -v` → 5 passed.
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

The epistemic guardrail in code: facts must cite real bundle event ids; inferences must chain to a kept grounded fact. Everything else is dropped. The `Verdict.attribution` field is **not** set by the model — it is computed by `qa_error_classify.classify` (Task 7b) from the decoded failure's catalog metadata, so a harness/infra failure can never be mislabeled as a verdict on the change (spec §9.B-5/§9.B-6).

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

`qa_head_match` confirms the deployed FLT runs the PR commit, ignoring EDOG's injection set (else HEAD always mismatches post-deploy). `qa_targets` builds the enriched, risk-annotated menu and the locked tuple. **The locked tuple stores GUIDs (`workspaceId`/`lakehouseId`/`capacityId`), never display names** — FLT's name-based resolution fallback can silently resolve the *wrong* lakehouse, so `is_addressable` compares GUIDs and the boundary rejects any name-only address.

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
    # workspace/lakehouse/capacity MUST be GUIDs (workspaceId/lakehouseId from
    # build_menu), never display names — name-based resolution can mis-target.
    return {"workspace": workspace, "lakehouse": lakehouse, "capacity": capacity, "created": created}

def is_addressable(locked: dict, workspace: str, lakehouse: str) -> bool:
    return locked["workspace"] == workspace and locked["lakehouse"] == lakehouse
```

- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_qa_head_match.py tests/test_qa_targets.py -v` → 5 passed.
- [ ] **Step 5: Commit** — `feat(qa): HEAD-match check + enriched locked-target menu`.

---

## Task 7: Scenario-aware infra spec (required-vs-available diff)

**Files:** Create `scripts/qa_infra_spec.py`; Test `tests/test_qa_infra_spec.py`

Aggregates each scenario's `infra requirements` into one required spec, then diffs it against what an existing target actually has — producing the "here's what's missing" list that drives Beat 4's recommend-fresh path. Beyond counts, scenarios may demand specific **table properties** (e.g. `enableChangeDataFeed=false`), **flag preconditions** (e.g. `FLTMLVWarnings`=on + `FLTIRDeltaPhysicalCDFEnabled`=off for a CDFDisabled-warning test), and a **DAG shape** (node count) — so a property mismatch on a same-named table makes an existing target unfit even when the table exists.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_infra_spec.py
from scripts import qa_infra_spec as spec

SCENARIOS = [
    {"infra": {"lakehouses": 1, "tables": ["orders"], "mlvs": 1}},
    {"infra": {"lakehouses": 1, "tables": ["orders", "customers"], "mlvs": 2}},
]
CDF = [
    # Grounded CDFDisabled-warning scenario (verified against FLT): needs
    # FLTMLVWarnings ON, FLTIRDeltaPhysicalCDFEnabled OFF, source CDF off.
    {"infra": {"lakehouses": 1, "tables": ["orders"], "mlvs": 1,
               "table_properties": {"orders": {"enableChangeDataFeed": False}}, "dag_nodes": 4},
     "preconditions": {"flags": {"FLTMLVWarnings": True, "FLTIRDeltaPhysicalCDFEnabled": False}}},
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

def test_required_carries_table_props_flags_and_dag_shape():
    req = spec.required(CDF)
    assert req["table_properties"]["orders"]["enableChangeDataFeed"] is False
    assert req["flags"]["FLTMLVWarnings"] is True
    assert req["flags"]["FLTIRDeltaPhysicalCDFEnabled"] is False
    assert req["dag_nodes"] == 4

def test_fitness_flags_property_mismatch():
    req = spec.required(CDF)
    have = {"lakehouses": 1, "tables": ["orders"], "mlvs": 1,
            "table_properties": {"orders": {"enableChangeDataFeed": True}}, "dag_nodes": 4}
    gap = spec.fitness(req, have)
    assert gap["fits"] is False
    assert gap["missing"]["property_mismatch"]["orders"]["enableChangeDataFeed"] is False
```

- [ ] **Step 2: Run to verify fail** — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# scripts/qa_infra_spec.py
"""Derive the required-infra spec from the scenario plan, and diff it against an
existing target's actual infra to produce the 'what is missing' list. Beyond
counts, scenarios may demand specific TABLE PROPERTIES (e.g. enableChangeDataFeed=False), flag
PRECONDITIONS (e.g. FLTMLVWarnings on + FLTIRDeltaPhysicalCDFEnabled off), and a DAG SHAPE (node count)."""
from __future__ import annotations

def required(scenarios: list[dict]) -> dict:
    lakehouses = mlvs = dag_nodes = 0
    tables: set[str] = set()
    table_props: dict[str, dict] = {}
    flags: dict[str, bool] = {}
    for s in scenarios:
        infra = s.get("infra", {})
        lakehouses = max(lakehouses, int(infra.get("lakehouses", 0)))
        mlvs = max(mlvs, int(infra.get("mlvs", 0)))
        dag_nodes = max(dag_nodes, int(infra.get("dag_nodes", 0)))
        tables.update(infra.get("tables", []))
        for name, props in (infra.get("table_properties") or {}).items():
            table_props.setdefault(name, {}).update(props)
            tables.add(name)
        for flag, state in (s.get("preconditions", {}).get("flags") or {}).items():
            flags[flag] = bool(state)
    return {"lakehouses": lakehouses, "tables": sorted(tables), "mlvs": mlvs,
            "table_properties": table_props, "flags": flags, "dag_nodes": dag_nodes}

def fitness(req: dict, have: dict) -> dict:
    have_tables = set(have.get("tables", []))
    missing_tables = [t for t in req["tables"] if t not in have_tables]
    missing_mlvs = max(0, req["mlvs"] - int(have.get("mlvs", 0)))
    missing_lh = max(0, req["lakehouses"] - int(have.get("lakehouses", 0)))
    dag_short = max(0, req.get("dag_nodes", 0) - int(have.get("dag_nodes", 0)))
    have_props = have.get("table_properties") or {}
    prop_mismatch = {}
    for name, props in req.get("table_properties", {}).items():
        if name in have_tables:
            bad = {k: v for k, v in props.items() if have_props.get(name, {}).get(k) != v}
            if bad:
                prop_mismatch[name] = bad
    fits = (not missing_tables and missing_mlvs == 0 and missing_lh == 0
            and not prop_mismatch and dag_short == 0)
    return {"fits": fits,
            "missing": {"tables": missing_tables, "mlvs": missing_mlvs, "lakehouses": missing_lh,
                        "property_mismatch": prop_mismatch, "dag_nodes": dag_short},
            "required_flags": req.get("flags", {})}
```

- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_qa_infra_spec.py -v` → 5 passed.
- [ ] **Step 5: Commit** — `feat(qa): scenario-aware required-infra spec + fitness diff (table props, flag preconditions, DAG shape)`.

---

## Task 7a: API-contract diff primitive (`qa_contract_diff`)

**Files:** Create `scripts/qa_contract_diff.py`; Test `tests/test_qa_contract_diff.py`

**Two-spec differ — NOT the committed-baseline endpoint.** The FLT repo's committed `Swagger/Swagger.json` is updated infrequently and drifts from reality, so diffing runtime-vs-committed (`/api/playground/swagger/diff`) is misleading. Instead the caller generates the swagger spec **from the PR branch and from its merge-base (main)** and passes both here; the diff then reflects exactly what *this PR* changed. An endpoint = `(METHOD, path)`; a removed or signature/response-shape-changed endpoint is **breaking**, a pure addition is not. Each change carries a stable, content-derived `ch-NNN` id for citation.

> **Spec generation (caller's job, documented in `scenarios.md`/SKILL.md):** generate BOTH specs with **`dotnet swagger tofile`** on each branch's built assembly — PR built by Beat 5's deploy; main = build the **base-commit worktree** (`commonCommit` from `pr-diff`, which Beat 5 already creates) — `dotnet swagger tofile <assembly.dll> <apiVersion> --output main.json`. Using the same generator both sides avoids runtime-vs-tofile formatting noise, and main needs only a **build, not a deploy**. Only run this for controller/DTO-touching PRs. **Prereq:** the `Swashbuckle.AspNetCore.Cli` tool must be installed (`dotnet tool install`/`dotnet swagger`) and the assembly loadable — a build-time setup check; treat a tool/host failure as a **harness** error (it can never be a verdict on the change).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_contract_diff.py
from scripts import qa_contract_diff as cd

def _op(params=None, responses=("200",), body=False):
    op = {"responses": {c: {} for c in responses}}
    if params: op["parameters"] = params
    if body: op["requestBody"] = {}
    return op

MAIN = {"paths": {
    "/a":      {"get":  _op()},
    "/legacy": {"post": _op(responses=("200",))},
    "/gone":   {"delete": _op()},
}}
PR = {"paths": {
    "/a":      {"get":  _op()},
    "/legacy": {"post": _op(responses=("200", "400"))},
    "/new":    {"get":  _op()},
}}

def test_changed_true_with_three_changes():
    r = cd.diff(MAIN, PR)
    assert r["changed"] is True and r["totalChanges"] == 3

def test_added_removed_modified_classified():
    kinds = {c["endpoint"]: c["kind"] for c in cd.diff(MAIN, PR)["changes"]}
    assert kinds["GET /new"] == "added"
    assert kinds["DELETE /gone"] == "removed"
    assert kinds["POST /legacy"] == "modified"

def test_breaking_excludes_pure_additions():
    eps = {c["endpoint"] for c in cd.diff(MAIN, PR)["breaking"]}
    assert eps == {"DELETE /gone", "POST /legacy"}

def test_identical_specs_unchanged():
    r = cd.diff(MAIN, MAIN)
    assert r["changed"] is False and r["breaking"] == []

def test_ids_are_stable_and_contiguous():
    ids = [c["id"] for c in cd.diff(MAIN, PR)["changes"]]
    assert ids == ["ch-001", "ch-002", "ch-003"]

def test_param_change_is_modified():
    main = {"paths": {"/x": {"get": _op(params=[{"name": "id", "in": "query", "required": False}])}}}
    pr   = {"paths": {"/x": {"get": _op(params=[{"name": "id", "in": "query", "required": True}])}}}
    assert cd.diff(main, pr)["changes"][0]["kind"] == "modified"
```

- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_qa_contract_diff.py -v` → `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# scripts/qa_contract_diff.py
"""Deterministic API-contract diff between two generated OpenAPI specs.

We do NOT use the committed Swagger/Swagger.json baseline -- it is updated
infrequently and drifts from reality, which makes a runtime-vs-baseline diff
misleading. Instead the caller generates the swagger spec from the PR branch
and from its merge-base (main) and passes both here, so the diff reflects
exactly what THIS PR changed. An endpoint = (METHOD, path); a removed or
signature/response-shape-changed endpoint is breaking, a pure addition is not.
Each change carries a stable, content-derived `ch-NNN` id for citation.
"""
from __future__ import annotations

_BREAKING_KINDS = {"removed", "modified"}

def _endpoints(spec: dict) -> dict:
    out = {}
    for path, methods in (spec.get("paths") or {}).items():
        for method, op in (methods or {}).items():
            if isinstance(op, dict):
                out[f"{method.upper()} {path}"] = op
    return out

def _signature(op: dict) -> dict:
    # The pieces a consumer depends on: params + request body + response codes.
    return {
        "params": sorted(
            (p.get("name"), p.get("in"), bool(p.get("required")))
            for p in op.get("parameters", []) if isinstance(p, dict)),
        "requestBody": "requestBody" in op,
        "responses": sorted((op.get("responses") or {}).keys()),
    }

def diff(main_spec: dict, pr_spec: dict) -> dict:
    main_eps, pr_eps = _endpoints(main_spec), _endpoints(pr_spec)
    raw = []
    for key in sorted(set(main_eps) | set(pr_eps)):
        if key not in main_eps:
            raw.append(("added", key))
        elif key not in pr_eps:
            raw.append(("removed", key))
        elif _signature(main_eps[key]) != _signature(pr_eps[key]):
            raw.append(("modified", key))
    changes = [{"id": f"ch-{i:03d}", "kind": kind, "endpoint": key}
               for i, (kind, key) in enumerate(raw, start=1)]
    breaking = [c for c in changes if c["kind"] in _BREAKING_KINDS]
    return {"changed": bool(changes), "totalChanges": len(changes),
            "changes": changes, "breaking": breaking,
            "evidence": [c["id"] for c in changes]}
```

- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_qa_contract_diff.py -v` → 6 passed.
- [ ] **Step 5: Commit** — `git add scripts/qa_contract_diff.py tests/test_qa_contract_diff.py && git commit -m "feat(qa): two-spec (main vs PR) contract-diff grounding primitive"` (add the Co-authored-by trailer).

---

## Task 7b: Deterministic failure classifier (`qa_error_classify`)

**Files:** Create `scripts/qa_error_classify.py`; Test `tests/test_qa_error_classify.py`

Maps a decoded error (the `errorSource`/`category`/`httpStatus` metadata the EDOG error catalog already carries) to an **attribution tier** — `change` (the PR's fault), `infra` (the environment's fault), or `unknown`. This is what keeps §9.B-5's harness-vs-test split mechanical instead of an LLM guess; the result feeds `qa_verdict`'s `attribution` field.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_qa_error_classify.py
from scripts import qa_error_classify as ec

def test_user_validation_is_change_attributable():
    assert ec.classify({"errorSource": "User", "category": "Validation", "httpStatus": 400}) == "change"

def test_user_auth_is_change_attributable():
    assert ec.classify({"errorSource": "User", "category": "Authentication", "httpStatus": 401}) == "change"

def test_system_throttling_is_infra():
    assert ec.classify({"errorSource": "System", "category": "Throttling", "httpStatus": 429}) == "infra"

def test_capacity_routing_not_ready_is_infra():
    assert ec.classify({"errorSource": "System", "category": "Execution", "httpStatus": 404}) == "infra"

def test_unknown_when_metadata_missing():
    assert ec.classify({}) == "unknown"

def test_token_expiry_is_infra_not_a_verdict():
    assert ec.classify({"errorSource": "System", "category": "Authentication", "httpStatus": 401}) == "infra"
```

- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_qa_error_classify.py -v` → `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# scripts/qa_error_classify.py
"""Catalog-grounded failure attribution.

EDOG's error-sim-catalog tags every code with `errorSource` (User|System),
`category`, and `httpStatus`. Whose fault a failure is must NOT be an LLM guess
-- it is read off this metadata so the harness-vs-test split (spec §9.B-5) is
deterministic.

Rule: a User-sourced validation/auth failure is the change's fault; a
System-sourced failure (throttling, execution, capacity-routing, token expiry)
is the environment's. Anything we can't tag stays `unknown` (never silently a
verdict on the change).
"""
from __future__ import annotations

def classify(meta: dict) -> str:
    source = (meta.get("errorSource") or "").lower()
    if not source:
        return "unknown"
    if source == "system":
        # Environment-owned: throttling, execution, capacity routing, token expiry.
        return "infra"
    if source == "user":
        # Caller-shape fault: the change's request (validation/auth/contract) is
        # what triggered it, so it's attributable to the change under test.
        return "change"
    return "unknown"
```

- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_qa_error_classify.py -v` → 6 passed.
- [ ] **Step 5: Commit** — `git add scripts/qa_error_classify.py tests/test_qa_error_classify.py && git commit -m "feat(qa): catalog-grounded failure attribution classifier"` (add the Co-authored-by trailer).

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

def _config_restore(s: dict) -> bool:
    """Restore flt_repo_path after a worktree deploy (deploy is config-driven)."""
    import json
    from pathlib import Path
    cfg_path = Path(__file__).parent.parent / "edog-config.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["flt_repo_path"] = s["original"]
    cfg_path.write_text(json.dumps(cfg, indent=2))
    return True

REVERSERS = {
    "flag_clear": _flag_clear,
    "capacity_delete": _capacity_delete,
    "worktree_remove": _worktree_remove,
    "config_restore": _config_restore,   # restore flt_repo_path after worktree deploy
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
- [ ] **Step 2:** `tools.md` — the EDOG HTTP tool surface, one row per endpoint the skill calls (from §4 of the spec) with a concrete `curl` example each. **Primary stimulus = `POST /api/playground/dispatch`** — dispatches ANY well-formed path (NOT catalog-limited; the whole FLT API surface is reachable). **Complete discovery = `GET /api/playground/swagger/spec`** (the live runtime swagger — the full endpoint list, including PublicAPI/MLV controllers the static `/api/playground/catalog` omits; used for runtime discovery + the response-schema invariant — **the main-vs-PR contract diff uses `dotnet swagger tofile` per branch, NOT this runtime endpoint and NOT `/api/playground/swagger/diff`**). Document that the curated catalog is convenience-only, not the coverage boundary. Plus: config, **health (`bearerExpiresIn`)**, ado-proxy/pr-diff + **pr-comment**, fabric/workspaces+lakehouses+capacities, command/deploy + deploy-stream, flt-proxy/runDAG + getDAGExecStatus, **notebook session trio (also the table/MLV seeding path)**, feature-flags/overrides (+`/bulk`, `X-EDOG-Control-Token`, force-ON/OFF) + **`/catalog` (FM-resolved `effectiveForMyWorkspace/locked/isOverridden`; flag STATE comes from the FM repo, override by **wire key/FM `Id`** not the C# const name)**, logs, telemetry, **`/api/executions`** (DAG history+timing), interceptors-status, **`/api/onelake/table-preview-rows`+`table-metadata` (verify output landed)**. Note the **headless start** (`scripts/dev-server.py` direct / `edog --no-browser`) so no Studio webpage opens.
- [ ] **Step 3:** `scenarios.md` — **the generation protocol**: the change-type → scenario-pattern catalog (the table from spec §7), and for each pattern a worked example showing the **eight scenario fields** (`title · category · stimulus · observations · invariants · infra requirements · preconditions · sub-scenarios`). Include: (a) the **AUDITED infra-seeding recipe** — `create workspace → assignToCapacity → create SCHEMA-ENABLED lakehouse (pass the Fabric schema flag; default is non-schema and MLVs need schemas) → create a NOTEBOOK artifact → create-session → execute-cell running Python spark.sql("CREATE TABLE …") then spark.sql("CREATE MATERIALIZED LAKE VIEW silver.<n> AS …") → close-session` (kernel is synapse_pyspark, `language` ignored; cold-start ≤10min; outputs give ok/error; a SQL MLV is catalog-registered + runnable via runDAG with no separate MLVExecutionDefinition — FLT-owner verified); record each create to the ledger; (b) **runDAG** — the skill generates a fresh GUID `iterationId`; body optional; (c) **output verification + response-body + FLT-native oracles** — assert the stimulus call's **API response body/output** itself (cite it); DAG scenarios check `/api/onelake/table-preview-rows` (live parquet) that the write landed; AND read **FLT-native structured outputs as the real semantic oracles** — `node.warnings` (`NodeWarning`, e.g. CDFDisabled), `refresh_policy`, `NodeExecutionMetrics` (added/dropped row counts, status, error_code/source), and the `sys_node_metrics`/`sys_run_metrics` insights tables. (A CDF change leaves the rows identical — only `node.warnings` shows it.) (d) **observation discovery** — `/api/logs`,`/telemetry`,`/executions` are FLT-log-server proxies whose query interface the skill must DISCOVER at runtime (don't assume `?since=&level=`); (e) **stimulus via `/api/playground/dispatch`** (any path) as the default; (f) **contract-diff scenario (main-vs-PR via `dotnet swagger tofile`, NOT the committed baseline)** — for any controller/DTO change, generate the swagger from the PR branch and the base-commit (main) worktree with `dotnet swagger tofile <built-assembly> <apiVersion> --output spec.json` (same generator both sides; main is build-only, no deploy), diff via `qa_contract_diff.diff(main, pr)`, assert each `ch-NNN` is intended, flag removed/modified as breaking. The committed `Swagger.json` is unreliable (rarely updated); do not diff against it. Prereq: `Swashbuckle.AspNetCore.Cli` available; (g) **flag-gating rule (correctness gate; state lives in the FM repo)** — if `qa_pr_diff` reports `feature_flags`, resolve const name → **wire key → FM `Id`** (the FM repo `Features/**/*.json` `Id` is the real key, ≠ filename ≠ const name; override the wire key or it no-ops), read effective state via `GET /api/edog/feature-flags/catalog` (`effectiveForMyWorkspace/locked/isOverridden`, resolved from the FMv2 clone), then `set_override(wireKey, bool)` (force-ON or -OFF) via `POST /api/edog/feature-flags/overrides` (X-EDOG-Control-Token, success = `applied` echo) and **re-read the catalog to confirm `effectiveForMyWorkspace` flipped**; run the scenario's required direction (often ON, sometimes OFF) — `locked`/`missing` = harness limitation, not a verdict; (h) **failure attribution** — decode failures and run them through `qa_error_classify` so `change` vs `infra` is catalog-grounded, never guessed; (i) **preconditions + composite scenarios** — a scenario declares `preconditions` (required flag STATE and table/MLV properties set at seed time) enforced BEFORE stimulus, and may carry `sub_scenarios` that share one seeded (possibly multi-node DAG) infra but exercise many cases — `qa_infra_spec` carries `table_properties`, `flags`, and `dag_nodes` for exactly this. Grounded worked example (verified against FLT): the **CDFDisabled-warning** scenario needs `FLTMLVWarnings`=ON, `FLTIRDeltaPhysicalCDFEnabled`=OFF, and the source table seeded with `delta.enableChangeDataFeed=false`; the skill must READ the FLT code to know each flag's direction, and the oracle is `node.warnings`, not the output rows.
- [ ] **Step 4: Validate** — `python -m pytest tests/test_qa_skill_install.py -v` → 3 passed.
- [ ] **Step 5: Commit** — `docs(qa): skill reference docs (flt-model, tools, scenarios)`.

---

## Task 11: SKILL.md — journey orchestration & guardrail wiring

**Files:** Modify `skills/flt-pr-scenario-validator/SKILL.md`

Write the operational instructions the agent follows, mapping each beat to its primitives and gates. No code — this is the agent's playbook. Cover, in order: Beat 1 (lock → resolve PR via git/ADO → **start the server HEADLESS — launch `scripts/dev-server.py` directly (or `edog --no-browser`); the default `python edog.py` opens the EDOG Studio webpage, which we must NOT do** → **check `/api/edog/health bearerExpiresIn`; ensure a username/session is saved so bearer auto-refresh works across a long run**), Beat 2 (clean-diff understanding via `qa_pr_diff` + repo grep; **note any `feature_flags` it surfaces**), Beat 3 (generate per `scenarios.md`, present editable plan; **controller changes get a main-vs-PR `qa_contract_diff` scenario; flag-gated changes get a flag-ON scenario; scenarios may declare `preconditions` and `sub_scenarios`**), Beat 4 (derive `qa_infra_spec.required` — **incl. `table_properties`, `flags`, `dag_nodes`** — user picks existing/new, existing → `qa_infra_spec.fitness` + "what's missing" (**incl. property mismatches like `cdf`**), new → seed tailored infra **enforcing preconditions at seed time** recording each create to the ledger, `qa_targets.lock_target` — **store GUIDs, never names**), Beat 5 (**repoint `flt_repo_path` by editing `edog-config.json` directly — NOT `--config`, which deletes the token cache — recorded to the ledger as `config_restore`** → worktree checkout recorded to ledger → deploy → `qa_head_match` → **enforce scenario preconditions (resolve each flag's wire key/FM `Id`, read effective state via the FM-resolved `/feature-flags/catalog`, `set_override` to the required state, then re-read to confirm `effectiveForMyWorkspace` flipped; + table props), then exercise any flag-gated change in its required direction** → run happy/edge/perf + main-vs-PR contract-diff (**`dotnet swagger tofile` on each built assembly; main is build-only, no deploy**), **assert the API response body**, observe, `qa_invariants`), Beat 6 (retry-once/flag ON-vs-OFF/correlate; **classify every failure through `qa_error_classify` so attribution is catalog-grounded**; honest "suspected" — fault-injection confirmation is **Phase N, TBD**), Beat 7 (`qa_verdict` → markdown PR comment → cleanup auto-on-pass / offer-keep-on-fail → `qa_cleanup.run`). Explicitly instruct: heartbeat the lock each turn; persist state each turn; **never address a target outside the locked GUID tuple; treat a "backward compatibility mode" / name-based-resolution log as a locked-target violation**; re-check `bearerExpiresIn` before any multi-minute operation; every claim must cite a trace event (or the response body) and pass `qa_verdict.verify`.

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

# PHASE N (TIMING TBD) — FAILURE INJECTION & AUTO-INVESTIGATION

> Adds the chaos-driven scenarios and the confirm-the-root-cause loop. Upgrades Phase-1 "suspected" verdicts to "confirmed". **Timing is undecided — this is deferred to an undetermined later phase ("Phase N"), not committed to immediately follow Phase 1.**

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




