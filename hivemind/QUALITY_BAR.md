# SENTINEL'S 7-GATE GAUNTLET

> **Status:** ACTIVE — ENFORCED  
> **Authority:** Sentinel (QA Lead) has unconditional veto power  
> **Applies To:** Every commit, every feature, every change — no exceptions  
> **Last Updated:** 2025-07-24

---

## Purpose

EDOG Studio shipped 45 fix commits out of 151 total. That is a **30% bug-fixing churn rate**. Nearly one in three commits existed only to correct mistakes that should never have been merged. Features shipped with untested branches, unhandled error paths, missing edge cases, and integration points that were never verified. The old quality gates existed on paper. They were not enforced. That era is over.

This document defines **Sentinel's 7-Gate Gauntlet** — a mandatory, sequential quality process that every change must pass before it can be committed. Sentinel, the QA Lead, owns this process and has **unconditional veto power**. No agent may commit code without Sentinel's explicit `APPROVED` verdict. There is no appeals process. There are no exceptions. There is no "I'll add tests later."

The goal is simple: **zero preventable defects reach the codebase.**

---

## The Studio Bar

The fundamental quality question has not changed:

> **Would a senior FLT engineer choose this over their current workflow?**

Not "would tolerate." Not "could use if forced." Would **choose** — over manually juggling terminals, Kusto queries, and Azure portal tabs. Would open first thing in the morning. Would recommend to their team.

**The Three-Layer Test:**

| Layer | Question | Minimum Standard |
|-------|----------|------------------|
| **Does it work?** | Correctly, in all states? | 100% of stated requirements + error states + empty states |
| **Is it fast?** | Does it feel instant? | Renders < 200ms, shortcuts < 50ms, no jank at 10K entries |
| **Is it dense?** | Does it show what matters? | Information-rich, not decoration-rich, zero wasted pixels |

**The Bar in Practice:**

| Scenario | Below Bar (BLOCKED) | At Bar (minimum) | Above Bar |
|----------|---------------------|-------------------|-----------|
| Log viewer | Shows logs | + filterable + color-coded + keyboard nav | + smart grouping + clickable stack traces + virtual scroll |
| Token display | Shows "valid/expired" | + countdown + color shift at warning threshold | + decoded JWT claims on hover + copy button |
| Error message | "Error occurred" | "Token expired 3 min ago — press R to refresh" | + contextual suggested fix + link to relevant view |
| Keyboard shortcut | Not implemented | Works correctly + shown in Command Palette | + discoverable via tooltip + Ctrl+K listing |
| Empty state | Blank area | Clear message explaining why + what to do next | + one-click action to resolve (e.g., "Connect to workspace") |

---

## The Team

| Agent | Role | Domain | Signs Off On |
|-------|------|--------|--------------|
| **Vex** | Backend Engineer | Python + C# | Backend logic, IPC, interceptors, CLI |
| **Pixel** | Frontend Engineer | JS + CSS | UI modules, DOM rendering, WebSocket client, styles |
| **Sentinel** | QA Lead + Gatekeeper | All testing, quality process | **Everything. Has veto power.** |
| **Sana Reeves** | Architect + FLT Domain Expert | Architecture, FLT integration, system design | Architecture impact, cross-cutting concerns |

---

## The 7-Gate Gauntlet

Every change — feature, bugfix, refactor, config change — must pass through all seven gates **in order**. No gate may be skipped. No gate may be reordered. Sentinel controls the process.

---

### Gate 0: PRE-FLIGHT

**Before a single line of code is written.**

The building agent must produce a **Pre-Flight Brief** that answers:

```
PRE-FLIGHT BRIEF
================
Agent: [who is building this]
Feature/Change: [what, in one sentence]

1. WHAT I'M BUILDING:
   - [concrete description of the deliverable]
   - [files I expect to create or modify]
   - [components this touches]

2. WHAT CAN GO WRONG:
   - [failure mode 1 and how I'll handle it]
   - [failure mode 2 and how I'll handle it]
   - [failure mode N...]

3. WHAT I DON'T KNOW:
   - [unknowns, assumptions I'm making]
   - [questions for Sana or domain agents]

4. INTEGRATION POINTS:
   - [other components this talks to]
   - [message formats, IPC, config dependencies]

5. ESTIMATED RISK: Low / Medium / High
   - [justification]
```

