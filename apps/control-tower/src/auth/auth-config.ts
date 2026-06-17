/**
 * Auth environment resolution (architecture §2.3, §2.6).
 *
 * Reads the Entra app registration + session secret from the environment. The
 * client secret is loaded here from `ENTRA_CLIENT_SECRET` (Vercel) — under App
 * Service it is injected from KeyVault via Managed Identity at startup, which is
 * the only hosting-specific difference (§2.6).
 */
export interface AuthEnv {
  clientId: string;
  tenantId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
}

export class AuthConfigError extends Error {
  constructor(missing: string[]) {
    super(`Auth is not configured — missing env: ${missing.join(', ')}.`);
    this.name = 'AuthConfigError';
  }
}

const REQUIRED: Array<[keyof AuthEnv, string]> = [
  ['clientId', 'ENTRA_CLIENT_ID'],
  ['tenantId', 'ENTRA_TENANT_ID'],
  ['clientSecret', 'ENTRA_CLIENT_SECRET'],
  ['redirectUri', 'CT_REDIRECT_URI'],
  ['sessionSecret', 'CT_SESSION_SECRET'],
];

/** Resolve auth env, or null if any required var is missing. */
export function tryReadAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv | null {
  const values = {
    clientId: env.ENTRA_CLIENT_ID,
    tenantId: env.ENTRA_TENANT_ID,
    clientSecret: env.ENTRA_CLIENT_SECRET,
    redirectUri: env.CT_REDIRECT_URI,
    sessionSecret: env.CT_SESSION_SECRET,
  };
  if (REQUIRED.some(([k]) => !values[k])) return null;
  return values as AuthEnv;
}

/** Resolve auth env or throw with the list of missing vars. */
export function readAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv {
  const cfg = tryReadAuthEnv(env);
  if (!cfg) {
    const missing = REQUIRED.filter(([, envName]) => !env[envName]).map(([, e]) => e);
    throw new AuthConfigError(missing);
  }
  return cfg;
}

/** Whether the local dev ADO_TOKEN fallback is active (no Entra needed locally). */
export function isDevAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CT_DEV_AUTH === '1' && !!env.ADO_TOKEN;
}

/**
 * Whether the Azure-credential data source is active (`CT_AZURE_CRED=1`). The ADO
 * token is then minted via `@azure/identity` — the developer's `az login` locally,
 * or a managed identity when deployed — so no PAT or interactive sign-in is needed.
 */
export function isAzureCred(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CT_AZURE_CRED === '1';
}
