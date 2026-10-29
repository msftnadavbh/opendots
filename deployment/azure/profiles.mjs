import {
  SCOPE,
  TAGS,
  VM,
  GROUP_ID,
  REGISTRY_NAME,
  FOUNDRY_NAME,
  RUN_COMMAND,
  resourceId,
  requirePilot,
} from './scope.mjs';

function freeze(value) {
  for (const child of Object.values(value))
    if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
const account = {
  tenantId: SCOPE.tenantId,
  subscriptionId: SCOPE.subscriptionId,
  principalId: SCOPE.principalId,
};
const sharedServices = {
  resourceGroup: SCOPE.resourceGroup,
  location: SCOPE.location,
  registry: {
    name: REGISTRY_NAME,
    id: resourceId('Microsoft.ContainerRegistry/registries', REGISTRY_NAME),
  },
  foundry: {
    name: FOUNDRY_NAME,
    id: resourceId('Microsoft.CognitiveServices/accounts', FOUNDRY_NAME),
  },
  projectId: resourceId(
    'Microsoft.CognitiveServices/accounts',
    `${FOUNDRY_NAME}/projects/opendots`,
  ),
  modelDeployment: 'dot-chat',
  insightsId: resourceId(
    'Microsoft.Insights/components',
    `appi-opendots-${SCOPE.suffix}`,
  ),
  logsId: resourceId(
    'Microsoft.OperationalInsights/workspaces',
    `log-opendots-${SCOPE.suffix}`,
  ),
};
const targetGroup = `/subscriptions/${SCOPE.subscriptionId}/resourceGroups/rg-opendots-pilot-scus`;
const targetResource = (type, name) => ({
  name,
  type,
  id: `${targetGroup}/providers/${type}/${name}`,
});
const targetVm = targetResource(
  'Microsoft.Compute/virtualMachines',
  'vm-opendots-pilot-scus',
);
const targetVnet = targetResource(
  'Microsoft.Network/virtualNetworks',
  'vnet-opendots-pilot-scus',
);
// UUIDv5(DNS, 'opendots.pilot-scus-v1.model-role'); fixed across retries, never derived from a replacement identity.
const modelRoleName = 'f38e4e56-1acc-5c13-9dc1-d17567962599';
const snapshot = (name, location) => ({
  name,
  location,
  id: `${targetGroup}/providers/Microsoft.Compute/snapshots/${name}`,
});
export const ORIGINAL_PROFILE = freeze({
  id: 'original',
  account: { ...account },
  compute: {
    resourceGroup: SCOPE.resourceGroup,
    groupId: GROUP_ID,
    location: SCOPE.location,
    vm: structuredClone(VM),
  },
  sharedServices: structuredClone(sharedServices),
  sourcePreservation: null,
  artifacts: {
    directory: 'artifacts/azure-pilot',
    shared: 'artifacts/azure-pilot-shared',
  },
  guestBundle: { available: true, version: RUN_COMMAND.version },
});
export const SCUS_PROFILE = freeze({
  id: 'pilot-scus-v1',
  account: { ...account },
  compute: {
    resourceGroup: 'rg-opendots-pilot-scus',
    groupId: targetGroup,
    location: 'southcentralus',
    vm: {
      ...targetVm,
      admin: VM.admin,
      size: VM.size,
      image: structuredClone(VM.image),
      diskControllerType: 'NVMe',
      securityType: 'TrustedLaunch',
    },
    disks: {
      os: targetResource(
        'Microsoft.Compute/disks',
        'disk-opendots-pilot-scus-os',
      ),
      data: targetResource(
        'Microsoft.Compute/disks',
        'disk-opendots-pilot-scus-data',
      ),
      audit: targetResource(
        'Microsoft.Compute/disks',
        'disk-opendots-pilot-scus-os-audit',
      ),
    },
    network: {
      vnet: targetVnet,
      subnet: { name: 'app', id: `${targetVnet.id}/subnets/app` },
      nic: targetResource(
        'Microsoft.Network/networkInterfaces',
        'nic-opendots-pilot-scus',
      ),
      nsg: targetResource(
        'Microsoft.Network/networkSecurityGroups',
        'nsg-opendots-pilot-scus',
      ),
      pip: targetResource(
        'Microsoft.Network/publicIPAddresses',
        'pip-opendots-pilot-scus',
      ),
      dnsLabel: `opendots-${SCOPE.suffix}-scus`,
      addressPrefix: '10.43.0.0/24',
      privateIpv4: '10.43.0.4',
      allocation: 'Static',
      nsgAttachments: ['nic', 'subnet'],
      inboundPorts: ['80', '443'],
    },
  },
  sharedServices: structuredClone(sharedServices),
  modelRole: {
    name: modelRoleName,
    id: `${sharedServices.foundry.id}/providers/Microsoft.Authorization/roleAssignments/${modelRoleName}`,
    scope: sharedServices.foundry.id,
    roleDefinitionId: `/subscriptions/${SCOPE.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`,
  },
  sourcePreservation: {
    profileId: 'original',
    groupId: GROUP_ID,
    resourceGroup: SCOPE.resourceGroup,
    location: SCOPE.location,
    vmId: VM.ids.id,
    osDiskId: VM.ids.osDiskId,
    dataDiskId: VM.ids.dataDiskId,
    fsUuid: 'a18c384f-d8ca-40a5-8a93-18ba8e1890e3',
    osSizeGiB: 30,
    dataSizeGiB: 32,
    sku: 'Standard_LRS',
    archiveFiles: ['vm-state.json', 'vm-parameters.json', 'arm-outputs.json'],
    snapshots: {
      sourceOs: snapshot('snap-opendots-source-os-v1', 'eastus2'),
      sourceData: snapshot('snap-opendots-source-data-v1', 'eastus2'),
      targetOs: snapshot('snap-opendots-scus-os-v1', 'southcentralus'),
      targetData: snapshot('snap-opendots-scus-data-v1', 'southcentralus'),
    },
  },
  stages: {
    group: {
      scope: 'sub',
      deploymentName: 'opendots-scus-group-v1',
      template: 'infra/scus/group.bicep',
    },
    capture: {
      scope: 'group',
      deploymentName: 'opendots-scus-capture-v1',
      template: 'infra/scus/capture.bicep',
    },
    copy: {
      scope: 'group',
      deploymentName: 'opendots-scus-copy-v1',
      template: 'infra/scus/copy.bicep',
    },
    host: {
      scope: 'group',
      deploymentName: 'opendots-scus-host-v1',
      template: 'infra/scus/host.bicep',
    },
    'model-role': {
      scope: 'group',
      resourceGroup: sharedServices.resourceGroup,
      groupId: GROUP_ID,
      deploymentName: 'opendots-scus-model-role-v1',
      template: 'infra/scus/model-role.bicep',
    },
  },
  tags: { ...TAGS, profileId: 'pilot-scus-v1' },
  artifacts: {
    directory: 'artifacts/azure-pilot-scus',
    shared: 'artifacts/azure-pilot-shared',
    hostKey: {
      directory: 'host-key',
      privateFile: 'id_ed25519',
      publicFile: 'id_ed25519.pub',
    },
    hostPublicParameters: 'host-public-parameters.json',
  },
  guestBundle: { available: false, version: 'restore-only-v2' },
});
export const PROFILES = Object.freeze({
  original: ORIGINAL_PROFILE,
  'pilot-scus-v1': SCUS_PROFILE,
});

export function assertProfile(profile) {
  requirePilot(
    profile === ORIGINAL_PROFILE || profile === SCUS_PROFILE,
    'Only canonical fixed pilot profiles are accepted; copied or mutable profile objects are not authority.',
  );
  return profile;
}
export function selectProfile(args) {
  let profile = ORIGINAL_PROFILE;
  if (args[0] === '--profile') {
    requirePilot(
      Object.hasOwn(PROFILES, args[1] ?? ''),
      'Unknown fixed pilot profile.',
    );
    profile = PROFILES[args[1]];
    args = args.slice(2);
  }
  requirePilot(
    !args.some((arg) => arg.startsWith('--profile')),
    'Select exactly one fixed profile before the command; conflicting or late profile selectors are forbidden.',
  );
  return { profile, args };
}
