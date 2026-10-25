import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCOPE, VM, PULL_ACTIONS } from '../scope.mjs';

assert(
  process.env.PILOT_ARM_TEMPLATE,
  'Compile infra/main.bicep and set PILOT_ARM_TEMPLATE; this safety contract must not be skipped.',
);
const template = JSON.parse(
  readFileSync(process.env.PILOT_ARM_TEMPLATE, 'utf8'),
);
const resources = (value) =>
  Array.isArray(value.resources)
    ? value.resources
    : Object.values(value.resources);
const find = (value, type) => {
  const matches = resources(value).filter((resource) => resource.type === type);
  assert.equal(matches.length, 1, `Exactly one ${type}`);
  return matches[0];
};
const pilot = (value) =>
  find(value, 'Microsoft.Resources/deployments').properties.template;
const host = (value) =>
  find(pilot(value), 'Microsoft.Resources/deployments').properties.template;

function contract(value) {
  const group = find(value, 'Microsoft.Resources/resourceGroups');
  const deployment = find(value, 'Microsoft.Resources/deployments');
  assert.equal(resources(value).length, 2);
  assert.equal(group.name, 'rg-opendots-pilot');
  assert.equal(group.location, 'eastus2');
  assert.equal(deployment.resourceGroup, group.name);
  assert.equal(
    deployment.properties.expressionEvaluationOptions.scope,
    'inner',
  );
  assert.equal(deployment.properties.mode, 'Incremental');
  assert.equal(group.condition, "[variables('authorized')]");
  assert.equal(deployment.condition, group.condition);
  assert(value.variables.authorized.includes(SCOPE.subscriptionId));
  assert(value.variables.authorized.includes(SCOPE.tenantId));
  assert(
    value.variables.authorized.includes("'/32'"),
    'The historical operator parameter must retain its /32 contract',
  );
  assert(deployment.dependsOn.some((id) => id.includes(group.name)));
  assert.deepEqual(Object.keys(value.parameters).sort(), [
    'operatorIpv4Cidr',
    'sshPublicKey',
  ]);

  const p = pilot(value),
    v = host(value);
  assert.equal(p.variables.location, 'eastus2');
  assert.equal(v.variables.location, 'eastus2');
  const sandbox = find(p, 'Microsoft.App/sandboxGroups');
  assert.equal(sandbox.name, 'sbx-opendots-pilot');
  assert.equal(sandbox.apiVersion, '2026-07-01');
  assert.deepEqual(sandbox.properties, {});
  assert(!Object.hasOwn(sandbox, 'identity'));
  const project = find(p, 'Microsoft.CognitiveServices/accounts/projects');
  assert.deepEqual(project.identity, { type: 'SystemAssigned' });
  assert(
    project.dependsOn.some(
      (id) => id.includes('accounts/deployments') && id.includes('dot-chat'),
    ),
  );
  assert.equal(
    find(p, 'Microsoft.CognitiveServices/accounts').properties.disableLocalAuth,
    true,
  );
  assert.deepEqual(find(p, 'Microsoft.CognitiveServices/accounts').identity, {
    type: 'SystemAssigned',
  });
  assert.equal(
    find(p, 'Microsoft.CognitiveServices/accounts/deployments').properties
      .raiPolicyName,
    'Microsoft.DefaultV2',
  );
  assert.equal(p.outputs.pilot.value.modelAuthMode, 'managed-identity');
  const registry = find(p, 'Microsoft.ContainerRegistry/registries');
  assert.equal(registry.properties.adminUserEnabled, false);
  assert.equal(registry.properties.anonymousPullEnabled, false);
  assert.equal(registry.properties.dataEndpointEnabled, false);
  assert.equal(registry.properties.networkRuleBypassAllowedForTasks, false);
  assert.equal(
    registry.properties.roleAssignmentMode,
    'LegacyRegistryPermissions',
  );
  assert.deepEqual(
    find(p, 'Microsoft.ContainerRegistry/registries/scopeMaps').properties
      .actions,
    PULL_ACTIONS,
  );
  const token = find(p, 'Microsoft.ContainerRegistry/registries/tokens');
  assert.equal(token.properties.status, 'disabled');
  assert(!Object.hasOwn(token.properties, 'credentials'));

  const roles = resources(p).filter(
    (resource) => resource.type === 'Microsoft.Authorization/roleAssignments',
  );
  assert.equal(roles.length, 2);
  const modelRole = roles.find(
    (resource) => resource.properties.principalType === 'ServicePrincipal',
  );
  const sandboxRole = roles.find(
    (resource) => resource.properties.principalType === 'User',
  );
  assert.equal(
    modelRole.scope,
    "[resourceId('Microsoft.CognitiveServices/accounts', format('ai-opendots-{0}', variables('suffix')))]",
  );
  assert.equal(
    modelRole.properties.roleDefinitionId,
    "[variables('modelRole')]",
  );
  assert(
    p.variables.modelRole.includes('5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'),
  );
  assert.match(
    modelRole.properties.principalId,
    /opendots-pilot-vm.*outputs\.vmPrincipalId\.value/,
  );
  assert.equal(
    sandboxRole.scope,
    "[resourceId('Microsoft.App/sandboxGroups', 'sbx-opendots-pilot')]",
  );
  assert.equal(p.variables.principalId, SCOPE.principalId);

  const vm = find(v, 'Microsoft.Compute/virtualMachines');
  assert.equal(vm.apiVersion, '2025-11-01');
  assert.equal(v.variables.vmName, 'vm-opendots-pilot');
  assert.deepEqual(vm.identity, { type: 'SystemAssigned' });
  assert.equal(vm.properties.hardwareProfile.vmSize, 'Standard_D2als_v7');
  assert.deepEqual(vm.properties.securityProfile, {
    securityType: 'TrustedLaunch',
    uefiSettings: { secureBootEnabled: true, vTpmEnabled: true },
  });
  const storage = vm.properties.storageProfile;
  assert.equal(storage.diskControllerType, 'NVMe');
  assert.deepEqual(storage.imageReference, {
    publisher: 'Canonical',
    offer: 'ubuntu-24_04-lts',
    sku: 'server',
    version: '24.04.202610160',
  });
  assert.equal(storage.osDisk.deleteOption, 'Detach');
  assert.equal(
    storage.osDisk.managedDisk.storageAccountType,
    'StandardSSD_LRS',
  );
  assert.equal(storage.dataDisks.length, 1);
  assert.deepEqual(storage.dataDisks[0], {
    lun: 0,
    name: 'disk-opendots-pilot-data',
    createOption: 'Attach',
    caching: 'None',
    deleteOption: 'Detach',
    managedDisk: {
      id: "[resourceId('Microsoft.Compute/disks', 'disk-opendots-pilot-data')]",
    },
  });
  assert.equal(vm.properties.networkProfile.networkInterfaces.length, 1);
  assert.equal(
    vm.properties.networkProfile.networkInterfaces[0].properties.deleteOption,
    'Detach',
  );
  const linux = vm.properties.osProfile.linuxConfiguration;
  assert.equal(linux.disablePasswordAuthentication, true);
  assert.equal(linux.provisionVMAgent, true);
  assert.deepEqual(linux.ssh.publicKeys, [
    {
      path: '/home/opendots/.ssh/authorized_keys',
      keyData: "[parameters('sshPublicKey')]",
    },
  ]);
  assert(!Object.hasOwn(vm.properties.osProfile, 'customData'));

  const disk = find(v, 'Microsoft.Compute/disks');
  assert.equal(disk.apiVersion, '2025-01-02');
  assert.equal(disk.name, 'disk-opendots-pilot-data');
  assert.equal(disk.sku.name, 'StandardSSD_LRS');
  assert.deepEqual(disk.properties, {
    creationData: { createOption: 'Empty' },
    diskSizeGB: 32,
    networkAccessPolicy: 'DenyAll',
    publicNetworkAccess: 'Disabled',
  });
  const nsg = find(v, 'Microsoft.Network/networkSecurityGroups');
  assert.equal(nsg.properties.securityRules.length, 2);
  for (const [name, priority, access, protocol, source, ports] of [
    ['https-and-acme', 100, 'Allow', 'Tcp', 'Internet', ['80', '443']],
    ['deny-other-inbound', 4096, 'Deny', '*', '*', ['*']],
  ]) {
    const rule = nsg.properties.securityRules.find(
      (rule) => rule.name === name,
    )?.properties;
    assert.equal(rule.priority, priority);
    assert.equal(rule.access, access);
    assert.equal(rule.direction, 'Inbound');
    assert.equal(rule.protocol, protocol);
    assert.equal(rule.sourceAddressPrefix, source);
    assert.equal(rule.sourcePortRange, '*');
    assert.equal(rule.destinationAddressPrefix, '*');
    for (const key of [
      'sourceAddressPrefixes',
      'sourcePortRanges',
      'destinationAddressPrefixes',
      'sourceApplicationSecurityGroups',
      'destinationApplicationSecurityGroups',
    ])
      assert(!rule[key]?.length);
    assert(!(rule.destinationPortRange && rule.destinationPortRanges?.length));
    assert.deepEqual(
      rule.destinationPortRanges ?? [rule.destinationPortRange],
      ports,
    );
  }
  const pip = find(v, 'Microsoft.Network/publicIPAddresses');
  assert.equal(pip.sku.name, 'Standard');
  assert.equal(pip.properties.publicIPAllocationMethod, 'Static');
  assert.equal(pip.properties.publicIPAddressVersion, 'IPv4');
  assert.equal(
    pip.properties.dnsSettings.domainNameLabelScope,
    'ResourceGroupReuse',
  );
  const nic = find(v, 'Microsoft.Network/networkInterfaces');
  assert.equal(nic.properties.enableIPForwarding, false);
  assert.equal(
    nic.properties.networkSecurityGroup.id,
    "[resourceId('Microsoft.Network/networkSecurityGroups', 'nsg-opendots-pilot')]",
  );
  assert.equal(nic.properties.ipConfigurations.length, 1);
  assert.equal(
    nic.properties.ipConfigurations[0].properties.publicIPAddress.id,
    "[resourceId('Microsoft.Network/publicIPAddresses', 'pip-opendots-pilot')]",
  );
  assert.equal(
    find(v, 'Microsoft.Network/virtualNetworks').properties.subnets.length,
    1,
  );
  for (const resource of resources(v).filter((r) =>
    r.type.startsWith('Microsoft.Network/'),
  ))
    assert.equal(resource.apiVersion, '2025-05-01');
  const allowed = new Map([
    ['Microsoft.Resources/resourceGroups', 1],
    ['Microsoft.Resources/deployments', 2],
    ['Microsoft.App/sandboxGroups', 1],
    ['Microsoft.Authorization/roleAssignments', 2],
    ['Microsoft.ContainerRegistry/registries', 1],
    ['Microsoft.ContainerRegistry/registries/scopeMaps', 1],
    ['Microsoft.ContainerRegistry/registries/tokens', 1],
    ['Microsoft.CognitiveServices/accounts', 1],
    ['Microsoft.CognitiveServices/accounts/projects', 1],
    ['Microsoft.CognitiveServices/accounts/deployments', 1],
    ['Microsoft.OperationalInsights/workspaces', 1],
    ['Microsoft.Insights/components', 1],
    ['Microsoft.Network/networkSecurityGroups', 1],
    ['Microsoft.Network/virtualNetworks', 1],
    ['Microsoft.Network/publicIPAddresses', 1],
    ['Microsoft.Network/networkInterfaces', 1],
    ['Microsoft.Compute/disks', 1],
    ['Microsoft.Compute/virtualMachines', 1],
  ]);
  const actual = new Map();
  function walk(t) {
    for (const r of resources(t)) {
      actual.set(r.type, (actual.get(r.type) ?? 0) + 1);
      if (r.type === 'Microsoft.Resources/deployments') {
        assert(!r.properties.templateLink);
        assert.equal(r.properties.mode, 'Incremental');
        walk(r.properties.template);
      }
    }
  }
  walk(value);
  assert.deepEqual(
    actual,
    allowed,
    'No production resources, extensions or deployment scripts may enter the pilot graph',
  );
  assert(
    !/listKeys|listAccountSas|listServiceSas|adminPassword|OWNER_TOKEN|CPK_INTELLIGENCE_API_KEY/.test(
      JSON.stringify(value),
    ),
  );
}

