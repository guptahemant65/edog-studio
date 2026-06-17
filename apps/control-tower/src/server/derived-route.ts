/**
 * Shared adapter for read-only derived `/api/ct/*` routes.
 *
 * Every derived endpoint follows the same shape: select the per-request ADO
 * provider, validate auth on EVERY call (so a warm store can never bypass the
 * gate — architecture §2.6), ensure the store is built, then project it. This
 * helper centralises that boilerplate and the uniform error mapping.
 */
import { ensureBuilt } from './store.ts';
import { adoProviderForRequest } from './request-auth.ts';
import { UnauthorizedError } from './session-ado-provider.ts';
import { MissingTokenError } from './ado-provider.ts';
import { AzureCredError } from './azure-cred-ado-provider.ts';
import { AuthConfigError } from '../auth/auth-config.ts';
import { errorResponse } from './routes.ts';
import type { AdoClient } from '../engine/ado-client.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export type DerivedProjector = (store: WarmStore, client: AdoClient) => Response | Promise<Response>;

export async function serveDerived(req: Request, project: DerivedProjector): Promise<Response> {
  try {
    const client = await adoProviderForRequest(req.headers.get('cookie'))();
    const store = await ensureBuilt(() => Promise.resolve(client));
    return await project(store, client);
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, err.message);
    if (err instanceof AuthConfigError || err instanceof MissingTokenError || err instanceof AzureCredError) {
      return errorResponse(503, err.message);
    }
    return errorResponse(500, err instanceof Error ? err.message : 'internal error');
  }
}
