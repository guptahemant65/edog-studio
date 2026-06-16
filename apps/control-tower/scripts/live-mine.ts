/**
 * Live smoke: mine the real FeatureManagement repo and print a summary.
 *
 * Requires a Power BI ADO access token (delegated, read-only) in ADO_TOKEN.
 * This is a MANUAL validation tool, not a unit test — it makes live ADO calls.
 *
 *   ADO_TOKEN=<token> npm run mine:live
 */
import { HttpAdoClient } from '../src/engine/ado-client.ts';
import { mineRepository } from '../src/engine/repository.ts';
import { LADDER_ENVS } from '../src/types/model.ts';
import type { AttributionEvent } from '../src/engine/miner.ts';

const token = process.env.ADO_TOKEN;
if (!token) {
  console.error('ADO_TOKEN not set. Provide a Power BI ADO access token to run the live mine.');
  process.exit(2);
}

const started = Date.now();
const results = await mineRepository(new HttpAdoClient(token));

let totalEvents = 0;
const reachedProd = new Set<string>();
for (const r of results) {
  totalEvents += r.events.length;
  const prodEnabled = r.events.some(
    (e): e is AttributionEvent => e.kind === 'transition' && e.env === 'prod' && e.currState !== 'off',
  );
  if (prodEnabled) reachedProd.add(r.flagId);
}

console.log(`Flags discovered:   ${results.length}`);
console.log(`Attribution events: ${totalEvents}`);
console.log(`Reached prod:       ${reachedProd.size}`);
console.log(`Ladder spine:       ${LADDER_ENVS.join(' -> ')}`);
console.log(`Elapsed:            ${((Date.now() - started) / 1000).toFixed(1)}s`);
