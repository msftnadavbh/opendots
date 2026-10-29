import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCUS_PROFILE } from '../profiles.mjs';
import { assertHostWhatIf } from '../migration-host.mjs';
import { desiredResources } from '../migration-validation.mjs';
import { migrationFixture } from './migration-fixture.mjs';

// Only affected property subtrees from the diagnostic capture; no operator identities or deployment metadata.
const captured = JSON.parse(
  await readFile(
    new URL('./fixtures/host-what-if.json', import.meta.url),
    'utf8',
  ),
);
const compute = SCUS_PROFILE.compute;
const parts = (resources) =>
  Object.fromEntries(
    Object.entries({ ...compute.network, vm: compute.vm })
      .filter(
        ([, value]) => value?.id && resources.some((r) => r.id === value.id),
      )
      .map(([kind, value]) => [
        kind,
        resources.find((r) => r.id === value.id).properties,
      ]),
  );
const maskKeys = (p) => {
  p.vm.osProfile.linuxConfiguration.ssh.publicKeys = structuredClone(
    captured.virtualMachines.publicKeys,
  );
};
const capturedShape = (p) => {
  p.nsg.securityRules = structuredClone(
    captured.networkSecurityGroups.securityRules,
  );
  p.nic.ipConfigurations = structuredClone(
    captured.networkInterfaces.ipConfigurations,
  );
  p.vm.storageProfile = structuredClone(
    captured.virtualMachines.storageProfile,
  );
  maskKeys(p);
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
async function prepared(t) {
  const f = await migrationFixture(t);
  await f.prepare();
  for (const stage of ['group', 'capture', 'copy']) await f.stage(stage);
  await f.prepareHost();
  return f;
}
const disk = (p, kind) =>
  kind === 'os' ? p.vm.storageProfile.osDisk : p.vm.storageProfile.dataDisks[0];

test('host preview accepts explicit, four independent exceptions, combined capture and exact extra disk mirrors without mutating frozen inputs', async (t) => {
  const f = await prepared(t);
  const expected = freeze(
    desiredResources(SCUS_PROFILE, await f.diskState(), 'host'),
  );
  const original = structuredClone(expected);
  const variants = {
    explicit: () => {},
    'NSG name order': (p) => {
      p.nsg.securityRules.reverse();
    },
    'NIC primary omitted': (p) => {
      delete p.nic.ipConfigurations[0].properties.primary;
    },
    'OS managedDisk omitted': (p) => {
      delete disk(p, 'os').managedDisk;
    },
    'data managedDisk omitted': (p) => {
      delete disk(p, 'data').managedDisk;
    },
    'SSH pair masked': maskKeys,
    'combined captured projection': capturedShape,
    'exact extra managed-disk ID and SKU': (p) => {
      disk(p, 'os').managedDisk.id = compute.disks.os.id;
      disk(p, 'data').managedDisk.storageAccountType = 'Standard_LRS';
    },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    await t.test(name, () => {
      const observed = structuredClone(expected);
      mutate(parts(observed));
      const before = structuredClone(observed);
      freeze(observed);
      for (const spec of expected)
        assertHostWhatIf(
          observed.find((r) => r.id === spec.id),
          spec,
          SCUS_PROFILE,
          'host',
        );
      assert.deepEqual(observed, before);
      assert.deepEqual(expected, original);
    });
  }
});

test('captured preview validates and creates only the original explicit request in the synthetic flow; raw gaps and four retained Ignore records stay visible', async (t) => {
  const f = await prepared(t);
  const expected = desiredResources(SCUS_PROFILE, await f.diskState(), 'host');
  let observed;
  f.whatIfMutation = (result) => {
    capturedShape(parts(result.changes.map((c) => c.after)));
    result.changes.push(
      ...Object.values(SCUS_PROFILE.sourcePreservation.snapshots).map(
        ({ id }) => ({ resourceId: id, changeType: 'Ignore' }),
      ),
    );
    observed = structuredClone(result);
  };
  assert.equal((await f.controller.validate('host')).status, 'review-required');
  const proof = (await f.diskState()).stages.host.validation;
  assert.deepEqual(proof.request.expected, expected);
  assert.deepEqual(proof.whatIf, observed);
  assert.equal(proof.validation.properties.validationLevel, 'Provider');
  assert.equal(
    proof.whatIf.changes.filter((c) => c.changeType === 'Create').length,
    7,
  );
  assert.equal(
    proof.whatIf.changes.filter((c) => c.changeType === 'Ignore').length,
    4,
  );
  const raw = parts(
    proof.whatIf.changes.filter((c) => c.after).map((c) => c.after),
  );
  assert(!Object.hasOwn(raw.nic.ipConfigurations[0].properties, 'primary'));
  for (const kind of ['os', 'data'])
    assert(!Object.hasOwn(disk(raw, kind), 'managedDisk'));
  assert.deepEqual(
    raw.vm.osProfile.linuxConfiguration.ssh.publicKeys,
    captured.virtualMachines.publicKeys,
  );
  assert(!(await f.diskState()).stages.host.intent);
  await f.review('host');
  assert.equal((await f.controller.apply('host')).status, 'complete');
  const state = await f.diskState();
  assert.deepEqual(state.stages.host.intent.request.expected, expected);
  assert.deepEqual(
    f.resources.get(compute.vm.id).properties.osProfile.linuxConfiguration.ssh
      .publicKeys,
    parts(expected).vm.osProfile.linuxConfiguration.ssh.publicKeys,
  );
  assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
});

test('preview exceptions reject presence-sensitive invalid values, extra security configuration, other masks and other array changes', async (t) => {
  const f = await prepared(t);
  const expected = freeze(
    desiredResources(SCUS_PROFILE, await f.diskState(), 'host'),
  );
  const original = structuredClone(expected);
  const mutations = [];
  for (const value of [
    undefined,
    null,
    false,
    0,
    'true',
    '*******',
    { testProperty: true },
  ])
    mutations.push([
      'present invalid NIC primary',
      (p) => {
        p.nic.ipConfigurations[0].properties.primary = value;
      },
    ]);
  for (const kind of ['os', 'data']) {
    for (const value of [undefined, null, false, 0, '*******', {}, []])
      mutations.push([
        `${kind} present invalid managedDisk`,
        (p) => {
          disk(p, kind).managedDisk = value;
        },
      ]);
    for (const value of [
      undefined,
      null,
      false,
      '*******',
      'foreign',
      '[resourceId("disk")]',
    ])
      mutations.push([
        `${kind} invalid managed-disk ID`,
        (p) => {
          disk(p, kind).managedDisk.id = value;
        },
      ]);
    for (const value of [
      undefined,
      null,
      false,
      '*******',
      'Premium_LRS',
      '[parameters("sku")]',
    ])
      mutations.push([
        `${kind} invalid managed-disk SKU`,
        (p) => {
          disk(p, kind).managedDisk.storageAccountType = value;
        },
      ]);
    for (const value of [
      { diskEncryptionSet: { id: 'foreign' } },
      { testProperty: true },
      { publicNetworkAccess: 'Enabled' },
    ])
      mutations.push([
        `${kind} unexpected managed-disk configuration`,
        (p) => {
          Object.assign(disk(p, kind).managedDisk, value);
        },
      ]);
  }
  const key = parts(expected).vm.osProfile.linuxConfiguration.ssh.publicKeys[0];
  for (const value of [
    undefined,
    null,
    false,
    {},
    [],
    [null],
    [{ path: '*******', keyData: key.keyData }],
    [{ path: key.path, keyData: '*******' }],
    [{ path: '******', keyData: '******' }],
    [{ path: '********', keyData: '********' }],
    [{ path: '*******', keyData: '******' }],
    [{ path: null, keyData: null }],
    [{ path: key.path }],
    [{ keyData: key.keyData }],
    [{ path: '/wrong/path', keyData: key.keyData }],
    [{ path: key.path, keyData: 'wrong-key' }],
    [{ ...key, extra: true }],
    [{ path: '*******', keyData: '*******', extra: true }],
    [key, key],
  ])
    mutations.push([
      'invalid SSH pair',
      (p) => {
        p.vm.osProfile.linuxConfiguration.ssh.publicKeys = value;
      },
    ]);
  for (const [field, value] of Object.entries({
    priority: 101,
    direction: 'Outbound',
    access: 'Deny',
    protocol: '*',
    sourceAddressPrefix: '*',
    sourcePortRange: '22',
    destinationAddressPrefix: '*',
    destinationPortRanges: ['80', '443', '22'],
    destinationPortRange: '*',
    sourceAddressPrefixes: ['Internet'],
    sourcePortRanges: ['*'],
    destinationAddressPrefixes: ['*'],
    sourceApplicationSecurityGroups: [{ id: 'foreign' }],
    destinationApplicationSecurityGroups: [{ id: 'foreign' }],
    testProperty: 'unexpected',
  }))
    mutations.push([
      `NSG changed/extra security property ${field}`,
      (p) => {
        p.nsg.securityRules.find((r) => r.name === 'https-and-acme').properties[
          field
        ] = value;
      },
    ]);
  const structural = {
    'NSG extra rule': (p) => {
      p.nsg.securityRules.push(structuredClone(p.nsg.securityRules[0]));
    },
    'NSG duplicate name': (p) => {
      p.nsg.securityRules[0] = structuredClone(p.nsg.securityRules[1]);
    },
    'NSG missing rule': (p) => {
      p.nsg.securityRules.pop();
    },
    'NSG wrong name case': (p) => {
      p.nsg.securityRules[0].name = 'HTTPS-AND-ACME';
    },
    'NSG null rule': (p) => {
      p.nsg.securityRules[0] = null;
    },
    'NSG ports order is not relaxed': (p) => {
      p.nsg.securityRules[0].properties.destinationPortRanges.reverse();
    },
    'NIC missing parent': (p) => {
      delete p.nic.ipConfigurations[0].properties;
    },
    'NIC missing config': (p) => {
      p.nic.ipConfigurations = [];
    },
    'NIC extra config': (p) => {
      p.nic.ipConfigurations.push(structuredClone(p.nic.ipConfigurations[0]));
    },
    'NIC omitted primary cannot hide wrong IP': (p) => {
      delete p.nic.ipConfigurations[0].properties.primary;
      p.nic.ipConfigurations[0].properties.privateIPAddress = '10.43.0.5';
    },
    'VM missing OS parent': (p) => {
      delete p.vm.storageProfile.osDisk;
    },
    'VM missing storage parent': (p) => {
      delete p.vm.storageProfile;
    },
    'VM missing data parent': (p) => {
      p.vm.storageProfile.dataDisks = [];
    },
    'VM extra data disk': (p) => {
      p.vm.storageProfile.dataDisks.push(
        structuredClone(p.vm.storageProfile.dataDisks[0]),
      );
    },
    'VM omitted disk cannot hide wrong size': (p) => {
      delete disk(p, 'os').managedDisk;
      disk(p, 'os').diskSizeGB = 31;
    },
    'VM omitted disk cannot hide wrong retention': (p) => {
      delete disk(p, 'data').managedDisk;
      disk(p, 'data').deleteOption = 'Delete';
    },
    'mask outside SSH on image': (p) => {
      p.vm.storageProfile.imageReference.version = '*******';
    },
    'mask outside SSH on admin': (p) => {
      p.vm.osProfile.adminUsername = '*******';
    },
    'mask outside SSH on NIC': (p) => {
      p.nic.ipConfigurations[0].properties.privateIPAddress = '*******';
    },
    'masked customData': (p) => {
      p.vm.osProfile.customData = '*******';
    },
    'masked userData': (p) => {
      p.vm.userData = '*******';
    },
    'masked PIP classification': (p) => {
      p.pip.ipTags[0].tag = '*******';
    },
    'VNet array count unchanged': (p) => {
      p.vnet.subnets.push(structuredClone(p.vnet.subnets[0]));
    },
  };
  mutations.push(...Object.entries(structural));
  for (const [name, mutate] of mutations) {
    const observed = structuredClone(expected);
    mutate(parts(observed));
    const before = structuredClone(observed);
    freeze(observed);
    assert.throws(
      () => {
        for (const spec of expected)
          assertHostWhatIf(
            observed.find((r) => r.id === spec.id),
            spec,
            SCUS_PROFILE,
            'host',
          );
      },
      /B1 what-if/,
      name,
    );
    assert.deepEqual(observed, before, name);
    assert.deepEqual(expected, original, name);
  }
  const maskedVm = structuredClone(
    expected.find((r) => r.id === compute.vm.id),
  );
  maskKeys({ vm: maskedVm.properties });
  assert.throws(
    () =>
      assertHostWhatIf(
        maskedVm,
        expected.find((r) => r.id === compute.vm.id),
        SCUS_PROFILE,
        'model-role',
      ),
    /B1 what-if/,
  );
});

test('bad combined previews retain the earlier synthetic proof and produce zero host intent/create', async (t) => {
  const f = await prepared(t);
  f.whatIfMutation = (r) => capturedShape(parts(r.changes.map((c) => c.after)));
  await f.controller.validate('host');
  await f.review('host');
  const before = await f.diskState();
  for (const mutate of [
    (p) => {
      p.nic.ipConfigurations[0].properties.primary = null;
    },
    (p) => {
      disk(p, 'os').managedDisk = {};
    },
    (p) => {
      disk(p, 'data').managedDisk = { id: 'foreign' };
    },
    (p) => {
      p.vm.osProfile.linuxConfiguration.ssh.publicKeys[0].path = '/wrong';
    },
    (p) => {
      p.nsg.securityRules.push(structuredClone(p.nsg.securityRules[0]));
    },
    (p) => {
      p.vm.osProfile.customData = '*******';
    },
    (p) => {
      p.pip.ipTags[0].extra = 'unapproved';
    },
    (p) => {
      p.nic.ipConfigurations[0].properties.loadBalancerBackendAddressPools = [
        { id: 'foreign' },
      ];
    },
  ]) {
    f.whatIfMutation = (r) => {
      const p = parts(r.changes.map((c) => c.after));
      capturedShape(p);
      mutate(p);
    };
    await assert.rejects(f.controller.validate('host'), /B1 what-if/);
    await assert.rejects(f.controller.apply('host'), /B1 what-if/);
    assert.deepEqual(await f.diskState(), before);
  }
  assert(!before.stages.host.intent);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
});

test('completed readback still rejects omitted NIC primary, missing managedDisk objects/IDs and masked or incorrect SSH keys', async (t) => {
  const f = await prepared(t);
  f.createFault = 'after';
  await assert.rejects(f.stage('host'), /Azure CLI/);
  f.createFault = undefined;
  const original = structuredClone([...f.resources.entries()]);
  const intent = (await f.diskState()).stages.host.intent;
  const start = f.calls.length;
  for (const mutate of [
    (p) => {
      delete p.nic.ipConfigurations[0].properties.primary;
    },
    (p) => {
      p.nic.ipConfigurations[0].properties.primary = null;
    },
    (p) => {
      p.nic.ipConfigurations[0].properties.primary = false;
    },
    (p) => {
      delete disk(p, 'os').managedDisk;
    },
    (p) => {
      delete disk(p, 'data').managedDisk;
    },
    (p) => {
      delete disk(p, 'os').managedDisk.id;
    },
    (p) => {
      delete disk(p, 'data').managedDisk.id;
    },
    maskKeys,
    (p) => {
      p.vm.osProfile.linuxConfiguration.ssh.publicKeys[0].keyData = 'wrong-key';
    },
  ]) {
    f.resources = new Map(structuredClone(original));
    mutate(parts([...f.resources.values()]));
    const observed = structuredClone([...f.resources.entries()]);
    await assert.rejects(f.controller.reconcile('host'));
    const state = await f.diskState();
    assert.deepEqual(state.stages.host.intent, intent);
    assert(!state.stages.host.binding);
    assert.deepEqual([...f.resources.entries()], observed);
  }
  assert(
    !f.calls
      .slice(start)
      .some((args) => ['validate', 'what-if', 'create'].includes(args[2])),
  );
  assert.deepEqual(f.creates, ['group', 'capture', 'copy', 'host']);
});
