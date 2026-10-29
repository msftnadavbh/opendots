import { isDeepStrictEqual } from 'node:util';
import { SCUS_PROFILE, assertProfile } from './profiles.mjs';
import { requirePilot, validatePublicIpv4, TAGS } from './scope.mjs';
import { publicKey } from './ssh.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sameId = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.toLowerCase() === b.toLowerCase();
const encryption = Object.freeze({ type: 'EncryptionAtRestWithPlatformKey' });
const diskSecurity = Object.freeze({ securityType: 'TrustedLaunch' });
const pipIpTags = Object.freeze([
  Object.freeze({ ipTagType: 'FirstPartyUsage', tag: '/Unprivileged' }),
]);
const vmSecurity = Object.freeze({
  ...diskSecurity,
  uefiSettings: Object.freeze({ secureBootEnabled: true, vTpmEnabled: true }),
});
export const isHostStage = (stage) =>
  stage === 'host' || stage === 'model-role';
const target = (profile) => {
  assertProfile(profile);
  requirePilot(
    profile === SCUS_PROFILE,
    'Host infrastructure requires the canonical target profile.',
  );
};
export function hostDescriptors(profile) {
  target(profile);
  const { network: n, disks: d, vm } = profile.compute;
  return [n.nsg, n.vnet, n.pip, n.nic, d.data, d.audit, vm].map(
    ({ id, type, name }) => ({ id, type, name }),
  );
}
export function hostImageId(profile) {
  target(profile);
  const { publisher, offer, sku, version } = profile.compute.vm.image;
  return `/subscriptions/${profile.account.subscriptionId}/providers/Microsoft.Compute/locations/${profile.compute.location}/publishers/${publisher}/artifacttypes/vmimage/offers/${offer}/skus/${sku}/versions/${version}`;
}
export const hostImageUrl = (profile) =>
  `https://management.azure.com${hostImageId(profile)}?api-version=2025-11-01`;
export const modelRoleListUrl = (profile) =>
  `https://management.azure.com${profile.modelRole.scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()`;
export const HOST_OBSERVATION_QUERY =
  'instanceView.{statuses:statuses[].{code:code,level:level},agent:{version:vmAgent.vmAgentVersion,statuses:vmAgent.statuses[].{code:code,level:level},handlers:vmAgent.extensionHandlers[].{name:type,version:typeHandlerVersion,code:status.code,level:status.level}}}';

export function hostParameters(profile, state, stage) {
  target(profile);
  if (stage === 'model-role') {
    const binding = state.stages.host?.binding;
    requirePilot(
      state.stages.host?.status === 'complete' &&
        sameId(binding?.vm?.id, profile.compute.vm.id) &&
        uuid.test(binding?.vm?.principalId ?? '') &&
        binding.vm.tenantId === profile.account.tenantId,
      'Model-role validation requires the completed actual target VM/MI binding, never a placeholder.',
    );
    return { principalId: { value: binding.vm.principalId } };
  }
  requirePilot(
    stage === 'host' && state.stages.host?.preparation?.status === 'complete',
    'Run target-only prepare-host first.',
  );
  const copies = state.stages.copy?.resources;
  requirePilot(
    state.stages.copy?.status === 'complete' &&
      uuid.test(copies?.os?.uniqueId ?? '') &&
      uuid.test(copies?.data?.uniqueId ?? ''),
    'Host requires both completed, pinned SCUS copies.',
  );
  return {
    migrationId: { value: state.migrationId },
    sourceArchiveSha256: { value: state.source.archiveSha256 },
    sshPublicKey: { value: publicKey(state.stages.host.preparation.publicKey) },
    dataSourceUniqueId: { value: copies.data.uniqueId },
    auditSourceUniqueId: { value: copies.os.uniqueId },
  };
}

