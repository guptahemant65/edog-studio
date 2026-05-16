# C01 — Config Snapshot: Component Deep Spec

> **Component:** Config Snapshot (Card 1, Environment Panel)  
> **Feature:** F11 — Environment Panel  
> **Owner:** Sana (architecture + FLT contract), Vex (Python endpoint), Pixel (JS/CSS implementation)  
> **Complexity:** MEDIUM  
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

Config Snapshot is the first Environment Panel card. Its job is deliberately boring and therefore important: show the exact workspace, lakehouse, and capacity identity EDOG Studio is currently pointed at. This is the card a developer reads before trusting any downstream signal. If the workspace ID is wrong, every token state, feature flag, build hint, and auth conclusion becomes beautifully rendered misinformation. We are not doing that.

P0 grounds the card in existing configuration: `workspace_id`, `artifact_id`, and `capacity_id` are already read from `edog-config.json` and exposed through `GET /api/flt/config` as `workspaceId`, `artifactId`, and `capacityId` (`docs/specs/features/F11-environment-panel/research/p0-foundation.md:14-16`). In current code, the physical workload config file is `edog-config.json`: `CONFIG_PATH = PROJECT_DIR / "edog-config.json"` (`scripts/dev-server.py:44`). The user-facing phrase "workload config" should map to this existing file; do not introduce a second `workload-config.json` shadow source.

The component lives as Card 1 in the locked v3 shell. The mock labels it `Config Snapshot`, gives it a running badge, and renders rows for workspace, lakehouse, and capacity with friendly names above raw GUIDs (`docs/specs/features/F11-environment-panel/mocks/environment-shell.html:902-934`). C01 owns those identity rows and the copy affordances attached to them. The same mock also shows FLT port, branch/SHA, and deploy time (`environment-shell.html:935-948`); those can remain card-level enrichments, but this C01 contract is scoped to workspace/lakehouse/capacity identity because that is the durable pre-deploy truth P0 calls out.

---

## 2. Data Model

C01 normalizes backend config into one immutable snapshot object per render. IDs are always strings; display names may be missing during first-run or after a dev-server restart until persistence is fixed. Region is optional for workspace because P0 does not identify a current workspace-region source in Card 1. Capacity SKU is required for the display contract, but it is a P1 persistence gap: P0 lists `capacity_name` as collected/not exposed (`p0-foundation.md:19`) and current frontend wizard state already carries `capacitySku` and `capacityRegion` (`src/frontend/js/infra-wizard.js:114-120`, `src/frontend/js/infra-wizard.js:1157-1158`).

```typescript
interface ConfigSnapshot {
  workspace: {
    id: string;
    name: string | null;
    region?: string | null;
  };
  lakehouse: {
    id: string;
    name: string | null;
  };
  capacity: {
    id: string;
    name: string | null;
    sku: string | null;
  };
  source: {
    file: 'edog-config.json';
    loadedAt: string;      // ISO timestamp when browser normalized the payload
    stale: boolean;        // true when names came from volatile deployTarget only
  };
}
```

The backend payload should stay backwards-compatible with the existing fields. Add display fields beside the IDs instead of replacing them:

```typescript
interface FltConfigResponseV2 {
  workspaceId: string;
  workspaceName?: string;
  workspaceRegion?: string;
  artifactId: string;
  lakehouseName?: string;
  capacityId: string;
  capacityName?: string;
  capacitySku?: string;
  fltPort?: number | null;
  studioPhase: 'idle' | 'deploying' | 'running' | 'crashed' | string;
}
```

The source-of-truth hierarchy is: persisted config first, volatile deploy target second, blank display labels last. Today deploy writes only the three IDs into `edog-config.json` (`scripts/dev-server.py:1551-1560`). The deploy request body accepts `workspaceName` and `lakehouseName` (`scripts/dev-server.py:2491-2495`), and `_studio_state.deployTarget` stores those names next to the IDs (`scripts/dev-server.py:2563-2569`). P0 correctly marks those names as "collected, not exposed" and volatile after dev-server restart (`p0-foundation.md:17-19`). C01 requires Vex to close that gap by persisting `workspace_name`, `lakehouse_name`, `capacity_name`, and `capacity_sku` into `edog-config.json` on successful deploy or wizard creation.

