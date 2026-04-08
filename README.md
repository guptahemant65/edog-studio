# EDOG Studio

**The FabricLiveTable Developer Cockpit**

EDOG Studio is the evolution of [flt-edog-devmode](https://github.com/guptahemant65/flt-edog-devmode) — a localhost developer tool for building and debugging Microsoft FabricLiveTable (FLT) locally.

## What's New (v2)

EDOG DevMode was a token manager + code patcher + log viewer. EDOG Studio is a **full developer cockpit** with a two-phase lifecycle:

**Phase 1 — Browse & Explore** (no FLT service needed)
- Browse tenants, workspaces, lakehouses, tables via Fabric APIs
- Create/rename/delete workspaces and lakehouses
- Manage feature flags with rollout visibility + local overrides + PR creation
- Test Fabric APIs with built-in playground

**Phase 2 — Connected DevTools** (FLT service running)  
- Pick a lakehouse → one-click deploy (token + patch + build + launch)
- Real-time log streaming with breakpoints and bookmarks
- Interactive DAG graph with execution Gantt chart
- Spark HTTP request/response inspector
- Lock monitor with auto-unlock
- File change detection with hot re-deploy

## Architecture

```
edog-studio/
├── src/
│   ├── backend/           # C# files injected into FLT service
│   │   └── DevMode/       # EdogLogServer, interceptors, wrappers
│   └── frontend/          # Web UI (single-file HTML build)
│       ├── css/           # CSS modules
│       ├── js/            # JS modules
│       └── assets/        # Icons
├── scripts/               # Build, install, setup scripts
├── docs/
│   └── specs/             # Design specifications
├── tests/                 # Test suite
├── config/                # Default config templates
├── edog.py                # Main CLI (Python)
└── edog.cmd               # Windows launcher
```

## Quick Start

```powershell
# Install
irm https://raw.githubusercontent.com/guptahemant65/edog-studio/main/scripts/install.ps1 | iex

# Configure
edog --config -u your@email.com

# Launch
edog
```

## Views

| # | View | Phase | Description |
|---|------|-------|-------------|
| 1 | **Workspace Explorer** | Both | Browse tenants/workspaces/lakehouses/tables, deploy to lakehouse |
| 2 | **Logs** | Connected | Real-time log stream with breakpoints, bookmarks, error clustering |
| 3 | **DAG Studio** | Connected | Interactive DAG graph, Gantt chart, run/cancel, execution diff |
| 4 | **Spark Inspector** | Connected | HTTP traffic capture for all Spark/GTS calls |
| 5 | **API Playground** | Both | Postman-like API testing with pre-configured endpoints |
| 6 | **Environment** | Both | Feature flags, lock monitor, orphaned resource cleanup |

Plus: Command Palette (Ctrl+K), Token Inspector, File Change Detection, Session History.

## Origin

This project evolved from [flt-edog-devmode](https://github.com/guptahemant65/flt-edog-devmode) which provides the core token management, code patching, and log viewer functionality. EDOG Studio extends it with workspace browsing, DAG visualization, Spark inspection, feature flag management, and a complete API playground.

## License

Microsoft Internal
