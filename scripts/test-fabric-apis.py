"""Comprehensive Fabric API endpoint test — maps what works, what doesn't."""
import base64
import contextlib
import json
import ssl
import urllib.request
from pathlib import Path

raw = Path(".edog-bearer-cache").read_text().strip()
_, bearer = base64.b64decode(raw.encode()).decode().split("|", 1)
ctx = ssl.create_default_context()
META = "https://biazure-int-edog-redirect.analysis-df.windows.net"

results = []


def test(host, path, method="GET", body=None, label=""):
    url = host + path
    try:
        data = body.encode() if body else None
        headers = {"Authorization": "Bearer " + bearer, "Content-Type": "application/json"}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        resp = urllib.request.urlopen(req, timeout=20, context=ctx)
        raw_resp = resp.read().decode()
        parsed = json.loads(raw_resp) if raw_resp.strip() else {}
        if isinstance(parsed, dict):
            shape = "{" + ", ".join(list(parsed.keys())[:6]) + "}"
            count = len(parsed.get("value", parsed.get("folders", [])))
        elif isinstance(parsed, list):
            shape = f"[{len(parsed)} items]"
            count = len(parsed)
            if parsed:
                shape += " keys=" + str(list(parsed[0].keys())[:5])
        else:
            shape = str(type(parsed))
            count = 0
        print(f"  OK  {resp.status:>3} | {label:<45} | {shape}")
        results.append({"label": label, "status": "OK", "code": resp.status, "shape": shape, "count": count, "path": path, "host": host})
        return parsed
    except urllib.error.HTTPError as e:
        body_text = ""
        with contextlib.suppress(Exception):
            body_text = e.read().decode()[:200]
        print(f"  FAIL {e.code:>3} | {label:<45} | {body_text[:100]}")
        results.append({"label": label, "status": "FAIL", "code": e.code, "error": body_text[:200], "path": path, "host": host})
        return None
    except Exception as e:
        print(f"  ERR      | {label:<45} | {type(e).__name__}: {e}")
        results.append({"label": label, "status": "ERR", "error": str(e), "path": path, "host": host})
        return None


# ── METADATA API ──
print("=== METADATA API (PBI token) ===")
print(f"Host: {META}")
ws_data = test(META, "/metadata/workspaces", label="List workspaces")
test(META, "/metadata/folders", label="List folders (workspace create)")

WSID = "c40147b5-d369-407b-b5c0-7b080fb929bd"  # FMLVWS
LHID = "a96fdc44-a514-4abf-b73b-e691d3022500"  # TestLH

test(META, f"/metadata/workspaces/{WSID}/artifacts", label="List artifacts in workspace")
test(META, f"/metadata/artifacts/{LHID}", label="Get artifact by ID")
test(META, f"/metadata/artifacts/{LHID}/tables", label="List tables (metadata path)")
test(META, f"/metadata/access/folders/{WSID}", label="Workspace access/permissions")

# ── FABRIC v1 API (via redirect host) ──
print()
print("=== FABRIC v1 API (via redirect host, PBI token) ===")
v1_items = test(META, f"/v1/workspaces/{WSID}/items", label="List items in workspace (v1)")
test(META, f"/v1/workspaces/{WSID}/lakehouses", label="List lakehouses (v1)")
test(META, f"/v1/workspaces/{WSID}/lakehouses/{LHID}", label="Get lakehouse by ID (v1)")
test(META, f"/v1/workspaces/{WSID}/lakehouses/{LHID}/tables", label="List tables (v1)")

# Find a lakehouse in another workspace that might not have schemas enabled
if v1_items and "value" in v1_items:
    lakehouses = [i for i in v1_items["value"] if i.get("type") == "Lakehouse"]
    for lh in lakehouses:
        test(META, f"/v1/workspaces/{WSID}/lakehouses/{lh['id']}/tables", label=f"Tables: {lh['displayName']}")

# ── v1.0 Power BI API ──
print()
print("=== v1.0 POWER BI API (via redirect host, PBI token) ===")
test(META, "/v1.0/myorg/groups", label="List workspaces (v1.0)")

# ── MWC Token generation ──
print()
print("=== MWC TOKEN GENERATION ===")
mwc_body = json.dumps({
    "type": "[Start] GetMWCToken",
    "workloadType": "Lakehouse",
    "workspaceObjectId": WSID,
    "artifactObjectIds": [LHID],
    "capacityObjectId": "dd01a7f3-4198-4439-aae3-4eaf902281bb",
})
test(META, "/metadata/v201606/generatemwctoken", method="POST", body=mwc_body, label="Generate MWC token")

# ── Test RENAME / DELETE (read-only, don't actually execute) ──
print()
print("=== MUTATION ENDPOINTS (tested via PATCH/DELETE, expect results) ===")
# We'll test with a dummy rename — just verify the endpoint responds (even if 400)
test(META, f"/v1/workspaces/{WSID}", method="PATCH", body=json.dumps({"displayName": "FMLVWS"}), label="Rename workspace (v1 PATCH)")
test(META, f"/v1/workspaces/{WSID}/lakehouses/{LHID}", method="PATCH", body=json.dumps({"displayName": "TestLH"}), label="Rename lakehouse (v1 PATCH)")

# ── Fabric public API (different host, expect 401) ──
print()
print("=== FABRIC PUBLIC API (api.fabric.microsoft.com, PBI token — expect 401) ===")
FABRIC = "https://api.fabric.microsoft.com"
test(FABRIC, "/v1/workspaces", label="List workspaces (public)")

# ── Test other workspace items ──
print()
print("=== CROSS-WORKSPACE TABLE TESTS ===")
# psai_FLT_1
PSA_WS = "de3cc98a-fdd6-4a8e-965c-5b4b12af9d79"
psa_items = test(META, f"/v1/workspaces/{PSA_WS}/items", label="psai_FLT_1 items")
if psa_items and "value" in psa_items:
    for i in psa_items["value"]:
        if i.get("type") == "Lakehouse":
            test(META, f"/v1/workspaces/{PSA_WS}/lakehouses/{i['id']}/tables", label=f"Tables: {i['displayName']} (psai)")

# sravuri
SRA_WS = "e6467272-8d9b-4145-84f0-1f238637a583"
sra_items = test(META, f"/v1/workspaces/{SRA_WS}/items", label="sravuri items")
if sra_items and "value" in sra_items:
    for i in sra_items["value"]:
        if i.get("type") == "Lakehouse":
            test(META, f"/v1/workspaces/{SRA_WS}/lakehouses/{i['id']}/tables", label=f"Tables: {i['displayName']} (sravuri)")

# ── Summary ──
print()
print("=" * 80)
print("SUMMARY")
print("=" * 80)
ok = [r for r in results if r["status"] == "OK"]
fail = [r for r in results if r["status"] == "FAIL"]
err = [r for r in results if r["status"] == "ERR"]
print(f"  OK: {len(ok)}  |  FAIL: {len(fail)}  |  ERR: {len(err)}")

# Save full results
with open("docs/fabric-api-test-results.json", "w") as f:
    json.dump(results, f, indent=2)
print("\nFull results saved to docs/fabric-api-test-results.json")
