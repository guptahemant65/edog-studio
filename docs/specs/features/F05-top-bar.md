# Feature 5: Top Bar

> **Phase:** MVP
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS) + Mika Tanaka (CSS)
> **Spec:** docs/specs/features/F05-top-bar.md
> **Design Ref:** docs/specs/design-spec-v2.md §5

### Problem

Engineers need persistent status information visible at all times: Is the service running? When does the token expire? What git branch am I on? How many patches are applied? Currently this information requires switching to terminal windows.

### Objective

A 44px persistent top bar showing service status, token health countdown, git branch, patch count, restart button, and theme toggle.

### Owner

**Primary:** Zara Okonkwo (JS topbar logic) + Mika Tanaka (CSS topbar styles)
**Reviewers:** Kael Andersen (UX layout), Elena Voronova (status data sources)

### Inputs

- `/api/flt/config` — provides service status, token expiry, workspace/artifact info
- Git status — `git branch --show-current` and `git status --porcelain` (via edog.py or EdogLogServer)
- Patch count — from edog.py's patch tracking
- HTML structure: `#topbar` already exists in `index.html`

### Outputs

- **Files modified:**
  - `src/frontend/js/topbar.js` — Rewrite from mock rendering to live data polling
  - `src/frontend/css/topbar.css` — Refinements for status colors, countdown animation
  - `src/frontend/js/api-client.js` — Add `getConfig()` polling (every 10s)
  - `src/backend/DevMode/EdogApiProxy.cs` — Extend config response with phase, git info, patch count

### Technical Design

**Frontend — `topbar.js`:**

```
class TopBar {
  constructor(topbarEl, apiClient, stateManager)

  async init()                        // Initial config fetch + start polling
  startPolling(intervalMs)            // Poll /api/flt/config every 10s
  updateServiceStatus(status)         // green=Running, gray=Stopped, amber=Building
  updateTokenHealth(expiresAt)        // Countdown timer, color by time remaining
  updateGitInfo(branch, dirtyCount)   // Branch name + badge
  updatePatchCount(count)             // "6 patches" pill
  handleRestartClick()                // POST /api/command/restart via IPC
  handleThemeToggle()                 // Toggle data-theme on body, persist to localStorage

  _startTokenCountdown(expiresAt)     // setInterval every 1s, format as "Xm Ys"
  _getTokenHealthColor(remaining)     // green >10min, amber 5-10min, red <5min
}
```

**Token countdown logic:**

```javascript
_startTokenCountdown(expiresAt) {
  if (this._countdownInterval) clearInterval(this._countdownInterval);
  this._countdownInterval = setInterval(() => {
    const remaining = Math.max(0, expiresAt - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    this.tokenCountdownEl.textContent = `${minutes}m ${seconds}s`;
    this.tokenHealthEl.className = `token-health ${this._getTokenHealthColor(remaining)}`;
    if (remaining <= 0) {
      this.tokenCountdownEl.textContent = 'Expired';
      // Trigger Token Inspector drawer auto-open (V1.1)
    }
  }, 1000);
}
```

**Backend — `EdogApiProxy.cs` config response:**

```json
{
  "phase": "connected",
  "serviceStatus": "running",
  "serviceUptime": 3600,
  "bearerToken": "eyJ...",
  "bearerTokenExpiry": 1712678400,
  "mwcToken": "eyJ...",
  "mwcTokenExpiry": 1712678400,
  "workspaceId": "guid",
  "artifactId": "guid",
  "capacityId": "guid",
  "gitBranch": "feature/dag-studio",
  "gitDirtyCount": 3,
  "patchCount": 6
}
```

### Acceptance Criteria

- [ ] Top bar renders on page load with correct initial state
- [ ] Service status shows colored dot: green (Running), gray (Stopped), amber (Building)
- [ ] Service status text shows uptime when running (e.g., "Running 1h 23m")
- [ ] Token countdown updates every second in format "Xm Ys"
- [ ] Token health color: green (>10min), amber (5-10min), red (<5min)
- [ ] "No token" shown when disconnected (no token available)
- [ ] Git branch name displayed (e.g., "feature/dag-studio")
- [ ] Dirty file count badge shown next to branch name (e.g., "3" in small badge)
- [ ] Patch count pill shows "N patches" (e.g., "6 patches")
- [ ] Restart button sends IPC command and shows loading state
- [ ] Theme toggle switches between light and dark themes
- [ ] Theme preference persists across refreshes via localStorage
- [ ] Top bar is exactly 44px height per design system

### Dependencies

- **Feature 2 (Deploy):** Phase transition triggers top bar updates
- EdogApiProxy must serve extended config response

### Risks

| Risk | Mitigation |
|------|------------|
| Polling /api/flt/config every 10s adds request overhead | 10s is acceptable. Response is small JSON. Reduce to 30s if needed. |
| Git info requires subprocess call from EdogLogServer | Cache git info on startup + on file change. Don't call git on every config request. |

### Moonshot Vision

V2+: CPU/memory sparkline in top bar. Notification bell with action queue. Multi-service status (when running multiple FLT instances). Token auto-refresh with countdown reset.

