# P3 State Matrix: PR Input Stage (C06-S03)

**Feature:** F27 QA Testing
**Component:** C06 Frontend Panel — Stage 1
**Author:** Pixel (Frontend)
**Priority:** P0 — Entry point for entire QA workflow

---

## Overview

The PR Input Stage is the gateway to the QA Testing pipeline. Users provide a pull
request identifier (full ADO URL, short `#12345`, or bare number), the system validates
the input, fetches PR metadata, and renders a detail card. The "Analyze" button fires
`QaStartCodeAnalysis` via SignalR and transitions to Stage 2. A recent-PRs list
(persisted in `localStorage`, max 10 entries) provides quick re-analysis.

**Accepted input formats:**

| Format | Example | Regex |
|--------|---------|-------|
| Full ADO URL | `https://dev.azure.com/powerbi/MWC/_git/.../pullrequest/12345` | `/dev\.azure\.com\/[^/]+\/[^/]+\/_git\/[^/]+\/pullrequest\/(\d+)/` |
| Hash-prefixed number | `#12345` | `/^#(\d{1,6})$/` |
| Bare number | `12345` | `/^(\d{1,6})$/` |

---

## State Inventory

| # | State ID | Short Description |
|---|----------|-------------------|
| 1 | `input.empty` | Blank field, no history, fresh start |
| 2 | `input.typing` | User actively entering text |
| 3 | `input.valid` | Input matches ADO PR pattern (local regex) |
| 4 | `input.invalid` | Input does not match any accepted format |
| 5 | `input.validating` | Async API call verifying PR exists |
| 6 | `input.resolved` | PR metadata fetched, detail card shown |
| 7 | `input.submitting` | `QaStartCodeAnalysis` invocation in-flight |
| 8 | `input.error` | Submission or validation failed |
| 9 | `input.history` | Recent PRs list visible, no input focus |
| 10 | `input.history.selected` | PR selected from history list |
| 11 | `input.paste` | URL pasted, auto-validate triggered |
| 12 | `input.prefilled` | Opened with branch-auto-detected PR context |

---

## Transition Diagram

```
                          +------------------+
                          |  input.prefilled |  (branch auto-detect banner)
                          +--------+---------+
                                   |
                            "Use this PR"
                                   |
                                   v
+----------------+  type   +---------------+  regex pass   +-------------+
| input.empty    |-------->| input.typing  |-------------->| input.valid |
+-------+--------+         +-------+-------+               +------+------+
        |                          |                               |
    Tab to list              regex fail                    async fetch PR
        |                          |                               |
        v                          v                               v
+----------------+         +---------------+            +------------------+
| input.history  |         | input.invalid |            | input.validating |
+-------+--------+         +-------+-------+            +--------+---------+
        |                          |                              |
   click/Enter              edit input                   +--------+--------+
        |                          |                     |                 |
        v                          v                success (200)     fail (4xx/net)
+----------------------+   +---------------+             |                 |
| input.history.select |   | input.typing  |             v                 v
+----------+-----------+   +---------------+     +---------------+  +--------------+
           |                                     | input.resolved|  | input.error  |
           |                                     +-------+-------+  +------+-------+
           +----------+                                  |                 |
                      |                          click "Analyze"     edit / retry
                      v                                  |                 |
              +------------------+                       v                 v
              | input.validating |               +-----------------+  +---------------+
              +------------------+               | input.submitting|  | input.typing  |
                                                 +--------+--------+  +---------------+
                                                          |
                                                 +--------+--------+
                                                 |                 |
                                             success            fail
                                                 |                 |
                                                 v                 v
                                          [Stage 2: Analysis] +-------------+
                                                               | input.error |
                                                               +-------------+

    +---------------+   paste event    +-------------+
    | (any state)   |----------------->| input.paste |---> input.valid / input.invalid
    +---------------+                  +-------------+
```

---

## State Definitions

### 1. `input.empty`

