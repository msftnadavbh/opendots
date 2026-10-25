import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE,
  TAGS,
  GROUP_ID,
  resourceId,
  DATA_PATH,
  assertAccount,
  assertEnvironment,
  assertOwned,
  safeError,
  VM,
  validateOperatorCidr,
  validateDataRequest,
  validateImage,
  validateOutputs,
  validatePortUrl,
} from '../scope.mjs';
import {
  createAz,
  inspectTokenPolicy,
  inspectGroupBeforeDeployment,
  SANDBOX_CREDENTIAL_OPTIONS,
  verifyLiveResources,
  effectivePolicies,
} from '../cloud.mjs';
import { account, image, origin, output } from './fixtures.mjs';

test('copied pilot tags never authorize adoption of a governance-created subnet NSG', async () => {
  const extra = {
    id: resourceId(
      'Microsoft.Network/networkSecurityGroups',
      'vnet-opendots-pilot-app-nsg-eastus2',
    ),
    location: SCOPE.location,
    tags: TAGS,
    type: 'Microsoft.Network/networkSecurityGroups',
  };
  assertOwned(extra, extra.id);
  const az = {
    verify: async () => {},
    write: () =>
      assert.fail('Unexpected controls must never cause an Azure write'),
    read: async (args) => {
      if (args[0] === 'group')
        return args[1] === 'exists'
          ? true
          : { id: GROUP_ID, location: SCOPE.location, tags: TAGS };
      assert.deepEqual(args, [
        'resource',
        'list',
        '--resource-group',
        SCOPE.resourceGroup,
      ]);
      return [extra];
    },
  };
  await assert.rejects(inspectGroupBeforeDeployment(az), /Unexpected resource/);
});

