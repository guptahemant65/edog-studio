/**
 * Sovereign-lens response builder (architecture §7 endpoint 12, §5.4, C07 §2.2).
 *
 * For each flag, classifies all 7 sovereign cloud cells against its prod state and
 * aggregates the gaps by GapKind so the lens can rank "where are we diverging?".
 */
import { currentStates } from '../engine/current-state.ts';
import { sovereignGaps, type SovereignGap, type GapKind } from '../engine/sovereign.ts';
import { responseMeta, type ResponseMeta } from './meta.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export interface SovereignFlagGaps {
  flagId: string;
  gaps: SovereignGap[];
  /** number of clouds (of 7) that diverge from prod. */
  gapCount: number;
}

export interface SovereignLensResponse {
  flags: SovereignFlagGaps[];
  /** count of each GapKind across every (flag, cloud) pair. */
  byKind: Record<GapKind, number>;
  totalGaps: number;
  meta: ResponseMeta;
}

const GAP_KINDS: GapKind[] = [
  'prod_on_cloud_off',
  'prod_on_cloud_cond',
  'prod_on_cloud_target',
  'prod_cond_cloud_off',
  'prod_target_cloud_off',
  'cloud_on_prod_off',
  'cloud_on_prod_cond',
  'cloud_cond_prod_off',
];

export function buildSovereignLensResponse(store: WarmStore, now: number = Date.now()): SovereignLensResponse {
  const snapshot = store.current();
  const vintages = snapshot ? [...snapshot.flags.values()] : [];

  const byKind = Object.fromEntries(GAP_KINDS.map((k) => [k, 0])) as Record<GapKind, number>;
  let totalGaps = 0;

  const flags: SovereignFlagGaps[] = vintages
    .map((v) => {
      const gaps = sovereignGaps(currentStates(v.events));
      let gapCount = 0;
      for (const g of gaps) {
        if (g.gap !== null) {
          gapCount += 1;
          totalGaps += 1;
          byKind[g.gap] += 1;
        }
      }
      return { flagId: v.flagId, gaps, gapCount };
    })
    .sort((a, b) => b.gapCount - a.gapCount || a.flagId.localeCompare(b.flagId));

  return { flags, byKind, totalGaps, meta: responseMeta(store, now) };
}
