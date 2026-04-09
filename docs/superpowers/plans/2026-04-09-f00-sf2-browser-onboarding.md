# F00-SF2: Browser Onboarding Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On first launch, auto-detect the user's CBA certificate, authenticate via Silent CBA, and transition to the Workspace Explorer dashboard — all within 10 seconds, zero manual steps for 90% of users.

**Architecture:** dev-server.py gets 3 new API endpoints (`/api/edog/certs`, `/api/edog/auth`, `/api/edog/health`). A new `onboarding.js` module renders a full-screen overlay with cert detection → auth progress → auto-dismiss. `main.js` gates the app behind auth state. CSS in a new `onboarding.css` with the split-layout aesthetic (left form + right amber gradient).

**Tech Stack:** Python (dev-server.py endpoints), Vanilla JS (class-based module), CSS (OKLCH, 4px grid), existing token-helper.exe (Silent CBA)

**Assigned:** Zara Okonkwo (JS), Mika Tanaka (CSS), Elena Voronova (Python APIs)

**Depends on:** token-helper.exe already built and working (done), dev-server.py already running (done), workspace-explorer.js already functional (done)

**Reference spec:** `docs/specs/features/F00-onboarding-spec.md` — Sections 2, 4, 7

---

## File Map

| File | Action | Owner | Responsibility |
|------|--------|-------|----------------|
| `scripts/dev-server.py` | Modify | Elena | Add `/api/edog/certs`, `/api/edog/auth`, `/api/edog/health` endpoints |
| `src/frontend/js/onboarding.js` | Create | Zara | Full-screen onboarding overlay: cert list, auth progress, error states |
| `src/frontend/css/onboarding.css` | Create | Mika | Split layout, amber gradient, progress stepper, cert selector styles |
| `src/frontend/js/main.js` | Modify | Zara | Gate app behind auth — show onboarding if no cached bearer |
| `src/frontend/js/api-client.js` | Modify | Zara | Add `getAuthState()`, `authenticate(username)`, `getCerts()` methods |
| `scripts/token-helper/Program.cs` | Modify | Elena | Switch target to net8.0, add `--find-certs` mode for cert listing |
| `scripts/token-helper/token-helper.csproj` | Modify | Elena | Change TargetFramework to net8.0 |
| `tests/test_dev_server_auth.py` | Create | Elena | Tests for /api/edog/* endpoints |

---

### Task 1: Python API — `/api/edog/certs` endpoint (Elena)

**Files:**
- Modify: `scripts/dev-server.py`
- Modify: `scripts/token-helper/Program.cs`
- Modify: `scripts/token-helper/token-helper.csproj`
- Create: `tests/test_dev_server_auth.py`

This endpoint lists all CBA certificates from the Windows cert store. It's called once on page load and the result is cached.

- [ ] **Step 1: Switch token-helper to net8.0**

In `scripts/token-helper/token-helper.csproj`, change:
```xml
<TargetFramework>net8.0</TargetFramework>
```
Remove the old net472 build output. Rebuild:
```bash
cd scripts/token-helper && dotnet build
```
Verify token-helper still works:
```bash
dotnet run -- "6921EC59777B2667C9B0BD4B82FA09F1077AB973" "Admin1CBA@FabricFMLV08PPE.ccsctp.net"
```
Expected: bearer token on stdout.

- [ ] **Step 2: Add `--list-certs` mode to token-helper**

Add a second mode to `Program.cs`. When first arg is `--list-certs`, enumerate all CBA certs and output JSON to stdout:

```csharp
if (args.Length > 0 && args[0] == "--list-certs")
{
    using var store = new X509Store(StoreLocation.CurrentUser);
    store.Open(OpenFlags.ReadOnly);
    var certs = new List<object>();
    foreach (var cert in store.Certificates)
    {
        if (cert.Subject.Contains("CBA"))
        {
            certs.Add(new
            {
                thumbprint = cert.Thumbprint,
                subject = cert.Subject,
                cn = cert.GetNameInfo(X509NameType.SimpleName, false),
                notAfter = cert.NotAfter.ToString("o"),
                notBefore = cert.NotBefore.ToString("o"),
                issuer = cert.Issuer,
            });
        }
    }
    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(certs));
    return;
}
```

Rebuild and test:
```bash
dotnet run -- --list-certs
```
Expected: JSON array of cert objects on stdout.

- [ ] **Step 3: Add `/api/edog/certs` to dev-server.py**

In `dev-server.py`, add a handler that calls token-helper with `--list-certs` and returns the JSON:

```python
def _serve_certs(self):
    """List CBA certs from Windows cert store via token-helper."""
    helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
    if not helper.exists():
        self._json_response(500, {"error": "token-helper not built"})
        return
    try:
        result = subprocess.run(
            [str(helper), "--list-certs"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            self._json_response(200, json.loads(result.stdout))
        else:
            self._json_response(500, {"error": result.stderr.strip()[:200]})
    except subprocess.TimeoutExpired:
        self._json_response(500, {"error": "cert scan timed out"})
```

Add a helper `_json_response` method:
```python
def _json_response(self, code, data):
    body = json.dumps(data).encode()
    self.send_response(code)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", len(body))
    self.end_headers()
    self.wfile.write(body)
```

Wire it into `do_GET`:
```python
elif self.path == "/api/edog/certs":
    self._serve_certs()
```

- [ ] **Step 4: Write test for /api/edog/certs**

Create `tests/test_dev_server_auth.py`:
```python
"""Tests for EDOG auth API endpoints in dev-server.py."""
import json
import subprocess
from pathlib import Path

def test_token_helper_list_certs():
    """token-helper --list-certs returns valid JSON array."""
    helper = Path(__file__).parent.parent / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
    if not helper.exists():
        import pytest
        pytest.skip("token-helper not built")
    result = subprocess.run([str(helper), "--list-certs"], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0
    certs = json.loads(result.stdout)
    assert isinstance(certs, list)
    # At least one CBA cert should exist on dev machine
    assert len(certs) > 0
    assert "thumbprint" in certs[0]
    assert "cn" in certs[0]
    assert "notAfter" in certs[0]
```

Run: `pytest tests/test_dev_server_auth.py -v`

- [ ] **Step 5: Commit**

```bash
git add scripts/token-helper/ scripts/dev-server.py tests/test_dev_server_auth.py
git commit -m "feat(onboarding): /api/edog/certs endpoint + token-helper --list-certs

Elena: Add cert listing mode to token-helper (net8.0). New endpoint
in dev-server.py returns CBA certs as JSON for the onboarding UI.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Python API — `/api/edog/auth` endpoint (Elena)

**Files:**
- Modify: `scripts/dev-server.py`
- Modify: `tests/test_dev_server_auth.py`

This endpoint accepts a username, runs Silent CBA, returns the bearer token + expiry.

- [ ] **Step 1: Add `/api/edog/auth` handler**

```python
def _serve_auth(self):
    """Authenticate via Silent CBA. POST body: {"username": "..."}"""
    content_len = int(self.headers.get("Content-Length", 0))
    body = json.loads(self.rfile.read(content_len)) if content_len else {}
    username = body.get("username", "")
    if not username:
        self._json_response(400, {"error": "username required"})
        return

    # Find cert thumbprint
    cert_cn = username.replace("@", ".")
    tp = _find_thumbprint(cert_cn)
    if not tp:
        self._json_response(404, {"error": f"No certificate found for {cert_cn}",
                                   "help": "Upload a .pfx or request access via PPE wiki"})
        return

    # Run Silent CBA
    helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
    try:
        result = subprocess.run(
            [str(helper), tp, username],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            token = result.stdout.strip()
            # Parse expiry from JWT
            import base64
            payload = token.split(".")[1]
            payload += "=" * (4 - len(payload) % 4)
            claims = json.loads(base64.b64decode(payload).decode("utf-8", "replace"))
            expiry = claims.get("exp", time.time() + 3600)
            upn = claims.get("upn", username)
            # Cache bearer
            _write_cache(BEARER_CACHE, token, float(expiry))
            self._json_response(200, {
                "token": token,
                "username": upn,
                "expiresIn": int(expiry - time.time()),
            })
        else:
            err = result.stderr.strip()
            self._json_response(401, {"error": "Authentication failed", "detail": err[:300]})
    except subprocess.TimeoutExpired:
        self._json_response(504, {"error": "Authentication timed out (30s)"})
```

Add helper functions at module level:
```python
def _find_thumbprint(cert_cn: str) -> str | None:
    """Find cert thumbprint via token-helper --list-certs."""
    helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
    if not helper.exists():
        return None
    try:
        result = subprocess.run([str(helper), "--list-certs"], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            return None
        certs = json.loads(result.stdout)
        for c in certs:
            if cert_cn.lower() in c.get("cn", "").lower() or cert_cn.lower() in c.get("subject", "").lower():
                return c["thumbprint"]
    except Exception:
        pass
    return None

def _write_cache(path: Path, token: str, expiry: float):
    """Write base64-encoded timestamp|token cache file."""
    data = f"{expiry}|{token}"
    path.write_text(base64.b64encode(data.encode()).decode(), encoding="utf-8")
```

Wire into `do_POST`:
```python
elif self.path == "/api/edog/auth":
    self._serve_auth()
```

- [ ] **Step 2: Add `/api/edog/health` endpoint**

```python
def _serve_health(self):
    """Pre-flight check: Python, dotnet, cert, token status."""
    bearer, bearer_exp = _read_cache(BEARER_CACHE)
    helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
    self._json_response(200, {
        "tokenHelperBuilt": helper.exists(),
        "hasBearerToken": bearer is not None,
        "bearerExpiresIn": int(bearer_exp - time.time()) if bearer_exp else 0,
        "port": 5555,
    })
```

Wire into `do_GET`:
```python
elif self.path == "/api/edog/health":
    self._serve_health()
```

- [ ] **Step 3: Add `import subprocess, base64` to dev-server.py if missing**

Check the imports at the top of dev-server.py and add `subprocess` if not already there.

- [ ] **Step 4: Write test for /api/edog/auth**

Add to `tests/test_dev_server_auth.py`:
```python
def test_token_helper_silent_cba():
    """token-helper acquires a real bearer token via Silent CBA."""
    helper = Path(__file__).parent.parent / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
    if not helper.exists():
        import pytest
        pytest.skip("token-helper not built")
    # Use known test cert
    result = subprocess.run(
        [str(helper), "6921EC59777B2667C9B0BD4B82FA09F1077AB973", "Admin1CBA@FabricFMLV08PPE.ccsctp.net"],
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0
    token = result.stdout.strip()
    assert token.startswith("eyJ")
    assert len(token) > 100
```

Run: `pytest tests/test_dev_server_auth.py -v`

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-server.py tests/test_dev_server_auth.py
git commit -m "feat(onboarding): /api/edog/auth + /api/edog/health endpoints

Elena: Silent CBA auth endpoint returns bearer + expiry + username.
Health endpoint reports token-helper status and cached bearer state.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: CSS — Onboarding split layout + auth screen (Mika)

**Files:**
- Create: `src/frontend/css/onboarding.css`

The full-screen overlay with split layout: left panel (form/content), right panel (amber gradient blob). Progress stepper with animated checkmarks. Cert selector radio list.

- [ ] **Step 1: Create `onboarding.css`**

```css
/* ============================================================================
   ONBOARDING — Full-screen auth overlay
   Split layout: left form panel + right ambient gradient
   Mika Tanaka — OKLCH palette, 4px grid
   ============================================================================ */

