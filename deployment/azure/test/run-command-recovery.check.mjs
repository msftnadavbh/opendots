import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  managedTransport,
  managedScript,
  runCommandClient,
} from '../run-command.mjs';
import { inspectGroupBeforeDeployment } from '../cloud.mjs';
import { rootCommand } from '../ssh.mjs';
import { SCOPE, TAGS, GROUP_ID, safeError } from '../scope.mjs';
import { managedFixture, fixtureAuth } from './managed-fixture.mjs';
import { vmResources } from './fixtures.mjs';

const execute = promisify(execFile);
const secret = 'FAKE-REVIEW-PROTECTED-INPUT-NOT-A-CREDENTIAL';
const other = '99999999-9999-9999-9999-999999999999';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const specOf = (body) =>
  JSON.parse(
    JSON.parse(
      body.properties.source.script
        .split('\nmain(json.loads(')[1]
        .split('))\n')[0],
    ),
  );

function copies(t, input = secret) {
  const values = [],
    from = Buffer.from;
  t.mock.method(Buffer, 'from', function (value, ...args) {
    const bytes = from.call(this, value, ...args);
    if (value === input) values.push(bytes);
    return bytes;
  });
  return () => {
    assert.equal(values.length, 1);
    assert(
      values[0].every((byte) => byte === 0),
      'Every private input copy is cleaned on early exits',
    );
  };
}

