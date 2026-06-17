/**
 * Cookie parsing + session guard (architecture §2.2 step 11).
 *
 * Reads the encrypted session cookie off a request's Cookie header and verifies
 * it. Route handlers use `readSession` to gate access; a null result means the
 * caller is unauthenticated and must be redirected to sign-in (page) or 401'd
 * (API).
 */
import { SESSION_COOKIE, openSession, type SessionPayload } from './session.ts';

/** Parse a raw `Cookie` header into a name→value map. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/** Verify the session cookie from a Cookie header. Returns null if absent/invalid/expired. */
export function readSession(
  cookieHeader: string | null,
  secret: string,
  now: number = Date.now(),
): SessionPayload | null {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  return openSession(token, secret, now);
}
