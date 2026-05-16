"""Fetch vendored third-party assets into scripts/vendor/.

The dev-server serves these locally (see `_serve_vendor_asset` in
dev-server.py) so the FLT swagger viewer stays fully air-gapped — no CDN
beacons, no spec data leaking to third parties.

Files are gitignored. Run `make vendor` after a fresh clone.

Usage:
    python scripts/fetch-vendor.py <asset> [version]

Assets:
    scalar  -- @scalar/api-reference (default version pinned below)
    all     -- fetch every known asset
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

VENDOR_ROOT = Path(__file__).parent / "vendor"

# Each entry: (vendor subdir, output filename template, URL template)
ASSETS: dict[str, tuple[str, str, str, str]] = {
    "scalar": (
        "scalar",
        "api-reference-{version}.js",
        "https://cdn.jsdelivr.net/npm/@scalar/api-reference@{version}",
        "1.57.2",
    ),
}


def fetch(asset: str, version: str | None = None) -> None:
    if asset not in ASSETS:
        known = ", ".join(sorted(ASSETS))
        raise SystemExit(f"Unknown asset '{asset}'. Known: {known}")
    subdir, filename_tpl, url_tpl, default_version = ASSETS[asset]
    v = version or default_version
    out_dir = VENDOR_ROOT / subdir
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / filename_tpl.format(version=v)
    url = url_tpl.format(version=v)

    if out_path.exists():
        size = out_path.stat().st_size
        print(f"[vendor] {asset}@{v} already present ({size:,} bytes) -> {out_path}")
        return

    print(f"[vendor] fetching {asset}@{v} from {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "edog-studio-vendor/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status != 200:
            raise SystemExit(f"[vendor] HTTP {resp.status} fetching {url}")
        data = resp.read()
    out_path.write_bytes(data)
    print(f"[vendor] wrote {len(data):,} bytes -> {out_path}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    asset = argv[1]
    version = argv[2] if len(argv) > 2 else None
    if asset == "all":
        for name in ASSETS:
            fetch(name, None)
    else:
        fetch(asset, version)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
