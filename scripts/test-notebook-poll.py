"""Poll LRO results from notebook getDefinition and RunNotebook."""
import base64
import json
import ssl
import time
import urllib.request
import uuid
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
raw = (PROJECT_DIR / ".edog-bearer-cache").read_text().strip()
_, BEARER = base64.b64decode(raw.encode()).decode().split("|", 1)
CTX = ssl.create_default_context()
META = "https://biazure-int-edog-redirect.analysis-df.windows.net"

WSID = "1b20c810-b067-4b98-b418-935456c1256f"
NBID = "e1952851-641f-4dc6-8fae-3ac5a67aa3e4"


def req(method, path, body=None):
    url = META + path if not path.startswith("http") else path
    data = json.dumps(body).encode() if body else None
    h = {"Authorization": f"Bearer {BEARER}", "Content-Type": "application/json;charset=UTF-8",
         "activityid": str(uuid.uuid4()), "requestid": str(uuid.uuid4()),
         "x-powerbi-hostenv": "Power BI Web App",
         "origin": "https://powerbi-df.analysis-df.windows.net",
         "referer": "https://powerbi-df.analysis-df.windows.net/"}
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    return urllib.request.urlopen(r, timeout=30, context=CTX)


# 1. Get notebook definition (ipynb format)
print("=== 1. Get Notebook Definition ===")
try:
    resp = req("POST", f"/v1/workspaces/{WSID}/items/{NBID}/getDefinition?format=ipynb")
    status = resp.status
    location = resp.headers.get("Location", "")
    op_id = resp.headers.get("x-ms-operation-id", "")
    retry = resp.headers.get("Retry-After", "")
    body = resp.read().decode()
    print(f"  Status: {status}")
    print(f"  Location: {location}")
    print(f"  x-ms-operation-id: {op_id}")
    print(f"  Retry-After: {retry}")
    print(f"  Body: {body[:200]}")
    print(f"  All headers: {dict(resp.headers)}")

    # Poll the Location header for the result
    if location:
        print(f"\n  Polling {location}...")
        time.sleep(3)
        try:
            resp2 = req("GET", location)
            data = resp2.read().decode()
            parsed = json.loads(data) if data.strip() else {}
            if isinstance(parsed, dict):
                print(f"  Poll result keys: {list(parsed.keys())[:10]}")
                # Check for definition parts
                definition = parsed.get("definition", {})
                parts = definition.get("parts", [])
                if parts:
                    print(f"  Definition has {len(parts)} parts:")
                    for p in parts[:5]:
                        path_name = p.get("path", "?")
                        payload_len = len(p.get("payload", ""))
                        print(f"    - {path_name}  ({payload_len} chars)")
                        if "notebook" in path_name.lower() and payload_len > 0:
                            # Decode the notebook content
                            payload = p.get("payload", "")
                            try:
                                nb_content = base64.b64decode(payload).decode("utf-8")
                                nb_json = json.loads(nb_content)
                                cells = nb_json.get("cells", [])
                                print(f"    Notebook has {len(cells)} cells!")
                                for i, cell in enumerate(cells[:5]):
                                    cell_type = cell.get("cell_type", "?")
                                    source = "".join(cell.get("source", []))[:100]
                                    print(f"      Cell {i}: [{cell_type}] {source}")
                            except Exception as e:
                                print(f"    Decode error: {e}")
                                print(f"    Raw payload (first 200): {payload[:200]}")
                else:
                    print(f"  Full response: {json.dumps(parsed, indent=2)[:500]}")
            else:
                print(f"  Response: {data[:300]}")
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:200]
            print(f"  Poll FAIL {e.code}: {err}")
except urllib.error.HTTPError as e:
    print(f"  FAIL {e.code}: {e.read().decode()[:200]}")
except Exception as e:
    print(f"  ERR: {e}")

# 2. Check artifacts/definitions (the bulk endpoint)
print("\n=== 2. Artifacts Definitions (bulk) ===")
try:
    resp = req("GET", "/metadata/artifacts/definitions")
    data = json.loads(resp.read().decode())
    if isinstance(data, list):
        print(f"  {len(data)} definitions")
        # Find notebooks
        notebooks = [d for d in data if "notebook" in str(d.get("artifactType", "")).lower() or
                     "notebook" in str(d.get("type", "")).lower()]
        print(f"  Notebooks: {len(notebooks)}")
        if data:
            print(f"  First entry keys: {list(data[0].keys())[:8]}")
            print(f"  First entry: {json.dumps(data[0])[:300]}")
except Exception as e:
    print(f"  ERR: {e}")

# 3. Check RunNotebook job status
print("\n=== 3. Run Notebook Job (check if it ran) ===")
try:
    # List recent jobs for this item
    resp = req("GET", f"/v1/workspaces/{WSID}/items/{NBID}/jobs/instances")
    data = json.loads(resp.read().decode())
    jobs = data.get("value", data if isinstance(data, list) else [])
    print(f"  Jobs: {len(jobs)}")
    for j in jobs[:3]:
        print(f"  {json.dumps(j)[:250]}")
except urllib.error.HTTPError as e:
    print(f"  FAIL {e.code}: {e.read().decode()[:200]}")
except Exception as e:
    print(f"  ERR: {e}")

print("\nDone!")
