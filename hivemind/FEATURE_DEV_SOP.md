# EDOG Studio — Feature Development SOP

> **Status:** ACTIVE
> **Established:** 2026-04-14
> **Based on:** F24 Chaos Engineering + F08 DAG Studio development process
> **Rule:** Follow this for every new feature. No shortcuts.

---

## The Principle

**Divide until trivial. Research before designing. Design before building. Verify before shipping.**

Every feature failure traces back to skipping a phase — guessing instead of reading, designing in the abstract instead of grounding in real code, building 4 files in one agent instead of 1 file per agent.

---

## Phase 0: Foundation Research

**Goal:** Understand what exists before imagining what to build.

| Task | What | Who | Output |
|------|------|-----|--------|
| P0.1 | **Existing code audit** — read every file that touches this feature. What's built? What's not? What can be reused? | Vex/Pixel | `research/p0-foundation.md` §1 |
| P0.2 | **Data source mapping** — for backend features: read the ACTUAL C# models, API endpoints, response schemas. Use `git show HEAD:` for patched files. For frontend: read existing JS/CSS. | Vex | `research/p0-foundation.md` §2 |
| P0.3 | **Industry research** — how do the best tools solve this? Extract patterns, not copy designs. | Sana | `research/p0-foundation.md` §3 |

**Rules:**
- Read REAL source code, not docs about source code
- Use `git show HEAD:<path>` for EDOG-patched files — never analyze our own patches as FLT findings
- Output is a markdown file with file:line references, not abstract descriptions

**Gate:** P0 must be DONE before P1 starts.

---

## Phase 1: Component Deep Specs

**Goal:** Define every scenario, every edge case, every data format — grounded in P0 research.

| Task | What | Who | Output |
|------|------|-----|--------|
| P1.N | **One spec per component/category** — each is an independent unit | Sana | `components/C0N-name.md` or `categories/C0N-name.md` |

**Per scenario in each spec:**
1. Name + ID + one-liner
2. Detailed description (3-5 sentences)
3. Technical mechanism (pseudocode or JSON config)
4. Source code path (file:line from CLEAN source)
5. Edge cases (what breaks if misconfigured)
6. Interactions with other components
7. Revert/undo mechanism
8. Priority (P0/P1/P2)

