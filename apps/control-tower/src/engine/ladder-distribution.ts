/**
 * Ladder distribution (architecture §3.5 consumer, C03 §2.4).
 *
 * Aggregates current per-flag ladder states into a per-rung distribution: how many
 * flags sit at each CellState on each of the 6 ladder rungs, plus a "reached"
 * count (non-off). The furthest-rung histogram answers "where do flags pile up?".
 */
import { LADDER_ENVS, type CellState, type LadderEnv } from '../types/model.ts';
import type { EnvStates } from './current-state.ts';

export interface RungDistribution {
  rung: LadderEnv;
  off: number;
  on: number;
  conditional: number;
  targeted: number;
  /** non-off total (on + conditional + targeted). */
  reached: number;
}

export interface LadderDistribution {
  rungs: RungDistribution[];
  /** flagId count whose furthest non-off ladder rung is each rung; key 'none' = no rung reached. */
  furthestRung: Record<string, number>;
  totalFlags: number;
}

function emptyRung(rung: LadderEnv): RungDistribution {
  return { rung, off: 0, on: 0, conditional: 0, targeted: 0, reached: 0 };
}

/** Index of the furthest (highest) ladder rung that is non-off, or -1 if none. */
function furthestRungIndex(states: EnvStates): number {
  let idx = -1;
  LADDER_ENVS.forEach((rung, i) => {
    if (states[rung] !== 'off') idx = i;
  });
  return idx;
}

export function ladderDistribution(flagStates: EnvStates[]): LadderDistribution {
  const rungs = LADDER_ENVS.map(emptyRung);
  const furthest: Record<string, number> = { none: 0 };
  for (const rung of LADDER_ENVS) furthest[rung] = 0;

  for (const states of flagStates) {
    LADDER_ENVS.forEach((rung, i) => {
      const state: CellState = states[rung];
      const bucket = rungs[i]!;
      bucket[state] += 1;
      if (state !== 'off') bucket.reached += 1;
    });
    const fi = furthestRungIndex(states);
    const key = fi === -1 ? 'none' : LADDER_ENVS[fi]!;
    furthest[key] = (furthest[key] ?? 0) + 1;
  }

  return { rungs, furthestRung: furthest, totalFlags: flagStates.length };
}