---

## 3. API Surface

No new endpoint is needed. Use the existing `GET /api/flt/config`, which is already routed in `do_GET` (`scripts/dev-server.py:1882-1884`) and already reads `CONFIG_PATH` before returning JSON (`scripts/dev-server.py:2030-2032`). The current response includes `workspaceId`, `artifactId`, `capacityId`, `fltPort`, and `studioPhase` (`scripts/dev-server.py:2043-2055`). Extend that response with the friendly-name and SKU fields above.

This choice matters. A separate `/api/environment/config-snapshot` endpoint would make the UI cleaner for exactly one card, then create a second contract that must be kept in sync with `/api/flt/config`. The whole point of this card is to reveal EDOG's active FLT config, so it should consume the same endpoint FLT-related browser code already trusts. If backend needs a helper, keep it private: `_load_config_snapshot()` can normalize file keys and volatile fallback, but the public HTTP surface remains `/api/flt/config`.

If C01 later displays the mock's secondary diagnostics, it may also read `GET /api/edog/health` for branch and repo state. That endpoint already returns `gitBranch` and dirty counts (`scripts/dev-server.py:3483-3495`), while P0 notes SHA is not collected yet (`p0-foundation.md:21-23`). Those diagnostics are not acceptance blockers for the identity snapshot.

---

## 4. State Machine

```text
loading
  ├─ success + required IDs present ──> loaded.complete
  ├─ success + some IDs missing ──────> loaded.partial
  └─ network/parse failure ───────────> error

loaded.complete / loaded.partial
  ├─ refresh tick or panel reopen ────> loading
  └─ copy action ─────────────────────> same state + toast
```

`loading` begins when the Environment Panel opens or when its refresh loop invalidates cached panel data. During loading, Card 1 renders the shell immediately, with three skeleton identity rows. It must not block the rest of the panel; P0's panel thesis is a data-source map per card, not a global all-or-nothing load (`p0-foundation.md:8-24`).

`loaded.complete` means all three IDs exist and at least one human-readable label exists for each row. `loaded.partial` means the IDs are present but one or more names/SKU values are missing; the row still renders the GUID and shows `Unknown workspace`, `Unknown lakehouse`, or `Unknown capacity` as the friendly label. `error` means EDOG could not read or parse the config response at all. In disconnected mode the state should still be `loaded.complete` or `loaded.partial` if config exists: P0 explicitly says Card 1 shows workspace/capacity/artifact pre-deploy from `edog-config.json`, with only FLT port absent (`p0-foundation.md:316-319`).

Connected vs disconnected changes the badge and secondary fields, not the identity contract. The current backend computes `phase: "connected" if mwc_available else "disconnected"` and returns `studioPhase` (`scripts/dev-server.py:2052-2054`). C01 should not hide identity rows just because FLT is not running. That would repeat the mock's over-aggressive disconnected behavior that P0 says must be refined (`p0-foundation.md:314-324`).

---

## 5. Scenarios

| ID | Scenario | Mechanism | Priority |
|---|---|---|---|
| C01-S1 | Happy path | `/api/flt/config` returns all IDs plus names/SKU. Render three clickable rows and allow JSON copy. | P0 |
| C01-S2 | Missing config file | Endpoint returns blank IDs or backend returns a structured config error. Render empty state with setup guidance. | P0 |
| C01-S3 | Partial config | One or two IDs exist. Render known rows, mark missing rows as `Not configured`, disable copy for empty values. | P0 |
| C01-S4 | Name resolution failure | IDs exist but names/SKU are missing. Render GUIDs with `Unknown ...` friendly labels and do not fail the card. | P1 |

