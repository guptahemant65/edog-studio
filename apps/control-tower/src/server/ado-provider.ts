/**
 * Dev ADO client provider (architecture §2.6 — hosting-swappable auth).
 *
 * Reads a Personal Access Token from ADO_TOKEN so the grid endpoint is runnable
 * locally before the MSAL delegated-token flow (§2) lands. In production this
 * provider is replaced by one that mints a per-request delegated user token.
 */
import { HttpAdoClient, type AdoClient } from '../engine/ado-client.ts';

export class MissingTokenError extends Error {
  constructor() {
    super('ADO_TOKEN is not set — the grid endpoint needs an ADO access token (dev) or a signed-in session (prod).');
    this.name = 'MissingTokenError';
  }
}

/** Build an AdoClient from the ADO_TOKEN env var. Throws MissingTokenError if absent. */
export async function devAdoClientProvider(): Promise<AdoClient> {
  const token = process.env.ADO_TOKEN;
  if (!token) throw new MissingTokenError();
  return new HttpAdoClient(token);
}
