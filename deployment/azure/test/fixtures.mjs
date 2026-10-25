import {
  SCOPE,
  TAGS,
  VM,
  GROUP_ID,
  REGISTRY_NAME,
  FOUNDRY_NAME,
  MODEL_ENDPOINT,
  resourceId,
  SCOPE_MAP_NAME,
  TOKEN_NAME,
} from '../scope.mjs';
import { parametersHash } from '../vm-state.mjs';

const key = Buffer.alloc(51, 7);
key.writeUInt32BE(11, 0);
key.write('ssh-ed25519', 4);
key.writeUInt32BE(32, 15);
export const sshPublicKey = `ssh-ed25519 ${key.toString('base64')}`;
export const parameters = { sshPublicKey, operatorIpv4Cidr: '8.8.8.8/32' };
export const connectionString =
  'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://eastus2-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus2.livediagnostics.monitor.azure.com/;ApplicationId=11111111-1111-1111-1111-111111111111';
export const output = {
  tenantId: SCOPE.tenantId,
  subscriptionId: SCOPE.subscriptionId,
  resourceGroup: SCOPE.resourceGroup,
  location: SCOPE.location,
  sandboxGroupName: SCOPE.sandboxGroupName,
  dataPlaneEndpoint: SCOPE.dataPlaneEndpoint,
  sandboxGroupId: resourceId(
    'Microsoft.App/sandboxGroups',
    SCOPE.sandboxGroupName,
  ),
  registryName: REGISTRY_NAME,
  registryId: resourceId(
    'Microsoft.ContainerRegistry/registries',
    REGISTRY_NAME,
  ),
  registryLoginServer: `${REGISTRY_NAME}.azurecr.io`,
  scopeMapName: SCOPE_MAP_NAME,
  tokenName: TOKEN_NAME,
  foundryName: FOUNDRY_NAME,
  foundryPrincipalId: '88888888-8888-8888-8888-888888888888',
  projectPrincipalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  foundryId: resourceId('Microsoft.CognitiveServices/accounts', FOUNDRY_NAME),
  projectId: resourceId(
    'Microsoft.CognitiveServices/accounts',
    `${FOUNDRY_NAME}/projects/opendots`,
  ),
  projectEndpoint: `https://${FOUNDRY_NAME}.services.ai.azure.com/api/projects/opendots`,
  modelDeployment: 'dot-chat',
  modelEndpoint: MODEL_ENDPOINT,
  modelAuthMode: 'managed-identity',
  logAnalyticsId: resourceId(
    'Microsoft.OperationalInsights/workspaces',
    `log-opendots-${SCOPE.suffix}`,
  ),
  applicationInsightsId: resourceId(
    'Microsoft.Insights/components',
    `appi-opendots-${SCOPE.suffix}`,
  ),
  applicationInsightsConnectionString: connectionString,
  modelRoleAssignmentId: `${resourceId('Microsoft.CognitiveServices/accounts', FOUNDRY_NAME)}/providers/Microsoft.Authorization/roleAssignments/44444444-4444-4444-4444-444444444444`,
  vm: {
    ...VM.ids,
    name: VM.name,
    uniqueId: '11111111-1111-1111-1111-111111111111',
    principalId: '22222222-2222-2222-2222-222222222222',
    tenantId: SCOPE.tenantId,
    dataDiskUniqueId: '33333333-3333-3333-3333-333333333333',
    ipv4: '20.30.40.50',
    fqdn: `${VM.dnsLabel}.abcdef.eastus2.sysgen.cloudapp.azure.com`,
  },
};
export const image = `${output.registryLoginServer}/opendots@sha256:${'a'.repeat(64)}`;
export const origin = `https://${output.vm.fqdn}`;
export const state = {
  version: 2,
  groupId: GROUP_ID,
  operationId: '55555555-5555-5555-5555-555555555555',
  parametersHash: parametersHash(parameters),
  creation: {
    diskId: VM.ids.dataDiskId,
    absentAt: '2026-10-20T12:00:00.000Z',
    uniqueId: output.vm.dataDiskUniqueId,
  },
  seenVmUniqueId: output.vm.uniqueId,
  binding: {
    vmId: VM.ids.id,
    vmUniqueId: output.vm.uniqueId,
    principalId: output.vm.principalId,
    tenantId: SCOPE.tenantId,
    diskId: VM.ids.dataDiskId,
    diskUniqueId: output.vm.dataDiskUniqueId,
    osDiskId: VM.ids.osDiskId,
    osDiskUniqueId: '66666666-6666-6666-6666-666666666666',
    nicId: VM.ids.nicId,
    publicIpId: VM.ids.publicIpId,
    ipv4: output.vm.ipv4,
    fqdn: output.vm.fqdn,
  },
  fsUuid: '77777777-7777-7777-7777-777777777777',
  image,
  hostKey: sshPublicKey,
  provisioned: true,
};
export const account = {
  id: SCOPE.subscriptionId,
  tenantId: SCOPE.tenantId,
  environmentName: 'AzureCloud',
  state: 'Enabled',
  user: { type: 'user' },
};
const owned = (id, properties) => ({
  id,
  location: SCOPE.location,
  tags: { ...TAGS },
  properties,
});

