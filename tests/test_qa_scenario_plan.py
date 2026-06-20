from scripts import qa_scenario_plan as sp


def test_no_features_yields_no_scenarios():
    # nothing with a runtime/contract surface -> honestly no scenarios, not a template
    assert sp.derive([]) == []
    assert sp.case_count(sp.derive([])) == 0


def test_count_emerges_from_the_change_small_change_few_cases():
    plan = sp.derive([{"feature": "default_changed", "endpoint": "cards",
                        "param": "state", "to": "Active", "alts": ["Resolved"]}])
    assert [c["name"] for c in plan] == ["Default behaviour"]  # m = 1
    assert sp.case_count(plan) == 1  # n = 1


def test_param_enum_added_auto_includes_regression_guard_and_limit():
    plan = sp.derive([{
        "feature": "param_enum_added", "endpoint": "summary", "param": "statuses",
        "added": ["running"], "cap": 200, "is_list": True,
        "also_on": ["runs", "trends", "errors/top"],
    }])
    names = [c["name"] for c in plan]
    # adding to an allow-set MUST pull in the "still rejected" guard and the cap
    assert "Newly accepted input" in names
    assert "Input still rejected" in names
    assert "Limits" in names
    # representative sampling: the sibling endpoints are named as covered, not duplicated
    accept = next(c for c in plan if c["name"] == "Newly accepted input")
    assert any("runs" in (case.get("note") or "") for case in accept["cases"])


def test_dto_breaking_makes_contract_category_and_runtime_cap_case():
    plan = sp.derive([{"feature": "dto_breaking", "type": "InsightCardResponse",
                        "detail": "relatedIterationId -> relatedIterationIds", "cap": 500}])
    assert [c["name"] for c in plan] == ["API contract"]
    assert sp.case_count(plan) == 2  # the diff + the best-effort runtime cap


def test_flags_collapse_to_one_category_but_n_grows():
    plan = sp.derive([{"feature": "flag", "name": "A"}, {"feature": "flag", "name": "B"}])
    assert len(plan) == 1 and plan[0]["name"] == "Feature flag"  # m collapses by category
    assert sp.case_count(plan) == 2  # n = one ON/OFF case per flag


def test_auth_posture_is_detect_only_security():
    plan = sp.derive([{"feature": "auth_posture", "detail": "controller base changed"}])
    assert plan[0]["name"].startswith("Security")
    assert plan[0]["cases"][0]["detect_only"] is True


def test_mlv_write_yields_data_correctness():
    plan = sp.derive([{"feature": "mlv_write", "table": "sales_summary"}])
    assert plan[0]["name"] == "Data correctness"
    assert "sales_summary" in plan[0]["cases"][0]["title"]


def test_categories_are_priority_ordered_contract_first():
    plan = sp.derive([
        {"feature": "flag", "name": "X"},
        {"feature": "dto_breaking", "type": "T", "detail": "d"},
    ])
    assert next(c["name"] for c in plan) == "API contract"  # cheapest+highest-value leads


def test_every_case_carries_an_input_class_for_coverage_audit():
    plan = sp.derive([{
        "feature": "param_enum_added", "endpoint": "summary", "param": "statuses",
        "added": ["running"], "cap": 200, "is_list": True,
    }])
    classes = {case["input_class"] for c in plan for case in c["cases"]}
    # the change must exercise these distinct classes, not just the happy path
    assert {"newly-allowed", "differential", "multi-value", "negative", "message", "boundary-over"} <= classes


def test_full_change_count_is_derived_not_chosen():
    # PR #1008944's three change-features -> a count that falls out, reproducibly
    feats = [
        {"feature": "param_enum_added", "endpoint": "summary", "param": "statuses",
         "added": ["running"], "cap": 200, "is_list": True, "also_on": ["runs", "trends", "errors/top"]},
        {"feature": "default_changed", "endpoint": "cards", "param": "state", "to": "Active", "alts": ["Resolved"]},
        {"feature": "dto_breaking", "type": "InsightCardResponse",
         "detail": "relatedIterationId -> relatedIterationIds (Guid -> List<Guid>)", "cap": 500},
    ]
    plan = sp.derive(feats)
    assert len(plan) == 5  # m
    assert sp.case_count(plan) == 9  # n — derived, identical on every run
