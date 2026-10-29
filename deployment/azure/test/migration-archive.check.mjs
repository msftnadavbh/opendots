import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { migrationFixture } from './migration-fixture.mjs';

const name = 'vm-state.json';
const paths = (f, state) => ({
  final: join(f.target, 'source', name),
  staging: join(f.target, 'source', `.${name}.${state.migrationId}.tmp`),
});
const isStaging = (path) => /\/\.vm-state\.json\.[a-f0-9-]+\.tmp$/.test(path);
const restoreMocks = (t) => {
  t.mock.restoreAll();
  syncBuiltinESMExports();
};
async function unchangedOriginal(f) {
  for (const [name, expected] of Object.entries(f.files))
    assert.equal(await fs.readFile(join(f.original, name), 'utf8'), expected);
  assert.deepEqual(f.calls, []);
}

for (const boundary of [
  'staging-create',
  'partial-write',
  'file-fsync',
  'link',
  'directory-fsync',
  'unlink',
  'final-directory-fsync',
])
  test(`archive recovers ${boundary} interruption without rewriting source, intent or a complete final`, async (t) => {
    const f = await migrationFixture(t);
    await f.open();
    const open = fs.open,
      link = fs.link,
      unlink = fs.unlink;
    const events = [];
    let interrupted = false;
    const stop = (event) => {
      events.push(event);
      if (event === boundary) {
        interrupted = true;
        throw new Error(`fault at ${event}`);
      }
    };
    t.mock.method(fs, 'open', async (path, ...args) => {
      const file = await open(path, ...args);
      if (isStaging(path)) {
        if (boundary === 'staging-create') {
          await file.close();
          stop('staging-create');
        }
        events.push('staging-create');
        const write = file.write.bind(file),
          sync = file.sync.bind(file);
        t.mock.method(
          file,
          'write',
          async (buffer, offset, length, position) => {
            if (boundary === 'partial-write') {
              await write(buffer, offset, 17, position);
              stop('partial-write');
            }
            events.push('write');
            return write(buffer, offset, length, position);
          },
        );
        t.mock.method(file, 'sync', async () => {
          await sync();
          stop('file-fsync');
        });
      } else if (String(path).endsWith('/source')) {
        const sync = file.sync.bind(file);
        let count = 0;
        t.mock.method(file, 'sync', async () => {
          await sync();
          stop(++count === 1 ? 'directory-fsync' : 'final-directory-fsync');
        });
      }
      return file;
    });
    t.mock.method(fs, 'link', async (from, to) => {
      await link(from, to);
      if (isStaging(from)) stop('link');
    });
    t.mock.method(fs, 'unlink', async (path) => {
      await unlink(path);
      if (isStaging(path)) stop('unlink');
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        f.store.prepare(),
        new RegExp(`fault at ${boundary}`),
      );
    } finally {
      restoreMocks(t);
    }
    assert(interrupted);
    assert.equal(events.at(-1), boundary);
    if (events.includes('link'))
      assert(events.indexOf('file-fsync') < events.indexOf('link'));
    if (events.includes('unlink'))
      assert(events.indexOf('directory-fsync') < events.indexOf('unlink'));
    const state = await f.diskState();
    const journal = await fs.readFile(join(f.target, 'migration-state.json'));
    const { final, staging } = paths(f, state);
    const stagingOnly = [
      'staging-create',
      'partial-write',
      'file-fsync',
    ].includes(boundary);
    const twoLinks = ['link', 'directory-fsync'].includes(boundary);
    const retained = await fs.lstat(stagingOnly ? staging : final);
    assert.equal(retained.nlink, twoLinks ? 2 : 1);
    if (stagingOnly) await assert.rejects(fs.lstat(final), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(final, 'utf8'), f.files[name]);
    if (twoLinks) {
      assert.equal((await fs.lstat(staging)).ino, retained.ino);
      await assert.rejects(f.store.loadArchive(state));
    }
    await unchangedOriginal(f);
    await f.close();
    await f.open();
    const writes = [];
    t.mock.method(fs, 'open', async (path, ...args) => {
      const file = await open(path, ...args);
      if (isStaging(path)) {
        const write = file.write.bind(file);
        t.mock.method(
          file,
          'write',
          async (buffer, offset, length, position) => {
            writes.push({ offset, length, position });
            return write(buffer, offset, length, position);
          },
        );
      }
      return file;
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(await f.store.prepare(), state);
    } finally {
      restoreMocks(t);
    }
    assert.deepEqual(
      writes,
      retained.size < Buffer.byteLength(f.files[name])
        ? [
            {
              offset: retained.size,
              position: retained.size,
              length: Buffer.byteLength(f.files[name]) - retained.size,
            },
          ]
        : [],
    );
    assert.equal((await fs.lstat(final)).ino, retained.ino);
    assert.equal((await fs.lstat(final)).nlink, 1);
    await assert.rejects(fs.lstat(staging), { code: 'ENOENT' });
    assert(
      (await fs.readFile(join(f.target, 'migration-state.json'))).equals(
        journal,
      ),
    );
    for (const [name, expected] of Object.entries(f.files)) {
      assert.equal(
        await fs.readFile(join(f.target, 'source', name), 'utf8'),
        expected,
      );
      assert.equal(
        (await fs.lstat(join(f.target, 'source', name))).mode & 0o777,
        0o600,
      );
    }
    await f.store.loadArchive(state);
    await unchangedOriginal(f);
  });

async function identity(path) {
  try {
    const stat = await fs.lstat(path);
    return {
      ino: stat.ino,
      dev: stat.dev,
      mode: stat.mode,
      links: stat.nlink,
      bytes: stat.isSymbolicLink()
        ? await fs.readlink(path)
        : stat.isFile()
          ? await fs.readFile(path)
          : 'directory',
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
for (const fault of [
  'staging-mode',
  'final-mode',
  'staging-symlink',
  'final-symlink',
  'staging-directory',
  'staging-unknown-link',
  'final-unknown-link',
  'two-planned-plus-unknown-link',
  'different-inodes',
  'unexpected-prefix',
  'oversized-staging',
  'conflicting-final',
  'partial-final',
])
  test(`archive stops on ${fault} without cleanup, replacement or partial-final repair`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    const state = await f.diskState(),
      { final, staging } = paths(f, state);
    const extra = join(f.root, 'unplanned-link');
    if (
      fault.startsWith('staging') ||
      ['unexpected-prefix', 'oversized-staging'].includes(fault)
    )
      await fs.rename(final, staging);
    if (fault === 'staging-mode') await fs.chmod(staging, 0o644);
    if (fault === 'final-mode') await fs.chmod(final, 0o644);
    if (fault.endsWith('symlink')) {
      const path = fault.startsWith('staging') ? staging : final;
      await fs.unlink(path);
      await fs.symlink(join(f.original, name), path);
    }
    if (fault === 'staging-directory') {
      await fs.unlink(staging);
      await fs.mkdir(staging, { mode: 0o700 });
    }
    if (fault === 'staging-unknown-link') await fs.link(staging, extra);
    if (fault === 'final-unknown-link') await fs.link(final, extra);
    if (fault === 'two-planned-plus-unknown-link') {
      await fs.link(final, staging);
      await fs.link(final, extra);
    }
    if (fault === 'different-inodes')
      await fs.writeFile(staging, f.files[name], { mode: 0o600 });
    if (fault === 'unexpected-prefix')
      await fs.writeFile(staging, 'not the planned prefix');
    if (fault === 'oversized-staging')
      await fs.writeFile(staging, f.files[name] + 'extra');
    if (fault === 'conflicting-final')
      await fs.writeFile(final, 'X' + f.files[name].slice(1));
    if (fault === 'partial-final')
      await fs.writeFile(final, f.files[name].slice(0, 17));
    const before = await Promise.all([final, staging, extra].map(identity));
    const journal = await fs.readFile(join(f.target, 'migration-state.json'));
    await f.close();
    await f.open();
    await assert.rejects(f.store.prepare());
    assert.deepEqual(
      await Promise.all([final, staging, extra].map(identity)),
      before,
    );
    assert(
      (await fs.readFile(join(f.target, 'migration-state.json'))).equals(
        journal,
      ),
    );
    await unchangedOriginal(f);
  });

test('archive validates staging owner and descriptor/path identity before completing its prefix', async (t) => {
  for (const fault of ['owner', 'replaced-path']) {
    const f = await migrationFixture(t);
    await f.prepare();
    const state = await f.diskState(),
      { final, staging } = paths(f, state);
    await fs.rename(final, staging);
    await fs.writeFile(staging, f.files[name].slice(0, 17));
    const extra = join(f.root, 'retained-inode');
    const open = fs.open;
    t.mock.method(fs, 'open', async (path, ...args) => {
      const file = await open(path, ...args);
      if (isStaging(path)) {
        if (fault === 'owner') {
          const stat = file.stat.bind(file);
          t.mock.method(file, 'stat', async () =>
            Object.assign(await stat(), { uid: process.getuid() + 1 }),
          );
        } else {
          await fs.rename(staging, extra);
          await fs.writeFile(staging, f.files[name].slice(0, 17), {
            mode: 0o600,
          });
        }
      }
      return file;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.store.prepare(), /unsafe metadata|path changed/);
    } finally {
      restoreMocks(t);
    }
    assert.equal(
      await fs.readFile(staging, 'utf8'),
      f.files[name].slice(0, 17),
    );
    await assert.rejects(fs.lstat(final), { code: 'ENOENT' });
    if (fault === 'replaced-path')
      assert.equal(
        await fs.readFile(extra, 'utf8'),
        f.files[name].slice(0, 17),
      );
    await unchangedOriginal(f);
  }
});

test('archive rechecks the exact alias after directory fsync and never unlinks a substitute', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  const { final, staging } = paths(f, await f.diskState());
  await fs.link(final, staging);
  await assert.rejects(
    f.store.loadArchive(await f.diskState()),
    /regular files/,
  );
  const extra = join(f.root, 'retained-alias'),
    open = fs.open;
  let replaced = false;
  t.mock.method(fs, 'open', async (path, ...args) => {
    const file = await open(path, ...args);
    if (String(path).endsWith('/source')) {
      const sync = file.sync.bind(file);
      t.mock.method(file, 'sync', async () => {
        await sync();
        await fs.rename(staging, extra);
        await fs.writeFile(staging, 'substitute', { mode: 0o600 });
        replaced = true;
      });
    }
    return file;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.prepare(), /path changed/);
  } finally {
    restoreMocks(t);
  }
  assert(replaced);
  assert.equal(await fs.readFile(staging, 'utf8'), 'substitute');
  assert.equal((await fs.lstat(final)).nlink, 2);
  assert.equal((await fs.lstat(final)).ino, (await fs.lstat(extra)).ino);
  await unchangedOriginal(f);
});

test('archive final-only reopen re-fsyncs verified files without rewriting them or sweeping other files', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  const directory = join(f.target, 'source'),
    extra = join(directory, '.unplanned.tmp');
  await fs.writeFile(extra, 'not ours to remove', { mode: 0o600 });
  const before = await Promise.all(
    Object.keys(f.files).map((name) => identity(join(directory, name))),
  );
  const open = fs.open,
    synced = [];
  t.mock.method(fs, 'open', async (path, ...args) => {
    const file = await open(path, ...args);
    const name = String(path).split('/').at(-1);
    if (Object.hasOwn(f.files, name)) {
      const sync = file.sync.bind(file);
      t.mock.method(file, 'sync', async () => {
        await sync();
        synced.push(name);
      });
    }
    return file;
  });
  syncBuiltinESMExports();
  try {
    await f.store.prepare();
  } finally {
    restoreMocks(t);
  }
  assert.deepEqual(synced.sort(), Object.keys(f.files).sort());
  assert.deepEqual(
    await Promise.all(
      Object.keys(f.files).map((name) => identity(join(directory, name))),
    ),
    before,
  );
  assert.equal(await fs.readFile(extra, 'utf8'), 'not ours to remove');
  await unchangedOriginal(f);
});
