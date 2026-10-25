import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  INITIAL_IMAGE,
  INITIAL_UNIT_SHA256,
  initialActivationTarget,
  recoverInitialActivation,
  assertNormalActivation,
} from '../initial-activation.mjs';
import { RUN_COMMAND, SCOPE, TAGS, PULL_ACTIONS } from '../scope.mjs';
import {
  state,
  image,
  output,
  parameters,
  vmResources,
  vmAz,
} from './fixtures.mjs';
import { managedFixture } from './managed-fixture.mjs';
import { provisionVm } from '../vm.mjs';
import { verifyVm } from '../vm-state.mjs';

const execute = promisify(execFile);
const target = initialActivationTarget(image);
const { oldUnit, newUnit, ...review } = target;
const approval = { ...review, reviewSha256: 'e'.repeat(64) };
const plan = {
  ...target,
  operationId: '99999999-9999-9999-9999-999999999999',
  reviewSha256: approval.reviewSha256,
  binding: state.binding,
  fsUuid: state.fsUuid,
  diskOperationId: state.operationId,
  immutableStateSha256: 'f'.repeat(64),
};
const withoutRecovery = (value) => {
  const result = structuredClone(value);
  delete result.image;
  delete result.initialActivationRecovery;
  return result;
};

async function guestFixture(t, scenario) {
  await mkdir('/tmp/opencode', { recursive: true });
  const path = await mkdtemp('/tmp/opencode/opendots-initial-recovery-');
  t.after(() => rm(path, { recursive: true, force: true }));
  const child = execute(
    'python3',
    [
      new URL('./initial_activation_fixture.py', import.meta.url).pathname,
      path,
      scenario,
    ],
    {
      timeout: 8000,
      maxBuffer: 128 * 1024,
    },
  );
  child.child.stdin.end(JSON.stringify(plan));
  const result = await child;
  assert.equal(result.stderr, '');
  return { path, ...JSON.parse(result.stdout) };
}

test('frozen initial target differs solely by the reviewed digest, not helper bytes or normal upgrade guards', async () => {
  assert.equal(target.oldImage, INITIAL_IMAGE);
  assert.equal(target.oldUnitSha256, INITIAL_UNIT_SHA256);
  assert.equal(oldUnit.replace(INITIAL_IMAGE, image), newUnit);
  assert.equal(
    createHash('sha256').update(oldUnit).digest('hex'),
    INITIAL_UNIT_SHA256,
  );
  assert.throws(() => initialActivationTarget(INITIAL_IMAGE), /distinct/);
  assert.throws(() =>
    initialActivationTarget(image.replace('@sha256:', ':tag-')),
  );
  for (const [name, expected] of [
    [
      'vm-host.sh',
      'f872b3d1b67dc7f54f4386c5dc458d69e3123619c2e90ced7a64ee13835c8784',
    ],
    [
      'vm-disk.py',
      'df76fc6d40075d3253b5844a53234c87639a785d929329949a638baae415f778',
    ],
    [
      'vm-bootstrap.sh',
      '6add0dfbf2d8207cbc5710e4f004bce15bf54a1e127e675977552f111f1aafcf',
    ],
  ])
    assert.equal(
      createHash('sha256')
        .update(await readFile(new URL(`../${name}`, import.meta.url)))
        .digest('hex'),
      expected,
    );
});

test('actual recovery script preserves a private verified old unit, intent, fsynced replacement and receipt without start/enable or data writes', async (t) => {
  const f = await guestFixture(t, 'pristine');
  assert.equal(f.status, 'applied');
  assert.equal(f.unitSha256, target.newUnitSha256);
  assert.equal(f.backupSha256, INITIAL_UNIT_SHA256);
  assert(f.intent && f.applied && !f.ineligible);
  assert.equal(f.unitWrites, 1);
  assert(
    f.events.indexOf('intent-directory-sync') <
      f.events.indexOf('unit-replace'),
  );
  assert(f.events.indexOf('unit-file-sync') < f.events.indexOf('unit-replace'));
  assert(
    f.events.indexOf('unit-directory-sync') <
      f.events.indexOf('applied-publish'),
  );
  assert(!f.events.some((event) => event.startsWith('write:srv/')));
  assert(
    !f.events.some((event) =>
      /command:.*\b(start|enable|mkfs|prepare)\b/.test(event),
    ),
  );
});

