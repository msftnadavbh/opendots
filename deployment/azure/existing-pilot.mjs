import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  SCOPE,
  TAGS,
  VM,
  requirePilot,
  resourceId,
  validateOutputs,
  validateImage,
  assertOwned,
} from './scope.mjs';
import {
  assertOsDiskAttachment,
  inspectOwnedInventory,
  readResource,
  verifyLiveResources,
} from './cloud.mjs';
import {
  assertDataDiskProperties,
  assertNetwork,
  assertVmBindings,
  assertVmConfiguration,
  readVmResources,
  validateVmState,
} from './vm-state.mjs';
import { INITIAL_IMAGE } from './initial-activation.mjs';

export const GOVERNANCE_NSG_ID = resourceId(
  'Microsoft.Network/networkSecurityGroups',
  'vnet-opendots-pilot-app-nsg-eastus2',
);
const governanceResourceGuid = 'ea14dfd0-7317-47a2-bd0d-0c3271f4d50d';
const webRuleId = `${GOVERNANCE_NSG_ID}/securityRules/opendots-web`;
const privateIpv4 = '10.42.0.4';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const trackedIds = Object.values(VM.ids).filter((id) => id !== VM.ids.subnetId);
const sameId = (left, right) =>
  typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value, null, 2) + '\n')
    .digest('hex');
const webRule = () => ({
  priority: 100,
  direction: 'Inbound',
  access: 'Allow',
  protocol: 'tcp',
  sourceAddressPrefix: 'Internet',
  sourcePortRange: '*',
  destinationAddressPrefix: `${privateIpv4}/32`,
  destinationPorts: ['443', '80'],
});
const configuration = () => ({
  diskSku: 'Standard_LRS',
  dataDiskTags: 'absent',
  privateIpv4,
  governanceNsg: {
    id: GOVERNANCE_NSG_ID,
    management: 'external',
    tags: { ...TAGS },
    resourceGuid: governanceResourceGuid,
    subnetId: VM.ids.subnetId,
    rule: webRule(),
  },
});
function withoutEvidence(state) {
  const value = structuredClone(state);
  delete value.existingPilot;
  return value;
}
function immutable(state) {
  const value = withoutEvidence(state);
  for (const key of [
    'image',
    'management',
    'initialActivationRecovery',
    'provisioned',
    'configured',
    'pullOperationId',
  ])
    delete value[key];
  return value;
}

function originalState(state, parameters, output) {
  validateVmState(state, parameters);
  const b = state.binding;
  requirePilot(
    b &&
      b.vmId === VM.ids.id &&
      b.diskId === VM.ids.dataDiskId &&
      b.osDiskId === VM.ids.osDiskId &&
      b.nicId === VM.ids.nicId &&
      b.publicIpId === VM.ids.publicIpId &&
      b.tenantId === SCOPE.tenantId &&
      ['vmUniqueId', 'principalId', 'diskUniqueId', 'osDiskUniqueId'].every(
        (key) => uuid.test(b[key] ?? ''),
      ) &&
      state.creation.uniqueId === b.diskUniqueId &&
      state.seenVmUniqueId === b.vmUniqueId &&
      state.pins &&
      Object.entries(b).every(([key, value]) => state.pins[key] === value) &&
      Array.isArray(state.seenResourceIds) &&
      isDeepStrictEqual(
        [...state.seenResourceIds].sort(),
        [...trackedIds].sort(),
      ) &&
      uuid.test(state.fsUuid ?? '') &&
      state.modelRoleAssignmentId === output.modelRoleAssignmentId &&
      state.foundryPrincipalId === output.foundryPrincipalId &&
      state.projectPrincipalId === output.projectPrincipalId,
    'Existing-pilot operations require the complete original creation record, immutable pins, filesystem and ARM identity/role bindings; no adoption or pin learning.',
  );
  validateImage(state.image, output);
}

