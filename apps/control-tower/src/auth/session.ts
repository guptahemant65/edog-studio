/**
 * Encrypted session cookie (architecture §2.4 / §2.5).
 *
 * The browser session is an AES-256-GCM-sealed token carrying ONLY the user
 * profile + expiry — never an access/refresh token (the hard rule in §2.1). The
 * server looks up the actual ADO token in the server-side cache (token-cache.ts)
 * using the `oid` from this payload. Tamper or expiry yields a null session.
 *
 * This is a focused, fully-tested stand-in for the Auth.js encrypted-JWT cookie
 * with the identical security posture (httpOnly, secure, sameSite=lax, 8h); it
 * can be swapped for Auth.js without changing any consumer.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'ct_session';
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // 8h (§2.5)

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SessionPayload {
  /** Entra object id — the stable per-user key into the server token cache. */
  oid: string;
  name: string;
  email: string | null;
  /** epoch ms when this session expires. */
  expiresAt: number;
}

/** Derive a stable 32-byte key from the configured session secret. */
function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Seal a payload into an opaque cookie value. */
export function sealSession(payload: SessionPayload, secret: string): string {
  return sealValue(payload, secret);
}

/** Seal any JSON-serialisable value with AES-256-GCM (no expiry semantics). */
export function sealValue(value: unknown, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [b64urlEncode(iv), b64urlEncode(tag), b64urlEncode(ct)].join('.');
}

/** Open + verify an AES-256-GCM value. Returns null on tamper/malformed. */
export function openValue<T>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0]!, 'base64url');
    const tag = Buffer.from(parts[1]!, 'base64url');
    const ct = Buffer.from(parts[2]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Open and verify a session cookie value. Returns null on tamper, malformed, or expired. */
export function openSession(token: string, secret: string, now: number = Date.now()): SessionPayload | null {
  const payload = openValue<SessionPayload>(token, secret);
  if (!payload) return null;
  if (typeof payload.oid !== 'string' || typeof payload.expiresAt !== 'number') return null;
  if (payload.expiresAt <= now) return null;
  return payload;
}

export interface CookieOptions {
  secure?: boolean;
}

/** `Set-Cookie` header value for a sealed session. */
export function buildSetCookie(value: string, opts: CookieOptions = {}): string {
  const secure = opts.secure ?? true;
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** `Set-Cookie` header that clears the session (sign-out). */
export function buildClearCookie(opts: CookieOptions = {}): string {
  const secure = opts.secure ?? true;
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** Constant-time compare for opaque tokens (CSRF state, etc.). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