for (const scenario of [
  'container',
  'stopped-container',
  'image',
  'runtime',
  'database',
  'other-data',
  'lost-data',
  'active',
  'enabled',
  'job',
  'activation-job',
  'prior-activation',
  'invocation',
])
  test(`initial recovery permanently rejects ${scenario}; observations cannot be deleted to restore eligibility`, async (t) => {
    const f = await guestFixture(t, scenario);
    assert.equal(f.status, 'ineligible');
    assert(f.ineligible && f.unitUnchanged);
    assert(!f.intent && !f.applied);
    assert.equal(f.unitWrites, 0);
  });

for (const scenario of [
  'wrong-uuid',
  'wrong-vm',
  'wrong-disk',
  'wrong-disk-id',
  'wrong-format-op',
  'pending-pull',
  'disk-error',
  'container-error',
  'image-error',
  'service-error',
  'job-error',
  'data-symlink',
  'data-owner',
  'lost-symlink',
  'helper-drift',
  'unit-mode',
  'unit-owner',
  'unit-symlink',
  'unit-directory',
  'unit-fifo',
  'unit-hardlink',
  'parent-writable',
  'parent-owner',
  'private-writable',
  'drop-ins',
  'fragment',
  'not-loaded',
  'effective-exec',
  'effective-mount',
  'reload-needed',
  'cat-drift',
  'backup-bytes',
  'backup-mode',
  'backup-symlink',
  'wrong-intent',
])
  test(`actual recovery fails closed on ${scenario}: errors are not absence, no blind overwrite/rollback`, async (t) => {
    const f = await guestFixture(t, scenario);
    assert.equal(f.status, 'rejected');
    assert(f.unitUnchanged);
    assert.equal(f.unitWrites, 0);
  });

for (const scenario of ['unit-bytes', 'applied-old', 'new-without-intent'])
  test(`uncertain mutation ${scenario} is a bound conflict, not pre-activation ineligibility`, async (t) => {
    const f = await guestFixture(t, scenario);
    assert.equal(f.status, 'post-intent-conflict');
    assert(f.conflict && f.unitUnchanged);
    assert(!f.ineligible);
    assert.equal(f.unitWrites, 0);
  });

for (const phase of ['prepared', 'swapped', 'applied'])
  for (const observation of ['active', 'runtime', 'database', 'tombstone'])
    test(`${observation} after ${phase} preserves journal/receipt/unit facts and permanently blocks automatic continuation`, async (t) => {
      const f = await guestFixture(t, `${phase}:${observation}`);
      assert.equal(f.status, 'post-intent-conflict');
      assert(f.conflict && f.intent && f.unitUnchanged);
      assert.equal(f.applied, phase === 'applied');
      assert.equal(f.ineligible, observation === 'tombstone');
      assert.equal(f.backupSha256, INITIAL_UNIT_SHA256);
      assert.equal(f.unitWrites, 0);
      if (observation === 'tombstone')
        assert(
          !f.events.some((value) => value.startsWith('command:')),
          'Mixed journal/tombstone is classified before eligibility',
        );
    });

for (const phase of [
  'intent-directory-sync',
  'unit-replace',
  'applied-directory-sync',
])
  for (const observation of ['active', 'runtime', 'database'])
    test(`actual transaction detects ${observation} at ${phase} without relabeling an applied/prepared transaction`, async (t) => {
      const f = await guestFixture(t, `during:${phase}:${observation}`);
      assert.equal(f.status, 'post-intent-conflict');
      assert(f.conflict && f.intent && !f.ineligible);
      assert.equal(f.applied, phase === 'applied-directory-sync');
      assert.equal(f.unitWrites, phase === 'intent-directory-sync' ? 0 : 1);
      assert.equal(f.backupSha256, INITIAL_UNIT_SHA256);
    });

for (const scenario of ['foreign-journal', 'foreign-conflict'])
  test(`${scenario} fails before eligibility can hide or replace foreign evidence`, async (t) => {
    const f = await guestFixture(t, scenario);
    assert.equal(f.status, 'rejected');
    assert(f.unitUnchanged && f.intent && !f.ineligible);
    assert(!f.events.some((value) => value.startsWith('command:')));
  });

