# EDOG-STUDIO DEBUGGING GUIDE

> **Status:** 🟢 ACTIVE
> **Applies To:** All edog-studio agents
> **Last Updated:** 2026-04-08

---

## Purpose

edog-studio spans three languages, two build pipelines, browser auth via Playwright, token management, code patching, and WebSocket streaming. When something breaks, the failure surface is wide. This guide maps common failures to their root causes so you fix the right thing on the first try.

**The debugging oath:** Do NOT guess. Do NOT apply random fixes. Follow the 4-phase process: Gather → Hypothesize → Test → Fix.

---

## Quick Reference

| Symptom | Likely Cause | Section |
|---------|-------------|---------|
| `build-html.py` fails | Missing source file, bad module order | [Build Failures](#1-build-failures) |
| `dotnet build` fails with StyleCop errors | Pragma warnings missing, using order | [C# Build Failures](#c-build-failures) |
| Token expired / "401 Unauthorized" | Token cache stale, cert not loaded | [Token Issues](#2-token-issues) |
| "Port 5555 already in use" | Previous edog instance still running | [Port Conflicts](#3-port-conflicts) |
| "FLT repo not found" | Config path wrong, repo moved | [FLT Repo Not Found](#4-flt-repo-not-found) |
| "Pattern not found" during patch | FLT code structure changed | [Patch Failures](#5-patch-failures) |
| WebSocket disconnects randomly | Server restart, browser tab sleep | [WebSocket Disconnects](#6-websocket-disconnects) |
| StyleCop analyzer warnings | Missing `#nullable disable`, using order | [StyleCop Failures](#7-stylecop-failures) |

---

## 1. Build Failures

### Python Build (`build-html.py`)

**Symptom:** `python build-html.py` fails or produces broken HTML.

**Common causes:**

| Error | Cause | Fix |
|-------|-------|-----|
| `FileNotFoundError: src/edog-logs/css/variables.css` | CSS file moved or renamed | Check `src/edog-logs/css/` directory. File list must match what `build-html.py` expects. |
| `FileNotFoundError: src/edog-logs/js/app.js` | JS file moved or renamed | Same — check `src/edog-logs/js/`. |
| Output HTML is empty or truncated | Exception during concatenation | Run with `python build-html.py` and read the full traceback. |
| HTML works in browser but CSS is missing | CSS module not listed in build order | Check the module list in `build-html.py`. New CSS files must be added explicitly. |
| HTML works but JS module not initialized | JS file loaded before its dependency | Check JS module order in `build-html.py`. Dependencies must come first (utils → components → app). |

**Diagnostic steps:**
```bash
# 1. Verify all source files exist
python -c "from pathlib import Path; [print(f) for f in sorted(Path('src/edog-logs').rglob('*')) if f.is_file()]"

# 2. Run the build and capture full output
python build-html.py 2>&1

# 3. Verify output is valid HTML
python -c "from pathlib import Path; html = Path('src/edog-logs.html').read_text(); print(f'Size: {len(html)} bytes'); print(f'Has <html>: {\"<html\" in html}'); print(f'Has </html>: {\"</html>\" in html}')"

# 4. Check for external references (should be zero)
python -c "from pathlib import Path; html = Path('src/edog-logs.html').read_text(); links = [l for l in html.split('\n') if '<link' in l or 'src=\"http' in l]; print(f'External refs: {len(links)}'); [print(l.strip()) for l in links]"
```

### C# Build Failures

**Symptom:** `dotnet build` fails on DevMode files.

**Common causes:**

| Error | Cause | Fix |
|-------|-------|-----|
| `CS8632: nullable annotations` | Missing `#nullable disable` pragma | Add `#nullable disable` as the first line of the `.cs` file |
| `SA1200: Using should be placed within namespace` | StyleCop ordering violation | Move `using` statements outside namespace, alphabetical |
| `CS0246: Type or namespace not found` | Missing project reference | Check that the DevMode `.csproj` references the correct FLT projects |
| `CS1061: does not contain a definition for` | FLT API changed | Check FLT codebase for method signature changes |

**Diagnostic steps:**
```bash
# Build with verbose output
dotnet build src/backend/DevMode/ -v detailed 2>&1 | head -100

# Check specific error
dotnet build src/backend/DevMode/ 2>&1 | grep -i "error"
```

---

## 2. Token Issues

### Expired Token

**Symptom:** API calls return 401. Token countdown shows negative time. UI shows "Token Expired" state.

**Diagnostic steps:**
```bash
# 1. Check token cache
python -c "
from pathlib import Path
import json, time, base64
cache = Path('.edog-token-cache')
if not cache.exists():
    print('No token cache file found')
else:
    data = json.loads(cache.read_text())
    for key, val in data.items():
        if 'token' in key.lower():
            # Decode JWT payload (middle segment)
            parts = val.split('.')
            if len(parts) == 3:
                payload = json.loads(base64.b64decode(parts[1] + '=='))
                exp = payload.get('exp', 0)
                remaining = exp - time.time()
                print(f'{key}: expires in {remaining/60:.1f} minutes')
"
```

**Common causes and fixes:**

| Cause | Fix |
|-------|-----|
| Token naturally expired (1hr lifetime) | Re-run `edog.cmd` or press R in the UI to trigger refresh |
| Playwright browser session lost | Close all Edge instances, re-run edog |
| Certificate not loaded in browser | Open Edge manually, navigate to Fabric, ensure cert prompt appears |
| Wrong token scope | Check `edog-config.json` — `workspace_id` and `artifact_id` must be valid GUIDs |
| `.edog-token-cache` corrupted | Delete the file and re-run edog to regenerate |

### Certificate Not Loaded

**Symptom:** Playwright hangs on "Select a certificate" dialog or times out.

**Fix:**
1. Open Edge manually: `start msedge https://app.fabric.microsoft.com`
2. When the certificate dialog appears, select your Microsoft certificate
3. Close Edge
4. Re-run edog — Playwright should now use the cached cert selection

---

## 3. Port Conflicts

**Symptom:** `OSError: [Errno 10048] Only one usage of each socket address is normally permitted` or "Port 5555 already in use."

**Diagnostic steps:**
```powershell
# Find what's using port 5555
netstat -ano | findstr :5555

# Find the process
Get-Process -Id <PID_FROM_ABOVE>
```

**Fixes:**
1. Kill the previous edog process: `Stop-Process -Id <PID>`
2. If it's another application, change the port in `edog-config.json`:
   ```json
   { "port": 5556 }
   ```
3. If the port is stuck (TIME_WAIT), wait 60 seconds or use a different port

**Port 5556 conflict:** If the IPC HTTP server on 5556 is also conflicting, stop all edog processes and restart.

---

## 4. FLT Repo Not Found

**Symptom:** edog.py reports "FLT repository not found" or "Cannot find FabricLiveTable source."

**Diagnostic steps:**
```bash
# Check edog-config.json for the FLT path
python -c "
from pathlib import Path
import json
config = json.loads(Path('edog-config.json').read_text())
flt_path = config.get('flt_repo_path', 'NOT SET')
print(f'FLT path: {flt_path}')
print(f'Exists: {Path(flt_path).exists() if flt_path != \"NOT SET\" else False}')
"
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| `flt_repo_path` not set in config | Run `edog.cmd --setup` or manually set the path |
| FLT repo moved to a different directory | Update `flt_repo_path` in `edog-config.json` |
| Path uses forward slashes on Windows | Use backslashes or raw strings: `C:\\repos\\FabricLiveTable` |
| FLT repo exists but is on a different branch | Ensure the target branch has the expected file structure |

---

## 5. Patch Failures

**Symptom:** edog.py reports "Pattern not found" when applying DevMode patches to the FLT codebase.

This is the most common failure mode after FLT team updates their code.

**Why it happens:** edog patches work by finding specific text patterns in FLT source files and inserting/replacing code. When the FLT team refactors, renames methods, or restructures files, our patterns stop matching.

**Diagnostic steps:**
```bash
# 1. Identify which patch failed
# The error output will show the file and pattern that didn't match

# 2. Check if the target file still exists
# Look in the FLT repo at the path from the error

# 3. Search for the pattern (it may have moved)
# Use grep/ripgrep to find the pattern text in the FLT codebase
```

**How to fix:**
1. Open the FLT file mentioned in the error
2. Find where the code moved to (search for key identifiers like class names, method names)
3. Update the patch pattern in `edog.py` to match the new code structure
4. Test the patch on a clean FLT checkout
5. Document the FLT change that caused the break (for Dev Patel's awareness)

**Prevention:**
- Dev Patel should monitor FLT PRs that touch files we patch
- Patches should match on stable identifiers (class names, method signatures) not whitespace or comments
- Keep the patch surface area minimal — fewer patches = fewer breaks

---

## 6. WebSocket Disconnects

**Symptom:** Live log stream stops updating. Browser console shows WebSocket close events. UI shows "Disconnected" status.

**Common causes:**

| Cause | Fix |
|-------|-----|
| Python backend restarted | Frontend should auto-reconnect. If not, refresh the browser. |
| Browser tab went to sleep (power saving) | Click on the tab to wake it. Modern browsers throttle background tabs. |
| FLT service restarted | The C# interceptors restart with FLT. Logs resume when FLT is back up. |
| Network buffer overflow | If log volume is extreme (>5000/sec), the WebSocket buffer may overflow. Reduce log verbosity or add server-side filtering. |
| Antivirus/firewall blocking localhost | Add exception for `localhost:5555` and `localhost:5556` |

**Frontend reconnection logic:**
The frontend should implement exponential backoff reconnection:
```
Attempt 1: wait 1s
Attempt 2: wait 2s
Attempt 3: wait 4s
Attempt 4: wait 8s
Max: wait 30s, then keep retrying every 30s
```

---

## 7. StyleCop Failures

**Symptom:** C# build produces StyleCop analyzer warnings/errors on DevMode files.

**Required pragmas for every DevMode `.cs` file:**
```csharp
#nullable disable
// EdogFileName.cs — Brief description
```

**Common StyleCop issues in edog code:**

| Warning | Cause | Fix |
|---------|-------|-----|
| SA1200 | `using` inside namespace | Move `using` statements above the namespace |
| SA1633 | Missing file header | Add the file description comment after `#nullable disable` |
| SA1101 | `this.` prefix missing | Add `this.` or suppress with `#pragma warning disable SA1101` |
| SA1516 | Missing blank line between elements | Add the blank line |
| IDE0060 | Unused parameter | Remove the parameter or add `_ =` discard |

**When to suppress vs. fix:**
- **Fix** if the warning is about real code quality (unused variables, missing docs)
- **Suppress** only if the warning conflicts with FLT codebase conventions (FLT uses `#nullable disable`, some FLT patterns trigger SA1101)

```csharp
#pragma warning disable SA1101 // Prefix local calls with this
#pragma warning disable SA1633 // File should have header
```

---

## Log Locations & Diagnostic Files

| File | What It Contains | When to Check |
|------|-----------------|---------------|
| Console output (stdout/stderr) | edog.py runtime logs, build output | Any failure — always check first |
| `.edog-token-cache` | Cached bearer and MWC tokens | Token expiry, auth failures |
| `edog-config.json` | All configuration: paths, workspace IDs, port | "Not found" errors, wrong workspace |
| `src/edog-logs.html` | Last build output | Frontend rendering issues |
| Browser DevTools Console | JS errors, WebSocket events | UI bugs, missing data |
| Browser DevTools Network | HTTP requests, WebSocket frames | API errors, missing responses |

---

## Testing Components Independently

### Frontend Only (No Backend)

```bash
# Build the HTML
python build-html.py

# Open directly in browser (file:// mode)
start src/edog-logs.html

# Frontend will be in "disconnected" mode — no live data
# But you can verify layout, styling, keyboard shortcuts
```

### Python Backend Only (No C# / No FLT)

```bash
# Run edog without deploying to FLT
python edog.py --no-deploy

# This starts the HTTP server and serves the UI
# You can test token management, API proxy, config loading
# But no live logs (those come from C# interceptors)
```

### C# Interceptors Only

```bash
# Build the C# project independently
dotnet build src/backend/DevMode/

# Run FLT service with DevMode enabled
# The interceptors will start sending data to localhost:5555
# You need the Python backend running to receive them
```

### Full Stack Smoke Test

```bash
# 1. Build everything
python build-html.py && dotnet build src/backend/DevMode/

# 2. Start edog
edog.cmd

# 3. Open browser
start http://localhost:5555

# 4. Verify: UI loads, token shows, sidebar works, keyboard shortcuts work
# 5. Deploy to a lakehouse → verify logs start streaming
```

---

## The 4-Phase Debugging Process

When something breaks, follow this process. No shortcuts.

### Phase 1: GATHER

Collect ALL available error information before forming any hypothesis.

- **Capture:** full error message, traceback, exit code
- **Capture:** which command was run, what arguments
- **Capture:** what changed since it last worked (code, config, FLT version)
- **Never** skip this step

### Phase 2: HYPOTHESIZE

Form exactly 3 hypotheses, ranked by likelihood.

```
H1 (most likely): [based on the error message]
H2 (alternative):  [different cause, same symptom]
H3 (environmental): [config drift, dependency change, FLT update]
```

Write all 3 before testing any of them.

### Phase 3: TEST

Test each hypothesis with minimal, isolated changes.

- Test in order (most likely first)
- Change ONE thing at a time
- Record: what you changed, what you expected, what happened
- If disproven, move to the next — don't force-fit the hypothesis

### Phase 4: FIX

Apply the smallest fix that addresses the root cause.

- Fix the root cause, not the symptom
- Write a regression test if the bug was non-obvious
- Verify the fix doesn't break other components
- Document what broke and why

### The 3-Fix Rule

If you've attempted 3 fixes and none worked:
- **STOP** — the problem is likely structural
- **ESCALATE** to Sana with your 3 attempts documented
- The architecture may need adjustment, not a patch

---

*"Every bug has a cause. Find the cause, not a workaround."*

— edog-studio debugging
