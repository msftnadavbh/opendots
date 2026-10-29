import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createAz } from '../cloud.mjs';
import { SCUS_PROFILE } from '../profiles.mjs';
import { hashObject } from '../migration-state.mjs';
import { migrationFixture } from './migration-fixture.mjs';

const createArgs = (f) => [
  'deployment',
  'sub',
  'create',
  '--name',
  SCUS_PROFILE.stages.group.deploymentName,
  '--location',
  SCUS_PROFILE.compute.location,
  '--template-file',
  f.store.deploymentPath('group-template.json'),
  '--parameters',
  `@${f.store.deploymentPath('group-parameters.json')}`,
  '--no-wait',
];
const journal = (f) => fs.readFile(join(f.target, 'migration-state.json'));
async function reviewed(t) {
  const f = await migrationFixture(t);
  await f.prepare();
  await f.controller.validate('group');
  await f.review('group');
  return f;
}
function finalBoundary(f) {
  const create = f.az.createWithIntent;
  f.az.createWithIntent = (...args) => {
    f.finalAuth = true;
    return create(...args);
  };
}

test('target CREATE has one mandatory internal callback, no read/write escape or original-client capability', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  assert.equal(createAz(f.run).createWithIntent, undefined);
  assert.deepEqual(Object.keys(f.az).sort(), [
    'createWithIntent',
    'profile',
    'read',
    'verify',
    'write',
  ]);
  const before = await journal(f),
    args = createArgs(f);
  for (const callback of [undefined, null, false, {}])
    await assert.rejects(f.az.createWithIntent(args, callback), /callback/);
  for (const method of ['read', 'write'])
    await assert.rejects(f.az[method](args));
  await assert.rejects(
    f.az.createWithIntent(
      [...args.slice(0, 2), 'validate', ...args.slice(3)],
      async () => {},
    ),
  );
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    f.az.createWithIntent(args, async () => {
      throw new Error('callback failed');
    }),
    /callback failed/,
  );
  assert.deepEqual(
    f.calls.map((args) => args[0]),
    ['account', 'rest'],
  );
  assert.deepEqual(f.creates, []);
  assert((await journal(f)).equals(before));
});

test('target CREATE rejects invalid exact arguments/options/environment before authentication, callback or new intent', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  const before = await journal(f),
    args = createArgs(f);
  let callbacks = 0;
  const callback = async () => {
    callbacks++;
  };
  for (const options of [
    null,
    [],
    { env: {} },
    { shell: true },
    { skipVerify: true },
    { alreadyVerified: true },
    { timeoutMs: -1 },
    { timeoutMs: 1.5 },
    { timeoutMs: '100' },
    { timeoutMs: Infinity },
    { signal: {} },
  ])
    await assert.rejects(f.az.createWithIntent(args, callback, options));
  for (const invalid of [
    null,
    {},
    [...args, '--debug'],
    args.slice(0, -1),
    args.map((arg) => (arg === 'southcentralus' ? 'eastus2' : arg)),
    args.map((arg) => (arg === '--no-wait' ? '--confirm-with-what-if' : arg)),
  ])
    await assert.rejects(f.az.createWithIntent(invalid, callback));
  const previous = process.env.AZURE_LOCATION;
  process.env.AZURE_LOCATION = 'foreign';
  try {
    await assert.rejects(f.az.createWithIntent(args, callback), /conflicts/);
  } finally {
    if (previous === undefined) delete process.env.AZURE_LOCATION;
    else process.env.AZURE_LOCATION = previous;
  }
  assert.equal(callbacks, 0);
  assert.deepEqual(f.calls, []);
  assert((await journal(f)).equals(before));
});

for (const fault of [
  'account-error',
  'account-subscription',
  'account-tenant',
  'account-principal-type',
  'graph-error',
  'graph-principal',
])
  test(`final ${fault} fails before new durable intent and create, not an earlier preflight`, async (t) => {
    const f = await reviewed(t);
    finalBoundary(f);
    const before = await journal(f),
      finalCalls = [];
    f.beforeCall = (args) => {
      if (!f.finalAuth) return;
      finalCalls.push(args[0]);
      if (args[0] === 'account') {
        if (fault === 'account-error')
          throw new Error('private account failure');
        if (fault === 'account-subscription') f.account.id = 'foreign';
        if (fault === 'account-tenant') f.account.tenantId = 'foreign';
        if (fault === 'account-principal-type')
          f.account.user.type = 'servicePrincipal';
      }
      if (args[0] === 'rest') {
        if (fault === 'graph-error') throw new Error('private Graph failure');
        if (fault === 'graph-principal') f.principal = 'foreign';
      }
    };
    await assert.rejects(
      f.controller.apply('group'),
      /Azure CLI|authorized pilot/,
    );
    assert.deepEqual(
      finalCalls,
      fault === 'account-error' ? ['account'] : ['account', 'rest'],
    );
    assert.deepEqual(f.creates, []);
    assert((await journal(f)).equals(before));
    assert(!(await f.diskState()).stages.group.intent);
  });

for (const file of ['template', 'parameters'])
  test(`callback rechecks exact ${file} bytes after final Graph and before saving intent`, async (t) => {
    const f = await reviewed(t);
    finalBoundary(f);
    const before = await journal(f);
    f.afterCall = async (args) => {
      if (f.finalAuth && args[0] === 'rest') {
        const name = `group-${file}.json`;
        await f.store.write(
          name,
          (await f.store.readBytes(name)).toString() + ' ',
        );
      }
    };
    await assert.rejects(
      f.controller.apply('group'),
      /request bytes or parameters/,
    );
    assert.deepEqual(f.creates, []);
    assert((await journal(f)).equals(before));
    assert.equal(f.calls.at(-1)[0], 'rest');
  });

