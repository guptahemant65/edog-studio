"""Patch 8 — Pre-register InsightDiscoveryHook before the faulted-nodes throw.

Bug
---
The faulted-nodes branch in DagExecutionHandlerV2.cs throws
EdogFaultedNodeException (added by Patch 4) BEFORE the hook-registration
block at L406-465 runs. dagExecutionHooks is declared empty at L155 and
only populated by that L406+ block. So at throw-time the list is empty,
and the outer-catch's "fire hooks on failure" safety net at L646 sees
`dagExecutionHooks.Count == 0` and silently does nothing. Result:
InsightDiscoveryHook never runs for any faulted-node failure (real OR
simulated), no insight card is generated.

This bug pre-dates Phase 0 — the bare `throw new Exception(...)` had it
too. Phase 0 just exposed it on the simulator path.

Patch 8 fix
-----------
Inject a guarded registration block immediately BEFORE the typed-throw
comment introduced by Patch 4. The block mirrors the L457 hook
construction verbatim (same FLTInsightsEngine feature flag, same rules
list: ConsecutiveFailuresRule + DurationRegressionRule) and dedups via
`dagExecutionHooks.Any(h => h.Name == "InsightDiscovery")` so it never
double-registers.

These tests verify apply correctness, idempotency, revert symmetry, and
the explicit dependency on Patch 4 (no Patch 4 → pattern_not_found).
The real-FLT StyleCop / msbuild verification lives alongside the other
Phase 0 patches in test_phase0_error_sim_rebuild.py.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location("edog", str(REPO / "edog.py"))
edog = importlib.util.module_from_spec(_spec)
sys.path.insert(0, str(REPO))
_cwd = os.getcwd()
try:
    os.chdir(REPO)
    _spec.loader.exec_module(edog)
finally:
    os.chdir(_cwd)


# Minimal synthetic FLT fixture mirroring the exact anchor lines Patch 4 + Patch 8 need.
DAGHANDLER_FIXTURE = """\
namespace Microsoft.LiveTable.Service.Core.V2
{
    using System.Linq;

