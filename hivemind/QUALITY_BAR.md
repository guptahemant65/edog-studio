# THE STUDIO BAR

> **Status:** 🟢 ACTIVE  
> **Applies To:** All edog-studio agents  
> **Last Updated:** 2026-04-08

---

## Purpose

Before writing a single line of code, every agent must understand what "quality" means for a developer tool that senior engineers use 8 hours a day. This isn't an abstract exercise — our users will notice every janky animation, every unclear label, every unnecessary click.

---

## Part 1: Fundamental Questions

### Q1: What Is "Quality Work" for a Developer Tool?

**Definition:** Quality work is output that:
1. **Solves the actual problem** — not a symptom, not an adjacent issue
2. **Works correctly** under normal AND edge conditions
3. **Feels fast** — latency is a bug in developer tools
4. **Respects the user's flow** — zero unnecessary context switches
5. **Can be understood** by an agent who didn't write it

**The Developer Tool Test:**
> Imagine you're a senior engineer debugging a production incident at 2 AM. Your tool:
> - Shows you what you need without clicking through menus (information density)
> - Responds instantly when you press a shortcut (performance)
> - Doesn't crash or stall when logs are flooding in (reliability)
> - Doesn't make you reach for the mouse (keyboard-first)
>
> A pretty tool that adds friction to debugging is a *bad* tool.

---

### Q2: What Is "Our Bar"?

**The Studio Bar:** Code that a **senior FLT engineer would want to use 8 hours/day**.

Not "would tolerate." Not "could use if they had to." Would *want* to use. Would choose over their current workflow of manually juggling terminals, Kusto queries, and Azure portal tabs.

**The Three-Layer Test:**

| Layer | Question | Minimum Standard |
|-------|----------|------------------|
| **Does it work?** | Does it solve the problem correctly? | 100% of stated requirements |
| **Is it fast?** | Does it feel instant? | Renders in < 200ms, shortcuts < 50ms |
| **Is it dense?** | Does it show what matters without clutter? | Information-rich, not decoration-rich |

**The Bar in Practice:**

| Scenario | Below Bar | At Bar | Above Bar |
|----------|-----------|--------|-----------|
| Log viewer | Shows logs | + filterable + color-coded levels | + smart grouping + clickable stack traces |
| Token display | Shows "valid/expired" | + countdown timer + color shift | + decoded JWT claims on click |
| Error message | "Error occurred" | "Token expired 3 min ago" | "Token expired — press R to refresh, or Ctrl+K → 'token'" |
| Keyboard shortcut | Not implemented | Works correctly | + discoverable via Ctrl+K + shown in tooltip |

---

### Q3: What Does "Done" Mean?

**"Done" is NOT:**
- ❌ "I wrote the code"
- ❌ "It compiles / the build passes"
- ❌ "It works when I test it manually once"
- ❌ "The happy path works"

**"Done" IS when ALL of these are true:**

```
□ Code solves the stated problem
□ Edge cases handled (empty state, error state, overflow, rapid input)
□ Tested (automated where possible, browser-verified for UI)
□ Keyboard accessible (if it's a UI feature)
□ Performance verified (meets targets from ENGINEERING_STANDARDS)
□ Follows the style guide (OKLCH colors, 4px grid, naming conventions)
□ Integrated into the runtime (not just built — wired and callable)
□ Another agent could maintain this without asking you questions
□ You would use this feature yourself without frustration
```

---

### Q4: When Is "Good Enough" Acceptable?

| Situation | Target |
|-----------|--------|
| Spike / prototype | Good Enough — but mark it clearly and don't merge it |
| Internal plumbing (build script, config parsing) | Good Enough + tests |
| UI feature users see 8 hours/day | Excellent. No exceptions. |
| Token/auth flow | Excellent + security review |
| Log viewer performance | Excellent — this is our showcase |

**The difference:**
- **Good Enough** solves the problem, has tests, handles obvious edge cases.
- **Excellent** does all of the above AND: feels polished, has keyboard support, handles 99th-percentile load, delights the user with thoughtful details.

---

### Q5: What Are Unacceptable Shortcuts?

**Zero Tolerance:**

