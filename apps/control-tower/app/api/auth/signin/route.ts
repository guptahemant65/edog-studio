import { readAuthEnv, AuthConfigError } from '../../../../src/auth/auth-config.ts';
import { buildAuthorizeUrl, generateState, pkcePair } from '../../../../src/auth/authorize.ts';
import { sealOAuth, buildOAuthSetCookie } from '../../../../src/auth/oauth-cookie.ts';
import { isSecureRequest } from '../../../../src/server/request-auth.ts';

export const dynamic = 'force-dynamic';

/** GET /api/auth/signin — start the Entra auth-code + PKCE flow (architecture §2.2). */
export async function GET(req: Request): Promise<Response> {
  let env;
  try {
    env = readAuthEnv();
  } catch (err) {
    if (err instanceof AuthConfigError) return new Response(err.message, { status: 503 });
    throw err;
  }

  const returnTo = new URL(req.url).searchParams.get('returnTo') ?? '/';
  const state = generateState();
  const { verifier, challenge } = pkcePair();

  const authorizeUrl = buildAuthorizeUrl({
    clientId: env.clientId,
    tenantId: env.tenantId,
    redirectUri: env.redirectUri,
    state,
    codeChallenge: challenge,
  });

  const oauthCookie = buildOAuthSetCookie(
    sealOAuth({ state, verifier, returnTo }, env.sessionSecret),
    { secure: isSecureRequest() },
  );

  return new Response(null, { status: 302, headers: { Location: authorizeUrl, 'Set-Cookie': oauthCookie } });
}
