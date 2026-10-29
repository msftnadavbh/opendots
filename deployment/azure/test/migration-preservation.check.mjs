import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCUS_PROFILE } from '../profiles.mjs';
import { SCOPE } from '../scope.mjs';
import { hashObject } from '../migration-state.mjs';
import {
  snapshotReady,
  snapshotRecord,
  stageIds,
  desiredResources,
} from '../migration-validation.mjs';
import { migrationFixture } from './migration-fixture.mjs';

const pendingStates = [
  undefined,
  null,
  'Unknown',
  'Pending',
  'InstantAccess',
  'Unrecognized',
  'available',
];
const readyStates = ['Available', 'AvailableWithInstantAccess'];
const properties = (f, stage, index = 0) =>
  f.resources.get(stageIds(SCUS_PROFILE, stage)[index]).properties;
async function captured(t) {
  const f = await migrationFixture(t);
  await f.prepare();
  await f.stage('group');
  await f.stage('capture');
  return f;
}

test('snapshot readiness requires exact access state and numeric copy completion, with failure precedence', () => {
  for (const stage of ['capture', 'copy'])
    for (const access of [...pendingStates, ...readyStates]) {
      for (const completionPercent of [
        undefined,
        null,
        0,
        50,
        99,
        100,
        '100',
        101,
        NaN,
        Infinity,
      ]) {
        const p = {
          provisioningState: 'Succeeded',
          snapshotAccessState: access,
          completionPercent,
        };
        assert.equal(
          snapshotReady({ properties: p }, stage),
          readyStates.includes(access) &&
            (stage === 'capture' || completionPercent === 100),
        );
        for (const provisioningState of ['Updating', undefined, null])
          assert.equal(
            snapshotReady({ properties: { ...p, provisioningState } }, stage),
            false,
          );
        for (const provisioningState of ['Failed', 'Canceled'])
          assert.throws(
            () =>
              snapshotReady({ properties: { ...p, provisioningState } }, stage),
            /failed/,
          );
        for (const copyCompletionError of [
          {},
          { errorCode: 'CopySourceNotFound' },
        ])
          assert.throws(
            () =>
              snapshotReady(
                { properties: { ...p, copyCompletionError } },
                stage,
              ),
            /failed/,
          );
      }
    }
});

for (const stage of ['capture', 'copy'])
  test(`${stage} access-state transitions stay pending then complete via GET without changing pins or repeating CREATE`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.stage('group');
    if (stage === 'copy') await f.stage('capture');
    f.snapshotAccessState[stage] = 'Pending';
    assert.equal((await f.stage(stage)).status, 'pending');
    const pins = structuredClone((await f.diskState()).stages[stage].resources),
      writes = [...f.creates];
    await f.close();
    await f.open();
    for (const access of pendingStates) {
      for (const id of stageIds(SCUS_PROFILE, stage)) {
        const p = f.resources.get(id).properties;
        if (access === undefined) delete p.snapshotAccessState;
        else p.snapshotAccessState = access;
      }
      assert.equal((await f.controller.reconcile(stage)).status, 'pending');
      assert.deepEqual((await f.diskState()).stages[stage].resources, pins);
      if (stage === 'capture')
        await assert.rejects(f.controller.preflight('copy'), /cold capture/);
    }
    for (const access of readyStates) {
      for (const id of stageIds(SCUS_PROFILE, stage))
        f.resources.get(id).properties.snapshotAccessState = access;
      assert.equal((await f.controller.reconcile(stage)).status, 'complete');
      assert.deepEqual((await f.diskState()).stages[stage].resources, pins);
    }
    for (const record of Object.values(pins)) {
      assert(!Object.hasOwn(record, 'snapshotAccessState'));
      assert(!Object.hasOwn(record, 'completionPercent'));
    }
    assert.deepEqual(f.creates, writes);
  });

