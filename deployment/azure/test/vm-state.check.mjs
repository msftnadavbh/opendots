import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VM, SCOPE, TAGS } from '../scope.mjs';
import { recordDeployment, verifyVm, diskPlan } from '../vm-state.mjs';
import { parameters, output, state, vmResources, vmAz } from './fixtures.mjs';

const now = Date.parse('2026-10-20T12:05:00Z');
const otherId = '99999999-9999-9999-9999-999999999999';
function pending() {
  const next = structuredClone(state);
  for (const key of [
    'binding',
    'seenVmUniqueId',
    'fsUuid',
    'image',
    'hostKey',
    'provisioned',
  ])
    delete next[key];
  delete next.creation.uniqueId;
  return next;
}
function fixture(t, resources = vmResources()) {
  t.mock.method(Date, 'now', () => now);
  const az = vmAz(resources),
    saves = [];
  az.write = async () =>
    assert.fail('State validation must never write Azure resources');
  return {
    az,
    saves,
    save: async (value) => saves.push(structuredClone(value)),
  };
}

test('fresh absence is saved once, read-only, without a disk format permission', async (t) => {
  const f = fixture(t, {});
  const recorded = await recordDeployment(f.az, parameters, undefined, f.save);
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.saves[0], recorded);
  assert.deepEqual(recorded.seenResourceIds, []);
  assert.equal(recorded.creation.diskId, VM.ids.dataDiskId);
  assert(Number.isFinite(Date.parse(recorded.creation.absentAt)));
  assert.equal(recorded.creation.uniqueId, undefined);
  assert.throws(() => diskPlan(recorded), /No bound new-disk/);
  assert.equal(f.az.calls.length, 1);
});

for (const name of ['vm', 'disk', 'os', 'nic', 'pip', 'nsg', 'vnet'])
  test(`pre-existing ${name} cannot be adopted without state or obtain a format permit`, async (t) => {
    const f = fixture(t, { [name]: vmResources()[name] });
    await assert.rejects(
      recordDeployment(f.az, parameters, undefined, f.save),
      /refusing adoption/,
    );
    assert.deepEqual(f.saves, []);
    assert.equal(f.az.calls.length, 1);
  });

test('a valid partial graph retries, pins each observed identity, and binds only after full verification', async (t) => {
  const resources = vmResources();
  const partial = {
    disk: resources.disk,
    nic: resources.nic,
    pip: resources.pip,
    nsg: resources.nsg,
    vnet: resources.vnet,
  };
  const f = fixture(t, partial);
  const first = await recordDeployment(f.az, parameters, pending(), f.save);
  assert.equal(first.creation.uniqueId, output.vm.dataDiskUniqueId);
  assert.equal(first.pins.ipv4, output.vm.ipv4);
  assert.equal(first.binding, undefined);
  assert.equal(first.seenResourceIds.length, 5);
  assert.throws(() => diskPlan(first), /No bound new-disk/);
  const second = await recordDeployment(
    vmAz(resources),
    parameters,
    first,
    f.save,
  );
  assert.equal(second.pins.principalId, output.vm.principalId);
  assert.equal(second.pins.osDiskUniqueId, state.binding.osDiskUniqueId);
  assert.equal(second.seenResourceIds.length, 7);
  assert.throws(() => diskPlan(second), /No bound new-disk/);
  const verified = await verifyVm(
    fixture(t).az,
    output,
    parameters,
    second,
    f.save,
  );
  assert.equal(verified.power, 'PowerState/running');
  assert.deepEqual(verified.state.binding, state.binding);
  assert.equal(
    verified.state.modelRoleAssignmentId,
    output.modelRoleAssignmentId,
  );
  assert.equal(diskPlan(verified.state).allowFormat, true);
  assert.equal(diskPlan(state).allowFormat, false);
});

for (const name of ['vm', 'disk', 'os', 'nic', 'pip', 'nsg', 'vnet'])
  test(`previously seen ${name} cannot be silently recreated, before or after binding`, async (t) => {
    const all = vmResources();
    const f = fixture(t);
    const seen = await recordDeployment(f.az, parameters, pending(), f.save);
    delete all[name];
    for (const saved of [seen, state]) {
      const missing = fixture(t, all);
      await assert.rejects(
        recordDeployment(missing.az, parameters, saved, missing.save),
        /missing; refusing recreation/,
      );
      assert.deepEqual(missing.saves, []);
    }
  });