/* --- Overlay --- */
.onboarding-overlay {
    position: fixed;
    inset: 0;
    z-index: 9000;
    display: grid;
    grid-template-columns: 1fr 0.6fr;
    background: var(--bg-primary);
    opacity: 1;
    transition: opacity 0.4s ease;
}

.onboarding-overlay.fade-out {
    opacity: 0;
    pointer-events: none;
}

/* --- Left panel: form content --- */
.onboarding-left {
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 64px 80px;
    max-width: 640px;
}

.onboarding-hero {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--text-tertiary);
    margin-bottom: 8px;
}

.onboarding-title {
    font-size: 36px;
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: -0.5px;
    color: var(--text-primary);
    margin-bottom: 24px;
}

.onboarding-subtitle {
    font-size: 14px;
    line-height: 1.6;
    color: var(--text-secondary);
    margin-bottom: 40px;
}

/* --- Right panel: gradient blob --- */
.onboarding-right {
    position: relative;
    overflow: hidden;
    background: oklch(0.25 0.02 60);
}

.onboarding-right::before {
    content: '';
    position: absolute;
    width: 140%;
    height: 140%;
    top: -20%;
    left: -20%;
    background: radial-gradient(
        ellipse at 50% 50%,
        oklch(0.65 0.18 55 / 0.7) 0%,
        oklch(0.55 0.15 40 / 0.4) 35%,
        oklch(0.30 0.05 30 / 0.1) 70%,
        transparent 100%
    );
    animation: gradient-pulse 6s ease-in-out infinite alternate;
}

