"""Test ALL F01 API endpoints end-to-end via dev-server proxy."""
import json
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:5555"
results = []


def test(label, method, path, body=None, expect_status=200):
    """Test a single endpoint."""
    url = BASE + path
    headers = {"Content-Type": "application/json"}
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    start = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        elapsed = int((time.time() - start) * 1000)
        body_text = resp.read().decode()
        try:
            parsed = json.loads(body_text)
        except Exception:
            parsed = body_text[:200]
        status = resp.status
        ok = status == expect_status
        summary = ""
        if isinstance(parsed, dict):
            if "value" in parsed:
                summary = f"{len(parsed['value'])} items"
            elif "data" in parsed:
                summary = f"{len(parsed['data'])} items"
            elif "token" in parsed:
                summary = f"token {len(parsed.get('token',''))} chars"
            else:
                summary = f"keys: {list(parsed.keys())[:5]}"
        elif isinstance(parsed, list):
            summary = f"{len(parsed)} items"
        else:
            summary = str(parsed)[:100]

        icon = "OK" if ok else "UNEXPECTED"
        print(f"  [{icon}] {status} {method} {path} ({elapsed}ms) — {summary}")
        results.append((label, ok, status, elapsed, summary))
        return parsed
    except urllib.error.HTTPError as e:
        elapsed = int((time.time() - start) * 1000)
        body_text = e.read().decode()[:300] if e.readable() else ""
        ok = e.code == expect_status
        icon = "OK" if ok else "FAIL"
        print(f"  [{icon}] {e.code} {method} {path} ({elapsed}ms) — {body_text[:150]}")
        results.append((label, ok, e.code, elapsed, body_text[:150]))
        return None
    except Exception as e:
        elapsed = int((time.time() - start) * 1000)
        print(f"  [ERR] {method} {path} ({elapsed}ms) — {e}")
        results.append((label, False, 0, elapsed, str(e)))
        return None


print("=" * 60)
print("F01 API TEST SUITE")
print("=" * 60)

# --- 1. Health ---
print("\n--- Health & Config ---")
test("health", "GET", "/api/edog/health")
config = test("config", "GET", "/api/flt/config")

# --- 2. Workspace listing ---
print("\n--- Workspace Listing ---")
ws_data = test("list-workspaces", "GET", "/api/fabric/workspaces?$top=100")

if ws_data and ws_data.get("value"):
    ws = ws_data["value"][0]
    ws_id = ws.get("id", "")
    ws_name = ws.get("displayName", "?")
    cap_id = ws.get("capacityId", "")
    print(f"  Using workspace: {ws_name} ({ws_id}), cap: {cap_id}")

    # --- 3. Workspace items ---
    print("\n--- Workspace Items ---")
    items = test("list-items", "GET", f"/api/fabric/workspaces/{ws_id}/items")

    # Find a lakehouse
    lh = None
    if items and items.get("value"):
        for item in items["value"]:
            if item.get("type") == "Lakehouse":
                lh = item
                break

    if lh:
        lh_id = lh["id"]
        lh_name = lh["displayName"]
        print(f"  Using lakehouse: {lh_name} ({lh_id})")

        # --- 4. Table listing (public API — may 400 for schema-enabled) ---
        print("\n--- Table Listing (Public API) ---")
        tables = test("list-tables-public", "GET",
                       f"/api/fabric/workspaces/{ws_id}/lakehouses/{lh_id}/tables")

        # --- 5. Table listing (MWC capacity host) ---
        print("\n--- Table Listing (MWC Capacity Host) ---")
        if cap_id:
            mwc_tables = test("list-tables-mwc", "GET",
                              f"/api/mwc/tables?wsId={ws_id}&lhId={lh_id}&capId={cap_id}")
        else:
            print("  [SKIP] No capacityId — cannot test MWC tables")

        # --- 6. MWC Token generation ---
        print("\n--- MWC Token Generation ---")
        if cap_id:
            mwc_token = test("generate-mwc", "POST", "/api/edog/mwc-token",
                             body={"workspaceId": ws_id, "lakehouseId": lh_id, "capacityId": cap_id})
        else:
            print("  [SKIP] No capacityId")

        # --- 7. Batch table details ---
        print("\n--- Batch Table Details ---")
        if cap_id and mwc_tables and mwc_tables.get("data"):
            table_names = [t["name"] for t in mwc_tables["data"][:3]]
            print(f"  Testing with tables: {table_names}")
            details = test("batch-table-details", "POST", "/api/mwc/table-details",
                           body={"wsId": ws_id, "lhId": lh_id, "capId": cap_id, "tables": table_names})
        elif cap_id:
            print("  [SKIP] No tables from MWC listing")
        else:
            print("  [SKIP] No capacityId")

    else:
        print("  [SKIP] No lakehouse found in workspace")

    # --- 8. Lakehouses listing ---
    print("\n--- Lakehouse Listing ---")
    test("list-lakehouses", "GET", f"/api/fabric/workspaces/{ws_id}/lakehouses")

else:
    print("  [SKIP] No workspaces returned")

# --- 9. Certs ---
print("\n--- Auth & Certs ---")
test("list-certs", "GET", "/api/edog/certs")

# --- Summary ---
print("\n" + "=" * 60)
passed = sum(1 for _, ok, *_ in results if ok)
failed = sum(1 for _, ok, *_ in results if not ok)
print(f"RESULTS: {passed} passed, {failed} failed, {len(results)} total")
if failed:
    print("\nFAILED:")
    for label, ok, status, elapsed, summary in results:
        if not ok:
            print(f"  ✗ {label}: {status} — {summary}")
print("=" * 60)