function graph(profile, stage, values, tags) {
  if (stage === 'model-role')
    return [
      {
        id: profile.modelRole.id,
        name: profile.modelRole.name,
        type: 'Microsoft.Authorization/roleAssignments',
        apiVersion: '2022-04-01',
        properties: {
          roleDefinitionId: profile.modelRole.roleDefinitionId,
          principalId: values.principalId,
          principalType: 'ServicePrincipal',
        },
      },
    ];
  const { network: n, disks: d, vm } = profile.compute;
  const base = (r, properties, extra = {}) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    apiVersion: r.type.startsWith('Microsoft.Network/')
      ? '2025-05-01'
      : r === vm
        ? '2025-11-01'
        : '2025-01-02',
    location: profile.compute.location,
    tags,
    ...extra,
    properties,
  });
  const restored = (kind, snapshot, uid, size) =>
    base(
      d[kind],
      {
        creationData: { createOption: 'Copy', sourceResourceId: snapshot.id },
        diskSizeGB: size,
        ...(kind === 'audit'
          ? {
              osType: 'Linux',
              hyperVGeneration: 'V2',
              securityProfile: diskSecurity,
            }
          : {}),
        encryption,
        networkAccessPolicy: 'DenyAll',
        publicNetworkAccess: 'Disabled',
      },
      {
        sku: { name: 'Standard_LRS' },
        tags: { ...tags, expectedSourceUniqueId: uid },
      },
    );
  return [
    base(n.nsg, {
      securityRules: [
        {
          name: 'https-and-acme',
          properties: {
            priority: 100,
            direction: 'Inbound',
            access: 'Allow',
            protocol: 'Tcp',
            sourceAddressPrefix: 'Internet',
            sourcePortRange: '*',
            destinationAddressPrefix: `${n.privateIpv4}/32`,
            destinationPortRanges: ['80', '443'],
          },
        },
        {
          name: 'deny-other-inbound',
          properties: {
            priority: 4096,
            direction: 'Inbound',
            access: 'Deny',
            protocol: '*',
            sourceAddressPrefix: '*',
            sourcePortRange: '*',
            destinationAddressPrefix: '*',
            destinationPortRange: '*',
          },
        },
      ],
    }),
    base(n.vnet, {
      addressSpace: { addressPrefixes: [n.addressPrefix] },
      subnets: [
        {
          name: n.subnet.name,
          properties: {
            addressPrefix: n.addressPrefix,
            networkSecurityGroup: { id: n.nsg.id },
          },
        },
      ],
    }),
    base(
      n.pip,
      {
        publicIPAllocationMethod: 'Static',
        publicIPAddressVersion: 'IPv4',
        ipTags: pipIpTags,
        dnsSettings: {
          domainNameLabel: n.dnsLabel,
          domainNameLabelScope: 'ResourceGroupReuse',
        },
      },
      { sku: { name: 'Standard', tier: 'Regional' } },
    ),
    base(n.nic, {
      enableIPForwarding: false,
      networkSecurityGroup: { id: n.nsg.id },
      ipConfigurations: [
        {
          name: 'primary',
          properties: {
            primary: true,
            privateIPAllocationMethod: 'Static',
            privateIPAddress: n.privateIpv4,
            privateIPAddressVersion: 'IPv4',
            subnet: { id: n.subnet.id },
            publicIPAddress: { id: n.pip.id },
          },
        },
      ],
    }),
    restored(
      'data',
      profile.sourcePreservation.snapshots.targetData,
      values.dataSourceUniqueId,
      32,
    ),
    restored(
      'audit',
      profile.sourcePreservation.snapshots.targetOs,
      values.auditSourceUniqueId,
      30,
    ),
    base(
      vm,
      {
        hardwareProfile: { vmSize: vm.size },
        securityProfile: vmSecurity,
        storageProfile: {
          diskControllerType: vm.diskControllerType,
          imageReference: vm.image,
          osDisk: {
            name: d.os.name,
            createOption: 'FromImage',
            diskSizeGB: 32,
            caching: 'ReadWrite',
            deleteOption: 'Detach',
            managedDisk: { storageAccountType: 'Standard_LRS' },
          },
          dataDisks: [
            {
              name: d.data.name,
              lun: 0,
              createOption: 'Attach',
              caching: 'None',
              deleteOption: 'Detach',
              managedDisk: { id: d.data.id },
            },
          ],
        },
        osProfile: {
          computerName: vm.name,
          adminUsername: vm.admin,
          linuxConfiguration: {
            disablePasswordAuthentication: true,
            provisionVMAgent: true,
            ssh: {
              publicKeys: [
                {
                  path: `/home/${vm.admin}/.ssh/authorized_keys`,
                  keyData: values.sshPublicKey,
                },
              ],
            },
          },
        },
        networkProfile: {
          networkInterfaces: [
            {
              id: n.nic.id,
              properties: { primary: true, deleteOption: 'Detach' },
            },
          ],
        },
      },
      { identity: { type: 'SystemAssigned' } },
    ),
  ];
}
export function hostResources(profile, state, stage, tags) {
  const values = Object.fromEntries(
    Object.entries(hostParameters(profile, state, stage)).map(([key, p]) => [
      key,
      p.value,
    ]),
  );
  return graph(profile, stage, values, tags);
}

