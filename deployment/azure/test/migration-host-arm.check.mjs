import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCUS_PROFILE } from '../profiles.mjs';
import { assertHostWhatIf } from '../migration-host.mjs';
import { assertStageTemplate, stageIds } from '../migration-validation.mjs';
import { migrationFixture, compiled } from './migration-fixture.mjs';

const pipIpTags = [{ ipTagType: 'FirstPartyUsage', tag: '/Unprivileged' }];
const invalidIpTags = [
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

test('B1 compiled contracts declare only seven target host resources and the exact separate shared-account role', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  for (const stage of ['group', 'capture', 'copy']) await f.stage(stage);
  await f.prepareHost();
  await f.stage('host');
  const state = await f.diskState();
  for (const stage of ['host', 'model-role']) {
    const template = JSON.parse(compiled[stage]);
    assertStageTemplate(SCUS_PROFILE, state, stage, template);
    assert.equal(template.resources.length, stage === 'host' ? 7 : 1);
    assert(
      template.resources.every(
        (r) => r.condition === "[variables('authorized')]",
      ),
    );
    assert(!JSON.stringify(template).includes('runCommands'));
    assert(!JSON.stringify(template).includes('customData'));
    const mutations = [
      (x) => {
        x.resources.push(structuredClone(x.resources[0]));
      },
      (x) => {
        x.resources[0].type = 'Microsoft.Compute/virtualMachines/extensions';
      },
      (x) => {
        delete x.resources[0].condition;
      },
      (x) => {
        x.variables.authorized = true;
      },
      (x) => {
        x.parameters.arbitraryScope = { type: 'string' };
      },
      (x) => {
        x.outputs.secret = { type: 'string', value: '[listKeys()]' };
      },
    ];
    if (stage === 'host') {
      assert(
        stageIds(SCUS_PROFILE, stage).every((id) =>
          id.startsWith(SCUS_PROFILE.compute.groupId),
        ),
      );
      assert(
        !stageIds(SCUS_PROFILE, stage).includes(
          SCUS_PROFILE.compute.disks.os.id,
        ),
      );
      assert.deepEqual(template.resources[2].properties.ipTags, pipIpTags);
      const vm = template.resources[6];
      assert.equal(vm.properties.storageProfile.osDisk.diskSizeGB, 32);
      assert.equal(
        vm.properties.storageProfile.osDisk.createOption,
        'FromImage',
      );
      assert.equal(
        vm.properties.storageProfile.osDisk.managedDisk.publicNetworkAccess,
        undefined,
      );
      assert.equal(vm.properties.storageProfile.dataDisks.length, 1);
      assert.equal(vm.properties.storageProfile.dataDisks[0].lun, 0);
      assert.equal(
        template.resources[5].properties.creationData.createOption,
        'Copy',
      );
      assert(
        !JSON.stringify(vm.properties.storageProfile).includes('os-audit'),
      );
      mutations.push(
        ...invalidIpTags.map((ipTags) => (x) => {
          x.resources[2].properties.ipTags = structuredClone(ipTags);
        }),
        (x) => {
          x.resources[6].properties.storageProfile.imageReference.version =
            'latest';
        },
        (x) => {
          x.resources[6].properties.storageProfile.osDisk.diskSizeGB = 64;
        },
        (x) => {
          x.resources[6].properties.storageProfile.osDisk.createOption =
            'Attach';
        },
        (x) => {
          x.resources[6].properties.storageProfile.dataDisks.push({ lun: 1 });
        },
        (x) => {
          x.resources[6].properties.osProfile.customData = 'unreviewed';
        },
        (x) => {
          x.resources[6].properties.osProfile.adminPassword = 'unreviewed';
        },
        (x) => {
          x.resources[6].properties.securityProfile.uefiSettings.secureBootEnabled = false;
        },
        (x) => {
          x.resources[6].identity.type = 'SystemAssigned, UserAssigned';
        },
        (x) => {
          x.resources[4].properties.creationData.createOption = 'Empty';
        },
        (x) => {
          x.resources[4].properties.creationData.sourceResourceId =
            SCUS_PROFILE.sourcePreservation.dataDiskId;
        },
        (x) => {
          x.resources[5].properties.networkAccessPolicy = 'AllowAll';
        },
        (x) => {
          x.resources[5].properties.securityProfile.securityType = 'Standard';
        },
        (x) => {
          x.resources[3].properties.ipConfigurations[0].properties.privateIPAllocationMethod =
            'Dynamic';
        },
        (x) => {
          delete x.resources[1].properties.subnets[0].properties
            .networkSecurityGroup;
        },
        (x) => {
          x.resources[0].properties.securityRules[0].properties.destinationPortRanges.push(
            '22',
          );
        },
        (x) => {
          x.resources[0].properties.securityRules[0].properties.destinationAddressPrefix =
            '*';
        },
      );
    } else {
      assert.equal(
        template.resources[0].type,
        'Microsoft.Authorization/roleAssignments',
      );
      assert.equal(template.resources[0].name, SCUS_PROFILE.modelRole.name);
      assert.equal(
        template.resources[0].properties.principalId,
        "[parameters('principalId')]",
      );
      assert.deepEqual(Object.keys(template.parameters), ['principalId']);
      assert(template.variables.authorized.includes("'rg-opendots-pilot'"));
      assert(!JSON.stringify(template).includes('reference('));
      mutations.push(
        (x) => {
          x.resources[0].scope = SCUS_PROFILE.compute.groupId;
        },
        (x) => {
          x.resources[0].name = '00000000-0000-0000-0000-000000000000';
        },
        (x) => {
          x.resources[0].properties.roleDefinitionId = 'Owner';
        },
        (x) => {
          x.resources[0].properties.principalType = 'User';
        },
        (x) => {
          x.resources[0].properties.principalId =
            "[reference('vm').identity.principalId]";
        },
      );
    }
    for (const mutate of mutations) {
      const changed = structuredClone(template);
      mutate(changed);
      assert.throws(
        () => assertStageTemplate(SCUS_PROFILE, state, stage, changed),
        /Compiled B1 template/,
      );
    }
  }
});