**Gate 0 Reviewers:**
- **Sana Reeves** reviews architecture impact. If the change touches cross-cutting concerns (IPC, config format, data flow, new message types), Sana must approve the approach before coding begins.
- **Sentinel** writes the **Test Plan** — a concrete list of every scenario, every edge case, every integration point that must be verified. This plan is written BEFORE implementation, not after.

**Gate 0 Checkpoint:**
- If the agent cannot clearly explain what they are building, they are not ready to build it.
- If Sana identifies an architectural risk, coding does not begin until the risk is resolved.
- If Sentinel's test plan reveals the agent hasn't thought through failure modes, the brief is sent back.

**Gate 0 produces:** Approved Pre-Flight Brief + Sentinel's Test Plan.

---

### Gate 1: UNIT — Every Function, Every Branch

**Every new or changed function has tests. No exceptions.**

| Requirement | What It Means | Example |
|-------------|---------------|---------|
| Every function tested | If you wrote it or changed it, it has a test | `test_parse_workspace_id_valid`, `test_parse_workspace_id_empty`, `test_parse_workspace_id_malformed` |
| Every branch covered | Every `if/else`, every `try/except`, every early return | If a function has 3 branches, there are at least 3 tests |
| Error paths tested for correct behavior | Not just "doesn't crash" — correct error message, correct state, correct recovery | `assert error.message == "Workspace ID must be a valid GUID"` |
| Return values verified | Tests assert on the actual output, not just that no exception was raised | `assert result.status == "disconnected"`, not just `assert result is not None` |
| Edge inputs exercised | Boundary values, empty inputs, None/null, maximum length | `test_filter_with_empty_string`, `test_filter_with_500_char_input` |

**Sentinel's Gate 1 question:** *"What input would break this function?"*

If the building agent cannot answer that question for every function they wrote, Gate 1 fails.

**Gate 1 produces:** Unit test suite with branch-level coverage for all new/changed code.

---

### Gate 2: INTEGRATION — Components Actually Talk Correctly

**Individual units working in isolation means nothing if they don't compose correctly.**

| Integration Point | What Must Be Tested |
|-------------------|---------------------|
| Python <-> C# IPC | Command files written by Python are read correctly by C#. Response files written by C# are parsed correctly by Python. File locking and cleanup work. Race conditions between write and read are handled. |
| JS <-> WebSocket | Messages sent from EdogLogServer arrive in the JS client intact. Reconnection after disconnect works. Message ordering is preserved. Binary/large payloads don't corrupt. |
| Config propagation | Changes to `edog-config.json` are picked up by all consumers. Invalid config produces a clear error, not silent misbehavior. Missing keys use documented defaults. |
| File watchers | File creation/modification/deletion events trigger the correct callbacks. Rapid file changes don't cause duplicate processing. Watcher cleanup on shutdown is verified. |
| Token flow | Token acquisition, caching, expiry detection, and refresh work end-to-end. Expired token mid-operation is handled gracefully. Token format changes don't cause silent auth failures. |
| Build pipeline | `build-html.py` produces valid single-file HTML from current source. All CSS and JS modules are inlined correctly. No missing references in the output. |

**Gate 2 failure example:** "The Python CLI writes a command file, but the C# server expects a different field name. Unit tests pass for both sides individually. Integration is broken."

This is exactly the kind of bug that caused our 30% fix-commit rate. Gate 2 exists to catch it.

**Gate 2 produces:** Integration test results proving cross-component communication works.

---

### Gate 3: SCENARIO — Full User Journeys, Start to Finish

**Walk through the feature as a real user. Every click, every keypress, every state transition.**

