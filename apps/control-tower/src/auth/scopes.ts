/**
 * Entra / ADO scope constants (architecture §2.3).
 *
 * The data identity requests the Azure DevOps resource scope so the delegated
 * token can call the ADO REST API as the signed-in user.
 */

/** Azure DevOps resource — `.default` yields the user's delegated ADO permissions. */
export const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

/** OIDC scopes for the user profile (no tokens for these leave the server). */
export const OIDC_SCOPES = ['openid', 'profile', 'email'] as const;

/** Tenant-pinned authority — only PowerBI-org users can sign in (§2.5). */
export function authorityUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}`;
}

/** Full scope set for the authorization request. */
export function allScopes(): string[] {
  return [...OIDC_SCOPES, ADO_SCOPE];
}
