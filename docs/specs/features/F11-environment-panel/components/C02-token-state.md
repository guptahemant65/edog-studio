# C02 — Token State: Component Deep Spec

> **Component:** Token State (Environment Panel Card 2)  
> **Feature:** F11 — Environment Panel  
> **Owner:** Sana Reeves (Architecture) + Pixel (frontend implementation) + Vex (token API plumbing)  
> **Complexity:** MEDIUM  
> **Status:** P1 — DRAFT  
> **Source of Truth:** `docs/specs/features/F11-environment-panel/research/p0-foundation.md:26-35`

---

## 1. Overview

Token State is the environment panel's answer to the question developers actually ask when FLT calls fail: "Which token is sick?" EDOG has a two-token auth model: Bearer for Fabric API calls and MWC for workspace-scoped FLT calls. Sana's call: this card must not collapse those into one vague "auth ok" badge. The P0 research separates Card 2 into bearer presence, bearer expiry, MWC availability, last refresh timestamp, and refresh source, with bearer backed by `.edog-bearer-cache` and MWC backed by proxy-managed state plus `MWC_CACHE` freshness work (`p0-foundation.md:26-35`). That is the contract.

The card renders exactly two primary rows: **Bearer** and **MWC**. Each row shows source, age since fetched, expiry countdown, claims preview, manual refresh, and a copy-full-token control that reveals the JWT only on explicit action. The mock already establishes Card 2 as "Token State" with a badge, a Bearer row, an MWC row, countdown styling, and refresh action (`environment-shell.html:954-982`). The current CSS also defines token rows, status icons, and countdown color states (`environment-shell.html:400-426`), so implementation should extend the mock pattern rather than invent another inspector.

The non-obvious constraint is that MWC availability is not the same as having the raw MWC token in `/api/flt/config`. P0 explicitly says `mwcToken: "proxy-managed"` is a presence signal, "not an actual token" (`p0-foundation.md:32`). Therefore the MWC row may show "available" from config, but copy/reveal and claim decoding must use `POST /api/edog/mwc-token`, which returns the actual token and expiry (`dev-server.py:3796-3841`). Anything else would display a comforting lie. We have enough of those in distributed systems already.

---

## 2. Data Model

```ts
type TokenKind = 'bearer' | 'mwc';
type TokenStatus = 'fresh' | 'expiring' | 'expired' | 'missing';

interface TokenState {
  kind: TokenKind;
  token: string | null;
  expiresAt: number;
  fetchedAt: number;
  claims: {
    aud?: string | string[];
    upn?: string;
    exp?: number;
    [key: string]: unknown;
  };
  source: string;
  status: TokenStatus;
  error?: string;
  revealToken?: boolean;
  refreshInFlight?: boolean;
}
```

`kind` is fixed to one of the two rows. `token` is nullable because the disconnected phase can legitimately have no MWC token, and bearer may be absent before sign-in. `expiresAt` is milliseconds since epoch derived from JWT `exp` when the token can be decoded, otherwise from API metadata. `fetchedAt` is the moment the client accepted this token into state, not necessarily the backend cache file mtime. P0 marks "last refresh timestamp" as a gap and recommends surfacing MWC cache mtime (`p0-foundation.md:33`); until that backend field exists, the frontend must show "seen just now" for tokens fetched in this session and "unknown" for proxy-only MWC availability.

`source` is user-facing and concrete: Bearer uses `.edog-bearer-cache`, matching `BEARER_CACHE = PROJECT_DIR / ".edog-bearer-cache"` (`dev-server.py:43-46`) and P0's bearer source row (`p0-foundation.md:30`). MWC uses `proxy-managed / .edog-token-cache`, because `MWC_CACHE` is defined as `.edog-token-cache` (`dev-server.py:45-46`) and `_resolve_mwc_for_jupyter` still falls back to reading that file (`dev-server.py:1084-1086`), while the primary MWC path is currently in-memory `_mwc_cache` keyed by workspace, artifact, capacity, and workload (`dev-server.py:52-54`, `dev-server.py:975-980`).

Status is computed, not stored by the backend. `missing` means no token or no deploy prerequisites. `fresh` means expiry is more than five minutes away. `expiring` means less than five minutes remain. `expired` means `expiresAt <= Date.now()`. The five-minute threshold is not arbitrary: `_read_cache()` returns `(None, None)` when a cache entry is within 300 seconds of expiry (`dev-server.py:279-290`), and `_get_mwc_token()` also treats cached MWC entries as unusable inside that same 300-second safety window (`dev-server.py:976-980`).

