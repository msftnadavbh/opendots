import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  managedScript,
  managedTransport,
  runCommandClient,
  PRIVACY_CHECKS,
  assertManagedHandler,
} from '../run-command.mjs';
import { inspectGroupBeforeDeployment } from '../cloud.mjs';
import { RUN_COMMAND, SCOPE, TAGS, GROUP_ID, safeError } from '../scope.mjs';
import { main } from '../pilot.mjs';
import { backupVm, pullImage } from '../vm.mjs';
import {
  managedFixture,
  handlerResource,
  fixtureAuth as auth,
} from './managed-fixture.mjs';
import { state, vmResources, output } from './fixtures.mjs';

const execute = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const operationId = '99999999-9999-9999-9999-999999999999';
const secret = 'FAKE-PROTECTED-INPUT-NOT-A-CREDENTIAL-$;\nsecond line';

async function localWrapper(command, options = {}, input = secret) {
  const spec = {
    operationId,
    command,
    hasInput: true,
    schema: 'empty',
    seconds: 2,
    ...options,
  };
  const script = managedScript(spec);
  assert(!script.includes(secret));
  assert(!script.includes(Buffer.from(secret).toString('base64')));
  try {
    return {
      ...(await execute('/bin/sh', ['-c', script], {
        env: {
          PATH: '/usr/bin:/bin',
          OPENDOTS_PROTECTED_INPUT: Buffer.from(input).toString('base64'),
        },
        timeout: 5000,
        maxBuffer: 4096,
      })),
      code: 0,
    };
  } catch (error) {
    assert(
      Number.isInteger(error.code),
      'Wrapper must terminate, not time out locally',
    );
    return error;
  }
}

test('actual local wrapper delivers named protected env bytes to child stdin, scrubs env, and never uses secret argv/source/output', async () => {
  const command = `/usr/bin/python3 -c 'import sys,os,hashlib; d=sys.stdin.buffer.read(); assert hashlib.sha256(d).hexdigest()=="${hash(secret)}"; assert "OPENDOTS_PROTECTED_INPUT" not in os.environ; assert len(sys.argv)==1; assert set(os.environ)<=set(["PATH","HOME","LANG","LC_CTYPE","PWD","SHLVL","_"]); print("active")'`;
  const result = await localWrapper(command, { schema: 'status' });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    operationId,
    exitCode: 0,
    category: 'ok',
    result: 'active',
  });
  assert(!result.stdout.includes(secret));
});

for (const [name, command, schema, code, category] of [
  ['secret stdout', 'cat', 'image', 65, 'invalid-output'],
  ['secret stderr and exit', 'cat >&2; exit 7', 'empty', 7, 'command-failed'],
  ['output overflow', 'yes', 'status', 65, 'invalid-output'],
  ['deadline and descendants', 'sleep 30 & wait', 'empty', 124, 'deadline'],
])
  test(`actual wrapper suppresses ${name} with a bounded fixed receipt and proper exit status`, async () => {
    const value = await localWrapper(command, { schema, seconds: 0.15 });
    assert.equal(value.code, code);
    assert.equal(value.stderr, '');
    assert.deepEqual(JSON.parse(value.stdout), {
      version: 1,
      operationId,
      exitCode: code,
      category,
      result: '',
    });
    assert(!value.stdout.includes(secret));
  });

test('wrapper rejects unnamed/missing/oversized/bad-base64 input without exposing it', async () => {
  for (const input of [
    undefined,
    '*not-base64*',
    Buffer.alloc(65537).toString('base64'),
  ]) {
    const script = managedScript({
      operationId,
      command: 'exit 99',
      schema: 'empty',
      hasInput: true,
      seconds: 1,
    });
    await assert.rejects(
      execute('/bin/sh', ['-c', script], {
        env: {
          PATH: '/usr/bin:/bin',
          ...(input === undefined ? {} : { OPENDOTS_PROTECTED_INPUT: input }),
        },
        timeout: 3000,
      }),
      (error) => {
        assert.equal(error.code, 64);
        assert.equal(error.stderr, '');
        assert.equal(JSON.parse(error.stdout).category, 'invalid-input');
        return true;
      },
    );
  }
});

