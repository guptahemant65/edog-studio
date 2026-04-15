# Active Rules List — State Matrix

> **Author:** Pixel (Frontend Engineer)
> **Status:** SPEC
> **Date:** 2026-07-28
> **Depends On:** `engine-design.md` (rule model, lifecycle states), `signalr-protocol.md` (events), `spec.md` §2.2

---

## Overview

The Active Rules List is the second sub-view of the Chaos Panel (§2.2). It renders every `ChaosRule` returned by `ChaosGetAllRules` and updates in real time via SignalR events (`RuleCreated`, `RuleUpdated`, `RuleDeleted`, `RuleFired`, `RuleAutoDisabled`, `KillSwitchActivated`).

This document defines **every visual state** the list can occupy — entry/exit conditions, DOM structure, keyboard behavior, transitions, and real-time update semantics.

### Conventions

- **State IDs** use dot-separated hierarchical notation: `list.rule.active`
- **Keyboard** assumes standard EDOG keyboard-first model (Tab/Shift+Tab, arrow keys, Enter, Escape)
- **Visual indicators** from spec §2.2: `●` green = active, `●` amber = rate-limited, `●` red = error, `●` grey = paused
- **CSS** uses OKLCH color tokens per STYLE_GUIDE.md; no hex/HSL
- **Unicode symbols only** — no emoji

---

## State Transition Diagram

```
                          ChaosGetAllRules()
    ┌──────────┐         ┌──────────────┐         ┌───────────────┐
    │          │  invoke  │              │  0 rules │               │
    │  (init)  ├────────►│ list.loading  ├────────►│  list.empty   │
    │          │         │              │         │               │
    └──────────┘         └──────┬───────┘         └───────┬───────┘
                                │ N>0 rules               │ RuleCreated
                                ▼                         ▼
                        ┌───────────────┐◄────────────────┘
                        │               │
                        │ list.populated │◄─── RuleCreated / RuleUpdated / RuleFired
                        │               │     RuleDeleted / RuleAutoDisabled
                        └──┬──┬──┬──┬───┘
                           │  │  │  │
              ┌────────────┘  │  │  └────────────────┐
              ▼               ▼  ▼                   ▼
    list.filtering    list.sorting  list.bulk    list.kill-switched
                                    .selecting       (overlay)
```

Each rule row is an independent state machine within `list.populated`:

```
    ┌────────────────────────────────────────────────────┐
    │                  Rule Row States                    │
    │                                                    │
    │  ┌─────────┐  enable  ┌──────────┐  maxFirings/   │
    │  │  draft   ├────────►│  active   ├──TTL/expiresAt │
    │  │ (paused) │◄────────┤          ├──────────────► │
    │  └─────────┘ disable  └────┬─────┘   expired      │
    │       │                    │                       │
    │       │               RuleFired                    │
    │       │                    │                       │
    │       │               ▼ (counter++)                │
    │       │                                            │
    │       │  safety/killswitch                         │
    │       ◄──────────────── disabled-by-safety         │
    │                                                    │
    │  Interaction overlays (composable):                │
    │    .hovering  .selected  .deleting                 │
    └────────────────────────────────────────────────────┘
```

---

## 1. `list.loading`

Initial fetch state. Shown when the Chaos Panel activates and calls `ChaosGetAllRules()`.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | Chaos Panel mounts OR user triggers manual refresh (F5 / pull-to-refresh) |
| **Exit condition** | `ChaosGetAllRules` resolves (success → `list.populated` or `list.empty`) or rejects (→ `list.error`) |
| **Duration** | Typically <100ms (localhost). Show skeleton after 200ms delay to avoid flash. |

### Visual

