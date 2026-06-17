import { getStore, STARTED_AT } from '../../../../src/server/store.ts';
import { jsonResponse } from '../../../../src/server/routes.ts';
import { buildHealthResponse } from '../../../../src/api/ops.ts';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ct/health — liveness + cache stats (architecture §7.1 #17).
 * Unauthenticated ops probe: never triggers a cold-load, never calls ADO.
 */
export function GET(): Response {
  return jsonResponse(buildHealthResponse(getStore(), STARTED_AT));
}
