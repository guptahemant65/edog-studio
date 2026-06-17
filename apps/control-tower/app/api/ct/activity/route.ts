import { serveDerived } from '../../../../src/server/derived-route.ts';
import { jsonResponse } from '../../../../src/server/routes.ts';
import { buildActivityStream, parseActivityFilter } from '../../../../src/api/activity.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/activity — cross-flag event stream, filterable (architecture §7.1 #6). */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, (store) => {
    const filter = parseActivityFilter(new URL(req.url).searchParams);
    return jsonResponse(buildActivityStream(store, filter));
  });
}
