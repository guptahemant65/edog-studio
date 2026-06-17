/**
 * Token acquisition layer (architecture §2.3, §2.5).
 *
 * `TokenService` is the seam that hides MSAL so the sign-in flow and the ADO
 * provider are unit-testable with a fake. `MsalTokenService` is the real
 * implementation over `@azure/msal-node`'s ConfidentialClientApplication:
 *  - `acquireByCode` exchanges the auth code for the user's ADO access token;
 *  - `acquireAdoTokenSilent` refreshes transparently from the MSAL cache (§2.5).
 *
 * Access/refresh tokens live only inside MSAL's cache + our ServerTokenCache;
 * they never cross the seam to the browser.
 */
import { ConfidentialClientApplication, type Configuration } from '@azure/msal-node';
import { ADO_SCOPE, allScopes, authorityUrl } from './scopes.ts';

export interface UserProfile {
  /** Entra object id (localAccountId) — the cache key. */
  oid: string;
  name: string;
  email: string | null;
}

export interface AdoTokenGrant {
  adoAccessToken: string;
  /** epoch ms. */
  adoExpiresAt: number;
}

export interface AcquiredTokens extends AdoTokenGrant {
  profile: UserProfile;
}

export interface TokenService {
  /** Exchange an auth code for the user's profile + ADO token. */
  acquireByCode(code: string, codeVerifier?: string): Promise<AcquiredTokens>;
  /** Silently refresh the user's ADO token from cache, or null if re-auth is needed. */
  acquireAdoTokenSilent(oid: string): Promise<AdoTokenGrant | null>;
}

export interface MsalTokenServiceOptions {
  clientId: string;
  tenantId: string;
  clientSecret: string;
  redirectUri: string;
}

function toGrant(expiresOn: Date | null, accessToken: string): AdoTokenGrant {
  return {
    adoAccessToken: accessToken,
    adoExpiresAt: expiresOn ? expiresOn.getTime() : Date.now() + 55 * 60_000,
  };
}

export class MsalTokenService implements TokenService {
  private readonly cca: ConfidentialClientApplication;
  private readonly redirectUri: string;

  constructor(opts: MsalTokenServiceOptions) {
    const config: Configuration = {
      auth: {
        clientId: opts.clientId,
        authority: authorityUrl(opts.tenantId),
        clientSecret: opts.clientSecret,
      },
    };
    this.cca = new ConfidentialClientApplication(config);
    this.redirectUri = opts.redirectUri;
  }

  async acquireByCode(code: string, codeVerifier?: string): Promise<AcquiredTokens> {
    const result = await this.cca.acquireTokenByCode({
      code,
      scopes: allScopes(),
      redirectUri: this.redirectUri,
      codeVerifier,
    });
    if (!result?.account) throw new Error('MSAL returned no account for the auth code.');
    const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
    const profile: UserProfile = {
      oid: result.account.localAccountId,
      name: result.account.name ?? (typeof claims.name === 'string' ? claims.name : result.account.username),
      email: result.account.username || (typeof claims.preferred_username === 'string' ? claims.preferred_username : null),
    };
    return { profile, ...toGrant(result.expiresOn, result.accessToken) };
  }

  async acquireAdoTokenSilent(oid: string): Promise<AdoTokenGrant | null> {
    const account = await this.cca.getTokenCache().getAccountByLocalId(oid);
    if (!account) return null;
    try {
      const result = await this.cca.acquireTokenSilent({ account, scopes: [ADO_SCOPE] });
      if (!result) return null;
      return toGrant(result.expiresOn, result.accessToken);
    } catch {
      // Silent refresh failed (e.g. CAE revocation, §2.5) — caller must re-auth.
      return null;
    }
  }
}
