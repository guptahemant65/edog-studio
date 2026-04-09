"""Test remaining untested APIs: rename, capacity, batchTableDetails, schedules.

Covers:
1. Rename operations (workspace, lakehouse, items)
2. Capacity APIs (list, details, workspaces on capacity, throttling)
3. batchGetTableDetails (fix 400)
4. Schedule CRUD
5. getTableDetails + preview result polling
"""
import urllib.request
import json
import ssl
import base64
import uuid
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
raw = (PROJECT_DIR / ".edog-bearer-cache").read_text().strip()
_, BEARER = base64.b64decode(raw.encode()).decode().split("|", 1)
CTX = ssl.create_default_context()
META = "https://biazure-int-edog-redirect.analysis-df.windows.net"

env = json.loads((PROJECT_DIR / "config" / "test-environment.json").read_text())
TEST_WSID = env["workspaceId"]
TEST_LHID = env["schemaLakehouseId"]
CAPID = env["capacityId"]

FMLV_WSID = "c40147b5-d369-407b-b5c0-7b080fb929bd"
FMLV_LHID = "a96fdc44-a514-4abf-b73b-e691d3022500"

results = []


def bearer(method, path, body=None):
    url = META + path
    data = json.dumps(body).encode() if body else None
    h = {"Authorization": f"Bearer {BEARER}", "Content-Type": "application/json;charset=UTF-8",
         "activityid": str(uuid.uuid4()), "requestid": str(uuid.uuid4())}
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    return urllib.request.urlopen(r, timeout=30, context=CTX)


def gen_mwc(ws_id, lh_id, cap_id):
    body = json.dumps({
        "type": "[Start] GetMWCToken", "workloadType": "Lakehouse",
        "workspaceObjectId": ws_id, "artifactObjectIds": [lh_id],
        "capacityObjectId": cap_id, "asyncId": str(uuid.uuid4()), "iframeId": str(uuid.uuid4()),
    }).encode()
    h = {"Authorization": f"Bearer {BEARER}", "Content-Type": "application/json;charset=UTF-8",
         "activityid": str(uuid.uuid4()), "requestid": str(uuid.uuid4()),
         "x-powerbi-hostenv": "Power BI Web App",
         "origin": "https://powerbi-df.analysis-df.windows.net",
         "referer": "https://powerbi-df.analysis-df.windows.net/"}
    r = urllib.request.Request(META + "/metadata/v201606/generatemwctoken", data=body, headers=h, method="POST")
    d = json.loads(urllib.request.urlopen(r, timeout=30, context=CTX).read().decode())
    return d["Token"], d["TargetUriHost"]


def mwc_req(method, host, path, mwc, moniker, body=None, session_id=None):
    url = f"https://{host}" + path
    data = json.dumps(body).encode() if body else None
    h = {"Authorization": f"MwcToken {mwc}", "Content-Type": "application/json",
         "x-ms-workload-resource-moniker": moniker}
    if session_id:
        h["x-ms-lakehouse-client-session-id"] = session_id
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    return urllib.request.urlopen(r, timeout=30, context=CTX)


def t(label, fn):
    try:
        resp = fn()
        raw = resp.read().decode()
        parsed = json.loads(raw) if raw.strip() else {}
        # Smart summary
        if isinstance(parsed, dict):
            keys = list(parsed.keys())[:6]
            sz = ""
            for k in ["data", "value", "folders", "capacities"]:
                if k in parsed and isinstance(parsed[k], list):
                    sz = f"{len(parsed[k])} {k}"
                    break
            summary = sz or str(keys)
        elif isinstance(parsed, list):
            summary = f"[{len(parsed)} items]"
        else:
            summary = raw[:80]
        print(f"  OK  {resp.status:>3} | {label:<60} | {summary}")
        results.append({"l": label, "ok": True, "code": resp.status, "s": summary})
        return parsed
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        code = ""
        try:
            code = json.loads(body).get("errorCode", json.loads(body).get("code", ""))
        except Exception:
            pass
        print(f"  FAIL {e.code:>3} | {label:<60} | {code or body[:100]}")
        results.append({"l": label, "ok": False, "code": e.code, "err": code or body[:100]})
        return None
    except Exception as e:
        print(f"  ERR      | {label:<60} | {e}")
        results.append({"l": label, "ok": False, "err": str(e)[:100]})
        return None


