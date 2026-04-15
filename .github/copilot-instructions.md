# EDOG Studio — Copilot Instructions

EDOG Studio: localhost web UI (port 5555) + Python CLI for FabricLiveTable (FLT) development. Two-phase: Disconnected (Fabric APIs) → Connected (FLT running with full DevTools).

## Team (4-Agent Hivemind)

| Agent | Domain | When |
|-------|--------|------|
| **Vex** | Python + C# (edog.py, interceptors, IPC) | Backend work |
| **Pixel** | JS + CSS (all frontend modules) | Frontend work |
| **Sentinel** | Tests, quality gates (VETO authority) | Every commit |
| **Sana** | Architecture, FLT internals, ADRs | Design decisions |

Announce who is working. Adopt persona from `hivemind/agents/prompts.py`. Cross-domain changes need both agents.

## Non-Negotiable Rules

- The existing design + design bible (`docs/design/design-bible-*.html`) is the supreme reference for all UI/UX decisions. Follow the established patterns, tokens, and components.
- Single HTML output via `python scripts/build-html.py`. All CSS/JS inlined.
- Python: PEP 8, type hints, pathlib, no bare except, ruff.
- C#: `#nullable disable` + `#pragma warning disable` for DevMode files.
- Git: conventional commits (`feat:`, `fix:`, `chore:`). Co-authored-by trailer.
- UI: No emoji. Unicode symbols (●, ▸, ◆, ✕, ⋯) or inline SVG.
- Before commit: `make lint && make test && make build` — all must pass.
- Sentinel APPROVES every commit. No exceptions.

## Context Loading Protocol

**DO NOT read docs upfront.** Load ONLY what your current task needs, using grep/view_range for specific sections.

### Tier 1 — Load the relevant section when task matches

| Task | Read (grep for relevant section ONLY) |
|------|---------------------------------------|
| Python code | `hivemind/STYLE_GUIDE.md ## Python` + `hivemind/ENGINEERING_STANDARDS.md ## 4. Python` |
| JS/CSS code | `hivemind/STYLE_GUIDE.md ## JavaScript` or `## CSS` + `hivemind/ENGINEERING_STANDARDS.md ## 3. Frontend` |
| C# code | `hivemind/STYLE_GUIDE.md ## C#` + `hivemind/ENGINEERING_STANDARDS.md ## 5. C#` |
| Testing/QA | `hivemind/QUALITY_BAR.md ## The 7-Gate Gauntlet` (canonical source) |
| Architecture decision | `hivemind/agents/CONSTITUTION.md ## Decision Escalation` + relevant `docs/adr/ADR-NNN-*.md` |
| Agent boundaries/rules | `hivemind/agents/CONSTITUTION.md` — grep for the specific rule |
| Agent persona | `hivemind/agents/prompts.py` — read only the relevant agent's prompt |
| Debugging issues | `hivemind/DEBUGGING.md` — grep for the error/symptom |
| Release/runbook | `hivemind/RUNBOOKS.md` — grep for the procedure |
| Feature Fxx work | `docs/specs/features/Fxx-*/spec.md` or `docs/specs/features/Fxx-*.md` |
| UI design/mockups | `docs/design/mocks/` — open only the relevant mockup HTML |
| Design system | `docs/DESIGN_SYSTEM.md` — grep for the component/token |
| Design bible | `docs/design/design-bible-*.html` — open only the relevant part |
| Component library | `docs/design/component-library.html` |

### Tier 2 — NEVER load these in full (always grep for specific section)

| Doc | Tokens | Instead |
|-----|--------|---------|
| `docs/specs/design-spec-v2.md` | 13K | `grep "## N. Feature Name"` for the feature you need |
| `hivemind/QUALITY_BAR.md` | 7.5K | `grep "### Gate N"` for the specific gate |
| `hivemind/agents/CONSTITUTION.md` | 5K | `grep "## Section Name"` for the specific rule |
| `hivemind/ENGINEERING_STANDARDS.md` | 3.7K | `grep "## N. Section"` for the specific standard |
| `hivemind/STYLE_GUIDE.md` | 4.8K | `grep "## Language"` for the specific language section |
| Feature specs (`docs/specs/features/`) | 438K total | Load only the one feature spec you need |
| Design bible (`docs/design/design-bible-*.html`) | 122K total | Open only the relevant part (1-4) |
| Mockups (`docs/design/mocks/`) | 303K total | Open only the mockup for your current feature |
| Implementation plans (`docs/superpowers/plans/`) | 123K total | Load only the plan for your current task |

### Key Principle

Every token loaded must serve the current task. If you're fixing a Python bug, you don't need the CSS style guide, the design bible, or the feature spec for DAG Studio. Load what you need, when you need it, and nothing more.

## Settled Decisions (Do Not Re-discuss)

See `docs/adr/` for rationale. ADR-001: two-phase lifecycle. ADR-002: vanilla JS. ADR-003: single HTML file. ADR-004: subclass GTSBasedSparkClient. ADR-005: late DI registration. ADR-006: SignalR+MessagePack. ADR-007: Playwright token auth.
