# EDOG-STUDIO AGENT PERFORMANCE EVALUATION

> **Status:** 🟢 ACTIVE
> **Applies To:** All edog-studio agents
> **Last Updated:** 2026-04-08

---

## Philosophy

### Why We Measure

edog-studio is built by 9 AI agents channeled through Copilot. There's no Jira, no sprint velocity, no standup. We measure quality per deliverable — not output per time period.

### What We Believe

1. **Outcomes over output** — Shipping broken code fast is worse than shipping quality code slower.
2. **The Studio Bar is the bar** — "Would a senior FLT engineer choose this over their current workflow?"
3. **Domain-specific metrics** — A CSS engineer is measured differently than a C# engineer.
4. **Per-feature review, not time-based** — We evaluate when features ship, not on a calendar.

---

## The Evaluation Framework

### Universal Dimensions

Every agent is evaluated on 4 dimensions:

| Dimension | Weight | Description |
|-----------|--------|-------------|
| **Quality** | 40% | Does the deliverable meet the Studio Bar? |
| **Correctness** | 30% | Does it work under normal AND edge conditions? |
| **Craft** | 20% | Does it follow conventions, show attention to detail? |
| **Collaboration** | 10% | Does the agent communicate, escalate, and coordinate? |

### Scoring Scale

| Score | Label | Meaning |
|-------|-------|---------|
| 1 | Below Bar | Violates constraints, breaks things, or ignores standards |
| 2 | Approaching | Works but missing edge cases, shortcuts taken |
| 3 | At Bar | Meets the Studio Bar — tested, styled, keyboard-accessible, documented |
| 4 | Above Bar | At Bar + polished, performant, delightful |
| 5 | Exceptional | Above Bar + innovative, teaches others, users love it |

**Minimum acceptable score: 3**

---

## Domain-Specific Metrics

### Frontend: Zara Okonkwo + Mika Tanaka

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Initial render time | < 200ms | Chrome DevTools Performance tab |
| View switch latency | < 50ms | Keyboard shortcut → paint (Performance tab) |
| Log entry append | < 5ms per entry | Profile `addEntry()` with `console.time()` |
| Zero-jank scroll | 0 dropped frames at 1000+ entries | DevTools FPS counter during scroll |
| Memory (1hr session) | < 200MB | Chrome Task Manager after 1hr |
| Bundle size impact | Track delta per change | `build-html.py` output size diff |
| Layout shift | 0 CLS during state transitions | Visual inspection + DevTools |
| OKLCH compliance | 100% | `check_css_uses_oklch()` quality gate |
| 4px grid compliance | 100% | Grep for bare `px` values outside `:root` |
| Keyboard accessibility | Every action via keyboard | Manual test: complete workflow without mouse |
| No emoji in UI | 0 emoji characters | `check_no_emoji_in_frontend()` quality gate |
| No framework imports | 0 React/Vue/Angular references | `check_no_frameworks_in_js()` quality gate |

**Zara-specific:**
- Virtual scroll renders 10,000 entries without jank
- WebSocket reconnection works within 5 seconds
- No synchronous DOM reads in loops (layout thrashing)

**Mika-specific:**
- All new CSS uses custom properties, not hardcoded values
- Color contrast meets WCAG AA (OKLCH makes this measurable)
- Transitions are ≤ 150ms ease-out or instant

---

### Backend (C#): Arjun Mehta

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Interceptor overhead | < 1ms per log entry | `Stopwatch` in test harness |
| Memory overhead | < 50MB total | .NET memory profiler |
| Zero-allocation hot paths | 0 `new` in per-log-entry code | Code review + `dotnet-counters` |
| StyleCop compliance | 0 warnings | `dotnet build` with analyzers |
| DI graph cleanliness | No service locator usage | Code review |
| Null-safety | `#nullable disable` on all DevMode files | Build check |
| XML doc coverage | 100% on public types/methods | Compiler warning check |
| Error resilience | Interceptor failure never crashes FLT | Unit tests with fault injection |
| `ConfigureAwait(false)` | On all awaits in library code | Code review |

**What "zero overhead" means:**
The C# interceptors run inside the FLT service process. If they add latency to request processing or allocate on every log entry, they are degrading the developer's actual work. Interceptor overhead must be invisible.

---

### Python: Elena Voronova

| Metric | Target | How to Measure |
|--------|--------|----------------|
| CLI startup time | < 500ms to first output | `time python edog.py --help` |
| Token fetch latency | < 10s for MWC token | `time python edog.py --token-only` |
| API proxy overhead | < 50ms added latency | Request timing comparison |
| Build time (build-html.py) | < 2s | `time python build-html.py` |
| Type hint coverage | 100% on function signatures | `ruff check` / manual review |
| PEP 8 compliance | 0 violations | `ruff check` |
| Error message quality | Actionable, specific, suggests fix | Manual review per error path |
| No bare `except` clauses | 0 | `grep "except:" *.py` |
| pathlib usage | 100% (no `os.path.join`) | `grep "os.path" *.py` |

