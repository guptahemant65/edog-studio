/**
 * Client-safe view-model for the Rollout Tracker SPA.
 *
 * Pure derivations from the grid payload (GridRow[]) into the shapes the mock's
 * render functions consume. Every number here is derived from real warm-store
 * data — no fabrication. State tokens are mapped to the mock's vocabulary
 * (conditional -> cond, targeted -> target) so the locked CSS classes apply
 * verbatim.
 */

export type CellState = 'off' | 'on' | 'conditional' | 'targeted';
export type CellTok = 'off' | 'on' | 'cond' | 'target';

export const ENV_ORDER = [
  'onebox', 'test', 'cst', 'daily', 'dxt', 'msit', 'prod',
  'mc', 'gcc', 'gcchigh', 'dod', 'usnat', 'ussec', 'bleu', 'usgovcanary',
] as const;
export type EnvKey = (typeof ENV_ORDER)[number];

export const ENV_LABELS: Record<string, string> = {
  onebox: 'Onebox', test: 'Test', cst: 'CST', daily: 'Daily', dxt: 'DXT', msit: 'MSIT', prod: 'Prod',
  mc: 'Mooncake', gcc: 'GCC', gcchigh: 'GCC-High', dod: 'DoD', usnat: 'USNat', ussec: 'USSec',
  bleu: 'Bleu', usgovcanary: 'USGovCanary',
};

export const RUNGS = ['test', 'cst', 'daily', 'dxt', 'msit', 'prod'] as const;
export const RUNGL = ['Test', 'CST', 'Daily', 'DXT', 'MSIT', 'Prod'] as const;
export const SOV = ['mc', 'gcc', 'gcchigh', 'dod', 'usnat', 'ussec', 'usgovcanary'] as const;

export const SMETA: Record<CellTok, string> = { on: 'on', off: 'off', cond: 'cond', target: 'targ' };

export function tok(s: CellState): CellTok {
  return s === 'conditional' ? 'cond' : s === 'targeted' ? 'target' : (s as CellTok);
}
export function scl(s: CellState | CellTok): string {
  const t = s === 'conditional' ? 'cond' : s === 'targeted' ? 'target' : s;
  return 's-' + t;
}
export const short = (id: string): string => id.replace(/^FLT/, '');

// ── Inbound payloads (mirror the server builder shapes) ───────────────────────

export interface Attribution {
  author: string | null;
  prNumber: number | null;
  commitId: string;
  changedAt: string;
}

export interface GridRowDTO {
  flagId: string;
  description: string;
  states: Record<string, CellState>;
  lastChange: Attribution | null;
  daysSinceLastChange: number | null;
  staleReason: string | null;
  layer: 'ladder' | 'sovereign' | 'other';
}

export interface GridMetaDTO {
  syncedAt: string | null;
  headCommitId: string | null;
  isStale: boolean;
  status: 'ok' | 'failed' | 'empty';
  flagCount: number;
}

export interface InertNote {
  needs: string;
  note: string;
}

export interface InitialData {
  flags: GridRowDTO[];
  meta: GridMetaDTO;
  inert: Record<string, InertNote>;
}

// ── Per-flag view-model ───────────────────────────────────────────────────────

export type ProdPosture = 'ga' | 'cond' | 'targeted' | 'notprod';
export type AgeBucket = 'fresh' | 'recent' | 'aging' | 'stale' | 'dormant';

export interface FlagVM {
  id: string;
  description: string;
  env: Record<string, CellTok>;
  lad: CellTok[];
  hi: number;
  stage: string;
  stageState: CellTok;
  sovOn: number;
  mix: Record<CellTok, number>;
  nonOff: number;
  distinct: number;
  prodPosture: ProdPosture;
  ageBucket: AgeBucket;
  dwell: number;
  lastChangeDays: number | null;
  lastDateISO: string | null;
  author: string;
  pr: number | null;
  dep: InertNote | null;
}

const cleanAuthor = (n: string | null): string => (n ?? 'unknown').replace(/\s*\([^)]*\)\s*$/, '').trim();

export function toVM(row: GridRowDTO, inert: Record<string, InertNote>): FlagVM {
  const env: Record<string, CellTok> = {};
  for (const e of ENV_ORDER) env[e] = tok(row.states[e] ?? 'off');

  const lad = RUNGS.map((r) => env[r] ?? 'off');
  let hi = -1;
  RUNGS.forEach((r, i) => {
    if ((env[r] ?? 'off') !== 'off') hi = i;
  });
  const stage = hi < 0 ? 'staging' : RUNGS[hi]!;
  const stageState: CellTok = hi < 0 ? 'off' : lad[hi]!;
  const sovOn = SOV.filter((s) => (env[s] ?? 'off') !== 'off').length;

  const mix: Record<CellTok, number> = { on: 0, cond: 0, target: 0, off: 0 };
  for (const e of ENV_ORDER) mix[env[e] ?? 'off']++;
  const nonOff = mix.on + mix.cond + mix.target;
  const distinct = (['on', 'cond', 'target'] as CellTok[]).filter((s) => mix[s] > 0).length;

  const days = row.daysSinceLastChange;
  const ps = env.prod ?? 'off';
  const prodPosture: ProdPosture = ps === 'on' ? 'ga' : ps === 'cond' ? 'cond' : ps === 'target' ? 'targeted' : 'notprod';
  const ageBucket: AgeBucket =
    hi < 0 || days === null ? 'dormant' : days < 30 ? 'fresh' : days < 90 ? 'recent' : days < 180 ? 'aging' : 'stale';
  const dwell = days ?? 0;
  const stalled = hi >= 0 && hi < 5 && dwell >= 30;

  return {
    id: row.flagId,
    description: row.description,
    env,
    lad,
    hi,
    stage,
    stageState,
    sovOn,
    mix,
    nonOff,
    distinct,
    prodPosture,
    ageBucket,
    dwell,
    lastChangeDays: days,
    lastDateISO: row.lastChange?.changedAt ?? null,
    author: cleanAuthor(row.lastChange?.author ?? null),
    pr: row.lastChange?.prNumber ?? null,
    dep: inert[row.flagId] ?? null,
  };
}

