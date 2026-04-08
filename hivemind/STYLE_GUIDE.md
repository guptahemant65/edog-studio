# EDOG-STUDIO STYLE GUIDE

> **Status:** 🟢 ACTIVE  
> **Applies To:** All edog-studio agents  
> **Last Updated:** 2026-04-08

---

## Philosophy

edog-studio spans three languages (Python, C#, JavaScript) and two styling systems (CSS, Git). This guide ensures consistency across all of them. When in doubt, match the existing code around you.

**The Golden Rule:**
> Code is read more often than it is written. Optimize for the reader.

---

## Python

### Baseline

- **PEP 8** as the foundation.
- **Line length:** 120 characters (we have wide monitors; 79 is for the 1990s).
- **Formatter:** Not enforced by tooling — follow PEP 8 manually.
- **Python version:** 3.8+ (must work on developer machines without bleeding-edge installs).

### Imports

```python
# 1. Standard library
import os
import sys
import json
import time
import asyncio
from pathlib import Path
from datetime import datetime, timedelta

# 2. Third-party (minimize — only Playwright for auth)
from playwright.async_api import async_playwright

# 3. Local
from edog_config import load_config
```

One blank line between each group. Alphabetical within groups.

### Naming

```python
# Functions and variables: snake_case
def fetch_mwc_token(workspace_id: str) -> str:
    token_cache_path = Path(".edog-token-cache")
    max_retry_count = 3

# Classes: PascalCase
class TokenManager:
    pass

# Constants: SCREAMING_SNAKE_CASE
DEFAULT_PORT = 5555
TOKEN_REFRESH_INTERVAL_SECONDS = 2700  # 45 minutes

# Private: leading underscore
def _parse_jwt_payload(token: str) -> dict:
    pass
```

### Type Hints

**Required** on all function signatures — parameters and return types.

```python
def apply_patches(
    repo_path: Path,
    patches: list[dict[str, str]],
    dry_run: bool = False,
) -> tuple[int, list[str]]:
    """Apply EDOG patches to FLT codebase.

    Args:
        repo_path: Root of the FLT repository.
        patches: List of patch definitions (file, pattern, replacement).
        dry_run: If True, report what would change without modifying files.

    Returns:
        Tuple of (patches_applied_count, list_of_modified_files).

    Raises:
        FileNotFoundError: If repo_path doesn't exist.
        PatchConflictError: If a patch target has already been modified.
    """
    ...
```

### Docstrings

Google style. Required on all public functions. Optional on private helpers if the name is self-explanatory.

```python
def fetch_mwc_token(workspace_id: str, artifact_id: str) -> str:
    """Fetch MWC token for a workspace/artifact pair via browser automation.

    Uses Playwright to perform cert-based authentication against the Fabric
    token endpoint. Caches the result in .edog-token-cache.

    Args:
        workspace_id: GUID of the Fabric workspace.
        artifact_id: GUID of the target lakehouse.

    Returns:
        MWC bearer token string.

    Raises:
        AuthenticationError: If browser login fails or times out.
        NetworkError: If the token endpoint is unreachable.
    """
    ...
```

### Error Handling

```python
# Specific exceptions with actionable messages
try:
    config = json.loads(config_path.read_text())
except FileNotFoundError:
    print(f"❌ Config not found: {config_path}")
    print(f"   Run: edog.cmd --setup")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"❌ Invalid JSON in {config_path}: {e}")
    sys.exit(1)

# Never: bare except, Exception-catching without re-raise, swallowed errors
```

### f-Strings

Always f-strings. Never `%` formatting or `.format()`.

```python
# Yes
print(f"Token expires in {minutes_remaining} minutes")
log_line = f"[{timestamp}] {level}: {message}"

# No
print("Token expires in %d minutes" % minutes_remaining)
print("Token expires in {} minutes".format(minutes_remaining))
```

### Path Handling

Always `pathlib.Path`. Never `os.path.join`.

```python
# Yes
config_path = Path(script_dir) / "edog-config.json"
output_file = Path("src") / "edog-logs.html"

# No
config_path = os.path.join(script_dir, "edog-config.json")
```

---

## C#

### DevMode File Conventions

```csharp
#nullable disable
// EdogLogInterceptor.cs — Captures and forwards FLT log entries to edog-studio
//
// This file is part of the EDOG DevMode interceptor layer.
// It is compiled into the FLT service when running in dev mode.

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace FabricLiveTable.DevMode
{
    /// <summary>
    /// Intercepts ILogger calls from the FLT service and forwards
    /// structured log entries to the EDOG log server via HTTP POST.
    /// </summary>
    public class EdogLogInterceptor : ILogInterceptor
    {
        private readonly HttpClient _httpClient;
        private readonly string _edogEndpoint;

        public EdogLogInterceptor(string edogEndpoint = "http://localhost:5555")
        {
            _httpClient = new HttpClient();
            _edogEndpoint = edogEndpoint;
        }

        /// <summary>
        /// Captures a log entry and sends it to EDOG for display.
        /// </summary>
        /// <param name="level">Log severity level.</param>
        /// <param name="message">Log message text.</param>
        /// <param name="properties">Structured log properties.</param>
        public async Task CaptureAsync(
            LogLevel level,
            string message,
            IDictionary<string, object> properties)
        {
            // Implementation
        }
    }
}
```

### Naming

```csharp
// Classes, methods, properties: PascalCase
public class EdogApiProxy
{
    public string BaseUrl { get; set; }
    public async Task<string> ForwardRequestAsync(HttpRequest request) { }
}

// Parameters, local variables: camelCase
public void Configure(string endpointUrl, int maxRetries)
{
    var requestCount = 0;
}

// Private fields: _camelCase
private readonly HttpClient _httpClient;
private int _retryCount;

// Constants: PascalCase (C# convention, not SCREAMING_CASE)
public const int DefaultPort = 5555;
public const string LogEndpointPath = "/api/edog/logs";
```

### Key Rules

- **`#nullable disable`** at the top of every DevMode `.cs` file (FLT codebase convention).
- **Namespace:** `FabricLiveTable.DevMode` for all edog interceptor code.
- **XML doc comments** (`///`) on all public types, methods, and properties.
- **`using` order:** System → Microsoft → third-party → project. Alphabetical within groups.
- **No LINQ in hot paths** — log interception runs on every log entry. Allocations matter.
- **Dispose patterns:** Implement `IDisposable` for any class that holds `HttpClient`, streams, or timers.
- **`async`/`await`:** Use `ConfigureAwait(false)` in library-style code (interceptors are library code).
- **String interpolation** preferred over `string.Format` or concatenation.

### Error Handling

```csharp
// Specific catch blocks, structured logging
try
{
    await _httpClient.PostAsync(_edogEndpoint, content);
}
catch (HttpRequestException ex)
{
    // Log but don't throw — interceptor failures must not break FLT
    System.Diagnostics.Debug.WriteLine(
        $"EDOG: Failed to forward log: {ex.Message}");
}
catch (TaskCanceledException)
{
    // Timeout — expected during service shutdown, ignore
}

// Never: catch (Exception), empty catch blocks, throw ex (lose stack trace)
```

---

## JavaScript

### Module Pattern

All JS is organized as class-based modules. No frameworks. No module bundlers.

```javascript
/**
 * LogViewer — Renders and manages the log entry list.
 *
 * Responsibilities:
 *   - Append log entries to the DOM
 *   - Filter by level, source, and text search
 *   - Handle virtual scrolling for performance
 */
class LogViewer {
    constructor(containerEl, options = {}) {
        this._container = containerEl;
        this._entries = [];
        this._maxEntries = options.maxEntries || 10000;
        this._filterLevel = 'all';

        this._bindEvents();
    }

    // --- Public API ---

    addEntry(entry) {
        this._entries.push(entry);
        this._renderEntry(entry);
        this._enforceMaxEntries();
    }

    setFilter(level) {
        this._filterLevel = level;
        this._rerender();
    }

    // --- Private Methods ---

    _bindEvents() {
        this._container.addEventListener('click', (e) => {
            const row = e.target.closest('[data-log-id]');
            if (row) this._onEntryClick(row);
        });
    }

    _renderEntry(entry) {
        const el = document.createElement('div');
        el.className = `log-entry log-level-${entry.level}`;
        el.dataset.logId = entry.id;
        el.textContent = `${entry.timestamp} [${entry.level}] ${entry.message}`;
        this._container.appendChild(el);
    }

    _onEntryClick(row) {
        // Open detail panel
    }

    _enforceMaxEntries() {
        while (this._entries.length > this._maxEntries) {
            this._entries.shift();
            this._container.removeChild(this._container.firstChild);
        }
    }

    _rerender() {
        this._container.innerHTML = '';
        const filtered = this._entries.filter(
            e => this._filterLevel === 'all' || e.level === this._filterLevel
        );
        filtered.forEach(e => this._renderEntry(e));
    }
}
```

### Naming

```javascript
// Classes: PascalCase
class TokenDisplay { }

// Methods, variables, parameters: camelCase
function formatTimestamp(isoString) { }
const retryCount = 3;

// Constants: SCREAMING_SNAKE_CASE
const MAX_LOG_ENTRIES = 10000;
const TOKEN_WARNING_THRESHOLD_MS = 600000; // 10 minutes

// Private members: _camelCase (underscore prefix)
this._container = el;
this._isInitialized = false;

// DOM IDs and classes: kebab-case
// <div id="log-viewer" class="panel-content">

// Data attributes: kebab-case
// <div data-log-id="123" data-log-level="error">

// Event handlers: _on + Event name
_onClick(event) { }
_onKeyDown(event) { }
_onTokenExpiry() { }
```

### Key Rules

- **`const` by default.** `let` only when reassignment is needed. Never `var`.
- **No `document.write`** or `eval`.
- **No inline event handlers** (`onclick="..."`). Always `addEventListener`.
- **Template literals** for string building:
  ```javascript
  // Yes
  const html = `<div class="log-entry">${entry.message}</div>`;
  // No
  const html = '<div class="log-entry">' + entry.message + '</div>';
  ```
- **DOM queries cached** — query once in constructor/init, reference thereafter.
- **Event delegation** — attach listeners to containers, not individual elements.
- **No global variables.** Everything lives inside a class or an IIFE.
- **`===` always.** Never `==` (except explicit `null` checks: `value == null`).

---

## CSS

### OKLCH Color System

**All colors in OKLCH. No exceptions.** No `#hex`, no `rgb()`, no `hsl()`.

```css
/* Define in variables.css */
:root {
    /* Backgrounds */
    --color-bg-base: oklch(0.15 0.01 260);
    --color-bg-surface: oklch(0.20 0.01 260);
    --color-bg-elevated: oklch(0.25 0.015 260);

    /* Text */
    --color-text-primary: oklch(0.92 0.01 260);
    --color-text-secondary: oklch(0.70 0.01 260);
    --color-text-muted: oklch(0.50 0.01 260);

    /* Semantic */
    --color-error: oklch(0.65 0.20 25);
    --color-warning: oklch(0.75 0.15 70);
    --color-success: oklch(0.70 0.15 145);
    --color-info: oklch(0.70 0.12 250);
    --color-accent: oklch(0.72 0.15 250);

    /* Interactive */
    --color-focus-ring: oklch(0.72 0.15 250 / 0.5);
    --color-hover: oklch(0.30 0.02 260);
}

/* Usage — always reference variables */
.log-level-error { color: var(--color-error); }
.log-level-warn  { color: var(--color-warning); }
.log-level-info  { color: var(--color-info); }
```

### 4px Spacing Grid

**All spacing values derive from a 4px base.** No arbitrary pixel values.

```css
:root {
    --space-0: 0;
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-8: 32px;
    --space-10: 40px;
    --space-12: 48px;
    --space-16: 64px;
}

/* Usage */
.panel {
    padding: var(--space-4);       /* 16px — not "padding: 16px" */
    gap: var(--space-2);           /* 8px */
    border-radius: var(--space-1); /* 4px */
}

.sidebar {
    width: var(--space-12);        /* 48px — icon-only sidebar */
}

.topbar {
    height: var(--space-8);        /* 32px */
}
```

### CSS Custom Properties over Hardcoded Values

```css
/* Yes — themeable, consistent, maintainable */
.panel {
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border);
    padding: var(--space-3);
    font-size: var(--font-size-sm);
}

/* No — hardcoded, fragile, inconsistent */
.panel {
    background: #1e1e2e;
    border: 1px solid #333;
    padding: 12px;
    font-size: 13px;
}
```

### Typography

```css
:root {
    --font-mono: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;

    --font-size-xs: 11px;
    --font-size-sm: 13px;
    --font-size-md: 14px;
    --font-size-lg: 16px;
    --font-size-xl: 20px;

    --font-weight-normal: 400;
    --font-weight-medium: 500;
    --font-weight-bold: 600;

    --line-height-tight: 1.3;
    --line-height-normal: 1.5;
}

/* Monospace for data: logs, code, IDs, timestamps */
.log-entry { font-family: var(--font-mono); font-size: var(--font-size-sm); }

/* Sans-serif for UI: labels, buttons, navigation */
.sidebar-label { font-family: var(--font-sans); font-size: var(--font-size-xs); }
```

### Key CSS Rules

- **No `!important`** — fix the cascade instead.
- **No `z-index`** without a comment explaining the stacking context.
- **No `px` values** outside `:root` custom property definitions — use `var(--space-*)` and `var(--font-size-*)`.
- **No animations over 150ms** — this is a dev tool, not a marketing site. Use `150ms ease-out` for transitions, or instant.
- **No `display: none` for toggling** — use a `.hidden` utility class or data attributes.
- **Logical grouping** in CSS files: variables → layout → components → utilities.

---

## Git

### Commit Messages

**Format:** `<type>(<scope>): <subject>`

```
feat(logs): add smart log grouping by correlation ID
fix(token): handle expired token during auto-refresh
docs(readme): update quick start for Phase 2 flow
style(css): convert remaining HSL colors to OKLCH
refactor(build): parallelize CSS and JS concatenation
test(revert): add edge case for partial patch revert
chore(ci): update build script for new module ordering
```

**Types:**

| Type | Use For |
|------|---------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `style` | Formatting, whitespace (no logic change) |
| `refactor` | Code restructuring (no behavior change) |
| `test` | Adding or updating tests |
| `chore` | Build, CI, tooling, dependencies |
| `perf` | Performance improvement |

**Scopes** (use the most specific that applies):

| Scope | Covers |
|-------|--------|
| `logs` | Log viewer, log interceptor |
| `token` | Token management, auth |
| `build` | build-html.py, build process |
| `workspace` | Workspace explorer |
| `dag` | DAG view |
| `spark` | Spark inspector |
| `api` | API playground, proxy |
| `css` | Styling |
| `topbar` | Top status bar |
| `sidebar` | Sidebar navigation |
| `interceptor` | C# interceptor layer |

### Commit Body (when needed)

```
feat(workspace): add lakehouse table schema inspector

Shows column names, types, and nullable flags when a Delta table is
selected in the workspace explorer. Data fetched via Fabric REST API
using the bearer token from Phase 1 auth.

Resolves: lakehouse browsing must show table structure
```

### Co-authored-by Trailer

**Required on all commits** involving AI agent collaboration:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

### Branch Names

```
feature/log-grouping-by-correlation
fix/token-refresh-race-condition
docs/onboarding-guide-update
refactor/css-oklch-migration
```

Format: `<type>/<short-description>` — kebab-case, no ticket numbers (we don't have a tracker yet).

---

## File Organization

### Frontend Source

```
src/edog-logs/
├── index.html           # Shell template (header, structure)
├── css/
│   ├── variables.css    # Custom properties (colors, spacing, typography)
│   ├── layout.css       # Grid, flexbox, panel structure
│   ├── filters.css      # Filter bar, dropdowns, search
│   ├── logs.css         # Log entry styling
│   ├── telemetry.css    # Telemetry view
│   ├── detail.css       # Detail/inspector panel
│   ├── summary.css      # Summary view
│   └── smart.css        # Smart grouping styles
└── js/
    ├── utils.js         # Shared utilities (formatting, DOM helpers)
    ├── log-viewer.js    # LogViewer class
    ├── filter-bar.js    # FilterBar class
    ├── detail-panel.js  # DetailPanel class
    └── app.js           # App class (entry point, wiring)
```

### Naming Conventions

```
Python files:     snake_case.py        (edog_config.py, build_html.py)
C# files:         PascalCase.cs        (EdogLogInterceptor.cs)
JS files:         kebab-case.js        (log-viewer.js, filter-bar.js)
CSS files:        kebab-case.css       (variables.css, layout.css)
Config files:     kebab-case.json      (edog-config.json)
Scripts:          kebab-case.cmd/.ps1  (edog-setup.cmd, install.ps1)
```

---

## Exceptions

When you need to deviate from this guide:

1. **Comment why** in the code.
2. **Get review** from another agent.
3. **Consider updating the guide** if the exception will recur.

```python
# Exception: Using os.path instead of pathlib here because subprocess.run
# on Python 3.8 doesn't accept Path objects for cwd on Windows
import os
cwd = os.path.abspath(repo_dir)  # noqa: pathlib
```

---

*"Consistency is the foundation of mastery."*

— edog-studio style guide
