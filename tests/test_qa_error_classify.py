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
