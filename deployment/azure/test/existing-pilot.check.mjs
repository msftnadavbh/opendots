import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCOPE, TAGS, VM, assertOwned } from '../scope.mjs';
import { assertOsDisk, inspectGroupBeforeDeployment } from '../cloud.mjs';
import { recordDeployment, verifyVm, diskPlan } from '../vm-state.mjs';
import {
  GOVERNANCE_NSG_ID,
  assertExistingEvidence,
  existingPilotSave,
  verifyExistingPilot,
} from '../existing-pilot.mjs';
import {
  INITIAL_IMAGE,
  initialActivationTarget,
  recoverInitialActivation,
  assertInitialActivationComplete,
  assertNormalActivation,
  inspectInitialGuest,
  inspectCaddy,
} from '../initial-activation.mjs';
import { managedTransport } from '../run-command.mjs';
import { existingFixture } from './existing-fixture.mjs';
import { managedFixture } from './managed-fixture.mjs';
import { output, parameters, image, vmResources } from './fixtures.mjs';

const other = '99999999-9999-9999-9999-999999999999';
const verify = (f) => verifyExistingPilot(f.az, output, parameters, f.state);
const strip = (s) => {
  const next = structuredClone(s);
  delete next.existingPilot;
  return next;
};

test('only explicit existing reconciliation accepts exact disk drift and post-change governed web profile; strict ARM guards still reject', async () => {
  const f = existingFixture(),
    before = structuredClone(f.state);
  await assert.rejects(verify(f), /evidence/);
  await assert.rejects(verifyVm(f.az, output, parameters, f.state, f.save));
  await assert.rejects(recordDeployment(f.az, parameters, f.state, f.save));
  await assert.rejects(inspectGroupBeforeDeployment(f.az, f.state));
  assert.throws(() => assertOwned(f.resources.disk, VM.ids.dataDiskId));
  assert.throws(() => assertOsDisk(f.resources.os, f.resources.vm));
  assert.equal(f.saved.length, 0);
  await f.reconcile();
  assert.equal(f.saved.length, 1);
  assert.deepEqual(strip(f.state), before);
  assert.equal(
    f.state.existingPilot.configuration.governanceNsg.management,
    'external',
  );
  assert.deepEqual(
    f.state.existingPilot.configuration.governanceNsg.tags,
    TAGS,
  );
  assert.equal(
    f.state.existingPilot.configuration.governanceNsg.resourceGuid,
    'ea14dfd0-7317-47a2-bd0d-0c3271f4d50d',
  );
  assert.equal(f.state.existingPilot.configuration.privateIpv4, '10.42.0.4');
  assert.equal(diskPlan(f.state).allowFormat, false);
  const reconciled = structuredClone(f.state);
  assert.equal((await verify(f)).power, 'PowerState/running');
  await f.reconcile();
  assert.equal(
    f.saved.length,
    1,
    'No implicit proof refresh or repeated state save',
  );
  assert.deepEqual(f.state, reconciled);
  await assert.rejects(verifyVm(f.az, output, parameters, f.state, f.save));
  await assert.rejects(recordDeployment(f.az, parameters, f.state, f.save));
});

