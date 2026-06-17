import { serveDerived } from '../../../../../src/server/derived-route.ts';
import { jsonResponse } from '../../../../../src/server/routes.ts';
import { buildActivityTimeline, parseActivityFilter } from '../../../../../src/api/activity.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/activity/timeline — per-day event buckets (architecture §7.1 #8). */
export function GET(req: Request): Promise<Response> {
  return serveDerived(req, (store) => {
    const filter = parseActivityFilter(new URL(req.url).searchParams);
    return jsonResponse(buildActivityTimeline(store, filter));
  });
}
