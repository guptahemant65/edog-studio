/**
 * Short-lived OAuth round-trip cookie (architecture §2.2 steps 3–6).
 *
 * Carries the CSRF `state` + PKCE `verifier` from the sign-in redirect to the
 * callback. Sealed (AES-256-GCM) and httpOnly so the browser can't read or forge
 * it; cleared immediately after the callback validates state.
 */
import { sealValue, openValue, type CookieOptions } from './session.ts';

export const OAUTH_COOKIE = 'ct_oauth';
const OAUTH_MAX_AGE_SECONDS = 600; // 10 min to complete sign-in

export interface OAuthRoundTrip {
  state: string;
  verifier: string;
  /** path to return to after sign-in. */
  returnTo: string;
}

export function sealOAuth(rt: OAuthRoundTrip, secret: string): string {
  return sealValue(rt, secret);
}

export function openOAuth(token: string, secret: string): OAuthRoundTrip | null {
  const rt = openValue<OAuthRoundTrip>(token, secret);
  if (!rt || typeof rt.state !== 'string' || typeof rt.verifier !== 'string') return null;
  return rt;
}

export function buildOAuthSetCookie(value: string, opts: CookieOptions = {}): string {
  const secure = opts.secure ?? true;
  const attrs = [`${OAUTH_COOKIE}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${OAUTH_MAX_AGE_SECONDS}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildOAuthClearCookie(opts: CookieOptions = {}): string {
  const secure = opts.secure ?? true;
  const attrs = [`${OAUTH_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
