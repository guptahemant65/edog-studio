# C05 — Auth Mode: Component Deep Spec

> **Component:** AuthModeCard (Environment Panel Card 5)  
> **Feature:** F11 — Environment Panel  
> **Owner:** Sana (architecture) + Vex (Python API) + Pixel (card rendering)  
> **Complexity:** MEDIUM  
> **Depends On:** P0 foundation research §5, Silent CBA token injection, DisableFLTAuth patching, Card 3 restart affordance  
> **Status:** P1 — DRAFT

---

## 1. Overview

AuthModeCard is the Environment Panel's explicit truth surface for FLT DevMode authentication. P0 names Card 5 as **Auth Mode & Overrides** and scopes the card to `DisableFLTAuth`, environment overrides, file:line evidence, and removal of the speculative appsettings-diff row (`docs/specs/features/F11-environment-panel/research/p0-foundation.md:62-70`). The card answers one operational question: "what authentication path will FLT use after the next start, and is EDOG overriding that path?"

The card has three effective modes. **Silent CBA** is the preferred zero-popup path: EDOG obtains a DevMode bearer token and writes it into `workload-dev-mode.json` as `UserAuthorizationToken`, which makes DevConnection skip the browser popup (`scripts/dev-server.py:1375-1383`, `scripts/dev-server.py:1452-1469`). **DevConnection** is the interactive fallback: FLT starts normally, the DevConnection browser/account picker appears, and EDOG may attempt account picker automation if token injection fails (`scripts/dev-server.py:1296-1372`, `scripts/dev-server.py:1718-1721`). **Disabled** is the patch override: `DisableFLTAuth` is set in FLT rollout/config files so requests bypass FLT auth entirely; P0 says both `ParametersManifest.json` and `Test.json` must be parsed and shown separately (`p0-foundation.md:66-68`).

This component is disconnected-safe. P0 explicitly states that Card 5 has full data pre-deploy because it is based on file parsing of `ParametersManifest` and `Test.json` (`p0-foundation.md:314-322`). Therefore the card must render the configured/effective mode even when FLT is not running, DevConnection has not started, and no MWC token exists. Connected mode only adds confidence that the running process has consumed the setting; it is not required to know what is configured on disk.

---

## 2. Data Model

The backend returns one card-owned projection:

```typescript
interface AuthMode {
  mode: 'silent-cba' | 'devconnection' | 'disabled';
  source: 'config' | 'patch' | 'env';
  restartRequired: boolean;
  lastChangedAt?: number;
}
```

`mode` is the effective auth path after resolving overrides. `disabled` wins whenever either `DisableFLTAuth` file parse reports enabled, because P0 makes those two file-backed rows the primary Card 5 facts (`p0-foundation.md:66-68`) and `edog.py check_status()` already detects the same marker string in both files (`edog.py:2761-2773`). `silent-cba` means EDOG is configured to pre-populate DevMode token state through `_inject_devmode_token()`; `devconnection` means EDOG should not inject the token and FLT should follow its normal InteractiveBrowserCredential/DevConnection picker path (`scripts/dev-server.py:1375-1383`, `scripts/dev-server.py:1694-1721`).

`source` explains why the card reached that mode. Use `patch` when `DisableFLTAuth` is present in `ParametersManifest.json` or `Test.json`, because P0 calls those file rows not-yet-exposed patch/config drift that must be lifted into `/api/edog/auth-mode` (`p0-foundation.md:66-67`). Use `env` when an `EDOG_*` environment variable explicitly selects or suppresses a mode; P0 requires an `os.environ` scan for `EDOG_*` overrides (`p0-foundation.md:69`). Use `config` for the normal desired mode stored in EDOG configuration or inferred from DevMode token injection policy.

The implementation should return additional display metadata beside the required `AuthMode` object, not inside it: file rows for each `DisableFLTAuth` occurrence, an `envOverrides` list, and a `patchOverrideActive` boolean. That preserves the required compact model while matching the mock's `kv-table` rows for `DisableFLTAuth`, file reference, and env overrides (`docs/specs/features/F11-environment-panel/mocks/environment-shell.html:1131-1155`). `restartRequired` is true after any POST that changes mode until FLT is restarted through the shared deploy/restart flow.

