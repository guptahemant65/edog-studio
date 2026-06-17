/**
 * Test fixtures for derivation tests. Not a test file (no *.test.ts suffix), so
 * the node:test glob never runs it directly — it is imported by the suites.
 */
import type { CellState, EnvKey } from '../src/types/model.ts';
import type { AttributionEvent, MineEvent } from '../src/engine/miner.ts';

let seq = 0;

/** Build a transition AttributionEvent with sensible defaults. */
export function tx(
  env: EnvKey,
  prevState: CellState,
  currState: CellState,
  changedAt: string,
  extra: { author?: string | null; prNumber?: number | null; commitId?: string } = {},
): AttributionEvent {
  seq += 1;
  return {
    kind: 'transition',
    flagId: 'F',
    env,
    prevState,
    currState,
    attribution: {
      author: extra.author ?? 'dev',
      prNumber: extra.prNumber ?? null,
      commitId: extra.commitId ?? `c${seq}`.padEnd(40, '0'),
      changedAt,
    },
  };
}

export function creation(flagId: string, changedAt: string): MineEvent {
  return {
    kind: 'creation',
    flagId,
    attribution: { author: 'dev', prNumber: null, commitId: 'init'.padEnd(40, '0'), changedAt },
  };
}
