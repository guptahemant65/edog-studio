/**
 * Timeline projection (architecture §3.4, data-model §3.1).
 *
 * Turns mined events into display-ready timeline entries with stable, immutable
 * event ids and the canonical display labels. Shared by the dossier (C02) and the
 * activity stream (C04) so both speak the same vocabulary.
 */
import type { Attribution, CellState, EnvKey } from '../types/model.ts';
import { buildPrUrl } from './state.ts';
import type { MineEvent } from './miner.ts';

export type TimelineAction = 'created' | 'enabled' | 'disabled' | 'modified';
export type DisplayLabel = 'Created by' | 'Last enabled by' | 'Last modified by';

export interface TimelineEntry {
  /** stable + immutable: `flagId:commitId:env` (env = `__created__` for creation). */
  eventId: string;
  flagId: string;
  kind: 'creation' | 'transition';
  env: EnvKey | null;
  prevState: CellState | null;
  currState: CellState | null;
  action: TimelineAction;
  displayLabel: DisplayLabel;
  attribution: Attribution;
  prUrl: string | null;
}

const CREATION_TOKEN = '__created__';

export function eventId(flagId: string, commitId: string, env: EnvKey | null): string {
  return `${flagId}:${commitId}:${env ?? CREATION_TOKEN}`;
}

/** Parse an eventId back into its parts. Returns null on a malformed id. */
export function parseEventId(id: string): { flagId: string; commitId: string; env: EnvKey | null } | null {
  const parts = id.split(':');
  if (parts.length !== 3) return null;
  const [flagId, commitId, envToken] = parts as [string, string, string];
  if (!flagId || !commitId || !envToken) return null;
  return { flagId, commitId, env: envToken === CREATION_TOKEN ? null : (envToken as EnvKey) };
}

function actionOf(prev: CellState, curr: CellState): TimelineAction {
  if (prev === 'off' && curr !== 'off') return 'enabled';
  if (prev !== 'off' && curr === 'off') return 'disabled';
  return 'modified';
}

function labelFor(action: TimelineAction): DisplayLabel {
  if (action === 'created') return 'Created by';
  if (action === 'enabled') return 'Last enabled by';
  return 'Last modified by'; // modified + disabled (data-model §3.1)
}

export function toTimelineEntry(e: MineEvent): TimelineEntry {
  const prUrl = e.attribution.prNumber !== null ? buildPrUrl(e.attribution.prNumber) : null;
  if (e.kind === 'creation') {
    return {
      eventId: eventId(e.flagId, e.attribution.commitId, null),
      flagId: e.flagId,
      kind: 'creation',
      env: null,
      prevState: null,
      currState: null,
      action: 'created',
      displayLabel: labelFor('created'),
      attribution: e.attribution,
      prUrl,
    };
  }
  const action = actionOf(e.prevState, e.currState);
  return {
    eventId: eventId(e.flagId, e.attribution.commitId, e.env),
    flagId: e.flagId,
    kind: 'transition',
    env: e.env,
    prevState: e.prevState,
    currState: e.currState,
    action,
    displayLabel: labelFor(action),
    attribution: e.attribution,
    prUrl,
  };
}

/** A flag's full timeline, newest-first (ties broken by env for determinism). */
export function flagTimeline(events: MineEvent[]): TimelineEntry[] {
  return events
    .map(toTimelineEntry)
    .sort(
      (a, b) =>
        b.attribution.changedAt.localeCompare(a.attribution.changedAt) ||
        (a.env ?? '').localeCompare(b.env ?? ''),
    );
}
