/**
 * Sovereign gap analysis (architecture §5.4, canonical in C07 §2.2).
 *
 * For each (flag, sovereignEnv) pair the cloud cell state is compared to prod and
 * classified into a GapKind. The mapping is verbatim from the spec — no inference.
 */
import { SOVEREIGN_ENVS, type CellState } from '../types/model.ts';
import type { EnvStates } from './current-state.ts';

export type GapKind =
  | 'prod_on_cloud_off'
  | 'prod_on_cloud_cond'
  | 'prod_on_cloud_target'
  | 'prod_cond_cloud_off'
  | 'prod_target_cloud_off'
  | 'cloud_on_prod_off'
  | 'cloud_on_prod_cond'
  | 'cloud_cond_prod_off';

const GAP_MAP: Record<string, GapKind> = {
  on_off: 'prod_on_cloud_off',
  on_conditional: 'prod_on_cloud_cond',
  on_targeted: 'prod_on_cloud_target',
  conditional_off: 'prod_cond_cloud_off',
  targeted_off: 'prod_target_cloud_off',
  off_on: 'cloud_on_prod_off',
  conditional_on: 'cloud_on_prod_cond',
  off_conditional: 'cloud_cond_prod_off',
};

/** Classify the gap between prod and a sovereign cloud. null = aligned / no gap. */
export function classifyGap(prodState: CellState, cloudState: CellState): GapKind | null {
  if (prodState === cloudState) return null;
  if (prodState === 'off' && cloudState === 'off') return null;
  return GAP_MAP[`${prodState}_${cloudState}`] ?? null;
}

export interface SovereignGap {
  env: (typeof SOVEREIGN_ENVS)[number];
  cloudState: CellState;
  prodState: CellState;
  gap: GapKind | null;
}

/** All 7 sovereign cells for one flag, each classified against its prod state. */
export function sovereignGaps(states: EnvStates): SovereignGap[] {
  const prodState = states.prod;
  return SOVEREIGN_ENVS.map((env) => ({
    env,
    cloudState: states[env],
    prodState,
    gap: classifyGap(prodState, states[env]),
  }));
}
