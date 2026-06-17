import { serveDerived } from '../../../../../../src/server/derived-route.ts';
import { jsonResponse } from '../../../../../../src/server/routes.ts';
import { buildActivityDiff } from '../../../../../../src/api/diff.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/activity/diff/:eventId — the transition behind one activity row (§7.1 #7). */
export function GET(req: Request, ctx: { params: Promise<{ eventId: string }> }): Promise<Response> {
  return serveDerived(req, async (store) => {
    const { eventId } = await ctx.params;
    return jsonResponse(buildActivityDiff(store, decodeURIComponent(eventId)));
  });
}
