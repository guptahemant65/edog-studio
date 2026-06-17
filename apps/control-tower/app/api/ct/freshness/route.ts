import { serveDerived } from '../../../../src/server/derived-route.ts';
import { handleFreshness } from '../../../../src/server/routes.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/freshness — metadata-only warm-store freshness (architecture §7.1 #14). */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, (store) => handleFreshness(store));
}
