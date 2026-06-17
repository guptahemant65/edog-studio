import { ensureBuilt } from '../src/server/store.ts';
import { adoProviderForRequest } from '../src/server/request-auth.ts';
import { UnauthorizedError } from '../src/server/session-ado-provider.ts';
import { MissingTokenError } from '../src/server/ado-provider.ts';
import { AzureCredError } from '../src/server/azure-cred-ado-provider.ts';
import { AuthConfigError } from '../src/auth/auth-config.ts';
import { buildGridResponse } from '../src/api/grid.ts';
import { buildInertResponse } from '../src/api/inert.ts';
import { headers } from 'next/headers';
import RolloutTracker from './rollout-tracker.tsx';
import type { InitialData, GridRowDTO, InertNote } from './view-model.ts';

// Always render at request time — the warm store is process state, not build-time data.
export const dynamic = 'force-dynamic';

function AuthShell({ text, signIn }: { text: string; signIn?: boolean }) {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '64px 24px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ fontSize: 13, letterSpacing: '.12em', textTransform: 'uppercase', color: '#8a8f98' }}>Aperture</div>
      <h1 style={{ fontSize: 22, margin: '6px 0 0' }}>Rollout Tracker</h1>
      <div
        style={{
          background: '#f6f7f9',
          border: '1px solid #e3e5e9',
          borderRadius: 8,
          padding: 20,
          marginTop: 24,
          color: '#3c4149',
        }}
      >
        <p style={{ margin: 0 }}>{text}</p>
        {signIn ? (
          <a
            href="/api/auth/signin"
            style={{
              display: 'inline-block',
              marginTop: 14,
              padding: '8px 16px',
              background: '#6d5cff',
              color: '#fff',
              borderRadius: 6,
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            Sign in with Microsoft
          </a>
        ) : null}
      </div>
    </main>
  );
}

export default async function Page() {
  let initial: InitialData | null = null;
  let banner: { text: string; signIn?: boolean } | null = null;

  try {
    const cookieHeader = (await headers()).get('cookie');
    const provider = adoProviderForRequest(cookieHeader);
    const client = await provider();
    const store = await ensureBuilt(() => Promise.resolve(client));

    const grid = buildGridResponse(store);
    const inert = buildInertResponse(store);

    const inertMap: Record<string, InertNote> = {};
    for (const finding of inert.findings) {
      if (finding.status !== 'INERT') continue;
      const blocker = finding.edges.find((e) => e.isBlocker);
      if (!blocker) continue;
      inertMap[finding.flagId] = {
        needs: blocker.prerequisiteId,
        note: `Requires ${blocker.prerequisiteId} — off in prod`,
      };
    }

    const flags: GridRowDTO[] = grid.rows.map((r) => ({
      flagId: r.flagId,
      description: r.description,
      states: r.states,
      lastChange: r.lastChange,
      daysSinceLastChange: r.daysSinceLastChange,
      staleReason: r.staleReason,
      layer: r.layer,
    }));

    initial = { flags, meta: grid.meta, inert: inertMap };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      banner = { text: 'Sign in with your Microsoft account to view rollout data.', signIn: true };
    } else if (err instanceof AuthConfigError) {
      banner = { text: 'Auth is not configured. Set the Entra env vars, or use CT_DEV_AUTH=1 + ADO_TOKEN for local dev.' };
    } else if (err instanceof MissingTokenError) {
      banner = { text: 'Set ADO_TOKEN to a PAT with code-read scope, then reload to mine live flag data.' };
    } else if (err instanceof AzureCredError) {
      banner = { text: err.message };
    } else {
      throw err;
    }
  }

  if (banner) return <AuthShell text={banner.text} signIn={banner.signIn} />;
  return <RolloutTracker initial={initial!} />;
}
