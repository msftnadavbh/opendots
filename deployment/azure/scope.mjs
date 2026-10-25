import { isIPv4 } from 'node:net';

export const SCOPE = Object.freeze({
  tenantId: '16b3c013-d300-468d-ac64-7eda0820b6d3',
  subscriptionId: '68eab0d1-ab81-4851-b2dd-173dede87582',
  resourceGroup: 'rg-opendots-pilot',
  location: 'eastus2',
  sandboxGroupName: 'sbx-opendots-pilot',
  principalId: 'ad4d1fc5-ea1f-4e76-a56c-934f5b1b52e9',
  dataPlaneEndpoint: 'https://management.eastus2.azuredevcompute.io',
  suffix: '7unu3az5tgmza',
});
export const TAGS = Object.freeze({
  application: 'opendots',
  environment: 'pilot',
  managedBy: 'opendots-pilot-v1',
});
export const GROUP_ID = `/subscriptions/${SCOPE.subscriptionId}/resourceGroups/${SCOPE.resourceGroup}`;
export const DATA_PATH = `${GROUP_ID}/sandboxGroups/${SCOPE.sandboxGroupName}`;
export const TOKEN_NAME = 'opendots-pilot-import';
export const SCOPE_MAP_NAME = 'opendots-pilot-pull';
export const VM = Object.freeze({
  name: 'vm-opendots-pilot',
  admin: 'opendots',
  size: 'Standard_D2als_v7',
  image: {
    publisher: 'Canonical',
    offer: 'ubuntu-24_04-lts',
    sku: 'server',
    version: '24.04.202610160',
  },
  dnsLabel: `opendots-${SCOPE.suffix}`,
  role: `/subscriptions/${SCOPE.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`,
  ids: {
    id: resourceId('Microsoft.Compute/virtualMachines', 'vm-opendots-pilot'),
    dataDiskId: resourceId(
      'Microsoft.Compute/disks',
      'disk-opendots-pilot-data',
    ),
    osDiskId: resourceId('Microsoft.Compute/disks', 'disk-opendots-pilot-os'),
    nicId: resourceId(
      'Microsoft.Network/networkInterfaces',
      'nic-opendots-pilot',
    ),
    nsgId: resourceId(
      'Microsoft.Network/networkSecurityGroups',
      'nsg-opendots-pilot',
    ),
    vnetId: resourceId(
      'Microsoft.Network/virtualNetworks',
      'vnet-opendots-pilot',
    ),
    subnetId: resourceId(
      'Microsoft.Network/virtualNetworks',
      'vnet-opendots-pilot/subnets/app',
    ),
    publicIpId: resourceId(
      'Microsoft.Network/publicIPAddresses',
      'pip-opendots-pilot',
    ),
  },
});
export const REGISTRY_NAME = `odpilot${SCOPE.suffix}`;
export const RUN_COMMAND = Object.freeze({
  name: 'opendots-pilot-management-v1',
  id: `${VM.ids.id}/runCommands/opendots-pilot-management-v1`,
  type: 'Microsoft.Compute/virtualMachines/runCommands',
  api: '2026-04-01',
  version: 'managed-run-command-v1',
  handlerId: `${VM.ids.id}/extensions/RunCommandHandlerLinux`,
  publisher: 'Microsoft.CPlat.Core',
  handlerType: 'RunCommandHandlerLinux',
});
export const FOUNDRY_NAME = `ai-opendots-${SCOPE.suffix}`;
export const MODEL_ENDPOINT = `https://${FOUNDRY_NAME}.openai.azure.com/openai/v1`;
export const PULL_ACTIONS = Object.freeze([
  'repositories/opendots/content/read',
  'repositories/opendots/metadata/read',
]);