export function vmResources() {
  return {
    vm: {
      ...owned(VM.ids.id, {
        vmId: output.vm.uniqueId,
        provisioningState: 'Succeeded',
        hardwareProfile: { vmSize: VM.size },
        securityProfile: {
          securityType: 'TrustedLaunch',
          uefiSettings: { secureBootEnabled: true, vTpmEnabled: true },
        },
        osProfile: {
          adminUsername: VM.admin,
          linuxConfiguration: {
            disablePasswordAuthentication: true,
            provisionVMAgent: true,
            ssh: {
              publicKeys: [
                {
                  path: '/home/opendots/.ssh/authorized_keys',
                  keyData: sshPublicKey,
                },
              ],
            },
          },
        },
        storageProfile: {
          diskControllerType: 'NVMe',
          imageReference: { ...VM.image },
          osDisk: {
            managedDisk: {
              id: VM.ids.osDiskId,
              storageAccountType: 'StandardSSD_LRS',
            },
            deleteOption: 'Detach',
          },
          dataDisks: [
            {
              lun: 0,
              createOption: 'Attach',
              caching: 'None',
              deleteOption: 'Detach',
              managedDisk: { id: VM.ids.dataDiskId },
            },
          ],
        },
        networkProfile: {
          networkInterfaces: [
            {
              id: VM.ids.nicId,
              properties: { primary: true, deleteOption: 'Detach' },
            },
          ],
        },
      }),
      identity: {
        type: 'SystemAssigned',
        principalId: output.vm.principalId,
        tenantId: SCOPE.tenantId,
      },
    },
    disk: {
      ...owned(VM.ids.dataDiskId, {
        uniqueId: output.vm.dataDiskUniqueId,
        diskSizeGB: 32,
        creationData: { createOption: 'Empty' },
        networkAccessPolicy: 'DenyAll',
        publicNetworkAccess: 'Disabled',
        provisioningState: 'Succeeded',
        timeCreated: '2026-10-20T12:01:00.000Z',
      }),
      sku: { name: 'StandardSSD_LRS' },
      managedBy: VM.ids.id,
    },
    os: {
      ...owned(VM.ids.osDiskId, {
        uniqueId: state.binding.osDiskUniqueId,
        osType: 'Linux',
        hyperVGeneration: 'V2',
        creationData: { createOption: 'FromImage' },
        provisioningState: 'Succeeded',
        timeCreated: '2026-10-20T12:01:00.000Z',
      }),
      sku: { name: 'StandardSSD_LRS' },
      managedBy: VM.ids.id,
      tags: {},
    },
    nic: owned(VM.ids.nicId, {
      enableIPForwarding: false,
      networkSecurityGroup: { id: VM.ids.nsgId },
      ipConfigurations: [
        {
          name: 'primary',
          properties: {
            primary: true,
            privateIPAllocationMethod: 'Dynamic',
            privateIPAddress: '10.42.0.4',
            subnet: { id: VM.ids.subnetId },
            publicIPAddress: { id: VM.ids.publicIpId },
          },
        },
      ],
    }),
    pip: {
      ...owned(VM.ids.publicIpId, {
        publicIPAllocationMethod: 'Static',
        publicIPAddressVersion: 'IPv4',
        ipAddress: output.vm.ipv4,
        dnsSettings: {
          domainNameLabel: VM.dnsLabel,
          domainNameLabelScope: 'ResourceGroupReuse',
          fqdn: output.vm.fqdn,
        },
      }),
      sku: { name: 'Standard' },
    },
    nsg: owned(VM.ids.nsgId, {
      securityRules: [
        ['https-and-acme', 100, 'Allow', 'Tcp', 'Internet', ['80', '443']],
        ['deny-other-inbound', 4096, 'Deny', '*', '*', ['*']],
      ].map(([name, priority, access, protocol, source, ports]) => ({
        name,
        properties: {
          priority,
          direction: 'Inbound',
          access,
          protocol,
          sourceAddressPrefix: source,
          sourcePortRange: '*',
          destinationAddressPrefix: '*',
          destinationPortRanges: ports,
        },
      })),
    }),
    vnet: owned(VM.ids.vnetId, {
      addressSpace: { addressPrefixes: ['10.42.0.0/24'] },
      subnets: [
        {
          name: 'app',
          id: VM.ids.subnetId,
          properties: { addressPrefix: '10.42.0.0/24' },
        },
      ],
    }),
    role: {
      id: output.modelRoleAssignmentId,
      properties: {
        principalId: output.vm.principalId,
        principalType: 'ServicePrincipal',
        roleDefinitionId: VM.role,
        scope: output.foundryId,
      },
    },
  };
}

export function vmAz(resources = vmResources()) {
  const calls = [];
  return {
    calls,
    verify: async () => {},
    read: async (args) => {
      calls.push(args);
      if (args[0] === 'resource' && args[1] === 'list')
        return Object.values(resources).filter((r) => r !== resources.role);
      if (args[0] === 'vm') return [{ code: 'PowerState/running' }];
      const id = args[args.indexOf('--ids') + 1];
      const resource = Object.values(resources).find(
        (value) => value.id === id,
      );
      assertResource(resource);
      return structuredClone(resource);
    },
  };
}
function assertResource(resource) {
  if (!resource) throw new Error('Unexpected fixture resource read');
}
