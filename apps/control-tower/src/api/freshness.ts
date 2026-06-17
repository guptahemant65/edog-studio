/**
 * Freshness response builder (architecture §7 endpoint 14, C09 §7.2).
 *
 * Metadata-only — reads warm store freshness + cache stats and NEVER calls ADO.
 * Drives the freshness chip in the shell; distinct from /updates which does the
 * cheap $top=1 HEAD poll.
 */
import type { WarmStore } from '../engine/warm-store.ts';

export interface FreshnessPayload {
  syncedAt: string | null;
  headCommitId: string | null;
  ageMinutes: number | null;
  isStale: boolean;
  status: 'ok' | 'failed' | 'empty';
  flagCount: number;
  cacheSize: number;
}

export function buildFreshnessResponse(store: WarmStore, now: number = Date.now()): FreshnessPayload {
  const fresh = store.freshness(now);
  const snapshot = store.current();
  return {
    syncedAt: fresh.syncedAt,
    headCommitId: fresh.headCommitId,
    ageMinutes: fresh.ageMinutes,
    isStale: fresh.isStale,
    status: fresh.status,
    flagCount: snapshot ? snapshot.flags.size : 0,
    cacheSize: store.cacheSize,
  };
}
