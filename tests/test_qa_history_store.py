"""F27 P7 — Source-grep contract tests for EdogQaRunStore.

These tests pin the structural invariants of the disk-backed history
store. They complement the behavioural harness in
``test_qa_history_e2e.py`` (which only runs when FLT bin is present);
the source-grep gauntlet here runs on every commit and catches
refactors that silently strip a documented guarantee.

Conventions follow the F27 P5 source-grep style (see
``tests/test_qa_capabilities.py``): each test loads the file once via
a fixture, then asserts on the presence + ordering of marker strings.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
STORE_PATH = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaRunStore.cs"
HUB_PATH = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogPlaygroundHub.cs"
MODELS_PATH = REPO_ROOT / "src" / "backend" / "DevMode" / "QaSignalRModels.cs"


@pytest.fixture(scope="module")
def store_src() -> str:
    return STORE_PATH.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def hub_src() -> str:
    return HUB_PATH.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def models_src() -> str:
    return MODELS_PATH.read_text(encoding="utf-8")


# ───────────────────────────────────────────────────────────────────
# 1. File existence + top-level surface
# ───────────────────────────────────────────────────────────────────


def test_store_file_exists() -> None:
    assert STORE_PATH.exists(), (
        "EdogQaRunStore.cs is the entire P7 persistence layer — "
        "deleting it removes server-side history."
    )


def test_store_is_devmode_only_file(store_src: str) -> None:
    """Every DevMode file disables nullable + warnings so it compiles
    cleanly when injected into FLT (see hivemind STYLE_GUIDE.md)."""
    assert "#nullable disable" in store_src
    assert "#pragma warning disable" in store_src
    assert "namespace Microsoft.LiveTable.Service.DevMode" in store_src


def test_store_is_registered_for_deployment() -> None:
    """edog.py's DEVMODE_FILES is the source of truth for what gets
    injected into FLT. A new DevMode file that is not registered will
    not be deployed; the C# build gate catches the mismatch but only
    after the fact — this test fires immediately."""
    edog_src = (REPO_ROOT / "edog.py").read_text(encoding="utf-8")
    assert '"EdogQaRunStore"' in edog_src, (
        "EdogQaRunStore must appear in edog.py DEVMODE_FILES."
    )


# ───────────────────────────────────────────────────────────────────
# 2. Schema + migration
# ───────────────────────────────────────────────────────────────────


def test_envelope_carries_schema_version(store_src: str) -> None:
    """Future field additions must be migratable. The envelope owns the
    schema version — never inline it inside the record."""
    assert "class QaRunStoreEnvelope" in store_src
    assert "SchemaVersion { get; set; }" in store_src
    assert "CurrentSchemaVersion = 1" in store_src


def test_migration_helper_exists(store_src: str) -> None:
    """The migration helper is required from day 1 even if no migration
    runs today — adding it later is twice the work because every
    persisted file must then be retroactively versioned."""
    assert "MigrateIfNeeded" in store_src
    # Future-version files must be quarantined, not silently overwritten.
    assert "QuarantineCorruptFile" in store_src
    assert "envelope.SchemaVersion > CurrentSchemaVersion" in store_src


# ───────────────────────────────────────────────────────────────────
# 3. Storage location + env-var override
# ───────────────────────────────────────────────────────────────────


def test_storage_path_resolution_priority(store_src: str) -> None:
    """Priority order from the F27 P7 design: env var → LocalAppData →
    temp fallback. The order matters — tests + CI rely on the env var
    to redirect away from a developer's real LocalAppData."""
    env_idx = store_src.find('"EDOG_QA_HISTORY_DIR"')
    local_idx = store_src.find("SpecialFolder.LocalApplicationData")
    temp_idx = store_src.find("Path.GetTempPath()")
    assert env_idx > 0, "EDOG_QA_HISTORY_DIR env-var override missing."
    assert local_idx > 0, "LocalAppData fallback missing."
    assert temp_idx > 0, "Temp-dir final fallback missing."
    assert env_idx < local_idx < temp_idx, (
        "Path resolution must check env var first, then LocalAppData, "
        "then OS temp. Re-ordering changes the user-visible storage location."
    )


