import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const path = process.env.PRODUCTION_ARM_TEMPLATE;
assert.ok(
  path,
  'PRODUCTION_ARM_TEMPLATE must name a freshly compiled ARM JSON file',
);
const template = JSON.parse(readFileSync(path, 'utf8'));
const schema =
  'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#';
const expr = (value) => `[${value}]`;
const param = (name) => expr(`parameters('${name}')`);
const vnetName = "format('{0}-vnet', parameters('namingPrefix'))";
const acaName = "format('{0}-aca', parameters('namingPrefix'))";
const peName = "format('{0}-blob-pe', parameters('namingPrefix'))";
const identityName = "format('{0}-workload', parameters('namingPrefix'))";
const pgZone = 'private.postgres.database.azure.com';
const blobZone = 'privatelink.blob.core.windows.net';
const ids = {
  vnet: `resourceId('Microsoft.Network/virtualNetworks', ${vnetName})`,
  aca: `resourceId('Microsoft.App/managedEnvironments', ${acaName})`,
  pg: "resourceId('Microsoft.DBforPostgreSQL/flexibleServers', variables('postgresName'))",
  pgDns: `resourceId('Microsoft.Network/privateDnsZones', '${pgZone}')`,
  pgDnsLink: `resourceId('Microsoft.Network/privateDnsZones/virtualNetworkLinks', '${pgZone}', ${vnetName})`,
  storage:
    "resourceId('Microsoft.Storage/storageAccounts', variables('storageName'))",
  blobService:
    "resourceId('Microsoft.Storage/storageAccounts/blobServices', variables('storageName'), 'default')",
  media:
    "resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', variables('storageName'), 'default', 'media')",
  blobDns: `resourceId('Microsoft.Network/privateDnsZones', '${blobZone}')`,
  pe: `resourceId('Microsoft.Network/privateEndpoints', ${peName})`,
  identity: `resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', ${identityName})`,
};
const subnetId = (name) =>
  expr(
    `resourceId('Microsoft.Network/virtualNetworks/subnets', ${vnetName}, '${name}')`,
  );
const reference = (id, api, property) =>
  expr(`reference(${ids[id]}, '${api}').${property}`);
const dependencies = (...names) => names.map((name) => expr(ids[name])).sort();

function expectResource(type, apiVersion, name, fields = {}) {
  const matches = template.resources.filter(
    (resource) => resource.type === type && resource.name === name,
  );
  assert.equal(matches.length, 1, `${type}: unique expected resource ${name}`);
  const actual = { ...matches[0] };
  const expected = { type, apiVersion, name, ...fields };
  if (actual.dependsOn) actual.dependsOn = [...actual.dependsOn].sort();
  if (expected.dependsOn) expected.dependsOn = [...expected.dependsOn].sort();
  assert.deepEqual(
    actual,
    expected,
    `${type}: complete compiled resource contract`,
  );
}