const drift = {
  'VM replacement': (r) => {
    r.vm.properties.vmId = other;
  },
  'VM principal replacement': (r) => {
    r.vm.identity.principalId = other;
  },
  'VM tenant': (r) => {
    r.vm.identity.tenantId = other;
  },
  'user-assigned identity': (r) => {
    r.vm.identity.userAssignedIdentities = { foreign: {} };
  },
  'VM ownership': (r) => {
    r.vm.tags.managedBy = 'foreign';
  },
  'VM image': (r) => {
    r.vm.properties.storageProfile.imageReference.version = 'latest';
  },
  'secure boot': (r) => {
    r.vm.properties.securityProfile.uefiSettings.secureBootEnabled = false;
  },
  'guest agent configuration': (r) => {
    r.vm.properties.osProfile.linuxConfiguration.provisionVMAgent = false;
  },
  'password SSH': (r) => {
    r.vm.properties.osProfile.linuxConfiguration.disablePasswordAuthentication = false;
  },
  'SSH public key': (r) => {
    r.vm.properties.osProfile.linuxConfiguration.ssh.publicKeys[0].keyData +=
      'x';
  },
  'OS identity': (r) => {
    r.os.properties.uniqueId = other;
  },
  'OS SKU': (r) => {
    r.os.sku.name = 'Premium_LRS';
  },
  'VM OS SKU': (r) => {
    r.vm.properties.storageProfile.osDisk.managedDisk.storageAccountType =
      'Premium_LRS';
  },
  'OS attachment': (r) => {
    r.os.managedBy += '-foreign';
  },
  'OS retention': (r) => {
    r.vm.properties.storageProfile.osDisk.deleteOption = 'Delete';
  },
  'OS ownership': (r) => {
    r.os.tags = { ...TAGS, managedBy: 'foreign' };
  },
  'data identity': (r) => {
    r.disk.properties.uniqueId = other;
  },
  'third data SKU': (r) => {
    r.disk.sku.name = 'Premium_LRS';
  },
  'original data SKU is not drift profile': (r) => {
    r.disk.sku.name = 'StandardSSD_LRS';
  },
  'VM data SKU': (r) => {
    r.vm.properties.storageProfile.dataDisks[0].managedDisk.storageAccountType =
      'Premium_LRS';
  },
  'data size': (r) => {
    r.disk.properties.diskSizeGB = 64;
  },
  'data export': (r) => {
    r.disk.properties.networkAccessPolicy = 'AllowAll';
  },
  'data public access': (r) => {
    r.disk.properties.publicNetworkAccess = 'Enabled';
  },
  'data attachment': (r) => {
    r.disk.managedBy += '-foreign';
  },
  'data retention': (r) => {
    r.vm.properties.storageProfile.dataDisks[0].deleteOption = 'Delete';
  },
  'data LUN': (r) => {
    r.vm.properties.storageProfile.dataDisks[0].lun = 1;
  },
  'data controller': (r) => {
    r.vm.properties.storageProfile.diskControllerType = 'SCSI';
  },
  'data create option': (r) => {
    r.disk.properties.creationData.createOption = 'Copy';
  },
  'data creation provenance': (r) => {
    r.disk.properties.timeCreated = '2025-01-01T00:00:00Z';
  },
  'partial data tags': (r) => {
    r.disk.tags = { application: 'opendots' };
  },
  'arbitrary nonownership data tags': (r) => {
    r.disk.tags = { ignored: 'not-authorized' };
  },
  'restored data ownership is not drift profile': (r) => {
    r.disk.tags = { ...TAGS };
  },
  'conflicting data tags': (r) => {
    r.disk.tags = { ...TAGS, managedBy: 'foreign' };
  },
  'PIP identity': (r) => {
    r.nic.properties.ipConfigurations[0].properties.publicIPAddress.id +=
      '-foreign';
  },
  FQDN: (r) => {
    r.pip.properties.dnsSettings.fqdn = output.vm.fqdn.replace(
      '.abcdef.',
      '.foreign.',
    );
  },
  'public IPv4': (r) => {
    r.pip.properties.ipAddress = '20.30.40.51';
  },
  'private IPv4': (r) => {
    r.nic.properties.ipConfigurations[0].properties.privateIPAddress =
      '10.42.0.5';
  },
  'static private IPv4': (r) => {
    r.nic.properties.ipConfigurations[0].properties.privateIPAllocationMethod =
      'Static';
  },
  'nonprimary NIC IP': (r) => {
    r.nic.properties.ipConfigurations[0].properties.primary = false;
  },
  'NIC VM attachment': (r) => {
    r.nic.properties.virtualMachine.id += '-foreign';
  },
  'NIC NSG': (r) => {
    r.nic.properties.networkSecurityGroup.id = GOVERNANCE_NSG_ID;
  },
  'NIC extra port': (r) => {
    r.nsg.properties.securityRules[0].properties.destinationPortRanges.push(
      '22',
    );
  },
  'NIC broader allow': (r) => {
    r.nsg.properties.securityRules[1].properties.access = 'Allow';
  },
  'foreign subnet NSG': (r) => {
    r.vnet.properties.subnets[0].properties.networkSecurityGroup.id +=
      '-foreign';
  },
  'removed subnet NSG': (r) => {
    delete r.vnet.properties.subnets[0].properties.networkSecurityGroup;
  },
  'route table': (r) => {
    r.vnet.properties.subnets[0].properties.routeTable = { id: 'foreign' };
  },
  'extra subnet': (r) => {
    r.vnet.properties.subnets.push(
      structuredClone(r.vnet.properties.subnets[0]),
    );
  },
  'missing governance tags': (r) => {
    delete r.governance.tags;
  },
  'partial governance tags': (r) => {
    delete r.governance.tags.managedBy;
  },
  'extra governance tags': (r) => {
    r.governance.tags.extra = 'not-approved';
  },
  'conflicting governance tags': (r) => {
    r.governance.tags.managedBy = 'foreign';
  },
  'missing governance GUID': (r) => {
    delete r.governance.properties.resourceGuid;
  },
  'same-ID governance substitution': (r) => {
    r.governance = structuredClone(r.governance);
    r.governance.properties.resourceGuid = other;
  },
  'foreign copied-tag NSG': (r) => {
    r.foreign = {
      ...structuredClone(r.governance),
      id: GOVERNANCE_NSG_ID + '-foreign',
    };
  },
  'governance NIC attachment': (r) => {
    r.governance.properties.networkInterfaces.push({ id: VM.ids.nicId });
  },
  'governance extra subnet attachment': (r) => {
    r.governance.properties.subnets.push({ id: VM.ids.subnetId + '-foreign' });
  },
  'governance foreign attachment': (r) => {
    r.governance.properties.subnets[0].id += '-foreign';
  },
  'governance prechange/reversal': (r) => {
    r.governance.properties.securityRules = [];
  },
  'governance extra rule': (r) => {
    r.governance.properties.securityRules.push(
      structuredClone(r.governance.properties.securityRules[0]),
    );
  },
  'governance missing defaults': (r) => {
    delete r.governance.properties.defaultSecurityRules;
  },
  'governance changed default deny': (r) => {
    r.governance.properties.defaultSecurityRules[2].properties.access = 'Allow';
  },
  'Foundry local auth': (r) => {
    r.foundry.properties.disableLocalAuth = false;
  },
  'Foundry principal': (r) => {
    r.foundry.identity.principalId = other;
  },
  'project principal': (r) => {
    r.project.identity.principalId = other;
  },
  'model deployment': (r) => {
    r.model.properties.model.name = 'foreign';
  },
  'model role principal': (r) => {
    r.role.properties.principalId = other;
  },
  'model role scope': (r) => {
    r.role.properties.scope = VM.ids.id;
  },
  'registry admin': (r) => {
    r.registry.properties.adminUserEnabled = true;
  },
  'unexpected inventory': (r) => {
    r.foreign = {
      id: VM.ids.id + '-foreign',
      tags: TAGS,
      location: SCOPE.location,
    };
  },
};
for (const [field, value] of Object.entries({
  priority: 101,
  direction: 'Outbound',
  access: 'Deny',
  protocol: '*',
  sourceAddressPrefix: '*',
  sourcePortRange: '443',
  destinationAddressPrefix: '10.42.0.0/24',
  destinationPortRanges: ['80', '443', '22'],
  destinationPortRange: '*',
  sourceAddressPrefixes: ['Internet'],
  destinationAddressPrefixes: ['10.42.0.4/32'],
  sourceApplicationSecurityGroups: [{ id: 'foreign' }],
  destinationApplicationSecurityGroups: [{ id: 'foreign' }],
}))
  drift[`governance web ${field}`] = (r) => {
    r.governance.properties.securityRules[0].properties[field] = value;
  };