test('pins account, tenant, subscription and user without accepting environment broadening', () => {
  assertAccount(account, SCOPE.principalId);
  for (const key of ['id', 'tenantId', 'environmentName', 'state'])
    assert.throws(() =>
      assertAccount({ ...account, [key]: 'foreign' }, SCOPE.principalId),
    );
  assert.throws(() => assertAccount(account, 'foreign'));
  assertEnvironment({ AZURE_SUBSCRIPTION_ID: SCOPE.subscriptionId });
  for (const key of [
    'AZURE_SUBSCRIPTION_ID',
    'AZURE_TENANT_ID',
    'AZURE_REGION',
    'AZURE_RESOURCE_GROUP',
    'AZURE_SANDBOX_ENDPOINT',
  ])
    assert.throws(() => assertEnvironment({ [key]: 'foreign' }));
  for (const key of [
    'DEBUG',
    'NODE_DEBUG',
    'NODE_DEBUG_NATIVE',
    'AZURE_LOG_LEVEL',
    'AZURE_CORE_LOG_LEVEL',
  ])
    assert.throws(() => assertEnvironment({ [key]: 'http' }));
});
test('validates exact ARM resource IDs, group, endpoints and immutable image digests', () => {
  assert.deepEqual(validateOutputs({ pilot: { value: output } }), output);
  for (const key of [
    'tenantId',
    'subscriptionId',
    'resourceGroup',
    'location',
    'sandboxGroupName',
    'sandboxGroupId',
    'registryId',
    'modelEndpoint',
    'projectId',
    'dataPlaneEndpoint',
  ])
    assert.throws(() => validateOutputs({ ...output, [key]: 'foreign' }));
  for (const key of Object.keys(VM.ids))
    assert.throws(() =>
      validateOutputs({ ...output, vm: { ...output.vm, [key]: 'foreign' } }),
    );
  assert.throws(() => validateOutputs({ ...output, modelAuthMode: 'api-key' }));
  assert.equal(validateImage(image, output), image);
  for (const value of [
    image.replace('opendots@', 'other@'),
    image.replace('sha256:', ''),
    image.replace('@sha256:' + 'a'.repeat(64), ':latest'),
    image.replace('.azurecr.io', '.evil.example'),
  ])
    assert.throws(() => validateImage(value, output));
  assert.throws(() =>
    validateOutputs({
      ...output,
      applicationInsightsConnectionString:
        output.applicationInsightsConnectionString.replace(
          'eastus2-8.in.applicationinsights.azure.com',
          'evil.example',
        ),
    }),
  );
});
test('data-plane paths and ingress origins cannot escape the approved service and group', () => {
  validateDataRequest(
    SCOPE.dataPlaneEndpoint +
      DATA_PATH +
      '/sandboxes?api-version=2026-02-01-preview',
  );
  for (const url of [
    SCOPE.dataPlaneEndpoint +
      DATA_PATH.replace('sbx-opendots-pilot', 'foreign'),
    SCOPE.dataPlaneEndpoint.replace('eastus2', 'westus') + DATA_PATH,
    'https://evil.example' + DATA_PATH,
    SCOPE.dataPlaneEndpoint + DATA_PATH + '/%2e%2e/secrets',
  ])
    assert.throws(() => validateDataRequest(url));
  assert.equal(validatePortUrl(origin), origin);
  const observed =
    'https://opendots-7unu3az5tgmza.cucwhrfve2byhfa6.eastus2.sysgen.cloudapp.azure.com';
  assert.equal(validatePortUrl(observed), observed);
  for (const value of [
    observed + '.evil.example',
    observed.replace('eastus2', 'westus'),
    observed.replace('7unu3az5tgmza', 'foreign'),
  ])
    assert.throws(() => validatePortUrl(value));
  assert.equal(
    validatePortUrl(origin.replace('.sysgen.', '.')),
    origin.replace('.sysgen.', '.'),
  );
  for (const url of [
    origin.replace('https:', 'http:'),
    origin + '.evil.example',
    origin + '/path',
    origin + '?token=x',
    origin.replace('eastus2', 'westus'),
    SCOPE.dataPlaneEndpoint,
    origin.replace('https://', 'https://secret@'),
    'https://4310-fixture.eastus2.adcproxy.io',
    origin.replace('7unu3az5tgmza', 'foreign'),
  ])
    assert.throws(() => validatePortUrl(url));
});
test('ownership checks reject foreign IDs and missing tags', () => {
  assertOwned(
    { id: output.sandboxGroupId, tags: TAGS, location: 'eastus2' },
    output.sandboxGroupId,
  );
  assert.throws(() =>
    assertOwned(
      { id: output.sandboxGroupId, tags: {}, location: 'eastus2' },
      output.sandboxGroupId,
    ),
  );
  assert.throws(() =>
    assertOwned(
      { id: 'foreign', tags: TAGS, location: 'eastus2' },
      output.sandboxGroupId,
    ),
  );
});
test('SSH requires one globally routable IPv4 /32, never a broad range', () => {
  assert.equal(validateOperatorCidr('8.8.8.8/32'), '8.8.8.8/32');
  for (const value of [
    '0.0.0.0/0',
    '8.8.8.8/24',
    '8.8.8.8',
    '127.0.0.1/32',
    '10.1.2.3/32',
    '169.254.169.254/32',
    '192.0.2.1/32',
    '2001:db8::1/128',
  ])
    assert.throws(() => validateOperatorCidr(value));
});
test('az writes recheck the account and pin subscription; raw failures are redacted', async () => {
  const calls = [];
  const az = createAz(async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'account') return { stdout: JSON.stringify(account) };
    if (args[0] === 'rest') {
      assert(args.includes('https://graph.microsoft.com/v1.0/me?$select=id'));
      return { stdout: JSON.stringify(SCOPE.principalId) };
    }
    throw new Error('secret provider body Authorization token');
  });
  await assert.rejects(
    az.write(['acr', 'token', 'update']),
    (error) => !safeError(error).includes('Authorization'),
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['account', 'rest', 'acr'],
  );
  assert(
    calls.every(
      (args) =>
        args[args.indexOf('--subscription') + 1] === SCOPE.subscriptionId,
    ),
  );
  assert(!safeError(new Error('secret')).includes('secret'));
});
test('SDK token acquisition pins subscription without the incompatible tenant option', () => {
  assert.equal(SANDBOX_CREDENTIAL_OPTIONS.subscription, SCOPE.subscriptionId);
  assert.equal(Object.hasOwn(SANDBOX_CREDENTIAL_OPTIONS, 'tenantId'), false);
  assert.deepEqual(SANDBOX_CREDENTIAL_OPTIONS.additionallyAllowedTenants, []);
});
test('live resource verification rejects local-auth policy changes and failed model deployment', async () => {
  let disabled = true;
  let modelState = 'Succeeded';
  const az = {
    verify: async () => {},
    read: async (args) => {
      assert(!args.includes('keys'));
      if (args[0] === 'group')
        return {
          id: output.registryId.split('/providers/')[0],
          location: SCOPE.location,
          tags: TAGS,
        };
      const id = args[args.indexOf('--ids') + 1];
      const properties =
        id === output.registryId
          ? {
              adminUserEnabled: false,
              anonymousPullEnabled: false,
              loginServer: output.registryLoginServer,
            }
          : id === output.foundryId
            ? {
                customSubDomainName: output.foundryName,
                allowProjectManagement: true,
                disableLocalAuth: disabled,
                provisioningState: 'Succeeded',
              }
            : id === output.applicationInsightsId
              ? { ConnectionString: output.applicationInsightsConnectionString }
              : id.endsWith('/deployments/dot-chat')
                ? {
                    provisioningState: modelState,
                    raiPolicyName: 'Microsoft.DefaultV2',
                    model: {
                      format: 'OpenAI',
                      name: 'gpt-5.4-mini',
                      version: '2026-03-17',
                    },
                  }
                : { provisioningState: 'Succeeded' };
      return {
        id,
        location: SCOPE.location,
        tags: TAGS,
        kind: 'AIServices',
        identity: {
          type: 'SystemAssigned',
          tenantId: SCOPE.tenantId,
          principalId:
            id === output.projectId
              ? output.projectPrincipalId
              : output.foundryPrincipalId,
        },
        properties,
        sku: { name: 'GlobalStandard', capacity: 50 },
      };
    },
  };
  await verifyLiveResources(az, output);
  disabled = false;
  await assert.rejects(verifyLiveResources(az, output), /Foundry account/);
  disabled = true;
  modelState = 'Failed';
  await assert.rejects(verifyLiveResources(az, output), /model deployment/);
});
test('an effective repository-token deny blocks import without changing policy', async () => {
  const id =
    '/providers/Microsoft.Authorization/policyDefinitions/ff05e24e-195c-447e-b322-5e90c9f9f366';
  const az = {
    read: async (args) =>
      args.at(-1).includes('/policyAssignments?')
        ? {
            value: [
              {
                properties: {
                  policyDefinitionId: id,
                  parameters: { effect: { value: 'Deny' } },
                },
              },
            ],
          }
        : { properties: {} },
  };
  await assert.rejects(
    inspectTokenPolicy(az, output.registryId),
    /Policy denies/,
  );
});