for (const boundary of [
  'private-directory-sync',
  'backup-file-sync',
  'backup-publish',
  'backup-directory-sync',
  'intent-file-sync',
  'intent-publish',
  'intent-directory-sync',
  'unit-file-sync',
  'unit-replace',
  'unit-directory-sync',
  'unit-post-check',
  'daemon-reload',
  'applied-file-sync',
  'applied-publish',
  'applied-directory-sync',
  'applied-post-check',
])
  test(`actual process crash at ${boundary} reconciles only the same prepared/applied transaction`, async (t) => {
    const f = await guestFixture(t, `crash-${boundary}`);
    assert.equal(f.status, 'applied');
    assert.equal(f.unitSha256, target.newUnitSha256);
    assert.equal(f.backupSha256, INITIAL_UNIT_SHA256);
    assert(f.intent && f.applied && !f.ineligible);
    assert.equal(
      f.unitWrites,
      1,
      'Never blindly rewrite an already-applied unit',
    );
    const replaced = f.events.indexOf('unit-replace');
    const intentPublished = f.events.indexOf('intent-publish');
    assert(
      f.events
        .slice(intentPublished + 1, replaced)
        .includes('private-records-sync'),
      'Recovered intent must be durable before replacement',
    );
    assert(
      f.events.lastIndexOf('unit-file-resync') > replaced,
      'Recovered unit file is re-synced before accepting its receipt',
    );
    assert(
      f.events.lastIndexOf('private-records-sync') >
        f.events.indexOf('applied-publish'),
      'Recovered applied receipt directory is synced before return',
    );
  });

for (const scenario of ['prepared-new', 'applied-new'])
  test(`${scenario} guest receipt is reconciled without rewriting the unit`, async (t) => {
    const f = await guestFixture(t, scenario);
    assert.equal(f.status, 'applied');
    assert.equal(f.unitWrites, 0);
    assert(f.unitUnchanged && f.applied);
  });

test('daemon-reload failure preserves the prepared intent/new unit; no applied receipt is manufactured', async (t) => {
  const f = await guestFixture(t, 'reload-error');
  assert.equal(f.status, 'rejected');
  assert(f.intent && !f.applied);
  assert.equal(f.unitSha256, target.newUnitSha256);
  assert.equal(f.backupSha256, INITIAL_UNIT_SHA256);
});

function localFixture(t) {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-21T12:00:00Z'));
  const f = {
    state: {
      ...structuredClone(state),
      image: INITIAL_IMAGE,
      provisioned: false,
      configured: false,
      pins: structuredClone(state.binding),
      untouchedHistoricalField: 'preserve',
    },
    approval: structuredClone(approval),
    resources: vmResources(),
    saved: [],
    guestCalls: [],
    token: {
      status: 'disabled',
      scopeMapId: `${output.registryId}/scopeMaps/${output.scopeMapName}`,
      credentials: { passwords: [], certificates: [] },
    },
    scope: {
      id: `${output.registryId}/scopeMaps/${output.scopeMapName}`,
      actions: [...PULL_ACTIONS],
    },
    registry: {
      id: output.registryId,
      location: SCOPE.location,
      tags: TAGS,
      properties: { adminUserEnabled: false, anonymousPullEnabled: false },
    },
    power: 'PowerState/running',
    saveFailure: undefined,
    durableAfterFailure: false,
  };
  const vm = vmAz(f.resources);
  f.az = {
    calls: vm.calls,
    verify: vm.verify,
    write: () =>
      assert.fail('Initial recovery must not write Azure resources or tokens'),
    read: async (args) => {
      if (args[0] === 'acr')
        return structuredClone(args[1] === 'token' ? f.token : f.scope);
      if (args.includes(output.registryId)) return structuredClone(f.registry);
      if (args[0] === 'vm') return [{ code: f.power }];
      return vm.read(args);
    },
  };
  f.save = async (value) => {
    const fail = f.saved.length === f.saveFailure;
    if (!fail || f.durableAfterFailure) f.durable = structuredClone(value);
    f.saved.push(structuredClone(value));
    if (fail) throw new Error('fixture fsync fault');
    await f.afterSave?.(value);
  };
  f.ssh = {
    kind: RUN_COMMAND.version,
    requireProtectedInput: async () => {},
    run: async (command, options) => {
      assert.equal(
        f.state.initialActivationRecovery.status === 'prepared' ||
          f.state.initialActivationRecovery.status === 'applied',
        true,
      );
      assert.equal(options.schema, 'recovery');
      assert(command.includes('flock -w 30'));
      assert(command.includes('timeout --kill-after=10 180'));
      const input = JSON.parse(options.input);
      assert.equal(input.oldUnit, oldUnit);
      assert.equal(input.newUnit, newUnit);
      if (f.remoteIntent) assert.deepEqual(input, f.remoteIntent);
      f.remoteIntent = input;
      f.guestCalls.push(input);
      await f.duringGuest?.();
      return JSON.stringify({
        ...options.recovery,
        status: f.remoteStatus ?? 'applied',
        ...f.badReceipt,
      });
    },
  };
  f.durable = structuredClone(f.state);
  f.run = () => recoverInitialActivation({ ...f, output, parameters });
  return f;
}

