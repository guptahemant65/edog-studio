# EDOG-STUDIO ENGINEERING STANDARDS

> **Status:** 🟢 ACTIVE  
> **Applies To:** All edog-studio agents  
> **Last Updated:** 2026-04-12

---

## ⚠️ DOCUMENT AUTHORITY — READ FIRST

**This document is Tier 3.** The Design Bible (Tier 0) overrides these standards on visual decisions. See **`hivemind/AUTHORITY.md`** for the full hierarchy.

**Key overrides from the Design Bible:**
- **Colors:** The Bible uses hex (`#6d5cff`), `rgba()`, and `color-mix()`. When implementing Bible components, use Bible tokens — not OKLCH.
- **Transitions:** The Bible uses `160ms cubic-bezier(0.4,0,0.2,1)`. Use this, not "150ms ease-out."
- **Radii:** The Bible defines `--r4`, `--r6`, `--r10`, `--r16`, `--r100`. These are not restricted to 4px multiples.
- **Typography:** The Bible uses `'Inter', system-ui, sans-serif`. Use this font stack.

**When NOT overridden:** These standards still fully govern Python code, C# code, Git conventions, testing requirements, security, build process, and any visual decision the Bible does not explicitly address.

---

## Purpose

This document defines the engineering standards for edog-studio — a multi-language project (Python, C#, vanilla JS/CSS) that compiles to a single-file developer cockpit. These standards exist because our users are senior engineers who will judge every rough edge, and because our unusual constraints (single-file HTML, no frameworks, three languages) demand discipline.

---

## 1. Core Principles

### The Four Pillars

1. **Fix the root cause** — If a test fails, fix the code, not the test.
2. **Prove it works** — Untested code is broken code you haven't found yet.
3. **Respect the constraints** — Single-file HTML, no frameworks, OKLCH colors, 4px grid. These aren't suggestions.
4. **Ship what you'd use** — You are building a tool for engineers like you. Dogfood it.

### The Engineering Oath

```
I will not ship code I know to be broken.
I will not modify tests to accept broken behavior.
I will not introduce framework dependencies in the frontend.
I will not bypass the single-file constraint.
I will not add arbitrary spacing values — 4px grid or justify why not.
I will not use RGB/HSL when OKLCH is available.
```

---

## 2. Tech Stack

### Languages & Their Roles

| Language | Files | Purpose | Build |
|----------|-------|---------|-------|
| **Python** | `edog.py`, `edog-logs.py`, `build-html.py`, `test_revert.py` | CLI, token management, API proxy, build system | `python edog.py` |
| **C#** | `src/Edog*.cs` | DevMode interceptors injected into FLT service | `dotnet build` |
| **JavaScript** | `src/edog-logs/js/*.js` | Frontend modules (class-based, vanilla DOM) | `python build-html.py` → single `.html` |
| **CSS** | `src/edog-logs/css/*.css` | Styling (OKLCH, custom properties, 4px grid) | Inlined by `build-html.py` |
| **HTML** | `src/edog-logs/index.html` | Shell template | Assembled by `build-html.py` |

### Build System

The build is two independent pipelines:

```
Frontend:
  src/edog-logs/index.html
  + src/edog-logs/css/*.css     →  python build-html.py  →  src/edog-logs.html
  + src/edog-logs/js/*.js

Backend (C#):
  src/Edog*.cs                  →  dotnet build           →  DLL injected into FLT
```

**Rules:**
- `build-html.py` must be idempotent — running it twice produces identical output.
- CSS modules are concatenated in dependency order (variables first).
- JS modules are concatenated in dependency order (utilities first, app last).
- The output `src/edog-logs.html` is a complete, self-contained document. Zero external requests.

### Dependency Policy

| Layer | Allowed Dependencies | Prohibited |
|-------|---------------------|------------|
| **Python** | Standard library, Playwright (for browser auth) | pip packages for core logic |
| **C#** | .NET BCL, ASP.NET Core (already in FLT) | NuGet packages not already in FLT |
| **JavaScript** | None. Vanilla only. | npm, CDN scripts, any framework |
| **CSS** | None. Vanilla only. | Tailwind, Bootstrap, preprocessors |

---

## 3. Frontend Standards

### The Single-File Constraint

The compiled HTML file (`src/edog-logs.html`) must:
- Be a single file. Zero external resources (no `<link>`, no `<script src>`).
- Work when served by the C# `EdogLogServer` at `localhost:5555`.
- Work when opened directly as `file://` for development.
- Contain all CSS inlined in `<style>` blocks.
- Contain all JS inlined in `<script>` blocks.

### CSS Architecture

```css
/* All colors use OKLCH */
--color-bg-primary: oklch(0.17 0.01 260);     /* NOT: #1a1a2e */
--color-text-primary: oklch(0.92 0.01 260);   /* NOT: rgb(230, 230, 240) */
--color-accent: oklch(0.72 0.15 250);         /* NOT: hsl(220, 80%, 60%) */

/* All spacing derives from 4px base */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-6: 24px;
--space-8: 32px;

/* Custom properties for theming — not hardcoded values */
.panel { padding: var(--space-4); }            /* NOT: padding: 16px */
.panel { background: var(--color-bg-primary); } /* NOT: background: #1a1a2e */
```

**CSS Rules:**
- No `!important` unless overriding third-party styles (which shouldn't exist).
- No `px` values outside custom property definitions — use `var(--space-*)`.
- No `z-index` values without a comment explaining the stacking context.
- Media queries: mobile-first is irrelevant (this is a desktop dev tool). Design for 1440px+.

### JavaScript Architecture

```javascript
// Module pattern: class-based, no frameworks
class LogViewer {
    constructor(containerEl) {
        this.container = containerEl;
        this.logs = [];
        this._bindEvents();
    }

    _bindEvents() {
        // Private method — underscore prefix
    }

    addLog(entry) {
        // Public method — no prefix
    }
}

// Initialization in a single entry point
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
```

**JS Rules:**
- No `var` — use `const` by default, `let` when reassignment is needed.
- No `document.write`.
- No inline event handlers (`onclick="..."`). Use `addEventListener`.
- No `eval`, `Function()`, or dynamic script injection.
- All DOM queries cached in constructor or `init()`.
- Keyboard shortcuts must not conflict with browser defaults or IDE shortcuts.

---

## 4. Python Standards

### Code Organization

```python
# Standard library first
import os
import sys
import json

# Third-party (Playwright only)
from playwright.async_api import async_playwright

# Local imports
from edog_utils import parse_token
```

### Requirements

- **Type hints** on all function signatures (parameters and return types).
- **Docstrings** on all public functions (Google style).
- **PEP 8** compliance. Line length: 120 (not 79 — we have wide monitors).
- **f-strings** for string formatting (not `%` or `.format()`).
- **pathlib.Path** for file operations (not `os.path.join`).

### Error Handling

```python
# Specific exceptions, actionable messages
try:
    token = await fetch_mwc_token(workspace_id)
except PlaywrightTimeoutError:
    print(f"❌ Browser timed out fetching token for workspace {workspace_id}")
    print(f"   Try: Close other browser windows and retry")
    sys.exit(1)
except PermissionError as e:
    print(f"❌ Cannot write to config: {e}")
    print(f"   Try: Run as administrator or check file permissions")
    sys.exit(1)

# Never: bare except, swallowed exceptions, generic messages
```

---

## 5. C# Standards

### DevMode Interceptor Pattern

All C# files follow the interceptor pattern — they hook into the FLT service pipeline:

```csharp
// Standard file header
#nullable disable
// EdogLogInterceptor.cs — Captures FLT log output for edog-studio

namespace FabricLiveTable.DevMode
{
    /// <summary>
    /// Intercepts log entries from the FLT service and forwards
    /// them to the EDOG log server for real-time display.
    /// </summary>
    public class EdogLogInterceptor
    {
        // Implementation
    }
}
```

**C# Rules:**
- `#nullable disable` pragma at top of DevMode files (FLT codebase convention).
- Namespace: `FabricLiveTable.DevMode` for all edog interceptor code.
- XML doc comments on all public types and methods.
- No LINQ in hot paths (log interception runs on every log entry).
- Minimal allocations — these interceptors run in the FLT process.
- StyleCop-clean: proper `using` ordering, no unused imports.

---

## 6. Testing Requirements

### By Language

| Layer | Framework | What to Test | Coverage Target |
|-------|-----------|-------------|-----------------|
| **Python** | pytest | Token logic, config management, build script, API proxy | 80%+ on core logic |
| **C#** | MSTest | Interceptor behavior, log parsing, telemetry capture | 80%+ on public methods |
| **JavaScript** | Manual browser | UI interactions, keyboard shortcuts, responsive layout | All 6 views, all shortcuts |

### Python Testing

```python
# Test file naming: test_<module>.py
# Test function naming: test_<what>_<condition>_<expected>

def test_parse_token_valid_jwt_returns_claims():
    """Valid JWT should return decoded claims dict."""
    token = create_test_jwt(exp=future_time())
    result = parse_token(token)
    assert result["exp"] > time.time()
    assert "aud" in result

def test_parse_token_expired_jwt_raises_token_error():
    """Expired JWT should raise TokenExpiredError."""
    token = create_test_jwt(exp=past_time())
    with pytest.raises(TokenExpiredError, match="Token expired"):
        parse_token(token)

def test_build_html_produces_single_file():
    """build-html.py output must be a single self-contained HTML file."""
    build_html()
    content = Path("src/edog-logs.html").read_text()
    assert "<link" not in content, "No external stylesheets allowed"
    assert 'src="' not in content or 'src="data:' in content, "No external scripts"
```

### Browser Testing Checklist

Since the frontend has no test framework, manual validation is required:

```
□ All 6 sidebar views render correctly
□ Keyboard shortcuts 1-6 switch views
□ Ctrl+K opens command palette
□ Log entries stream in real-time
□ Token countdown updates every second
□ Color-coded log levels (error=red, warn=amber, info=blue)
□ Filter controls work (level, source, text search)
□ Detail panel opens on log entry click
□ No console errors in browser DevTools
□ Works in Edge and Chrome
```

---

## 7. Prohibited Practices

### Zero Tolerance

| Practice | Why | Do Instead |
|----------|-----|------------|
| Weaken test assertions to make tests pass | Hides bugs | Fix the code |
| Add npm/CDN dependencies to frontend | Breaks single-file constraint | Write vanilla JS |
| Use RGB/HSL colors in CSS | Violates OKLCH standard | Convert to OKLCH |
| Hardcode spacing values | Breaks 4px grid | Use `var(--space-*)` |
| Catch and swallow exceptions | Hides failures | Log, handle, or propagate |
| `SELECT *` in production queries | Fragile to schema changes | List columns explicitly |
| Commit secrets or tokens | Security breach | Use environment variables |
| Skip tests for "simple" changes | "Simple" changes break things | Test proportionally |
| Use `document.write` or `eval` | Security and maintainability | Use DOM API |
| Add `!important` to CSS | Specificity nightmare | Fix the cascade |

### The Shortcut Test

Before taking a shortcut, ask: *"Would I be comfortable if a senior FLT engineer saw this while debugging a production issue at 2 AM?"*

If no, don't do it.

---

## 8. Documentation Standards

### When to Document

| Change | Documentation Required |
|--------|----------------------|
| New API endpoint | Endpoint docs + request/response examples |
| New keyboard shortcut | Update shortcuts table in design spec |
| New CSS custom property | Comment in `variables.css` with usage intent |
| New C# interceptor | XML doc comments + architecture note |
| Build process change | Update this doc + README |
| Config format change | Update `edog-config.json` schema docs |

### Code Comments

```python
# Good: Explains WHY
# Retry with backoff because Fabric API rate-limits to 10 req/sec
for attempt in range(max_retries):

# Bad: Explains WHAT (the code already says this)
# Loop through items
for item in items:

# Good: Documents non-obvious constraint
# Must be single-file — EdogLogServer.cs reads this path directly
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "src", "edog-logs.html")
```

---

## 9. Performance Standards

### Frontend

| Metric | Target | Why |
|--------|--------|-----|
| Initial render | < 200ms | Tool must feel instant |
| Log entry append | < 5ms per entry | Must handle 1000+ entries/sec |
| View switch | < 50ms | Keyboard shortcut response must feel immediate |
| Memory (1h session) | < 200MB | Runs alongside VS and FLT service |

### Python Backend

| Metric | Target | Why |
|--------|--------|-----|
| Token refresh | < 10s | User waits for this |
| API proxy latency | < 50ms overhead | Transparent to calling code |
| Build time (`build-html.py`) | < 2s | Fast iteration loop |

### C# Interceptors

| Metric | Target | Why |
|--------|--------|-----|
| Log capture overhead | < 1ms per entry | Cannot slow down FLT service |
| Memory overhead | < 50MB | Runs inside FLT process |

---

## 10. Security Requirements

- **No secrets in code.** Tokens, passwords, connection strings go in environment variables or `edog-config.json` (gitignored).
- **No token logging.** Bearer and MWC tokens must never appear in log output.
- **Token cache file** (`.edog-token-cache`) must be gitignored and readable only by the current user.
- **Playwright sessions** must not persist cookies beyond the current EDOG session.
- **API proxy** must validate that requests come from `localhost` only.

---

## 11. Deployment & Integration

### The Integration Gate

A module is not "done" until:

1. **Build gate** — `python build-html.py` succeeds (frontend) or `dotnet build` succeeds (C#).
2. **Wire gate** — The module is actually called in the runtime path. Dead code is not shipped code.
3. **Smoke gate** — Launch edog, open the browser, verify the feature works end-to-end.

### Why This Matters

From the hivemind post-mortem: modules that pass unit tests but aren't wired into the runtime are worse than no module at all — they give false confidence.

---

*"The standard you walk past is the standard you accept."*

— edog-studio engineering
