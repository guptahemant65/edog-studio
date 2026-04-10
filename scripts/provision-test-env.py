"""Provision EDOG Studio test environment — workspace, lakehouse, tables.

Creates isolated test infra for API endpoint testing. Does NOT touch existing resources.
Uses the redirect host with PBI bearer token.
"""
import base64
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
BEARER_CACHE = PROJECT_DIR / ".edog-bearer-cache"
REDIRECT_HOST = "https://biazure-int-edog-redirect.analysis-df.windows.net"

# Capacity from the devmode config in LiveTableInfraDetails.json
CAPACITY_ID = "dd01a7f3-4198-4439-aae3-4eaf902281bb"

ENV_FILE = PROJECT_DIR / "config" / "test-environment.json"

ctx = ssl.create_default_context()


def _get_bearer() -> str:
    raw = BEARER_CACHE.read_text().strip()
    decoded = base64.b64decode(raw.encode()).decode()
    _, token = decoded.split("|", 1)
    return token


def _request(method: str, path: str, body: dict | None = None, bearer: str = "") -> dict:
    """Make an authenticated request to the redirect host."""
    url = REDIRECT_HOST + path
    data = json.dumps(body).encode() if body else None
    headers = {
        "Authorization": f"Bearer {bearer}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=30, context=ctx)
        raw = resp.read().decode()
        return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f"  HTTP {e.code}: {error_body[:300]}")
        raise


def main():
    if not BEARER_CACHE.exists():
        print("No bearer token cached. Run bearer auth first.")
        sys.exit(1)

    bearer = _get_bearer()
    print("EDOG Test Environment Provisioner")
    print("=" * 60)
    print(f"Host:     {REDIRECT_HOST}")
    print(f"Capacity: {CAPACITY_ID}")
    print()

    # Check if we already have a test environment
    if ENV_FILE.exists():
        env = json.loads(ENV_FILE.read_text())
        print("Existing test environment found:")
        print(f"  Workspace: {env.get('workspaceName')} ({env.get('workspaceId', '')[:12]}...)")
        print(f"  Lakehouse: {env.get('lakehouseName')} ({env.get('lakehouseId', '')[:12]}...)")
        resp = input("Re-use existing? [Y/n] ").strip().lower()
        if resp != "n":
            print("Using existing environment.")
            return

    ws_name = "EDOG_Studio_TestEnv"
    lh_name = "EDOG_Test_LH"

    # ── Step 1: Check if workspace already exists ──
    print("\n[1/4] Checking for existing workspace...")
    ws_list = _request("GET", "/metadata/workspaces", bearer=bearer)
    existing_ws = None
    for f in ws_list.get("folders", []):
        if f.get("displayName") == ws_name:
            existing_ws = f
            break

    if existing_ws:
        ws_id = existing_ws["objectId"]
        print(f"  Found existing: {ws_name} ({ws_id[:12]}...)")
    else:
        print(f"  Creating workspace: {ws_name}")
        result = _request("POST", "/metadata/folders", body={
            "capacityObjectId": CAPACITY_ID,
            "displayName": ws_name,
            "description": "Auto-provisioned by EDOG Studio for API testing. Safe to delete.",
            "isServiceApp": False,
            "datasetStorageMode": 1,
        }, bearer=bearer)
        ws_id = result.get("objectId", result.get("id", ""))
        if not ws_id:
            print(f"  ERROR: No workspace ID in response: {json.dumps(result)[:300]}")
            sys.exit(1)
        print(f"  Created: {ws_id}")

    # ── Step 2: Check if lakehouse exists ──
    print("\n[2/4] Checking for existing lakehouse...")
    items = _request("GET", f"/v1/workspaces/{ws_id}/items", bearer=bearer)
    existing_lh = None
    for item in items.get("value", []):
        if item.get("displayName") == lh_name and item.get("type") == "Lakehouse":
            existing_lh = item
            break

    if existing_lh:
        lh_id = existing_lh["id"]
        print(f"  Found existing: {lh_name} ({lh_id[:12]}...)")
    else:
        print(f"  Creating lakehouse: {lh_name} (WITHOUT schemas for table listing)")
        # Create via v1 public API — creates lakehouse without schemas by default
        result = _request("POST", f"/v1/workspaces/{ws_id}/lakehouses", body={
            "displayName": lh_name,
            "description": "EDOG Studio test lakehouse. Safe to delete.",
        }, bearer=bearer)
        lh_id = result.get("id", "")
        if not lh_id:
            print(f"  ERROR: No lakehouse ID in response: {json.dumps(result)[:300]}")
            sys.exit(1)
        print(f"  Created: {lh_id}")
        print("  Waiting 10s for provisioning...")
        time.sleep(10)

    # ── Step 3: Test table listing ──
    print("\n[3/4] Testing table listing...")
    try:
        tables_resp = _request("GET", f"/v1/workspaces/{ws_id}/lakehouses/{lh_id}/tables", bearer=bearer)
        tables = tables_resp.get("value", tables_resp.get("data", []))
        print(f"  Tables endpoint works! {len(tables)} tables found.")
        for t in tables[:5]:
            print(f"    - {t.get('name', t.get('displayName', '?'))}")
    except urllib.error.HTTPError as e:
        if e.code == 400:
            err = json.loads(e.read().decode() if hasattr(e, 'read') else '{}')
            ec = err.get("errorCode", "?")
            if "Schemas" in ec:
                print("  Tables endpoint returned 400 (schemas enabled) — this lakehouse has schemas.")
                print("  This is a known issue. Tables listing works only for non-schema lakehouses.")
            else:
                print(f"  Tables endpoint returned 400: {ec}")
        else:
            print(f"  Tables endpoint failed: {e.code}")

    # ── Step 4: Get lakehouse details ──
    print("\n[4/4] Getting lakehouse details...")
    try:
        lh_details = _request("GET", f"/v1/workspaces/{ws_id}/lakehouses/{lh_id}", bearer=bearer)
        props = lh_details.get("properties", {})
        print(f"  oneLakeTablesPath: {props.get('oneLakeTablesPath', 'N/A')[:80]}")
        print(f"  oneLakeFilesPath:  {props.get('oneLakeFilesPath', 'N/A')[:80]}")
        sql_props = props.get("sqlEndpointProperties", {})
        print(f"  SQL endpoint:      {sql_props.get('connectionString', 'N/A')[:80]}")
        print(f"  Default schema:    {props.get('defaultSchema', 'N/A')}")
    except Exception as e:
        print(f"  Could not get details: {e}")

    # ── Save environment config ──
    env = {
        "workspaceId": ws_id,
        "workspaceName": ws_name,
        "lakehouseId": lh_id,
        "lakehouseName": lh_name,
        "capacityId": CAPACITY_ID,
        "redirectHost": REDIRECT_HOST,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": "Auto-provisioned by EDOG Studio. Safe to delete.",
    }
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    ENV_FILE.write_text(json.dumps(env, indent=2))
    print(f"\nEnvironment saved to: {ENV_FILE}")
    print(json.dumps(env, indent=2))
    print("\nDone!")


if __name__ == "__main__":
    main()