**C01-S1 — happy path.** The deploy pipeline writes `workspace_id`, `artifact_id`, and `capacity_id` to `edog-config.json` (`scripts/dev-server.py:1555-1559`), and `/api/flt/config` exposes them as camelCase fields (`scripts/dev-server.py:2043-2046`). Pixel renders labels in the mock order: workspace, lakehouse, capacity (`environment-shell.html:911-934`). Copying a row writes only the raw GUID, not the friendly label.

**C01-S2 — missing config.** If `CONFIG_PATH` does not exist, `_serve_config()` currently starts with `{}` and returns empty strings for the IDs (`scripts/dev-server.py:2030-2046`). C01 should treat all-empty IDs as a configuration absence, not as a successful empty environment. The row area becomes a compact empty state: `No workload config found` plus a hint to select or create a workspace from the existing flow. No deploy action belongs in this card.

**C01-S3 — partial config.** Partial state is valid because EDOG can be between first-run, wizard creation, and deploy. C01 must show whatever is known. For example, a workspace and capacity without a lakehouse renders two copyable rows and one disabled `lakehouse — Not configured` row. This matches the Phase 1 SOP requirement that each scenario specify edge cases and implementation paths (`hivemind/FEATURE_DEV_SOP.md:45-60`).

**C01-S4 — name resolution failure.** This is expected until backend persists names. P0 says `lakehouse_name`, `workspace_name`, and `capacity_name` are collected but not currently exposed (`p0-foundation.md:17-19`). The frontend must not invent names from GUID fragments except as a last-resort visual abbreviation. The failure is visible but non-fatal: identity remains trustworthy because the GUID remains the copy source.

---

## 6. Visual Spec

The visual pattern is already locked by the v3 shell. Card 1 uses `.env-card`, a clickable `.card-header`, a chevron, title, and status badge (`environment-shell.html:902-908`). Inside the card, rows live in `.kv-table` and follow the same three-column structure: label, value, copy action (`environment-shell.html:910-934`). C01 should preserve this exact spatial grammar.

Each identity row renders friendly name first, raw GUID second. The CSS already defines `.friendly-name` as normal UI font, semibold, block layout, and `.guid-sub` as monospace muted subtext (`environment-shell.html:335-341`). This is not decoration; it is the information hierarchy. Humans scan names, machines and support threads need GUIDs. Put the name above the GUID every time.

Rows are clickable in two places: the value area and the copy button. Hovering the value area shows the full GUID in a native `title` tooltip and may also apply a subtle hover background if Pixel chooses. The copy button uses the existing copy glyph and transition behavior (`environment-shell.html:349-359`). Add one card-level action in the header or table footer: `Copy all as JSON`. Its clipboard payload is the normalized `ConfigSnapshot`, pretty-printed with two spaces, so support can paste it directly into an incident or PR thread.

---

## 7. Keyboard & Accessibility

Tab order is card header, workspace row, workspace copy button, lakehouse row, lakehouse copy button, capacity row, capacity copy button, then `Copy all as JSON`. If the row itself is clickable, it must be focusable with `tabindex="0"` and behave like a button: Enter and Space copy the row GUID. The separate copy button remains for pointer users and screen-reader discoverability.

Use explicit accessible names. Examples: `aria-label="Copy workspace ID ws-..."`, `aria-label="Copy lakehouse ID ..."`, and `aria-label="Copy environment config snapshot as JSON"`. The visible row label alone is insufficient because the action is copy, not navigation. After copy, announce success through the existing toast region or an `aria-live="polite"` status node: `Workspace ID copied`.

The card must not rely on color alone. Missing values use text (`Not configured`) and disabled copy controls, not merely muted color. Partial snapshot warnings should use a small textual hint under the affected friendly label. Unicode symbols are allowed by the EDOG UI rules, but this component does not need extra glyphs beyond the existing copy icon. Restraint: the underrated architecture pattern.

---

## 8. Error Handling

