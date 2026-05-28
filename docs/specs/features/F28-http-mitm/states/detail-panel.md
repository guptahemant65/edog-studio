# F28 — Detail Panel State Matrix

> **Component:** Detail Panel (right side of HTTP MITM tab, optionally detachable to modal)
> **Feature:** F28 HTTP MITM (simplified scope: MITM + Send to API Playground)
> **Author:** Pixel
> **Phase:** P3 — State Matrices
> **Surface:** `src/frontend/js/tab-http.js` `_buildDetailPanel` / `_renderDetail` extensions, `src/frontend/css/tab-http.css`
> **Sources:** C04 §4–§6, mock `http-mitm.html` lines 555–595 (detailPanel + detailFooter + modal), P0 §1.6 / §2.1

---

## 0. Scope

The Detail Panel is the right-hand inspector that owns:

- **Request / Response / Timing / Headers** read-only viewers (existing, extended).
- **Intercept editing surface** when a request is paused at a breakpoint (request body, request headers, URL, method).
- **Forge composer** when the user is constructing a synthetic response.
- The footer's **Forward / Drop / Send to Playground** decision triumvirate.
- **Detach-to-modal** affordance — the same body content rendered in a draggable modal window.

State IDs use `detail.<area>.<state>`. The top-level region is `detail.lifecycle.*` (closed / sliding-in / open / closing). Within `open`, two orthogonal sub-states compose: the **tab** (`detail.tab.*`) and the **mode** (`detail.mode.*`). Modal detachment lives in `detail.shell.*`.

---

## 1. State Map

