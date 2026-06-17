/**
 * Stale-reason derivation (architecture §5.1, canonical in C06 §4.3).
 *
 * Classifies a flag's "health" from its current env states + days since last
 * change. Priority order is first-match-wins exactly as specified; do not reorder.
 */
import { CANONICAL_15_ENVS, MAINLINE_ENVS, type EnvKey, type StaleReason } from '../types/model.ts';
import type { EnvStates } from './current-state.ts';
import { STALE_THRESHOLDS, type StaleThresholds } from './config.ts';

export function deriveStaleReason(
  envStates: EnvStates,
  daysSinceLastChange: number | null,
  thresholds: StaleThresholds = STALE_THRESHOLDS,
): StaleReason {
  // No history (never changed) cannot be classified by age — treat as stable.
  if (daysSinceLastChange === null) return null;

  const mainlineOnCount = (MAINLINE_ENVS as readonly EnvKey[]).filter((e) => envStates[e] !== 'off').length;
  const allOffCount = (CANONICAL_15_ENVS as readonly EnvKey[]).filter((e) => envStates[e] === 'off').length;
  const hasPartialMainline = mainlineOnCount >= 1 && mainlineOnCount < MAINLINE_ENVS.length;

  // Priority order — first match wins (C06 §4.3).
  if (daysSinceLastChange < thresholds.activeRolloutDays && hasPartialMainline) return 'ACTIVE_ROLLOUT';
  if (allOffCount === CANONICAL_15_ENVS.length && daysSinceLastChange >= thresholds.probablyDeadDays) return 'PROBABLY_DEAD';
  if (mainlineOnCount === MAINLINE_ENVS.length && daysSinceLastChange >= thresholds.probablyLaunchedDays) return 'PROBABLY_LAUNCHED';
  if (hasPartialMainline && daysSinceLastChange >= thresholds.probablyForgottenDays) return 'PROBABLY_FORGOTTEN';
  return null; // STABLE — no label
}