def test_resolved_path_is_logged(store_src: str) -> None:
    """When something goes wrong the user must be able to find the
    file. The resolved path is emitted via Debug.WriteLine."""
    assert 'Debug.WriteLine($"[EDOG] QaRunStore resolved path:' in store_src


# ───────────────────────────────────────────────────────────────────
# 4. Atomic write + corruption recovery
# ───────────────────────────────────────────────────────────────────


def test_atomic_write_uses_tmp_then_move(store_src: str) -> None:
    """The proven safe-write pattern: write to .tmp, File.Move with
    overwrite. Same shape EdogNexusSessionStore uses."""
    assert 'var tmp = path + ".tmp"' in store_src
    assert "File.WriteAllText(tmp" in store_src
    assert "File.Move(tmp, path, overwrite: true)" in store_src


def test_orphan_tmp_is_cleaned_at_load(store_src: str) -> None:
    """An interrupted writer can leave .tmp behind. The store must
    clean it at load time — otherwise stale data could be promoted."""
    assert "CleanupOrphanTemp" in store_src
    assert "File.Exists(tmp)" in store_src
    assert "File.Delete(tmp)" in store_src


def test_corrupt_file_is_quarantined(store_src: str) -> None:
    """JsonException → rename file to qa-runs.json.corrupt-<unix>.json and
    start empty. NEVER throw out of persistence code."""
    assert "catch (JsonException ex)" in store_src
    assert "QuarantineCorruptFile" in store_src
    assert "corrupt-" in store_src
    assert "ToUnixTimeSeconds()" in store_src


def test_persistence_never_throws(store_src: str) -> None:
    """All write paths catch Exception and log; QA execution must never
    fail because the history file is wedged."""
    assert "catch (Exception ex)" in store_src
    assert 'non-fatal' in store_src.lower()


# ───────────────────────────────────────────────────────────────────
# 5. Eviction cap + sort order
# ───────────────────────────────────────────────────────────────────


def test_record_cap_enforced(store_src: str) -> None:
    """Records are bounded at 100 — drop oldest by CompletedAt. This
    keeps the JSON file at a few hundred KB worst case so full
    rewrites stay cheap."""
    assert "MaxRecords = 100" in store_src
    assert "while (_records.Count > MaxRecords)" in store_src
    assert "_records.RemoveAt(_records.Count - 1)" in store_src


def test_sort_is_newest_first(store_src: str) -> None:
    """The wire contract for the hub's history list is newest-first.
    Sort happens AFTER add and AFTER migration merges."""
    assert "_records.Sort((a, b) => b.CompletedAt.CompareTo(a.CompletedAt))" in store_src


# ───────────────────────────────────────────────────────────────────
# 6. Hydration + thread safety
# ───────────────────────────────────────────────────────────────────


def test_double_checked_hydration(store_src: str) -> None:
    """Two callers hitting EnsureLoaded simultaneously must not double-
    read. The double-checked pattern under the state lock is what the
    rubber-duck explicitly required to prevent the merge race."""
    assert "if (_loaded) return;" in store_src
    assert "lock (_stateLock)" in store_src


def test_writes_use_dedicated_write_lock(store_src: str) -> None:
    """File I/O happens under _writeLock, not _stateLock. This stops
    SignalR read paths stalling on disk."""
    assert "object _writeLock" in store_src
    assert "Monitor.TryEnter(_writeLock)" in store_src


# ───────────────────────────────────────────────────────────────────
# 7. Comparison contract
# ───────────────────────────────────────────────────────────────────


def test_compare_returns_typed_result(store_src: str) -> None:
    """Compare() returns a QaRunComparison with explicit fields so the
    UI does not have to introspect anonymous types."""
    assert "public static QaRunComparison Compare(" in store_src
    assert "AddedInTarget" in store_src
    assert "RemovedFromTarget" in store_src
    assert "StatusFlips" in store_src
    assert "Warnings" in store_src


