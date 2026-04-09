"""Comprehensive API test — hit EVERY untested endpoint in the project.

Tests against:
1. EDOG_Studio_TestEnv (our safe playground) — for destructive ops
2. FMLVWS (real data) — for DAG/maintenance/table details (has MLVs)

Run: python scripts/test-all-apis.py
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
TEST_LH_PLAIN = env["lakehouseId"]
CAPID = env["capacityId"]

# FMLVWS has real MLV tables
FMLV_WSID = "c40147b5-d369-407b-b5c0-7b080fb929bd"
FMLV_LHID = "a96fdc44-a514-4abf-b73b-e691d3022500"  # TestLH (has mvfrommv, mvfromone etc)
FMLV_CAPID = "dd01a7f3-4198-4439-aae3-4eaf902281bb"

results = []


def bearer_req(method, path, body=None):
    """Request to redirect host with Bearer token."""
    url = META + path
    data = json.dumps(body).encode() if body else None
    headers = {"Authorization": f"Bearer {BEARER}", "Content-Type": "application/json;charset=UTF-8",
               "activityid": str(uuid.uuid4()), "requestid": str(uuid.uuid4())}
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    return urllib.request.urlopen(r, timeout=30, context=CTX)


def gen_mwc(ws_id, lh_id, cap_id):
    """Generate MWC token."""
    body = json.dumps({
        "type": "[Start] GetMWCToken", "workloadType": "Lakehouse",
        "workspaceObjectId": ws_id, "artifactObjectIds": [lh_id],
        "capacityObjectId": cap_id, "asyncId": str(uuid.uuid4()), "iframeId": str(uuid.uuid4()),
    }).encode()
    headers = {"Authorization": f"Bearer {BEARER}", "Content-Type": "application/json;charset=UTF-8",
               "activityid": str(uuid.uuid4()), "requestid": str(uuid.uuid4()),
               "x-powerbi-hostenv": "Power BI Web App",
               "origin": "https://powerbi-df.analysis-df.windows.net",
               "referer": "https://powerbi-df.analysis-df.windows.net/"}
    r = urllib.request.Request(META + "/metadata/v201606/generatemwctoken", data=body, headers=headers, method="POST")
    data = json.loads(urllib.request.urlopen(r, timeout=30, context=CTX).read().decode())
    return data["Token"], data["TargetUriHost"]


def mwc_req(method, host, path, mwc, moniker, body=None, session_id=None):
    """Request to capacity host with MwcToken."""
    url = f"https://{host}" + path
    data = json.dumps(body).encode() if body else None
    headers = {"Authorization": f"MwcToken {mwc}", "Content-Type": "application/json",
               "x-ms-workload-resource-moniker": moniker}
    if session_id:
        headers["x-ms-lakehouse-client-session-id"] = session_id
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    return urllib.request.urlopen(r, timeout=30, context=CTX)


def test(label, fn):
    """Run a test and record result."""
    try:
        resp = fn()
        raw = resp.read().decode()
        parsed = json.loads(raw) if raw.strip() else {}
        summary = ""
        if isinstance(parsed, dict):
            keys = list(parsed.keys())[:5]
            if "data" in parsed:
                summary = f"{len(parsed['data'])} items"
            elif "value" in parsed:
                summary = f"{len(parsed['value'])} items"
            else:
                summary = str(keys)
        elif isinstance(parsed, list):
            summary = f"[{len(parsed)} items]"
        else:
            summary = raw[:60]
        print(f"  OK  {resp.status:>3} | {label:<55} | {summary}")
        results.append({"label": label, "ok": True, "code": resp.status, "summary": summary})
        return parsed
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()[:150]
        err_code = ""
        try:
            err_code = json.loads(err_body).get("errorCode", json.loads(err_body).get("code", ""))
        except Exception:
            pass
        print(f"  FAIL {e.code:>3} | {label:<55} | {err_code or err_body[:80]}")
        results.append({"label": label, "ok": False, "code": e.code, "error": err_code or err_body[:80]})
        return None
    except Exception as e:
        print(f"  ERR      | {label:<55} | {type(e).__name__}: {str(e)[:60]}")
        results.append({"label": label, "ok": False, "error": str(e)[:80]})
        return None


# ════════════════════════════════════════════════════════════════
print("=" * 90)
print("EDOG STUDIO — COMPREHENSIVE API TEST")
print(f"Bearer token available: {len(BEARER)} chars")
print(f"Test env: {env['workspaceName']} | Real data: FMLVWS")
print("=" * 90)

# ── SECTION 1: Bearer-based (redirect host) ──
print("\n╔══ SECTION 1: Bearer Token Endpoints (redirect host) ══╗")

print("\n── Scheduled Jobs (F05) ──")
test("List scheduled jobs (test LH)", lambda: bearer_req("GET", f"/metadata/artifacts/{TEST_LHID}/scheduledJobs"))
test("List scheduled jobs (FMLVWS TestLH)", lambda: bearer_req("GET", f"/metadata/artifacts/{FMLV_LHID}/scheduledJobs"))

print("\n── Capacity Info ──")
test("List capacities (/v1/capacities)", lambda: bearer_req("GET", "/v1/capacities"))
test("Get capacity detail", lambda: bearer_req("GET", f"/v1/capacities/{CAPID}"))

print("\n── DELETE test (create temp LH, then delete) ──")
temp_lh_id = None
temp_resp = test("Create temp lakehouse", lambda: bearer_req("POST", f"/v1/workspaces/{TEST_WSID}/lakehouses",
    {"displayName": f"EDOG_Temp_Delete_Test_{int(time.time())}",
     "description": "Temp LH for delete testing. Safe to delete."}))
if temp_resp:
    temp_lh_id = temp_resp.get("id")
    print(f"  Created temp LH: {temp_lh_id}")
    time.sleep(3)
    test("DELETE temp lakehouse", lambda: bearer_req("DELETE", f"/v1/workspaces/{TEST_WSID}/lakehouses/{temp_lh_id}"))

print("\n── Notebook/Item APIs ──")
test("List items (v1) for test WS", lambda: bearer_req("GET", f"/v1/workspaces/{TEST_WSID}/items"))
# Notebook creation
test("Create notebook", lambda: bearer_req("POST", f"/v1/workspaces/{TEST_WSID}/items",
    {"displayName": f"EDOG_Test_Notebook_{int(time.time())}", "type": "Notebook"}))

# ── SECTION 2: MwcToken-based (capacity host) — using test env ──
print("\n╔══ SECTION 2: MwcToken Endpoints — Test Environment ══╗")
try:
    mwc_test, host_test = gen_mwc(TEST_WSID, TEST_LHID, CAPID)
    print(f"  MWC generated for test env: {len(mwc_test)} chars, host: {host_test}")
    base_test = f"/webapi/capacities/{CAPID}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{TEST_WSID}"

    print("\n── Table Details (F01+) ──")
    test("List tables (schema LH)", lambda: mwc_req("GET", host_test,
        f"{base_test}/artifacts/DataArtifact/{TEST_LHID}/schemas/dbo/tables", mwc_test, TEST_LHID))

    print("\n── DAG endpoints (expect 404 — no MLV configured) ──")
    lt_test = f"{base_test}/lakehouses/{TEST_LHID}/liveTable"
    test("getLatestDag (test env)", lambda: mwc_req("GET", host_test,
        f"{lt_test}/getLatestDag?showExtendedLineage=true", mwc_test, TEST_LHID))
    test("DAG settings (test env)", lambda: mwc_req("GET", host_test,
        f"{lt_test}/settings", mwc_test, TEST_LHID))

    print("\n── Maintenance endpoints ──")
    mt_test = f"{base_test}/lakehouses/{TEST_LHID}/liveTableMaintenance"
    test("getLockedDAGExecution (test)", lambda: mwc_req("GET", host_test,
        f"{mt_test}/getLockedDAGExecutionIteration", mwc_test, TEST_LHID))
    test("listOrphanedIndexFolders (test)", lambda: mwc_req("GET", host_test,
        f"{mt_test}/listOrphanedIndexFolders", mwc_test, TEST_LHID))

except Exception as e:
    print(f"  MWC generation failed for test env: {e}")

# ── SECTION 3: MwcToken-based — FMLVWS (real data with MLVs) ──
print("\n╔══ SECTION 3: MwcToken Endpoints — FMLVWS (real MLV data) ══╗")
try:
    mwc_fmlv, host_fmlv = gen_mwc(FMLV_WSID, FMLV_LHID, FMLV_CAPID)
    print(f"  MWC generated for FMLVWS: {len(mwc_fmlv)} chars, host: {host_fmlv}")
    base_fmlv = f"/webapi/capacities/{FMLV_CAPID}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{FMLV_WSID}"
    session = str(uuid.uuid4())

    print("\n── Tables (schema-enabled, real data) ──")
    tables_resp = test("List tables (FMLVWS TestLH)", lambda: mwc_req("GET", host_fmlv,
        f"{base_fmlv}/artifacts/DataArtifact/{FMLV_LHID}/schemas/dbo/tables", mwc_fmlv, FMLV_LHID))
    if tables_resp:
        tables = tables_resp.get("data", [])
        print(f"  Found {len(tables)} tables: {[t.get('name','?') for t in tables[:5]]}")
        if tables:
            first_table = tables[0]["name"]

            print("\n── Table Details (F01+) — single table ──")
            test(f"getTableDetails ({first_table})", lambda: mwc_req("POST", host_fmlv,
                f"{base_fmlv}/artifacts/DataArtifact/{FMLV_LHID}/getTableDetails",
                mwc_fmlv, FMLV_LHID, body={"relativePath": f"Tables/dbo/{first_table}"},
                session_id=session))

            print("\n── Batch Table Details ──")
            test("batchGetTableDetails", lambda: mwc_req("POST", host_fmlv,
                f"{base_fmlv}/artifacts/DataArtifact/{FMLV_LHID}/schemas/dbo/batchGetTableDetails",
                mwc_fmlv, FMLV_LHID,
                body={"tableNames": [t["name"] for t in tables[:3]]}))

            print("\n── Table Preview ──")
            test(f"previewAsync ({first_table})", lambda: mwc_req("POST", host_fmlv,
                f"{base_fmlv}/artifacts/Lakehouse/{FMLV_LHID}/schemas/dbo/tables/{first_table}/preview",
                mwc_fmlv, FMLV_LHID, body={"maxRows": 5}, session_id=session))

    print("\n── DAG Studio (F03) ──")
    lt_fmlv = f"{base_fmlv}/lakehouses/{FMLV_LHID}/liveTable"
    dag = test("getLatestDag (FMLVWS)", lambda: mwc_req("GET", host_fmlv,
        f"{lt_fmlv}/getLatestDag?showExtendedLineage=true", mwc_fmlv, FMLV_LHID))
    if dag:
        print(f"  DAG keys: {list(dag.keys())[:8]}")
        nodes = dag.get("nodes", dag.get("Nodes", []))
        if isinstance(nodes, list):
            print(f"  Nodes: {len(nodes)}")
            for n in nodes[:5]:
                print(f"    - {n.get('name', n.get('Name', '?'))}")

    test("DAG settings (FMLVWS)", lambda: mwc_req("GET", host_fmlv,
        f"{lt_fmlv}/settings", mwc_fmlv, FMLV_LHID))
    test("listDAGExecutionIterationIds", lambda: mwc_req("GET", host_fmlv,
        f"{lt_fmlv}/listDAGExecutionIterationIds", mwc_fmlv, FMLV_LHID))
    test("mlvExecutionDefinitions", lambda: mwc_req("GET", host_fmlv,
        f"{lt_fmlv}/mlvExecutionDefinitions", mwc_fmlv, FMLV_LHID))

    print("\n── Maintenance (F05) ──")
    mt_fmlv = f"{base_fmlv}/lakehouses/{FMLV_LHID}/liveTableMaintenance"
    test("getLockedDAGExecution (FMLVWS)", lambda: mwc_req("GET", host_fmlv,
        f"{mt_fmlv}/getLockedDAGExecutionIteration", mwc_fmlv, FMLV_LHID))
    test("listOrphanedIndexFolders (FMLVWS)", lambda: mwc_req("GET", host_fmlv,
        f"{mt_fmlv}/listOrphanedIndexFolders", mwc_fmlv, FMLV_LHID))

except urllib.error.HTTPError as e:
    print(f"  MWC generation failed for FMLVWS: HTTP {e.code} — {e.read().decode()[:150]}")
except Exception as e:
    print(f"  MWC generation failed for FMLVWS: {e}")

# ── SECTION 4: Other workspaces with known MLVs ──
print("\n╔══ SECTION 4: DAG on other workspaces ══╗")
# gapatws has lots of MLVs
GAPAT_WSID = "50eae5ca-d72c-470f-901e-be94226b0c5f"
GAPAT_LHID = None
try:
    items = json.loads(bearer_req("GET", f"/v1/workspaces/{GAPAT_WSID}/items").read().decode())
    lakehouses = [i for i in items.get("value", []) if i.get("type") == "Lakehouse"]
    if lakehouses:
        GAPAT_LHID = lakehouses[0]["id"]
        GAPAT_CAPID = "dd01a7f3-4198-4439-aae3-4eaf902281bb"
        mwc_g, host_g = gen_mwc(GAPAT_WSID, GAPAT_LHID, GAPAT_CAPID)
        base_g = f"/webapi/capacities/{GAPAT_CAPID}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{GAPAT_WSID}"
        lt_g = f"{base_g}/lakehouses/{GAPAT_LHID}/liveTable"

        dag_g = test(f"getLatestDag (gapatws/{lakehouses[0]['displayName']})", lambda: mwc_req("GET", host_g,
            f"{lt_g}/getLatestDag?showExtendedLineage=true", mwc_g, GAPAT_LHID))
        if dag_g:
            nodes = dag_g.get("nodes", dag_g.get("Nodes", dag_g.get("dagNodes", [])))
            if isinstance(nodes, list):
                print(f"  DAG: {len(nodes)} nodes")
            else:
                print(f"  DAG response keys: {list(dag_g.keys())[:10]}")
                print(f"  First 300 chars: {json.dumps(dag_g)[:300]}")

        test(f"DAG settings (gapatws)", lambda: mwc_req("GET", host_g,
            f"{lt_g}/settings", mwc_g, GAPAT_LHID))
        test(f"iterations (gapatws)", lambda: mwc_req("GET", host_g,
            f"{lt_g}/listDAGExecutionIterationIds", mwc_g, GAPAT_LHID))
except Exception as e:
    print(f"  gapatws test failed: {e}")

# ════════════════════════════════════════════════════════════════
print("\n" + "=" * 90)
ok = sum(1 for r in results if r["ok"])
fail = sum(1 for r in results if not r["ok"])
print(f"FINAL: {ok} OK / {fail} FAIL / {len(results)} total")
print("=" * 90)

# Save results
out = PROJECT_DIR / "docs" / "all-api-test-results.json"
out.write_text(json.dumps(results, indent=2))
print(f"\nResults saved to: {out}")
