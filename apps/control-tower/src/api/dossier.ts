/**
 * Dossier response builder (architecture §7 endpoint 2, C02 §2.7).
 *
 * The full per-flag view: current (or as-of) env states, the change timeline,
 * ladder dwell rail, time-to-prod, and the grid-consistent summary (last change,
 * stale reason, layer). Pure over the warm store; supports the `asOf` time-travel
 * entry point (data-model §5).
 */
import { currentStates, daysSinceLastChange, lastChange, type EnvStates } from '../engine/current-state.ts';
import { deriveStaleReason } from '../engine/stale-reason.ts';
import { STALE_THRESHOLDS } from '../engine/config.ts';
import { flagTimeline, type TimelineEntry } from '../engine/timeline.ts';
import { dossierDwell, timeToProd, type DossierRungDwell } from '../engine/dossier-dwell.ts';
import { eventsAsOf, statesAsOf, existedAsOf } from '../engine/as-of.ts';
import { layerOf, type FlagLayer } from './grid.ts';
import type { Attribution, StaleReason } from '../types/model.ts';
import type { MineEvent } from '../engine/miner.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export interface DossierResponse {
  found: boolean;
  flagId: string;
  description: string;
  /** echoed when the request reconstructed a historical state. */
  asOf: string | null;
  existed: boolean;
  states: EnvStates;
  timeline: TimelineEntry[];
  dwell: DossierRungDwell[];
  timeToProdDays: number | null;
  lastChange: Attribution | null;
  daysSinceLastChange: number | null;
  staleReason: StaleReason;
  layer: FlagLayer;
}

export interface BuildDossierOptions {
  now?: number;
  /** ISO date — reconstruct the flag as it stood at this instant (data-model §5). */
  asOf?: string;
}

function notFound(flagId: string, asOf: string | null): DossierResponse {
  return {
    found: false,
    flagId,
    description: '',
    asOf,
    existed: false,
    states: currentStates([]),
    timeline: [],
    dwell: [],
    timeToProdDays: null,
    lastChange: null,
    daysSinceLastChange: null,
    staleReason: null,
    layer: 'other',
  };
}

export function buildDossierResponse(store: WarmStore, flagId: string, opts: BuildDossierOptions = {}): DossierResponse {
  const now = opts.now ?? Date.now();
  const asOf = opts.asOf ?? null;
  const vintage = store.current()?.flags.get(flagId);
  if (!vintage) return notFound(flagId, asOf);

  const asOfMs = asOf ? Date.parse(asOf) : null;
  const scoped: MineEvent[] = asOfMs !== null ? eventsAsOf(vintage.events, asOfMs) : vintage.events;
  const states = asOfMs !== null ? statesAsOf(vintage.events, asOfMs) : currentStates(vintage.events);
  const horizon = asOfMs !== null ? asOfMs : now;

  const days = daysSinceLastChange(scoped, horizon);
  return {
    found: true,
    flagId,
    description: vintage.description,
    asOf,
    existed: asOfMs !== null ? existedAsOf(vintage.events, asOfMs) : true,
    states,
    timeline: flagTimeline(scoped),
    dwell: dossierDwell(scoped, horizon),
    timeToProdDays: timeToProd(scoped),
    lastChange: lastChange(scoped),
    daysSinceLastChange: days,
    staleReason: deriveStaleReason(states, days, STALE_THRESHOLDS),
    layer: layerOf(states),
  };
}