**Disconnected Mode Scenarios:**
```
□ Launch EDOG Studio with no prior config — what does the user see?
□ Browse workspaces — expand, collapse, search, filter
□ Select a lakehouse — inspector shows correct metadata
□ Manage feature flags — view, toggle, verify persistence
□ Test Fabric APIs — send request, see response, handle auth failure
□ Switch between views — sidebar navigation, keyboard shortcuts
```

**Connected Mode Scenarios:**
```
□ Deploy to a lakehouse — full flow from selection to running service
□ View live logs — streaming, filtering, level selection
□ Inspect DAG — node selection, dependency visualization
□ Monitor Spark jobs — status updates, timing, error details
□ Use Command Palette — search, execute, keyboard-only flow
```

**State Transition Scenarios:**
```
□ Disconnected -> Connected: deploy flow completes, UI updates, new views unlock
□ Connected -> Error: service crashes, UI shows clear error state, no zombie processes
□ Error -> Recovery: user restarts, previous state is restored or cleanly reset
□ Connected -> Disconnected: user explicitly disconnects, connected-only views disable
□ Token expires mid-session: clear warning, suggested action, no silent failure
```

**Gate 3 requires** the building agent to literally narrate the user journey step-by-step. Sentinel walks through each scenario and verifies.

**Gate 3 produces:** Scenario test results with pass/fail per journey.

---

### Gate 4: ERROR — Every Failure Mode Handled

**If it can fail, it will fail. The question is whether the user gets a helpful message or a blank screen.**

| Failure Mode | Required Behavior | Unacceptable Behavior |
|--------------|-------------------|----------------------|
| Network timeout | Show elapsed time + "Retrying in Xs" or "Connection timed out — check network" | Spinner forever. Silent failure. Generic "Error." |
| Invalid/expired token | "Token expired 3 min ago — press R to refresh, or Ctrl+K and type 'token'" | "Unauthorized." "Error 401." Blank screen. |
| Process dies mid-operation | Clean up child processes, release file locks, show "Operation interrupted — [state summary]" | Zombie processes. Locked files. Corrupted partial state. |
| Config file corrupted/missing | Use defaults, warn user: "Config invalid at line X — using defaults. Edit config to fix." | Silent fallback with no indication. Crash on startup. |
| WebSocket disconnect | Attempt reconnect with backoff, show connection status indicator, queue missed messages if possible | Blank log view. No indication connection was lost. Duplicate messages on reconnect. |
| Disk full / write failure | "Cannot write to [path] — disk full or permission denied" + suggest resolution | Silent data loss. Crash without explanation. |
| Malformed API response | Log the raw response, show "Unexpected response from [endpoint] — see logs" | Crash on JSON parse. Show raw error to user. Swallow and continue with bad data. |
| Concurrent access conflict | Detect, warn, suggest resolution (e.g., "Another EDOG instance may be running") | Corrupt shared state. Overwrite without warning. |

**Sentinel's Gate 4 method:** For every external dependency (network, filesystem, process, API), Sentinel asks: *"What happens when this fails?"* If the answer is "it won't fail" or "I didn't think about that," Gate 4 is BLOCKED.

**Gate 4 produces:** Error handling verification for every failure mode in the test plan.

---

### Gate 5: EDGE CASES — Boundaries and Extremes

**Normal inputs are easy. Edge cases are where bugs live.**

**Empty States:**
```
□ No workspaces returned from API — helpful empty state, not blank area
□ No tables in lakehouse — clear message, not broken layout
□ No logs available — "No logs yet. Deploy to start streaming."
□ No token configured — guided setup, not cryptic error
□ No config file — create default, inform user
□ Empty search/filter result — "No matches for '[query]'" with suggestion
```

**Overflow / Scale:**
```
□ 10,000 log entries — virtual scroll, no DOM explosion, no jank
□ 500-character workspace/table names — truncation with tooltip, no layout break
□ 200+ workspaces in tree — lazy loading or pagination, instant filter
□ Deeply nested structures (10+ levels) — indentation stays readable
□ Rapid log ingestion (1000 entries/sec) — throttled rendering, no dropped data
□ Large config file (1000+ lines) — parsed without blocking UI
```

