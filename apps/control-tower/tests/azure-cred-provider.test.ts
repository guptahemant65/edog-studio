/**
 * Azure-credential ADO provider tests — the `CT_AZURE_CRED=1` data source that
 * mints the ADO token from an Entra identity (az login locally / managed identity
 * deployed) instead of a PAT or interactive sign-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessToken, TokenCredential } from '@azure/identity';
import { isAzureCred } from '../src/auth/auth-config.ts';
import {
  AzureCredError,
  azureCredAdoClientProviderWith,
  buildAdoCredential,
} from '../src/server/azure-cred-ado-provider.ts';
import { HttpAdoClient } from '../src/engine/ado-client.ts';
import { ADO_SCOPE } from '../src/auth/scopes.ts';

function fakeCredential(impl: () => Promise<AccessToken | null>): TokenCredential {
  return { getToken: impl };
}

test('isAzureCred: only true when CT_AZURE_CRED=1', () => {
  assert.equal(isAzureCred({ CT_AZURE_CRED: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(isAzureCred({ CT_AZURE_CRED: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(isAzureCred({} as NodeJS.ProcessEnv), false);
});

test('provider: builds an HttpAdoClient from the credential token', async () => {
  let requestedScope: string | string[] | undefined;
  const cred = fakeCredential(async (...args: unknown[]) => {
    requestedScope = args[0] as string | string[];
    return { token: 'ado-access-token', expiresOnTimestamp: Date.now() + 3_600_000 };
  });
  const client = await azureCredAdoClientProviderWith(cred)();
  assert.ok(client instanceof HttpAdoClient);
  assert.equal(requestedScope, ADO_SCOPE);
});

test('provider: null token → AzureCredError', async () => {
  const cred = fakeCredential(async () => null);
  await assert.rejects(azureCredAdoClientProviderWith(cred)(), AzureCredError);
});

test('provider: credential throws → AzureCredError (wrapped)', async () => {
  const cred = fakeCredential(async () => {
    throw new Error('no az login');
  });
  await assert.rejects(azureCredAdoClientProviderWith(cred)(), (err: unknown) => {
    assert.ok(err instanceof AzureCredError);
    assert.match(err.message, /no az login/);
    return true;
  });
});

test('buildAdoCredential: mode selects the credential kind', () => {
  assert.equal(buildAdoCredential({ CT_AZURE_CRED_MODE: 'cli' } as NodeJS.ProcessEnv).constructor.name, 'AzureCliCredential');
  assert.equal(buildAdoCredential({ CT_AZURE_CRED_MODE: 'mi' } as NodeJS.ProcessEnv).constructor.name, 'ManagedIdentityCredential');
  assert.equal(buildAdoCredential({} as NodeJS.ProcessEnv).constructor.name, 'DefaultAzureCredential');
});
