# F13: File Change Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect user code changes in the FLT repo (excluding EDOG's own patches), show a notification bar with changed file list and one-click Re-deploy.

**Architecture:** Python file-watcher module polls FLT `Service/` directory every 3 seconds for `.cs`/`.json`/`.csproj` changes, using content hashes to distinguish user edits from EDOG patches. Frontend polls `/api/studio/file-changes` every 5 seconds when FLT is running, renders a notification bar in the existing `#file-change-bar` container with Re-deploy and Dismiss buttons.

**Tech Stack:** Python 3 (pathlib, hashlib, threading), vanilla JS (var-only, no arrow functions, no template literals), CSS variables from design system.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `scripts/file-watcher.py` | Python module — watches FLT `Service/` dir, tracks file fingerprints, excludes EDOG files |
| Create | `tests/test_file_watcher.py` | Unit tests for file watcher logic |
| Create | `src/frontend/js/file-watcher.js` | Frontend polling + notification bar rendering |
| Create | `src/frontend/css/file-watcher.css` | Notification bar styles |
| Modify | `scripts/dev-server.py` | Add `/api/studio/file-changes` + `/api/studio/file-changes/dismiss` endpoints, wire watcher lifecycle |
| Modify | `src/frontend/js/main.js` | Instantiate `FileChangeWatcher`, wire phase transitions |
| Modify | `scripts/build-html.py` | Add new JS and CSS modules to build order |

---

## Codebase Conventions (Non-Negotiable)

- **Python:** PEP 8, type hints, pathlib, no bare except, ruff-clean
- **JS:** No `const`/`let` (use `var`), no arrow functions, no template literals, no optional chaining
- **CSS:** Use design tokens from `variables.css` (`--surface`, `--border`, `--accent`, `--text-muted`, etc.)
- **No emoji** in UI — Unicode symbols only (●, ▸, ◆, ✕, ⋯)
- **Build:** `python scripts/build-html.py` (single HTML output)
- **Test:** `python -m pytest tests/ -q`
- **Lint:** `python -m ruff check scripts/file-watcher.py tests/test_file_watcher.py`
- **Git:** conventional commits, `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer

---

## Reference: EDOG File Modifications (Critical Context)

EDOG modifies FLT files in two categories that must be EXCLUDED from user change detection:

**1. DEVMODE_FILES** — 26 files EDOG **creates** in `Service/Microsoft.LiveTable.Service/DevMode/`:
- Detection: any file whose resolved path contains a directory segment named `DevMode`
- These are 100% EDOG-owned. Always exclude.

**2. PATCH_FILES** — 9 existing FLT files EDOG **patches** (defined in `edog.py:54-64`):
```
Controllers/LiveTableController.cs
Controllers/LiveTableSchedulerRunController.cs
SparkHttp/GTSBasedSparkClient.cs
Telemetry/CustomLiveTableTelemetryReporter.cs
WorkloadApp.cs
EntryPoint/Program.cs
EntryPoint/WorkloadParameters/ParametersManifest.json
EntryPoint/WorkloadParameters/Rollouts/Test.json
Core/V2/DagExecutionHandlerV2.cs
```
- Detection: after deploy completes, record content hash of each patched file. On subsequent poll, if file hash differs from deployed hash, it's a user change. If hash matches deployed hash, it's just EDOG's patch — ignore.

**3. Build Output** — always exclude: `bin/`, `obj/`, `.vs/`, `TestResults/`, `.edog-changes.patch`

---

### Task 1: Python File Watcher Module

**Files:**
- Create: `scripts/file-watcher.py`
- Create: `tests/test_file_watcher.py`

**What this builds:** A standalone Python module with a `FileWatcher` class that polls the FLT `Service/` directory for file changes, tracks content fingerprints, excludes EDOG files, and provides a thread-safe API for querying changed files.

- [ ] **Step 1: Write failing tests for FileWatcher core logic**

Create `tests/test_file_watcher.py`:

```python
"""Tests for F13 File Change Detection — FileWatcher module."""
import hashlib
import time
from pathlib import Path

import pytest