// `stalled` recomputed where needed (kept out of FlagVM to mirror mock filter logic).
export const isStalled = (f: FlagVM): boolean => f.hi >= 0 && f.hi < 5 && f.dwell >= 30;

// ── Aggregate derivations ─────────────────────────────────────────────────────

export interface Briefing {
  inProd: number;
  preProd: number;
  stalledN: number;
  sovGapFlags: number;
  sovGaps: number;
  sovCovered: number;
}

export function briefing(flags: FlagVM[]): Briefing {
  const inProd = flags.filter((f) => f.hi === 5).length;
  const preProd = flags.filter((f) => f.hi >= 0 && f.hi < 5).length;
  const stalledN = flags.filter(isStalled).length;
  let sovGaps = 0;
  for (const f of flags) if (f.hi === 5) sovGaps += SOV.filter((s) => (f.env[s] ?? 'off') === 'off').length;
  const sovCovered = flags.filter((f) => f.sovOn > 0).length;
  const sovGapFlags = flags.filter((f) => f.hi === 5 && f.sovOn < 7).length;
  return { inProd, preProd, stalledN, sovGapFlags, sovGaps, sovCovered };
}

export const PIPE_ORDER = ['staging', 'test', 'cst', 'daily', 'dxt', 'msit', 'prod'] as const;

export interface PipeStation {
  key: string;
  parked: number;
  reached: number;
  cond: number;
  target: number;
}

export function pipeline(flags: FlagVM[]): { stations: PipeStation[]; total: number; inProd: number } {
  const parked: Record<string, number> = {};
  const cond: Record<string, number> = {};
  const target: Record<string, number> = {};
  for (const k of PIPE_ORDER) {
    parked[k] = 0;
    cond[k] = 0;
    target[k] = 0;
  }
  for (const f of flags) {
    parked[f.stage] = (parked[f.stage] ?? 0) + 1;
    if (f.stageState === 'cond') cond[f.stage] = (cond[f.stage] ?? 0) + 1;
    else if (f.stageState === 'target') target[f.stage] = (target[f.stage] ?? 0) + 1;
  }
  const N = PIPE_ORDER.length;
  const reach = (k: string): number => {
    const i = PIPE_ORDER.indexOf(k as (typeof PIPE_ORDER)[number]);
    let n = 0;
    for (let j = i; j < N; j++) n += parked[PIPE_ORDER[j]!]!;
    return n;
  };
  const stations = PIPE_ORDER.map((k) => ({ key: k, parked: parked[k]!, reached: reach(k), cond: cond[k]!, target: target[k]! }));
  return { stations, total: flags.length, inProd: flags.filter((f) => f.hi === 5).length };
}

export const POSTURE_ORDER: Array<[ProdPosture, string, string]> = [
  ['ga', 'fully on', '--neutral-sw'],
  ['cond', 'conditional', '--cond-sw'],
  ['targeted', 'targeted', '--target-sw'],
  ['notprod', 'not in prod', '--off-sw'],
];
export const AGE_ORDER: Array<[AgeBucket, string]> = [
  ['fresh', '< 30d'],
  ['recent', '30–90d'],
  ['aging', '90–180d'],
  ['stale', '180d+'],
  ['dormant', 'staging'],
];

export function postureCounts(flags: FlagVM[]): Array<[ProdPosture, string, string, number]> {
  return POSTURE_ORDER.map(([k, l, c]) => [k, l, c, flags.filter((f) => f.prodPosture === k).length]);
}
export function ageCounts(flags: FlagVM[]): Array<[AgeBucket, string, number]> {
  return AGE_ORDER.map(([k, l]) => [k, l, flags.filter((f) => f.ageBucket === k).length]);
}

export interface CellMix {
  on: number;
  cond: number;
  target: number;
  off: number;
  total: number;
}
export function cellMix(flags: FlagVM[]): CellMix {
  const m: Record<CellTok, number> = { on: 0, cond: 0, target: 0, off: 0 };
  for (const f of flags) for (const e of ENV_ORDER) m[f.env[e] ?? 'off']++;
  return { ...m, total: m.on + m.cond + m.target + m.off };
}