const drift = {
  principal: (r) => {
    r.vm.identity.principalId = otherId;
  },
  'VM unique ID': (r) => {
    r.vm.properties.vmId = otherId;
  },
  'data disk unique ID': (r) => {
    r.disk.properties.uniqueId = otherId;
  },
  'OS disk unique ID': (r) => {
    r.os.properties.uniqueId = otherId;
  },
  'NIC wiring': (r) => {
    r.nic.properties.ipConfigurations[0].properties.publicIPAddress.id +=
      '-foreign';
  },
  'public IP': (r) => {
    r.pip.properties.ipAddress = '20.30.40.51';
  },
  FQDN: (r) => {
    r.pip.properties.dnsSettings.fqdn = output.vm.fqdn.replace(
      '.abcdef.',
      '.changed.',
    );
  },
  'deny source': (r) => {
    r.nsg.properties.securityRules[1].properties.sourceAddressPrefix =
      '0.0.0.0/0';
  },
  'restored SSH rule': (r) => {
    r.nsg.properties.securityRules.push({
      name: 'operator-ssh',
      properties: {
        priority: 110,
        direction: 'Inbound',
        access: 'Allow',
        protocol: 'Tcp',
        sourceAddressPrefix: parameters.operatorIpv4Cidr,
        sourcePortRange: '*',
        destinationAddressPrefix: '*',
        destinationPortRange: '22',
      },
    });
  },
  'alternate management port': (r) => {
    r.nsg.properties.securityRules[0].properties.destinationPortRanges.push(
      '2222',
    );
  },
  'allow other inbound': (r) => {
    r.nsg.properties.securityRules[1].properties.access = 'Allow';
  },
  'ambiguous destination ports': (r) => {
    r.nsg.properties.securityRules[0].properties.destinationPortRange = '22';
  },
  'source ASG': (r) => {
    r.nsg.properties.securityRules[0].properties.sourceApplicationSecurityGroups =
      [{ id: 'foreign' }];
  },
  'extra port': (r) => {
    r.nsg.properties.securityRules[0].properties.destinationPortRanges.push(
      '8080',
    );
  },
  route: (r) => {
    r.vnet.properties.subnets[0].properties.routeTable = { id: 'foreign' };
  },
  tenant: (r) => {
    r.vm.identity.tenantId = otherId;
  },
  key: (r) => {
    r.vm.properties.osProfile.linuxConfiguration.ssh.publicKeys[0].keyData +=
      'X';
  },
  image: (r) => {
    r.vm.properties.storageProfile.imageReference.sku = 'other';
  },
  'data retention': (r) => {
    r.vm.properties.storageProfile.dataDisks[0].deleteOption = 'Delete';
  },
  'OS retention': (r) => {
    r.vm.properties.storageProfile.osDisk.deleteOption = 'Delete';
  },
};
for (const [name, mutate] of Object.entries(drift))
  test(`${name} drift fails before save/write, never repaired by an ARM retry`, async (t) => {
    const initial = fixture(t);
    const pinned = await recordDeployment(
      initial.az,
      parameters,
      pending(),
      initial.save,
    );
    for (const saved of [pinned, state]) {
      const snapshot = structuredClone(saved);
      const resources = vmResources();
      mutate(resources);
      const f = fixture(t, resources);
      await assert.rejects(recordDeployment(f.az, parameters, saved, f.save));
      assert.deepEqual(f.saves, []);
      await assert.rejects(verifyVm(f.az, output, parameters, saved, f.save));
      assert.deepEqual(f.saves, []);
      assert.deepEqual(saved, snapshot);
    }
  });

test('full verification requires the exact Foundry model role and live output bindings', async (t) => {
  const f = fixture(t);
  const verified = await verifyVm(f.az, output, parameters, state, f.save);
  assert.deepEqual(verified.state.binding, state.binding);
  assert.equal(f.saves.length, 1);
  for (const patch of [
    { principalId: otherId },
    { principalType: 'User' },
    { roleDefinitionId: VM.role.replace(/.$/, '0') },
    { scope: VM.ids.id },
  ]) {
    const resources = vmResources();
    Object.assign(resources.role.properties, patch);
    const bad = fixture(t, resources);
    await assert.rejects(
      verifyVm(bad.az, output, parameters, state, bad.save),
      /exact Foundry-scoped/,
    );
    assert.deepEqual(bad.saves, []);
  }
  for (const key of [
    'uniqueId',
    'principalId',
    'dataDiskUniqueId',
    'ipv4',
    'fqdn',
  ]) {
    const changed = structuredClone(output);
    changed.vm[key] += '-foreign';
    const bad = fixture(t);
    await assert.rejects(
      verifyVm(bad.az, changed, parameters, state, bad.save),
      /outputs do not match/,
    );
    assert.deepEqual(bad.saves, []);
  }
});