def test_compare_matches_hash_before_id(store_src: str) -> None:
    """ScenarioHash is the authoritative match key; ScenarioId is the
    fallback. The reverse — ID-first — would silently mis-attribute
    flips after a scenario rename."""
    assert 'KeyOf' in store_src
    # Key prefix indicates which strategy matched; the comparison test
    # in the behavioural harness pins the actual semantics.
    assert '"h:"' in store_src and '"i:"' in store_src
    assert "string.IsNullOrEmpty(s.ScenarioHash)" in store_src


def test_compare_warns_on_id_fallback(store_src: str) -> None:
    """When any scenario lacks a hash, the comparison MUST attach a
    warning so the UI can degrade confidence."""
    assert "anyMissingHash" in store_src
    assert "matched by scenarioId only" in store_src


def test_compare_warns_on_unscoped_runs(store_src: str) -> None:
    """Two prId=0 runs may have nothing to do with each other —
    surface a warning instead of silently treating them as comparable."""
    assert "PrId == 0 && targetRun.PrId == 0" in store_src
    assert "not PR-scoped" in store_src


def test_compare_warns_on_pr_mismatch(store_src: str) -> None:
    """If base and target target different PRs, that is almost always
    a mistake; the warning helps the user catch it before reading the
    diff."""
    assert "Runs target different PRs" in store_src


def test_compare_rejects_self_comparison(store_src: str) -> None:
    """Comparing a run to itself is a no-op — short-circuit with a
    clear Error rather than producing an empty diff."""
    assert "Cannot compare a run to itself" in store_src


# ───────────────────────────────────────────────────────────────────
# 8. Hub wiring
# ───────────────────────────────────────────────────────────────────


def test_hub_persists_record_after_history(hub_src: str) -> None:
    """The persistence hook lives at the run-completion site, after
    StoreRunResult + AddToHistory. Moving it earlier means partial
    runs could be persisted."""
    add_to_history_idx = hub_src.find("AddToHistory(new QaRunSummary")
    persist_idx = hub_src.find("EdogQaRunStore.Add(new QaRunRecord")
    assert add_to_history_idx > 0
    assert persist_idx > 0
    assert persist_idx > add_to_history_idx, (
        "EdogQaRunStore.Add must be invoked AFTER AddToHistory so the "
        "in-memory cache is updated first."
    )


def test_hub_persists_inside_try_catch(hub_src: str) -> None:
    """Persistence failure MUST NOT fail the surrounding QA run. The
    EdogQaRunStore.Add call is wrapped in try/catch as a final safety
    net even though the store itself never throws."""
    idx = hub_src.find("EdogQaRunStore.Add(new QaRunRecord")
    window = hub_src[max(0, idx - 200): idx + 1200]
    assert "try" in window
    assert "catch (Exception persistEx)" in window
    assert "non-fatal" in window.lower()


def test_hub_builds_scenarios_with_hash(hub_src: str) -> None:
    """Each persisted scenario carries a content hash synthesised at
    persist time. Hashing inside the loop avoids a second pass."""
    assert "persistedScenarios.Add(new QaScenarioRecord" in hub_src
    assert "EdogQaRunStore.ComputeScenarioHash(" in hub_src


def test_hub_compare_method_exists(hub_src: str) -> None:
    """QaCompareRuns is the public hub surface. Removing it breaks
    the comparison UI; the contract snapshot catches the regression
    but this test fires earlier."""
    assert "public Task<QaRunComparison> QaCompareRuns(" in hub_src


def test_hub_hydrates_history_once(hub_src: str) -> None:
    """The first GetHistory call must hydrate from disk. Subsequent
    calls short-circuit on the _historyHydrated flag."""
    assert "HydrateHistoryFromStore" in hub_src
    assert "volatile bool _historyHydrated" in hub_src
    # Double-check: read disk OUTSIDE the state lock to avoid stalling
    # SignalR threads on file I/O.
    hydration_idx = hub_src.find("private static void HydrateHistoryFromStore")
    body = hub_src[hydration_idx: hydration_idx + 2000]
    list_idx = body.find("EdogQaRunStore.ListAllSummaries()")
    state_lock_idx = body.find("lock (_lock)")
    assert list_idx > 0 and state_lock_idx > 0, body[:400]
    assert list_idx < state_lock_idx, (
        "Disk read must happen BEFORE the state lock is taken."
    )