@keyframes gradient-pulse {
    0% { transform: scale(1) translate(0, 0); }
    100% { transform: scale(1.05) translate(2%, -2%); }
}

/* --- Progress stepper --- */
.auth-steps {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.auth-step {
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 12px;
    align-items: start;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.3s ease, transform 0.3s ease;
}

.auth-step.visible {
    opacity: 1;
    transform: translateY(0);
}

.auth-step-icon {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
}

.auth-step-icon.pending { color: var(--text-tertiary); }
.auth-step-icon.spinning { animation: spin 1s linear infinite; color: var(--accent-primary); }
.auth-step-icon.done { color: oklch(0.72 0.19 145); }
.auth-step-icon.error { color: oklch(0.65 0.22 25); }

@keyframes spin {
    to { transform: rotate(360deg); }
}

.auth-step-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
}

.auth-step-detail {
    font-size: 12px;
    color: var(--text-tertiary);
    margin-top: 2px;
}

/* --- Cert selector --- */
.cert-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 32px;
}

.cert-item {
    display: grid;
    grid-template-columns: 20px 1fr;
    gap: 12px;
    padding: 12px 16px;
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
}

.cert-item:hover {
    border-color: var(--accent-primary);
    background: var(--bg-hover);
}

.cert-item.selected {
    border-color: var(--accent-primary);
    background: oklch(0.65 0.18 55 / 0.08);
}

