# F05 Top Bar — Complete UX State Matrix

> **Feature:** F05 Top Bar
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS) + Mika Tanaka (CSS) + Kael Andersen (UX)
> **Last Updated:** 2025-07-14
> **States Documented:** 127

---

## How to Read This Document

Every state is documented as:
```
STATE_ID | Trigger | What User Sees | Components Used | Transitions To
```

States are grouped by component zone and interaction category. Each state has a unique ID for reference in code reviews and bug reports (e.g., "this violates F05-TKN-003").

**Top bar anatomy (left → right):**
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [EDOG] [Tenant ▾] [● Running 14m 22s] [Connected]     [42:18] [main +3] [6 patches] [☽] │
└──────────────────────────────────────────────────────────────────────────────┘
 ↕ 44px fixed. z-index: 100. Renders above all panels. Never scrolls.
```

**File change banner (slides below top bar when active):**
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▌ Files changed: GTSBasedSparkClient.cs, WorkloadApp.cs    [Re-deploy] [Dismiss] │
└──────────────────────────────────────────────────────────────────────────────┘
 ↕ 36px. Amber left border. Slides in/out with 200ms ease-out.
```

---

## 1. TOP BAR CONTAINER

### 1.1 Layout & Lifecycle

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| BAR-001 | Initial render | Page load completes | 44px bar, background: var(--surface-1), bottom border: 1px solid var(--border-1). EDOG wordmark left. All status zones show shimmer placeholders (tenant, status, token, git, patches). Theme toggle renders immediately (no data dependency) | BAR-002 |
| BAR-002 | First config loaded | `/api/flt/config` returns 200 | Shimmers crossfade to real data (300ms). Tenant populates, service status dot appears, token countdown starts, git info fills in. Polling begins at 10s interval | TNT-001, SVC-*, TKN-*, GIT-*, PAT-* |
| BAR-003 | Config load failed | `/api/flt/config` returns error or timeout (>5s) | Shimmers replaced with muted "—" placeholders in each zone. Subtle error indicator: red dot on the EDOG wordmark. Tooltip on wordmark: "Cannot reach server. Retrying..." Auto-retry every 10s | BAR-002 (on retry success) |
| BAR-004 | Config poll failure (transient) | Single poll fails after initial success | Last-known values retained. No visual disruption. Console warns. Next poll retries normally | BAR-002 (on next success) |
| BAR-005 | Config poll failure (sustained, 3+ consecutive) | 3 consecutive poll failures | Connection indicator switches to "Reconnecting" (see CON-003). All countdown timers freeze at last known value. Muted overlay: values dim to 60% opacity | CON-003 |
| BAR-006 | Server disconnected | WebSocket close / server unreachable for >30s | Connection indicator: "Disconnected" (red). Service status: "Unknown". Token countdown freezes. All values show last-known with strikethrough opacity (40%). Banner: "Server connection lost" at top | CON-002 |
| BAR-007 | Server reconnected | WebSocket reopens / poll succeeds after disconnect | All values refresh instantly. Brief green flash on bar bottom border (200ms). Connection indicator returns to "Connected" | BAR-002 |

### 1.2 Responsive Breakpoints

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| BAR-010 | Full width (≥1200px) | Viewport ≥1200px | All zones visible: EDOG wordmark, tenant selector (full label), service status, connection, token pill, git branch + dirty count, patch count pill, theme toggle | — |
| BAR-011 | Medium width (1000–1199px) | Viewport 1000–1199px | Tenant selector collapses to icon-only (first letter avatar, e.g. "A" for Admin1CBA). Tooltip shows full tenant name on hover. All other zones visible | BAR-010 (resize up) |
| BAR-012 | Narrow width (900–999px) | Viewport 900–999px | Git info and patch count hide (display: none). Remaining: EDOG, tenant icon, status, connection, token, theme toggle | BAR-011 (resize up) |
| BAR-013 | Minimum width (<900px) | Viewport <900px | Minimal bar: EDOG wordmark, service status dot only (no text), token countdown, theme toggle. Tenant, connection, git, patches all hidden. Overflow menu (⋯) appears — click to see hidden items in a dropdown | BAR-012 (resize up) |
| BAR-014 | Overflow menu open | Click ⋯ at <900px | Dropdown below top bar showing: Tenant selector, Connection status, Git info, Patch count as stacked rows. Same interactions as inline versions. Click outside or Escape closes | BAR-013 |

---

## 2. TENANT SELECTOR

### 2.1 Single Tenant (Default)

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TNT-001 | Single tenant, collapsed | Config loaded with one tenant | Clickable button: Tenant name "Admin1CBA" in medium weight + environment badge "FMLV08PPE" in small pill (var(--accent-dim) background). Chevron ▾ right of name. Cursor: pointer | TNT-010 (click) |
| TNT-002 | Single tenant, hover | Mouse enters tenant button | Background: var(--surface-2). Chevron animates subtle bounce. Tooltip after 500ms: "Switch tenant or add new" | TNT-010 (click) |
| TNT-003 | Single tenant, focus | Tab focuses tenant button | Focus ring: 2px solid var(--accent) with 2px offset. Screen reader: "Tenant: Admin1CBA, environment FMLV08PPE. Press Enter to open tenant menu" | TNT-010 (Enter) |

