/**
 * Current-state derivation (architecture §3.3, §3.5).
 *
 * Folds a flag's mined transition events into the current per-env CellState plus
 * activity metadata (last change attribution, days since last change). Every flag
 * is normalised to all 15 canonical env keys — components never see missing keys.
 */
import { CANONICAL_15_ENVS, type Attribution, type CellState, type EnvKey } from '../types/model.ts';
import type { AttributionEvent, MineEvent } from './miner.ts';

const MS_PER_DAY = 86_400_000;

/** All 15 canonical envs mapped to a CellState. */
export type EnvStates = Record<EnvKey, CellState>;

function transitions(events: MineEvent[]): AttributionEvent[] {
  return events.filter((e): e is AttributionEvent => e.kind === 'transition');
}

/** Fully-off baseline — the starting point before any transition is applied. */
function allOff(): EnvStates {
  const out = {} as EnvStates;
  for (const env of CANONICAL_15_ENVS) out[env] = 'off';
  return out;
}

/**
 * Current per-env state: the latest transition (by changedAt) wins for each env.
 * Envs with no transition remain 'off'.
 */
export function currentStates(events: MineEvent[]): EnvStates {
  const states = allOff();
  const latest = new Map<EnvKey, string>(); // env → winning changedAt
  for (const e of transitions(events)) {
    const prev = latest.get(e.env);
    if (prev === undefined || e.attribution.changedAt >= prev) {
      latest.set(e.env, e.attribution.changedAt);
      states[e.env] = e.currState;
    }
  }
  return states;
}

/** The most recent transition's attribution, or null if the flag never transitioned. */
export function lastChange(events: MineEvent[]): Attribution | null {
  let best: Attribution | null = null;
  for (const e of transitions(events)) {
    if (!best || e.attribution.changedAt > best.changedAt) best = e.attribution;
  }
  return best;
}

/** Whole calendar days since the flag's last transition, or null if it never changed. */
export function daysSinceLastChange(events: MineEvent[], now: number = Date.now()): number | null {
  const last = lastChange(events);
  if (!last) return null;
  return Math.floor((now - Date.parse(last.changedAt)) / MS_PER_DAY);
}
