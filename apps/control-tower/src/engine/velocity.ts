/**
 * Velocity metrics (architecture §5.3, C08 §3.1).
 *
 * Promotion-speed analytics derived from the warm event store: per-flag
 * time-to-prod, cohort statistics, per-rung median dwell, and a quarterly trend
 * of flags reaching prod=on. All pure; no browser recomputation.
 */
import { LADDER_ENVS, type LadderEnv } from '../types/model.ts';
import type { AttributionEvent, MineEvent } from './miner.ts';
import { firstEnabledDate, ladderDwell } from './derivation.ts';

const MS_PER_DAY = 86_400_000;

function transitions(events: MineEvent[]): AttributionEvent[] {
  return events.filter((e): e is AttributionEvent => e.kind === 'transition');
}

/** Earliest date prod reached a specific state, or null. */
function firstDateAtState(events: MineEvent[], env: LadderEnv, state: 'on'): string | null {
  const hits = transitions(events)
    .filter((e) => e.env === env && e.currState === state)
    .map((e) => e.attribution.changedAt)
    .sort();
  return hits[0] ?? null;
}

function diffDays(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_DAY);
}

export interface FlagVelocity {
  flagId: string;
  /** prod first fully 'on' minus test first non-off; null until prod is fully on. */
  ttpDays: number | null;
  /** prod first non-off minus test first non-off; null until prod is non-off. */
  partialTtpDays: number | null;
}

export function flagVelocity(flagId: string, events: MineEvent[]): FlagVelocity {
  const testStart = firstEnabledDate(events, 'test');
  const prodOn = firstDateAtState(events, 'prod', 'on');
  const prodNonOff = firstEnabledDate(events, 'prod');
  return {
    flagId,
    ttpDays: testStart && prodOn ? diffDays(testStart, prodOn) : null,
    partialTtpDays: testStart && prodNonOff ? diffDays(testStart, prodNonOff) : null,
  };
}

/** Percentile (0–100) of a numeric sample using linear interpolation. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

export interface CohortStats {
  count: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  fastest: number | null;
  slowest: number | null;
}

/** Cohort TTP statistics — only meaningful with ≥3 fully-rolled-out flags (§5.3). */
export function cohortStats(ttps: number[]): CohortStats {
  if (ttps.length < 3) {
    return { count: ttps.length, median: null, p25: null, p75: null, fastest: null, slowest: null };
  }
  return {
    count: ttps.length,
    median: median(ttps),
    p25: percentile(ttps, 25),
    p75: percentile(ttps, 75),
    fastest: Math.min(...ttps),
    slowest: Math.max(...ttps),
  };
}

/** Median dwell at each ladder rung across all flags that have dwelt there. */
export function perRungMedianDwell(allEvents: MineEvent[][]): Record<LadderEnv, number | null> {
  const buckets = new Map<LadderEnv, number[]>();
  for (const rung of LADDER_ENVS) buckets.set(rung, []);
  for (const events of allEvents) {
    for (const d of ladderDwell(events)) {
      if (d.dwellDays !== null) buckets.get(d.from as LadderEnv)!.push(d.dwellDays);
    }
  }
  const out = {} as Record<LadderEnv, number | null>;
  for (const rung of LADDER_ENVS) out[rung] = median(buckets.get(rung)!);
  return out;
}

/** ISO date → calendar quarter label, e.g. "2026-Q1". */
export function quarterOf(iso: string): string {
  const d = new Date(iso);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

/** Count of flags reaching prod='on', bucketed by the quarter they got there. */
export function quarterlyTrend(allEvents: MineEvent[][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const events of allEvents) {
    const prodOn = firstDateAtState(events, 'prod', 'on');
    if (!prodOn) continue;
    const q = quarterOf(prodOn);
    out[q] = (out[q] ?? 0) + 1;
  }
  return out;
}
