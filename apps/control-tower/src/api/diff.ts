/**
 * Diff response builders (architecture §7 endpoints 3 & 7, C02 §2.8 / C04 §3.2).
 *
 * Both endpoints are commitId-anchored and therefore immutable. The diff is the
 * set of semantic env state transitions carried by a single commit — derived from
 * the mined events, so no content re-fetch is needed. Raw `Requires`/`Targets`
 * blocks are offered as a repo deep-link per the data-model §6.1 size policy.
 */
import { buildPrUrl } from '../engine/state.ts';
import { parseEventId } from '../engine/timeline.ts';
import type { AttributionEvent, MineEvent } from '../engine/miner.ts';
import type { Attribution, CellState, EnvKey } from '../types/model.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export interface EnvChange {
  env: EnvKey;
  prevState: CellState;
  currState: CellState;
}

export interface EnvsDiff {
  found: boolean;
  flagId: string;
  commitId: string;
  isCreation: boolean;
  attribution: Attribution | null;
  changes: EnvChange[];
  prUrl: string | null;
}

function transitionsAt(events: MineEvent[], commitId: string): AttributionEvent[] {
  return events.filter(
    (e): e is AttributionEvent => e.kind === 'transition' && e.attribution.commitId === commitId,
  );
}

function eventAt(events: MineEvent[], commitId: string): MineEvent | undefined {
  return events.find((e) => e.attribution.commitId === commitId);
}

/** GET /api/ct/flag/:flagId/timeline/:commitId/diff — all env changes at one commit. */
export function buildTimelineDiff(store: WarmStore, flagId: string, commitId: string): EnvsDiff {
  const vintage = store.current()?.flags.get(flagId);
  const anchor = vintage ? eventAt(vintage.events, commitId) : undefined;
  if (!vintage || !anchor) {
    return { found: false, flagId, commitId, isCreation: false, attribution: null, changes: [], prUrl: null };
  }
  const changes = transitionsAt(vintage.events, commitId)
    .map((e) => ({ env: e.env, prevState: e.prevState, currState: e.currState }))
    .sort((a, b) => a.env.localeCompare(b.env));
  return {
    found: true,
    flagId,
    commitId,
    isCreation: anchor.kind === 'creation',
    attribution: anchor.attribution,
    changes,
    prUrl: anchor.attribution.prNumber !== null ? buildPrUrl(anchor.attribution.prNumber) : null,
  };
}

export interface EnvDiffDetail {
  found: boolean;
  eventId: string;
  flagId: string;
  env: EnvKey | null;
  prevState: CellState | null;
  currState: CellState | null;
  attribution: Attribution | null;
  prUrl: string | null;
}

/** GET /api/ct/activity/diff/:eventId — the single transition behind one activity row. */
export function buildActivityDiff(store: WarmStore, rawEventId: string): EnvDiffDetail {
  const parsed = parseEventId(rawEventId);
  const miss: EnvDiffDetail = {
    found: false,
    eventId: rawEventId,
    flagId: parsed?.flagId ?? '',
    env: parsed?.env ?? null,
    prevState: null,
    currState: null,
    attribution: null,
    prUrl: null,
  };
  if (!parsed) return miss;

  const vintage = store.current()?.flags.get(parsed.flagId);
  if (!vintage) return miss;

  const match = vintage.events.find((e) =>
    parsed.env === null
      ? e.kind === 'creation' && e.attribution.commitId === parsed.commitId
      : e.kind === 'transition' && e.env === parsed.env && e.attribution.commitId === parsed.commitId,
  );
  if (!match) return miss;

  return {
    found: true,
    eventId: rawEventId,
    flagId: parsed.flagId,
    env: parsed.env,
    prevState: match.kind === 'transition' ? match.prevState : null,
    currState: match.kind === 'transition' ? match.currState : null,
    attribution: match.attribution,
    prUrl: match.attribution.prNumber !== null ? buildPrUrl(match.attribution.prNumber) : null,
  };
}