**Rules:**
- One agent per component spec (parallel dispatch OK — they're independent)
- Each agent reads ALL of P0 research as context
- Every code reference verified against real source
- No scenario without a concrete implementation path

**Gate:** All component specs DONE before P2 starts.

---

## Phase 2: Architecture

**Goal:** A senior engineer can implement from the spec without asking questions.

| Task | What | Who | Output |
|------|------|-----|--------|
| P2.1 | **Data model** — JSON schemas, C# classes, TypeScript interfaces | Sana | `architecture.md` or `engine-design.md` |
| P2.2 | **Core engine/algorithm** — the keystone code. Pseudocode for every public method. | Sana | Same file §2-3 |
| P2.3 | **Storage/persistence** — where data lives, format, CRUD, hot-reload | Vex | Same file §4 |
| P2.4 | **Safety mechanisms** — kill switches, limits, error recovery | Sana | Same file §5 |
| P2.5 | **Protocol/API** — SignalR messages, REST endpoints, frontend↔backend contract | Vex | `signalr-protocol.md` or `api-spec.md` |

**Rules:**
- Architecture must account for EVERY scenario from P1
- Performance targets specified (latency, memory, fps)
- Error paths explicitly designed (not "handle errors")
- Protocol spec enables frontend and backend to develop in parallel

**Gate:** Architecture DONE before P3 starts.

---

## Phase 3: State Matrices

**Goal:** Every pixel, every state, every transition defined before mockups.

| Task | What | Who | Output |
|------|------|-----|--------|
| P3.N | **One state matrix per UI component** | Pixel (specialist persona) | `states/component-name.md` |

**Per state:**
1. State name (e.g., `panel.open.rules.editing`)
2. Entry conditions — what triggers entering this state
3. Exit conditions — what triggers leaving
4. Visual description — what the user sees
5. Keyboard shortcuts
6. Data requirements — what SignalR subscriptions are active
7. Transitions — arrows to other states with trigger labels
8. Error recovery — what happens on failure in this state

**Rules:**
- Each agent is a SPECIALIST for that component type (list UX expert, form UX expert, graph UX expert, etc.)
- Minimum 10-15 states per component, more for complex ones
- Include cross-cutting concerns: disconnected state, kill switch, theme change
- ASCII wireframes for complex layouts

**Gate:** All state matrices DONE before P4 starts.

---

## Phase 4: Interactive Mocks

**Goal:** CEO opens it in a browser, clicks everything, says "build this."

| Task | What | Who | Output |
|------|------|-----|--------|
| P4.N | **One HTML mock per major view** | Pixel (design god persona) | `mocks/component-name.html` |

**Requirements:**
- Self-contained single HTML file (inline CSS + JS, Google Fonts only)
- Interactive — all states from P3 switchable
- Light + dark theme
- Realistic mock data (not "Lorem ipsum")
- CSS interactions that delight (animations, transitions, hover states)
- State switcher bar at bottom for CEO review
- Production-quality CSS — this should look shippable

**Rules:**
- ONE agent per mock (not a swarm — needs one cohesive vision)
- Agent reads ALL of P0-P3 for context
- Agent reads Design Bible + variables.css for design language
- Iterate: CEO reviews → feedback → agent refines (use `write_agent`)

**Gate:** CEO approves mock before implementation starts.

---

## Phase 5: Implementation

**Goal:** Ship working code that matches the approved mock.

| Layer | What | Agent Type | Rule |
|-------|------|-----------|------|
| Layer 0 | Core engine/algorithm (C# or JS) | One agent, one file | Smallest unit. Verify syntax. |
| Layer 1 | API integration | One agent, one file | Match protocol spec exactly. |
| Layer 2 | Frontend shell (HTML + CSS) | One agent, two files max | Match mock exactly. |
| Layer 3 | Frontend modules (JS) | One agent per module | Class-based, activate/deactivate lifecycle. |
| Layer 4 | Wiring (build-html.py, main.js) | One agent per file | Surgical edits only. |
| Layer 5 | Build + Test | Verify agent | `make build && make test` must pass. |

**Rules:**
- ONE agent, ONE file (or ONE file pair: .js + .css)
- Agent reads the ACTUAL source file before editing (not assuming content)
- Agent reads the mock for visual contract
- Agent reads the state matrix for behavior contract
- Agent reads the architecture for data contract
- `node -c <file>` after every JS edit
- `python scripts/build-html.py` after all edits
- `python -m pytest tests/ -q` before claiming done

---

## Phase 6: Bug Hunt

**Goal:** Find bugs before the CEO does.

| Step | What | Agents |
|------|------|--------|
| 6.1 | **Adversarial bugfind** — 4 agents, each reviewing a subset of files | 4 parallel bugfind agents |
| 6.2 | **Validation** — independent agents verify each reported bug against actual code | 4 parallel validation agents |
| 6.3 | **Fix** — grouped by pattern (listener leaks, memory leaks, rendering bugs) | 3 parallel fix agents |
| 6.4 | **Rebuild + retest** | Single verify step |

**Rules:**
- Bugfind agents are ADVERSARIAL — their job is to break the code
- Validation agents are SKEPTICAL — they reject false positives
- Fix agents are SURGICAL — one pattern per agent, edit tool not rewrite
- Every fix verified: syntax check + build + test

---

## Phase 7: CEO Review

**Goal:** Ship what was approved.

| Check | Method |
|-------|--------|
| Does it match the mock? | Side-by-side comparison |
| Do all states work? | Click through state matrix |
| Is it fast? | Check performance targets from P2 |
| Does dark mode work? | Toggle theme |
| Does keyboard work? | Try all shortcuts from P3 |
| Does it break existing features? | Full regression test |

**If CEO finds issues:** File as specific bugs → fix agents → rebuild → re-review.

---

## Folder Structure Per Feature

```
docs/specs/features/FNN-feature-name/
├── spec.md                    ← Master spec (product vision + prep checklist)
├── research/
│   └── p0-foundation.md       ← P0: what exists, data models, industry research
├── components/ (or categories/)
│   ├── C01-name.md            ← P1: deep spec per component
│   ├── C02-name.md
│   └── ...
├── architecture.md            ← P2: data model, engine, protocol, safety
├── signalr-protocol.md        ← P2: frontend↔backend message contract
├── states/
│   ├── component-a.md         ← P3: state matrix per UI component
│   ├── component-b.md
│   └── ...
└── mocks/
    ├── feature-shell.html     ← P4: CEO-reviewable interactive mock
    └── ...
```

---

## Agent Dispatch Patterns

**What works:**
- One agent, one file, one clear contract
- Parallel dispatch for independent units (6 category specs, 5 state matrices)
- Specialist personas (Canvas engineer, form UX expert, security architect)
- Agent reads ALL context before writing (P0 → P1 → P2 → P3 → P4 chain)

**What fails:**
- One agent editing 4+ files (CSS conflicts, missed interactions)
- Agent assuming code content instead of reading it
- Agent reading EDOG-patched FLT code as real FLT code
- Abstract specs without file:line references
- Mocks built without state matrices (missing states)
- Implementation without approved mock (rework)

**Model choice:**
- Opus 4.6 1M for everything — research, specs, mocks, implementation
- The 1M context window is essential: agents need to read 50-100KB of specs + source

---

## Timing Guide

| Phase | Typical Duration | Parallel Agents |
|-------|-----------------|-----------------|
| P0: Research | 1 agent, 10 min | 1-2 |
| P1: Component Specs | 6 agents, 8 min each | All parallel |
| P2: Architecture | 2 agents, 12 min each | 2 parallel |
| P3: State Matrices | 5 agents, 7 min each | All parallel |
| P4: Mocks | 1 agent, 8 min per mock | Sequential (one vision) |
| P5: Implementation | Varies by feature size | 1 per file |
| P6: Bug Hunt | 4+4+3 agents, 5 min each | Batched |

**Total for a major feature (F24 Chaos or F08 DAG Studio): ~2-3 hours of wall time with parallel agents.**

---

*"Divide until trivial. Verify before proceeding. Never assume."*

— EDOG Studio Feature Development SOP