for (const [name, mutate] of Object.entries(drift))
  test(`existing-pilot rejects ${name} before any state/resource write`, async () => {
    const f = existingFixture();
    await f.reconcile();
    const before = structuredClone(f.state);
    mutate(f.resources);
    await assert.rejects(verify(f));
    assert.deepEqual(f.state, before);
    assert.equal(f.saved.length, 1);
    const first = existingFixture();
    mutate(first.resources);
    await assert.rejects(first.reconcile());
    assert.equal(first.saved.length, 0);
  });

test('copied governance tags are order-independent metadata; only the dedicated GET must contain the fixed GUID', async () => {
  const f = existingFixture();
  f.resources.governance.tags = Object.fromEntries(
    Object.entries(TAGS).reverse(),
  );
  f.inventory = Object.values(f.resources)
    .filter((item) => item !== f.resources.role)
    .map((item) => structuredClone(item));
  delete f.inventory.find((item) => item.id === GOVERNANCE_NSG_ID).properties;
  await f.reconcile();
  await verify(f);
  assert.equal(f.saved.length, 1);
  assert.equal(
    f.state.existingPilot.configuration.governanceNsg.management,
    'external',
  );
  const before = structuredClone(f.state);
  f.resources.governance.properties.resourceGuid = other;
  await assert.rejects(verify(f), /Governance NSG/);
  assert.deepEqual(f.state, before);
  assert.equal(f.saved.length, 1);
});

