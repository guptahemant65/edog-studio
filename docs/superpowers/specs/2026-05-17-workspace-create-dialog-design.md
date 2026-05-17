# Create Workspace Dialog — Design Spec

**Date:** 2026-05-17
**Feature:** Workspace Explorer — Create Workspace
**Mockup:** `docs/design/mocks/workspace-create-dialog.html`
**Status:** Approved by user

---

## Summary

Replace the current bare inline form (name input + native `<select>`) with a proper modal dialog covering all creation states. The dialog is triggered by the existing `+` button in the workspace tree header and the "Create Workspace" context menu action.

## Architecture

- **Component:** `WorkspaceCreateDialog` — new class in `workspace-explorer.js` (inline, not a separate file per ADR-003 single-HTML constraint)
- **CSS prefix:** `.ws-cd-` (workspace create-dialog)
- **Singleton:** Only one dialog can be open at a time
- **Integration:** Called from `_showCreateWorkspaceInput()` (replaces current inline form logic)

## Fields

### 1. Workspace Name
- Text input, auto-focused on open
- Real-time validation:
  - Min 3 characters → inline error "Name must be at least 3 characters"
  - Max 256 characters → hard limit, character counter shows `n / 256`
  - Allowed chars: letters, numbers, hyphens, underscores, spaces → inline error "Only letters, numbers, hyphens, underscores, spaces"
  - Duplicate detection: compare against `existingWorkspaces` array → inline error "A workspace with this name already exists"
- Green checkmark icon when valid
- Red border + shake animation on invalid submit attempt

### 2. Capacity Picker
- Styled card-based selector (not native `<select>`)
- Async load from `api.listCapacities()` on dialog open
- Each capacity card shows: display name, SKU badge (F2, F64, etc.), region
- "Default capacity" option always first (no specific capacity assigned)
- Radio-style single selection

## State Matrix

| # | State | Trigger | Visual Treatment |
|---|-------|---------|------------------|
| 1 | **Empty** | Dialog opens | Name input focused, Create btn disabled, capacity loading shimmer |
| 2 | **Valid name** | User types 3+ valid chars | Green checkmark, counter updates, Create still disabled until capacity resolves |
| 3 | **Invalid — too short** | User types < 3 chars then blurs or submits | Red border, inline error below input |
| 4 | **Invalid — duplicate** | Name matches existing workspace | Red border, inline error "already exists" |
| 5 | **Invalid — bad chars** | Regex mismatch | Red border, inline error "Only letters, numbers..." |
| 6 | **Capacity loading** | Dialog opens (async) | Skeleton shimmer rows in capacity area |
| 7 | **Capacity loaded** | API responds | Cards animate in with spring entrance |
| 8 | **Capacity load failed** | API error/timeout | Error card with retry button |
| 9 | **No auth** | No bearer token | Form disabled, overlay "Sign in to create workspaces" |
| 10 | **Ready** | Valid name + capacity selected | Create btn becomes accent, pulses |
| 11 | **Creating** | User clicks Create | Spinner in btn, inputs disabled, progress bar |
| 12 | **Success** | API 2xx | checkPop animation, green state, "Open Workspace" btn, auto-close 3s |
| 13 | **API failure** | API error | Red error banner slides in, Retry + Cancel buttons, form stays editable |

## Animations (from mockup)

- `dialogIn` — modal rises into place (scale + translateY)
- `scaleSpring` — capacity cards enter with spring overshoot
- `checkPop` — success completion animation
- `pulseAccent` — breathing glow on ready-state Create button
- `shakeX` — invalid input horizontal shake
- `fadeSlideDown` — error banner entrance
- `shimmer` — skeleton loading pulse

## Keyboard

| Key | Action |
|-----|--------|
| Tab | Name → Capacity cards → Create → Cancel |
| Enter | Submit (if valid) |
| Escape | Close dialog (confirm if dirty) |
| Arrow keys | Navigate capacity cards |

## API Integration

```
POST /api/fabric/workspaces
Body: { displayName: string, capacityId?: string }
Response: { id: string, displayName: string, ... }
```

On success: refresh workspace list, expand + select new workspace in tree.

## Dirty Form Protection

If user has typed a name and clicks overlay or presses Escape, show a confirm prompt: "Discard workspace creation?" with Discard / Keep Editing buttons.

## Files Modified

1. `src/frontend/js/workspace-explorer.js` — replace `_showCreateWorkspaceInput()` with `WorkspaceCreateDialog`
2. `src/frontend/css/workspace.css` — add `.ws-cd-*` styles
3. Existing `.ws-create-*` styles can be removed (superseded)