```
┌─ detail.lifecycle ────────────────────────────────────────────────────┐
│   closed → sliding-in → open → closing → closed                       │
│            ↘ aborted (selection changed mid-animation)                 │
└────────────────────────────────────────────────────────────────────────┘
┌─ detail.shell (only when open) ───────────────────────────────────────┐
│   docked → detaching → modal.floating → modal.dragging → docked        │
│                     ↘ modal.maximized                                  │
└────────────────────────────────────────────────────────────────────────┘
┌─ detail.tab (only when open) ─────────────────────────────────────────┐
│   request | response | timing | headers | intercept (F28)              │
└────────────────────────────────────────────────────────────────────────┘
┌─ detail.mode (only when tab=intercept) ───────────────────────────────┐
│   view-only → editing.url → editing.headers → editing.body →           │
│   forge.composing → decision-pending → resolved                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Lifecycle States (`detail.lifecycle.*`)

### 2.1 `detail.lifecycle.closed`

- **Entry conditions:** Default at tab load; user clicked `[✕]`; `Esc` while not in paused-intercept mode; selection cleared in traffic list.
- **Exit conditions:** Row selected in traffic list → enters `sliding-in`.
- **Visual:** Detail panel hidden (CSS `flex-basis: 0`, `display: none` on inner content). Resize handle hidden.
- **Keyboard:** N/A (panel is not focusable when closed).
- **Data requirements:** None — no row context loaded.
- **Transitions:** Row click → `sliding-in`.
- **Error recovery:** N/A.

### 2.2 `detail.lifecycle.sliding-in`

- **Entry conditions:** First row select since the panel was last closed.
- **Exit conditions:** 180ms animation completes → `open`; selection cleared mid-animation → `aborted`.
- **Visual:** Panel slides from right edge: `transform: translateX(8px) → 0`, `opacity: 0 → 1`, easing `cubic-bezier(0.2, 0.8, 0.2, 1)`. Tab strip indicator slides to default tab. Body content rendered behind a `[Loading…]` placeholder for the first 50ms if the row payload is large.
- **Keyboard:** Inert during animation. Buffered keystrokes process on `open`.
- **Data requirements:** Row snapshot in memory. If row is paused, `_pausedSnapshots.get(interceptId)` retrieved.
- **Transitions:** Animation `transitionend` → `open`. Selection mid-animation → `aborted`.
- **Error recovery:** If animation API unavailable (older browser), CSS `prefers-reduced-motion` style applies — opacity 0→1 only, no slide.

### 2.3 `detail.lifecycle.open`

- **Entry conditions:** Slide-in completed.
- **Exit conditions:** `Esc` (when no paused decision pending); `[✕]` button; row deselected; tab destroyed.
- **Visual:** Full panel visible, default `flex-basis: 45%` (overridable by resize). Header shows request title; tab strip below; body fills remaining height; footer pinned at bottom (only visible when row is paused — see §3.2 footer).
- **Keyboard:** Tab strip arrows navigate tabs; content shortcuts depend on active tab and mode.
- **Data requirements:** Row snapshot; for paused rows, `_pausedSnapshots` entry; for resolved MITM rows, modification diff cached on row.
- **Transitions:**
  - Selection changes to another row → re-render in place (no slide-out).
  - `[✕]` → `closing`.
  - Detach button → enters `detail.shell.detaching`.
- **Error recovery:** If row drops from buffer (rare), panel transitions to a tombstone view: *"This request is no longer in the buffer."* with `[Close]`.

### 2.4 `detail.lifecycle.closing`

- **Entry conditions:** `[✕]`, `Esc` (non-paused), row deselected, tab switch away from HTTP.
- **Exit conditions:** 140ms animation completes → `closed`.
- **Visual:** Reverse slide: `translateX(0 → 8px)`, `opacity: 1 → 0`. Detail tab indicator fades.
- **Keyboard:** Inert.
- **Data requirements:** Snapshot retained (instant re-open is possible without re-fetch).
- **Transitions:** `transitionend` → `closed`. New row click during close → cancel close → `sliding-in` (with the new row).
- **Error recovery:** N/A.

### 2.5 `detail.lifecycle.aborted`

- **Entry conditions:** Selection cleared during `sliding-in`.
- **Exit conditions:** Immediate → `closing` (skipping the in-animation).
- **Visual:** Panel snaps to opacity 0 over 80ms (faster than normal close).
- **Keyboard:** Inert.
- **Data requirements:** N/A.
- **Transitions:** → `closed`.
- **Error recovery:** N/A.

---

## 3. Tab Sub-states (`detail.tab.*`)

These compose with `detail.lifecycle.open`.

### 3.1 `detail.tab.request` (default)

- **Entry conditions:** Default tab on open for non-paused rows; click `Request` tab.
- **Exit conditions:** Click another tab; programmatic switch (paused row auto-switches to `intercept`).
- **Visual:**
  ```
  ┌──────────────────────────────────────────────────────────────┐
  │  Request   Response   Timing   Headers   [Intercept]    [✕] │
  │  ▔▔▔▔▔▔▔                                                     │  ← indicator
  ├──────────────────────────────────────────────────────────────┤
  │  Endpoint                                                     │
  │    POST  https://api.fabric.microsoft.com/v1/.../sessions     │
  │                                                                │
  │  Request Headers (5 headers)                                  │
  │    Authorization:    [redacted]                               │
  │    Content-Type:     application/json                         │
  │    x-ms-correlation-id: f9b4c0e3-5d6a                         │
  │  …                                                             │
  │  Request Body                                                 │
  │  ┌──────────────────────────────────────────────────────────┐│
  │  │ {                                                         ││
  │  │   "name": "flt-materialization-session",                  ││
  │  │   "driverMemory": "8g"                                    ││
  │  │ }                                                         ││
  │  └──────────────────────────────────────────────────────────┘│
  └──────────────────────────────────────────────────────────────┘
  ```
- **Keyboard:** `Tab` cycles between sections; `Ctrl+C` copies focused JSON region; `Ctrl+Shift+C` copies as cURL.
- **Data requirements:** `req.url`, `req.method`, `req.requestHeaders`, `req.requestBodyPreview` (4KB or full 10MB for paused rows).
- **Transitions:** Tab strip → other tab; row paused → auto-switch to `intercept`.
- **Error recovery:** If body parse fails (not JSON), fallback to plain pre-block. If body > 10MB cap, render warning banner.

### 3.2 `detail.tab.response`

- **Entry conditions:** Click `Response` tab; some workflows auto-select it (e.g., replay result).
- **Exit conditions:** Other tab click.
- **Visual:** Status line `200 OK · 142ms · 8.2 KB`, response headers list, response body with JSON highlight (reuses `_renderResponseTab` / `_jsonHighlight`).
- **Keyboard:** Same content shortcuts as Request tab.
- **Data requirements:** `req.statusCode`, `req.responseHeaders`, `req.responseBodyPreview`, `req.durationMs`.
- **Transitions:** Tab strip.
- **Error recovery:** If response is missing (paused / blocked / timeout), render placeholder *"No response captured (request was {paused|blocked|timed-out})."*

### 3.3 `detail.tab.timing`

- **Entry conditions:** Click `Timing` tab.
- **Exit conditions:** Other tab click.
- **Visual:** Waterfall with DNS / Connect / TLS / Request / Response phases, color-coded bars. Total duration headline.
- **Keyboard:** N/A.
- **Data requirements:** `req.timing` object.
- **Transitions:** Tab strip.
- **Error recovery:** If timing data absent (e.g., synthesized/forged responses), show `"Timing unavailable for synthesized responses."`

### 3.4 `detail.tab.headers`

- **Entry conditions:** Click `Headers` tab.
- **Exit conditions:** Other tab click.
- **Visual:** Two-pane: request headers (left), response headers (right). Auth-redacted values dimmed and tagged `[redacted]`. Search input filters both panes.
- **Keyboard:** `Ctrl+F` focuses header search (locally scoped).
- **Data requirements:** Both header maps.
- **Transitions:** Tab strip.
- **Error recovery:** N/A.

### 3.5 `detail.tab.intercept`

- **Entry conditions:**
  - Selected row has `mitmTag === 'paused'` → auto-selected (`attention-pulse` animation 800ms).
  - Selected row has `mitmTag in {modified, blocked, forged, replayed}` → tab visible but not auto-selected.
  - User clicks the Intercept tab.
- **Exit conditions:** Click another tab; row becomes a row without MITM lifecycle (tab hidden again).
- **Visual:** Hero card with paused request snapshot + Forward / Drop / Send-to-Playground / (Forge) controls. See `detail.mode.*` for content variation.
- **Keyboard:** Mode-dependent (see §4).
- **Data requirements:** `_pausedSnapshots.get(interceptId)` for paused; row-cached `mitmModifications` for resolved.
- **Transitions:** → mode sub-states (§4).
- **Error recovery:** If intercept resolved between snapshot fetch and render, show *"Already resolved — see audit summary."*

---

## 4. Mode Sub-states (`detail.mode.*`) — only when `tab=intercept`

### 4.1 `detail.mode.view-only`

- **Entry conditions:** Row has resolved MITM lifecycle (`mitmTag !== 'paused'`).
- **Exit conditions:** Click `[↻ Re-arm]` or `[↻ Replay with edits]`; navigate away.
- **Visual:** Audit summary card (C04 §4.3):
  ```
  ┌──────────────────────────────────────────────────────────────┐
  │ ✎  MODIFIED — Forwarded                                       │
  │ ────────────────────────────────────────────────────────────  │
  │  POST  /api/v1/workspaces/.../sessions                        │
  │  Decided 4.2s after pause                                     │
  │                                                                │
  │  Modifications applied:                                       │
  │    ▲ headers["x-test-flag"] = "true"  (added)                 │
  │    ▼→▲ body $.driverMemory: "8g" → "16g"                       │
  │                                                                │
  │  [ ↻ Re-arm same rule ]    [ ↻ Replay with these edits ]      │
  └──────────────────────────────────────────────────────────────┘
  ```
- **Keyboard:** `Shift+R` re-arms.
- **Data requirements:** `req.mitmModifications` array, `req.url`, `req.method`.
- **Transitions:** Re-arm → fire-and-forget RPC, toast; stays in `view-only`. Replay → opens Replay flow (separate path that pre-fills the Playground; see §5.2).
- **Error recovery:** If diff render fails (malformed payload), fall back to JSON tree dump.

### 4.2 `detail.mode.editing.url`

- **Entry conditions:** Paused row + user clicks the URL field in the editor; `Tab` key navigates to URL field.
- **Exit conditions:** Blur out; click elsewhere; commit decision.
- **Visual:** URL field highlighted with `--accent` outline; original value stashed for diff. Below, an inline hint: `"Edited — will diff against captured request."` Subtle change indicator dot left of the field.
- **Keyboard:** Standard text editing; `Esc` reverts to original (UX: only when no other field edited yet); `Enter` does NOT forward (collides with text input).
- **Data requirements:** Snapshot from `_pausedSnapshots`.
- **Transitions:**
  - Blur → `editing.<lastfocus>` or back to `view-only` if no edits pending.
  - Click `[Forward]` → `decision-pending` with `action="modify"` if diff non-empty, else `"forward"`.
- **Error recovery:** Invalid URL (no scheme/host) → red outline + tooltip `"Invalid URL"`; Forward/Modify button disabled until valid or reverted.

### 4.3 `detail.mode.editing.headers`

- **Entry conditions:** User clicks a header value in the editor; clicks `[+ add header]`; clicks `[×]` to remove.
- **Exit conditions:** Blur; decision commit.
- **Visual:** Headers table with editable values:
  ```
  ┌────────────────────────────────────────────────────────────┐
  │  Authorization:  [redacted]                  [👁 Reveal]    │
  │  Content-Type:   [application/json        ]  [×]            │
  │  x-test-flag:    [true                    ]  [×]   (added)  │
  │  + add header                                                │
  └────────────────────────────────────────────────────────────┘
  ```
  Added/modified/removed rows tagged in `--http-blue` margin. Reveal button on redacted values triggers the Reveal Auth modal (§7).
- **Keyboard:** `Tab` moves through key/value pairs. `Enter` on the value field commits (but does NOT submit decision). `Delete` on a focused row removes the header.
- **Data requirements:** Snapshot headers.
- **Transitions:** Blur → keeps modifications staged in `RequestEditor`. Forward → `decision-pending` with diff payload.
- **Error recovery:** Duplicate header keys allowed (preserved as separate entries per C04 §6 edge case). Empty key → row marked invalid with red outline; not included in mods.

### 4.4 `detail.mode.editing.body`

- **Entry conditions:** User clicks into the body textarea; user pastes content; user clicks `[Format JSON]`.
- **Exit conditions:** Blur; decision commit.
- **Visual:**
  ```
  ┌────────────────────────────────────────────────────────────┐
  │ Body                                  [Format] [Original]  │
  │ ┌────────────────────────────────────────────────────────┐ │
  │ │ {                                                       │ │
  │ │   "name": "flt-materialization-session",                │ │
  │ │   "driverMemory": "16g",  ← modified                    │ │
  │ │   "driverCores": 4                                      │ │
  │ │ }                                                       │ │
  │ └────────────────────────────────────────────────────────┘ │
  │  Diff: 1 line changed                                       │
  └────────────────────────────────────────────────────────────┘
  ```
  Gutter highlights modified lines in `--http-blue`. Bottom status: `"Diff: N lines changed."`
- **Keyboard:** Standard textarea. `Ctrl+/` toggles a comment-aware "fold raw view ↔ JSON tree view". `Ctrl+Enter` commits as Modify & Forward.
- **Data requirements:** Original body from snapshot; mutable buffer in `RequestEditor`.
- **Transitions:** Blur → staged. Forward → `decision-pending`.
- **Error recovery:** JSON syntax error → red glyph in gutter; Modify & Forward still permitted (C04 §6 — testing-tool stance allows intentional malformed bodies). Body > 10MB → block commit with toast.

### 4.5 `detail.mode.forge.composing`

- **Entry conditions:** User clicks `[◆ Forge]` button (when present) or `f` shortcut on a paused row; user clicks `Forge Response…` in context menu (creates one-shot rule + auto-pauses, then enters this mode).
- **Exit conditions:** Submit forge → `decision-pending`; Cancel → returns to paused view; navigate away.
- **Visual:** Inline composer replaces the request body editor area:
  ```
  ┌────────────────────────────────────────────────────────────┐
  │  ◆ Forge Response                                          │
  │ ────────────────────────────────────────────────────────── │
  │  Status:    [ 503 ▾ ]   Reason: [ Service Unavailable    ] │
  │                                                             │
  │  Response Headers                                           │
  │    Content-Type:  [application/json]              [×]      │
  │    Retry-After:   [30]                            [×]      │
  │    + add header                                             │
  │                                                             │
  │  Response Body                                              │
  │  ┌────────────────────────────────────────────────────────┐│
  │  │ { "error": { "code": "throttled" } }                    ││
  │  └────────────────────────────────────────────────────────┘│
  │                                                             │
  │  [ Cancel ]                          [ ◆ Send Forged Response ]│
  └────────────────────────────────────────────────────────────┘
  ```
  Hero card border tints `--http-purple` to signal forge mode.
- **Keyboard:** `Esc` cancels forge (returns to paused). `Ctrl+Enter` submits.
- **Data requirements:** Snapshot for context (URL, method, original request). Forge payload composed locally.
- **Transitions:**
  - Submit → `decision-pending` with `action="forge"` + payload `{status, headers, body}`.
  - Cancel → back to paused view (request still pending).
- **Error recovery:** Status code out of 100–599 → field outlined red; submit disabled.

### 4.6 `detail.mode.decision-pending`

- **Entry conditions:** User clicked `[▶ Forward]`, `[✕ Drop]`, or `[◆ Send Forged Response]`; or Enter/Esc/D shortcut fired.
- **Exit conditions:** RPC resolves (`MitmResume` success or error).
- **Visual:** Decision buttons greyed; small inline spinner replaces the active button label (e.g., `[ ⟳ Forwarding… ]`). 1500ms safety timeout; if no response, button re-enables with toast `"Decision sent — server not confirming, retry?"`.
- **Keyboard:** All disabled until RPC resolves.
- **Data requirements:** `interceptId`, modifications array.
- **Transitions:**
  - RPC OK → `mitm` topic emits `breakpoint-resolved` → row transitions; mode → `resolved`.
  - RPC error → back to previous editing/paused state; toast with error.
- **Error recovery:** Network mid-flight → `signalr-manager` auto-reconnects; on reconnect, frontend re-queries `MitmListPaused()` — if intercept still pending, button is re-enabled (snapshot replayed); if resolved server-side, transition to `resolved` with the actual outcome.

### 4.7 `detail.mode.resolved`

- **Entry conditions:** `mitm` topic `breakpoint-resolved` arrived for the row's `interceptId`.
- **Exit conditions:** Navigate to a different row; click Re-arm (stays in resolved with new rule); click Replay (opens Playground).
- **Visual:** Same as `view-only` (audit summary card). Crossfade from decision-pending content.
- **Keyboard:** `Shift+R` re-arm, `r` replay (with confirmation if non-idempotent), `P` Send to Playground.
- **Data requirements:** Mutated row entry with new `mitmTag`, `mitmModifications`.
- **Transitions:** Same as `view-only`.
- **Error recovery:** N/A.

---

## 5. Footer Decision Strip

### 5.1 Footer presence
The footer (per mock lines 572–577) appears ONLY when:

- `detail.tab === 'intercept'` AND
- `detail.mode in {editing.*, forge.composing, view-only-with-paused-row}`

For non-paused, non-MITM rows, the footer is hidden (existing four-tab detail panel keeps its current chrome).

### 5.2 Footer button states

| Button | Enabled when | Disabled when | RPC |
|--------|--------------|---------------|-----|
| `▶ Forward` | Paused + decision not in flight | RPC in flight; row not paused | `MitmResume(id, "modify"\|"forward", mods)` |
| `✕ Drop` | Paused + decision not in flight | Same | `MitmResume(id, "block", null)` |
| `→ Playground` | Always (resolved or paused) | Disconnected | None — local handoff to Playground tab |
| `⎘ Copy as cURL` | Always | — | None |

### 5.3 Send to Playground (P / button click) — flow
1. Capture current row snapshot OR (if editing) the modified snapshot from `RequestEditor.getSnapshot()`.
2. Persist the snapshot to `ApiPlayground.loadFromExternal({method, url, headers, body, queryParams})` via a CustomEvent `edog:open-playground` (decoupled, no direct import).
3. Switch the active root tab to `playground`.
4. Toast: `"Loaded into API Playground"`.
5. The paused intercept is **NOT** auto-resolved by this action — the user must still Forward or Drop. Toast reminds: `"Loaded into Playground. The paused request is still waiting."`

This satisfies the simplified F28 scope: "Send to API Playground — pre-filled."

---

## 6. Shell Sub-states (`detail.shell.*`)

### 6.1 `detail.shell.docked`

- **Entry conditions:** Default. Reattach from modal.
- **Exit conditions:** Click `[⬜] Detach` button (mock `#detachBtn`).
- **Visual:** Panel docked on the right of the split view; resize handle on left edge.
- **Keyboard:** N/A shell-specific.
- **Data requirements:** Snapshot.
- **Transitions:** → `detaching`.
- **Error recovery:** N/A.

