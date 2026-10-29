import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCUS_PROFILE } from '../profiles.mjs';
import {
  assertStageTemplate,
  desiredResources,
} from '../migration-validation.mjs';
import { compiled, migrationFixture } from './migration-fixture.mjs';

test('compiled stages contain only the approved new group and four incremental snapshots, never original/shared writes', async (t) => {
  const f = await migrationFixture(t);
  await f.prepare();
  await f.stage('group');
  await f.stage('capture');
  const state = await f.diskState();
  for (const stage of ['group', 'capture', 'copy']) {
    const template = JSON.parse(compiled[stage]);
    assertStageTemplate(SCUS_PROFILE, state, stage, template);
    assert.equal(template.resources.length, stage === 'group' ? 1 : 2);
    for (const item of template.resources) {
      assert.equal(item.condition, "[variables('authorized')]");
      assert(!item.resources && !item.scope && !item.dependsOn);
      assert(
        [
          'Microsoft.Resources/resourceGroups',
          'Microsoft.Compute/snapshots',
        ].includes(item.type),
      );
      if (stage === 'group') {
        assert.equal(item.name, 'rg-opendots-pilot-scus');
        assert.equal(item.location, 'southcentralus');
      } else {
        assert.equal(
          item.location,
          stage === 'capture' ? 'eastus2' : 'southcentralus',
        );
        assert.equal(item.sku.name, 'Standard_LRS');
        assert.equal(item.properties.incremental, true);
        assert.equal(
          item.properties.creationData.createOption,
          stage === 'capture' ? 'Copy' : 'CopyStart',
        );
        assert.equal(item.properties.networkAccessPolicy, 'DenyAll');
        assert.equal(item.properties.publicNetworkAccess, 'Disabled');
        assert.deepEqual(item.properties.encryption, {
          type: 'EncryptionAtRestWithPlatformKey',
        });
        assert(
          !item.properties.creationData.sourceUri &&
            !item.properties.creationData.sourceUniqueId,
        );
      }
    }
    if (stage !== 'group') {
      assert.equal(template.resources[0].properties.diskSizeGB, 30);
      assert.equal(template.resources[1].properties.diskSizeGB, 32);
      assert.deepEqual(template.resources[0].properties.securityProfile, {
        securityType: 'TrustedLaunch',
      });
      assert.equal(template.resources[0].properties.hyperVGeneration, 'V2');
    }
    const tests = [
      (x) => {
        x.resources[0].type = 'Microsoft.Compute/virtualMachines';
      },
      (x) => {
        x.resources[0].name = 'vm-opendots-pilot';
      },
      (x) => {
        x.resources[0].location = 'foreign';
      },
      (x) => {
        delete x.resources[0].condition;
      },
      (x) => {
        x.resources.push(structuredClone(x.resources[0]));
      },
      (x) => {
        x.resources[0].scope = '/subscriptions/foreign';
      },
      (x) => {
        x.resources[0].dependsOn = ['unreviewed'];
      },
      (x) => {
        x.outputs.secret = { type: 'string', value: '[listKeys()]' };
      },
      (x) => {
        x.variables.authorized = true;
      },
      (x) => {
        x.parameters.arbitraryId = { type: 'string' };
      },
    ];
    if (stage !== 'group')
      tests.push(
        (x) => {
          x.resources[0].properties.networkAccessPolicy = 'AllowAll';
        },
        (x) => {
          x.resources[0].properties.publicNetworkAccess = 'Enabled';
        },
        (x) => {
          x.resources[0].properties.securityProfile.securityType = 'Standard';
        },
        (x) => {
          x.resources[1].properties.creationData.sourceUri = 'https://foreign';
        },
      );
    for (const mutate of tests) {
      const changed = structuredClone(template);
      mutate(changed);
      assert.throws(() =>
        assertStageTemplate(SCUS_PROFILE, state, stage, changed),
      );
    }
    assert(
      desiredResources(SCUS_PROFILE, state, stage).every((item) =>
        item.id.startsWith(SCUS_PROFILE.compute.groupId),
      ),
    );
  }
});