### 2.2 Dropdown Interactions

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TNT-010 | Dropdown open (single tenant) | Click tenant button or press Enter/Space when focused | Dropdown panel (240px wide, max-height 320px) slides down from button (150ms ease-out). Contains: current tenant row with green ● dot + name + env badge, divider, "+ Add tenant" row with dashed left border. Chevron rotates ▾ → ▴ | TNT-011, TNT-020, TNT-030 |
| TNT-011 | Dropdown open (multiple tenants) | Click tenant button when >1 tenants saved | Same dropdown but lists all tenants. Active tenant: green ● + bold name + env badge. Inactive tenants: grey ○ + regular weight name + env badge. Each row is 36px. Scrollable if >6 tenants. "+ Add tenant" at bottom below divider | TNT-012, TNT-013, TNT-020, TNT-030, TNT-040 |
| TNT-012 | Tenant row hover | Mouse enters inactive tenant row | Row background: var(--surface-2). "Switch to {name}" tooltip after 500ms. Row shows right-arrow icon (→) on hover, indicating switch action | TNT-020 (click) |
| TNT-013 | Tenant row context actions | Mouse enters any tenant row (including active) | Ellipsis button (⋯) appears at right end of row on hover. Click ellipsis: shows mini-menu with "Copy tenant ID" and "Remove tenant" (red text). Active tenant also shows "Set as default" | TNT-014, TNT-015, TNT-016 |
| TNT-014 | Copy tenant ID | Click "Copy tenant ID" from row ellipsis menu | Tenant ID copied to clipboard. Brief checkmark (✓) replaces ellipsis for 1.5s. Toast: "Tenant ID copied". Mini-menu closes | TNT-011 |
| TNT-015 | Remove tenant (confirm) | Click "Remove tenant" from row ellipsis menu | Row background turns red-tinted. Inline confirm: "Remove {name}?" [Remove] (red) [Cancel]. Cannot remove the active tenant — option greyed out with tooltip "Switch to another tenant first" | TNT-016, TNT-017 |
| TNT-016 | Remove tenant success | Click [Remove] in confirm | Row slides out left (200ms). Tenant removed from localStorage. If this was the last inactive tenant, dropdown shows single-tenant layout. Toast: "Removed {name}" with [Undo] (5s) | TNT-010 or TNT-011 |
| TNT-017 | Remove tenant cancelled | Click [Cancel] or Escape | Red tint removed. Row returns to normal | TNT-011 |
| TNT-018 | Dropdown keyboard navigation | Arrow keys while dropdown open | Down arrow: move highlight to next tenant row (wraps to "+ Add tenant"). Up arrow: move to previous. Highlighted row has var(--surface-3) background + left accent bar. Home/End jump to first/last. Currently focused item announced to screen reader | TNT-012, TNT-020, TNT-030 |
| TNT-019 | Dropdown dismiss | Click outside dropdown, press Escape, or Tab past last item | Dropdown slides up (150ms ease-in). Chevron rotates ▴ → ▾. Focus returns to tenant button | TNT-001 or TNT-002 |

### 2.3 Switch Tenant

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TNT-020 | Switch initiated | Click inactive tenant row or press Enter on highlighted row | Dropdown stays open. Clicked row shows spinner replacing the grey ○. All other rows disabled (opacity 50%). Tenant button text changes to "Switching..." Text in dropdown: "Re-authenticating..." below spinner | TNT-021, TNT-022 |
| TNT-021 | Switch success | Re-auth completes, new config loaded | Dropdown closes with slide-up. Tenant button updates to new tenant name + env badge. All top bar values refresh (service status, token, git, patches). Green flash on tenant button (200ms). Toast: "Switched to {name}". Dashboard reloads workspace tree | TNT-001, BAR-002 |
| TNT-022 | Switch failed (auth) | CBA/token acquisition fails for new tenant | Spinner replaced with red ✕ icon on the attempted row. Error text below row: "Authentication failed for {name}". [Retry] link. All rows re-enabled. Original tenant remains active (green ●). Toast: "Could not switch to {name}" | TNT-011 (retry or dismiss) |
| TNT-023 | Switch failed (network) | Network error during switch | Same as TNT-022 but error text: "Network error — check connection". [Retry] link | TNT-011 |
| TNT-024 | Switch failed (timeout) | Switch takes >15s | Spinner replaced with amber ⚠ icon. Error text: "Switch timed out". [Retry] link. Original tenant still active | TNT-011 |

### 2.4 Add Tenant

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TNT-030 | Add tenant start | Click "+ Add tenant" row | Row expands inline to show input form. Fields: Tenant Name (text input, required), Environment (text input, placeholder "e.g., FMLV08PPE"). [Save] (primary, disabled until name filled) [Cancel] (ghost). Keyboard: Enter submits, Escape cancels | TNT-031, TNT-032, TNT-033 |
| TNT-031 | Add tenant validation | User types in fields | Tenant Name: validates non-empty, no special chars except hyphens. Red border + "Invalid tenant name" if validation fails. [Save] enabled only when name passes validation | TNT-034, TNT-035 |
| TNT-032 | Add tenant cancelled | Click [Cancel] or press Escape | Form collapses back to "+ Add tenant" row. No data saved | TNT-010 or TNT-011 |
| TNT-033 | Add tenant saving | Click [Save] or press Enter | Inputs disabled. [Save] becomes spinner. "Validating tenant..." text. Backend attempts auth with new tenant credentials | TNT-034, TNT-035 |
| TNT-034 | Add tenant success | Auth succeeds for new tenant | Form collapses. New tenant row appears in list with slide-in animation. Grey ○ (inactive). Toast: "Added tenant {name}". User can now switch to it | TNT-011 |
| TNT-035 | Add tenant failed | Auth fails or tenant not found | Red border on inputs. Error text below form: "Could not authenticate with this tenant" or "Tenant not found". Inputs re-enabled. User can correct and retry | TNT-030 |
| TNT-036 | Add tenant duplicate | Name matches existing tenant | Inline error below name field: "Tenant '{name}' already exists". [Save] disabled | TNT-030 |

