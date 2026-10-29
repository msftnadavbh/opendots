import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCUS_PROFILE } from '../profiles.mjs';
import { SCOPE, VM } from '../scope.mjs';
import { hashObject } from '../migration-state.mjs';
import { assertStageOutputs, stageIds } from '../migration-validation.mjs';
import {
  HOST_OBSERVATION_QUERY,
  hostImageId,
  hostObservation,
  modelRoleListUrl,
} from '../migration-host.mjs';
import { migrationFixture } from './migration-fixture.mjs';

const pipIpTags = [{ ipTagType: 'FirstPartyUsage', tag: '/Unprivileged' }];

async function preserved(t) {
  const f = await migrationFixture(t);
  await f.prepare();
  for (const stage of ['group', 'capture', 'copy']) await f.stage(stage);
  return f;
}
const resource = (f, kind) => {
  const c = SCUS_PROFILE.compute;
  return f.resources.get(
    kind === 'vm' ? c.vm.id : (c.disks[kind] ?? c.network[kind]).id,
  );
};
async function pendingHost(t) {
  const f = await preserved(t);
  await f.prepareHost();
  f.createFault = 'after';
  await assert.rejects(f.stage('host'), /Azure CLI/);
  f.createFault = undefined;
  assert(!(await f.diskState()).stages.host.binding);
  return f;
}

test('working finite B1 flow uses a fresh private key, binds host and implicit OS, then assigns the actual MI role only in the shared RG', async (t) => {
  const f = await preserved(t),
    before = await f.diskState();
  const prepareCalls = f.calls.length;
  await f.prepareHost();
  assert.equal(f.calls.length, prepareCalls);
  const prepared = await f.diskState();
  const keyPath = join(
    f.target,
    SCUS_PROFILE.artifacts.hostKey.directory,
    SCUS_PROFILE.artifacts.hostKey.privateFile,
  );
  const keyBytes = await readFile(keyPath);
  assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
  assert.notEqual(
    prepared.stages.host.preparation.publicKey,
    JSON.parse(f.files['vm-parameters.json']).parameters.sshPublicKey.value,
  );
  const host = await f.stage('host');
  assert.equal(host.status, 'complete');
  assert.equal(host.hostBound, true);
  assert.equal(host.applicationActivated, false);
  assert.equal(host.sizeEvidence, 'created OS reports 32GiB');
  const bound = (await f.diskState()).stages.host.binding;
  assert.equal(bound.disks.os.sizeGiB, 32);
  assert.equal(bound.disks.os.networkAccessPolicy, 'AllowAll');
  assert.equal(bound.disks.audit.managedBy, null);
  assert.equal(bound.disks.audit.sizeGiB, 30);
  assert.equal(bound.network.privateIpv4, '10.43.0.4');
  assert.deepEqual(bound.network.resources.pip.ipTags, pipIpTags);
  assert.deepEqual(resource(f, 'pip').properties.ipTags, pipIpTags);
  const role = await f.stage('model-role');
  assert.equal(role.status, 'complete');
  assert.equal(role.modelRoleAssigned, true);
  assert.equal(role.inferenceVerified, false);
  const state = await f.diskState();
  assert.equal(
    state.stages['model-role'].intent.request.parameters.principalId.value,
    bound.vm.principalId,
  );
  assert.equal(
    state.stages['model-role'].binding.scope,
    SCUS_PROFILE.sharedServices.foundry.id,
  );
  assert(
    f.calls.some(
      (args) =>
        args[0] === 'deployment' &&
        args[2] === 'create' &&
        args.includes(SCUS_PROFILE.stages['model-role'].deploymentName) &&
        args.includes(SCUS_PROFILE.sharedServices.resourceGroup),
    ),
  );
  const observation = await f.controller.status();
  assert.equal(observation.power, 'PowerState/running');
  assert.equal(observation.managementQualified, false);
  assert.equal(observation.agent.handlers[0].version, '1.3.7');
  await f.close();
  await f.open();
  await f.prepareHost();
  assert((await readFile(keyPath)).equals(keyBytes));
  for (const stage of ['group', 'capture', 'copy']) {
    await f.controller.reconcile(stage);
    assert.deepEqual(
      (await f.diskState()).stages[stage].intent,
      before.stages[stage].intent,
    );
  }
  for (const stage of ['host', 'model-role']) {
    assert.equal((await f.controller.reconcile(stage)).status, 'complete');
    await assert.rejects(f.controller.apply(stage), /durable intent/);
  }
  assert.deepEqual((await f.diskState()).stages.host.binding, bound);
  assert.deepEqual(f.creates, [
    'group',
    'capture',
    'copy',
    'host',
    'model-role',
  ]);
});

test('actual finite target CLI reaches host and role, while guest/hardening/export commands still fail before effects', async (t) => {
  const f = await preserved(t);
  await f.close();
  await f.cli(['prepare-host']);
  for (const stage of ['host', 'model-role']) {
    await f.cli(['preflight', stage]);
    await f.cli(['validate', stage]);
    await f.open();
    await f.review(stage);
    await f.close();
    await f.cli(['apply', stage]);
    await f.cli(['reconcile', stage]);
  }
  await f.cli(['status']);
  const count = f.calls.length;
  for (const args of [
    ['prepare-host', 'foreign'],
    ['host'],
    ['audit'],
    ['configure'],
    ['activate'],
    ['management-canary'],
    ['apply', 'harden-os'],
    ['apply', 'audit'],
    ['start'],
    ['stop'],
    ['attach-audit'],
    ['export'],
  ])
    await assert.rejects(f.cli(args), /unavailable/);
  assert.equal(f.calls.length, count);
  assert.equal(SCUS_PROFILE.guestBundle.available, false);
});