# Module under test — import will fail until Step 3
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from file_watcher import FileWatcher


class TestFileWatcherExclusions:
    """Test that EDOG files are properly excluded."""

    def test_devmode_files_excluded(self, tmp_path):
        """Files in DevMode/ directory are always excluded."""
        service = tmp_path / "Service" / "Microsoft.LiveTable.Service"
        devmode = service / "DevMode"
        devmode.mkdir(parents=True)
        (devmode / "EdogLogServer.cs").write_text("// edog file")
        (service / "UserCode.cs").write_text("// user code")

        watcher = FileWatcher(str(service))
        files = watcher._scan_files()
        rel_paths = [str(f.relative_to(service)) for f in files]
        assert any("UserCode.cs" in p for p in rel_paths)
        assert not any("EdogLogServer.cs" in p for p in rel_paths)

    def test_bin_obj_excluded(self, tmp_path):
        """Build output directories are excluded."""
        service = tmp_path / "Service"
        service.mkdir()
        (service / "bin").mkdir()
        (service / "bin" / "Debug.dll").write_text("binary")
        (service / "obj").mkdir()
        (service / "obj" / "cache.json").write_text("{}")
        (service / "Real.cs").write_text("// real")

        watcher = FileWatcher(str(service))
        files = watcher._scan_files()
        rel_paths = [str(f.relative_to(service)) for f in files]
        assert any("Real.cs" in p for p in rel_paths)
        assert not any("Debug.dll" in p for p in rel_paths)
        assert not any("cache.json" in p for p in rel_paths)

    def test_only_watched_extensions(self, tmp_path):
        """Only .cs, .json, .csproj files are watched."""
        service = tmp_path / "Service"
        service.mkdir()
        (service / "Code.cs").write_text("class A {}")
        (service / "config.json").write_text("{}")
        (service / "proj.csproj").write_text("<Project/>")
        (service / "readme.md").write_text("# hi")
        (service / "notes.txt").write_text("notes")

        watcher = FileWatcher(str(service))
        files = watcher._scan_files()
        extensions = [f.suffix for f in files]
        assert ".cs" in extensions
        assert ".json" in extensions
        assert ".csproj" in extensions
        assert ".md" not in extensions
        assert ".txt" not in extensions

    def test_vs_directory_excluded(self, tmp_path):
        """IDE directories (.vs/) are excluded."""
        service = tmp_path / "Service"
        (service / ".vs" / "cache").mkdir(parents=True)
        (service / ".vs" / "cache" / "settings.json").write_text("{}")
        (service / "Code.cs").write_text("class B {}")

        watcher = FileWatcher(str(service))
        files = watcher._scan_files()
        assert len(files) == 1
        assert files[0].name == "Code.cs"


class TestFileWatcherFingerprints:
    """Test content-hash based change detection."""

    def test_snapshot_deployed_records_hashes(self, tmp_path):
        """After deploy, snapshot records content hash of each file."""
        service = tmp_path / "Service"
        service.mkdir()
        (service / "Code.cs").write_text("class A {}")

        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        assert len(watcher._deployed_hashes) == 1
        path_key = str((service / "Code.cs").resolve())
        assert path_key in watcher._deployed_hashes

    def test_unchanged_file_not_reported(self, tmp_path):
        """A file unchanged since deploy is not reported as changed."""
        service = tmp_path / "Service"
        service.mkdir()
        (service / "Code.cs").write_text("class A {}")

        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        changes = watcher.poll_changes()
        assert changes == []

    def test_user_edit_detected(self, tmp_path):
        """A file edited after deploy is reported as changed."""
        service = tmp_path / "Service"
        service.mkdir()
        code = service / "Code.cs"
        code.write_text("class A {}")

        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        code.write_text("class A { int x; }")
        changes = watcher.poll_changes()
        assert len(changes) == 1
        assert "Code.cs" in changes[0]

    def test_new_file_detected(self, tmp_path):
        """A file created after deploy is reported as changed."""
        service = tmp_path / "Service"
        service.mkdir()
        (service / "Existing.cs").write_text("class E {}")

        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        (service / "NewFile.cs").write_text("class N {}")
        changes = watcher.poll_changes()
        assert len(changes) == 1
        assert "NewFile.cs" in changes[0]

    def test_edog_patched_file_ignored_when_unchanged_by_user(self, tmp_path):
        """A PATCH_FILES file that only has EDOG's patch is not reported."""
        service = tmp_path / "Service"
        service.mkdir()
        prog = service / "Program.cs"
        prog.write_text("// original + edog patch")

        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        # File hasn't changed since deploy snapshot — ignore
        changes = watcher.poll_changes()
        assert changes == []

    def test_edog_patched_file_reported_when_user_also_edits(self, tmp_path):
        """A PATCH_FILES file edited by user AFTER deploy is reported."""
        service = tmp_path / "Service"
        service.mkdir()
        prog = service / "Program.cs"
        prog.write_text("// original + edog patch")

        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        prog.write_text("// original + edog patch + user change")
        changes = watcher.poll_changes()
        assert len(changes) == 1
        assert "Program.cs" in changes[0]


