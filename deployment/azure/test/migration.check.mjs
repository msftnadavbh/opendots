import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,
  writeFile,
  chmod,
  symlink,
  unlink,
  mkdir,
  lstat,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {
  ORIGINAL_PROFILE,
  SCUS_PROFILE,
  PROFILES,
  selectProfile,
  assertProfile,
} from '../profiles.mjs';
import { createAz, assertProfileEnvironment } from '../cloud.mjs';
import { SCOPE, VM, safeError } from '../scope.mjs';
import { main } from '../pilot.mjs';
import { migrationMain } from '../migration.mjs';
import {
  openMigrationStore,
  hashObject,
  assertMigrationState,
} from '../migration-state.mjs';
import {
  stageIds,
  assertStageTemplate,
  desiredResources,
} from '../migration-validation.mjs';
import { migrationFixture, compiled, serialize } from './migration-fixture.mjs';

test('two canonical deeply frozen profiles preserve original defaults and separate compute/shared/source/artifact contexts', () => {
  assert.deepEqual(Object.keys(PROFILES), ['original', 'pilot-scus-v1']);
  assert.equal(selectProfile(['status']).profile, ORIGINAL_PROFILE);
  assert.equal(
    selectProfile(['--profile', 'pilot-scus-v1', 'prepare']).profile,
    SCUS_PROFILE,
  );
  assert.equal(SCUS_PROFILE.compute.location, 'southcentralus');
  assert.equal(SCUS_PROFILE.sharedServices.location, 'eastus2');
  assert.equal(SCUS_PROFILE.sourcePreservation.location, 'eastus2');
  assert.equal(SCUS_PROFILE.guestBundle.available, false);
  const frozen = (value) => {
    assert(Object.isFrozen(value));
    for (const item of Object.values(value))
      if (item && typeof item === 'object') frozen(item);
  };
  frozen(ORIGINAL_PROFILE);
  frozen(SCUS_PROFILE);
  assert.throws(
    () => assertProfile(structuredClone(SCUS_PROFILE)),
    /canonical/,
  );
  assert.throws(() => (SCUS_PROFILE.compute.location = 'foreign'), TypeError);
  assert.throws(
    () => assertProfileEnvironment(SCUS_PROFILE, { AZURE_LOCATION: 'eastus2' }),
    /conflicts/,
  );
  assert.throws(
    () =>
      assertProfileEnvironment(ORIGINAL_PROFILE, {
        AZURE_LOCATION: 'southcentralus',
      }),
    /overrides/,
  );
  assertProfileEnvironment(SCUS_PROFILE, {});
  assertProfileEnvironment(ORIGINAL_PROFILE, {});
});

test('unknown/conflicting profiles and future target commands fail before filesystem/client effects', async () => {
  for (const args of [
    ['--profile', 'production', 'prepare'],
    ['status', '--profile', 'pilot-scus-v1'],
    ['--profile', 'pilot-scus-v1', '--profile', 'original', 'prepare'],
    ['--profile=pilot-scus-v1', 'prepare'],
    ...[
      'host',
      'audit',
      'configure',
      'activate',
      'status',
      'management-canary',
      'deploy',
      'stop',
      'resume',
    ].map((command) => ['--profile', 'pilot-scus-v1', command]),
    ['--profile', 'pilot-scus-v1', 'apply', 'host'],
  ])
    await assert.rejects(main(args), /profile|unavailable|Only/);
  await assert.rejects(
    migrationMain(structuredClone(SCUS_PROFILE), ['prepare']),
    /canonical/,
  );
});

test('profile-aware Azure client retains injected-run default behavior and excludes every target mutation/read escape', async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    return { stdout: '{}' };
  };
  const original = createAz(run);
  assert.equal(original.profile, ORIGINAL_PROFILE);
  await original.read([
    'resource',
    'list',
    '--resource-group',
    SCOPE.resourceGroup,
  ]);
  assert.equal(calls, 1);
  assert.throws(() => createAz(run, { ...SCUS_PROFILE }), /canonical/);
  const target = createAz(run, SCUS_PROFILE);
  for (const method of ['read', 'write'])
    for (const args of [
      ['vm', 'start', '--ids', VM.ids.id],
      ['vm', 'deallocate', '--ids', VM.ids.id],
      ['disk', 'grant-access'],
      ['snapshot', 'grant-access'],
      ['group', 'delete'],
      [
        'rest',
        '--method',
        'put',
        '--url',
        'https://management.azure.com/foreign',
      ],
      ['account', 'get-access-token'],
      ['acr', 'token', 'credential', 'generate'],
      [
        'deployment',
        'group',
        'create',
        '--name',
        'other',
        '--resource-group',
        SCOPE.resourceGroup,
      ],
    ])
      await assert.rejects(target[method](args));
  assert.equal(calls, 1);
  assert.throws(() => {
    target.profile = ORIGINAL_PROFILE;
  }, TypeError);
});