test('host and role prerequisites reject incomplete/mixed state without cloud or key creation', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  for (const call of [
    () => f.prepareHost(),
    () => f.controller.preflight('host'),
    () => f.controller.validate('model-role'),
  ])
    await assert.rejects(call());
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    lstat(join(f.target, SCUS_PROFILE.artifacts.hostKey.directory)),
    { code: 'ENOENT' },
  );
  for (const stage of ['group', 'capture', 'copy']) await f.stage(stage);
  const count = f.calls.length;
  await assert.rejects(f.controller.preflight('host'), /preparation/);
  await assert.rejects(
    f.controller.preflight('model-role'),
    /actual target host/,
  );
  assert.equal(f.calls.length, count);
  const foreign = await f.diskState();
  foreign.profileId = 'original';
  await writeFile(
    join(f.target, 'migration-state.json'),
    JSON.stringify(foreign),
  );
  await assert.rejects(f.prepareHost(), /foreign|transplanted/);
  await assert.rejects(f.controller.preflight('host'), /foreign|transplanted/);
  assert.equal(f.calls.length, count);
});

for (const data of ['omitted', 'null', 'value'])
  for (const audit of ['omitted', 'null', 'value'])
    test(`restored Copy accepts and preserves data=${data}, audit=${audit} through completed binding, reopen and role assignment`, async (t) => {
      const f = await preserved(t);
      await f.prepareHost();
      f.restoreLineage = { data, audit };
      await f.stage('host');
      const state = await f.diskState();
      for (const kind of ['data', 'audit']) {
        const raw = resource(f, kind).properties.creationData,
          bound = state.stages.host.binding.disks[kind].creation;
        assert.equal(
          bound.sourceUniqueIdRepresentation,
          f.restoreLineage[kind],
        );
        assert.equal(
          Object.hasOwn(bound, 'sourceUniqueId'),
          f.restoreLineage[kind] !== 'omitted',
        );
        assert.equal(
          Object.hasOwn(raw, 'sourceUniqueId'),
          f.restoreLineage[kind] !== 'omitted',
        );
        if (f.restoreLineage[kind] === 'null')
          assert.equal(bound.sourceUniqueId, null);
        if (f.restoreLineage[kind] === 'value')
          assert.equal(
            bound.sourceUniqueId,
            state.stages.copy.resources[kind === 'audit' ? 'os' : 'data']
              .uniqueId,
          );
      }
      const raw = structuredClone([...f.resources.values()]);
      await f.close();
      await f.open();
      assert.equal((await f.controller.reconcile('host')).status, 'complete');
      assert.deepEqual(
        (await f.diskState()).stages.host.binding,
        state.stages.host.binding,
      );
      assert.deepEqual(
        [...f.resources.values()],
        raw,
        'readback must not fill or mutate provider fields',
      );
      assert.equal((await f.stage('model-role')).status, 'complete');
    });

test('restored Copy rejects ancestor, cross-disk, foreign, empty and malformed source UIDs and wrong source ID', async (t) => {
  const f = await pendingHost(t),
    state = await f.diskState();
  const disk = resource(f, 'data').properties;
  for (const value of [
    state.source.lineage.dataDiskUniqueId,
    state.stages.capture.resources.data.uniqueId,
    state.stages.copy.resources.os.uniqueId,
    '99999999-9999-9999-9999-999999999999',
    '',
    'not-a-uuid',
    123,
    {},
  ]) {
    disk.creationData.sourceUniqueId = value;
    await assert.rejects(f.controller.reconcile('host'), /sourceUniqueId/);
    assert(!(await f.diskState()).stages.host.binding);
  }
  delete disk.creationData.sourceUniqueId;
  disk.creationData.sourceResourceId = state.stages.capture.resources.data.id;
  await assert.rejects(
    f.controller.reconcile('host'),
    /exact independently verified SCUS snapshot/,
  );
  await assert.rejects(f.controller.apply('host'), /durable intent/);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
});

for (const initial of ['omitted', 'null', 'value'])
  test(`completed restored-disk ${initial} representation cannot drift later`, async (t) => {
    const f = await preserved(t);
    await f.prepareHost();
    f.restoreLineage.data = initial;
    await f.stage('host');
    const state = await f.diskState(),
      p = resource(f, 'data').properties.creationData;
    const variants = ['omitted', 'null', 'value'].filter((v) => v !== initial);
    for (const next of variants) {
      if (next === 'omitted') delete p.sourceUniqueId;
      else
        p.sourceUniqueId =
          next === 'null' ? null : state.stages.copy.resources.data.uniqueId;
      await assert.rejects(f.controller.reconcile('host'), /binding changed/);
      assert.deepEqual(
        (await f.diskState()).stages.host.binding,
        state.stages.host.binding,
      );
    }
  });

test('an incomplete disk response cannot bind a final absence; Standard_LRS hydration progress is not a snapshot-copy gate', async (t) => {
  const f = await pendingHost(t),
    p = resource(f, 'data').properties;
  delete p.creationData.sourceUniqueId;
  p.provisioningState = 'Updating';
  assert.equal((await f.controller.reconcile('host')).status, 'pending');
  assert(!(await f.diskState()).stages.host.binding);
  p.provisioningState = 'Succeeded';
  p.creationData.sourceUniqueId = (
    await f.diskState()
  ).stages.copy.resources.data.uniqueId;
  p.completionPercent = 15;
  assert.equal((await f.controller.reconcile('host')).status, 'complete');
  assert.equal(
    (await f.diskState()).stages.host.binding.disks.data.creation
      .sourceUniqueIdRepresentation,
    'value',
  );
});

test('copied snapshot identity is refreshed before submission and again after creation even when restored UID is absent', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  const snapshot = f.resources.get(
    SCUS_PROFILE.sourcePreservation.snapshots.targetData.id,
  );
  const original = structuredClone(snapshot);
  for (const mutate of [
    (p) => {
      p.snapshotAccessState = 'Pending';
    },
    (p) => {
      p.completionPercent = '100';
    },
    (p) => {
      p.uniqueId = '99999999-9999-9999-9999-999999999999';
    },
    (p) => {
      p.creationData.sourceUniqueId = '99999999-9999-9999-9999-999999999999';
    },
  ]) {
    mutate(snapshot.properties);
    const count = f.calls.length;
    await assert.rejects(f.controller.validate('host'));
    assert(
      !f.calls
        .slice(count)
        .some((args) => ['validate', 'what-if', 'create'].includes(args[2])),
    );
    snapshot.properties = structuredClone(original.properties);
  }
  f.restoreLineage = { data: 'omitted', audit: 'omitted' };
  f.afterCreate = () => {
    snapshot.properties.uniqueId = '99999999-9999-9999-9999-999999999999';
  };
  await assert.rejects(f.stage('host'), /replaced/);
  assert(!(await f.diskState()).stages.host.binding);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
});