### 6.2 `detail.shell.detaching`

- **Entry conditions:** Detach button clicked.
- **Exit conditions:** 220ms animation completes → `modal.floating`.
- **Visual:** Panel shrinks to a smaller floating modal with shadow-lg, anchored near the click. Traffic list expands to fill the freed width.
- **Keyboard:** Inert during animation.
- **Data requirements:** Same.
- **Transitions:** → `modal.floating`.
- **Error recovery:** If animation interrupted by tab change, snap to floating end-state.

### 6.3 `detail.shell.modal.floating`

- **Entry conditions:** Detach complete.
- **Exit conditions:** Reattach button; close `[✕]`; double-click drag bar to maximize.
- **Visual:** Draggable modal with drag-bar at top (mock `#modalDragBar`), tabs, body, footer. Backdrop opacity 0.25 (light) / 0.50 (dark). Click-outside does NOT dismiss (modal is non-dismissive — user must explicitly close).
- **Keyboard:** Tab strip arrows; mode-specific shortcuts; `Esc` closes modal AND detail (returns to closed state); `Ctrl+Shift+D` reattach.
- **Data requirements:** Same as docked.
- **Transitions:**
  - Mousedown on drag bar → `modal.dragging`.
  - `[✕]` → `closing` (skipping reattach).
  - Reattach button → reverse `detaching` animation → `docked`.
  - Double-click drag bar → `modal.maximized`.