test('initial local intent -> applied receipt -> atomic image pin update preserves every unrelated/SSH/format/identity field', async (t) => {
  const f = localFixture(t),
    before = structuredClone(f.state);
  await f.run();
  assert.deepEqual(
    f.saved.map((s) => [s.image, s.initialActivationRecovery.status]),
    [
      [INITIAL_IMAGE, 'prepared'],
      [INITIAL_IMAGE, 'applied'],
      [image, 'complete'],
    ],
  );
  for (const saved of f.saved)
    assert.deepEqual(withoutRecovery(saved), withoutRecovery(before));
  assert.equal(f.state.image, image);
  assert.equal(f.guestCalls.length, 1);
  assert(
    f.az.calls.some((args) => args.includes(state.binding.diskId)),
    'Fresh live disk read is mandatory',
  );
  assert(
    f.az.calls.some((args) => args.includes(state.binding.vmId)),
    'Fresh live VM read is mandatory',
  );
  await f.run();
  assert.equal(
    f.guestCalls.length,
    1,
    'Completed recovery is not a generic re-upgrader',
  );
});

test('reviewed recovery fits the real managed envelope and protected-input path, with no public unit/input leakage', async (t) => {
  const f = localFixture(t);
  // Privacy proof uses real wall clock in the fixture, not the historical creation-time test clock.
  t.mock.restoreAll();
  const managed = managedFixture({ state: f.state });
  f.state = managed.state;
  f.ssh = managed.guest;
  await managed.approveFixture();
  await f.run();
  assert.equal(f.state.image, image);
  assert.equal(f.state.initialActivationRecovery.status, 'complete');
  const request = managed.requests.at(-1);
  const input = Buffer.from(
    request.properties.protectedParameters[0].value,
    'base64',
  ).toString();
  assert.equal(JSON.parse(input).newUnit, newUnit);
  assert(!request.properties.source.script.includes(input));
  assert(
    !request.properties.source.script.includes(
      request.properties.protectedParameters[0].value,
    ),
  );
  assert(Buffer.byteLength(request.properties.source.script) <= 65536);
  assert.equal(managed.state.management.receipt.schema, 'recovery');
});

for (const field of ['provisioned', 'configured'])
  test(`local ${field} history permanently closes one-off eligibility`, async (t) => {
    const f = localFixture(t);
    f.state[field] = true;
    await assert.rejects(f.run(), /permanently/);
    assert.equal(f.state.initialActivationRecovery.status, 'ineligible');
    f.state[field] = false;
    await assert.rejects(f.run(), /permanently/);
    assert.equal(f.guestCalls.length, 0);
    assert.equal(f.state.image, INITIAL_IMAGE);
  });

