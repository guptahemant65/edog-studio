import { serveDerived } from '../../../../src/server/derived-route.ts';
import { handleSovereignLens } from '../../../../src/server/routes.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/sovereign-lens — sovereign vs prod gap classification (architecture §7.1 #12). */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, (store) => handleSovereignLens(store));
}