export class PilotError extends Error {}
export function requirePilot(condition, message) {
  if (!condition) throw new PilotError(message);
}
export function safeError(error) {
  return error instanceof PilotError
    ? error.message
    : 'Pilot operation failed; provider output suppressed. Check scope, permissions and service health.';
}
export function resourceId(type, name) {
  return `${GROUP_ID}/providers/${type}/${name}`;
}
export function assertAccount(account, principalId) {
  requirePilot(
    account?.id === SCOPE.subscriptionId &&
      account?.tenantId === SCOPE.tenantId &&
      account?.environmentName === 'AzureCloud' &&
      account?.state === 'Enabled' &&
      account?.user?.type === 'user' &&
      principalId === SCOPE.principalId,
    'Azure account does not match the authorized pilot tenant, subscription and deployment user.',
  );
}
export function assertEnvironment(env = process.env) {
  const pinned = {
    AZURE_TENANT_ID: SCOPE.tenantId,
    AZURE_SUBSCRIPTION_ID: SCOPE.subscriptionId,
    AZURE_RESOURCE_GROUP: SCOPE.resourceGroup,
    AZURE_REGION: SCOPE.location,
    AZURE_LOCATION: SCOPE.location,
    AZURE_SANDBOX_GROUP: SCOPE.sandboxGroupName,
    AZURE_SANDBOX_ENDPOINT: SCOPE.dataPlaneEndpoint,
    AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.com',
  };
  requirePilot(
    Object.entries(pinned).every(
      ([key, value]) => !env[key] || env[key] === value,
    ),
    'Environment overrides cannot change the authorized pilot scope.',
  );
  requirePilot(
    !env.AZURE_LOG_LEVEL &&
      !env.AZURE_CORE_LOG_LEVEL &&
      !env.DEBUG &&
      !env.NODE_DEBUG &&
      !env.NODE_DEBUG_NATIVE &&
      env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    'Debug SDK logging and disabled TLS verification are not allowed for pilot operations.',
  );
}
export function assertOwned(resource, expectedId) {
  requirePilot(
    resource?.id?.toLowerCase() === expectedId.toLowerCase() &&
      resource.location?.toLowerCase() === SCOPE.location &&
      Object.entries(TAGS).every(
        ([key, value]) => resource.tags?.[key] === value,
      ),
    'Existing resource has conflicting scope, location or ownership tags; refusing adoption.',
  );
}
export function validateOutputs(raw) {
  const output = raw?.pilot?.value ?? raw;
  requirePilot(
    output && typeof output === 'object',
    'Missing pilot ARM outputs.',
  );
  for (const key of [
    'tenantId',
    'subscriptionId',
    'resourceGroup',
    'location',
    'sandboxGroupName',
    'dataPlaneEndpoint',
  ])
    requirePilot(
      output[key] === SCOPE[key],
      'ARM outputs do not match the fixed pilot scope.',
    );
  const suffix = /^odpilot([a-z0-9]{13})$/.exec(output.registryName ?? '')?.[1];
  requirePilot(suffix === SCOPE.suffix, 'Unexpected pilot registry name.');
  const expected = {
    sandboxGroupId: resourceId(
      'Microsoft.App/sandboxGroups',
      SCOPE.sandboxGroupName,
    ),
    registryId: resourceId(
      'Microsoft.ContainerRegistry/registries',
      output.registryName,
    ),
    registryLoginServer: `${output.registryName}.azurecr.io`,
    scopeMapName: SCOPE_MAP_NAME,
    tokenName: TOKEN_NAME,
    foundryName: `ai-opendots-${suffix}`,
    foundryId: resourceId(
      'Microsoft.CognitiveServices/accounts',
      `ai-opendots-${suffix}`,
    ),
    projectId: resourceId(
      'Microsoft.CognitiveServices/accounts',
      `ai-opendots-${suffix}/projects/opendots`,
    ),
    projectEndpoint: `https://ai-opendots-${suffix}.services.ai.azure.com/api/projects/opendots`,
    modelDeployment: 'dot-chat',
    modelEndpoint: `https://ai-opendots-${suffix}.openai.azure.com/openai/v1`,
    logAnalyticsId: resourceId(
      'Microsoft.OperationalInsights/workspaces',
      `log-opendots-${suffix}`,
    ),
    applicationInsightsId: resourceId(
      'Microsoft.Insights/components',
      `appi-opendots-${suffix}`,
    ),
  };
  for (const [key, value] of Object.entries(expected))
    requirePilot(
      output[key] === value,
      'Conflicting resource ID, name or endpoint in ARM outputs.',
    );
  validateInsightsConnectionString(output.applicationInsightsConnectionString);
  validateIdentity(output.foundryPrincipalId);
  validateIdentity(output.projectPrincipalId);
  requirePilot(
    output.modelAuthMode === 'managed-identity',
    'Only Entra managed-identity model authentication is allowed.',
  );
  requirePilot(
    output.vm?.name === VM.name && output.vm.tenantId === SCOPE.tenantId,
    'Unexpected VM identity or tenant.',
  );
  for (const [key, value] of Object.entries(VM.ids))
    requirePilot(
      output.vm[key] === value,
      'VM resource ID is outside the fixed pilot topology.',
    );
  for (const key of ['uniqueId', 'principalId', 'dataDiskUniqueId'])
    validateIdentity(output.vm[key]);
  validatePublicIpv4(output.vm.ipv4);
  validateFqdn(output.vm.fqdn);
  const rolePrefix = `${output.foundryId}/providers/Microsoft.Authorization/roleAssignments/`;
  requirePilot(
    typeof output.modelRoleAssignmentId === 'string' &&
      output.modelRoleAssignmentId
        .toLowerCase()
        .startsWith(rolePrefix.toLowerCase()) &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        output.modelRoleAssignmentId.slice(rolePrefix.length),
      ),
    'Model role assignment is outside the owned Foundry account.',
  );
  return Object.freeze({ ...output });
}

