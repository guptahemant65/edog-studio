# EDOG-STUDIO OPERATIONAL RUNBOOKS

> **Status:** 🟢 ACTIVE
> **Applies To:** All edog-studio agents
> **Last Updated:** 2026-04-08

---

## Quick Index

| Runbook | When to Use | Owner |
|---------|-------------|-------|
| [RB-001: Release a New Version](#rb-001-release-a-new-version) | Shipping a release | Ren Aoki |
| [RB-002: Onboard a New FLT Team Member](#rb-002-onboard-a-new-flt-team-member) | New FLT engineer needs edog | Elena Voronova |
| [RB-003: Handle a Broken Build](#rb-003-handle-a-broken-build) | CI/build is red | Ren Aoki |
| [RB-004: Update for FLT Codebase Changes](#rb-004-update-for-flt-codebase-changes) | FLT refactored, patches break | Dev Patel |
| [RB-005: Add a New C# Interceptor](#rb-005-add-a-new-c-interceptor) | New data capture needed | Arjun Mehta |
| [RB-006: Add a New Frontend View/Tab](#rb-006-add-a-new-frontend-viewtab) | New UI section | Zara + Mika + Kael |
| [RB-007: Update Feature Flag Definitions](#rb-007-update-feature-flag-definitions) | Flags changed in FeatureManagement repo | Dev Patel |

---

## RB-001: Release a New Version

### When to Use
Shipping a new version of edog-studio with completed features.

### Owner: Ren Aoki

### Prerequisites
- [ ] All quality gates pass (`quality_gates.py`)
- [ ] `build-html.py` produces valid output
- [ ] `dotnet build` succeeds for C# files
- [ ] Browser smoke test passes (all views, keyboard shortcuts)
- [ ] No open P0/P1 issues

### Steps

**1. Bump Version**
```bash
# Update version in edog.py (VERSION constant)
# Update version in edog-config.json if applicable
# Format: YYYY.MM.DD (CalVer)
```

**2. Update Changelog**
```bash
# Add entry to CHANGELOG.md (if it exists) or docs/CHANGELOG.md
# Format:
# ## [2026.04.08]
# ### Added
# - Workspace Explorer tree view
# - Token countdown timer
# ### Fixed
# - WebSocket reconnection on tab sleep
```

**3. Run Full Verification**
```bash
# Build frontend
python build-html.py

# Build C#
dotnet build src/backend/DevMode/

# Run Python tests
pytest tests/ -v

# Run quality gates
python -m hivemind.agents.quality_gates

# Browser smoke test (manual)
edog.cmd
# → Verify all 6 views, keyboard shortcuts, token display
```

**4. Commit and Tag**
```bash
git add -A
git commit -m "chore(release): v2026.04.08

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

git tag -a v2026.04.08 -m "Release 2026.04.08"
git push origin main --tags
```

**5. Post-Release**
- [ ] Notify the FLT team on Teams/email
- [ ] Update onboarding docs if install steps changed
- [ ] Monitor for issues in the first 24 hours

---

## RB-002: Onboard a New FLT Team Member

### When to Use
A new FLT engineer needs to start using edog-studio.

### Owner: Elena Voronova

### Prerequisites
- [ ] Engineer has FLT repo cloned locally
- [ ] Engineer has valid Microsoft certificate for auth
- [ ] Engineer has Python 3.8+ installed

### Steps

**1. Install edog-studio**
```powershell
# Clone the repo (or pull latest)
git clone <edog-studio-repo-url>
cd edog-studio

# Run the installer
.\install.ps1
```

**2. Configure**
```powershell
# Run setup to configure FLT repo path and workspace
.\edog.cmd --setup

# This will:
# - Ask for FLT repo root path
# - Ask for default workspace ID
# - Create edog-config.json
# - Verify the certificate is loadable
```

**3. First Run**
```powershell
# Start edog
.\edog.cmd

# Open browser to http://localhost:5555
# Verify:
# - UI loads with Workspace Explorer
# - Token health shows in the top bar
# - Sidebar navigation works (keyboard 1-6)
# - Ctrl+K opens command palette
```

**4. Deploy to a Lakehouse (Phase 2)**
```powershell
# In the UI: click "Deploy to this Lakehouse" or use Ctrl+K → "deploy"
# This will:
# - Fetch MWC token via Playwright
# - Patch FLT source with DevMode interceptors
# - Build the patched FLT
# - Launch FLT service with edog integration
```

**5. Verify Connection**
- [ ] Live logs stream in the Logs view
- [ ] Token countdown updates every second
- [ ] Service status shows "Connected" in the top bar

### Troubleshooting

If something goes wrong, direct the engineer to `hivemind/DEBUGGING.md`.

Common first-run issues:
- Certificate not loaded → Open Edge, navigate to Fabric, select cert
- Port 5555 in use → Kill existing process or change port
- FLT repo not found → Check `edog-config.json` path

---

## RB-003: Handle a Broken Build

### When to Use
`build-html.py` or `dotnet build` is failing on the main branch.

### Owner: Ren Aoki
### Urgency: P1 — blocks all development

### Steps

**1. Identify the Break**
```bash
# Check what changed
git --no-pager log --oneline -5

# Run the failing build
python build-html.py 2>&1
# or
dotnet build src/backend/DevMode/ 2>&1
```

**2. Classify the Failure**

| Type | Example | Action |
|------|---------|--------|
| Missing file | `FileNotFoundError` | File was deleted or renamed — restore or update references |
| Syntax error | Python/JS/C# parse error | Fix the syntax in the offending file |
| Module order | JS class not defined when referenced | Update `build-html.py` module order |
| FLT API change | C# compile error, missing method | Update interceptor code to match FLT |
| StyleCop | Analyzer warnings | Fix or suppress per DEBUGGING.md |

**3. Fix and Verify**
```bash
# Fix the issue
# Rebuild
python build-html.py && dotnet build src/backend/DevMode/

# Run tests
pytest tests/ -v

# Smoke test in browser
start http://localhost:5555
```

**4. Commit the Fix**
```bash
git add -A
git commit -m "fix(build): <describe what broke and why>

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin main
```

**5. Post-Mortem (if the break lasted > 1 hour)**
```
WHAT HAPPENED: [Build broke because...]
IMPACT: [No agent could build/test for X minutes]
ROOT CAUSE: [File renamed without updating build script]
WHAT WE'LL CHANGE: [Add build verification to pre-commit hook]
```

---

## RB-004: Update for FLT Codebase Changes

### When to Use
The FLT team has refactored code that edog-studio patches or depends on, causing patch failures or compilation errors.

### Owner: Dev Patel (analysis) + Arjun Mehta (C# fixes) + Elena Voronova (Python patch fixes)

### Steps

**1. Identify What Changed**
```bash
# In the FLT repo, check recent changes to files we patch
cd <FLT_REPO_PATH>
git --no-pager log --oneline -20

# Look for changes in files we care about:
# - Files containing classes we subclass
# - Files where we inject interceptors
# - API endpoints we proxy
```

**2. Categorize the Change**

| Change Type | Impact | Action |
|-------------|--------|--------|
| Method renamed | Patch pattern won't match | Update patch pattern in `edog.py` |
| Method signature changed | C# compile error | Update interceptor code |
| File moved to different namespace | Both patch and compile errors | Update path + namespace references |
| New dependency added | May need reference in DevMode project | Add project reference |
| Class refactored to interface | Subclass pattern breaks | Redesign interception approach (ADR needed) |

**3. Update edog-studio**
```bash
# Update patches in edog.py
# Update C# interceptor code if needed
# Update any API endpoint URLs

# Test patches on a clean FLT checkout
cd <FLT_REPO_PATH>
git stash  # Clean state
cd <EDOG_STUDIO_PATH>
python edog.py --dry-run  # Verify patches apply

# Build
python build-html.py
dotnet build src/backend/DevMode/
```

**4. Document**
- Note which FLT commit caused the break
- Update ADR if the change affects architecture decisions
- Notify Sana if the change was significant

---

## RB-005: Add a New C# Interceptor

### When to Use
A new feature requires capturing data from the FLT service (e.g., Spark requests, DAG execution events, telemetry).

### Owner: Arjun Mehta (implementation) + Sana Reeves (design review)

### Prerequisites
- [ ] Design spec section exists for the feature
- [ ] Sana has approved the interception approach
- [ ] FLT injection point identified by Dev Patel

### Steps

**1. Create the Interceptor File**
```csharp
#nullable disable
// EdogNewInterceptor.cs — Brief description of what this intercepts

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading.Tasks;

namespace FabricLiveTable.DevMode
{
    /// <summary>
    /// Intercepts [what] from the FLT service and forwards to edog-studio.
    /// </summary>
    public class EdogNewInterceptor
    {
        // Implementation following the interceptor pattern
    }
}
```

**2. Add the Patch**
```python
# In edog.py, add a new patch entry:
# - Target file in FLT repo
# - Pattern to find the injection point
# - Code to insert
# Keep the patch surface minimal
```

**3. Wire the Data Pipeline**
```
C# Interceptor → HTTP POST to localhost:5555/api/edog/<endpoint>
     → Python backend receives and stores/streams
     → WebSocket pushes to frontend
     → Frontend module renders the data
```

**4. Test**
- [ ] `dotnet build` succeeds
- [ ] Patch applies cleanly to FLT
- [ ] Data flows end-to-end in development
- [ ] Interceptor failure doesn't crash FLT (fault isolation test)
- [ ] No measurable overhead (< 1ms per interception)

**5. Update Documentation**
- [ ] Add to architecture diagram in README.md
- [ ] Update ENGINEERING_STANDARDS.md if new patterns introduced
- [ ] Write ADR if this uses a new interception approach

---

## RB-006: Add a New Frontend View/Tab

### When to Use
Adding a new view to the sidebar navigation (e.g., DAG Studio, Spark Inspector, API Playground).

### Owner: Kael Andersen (design) + Zara Okonkwo (JS) + Mika Tanaka (CSS)

### Prerequisites
- [ ] Design spec section exists for the view
- [ ] Kael has defined the information architecture
- [ ] Keyboard shortcut assigned (number key or Ctrl+K command)

### Steps

**1. Create CSS Module**
```
src/edog-logs/css/new-view.css
```
- Follow OKLCH color system
- Use 4px spacing grid (`var(--space-*)`)
- No hardcoded values
- Add to `build-html.py` CSS module list (in correct dependency order)

**2. Create JS Module**
```
src/edog-logs/js/new-view.js
```
- Class-based module pattern
- Constructor takes container element
- Public API for data updates
- Private methods prefixed with `_`
- Add to `build-html.py` JS module list (after utils, before app)

**3. Update HTML Template**
```html
<!-- In src/edog-logs/index.html -->
<!-- Add sidebar icon/label -->
<!-- Add view container with data-view attribute -->
```

**4. Wire Into App**
```javascript
// In app.js:
// - Register the view in the view switching logic
// - Add keyboard shortcut
// - Register in command palette
// - Handle phase awareness (is this view disconnected-only? connected-only? both?)
```

**5. Build and Test**
```bash
# Build
python build-html.py

# Browser test checklist:
# □ View renders correctly
# □ Sidebar icon/label shows
# □ Keyboard shortcut works
# □ Command palette can switch to it
# □ Empty state shows helpful message
# □ OKLCH colors consistent with other views
# □ 4px grid alignment verified
# □ No console errors
# □ Works in Edge and Chrome
# □ Phase-aware enabling/disabling works
```

**6. Update Documentation**
- [ ] Add view to sidebar navigation table in design spec
- [ ] Add keyboard shortcut to shortcuts table
- [ ] Update the browser testing checklist in ENGINEERING_STANDARDS.md

---

## RB-007: Update Feature Flag Definitions

### When to Use
The FLT FeatureManagement repo has added, removed, or changed feature flags, and edog-studio needs to reflect these changes.

### Owner: Dev Patel

### Steps

**1. Identify Changes**
```bash
# Check the FeatureManagement repo for recent changes
cd <FEATURE_MANAGEMENT_REPO>
git --no-pager log --oneline -10

# Look for changes to:
# - FeatureNames.cs (flag name constants)
# - Feature flag configuration files
# - Rollout percentage definitions
```

**2. Update Flag Definitions in edog-studio**
```bash
# Update the flag list used by the UI
# This might be in:
# - A JSON config file with flag definitions
# - A Python dict in edog.py
# - The frontend JS that renders the flag list
```

**3. Verify IFeatureFlighter Wrapper**
```bash
# Ensure the late DI registration still works with new flags
# Build and test the C# wrapper
dotnet build src/backend/DevMode/

# Test flag override behavior:
# - Default flag values match production
# - Override applies when toggled in UI
# - Override persists across FLT service restarts (if expected)
```

**4. Update UI**
```bash
# If new flags were added:
# - They should appear in the feature flag management view
# - Default rollout percentage should be shown
# - Local override toggle should work

# Build and verify
python build-html.py
# Open browser, check feature flag view
```

**5. Document**
- Note which flags changed and why
- Update any hardcoded flag references in edog-studio code
- Notify the team if a flag change affects edog behavior

---

## Runbook Template

When adding a new runbook, use this structure:

```markdown
## RB-NNN: [Title]

### When to Use
[What situation triggers this runbook]

### Owner: [Agent name]

### Prerequisites
- [ ] [Required condition 1]
- [ ] [Required condition 2]

### Steps

**1. [Phase Name]**
[Detailed steps with commands]

**2. [Phase Name]**
[Detailed steps with commands]

### Rollback
[How to undo if something goes wrong]

### Success Criteria
- [ ] [How to know it worked]
```

---

## Runbook Maintenance

### Update Triggers
- After each use: update with learnings
- When a step no longer works: fix immediately
- When a new failure mode is discovered: add a section
- When FLT codebase changes affect procedures: update RB-004

### Review Process
- Ren reviews build/release runbooks
- Dev reviews FLT integration runbooks
- Sana reviews all for architectural accuracy
- CEO reviews when process changes affect FLT team

---

*"A runbook is only as good as its last update."*

— edog-studio operations
