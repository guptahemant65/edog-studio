import { serveDerived } from '../../../../src/server/derived-route.ts';
import { jsonResponse } from '../../../../src/server/routes.ts';
import { buildRefreshResponse } from '../../../../src/api/ops.ts';

export const dynamic = 'force-dynamic';

/**
 * POST /api/ct/refresh — atomic incremental warm-store advance (§7.1 #16).
 * Reads from ADO; writes nothing to any external system (§7.3).
 */
export function POST(req: Request): Promise<Response> {
  return serveDerived(req, async (store, client) => {
    const result = await store.refresh(client);
    return jsonResponse(buildRefreshResponse(result, store));
  });
}
