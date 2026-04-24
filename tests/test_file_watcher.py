"""Tests for F13 File Change Detection — FileWatcher module."""


# Module under test — import will fail until Step 3
import os
import sys

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

    def test_edog_patch_file_excluded(self, tmp_path):
        """The .edog-changes.patch file is always excluded."""
        service = tmp_path / "Service"
        service.mkdir()
        (service / ".edog-changes.patch").write_text("patch content")
        (service / "Code.cs").write_text("class A {}")

        watcher = FileWatcher(str(service))
        files = watcher._scan_files()
        names = [f.name for f in files]
        assert ".edog-changes.patch" not in names
        assert "Code.cs" in names

    def test_testresults_directory_excluded(self, tmp_path):
        """TestResults/ directory is excluded."""
        service = tmp_path / "Service"
        (service / "TestResults").mkdir(parents=True)
        (service / "TestResults" / "results.json").write_text("{}")
        (service / "Code.cs").write_text("class A {}")

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
