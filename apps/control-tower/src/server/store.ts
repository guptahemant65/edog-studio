/**
 * Warm-store singleton + lazy cold-load (architecture §3.5, §6).
 *
 * One WarmStore lives for the server process lifetime. The ADO client is supplied
 * by an injected provider so auth (§2) stays decoupled from the store: in dev the
 * provider reads a PAT; under App Service it will mint a delegated user token.
 */
import type { AdoClient } from '../engine/ado-client.ts';
import { WarmStore } from '../engine/warm-store.ts';

export type AdoClientProvider = () => Promise<AdoClient>;

let store: WarmStore | null = null;
let building: Promise<void> | null = null;

/** Process start time (module load) — drives the /health uptime metric. */
export const STARTED_AT = Date.now();

/** The process-wide warm store (created on first access). */
export function getStore(): WarmStore {
  if (!store) store = new WarmStore();
  return store;
}

/**
 * Ensure the store is cold-loaded exactly once. Concurrent callers share the
 * single in-flight build promise rather than each triggering a full mine.
 */
export async function ensureBuilt(provider: AdoClientProvider): Promise<WarmStore> {
  const s = getStore();
  if (s.isBuilt) return s;
  if (!building) {
    building = (async () => {
      const client = await provider();
      await s.build(client);
    })().finally(() => {
      building = null;
    });
  }
  await building;
  return s;
}

/** Test hook — drop the singleton so each suite starts clean. */
export function resetStore(): void {
  store = null;
  building = null;
}