- **Error recovery:** If modal escapes viewport bounds (window resize while detached), clamp position to keep at least 40px of drag-bar in view.

### 6.4 `detail.shell.modal.dragging`

- **Entry conditions:** Mousedown on drag bar.
- **Exit conditions:** Mouseup; Esc (cancels and reverts to original position).
- **Visual:** Modal follows pointer; cursor `grabbing`; backdrop opacity unchanged. Drag bar tinted `--accent-hover`.
- **Keyboard:** `Esc` reverts.
- **Data requirements:** N/A.
- **Transitions:** → `modal.floating` on mouseup at new position.
- **Error recovery:** If pointer is lost (browser tab change mid-drag), commit current position on next mouseenter.

### 6.5 `detail.shell.modal.maximized`

- **Entry conditions:** Double-click drag bar; click maximize icon (if added).
- **Exit conditions:** Double-click again; `[Restore]` button; Esc → still maximized (Esc reserved for decision dismissal).
- **Visual:** Modal fills viewport with 24px inset. Reset border-radius to `--radius-md`.
- **Keyboard:** Same as floating.
- **Data requirements:** N/A.
- **Transitions:** → `modal.floating` on restore.
- **Error recovery:** N/A.

---

## 7. Reveal Auth Modal (sub-modal within Intercept tab)