const drift = {
  'authoritative OS size missing': (f) => {
    delete resource(f, 'os').properties.diskSizeGB;
  },
  'authoritative OS size string': (f) => {
    resource(f, 'os').properties.diskSizeGB = '32';
  },
  'authoritative OS size wrong': (f) => {
    resource(f, 'os').properties.diskSizeGB = 31;
  },
  'authoritative SKU missing': (f) => {
    delete resource(f, 'os').sku;
  },
  'authoritative SKU wrong': (f) => {
    resource(f, 'os').sku.name = 'Premium_LRS';
  },
  'contradictory VM size': (f) => {
    resource(f, 'vm').properties.storageProfile.osDisk.diskSizeGB = 31;
  },
  'contradictory VM SKU': (f) => {
    resource(
      f,
      'vm',
    ).properties.storageProfile.osDisk.managedDisk.storageAccountType =
      'Premium_LRS';
  },
  'wrong fresh image': (f) => {
    resource(f, 'os').properties.creationData.imageReference.id += '-other';
  },
  'wrong disk ID': (f) => {
    resource(f, 'data').id += '-other';
  },
  'missing disk unique ID': (f) => {
    delete resource(f, 'data').properties.uniqueId;
  },
  'old disk creation time': (f) => {
    resource(f, 'data').properties.timeCreated = '2020-01-01T00:00:00Z';
  },
  'foreign disk owner': (f) => {
    resource(f, 'data').managedBy = VM.ids.id;
  },
  'audit attachment': (f) => {
    resource(f, 'audit').managedBy = SCUS_PROFILE.compute.vm.id;
    resource(f, 'audit').properties.diskState = 'Attached';
  },
  'audit shared attachment': (f) => {
    resource(f, 'audit').managedByExtended = [VM.ids.id];
  },
  'audit security downgrade': (f) => {
    resource(f, 'audit').properties.securityProfile.securityType = 'Standard';
  },
  'data public export': (f) => {
    resource(f, 'data').properties.networkAccessPolicy = 'AllowAll';
  },
  'data encryption drift': (f) => {
    resource(f, 'data').properties.encryption.type =
      'EncryptionAtRestWithCustomerKey';
  },
  'disk copy error': (f) => {
    resource(f, 'data').properties.copyCompletionError = {
      errorCode: 'CopySourceNotFound',
    };
  },
  'VM original MI transplant': (f) => {
    resource(f, 'vm').identity.principalId = f.source.vm.identity.principalId;
  },
  'VM identity foreign tenant': (f) => {
    resource(f, 'vm').identity.tenantId = 'foreign';
  },
  'extra audit LUN': (f) => {
    resource(f, 'vm').properties.storageProfile.dataDisks.push({
      lun: 1,
      managedDisk: { id: SCUS_PROFILE.compute.disks.audit.id },
    });
  },
  'customData execution': (f) => {
    resource(f, 'vm').properties.osProfile.customData = 'private-script';
  },
  'userData execution': (f) => {
    resource(f, 'vm').properties.userData = 'private-script';
  },
  'guest extension resource': (f) => {
    resource(f, 'vm').resources = [{ name: 'foreign' }];
  },
  'NIC dynamic allocation': (f) => {
    resource(
      f,
      'nic',
    ).properties.ipConfigurations[0].properties.privateIPAllocationMethod =
      'Dynamic';
  },
  'NIC private IP drift': (f) => {
    resource(
      f,
      'nic',
    ).properties.ipConfigurations[0].properties.privateIPAddress = '10.43.0.5';
  },
  'subnet NSG missing': (f) => {
    delete resource(f, 'vnet').properties.subnets[0].properties
      .networkSecurityGroup;
  },
  'NIC NSG foreign': (f) => {
    resource(f, 'nic').properties.networkSecurityGroup.id = VM.ids.nsgId;
  },
  'VNet prefix drift': (f) => {
    resource(f, 'vnet').properties.addressSpace.addressPrefixes = [
      '10.44.0.0/24',
    ];
  },
  'VNet peering': (f) => {
    resource(f, 'vnet').properties.virtualNetworkPeerings = [{ id: 'foreign' }];
  },
  'VNet custom DNS': (f) => {
    resource(f, 'vnet').properties.dhcpOptions = { dnsServers: ['8.8.8.8'] };
  },
  'NSG extra SSH port': (f) => {
    resource(
      f,
      'nsg',
    ).properties.securityRules[0].properties.destinationPortRanges.push('22');
  },
  'NSG broader destination': (f) => {
    resource(
      f,
      'nsg',
    ).properties.securityRules[0].properties.destinationAddressPrefix = '*';
  },
  'NSG reverse attachment foreign': (f) => {
    resource(f, 'nsg').properties.subnets = [{ id: 'foreign' }];
  },
  'public DNS label drift': (f) => {
    resource(f, 'pip').properties.dnsSettings.domainNameLabel = 'foreign';
  },
  'public DNS suffix drift': (f) => {
    resource(f, 'pip').properties.dnsSettings.fqdn = 'foreign.example';
  },
  'public IP prefix overlay': (f) => {
    resource(f, 'pip').properties.publicIPPrefix = { id: 'foreign' };
  },
  'linked public IP overlay': (f) => {
    resource(f, 'pip').properties.linkedPublicIPAddress = { id: 'foreign' };
  },
  'service public IP overlay': (f) => {
    resource(f, 'pip').properties.servicePublicIPAddress = { id: 'foreign' };
  },
  'public IP NAT overlay': (f) => {
    resource(f, 'pip').properties.natGateway = { id: 'foreign' };
  },
  'subnet routing overlay': (f) => {
    resource(f, 'vnet').properties.subnets[0].properties.routeTable = {
      id: 'foreign',
    };
  },
};
for (const [name, mutate] of Object.entries(drift))
  test(`host binding rejects ${name} without accepting partial bindings or retrying`, async (t) => {
    const f = await pendingHost(t);
    mutate(f);
    await assert.rejects(f.controller.reconcile('host'));
    const state = await f.diskState();
    assert(state.stages.host.intent);
    assert(!state.stages.host.binding);
    await assert.rejects(f.controller.apply('host'), /durable intent/);
    assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
  });

