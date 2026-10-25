import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  SCOPE,
  GROUP_ID,
  PilotError,
  assertAccount,
  assertEnvironment,
  assertOwned,
  requirePilot,
  VM,
  FOUNDRY_NAME,
  REGISTRY_NAME,
  resourceId,
  RUN_COMMAND,
} from './scope.mjs';
import {
  assertKnownManagedCommand,
  assertManagedHandler,
} from './run-command.mjs';

const execute = promisify(execFile);
// Azure CLI rejects get-access-token when tenant and subscription are both supplied.
export const SANDBOX_CREDENTIAL_OPTIONS = Object.freeze({
  subscription: SCOPE.subscriptionId,
  additionallyAllowedTenants: [],
  processTimeoutInMs: 30_000,
});
export function createAz(run = execute) {
  assertEnvironment();
  const read = async (args, { signal, timeoutMs = 20 * 60_000 } = {}) => {
    requirePilot(
      !args.some((arg) =>
        ['--subscription', '--debug', '--verbose', '--output'].includes(arg),
      ),
      'Pilot commands cannot override scope or enable logging.',
    );
    try {
      const { stdout } = await run(
        'az',
        [
          ...args,
          '--subscription',
          SCOPE.subscriptionId,
          '--only-show-errors',
          '--output',
          'json',
        ],
        {
          timeout: timeoutMs,
          signal,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: 'no' },
        },
      );
      return stdout.trim() ? JSON.parse(stdout) : undefined;
    } catch {
      throw new PilotError(
        `Azure CLI ${args.slice(0, 2).join(' ')} failed; stdout/stderr suppressed. Inspect service status and policy without verbose or secret-bearing logs.`,
      );
    }
  };
  const verify = async (options) => {
    const account = await read(['account', 'show'], options);
    const principal = await read(
      [
        'rest',
        '--method',
        'get',
        '--url',
        'https://graph.microsoft.com/v1.0/me?$select=id',
        '--resource',
        'https://graph.microsoft.com/',
        '--query',
        'id',
      ],
      options,
    );
    assertAccount(account, principal);
  };
  return {
    read,
    verify,
    write: async (args) => {
      await verify();
      return read(args);
    },
  };
}

export async function inspectGroupBeforeDeployment(az, state) {
  await az.verify();
  if (!(await az.read(['group', 'exists', '--name', SCOPE.resourceGroup])))
    return false;
  assertOwned(
    await az.read(['group', 'show', '--name', SCOPE.resourceGroup]),
    GROUP_ID,
  );
  const resources = await az.read([
    'resource',
    'list',
    '--resource-group',
    SCOPE.resourceGroup,
  ]);
  const ownedIds = [
    resourceId('Microsoft.App/sandboxGroups', SCOPE.sandboxGroupName),
    resourceId('Microsoft.ContainerRegistry/registries', REGISTRY_NAME),
    resourceId('Microsoft.CognitiveServices/accounts', FOUNDRY_NAME),
    resourceId(
      'Microsoft.CognitiveServices/accounts',
      `${FOUNDRY_NAME}/projects/opendots`,
    ),
    resourceId(
      'Microsoft.Insights/components',
      `appi-opendots-${SCOPE.suffix}`,
    ),
    resourceId(
      'Microsoft.OperationalInsights/workspaces',
      `log-opendots-${SCOPE.suffix}`,
    ),
    ...Object.values(VM.ids).filter(
      (id) => id !== VM.ids.osDiskId && id !== VM.ids.subnetId,
    ),
  ].map((id) => id.toLowerCase());
  const childParents = new Map(
    [
      [
        `${resourceId('Microsoft.ContainerRegistry/registries', REGISTRY_NAME)}/scopeMaps/opendots-pilot-pull`,
        resourceId('Microsoft.ContainerRegistry/registries', REGISTRY_NAME),
      ],
      [
        `${resourceId('Microsoft.ContainerRegistry/registries', REGISTRY_NAME)}/tokens/opendots-pilot-import`,
        resourceId('Microsoft.ContainerRegistry/registries', REGISTRY_NAME),
      ],
      [
        `${resourceId('Microsoft.CognitiveServices/accounts', FOUNDRY_NAME)}/deployments/dot-chat`,
        resourceId('Microsoft.CognitiveServices/accounts', FOUNDRY_NAME),
      ],
      [VM.ids.subnetId, VM.ids.vnetId],
    ].map(([id, parent]) => [id.toLowerCase(), parent]),
  );
  let vm;
  const ownedVm = async () => {
    vm ??= await readResource(az, VM.ids.id, '2025-11-01');
    assertOwned(vm, VM.ids.id);
    return vm;
  };
  for (const resource of resources) {
    const id = resource.id?.toLowerCase();
    if (
      ['opendots-pilot-resources', 'opendots-pilot-vm'].some(
        (name) =>
          id ===
          resourceId('Microsoft.Resources/deployments', name).toLowerCase(),
      )
    )
      continue;
    if (id === VM.ids.osDiskId.toLowerCase()) {
      const host = await ownedVm();
      const disk = await readResource(az, VM.ids.osDiskId, '2025-01-02');
      assertOsDisk(disk, host);
      continue;
    }
    if (id === `${VM.ids.id}/extensions/RunCommandLinux`.toLowerCase()) {
      await ownedVm();
      const extension = await readResource(az, resource.id, '2025-11-01');
      requirePilot(
        extension.properties?.publisher === 'Microsoft.CPlat.Core' &&
          extension.properties?.type === 'RunCommandLinux',
        'Unexpected VM extension; no broad extension adoption is allowed.',
      );
      continue;
    }
    if (id === RUN_COMMAND.id.toLowerCase()) {
      const host = await ownedVm();
      requirePilot(
        host.properties?.vmId === state?.binding?.vmUniqueId,
        'Managed resource VM binding changed; refusing adoption.',
      );
      assertKnownManagedCommand(
        await readResource(az, RUN_COMMAND.id, RUN_COMMAND.api),
        state,
      );
      continue;
    }
    if (id === RUN_COMMAND.handlerId.toLowerCase()) {
      await ownedVm();
      requirePilot(
        state?.management?.resourceId === RUN_COMMAND.id &&
          (state.management.pending || state.management.receipt),
        'Untracked managed handler; review provenance before permitting this exact VM child.',
      );
      assertManagedHandler(
        await readResource(az, RUN_COMMAND.handlerId, RUN_COMMAND.api),
      );
      continue;
    }
    if (childParents.has(id)) {
      const parentId = childParents.get(id);
      const parent = resources.find(
        (item) => item.id.toLowerCase() === parentId.toLowerCase(),
      );
      requirePilot(parent, 'Child resource has no owned pilot parent.');
      assertOwned(parent, parentId);
      continue;
    }
    requirePilot(
      ownedIds.includes(id),
      'Unexpected resource in the pilot group; refusing to adopt or overwrite it.',
    );
    assertOwned(resource, resource.id);
  }
  return true;
}