.cert-item-radio {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-secondary);
    border-radius: 50%;
    margin-top: 2px;
    position: relative;
}

.cert-item.selected .cert-item-radio {
    border-color: var(--accent-primary);
}

.cert-item.selected .cert-item-radio::after {
    content: '';
    position: absolute;
    inset: 3px;
    background: var(--accent-primary);
    border-radius: 50%;
}

.cert-item-cn {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
}

.cert-item-expiry {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 2px;
}

/* --- CTA button --- */
.onboarding-cta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 32px;
    background: var(--text-primary);
    color: var(--bg-primary);
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    cursor: pointer;
    transition: opacity 0.15s ease;
}

.onboarding-cta:hover { opacity: 0.85; }
.onboarding-cta:disabled { opacity: 0.4; cursor: not-allowed; }

/* --- Manual tenant input --- */
.manual-tenant-link {
    font-size: 12px;
    color: var(--text-tertiary);
    cursor: pointer;
    margin-top: 16px;
    text-decoration: underline;
    text-underline-offset: 2px;
}

.manual-tenant-input {
    width: 100%;
    padding: 10px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font-mono);
    margin-top: 12px;
    margin-bottom: 16px;
}

.manual-tenant-input::placeholder { color: var(--text-tertiary); }
.manual-tenant-input:focus { outline: none; border-color: var(--accent-primary); }

/* --- Error state --- */
.auth-error {
    padding: 12px 16px;
    background: oklch(0.65 0.22 25 / 0.08);
    border: 1px solid oklch(0.65 0.22 25 / 0.2);
    border-radius: 8px;
    margin-top: 16px;
}

.auth-error-title {
    font-size: 13px;
    font-weight: 600;
    color: oklch(0.65 0.22 25);
}

.auth-error-detail {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 4px;
}

.auth-error-help a {
    font-size: 12px;
    color: var(--accent-primary);
    text-decoration: underline;
    text-underline-offset: 2px;
}

/* --- Reduced motion --- */
@media (prefers-reduced-motion: reduce) {
    .onboarding-right::before { animation: none; }
    .auth-step-icon.spinning { animation: none; }
    .auth-step { transition: none; }
    .onboarding-overlay { transition: none; }
}
```

- [ ] **Step 2: Verify CSS variables exist in `variables.css`**

Check `src/frontend/css/variables.css` for the required custom properties: `--bg-primary`, `--bg-secondary`, `--bg-hover`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--border-primary`, `--border-secondary`, `--accent-primary`, `--font-mono`. If any are missing, add them following OKLCH convention.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/css/onboarding.css src/frontend/css/variables.css
git commit -m "style(onboarding): split-layout auth screen with amber gradient