---

## 3. SERVICE STATUS

### 3.1 Status Indicator

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| SVC-001 | Stopped | Config reports `serviceStatus: "stopped"` or Phase 1 (disconnected) | Grey dot (var(--text-3)) + "Stopped" text in muted color. No uptime counter. Dot is static (no animation). Click: no action (status is informational) | SVC-002, SVC-003 |
| SVC-002 | Building | Config reports `serviceStatus: "building"` | Amber dot (var(--warning)) with CSS pulse animation (opacity 1→0.4→1, 1.5s infinite). "Building..." text in amber. No uptime counter. Elapsed build time appears after 5s: "Building... (12s)" | SVC-003, SVC-005 |
| SVC-003 | Running | Config reports `serviceStatus: "running"` + `serviceUptime` | Green dot (var(--success)) with subtle pulse animation (opacity 1→0.8→1, 2s infinite). "Running" text + uptime counter: "14m 22s". Counter updates every second via JS interval (not polling). Uptime resets when service restarts | SVC-001, SVC-004 |
| SVC-004 | Crashed | Config reports `serviceStatus: "crashed"` or connection lost after "running" | Red dot (var(--danger)) static. "Crashed" text in red. [Restart] ghost button appears inline, 4px left of text. Last uptime shown in muted text: "(was running 14m 22s)". Screen reader: "Service crashed. Restart button available" | SVC-006 |
| SVC-005 | Restarting | User clicks [Restart] or re-deploy triggers restart | Amber dot with fast pulse (0.8s). "Restarting..." text. [Restart] button disabled (opacity 50%). Spinner icon replaces dot during first 2s. Progress indication: "Stopping... → Building... → Starting..." text cycles | SVC-002, SVC-003, SVC-004 |
| SVC-006 | Restart initiated from crash | Click [Restart] in crashed state | Same as SVC-005 but with additional context: "(recovering from crash)" appended in muted text | SVC-002, SVC-003, SVC-004 |
| SVC-007 | Build slow (>60s) | Build phase exceeds 60 seconds | SVC-002 state but amber text changes to: "Building... (slow — 72s)" with amber background tint on the build time. Tooltip: "Build is taking longer than usual" | SVC-003, SVC-004 |
| SVC-008 | Uptime milestone | Uptime crosses 1h, 4h, 8h, 24h | Brief accent flash on uptime text (200ms). Format changes: <1h: "14m 22s", 1-24h: "1h 14m", >24h: "1d 2h". No toast (too noisy). Tooltip shows exact start time: "Running since 09:14:33 AM" | SVC-003 |
| SVC-009 | Status hover | Mouse over status zone | Tooltip with full detail: "Service: Running since 09:14:33 AM (14m 22s uptime). Process ID: 12847. Build: successful at 09:14:30 AM" | — |
| SVC-010 | Status unknown | Config poll failing, last status stale >30s | Grey dot. "Unknown" text in muted color. Tooltip: "Status unknown — server not responding" | SVC-001 through SVC-004 (on reconnect) |

---

## 4. CONNECTION INDICATOR