test('B1 provider checks reject missing declared resources and extra guest/network configuration before intent', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  for (const stage of ['group', 'capture', 'copy']) await f.stage(stage);
  await f.prepareHost();
  f.validationMutation = (r) => {
    r.properties.validatedResources.pop();
  };
  await assert.rejects(f.controller.validate('host'), /Provider validation/);
  f.validationMutation = undefined;
  for (const mutate of [
    (changes) => {
      changes.find(
        (x) => x.after.type === 'Microsoft.Compute/disks',
      ).after.properties.encryption.type = 'EncryptionAtRestWithCustomerKey';
    },
    (changes) => {
      changes.find(
        (x) => x.after.type === 'Microsoft.Compute/virtualMachines',
      ).after.properties.osProfile.customData = 'unreviewed';
    },
    (changes) => {
      changes.find(
        (x) => x.after.type === 'Microsoft.Network/virtualNetworks',
      ).after.properties.dhcpOptions = { dnsServers: ['8.8.8.8'] };
    },
    (changes) => {
      changes.find(
        (x) => x.after.type === 'Microsoft.Network/publicIPAddresses',
      ).after.properties.natGateway = { id: 'foreign' };
    },
    (changes) => {
      changes[0].changeType = 'Modify';
    },
  ]) {
    f.whatIfMutation = (r) => mutate(r.changes);
    await assert.rejects(f.controller.validate('host'), /B1 what-if/);
    assert(!(await f.diskState()).stages.host.intent);
  }
  assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
});

test('B1 what-if requires exact target PIP classification, rejects tags elsewhere and preserves every other overlay guard before intent/create', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  for (const stage of ['group', 'capture', 'copy']) await f.stage(stage);
  await f.prepareHost();
  await f.controller.validate('host');
  await f.review('host');
  const before = await f.diskState();
  const pip = before.stages.host.validation.request.expected.find(
    (r) => r.id === SCUS_PROFILE.compute.network.pip.id,
  );
  for (const override of [
    { id: `${pip.id}-foreign` },
    { type: 'Microsoft.Network/networkInterfaces' },
  ]) {
    const changed = { ...structuredClone(pip), ...override };
    assert.throws(
      () => assertHostWhatIf(changed, changed, SCUS_PROFILE, 'host'),
      /B1 what-if/,
    );
  }
  const mutations = invalidIpTags.map((ipTags) => (changes) => {
    const p = changes.find(
      (x) => x.resourceId === SCUS_PROFILE.compute.network.pip.id,
    ).after.properties;
    if (ipTags === undefined) delete p.ipTags;
    else p.ipTags = structuredClone(ipTags);
  });
  for (const kind of ['nic', 'vnet', 'nsg'])
    for (const ipTags of [pipIpTags, {}, { length: 0 }, '', false, 0])
      mutations.push((changes) => {
        changes.find(
          (x) => x.resourceId === SCUS_PROFILE.compute.network[kind].id,
        ).after.properties.ipTags = structuredClone(ipTags);
      });
  for (const field of [
    'publicIPPrefix',
    'linkedPublicIPAddress',
    'servicePublicIPAddress',
    'natGateway',
  ])
    mutations.push((changes) => {
      changes.find(
        (x) => x.resourceId === SCUS_PROFILE.compute.network.pip.id,
      ).after.properties[field] = { id: 'foreign' };
    });
  mutations.push(
    (changes) => {
      changes.find(
        (x) => x.resourceId === SCUS_PROFILE.compute.network.vnet.id,
      ).after.properties.virtualNetworkPeerings = [{ id: 'foreign' }];
    },
    (changes) => {
      changes.find(
        (x) => x.resourceId === SCUS_PROFILE.compute.network.vnet.id,
      ).after.properties.subnets[0].properties.routeTable = { id: 'foreign' };
    },
  );
  for (const [index, mutate] of mutations.entries()) {
    f.whatIfMutation = (r) => mutate(r.changes);
    await assert.rejects(
      f.controller.validate('host'),
      /B1 what-if/,
      `${index}`,
    );
    await assert.rejects(f.controller.apply('host'), /B1 what-if/, `${index}`);
    assert.deepEqual(await f.diskState(), before);
  }
  assert(!before.stages.host.intent);
  assert.deepEqual(f.creates, ['group', 'capture', 'copy']);
  f.whatIfMutation = (r) => {
    for (const change of r.changes) {
      delete change.after.id;
      if (change.resourceId === SCUS_PROFILE.compute.network.pip.id)
        change.after.type = change.after.type.toUpperCase();
      else if (
        ['nic', 'vnet', 'nsg'].some(
          (kind) => change.resourceId === SCUS_PROFILE.compute.network[kind].id,
        )
      )
        change.after.properties.ipTags = [];
    }
  };
  assert.equal((await f.controller.validate('host')).status, 'review-required');
});