### 7.1 `detail.reveal-auth.closed` / `.open` / `.confirming`

Per C04 §4.4 — a nested confirmation modal:

- **Closed:** default; opened by clicking `[👁 Reveal]` next to a redacted header.
- **Open:** centered card with explainer text, audit acknowledgement checkbox (unchecked by default), `[Cancel]` and `[Reveal Once]` buttons (Reveal disabled until checkbox checked).
- **Confirming:** RPC `MitmGetUnredactedHeader(interceptId, headerName)` in flight; both buttons disabled, spinner on Reveal button.
- **Visual:** Glass-morph backdrop over the detail panel (not the whole page); modal width 360px; `--shadow-lg`.
- **Keyboard:** Focus-trap; Tab cycles checkbox → Cancel → Reveal Once; Esc cancels; Enter on Reveal Once submits (only if checkbox checked).
- **Data requirements:** `interceptId` and `headerName` parameters.
- **Transitions:**
  - Cancel/Esc → `closed`, header stays redacted.
  - Confirm → `confirming` → on RPC OK, modal closes, the header field in the editor unmasks (value present but not persisted in localStorage).
  - RPC error → `confirming` → `open` with inline error `"Reveal denied: capability disabled."`
- **Error recovery:** If the intercept resolved while modal was open, RPC returns 410-equivalent → toast `"Intercept already resolved; reveal cancelled."` and modal closes.

