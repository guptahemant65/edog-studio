# EDOG-STUDIO AGENT ONBOARDING

> "You don't rise to the level of your goals. You fall to the level of your systems." — James Clear

Welcome to edog-studio. You're joining a team of 9 AI agents building a developer cockpit for FabricLiveTable. This guide will get you productive.

---

## Part 1: Understand the Mission

### What You're Building

**edog-studio** is a localhost web UI (`http://localhost:5555`) that senior C# engineers use 8+ hours/day while developing FabricLiveTable. It replaces a workflow of manually juggling terminals, Azure portal tabs, Kusto queries, and token management.

### Who You're Building For

Senior Microsoft engineers who:
- Live in Visual Studio, terminals, and Kusto
- Debug distributed systems daily
- Value information density over visual polish
- Use keyboard shortcuts instinctively
- Will notice — and be annoyed by — every unnecessary click, slow render, or wasted pixel

### The Product in 30 Seconds

EDOG has two phases:
1. **Disconnected** — Browse workspaces, manage tokens, explore Fabric APIs
2. **Connected** — Full cockpit: live logs, DAG controls, Spark inspection, API playground

Six views, one browser tab, zero context switches.

---

## Part 2: Required Reading

Read these documents **in this order** before your first task:

### Day 1: Culture & Quality (1 hour)

| Order | Document | What You'll Learn |
|-------|----------|-------------------|
| 1 | `hivemind/CULTURE.md` | How we think: dogfood everything, keyboard-first, dense but readable |
| 2 | `hivemind/QUALITY_BAR.md` | What "done" means: the Studio Bar, the 8-hour test |

### Day 2: Standards & Style (1 hour)

| Order | Document | What You'll Learn |
|-------|----------|-------------------|
| 3 | `hivemind/ENGINEERING_STANDARDS.md` | Tech stack, build system, prohibited practices, performance targets |
| 4 | `hivemind/STYLE_GUIDE.md` | Code conventions for Python, C#, JS, CSS, Git |

### Day 3: Product (1.5 hours)

| Order | Document | What You'll Learn |
|-------|----------|-------------------|
| 5 | `edog-design-spec-v2.md` | Complete product spec — every view, every interaction |
| 6 | `edog-design-brief.md` | Design brief for UI/UX context |

### Confirmation

After reading, you should be able to answer:

- [ ] What are the 6 sidebar views?
- [ ] What's the difference between Phase 1 (Disconnected) and Phase 2 (Connected)?
- [ ] Why can't we use React or any frontend framework?
- [ ] What color space does all CSS use?
- [ ] What's the spacing grid base unit?
- [ ] What does `build-html.py` produce?
- [ ] What's the `#nullable disable` pragma for in C# files?
- [ ] What are the performance targets for view switches and log appends?

---

## Part 3: Your First Week

### Day 1: Orient

- Read the required documents (Part 2 above).
- Browse the codebase. Key files:
  ```
  edog.py                    — Python CLI (token management, API proxy)
  build-html.py              — Build script (assembles single-file HTML)
  src/edog-logs/             — Frontend source (CSS + JS modules)
  src/edog-logs.html         — Compiled frontend (single-file output)
  src/Edog*.cs               — C# DevMode interceptors
  edog-config.json           — Runtime configuration
  edog-design-spec-v2.md     — Product specification
  ```
- Build the frontend: `python build-html.py`
- Don't write code yet. Understand first.

### Day 2: Build & Run

- Run the full tool: `edog.cmd`
- Open `http://localhost:5555` in your browser.
- Click through all views. Try keyboard shortcuts (1–6, Ctrl+K).
- Read the build script (`build-html.py`) to understand how CSS/JS modules become a single file.
- Read 2–3 recent Git commits to understand patterns and conventions.

### Day 3–4: First Task

Your first task should be:
- **Small scope** — under 2 hours of work
- **Low risk** — not touching token auth or interceptor wiring
- **Clear patterns** — similar work exists in the codebase to reference
- **Verifiable** — you can see the result in the browser or test output

Good first tasks:
- Add a CSS custom property and use it somewhere
- Fix a spacing value to use `var(--space-*)` instead of hardcoded `px`
- Add a test case in `test_revert.py`
- Improve an error message in `edog.py`

### Day 5: Retrospective

Reflect on:
- What went well?
- What was confusing?
- What documentation was missing or unclear?
- What would make you more effective?

Document answers and share with the team.

---

## Part 4: How Work Flows

### Task Lifecycle

```
1. Task defined with clear requirements and acceptance criteria
2. Agent assigned as DRI (Directly Responsible Individual)
3. Agent reads relevant design spec sections
4. Agent implements with quality (follows standards + style guide)
5. Agent tests (automated + browser for UI)
6. Agent runs build to verify (python build-html.py / dotnet build)
7. Peer review
8. Merge
```

### What You Must NOT Do

- **Start without understanding requirements.** Ask before building.
- **Skip the build step.** If `build-html.py` fails, you broke something.
- **Add framework dependencies.** No npm, no CDN, no Tailwind, no React.
- **Use hardcoded colors or spacing.** Always `var(--color-*)` and `var(--space-*)`.
- **Weaken tests to make them pass.** Fix the code.
- **Ship without browser-testing UI changes.** Open the browser.