print("=" * 100)
print("EDOG STUDIO — REMAINING API TESTS")
print("=" * 100)

# ╔══════════════════════════════════════════════════════════════╗
print("\n╔══ 1. RENAME OPERATIONS ══╗")

# Rename workspace (rename to same name = no-op, safe)
print("\n── Workspace rename ──")
t("PATCH workspace (same name)", lambda: bearer("PATCH", f"/v1/workspaces/{TEST_WSID}",
    {"displayName": env["workspaceName"]}))
# Rename to different, then back
t("PATCH workspace (rename to temp)", lambda: bearer("PATCH", f"/v1/workspaces/{TEST_WSID}",
    {"displayName": "EDOG_Studio_TestEnv_Renamed"}))
t("PATCH workspace (rename back)", lambda: bearer("PATCH", f"/v1/workspaces/{TEST_WSID}",
    {"displayName": env["workspaceName"]}))

# Rename lakehouse
print("\n── Lakehouse rename ──")
t("PATCH lakehouse (same name)", lambda: bearer("PATCH",
    f"/v1/workspaces/{TEST_WSID}/lakehouses/{TEST_LHID}",
    {"displayName": env.get("schemaLakehouseName", "EDOG_Test_LH_Schema")}))
t("PATCH lakehouse (rename to temp)", lambda: bearer("PATCH",
    f"/v1/workspaces/{TEST_WSID}/lakehouses/{TEST_LHID}",
    {"displayName": "EDOG_Test_LH_Renamed"}))
t("PATCH lakehouse (rename back)", lambda: bearer("PATCH",
    f"/v1/workspaces/{TEST_WSID}/lakehouses/{TEST_LHID}",
    {"displayName": "EDOG_Test_LH_Schema"}))

# Rename item (notebook) via /v1/workspaces/{id}/items/{id}
print("\n── Item rename (notebook via items endpoint) ──")
items_resp = t("List items to find notebook", lambda: bearer("GET", f"/v1/workspaces/{TEST_WSID}/items"))
if items_resp:
    notebooks = [i for i in items_resp.get("value", []) if i.get("type") == "Notebook"]
    if notebooks:
        nb = notebooks[0]
        nb_name = nb["displayName"]
        print(f"  Found notebook: {nb_name} ({nb['id'][:12]})")
        t(f"PATCH item (notebook rename)", lambda: bearer("PATCH",
            f"/v1/workspaces/{TEST_WSID}/items/{nb['id']}",
            {"displayName": nb_name + "_renamed"}))
        t(f"PATCH item (notebook rename back)", lambda: bearer("PATCH",
            f"/v1/workspaces/{TEST_WSID}/items/{nb['id']}",
            {"displayName": nb_name}))

# Rename table — check if there's an API
print("\n── Table rename (check if API exists) ──")
t("PATCH table (via v1 — expect 404/405)", lambda: bearer("PATCH",
    f"/v1/workspaces/{TEST_WSID}/lakehouses/{TEST_LHID}/tables/test_table",
    {"displayName": "test_table_renamed"}))


# ╔══════════════════════════════════════════════════════════════╗
print("\n╔══ 2. CAPACITY APIs ══╗")

print("\n── List capacities ──")
caps = t("GET /v1/capacities", lambda: bearer("GET", "/v1/capacities"))
if caps:
    cap_list = caps.get("value", [])
    print(f"  Found {len(cap_list)} capacities")
    for c in cap_list[:5]:
        print(f"    - {str(c.get('displayName') or '?'):30s}  id={str(c.get('id') or '?')[:12]}  sku={c.get('sku', '?')}  region={c.get('region', '?')}")
    if len(cap_list) > 5:
        print(f"    ... and {len(cap_list) - 5} more")

