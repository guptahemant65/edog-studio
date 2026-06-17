/**
 * Activity response builders (architecture §7 endpoints 6 & 8, C04 §3.1/§3.3).
 *
 * The activity stream is the cross-flag event feed (newest-first, filterable by
 * date range, flag, and env). The timeline summary buckets those events by
 * calendar day for the activity sparkline. Both are computed server-side from the
 * warm event store; the browser never recomputes.
 */
import { toTimelineEntry, type TimelineEntry } from '../engine/timeline.ts';
import { responseMeta, type ResponseMeta } from './meta.ts';
import type { EnvKey } from '../types/model.ts';
import type { MineEvent } from '../engine/miner.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export interface ActivityFilter {
  /** inclusive ISO lower bound on changedAt. */
  from?: string;
  /** inclusive ISO upper bound on changedAt. */
  to?: string;
  /** restrict to these flag ids. */
  flags?: ReadonlySet<string>;
  /** restrict to these envs (excludes creation entries). */
  envs?: ReadonlySet<EnvKey>;
  /** page size (default 100). */
  limit?: number;
  /** page offset (default 0). */
  offset?: number;
}

export interface ActivityStreamResponse {
  items: TimelineEntry[];
  total: number;
  limit: number;
  offset: number;
  meta: ResponseMeta;
}

/** Parse activity filter params from a query string (data-model §5 route table). */
export function parseActivityFilter(params: URLSearchParams): ActivityFilter {
  const flags = params.get('flags');
  const envs = params.get('envs');
  const limit = params.get('limit');
  const offset = params.get('offset');
  const toSet = <T extends string>(v: string | null): ReadonlySet<T> | undefined =>
    v ? new Set(v.split(',').map((s) => s.trim()).filter(Boolean) as T[]) : undefined;
  return {
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    flags: toSet<string>(flags),
    envs: toSet<EnvKey>(envs),
    limit: limit !== null && Number.isFinite(Number(limit)) ? Number(limit) : undefined,
    offset: offset !== null && Number.isFinite(Number(offset)) ? Number(offset) : undefined,
  };
}

function allEvents(store: WarmStore): MineEvent[] {
  const snapshot = store.current();
  if (!snapshot) return [];
  const out: MineEvent[] = [];
  for (const v of snapshot.flags.values()) out.push(...v.events);
  return out;
}

function matches(e: TimelineEntry, f: ActivityFilter): boolean {
  if (f.flags && !f.flags.has(e.flagId)) return false;
  if (f.envs) {
    if (e.env === null) return false; // creation entries have no env
    if (!f.envs.has(e.env)) return false;
  }
  const at = e.attribution.changedAt;
  if (f.from && at < f.from) return false;
  if (f.to && at > f.to) return false;
  return true;
}

export function buildActivityStream(
  store: WarmStore,
  filter: ActivityFilter = {},
  now: number = Date.now(),
): ActivityStreamResponse {
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;

  const all = allEvents(store)
    .map(toTimelineEntry)
    .filter((e) => matches(e, filter))
    .sort(
      (a, b) =>
        b.attribution.changedAt.localeCompare(a.attribution.changedAt) ||
        a.flagId.localeCompare(b.flagId) ||
        (a.env ?? '').localeCompare(b.env ?? ''),
    );

  return {
    items: all.slice(offset, offset + limit),
    total: all.length,
    limit,
    offset,
    meta: responseMeta(store, now),
  };
}

export interface TimelineBucket {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  count: number;
}

export interface TimelineSummaryResponse {
  buckets: TimelineBucket[];
  totalEvents: number;
  busiestDay: TimelineBucket | null;
  range: { from: string | null; to: string | null };
  meta: ResponseMeta;
}

export function buildActivityTimeline(
  store: WarmStore,
  filter: ActivityFilter = {},
  now: number = Date.now(),
): TimelineSummaryResponse {
  const entries = allEvents(store)
    .map(toTimelineEntry)
    .filter((e) => matches(e, filter));

  const counts = new Map<string, number>();
  let min: string | null = null;
  let max: string | null = null;
  for (const e of entries) {
    const at = e.attribution.changedAt;
    const day = at.slice(0, 10); // ISO date prefix = UTC calendar day
    counts.set(day, (counts.get(day) ?? 0) + 1);
    if (min === null || at < min) min = at;
    if (max === null || at > max) max = at;
  }

  const buckets: TimelineBucket[] = [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let busiest: TimelineBucket | null = null;
  for (const b of buckets) {
    if (!busiest || b.count > busiest.count) busiest = b;
  }

  return {
    buckets,
    totalEvents: entries.length,
    busiestDay: busiest,
    range: { from: min, to: max },
    meta: responseMeta(store, now),
  };
}
