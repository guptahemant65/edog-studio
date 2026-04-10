"""Test ALL capacity-related APIs."""
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
CAPID = "dd01a7f3-4198-4439-aae3-4eaf902281bb"


def req(method, path, body=None):
    url = META + path
    data = json.dumps(body).encode() if body else None
    h = {"Authorization": f"Bearer {BEARER}", "Content-Type": "application/json;charset=UTF-8",
         "activityid": str(uuid.uuid4()), "requestid": str(uuid.uuid4())}
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    return urllib.request.urlopen(r, timeout=20, context=CTX)


def t(label, method, path, body=None):
    try:
        resp = req(method, path, body)
        raw_resp = resp.read().decode()
        parsed = json.loads(raw_resp) if raw_resp.strip() else {}
        if isinstance(parsed, dict):
            val = parsed.get("value", parsed.get("data", []))
            if isinstance(val, list):
                summary = f"{len(val)} items, keys={list(parsed.keys())[:5]}"
            else:
                summary = f"keys={list(parsed.keys())[:6]}"
        elif isinstance(parsed, list):
            summary = f"[{len(parsed)} items]"
        else:
            summary = raw_resp[:80]
        print(f"  OK  {resp.status:>3} | {label:<55} | {summary}")
        return parsed
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:180]
        print(f"  FAIL {e.code:>3} | {label:<55} | {err[:120]}")
        return None
    except Exception as e:
        print(f"  ERR      | {label:<55} | {e}")
        return None


print("=" * 100)
print("CAPACITY API DEEP DIVE")
print("=" * 100)

# ── LIST ──
print("\n── List Capacities ──")
caps_v1 = t("GET /v1/capacities", "GET", "/v1/capacities")
caps_v10 = t("GET /v1.0/myorg/capacities", "GET", "/v1.0/myorg/capacities")

if caps_v1 and caps_v1.get("value"):
    print("\n  v1 capacity list:")
    for c in caps_v1["value"]:
        name = c.get("displayName") or "(unnamed)"
        sku = c.get("sku", "?")
        region = c.get("region", "?")
        state = c.get("state", "?")
        cid = c.get("id", "?")[:12]
        print(f"    {name:30s}  sku={sku:5s}  region={region:20s}  state={state}  id={cid}")

if caps_v10 and caps_v10.get("value"):
    print("\n  v1.0 first capacity (full keys):")
    first = caps_v10["value"][0]
    print(f"    keys: {list(first.keys())}")
    print(f"    sample: {json.dumps(first, indent=2)[:500]}")

# ── DETAIL ──
print("\n── Capacity Detail (single) ──")
t("GET /v1/capacities/{id}", "GET", f"/v1/capacities/{CAPID}")
t("GET /v1.0/myorg/capacities/{id}", "GET", f"/v1.0/myorg/capacities/{CAPID}")
# Try encoded format
cap_nodash = CAPID.replace("-", "")
t("GET /v1/capacities/{id-nodash}", "GET", f"/v1/capacities/{cap_nodash}")

# ── ADMIN ──
print("\n── Admin Capacity APIs ──")
t("GET /v1/admin/capacities", "GET", "/v1/admin/capacities")
t("GET /v1/admin/capacities/{id}", "GET", f"/v1/admin/capacities/{CAPID}")
t("GET /v1.0/myorg/admin/capacities", "GET", "/v1.0/myorg/admin/capacities")

# ── WORKLOADS ──
print("\n── Capacity Workloads ──")
t("GET /v1/capacities/{id}/workloads", "GET", f"/v1/capacities/{CAPID}/workloads")
t("GET /v1.0/myorg/capacities/{id}/Workloads", "GET", f"/v1.0/myorg/capacities/{CAPID}/Workloads")

# ── REFRESHABLES (throttling) ──
print("\n── Refreshables / Throttling ──")
t("GET /v1.0/myorg/capacities/{id}/Refreshables", "GET", f"/v1.0/myorg/capacities/{CAPID}/Refreshables")
t("GET /v1.0/myorg/capacities/refreshables", "GET", "/v1.0/myorg/capacities/refreshables")

# ── CREATION ──
print("\n── Capacity Creation (expect failure — admin only) ──")
t("POST /v1/capacities", "POST", "/v1/capacities",
    {"displayName": "EDOG_Test_Cap", "sku": "F2"})
t("POST /v1.0/myorg/capacities", "POST", "/v1.0/myorg/capacities",
    {"displayName": "EDOG_Test_Cap", "sku": "F2"})

# ── WORKSPACE CAPACITY INFO ──
print("\n── Workspace → Capacity Info ──")
_test_env = json.loads(Path(PROJECT_DIR / "config/test-environment.json").read_text())
ws = t("GET /v1/workspaces/{id} (capacity info)", "GET",
    f"/v1/workspaces/{_test_env['workspaceId']}")

# Get all workspaces and show their capacity assignments
print("\n── All Workspaces + Capacity Mapping ──")
all_ws = t("GET /v1.0/myorg/groups", "GET", "/v1.0/myorg/groups")
if all_ws and all_ws.get("value"):
    for w in all_ws["value"]:
        cap = w.get("capacityId", "none")
        print(f"    {w.get('name', '?'):35s}  cap={str(cap)[:12]}  dedicated={w.get('isOnDedicatedCapacity', '?')}")

print("\nDone!")
