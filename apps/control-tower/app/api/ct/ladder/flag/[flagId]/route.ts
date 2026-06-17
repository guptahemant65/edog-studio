import { serveDerived } from '../../../../../../src/server/derived-route.ts';
import { jsonResponse } from '../../../../../../src/server/routes.ts';
import { buildPerFlagLadderResponse } from '../../../../../../src/api/per-flag-ladder.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/ladder/flag/:flagId — one flag's promotion-spine view (§7.1 #5). */
export function GET(req: Request, ctx: { params: Promise<{ flagId: string }> }): Promise<Response> {
  return serveDerived(req, async (store) => {
    const { flagId } = await ctx.params;
    return jsonResponse(buildPerFlagLadderResponse(store, flagId));
  });
}
