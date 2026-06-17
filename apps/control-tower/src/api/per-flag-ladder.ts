/**
 * Per-flag ladder response builder (architecture §7 endpoint 5, C03 §2.4).
 *
 * One flag's promotion-spine view: current ladder states, the dwell rail, first-
 * enabled date per rung, furthest rung reached, and time-to-prod.
 */
import { currentStates } from '../engine/current-state.ts';
import { firstEnabledDate } from '../engine/derivation.ts';
import { dossierDwell, timeToProd, type DossierRungDwell } from '../engine/dossier-dwell.ts';
import { LADDER_ENVS, type CellState, type LadderEnv } from '../types/model.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export interface PerFlagLadderResponse {
  found: boolean;
  flagId: string;
  rungs: Array<{ rung: LadderEnv; state: CellState; firstEnabled: string | null }>;
  dwell: DossierRungDwell[];
  furthestRung: LadderEnv | null;
  timeToProdDays: number | null;
}

export function buildPerFlagLadderResponse(
  store: WarmStore,
  flagId: string,
  now: number = Date.now(),
): PerFlagLadderResponse {
  const vintage = store.current()?.flags.get(flagId);
  if (!vintage) {
    return { found: false, flagId, rungs: [], dwell: [], furthestRung: null, timeToProdDays: null };
  }

  const states = currentStates(vintage.events);
  const rungs = LADDER_ENVS.map((rung) => ({
    rung,
    state: states[rung],
    firstEnabled: firstEnabledDate(vintage.events, rung),
  }));

  let furthest: LadderEnv | null = null;
  for (const rung of LADDER_ENVS) {
    if (states[rung] !== 'off') furthest = rung;
  }

  return {
    found: true,
    flagId,
    rungs,
    dwell: dossierDwell(vintage.events, now),
    furthestRung: furthest,
    timeToProdDays: timeToProd(vintage.events),
  };
}
