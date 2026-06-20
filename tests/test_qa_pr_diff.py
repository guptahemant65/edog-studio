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
        "Service/Retry/RetryPolicy.cs",
        "Service/Token/TokenManager.cs",
    }


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
        "@@ -1,2 +1,3 @@\n+        if (flights.IsEnabled(FeatureNames.FastMintEnabled)) Mint();\n"
    )
    assert "FastMintEnabled" in set(qa_pr_diff.parse_diff(diff)["feature_flags"])


def test_fetch_uses_injected_client():
    seen = {}
    res = qa_pr_diff.fetch_and_parse(
        "https://dev.azure.com/x/_git/r/pullrequest/982144",
        client=lambda u: seen.update(url=u) or SAMPLE_DIFF,
    )
    assert "pullrequest/982144" in seen["url"] and len(res["files"]) == 2


def test_files_carry_added_removed_counts():
    files = {f["path"]: f for f in qa_pr_diff.parse_diff(SAMPLE_DIFF)["files"]}
    # RetryPolicy: one - and one + line; TokenManager: one + line
    assert files["Service/Retry/RetryPolicy.cs"]["added"] == 1
    assert files["Service/Retry/RetryPolicy.cs"]["removed"] == 1
    assert files["Service/Token/TokenManager.cs"]["added"] == 1
    assert files["Service/Token/TokenManager.cs"]["removed"] == 0


def test_feature_flags_split_introduced_vs_removed():
    diff = (
        "diff --git a/Gating.cs b/Gating.cs\n"
        "--- a/Gating.cs\n+++ b/Gating.cs\n"
        "@@ -1,3 +1,3 @@\n"
        "-        if (flights.IsEnabled(FeatureNames.OldFlag)) A();\n"
        "+        if (flights.IsEnabled(FeatureNames.NewFlag)) B();\n"
    )
    res = qa_pr_diff.parse_diff(diff)
    assert res["feature_flags_added"] == ["NewFlag"]
    assert res["feature_flags_removed"] == ["OldFlag"]
    assert set(res["feature_flags"]) == {"NewFlag", "OldFlag"}


def test_flag_touched_on_both_sides_is_neither_introduced_nor_removed():
    diff = (
        "diff --git a/Gating.cs b/Gating.cs\n"
        "--- a/Gating.cs\n+++ b/Gating.cs\n"
        "@@ -1,2 +1,2 @@\n"
        "-        if (flights.IsEnabled(FeatureNames.Keep)) Old();\n"
        "+        if (flights.IsEnabled(FeatureNames.Keep)) New();\n"
    )
    res = qa_pr_diff.parse_diff(diff)
    assert "Keep" in res["feature_flags"]
    assert res["feature_flags_added"] == [] and res["feature_flags_removed"] == []


# The ADO ado-proxy builds diffs with difflib, which emits "--- a/" / "+++ b/"
# headers but NO "diff --git" line. The parser must key on "+++ b/" so files and
# per-file churn are not silently empty for real PRs.
ADO_PROXY_DIFF = """--- a/Service/Controllers/LiveTableInsightsController.cs
+++ b/Service/Controllers/LiveTableInsightsController.cs
@@ -115,7 +115,7 @@ public class LiveTableInsightsController
-        const int MaxItems = 200;
+        const int MaxItems = 500;
+        public void NewEndpoint() { }
--- a/Service/Trends/InsightsQueryBuilder.cs
+++ b/Service/Trends/InsightsQueryBuilder.cs
@@ -10,3 +10,3 @@ public class InsightsQueryBuilder
-        var old = 1;
"""


def test_parse_ado_proxy_diff_without_diff_git_header():
    res = qa_pr_diff.parse_diff(ADO_PROXY_DIFF)
    files = {f["path"]: f for f in res["files"]}
    assert set(files) == {
        "Service/Controllers/LiveTableInsightsController.cs",
        "Service/Trends/InsightsQueryBuilder.cs",
    }
    # churn is still counted per file even with no "diff --git" line
    assert files["Service/Controllers/LiveTableInsightsController.cs"]["added"] == 2
    assert files["Service/Controllers/LiveTableInsightsController.cs"]["removed"] == 1
    assert files["Service/Trends/InsightsQueryBuilder.cs"]["removed"] == 1
    # symbols/facts still resolve to a file context
    assert ("MaxItems", "500") in {(f["name"], f["value"]) for f in res["config_facts"]}


def test_parse_handles_added_and_deleted_files_via_dev_null():
    diff = (
        "--- /dev/null\n+++ b/Service/NewFile.cs\n@@ -0,0 +1,1 @@\n+        var x = 1;\n"
        "--- a/Service/GoneFile.cs\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-        var y = 2;\n"
    )
    files = {f["path"]: f for f in qa_pr_diff.parse_diff(diff)["files"]}
    assert "Service/NewFile.cs" in files  # new file uses the +++ path
    assert "Service/GoneFile.cs" in files  # deleted file falls back to the --- path
    assert files["Service/NewFile.cs"]["added"] == 1
    assert files["Service/GoneFile.cs"]["removed"] == 1
