<div align="center">

# ◆ EDOG Studio

### The Developer Cockpit for Microsoft FabricLiveTable

[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-3776ab?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0-blue?style=flat-square)]()
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square&logo=windows&logoColor=white)]()

**Browse workspaces. Deploy locally. Debug in real-time.**
**All from a single localhost UI on port 5555.**

---

</div>

## What is EDOG Studio?

EDOG Studio is a localhost developer tool for building and debugging [Microsoft FabricLiveTable](https://learn.microsoft.com/en-us/fabric/) (FLT) — evolved from [flt-edog-devmode](https://github.com/guptahemant65/flt-edog-devmode) into a full-featured engineering cockpit.

It works in **two phases** — so you can explore Fabric resources without running FLT, and get deep debugging tools when you do.

---

## Two-Phase Lifecycle

### Phase 1 — Disconnected (no FLT service needed)

> Explore your Fabric environment using live APIs — no local service required.

- **Workspace Explorer** — Browse tenants, workspaces, lakehouses, and tables
- **Resource Management** — Create, rename, and delete workspaces and lakehouses
- **Feature Flags** — View rollout status, set local overrides, create PRs for flag changes
- **API Playground** — Postman-like API tester with pre-configured Fabric endpoints

### Phase 2 — Connected (FLT service running)

> Pick a lakehouse, deploy with one click, and get full DevTools.

- **Real-Time Logs** — Streaming log viewer with breakpoints, bookmarks, and error clustering
- **DAG Studio** — Interactive DAG graph with Gantt chart, execution diff, run/cancel controls
- **Spark Inspector** — Capture and inspect every Spark/GTS HTTP request and response
- **Lock Monitor** — Track distributed locks with auto-unlock capability
- **Hot Re-Deploy** — File change detection triggers automatic rebuild and re-deploy

---

## Quick Start

```powershell
# Install (one-liner)
irm https://raw.githubusercontent.com/guptahemant65/edog-studio/master/scripts/install.ps1 | iex

# Configure with your Microsoft identity
edog --config -u your@email.com

# Launch the cockpit
edog
```

Then open **http://localhost:5555** and you're in.

---

## Views at a Glance

| View | Phase | What It Does |
|:-----|:-----:|:-------------|
| **Workspace Explorer** | ● Both | Browse and manage tenants, workspaces, lakehouses, tables. One-click deploy. |
| **Logs** | ● Connected | Real-time log stream with breakpoints, bookmarks, and error clustering. |
| **DAG Studio** | ● Connected | Interactive DAG graph, Gantt execution chart, run/cancel, execution diff. |
| **Spark Inspector** | ● Connected | Full HTTP traffic capture for all Spark and GTS calls. |
| **API Playground** | ● Both | Test Fabric APIs with pre-configured endpoints and auth. |
| **Environment** | ● Both | Feature flags, lock monitor, orphaned resource cleanup. |

**Plus:** Command Palette (`Ctrl+K`), Token Inspector, File Change Detection, Session History.

---

## Architecture

```
edog-studio/
├── src/
│   ├── frontend/          # Web UI — JS + CSS modules → single HTML build
│   │   ├── js/            #   View controllers, services, state management
│   │   ├── css/           #   Design-system-driven stylesheets
│   │   └── assets/        #   SVG icons
│   └── backend/           # C# DevMode — injected into the FLT service
│       └── DevMode/       #   Log server, interceptors, DI wrappers
├── edog.py                # CLI entrypoint (Python)
├── edog.cmd               # Windows launcher
├── scripts/               # Build, install, setup automation
├── config/                # Default configuration templates
├── tests/                 # Test suite
├── docs/
│   ├── specs/             # Feature specifications
│   ├── design/            # Design bible, component library, mockups
│   └── adr/               # Architecture Decision Records
└── hivemind/              # Multi-agent orchestration layer
```

The frontend builds into a **single self-contained HTML file** via `python scripts/build-html.py` — all CSS and JS inlined, zero external dependencies at runtime.

---

## Tech Stack

| Layer | Technology |
|:------|:-----------|
| **CLI** | Python 3.10+ (Playwright, Watchdog, Pywinauto) |
| **Frontend** | Vanilla JS + CSS (no framework, single-file build) |
| **Backend Injection** | C# (DevMode registrar, interceptors, SignalR+MessagePack) |
| **Auth** | Playwright-based browser token acquisition |
| **Communication** | SignalR with MessagePack binary protocol |

---

## Development

```powershell
# Clone and setup
git clone https://github.com/guptahemant65/edog-studio.git
cd edog-studio
python -m venv .venv && .venv\Scripts\activate
pip install -e ".[dev]"

# Build the frontend
python scripts/build-html.py

# Run checks
make lint      # Ruff linter + formatter
make test      # Pytest suite
make build     # Full build pipeline
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

---

## Origin Story

EDOG DevMode started as a simple token manager + code patcher + log viewer. Over time, FabricLiveTable developers needed more — workspace browsing, DAG visualization, Spark inspection, feature flag management, and a proper API playground. EDOG Studio is the answer: a complete developer cockpit that covers the full inner-loop workflow.

---

<div align="center">

**Built for the FabricLiveTable team at Microsoft**

[Getting Started](#quick-start) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

</div>