for (const tags of [
  undefined,
  null,
  {},
  { application: 'opendots' },
  { ...TAGS, extra: 'not-approved' },
  { ...TAGS, environment: 'foreign' },
])
  test(`governance inventory rejects tag drift independently of a valid dedicated GET: ${JSON.stringify(tags)}`, async () => {
    const f = existingFixture();
    f.inventory = Object.values(f.resources)
      .filter((item) => item !== f.resources.role)
      .map((item) => structuredClone(item));
    f.inventory.find((item) => item.id === GOVERNANCE_NSG_ID).tags = tags;
    const before = structuredClone(f.state);
    await assert.rejects(f.reconcile(), /exact copied tag dictionary/);
    assert.deepEqual(f.state, before);
    assert.equal(f.saved.length, 0);
  });

test('copied tags cannot make the added governance NSG owned inventory for strict deployment', async () => {
  const f = existingFixture();
  await assert.rejects(recordDeployment(f.az, parameters, f.state, f.save));
  Object.assign(f.resources, vmResources());
  let recorded = false;
  await assert.rejects(async () => {
    await inspectGroupBeforeDeployment(f.az, f.state);
    recorded = true;
    await recordDeployment(f.az, parameters, f.state, f.save);
  }, /Unexpected resource/);
  assert.equal(recorded, false);
  assert.equal(f.saved.length, 0);
});

for (const change of ['old-shape', 'tags', 'guid'])
  test(`old or altered governance evidence (${change}) cannot be refreshed or migrate itself`, async () => {
    const f = existingFixture();
    await f.reconcile();
    const profile = f.state.existingPilot.configuration.governanceNsg;
    if (change === 'old-shape') {
      delete profile.tags;
      delete profile.resourceGuid;
    } else if (change === 'tags') profile.tags.application = 'foreign';
    else profile.resourceGuid = other;
    const before = structuredClone(f.state);
    f.calls.length = 0;
    await assert.rejects(verify(f), /evidence/);
    await assert.rejects(f.reconcile(), /evidence/);
    assert.throws(() => existingPilotSave(f.state, f.save), /evidence/);
    assert.deepEqual(f.state, before);
    assert.deepEqual(f.calls, []);
    assert.equal(f.saved.length, 1);
  });

test('exact single-host destination has only its two canonical forms, never broad CIDRs or implicit retargeting', async () => {
  const f = existingFixture();
  f.resources.governance.properties.securityRules[0].properties.destinationAddressPrefix =
    '10.42.0.4';
  await f.reconcile();
  assert.equal(
    f.state.existingPilot.configuration.governanceNsg.rule
      .destinationAddressPrefix,
    '10.42.0.4/32',
  );
  for (const destination of [
    '10.42.0.04',
    '10.42.0.4/032',
    '10.42.0.4/31',
    '10.42.0.5/32',
    '*',
  ]) {
    f.resources.governance.properties.securityRules[0].properties.destinationAddressPrefix =
      destination;
    await assert.rejects(verify(f));
  }
});

