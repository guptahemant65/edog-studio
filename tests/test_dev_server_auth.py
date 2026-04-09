"""Tests for EDOG auth API endpoints."""
import json
import subprocess
from pathlib import Path

HELPER_DIRS = [
    Path(__file__).parent.parent / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe",
    Path(__file__).parent.parent / "scripts" / "token-helper" / "bin" / "Debug" / "net472" / "token-helper.exe",
]


def _find_helper():
    for p in HELPER_DIRS:
        if p.exists():
            return p
    return None


def test_token_helper_list_certs():
    """token-helper --list-certs returns valid JSON array."""
    helper = _find_helper()
    if not helper:
        import pytest
        pytest.skip("token-helper not built")
    result = subprocess.run([str(helper), "--list-certs"], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, f"stderr: {result.stderr}"
    certs = json.loads(result.stdout)
    assert isinstance(certs, list)
    assert len(certs) > 0, "No CBA certs found"
    cert = certs[0]
    assert "thumbprint" in cert
    assert "cn" in cert
    assert "notAfter" in cert
    assert len(cert["thumbprint"]) == 40


def test_token_helper_silent_cba():
    """token-helper acquires a bearer token via Silent CBA."""
    helper = _find_helper()
    if not helper:
        import pytest
        pytest.skip("token-helper not built")
    result = subprocess.run(
        [str(helper), "6921EC59777B2667C9B0BD4B82FA09F1077AB973",
         "Admin1CBA@FabricFMLV08PPE.ccsctp.net"],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    token = result.stdout.strip()
    assert token.startswith("eyJ"), "Token should be a JWT"
    assert len(token) > 500, f"Token too short: {len(token)}"