export function assertHostTemplate(profile, state, stage, template, tags) {
  const parameters = hostParameters(profile, state, stage);
  const values = Object.fromEntries(
    Object.keys(parameters).map((key) => [key, `[parameters('${key}')]`]),
  );
  const symbolicTags = {
    ...tags,
    migrationId: values.migrationId,
    sourceArchiveSha256: values.sourceArchiveSha256,
  };
  const rg =
    profile.stages[stage].resourceGroup ?? profile.compute.resourceGroup;
  const authorized = `[and(and(equals(subscription().subscriptionId, '${profile.account.subscriptionId}'), equals(tenant().tenantId, '${profile.account.tenantId}')), equals(resourceGroup().name, '${rg}'))]`;
  const ref = (r) => `resourceId('${r.type}', '${r.name}')`;
  const refs = new Map(
    hostDescriptors(profile).map((r) => [r.id, `[${ref(r)}]`]),
  );
  refs.set(
    profile.compute.network.subnet.id,
    `[format('{0}/subnets/app', ${ref(profile.compute.network.vnet)})]`,
  );
  const replaceRefs = (v) =>
    typeof v === 'string'
      ? (refs.get(v) ?? v)
      : Array.isArray(v)
        ? v.map(replaceRefs)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v).map(([key, value]) => [
                key,
                replaceRefs(value),
              ]),
            )
          : v;
  const expected = graph(profile, stage, values, symbolicTags).map(
    ({ id, ...r }, index) => {
      const write = {
        condition: "[variables('authorized')]",
        ...replaceRefs(r),
      };
      if (stage === 'model-role')
        write.scope = `[resourceId('Microsoft.CognitiveServices/accounts', '${profile.sharedServices.foundry.name}')]`;
      else {
        write.tags = [4, 5].includes(index)
          ? `[union(variables('tags'), createObject('expectedSourceUniqueId', parameters('${index === 4 ? 'data' : 'audit'}SourceUniqueId')))]`
          : "[variables('tags')]";
        const n = profile.compute.network;
        const dependencies = {
          1: [n.nsg],
          3: [n.nsg, n.pip, n.vnet],
          6: [profile.compute.disks.data, n.nic],
        }[index];
        if (dependencies)
          write.dependsOn = dependencies.map((r) => `[${ref(r)}]`);
      }
      return write;
    },
  );
  const outputRefs =
    stage === 'host'
      ? hostDescriptors(profile).map(ref).join(', ')
      : `extensionResourceId(resourceId('Microsoft.CognitiveServices/accounts', '${profile.sharedServices.foundry.name}'), 'Microsoft.Authorization/roleAssignments', '${profile.modelRole.name}')`;
  const expectedParameters = Object.fromEntries(
    Object.keys(parameters).map((key) => [
      key,
      {
        type: 'string',
        ...(['migrationId', 'principalId'].includes(key)
          ? { minLength: 36, maxLength: 36 }
          : key === 'sourceArchiveSha256'
            ? { minLength: 64, maxLength: 64 }
            : {}),
      },
    ]),
  );
  requirePilot(
    template?.$schema ===
      'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#' &&
      template.contentVersion === '1.0.0.0' &&
      isDeepStrictEqual(
        Object.keys(template).sort(),
        [
          '$schema',
          'contentVersion',
          'metadata',
          'parameters',
          'variables',
          'resources',
          'outputs',
        ].sort(),
      ) &&
      isDeepStrictEqual(template.parameters, expectedParameters) &&
      isDeepStrictEqual(template.variables, {
        authorized,
        ...(stage === 'host' ? { tags: symbolicTags } : {}),
      }) &&
      isDeepStrictEqual(template.resources, expected) &&
      isDeepStrictEqual(template.outputs, {
        resourceIds: {
          type: 'array',
          value: `[if(variables('authorized'), createArray(${outputRefs}), createArray())]`,
        },
      }),
    'Compiled B1 template escaped its exact host/role graph, fixed scope, parameters or no-guest-execution contract.',
  );
}

