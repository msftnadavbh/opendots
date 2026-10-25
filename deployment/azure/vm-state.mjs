import { createHash, randomUUID } from 'node:crypto';
import {
  SCOPE,
  VM,
  GROUP_ID,
  requirePilot,
  assertOwned,
  validateIdentity,
  validatePublicIpv4,
  validateFqdn,
  FOUNDRY_NAME,
  resourceId,
} from './scope.mjs';
import { readResource, assertOsDisk } from './cloud.mjs';

export const parametersHash = (parameters) =>
  createHash('sha256').update(JSON.stringify(parameters)).digest('hex');
const trackedIds = Object.values(VM.ids).filter((id) => id !== VM.ids.subnetId);
const clockTolerance = 10 * 60_000;
function assertCreationTime(disk, state) {
  const created = Date.parse(disk.properties?.timeCreated);
  requirePilot(
    Number.isFinite(created) &&
      created >= Date.parse(state.creation.absentAt) - clockTolerance &&
      created <= Date.now() + clockTolerance,
    'Disk creation time is inconsistent with the recorded absence; check synchronized clocks and ownership, never recreate it.',
  );
}
function pin(state, values) {
  for (const previous of [state.pins, state.binding])
    requirePilot(
      Object.entries(values).every(
        ([key, value]) =>
          previous?.[key] === undefined || previous[key] === value,
      ),
      'Pinned VM, identity, OS/data disk or network endpoint changed; refusing an ARM update.',
    );
  state.pins = { ...state.pins, ...values };
}
function assertModelRole(role, id, principalId) {
  const scope = resourceId(
    'Microsoft.CognitiveServices/accounts',
    FOUNDRY_NAME,
  );
  requirePilot(
    role.id?.toLowerCase() === id.toLowerCase() &&
      role.properties?.principalId === principalId &&
      role.properties.principalType === 'ServicePrincipal' &&
      role.properties.roleDefinitionId?.toLowerCase() ===
        VM.role.toLowerCase() &&
      (!role.properties.scope ||
        role.properties.scope.toLowerCase() === scope.toLowerCase()),
    'VM model role is not the exact Foundry-scoped OpenAI User assignment.',
  );
}
export function validateVmState(state, parameters) {
  requirePilot(
    state?.version === 2 &&
      state.groupId === GROUP_ID &&
      state.creation?.diskId === VM.ids.dataDiskId &&
      /^[a-f0-9-]{36}$/.test(state.operationId ?? '') &&
      Number.isFinite(Date.parse(state.creation.absentAt)),
    'Missing or foreign VM creation record; never adopt a disk or reuse Sandbox state.',
  );
  if (parameters)
    requirePilot(
      state.parametersHash === parametersHash(parameters),
      'SSH parameters changed; no automatic identity or firewall replacement.',
    );
  requirePilot(
    !state.seenResourceIds ||
      (Array.isArray(state.seenResourceIds) &&
        state.seenResourceIds.every((id) => trackedIds.includes(id))),
    'Invalid tracked VM resource inventory.',
  );
  return state;
}