**What "good error messages" means:**
```python
# Bad
print("Error: token fetch failed")

# Good
print(f"Token fetch failed for workspace {workspace_id}")
print(f"  Cause: {e}")
print(f"  Try: Close browser windows and run: edog.cmd --refresh-token")
```

---

### QA: Ines Ferreira

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Test coverage (Python critical paths) | 80%+ | `pytest --cov` |
| Test coverage (C# public methods) | 80%+ | `dotnet test --collect:"Code Coverage"` |
| Flaky test rate | 0% | Run suite 5x, all pass every time |
| Test naming convention | 100% compliance | `test_<what>_<condition>_<expected>` pattern |
| Browser checklist completion | 100% per UI change | Manual checklist verification |
| Regression detection | Catch before ship | No regressions reach "done" state |
| Test execution time | < 30s for full Python suite | `time pytest` |
| No tests that test mocks | 0 | Code review — assertions must verify behavior |

---

### UX: Kael Andersen

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Keyboard accessibility | 100% of actions | Complete workflow without mouse |
| Information density score | High — no wasted space | The 100x100 pixel test (see CULTURE.md) |
| Focus indicator visibility | All focusable elements | Tab through the UI, verify visible focus |
| Tab order logic | Natural reading/usage order | Tab through, verify sequence makes sense |
| Shortcut discoverability | All shortcuts shown somewhere | Command palette lists all, tooltips show key |
| View consistency | All 6 views follow same layout pattern | Visual comparison |
| Empty state quality | Helpful, not blank | Load with no data, verify guidance shown |
| Error state quality | Actionable, not just "Error" | Trigger failures, verify messages help |

---

### Build/DevOps: Ren Aoki

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Build reproducibility | Same input → same output | Run `build-html.py` twice, diff outputs |
| Install time | < 60s for first setup | `time install.ps1` |
| Build time | < 2s for frontend | `time python build-html.py` |
| CI pass rate | 100% on main branch | GitHub Actions history |
| Single-file validity | Zero external references in output | `check_single_file_build()` quality gate |
| Module order correctness | Dependencies before dependents | Build + verify all classes resolve |

---

### FLT Expert: Dev Patel

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Patch maintenance | All patches apply cleanly to latest FLT | `python edog.py --dry-run` |
| FLT API accuracy | Correct endpoint URLs, params, headers | Compare against FLT source |
| Feature flag sync | All flags in UI match FeatureManagement repo | Diff against repo |
| Domain documentation | Key FLT concepts documented for non-FLT agents | Check docs/ for coverage |
| Integration test coverage | Happy path + auth failure + timeout | Test suite review |

---

## Evaluation Process

### When We Evaluate

We evaluate **per feature**, not on a calendar.

```
Feature work starts
  → Agent claims ownership
  → Agent delivers
  → Quality review against this rubric
  → Score recorded
  → Feature ships or goes back for rework
```

### Who Evaluates

| Agent | Primary Evaluator | Secondary |
|-------|-------------------|-----------|
| Sana | CEO (Hemant) | — |
| Kael | CEO (Hemant) | — |
| Zara, Mika | Kael (UX Lead) | Sana (architecture) |
| Arjun | Sana (Tech Lead) | — |
| Elena | Sana (Tech Lead) | — |
| Dev | Sana (Tech Lead) | — |
| Ines | Sana (Tech Lead) | — |
| Ren | Sana (Tech Lead) | — |

### Evidence Sources

- Code diff (did the change follow standards?)
- Build output (does it compile, pass tests?)
- Browser verification (does it work in Edge/Chrome?)
- Performance profile (does it meet latency targets?)
- Quality gate results (automated checks pass?)

---

## Consequences

### Consistently At/Above Bar (3+)

- More autonomy on implementation decisions
- Trusted to make architectural choices in their domain
- Asked to review other agents' work

### Below Bar (< 3)

- Rework required before shipping
- More detailed specification from lead before starting
- Paired with a domain expert for the next deliverable
- If persistent: role reassignment or removal from the team

---

## Self-Assessment

Before claiming any deliverable is complete, score yourself:

```
QUALITY:       [1-5] — Does it meet the Studio Bar?
CORRECTNESS:   [1-5] — Edge cases, error states, overflow?
CRAFT:         [1-5] — Conventions, naming, documentation?
COLLABORATION: [1-5] — Did I coordinate where needed?

Evidence:
- [What I built]
- [How I tested it]
- [What quality gates pass]
- [What I'd do differently next time]
```

If your self-score is below 3 on any dimension, fix it before shipping.

---

*"We don't measure how fast you type. We measure whether the user reaches for the mouse."*

— edog-studio performance
