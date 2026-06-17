/**
 * Sign-in completion flow (architecture §2.2 steps 7–9).
 *
 * Orchestrates the OAuth callback: exchange code → ADO token, stash the token in
 * the server-side cache keyed by oid, and seal a profile-only session cookie.
 * Pure over an injected `TokenService` + cache, so it is fully unit-testable.
 */
import { buildSetCookie, sealSession, SESSION_MAX_AGE_SECONDS, type SessionPayload } from './session.ts';
import type { ServerTokenCache } from './token-cache.ts';
import type { TokenService } from './token-service.ts';

export interface CompleteSignInOptions {
  svc: TokenService;
  cache: ServerTokenCache;
  code: string;
  codeVerifier?: string;
  sessionSecret: string;
  /** path to send the browser to after sign-in. */
  redirectTo?: string;
  /** false in local http dev so the cookie is sent without Secure. */
  secureCookie?: boolean;
  now?: number;
}

export interface SignInResult {
  setCookie: string;
  redirectTo: string;
  profile: SessionPayload;
}

export async function completeSignIn(opts: CompleteSignInOptions): Promise<SignInResult> {
  const now = opts.now ?? Date.now();
  const tokens = await opts.svc.acquireByCode(opts.code, opts.codeVerifier);

  // Server-side only — the access token never goes near the cookie.
  opts.cache.set(tokens.profile.oid, {
    adoAccessToken: tokens.adoAccessToken,
    adoExpiresAt: tokens.adoExpiresAt,
  });

  const payload: SessionPayload = {
    oid: tokens.profile.oid,
    name: tokens.profile.name,
    email: tokens.profile.email,
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000,
  };
  const cookieValue = sealSession(payload, opts.sessionSecret);

  return {
    setCookie: buildSetCookie(cookieValue, { secure: opts.secureCookie ?? true }),
    redirectTo: opts.redirectTo ?? '/',
    profile: payload,
  };
}