for (const [name, mutate] of Object.entries({
  'pending management': (f) => {
    f.state.management = { pending: { operationId: plan.operationId } };
  },
  'pending pull': (f) => {
    f.state.pullOperationId = plan.operationId;
  },
  'missing UUID': (f) => {
    delete f.state.fsUuid;
  },
  'wrong image pin': (f) => {
    f.state.image = image;
  },
  'SSH transport': (f) => {
    f.ssh.kind = 'legacy-ssh';
  },
  'live VM drift': (f) => {
    f.resources.vm.properties.vmId = plan.operationId;
  },
  'live disk drift': (f) => {
    f.resources.disk.properties.uniqueId = plan.operationId;
  },
  'restored SSH firewall': (f) => {
    f.resources.nsg.properties.securityRules.push({ name: 'operator-ssh' });
  },
  'stopped VM': (f) => {
    f.power = 'PowerState/deallocated';
  },
  'enabled token': (f) => {
    f.token.status = 'enabled';
  },
  'token password': (f) => {
    f.token.credentials.passwords.push({
      name: 'password1',
      expiry: 'expired',
    });
  },
  'token certificate': (f) => {
    f.token.credentials.certificates.push({});
  },
  'broad token': (f) => {
    f.scope.actions.push('repositories/opendots/content/write');
  },
  'admin registry': (f) => {
    f.registry.properties.adminUserEnabled = true;
  },
  'wrong old hash approval': (f) => {
    f.approval.oldUnitSha256 = 'a'.repeat(64);
  },
  'missing review': (f) => {
    f.approval.reviewSha256 = '';
  },
  'private gate closed': (f) => {
    f.ssh.requireProtectedInput = async () => {
      throw new Error('privacy gate closed');
    };
  },
}))
  test(`one-off preflight rejects ${name} before guest write or durable recovery intent`, async (t) => {
    const f = localFixture(t);
    mutate(f);
    await assert.rejects(f.run());
    assert.equal(f.guestCalls.length, 0);
    assert.equal(f.saved.length, 0);
  });

for (const boundary of [0, 1, 2])
  for (const afterDurable of [false, true])
    test(`local recovery save ${boundary}, ${afterDurable ? 'after' : 'before'} durable publication: explicit reload reconciles without clearing pins`, async (t) => {
      const f = localFixture(t),
        before = structuredClone(f.state);
      f.saveFailure = boundary;
      f.durableAfterFailure = afterDurable;
      await assert.rejects(f.run(), /durability failed/);
      await assert.rejects(f.run(), /durability is uncertain/);
      assert.equal(f.state.image, INITIAL_IMAGE);
      if (boundary === 0) assert.equal(f.guestCalls.length, 0);
      else assert.equal(f.guestCalls.length, 1);
      f.state = structuredClone(f.durable);
      f.saveFailure = undefined;
      await f.run();
      assert.equal(f.state.image, image);
      assert.equal(f.state.initialActivationRecovery.status, 'complete');
      assert.deepEqual(withoutRecovery(f.state), withoutRecovery(before));
      assert(f.saved.every((s) => [INITIAL_IMAGE, image].includes(s.image)));
      assert(
        f.guestCalls.every(
          (p) => p.operationId === f.guestCalls[0].operationId,
        ),
      );
    });

test('guest ineligibility is durable locally and never updates the image pin', async (t) => {
  const f = localFixture(t);
  f.remoteStatus = 'ineligible';
  await assert.rejects(f.run(), /permanently ineligible/);
  assert.equal(f.state.image, INITIAL_IMAGE);
  assert.equal(f.state.initialActivationRecovery.status, 'ineligible');
  await assert.rejects(f.run(), /permanently/);
  assert.equal(f.guestCalls.length, 1);
});

test('wrong recovery receipt or immutable state drift leaves the original pin and prepared intent', async (t) => {
  for (const kind of ['receipt', 'binding']) {
    const f = localFixture(t);
    if (kind === 'receipt') f.badReceipt = { operationId: state.operationId };
    else
      f.duringGuest = async () => {
        f.state.parametersHash = 'drift';
      };
    await assert.rejects(f.run());
    assert.equal(f.state.image, INITIAL_IMAGE);
    assert.equal(f.state.initialActivationRecovery.status, 'prepared');
    assert.equal(f.saved.length, 1);
  }
});

async function savedTransaction(f, phase) {
  if (phase === 'prepared') {
    const run = f.ssh.run;
    f.ssh.run = async () => {
      throw new Error('fixture interrupted before guest result');
    };
    await assert.rejects(f.run());
    f.ssh.run = run;
  } else {
    f.saveFailure = 2;
    await assert.rejects(f.run(), /durability failed/);
    f.state = structuredClone(f.durable);
    f.saveFailure = undefined;
  }
  assert.equal(f.state.initialActivationRecovery.status, phase);
  assert.equal(f.state.image, INITIAL_IMAGE);
}