export function validateIdentity(value) {
  requirePilot(
    typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value),
    'Invalid immutable Azure identity.',
  );
  return value;
}
export function validatePublicIpv4(value) {
  requirePilot(
    typeof value === 'string' && isIPv4(value),
    'A direct public IPv4 address is required.',
  );
  const [a, b, c] = value.split('.').map(Number);
  requirePilot(
    !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    ),
    'Private, reserved and documentation IPv4 addresses are not allowed.',
  );
  return value;
}
export function validateOperatorCidr(value) {
  requirePilot(
    typeof value === 'string' && value.endsWith('/32'),
    'SSH requires exactly one verified public operator IPv4 /32.',
  );
  validatePublicIpv4(value.slice(0, -3));
  return value;
}
export function validateFqdn(value) {
  requirePilot(
    typeof value === 'string' &&
      new RegExp(
        `^${VM.dnsLabel}(?:[.-][a-z0-9]+)?\\.eastus2\\.(?:sysgen\\.)?cloudapp\\.azure\\.com$`,
      ).test(value),
    'Unexpected regional VM DNS name. Bind only the actual owned Public IP FQDN.',
  );
  return value;
}
export function validateInsightsConnectionString(value) {
  requirePilot(
    typeof value === 'string',
    'Missing Application Insights connection string.',
  );
  const entries = value
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index), part.slice(index + 1)];
    });
  const fields = Object.fromEntries(entries);
  requirePilot(
    entries.length === Object.keys(fields).length &&
      Object.keys(fields).every((key) =>
        [
          'InstrumentationKey',
          'IngestionEndpoint',
          'LiveEndpoint',
          'ApplicationId',
        ].includes(key),
      ) &&
      /^[0-9a-f-]{36}$/i.test(fields.InstrumentationKey ?? '') &&
      /^https:\/\/eastus2(?:-[0-9]+)?\.in\.applicationinsights\.azure\.com\/?$/.test(
        fields.IngestionEndpoint ?? '',
      ) &&
      (!fields.LiveEndpoint ||
        /^https:\/\/eastus2(?:\.livediagnostics\.monitor\.azure\.com|\.livemonitor\.azure\.com)\/?$/.test(
          fields.LiveEndpoint,
        )) &&
      (!fields.ApplicationId || /^[0-9a-f-]{36}$/i.test(fields.ApplicationId)),
    'Application Insights endpoint is outside the approved regional service.',
  );
  return value;
}
export function validateImage(image, outputs) {
  const prefix = `${outputs.registryLoginServer}/opendots@sha256:`;
  requirePilot(
    typeof image === 'string' &&
      image.startsWith(prefix) &&
      /^[a-f0-9]{64}$/.test(image.slice(prefix.length)),
    'Image must be the pilot registry opendots repository at an immutable sha256 digest.',
  );
  return image;
}
export function validateDataRequest(value) {
  const url = new URL(value);
  requirePilot(
    url.origin === SCOPE.dataPlaneEndpoint &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.pathname === DATA_PATH ||
        url.pathname.startsWith(`${DATA_PATH}/`)) &&
      !/%|\/\.\.?\//.test(url.pathname),
    'Sandbox request is outside the authorized data-plane group.',
  );
}
export function validatePortUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PilotError('Invalid VM HTTPS origin.');
  }
  requirePilot(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
    'Only a path-free VM HTTPS origin is allowed.',
  );
  validateFqdn(url.hostname);
  return url.origin;
}
export function safeId(value) {
  requirePilot(
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    'Invalid data-plane resource ID.',
  );
  return value;
}
export function selectOwned(items, labels, savedId, key = 'id') {
  requirePilot(
    items.length <= 1,
    'Multiple pilot resources found; manual reconciliation required.',
  );
  if (!items.length) {
    requirePilot(
      !savedId,
      'A saved pilot resource is missing; refusing to recreate persistent state.',
    );
    return undefined;
  }
  const item = items[0];
  requirePilot(
    Object.entries(labels).every(
      ([name, value]) => item.labels?.[name] === value,
    ) &&
      (!savedId || item[key] === savedId),
    'Existing data-plane resource has conflicting ownership, image or configuration; use the manual upgrade runbook.',
  );
  safeId(item[key]);
  return item;
}
