"""Parse capacity health + rollout data."""
import urllib.request
import json
import ssl
import base64
import uuid
from pathlib import Path

raw = (Path(__file__).parent.parent / ".edog-bearer-cache").read_text().strip()
_, bearer = base64.b64decode(raw.encode()).decode().split("|", 1)
ctx = ssl.create_default_context()
META = "https://biazure-int-edog-redirect.analysis-df.windows.net"

h = {
    "Authorization": f"Bearer {bearer}",
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json",
    "activityid": str(uuid.uuid4()),
    "requestid": str(uuid.uuid4()),
    "x-powerbi-hostenv": "Power BI Web App",
    "x-powerbi-user-admin": "true",
    "origin": "https://powerbi-df.analysis-df.windows.net",
    "referer": "https://powerbi-df.analysis-df.windows.net/",
}
r = urllib.request.Request(META + "/capacities/listandgethealthbyrollouts", headers=h)
data = json.loads(urllib.request.urlopen(r, timeout=30, context=ctx).read().decode())

print("Top keys:", list(data.keys()))
print()

# Capacities metadata
caps = data.get("capacitiesMetadata", [])
print(f"capacitiesMetadata: {len(caps)} capacities")
for c in caps:
    cfg = c.get("configuration", {})
    lic = c.get("license", {})
    name = str(cfg.get("displayName") or "?")
    sku = str(cfg.get("sku") or "?")
    state = c.get("state", "?")
    vcores = lic.get("capacityNumberOfVCores", "?")
    mem = lic.get("capacityMemoryInGB", "?")
    region = str(lic.get("region") or "?")
    cid = str(c.get("capacityObjectId") or "?")[:12]
    mode = cfg.get("mode", "?")
    print(f"  {name:35s}  sku={sku:6s}  state={state}  vcores={vcores}  mem={mem}GB  mode={mode}  region={region}  id={cid}")

# Full keys of first capacity
print(f"\nFull keys of first capacity:")
if caps:
    print(f"  top: {list(caps[0].keys())}")
    print(f"  configuration: {list(caps[0].get('configuration', {}).keys())}")
    print(f"  license: {list(caps[0].get('license', {}).keys())}")

# Health
health = data.get("capacitiesHealth", [])
print(f"\ncapacitiesHealth: {len(health)} entries")
if health:
    print(f"  keys: {list(health[0].keys())[:10]}")
    # Show throttling/health data
    for h_entry in health[:3]:
        cid = h_entry.get("capacityObjectId", "?")[:12]
        throttled = h_entry.get("isThrottled", "?")
        health_score = h_entry.get("healthScore", "?")
        cu_usage = h_entry.get("cuUsagePercent", h_entry.get("cuUsage", "?"))
        print(f"  cap={cid}  throttled={throttled}  health={health_score}  cu={cu_usage}")
    # Full dump of first
    print(f"\n  First health entry (full):")
    print(f"  {json.dumps(health[0], indent=2)[:600]}")

# Rollout errors
errors = data.get("rolloutErrors", [])
print(f"\nrolloutErrors: {len(errors)} entries")
if errors:
    for e in errors[:3]:
        print(f"  {json.dumps(e)[:200]}")

# Save full response for reference
out = Path(__file__).parent.parent / "docs" / "capacity-health-response.json"
out.write_text(json.dumps(data, indent=2))
print(f"\nFull response saved to: {out}")
