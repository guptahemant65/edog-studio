"""One-shot helper: regenerate tests/fixtures/F09/expected_diff.json from
baseline.json + runtime.json. Run only when the fixture intentionally needs
updating (e.g. diff schema evolves). Snapshot test asserts byte-equality.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "scripts"))

from swagger_diff_assemble import build_diff_payload  # noqa: E402
from swagger_normalize import normalize  # noqa: E402

FIXTURE_DIR = _ROOT / "tests" / "fixtures" / "F09"


def main() -> None:
    baseline = json.loads((FIXTURE_DIR / "baseline.json").read_text())
    runtime = json.loads((FIXTURE_DIR / "runtime.json").read_text())
    payload = build_diff_payload(normalize(baseline), normalize(runtime))
    out_path = FIXTURE_DIR / "expected_diff.json"
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"  totalChanges: {payload['summary']['totalChanges']}")
    for ch in payload["changes"]:
        sub = len(ch.get("subChanges", [])) if "subChanges" in ch else 0
        print(f"  {ch['id']} {ch['type']:8} {ch['category']:9} {ch['key']} (sub={sub})")


if __name__ == "__main__":
    main()
