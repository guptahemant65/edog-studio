import { serveDerived } from '../../../../src/server/derived-route.ts';
import { handleInert } from '../../../../src/server/routes.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/inert — dependency / inert intelligence (architecture §7.1 #11). */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, (store) => handleInert(store));
}
