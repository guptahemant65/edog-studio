/**
 * As-of (time-travel) projection (data-model §5 `asOf`, architecture §7 #9/#10).
 *
 * Reconstructs a flag's state at a historical instant by replaying only the events
 * that had occurred by then. Pure over mined events — no ADO, no re-fetch.
 */
import { currentStates, type EnvStates } from './current-state.ts';
import type { MineEvent } from './miner.ts';

/** Events that had occurred at or before `asOfMs` (inclusive). */
export function eventsAsOf(events: MineEvent[], asOfMs: number): MineEvent[] {
  return events.filter((e) => Date.parse(e.attribution.changedAt) <= asOfMs);
}

/** Per-env states as they stood at `asOfMs`. */
export function statesAsOf(events: MineEvent[], asOfMs: number): EnvStates {
  return currentStates(eventsAsOf(events, asOfMs));
}

/** Whether the flag file existed at `asOfMs` (its creation commit had landed). */
export function existedAsOf(events: MineEvent[], asOfMs: number): boolean {
  const creation = events.find((e) => e.kind === 'creation');
  if (!creation) return events.some((e) => Date.parse(e.attribution.changedAt) <= asOfMs);
  return Date.parse(creation.attribution.changedAt) <= asOfMs;
}