test('actual wrapper permits only fixed disk/recovery result fields and bound identities', async () => {
  const disk = {
    operationId: state.operationId,
    vmUniqueId: state.binding.vmUniqueId,
    diskId: state.binding.diskId,
    diskUniqueId: state.binding.diskUniqueId,
    fsUuid: state.fsUuid,
  };
  const recovery = {
    operationId,
    oldUnitSha256: 'a'.repeat(64),
    newUnitSha256: 'b'.repeat(64),
  };
  for (const [schema, expected, result] of [
    ['disk', disk, disk],
    ['recovery', recovery, { ...recovery, status: 'applied' }],
    ['recovery', recovery, { ...recovery, status: 'post-intent-conflict' }],
  ]) {
    const good = await localWrapper(
      'cat',
      { schema, [schema]: expected },
      JSON.stringify(result),
    );
    assert.equal(good.code, 0);
    assert.deepEqual(JSON.parse(good.stdout).result, result);
    for (const bad of [
      { ...result, extra: secret },
      { ...result, operationId: state.binding.vmUniqueId },
    ]) {
      const failed = await localWrapper(
        'cat',
        { schema, [schema]: expected },
        JSON.stringify(bad),
      );
      assert.equal(failed.code, 65);
      assert.equal(JSON.parse(failed.stdout).category, 'invalid-output');
      assert(!failed.stdout.includes(secret));
    }
  }
  const empty = await localWrapper('cat');
  assert.equal(empty.code, 0);
  assert.equal(JSON.parse(empty.stdout).result, '');
  assert(!empty.stdout.includes(secret));
});

test('ARM HTTPS transport fixes origin/path/API, pins user auth, carries protected body only in memory and forbids redirects', async () => {
  const az = auth(),
    requests = [];
  const client = runCommandClient(az, async (url, init) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  });
  const body = {
    properties: {
      protectedParameters: [
        {
          name: 'OPENDOTS_PROTECTED_INPUT',
          value: Buffer.from(secret).toString('base64'),
        },
      ],
    },
  };
  await client.put(body);
  await client.get();
  await client.handler();
  assert.equal(
    requests[0].url,
    `https://management.azure.com${RUN_COMMAND.id}?api-version=2026-04-01`,
  );
  assert.equal(requests[1].url, requests[0].url + '&$expand=instanceView');
  assert.equal(
    requests[2].url,
    `https://management.azure.com${RUN_COMMAND.handlerId}?api-version=2026-04-01&$expand=instanceView`,
  );
  assert(requests.every(({ init }) => init.redirect === 'error'));
  assert.equal(
    JSON.parse(requests[0].init.body).properties.protectedParameters[0].value,
    Buffer.from(secret).toString('base64'),
  );
  assert(!JSON.stringify(az.calls).includes(secret));
  assert(
    !JSON.stringify(az.calls).includes(Buffer.from(secret).toString('base64')),
  );
  assert.equal(az.calls.filter((x) => x === 'verify').length, 3);
});

for (const code of [301, 302, 307, 400, 401, 403, 409, 429, 500])
  test(`HTTP ${code} never reads/logs the provider error or follows a redirect`, async () => {
    let read = false,
      cancelled = false;
    const client = runCommandClient(auth(), async (_url, init) => {
      assert.equal(init.redirect, 'error');
      return {
        status: code,
        body: {
          cancel: async () => {
            cancelled = true;
          },
          getReader: () => {
            read = true;
            throw new Error(secret);
          },
        },
      };
    });
    await assert.rejects(
      client.put({}),
      (error) => !safeError(error).includes(secret),
    );
    assert(cancelled);
    assert(!read);
  });

test('auth drift, fetch errors, malformed JSON and oversized responses fail sanitized', async () => {
  for (const patch of [
    { oid: 'foreign' },
    { tid: 'foreign' },
    { aud: 'https://evil.example/' },
    { exp: 1 },
  ])
    await assert.rejects(
      runCommandClient(auth(patch), () =>
        assert.fail('Foreign auth cannot fetch'),
      ).get(),
      /ARM credential/,
    );
  await assert.rejects(
    runCommandClient(auth({}, { subscription: 'foreign' }), () =>
      assert.fail(),
    ).get(),
    /ARM credential/,
  );
  for (const response of [
    () => {
      throw new Error(secret);
    },
    () => new Response(secret),
    () => new Response('x'.repeat(131073)),
  ])
    await assert.rejects(
      runCommandClient(auth(), response).get(),
      (error) => !safeError(error).includes(secret),
    );
});