// Readbacks may add provider metadata, but must not omit or contradict requested configuration.
function matches(actual, expected) {
  if (typeof expected === 'string' && expected.startsWith('/subscriptions/'))
    return sameId(actual, expected);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matches(actual[i], item))
    );
  if (expected && typeof expected === 'object')
    return (
      actual &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([key, value]) =>
        matches(actual[key], value),
      )
    );
  return actual === expected;
}
function noGuestExecution(value) {
  const p = value.properties;
  return (
    !value.resources?.length &&
    p?.userData == null &&
    p?.applicationProfile == null &&
    p?.osProfile?.customData == null &&
    p?.osProfile?.adminPassword == null &&
    !p?.osProfile?.secrets?.length &&
    p?.osProfile?.windowsConfiguration == null &&
    !p?.extensionProfile?.extensions?.length &&
    !Object.keys(value.identity?.userAssignedIdentities ?? {}).length &&
    (p?.priority == null || p.priority === 'Regular') &&
    !p?.host &&
    !p?.hostGroup
  );
}
function noNetworkOverlays(value, profile) {
  const p = value.properties;
  return (
    !p?.dnsSettings?.dnsServers?.length &&
    !p?.dhcpOptions?.dnsServers?.length &&
    !p?.virtualNetworkPeerings?.length &&
    !p?.natGateway &&
    !p?.publicIPPrefix &&
    !p?.linkedPublicIPAddress &&
    !p?.servicePublicIPAddress &&
    (sameId(value.id, profile.compute.network.pip.id) &&
    sameId(value.type, profile.compute.network.pip.type)
      ? isDeepStrictEqual(p?.ipTags, pipIpTags)
      : p?.ipTags == null ||
        (Array.isArray(p.ipTags) && p.ipTags.length === 0)) &&
    !p?.flowLogs?.length &&
    (p?.subnets ?? []).every(
      (s) =>
        !s.properties ||
        (!s.properties.routeTable &&
          !s.properties.natGateway &&
          !s.properties.delegations?.length &&
          !s.properties.serviceEndpoints?.length &&
          !s.properties.serviceEndpointPolicies?.length &&
          !s.properties.privateEndpoints?.length),
    ) &&
    (p?.ipConfigurations ?? []).every(
      (ip) =>
        !ip.properties?.applicationSecurityGroups?.length &&
        !ip.properties?.applicationGatewayBackendAddressPools?.length &&
        !ip.properties?.loadBalancerBackendAddressPools?.length &&
        !ip.properties?.loadBalancerInboundNatRules?.length &&
        !ip.properties?.privateLinkConnectionProperties,
    )
  );
}
export function assertHostWhatIf(after, spec, profile, stage) {
  requirePilot(
    sameId(after.id ?? spec.id, spec.id) &&
      after.type?.toLowerCase() === spec.type.toLowerCase() &&
      (after.name == null || after.name === spec.name) &&
      matches(after.properties, spec.properties) &&
      (stage === 'model-role'
        ? !after.properties.condition &&
          !after.properties.conditionVersion &&
          !after.properties.delegatedManagedIdentityResourceId &&
          (after.properties.scope == null ||
            sameId(after.properties.scope, profile.modelRole.scope)) &&
          (after.scope == null || sameId(after.scope, profile.modelRole.scope))
        : after.location?.toLowerCase() === spec.location &&
          isDeepStrictEqual(after.tags, spec.tags) &&
          (!spec.sku || matches(after.sku, spec.sku)) &&
          (!spec.identity || matches(after.identity, spec.identity)) &&
          (!spec.type.startsWith('Microsoft.Network/') ||
            noNetworkOverlays(
              { ...after, id: after.id ?? spec.id },
              profile,
            )) &&
          (spec.type !== 'Microsoft.Compute/virtualMachines' ||
            noGuestExecution(after))),
    'B1 what-if differs from the exact host request or actual-principal, account-scoped role; no unresolved placeholders or guest execution.',
  );
}

export function assertHostImage(image, profile) {
  const p = image?.properties;
  requirePilot(
    sameId(image?.id, hostImageId(profile)) &&
      image.name === profile.compute.vm.image.version &&
      image.location?.toLowerCase() === profile.compute.location &&
      p?.osDiskImage?.operatingSystem === 'Linux' &&
      p.architecture === 'x64' &&
      p.hyperVGeneration === 'V2' &&
      !p.plan &&
      !p.dataDiskImages?.length &&
      Array.isArray(p.features) &&
      p.features.every(
        (f) => typeof f.name === 'string' && typeof f.value === 'string',
      ) &&
      new Set(p.features.map((f) => f.name)).size === p.features.length,
    'Exact SCUS pinned-image Linux/x64/V2 metadata is unavailable or contradictory.',
  );
  const features = Object.fromEntries(p.features.map((f) => [f.name, f.value]));
  requirePilot(
    [
      'TrustedLaunch',
      'TrustedLaunchSupported',
      'TrustedLaunchAndConfidentialVmSupported',
    ].includes(features.SecurityType) &&
      features.DiskControllerTypes?.split(',')
        .map((s) => s.trim().toUpperCase())
        .includes('NVME'),
    'Pinned marketplace image does not establish Trusted Launch and NVMe compatibility.',
  );
  return {
    id: hostImageId(profile),
    operatingSystem: 'Linux',
    architecture: 'x64',
    hyperVGeneration: 'V2',
    securityType: features.SecurityType,
    diskControllerTypes: features.DiskControllerTypes,
    requestedOsDiskGiB: 32,
    minimumSize: 'not-independently-measured',
  };
}

