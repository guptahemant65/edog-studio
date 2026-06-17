/**
 * Ladder distribution response builder (architecture §7 endpoint 4, C03 §2.4).
 *
 * Pure projection of every flag's current ladder states into the per-rung
 * distribution + furthest-rung histogram. The route handler is a thin wrapper.
 */
import { currentStates } from '../engine/current-state.ts';
import { ladderDistribution, type LadderDistribution } from '../engine/ladder-distribution.ts';
import { responseMeta, type ResponseMeta } from './meta.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export interface LadderDistributionResponse {
  distribution: LadderDistribution;
  meta: ResponseMeta;
}

export function buildLadderDistributionResponse(
  store: WarmStore,
  now: number = Date.now(),
): LadderDistributionResponse {
  const snapshot = store.current();
  const flagStates = snapshot ? [...snapshot.flags.values()].map((v) => currentStates(v.events)) : [];
  return {
    distribution: ladderDistribution(flagStates),
    meta: responseMeta(store, now),
  };
}
