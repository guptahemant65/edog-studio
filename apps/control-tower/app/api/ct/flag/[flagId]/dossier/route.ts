import { serveDerived } from '../../../../../../src/server/derived-route.ts';
import { jsonResponse } from '../../../../../../src/server/routes.ts';
import { buildDossierResponse } from '../../../../../../src/api/dossier.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/flag/:flagId/dossier — full per-flag view (architecture §7.1 #2). */
export function GET(req: Request, ctx: { params: Promise<{ flagId: string }> }): Promise<Response> {
  return serveDerived(req, async (store) => {
    const { flagId } = await ctx.params;
    const asOf = new URL(req.url).searchParams.get('asOf') ?? undefined;
    return jsonResponse(buildDossierResponse(store, flagId, { asOf }));
  });
}