function owned(value, spec, implicit = false) {
  requirePilot(
    sameId(value?.id, spec.id) &&
      value.name === spec.name &&
      value.type?.toLowerCase() === spec.type.toLowerCase() &&
      value.location?.toLowerCase() === spec.location &&
      (implicit || isDeepStrictEqual(value.tags, spec.tags)),
    'Target host resource identity, ownership or location differs from the recorded request.',
  );
}
function assertDisk(value, profile, state, kind, intentAt) {
  const p = value.properties,
    d = profile.compute.disks[kind],
    isAudit = kind === 'audit',
    isOs = kind === 'os';
  const size = isAudit ? 30 : 32;
  const exportDisabled =
    p.networkAccessPolicy === 'DenyAll' && p.publicNetworkAccess === 'Disabled';
  requirePilot(
    p.provisioningState === 'Succeeded' &&
      uuid.test(p.uniqueId ?? '') &&
      p.diskSizeGB === size &&
      value.sku?.name === 'Standard_LRS' &&
      isDeepStrictEqual(p.encryption, encryption) &&
      (!p.encryptionSettingsCollection ||
        p.encryptionSettingsCollection.enabled === false) &&
      p.copyCompletionError == null &&
      !p.propertyUpdatesInProgress &&
      (!p.maxShares || p.maxShares === 1) &&
      !p.shareInfo?.length &&
      (isAudit
        ? value.managedBy == null &&
          p.diskState === 'Unattached' &&
          !value.managedByExtended?.length
        : sameId(value.managedBy, profile.compute.vm.id) &&
          ['Attached', 'Reserved'].includes(p.diskState) &&
          (value.managedByExtended == null ||
            (Array.isArray(value.managedByExtended) &&
              value.managedByExtended.length <= 1 &&
              value.managedByExtended.every((id) =>
                sameId(id, profile.compute.vm.id),
              )))) &&
      (exportDisabled ||
        (isOs &&
          p.networkAccessPolicy === 'AllowAll' &&
          p.publicNetworkAccess === 'Enabled')) &&
      (kind === 'data'
        ? p.securityProfile == null
        : p.osType === 'Linux' &&
          p.hyperVGeneration === 'V2' &&
          isDeepStrictEqual(p.securityProfile, diskSecurity)),
    'Authoritative target disk size/SKU/identity/ownership/attachment/security/export or completed state is unverified.',
  );
  const created = Date.parse(p.timeCreated);
  requirePilot(
    typeof p.timeCreated === 'string' &&
      Number.isFinite(created) &&
      created >= Date.parse(intentAt) - 600_000 &&
      created <= Date.now() + 600_000,
    'Target disk creation is not attributable to its recorded absent-resource intent.',
  );
  const c = p.creationData;
  requirePilot(
    c && !c.sourceUri && !c.storageAccountId && !c.galleryImageReference,
    'Target disk creation contains an unexpected source or export/import path.',
  );
  let creation;
  if (isOs) {
    requirePilot(
      c.createOption === 'FromImage' &&
        sameId(c.imageReference?.id, hostImageId(profile)) &&
        c.imageReference.lun == null &&
        c.sourceResourceId == null,
      'Fresh OS disk is not from the exact SCUS pinned platform image.',
    );
    creation = { createOption: 'FromImage', imageId: hostImageId(profile) };
  } else {
    const source = state.stages.copy.resources[isAudit ? 'os' : 'data'];
    requirePilot(
      c.createOption === 'Copy' &&
        sameId(c.sourceResourceId, source.id) &&
        c.imageReference == null,
      'Restored disk must use Copy from its exact independently verified SCUS snapshot.',
    );
    const representation = !Object.hasOwn(c, 'sourceUniqueId')
      ? 'omitted'
      : c.sourceUniqueId === null
        ? 'null'
        : 'value';
    requirePilot(
      representation !== 'value' ||
        (uuid.test(c.sourceUniqueId ?? '') &&
          c.sourceUniqueId === source.uniqueId),
      'Restored Copy sourceUniqueId must be omitted, null or the immediate SCUS snapshot UID; ancestor or arbitrary IDs are forbidden.',
    );
    creation = {
      createOption: 'Copy',
      sourceResourceId: source.id,
      sourceUniqueIdRepresentation: representation,
      ...(representation === 'omitted'
        ? {}
        : { sourceUniqueId: c.sourceUniqueId }),
    };
  }
  return {
    id: d.id,
    uniqueId: p.uniqueId,
    timeCreated: new Date(created).toISOString(),
    sizeGiB: size,
    sku: value.sku.name,
    managedBy: isAudit ? null : profile.compute.vm.id,
    creation,
    encryption: p.encryption,
    networkAccessPolicy: p.networkAccessPolicy,
    publicNetworkAccess: p.publicNetworkAccess,
    ...(kind === 'data'
      ? {}
      : {
          osType: p.osType,
          hyperVGeneration: p.hyperVGeneration,
          securityProfile: p.securityProfile,
        }),
  };
}

