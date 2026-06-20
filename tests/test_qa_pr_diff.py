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
