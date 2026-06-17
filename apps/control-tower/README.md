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
| Derivation (ladder/velocity/sovereign/inert) | 🟡 dwell done; rest pending |
| Auth (MSAL + Auth.js, two-identity) | ⬜ |
| API surface (17 `/api/ct/*` routes) | ⬜ |
| Next.js frontend (from `mocks/rollout-tracker.html`) | ⬜ |

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

The remaining derivations (ladder distribution, velocity, sovereign lens, inert
/ C06 stale-reason) reading from the warm store, then the first `/api/ct/grid`
endpoint end-to-end (current-state rows from the latest vintage).