function assertNetwork(values, profile, expected) {
  const { nsg, vnet, pip, nic } = values,
    n = profile.compute.network;
  const byId = (id) => expected.find((r) => sameId(r.id, id));
  for (const value of [vnet, pip, nic])
    requirePilot(
      matches(value.properties, byId(value.id).properties),
      'Target network settings differ from the exact static web-only topology.',
    );
  requirePilot(
    [nsg, vnet, pip, nic].every((value) => noNetworkOverlays(value, profile)),
    'Target network has unapproved DNS, routing, peering, service overlays or IP classification.',
  );
  const np = nic.properties,
    vp = vnet.properties,
    pp = pip.properties;
  requirePilot(
    sameId(np.virtualMachine?.id, profile.compute.vm.id) &&
      sameId(vp.subnets[0].id, n.subnet.id) &&
      pip.sku?.name === 'Standard' &&
      (pip.sku.tier == null || pip.sku.tier === 'Regional') &&
      (pp.ipConfiguration == null ||
        sameId(pp.ipConfiguration.id, `${n.nic.id}/ipConfigurations/primary`)),
    'Target network has foreign attachments, DNS, peering, routing or service overlays.',
  );
  const rules = nsg.properties.securityRules,
    wanted = byId(n.nsg.id).properties.securityRules;
  requirePilot(
    Array.isArray(rules) && rules.length === wanted.length,
    'Only two target inbound NSG rules are allowed.',
  );
  for (const rule of wanted) {
    const found = rules.filter((r) => r.name === rule.name);
    const p = found[0]?.properties;
    const ports = p?.destinationPortRanges?.length
      ? p.destinationPortRanges
      : [p?.destinationPortRange];
    const expectedPorts = rule.properties.destinationPortRanges ?? [
      rule.properties.destinationPortRange,
    ];
    requirePilot(
      found.length === 1 &&
        p.priority === rule.properties.priority &&
        p.direction === 'Inbound' &&
        p.access === rule.properties.access &&
        p.protocol?.toLowerCase() === rule.properties.protocol.toLowerCase() &&
        p.sourceAddressPrefix === rule.properties.sourceAddressPrefix &&
        p.sourcePortRange === '*' &&
        p.destinationAddressPrefix ===
          rule.properties.destinationAddressPrefix &&
        isDeepStrictEqual([...ports].sort(), [...expectedPorts].sort()) &&
        !(p.destinationPortRange && p.destinationPortRanges?.length) &&
        !p.sourceAddressPrefixes?.length &&
        !p.sourcePortRanges?.length &&
        !p.destinationAddressPrefixes?.length &&
        !p.sourceApplicationSecurityGroups?.length &&
        !p.destinationApplicationSecurityGroups?.length,
      'Target NSG must allow only Internet TCP80/443 to the exact host and deny all other inbound; SSH stays closed.',
    );
  }
  for (const [field, id] of [
    ['networkInterfaces', n.nic.id],
    ['subnets', n.subnet.id],
  ]) {
    const refs = nsg.properties[field];
    requirePilot(
      refs == null ||
        (Array.isArray(refs) && refs.length === 1 && sameId(refs[0].id, id)),
      'Target NSG reverse attachment contradicts the dedicated NIC/subnet links.',
    );
  }
  validatePublicIpv4(pp.ipAddress);
  requirePilot(
    typeof pp.dnsSettings.fqdn === 'string' &&
      new RegExp(
        `^${n.dnsLabel}(?:[.-][a-z0-9]+)?\\.${profile.compute.location}\\.(?:sysgen\\.)?cloudapp\\.azure\\.com$`,
      ).test(pp.dnsSettings.fqdn),
    'Target public FQDN is not the actual fixed-label regional Azure DNS readback.',
  );
  const identities = {};
  for (const [key, value] of Object.entries({ nsg, vnet, pip, nic })) {
    const guid = value.properties.resourceGuid;
    requirePilot(
      guid == null || uuid.test(guid),
      'Invalid target network resource GUID.',
    );
    identities[key] = {
      id: n[key].id,
      ...(Object.hasOwn(value.properties, 'resourceGuid')
        ? { resourceGuid: guid }
        : {}),
    };
  }
  identities.pip.ipTags = structuredClone(pp.ipTags);
  return {
    resources: identities,
    subnetId: n.subnet.id,
    privateIpv4: n.privateIpv4,
    ipv4: pp.ipAddress,
    fqdn: pp.dnsSettings.fqdn,
  };
}