**Rapid / Concurrent Input:**
```
□ Fast typing in filter box — debounced, no stutter, final result correct
□ Double-click on action button — idempotent, no duplicate operations
□ Spam Ctrl+K open/close — no state corruption, no leaked listeners
□ Rapid tab switching — no partial renders, no stale data in wrong tab
□ Multiple keyboard shortcuts in quick succession — queued and executed in order
```

**Timing / Race Conditions:**
```
□ Token expires during API call — retry with fresh token or clear error
□ Deploy interrupted mid-progress — clean rollback, no partial state
□ File change during file read — handle gracefully, no partial data
□ WebSocket message arrives during view switch — buffered, not lost
□ Config written while being read — file locking or atomic write
```

**Gate 5 produces:** Edge case test results covering all categories above relevant to the change.

---

### Gate 6: REGRESSION + BUILD

**The automated safety net. Non-negotiable. Zero tolerance for failures.**

```bash
make lint   # MUST PASS — zero warnings, zero errors
make test   # MUST PASS — zero failures, zero skips without documented reason
make build  # MUST PASS — valid single-file HTML output
```

| Check | Requirement | Failure Response |
|-------|-------------|------------------|
| `make lint` | Ruff lint + format: zero diagnostics | Fix every warning. Do not suppress. Do not add `# noqa` without Sentinel's approval. |
| `make test` | pytest: zero failures | Fix the test or fix the code. Do not delete or skip the test. |
| `make build` | `build-html.py` produces valid output | Fix the build. If CSS/JS modules changed, verify they inline correctly. |
| Existing tests | No regressions — all previously passing tests still pass | If your change broke an existing test, your change is wrong until proven otherwise. |

**Gate 6 is automated but not optional.** Every agent must run these commands locally before requesting Sentinel's review. Sentinel will also run them independently. If results differ, Sentinel's run is authoritative.

**Gate 6 produces:** Clean lint, test, and build output.

---

### Gate 7: SENTINEL SIGN-OFF

**The final gate. Sentinel reviews everything and issues a verdict.**

```
SENTINEL SIGN-OFF
=================
Feature/Change: [description]
Agent: [who built it]
Date: [date]

VERDICT: APPROVED / BLOCKED

GATE RESULTS:
  Gate 0 (Pre-Flight):   PASS / FAIL — [notes]
  Gate 1 (Unit):         PASS / FAIL — [notes]
  Gate 2 (Integration):  PASS / FAIL — [notes]
  Gate 3 (Scenario):     PASS / FAIL — [notes]
  Gate 4 (Error):        PASS / FAIL — [notes]
  Gate 5 (Edge Cases):   PASS / FAIL — [notes]
  Gate 6 (Regression):   PASS / FAIL — [notes]

TESTS:
  New tests written: [count]
  Tests modified: [count]
  Total coverage delta: [+/- lines]

SCENARIOS VERIFIED:
  - [scenario 1]: PASS
  - [scenario 2]: PASS
  - [scenario N]: PASS / FAIL — [details]

EDGE CASES COVERED:
  - [edge case 1]: PASS
  - [edge case N]: PASS / FAIL — [details]

INTEGRATION VERIFIED:
  - [integration point 1]: PASS
  - [integration point N]: PASS / FAIL — [details]

RISK ASSESSMENT: Low / Medium / High
  [justification]

NOTES:
  [any findings, concerns, or recommendations]

BLOCKING ISSUES (if BLOCKED):
  1. [issue — what must be fixed]
  2. [issue — what must be fixed]
```

**APPROVED** means: all seven gates passed, Sentinel has personally verified the critical paths, and the change is cleared to commit.

**BLOCKED** means: one or more gates failed. The blocking issues are listed. The agent must fix them and re-submit through the failed gates. There is no partial approval. There is no "approved with conditions." Fix it or don't ship it.

---

## Sentinel's Authority

Sentinel is the QA Lead and Gatekeeper. This is not a ceremonial role.