| Failure | Detection | UI response | Backend note |
|---|---|---|---|
| Config file missing | All three IDs empty, or explicit `config_missing` error | Empty state, no copy controls | Current code returns empty strings when file is absent (`scripts/dev-server.py:2030-2046`). |
| JSON parse fail | `/api/flt/config` returns non-2xx or malformed JSON | Error state with retry | Backend should catch `json.JSONDecodeError` and return structured error. |
| Name lookup fail | ID present, name/SKU absent | Render GUID with `Unknown ...`; copy stays enabled | P0 says names are collected/not exposed today (`p0-foundation.md:17-19`). |
| Clipboard denied | `navigator.clipboard.writeText` rejects | Toast: `Copy failed; select value manually` | No backend action. |

The error philosophy is simple: never conceal a valid GUID because a friendly label is missing. GUIDs are the authority. Friendly labels are usability. If config parsing fails entirely, the card cannot assert identity and must enter `error`; if name resolution fails, it enters `loaded.partial`.

For JSON parse failures, Vex should tighten `_serve_config()`. It currently calls `json.loads(CONFIG_PATH.read_text())` without local parse handling in `_serve_config()` (`scripts/dev-server.py:2030-2032`). Other handlers already use defensive config reads with fallback (`scripts/dev-server.py:3525-3531`); C01 should not require the browser to interpret a dropped connection as a config syntax problem.

---

## 9. Performance

C01 is cheap. It renders three primary rows and one optional JSON action. Fetch cost is one local dev-server request; render cost is constant. Cache the normalized snapshot in the Environment Panel controller and refresh it only when the panel opens, when `/api/flt/config` polling already runs, or after deploy completes. Do not poll this card independently.

Debounce refreshes triggered by deploy/status events to one render per animation frame. The deploy flow can update status frequently, but identity changes only at deploy target boundaries. If `/api/flt/config` returns the same IDs and names as the previous snapshot, skip DOM replacement and only update badge/secondary diagnostics elsewhere.

Clipboard actions are user-initiated and should not mutate component state beyond a transient `copied` class or toast. The `Copy all as JSON` payload is tiny; generate it on click from the cached snapshot, not during every render. No virtual DOM, no framework, no heroics. Vanilla JS is the settled EDOG architecture (ADR-002 in the agent prompt, `hivemind/agents/prompts.py:388-393`).

---

## 10. Implementation Notes

Pixel should implement C01 in `src/frontend/js/environment-panel.js` if that module already owns the F11 panel shell. If the file is not yet split, use a small extracted helper such as `src/frontend/js/environment-config-card.js` only when it reduces coupling; do not create a component framework. The component API can be plain JS:

```typescript
class ConfigSnapshotCard {
  constructor(root: HTMLElement, apiClient: ApiClient, toast: ToastBus);
  load(): Promise<void>;
  render(snapshot: ConfigSnapshot): void;
  copyField(kind: 'workspace' | 'lakehouse' | 'capacity'): Promise<void>;
  copyAll(): Promise<void>;
}
```

Vex owns the backend compatibility change. Extend deploy/config persistence so successful deploys store display metadata in `edog-config.json` beside the existing snake_case IDs. Current `DeployFlow.startDeploy()` sends `workspaceName` and `lakehouseName` but not capacity display metadata (`src/frontend/js/deploy-flow.js:37-50`), and workspace deploy target similarly stores only workspace/lakehouse names (`src/frontend/js/workspace-explorer.js:2405-2407`). Add `capacityName` and `capacitySku` to those paths where available. For wizard-created infra, the state already records `capacityDisplayName`, `capacitySku`, and `capacityRegion` (`src/frontend/js/infra-wizard.js:114-120`).

Recommended persisted keys:

```json
{
  "workspace_id": "...",
  "workspace_name": "My Workspace",
  "workspace_region": "eastus",
  "artifact_id": "...",
  "lakehouse_name": "Sales LH",
  "capacity_id": "...",
  "capacity_name": "EastUS-F64",
  "capacity_sku": "F64"
}
```

This is an additive schema change. Existing consumers keep reading `workspace_id`, `artifact_id`, and `capacity_id`; C01 gains names and SKU without breaking disconnected mode. That is the right boundary: EDOG's config file remains the durable source, `/api/flt/config` remains the single HTTP projection, and the browser remains a renderer with copy affordances. Clean organs, no scar tissue.