test('host readback requires exact target PIP classification and no tags or malformed collections on other network resources, without corrective writes', async (t) => {
  const f = await pendingHost(t);
  const intent = (await f.diskState()).stages.host.intent;
  const invalid = [
    undefined,
    null,
    [],
    {},
    false,
    0,
    '',
    { length: 0 },
    [null],
    ['FirstPartyUsage:/Unprivileged'],
    ...['RoutingPreference', 'firstpartyusage', null, 1].map((ipTagType) => [
      { ...pipIpTags[0], ipTagType },
    ]),
    ...['/Privileged', '/unprivileged', null, 1].map((tag) => [
      { ...pipIpTags[0], tag },
    ]),
    [...pipIpTags, ...pipIpTags],
    [...pipIpTags, { ipTagType: 'RoutingPreference', tag: 'Internet' }],
    [{ ...pipIpTags[0], extra: 'unapproved' }],
  ];
  const start = f.calls.length;
  for (const ipTags of invalid) {
    const p = resource(f, 'pip').properties;
    if (ipTags === undefined) delete p.ipTags;
    else p.ipTags = structuredClone(ipTags);
    const observed = structuredClone(p);
    await assert.rejects(f.controller.reconcile('host'), /network/);
    const state = await f.diskState();
    assert.deepEqual(state.stages.host.intent, intent);
    assert(!state.stages.host.binding);
    assert.deepEqual(p, observed, 'never fill or rewrite provider fields');
  }
  resource(f, 'pip').properties.ipTags = structuredClone(pipIpTags);
  for (const kind of ['nic', 'vnet', 'nsg']) {
    const p = resource(f, kind).properties;
    for (const ipTags of [pipIpTags, {}, { length: 0 }, '', false, 0]) {
      p.ipTags = structuredClone(ipTags);
      await assert.rejects(f.controller.reconcile('host'), /network/);
      const state = await f.diskState();
      assert.deepEqual(state.stages.host.intent, intent);
      assert(!state.stages.host.binding);
    }
    delete p.ipTags;
  }
  await assert.rejects(f.controller.apply('host'), /durable intent/);
  assert(
    !f.calls
      .slice(start)
      .some((args) => ['validate', 'what-if', 'create'].includes(args[2])),
  );
  for (const [kind, ipTags] of [
    ['nic', null],
    ['vnet', []],
  ])
    resource(f, kind).properties.ipTags = ipTags;
  assert.equal((await f.controller.reconcile('host')).status, 'complete');
  assert.deepEqual(
    (await f.diskState()).stages.host.binding.network.resources.pip.ipTags,
    pipIpTags,
  );
  assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
});

test('completed PIP classification cannot drift or refresh its pins on reconcile or dependent role validation', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  await f.stage('host');
  const before = (await f.diskState()).stages.host;
  for (const ipTags of [
    undefined,
    null,
    [],
    [{ ...pipIpTags[0], tag: '/Privileged' }],
    [...pipIpTags, { ipTagType: 'RoutingPreference', tag: 'Internet' }],
    [{ ...pipIpTags[0], extra: 'unapproved' }],
  ]) {
    const p = resource(f, 'pip').properties;
    if (ipTags === undefined) delete p.ipTags;
    else p.ipTags = structuredClone(ipTags);
    await assert.rejects(f.controller.reconcile('host'), /network/);
    await assert.rejects(f.controller.validate('model-role'), /network/);
    assert.deepEqual((await f.diskState()).stages.host, before);
  }
  assert(!(await f.diskState()).stages['model-role']?.intent);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
});

test('missing optional VM disk mirrors and network GUIDs do not replace authoritative disk requirements', async (t) => {
  const f = await pendingHost(t);
  delete resource(f, 'vm').properties.storageProfile.osDisk.diskSizeGB;
  for (const key of ['nic', 'pip', 'nsg', 'vnet'])
    delete resource(f, key).properties.resourceGuid;
  assert.equal((await f.controller.reconcile('host')).status, 'complete');
  assert.equal((await f.diskState()).stages.host.binding.disks.os.sizeGiB, 32);
});

test('an already export-disabled fresh OS can be bound without a hardening write, but later export drift cannot be adopted', async (t) => {
  const f = await pendingHost(t),
    p = resource(f, 'os').properties;
  p.networkAccessPolicy = 'DenyAll';
  p.publicNetworkAccess = 'Disabled';
  assert.equal((await f.controller.reconcile('host')).status, 'complete');
  assert.equal(
    (await f.diskState()).stages.host.binding.disks.os.publicNetworkAccess,
    'Disabled',
  );
  p.networkAccessPolicy = 'AllowAll';
  p.publicNetworkAccess = 'Enabled';
  await assert.rejects(f.controller.reconcile('host'), /binding changed/);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
});

