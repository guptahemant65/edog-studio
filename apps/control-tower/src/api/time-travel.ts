/**
 * Time-travel response builders (architecture §7 endpoints 9 & 10, C05 §2.4).
 *
 * `bounds` reports the queryable history window. `reconstruct` replays the warm
 * event store to a chosen instant and returns every flag's state as it stood
 * then. Both are pure over mined events (data-model §5/§7) — no ADO, no re-fetch.
 */
import { statesAsOf, existedAsOf } from '../engine/as-of.ts';
import { layerOf, type FlagLayer } from './grid.ts';
import { responseMeta, type ResponseMeta } from './meta.ts';
import type { EnvStates } from '../engine/current-state.ts';
import type { MineEvent } from '../engine/miner.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export interface TimeTravelBounds {
  earliest: string | null;
  latest: string | null;
  totalEvents: number;
  flagCount: number;
}

function allEvents(store: WarmStore): MineEvent[] {
  const snapshot = store.current();
  if (!snapshot) return [];
  const out: MineEvent[] = [];
  for (const v of snapshot.flags.values()) out.push(...v.events);
  return out;
}

export function buildTimeTravelBounds(store: WarmStore): TimeTravelBounds {
  const snapshot = store.current();
  let earliest: string | null = null;
  let latest: string | null = null;
  let total = 0;
  for (const e of allEvents(store)) {
    total += 1;
    const at = e.attribution.changedAt;
    if (earliest === null || at < earliest) earliest = at;
    if (latest === null || at > latest) latest = at;
  }
  return { earliest, latest, totalEvents: total, flagCount: snapshot ? snapshot.flags.size : 0 };
}

export interface TimeTravelRow {
  flagId: string;
  existed: boolean;
  states: EnvStates;
  layer: FlagLayer;
}

export interface TimeTravelResponse {
  asOf: string;
  rows: TimeTravelRow[];
  /** flags that existed at `asOf`. */
  existingCount: number;
  meta: ResponseMeta;
}

export interface TimeTravelRequest {
  asOf: string;
  /** restrict to these flag ids. */
  flags?: ReadonlySet<string>;
  now?: number;
}

export class InvalidAsOfError extends Error {
  constructor(value: string) {
    super(`Invalid asOf date: ${value}`);
    this.name = 'InvalidAsOfError';
  }
}

export function buildTimeTravelResponse(store: WarmStore, req: TimeTravelRequest): TimeTravelResponse {
  const asOfMs = Date.parse(req.asOf);
  if (Number.isNaN(asOfMs)) throw new InvalidAsOfError(req.asOf);

  const snapshot = store.current();
  const vintages = snapshot ? [...snapshot.flags.values()] : [];

  let existingCount = 0;
  const rows: TimeTravelRow[] = vintages
    .filter((v) => !req.flags || req.flags.has(v.flagId))
    .map((v) => {
      const existed = existedAsOf(v.events, asOfMs);
      if (existed) existingCount += 1;
      const states = statesAsOf(v.events, asOfMs);
      return { flagId: v.flagId, existed, states, layer: layerOf(states) };
    })
    .sort((a, b) => a.flagId.localeCompare(b.flagId));

  return { asOf: req.asOf, rows, existingCount, meta: responseMeta(store, req.now ?? Date.now()) };
}