test('RG scope, required parameters, guarded zones and closed resource inventory', () => {
  assert.deepEqual(
    Object.keys(template).sort(),
    [
      '$schema',
      'contentVersion',
      'metadata',
      'outputs',
      'parameters',
      'resources',
      'variables',
    ].sort(),
  );
  assert.equal(template.$schema, schema);
  assert.equal(template.contentVersion, '1.0.0.0');
  assert.equal(template.metadata._generator.name, 'bicep');
  const lengths = {
    location: [1, 64],
    namingPrefix: [3, 10],
    vnetCidr: [9, 18],
    acaSubnetCidr: [9, 18],
    postgresSubnetCidr: [9, 18],
    privateEndpointSubnetCidr: [9, 18],
    postgresSkuName: [1, 80],
    entraAdminGroupObjectId: [36, 36],
    entraAdminGroupDisplayName: [1, 256],
  };
  const expectedParameters = Object.fromEntries(
    Object.entries(lengths).map(([name, [minLength, maxLength]]) => [
      name,
      { type: 'string', minLength, maxLength },
    ]),
  );
  for (const name of ['postgresPrimaryZone', 'postgresStandbyZone']) {
    expectedParameters[name] = {
      type: 'string',
      allowedValues: ['1', '2', '3'],
    };
  }
  const parameters = Object.fromEntries(
    Object.entries(template.parameters).map(
      ([name, { metadata, ...definition }]) => {
        assert.equal(
          typeof metadata?.description,
          'string',
          `${name}: described input`,
        );
        return [name, definition];
      },
    ),
  );
  assert.deepEqual(parameters, expectedParameters); // No defaults, secrets, tenant override or pilot principal.
  assert.deepEqual(template.variables, {
    storageName: expr(
      "format('{0}{1}', parameters('namingPrefix'), uniqueString(resourceGroup().id, parameters('namingPrefix')))",
    ),
    postgresName: expr(
      "format('{0}-pg-{1}', parameters('namingPrefix'), uniqueString(resourceGroup().id, parameters('namingPrefix')))",
    ),
    standbyZone: expr(
      "if(not(equals(parameters('postgresPrimaryZone'), parameters('postgresStandbyZone'))), parameters('postgresStandbyZone'), fail('PostgreSQL primary and standby availability zones must be distinct.'))",
    ),
    blobContributorRoleId: expr(
      "subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')",
    ),
  });
  const counts = {};
  for (const resource of template.resources)
    counts[resource.type] = (counts[resource.type] ?? 0) + 1;
  assert.deepEqual(counts, {
    'Microsoft.Network/virtualNetworks': 1,
    'Microsoft.Network/privateDnsZones': 2,
    'Microsoft.Network/privateDnsZones/virtualNetworkLinks': 2,
    'Microsoft.App/managedEnvironments': 1,
    'Microsoft.Resources/deployments': 1,
    'Microsoft.DBforPostgreSQL/flexibleServers': 1,
    'Microsoft.DBforPostgreSQL/flexibleServers/administrators': 1,
    'Microsoft.Storage/storageAccounts': 1,
    'Microsoft.Storage/storageAccounts/blobServices': 1,
    'Microsoft.Storage/storageAccounts/blobServices/containers': 1,
    'Microsoft.Network/privateEndpoints': 1,
    'Microsoft.Network/privateEndpoints/privateDnsZoneGroups': 1,
    'Microsoft.ManagedIdentity/userAssignedIdentities': 1,
    'Microsoft.Authorization/roleAssignments': 1,
  }); // Only the local ACA DNS module; no app containers, firewall rules, scripts, vault or pilot imports.
});

test('three dedicated subnets and non-registering PostgreSQL/Blob DNS links', () => {
  expectResource(
    'Microsoft.Network/virtualNetworks',
    '2025-05-01',
    expr(vnetName),
    {
      location: param('location'),
      properties: {
        addressSpace: { addressPrefixes: [param('vnetCidr')] },
        subnets: [
          {
            name: 'aca',
            properties: {
              addressPrefix: param('acaSubnetCidr'),
              delegations: [
                {
                  name: 'aca',
                  properties: { serviceName: 'Microsoft.App/environments' },
                },
              ],
            },
          },
          {
            name: 'postgres',
            properties: {
              addressPrefix: param('postgresSubnetCidr'),
              delegations: [
                {
                  name: 'postgres',
                  properties: {
                    serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers',
                  },
                },
              ],
              serviceEndpoints: [{ service: 'Microsoft.Storage' }],
            },
          },
          {
            name: 'private-endpoints',
            properties: {
              addressPrefix: param('privateEndpointSubnetCidr'),
              privateEndpointNetworkPolicies: 'Disabled',
            },
          },
        ],
      },
    },
  );
  for (const [zone, id] of [
    [pgZone, 'pgDns'],
    [blobZone, 'blobDns'],
  ]) {
    expectResource('Microsoft.Network/privateDnsZones', '2024-06-01', zone, {
      location: 'global',
    });
    expectResource(
      'Microsoft.Network/privateDnsZones/virtualNetworkLinks',
      '2024-06-01',
      expr(`format('{0}/{1}', '${zone}', ${vnetName})`),
      {
        location: 'global',
        properties: {
          registrationEnabled: false,
          virtualNetwork: { id: expr(ids.vnet) },
        },
        dependsOn: dependencies(id, 'vnet'),
      },
    );
  }
});