| Field | Value |
|-------|-------|
| **State name** | `input.empty` |
| **Entry conditions** | Stage 1 activated for the first time, OR user pressed `Escape` to clear, OR returned from a later stage via back-navigation. Input field is blank. |
| **Exit conditions** | User types any character (`input.typing`), user focuses recent-PRs list (`input.history`), paste event fires (`input.paste`), or branch auto-detect banner present (`input.prefilled`). |
| **Visual description** | See wireframe below. Centered layout, input field with placeholder text, empty recent-PRs section shows "No recent PRs" hint. |
| **Keyboard shortcuts** | `Tab` — move focus to recent-PRs list (if populated). `/` — focus input from anywhere in QA panel. `Escape` — no-op (already empty). |
| **Data requirements** | `localStorage['edog-qa-recent-prs']` read on entry. If array is non-empty, recent-PRs section renders items. If empty/absent, show hint text. |
| **Transitions** | `input.typing` (keypress), `input.history` (Tab/click into list), `input.paste` (paste event), `input.prefilled` (auto-detect banner present on entry). |
| **Error recovery** | N/A — no error possible in this state. |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [diamond] Enter PR # or URL...             |  |
|  +--------------------------------------------+  |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  |  No recent pull requests.                  |  |
|  |  Enter a PR number or ADO URL above.       |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

### 2. `input.typing`

| Field | Value |
|-------|-------|
| **State name** | `input.typing` |
| **Entry conditions** | User types any character into the input field from `input.empty`, `input.invalid`, or `input.error`. Also entered when user edits an existing value. |
| **Exit conditions** | Input matches regex (`input.valid`), input fails regex after debounce (`input.invalid`), user clears field (`input.empty`), paste event overrides (`input.paste`). |
| **Visual description** | Input field has focus ring (`var(--accent-glow)`). Diamond icon `[diamond]` pulses subtly. Error message (if visible from prior state) remains until next validation cycle. |
| **Keyboard shortcuts** | `Enter` — force immediate validation. `Escape` — clear input, return to `input.empty`. `Ctrl+A` — select all text. |
| **Data requirements** | Current input value (raw string). Debounce timer (300ms) before regex validation fires. |
| **Transitions** | `input.valid` (regex match after debounce or Enter), `input.invalid` (regex fail after debounce), `input.empty` (Escape or delete-all), `input.paste` (paste event). |
| **Error recovery** | Prior error message auto-clears on first keypress. No new error can originate in this state. |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +============================================+  |
|  | [diamond] https://dev.azure.co|            |  |  <-- focus ring
|  +============================================+  |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  |  #14823  Fix retry logic in Da...  2h ago  |  |
|  |  #14801  Add Spark session pool... 1d ago  |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

### 3. `input.valid`

| Field | Value |
|-------|-------|
| **State name** | `input.valid` |
| **Entry conditions** | `_parsePRInput()` returns non-null (URL or number format matched). Entered from `input.typing` (debounce/Enter) or `input.paste` (auto-validate). |
| **Exit conditions** | Async PR fetch begins (`input.validating`). User edits text (`input.typing`). User clears field (`input.empty`). |
| **Visual description** | Input border turns `var(--ok)`. Diamond icon becomes filled `[ok-diamond]`. A brief checkmark indicator appears inline. No detail card yet — that requires async validation. |
| **Keyboard shortcuts** | `Enter` — trigger async PR fetch immediately (`input.validating`). `Escape` — clear input. |
| **Data requirements** | Parsed PR number (integer). Input format type (`'url'` or `'number'`). |
| **Transitions** | `input.validating` (auto-triggered 200ms after regex match, or immediate on Enter), `input.typing` (user edits), `input.empty` (Escape). |
| **Error recovery** | N/A — this is a success state. Editing reverts to `input.typing`. |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [ok] #14823                          [chk] |  |  <-- green border, checkmark
|  +--------------------------------------------+  |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  |  #14823  Fix retry logic in Da...  2h ago  |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

### 4. `input.invalid`

