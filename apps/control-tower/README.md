# Aperture — Rollout Tracker (F30 Control Tower)

Read-only feature-flag rollout-intelligence portal. Reconstructs how every FLT
feature flag rolls out across the 15 canonical environments by mining the
`FeatureManagement` ADO git repo.

> **Specs are authoritative.** This package implements
> `docs/specs/features/F30-control-tower/` — `architecture.md` (system design)
> and `data-model.md` (canonical types). Where code and spec disagree, the spec wins.

## Status

| Layer | State |
|-------|-------|
| **Data engine — attribution core** (`src/engine`) | ✅ implemented + tested |
| ADO REST client + git-history loader | ✅ implemented (injectable) + tested via fake; live smoke gated on `ADO_TOKEN` |
| Warm store + incremental refresh | ✅ immutable commit cache, atomic refresh, freshness metadata + tested |
| Derivation layer (state/stale/velocity/sovereign/ladder) | ✅ implemented + tested |
| Grid response builder + server layer | ✅ `buildGridResponse` + Web-standard handlers + store singleton, tested |
| Next.js shell + `GET /api/ct/grid` | ✅ App Router shell + wired grid route (dev: `ADO_TOKEN`) |
| Auth (MSAL two-identity, delegated per-user ADO token) | ✅ Entra auth-code+PKCE, server-side token cache, encrypted session cookie + tested; dev fallback via `CT_DEV_AUTH=1`+`ADO_TOKEN` |
| Derived endpoints — `freshness`, `ladder/distribution`, `velocity`, `sovereign-lens` | ✅ pure builders + thin routes + tested |
| Remaining `/api/ct/*` routes (dossier, per-flag ladder, timeline/activity diff, activity stream + timeline, time-travel bounds/reconstruct, inert, updates, refresh, health) | ✅ all 17 endpoints live — pure builders + thin routes + tested; `next build` green |
| Frontend build-out (from `mocks/rollout-tracker.html`) | ✅ live SPA wired to the 17 endpoints — locked mock CSS ported verbatim (`app/globals.css`), client-safe view-model (`app/view-model.ts`), interactive `RolloutTracker` (`app/rollout-tracker.tsx`) with briefing/pipeline/object table/facets/gauge/dossier drawer/command palette/as-of time-travel; `next build` green |
| P4 read-only enforcement gauntlet (`tests/read-only.test.ts`) | ✅ no mutating HTTP handlers (POST confined to reconstruct + refresh), `HttpAdoClient` GET-only egress, cold-load cost model (one fetch per commit, refresh reuses the immutable cache) — 6 tests |

## Engine core (done)

- `src/types/model.ts` — canonical `CellState`, 15-env model + groupings,
  `Attribution`, `StaleReason`, API prefix (verbatim from `data-model.md`).
- `src/engine/state.ts` — `classifyState` (§3.3), `normaliseBlock`
  (§3.4.2 reformat-proofing — neutralises whitespace/key-order so cosmetic
  commits never produce false attribution), `extractPR`/`buildPrUrl` (§3.4.3).
- `src/engine/miner.ts` — `mineFlag`: the consecutive-commit semantic-diff
  engine (§3.4.1). Decoupled from HTTP — consumes an ordered `FlagCommit[]`,
  emits `FileCreationEvent` + `AttributionEvent[]`.
- `src/engine/derivation.ts` — `firstEnabledDate` + `ladderDwell` (dwell rule
  §7: first-non-off; prod is not special-cased).
- `src/engine/ado-client.ts` — `AdoClient` interface + `HttpAdoClient` (fetch,
  concurrency cap, 429 backoff). Network decoupled so orchestration is testable.
- `src/engine/concurrency.ts` — `mapLimit` (bounded, order-preserving) +
  `fetchWithRetry` (§3.1).
- `src/engine/flag-discovery.ts` — `discoverFlagPaths` / `flagIdFromPath` (§3.2).
- `src/engine/repository.ts` — `loadFlagHistory` (newest→oldest, content per
  commit) + `mineRepository` (discover → load → mine), the ADO↔engine seam.