test('fresh copy authorization rechecks source snapshot access even after historical capture completion', async (t) => {
  const f = await captured(t);
  const pins = (await f.diskState()).stages.capture.resources;
  for (const access of pendingStates) {
    properties(f, 'capture').snapshotAccessState = access;
    const count = f.calls.length;
    await assert.rejects(f.controller.validate('copy'), /not ready/);
    assert(
      !f.calls
        .slice(count)
        .some((args) => ['validate', 'what-if', 'create'].includes(args[2])),
    );
  }
  properties(f, 'capture').snapshotAccessState = 'AvailableWithInstantAccess';
  assert.equal((await f.controller.preflight('copy')).status, 'preflight-only');
  assert.deepEqual((await f.diskState()).stages.capture.resources, pins);
  assert.deepEqual(f.creates, ['group', 'capture']);
});

for (const stage of ['capture', 'copy'])
  test(`${stage} reports the second snapshot failure even while the first has pending access`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.stage('group');
    if (stage === 'copy') await f.stage('capture');
    f.afterCreate = () => {
      properties(f, stage, 0).snapshotAccessState = 'Pending';
      properties(f, stage, 1).copyCompletionError = {
        errorCode: 'CopySourceNotFound',
      };
    };
    await assert.rejects(f.stage(stage), /Snapshot copy failed/);
    const saved = (await f.diskState()).stages[stage];
    assert.equal(saved.status, 'pending');
    assert(saved.intent);
    assert(saved.resources.os);
    assert(saved.resources.data);
  });

for (const os of ['captured-snapshot', 'original-disk'])
  for (const data of ['captured-snapshot', 'original-disk'])
    test(`CopyStart pins exact observed ${os} OS / ${data} data lineage across reopen and completion, without changing request tags`, async (t) => {
      const f = await captured(t);
      f.copyLineage = { os, data };
      f.completionPercent = 50;
      assert.equal((await f.stage('copy')).status, 'pending');
      const state = await f.diskState(),
        pins = structuredClone(state.stages.copy.resources);
      for (const [index, kind] of ['os', 'data'].entries()) {
        const source = state.stages.capture.resources[kind],
          record = pins[kind];
        assert.equal(
          source.sourceUniqueId,
          state.source.lineage[`${kind}DiskUniqueId`],
        );
        assert(!Object.hasOwn(source, 'sourceUniqueIdKind'));
        assert.equal(record.sourceUniqueIdKind, f.copyLineage[kind]);
        assert.equal(
          record.sourceUniqueId,
          f.copyLineage[kind] === 'captured-snapshot'
            ? source.uniqueId
            : source.sourceUniqueId,
        );
        assert.equal(record.sourceResourceId, source.id);
        assert.equal(
          state.stages.copy.intent.request.expected[index].tags
            .expectedSourceUniqueId,
          source.uniqueId,
        );
        assert.equal(
          state.stages.copy.intent.request.parameters[`${kind}SourceUniqueId`]
            .value,
          source.uniqueId,
        );
      }
      await f.close();
      await f.open();
      assert.equal((await f.controller.reconcile('copy')).status, 'pending');
      for (const id of stageIds(SCUS_PROFILE, 'copy'))
        f.resources.get(id).properties.completionPercent = 100;
      assert.equal((await f.controller.reconcile('copy')).status, 'complete');
      assert.deepEqual((await f.diskState()).stages.copy.resources, pins);
      assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
    });

