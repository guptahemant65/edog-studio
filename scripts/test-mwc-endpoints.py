"""Test MWC token generation + schema-enabled table listing + DAG endpoints."""
import urllib.request
import json
import ssl
import base64
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
raw = (PROJECT_DIR / ".edog-bearer-cache").read_text().strip()
_, bearer = base64.b64decode(raw.encode()).decode().split("|", 1)
ctx = ssl.create_default_context()
META = "https://biazure-int-edog-redirect.analysis-df.windows.net"
env = json.loads((PROJECT_DIR / "config" / "test-environment.json").read_text())
WSID = env["workspaceId"]
CAPID = env["capacityId"]
LHID = env["lakehouseId"]
SCHEMA_LHID = env["schemaLakehouseId"]


def req(method, url, token, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return urllib.request.urlopen(r, timeout=30, context=ctx)


# Step 1: Generate MWC token
print("=== 1. Generate MWC Token ===")
mwc_resp = json.loads(req("POST", META + "/metadata/v201606/generatemwctoken", bearer, body={
    "type": "[Start] GetMWCToken",
    "workloadType": "Lakehouse",
    "workspaceObjectId": WSID,
    "artifactObjectIds": [SCHEMA_LHID],
    "capacityObjectId": CAPID,
}).read().decode())

mwc = mwc_resp["Token"]
target_host = mwc_resp["TargetUriHost"]
print(f"  Token: {len(mwc)} chars")
print(f"  Host:  {target_host}")
print(f"  Expiry: {mwc_resp['Expiration']}")

cap_host = f"https://{target_host}"
base = f"/webapi/capacities/{CAPID}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{WSID}"


def test_cap(label, path, token=mwc):
    url = cap_host + path
    try:
        resp = req("GET", url, token)
        data = resp.read().decode()
        parsed = json.loads(data) if data.strip() else {}
        if isinstance(parsed, list):
            summary = f"[{len(parsed)} items]"
        elif isinstance(parsed, dict):
            summary = str(list(parsed.keys())[:5])
        else:
            summary = data[:80]
        print(f"  OK  200 | {label:<50} | {summary}")
        return parsed
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:120]
        print(f"  FAIL {e.code:>3} | {label:<50} | {err}")
        return None
    except Exception as e:
        print(f"  ERR      | {label:<50} | {e}")
        return None


# Step 2: Schema-enabled table listing
print(f"\n=== 2. Table Listing (capacity host, MWC token) ===")
print(f"  Capacity host: {cap_host}")
test_cap("Schema LH tables (DataArtifact/dbo)", f"{base}/artifacts/DataArtifact/{SCHEMA_LHID}/schemas/dbo/tables")
test_cap("Non-schema LH tables (Lakehouse)", f"{base}/artifacts/Lakehouse/{LHID}/tables")

# Also try the public-style tables path via capacity host
test_cap("Schema LH via public path (expect 400)", f"{base}/lakehouses/{SCHEMA_LHID}/tables")

# Step 3: DAG endpoints
print(f"\n=== 3. DAG Endpoints (capacity host, MWC token) ===")
lt_base = f"{base}/lakehouses/{SCHEMA_LHID}/liveTable"
test_cap("Get latest DAG", f"{lt_base}/getLatestDag?showExtendedLineage=true")
test_cap("DAG settings", f"{lt_base}/settings")
test_cap("List iteration IDs", f"{lt_base}/listDAGExecutionIterationIds")
test_cap("MLV execution definitions", f"{lt_base}/mlvExecutionDefinitions")

# Step 4: Maintenance endpoints
print(f"\n=== 4. Maintenance Endpoints (capacity host, MWC token) ===")
maint_base = lt_base.replace("/liveTable", "/liveTableMaintenance")
test_cap("Get locked DAG execution", f"{maint_base}/getLockedDAGExecutionIteration")
test_cap("List orphaned folders", f"{maint_base}/listOrphanedIndexFolders")

# Step 5: Ping (no auth)
print(f"\n=== 5. Service Health ===")
ping_path = f"/webapi/capacities/{CAPID}/workloads/LiveTable/LiveTableService/automatic/publicUnprotected/ping"
try:
    r = urllib.request.Request(cap_host + ping_path)
    resp = urllib.request.urlopen(r, timeout=10, context=ctx)
    print(f"  OK  {resp.status} | Ping (no auth)                                     | {resp.read().decode()[:50]}")
except Exception as e:
    print(f"  FAIL     | Ping (no auth)                                     | {e}")

print("\nDone!")