    public class DagExecutionHandlerV2
    {
        public async Task ExecuteAsync(ReliableOperationMetadata metadata, CancellationToken monikerEvictionCancellationToken)
        {
            await LiveTableRunCodeMarker.RunDAG.ExecuteAsync(async ms =>
            {
                var iterationId = metadata.OpId;
                List<IDagExecutionHook> dagExecutionHooks = new List<IDagExecutionHook>();

                DagExecutionContext dagExecutionContext = null;
                string resultCode = null;
                string errorMessage = null;
                ErrorSource errorSource = default;

                try
                {
                    // ... synthetic: imagine DAG build + faulted-node check here ...
                    var faultedNodes = sortedNodes.Where(n => n.IsFaulted).ToList();
                    if (faultedNodes.Count > 0)
                    {
                        var faultedDetails = string.Join("; ", faultedNodes.Select(n => $"{n.Name}: {n.ErrorMessage ?? "Unknown error"}"));
                        errorMessage = ErrorRegistry.GetErrorMessage(
                            ErrorCode.MLV_DAG_HAS_FAULTED_NODES,
                            new Dictionary<string, string> { { Constants.ErrorMessageKey, faultedDetails } });

                        resultCode = ErrorCode.MLV_DAG_HAS_FAULTED_NODES.ToString();
                        activityStatus = StandardizedActivityStatus.SucceededWithErrors;
                        errorSource = ErrorSource.User;
                        throw new Exception(errorMessage);
                    }
                }
                catch (Exception e)
                {
                    // outer catch ...
                }
            });
        }
    }
}
"""


@pytest.fixture
def fixture_with_patch4() -> str:
    """Fixture state AFTER Patch 4 (faulted-node typed throw) has applied.

    Patch 8 anchors on Patch 4's typed-throw comment — this fixture
    provides exactly that precondition.
    """
    content, status = edog.apply_faulted_node_typed_throw_patch(DAGHANDLER_FIXTURE)
    assert status == "applied", f"Patch 4 prerequisite failed: {status}"
    return content


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — Apply correctness
# ─────────────────────────────────────────────────────────────────────────────


class TestApplyPatch8:
    @pytest.fixture
    def patched(self, fixture_with_patch4) -> str:
        content, status = edog.apply_register_hooks_before_faulted_throw_patch(fixture_with_patch4)
        assert status == "applied"
        return content

    def test_sentinel_string_present(self, patched):
        assert "// EDOG DevMode — register InsightDiscoveryHook before the faulted-nodes throw" in patched

    def test_uses_real_feature_flag_name(self, patched):
        # Must match the L454 production registration's flag verbatim — using
        # the wrong name (e.g., FLTInsightDiscoveryEngine) would gate on a
        # different flag and silently never enable the early registration.
        assert "FeatureNames.FLTInsightsEngine" in patched

    def test_uses_exact_rules_list_from_line_457(self, patched):
        # If these diverge from the L457 list, the early-registered hook
        # behaves differently from the normal-flow one — latent fidelity bug.
        snippet = patched[patched.find("register InsightDiscoveryHook before") :][:2000]
        assert "new ConsecutiveFailuresRule()" in snippet
        assert "new DurationRegressionRule()" in snippet
        # Sanity: exactly TWO rules (no extras, no missing).
        rules_block_start = snippet.find("new IInsightRule[]")
        rules_block_end = snippet.find("}));", rules_block_start)
        rules_block = snippet[rules_block_start:rules_block_end]
        assert rules_block.count("new ") == 3, (
            "Expected exactly 3 `new ` allocations in rules block "
            "(IInsightRule[], ConsecutiveFailuresRule, DurationRegressionRule)"
        )

    def test_dedups_on_hook_name(self, patched):
        # Must check `Any(h => h.Name == "InsightDiscovery")` so a future
        # re-order that runs both blocks does not double-register the hook.
        # The literal must match InsightDiscoveryHook.Name (verified against
        # source at hook file line 66: `public string Name => "InsightDiscovery";`).
        assert 'dagExecutionHooks.Any(h => h.Name == "InsightDiscovery")' in patched

    def test_inject_is_wrapped_in_try_catch(self, patched):
        # Hook registration failure must never block DAG fault handling —
        # the outer-catch must always reach the typed throw.
        snippet = patched[patched.find("register InsightDiscoveryHook before") :][:2000]
        # The first try{ in the block is ours.
        try_pos = snippet.find("try\n")
        catch_pos = snippet.find("catch\n", try_pos)
        comment_pos = snippet.find("Non-fatal — hook registration failure", catch_pos)
        assert 0 < try_pos < catch_pos < comment_pos < len(snippet)

    def test_inject_null_guards_on_dag_execution_context(self, patched):
        # Defensive — the standard L407 block does not null-guard because
        # the comment at L406 promises dagExecutionContext is set by that
        # point. Our faulted-nodes branch runs EARLIER, so the conservative
        # choice is to null-check.
        assert "if (dagExecutionContext != null" in patched

    def test_inject_sits_before_typed_throw(self, patched):
        # CRITICAL ordering invariant — the fix only works if the
        # registration happens before the throw.
        register_pos = patched.find("register InsightDiscoveryHook before the faulted-nodes throw")
        throw_pos = patched.find("throw new Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException")
        assert register_pos > 0 < throw_pos
        assert register_pos < throw_pos, (
            "Patch 8 injection must sit BEFORE the typed throw — otherwise the "
            "hooks list is still empty when the throw fires and the outer-catch "
            "safety net silently skips InsightDiscoveryHook."
        )

    def test_inject_sits_inside_faulted_nodes_if_block(self, patched):
        # Must be inside `if (faultedNodes.Count > 0)` — registering it
        # unconditionally outside would double-register on the normal path
        # (the L406+ block runs anyway).
        if_pos = patched.find("if (faultedNodes.Count > 0)")
        register_pos = patched.find("register InsightDiscoveryHook before the faulted-nodes throw")
        throw_pos = patched.find("throw new Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException")
        # All three should be present and in order.
        assert if_pos > 0 < register_pos < throw_pos

    def test_indentation_matches_surrounding_block(self, patched):
        # The injected block lives at 24-space indent (6 levels of 4),
        # matching the surrounding faulted-node body. Drift here is a
        # symptom of broken indent that StyleCop will reject.
        for needle in (
            "                        // EDOG DevMode — register InsightDiscoveryHook before the faulted-nodes throw",
            "                        try",
            "                        catch",
        ):
            assert needle in patched, f"24-space indent missing for: {needle.strip()[:60]}"


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — Idempotency: re-apply returns "already_applied" unchanged
# ─────────────────────────────────────────────────────────────────────────────


class TestIdempotency:
    def test_second_apply_returns_already_applied(self, fixture_with_patch4):
        once, status1 = edog.apply_register_hooks_before_faulted_throw_patch(fixture_with_patch4)
        assert status1 == "applied"
        twice, status2 = edog.apply_register_hooks_before_faulted_throw_patch(once)
        assert status2 == "already_applied"
        assert twice == once, "Second apply must not mutate content"

    def test_third_apply_still_already_applied(self, fixture_with_patch4):
        once, _ = edog.apply_register_hooks_before_faulted_throw_patch(fixture_with_patch4)
        twice, _ = edog.apply_register_hooks_before_faulted_throw_patch(once)
        thrice, status3 = edog.apply_register_hooks_before_faulted_throw_patch(twice)
        assert status3 == "already_applied"
        assert thrice == twice


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — Pattern not found when Patch 4 has not been applied
# ─────────────────────────────────────────────────────────────────────────────


class TestExplicitDependencyOnPatch4:
    def test_apply_on_clean_fixture_returns_pattern_not_found(self):
        # Patch 8 anchors on Patch 4's typed-throw comment. On a clean
        # fixture (no Patch 4), it must fail loudly rather than inject
        # at the wrong site.
        _, status = edog.apply_register_hooks_before_faulted_throw_patch(DAGHANDLER_FIXTURE)
        assert status == "pattern_not_found"

    def test_apply_on_unrelated_source_returns_pattern_not_found(self):
        _, status = edog.apply_register_hooks_before_faulted_throw_patch(
            "namespace X { public class Y { } }"
        )
        assert status == "pattern_not_found"


# ─────────────────────────────────────────────────────────────────────────────
# Test 4 — Revert symmetry: apply + revert is byte-for-byte clean
# ─────────────────────────────────────────────────────────────────────────────


class TestRevertSymmetry:
    def test_apply_then_revert_restores_patch4_state(self, fixture_with_patch4):
        # Patch 8 revert leaves Patch 4 in place (different concern, different
        # revert). After patch8+revert8, content must equal post-patch4 state.
        patched, status = edog.apply_register_hooks_before_faulted_throw_patch(fixture_with_patch4)
        assert status == "applied"
        reverted = edog.revert_register_hooks_before_faulted_throw_patch(patched)
        assert reverted == fixture_with_patch4, (
            "Patch 8 apply+revert must be byte-for-byte symmetric on top of Patch 4 state. "
            "A drift here indicates injection or revert pattern is asymmetric."
        )

    def test_revert_on_clean_post_patch4_source_is_no_op(self, fixture_with_patch4):
        # Revert on a source that never had Patch 8 applied must be a no-op.
        assert edog.revert_register_hooks_before_faulted_throw_patch(fixture_with_patch4) == fixture_with_patch4

    def test_revert_on_pristine_fixture_is_no_op(self):
        # Even before Patch 4, revert is a no-op (defensive — never destroys data).
        assert edog.revert_register_hooks_before_faulted_throw_patch(DAGHANDLER_FIXTURE) == DAGHANDLER_FIXTURE

    def test_full_round_trip_with_patch4(self):
        # apply patch 4 + apply patch 8 → revert patch 8 + revert patch 4 → original.
        c = DAGHANDLER_FIXTURE
        c, _ = edog.apply_faulted_node_typed_throw_patch(c)
        c, _ = edog.apply_register_hooks_before_faulted_throw_patch(c)
        c = edog.revert_register_hooks_before_faulted_throw_patch(c)
        c = edog.revert_faulted_node_typed_throw_patch(c)
        assert c == DAGHANDLER_FIXTURE, (
            "Full apply (P4+P8) followed by reverse-order revert must restore the original"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 5 — Wiring: apply / revert functions are registered in edog.py flow
# ─────────────────────────────────────────────────────────────────────────────


class TestWiring:
    def test_apply_function_exists_in_edog(self):
        assert hasattr(edog, "apply_register_hooks_before_faulted_throw_patch")
        assert callable(edog.apply_register_hooks_before_faulted_throw_patch)

    def test_revert_function_exists_in_edog(self):
        assert hasattr(edog, "revert_register_hooks_before_faulted_throw_patch")
        assert callable(edog.revert_register_hooks_before_faulted_throw_patch)

    def test_apply_is_wired_into_apply_devmode_patches(self):
        # Must be invoked from the deploy flow — otherwise it never runs.
        edog_src = (REPO / "edog.py").read_text(encoding="utf-8")
        assert "apply_register_hooks_before_faulted_throw_patch(content)" in edog_src

    def test_revert_is_wired_into_revert_devmode_patches(self):
        # Must be present in the revert loop list — otherwise edog --revert
        # leaves the injection behind.
        edog_src = (REPO / "edog.py").read_text(encoding="utf-8")
        assert "revert_register_hooks_before_faulted_throw_patch" in edog_src
        # And specifically in the revert ordering list. Use the unique
        # descriptor string we register in the revert loop's tuple to
        # locate the right block (not the function def far up in the file).
        revert_descriptor = '("Pre-register InsightDiscoveryHook before faulted throw"'
        assert revert_descriptor in edog_src, (
            "Patch 8 revert must be registered with descriptor "
            f"{revert_descriptor!r} in the revert-loop tuple list."
        )
        # And it must sit BETWEEN the guard-extend descriptor (immediately
        # above in the reverse-of-apply order) and the typed-throw descriptor.
        guard_pos = edog_src.find('("Outer-catch guard extend"')
        register_pos = edog_src.find(revert_descriptor)
        typed_pos = edog_src.find('("Faulted-node typed throw"')
        assert guard_pos > 0 < register_pos < typed_pos, (
            "Patch 8 revert must be ordered AFTER outer-catch-guard-extend revert "
            "and BEFORE faulted-node-typed-throw revert (reverse of apply order)."
        )


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 — Coupled-postcondition: orchestration warns when Patch 4 applied
#          but Patch 8 didn't. We assert the warning text + condition by
#          inspecting edog.py source (the orchestration touches real files
#          and is hard to unit-test in isolation).
# ─────────────────────────────────────────────────────────────────────────────


class TestCoupledPostconditionExtended:
    def test_postcondition_check_inspects_patch8_state(self):
        edog_src = (REPO / "edog.py").read_text(encoding="utf-8")
        # The coupled check must read whether Patch 8 is applied.
        assert "has_register_hooks" in edog_src

    def test_postcondition_warns_when_patch4_applied_but_patch8_missing(self):
        edog_src = (REPO / "edog.py").read_text(encoding="utf-8")
        # The conditional must be present.
        assert "if has_typed_throw and not has_register_hooks:" in edog_src
        # The warning text must mention Patch 8 + the silent-fail consequence.
        assert "PATCH 8 NOT APPLIED" in edog_src
        assert "InsightDiscoveryHook" in edog_src
        assert "silently skip InsightDiscoveryHook" in edog_src


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 — Real-FLT StyleCop / build invariant (opt-in, skipped when the FLT
#          repo isn't checked out next to edog-studio).
# ─────────────────────────────────────────────────────────────────────────────


FLT_ROOT = pathlib.Path(r"C:\Users\guptahemant\newrepo\workload-fabriclivetable")
FLT_DAG = FLT_ROOT / edog.FILES["DagExecutionHandlerV2"]


@pytest.mark.skipif(
    not FLT_DAG.exists(),
    reason="real FLT source not present — Patch 8 real-source invariants check is opt-in",
)
class TestRealFLTPatch8Invariants:
    """Apply Patch 4 + Patch 8 to the REAL FLT source and assert the injection
    sits in the right place, uses the right symbols (FLTInsightsEngine,
    InsightDiscoveryHook, ConsecutiveFailuresRule, DurationRegressionRule),
    and matches the L457 hook construction verbatim.

    msbuild verification (must compile 0/0) runs externally — this test
    enforces the structural preconditions for that compile to succeed.
    """

    @pytest.fixture(scope="class")
    def patched_dag(self):
        """Real-FLT source with Patch 4 + Patch 8 applied.

        Robust to whatever Phase 0 state the local FLT happens to be in:
        if a patch returns ``already_applied`` (because dev applied patches
        outside this test), we accept that as equivalent to ``applied`` —
        what matters is the final structural state of the file.
        """
        content = FLT_DAG.read_text(encoding="utf-8")
        content, status4 = edog.apply_faulted_node_typed_throw_patch(content)
        assert status4 in ("applied", "already_applied"), f"Patch 4 prerequisite on real FLT: {status4}"
        content, status8 = edog.apply_register_hooks_before_faulted_throw_patch(content)
        assert status8 in ("applied", "already_applied"), f"Patch 8 on real FLT: {status8}"
        return content

    def test_real_flt_inject_uses_same_flag_as_line_457(self, patched_dag):
        # Both the normal-flow registration (L454-462) AND Patch 8 must gate
        # on FLTInsightsEngine — if Patch 8 used a different flag, the two
        # registrations would diverge under different flighting states.
        assert "FeatureNames.FLTInsightsEngine" in patched_dag
        # Sanity: there are now (at least) two callsites for this flag in the file.
        assert patched_dag.count("FeatureNames.FLTInsightsEngine") >= 2

    def test_real_flt_inject_uses_same_rules_as_line_457(self, patched_dag):
        # Both registration sites must construct InsightDiscoveryHook with
        # exactly ConsecutiveFailuresRule + DurationRegressionRule, in order.
        assert patched_dag.count("new ConsecutiveFailuresRule()") >= 2
        assert patched_dag.count("new DurationRegressionRule()") >= 2

    def test_real_flt_inject_before_typed_throw(self, patched_dag):
        register_pos = patched_dag.find("register InsightDiscoveryHook before the faulted-nodes throw")
        throw_pos = patched_dag.find("throw new Microsoft.LiveTable.Service.DevMode.EdogFaultedNodeException")
        assert register_pos > 0 < throw_pos
        assert register_pos < throw_pos

    def test_real_flt_normal_flow_registration_still_present(self, patched_dag):
        # Patch 8 must not have disturbed the L457 normal-flow registration.
        assert "dagExecutionHooks.Add(new InsightDiscoveryHook(new IInsightRule[]" in patched_dag

    def test_real_flt_round_trip_byte_for_byte(self):
        """Apply+revert is byte-symmetric regardless of starting state.

        Normalize to a clean baseline (no Patch 4, no Patch 8) so the test
        works whether the local FLT was already in some patched state or
        not. Round-trip P4+P8 from that baseline, verify byte-equal.
        """
        original = FLT_DAG.read_text(encoding="utf-8")
        # Strip both patches first (no-op if neither is present). Revert
        # order: P8 before P4 (Patch 8's revert anchors on Patch 4's
        # injected text; reverting P4 first would orphan Patch 8's residue).
        baseline = edog.revert_register_hooks_before_faulted_throw_patch(original)
        baseline = edog.revert_faulted_node_typed_throw_patch(baseline)

        c = baseline
        c, _ = edog.apply_faulted_node_typed_throw_patch(c)
        c, _ = edog.apply_register_hooks_before_faulted_throw_patch(c)
        c = edog.revert_register_hooks_before_faulted_throw_patch(c)
        c = edog.revert_faulted_node_typed_throw_patch(c)
        assert c == baseline, (
            "Real-FLT P4+P8 apply / reverse-order revert must restore the baseline byte-for-byte"
        )
