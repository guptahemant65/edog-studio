import { serveDerived } from '../../../../src/server/derived-route.ts';
import { jsonResponse } from '../../../../src/server/routes.ts';
import { buildUpdatesResponse } from '../../../../src/api/ops.ts';
import { FLAG_SCOPE_PATH } from '../../../../src/engine/flag-discovery.ts';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ct/updates — cheap `$top=1` HEAD poll vs the warm store (§7.1 #15).
 * Drives the 60s passive freshness poll + "N new events" banner.
 */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, async (store, client) => {
    const remote = client.getLatestCommit ? await client.getLatestCommit(FLAG_SCOPE_PATH, 'master') : null;
    return jsonResponse(buildUpdatesResponse(store, remote?.commitId ?? null));
  });
}
