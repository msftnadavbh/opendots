import { afterEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import * as files from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createApp } from '../src/server/app.js';
import { backupMetadata, MAX_BACKUP_BYTES } from '../src/server/backup.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';

// Passthrough mocks only observe real processes/files, except explicit failure injection below.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof childProcess>();
  return { ...real, spawn: vi.fn(real.spawn) };
});
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof files>();
  return { ...real, rm: vi.fn(real.rm) };
});

const origin = 'https://owned.example';
const token = 'fake-owner-token-not-a-real-secret';
const config = { mode: 'sample' as const, baseUrl: 'https://unused.invalid' };
const sandboxRequested = process.env.OPENDOTS_BACKUP_TEST_SANDBOX === '1';
const sandboxBytes = 64 * 1024 * 1024;
if (process.env.OPENDOTS_BACKUP_TEST_SANDBOX !== undefined) {
  const space = statfsSync('/tmp');
  if (
    !sandboxRequested ||
    process.platform !== 'linux' ||
    !/^v24\./.test(process.version) ||
    space.type !== 0x01021994 ||
    space.bsize * space.blocks !== sandboxBytes
  )
    throw new Error(
      'Backup stress tests require the explicit disposable Node24/64MiB tmpfs sandbox.',
    );
}
const cleanups: (() => Promise<unknown> | void)[] = [];
const helperUrl = new URL(
  '../deployment/azure/sqlite-backup.mjs',
  import.meta.url,
).href;
const { manifest } = await import(helperUrl);
const headers = {
  Authorization: `Bearer ${token}`,
  Origin: origin,
  'Content-Type': 'application/json',
};

async function waitFor(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error('Condition timed out');
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function jobs() {
  return (await files.readdir('/tmp')).filter((name) =>
    name.startsWith('opendots-backup-'),
  );
}
async function fixture(
  options: { ownerToken?: string; origin?: string; databasePath?: string } = {},
) {
  const directory = await files.mkdtemp(resolve('node_modules/backup-test-'));
  const source = join(directory, 'source.sqlite');
  const store = new Store(source);
  store.updateSettings({ name: 'Private synthetic owner' });
  const db = new DatabaseSync(source);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE photos (id TEXT PRIMARY KEY, content BLOB); CREATE TABLE extra (value TEXT)',
  );
  db.prepare('INSERT INTO photos VALUES (?, ?)').run(
    'photo',
    Buffer.alloc(512 * 1024, 0x5a),
  );
  db.prepare('INSERT INTO extra VALUES (?)').run('visible only through WAL');
  cleanups.push(async () => {
    db.close();
    store.close();
    await files.rm(directory, { recursive: true, force: true });
  });
  const runner = new Runner(store, config);
  const app = createApp({
    store,
    runner,
    config,
    ownerToken: token,
    origin,
    databasePath: source,
    ...options,
  });
  const post = async (init: RequestInit = {}) => {
    const response = await app.request('/api/backup', {
      method: 'POST',
      headers,
      body: '{}',
      ...init,
    });
    if (response.status === 200)
      cleanups.push(() => response.body?.cancel().catch(() => {}));
    return response;
  };
  return { app, source, directory, db, post };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (sandboxRequested) await waitFor(async () => (await jobs()).length === 0);
});

