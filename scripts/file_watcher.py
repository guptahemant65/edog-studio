"""F13: File Change Detection — watches FLT Service/ directory for user code changes.

Polls the file system every N seconds, computes content hashes, and reports files
that differ from the deployed baseline. Excludes EDOG DevMode files and build output.

Thread-safe: all public methods acquire _lock before mutating state.

@author Vex — EDOG Studio hivemind
"""
from __future__ import annotations

import hashlib
import threading
from pathlib import Path

# Extensions we care about
WATCHED_EXTENSIONS = frozenset({".cs", ".json", ".csproj"})

# Directory segments to always exclude (case-insensitive comparison)
EXCLUDED_DIRS = frozenset({"devmode", "bin", "obj", ".vs", "testresults"})

# Files to always exclude by name
EXCLUDED_FILES = frozenset({".edog-changes.patch"})


def _file_hash(path: Path) -> str:
    """Compute MD5 hex digest of a file's content."""
    try:
        return hashlib.md5(path.read_bytes()).hexdigest()
    except (OSError, PermissionError):
        return ""


class FileWatcher:
    """Watches a directory for user file changes against a deployed baseline.

    Usage:
        watcher = FileWatcher("/path/to/Service")
        watcher.snapshot_deployed()  # Record baseline after deploy
        ...
        watcher.poll_changes()       # Check for changes (call periodically)
        result = watcher.get_changes()  # {"files": [...], "version": N}
        watcher.dismiss(version)     # Acknowledge through version N
    """

    def __init__(self, watch_dir: str) -> None:
        self._watch_dir = Path(watch_dir).resolve()
        self._lock = threading.Lock()
        self._deployed_hashes: dict[str, str] = {}  # resolved_path → hash
        self._current_hashes: dict[str, str] = {}  # resolved_path → current hash
        self._changed_files: list[str] = []  # relative paths
        self._version = 0
        self._dismissed_version = 0
        self._active = False

    def _scan_files(self) -> list[Path]:
        """Walk watch_dir and return all watched files, excluding EDOG/build dirs."""
        result = []
        if not self._watch_dir.is_dir():
            return result
        for path in self._watch_dir.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in WATCHED_EXTENSIONS:
                continue
            if path.name in EXCLUDED_FILES:
                continue
            # Check if any parent directory is excluded
            parts_lower = [p.lower() for p in path.relative_to(self._watch_dir).parts]
            if any(seg in EXCLUDED_DIRS for seg in parts_lower[:-1]):
                continue
            result.append(path)
        return result

    def snapshot_deployed(self) -> None:
        """Record content hashes of all watched files as the deployed baseline.

        Call this after a successful deploy completes.
        """
        with self._lock:
            self._deployed_hashes = {}
            self._current_hashes = {}
            self._changed_files = []
            self._version = 0
            self._dismissed_version = 0
            self._active = True
            for path in self._scan_files():
                key = str(path.resolve())
                self._deployed_hashes[key] = _file_hash(path)

    def poll_changes(self) -> list[str]:
        """Scan for files changed since deployed baseline. Returns relative paths.

        Call this periodically (e.g., every 3 seconds).
        """
        if not self._active:
            return []

        changed = []
        current_files = self._scan_files()
        new_hashes = {}

        with self._lock:
            for path in current_files:
                key = str(path.resolve())
                current_hash = _file_hash(path)
                if not current_hash:
                    continue
                new_hashes[key] = current_hash
                deployed_hash = self._deployed_hashes.get(key)
                if deployed_hash is None:
                    # New file created after deploy
                    rel = str(path.relative_to(self._watch_dir))
                    changed.append(rel)
                elif current_hash != deployed_hash:
                    # File content differs from deployed state
                    rel = str(path.relative_to(self._watch_dir))
                    changed.append(rel)

            # Increment version if files changed OR if same files have different hashes
            hashes_changed = new_hashes != self._current_hashes
            if changed != self._changed_files or (changed and hashes_changed):
                self._changed_files = changed
                self._current_hashes = new_hashes
                if changed:
                    self._version += 1

        return changed

    def get_changes(self) -> dict:
        """Return current changed files and version for the frontend.

        Returns {"files": [...], "version": N}.
        Files list is empty if version <= dismissed_version.
        """
        with self._lock:
            if self._version <= self._dismissed_version:
                return {"files": [], "version": self._version}
            return {
                "files": list(self._changed_files),
                "version": self._version,
            }

    def dismiss(self, version: int) -> None:
        """Acknowledge changes through the given version.

        Changes with version > dismissed_version will still appear.
        """
        with self._lock:
            if version >= self._dismissed_version:
                self._dismissed_version = version

    def is_active(self) -> bool:
        """Return True if the watcher has a deployed baseline."""
        with self._lock:
            return self._active

    def reset(self) -> None:
        """Clear all state. Used when undeploying or shutting down."""
        with self._lock:
            self._deployed_hashes = {}
            self._current_hashes = {}
            self._changed_files = []
            self._version = 0
            self._dismissed_version = 0
            self._active = False