**Sentinel CAN:**
- Block any commit for any quality reason
- Require additional tests beyond what the building agent wrote
- Require re-implementation if the approach is fundamentally fragile
- Override "it works on my machine" with reproducible evidence
- Demand a Pre-Flight Brief be rewritten if it's vague or incomplete
- Require cross-domain review (e.g., force Vex and Pixel to co-review a change that touches both backend and frontend)

**Sentinel CANNOT:**
- Be overruled by the building agent
- Be bypassed "just this once" or "for a quick fix"
- Be pressured to approve by schedule concerns

**There is no appeals process.** If Sentinel says BLOCKED, the agent fixes the issues. If the agent disagrees with Sentinel's assessment, they must provide concrete evidence (test results, reproduction steps, specification references) — not arguments, not opinions, not "it should work." Evidence or fix it.

---

## The Quality Rubric

### Scoring (0-5)

| Score | Level | Description |
|-------|-------|-------------|
| 0 | **Unacceptable** | Broken, insecure, violates constraints, or cannot pass Gate 6 |
| 1 | **Poor** | Functions but fragile — no tests, missing error handling, wrong color space, silent failures |
| 2 | **Below Bar** | Works with tests, but missing edge cases, keyboard support, or integration verification |
| 3 | **At Bar** | Works, fully tested (Gates 1-5), edge cases handled, keyboard accessible, follows style guide, Sentinel APPROVED |
| 4 | **Above Bar** | At Bar + polished UX + performance optimized + helpful error messages + well-documented |
| 5 | **Exceptional** | Above Bar + innovative solution + teaches other agents + users would highlight in a demo |

**Minimum acceptable score: 3 (At Bar)**

A score of 2 or below is BLOCKED. No discussion. A score of 3 means "this is correct, complete, and safe." Scores of 4 and 5 are earned through craft, not required for approval — but they are what we aspire to.

---

## Quality Checklist — Per Deliverable

Every deliverable is evaluated against this checklist. Sentinel uses it. Building agents should self-check against it before requesting review.

```
PRE-FLIGHT (Gate 0)
  □ Pre-Flight Brief submitted and approved
  □ Test Plan written by Sentinel before coding started
  □ Architecture impact reviewed by Sana (if cross-cutting)
  □ Agent can explain what they're building and what can go wrong

FUNCTIONALITY (Gates 1-3)
  □ Solves the stated problem completely — not partially, not approximately
  □ Every new/changed function has unit tests
  □ Every if/else branch is tested
  □ Every error path tested for CORRECT behavior (message, state, recovery)
  □ Integration points tested (IPC, WebSocket, config, file watchers)
  □ Full user journey tested start to finish
  □ State transitions verified (disconnected/connected/error/recovery)

ERROR HANDLING (Gate 4)
  □ Network timeout handled with clear message
  □ Invalid/expired token handled with suggested fix
  □ Process death handled with clean recovery
  □ Config corruption handled with fallback and warning
  □ WebSocket disconnect handled with reconnect
  □ Every external dependency has a failure handler
  □ No silent failures anywhere

EDGE CASES (Gate 5)
  □ Empty states handled (no data, no connection, no token)
  □ Overflow tested (10K entries, 500-char names, deep nesting)
  □ Rapid input tested (fast typing, double-click, shortcut spam)
  □ Timing/race conditions tested (token expiry, interrupted ops)

UI / UX (if applicable)
  □ Keyboard accessible — every action reachable without mouse
  □ OKLCH color system — no HSL, no hex in new code
  □ 4px spacing grid — var(--space-*) tokens, no hardcoded pixels
  □ Information-dense but readable
  □ No layout shift during loading or state transitions
  □ Consistent with existing views
  □ Empty states have helpful guidance, not blank areas

CODE QUALITY
  □ Follows STYLE_GUIDE.md for the language (Python/C#/JS/CSS)
  □ Functions are small, focused, single-responsibility
  □ Names are clear — no abbreviations without context
  □ No magic numbers or strings — use constants or config
  □ No dead code — remove it, don't comment it out
  □ Comments explain WHY, not WHAT

PERFORMANCE
  □ Meets render/latency targets (< 200ms render, < 50ms shortcut)
  □ No unnecessary DOM manipulation
  □ No memory leaks (especially in long-running sessions)
  □ Virtual scroll for large lists (1000+ items)
  □ Interceptors add < 1ms overhead

REGRESSION + BUILD (Gate 6)
  □ make lint — zero warnings
  □ make test — zero failures
  □ make build — valid single-file HTML
  □ No existing tests broken

SIGN-OFF (Gate 7)
  □ Sentinel's APPROVED verdict received
  □ All blocking issues resolved
  □ Commit message follows conventional commit format
  □ Co-authored-by trailer included
```