Mika: Full-screen overlay, cert selector radio list, animated progress
stepper, error states, manual tenant input. OKLCH palette, 4px grid.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: JS — Onboarding module (Zara)

**Files:**
- Create: `src/frontend/js/onboarding.js`

The core onboarding logic: detect auth state, show overlay, handle cert selection, run auth, dismiss on success.

- [ ] **Step 1: Create `onboarding.js` with OnboardingScreen class**

```javascript
/**
 * OnboardingScreen — Full-screen auth overlay for first-time and expired-token scenarios.
 *
 * Flow: detect auth state → show cert picker (or auto-select) → Silent CBA → dismiss.
 * Re-renders on tenant switch. Auto-dismisses when bearer token is valid.
 *
 * Zara Okonkwo — vanilla JS, class-based module.
 */
class OnboardingScreen {
    constructor() {
        this._overlay = null;
        this._state = 'loading';  // loading | certs | auth | error | done
        this._certs = [];
        this._selectedCert = null;
        this._username = null;
        this._onComplete = null;
    }

    /**
     * Check if onboarding is needed. Returns true if no valid cached bearer token.
     * @returns {Promise<boolean>}
     */
    async isRequired() {
        try {
            const resp = await fetch('/api/edog/health');
            if (!resp.ok) return true;
            const health = await resp.json();
            return !health.hasBearerToken || health.bearerExpiresIn < 300;
        } catch {
            return true;
        }
    }

    /**
     * Show the onboarding overlay and run the auth flow.
     * @param {Function} onComplete — called with {token, username} on success.
     * @returns {Promise<void>}
     */
    async show(onComplete) {
        this._onComplete = onComplete;
        this._createOverlay();
        document.body.appendChild(this._overlay);

        // Fetch certs
        this._setState('loading');
        try {
            const resp = await fetch('/api/edog/certs');
            if (!resp.ok) throw new Error('Failed to scan certificates');
            this._certs = await resp.json();
        } catch (err) {
            this._certs = [];
        }

        if (this._certs.length === 0) {
            // No certs — show manual entry
            this._setState('certs');
            this._renderNoCerts();
        } else if (this._certs.length === 1) {
            // Single cert — auto-authenticate
            this._selectedCert = this._certs[0];
            this._username = this._deriveUsername(this._selectedCert.cn);
            await this._runAuth();
        } else {
            // Multiple certs — show picker
            this._setState('certs');
            this._renderCertPicker();
        }
    }

    /** Dismiss the overlay with a fade-out animation. */
    dismiss() {
        if (!this._overlay) return;
        this._overlay.classList.add('fade-out');
        setTimeout(() => {
            this._overlay.remove();
            this._overlay = null;
        }, 400);
    }

    // --- Private methods ---

    _createOverlay() {
        const el = document.createElement('div');
        el.className = 'onboarding-overlay';
        el.innerHTML = `
            <div class="onboarding-left">
                <div class="onboarding-hero">EDOG PLAYGROUND</div>
                <div class="onboarding-title" id="onb-title">VERIFYING<br>IDENTITY.</div>
                <div class="onboarding-subtitle" id="onb-subtitle">
                    Browse workspaces, manage feature flags, inspect runtime — all from localhost.
                </div>
                <div id="onb-content"></div>
            </div>
            <div class="onboarding-right"></div>
        `;
        this._overlay = el;
    }

    _setState(state) {
        this._state = state;
    }

    _getContent() { return this._overlay.querySelector('#onb-content'); }
    _getTitle() { return this._overlay.querySelector('#onb-title'); }
    _getSubtitle() { return this._overlay.querySelector('#onb-subtitle'); }

    _renderCertPicker() {
        this._getTitle().innerHTML = 'SELECT<br>CERTIFICATE.';
        this._getSubtitle().textContent = 'Multiple certificates detected. Choose one to authenticate.';

        // Sort by expiry descending (newest first)
        const sorted = [...this._certs].sort((a, b) =>
            new Date(b.notAfter) - new Date(a.notAfter)
        );
        this._selectedCert = sorted[0];

        const content = this._getContent();
        content.innerHTML = `
            <div class="cert-list" id="onb-cert-list"></div>
            <button class="onboarding-cta" id="onb-continue">CONTINUE &#8594;</button>
            <div class="manual-tenant-link" id="onb-manual-link">Connect to a different tenant</div>
        `;

        const list = content.querySelector('#onb-cert-list');
        sorted.forEach((cert, i) => {
            const expiry = new Date(cert.notAfter);
            const item = document.createElement('div');
            item.className = 'cert-item' + (i === 0 ? ' selected' : '');
            item.innerHTML = `
                <div class="cert-item-radio"></div>
                <div>
                    <div class="cert-item-cn">${cert.cn}</div>
                    <div class="cert-item-expiry">Valid until ${expiry.toLocaleDateString()}</div>
                </div>
            `;
            item.addEventListener('click', () => {
                list.querySelectorAll('.cert-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                this._selectedCert = cert;
            });
            list.appendChild(item);
        });

        content.querySelector('#onb-continue').addEventListener('click', () => {
            this._username = this._deriveUsername(this._selectedCert.cn);
            this._runAuth();
        });

        content.querySelector('#onb-manual-link').addEventListener('click', () => {
            this._renderManualEntry();
        });
    }

    _renderNoCerts() {
        this._getTitle().innerHTML = 'NO CERTIFICATE<br>FOUND.';
        this._getSubtitle().textContent = 'Enter your username to authenticate, or upload a certificate.';
        this._renderManualEntry();
    }

    _renderManualEntry() {
        const content = this._getContent();
        content.innerHTML = `
            <input class="manual-tenant-input" id="onb-username"
                   placeholder="Admin1CBA@FabricFMLV08PPE.ccsctp.net" autocomplete="off">
            <button class="onboarding-cta" id="onb-connect">CONNECT &#8594;</button>
            <div style="margin-top: 16px; font-size: 12px; color: var(--text-tertiary)">
                Don't have a certificate?
                <a href="https://dev.azure.com/powerbi/Trident/_wiki/wikis/Trident.wiki/80942/PPE-Ephemeral-Tenants-(ES-Maintained-Rotated)"
                   target="_blank" style="color: var(--accent-primary)">Request access</a>
            </div>
        `;

        const input = content.querySelector('#onb-username');
        const btn = content.querySelector('#onb-connect');

        const doConnect = () => {
            const val = input.value.trim();
            if (!val || !val.includes('@')) return;
            this._username = val;
            this._selectedCert = null;
            this._runAuth();
        };

        btn.addEventListener('click', doConnect);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });
        input.focus();
    }

    async _runAuth() {
        this._setState('auth');
        this._getTitle().innerHTML = 'AUTHENTICATING';
        this._getSubtitle().textContent = 'Verifying identity...';

        const content = this._getContent();
        content.innerHTML = `<div class="auth-steps" id="onb-steps"></div>`;
        const steps = content.querySelector('#onb-steps');

        // Step 1: Certificate
        const certCn = this._selectedCert
            ? this._selectedCert.cn
            : this._username.replace('@', '.');
        const certExpiry = this._selectedCert
            ? new Date(this._selectedCert.notAfter).toLocaleDateString()
            : '';
        this._addStep(steps, 'done', 'Certificate found',
            `${certCn}${certExpiry ? ' — valid until ' + certExpiry : ''}`);

        // Step 2: Authenticate
        const authStep = this._addStep(steps, 'spinning', 'Acquiring bearer token', '');

        try {
            const resp = await fetch('/api/edog/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: this._username }),
            });
            const data = await resp.json();

            if (!resp.ok) {
                this._updateStep(authStep, 'error', 'Authentication failed', data.error || 'Unknown error');
                this._showError(data.error, data.detail, data.help);
                return;
            }

            const expiresMin = Math.round(data.expiresIn / 60);
            this._updateStep(authStep, 'done', `Signed in as ${data.username}`,
                `Token expires in ${expiresMin} minutes`);

            // Step 3: Load workspaces
            const wsStep = this._addStep(steps, 'spinning', 'Loading workspaces', '');
            try {
                const wsResp = await fetch('/api/fabric/workspaces');
                if (wsResp.ok) {
                    const wsData = await wsResp.json();
                    const count = (wsData.value || []).length;
                    this._updateStep(wsStep, 'done', `${count} workspaces loaded`, '');
                } else {
                    this._updateStep(wsStep, 'error', 'Could not load workspaces', '');
                }
            } catch {
                this._updateStep(wsStep, 'error', 'Network error loading workspaces', '');
            }

            // Success — dismiss after brief pause
            this._setState('done');
            setTimeout(() => {
                this.dismiss();
                if (this._onComplete) {
                    this._onComplete({ token: data.token, username: data.username });
                }
            }, 800);

        } catch (err) {
            this._updateStep(authStep, 'error', 'Authentication failed', err.message);
            this._showError('Network error', err.message);
        }
    }

    _addStep(container, state, label, detail) {
        const icons = { pending: '&#9675;', spinning: '&#9676;', done: '&#10003;', error: '&#10007;' };
        const el = document.createElement('div');
        el.className = 'auth-step';
        el.innerHTML = `
            <div class="auth-step-icon ${state}">${icons[state]}</div>
            <div>
                <div class="auth-step-label">${label}</div>
                ${detail ? `<div class="auth-step-detail">${detail}</div>` : ''}
            </div>
        `;
        container.appendChild(el);
        // Trigger animation
        requestAnimationFrame(() => el.classList.add('visible'));
        return el;
    }

    _updateStep(el, state, label, detail) {
        const icons = { pending: '&#9675;', spinning: '&#9676;', done: '&#10003;', error: '&#10007;' };
        el.querySelector('.auth-step-icon').className = `auth-step-icon ${state}`;
        el.querySelector('.auth-step-icon').innerHTML = icons[state];
        el.querySelector('.auth-step-label').textContent = label;
        const detailEl = el.querySelector('.auth-step-detail');
        if (detailEl) detailEl.textContent = detail;
        else if (detail) {
            const d = document.createElement('div');
            d.className = 'auth-step-detail';
            d.textContent = detail;
            el.querySelector('.auth-step-label').after(d);
        }
    }

    _showError(title, detail, help) {
        const content = this._getContent();
        const errDiv = document.createElement('div');
        errDiv.className = 'auth-error';
        errDiv.innerHTML = `
            <div class="auth-error-title">${title}</div>
            ${detail ? `<div class="auth-error-detail">${detail}</div>` : ''}
            <div style="margin-top: 8px; display: flex; gap: 8px;">
                <button class="onboarding-cta" id="onb-retry" style="padding: 8px 20px; font-size: 11px;">RETRY</button>
            </div>
            <div class="auth-error-help" style="margin-top: 8px;">
                <a href="https://dev.azure.com/powerbi/Trident/_wiki/wikis/Trident.wiki/80942/PPE-Ephemeral-Tenants-(ES-Maintained-Rotated)"
                   target="_blank">Don't have a certificate?</a>
            </div>
        `;
        content.appendChild(errDiv);
        errDiv.querySelector('#onb-retry').addEventListener('click', () => {
            errDiv.remove();
            this._runAuth();
        });
    }

    _deriveUsername(cn) {
        // CN: Admin1CBA.FabricFMLV08PPE.ccsctp.net → Admin1CBA@FabricFMLV08PPE.ccsctp.net
        const parts = cn.split('.');
        if (parts.length >= 2) {
            return parts[0] + '@' + parts.slice(1).join('.');
        }
        return cn;
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/js/onboarding.js
git commit -m "feat(onboarding): OnboardingScreen JS module

Zara: Full-screen auth overlay with cert detection, auto-select,
manual tenant entry, progress stepper, error handling with retry.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: JS — Wire onboarding into main.js + api-client.js (Zara)

**Files:**
- Modify: `src/frontend/js/main.js`
- Modify: `src/frontend/js/api-client.js`

Gate the app behind auth state. On load: check health → if no token, show onboarding → on success, init Workspace Explorer.

- [ ] **Step 1: Add auth methods to FabricApiClient**

In `src/frontend/js/api-client.js`, add to the class:

```javascript
/** Check if we have a valid bearer token. */
async getAuthState() {
    try {
        const resp = await fetch('/api/edog/health');
        if (!resp.ok) return { authenticated: false };
        const data = await resp.json();
        return {
            authenticated: data.hasBearerToken && data.bearerExpiresIn > 300,
            expiresIn: data.bearerExpiresIn,
        };
    } catch {
        return { authenticated: false };
    }
}
```

- [ ] **Step 2: Modify main.js initialization**

Find the existing `DOMContentLoaded` or init logic in `main.js`. Wrap the existing app initialization behind an auth check:

```javascript
// At the top of the DOMContentLoaded handler or IIFE:
async function initApp() {
    const apiClient = new FabricApiClient();

    // Auth gate: check if we have a valid bearer token
    const authState = await apiClient.getAuthState();

    if (!authState.authenticated) {
        // Show onboarding
        const onboarding = new OnboardingScreen();
        await onboarding.show(async (result) => {
            // Auth complete — initialize the app
            await apiClient.init();
            startWorkspaceExplorer(apiClient);
        });
    } else {
        // Already authenticated — go straight to dashboard
        await apiClient.init();
        startWorkspaceExplorer(apiClient);
    }
}