### 4.1 WebSocket Connection State

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| CON-001 | Connected | WebSocket open + polling healthy | Small green dot (6px) + "Connected" text in muted color. Dot is static (no pulse — don't waste attention on the expected state). Entire zone is low-prominence by design: good status should be invisible | CON-002, CON-003 |
| CON-002 | Disconnected | WebSocket closed + 3 consecutive poll failures | Red dot (6px) static + "Disconnected" text in red. Zone background: subtle red tint (var(--danger-dim)). Click zone: "Attempting reconnect..." and triggers immediate retry. Screen reader: "Server disconnected. Click to retry" | CON-003, CON-001 |
| CON-003 | Reconnecting | Auto-reconnect in progress (exponential backoff: 1s, 2s, 4s, 8s, max 30s) | Amber dot with pulse + "Reconnecting..." text. Attempt counter in muted text: "(attempt 3)". Animation: dot blinks. Click: forces immediate retry (resets backoff) | CON-001, CON-002 |
| CON-004 | Reconnect exhausted | 10 consecutive reconnect failures | Red dot static + "Disconnected" text. [Reconnect] button appears. Tooltip: "Automatic reconnection stopped after 10 attempts". Manual click required to restart reconnect cycle | CON-003 (click Reconnect) |
| CON-005 | Connection latency warning | Poll round-trip >2000ms for 3 consecutive polls | Green dot but with amber ring around it. "Connected (slow)" text. Tooltip: "Server responding slowly (avg 2.4s). Check network or server load" | CON-001 (latency normalizes) |

---

## 5. TOKEN HEALTH

### 5.1 Token Countdown States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| TKN-001 | No token | Phase 1 (disconnected) or config has no token | Grey pill (var(--surface-3) background). Text: "No token" in muted color. Pill is static, no countdown. Click: tooltip "Deploy to a lakehouse to acquire a token". Pill cursor: default (not clickable to inspector) | TKN-002 (on deploy) |
| TKN-002 | Healthy (>10 min) | Token expiry >10 minutes from now | Green pill (var(--success-dim) background, var(--success) text). Countdown: "42:18" (mm:ss format). Updates every second. Pill has subtle left border: 2px solid var(--success). Click: opens Token Inspector drawer (F10). Cursor: pointer | TKN-003, TKN-004, TKN-005 |
| TKN-003 | Warning (5–10 min) | Token expiry between 5 and 10 minutes | Amber pill (var(--warning-dim) background, var(--warning) text). Countdown continues: "7:14". Left border: 2px solid var(--warning). Transition from green → amber is smooth (background-color transition 500ms). First transition triggers subtle pulse (1 cycle) to draw attention | TKN-004 |
| TKN-004 | Critical (<5 min) | Token expiry <5 minutes | Red pill (var(--danger-dim) background, var(--danger) text). Countdown: "2:48". Left border: 2px solid var(--danger). CSS pulse animation on pill (scale 1→1.02→1, 2s infinite). Transition from amber → red triggers 2 fast pulses. Screen reader announcement: "Token expiring in less than 5 minutes" | TKN-005 |
| TKN-005 | Expired | Countdown reaches 0:00 | Red pill with stronger pulse (scale 1→1.04→1, 1.2s infinite). Text: "Expired" (replaces countdown). Background: var(--danger) solid (not dim). Text: white. Click: triggers token refresh flow. Cursor: pointer. Screen reader: "Token expired. Click to refresh" | TKN-006 |
| TKN-006 | Refreshing | Click expired pill, or auto-refresh triggered | Pill background: var(--surface-3). Spinner icon (12px) replaces countdown text. Text: "Refreshing..." in muted color. Pulse animation stops. Pill is non-interactive during refresh (cursor: wait) | TKN-002 (success), TKN-007 (failure) |
| TKN-007 | Refresh failed | Token refresh API returns error | Red pill. Text: "Refresh failed". Pulse resumes. Click: retry refresh. Toast: "Could not refresh token: {error}". If auth is completely broken: shows "Re-authenticate" link that triggers full re-auth flow | TKN-006 (retry), TNT-020 (re-auth) |
| TKN-008 | Token refreshed (reset) | Refresh succeeds, new expiry received | Pill transitions to green. Countdown restarts with new expiry. Brief green flash (200ms) on pill. Toast: "Token refreshed — expires in {time}" | TKN-002 |
| TKN-009 | Token Inspector open | Click healthy/warning/critical pill | Token Inspector drawer (F10) slides in from right. Pill gets active state: accent bottom border, slightly elevated (box-shadow). Click pill again: closes drawer | F10-* |
| TKN-010 | Countdown format edge | Exactly 10:00 or 5:00 remaining | At 10:00.0: color stays green (≥10 means green). At 9:59: transitions to amber. At 5:00.0: stays amber. At 4:59: transitions to red. Boundary is exclusive on the low side | TKN-003, TKN-004 |
| TKN-011 | Multiple tokens | Config provides both bearer + MWC tokens | Pill shows the token expiring soonest. Dot indicator inside pill: split dot (half green / half amber) if tokens have different health. Click → Token Inspector shows both. Tooltip: "Bearer: 42:18 | MWC: 8:12" | TKN-009 |

---

## 6. FILE CHANGE BANNER

### 6.1 Detection & Display

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FCB-001 | No changes detected | Normal state, watchdog reports no changes | Banner is hidden: height 0, overflow hidden. Top bar bottom border is the visual boundary. No DOM removal — banner element exists but collapsed for instant animation | FCB-002 |
| FCB-002 | Single file changed | Watchdog detects 1 C# file changed (not an EDOG patch file) | Banner slides down from below top bar (200ms ease-out, transform: translateY). Height: 36px. Layout: amber left border (3px solid var(--warning)) + file icon + "File changed: GTSBasedSparkClient.cs" + spacer + [Re-deploy] (primary small) + [Dismiss] (ghost small). Banner background: var(--warning-dim) | FCB-004, FCB-005, FCB-006 |
| FCB-003 | Multiple files changed | Watchdog detects 2+ files changed | Banner text: "3 files changed" as clickable/expandable link. Click text → expands to show file list below banner (one file per row, max 5 visible, scroll if more). Each file row: relative path + "modified" or "added" or "deleted" badge. Collapse on second click | FCB-004, FCB-005, FCB-006, FCB-007 |
| FCB-004 | Re-deploy clicked | Click [Re-deploy] | [Re-deploy] button shows spinner + "Deploying...". [Dismiss] disabled. Banner text changes to: "Re-deploying with changes...". Progress updates: "Stopping... → Building... → Starting...". Service status (SVC-*) also updates | FCB-008, FCB-009 |
| FCB-005 | Dismissed | Click [Dismiss] | Banner slides up (200ms ease-in). Changes are still tracked internally. Badge appears on EDOG wordmark: small amber dot indicating "dismissed changes pending". Tooltip on wordmark: "1 dismissed change — files may be out of sync" | FCB-010 |
| FCB-006 | Banner keyboard interaction | Tab reaches banner buttons | [Re-deploy] and [Dismiss] are in tab order (inserted after connection indicator). Focus ring on active button. Enter/Space activates. Escape dismisses (same as [Dismiss] click) | FCB-004, FCB-005 |
| FCB-007 | File list expanded | Click "3 files changed" text | File list panel drops below banner (max-height animation 200ms). Lists: `src/WorkloadApp.cs (modified)`, `src/GTSBasedSparkClient.cs (modified)`, `src/NewFile.cs (added)`. Each row is 28px. Click file row: no action (informational). Close: click text again or Escape | FCB-003 |

### 6.2 Re-deploy Flow States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| FCB-008 | Re-deploy success | Build + restart completes | Banner text: "Re-deployed successfully" with green left border (replaces amber). Text shows for 3 seconds, then banner slides up. Change tracking resets. Service status returns to SVC-003 | FCB-001 |
| FCB-009 | Re-deploy failed | Build or restart fails | Banner left border turns red. Text: "Re-deploy failed: {error}". [Retry] button replaces [Re-deploy]. [Dismiss] re-enabled. Error stays until user acts. Toast with full error detail | FCB-004 (retry), FCB-005 (dismiss) |
| FCB-010 | New changes after dismiss | Watchdog detects additional changes after dismiss | Banner reappears (slides down). Updated count: "2 files changed (1 previously dismissed)". Amber left border. Both [Re-deploy] and [Dismiss] available. Previously dismissed changes included in re-deploy | FCB-004, FCB-005 |
| FCB-011 | Changes during re-deploy | New file changes detected while re-deploy in progress | Changes queued silently. After current re-deploy completes (success or fail), banner reappears with new changes: "New changes detected during re-deploy: {files}". [Re-deploy] available again | FCB-002, FCB-003 |
| FCB-012 | EDOG patch file changed | Change detected in a known EDOG patch file | Change is filtered out — banner does NOT appear. Console log: "Ignoring change to EDOG patch file: {path}". Only user/FLT code changes trigger the banner | FCB-001 |
| FCB-013 | Rapid file changes | Multiple changes within 2s debounce window | Changes batched. Banner shows only after 2s of quiet. File count reflects all changes in the batch. Avoids banner flickering during save-all or branch switch | FCB-002, FCB-003 |

---

## 7. GIT INFO

### 7.1 Branch & Dirty State

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| GIT-001 | No git repo | FLT directory is not a git repository | Text: "—" in muted color. Tooltip: "Not a git repository". No click action. Git zone takes minimal width | — |
| GIT-002 | On branch, clean | Git reports branch name, 0 dirty files | Branch icon (fork glyph, 12px) + branch name in regular text. E.g., "main" or "feature/dag-parallel-execution". Long names truncated with ellipsis at 180px max-width. Tooltip shows full name. Click: copies branch name to clipboard | GIT-003, GIT-004 |
| GIT-003 | On branch, dirty | Git reports branch name + N dirty files (modified/untracked/staged combined) | Branch name + small badge right of name: "+3" in accent pill (var(--accent-dim) background, var(--accent) text, border-radius: 8px, min-width: 20px). Tooltip: "3 uncommitted files". Click badge: shows file list in small dropdown (max 10 files, path + status icon). Click branch name: copies to clipboard | GIT-002 (after commit) |
| GIT-004 | Detached HEAD | Git reports detached HEAD at commit | Text: "detached at abc1234" (first 7 chars of SHA) in amber text with ⚠ icon prefix. Tooltip: "HEAD is detached at abc12345678. You are not on a branch." Amber color signals unusual state. Click: copies full SHA | GIT-002 (checkout branch) |
| GIT-005 | Git info loading | Initial load or polling refresh | Brief shimmer on git text (200ms). If git command takes >1s: show "..." placeholder. Old value kept until new value arrives (no flicker) | GIT-002, GIT-003, GIT-004 |
| GIT-006 | Git info poll | Every 30s interval | Git status re-checked via backend. If branch or dirty count changed: text updates with subtle crossfade (200ms). No animation if unchanged. Console log: "Git poll: {branch} +{dirty}" | GIT-002, GIT-003, GIT-004 |
| GIT-007 | Git dirty list hover | Hover on "+3" badge (GIT-003) | After 500ms, dropdown appears below badge showing dirty file list. Each row: status icon (M=modified, A=added, D=deleted, ?=untracked) + relative file path. Max 10 rows, scroll if more. "View all in terminal" link at bottom. Dropdown dismisses on mouse leave (300ms delay) or Escape | GIT-003 |
| GIT-008 | Branch name copied | Click branch name text | Name copied to clipboard. Brief checkmark (✓) appears next to branch name for 1.5s, replacing the branch icon. Toast: "Branch name copied" | GIT-002, GIT-003 |
| GIT-009 | Git error | Git command fails (e.g., corrupted repo) | Text: "git error" in red muted text. Tooltip: "Could not read git status: {error}". Auto-retries on next poll cycle | GIT-001 through GIT-004 (on recovery) |

---

## 8. PATCH COUNT

### 8.1 Patch Display

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| PAT-001 | No patches | Config reports `patchCount: 0` | Text: "0 patches" in muted color (var(--text-3)). No pill background. Low visual weight — zero is the uninteresting state. Click: opens patch list dropdown (empty state) | PAT-004 |
| PAT-002 | Patches applied | Config reports `patchCount: N` where N > 0 | Accent pill: "6 patches" with var(--accent-dim) background, var(--accent) text. Pill has border-radius: 12px, padding: 2px 8px. Click: opens patch list dropdown. Cursor: pointer. Tooltip: "6 EDOG patches applied to FLT codebase" | PAT-003 |
| PAT-003 | Patch list dropdown | Click patch pill | Dropdown (280px wide, max-height 240px) below pill. Header: "Applied Patches" in bold. List of patched files, each row: file icon + relative path + patch type badge ("interceptor", "config", "startup"). Divider + "These patches are managed by EDOG" footer text in muted. Click outside or Escape closes | PAT-001, PAT-002 |
| PAT-004 | Patch list empty | Click "0 patches" text | Dropdown shows: empty state icon + "No patches applied" + "Deploy to a lakehouse to apply EDOG patches" muted text | PAT-001 |
| PAT-005 | Patch count changed | Re-deploy applies/removes patches, config reports new count | Pill text updates. If count increased: brief green flash on pill (200ms). If decreased: brief amber flash. Number animates (old → new with crossfade, 200ms) | PAT-002 |
| PAT-006 | Patch file in dirty list | A patched file also appears in git dirty files | Patch pill shows small warning indicator (amber dot on pill corner). Tooltip: "1 patched file has been manually modified". This warns that manual edits to EDOG-patched files may conflict | PAT-002 |

---

## 9. THEME TOGGLE

### 9.1 Theme States

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| THM-001 | Light mode active | `data-theme="light"` on body | Sun icon (☀ or inline SVG, 16px) in the toggle button. Button: 28px × 28px, border-radius: 6px, var(--surface-2) background. Icon color: var(--text-2). Tooltip: "Switch to dark mode" | THM-003 (click) |
| THM-002 | Dark mode active | `data-theme="dark"` on body | Moon icon (☽ or inline SVG, 16px). Same button dimensions. Tooltip: "Switch to light mode" | THM-003 (click) |
| THM-003 | Theme transitioning | Click toggle button | All CSS custom properties swap simultaneously. Transition: `background-color 150ms ease, color 150ms ease, border-color 150ms ease` on `*` selector. Icon crossfades: old icon scales down + fades (100ms), new icon scales up + fades in (100ms). No layout shift. `localStorage.setItem('edog-theme', 'dark')` persists choice | THM-001, THM-002 |
| THM-004 | First load (system preference) | No localStorage theme set on page load | Check `window.matchMedia('(prefers-color-scheme: dark)')`. If system prefers dark: start in dark mode. If light or no preference: start in light mode. No transition animation on first load (instant apply). Set `data-theme` before first paint to avoid flash of wrong theme | THM-001, THM-002 |
| THM-005 | System preference changes | OS theme changes while page is open | If user has NOT manually toggled (no localStorage value): follow system preference automatically, with 150ms transition. If user HAS manually toggled: ignore system change (user's explicit choice wins) | THM-001, THM-002 |
| THM-006 | Toggle hover | Mouse enters toggle button | Background: var(--surface-3). Icon color: var(--text-1). Scale: 1.05 (subtle grow, 100ms). Cursor: pointer | THM-003 (click) |
| THM-007 | Toggle focus | Tab focuses toggle button | Focus ring: 2px solid var(--accent) with 2px offset. Screen reader: "Theme toggle. Currently {light/dark} mode. Press Enter to switch" | THM-003 (Enter/Space) |
| THM-008 | Toggle keyboard | Enter or Space on focused toggle | Same as THM-003. Focus ring remains visible after switch. Announce to screen reader: "Switched to {dark/light} mode" | THM-001, THM-002 |

---

## 10. EDOG WORDMARK

### 10.1 Brand Zone

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| WMK-001 | Default | Page loaded, server healthy | "EDOG" text in brand font, 600 weight, var(--text-1) color. 16px font-size. No click action — purely brand identity. Left-most element with 12px left padding | — |
| WMK-002 | Server error indicator | Config load failed (BAR-003) | Red dot (4px) appears top-right of wordmark (absolute positioned). Tooltip: "Cannot reach EDOG server". Dot pulses subtly (2s cycle). Dot disappears when connection restores | WMK-001 (on reconnect) |
| WMK-003 | Dismissed changes indicator | File changes dismissed (FCB-005) | Amber dot (4px) appears top-right of wordmark. Tooltip: "Dismissed file changes pending — files may be out of sync". Dot disappears when changes are re-deployed or new banner appears | WMK-001 (on re-deploy) |
| WMK-004 | Both indicators | Server error + dismissed changes simultaneously | Red dot takes priority (server error is more critical). Amber dot hidden. Only one indicator dot shown at a time. Priority order: red (error) > amber (warning) | WMK-001 |

---

## 11. KEYBOARD & ACCESSIBILITY

### 11.1 Tab Order

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| A11Y-001 | Tab sequence | Tab key pressed from before top bar | Focus moves through top bar in logical order: (1) Tenant selector → (2) Service status zone (if restart button visible) → (3) Connection indicator (if reconnect button visible) → (4) Token pill → (5) Git branch → (6) Patch pill → (7) Theme toggle. Skip non-interactive elements. Tab past theme toggle exits top bar to main content | — |
| A11Y-002 | Focus visible | Any element receives keyboard focus | 2px solid var(--accent) focus ring with 2px offset (outline-offset). Glow: box-shadow: 0 0 0 4px var(--accent-dim). High contrast against both light and dark backgrounds. Never hidden by overflow or z-index issues | — |
| A11Y-003 | Skip link | Page load, Tab is first keypress | "Skip to main content" link appears (visually hidden until focused). Activating jumps focus past top bar + sidebar to main panel. Standard accessibility pattern | — |
| A11Y-004 | Screen reader: service status | Screen reader encounters status zone | Announces: "Service {status}." If running: "Service running for {uptime}." If crashed: "Service crashed. Restart button available." Live region (aria-live="polite") updates when status changes — no announcement on every uptime tick | — |
| A11Y-005 | Screen reader: token | Screen reader encounters token pill | Announces: "Token expires in {minutes} minutes {seconds} seconds." or "Token expired. Activate to refresh." aria-live="assertive" only on state transitions (green→amber, amber→red, expired). Countdown ticks are NOT announced (too noisy) | — |
| A11Y-006 | Screen reader: git | Screen reader encounters git zone | Announces: "Git branch: {name}." If dirty: "Git branch: {name}. {N} uncommitted files." If detached: "Detached HEAD at {sha}." | — |
| A11Y-007 | Screen reader: banner | File change banner appears | aria-live="polite" announcement: "{N} files changed. Re-deploy or dismiss." Banner is a role="alert" region. [Re-deploy] and [Dismiss] are labeled buttons | — |
| A11Y-008 | Reduced motion | `prefers-reduced-motion: reduce` media query | All pulse animations disabled (dot is static colored). Theme transition instant (0ms instead of 150ms). Banner slides replaced with instant show/hide. Countdown still ticks (functional, not decorative). Token pill scale pulse disabled | — |
| A11Y-009 | High contrast mode | Windows High Contrast Mode or forced-colors | All dot indicators use system colors (CanvasText, LinkText, etc.). Pill backgrounds use system highlight. Focus rings use Highlight color. Icon-only buttons get visible text labels. Borders become 2px for visibility | — |
| A11Y-010 | Keyboard: Escape patterns | Escape pressed while dropdown/panel open | Closes innermost open overlay: tenant dropdown → file list → patch list → git dirty list. After all overlays closed, Escape has no effect (doesn't exit top bar). Focus returns to the trigger element that opened the overlay | — |

### 11.2 Touch & Pointer

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| A11Y-011 | Touch targets | Touch device detected (pointer: coarse) | All interactive elements enforce minimum 44px × 44px touch target (matching top bar height). Padding expanded on pills and toggle to meet target. No visual change — only hit area expands | — |
| A11Y-012 | Hover → touch adaptation | No hover capability (`hover: none`) | All hover-triggered tooltips become tap-and-hold (500ms long press). Dirty file dropdown triggered by tap (not hover). Ellipsis menus in tenant dropdown always visible (not hover-revealed) | — |

---

## 12. CROSS-CUTTING & EDGE CASES

### 12.1 Timing & Synchronization

| ID | State | Trigger | What User Sees | Next States |
|----|-------|---------|----------------|-------------|
| EDGE-001 | Token expires during tenant switch | Token countdown hits 0 while TNT-020 in progress | Tenant switch continues (uses new auth flow). Token pill shows "Expired" but does not trigger refresh (switch will provide new token). If switch succeeds: new token resets countdown. If switch fails: expired token state remains | TKN-005, TNT-021 |
| EDGE-002 | File changes during tenant switch | Watchdog detects changes during TNT-020 | Changes queued. Banner does NOT appear during switch (would be confusing). After switch completes: if changes still relevant to new tenant's deployment, banner appears. If not (different workspace): changes discarded | FCB-001, FCB-002 |
| EDGE-003 | Rapid re-deploy clicks | User clicks [Re-deploy] multiple times quickly | First click starts deploy. Button immediately disables (pointer-events: none + opacity 50%). Subsequent clicks ignored. Debounce: 500ms after button shows | FCB-004 |
| EDGE-004 | Theme toggle during transition | User clicks theme toggle while 150ms transition is in progress | Second click queued. After current transition completes (150ms), toggle back begins. Net effect: brief flash then return to original theme. No broken intermediate state | THM-003 |
| EDGE-005 | Multiple overlays | User opens tenant dropdown, then tabs to git and opens dirty list | Only one dropdown open at a time. Opening a new dropdown closes the previous one (no stacking). Focus moves to newly opened dropdown. Previous dropdown's trigger returns to default state | — |
| EDGE-006 | Config changes during dropdown | Config poll updates tenant list while tenant dropdown is open | Dropdown content updates in-place without closing. New tenant appears with slide-in. Removed tenant fades out. Active tenant indicator updates. No jarring close/reopen | TNT-011 |
| EDGE-007 | Page visibility hidden | User switches browser tab | All polling pauses (clearInterval). Token countdown pauses. When tab becomes visible again: immediate config poll + countdown recalculation from server time (not local clock drift). Uptime recalculates from server uptime value | BAR-002 |
| EDGE-008 | Clock skew | Local clock differs from server by >30s | Token countdown based on server-provided expiry minus server-provided current time, then local countdown from that delta. Avoids "token expired" showing when server says 40 minutes left. Console warning: "Clock skew detected: {delta}ms" | TKN-002 through TKN-005 |
| EDGE-009 | localStorage unavailable | Private browsing or storage quota exceeded | Theme defaults to system preference. No persistence (each load checks system pref). Tenant list stored in memory only (lost on refresh). Console warning: "localStorage unavailable — preferences will not persist". No user-facing error | THM-004 |
| EDGE-010 | Concurrent sessions | Two browser tabs open to same EDOG instance | Each tab runs independent polling. Actions in one tab (restart, re-deploy, theme toggle) don't sync to other tabs. Each tab shows correct state from its own polling. localStorage theme change triggers `storage` event → other tabs update theme in real-time | — |
| EDGE-011 | Very long branch name | Branch name >40 characters | Text truncated with ellipsis at 180px max-width (CSS text-overflow: ellipsis). Full name in tooltip. Click still copies full name. No layout shift or overflow into adjacent zones | GIT-002 |
| EDGE-012 | Zero-width top bar zones | All optional zones hidden at <900px | Remaining zones (brand + status + token + theme) distribute evenly with flex. Gap: 12px between zones. No zone overlaps. Brand stays left-aligned, theme stays right-aligned, status + token center | BAR-013 |

---

## State Count Summary

| Category | State Range | Count |
|----------|-------------|-------|
| Top Bar Container | BAR-001 → BAR-014 | 14 |
| Tenant Selector | TNT-001 → TNT-036 | 30 |
| Service Status | SVC-001 → SVC-010 | 10 |
| Connection Indicator | CON-001 → CON-005 | 5 |
| Token Health | TKN-001 → TKN-011 | 11 |
| File Change Banner | FCB-001 → FCB-013 | 13 |
| Git Info | GIT-001 → GIT-009 | 9 |
| Patch Count | PAT-001 → PAT-006 | 6 |
| Theme Toggle | THM-001 → THM-008 | 8 |
| EDOG Wordmark | WMK-001 → WMK-004 | 4 |
| Accessibility | A11Y-001 → A11Y-012 | 12 |
| Edge Cases | EDGE-001 → EDGE-012 | 12 |
| **Total** | | **134** |

---

## Implementation Priority

| Priority | States | Rationale |
|----------|--------|-----------|
| P0 (MVP) | BAR-001–003, SVC-001–003, TKN-001–005, THM-001–004, GIT-001–003 | Core status visibility. Engineers need this day one |
| P1 (Fast follow) | TNT-001–002, TNT-010, TNT-020–021, CON-001–002, PAT-001–002, FCB-001–002, A11Y-001–007 | Multi-tenant, connection awareness, file change detection |
| P2 (Polish) | TNT-003–036, SVC-004–010, TKN-006–011, FCB-003–013, GIT-004–009, PAT-003–006, THM-005–008, WMK-001–004, A11Y-008–012, BAR-010–014 | Full interaction depth, edge cases, responsive, a11y |
| P3 (Edge) | EDGE-001–012 | Concurrent sessions, clock skew, rapid interactions |

---

## CSS Custom Properties Used

```css
/* Status dots */
--success: oklch(0.72 0.19 142);     /* green — running, connected, healthy */
--warning: oklch(0.75 0.18 85);      /* amber — building, warning, 5-10min */
--danger:  oklch(0.63 0.24 29);      /* red — crashed, expired, <5min */

/* Pill backgrounds (dimmed variants) */
--success-dim: oklch(0.72 0.19 142 / 0.12);
--warning-dim: oklch(0.75 0.18 85 / 0.12);
--danger-dim:  oklch(0.63 0.24 29 / 0.12);

/* Surfaces */
--surface-1: /* top bar background */
--surface-2: /* hover background */
--surface-3: /* active/pressed background */

/* Typography */
--text-1: /* primary text */
--text-2: /* secondary text */
--text-3: /* muted/disabled text */

/* Accent */
--accent:     /* brand accent for focus rings, active states */
--accent-dim: /* accent at 12% opacity for pill backgrounds */

/* Borders */
--border-1: /* subtle dividers */
```

---

## Animation Inventory

| Animation | Duration | Easing | Used In |
|-----------|----------|--------|---------|
| Pulse (dot) | 2s infinite | ease-in-out | SVC-003, TKN-004–005, CON-003 |
| Fast pulse (dot) | 0.8s infinite | ease-in-out | SVC-005 |
| Dropdown slide down | 150ms | ease-out | TNT-010, GIT-007, PAT-003 |
| Dropdown slide up | 150ms | ease-in | TNT-019 (dismiss) |
| Banner slide down | 200ms | ease-out | FCB-002 |
| Banner slide up | 200ms | ease-in | FCB-005, FCB-008 |
| Theme transition | 150ms | ease | THM-003 |
| Icon crossfade | 100ms | ease | THM-003 |
| Green flash | 200ms | ease-out | BAR-007, TNT-021, TKN-008, PAT-005 |
| Shimmer | 1.5s infinite | linear | BAR-001, GIT-005 |
| Pill scale pulse | 2s infinite | ease-in-out | TKN-004 (1→1.02), TKN-005 (1→1.04) |
| Chevron rotate | 150ms | ease | TNT-010, TNT-019 |
| Row slide out | 200ms | ease-in | TNT-016 |
| Crossfade (data update) | 200ms–300ms | ease | BAR-002, GIT-006, PAT-005 |