---

## 3. API Surface

### 3.1 `GET /api/edog/auth-mode` — NEW

Returns the effective auth mode and supporting evidence. P0 says `DisableFLTAuth (ParametersManifest.json)` and `DisableFLTAuth (Test.json)` are not yet exposed, and recommends lifting the existing `edog.py verify` logic into `/api/edog/auth-mode` (`p0-foundation.md:66-67`). The endpoint belongs in `scripts/dev-server.py`, alongside existing EDOG endpoints such as `/api/edog/health` and `/api/edog/patch-warnings` (`scripts/dev-server.py:1882-1894`).

Example response:

```json
{
  "authMode": {
    "mode": "disabled",
    "source": "patch",
    "restartRequired": false,
    "lastChangedAt": 1784213320123
  },
  "naturalMode": "silent-cba",
  "patchOverrideActive": true,
  "files": [
    { "name": "ParametersManifest.json", "disableFLTAuth": true, "line": 42 },
    { "name": "Test.json", "disableFLTAuth": true, "line": 14 }
  ],
  "envOverrides": ["EDOG_STUDIO_PORT=5555"]
}
```

File parsing must return file:line references because P0 marks that as trivial required evidence (`p0-foundation.md:68`), and the mock already renders `Test.json:14` beside the `DisableFLTAuth` pill (`environment-shell.html:1141-1145`). The endpoint must not read or diff appsettings because P0 explicitly recommends dropping that row for V1.1 (`p0-foundation.md:70`).

### 3.2 `POST /api/edog/auth-mode { mode }` — NEW

Accepts `{ "mode": "silent-cba" | "devconnection" | "disabled" }` and returns the same payload as GET plus restart guidance. The POST does not mutate a running FLT process. It changes the next-start inputs, sets `restartRequired: true`, and lets the user restart FLT through the shared Card 3 restart action. C03 already defines cached-startup changes as `Restart FLT to apply` using a redeploy/reconnect flow (`docs/specs/features/F11-environment-panel/components/C03-feature-flags.md:218-224`).

For `disabled`, the endpoint applies the existing DisableFLTAuth patch operations: manifest replacement changes `"DisableFLTAuth": false` to `true`, and Test.json insertion adds `"DisableFLTAuth": true` near the parameters tail (`edog.py:2040-2084`). For `silent-cba`, it clears DisableFLTAuth from both files and enables the existing `_inject_devmode_token()` launch path, which acquires the right DevMode audience and writes `UserAuthorizationToken` before FLT starts (`scripts/dev-server.py:1375-1469`, `scripts/dev-server.py:1694-1696`). For `devconnection`, it clears DisableFLTAuth and suppresses EDOG token injection so the normal browser/picker path can run; EDOG's fallback picker automation is already present when injection fails (`scripts/dev-server.py:1296-1372`, `scripts/dev-server.py:1718-1721`).

---

## 4. State Machine

```text
loading
  -> current-mode-displayed

current-mode-displayed
  -- select different mode --> switching

switching
  -> pending-restart
  -> current-mode-displayed (error rollback)

pending-restart
  -- restart succeeds --> restart-applied
  -- restart fails --> pending-restart

restart-applied
  -> loading
```

`loading` begins when the Environment Panel opens, when Card 5 is expanded, after a POST completes, and after FLT deploy/restart finishes. `current-mode-displayed` always has enough data to render because P0 states Card 5 is fully available pre-deploy from local file parsing (`p0-foundation.md:314-322`). If files are missing because the FLT repo is not configured, the card displays an error state rather than pretending DevConnection is active.

`switching` disables the radio group and sends the POST. On success, `pending-restart` shows the selected mode, the previous running mode if known, and an amber restart prompt. On restart success, `restart-applied` immediately re-fetches GET and clears the pending warning only when disk evidence and desired mode agree. If restart fails, the selected mode remains pending because the files/config may already have changed; rolling it back automatically would be clever in the way distributed systems outages are "interesting."