export function assertVm(vm, parameters) {
  assertOwned(vm, VM.ids.id);
  const p = vm.properties,
    storage = p?.storageProfile,
    linux = p?.osProfile?.linuxConfiguration;
  requirePilot(
    vm.identity?.type === 'SystemAssigned' &&
      vm.identity.tenantId === SCOPE.tenantId &&
      !Object.keys(vm.identity.userAssignedIdentities ?? {}).length &&
      p?.hardwareProfile?.vmSize === VM.size &&
      storage?.diskControllerType === 'NVMe' &&
      Object.entries(VM.image).every(
        ([key, value]) => storage.imageReference?.[key] === value,
      ) &&
      p.securityProfile?.securityType === 'TrustedLaunch' &&
      p.securityProfile.uefiSettings?.secureBootEnabled === true &&
      p.securityProfile.uefiSettings?.vTpmEnabled === true &&
      p.osProfile.adminUsername === VM.admin &&
      linux?.disablePasswordAuthentication === true &&
      linux.provisionVMAgent === true &&
      linux.ssh?.publicKeys?.length === 1 &&
      linux.ssh.publicKeys[0].path === '/home/opendots/.ssh/authorized_keys' &&
      linux.ssh.publicKeys[0].keyData.trim() === parameters.sshPublicKey &&
      storage.osDisk?.managedDisk?.id?.toLowerCase() ===
        VM.ids.osDiskId.toLowerCase() &&
      storage.osDisk.deleteOption === 'Detach' &&
      storage.osDisk.managedDisk.storageAccountType === 'StandardSSD_LRS' &&
      storage.dataDisks?.length === 1 &&
      storage.dataDisks[0].lun === 0 &&
      storage.dataDisks[0].createOption === 'Attach' &&
      storage.dataDisks[0].caching === 'None' &&
      storage.dataDisks[0].deleteOption === 'Detach' &&
      storage.dataDisks[0].managedDisk?.id?.toLowerCase() ===
        VM.ids.dataDiskId.toLowerCase() &&
      p.networkProfile?.networkInterfaces?.length === 1 &&
      p.networkProfile.networkInterfaces[0].id?.toLowerCase() ===
        VM.ids.nicId.toLowerCase(),
    'VM image, identity, SSH, security, NVMe, retained disk attachment or NIC differs. Stop; no automatic replacement.',
  );
  validateIdentity(p.vmId);
  validateIdentity(vm.identity.principalId);
}
export function assertDataDisk(disk, vmAttached = false) {
  assertOwned(disk, VM.ids.dataDiskId);
  requirePilot(
    disk.sku?.name === 'StandardSSD_LRS' &&
      disk.properties?.diskSizeGB === 32 &&
      disk.properties.creationData?.createOption === 'Empty' &&
      disk.properties.networkAccessPolicy === 'DenyAll' &&
      disk.properties.publicNetworkAccess === 'Disabled' &&
      (!vmAttached ||
        disk.managedBy?.toLowerCase() === VM.ids.id.toLowerCase()),
    'Data disk type, size, export policy or attachment differs.',
  );
  validateIdentity(disk.properties.uniqueId);
}

