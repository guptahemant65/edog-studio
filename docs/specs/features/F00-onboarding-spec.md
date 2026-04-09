# EDOG Playground — Onboarding & First-Time Experience Spec

**Date:** 2026-04-09 (Updated after team review)
**Authors:** Kael Andersen (UX), Elena Voronova (Python/CLI), Sana Reeves (Architecture)
**Status:** Approved

---

## Overview

The onboarding flow takes a developer from zero to browsing their Fabric workspaces
in under 10 seconds. Two components: a one-time **installer** (PowerShell GUI for
detection, then browser wizard for install) and a **first-launch auth flow**
(auto-detect cert, Silent CBA, dashboard).

Returning users see zero auth screens — cached token + session restore puts them
right where they left off.

---

## 1. Installer (`edog-playground-setup.exe`)

### 1.1 What It Does

The installer has two phases:
- **Phase A (PowerShell GUI):** Detect prerequisites + auto-install missing ones.
  This runs BEFORE Python is confirmed, so it cannot use browser UI.
- **Phase B (Browser wizard):** Once Python is confirmed, launch browser-based
  wizard on port 5555 for install + setup steps.

Both phases use the same port (5555). Phase A is a native PowerShell WPF window.
Phase B transitions to the browser on the same port.

Packaging: Inno Setup or MSIX (NOT ps2exe — flagged by antivirus). Code-signed
with a Microsoft internal certificate.

### 1.2 Phase A: Prerequisites (PowerShell native GUI)

A minimal WPF window with the EDOG Playground branding showing a checklist:

```
EDOG PLAYGROUND — Setup

Checking your environment...

✓ Python 3.12.10 found
✓ .NET 8.0.5 SDK found
✓ Git 2.44.0 found
◌ Scanning for FLT repo...
```

Auto-fix for missing prerequisites:
- Python → `winget install Python.Python.3.12 --silent`
  - Fallback if winget missing: download MSI from python.org, run `/quiet`
- .NET SDK → `winget install Microsoft.DotNet.SDK.8 --silent`
  - Fallback: download installer from dotnet.microsoft.com
- Git → `winget install Git.Git --silent`
  - Fallback: download from git-scm.com

Repo detection:
- Scan: `C:\Repos\*`, `%USERPROFILE%\*\newrepo\*`, `D:\*`, VS recent projects
- Verify via `git remote -v` matching ADO URLs
- If found: show path, user confirms
- If not found: ask user — [Clone from ADO] or [Browse to existing clone]
  - Clone: show size estimate "FLT repo is ~2GB. Clone to:" + [Browse...] folder picker
  - User picks location, clone proceeds with progress bar
  - Default clone location: `%USERPROFILE%\Repos\`
- FeatureManagement repo: sibling scan, optional (flags feature won't work without it)

Once all blocking prerequisites pass → "Starting browser wizard..." → transitions
to Phase B on port 5555.

### 1.3 Phase B: Browser Wizard (port 5555)

**Screen 1: Welcome**
- Hero text: "EDOG PLAYGROUND" with warm amber gradient right panel
- Tagline: "Developer cockpit for FabricLiveTable"
- One-liner: "Browse workspaces, manage feature flags, inspect runtime — all from localhost."
- Three feature icons: Workspace Explorer | Feature Flags | Runtime Inspector
- Single CTA: [GET STARTED]

**Screen 2: Installation**
- Install to `%LOCALAPPDATA%\EDOG-Playground\`
- Steps with live progress:
  1. Copy/sync EDOG Playground files
  2. `dotnet build scripts/token-helper/` (build Silent CBA helper)
  3. `pip install -r requirements.txt` (minimal deps)
  4. `python scripts/build-html.py` (build single-file UI)
  5. Create desktop shortcut + Start Menu entry
- Each step independently retryable on failure
- Auto-retry transient failures (NuGet timeout, pip timeout) with 3x backoff

**Screen 3: Done**
- "Ready." hero text
- [LAUNCH EDOG PLAYGROUND] CTA
- Transitions to the first-launch auth flow (same page, port 5555)

### 1.4 Repo URLs (for auto-clone)

- FLT: `https://powerbi@dev.azure.com/powerbi/MWC/_git/workload-fabriclivetable`
- FeatureManagement: `https://powerbi.visualstudio.com/DefaultCollection/Power%20BI/_git/FeatureManagement`

### 1.5 Desktop Shortcut

- Name: "EDOG Playground"
- Action: Start `dev-server.py` on port 5555 → open default browser to `localhost:5555`
- Icon: EDOG Playground icon (to be designed)

---

