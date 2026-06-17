/**
 * Azure-credential ADO client provider (architecture §2.6 — hosting-swappable auth).
 *
 * Mints the ADO access token from an Entra identity via `@azure/identity` instead
 * of a PAT or an interactive sign-in. `DefaultAzureCredential` resolves to:
 *  - `AzureCliCredential` locally — the developer's own `az login`, so the token
 *    carries their existing ADO access (no app registration, no PAT);
 *  - `ManagedIdentityCredential` when deployed — the app's system/user-assigned
 *    identity (which must be granted Code-read on the ADO org).
 *
 * The token targets the Azure DevOps resource scope (`ADO_SCOPE`); the credential
 * caches and refreshes it internally, so per-request calls are cheap. The token is
 * server-side only and is handed straight to `HttpAdoClient` as a Bearer token.
 */
import {
  AzureCliCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { HttpAdoClient, type AdoClient } from '../engine/ado-client.ts';
import { ADO_SCOPE } from '../auth/scopes.ts';
import type { AdoClientProvider } from './store.ts';

export class AzureCredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AzureCredError';
  }
}

/**
 * Build the credential from the environment:
 *  - `CT_AZURE_CRED_MODE=cli` → only the Azure CLI (fast locally; no IMDS probe);
 *  - `CT_AZURE_CRED_MODE=mi`  → only a managed identity (optionally `CT_MI_CLIENT_ID`);
 *  - otherwise → `DefaultAzureCredential` (works both locally and when deployed).
 */
export function buildAdoCredential(env: NodeJS.ProcessEnv = process.env): TokenCredential {
  const mode = env.CT_AZURE_CRED_MODE;
  const miClientId = env.CT_MI_CLIENT_ID;
  if (mode === 'cli') return new AzureCliCredential();
  if (mode === 'mi') {
    return miClientId ? new ManagedIdentityCredential({ clientId: miClientId }) : new ManagedIdentityCredential();
  }
  return miClientId
    ? new DefaultAzureCredential({ managedIdentityClientId: miClientId })
    : new DefaultAzureCredential();
}

let cachedCredential: TokenCredential | null = null;

function getCredential(): TokenCredential {
  if (!cachedCredential) cachedCredential = buildAdoCredential();
  return cachedCredential;
}

/** Test hook — drop the cached credential so each suite starts clean. */
export function resetAdoCredential(): void {
  cachedCredential = null;
}

/** Build an AdoClientProvider over an explicit credential (injectable for tests). */
export function azureCredAdoClientProviderWith(credential: TokenCredential): AdoClientProvider {
  return async (): Promise<AdoClient> => {
    let token;
    try {
      token = await credential.getToken(ADO_SCOPE);
    } catch (err) {
      throw new AzureCredError(
        `Azure credential could not acquire an ADO token: ${(err as Error).message}`,
      );
    }
    if (!token?.token) {
      throw new AzureCredError(
        'Azure credential returned no ADO token — run `az login` (local) or assign a managed identity with ADO access (deployed).',
      );
    }
    return new HttpAdoClient(token.token);
  };
}

/** The process-wide Azure-credential ADO provider (lazy-builds from env). */
export const azureCredAdoClientProvider: AdoClientProvider = () =>
  azureCredAdoClientProviderWith(getCredential())();
