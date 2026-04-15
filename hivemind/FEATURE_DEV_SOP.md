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

## Design Philosophy — "The F16 Standard"

> Established after the F16 Infra Wizard mock achieved first-take CEO approval.
> Every mock and implementation must embody these principles.

### 1. Layered Token Architecture

Don't use raw colors. Build a **semantic token system** with depth layers:

```
Surfaces:   surface → surface-2 → surface-3          (white → off-white → light gray)
Borders:    border (0.06 opacity) → border-bright (0.12)
Text:       text → text-dim → text-muted             (near-black → gray → light gray)
Accent:     accent → accent-dim (0.07) → accent-hover (0.04) → accent-glow (0.15) → accent-soft (0.10)
Elevation:  shadow-sm → shadow-md → shadow-lg → shadow-xl → shadow-dialog
```

Every element lives at a **specific semantic layer**. Surfaces create depth without borders. Borders separate when surfaces can't. Accent is used **sparingly** — a whisper, not a shout.

### 2. Physics-Based Motion

Three timing curves, each with a purpose:

| Curve | Value | When |
|-------|-------|------|
| `--ease` | `cubic-bezier(0.4, 0, 0.2, 1)` | Standard transitions (hover, focus, state change) |
| `--spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Scale animations — overshoots 1.0 slightly, feels alive |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Exit animations — starts fast, decelerates |

Three speed tiers:

| Speed | Value | When |
|-------|-------|------|
| `--t-fast` | `80ms` | Hover/focus feedback (near-instant) |
| `--t-normal` | `150ms` | State transitions (button press, toggle) |
| `--t-page` | `360ms` | Page/panel transitions (dramatic but not slow) |

**Rule:** Every animated property has an explicit duration + curve. No `transition: all 0.3s ease` shortcuts.

### 3. Purposeful Animation Vocabulary

Name every animation. If you can't name it, you don't need it.

| Pattern | What It Does | CSS |
|---------|-------------|-----|
| `dialogIn` | Modal entrance — scale(0.94) + translateY(16px) → normal | Combined transform feels like it "rises into place" |
| `overlayIn` | Backdrop — blur(0→8px) + opacity fade | Creates depth, not just dimming |
| `slideLeft/Right` | Page transitions — 60px lateral slide + fade | Direction indicates forward/backward navigation |
| `scaleSpring` | Element entrance — scale(0.85) with spring curve | The spring overshoot adds life |
| `checkPop` | Completion indicator — scale(0→1.2→1) | The 1.2 overshoot creates satisfaction |
| `pulseAccent` | Active/in-progress — box-shadow breathe (0→6px→0) | Subtle breathing = "I'm alive" |
| `flowDash` | Connection lines — stroke-dashoffset animation | Shows data flow direction |

**Target:** 20-30 named animations per complex mock. Each serves UX, not decoration.

### 4. Hover That Teaches

Every interactive element must teach affordance through hover:

```css
/* Cards lift + shadow deepens = "I'm clickable" */
.card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }

/* Buttons lift subtly = "I'm about to do something" */
.btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(accent,0.3); }

/* Circles scale = "I'm a small target, let me help" */
.step-circle:hover { transform: scale(1.1); }

/* Icons change color + get background = "I have a function" */
.icon-btn:hover { background: var(--surface-3); color: var(--accent); }
```

**Rule:** `-1px` lift for buttons. `-2px` lift for cards/panels. `scale(1.1)` for small targets. Never more.

### 5. Typography Precision

Six deliberate size stops — not arbitrary pixel values:

| Token | Size | Usage |
|-------|------|-------|
| `--text-xs` | 10px | Badges, timestamps, fine print |
| `--text-sm` | 12px | Labels, hints, secondary info |
| `--text-md` | 13px | Body text, inputs, default |
| `--text-lg` | 15px | Section titles, dialog titles |
| `--text-xl` | 18px | Page headings |
| `--text-2xl` | 22px | Feature names, hero text |

Form labels: `font-size: xs; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em` — this pattern creates authority without shouting.

### 6. Compound Elevation

Every shadow is **two shadows** — ambient (wide, soft) + key light (tight, sharp):

```css
--shadow-sm:     0 1px 2px rgba(0,0,0,0.04);
--shadow-md:     0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
--shadow-lg:     0 4px 16px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04);
--shadow-xl:     0 12px 40px rgba(0,0,0,0.10), 0 4px 12px rgba(0,0,0,0.06);
--shadow-dialog: 0 24px 80px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.08);
```

The `dialog` level is reserved for modals only. The jump from `xl` to `dialog` creates real depth hierarchy.

### 7. Accent Restraint

Accent color (#6d5cff) appears in exactly these contexts:
- Active step indicators (circle border + label)
- Focused input glow ring
- Primary buttons (solid fill)
- Selected card borders
- Code syntax highlights
- Status indicators (but use status-ok green, not accent, for "done")

**Accent is never a background fill** except on primary buttons. For surfaces, use `accent-dim` (7% opacity) or `accent-hover` (4% opacity).

### 8. Context-Saturated Agent Prompt

The mock agent must **absorb all research before touching CSS**. The prompt includes:
1. ALL P0 research docs (code audit, industry research, UX research, canvas research)
2. Complete design bible / design system
3. Previous approved mocks as quality benchmark
4. Full spec with requirements, edge cases, and user flows
5. Explicit instruction: "Read every document. Internalize the design language. Then — and only then — write."

**This is not optional.** The difference between a generic mock and an extraordinary one is the 180KB of context that preceded it.

---

## Phase 4: Interactive Mocks

**Goal:** CEO opens it in a browser, clicks everything, says "build this."

| Task | What | Who | Output |
|------|------|-----|--------|
| P4.N | **One HTML mock per major view** | Pixel (design god persona) | `mocks/component-name.html` |

**Requirements:**
- Self-contained single HTML file (inline CSS + JS, Google Fonts only)
- Interactive — all states clickable and transition-animated
- Realistic mock data (themed to the feature, not "Lorem ipsum")
- Full token system from Design Philosophy §1 (surfaces, borders, text, accent, elevation)
- Physics-based motion from Design Philosophy §2 (spring curves, three speed tiers)
- 20-30 named keyframe animations per complex mock (Design Philosophy §3)
- Hover affordance on every interactive element (Design Philosophy §4)
- Typography precision with 6-stop scale (Design Philosophy §5)
- Compound elevation shadows (Design Philosophy §6)
- Production-quality CSS — this should look shippable, not prototypical

**Rules:**
- ONE agent per mock (not a swarm — needs one cohesive vision)
- Agent reads ALL of P0-P3 for context (Design Philosophy §8 — non-negotiable)
- Agent reads Design Bible + previous approved mocks for quality benchmark
- Agent absorbs 100-200KB of context before writing a single line of CSS
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
