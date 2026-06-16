/**
 * ADO REST client for the FeatureManagement git repo (architecture §3.1).
 *
 * The `AdoClient` interface decouples the data engine from HTTP so the
 * orchestration layer (flag-discovery, repository) is fully testable with a fake.
 * `HttpAdoClient` is the real, fetch-based implementation.
 */
import { fetchWithRetry, type RetryOptions } from './concurrency.ts';

export interface VersionDescriptor {
  versionType: 'branch' | 'commit';
  /** 'master' for a branch, or a full 40-char SHA for a commit. */
  version: string;
}

export interface AdoItem {
  path: string;
  isFolder: boolean;
  objectId?: string;
}

export interface AdoCommitAuthor {
  name: string;
  email?: string;
  /** ISO-8601. */
  date: string;
}

export interface AdoCommit {
  commitId: string;
  author: AdoCommitAuthor;
  comment: string;
}

export interface AdoClient {
  /** List items one level under a scope path. */
  listItems(scopePath: string): Promise<AdoItem[]>;
  /** Raw file content at a specific branch or commit. */
  getContent(path: string, version: VersionDescriptor): Promise<string>;
  /** Commit history for a file path on a branch (newest-first, as ADO returns it). */
  getPathCommits(path: string, branch: string): Promise<AdoCommit[]>;
}

const DEFAULT_BASE =
  'https://dev.azure.com/powerbi/Power%20BI/_apis/git/repositories/FeatureManagement';
const API_VERSION = '7.1';

export interface HttpAdoClientOptions {
  baseUrl?: string;
  retry?: RetryOptions;
  fetchImpl?: typeof fetch;
}

export class HttpAdoClient implements AdoClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly retry: RetryOptions;

  constructor(
    /** The signed-in user's ADO access token (server-side only — never sent to the browser). */
    accessToken: string,
    options: HttpAdoClientOptions = {},
  ) {
    this.accessToken = accessToken;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.retry = { ...options.retry, fetchImpl: options.fetchImpl ?? options.retry?.fetchImpl };
  }

  private headers(accept: string): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, Accept: accept };
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetchWithRetry(url, { headers: this.headers('application/json') }, this.retry);
    if (!res.ok) {
      throw new Error(`ADO ${res.status} ${res.statusText} for ${url}`);
    }
    return (await res.json()) as T;
  }

  async listItems(scopePath: string): Promise<AdoItem[]> {
    const url =
      `${this.baseUrl}/items?scopePath=${encodeURIComponent(scopePath)}` +
      `&recursionLevel=OneLevel&versionDescriptor.version=master` +
      `&versionDescriptor.versionType=branch&api-version=${API_VERSION}`;
    const body = await this.getJson<{ value: Array<{ path: string; isFolder?: boolean; objectId?: string }> }>(url);
    return body.value.map((i) => ({ path: i.path, isFolder: i.isFolder ?? false, objectId: i.objectId }));
  }

  async getContent(path: string, version: VersionDescriptor): Promise<string> {
    const url =
      `${this.baseUrl}/items?path=${encodeURIComponent(path)}` +
      `&versionDescriptor.version=${encodeURIComponent(version.version)}` +
      `&versionDescriptor.versionType=${version.versionType}` +
      `&includeContent=true&$format=text&api-version=${API_VERSION}`;
    const res = await fetchWithRetry(url, { headers: this.headers('text/plain') }, this.retry);
    if (!res.ok) {
      throw new Error(`ADO ${res.status} ${res.statusText} for ${url}`);
    }
    return res.text();
  }

  async getPathCommits(path: string, branch: string): Promise<AdoCommit[]> {
    const url =
      `${this.baseUrl}/commits?searchCriteria.itemPath=${encodeURIComponent(path)}` +
      `&searchCriteria.itemVersion.version=${encodeURIComponent(branch)}` +
      `&searchCriteria.itemVersion.versionType=branch&api-version=${API_VERSION}`;
    const body = await this.getJson<{ value: AdoCommit[] }>(url);
    return body.value;
  }
}
