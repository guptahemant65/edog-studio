import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeSignIn } from '../src/auth/flow.ts';
import { ServerTokenCache } from '../src/auth/token-cache.ts';
import { openSession, SESSION_COOKIE } from '../src/auth/session.ts';
import { sessionAdoClientProvider, UnauthorizedError } from '../src/server/session-ado-provider.ts';
import { sealSession } from '../src/auth/session.ts';
import type { AcquiredTokens, AdoTokenGrant, TokenService } from '../src/auth/token-service.ts';

const SECRET = 'flow-secret';

class FakeTokenService implements TokenService {
  byCodeCalls = 0;
  silentCalls = 0;
  silentResult: AdoTokenGrant | null = null;

  async acquireByCode(code: string): Promise<AcquiredTokens> {
    this.byCodeCalls += 1;
    return {
      profile: { oid: `oid-${code}`, name: 'PM', email: 'pm@ms.com' },
      adoAccessToken: `ado-for-${code}`,
      adoExpiresAt: Date.now() + 3_600_000,
    };
  }

  async acquireAdoTokenSilent(_oid: string): Promise<AdoTokenGrant | null> {
    this.silentCalls += 1;
    return this.silentResult;
  }
}

test('completeSignIn: caches token, seals profile-only cookie', async () => {
  const svc = new FakeTokenService();
  const cache = new ServerTokenCache();
  const res = await completeSignIn({ svc, cache, code: 'AAA', sessionSecret: SECRET, secureCookie: false });

  assert.equal(svc.byCodeCalls, 1);
  assert.match(res.setCookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.equal(res.redirectTo, '/');
  // token is in the server cache, keyed by oid
  assert.equal(cache.getValid('oid-AAA'), 'ado-for-AAA');
  // cookie carries only the profile, never the token
  const value = res.setCookie.split(';')[0]!.split('=')[1]!;
  const opened = openSession(value, SECRET)!;
  assert.equal(opened.oid, 'oid-AAA');
  assert.ok(!res.setCookie.includes('ado-for-AAA'));
});

function cookieHeaderFor(oid: string): string {
  const token = sealSession({ oid, name: 'PM', email: null, expiresAt: Date.now() + 3_600_000 }, SECRET);
  return `${SESSION_COOKIE}=${token}`;
}

test('sessionAdoClientProvider: returns client when token cached', async () => {
  const cache = new ServerTokenCache();
  cache.set('oid-1', { adoAccessToken: 'tok', adoExpiresAt: Date.now() + 3_600_000 });
  const provider = sessionAdoClientProvider({ cookieHeader: cookieHeaderFor('oid-1'), sessionSecret: SECRET, cache });
  const client = await provider();
  assert.ok(client); // HttpAdoClient constructed
});

test('sessionAdoClientProvider: no session → UnauthorizedError', async () => {
  const cache = new ServerTokenCache();
  const provider = sessionAdoClientProvider({ cookieHeader: null, sessionSecret: SECRET, cache });
  await assert.rejects(provider(), UnauthorizedError);
});

test('sessionAdoClientProvider: expired token silently refreshed', async () => {
  const cache = new ServerTokenCache();
  const svc = new FakeTokenService();
  svc.silentResult = { adoAccessToken: 'fresh', adoExpiresAt: Date.now() + 3_600_000 };
  const provider = sessionAdoClientProvider({
    cookieHeader: cookieHeaderFor('oid-9'), sessionSecret: SECRET, cache, tokenSvc: svc,
  });
  const client = await provider();
  assert.ok(client);
  assert.equal(svc.silentCalls, 1);
  assert.equal(cache.getValid('oid-9'), 'fresh');
});

test('sessionAdoClientProvider: expired + refresh fails → UnauthorizedError', async () => {
  const cache = new ServerTokenCache();
  const svc = new FakeTokenService(); // silentResult stays null
  const provider = sessionAdoClientProvider({
    cookieHeader: cookieHeaderFor('oid-x'), sessionSecret: SECRET, cache, tokenSvc: svc,
  });
  await assert.rejects(provider(), UnauthorizedError);
  assert.equal(svc.silentCalls, 1);
});