export async function verifyLiveResources(az, output) {
  requirePilot(
    output.modelAuthMode === 'managed-identity',
    'Model authentication must remain managed-identity.',
  );
  await az.verify();
  assertOwned(
    await az.read(['group', 'show', '--name', SCOPE.resourceGroup]),
    GROUP_ID,
  );
  const resources = [
    [output.sandboxGroupId, '2026-07-01'],
    [output.registryId, '2025-11-01'],
    [output.foundryId, '2025-06-01'],
    [output.applicationInsightsId, '2020-02-02'],
    [output.logAnalyticsId, '2025-07-01'],
  ];
  const live = [];
  for (const [id, api] of resources) {
    const resource = await az.read([
      'resource',
      'show',
      '--ids',
      id,
      '--api-version',
      api,
    ]);
    assertOwned(resource, id);
    live.push(resource);
  }
  requirePilot(
    live[1].properties.adminUserEnabled === false &&
      live[1].properties.anonymousPullEnabled !== true &&
      live[1].properties.loginServer === output.registryLoginServer,
    'Registry must remain private with admin access disabled.',
  );
  requirePilot(
    live[2].kind === 'AIServices' &&
      live[2].identity?.type === 'SystemAssigned' &&
      live[2].identity.tenantId === SCOPE.tenantId &&
      live[2].identity.principalId === output.foundryPrincipalId &&
      live[2].properties.provisioningState === 'Succeeded' &&
      live[2].properties.customSubDomainName === output.foundryName &&
      live[2].properties.allowProjectManagement === true &&
      live[2].properties.disableLocalAuth === true,
    'Foundry account does not match the pilot configuration.',
  );
  const deploymentId = `${output.foundryId}/deployments/${output.modelDeployment}`;
  const deployment = await az.read([
    'resource',
    'show',
    '--ids',
    deploymentId,
    '--api-version',
    '2025-06-01',
  ]);
  requirePilot(
    deployment.id?.toLowerCase() === deploymentId.toLowerCase() &&
      deployment.properties?.provisioningState === 'Succeeded' &&
      deployment.properties?.model?.format === 'OpenAI' &&
      deployment.properties?.model?.name === 'gpt-5.4-mini' &&
      deployment.properties?.model?.version === '2026-03-17' &&
      deployment.properties?.raiPolicyName === 'Microsoft.DefaultV2' &&
      deployment.sku?.name === 'GlobalStandard' &&
      deployment.sku?.capacity === 50,
    'The approved Foundry model deployment is not ready or its configuration differs.',
  );
  requirePilot(
    live[3].properties.ConnectionString ===
      output.applicationInsightsConnectionString,
    'Application Insights connection string does not match the live owned resource.',
  );
  const project = await readResource(az, output.projectId, '2025-06-01');
  assertOwned(project, output.projectId);
  requirePilot(
    project.properties?.provisioningState === 'Succeeded' &&
      project.identity?.type === 'SystemAssigned' &&
      project.identity.tenantId === SCOPE.tenantId &&
      project.identity.principalId === output.projectPrincipalId,
    'Foundry project is not ready.',
  );
}

