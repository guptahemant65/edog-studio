"""Test F01 APIs against FMLVWS workspace with real lakehouses."""
import json
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:5555"

# Get workspaces
resp = urllib.request.urlopen(BASE + "/api/fabric/workspaces?%24top=100", timeout=10)
ws_list = json.loads(resp.read())["value"]

# Find FMLVWS
fmlvws = next((w for w in ws_list if w["displayName"] == "FMLVWS"), None)
if not fmlvws:
    print("FMLVWS not found. Available:", [w["displayName"] for w in ws_list])
    exit()

ws_id = fmlvws["id"]
cap_id = fmlvws.get("capacityId", "")
print(f"FMLVWS: ws={ws_id} cap={cap_id}")

# List items
resp = urllib.request.urlopen(BASE + f"/api/fabric/workspaces/{ws_id}/items", timeout=10)
items = json.loads(resp.read())["value"]
print(f"Items: {len(items)}")
for i in items[:10]:
    itype = i.get("type", "?")
    iname = i.get("displayName", "?")
    print(f"  {itype:15s} {iname}")

# Find lakehouse
lh = next((i for i in items if i["type"] == "Lakehouse"), None)
if not lh:
    print("No lakehouse found")
    exit()

lh_id = lh["id"]
lh_name = lh["displayName"]
print(f"\nLakehouse: {lh_name} ({lh_id})")

# Test 1: Public API tables
print("\n--- Public API tables ---")
try:
    resp = urllib.request.urlopen(
        BASE + f"/api/fabric/workspaces/{ws_id}/lakehouses/{lh_id}/tables", timeout=10)
    tables = json.loads(resp.read())
    count = len(tables.get("value", tables.get("data", [])))
    print(f"OK 200: {count} tables")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code} (expected 400 for schema-enabled)")

# Test 2: MWC tables
print("\n--- MWC tables ---")
tables = []
if cap_id:
    try:
        resp = urllib.request.urlopen(
            BASE + f"/api/mwc/tables?wsId={ws_id}&lhId={lh_id}&capId={cap_id}", timeout=20)
        mwc = json.loads(resp.read())
        tables = mwc.get("data", [])
        print(f"OK 200: {len(tables)} tables")
        for t in tables[:5]:
            print(f"  - {t.get('name', t)}")
        if len(tables) > 5:
            print(f"  ... +{len(tables) - 5} more")
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        print(f"FAIL {e.code}: {body}")
    except Exception as e:
        print(f"ERR: {e}")
else:
    print("SKIP — no capacityId")

# Test 3: Batch table details
print("\n--- Batch table details ---")
if tables and cap_id:
    names = [t.get("name") for t in tables[:3]]
    print(f"Testing with: {names}")
    try:
        req = urllib.request.Request(
            BASE + "/api/mwc/table-details",
            data=json.dumps({
                "wsId": ws_id, "lhId": lh_id, "capId": cap_id, "tables": names
            }).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=30)
        result = json.loads(resp.read())
        print(f"OK 200 — keys: {list(result.keys())}")
        if "value" in result:
            for v in result["value"]:
                r = v.get("result", {})
                tname = v.get("tableName", "?")
                ttype = r.get("type", "?")
                cols = len(r.get("schema", []))
                loc = r.get("location", "")[:60]
                print(f"  {tname}: type={ttype}, {cols} cols, loc={loc}...")
        else:
            print(f"  Response: {json.dumps(result)[:300]}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        print(f"FAIL {e.code}: {body}")
    except Exception as e:
        print(f"ERR: {e}")
else:
    print("SKIP — no tables or no capacityId")

# Test 4: MWC token generation
print("\n--- MWC token generation ---")
if cap_id:
    try:
        req = urllib.request.Request(
            BASE + "/api/edog/mwc-token",
            data=json.dumps({
                "workspaceId": ws_id, "lakehouseId": lh_id, "capacityId": cap_id
            }).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=20)
        result = json.loads(resp.read())
        token = result.get("token", "")
        host = result.get("host", "")
        print(f"OK 200 — token: {len(token)} chars, host: {host}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        print(f"FAIL {e.code}: {body}")
else:
    print("SKIP — no capacityId")

print("\n=== DONE ===")