```
┌──────────────────────────────────────────────────┐
│  Active Rules                              ⟳    │
├──────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────┐    │
│  │  ░░░░░░░░░░░░░░░░░░░░░░  ░░░░  ░░░░░░  │    │  ← skeleton row 1
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │  ░░░░░░░░░░░░░░░░░░░░░░  ░░░░  ░░░░░░  │    │  ← skeleton row 2
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │  ░░░░░░░░░░░░░░░░░░░░░░  ░░░░  ░░░░░░  │    │  ← skeleton row 3
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

- 3 skeleton rows with pulsing `oklch` gradient animation
- `aria-busy="true"` on the list container
- Spinner icon (`⟳`) in header, rotating via CSS animation
- No interactive controls — filter bar and sort controls are disabled (`aria-disabled`)

### Keyboard

- Focus trapped on panel header. Tab does not enter skeleton rows.
- Escape closes the Chaos Panel (returns to previous view).

### Transitions

| Trigger | Next State | Animation |
|---------|-----------|-----------|
| Response: 0 rules | `list.empty` | Skeleton rows fade out (150ms), empty state fades in (200ms) |
| Response: N>0 rules | `list.populated` | Skeleton rows crossfade to real rows (200ms staggered, 30ms per row) |
| Response: error | `list.error` | Skeleton rows collapse, inline error banner slides down |
| SignalR disconnect during load | `list.error` | Same as error |

---

## 2. `list.empty`

No rules exist in the engine (fresh session or all rules deleted).

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `ChaosGetAllRules` returns `[]` OR last rule deleted |
| **Exit condition** | `RuleCreated` event received OR user navigates to Rule Builder |

### Visual

```
┌──────────────────────────────────────────────────┐
│  Active Rules                          [+ New]   │
├──────────────────────────────────────────────────┤
│                                                  │
│              ◇                                   │
│                                                  │
│         No chaos rules yet                       │
│                                                  │
│    Create a rule to start injecting faults       │
│    into FLT's HTTP pipeline.                     │
│                                                  │
│    [Create First Rule]     [Load Preset ▸]       │
│                                                  │
│    Ctrl+N  New rule                              │
│    Ctrl+P  Browse presets                        │
│                                                  │
└──────────────────────────────────────────────────┘
```

- Diamond symbol (`◇`) — decorative, muted color (`--color-text-tertiary`)
- Two action buttons: "Create First Rule" (primary), "Load Preset" (secondary)
- Keyboard hints below buttons in muted text
- Filter/sort controls hidden (nothing to filter)

### Keyboard

| Key | Action |
|-----|--------|
| `Ctrl+N` | Navigate to Rule Builder (create new rule) |
| `Ctrl+P` | Open preset picker dialog |
| `Tab` | Cycle: [+ New] → [Create First Rule] → [Load Preset] |
| `Enter` on focused button | Activate |

### Real-Time Updates

| Event | Behavior |
|-------|----------|
| `RuleCreated` | Transition to `list.populated`. New rule row animates in from top (slide-down 200ms). Empty state fades out (150ms). |

---

## 3. `list.populated`

The primary state. One or more rules visible in a scrollable list.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `ChaosGetAllRules` returns N>0 rules, or first `RuleCreated` after `list.empty` |
| **Exit condition** | Last rule deleted → `list.empty`. Never returns to `list.loading` unless explicit refresh. |

### Visual — List Chrome

```
┌──────────────────────────────────────────────────────────────────┐
│  Active Rules (4)                    [Filter ▾] [Sort ▾] [+ New]│
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ ● Delay OneLake Writes 3s            7/50 fired   3s ago  │  │
│  │   traffic-control · request · p100   ████░░░░░░   active  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ ● Block Spark 429 (30%)              0/∞ fired    —       │  │
│  │   traffic-control · request · p100   ░░░░░░░░░░   paused  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ ● Forge 401 for Token Calls          50/50 fired  2m ago  │  │
│  │   security-probing · request · p50   ██████████   expired │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ ● [Safety] CPU Guard Disabled        12/∞ fired   45s ago │  │
│  │   traffic-control · request · p100   ░░░░░░░░░░   error   │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Rule Row Layout

Each rule row renders:

| Element | Source | Position |
|---------|--------|----------|
| Status dot (`●`) | `lifecycle.state` → color map | Left edge |
| Rule name | `rule.name` (truncate at 40ch with `…`) | Left, primary text |
| Fire counter | `lifecycle.fireCount` / `limits.maxFirings` (or `∞`) | Right of name |
| Last fired | Relative time from `lifecycle.lastFiredAt` (`3s ago`, `2m ago`, `—` if never) | Far right |
| Category + phase + priority | `category · phase · p{priority}` | Second line, muted |
| Progress bar | `fireCount / maxFirings` ratio (or indeterminate if `maxFirings=0`) | Second line |
| State label | `active` / `paused` / `expired` / `error` | Far right, second line |

### Status Dot Color Map

| `lifecycle.state` | Dot Color | OKLCH Token | Label |
|-------------------|-----------|-------------|-------|
| `active` | Green | `--color-status-active` | `active` |
| `active` + rate-limited | Amber | `--color-status-warning` | `rate-limited` |
| `draft` | Grey | `--color-status-muted` | `draft` |
| `paused` | Grey | `--color-status-muted` | `paused` |
| `expired` | Dim grey | `--color-status-expired` | `expired` |
| `disabled-by-safety` | Red | `--color-status-error` | `error` |
| `deleted` | — (not rendered in list) | — | — |

### Default Sort Order

Matches `ChaosGetAllRules` return: `priority ASC`, then `createdAt ASC`.

### Keyboard (list-level)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move focus between rule rows |
| `Home` / `End` | Jump to first/last rule |
| `Ctrl+N` | Navigate to Rule Builder |
| `Ctrl+P` | Open preset picker |
| `Ctrl+A` | Enter bulk selection mode, select all |
| `Ctrl+Shift+K` | Kill switch (all rules) |
| `Ctrl+F` | Focus filter input |
| `F5` | Refresh (re-fetch `ChaosGetAllRules`) |
| `Escape` | Clear filter / exit bulk mode / close panel (cascade) |

