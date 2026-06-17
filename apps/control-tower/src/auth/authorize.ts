/**
 * OAuth2 authorization-request helpers (architecture §2.2 steps 3–4).
 *
 * Pure builders for the Entra authorize URL plus CSRF `state` and PKCE pair.
 * No network, no MSAL — these shape the redirect the browser follows to sign in.
 */
import { createHash, randomBytes } from 'node:crypto';
import { allScopes, authorityUrl } from './scopes.ts';

export interface AuthorizeParams {
  clientId: string;
  tenantId: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
  scopes?: string[];
}

/** Build the Entra `/authorize` URL (auth-code + PKCE when a challenge is given). */
export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const url = new URL(`${authorityUrl(p.tenantId)}/oauth2/v2.0/authorize`);
  const q = url.searchParams;
  q.set('client_id', p.clientId);
  q.set('response_type', 'code');
  q.set('redirect_uri', p.redirectUri);
  q.set('response_mode', 'query');
  q.set('scope', (p.scopes ?? allScopes()).join(' '));
  q.set('state', p.state);
  if (p.codeChallenge) {
    q.set('code_challenge', p.codeChallenge);
    q.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/** Random, URL-safe CSRF state token. */
export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** PKCE verifier + S256 challenge. */
export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