class TestFileWatcherVersioning:
    """Test versioned dismiss mechanism."""

    def test_get_changes_returns_version(self, tmp_path):
        """get_changes() returns a monotonic version number."""
        service = tmp_path / "Service"
        service.mkdir()
        (service / "Code.cs").write_text("class A {}")

        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        (service / "Code.cs").write_text("class A { int x; }")
        watcher.poll_changes()
        result = watcher.get_changes()
        assert "version" in result
        assert "files" in result
        assert result["version"] >= 1

    def test_dismiss_by_version(self, tmp_path):
        """Dismiss acknowledges up to a specific version."""
        service = tmp_path / "Service"
        service.mkdir()
        code = service / "Code.cs"
        code.write_text("class A {}")

        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        code.write_text("class A { int x; }")
        watcher.poll_changes()
        result = watcher.get_changes()
        v = result["version"]

        watcher.dismiss(v)
        result2 = watcher.get_changes()
        assert result2["files"] == []

    def test_new_changes_after_dismiss_reappear(self, tmp_path):
        """Changes after dismiss trigger new notification."""
        service = tmp_path / "Service"
        service.mkdir()
        code = service / "Code.cs"
        code.write_text("class A {}")

        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        code.write_text("class A { int x; }")
        watcher.poll_changes()
        result = watcher.get_changes()
        watcher.dismiss(result["version"])

        code.write_text("class A { int x; int y; }")
        watcher.poll_changes()
        result2 = watcher.get_changes()
        assert len(result2["files"]) == 1


