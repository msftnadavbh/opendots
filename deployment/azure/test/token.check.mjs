import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertExpiry,
  tokenExpiration,
  withImportToken,
} from '../import-token.mjs';
import { PULL_ACTIONS, TOKEN_NAME, safeError } from '../scope.mjs';
import { output } from './fixtures.mjs';
const now = Date.parse('2026-10-20T12:00:00Z');
function fixture(failAt) {
  const calls = [];
  let status = 'disabled';
  const scopeMapId = `${output.registryId}/scopeMaps/${output.scopeMapName}`;
  const az = {
    read: async (args) => {
      calls.push(args);
      return args[1] === 'scope-map'
        ? { id: scopeMapId, actions: PULL_ACTIONS }
        : { status, scopeMapId, credentials: { passwords: [] } };
    },
    write: async (args) => {
      calls.push(args);
      if (args.includes('generate')) {
        assert(args.includes('--password1'));
        assert(!args.includes('--password2'));
        if (failAt === 'generate') throw new Error('secret-from-cli');
        return {
          username: TOKEN_NAME,
          passwords: [
            {
              name: 'password1',
              value: 'test-registry-secret',
              expiry: tokenExpiration(now),
            },
          ],
        };
      }
      status = args.at(-1);
      if (failAt === 'enable' && status === 'enabled')
        throw new Error('secret-enable-error');
      return { status };
    },
  };
  return { az, calls, status: () => status };
}
test('expiration is UTC, bounded to one hour, and never defaults to a second password', () => {
  assertExpiry(tokenExpiration(now), now);
  assertExpiry(tokenExpiration(now).replace('Z', '+00:00'), now);
  for (const value of [
    'never',
    new Date(now).toISOString(),
    new Date(now + 3_600_001).toISOString(),
    '2026-10-20T13:00:01+00:00',
    '2026-10-20T13:00:00+01:00',
  ])
    assert.throws(() => assertExpiry(value, now));
});
for (const failure of [undefined, 'generate', 'enable', 'import'])
  test(`finally disables and verifies token after ${failure ?? 'success'}`, async () => {
    const { az, calls, status } = fixture(failure);
    const operation = () =>
      withImportToken(
        az,
        output,
        async (credentials) => {
          assert.equal(credentials.username, TOKEN_NAME);
          assert.equal(credentials.token, 'test-registry-secret');
          if (failure === 'import') throw new Error('test-registry-secret');
          return 'image';
        },
        () => now,
      );
    if (failure)
      await assert.rejects(
        operation(),
        (error) => !safeError(error).includes('secret'),
      );
    else assert.equal(await operation(), 'image');
    assert.equal(status(), 'disabled');
    assert(calls.at(-2).includes('disabled'));
    assert.equal(calls.at(-1)[2], 'show');
    assert(!JSON.stringify(calls).includes('test-registry-secret'));
  });
test('failure to revoke is never reported as success', async () => {
  const { az } = fixture();
  const original = az.write;
  az.write = async (args) => {
    if (args.includes('disabled')) throw new Error('secret');
    return original(args);
  };
  await assert.rejects(
    withImportToken(
      az,
      output,
      async () => 'image',
      () => now,
    ),
    /revocation could not be verified/,
  );
});

test('malformed credential responses cannot bypass final revocation', async () => {
  const { az, status, calls } = fixture();
  const original = az.write;
  az.write = async (args) =>
    args.includes('generate')
      ? { username: TOKEN_NAME, passwords: 'unexpected-private-response' }
      : original(args);
  await assert.rejects(
    withImportToken(
      az,
      output,
      async () => 'unused',
      () => now,
    ),
    /Unexpected registry credential response/,
  );
  assert.equal(status(), 'disabled');
  assert(calls.some((args) => args.includes('disabled')));
});
