/**
 * Shared response metadata for derived-cache endpoints (architecture §7.1).
 *
 * Every derived endpoint echoes the warm store's freshness so the client can show
 * a consistent "synced N min ago / stale" chip without a second round-trip.
 */
import type { WarmStore } from '../engine/warm-store.ts';

export interface ResponseMeta {
  syncedAt: string | null;
  isStale: boolean;
  status: 'ok' | 'failed' | 'empty';
  flagCount: number;
}

export function responseMeta(store: WarmStore, now: number = Date.now()): ResponseMeta {
  const fresh = store.freshness(now);
  const snapshot = store.current();
  return {
    syncedAt: fresh.syncedAt,
    isStale: fresh.isStale,
    status: fresh.status,
    flagCount: snapshot ? snapshot.flags.size : 0,
  };
}
