import { serveDerived } from '../../../../../src/server/derived-route.ts';
import { handleLadderDistribution } from '../../../../../src/server/routes.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/ladder/distribution — per-rung ladder distribution (architecture §7.1 #4). */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, (store) => handleLadderDistribution(store));
}