### Real-Time Update Behavior

| Event | UI Behavior | Animation |
|-------|-------------|-----------|
| `RuleCreated` | Insert new row at correct sort position. Update count badge `(N)`. | Slide-down + fade-in (200ms). Green highlight flash on new row (300ms). |
| `RuleUpdated` | Update affected row in-place. Re-sort if sort-affecting field changed. | State dot color crossfade (150ms). Label text swap with fade (100ms). |
| `RuleFired` | Increment fire counter on matching row. Update `lastFiredAt` relative time. Advance progress bar. | Counter number rolls up (CSS `counter` transition). Progress bar width transitions (200ms ease). Brief dot pulse animation (scale 1→1.3→1, 200ms). |
| `RuleDeleted` | Remove row. Decrement count badge. If last rule: transition to `list.empty`. | Row collapses vertically (200ms ease-out) then removed from DOM. |
| `RuleAutoDisabled` | Update state to `expired` or `disabled-by-safety`. Update dot color, label, progress bar. | Dot color crossfade. Subtle left-border flash (amber for expired, red for safety). |
| `KillSwitchActivated` | Overlay kill-switch banner (see `list.kill-switched`). All active rule rows transition to error state. | Banner slides down from top (200ms). All green dots simultaneously crossfade to red (100ms). |

### Counter Debouncing

`RuleFired` events can arrive at 5–20/sec per rule during active DAG operations. The frontend **throttles visual updates to 2 repaints/sec** per row:

1. `RuleFired` handler updates the in-memory rule object immediately (counter, timestamp)
2. A `requestAnimationFrame`-gated render cycle batches all pending counter updates
3. The DOM update runs at most every 500ms per row (via last-update timestamp check)

---

## 4. `list.rule.active`

A single rule row whose `lifecycle.state === "active"`. The rule is being evaluated against live traffic.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `RuleUpdated` event with `lifecycle.state: "active"`, OR initial fetch with active rule |
| **Exit condition** | `RuleUpdated` → paused/expired/disabled-by-safety, `RuleDeleted`, `RuleAutoDisabled` |

### Visual

```
┌────────────────────────────────────────────────────────────┐
│ ● Delay OneLake Writes 3s             7/50 fired    3s ago │
│   traffic-control · request · p100    ████░░░░░░    active │
└────────────────────────────────────────────────────────────┘
  ▲                                     ▲              ▲
  green dot                          progress bar    green label
```

- Green status dot with subtle CSS pulse animation (glow every 3s to indicate liveness)
- Fire counter updates live via `RuleFired` events (debounced per §3)
- Progress bar fills from left: `width = (fireCount / maxFirings) * 100%`
  - If `maxFirings === 0`: indeterminate shimmer animation (no defined endpoint)
- `lastFiredAt` shown as relative time, recalculated every 1s via `setInterval`
- `aria-label`: `"Delay OneLake Writes 3s, active, 7 of 50 firings, last fired 3 seconds ago"`

### Keyboard (row-level, when focused)

| Key | Action |
|-----|--------|
| `Enter` | Open rule detail / edit panel |
| `Space` | Toggle enable/disable (calls `ChaosDisableRule`) |
| `Delete` / `Backspace` | Enter `list.deleting` (confirm dialog) |
| `D` | Duplicate rule (calls `ChaosCloneRule` if available, or opens Rule Builder pre-filled) |
| `E` | Open in Rule Builder for editing (must pause first — UI auto-pauses with confirmation) |

### Real-Time Updates (row-specific)

| Event | Effect |
|-------|--------|
| `RuleFired` matching this `ruleId` | Increment counter, update lastFiredAt, advance progress bar, pulse dot |
| `RuleAutoDisabled` matching this `ruleId` | Transition to `list.rule.expired` or `list.rule.error` based on `newState` |
| `RuleUpdated` with state change away from `active` | Transition to matching row state |

---

## 5. `list.rule.paused`

A rule that has been manually disabled by the user (`lifecycle.state === "paused"` or `"draft"`).

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `RuleUpdated` with state `paused`/`draft`, or initial fetch |
| **Exit condition** | User enables → `list.rule.active`. User deletes → `list.deleting`. |

### Visual

```
┌────────────────────────────────────────────────────────────┐
│ ● Block Spark 429 (30%)               0/∞ fired     —     │
│   traffic-control · request · p100    ░░░░░░░░░░    paused │
└────────────────────────────────────────────────────────────┘
  ▲                                                    ▲
  grey dot (no pulse)                              grey label
```

- Grey status dot, no animation
- Row text at reduced opacity (`0.7`) to visually recede behind active rules
- Progress bar empty, muted color
- `lastFiredAt` shows `—` if `null`, or frozen relative time from last firing before pause
- `aria-label`: `"Block Spark 429 30 percent, paused, 0 firings"`

### Keyboard

