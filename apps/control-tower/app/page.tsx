import { ensureBuilt } from '../src/server/store.ts';
import { devAdoClientProvider, MissingTokenError } from '../src/server/ado-provider.ts';
import { buildGridResponse, type GridRow } from '../src/api/grid.ts';
import { LADDER_ENVS } from '../src/types/model.ts';

// Always render at request time — the warm store is process state, not build-time data.
export const dynamic = 'force-dynamic';

const STATE_COLOR: Record<string, string> = {
  on: '#2ea043',
  conditional: '#bf8700',
  targeted: '#8957e5',
  off: '#30363d',
};

function Cell({ state }: { state: string }) {
  return (
    <td style={{ padding: '4px 8px', textAlign: 'center' }}>
      <span
        title={state}
        style={{
          display: 'inline-block',
          width: 10,
          height: 10,
          borderRadius: 2,
          background: STATE_COLOR[state] ?? '#30363d',
        }}
      />
    </td>
  );
}

function GridTable({ rows }: { rows: GridRow[] }) {
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
      <thead>
        <tr style={{ textAlign: 'left', color: '#9aa0ad' }}>
          <th style={{ padding: '6px 8px' }}>Flag</th>
          {LADDER_ENVS.map((e) => (
            <th key={e} style={{ padding: '6px 8px', textAlign: 'center' }}>
              {e}
            </th>
          ))}
          <th style={{ padding: '6px 8px' }}>Last change</th>
          <th style={{ padding: '6px 8px' }}>Health</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.flagId} style={{ borderTop: '1px solid #21262d' }}>
            <td style={{ padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{r.flagId}</td>
            {LADDER_ENVS.map((e) => (
              <Cell key={e} state={r.states[e]} />
            ))}
            <td style={{ padding: '4px 8px', color: '#9aa0ad' }}>
              {r.daysSinceLastChange === null ? '—' : `${r.daysSinceLastChange}d ago`}
            </td>
            <td style={{ padding: '4px 8px', color: '#9aa0ad' }}>{r.staleReason ?? 'stable'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function Page() {
  let rows: GridRow[] = [];
  let banner: string | null = null;
  try {
    const store = await ensureBuilt(devAdoClientProvider);
    rows = buildGridResponse(store).rows;
  } catch (err) {
    if (err instanceof MissingTokenError) {
      banner = 'Set ADO_TOKEN to a PAT with code-read scope, then reload to mine live flag data.';
    } else {
      throw err;
    }
  }

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px' }}>
      <h1 style={{ fontSize: 22, margin: 0 }}>Aperture — Rollout Tracker</h1>
      <p style={{ color: '#9aa0ad', marginTop: 4 }}>
        Read-only rollout intelligence for FabricLiveTable feature flags.
      </p>
      {banner ? (
        <p style={{ background: '#1c2330', border: '1px solid #30363d', borderRadius: 6, padding: 12, marginTop: 24 }}>
          {banner}
        </p>
      ) : (
        <div style={{ marginTop: 24 }}>
          <GridTable rows={rows} />
        </div>
      )}
    </main>
  );
}
