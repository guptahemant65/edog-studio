/**
 * Per-request ADO provider selection (architecture §2.6).
 *
 * Chooses the data-identity source for a request:
 *  - local dev (`CT_DEV_AUTH=1` + `ADO_TOKEN`) → a PAT-backed client;
 *  - Azure credential (`CT_AZURE_CRED=1`) → an Entra token via `@azure/identity`
 *    (the developer's `az login` locally, or a managed identity when deployed);
 *  - otherwise → the signed-in user's delegated token via the session.
 *
 * The returned provider validates authentication on EVERY call, so callers must
 * invoke it per request (even when the warm store is already built) to keep
 * unauthenticated users out — the store being warm must never bypass the gate.
 */
import { getTokenCache } from '../auth/token-cache.ts';
import { readAuthEnv } from '../auth/auth-config.ts';
import { isDevAuth, isAzureCred } from '../auth/auth-config.ts';
import { MsalTokenService } from '../auth/token-service.ts';
import { devAdoClientProvider } from './ado-provider.ts';
import { azureCredAdoClientProvider } from './azure-cred-ado-provider.ts';
import { sessionAdoClientProvider } from './session-ado-provider.ts';
import type { AdoClientProvider } from './store.ts';

/** Cookies are only sent with Secure in production (https); local dev is http. */
export function isSecureRequest(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Build the appropriate ADO client provider for the incoming request. */
export function adoProviderForRequest(cookieHeader: string | null): AdoClientProvider {
  if (isDevAuth()) return devAdoClientProvider;
  if (isAzureCred()) return azureCredAdoClientProvider;
  const env = readAuthEnv(); // throws AuthConfigError when Entra isn't configured
  const svc = new MsalTokenService({
    clientId: env.clientId,
    tenantId: env.tenantId,
    clientSecret: env.clientSecret,
    redirectUri: env.redirectUri,
  });
  return sessionAdoClientProvider({
    cookieHeader,
    sessionSecret: env.sessionSecret,
    cache: getTokenCache(),
    tokenSvc: svc,
  });
}