function startWorkspaceExplorer(apiClient) {
    // Existing workspace explorer initialization code
    // Move the current init logic here
}
```

Adapt this to match the exact existing initialization pattern in main.js. The key change: wrap existing init in `startWorkspaceExplorer()` and call it after auth completes.

- [ ] **Step 3: Build and test**

```bash
python scripts/build-html.py
```

Open `localhost:5555` — should show onboarding overlay if no cached bearer, or go straight to workspace explorer if bearer is cached. Clear `.edog-bearer-cache` to test the onboarding flow.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/main.js src/frontend/js/api-client.js
git commit -m "feat(onboarding): wire auth gate into app initialization

Zara: main.js checks auth state on load. If no valid bearer token,
shows OnboardingScreen overlay. On success, initializes workspace
explorer. Returning users skip straight to dashboard.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Build + End-to-End Verification (Ren + all)

**Files:**
- Modify: `src/frontend/index.html` (add onboarding.css + onboarding.js to build)

- [ ] **Step 1: Add onboarding files to index.html**

Add `<link>` for `onboarding.css` and `<script>` for `onboarding.js` in the correct order in `src/frontend/index.html`. `onboarding.js` must load before `main.js`.

- [ ] **Step 2: Build single-file HTML**

```bash
python scripts/build-html.py
```

Verify no errors.

- [ ] **Step 3: Run all tests**

```bash
pytest tests/ -v
```

All existing tests + new auth tests must pass.

- [ ] **Step 4: End-to-end test — fresh auth**

```bash
# Clear all caches
del .edog-bearer-cache
del .edog-thumbprint-cache