// This record is written before ARM; a pre-existing disk can never obtain a fresh format permit.
export async function recordDeployment(az, parameters, saved, save) {
  const inventory = await az.read([
    'resource',
    'list',
    '--resource-group',
    SCOPE.resourceGroup,
  ]);
  const exists = (id) =>
    inventory.some(
      (resource) => resource.id.toLowerCase() === id.toLowerCase(),
    );
  let state;
  if (!saved) {
    requirePilot(
      Object.values(VM.ids).every((id) => !exists(id)),
      'VM resources already exist without a tracked creation operation; refusing adoption.',
    );
    state = {
      version: 2,
      groupId: GROUP_ID,
      operationId: randomUUID(),
      parametersHash: parametersHash(parameters),
      creation: {
        diskId: VM.ids.dataDiskId,
        absentAt: new Date().toISOString(),
      },
    };
  } else state = structuredClone(validateVmState(saved, parameters));
  const foundryId = resourceId(
    'Microsoft.CognitiveServices/accounts',
    FOUNDRY_NAME,
  );
  if (exists(foundryId)) {
    const account = await readResource(az, foundryId, '2025-06-01');
    assertOwned(account, foundryId);
    requirePilot(
      account.properties?.disableLocalAuth === true,
      'Foundry must remain Entra-only before an ARM update.',
    );
    if (account.identity?.type === 'SystemAssigned') {
      requirePilot(
        account.identity.tenantId === SCOPE.tenantId &&
          !Object.keys(account.identity.userAssignedIdentities ?? {}).length &&
          (!state.foundryPrincipalId ||
            state.foundryPrincipalId === account.identity.principalId),
        'Foundry identity changed; refusing replacement.',
      );
      state.foundryPrincipalId = validateIdentity(account.identity.principalId);
    } else
      requirePilot(
        !state.foundryPrincipalId &&
          [undefined, 'None'].includes(account.identity?.type),
        'Only the initial no-identity to SystemAssigned Foundry transition is approved.',
      );
  } else
    requirePilot(
      !state.foundryPrincipalId,
      'Tracked Foundry account is missing.',
    );
  const projectId = `${foundryId}/projects/opendots`;
  if (exists(projectId)) {
    const project = await readResource(az, projectId, '2025-06-01');
    assertOwned(project, projectId);
    requirePilot(
      project.identity?.type === 'SystemAssigned' &&
        project.identity.tenantId === SCOPE.tenantId &&
        (!state.projectPrincipalId ||
          state.projectPrincipalId === project.identity.principalId),
      'Foundry project identity differs; no replacement is allowed.',
    );
    state.projectPrincipalId = validateIdentity(project.identity.principalId);
  } else
    requirePilot(
      !state.projectPrincipalId,
      'Tracked Foundry project is missing.',
    );
  const previouslySeen = state.binding
    ? trackedIds
    : (state.seenResourceIds ?? []);
  requirePilot(
    previouslySeen.every(exists),
    'A tracked VM/network/disk resource is missing; refusing recreation.',
  );
  const network = {};
  for (const [key, id] of [
    ['nic', VM.ids.nicId],
    ['pip', VM.ids.publicIpId],
    ['nsg', VM.ids.nsgId],
    ['vnet', VM.ids.vnetId],
  ])
    if (exists(id)) network[key] = await readResource(az, id, '2025-05-01');
  assertNetwork(network);
  if (network.pip)
    pin(state, {
      ipv4: network.pip.properties.ipAddress,
      fqdn: network.pip.properties.dnsSettings.fqdn,
    });
  if (exists(VM.ids.dataDiskId)) {
    const disk = await readResource(az, VM.ids.dataDiskId, '2025-01-02');
    assertDataDisk(disk);
    assertCreationTime(disk, state);
    requirePilot(
      !state.creation.uniqueId ||
        state.creation.uniqueId === disk.properties.uniqueId,
      'Tracked data disk was replaced.',
    );
    state.creation.uniqueId = disk.properties.uniqueId;
    pin(state, {
      diskId: VM.ids.dataDiskId,
      diskUniqueId: disk.properties.uniqueId,
    });
  } else
    requirePilot(
      !state.creation.uniqueId,
      'Tracked data disk is missing; refusing recreation.',
    );
  if (exists(VM.ids.id)) {
    const vm = await readResource(az, VM.ids.id, '2025-11-01');
    assertVm(vm, parameters);
    requirePilot(
      !state.seenVmUniqueId || state.seenVmUniqueId === vm.properties.vmId,
      'Tracked VM was replaced.',
    );
    state.seenVmUniqueId = vm.properties.vmId;
    pin(state, {
      vmId: VM.ids.id,
      vmUniqueId: vm.properties.vmId,
      principalId: vm.identity.principalId,
      tenantId: vm.identity.tenantId,
    });
    requirePilot(
      exists(VM.ids.osDiskId),
      'VM OS disk is missing; refusing recreation.',
    );
    const os = await readResource(az, VM.ids.osDiskId, '2025-01-02');
    assertOsDisk(os, vm);
    pin(state, {
      osDiskId: VM.ids.osDiskId,
      osDiskUniqueId: validateIdentity(os.properties?.uniqueId),
    });
    if (state.modelRoleAssignmentId)
      assertModelRole(
        await readResource(az, state.modelRoleAssignmentId, '2022-04-01'),
        state.modelRoleAssignmentId,
        vm.identity.principalId,
      );
  } else
    requirePilot(
      !state.seenVmUniqueId,
      'Tracked VM is missing; refusing recreation.',
    );
  if (!exists(VM.ids.id))
    requirePilot(
      !exists(VM.ids.osDiskId),
      'Orphan OS disk requires manual reconciliation; no adoption or deletion.',
    );
  state.seenResourceIds = trackedIds.filter(exists);
  await save(state);
  return state;
}

