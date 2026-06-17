/**
 * Web-standard route handlers for the Control Tower API (architecture §7).
 *
 * These take a built WarmStore and return a Fetch `Response`, with zero Next.js
 * coupling, so the full HTTP contract is unit-tested without a server. The
 * Next.js App Router route files are thin adapters that call these.
 */
import { buildGridResponse, type BuildGridOptions } from '../api/grid.ts';
import type { WarmStore } from '../engine/warm-store.ts';

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // Grid is served from the derived cache and goes stale after 60 min (§7.1); the
  // client polls /updates for freshness, so the browser must never cache it.
  'cache-control': 'no-store',
};

/** GET /api/ct/grid — current-state grid projected from the warm store. */
export function handleGrid(store: WarmStore, opts: BuildGridOptions = {}): Response {
  const body = buildGridResponse(store, opts);
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

/** A uniform error envelope for unbuilt/failed stores. */
export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}