test('empty internal-only zone-redundant ACA and runtime-derived private DNS', () => {
  expectResource(
    'Microsoft.App/managedEnvironments',
    '2026-07-01',
    expr(acaName),
    {
      location: param('location'),
      properties: {
        environmentMode: 'WorkloadProfiles',
        workloadProfiles: [
          { name: 'Consumption', workloadProfileType: 'Consumption' },
        ],
        zoneRedundant: true,
        vnetConfiguration: {
          infrastructureSubnetId: subnetId('aca'),
          internal: true,
        },
        publicNetworkAccess: 'Disabled',
        appLogsConfiguration: { destination: 'azure-monitor' },
      },
      dependsOn: dependencies('vnet'),
    },
  );
  const deployment = template.resources.find(
    (resource) => resource.type === 'Microsoft.Resources/deployments',
  );
  const dns = deployment.properties.template;
  assert.equal(
    typeof dns,
    'object',
    'ACA DNS must be a plain nested template object, not a template expression string',
  );
  assert.ok(
    dns && !Array.isArray(dns),
    'ACA DNS must be a plain nested template object',
  );
  expectResource(
    'Microsoft.Resources/deployments',
    '2025-04-01',
    expr("format('{0}-aca-dns', parameters('namingPrefix'))"),
    {
      properties: {
        mode: 'Incremental',
        expressionEvaluationOptions: { scope: 'inner' },
        parameters: {
          domain: { value: reference('aca', '2026-07-01', 'defaultDomain') },
          privateIp: { value: reference('aca', '2026-07-01', 'staticIp') },
          vnetId: { value: expr(ids.vnet) },
          linkName: { value: expr(vnetName) },
        },
        template: dns,
      },
      dependsOn: dependencies('aca', 'vnet'),
    },
  );
  const zoneDependency = [
    expr(
      "resourceId('Microsoft.Network/privateDnsZones', parameters('domain'))",
    ),
  ];
  const { metadata, ...definition } = dns;
  assert.equal(metadata?._generator?.name, 'bicep');
  assert.deepEqual(definition, {
    $schema: schema,
    contentVersion: '1.0.0.0',
    parameters: {
      domain: { type: 'string' },
      privateIp: { type: 'string' },
      vnetId: { type: 'string' },
      linkName: { type: 'string' },
    },
    resources: [
      {
        type: 'Microsoft.Network/privateDnsZones',
        apiVersion: '2024-06-01',
        name: param('domain'),
        location: 'global',
      },
      {
        type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks',
        apiVersion: '2024-06-01',
        name: expr(
          "format('{0}/{1}', parameters('domain'), parameters('linkName'))",
        ),
        location: 'global',
        properties: {
          registrationEnabled: false,
          virtualNetwork: { id: param('vnetId') },
        },
        dependsOn: zoneDependency,
      },
      {
        type: 'Microsoft.Network/privateDnsZones/A',
        apiVersion: '2024-06-01',
        name: expr("format('{0}/{1}', parameters('domain'), '*')"),
        properties: {
          ttl: 60,
          aRecords: [{ ipv4Address: param('privateIp') }],
        },
        dependsOn: zoneDependency,
      },
    ],
  });
});

test('PostgreSQL Entra-group-only auth, HA, storage, backups and DNS-link ordering', () => {
  expectResource(
    'Microsoft.DBforPostgreSQL/flexibleServers',
    '2025-08-01',
    expr("variables('postgresName')"),
    {
      location: param('location'),
      sku: { name: param('postgresSkuName'), tier: 'GeneralPurpose' },
      properties: {
        version: '17',
        availabilityZone: param('postgresPrimaryZone'),
        highAvailability: {
          mode: 'ZoneRedundant',
          standbyAvailabilityZone: expr("variables('standbyZone')"),
        },
        storage: {
          storageSizeGB: 128,
          type: 'Premium_LRS',
          autoGrow: 'Enabled',
        },
        backup: { backupRetentionDays: 35, geoRedundantBackup: 'Disabled' },
        authConfig: {
          activeDirectoryAuth: 'Enabled',
          passwordAuth: 'Disabled',
          tenantId: expr('tenant().tenantId'),
        },
        network: {
          delegatedSubnetResourceId: subnetId('postgres'),
          privateDnsZoneArmResourceId: expr(ids.pgDns),
        },
      },
      dependsOn: dependencies('pgDns', 'pgDnsLink', 'vnet'),
    },
  ); // Exact properties also reject administratorLogin/password and network.publicNetworkAccess.
  expectResource(
    'Microsoft.DBforPostgreSQL/flexibleServers/administrators',
    '2025-08-01',
    expr(
      "format('{0}/{1}', variables('postgresName'), parameters('entraAdminGroupObjectId'))",
    ),
    {
      properties: {
        principalName: param('entraAdminGroupDisplayName'),
        principalType: 'Group',
        tenantId: expr('tenant().tenantId'),
      },
      dependsOn: dependencies('pg'),
    },
  );
});