export function assertNetwork({ nic, pip, nsg, vnet }) {
  for (const [key, resource] of Object.entries({ nic, nsg, vnet }))
    if (resource) assertOwned(resource, VM.ids[`${key}Id`]);
  if (pip) assertOwned(pip, VM.ids.publicIpId);
  if (nic) {
    const config = nic.properties?.ipConfigurations;
    requirePilot(
      nic.properties?.enableIPForwarding === false &&
        config?.length === 1 &&
        nic.properties.networkSecurityGroup?.id?.toLowerCase() ===
          VM.ids.nsgId.toLowerCase() &&
        config[0].properties?.subnet?.id?.toLowerCase() ===
          VM.ids.subnetId.toLowerCase() &&
        config[0].properties.publicIPAddress?.id?.toLowerCase() ===
          VM.ids.publicIpId.toLowerCase() &&
        !nic.properties.dnsSettings?.dnsServers?.length,
      'VM network attachment or DNS differs.',
    );
  }
  if (vnet)
    requirePilot(
      vnet.properties?.subnets?.length === 1 &&
        vnet.properties.subnets[0].name === 'app' &&
        vnet.properties.subnets[0].properties?.addressPrefix ===
          '10.42.0.0/24' &&
        JSON.stringify(vnet.properties.addressSpace?.addressPrefixes) ===
          '["10.42.0.0/24"]' &&
        !vnet.properties.virtualNetworkPeerings?.length &&
        !vnet.properties.dhcpOptions?.dnsServers?.length &&
        !vnet.properties.subnets[0].properties.routeTable &&
        !vnet.properties.subnets[0].properties.natGateway &&
        !vnet.properties.subnets[0].properties.delegations?.length,
      'VM network attachment or address space differs.',
    );
  if (pip) {
    requirePilot(
      pip.sku?.name === 'Standard' &&
        pip.properties?.publicIPAllocationMethod === 'Static' &&
        pip.properties.publicIPAddressVersion === 'IPv4' &&
        pip.properties.dnsSettings?.domainNameLabel === VM.dnsLabel &&
        pip.properties.dnsSettings.domainNameLabelScope ===
          'ResourceGroupReuse',
      'Public IP or DNS policy differs.',
    );
    validatePublicIpv4(pip.properties.ipAddress);
    validateFqdn(pip.properties.dnsSettings.fqdn);
  }
  if (!nsg) return;
  const rules = nsg.properties?.securityRules;
  requirePilot(
    rules?.length === 2,
    'Expected exactly the two governance-approved NSG rules; SSH must remain closed.',
  );
  const expected = [
    ['https-and-acme', 100, 'Allow', 'Tcp', 'Internet', ['80', '443']],
    ['deny-other-inbound', 4096, 'Deny', '*', '*', ['*']],
  ];
  for (const [name, priority, access, protocol, source, ports] of expected) {
    const p = rules.find((rule) => rule.name === name)?.properties;
    requirePilot(
      p?.priority === priority &&
        p.direction === 'Inbound' &&
        p.access === access &&
        p.protocol?.toLowerCase() === protocol.toLowerCase() &&
        p.sourceAddressPrefix === source &&
        !p.sourceAddressPrefixes?.length &&
        !p.sourceApplicationSecurityGroups?.length &&
        p.sourcePortRange === '*' &&
        !p.sourcePortRanges?.length &&
        p.destinationAddressPrefix === '*' &&
        !p.destinationAddressPrefixes?.length &&
        !p.destinationApplicationSecurityGroups?.length &&
        !(p.destinationPortRange && p.destinationPortRanges?.length) &&
        JSON.stringify(
          (p.destinationPortRanges?.length
            ? [...p.destinationPortRanges]
            : [p.destinationPortRange]
          ).sort(),
        ) === JSON.stringify([...ports].sort()),
      'NSG must retain exactly HTTPS/ACME and deny-other-inbound; no SSH, alternate management port or broader ingress.',
    );
  }
}

