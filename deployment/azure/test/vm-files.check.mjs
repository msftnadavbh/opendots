import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  configureRuntime,
  backupDirectory,
  streamBackup,
} from '../vm-files.mjs';
import { backupVm } from '../vm.mjs';
import {
  consistentBackup,
  manifest,
  verifyRestore,
} from '../sqlite-backup.mjs';
import {
  encodeRuntimeEnv,
  makeRuntimeEnv,
  parseEnv,
  writePrivate,
} from '../runtime-env.mjs';
import { origin, output } from './fixtures.mjs';

async function temporary(t) {
  await mkdir('/tmp/opencode', { recursive: true });
  const directory = await mkdtemp('/tmp/opencode/opendots-files-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const runtime = () =>
  makeRuntimeEnv(
    {
      CPK_INTELLIGENCE_API_KEY: 'fake-project-key-only',
      OWNER_ID: 'fixture-owner',
      OWNER_TOKEN: 'f'.repeat(43),
    },
    undefined,
    output,
    origin,
  );
function collector() {
  const chunks = [];
  return {
    chunks,
    output: new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  };
}
async function sqliteFixture(t) {
  const directory = await temporary(t),
    active = join(directory, 'live.sqlite'),
    snapshot = join(directory, 'snapshot.sqlite');
  const db = new DatabaseSync(active);
  t.after(() => db.close());
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE dot_photos(dotId TEXT PRIMARY KEY, photo BLOB);',
  );
  db.prepare('INSERT INTO records VALUES (?, ?)').run(1, 'fake-private-record');
  db.prepare('INSERT INTO dot_photos VALUES (?, ?)').run(
    'dot-1',
    Buffer.from([0, 255, 10, 128, 1]),
  );
  assert((await stat(active + '-wal')).size > 0);
  const reported = await consistentBackup(active, snapshot);
  db.prepare('INSERT INTO records VALUES (?, ?)').run(2, 'later-live-write');
  return { directory, active, snapshot, reported };
}
function remote(
  f,
  directory,
  { badManifest = false, brokenStream = false, collision } = {},
) {
  let name;
  return {
    name: () => name,
    run: async (command, options) => {
      const match = /backup-[a-f0-9-]{36}\.sqlite/.exec(command);
      assert(match, 'Only a bounded backup/download command is expected');
      if (command.includes('vm-host.sh backup ')) {
        name = match[0];
        assert(command.includes('timeout --kill-after=10 330'));
        if (collision)
          await writeFile(
            join(directory, name + collision.suffix),
            collision.bytes,
            { mode: 0o600, flag: 'wx' },
          );
        return JSON.stringify(
          badManifest ? { ...f.reported, integrity: 'wrong' } : f.reported,
        );
      }
      assert.equal(match[0], name);
      assert(command.includes('vm-host.sh download '));
      assert(
        !command.includes('flock'),
        'Streaming reads must not hold the operator lock',
      );
      assert(options.output);
      assert.equal(options.timeoutMs, 900_000);
      if (brokenStream) {
        const source = new Readable({
          read() {
            this.push(Buffer.from('incomplete'));
            this.destroy(new Error('fixture stream failure'));
          },
        });
        await pipeline(source, options.output);
      } else await pipeline(createReadStream(f.snapshot), options.output);
      return '';
    },
  };
}

test(
  'backupVm pipelines a real WAL/photo snapshot to completion, private data+manifest and restore parity',
  { timeout: 10_000 },
  async (t) => {
    const f = await sqliteFixture(t),
      directory = join(f.directory, 'downloaded');
    const ssh = remote(f, directory);
    const destination = await backupVm(ssh, directory);
    assert.equal(destination, join(directory, ssh.name()));
    for (const path of [destination, destination + '.manifest.json'])
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(await readFile(destination + '.manifest.json', 'utf8')),
      f.reported,
    );
    assert.deepEqual(manifest(destination), f.reported);
    const restored = await verifyRestore(
      destination,
      join(f.directory, 'restored'),
    );
    assert.deepEqual(restored.tables, f.reported.tables);
    assert.equal(restored.tables.dot_photos.records, 1);
    assert.equal(manifest(f.active).tables.records.records, 2);
    assert.equal(manifest(destination).tables.records.records, 1);
    assert.deepEqual(
      (await readdir(directory)).sort(),
      [ssh.name(), ssh.name() + '.manifest.json'].sort(),
    );
  },
);

for (const failure of ['badManifest', 'brokenStream'])
  test(
    `${failure} leaves no completed local backup`,
    { timeout: 10_000 },
    async (t) => {
      const f = await sqliteFixture(t),
        directory = join(f.directory, 'downloaded');
      const ssh = remote(f, directory, { [failure]: true });
      await assert.rejects(backupVm(ssh, directory));
      const names = await readdir(directory);
      assert(
        !names.some(
          (name) => name.endsWith('.sqlite') || name.endsWith('.manifest.json'),
        ),
      );
      assert.deepEqual(names, [ssh.name() + '.partial']);
      assert.equal((await stat(join(directory, names[0]))).mode & 0o777, 0o600);
    },
  );