| Key | Action |
|-----|--------|
| `Enter` | Open rule detail |
| `Space` | Toggle enable (calls `ChaosEnableRule` — may fail if no limits set → show inline error toast) |
| `Delete` | Enter `list.deleting` |
| `E` | Open in Rule Builder for editing (allowed — rule is already paused) |

### Real-Time Updates

| Event | Effect |
|-------|--------|
| `RuleUpdated` with state → `active` | Transition to `list.rule.active`. Row opacity animates to 1.0. Dot crossfades green. |
| `RuleDeleted` | Row collapse animation, remove from DOM. |

---

## 6. `list.rule.expired`

A rule that auto-disabled because it hit `maxFirings`, `ttlSeconds`, or `expiresAt`.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `RuleAutoDisabled` event with `newState: "expired"` |
| **Exit condition** | User deletes, clones, or re-enables after resetting limits |

### Visual

```
┌────────────────────────────────────────────────────────────┐
│ ● Forge 401 for Token Calls          50/50 fired    2m ago │
│   security-probing · request · p50   ██████████    expired │
└────────────────────────────────────────────────────────────┘
  ▲                                    ▲               ▲
  dim grey dot                    full bar (muted)  amber label
```

- Dim grey dot, no animation
- Row opacity `0.6`
- Progress bar full but in muted color (not green)
- `expired` label in amber/muted tone
- Strikethrough-style bottom border or subtle diagonal hash overlay to indicate finality
- Reason tooltip on hover: `"maxFirings reached (50/50)"` or `"ttlSeconds reached (300s)"`
- `aria-label`: `"Forge 401 for Token Calls, expired, 50 of 50 firings, reason: maxFirings reached"`

### Keyboard

| Key | Action |
|-----|--------|
| `Enter` | Open rule detail (read-only view with audit log) |
| `Space` | No-op with subtle shake animation (cannot re-enable expired rule without editing limits) |
| `D` | Clone rule (creates copy in `draft` state with reset counters) |
| `Delete` | Enter `list.deleting` |
| `E` | Open in Rule Builder for editing (transitions to `draft`, resets counters after confirmation) |

### Transition Animation

When a `RuleAutoDisabled` event arrives for an active rule:

1. Green dot crossfades to dim grey (200ms)
2. `active` label crossfades to `expired` (150ms)
3. Left-border flashes amber (300ms, fades out)
4. Brief toast notification: `"Rule expired: {ruleName} — {reason}"` (auto-dismiss 4s)

---

## 7. `list.rule.error`

A rule disabled by the safety system (`lifecycle.state === "disabled-by-safety"`).

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `RuleAutoDisabled` with `newState: "disabled-by-safety"`, or `KillSwitchActivated` |
| **Exit condition** | Kill switch reset + user manually re-enables, or user deletes |

### Visual

```
┌────────────────────────────────────────────────────────────┐
│ ● [Safety] CPU Guard Disabled         12/∞ fired    45s ago│
│   traffic-control · request · p100    ░░░░░░░░░░    error  │
│   ▸ Safety: FLT error rate >50% for 10s                    │
└────────────────────────────────────────────────────────────┘
  ▲                                                    ▲
  red dot                                          red label
```

- Red status dot, solid (no pulse)
- `[Safety]` prefix badge on the rule name if disabled by health guard
- Third line with `disableReason` in muted red, preceded by `▸` indicator
- Row has a subtle left-border in `--color-status-error` (2px solid)
- `aria-label`: `"CPU Guard Disabled, error, disabled by safety, reason: FLT error rate above 50 percent"`

### Keyboard

| Key | Action |
|-----|--------|
| `Enter` | Open rule detail with audit log showing the safety event |
| `Space` | If kill switch active → inline error: "Kill switch active. Reset first (Ctrl+Shift+R)". If kill switch reset → calls `ChaosEnableRule` (transitions to `list.rule.active`). |
| `Delete` | Enter `list.deleting` |

### Transition Animation

When safety disables a rule:

1. Green/amber dot crossfades to red (100ms — fast, because safety = urgency)
2. Left-border appears (red, 2px, slide-in from left 150ms)
3. Reason line slides down into view (200ms)
4. Toast notification with `severity: "warning"`: `"Safety disabled: {ruleName} — {reason}"`

---

## 8. `list.rule.hovering`

Composable overlay state — applied ON TOP of any rule row state when the pointer hovers.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | Mouse enters rule row bounding box |
| **Exit condition** | Mouse leaves row, OR keyboard navigation moves focus away |
| **Composable with** | `list.rule.active`, `list.rule.paused`, `list.rule.expired`, `list.rule.error` |

### Visual

```
┌────────────────────────────────────────────────────────────┐
│ ● Delay OneLake Writes 3s     7/50 fired  3s ago  [⏸][✕] │
│   traffic-control · request · p100  ████░░░  active  [⋯]  │
└────────────────────────────────────────────────────────────┘
                                                      ▲
                                              action buttons
                                             revealed on hover
```

