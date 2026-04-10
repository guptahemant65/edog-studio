"""Full MWC table listing test across multiple workspaces/lakehouses."""
import base64
import json
import ssl
import urllib.request
import uuid
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
raw = (PROJECT_DIR / ".edog-bearer-cache").read_text().strip()
_, bearer = base64.b64decode(raw.encode()).decode().split("|", 1)
ctx = ssl.create_default_context()
META = "https://biazure-int-edog-redirect.analysis-df.windows.net"


def gen_mwc(ws_id, lh_id, cap_id):
    """Generate MWC token for a specific lakehouse."""
    body = json.dumps({
        "type": "[Start] GetMWCToken", "workloadType": "Lakehouse",
        "workspaceObjectId": ws_id, "artifactObjectIds": [lh_id],
        "capacityObjectId": cap_id, "asyncId": str(uuid.uuid4()), "iframeId": str(uuid.uuid4()),
    }).encode()
    headers = {
        "Authorization": "Bearer " + bearer, "Content-Type": "application/json;charset=UTF-8",
        "activityid": str(uuid.uuid4()), "requestid": str(uuid.uuid4()),
        "x-powerbi-hostenv": "Power BI Web App",
        "origin": "https://powerbi-df.analysis-df.windows.net",
        "referer": "https://powerbi-df.analysis-df.windows.net/",
    }
    r = urllib.request.Request(META + "/metadata/v201606/generatemwctoken", data=body, headers=headers, method="POST")
    data = json.loads(urllib.request.urlopen(r, timeout=30, context=ctx).read().decode())
    return data["Token"], data["TargetUriHost"]


def list_tables_mwc(mwc, target_host, cap_id, ws_id, lh_id, schema="dbo"):
    """List tables via capacity host with MwcToken auth."""
    host = f"https://{target_host}"
    base = f"/webapi/capacities/{cap_id}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{ws_id}"
    path = f"{base}/artifacts/DataArtifact/{lh_id}/schemas/{schema}/tables"
    headers = {
        "Authorization": f"MwcToken {mwc}",
        "Content-Type": "application/json",
        "x-ms-workload-resource-moniker": lh_id,
    }
    r = urllib.request.Request(host + path, headers=headers)
    resp = urllib.request.urlopen(r, timeout=20, context=ctx)
    return json.loads(resp.read().decode())


# ── Test 1: Our test env (schema-enabled, empty) ──
env = json.loads((PROJECT_DIR / "config" / "test-environment.json").read_text())
print("=== Test Environment (EDOG_Studio_TestEnv) ===")
try:
    mwc, host = gen_mwc(env["workspaceId"], env["schemaLakehouseId"], env["capacityId"])
    data = list_tables_mwc(mwc, host, env["capacityId"], env["workspaceId"], env["schemaLakehouseId"])
    tables = data.get("data", [])
    print(f"  EDOG_Test_LH_Schema: OK — {len(tables)} tables")
except Exception as e:
    print(f"  EDOG_Test_LH_Schema: FAIL — {e}")

# ── Test 2: FMLVWS workspaces (real data with tables) ──
print("\n=== Real Workspaces ===")
# Get workspace list to find ones with lakehouses
ws_resp = json.loads(urllib.request.urlopen(
    urllib.request.Request(META + "/metadata/workspaces", headers={"Authorization": "Bearer " + bearer}),
    timeout=15, context=ctx,
).read().decode())

for folder in ws_resp.get("folders", []):
    ws_name = folder.get("displayName", "?")
    ws_id = folder.get("objectId", "")
    cap_id = folder.get("capacityObjectId", "")
    if not ws_id or not cap_id:
        continue

    # Get items to find lakehouses
    try:
        items_resp = json.loads(urllib.request.urlopen(
            urllib.request.Request(META + f"/v1/workspaces/{ws_id}/items",
                                  headers={"Authorization": "Bearer " + bearer, "Content-Type": "application/json"}),
            timeout=15, context=ctx,
        ).read().decode())
    except Exception:
        continue

    lakehouses = [i for i in items_resp.get("value", []) if i.get("type") == "Lakehouse"]
    if not lakehouses:
        continue

    print(f"\n  {ws_name} ({len(lakehouses)} lakehouses)")
    for lh in lakehouses:
        lh_id = lh["id"]
        lh_name = lh["displayName"]
        try:
            mwc, host = gen_mwc(ws_id, lh_id, cap_id)
            data = list_tables_mwc(mwc, host, cap_id, ws_id, lh_id)
            tables = data.get("data", [])
            print(f"    {lh_name}: {len(tables)} tables")
            for t in tables[:10]:
                name = t.get("name", "?")
                ttype = t.get("type", "?")
                fmt = t.get("format", "?")
                print(f"      - {name:35s}  {ttype:12s}  {fmt}")
            if len(tables) > 10:
                print(f"      ... and {len(tables) - 10} more")
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:100]
            print(f"    {lh_name}: FAIL {e.code} — {err}")
        except Exception as e:
            print(f"    {lh_name}: ERR — {e}")

print("\nDone!")