export async function effectivePolicies(az, scope) {
  requirePilot(
    [
      `/subscriptions/${SCOPE.subscriptionId}`,
      GROUP_ID,
      resourceId('Microsoft.ContainerRegistry/registries', REGISTRY_NAME),
    ].includes(scope),
    'Policy inspection must remain within the approved pilot scope.',
  );
  const endpoint = `https://management.azure.com${scope}/providers/Microsoft.Authorization/policyAssignments`;
  let url = `${endpoint}?api-version=2023-04-01&$filter=atScope()`;
  const visited = new Set(),
    assignments = [];
  while (url) {
    const parsed = new URL(url);
    requirePilot(
      parsed.origin === 'https://management.azure.com' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash &&
        parsed.pathname.toLowerCase() ===
          new URL(endpoint).pathname.toLowerCase() &&
        !visited.has(url) &&
        visited.size < 100,
      'Policy pagination escaped its fixed ARM endpoint or repeated.',
    );
    visited.add(url);
    const page = await az.read(['rest', '--method', 'get', '--url', url]);
    requirePilot(
      Array.isArray(page?.value),
      'Invalid policy assignment response.',
    );
    assignments.push(
      ...page.value.map((item) => ({
        ...item.properties,
        id: item.id,
        name: item.name,
      })),
    );
    url = page.nextLink;
  }
  return assignments;
}

// CLI listing omitted inherited assignments here; the explicit ARM atScope() query includes them.
export async function inspectTokenPolicy(az, registryId) {
  const tokenPolicy =
    '/providers/Microsoft.Authorization/policyDefinitions/ff05e24e-195c-447e-b322-5e90c9f9f366';
  const assignments = await effectivePolicies(az, registryId);
  for (const assignment of assignments) {
    if (
      assignment.enforcementMode === 'DoNotEnforce' ||
      assignment.notScopes?.some(
        (scope) =>
          registryId.toLowerCase() === scope.toLowerCase() ||
          registryId.toLowerCase().startsWith(scope.toLowerCase() + '/'),
      )
    )
      continue;
    const id = assignment.policyDefinitionId;
    requirePilot(
      typeof id === 'string' &&
        /^\/[A-Za-z0-9_./-]+$/.test(id) &&
        !id.includes('..'),
      'Invalid policy definition ID.',
    );
    const definition = await az.read([
      'rest',
      '--method',
      'get',
      '--url',
      `https://management.azure.com${id}?api-version=2023-04-01`,
    ]);
    const value = (parameter) => {
      const reference = /^\[parameters\('([^']+)'\)\]$/.exec(parameter ?? '');
      return reference
        ? (assignment.parameters?.[reference[1]]?.value ??
            definition.properties.parameters?.[reference[1]]?.defaultValue)
        : parameter;
    };
    if (id.toLowerCase() === tokenPolicy.toLowerCase())
      requirePilot(
        String(
          assignment.parameters?.effect?.value ??
            definition.properties.parameters?.effect?.defaultValue,
        ).toLowerCase() !== 'deny',
        'Azure Policy denies repository-scoped tokens. Stop; do not create an exemption or change the policy.',
      );
    for (const member of definition.properties.policyDefinitions ?? [])
      if (member.policyDefinitionId.toLowerCase() === tokenPolicy.toLowerCase())
        requirePilot(
          String(
            value(member.parameters?.effect?.value) ?? 'Audit',
          ).toLowerCase() !== 'deny',
          'An Azure Policy initiative denies repository-scoped tokens. Stop; do not override it.',
        );
  }
}

export function readResource(az, id, api) {
  requirePilot(
    typeof id === 'string' &&
      id.toLowerCase().startsWith(`${GROUP_ID}/providers/`.toLowerCase()) &&
      !/[?#%\s]/.test(id) &&
      !id.includes('..'),
    'Resource read is outside the pilot group.',
  );
  return az.read(['resource', 'show', '--ids', id, '--api-version', api]);
}
export function assertOsDisk(disk, vm) {
  requirePilot(
    disk.id?.toLowerCase() === VM.ids.osDiskId.toLowerCase() &&
      disk.location?.toLowerCase() === SCOPE.location &&
      disk.managedBy?.toLowerCase() === VM.ids.id.toLowerCase() &&
      disk.sku?.name === 'StandardSSD_LRS' &&
      disk.properties?.osType === 'Linux' &&
      vm.properties?.storageProfile?.osDisk?.managedDisk?.id?.toLowerCase() ===
        VM.ids.osDiskId.toLowerCase(),
    'OS disk is not the exact attached pilot OS disk.',
  );
  if (Object.keys(disk.tags ?? {}).length) assertOwned(disk, VM.ids.osDiskId);
}