for (const phase of ['prepared', 'applied'])
  for (const field of ['provisioned', 'configured'])
    test(`local ${field} after ${phase} adds a bound conflict without replacing transaction/receipt facts`, async (t) => {
      const f = localFixture(t);
      await savedTransaction(f, phase);
      const before = structuredClone(f.state.initialActivationRecovery),
        calls = f.guestCalls.length;
      f.state[field] = true;
      await assert.rejects(f.run(), /post-intent conflict/);
      const { conflict, ...retained } = f.state.initialActivationRecovery;
      assert.deepEqual(retained, before);
      assert.deepEqual(conflict, {
        operationId: before.operationId,
        status: 'post-intent-conflict',
        oldUnitSha256: before.oldUnitSha256,
        newUnitSha256: before.newUnitSha256,
      });
      assert.equal(f.state.image, INITIAL_IMAGE);
      assert.equal(f.guestCalls.length, calls);
      f.state[field] = false;
      await assert.rejects(f.run(), /post-intent conflict/);
      assert.equal(
        f.guestCalls.length,
        calls,
        'Deleting the activity observation cannot resume recovery',
      );
    });

for (const phase of ['prepared', 'applied'])
  for (const remoteStatus of ['post-intent-conflict', 'ineligible'])
    test(`${remoteStatus} cannot demote or erase a durable local ${phase} transaction`, async (t) => {
      const f = localFixture(t);
      await savedTransaction(f, phase);
      const before = structuredClone(f.state.initialActivationRecovery);
      f.remoteStatus = remoteStatus;
      await assert.rejects(f.run(), /post-intent conflict/);
      const { conflict, ...retained } = f.state.initialActivationRecovery;
      assert.deepEqual(retained, before);
      assert.equal(conflict.status, 'post-intent-conflict');
      assert.equal(f.state.image, INITIAL_IMAGE);
      f.remoteStatus = 'applied';
      await assert.rejects(f.run(), /post-intent conflict/);
      assert.equal(f.state.image, INITIAL_IMAGE);
    });

test('mixed local ineligible/applied receipt preserves both facts and records conflict', async (t) => {
  const f = localFixture(t);
  await savedTransaction(f, 'applied');
  f.state.initialActivationRecovery.status = 'ineligible';
  const before = structuredClone(f.state.initialActivationRecovery);
  await assert.rejects(f.run(), /post-intent conflict/);
  const { conflict, ...retained } = f.state.initialActivationRecovery;
  assert.deepEqual(retained, before);
  assert.equal(conflict.operationId, before.operationId);
  assert.equal(f.state.image, INITIAL_IMAGE);
});

for (const boundary of ['guest-result', 'local-applied-receipt'])
  for (const field of ['provisioned', 'configured'])
    test(`${field} observed at ${boundary} retains the applied receipt but never commits a new image pin`, async (t) => {
      const f = localFixture(t);
      if (boundary === 'guest-result')
        f.duringGuest = async () => {
          f.state[field] = true;
        };
      else
        f.afterSave = async (value) => {
          if (
            value.initialActivationRecovery.status === 'applied' &&
            !value.initialActivationRecovery.conflict
          )
            f.state[field] = true;
        };
      await assert.rejects(f.run(), /post-intent conflict/);
      assert.equal(f.state.image, INITIAL_IMAGE);
      assert.equal(f.state.initialActivationRecovery.status, 'applied');
      assert.equal(f.state.initialActivationRecovery.receipt.status, 'applied');
      assert.equal(
        f.state.initialActivationRecovery.conflict.status,
        'post-intent-conflict',
      );
      assert(f.saved.every((value) => value.image === INITIAL_IMAGE));
      f.state[field] = false;
      await assert.rejects(f.run(), /post-intent conflict/);
    });

