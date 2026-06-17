import { ensureBuilt } from '../../../../src/server/store.ts';
import { adoProviderForRequest } from '../../../../src/server/request-auth.ts';
import { UnauthorizedError } from '../../../../src/server/session-ado-provider.ts';
import { MissingTokenError } from '../../../../src/server/ado-provider.ts';
import { AuthConfigError } from '../../../../src/auth/auth-config.ts';
import { handleGrid, errorResponse } from '../../../../src/server/routes.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/grid — current-state grid from the warm store (architecture §7.1 #1). */
export async function GET(req: Request): Promise<Response> {
  try {
    const provider = adoProviderForRequest(req.headers.get('cookie'));
    // Validate auth on EVERY request, even if the store is already warm.
    const client = await provider();
    const store = await ensureBuilt(() => Promise.resolve(client));
    return handleGrid(store);
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, err.message);
    if (err instanceof AuthConfigError || err instanceof MissingTokenError) return errorResponse(503, err.message);
    return errorResponse(500, err instanceof Error ? err.message : 'internal error');
  }
}
