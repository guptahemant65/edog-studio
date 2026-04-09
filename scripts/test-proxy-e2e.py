"""Quick e2e test of the proxy pipeline."""
import urllib.request
import json

BASE = "http://127.0.0.1:5555"


def get(path):
    r = urllib.request.urlopen(BASE + path, timeout=15)
    return json.loads(r.read().decode())


print("=== Workspaces ===")
ws = get("/api/fabric/workspaces")["value"]
print(f"OK: {len(ws)} workspaces")
print(f"Keys: {list(ws[0].keys())}")
fid = next(w["id"] for w in ws if "FMLVWS" in w["displayName"])
print(f"FMLVWS: {fid}")

print("\n=== Items ===")
items = get(f"/api/fabric/workspaces/{fid}/items")["value"]
print(f"OK: {len(items)} items")
if items:
    print(f"Keys: {list(items[0].keys())}")
    for i in items[:6]:
        print(f"  {i['displayName']:20s}  {i['type']:25s}  {i['id'][:12]}")

print("\n=== Lakehouses ===")
lhs = get(f"/api/fabric/workspaces/{fid}/lakehouses")["value"]
print(f"OK: {len(lhs)} lakehouses")
if lhs:
    lh = lhs[0]
    print(f"Keys: {list(lh.keys())}")
    props = lh.get("properties", {})
    print(f"Properties: {list(props.keys())[:6]}")

    print(f"\n=== Tables for {lh['displayName']} ===")
    try:
        tables = get(f"/api/fabric/workspaces/{fid}/lakehouses/{lh['id']}/tables")
        t_list = tables.get("value", tables.get("data", []))
        print(f"OK: {len(t_list)} tables")
        for t in t_list[:5]:
            print(f"  {t}")
    except urllib.error.HTTPError as e:
        err = json.loads(e.read().decode())
        code = err.get("errorCode", "?")
        msg = err.get("message", "?")[:100]
        print(f"FAIL {e.code}: {code} — {msg}")

print("\n=== PATCH rename (same name) ===")
try:
    body = json.dumps({"displayName": "FMLVWS"}).encode()
    req = urllib.request.Request(
        f"{BASE}/api/fabric/workspaces/{fid}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="PATCH",
    )
    r = urllib.request.urlopen(req, timeout=15)
    result = json.loads(r.read().decode())
    print(f"OK: renamed to {result.get('displayName')}")
    print(f"Keys: {list(result.keys())}")
except urllib.error.HTTPError as e:
    print(f"FAIL {e.code}: {e.read().decode()[:200]}")
