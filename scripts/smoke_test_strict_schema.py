"""One-off smoke test: does Azure OpenAI Structured Output strict mode accept
`oneOf` / `allOf` / `if`/`then` keywords on the gpt-5.4 deployment we use?

Reads creds from .env. Sends four schema variants:

  A. Top-level `oneOf`        — expected to be REJECTED at schema registration.
  B. `allOf` + `if`/`then`     — expected to be REJECTED.
  C. `anyOf` with discriminator — expected to be ACCEPTED (control).
  D. Composite enum (`a.b`, `c.d`) — expected to be ACCEPTED (control).

Exit code 0 if reality matches the research finding; 1 otherwise.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib import request as urlrequest
from urllib import error as urlerror


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.is_file():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def call_azure(endpoint: str, deployment: str, api_key: str, api_version: str, schema: dict) -> tuple[int, str]:
    url = (
        endpoint.rstrip("/")
        + f"/openai/deployments/{deployment}/chat/completions"
        + f"?api-version={api_version}"
    )
    body = {
        "messages": [
            {"role": "system", "content": "You output a tiny JSON object per the schema."},
            {"role": "user", "content": "Produce one valid output."},
        ],
        "max_completion_tokens": 200,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "smoke",
                "strict": True,
                "schema": schema,
            },
        },
    }
    data = json.dumps(body).encode("utf-8")
    req = urlrequest.Request(
        url,
        data=data,
        method="POST",
        headers={
            "api-key": api_key,
            "content-type": "application/json",
        },
    )
    try:
        with urlrequest.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urlerror.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        return -1, repr(e)


SCHEMA_A_ONEOF = {
    "type": "object",
    "additionalProperties": False,
    "required": ["pick"],
    "properties": {
        "pick": {
            "oneOf": [
                {"type": "object", "additionalProperties": False, "required": ["kind", "v"],
                 "properties": {"kind": {"const": "a"}, "v": {"type": "string"}}},
                {"type": "object", "additionalProperties": False, "required": ["kind", "n"],
                 "properties": {"kind": {"const": "b"}, "n": {"type": "integer"}}},
            ]
        }
    },
}

SCHEMA_B_ALLOF_IFTHEN = {
    "type": "object",
    "additionalProperties": False,
    "required": ["topic", "field"],
    "properties": {
        "topic": {"enum": ["http", "log"]},
        "field": {"type": "string"},
    },
    "allOf": [
        {"if": {"properties": {"topic": {"const": "http"}}},
         "then": {"properties": {"field": {"enum": ["method", "status"]}}}},
        {"if": {"properties": {"topic": {"const": "log"}}},
         "then": {"properties": {"field": {"enum": ["level", "message"]}}}},
    ],
}

SCHEMA_C_ANYOF = {
    "type": "object",
    "additionalProperties": False,
    "required": ["pick"],
    "properties": {
        "pick": {
            "anyOf": [
                {"type": "object", "additionalProperties": False, "required": ["kind", "v"],
                 "properties": {"kind": {"type": "string", "const": "a"}, "v": {"type": "string"}}},
                {"type": "object", "additionalProperties": False, "required": ["kind", "n"],
                 "properties": {"kind": {"type": "string", "const": "b"}, "n": {"type": "integer"}}},
            ]
        }
    },
}

SCHEMA_D_COMPOSITE_ENUM = {
    "type": "object",
    "additionalProperties": False,
    "required": ["topicField"],
    "properties": {
        "topicField": {
            "enum": ["http.method", "http.status", "log.level", "log.message"]
        }
    },
}

TESTS = [
    ("A_oneOf",           SCHEMA_A_ONEOF,           "REJECTED"),
    ("B_allOf_ifthen",    SCHEMA_B_ALLOF_IFTHEN,    "REJECTED"),
    ("C_anyOf_control",   SCHEMA_C_ANYOF,           "ACCEPTED"),
    ("D_composite_enum",  SCHEMA_D_COMPOSITE_ENUM,  "ACCEPTED"),
]


def main() -> int:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    env = load_env(env_path)
    prefix = os.environ.get("SMOKE_ENV_PREFIX", "PRO")  # PRO=gpt-5.4, ALT=gpt-5.4-pro
    endpoint = env.get(f"AZURE_OPENAI_{prefix}_ENDPOINT") or env.get("AZURE_OPENAI_ENDPOINT")
    api_key = env.get(f"AZURE_OPENAI_{prefix}_API_KEY") or env.get("AZURE_OPENAI_API_KEY")
    api_version = env.get(f"AZURE_OPENAI_{prefix}_API_VERSION") or env.get("AZURE_OPENAI_API_VERSION") or "2024-08-01-preview"
    deployment = env.get(f"AZURE_OPENAI_{prefix}_DEPLOYMENT") or env.get("AZURE_OPENAI_DEPLOYMENT")
    if not (endpoint and api_key and deployment):
        print("MISSING_CONFIG: endpoint/api_key/deployment not in .env", file=sys.stderr)
        return 2
    print(f"endpoint={endpoint}  deployment={deployment}  api_version={api_version}")
    print("-" * 80)
    all_match = True
    for name, schema, expected in TESTS:
        status, body = call_azure(endpoint, deployment, api_key, api_version, schema)
        # 200 = accepted + completion; 400 = rejected (schema or other); other = transport/auth
        actual = "ACCEPTED" if status == 200 else "REJECTED" if status == 400 else f"OTHER({status})"
        match = "✓" if actual == expected else "✗"
        if actual != expected:
            all_match = False
        print(f"{match} {name:20s} expected={expected:9s} actual={actual:12s} (http {status})")
        if status != 200:
            # Print the rejection reason — that's the evidence
            try:
                err = json.loads(body)
                msg = err.get("error", {}).get("message") or body[:300]
            except Exception:  # noqa: BLE001
                msg = body[:300]
            print(f"   reason: {msg}")
        print()
    print("=" * 80)
    if all_match:
        print("VERDICT: research finding CONFIRMED — Azure strict mode rejects oneOf/allOf/if-then, accepts anyOf + composite enum.")
        return 0
    print("VERDICT: research finding CONTRADICTED — see actuals above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
