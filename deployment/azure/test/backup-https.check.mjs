import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  lstat,
  chmod,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { backupHttps } from '../backup-https.mjs';
import { manifest, verifyRestore } from '../sqlite-backup.mjs';
import {
  makeRuntimeEnv,
  encodeRuntimeEnv,
  writePrivate,
  readPrivate,
} from '../runtime-env.mjs';
import { output } from './fixtures.mjs';

const origin = `https://${output.vm.fqdn}`;
const token = randomBytes(32).toString('base64url');
async function fixture(t) {
  const root = await mkdtemp('/tmp/opencode/opendots-https-backup-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.sqlite'),
    directory = join(root, 'backups');
  const db = new DatabaseSync(source);
  db.exec('CREATE TABLE photos(id TEXT PRIMARY KEY, bytes BLOB NOT NULL);');
  db.prepare('INSERT INTO photos VALUES (?, ?)').run(
    'synthetic',
    Buffer.from([255, 216, 255, 217]),
  );
  db.close();
  const bytes = await readFile(source),
    report = manifest(source);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="untrusted-ignored.sqlite"',
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes.length),
    'X-OpenDots-Backup-Sha256': createHash('sha256')
      .update(bytes)
      .digest('hex'),
    'X-OpenDots-Backup-Manifest': Buffer.from(JSON.stringify(report)).toString(
      'base64',
    ),
  };
  const calls = [];
  const privatePath = join(root, 'runtime.env');
  await writePrivate(
    privatePath,
    encodeRuntimeEnv(
      makeRuntimeEnv(
        {
          CPK_INTELLIGENCE_API_KEY: 'fake-project-key',
          OWNER_ID: 'fixture-owner',
          OWNER_TOKEN: token,
        },
        undefined,
        output,
        origin,
      ),
    ),
  );
  const options = { output, privatePath, directory };
  const response = (body = bytes, change = {}, extra = {}) => {
    const value = new Response(body, {
      status: 200,
      headers: { ...headers, ...change },
    });
    Object.defineProperties(value, {
      url: { value: origin + '/api/backup' },
      ...Object.fromEntries(
        Object.entries(extra).map(([key, value]) => [key, { value }]),
      ),
    });
    return value;
  };
  const request = async (url, options) => {
    calls.push({ url, options });
    return response();
  };
  return {
    root,
    source,
    directory,
    bytes,
    report,
    headers,
    calls,
    options,
    response,
    request,
  };
}

test('private HTTPS export validates the complete SQLite file, publishes manifest first and restores identical BLOBs', async (t) => {
  const f = await fixture(t);
  const path = await backupHttps({ ...f.options, request: f.request });
  assert.match(path, /\/backup-[a-f0-9-]{36}\.sqlite$/);
  assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(path + '.manifest.json')).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(path), f.bytes);
  assert.deepEqual(
    JSON.parse(await readFile(path + '.manifest.json', 'utf8')),
    f.report,
  );
  const restored = await verifyRestore(path, join(f.root, 'restored'));
  assert.deepEqual(manifest(restored.destination), f.report);
  assert.equal(
    (await readdir(f.directory)).some((name) => name.endsWith('.partial')),
    false,
  );
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, origin + '/api/backup');
  assert(!call.url.includes(token));
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.body, '{}');
  assert.equal(call.options.headers.Authorization, 'Bearer ' + token);
  assert.equal(call.options.headers.Origin, origin);
});

for (const kind of [
  'redirected',
  'different-url',
  'wrong-mime',
  'cacheable',
  'inline',
  'too-large',
  'missing-size',
  'bad-manifest',
  'oversized-manifest',
  'bad-hash',
])
  test(`rejects ${kind} response metadata before writing database bytes`, async (t) => {
    const f = await fixture(t);
    const changes = {
      'wrong-mime': { 'Content-Type': 'text/html' },
      cacheable: { 'Cache-Control': 'public' },
      inline: { 'Content-Disposition': 'inline' },
      'too-large': { 'Content-Length': String(32 * 1024 * 1024 + 1) },
      'missing-size': { 'Content-Length': '' },
      'bad-manifest': {
        'X-OpenDots-Backup-Manifest': Buffer.from(
          '{"integrity":"bad"}',
        ).toString('base64'),
      },
      'oversized-manifest': { 'X-OpenDots-Backup-Manifest': 'A'.repeat(8193) },
      'bad-hash': { 'X-OpenDots-Backup-Sha256': 'not-a-hash' },
    };
    const extra =
      kind === 'redirected'
        ? { redirected: true }
        : kind === 'different-url'
          ? { url: 'https://example.invalid/' }
          : {};
    await assert.rejects(
      backupHttps({
        ...f.options,
        request: async () => f.response(f.bytes, changes[kind], extra),
      }),
      /HTTPS backup failed/,
    );
    assert.deepEqual(await readdir(f.directory), []);
  });