for (const suffix of ['', '.manifest.json', '.partial'])
  test(
    `exclusive publication never overwrites an existing backup${suffix}`,
    { timeout: 10_000 },
    async (t) => {
      const f = await sqliteFixture(t),
        directory = join(f.directory, 'downloaded');
      await mkdir(directory, { mode: 0o700 });
      const bytes = Buffer.from('existing-fixture-must-survive');
      const ssh = remote(f, directory, { collision: { suffix, bytes } });
      await assert.rejects(backupVm(ssh, directory), { code: 'EEXIST' });
      assert.deepEqual(
        await readFile(join(directory, ssh.name() + suffix)),
        bytes,
      );
      if (suffix)
        await assert.rejects(stat(join(directory, ssh.name())), {
          code: 'ENOENT',
        });
    },
  );

test('configureRuntime enforces stdin bounds, private atomic updates and stable identity', async (t) => {
  const directory = await temporary(t),
    path = join(directory, 'runtime.env');
  await assert.rejects(
    configureRuntime(directory, Buffer.alloc(1_000_001)),
    /too large/,
  );
  assert.deepEqual(await readdir(directory), []);
  const initial = runtime();
  await configureRuntime(directory, encodeRuntimeEnv(initial));
  const previous = await open(path, 'r');
  try {
    const inode = (await previous.stat()).ino;
    await configureRuntime(directory, encodeRuntimeEnv(initial));
    assert.notEqual(
      (await stat(path)).ino,
      inode,
      'Configuration must replace, not mutate, the file',
    );
    assert.deepEqual(parseEnv(await previous.readFile('utf8')), initial);
  } finally {
    await previous.close();
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const before = await readFile(path);
  for (const [key, value] of Object.entries({
    OWNER_ID: 'other-owner',
    OWNER_TOKEN: 'g'.repeat(43),
    CPK_INTELLIGENCE_API_KEY: 'other-fake-key',
    APP_ORIGIN: 'https://other.example.com',
    OPENAI_BASE_URL: 'https://other.example.com',
  })) {
    const changed = { ...initial, [key]: value };
    // OPENAI_BASE_URL is rejected at validation, even before identity comparison.
    const content = Buffer.from(
      before
        .toString()
        .replace(`${key}='${initial[key]}'`, `${key}='${changed[key]}'`),
    );
    await assert.rejects(configureRuntime(directory, content));
    assert.deepEqual(await readFile(path), before);
  }
  assert.deepEqual(await readdir(directory), ['runtime.env']);
});

test('configuration symlink targets stay unchanged; atomic private writes never follow a target link', async (t) => {
  const directory = await temporary(t),
    sentinel = join(directory, 'sentinel'),
    path = join(directory, 'runtime.env');
  const bytes = Buffer.from('fixture-sentinel');
  await writeFile(sentinel, bytes, { mode: 0o600 });
  await symlink(sentinel, path);
  await assert.rejects(
    configureRuntime(directory, encodeRuntimeEnv(runtime())),
  );
  assert((await lstat(path)).isSymbolicLink());
  assert.deepEqual(await readFile(sentinel), bytes);
  await writePrivate(path, 'replacement-fixture');
  assert((await lstat(path)).isFile());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(sentinel), bytes);
});

test('backupDirectory rejects symlinks, files and public directories', async (t) => {
  for (const kind of ['symlink', 'file', 'public']) {
    const directory = await temporary(t),
      path = join(directory, 'backups');
    if (kind === 'symlink') await symlink(directory, path);
    if (kind === 'file') await writeFile(path, 'fixture', { mode: 0o600 });
    if (kind === 'public') {
      await mkdir(path);
      await chmod(path, 0o755);
    }
    await assert.rejects(backupDirectory(directory), /private and regular/);
  }
  const directory = await temporary(t);
  assert.equal(await backupDirectory(directory), join(directory, 'backups'));
  assert.equal((await stat(join(directory, 'backups'))).mode & 0o777, 0o700);
});

test(
  'streamBackup completes actual binary reads and rejects symlinks, nonfiles and public modes',
  { timeout: 5_000 },
  async (t) => {
    const directory = await temporary(t),
      path = join(directory, 'backup.sqlite');
    const bytes = Buffer.alloc(256 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    await writeFile(path, bytes, { mode: 0o600 });
    const good = collector();
    await streamBackup(path, good.output);
    assert(good.output.writableFinished);
    assert.deepEqual(Buffer.concat(good.chunks), bytes);
    await symlink(path, join(directory, 'link'));
    for (const bad of [join(directory, 'link'), directory]) {
      const next = collector();
      await assert.rejects(streamBackup(bad, next.output));
      assert.equal(next.chunks.length, 0);
      next.output.destroy();
    }
    await chmod(path, 0o644);
    const next = collector();
    await assert.rejects(streamBackup(path, next.output), /private regular/);
    assert.equal(next.chunks.length, 0);
    next.output.destroy();
  },
);
