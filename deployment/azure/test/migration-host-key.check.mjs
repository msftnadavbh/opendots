import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { migrationFixture } from './migration-fixture.mjs';
import { SCUS_PROFILE } from '../profiles.mjs';

async function preserved(t) {
  const f = await migrationFixture(t);
  await f.prepare();
  for (const stage of ['group', 'capture', 'copy']) await f.stage(stage);
  return f;
}
const keyPath = (f) =>
  join(
    f.target,
    SCUS_PROFILE.artifacts.hostKey.directory,
    SCUS_PROFILE.artifacts.hostKey.privateFile,
  );
const reset = (t) => {
  t.mock.restoreAll();
  syncBuiltinESMExports();
};

test('interrupted key-generation intent never silently starts a second generation', async (t) => {
  const f = await preserved(t),
    mkdir = fs.mkdir;
  const calls = f.calls.length;
  t.mock.method(fs, 'mkdir', async (path, options) => {
    await mkdir(path, options);
    if (String(path).endsWith('/host-key'))
      throw new Error('key-directory boundary');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.prepareHost(), /key-directory boundary/);
  } finally {
    reset(t);
  }
  const before = await f.diskState();
  assert.equal(before.stages.host.preparation.status, 'key-generation-intent');
  await f.close();
  await f.open();
  await assert.rejects(f.prepareHost());
  await assert.rejects(fs.lstat(keyPath(f)), { code: 'ENOENT' });
  assert.deepEqual(await f.diskState(), before);
  assert.equal(f.calls.length, calls);
  await assert.rejects(f.controller.preflight('host'), /preparation/);
});