test('closed host inventory and declared output graph allow only the exact implicit OS disk', async (t) => {
  const f = await pendingHost(t),
    declared = stageIds(SCUS_PROFILE, 'host').map((id) => ({ id }));
  const outputs = f.deployments.get('host').properties;
  for (const invalid of [
    declared.slice(1),
    [...declared, { id: VM.ids.osDiskId }],
    [
      ...declared,
      { id: SCUS_PROFILE.compute.disks.os.id },
      { id: SCUS_PROFILE.compute.disks.os.id },
    ],
  ]) {
    outputs.outputResources = invalid;
    await assert.rejects(
      f.controller.reconcile('host'),
      /output-resource graph/,
    );
  }
  outputs.outputResources = declared;
  const foreign = `${SCUS_PROFILE.compute.vm.id}/extensions/foreign`;
  f.resources.set(foreign, {
    id: foreign,
    type: 'Microsoft.Compute/virtualMachines/extensions',
  });
  await assert.rejects(
    f.controller.reconcile('host'),
    /Unexpected or untracked/,
  );
  f.resources.delete(foreign);
  assert.equal((await f.controller.reconcile('host')).status, 'complete');
  assertStageOutputs(
    [...declared, { id: SCUS_PROFILE.compute.disks.os.id }],
    SCUS_PROFILE,
    'host',
  );
});

test('dedicated GET success cannot excuse an incomplete runtime inventory', async (t) => {
  const f = await pendingHost(t);
  for (const id of [
    SCUS_PROFILE.compute.disks.os.id,
    SCUS_PROFILE.compute.disks.audit.id,
    SCUS_PROFILE.sourcePreservation.snapshots.targetData.id,
  ]) {
    f.inventoryResponse = (items, group) =>
      group === SCUS_PROFILE.compute.resourceGroup
        ? items.filter((r) => r.id !== id)
        : items;
    await assert.rejects(
      f.controller.reconcile('host'),
      /runtime inventory is incomplete/,
    );
    assert(!(await f.diskState()).stages.host.binding);
  }
  f.inventoryResponse = undefined;
  assert.equal((await f.controller.reconcile('host')).status, 'complete');
});

test('untracked implicit OS or host resources cannot be adopted before host intent', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  for (const spec of [SCUS_PROFILE.compute.disks.os, SCUS_PROFILE.compute.vm]) {
    f.resources.set(spec.id, spec);
    await assert.rejects(f.controller.preflight('host'), /untracked/);
    f.resources.delete(spec.id);
  }
  assert(!(await f.diskState()).stages.host.intent);
});

test('image gate uses exact documented identity/features, not an invented minimum-size property', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  assert.equal(f.image.properties.osDiskImage.sizeInGb, undefined);
  const original = structuredClone(f.image);
  for (const mutate of [
    (x) => {
      x.id = x.id.replace('southcentralus', 'eastus2');
    },
    (x) => {
      x.name = 'latest';
    },
    (x) => {
      x.properties.architecture = 'Arm64';
    },
    (x) => {
      x.properties.osDiskImage.operatingSystem = 'Windows';
    },
    (x) => {
      x.properties.hyperVGeneration = 'V1';
    },
    (x) => {
      x.properties.features = [];
    },
    (x) => {
      x.properties.features[1].value = 'SCSI';
    },
  ]) {
    mutate(f.image);
    const start = f.calls.length;
    await assert.rejects(f.controller.preflight('host'));
    assert(
      !f.calls
        .slice(start)
        .some((args) => ['create', 'validate', 'what-if'].includes(args[2])),
    );
    f.image = structuredClone(original);
  }
  const result = await f.controller.validate('host');
  assert.equal(
    result.sizeEvidence,
    'Provider validation accepted pinned-image 32GiB request; image minimum not independently measured',
  );
  assert.equal(
    (await f.diskState()).stages.host.validation.request.image.minimumSize,
    'not-independently-measured',
  );
});

for (const stage of ['host', 'model-role'])
  for (const outcome of ['before', 'after'])
    test(`ambiguous B1 ${stage} ${outcome} provider acceptance retains intent and key, with GET-only reconciliation`, async (t) => {
      const f = await preserved(t);
      await f.prepareHost();
      if (stage === 'model-role') await f.stage('host');
      const keyPath = join(f.target, 'host-key', 'id_ed25519'),
        key = await readFile(keyPath);
      f.createFault = outcome;
      await assert.rejects(f.stage(stage));
      assert((await f.diskState()).stages[stage].intent);
      await f.close();
      await f.open();
      await f.prepareHost();
      await assert.rejects(f.controller.apply(stage), /durable intent/);
      assert.equal(
        (await f.controller.reconcile(stage)).status,
        outcome === 'after' ? 'complete' : 'pending',
      );
      assert((await readFile(keyPath)).equals(key));
      assert.equal(f.creates.filter((name) => name === stage).length, 1);
    });

test('model-role always uses the actual pinned MI, rejects drift/foreign scopes/definitions, and preserves old role', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  await f.stage('host');
  const originalRole = structuredClone(f.source.role),
    vm = resource(f, 'vm'),
    principal = vm.identity.principalId;
  vm.identity.principalId = '99999999-9999-9999-9999-999999999999';
  await assert.rejects(f.controller.validate('model-role'), /binding changed/);
  vm.identity.principalId = principal;
  f.roleNextLink = 'https://management.azure.com/unfollowed';
  await assert.rejects(f.controller.preflight('model-role'), /role inventory/);
  f.roleNextLink = undefined;
  await f.controller.validate('model-role');
  await f.review('model-role');
  const create = f.az.createWithIntent;
  f.az.createWithIntent = (args, callback) =>
    create(
      args.map((arg) =>
        arg === SCOPE.resourceGroup ? SCUS_PROFILE.compute.resourceGroup : arg,
      ),
      callback,
    );
  await assert.rejects(f.controller.apply('model-role'), /escaped/);
  assert(!(await f.diskState()).stages['model-role'].intent);
  f.az.createWithIntent = create;
  f.createFault = 'after';
  await assert.rejects(f.controller.apply('model-role'));
  const value = f.roles.get(SCUS_PROFILE.modelRole.id),
    good = structuredClone(value);
  for (const mutate of [
    (r) => {
      r.properties.scope = SCUS_PROFILE.compute.groupId;
    },
    (r) => {
      r.properties.principalId = f.source.vm.identity.principalId;
    },
    (r) => {
      r.properties.principalType = 'User';
    },
    (r) => {
      r.properties.roleDefinitionId =
        '/subscriptions/foreign/providers/Microsoft.Authorization/roleDefinitions/Owner';
    },
    (r) => {
      r.id = r.id.replace(
        SCOPE.resourceGroup,
        SCUS_PROFILE.compute.resourceGroup,
      );
    },
  ]) {
    mutate(value);
    await assert.rejects(f.controller.reconcile('model-role'), /Model role/);
    Object.assign(value, structuredClone(good));
  }
  assert.equal((await f.controller.reconcile('model-role')).status, 'complete');
  assert.deepEqual(f.source.role, originalRole);
});