test('protected operations and legacy backup fail closed before gate/token/private reads; canary alone is not approval', async () => {
  const f = managedFixture();
  await assert.rejects(
    f.guest.run('true', { input: secret }),
    /privacy canary/,
  );
  assert.equal(f.requests.length, 0);
  await f.guest.canary();
  assert(!f.state.management.privacyValidation);
  await assert.rejects(
    f.guest.run('true', { input: secret }),
    /privacy canary/,
  );
  await assert.rejects(
    backupVm(f.guest, '/no-such-backup-directory'),
    /retired/,
  );
  await assert.rejects(
    main(['backup', 'unexpected']),
    /Unknown command or arguments/,
  );
  await assert.rejects(
    main(['prepare', '8.8.8.8/32']),
    /preparation is retired/,
  );
  await assert.rejects(
    pullImage({
      az: { read: () => assert.fail('No token or policy read before gate') },
      ssh: f.guest,
      state: f.state,
      output,
      image: state.image,
      save: f.save,
    }),
    /privacy canary/,
  );
  assert(!f.state.pullOperationId);
});

test('canary proof must cover every surface and exact VM/handler/transport; real protected input never enters source/tags/state/results', async () => {
  const f = managedFixture();
  await f.guest.canary();
  for (const field of PRIVACY_CHECKS) {
    const proof = f.proof();
    proof.checks[field] = false;
    await assert.rejects(
      f.guest.recordPrivacyValidation(proof),
      /Privacy proof/,
    );
  }
  for (const [key, value] of [
    ['vmUniqueId', 'foreign'],
    ['transportSha256', 'a'.repeat(64)],
    ['canaryOperationId', operationId],
    ['plaintextLeaks', true],
    ['evidenceSha256', ''],
    ['validatedAt', '2099-01-01T00:00:00Z'],
  ]) {
    await assert.rejects(
      f.guest.recordPrivacyValidation({ ...f.proof(), [key]: value }),
      /Privacy proof/,
    );
  }
  await f.guest.recordPrivacyValidation(f.proof());
  await f.guest.run('cat >/dev/null', { input: secret });
  const sent = f.requests.at(-1);
  assert.deepEqual(sent.properties.parameters, []);
  assert.deepEqual(sent.properties.protectedParameters, [
    {
      name: 'OPENDOTS_PROTECTED_INPUT',
      value: Buffer.from(secret).toString('base64'),
    },
  ]);
  for (const value of [
    JSON.stringify(f.saved),
    sent.properties.source.script,
    JSON.stringify(sent.tags),
    JSON.stringify(f.state.management.receipt),
  ]) {
    assert(!value.includes(secret));
    assert(!value.includes(Buffer.from(secret).toString('base64')));
  }
  f.vm.properties.instanceView.vmAgent.extensionHandlers.find(
    (item) => item.type === 'Microsoft.CPlat.Core.RunCommandHandlerLinux',
  ).typeHandlerVersion = '1.3.29';
  await assert.rejects(
    f.guest.run('true', { input: secret }),
    /handler changed/,
  );
});

test('intent precedes PUT; successful receipt is durable before named resource reuse', async () => {
  const f = managedFixture();
  await f.guest.run('true');
  assert.deepEqual(f.calls, [
    'GET',
    'readiness',
    'handler',
    'save-intent',
    'PUT',
    'GET',
    'save-receipt',
  ]);
  assert(f.saved[0].management.pending);
  assert(!f.saved.at(-1).management.pending);
  assert.equal(f.state.management.receipt.exitCode, 0);
  const firstId = f.state.management.receipt.operationId;
  await f.guest.run('true');
  assert.notEqual(f.state.management.receipt.operationId, firstId);
  assert.equal(f.requests.length, 2);
  assert(
    f.requests.every(
      (request) => request.tags.transport === RUN_COMMAND.version,
    ),
  );
});