describe('private backup authorization', () => {
  it('refuses every unauthorized, unconfigured, malformed or non-POST request before spawn', async () => {
    const { post } = await fixture();
    const spawn = vi.spyOn(childProcess, 'spawn');
    for (const [init, status] of [
      [{ headers: { ...headers, Authorization: '' } }, 401],
      [{ headers: { ...headers, Authorization: 'Bearer wrong' } }, 401],
      [{ headers: { ...headers, Authorization: token } }, 401],
      [{ headers: { ...headers, Authorization: `bearer ${token}` } }, 401],
      [{ headers: { ...headers, Origin: '' } }, 403],
      [{ headers: { ...headers, Origin: 'https://foreign.example' } }, 403],
      [{ headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } }, 403],
      [{ headers: { ...headers, 'Content-Type': 'text/plain' } }, 415],
      [{ body: '{"path":"/anything"}' }, 400],
      [{ body: '[]' }, 400],
      [{ body: 'null' }, 400],
      [{ body: '' }, 400],
      [{ body: 'invalid' }, 400],
      [{ method: 'GET', body: undefined }, 405],
      [{ method: 'HEAD', body: undefined }, 405],
      [{ method: 'PUT' }, 405],
    ] as [RequestInit, number][])
      expect((await post(init)).status).toBe(status);
    for (const options of [
      { ownerToken: undefined },
      { origin: undefined },
      { databasePath: undefined },
    ]) {
      const other = await fixture(options);
      expect((await other.post()).status).toBe(
        options.ownerToken === undefined && 'ownerToken' in options
          ? 401
          : 'origin' in options
            ? 403
            : 503,
      );
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe.runIf(sandboxRequested)(
  'disposable 64MiB backup filesystem sandbox',
  () => {
    it('exports the WAL-visible whole database with BLOBs, canonical metadata, private modes and no source mutation', async () => {
      const { post, source, directory } = await fixture();
      const before = manifest(source);
      const bytesBefore = await files.readFile(source);
      const walBefore = await files.readFile(`${source}-wal`);
      const spawn = vi.spyOn(childProcess, 'spawn');
      const response = await post();
      expect(response.status).toBe(200);
      const [job] = await jobs();
      expect((await files.stat(`/tmp/${job}`)).mode & 0o777).toBe(0o700);
      expect(
        (await files.stat(`/tmp/${job}/snapshot.sqlite`)).mode & 0o777,
      ).toBe(0o600);
      const child = spawn.mock.results[0].value as childProcess.ChildProcess;
      let closed = false;
      child.once('close', () => {
        closed = true;
      });
      const second = await post();
      expect(second.status).toBe(409);
      const bytes = Buffer.from(await response.arrayBuffer());
      await waitFor(async () => (await jobs()).length === 0);
      expect(closed).toBe(true);
      const restored = join(directory, 'restored.sqlite');
      await files.writeFile(restored, bytes, { mode: 0o600 });
      expect(manifest(restored)).toEqual(before);
      const copy = new DatabaseSync(restored, { readOnly: true });
      expect(
        Buffer.from(
          copy.prepare('SELECT content FROM photos').get()
            ?.content as Uint8Array,
        ).equals(Buffer.alloc(512 * 1024, 0x5a)),
      ).toBe(true);
      expect(copy.prepare('SELECT value FROM extra').get()?.value).toBe(
        'visible only through WAL',
      );
      copy.close();
      expect(response.headers.get('Content-Type')).toBe(
        'application/octet-stream',
      );
      expect(response.headers.get('Content-Disposition')).toContain(
        'attachment;',
      );
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(Number(response.headers.get('Content-Length'))).toBe(bytes.length);
      expect(response.headers.get('X-OpenDots-Backup-Sha256')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(response.headers.get('X-OpenDots-Backup-Manifest')).toBe(
        Buffer.from(JSON.stringify(before)).toString('base64'),
      );
      expect(await files.readFile(source)).toEqual(bytesBefore);
      expect(await files.readFile(`${source}-wal`)).toEqual(walBefore);
      const cooldown = await post();
      expect(cooldown.status).toBe(429);
      expect(Number(cooldown.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(Number(cooldown.headers.get('Retry-After'))).toBeLessThanOrEqual(
        30,
      );
      const env = spawn.mock.calls[0][2]?.env;
      expect(Object.keys(env ?? {}).sort()).toEqual([
        'LANG',
        'PATH',
        'SQLITE_TMPDIR',
        'TMPDIR',
      ]);
      expect(JSON.stringify(spawn.mock.calls)).not.toContain(token);
    });

    it('refuses missing, symlinked, nonregular and over-cap source before spawning', async () => {
      const { source, directory } = await fixture();
      const link = join(directory, 'link.sqlite');
      await files.symlink(source, link);
      const oversized = join(directory, 'oversized.sqlite');
      const file = await files.open(oversized, 'wx', 0o600);
      await file.truncate(MAX_BACKUP_BYTES + 1);
      await file.close();
      const spawn = vi.spyOn(childProcess, 'spawn');
      for (const databasePath of [
        join(directory, 'missing.sqlite'),
        link,
        directory,
        oversized,
      ]) {
        const { post } = await fixture({ databasePath });
        expect((await post()).status).toBe(503);
      }
      expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects an already aborted request without spawning', async () => {
      const { post } = await fixture();
      const spawn = vi.spyOn(childProcess, 'spawn');
      expect((await post({ signal: AbortSignal.abort() })).status).toBe(503);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('refuses an actual over-32MiB WAL snapshot without dropping photos or changing source', async () => {
      const { post, db, source } = await fixture();
      const insert = db.prepare('INSERT INTO photos VALUES (?, ?)');
      db.exec('BEGIN');
      for (let i = 0; i < 128; i++)
        insert.run(`large-${i}`, Buffer.alloc(256 * 1024, i));
      db.exec('COMMIT');
      expect((await files.stat(source)).size).toBeLessThan(MAX_BACKUP_BYTES);
      const before = manifest(source);
      const response = await post();
      expect(response.status).toBe(503);
      expect(response.headers.has('X-OpenDots-Backup-Manifest')).toBe(false);
      expect(manifest(source)).toEqual(before);
      expect(db.prepare('SELECT count(*) AS n FROM photos').get()?.n).toBe(129);
    });

    it('exports a near-capacity photo database with the final 32MiB resource profile', async () => {
      const { post, db, source } = await fixture();
      const insert = db.prepare('INSERT INTO photos VALUES (?, ?)');
      db.exec('BEGIN');
      for (let i = 0; i < 120; i++)
        insert.run(`large-${i}`, Buffer.alloc(256 * 1024, i));
      db.exec('COMMIT');
      const before = manifest(source);
      const response = await post();
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(30 * 1024 * 1024);
      expect(bytes.length).toBeLessThanOrEqual(MAX_BACKUP_BYTES);
      expect(Number(response.headers.get('Content-Length'))).toBe(bytes.length);
      expect(response.headers.get('X-OpenDots-Backup-Sha256')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(response.headers.get('X-OpenDots-Backup-Manifest')).toBe(
        Buffer.from(JSON.stringify(before)).toString('base64'),
      );
    }, 15_000);

    it.each(['mode', 'size', 'symlink'])(
      'refuses a completed snapshot with invalid %s before headers',
      async (invalid) => {
        const { post, source } = await fixture();
        const { open: realOpen } =
          await vi.importActual<typeof files>('node:fs/promises');
        vi.spyOn(files, 'open').mockImplementation(
          async (path, flags, mode) => {
            if (String(path).endsWith('/snapshot.sqlite')) {
              if (invalid === 'mode') await files.chmod(path, 0o644);
              if (invalid === 'size') await files.truncate(path, 512);
              if (invalid === 'symlink') {
                await files.unlink(path);
                await files.symlink(source, path);
              }
            }
            return realOpen(path, flags, mode);
          },
        );
        const response = await post();
        expect(response.status).toBe(503);
        expect(response.headers.has('X-OpenDots-Backup-Manifest')).toBe(false);
        expect(manifest(source).integrity).toBe('ok');
      },
    );

    it('rejects an actually oversized encoded manifest before headers without truncation', async () => {
      const { post, db } = await fixture();
      db.exec('BEGIN');
      for (let i = 0; i < 100; i++)
        db.exec(`CREATE TABLE extra_${i} (id INTEGER)`);
      db.exec('COMMIT');
      const response = await post();
      expect(response.status).toBe(503);
      expect(response.headers.has('X-OpenDots-Backup-Manifest')).toBe(false);
    });

    it('aborts a real SQLite worker before headers, closes it before unlock, and leaves source intact', async () => {
      const { post, db, source } = await fixture();
      const before = manifest(source);
      db.exec('BEGIN EXCLUSIVE');
      const spy = vi.spyOn(childProcess, 'spawn');
      const controller = new AbortController();
      const pending = post({ signal: controller.signal });
      await waitFor(async () => spy.mock.results.length > 0);
      const child = spy.mock.results[0].value as childProcess.ChildProcess;
      let closed = false;
      child.once('close', () => {
        closed = true;
      });
      expect((await post()).status).toBe(409);
      controller.abort();
      expect((await pending).status).toBe(503);
      expect(closed).toBe(true);
      expect((await post()).status).toBe(429);
      db.exec('ROLLBACK');
      expect(manifest(source)).toEqual(before);
    });

    it('cleans on an actual loopback HTTP disconnect during stream', async () => {
      const { app } = await fixture();
      const spy = vi.spyOn(childProcess, 'spawn');
      const server = serve({
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      });
      await once(server, 'listening');
      cleanups.push(
        () => new Promise<void>((done) => server.close(() => done())),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error();
      await new Promise<void>((done, fail) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/api/backup',
            method: 'POST',
            headers,
          },
          (response) => {
            expect(response.statusCode).toBe(200);
            response.once('data', () => {
              response.destroy();
              req.destroy();
              done();
            });
          },
        );
        req.once('error', (error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET')
            fail(error);
        });
        req.end('{}');
      });
      const child = spy.mock.results[0].value as childProcess.ChildProcess;
      await waitFor(async () => (await jobs()).length === 0);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    });

    it('refuses leftover jobs without deleting them or spawning', async () => {
      const { post } = await fixture();
      const leftover = await files.mkdtemp('/tmp/opendots-backup-');
      cleanups.push(() => files.rm(leftover, { recursive: true, force: true }));
      const spawn = vi.spyOn(childProcess, 'spawn');
      expect((await post()).status).toBe(503);
      expect((await files.stat(leftover)).isDirectory()).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('cancels a stalled real file stream at its scheduled lifetime deadline before unlock', async () => {
      const { post } = await fixture();
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const spawn = vi.spyOn(childProcess, 'spawn');
      const response = await post();
      expect(response.status).toBe(200);
      const child = spawn.mock.results[0].value as childProcess.ChildProcess;
      const deadline = timers.mock.calls.find(([, ms]) => ms === 60_000)?.[0];
      expect(typeof deadline).toBe('function');
      (deadline as () => void)();
      const body = await response.arrayBuffer().catch(() => null);
      if (body)
        expect(body.byteLength).toBeLessThan(
          Number(response.headers.get('Content-Length')),
        );
      await waitFor(async () => (await jobs()).length === 0);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect((await post()).status).toBe(429);
    });

    it('keeps the lifetime kill backstop while cleanup waits for a guardian ignoring EOF', async () => {
      const { post, directory } = await fixture();
      const stalled = join(directory, 'stalled-guardian.sh');
      await files.writeFile(
        stalled,
        '#!/bin/bash\nset -eu\nshift\n"$@"\nwhile true; do /bin/sleep 1; done\n',
        { mode: 0o600 },
      );
      const { spawn: realSpawn } =
        await vi.importActual<typeof childProcess>('node:child_process');
      const spawn = vi
        .spyOn(childProcess, 'spawn')
        .mockImplementation(
          (...args: Parameters<typeof childProcess.spawn>) => {
            if (Array.isArray(args[1]))
              args[1] = [stalled, ...args[1].slice(1)];
            return realSpawn(...args);
          },
        );
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const cleared = vi.spyOn(globalThis, 'clearTimeout');
      const response = await post();
      expect(response.status).toBe(200);
      const child = spawn.mock.results[0].value as childProcess.ChildProcess;
      const timerIndex = timers.mock.calls.findIndex(([, ms]) => ms === 60_000);
      const timer = timers.mock.results[timerIndex].value;
      const body = response.arrayBuffer();
      await waitFor(async () => child.stdin?.writableEnded === true);
      expect(child.exitCode).toBe(null);
      expect(cleared.mock.calls.some(([value]) => value === timer)).toBe(false);
      (timers.mock.calls[timerIndex][0] as () => void)();
      await body;
      await waitFor(async () => (await jobs()).length === 0);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect((await post()).status).toBe(429);
    });

    it('blocks future exports after cleanup failure, even after cooldown', async () => {
      const { post } = await fixture();
      const original = files.rm;
      const rm = vi
        .spyOn(files, 'rm')
        .mockRejectedValue(new Error('fake private marker'));
      const response = await post();
      await response.arrayBuffer();
      await waitFor(async () => rm.mock.calls.length > 0);
      rm.mockRestore();
      for (const job of await jobs())
        await original(`/tmp/${job}`, { recursive: true, force: true });
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
      expect((await post()).status).toBe(503);
      now.mockRestore();
    });

    it('fails cleanly under actual concurrent tmpfs pressure before spawn', async () => {
      const { post } = await fixture();
      const pressure = '/tmp/backup-test-pressure';
      cleanups.push(() => files.rm(pressure, { force: true }));
      await files.writeFile(pressure, Buffer.alloc(33 * 1024 * 1024));
      const spawn = vi.spyOn(childProcess, 'spawn');
      expect((await post()).status).toBe(503);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('fails a real SQLite child on ENOSPC pressure arriving after preflight', async () => {
      const { post, db, source } = await fixture();
      db.prepare('INSERT INTO photos VALUES (?, ?)').run(
        'pressure-photo',
        Buffer.alloc(2 * 1024 * 1024),
      );
      const before = manifest(source);
      const pressure = '/tmp/backup-test-pressure';
      cleanups.push(() => files.rm(pressure, { force: true }));
      const { spawn: realSpawn } =
        await vi.importActual<typeof childProcess>('node:child_process');
      vi.spyOn(childProcess, 'spawn').mockImplementation(
        (...args: Parameters<typeof childProcess.spawn>) => {
          const space = statfsSync('/tmp');
          writeFileSync(
            pressure,
            Buffer.alloc(
              Math.max(
                0,
                Math.min(sandboxBytes, space.bsize * space.bavail) - 512 * 1024,
              ),
            ),
          );
          return realSpawn(...args);
        },
      );
      const response = await post();
      expect(response.status).toBe(503);
      expect(response.headers.has('X-OpenDots-Backup-Manifest')).toBe(false);
      expect(manifest(source)).toEqual(before);
    });

    it('fails worker errors without metadata or raw error leakage', async () => {
      const { directory } = await fixture();
      const source = join(directory, 'corrupt.sqlite');
      await files.writeFile(source, 'not a database fake-private-marker');
      const { post } = await fixture({ databasePath: source });
      const audit = vi.spyOn(console, 'info').mockImplementation(() => {});
      const response = await post();
      expect(response.status).toBe(503);
      expect(response.headers.has('X-OpenDots-Backup-Manifest')).toBe(false);
      expect(await response.text()).not.toContain('fake-private-marker');
      expect(JSON.stringify(audit.mock.calls)).not.toContain(
        'fake-private-marker',
      );
    });
  },
);

describe('bounded backup metadata', () => {
  const valid = {
    size: 512,
    sha256: 'a'.repeat(64),
    manifest: Buffer.from(
      JSON.stringify({ integrity: 'ok', tables: {} }),
    ).toString('base64'),
  };
  it('accepts canonical metadata and rejects malformed, oversized or noncanonical headers without truncation', () => {
    expect(backupMetadata(JSON.stringify(valid))).toEqual(valid);
    for (const value of [
      { ...valid, size: MAX_BACKUP_BYTES + 1 },
      { ...valid, size: 0 },
      { ...valid, sha256: 'A'.repeat(64) },
      { ...valid, manifest: 'a'.repeat(8193) },
      { ...valid, manifest: valid.manifest + '\n' },
      {
        ...valid,
        manifest: Buffer.from('{ "integrity": "ok", "tables": {} }').toString(
          'base64',
        ),
      },
      {
        ...valid,
        manifest: Buffer.from(
          JSON.stringify({
            integrity: 'ok',
            tables: { x: { records: -1, sha256: valid.sha256 } },
          }),
        ).toString('base64'),
      },
      { ...valid, extra: true },
      null,
    ])
      expect(() => backupMetadata(JSON.stringify(value))).toThrow();
  });
});

describe.runIf(sandboxRequested)(
  'actual Linux guardian and kernel bounds',
  () => {
    const guardian = resolve('deployment/azure/export-guardian.sh');
    const flags = [
      '--jitless',
      '--max-old-space-size=128',
      '--max-semi-space-size=8',
    ];
    async function run(code: string) {
      const directory = await files.mkdtemp('/tmp/opendots-backup-');
      const child = childProcess.spawn(
        '/bin/bash',
        [guardian, directory, process.execPath, ...flags, '-e', code],
        {
          detached: true,
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C',
            TMPDIR: directory,
            SQLITE_TMPDIR: directory,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        child.stdin.end();
      });
      child.stderr.resume();
      const closed = once(child, 'close');
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          process.kill(-child.pid, 'SIGKILL');
          await closed;
        }
        await files.rm(directory, { recursive: true, force: true });
      });
      const [exitCode, signal] = await closed;
      expect(await files.stat(directory).catch(() => null)).toBe(null);
      return { exitCode, signal, output };
    }

    it('enforces the final profile and private scratch spill environment in actual Node24', async () => {
      const result = await run(
        `const fs=require('node:fs'); console.log(JSON.stringify({limits:fs.readFileSync('/proc/self/limits','utf8'),node:process.version,tmp:process.env.TMPDIR,sqliteTmp:process.env.SQLITE_TMPDIR}));`,
      );
      expect(result.exitCode).toBe(0);
      const value = JSON.parse(result.output);
      expect(value.node).toMatch(/^v24\./);
      expect(value.limits).toMatch(/Max core file size\s+0\s+0/);
      expect(value.limits).toMatch(/Max file size\s+33554432\s+33554432/);
      expect(value.limits).toMatch(
        /Max address space\s+1073741824\s+1073741824/,
      );
      expect(value.tmp).toBe(value.sqliteTmp);
      expect(value.tmp).toMatch(/^\/tmp\/opendots-backup-/);
    });

    it('permits exactly 32MiB and enforces boundary plus one with real EFBIG', async () => {
      const result = await run(
        `const fs=require('node:fs'); const fd=fs.openSync('boundary','wx',0o600);fs.ftruncateSync(fd,33554432);let error;try{fs.writeSync(fd,Buffer.from([1]),0,1,33554432)}catch(e){error=e.code}console.log(JSON.stringify({size:fs.fstatSync(fd).size,error}));fs.closeSync(fd);`,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toEqual({
        size: MAX_BACKUP_BYTES,
        error: 'EFBIG',
      });
    });

    it('fails cleanly on actual tmpfs ENOSPC after preflight', async () => {
      const pressure = '/tmp/backup-test-pressure';
      cleanups.push(() => files.rm(pressure, { force: true }));
      const space = await files.statfs('/tmp');
      await files.writeFile(
        pressure,
        Buffer.alloc(
          Math.max(
            0,
            Math.min(sandboxBytes, space.bsize * space.bavail) - 512 * 1024,
          ),
        ),
      );
      const result = await run(
        `const fs=require('node:fs');let error;try{fs.writeFileSync('spill',Buffer.alloc(2*1024*1024))}catch(e){error=e.code}fs.rmSync('spill',{force:true});console.log(JSON.stringify({error}));`,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toEqual({ error: 'ENOSPC' });
    });

    it('contains actual memory exhaustion without core dumps or unbounded worker output', async () => {
      const result = await run(
        'const values=[];while(true)values.push(new Array(100000).fill(42));',
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toBe('');
    }, 30_000);

    it('hard-kills synchronous busy work at the real deadline and cleans private files', async () => {
      const start = Date.now();
      const result = await run('while(true){}');
      expect(result.exitCode).not.toBe(0);
      expect(Date.now() - start).toBeGreaterThanOrEqual(19_500);
      expect(Date.now() - start).toBeLessThan(25_000);
      expect(result.output).toBe('');
    }, 30_000);

    it('survives actual parent SIGKILL, bounds the orphan worker and removes the job', async () => {
      const directory = await files.mkdtemp('/tmp/opendots-backup-');
      const workerCode = `require('node:fs').writeFileSync('worker.pid',String(process.pid));while(true){}`;
      const parentCode = `import {spawn} from 'node:child_process';const child=spawn('/bin/bash',${JSON.stringify([guardian, directory, process.execPath, ...flags, '-e', workerCode])},{detached:true,env:{PATH:'/usr/bin:/bin',TMPDIR:${JSON.stringify(directory)},SQLITE_TMPDIR:${JSON.stringify(directory)}},stdio:['pipe','pipe','ignore']});child.stdout.resume();console.log(child.pid);setInterval(()=>{},1000);`;
      const parent = childProcess.spawn(
        process.execPath,
        ['--input-type=module', '-e', parentCode],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const [chunk] = await once(parent.stdout, 'data');
      const guardianPid = Number(String(chunk).trim());
      await waitFor(
        async () =>
          !!(await files.stat(join(directory, 'worker.pid')).catch(() => null)),
      );
      const workerPid = Number(
        await files.readFile(join(directory, 'worker.pid'), 'utf8'),
      );
      parent.kill('SIGKILL');
      await once(parent, 'close');
      expect(
        await files.stat(`/proc/${guardianPid}`).catch(() => null),
      ).not.toBe(null);
      expect(await files.stat(`/proc/${workerPid}`).catch(() => null)).not.toBe(
        null,
      );
      await waitFor(
        async () => !(await files.stat(directory).catch(() => null)),
        25_000,
      );
      expect(await files.stat(`/proc/${workerPid}`).catch(() => null)).toBe(
        null,
      );
    }, 30_000);
  },
);