for (const initial of ['captured-snapshot', 'original-disk'])
  test(`CopyStart cannot switch the initially observed ${initial} interpretation`, async (t) => {
    const f = await captured(t);
    f.copyLineage = { os: initial, data: initial };
    f.completionPercent = 50;
    await f.stage('copy');
    const state = await f.diskState(),
      pins = structuredClone(state.stages.copy.resources);
    properties(f, 'copy').creationData.sourceUniqueId =
      initial === 'captured-snapshot'
        ? state.source.lineage.osDiskUniqueId
        : state.stages.capture.resources.os.uniqueId;
    await f.close();
    await f.open();
    await assert.rejects(f.controller.reconcile('copy'), /replaced/);
    assert.deepEqual((await f.diskState()).stages.copy.resources, pins);
    properties(f, 'copy').creationData.sourceUniqueId = pins.os.sourceUniqueId;
    const altered = await f.diskState();
    altered.stages.copy.resources.os.sourceUniqueIdKind =
      initial === 'original-disk' ? 'captured-snapshot' : 'original-disk';
    await f.store.save(altered);
    await assert.rejects(f.controller.reconcile('copy'), /replaced/);
    assert.equal(
      (await f.diskState()).stages.copy.resources.os.sourceUniqueIdKind,
      altered.stages.copy.resources.os.sourceUniqueIdKind,
    );
    assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
  });

test('first CopyStart readback rejects missing, arbitrary, cross-disk and destination unique IDs without pinning them', async (t) => {
  const f = await captured(t);
  f.createFault = 'after';
  await assert.rejects(f.stage('copy'), /Azure CLI/);
  const state = await f.diskState(),
    p = properties(f, 'copy');
  for (const id of [
    undefined,
    null,
    '',
    '99999999-9999-9999-9999-999999999999',
    state.source.lineage.dataDiskUniqueId,
    state.stages.capture.resources.data.uniqueId,
    p.uniqueId,
  ]) {
    p.creationData.sourceUniqueId = id;
    await assert.rejects(f.controller.reconcile('copy'), /neither the exact/);
    assert(!(await f.diskState()).stages.copy.resources?.os);
  }
  p.creationData.sourceUniqueId = state.source.lineage.osDiskUniqueId;
  p.creationData.sourceResourceId = state.source.lineage.osDiskId;
  await assert.rejects(
    f.controller.reconcile('copy'),
    /immutable source lineage/,
  );
  assert(!(await f.diskState()).stages.copy.resources?.os);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
});

test('CopyStart compatibility derives its two interpretations only from verified captured-root state, never arbitrary caller lists or request tags', async (t) => {
  const f = await captured(t);
  f.copyLineage.os = 'original-disk';
  await f.stage('copy');
  const state = await f.diskState(),
    spec = desiredResources(SCUS_PROFILE, state, 'copy')[0];
  const value = f.resources.get(spec.id),
    at = state.stages.copy.intent.at;
  for (const mutate of [
    (s) => {
      s.stages.capture.resources.os.sourceUniqueId =
        s.source.lineage.dataDiskUniqueId;
    },
    (s) => {
      s.stages.capture.resources.os.sourceResourceId =
        s.source.lineage.dataDiskId;
    },
    (s) => {
      s.stages.capture.resources.os = s.stages.capture.resources.data;
    },
    (s) => {
      delete s.source.lineage.osDiskUniqueId;
    },
  ]) {
    const altered = structuredClone(state);
    mutate(altered);
    assert.throws(
      () => snapshotRecord(value, spec, undefined, at, altered),
      /lineage lacks/,
    );
  }
  assert.throws(
    () =>
      snapshotRecord(value, spec, undefined, at, [
        value.properties.creationData.sourceUniqueId,
      ]),
    /lineage lacks/,
  );
  const alteredSpec = structuredClone(spec);
  alteredSpec.tags.expectedSourceUniqueId = state.source.lineage.osDiskUniqueId;
  assert.throws(
    () => snapshotRecord(value, alteredSpec, undefined, at, state),
    /lineage lacks/,
  );
});

