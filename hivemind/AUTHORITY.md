# EDOG-STUDIO DOCUMENT AUTHORITY HIERARCHY

> **Status:** ACTIVE — MANDATORY READING
> **Classification:** INTERNAL — SUPREME GOVERNANCE
> **Applies To:** All edog-studio agents (Vex, Pixel, Sentinel, Sana)
> **Authority:** CEO (Hemant Gupta)
> **Last Updated:** 2026-04-12
> **Approved by:** CEO directive, 2026-04-12

---

## Purpose

This document establishes the authority hierarchy for all edog-studio documentation. When documents conflict, the higher-authority document wins. No exceptions. No "but the style guide says..." — if the Design Bible says otherwise, the Design Bible wins.

---

## The Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│  TIER 0: DESIGN BIBLE (SUPREME)                                │
│  The visual truth. Overrides ALL other documents on conflict.   │
│                                                                 │
│  docs/design/design-bible-part1.html                            │
│  docs/design/design-bible-part2.html                            │
│  docs/design/design-bible-part3.html                            │
│  docs/design/design-bible-part4a.html                           │
│  docs/design/design-bible-part4b.html                           │
│  docs/design/design-bible-part4c.html                           │
│  docs/design/component-library.html                             │
│  docs/design/notebook-ide-design.html                           │
├─────────────────────────────────────────────────────────────────┤
│  TIER 1: FEATURE SPECS + STATE MATRICES                        │
│  The behavioral truth. Every state, trigger, transition.        │
│                                                                 │
│  docs/specs/design-spec-v2.md                                   │
│  docs/specs/MVP-DECISIONS.md                                    │
│  docs/specs/features/F*/spec.md                                 │
│  docs/specs/features/F*/states.md                               │
├─────────────────────────────────────────────────────────────────┤
│  TIER 2: GOVERNANCE (Constitution, Roster, Quality Bar)         │
│  Process rules: who does what, how commits flow, veto power.    │
│                                                                 │
│  hivemind/agents/CONSTITUTION.md                                │
│  hivemind/agents/ROSTER.md                                      │
│  hivemind/QUALITY_BAR.md                                        │
│  hivemind/QUALITY_ENFORCEMENT.md                                │
├─────────────────────────────────────────────────────────────────┤
│  TIER 3: ENGINEERING STANDARDS + STYLE GUIDE                   │
│  Code conventions. Overridden by Tier 0/1 on conflict.         │
│                                                                 │
│  hivemind/ENGINEERING_STANDARDS.md                              │
│  hivemind/STYLE_GUIDE.md                                        │
│  docs/adr/ADR-*.md                                              │
├─────────────────────────────────────────────────────────────────┤
│  TIER 4: OPERATIONAL DOCS                                      │
│  How-to guides, debugging, onboarding, performance.            │
│                                                                 │
│  hivemind/CULTURE.md                                            │
│  hivemind/DEBUGGING.md                                          │
│  hivemind/RUNBOOKS.md                                           │
│  hivemind/ONBOARDING.md                                         │
│  hivemind/PERFORMANCE.md                                        │
│  hivemind/ADR_GUIDE.md                                          │
│  docs/DESIGN_SYSTEM.md                                          │
│  docs/*_ARCHITECTURE.md                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Conflict Resolution Rules

### Rule 1: Design Bible Is Supreme

The Design Bible (`docs/design/design-bible-*.html` + `component-library.html` + `notebook-ide-design.html`) is the **single source of visual truth**. It defines:

- Design tokens (colors, spacing, radii, shadows, transitions)
- Component patterns (how things look, animate, and behave)
- Interaction patterns (hover, focus, click states)
- Layout patterns (panels, drawers, grids)
- Typography (font families, sizes, weights)

**When the Bible conflicts with other docs, the Bible wins:**

| Bible Says | Other Doc Says | Winner |
|------------|----------------|--------|
| `--accent: #6d5cff` | STYLE_GUIDE: "OKLCH only" | **Bible** — use `#6d5cff` |
| `--transition: 160ms cubic-bezier(0.4,0,0.2,1)` | ENGINEERING_STANDARDS: "150ms ease-out" | **Bible** — use `160ms cubic-bezier` |
| `font-family: 'Inter', system-ui, sans-serif` | STYLE_GUIDE: system font stack | **Bible** — use Inter |
| `border-radius: var(--r6)` (6px) | STYLE_GUIDE: "4px grid only" | **Bible** — the Bible defines its own radius scale |
| `color-mix(in srgb, ...)` | STYLE_GUIDE: "OKLCH for all colors" | **Bible** — Bible's color functions are authoritative |

**Why:** The Design Bible contains the pixel-perfect visual references that the CEO approved. The engineering docs describe *coding conventions*. When the visual spec says "this is what it looks like," that overrides a coding convention. You build what the Bible shows, not what the style guide theorizes.

### Rule 2: State Matrices Are Required

Every feature must have a state matrix (`states.md`) before implementation begins. A feature without a state matrix is **not specified** and **not buildable**.

A state matrix documents:
- Every UI state (loading, empty, error, success, hover, focus, disabled)
- Every trigger (click, keypress, API response, timeout, WebSocket message)
- Every visual treatment (what the user sees in each state)
- Every transition (which states lead to which other states)

State IDs (e.g., `TREE-031`, `LOG-CONN-002`, `RTAB-010`) are referenceable in:
- Code comments: `// Implements TREE-031 (rename saving)`
- Bug reports: "Violates F01-TREE-035 — rename failure should keep input open"
- Code reviews: "This doesn't handle CONTENT-066 → RTAB-010 transition"
- Commit messages: `feat(workspace): implement TREE-030 through TREE-039 inline rename`

### Rule 3: Feature Specs Define Behavior

`design-spec-v2.md` and individual `F*/spec.md` files define **what the product does**. If a feature spec says "300ms crossfade" and the engineering standards say "no animations over 150ms," the feature spec wins for that specific component.

### Rule 4: Governance Still Applies to Process

Tier 0 and Tier 1 override *visual and behavioral* decisions. They do NOT override:
- Sentinel's veto power (Tier 2 governance)
- The 7-Gate Gauntlet process (Tier 2 governance)
- Code ownership rules (Tier 2 governance)
- Security requirements (Tier 3 engineering — no tokens in code)
- The single-file HTML constraint (Tier 3 engineering — architectural, not visual)
- Test requirements (Tier 2 governance)

**In other words:** The Bible tells you *what to build*. The Constitution tells you *how to ship it*.

---

## Mandatory Reading Order (Updated)

Before doing ANY work, every agent reads in this order:

### Session Start (Every Time)

1. **`hivemind/AUTHORITY.md`** ← THIS FILE (know the hierarchy)
2. **`hivemind/agents/ROSTER.md`** — Team structure, who does what
3. **`hivemind/agents/CONSTITUTION.md`** — What you can/cannot do, escalation, veto
4. **`hivemind/ENGINEERING_STANDARDS.md`** — Tech stack, build, prohibited practices
5. **`hivemind/STYLE_GUIDE.md`** — Code conventions (Bible overrides on conflict)
6. **`hivemind/QUALITY_BAR.md`** — The Studio Bar, 7-Gate Gauntlet

### Before Implementing a Feature

7. **Design Bible** — Open the relevant `docs/design/design-bible-*.html` in a browser. Study the component patterns you'll use.
8. **Feature spec** — `docs/specs/features/F*/spec.md`
9. **State matrix** — `docs/specs/features/F*/states.md` (if no states.md exists, **write one first**)
10. **Design spec** — Relevant section of `docs/specs/design-spec-v2.md`

### As Needed

- `hivemind/DEBUGGING.md` — When things break
- `hivemind/RUNBOOKS.md` — Operational procedures
- `docs/adr/ADR-*.md` — When questioning a settled decision

---

## Design Bible Contents (Quick Reference)

| File | Sections | What It Defines |
|------|----------|-----------------|
| **Part 1** | §1–8 | Icons, GUID display, badges, progress indicators, CRUD operations, data tables, form inputs, tabs & navigation |
| **Part 2** | §9–16 | Panels & drawers, code & JSON viewers, graph components, empty states, tooltips, notifications & alerts, animation library, keyboard shortcuts |
| **Part 3** | §17–20 | Data-heavy components, real-time & status indicators, layout & overflow patterns, domain-specific UI |
| **Part 4a** | §21–23 | Real-time data visualization: log entries, HTTP & API patterns, token visualization |
| **Part 4b** | §24–26 | Dashboard cards, wizard & multi-step forms, test & comparison patterns |
| **Part 4c** | §27–30 | Confirmation patterns, data export menus, density modes, reduced motion & accessibility |
| **Component Library** | — | Complete component reference: icons, GUIDs, badges, CRUD, tables, CSS interactions |
| **Notebook IDE** | §1–12 | Notebook mini IDE: layout, toolbar, code cells, outputs, between-cell actions, run status, environment switching, keyboard shortcuts |

---

## Design Bible Design Tokens (Authoritative)

These are the canonical values from the Bible. Use these, not values from other docs.

```css
/* Colors — Bible uses hex, NOT OKLCH */
--accent:   #6d5cff;
--green:    #18a058;
--amber:    #e5940c;
--red:      #e5453b;
--blue:     #2d7ff9;
--purple:   #a855f7;
--teal:     #0d9488;

