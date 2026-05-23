"""Strict-schema smoke test against gpt-5.4-pro via /responses endpoint (api-version=v1)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

REPO = Path(__file__).resolve().parents[1]


def load_env(p: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def call_responses(endpoint, deployment, key, api_ver, schema):
    url = endpoint.rstrip("/") + f"/openai/v1/responses?api-version={api_ver}"
    body = {
        "model": deployment,
        "input": "Produce one valid output per the schema.",
        "max_output_tokens": 200,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "smoke",
                "strict": True,
                "schema": schema,
            }
        },
    }
    req = urlrequest.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "api-key": key},
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode("utf-8")[:300]
    except urlerror.HTTPError as e:
        return e.code, e.read().decode("utf-8")[:400]


SCHEMA_A_ONEOF = {
    "type": "object",
    "additionalProperties": False,
    "required": ["pick"],
    "properties": {
        "pick": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["v"],
                    "properties": {"v": {"type": "string"}},
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["n"],
                    "properties": {"n": {"type": "integer"}},
                },
            ]
        }
    },
}

SCHEMA_B_ALLOF_IFTHEN = {
    "type": "object",
    "additionalProperties": False,
    "required": ["kind", "data"],
    "properties": {"kind": {"type": "string", "enum": ["a", "b"]}, "data": {"type": "object"}},
    "allOf": [
        {
            "if": {"properties": {"kind": {"const": "a"}}},
            "then": {"properties": {"data": {"required": ["v"], "properties": {"v": {"type": "string"}}}}},
        },
        {
            "if": {"properties": {"kind": {"const": "b"}}},
            "then": {"properties": {"data": {"required": ["n"], "properties": {"n": {"type": "integer"}}}}},
        },
    ],
}

SCHEMA_C_ANYOF = {
    "type": "object",
    "additionalProperties": False,
    "required": ["pick"],
    "properties": {
        "pick": {
            "anyOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["kind", "v"],
                    "properties": {"kind": {"type": "string", "const": "a"}, "v": {"type": "string"}},
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["kind", "n"],
                    "properties": {"kind": {"type": "string", "const": "b"}, "n": {"type": "integer"}},
                },
            ]
        }
    },
}

SCHEMA_D_COMPOSITE = {
    "type": "object",
    "additionalProperties": False,
    "required": ["topicField"],
    "properties": {
        "topicField": {"type": "string", "enum": ["http.method", "http.status", "log.level", "log.message"]}
    },
}

CASES = [
    ("A_oneOf", SCHEMA_A_ONEOF, "REJECTED"),
    ("B_allOf_ifthen", SCHEMA_B_ALLOF_IFTHEN, "REJECTED"),
    ("C_anyOf_control", SCHEMA_C_ANYOF, "ACCEPTED"),
    ("D_composite_enum", SCHEMA_D_COMPOSITE, "ACCEPTED"),
]


def main():
    env = load_env(REPO / ".env")
    ep = env["AZURE_OPENAI_ALT_ENDPOINT"]
    key = env["AZURE_OPENAI_ALT_API_KEY"]
    dep = env["AZURE_OPENAI_ALT_DEPLOYMENT"]
    ver = "v1"
    print(f"endpoint={ep}  deployment={dep}  api_version={ver}\n" + "-" * 80)
    all_ok = True
    for name, schema, expected in CASES:
        status, body = call_responses(ep, dep, key, ver, schema)
        actual = "ACCEPTED" if status == 200 else "REJECTED"
        ok = actual == expected
        all_ok = all_ok and ok
        mark = "✓" if ok else "✗"
        print(f"{mark} {name:22} expected={expected:10} actual={actual:10} (http {status})")
        if actual == "REJECTED":
            try:
                err = json.loads(body).get("error", {})
                print(f"   reason: {err.get('message', body)[:300]}")
            except Exception:
                print(f"   raw:    {body[:300]}")
    print("=" * 80)
    if all_ok:
        print("VERDICT: gpt-5.4-pro behaves IDENTICALLY to gpt-5.4 — oneOf/allOf rejected, anyOf/enum accepted.")
        sys.exit(0)
    else:
        print("VERDICT: gpt-5.4-pro DIFFERS from gpt-5.4 — see actuals above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