for (const boundary of [
  'private-fsync',
  'before-complete-journal',
  'after-complete-journal',
])
  test(`complete generated key survives ${boundary} interruption and is finalized without rotation`, async (t) => {
    const f = await preserved(t),
      open = fs.open,
      rename = fs.rename;
    let fault = false;
    t.mock.method(fs, 'open', async (path, ...args) => {
      const file = await open(path, ...args);
      if (
        boundary === 'private-fsync' &&
        String(path).endsWith('/id_ed25519')
      ) {
        const sync = file.sync.bind(file);
        t.mock.method(file, 'sync', async () => {
          await sync();
          fault = true;
          throw new Error('key fsync boundary');
        });
      }
      return file;
    });
    t.mock.method(fs, 'rename', async (from, to) => {
      if (
        String(to).endsWith('/migration-state.json') &&
        boundary.includes('complete-journal')
      ) {
        const pending = JSON.parse(await fs.readFile(from, 'utf8'));
        if (pending.stages.host?.preparation?.status === 'complete') {
          if (boundary === 'after-complete-journal') await rename(from, to);
          fault = true;
          throw new Error('completed key journal boundary');
        }
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.prepareHost());
    } finally {
      reset(t);
    }
    assert(fault);
    const key = await fs.readFile(keyPath(f));
    await f.close();
    await f.open();
    await f.prepareHost();
    assert((await fs.readFile(keyPath(f))).equals(key));
    assert.equal(
      (await f.diskState()).stages.host.preparation.status,
      'complete',
    );
    assert.equal(
      (await f.controller.preflight('host')).status,
      'preflight-only',
    );
  });

test('untracked host key directory or public parameters are not adopted into key preparation', async (t) => {
  for (const entry of ['directory', 'parameters']) {
    const f = await preserved(t);
    if (entry === 'directory')
      await fs.mkdir(join(f.target, SCUS_PROFILE.artifacts.hostKey.directory), {
        mode: 0o700,
      });
    else
      await fs.writeFile(
        join(f.target, SCUS_PROFILE.artifacts.hostPublicParameters),
        '{}',
        { mode: 0o600 },
      );
    await assert.rejects(f.prepareHost(), /Untracked target host key/);
    assert(!(await f.diskState()).stages.host?.preparation);
  }
});

for (const fault of [
  'missing-private',
  'wrong-private-mode',
  'symlink-private',
  'hardlink-private',
  'changed-public',
  'changed-parameters',
])
  test(`host key ${fault} after possible VM creation stops without rotating or repairing bindings`, async (t) => {
    const f = await preserved(t);
    await f.prepareHost();
    f.createFault = 'before';
    await assert.rejects(f.stage('host'));
    const state = await f.diskState(),
      key = await fs.readFile(keyPath(f));
    if (fault === 'missing-private') await fs.unlink(keyPath(f));
    if (fault === 'wrong-private-mode') await fs.chmod(keyPath(f), 0o644);
    if (fault === 'symlink-private') {
      await fs.unlink(keyPath(f));
      await fs.symlink(join(f.original, 'vm-state.json'), keyPath(f));
    }
    if (fault === 'hardlink-private')
      await fs.link(keyPath(f), join(f.root, 'unplanned-key-link'));
    if (fault === 'changed-public')
      await fs.writeFile(`${keyPath(f)}.pub`, 'invalid public key\n');
    if (fault === 'changed-parameters')
      await fs.writeFile(
        join(f.target, SCUS_PROFILE.artifacts.hostPublicParameters),
        '{}',
      );
    await f.close();
    await f.open();
    await assert.rejects(f.prepareHost());
    await assert.rejects(f.controller.apply('host'), /durable intent/);
    assert.deepEqual(await f.diskState(), state);
    if (!['missing-private', 'symlink-private'].includes(fault))
      assert((await fs.readFile(keyPath(f))).equals(key));
    if (fault === 'missing-private')
      await assert.rejects(fs.lstat(keyPath(f)), { code: 'ENOENT' });
    assert.equal(f.creates.filter((stage) => stage === 'host').length, 1);
  });

for (const stage of ['host', 'model-role'])
  test(`B1 ${stage} final Graph failure leaves no new intent or create`, async (t) => {
    const f = await preserved(t);
    await f.prepareHost();
    if (stage === 'model-role') await f.stage('host');
    await f.controller.validate(stage);
    await f.review(stage);
    const state = await f.diskState(),
      create = f.az.createWithIntent,
      key = await fs.readFile(keyPath(f));
    let final = false,
      hit = false;
    f.az.createWithIntent = (...args) => {
      final = true;
      return create(...args);
    };
    f.beforeCall = (args) => {
      if (
        final &&
        args[0] === 'rest' &&
        args.includes('https://graph.microsoft.com/v1.0/me?$select=id')
      ) {
        hit = true;
        throw new Error('private authentication error');
      }
    };
    await assert.rejects(f.controller.apply(stage), /Azure CLI/);
    assert(hit);
    assert.deepEqual(await f.diskState(), state);
    assert(!f.creates.includes(stage));
    assert((await fs.readFile(keyPath(f))).equals(key));
  });

for (const stage of ['host', 'model-role'])
  for (const boundary of ['before', 'after'])
    test(`B1 ${stage} intent durability failure ${boundary} publication prevents create and retains key and historical evidence`, async (t) => {
      const f = await preserved(t);
      await f.prepareHost();
      if (stage === 'model-role') await f.stage('host');
      await f.controller.validate(stage);
      await f.review(stage);
      const save = f.store.save,
        original = await f.diskState(),
        key = await fs.readFile(keyPath(f));
      f.store.save = async (value) => {
        if (value.stages[stage]?.intent) {
          if (boundary === 'after') await save(value);
          throw new Error('intent durability boundary');
        }
        return save(value);
      };
      await assert.rejects(
        f.controller.apply(stage),
        /intent durability boundary/,
      );
      const recorded = await f.diskState();
      assert.equal(!!recorded.stages[stage].intent, boundary === 'after');
      assert(!f.creates.includes(stage));
      await f.close();
      await f.open();
      await f.prepareHost();
      assert((await fs.readFile(keyPath(f))).equals(key));
      for (const name of ['group', 'capture', 'copy'])
        assert.deepEqual(
          (await f.diskState()).stages[name],
          original.stages[name],
        );
      if (boundary === 'after') {
        await assert.rejects(f.controller.apply(stage), /durable intent/);
        assert.equal((await f.controller.reconcile(stage)).status, 'pending');
      }
    });