export function assertExistingEvidence(state, output) {
  const e = state?.existingPilot;
  requirePilot(
    e &&
      isDeepStrictEqual(
        Object.keys(e).sort(),
        [
          'version',
          'initialStateSha256',
          'immutableStateSha256',
          'outputsSha256',
          'configuration',
          'stateSha256',
          'reconciledAt',
        ].sort(),
      ) &&
      e.version === 1 &&
      sha.test(e.initialStateSha256) &&
      sha.test(e.outputsSha256) &&
      e.immutableStateSha256 === digest(immutable(state)) &&
      e.stateSha256 === digest(withoutEvidence(state)) &&
      isDeepStrictEqual(e.configuration, configuration()) &&
      Number.isFinite(Date.parse(e.reconciledAt)) &&
      Date.parse(e.reconciledAt) <= Date.now() &&
      (!output || e.outputsSha256 === digest(output)),
    'Existing-pilot reconciliation evidence is missing, stale or changed; never refresh immutable pins or reuse an earlier state hash as current proof.',
  );
}

// One atomic private state save carries both the real receipt and its updated proof.
export function existingPilotSave(state, save) {
  assertExistingEvidence(state);
  const { stateSha256: _hash, ...anchor } = structuredClone(
    state.existingPilot,
  );
  let poisoned = false;
  return async (next) => {
    requirePilot(
      !poisoned,
      'Existing-pilot durability is uncertain; reload persistent state.',
    );
    const { stateSha256: _nextHash, ...record } = next.existingPilot ?? {};
    requirePilot(
      isDeepStrictEqual(record, anchor) &&
        digest(immutable(next)) === anchor.immutableStateSha256,
      'Existing-pilot immutable state or reconciliation anchor changed; no pin/proof rewrite.',
    );
    const evidence = { ...anchor, stateSha256: digest(withoutEvidence(next)) };
    try {
      await save({ ...next, existingPilot: evidence });
    } catch (error) {
      poisoned = true;
      throw error;
    }
    next.existingPilot = evidence;
    state.existingPilot = evidence;
  };
}

function missingDataTags(resource) {
  requirePilot(
    sameId(resource?.id, VM.ids.dataDiskId) &&
      resource.location?.toLowerCase() === SCOPE.location &&
      (resource.tags == null || isDeepStrictEqual(resource.tags, {})),
    'Only the exact original data disk with absent tags is recognized; partial, restored or conflicting ownership tags are not this reconciliation profile.',
  );
}

function ruleShape(rule) {
  const p = rule?.properties;
  requirePilot(
    p &&
      [
        'sourceAddressPrefixes',
        'destinationAddressPrefixes',
        'sourcePortRanges',
        'sourceApplicationSecurityGroups',
        'destinationApplicationSecurityGroups',
      ].every(
        (key) =>
          p[key] == null || (Array.isArray(p[key]) && p[key].length === 0),
      ) &&
      (p.destinationPortRanges == null ||
        Array.isArray(p.destinationPortRanges)) &&
      !(p.destinationPortRange && p.destinationPortRanges?.length) &&
      (p.provisioningState == null || p.provisioningState === 'Succeeded'),
    'Governance NSG rule is ambiguous, transitional or uses an unapproved address/port/ASG form.',
  );
  return {
    priority: p.priority,
    direction: p.direction,
    access: p.access,
    protocol: p.protocol?.toLowerCase(),
    sourceAddressPrefix: p.sourceAddressPrefix,
    sourcePortRange: p.sourcePortRange,
    destinationAddressPrefix:
      p.destinationAddressPrefix === privateIpv4
        ? `${privateIpv4}/32`
        : p.destinationAddressPrefix,
    destinationPorts: (p.destinationPortRanges?.length
      ? [...p.destinationPortRanges]
      : [p.destinationPortRange]
    ).sort(),
  };
}

function assertWebRule(rule) {
  requirePilot(
    rule?.name === 'opendots-web' &&
      sameId(rule.id, webRuleId) &&
      isDeepStrictEqual(ruleShape(rule), webRule()),
    'The exact approved opendots-web TCP 80/443 single-host rule is missing or changed; no fallback, retarget or network repair.',
  );
}

