/**
 * Server-side tunables (architecture §5.1, C06 §8.1 Q3).
 *
 * Thresholds ship as initial values and live here — not inline in logic — so PMs
 * can tune the stale-reason classifier without touching derivation code.
 */
export interface StaleThresholds {
  activeRolloutDays: number;
  probablyDeadDays: number;
  probablyLaunchedDays: number;
  probablyForgottenDays: number;
}

export const STALE_THRESHOLDS: StaleThresholds = {
  activeRolloutDays: 30,
  probablyDeadDays: 90,
  probablyLaunchedDays: 90,
  probablyForgottenDays: 180,
};
