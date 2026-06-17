import { ensureBuilt } from '../../../../src/server/store.ts';
import { devAdoClientProvider, MissingTokenError } from '../../../../src/server/ado-provider.ts';
import { handleGrid, errorResponse } from '../../../../src/server/routes.ts';

export const dynamic = 'force-dynamic';

/** GET /api/ct/grid — current-state grid from the warm store (architecture §7.1 #1). */
export async function GET(): Promise<Response> {
  try {
    const store = await ensureBuilt(devAdoClientProvider);
    return handleGrid(store);
  } catch (err) {
    if (err instanceof MissingTokenError) return errorResponse(503, err.message);
    return errorResponse(500, err instanceof Error ? err.message : 'internal error');
  }
}