test('working prepare → group → capture → copy uses real private journal/archive and scoped client, preserving source bytes and cold provenance', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  const initial = await f.diskState();
  assert.equal(initial.version, 3);
  assert.equal(initial.profileId, SCUS_PROFILE.id);
  for (const key of [
    'creation',
    'binding',
    'pins',
    'existingPilot',
    'management',
    'initialActivationRecovery',
  ])
    assert(!Object.hasOwn(initial, key));
  for (const stage of ['group', 'capture', 'copy'])
    assert.equal((await f.stage(stage)).status, 'complete');
  const state = await f.diskState();
  assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
  assert.equal(state.stages.capture.consistency, 'cold/crash-consistent');
  assert.equal(state.stages.capture.sourceGuestManifest, 'unavailable');
  assert.equal(state.stages.capture.shutdownCleanliness, 'unknown');
  assert.equal(
    state.stages.copy.resources.os.sourceUniqueId,
    state.stages.capture.resources.os.uniqueId,
  );
  assert.equal(
    state.stages.copy.resources.data.sourceUniqueId,
    state.stages.capture.resources.data.uniqueId,
  );
  assert.notEqual(
    state.stages.copy.resources.data.uniqueId,
    state.source.lineage.dataDiskUniqueId,
  );
  for (const [name, bytes] of Object.entries(f.files)) {
    assert.equal(await readFile(join(f.original, name), 'utf8'), bytes);
    assert.equal(await readFile(join(f.target, 'source', name), 'utf8'), bytes);
    assert.equal(
      (await lstat(join(f.target, 'source', name))).mode & 0o777,
      0o600,
    );
  }
  assert.deepEqual(state.source, initial.source);
  for (const stage of ['group', 'capture', 'copy'])
    await assert.rejects(f.controller.apply(stage), /durable intent/);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
  f.power = 'PowerState/running';
  f.compile = async () => {
    throw new Error(
      'Changed future templates are not needed to observe applied evidence',
    );
  };
  await f.close();
  await f.open();
  assert.equal((await f.controller.reconcile('capture')).historical, true);
  assert.equal((await f.controller.reconcile('copy')).historical, true);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
});

test('actual finite CLI commands execute all three stages with synthetic state and mocked provider calls', async (t) => {
  const f = await migrationFixture(t);
  await f.cli(['prepare']);
  for (const stage of ['group', 'capture', 'copy']) {
    await f.cli(['preflight', stage]);
    await f.cli(['validate', stage]);
    await f.open();
    await f.review(stage);
    await f.close();
    await f.cli(['apply', stage]);
    await f.cli(['reconcile', stage]);
    assert.equal((await f.diskState()).stages[stage].status, 'complete');
  }
  assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
});