- Background color shifts to `--color-surface-hover` (subtle, 100ms transition)
- Action buttons appear at right edge (fade-in 100ms):
  - `[⏸]` / `[▸]` — Pause/Resume toggle (icon changes based on state)
  - `[✕]` — Delete
  - `[⋯]` — More actions menu (Clone, Edit, Export, View Audit)
- Buttons are `24×24px` touch targets with `4px` gap (4px grid)
- Buttons hidden for `expired` rules: show only `[⋯]` and `[✕]`
- `aria-hidden="true"` on hover buttons (keyboard users use row-level shortcuts instead)

### Keyboard

Hover state is mouse-only. Keyboard equivalent is focus state (`:focus-visible` outline on the row), which reveals the same action context via shortcuts printed in the detail panel.

---

## 9. `list.rule.selected`

A rule row selected for detail view or as part of a bulk selection.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `Enter` on focused row (single select) OR checkbox click in bulk mode |
| **Exit condition** | `Escape` to deselect, select different row, or exit bulk mode |
| **Composable with** | Any rule state. In bulk mode, composable with `list.bulk.selecting`. |

### Visual — Single Select

```
┌═══════════════════════════════════════════════════════════════┐
║ ● Delay OneLake Writes 3s            7/50 fired      3s ago ║
║   traffic-control · request · p100   ████░░░░░░      active ║
└═══════════════════════════════════════════════════════════════┘
  ▲
  2px left + right border in --color-accent
```

- Highlighted border (`2px` left + right in `--color-accent`)
- Background: `--color-surface-selected`
- Opens detail panel below or to the right (depends on panel width):
  - Width ≥ 800px: side-by-side (list left, detail right)
  - Width < 800px: detail panel pushes down below selected row (accordion)

### Visual — Bulk Select

```
┌──────────────────────────────────────────────────────────────┐
│ [☑] ● Delay OneLake Writes 3s        7/50 fired      3s ago │
│       traffic-control · request       ████░░░░░░      active │
├──────────────────────────────────────────────────────────────┤
│ [☑] ● Block Spark 429 (30%)          0/∞ fired        —     │
│       traffic-control · request       ░░░░░░░░░░      paused │
├──────────────────────────────────────────────────────────────┤
│ [☐] ● Forge 401 for Token Calls      50/50 fired     2m ago │
│       security-probing · request      ██████████     expired │
└──────────────────────────────────────────────────────────────┘
```

- Checkbox appears at left edge of each row
- Selected rows get `--color-surface-selected` background
- Checkboxes are `16×16px`, aligned to 4px grid

### Keyboard

| Key | Action |
|-----|--------|
| `Escape` | Deselect (single) or exit bulk mode |
| `Enter` | Open detail panel for focused selected row |
| `Space` (bulk mode) | Toggle checkbox on focused row |

---

## 10. `list.deleting`

Confirmation dialog before soft-deleting a rule.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `Delete` key on focused rule, OR click `[✕]` button on hover |
| **Exit condition** | User confirms → rule deleted. User cancels → return to previous state. |

### Visual

```
┌────────────────────────────────────────────────────────────┐
│ ● Delay OneLake Writes 3s            7/50 fired    3s ago  │
│   traffic-control · request · p100   ████░░░░░░    active  │
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│  Delete "Delay OneLake Writes 3s"?                         │
│  This rule has fired 7 times. It can be recovered          │
│  within 24 hours.                                          │
│                              [Cancel]  [Delete Rule]       │
└────────────────────────────────────────────────────────────┘
```

- Inline confirmation panel expands below the target row (slide-down 150ms)
- Rule row dims to `0.5` opacity
- Confirmation text includes fire count context
- Recovery window mentioned ("recovered within 24 hours" — matches soft-delete spec)
- `[Delete Rule]` button is destructive style (`--color-status-error` background)
- If rule is `active`, extra warning: "This rule is currently active. It will be disabled before deletion."
- Focus moves to `[Cancel]` by default (safe default)
- `role="alertdialog"`, `aria-modal="true"` on the confirmation region

### Keyboard

| Key | Action |
|-----|--------|
| `Escape` | Cancel — collapse confirmation, return focus to row |
| `Tab` | Cycle between [Cancel] and [Delete Rule] |
| `Enter` on [Delete Rule] | Invoke `ChaosDeleteRule(ruleId)`. On success: row collapse animation (200ms). On error: inline error toast. |
| `Enter` on [Cancel] | Same as Escape |

### Bulk Delete

In `list.bulk.selecting`, if the user invokes delete, the confirmation dialog changes:

```
Delete 3 selected rules?
2 active rules will be disabled first. All rules recoverable within 24 hours.
                                    [Cancel]  [Delete 3 Rules]
```

---

## 11. `list.bulk.selecting`

