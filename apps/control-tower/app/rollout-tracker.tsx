'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type InitialData,
  type FlagVM,
  type CellTok,
  type ProdPosture,
  type AgeBucket,
  type Attribution,
  type CellState,
  toVM,
  briefing,
  pipeline,
  postureCounts,
  ageCounts,
  cellMix,
  isStalled,
  scl,
  tok,
  SMETA,
  RUNGS,
  RUNGL,
  SOV,
  ENV_ORDER,
  ENV_LABELS,
  PIPE_ORDER,
  POSTURE_ORDER,
  AGE_ORDER,
} from './view-model';

const PR_BASE = 'https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/pullrequest/';
const COMMIT_BASE = 'https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/commit/';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtMonthYear(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
function agoTxt(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface Filter {
  mode: 'all' | 'prod' | 'preprod' | 'stalled' | 'sov';
  rung: string | null;
  posture: ProdPosture | null;
  age: AgeBucket | null;
}
const MODE_LABEL: Record<string, string> = { prod: 'In prod', preprod: 'Pre-prod', stalled: 'Stalled', sov: 'Sovereign gaps' };

type SortKey = 'id' | 'hi' | 'prod' | 'nonOff' | 'dwell' | 'lastDate';

// ── dossier (drawer) payload ──────────────────────────────────────────────────
interface TimelineEntry {
  eventId: string;
  env: string | null;
  kind: 'creation' | 'transition';
  prevState: CellState | null;
  currState: CellState | null;
  action: string;
  displayLabel: string;
  attribution: Attribution;
  prUrl: string | null;
}
interface RungDwell {
  rung: string;
  firstEnabled: string;
  dwellDays: number;
  dwellLabel: string;
  isCurrent: boolean;
}
interface DossierData {
  found: boolean;
  flagId: string;
  description: string;
  states: Record<string, CellState>;
  timeline: TimelineEntry[];
  dwell: RungDwell[];
  timeToProdDays: number | null;
  lastChange: Attribution | null;
  daysSinceLastChange: number | null;
  staleReason: string | null;
  layer: string;
}

export default function RolloutTracker({ initial }: { initial: InitialData }) {
  const baseFlags = useMemo(() => initial.flags.map((r) => toVM(r, initial.inert)), [initial]);

  const [filter, setFilter] = useState<Filter>({ mode: 'all', rung: null, posture: null, age: null });
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: number }>({ key: 'hi', dir: -1 });
  const [view, setView] = useState<'grid' | 'ladder'>('grid');
  const [selId, setSelId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [clock, setClock] = useState('--:--');
  const [now, setNow] = useState(() => Date.now());

  // as-of time travel
  const [asofDays, setAsofDays] = useState(0);
  const [asofLabel, setAsofLabel] = useState('now');
  const [asofOpen, setAsofOpen] = useState(false);
  const [histFlags, setHistFlags] = useState<FlagVM[] | null>(null);

  // drawer dossier
  const [dossier, setDossier] = useState<DossierData | null>(null);
  const [dossierLoading, setDossierLoading] = useState(false);

  // palette
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteCur, setPaletteCur] = useState(0);
  const paletteInputRef = useRef<HTMLInputElement>(null);

  // toast
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((html: string) => {
    setToast(html);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }, []);

  const flags = histFlags ?? baseFlags;

  // ── theme on <html> ──
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // ── clock + freshness tick ──
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(`${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`);
      setNow(Date.now());
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── global keys ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
        setSelId(null);
        setAsofOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── close as-of on outside click ──
  useEffect(() => {
    if (!asofOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.asof-ctl')) setAsofOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [asofOpen]);

  // ── derived aggregates ──
  const brief = useMemo(() => briefing(flags), [flags]);
  const pipe = useMemo(() => pipeline(flags), [flags]);
  const postures = useMemo(() => postureCounts(flags), [flags]);
  const ages = useMemo(() => ageCounts(flags), [flags]);
  const cells = useMemo(() => cellMix(baseFlags), [baseFlags]);

  // ── filtering ──
  const filtered = useMemo(() => {
    let r = flags.slice();
    if (filter.rung) r = r.filter((f) => f.stage === filter.rung);
    if (filter.mode === 'stalled') r = r.filter(isStalled);
    else if (filter.mode === 'sov') r = r.filter((f) => f.hi === 5 && f.sovOn < 7);
    else if (filter.mode === 'preprod') r = r.filter((f) => f.hi >= 0 && f.hi < 5);
    else if (filter.mode === 'prod') r = r.filter((f) => f.hi === 5);
    if (filter.posture) r = r.filter((f) => f.prodPosture === filter.posture);
    if (filter.age) r = r.filter((f) => f.ageBucket === filter.age);
    if (search) {
      const q = search.toLowerCase();
      r = r.filter((f) => f.id.toLowerCase().includes(q));
    }
    return r;
  }, [flags, filter, search]);

  const sortedRows = useMemo(() => {
    const k = sort.key;
    const d = sort.dir;
    const rows = filtered.slice();
    rows.sort((a, b) => {
      if (k === 'id' || k === 'prod') {
        const va = k === 'id' ? a.id : a.env.prod ?? 'off';
        const vb = k === 'id' ? b.id : b.env.prod ?? 'off';
        return va < vb ? d : va > vb ? -d : 0;
      }
      let va: number;
      let vb: number;
      if (k === 'lastDate') {
        va = a.lastDateISO ? new Date(a.lastDateISO).getTime() : 0;
        vb = b.lastDateISO ? new Date(b.lastDateISO).getTime() : 0;
      } else {
        va = (a[k] as number) ?? 0;
        vb = (b[k] as number) ?? 0;
      }
      return (va - vb) * d || a.id.localeCompare(b.id);
    });
    return rows;
  }, [filtered, sort]);

  // ── actions ──
  const refreshFilter = (next: Partial<Filter>) => setFilter((f) => ({ ...f, ...next }));
  const applyLead = (mode: Filter['mode']) =>
    setFilter((f) => ({ ...f, mode: f.mode === mode ? 'all' : mode, rung: null }));
  const applyRung = (k: string) => setFilter((f) => ({ ...f, rung: f.rung === k ? null : k, mode: 'all' }));
  const toggleFacet = (dim: 'posture' | 'age', val: string) =>
    setFilter((f) => ({ ...f, [dim]: f[dim] === val ? null : val }) as Filter);
  const clearAllFilters = () => setFilter({ mode: 'all', rung: null, posture: null, age: null });
  const setSortKey = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir * -1 } : { key: k, dir: -1 }));

  const setAsof = useCallback(
    async (days: number, label: string) => {
      setAsofDays(days);
      setAsofLabel(label);
      setAsofOpen(false);
      if (days === 0) {
        setHistFlags(null);
        return;
      }
      const asof = new Date(Date.now() - days * 864e5).toISOString();
      try {
        const res = await fetch('/api/ct/time-travel/reconstruct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ asOf: asof }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { rows: Array<{ flagId: string; existed: boolean; states: Record<string, CellState> }> };
        const byId = new Map(initial.flags.map((r) => [r.flagId, r]));
        const vms = data.rows
          .filter((r) => r.existed)
          .map((r) => {
            const base = byId.get(r.flagId);
            return toVM(
              {
                flagId: r.flagId,
                description: base?.description ?? '',
                states: r.states,
                lastChange: null,
                daysSinceLastChange: null,
                staleReason: null,
                layer: 'other',
              },
              initial.inert,
            );
          });
        setHistFlags(vms);
        showToast(`Snapshot · ${label} · reconstructed from history`);
      } catch {
        setHistFlags(null);
        setAsofDays(0);
        setAsofLabel('now');
        showToast('Could not reconstruct that snapshot.');
      }
    },
    [initial, showToast],
  );

  // ── drawer ──
  const openDrawer = useCallback(
    async (id: string) => {
      setSelId(id);
      setDossier(null);
      setDossierLoading(true);
      try {
        const qs = asofDays > 0 ? `?asOf=${encodeURIComponent(new Date(Date.now() - asofDays * 864e5).toISOString())}` : '';
        const res = await fetch(`/api/ct/flag/${encodeURIComponent(id)}/dossier${qs}`);
        if (!res.ok) throw new Error(String(res.status));
        setDossier((await res.json()) as DossierData);
      } catch {
        setDossier(null);
      } finally {
        setDossierLoading(false);
      }
    },
    [asofDays],
  );
  const closeDrawer = () => {
    setSelId(null);
    setDossier(null);
  };

  // ── palette ──
  const surfaces: Array<{ t: string; ico: string; s: string }> = [{ t: 'Rollout Tracker', ico: '◎', s: 'workspace' }];
  const paletteItems = useMemo(() => {
    const q = paletteQuery.toLowerCase();
    const surf = surfaces
      .filter((s) => s.t.toLowerCase().includes(q))
      .map((s) => ({ type: 'surface' as const, t: s.t, ico: s.ico, s: s.s, id: '', st: '' as CellTok | '' }));
    const fl = flags
      .filter((f) => f.id.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({
        type: 'flag' as const,
        t: f.id,
        ico: '◆',
        s: `${f.hi < 0 ? 'staging' : RUNGL[f.hi]} · ${f.dwell}d`,
        id: f.id,
        st: f.stageState as CellTok,
      }));
    return [...surf, ...fl];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteQuery, flags]);

  const openPalette = () => {
    setPaletteOpen(true);
    setPaletteQuery('');
    setPaletteCur(0);
    setTimeout(() => paletteInputRef.current?.focus(), 40);
  };
  const runPalette = (i: number) => {
    const it = paletteItems[i];
    if (!it) return;
    setPaletteOpen(false);
    if (it.type === 'flag') void openDrawer(it.id);
    else if (it.t !== 'Rollout Tracker') showToast(`<b>${it.t}</b> — live in the full product`);
  };
  const paletteKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setPaletteOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setPaletteCur((c) => Math.min(c + 1, paletteItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setPaletteCur((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      runPalette(paletteCur);
    }
  };

  // ── active filter pill ──
  const activeParts: string[] = [];
  if (filter.rung) {
    const i = RUNGS.indexOf(filter.rung as (typeof RUNGS)[number]);
    activeParts.push(filter.rung === 'staging' || i < 0 ? 'Staging' : RUNGL[i]!);
  }
  if (filter.mode !== 'all') activeParts.push(MODE_LABEL[filter.mode] ?? filter.mode);
  if (filter.posture) activeParts.push(POSTURE_ORDER.find((p) => p[0] === filter.posture)?.[1] ?? filter.posture);
  if (filter.age) activeParts.push(AGE_ORDER.find((a) => a[0] === filter.age)?.[1] ?? filter.age);

  // ── recent movement ──
  const recent = useMemo(
    () => flags.filter((f) => f.lastChangeDays != null).sort((a, b) => a.lastChangeDays! - b.lastChangeDays!).slice(0, 6),
    [flags],
  );
  const moved30 = flags.filter((f) => f.lastChangeDays != null && f.lastChangeDays <= 30).length;

  // ── pipeline geometry ──
  const N = PIPE_ORDER.length;
  const total = pipe.total || 1;
  const xs = PIPE_ORDER.map((_, i) => +(5 + i * (90 / (N - 1))).toFixed(2));
  const hh = pipe.stations.map((st) => Math.max(3, (st.reached / total) * 23));
  let topPath = '';
  let botPath = '';
  xs.forEach((x, i) => {
    topPath += `${i ? 'L' : 'M'}${x},${(50 - hh[i]!).toFixed(2)} `;
  });
  for (let i = xs.length - 1; i >= 0; i--) botPath += `L${xs[i]},${(50 + hh[i]!).toFixed(2)} `;
  const pipePct = Math.round((pipe.inProd / total) * 100);

  // ── gauge ──
  const gaugePct = Math.round((brief.sovCovered / (flags.length || 1)) * 100);
  const gaugeC = 2 * Math.PI * 30;

  const maxP = Math.max(1, ...postures.map((a) => a[3]));
  const maxG = Math.max(1, ...ages.map((a) => a[2]));

  const syncedAt = initial.meta.syncedAt;
  const syncAgo = syncedAt ? agoTxt(now - new Date(syncedAt).getTime()) : '—';
  const headCommit = (initial.meta.headCommitId ?? '').slice(0, 7) || 'unknown';
  const asofText = asofDays > 0 ? `posture reconstructed @ ${fmtDate(new Date(Date.now() - asofDays * 864e5).toISOString())}` : 'posture as of now';

  // ── render helpers ──
  const prLink = (pr: number | null) =>
    pr == null ? <span className="muted">no PR</span> : (
      <a className="prlink" href={`${PR_BASE}${pr}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        PR {pr}
        <span className="ext">↗</span>
      </a>
    );

  const mixBar = (f: FlagVM) => {
    const segW = (n: number) => `${((n / 15) * 100).toFixed(2)}%`;
    return (
      <span className="mixwrap" title={`${f.mix.on} on · ${f.mix.cond} conditional · ${f.mix.target} targeted · ${f.mix.off} off`}>
        <span className="mixbar">
          {f.mix.on ? <i className="m-on" style={{ width: segW(f.mix.on) }} /> : null}
          {f.mix.cond ? <i className="m-cond" style={{ width: segW(f.mix.cond) }} /> : null}
          {f.mix.target ? <i className="m-target" style={{ width: segW(f.mix.target) }} /> : null}
        </span>
        {f.distinct >= 2 ? <span className="mixhet" title="runs mixed states across envs">◆</span> : null}
      </span>
    );
  };

  const Row = ({ f }: { f: FlagVM }) => {
    const frung = f.hi < 0 ? 'staging' : RUNGL[f.hi]!;
    const dwellTxt = f.dwell > 0 ? `${f.dwell}d` : '—';
    const prodTok = f.env.prod ?? 'off';
    return (
      <tr className={selId === f.id ? 'sel' : ''} onClick={() => void openDrawer(f.id)}>
        <td>
          <span className="oid">
            {f.dep ? <span className="depmark" title="dependency exposure">⊘</span> : null}
            {f.id}
          </span>
        </td>
        <td>
          <span className="lad">
            {f.lad.map((s, i) => (
              <span key={i} className={`lc ${scl(s)}`} title={`${RUNGL[i]}: ${s}`}>
                {RUNGL[i]![0]}
              </span>
            ))}
          </span>
        </td>
        <td>
          <span className={`pill ${scl(f.stageState)}`}>{frung}</span>
        </td>
        <td>
          <span className={`pill ${scl(prodTok)}`}>{prodTok === 'off' ? 'off' : SMETA[prodTok]}</span>
        </td>
        <td>{mixBar(f)}</td>
        <td>
          <span className={`dwell ${isStalled(f) ? 'hot' : 'cold'}`}>{dwellTxt}</span>
        </td>
        <td>
          <span className="lastby">
            {f.author}
            <br />
            <small>
              {fmtDate(f.lastDateISO)} · {prLink(f.pr)}
            </small>
          </span>
        </td>
      </tr>
    );
  };

  const COLS: Array<{ k: SortKey | 'lad'; l: string; nosort?: boolean }> = [
    { k: 'id', l: 'Flag' },
    { k: 'lad', l: 'Ladder', nosort: true },
    { k: 'hi', l: 'Stage' },
    { k: 'prod', l: 'Prod' },
    { k: 'nonOff', l: 'Spread' },
    { k: 'dwell', l: 'Dwell' },
    { k: 'lastDate', l: 'Last change' },
  ];

  const tableBody = () => {
    if (!sortedRows.length) {
      return (
        <tr className="tbl-empty">
          <td colSpan={COLS.length}>
            No flags match this filter.
            {search ? (
              <button className="empty-clear" onClick={() => setSearch('')}>
                clear search
              </button>
            ) : null}
          </td>
        </tr>
      );
    }
    if (view === 'ladder') {
      const byStage = sortedRows.slice().sort((a, b) => b.hi - a.hi);
      const out: React.ReactNode[] = [];
      let cur: number | undefined;
      byStage.forEach((f) => {
        if (f.hi !== cur) {
          cur = f.hi;
          const label = f.hi < 0 ? 'Staging — not yet promoted' : RUNGL[f.hi]!;
          const n = byStage.filter((x) => x.hi === cur).length;
          const sw = f.hi < 0 ? 'var(--text-4)' : f.hi === 5 ? '#86c8a0' : 'var(--accent-line)';
          out.push(
            <tr className="grp-row" key={`grp-${f.hi}`}>
              <td colSpan={COLS.length}>
                <span className="gbar" style={{ background: sw }} />
                {label}
                <span className="gcount">
                  {n} flag{n === 1 ? '' : 's'}
                </span>
              </td>
            </tr>,
          );
        }
        out.push(<Row key={f.id} f={f} />);
      });
      return out;
    }
    return sortedRows.map((f) => <Row key={f.id} f={f} />);
  };

  // ── dossier render ──
  const renderDossier = () => {
    if (dossierLoading) return <div className="dl-empty">Reconstructing dossier…</div>;
    if (!dossier || !dossier.found) return <div className="dl-empty">No dossier available for this flag.</div>;
    const d = dossier;
    const env: Record<string, CellTok> = {};
    for (const e of ENV_ORDER) env[e] = tok(d.states[e] ?? 'off');
    let hi = -1;
    RUNGS.forEach((r, i) => {
      if ((env[r] ?? 'off') !== 'off') hi = i;
    });
    const sovOn = SOV.filter((s) => (env[s] ?? 'off') !== 'off').length;
    const nonOff = ENV_ORDER.filter((e) => (env[e] ?? 'off') !== 'off').length;
    const stageState = hi < 0 ? 'off' : env[RUNGS[hi]!]!;
    const word: Record<string, string> = { on: 'fully on', cond: 'conditional', target: 'targeted', off: 'off' };
    const swv: Record<string, string> = { on: '--neutral-sw', cond: '--cond-sw', target: '--target-sw', off: '--off-sw' };

    // dwell map for promotion timeline
    const dwellByRung = new Map(d.dwell.map((x) => [x.rung, x]));
    const curRung = hi < 0 ? null : RUNGS[hi]!;
    const curDwell = curRung ? dwellByRung.get(curRung) : null;

    // latest timeline entry per env -> attribution ledger
    const latestByEnv = new Map<string, TimelineEntry>();
    for (const t of d.timeline) {
      if (t.env === null) continue;
      const prev = latestByEnv.get(t.env);
      if (!prev || t.attribution.changedAt > prev.attribution.changedAt) latestByEnv.set(t.env, t);
    }
    const reachedEnvs = ENV_ORDER.filter((e) => (env[e] ?? 'off') !== 'off');
    const offEnvs = ENV_ORDER.filter((e) => (env[e] ?? 'off') === 'off');
    const fillW = Math.max(0, hi);

    return (
      <>
        {/* posture line */}
        <div className="dposture">
          <span className="ppsw" style={{ background: `var(${swv[hi < 0 ? 'off' : stageState]})` }} />
          <div>
            {hi < 0 ? (
              <>
                Not yet promoted — still in <b>staging</b>. Touches <b>{nonOff}</b> of 15 environments.
              </>
            ) : (
              <>
                Furthest stage <b>{RUNGL[hi]}</b>, currently <b>{word[stageState]}</b> ·{' '}
                {curDwell && hi < 5 ? <b>{curDwell.dwellDays}d at this stage</b> : 'recently promoted'} · <b>{sovOn}/7</b> sovereign clouds live.
                {d.timeToProdDays != null ? (
                  <>
                    {' '}
                    Test→prod in <b>{d.timeToProdDays}d</b>.
                  </>
                ) : null}
              </>
            )}
            {d.lastChange ? (
              <>
                {' '}
                Last change by <b>{(d.lastChange.author ?? 'unknown').replace(/\s*\([^)]*\)\s*$/, '')}</b> · {fmtDate(d.lastChange.changedAt)} ·{' '}
                {prLink(d.lastChange.prNumber)}.
              </>
            ) : null}
          </div>
        </div>

        {/* promotion timeline */}
        <div className="ptl-wrap">
          <div className="ptl-cap">Promotion timeline · test → prod</div>
          <div className="ptl">
            <div className="ptl-base" />
            <div className="ptl-fill" style={{ width: `calc(83.33% * ${fillW} / 5)` }} />
            {RUNGS.map((r, i) => {
              const st = env[r] ?? 'off';
              const cls = st === 'off' ? 'off' : st;
              const dw = dwellByRung.get(r);
              return (
                <div key={r} className={`ptl-step ${cls} ${i === hi ? 'atstage' : ''}`}>
                  <div className="ptl-node" />
                  <div className="ptl-rl">{RUNGL[i]}</div>
                  <div className="ptl-rd">{dw ? fmtMonthYear(dw.firstEnabled) : '—'}</div>
                  <div className="ptl-dw">{i === hi && hi < 5 && dw ? `held ${dw.dwellDays}d` : ''}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* attribution ledger */}
        <div className="dgroup-label">Attribution ledger</div>
        {!reachedEnvs.length ? <div className="dl-empty">No environment has enabled this flag.</div> : null}
        {reachedEnvs.map((e) => {
          const st = env[e]!;
          const a = latestByEnv.get(e);
          const stWord = { on: 'on', cond: 'conditional', target: 'targeted', off: 'off' }[st];
          return (
            <div className="dl-row" key={e}>
              <span className={`dl-sw ${scl(st)}`} />
              <div className="dl-main">
                <div className="dl-top">
                  <span className="dl-env">{ENV_LABELS[e]}</span>
                  <span className={`dl-st pill ${scl(st)}`}>{stWord}</span>
                </div>
                <div className="dl-attr">
                  {a ? (
                    <>
                      {a.displayLabel.toLowerCase()} {(a.attribution.author ?? 'unknown').replace(/\s*\([^)]*\)\s*$/, '')} · {fmtDate(a.attribution.changedAt)} ·{' '}
                      {a.prUrl ? (
                        <a className="prlink" href={a.prUrl} target="_blank" rel="noopener noreferrer">
                          {a.attribution.prNumber ? `PR ${a.attribution.prNumber}` : 'commit'}
                          <span className="ext">↗</span>
                        </a>
                      ) : (
                        <a className="prlink" href={`${COMMIT_BASE}${a.attribution.commitId}`} target="_blank" rel="noopener noreferrer">
                          {a.attribution.commitId.slice(0, 7)}
                          <span className="ext">↗</span>
                        </a>
                      )}
                    </>
                  ) : (
                    'enabled · attribution unavailable'
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {offEnvs.length ? (
          <div className="dl-off-sum" onClick={(e) => e.currentTarget.classList.toggle('open')}>
            <span className="chev">▸</span>
            {offEnvs.length} environment{offEnvs.length === 1 ? '' : 's'} off
            <span className="dl-off-names">{offEnvs.map((e) => ENV_LABELS[e]).join(' · ')}</span>
          </div>
        ) : null}

        {/* sovereign strip */}
        <div className="dgroup-label">Sovereign coverage</div>
        <div className="dsov">
          <div className="dsov-dots">
            {SOV.map((s) => {
              const on = (env[s] ?? 'off') !== 'off';
              return <span key={s} className={`sov-dot ${on ? 'on' : ''}`} title={`${ENV_LABELS[s]}: ${on ? env[s] : 'off'}`} />;
            })}
          </div>
          <div className="dsov-txt">
            <b>{sovOn}/7</b> sovereign clouds enabled
          </div>
        </div>
      </>
    );
  };

  const selFlag = selId ? flags.find((f) => f.id === selId) : null;

  // ── briefing tiles config ──
  const LEADS: Array<{ label: string; ico: string; val: number; sub: string; pill: string; pc: string; pbg: string; mode: Filter['mode'] }> = [
    { label: 'Live in prod', ico: '●', val: brief.inProd, sub: 'furthest stage', pill: 'prod', pc: 'var(--neutral-ink)', pbg: 'var(--neutral-cell)', mode: 'prod' },
    { label: 'On the ladder', ico: '▸', val: brief.preProd, sub: 'pre-prod', pill: 'climbing', pc: 'var(--neutral-ink)', pbg: 'var(--neutral-cell)', mode: 'preprod' },
    { label: 'Stalled mid-ladder', ico: '◆', val: brief.stalledN, sub: '30d+ no advance', pill: 'attention', pc: 'var(--warn)', pbg: 'var(--warn-bg)', mode: 'stalled' },
    { label: 'Sovereign gaps', ico: '◈', val: brief.sovGapFlags, sub: `${brief.sovGaps} dark cells`, pill: `${brief.sovCovered} covered`, pc: 'var(--text-3)', pbg: 'var(--surface-3)', mode: 'sov' },
  ];

  return (
    <>
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">◉</div>
          <div className="crumb">
            <b>Aperture</b>
            <span className="sep">›</span>
            <span className="cur">Rollout Tracker</span>
          </div>
        </div>
        <div className="topbar-right">
          <span className="tstat">
            <span className="dot" />
            <b>{clock}</b> UTC
          </span>
          <span className="tstat">
            <b>{initial.meta.flagCount}</b> flags · <b>15</b> envs
          </span>
          <div className="asof-ctl">
            <button className={`asof-btn ${asofDays > 0 ? 'past' : ''}`} onClick={(e) => { e.stopPropagation(); setAsofOpen((o) => !o); }}>
              as of <b>{asofLabel}</b> ▾
            </button>
            <div className={`asof-pop ${asofOpen ? 'open' : ''}`}>
              <div className="ahd">Time travel · snapshot</div>
              {[
                [0, 'Now', 'live'],
                [7, '7 days ago', '−7d'],
                [30, '30 days ago', '−30d'],
                [90, '90 days ago', '−90d'],
              ].map(([days, lbl, small]) => (
                <div
                  key={days}
                  className={`asof-opt ${asofDays === days ? 'sel' : ''}`}
                  onClick={() => void setAsof(days as number, days === 0 ? 'now' : `${days}d ago`)}
                >
                  {lbl}
                  <small>{small}</small>
                </div>
              ))}
            </div>
          </div>
          <button className="searchbtn" onClick={openPalette}>
            <span>⌕</span>Search flags<kbd>⌘K</kbd>
          </button>
          <button className="theme-btn" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
            ◐
          </button>
        </div>
      </div>

      <div className="shell">
        <nav className="nav">
          <div className="nav-ico-btn active" data-tip="Rollout Tracker">
            <span>◎</span>
          </div>
          <div className="nav-sep" />
          <div className="legend-wrap">
            <div className="nav-ico-btn" data-tip="State vocabulary">
              <span>◧</span>
            </div>
            <div className="legend-pop">
              <div className="vocab-title">State Vocabulary</div>
              <div className="vocab-row">
                <i style={{ background: 'var(--off-sw)' }} />
                Off<span className="q">{'{}'}</span>
              </div>
              <div className="vocab-row">
                <i style={{ background: 'var(--neutral-sw)' }} />
                On<span className="q">true</span>
              </div>
              <div className="vocab-row">
                <i style={{ background: 'var(--cond-sw)' }} />
                Conditional<span className="q">Requires</span>
              </div>
              <div className="vocab-row">
                <i style={{ background: 'var(--target-sw)' }} />
                Targeted<span className="q">Targets</span>
              </div>
            </div>
          </div>
          <div className="nav-ico-btn" data-tip="System · live">
            <span className="nav-sys" />
          </div>
        </nav>

        <main className="content">
          <div className="sec-label">
            Situational Briefing<span className="right">{asofText}</span>
          </div>
          <div className="briefing">
            {LEADS.map((L) => (
              <div key={L.label} className={`lead ${filter.mode === L.mode ? 'active' : ''}`} onClick={() => applyLead(L.mode)}>
                <div className="lead-top">
                  <span>{L.label}</span>
                  <span className="lead-ico">{L.ico}</span>
                </div>
                <div className="lead-val">
                  {L.val}
                  <small>flags</small>
                </div>
                <div className="lead-sub">
                  <span className="pill" style={{ color: L.pc, background: L.pbg }}>
                    {L.pill}
                  </span>
                  {L.sub}
                </div>
              </div>
            ))}
          </div>

          <div className="sec-label">
            Rollout Stage
            <span className="right">{`${total} flags · ${pipe.inProd} reached prod (${pipePct}%)`}</span>
          </div>
          <div className="ribbon-card">
            <div className="pipe">
              <svg className="pipe-flow" viewBox="0 0 100 100" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="ppg" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="var(--neutral-cell)" stopOpacity=".58" />
                    <stop offset=".68" stopColor="var(--neutral-cell)" stopOpacity=".5" />
                    <stop offset="1" stopColor="var(--prod-cell)" stopOpacity=".5" />
                  </linearGradient>
                </defs>
                <path d={`${topPath}${botPath}Z`} fill="url(#ppg)" stroke="var(--border)" strokeWidth=".35" />
              </svg>
              {pipe.stations.map((st, i) => {
                const dim = filter.rung && filter.rung !== st.key ? 'dim' : '';
                const act = filter.rung === st.key ? 'active' : '';
                const node = st.parked ? (st.key === 'prod' ? 'prod' : '') : 'empty';
                const pips = [
                  ...Array(Math.min(st.cond, 3)).fill('cond'),
                  ...Array(Math.min(st.target, 3)).fill('target'),
                ];
                const tip = `${st.parked} parked at ${st.key} · ${st.reached} reached ${st.key}+`;
                return (
                  <div
                    key={st.key}
                    className={`pp-st ${dim} ${act} ${st.parked ? '' : 'empty'}`}
                    style={{ left: `${xs[i]}%` }}
                    title={tip}
                    onClick={st.parked ? () => applyRung(st.key) : undefined}
                  >
                    <div className={`pp-c ${st.parked ? '' : 'off'}`}>{st.parked}</div>
                    <div className={`pp-node ${node}`} />
                    {pips.length ? (
                      <div className="pp-pips">
                        {pips.map((c, j) => (
                          <span key={j} className={`pp-pip ${c}`} />
                        ))}
                      </div>
                    ) : null}
                    <div className="pp-l">{st.key}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="split">
            <div className="tbl-card">
              <div className="tbl-toolbar">
                <input
                  className="tbl-search"
                  type="text"
                  placeholder="Filter flags by name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="active-filter">
                  {activeParts.length ? (
                    <span className="afpill">
                      {activeParts.join(' · ')}
                      <span className="afn">{filtered.length}</span>
                      <button onClick={clearAllFilters} title="clear filter">
                        ✕
                      </button>
                    </span>
                  ) : null}
                </div>
                <div className="viewseg">
                  <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')}>
                    Grid
                  </button>
                  <button className={view === 'ladder' ? 'on' : ''} onClick={() => setView('ladder')}>
                    Ladder
                  </button>
                </div>
              </div>
              <div className="tbl-scroll">
                <table className="otable">
                  <thead>
                    <tr>
                      {COLS.map((c) => {
                        const sorted = sort.key === c.k;
                        const arr = sorted ? (sort.dir < 0 ? '▼' : '▲') : '';
                        return (
                          <th
                            key={c.k}
                            className={sorted ? 'sorted' : ''}
                            onClick={c.nosort ? undefined : () => setSortKey(c.k as SortKey)}
                          >
                            {c.l}
                            <span className="arr">{arr}</span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>{tableBody()}</tbody>
                </table>
              </div>
              <div className="tbl-foot">
                <span>{`${sortedRows.length} of ${flags.length} flags`}</span>
                <span>read-only · reconstructed from FeatureManagement @ master</span>
              </div>
            </div>

            <aside className="side">
              <div className="scard">
                <div className="scard-head">
                  Refine
                  {filter.posture || filter.age ? (
                    <button className="facet-clear" onClick={() => setFilter((f) => ({ ...f, posture: null, age: null }))}>
                      clear ✕
                    </button>
                  ) : null}
                </div>
                <div className="scard-body">
                  <div className="facet-grp">
                    <div className="facet-grp-l">By prod posture · GA readiness</div>
                    {postures.map(([k, l, c, n]) => (
                      <div key={k} className={`facet ${filter.posture === k ? 'on' : ''}`} onClick={() => toggleFacet('posture', k)}>
                        <span className="fdot" style={{ background: `var(${c})` }} />
                        <span className="fnm">{l}</span>
                        <span className="fbar">
                          <i style={{ width: `${Math.round((n / maxP) * 100)}%` }} />
                        </span>
                        <span className="fv">{n}</span>
                      </div>
                    ))}
                  </div>
                  <div className="facet-grp">
                    <div className="facet-grp-l">By age · time at current stage</div>
                    {ages.map(([k, l, n]) => (
                      <div key={k} className={`facet ${filter.age === k ? 'on' : ''}`} onClick={() => toggleFacet('age', k)}>
                        <span className="fnm pad">{l}</span>
                        <span className="fbar">
                          <i style={{ width: `${Math.round((n / maxG) * 100)}%` }} />
                        </span>
                        <span className="fv">{n}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="scard">
                <div className="scard-head">
                  Recent movement<span className="cnt">{`${moved30} moved · 30d`}</span>
                </div>
                <div className="scard-body" style={{ padding: '6px 4px' }}>
                  {recent.map((f) => {
                    const to = f.hi < 0 ? 'staging' : RUNGL[f.hi]!;
                    const from = f.hi <= 0 ? 'staging' : RUNGL[f.hi - 1]!;
                    const ago = f.lastChangeDays === 0 ? 'today' : `${f.lastChangeDays}d ago`;
                    return (
                      <div key={f.id} className="afeed-row" onClick={() => void openDrawer(f.id)}>
                        <div className="afeed-ico" style={{ color: 'var(--text-3)' }}>
                          ▲
                        </div>
                        <div className="afeed-main">
                          <div className="afeed-name">{f.id}</div>
                          <div className="afeed-meta">
                            {from} → {to}
                          </div>
                        </div>
                        <div className="afeed-d">{ago}</div>
                      </div>
                    );
                  })}
                  {!recent.length ? <div className="dl-empty" style={{ padding: '9px 12px' }}>No movement in window.</div> : null}
                </div>
              </div>

              <div className="scard">
                <div className="scard-head">Sovereign coverage</div>
                <div className="gauge-wrap">
                  <div className="gauge">
                    <svg width="74" height="74" viewBox="0 0 74 74">
                      <circle cx="37" cy="37" r="30" fill="none" stroke="var(--surface-3)" strokeWidth="7" />
                      <circle
                        cx="37"
                        cy="37"
                        r="30"
                        fill="none"
                        stroke={gaugePct > 0 ? 'var(--on)' : 'var(--off-sw)'}
                        strokeWidth="7"
                        strokeLinecap="round"
                        strokeDasharray={gaugeC}
                        strokeDashoffset={gaugeC * (1 - gaugePct / 100)}
                        transform="rotate(-90 37 37)"
                        style={{ transition: 'stroke-dashoffset .8s var(--e)' }}
                      />
                    </svg>
                    <div className="lbl">
                      <b>{gaugePct}%</b>
                      <span>covered</span>
                    </div>
                  </div>
                  <div className="gauge-txt">
                    <b>{brief.sovGaps}</b> dark cells — prod-live flags absent from sovereign clouds. <b>{flags.length - brief.sovCovered}</b> of{' '}
                    {flags.length} flags touch zero sovereign envs.
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </main>
      </div>

      <footer className="provbar">
        <div className="pb-l">
          <i className="d" />
          <span className="pb-seg">
            Reconstructed&nbsp;from&nbsp;<b>FeatureManagement</b>&nbsp;@&nbsp;
            <a className="pb-commit" href={`${COMMIT_BASE}${initial.meta.headCommitId ?? ''}`} target="_blank" rel="noopener noreferrer">
              {headCommit}
              <span className="ext">↗</span>
            </a>
          </span>
          <span className="sep">│</span>
          <span className="pb-seg">
            <b>{flags.length}</b>&nbsp;flags · <b>15</b>&nbsp;envs · <b>{cells.total}</b>&nbsp;cells
          </span>
          <span className="sep">│</span>
          <span className="pb-seg">
            <span className="sw" style={{ background: 'var(--on-sw)' }} />
            <b>{cells.on}</b>&nbsp;on&nbsp;&nbsp;
            <span className="sw" style={{ background: 'var(--cond-sw)' }} />
            <b>{cells.cond}</b>&nbsp;cond&nbsp;&nbsp;
            <span className="sw" style={{ background: 'var(--target-sw)' }} />
            <b>{cells.target}</b>&nbsp;targeted&nbsp;&nbsp;
            <span className="sw" style={{ background: 'var(--off-sw)' }} />
            <b>{cells.off}</b>&nbsp;off
          </span>
        </div>
        <div className="pb-r">
          <span>last&nbsp;sync&nbsp;{syncAgo}</span>
          <span className="sep">│</span>
          <span>read-only</span>
        </div>
      </footer>

      {/* drawer */}
      <div className={`overlay ${selId ? 'show' : ''}`} onClick={closeDrawer} />
      <div className={`drawer ${selId ? 'show' : ''}`}>
        <div className="drawer-head">
          <button className="drawer-close" onClick={closeDrawer}>
            ✕
          </button>
          <div className="drawer-kicker">Flag Dossier</div>
          <div className="drawer-title">{selFlag?.id ?? ''}</div>
          <div className="drawer-desc">{dossier?.description ?? selFlag?.description ?? ''}</div>
        </div>
        <div className="drawer-body">{selId ? renderDossier() : null}</div>
      </div>

      {/* palette */}
      <div className={`palette-wrap ${paletteOpen ? 'show' : ''}`} onClick={() => setPaletteOpen(false)}>
        <div className="palette" onClick={(e) => e.stopPropagation()}>
          <div className="palette-in">
            <span>⌕</span>
            <input
              ref={paletteInputRef}
              placeholder="Jump to a flag or surface…"
              value={paletteQuery}
              onChange={(e) => {
                setPaletteQuery(e.target.value);
                setPaletteCur(0);
              }}
              onKeyDown={paletteKey}
            />
            <kbd>esc</kbd>
          </div>
          <div className="palette-list">
            {paletteItems.length ? (
              paletteItems.map((it, i) => (
                <div key={`${it.type}-${it.t}`}>
                  {i === 0 || paletteItems[i - 1]!.type !== it.type ? (
                    <div className="pgroup">{it.type === 'surface' ? 'Surfaces' : 'Flags'}</div>
                  ) : null}
                  <div className={`pitem ${i === paletteCur ? 'cur' : ''}`} onClick={() => runPalette(i)}>
                    <span className="pitem-ico">{it.ico}</span>
                    <div className="pitem-main">
                      <div className="pitem-t">{it.t}</div>
                      <div className="pitem-s">{it.s}</div>
                    </div>
                    {it.st ? (
                      <span className={`pitem-st pill ${scl(it.st)}`} style={{ padding: '2px 7px' }}>
                        {it.st}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <div className="pgroup">No matches</div>
            )}
          </div>
        </div>
      </div>

      {/* toast */}
      <div className={`toast ${toast ? 'show' : ''}`} dangerouslySetInnerHTML={{ __html: toast }} />
    </>
  );
}
