/**
 * Ops response builders (architecture §7 endpoints 15, 16, 17).
 *
 * - updates  — compares the warm store's head to a remote `$top=1` HEAD (the
 *   cheap freshness poll). Pure: the route supplies the remote head.
 * - refresh  — wraps the warm store's atomic refresh result.
 * - health   — liveness + cache stats for ops.
 */
import { responseMeta, type ResponseMeta } from './meta.ts';
import type { RefreshResult, WarmStore } from '../engine/warm-store.ts';

export interface UpdatesCheckPayload {
  newerHeadAvailable: boolean;
  storeHead: string | null;
  remoteHead: string | null;
  checkedAt: string;
}

export function buildUpdatesResponse(
  store: WarmStore,
  remoteHead: string | null,
  now: number = Date.now(),
): UpdatesCheckPayload {
  const storeHead = store.freshness(now).headCommitId;
  return {
    // Only assert "newer" when we have a remote head that differs from a known store head.
    newerHeadAvailable: remoteHead !== null && storeHead !== null && remoteHead !== storeHead,
    storeHead,
    remoteHead,
    checkedAt: new Date(now).toISOString(),
  };
}

export interface RefreshResponse {
  ok: boolean;
  headCommitId: string | null;
  totalEvents: number;
  error: string | null;
  meta: ResponseMeta;
}

export function buildRefreshResponse(result: RefreshResult, store: WarmStore, now: number = Date.now()): RefreshResponse {
  return {
    ok: result.ok,
    headCommitId: result.headCommitId,
    totalEvents: result.totalEvents,
    error: result.error ?? null,
    meta: responseMeta(store, now),
  };
}

export interface HealthPayload {
  status: 'ok';
  uptimeSeconds: number;
  cacheStats: {
    isBuilt: boolean;
    flagCount: number;
    cacheSize: number;
  };
  freshness: ResponseMeta;
}

export function buildHealthResponse(store: WarmStore, startedAtMs: number, now: number = Date.now()): HealthPayload {
  const snapshot = store.current();
  return {
    status: 'ok',
    uptimeSeconds: Math.floor((now - startedAtMs) / 1000),
    cacheStats: {
      isBuilt: store.isBuilt,
      flagCount: snapshot ? snapshot.flags.size : 0,
      cacheSize: store.cacheSize,
    },
    freshness: responseMeta(store, now),
  };
}