print("\n── Capacity detail ──")
# Try various path patterns
t("GET /v1/capacities/{id}", lambda: bearer("GET", f"/v1/capacities/{CAPID}"))
t("GET /v1/capacities/{id-nodash}", lambda: bearer("GET",
    f"/v1/capacities/{CAPID.replace('-', '')}"))
# v1.0 pattern
t("GET /v1.0/myorg/capacities", lambda: bearer("GET", "/v1.0/myorg/capacities"))

print("\n── Capacity assignment info ──")
# Workspaces assigned to capacity
t("GET /v1.0/myorg/groups (filter by cap)", lambda: bearer("GET",
    f"/v1.0/myorg/groups?$filter=capacityId eq '{CAPID}'"))
# Workspace capacity info
ws_detail = t("GET /v1/workspaces/{id} detail", lambda: bearer("GET", f"/v1/workspaces/{TEST_WSID}"))
if ws_detail:
    print(f"  Workspace detail keys: {list(ws_detail.keys())}")
    print(f"  capacityId: {ws_detail.get('capacityId', 'N/A')}")

print("\n── Assign to capacity ──")
t("POST assignToCapacity (same cap = no-op)", lambda: bearer("POST",
    f"/v1/workspaces/{TEST_WSID}/assignToCapacity",
    {"capacityId": CAPID}))
# v1.0 pattern
t("POST v1.0 AssignToCapacity", lambda: bearer("POST",
    f"/v1.0/myorg/groups/{TEST_WSID}/AssignToCapacity",
    {"capacityId": CAPID}))


# ╔══════════════════════════════════════════════════════════════╗
print("\n╔══ 3. BATCH TABLE DETAILS (fix 400) ══╗")

mwc_f, host_f = gen_mwc(FMLV_WSID, FMLV_LHID, CAPID)
base_f = f"/webapi/capacities/{CAPID}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{FMLV_WSID}"
session = str(uuid.uuid4())

# First get table list
tables_data = t("List tables (FMLVWS)", lambda: mwc_req("GET", host_f,
    f"{base_f}/artifacts/DataArtifact/{FMLV_LHID}/schemas/dbo/tables", mwc_f, FMLV_LHID))