test('compiled ARM enforces the full fixed-scope VM, identity, retained-disk and network contract', () =>
  contract(template));
test('compiled ARM safety contract rejects insecure changes', () => {
  const mutations = [
    (t) => {
      find(t, 'Microsoft.Resources/deployments').resourceGroup = 'foreign';
    },
    (t) => {
      find(
        pilot(t),
        'Microsoft.CognitiveServices/accounts',
      ).properties.disableLocalAuth = false;
    },
    (t) => {
      find(pilot(t), 'Microsoft.App/sandboxGroups').identity = {
        type: 'SystemAssigned',
      };
    },
    (t) => {
      find(
        pilot(t),
        'Microsoft.CognitiveServices/accounts/projects',
      ).dependsOn = [];
    },
    (t) => {
      find(
        pilot(t),
        'Microsoft.ContainerRegistry/registries',
      ).properties.adminUserEnabled = true;
    },
    (t) => {
      find(
        pilot(t),
        'Microsoft.ContainerRegistry/registries/tokens',
      ).properties.status = 'enabled';
    },
    (t) => {
      resources(pilot(t)).find(
        (r) => r.properties?.principalType === 'ServicePrincipal',
      ).scope = '[subscription().id]';
    },
    (t) => {
      find(host(t), 'Microsoft.Compute/virtualMachines').identity.type = 'None';
    },
    (t) => {
      find(
        host(t),
        'Microsoft.Compute/virtualMachines',
      ).properties.storageProfile.diskControllerType = 'SCSI';
    },
    (t) => {
      find(
        host(t),
        'Microsoft.Compute/virtualMachines',
      ).properties.storageProfile.dataDisks[0].deleteOption = 'Delete';
    },
    (t) => {
      find(
        host(t),
        'Microsoft.Compute/virtualMachines',
      ).properties.storageProfile.osDisk.deleteOption = 'Delete';
    },
    (t) => {
      find(host(t), 'Microsoft.Compute/disks').properties.networkAccessPolicy =
        'AllowAll';
    },
    (t) => {
      find(
        host(t),
        'Microsoft.Network/networkSecurityGroups',
      ).properties.securityRules[1].properties.access = 'Allow';
    },
    (t) => {
      find(
        host(t),
        'Microsoft.Network/networkSecurityGroups',
      ).properties.securityRules.push({
        name: 'operator-ssh',
        properties: {
          priority: 110,
          direction: 'Inbound',
          access: 'Allow',
          protocol: 'Tcp',
          sourceAddressPrefix: '8.8.8.8/32',
          sourcePortRange: '*',
          destinationAddressPrefix: '*',
          destinationPortRange: '22',
        },
      });
    },
    (t) => {
      find(
        host(t),
        'Microsoft.Network/networkSecurityGroups',
      ).properties.securityRules[0].properties.destinationPortRanges.push(
        '4310',
      );
    },
    (t) => {
      host(t).resources.push({
        type: 'Microsoft.App/managedEnvironments',
        properties: {},
      });
    },
    (t) => {
      find(
        host(t),
        'Microsoft.Compute/virtualMachines',
      ).properties.osProfile.adminPassword = 'forbidden';
    },
  ];
  for (const change of mutations) {
    const altered = structuredClone(template);
    change(altered);
    assert.throws(() => contract(altered));
  }
  assert.equal(VM.size, 'Standard_D2als_v7');
});
