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
| **Data engine — attribution core** (`src/engine`) | ✅ implemented + tested (28 tests) |
| ADO REST client + git-history fetch | ⬜ next |
| Warm store + incremental refresh | ⬜ next |
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

ADO REST client (`src/engine/ado-client.ts`) behind the same `FlagCommit`
interface the miner already consumes, with recorded fixtures for offline tests
and a live mode gated on an ADO token — then the warm store and the first
`/api/ct/grid` endpoint end-to-end.