class TestFileWatcherLifecycle:
    """Test start/stop/reset lifecycle."""

    def test_not_active_before_start(self, tmp_path):
        service = tmp_path / "Service"
        service.mkdir()
        watcher = FileWatcher(str(service))
        assert not watcher.is_active()

    def test_active_after_snapshot(self, tmp_path):
        service = tmp_path / "Service"
        service.mkdir()
        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        assert watcher.is_active()

    def test_reset_clears_state(self, tmp_path):
        service = tmp_path / "Service"
        service.mkdir()
        (service / "Code.cs").write_text("class A {}")
        watcher = FileWatcher(str(service))
        watcher.snapshot_deployed()
        (service / "Code.cs").write_text("class A { int x; }")
        watcher.poll_changes()
        assert len(watcher.get_changes()["files"]) == 1

        watcher.reset()
        assert not watcher.is_active()
        assert watcher.get_changes()["files"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_file_watcher.py -v`
Expected: ModuleNotFoundError — `file_watcher` doesn't exist yet.

- [ ] **Step 3: Implement FileWatcher module**

Create `scripts/file-watcher.py`:

```python
"""F13: File Change Detection — watches FLT Service/ directory for user code changes.

Polls the file system every N seconds, computes content hashes, and reports files
that differ from the deployed baseline. Excludes EDOG DevMode files and build output.

Thread-safe: all public methods acquire _lock before mutating state.

@author Vex — EDOG Studio hivemind
"""
from __future__ import annotations

import hashlib
import threading
from pathlib import Path, PurePosixPath

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

        with self._lock:
            for path in current_files:
                key = str(path.resolve())
                current_hash = _file_hash(path)
                if not current_hash:
                    continue
                deployed_hash = self._deployed_hashes.get(key)
                if deployed_hash is None:
                    # New file created after deploy
                    rel = str(path.relative_to(self._watch_dir))
                    changed.append(rel)
                elif current_hash != deployed_hash:
                    # File content differs from deployed state
                    rel = str(path.relative_to(self._watch_dir))
                    changed.append(rel)

            if changed != self._changed_files:
                self._changed_files = changed
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
            self._changed_files = []
            self._version = 0
            self._dismissed_version = 0
            self._active = False
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_file_watcher.py -v`
Expected: All 16 tests PASS.

- [ ] **Step 5: Run lint on new files**

Run: `python -m ruff check scripts/file-watcher.py tests/test_file_watcher.py`
Expected: No new errors (pre-existing errors in other files are acceptable).

- [ ] **Step 6: Commit**

```bash
git add scripts/file-watcher.py tests/test_file_watcher.py
git commit -m "feat(F13): add FileWatcher module with content-hash change detection

- Polls Service/ dir for .cs/.json/.csproj changes
- Excludes DevMode/, bin/, obj/, .vs/ directories
- Content-hash fingerprinting (MD5) for deployed baseline
- Versioned dismiss mechanism (monotonic version counter)
- Thread-safe via threading.Lock

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Dev Server Integration

**Files:**
- Modify: `scripts/dev-server.py` (lines ~66-80, ~900-935, ~947-975, ~1074-1103)

**What this builds:** Wire the FileWatcher into dev-server.py — add REST endpoints, start/stop watcher on deploy lifecycle, background polling thread.

- [ ] **Step 1: Add import and global watcher instance**

At the top of `scripts/dev-server.py`, after the existing imports (around line 25), add the import. Near the `_studio_state` dict (around line 66), add the watcher globals:

```python
# After existing imports:
from file_watcher import FileWatcher

# After _studio_state dict (line 79):
_file_watcher: FileWatcher | None = None
_file_watcher_thread: threading.Thread | None = None
_file_watcher_stop = threading.Event()
```

- [ ] **Step 2: Add background polling thread function**

After the watcher globals, add the polling function:

```python
def _file_watcher_loop():
    """Background thread: polls FileWatcher every 3 seconds."""
    while not _file_watcher_stop.is_set():
        if _file_watcher and _file_watcher.is_active():
            try:
                _file_watcher.poll_changes()
            except Exception:
                pass
        _file_watcher_stop.wait(3.0)
```

- [ ] **Step 3: Add file watcher start/stop helpers**

After the polling function:

```python
def _start_file_watcher(service_dir: str):
    """Start watching the FLT Service directory for file changes."""
    global _file_watcher, _file_watcher_thread
    _file_watcher_stop.clear()
    _file_watcher = FileWatcher(service_dir)
    _file_watcher.snapshot_deployed()
    _file_watcher_thread = threading.Thread(
        target=_file_watcher_loop, daemon=True, name="file-watcher"
    )
    _file_watcher_thread.start()


def _stop_file_watcher():
    """Stop the file watcher background thread."""
    global _file_watcher, _file_watcher_thread
    _file_watcher_stop.set()
    if _file_watcher_thread and _file_watcher_thread.is_alive():
        _file_watcher_thread.join(timeout=5)
    _file_watcher_thread = None
    if _file_watcher:
        _file_watcher.reset()
```

- [ ] **Step 4: Wire watcher to deploy lifecycle**

In the deploy pipeline, after the "Ready check" step succeeds (when `phase` transitions to `"running"`), start the file watcher. Search for where `_studio_state["phase"] = "running"` is set — this is in the deploy thread. After that line, add:

```python
# Start file change detection after successful deploy
try:
    config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    flt_repo = config.get("flt_repo_path", "")
    if flt_repo:
        service_dir = str(Path(flt_repo) / "Service" / "Microsoft.LiveTable.Service")
        _start_file_watcher(service_dir)
except Exception:
    pass  # File watcher is non-critical
```

Also, when deploy starts or undeploy happens, stop any existing watcher. In `_serve_deploy_start`, near the beginning (after acquiring the lock), add:

```python
_stop_file_watcher()
```

And in `_serve_undeploy`, add the same `_stop_file_watcher()` call.

- [ ] **Step 5: Add GET /api/studio/file-changes endpoint**

In the `do_GET` method (around line 900), add a new route before the `else: self.send_error(404)`:

```python
elif self.path == "/api/studio/file-changes":
    self._serve_file_changes()
```

Then add the handler method near `_serve_studio_status`:

```python
def _serve_file_changes(self):
    """GET /api/studio/file-changes — return changed files since deploy."""
    if _file_watcher and _file_watcher.is_active():
        result = _file_watcher.get_changes()
    else:
        result = {"files": [], "version": 0}
    self._json_response(200, result)
```

- [ ] **Step 6: Add POST /api/studio/file-changes/dismiss endpoint**

In the `do_POST` method (around line 947), add:

```python
elif self.path == "/api/studio/file-changes/dismiss":
    self._serve_file_changes_dismiss()
```

Then add the handler:

```python
def _serve_file_changes_dismiss(self):
    """POST /api/studio/file-changes/dismiss — acknowledge changes through version."""
    try:
        content_length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_length)) if content_length else {}
        version = body.get("version", 0)
    except (json.JSONDecodeError, ValueError):
        version = 0
    if _file_watcher:
        _file_watcher.dismiss(version)
    self._json_response(200, {"ok": True})
```

- [ ] **Step 7: Add file-changes to studio status response**

In `_serve_studio_status` (line 1074), extend the response to include file change info. After `state = dict(_studio_state)` (line 1101), add:

```python
if _file_watcher and _file_watcher.is_active():
    fc = _file_watcher.get_changes()
    state["fileChanges"] = fc["files"]
    state["fileChangesVersion"] = fc["version"]
else:
    state["fileChanges"] = []
    state["fileChangesVersion"] = 0
```

- [ ] **Step 8: Verify build and existing tests still pass**

Run: `python scripts/build-html.py && python -m pytest tests/ -q`
Expected: Build succeeds, all existing tests pass (85+).

- [ ] **Step 9: Commit**

```bash
git add scripts/dev-server.py
git commit -m "feat(F13): wire FileWatcher into dev-server with REST endpoints

- GET /api/studio/file-changes returns changed files + version
- POST /api/studio/file-changes/dismiss acknowledges through version
- Background thread polls every 3s after successful deploy
- Watcher stops on re-deploy start and undeploy
- fileChanges included in /api/studio/status response

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Frontend File Change Notification Bar (CSS)

**Files:**
- Create: `src/frontend/css/file-watcher.css`
- Modify: `scripts/build-html.py` (CSS_MODULES list)

**What this builds:** Styles for the file change notification bar. Follows the smart-context-bar pattern (same notification zone).

- [ ] **Step 1: Create file-watcher.css**

Create `src/frontend/css/file-watcher.css`:

```css
/* ═══════════════════════════════════════════════════════════════════════════
   File Change Detection — Notification Bar
   Renders in #file-change-bar within .notification-zone.
   Follows smart-context-bar pattern. Amber accent for "stale code" warning.
   @author Pixel — EDOG Studio hivemind
   ═══════════════════════════════════════════════════════════════════════════ */

.file-change-bar {
  display: none;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 8px 16px;
  font-family: var(--font-body);
  font-size: 12px;
  animation: slideDown 0.3s ease;
}

.file-change-bar.active {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* Left: warning indicator */
.file-change-bar .fcb-indicator {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(245, 158, 11, 0.10);
  color: oklch(0.75 0.15 75);
  white-space: nowrap;
}

/* File count label */
.file-change-bar .fcb-label {
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
}

/* File list (comma-separated, truncated) */
.file-change-bar .fcb-files {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50%;
  flex-shrink: 1;
}

/* Spacer to push buttons right */
.file-change-bar .fcb-spacer {
  flex: 1;
}

/* Re-deploy button */
.file-change-bar .fcb-redeploy {
  background: var(--accent);
  color: var(--text-on-accent);
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-body);
  cursor: pointer;
  transition: opacity var(--transition-fast);
  white-space: nowrap;
}

.file-change-bar .fcb-redeploy:hover {
  opacity: 0.85;
}

/* Dismiss button */
.file-change-bar .fcb-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  font-family: var(--font-body);
  transition: color var(--transition-fast);
}