test('saved privacy proof is fully revalidated, and a reviewed nonsecret probe can finish before proof recording', async () => {
  const f = managedFixture();
  const canary = await f.guest.canary();
  await f.guest.run('true');
  await f.guest.recordPrivacyValidation(f.proof());
  assert.equal(
    f.state.management.privacyValidation.canaryOperationId,
    canary.operationId,
  );
  const valid = structuredClone(f.state.management.privacyValidation);
  for (const patch of [
    { version: 0 },
    { evidenceSha256: 'not-a-hash' },
    { validatedAt: 'invalid' },
    { extra: true },
  ]) {
    f.state.management.privacyValidation = { ...valid, ...patch };
    await assert.rejects(
      f.guest.run('true', { input: secret }),
      /Privacy proof/,
    );
  }
  f.state.management.privacyValidation = valid;
  await f.guest.canary();
  assert(
    !f.state.management.privacyValidation,
    'A new canary invalidates the old approval',
  );
});

for (const failure of ['before', 'after'])
  test(`ambiguous PUT (${failure} accept) stays pending; no blind retry or adoption`, async () => {
    const f = managedFixture();
    f.putFailure = failure;
    await assert.rejects(f.guest.run('true'), /interrupted/);
    assert(f.state.management.pending);
    const id = f.state.management.pending.operationId;
    await assert.rejects(f.guest.run('true'), /pending/);
    assert.equal(f.requests.length, 1);
    if (failure === 'before') {
      await assert.rejects(f.guest.reconcile(), /unknown/);
      assert.equal(f.state.management.pending.operationId, id);
    } else {
      const receipt = await f.guest.reconcile();
      assert.equal(receipt.operationId, id);
      assert(!f.state.management.pending);
    }
    assert.equal(f.requests.length, 1);
  });

for (const boundary of ['intent', 'receipt'])
  test(`local ${boundary} fsync/save failure poisons the session without blind resubmission`, async () => {
    const f = managedFixture({
      beforeSave: async (next) => {
        if ((boundary === 'intent') === !!next.management.pending)
          throw new Error(secret);
      },
    });
    await assert.rejects(f.guest.run('true'), /durability/);
    assert.equal(f.requests.length, boundary === 'intent' ? 0 : 1);
    if (boundary === 'receipt') assert(f.state.management.pending);
    await assert.rejects(f.guest.run('true'), /uncertain local save/);
    assert.equal(f.requests.length, boundary === 'intent' ? 0 : 1);
  });

for (const [name, mutate] of Object.entries({
  'foreign resource': (r) => {
    r.id += '-foreign';
  },
  'foreign name': (r) => {
    r.name += '-foreign';
  },
  'foreign tags': (r) => {
    r.tags.managedBy = 'foreign';
  },
  'wrong operation': (r) => {
    r.tags.operationId = operationId;
  },
  'wrong source': (r) => {
    r.properties.source.script += '\ntrue';
  },
  'alternate script URL': (r) => {
    r.properties.source.scriptUri = 'https://evil.example';
  },
  'ordinary parameter': (r) => {
    r.properties.parameters = [{ name: 'input', value: secret }];
  },
  'exposed protected value': (r) => {
    r.properties.protectedParameters = [
      { name: 'OPENDOTS_PROTECTED_INPUT', value: secret },
    ];
  },
  'unexpected output storage': (r) => {
    r.properties.outputBlobUri = 'https://evil.example';
  },
  'wrong output operation': (r) => {
    const value = JSON.parse(r.properties.instanceView.output);
    value.operationId = operationId;
    r.properties.instanceView.output = JSON.stringify(value);
  },
  'raw output': (r) => {
    r.properties.instanceView.output = secret;
  },
  'raw stderr': (r) => {
    r.properties.instanceView.error = secret;
  },
  'exit status': (r) => {
    r.properties.instanceView.exitCode = 7;
  },
}))
  test(`managed reconciliation rejects ${name} without saving raw output or reusing the resource`, async () => {
    const f = managedFixture();
    f.putFailure = 'after';
    await assert.rejects(f.guest.run('true'));
    f.mutation = mutate;
    await assert.rejects(
      f.guest.reconcile(),
      (error) => !safeError(error).includes(secret),
    );
    assert(f.state.management.pending);
    assert.equal(f.requests.length, 1);
    assert(!JSON.stringify(f.saved).includes(secret));
  });

