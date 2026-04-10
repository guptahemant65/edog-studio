"""Shared pytest fixtures for edog-studio."""

from __future__ import annotations

import pathlib
from collections.abc import Generator

import pytest


@pytest.fixture()
def tmp_repo(tmp_path: pathlib.Path) -> pathlib.Path:
    """Return a temporary directory usable as a scratch repo root."""
    return tmp_path


@pytest.fixture()
def mock_flt_repo(tmp_path: pathlib.Path) -> Generator[pathlib.Path, None, None]:
    """Create a minimal FLT repo structure mirroring the real layout.

    Layout::

        <tmp>/
        ├── Service/
        │   └── Microsoft.LiveTable.Service/
        │       ├── DevMode/
        │       │   ├── DevModeController.cs
        │       │   ├── DevModeMiddleware.cs
        │       │   └── DevModeConfig.cs
        │       └── appsettings.json
        ├── Frontend/
        │   └── livetable/
        │       └── src/
        │           └── index.ts
        └── build/
            └── output/
    """
    service_dir = tmp_path / "Service" / "Microsoft.LiveTable.Service"
    devmode_dir = service_dir / "DevMode"
    devmode_dir.mkdir(parents=True)

    # C# stubs
    (devmode_dir / "DevModeController.cs").write_text(
        "namespace Microsoft.LiveTable.Service.DevMode;\n"
        "public class DevModeController { }\n",
        encoding="utf-8",
    )
    (devmode_dir / "DevModeMiddleware.cs").write_text(
        "namespace Microsoft.LiveTable.Service.DevMode;\n"
        "public class DevModeMiddleware { }\n",
        encoding="utf-8",
    )
    (devmode_dir / "DevModeConfig.cs").write_text(
        "namespace Microsoft.LiveTable.Service.DevMode;\n"
        "public class DevModeConfig { }\n",
        encoding="utf-8",
    )

    # appsettings.json
    (service_dir / "appsettings.json").write_text(
        '{\n  "DevMode": {\n    "Enabled": true\n  }\n}\n',
        encoding="utf-8",
    )

    # Frontend stub
    frontend_dir = tmp_path / "Frontend" / "livetable" / "src"
    frontend_dir.mkdir(parents=True)
    (frontend_dir / "index.ts").write_text(
        "export const VERSION = '0.0.0-test';\n",
        encoding="utf-8",
    )

    # Build output directory
    (tmp_path / "build" / "output").mkdir(parents=True)

    yield tmp_path