const sourceDrift = [
  (p) => {
    p.uniqueId = '99999999-9999-9999-9999-999999999999';
  },
  (p) => {
    p.incrementalSnapshotFamilyId = '99999999-9999-9999-9999-999999999999';
  },
  (p) => {
    p.timeCreated = new Date(Date.parse(p.timeCreated) + 1000).toISOString();
  },
  (p) => {
    p.creationData.sourceUniqueId = '99999999-9999-9999-9999-999999999999';
  },
  (p) => {
    p.creationData.sourceResourceId += '-substituted';
  },
  (p) => {
    p.securityProfile.securityType = 'Standard';
  },
  (p) => {
    p.networkAccessPolicy = 'AllowAll';
  },
  (p) => {
    p.publicNetworkAccess = 'Enabled';
  },
];
for (const boundary of ['authorization', 'first-readback'])
  test(`captured snapshot identity/root/security/export is refreshed before copy ${boundary}`, async (t) => {
    const f = await captured(t);
    if (boundary === 'first-readback') {
      f.createFault = 'after';
      await assert.rejects(f.stage('copy'));
    }
    const sourceId = stageIds(SCUS_PROFILE, 'capture')[0],
      original = structuredClone(f.resources.get(sourceId));
    for (const mutate of sourceDrift) {
      mutate(properties(f, 'capture'));
      const start = f.calls.length;
      await assert.rejects(
        boundary === 'authorization'
          ? f.controller.preflight('copy')
          : f.controller.reconcile('copy'),
      );
      assert(
        !f.calls
          .slice(start)
          .some(
            (args) =>
              args[0] === 'resource' &&
              args[1] === 'show' &&
              stageIds(SCUS_PROFILE, 'copy').includes(args[3]),
          ),
      );
      assert(!(await f.diskState()).stages.copy?.resources?.os);
      f.resources.set(sourceId, structuredClone(original));
    }
    assert.deepEqual(
      f.creates,
      boundary === 'authorization'
        ? ['group', 'capture']
        : ['group', 'capture', 'copy'],
    );
  });

test('captured lineage is refreshed again after destination reads and before copy completion', async (t) => {
  const f = await captured(t);
  let changed = false;
  f.afterCall = (args) => {
    if (
      args[0] === 'resource' &&
      args[1] === 'show' &&
      args[3] === stageIds(SCUS_PROFILE, 'copy')[1]
    ) {
      properties(f, 'capture', 1).uniqueId =
        '99999999-9999-9999-9999-999999999999';
      changed = true;
    }
  };
  await assert.rejects(f.stage('copy'), /replaced/);
  assert(changed);
  const state = await f.diskState();
  assert.equal(state.stages.copy.status, 'pending');
  assert(state.stages.copy.resources.os);
  assert(state.stages.copy.resources.data);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
});

test('unrelated source-RG tag changes and additions do not invalidate reviewed source proof or cold capture', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  await f.stage('group');
  await f.controller.validate('capture');
  await f.review('capture');
  const source = (await f.diskState()).stages.capture.validation.request.source;
  assert.equal(source.inventoryProjection, 'source-vm-os-data-v1');
  f.source.nic.tags.changed = 'unrelated-before-apply';
  f.afterCreate = () => {
    f.source.registry = {
      id: SCUS_PROFILE.sharedServices.registry.id,
      type: 'Microsoft.ContainerRegistry/registries',
      location: 'eastus2',
      tags: { changed: 'unrelated' },
    };
    f.source.foundry = {
      id: SCUS_PROFILE.sharedServices.foundry.id,
      type: 'Microsoft.CognitiveServices/accounts',
      location: 'eastus2',
      tags: { changed: 'unrelated' },
    };
  };
  assert.equal((await f.controller.apply('capture')).status, 'complete');
  assert.deepEqual(
    (await f.diskState()).stages.capture.intent.request.source,
    source,
  );
  assert.equal((await f.controller.preflight('copy')).status, 'preflight-only');
  assert(!(await f.diskState()).stages.capture.uncertainPreservation);
});