export function bindHost(values, profile, state, expected, intentAt, previous) {
  target(profile);
  const d = profile.compute.disks,
    vmSpec = expected.find((r) => r.id === profile.compute.vm.id);
  for (const value of Object.values(values)) {
    const implicit = sameId(value?.id, d.os.id);
    const spec = implicit
      ? { ...d.os, location: profile.compute.location }
      : expected.find((r) => sameId(r.id, value?.id));
    requirePilot(spec, 'Unexpected target host readback.');
    owned(value, spec, implicit);
    requirePilot(
      !['Failed', 'Canceled', 'Deleted'].includes(
        value.properties?.provisioningState,
      ),
      'Target host resource failed; retain intent and partial resources without retry.',
    );
  }
  if (
    Object.values(values).some(
      (v) => v.properties?.provisioningState !== 'Succeeded',
    )
  )
    return;
  const vm = values.vm,
    p = vm.properties,
    sp = p.storageProfile,
    os = sp?.osDisk;
  const wanted = structuredClone(vmSpec.properties);
  delete wanted.storageProfile.osDisk.diskSizeGB;
  delete wanted.storageProfile.osDisk.managedDisk.storageAccountType;
  requirePilot(
    matches(p, wanted) &&
      noGuestExecution(vm) &&
      vm.identity?.type === 'SystemAssigned' &&
      uuid.test(p.vmId ?? '') &&
      uuid.test(vm.identity.principalId ?? '') &&
      vm.identity.tenantId === profile.account.tenantId &&
      !Object.keys(vm.identity.userAssignedIdentities ?? {}).length &&
      p.vmId !== state.source.lineage.vmUniqueId &&
      vm.identity.principalId !== state.source.lineage.principalId &&
      sameId(os.managedDisk?.id, d.os.id) &&
      (!Object.hasOwn(os, 'diskSizeGB') || os.diskSizeGB === 32) &&
      (os.managedDisk.storageAccountType == null ||
        os.managedDisk.storageAccountType === 'Standard_LRS') &&
      (sp.dataDisks[0].managedDisk.storageAccountType == null ||
        sp.dataDisks[0].managedDisk.storageAccountType === 'Standard_LRS') &&
      (sp.dataDisks[0].diskSizeGB == null ||
        sp.dataDisks[0].diskSizeGB === 32) &&
      !sp.dataDisks[0].toBeDetached &&
      !os.diffDiskSettings &&
      !os.vhd &&
      !os.image &&
      !os.writeAcceleratorEnabled &&
      !os.managedDisk.diskEncryptionSet &&
      !sp.imageReference.id &&
      !sp.imageReference.sharedGalleryImageId &&
      !sp.imageReference.communityGalleryImageId &&
      (sp.imageReference.exactVersion == null ||
        sp.imageReference.exactVersion === profile.compute.vm.image.version),
    'Target VM image/MI/OS/data/NIC/retention/security or no-guest-execution binding differs; authoritative disks do not excuse a contradictory VM reference.',
  );
  const disks = Object.fromEntries(
    ['os', 'data', 'audit'].map((kind) => [
      kind,
      assertDisk(values[kind], profile, state, kind, intentAt),
    ]),
  );
  const uids = Object.values(disks).map((disk) => disk.uniqueId);
  const retained = [
    state.source.lineage.osDiskUniqueId,
    state.source.lineage.dataDiskUniqueId,
    ...Object.values(state.stages.copy.resources).map((r) => r.uniqueId),
  ];
  requirePilot(
    new Set(uids).size === 3 && uids.every((id) => !retained.includes(id)),
    'Target disks are not distinct new identities.',
  );
  const binding = {
    vm: {
      id: profile.compute.vm.id,
      uniqueId: p.vmId,
      principalId: vm.identity.principalId,
      tenantId: vm.identity.tenantId,
    },
    disks,
    network: assertNetwork(values, profile, expected),
  };
  requirePilot(
    !previous || isDeepStrictEqual(previous, binding),
    'Pinned target host/disk/lineage representation/network binding changed; no rebinding.',
  );
  return binding;
}