---

## 5. Scenarios

| ID | Scenario | Mechanism | Source | Edge / Undo | Priority |
|---|---|---|---|---|---|
| C05-S01 | Default Silent CBA. User sees `Silent CBA` with `zero-popup` copy and no patch override. | `GET /api/edog/auth-mode`; no DisableFLTAuth markers; config policy allows `_inject_devmode_token()`. | P0 requires Card 5 auth facts (`p0-foundation.md:62-70`); Silent CBA injection path (`scripts/dev-server.py:1375-1469`). | If token-helper/cert is missing, deploy falls back to DevConnection picker and card should surface last launch warning. | P0 |
| C05-S02 | Switch to Disabled for testing. User selects `Disabled`, sees security warning, confirms, then gets restart required. | POST applies DisableFLTAuth to manifest/Test rollout. | P0 names both DisableFLTAuth files (`p0-foundation.md:66-67`); patch functions exist (`edog.py:2040-2084`). | Undo by selecting Silent CBA or DevConnection; restart still required. | P0 |
| C05-S03 | Switch to DevConnection for picker testing. User selects `DevConnection`, EDOG clears DisableFLTAuth and suppresses token injection. | POST writes config/env policy for next deploy and clears patch override. | DevConnection readiness and picker automation (`scripts/dev-server.py:1271-1291`, `scripts/dev-server.py:1296-1372`). | If picker automation cannot find the account, user selects manually. | P1 |
| C05-S04 | Restart pending warning. Disk/config changed but FLT has not restarted. | `restartRequired: true`; show shared restart button. | Card 3 restart pattern (`C03-feature-flags.md:218-224`); mock button (`environment-shell.html:1599-1610`). | Closing panel must not clear pending state; GET recomputes it. | P0 |
| C05-S05 | Disconnected mode. FLT is not running, but configured mode still renders. | Read local files and env/config only. | P0 disconnected contract says Card 5 has all data pre-deploy (`p0-foundation.md:314-322`). | Hide running-mode claims; show `will apply on next FLT start`. | P0 |

---

## 6. Visual Spec

Follow Card 5 from the mock: `.env-card[data-card="auth"]`, title `Auth Mode & Overrides`, a right-side badge, and a compact `kv-table` body (`environment-shell.html:1131-1155`). Replace the mock's single `DisableFLTAuth` row with a three-option mode selector at the top, then keep evidence rows below it. The badge shows `Silent CBA`, `DevConnection`, or `DisableAuth`, with warning severity only for `disabled` or pending restart.

Recommended layout:

1. **Mode selector** — radio cards or segmented radio group: `Silent CBA`, `DevConnection`, `Disabled`.
2. **Mode explanation** — one sentence under the selected mode: zero-popup token injection, popup picker, or auth bypass.
3. **Patch override indicator** — visible only when `patchOverrideActive`; label `Patch override active` and list which files set DisableFLTAuth.
4. **Evidence rows** — `ParametersManifest.json`, `Test.json`, and `env overrides`, each with value pill and file:line or env key.
5. **Restart row** — hidden when `restartRequired === false`; otherwise amber text plus `Restart FLT to apply`.

Security copy must be blunt. `Disabled` says: "Bypasses FLT auth for DevMode only. Do not use for auth behavior validation." `Silent CBA` says: "Uses certificate-backed token injection; no browser popup." `DevConnection` says: "Uses FLT's normal picker path; useful for validating interactive auth." The appsettings diff row is intentionally absent, because P0 says no baseline exists and recommends dropping it (`p0-foundation.md:70`).

---

## 7. Keyboard & Accessibility

The mode selector is a real radio group: container `role="radiogroup"`, each option `role="radio"`, roving `tabindex`, ArrowLeft/ArrowRight or ArrowUp/ArrowDown to move, Space/Enter to select. The accessible name for each option includes both mode and consequence: "Silent CBA, zero-popup token injection", "DevConnection, browser account picker", and "Disabled, bypasses FLT auth after restart." Color never carries the security meaning alone; the text `Patch override active` and `Restart required` must be visible.