for (const fault of [
  'missing-required',
  'duplicate-required',
  'duplicate-unrelated',
  'invalid-unrelated-shape',
  'non-array',
  'read-error',
])
  test(`full source inventory still rejects ${fault} during capture and makes uncertainty sticky`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.stage('group');
    f.afterCreate = () => {
      f.inventoryResponse = (items, group) => {
        if (group !== SCOPE.resourceGroup) return items;
        if (fault === 'missing-required')
          return items.filter(
            (item) => item.id !== SCUS_PROFILE.sourcePreservation.osDiskId,
          );
        if (fault === 'duplicate-required')
          return [
            ...items,
            items.find(
              (item) => item.id === SCUS_PROFILE.sourcePreservation.osDiskId,
            ),
          ];
        if (fault === 'duplicate-unrelated') return [...items, f.source.nic];
        if (fault === 'invalid-unrelated-shape')
          return [...items, { id: 'unrelated', type: null }];
        if (fault === 'non-array') return null;
        throw new Error('source inventory read failed');
      };
    };
    await assert.rejects(f.stage('capture'), /uncertain/);
    assert.equal(
      (await f.diskState()).stages.capture.uncertainPreservation,
      true,
    );
    f.inventoryResponse = undefined;
    await assert.rejects(f.controller.reconcile('capture'), /Uncertain/);
    await assert.rejects(f.controller.preflight('copy'), /capture/);
    assert.deepEqual(f.creates, ['group', 'capture']);
  });

for (const boundary of ['pending-deployment', 'completion'])
  test(`required source record drift at ${boundary} is retained by the early and completion capture checks`, async (t) => {
    const f = await migrationFixture(t);
    await f.prepare();
    await f.stage('group');
    if (boundary === 'pending-deployment')
      f.afterCreate = () => {
        f.deployments.get('capture').properties.provisioningState = 'Running';
        f.source.disk.tags.changed = 'required';
      };
    else
      f.afterCall = (args) => {
        if (
          args[0] === 'resource' &&
          args[1] === 'show' &&
          args[3] === stageIds(SCUS_PROFILE, 'capture')[1]
        )
          f.source.disk.tags.changed = 'required';
      };
    await assert.rejects(f.stage('capture'), /uncertain/);
    const intent = (await f.diskState()).stages.capture.intent;
    delete f.source.disk.tags.changed;
    f.afterCall = undefined;
    f.deployments.get('capture').properties.provisioningState = 'Succeeded';
    await f.close();
    await f.open();
    await assert.rejects(f.controller.reconcile('capture'), /Uncertain/);
    assert.deepEqual((await f.diskState()).stages.capture.intent, intent);
    assert.equal(
      (await f.diskState()).stages.capture.uncertainPreservation,
      true,
    );
  });

test('legacy whole-RG proof is not reinterpreted, rebound or rewritten into the versioned source projection', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  await f.controller.validate('group');
  const state = await f.diskState(),
    proof = state.stages.group.validation;
  delete proof.request.source.inventoryProjection;
  proof.request.source.inventorySha256 = hashObject(
    Object.values(f.source)
      .filter((item) => item !== f.source.role)
      .map(({ id, type, location, tags }) => ({ id, type, location, tags }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  proof.requestSha256 = hashObject(proof.request);
  await f.store.save(state);
  await f.review('group');
  const before = await f.diskState();
  await assert.rejects(f.controller.apply('group'), /manual review/);
  assert.deepEqual(await f.diskState(), before);
  assert.deepEqual(f.creates, []);
});

test('unfinished legacy capture intent keeps its original hash and becomes uncertain rather than being converted', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  await f.stage('group');
  f.snapshotAccessState.capture = 'Pending';
  await f.stage('capture');
  const state = await f.diskState(),
    intent = state.stages.capture.intent;
  delete intent.request.source.inventoryProjection;
  intent.requestSha256 = hashObject(intent.request);
  await f.store.save(state);
  const historical = structuredClone(intent);
  await assert.rejects(f.controller.reconcile('capture'), /uncertain/);
  assert.deepEqual((await f.diskState()).stages.capture.intent, historical);
  assert.equal(
    (await f.diskState()).stages.capture.uncertainPreservation,
    true,
  );
});
