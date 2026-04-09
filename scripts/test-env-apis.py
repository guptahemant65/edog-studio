"""Test all Fabric API endpoints against EDOG_Studio_TestEnv."""
import base64
import json
import ssl
import time
import urllib.request
import urllib.error
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
BEARER_CACHE = PROJECT_DIR / ".edog-bearer-cache"
ENV_FILE = PROJECT_DIR / "config" / "test-environment.json"
REDIRECT = "https://biazure-int-edog-redirect.analysis-df.windows.net"

raw = BEARER_CACHE.read_text().strip()
_, bearer = base64.b64decode(raw.encode()).decode().split("|", 1)
ctx = ssl.create_default_context()

env = json.loads(ENV_FILE.read_text())
WSID = env["workspaceId"]
LHID = env["lakehouseId"]
CAPID = env["capacityId"]

results = []


def test(method, path, body=None, label=""):
    url = REDIRECT + path
    try:
        data = json.dumps(body).encode() if body else None
        headers = {"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        resp = urllib.request.urlopen(req, timeout=30, context=ctx)
        raw_resp = resp.read().decode()
        parsed = json.loads(raw_resp) if raw_resp.strip() else {}
        if isinstance(parsed, dict):
            keys = list(parsed.keys())[:6]
            count = len(parsed.get("value", parsed.get("folders", parsed.get("data", []))))
        elif isinstance(parsed, list):
            keys = list(parsed[0].keys())[:5] if parsed else []
            count = len(parsed)
        else:
            keys = []
            count = 0
        status = f"OK {resp.status}"
        print(f"  {status:>8} | {label:<55} | count={count} keys={keys}")
        results.append({"label": label, "ok": True, "code": resp.status, "count": count, "keys": keys})
        return parsed
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()[:200]
        err_code = ""
        try:
            err_code = json.loads(body_text).get("errorCode", "")
        except Exception:
            pass
        print(f"  FAIL {e.code:>3} | {label:<55} | {err_code or body_text[:80]}")
        results.append({"label": label, "ok": False, "code": e.code, "error": err_code or body_text[:80]})
        return None
    except Exception as e:
        print(f"  ERR      | {label:<55} | {e}")
        results.append({"label": label, "ok": False, "error": str(e)})
        return None


print(f"Testing against: {env['workspaceName']} / {env['lakehouseName']}")
print(f"WS={WSID}  LH={LHID}  CAP={CAPID}")
print("=" * 100)

# ── WORKSPACE OPS ──
print("\n--- WORKSPACE OPERATIONS ---")
test("GET", "/metadata/workspaces", label="List workspaces (metadata)")
test("GET", "/v1.0/myorg/groups", label="List workspaces (v1.0)")
test("GET", f"/v1/workspaces/{WSID}/items", label="List items in workspace (v1)")
test("PATCH", f"/v1/workspaces/{WSID}", body={"displayName": env["workspaceName"]}, label="Rename workspace (no-op)")

# ── LAKEHOUSE OPS ──
print("\n--- LAKEHOUSE OPERATIONS ---")
test("GET", f"/v1/workspaces/{WSID}/lakehouses", label="List lakehouses (v1)")
test("GET", f"/v1/workspaces/{WSID}/lakehouses/{LHID}", label="Get lakehouse details (v1)")
test("PATCH", f"/v1/workspaces/{WSID}/lakehouses/{LHID}", body={"displayName": env["lakehouseName"]}, label="Rename lakehouse (no-op)")

# ── TABLE OPS ──
print("\n--- TABLE OPERATIONS ---")
test("GET", f"/v1/workspaces/{WSID}/lakehouses/{LHID}/tables", label="List tables (v1) — non-schema LH")

# ── METADATA OPS ──
print("\n--- METADATA OPERATIONS ---")
test("GET", f"/metadata/workspaces/{WSID}/artifacts", label="List artifacts (metadata)")
test("GET", f"/metadata/artifacts/{LHID}", label="Get artifact by ID (metadata)")

# ── MWC TOKEN ──
print("\n--- TOKEN OPERATIONS ---")
mwc_result = test("POST", "/metadata/v201606/generatemwctoken", body={
    "type": "[Start] GetMWCToken",
    "workloadType": "Lakehouse",
    "workspaceObjectId": WSID,
    "artifactObjectIds": [LHID],
    "capacityObjectId": CAPID,
}, label="Generate MWC token")

# ── FLT SERVICE (if MWC token available) ──
if mwc_result and mwc_result.get("Token"):
    mwc = mwc_result["Token"]
    cap_host = f"https://{CAPID}.pbidedicated.windows-int.net"
    base = f"/webapi/capacities/{CAPID}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{WSID}/lakehouses/{LHID}"

    print("\n--- FLT SERVICE (MWC token) ---")
    print(f"Capacity host: {cap_host}")

    # Ping (unprotected)
    ping_url = f"{cap_host}/webapi/capacities/{CAPID}/workloads/LiveTable/LiveTableService/automatic/publicUnprotected/ping"
    try:
        req = urllib.request.Request(ping_url)
        resp = urllib.request.urlopen(req, timeout=10, context=ctx)
        print(f"  OK {resp.status:>5} | Ping FLT service                                      | {resp.read().decode()[:50]}")
    except Exception as e:
        print(f"  FAIL     | Ping FLT service                                      | {e}")

    # DAG endpoints (need MWC)
    lt_base = f"/webapi/capacities/{CAPID}/workloads/LiveTable/LiveTableService/automatic/v1/workspaces/{WSID}/lakehouses/{LHID}/liveTable"
    for path, label in [
        (f"{lt_base}/getLatestDag?showExtendedLineage=true", "Get latest DAG"),
        (f"{lt_base}/settings", "Get DAG settings"),
        (f"{lt_base}/listDAGExecutionIterationIds", "List DAG execution IDs"),
        (f"{lt_base}/mlvExecutionDefinitions", "List MLV execution definitions"),
    ]:
        url = cap_host + path
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {mwc}", "Content-Type": "application/json"})
            resp = urllib.request.urlopen(req, timeout=15, context=ctx)
            raw_resp = resp.read().decode()
            print(f"  OK {resp.status:>5} | {label:<55} | {raw_resp[:80]}")
        except urllib.error.HTTPError as e:
            print(f"  FAIL {e.code:>3} | {label:<55} | {e.read().decode()[:80]}")
        except Exception as e:
            print(f"  ERR      | {label:<55} | {e}")

    # Maintenance endpoints
    maint_base = lt_base.replace("/liveTable", "/liveTableMaintenance")
    for path, label in [
        (f"{maint_base}/getLockedDAGExecutionIteration", "Get locked DAG execution"),
    ]:
        url = cap_host + path
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {mwc}", "Content-Type": "application/json"})
            resp = urllib.request.urlopen(req, timeout=15, context=ctx)
            raw_resp = resp.read().decode()
            print(f"  OK {resp.status:>5} | {label:<55} | {raw_resp[:80]}")
        except urllib.error.HTTPError as e:
            print(f"  FAIL {e.code:>3} | {label:<55} | {e.read().decode()[:80]}")
        except Exception as e:
            print(f"  ERR      | {label:<55} | {e}")
else:
    print("\n--- FLT SERVICE: SKIPPED (no MWC token) ---")

# ── SUMMARY ──
print("\n" + "=" * 100)
ok_count = sum(1 for r in results if r["ok"])
fail_count = sum(1 for r in results if not r["ok"])
print(f"SUMMARY: {ok_count} OK / {fail_count} FAIL / {len(results)} total")

# Save
out = PROJECT_DIR / "docs" / "test-env-api-results.json"
out.write_text(json.dumps(results, indent=2))
print(f"Results saved to: {out}")
