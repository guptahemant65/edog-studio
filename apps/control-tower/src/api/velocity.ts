/**
 * Velocity response builder (architecture §7 endpoint 13, §5.3, C08 §3.1).
 *
 * Promotion-speed analytics over the warm event store: per-flag time-to-prod,
 * cohort statistics (only with >=3 fully-rolled-out flags), per-rung median dwell,
 * and the quarterly prod=on trend. All computed server-side; never in the browser.
 */
import {
  flagVelocity,
  cohortStats,
  perRungMedianDwell,
  quarterlyTrend,
  type FlagVelocity,
  type CohortStats,
} from '../engine/velocity.ts';
import { responseMeta, type ResponseMeta } from './meta.ts';
import type { LadderEnv } from '../types/model.ts';
import type { MineEvent } from '../engine/miner.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export interface VelocityResponse {
  flags: FlagVelocity[];
  cohort: CohortStats;
  perRungMedianDwell: Record<LadderEnv, number | null>;
  quarterlyTrend: Record<string, number>;
  meta: ResponseMeta;
}

export function buildVelocityResponse(store: WarmStore, now: number = Date.now()): VelocityResponse {
  const snapshot = store.current();
  const vintages = snapshot ? [...snapshot.flags.values()] : [];
  const allEvents: MineEvent[][] = vintages.map((v) => v.events);

  const flags = vintages
    .map((v) => flagVelocity(v.flagId, v.events))
    .sort((a, b) => a.flagId.localeCompare(b.flagId));

  const ttps = flags.map((f) => f.ttpDays).filter((d): d is number => d !== null);

  return {
    flags,
    cohort: cohortStats(ttps),
    perRungMedianDwell: perRungMedianDwell(allEvents),
    quarterlyTrend: quarterlyTrend(allEvents),
    meta: responseMeta(store, now),
  };
}