function assertGovernanceNsg(nsg) {
  const p = nsg?.properties;
  requirePilot(
    sameId(nsg?.id, GOVERNANCE_NSG_ID) &&
      nsg.type?.toLowerCase() === 'microsoft.network/networksecuritygroups' &&
      nsg.location?.toLowerCase() === SCOPE.location &&
      p?.provisioningState === 'Succeeded' &&
      isDeepStrictEqual(nsg.tags, TAGS) &&
      p.resourceGuid === governanceResourceGuid &&
      Array.isArray(p.subnets) &&
      p.subnets.length === 1 &&
      sameId(p.subnets[0].id, VM.ids.subnetId) &&
      (p.networkInterfaces == null ||
        (Array.isArray(p.networkInterfaces) &&
          p.networkInterfaces.length === 0)) &&
      Array.isArray(p.securityRules) &&
      p.securityRules.length === 1,
    'Governance NSG must remain externally managed, attached only to app subnet, with only the approved web rule.',
  );
  assertWebRule(p.securityRules[0]);
  const defaults = [
    [
      'AllowVnetInBound',
      65000,
      'Inbound',
      'Allow',
      'VirtualNetwork',
      'VirtualNetwork',
    ],
    [
      'AllowAzureLoadBalancerInBound',
      65001,
      'Inbound',
      'Allow',
      'AzureLoadBalancer',
      '*',
    ],
    ['DenyAllInBound', 65500, 'Inbound', 'Deny', '*', '*'],
    [
      'AllowVnetOutBound',
      65000,
      'Outbound',
      'Allow',
      'VirtualNetwork',
      'VirtualNetwork',
    ],
    ['AllowInternetOutBound', 65001, 'Outbound', 'Allow', '*', 'Internet'],
    ['DenyAllOutBound', 65500, 'Outbound', 'Deny', '*', '*'],
  ];
  requirePilot(
    Array.isArray(p.defaultSecurityRules) &&
      p.defaultSecurityRules.length === defaults.length,
    'Complete governance NSG default rule profile is unavailable.',
  );
  for (const [
    name,
    priority,
    direction,
    access,
    source,
    destination,
  ] of defaults) {
    const matches = p.defaultSecurityRules.filter((rule) => rule.name === name);
    requirePilot(
      matches.length === 1 &&
        isDeepStrictEqual(ruleShape(matches[0]), {
          priority,
          direction,
          access,
          protocol: '*',
          sourceAddressPrefix: source,
          sourcePortRange: '*',
          destinationAddressPrefix: destination,
          destinationPorts: ['*'],
        }),
      'Governance NSG default deny/routing profile changed.',
    );
  }
}

