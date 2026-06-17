/**
 * Grid response builder (architecture §7 endpoint 1, C01 §2.2).
 *
 * Pure, framework-agnostic projection of the warm store into the Control Tower
 * grid payload. The Next.js route handler is a thin wrapper around this so the
 * full response shape is unit-tested without a server or bundler.
 */
import { LADDER_ENVS, SOVEREIGN_ENVS, type Attribution, type StaleReason } from '../types/model.ts';
import { currentStates, daysSinceLastChange, lastChange, type EnvStates } from '../engine/current-state.ts';
import { deriveStaleReason } from '../engine/stale-reason.ts';
import { STALE_THRESHOLDS, type StaleThresholds } from '../engine/config.ts';
import type { WarmStore } from '../engine/warm-store.ts';

/** A flag's layer membership, for the grid's layer facet (LADDER / SOVEREIGN / OTHER). */
export type FlagLayer = 'ladder' | 'sovereign' | 'other';

export interface GridRow {
  flagId: string;
  description: string;
  /** all 15 canonical env states. */
  states: EnvStates;
  /** attribution of the most recent transition; null if never changed. */
  lastChange: Attribution | null;
  daysSinceLastChange: number | null;
  staleReason: StaleReason;
  /** furthest layer this flag has reached a non-off state in. */
  layer: FlagLayer;
}

export interface GridMeta {
  syncedAt: string | null;
  headCommitId: string | null;
  isStale: boolean;
  status: 'ok' | 'failed' | 'empty';
  flagCount: number;
}

export interface ControlTowerGridResponse {
  rows: GridRow[];
  meta: GridMeta;
}

function layerOf(states: EnvStates): FlagLayer {
  if (SOVEREIGN_ENVS.some((e) => states[e] !== 'off')) return 'sovereign';
  if (LADDER_ENVS.some((e) => states[e] !== 'off')) return 'ladder';
  return 'other';
}

export interface BuildGridOptions {
  now?: number;
  thresholds?: StaleThresholds;
}

/** Project the warm store's current vintage into the grid response. */
export function buildGridResponse(store: WarmStore, opts: BuildGridOptions = {}): ControlTowerGridResponse {
  const now = opts.now ?? Date.now();
  const thresholds = opts.thresholds ?? STALE_THRESHOLDS;
  const snapshot = store.current();
  const fresh = store.freshness(now);

  const rows: GridRow[] = [];
  if (snapshot) {
    for (const vintage of snapshot.flags.values()) {
      const states = currentStates(vintage.events);
      const days = daysSinceLastChange(vintage.events, now);
      rows.push({
        flagId: vintage.flagId,
        description: vintage.description,
        states,
        lastChange: lastChange(vintage.events),
        daysSinceLastChange: days,
        staleReason: deriveStaleReason(states, days, thresholds),
        layer: layerOf(states),
      });
    }
  }
  rows.sort((a, b) => a.flagId.localeCompare(b.flagId));

  return {
    rows,
    meta: {
      syncedAt: fresh.syncedAt,
      headCommitId: fresh.headCommitId,
      isStale: fresh.isStale,
      status: fresh.status,
      flagCount: rows.length,
    },
  };
}