---

## 3. API Surface

Initial load calls `GET /api/flt/config`. The route exists (`dev-server.py:1882-1884`) and returns `workspaceId`, `artifactId`, `capacityId`, `mwcToken`, `bearerToken`, `phase`, `fltPort`, and `studioPhase` (`dev-server.py:2043-2055`). For Bearer, this endpoint provides the raw JWT via `bearerToken`, satisfying the copy/reveal and client-side claims-preview requirements. For MWC, this endpoint only decides whether the row should say "deploy first," "proxy-managed," or "ready to fetch"; P0 warns the value is a presence signal, not an actual token (`p0-foundation.md:32`).

MWC reveal, copy, and manual refresh call `POST /api/edog/mwc-token` with `{ workspaceId, lakehouseId, capacityId }`. The POST route is already wired (`dev-server.py:1988-1992`), validates all three IDs (`dev-server.py:3803-3816`), requires a cached bearer token (`dev-server.py:3818-3821`), and returns `{ token, host, expiry }` on success (`dev-server.py:3833-3841`). This endpoint is the only source C02 should treat as a raw MWC JWT. If it returns 401, the MWC row depends on Bearer refresh first; if it returns 400, the row depends on deploy/config completion.

Bearer refresh uses the existing `POST /api/edog/auth` path, not a new token endpoint. The dev-server route exists (`dev-server.py:1982-1985`), `_serve_auth()` requires `username` (`dev-server.py:3354-3361`), invokes token-helper, parses JWT `exp` and `upn`, writes `.edog-bearer-cache`, and returns `{ token, username, expiresIn }` (`dev-server.py:3407-3441`). C02 should use the last known username from health/config state rather than prompt inside the card. JWT decoding must reuse TopBar's `_decodeJwt(token)` logic, which splits a three-part JWT, base64url-decodes header and payload, and returns `{ header, payload, signature, raw, parts }` or `null` on malformed input (`topbar.js:273-284`).

---

## 4. State Machine

```
missing ── token loaded ──> fresh ── T-5min ──> expiring ── T<=0 ──> expired
   ▲             │             │                    │                  │
   │             │             └─ manual refresh ───┴──── success ─────┘
   └─────────────┴──────────────── refresh failure keeps last known state
```

Bearer starts `missing` until sign-in writes `.edog-bearer-cache` and `/api/flt/config` returns `bearerToken`. Once loaded, the client decodes `exp` and moves through `fresh`, `expiring`, and `expired` using a local timer. This matters because the backend may hide near-expiry tokens at the five-minute mark (`dev-server.py:288-289`), while the UI still needs to communicate "expiring" instead of abruptly falling to "missing." TopBar already maintains local bearer expiry and ticks it every second (`topbar.js:67-74`, `topbar.js:188-223`); C02 should share or extract that logic rather than running a second truth.

MWC starts `missing` if any deploy prerequisite is absent. P0 defines MWC availability as computed from bearer plus workspace/capacity presence and exposed as `mwcToken: "proxy-managed" | null` (`p0-foundation.md:32`). The implementation should further require `artifactId`, because `_serve_mwc_token()` requires `lakehouseId` alongside workspace and capacity (`dev-server.py:3803-3816`). When available, the row may show "deploy ready" before fetching the raw token. It becomes `fresh` only after `POST /api/edog/mwc-token` succeeds and either `expiry` or decoded `exp` gives a future timestamp.

Manual refresh is row-local. Bearer refresh calls auth, replaces token state, then invalidates MWC because workspace-scoped generation depends on Bearer. MWC refresh calls `/api/edog/mwc-token` and replaces only the MWC row. Auto-refresh begins when status becomes `expiring`, with a single in-flight guard per row. If auto-refresh fails, keep the last known token visible, mark the row `expiring` or `expired`, and surface the error; deleting evidence during an outage is how dashboards become décor.

---

## 5. Scenarios