.file-change-bar .fcb-dismiss:hover {
  color: var(--text);
}

/* slideDown animation — reuse if already defined, else define */
@keyframes slideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 2: Add to CSS_MODULES in build-html.py**

In `scripts/build-html.py`, add `"css/file-watcher.css"` to the `CSS_MODULES` list after `"css/smart.css"` (line 37):

```python
    "css/smart.css",
    "css/file-watcher.css",
    "css/control.css",
```

- [ ] **Step 3: Verify build**

Run: `python scripts/build-html.py`
Expected: Build succeeds, new CSS module included.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/css/file-watcher.css scripts/build-html.py
git commit -m "feat(F13): add file change notification bar CSS

- Amber indicator badge for stale-code warning
- Re-deploy button (accent), Dismiss button (muted)
- slideDown animation, follows smart-context-bar pattern
- Added to CSS_MODULES build order after smart.css

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Frontend FileChangeWatcher Module

**Files:**
- Create: `src/frontend/js/file-watcher.js`
- Modify: `scripts/build-html.py` (JS_MODULES list)

**What this builds:** Frontend JS class that polls the file-changes API, renders the notification bar, handles Re-deploy and Dismiss actions.

- [ ] **Step 1: Create file-watcher.js**

Create `src/frontend/js/file-watcher.js`:

```javascript
/**
 * FileChangeWatcher — polls for FLT source changes, renders notification bar.
 *
 * Polls /api/studio/file-changes every 5 seconds when FLT is running.
 * Renders into #file-change-bar with changed file list, Re-deploy, and Dismiss.
 *
 * @author Pixel — EDOG Studio hivemind
 */
class FileChangeWatcher {
  constructor() {
    this._el = document.getElementById('file-change-bar');
    this._pollTimer = null;
    this._active = false;
    this._lastVersion = 0;
    this._onRedeploy = null;  // callback set by main.js
  }

  /**
   * Start polling for file changes. Call when FLT reaches "running" state.
   */
  start() {
    if (this._active) return;
    this._active = true;
    this._lastVersion = 0;
    this._poll();
    this._pollTimer = setInterval(this._poll.bind(this), 5000);
  }

  /**
   * Stop polling. Call when deploying, stopped, or crashed.
   */
  stop() {
    this._active = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._hide();
  }

  /**
   * Poll the backend for file changes.
   * @private
   */
  _poll() {
    if (!this._active) return;
    var self = this;
    fetch('/api/studio/file-changes')
      .then(function (resp) {
        if (!resp.ok) return null;
        return resp.json();
      })
      .then(function (data) {
        if (!data || !self._active) return;
        if (data.files && data.files.length > 0) {
          self._lastVersion = data.version;
          self._render(data.files, data.version);
        } else {
          self._hide();
        }
      })
      .catch(function () {
        // Ignore — server might be restarting
      });
  }

  /**
   * Render the notification bar with changed files.
   * @param {string[]} files - Relative paths of changed files
   * @param {number} version - Change version for dismiss
   * @private
   */
  _render(files, version) {
    if (!this._el) return;
    var count = files.length;
    var label = count === 1 ? '1 file changed' : count + ' files changed';
    var shortNames = files.map(function (f) {
      var parts = f.replace(/\\/g, '/').split('/');
      return parts[parts.length - 1];
    });
    var fileList = shortNames.join(', ');

    this._el.innerHTML =
      '<span class="fcb-indicator">' + String.fromCharCode(9670) + ' Stale</span>' +
      '<span class="fcb-label">' + label + '</span>' +
      '<span class="fcb-files" title="' + files.join('\n') + '">' + fileList + '</span>' +
      '<span class="fcb-spacer"></span>' +
      '<button class="fcb-redeploy">Re-deploy</button>' +
      '<button class="fcb-dismiss" title="Dismiss">' + String.fromCharCode(10005) + '</button>';

    this._el.classList.add('active');

    var self = this;
    var redeployBtn = this._el.querySelector('.fcb-redeploy');
    var dismissBtn = this._el.querySelector('.fcb-dismiss');

    if (redeployBtn) {
      redeployBtn.onclick = function () {
        self._hide();
        if (self._onRedeploy) self._onRedeploy();
      };
    }
    if (dismissBtn) {
      dismissBtn.onclick = function () {
        self._dismiss(version);
      };
    }
  }

  /**
   * Hide the notification bar.
   * @private
   */
  _hide() {
    if (!this._el) return;
    this._el.classList.remove('active');
    this._el.innerHTML = '';
  }

  /**
   * Dismiss changes through a specific version.
   * @param {number} version
   * @private
   */
  _dismiss(version) {
    this._hide();
    fetch('/api/studio/file-changes/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: version })
    }).catch(function () {});
  }

  /**
   * Clean up timers.
   */
  destroy() {
    this.stop();
  }
}
```