---

## 8. Cross-cutting Concerns

### 8.1 Disconnected
While disconnected:
- All decision buttons (Forward / Drop) disabled with tooltip `"Disconnected — waiting for reconnect"`.
- Send to Playground remains enabled (local handoff).
- Reveal Auth blocked at the click (RPC required).
- If the detail panel was on a paused row when disconnect happened, the row's snapshot in `_pausedSnapshots` is retained; on reconnect, frontend invokes `MitmListPaused()` — if intercept is still pending, decision buttons re-enable; if server timed out and forwarded, panel transitions to `resolved` view with toast `"Connection restored — request was auto-forwarded."`

### 8.2 Kill switch (`Ctrl+Shift+K`)
If the panel is on a paused row when kill switch fires:
- Mode transitions immediately to `resolved` (specifically: `breakpoint-resolved` with `action="forward"`, `synthesized=false`).
- Audit summary shows `"Kill switch — auto-forwarded without modifications."`
- Toast banner per the global kill-switch message.

### 8.3 Theme change
All shadows, borders, and tints use design tokens. Forge mode's purple accent, modify mode's blue accent, paused mode's amber pulse all swap via `[data-theme]` overrides — no per-state CSS rules needed for theming.

### 8.4 Panel resize
Resize handle on the panel's left edge owns:
- Drag to set `flex-basis`. Persisted in `localStorage['edog.http.detail.width']`.
- Min width 320px; max width 80% of viewport.
- Double-click handle resets to 45%.
- While dragging, body content is `pointer-events: none` to prevent text-selection thrash.
- Detached modal ignores this — modal width is independent.

