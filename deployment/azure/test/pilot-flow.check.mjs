import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('actual pilot CLI preserves strict activation and explicit compute-stop sequencing with memory-only state/Azure', async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--no-warnings',
      new URL('./pilot-flow-fixture.mjs', import.meta.url).pathname,
    ],
    {
      timeout: 30_000,
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
    },
  );
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { cases: 50 });
});