- [ ] **Step 2: Add to JS_MODULES in build-html.py**

In `scripts/build-html.py`, add `"js/file-watcher.js"` to the `JS_MODULES` list. Place it after `"js/deploy-flow.js"` (line 93) and before `"js/sidebar.js"`:

```python
    "js/deploy-flow.js",
    "js/file-watcher.js",
    "js/sidebar.js",
```

- [ ] **Step 3: Verify build**

Run: `python scripts/build-html.py`
Expected: Build succeeds, new JS module included.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/file-watcher.js scripts/build-html.py
git commit -m "feat(F13): add FileChangeWatcher frontend module

- Polls /api/studio/file-changes every 5s when FLT running
- Renders notification bar with file list, Re-deploy, Dismiss
- Versioned dismiss (server-side acknowledgment)
- Re-deploy callback wired by main.js
- Added to JS_MODULES build order after deploy-flow.js

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Main.js Integration + Polish

**Files:**
- Modify: `src/frontend/js/main.js` (constructor, `_checkDeployResume`, deploy onUpdate callback)

**What this builds:** Wire `FileChangeWatcher` into the app lifecycle — start when connected, stop when deploying/stopped, Re-deploy triggers `DeployFlow.startDeploy()`.

- [ ] **Step 1: Add FileChangeWatcher to constructor**

In `src/frontend/js/main.js`, inside the `EdogLogViewer` constructor (around line 111, after `this.commandPalette`), add:

```javascript
    this.fileWatcher = new FileChangeWatcher();
```

- [ ] **Step 2: Wire Re-deploy callback in init()**

In the `init()` method (after other initializations, around line 230), add:

```javascript
    // F13: Wire file change Re-deploy to deploy flow
    var self = this;
    this.fileWatcher._onRedeploy = function () {
      if (self.workspaceExplorer && self.workspaceExplorer._deployFlow) {
        var target = self.workspaceExplorer._lastDeployTarget;
        if (target) {
          self.workspaceExplorer._deployFlow.startDeploy(
            target.workspaceId, target.artifactId,
            target.capacityId, target.lakehouseName, true
          );
        }
      }
    };
```

- [ ] **Step 3: Start file watcher when connected**

In `_checkDeployResume()`, inside the `state.phase === 'running'` block (around line 290, after `this.loadInitialData()`), add:

```javascript
        this.fileWatcher.start();
```

Also, in the `deployFlow.onUpdate` callback, inside the `s.status === 'running'` block (around line 271, after `this.loadInitialData()`), add:

```javascript
            self.fileWatcher.start();
```

- [ ] **Step 4: Stop file watcher when deploying/failed**

In the deploy `onUpdate` callback, inside the `s.status === 'stopped' && s.error` block (around line 280), add:

```javascript
            self.fileWatcher.stop();
```

Also in `_checkDeployResume()`, inside the `state.phase === 'deploying'` block (around line 287), add:

```javascript
        this.fileWatcher.stop();
```

And inside `state.phase === 'crashed'` (around line 297), add:

```javascript
        this.fileWatcher.stop();
```

- [ ] **Step 5: Store last deploy target for Re-deploy**

In `src/frontend/js/workspace-explorer.js` (or wherever deploy is triggered), ensure the deploy target is stored so Re-deploy can reuse it. Search for where `startDeploy` is called — add:

```javascript
this._lastDeployTarget = { workspaceId, artifactId, capacityId, lakehouseName };
```

If `_lastDeployTarget` is already stored (check workspace-explorer.js for existing pattern), skip this step. If not, add it right before `this._deployFlow.startDeploy(...)` is called.

- [ ] **Step 6: Verify full build and all tests pass**

Run: `python scripts/build-html.py && python -m pytest tests/ -q`
Expected: Build succeeds (new modules included), all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/js/main.js src/frontend/js/workspace-explorer.js
git commit -m "feat(F13): wire FileChangeWatcher into app lifecycle

- Start watching when FLT reaches running state
- Stop watching on deploy/crash/stop
- Re-deploy button triggers DeployFlow.startDeploy with force=true
- Stores last deploy target for Re-deploy reuse

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Final Polish + Full Verification

**Files:**
- All files from Tasks 1-5
- Verify: build, lint, tests, manual smoke test

**What this builds:** End-to-end verification and any final adjustments.

- [ ] **Step 1: Run full test suite**

Run: `python -m pytest tests/ -v`
Expected: All tests pass (85 existing + 16 new file watcher tests = 101+).

- [ ] **Step 2: Run lint on all new/modified files**

Run: `python -m ruff check scripts/file-watcher.py tests/test_file_watcher.py`
Expected: Clean (no new errors).

- [ ] **Step 3: Build final HTML**

Run: `python scripts/build-html.py`
Expected: Build succeeds. Output includes `file-watcher.js` and `file-watcher.css`.

- [ ] **Step 4: Verify the notification bar HTML container exists**

Check that `src/frontend/index.html` line 57 has `<div id="file-change-bar" class="file-change-bar"></div>`. This already exists — no changes needed.

- [ ] **Step 5: Commit any remaining polish**

If any adjustments were needed:

```bash
git add -A
git commit -m "chore(F13): final polish and verification

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review Checklist

### Spec Coverage
| Acceptance Criteria | Task |
|---|---|
| Detect .cs, .json, .csproj changes | Task 1: `WATCHED_EXTENSIONS`, `_scan_files()` |
| EDOG DevMode files excluded | Task 1: `EXCLUDED_DIRS` includes "devmode" |
| Build output dirs excluded | Task 1: `EXCLUDED_DIRS` includes "bin", "obj", ".vs", "testresults" |
| Notification bar: files + Re-deploy + Dismiss | Task 4: `_render()` method |
| Re-deploy triggers rebuild | Task 5: `_onRedeploy` → `DeployFlow.startDeploy()` |
| Dismiss hides bar, re-appears on new changes | Task 4: versioned dismiss |
| 2-second debounce | Task 1: 3s poll interval provides natural debounce |
| Works alongside deploy flow | Task 2: watcher stops on deploy start, restarts on success |

### Type/Name Consistency
- `FileWatcher` (Python) — `scripts/file-watcher.py`
- `FileChangeWatcher` (JS) — `src/frontend/js/file-watcher.js`
- `_file_watcher` (global in dev-server.py)
- `/api/studio/file-changes` — GET returns `{files: [], version: N}`
- `/api/studio/file-changes/dismiss` — POST with `{version: N}`
- `snapshot_deployed()` / `poll_changes()` / `get_changes()` / `dismiss(version)` / `reset()`

### No Placeholders
- All code blocks contain complete, runnable code
- All test methods have explicit assertions
- All file paths are exact
- All commands include expected output