for (const phase of ['prepared', 'applied'])
  for (const afterPublication of [false, true])
    test(`local ${phase} conflict save failure ${afterPublication ? 'after' : 'before'} publication blocks pin advance and requires reload`, async (t) => {
      const f = localFixture(t);
      await savedTransaction(f, phase);
      const before = structuredClone(f.state.initialActivationRecovery);
      f.remoteStatus = 'post-intent-conflict'; // The guest's durable conflict survives removal of app data.
      f.saveFailure = f.saved.length;
      f.durableAfterFailure = afterPublication;
      await assert.rejects(f.run(), /durability failed/);
      assert.deepEqual(f.state.initialActivationRecovery, before);
      assert.equal(f.state.image, INITIAL_IMAGE);
      await assert.rejects(f.run(), /durability is uncertain/);
      f.state = structuredClone(f.durable);
      f.saveFailure = undefined;
      await assert.rejects(f.run(), /post-intent conflict/);
      const { conflict, ...retained } = f.state.initialActivationRecovery;
      assert.deepEqual(retained, before);
      assert.equal(conflict.operationId, before.operationId);
      assert.equal(f.state.image, INITIAL_IMAGE);
    });

test('a first guest conflict is not an applied receipt and blocks normal provisioning even with a misleading phase', async (t) => {
  const f = localFixture(t);
  f.remoteStatus = 'post-intent-conflict';
  await assert.rejects(f.run(), /post-intent conflict/);
  assert.equal(f.state.initialActivationRecovery.status, 'prepared');
  assert.equal(f.state.initialActivationRecovery.receipt, undefined);
  assert.equal(f.state.image, INITIAL_IMAGE);
  f.state.initialActivationRecovery.status = 'complete';
  const calls = f.guestCalls.length;
  await assert.rejects(
    provisionVm({ ...f, output, image: INITIAL_IMAGE }),
    /recovery/,
  );
  assert.equal(f.guestCalls.length, calls);
  const source = await readFile(
    new URL('../pilot.mjs', import.meta.url),
    'utf8',
  );
  assert(
    source.indexOf('verified.state.initialActivationRecovery?.conflict') <
      source.indexOf("await az.write(['vm', 'start'"),
  );
});

async function benignIneligible(t, marker = 'provisioned') {
  const f = localFixture(t);
  f.state.image = image.replace(/a$/, 'b');
  f.state[marker] = true;
  await assert.rejects(f.run(), /permanently ineligible/);
  assert.deepEqual(f.state.initialActivationRecovery, {
    ...review,
    status: 'ineligible',
  });
  assert.notEqual(f.state.image, f.state.initialActivationRecovery.newImage);
  assert.equal(f.guestCalls.length, 0);
  f.check = async () => {
    const verified = await verifyVm(
      f.az,
      output,
      parameters,
      f.state,
      async () => {},
    );
    assertNormalActivation(verified.state, output);
  };
  return f;
}

for (const marker of ['provisioned', 'configured'])
  test(`actual pre-intent ineligible producer with ${marker} history permits strictly verified normal work, not another recovery`, async (t) => {
    const f = await benignIneligible(t, marker);
    const before = structuredClone(f.state);
    await f.check();
    assert.deepEqual(f.state, before);
    assert.equal(f.saved.length, 1);
    await assert.rejects(f.run(), /permanently ineligible/);
    assert.deepEqual(f.state, before);
    assert.equal(f.guestCalls.length, 0);
  });

for (const [name, mutate] of Object.entries({
  'existing lane': (s) => {
    s.existingPilot = {};
  },
  'null existing metadata is not absent': (s) => {
    s.existingPilot = null;
  },
  'original image': (s) => {
    s.image = INITIAL_IMAGE;
  },
  'no activation markers': (s) => {
    s.provisioned = false;
    s.configured = false;
  },
  'truthy but nonboolean activation': (s) => {
    s.provisioned = 'true';
  },
  'invalid pinned image': (s) => {
    s.image = 'foreign/image:latest';
  },
}))
  test(`benign strict exception rejects ${name}`, async (t) => {
    const f = await benignIneligible(t);
    mutate(f.state);
    const before = structuredClone(f.state);
    await assert.rejects(f.check());
    assert.deepEqual(f.state, before);
    assert.equal(f.saved.length, 1);
    assert.equal(f.guestCalls.length, 0);
  });

for (const field of [
  'operationId',
  'binding',
  'fsUuid',
  'diskOperationId',
  'immutableStateSha256',
  'reviewSha256',
  'receipt',
  'conflict',
  'oldUnit',
  'newUnit',
  'unknown',
])
  for (const value of [null, false, undefined])
    test(`pre-intent exception rejects extra ${field} even when ${String(value)}`, async (t) => {
      const f = await benignIneligible(t);
      f.state.initialActivationRecovery[field] = value;
      await assert.rejects(f.check());
      assert.equal(f.saved.length, 1);
      assert.equal(f.guestCalls.length, 0);
    });