Changing modes opens a confirmation prompt only for `disabled` and for any change while FLT is running. That prompt is focus-trapped, starts focus on Cancel, supports Escape, and returns focus to the selected radio after close. The restart prompt is also keyboard reachable and uses the same button semantics as Card 3's cached-flag restart affordance (`C03-feature-flags.md:224`, `environment-shell.html:1697-1705`).

---

## 8. Error Handling

If mode switching fails, leave the previous `AuthMode` rendered, show an inline error under the selector, and re-enable controls. Partial patch writes are possible because `ParametersManifest.json` and `Test.json` are separate files; after any POST failure, immediately re-run GET so the card shows the actual disk state. P0 requires both files to be shown separately (`p0-foundation.md:66-68`), so a split state is not a generic error. It is evidence.

If restart fails, keep `pending-restart` and attach the restart failure message. Do not clear `restartRequired` until the next GET proves the running/deployed phase consumed the new setting. If FLT is not running, the card must not fail; it shows the configured mode and labels the state as `will apply on next FLT start`, consistent with P0's disconnected contract for Card 5 (`p0-foundation.md:314-322`).

If Silent CBA preparation fails during deploy, show the last deploy warning and effective fallback as `DevConnection` only after evidence exists. `_inject_devmode_token()` returns false for missing config, missing `workload-dev-mode.json`, missing audience, missing cert, missing token-helper, timeout, or acquisition error, and the launch path then starts account picker automation (`scripts/dev-server.py:1384-1450`, `scripts/dev-server.py:1471-1476`, `scripts/dev-server.py:1718-1721`).

---

## 9. Performance

No performance concerns. This is a single-row card with two small JSON files, one environment-variable scan, and one compact config read. P0's own data-source map classifies the missing pieces as regex/file parsing and one-line env scan (`p0-foundation.md:66-69`). There is no FLT RPC, SignalR subscription, Fabric API call, or large catalog payload.

The endpoint can compute on demand whenever the panel opens. If the panel later adds polling, use the Environment Panel's existing refresh cadence and skip polling while collapsed. The only expensive operation is token acquisition, and that belongs to deploy/restart preparation through `_inject_devmode_token()`, not to GET (`scripts/dev-server.py:1375-1469`).

---

## 10. Implementation Notes

Reuse the existing Silent CBA machinery. ADR-007 records Silent CBA as the accepted token-acquisition path: zero browser, zero dialog, roughly 5-7 seconds fresh and around 30ms cached (`docs/adr/ADR-007-playwright-token-auth.md:22-35`, `docs/adr/ADR-007-playwright-token-auth.md:51-55`). The dev server already calls `_inject_devmode_token(config)` immediately before `dotnet run --no-build`, and falls back to account picker automation when injection returns false (`scripts/dev-server.py:1694-1721`). C05 should expose and control that path, not reimplement token auth.

Add one backend helper that computes `AuthMode` from three inputs: DisableFLTAuth file markers, EDOG environment overrides, and EDOG desired config. Add one patch toggle for DisableFLTAuth using the existing manifest/Test.json apply/revert functions (`edog.py:2040-2091`, `edog.py:2560-2573`). The helper should return line numbers during parsing because P0 requires file:line references (`p0-foundation.md:68`) and the mock already shows that shape (`environment-shell.html:1141-1145`).

The restart trigger must share Card 3's cached-flag restart interaction, not invent a second restart language. C03 defines restart-required changes as a deploy/reconnect operation with replay after reconnect (`C03-feature-flags.md:224`), and the mock already has the amber inline `Restart FLT to apply` button styling and behavior (`environment-shell.html:695-706`, `environment-shell.html:1599-1610`, `environment-shell.html:1697-1705`). One restart affordance, one mental model. Anything else is how panels become control planes with opinions and no accountability.