for (const kind of [
  'truncated',
  'extra-bytes',
  'hash-mismatch',
  'manifest-mismatch',
  'non-sqlite',
  'stream-error',
])
  test(`never publishes ${kind} data and retains private partial evidence`, async (t) => {
    const f = await fixture(t);
    let body = f.bytes,
      changes = {};
    if (kind === 'truncated') body = f.bytes.subarray(0, f.bytes.length - 1);
    if (kind === 'extra-bytes')
      body = Buffer.concat([f.bytes, Buffer.from([0])]);
    if (kind === 'hash-mismatch')
      changes['X-OpenDots-Backup-Sha256'] = '0'.repeat(64);
    if (kind === 'manifest-mismatch') {
      const different = structuredClone(f.report);
      different.tables.photos.records++;
      changes['X-OpenDots-Backup-Manifest'] = Buffer.from(
        JSON.stringify(different),
      ).toString('base64');
    }
    if (kind === 'non-sqlite') {
      body = Buffer.alloc(f.bytes.length, 0);
      changes['X-OpenDots-Backup-Sha256'] = createHash('sha256')
        .update(body)
        .digest('hex');
    }
    if (kind === 'stream-error')
      body = new ReadableStream({
        pull(controller) {
          controller.enqueue(f.bytes.subarray(0, 32));
          controller.error(
            new Error('fake-sensitive-provider-detail-' + token),
          );
        },
      });
    await assert.rejects(
      backupHttps({
        ...f.options,
        request: async () => f.response(body, changes),
      }),
      (error) => {
        assert(!error.message.includes(token));
        assert(!error.message.includes('fake-sensitive-provider-detail'));
        return /HTTPS backup failed/.test(error.message);
      },
    );
    const files = await readdir(f.directory);
    assert.equal(files.length, 1);
    assert(files[0].endsWith('.partial'));
    assert.equal(
      (await lstat(join(f.directory, files[0]))).mode & 0o777,
      0o600,
    );
  });

test(
  'cancellation terminates a stalled stream without a completed backup',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      abort = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(f.bytes.subarray(0, 64));
      },
      cancel() {
        cancelled = true;
      },
    });
    const timer = setTimeout(() => abort.abort(), 50);
    t.after(() => clearTimeout(timer));
    await assert.rejects(
      backupHttps({
        ...f.options,
        signal: abort.signal,
        request: async () => f.response(body),
      }),
      /HTTPS backup failed/,
    );
    assert(cancelled);
    assert(
      (await readdir(f.directory)).every((name) => name.endsWith('.partial')),
    );
  },
);

test('invalid scope/credential/private destination/pre-abort never makes an HTTP request', async (t) => {
  const f = await fixture(t);
  const request = async () => assert.fail('No network call permitted');
  for (const patch of [
    { output: {} },
    { output: { ...output, vm: { ...output.vm, fqdn: 'example.invalid' } } },
    { privatePath: join(f.root, 'missing.env') },
  ])
    await assert.rejects(
      backupHttps({ ...f.options, ...patch, request }),
      /HTTPS backup failed/,
    );
  const saved = await readPrivate(f.options.privatePath);
  await writePrivate(f.options.privatePath, saved.replace(token, 'invalid'));
  await assert.rejects(
    backupHttps({ ...f.options, request }),
    /HTTPS backup failed/,
  );
  await writePrivate(f.options.privatePath, saved);
  await writePrivate(
    f.options.privatePath,
    saved.replace(
      origin,
      'https://opendots-7unu3az5tgmza.other.eastus2.sysgen.cloudapp.azure.com',
    ),
  );
  await assert.rejects(
    backupHttps({ ...f.options, request }),
    /HTTPS backup failed/,
  );
  await writePrivate(f.options.privatePath, saved);
  await chmod(f.options.privatePath, 0o644);
  await assert.rejects(
    backupHttps({ ...f.options, request }),
    /HTTPS backup failed/,
  );
  await chmod(f.options.privatePath, 0o600);
  await mkdir(f.directory, { mode: 0o700 });
  await chmod(f.directory, 0o755);
  await assert.rejects(
    backupHttps({ ...f.options, request }),
    /HTTPS backup failed/,
  );
  await rm(f.directory, { recursive: true });
  await symlink(f.root, f.directory);
  await assert.rejects(
    backupHttps({ ...f.options, request }),
    /HTTPS backup failed/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    backupHttps({ ...f.options, signal: abort.signal, request }),
    /HTTPS backup failed/,
  );
});

test('an HTTP or thrown request error is sanitized and does not publish data', async (t) => {
  const f = await fixture(t);
  for (const request of [
    async () => new Response(token, { status: 401 }),
    async () => {
      throw new Error('provider echoed ' + token);
    },
  ])
    await assert.rejects(
      backupHttps({ ...f.options, request }),
      (error) =>
        !error.message.includes(token) &&
        /HTTPS backup failed/.test(error.message),
    );
  assert.deepEqual(await readdir(f.directory), []);
});