def test_hub_run_detail_falls_back_to_disk(hub_src: str) -> None:
    """If a run is not in the in-memory dictionary (e.g. it predates
    the current FLT process), GetRunResult must fall back to disk."""
    idx = hub_src.find("internal static QaRunResult GetRunResult")
    body = hub_src[idx: idx + 1400]
    assert "EdogQaRunStore.Get(runId)" in body, (
        "GetRunResult must consult EdogQaRunStore when the in-memory "
        "cache misses, otherwise history detail breaks after restart."
    )


# ───────────────────────────────────────────────────────────────────
# 9. Wire models
# ───────────────────────────────────────────────────────────────────


def test_qa_run_record_model(models_src: str) -> None:
    """QaRunRecord is the persisted full-fidelity row. Scenarios are
    summary rows (not ScenarioResult) so file size stays bounded."""
    assert "public sealed class QaRunRecord" in models_src
    assert "public List<QaScenarioRecord> Scenarios" in models_src


def test_qa_scenario_record_model(models_src: str) -> None:
    """Identity columns: ScenarioId, ScenarioHash. Display columns:
    Title, Category, Status, ErrorSummary."""
    assert "public sealed class QaScenarioRecord" in models_src
    assert "ScenarioHash" in models_src
    assert "ErrorSummary" in models_src


def test_qa_run_comparison_model(models_src: str) -> None:
    """The comparison wire shape MUST include explicit base/target ids
    and a Warnings list so the UI can render degraded-confidence
    banners."""
    assert "public sealed class QaRunComparison" in models_src
    assert "public string BaseRunId" in models_src
    assert "public string TargetRunId" in models_src
    assert "public List<QaScenarioFlip> StatusFlips" in models_src
    assert "public List<string> Warnings" in models_src


# ── F27 P7 Chunk 2: frontend compare UI guards ─────────────────────────

QA_RESULTS_JS = REPO_ROOT / "src" / "frontend" / "js" / "qa-results.js"


@pytest.fixture(scope="module")
def qa_results_js() -> str:
    return QA_RESULTS_JS.read_text(encoding="utf-8")


def test_qa_results_invokes_qa_compare_runs(qa_results_js: str) -> None:
    """The compare dropdown must invoke QaCompareRuns with both run ids — losing
    either parameter silently breaks the diff and falls through to the
    'success: false' branch in the C# hub."""
    assert "'QaCompareRuns'" in qa_results_js
    assert "baseRunId" in qa_results_js and "targetRunId" in qa_results_js


def test_qa_results_renders_all_diff_badges(qa_results_js: str) -> None:
    """The four diff verdicts that the hub returns (NEW / GONE / flip-PASS /
    flip-FAIL) MUST all have a corresponding badge renderer or the UI will
    silently drop categories of regressions."""
    assert "qa-compare-new" in qa_results_js
    assert "qa-compare-gone" in qa_results_js
    assert "qa-compare-flip-pass" in qa_results_js
    assert "qa-compare-flip-fail" in qa_results_js


def test_qa_results_renders_warnings_banner(qa_results_js: str) -> None:
    """When the comparison returns warnings (degraded-confidence /
    cross-PR / unscoped), the UI MUST render them — they are the only
    way a user knows the diff is approximate."""
    assert "qa-compare-warnings" in qa_results_js
    assert "warnings" in qa_results_js


def test_qa_results_match_key_mirrors_csharp(qa_results_js: str) -> None:
    """JS match-key must use the same 'h:' / 'i:' prefix scheme as the C#
    matcher, otherwise added/flip lookup will silently miss every row."""
    assert "'h:'" in qa_results_js
    assert "'i:'" in qa_results_js