test('changed operator parameters and unbound or mismatched disks never gain a format permit', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    recordDeployment(
      f.az,
      { ...parameters, operatorIpv4Cidr: '8.8.4.4/32' },
      state,
      f.save,
    ),
    /parameters changed/,
  );
  assert.deepEqual(f.saves, []);
  for (const saved of [
    pending(),
    { ...state, binding: undefined },
    { ...state, creation: { ...state.creation, uniqueId: otherId } },
  ])
    assert.throws(() => diskPlan(saved), /No bound new-disk/);
});

for (const [name, absentAt, createdAt, accepted] of [
  [
    'operator 60 seconds ahead',
    '2026-10-20T12:02:00Z',
    '2026-10-20T12:01:00Z',
    true,
  ],
  [
    'operator 15 minutes ahead',
    '2026-10-20T12:16:00Z',
    '2026-10-20T12:01:00Z',
    false,
  ],
  ['nonfinite creation', state.creation.absentAt, 'not-a-date', false],
  [
    'implausible future creation',
    state.creation.absentAt,
    '2026-10-20T12:20:00Z',
    false,
  ],
])
  test(`creation clock: ${name}`, async (t) => {
    const resources = vmResources();
    resources.disk.properties.timeCreated = createdAt;
    const saved = pending();
    saved.creation.absentAt = absentAt;
    const f = fixture(t, resources);
    if (accepted) {
      const recorded = await recordDeployment(f.az, parameters, saved, f.save);
      await verifyVm(f.az, output, parameters, recorded, f.save);
      assert.equal(f.saves.length, 2);
    } else {
      await assert.rejects(
        recordDeployment(f.az, parameters, saved, f.save),
        /creation time/,
      );
      await assert.rejects(
        verifyVm(f.az, output, parameters, saved, f.save),
        /creation time/,
      );
      assert.deepEqual(f.saves, []);
    }
  });

test('Foundry permits the initial parent identity prerequisite but pins its principal before later ARM writes', async (t) => {
  const resources = vmResources();
  resources.foundry = {
    id: output.foundryId,
    location: SCOPE.location,
    tags: TAGS,
    properties: { disableLocalAuth: true },
  };
  const f = fixture(t, resources);
  const withoutIdentity = await recordDeployment(
    f.az,
    parameters,
    pending(),
    f.save,
  );
  assert.equal(withoutIdentity.foundryPrincipalId, undefined);
  resources.foundry.identity = {
    type: 'SystemAssigned',
    tenantId: SCOPE.tenantId,
    principalId: output.foundryPrincipalId,
  };
  const pinned = await recordDeployment(
    f.az,
    parameters,
    withoutIdentity,
    f.save,
  );
  assert.equal(pinned.foundryPrincipalId, output.foundryPrincipalId);
  for (const identity of [
    undefined,
    { ...resources.foundry.identity, principalId: otherId },
    { ...resources.foundry.identity, tenantId: otherId },
    { type: 'UserAssigned' },
  ]) {
    const changed = structuredClone(resources);
    changed.foundry.identity = identity;
    const bad = fixture(t, changed);
    await assert.rejects(
      recordDeployment(bad.az, parameters, pinned, bad.save),
    );
    assert.deepEqual(bad.saves, []);
  }
  const missing = fixture(t, vmResources());
  await assert.rejects(
    recordDeployment(missing.az, parameters, pinned, missing.save),
    /Foundry account is missing/,
  );
  assert.deepEqual(missing.saves, []);
});

test('a created Foundry project keeps its separate identity and cannot be removed or replaced by a retry', async (t) => {
  const resources = vmResources();
  resources.project = {
    id: output.projectId,
    location: SCOPE.location,
    tags: TAGS,
    identity: {
      type: 'SystemAssigned',
      tenantId: SCOPE.tenantId,
      principalId: output.projectPrincipalId,
    },
  };
  const f = fixture(t, resources);
  const pinned = await recordDeployment(f.az, parameters, pending(), f.save);
  assert.equal(pinned.projectPrincipalId, output.projectPrincipalId);
  for (const changed of ['principal', 'tenant', 'missing']) {
    const next = structuredClone(resources);
    if (changed === 'missing') delete next.project;
    else if (changed === 'principal')
      next.project.identity.principalId = otherId;
    else next.project.identity.tenantId = otherId;
    const bad = fixture(t, next);
    await assert.rejects(
      recordDeployment(bad.az, parameters, pinned, bad.save),
      /project/,
    );
    assert.deepEqual(bad.saves, []);
  }
});
