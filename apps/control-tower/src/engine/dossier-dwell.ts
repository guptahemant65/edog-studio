/**
 * Dossier ladder dwell (architecture §5.2, data-model §7).
 *
 * Distinct from `ladderDwell` (consecutive-rung pairs, used by velocity): this
 * walks only the rungs a flag has actually *reached* and reports dwell between
 * consecutive reached rungs, with the current highest rung's dwell still ongoing.
 * Contract anchor (§5.2): FLTArtifactBasedThrottling → test 8d, cst 0d, daily 12d,
 * dxt 7d, msit 7d (test→prod 37d).
 */
import { LADDER_ENVS, type LadderEnv } from '../types/model.ts';
import { calendarDaysBetween, firstEnabledDate } from './derivation.ts';
import type { MineEvent } from './miner.ts';

export interface DossierRungDwell {
  rung: LadderEnv;
  nextRung: LadderEnv | null;
  /** ISO date this rung was first reached (first non-off state). */
  firstEnabled: string;
  dwellDays: number;
  dwellLabel: string;
  /** true for the current highest reached rung — dwell is still accumulating. */
  isCurrent: boolean;
}

function formatDwell(days: number): string {
  return `${days}d`;
}

export function dossierDwell(events: MineEvent[], now: number = Date.now()): DossierRungDwell[] {
  const firstEnabled = new Map<LadderEnv, string>();
  for (const rung of LADDER_ENVS) {
    const date = firstEnabledDate(events, rung);
    if (date) firstEnabled.set(rung, date);
  }

  const reached = LADDER_ENVS.filter((r) => firstEnabled.has(r));
  const nowIso = new Date(now).toISOString();

  return reached.map((rung, i) => {
    const next = reached[i + 1] ?? null;
    const from = firstEnabled.get(rung)!;
    const isCurrent = next === null;
    const to = next ? firstEnabled.get(next)! : nowIso;
    const dwellDays = calendarDaysBetween(from, to);
    return { rung, nextRung: next, firstEnabled: from, dwellDays, dwellLabel: formatDwell(dwellDays), isCurrent };
  });
}

/** Test→prod calendar days (first test enabled → first prod enabled), or null. */
export function timeToProd(events: MineEvent[]): number | null {
  const test = firstEnabledDate(events, 'test');
  const prod = firstEnabledDate(events, 'prod');
  return test && prod ? calendarDaysBetween(test, prod) : null;
}