### 8.5 Modal close
Three close vectors:
1. `[✕]` → `closing` → `closed` (decision panel gone).
2. `Esc` (no decision pending) → same.
3. `Esc` (paused intercept + Intercept tab active) → forwards the request first, then closes (per C04 §7.1).
4. Row deselected in traffic list → close without animation (selection drives presence).

### 8.6 Multiple paused rows
Detail panel always shows ONE row. If the user is editing row A's paused intercept and clicks row B (also paused):
- Row A's edit buffer in `RequestEditor` is preserved by `_pausedSnapshots` map keyed by `interceptId`.
- Detail panel re-renders for row B; editor mounts with row B's snapshot.
- Returning to row A restores its in-progress edits exactly.

### 8.7 Tab visibility
While the HTTP tab is hidden but the detail panel had been open on a paused row:
- `_pausedSnapshots` retained.
- On re-show, panel re-renders to its last open state.
- If the intercept resolved server-side while hidden, panel renders `resolved` mode directly.

### 8.8 Memory
`RequestEditor` instances are disposed (`ed.dispose()`) when:
- Panel closes.
- User navigates to a different row (old editor replaced).
- Tab destroyed.

Listeners cleaned up; no leaks.

---

## 9. State Transition Table (consolidated)

| From | Trigger | To | Notes |
|------|---------|----|-------|
| `lifecycle.closed` | Row selected | `lifecycle.sliding-in` | 180ms anim |
| `lifecycle.sliding-in` | Anim complete | `lifecycle.open` | — |
| `lifecycle.sliding-in` | Selection cleared | `lifecycle.aborted` → `closed` | — |
| `lifecycle.open` | `[✕]` or `Esc` (non-paused) | `lifecycle.closing` → `closed` | — |
| `lifecycle.open` + `tab=intercept` + paused | `Esc` | `mode.decision-pending` (forward) | C04 §7.1 |
| `tab.request` | Row paused (auto) | `tab.intercept` + `attention-pulse` | C04 §4.1 |
| `tab.intercept` + paused | Click body field | `mode.editing.body` | — |
| `mode.editing.*` | Click `[▶ Forward]` | `mode.decision-pending` | `action=modify` if dirty |
| `mode.editing.*` | Click `[✕ Drop]` | `mode.decision-pending` | `action=block` |
| `mode.editing.*` | Click `[→ Playground]` | (Playground tab) | Intercept still pending |
| `mode.editing.*` | Click `[Forge]` / `f` | `mode.forge.composing` | — |
| `mode.forge.composing` | Submit | `mode.decision-pending` | `action=forge` |
| `mode.forge.composing` | Cancel / Esc | back to paused view | Request still pending |
| `mode.decision-pending` | RPC OK | `mode.resolved` | Row tag updates |
| `mode.decision-pending` | RPC error | previous editing/paused | Toast |
| `mode.resolved` | Re-arm clicked | stays `resolved` | New rule created |
| `mode.resolved` | Replay clicked | (Playground tab) | Confirmation if unsafe method |
| `shell.docked` | Detach button | `shell.detaching` → `modal.floating` | 220ms anim |
| `shell.modal.floating` | Reattach | `shell.docked` | — |
| `shell.modal.floating` | Drag-bar mousedown | `shell.modal.dragging` | — |
| `shell.modal.dragging` | Mouseup | `shell.modal.floating` | New position |
| `shell.modal.floating` | Dbl-click drag bar | `shell.modal.maximized` | — |
| `reveal-auth.closed` | Click Reveal | `reveal-auth.open` | Audit checkbox required |
| `reveal-auth.open` | Confirm | `reveal-auth.confirming` → close | Header value populated inline |