for (const field of [
  'binding',
  'pins',
  'fsUuid',
  'seenVmUniqueId',
  'seenResourceIds',
  'modelRoleAssignmentId',
  'foundryPrincipalId',
  'projectPrincipalId',
])
  test(`missing original ${field} is never learned/adopted by reconciliation`, async () => {
    const f = existingFixture();
    delete f.state[field];
    await assert.rejects(f.reconcile());
    assert.equal(f.saved.length, 0);
  });

test('missing/duplicated inventory, changed parameters/outputs and authority failures are not absence', async () => {
  for (const name of [
    'vm',
    'disk',
    'os',
    'nic',
    'pip',
    'nsg',
    'vnet',
    'governance',
  ]) {
    const f = existingFixture();
    f.inventory = Object.values(f.resources).filter(
      (r) => r !== f.resources[name] && r !== f.resources.role,
    );
    await assert.rejects(f.reconcile(), /inventory/);
    assert.equal(f.saved.length, 0);
  }
  const duplicate = existingFixture();
  duplicate.inventory = [
    ...Object.values(duplicate.resources),
    duplicate.resources.vm,
  ];
  await assert.rejects(duplicate.reconcile(), /inventory/);
  const f = existingFixture();
  await f.reconcile();
  await assert.rejects(
    verifyExistingPilot(
      f.az,
      output,
      { ...parameters, operatorIpv4Cidr: '8.8.4.4/32' },
      f.state,
    ),
    /parameters changed/,
  );
  await assert.rejects(
    verifyExistingPilot(
      f.az,
      { ...output, foundryPrincipalId: other },
      parameters,
      f.state,
    ),
    /evidence/,
  );
  f.az.verify = async () => {
    throw new Error('fixture deployment principal mismatch');
  };
  await assert.rejects(verify(f), /principal/);
});

test('conflicting OS inventory tags and malformed default port fields are not tolerated by the existing lane', async () => {
  const f = existingFixture();
  f.inventory = Object.values(f.resources)
    .filter((item) => item !== f.resources.role)
    .map((item) => structuredClone(item));
  f.inventory.find((item) => item.id === VM.ids.osDiskId).tags = {
    ...TAGS,
    managedBy: 'foreign',
  };
  await assert.rejects(f.reconcile(), /ownership/);
  assert.equal(f.saved.length, 0);
  const g = existingFixture();
  g.resources.governance.properties.defaultSecurityRules[0].properties.destinationPortRanges = false;
  await assert.rejects(g.reconcile(), /ambiguous/);
  assert.equal(g.saved.length, 0);
});

test('reconciliation cannot replace pending/recovery/activation facts or accept another initial image', async () => {
  for (const patch of [
    { management: { pending: { operationId: other } } },
    { pullOperationId: other },
    { initialActivationRecovery: { status: 'prepared' } },
    { initialActivationRecovery: { conflict: {} } },
    { provisioned: true },
    { configured: true },
    { image },
  ]) {
    const f = existingFixture();
    Object.assign(f.state, patch);
    const before = structuredClone(f.state);
    await assert.rejects(f.reconcile());
    assert.deepEqual(f.state, before);
    assert.equal(f.saved.length, 0);
  }
});

async function transportFixture() {
  const f = existingFixture();
  await f.reconcile();
  const m = managedFixture({
    state: f.state,
    afterPut: async (m) => {
      f.resources.command = m.resource;
      if (m.handler) f.resources.handler = m.handler;
    },
  });
  f.state = m.state;
  const save = existingPilotSave(m.state, f.save);
  m.guest = managedTransport({
    az: m.az,
    state: m.state,
    save,
    client: m.client,
  });
  return { f, m, save };
}

