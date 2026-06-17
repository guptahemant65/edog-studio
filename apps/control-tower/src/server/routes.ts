/**
 * Web-standard route handlers for the Control Tower API (architecture §7).
 *
 * These take a built WarmStore and return a Fetch `Response`, with zero Next.js
 * coupling, so the full HTTP contract is unit-tested without a server. The
 * Next.js App Router route files are thin adapters that call these.
 */
import { buildGridResponse, type BuildGridOptions } from '../api/grid.ts';
import { buildFreshnessResponse } from '../api/freshness.ts';
import { buildLadderDistributionResponse } from '../api/ladder.ts';
import { buildVelocityResponse } from '../api/velocity.ts';
import { buildSovereignLensResponse } from '../api/sovereign.ts';
import { buildInertResponse } from '../api/inert.ts';
import { buildTimeTravelBounds } from '../api/time-travel.ts';
import type { WarmStore } from '../engine/warm-store.ts';

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // Grid is served from the derived cache and goes stale after 60 min (§7.1); the
  // client polls /updates for freshness, so the browser must never cache it.
  'cache-control': 'no-store',
};

/** 200 JSON response with no-store caching. */
export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

/** GET /api/ct/grid — current-state grid projected from the warm store. */
export function handleGrid(store: WarmStore, opts: BuildGridOptions = {}): Response {
  return jsonResponse(buildGridResponse(store, opts));
}

/** GET /api/ct/freshness — metadata-only warm-store freshness (never calls ADO). */
export function handleFreshness(store: WarmStore, now?: number): Response {
  return jsonResponse(buildFreshnessResponse(store, now));
}

/** GET /api/ct/ladder/distribution — per-rung ladder distribution. */
export function handleLadderDistribution(store: WarmStore, now?: number): Response {
  return jsonResponse(buildLadderDistributionResponse(store, now));
}

/** GET /api/ct/velocity — promotion-speed analytics. */
export function handleVelocity(store: WarmStore, now?: number): Response {
  return jsonResponse(buildVelocityResponse(store, now));
}

/** GET /api/ct/sovereign-lens — sovereign vs prod gap classification. */
export function handleSovereignLens(store: WarmStore, now?: number): Response {
  return jsonResponse(buildSovereignLensResponse(store, now));
}

/** GET /api/ct/inert — dependency / inert intelligence. */
export function handleInert(store: WarmStore, now?: number): Response {
  return jsonResponse(buildInertResponse(store, now));
}

/** GET /api/ct/time-travel/bounds — queryable history window. */
export function handleTimeTravelBounds(store: WarmStore): Response {
  return jsonResponse(buildTimeTravelBounds(store));
}

/** A uniform error envelope for unbuilt/failed stores. */
export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}
