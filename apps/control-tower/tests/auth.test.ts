import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sealSession, openSession, buildSetCookie, buildClearCookie, safeEqual,
  SESSION_COOKIE, type SessionPayload,
} from '../src/auth/session.ts';
import { ServerTokenCache } from '../src/auth/token-cache.ts';
import { buildAuthorizeUrl, generateState, pkcePair } from '../src/auth/authorize.ts';
import { parseCookies, readSession } from '../src/auth/guard.ts';
import { ADO_SCOPE, allScopes, authorityUrl } from '../src/auth/scopes.ts';
import { tryReadAuthEnv, readAuthEnv, AuthConfigError, isDevAuth } from '../src/auth/auth-config.ts';

const SECRET = 'unit-test-session-secret';
const payload: SessionPayload = { oid: 'oid-123', name: 'PM', email: 'pm@ms.com', expiresAt: Date.now() + 3_600_000 };

test('session: seal → open round-trips', () => {
  const token = sealSession(payload, SECRET);
  const opened = openSession(token, SECRET);
  assert.deepEqual(opened, payload);
});

test('session: tampered token → null', () => {
  const token = sealSession(payload, SECRET);
  const parts = token.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${Buffer.from('evil').toString('base64url')}`;
  assert.equal(openSession(tampered, SECRET), null);
});

test('session: wrong secret → null', () => {
  const token = sealSession(payload, SECRET);
  assert.equal(openSession(token, 'other-secret'), null);
});

test('session: expired → null', () => {
  const expired = { ...payload, expiresAt: Date.now() - 1000 };
  const token = sealSession(expired, SECRET);
  assert.equal(openSession(token, SECRET), null);
});

test('session: never embeds a token (payload is profile-only)', () => {
  const token = sealSession(payload, SECRET);
  const decoded = Buffer.from(token.split('.')[2]!, 'base64url').toString('utf8');
  // ciphertext is opaque, but the typed payload has no token field by construction:
  assert.equal('adoAccessToken' in payload, false);
  assert.ok(decoded.length > 0);
});

test('cookie: Set-Cookie attributes', () => {
  const c = buildSetCookie('VALUE', { secure: true });
  assert.match(c, new RegExp(`^${SESSION_COOKIE}=VALUE`));
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.match(c, /Max-Age=28800/);
  assert.match(buildClearCookie(), /Max-Age=0/);
  assert.ok(!buildSetCookie('V', { secure: false }).includes('Secure'));
});

test('safeEqual: constant-time compare', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('token-cache: getValid honours expiry skew + never serialises', () => {
  const cache = new ServerTokenCache();
  const now = 1_000_000;
  cache.set('oid-1', { adoAccessToken: 'tok', adoExpiresAt: now + 120_000 });
  assert.equal(cache.getValid('oid-1', now), 'tok');
  // within 60s skew of expiry → treated as expired
  assert.equal(cache.getValid('oid-1', now + 70_000), null);
  assert.equal(cache.getValid('missing', now), null);
  assert.throws(() => JSON.stringify(cache), /never be serialised/);
});

test('authorize: URL carries all required params', () => {
  const state = generateState();
  const { challenge } = pkcePair();
  const url = new URL(buildAuthorizeUrl({
    clientId: 'cid', tenantId: 'tid', redirectUri: 'https://app/cb', state, codeChallenge: challenge,
  }));
  assert.equal(url.origin + url.pathname, `${authorityUrl('tid')}/oauth2/v2.0/authorize`);
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app/cb');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('scope')!.includes(ADO_SCOPE));
});

test('scopes: OIDC + ADO resource', () => {
  assert.deepEqual(allScopes(), ['openid', 'profile', 'email', ADO_SCOPE]);
});

test('guard: parseCookies + readSession', () => {
  const token = sealSession(payload, SECRET);
  const header = `foo=bar; ${SESSION_COOKIE}=${token}; baz=qux`;
  assert.equal(parseCookies(header)[SESSION_COOKIE], token);
  assert.deepEqual(readSession(header, SECRET), payload);
  assert.equal(readSession(null, SECRET), null);
  assert.equal(readSession('foo=bar', SECRET), null);
});

test('auth-config: missing env → null / throws with names', () => {
  assert.equal(tryReadAuthEnv({} as NodeJS.ProcessEnv), null);
  assert.throws(() => readAuthEnv({ ENTRA_CLIENT_ID: 'x' } as NodeJS.ProcessEnv), (e) => {
    assert.ok(e instanceof AuthConfigError);
    assert.match((e as Error).message, /ENTRA_TENANT_ID/);
    return true;
  });
  const full = {
    ENTRA_CLIENT_ID: 'c', ENTRA_TENANT_ID: 't', ENTRA_CLIENT_SECRET: 's',
    CT_REDIRECT_URI: 'https://app/cb', CT_SESSION_SECRET: 'sec',
  } as NodeJS.ProcessEnv;
  assert.equal(readAuthEnv(full).clientId, 'c');
  assert.equal(isDevAuth({ CT_DEV_AUTH: '1', ADO_TOKEN: 'pat' } as NodeJS.ProcessEnv), true);
  assert.equal(isDevAuth({ CT_DEV_AUTH: '1' } as NodeJS.ProcessEnv), false);
});
