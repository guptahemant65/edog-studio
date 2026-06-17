import { readSession } from '../../../../src/auth/guard.ts';
import { buildClearCookie } from '../../../../src/auth/session.ts';
import { getTokenCache } from '../../../../src/auth/token-cache.ts';
import { tryReadAuthEnv } from '../../../../src/auth/auth-config.ts';
import { isSecureRequest } from '../../../../src/server/request-auth.ts';

export const dynamic = 'force-dynamic';

/** GET /api/auth/signout — drop the server token + clear the session cookie. */
export async function GET(req: Request): Promise<Response> {
  const env = tryReadAuthEnv();
  if (env) {
    const session = readSession(req.headers.get('cookie'), env.sessionSecret);
    if (session) getTokenCache().delete(session.oid);
  }
  const headers = new Headers({ Location: '/' });
  headers.append('Set-Cookie', buildClearCookie({ secure: isSecureRequest() }));
  return new Response(null, { status: 302, headers });
}