## 2. First-Launch Auth Flow (Browser UI)

### 2.1 Aesthetic

Split layout matching the reference screenshot:
- Left panel: content/form area with bold uppercase typography
- Right panel: warm amber/orange gradient blob (animated subtle pulse)
- Dark CTA buttons, minimal chrome
- System status bar at top (version, connection status)
- OKLCH color palette per STYLE_GUIDE.md

### 2.2 Flow by Case

**Case A: Cert found in local Windows cert store (90% of devs)**
1. On load: scan `Cert:\CurrentUser\My` for certs with `*CBA*` in CN
   (pre-scanned during server startup, cached in memory)
2. If exactly 1 matching cert → skip picker, go to auth screen
3. Auth screen shows progress (3-5 seconds):
   - Checkmark: Certificate found (CN, expiry)
   - Spinner → Checkmark: Signed in as Admin1CBA
   - Spinner → Checkmark: Workspaces loaded
4. Auto-transition to Dashboard (Workspace Explorer)

**Case B: Multiple CBA certs found**
1. Show cert selector with radio buttons grouped by tenant
2. Pre-select the cert with latest expiry (most recently renewed)
3. User confirms → proceeds to auth screen (same as Case A step 3)

**Case C: No local cert found**
1. Check Key Vault access: `az keyvault secret list --vault-name ppe-ephemeral-admin-kv`
2. If KV access → show "Downloading certificate..." progress → install to local store → auth
3. If no KV access → show:
   - [Upload .pfx certificate] button → file picker dialog
   - Validate uploaded cert: CN must contain CBA pattern, must not be expired
   - On valid upload → install to local store → auth
   - On invalid: show specific error ("Cert expired" / "CN doesn't match") + [Re-upload]
   - Help text: "Don't have a certificate? Request access via the
     [PPE Ephemeral Tenants wiki](https://dev.azure.com/powerbi/Trident/_wiki/wikis/Trident.wiki/80942/PPE-Ephemeral-Tenants-(ES-Maintained-Rotated))"

**Case D: Manual tenant entry**
- Link at bottom of cert selector: "Connect to a different tenant"
- Single field: `Username` (e.g., `Admin1CBA@FabricDMS07PPE.ccsctp.net`)
- Tenant and CN derived from username: `@` → split → tenant + CN
- Flow:
  1. Scan cert store for match → if found: auth directly
  2. If not in store: check KV access → if yes, download matching cert → auth
  3. If no KV access: show [Upload .pfx] + help link to PPE wiki
- Manual tenants are saved to profile for future auto-detection.

### 2.3 Auth Screen Detail

```
AUTHENTICATING
VERIFYING IDENTITY.

✓ Certificate: Admin1CBA.FabricFMLV08PPE.ccsctp.net
  Valid until Aug 1, 2026

✓ Signed in as Admin1CBA
  Token expires in 74 minutes

✓ 13 workspaces loaded

[progress bar ████████████ 100%]
```

- Duration: ~4-6 seconds total
- Each step appears as it completes (staggered fade-in)
- On success: 500ms pause then auto-transition to dashboard
- On failure: show error inline with [Retry] button

### 2.4 Authentication Method

- **Silent CBA** via `scripts/token-helper/token-helper.exe`
- Uses `Microsoft.Identity.Client.TestOnlySilentCBA` (3-phase HTTP flow, zero browser)
- Target: `net8.0` (not net472 — avoids .NET Framework dependency)
- Cert thumbprint cached to `.edog-thumbprint-cache` (disk) after first lookup
- Bearer token cached to `.edog-bearer-cache` (disk, base64-encoded with expiry)
- Note: `TestOnlySilentCBA` has a newer replacement (User FIC via MISE 1.35+).
  Current package works for PPE. Upgrade path documented for future.

---

## 3. Returning User Experience

### 3.1 Instant Resume

On launch (day 2+):
1. Start dev-server.py (~1s)
2. Browser opens to `localhost:5555`
3. Load cached bearer token (30ms)
4. If valid (>5 min remaining): skip auth entirely → restore session
5. If expired: Silent CBA refresh (~4s) in background → show dashboard immediately
   with cached data → swap to fresh data when ready

### 3.2 Session Persistence

Auto-saved every 10 seconds to `edog-session.json` (not on close — handles force-close):
- `lastTenant`: username (e.g., `Admin1CBA@FabricFMLV08PPE.ccsctp.net`)
- `lastView`: active tab/view ID
- `lastWorkspace`: expanded workspace ID + selected item
- `scrollPosition`: per-view scroll offsets
- `recentLakehouses`: last 5 accessed lakehouses (for quick-launch)

On load: restore exactly where they left off.

### 3.3 Multi-Tenant Switching

- Top bar shows current tenant: `Admin1CBA@FabricFMLV08PPE ▾`
- Click → dropdown with saved tenants + [Add tenant...] option
- Switch → 4-second re-auth via Silent CBA → dashboard reloads with new tenant data
- Each tenant has independent session state (workspace, view, scroll)

---

## 4. Error Handling

### 4.1 Principles

1. **Auto-fix first**: attempt programmatic resolution before showing error
2. **Specific messages**: "Certificate expired on Aug 1, 2026" not "Auth failed"
3. **Actionable next step**: every error has a button (Retry / Upload / Switch Tenant)
4. **No dead ends**: user can always get back to a working state
5. **Independent retry**: each step retryable without restarting the flow
6. **Wiki link**: "Don't have access?" always links to PPE Ephemeral Tenants wiki

### 4.2 Error Catalog

| Error | Auto-Fix | Fallback |
|-------|----------|----------|
| Cert not in store | Check KV → download | Upload .pfx prompt + wiki link |
| Cert expired | None (admin must renew) | Show expiry + wiki link |
| Wrong CN on uploaded cert | None | "Expected *CBA*, got {CN}" + re-upload |
| KV access denied | Skip silently → local cert | Upload .pfx prompt + wiki link |
| Silent CBA timeout | Retry 2x with 3s delay | "PPE auth may be down" + manual retry |
| API 401 after login | Try different scope/audience | "Token rejected — try another tenant" |
| Port 5555 busy | Kill previous edog process | Show which process holds the port |
| token-helper.exe not built | Auto-build (`dotnet build`) | Show build error + instructions |
| No cert at all (new hire) | None | "Request access" + wiki link |
| winget not available | Fall back to direct MSI download | Show manual install instructions |

---

## 5. UI Components Needed

### New (for onboarding)
- `onboarding-screen.js` — Full-screen auth/setup overlay
- `cert-selector.js` — Radio list of discovered certs
- `progress-stepper.js` — Animated checkmark progress list
- `tenant-switcher.js` — Top bar dropdown for multi-tenant

### Modified
- `main.js` — Check auth state on load, show onboarding if needed
- `api-client.js` — Accept tenant from onboarding, refresh on tenant switch

### Installer (separate build)
- `install-wizard.html` — Browser wizard UI (Screen 1-3 of Phase B)
- `install-server.py` — Tiny HTTP server for install wizard (reuses port 5555)
- `install.ps1` — PowerShell script for Phase A (detection + auto-fix)
- Inno Setup / MSIX wrapper for `.exe` packaging

---

## 6. Data Flow

```
[Installer .exe]
  → Phase A: PowerShell native GUI (detect/install prereqs)
  → Phase B: install-server.py on port 5555 (browser wizard)
  → Install files, build token-helper, create shortcut
  → Done → Launch EDOG Playground on port 5555

[First Launch]
  → dev-server.py starts (port 5555), pre-scans cert store
  → index.html loads
  → main.js checks: has cached bearer?
    YES → restore session → dashboard
    NO  → show onboarding-screen
      → /api/edog/certs (pre-cached, instant)
      → auto-select or user picks cert
      → /api/edog/auth (triggers token-helper.exe, ~4s)
      → token returned → cached
      → dashboard loads with real data

[Returning Launch]
  → dev-server.py starts (port 5555)
  → index.html loads
  → main.js: cached bearer valid? YES → dashboard
  → Session restored from edog-session.json

[Tenant Switch]
  → User clicks tenant dropdown → picks new tenant
  → /api/edog/auth with new username
  → Silent CBA (~4s)
  → Dashboard reloads with new tenant data
```

---

## 7. API Endpoints (dev-server.py additions)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/edog/certs` | GET | List CBA certs (pre-scanned at startup, cached) |
| `/api/edog/auth` | POST | Trigger Silent CBA, return bearer token |
| `/api/edog/session` | GET/PUT | Load/save session state |
| `/api/edog/tenants` | GET | List saved tenants with last-used timestamp |
| `/api/edog/health` | GET | Pre-flight check (Python, dotnet, cert, token) |

---

## 8. Success Metrics

- **First-time onboarding**: < 30 seconds from installer done to browsing workspaces
- **Returning launch**: < 2 seconds from shortcut click to dashboard
- **Auth success rate**: > 99% for devs with valid CBA cert
- **Zero manual token management**: no copy-paste, no browser, no cert dialog ever
- **Session restore accuracy**: 100% — user sees exactly where they left off
