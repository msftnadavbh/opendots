import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import {
  SCOPE,
  GROUP_ID,
  PilotError,
  assertAccount,
  assertEnvironment,
  assertAccountEnvironment,
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
import { ORIGINAL_PROFILE, SCUS_PROFILE, assertProfile } from './profiles.mjs';

const execute = promisify(execFile);
// Azure CLI rejects get-access-token when tenant and subscription are both supplied.
export const SANDBOX_CREDENTIAL_OPTIONS = Object.freeze({
  subscription: SCOPE.subscriptionId,
  additionallyAllowedTenants: [],
  processTimeoutInMs: 30_000,
});
export function assertProfileEnvironment(profile, env = process.env) {
  assertProfile(profile);
  if (profile === ORIGINAL_PROFILE) return assertEnvironment(env);
  assertAccountEnvironment(env);
  const pinned = {
    AZURE_RESOURCE_GROUP: profile.compute.resourceGroup,
    AZURE_REGION: profile.compute.location,
    AZURE_LOCATION: profile.compute.location,
  };
  requirePilot(
    Object.entries(pinned).every(
      ([key, value]) => !env[key] || env[key] === value,
    ),
    'Environment conflicts with the explicitly selected compute profile; environment variables cannot select a profile.',
  );
}

export function createAz(run = execute, profile = ORIGINAL_PROFILE) {
  assertProfileEnvironment(profile);
  const principalArgs = [
    'rest',
    '--method',
    'get',
    '--url',
    'https://graph.microsoft.com/v1.0/me?$select=id',
    '--resource',
    'https://graph.microsoft.com/',
    '--query',
    'id',
  ];
  const allowed = (args, writing) => {
    if (profile === ORIGINAL_PROFILE) return;
    const stage = Object.entries(profile.stages).find(
      ([, value]) =>
        args[0] === 'deployment' &&
        args[1] === value.scope &&
        args[args.indexOf('--name') + 1] === value.deploymentName,
    );
    if (writing) {
      requirePilot(
        stage && ['validate', 'what-if', 'create'].includes(args[2]),
        'Target client has no VM/disk/delete/export/token or arbitrary write capability.',
      );
      const [key, value] = stage;
      const prefix = [
        'deployment',
        value.scope,
        args[2],
        '--name',
        value.deploymentName,
        ...(value.scope === 'group'
          ? [
              '--resource-group',
              profile.compute.resourceGroup,
              '--mode',
              'Incremental',
            ]
          : ['--location', profile.compute.location]),
      ];
      const template = args[args.indexOf('--template-file') + 1];
      const parameters = args[args.indexOf('--parameters') + 1];
      requirePilot(
        new RegExp(
          `^/proc/${process.pid}/fd/[0-9]+/${key}-template\\.json$`,
        ).test(template ?? '') &&
          parameters ===
            '@' + template.replace('-template.json', '-parameters.json') &&
          isDeepStrictEqual(args, [
            ...prefix,
            '--template-file',
            template,
            '--parameters',
            parameters,
            ...(args[2] === 'create'
              ? ['--no-wait']
              : [
                  '--validation-level',
                  'Provider',
                  ...(args[2] === 'what-if'
                    ? [
                        '--result-format',
                        'FullResourcePayloads',
                        '--no-pretty-print',
                      ]
                    : []),
                ]),
          ]),
        'Target request escaped its fixed stage, incremental mode, private request files or provider validation.',
      );
      return;
    }
    const reads = [
      ['account', 'show'],
      principalArgs,
      ...['exists', 'show'].map((action) => [
        'group',
        action,
        '--name',
        profile.compute.resourceGroup,
      ]),
      ...[
        profile.compute.resourceGroup,
        profile.sourcePreservation.resourceGroup,
      ].map((group) => [
        'resource',
        'list',
        '--resource-group',
        group,
        '--query',
        '[].{id:id,type:type,location:location,tags:tags}',
      ]),
      [
        'vm',
        'get-instance-view',
        '--ids',
        profile.sourcePreservation.vmId,
        '--query',
        'instanceView.statuses',
      ],
      ...[
        profile.sourcePreservation.vmId,
        profile.sourcePreservation.osDiskId,
        profile.sourcePreservation.dataDiskId,
        ...Object.values(profile.sourcePreservation.snapshots).map(
          (item) => item.id,
        ),
      ].map((id) => [
        'resource',
        'show',
        '--ids',
        id,
        '--api-version',
        id === profile.sourcePreservation.vmId ? '2025-11-01' : '2025-01-02',
      ]),
      ...Object.values(profile.stages).flatMap((value) => [
        [
          'deployment',
          value.scope,
          'list',
          ...(value.scope === 'group'
            ? ['--resource-group', profile.compute.resourceGroup]
            : []),
          '--query',
          `[?name=='${value.deploymentName}'].id`,
        ],
        [
          'deployment',
          value.scope,
          'show',
          '--name',
          value.deploymentName,
          ...(value.scope === 'group'
            ? ['--resource-group', profile.compute.resourceGroup]
            : []),
        ],
      ]),
    ];
    requirePilot(
      reads.some((expected) => isDeepStrictEqual(args, expected)),
      'Target client permits only fixed account/source/preservation GETs; no arbitrary read or mutation through read().',
    );
  };
  const prepare = (
    args,
    options = {},
    writing = false,
    environment = process.env,
  ) => {
    if (profile === SCUS_PROFILE) {
      requirePilot(
        Array.isArray(args) && args.every((arg) => typeof arg === 'string'),
        'Target command arguments must be an exact string array.',
      );
      requirePilot(
        options &&
          typeof options === 'object' &&
          !Array.isArray(options) &&
          Reflect.ownKeys(options).every((key) =>
            ['signal', 'timeoutMs'].includes(key),
          ),
        'Target command options are limited to signal and timeoutMs.',
      );
    }
    args = Object.freeze([...args]);
    const { signal, timeoutMs = 20 * 60_000 } = options;
    const env = Object.freeze({
      ...environment,
      AZURE_CORE_COLLECT_TELEMETRY: 'no',
    });
    if (profile === SCUS_PROFILE) {
      requirePilot(
        (signal === undefined || signal instanceof AbortSignal) &&
          Number.isInteger(timeoutMs) &&
          timeoutMs >= 0 &&
          timeoutMs <= 2_147_483_647,
        'Target command signal or timeout is invalid.',
      );
      assertProfileEnvironment(profile, env);
    }
    allowed(args, writing);
    requirePilot(
      !args.some((arg) =>
        ['--subscription', '--debug', '--verbose', '--output'].includes(arg),
      ),
      'Pilot commands cannot override scope or enable logging.',
    );
    return Object.freeze({
      args: Object.freeze([
        ...args,
        '--subscription',
        SCOPE.subscriptionId,
        '--only-show-errors',
        '--output',
        'json',
      ]),
      options: Object.freeze({
        timeout: timeoutMs,
        signal,
        maxBuffer: 8 * 1024 * 1024,
        env,
      }),
    });
  };
  const invoke = async ({ args, options }) => {
    try {
      const { stdout } = await run('az', args, options);
      return stdout.trim() ? JSON.parse(stdout) : undefined;
    } catch {
      throw new PilotError(
        `Azure CLI ${args.slice(0, 2).join(' ')} failed; stdout/stderr suppressed. Inspect service status and policy without verbose or secret-bearing logs.`,
      );
    }
  };
  const read = async (args, options) => invoke(prepare(args, options));
  const verify = async (options) => {
    const account = await read(['account', 'show'], options);
    const principal = await read(principalArgs, options);
    assertAccount(account, principal);
  };
  const verifyPrepared = async ({ options }) => {
    const authOptions = { signal: options.signal, timeoutMs: options.timeout };
    const account = prepare(
      ['account', 'show'],
      authOptions,
      false,
      options.env,
    );
    const principal = prepare(principalArgs, authOptions, false, options.env);
    assertAccount(await invoke(account), await invoke(principal));
  };
  const client = {
    read,
    verify,
    write: async (args, options) => {
      if (profile === ORIGINAL_PROFILE) {
        await verify(options);
        return read(args, options);
      }
      const invocation = prepare(args, options, true);
      requirePilot(
        invocation.args[2] !== 'create',
        'Target create requires the internal durable-intent callback; write() permits only validate/what-if.',
      );
      await verifyPrepared(invocation);
      return invoke(invocation);
    },
  };
  if (profile === SCUS_PROFILE)
    client.createWithIntent = async (args, persistIntent, options) => {
      requirePilot(
        typeof persistIntent === 'function',
        'Target create requires an internal durable-intent callback.',
      );
      const invocation = prepare(args, options, true);
      requirePilot(
        invocation.args[2] === 'create',
        'The intent callback is only for the exact stage CREATE.',
      );
      await verifyPrepared(invocation);
      await persistIntent();
      return invoke(invocation); // No authentication or mutable request preparation after durable intent.
    };
  Object.defineProperty(client, 'profile', {
    value: profile,
    enumerable: true,
  });
  return client;
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
  await inspectOwnedInventory(az, resources, state);
  return true;
}

export async function inspectOwnedInventory(az, resources, state) {
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
  assertOsDiskAttachment(disk, vm);
  requirePilot(
    disk.sku?.name === 'StandardSSD_LRS',
    'OS disk is not the exact attached pilot OS disk.',
  );
}

export function assertOsDiskAttachment(disk, vm) {
  requirePilot(
    disk.id?.toLowerCase() === VM.ids.osDiskId.toLowerCase() &&
      disk.location?.toLowerCase() === SCOPE.location &&
      disk.managedBy?.toLowerCase() === VM.ids.id.toLowerCase() &&
      disk.properties?.osType === 'Linux' &&
      vm.properties?.storageProfile?.osDisk?.managedDisk?.id?.toLowerCase() ===
        VM.ids.osDiskId.toLowerCase(),
    'OS disk is not the exact attached pilot OS disk.',
  );
  if (Object.keys(disk.tags ?? {}).length) assertOwned(disk, VM.ids.osDiskId);
}
