# EDOG Playground — Development Workflow & Quality Enforcement Overhaul

**Date:** 2026-04-10
**Authors:** Full hivemind team
**Status:** DRAFT — CEO review required
**Triggered by:** Repeated shipping of broken code in F00/F01 sprint

---

## The Problem (Sana)

We have excellent governance docs. We have quality gates. We have a quality bar.
We shipped a page-killing JS syntax error anyway. Twice in one session.

**Root cause is not missing rules — it's missing enforcement.** The rules are
voluntary. An agent can commit without running a single gate. There's no
automated verification that the built output actually works. Sub-agents make
changes that are trusted on claim alone.

This overhaul makes quality gates **mandatory and automated** — not optional
and aspirational.

---

## The Strategy: Three Layers of Defense

### Layer 1: PRE-WRITE (Before touching code)
### Layer 2: PRE-COMMIT (Before `git commit`)
### Layer 3: POST-COMMIT (Before claiming "done")

Each layer catches different failure modes. All three are mandatory.

---

## Layer 1: PRE-WRITE — Scope Lock + Scenario Matrix

**Owner:** Sana (process) + every agent (execution)

### 1a. Scope Lock

Before writing any code, the agent must state:
```
SCOPE:
  CHANGING: [list of files being modified]
  NOT CHANGING: [list of files explicitly out of scope]
  ADDING: [new files being created]
```

Any edit outside the declared scope requires re-stating scope and getting
approval. This prevents the "I was polishing CSS and accidentally changed
the color scheme" class of bugs.

**Enforcement:** Agents must include scope in their first message when starting
a task. The orchestrating agent verifies edits match the declared scope before
committing.

### 1b. Scenario Matrix

Before implementing, the agent must enumerate scenarios:

```
SCENARIOS:
  HAPPY: [user picks cert → auth → dashboard]
  EMPTY: [no certs found → manual entry screen]
  ERROR: [auth fails → error with retry]
  EDGE:  [token expires mid-session → silent re-auth]
  FIRST_RUN: [no session file → full onboarding]
  RETURNING: [session file exists, token expired → silent re-auth]
```

Each scenario must be tested after implementation. This prevents the
"works on happy path, crashes on first run" class of bugs.

**Enforcement:** Scenario matrix is required in the plan. Each scenario is
checked off during verification (Layer 3).

---

## Layer 2: PRE-COMMIT — Automated Gates (Mandatory)

**Owner:** Ines (test design) + Ren (automation)

### 2a. Fix quality_gates.py

**Current bug:** References `src/edog-logs/` but actual path is `src/frontend/`.
Gates literally can't find files to check.

**Fix:** Update `FRONTEND_SRC` to correct path. Add to Makefile so it runs
automatically.

### 2b. Add JS Syntax Validation Gate

New gate: `check_js_syntax()` — runs Node.js `new Function()` on the built
HTML's script content. Catches:
- Duplicate variable declarations
- Syntax errors
- Unclosed brackets/strings

```python
def check_js_syntax() -> Tuple[bool, str]:
    """Parse built HTML and verify JS is syntactically valid."""
    # Extract <script> content from built HTML
    # Run: node -e "new Function(code)"
    # Any parse error = gate fails
```

**This single gate would have caught the bug that killed us today.**

### 2c. Add Build Integrity Gate

New gate: `check_build_integrity()` — verifies:
- All CSS modules in build-html.py exist on disk
- All JS modules in build-html.py exist on disk
- Built HTML size is within 10% of last known size (catches accidental deletions)
- No `MODULE NOT FOUND` warnings in build output

### 2d. Mandatory Pre-Commit Hook

Create `scripts/pre-commit.py` that runs ALL gates:

```python
#!/usr/bin/env python3
"""Pre-commit quality gate runner. Exit 1 = block commit."""

def main():
    # 1. Build (python scripts/build-html.py)
    # 2. Run quality_gates.py
    # 3. Run JS syntax check (node)
    # 4. Run pytest
    # 5. Report pass/fail
    # Exit 1 if ANY gate fails → commit is blocked
```

**Enforcement:** Every agent session must run `python scripts/pre-commit.py`
before committing. The orchestrating agent verifies the output shows all gates
passed.

### 2e. Makefile Integration

```makefile
lint:     ruff check . && python hivemind/agents/quality_gates.py
test:     python -m pytest tests/ -q --ignore=tests/test_revert.py
build:    python scripts/build-html.py
jscheck:  node -e "<JS syntax validation script>"
verify:   build lint test jscheck
precommit: verify
```

`make verify` = the single command that must pass before any commit.

---

## Layer 3: POST-COMMIT — Scenario Verification

**Owner:** Ines (test design) + Kael (UX verification)

### 3a. Smoke Test Script