test('policy inspection explicitly includes inheritance and validates every pagination URL', async () => {
  const calls = [];
  const endpoint = `https://management.azure.com${output.registryId}/providers/Microsoft.Authorization/policyAssignments`;
  const az = {
    read: async (args) => {
      const url = args.at(-1);
      calls.push(url);
      return calls.length === 1
        ? {
            value: [
              {
                name: 'inherited',
                properties: {
                  scope:
                    '/providers/Microsoft.Management/managementGroups/example',
                },
              },
            ],
            nextLink: endpoint + '?api-version=2023-04-01&$skiptoken=page2',
          }
        : { value: [] };
    },
  };
  const assignments = await effectivePolicies(az, output.registryId);
  assert(calls[0].includes('$filter=atScope()'));
  assert.equal(assignments[0].name, 'inherited');
  assert.equal(calls.length, 2);
  for (const nextLink of [
    'https://evil.example/next',
    endpoint.replace('rg-opendots-pilot', 'foreign') + '?page=2',
  ])
    await assert.rejects(
      effectivePolicies(
        { read: async () => ({ value: [], nextLink }) },
        output.registryId,
      ),
      /pagination/,
    );
});

test('ARM preflight handles an absent RG and correctly recognizes owned child resource IDs', async () => {
  const group = {
    id: output.registryId.split('/providers/')[0],
    location: 'eastus2',
    tags: TAGS,
  };
  const az = {
    verify: async () => {},
    read: async (args) => {
      if (args[0] === 'group' && args[1] === 'exists') return true;
      if (args[0] === 'group') return group;
      return [
        {
          id: output.projectId,
          type: 'Microsoft.CognitiveServices/accounts/projects',
          name: `${output.foundryName}/opendots`,
          location: 'eastus2',
          tags: TAGS,
        },
      ];
    },
  };
  assert.equal(await inspectGroupBeforeDeployment(az), true);
  assert.equal(
    await inspectGroupBeforeDeployment({
      verify: async () => {},
      read: async () => false,
    }),
    false,
  );
});
