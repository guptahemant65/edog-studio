"""Tests for bearer token caching functions in edog.py."""

from __future__ import annotations

import base64
import importlib.util
import os
import time
from datetime import datetime
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Import edog module via importlib (same pattern as test_revert.py)
# ---------------------------------------------------------------------------
_edog_root = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("edog", _edog_root / "edog.py")
_edog = importlib.util.module_from_spec(_spec)

# edog.py touches cwd on import — preserve and restore
_original_cwd = os.getcwd()
os.chdir(str(_edog_root))
_spec.loader.exec_module(_edog)
os.chdir(_original_cwd)

# Re-export the functions under test
get_bearer_cache_path = _edog.get_bearer_cache_path
cache_bearer_token = _edog.cache_bearer_token
load_cached_bearer_token = _edog.load_cached_bearer_token


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestCacheBearerToken:
    """cache_bearer_token() should create the cache file correctly."""

    def test_cache_bearer_token_creates_file(self, tmp_path: Path) -> None:
        """Cache file must exist after a successful write."""
        token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.test.sig"
        expiry = time.time() + 3600

        result = cache_bearer_token(token, expiry, cache_dir=tmp_path)

        assert result is True
        cache_file = tmp_path / ".edog-bearer-cache"
        assert cache_file.exists()

        # Verify content round-trips through base64
        raw = base64.b64decode(cache_file.read_text(encoding="utf-8").encode()).decode()
        stored_expiry, stored_token = raw.split("|", 1)
        assert stored_token == token
        assert float(stored_expiry) == pytest.approx(expiry)


class TestLoadCachedBearerToken:
    """load_cached_bearer_token() should return valid tokens or (None, None)."""

    def test_load_bearer_token_valid(self, tmp_path: Path) -> None:
        """A freshly-cached token with future expiry should load correctly."""
        token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
        expiry = time.time() + 3600  # 1 hour from now

        cache_bearer_token(token, expiry, cache_dir=tmp_path)
        loaded_token, loaded_expiry = load_cached_bearer_token(cache_dir=tmp_path)

        assert loaded_token == token
        assert isinstance(loaded_expiry, datetime)
        assert loaded_expiry.timestamp() == pytest.approx(expiry)

    def test_load_bearer_token_expired(self, tmp_path: Path) -> None:
        """An expired token (past expiry minus 5-min buffer) returns None."""
        token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.expired.signature"
        # Expired 10 minutes ago — well past the 5-min buffer
        expiry = time.time() - 600

        cache_bearer_token(token, expiry, cache_dir=tmp_path)
        loaded_token, loaded_expiry = load_cached_bearer_token(cache_dir=tmp_path)

        assert loaded_token is None
        assert loaded_expiry is None

    def test_load_bearer_token_missing_file(self, tmp_path: Path) -> None:
        """When no cache file exists, return (None, None)."""
        loaded_token, loaded_expiry = load_cached_bearer_token(cache_dir=tmp_path)

        assert loaded_token is None
        assert loaded_expiry is None

    def test_load_bearer_token_corrupted_file(self, tmp_path: Path) -> None:
        """Corrupted cache file should return (None, None) and be cleaned up."""
        cache_file = tmp_path / ".edog-bearer-cache"
        cache_file.write_text("not-valid-base64!!!", encoding="utf-8")

        loaded_token, loaded_expiry = load_cached_bearer_token(cache_dir=tmp_path)

        assert loaded_token is None
        assert loaded_expiry is None
