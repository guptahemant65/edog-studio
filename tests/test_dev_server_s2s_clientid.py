"""Regression tests pinning the FLT 1P client_id wiring for the S2S bypass mint path.

OneLake DFS (and the PBI Shared S2S endpoints) reject tokens whose `appid` claim
is not on their trusted-workload allowlist. Until 2026-05-26 the dev-server
minted S2S-bypass tokens with `TOKEN_HELPER_CLIENT_ID` (FabricSparkCST), which
produced the production error:

    Untrusted client ID 'ea0616ba-638b-4df5-95b9-636659ae5121' with tenant ID
    '4560a712-5763-44ca-bd40-82c36cc58ad0' is not allowed

The fix mints the S2S-bypass tokens with `FLT_FIRSTPARTY_CLIENT_ID`
(`f10a234d-51d4-434e-9324-0553112ff091`) — the FLT 1P workload app, which
OneLake already trusts because the FLT service normally calls OneLake with it.

The UI-side OneLake bearer (`_ensure_onelake_bearer`) MUST stay on the default
TOKEN_HELPER_CLIENT_ID — it is used for user-Authorization-only filesystem
calls where the appid allowlist is not in play, and we want to minimise blast
radius. Trust paths stay separate.

These tests parse the dev-server source so we don't need to import the module
(which would require the full HTTP server bootstrap).
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

DEV_SERVER = Path(__file__).parent.parent / "scripts" / "dev-server.py"
FLT_1P_APP_ID = "f10a234d-51d4-434e-9324-0553112ff091"
FABRIC_SPARK_CST_APP_ID = "ea0616ba-638b-4df5-95b9-636659ae5121"


@pytest.fixture(scope="module")
def source() -> str:
    return DEV_SERVER.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def tree(source: str) -> ast.AST:
    return ast.parse(source)


def _find_func(tree: ast.AST, name: str) -> ast.FunctionDef | None:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    return None


def test_flt_firstparty_client_id_constant_is_defined(source: str) -> None:
    """The FLT 1P app id constant must be defined with the exact published UUID.

    Source of truth: `FirstPartyApplicationId` in FLT's ParametersManifest.json.
    If the FLT 1P app id ever changes upstream this test will need an update;
    that is intentional — it forces re-verification that OneLake's allowlist
    still includes the new id.
    """
    match = re.search(
        r'^FLT_FIRSTPARTY_CLIENT_ID\s*=\s*"([0-9a-fA-F-]+)"\s*$',
        source,
        re.MULTILINE,
    )
    assert match is not None, "FLT_FIRSTPARTY_CLIENT_ID constant missing"
    assert match.group(1) == FLT_1P_APP_ID, (
        f"FLT_FIRSTPARTY_CLIENT_ID is '{match.group(1)}', expected '{FLT_1P_APP_ID}'. "
        "If the FLT 1P app id has legitimately changed, update this test AND verify "
        "OneLake DFS's trusted-workload list still includes the new id."
    )


def test_token_helper_client_id_stays_fabric_spark_cst(source: str) -> None:
    """TOKEN_HELPER_CLIENT_ID (UI bearer) must NOT be silently switched to FLT 1P.

    The UI auth path mints PBI bearers with FabricSparkCST and has been
    stable; the S2S fix is intentionally scoped to the bypass mint path only.
    """
    match = re.search(
        r'^TOKEN_HELPER_CLIENT_ID\s*=\s*"([0-9a-fA-F-]+)"\s*$',
        source,
        re.MULTILINE,
    )
    assert match is not None, "TOKEN_HELPER_CLIENT_ID constant missing"
    assert match.group(1) == FABRIC_SPARK_CST_APP_ID, (
        f"TOKEN_HELPER_CLIENT_ID changed to '{match.group(1)}'. The UI bearer "
        "path was deliberately left on FabricSparkCST; if you intend to change "
        "it, update this test and verify the PBI Portal flow still works."
    )


def test_ensure_onelake_s2s_bearer_function_exists(tree: ast.AST) -> None:
    """The dedicated S2S OneLake bearer helper must exist as a top-level function."""
    fn = _find_func(tree, "_ensure_onelake_s2s_bearer")
    assert fn is not None, (
        "_ensure_onelake_s2s_bearer is missing — the S2S endpoint must mint "
        "tokens with the FLT 1P client_id via a dedicated helper to keep the "
        "trust path isolated from the UI bearer."
    )


def test_ensure_onelake_s2s_bearer_uses_flt_firstparty_client_id(source: str) -> None:
    """_ensure_onelake_s2s_bearer must mint with client_id=FLT_FIRSTPARTY_CLIENT_ID."""
    match = re.search(
        r"def\s+_ensure_onelake_s2s_bearer\b.*?(?=^def\s|\Z)",
        source,
        re.MULTILINE | re.DOTALL,
    )
    assert match is not None, "Could not isolate _ensure_onelake_s2s_bearer body"
    body = match.group(0)

    assert "_mint_token_for_resource(" in body, (
        "_ensure_onelake_s2s_bearer must call _mint_token_for_resource"
    )
    assert "client_id=FLT_FIRSTPARTY_CLIENT_ID" in body, (
        "_ensure_onelake_s2s_bearer must pass client_id=FLT_FIRSTPARTY_CLIENT_ID. "
        "Without this, OneLake DFS rejects the token with 'Untrusted client ID'."
    )


def test_s2s_endpoint_routes_onelake_resource_through_s2s_bearer(source: str) -> None:
    """`/api/edog/s2s-token?resource=https://storage.azure.com` must use the S2S helper.

    The original bug was that the endpoint shared the UI cache via
    `_ensure_onelake_bearer`, which served a FabricSparkCST-minted token to FLT.
    The dedicated S2S helper enforces the FLT 1P appid.
    """
    match = re.search(
        r"def\s+_serve_s2s_token\b.*?(?=\n    def\s|\Z)",
        source,
        re.MULTILINE | re.DOTALL,
    )
    assert match is not None, "Could not isolate _serve_s2s_token body"
    body = match.group(0)

    onelake_branch = re.search(
        r"if\s+resource\s*==\s*ONELAKE_RESOURCE\s*:(.*?)else\s*:",
        body,
        re.DOTALL,
    )
    assert onelake_branch is not None, "_serve_s2s_token ONELAKE_RESOURCE branch not found"
    onelake_body = onelake_branch.group(1)
    assert "_ensure_onelake_s2s_bearer()" in onelake_body, (
        "ONELAKE_RESOURCE branch of _serve_s2s_token must call "
        "_ensure_onelake_s2s_bearer (not _ensure_onelake_bearer). The latter "
        "serves the UI cache and would re-introduce the appid mismatch."
    )


def test_s2s_endpoint_pbi_shared_mint_uses_flt_firstparty_client_id(source: str) -> None:
    """The non-ONELAKE_RESOURCE branch (PBI Shared) must mint with FLT 1P client_id."""
    match = re.search(
        r"def\s+_serve_s2s_token\b.*?(?=\n    def\s|\Z)",
        source,
        re.MULTILINE | re.DOTALL,
    )
    assert match is not None
    body = match.group(0)

    else_branch = re.search(
        r"else\s*:\s*\n(.*?)(?=\n            print\(|\n        except\b)",
        body,
        re.DOTALL,
    )
    assert else_branch is not None, "_serve_s2s_token else-branch not found"
    else_body = else_branch.group(1)
    assert "_mint_token_for_resource(" in else_body, (
        "Non-ONELAKE branch must call _mint_token_for_resource"
    )
    assert "client_id=FLT_FIRSTPARTY_CLIENT_ID" in else_body, (
        "Non-ONELAKE S2S audiences (PBI Shared, etc.) must also mint with "
        "client_id=FLT_FIRSTPARTY_CLIENT_ID so their appid claim is on the "
        "trusted-workload allowlist."
    )


def test_separate_cache_paths_for_ui_and_s2s(source: str) -> None:
    """UI bearer and S2S bearer must use distinct cache files.

    Sharing a cache file would defeat the trust-path isolation — a stale entry
    from one path would be served to the other and re-introduce the bug.
    """
    ui_cache = re.search(
        r'^ONELAKE_BEARER_CACHE\s*=\s*PROJECT_DIR\s*/\s*"([^"]+)"',
        source,
        re.MULTILINE,
    )
    s2s_cache = re.search(
        r'^ONELAKE_S2S_CACHE\s*=\s*PROJECT_DIR\s*/\s*"([^"]+)"',
        source,
        re.MULTILINE,
    )
    assert ui_cache is not None, "ONELAKE_BEARER_CACHE not defined"
    assert s2s_cache is not None, "ONELAKE_S2S_CACHE not defined"
    assert ui_cache.group(1) != s2s_cache.group(1), (
        "ONELAKE_BEARER_CACHE and ONELAKE_S2S_CACHE must be distinct files. "
        "They hold tokens with different appid claims; sharing them would "
        "cause the S2S endpoint to serve a FabricSparkCST-minted token to FLT."
    )
