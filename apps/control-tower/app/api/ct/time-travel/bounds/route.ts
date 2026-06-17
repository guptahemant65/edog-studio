import { serveDerived } from '../../../../../src/server/derived-route.ts';
import { handleTimeTravelBounds } from '../../../../../src/server/routes.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/time-travel/bounds — queryable history window (architecture §7.1 #9). */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, (store) => handleTimeTravelBounds(store));
}
