"""Test real table listing with MwcToken auth on FMLVWS TestLH."""
import urllib.request
import json
import ssl
import base64
import uuid
from pathlib import Path

raw = Path(".edog-bearer-cache").read_text().strip()
_, bearer = base64.b64decode(raw.encode()).decode().split("|", 1)
ctx = ssl.create_default_context()
META = "https://biazure-int-edog-redirect.analysis-df.windows.net"

WSID = "65e22bd4-92a1-4de6-8bfc-af813eccff3e"  # EDOG_Studio_TestEnv
LHID = "a70c1b89-f2c9-44e0-9a08-f2f955179162"  # EDOG_Test_LH_Schema
CAPID = "dd01a7f3-4198-4439-aae3-4eaf902281bb"

# Generate MWC
body = json.dumps({
    "type": "[Start] GetMWCToken", "workloadType": "Lakehouse",
    "workspaceObjectId": WSID, "artifactObjectIds": [LHID],
    "capacityObjectId": CAPID, "asyncId": str(uuid.uuid4()), "iframeId": str(uuid.uuid4()),
}).encode()
r = urllib.request.Request(
    META + "/metadata/v201606/generatemwctoken", data=body, method="POST",
    headers={"Authorization": "Bearer " + bearer, "Content-Type": "application/json;charset=UTF-8",
             "activityid": str(uuid.uuid4()), "requestid": str(uuid.uuid4()),
             "x-powerbi-hostenv": "Power BI Web App",
             "origin": "https://powerbi-df.analysis-df.windows.net",
             "referer": "https://powerbi-df.analysis-df.windows.net/"})
mwc_data = json.loads(urllib.request.urlopen(r, timeout=30, context=ctx).read().decode())
mwc = mwc_data["Token"]
target = mwc_data["TargetUriHost"]
host = f"https://{target}"
base = f"/webapi/capacities/{CAPID}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{WSID}"

print(f"Host: {host}")
print(f"Auth: MwcToken (not Bearer)")
print()

# Schema-enabled table listing
path = f"{base}/artifacts/DataArtifact/{LHID}/schemas/dbo/tables"
headers = {
    "Authorization": f"MwcToken {mwc}",
    "Content-Type": "application/json",
    "x-ms-workload-resource-moniker": LHID,
}
print("=== Schema-enabled table listing ===")
try:
    r = urllib.request.Request(host + path, headers=headers)
    resp = urllib.request.urlopen(r, timeout=15, context=ctx)
    data = json.loads(resp.read().decode())
    tables = data.get("data", [])
    print(f"OK {resp.status}: {len(tables)} tables")
    for t in tables[:15]:
        name = t.get("name", "?")
        ttype = t.get("type", "?")
        fmt = t.get("format", "?")
        loc = t.get("location", "?")[:60] if t.get("location") else "?"
        print(f"  - {name:30s}  type={ttype:12s}  format={fmt}")
except urllib.error.HTTPError as e:
    print(f"FAIL {e.code}: {e.read().decode()[:200]}")
except Exception as e:
    print(f"ERR: {e}")
