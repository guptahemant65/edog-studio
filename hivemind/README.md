# EDOG-STUDIO HIVEMIND

> 9 AI agents building a developer cockpit for FabricLiveTable.

---

## What Is This

edog-studio is a **localhost developer cockpit** (`http://localhost:5555`) for engineers building FabricLiveTable (FLT) — Microsoft's materialized lake view service. Think Chrome DevTools, but for FLT: logs, telemetry, DAG execution, Spark inspection, workspace management, and API playground — all in one browser tab.

This `hivemind/` directory contains the governance documents for the AI agent team building it.

---

## The Team

9 agents, one mission: build a tool that senior C# engineers want open 8 hours a day.

| Agent | Domain | Owns |
|-------|--------|------|
| **Architect** | System design | Architecture decisions, component boundaries |
| **CLI Engineer** | Python backend | `edog.py`, token management, API proxy, build system |
| **Interceptor Engineer** | C# middleware | DevMode interceptors, log/telemetry capture |
| **Frontend Engineer** | Browser UI | Single-file HTML, CSS, JS modules |
| **Build Engineer** | Build pipeline | `build-html.py`, CI, packaging |
| **UX Engineer** | Interaction design | Keyboard shortcuts, information density, flow |
| **Test Engineer** | Quality assurance | pytest, MSTest, browser validation |
| **Docs Engineer** | Documentation | Design specs, onboarding, API docs |
| **Integration Engineer** | Cross-cutting | Phase transitions, token flow, end-to-end wiring |

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────┐
│                   Browser Tab                       │
│  ┌───────────────────────────────────────────────┐  │
│  │        Single-File HTML (edog-logs.html)       │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐  │  │
│  │  │ Vanilla  │ │ CSS      │ │ Class-based  │  │  │
│  │  │ DOM API  │ │ OKLCH    │ │ JS Modules   │  │  │
│  │  └──────────┘ └──────────┘ └──────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
│                        ▲                            │
│                        │ HTTP / WebSocket            │
│                        ▼                            │
│  ┌───────────────────────────────────────────────┐  │
│  │           Python Backend (edog.py)             │  │
│  │  Token mgmt │ API proxy │ Build orchestration  │  │
│  └───────────────────────────────────────────────┘  │
│                        ▲                            │
│                        │ HTTP intercept              │
│                        ▼                            │
│  ┌───────────────────────────────────────────────┐  │
│  │         C# DevMode Interceptors               │  │
│  │  EdogLogInterceptor │ EdogTelemetryInterceptor │  │
│  │  EdogApiProxy       │ EdogLogServer            │  │
│  └───────────────────────────────────────────────┘  │
│                        ▲                            │
│                        │                            │
│                        ▼                            │
│  ┌───────────────────────────────────────────────┐  │
│  │            FLT Service (local)                │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Three-Layer Stack

| Layer | Tech | Key Constraint |
|-------|------|----------------|
| **Frontend** | Vanilla JS + CSS | Single-file HTML output. No frameworks. No npm. |
| **Backend** | Python 3.8+ | Zero external deps beyond Playwright. Stdlib-first. |
| **Interceptors** | C# (.NET) | Injected into FLT service. Minimal surface area. |

### Two-Phase Lifecycle

1. **Disconnected** — Browse workspaces, manage tokens, explore Fabric APIs (bearer token only)
2. **Connected** — Full cockpit: live logs, DAG controls, Spark inspector, MWC + bearer tokens

---

## Quick Start

### For a New Agent

```bash
# 1. Read the governance docs (in this order)
cat hivemind/CULTURE.md
cat hivemind/QUALITY_BAR.md
cat hivemind/ENGINEERING_STANDARDS.md
cat hivemind/STYLE_GUIDE.md
cat hivemind/ONBOARDING.md

# 2. Understand the product
cat edog-design-spec-v2.md
cat edog-design-brief.md

# 3. Build the frontend
python build-html.py

# 4. Run the tool
edog.cmd
```

### For Humans

```bash
# Install and run
install.ps1
edog.cmd
# Open http://localhost:5555
```

---

## Governance Documents

| Document | Purpose |
|----------|---------|
| [CULTURE.md](CULTURE.md) | Values and operating principles for developer tool builders |
| [QUALITY_BAR.md](QUALITY_BAR.md) | What "good" means — the Studio Bar |
| [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) | Tech stack rules, build process, prohibited practices |
| [STYLE_GUIDE.md](STYLE_GUIDE.md) | Code conventions across Python, C#, JS, CSS, Git |
| [ONBOARDING.md](ONBOARDING.md) | How a new agent joins the team |

---

## Key Design Constraints

These are non-negotiable. They exist for good reasons.

1. **Single-file HTML** — The frontend compiles to one `.html` file. No CDN, no bundler, no node_modules. The C# `EdogLogServer` serves it directly. This eliminates deployment complexity.

2. **No frontend frameworks** — Vanilla JS, vanilla DOM. Class-based modules for organization. React/Vue/Svelte add complexity that outlives their value in a single-file context.

3. **OKLCH color space** — All colors in CSS use OKLCH. It's perceptually uniform, which matters when you're staring at this UI 8 hours a day.

4. **4px spacing grid** — All spacing derives from a 4px base. No arbitrary pixel values.

5. **Keyboard-first** — Every action must be reachable via keyboard. Number keys 1-6 for views, Ctrl+K for command palette.

---

*"A developer tool is a mirror — it reflects how seriously you take your craft."*
