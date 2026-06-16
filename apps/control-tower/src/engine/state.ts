/**
 * State classification, semantic normalisation, and PR linkage.
 *
 * Implements architecture.md §3.3 (classifyState), §3.4.2 (normaliseBlock —
 * reformat-proofing, the R3 risk mitigation), and §3.4.3 (PR linkage).
 */
import type { CellState, EnvBlock } from '../types/model.ts';

/**
 * Classify a FeatureManagement env block into a CellState.
 * Precedence (architecture.md §3.3): Enabled wins, then Requires, then Targets.
 */
export function classifyState(block: EnvBlock | undefined | null): CellState {
  if (!block) return 'off';
  if (block.Enabled === true) return 'on';
  const requires = block.Requires;
  if (Array.isArray(requires) && requires.length > 0) return 'conditional';
  const targets = block.Targets;
  if (targets !== undefined && targets !== null) return 'targeted';
  return 'off';
}

/** Recursively sort object keys so structurally-equal blocks stringify identically. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    return Object.keys(src)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep(src[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Canonical string form of an env block for deep-equality comparison.
 * Neutralises whitespace, key reordering, and trailing-comma reformatting so
 * cosmetic commits never produce false attribution changes (architecture.md §3.4.2).
 * An absent block normalises identically to {} — i.e. 'off'.
 */
export function normaliseBlock(block: EnvBlock | undefined | null): string {
  return JSON.stringify(sortKeysDeep(block ?? {}));
}

/** Extract the merged-PR number from a commit message, or null. */
export function extractPR(commitMessage: string): number | null {
  const match = commitMessage.match(/Merged PR (\d+)/i);
  return match && match[1] ? parseInt(match[1], 10) : null;
}

/** Build the ADO pull-request deep link for a PR number. */
export function buildPrUrl(prNumber: number): string {
  return `https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/pullrequest/${prNumber}`;
}