const drift = {
  running: (f) => {
    f.power = 'PowerState/running';
  },
  stopped: (f) => {
    f.power = 'PowerState/stopped';
  },
  'VM replacement': (f) => {
    f.source.vm.properties.vmId = '99999999-9999-9999-9999-999999999999';
  },
  'MI replacement': (f) => {
    f.source.vm.identity.principalId = '99999999-9999-9999-9999-999999999999';
  },
  tenant: (f) => {
    f.source.vm.identity.tenantId = 'foreign';
  },
  'data replacement': (f) => {
    f.source.disk.properties.uniqueId = 'foreign';
  },
  'OS replacement': (f) => {
    f.source.os.properties.uniqueId = 'foreign';
  },
  'wrong attachment': (f) => {
    f.source.disk.managedBy += '-foreign';
  },
  'shared attachment': (f) => {
    f.source.disk.managedByExtended = [VM.ids.id, VM.ids.id + '-foreign'];
  },
  'pending detach': (f) => {
    f.source.vm.properties.storageProfile.dataDisks[0].toBeDetached = true;
  },
  'delete OS': (f) => {
    f.source.vm.properties.storageProfile.osDisk.deleteOption = 'Delete';
  },
  'delete data': (f) => {
    f.source.vm.properties.storageProfile.dataDisks[0].deleteOption = 'Delete';
  },
  'source writing': (f) => {
    f.source.disk.properties.diskState = 'Attached';
  },
  'active export': (f) => {
    f.source.os.properties.diskState = 'ActiveSAS';
  },
  'source size': (f) => {
    f.source.os.properties.diskSizeGB = 32;
  },
  'OS security downgrade': (f) => {
    f.source.os.properties.securityProfile.securityType = 'Standard';
  },
  'OS encryption change': (f) => {
    f.source.os.properties.encryption.type = 'EncryptionAtRestWithCustomerKey';
  },
  'OS export rewrite': (f) => {
    f.source.os.properties.networkAccessPolicy = 'DenyAll';
  },
  'data export rewrite': (f) => {
    f.source.disk.properties.publicNetworkAccess = 'Enabled';
  },
  'missing transition evidence': (f) => {
    delete f.source.disk.properties.LastOwnershipUpdateTime;
  },
  'active disk property update': (f) => {
    f.source.disk.properties.propertyUpdatesInProgress = {
      targetTier: 'Premium',
    };
  },
};
for (const [name, mutate] of Object.entries(drift))
  test(`cold source rejects ${name}, without provider mutations or state refresh`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    const before = await f.diskState();
    mutate(f);
    await assert.rejects(f.controller.preflight('group'));
    assert.deepEqual(await f.diskState(), before);
    assert.equal(f.creates.length, 0);
    assert(
      !f.calls.some((args) =>
        ['validate', 'what-if', 'create'].includes(args[2]),
      ),
    );
  });

test('existing matching-tag RG, snapshot or deployment without intent is not adopted', async (t) => {
  for (const kind of ['group', 'snapshot', 'deployment']) {
    const f = await migrationFixture(t);
    await f.prepare();
    if (kind === 'group')
      f.group = {
        ...desiredResources(SCUS_PROFILE, await f.diskState(), 'group')[0],
        properties: { provisioningState: 'Succeeded' },
      };
    if (kind === 'deployment')
      f.deployments.set('group', {
        id: `/subscriptions/${SCOPE.subscriptionId}/providers/Microsoft.Resources/deployments/opendots-scus-group-v1`,
        name: 'opendots-scus-group-v1',
      });
    if (kind === 'snapshot') {
      await f.stage('group');
      const spec = desiredResources(
        SCUS_PROFILE,
        await f.diskState(),
        'capture',
      )[0];
      f.resources.set(spec.id, spec);
    }
    const writes = f.creates.length;
    await assert.rejects(
      f.controller.preflight(kind === 'snapshot' ? 'capture' : 'group'),
      /adoption|untracked/,
    );
    assert.equal(f.creates.length, writes);
  }
});

for (const when of ['before', 'after'])
  for (const stage of ['group', 'capture', 'copy'])
    test(`ambiguous ${stage} submission ${when} provider acceptance is never retried`, async (t) => {
      const f = await migrationFixture(t);
      await f.prepare();
      for (const predecessor of ['group', 'capture', 'copy'].slice(
        0,
        ['group', 'capture', 'copy'].indexOf(stage),
      ))
        await f.stage(predecessor);
      await f.controller.validate(stage);
      await f.review(stage);
      f.createFault = when;
      await assert.rejects(
        f.controller.apply(stage),
        (error) => !safeError(error).includes('FAKE-PRIVATE'),
      );
      assert((await f.diskState()).stages[stage].intent);
      await f.close();
      await f.open();
      await assert.rejects(f.controller.apply(stage), /durable intent/);
      const count = f.creates.length;
      const result = await f.controller.reconcile(stage);
      assert.equal(result.status, when === 'after' ? 'complete' : 'pending');
      assert.equal(f.creates.length, count);
    });

for (const mode of [
  'running',
  'transition-while-off',
  'source-inventory',
  'read-error',
])
  test(`capture ${mode} after dispatch permanently marks uncertain preservation without cleanup`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.stage('group');
    await f.controller.validate('capture');
    await f.review('capture');
    f.afterCreate = async () => {
      if (mode === 'running') f.power = 'PowerState/running';
      if (mode === 'transition-while-off')
        f.source.os.properties.LastOwnershipUpdateTime =
          new Date().toISOString();
      if (mode === 'source-inventory')
        f.source.disk.tags.changed = 'required-record';
      if (mode === 'read-error') f.readFault = VM.ids.osDiskId;
    };
    await assert.rejects(f.controller.apply('capture'), /uncertain/);
    assert.equal(
      (await f.diskState()).stages.capture.uncertainPreservation,
      true,
    );
    assert.equal(f.resources.size, 2);
    f.power = 'PowerState/deallocated';
    f.readFault = undefined;
    f.source.os.properties.LastOwnershipUpdateTime = '2026-10-25T16:00:00.000Z';
    delete f.source.disk.tags.changed;
    await assert.rejects(f.controller.reconcile('capture'), /Uncertain/);
    await assert.rejects(f.controller.preflight('copy'), /capture/);
    assert.deepEqual(f.creates, ['group', 'capture']);
  });

