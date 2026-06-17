/**
 * Shared in-memory ADO fake for API builder tests. Mirrors the FakeAdoClient in
 * grid.test.ts so each builder test can stand up a real WarmStore from fixtures.
 */
import { WarmStore } from '../src/engine/warm-store.ts';
import { FLAG_SCOPE_PATH } from '../src/engine/flag-discovery.ts';
import type { AdoClient, AdoCommit, AdoItem, VersionDescriptor } from '../src/engine/ado-client.ts';

export interface FlagSpec {
  id: string;
  commits: Array<{
    commitId: string;
    date: string;
    comment?: string;
    envs: Record<string, unknown>;
    description?: string;
  }>;
}

export class FakeAdoClient implements AdoClient {
  private readonly byPath = new Map<string, FlagSpec>();

  constructor(specs: FlagSpec[]) {
    for (const s of specs) this.byPath.set(`${FLAG_SCOPE_PATH}/${s.id}.json`, s);
  }

  async listItems(_scopePath: string): Promise<AdoItem[]> {
    return [...this.byPath.keys()].map((path) => ({ path, isFolder: false }));
  }

  async getPathCommits(path: string, _branch: string): Promise<AdoCommit[]> {
    const spec = this.byPath.get(path)!;
    return [...spec.commits].reverse().map((c) => ({
      commitId: c.commitId,
      author: { name: 'dev', date: c.date },
      comment: c.comment ?? '',
    }));
  }

  async getContent(path: string, version: VersionDescriptor): Promise<string> {
    const spec = this.byPath.get(path)!;
    const c = spec.commits.find((x) => x.commitId === version.version)!;
    return JSON.stringify({ Id: spec.id, Description: c.description ?? `${spec.id} desc`, Environments: c.envs });
  }
}

/** 40-char commit id from a short seed. */
export function cid(seed: string): string {
  return seed.padEnd(40, '0');
}

export async function builtStore(specs: FlagSpec[]): Promise<WarmStore> {
  const store = new WarmStore();
  await store.build(new FakeAdoClient(specs));
  return store;
}
