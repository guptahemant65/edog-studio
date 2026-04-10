"""Test MWC table APIs on real fmlv-poc workspace with actual tables."""
import base64
import json
import ssl
import time
import urllib.request
import uuid
from pathlib import Path

raw = Path(".edog-bearer-cache").read_text().strip()
_, bearer = base64.b64decode(raw.encode()).decode().split("|", 1)
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
META = "https://biazure-int-edog-redirect.analysis-df.windows.net"

WSID = "c40147b5-d369-407b-b5c0-7b080fb929bd"  # FMLVWS
CAPID = "dd01a7f3-4198-4439-aae3-4eaf902281bb"

def call(method, url, headers, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=30, context=ctx)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        txt = e.read().decode()[:500]
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, {"raw": txt}

# Step 1: List lakehouses
print("=== Step 1: List lakehouses in fmlv-poc ===")
s, lhs = call("GET", f"{META}/v1/workspaces/{WSID}/lakehouses", {"Authorization": f"Bearer {bearer}"})
for lh in lhs.get("value", []):
    print(f"  {lh['displayName']}: {lh['id']}")

LHID = lhs["value"][0]["id"]
LH_NAME = lhs["value"][0]["displayName"]
print(f"\nUsing: {LH_NAME} ({LHID})")

# Step 2: Generate MWC token
print("\n=== Step 2: Generate MWC token ===")
s, mwc_data = call("POST", f"{META}/metadata/v201606/generatemwctoken", {
    "Authorization": f"Bearer {bearer}", "Content-Type": "application/json"
}, {
    "type": "[Start] GetMWCToken", "workloadType": "Lakehouse",
    "workspaceObjectId": WSID, "artifactObjectIds": [LHID], "capacityObjectId": CAPID
})
mwc = mwc_data["Token"]
host = f"https://{mwc_data['TargetUriHost']}"
base = f"/webapi/capacities/{CAPID}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{WSID}"
print(f"  MWC: {mwc[:40]}...")
print(f"  Host: {host}")

mwc_headers = {
    "Authorization": f"MwcToken {mwc}",
    "x-ms-workload-resource-moniker": LHID,
    "Content-Type": "application/json",
}

# Step 3: List tables via schemas/dbo/tables
print("\n=== Step 3: schemas/dbo/tables (list) ===")
s, data = call("GET", f"{host}{base}/artifacts/DataArtifact/{LHID}/schemas/dbo/tables", mwc_headers)
tables = data.get("data", [])
print(f"  Status: {s} — {len(tables)} tables")
for t in tables[:10]:
    print(f"    - {t.get('name', t)}")
if len(tables) > 10:
    print(f"    ... +{len(tables)-10} more")

# Step 4: getTableDetails (single table, LRO)
if tables:
    tname = tables[0].get("name", tables[0])
    print(f"\n=== Step 4: getTableDetails (table: {tname}) ===")
    s, op = call("POST", f"{host}{base}/artifacts/DataArtifact/{LHID}/getTableDetails", {
        **mwc_headers, "x-ms-lakehouse-client-session-id": str(uuid.uuid4())
    }, {"relativePath": f"Tables/dbo/{tname}"})
    print(f"  Status: {s}")

    if s == 202:
        op_id = op.get("operationId", "")
        print(f"  operationId: {op_id}")
        for i in range(15):
            time.sleep(1)
            ps, pd = call("GET", f"{host}{base}/artifacts/DataArtifact/{LHID}/getTableDetails/operationResults/{op_id}", mwc_headers)
            st = pd.get("status", str(ps))
            if st in ("completed", "Succeeded"):
                result = pd.get("result", pd)
                print(f"  DONE — full response: {json.dumps(pd)[:600]}")
                break
            print(f"  Poll {i+1}: {st} — keys: {list(pd.keys())}")
        else:
            print("  TIMEOUT")
    else:
        print(f"  Response: {json.dumps(op)[:300]}")

# Step 5: batchGetTableDetails
if len(tables) >= 2:
    batch = [t.get("name") for t in tables[:3]]
    print(f"\n=== Step 5: batchGetTableDetails ({batch}) ===")
    s, op = call("POST", f"{host}{base}/artifacts/DataArtifact/{LHID}/schemas/dbo/batchGetTableDetails", mwc_headers, {"tables": batch})
    print(f"  Status: {s}")

    if s == 202:
        op_id = op.get("operationId", "")
        for i in range(15):
            time.sleep(1)
            ps, pd = call("GET", f"{host}{base}/artifacts/DataArtifact/{LHID}/schemas/dbo/batchGetTableDetails/operationResults/{op_id}", mwc_headers)
            if pd.get("status") in ("completed", "Succeeded"):
                result = pd.get("result", pd)
                print(f"  COMPLETED — result: {json.dumps(result)[:500]}")
                break
            print(f"  Poll {i+1}: {pd.get('status', ps)}")
        else:
            print("  TIMEOUT")
    else:
        print(f"  Response: {json.dumps(op)[:300]}")

print("\n=== DONE ===")