**S-C02-01: Bearer present, MWC missing.** `/api/flt/config` returns `bearerToken` but `mwcToken: null` and `phase: "disconnected"` (`dev-server.py:2047-2052`). Render Bearer as fresh/expiring based on claims. Render MWC as `missing` with a "Deploy FLT first" hint. The mock keeps a disconnected hint style specifically for Card 2 (`environment-shell.html:778-788`), so use that inline, not a modal.

**S-C02-02: Both expired.** The frontend may retain last-known tokens even after backend cache reads return null inside the 300-second safety window (`dev-server.py:279-290`). Show both rows as `expired`, disable copy until reveal confirms stale-token intent, and put refresh buttons first in tab order. Bearer refresh runs before MWC refresh because `_serve_mwc_token()` rejects requests without cached bearer (`dev-server.py:3818-3821`).

**S-C02-03: Refresh in flight.** Set `refreshInFlight = true`, disable only that row's refresh button, keep copy/reveal available for the last known token, and announce "Refreshing Bearer token" or "Refreshing MWC token" through the card live region. Concurrent clicks collapse to one request per row. MWC uses the backend's own `_mwc_lock` and cache safety window (`dev-server.py:976-980`), but the UI still needs an in-flight guard to avoid button thrash.

**S-C02-04: JWT malformed.** `_decodeJwt()` returns null for missing tokens, non-three-part strings, and parse failures (`topbar.js:273-284`). Render claims preview as "JWT unreadable," show the raw token only after reveal, and mark the row with a warning state rather than pretending the token is absent. For Bearer, retain expiry from `expiresIn` if auth returned it (`dev-server.py:3435-3441`) or from health's `bearerExpiresIn` (`dev-server.py:3483-3489`). For MWC, prefer response `expiry` (`dev-server.py:3835-3841`).

---

## 6. Visual Spec

Card 2 uses the existing Environment Panel card shell. The header title is `Token State`; the badge summarizes the worst row state: `MWC ok`, `Bearer expiring`, `Token expired`, or `Deploy first`. The mock's Card 2 header and rows are the baseline (`environment-shell.html:954-982`). The final layout keeps two primary `.token-row` entries only; the mock's separate "Last refresh" row (`environment-shell.html:983-989`) is folded into each token row as an age label so Bearer and MWC can differ.

Each row layout is: status icon, token label, detail stack, expiry chip, actions. Detail stack line one shows status pill and source. Line two shows claims preview: `aud`, `upn`, `exp`, with missing claims rendered as muted em dash. Actions are `Refresh`, `Reveal`, and `Copy`; `Copy` is disabled until reveal or explicit confirmation to avoid accidental clipboard leakage. Use `.token-icon.ok/.warn/.err`, `.inline-pill.ok/.warn/.err`, and `.token-countdown.ok/.warn` from the mock CSS (`environment-shell.html:403-426`, `environment-shell.html:368-375`).

Color rules follow status: fresh green, expiring amber, expired red, missing neutral/amber depending on whether action is required. Bearer missing before sign-in is neutral with "Sign in first." MWC missing while Bearer exists is amber with "Deploy FLT first," because the user has done auth but not connected the workspace-scoped layer. Source strings are deliberately visible because P0 treats source mapping as the point of the card (`p0-foundation.md:26-35`).

---

## 7. Keyboard & Accessibility

Rows are keyboard reachable as grouped regions: `role="group"`, `aria-labelledby` pointing at the token label, and a visually hidden status sentence such as "Bearer token fresh, expires in 38 minutes, source dot edog bearer cache." The countdown chip gets `aria-live="polite"` but must announce only minute-boundary changes, not every second. TopBar ticks every second (`topbar.js:154-158`, `topbar.js:188-223`); C02 can visually update per second while throttling screen-reader text.

`Enter` or `Space` on Reveal toggles masked/unmasked JWT text for that row. When the token text or row action group has focus, `Ctrl+C` copies the full token if revealed; otherwise it copies the claims preview and shows a toast saying reveal is required for the full JWT. This mirrors the mock's keyboard-first environment panel affordances, including global key hints in the footer (`environment-shell.html:850-864`, `environment-shell.html:1164-1168`), while avoiding accidental secret exposure.

Copy buttons must have explicit labels: "Copy Bearer token," "Copy MWC token," "Copy Bearer claims," etc. The status icon is decorative unless it is the only visible state indicator; prefer text plus color, not color alone. Error and refresh completion messages use the existing toast container pattern (`environment-shell.html:812-828`) and also update the row live region for screen readers.