for (const progress of [undefined, null, 0, 50, '100', 101])
  test(`copy progress ${String(progress)} cannot complete or trigger another create`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.stage('group');
    await f.stage('capture');
    f.completionPercent = progress;
    assert.equal((await f.stage('copy')).status, 'pending');
    const pinned = structuredClone((await f.diskState()).stages.copy.resources);
    const count = f.creates.length;
    assert.equal((await f.controller.reconcile('copy')).status, 'pending');
    assert.equal(f.creates.length, count);
    for (const id of stageIds(SCUS_PROFILE, 'copy'))
      f.resources.get(id).properties.completionPercent = 100;
    assert.equal((await f.controller.reconcile('copy')).status, 'complete');
    assert.deepEqual((await f.diskState()).stages.copy.resources, pinned);
    assert.equal(f.creates.length, count);
  });

for (const field of [
  'uniqueId',
  'incrementalSnapshotFamilyId',
  'sourceUniqueId',
  'sourceResourceId',
  'securityProfile',
  'copyCompletionError',
])
  test(`copy rejects substituted or failed snapshot ${field}`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.stage('group');
    await f.stage('capture');
    f.completionPercent = 10;
    await f.stage('copy');
    const value = f.resources.get(stageIds(SCUS_PROFILE, 'copy')[0]).properties;
    if (field === 'copyCompletionError')
      value.copyCompletionError = {
        errorCode: 'CopySourceNotFound',
        errorMessage: 'FAKE-PRIVATE-ERROR',
      };
    else if (field === 'securityProfile')
      value.securityProfile = { securityType: 'Standard' };
    else if (field === 'sourceUniqueId')
      value.creationData.sourceUniqueId =
        '99999999-9999-9999-9999-999999999999';
    else if (field === 'sourceResourceId')
      value.creationData.sourceResourceId += '-foreign';
    else value[field] = '99999999-9999-9999-9999-999999999999';
    value.completionPercent = 100;
    const count = f.creates.length;
    await assert.rejects(
      f.controller.reconcile('copy'),
      (error) => !safeError(error).includes('FAKE-PRIVATE'),
    );
    assert.equal(f.creates.length, count);
    assert.notEqual((await f.diskState()).stages.copy.status, 'complete');
  });

test('copied source snapshot replacement prevents later authorization, and historical observation does not authorize new templates', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  await f.stage('group');
  await f.stage('capture');
  f.resources.get(stageIds(SCUS_PROFILE, 'capture')[0]).properties.uniqueId =
    '99999999-9999-9999-9999-999999999999';
  await assert.rejects(f.controller.validate('copy'), /replaced/);
  assert.deepEqual(f.creates, ['group', 'capture']);
});

for (const field of [
  'profileId',
  'migrationId',
  'stage',
  'proposalSha256',
  'changesSha256',
  'reviewSha256',
  'reviewedAt',
])
  test(`manual review ${field} mismatch fails before create`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.controller.validate('group');
    await f.review('group');
    const review = await f.store.read('group-review.json');
    review[field] = 'foreign';
    await f.store.write('group-review.json', review);
    await assert.rejects(f.controller.apply('group'), /manual review/);
    assert.deepEqual(f.creates, []);
    assert(!(await f.diskState()).stages.group.intent);
  });

test('fresh what-if/validation drift, source drift and compiled-byte changes cannot consume an earlier review', async (t) => {
  for (const change of ['what-if', 'validation', 'source', 'template-bytes']) {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.controller.validate('group');
    await f.review('group');
    if (change === 'what-if')
      f.whatIfMutation = (value) => {
        value.changes[0].changeType = 'Delete';
      };
    if (change === 'validation')
      f.validationMutation = (value) => {
        value.properties.validatedResources = [];
      };
    if (change === 'source')
      f.source.disk.properties.LastOwnershipUpdateTime =
        new Date().toISOString();
    if (change === 'template-bytes') {
      await f.close();
      f.compile = async (_profile, stage) => compiled[stage] + '\n';
      await f.open();
    }
    await assert.rejects(f.controller.apply('group'));
    assert.deepEqual(f.creates, []);
    assert(!(await f.diskState()).stages.group.intent);
  }
});