export function assertSharedFoundry(value, profile) {
  requirePilot(
    sameId(value?.id, profile.sharedServices.foundry.id) &&
      value.type?.toLowerCase() === 'microsoft.cognitiveservices/accounts' &&
      value.location?.toLowerCase() === profile.sharedServices.location &&
      Object.entries(TAGS).every(([key, v]) => value.tags?.[key] === v) &&
      value.properties?.provisioningState === 'Succeeded' &&
      value.properties.disableLocalAuth === true,
    'Existing shared Foundry account scope/ownership/Entra-only state differs; B1 cannot modify or replace it.',
  );
}
export function bindModelRole(value, profile, principalId, previous) {
  const p = value?.properties,
    role = profile.modelRole;
  requirePilot(
    sameId(value?.id, role.id) &&
      value.name === role.name &&
      value.type?.toLowerCase() === 'microsoft.authorization/roleassignments' &&
      p?.principalId === principalId &&
      p.principalType === 'ServicePrincipal' &&
      sameId(p.roleDefinitionId, role.roleDefinitionId) &&
      sameId(p.scope, role.scope) &&
      !p.condition &&
      !p.conditionVersion &&
      !p.delegatedManagedIdentityResourceId,
    'Model role must be the fixed account-scoped OpenAI User assignment to the actual pinned target MI.',
  );
  const binding = {
    id: role.id,
    principalId,
    principalType: p.principalType,
    roleDefinitionId: role.roleDefinitionId,
    scope: role.scope,
  };
  requirePilot(
    !previous || isDeepStrictEqual(previous, binding),
    'Recorded model role changed; no adoption or rebinding.',
  );
  return binding;
}

export function hostObservation(view, provisioningState) {
  const safe = (value, regex) =>
    typeof value === 'string' && regex.test(value) ? value : 'unavailable';
  const code = (v) => safe(v, /^[A-Za-z][A-Za-z0-9_/.-]{0,127}$/);
  const version = (v) =>
    typeof v === 'string' && v.length <= 64
      ? safe(v, /^[0-9]+(?:\.[0-9]+){1,4}$/)
      : 'unavailable';
  const statuses = (list) =>
    Array.isArray(list) && list.length <= 16
      ? list.map((s) => ({
          code: code(s?.code),
          level: ['Info', 'Warning', 'Error'].includes(s?.level)
            ? s.level
            : 'unavailable',
        }))
      : null;
  requirePilot(
    view?.statuses == null ||
      (Array.isArray(view.statuses) && view.statuses.length <= 16),
    'Target status observation exceeds its bounded shape.',
  );
  const power = (view?.statuses ?? []).filter(
    (s) => typeof s?.code === 'string' && s.code.startsWith('PowerState/'),
  );
  const handlers = view?.agent?.handlers;
  requirePilot(
    handlers == null || (Array.isArray(handlers) && handlers.length <= 32),
    'Target handler observation exceeds its bounded shape.',
  );
  return {
    provisioningState: code(provisioningState),
    power: power?.length === 1 ? code(power[0].code) : 'unavailable',
    agent: {
      version: version(view?.agent?.version),
      statuses: statuses(view?.agent?.statuses),
      handlers:
        handlers == null
          ? null
          : handlers.map((h) => ({
              name: safe(h?.name, /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
              version: version(h?.version),
              status: {
                code: code(h?.code),
                level: ['Info', 'Warning', 'Error'].includes(h?.level)
                  ? h.level
                  : 'unavailable',
              },
            })),
    },
    managementQualified: false,
    bootContainmentVerified: false,
    dataAudited: false,
    applicationActivated: false,
  };
}
