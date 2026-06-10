<div align="center">
<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner-light.svg">
  <img alt="EDOG Studio" src="docs/assets/banner-dark.svg" width="100%">
</picture>

<br>

**Browse workspaces. Deploy locally. Debug in real-time.**
<br>
**A developer cockpit on `localhost:5555`.**

<br>

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-3776ab?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![v2.0.0](https://img.shields.io/badge/version-2.0.0-6d5cff?style=flat-square)]()
[![Windows](https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square&logo=windows&logoColor=white)]()

</div>

<br>

Stop juggling the Fabric portal, a terminal, log files, and three browser tabs. **EDOG Studio is one window for the entire FabricLiveTable inner loop** — browse your Fabric tenant, deploy to a local lakehouse with one click, and watch the service light up in real time: live logs, an interactive DAG, every Spark request, feature flags, the works.

You don't configure it. You don't read a setup guide. You `git clone`, type `edog`, and it walks you through the rest. It evolved from [flt-edog-devmode](https://github.com/guptahemant65/flt-edog-devmode) into a full engineering cockpit — and now it's yours.

---

## Two Phases, One Cockpit

<table>
<tr>
<td width="50%" valign="top">

### ○ Phase 1 — Disconnected

> No FLT service. No deploy. Just your Fabric credentials.

▸ Browse tenants, workspaces, lakehouses, tables<br>
▸ Create, rename, and delete Fabric resources<br>
▸ Edit notebooks inline — cells, run-all, the lot<br>
▸ Scaffold a whole environment with the Infra Wizard<br>
▸ Flip feature flags · test any Fabric API live

</td>
<td width="50%" valign="top">

### ● Phase 2 — Connected

> Pick a lakehouse ▸ deploy ▸ full DevTools light up.

▸ Real-time log streaming with breakpoints<br>
▸ Interactive DAG graph + Gantt execution chart<br>
▸ Spark & GTS HTTP request/response inspector<br>
▸ Lock monitor, interceptor status, hot re-deploy<br>
▸ Every Spark span, poll, and retry — fully drillable

</td>
</tr>
</table>

---

## The Feature Tour

Six views, one keystroke apart (<kbd>1</kbd>–<kbd>6</kbd>). Five are shipped today; QA is still baking. Here's what each one does for you.

### ◆ Workspace Explorer · *both phases*
Your Fabric tenant as a three-panel tree — tenants ▸ workspaces ▸ lakehouses ▸ tables. Create, rename, delete, and **deploy to a local lakehouse with a single click**. Open a notebook and it turns into a real **embedded IDE**: edit cells, run them one at a time or all at once, save straight back to Fabric. Need a fresh environment? The **Infra Wizard** scaffolds one end to end — Setup ▸ Theme ▸ Build (visual DAG canvas) ▸ Review ▸ Deploy — and it's a true singleton, so it never loses your half-finished work.

### ◆ Runtime · *connected*
The cockpit's beating heart. The moment FLT is running, the Runtime view streams **live logs** with breakpoints, bookmarks, and error clustering — then hands you **11 inspector sub-tabs** (<kbd>Alt</kbd>+<kbd>1–5</kbd> to fly between them): Spark, HTTP, DI, Caches, Flags, Nexus, Perf, Retries, SysFiles, Telemetry, Tokens. Every Spark session is drillable down to its spans, state, polls, and raw payloads.

### ◆ DAG Studio · *connected*
Watch your DAG execute, node by node, in real time. A single source-of-truth state machine fuses SignalR telemetry (~50 ms) with log parsing (~200 ms), so the graph never lies — `pending ▸ running ▸ completed · failed · cancelled · skipped`, all colour-coded. Smooth, eased camera controls, a synced **Gantt chart**, run/cancel buttons, and a live execution strip across the top.

### ◆ API Playground · *both phases*
Postman, but it already knows your APIs. The endpoint catalog is **auto-discovered from the FLT C# source at runtime** — no manual setup. Build a request, fire it with live auth, and explore the response in a collapsible JSON tree. History is saved so you can replay anything.

### ◆ Environment · *both phases*
Everything about your local setup on cards you can trust: Config snapshot, Token state, Build & Patch status, Interceptor wrap status — plus the full **Feature Flags matrix** with rollout visibility, a lock monitor, and orphaned-resource cleanup.

### ◆ QA · *connected* · 🚧 *in development*
A PR-driven testing pipeline in five stages: **PR Input ▸ Analysis ▸ Curation ▸ Execution ▸ Results** — point it at a change and walk it from raw diff to a clean test verdict. Landing soon; the view is in the app today as a preview.

> **And the little things that add up:** Command Palette (<kbd>Ctrl</kbd>+<kbd>K</kbd>), a live top bar that tracks your git branch and flags a crashed service the instant it happens, file-watcher hot re-deploy, a token inspector with countdown, and a first-run flow that finds your FLT repo for you.

---

## Quick Start

Three lines. No setup guide.

```powershell
git clone https://github.com/guptahemant65/edog-studio.git
cd edog-studio
edog
```

That's it. On first run, EDOG **finds your FabricLiveTable repo for you** and asks for your email — then opens **http://localhost:5555**. The web UI handles auth, workspace selection, and deploy. No CLI token dance.

<details>
<summary><b>Want <code>edog</code> on your PATH so it runs from anywhere?</b></summary>
<br>

```powershell
# One-line installer — adds edog to PATH
irm https://raw.githubusercontent.com/guptahemant65/edog-studio/master/scripts/install.ps1 | iex
```

Or point EDOG at your FLT repo manually so it can run from any directory:

```powershell
edog --config -r C:\path\to\FabricLiveTable
```

Handy flags: `edog --status` (are changes applied?) · `edog --revert` (undo everything) · `edog --config` (show config) · `edog --logs` (just open the viewer).

</details>

---

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture-light.svg">
  <img alt="EDOG Studio Architecture" src="docs/assets/architecture-dark.svg" width="100%">
</picture>

<br>

<details>
<summary><b>Project Structure</b></summary>
<br>

```
edog-studio/
├── src/
│   ├── frontend/          # JS + CSS modules → single HTML build
│   └── backend/           # C# DevMode injected into FLT service
├── edog.py                # CLI entrypoint
├── scripts/               # Build, install, setup automation
├── config/                # Default configuration templates
├── tests/                 # Test suite
├── docs/
│   ├── specs/             # Feature specifications
│   ├── design/            # Design bible, component library, mockups
│   └── adr/               # Architecture Decision Records
└── hivemind/              # Multi-agent orchestration layer
```

The frontend builds into a **single self-contained HTML file** — all CSS and JS inlined, zero external dependencies at runtime.

</details>

---

<details>
<summary><b>Tech Stack</b></summary>
<br>

| Layer | Technology |
|:------|:-----------|
| **CLI** | Python 3.10+ — Watchdog, Pywinauto, WebSockets |
| **Frontend** | Vanilla JS + CSS — no framework, single-file build |
| **Backend Injection** | C# — DevMode registrar, interceptors |
| **Auth** | Silent CBA via C# token-helper (certificate-based, zero browser) |
| **IPC** | SignalR (JSON hub protocol) over WebSocket — real-time telemetry |

</details>

<details>
<summary><b>Development</b></summary>
<br>

```powershell
git clone https://github.com/guptahemant65/edog-studio.git
cd edog-studio
python -m venv .venv && .venv\Scripts\activate
pip install -e ".[dev]"

# Build the single-file UI
python scripts/build-html.py

# Quality gates (make, or call the tools directly)
make lint      # ruff check + format   → python -m ruff check .
make test      # pytest + coverage     → python -m pytest
make build     # full pipeline         → python scripts/build-html.py
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

</details>

---

<div align="center">

**Built for the FabricLiveTable team at Microsoft**

[Quick Start](#quick-start) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

</div>
