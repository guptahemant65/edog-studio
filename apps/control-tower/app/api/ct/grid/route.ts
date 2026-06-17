import { serveDerived } from '../../../../src/server/derived-route.ts';
import { handleGrid } from '../../../../src/server/routes.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/grid — current-state grid from the warm store (architecture §7.1 #1). */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, (store) => handleGrid(store));
}