/* Backgrounds (light theme) */
--bg:       #fff;
--bg-2:     #f8f9fb;
--bg-3:     #f4f5f7;
--bg-4:     #ebedf0;

/* Backgrounds (dark theme) */
--bg:       #0f1117;
--bg-2:     #161923;
--bg-3:     #1e2230;
--bg-4:     #252a38;

/* Text (light) */
--text:     #1a1d23;
--text-2:   #5a6070;
--text-3:   #8e95a5;

/* Text (dark) */
--text:     #e8eaf0;
--text-2:   #9aa0b2;
--text-3:   #5f6578;

/* Borders */
--border:        rgba(0,0,0,0.06);    /* light */
--border-bright: rgba(0,0,0,0.12);    /* light */
--border:        rgba(255,255,255,0.06);  /* dark */
--border-bright: rgba(255,255,255,0.12);  /* dark */

/* Radii — Bible's own scale, NOT restricted to 4px multiples */
--r4:   4px;
--r6:   6px;
--r10:  10px;
--r16:  16px;
--r100: 100px;

/* Shadows */
--shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
--shadow-md: 0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04);
--shadow-lg: 0 8px 32px rgba(0,0,0,0.12), 0 4px 8px rgba(0,0,0,0.06);

/* Transitions */
--transition: 160ms cubic-bezier(0.4,0,0.2,1);

/* Typography */
--font:  'Inter', system-ui, sans-serif;
--mono:  'Cascadia Code', 'Consolas', monospace;
```

---

## Enforcement

- **Pixel** must open the Design Bible HTML files in a browser before implementing any UI component. Match the Bible, not your memory of the style guide.
- **Sentinel** checks implementations against Bible mockups during Gate 3 (Scenario) and Gate 5 (Edge Cases). Visual mismatch from the Bible is a blocking issue.
- **Sana** arbitrates ambiguities — when the Bible doesn't cover a specific case, the closest Bible pattern applies. When no pattern applies, Sana decides and documents it.
- **Vex** follows Bible tokens for any backend-served UI (error pages, health endpoints with HTML responses).

---

*"The Bible is what we're building. Everything else is how we build it."*

— edog-studio governance, approved by CEO 2026-04-12