export async function verifyVm(az, output, parameters, saved, save) {
  const state = structuredClone(validateVmState(saved, parameters));
  await az.verify();
  const resources = {};
  for (const [key, id, api] of [
    ['vm', VM.ids.id, '2025-11-01'],
    ['disk', VM.ids.dataDiskId, '2025-01-02'],
    ['os', VM.ids.osDiskId, '2025-01-02'],
    ['nic', VM.ids.nicId, '2025-05-01'],
    ['pip', VM.ids.publicIpId, '2025-05-01'],
    ['nsg', VM.ids.nsgId, '2025-05-01'],
    ['vnet', VM.ids.vnetId, '2025-05-01'],
  ])
    resources[key] = await readResource(az, id, api);
  const { vm, disk, os, pip } = resources;
  assertVm(vm, parameters);
  assertDataDisk(disk, true);
  assertOsDisk(os, vm);
  requirePilot(
    ['nic', 'pip', 'nsg', 'vnet'].every((key) => resources[key]),
    'VM network resources are incomplete.',
  );
  assertNetwork(resources);
  requirePilot(
    vm.properties.provisioningState === 'Succeeded' &&
      disk.properties.provisioningState === 'Succeeded',
    'VM/disk is not ready or disk creation is not attributable to the recorded operation.',
  );
  assertCreationTime(disk, state);
  const binding = {
    vmId: VM.ids.id,
    vmUniqueId: vm.properties.vmId,
    principalId: vm.identity.principalId,
    tenantId: vm.identity.tenantId,
    diskId: VM.ids.dataDiskId,
    diskUniqueId: disk.properties.uniqueId,
    osDiskId: VM.ids.osDiskId,
    osDiskUniqueId: validateIdentity(os.properties?.uniqueId),
    nicId: VM.ids.nicId,
    publicIpId: VM.ids.publicIpId,
    ipv4: pip.properties.ipAddress,
    fqdn: pip.properties.dnsSettings.fqdn,
  };
  requirePilot(
    (!state.creation.uniqueId ||
      state.creation.uniqueId === binding.diskUniqueId) &&
      (!state.seenVmUniqueId || state.seenVmUniqueId === binding.vmUniqueId),
    'Tracked VM or data disk identity changed.',
  );
  if (state.binding)
    requirePilot(
      Object.entries(binding).every(
        ([key, value]) => state.binding[key] === value,
      ),
      'Pinned VM, identity, OS disk, data disk, NIC or endpoint changed; no silent pin refresh.',
    );
  pin(state, binding);
  requirePilot(
    output.vm.uniqueId === binding.vmUniqueId &&
      output.vm.principalId === binding.principalId &&
      output.vm.dataDiskUniqueId === binding.diskUniqueId &&
      output.vm.ipv4 === binding.ipv4 &&
      output.vm.fqdn === binding.fqdn,
    'ARM outputs do not match live VM bindings.',
  );
  const role = await readResource(
    az,
    output.modelRoleAssignmentId,
    '2022-04-01',
  );
  assertModelRole(role, output.modelRoleAssignmentId, binding.principalId);
  state.binding = binding;
  state.creation.uniqueId = binding.diskUniqueId;
  state.seenVmUniqueId = binding.vmUniqueId;
  state.seenResourceIds = [...trackedIds];
  state.modelRoleAssignmentId = output.modelRoleAssignmentId;
  requirePilot(
    !state.foundryPrincipalId ||
      state.foundryPrincipalId === output.foundryPrincipalId,
    'Pinned Foundry identity changed.',
  );
  state.foundryPrincipalId = validateIdentity(output.foundryPrincipalId);
  requirePilot(
    !state.projectPrincipalId ||
      state.projectPrincipalId === output.projectPrincipalId,
    'Pinned project identity changed.',
  );
  state.projectPrincipalId = validateIdentity(output.projectPrincipalId);
  await save(state);
  const view = await az.read([
    'vm',
    'get-instance-view',
    '--ids',
    VM.ids.id,
    '--query',
    'instanceView.statuses',
  ]);
  const power = view?.find((item) =>
    item.code?.startsWith('PowerState/'),
  )?.code;
  requirePilot(typeof power === 'string', 'VM power state unavailable.');
  return { state, power };
}

export function diskPlan(state) {
  validateVmState(state);
  requirePilot(
    state.binding?.diskId === state.creation.diskId &&
      state.binding.diskUniqueId === state.creation.uniqueId,
    'No bound new-disk format permit.',
  );
  return {
    operationId: state.operationId,
    vmUniqueId: state.binding.vmUniqueId,
    diskId: state.binding.diskId,
    diskUniqueId: state.binding.diskUniqueId,
    fsUuid: state.fsUuid ?? null,
    allowFormat: !state.fsUuid,
  };
}
