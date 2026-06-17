/**
 * Server-side ADO token cache (architecture §2.5).
 *
 * Holds each user's delegated ADO access token in memory ONLY, keyed by Entra
 * `oid`. The token is never serialised to a cookie or response — `toJSON` throws
 * to make accidental serialisation a hard error. A skew window forces a refresh
 * slightly before real expiry so in-flight requests never use a dead token.
 */
const EXPIRY_SKEW_MS = 60_000; // refresh 60s early

export interface CachedToken {
  adoAccessToken: string;
  /** epoch ms. */
  adoExpiresAt: number;
}

export class ServerTokenCache {
  private readonly map = new Map<string, CachedToken>();

  set(oid: string, token: CachedToken): void {
    this.map.set(oid, token);
  }

  /** The user's access token if present and not within the skew of expiry, else null. */
  getValid(oid: string, now: number = Date.now()): string | null {
    const hit = this.map.get(oid);
    if (!hit) return null;
    if (hit.adoExpiresAt - EXPIRY_SKEW_MS <= now) return null;
    return hit.adoAccessToken;
  }

  has(oid: string): boolean {
    return this.map.has(oid);
  }

  delete(oid: string): void {
    this.map.delete(oid);
  }

  get size(): number {
    return this.map.size;
  }

  /** Guard: tokens must never be serialised. */
  toJSON(): never {
    throw new Error('ServerTokenCache must never be serialised — it holds delegated access tokens.');
  }
}

/** Process-wide singleton (one cache per server instance, §2.5). */
let cache: ServerTokenCache | null = null;
export function getTokenCache(): ServerTokenCache {
  if (!cache) cache = new ServerTokenCache();
  return cache;
}
export function resetTokenCache(): void {
  cache = null;
}