test('CREATE freezes caller arguments/options and the validated environment through both auth calls and callback', async (t) => {
  const f = await reviewed(t),
    create = f.az.createWithIntent;
  const controller = new AbortController(),
    other = new AbortController();
  const options = { signal: controller.signal, timeoutMs: 32100 };
  const previous = {
    AZURE_LOCATION: process.env.AZURE_LOCATION,
    DEBUG: process.env.DEBUG,
  };
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let callerArgs,
    expectedArgs,
    entered = false;
  f.az.createWithIntent = (args, callback) => {
    f.finalAuth = true;
    callerArgs = args;
    expectedArgs = [...args];
    process.env.AZURE_LOCATION = SCUS_PROFILE.compute.location;
    return create(args, callback, options);
  };
  f.beforeCall = (args, execution) => {
    if (!f.finalAuth || entered) return;
    assert(Object.isFrozen(execution));
    assert(Object.isFrozen(execution.env));
    assert.equal(execution.signal, controller.signal);
    assert.equal(execution.timeout, 32100);
    assert.equal(execution.env.AZURE_LOCATION, SCUS_PROFILE.compute.location);
    assert.equal(execution.env.DEBUG, previous.DEBUG);
    if (args[0] === 'account') {
      callerArgs[2] = 'delete';
      callerArgs.push('--debug');
      options.signal = other.signal;
      options.timeoutMs = 1;
      options.env = { DEBUG: 'bad' };
      process.env.AZURE_LOCATION = 'foreign';
      process.env.DEBUG = 'bad';
    } else if (args[2] === 'create') {
      assert.deepEqual(args, expectedArgs);
      entered = true;
      restore();
    }
  };
  try {
    assert.equal((await f.controller.apply('group')).status, 'complete');
  } finally {
    restore();
  }
  assert(entered);
  assert.deepEqual(f.creates, ['group']);
});

test('validate/what-if write preparation cannot be mutated into CREATE during authentication', async (t) => {
  const f = await reviewed(t);
  const args = [...createArgs(f).slice(0, -1)];
  args[2] = 'validate';
  args.push('--validation-level', 'Provider');
  const expected = [...args],
    before = await journal(f);
  f.beforeCall = (call) => {
    if (call[0] === 'account') args[2] = 'create';
  };
  await f.az.write(args);
  assert.deepEqual(f.calls.at(-1), expected);
  assert.deepEqual(f.creates, []);
  assert((await journal(f)).equals(before));
});

test('final authentication → unconditional intent file/rename/directory durability → one CREATE has no post-intent auth', async (t) => {
  const f = await reviewed(t);
  finalBoundary(f);
  const directory = f.store
    .path('migration-state.json')
    .replace('/migration-state.json', '');
  const open = fs.open,
    rename = fs.rename,
    events = [];
  let created = false,
    intended;
  const save = f.store.save;
  f.store.save = async (value) => {
    if (!created) {
      assert(f.finalAuth);
      assert.equal(events.at(-1), 'rest');
      intended = structuredClone(value);
    }
    return save(value);
  };
  f.beforeCall = async (args) => {
    if (!f.finalAuth || created) return;
    if (args[2] === 'create') {
      assert.deepEqual(await f.diskState(), intended);
      assert.equal(
        intended.stages.group.intent.requestSha256,
        hashObject(intended.stages.group.intent.request),
      );
      created = true;
      events.push('create');
    } else events.push(args[0]);
  };
  t.mock.method(fs, 'open', async (path, ...args) => {
    const file = await open(path, ...args);
    if (String(path).includes('/migration-state.json.') || path === directory) {
      const sync = file.sync.bind(file);
      t.mock.method(file, 'sync', async () => {
        await sync();
        if (f.finalAuth && !created)
          events.push(path === directory ? 'directory-fsync' : 'file-fsync');
      });
    }
    return file;
  });
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (f.finalAuth && !created && String(to).endsWith('/migration-state.json'))
      events.push('rename');
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await f.controller.apply('group')).status, 'complete');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(events, [
    'account',
    'rest',
    'file-fsync',
    'rename',
    'directory-fsync',
    'create',
  ]);
  assert.deepEqual(
    (await f.diskState()).stages.group.intent,
    intended.stages.group.intent,
  );
});

for (const publication of ['before', 'after'])
  test(`real intent save failure ${publication} journal publication prevents CREATE and preserves all observed facts`, async (t) => {
    const f = await reviewed(t);
    finalBoundary(f);
    const before = await journal(f),
      rename = fs.rename;
    let failed = false;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (f.finalAuth && String(to).endsWith('/migration-state.json')) {
        if (publication === 'after') await rename(from, to);
        failed = true;
        throw new Error('journal publication fault');
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.controller.apply('group'), /durability failed/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert(failed);
    assert.equal(f.calls.at(-1)[0], 'rest');
    assert.deepEqual(f.creates, []);
    const observed = await f.diskState();
    assert.equal(!!observed.stages.group.intent, publication === 'after');
    if (publication === 'before') assert((await journal(f)).equals(before));
    await assert.rejects(f.store.save(observed), /durability is uncertain/);
    await f.close();
    await f.open();
    if (publication === 'after') {
      await assert.rejects(f.controller.apply('group'), /durable intent/);
      assert.equal((await f.controller.reconcile('group')).status, 'pending');
      assert.deepEqual(
        (await f.diskState()).stages.group.intent,
        observed.stages.group.intent,
      );
    }
    assert.deepEqual(f.creates, []);
  });
