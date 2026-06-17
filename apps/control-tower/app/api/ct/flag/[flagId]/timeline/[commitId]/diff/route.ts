import { serveDerived } from '../../../../../../../../src/server/derived-route.ts';
import { jsonResponse } from '../../../../../../../../src/server/routes.ts';
import { buildTimelineDiff } from '../../../../../../../../src/api/diff.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/flag/:flagId/timeline/:commitId/diff — env changes at one commit (§7.1 #3). */
export function GET(req: Request, ctx: { params: Promise<{ flagId: string; commitId: string }> }): Promise<Response> {
  return serveDerived(req, async (store) => {
    const { flagId, commitId } = await ctx.params;
    return jsonResponse(buildTimelineDiff(store, flagId, commitId));
  });
}
