/**
 * Request-scoped ADO client provider (architecture §2.2 steps 11–12).
 *
 * Resolves the signed-in user's delegated ADO token from the session + server
 * token cache (refreshing silently if needed) and constructs an HttpAdoClient.
 * Unauthenticated or expired-without-refresh requests raise UnauthorizedError so
 * the route returns 401 → the browser re-authenticates (§2.5 revocation path).
 */
import { HttpAdoClient, type AdoClient } from '../engine/ado-client.ts';
import { readSession } from '../auth/guard.ts';
import type { ServerTokenCache } from '../auth/token-cache.ts';
import type { TokenService } from '../auth/token-service.ts';
import type { AdoClientProvider } from './store.ts';

export class UnauthorizedError extends Error {
  constructor(message = 'Not signed in.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export interface SessionProviderOptions {
  cookieHeader: string | null;
  sessionSecret: string;
  cache: ServerTokenCache;
  /** optional — enables silent refresh when the cached token has expired. */
  tokenSvc?: TokenService;
  now?: number;
}

/** Build an AdoClientProvider bound to the current request's session. */
export function sessionAdoClientProvider(opts: SessionProviderOptions): AdoClientProvider {
  return async (): Promise<AdoClient> => {
    const session = readSession(opts.cookieHeader, opts.sessionSecret, opts.now);
    if (!session) throw new UnauthorizedError('No valid session — sign in required.');

    let token = opts.cache.getValid(session.oid, opts.now);
    if (!token && opts.tokenSvc) {
      const refreshed = await opts.tokenSvc.acquireAdoTokenSilent(session.oid);
      if (refreshed) {
        opts.cache.set(session.oid, refreshed);
        token = refreshed.adoAccessToken;
      }
    }
    if (!token) throw new UnauthorizedError('Session token expired — re-authentication required.');

    return new HttpAdoClient(token);
  };
}
