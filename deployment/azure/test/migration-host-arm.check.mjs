import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCUS_PROFILE } from '../profiles.mjs';
import { assertStageTemplate, stageIds } from '../migration-validation.mjs';
import { migrationFixture, compiled } from './migration-fixture.mjs';

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