test('private ZRS media, retention and exact Blob PE/DNS association', () => {
  expectResource(
    'Microsoft.Storage/storageAccounts',
    '2025-08-01',
    expr("variables('storageName')"),
    {
      location: param('location'),
      kind: 'StorageV2',
      sku: { name: 'Standard_ZRS' },
      properties: {
        isHnsEnabled: false,
        supportsHttpsTrafficOnly: true,
        minimumTlsVersion: 'TLS1_2',
        publicNetworkAccess: 'Disabled',
        allowBlobPublicAccess: false,
        allowSharedKeyAccess: false,
        networkAcls: { defaultAction: 'Deny', bypass: 'None' },
      },
    },
  );
  expectResource(
    'Microsoft.Storage/storageAccounts/blobServices',
    '2025-08-01',
    expr("format('{0}/{1}', variables('storageName'), 'default')"),
    {
      properties: {
        isVersioningEnabled: true,
        deleteRetentionPolicy: { enabled: true, days: 30 },
        containerDeleteRetentionPolicy: { enabled: true, days: 30 },
      },
      dependsOn: dependencies('storage'),
    },
  );
  expectResource(
    'Microsoft.Storage/storageAccounts/blobServices/containers',
    '2025-08-01',
    expr("format('{0}/{1}/{2}', variables('storageName'), 'default', 'media')"),
    {
      properties: { publicAccess: 'None' },
      dependsOn: dependencies('blobService'),
    },
  );
  expectResource(
    'Microsoft.Network/privateEndpoints',
    '2025-05-01',
    expr(peName),
    {
      location: param('location'),
      properties: {
        subnet: { id: subnetId('private-endpoints') },
        privateLinkServiceConnections: [
          {
            name: 'blob',
            properties: {
              privateLinkServiceId: expr(ids.storage),
              groupIds: ['blob'],
            },
          },
        ],
      },
      dependsOn: dependencies('storage', 'vnet'),
    },
  );
  expectResource(
    'Microsoft.Network/privateEndpoints/privateDnsZoneGroups',
    '2025-05-01',
    expr(`format('{0}/{1}', ${peName}, 'blob')`),
    {
      properties: {
        privateDnsZoneConfigs: [
          { name: 'blob', properties: { privateDnsZoneId: expr(ids.blobDns) } },
        ],
      },
      dependsOn: dependencies('blobDns', 'pe'),
    },
  );
});

test('future workload identity has only deterministic media-container RBAC', () => {
  expectResource(
    'Microsoft.ManagedIdentity/userAssignedIdentities',
    '2024-11-30',
    expr(identityName),
    { location: param('location') },
  );
  expectResource(
    'Microsoft.Authorization/roleAssignments',
    '2022-04-01',
    expr(
      `guid(${ids.media}, ${ids.identity}, variables('blobContributorRoleId'))`,
    ),
    {
      scope: expr(ids.media),
      properties: {
        roleDefinitionId: expr("variables('blobContributorRoleId')"),
        principalId: reference('identity', '2024-11-30', 'principalId'),
        principalType: 'ServicePrincipal',
      },
      dependsOn: dependencies('media', 'identity'),
    },
  );
});

test('outputs are only approved IDs, private environment details and media/PG endpoints', () => {
  const values = {
    vnetId: expr(ids.vnet),
    acaSubnetId: subnetId('aca'),
    postgresSubnetId: subnetId('postgres'),
    privateEndpointSubnetId: subnetId('private-endpoints'),
    acaEnvironmentId: expr(ids.aca),
    acaEnvironmentDomain: reference('aca', '2026-07-01', 'defaultDomain'),
    acaEnvironmentPrivateIp: reference('aca', '2026-07-01', 'staticIp'),
    postgresServerId: expr(ids.pg),
    postgresFqdn: reference('pg', '2025-08-01', 'fullyQualifiedDomainName'),
    storageAccountId: expr(ids.storage),
    blobPrivateEndpointId: expr(ids.pe),
    mediaContainerId: expr(ids.media),
    mediaEndpoint: expr(
      `format('{0}media', reference(${ids.storage}, '2025-08-01').primaryEndpoints.blob)`,
    ),
    mediaContainerName: 'media',
    workloadIdentityId: expr(ids.identity),
    workloadIdentityClientId: reference('identity', '2024-11-30', 'clientId'),
    workloadIdentityPrincipalId: reference(
      'identity',
      '2024-11-30',
      'principalId',
    ),
  };
  assert.deepEqual(
    template.outputs,
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        { type: 'string', value },
      ]),
    ),
  );
});
