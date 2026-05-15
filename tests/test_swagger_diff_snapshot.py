"""SF-020: end-to-end snapshot test for the swagger diff pipeline.

Guards against accidental drift in any of the five modules that compose
the diff payload:

    swagger_normalize -> swagger_diff_paths
                      -> swagger_diff_operation
                      -> swagger_diff_schemas
                      -> swagger_diff_assemble

Fixture pair: tests/fixtures/F09/{baseline,runtime}.json — a small but
representative OpenAPI 3.0 pair that exercises every cell of the matrix
(added/modified/removed x endpoints/schemas) and the major sub-change
kinds (parameter-added, response-added, metadata-changed, property-added,
required-changed).

Regenerate intentionally with: ``python scripts/regen_swagger_diff_fixture.py``.
Failure here means either a real diff bug OR an intentional shape change —
review the fixture diff in the PR before regenerating.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS_DIR = _ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from swagger_diff_assemble import build_diff_payload  # noqa: E402
from swagger_normalize import normalize  # noqa: E402

FIXTURE_DIR = _ROOT / "tests" / "fixtures" / "F09"


def _load(name: str) -> dict:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def test_full_pipeline_matches_frozen_snapshot():
    """The assembled diff payload must equal the committed fixture byte-for-byte
    after JSON round-trip. If you intentionally changed the diff shape,
    re-run scripts/regen_swagger_diff_fixture.py and review the fixture diff."""
    baseline = _load("baseline.json")
    runtime = _load("runtime.json")
    expected = _load("expected_diff.json")

    actual = build_diff_payload(normalize(baseline), normalize(runtime))

    # Round-trip both through JSON to neutralize tuple/list quirks.
    assert json.loads(json.dumps(actual)) == expected


def test_snapshot_covers_every_matrix_cell():
    """Sanity: the fixture must keep exercising the full 2x3 category/type
    matrix. If someone trims it down we lose coverage silently."""
    expected = _load("expected_diff.json")
    cells = {(c["category"], c["type"]) for c in expected["changes"]}
    for cat in ("endpoints", "schemas"):
        for typ in ("added", "removed", "modified"):
            assert (cat, typ) in cells, (
                f"snapshot fixture lost coverage for {cat}/{typ} — "
                f"add a representative change back to baseline/runtime.json"
            )


def test_snapshot_ids_are_lexically_sortable():
    """ch-NNN ids must zero-pad so lexical sort == insertion order. Guards
    the assemble layer's id-generation contract that the frontend relies on
    when grouping changes."""
    expected = _load("expected_diff.json")
    ids = [c["id"] for c in expected["changes"]]
    assert ids == sorted(ids), f"change ids not lexically sorted: {ids}"
    for cid in ids:
        assert cid.startswith("ch-")
        suffix = cid.split("-", 1)[1]
        assert suffix.isdigit() and len(suffix) >= 3, f"id not zero-padded: {cid}"


def test_snapshot_exercises_modified_subchanges():
    """The "modified" leaves must carry subChanges — otherwise we're not
    actually validating the operation/schema diff walkers."""
    expected = _load("expected_diff.json")
    modified = [c for c in expected["changes"] if c["type"] == "modified"]
    assert modified, "snapshot has no modified entries"
    for ch in modified:
        assert "subChanges" in ch and len(ch["subChanges"]) > 0, (
            f"modified change {ch['id']} ({ch['key']}) has no subChanges"
        )