for (const boundary of [
  'intent-before',
  'intent-after',
  'receipt-before',
  'receipt-after',
])
  test(`durability failure at ${boundary} retains the exact intent or proves no create occurred; reload never blindly resubmits`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.controller.validate('group');
    await f.review('group');
    const save = f.store.save;
    f.store.save = async (value) => {
      const stage = value.stages.group;
      if (
        stage?.intent &&
        (boundary.startsWith('intent') ? !stage.deployment : !!stage.deployment)
      ) {
        if (boundary.endsWith('after')) await save(value);
        throw new Error('fixture durability failure');
      }
      return save(value);
    };
    await assert.rejects(f.controller.apply('group'));
    assert.equal(f.creates.length, boundary.startsWith('intent') ? 0 : 1);
    await f.close();
    await f.open();
    const state = await f.diskState();
    if (state.stages.group.intent) {
      await assert.rejects(f.controller.apply('group'), /durable intent/);
      const count = f.creates.length;
      assert.equal(
        (await f.controller.reconcile('group')).status,
        boundary.startsWith('receipt') ? 'complete' : 'pending',
      );
      assert.equal(f.creates.length, count);
    }
  });

test('private archives reject unsafe modes, symlinks, foreign ownership, changed bytes, transplanted state and existing locks', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  await assert.rejects(
    openMigrationStore(SCUS_PROFILE, f.root),
    /lock already exists/,
  );
  await assert.rejects(f.store.read('.env'), /Unrecognized/);
  await assert.rejects(f.store.write('../vm-state.json', {}), /Unrecognized/);
  assert.throws(
    () =>
      assertMigrationState(JSON.parse(f.files['vm-state.json']), SCUS_PROFILE),
    /transplanted/,
  );
  const state = await f.diskState();
  assert.throws(
    () => assertMigrationState({ ...state, management: {} }, SCUS_PROFILE),
    /transplanted/,
  );
  const path = join(f.target, 'source', 'vm-state.json');
  await chmod(path, 0o644);
  await assert.rejects(f.controller.preflight('group'), /private owner-only/);
  await chmod(path, 0o600);
  await writeFile(path, f.files['vm-state.json'] + ' ');
  await assert.rejects(
    f.controller.preflight('group'),
    /archive bytes changed/,
  );
  await unlink(path);
  await symlink(join(f.original, 'vm-state.json'), path);
  await assert.rejects(f.controller.preflight('group'));
  await unlink(path);
  await writeFile(path, f.files['vm-state.json'], { mode: 0o600 });
  await f.close();
  const uid = process.getuid();
  t.mock.method(process, 'getuid', () => uid + 1);
  await assert.rejects(openMigrationStore(SCUS_PROFILE, f.root), /owned/);
  t.mock.restoreAll();
  assert.deepEqual(f.creates, []);
});

test('private request descriptors remain readable by the CLI child while source files remain untouched', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  await f.store.write('group-template.json', compiled.group);
  const result = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    'import {readFileSync} from "node:fs"; process.stdout.write(readFileSync(process.argv[1]));',
    f.store.deploymentPath('group-template.json'),
  ]);
  assert.equal(result.stdout, compiled.group);
  for (const [name, content] of Object.entries(f.files))
    assert.equal(await readFile(join(f.original, name), 'utf8'), content);
});

for (const file of ['template', 'parameters'])
  test(`changed private ${file} request after validation cannot reach create`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.controller.validate('group');
    await f.review('group');
    f.afterWhatIf = async () => f.store.write(`group-${file}.json`, {});
    await assert.rejects(
      f.controller.apply('group'),
      /request bytes or parameters/,
    );
    assert.equal(f.creates.length, 0);
    assert(!(await f.diskState()).stages.group.intent);
  });

test('normal lock release never deletes a replaced operation lock', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  const store = f.store;
  const path = join(f.target, 'operator.lock');
  await unlink(path);
  await writeFile(path, 'different operator', { mode: 0o600 });
  f.store = undefined;
  await assert.rejects(store.close(), /lock was replaced/);
  assert.equal(await readFile(path, 'utf8'), 'different operator');
});
