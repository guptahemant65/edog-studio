# C02 — InfraSetupPage: Component Deep Spec

> **Component:** InfraSetupPage (Page 1 of New Infra Wizard)
> **Feature:** F16 — New Infra Wizard
> **Owner:** Pixel (JS/CSS) + Vex (API integration)
> **Complexity:** MEDIUM
> **Depends On:** P0.2 (API verification), C01 InfraWizardDialog (parent container)
> **Status:** P1 — DRAFT
> **Last Updated:** 2025-07-20

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [State Machine](#4-state-machine)
5. [Scenarios](#5-scenarios)
6. [Visual Spec](#6-visual-spec)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Error Handling](#8-error-handling)
9. [Performance](#9-performance)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Overview

### 1.1 Purpose

InfraSetupPage is the first page of the F16 New Infra Wizard. It collects the four foundational configuration values required to create a Fabric test environment:

1. **Workspace Name** — The root identifier for the entire environment. Drives downstream names.
2. **Capacity** — Which Fabric capacity to assign to the workspace. Loaded from API.
3. **Lakehouse Name** — Auto-derived from workspace name with `_lakehouse` suffix. Always created with `enableSchemas: true`.
4. **Notebook Name** — Auto-derived from workspace name with `_notebook` suffix.

The page is the user's first interaction with the wizard. It must feel immediate, intelligent, and frictionless. A Docker-style random name generator pre-fills the workspace name on mount, cascading auto-generated names flow into lakehouse and notebook fields, and inline validation provides instant feedback. The capacity dropdown loads asynchronously from the Fabric API and shows meaningful metadata (SKU, region, state) for each option.

### 1.2 Design Philosophy

This page follows the **Stripe validation pattern** identified in the P0.5 wizard research:

- Validate on blur (per-field) + re-validate on Next (full-form)
- Inline error messages directly below the invalid field
- Green checkmark (✓) indicators in the trailing icon slot for valid fields
- Disabled Next button with tooltip when validation fails
- Auto-generated cascading names with manual override capability (Azure pattern)

The form is single-column layout (560px max content width), with lakehouse and notebook fields side-by-side in a 2-column grid row — matching the CEO-approved mock.

### 1.3 Component Boundaries

**InfraSetupPage owns:**
- All four form fields and their DOM elements
- Docker-style random name generation (adjective + noun + number)
- Randomize button (🎲 icon) with spin animation
- Workspace name validation (format + collision check)
- Capacity dropdown population and loading state
- "Create new capacity" link with "Coming Soon" badge
- Lakehouse/notebook name auto-sync logic
- Manual override detection and sync-break tracking
- Per-field validation state and error message rendering
- Green checkmark indicators for valid fields
- Form-level validation state emission to parent dialog

**InfraSetupPage does NOT own:**
- The wizard dialog chrome (header, footer, step indicator) — owned by C01 InfraWizardDialog
- Navigation buttons (Next/Back) — owned by C01 InfraWizardDialog
- Page transition animations — owned by C01 InfraWizardDialog
- Capacity creation flow — future feature, UI stub only
- The Bearer token or API client instance — injected from parent

### 1.4 Relationship to Parent

InfraSetupPage is instantiated by InfraWizardDialog and rendered inside the `.wizard-content` container. Communication is bidirectional:

| Direction | Channel | Data |
|-----------|---------|------|
| Parent → Page | `activate(wizardState)` | Called when page becomes visible. Receives shared wizard state object. |
| Parent → Page | `deactivate()` | Called when navigating away. Page persists state but can release focus. |
| Page → Parent | `onValidationChange(isValid)` | Callback fired whenever form validity changes. Controls Next button. |
| Page → Parent | `getData()` | Returns current form data for wizard state aggregation. |
| Parent → Page | `setData(data)` | Restores form data when navigating back to this page. |

---

## 2. Data Model

### 2.1 Form Data Schema

```typescript
interface InfraSetupData {
  /** Workspace name entered by the user or generated randomly */
  workspaceName: string;

  /** Selected capacity ID (from API response) */
  capacityId: string | null;

  /** Display string for selected capacity (e.g., "F4 — East US (Running)") */
  capacityDisplay: string;

  /** Lakehouse name — auto-synced or manually overridden */
  lakehouseName: string;

  /** Notebook name — auto-synced or manually overridden */
  notebookName: string;

  /** Whether lakehouse name has been manually edited (breaks auto-sync) */
  lakehouseManuallyEdited: boolean;

  /** Whether notebook name has been manually edited (breaks auto-sync) */
  notebookManuallyEdited: boolean;

  /** Hard-coded, non-negotiable. Included in data for downstream consumption. */
  lakehouseEnableSchemas: true;
}
```

### 2.2 Default State (on first mount)

```javascript
{
  workspaceName: '',           // Empty — randomName() called in activate()
  capacityId: null,            // No selection
  capacityDisplay: '',
  lakehouseName: '',           // Empty — derived after random generation
  notebookName: '',            // Empty — derived after random generation
  lakehouseManuallyEdited: false,
  notebookManuallyEdited: false,
  lakehouseEnableSchemas: true  // ALWAYS true — non-negotiable
}
```

### 2.3 Capacity API Response Schema

```typescript
interface CapacityListResponse {
  value: Capacity[];
}

interface Capacity {
  /** Capacity GUID */
  id: string;

  /** Display name (user-defined) */
  displayName: string;

  /** SKU tier — e.g., "F2", "F4", "F8", "F16", "F32", "F64" */
  sku: string;

  /** Azure region — e.g., "eastus", "westus2", "northeurope" */
  region: string;

  /** Current state */
  state: 'Active' | 'Provisioning' | 'Paused' | 'Deleting' | 'ProvisionFailed';

  /** Admin users (array of UPNs) */
  admins: string[];
}
```

### 2.4 Validation State Schema

```typescript
interface FieldValidation {
  /** Field identifier */
  field: 'workspaceName' | 'capacity' | 'lakehouseName' | 'notebookName';

  /** Current validation status */
  status: 'pristine' | 'validating' | 'valid' | 'invalid';

  /** Error message to display (null when valid or pristine) */
  errorMessage: string | null;

  /** Whether the field has been touched (focused then blurred) */
  touched: boolean;
}

interface FormValidationState {
  fields: Record<string, FieldValidation>;
  isFormValid: boolean;
}
```

### 2.5 Workspace Name Collision Cache

Collision checking uses the locally cached workspace list — **no real-time API call** during name validation. The workspace list is fetched once by `WorkspaceExplorer.loadWorkspaces()` at app startup and cached in `WorkspaceExplorer._workspaces`. InfraSetupPage receives this list via dependency injection.

```typescript
interface WorkspaceRef {
  id: string;
  displayName: string;
}

// Injected into InfraSetupPage constructor
type WorkspaceList = WorkspaceRef[];
```

### 2.6 Docker-Style Name Generator Data

The name generator produces names in the format `{adjective}_{noun}_{number}` where:
- `{adjective}` — randomly selected from the adjectives list
- `{noun}` — randomly selected from the nouns list (famous computer scientists and engineers)
- `{number}` — random 2-digit integer from 10–99 (inclusive)
- Separator is underscore (`_`)

Example outputs: `brave_turing_42`, `swift_hopper_17`, `calm_dijkstra_88`

#### Complete Adjective List (60 words)

```javascript
const ADJECTIVES = [
  // Positive temperament
  'brave',    'calm',     'bold',     'keen',     'wise',
  'fair',     'pure',     'warm',     'cool',     'kind',
  'glad',     'fond',     'mild',     'true',     'free',

  // Speed & energy
  'swift',    'quick',    'fast',     'brisk',    'agile',
  'fleet',    'rapid',    'lively',   'nimble',   'zippy',

  // Intellect & clarity
  'bright',   'sharp',    'clear',    'deep',     'smart',
  'lucid',    'astute',   'clever',   'witty',    'adept',

  // Strength & reliability
  'tough',    'solid',    'steady',   'firm',     'stout',
  'hardy',    'robust',   'stable',   'deft',     'able',

  // Nature & aesthetics
  'vivid',    'crisp',    'fresh',    'lush',     'sleek',
  'noble',    'prime',    'grand',    'keen',     'neat',

  // Positive vibes
  'happy',    'jolly',    'merry',    'proud',    'eager',
  'sunny',    'zesty',    'peppy',    'plucky',   'loyal',
];
```

#### Complete Noun List (60 words — Computer Scientists & Engineers)

```javascript
const NOUNS = [
  // Pioneers
  'turing',      'lovelace',    'hopper',      'dijkstra',    'knuth',
  'ritchie',     'thompson',    'mccarthy',    'backus',      'liskov',

  // Systems & languages
  'gosling',     'torvalds',    'pike',        'kernighan',   'stroustrup',
  'hejlsberg',   'matsumoto',   'wozniak',     'cerf',        'berners_lee',

  // AI & theory
  'minsky',      'shannon',     'church',      'babbage',     'von_neumann',
  'hamilton',    'boole',       'curry',       'haskell',     'erlang',

  // Modern era
  'carmack',     'dean',        'norvig',      'hinton',      'lecun',
  'bengio',      'goodfellow',  'sutskever',   'ng',          'pearl',

  // Women in computing
  'goldberg',    'lamport',     'wing',        'keller',      'shaw',
  'bartik',      'holberton',   'sammet',      'allen',       'estrin',

  // Hardware & networking
  'moore',       'grove',       'noyce',       'kilby',       'engelbart',
  'postel',      'metcalfe',    'baran',       'clark',       'floyd',
];
```

#### Generator Function

```javascript
/**
 * Generate a Docker-style random name: adjective_noun_NN
 * @returns {string} e.g., "brave_turing_42"
 */
function generateRandomName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 90) + 10; // 10–99
  return `${adj}_${noun}_${num}`;
}
```

**Collision avoidance in generation:** After generating a name, check it against the workspace list. If it collides, regenerate (up to 5 attempts). Given 60 × 60 × 90 = 324,000 possible combinations, collisions are astronomically unlikely — but we handle them defensively.

```javascript
/**
 * Generate a random name guaranteed not to collide with existing workspaces.
 * @param {WorkspaceRef[]} existingWorkspaces - Cached workspace list
 * @returns {string}
 */
function generateUniqueRandomName(existingWorkspaces) {
  const existingNames = new Set(
    existingWorkspaces.map(ws => ws.displayName.toLowerCase())
  );

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateRandomName();
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // Fallback: append timestamp fragment for guaranteed uniqueness
  const base = generateRandomName();
  const suffix = Date.now().toString(36).slice(-4);
  return `${base}_${suffix}`;
}
```

---

## 3. API Surface

### 3.1 Class Definition

```javascript
class InfraSetupPage {
  /**
   * @param {object} options
   * @param {FabricApiClient} options.apiClient - For capacity loading
   * @param {WorkspaceRef[]} options.existingWorkspaces - For collision checking
   * @param {function(boolean): void} options.onValidationChange - Callback to parent
   * @param {HTMLElement} options.containerEl - DOM container for this page
   */
  constructor(options) { /* ... */ }
}
```

### 3.2 Public Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `activate` | `activate(wizardState?: InfraSetupData)` | `void` | Called when page becomes visible. Generates random name on first activation. Restores state if `wizardState` provided (navigating back). Triggers capacity load if not loaded. |
| `deactivate` | `deactivate()` | `void` | Called when navigating away. No-op for this page (state persists in DOM). |
| `getData` | `getData()` | `InfraSetupData` | Returns current form data snapshot for wizard state aggregation. |
| `setData` | `setData(data: InfraSetupData)` | `void` | Restores form data from wizard state (e.g., navigating back from Page 2). |
| `validate` | `validate()` | `boolean` | Runs full-form validation. Returns `true` if all fields valid. Called by parent before allowing Next navigation. |
| `destroy` | `destroy()` | `void` | Removes event listeners, clears references. Called on wizard close. |
| `getValidationState` | `getValidationState()` | `FormValidationState` | Returns the current validation state of all fields. |
| `randomize` | `randomize()` | `void` | Generates a new random workspace name and cascades to synced children. Exposed for keyboard shortcut binding by parent. |

### 3.3 Events Emitted (via callback)

| Event | Payload | When Fired |
|-------|---------|------------|
| `onValidationChange` | `boolean` (isFormValid) | Whenever any field's validation status changes. Parent uses this to enable/disable the Next button. |

### 3.4 Constructor Parameters

```javascript
/**
 * @param {object} options
 * @param {FabricApiClient} options.apiClient
 *   The shared Fabric API client instance. Used to call listCapacities().
 *   Must have a valid Bearer token (checked via apiClient.hasBearerToken()).
 *
 * @param {WorkspaceRef[]} options.existingWorkspaces
 *   Array of {id, displayName} objects representing currently existing
 *   workspaces. Used for name collision checking. Sourced from
 *   WorkspaceExplorer._workspaces (cached at app startup).
 *
 * @param {function(boolean): void} options.onValidationChange
 *   Callback invoked whenever the form's overall validity changes.
 *   Parent dialog uses this to enable/disable the Next button.
 *
 * @param {HTMLElement} options.containerEl
 *   The DOM element where this page renders its content.
 *   Should be the `.page` div inside the wizard's `.page-container`.
 */
```

### 3.5 Internal Methods (Private API)

| Method | Purpose |
|--------|---------|
| `_render()` | Build initial DOM structure (labels, inputs, select, hints) |
| `_bindEvents()` | Attach input, blur, focus, click event listeners |
| `_unbindEvents()` | Remove all event listeners (for destroy) |
| `_generateRandomName()` | Call `generateUniqueRandomName()` and set workspace field |
| `_onWorkspaceNameInput(e)` | Handle workspace name typing — sanitize + cascade |
| `_onWorkspaceNameBlur()` | Validate workspace name on blur |
| `_onLakehouseNameInput(e)` | Handle lakehouse name typing — detect manual edit |
| `_onLakehouseNameBlur()` | Validate lakehouse name on blur |
| `_onNotebookNameInput(e)` | Handle notebook name typing — detect manual edit |
| `_onNotebookNameBlur()` | Validate notebook name on blur |
| `_onCapacityChange(e)` | Handle capacity dropdown selection |
| `_onRandomizeClick()` | Handle randomize button click — spin animation + regenerate |
| `_cascadeNames()` | Update lakehouse/notebook names from workspace (if not manually edited) |
| `_validateField(field)` | Run validation for a single field, update UI |
| `_validateAllFields()` | Run validation for all fields, compute form validity |
| `_updateFieldUI(field, validation)` | Set border color, show/hide error, show/hide checkmark |
| `_setFieldError(field, message)` | Show inline error below field |
| `_clearFieldError(field)` | Remove inline error, restore hint text |
| `_setFieldValid(field)` | Show green checkmark in trailing icon slot |
| `_loadCapacities()` | Async — fetch capacity list from API, populate dropdown |
| `_renderCapacityOptions(capacities)` | Build `<option>` elements from API response |
| `_showCapacityLoading()` | Show spinner/skeleton in capacity dropdown |
| `_showCapacityError(message)` | Show error state for capacity loading failure |
| `_emitValidationChange()` | Compute `isFormValid` and invoke callback |
| `_sanitizeIdentifier(value)` | Strip characters not allowed in Fabric names |
| `_checkNameCollision(name)` | Check name against cached workspace list |

---

## 4. State Machine

### 4.1 Page Lifecycle States

```
                    ┌──────────────┐
                    │  UNINITIALIZED │
                    └──────┬───────┘
                           │ constructor()
                           ▼
                    ┌──────────────┐
                    │   RENDERED    │  DOM built, events bound
                    └──────┬───────┘
                           │ activate() — first time
                           ▼
                    ┌──────────────┐
                    │   LOADING    │  Generating name + fetching capacities
                    └──────┬───────┘
                           │ capacities loaded (or failed)
                           ▼
                    ┌──────────────┐
         ┌────────▶│    ACTIVE     │◀────────┐
         │         └──────┬───────┘         │
         │                │ deactivate()     │ activate() — returning
         │                ▼                  │
         │         ┌──────────────┐         │
         │         │   INACTIVE   │─────────┘
         │         └──────┬───────┘
         │                │ destroy()
         │                ▼
         │         ┌──────────────┐
         └─ N/A ──│  DESTROYED   │
                   └──────────────┘
```

### 4.2 Field-Level States

Each of the four form fields has its own validation state machine:

```
    ┌───────────┐
    │  PRISTINE  │  Initial state — no user interaction
    └─────┬─────┘
          │ focus (user clicks/tabs into field)
          ▼
    ┌───────────┐
    │  FOCUSED   │  Field is actively being edited
    └─────┬─────┘
          │ blur (user leaves field)
          ▼
    ┌───────────┐
    │ VALIDATING │  Checking value (sync for format, async for collision)
    └─────┬─────┘
          │
     ┌────┴────┐
     ▼         ▼
┌────────┐ ┌─────────┐
│  VALID  │ │ INVALID │
└────┬───┘ └────┬────┘
     │          │
     │ input    │ input (user corrects)
     ▼          ▼
┌───────────┐
│  FOCUSED   │  Re-enters edit mode
└───────────┘
```

### 4.3 Auto-Sync State Machine (Lakehouse & Notebook)

Each auto-syncable field (lakehouse, notebook) tracks whether it's in sync with the workspace name:

```
    ┌───────────┐
    │   SYNCED   │  Value = workspaceName + suffix
    └─────┬─────┘
          │ user types in lakehouse/notebook field
          │ (value !== workspaceName + suffix)
          ▼
    ┌──────────────┐
    │  UNSYNCED     │  Manual override active — workspace changes no longer cascade
    └──────┬───────┘
           │ randomize() clicked — ALWAYS re-syncs both fields
           ▼
    ┌───────────┐
    │   SYNCED   │
    └───────────┘
```

**Key rule:** The randomize button (🎲) ALWAYS resets both lakehouse and notebook back to SYNCED state, even if they were manually edited. This is intentional — randomize is a "start fresh" action.

### 4.4 Capacity Loading States

```
    ┌──────────────┐
    │    IDLE       │  No capacities loaded yet
    └──────┬───────┘
           │ activate() triggers _loadCapacities()
           ▼
    ┌──────────────┐
    │   LOADING    │  Showing spinner in dropdown, disabled
    └──────┬───────┘
           │
     ┌─────┴──────┐
     ▼            ▼
┌─────────┐  ┌────────────┐
│  LOADED  │  │   FAILED    │  Show error + retry link
└─────────┘  └──────┬─────┘
                    │ user clicks "Retry"
                    ▼
             ┌──────────────┐
             │   LOADING    │
             └──────────────┘
```

### 4.5 Combined Form Validity

The form is valid when **ALL** of the following are true:

| Condition | Check |
|-----------|-------|
| Workspace name is non-empty | `workspaceName.trim().length > 0` |
| Workspace name passes format validation | Matches `/^[a-zA-Z0-9_]+$/` |
| Workspace name does not collide | Not in `existingWorkspaces` (case-insensitive) |
| Capacity is selected | `capacityId !== null` |
| Capacity is not in error state | `capacityLoadState !== 'FAILED'` |
| Lakehouse name is non-empty | `lakehouseName.trim().length > 0` |
| Lakehouse name passes format validation | Matches `/^[a-zA-Z][a-zA-Z0-9_]*$/` |
| Notebook name is non-empty | `notebookName.trim().length > 0` |
| Notebook name passes format validation | Matches `/^[a-zA-Z][a-zA-Z0-9_ ]*$/` |

The `isFormValid` boolean is recomputed after every field change and emitted to the parent via `onValidationChange(isFormValid)`.

---

## 5. Scenarios

### 5.1 Happy Path — First-Time User

```
1. User opens wizard → InfraWizardDialog instantiates InfraSetupPage
2. activate() is called for the first time
3. Page renders with empty fields
4. _generateRandomName() produces "bold_lamport_73"
5. Workspace name field populated: "bold_lamport_73"
6. Lakehouse auto-syncs: "bold_lamport_73_lakehouse"
7. Notebook auto-syncs: "bold_lamport_73_notebook"
8. _loadCapacities() fires → dropdown shows spinner
9. API returns 3 capacities → dropdown populated
10. User selects "F4 — East US (Active)"
11. All fields valid → green checkmarks appear
12. onValidationChange(true) → parent enables Next button
13. User clicks Next → parent calls getData() → navigates to Page 2
```

### 5.2 Randomize Flow

```
1. User sees initial random name "bold_lamport_73"
2. User doesn't like it → clicks 🎲 randomize button
3. Button spins 180° with 300ms animation
4. New name generated: "swift_hopper_42"
5. Workspace field updates: "swift_hopper_42"
6. Lakehouse field updates: "swift_hopper_42_lakehouse" (even if previously manually edited)
7. Notebook field updates: "swift_hopper_42_notebook" (even if previously manually edited)
8. lakehouseManuallyEdited → false
9. notebookManuallyEdited → false
10. Validation re-runs → checkmarks update
```

### 5.3 Manual Workspace Name Entry

```
1. User clears the workspace name field
2. Types "my_test_env"
3. As user types, _onWorkspaceNameInput fires on each keystroke
4. Invalid characters are stripped in real-time (only a-zA-Z0-9_ allowed)
5. Lakehouse auto-syncs: "my_test_env_lakehouse"
6. Notebook auto-syncs: "my_test_env_notebook"
7. User tabs out (blur) → _onWorkspaceNameBlur fires
8. Validation: non-empty ✓, format valid ✓, no collision ✓
9. Green checkmark appears on workspace field
```

### 5.4 Manual Override of Lakehouse Name

```
1. Workspace name is "bold_lamport_73"
2. Lakehouse name is "bold_lamport_73_lakehouse" (auto-synced)
3. User clicks into lakehouse field
4. User changes lakehouse name to "my_custom_lakehouse"
5. _onLakehouseNameInput detects: value !== workspaceName + "_lakehouse"
6. lakehouseManuallyEdited → true
7. "auto" pill badge disappears from lakehouse field
8. Subsequent workspace name changes NO LONGER cascade to lakehouse
9. Notebook field continues to auto-sync (it wasn't manually edited)
```

### 5.5 Workspace Name Collision

```
1. User types workspace name "existing_workspace_42"
2. On blur, _onWorkspaceNameBlur fires
3. _checkNameCollision("existing_workspace_42") → COLLISION FOUND
4. Workspace field border turns red (--status-fail)
5. Error message appears below field:
   "A workspace named 'existing_workspace_42' already exists. Choose a different name."
6. Green checkmark hidden
7. isFormValid → false
8. onValidationChange(false) → parent disables Next button
9. User edits name to "existing_workspace_43"
10. On blur → no collision → error clears → checkmark appears
```

### 5.6 Capacity Loading Failure

```
1. activate() → _loadCapacities() fires
2. API call fails (network error, 401, 500)
3. Capacity dropdown shows: "Failed to load capacities"
4. "Retry" link appears below dropdown
5. Form is invalid (no capacity selected)
6. User clicks "Retry" → _loadCapacities() fires again
7. On success → dropdown populated → user can select
```

### 5.7 Capacity Loading — Empty List

```
1. _loadCapacities() succeeds but returns empty array
2. Dropdown shows: "No capacities available"
3. Dropdown is disabled
4. Hint text below: "You need at least one Fabric capacity. Contact your admin."
5. "Create new capacity" link is visible but has "Coming Soon" badge
6. Form is invalid (no capacity can be selected)
```

### 5.8 Navigate Back from Page 2

```
1. User was on Page 2, clicks Back
2. Parent calls activate(previousInfraData)
3. setData(previousInfraData) restores all field values
4. lakehouseManuallyEdited and notebookManuallyEdited flags restored
5. Capacity dropdown re-renders with previously selected value
6. Validation state restored — checkmarks appear for valid fields
7. No new API calls (capacities already cached from first load)
```

### 5.9 All Fields Empty — Attempted Next

```
1. User somehow clears all fields (unlikely but possible)
2. Clicks Next (or parent calls validate())
3. validate() runs on all fields:
   - workspaceName: INVALID → "Workspace name is required"
   - capacity: INVALID → "Select a capacity"
   - lakehouseName: INVALID → "Lakehouse name is required"
   - notebookName: INVALID → "Notebook name is required"
4. All four fields show red borders and inline errors
5. Focus moves to the first invalid field (workspace name)
6. validate() returns false
```

### 5.10 Special Characters in Workspace Name

```
1. User types "My Test Workspace!"
2. _onWorkspaceNameInput fires on each keystroke
3. Sanitizer strips spaces, special characters: "MyTestWorkspace"
4. Only [a-zA-Z0-9_] characters allowed through
5. The input value is live-corrected (user sees characters disappear)
6. No error message — the invalid characters simply don't appear
```

### 5.11 Very Long Workspace Name

```
1. User pastes a 300-character string
2. _onWorkspaceNameInput truncates to max 256 characters
3. Remaining characters silently dropped
4. If length exactly 256: valid but no warning
5. Auto-synced lakehouse name becomes workspaceName + "_lakehouse" (could exceed 256)
6. Lakehouse validation catches overlength → error:
   "Lakehouse name exceeds maximum length (256 characters)"
```

### 5.12 Capacity Dropdown — Region/State Display

```
1. API returns capacities:
   [
     { id: "cap-1", displayName: "Dev Capacity", sku: "F4", region: "eastus", state: "Active" },
     { id: "cap-2", displayName: "Prod Capacity", sku: "F64", region: "westeurope", state: "Active" },
     { id: "cap-3", displayName: "Test Capacity", sku: "F2", region: "southeastasia", state: "Paused" }
   ]
2. Dropdown renders:
   - "Dev Capacity — F4, East US (Active)"
   - "Prod Capacity — F64, West Europe (Active)"
   - "Test Capacity — F2, Southeast Asia (Paused)"
3. Paused capacities are visually dimmed but still selectable
4. User can assign to a paused capacity (Fabric allows this)
```

### 5.13 Randomize After Manual Lakehouse Edit

```
1. Lakehouse was manually edited to "my_custom_lh"
2. User clicks 🎲 → new random name "nimble_cerf_55"
3. Workspace → "nimble_cerf_55"
4. Lakehouse → "nimble_cerf_55_lakehouse" (override reset)
5. Notebook → "nimble_cerf_55_notebook"
6. lakehouseManuallyEdited → false
7. notebookManuallyEdited → false
```

### 5.14 Keyboard-Only Navigation

```
1. Tab → workspace name field (focus)
2. Type name → Tab → capacity dropdown (focus)
3. Arrow down to select capacity → Tab → lakehouse name field
4. Tab → notebook name field
5. Tab → focus leaves form (parent Next button receives focus)
6. Enter on Next → parent calls validate() → if valid, navigate
```

### 5.15 Template Pre-Fill Flow

```
1. User selected a template on wizard start screen
2. Template has saved infra data:
   { workspaceName: "ecommerce_test", capacityId: "cap-1", ... }
3. activate(templateData) is called
4. setData(templateData) fills all fields
5. If templateData.capacityId matches a loaded capacity → that option is selected
6. If templateData.capacityId doesn't match (capacity deleted since template saved):
   → capacity shows "Select capacity..." (no selection)
   → form is invalid
   → user must re-select
```

---

## 6. Visual Spec

### 6.1 Layout Structure

```
┌─────────────────────────────────────────────────────────────┐
│                     (wizard header — not owned by this page) │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  WORKSPACE NAME                                       │  │
│  │  ┌─────────────────────────────────────┬──────┐       │  │
│  │  │ brave_turing_42                     │  🎲  │       │  │
│  │  └─────────────────────────────────────┴──────┘       │  │
│  │  ● Unique name, underscores allowed                   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  CAPACITY                                             │  │
│  │  ┌─────────────────────────────────────────────┬──┐   │  │
│  │  │ F4 — East US (Active)                       │ ▾│   │  │
│  │  └─────────────────────────────────────────────┴──┘   │  │
│  │  Create New Capacity  ┌──────────────┐                │  │
│  │                       │ Coming Soon  │                │  │
│  │                       └──────────────┘                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────┐ ┌──────────────────────────┐  │
│  │  LAKEHOUSE NAME          │ │  NOTEBOOK NAME           │  │
│  │  ┌──────────────────┬──┐ │ │  ┌──────────────────┬──┐ │  │
│  │  │ brave_turing_42_ │✓ │ │ │  │ brave_turing_42_ │✓ │ │  │
│  │  │ lakehouse        │  │ │ │  │ notebook         │  │ │  │
│  │  └──────────────────┴──┘ │ │  └──────────────────┴──┘ │  │
│  │  ● Schema-enabled        │ │  ● Auto-generated from   │  │
│  │    (always)              │ │    workspace             │  │
│  └──────────────────────────┘ └──────────────────────────┘  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                   (wizard footer — not owned by this page)   │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Design Tokens (from CEO-Approved Mock)

| Token | Value | Usage |
|-------|-------|-------|
| `--surface-2` | `#f8f9fb` | Input background |
| `--border-bright` | `rgba(0,0,0,0.12)` | Input border (default) |
| `--accent` | `#6d5cff` | Input border (focused) |
| `--shadow-glow` | `0 0 0 3px rgba(109,92,255,0.15)` | Input focus ring |
| `--status-ok` | `#18a058` | Valid checkmark color, hint dot color |
| `--status-fail` | `#e5453b` | Error border, error text |
| `--text-muted` | `#8e95a5` | Label color, hint text, placeholder |
| `--text` | `#1a1d23` | Input text |
| `--mono` | `'JetBrains Mono', ...` | Input font (monospace) |
| `--font` | `'Inter', ...` | Label and hint font |
| `--r-md` | `6px` | Input border radius |
| `--sp-5` | `20px` | Gap between form groups |
| `--sp-2` | `8px` | Gap between label and input |
| `--sp-1` | `4px` | Gap between input and hint |

### 6.3 Field Dimensions

| Element | Property | Value |
|---------|----------|-------|
| Form label | font-size | `var(--text-xs)` = 10px |
| Form label | font-weight | 700 |
| Form label | text-transform | uppercase |
| Form label | letter-spacing | 0.08em |
| Form label | color | `var(--text-muted)` |
| Form label | margin-bottom | `var(--sp-2)` = 8px |
| Input field | height | 40px |
| Input field | padding | `0 var(--sp-3)` = 0 12px |
| Input field | font-size | `var(--text-md)` = 13px (body), `var(--text-sm)` = 12px (mono) |
| Input field | font-family | `var(--mono)` for name fields |
| Input field | background | `var(--surface-2)` |
| Input field | border | `1px solid var(--border-bright)` |
| Input field | border-radius | `var(--r-md)` = 6px |
| Input field | color | `var(--text)` |
| Form hint | font-size | `var(--text-xs)` = 10px |
| Form hint | color | `var(--text-muted)` |
| Form hint | margin-top | `var(--sp-1)` = 4px |
| Form group | margin-bottom | `var(--sp-5)` = 20px |
| Form row (lakehouse + notebook) | display | grid |
| Form row | grid-template-columns | 1fr 1fr |
| Form row | gap | `var(--sp-5)` = 20px |

### 6.4 Input States

#### Default State
```css
.form-input {
  background: var(--surface-2);
  border: 1px solid var(--border-bright);
  color: var(--text);
}
```

#### Focused State
```css
.form-input:focus {
  border-color: var(--accent);
  box-shadow: var(--shadow-glow); /* 0 0 0 3px rgba(109,92,255,0.15) */
  outline: none;
}
```

#### Valid State
```css
.form-input.is-valid {
  border-color: var(--status-ok);
}
/* Green checkmark icon visible in trailing slot */
.input-icon.valid {
  color: var(--status-ok);
  opacity: 1;
}
```

#### Invalid State
```css
.form-input.is-invalid {
  border-color: var(--status-fail);
}
/* Error message replaces hint text */
.form-error {
  font-size: var(--text-xs);
  color: var(--status-fail);
  margin-top: var(--sp-1);
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
```

#### Disabled State (capacity dropdown during loading)
```css
.form-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: var(--surface-3);
}
```

### 6.5 Randomize Button

| Property | Value |
|----------|-------|
| Position | Absolute, inside `.input-wrapper`, right side |
| Size | 28px × 28px |
| Border-radius | `var(--r-sm)` = 4px |
| Default color | `var(--text-muted)` |
| Hover color | `var(--accent)` |
| Hover background | `var(--surface-3)` |
| Icon | SVG refresh/dice arrows, 14px × 14px |
| Click animation | Rotate 180° over 300ms, ease transition |
| Cursor | pointer |

### 6.6 Green Checkmark Indicator

| Property | Value |
|----------|-------|
| Character | `✓` (Unicode U+2713) |
| Position | Absolute, inside `.input-wrapper`, right side (same slot as randomize for other fields) |
| Color | `var(--status-ok)` = `#18a058` |
| Font-size | 14px |
| Visibility | Hidden by default. Shown when field status is `valid` AND field has been `touched`. |
| Animation | Fade-in 150ms ease |

### 6.7 Capacity Dropdown

| Property | Value |
|----------|-------|
| Height | 40px |
| Appearance | `none` (custom arrow) |
| Arrow | `▾` character, positioned absolute right, `var(--text-muted)`, pointer-events: none |
| Padding-right | 32px (room for arrow) |
| Option format | `"{displayName} — {sku}, {region} ({state})"` |
| Loading state | Disabled, single option: "Loading capacities..." |
| Error state | Disabled, single option: "Failed to load — click Retry" |
| Empty state | Disabled, single option: "No capacities available" |

### 6.8 "Coming Soon" Link + Badge

```
Layout: inline-flex, align-items center, gap 8px
Link text: "Create New Capacity"
Link color: var(--text-muted)
Link font-size: var(--text-xs) = 10px
Badge: "COMING SOON"
Badge font-size: 9px
Badge font-weight: 700
Badge text-transform: uppercase
Badge letter-spacing: 0.06em
Badge padding: 1px 6px
Badge border-radius: var(--r-full) = 100px
Badge background: var(--surface-3)
Badge color: var(--text-muted)
Link cursor: default (not clickable)
Link pointer-events: none
```

### 6.9 Hint Text

| Property | Value |
|----------|-------|
| Layout | Flex row, align-items center, gap `var(--sp-1)` |
| Font-size | `var(--text-xs)` = 10px |
| Color | `var(--text-muted)` |
| Dot character | `●` (Unicode U+25CF) |
| Dot color | `var(--status-ok)` |

Hint messages per field:

| Field | Hint Text |
|-------|-----------|
| Workspace Name | `● Unique name, underscores allowed` |
| Capacity | (none — "Create New Capacity" link serves as hint) |
| Lakehouse Name | `● Schema-enabled (always)` |
| Notebook Name | `● Auto-generated from workspace` |

### 6.10 Error Text (replaces hint when invalid)

| Property | Value |
|----------|-------|
| Font-size | `var(--text-xs)` = 10px |
| Color | `var(--status-fail)` = `#e5453b` |
| Icon | None (text-only, matching Stripe pattern) |
| Transition | Fade-in 150ms when error appears, instant hide when corrected |

### 6.11 Entry Animation (Staggered Slide-Up)

When the page becomes active, form groups animate in with staggered delays (from the CEO-approved mock):

```css
.page.active .form-group:nth-child(1) { animation: slideUp 400ms var(--ease) 50ms both; }
.page.active .form-group:nth-child(2) { animation: slideUp 400ms var(--ease) 100ms both; }
.page.active .form-group:nth-child(3) { animation: slideUp 400ms var(--ease) 150ms both; }

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

The form row (lakehouse + notebook) is a single `.form-group` that animates together — the two fields within the row don't stagger independently. This gives 3 stagger steps: workspace → capacity → lakehouse/notebook row.

### 6.12 Auto-Sync Visual Indicator

When a field is auto-synced from the workspace name, it shows a subtle "auto" pill badge:

| Property | Value |
|----------|-------|
| Text | "auto" |
| Position | Right side of the label row (inline with label text) |
| Font-size | 9px |
| Font-weight | 600 |
| Text-transform | uppercase |
| Letter-spacing | 0.05em |
| Padding | 1px 5px |
| Border-radius | `var(--r-sm)` = 4px |
| Background | `var(--accent-dim)` = `rgba(109,92,255,0.07)` |
| Color | `var(--accent)` = `#6d5cff` |
| Visibility | Shown when field is in SYNCED state, hidden when UNSYNCED |
| Transition | Fade out 150ms when user manually edits |

---

## 7. Keyboard & Accessibility

### 7.1 Tab Order

The tab order follows the visual layout top-to-bottom, left-to-right:

| Tab Index | Element | Notes |
|-----------|---------|-------|
| 1 | Workspace name input | First focusable element on page |
| 2 | Randomize button (🎲) | Inside workspace input wrapper |
| 3 | Capacity dropdown (`<select>`) | Standard browser select behavior |
| 4 | Lakehouse name input | Left column of form row |
| 5 | Notebook name input | Right column of form row |
| — | Next button (in footer) | Owned by parent, outside this page |

### 7.2 Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Tab` | Any field | Move to next field in tab order |
| `Shift+Tab` | Any field | Move to previous field in tab order |
| `Enter` | Any field | Submit/move to next step (handled by parent, not this page) |
| `Escape` | Any field | Close wizard (with confirmation, handled by parent) |
| `Space` | Randomize button focused | Trigger randomize (standard button behavior) |
| `Enter` | Randomize button focused | Trigger randomize (standard button behavior) |
| `Arrow Down/Up` | Capacity dropdown focused | Navigate capacity options (native `<select>` behavior) |

### 7.3 ARIA Attributes

```html
<!-- Workspace name field -->
<div class="form-group" role="group" aria-labelledby="ws-label">
  <label id="ws-label" class="form-label" for="wsName">Workspace Name</label>
  <div class="input-wrapper">
    <input
      id="wsName"
      class="form-input mono"
      type="text"
      spellcheck="false"
      autocomplete="off"
      aria-required="true"
      aria-describedby="ws-hint"
      aria-invalid="false"
    >
    <button
      id="randomizeBtn"
      class="input-icon"
      type="button"
      aria-label="Randomize workspace name"
      title="Randomize name"
    >
      <!-- SVG icon -->
    </button>
  </div>
  <div id="ws-hint" class="form-hint" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true">●</span> Unique name, underscores allowed
  </div>
</div>

<!-- Capacity dropdown -->
<div class="form-group" role="group" aria-labelledby="cap-label">
  <label id="cap-label" class="form-label" for="capacitySelect">Capacity</label>
  <div class="select-wrapper">
    <select
      id="capacitySelect"
      class="form-select"
      aria-required="true"
      aria-describedby="cap-hint"
      aria-busy="false"
    >
      <option value="" disabled selected>Select capacity...</option>
    </select>
    <span class="select-arrow" aria-hidden="true">▾</span>
  </div>
  <div id="cap-hint" class="coming-soon-link" aria-hidden="true">
    <span>Create New Capacity</span>
    <span class="coming-soon-badge">Coming Soon</span>
  </div>
</div>

<!-- Lakehouse name field -->
<div class="form-group" role="group" aria-labelledby="lh-label">
  <label id="lh-label" class="form-label" for="lhName">
    Lakehouse Name
    <span class="auto-badge" aria-label="auto-generated">auto</span>
  </label>
  <div class="input-wrapper">
    <input
      id="lhName"
      class="form-input mono"
      type="text"
      spellcheck="false"
      autocomplete="off"
      aria-required="true"
      aria-describedby="lh-hint"
      aria-invalid="false"
    >
    <span class="input-icon valid" aria-hidden="true">✓</span>
  </div>
  <div id="lh-hint" class="form-hint" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true">●</span> Schema-enabled (always)
  </div>
</div>

<!-- Notebook name field -->
<div class="form-group" role="group" aria-labelledby="nb-label">
  <label id="nb-label" class="form-label" for="nbName">
    Notebook Name
    <span class="auto-badge" aria-label="auto-generated">auto</span>
  </label>
  <div class="input-wrapper">
    <input
      id="nbName"
      class="form-input mono"
      type="text"
      spellcheck="false"
      autocomplete="off"
      aria-required="true"
      aria-describedby="nb-hint"
      aria-invalid="false"
    >
    <span class="input-icon valid" aria-hidden="true">✓</span>
  </div>
  <div id="nb-hint" class="form-hint" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true">●</span> Auto-generated from workspace
  </div>
</div>
```

### 7.4 ARIA State Transitions

When a field becomes invalid:
```javascript
inputEl.setAttribute('aria-invalid', 'true');
hintEl.textContent = errorMessage;  // replaces hint with error
hintEl.setAttribute('role', 'alert'); // announces to screen reader
```

When a field becomes valid:
```javascript
inputEl.setAttribute('aria-invalid', 'false');
hintEl.textContent = originalHint;  // restore hint
hintEl.setAttribute('role', 'status'); // back to polite
```

When capacity is loading:
```javascript
selectEl.setAttribute('aria-busy', 'true');
selectEl.disabled = true;
```

### 7.5 Focus Management

| Event | Focus Behavior |
|-------|----------------|
| Page activation (first time) | Focus workspace name input after 100ms delay (allows entry animation) |
| Page activation (returning) | Focus first invalid field; if all valid, focus workspace name |
| Randomize click | Focus stays on randomize button (don't steal focus) |
| Full-form validation failure | Focus first invalid field, announce error via `aria-live` |
| Capacity load complete | If capacity dropdown had focus, keep focus there |

### 7.6 Screen Reader Announcements

| Event | Announcement | Method |
|-------|--------------|--------|
| Page loads | "Infrastructure Setup, step 1 of 5" | Parent dialog responsibility |
| Randomize | "Workspace name randomized: {name}" | `aria-live="assertive"` on a visually hidden region |
| Field validated (valid) | "Workspace name is valid" | `aria-live="polite"` on hint element |
| Field validated (error) | "{error message}" | `role="alert"` on error element |
| Capacity loaded | "{count} capacities available" | `aria-live="polite"` on hidden status |
| Capacity failed | "Failed to load capacities. Retry available." | `role="alert"` |

### 7.7 Color Contrast Compliance

All text meets WCAG 2.1 AA contrast requirements:

| Element | Foreground | Background | Ratio | Passes |
|---------|-----------|------------|-------|--------|
| Label text | `#8e95a5` (--text-muted) | `#ffffff` (--surface) | 3.5:1 | AA (large text) |
| Input text | `#1a1d23` (--text) | `#f8f9fb` (--surface-2) | 14.8:1 | AAA |
| Hint text | `#8e95a5` | `#ffffff` | 3.5:1 | AA (large text) |
| Error text | `#e5453b` (--status-fail) | `#ffffff` | 4.2:1 | AA |
| Valid checkmark | `#18a058` (--status-ok) | `#f8f9fb` | 3.8:1 | AA |

**Note:** Labels at 10px with `var(--text-xs)` are below WCAG's 14px "large text" threshold. The 3.5:1 ratio technically fails AA for small text (needs 4.5:1). However, the labels are UPPERCASE with 700 weight + letter-spacing, which improves legibility. This matches the CEO-approved mock and is an accepted design trade-off documented in the Design Bible. If accessibility audit flags this, increase label opacity or switch to `var(--text-dim)` (#5a6070, ratio 6.3:1).

---

## 8. Error Handling

### 8.1 Validation Rules — Complete Reference

#### Workspace Name

| Rule # | Rule | Check | Error Message |
|--------|------|-------|---------------|
| WS-01 | Required | `value.trim().length === 0` | "Workspace name is required" |
| WS-02 | Minimum length | `value.trim().length < 3` | "Name must be at least 3 characters" |
| WS-03 | Maximum length | `value.length > 256` | "Name must be 256 characters or fewer" |
| WS-04 | Valid characters | `!/^[a-zA-Z0-9_]+$/.test(value)` | "Only letters, numbers, and underscores allowed" |
| WS-05 | Must start with letter or number | `!/^[a-zA-Z0-9]/.test(value)` | "Name must start with a letter or number" |
| WS-06 | No consecutive underscores | `/__/.test(value)` | "Consecutive underscores are not allowed" |
| WS-07 | Must not end with underscore | `/_$/.test(value)` | "Name must not end with an underscore" |
| WS-08 | Name collision | `existingNames.has(value.toLowerCase())` | "A workspace named '{value}' already exists. Choose a different name." |
| WS-09 | Reserved words | `RESERVED_NAMES.has(value.toLowerCase())` | "'{value}' is a reserved name. Choose a different name." |

**Reserved names list:**
```javascript
const RESERVED_NAMES = new Set([
  'default', 'system', 'admin', 'test', 'null', 'undefined',
  'true', 'false', 'workspace', 'my_workspace', 'new_workspace',
]);
```

**Validation order:** Rules are checked in order WS-01 through WS-09. First failure stops the chain (only one error shown at a time).

#### Capacity

| Rule # | Rule | Check | Error Message |
|--------|------|-------|---------------|
| CAP-01 | Required | `capacityId === null \|\| capacityId === ''` | "Select a capacity to continue" |
| CAP-02 | Valid selection | Selected value not in loaded capacities | "Selected capacity is no longer available. Please choose another." |

#### Lakehouse Name

| Rule # | Rule | Check | Error Message |
|--------|------|-------|---------------|
| LH-01 | Required | `value.trim().length === 0` | "Lakehouse name is required" |
| LH-02 | Minimum length | `value.trim().length < 3` | "Name must be at least 3 characters" |
| LH-03 | Maximum length | `value.length > 256` | "Lakehouse name exceeds maximum length (256 characters)" |
| LH-04 | Valid characters | `!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value)` | "Must start with a letter and contain only letters, numbers, and underscores" |
| LH-05 | Must start with letter | `!/^[a-zA-Z]/.test(value)` | "Lakehouse name must start with a letter" |
| LH-06 | No consecutive underscores | `/__/.test(value)` | "Consecutive underscores are not allowed" |
| LH-07 | Must not end with underscore | `/_$/.test(value)` | "Name must not end with an underscore" |

#### Notebook Name

| Rule # | Rule | Check | Error Message |
|--------|------|-------|---------------|
| NB-01 | Required | `value.trim().length === 0` | "Notebook name is required" |
| NB-02 | Minimum length | `value.trim().length < 3` | "Name must be at least 3 characters" |
| NB-03 | Maximum length | `value.length > 256` | "Notebook name exceeds maximum length (256 characters)" |
| NB-04 | Valid characters | `!/^[a-zA-Z][a-zA-Z0-9_ ]*$/.test(value)` | "Must start with a letter and contain only letters, numbers, underscores, and spaces" |
| NB-05 | Must start with letter | `!/^[a-zA-Z]/.test(value)` | "Notebook name must start with a letter" |
| NB-06 | No consecutive underscores | `/__/.test(value)` | "Consecutive underscores are not allowed" |
| NB-07 | No consecutive spaces | `/  /.test(value)` | "Consecutive spaces are not allowed" |
| NB-08 | Must not end with underscore or space | `/[_ ]$/.test(value)` | "Name must not end with an underscore or space" |

**Note:** Notebook names allow spaces (Fabric API accepts them), unlike workspace and lakehouse names. This is intentional — notebooks often have human-readable names.

### 8.2 Validation Pseudocode

```javascript
/**
 * Validate a single field.
 * @param {'workspaceName'|'capacity'|'lakehouseName'|'notebookName'} field
 * @returns {FieldValidation}
 */
_validateField(field) {
  const value = this._getFieldValue(field);
  let result = { field, status: 'valid', errorMessage: null, touched: true };

  switch (field) {
    case 'workspaceName': {
      if (value.trim().length === 0) {
        result = { ...result, status: 'invalid', errorMessage: 'Workspace name is required' };
      } else if (value.trim().length < 3) {
        result = { ...result, status: 'invalid', errorMessage: 'Name must be at least 3 characters' };
      } else if (value.length > 256) {
        result = { ...result, status: 'invalid', errorMessage: 'Name must be 256 characters or fewer' };
      } else if (!/^[a-zA-Z0-9_]+$/.test(value)) {
        result = { ...result, status: 'invalid', errorMessage: 'Only letters, numbers, and underscores allowed' };
      } else if (!/^[a-zA-Z0-9]/.test(value)) {
        result = { ...result, status: 'invalid', errorMessage: 'Name must start with a letter or number' };
      } else if (/__/.test(value)) {
        result = { ...result, status: 'invalid', errorMessage: 'Consecutive underscores are not allowed' };
      } else if (/_$/.test(value)) {
        result = { ...result, status: 'invalid', errorMessage: 'Name must not end with an underscore' };
      } else if (this._checkNameCollision(value)) {
        result = { ...result, status: 'invalid',
          errorMessage: `A workspace named '${value}' already exists. Choose a different name.` };
      } else if (RESERVED_NAMES.has(value.toLowerCase())) {
        result = { ...result, status: 'invalid',
          errorMessage: `'${value}' is a reserved name. Choose a different name.` };
      }
      break;
    }

    case 'capacity': {
      if (!this._data.capacityId) {
        result = { ...result, status: 'invalid', errorMessage: 'Select a capacity to continue' };
      }
      break;
    }

    case 'lakehouseName': {
      if (value.trim().length === 0) {
        result = { ...result, status: 'invalid', errorMessage: 'Lakehouse name is required' };
      } else if (value.trim().length < 3) {
        result = { ...result, status: 'invalid', errorMessage: 'Name must be at least 3 characters' };
      } else if (value.length > 256) {
        result = { ...result, status: 'invalid',
          errorMessage: 'Lakehouse name exceeds maximum length (256 characters)' };
      } else if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value)) {
        result = { ...result, status: 'invalid',
          errorMessage: 'Must start with a letter and contain only letters, numbers, and underscores' };
      } else if (/__/.test(value)) {
        result = { ...result, status: 'invalid', errorMessage: 'Consecutive underscores are not allowed' };
      } else if (/_$/.test(value)) {
        result = { ...result, status: 'invalid', errorMessage: 'Name must not end with an underscore' };
      }
      break;
    }

    case 'notebookName': {
      if (value.trim().length === 0) {
        result = { ...result, status: 'invalid', errorMessage: 'Notebook name is required' };
      } else if (value.trim().length < 3) {
        result = { ...result, status: 'invalid', errorMessage: 'Name must be at least 3 characters' };
      } else if (value.length > 256) {
        result = { ...result, status: 'invalid',
          errorMessage: 'Notebook name exceeds maximum length (256 characters)' };
      } else if (!/^[a-zA-Z][a-zA-Z0-9_ ]*$/.test(value)) {
        result = { ...result, status: 'invalid',
          errorMessage: 'Must start with a letter and contain only letters, numbers, underscores, and spaces' };
      } else if (/__/.test(value)) {
        result = { ...result, status: 'invalid', errorMessage: 'Consecutive underscores are not allowed' };
      } else if (/  /.test(value)) {
        result = { ...result, status: 'invalid', errorMessage: 'Consecutive spaces are not allowed' };
      } else if (/[_ ]$/.test(value)) {
        result = { ...result, status: 'invalid', errorMessage: 'Name must not end with an underscore or space' };
      }
      break;
    }
  }

  this._validationState.fields[field] = result;
  this._updateFieldUI(field, result);
  this._emitValidationChange();
  return result;
}
```

### 8.3 Auto-Sync Pseudocode

```javascript
/**
 * Cascade workspace name changes to lakehouse and notebook fields.
 * Called on every workspace name input event.
 */
_cascadeNames() {
  const wsName = this._els.wsNameInput.value;

  // Cascade to lakehouse if not manually edited
  if (!this._data.lakehouseManuallyEdited) {
    const lhName = wsName ? `${wsName}_lakehouse` : '';
    this._els.lhNameInput.value = lhName;
    this._data.lakehouseName = lhName;

    // Show "auto" badge
    this._els.lhAutoBadge.style.display = '';

    // Re-validate lakehouse if it was previously touched
    if (this._validationState.fields.lakehouseName.touched) {
      this._validateField('lakehouseName');
    }
  }

  // Cascade to notebook if not manually edited
  if (!this._data.notebookManuallyEdited) {
    const nbName = wsName ? `${wsName}_notebook` : '';
    this._els.nbNameInput.value = nbName;
    this._data.notebookName = nbName;

    // Show "auto" badge
    this._els.nbAutoBadge.style.display = '';

    // Re-validate notebook if it was previously touched
    if (this._validationState.fields.notebookName.touched) {
      this._validateField('notebookName');
    }
  }
}

/**
 * Detect manual edit on lakehouse field.
 * Called on lakehouse name input event.
 */
_onLakehouseNameInput(e) {
  const value = e.target.value;
  this._data.lakehouseName = value;

  // Check if user has manually deviated from auto-generated name
  const expectedAutoName = `${this._data.workspaceName}_lakehouse`;
  if (value !== expectedAutoName) {
    this._data.lakehouseManuallyEdited = true;
    // Hide "auto" badge with fade
    this._els.lhAutoBadge.style.display = 'none';
  }
}

/**
 * Detect manual edit on notebook field.
 * Called on notebook name input event.
 */
_onNotebookNameInput(e) {
  const value = e.target.value;
  this._data.notebookName = value;

  // Check if user has manually deviated from auto-generated name
  const expectedAutoName = `${this._data.workspaceName}_notebook`;
  if (value !== expectedAutoName) {
    this._data.notebookManuallyEdited = true;
    // Hide "auto" badge with fade
    this._els.nbAutoBadge.style.display = 'none';
  }
}

/**
 * Full randomize — generates new name and ALWAYS re-syncs children.
 * This resets manual edit flags.
 */
randomize() {
  const name = generateUniqueRandomName(this._existingWorkspaces);

  // Update workspace
  this._els.wsNameInput.value = name;
  this._data.workspaceName = name;

  // Force-reset manual edit flags
  this._data.lakehouseManuallyEdited = false;
  this._data.notebookManuallyEdited = false;

  // Cascade (will now work since manual flags are reset)
  this._cascadeNames();

  // Validate all name fields
  this._validateField('workspaceName');
  this._validateField('lakehouseName');
  this._validateField('notebookName');

  // Spin animation on randomize button
  this._els.randomizeBtn.style.transform = 'translateY(-50%) rotate(180deg)';
  setTimeout(() => {
    this._els.randomizeBtn.style.transform = 'translateY(-50%)';
  }, 300);
}
```

### 8.4 Capacity Loading Pseudocode

```javascript
/**
 * Load capacities from Fabric API and populate dropdown.
 * Called on first page activation.
 */
async _loadCapacities() {
  // Guard: don't re-fetch if already loaded
  if (this._capacitiesLoaded) return;

  // Show loading state
  this._showCapacityLoading();

  try {
    // Guard: check for token
    if (!this._apiClient.hasBearerToken()) {
      throw new Error('No Bearer token available. Please authenticate first.');
    }

    const response = await this._apiClient.listCapacities();
    const capacities = response?.value || [];

    if (capacities.length === 0) {
      this._showCapacityEmpty();
      return;
    }

    this._renderCapacityOptions(capacities);
    this._capacitiesLoaded = true;
    this._capacities = capacities;

    // If restoring from saved state, re-select the previously chosen capacity
    if (this._data.capacityId) {
      const exists = capacities.find(c => c.id === this._data.capacityId);
      if (exists) {
        this._els.capacitySelect.value = this._data.capacityId;
      } else {
        // Previously selected capacity no longer exists
        this._data.capacityId = null;
        this._data.capacityDisplay = '';
      }
    }

    // Announce to screen readers
    this._announceToSR(`${capacities.length} capacities available`);

  } catch (error) {
    this._showCapacityError(error.message || 'Failed to load capacities');
  }
}

/**
 * Render capacity options in the dropdown.
 * Format: "{displayName} — {sku}, {region} ({state})"
 */
_renderCapacityOptions(capacities) {
  const select = this._els.capacitySelect;
  select.disabled = false;
  select.setAttribute('aria-busy', 'false');

  // Clear existing options except placeholder
  while (select.options.length > 1) {
    select.remove(1);
  }

  // Region display name mapping
  const REGION_DISPLAY = {
    'eastus': 'East US',
    'eastus2': 'East US 2',
    'westus': 'West US',
    'westus2': 'West US 2',
    'westus3': 'West US 3',
    'centralus': 'Central US',
    'northcentralus': 'North Central US',
    'southcentralus': 'South Central US',
    'northeurope': 'North Europe',
    'westeurope': 'West Europe',
    'uksouth': 'UK South',
    'ukwest': 'UK West',
    'eastasia': 'East Asia',
    'southeastasia': 'Southeast Asia',
    'japaneast': 'Japan East',
    'japanwest': 'Japan West',
    'australiaeast': 'Australia East',
    'australiasoutheast': 'Australia Southeast',
    'canadacentral': 'Canada Central',
    'canadaeast': 'Canada East',
    'brazilsouth': 'Brazil South',
    'koreacentral': 'Korea Central',
    'koreasouth': 'Korea South',
    'francecentral': 'France Central',
    'southafricanorth': 'South Africa North',
    'uaenorth': 'UAE North',
    'switzerlandnorth': 'Switzerland North',
    'germanywestcentral': 'Germany West Central',
    'norwayeast': 'Norway East',
    'swedencentral': 'Sweden Central',
    'qatarcentral': 'Qatar Central',
    'polandcentral': 'Poland Central',
    'italynorth': 'Italy North',
  };

  for (const cap of capacities) {
    const opt = document.createElement('option');
    opt.value = cap.id;
    const regionDisplay = REGION_DISPLAY[cap.region] || cap.region;
    opt.textContent = `${cap.displayName} — ${cap.sku}, ${regionDisplay} (${cap.state})`;
    if (cap.state === 'Paused') {
      opt.style.color = 'var(--text-muted)';
    }
    select.appendChild(opt);
  }
}

/**
 * Show loading state in capacity dropdown.
 */
_showCapacityLoading() {
  const select = this._els.capacitySelect;
  select.disabled = true;
  select.setAttribute('aria-busy', 'true');

  // Replace placeholder option text
  select.options[0].textContent = 'Loading capacities...';
  select.options[0].selected = true;
}

/**
 * Show error state for capacity loading failure.
 */
_showCapacityError(message) {
  const select = this._els.capacitySelect;
  select.disabled = true;
  select.setAttribute('aria-busy', 'false');
  select.options[0].textContent = 'Failed to load capacities';
  select.options[0].selected = true;

  // Show retry link in the hint area below
  const hintArea = this._els.capacityHint;
  hintArea.innerHTML = '';

  const errorText = document.createElement('span');
  errorText.className = 'form-error';
  errorText.textContent = message;

  const retryLink = document.createElement('button');
  retryLink.type = 'button';
  retryLink.className = 'retry-link';
  retryLink.textContent = 'Retry';
  retryLink.setAttribute('aria-label', 'Retry loading capacities');
  retryLink.addEventListener('click', () => this._loadCapacities());

  hintArea.appendChild(errorText);
  hintArea.appendChild(document.createTextNode(' '));
  hintArea.appendChild(retryLink);
}

/**
 * Show empty state for capacity dropdown.
 */
_showCapacityEmpty() {
  const select = this._els.capacitySelect;
  select.disabled = true;
  select.options[0].textContent = 'No capacities available';
  select.options[0].selected = true;

  const hintArea = this._els.capacityHint;
  hintArea.innerHTML = '';
  const msg = document.createElement('span');
  msg.className = 'form-hint';
  msg.textContent = 'You need at least one Fabric capacity. Contact your admin.';
  hintArea.appendChild(msg);
}
```

### 8.5 Input Sanitization Pseudocode

```javascript
/**
 * Live sanitization for workspace name input.
 * Called on every 'input' event.
 * Strips disallowed characters in real-time.
 */
_onWorkspaceNameInput(e) {
  const raw = e.target.value;

  // Strip everything except [a-zA-Z0-9_]
  const sanitized = raw.replace(/[^a-zA-Z0-9_]/g, '');

  // Enforce max length
  const truncated = sanitized.slice(0, 256);

  // Only update DOM if value changed (prevents cursor jump)
  if (truncated !== raw) {
    const cursorPos = e.target.selectionStart - (raw.length - truncated.length);
    e.target.value = truncated;
    e.target.setSelectionRange(
      Math.max(0, cursorPos),
      Math.max(0, cursorPos)
    );
  }

  this._data.workspaceName = truncated;
  this._cascadeNames();

  // Clear any existing error if user is actively typing
  // (validation happens on blur, not on input)
  if (this._validationState.fields.workspaceName.status === 'invalid') {
    // Keep the error visible — only clear on successful blur validation
    // This matches the Stripe pattern: errors stay until corrected + blur
  }
}
```

### 8.6 Error Recovery Matrix

| Error Condition | User Impact | Recovery Path |
|----------------|-------------|---------------|
| Capacity API returns 401 | Dropdown shows "Failed to load" | Retry link → re-authenticates if token expired |
| Capacity API returns 500 | Dropdown shows "Failed to load" | Retry link → automatic retry |
| Capacity API timeout | Dropdown shows "Failed to load" | Retry link → retry with timeout extension |
| Network offline | Dropdown shows "Failed to load" | Retry link → retries when back online |
| Workspace name collision | Red border + inline error | User edits name or clicks randomize |
| Lakehouse name auto-sync creates invalid name | Red border on lakehouse field | User manually edits lakehouse name |
| All capacities are in "Paused" state | Capacities still selectable (dimmed) | User selects paused capacity (Fabric allows assignment) |
| All capacities deleted between load and selection | Stale data — will fail at execution time | Handled by ExecutionPipeline (C10) with retry |
| Browser autofill overwrites fields | Auto-sync logic may break | `autocomplete="off"` on all inputs prevents this |

---

## 9. Performance

### 9.1 Render Budget

| Metric | Budget | Notes |
|--------|--------|-------|
| Time to interactive (page mount → fields editable) | < 50ms | DOM construction is simple (4 fields) |
| Time to first paint (entry animation start) | < 16ms | Single `requestAnimationFrame` for animation setup |
| Capacity API call duration | < 2000ms | Show loading state immediately, timeout at 10s |
| Input event handler latency | < 4ms | Sanitization + cascade are synchronous, O(1) |
| Validation (single field) | < 1ms | All checks are regex/set-lookup, O(1) |
| Full-form validation (all 4 fields) | < 4ms | Sequential validation of 4 fields |
| Name collision check | < 1ms | Set lookup against cached workspace list (typically < 100 items) |

### 9.2 DOM Element Count

| Element Category | Count | Notes |
|-----------------|-------|-------|
| Form groups | 4 | (3 visible groups: workspace, capacity, lakehouse+notebook row) |
| Input elements | 3 | Workspace, lakehouse, notebook |
| Select elements | 1 | Capacity dropdown |
| Button elements | 1 | Randomize |
| Label elements | 4 | One per field |
| Hint/error elements | 4 | One per field (toggle between hint/error content) |
| Icon elements | 3 | Randomize SVG, lakehouse ✓, notebook ✓ |
| Badge elements | 2 | "auto" pills on lakehouse and notebook |
| Coming soon elements | 2 | Link text + badge |
| **Total DOM nodes** | **~35** | Lightweight — no performance concerns |

### 9.3 Event Listener Count

| Event | Element | Handler | Debounced? |
|-------|---------|---------|------------|
| `input` | Workspace name input | `_onWorkspaceNameInput` | No (needs instant sanitization) |
| `blur` | Workspace name input | `_onWorkspaceNameBlur` | No |
| `focus` | Workspace name input | Mark as touched | No |
| `input` | Lakehouse name input | `_onLakehouseNameInput` | No |
| `blur` | Lakehouse name input | `_onLakehouseNameBlur` | No |
| `focus` | Lakehouse name input | Mark as touched | No |
| `input` | Notebook name input | `_onNotebookNameInput` | No |
| `blur` | Notebook name input | `_onNotebookNameBlur` | No |
| `focus` | Notebook name input | Mark as touched | No |
| `change` | Capacity select | `_onCapacityChange` | No |
| `click` | Randomize button | `_onRandomizeClick` | No |
| **Total** | | **11 listeners** | |

All listeners are bound with `{ passive: true }` where possible. All are removed in `destroy()`.

### 9.4 Memory Footprint

| Data | Size | Notes |
|------|------|-------|
| Adjective list | ~600 bytes | 60 strings, static |
| Noun list | ~720 bytes | 60 strings, static |
| Existing workspace list (cached) | ~10 KB typical | 100 workspaces × ~100 bytes each |
| Workspace name set (for collision) | ~5 KB typical | Set of lowercase workspace names |
| Capacity list (cached) | ~2 KB typical | 10 capacities × ~200 bytes each |
| Region display map | ~1.5 KB | 33 regions × ~45 bytes each |
| Form data object | ~500 bytes | 7 fields |
| Validation state | ~300 bytes | 4 field validations |
| **Total component memory** | **~20 KB** | Negligible |

### 9.5 Network Requests

| Request | When | Cached? | Fallback |
|---------|------|---------|----------|
| `GET /v1.0/myorg/capacities` | First page activation | Yes — only fetched once per wizard session | Error state with retry |
| Workspace list | Already cached by `WorkspaceExplorer` at app startup | Yes — injected, not re-fetched | Use whatever's in cache |

**Total network requests triggered by this page: 1** (capacity list)

### 9.6 Optimization Notes

- **No debouncing on input events**: The sanitizer and cascade logic are O(1) and complete in < 1ms. Debouncing would add latency to the name sync, making it feel sluggish. Input events fire at most ~60Hz (one per frame during fast typing), so 11 listeners × 60Hz = 660 handler invocations/second maximum — trivial.

- **No virtual rendering**: With ~35 DOM nodes, there is nothing to virtualize.

- **Capacity list caching**: Cached in `this._capacities` after first load. Subsequent `activate()` calls skip the API request. The cache is invalidated only on `destroy()` (wizard close).

- **Workspace name set pre-computation**: The collision check set (`new Set(workspaces.map(ws => ws.displayName.toLowerCase()))`) is computed once in the constructor, not on every validation call.

---

## 10. Implementation Notes

### 10.1 File Placement

```
src/frontend/js/infra-wizard/
├── infra-setup-page.js     ← This component
├── infra-wizard-dialog.js  ← Parent (C01)
├── theme-schema-page.js    ← Page 2 (C03)
├── ...
└── name-generator.js       ← Docker-style name generator (shared utility)
```

The `name-generator.js` module exports `generateRandomName()` and `generateUniqueRandomName()` as standalone functions — they're stateless utilities, not tied to any component. This allows reuse in tests and potentially in other features.

### 10.2 CSS Location

All styles are in `src/frontend/css/infra-wizard.css`, shared across all wizard pages. InfraSetupPage uses these class names from the CEO-approved mock:

```
.form-group
.form-label
.form-input
.form-input.mono
.form-input.is-valid
.form-input.is-invalid
.input-wrapper
.input-icon
.input-icon.valid
.form-hint
.form-hint .dot
.form-error
.form-row
.select-wrapper
.form-select
.select-arrow
.coming-soon-link
.coming-soon-badge
.auto-badge       ← NEW (not in mock, added for auto-sync indicator)
.retry-link       ← NEW (not in mock, added for capacity error recovery)
```

### 10.3 API Client Extension

The `listCapacities()` method must be added to `FabricApiClient` before this component can be implemented. As identified in the P0.1 code audit:

```javascript
// In api-client.js
async listCapacities() {
  // GET /v1.0/myorg/capacities
  // NOTE: This endpoint may use a different base URL than the
  // standard Fabric v1 API. The Power BI REST API uses
  // https://api.powerbi.com/v1.0/myorg/capacities
  // We may need to proxy through a different route.
  return this._fabricFetch('/capacities', {
    method: 'GET',
    // The base URL handling is TBD — see risk in code audit
  });
}
```

**Risk:** The `/v1.0/myorg/capacities` endpoint is a Power BI REST API endpoint, not a Fabric v1 endpoint. It may require a different base URL (`https://api.powerbi.com` vs `https://api.fabric.microsoft.com`). The dev-server proxy routing needs to handle this. This is flagged as a MEDIUM risk in the P0.1 code audit and must be resolved during P0.2 API verification.

### 10.4 Constructor Implementation Pattern

```javascript
class InfraSetupPage {
  /**
   * @param {object} options
   */
  constructor({ apiClient, existingWorkspaces, onValidationChange, containerEl }) {
    // Store dependencies
    this._apiClient = apiClient;
    this._existingWorkspaces = existingWorkspaces;
    this._onValidationChange = onValidationChange;
    this._containerEl = containerEl;

    // Pre-compute collision set (O(n) once, O(1) lookups)
    this._existingNameSet = new Set(
      existingWorkspaces.map(ws => ws.displayName.toLowerCase())
    );

    // Internal state
    this._data = {
      workspaceName: '',
      capacityId: null,
      capacityDisplay: '',
      lakehouseName: '',
      notebookName: '',
      lakehouseManuallyEdited: false,
      notebookManuallyEdited: false,
      lakehouseEnableSchemas: true,
    };

    this._validationState = {
      fields: {
        workspaceName:  { field: 'workspaceName',  status: 'pristine', errorMessage: null, touched: false },
        capacity:       { field: 'capacity',       status: 'pristine', errorMessage: null, touched: false },
        lakehouseName:  { field: 'lakehouseName',  status: 'pristine', errorMessage: null, touched: false },
        notebookName:   { field: 'notebookName',   status: 'pristine', errorMessage: null, touched: false },
      },
      isFormValid: false,
    };

    this._capacitiesLoaded = false;
    this._capacities = [];
    this._isFirstActivation = true;

    // DOM element references (populated by _render)
    this._els = {};

    // Bound event handler references (for cleanup)
    this._handlers = {};

    // Build DOM
    this._render();
    this._bindEvents();
  }
}
```

### 10.5 Activation Logic

```javascript
activate(wizardState) {
  if (this._isFirstActivation) {
    this._isFirstActivation = false;

    // Generate initial random name
    this._generateRandomName();

    // Load capacities (async — fire-and-forget, loading state shows)
    this._loadCapacities();

    // Focus workspace name after entry animation settles
    setTimeout(() => {
      this._els.wsNameInput.focus();
    }, 100);
  } else if (wizardState) {
    // Returning from a later page — restore state
    this.setData(wizardState);

    // Focus first invalid field, or workspace if all valid
    const firstInvalid = this._findFirstInvalidField();
    if (firstInvalid) {
      this._els[firstInvalid + 'Input']?.focus();
    } else {
      this._els.wsNameInput.focus();
    }
  }
}
```

### 10.6 getData / setData Round-Trip

```javascript
getData() {
  return {
    workspaceName: this._data.workspaceName,
    capacityId: this._data.capacityId,
    capacityDisplay: this._data.capacityDisplay,
    lakehouseName: this._data.lakehouseName,
    notebookName: this._data.notebookName,
    lakehouseManuallyEdited: this._data.lakehouseManuallyEdited,
    notebookManuallyEdited: this._data.notebookManuallyEdited,
    lakehouseEnableSchemas: true,  // ALWAYS true
  };
}

setData(data) {
  if (!data) return;

  // Restore workspace name
  this._els.wsNameInput.value = data.workspaceName || '';
  this._data.workspaceName = data.workspaceName || '';

  // Restore capacity selection
  this._data.capacityId = data.capacityId || null;
  this._data.capacityDisplay = data.capacityDisplay || '';
  if (this._capacitiesLoaded && data.capacityId) {
    this._els.capacitySelect.value = data.capacityId;
  }

  // Restore lakehouse
  this._els.lhNameInput.value = data.lakehouseName || '';
  this._data.lakehouseName = data.lakehouseName || '';
  this._data.lakehouseManuallyEdited = data.lakehouseManuallyEdited || false;

  // Restore notebook
  this._els.nbNameInput.value = data.notebookName || '';
  this._data.notebookName = data.notebookName || '';
  this._data.notebookManuallyEdited = data.notebookManuallyEdited || false;

  // Update auto badges
  this._els.lhAutoBadge.style.display = this._data.lakehouseManuallyEdited ? 'none' : '';
  this._els.nbAutoBadge.style.display = this._data.notebookManuallyEdited ? 'none' : '';

  // Re-validate all fields
  this._validateAllFields();
}
```

### 10.7 Full validate() Method

```javascript
/**
 * Run full-form validation. Called by parent before allowing Next navigation.
 * @returns {boolean} true if ALL fields are valid
 */
validate() {
  // Mark all fields as touched (show errors even for pristine fields)
  for (const key in this._validationState.fields) {
    this._validationState.fields[key].touched = true;
  }

  // Validate each field
  const wsResult = this._validateField('workspaceName');
  const capResult = this._validateField('capacity');
  const lhResult = this._validateField('lakehouseName');
  const nbResult = this._validateField('notebookName');

  const isValid = (
    wsResult.status === 'valid' &&
    capResult.status === 'valid' &&
    lhResult.status === 'valid' &&
    nbResult.status === 'valid'
  );

  // Focus first invalid field
  if (!isValid) {
    const firstInvalid = this._findFirstInvalidField();
    if (firstInvalid) {
      const inputEl = this._els[firstInvalid + 'Input'] ||
                       this._els[firstInvalid + 'Select'];
      inputEl?.focus();
    }
  }

  return isValid;
}

_findFirstInvalidField() {
  const order = ['workspaceName', 'capacity', 'lakehouseName', 'notebookName'];
  for (const field of order) {
    if (this._validationState.fields[field].status === 'invalid') {
      return field;
    }
  }
  return null;
}

_emitValidationChange() {
  const fields = this._validationState.fields;
  const isValid = (
    fields.workspaceName.status === 'valid' &&
    fields.capacity.status === 'valid' &&
    fields.lakehouseName.status === 'valid' &&
    fields.notebookName.status === 'valid'
  );

  if (isValid !== this._validationState.isFormValid) {
    this._validationState.isFormValid = isValid;
    this._onValidationChange(isValid);
  }
}
```

### 10.8 Field UI Update Logic

```javascript
/**
 * Update a single field's visual state (border, icon, hint/error text).
 * @param {string} field - Field identifier
 * @param {FieldValidation} validation - Validation result
 */
_updateFieldUI(field, validation) {
  const inputEl = (field === 'capacity')
    ? this._els.capacitySelect
    : this._els[field + 'Input'];
  const hintEl = this._els[field + 'Hint'];
  const iconEl = this._els[field + 'Icon']; // may be null for workspace (has randomize instead)

  // Only show validation feedback if field has been touched
  if (!validation.touched) return;

  // Remove existing state classes
  inputEl.classList.remove('is-valid', 'is-invalid');

  switch (validation.status) {
    case 'valid':
      inputEl.classList.add('is-valid');

      // Show green checkmark (for fields that have one)
      if (iconEl && iconEl.classList.contains('valid')) {
        iconEl.style.opacity = '1';
      }

      // Restore original hint text
      hintEl.className = 'form-hint';
      hintEl.setAttribute('role', 'status');
      hintEl.innerHTML = this._originalHints[field];
      break;

    case 'invalid':
      inputEl.classList.add('is-invalid');

      // Hide green checkmark
      if (iconEl && iconEl.classList.contains('valid')) {
        iconEl.style.opacity = '0';
      }

      // Replace hint with error message
      hintEl.className = 'form-error';
      hintEl.setAttribute('role', 'alert');
      hintEl.textContent = validation.errorMessage;
      break;

    case 'pristine':
    default:
      // Hide checkmark
      if (iconEl && iconEl.classList.contains('valid')) {
        iconEl.style.opacity = '0';
      }
      // Show original hint
      hintEl.className = 'form-hint';
      hintEl.setAttribute('role', 'status');
      hintEl.innerHTML = this._originalHints[field];
      break;
  }
}
```

### 10.9 Destroy / Cleanup

```javascript
destroy() {
  // Remove all event listeners
  this._unbindEvents();

  // Clear DOM references
  this._els = {};
  this._handlers = {};

  // Clear data references
  this._capacities = [];
  this._existingNameSet = null;
  this._existingWorkspaces = null;

  // Clear DOM
  this._containerEl.innerHTML = '';
}

_unbindEvents() {
  // Remove each listener using stored handler references
  for (const [key, { element, event, handler }] of Object.entries(this._handlers)) {
    element.removeEventListener(event, handler);
  }
}
```

### 10.10 Testing Strategy

| Test Category | Tests | Method |
|---------------|-------|--------|
| **Name generation** | Random name format (adj_noun_NN), uniqueness, collision avoidance, fallback | Unit test `name-generator.js` |
| **Validation rules** | Each of WS-01..WS-09, CAP-01..CAP-02, LH-01..LH-07, NB-01..NB-08 | Unit test `_validateField()` with edge cases |
| **Auto-sync** | Cascade on input, break on manual edit, reset on randomize | Unit test `_cascadeNames()` |
| **Capacity loading** | Success, empty, error, retry, 401 | Integration test with mock API |
| **State round-trip** | `getData()` → `setData()` preserves all fields + flags | Unit test |
| **UI states** | Valid/invalid/pristine field rendering | DOM assertion tests |
| **Keyboard** | Tab order, Enter on randomize, Arrow in dropdown | Integration test |
| **Accessibility** | ARIA attributes, screen reader announcements, focus management | axe-core + manual SR testing |

### 10.11 Edge Cases to Watch

| # | Edge Case | Handling |
|---|-----------|----------|
| 1 | User pastes text with invalid characters | `_onWorkspaceNameInput` strips them instantly |
| 2 | User pastes very long string (10,000 chars) | Truncated to 256 in sanitizer |
| 3 | Workspace name that's valid but produces invalid lakehouse name | Lakehouse validation catches it independently |
| 4 | Capacity list returns 100+ items | Dropdown renders all — native `<select>` handles scrolling |
| 5 | User navigates away during capacity load | `_loadCapacities` completes in background; state correct on return |
| 6 | Bearer token expires between page load and capacity fetch | 401 caught, error state shown with retry |
| 7 | Two workspaces with same name different case | Collision check is case-insensitive (`.toLowerCase()`) |
| 8 | User types underscore as first character | `_onWorkspaceNameInput` allows it through (sanitizer permits `_`); WS-05 catches it on blur |
| 9 | Template specifies capacity that no longer exists | Capacity dropdown shows "Select capacity..." — user must re-select |
| 10 | Empty workspace list injected | Collision check always passes (no existing names to collide with) |
| 11 | All fields valid, then user clears workspace name | Cascade clears lakehouse/notebook; all three become invalid; Next disabled |
| 12 | User focuses and immediately blurs without typing | Field marked as touched, validates current value (empty → error) |
| 13 | Randomize produces a name that collides | `generateUniqueRandomName` retries up to 5 times, then appends timestamp suffix |
| 14 | Browser autofill fires `input` event | `autocomplete="off"` prevents this; but if it happens, sanitizer handles it |
| 15 | User edits lakehouse to exactly match what auto-sync would produce | `lakehouseManuallyEdited` stays `true` (we compare against expected value at time of input, not after re-derive) |

### 10.12 Dependencies & Blockers

| Dependency | Status | Impact |
|-----------|--------|--------|
| `FabricApiClient.listCapacities()` method | ❌ MISSING | Must be implemented before InfraSetupPage can load capacities |
| `WorkspaceExplorer._workspaces` access | ✅ EXISTS | Need to expose via public getter or pass to wizard constructor |
| `infra-wizard.css` styles | ⬜ NOT STARTED | Must be created — use mock CSS as starting point |
| `name-generator.js` module | ⬜ NOT STARTED | New file — extract generator logic |
| InfraWizardDialog (C01) shell | ⬜ NOT STARTED | Parent container must exist to host this page |
| Bearer token available | ✅ EXISTS | `apiClient.hasBearerToken()` check in constructor |

### 10.13 Naming Suffix Convention

The auto-sync suffixes are defined as constants:

```javascript
const LAKEHOUSE_SUFFIX = '_lakehouse';
const NOTEBOOK_SUFFIX = '_notebook';
```

These match the CEO-approved mock which shows `brave_turing_42_lh` and `brave_turing_42_nb` — **HOWEVER**, the mock uses abbreviated suffixes (`_lh`, `_nb`) while the spec says `_lakehouse` and `_notebook`. The spec takes precedence as the source of truth. If the CEO prefers the abbreviated form, update these constants — the auto-sync logic doesn't hardcode the suffix anywhere else.

**Decision needed:** Confirm suffix convention with stakeholders:
- Option A: `_lakehouse` / `_notebook` (spec language, clearer)
- Option B: `_lh` / `_nb` (mock implementation, shorter)

For this spec, we use `_lakehouse` / `_notebook` as the default. The constants make changing this trivial.

### 10.14 Capacity Dropdown — Option Display Format

The capacity dropdown option format encodes four pieces of information:

```
{displayName} — {sku}, {region} ({state})
```

Examples:
```
Dev Capacity — F4, East US (Active)
Prod Capacity — F64, West Europe (Active)
Test Capacity — F2, Southeast Asia (Paused)
My Capacity — F8, North Europe (Provisioning)
```

**State rendering rules:**
| State | Text Color | Selectable? | Notes |
|-------|-----------|-------------|-------|
| `Active` | Default (`var(--text)`) | Yes | Normal |
| `Provisioning` | `var(--text-muted)` | Yes | Fabric allows assignment during provisioning |
| `Paused` | `var(--text-muted)` | Yes | Fabric allows assignment to paused capacity |
| `Deleting` | `var(--text-muted)` | No (disabled) | Cannot assign to a deleting capacity |
| `ProvisionFailed` | `var(--status-fail)` | No (disabled) | Cannot assign to a failed capacity |

### 10.15 DOM Structure — Complete HTML Template

```html
<div class="page-content">
  <!-- ── Workspace Name ── -->
  <div class="form-group" role="group" aria-labelledby="ws-label">
    <label id="ws-label" class="form-label" for="wsName">Workspace Name</label>
    <div class="input-wrapper">
      <input
        class="form-input mono"
        id="wsName"
        type="text"
        spellcheck="false"
        autocomplete="off"
        aria-required="true"
        aria-describedby="ws-hint"
        aria-invalid="false"
      >
      <button
        class="input-icon"
        id="randomizeBtn"
        type="button"
        aria-label="Randomize workspace name"
        title="Randomize name"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M21 2v6h-6"/>
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
          <path d="M3 22v-6h6"/>
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
        </svg>
      </button>
    </div>
    <div id="ws-hint" class="form-hint" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true">●</span> Unique name, underscores allowed
    </div>
  </div>

  <!-- ── Capacity ── -->
  <div class="form-group" role="group" aria-labelledby="cap-label">
    <label id="cap-label" class="form-label" for="capacitySelect">Capacity</label>
    <div class="select-wrapper">
      <select
        class="form-select"
        id="capacitySelect"
        aria-required="true"
        aria-describedby="cap-hint"
        aria-busy="false"
      >
        <option value="" disabled selected>Select capacity...</option>
      </select>
      <span class="select-arrow" aria-hidden="true">▾</span>
    </div>
    <div id="cap-hint" class="coming-soon-link" aria-hidden="true">
      <span>Create New Capacity</span>
      <span class="coming-soon-badge">Coming Soon</span>
    </div>
  </div>

  <!-- ── Lakehouse + Notebook Row ── -->
  <div class="form-row">
    <!-- Lakehouse Name -->
    <div class="form-group" role="group" aria-labelledby="lh-label">
      <label id="lh-label" class="form-label" for="lhName">
        Lakehouse Name
        <span class="auto-badge" id="lhAutoBadge" aria-label="auto-generated">auto</span>
      </label>
      <div class="input-wrapper">
        <input
          class="form-input mono"
          id="lhName"
          type="text"
          spellcheck="false"
          autocomplete="off"
          aria-required="true"
          aria-describedby="lh-hint"
          aria-invalid="false"
        >
        <span class="input-icon valid" id="lhCheckmark" aria-hidden="true" style="opacity:0">✓</span>
      </div>
      <div id="lh-hint" class="form-hint" role="status" aria-live="polite">
        <span class="dot" aria-hidden="true">●</span> Schema-enabled (always)
      </div>
    </div>

    <!-- Notebook Name -->
    <div class="form-group" role="group" aria-labelledby="nb-label">
      <label id="nb-label" class="form-label" for="nbName">
        Notebook Name
        <span class="auto-badge" id="nbAutoBadge" aria-label="auto-generated">auto</span>
      </label>
      <div class="input-wrapper">
        <input
          class="form-input mono"
          id="nbName"
          type="text"
          spellcheck="false"
          autocomplete="off"
          aria-required="true"
          aria-describedby="nb-hint"
          aria-invalid="false"
        >
        <span class="input-icon valid" id="nbCheckmark" aria-hidden="true" style="opacity:0">✓</span>
      </div>
      <div id="nb-hint" class="form-hint" role="status" aria-live="polite">
        <span class="dot" aria-hidden="true">●</span> Auto-generated from workspace
      </div>
    </div>
  </div>

  <!-- ── Screen reader live region (visually hidden) ── -->
  <div class="sr-only" aria-live="assertive" id="srAnnounce"></div>
</div>
```

### 10.16 CSS Additions (beyond mock)

```css
/* Auto-sync badge */
.auto-badge {
  display: inline-block;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 5px;
  border-radius: var(--r-sm);
  background: var(--accent-dim);
  color: var(--accent);
  margin-left: var(--sp-2);
  vertical-align: middle;
  transition: opacity var(--t-normal) var(--ease);
}

/* Retry link for capacity error */
.retry-link {
  display: inline;
  background: none;
  border: none;
  font-size: var(--text-xs);
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
  font-family: var(--font);
}
.retry-link:hover {
  color: var(--text);
}
.retry-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 2px;
}

/* Error state for input */
.form-input.is-invalid {
  border-color: var(--status-fail);
}
.form-input.is-invalid:focus {
  box-shadow: 0 0 0 3px rgba(229, 69, 59, 0.15);
}

/* Valid state for input */
.form-input.is-valid {
  border-color: var(--status-ok);
}
.form-input.is-valid:focus {
  box-shadow: 0 0 0 3px var(--status-ok-glow);
}

/* Error text (replaces hint) */
.form-error {
  font-size: var(--text-xs);
  color: var(--status-fail);
  margin-top: var(--sp-1);
  animation: fadeIn var(--t-normal) var(--ease);
}

/* Screen reader only */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Checkmark fade-in */
.input-icon.valid {
  transition: opacity var(--t-normal) var(--ease);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* Capacity select error state */
.form-select.is-invalid {
  border-color: var(--status-fail);
}

/* Randomize spin animation */
.input-icon.spinning {
  transition: transform 300ms var(--ease);
}
```

### 10.17 Integration with InfraWizardDialog (C01)

The parent dialog creates this page during its own initialization:

```javascript
// In InfraWizardDialog constructor
this._setupPage = new InfraSetupPage({
  apiClient: this._apiClient,
  existingWorkspaces: this._workspaces,
  onValidationChange: (isValid) => {
    this._pageValid[0] = isValid;
    this._updateNextButton();
  },
  containerEl: this._pageContainers[0],
});
```

The parent maintains a `_pageValid` array tracking each page's validation state:
```javascript
this._pageValid = [false, false, false, true, true]; // Pages 1-5
// Pages 4 (Review) and 5 (Execute) are always "valid" — no forms
```

When the user clicks Next on Page 1:
```javascript
_onNextClick() {
  if (this._currentPage === 0) {
    const isValid = this._setupPage.validate(); // Full validation
    if (!isValid) return; // Don't navigate — focus is on first invalid field

    const data = this._setupPage.getData();
    this._wizardState.infra = data; // Save to shared state
    this._goToPage(1); // Navigate to Page 2
  }
}
```

When the user clicks Back to return to Page 1:
```javascript
_onBackClick() {
  if (this._currentPage === 1) {
    this._goToPage(0);
    this._setupPage.activate(this._wizardState.infra); // Restore state
  }
}
```

### 10.18 Open Questions

| # | Question | Impact | Decision Needed By |
|---|----------|--------|-------------------|
| 1 | Suffix convention: `_lakehouse` vs `_lh`? | Display consistency between spec and mock | Before P2 (Architecture) |
| 2 | Should paused capacities show a warning tooltip? | UX clarity for edge case | Before implementation |
| 3 | Should collision check be real-time (on input) or on blur? | Responsiveness vs simplicity | Decision: **on blur** (per Stripe pattern) |
| 4 | Should there be a "Reset to auto" button on manually-edited fields? | Extra affordance vs complexity | Deferred to V2 — randomize serves this purpose |
| 5 | What if `listCapacities()` requires a different API base URL? | Breaks capacity loading entirely | Must resolve in P0.2 (API verification) |

### 10.19 Acceptance Criteria

| # | Criterion | Verifiable By |
|---|-----------|---------------|
| AC-01 | Page renders with Docker-style random name on first activation | Visual + unit test |
| AC-02 | Randomize button generates new name and cascades to synced children | Click test |
| AC-03 | Randomize button rotates 180° on click | Visual test |
| AC-04 | Capacity dropdown loads from API with loading state | Integration test |
| AC-05 | Capacity options show name, SKU, region, and state | Visual test |
| AC-06 | "Create New Capacity" link shows "Coming Soon" badge and is not clickable | Visual test |
| AC-07 | Lakehouse name auto-syncs from workspace name with suffix | Input + cascade test |
| AC-08 | Notebook name auto-syncs from workspace name with suffix | Input + cascade test |
| AC-09 | Manual edit of lakehouse name breaks auto-sync for that field only | Edit + verify no cascade test |
| AC-10 | Manual edit of notebook name breaks auto-sync for that field only | Edit + verify no cascade test |
| AC-11 | Randomize resets manual edit flags and re-syncs all children | Randomize after manual edit test |
| AC-12 | "auto" pill badge visible on synced fields, hidden on manually-edited fields | Visual test |
| AC-13 | Workspace name validation: required, format, collision, reserved words | Unit test suite |
| AC-14 | Lakehouse name validation: required, format, must start with letter | Unit test suite |
| AC-15 | Notebook name validation: required, format, spaces allowed | Unit test suite |
| AC-16 | Capacity validation: required selection | Unit test |
| AC-17 | Invalid fields show red border and inline error message | Visual test |
| AC-18 | Valid fields show green checkmark in trailing icon slot | Visual test |
| AC-19 | Form validity emitted to parent via `onValidationChange` callback | Integration test |
| AC-20 | Next button disabled when form is invalid | Integration with C01 |
| AC-21 | Tab order: workspace → randomize → capacity → lakehouse → notebook | Keyboard test |
| AC-22 | ARIA attributes present and correct for all fields | axe-core audit |
| AC-23 | Screen reader announcements for randomize, validation, capacity load | Manual SR test |
| AC-24 | `getData()` → `setData()` round-trip preserves all fields + flags | Unit test |
| AC-25 | Capacity load failure shows error state with retry link | Error simulation test |
| AC-26 | Capacity retry link re-fetches and recovers | Retry test |
| AC-27 | Capacity empty state shows "No capacities available" message | Empty API response test |
| AC-28 | Entry animation: staggered slide-up for form groups | Visual test |
| AC-29 | `enableSchemas: true` always present in `getData()` output | Unit test |
| AC-30 | Invalid characters stripped from workspace name in real-time | Input test with special chars |

---

## Appendix A: Region Display Name Mapping

Complete mapping from Azure region identifiers to human-readable display names, used in capacity dropdown option text:

| API Region ID | Display Name |
|---------------|-------------|
| `eastus` | East US |
| `eastus2` | East US 2 |
| `westus` | West US |
| `westus2` | West US 2 |
| `westus3` | West US 3 |
| `centralus` | Central US |
| `northcentralus` | North Central US |
| `southcentralus` | South Central US |
| `westcentralus` | West Central US |
| `northeurope` | North Europe |
| `westeurope` | West Europe |
| `uksouth` | UK South |
| `ukwest` | UK West |
| `eastasia` | East Asia |
| `southeastasia` | Southeast Asia |
| `japaneast` | Japan East |
| `japanwest` | Japan West |
| `australiaeast` | Australia East |
| `australiasoutheast` | Australia Southeast |
| `canadacentral` | Canada Central |
| `canadaeast` | Canada East |
| `brazilsouth` | Brazil South |
| `koreacentral` | Korea Central |
| `koreasouth` | Korea South |
| `francecentral` | France Central |
| `francesouth` | France South |
| `southafricanorth` | South Africa North |
| `southafricawest` | South Africa West |
| `uaenorth` | UAE North |
| `uaecentral` | UAE Central |
| `switzerlandnorth` | Switzerland North |
| `switzerlandwest` | Switzerland West |
| `germanywestcentral` | Germany West Central |
| `norwayeast` | Norway East |
| `norwaywest` | Norway West |
| `swedencentral` | Sweden Central |
| `qatarcentral` | Qatar Central |
| `polandcentral` | Poland Central |
| `italynorth` | Italy North |
| `israelcentral` | Israel Central |

**Fallback:** If the API returns a region ID not in this map, display the raw ID string. Do not throw or hide the capacity.

---

## Appendix B: Validation Rule Quick Reference

| Field | Required | Min Len | Max Len | Format Regex | Start Char | Extra |
|-------|----------|---------|---------|-------------|-----------|-------|
| Workspace | Yes | 3 | 256 | `/^[a-zA-Z0-9_]+$/` | Letter or number | No collision, no reserved |
| Capacity | Yes | — | — | — | — | Must be selected from API list |
| Lakehouse | Yes | 3 | 256 | `/^[a-zA-Z][a-zA-Z0-9_]*$/` | Letter only | No `__`, no trailing `_` |
| Notebook | Yes | 3 | 256 | `/^[a-zA-Z][a-zA-Z0-9_ ]*$/` | Letter only | Spaces allowed, no `__`/`  `, no trailing `_`/` ` |

---

## Appendix C: Glossary

| Term | Definition |
|------|-----------|
| **Auto-sync** | Mechanism where lakehouse/notebook names are automatically derived from workspace name until manually edited |
| **Cascade** | The propagation of workspace name changes to auto-synced child fields |
| **Collision** | A workspace name that already exists in the user's Fabric tenant |
| **Docker-style name** | Random name in `adjective_noun_number` format, inspired by Docker's container naming convention |
| **Manual override** | When a user edits an auto-synced field, breaking the sync link |
| **Pristine** | A field that has not been focused or edited by the user |
| **Touched** | A field that has received focus at least once (blur has fired) |
| **Sync-break** | The event of a user manually editing an auto-synced field, causing it to stop tracking workspace name changes |

---

*End of C02 — InfraSetupPage Component Deep Spec*
