"""Extract and test notebook execution APIs from captured network data."""
import base64
import json
import ssl
import urllib.request
import uuid
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
raw = (PROJECT_DIR / ".edog-bearer-cache").read_text().strip()
_, BEARER = base64.b64decode(raw.encode()).decode().split("|", 1)
CTX = ssl.create_default_context()
META = "https://biazure-int-edog-redirect.analysis-df.windows.net"

# Parse captured patterns
data = json.loads((PROJECT_DIR / "docs" / "notebook-editor-network-calls.json").read_text())

print("=== NOTEBOOK-RELATED CAPACITY HOST ENDPOINTS ===\n")
for ep in sorted(data["unique"], key=lambda x: x["pattern"]):
    p = ep["pattern"]
    if "Notebook" in p and "pbidedicated" in p:
        # Strip host to show just the path
        path = p
        if ".net" in p:
            path = p.split(".net", 1)[1] if ".net" in p else p
        body = ep.get("post_data", "")
        print(f"  {ep['method']:>5} x{ep['count']}  {path[:120]}")
        if body:
            print(f"        body: {body[:200]}")
        print()

print("\n=== TESTING KEY NOTEBOOK ENDPOINTS ===\n")

# IDs from the captured data
WSID = "1b20c810-b067-4b98-b418-935456c1256f"  # hmgtrends
NBID = "e1952851-641f-4dc6-8fae-3ac5a67aa3e4"  # the notebook
CAPID = "19524206-8f8a-4e75-a89c-3df0de08cc7f"  # hmgcapone

results = []


def bearer_req(method, path, body=None):
    url = META + path
    data_bytes = json.dumps(body).encode() if body else None
    h = {"Authorization": f"Bearer {BEARER}", "Content-Type": "application/json;charset=UTF-8",
         "activityid": str(uuid.uuid4()), "requestid": str(uuid.uuid4()),
         "x-powerbi-hostenv": "Power BI Web App",
         "origin": "https://powerbi-df.analysis-df.windows.net",
         "referer": "https://powerbi-df.analysis-df.windows.net/"}
    r = urllib.request.Request(url, data=data_bytes, headers=h, method=method)
    return urllib.request.urlopen(r, timeout=30, context=CTX)


def gen_mwc(ws_id, artifact_id, cap_id, workload_type="Notebook"):
    body = json.dumps({
        "type": "[Start] GetMWCToken", "workloadType": workload_type,
        "workspaceObjectId": ws_id, "artifactObjectIds": [artifact_id],
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


def t(label, fn):
    try:
        resp = fn()
        raw_resp = resp.read().decode()
        parsed = json.loads(raw_resp) if raw_resp.strip() else {}
        if isinstance(parsed, dict):
            keys = list(parsed.keys())[:8]
            print(f"  OK  {resp.status:>3} | {label:<55} | keys={keys}")
        elif isinstance(parsed, list):
            print(f"  OK  {resp.status:>3} | {label:<55} | [{len(parsed)} items]")
        else:
            print(f"  OK  {resp.status:>3} | {label:<55} | {raw_resp[:80]}")
        results.append({"label": label, "ok": True, "response": raw_resp[:500]})
        return parsed
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:200]
        print(f"  FAIL {e.code:>3} | {label:<55} | {err[:120]}")
        results.append({"label": label, "ok": False, "error": err[:200]})
        return None
    except Exception as e:
        print(f"  ERR      | {label:<55} | {e}")
        results.append({"label": label, "ok": False, "error": str(e)[:200]})
        return None


# 1. Notebook definitions (content)
print("── 1. Notebook Content/Definitions ──")
t("GET /metadata/artifacts/definitions (need query params?)",
    lambda: bearer_req("GET", "/metadata/artifacts/definitions"))
t("GET /metadata/artifacts/{nbId}",
    lambda: bearer_req("GET", f"/metadata/artifacts/{NBID}"))

# Try getDefinition via v1 API (from ILakehousePublicApiClient)
t("POST /v1/.../items/{nbId}/getDefinition?format=ipynb",
    lambda: bearer_req("POST", f"/v1/workspaces/{WSID}/items/{NBID}/getDefinition?format=ipynb"))

# 2. Generate MWC for Notebook workload
print("\n── 2. MWC Token for Notebook ──")
try:
    mwc, host = gen_mwc(WSID, NBID, CAPID, "Notebook")
    print(f"  MWC OK: {len(mwc)} chars, host={host}")
    cap_host = f"https://{host}"
    nb_base = f"/webapi/capacities/{CAPID}/workloads/Notebook/NotebookService/automatic"

    # 3. Notebook session/kernel (from captured patterns)
    print("\n── 3. Notebook Session/Kernel ──")

    # Create session (this is how the portal starts a Spark session)
    t("POST .../sessions (create Spark session)",
        lambda: urllib.request.urlopen(
            urllib.request.Request(
                cap_host + nb_base + f"/v1/workspaces/{WSID}/artifacts/Notebook/{NBID}/sessions",
                data=json.dumps({
                    "kernel": {"id": None, "name": "synapse_pyspark"},
                    "name": "",
                    "path": f"notebooks/{NBID}.ipynb",
                    "type": "notebook"
                }).encode(),
                headers={"Authorization": f"MwcToken {mwc}", "Content-Type": "application/json",
                         "x-ms-workload-resource-moniker": NBID},
                method="POST"
            ), timeout=60, context=CTX
        ))

except Exception as e:
    print(f"  MWC/Session error: {e}")

# 4. OneLake direct access
print("\n── 4. OneLake File Access ──")
ONELAKE = "https://onelake-int-edog.dfs.pbidedicated.windows-int.net"
t("GET onelake v1.0/workspaces/{id}/artifacts",
    lambda: urllib.request.urlopen(
        urllib.request.Request(
            ONELAKE + f"/v1.0/workspaces/{WSID}/artifacts",
            headers={"Authorization": f"Bearer {BEARER}"}
        ), timeout=15, context=CTX
    ))

# 5. Shortcuts
print("\n── 5. Shortcuts ──")
t("GET /v1/.../items/{nbId}/shortcuts",
    lambda: bearer_req("GET", f"https://powerbiapi.analysis-df.windows.net/v1/workspaces/{WSID}/items/{NBID}/shortcuts"))

# 6. v1 API for item jobs (run notebook)
print("\n── 6. Run Notebook via Jobs API ──")
t("POST /v1/.../items/{nbId}/jobs/instances (RunNotebook)",
    lambda: bearer_req("POST", f"/v1/workspaces/{WSID}/items/{NBID}/jobs/instances?jobType=RunNotebook"))

# Summary
print("\n" + "=" * 80)
ok = sum(1 for r in results if r["ok"])
fail = sum(1 for r in results if not r["ok"])
print(f"RESULTS: {ok} OK / {fail} FAIL / {len(results)} total")

out = PROJECT_DIR / "docs" / "notebook-api-test-results.json"
out.write_text(json.dumps(results, indent=2))
print(f"Saved to: {out}")
