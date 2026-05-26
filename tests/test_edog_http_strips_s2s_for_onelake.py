"""Regression test pinning the OneLake DFS S2S-header strip in EdogHttpPipelineHandler.

Why this exists
---------------
OneLake DFS in EDOG (PPE / int-edog) rejects FLT's outbound calls when the
`x-ms-s2s-actor-authorization` header carries a token whose `appid` claim isn't
on its trusted-workload allowlist. Our S2S bypass mints user-delegated CBA
tokens with the dev-server's public client_id (FabricSparkCST, ea0616ba-...),
which OneLake refuses with:

    Untrusted client ID 'ea0616ba-638b-4df5-95b9-636659ae5121' with tenant ID
    '<tenant>' is not allowed

Minting the token with the FLT 1P workload id (f10a234d-...) fails earlier at
AAD with `AADSTS500113: No reply address is registered for the application`
because the FLT 1P app has no native-client redirect URI.

PLS is not enforced in EDOG, so the S2S header is decorative — the user
`Authorization` header alone is sufficient for OneLake to authorize. The fix
strips the S2S header from OneLake DFS requests inside
`EdogHttpPipelineHandler.SendAsync`.

These tests pin three invariants:
  1. The header name matches FLT's `HttpConstants.S2SAuthorizationHeaderKey`.
  2. The strip is wired into `SendAsync` (won't accidentally be moved into a
     dead code path or a method that nobody calls).
  3. The host-match is scoped to `.dfs.pbidedicated.` so we don't accidentally
     also strip the header from PBI Shared or GTS calls, which have their own
     trust paths and need it intact.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
HANDLER_PATH = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogHttpPipelineHandler.cs"
HTTPCONSTANTS_PATH = (
    Path(__file__).parent.parent.parent
    / "workload-fabriclivetable"
    / "Service"
    / "Microsoft.LiveTable.Service"
    / "Common"
    / "HttpConstants.cs"
)
EXPECTED_HEADER_NAME = "x-ms-s2s-actor-authorization"


@pytest.fixture(scope="module")
def handler_source() -> str:
    assert HANDLER_PATH.exists(), f"EdogHttpPipelineHandler.cs missing at {HANDLER_PATH}"
    return HANDLER_PATH.read_text(encoding="utf-8")


def test_handler_declares_s2s_header_constant(handler_source: str) -> None:
    """The handler must declare the S2S header name as a constant — no magic strings."""
    match = re.search(
        r'const\s+string\s+S2SActorAuthorizationHeader\s*=\s*"([^"]+)"\s*;',
        handler_source,
    )
    assert match is not None, (
        "EdogHttpPipelineHandler must declare a `S2SActorAuthorizationHeader` constant "
        "so the header name is centralised and discoverable."
    )
    assert match.group(1) == EXPECTED_HEADER_NAME, (
        f"S2SActorAuthorizationHeader is '{match.group(1)}', expected "
        f"'{EXPECTED_HEADER_NAME}'. This must match "
        f"`HttpConstants.S2SAuthorizationHeaderKey` in workload-fabriclivetable."
    )


def test_strip_method_exists_and_matches_onelake_dfs(handler_source: str) -> None:
    """The strip method must exist and scope its host match to OneLake DFS hosts only."""
    assert "StripS2SHeaderForOneLakeDfs" in handler_source, (
        "EdogHttpPipelineHandler must define StripS2SHeaderForOneLakeDfs."
    )
    assert "IsOneLakeDfsRequest" in handler_source, (
        "EdogHttpPipelineHandler must define IsOneLakeDfsRequest helper."
    )

    # The host-match substring must be `.dfs.pbidedicated.` — scoped enough to
    # match OneLake regional variants but tight enough that PBI Shared
    # (`*.analysis.windows-int.net`) and GTS endpoints are NOT matched.
    assert '".dfs.pbidedicated."' in handler_source, (
        "IsOneLakeDfsRequest must match on '.dfs.pbidedicated.' substring. A "
        "looser match could accidentally strip the S2S header from PBI Shared "
        "or other Fabric service calls that legitimately need it."
    )


def test_strip_invoked_from_send_async(handler_source: str) -> None:
    """The strip method must be CALLED from SendAsync, not just defined.

    Mutation-test: if a future change moves or deletes the call site, this
    asserts. We require the call to appear inside the `SendAsync` method body
    BEFORE the snapshot (STEP 1) so what's recorded matches what goes on the wire.
    """
    send_async_match = re.search(
        r"protected\s+override\s+async\s+Task<HttpResponseMessage>\s+SendAsync\s*\([^)]*\)\s*\{(.+?)\n        \}",
        handler_source,
        re.DOTALL,
    )
    assert send_async_match is not None, "Could not locate SendAsync method body"
    body = send_async_match.group(1)

    # The strip call must appear before the snapshot block (which begins with
    # `var method = request.Method.Method;`).
    strip_idx = body.find("StripS2SHeaderForOneLakeDfs(request)")
    snapshot_idx = body.find("var method = request.Method.Method")
    assert strip_idx >= 0, (
        "SendAsync must call StripS2SHeaderForOneLakeDfs(request). Without this "
        "call the strip method is dead code and OneLake will keep rejecting "
        "requests with 'Untrusted client ID'."
    )
    assert snapshot_idx >= 0, "SendAsync snapshot anchor not found"
    assert strip_idx < snapshot_idx, (
        "StripS2SHeaderForOneLakeDfs(request) must be called BEFORE the request "
        "snapshot so the captured headers reflect what actually leaves the process."
    )


def test_header_constant_stays_in_sync_with_flt_httpconstants() -> None:
    """The header literal in EDOG must match HttpConstants.S2SAuthorizationHeaderKey in FLT.

    If FLT renames the constant upstream, the strip silently stops working —
    requests would still go out with the (renamed) header and OneLake would
    keep rejecting them. This guards against that drift.
    """
    if not HTTPCONSTANTS_PATH.exists():
        pytest.skip(
            f"FLT HttpConstants.cs not found at {HTTPCONSTANTS_PATH} — skipping cross-repo "
            "drift check. Run the test with the workload-fabriclivetable repo cloned."
        )
    flt_src = HTTPCONSTANTS_PATH.read_text(encoding="utf-8")
    match = re.search(
        r'S2SAuthorizationHeaderKey\s*=\s*"([^"]+)"\s*;',
        flt_src,
    )
    assert match is not None, (
        "Could not find S2SAuthorizationHeaderKey in FLT HttpConstants.cs — "
        "the constant may have been renamed. Update the EDOG handler accordingly."
    )
    assert match.group(1) == EXPECTED_HEADER_NAME, (
        f"FLT HttpConstants.S2SAuthorizationHeaderKey is now '{match.group(1)}' "
        f"but EDOG strips '{EXPECTED_HEADER_NAME}'. Update "
        "EdogHttpPipelineHandler.S2SActorAuthorizationHeader to match."
    )