| Field | Value |
|-------|-------|
| **State name** | `input.invalid` |
| **Entry conditions** | `_parsePRInput()` returns null after debounce. Input is non-empty but does not match URL or number regex. Also entered from `input.paste` if pasted text is not a valid format. |
| **Exit conditions** | User edits text (`input.typing`). User clears field (`input.empty`). |
| **Visual description** | Input border turns `var(--fail)`. Error message appears below: "Enter a PR number (e.g., #12345) or ADO URL". Error div has `role="alert"` for screen readers. |
| **Keyboard shortcuts** | `Escape` — clear input and error, return to `input.empty`. Any key — transition to `input.typing`, error persists until next debounce cycle. |
| **Data requirements** | Raw input string (for display). Error message string. |
| **Transitions** | `input.typing` (any edit), `input.empty` (Escape or select-all + delete). |
| **Error recovery** | Error message auto-clears on transition to `input.typing`. User can press Escape to reset entirely. |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [diamond] not-a-valid-input                |  |  <-- red border
|  +--------------------------------------------+  |
|  [!] Enter a PR number (e.g., #12345) or      |
|      ADO URL                                   |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  |  #14823  Fix retry logic in Da...  2h ago  |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

### 5. `input.validating`

| Field | Value |
|-------|-------|
| **State name** | `input.validating` |
| **Entry conditions** | Regex-valid PR number triggers async `GET /api/qa/pr/{prNumber}` call. Entered from `input.valid` (auto or Enter) or `input.history.selected` (clicking a recent PR that needs re-fetch). |
| **Exit conditions** | API returns 200 (`input.resolved`). API returns 404 or network error (`input.error`). User presses Escape to abort (`input.empty`). |
| **Visual description** | Input field shows a small inline spinner replacing the checkmark. Input is read-only during fetch. Diamond icon animates (pulse). "Verifying PR..." text appears below input in `var(--text-dim)`. |
| **Keyboard shortcuts** | `Escape` — abort fetch (AbortController), clear input, return to `input.empty`. All other keys blocked (input is read-only). |
| **Data requirements** | PR number (integer). Active `AbortController` for fetch cancellation. Timeout: 10s max. |
| **Transitions** | `input.resolved` (200 OK with metadata), `input.error` (404, 500, network failure, timeout), `input.empty` (Escape abort). |
| **Error recovery** | Escape aborts cleanly. Timeout (10s) auto-transitions to `input.error` with "Request timed out" message. AbortController prevents stale responses from racing. |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [pulse] #14823                      [spin] |  |  <-- read-only, spinner
|  +--------------------------------------------+  |
|  Verifying PR...                                 |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  |  #14823  Fix retry logic in Da...  2h ago  |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

### 6. `input.resolved`

| Field | Value |
|-------|-------|
| **State name** | `input.resolved` |
| **Entry conditions** | API returned 200 with PR metadata (`{ number, title, author, files[], additions, deletions, createdAt }`). This is the primary "ready to submit" state. |
| **Exit conditions** | User clicks "Analyze" button (`input.submitting`). User edits input (`input.typing`). User presses Escape (`input.empty`). |
| **Visual description** | PR detail card appears below input showing title, author, file count, +/- diff stats, and creation date. "Analyze" button is enabled and prominently styled with `var(--accent)`. Input keeps green border. |
| **Keyboard shortcuts** | `Enter` — activate "Analyze" button (submit). `Escape` — clear input, hide card, return to `input.empty`. `Tab` — input -> card details -> "Analyze" button. |
| **Data requirements** | Full PR metadata object. PR number. Input text (preserved). Recent-PRs list (for deduplication before adding). |
| **Transitions** | `input.submitting` (click "Analyze" or Enter), `input.typing` (edit input), `input.empty` (Escape). |
| **Error recovery** | N/A — success state. "Analyze" button is the only forward action. Back-navigation always available via Escape. |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [ok] #14823                          [chk] |  |
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  | PR #14823                                  |  |
|  | Fix retry logic in DAG executor            |  |
|  |                                            |  |
|  | Author: jsmith   Files: 12                 |  |
|  | +847 / -203      Created: 2h ago           |  |
|  |                                            |  |
|  |                        [ Analyze >> ]      |  |  <-- accent button
|  +--------------------------------------------+  |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  |  #14823  Fix retry logic in Da...  2h ago  |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

### 7. `input.submitting`

| Field | Value |
|-------|-------|
| **State name** | `input.submitting` |
| **Entry conditions** | User clicked "Analyze" or pressed Enter in `input.resolved`. Triggers `connection.invoke('QaStartCodeAnalysis', request)` via SignalR. |
| **Exit conditions** | SignalR returns `QaAnalysisResult` with `success: true` (transition to Stage 2). SignalR returns error or times out (`input.error`). |
| **Visual description** | "Analyze" button replaced by spinner + "Starting analysis..." text. Input and card are dimmed (`opacity: 0.6`). All interactive elements disabled. Pipeline bar stage-1 node pulses. |
| **Keyboard shortcuts** | `Escape` — cancel submission (if backend supports cancel). All other input blocked. |
| **Data requirements** | `QaAnalysisRequest` object: `{ correlationId, prUrl or prId, options }`. SignalR connection must be `'connected'`. Active timeout (30s). |
| **Transitions** | Stage 2 (`input.submitting` -> `analysis.running` in Stage 2 controller), `input.error` (SignalR error, timeout, network failure). |
| **Error recovery** | Timeout (30s) auto-transitions to `input.error`. SignalR disconnect during submission also transitions to `input.error` with reconnect hint. PR is added to recent-PRs list regardless of outcome (for re-try convenience). |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |  <-- dimmed (opacity: 0.6)
|  | [ok] #14823                                |  |
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  | PR #14823                                  |  |
|  | Fix retry logic in DAG executor            |  |
|  |                                            |  |
|  |                 [spin] Starting analysis... |  |  <-- spinner replaces button
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

### 8. `input.error`

| Field | Value |
|-------|-------|
| **State name** | `input.error` |
| **Entry conditions** | Any failure: PR not found (404), network error, SignalR timeout, `QaStartCodeAnalysis` returned `success: false`, or request timed out. |
| **Exit conditions** | User edits input (`input.typing`). User clicks "Retry" (`input.validating` or `input.submitting` depending on failure origin). User presses Escape (`input.empty`). |
| **Visual description** | Error message below input with `var(--fail)` color. Message varies by cause (see table below). Input border is `var(--fail)`. "Retry" link appears next to error if the failure is retryable. PR card hidden if error was during validation; card visible (dimmed) if error was during submission. |
| **Keyboard shortcuts** | `Enter` — activate "Retry" if retryable. `Escape` — clear all, return to `input.empty`. `Tab` — input -> Retry link. |
| **Data requirements** | Error cause enum: `'not_found'`, `'network'`, `'timeout'`, `'signalr_disconnect'`, `'server_error'`. Original PR number (for retry). |
| **Transitions** | `input.typing` (edit input), `input.validating` (retry validation-phase error), `input.submitting` (retry submission-phase error), `input.empty` (Escape). |
| **Error recovery** | See error messages table below. All errors are recoverable — user can always edit and re-try or Escape to reset. |

**Error messages by cause:**

| Cause | Message | Retryable |
|-------|---------|-----------|
| `not_found` | "PR #12345 not found. Check the number and try again." | No (edit input) |
| `network` | "Could not reach EDOG backend. Check connection." | Yes |
| `timeout` | "Request timed out. Try again." | Yes |
| `signalr_disconnect` | "Lost connection to FLT. Reconnecting..." | Yes (auto) |
| `server_error` | "Analysis failed. See EDOG logs for details." | Yes |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [diamond] #99999                           |  |  <-- red border
|  +--------------------------------------------+  |
|  [!] PR #99999 not found. Check the number    |
|      and try again.                            |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  |  #14823  Fix retry logic in Da...  2h ago  |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [ok] #14823                                |  |  <-- red border
|  +--------------------------------------------+  |
|  [!] Could not reach EDOG backend.  [Retry]   |
|      Check connection.                         |
|                                                  |
+--------------------------------------------------+
```

---

### 9. `input.history`

| Field | Value |
|-------|-------|
| **State name** | `input.history` |
| **Entry conditions** | User tabs into the recent-PRs list, or clicks on the list area. List is populated (at least 1 entry in `localStorage`). |
| **Exit conditions** | User selects a PR (`input.history.selected`). User tabs/clicks back to input (`input.empty` or `input.typing`). User presses Escape (focus returns to input). |
| **Visual description** | Recent-PRs list has visual focus. Items show: PR number, truncated title, relative timestamp, and a hover-visible remove button (x). Active/focused item has `var(--surface-2)` background highlight. |
| **Keyboard shortcuts** | `Up/Down` — navigate items. `Enter` — select highlighted item. `Delete` or `Backspace` — remove highlighted item from history. `Escape` — return focus to input. `Home/End` — jump to first/last item. |
| **Data requirements** | `localStorage['edog-qa-recent-prs']` array. Each entry: `{ number, title, analyzedAt }`. Max 10 entries, newest first. |
| **Transitions** | `input.history.selected` (Enter/click on item), `input.empty` (Escape or Tab back when input is empty), `input.typing` (Tab back when input has text). |
| **Error recovery** | Corrupted localStorage data: catch JSON parse error, reset to empty array, show "No recent PRs" hint. |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [diamond] Enter PR # or URL...             |  |
|  +--------------------------------------------+  |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  | > #14823  Fix retry logic in...   2h ago x |  |  <-- highlighted
|  |   #14801  Add Spark session p... 1d ago  x |  |
|  |   #14790  Update Graphify sch... 3d ago  x |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

### 10. `input.history.selected`

| Field | Value |
|-------|-------|
| **State name** | `input.history.selected` |
| **Entry conditions** | User pressed Enter on or clicked a recent-PR item in `input.history`. |
| **Exit conditions** | PR number populates input, validation begins (`input.validating`). If cached metadata is still fresh (< 5 min), skip to `input.resolved` directly. |
| **Visual description** | Selected item briefly flashes `var(--accent-dim)` background. Input field auto-populates with `#14823`. Transition to `input.validating` or `input.resolved` is near-instant. |
| **Keyboard shortcuts** | Inherited — state is transient (< 100ms visible). No unique shortcuts. |
| **Data requirements** | Selected PR entry from history: `{ number, title, analyzedAt }`. Cached metadata (if available and fresh). |
| **Transitions** | `input.validating` (default — re-fetch metadata), `input.resolved` (cached metadata fresh < 5 min). |
| **Error recovery** | If selected item references a PR that no longer exists, `input.validating` will fail and transition to `input.error` with "not_found" cause. Item is NOT auto-removed from history (user might have network issues). |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [ok] #14823                                |  |  <-- auto-populated
|  +--------------------------------------------+  |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  | [*] #14823  Fix retry logic...    2h ago   |  |  <-- flash highlight
|  |     #14801  Add Spark session... 1d ago     |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

### 11. `input.paste`

| Field | Value |
|-------|-------|
| **State name** | `input.paste` |
| **Entry conditions** | `paste` event fires on the input element. Can occur from any state where input is not read-only (`input.empty`, `input.typing`, `input.invalid`, `input.error`). |
| **Exit conditions** | Pasted text validated immediately (no debounce): regex match (`input.valid`), regex fail (`input.invalid`). |
| **Visual description** | Transient state (< 50ms). Input value is replaced with pasted text. Brief "paste" animation (input background flashes `var(--surface-3)`). |
| **Keyboard shortcuts** | `Ctrl+V` / `Cmd+V` — standard paste (triggers this state). No unique shortcuts. |
| **Data requirements** | Clipboard text (from `paste` event `clipboardData.getData('text/plain')`). Whitespace trimmed. |
| **Transitions** | `input.valid` (pasted text matches regex), `input.invalid` (pasted text does not match). Transition is synchronous — no debounce for paste. |
| **Error recovery** | Malformed clipboard data (non-text MIME): ignore paste, stay in previous state. Empty paste: ignore, stay in previous state. |

```
+--------------------------------------------------+
|  PULL REQUEST                                    |
|                                                  |
|  +============================================+  |
|  | [diamond] https://dev.azure.com/powerbi/.. |  |  <-- flash bg on paste
|  +============================================+  |
|                 (instant validation)             |
+--------------------------------------------------+
```

---

### 12. `input.prefilled`

| Field | Value |
|-------|-------|
| **State name** | `input.prefilled` |
| **Entry conditions** | QA panel activated while current git branch matches an open PR. Backend or git integration detects the association and provides the PR number. Banner appears above the input. |
| **Exit conditions** | User clicks "Use this PR" (`input.validating` with the detected PR number). User dismisses banner (x) and types manually (`input.empty`). User ignores banner and types different PR (`input.typing`). |
| **Visual description** | A highlight banner above the input: "Detected PR #14823 from current branch `feature/retry-fix`" with "Use this PR" button and dismiss (x). Input field is empty (user has not committed to using detected PR). |
| **Keyboard shortcuts** | `Enter` — activate "Use this PR" button (if focused). `Escape` — dismiss banner, focus input. `Tab` — "Use this PR" button -> dismiss (x) -> input field. |
| **Data requirements** | Detected PR number (integer). Branch name (string). PR exists confirmation (pre-validated by backend). |
| **Transitions** | `input.validating` ("Use this PR" clicked — PR number auto-fills and fetch begins), `input.empty` (banner dismissed), `input.typing` (user types in input, ignoring banner). |
| **Error recovery** | If detected PR no longer exists (merged/abandoned between detection and click), `input.validating` -> `input.error` with appropriate message. Banner auto-dismisses if branch changes. |

```
+--------------------------------------------------+
|  +--------------------------------------------+  |
|  | Detected PR #14823 from branch             |  |
|  | feature/retry-fix                          |  |
|  |              [Use this PR]            [x]  |  |
|  +--------------------------------------------+  |
|                                                  |
|  PULL REQUEST                                    |
|                                                  |
|  +--------------------------------------------+  |
|  | [diamond] Enter PR # or URL...             |  |
|  +--------------------------------------------+  |
|                                                  |
|  RECENT PRS                                      |
|  +--------------------------------------------+  |
|  |  #14823  Fix retry logic in Da...  2h ago  |  |
|  +--------------------------------------------+  |
+--------------------------------------------------+
```

---

## Complete Transition Table

| From | Event | To | Guard / Notes |
|------|-------|----|---------------|
| `input.empty` | keypress | `input.typing` | Any printable character |
| `input.empty` | Tab / click list | `input.history` | List must have >= 1 item |
| `input.empty` | paste | `input.paste` | Non-empty clipboard text |
| `input.empty` | branch-detect | `input.prefilled` | Backend provides PR match |
| `input.typing` | debounce (300ms) regex pass | `input.valid` | `_parsePRInput()` non-null |
| `input.typing` | debounce (300ms) regex fail | `input.invalid` | `_parsePRInput()` null, input non-empty |
| `input.typing` | Escape / delete-all | `input.empty` | Input becomes blank |
| `input.typing` | paste | `input.paste` | Overrides current text |
| `input.valid` | auto (200ms) or Enter | `input.validating` | Async fetch begins |
| `input.valid` | edit | `input.typing` | User modifies text |
| `input.valid` | Escape | `input.empty` | Clear all |
| `input.invalid` | edit | `input.typing` | User modifies text |
| `input.invalid` | Escape | `input.empty` | Clear input and error |
| `input.invalid` | paste | `input.paste` | Replace text |
| `input.validating` | 200 OK | `input.resolved` | Metadata received |
| `input.validating` | 404 / error | `input.error` | Set cause accordingly |
| `input.validating` | timeout (10s) | `input.error` | cause = `'timeout'` |
| `input.validating` | Escape | `input.empty` | AbortController.abort() |
| `input.resolved` | click "Analyze" / Enter | `input.submitting` | SignalR must be connected |
| `input.resolved` | edit input | `input.typing` | Card hidden |
| `input.resolved` | Escape | `input.empty` | Card hidden, input cleared |
| `input.submitting` | success | **Stage 2** | `QaAnalysisResult.success === true` |
| `input.submitting` | error / timeout (30s) | `input.error` | cause varies |
| `input.submitting` | Escape | `input.error` | Cancel if supported |
| `input.error` | edit input | `input.typing` | Error clears on keypress |
| `input.error` | click "Retry" | `input.validating` or `input.submitting` | Depends on error origin |
| `input.error` | Escape | `input.empty` | Full reset |
| `input.history` | Enter / click item | `input.history.selected` | Item focused/clicked |
| `input.history` | Escape / Tab to input | `input.empty` or `input.typing` | Depends on input content |
| `input.history` | Delete / Backspace | `input.history` | Remove item, stay in list |
| `input.history.selected` | (auto) | `input.validating` | Default: re-fetch metadata |
| `input.history.selected` | (auto, cached) | `input.resolved` | Cache fresh < 5 min |
| `input.paste` | regex pass | `input.valid` | Synchronous, no debounce |
| `input.paste` | regex fail | `input.invalid` | Synchronous, no debounce |
| `input.prefilled` | "Use this PR" | `input.validating` | Auto-fill + fetch |
| `input.prefilled` | dismiss (x) | `input.empty` | Banner removed |
| `input.prefilled` | type in input | `input.typing` | Banner remains visible |

---

## Global Keyboard Shortcuts (Stage 1)

| Key | Action | Context |
|-----|--------|---------|
| `/` | Focus PR input field | Anywhere in QA panel, Stage 1 active |
| `Escape` | Clear input + errors, or dismiss banner | Any state (cascading reset) |
| `Enter` | Validate / fetch / submit (context-dependent) | Input focused |
| `Tab` | Forward through focus order | Standard tab order (see S12) |
| `Shift+Tab` | Backward through focus order | Standard reverse tab |
| `Up/Down` | Navigate recent-PRs list | List focused (`input.history`) |
| `Delete` | Remove item from recent-PRs | List focused, item highlighted |
| `Ctrl+V` | Paste and auto-validate | Input focused |

---

## ARIA & Accessibility

| Element | ARIA attribute | Value |
|---------|---------------|-------|
| Input field | `role` | `searchbox` |
| Input field | `aria-label` | "Pull request number or URL" |
| Error div | `role` | `alert` |
| Error div | `aria-live` | `polite` |
| Recent-PRs list | `role` | `listbox` |
| Recent-PR item | `role` | `option` |
| Recent-PR item | `aria-selected` | `true` when highlighted |
| PR detail card | `role` | `region` |
| PR detail card | `aria-label` | "Pull request details" |
| "Analyze" button | `aria-label` | "Analyze pull request 14823" (dynamic) |
| Auto-detect banner | `role` | `status` |
| Auto-detect banner | `aria-live` | `polite` |

---

## localStorage Schema

**Key:** `edog-qa-recent-prs`

```json
[
  {
    "number": 14823,
    "title": "Fix retry logic in DAG executor",
    "author": "jsmith",
    "analyzedAt": "2025-07-10T14:30:22Z",
    "metadata": {
      "files": 12,
      "additions": 847,
      "deletions": 203
    }
  }
]
```

**Constraints:** Max 10 entries. Newest first. Deduplicated by `number`.
On cache read failure: reset to `[]`, log warning, continue.

---

## Design Token Reference

| Visual element | Token |
|----------------|-------|
| Input border (default) | `var(--border)` |
| Input border (focus) | `var(--accent)` with `var(--accent-glow)` shadow |
| Input border (valid) | `var(--ok)` |
| Input border (error) | `var(--fail)` |
| Error text | `var(--fail)` |
| Hint text | `var(--text-muted)` |
| PR card background | `var(--surface-2)` |
| PR card border | `var(--border)` |
| "Analyze" button bg | `var(--accent)` |
| "Analyze" button text | `var(--bg)` (contrast) |
| History item hover | `var(--surface-2)` |
| History item active | `var(--surface-3)` |
| Banner background | `var(--surface-2)` |
| Banner border-left | `var(--accent)` 3px solid |
| Disabled overlay | `opacity: 0.6` |
| Spinner | `var(--accent)` border animation |