---

## Definition of "Done"

**"Done" is NOT:**
- "I wrote the code"
- "It compiles"
- "The build passes"
- "It works when I test the happy path once"
- "I'll add tests later"
- "It works on my machine"

**"Done" IS when ALL of the following are true:**

```
1. All 7 gates passed sequentially
2. Sentinel issued APPROVED verdict
3. make lint — zero warnings
4. make test — zero failures
5. make build — valid output
6. No existing tests broken
7. Every new/changed function has tests
8. Every error path has a handler with a helpful message
9. Every edge case from the test plan is covered
10. Keyboard accessible (UI changes)
11. OKLCH colors, 4px grid, style guide followed
12. Cross-domain review completed (if applicable)
13. Another agent could maintain this without asking questions
14. You would use this feature yourself without frustration
```

If any one of these is false, the work is not done. It does not matter how close it is. Close is not done.

---

## Speed vs. Quality

**Quality is non-negotiable. Speed is the variable.**

We spent 30% of our commits fixing bugs that should have been caught before merge. Every fix commit is a context switch. Every context switch is lost velocity. Every bug that ships is a bug that has to be found, diagnosed, fixed, tested, and merged — costing 5-10x more than catching it at the gate.

The 7-Gate Gauntlet is not slow. Shipping broken code and fixing it later is slow.

| Trade-off | Decision | Rationale |
|-----------|----------|-----------|
| Ship fast with bugs vs. ship later without bugs | Ship later. | 30% fix-commit rate proved "ship fast" doesn't work. |
| Skip tests to save time vs. write tests now | Write tests now. | "I'll add tests later" is a lie we've told 45 times. |
| Simple but slow vs. complex but fast | Complex but fast. | Performance IS a feature for developer tools. |
| Minimal error handling vs. comprehensive | Comprehensive. | Silent failures caused half our fix commits. |
| One agent reviews vs. cross-domain review | Cross-domain when applicable. | Integration bugs don't surface in single-domain review. |

---

## Unacceptable Shortcuts — Zero Tolerance

These are not guidelines. These are fireable offenses against the codebase.

| Shortcut | Why It's Unacceptable | What You Must Do Instead |
|----------|----------------------|--------------------------|
| Commit without Sentinel's APPROVED | Bypasses every quality guarantee | Get the verdict. No exceptions. |
| "I'll add tests later" | You won't. History proves it. 45 fix commits prove it. | Write tests in Gate 1. Before or during implementation. Not after. |
| Weaken test assertions to make tests pass | Hides the bug, doesn't fix it | Fix the code. If the test is wrong, prove it with the spec. |
| Add a framework (React, Vue, etc.) | Permanently breaks single-file constraint (ADR-002/003) | Write vanilla JS. Always. |
| Use RGB/HSL colors | Fragments the color system | Convert to OKLCH. Use design tokens. |
| Skip keyboard support | "Users can click" — our users don't want to | Add the shortcut. Register in Command Palette. |
| Hardcode pixel values | Breaks the 4px spacing system | Use `var(--space-*)` tokens. |
| Catch and swallow exceptions | Silent failures are the #1 source of fix commits | Handle with a helpful message, log, or propagate. Never swallow. |
| Ship without browser testing | "It looks right in my head" is not validation | Open Edge/Chrome. Test it. Screenshot it. |
| Skip Pre-Flight Brief | Leads to rework, missed integration points, unclear scope | Write the brief. Get it approved. Then build. |
| Merge with failing tests | "That test was already broken" — now it's your problem | Fix the test or fix the code. Zero failures. |
| Suppress linter warnings with `# noqa` | Hiding problems, not solving them | Fix the code. Sentinel-approved `# noqa` only for documented false positives. |

