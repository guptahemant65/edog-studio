/**
 * Derivation helpers — first-enabled dates and ladder dwell.
 *
 * Implements the dwell rule (data-model.md §7): a rung is "reached" at its first
 * non-off state; dwell between consecutive rungs is whole calendar days between
 * their first-enabled dates. Prod follows the same formula — no special case.
 */
import { LADDER_ENVS, type EnvKey } from '../types/model.ts';
import type { AttributionEvent, MineEvent } from './miner.ts';

const MS_PER_DAY = 86_400_000;

function transitions(events: MineEvent[]): AttributionEvent[] {
  return events.filter((e): e is AttributionEvent => e.kind === 'transition');
}

/**
 * Earliest date at which `env` entered a non-off state (on | conditional | targeted),
 * or null if it never did. ISO-8601 string.
 */
export function firstEnabledDate(events: MineEvent[], env: EnvKey): string | null {
  const enables = transitions(events)
    .filter((e) => e.env === env && e.currState !== 'off')
    .map((e) => e.attribution.changedAt)
    .sort();
  return enables[0] ?? null;
}

/** Whole calendar days between two ISO dates (UTC midnight, floored). */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(...utcParts(fromIso));
  const b = Date.UTC(...utcParts(toIso));
  return Math.floor((b - a) / MS_PER_DAY);
}

function utcParts(iso: string): [number, number, number] {
  const d = new Date(iso);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

export interface RungDwell {
  from: EnvKey;
  to: EnvKey;
  /** null when either rung was never reached. */
  dwellDays: number | null;
}

/** Dwell (in calendar days) between each consecutive pair of ladder rungs. */
export function ladderDwell(events: MineEvent[]): RungDwell[] {
  const out: RungDwell[] = [];
  for (let i = 0; i < LADDER_ENVS.length - 1; i++) {
    const from = LADDER_ENVS[i]!;
    const to = LADDER_ENVS[i + 1]!;
    const a = firstEnabledDate(events, from);
    const b = firstEnabledDate(events, to);
    out.push({ from, to, dwellDays: a && b ? calendarDaysBetween(a, b) : null });
  }
  return out;
}