function realPutFailure(f, mode) {
  const az =
    mode === 'claims' ? fixtureAuth({ oid: 'foreign' }) : fixtureAuth();
  const calls = [];
  if (mode === 'verify')
    az.verify = async () => {
      throw new Error(secret);
    };
  if (mode === 'token')
    az.read = async () => {
      throw new Error(secret);
    };
  if (mode === 'abort-verify')
    az.verify = async () => {
      f.controller.abort();
    };
  if (mode === 'abort-token') {
    const read = az.read;
    az.read = async (...args) => {
      const token = await read(...args);
      f.controller.abort();
      return token;
    };
  }
  const client = runCommandClient(az, (_url, init) => {
    calls.push(init.method);
    if (mode === 'abort-fetch') f.controller.abort();
    if (mode === 'http403') return new Response(secret, { status: 403 });
    throw new Error(secret); // Deliberately synchronous: invocation is already unknown.
  });
  let body;
  f.client.put = async (value, signal) => {
    body = value;
    if (mode === 'serialization')
      value.toJSON = () => {
        throw new Error(secret);
      };
    const before = process.env.DEBUG;
    try {
      if (mode === 'environment') process.env.DEBUG = 'fixture';
      return await client.put(value, signal);
    } finally {
      if (before === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = before;
    }
  };
  return { calls, body: () => body };
}

for (const mode of [
  'environment',
  'verify',
  'token',
  'claims',
  'serialization',
  'abort-verify',
  'abort-token',
])
  test(`real PUT ${mode} preflight proves zero fetch calls and durably restores prior management`, async (t) => {
    const f = managedFixture();
    await f.approveFixture();
    const prior = structuredClone(f.state.management);
    const cleaned = copies(t),
      request = realPutFailure(f, mode);
    await assert.rejects(
      f.guest.run('cat >/dev/null', { input: secret }),
      (error) => {
        assert.match(safeError(error), /not dispatched/);
        assert(!safeError(error).includes(secret));
        return true;
      },
    );
    assert.deepEqual(request.calls, []);
    assert.deepEqual(f.state.management, prior);
    assert.deepEqual(f.durable.management, prior);
    assert(f.saved.at(-2).management.pending);
    assert(!f.saved.at(-1).management.pending);
    assert.deepEqual(request.body().properties.protectedParameters, []);
    cleaned();
  });

test('proven nondispatch restores absence of management rather than inventing a prior receipt', async () => {
  const f = managedFixture(),
    request = realPutFailure(f, 'verify');
  await assert.rejects(f.guest.run('true'), /not dispatched/);
  assert(!Object.hasOwn(f.state, 'management'));
  assert(!Object.hasOwn(f.durable, 'management'));
  assert.deepEqual(request.calls, []);
});

for (const mode of ['sync-fetch-throw', 'abort-fetch', 'http403'])
  test(`${mode} after HTTP invocation remains pending, even if no new resource is visible`, async (t) => {
    const f = managedFixture();
    await f.approveFixture();
    const cleaned = copies(t),
      request = realPutFailure(f, mode);
    const prior = structuredClone(f.state.management.receipt);
    await assert.rejects(
      f.guest.run('cat >/dev/null', { input: secret }),
      (error) => !safeError(error).includes(secret),
    );
    assert.deepEqual(request.calls, ['PUT']);
    assert(f.state.management.pending);
    assert.deepEqual(f.state.management.receipt, prior);
    assert(f.durable.management.pending);
    assert.deepEqual(request.body().properties.protectedParameters, []);
    cleaned();
  });

test('a name/message look-alike cannot claim the real client nondispatch type', async () => {
  const f = managedFixture();
  f.client.put = async () => {
    const error = new Error('Managed Run Command PUT was not dispatched');
    error.name = 'NotDispatchedError';
    throw error;
  };
  await assert.rejects(f.guest.run('true'), /interrupted/);
  assert(f.state.management.pending);
});

test('a real earlier nondispatch error thrown by fetch is still an unknown current submission', async () => {
  let earlier;
  try {
    await runCommandClient(fixtureAuth({ oid: 'foreign' }), () =>
      assert.fail(),
    ).put({});
  } catch (error) {
    earlier = error;
  }
  const f = managedFixture();
  let calls = 0;
  f.client.put = runCommandClient(fixtureAuth(), () => {
    calls++;
    throw earlier;
  }).put;
  await assert.rejects(f.guest.run('true'), /interrupted/);
  assert.equal(calls, 1);
  assert(f.state.management.pending);
});

for (const boundary of ['before-intent', 'after-intent', 'client-preflight'])
  test(`canary abort/failure ${boundary} never resurrects a durably invalidated approval`, async () => {
    let armed = false;
    const f = managedFixture({
      afterSave: async (next) => {
        if (armed && boundary === 'after-intent' && next.management?.pending)
          f.controller.abort();
      },
    });
    await f.approveFixture();
    const prior = structuredClone(f.state.management),
      before = f.saved.length;
    armed = true;
    if (boundary === 'before-intent') {
      const get = f.client.get;
      f.client.get = async (...args) => {
        const resource = await get(...args);
        f.controller.abort();
        return resource;
      };
    }
    const request =
      boundary === 'client-preflight'
        ? realPutFailure(f, 'verify')
        : { calls: [] };
    if (boundary !== 'client-preflight')
      f.client.put = () =>
        assert.fail('Pre-call abort cannot invoke the client');
    await assert.rejects(f.guest.canary());
    assert.deepEqual(request.calls, []);
    if (boundary === 'before-intent') {
      assert.deepEqual(f.state.management, prior);
      assert.equal(f.saved.length, before);
    } else {
      delete prior.privacyValidation;
      delete prior.canary;
      assert.deepEqual(f.state.management, prior);
      assert.deepEqual(f.durable.management, prior);
      assert.equal(f.saved.length, before + 2);
    }
  });

for (const afterPublication of [false, true])
  test(`failed nondispatch rollback ${afterPublication ? 'after' : 'before'} publication poisons transport and requires persistent reload`, async () => {
    let armed = false;
    const fault = async (next) => {
      if (armed && !next.management?.pending) throw new Error(secret);
    };
    const f = managedFixture({
      [afterPublication ? 'afterSave' : 'beforeSave']: fault,
    });
    await f.approveFixture();
    armed = true;
    const request = realPutFailure(f, 'verify');
    await assert.rejects(f.guest.canary(), /durability/);
    assert(f.state.management.pending);
    assert(!f.state.management.canary && !f.state.management.privacyValidation);
    await assert.rejects(f.guest.run('true'), /uncertain local save/);
    assert.deepEqual(request.calls, []);
    const reloaded = structuredClone(f.durable);
    const guest = managedTransport({
      az: {},
      state: reloaded,
      save: () => assert.fail('A stale/missing resource is not completion'),
      client: { ...f.client, put: () => assert.fail('No resubmission') },
      wait: async () => {
        throw new Error('fixture polling deadline');
      },
    });
    assert(
      !reloaded.management.canary && !reloaded.management.privacyValidation,
    );
    if (afterPublication) {
      assert(!reloaded.management.pending);
      assert.equal(await guest.reconcile(), undefined);
    } else {
      await assert.rejects(guest.reconcile(), /interrupted/);
      assert(
        reloaded.management.pending,
        'Lost in-memory nondispatch proof cannot clear the saved intent',
      );
      f.resource = undefined;
      await assert.rejects(guest.reconcile(), /unknown/);
      assert(reloaded.management.pending);
    }
  });

for (const mode of ['gate', 'get', 'intent-save', 'pre-call-abort'])
  test(`protected bytes are cleaned after early ${mode} failure`, async (t) => {
    let armed = false;
    const f = managedFixture({
      beforeSave: async (next) => {
        if (armed && next.management?.pending) {
          if (mode === 'intent-save') throw new Error(secret);
          if (mode === 'pre-call-abort') f.controller.abort();
        }
      },
    });
    if (mode !== 'gate') await f.approveFixture();
    armed = true;
    if (mode === 'get')
      f.client.get = async () => {
        throw new Error(secret);
      };
    const cleaned = copies(t);
    await assert.rejects(f.guest.run('cat >/dev/null', { input: secret }));
    cleaned();
  });

test('private input cleanup also covers oversize and public-source rejection without changing the caller buffer', async (t) => {
  const large = Buffer.alloc(65537, 7);
  const f = managedFixture(),
    cleaned = copies(t, large);
  await assert.rejects(f.guest.run('true', { input: large }), /64 KiB/);
  cleaned();
  assert(large.every((byte) => byte === 7));
  t.mock.restoreAll();
  await f.approveFixture();
  const sourceCleaned = copies(t);
  await assert.rejects(
    f.guest.run(secret, { input: secret }),
    /public managed source/,
  );
  sourceCleaned();
  assert(!f.state.management.pending);
});

test('polling accepts only whole-old, pending-source/old-completion, then valid pending execution; it never saves old as new', async () => {
  let prior,
    pending,
    waits = 0;
  const f = managedFixture({
    afterPut: async (f) => {
      if (prior) {
        pending = structuredClone(f.resource);
        f.resource = structuredClone(prior);
      }
    },
    wait: async () => {
      assert(f.state.management.pending);
      assert.equal(
        f.state.management.receipt.operationId,
        prior.tags.operationId,
      );
      waits++;
      if (waits === 1)
        f.resource = {
          ...pending,
          properties: {
            ...pending.properties,
            instanceView: prior.properties.instanceView,
          },
        };
      else if (waits === 2)
        f.resource = {
          ...pending,
          properties: {
            ...pending.properties,
            instanceView: { executionState: 'Running' },
          },
        };
      else f.resource = structuredClone(pending);
    },
  });
  await f.guest.run('true');
  prior = structuredClone(f.resource);
  await f.guest.run('true', { timeoutMs: 60_000 });
  assert.equal(waits, 3);
  assert.equal(f.requests.length, 2);
  assert(!f.state.management.pending);
  assert.equal(
    f.state.management.receipt.operationId,
    pending.tags.operationId,
  );
  assert.notEqual(
    f.state.management.receipt.operationId,
    prior.tags.operationId,
  );
});

for (const kind of ['old-resource', 'old-view'])
  test(`persistent ${kind} is polled only until deadline, never retried or accepted as pending completion`, async () => {
    let prior;
    const f = managedFixture({
      afterPut: async (f) => {
        if (prior)
          f.resource =
            kind === 'old-resource'
              ? structuredClone(prior)
              : {
                  ...f.resource,
                  properties: {
                    ...f.resource.properties,
                    instanceView: prior.properties.instanceView,
                  },
                };
      },
    });
    await f.guest.run('true');
    prior = structuredClone(f.resource);
    await assert.rejects(
      f.guest.run('true', {
        timeoutMs: 31_000,
        signal: AbortSignal.timeout(1000),
      }),
      /interrupted/,
    );
    assert.equal(f.requests.length, 2);
    assert(f.state.management.pending);
    assert.equal(
      f.state.management.receipt.operationId,
      prior.tags.operationId,
    );
  });

for (const mutation of [
  'new-tags-old-source',
  'old-tags-new-source',
  'old-tags-new-view',
  'timeout',
  'extra-tag',
  'unknown-view-id',
  'changed-prior-result',
  'changed-prior-category',
  'malformed-terminal',
  'unknown-execution',
])
  test(`mixed/foreign ${mutation} fails closed rather than being treated as transient`, async () => {
    const f = managedFixture();
    await f.guest.run('true', { schema: 'image' });
    const prior = structuredClone(f.resource),
      priorReceipt = structuredClone(f.state.management.receipt);
    f.putFailure = 'after';
    await assert.rejects(f.guest.run('true', { timeoutMs: 60_000 }));
    const pending = structuredClone(f.resource);
    f.resource.properties.instanceView = structuredClone(
      prior.properties.instanceView,
    );
    if (mutation === 'new-tags-old-source')
      f.resource.properties.source = prior.properties.source;
    if (mutation === 'old-tags-new-source') f.resource.tags = prior.tags;
    if (mutation === 'old-tags-new-view')
      f.resource = {
        ...prior,
        properties: {
          ...prior.properties,
          instanceView: pending.properties.instanceView,
        },
      };
    if (mutation === 'timeout')
      f.resource.properties.timeoutInSeconds =
        prior.properties.timeoutInSeconds;
    if (mutation === 'extra-tag') f.resource.tags.foreign = 'not-approved';
    if (
      [
        'unknown-view-id',
        'changed-prior-result',
        'changed-prior-category',
      ].includes(mutation)
    ) {
      const value = JSON.parse(f.resource.properties.instanceView.output);
      if (mutation === 'unknown-view-id') value.operationId = other;
      if (mutation === 'changed-prior-result') value.result = 'true';
      if (mutation === 'changed-prior-category') value.category = 'deadline';
      f.resource.properties.instanceView.output = JSON.stringify(value);
    }
    if (mutation === 'malformed-terminal')
      f.resource.properties.instanceView.output = secret;
    if (mutation === 'unknown-execution')
      f.resource.properties.instanceView = { executionState: 'Other' };
    await assert.rejects(
      f.guest.reconcile(),
      (error) => !safeError(error).includes(secret),
    );
    assert(f.state.management.pending);
    assert.deepEqual(f.state.management.receipt, priorReceipt);
    assert.equal(f.requests.length, 2);
  });

for (const mutation of [
  'category',
  'execution-state',
  'missing-failure-state',
  'binding',
  'schema',
])
  test(`pending public source cannot hide a changed prior failure ${mutation}`, async () => {
    const f = managedFixture(),
      put = f.client.put;
    f.client.put = async (...args) => {
      await put(...args);
      f.result = '';
      f.complete(7, 'command-failed');
    };
    await assert.rejects(f.guest.run('false'), /exit 7/);
    const prior = structuredClone(f.resource);
    f.client.put = put;
    f.putFailure = 'after';
    await assert.rejects(f.guest.run('true'));
    f.resource.properties.instanceView = structuredClone(
      prior.properties.instanceView,
    );
    if (mutation === 'category') {
      const value = JSON.parse(f.resource.properties.instanceView.output);
      value.category = 'invalid-output';
      f.resource.properties.instanceView.output = JSON.stringify(value);
    }
    if (mutation === 'execution-state')
      f.resource.properties.instanceView.executionState = 'TimedOut';
    if (mutation === 'binding')
      f.state.management.receipt.bindingSha256 = 'a'.repeat(64);
    if (mutation === 'schema') f.state.management.receipt.schema = 'foreign';
    if (mutation === 'missing-failure-state')
      delete f.state.management.receipt.executionState;
    await assert.rejects(f.guest.reconcile());
    assert(f.state.management.pending);
    assert.equal(f.requests.length, 2);
  });

test('inventory recognizes only exact pending or prior binding; read-only status/HTTPS backup preflight does not write Azure', async () => {
  const f = managedFixture();
  await f.guest.run('true');
  const prior = structuredClone(f.resource);
  f.putFailure = 'after';
  await assert.rejects(f.guest.run('true', { timeoutMs: 60_000 }));
  const pending = structuredClone(f.resource),
    state = structuredClone(f.state);
  const resources = [vmResources().vm, prior];
  const az = {
    verify: async () => {},
    write: () => assert.fail('Inventory for backup/status cannot write Azure'),
    read: async (args) => {
      if (args[0] === 'group')
        return args[1] === 'exists'
          ? true
          : { id: GROUP_ID, location: SCOPE.location, tags: TAGS };
      if (args[1] === 'list') return structuredClone(resources);
      const id = args[args.indexOf('--ids') + 1];
      const result = resources.find((r) => r.id === id);
      assert(result);
      return structuredClone(result);
    },
  };
  assert(await inspectGroupBeforeDeployment(az, f.state));
  resources[1] = pending;
  assert(await inspectGroupBeforeDeployment(az, f.state));
  resources[1] = { ...prior, properties: pending.properties };
  await assert.rejects(inspectGroupBeforeDeployment(az, f.state), /drift/);
  resources[1] = prior;
  f.state.management.receipt.bindingSha256 = 'a'.repeat(64);
  await assert.rejects(
    inspectGroupBeforeDeployment(az, f.state),
    /another VM binding/,
  );
  f.state.management.receipt = structuredClone(state.management.receipt);
  assert.deepEqual(f.state, state);
  const source = await readFile(
    new URL('../pilot.mjs', import.meta.url),
    'utf8',
  );
  const backup = source.slice(
    source.indexOf("if (command === 'backup')"),
    source.indexOf('const ssh = managedTransport'),
  );
  assert(backup.includes('backupHttps'));
  assert(!/az\.write|ssh\.run|managedTransport/.test(backup));
});

test('requested timeout leaves 15 seconds beyond execution for reaping/reporting and 15 for client polling', async () => {
  for (const timeoutMs of [
    31_000, 120_000, 240_000, 780_000, 1_260_000, 1_320_000,
  ]) {
    const f = managedFixture();
    await f.guest.run('true', { timeoutMs });
    const body = f.requests[0],
      spec = specOf(body);
    assert(spec.seconds >= 1);
    assert.equal(body.properties.timeoutInSeconds - spec.seconds, 15);
    assert(timeoutMs / 1000 - body.properties.timeoutInSeconds >= 15);
    assert(body.properties.timeoutInSeconds <= 1320);
  }
  for (const timeoutMs of [0, 1000, 30_999, 1_320_001]) {
    const f = managedFixture();
    await assert.rejects(f.guest.run('true', { timeoutMs }), /Invalid bounded/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.saved.length, 0);
  }
});

test('actual wrapper worst-case ten-second reap fits the provider margin', async () => {
  const wrapper = await readFile(
    new URL('../run-command-wrapper.py', import.meta.url),
    'utf8',
  );
  const fixture = `${wrapper}
clock=0
time.monotonic=lambda: clock
class Stream:
 def close(self): pass
class Process:
 pid=123
 stdin=Stream()
 stdout=None
 def poll(self): return None
 def wait(self,timeout):
  global clock
  assert timeout==10
  clock+=10
  return -9
class Select:
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def get_map(self): return {}
 def select(self,seconds):
  global clock
  clock+=seconds
  return []
selectors.DefaultSelector=Select
subprocess.Popen=lambda *args,**kwargs: Process()
os.killpg=lambda *args: None
try: main({'operationId':'${other}','command':'unused','hasInput':False,'schema':'empty','seconds':1})
except SystemExit as exit:
 assert exit.code==124 and 11<=clock<16
`;
  const result = await execute('python3', ['-c', fixture], {
    timeout: 3000,
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).category, 'deadline');
});

for (const leak of [false, true])
  test(`actual canary direct-child environment ${leak ? 'leak is rejected before a later sudo could scrub it' : 'is checked before the locked command'}`, async () => {
    const f = managedFixture();
    await f.guest.canary();
    const body = f.requests[0],
      spec = specOf(body);
    assert.equal(spec.command, rootCommand('true', 60));
    const marker = Buffer.from(
      body.properties.protectedParameters[0].value,
      'base64',
    );
    assert.equal(hash(marker), spec.canarySha256);
    const hook = `
original_popen=subprocess.Popen
def fixture_popen(args,**options):
 assert 'OPENDOTS_PROTECTED_INPUT' not in options['env']
 if ${leak ? 'True' : 'False'}: options['env']['OPENDOTS_PROTECTED_INPUT']='FAKE-LEAK'
 if args[0]=='/usr/bin/python3':
  assert len(args)==3 and args[1]=='-c'
  return original_popen(args,**options)
 assert args[:2]==['/bin/bash','-c'] and 'flock -w 30' in args[2] and 'sudo -n' in args[2]
 options['env'].pop('OPENDOTS_PROTECTED_INPUT',None)
 return original_popen(['/bin/true'],**options)
subprocess.Popen=fixture_popen
`;
    const script = body.properties.source.script.replace(
      '\nmain(json.loads(',
      hook + '\nmain(json.loads(',
    );
    assert(!script.includes(marker.toString()));
    const result = await execute('/bin/sh', ['-c', script], {
      env: {
        PATH: '/usr/bin:/bin',
        OPENDOTS_PROTECTED_INPUT: marker.toString('base64'),
      },
      timeout: 4000,
    }).then(
      (value) => ({ ...value, code: 0 }),
      (error) => error,
    );
    assert.equal(result.stderr, '');
    assert.equal(result.code, leak ? 1 : 0);
    assert.equal(JSON.parse(result.stdout).result, leak ? '' : 'canary-ok');
  });