test('model-role refuses an existing untracked assignment or an unresolved what-if principal', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  await f.stage('host');
  f.roles.set(SCUS_PROFILE.modelRole.id, {
    id: SCUS_PROFILE.modelRole.id,
    type: 'Microsoft.Authorization/roleAssignments',
  });
  await assert.rejects(f.controller.preflight('model-role'), /no adoption/);
  f.roles.clear();
  f.whatIfMutation = (value) => {
    value.changes[0].after.properties.principalId =
      '[reference(vm).identity.principalId]';
  };
  await assert.rejects(
    f.controller.validate('model-role'),
    /unresolved placeholders/,
  );
  assert(!(await f.diskState()).stages['model-role']?.intent);
});

const inheritedRole = (ancestor, name = randomUUID()) => ({
  id: `${ancestor}/providers/Microsoft.Authorization/roleAssignments/${name}`,
  type: 'Microsoft.Authorization/roleAssignments',
});

test('model-role accepts authenticated atScope inherited roles without changing its payload or granting ancestor capabilities', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  await f.stage('host');
  assert.equal(f.inheritedRoles.length, 44);
  const originalRole = structuredClone(f.source.role);
  const subscription = `/subscriptions/${SCOPE.subscriptionId}`;
  const sharedGroup = SCUS_PROFILE.stages['model-role'].groupId;
  f.inheritedRoles.push(inheritedRole(sharedGroup), inheritedRole(''));
  f.inheritedRoles[21] = inheritedRole(
    '/providers/Microsoft.Management/managementGroups/tenant.root-(fixture)',
  );
  f.inheritedRoles[0].id = f.inheritedRoles[0].id.toUpperCase();
  f.inheritedRoles[21].id = f.inheritedRoles[21].id.toUpperCase();
  f.inheritedRoles[21].type = f.inheritedRoles[21].type.toUpperCase();
  f.inheritedRoles.at(-2).id = f.inheritedRoles.at(-2).id.toUpperCase();
  f.inheritedRoles.at(-1).id = f.inheritedRoles.at(-1).id.toUpperCase();
  const ids = [f.source.role.id, ...f.inheritedRoles.map((r) => r.id)];
  assert.equal(ids.length, 47);
  f.whatIfMutation = (value) => {
    value.changes.push(
      ...ids.map((resourceId, index) => ({
        resourceId,
        changeType: index % 2 ? 'Ignore' : 'NoChange',
      })),
    );
  };
  const start = f.calls.length;
  assert.equal(
    (await f.controller.preflight('model-role')).status,
    'preflight-only',
  );
  assert.equal(
    (await f.controller.validate('model-role')).status,
    'review-required',
  );
  const validated = await f.diskState();
  const expectedProperties = {
    roleDefinitionId: SCUS_PROFILE.modelRole.roleDefinitionId,
    principalId: validated.stages.host.binding.vm.principalId,
    principalType: 'ServicePrincipal',
  };
  const proof = validated.stages['model-role'].validation;
  assert(
    ids.every((id) => proof.request.existingIds.includes(id.toLowerCase())),
  );
  assert.deepEqual(proof.request.parameters, {
    principalId: { value: expectedProperties.principalId },
  });
  assert.deepEqual(proof.request.expected, [
    {
      id: SCUS_PROFILE.modelRole.id,
      name: SCUS_PROFILE.modelRole.name,
      type: 'Microsoft.Authorization/roleAssignments',
      apiVersion: '2022-04-01',
      properties: expectedProperties,
    },
  ]);
  await f.review('model-role');
  assert.equal((await f.controller.apply('model-role')).status, 'complete');
  assert.deepEqual(f.roles.get(SCUS_PROFILE.modelRole.id).properties, {
    ...expectedProperties,
    scope: SCUS_PROFILE.modelRole.scope,
  });
  assert.deepEqual(f.source.role, originalRole);
  const roleReads = f.calls.slice(start).filter((args) => args[0] === 'rest');
  assert(
    roleReads.some((args) => args.includes(modelRoleListUrl(SCUS_PROFILE))),
  );
  assert(
    roleReads.every(
      (args) =>
        args.includes(modelRoleListUrl(SCUS_PROFILE)) ||
        args.includes('https://graph.microsoft.com/v1.0/me?$select=id'),
    ),
  );
  assert(
    f.calls
      .slice(start)
      .filter((args) => args[0] === 'deployment' && args[2] === 'create')
      .every(
        (args) =>
          args.includes(SCUS_PROFILE.stages['model-role'].deploymentName) &&
          args.includes(SCUS_PROFILE.sharedServices.resourceGroup),
      ),
  );
  const count = f.calls.length;
  for (const ancestor of [
    subscription,
    sharedGroup,
    '/providers/Microsoft.Management/managementGroups/mg-fixture-0',
    '',
  ]) {
    await assert.rejects(
      f.az.read([
        'rest',
        '--method',
        'get',
        '--url',
        `https://management.azure.com${ancestor}?api-version=2022-04-01`,
      ]),
    );
    await assert.rejects(
      f.az.write(['role', 'assignment', 'create', '--scope', ancestor]),
    );
  }
  assert.equal(f.calls.length, count);
  assert.deepEqual(f.creates, [
    'group',
    'capture',
    'copy',
    'host',
    'model-role',
  ]);
});