| Shortcut | Why It's Unacceptable | Do Instead |
|----------|----------------------|------------|
| Weaken test assertions | Hides bugs | Fix the code |
| Add a framework to save time | Breaks the single-file constraint permanently | Write vanilla JS |
| Use RGB/HSL "just this once" | Color system fragmentation | Convert to OKLCH |
| Skip keyboard support | "Users can click" — our users don't want to | Add the shortcut |
| Hardcode pixel values | Breaks the spacing system | Use `var(--space-*)` |
| Catch and swallow exceptions | Silent failures are the worst failures | Handle, log, or propagate |
| Ship without browser-testing | "It looks right in my head" is not validation | Open the browser |
| "TODO: fix later" without a ticket | It never gets fixed | Create the ticket now |

---

### Q6: Speed vs. Quality

**Our Position:** Quality is non-negotiable. Speed is a variable.

For developer tools specifically:

| Trade-off | Decision |
|-----------|----------|
| Ship fast with jank vs. ship later without jank | Ship later. Jank erodes trust. |
| Simple but slow vs. complex but fast | Complex but fast. Performance IS a feature. |
| Minimal UI vs. information-dense UI | Information-dense. Our users are experts. |
| Mouse-friendly vs. keyboard-first | Keyboard-first. Mouse as fallback. |

---

## Part 2: The Quality Rubric

### Scoring (0–5)

| Score | Level | Description |
|-------|-------|-------------|
| 0 | **Unacceptable** | Broken, insecure, or violates constraints |
| 1 | **Poor** | Works but fragile, no tests, wrong color space |
| 2 | **Below Bar** | Works, some tests, but missing edge cases or keyboard support |
| 3 | **At Bar** ✓ | Works, tested, edge cases handled, keyboard accessible, follows style guide |
| 4 | **Above Bar** | At Bar + polished UX + performance optimized + well-documented |
| 5 | **Exceptional** | Above Bar + innovative + teaches others + users love it |

**Minimum acceptable score: 3**

### Quality Checklist (Use for Every Deliverable)

```
FUNCTIONALITY
□ Solves the stated problem completely
□ Handles empty state (no data, no connection, no token)
□ Handles error state (network failure, invalid input, timeout)
□ Handles overflow (1000+ log entries, long strings, deep nesting)
□ Handles rapid input (fast typing in filters, rapid key presses)
□ Fails gracefully with helpful, actionable messages

UI / UX (if applicable)
□ Keyboard accessible — reachable without mouse
□ Follows OKLCH color system
□ Uses 4px spacing grid (var(--space-*))
□ Information-dense but readable
□ No layout shift during loading or state transitions
□ Consistent with existing views

CODE QUALITY
□ Follows style guide for the language
□ Functions are small and focused
□ Names are clear — no abbreviations without context
□ No magic numbers or strings
□ No dead code
□ Comments explain WHY, not WHAT

TESTING
□ Tests exist for new functionality
□ Tests verify behavior (not just "doesn't crash")
□ Tests cover error paths
□ Browser-tested for UI changes
□ No flaky tests

PERFORMANCE
□ Meets render/latency targets
□ No unnecessary DOM manipulation
□ No memory leaks (especially in long-running sessions)
□ Interceptors add < 1ms overhead
```

---

## Part 3: The Developer Tool Difference

Building a developer tool is different from building a product for end users. Our users are engineers. They notice things.

### What Engineers Notice

| Detail | Reaction |
|--------|----------|
| 200ms delay on view switch | "This tool is slow" |
| Mouse-only action | "Did they even use this?" |
| Wasted screen space | "I could be seeing data here" |
| Inconsistent styling | "This feels unfinished" |
| Helpful error with suggested fix | "Whoever built this gets it" |
| Keyboard shortcut that just works | Trust. Continued use. |

### The 8-Hour Test

Before shipping a UI feature, ask:

> "Would I want to look at this for 8 hours?"
> - Is the contrast comfortable? (OKLCH helps here)
> - Is the information density right? (Not too sparse, not overwhelming)
> - Are the animations subtle? (No bouncing, no sliding — instant or 150ms fade)
> - Does it respect my keyboard workflow?

---

## Part 4: Decision Framework

### "Should I Ship This?"

```
Does it solve the problem? ──NO──► Don't ship.
  │ YES
  ▼
Does it meet performance targets? ──NO──► Optimize first.
  │ YES
  ▼
Is it keyboard accessible? ──NO──► Add shortcuts.
  │ YES
  ▼
Does it follow the style guide? ──NO──► Fix styling.
  │ YES
  ▼
Would you use this 8 hours/day? ──NO──► What's wrong? Fix it.
  │ YES
  ▼
✅ SHIP IT
```

---

*"A developer tool that slows developers down is an insult disguised as a gift."*

— edog-studio quality bar