Multi-select mode for batch operations (enable all, disable all, delete selected, export selected).

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `Ctrl+A` (select all), or `Ctrl+Click` on any row, or "Select" button in toolbar |
| **Exit condition** | `Escape`, or all selections removed, or batch action completed |

### Visual — Toolbar

```
┌──────────────────────────────────────────────────────────────┐
│  3 selected   [Enable All] [Disable All] [Delete] [Export]  │
│  ☐ Select All                                    [✕ Cancel]  │
├──────────────────────────────────────────────────────────────┤
│  [☑] ● Delay OneLake Writes 3s  ...                         │
│  [☑] ● Block Spark 429 (30%)    ...                         │
│  [☐] ● Forge 401 for Token Calls ...                        │
│  [☑] ● [Safety] CPU Guard ...    ...                         │
└──────────────────────────────────────────────────────────────┘
```

- Batch action toolbar replaces the filter/sort bar
- Selection count badge: `"3 selected"`
- [Select All] checkbox in toolbar header
- Action buttons enabled/disabled based on selected rules' states:
  - [Enable All]: enabled if any selected rule is `paused`/`draft`
  - [Disable All]: enabled if any selected rule is `active`
  - [Delete]: always enabled when selection > 0
  - [Export]: always enabled (exports selected rules as JSON)
- `[✕ Cancel]` button to exit bulk mode
- Each row gets a checkbox column (16px, left edge)

### Keyboard

| Key | Action |
|-----|--------|
| `Ctrl+A` | Toggle select all / deselect all |
| `Space` | Toggle checkbox on focused row |
| `↑` / `↓` | Navigate rows (focus moves, selection unchanged) |
| `Shift+↑` / `Shift+↓` | Extend selection range |
| `Escape` | Exit bulk mode, remove all selections |
| `Delete` | Bulk delete confirmation (see §10) |
| `E` | Bulk enable selected |
| `D` (Shift+D) | Bulk disable selected |

### Real-Time Updates During Bulk Mode

| Event | Behavior |
|-------|----------|
| `RuleCreated` | New row appears, unchecked. Count badge unchanged. |
| `RuleDeleted` (external) | Row removed. If it was selected, decrement count. |
| `RuleFired` | Counter updates on matching rows (even if selected). |
| `KillSwitchActivated` | Exit bulk mode. Transition to `list.kill-switched`. |
| `RuleAutoDisabled` | Update affected row state. If it was selected and active → now expired, update toolbar button states. |

---

## 12. `list.kill-switched`

Overlay state when the kill switch is active. The engine is locked — no rules can be enabled.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `KillSwitchActivated` event received |
| **Exit condition** | `KillSwitchReset` event (after `ChaosResetKillSwitch` call) |
| **Composable with** | `list.populated` (overlay), `list.empty` (overlay) |

### Visual

```
┌══════════════════════════════════════════════════════════════┐
║  ◆ KILL SWITCH ACTIVE — All chaos rules disabled            ║
║    Engine locked. No rules can fire.        [Reset Switch]  ║
╞══════════════════════════════════════════════════════════════╡
│  ● [Safety] Delay OneLake ...         7/50 fired    3s ago  │
│    traffic-control · request · p100   ████░░░░░░    error   │
│  ● [Safety] Block Spark ...           0/∞ fired      —      │
│    traffic-control · request · p100   ░░░░░░░░░░    error   │
│  ... (all rows show error state)                             │
└──────────────────────────────────────────────────────────────┘
```