- `src/engine/warm-store.ts` — `WarmStore`: immutable `CommitContentCache`,
  `build` (cold-load), atomic `refresh` (stage-then-swap, last-good rollback on
  failure), and `freshness` metadata (no ADO). Refresh refetches only NEW commits.
- `src/engine/current-state.ts` — fold transitions to current per-env `CellState`
  (latest wins) + `lastChange` + `daysSinceLastChange`; always all 15 envs.
- `src/engine/stale-reason.ts` + `config.ts` — C06 §4.3 health classifier with
  tunable thresholds.
- `src/engine/velocity.ts` — per-flag TTP, cohort stats, per-rung median dwell,
  quarterly prod-on trend (§5.3).
- `src/engine/sovereign.ts` — `GAP_MAP` gap classification for the 7 clouds (§5.4).
- `src/engine/ladder-distribution.ts` — per-rung state counts + furthest-rung
  histogram (C03 §2.4).
- `src/api/grid.ts` — pure `buildGridResponse(store)` → `ControlTowerGridResponse`
  (§7.1 #1). `src/server/` — Web-standard route handlers, the warm-store
  singleton (`ensureBuilt`), and the auth-swappable dev ADO provider.

## App shell

The Next.js App Router shell lives in `app/`: `layout.tsx`, `page.tsx` (renders
the grid, with a graceful "set `ADO_TOKEN`" banner), and `app/api/ct/grid/route.ts`
(thin adapter over `src/server`). `next.config.mjs` teaches webpack to resolve the
engine's explicit `.ts` import extensions.

```bash
npm run build      # next build (typechecks app/, compiles routes)
ADO_TOKEN=<pat> npm run dev   # next dev on :5556 — live flag data
```

> `npm run typecheck` (tsc) gates the pure engine (`src`/`tests`/`scripts`);
> `app/` is gated by `next build` (it needs the DOM lib + Next's jsx transform).

## Commands

```bash
npm install        # typescript + @types/node only — no bundler
npm test           # node --test + --experimental-strip-types (zero-dep runner)
npm run typecheck  # tsc --noEmit
```

### Why no vitest/bundler

The engine is pure Node logic with no DOM. It runs on Node's built-in test
runner with native TypeScript type-stripping — no Vite/rollup, no flaky native
optional-dep install on Windows. The Next.js app layer (added later) will carry
its own bundler-based tooling.

## Next slice

All 17 `/api/ct/*` read-only endpoints are now live (grid, freshness, ladder
distribution + per-flag ladder, velocity, sovereign-lens, dossier, timeline diff,
activity stream/diff/timeline, time-travel bounds + reconstruct, inert
intelligence, updates poll, refresh, health) — each a thin adapter over a pure
builder in `src/api/`. The P3 frontend is now live: `app/page.tsx` is the
auth-gated server shell that assembles `InitialData` from `buildGridResponse` +
`buildInertResponse`, and `app/rollout-tracker.tsx` (a `'use client'` SPA) renders
the locked mock against real warm-store data — every number derived from the
endpoints, no fabricated rule JSON (per-env attribution links straight to the real
PR/commit). Next up: P4 gauntlet (read-only enforcement test, cold-load perf,
Azure deploy).

### Auth notes (§2)

Two identities: the App identity (infra) and the Data identity (delegated
per-user Entra token with the ADO scope). The user's ADO access token lives
**only** in a server-side cache keyed by `oid` and never touches the cookie or
the browser; the session cookie is AES-256-GCM encrypted, httpOnly, profile-only,
8h. Env: `ENTRA_CLIENT_ID`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_SECRET`,
`CT_REDIRECT_URI`, `CT_SESSION_SECRET`. Local dev shortcut: `CT_DEV_AUTH=1` +
`ADO_TOKEN` (PAT) bypasses Entra.

> **Deviation from §2.4:** the spec names Auth.js (next-auth) v5. The session
> layer here is implemented directly with `node:crypto` AES-256-GCM (identical
> security posture) for testability without a live Entra registration. Real MSAL
> token acquisition (`MsalTokenService`) is retained behind a `TokenService`
> seam, so this is swappable for Auth.js later.