test('abort/timeouts retain pending operation, and fresh-signal reconciliation preserves guest nonzero status', async () => {
  for (const kind of ['abort', 'timeout']) {
    const f = managedFixture({
      afterPut: async (f) => {
        f.resource.properties.instanceView = { executionState: 'Running' };
        if (kind === 'abort') f.controller.abort();
      },
    });
    await assert.rejects(
      f.guest.run('true', {
        timeoutMs: 31_000,
        signal:
          kind === 'timeout' ? AbortSignal.timeout(1000) : f.controller.signal,
      }),
      /interrupted/,
    );
    assert(f.state.management.pending);
    f.result = '';
    f.complete(7, 'command-failed');
    const receipt = await f.guest.reconcile({
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(receipt.exitCode, 7);
    assert(!f.state.management.pending);
    assert.equal(f.requests.length, 1);
  }
});

test('provider terminal timeout without wrapper receipt is still unknown, never cleared', async () => {
  const f = managedFixture();
  f.putFailure = 'after';
  await assert.rejects(f.guest.run('true'));
  f.resource.properties.instanceView = {
    executionState: 'TimedOut',
    exitCode: 124,
  };
  await assert.rejects(f.guest.reconcile(), /completion receipt/);
  assert(f.state.management.pending);
});

test('untracked/missing managed children, stale bindings, oversized input and output streams fail closed', async () => {
  const f = managedFixture();
  await f.guest.run('true');
  const fresh = managedFixture();
  fresh.resource = structuredClone(f.resource);
  await assert.rejects(fresh.guest.run('true'), /Untracked/);
  f.resource = undefined;
  await assert.rejects(f.guest.run('true'), /refusing recreation/);
  const unchanged = managedFixture();
  unchanged.state.binding.diskUniqueId = operationId;
  await assert.rejects(unchanged.guest.run('true'));
  const bound = managedFixture();
  await assert.rejects(
    bound.guest.run('true', { input: Buffer.alloc(65537) }),
    /64 KiB/,
  );
  await assert.rejects(
    bound.guest.run('true', { output: {} }),
    /cannot stream/,
  );
  await assert.rejects(
    bound.guest.run('true', { schema: 'canary' }),
    /Invalid/,
  );
  assert.equal(bound.requests.length, 0);
});

test('closed group inventory permits only tracked owned child and verified exact Microsoft handler, not broad Compute resources', async () => {
  const f = managedFixture();
  await f.guest.canary();
  const resources = [vmResources().vm, f.resource, handlerResource()];
  const az = {
    verify: async () => {},
    read: async (args) => {
      if (args[0] === 'group')
        return args[1] === 'exists'
          ? true
          : { id: GROUP_ID, location: SCOPE.location, tags: TAGS };
      if (args[1] === 'list') return structuredClone(resources);
      const id = args[args.indexOf('--ids') + 1];
      const resource = resources.find((r) => r.id === id);
      assert(resource, 'Only exact known IDs may be read');
      return structuredClone(resource);
    },
  };
  assert(await inspectGroupBeforeDeployment(az, f.state));
  await assert.rejects(
    inspectGroupBeforeDeployment(az),
    /binding|intent\/receipt/,
  );
  resources[2].properties.publisher = 'foreign';
  await assert.rejects(inspectGroupBeforeDeployment(az, f.state), /handler/);
  resources[2] = handlerResource();
  resources[2].id += '-other';
  await assert.rejects(
    inspectGroupBeforeDeployment(az, f.state),
    /Unexpected resource/,
  );
  assert.throws(
    () =>
      assertManagedHandler({
        ...handlerResource(),
        id: RUN_COMMAND.handlerId.replace('pilot', 'production'),
      }),
    /handler/,
  );
});

test('active pilot never imports/connects SSH or invokes action RunCommand; historic material remains untouched', async () => {
  const source = await readFile(
    new URL('../pilot.mjs', import.meta.url),
    'utf8',
  );
  assert(!source.includes('pinHostKey'));
  assert(!source.includes('sshTransport'));
  assert(!source.includes("'invoke'"));
  assert(source.includes('managedTransport'));
  assert(!source.includes('verifyKeyPair'));
  assert(!source.includes('prepareOperator'));
  assert(source.includes('validateParameters'));
  assert(source.includes('operator.lock'));
});