---

## Part 5: How to Get Help

### Asking Good Questions

```
BAD:  "The build is broken."
GOOD: "build-html.py fails with FileNotFoundError on line 45. 
       It's looking for src/edog-logs/js/new-module.js which 
       I added to CSS_MODULES by mistake. Fixing now, but 
       wanted to flag that the module arrays aren't validated."
```

Include:
1. What you're trying to do
2. What happened
3. What you expected
4. What you've already tried
5. Relevant error messages

### Who to Ask

| Question | Ask |
|----------|-----|
| Architecture / component boundaries | Architect |
| Product requirements / feature intent | Design spec first, then product owner |
| Python code patterns | CLI Engineer |
| C# interceptor patterns | Interceptor Engineer |
| Frontend patterns | Frontend Engineer |
| Build system | Build Engineer |
| "Is this good enough?" | QUALITY_BAR.md first, then any peer |

### The 30-Minute Rule

If you've been stuck for 30 minutes without progress, escalate. Spinning for 4 hours then asking is a failure, not heroism.

---

## Part 6: Quality Expectations

### The Studio Bar (Summary)

Your work must pass the **Three-Layer Test**:

| Layer | Question | Standard |
|-------|----------|----------|
| **Does it work?** | Solves the problem correctly? | All requirements + edge cases |
| **Is it fast?** | Meets performance targets? | View switch < 50ms, log append < 5ms |
| **Is it dense?** | Shows what matters without clutter? | Information-rich, keyboard-accessible |

### Before Submitting Work

```
□ Solves the stated problem
□ Edge cases handled (empty, error, overflow)
□ Tested (automated where possible, browser for UI)
□ Keyboard accessible (if UI)
□ Follows style guide (OKLCH, 4px grid, naming)
□ Build passes (python build-html.py && dotnet build)
□ Browser-tested (if UI change)
□ You would use this feature 8 hours/day without frustration
```

### Common Mistakes New Agents Make

| Mistake | Fix |
|---------|-----|
| Using `#hex` or `rgb()` for colors | Convert to `oklch()`, define as custom property |
| Hardcoding `padding: 12px` | Use `var(--space-3)` |
| Adding a click handler but no keyboard equivalent | Add keyboard shortcut + document it |
| Testing only the happy path | Test empty state, error state, overflow |
| Forgetting `build-html.py` after editing source modules | Always rebuild and check the compiled output |
| Writing "it works" without browser verification | Open the browser. Every time. |

---

## Part 7: Development Environment

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Python | 3.8+ | CLI, build script, tests |
| .NET SDK | 6.0+ | C# interceptor compilation |
| Browser | Edge or Chrome | Testing, dogfooding |
| Git | Any modern | Version control |
| Text editor | Any | Editing (VS Code recommended) |

### Key Commands

```bash
# Build the frontend
python build-html.py

# Run the tool
edog.cmd

# Run Python tests
pytest test_revert.py -v

# Check EDOG status
edog.cmd --status

# Revert all EDOG patches
edog.cmd --revert

# Build C# interceptors (from FLT repo)
dotnet build
```

### Project Structure

```
flt-edog-devmode/
├── hivemind/                  # Governance docs (you are here)
│   ├── README.md
│   ├── CULTURE.md
│   ├── QUALITY_BAR.md
│   ├── ENGINEERING_STANDARDS.md
│   ├── STYLE_GUIDE.md
│   └── ONBOARDING.md
├── src/
│   ├── edog-logs/             # Frontend source modules
│   │   ├── index.html         # HTML shell
│   │   ├── css/               # CSS modules (OKLCH, 4px grid)
│   │   └── js/                # JS modules (class-based, vanilla)
│   ├── edog-logs.html         # Compiled single-file frontend
│   ├── EdogLogInterceptor.cs  # C# log capture
│   ├── EdogTelemetryInterceptor.cs
│   ├── EdogApiProxy.cs
│   └── EdogLogServer.cs       # Serves the frontend
├── edog.py                    # Python CLI
├── edog-logs.py               # Log processing
├── build-html.py              # Frontend build script
├── test_revert.py             # Python tests
├── edog-config.json           # Runtime config
├── edog.cmd                   # Windows launcher
└── install.ps1                # Installation script
```

---

## Part 8: Your Commitment

By completing onboarding, you agree to:

> I have read the edog-studio governance documents. I understand the technical constraints (single-file HTML, no frameworks, OKLCH, 4px grid) and why they exist. I will uphold the Studio Bar — building a tool that senior engineers want to use 8 hours a day. I will dogfood my own work, test in the browser, and never take shortcuts that compromise quality.
>
> I will ask for help when stuck, escalate blockers within 30 minutes, and treat every pixel, every keystroke, and every millisecond as a reflection of the team's craft.

**Welcome to the team. Build something an engineer would love.**

---

*Document Version: 1.0*  
*Last Updated: 2026-04-08*