test('role inventory rejects nonancestors and malformed literal role-assignment IDs before provider validation or intent', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  await f.stage('host');
  const before = await f.diskState();
  const subscription = `/subscriptions/${SCOPE.subscriptionId}`;
  const sharedGroup = SCUS_PROFILE.stages['model-role'].groupId;
  const foundry = SCUS_PROFILE.modelRole.scope;
  const mg = '/providers/Microsoft.Management/managementGroups/mg-fixture';
  const role = inheritedRole(subscription).id;
  const invalid = [
    [
      'sibling RG',
      inheritedRole(`${subscription}/resourceGroups/rg-sibling`).id,
    ],
    [
      'target compute RG is not shared ancestor',
      inheritedRole(SCUS_PROFILE.compute.groupId).id,
    ],
    ['sibling account', inheritedRole(`${foundry}-sibling`).id],
    [
      'sibling resource',
      inheritedRole(
        `${sharedGroup}/providers/Microsoft.Compute/virtualMachines/other`,
      ).id,
    ],
    ['Foundry child', inheritedRole(`${foundry}/projects/opendots`).id],
    [
      'foreign subscription',
      inheritedRole('/subscriptions/99999999-9999-9999-9999-999999999999').id,
    ],
    [
      'foreign subscription RG',
      inheritedRole(
        sharedGroup.replace(
          SCOPE.subscriptionId,
          '99999999-9999-9999-9999-999999999999',
        ),
      ).id,
    ],
    ['management-group child', inheritedRole(`${mg}/children/child`).id],
    ['management-group extra segment', inheritedRole(`${mg}/child`).id],
    [
      'empty management-group segment',
      inheritedRole('/providers/Microsoft.Management/managementGroups/').id,
    ],
    [
      'management-group dot',
      inheritedRole('/providers/Microsoft.Management/managementGroups/.').id,
    ],
    [
      'management-group dot-dot',
      inheritedRole('/providers/Microsoft.Management/managementGroups/..').id,
    ],
    [
      'management-group dot path',
      inheritedRole(
        '/providers/Microsoft.Management/managementGroups/./mg-fixture',
      ).id,
    ],
    ['subscription dot path', inheritedRole(`${subscription}/./`).id],
    [
      'shared RG dot-dot path',
      inheritedRole(
        `${subscription}/resourceGroups/../${SCUS_PROFILE.sharedServices.resourceGroup}`,
      ).id,
    ],
    ['Foundry trailing dot', inheritedRole(`${foundry}/.`).id],
    ['Foundry child traversal', inheritedRole(`${foundry}/child/..`).id],
    ['encoded management-group separator', inheritedRole(`${mg}%2fchild`).id],
    [
      'encoded dot segment',
      inheritedRole('/providers/Microsoft.Management/managementGroups/%2e%2e')
        .id,
    ],
    ['double-encoded path', inheritedRole(`${mg}%252fchild`).id],
    [
      'encoded ordinary name character',
      inheritedRole('/providers/Microsoft.Management/managementGroups/%61').id,
    ],
    ['backslash path', inheritedRole(`${mg}\\child`).id],
    ['whitespace segment', inheritedRole(`${mg} `).id],
    ['control character', inheritedRole(`${mg}\u0000`).id],
    [
      'query in management-group segment',
      inheritedRole(`${mg}?scope=other`).id,
    ],
    ['fragment in management-group segment', inheritedRole(`${mg}#other`).id],
    [
      'missing UUID',
      `${subscription}/providers/Microsoft.Authorization/roleAssignments/`,
    ],
    ['short UUID', role.slice(0, -1)],
    ['malformed UUID', inheritedRole(subscription, 'not-a-uuid').id],
    [
      'encoded UUID',
      inheritedRole(subscription, '%61aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').id,
    ],
    ['extra suffix', `${role}/extra`],
    ['trailing slash', `${role}/`],
    ['trailing query', `${role}?api-version=2022-04-01`],
    ['trailing fragment', `${role}#fragment`],
    ['trailing newline', `${role}\n`],
    ['double leading separator', `/${role}`],
    ['relative ID', role.slice(1)],
    ['absolute URL', `https://management.azure.com${role}`],
    [
      'wrong assignment segment',
      role.replace('roleAssignments', 'policyAssignments'),
    ],
    ['non-string ID', 123],
    ['missing ID', undefined],
  ];
  for (const [name, id] of invalid) {
    f.inheritedRoles = [
      { id, type: 'Microsoft.Authorization/roleAssignments' },
    ];
    const start = f.calls.length;
    await assert.rejects(
      f.controller.preflight('model-role'),
      /role inventory/,
      name,
    );
    assert(
      !f.calls
        .slice(start)
        .some((args) => ['validate', 'what-if', 'create'].includes(args[2])),
      name,
    );
    assert.deepEqual(await f.diskState(), before, name);
  }
  assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
});

test('role inventory retains complete-array, error, type and case-insensitive duplicate gates', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  await f.stage('host');
  const before = await f.diskState();
  const valid = inheritedRole(
    '/providers/Microsoft.Management/managementGroups/mg-fixture',
  );
  for (const response of [
    undefined,
    null,
    {},
    { value: null },
    { value: {} },
    { value: [null] },
    { value: [{}] },
    {
      value: [{ ...valid, type: 'Microsoft.Authorization/policyAssignments' }],
    },
    { value: [{ ...valid, type: null }] },
    { value: [valid, { ...valid, id: valid.id.toUpperCase() }] },
    { value: [valid], nextLink: 'https://management.azure.com/unfollowed' },
    {
      value: [valid],
      error: { code: 'Forbidden', message: 'PRIVATE_ROLE_ERROR' },
    },
  ]) {
    f.roleInventoryResponse = () => response;
    const start = f.calls.length;
    await assert.rejects(
      f.controller.preflight('model-role'),
      /role inventory/,
    );
    assert(
      !f.calls
        .slice(start)
        .some((args) => ['validate', 'what-if', 'create'].includes(args[2])),
    );
    assert.deepEqual(await f.diskState(), before);
  }
  f.roleInventoryResponse = undefined;
  f.beforeCall = (args) => {
    if (args.includes(modelRoleListUrl(SCUS_PROFILE)))
      throw new Error('PRIVATE_ROLE_ERROR');
  };
  await assert.rejects(
    f.controller.preflight('model-role'),
    (error) =>
      /Azure CLI/.test(error.message) &&
      !error.message.includes('PRIVATE_ROLE_ERROR'),
  );
  assert.deepEqual(await f.diskState(), before);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
});