---

## The Developer Tool Test

Before claiming any feature is ready, apply this test:

> **The 2 AM Test:** Imagine you're a senior FLT engineer debugging a production incident at 2 AM. Your shift started 6 hours ago. You're tired. You need answers fast.
>
> Your tool:
> - Shows you what you need **without clicking through menus** (information density)
> - Responds **instantly** when you press a shortcut (performance)
> - **Doesn't crash or stall** when 10,000 logs are flooding in (reliability)
> - Doesn't make you **reach for the mouse** (keyboard-first)
> - When something goes wrong, **tells you what happened and what to do** (error handling)
> - **Doesn't lose your place** when a WebSocket reconnects (state preservation)
>
> A pretty tool that adds friction to debugging is a **bad tool**.
> A tool that silently fails during an incident is a **dangerous tool**.

**The 8-Hour Test:** Before shipping any UI feature:

> "Would I want to look at this for 8 hours?"
> - Is the contrast comfortable? (OKLCH helps here)
> - Is the information density right? (Not too sparse, not overwhelming)
> - Are the animations subtle? (No bouncing, no sliding — instant or 150ms max)
> - Does it respect my keyboard workflow?
> - When I switch away and come back, is my state preserved?

---

## Cross-Domain Review Requirements

One of the root causes of our fix-commit churn was changes that crossed domain boundaries without review from both sides.

| Change Touches | Required Reviewers |
|----------------|--------------------|
| Python only | Vex + Sentinel |
| C# only | Vex + Sentinel |
| JS only | Pixel + Sentinel |
| CSS only | Pixel + Sentinel |
| Python + C# (IPC) | Vex + Sana + Sentinel |
| JS + CSS (UI feature) | Pixel + Sentinel |
| JS + WebSocket + C# (connected mode) | Pixel + Vex + Sentinel |
| Config format changes | Vex + Pixel + Sana + Sentinel |
| Build system changes | All agents + Sentinel |
| Architecture / new data flows | Sana + affected domain agents + Sentinel |

**Rule:** If a change touches two or more domains, **both domain agents must review**. Sentinel enforces this. A single-domain review on a cross-domain change is automatically BLOCKED.

---

## The Decision Framework

```
Has Pre-Flight Brief been approved? ──NO──> Write it. Get approval.
  | YES
  v
Has Sentinel written the test plan? ──NO──> Wait. Sentinel writes the plan first.
  | YES
  v
Do all unit tests pass (Gate 1)? ──NO──> Write missing tests. Fix failures.
  | YES
  v
Do integration tests pass (Gate 2)? ──NO──> Fix the integration.
  | YES
  v
Do scenario tests pass (Gate 3)? ──NO──> Walk the user journey. Fix gaps.
  | YES
  v
Are all error paths handled (Gate 4)? ──NO──> Add error handlers. Every one.
  | YES
  v
Are edge cases covered (Gate 5)? ──NO──> Test the boundaries.
  | YES
  v
Does make lint/test/build pass (Gate 6)? ──NO──> Fix it. Zero tolerance.
  | YES
  v
Has Sentinel issued APPROVED (Gate 7)? ──NO──> Address blocking issues. Re-submit.
  | YES
  v
COMMIT.
```

There is no shortcut through this flowchart. There is no "but it's a small change." Small changes with untested edge cases caused 30% of our commits to be fixes. Every change, every time, all seven gates.

---

*"We don't have a speed problem. We have a rework problem. The 7-Gate Gauntlet doesn't slow us down — it stops us from doing the same work twice."*

— Sentinel, QA Lead, EDOG Studio
