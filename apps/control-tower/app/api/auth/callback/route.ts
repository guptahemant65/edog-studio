import { readAuthEnv, AuthConfigError } from '../../../../src/auth/auth-config.ts';
import { MsalTokenService } from '../../../../src/auth/token-service.ts';
import { completeSignIn } from '../../../../src/auth/flow.ts';
import { getTokenCache } from '../../../../src/auth/token-cache.ts';
import { parseCookies } from '../../../../src/auth/guard.ts';
import { safeEqual } from '../../../../src/auth/session.ts';
import { OAUTH_COOKIE, openOAuth, buildOAuthClearCookie } from '../../../../src/auth/oauth-cookie.ts';
import { isSecureRequest } from '../../../../src/server/request-auth.ts';

export const dynamic = 'force-dynamic';

/** GET /api/auth/callback — exchange code → token, set session, redirect (architecture §2.2 steps 6–9). */
export async function GET(req: Request): Promise<Response> {
  let env;
  try {
    env = readAuthEnv();
  } catch (err) {
    if (err instanceof AuthConfigError) return new Response(err.message, { status: 503 });
    throw err;
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthRaw = parseCookies(req.headers.get('cookie'))[OAUTH_COOKIE];
  const roundTrip = oauthRaw ? openOAuth(oauthRaw, env.sessionSecret) : null;

  if (!code || !state || !roundTrip || !safeEqual(state, roundTrip.state)) {
    return new Response('Invalid or expired sign-in request.', { status: 400 });
  }

  const secure = isSecureRequest();
  const result = await completeSignIn({
    svc: new MsalTokenService({
      clientId: env.clientId,
      tenantId: env.tenantId,
      clientSecret: env.clientSecret,
      redirectUri: env.redirectUri,
    }),
    cache: getTokenCache(),
    code,
    codeVerifier: roundTrip.verifier,
    sessionSecret: env.sessionSecret,
    redirectTo: roundTrip.returnTo,
    secureCookie: secure,
  });

  const headers = new Headers({ Location: result.redirectTo });
  headers.append('Set-Cookie', result.setCookie);
  headers.append('Set-Cookie', buildOAuthClearCookie({ secure })); // one-time use
  return new Response(null, { status: 302, headers });
}