- **Banner**: full-width, `--color-status-error` background at reduced opacity, white text
- `◆` diamond icon, bold text, [Reset Switch] button at right
- Banner is sticky (stays at top when scrolling rules)
- All rule rows that were `active` transition to `list.rule.error` with `disableReason: "Kill switch activated"`
- All enable/toggle controls across the panel are disabled (`aria-disabled="true"`) with tooltip: "Kill switch active"
- [+ New] and [Load Preset] still work (rules created in `draft` state, just can't be enabled)
- Keyboard shortcut `Ctrl+Shift+R` to reset kill switch

### Keyboard

| Key | Action |
|-----|--------|
| `Ctrl+Shift+R` | Focus [Reset Switch] button, then Enter to confirm |
| `Ctrl+Shift+K` | No-op (kill switch already active). Brief flash on banner to acknowledge. |
| Other keys | Normal list navigation. Enable/Space on rows shows disabled tooltip. |

### Reset Behavior

On `KillSwitchReset`:

1. Banner slides up and out (200ms)
2. Rule rows remain in `disabled-by-safety` state (NOT auto-re-enabled — spec §1.2 says "user must explicitly re-enable")
3. Enable controls become interactive again
4. Toast: `"Kill switch reset. Re-enable rules individually to resume chaos."`

---

## 13. `list.filtering`

User is filtering the rule list by category, status, tag, or text search.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | User opens filter dropdown, or types in search field (`Ctrl+F`), or clicks category chip |
| **Exit condition** | Filter cleared (Escape, ✕ button, or clear search) |

### Visual

```
┌──────────────────────────────────────────────────────────────┐
│  Active Rules (2 of 4)          [Filter ▾ ●] [Sort ▾] [+]  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Category: [traffic-control ✕]    Status: [active ✕]   │  │
│  │ Search: [onelake____________]                  [Clear] │  │
│  └────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│  ● Delay OneLake Writes 3s           7/50 fired      3s ago │
│  ● Block Spark 429 (30%)             0/∞ fired         —    │
├──────────────────────────────────────────────────────────────┤
│  2 rules hidden by filter                                    │
└──────────────────────────────────────────────────────────────┘
```

- Filter bar expands below the header when active
- Active filter shown as removable chips (`[traffic-control ✕]`)
- Filter indicator dot (`●`) on the [Filter] button when filters active
- Count badge changes: `"2 of 4"` showing visible/total
- Hidden rules are NOT removed from DOM — they get `display: none` (preserves scroll position on filter clear)
- "N rules hidden by filter" footer line in muted text
- Search field does case-insensitive substring match on: `name`, `description`, `id`, `tags[]`, `category`

### Filter Dimensions

| Dimension | Control | Values |
|-----------|---------|--------|
| Category | Multi-select dropdown | `request-surgery`, `response-forgery`, `traffic-control`, `security-probing`, `observability`, `advanced` |
| Status | Multi-select dropdown | `active`, `paused`, `expired`, `error` (maps to `disabled-by-safety`), `draft` |
| Tags | Typeahead multi-select | Union of all `tags[]` across rules |
| Text search | Text input | Substring match across name, description, id, tags |

### Keyboard

| Key | Action |
|-----|--------|
| `Ctrl+F` | Focus search input |
| `Escape` (in search input) | Clear search text. If already empty, close filter bar. |
| `Escape` (in filter bar) | Close filter bar, clear all filters |
| `Tab` | Navigate filter controls (category → status → tags → search → [Clear]) |
| `Backspace` on chip | Remove that filter dimension |

### Real-Time Updates While Filtering

| Event | Behavior |
|-------|----------|
| `RuleCreated` | Apply current filter to new rule. If matches → insert in visible list, update counts. If not → increment hidden count only. |
| `RuleUpdated` (state change) | Re-evaluate filter. Rule may move between visible/hidden. Update counts. |
| `RuleDeleted` | Remove from appropriate bucket (visible or hidden). Update counts. |
| `RuleFired` | Update counters on visible rows. Hidden rows still update in-memory (visible when filter cleared). |

---

## 14. `list.sorting`

User has changed the sort order from the default.

| Attribute | Value |
|-----------|-------|
| **Entry condition** | User selects a sort option from [Sort ▾] dropdown |
| **Exit condition** | User resets to default sort, or navigates away |

### Sort Options

| Option | Field | Default Direction | Notes |
|--------|-------|-------------------|-------|
| Priority (default) | `priority` ASC, `createdAt` ASC | Ascending | Matches engine evaluation order |
| Name | `name` | A→Z | Alphabetical |
| Most Firings | `lifecycle.fireCount` | Descending | Most active rules first |
| Last Fired | `lifecycle.lastFiredAt` | Descending (most recent first) | `null` sorts to bottom |
| Newest First | `lifecycle.createdAt` | Descending | Creation time |
| Status | `lifecycle.state` | Active → Draft → Paused → Expired → Error | State priority order |

### Visual

```
┌──────────────────────────────────────────────────────────────┐
│  Active Rules (4)            [Filter ▾] [Sort: Firings ▾▼]  │
```

- Sort dropdown shows current sort with direction arrow (`▲` ascending, `▼` descending)
- Click current sort to toggle direction
- Sort is **client-side** (full rule set is in memory after initial fetch)
- Sort is **stable** — rules with equal sort values maintain relative order

### Real-Time Updates While Sorted

| Event | Behavior |
|-------|----------|
| `RuleCreated` | Insert at correct position per current sort. |
| `RuleFired` (sort by firings) | Re-evaluate position. If sort order changes, animate row to new position (slide up/down 200ms). Cap re-sort frequency to once per 2 seconds to prevent visual thrashing. |
| `RuleAutoDisabled` (sort by status) | Move rule to appropriate status group with animation. |

---

## 15. `list.error`

Unrecoverable error state for the list itself (not an individual rule).

| Attribute | Value |
|-----------|-------|
| **Entry condition** | `ChaosGetAllRules` fails, SignalR disconnect, or JS runtime error in list module |
| **Exit condition** | User retries (button or F5), or SignalR reconnects |

### Visual

```
┌──────────────────────────────────────────────────────────────┐
│  Active Rules                                         ⟳     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│              ◆                                               │
│                                                              │
│         Failed to load chaos rules                           │
│                                                              │
│    SignalR connection lost. The FLT service may have         │
│    stopped or the hub endpoint is unreachable.               │
│                                                              │
│    [Retry]                                                   │
│                                                              │
│    If this persists, check the FLT process is running        │
│    and EDOG interceptors are registered.                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- Red diamond icon (`◆`)
- Actionable error message with likely cause
- [Retry] button (calls `ChaosGetAllRules` again)
- If previous rules were visible, keep stale data with a yellow degraded-connection banner at top:

```
┌══════════════════════════════════════════════════════════════┐
║  ▲ Connection lost — rules may be stale     [Reconnect]     ║
╞══════════════════════════════════════════════════════════════╡
│  (previous rule rows still visible but greyed out)           │
```

### Keyboard

| Key | Action |
|-----|--------|
| `Enter` on [Retry] / [Reconnect] | Re-attempt fetch. Transition to `list.loading`. |
| `F5` | Same as Retry |

---

## Cross-Cutting Concerns

### Accessibility

| Concern | Implementation |
|---------|----------------|
| Screen reader | Each rule row is `role="row"` inside a `role="grid"`. Status announced via `aria-label`. |
| Live regions | Fire counter updates use `aria-live="polite"` with debounced announcements (max 1/5s). |
| Kill switch | Banner is `role="alert"` — announced immediately. |
| Focus management | After delete, focus moves to next row (or previous if last). After bulk action, focus moves to first remaining selected or toolbar. |
| Reduced motion | `prefers-reduced-motion: reduce` → all animations become instant (0ms). Pulse and shimmer disabled. |

### Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Initial render (50 rules) | < 16ms | Single `requestAnimationFrame` paint |
| `RuleFired` → DOM update | < 50ms (throttled to 2/s) | Counter and progress bar only |
| Sort (50 rules) | < 1ms | Client-side `Array.sort`, pre-computed comparators |
| Filter (50 rules) | < 1ms | CSS `display: none` toggle, no DOM removal |
| Bulk select/deselect all | < 5ms | Single pass, batch DOM update |

### Data Freshness

The list maintains a **client-side rule store** (JS `Map<string, ChaosRule>`):

1. **Bootstrap**: `ChaosGetAllRules()` populates the store on panel mount
2. **Live sync**: SignalR events incrementally update the store:
   - `RuleCreated` → `store.set(rule.id, rule)`
   - `RuleUpdated` → merge `changes` into existing rule
   - `RuleDeleted` → `store.delete(ruleId)`
   - `RuleFired` → increment `fireCount`, update `lastFiredAt`
   - `RuleAutoDisabled` → update `lifecycle.state`, set `disableReason`
3. **Conflict resolution**: Each event carries `lifecycle.version`. If incoming version ≤ stored version, the event is stale and ignored. If incoming version > stored version + 1, a full refresh is triggered (missed event).
4. **Reconnection**: On SignalR reconnect, perform full `ChaosGetAllRules()` to reconcile. Diff against store and animate only changed rows.

### State Persistence (Session)

| Item | Persisted? | Storage |
|------|-----------|---------|
| Filter settings | Yes (session) | `sessionStorage` key `edog:chaos:filter` |
| Sort preference | Yes (session) | `sessionStorage` key `edog:chaos:sort` |
| Selected rule | No | Cleared on navigation |
| Bulk selection | No | Cleared on navigation |
| Scroll position | Yes (session) | Restored on panel re-mount |
| Kill switch state | Engine-managed | Fetched on connect via `ChaosGetEngineStatus` |

---

## State × Event Matrix (Summary)

Quick-reference grid: rows = list states, columns = SignalR events.

| State | `RuleCreated` | `RuleFired` | `RuleUpdated` | `RuleDeleted` | `RuleAutoDisabled` | `KillSwitchActivated` |
|-------|---------------|-------------|---------------|---------------|---------------------|----------------------|
| `list.loading` | Queue (apply after load) | Queue | Queue | Queue | Queue | Queue |
| `list.empty` | → `list.populated` | N/A | N/A | N/A | N/A | Show banner (no rules) |
| `list.populated` | Insert row | Update counter | Update row | Remove row | Update row state | → `list.kill-switched` |
| `list.filtering` | Insert if matches filter | Update visible | Re-evaluate filter | Remove + update counts | Re-evaluate filter | → `list.kill-switched` |
| `list.sorting` | Insert at sort position | Re-sort (throttled) | Re-sort if field changed | Remove + close gap | Re-sort by status | → `list.kill-switched` |
| `list.bulk.selecting` | Add unchecked row | Update counter | Update row | Remove + update count | Update row + toolbar | Exit bulk → `kill-switched` |
| `list.kill-switched` | Add as `draft` | N/A (engine locked) | Update row | Remove row | N/A | Flash banner |
| `list.deleting` | Insert row (behind dialog) | Update counter | Update row | Auto-close dialog | Update row state | Close dialog → `kill-switched` |
| `list.error` | Queue | Queue | Queue | Queue | Queue | Queue |