---

## 10. State Inventory

1. `detail.lifecycle.closed`
2. `detail.lifecycle.sliding-in`
3. `detail.lifecycle.open`
4. `detail.lifecycle.closing`
5. `detail.lifecycle.aborted`
6. `detail.tab.request`
7. `detail.tab.response`
8. `detail.tab.timing`
9. `detail.tab.headers`
10. `detail.tab.intercept`
11. `detail.mode.view-only`
12. `detail.mode.editing.url`
13. `detail.mode.editing.headers`
14. `detail.mode.editing.body`
15. `detail.mode.forge.composing`
16. `detail.mode.decision-pending`
17. `detail.mode.resolved`
18. `detail.shell.docked`
19. `detail.shell.detaching`
20. `detail.shell.modal.floating`
21. `detail.shell.modal.dragging`
22. `detail.shell.modal.maximized`
23. `detail.reveal-auth.closed`
24. `detail.reveal-auth.open`
25. `detail.reveal-auth.confirming`

**Total: 25 states.** All have entry/exit, visuals, keyboard, data, transitions, and error recovery defined.

---

## 11. Editing-Mode Affordance Reference

Editable surfaces are visually distinct from read-only viewers:

| Field | Read-only style | Editing style |
|-------|-----------------|---------------|
| URL | Mono font, `--text` color, no border | `--accent` 1px outline, caret visible, edit-pencil glyph in margin |
| Header value | Mono font, dim | Editable input, `--surface-2` background, `[×]` to remove |
| Header key | Bold, `--text-bright` | Editable input + autocomplete on common headers |
| Body | Pre-block, `--http-json` highlight | Textarea with gutter line numbers and diff highlights |
| Method | Pill, color-token | Dropdown with all 7 methods, same color-tokens |
| Status (forge) | Pill | Numeric input + dropdown shortcuts for common codes |

Every change is reflected in the **edit summary panel** at the bottom of the editor:

```
┌────────────────────────────────────────────────────────────┐
│ Edit summary                                                │
│   ▲ headers["x-test-flag"] = "true"     (added)             │
│   ▼ headers["X-Old"]                    (removed)           │
│   ▼→▲ body $.driverMemory: "8g" → "16g" (replaced)          │
│   ▼→▲ url: "/sessions" → "/sessions?debug=1" (replaced)     │
└────────────────────────────────────────────────────────────┘
```

`RequestEditor.getModifications()` returns this list in JSON-Patch-style format for `MitmResume(id, "modify", modifications)`.

---

*End of detail-panel state matrix.*