test('target role absence uses the exact full account-scoped ID, not an inherited assignment UUID', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  await f.stage('host');
  f.inheritedRoles.push(
    inheritedRole(
      '/providers/Microsoft.Management/managementGroups/mg-fixture',
      SCUS_PROFILE.modelRole.name,
    ),
  );
  assert.equal(
    (await f.controller.preflight('model-role')).status,
    'preflight-only',
  );
  const before = await f.diskState();
  const id = SCUS_PROFILE.modelRole.id.toUpperCase();
  f.roles.set(id, { id, type: 'MICROSOFT.AUTHORIZATION/ROLEASSIGNMENTS' });
  await assert.rejects(
    f.controller.validate('model-role'),
    /Fixed model role exists/,
  );
  assert.deepEqual(await f.diskState(), before);
  assert(!f.creates.includes('model-role'));
});

test('inherited what-if Create/Modify/Delete proposals never consume an Ignore/NoChange review or publish intent', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  await f.stage('host');
  f.inheritedRoles.push(
    inheritedRole(SCUS_PROFILE.stages['model-role'].groupId),
    inheritedRole(''),
  );
  const ids = [
    f.source.role.id,
    f.inheritedRoles[0].id,
    f.inheritedRoles[21].id,
    f.inheritedRoles.at(-2).id,
    f.inheritedRoles.at(-1).id,
  ];
  const noChanges = ids.map((resourceId, index) => ({
    resourceId,
    changeType: index % 2 ? 'Ignore' : 'NoChange',
  }));
  f.whatIfMutation = (value) => {
    value.changes.push(...structuredClone(noChanges));
  };
  await f.controller.validate('model-role');
  await f.review('model-role');
  const before = await f.diskState(),
    originalRole = structuredClone(f.source.role);
  for (const id of ids)
    for (const changeType of ['Create', 'Modify', 'Delete']) {
      f.whatIfMutation = (value) => {
        value.changes.push(
          ...noChanges.map((change) => ({
            ...change,
            ...(change.resourceId === id ? { changeType } : {}),
          })),
        );
      };
      await assert.rejects(
        f.controller.apply('model-role'),
        /What-if includes/,
      );
      assert.deepEqual(await f.diskState(), before);
      assert.deepEqual(f.source.role, originalRole);
      assert(!f.creates.includes('model-role'));
    }
});

test('bounded observations redact payloads and never qualify handlers, privacy, data or boot containment', async (t) => {
  const f = await preserved(t);
  await f.prepareHost();
  await f.stage('host');
  const before = await f.diskState();
  f.targetView = {
    statuses: [
      {
        code: 'PowerState/deallocated',
        level: 'Info',
        message: 'PRIVATE_SENTINEL',
      },
    ],
    bootDiagnostics: {
      serialConsoleLogBlobUri: 'https://PRIVATE_SENTINEL/?sig=PRIVATE_SENTINEL',
    },
    agent: {
      version: '3.0.0.0',
      protectedSettings: 'PRIVATE_SENTINEL',
      statuses: [],
      handlers: [
        {
          name: 'https://PRIVATE_SENTINEL',
          version: 'x\nPRIVATE_SENTINEL',
          code: '?sig=PRIVATE_SENTINEL',
          level: 'PRIVATE_SENTINEL',
        },
      ],
    },
  };
  const result = await f.controller.status();
  assert.equal(result.power, 'PowerState/deallocated');
  assert.equal(result.agent.version, '3.0.0.0');
  assert(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
  for (const key of [
    'managementQualified',
    'bootContainmentVerified',
    'dataAudited',
    'applicationActivated',
  ])
    assert.equal(result[key], false);
  assert.deepEqual(await f.diskState(), before);
  const call = f.calls.findLast((args) => args[0] === 'vm');
  assert.equal(call[5], HOST_OBSERVATION_QUERY);
  assert.equal(hostObservation({}, 'Succeeded').agent.handlers, null);
  assert.throws(
    () =>
      hostObservation({ agent: { handlers: Array(33).fill({}) } }, 'Succeeded'),
    /bounded/,
  );
});

test('historical Stage A requests stay observable under the extended profile without any hash/template/parameter rewrite', async (t) => {
  const f = await preserved(t),
    state = await f.diskState();
  const legacy = structuredClone(SCUS_PROFILE);
  delete legacy.compute.disks;
  delete legacy.compute.vm.type;
  delete legacy.compute.vm.admin;
  delete legacy.modelRole;
  for (const key of ['vnet', 'subnet', 'nsg', 'nic', 'pip', 'dnsLabel'])
    delete legacy.compute.network[key];
  delete legacy.stages.host;
  delete legacy.stages['model-role'];
  delete legacy.artifacts.hostKey;
  delete legacy.artifacts.hostPublicParameters;
  const legacyHash = hashObject(legacy);
  assert.notEqual(legacyHash, hashObject(SCUS_PROFILE));
  for (const stage of ['group', 'capture', 'copy']) {
    const intent = state.stages[stage].intent;
    intent.request.profileSha256 = legacyHash;
    intent.requestSha256 = hashObject(intent.request);
  }
  await f.store.save(state);
  const historical = structuredClone(state.stages);
  await f.prepareHost();
  await f.stage('host');
  await f.stage('model-role');
  for (const stage of ['group', 'capture', 'copy']) {
    await f.controller.reconcile(stage);
    assert.deepEqual((await f.diskState()).stages[stage], historical[stage]);
    await assert.rejects(f.controller.apply(stage), /durable intent/);
  }
});
