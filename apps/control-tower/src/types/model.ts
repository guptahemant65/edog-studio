/**
 * F30 Control Tower — Canonical data model.
 *
 * SINGLE SOURCE OF TRUTH for shared types, enums, and environment groupings.
 * Mirrors docs/specs/features/F30-control-tower/data-model.md VERBATIM.
 * Where this file and a component spec diverge, data-model.md supersedes.
 */

// ── 1. CellState ────────────────────────────────────────────────────────────
// No abbreviated tokens. Always 'conditional' / 'targeted' — never 'cond' / 'target'.
export type CellState = 'off' | 'on' | 'conditional' | 'targeted';

/** A FeatureManagement per-environment block, e.g. { Enabled: true } or { Requires: [...] }. */
export type EnvBlock = Record<string, unknown>;

// ── 2. Environment model ────────────────────────────────────────────────────
/** Full set, canonical order (15). */
export const CANONICAL_15_ENVS = [
  'onebox', 'test', 'cst', 'daily', 'dxt', 'msit', 'prod',
  'mc', 'gcc', 'gcchigh', 'dod', 'usnat', 'ussec', 'bleu', 'usgovcanary',
] as const;
export type EnvKey = (typeof CANONICAL_15_ENVS)[number];

/** The promotion spine (6). onebox is NOT on the ladder. */
export const LADDER_ENVS = ['test', 'cst', 'daily', 'dxt', 'msit', 'prod'] as const;
export type LadderEnv = (typeof LADDER_ENVS)[number];

/** Sovereign clouds (7). bleu is NOT sovereign. */
export const SOVEREIGN_ENVS = ['mc', 'gcc', 'gcchigh', 'dod', 'usnat', 'ussec', 'usgovcanary'] as const;

/** Mainline (7) — onebox through prod. Used by C06 stale-reason derivation. */
export const MAINLINE_ENVS = ['onebox', 'test', 'cst', 'daily', 'dxt', 'msit', 'prod'] as const;

// ── 3. Attribution ──────────────────────────────────────────────────────────
export interface Attribution {
  /** git commit author display name; null when unknown. */
  author: string | null;
  /** from "Merged PR NNNNNNN" in merge-commit message; null when absent. */
  prNumber: number | null;
  /** full 40-char SHA; UI truncates to 7 for display. */
  commitId: string;
  /** ISO-8601 timestamp of the change. */
  changedAt: string;
}

// ── 4. StaleReason ──────────────────────────────────────────────────────────
// Derivation is canonical in C06 §4.3 — do not redefine here.
export type StaleReason =
  | 'PROBABLY_LAUNCHED'
  | 'PROBABLY_DEAD'
  | 'PROBABLY_FORGOTTEN'
  | 'ACTIVE_ROLLOUT'
  | null;

// ── 6. API prefix ───────────────────────────────────────────────────────────
export const API_PREFIX = '/api/ct';
