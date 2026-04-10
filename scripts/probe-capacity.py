"""Re-auth and probe capacity metrics APIs."""
import base64
import json
import ssl
import time
import urllib.request
import urllib.error
from pathlib import Path

# Step 1: Re-auth
print("=== Re-authenticating ===")
try:
    req = urllib.request.Request(
        "http://127.0.0.1:5555/api/edog/auth",
        data=json.dumps({"username": "Admin1CBA@FabricFMLV08PPE.ccsctp.net"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=30)
    data = json.loads(resp.read())
    print(f"  Auth OK - expires in {data.get('expiresIn', 0) // 60} min")
except Exception as e:
    print(f"  Auth FAILED: {e}")
    exit(1)

# Step 2: Read fresh bearer
time.sleep(1)
raw = Path(".edog-bearer-cache").read_text().strip()
_, bearer = base64.b64decode(raw.encode()).decode().split("|", 1)
print(f"  Bearer: {bearer[:40]}...")

# Step 3: Probe capacity endpoints
HOST = "https://biazure-int-edog-redirect.analysis-df.windows.net"
CAP = "dd01a7f3-4198-4439-aae3-4eaf902281bb"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

headers = {
    "Authorization": f"Bearer {bearer}",
    "Content-Type": "application/json",
    "x-powerbi-user-admin": "true",
}

endpoints = [
    ("/capacities/listandgethealthbyrollouts", "Health + utilization"),
    (f"/capacities/{CAP}/metrics", "Capacity metrics"),
    (f"/capacities/{CAP}/operationlog", "Operation log"),
    (f"/capacities/{CAP}/events", "Events"),
    (f"/capacities/{CAP}/operations", "Operations"),
    (f"/v1.0/myorg/capacities/{CAP}/Refreshables", "Refreshables"),
    (f"/v1.0/myorg/admin/capacities/{CAP}/refreshables", "Admin refreshables"),
    (f"/capacities/{CAP}/activityEvents", "Activity events"),
    (f"/metadata/capacities/{CAP}/utilization", "Utilization"),
    (f"/v1/admin/capacities/{CAP}", "Admin capacity detail"),
    (f"/capacities/{CAP}/workloads", "Workloads"),
    (f"/v1.0/myorg/capacities/{CAP}/Workloads", "v1.0 Workloads"),
]

print(f"\n=== Probing {len(endpoints)} endpoints ===\n")

for ep, label in endpoints:
    try:
        req = urllib.request.Request(HOST + ep, headers=headers)
        resp = urllib.request.urlopen(req, context=ctx, timeout=15)
        data = resp.read().decode()
        print(f"OK {resp.status} [{label}] {ep}")
        # Show first 500 chars of response
        print(f"  {data[:500]}")
        print()
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200] if e.readable() else ""
        print(f"ERR {e.code} [{label}] {ep}")
        if body:
            print(f"  {body[:200]}")
        print()
    except Exception as e:
        print(f"FAIL [{label}] {ep}: {e}")
        print()