---

## 8. Error Handling

Refresh failure never clears the last known token. The row keeps `token`, `claims`, `expiresAt`, and `fetchedAt`, adds `error`, and shows an inline warning plus toast. For Bearer, auth can fail with missing username, missing token-helper, certificate not found, auth failure, or timeout (`dev-server.py:3354-3446`). For MWC, the endpoint returns `empty_body`, `missing_params`, `no_bearer_token`, HTTP-propagated `mwc_token_error`, or `502 mwc_token_error` (`dev-server.py:3796-3831`). Map these to actionable copy: "Sign in again," "Deploy FLT first," or "MWC generation failed. Last token retained."

Malformed JWT is not fatal. TopBar's decoder returns null instead of throwing (`topbar.js:273-284`), and C02 should preserve that behavior. Claims preview becomes a warning row showing raw length and source, reveal still works, copy still works after reveal, and expiry falls back to API metadata where available. This is especially important for MWC because P0 states the config value can be `proxy-managed` rather than a token (`p0-foundation.md:32`); decoding that sentinel as if it were JWT would be a category error.

Expired tokens are visible but clearly stale. Copying an expired token should require the same reveal step plus an inline "expired" label. The component should not auto-open drawers or modals on expiry. TopBar currently opens the inspector when bearer reaches zero in some states (`topbar.js:213-219`); C02 should not duplicate that interruption inside the panel.

---

## 9. Performance

Decode each token once per token string. Maintain a small memo map keyed by token reference or a short hash, storing decoded claims and parse error. TopBar already has `_decodeJwt()` and `_collectTokens()` that decode bearer and MWC candidates from current config (`topbar.js:286-328`); the right implementation is to extract a shared `jwt-utils.js` helper or expose a small `window.edogJwt.decode` utility, not to paste a third decoder into the panel.

Countdown rendering uses one shared interval for both rows. TopBar already polls config every 30 seconds and runs a one-second countdown timer (`topbar.js:154-158`). C02 should subscribe to shared api-client/topbar state where possible, and only issue its own fetch on mount, focus refresh, or explicit row refresh. A one-second visual countdown is fine; API polling every second is not. That is not observability. That is a denial-of-service costume.

MWC refresh should not be eager on every panel open. If config says proxy-managed and no raw MWC has been requested, render availability and wait until Reveal, Copy, manual refresh, or expiring auto-refresh requires the token. Once fetched, keep raw MWC only in memory for the page session. Do not write tokens to localStorage or sessionStorage; backend cache already owns persistence (`dev-server.py:43-47`, `dev-server.py:273-290`).

---

## 10. Implementation Notes

Split implementation into three units. `token-state-model.js` owns `TokenState`, status derivation, countdown formatting, and claim projection. `token-state-card.js` owns DOM rendering, keyboard behavior, reveal/copy, live-region updates, and toast integration. `token-service.js` wraps `/api/flt/config`, `/api/edog/auth`, `/api/edog/mwc-token`, and shared JWT decode. This preserves Sana's boundary: data flow and state transitions are explicit, Pixel can render without guessing, and Vex can adjust backend fields without rewriting DOM code.

The card should integrate with the existing API flow rather than invent another global. TopBar already fetches `/api/flt/config` and `/api/edog/health` in parallel (`topbar.js:37-60`) and caches `_lastConfig` and `_lastHealth` (`topbar.js:57-60`). If an `api-client` abstraction already exists in this feature branch, C02 should consume that; otherwise create the smallest shared module and let TopBar migrate later. The component spec phase requires concrete implementation paths and verified code references (`FEATURE_DEV_SOP.md:37-61`), so any new backend field such as `mwcLastRefresh` must be treated as an explicit Vex task, not a frontend assumption.

Backend follow-up: expose MWC freshness and source cleanly. P0 says last MWC refresh timestamp is not collected and recommends `mwcLastRefresh` backed by `MWC_CACHE` mtime (`p0-foundation.md:33`), while current `_get_mwc_token()` stores primary Lakehouse MWC state in `_mwc_cache` with `expiry` but no fetched timestamp (`dev-server.py:1024-1028`). The surgical backend addition is to store `fetchedAt` alongside `token`, `host`, and `expiry`, and return it from `/api/edog/mwc-token`. Until then, C02 must label MWC age as client-observed, not backend authoritative.