test('real management receipts atomically evolve current proof, never the original anchor or immutable pins', async () => {
  const { f, m } = await transportFixture();
  const before = structuredClone(f.state),
    anchor = before.existingPilot.initialStateSha256;
  await m.guest.canary();
  await m.guest.recordPrivacyValidation(m.proof());
  assertExistingEvidence(f.state, output);
  assert.notEqual(
    f.state.existingPilot.stateSha256,
    before.existingPilot.stateSha256,
  );
  assert.equal(f.state.existingPilot.initialStateSha256, anchor);
  assert.deepEqual(f.state.binding, before.binding);
  assert.deepEqual(f.state.pins, before.pins);
  await verify(f);
  m.putFailure = 'after';
  await assert.rejects(m.guest.run('true'));
  f.resources.command = m.resource;
  assertExistingEvidence(f.state, output);
  m.vm.properties.instanceView.vmAgent.statuses = [];
  await m.guest.reconcile();
  assertExistingEvidence(f.state, output);
  await verify(f);
  assert.equal(f.state.existingPilot.initialStateSha256, anchor);
  for (const saved of f.saved) assertExistingEvidence(saved, output);
});

test('stale proof, changed immutable bindings and uncertain private saves cannot refresh themselves', async () => {
  const f = existingFixture();
  await f.reconcile();
  f.state.management = { pending: { operationId: other } };
  await assert.rejects(verify(f), /stale/);
  await assert.rejects(f.reconcile(), /stale/);
  const g = existingFixture();
  await g.reconcile();
  const save = existingPilotSave(g.state, g.save);
  await assert.rejects(save({ ...g.state, fsUuid: other }), /immutable/);
  const fail = existingPilotSave(g.state, async () => {
    throw new Error('fixture fsync fault');
  });
  await assert.rejects(fail(g.state), /fsync/);
  await assert.rejects(fail(g.state), /uncertain/);
  for (const evidence of [null, false, {}, { version: 1 }]) {
    const invalid = existingFixture();
    invalid.state.existingPilot = evidence;
    await assert.rejects(invalid.reconcile(), /evidence/);
    assert.equal(invalid.saved.length, 0);
  }
});

test('initial evidence needs running/Succeeded, while recorded continuity remains readable for stopped/unhealthy reconciliation', async () => {
  for (const field of ['power', 'provisioningState']) {
    const f = existingFixture();
    if (field === 'power') f.power = 'PowerState/deallocated';
    else f.resources.vm.properties.provisioningState = 'Failed';
    await assert.rejects(f.reconcile(), /running and successfully provisioned/);
    assert.equal(f.saved.length, 0);
  }
  const f = existingFixture();
  await f.reconcile();
  f.power = 'PowerState/deallocated';
  f.resources.vm.properties.provisioningState = 'Failed';
  const verified = await verify(f);
  assert.equal(verified.power, f.power);
  assert.equal(verified.provisioningState, 'Failed');
  assert.equal(f.saved.length, 1);
});

test('internal initial recovery freshly verifies the reviewed topology and still uses frozen protected recovery', async () => {
  const { f, m, save } = await transportFixture();
  await m.guest.canary();
  await m.guest.recordPrivacyValidation(m.proof());
  const { oldUnit, newUnit, ...review } = initialActivationTarget(image);
  f.calls.length = 0;
  await recoverInitialActivation({
    az: f.az,
    ssh: m.guest,
    output,
    parameters,
    state: f.state,
    save,
    approval: { ...review, reviewSha256: 'e'.repeat(64) },
  });
  assert.equal(f.state.image, image);
  assertInitialActivationComplete(f.state);
  assertNormalActivation(f.state, output);
  for (const mutate of [
    (s) => {
      s.initialActivationRecovery.receipt.operationId = other;
    },
    (s) => {
      s.initialActivationRecovery.fsUuid = other;
    },
    (s) => {
      s.initialActivationRecovery.binding.vmUniqueId = other;
    },
    (s) => {
      s.initialActivationRecovery.oldUnitSha256 = 'f'.repeat(64);
    },
    (s) => {
      s.initialActivationRecovery.conflict = {};
    },
    (s) => {
      s.image = INITIAL_IMAGE;
    },
  ]) {
    const changed = structuredClone(f.state);
    mutate(changed);
    assert.throws(() => assertInitialActivationComplete(changed));
  }
  assertExistingEvidence(f.state, output);
  assert(
    f.calls.some(
      (args) => Array.isArray(args) && args.includes(GOVERNANCE_NSG_ID),
    ),
    'Internal fresh verifier must read governance topology',
  );
  assert.equal(m.state.management.receipt.schema, 'recovery');
  const body = m.requests.at(-1);
  const plan = JSON.parse(
    Buffer.from(body.properties.protectedParameters[0].value, 'base64'),
  );
  assert.equal(plan.oldUnit, oldUnit);
  assert.equal(plan.newUnit, newUnit);
  assert(
    !body.properties.source.script.includes(
      body.properties.protectedParameters[0].value,
    ),
  );
});