# Start server
python scripts/dev-server.py
```

Open `localhost:5555` in browser:
1. Should show onboarding overlay with split layout
2. Should auto-detect CBA cert(s)
3. If single cert: auto-authenticate (4-6 seconds)
4. Should transition to Workspace Explorer with real workspaces

- [ ] **Step 5: End-to-end test — cached auth (returning user)**

Close browser tab, reopen `localhost:5555`:
1. Should NOT show onboarding overlay
2. Should go straight to Workspace Explorer
3. Should be < 2 seconds from open to workspaces visible

- [ ] **Step 6: End-to-end test — expired token**

Edit `.edog-bearer-cache` to set expiry in the past (or delete the file):
1. Should show onboarding overlay
2. Should re-authenticate automatically
3. Should transition to dashboard

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(onboarding): F00-SF2 complete — browser onboarding flow

End-to-end verified: fresh auth (auto-detect cert, Silent CBA, dashboard),
cached auth (instant resume), expired token (re-auth overlay).

Components: onboarding.js, onboarding.css, dev-server.py endpoints,
token-helper --list-certs mode, main.js auth gate.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review Checklist

| Spec Requirement | Task |
|-----------------|------|
| Case A: single cert auto-auth | Task 4 (`_certs.length === 1` branch) |
| Case B: multiple cert picker | Task 4 (`_renderCertPicker`) |
| Case C: no cert — KV/upload | Task 4 (`_renderNoCerts` + manual entry) |
| Case D: manual tenant entry | Task 4 (`_renderManualEntry`) |
| Auth screen with progress | Task 4 (`_runAuth` + step animations) |
| Split layout aesthetic | Task 3 (full CSS) |
| `/api/edog/certs` endpoint | Task 1 |
| `/api/edog/auth` endpoint | Task 2 |
| `/api/edog/health` endpoint | Task 2 |
| Returning user instant resume | Task 5 (auth gate in main.js) |
| Error handling with retry | Task 4 (`_showError`) |
| PPE wiki link for no cert | Task 4 (hardcoded link in manual entry + error) |
| net8.0 target for token-helper | Task 1 step 1 |
| Pre-scan certs at startup | Task 1 (server calls token-helper) |
| Token caching | Task 2 (`_write_cache` in auth endpoint) |
