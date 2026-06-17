import { serveDerived } from '../../../../../src/server/derived-route.ts';
import { jsonResponse, errorResponse } from '../../../../../src/server/routes.ts';
import { buildTimeTravelResponse, InvalidAsOfError } from '../../../../../src/api/time-travel.ts';

export const dynamic = 'force-dynamic';

interface ReconstructBody {
  asOf?: string;
  flags?: string[];
}

/**
 * POST /api/ct/time-travel/reconstruct — historical state at an instant (§7.1 #10).
 * POST only because of the request-body shape; it writes nothing (§7.3).
 */
export function POST(req: Request): Promise<Response> {
  return serveDerived(req, async (store) => {
    let body: ReconstructBody;
    try {
      body = (await req.json()) as ReconstructBody;
    } catch {
      return errorResponse(400, 'Request body must be valid JSON.');
    }
    if (!body.asOf) return errorResponse(400, 'Missing required field: asOf.');
    try {
      const flags = body.flags ? new Set(body.flags) : undefined;
      return jsonResponse(buildTimeTravelResponse(store, { asOf: body.asOf, flags }));
    } catch (err) {
      if (err instanceof InvalidAsOfError) return errorResponse(400, err.message);
      throw err;
    }
  });
}