test('present null/malformed/unknown recovery records and bad target hashes never act like absence', async (t) => {
  const f = await benignIneligible(t);
  const benign = structuredClone(f.state.initialActivationRecovery);
  for (const record of [
    null,
    undefined,
    false,
    '',
    [],
    {},
    { ...benign, version: 2 },
    { ...benign, oldImage: image },
    { ...benign, newImage: INITIAL_IMAGE },
    { ...benign, oldUnitSha256: '0'.repeat(64) },
    { ...benign, newUnitSha256: '0'.repeat(64) },
    { ...benign, status: 'prepared' },
    { ...benign, status: 'applied' },
    { ...benign, status: 'complete' },
    { ...benign, status: 'unknown' },
    { ...benign, receipt: { status: 'applied' } },
    { ...benign, receipt: { status: 'ineligible' } },
    { ...benign, conflict: { status: 'post-intent-conflict' } },
  ]) {
    f.state.initialActivationRecovery = record;
    await assert.rejects(f.check());
  }
  delete f.state.initialActivationRecovery;
  await f.check();
  assert.equal(f.saved.length, 1);
  assert.equal(f.guestCalls.length, 0);
});

for (const slot of ['pending', 'receipt'])
  test(`contradictory recovery evidence in management.${slot} closes the benign exception`, async (t) => {
    const f = await benignIneligible(t);
    for (const operation of [
      { schema: 'recovery' },
      { schema: 'unknown' },
      { ...review, status: 'applied' },
      { schema: 'empty', recovery: null },
      { schema: 'empty', recovery: false },
      { schema: 'empty', conflict: false },
      { schema: 'empty', status: false },
      { schema: 'empty', oldUnitSha256: null },
      { schema: 'empty', newUnitSha256: false },
      { schema: 'empty', result: { status: 'applied' } },
      { schema: 'empty', result: { status: 'ineligible' } },
      { schema: 'empty', result: { status: 'post-intent-conflict' } },
      { schema: 'empty', result: { oldUnitSha256: null } },
      { schema: 'empty', result: { newUnitSha256: false } },
    ]) {
      f.state.management = { [slot]: operation };
      await assert.rejects(f.check(), /contradictory recovery evidence/);
    }
    assert.equal(f.saved.length, 1);
    assert.equal(f.guestCalls.length, 0);
  });

test('ordinary managed receipts remain compatible; unrelated pending still needs normal GET-only reconciliation', async (t) => {
  const f = await benignIneligible(t);
  const m = managedFixture({ state: f.state });
  f.state = m.state;
  const record = structuredClone(f.state.initialActivationRecovery);
  await m.guest.run('true');
  await f.check();
  m.putFailure = 'after';
  await assert.rejects(m.guest.run('true'));
  await f.check();
  await assert.rejects(m.guest.run('true'), /pending/);
  assert.equal(m.requests.length, 2);
  await m.guest.reconcile();
  await f.check();
  assert.deepEqual(f.state.initialActivationRecovery, record);
});

test('normal activation still requires a valid complete transaction, and fresh strict verification cannot be skipped by a benign record', async (t) => {
  const f = localFixture(t);
  await f.run();
  const verified = await verifyVm(
    f.az,
    output,
    parameters,
    f.state,
    async () => {},
  );
  assertNormalActivation(verified.state, output);
  for (const patch of [
    { status: 'prepared' },
    { status: 'applied' },
    { status: 'ineligible' },
    { receipt: null },
    { reviewSha256: '' },
    { operationId: 'foreign' },
    { conflict: { status: 'post-intent-conflict' } },
  ]) {
    assert.throws(() =>
      assertNormalActivation(
        {
          ...verified.state,
          initialActivationRecovery: {
            ...verified.state.initialActivationRecovery,
            ...patch,
          },
        },
        output,
      ),
    );
  }
  const benign = await benignIneligible(t);
  benign.resources.vm.identity.principalId = plan.operationId;
  await assert.rejects(benign.check(), /Pinned/);
  assert.equal(benign.guestCalls.length, 0);
});