Create `scripts/smoke-test.py` that:
1. Starts dev-server.py on a random port
2. Fetches the HTML page
3. Verifies `/api/edog/health` returns valid JSON
4. Verifies `/api/flt/config` returns valid JSON
5. Verifies no JS errors in the built HTML (node parse)
6. Shuts down the server

This runs in ~5 seconds and catches "server starts but nothing works" bugs.

### 3b. Scenario Checklist

After implementation, the agent runs through each scenario from the
pre-write matrix:

```
VERIFICATION:
  [x] HAPPY: Opened browser, picked cert, authenticated, saw workspaces
  [x] EMPTY: Removed .edog-session.json, refreshed → saw onboarding
  [x] ERROR: Used wrong cert → saw error with retry button
  [x] EDGE:  Deleted .edog-bearer-cache → silent re-auth worked
  [x] FIRST_RUN: Fresh install (no cache files) → full onboarding
```

Each scenario includes HOW it was verified (not just "tested").

### 3c. Sub-Agent Verification Protocol

When a sub-agent completes work:
1. Parent agent runs `make verify` (not just `make build`)
2. Parent agent checks the diff for scope violations
3. Parent agent runs the JS syntax check on the built output
4. Only then: commit

**Never trust a sub-agent's "all done" claim without running verification.**

---

## Layer 4: DEVELOPMENT ENVIRONMENT HARDENING

**Owner:** Ren (build) + Elena (server)

### 4a. Cache-Control Headers (DONE)
Already added `no-cache` to HTML serving. Never serve stale HTML during dev.

### 4b. Startup Health Check
Dev server prints a diagnostic on startup:
```
EDOG Dev Server
  Bearer: EXPIRED (7h ago) ← red warning
  Session: Admin1CBA@... (last auth 8h ago)
  Action: Will attempt silent re-auth on first page load
```

### 4c. Console Error Overlay
Add a JS error handler that shows a visible red banner on the page when
any unhandled error occurs:
```javascript
window.onerror = (msg, src, line) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="background:red;color:white;padding:8px;font-family:monospace">
     JS ERROR: ${msg} at line ${line}</div>`);
};
```
This makes silent JS death impossible — you always see the error.

---

## Implementation Priority

| Priority | What | Effort | Impact |
|----------|------|--------|--------|
| **P0** | Fix quality_gates.py paths | 5 min | Gates actually work |
| **P0** | Add JS syntax gate | 15 min | Catches the #1 bug class |
| **P0** | Add window.onerror overlay | 5 min | No more silent JS death |
| **P1** | Create pre-commit.py runner | 30 min | Single command verification |
| **P1** | Update Makefile with `verify` | 10 min | Standard workflow |
| **P1** | Smoke test script | 30 min | Automated server + page check |
| **P2** | Sub-agent verification protocol | Process only | Trust but verify |
| **P2** | Scope lock + scenario matrix | Process only | Prevent scope creep |
| **P2** | Startup health diagnostics | 20 min | Obvious token status |

---

## Team Sign-Off

**Sana Reeves (Tech Lead):**
The scope lock and scenario matrix are the highest-leverage changes. Every bug
this session was a scenario we didn't think about. The gates are necessary but
insufficient — we need to think before we code, not just check after.

**Ines Ferreira (QA):**
The quality_gates.py path bug is embarrassing. I'll fix it immediately. The JS
syntax gate should have existed from day one — we build a single-file HTML app
and never verify the JS parses. The smoke test gives us a 5-second confidence
check that should run after every build.

**Ren Aoki (Build/DevOps):**
The Makefile `verify` target is the key. One command. Everything checked. If it
passes, commit. If it fails, fix. No ambiguity. I'll also add build output size
tracking so we notice if the output suddenly drops (file missing) or balloons
(accidental duplication).

**Kael Andersen (UX):**
The window.onerror overlay is critical for dev experience. Right now a JS crash
looks identical to "page loaded fine but no data" — both show an empty
workspace panel. That's the worst possible failure mode: silent and confusing.
A red banner makes the error impossible to miss.

**Elena Voronova (Python):**
The pre-commit runner needs to be fast (<10 seconds) or agents will skip it.
Build is ~2s, tests are ~7s, JS parse is <1s, gates are <1s. Total ~10s.
Acceptable. I'll make sure the smoke test doesn't add latency to the
commit flow — it's a post-commit verification, not a blocker.

---

## Process Change Summary

### Before (broken):
```
Write code → Build → "Looks good" → Commit → User finds bug
```

### After (enforced):
```
State scope + scenarios → Write code → make verify (gates+build+test+jscheck)
→ All pass? → Review diff for scope → Commit → Verify scenarios → Done
```

---

*"The standard you walk past is the standard you accept. We're done walking past."*