for (const kind of [
  'stale',
  'pending',
  'conflict',
  'activation',
  'network',
  'stopped',
  'provisioning',
])
  test(`existing internal initial recovery rejects ${kind} without a new guest submission or image advance`, async () => {
    const { f, m, save } = await transportFixture();
    await m.guest.canary();
    await m.guest.recordPrivacyValidation(m.proof());
    if (kind === 'stale') f.state.hostKey += 'x';
    if (kind === 'pending') {
      f.state.management.pending = { operationId: other };
      await save(f.state);
    }
    if (kind === 'conflict') {
      f.state.initialActivationRecovery = { conflict: {} };
      await save(f.state);
    }
    if (kind === 'activation') {
      f.state.provisioned = true;
      await save(f.state);
    }
    if (kind === 'network')
      f.resources.governance.properties.securityRules = [];
    if (kind === 'stopped') f.power = 'PowerState/deallocated';
    if (kind === 'provisioning')
      f.resources.vm.properties.provisioningState = 'Failed';
    const count = m.requests.length;
    const {
      oldUnit: _old,
      newUnit: _new,
      ...review
    } = initialActivationTarget(image);
    await assert.rejects(
      recoverInitialActivation({
        az: f.az,
        ssh: m.guest,
        output,
        parameters,
        state: f.state,
        save,
        approval: { ...review, reviewSha256: 'e'.repeat(64) },
      }),
    );
    assert.equal(m.requests.length, count);
    assert.equal(f.state.image, INITIAL_IMAGE);
  });

test('fixed nonsecret diagnostics fit the unchanged empty-result envelope, never require protected input or emit private contents', async () => {
  const { f, m } = await transportFixture();
  await inspectInitialGuest({ ssh: m.guest, state: f.state });
  await inspectCaddy({ ssh: m.guest, state: f.state });
  assert.equal(m.requests.length, 2);
  for (const body of m.requests) {
    assert.equal(body.properties.protectedParameters.length, 0);
    assert(Buffer.byteLength(body.properties.source.script) <= 65536);
  }
  assert.equal(f.state.management.receipt.schema, 'empty');
  assert.equal(f.state.management.receipt.result, '');
});

test('CLI keeps ARM strict, requires evidence before build/guest use and initial completion before power/provision/configuration', async () => {
  const source = await readFile(
    new URL('../pilot.mjs', import.meta.url),
    'utf8',
  );
  const arm = source.slice(
    source.indexOf("if (['validate', 'what-if', 'deploy']"),
    source.indexOf("command === 'provision' ? resolve"),
  );
  assert(
    arm.includes('inspectGroupBeforeDeployment') &&
      arm.includes('recordDeployment') &&
      arm.includes('verifyVm'),
  );
  assert(
    !arm.includes('verifyExistingPilot') &&
      !arm.includes('reconcileExistingPilot'),
  );
  assert(
    source.indexOf('existing = await verifyExistingPilot') <
      source.indexOf("if (command === 'build')"),
  );
  const build = source.slice(
    source.indexOf("if (command === 'build')"),
    source.indexOf('validateVmState(saved, publicParameters)'),
  );
  assert(build.indexOf('!existing.state.management?.pending') >= 0);
  assert(
    build.indexOf('!existing.state.management?.pending') <
      build.indexOf('await az.write'),
  );
  assert.match(
    source,
    /command === 'management-reconcile' \|\|\s*verified.power === 'PowerState\/running'/,
  );
  assert.match(
    source,
    /requirePilot\(\s*!existing,\s*'Existing-pilot reconciliation grants no automatic power start/,
  );
  assert.throws(
    () => assertInitialActivationComplete(existingFixture().state),
    /one-off initial recovery/,
  );
});
