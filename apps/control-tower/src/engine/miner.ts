/**
 * Attribution miner — the consecutive-commit semantic-diff engine.
 *
 * Reconstructs WHO changed WHICH environment, WHEN, and via which PR by diffing
 * the `Environments` block between consecutive commits of a flag file.
 * Implements architecture.md §3.4.1. Uses semantic diff (normaliseBlock), never
 * line-`git blame`, so reformatting commits never produce false attribution.
 */
import { CANONICAL_15_ENVS, type Attribution, type CellState, type EnvBlock, type EnvKey } from '../types/model.ts';
import { classifyState, extractPR, normaliseBlock } from './state.ts';

/** A single commit of a flag file, as delivered by the ADO layer (decoupled from HTTP). */
export interface FlagCommit {
  commitId: string;
  author: string | null;
  /** ISO-8601 commit (author) date. */
  date: string;
  /** Commit message — parsed for "Merged PR NNN". */
  comment: string;
  /** Raw file content (JSON string) at this commit. */
  rawJson: string;
}

export interface ParsedFlagContent {
  id: string;
  description: string;
  environments: Record<string, EnvBlock>;
  rawJson: string;
}

export interface FileCreationEvent {
  kind: 'creation';
  flagId: string;
  attribution: Attribution;
}

export interface AttributionEvent {
  kind: 'transition';
  flagId: string;
  env: EnvKey;
  prevState: CellState;
  currState: CellState;
  attribution: Attribution;
}

export type MineEvent = FileCreationEvent | AttributionEvent;

/** Parse a flag file's raw JSON into id/description/environments. Tolerant of missing keys. */
export function parseFlagContent(rawJson: string): ParsedFlagContent {
  const obj = JSON.parse(rawJson) as Record<string, unknown>;
  const environments = (obj.Environments ?? {}) as Record<string, EnvBlock>;
  return {
    id: typeof obj.Id === 'string' ? obj.Id : '',
    description: typeof obj.Description === 'string' ? obj.Description : '',
    environments,
    rawJson,
  };
}

/**
 * Mine attribution events for a single flag from its commit history.
 * @param flagId  the flag identifier (e.g. "FLTArtifactBasedThrottling").
 * @param commits ordered OLDEST-FIRST. The first commit is treated as file creation.
 */
export function mineFlag(flagId: string, commits: FlagCommit[]): MineEvent[] {
  const events: MineEvent[] = [];
  let prevEnvs: Record<string, EnvBlock> = {};

  commits.forEach((commit, i) => {
    const currEnvs = parseFlagContent(commit.rawJson).environments;
    const attribution: Attribution = {
      author: commit.author,
      prNumber: extractPR(commit.comment),
      commitId: commit.commitId,
      changedAt: commit.date,
    };

    if (i === 0) {
      events.push({ kind: 'creation', flagId, attribution });
      prevEnvs = {}; // everything in the creation commit is "new"
    }

    for (const env of CANONICAL_15_ENVS) {
      const prevBlock = prevEnvs[env];
      const currBlock = currEnvs[env];
      // Semantic diff: only a real (non-cosmetic) change emits an event.
      if (normaliseBlock(prevBlock) === normaliseBlock(currBlock)) continue;
      events.push({
        kind: 'transition',
        flagId,
        env,
        prevState: classifyState(prevBlock),
        currState: classifyState(currBlock),
        attribution,
      });
    }

    prevEnvs = currEnvs;
  });

  return events;
}
