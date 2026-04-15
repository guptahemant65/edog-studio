# P3 State Matrices — Form Pages (C02 + C03)

> **Feature:** F16 — New Infra Wizard
> **Components:** C02-InfraSetupPage, C03-ThemeSchemaPage
> **Authored by:** Pixel (Form UX & Selection Pattern State Machine Specialist)
> **Status:** P3 — COMPLETE
> **Last Updated:** 2025-07-20

---

## Table of Contents

1. [C02 — InfraSetupPage State Matrix (25 states)](#c02--infra-setup-page-state-matrix)
2. [C03 — ThemeSchemaPage State Matrix (20 states)](#c03--theme-schema-page-state-matrix)
3. [Cross-Component Transition Map](#cross-component-transition-map)

---

# C02 — InfraSetupPage State Matrix

## S01 — `setup.page.uninitialized`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.page.uninitialized` |
| **Entry conditions** | InfraWizardDialog constructor creates InfraSetupPage instance. DOM container element exists but is empty. |
| **Exit conditions** | `constructor()` completes → `_render()` builds DOM → transitions to `setup.page.rendered` |
| **Visual description** | Empty `.page` container. No visible form fields. Parent wizard chrome (header, stepper, footer) may already be visible. |
| **Active DOM elements** | Visible: none inside page container. Hidden: all form elements (not yet created). Disabled: N/A. |
| **Keyboard shortcuts** | None active — page has no focusable elements. |
| **Data requirements** | `options.apiClient`, `options.existingWorkspaces`, `options.onValidationChange`, `options.containerEl` all must be injected. No API calls yet. |
| **Transitions** | → `setup.page.rendered` (on constructor completion) |
| **Error recovery** | If `containerEl` is null → `throw Error('InfraSetupPage: container element is required')`. Constructor fails, wizard cannot proceed. |
| **Animation** | None. Instantaneous state. |

---

## S02 — `setup.page.rendered`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.page.rendered` |
| **Entry conditions** | `_render()` has built all DOM: 4 form groups (workspace, capacity, lakehouse, notebook), labels, inputs, hints, randomize button. `_bindEvents()` attached all listeners. |
| **Exit conditions** | `activate()` called by parent → transitions to `setup.page.loading` |
| **Visual description** | All form fields present but empty. Workspace input is blank (no placeholder text yet). Capacity dropdown shows "Select capacity..." placeholder. Lakehouse and notebook inputs are blank. "auto" badges visible on lakehouse/notebook labels. No checkmarks. No errors. All borders use `--border-bright`. |
| **Active DOM elements** | Visible: all form groups, labels, inputs, hints, randomize button, "Coming Soon" capacity link. Hidden: checkmarks (`.input-icon.valid` opacity 0), error messages. Disabled: none (but form is functionally inert until activated). |
| **Keyboard shortcuts** | Standard Tab navigation available. No custom shortcuts active. |
| **Data requirements** | None — DOM is static, no data loaded. |
| **Transitions** | → `setup.page.loading` (on `activate()` — first time) |
| **Error recovery** | N/A — static DOM state. |
| **Animation** | None — DOM built synchronously. |

---

## S03 — `setup.page.loading`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.page.loading` |
| **Entry conditions** | `activate()` called for the first time. Triggers two parallel operations: `_generateRandomName()` (sync) and `_loadCapacities()` (async). |
| **Exit conditions** | Both name generation completes AND capacity fetch resolves (success or failure) → transitions to `setup.page.active` |
| **Visual description** | Workspace input populates with random Docker-style name (e.g., "bold_lamport_73"). Lakehouse auto-fills with `{name}_lakehouse`. Notebook auto-fills with `{name}_notebook`. Capacity dropdown shows "Loading capacities..." in a disabled state with `opacity: 0.5`. Form groups stagger-animate in: workspace (50ms), capacity (100ms), lakehouse+notebook row (150ms). |
| **Active DOM elements** | Visible: all form groups animating in, random name in workspace, auto-synced names in lakehouse/notebook. Disabled: capacity dropdown (`<select disabled>`, `aria-busy="true"`). Hidden: checkmarks, errors. |
| **Keyboard shortcuts** | `Tab` navigates fields. `Space`/`Enter` on randomize button triggers re-roll. Arrow keys in capacity dropdown are blocked (disabled). |
| **Data requirements** | `existingWorkspaces[]` accessed for collision-free name generation. `apiClient.listCapacities()` in-flight. |
| **Transitions** | → `setup.page.active` (capacity loaded or failed, name generated) |
| **Error recovery** | Name generation: if all 5 random attempts collide, fallback appends timestamp fragment. Capacity load: failure transitions capacity dropdown to error state but page still reaches `active`. |
| **Animation** | Form groups: `slideUp` keyframe (opacity 0→1, translateY 12px→0) with staggered delays (50ms, 100ms, 150ms). 400ms duration, `var(--ease)` timing. |

---

## S04 — `setup.page.active`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.page.active` |
| **Entry conditions** | Page loading complete. Name generated. Capacity fetch resolved. Page is the current visible wizard page. |
| **Exit conditions** | `deactivate()` called (user navigates to Page 2) → `setup.page.inactive`. OR `destroy()` called → `setup.page.destroyed`. |
| **Visual description** | Full interactive form. Workspace shows generated name. Capacity dropdown shows loaded options (or error/empty state). Lakehouse and notebook show auto-synced names. Checkmarks appear on fields that pass validation. Form validity emitted to parent (controls Next button). |
| **Active DOM elements** | Visible: all form fields, populated data, checkmarks on valid touched fields, hint text. Hidden: error messages (if no validation failures). Disabled: none (unless capacity errored). |
| **Keyboard shortcuts** | `Tab`/`Shift+Tab` navigate field order: workspace → randomize → capacity → lakehouse → notebook. `Enter` on any field → parent handles (Next). `Escape` → parent handles (close wizard). `Space`/`Enter` on randomize → re-roll name. `Arrow Down/Up` in capacity → native select behavior. |
| **Data requirements** | `existingWorkspaces[]` for collision checking. Capacity list cached in memory. Form validation state computed. `onValidationChange(isFormValid)` callback active. |
| **Transitions** | → `setup.page.inactive` (deactivate), → `setup.workspace.*` (user interacts with workspace field), → `setup.capacity.*` (user interacts with capacity), → `setup.lakehouse.*` / `setup.notebook.*` (user interacts with child fields) |
| **Error recovery** | N/A — umbrella state. Individual field errors handled in sub-states. |
| **Animation** | None on entry (animations played during `loading`). Checkmarks fade-in 150ms on validation. |

---

## S05 — `setup.page.inactive`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.page.inactive` |
| **Entry conditions** | `deactivate()` called — user navigated forward to Page 2 (or later). |
| **Exit conditions** | `activate(wizardState)` called again (user navigated Back) → `setup.page.active`. OR `destroy()` called → `setup.page.destroyed`. |
| **Visual description** | Page is not visible (display: none or slide-out animation completed). DOM and state persist in memory. |
| **Active DOM elements** | All hidden (page container not displayed). No focusable elements. |
| **Keyboard shortcuts** | None — page is offscreen. |
| **Data requirements** | All form state persisted in instance variables. No API calls. Capacity list cached. |
| **Transitions** | → `setup.page.active` (re-activation via Back navigation — no re-fetch, no re-animate), → `setup.page.destroyed` |
| **Error recovery** | N/A — dormant state. |
| **Animation** | Exit: page slides out (handled by parent C01 transition system). Re-entry: no stagger animation replay (already animated once). |

---

## S06 — `setup.page.destroyed`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.page.destroyed` |
| **Entry conditions** | `destroy()` called — wizard closed. `_unbindEvents()` removes all listeners. DOM references cleared. |
| **Exit conditions** | Terminal state. No transitions out. |
| **Visual description** | Nothing — DOM elements removed or orphaned. |
| **Active DOM elements** | None. |
| **Keyboard shortcuts** | None. |
| **Data requirements** | None — all references nulled. |
| **Transitions** | None (terminal). |
| **Error recovery** | `destroy()` is idempotent — safe to call multiple times. |
| **Animation** | None. |

---

## S07 — `setup.workspace.pristine`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.workspace.pristine` |
| **Entry conditions** | Page activated, random name generated and placed in workspace input. User has not yet interacted with the field. Field has value but `touched` flag is `false`. |
| **Exit conditions** | User focuses (clicks/tabs into) the workspace input → `setup.workspace.focused`. OR user clicks randomize → `setup.workspace.randomizing`. |
| **Visual description** | Workspace input contains Docker-style name (e.g., "bold_lamport_73") in `--mono` font. Border is `1px solid var(--border-bright)`. No checkmark (not yet touched). Hint shows: "● Unique name, underscores allowed" in `--text-muted`. No error. |
| **Active DOM elements** | Visible: input with random name, hint text, randomize button. Hidden: checkmark, error text. |
| **Keyboard shortcuts** | `Tab` into field triggers `setup.workspace.focused`. |
| **Data requirements** | Random name already generated. `existingWorkspaces[]` available. |
| **Transitions** | → `setup.workspace.focused` (focus event), → `setup.workspace.randomizing` (randomize click) |
| **Error recovery** | N/A — known-good random name. |
| **Animation** | None — steady state. |

---

## S08 — `setup.workspace.focused`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.workspace.focused` |
| **Entry conditions** | User clicks into or Tabs to the workspace name input. `focus` event fires. |
| **Exit conditions** | User leaves the field (`blur`) → `setup.workspace.validating`. OR user types → remains in `focused` (typing sub-state). |
| **Visual description** | Input border changes to `var(--accent)` (#6d5cff). Focus ring appears: `box-shadow: 0 0 0 3px rgba(109,92,255,0.15)`. Cursor blinks in input. Text is fully selectable. Randomize button remains accessible. |
| **Active DOM elements** | Visible: input (focused), hint text, randomize button. Hidden: checkmark (unless previously validated). |
| **Keyboard shortcuts** | All typing keys active — `_onWorkspaceNameInput()` fires on each keystroke. Invalid characters stripped in real-time (only `[a-zA-Z0-9_]` pass through). `Ctrl+A` selects all. `Ctrl+Z` browser undo. `Tab` blurs field. |
| **Data requirements** | `_sanitizeIdentifier()` runs on each input event. Auto-sync cascades to lakehouse/notebook if not manually edited. |
| **Transitions** | → `setup.workspace.validating` (blur), → `setup.workspace.randomizing` (randomize click while focused) |
| **Error recovery** | Live character stripping prevents invalid input — characters simply don't appear. Max length enforced at 256 chars (truncation, no error). |
| **Animation** | Border color transition: 200ms ease. Focus ring: instant on focus. |

---

## S09 — `setup.workspace.validating`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.workspace.validating` |
| **Entry conditions** | User blurs the workspace name input (`blur` event). `_onWorkspaceNameBlur()` triggers `_validateField('workspaceName')`. |
| **Exit conditions** | Validation completes → `setup.workspace.valid` OR `setup.workspace.invalid`. Validation is synchronous (collision check uses cached list). |
| **Visual description** | Transient state — imperceptible to user (sync validation). Border reverts from accent to neutral while validation runs. Conceptually the field is in a "checking" state. |
| **Active DOM elements** | Same as focused minus the focus ring. |
| **Keyboard shortcuts** | None active on this field (it's blurred). |
| **Data requirements** | Runs validation chain: WS-01 through WS-09. Checks `existingWorkspaces` set for collision. Checks `RESERVED_NAMES` set. |
| **Transitions** | → `setup.workspace.valid` (all rules pass), → `setup.workspace.invalid` (any rule fails) |
| **Error recovery** | If validation chain throws unexpectedly, treat as invalid with generic message: "Unable to validate name". |
| **Animation** | None — instantaneous transition. |

---

## S10 — `setup.workspace.valid`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.workspace.valid` |
| **Entry conditions** | `_validateField('workspaceName')` returns `{ status: 'valid' }`. All rules WS-01 through WS-09 pass. |
| **Exit conditions** | User re-focuses field → `setup.workspace.focused`. OR randomize clicked → `setup.workspace.randomizing`. |
| **Visual description** | Input border: `1px solid var(--status-ok)` (#18a058). Green checkmark (✓) visible in trailing icon slot, `color: var(--status-ok)`, fades in over 150ms. Hint text restored: "● Unique name, underscores allowed". No error text. `aria-invalid="false"`. |
| **Active DOM elements** | Visible: input with value, green checkmark, hint text. Hidden: error text. |
| **Keyboard shortcuts** | `Tab` into field → back to `focused`. |
| **Data requirements** | `onValidationChange()` called — may update parent's Next button state (if all other fields also valid). |
| **Transitions** | → `setup.workspace.focused` (user clicks/tabs back in), → `setup.workspace.randomizing` (randomize) |
| **Error recovery** | N/A — field is in good state. |
| **Animation** | Checkmark: fade-in 150ms ease. Border color: transition 200ms. |

---

## S11 — `setup.workspace.invalid`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.workspace.invalid` |
| **Entry conditions** | `_validateField('workspaceName')` returns `{ status: 'invalid', errorMessage: '...' }`. One of rules WS-01–WS-09 failed. |
| **Exit conditions** | User re-focuses field to correct → `setup.workspace.focused`. OR randomize clicked → `setup.workspace.randomizing`. |
| **Visual description** | Input border: `1px solid var(--status-fail)` (#e5453b). Error message replaces hint text below field: red text (10px, `--text-xs`), `color: var(--status-fail)`. Checkmark hidden. `aria-invalid="true"`. Hint element switched to `role="alert"` for screen reader announcement. |
| **Active DOM elements** | Visible: input with invalid value, error message below field. Hidden: checkmark, normal hint text. |
| **Keyboard shortcuts** | `Tab` into field → `focused`. |
| **Data requirements** | `onValidationChange(false)` fired — parent disables Next button. Error message from validation chain (e.g., "A workspace named 'X' already exists. Choose a different name."). |
| **Transitions** | → `setup.workspace.focused` (user edits), → `setup.workspace.randomizing` (randomize bypasses the error) |
| **Error recovery** | Self-recovering: user edits field or randomizes. Only one error shown at a time (first failing rule). |
| **Animation** | Error text: fade-in 150ms. Border color: transition 200ms. Error dismissed instantly on re-focus (no exit animation). |

---

## S12 — `setup.workspace.randomizing`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.workspace.randomizing` |
| **Entry conditions** | User clicks randomize button (🎲) OR presses `Space`/`Enter` while button is focused. `_onRandomizeClick()` fires. |
| **Exit conditions** | New name generated, cascaded to children, validation run → `setup.workspace.valid` (guaranteed — random names are collision-checked). |
| **Visual description** | Randomize button icon rotates 180° over 300ms (ease transition). Workspace input value updates to new Docker-style name. Lakehouse input updates to `{name}_lakehouse`. Notebook input updates to `{name}_notebook`. Both "auto" badges reappear (if previously hidden due to manual edit). All three fields re-validate. |
| **Active DOM elements** | Visible: spinning randomize button, all three updating inputs. Hidden: any previous errors (cleared by new valid names). |
| **Keyboard shortcuts** | Focus stays on randomize button after click (no focus steal). |
| **Data requirements** | `_generateUniqueRandomName(existingWorkspaces)` runs (up to 5 attempts + timestamp fallback). `lakehouseManuallyEdited → false`. `notebookManuallyEdited → false`. |
| **Transitions** | → `setup.workspace.valid` (new name is guaranteed collision-free) |
| **Error recovery** | 5-attempt retry with timestamp fallback ensures name generation never fails. |
| **Animation** | Button: `rotate(180deg)` over 300ms ease. Input values: instant text replacement (no animation on text content). Checkmarks fade in 150ms after validation. |

---

## S13 — `setup.workspace.collision`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.workspace.collision` |
| **Entry conditions** | User typed a name that exists in `existingWorkspaces` (case-insensitive match). Detected during `_onWorkspaceNameBlur()` via `_checkNameCollision()`. Rule WS-08 triggered. |
| **Exit conditions** | User edits name to non-colliding value → `setup.workspace.focused` → eventually `setup.workspace.valid`. OR randomize → `setup.workspace.randomizing`. |
| **Visual description** | Same as `setup.workspace.invalid` but with specific collision error: "A workspace named '{value}' already exists. Choose a different name." Border is `--status-fail`. |
| **Active DOM elements** | Visible: input with colliding name, collision error message. Hidden: checkmark, hint text. |
| **Keyboard shortcuts** | Same as invalid — `Tab` to re-enter, edit to fix. |
| **Data requirements** | `existingWorkspaces` set queried. `onValidationChange(false)` emitted. |
| **Transitions** | → `setup.workspace.focused` (user edits), → `setup.workspace.randomizing` (randomize) |
| **Error recovery** | User must change the name or randomize. Clear guidance in error message. |
| **Animation** | Same as `setup.workspace.invalid` — error fade-in 150ms, border transition 200ms. |

---

## S14 — `setup.capacity.idle`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.capacity.idle` |
| **Entry conditions** | Page rendered but `activate()` not yet called. Capacity dropdown exists in DOM with placeholder option "Select capacity..." |
| **Exit conditions** | `activate()` triggers `_loadCapacities()` → `setup.capacity.loading` |
| **Visual description** | Dropdown shows "Select capacity..." in `--text-muted` color. Arrow indicator (▾) visible. Dropdown is enabled but has no real options. "Create New Capacity" link with "COMING SOON" badge visible below. |
| **Active DOM elements** | Visible: dropdown with placeholder, arrow, Coming Soon link+badge. Hidden: error state, retry link. Disabled: nothing (but no real options to select). |
| **Keyboard shortcuts** | `Arrow Down/Up` opens native select — shows only placeholder. |
| **Data requirements** | None — waiting for activation. |
| **Transitions** | → `setup.capacity.loading` (activate triggers load) |
| **Error recovery** | N/A — pre-activation state. |
| **Animation** | None. |

---

## S15 — `setup.capacity.loading`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.capacity.loading` |
| **Entry conditions** | `_loadCapacities()` initiated. API call `GET /v1.0/myorg/capacities` in-flight. |
| **Exit conditions** | API success → `setup.capacity.loaded`. API failure → `setup.capacity.error`. API returns empty → `setup.capacity.empty`. |
| **Visual description** | Dropdown disabled with `opacity: 0.5`, `cursor: not-allowed`, background `var(--surface-3)`. Single option text: "Loading capacities...". `aria-busy="true"` on select element. |
| **Active DOM elements** | Visible: disabled dropdown with loading text. Hidden: error state, retry link. Disabled: `<select>` element. |
| **Keyboard shortcuts** | Dropdown keyboard interaction blocked (disabled). `Tab` skips to next focusable element. |
| **Data requirements** | `apiClient.listCapacities()` promise pending. Bearer token must be valid. |
| **Transitions** | → `setup.capacity.loaded` (200 OK with items), → `setup.capacity.empty` (200 OK with empty array), → `setup.capacity.error` (network error, 401, 500) |
| **Error recovery** | N/A — awaiting response. Timeout handled by API client (default 30s). |
| **Animation** | None (loading text is static — no spinner in dropdown, per spec). |

---

## S16 — `setup.capacity.loaded`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.capacity.loaded` |
| **Entry conditions** | `_loadCapacities()` resolved with one or more capacities. `_renderCapacityOptions()` builds `<option>` elements. |
| **Exit conditions** | User selects a capacity → `setup.capacity.selected`. State persists through page deactivation/reactivation. |
| **Visual description** | Dropdown enabled, border `var(--border-bright)`. First option: "Select capacity..." (placeholder, disabled). Subsequent options: `"{displayName} — {sku}, {region} ({state})"`. Paused capacities shown with dimmed text but remain selectable. `aria-busy="false"`. |
| **Active DOM elements** | Visible: dropdown with all capacity options, Coming Soon link. Hidden: error/retry, loading text. Disabled: none. |
| **Keyboard shortcuts** | `Arrow Down/Up` navigates options. `Enter` selects. `Tab` moves focus away. |
| **Data requirements** | Capacity array cached in `_capacities[]`. No re-fetch on reactivation. |
| **Transitions** | → `setup.capacity.selected` (user picks an option) |
| **Error recovery** | N/A — data loaded successfully. |
| **Animation** | None. |

---

## S17 — `setup.capacity.selected`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.capacity.selected` |
| **Entry conditions** | User selects a capacity from the dropdown. `_onCapacityChange()` fires. `capacityId` set to selected value. |
| **Exit conditions** | User changes selection (stays in `selected` with new value). Or field blurs — no separate validation state needed (dropdown selection is inherently valid). |
| **Visual description** | Dropdown displays selected capacity text. Border: `1px solid var(--border-bright)` (dropdowns don't show green valid border — that's an input pattern). `capacityId` is non-null → field validation passes. |
| **Active DOM elements** | Visible: dropdown with selected option text. Hidden: placeholder option (hidden when something selected, per HTML spec). |
| **Keyboard shortcuts** | Same as loaded — arrow keys, Enter. |
| **Data requirements** | `capacityId`, `capacityDisplay`, `capacitySku`, `capacityRegion` all set. `onValidationChange()` fired — may enable Next if all other fields valid. |
| **Transitions** | → `setup.capacity.selected` (user re-selects different capacity — self-transition with new value) |
| **Error recovery** | If selected capacity no longer in list (e.g., template pre-fill with deleted capacity) → revert to loaded state, show "Select capacity..." placeholder, form invalid. |
| **Animation** | None — native select behavior. |

---

## S18 — `setup.capacity.error`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.capacity.error` |
| **Entry conditions** | `_loadCapacities()` rejected — network error, HTTP 401/500, timeout. |
| **Exit conditions** | User clicks "Retry" link → `setup.capacity.loading` (retry attempt). |
| **Visual description** | Dropdown disabled, shows "Failed to load capacities" as sole option. Error hint below dropdown: "Could not load capacities. Check your connection." + "Retry" link in `--accent` color. `role="alert"` on error for screen reader. Form invalid (no capacity selected). |
| **Active DOM elements** | Visible: disabled dropdown with error text, Retry link, Coming Soon link. Hidden: normal options. Disabled: dropdown select. |
| **Keyboard shortcuts** | `Tab` can reach "Retry" link. `Enter`/`Space` on Retry triggers reload. |
| **Data requirements** | Error details logged to console. `onValidationChange(false)` emitted. |
| **Transitions** | → `setup.capacity.loading` (Retry clicked) |
| **Error recovery** | Retry link is the primary recovery mechanism. Retries have no limit. Each retry is a fresh API call. |
| **Animation** | Error text fade-in 150ms. |

---

## S19 — `setup.capacity.empty`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.capacity.empty` |
| **Entry conditions** | `_loadCapacities()` succeeded but returned empty array (`value: []`). |
| **Exit conditions** | None from within this page — user must obtain a capacity externally. (Future: "Create new capacity" flow.) |
| **Visual description** | Dropdown disabled, shows "No capacities available" as sole option. Hint below: "You need at least one Fabric capacity. Contact your admin." in `--text-muted`. "Create New Capacity" link visible with "COMING SOON" badge. Form permanently invalid until wizard closed and reopened with capacities available. |
| **Active DOM elements** | Visible: disabled dropdown with empty message, admin hint, Coming Soon link. Hidden: normal options, error/retry. Disabled: dropdown. |
| **Keyboard shortcuts** | `Tab` skips disabled dropdown. |
| **Data requirements** | Empty capacity array cached. `onValidationChange(false)` emitted. |
| **Transitions** | None — terminal for this activation cycle. Wizard must be closed and re-opened after admin provisions a capacity. |
| **Error recovery** | Out-of-band: admin provisions capacity, user closes/reopens wizard. |
| **Animation** | None. |

---

## S20 — `setup.lakehouse.synced`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.lakehouse.synced` |
| **Entry conditions** | Lakehouse name is auto-derived from workspace name: `{workspaceName}_lakehouse`. `lakehouseManuallyEdited` is `false`. This is the default state after name generation or randomize. |
| **Exit conditions** | User types in lakehouse field (value diverges) → `setup.lakehouse.unsynced`. OR workspace name changes (cascading update keeps this in `synced`). OR randomize resets → stays in `synced`. |
| **Visual description** | Lakehouse input shows `{workspaceName}_lakehouse` in `--mono` font. "auto" badge visible next to label: small pill with "AUTO" text, background `var(--accent-dim)`, color `var(--accent)`. Hint: "● Schema-enabled (always)" in `--text-muted`. If touched and valid: green checkmark visible. |
| **Active DOM elements** | Visible: input with auto-value, "auto" badge on label, hint text. Conditionally visible: checkmark (if touched+valid). Hidden: error text. |
| **Keyboard shortcuts** | `Tab` into field → field focuses for editing. Any keystroke that changes value potentially breaks sync. |
| **Data requirements** | `lakehouseManuallyEdited: false`. Value mirrors workspace computation. |
| **Transitions** | → `setup.lakehouse.unsynced` (user types diverging value), → `setup.lakehouse.synced` (workspace change cascades new value — self-loop) |
| **Error recovery** | If workspace name changes produce an invalid lakehouse name (e.g., exceeds 256 chars with suffix), validation catches it on blur → `setup.lakehouse.invalid` sub-state. |
| **Animation** | "auto" badge: steady state visible. Cascading name update: instant text replacement in input. |

---

## S21 — `setup.lakehouse.unsynced`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.lakehouse.unsynced` |
| **Entry conditions** | User typed in the lakehouse input and the value differs from `{workspaceName}_lakehouse`. `_onLakehouseNameInput()` detects divergence. `lakehouseManuallyEdited → true`. |
| **Exit conditions** | User clicks randomize → `setup.lakehouse.synced` (randomize ALWAYS resets both child fields). |
| **Visual description** | Lakehouse input shows user's custom value. "auto" badge fades out and disappears (150ms fade). Workspace name changes NO LONGER cascade to this field. Validation applies independently (rules LH-01 through LH-07). Hint and checkmark behavior same as before. |
| **Active DOM elements** | Visible: input with custom value, hint text. Hidden: "auto" badge (faded out). Conditionally visible: checkmark or error based on validation. |
| **Keyboard shortcuts** | Standard input editing. |
| **Data requirements** | `lakehouseManuallyEdited: true`. Independent validation. |
| **Transitions** | → `setup.lakehouse.synced` (randomize resets `lakehouseManuallyEdited → false` and overwrites value) |
| **Error recovery** | If user clears the field → validation on blur shows "Lakehouse name is required". User can type a new value or click randomize to restore sync. |
| **Animation** | "auto" badge: fade-out 150ms on manual edit. |

---

## S22 — `setup.notebook.synced`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.notebook.synced` |
| **Entry conditions** | Notebook name is auto-derived: `{workspaceName}_notebook`. `notebookManuallyEdited` is `false`. Default state after generation/randomize. |
| **Exit conditions** | User types in notebook field → `setup.notebook.unsynced`. OR workspace change cascades → stays `synced`. OR randomize → stays `synced`. |
| **Visual description** | Notebook input shows `{workspaceName}_notebook` in `--mono` font. "auto" badge visible on label. Hint: "● Auto-generated from workspace". Green checkmark if touched+valid. |
| **Active DOM elements** | Visible: input with auto-value, "auto" badge, hint text. Conditionally visible: checkmark. Hidden: error text. |
| **Keyboard shortcuts** | `Tab` into field for editing. |
| **Data requirements** | `notebookManuallyEdited: false`. Value mirrors workspace computation with `_notebook` suffix. |
| **Transitions** | → `setup.notebook.unsynced` (user edits), → `setup.notebook.synced` (workspace cascades — self-loop) |
| **Error recovery** | Same as lakehouse — validation on blur catches invalid formats. |
| **Animation** | Same as lakehouse synced state. |

---

## S23 — `setup.notebook.unsynced`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.notebook.unsynced` |
| **Entry conditions** | User typed in notebook input, value diverges from `{workspaceName}_notebook`. `notebookManuallyEdited → true`. |
| **Exit conditions** | Randomize → `setup.notebook.synced`. |
| **Visual description** | Notebook input shows custom value. "auto" badge faded out. Independent validation (NB-01 through NB-08). Note: notebook allows spaces unlike workspace/lakehouse. |
| **Active DOM elements** | Visible: input with custom value, hint. Hidden: "auto" badge. |
| **Keyboard shortcuts** | Standard input editing. Spaces allowed (unlike workspace). |
| **Data requirements** | `notebookManuallyEdited: true`. |
| **Transitions** | → `setup.notebook.synced` (randomize resets) |
| **Error recovery** | Validation on blur. Randomize as escape hatch. |
| **Animation** | "auto" badge fade-out 150ms. |

---

## S24 — `setup.form.allValid`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.form.allValid` |
| **Entry conditions** | All four validation conditions met simultaneously: workspace name valid + capacity selected + lakehouse name valid + notebook name valid. `_validateAllFields()` computes `isFormValid: true`. |
| **Exit conditions** | Any single field becomes invalid → `setup.form.hasErrors`. |
| **Visual description** | All applicable fields show green checkmarks. No error messages visible. Hint texts all in normal `--text-muted` color. Parent Next button enabled (accent fill, hover effects active). All `aria-invalid="false"` attributes set. |
| **Active DOM elements** | Visible: all inputs with values, green checkmarks on workspace/lakehouse/notebook, capacity dropdown with selection, all hint texts. Hidden: all error messages. |
| **Keyboard shortcuts** | `Enter` from any field → parent triggers navigation to Page 2. |
| **Data requirements** | `onValidationChange(true)` emitted. All `FieldValidation` statuses are `'valid'`. |
| **Transitions** | → `setup.form.hasErrors` (any field invalidated by user edit) |
| **Error recovery** | N/A — form is in ideal state. |
| **Animation** | None — steady valid state. |

---

## S25 — `setup.form.hasErrors`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.form.hasErrors` |
| **Entry conditions** | At least one field has `status: 'invalid'`. Can occur after blur validation, clearing a field, or capacity error/empty. Also entered when `validate()` called by parent with incomplete form. |
| **Exit conditions** | All fields corrected to valid → `setup.form.allValid`. |
| **Visual description** | One or more fields show red borders and error messages. Valid fields still show green checkmarks. Parent Next button disabled (dimmed, `cursor: not-allowed`, tooltip: "Complete all required fields"). On full-form validation (Next click attempt), focus jumps to first invalid field (top-to-bottom order: workspace → capacity → lakehouse → notebook). |
| **Active DOM elements** | Visible: mix of valid checkmarks and error messages across fields. Disabled: Next button in parent. |
| **Keyboard shortcuts** | `Tab` navigates to fields for correction. Focus auto-moves to first invalid field on failed validation attempt. |
| **Data requirements** | `onValidationChange(false)` emitted. At least one `FieldValidation` has `status: 'invalid'` with `errorMessage`. |
| **Transitions** | → `setup.form.allValid` (user fixes all errors), → `setup.form.hasErrors` (user fixes one error but another remains — self-loop) |
| **Error recovery** | Clear guidance via inline error messages. Focus management directs user to first problem. Randomize button as "nuclear reset" that generates all-valid names instantly. |
| **Animation** | Error messages: fade-in 150ms each. Focus transition to first invalid field: instant (no scroll animation — form fits in viewport). |

---

## S26 — `setup.template.hydrated`

| Property | Detail |
|----------|--------|
| **State ID** | `setup.template.hydrated` |
| **Entry conditions** | User selected a template before opening wizard, or template loaded via TemplateManager. `activate(templateData)` or `setData(templateData)` called with pre-filled `InfraSetupData`. |
| **Exit conditions** | Immediately transitions to `setup.page.active` with all fields populated. This is a transient pass-through state. |
| **Visual description** | All four fields pre-filled from template data. Workspace shows template's workspace name. Capacity dropdown attempts to match `templateData.capacityId`. If matched → selected. If not matched (capacity deleted since template was saved) → dropdown shows placeholder, field is invalid. Lakehouse and notebook show template values. `lakehouseManuallyEdited` and `notebookManuallyEdited` restored from template (determines "auto" badge visibility). |
| **Active DOM elements** | Same as `setup.page.active` but with template data pre-filled. |
| **Keyboard shortcuts** | Same as active — all fields editable. |
| **Data requirements** | Template data shape: `InfraSetupData`. Capacity list must be loaded (or loading) to validate `capacityId` match. |
| **Transitions** | → `setup.page.active` (immediate — validation runs, form state computed) |
| **Error recovery** | Capacity mismatch: dropdown reverts to placeholder, form invalid, user must re-select. Corrupted template fields: `_sanitizeIdentifier()` cleans input, validation catches remaining issues. |
| **Animation** | Same entry animations as normal activation (staggered slide-up) — template hydration is invisible to the animation system. |

---

# C03 — ThemeSchemaPage State Matrix

## S27 — `theme.page.unvisited`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.page.unvisited` |
| **Entry conditions** | ThemeSchemaPage instantiated and `render()` called. DOM built (theme grid, schema section). Page has never been activated. `visited: false`. |
| **Exit conditions** | `activate()` called (user navigates from Page 1 to Page 2) → `theme.page.entering` |
| **Visual description** | Page is not visible — hidden by parent's page container system. DOM exists in memory but is offscreen or `display: none`. |
| **Active DOM elements** | All hidden (page not displayed). Theme cards exist in DOM but not visible. Schema section exists but not visible. |
| **Keyboard shortcuts** | None — page not active. |
| **Data requirements** | Theme registry (static, 6 themes) loaded. Schema defaults: `selectedTheme: null`, `medallionEnabled: false`, all chips inactive. |
| **Transitions** | → `theme.page.entering` (first activation) |
| **Error recovery** | N/A — dormant state. |
| **Animation** | None. |

---

## S28 — `theme.page.entering`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.page.entering` |
| **Entry conditions** | `activate()` called for the first time. `_hasAnimated` flag is `false`. Page slide-in transition begins (from parent: `slideLeft`, 360ms). |
| **Exit conditions** | All entrance animations complete (last card at 650ms + schema section at 750ms total) → `theme.page.pristine` |
| **Visual description** | Page slides in from the right. Theme cards stagger-animate in a wave pattern: Row 1 cards at 50ms/100ms/150ms delays, Row 2 cards at 200ms/250ms/300ms delays. Each card: `opacity 0→1`, `translateY(12px→0)`, 350ms duration, `var(--ease)` timing. Schema section slides up at 350ms delay, 400ms duration. Cards start invisible, appear one by one left-to-right, top-to-bottom. |
| **Active DOM elements** | Visible (animating in): 6 theme cards staggering, schema section fading in. Cards are not yet interactive during animation (click events are technically bound but animation is purely visual). |
| **Keyboard shortcuts** | `Tab` would focus first card, but entrance animation is brief enough (750ms total) that user interaction during it is unlikely. |
| **Data requirements** | None — purely visual transition. |
| **Transitions** | → `theme.page.pristine` (animations complete, `_hasAnimated → true`) |
| **Error recovery** | If `prefers-reduced-motion: reduce` is active, all animations are suppressed — cards appear instantly, transitions directly to `theme.page.pristine`. |
| **Animation** | Cards: `cardStagger1`/`cardStagger2` keyframes, 350ms each, staggered 50ms increments. Schema: `slideUp` keyframe, 400ms, 350ms delay. Total choreography: 750ms. See §6.6 of C03 spec. |

---

## S29 — `theme.page.pristine`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.page.pristine` |
| **Entry conditions** | Entrance animations complete (first visit) OR page re-activated with no prior theme selection. No theme card is `.selected`. |
| **Exit conditions** | User clicks a theme card → `theme.card.selecting`. OR user toggles medallion → stays `pristine` (schemas don't affect validity). |
| **Visual description** | 6 theme cards in 3x2 grid, all in idle state: `2px solid var(--border-bright)` border, `--surface` background, no checkmarks. Schema section visible: dbo chip (locked, `--dbo-dim` background), medallion toggle (OFF position, gray track). No medallion chips visible (container collapsed). Section label "Data Theme" in `--text-muted` uppercase. Next button DISABLED (no theme selected → `isValid: false`). First theme card has `tabindex="0"` (roving tabindex), others `tabindex="-1"`. |
| **Active DOM elements** | Visible: all 6 theme cards (idle), schema section with dbo chip, medallion toggle (OFF). Hidden: medallion chips (collapsed container), checkmark badges on cards. Disabled: Next button (in parent). |
| **Keyboard shortcuts** | `Tab` → first theme card gets focus ring (`outline: 2px solid var(--accent), offset: 2px`). `Arrow Right/Left/Down/Up` navigates within grid (col-aware). `Enter`/`Space` selects focused card. `Tab` past grid → medallion toggle. |
| **Data requirements** | `selectedTheme: null`, `isValid: false`. `onValidationChange(false)` emitted to parent. |
| **Transitions** | → `theme.card.selecting` (card clicked/activated), → `theme.medallion.toggling-on` (toggle clicked, but page stays pristine/invalid) |
| **Error recovery** | If user tries to proceed without selection, Next button remains disabled. If inline validation message exists: "Please select a data theme to continue" in `--status-fail` below theme grid. |
| **Animation** | Card hover effects active: `translateY(-2px)`, `border-color: rgba(109,92,255,0.3)`, `shadow-md` on hover. 200ms transitions. |

---

## S30 — `theme.card.selecting`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.card.selecting` |
| **Entry conditions** | User clicks a theme card or presses `Enter`/`Space` on a focused card. No card was previously selected (first selection). |
| **Exit conditions** | Selection animation completes (200ms) → `theme.page.themeSelected` |
| **Visual description** | Clicked card begins transition: border animates from `--border-bright` to `--accent` (200ms ease). Background shifts from `--surface` to `--accent-dim`. Glow ring appears: `box-shadow: 0 0 0 3px var(--accent-glow)`. Checkmark badge pops in via `checkPop` keyframe: `scale(0) → scale(1.2) → scale(1)` over 200ms. `aria-checked` flips to `"true"`. All sibling cards remain idle (no deselection animation needed — nothing was selected before). |
| **Active DOM elements** | Visible: selected card animating to `.selected` state, other 5 cards idle, schema section. Hidden: previous selection effects (N/A for first selection). |
| **Keyboard shortcuts** | During 200ms animation: no additional keyboard handling needed (animation is non-blocking). Focus remains on the clicked/activated card. |
| **Data requirements** | `selectedTheme` set to clicked theme's `ThemeId`. `themeChanged` event fired: `{ themeId, theme: ThemeDefinition }`. `isValid → true`. `isDirty → true`. |
| **Transitions** | → `theme.page.themeSelected` (animation complete) |
| **Error recovery** | N/A — pure UI transition. |
| **Animation** | Border: `border-color` transition 200ms ease. Background: `background` transition 200ms ease. Glow: `box-shadow` transition 200ms ease. Checkmark: `checkPop` keyframe 200ms (scale 0→1.2→1). |

---

## S31 — `theme.page.themeSelected`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.page.themeSelected` |
| **Entry conditions** | One theme card has `.selected` class. Selection animation complete. `isValid: true`. |
| **Exit conditions** | User clicks a different card → `theme.card.switching`. User toggles medallion → stays in `themeSelected`. User clicks chip → stays in `themeSelected`. `deactivate()` → `theme.page.inactive`. |
| **Visual description** | One card highlighted: 2px `--accent` border, `--accent-dim` background, 3px glow ring, checkmark badge visible (20x20 circle, accent fill, white ✓). Other 5 cards in idle state (standard border, no glow, no checkmark). Hover effects active on all idle cards. Schema section: dbo chip locked, medallion toggle in current position, chips in current state. Next button ENABLED (accent fill, pointer cursor, hover effect). |
| **Active DOM elements** | Visible: all 6 cards (1 selected + 5 idle), schema section fully interactive, checkmark on selected card. Enabled: Next button in parent. |
| **Keyboard shortcuts** | `Arrow keys` in grid move focus. `Enter`/`Space` on different card triggers switch. `Tab` → medallion toggle → chips (if visible) → Next button. |
| **Data requirements** | `selectedTheme: ThemeId` (non-null). `onValidationChange(true)` emitted. `validationChanged` event: `{ isValid: true, reason: null }`. Theme data available via `getSelectedTheme()` for downstream consumers (C04 DagCanvas, C08 CodePreview). |
| **Transitions** | → `theme.card.switching` (different card clicked), → `theme.medallion.toggling-on` / `theme.medallion.toggling-off` (toggle interaction), → `theme.chip.activating` / `theme.chip.deactivating` (chip interaction), → `theme.page.inactive` (deactivate) |
| **Error recovery** | N/A — valid state. |
| **Animation** | Hover on idle cards: `translateY(-2px)`, border brightens, shadow-md, 200ms transitions. Selected card suppresses hover lift (already visually distinct). |

---

## S32 — `theme.card.switching`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.card.switching` |
| **Entry conditions** | User clicks a different theme card than the currently selected one. Two simultaneous animations fire: deselection on old card + selection on new card. |
| **Exit conditions** | Both animations complete (~200ms) → `theme.page.themeSelected` (with new theme) |
| **Visual description** | **Old card (deselecting):** Border transitions `--accent → --border-bright` (200ms). Background transitions `--accent-dim → --surface` (200ms). Glow ring fades out (200ms). Checkmark shrinks: `scale(1) → scale(0)` over 150ms ease-in — badge disappears. `aria-checked → "false"`. **New card (selecting):** Simultaneously: border, background, glow transition to selected state (200ms). Checkmark pops in via `checkPop` (200ms). `aria-checked → "true"`. Net effect: smooth visual handoff, old card fades to idle as new card gains selection. |
| **Active DOM elements** | Visible: old card transitioning out of selected, new card transitioning into selected, other 4 cards idle. |
| **Keyboard shortcuts** | Non-blocking — animation is 200ms. |
| **Data requirements** | `selectedTheme` updated to new `ThemeId`. `themeChanged` event fires with new theme data. Old theme's data no longer referenced by downstream. |
| **Transitions** | → `theme.page.themeSelected` (animations complete) |
| **Error recovery** | If user rapid-clicks multiple cards during animation: last click wins. Intermediate animations are overridden by CSS transition restart. |
| **Animation** | Deselection: all transitions 200ms ease (border, background, glow). Checkmark out: `scale(1→0)` 150ms ease-in. Selection: all transitions 200ms ease. Checkmark in: `checkPop` 200ms (scale 0→1.2→1). Total: 200ms (parallel). |

---

## S33 — `theme.card.hovered`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.card.hovered` |
| **Entry conditions** | Mouse enters an idle (non-selected) theme card. `:hover` CSS pseudo-class activates. |
| **Exit conditions** | Mouse leaves card → returns to `theme.card.idle`. OR card is clicked → `theme.card.selecting` or `theme.card.switching`. |
| **Visual description** | Card lifts: `translateY(-2px)`. Border brightens: `border-color: rgba(109,92,255,0.3)`. Shadow appears: `var(--shadow-md)` = `0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)`. Background subtly tints: `rgba(109,92,255,0.04)`. Cursor: `pointer`. All transitions: 200ms `var(--ease)`. |
| **Active DOM elements** | Visible: hovered card with lift/glow/shadow effects. |
| **Keyboard shortcuts** | N/A — mouse-driven state. Keyboard equivalent is focus-visible. |
| **Data requirements** | None — purely visual. |
| **Transitions** | → idle (mouse leave), → `theme.card.selecting` / `theme.card.switching` (click) |
| **Error recovery** | N/A — CSS-driven, no failure modes. |
| **Animation** | `translateY(-2px)` lift: 200ms ease. Border color: 200ms ease. Box-shadow: 200ms ease. Background: 200ms ease. |

---

## S34 — `theme.card.focused`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.card.focused` |
| **Entry conditions** | Card receives keyboard focus via `Tab` or arrow key navigation. `:focus-visible` CSS pseudo-class activates. Roving tabindex: this card gets `tabindex="0"`, all siblings get `tabindex="-1"`. |
| **Exit conditions** | Focus moves to another card (arrow keys) → that card becomes `focused`. `Tab` → focus leaves grid. `Enter`/`Space` → card selected. |
| **Visual description** | Focus ring: `outline: 2px solid var(--accent)`, `outline-offset: 2px`. Same visual treatment as hover (border brightens, subtle tint) PLUS the outline ring. If card is already selected, focus ring appears around the selected card (no additional hover effects). |
| **Active DOM elements** | Visible: focused card with outline ring. |
| **Keyboard shortcuts** | `Arrow Right` → next card (wraps row end to next row start). `Arrow Left` → previous card (wraps). `Arrow Down` → card below (N → N+3, column-aware). `Arrow Up` → card above (N → N-3). `Enter`/`Space` → select. `Tab` → leave grid to medallion toggle. |
| **Data requirements** | Roving tabindex management: `tabindex="0"` on focused card, `"-1"` on all others. |
| **Transitions** | → `theme.card.focused` on another card (arrow navigation), → `theme.card.selecting`/`theme.card.switching` (Enter/Space), → focus leaves (Tab) |
| **Error recovery** | Arrow navigation wraps — no out-of-bounds. |
| **Animation** | Focus ring: instant (browser-managed). Hover-like effects: 200ms transitions. |

---

## S35 — `theme.medallion.off`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.medallion.off` |
| **Entry conditions** | Default state. Medallion toggle is in OFF position. OR user toggled it OFF from ON. |
| **Exit conditions** | User clicks/activates toggle → `theme.medallion.toggling-on` |
| **Visual description** | Toggle track: `background: var(--surface-3)` (#ebedf0), gray. Thumb: positioned at left (no `translateX`). Label "Add medallion schemas" in `--text-dim`. `aria-checked="false"` on toggle button. `.medallion-chips` container: `max-height: 0; opacity: 0` — collapsed and invisible. `aria-hidden="true"` on chip container. Only dbo chip visible in schema section. `schemasChanged` event carries `{ schemas: ['dbo'], medallionEnabled: false }`. |
| **Active DOM elements** | Visible: dbo chip (locked), toggle track (OFF position), toggle label. Hidden: medallion chips container (collapsed). |
| **Keyboard shortcuts** | `Tab` reaches toggle. `Enter`/`Space` activates toggle. |
| **Data requirements** | `medallionEnabled: false`. Active schemas: `['dbo']` only. Chip states preserved internally (toggling back ON restores them). |
| **Transitions** | → `theme.medallion.toggling-on` (user activates toggle) |
| **Error recovery** | N/A — valid state (dbo always sufficient). |
| **Animation** | Toggle thumb: rests at left position. Chip container: stays collapsed. |

---

## S36 — `theme.medallion.toggling-on`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.medallion.toggling-on` |
| **Entry conditions** | User clicks the medallion toggle or presses `Enter`/`Space` while toggle is focused. Toggle was OFF. |
| **Exit conditions** | Toggle animation + chip container expansion complete (~300ms) → `theme.medallion.on` |
| **Visual description** | Toggle track transitions: `background: var(--surface-3) → var(--accent)` (#6d5cff). Thumb slides right: `translateX(0) → translateX(16px)` with spring easing `cubic-bezier(0.34, 1.56, 0.64, 1)` — slight bounce overshoot, 200ms. `aria-checked → "true"`. Chip container expands: `max-height: 0→50px`, `opacity: 0→1`, 300ms `var(--ease)`. Bronze, Silver, Gold chips appear (in their previously saved active/inactive states). `aria-hidden → "false"` on chip container. |
| **Active DOM elements** | Visible: toggle animating to ON, chip container expanding, 3 chips appearing. |
| **Keyboard shortcuts** | Non-blocking — animation is 300ms. |
| **Data requirements** | `medallionEnabled → true`. `schemasChanged` event fires with any previously active chips included. |
| **Transitions** | → `theme.medallion.on` (animations complete) |
| **Error recovery** | N/A — purely visual transition. |
| **Animation** | Track color: 200ms ease. Thumb: `translateX(16px)` 200ms spring-ease with bounce. Chip container: `max-height` + `opacity` 300ms ease. |

---

## S37 — `theme.medallion.on`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.medallion.on` |
| **Entry conditions** | Toggle animation complete. Chip container fully expanded. |
| **Exit conditions** | User clicks toggle OFF → `theme.medallion.toggling-off`. User clicks a chip → `theme.chip.activating` or `theme.chip.deactivating`. |
| **Visual description** | Toggle track: `background: var(--accent)`, purple. Thumb: positioned right (`translateX(16px)`). `aria-checked="true"`. Chip container fully visible: 3 chips in a row with 8px gap. Each chip in its current state (active or inactive). Chip states may have been preserved from a previous toggle cycle. |
| **Active DOM elements** | Visible: dbo chip (locked), toggle (ON), 3 medallion chips (individually active or inactive). All chips clickable. |
| **Keyboard shortcuts** | `Tab` from toggle → first chip (Bronze). `Arrow Right/Left` navigates between chips. `Enter`/`Space` toggles chip active/inactive. `Tab` from last chip → Next button. |
| **Data requirements** | `medallionEnabled: true`. Active schemas computed from `medallionSchemas` flags. `schemasChanged` fires on each chip toggle. |
| **Transitions** | → `theme.medallion.toggling-off` (toggle clicked), → `theme.chip.activating` / `theme.chip.deactivating` (chip interaction) |
| **Error recovery** | N/A — all states valid (schemas never invalidate the page). |
| **Animation** | Chips: individual toggle animations on click (see chip states). |

---

## S38 — `theme.medallion.toggling-off`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.medallion.toggling-off` |
| **Entry conditions** | User clicks toggle while in ON position. |
| **Exit conditions** | Animations complete (~300ms) → `theme.medallion.off` |
| **Visual description** | Reverse of toggling-on. Track transitions `var(--accent) → var(--surface-3)`. Thumb slides left: `translateX(16px) → translateX(0)` with spring easing, 200ms. Chip container collapses: `max-height: 50px→0`, `opacity: 1→0`, 300ms ease. Chips visually disappear but their active/inactive states are PRESERVED in memory. `aria-checked → "false"`. `aria-hidden → "true"` on chip container. |
| **Active DOM elements** | Visible: toggle animating to OFF, chips fading/collapsing. |
| **Keyboard shortcuts** | Non-blocking. Focus returns to toggle. |
| **Data requirements** | `medallionEnabled → false`. `schemasChanged` fires: `{ schemas: ['dbo'], medallionEnabled: false }`. Chip states NOT cleared — `medallionSchemas` object preserved. |
| **Transitions** | → `theme.medallion.off` (animations complete) |
| **Error recovery** | N/A — purely visual. |
| **Animation** | Track: 200ms ease. Thumb: 200ms spring. Container: 300ms ease collapse. |

---

## S39 — `theme.chip.activating`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.chip.activating` |
| **Entry conditions** | User clicks an inactive medallion chip (Bronze, Silver, or Gold) or presses `Enter`/`Space` while chip is focused. Chip is transitioning from inactive → active. |
| **Exit conditions** | Activation animation complete (200ms) → chip settles in active state within `theme.medallion.on` |
| **Visual description** | Chip gains `.active` class. Border transitions from `--border-bright` to schema color (Bronze: `#b87333`, Silver: `#7b8794`, Gold: `#c5a038`). Background transitions to schema dim color (e.g., `rgba(184,115,51,0.08)` for bronze). Checkmark inside chip fills/appears. `aria-checked → "true"`. Text color darkens to accessible variant (`--bronze-text`, `--silver-text`, `--gold-text`). |
| **Active DOM elements** | Visible: chip animating to active state. Sibling chips unaffected. |
| **Keyboard shortcuts** | Non-blocking — 200ms animation. |
| **Data requirements** | `medallionSchemas[chipId] → true`. `schemasChanged` event fires with updated array (e.g., `['dbo', 'bronze']`). Downstream Page 3 schema dropdowns update. |
| **Transitions** | → `theme.medallion.on` (animation complete, chip in active state) |
| **Error recovery** | N/A — stateless animation. |
| **Animation** | Border color: 200ms ease. Background: 200ms ease. Checkmark: fade-in or scale pop. All CSS transitions. |

---

## S40 — `theme.chip.deactivating`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.chip.deactivating` |
| **Entry conditions** | User clicks an active medallion chip or presses `Enter`/`Space` while active chip is focused. Chip transitioning from active → inactive. |
| **Exit conditions** | Deactivation animation complete (200ms) → chip settles in inactive state within `theme.medallion.on` |
| **Visual description** | Chip loses `.active` class. Border transitions from schema color back to `--border-bright`. Background transitions from schema dim back to white/transparent. Checkmark fades out or shrinks. `aria-checked → "false"`. Text color reverts to standard. |
| **Active DOM elements** | Visible: chip animating to inactive. |
| **Keyboard shortcuts** | Non-blocking. |
| **Data requirements** | `medallionSchemas[chipId] → false`. `schemasChanged` event fires with updated array. If nodes on Page 3 were assigned to this schema, InfraWizardDialog triggers node reassignment to dbo + toast notification. |
| **Transitions** | → `theme.medallion.on` (animation complete) |
| **Error recovery** | Schema removal orphan handling: InfraWizardDialog (not ThemeSchemaPage) detects orphaned nodes and reassigns to dbo. Toast: "N nodes reassigned to dbo (X schema removed)". |
| **Animation** | Same as activating, reversed: border, background, checkmark all transition back over 200ms. |

---

## S41 — `theme.chip.dbo.locked`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.chip.dbo.locked` |
| **Entry conditions** | Always. The dbo chip is a static, non-interactive element. Present from render time. Never changes state. |
| **Exit conditions** | None — permanent state for the lifetime of the page. Only removed on `dispose()`. |
| **Visual description** | Pill chip: `background: var(--dbo-dim)` (rgba(90,96,112,0.08)), `color: var(--dbo)` (#5a6070). Text: "● dbo" with filled dot. Helper text: "Always included" in `--text-muted`. `cursor: default` (not pointer). No hover effect. No click handler. `aria-disabled="true"`. `role="status"`. |
| **Active DOM elements** | Visible: dbo chip pill and "Always included" helper text. The chip is never hidden, disabled (visually), or modified. |
| **Keyboard shortcuts** | Not focusable — `tabindex="-1"` or no tabindex. Tab skips over it. Screen reader reads it as status: "dbo schema, always included." |
| **Data requirements** | `'dbo'` is always the first element in `getActiveSchemas()` return value. Never removed from the schema list. |
| **Transitions** | None — permanent. |
| **Error recovery** | N/A — immutable element. |
| **Animation** | None — static element. |

---

## S42 — `theme.page.inactive`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.page.inactive` |
| **Entry conditions** | `deactivate()` called — user navigated forward to Page 3 or backward to Page 1. `_isActive → false`. |
| **Exit conditions** | `activate()` called again (Back from Page 3 or Forward from Page 1) → `theme.page.returning` |
| **Visual description** | Page not visible. DOM and all state (selected theme, schema config) persist in memory. |
| **Active DOM elements** | All hidden. |
| **Keyboard shortcuts** | None. |
| **Data requirements** | Full state preserved: `selectedTheme`, `medallionEnabled`, `medallionSchemas`. Downstream consumers can still call `getSelectedTheme()` and `getActiveSchemas()` to read cached state. |
| **Transitions** | → `theme.page.returning` (re-activation) |
| **Error recovery** | N/A — dormant. |
| **Animation** | Exit: page slides out (parent C01 transition). |

---

## S43 — `theme.page.returning`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.page.returning` |
| **Entry conditions** | `activate()` called when `_hasAnimated` is `true` (not the first visit). User navigated Back from Page 3 or Forward from Page 1. |
| **Exit conditions** | Page slide-in completes → `theme.page.themeSelected` (if theme was selected) OR `theme.page.pristine` (if no theme selected) |
| **Visual description** | Page slides in (direction depends on navigation: `slideRight` if Back from Page 3, `slideLeft` if Forward from Page 1). Cards appear INSTANTLY in their current state — no stagger replay. Selected card retains `.selected` with full visual treatment. Schema section appears immediately with current toggle and chip states. Focus placed on previously selected card (or first card if none selected). |
| **Active DOM elements** | All visible immediately — no entrance animation delay. |
| **Keyboard shortcuts** | Full keyboard navigation available as soon as page is visible. |
| **Data requirements** | All state restored from memory. No re-computation needed. |
| **Transitions** | → `theme.page.themeSelected` (if theme exists), → `theme.page.pristine` (if no theme) |
| **Error recovery** | N/A — state fully preserved from prior visit. |
| **Animation** | Page slide-in only (parent-owned, 360ms). NO card stagger replay. NO schema section fade. Instant state restoration. |

---

## S44 — `theme.template.loaded`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.template.loaded` |
| **Entry conditions** | `setState()` called with template data: `{ selectedTheme: ThemeId, medallionEnabled: boolean, medallionSchemas: { bronze, silver, gold } }`. Source: TemplateManager (C12) or Back navigation with template state. |
| **Exit conditions** | Immediately resolves to `theme.page.themeSelected` (if theme valid) OR `theme.page.pristine` (if theme unrecognized). |
| **Visual description** | Transient state — template data applied to DOM: the matching theme card gains `.selected` class (with selection animation). Medallion toggle set to template's `medallionEnabled`. Chip states restored from `medallionSchemas` flags. If `medallionEnabled` is true, chip container expanded with chips in correct active/inactive states. Visual result: page looks exactly as if the user had made these selections manually. |
| **Active DOM elements** | Same as `theme.page.themeSelected` — one card selected, schema section configured per template. |
| **Keyboard shortcuts** | Full keyboard navigation. |
| **Data requirements** | Template data validated: `themeId` checked against THEME_REGISTRY. If unrecognized → console warning, theme stays unselected, toast: "Template theme not recognized — please select a theme". If `medallionSchemas` corrupted → reset to defaults, toast: "Schema configuration reset to defaults". |
| **Transitions** | → `theme.page.themeSelected` (valid template), → `theme.page.pristine` (invalid/missing theme in template) |
| **Error recovery** | Unknown theme: theme selection skipped, page stays invalid. Corrupted schemas: `medallionEnabled: false`, all chips inactive. Both cases: toast notification to user, console warning for developers. |
| **Animation** | Card selection animation plays (checkPop, border transition). Medallion toggle animates to target position. Chip container expands if needed. All standard animations apply even on template load. |

---

## S45 — `theme.validation.invalid`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.validation.invalid` |
| **Entry conditions** | `isValid()` returns `false` — no theme is selected. This is the state whenever `selectedTheme === null`. Can persist across schema changes (schemas never affect validity). |
| **Exit conditions** | User selects any theme card → `theme.validation.valid` |
| **Visual description** | No theme card has `.selected`. Next button DISABLED in parent footer. If user somehow triggers explicit validation (unlikely — Next button is disabled), inline message appears below theme grid: "Please select a data theme to continue" in `--status-fail` red. Stepper indicator for Step 2 shows no checkmark. |
| **Active DOM elements** | Visible: all 6 idle cards, schema section. Disabled: Next button. Optionally visible: validation error message below grid (only on explicit validate call). |
| **Keyboard shortcuts** | All grid/toggle/chip navigation active. User just needs to select a card. |
| **Data requirements** | `selectedTheme: null`. `onValidationChange(false)` active. `validationChanged` event: `{ isValid: false, reason: 'no_theme_selected' }`. |
| **Transitions** | → `theme.validation.valid` (any card selected) |
| **Error recovery** | Self-service: user clicks any card. No dead ends. |
| **Animation** | If error message shown: fade-in 150ms. |

---

## S46 — `theme.validation.valid`

| Property | Detail |
|----------|--------|
| **State ID** | `theme.validation.valid` |
| **Entry conditions** | `isValid()` returns `true` — a theme is selected. `selectedTheme !== null`. Schema state is irrelevant (dbo always guarantees at least one schema). |
| **Exit conditions** | This is a persistent valid state as long as a theme remains selected. Since themes can only be switched (not deselected), once valid, the page stays valid for the rest of the wizard session. Only `reset()` or corrupt `setState()` can revert to invalid. |
| **Visual description** | One card `.selected`. Next button ENABLED. Stepper Step 2 may show checkmark (if user has moved past this page). Validation error message hidden. |
| **Active DOM elements** | Visible: 1 selected card + 5 idle cards, schema section, enabled Next button. |
| **Keyboard shortcuts** | `Enter` from any element can trigger Next (parent handles). |
| **Data requirements** | `selectedTheme: ThemeId` (non-null). `onValidationChange(true)`. `getSelectedTheme()` returns full `ThemeDefinition`. `getActiveSchemas()` returns `['dbo', ...optionalSchemas]`. |
| **Transitions** | → `theme.validation.valid` (self — theme switch keeps page valid), → `theme.validation.invalid` (only via `reset()` or corrupted `setState()`) |
| **Error recovery** | N/A — once a theme is selected, it can only be replaced, never removed. The page is permanently valid. |
| **Animation** | None — steady valid state. |

---

# Cross-Component Transition Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        WIZARD PAGE FLOW                                     │
│                                                                             │
│   C02 InfraSetupPage                    C03 ThemeSchemaPage                 │
│   ──────────────────                    ─────────────────────               │
│                                                                             │
│   S01 uninitialized                     S27 unvisited                       │
│     │ constructor                         │                                 │
│     ▼                                     │                                 │
│   S02 rendered                            │ (waiting for page 1 completion) │
│     │ activate()                          │                                 │
│     ▼                                     │                                 │
│   S03 loading ──┐                         │                                 │
│     │           │ (parallel)              │                                 │
│     │    capacity.loading                 │                                 │
│     │    workspace.randomizing            │                                 │
│     ▼                                     │                                 │
│   S04 active                              │                                 │
│     │                                     │                                 │
│     │  ┌─ workspace.focused ─┐            │                                 │
│     │  │  workspace.valid    │            │                                 │
│     │  │  workspace.invalid  │            │                                 │
│     │  │  workspace.collision│            │                                 │
│     │  └─────────────────────┘            │                                 │
│     │                                     │                                 │
│     │  ┌─ capacity.loaded ───┐            │                                 │
│     │  │  capacity.selected  │            │                                 │
│     │  │  capacity.error     │            │                                 │
│     │  │  capacity.empty     │            │                                 │
│     │  └─────────────────────┘            │                                 │
│     │                                     │                                 │
│     │  ┌─ lakehouse.synced ──┐            │                                 │
│     │  │  lakehouse.unsynced │            │                                 │
│     │  └─────────────────────┘            │                                 │
│     │                                     │                                 │
│     │  ┌─ notebook.synced ───┐            │                                 │
│     │  │  notebook.unsynced  │            │                                 │
│     │  └─────────────────────┘            │                                 │
│     │                                     │                                 │
│     │  ┌─ form.allValid ─────┐            │                                 │
│     │  │  form.hasErrors     │            │                                 │
│     │  └─────────────────────┘            │                                 │
│     │                                     │                                 │
│     │  [Next button clicked]              │                                 │
│     │  (form.allValid required)           │                                 │
│     │                                     │                                 │
│     ├──── deactivate() ──────────────────▶│ activate()                      │
│     ▼                                     ▼                                 │
│   S05 inactive                          S28 entering ← (first visit)       │
│     │                                   S43 returning ← (back navigation)  │
│     │                                     │                                 │
│     │                                     ▼                                 │
│     │                                   S29 pristine                        │
│     │                                     │ card click                      │
│     │                                     ▼                                 │
│     │                                   S30 card.selecting                  │
│     │                                     │                                 │
│     │                                     ▼                                 │
│     │                                   S31 themeSelected                   │
│     │                                     │                                 │
│     │                                     │  ┌─ card.switching ──┐          │
│     │                                     │  │  card.hovered     │          │
│     │                                     │  │  card.focused     │          │
│     │                                     │  └───────────────────┘          │
│     │                                     │                                 │
│     │                                     │  ┌─ medallion.off ───┐          │
│     │                                     │  │  medallion.on     │          │
│     │                                     │  │  toggling-on/off  │          │
│     │                                     │  └───────────────────┘          │
│     │                                     │                                 │
│     │                                     │  ┌─ chip.activating ─┐          │
│     │                                     │  │  chip.deactivating│          │
│     │                                     │  │  chip.dbo.locked  │          │
│     │                                     │  └───────────────────┘          │
│     │                                     │                                 │
│     │                                     │  ┌─ validation.valid ┐          │
│     │                                     │  │  validation.invalid│          │
│     │                                     │  └───────────────────┘          │
│     │                                     │                                 │
│     │◀─── activate() (Back) ─────────────├──── deactivate() ──────▶ Page 3 │
│     │                                     ▼                                 │
│     │                                   S42 inactive                        │
│     │                                                                       │
│     ▼                                                                       │
│   S06 destroyed (wizard close)          (dispose on wizard close)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow at Page Transition (C02 → C03)

| What | How |
|------|-----|
| **Trigger** | User clicks "Next" while `setup.form.allValid` |
| **C02 action** | `getData()` returns `InfraSetupData` snapshot. `deactivate()` called. |
| **Parent action** | InfraWizardDialog stores data in `WizardState`. Calls `themeSchemaPage.activate()`. Runs page slide transition (`slideLeft`, 360ms). |
| **C03 action** | `activate()` fires. First visit: entrance animations play (stagger). Return visit: instant state restoration. Focus set to first/selected theme card. |
| **Data consumed by C03** | C03 does not directly read C02 data. Theme and schema selections are independent of infrastructure names. |

### Data Flow at Page Transition (C03 → C02, Back navigation)

| What | How |
|------|-----|
| **Trigger** | User clicks "Back" from Page 2 |
| **C03 action** | `deactivate()` called. State preserved in memory. |
| **Parent action** | Calls `infraSetupPage.activate(existingWizardState)`. Slide transition (`slideRight`, 360ms). |
| **C02 action** | `activate()` with existing state. `setData()` restores all field values, manual-edit flags, capacity selection. No stagger animation replay. No re-fetch of capacities (cached). Focus on workspace name (or first invalid field). |

---

*End of P3 State Matrices for C02-InfraSetupPage and C03-ThemeSchemaPage.*
*Total: 26 states (C02) + 20 states (C03) = 46 states across both form pages.*