async function inspectExisting(az, output, parameters, state) {
  validateOutputs(output);
  originalState(state, parameters, output);
  await verifyLiveResources(az, output);
  const resources = await readVmResources(az);
  const { vm, disk, os, nic, vnet } = resources;
  assertVmConfiguration(vm, parameters);
  missingDataTags(disk);
  assertDataDiskProperties(disk, true);
  assertOsDiskAttachment(os, vm);
  requirePilot(
    disk.sku?.name === 'Standard_LRS' &&
      os.sku?.name === 'Standard_LRS' &&
      vm.properties.storageProfile.osDisk.managedDisk.storageAccountType ===
        'Standard_LRS' &&
      (vm.properties.storageProfile.dataDisks[0].managedDisk
        .storageAccountType == null ||
        vm.properties.storageProfile.dataDisks[0].managedDisk
          .storageAccountType === 'Standard_LRS') &&
      disk.properties.provisioningState === 'Succeeded' &&
      os.properties.provisioningState === 'Succeeded',
    'Only the observed Standard_LRS original disks are eligible; no third SKU or incomplete disks.',
  );
  requirePilot(
    ['nic', 'pip', 'nsg', 'vnet'].every((key) => resources[key]),
    'Existing VM network inventory is incomplete.',
  );
  assertNetwork(resources);
  const ip = nic.properties.ipConfigurations[0];
  requirePilot(
    sameId(nic.properties.virtualMachine?.id, VM.ids.id) &&
      ip.name === 'primary' &&
      ip.properties.primary === true &&
      ip.properties.privateIPAllocationMethod === 'Dynamic' &&
      ip.properties.privateIPAddress === privateIpv4 &&
      sameId(
        vnet.properties.subnets[0].properties.networkSecurityGroup?.id,
        GOVERNANCE_NSG_ID,
      ),
    'Original NIC/private IPv4 or governed subnet attachment changed; never retarget the web rule.',
  );
  const governance = await readResource(az, GOVERNANCE_NSG_ID, '2025-05-01');
  assertGovernanceNsg(governance);
  await assertVmBindings(az, output, state, resources);
  const inventory = await az.read([
    'resource',
    'list',
    '--resource-group',
    SCOPE.resourceGroup,
  ]);
  requirePilot(
    Array.isArray(inventory) &&
      inventory.every((item) => typeof item?.id === 'string') &&
      new Set(inventory.map((item) => item.id.toLowerCase())).size ===
        inventory.length &&
      [...trackedIds, GOVERNANCE_NSG_ID].every((id) =>
        inventory.some((item) => sameId(item.id, id)),
      ),
    'Complete original resource inventory is required; missing, duplicate or unknown resources cannot be adopted.',
  );
  const ordinary = [];
  for (const item of inventory) {
    if (sameId(item.id, VM.ids.dataDiskId)) missingDataTags(item);
    else if (sameId(item.id, VM.ids.osDiskId)) {
      // The authoritative disk read above keeps the strict attachment/tag checks without its deployment SKU.
      requirePilot(
        item.location?.toLowerCase() === SCOPE.location,
        'OS disk inventory scope changed.',
      );
      if (Object.keys(item.tags ?? {}).length)
        assertOwned(item, VM.ids.osDiskId);
    } else if (sameId(item.id, GOVERNANCE_NSG_ID)) {
      requirePilot(
        item.location?.toLowerCase() === SCOPE.location &&
          isDeepStrictEqual(item.tags, TAGS),
        'External governance NSG inventory must retain the exact copied tag dictionary; tags do not grant ownership.',
      );
    } else if (sameId(item.id, webRuleId)) {
      assertWebRule(await readResource(az, webRuleId, '2025-05-01'));
    } else ordinary.push(item);
  }
  // Only the four explicitly checked exceptions are removed; all other closed-inventory checks are shared with ARM.
  await inspectOwnedInventory(az, ordinary, state);
  const view = await az.read([
    'vm',
    'get-instance-view',
    '--ids',
    VM.ids.id,
    '--query',
    'instanceView.statuses',
  ]);
  const power = Array.isArray(view)
    ? view.filter((item) => item.code?.startsWith('PowerState/'))
    : [];
  requirePilot(power.length === 1, 'Existing VM power state is unavailable.');
  return {
    state,
    power: power[0].code,
    provisioningState: vm.properties.provisioningState,
  };
}

// No ARM/power/network write, binding update, format permit or implicit evidence creation.
export async function verifyExistingPilot(az, output, parameters, state) {
  assertExistingEvidence(state, output);
  return inspectExisting(az, output, parameters, state);
}

export async function reconcileExistingPilot(
  az,
  output,
  parameters,
  state,
  save,
) {
  if (state && Object.hasOwn(state, 'existingPilot'))
    return verifyExistingPilot(az, output, parameters, state);
  requirePilot(
    state &&
      !state.management?.pending &&
      !state.pullOperationId &&
      !state.initialActivationRecovery &&
      !state.provisioned &&
      !state.configured &&
      state.image === INITIAL_IMAGE,
    'Initial existing-pilot reconciliation requires no activation, pending operation or recovery transaction; retain all existing facts.',
  );
  const verified = await inspectExisting(az, output, parameters, state);
  requirePilot(
    verified.power === 'PowerState/running' &&
      verified.provisioningState === 'Succeeded',
    'Initial reconciliation requires the original VM running and successfully provisioned; no automatic power start.',
  );
  const next = {
    ...state,
    existingPilot: {
      version: 1,
      initialStateSha256: digest(state),
      immutableStateSha256: digest(immutable(state)),
      outputsSha256: digest(output),
      configuration: configuration(),
      stateSha256: digest(state),
      reconciledAt: new Date().toISOString(),
    },
  };
  await save(next);
  return { ...verified, state: next };
}
