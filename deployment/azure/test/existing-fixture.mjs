import assert from 'node:assert/strict';
import { SCOPE, TAGS, GROUP_ID, VM, PULL_ACTIONS } from '../scope.mjs';
import { INITIAL_IMAGE } from '../initial-activation.mjs';
import {
  GOVERNANCE_NSG_ID,
  reconcileExistingPilot,
} from '../existing-pilot.mjs';
import { state, vmResources, output, parameters } from './fixtures.mjs';

export function existingFixture() {
  const f = {
    state: {
      ...structuredClone(state),
      image: INITIAL_IMAGE,
      provisioned: false,
      configured: false,
      pins: structuredClone(state.binding),
      seenResourceIds: Object.values(VM.ids).filter(
        (id) => id !== VM.ids.subnetId,
      ),
      modelRoleAssignmentId: output.modelRoleAssignmentId,
      foundryPrincipalId: output.foundryPrincipalId,
      projectPrincipalId: output.projectPrincipalId,
    },
    resources: vmResources(),
    saved: [],
    calls: [],
    power: 'PowerState/running',
  };
  const r = f.resources;
  r.vm.properties.storageProfile.osDisk.managedDisk.storageAccountType =
    'Standard_LRS';
  r.disk.sku.name = r.os.sku.name = 'Standard_LRS';
  r.disk.tags = {};
  r.nic.properties.virtualMachine = { id: VM.ids.id };
  r.vnet.properties.subnets[0].properties.networkSecurityGroup = {
    id: GOVERNANCE_NSG_ID,
  };
  const rule = (name, priority, direction, access, source, destination) => ({
    name,
    properties: {
      priority,
      direction,
      access,
      protocol: '*',
      sourceAddressPrefix: source,
      sourcePortRange: '*',
      destinationAddressPrefix: destination,
      destinationPortRange: '*',
      provisioningState: 'Succeeded',
    },
  });
  r.governance = {
    id: GOVERNANCE_NSG_ID,
    location: SCOPE.location,
    type: 'Microsoft.Network/networkSecurityGroups',
    tags: { ...TAGS },
    properties: {
      provisioningState: 'Succeeded',
      resourceGuid: 'ea14dfd0-7317-47a2-bd0d-0c3271f4d50d',
      subnets: [{ id: VM.ids.subnetId }],
      networkInterfaces: [],
      securityRules: [
        {
          name: 'opendots-web',
          id: `${GOVERNANCE_NSG_ID}/securityRules/opendots-web`,
          properties: {
            priority: 100,
            direction: 'Inbound',
            access: 'Allow',
            protocol: 'Tcp',
            sourceAddressPrefix: 'Internet',
            sourcePortRange: '*',
            destinationAddressPrefix: '10.42.0.4/32',
            destinationPortRanges: ['80', '443'],
            provisioningState: 'Succeeded',
          },
        },
      ],
      defaultSecurityRules: [
        rule(
          'AllowVnetInBound',
          65000,
          'Inbound',
          'Allow',
          'VirtualNetwork',
          'VirtualNetwork',
        ),
        rule(
          'AllowAzureLoadBalancerInBound',
          65001,
          'Inbound',
          'Allow',
          'AzureLoadBalancer',
          '*',
        ),
        rule('DenyAllInBound', 65500, 'Inbound', 'Deny', '*', '*'),
        rule(
          'AllowVnetOutBound',
          65000,
          'Outbound',
          'Allow',
          'VirtualNetwork',
          'VirtualNetwork',
        ),
        rule(
          'AllowInternetOutBound',
          65001,
          'Outbound',
          'Allow',
          '*',
          'Internet',
        ),
        rule('DenyAllOutBound', 65500, 'Outbound', 'Deny', '*', '*'),
      ],
    },
  };
  const owned = (id, properties = {}) => ({
    id,
    location: SCOPE.location,
    tags: { ...TAGS },
    properties,
  });
  r.sandbox = owned(output.sandboxGroupId);
  r.registry = owned(output.registryId, {
    adminUserEnabled: false,
    anonymousPullEnabled: false,
    loginServer: output.registryLoginServer,
  });
  r.foundry = {
    ...owned(output.foundryId, {
      provisioningState: 'Succeeded',
      customSubDomainName: output.foundryName,
      allowProjectManagement: true,
      disableLocalAuth: true,
    }),
    kind: 'AIServices',
    identity: {
      type: 'SystemAssigned',
      tenantId: SCOPE.tenantId,
      principalId: output.foundryPrincipalId,
    },
  };
  r.project = {
    ...owned(output.projectId, { provisioningState: 'Succeeded' }),
    identity: {
      type: 'SystemAssigned',
      tenantId: SCOPE.tenantId,
      principalId: output.projectPrincipalId,
    },
  };
  r.model = {
    id: `${output.foundryId}/deployments/${output.modelDeployment}`,
    properties: {
      provisioningState: 'Succeeded',
      model: { format: 'OpenAI', name: 'gpt-5.4-mini', version: '2026-03-17' },
      raiPolicyName: 'Microsoft.DefaultV2',
    },
    sku: { name: 'GlobalStandard', capacity: 50 },
  };
  r.insights = owned(output.applicationInsightsId, {
    ConnectionString: output.applicationInsightsConnectionString,
  });
  r.logs = owned(output.logAnalyticsId);
  f.az = {
    verify: async () => {
      f.calls.push('verify');
    },
    write: () =>
      assert.fail(
        'Existing reconciliation/diagnostics must never write ARM, power, network or tokens',
      ),
    read: async (args) => {
      f.calls.push(args);
      if (args[0] === 'group')
        return args[1] === 'exists' ? true : owned(GROUP_ID);
      if (args[0] === 'vm') return [{ code: f.power }];
      if (args[0] === 'acr') {
        const scopeMapId = `${output.registryId}/scopeMaps/${output.scopeMapName}`;
        return args[1] === 'token'
          ? {
              status: 'disabled',
              scopeMapId,
              credentials: { passwords: [], certificates: [] },
            }
          : { id: scopeMapId, actions: [...PULL_ACTIONS] };
      }
      if (args[1] === 'list')
        return structuredClone(
          f.inventory ?? Object.values(r).filter((item) => item !== r.role),
        );
      assert.equal(args[0], 'resource');
      assert.equal(args[1], 'show');
      const id = args[args.indexOf('--ids') + 1];
      const resource =
        Object.values(r).find((item) => item.id === id) ??
        r.governance.properties.securityRules.find((item) => item.id === id);
      assert(resource, `Unexpected fixture resource read: ${id}`);
      return structuredClone(resource);
    },
  };
  f.save = async (next) => {
    f.saved.push(structuredClone(next));
    f.durable = structuredClone(next);
  };
  f.reconcile = async () => {
    const verified = await reconcileExistingPilot(
      f.az,
      output,
      parameters,
      f.state,
      f.save,
    );
    f.state = verified.state;
    return verified;
  };
  return f;
}