if tables_data:
    table_names = [tb["name"] for tb in tables_data.get("data", [])]
    print(f"  Tables: {table_names}")

    # Try different body formats for batchGetTableDetails
    print("\n── batchGetTableDetails body format tests ──")

    # Format 1: { tableNames: [...] }
    t("batch: {tableNames: [...]}", lambda: mwc_req("POST", host_f,
        f"{base_f}/artifacts/DataArtifact/{FMLV_LHID}/schemas/dbo/batchGetTableDetails",
        mwc_f, FMLV_LHID, body={"tableNames": table_names[:2]}, session_id=session))

    # Format 2: { tables: [...] }
    t("batch: {tables: [...]}", lambda: mwc_req("POST", host_f,
        f"{base_f}/artifacts/DataArtifact/{FMLV_LHID}/schemas/dbo/batchGetTableDetails",
        mwc_f, FMLV_LHID, body={"tables": table_names[:2]}, session_id=session))

    # Format 3: { tableNames: [...], maxResults: 100 }
    t("batch: {tableNames, maxResults}", lambda: mwc_req("POST", host_f,
        f"{base_f}/artifacts/DataArtifact/{FMLV_LHID}/schemas/dbo/batchGetTableDetails",
        mwc_f, FMLV_LHID, body={"tableNames": table_names[:2], "maxResults": 100}, session_id=session))

    # Format 4: [name1, name2] (bare array)
    t("batch: bare array", lambda: mwc_req("POST", host_f,
        f"{base_f}/artifacts/DataArtifact/{FMLV_LHID}/schemas/dbo/batchGetTableDetails",
        mwc_f, FMLV_LHID, body=table_names[:2], session_id=session))

    # Format 5: without /schemas/dbo/ path
    t("batch: without schema path", lambda: mwc_req("POST", host_f,
        f"{base_f}/artifacts/DataArtifact/{FMLV_LHID}/batchGetTableDetails",
        mwc_f, FMLV_LHID, body={"tableNames": table_names[:2]}, session_id=session))

    # getTableDetails (single) — poll for result
    print("\n── getTableDetails + poll result ──")
    detail_resp = t("getTableDetails (single)", lambda: mwc_req("POST", host_f,
        f"{base_f}/artifacts/DataArtifact/{FMLV_LHID}/getTableDetails",
        mwc_f, FMLV_LHID, body={"relativePath": f"Tables/dbo/{table_names[0]}"}, session_id=session))

    if detail_resp and detail_resp.get("operationId"):
        op_id = detail_resp["operationId"]
        print(f"  Operation ID: {op_id}")
        time.sleep(3)
        t("poll getTableDetails result", lambda: mwc_req("GET", host_f,
            f"{base_f}/artifacts/DataArtifact/{FMLV_LHID}/getTableDetails/operationResults/{op_id}",
            mwc_f, FMLV_LHID, session_id=session))

    # previewAsync + poll
    print("\n── previewAsync + poll result ──")
    preview_resp = t("previewAsync", lambda: mwc_req("POST", host_f,
        f"{base_f}/artifacts/Lakehouse/{FMLV_LHID}/schemas/dbo/tables/{table_names[0]}/preview",
        mwc_f, FMLV_LHID, body={"maxRows": 5}, session_id=session))

    if preview_resp and preview_resp.get("operationId"):
        op_id = preview_resp["operationId"]
        print(f"  Operation ID: {op_id}")
        time.sleep(5)
        t("poll preview result", lambda: mwc_req("GET", host_f,
            f"{base_f}/artifacts/Lakehouse/{FMLV_LHID}/schemas/dbo/tables/{table_names[0]}/preview/operationResults/{op_id}",
            mwc_f, FMLV_LHID, session_id=session))


# ╔══════════════════════════════════════════════════════════════╗
print("\n╔══ 4. SCHEDULED JOBS CRUD ══╗")

print("\n── List scheduled jobs (FMLVWS) ──")
jobs = t("GET scheduledJobs (FMLVWS)", lambda: bearer("GET", f"/metadata/artifacts/{FMLV_LHID}/scheduledJobs"))
if jobs and isinstance(jobs, list) and len(jobs) > 0:
    print(f"  Found {len(jobs)} jobs")
    for j in jobs[:3]:
        print(f"    - type={j.get('artifactJobType', '?')}  enabled={j.get('scheduleEnabled', '?')}  defId={str(j.get('jobDefinitionObjectId', '?'))[:12]}")

# Create a test schedule on our test LH
print("\n── Create schedule (test env) ──")
now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
later = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + 86400))
t("POST scheduledJobs (create)", lambda: bearer("POST", f"/metadata/artifacts/{TEST_LHID}/scheduledJobs",
    {"artifactJobType": "MaterializedLakeViews",
     "artifactObjectId": TEST_LHID,
     "scheduleEnabled": False,
     "scheduleType": 2,
     "cronPeriod": 3,
     "scheduleStartTime": now,
     "scheduleEndTime": later,
     "scheduleHours": "[14:00]",
     "localTimeZoneId": "India Standard Time",
     "scheduleWeekIndex": 1,
     "scheduleWeekdays": 127}))


# ════════════════════════════════════════════════════════════════
print("\n" + "=" * 100)
ok = sum(1 for r in results if r["ok"])
fail = sum(1 for r in results if not r["ok"])
print(f"FINAL: {ok} OK / {fail} FAIL / {len(results)} total")
print("=" * 100)

out = PROJECT_DIR / "docs" / "remaining-api-test-results.json"
out.write_text(json.dumps(results, indent=2))
print(f"\nResults saved to: {out}")
