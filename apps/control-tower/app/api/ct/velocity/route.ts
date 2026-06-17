import { serveDerived } from '../../../../src/server/derived-route.ts';
import { handleVelocity } from '../../../../src/server/routes.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/velocity — promotion-speed analytics (architecture §7.1 #13). */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, (store) => handleVelocity(store));
}
