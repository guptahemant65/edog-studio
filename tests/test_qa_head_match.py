from scripts import qa_head_match as hm

INJ = {"Service/DevMode/EdogLogInterceptor.cs", "Service/Program.cs"}


def test_match_when_only_injected_differ():
    assert hm.compare(pr_commit="a", deployed_commit="a", dirty_files={"Service/Program.cs"}, injected=INJ)["match"]


def test_mismatch_on_commit():
    r = hm.compare(pr_commit="a", deployed_commit="b", dirty_files=set(), injected=INJ)
    assert not r["match"] and r["reason"] == "commit_mismatch"


def test_mismatch_on_unexpected_dirty():
    r = hm.compare(
        pr_commit="a",
        deployed_commit="a",
        dirty_files={"Service/Retry/RetryPolicy.cs"},
        injected=INJ,
    )
    assert not r["match"] and r["reason"] == "unexpected_dirty"
