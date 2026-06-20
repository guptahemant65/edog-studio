from scripts import qa_infra_spec as spec

SCENARIOS = [
    {"infra": {"lakehouses": 1, "tables": ["orders"], "mlvs": 1}},
    {"infra": {"lakehouses": 1, "tables": ["orders", "customers"], "mlvs": 2}},
]
CDF = [
    # Grounded CDFDisabled-warning scenario (verified against FLT): needs
    # FLTMLVWarnings ON, FLTIRDeltaPhysicalCDFEnabled OFF, source CDF off.
    {
        "infra": {
            "lakehouses": 1,
            "tables": ["orders"],
            "mlvs": 1,
            "table_properties": {"orders": {"enableChangeDataFeed": False}},
            "dag_nodes": 4,
        },
        "preconditions": {"flags": {"FLTMLVWarnings": True, "FLTIRDeltaPhysicalCDFEnabled": False}},
    },
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
    have = {
        "lakehouses": 1,
        "tables": ["orders"],
        "mlvs": 1,
        "table_properties": {"orders": {"enableChangeDataFeed": True}},
        "dag_nodes": 4,
    }
    gap = spec.fitness(req, have)
    assert gap["fits"] is False
    assert gap["missing"]["property_mismatch"]["orders"]["enableChangeDataFeed"] is False
