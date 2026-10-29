import { isDeepStrictEqual } from 'node:util';
import { SCOPE, requirePilot } from './scope.mjs';
import { SCUS_PROFILE, assertProfile } from './profiles.mjs';
import { assertVmConfiguration } from './vm-state.mjs';
import { hashObject } from './migration-state.mjs';
import {
  isHostStage,
  hostDescriptors,
  hostParameters,
  hostResources,
  assertHostTemplate,
  assertHostWhatIf,
} from './migration-host.mjs';

const sameId = (a, b) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const time = (value) => {
  requirePilot(
    typeof value === 'string' && Number.isFinite(Date.parse(value)),
    'Required provider identity/transition timestamp is unavailable.',
  );
  return new Date(value).toISOString();
};
export function requireStage(profile, stage) {
  assertProfile(profile);
  requirePilot(
    profile === SCUS_PROFILE && Object.hasOwn(profile.stages, stage),
    'Only target group/capture/copy/host/model-role stages exist; audit/configure/activate and guest commands are unavailable.',
  );
  return profile.stages[stage];
}
export function deploymentId(profile, stage) {
  const plan = requireStage(profile, stage);
  return `${plan.scope === 'sub' ? `/subscriptions/${profile.account.subscriptionId}` : (plan.groupId ?? profile.compute.groupId)}/providers/Microsoft.Resources/deployments/${plan.deploymentName}`;
}
export const stageResourceGroup = (profile, stage) =>
  requireStage(profile, stage).resourceGroup ?? profile.compute.resourceGroup;
export const stageIds = (profile, stage) => {
  requireStage(profile, stage);
  if (stage === 'host') return hostDescriptors(profile).map((r) => r.id);
  if (stage === 'model-role') return [profile.modelRole.id];
  return stage === 'group'
    ? [profile.compute.groupId]
    : (stage === 'capture'
        ? ['sourceOs', 'sourceData']
        : ['targetOs', 'targetData']
      ).map((key) => profile.sourcePreservation.snapshots[key].id);
};
export function assertStageOutputs(items, profile, stage) {
  const declared = stageIds(profile, stage).map((id) => id.toLowerCase());
  const allowed = [
    ...declared,
    ...(stage === 'host' ? [profile.compute.disks.os.id.toLowerCase()] : []),
  ];
  requirePilot(
    Array.isArray(items) && items.every((r) => typeof r?.id === 'string'),
    'Deployment output-resource graph is unavailable.',
  );
  const actual = items.map((r) => r.id.toLowerCase());
  requirePilot(
    new Set(actual).size === actual.length &&
      declared.every((id) => actual.includes(id)) &&
      actual.every((id) => allowed.includes(id)),
    'Deployment output-resource graph differs; only host may additionally report its exact implicit fresh OS disk.',
  );
}
export function stageTags(profile, state, stage) {
  return {
    ...profile.tags,
    migrationId: state.migrationId,
    sourceArchiveSha256: state.source.archiveSha256,
    stage,
  };
}
export function desiredResources(profile, state, stage) {
  requireStage(profile, stage);
  const tags = stageTags(profile, state, stage);
  if (isHostStage(stage)) return hostResources(profile, state, stage, tags);
  if (stage === 'group')
    return [
      {
        id: profile.compute.groupId,
        name: profile.compute.resourceGroup,
        type: 'Microsoft.Resources/resourceGroups',
        apiVersion: '2024-03-01',
        location: profile.compute.location,
        tags,
      },
    ];
  return ['os', 'data'].map((kind) => {
    const key = kind === 'os' ? 'Os' : 'Data';
    const target =
      profile.sourcePreservation.snapshots[
        `${stage === 'capture' ? 'source' : 'target'}${key}`
      ];
    const source =
      stage === 'capture'
        ? {
            id: state.source.lineage[`${kind}DiskId`],
            uniqueId: state.source.lineage[`${kind}DiskUniqueId`],
          }
        : state.stages.capture.resources[kind];
    return {
      ...target,
      type: 'Microsoft.Compute/snapshots',
      apiVersion: '2025-01-02',
      tags: { ...tags, expectedSourceUniqueId: source.uniqueId },
      sku: { name: 'Standard_LRS' },
      properties: {
        creationData: {
          createOption: stage === 'capture' ? 'Copy' : 'CopyStart',
          sourceResourceId: source.id,
        },
        incremental: true,
        diskSizeGB: kind === 'os' ? 30 : 32,
        ...(kind === 'os'
          ? {
              osType: 'Linux',
              hyperVGeneration: 'V2',
              securityProfile: { securityType: 'TrustedLaunch' },
            }
          : {}),
        encryption: { type: 'EncryptionAtRestWithPlatformKey' },
        networkAccessPolicy: 'DenyAll',
        publicNetworkAccess: 'Disabled',
      },
    };
  });
}
export function stageParameters(profile, state, stage) {
  if (isHostStage(stage)) return hostParameters(profile, state, stage);
  const resources = desiredResources(profile, state, stage);
  return {
    migrationId: { value: state.migrationId },
    sourceArchiveSha256: { value: state.source.archiveSha256 },
    ...(stage === 'group'
      ? {}
      : {
          osSourceUniqueId: { value: resources[0].tags.expectedSourceUniqueId },
          dataSourceUniqueId: {
            value: resources[1].tags.expectedSourceUniqueId,
          },
        }),
  };
}

export function assertStageTemplate(profile, state, stage, template) {
  if (isHostStage(stage))
    return assertHostTemplate(
      profile,
      state,
      stage,
      template,
      stageTags(profile, state, stage),
    );
  const expected = desiredResources(profile, state, stage);
  const values = Object.fromEntries(
    Object.keys(stageParameters(profile, state, stage)).map((key) => [
      key,
      `[parameters('${key}')]`,
    ]),
  );
  const tags = {
    ...stageTags(profile, state, stage),
    migrationId: values.migrationId,
    sourceArchiveSha256: values.sourceArchiveSha256,
  };
  const account = `and(equals(subscription().subscriptionId, '${SCOPE.subscriptionId}'), equals(tenant().tenantId, '${SCOPE.tenantId}'))`;
  const authorized = `[${stage === 'group' ? account : `and(${account}, equals(resourceGroup().name, '${profile.compute.resourceGroup}'))`}]`;
  const schema =
    stage === 'group'
      ? '2018-05-01/subscriptionDeploymentTemplate'
      : '2019-04-01/deploymentTemplate';
  requirePilot(
    template?.$schema ===
      `https://schema.management.azure.com/schemas/${schema}.json#` &&
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
      isDeepStrictEqual(
        Object.keys(template.parameters).sort(),
        Object.keys(values).sort(),
      ) &&
      Object.values(template.parameters).every(
        (item) =>
          item.type === 'string' && !Object.hasOwn(item, 'defaultValue'),
      ) &&
      isDeepStrictEqual(template.variables, {
        authorized,
        ...(stage === 'group' ? {} : { tags }),
      }) &&
      Array.isArray(template.resources) &&
      template.resources.length === expected.length,
    'Compiled migration template escaped the closed stage/account/parameter graph.',
  );
  for (const [index, spec] of expected.entries()) {
    const { id, ...write } = spec;
    write.tags =
      stage === 'group'
        ? tags
        : `[union(variables('tags'), createObject('expectedSourceUniqueId', parameters('${index === 0 ? 'os' : 'data'}SourceUniqueId')))]`;
    requirePilot(
      isDeepStrictEqual(template.resources[index], {
        condition: "[variables('authorized')]",
        ...write,
      }),
      'Compiled stage contains an unapproved resource, location, security/export policy, dependency or write.',
    );
  }
  const refs = expected
    .map(
      (r) =>
        `${stage === 'group' ? 'subscriptionResourceId' : 'resourceId'}('${r.type}', '${r.name}')`,
    )
    .join(', ');
  requirePilot(
    isDeepStrictEqual(template.outputs, {
      resourceIds: {
        type: 'array',
        value: `[if(variables('authorized'), createArray(${refs}), createArray())]`,
      },
    }),
    'Only fixed stage resource IDs may be deployment outputs.',
  );
}

const resource = (az, id, api) =>
  az.read(['resource', 'show', '--ids', id, '--api-version', api]);
export async function inventory(az, group) {
  const items = await az.read([
    'resource',
    'list',
    '--resource-group',
    group,
    '--query',
    '[].{id:id,type:type,location:location,tags:tags}',
  ]);
  requirePilot(
    Array.isArray(items) &&
      items.every(
        (r) => typeof r?.id === 'string' && typeof r.type === 'string',
      ) &&
      new Set(items.map((r) => r.id.toLowerCase())).size === items.length,
    'Complete resource inventory is unavailable or duplicated.',
  );
  return items.sort((a, b) =>
    a.id.toLowerCase().localeCompare(b.id.toLowerCase()),
  );
}
export async function coldSource(az, profile, inputs, lineage) {
  const source = profile.sourcePreservation;
  await az.verify();
  const vm = await resource(az, source.vmId, '2025-11-01');
  assertVmConfiguration(vm, inputs.parameters);
  const p = vm.properties;
  requirePilot(
    p.provisioningState === 'Succeeded' &&
      p.vmId === lineage.vmUniqueId &&
      vm.identity.principalId === lineage.principalId &&
      vm.identity.tenantId === lineage.tenantId &&
      (p.storageProfile.osDisk.managedDisk.storageAccountType == null ||
        p.storageProfile.osDisk.managedDisk.storageAccountType ===
          'Standard_LRS') &&
      p.storageProfile.dataDisks[0].toBeDetached !== true &&
      (p.storageProfile.dataDisks[0].managedDisk.storageAccountType == null ||
        p.storageProfile.dataDisks[0].managedDisk.storageAccountType ===
          'Standard_LRS'),
    'Original source VM identity/configuration changed; no preservation write.',
  );
  const statuses = await az.read([
    'vm',
    'get-instance-view',
    '--ids',
    source.vmId,
    '--query',
    'instanceView.statuses',
  ]);
  requirePilot(
    Array.isArray(statuses) &&
      statuses.filter((s) => s.code?.startsWith('PowerState/')).length === 1 &&
      statuses.some((s) => s.code === 'PowerState/deallocated'),
    'Source must already be deallocated; no start/stop capability or cleanliness inference is provided.',
  );
  const disks = {};
  for (const kind of ['os', 'data']) {
    const id = lineage[`${kind}DiskId`],
      disk = await resource(az, id, '2025-01-02'),
      d = disk.properties;
    requirePilot(
      sameId(disk.id, id) &&
        disk.location?.toLowerCase() === source.location &&
        disk.type?.toLowerCase() === 'microsoft.compute/disks' &&
        sameId(disk.managedBy, source.vmId) &&
        (disk.managedByExtended == null ||
          (Array.isArray(disk.managedByExtended) &&
            disk.managedByExtended.length <= 1 &&
            disk.managedByExtended.every((vm) => sameId(vm, source.vmId)))) &&
        disk.sku?.name === source.sku &&
        d?.uniqueId === lineage[`${kind}DiskUniqueId`] &&
        d.provisioningState === 'Succeeded' &&
        d.diskState === 'Reserved' &&
        d.diskSizeGB ===
          (kind === 'os' ? source.osSizeGiB : source.dataSizeGiB) &&
        isDeepStrictEqual(d.encryption, {
          type: 'EncryptionAtRestWithPlatformKey',
        }) &&
        (!d.encryptionSettingsCollection ||
          d.encryptionSettingsCollection.enabled === false) &&
        !d.propertyUpdatesInProgress &&
        (!d.maxShares || d.maxShares === 1) &&
        !d.shareInfo?.length &&
        d.networkAccessPolicy === (kind === 'os' ? 'AllowAll' : 'DenyAll') &&
        d.publicNetworkAccess === (kind === 'os' ? 'Enabled' : 'Disabled') &&
        (kind === 'os'
          ? d.osType === 'Linux' &&
            d.hyperVGeneration === 'V2' &&
            isDeepStrictEqual(d.securityProfile, {
              securityType: 'TrustedLaunch',
            }) &&
            d.creationData?.createOption === 'FromImage'
          : d.creationData?.createOption === 'Empty' && !d.securityProfile),
      'Source disk identity/attachment/retention/export/security or not-writing evidence differs; preserve it unchanged.',
    );
    disks[kind] = {
      id,
      uniqueId: d.uniqueId,
      lastOwnershipUpdateTime: time(d.LastOwnershipUpdateTime),
      timeCreated: time(d.timeCreated),
      sizeGiB: d.diskSizeGB,
      encryption: d.encryption,
      networkAccessPolicy: d.networkAccessPolicy,
      publicNetworkAccess: d.publicNetworkAccess,
      securityProfile: d.securityProfile ?? null,
    };
    requirePilot(
      Date.parse(disks[kind].lastOwnershipUpdateTime) >=
        Date.parse(disks[kind].timeCreated) &&
        Date.parse(disks[kind].lastOwnershipUpdateTime) <= Date.now() + 600_000,
      'Source disk transition timestamp is inconsistent; no cold-preservation assertion.',
    );
  }
  const items = await inventory(az, source.resourceGroup);
  const requiredIds = [source.vmId, source.osDiskId, source.dataDiskId];
  requirePilot(
    requiredIds.every((id) => items.some((item) => sameId(item.id, id))),
    'Original source resource inventory is incomplete.',
  );
  return {
    vmUniqueId: p.vmId,
    principalId: vm.identity.principalId,
    power: 'PowerState/deallocated',
    disks,
    inventoryProjection: 'source-vm-os-data-v1',
    inventorySha256: hashObject(
      items.filter((item) => requiredIds.some((id) => sameId(item.id, id))),
    ),
    guestManifest: 'unavailable',
    shutdownCleanliness: 'unknown',
  };
}

export function snapshotRecord(value, spec, previous, intentAt, state) {
  const p = value?.properties,
    expected = spec.properties;
  let sourceUniqueIdKind;
  if (expected.creationData.createOption === 'CopyStart') {
    const snapshots = SCUS_PROFILE.sourcePreservation.snapshots;
    const kind = sameId(spec.id, snapshots.targetOs.id)
      ? 'os'
      : sameId(spec.id, snapshots.targetData.id)
        ? 'data'
        : undefined;
    const captured = state?.stages?.capture?.resources?.[kind];
    const original = state?.source?.lineage?.[`${kind}DiskUniqueId`];
    requirePilot(
      kind &&
        state?.profileId === SCUS_PROFILE.id &&
        captured &&
        uuid.test(original ?? '') &&
        sameId(
          captured.id,
          snapshots[kind === 'os' ? 'sourceOs' : 'sourceData'].id,
        ) &&
        sameId(
          captured.sourceResourceId,
          SCUS_PROFILE.sourcePreservation[`${kind}DiskId`],
        ) &&
        captured.sourceUniqueId === original &&
        uuid.test(captured.uniqueId ?? '') &&
        sameId(expected.creationData.sourceResourceId, captured.id) &&
        spec.tags.expectedSourceUniqueId === captured.uniqueId,
      'Copy lineage lacks the exact verified captured snapshot and corresponding original disk binding.',
    );
    sourceUniqueIdKind =
      p?.creationData?.sourceUniqueId === captured.uniqueId
        ? 'captured-snapshot'
        : p?.creationData?.sourceUniqueId === original
          ? 'original-disk'
          : undefined;
    requirePilot(
      sourceUniqueIdKind,
      'Copy sourceUniqueId is neither the exact captured snapshot nor its original disk.',
    );
  }
  requirePilot(
    sameId(value?.id, spec.id) &&
      value.type?.toLowerCase() === 'microsoft.compute/snapshots' &&
      value.location?.toLowerCase() === spec.location &&
      value.sku?.name === 'Standard_LRS' &&
      isDeepStrictEqual(value.tags, spec.tags) &&
      !value.managedBy &&
      p?.incremental === true &&
      p.diskSizeGB === expected.diskSizeGB &&
      p.networkAccessPolicy === 'DenyAll' &&
      p.publicNetworkAccess === 'Disabled' &&
      isDeepStrictEqual(p.encryption, expected.encryption) &&
      p.creationData?.createOption === expected.creationData.createOption &&
      sameId(
        p.creationData.sourceResourceId,
        expected.creationData.sourceResourceId,
      ) &&
      (sourceUniqueIdKind ||
        p.creationData.sourceUniqueId === spec.tags.expectedSourceUniqueId) &&
      !p.creationData.sourceUri &&
      !p.creationData.storageAccountId &&
      uuid.test(p.uniqueId ?? '') &&
      uuid.test(p.incrementalSnapshotFamilyId ?? '') &&
      (expected.osType
        ? p.osType === 'Linux' &&
          p.hyperVGeneration === 'V2' &&
          isDeepStrictEqual(p.securityProfile, expected.securityProfile)
        : !p.securityProfile),
    'Snapshot scope, immutable source lineage, identity, security or export configuration is unverified.',
  );
  const record = {
    id: spec.id,
    uniqueId: p.uniqueId,
    familyId: p.incrementalSnapshotFamilyId,
    timeCreated: time(p.timeCreated),
    sourceResourceId: expected.creationData.sourceResourceId,
    sourceUniqueId: p.creationData.sourceUniqueId,
    ...(sourceUniqueIdKind ? { sourceUniqueIdKind } : {}),
  };
  requirePilot(
    Date.parse(record.timeCreated) >= Date.parse(intentAt) - 600_000 &&
      Date.parse(record.timeCreated) <= Date.now() + 600_000 &&
      (!previous || isDeepStrictEqual(previous, record)),
    'Snapshot was replaced or its creation is not attributable to the recorded absent-resource intent.',
  );
  return record;
}
export function snapshotReady(value, stage) {
  const p = value.properties;
  requirePilot(
    p.copyCompletionError == null &&
      !['Failed', 'Canceled'].includes(p.provisioningState),
    'Snapshot copy failed; all partial resources and intent are retained, with no cleanup or resubmission.',
  );
  return (
    p.provisioningState === 'Succeeded' &&
    ['Available', 'AvailableWithInstantAccess'].includes(
      p.snapshotAccessState,
    ) &&
    (stage !== 'copy' ||
      (typeof p.completionPercent === 'number' && p.completionPercent === 100))
  );
}
export function assertGroup(value, profile, state) {
  requirePilot(
    sameId(value?.id, profile.compute.groupId) &&
      value.type?.toLowerCase() === 'microsoft.resources/resourcegroups' &&
      value.location?.toLowerCase() === profile.compute.location &&
      isDeepStrictEqual(value.tags, stageTags(profile, state, 'group')) &&
      value.properties?.provisioningState === 'Succeeded' &&
      !value.managedBy,
    'Target group is untracked, foreign or not ready; no adoption.',
  );
}

export function assertValidation(result, profile, state, stage) {
  const p = result?.properties;
  requirePilot(
    sameId(result?.id, deploymentId(profile, stage)) &&
      result.name === profile.stages[stage].deploymentName &&
      !result.error &&
      !p?.error &&
      p?.mode === 'Incremental' &&
      p.provisioningState === 'Succeeded' &&
      typeof p.templateHash === 'string' &&
      p.templateHash.length > 0 &&
      (!p.validationLevel || p.validationLevel === 'Provider') &&
      (!p.diagnostics || p.diagnostics.every((d) => d.level === 'Info')) &&
      isDeepStrictEqual(
        (p.validatedResources ?? []).map((r) => r.id.toLowerCase()).sort(),
        stageIds(profile, stage)
          .map((id) => id.toLowerCase())
          .sort(),
      ),
    'Provider validation is incomplete, skipped, failed or scoped to different resources; no approval proof.',
  );
  assertParameters(p.parameters, stageParameters(profile, state, stage));
  return p.templateHash;
}
export function assertParameters(actual, expected) {
  requirePilot(
    actual &&
      isDeepStrictEqual(
        Object.keys(actual).sort(),
        Object.keys(expected).sort(),
      ) &&
      Object.keys(expected).every(
        (key) =>
          actual[key]?.value === expected[key].value &&
          !actual[key].reference &&
          !actual[key].expression,
      ),
    'Deployment parameters do not match the recorded scoped request.',
  );
}
export function assertWhatIf(result, profile, state, stage, existingIds) {
  const expected = desiredResources(profile, state, stage),
    created = new Set();
  requirePilot(
    result?.status === 'Succeeded' &&
      !result.error &&
      Array.isArray(result.changes),
    'What-if did not return a complete successful change set.',
  );
  for (const item of result.changes) {
    const spec = expected.find((r) => sameId(item.resourceId, r.id));
    if (spec) {
      if (isHostStage(stage)) {
        requirePilot(
          item.changeType === 'Create' && !created.has(spec.id) && item.after,
          'B1 what-if must contain each exact new resource once, without adoption.',
        );
        assertHostWhatIf(item.after, spec, profile, stage);
        created.add(spec.id);
        continue;
      }
      requirePilot(
        item.changeType === 'Create' &&
          !created.has(spec.id) &&
          item.after &&
          sameId(item.after.id ?? item.resourceId, spec.id) &&
          item.after.type?.toLowerCase() === spec.type.toLowerCase() &&
          item.after.location?.toLowerCase() === spec.location &&
          isDeepStrictEqual(item.after.tags, spec.tags) &&
          (stage === 'group' ||
            (item.after.sku?.name === 'Standard_LRS' &&
              Object.entries(spec.properties).every(([key, value]) =>
                isDeepStrictEqual(item.after.properties?.[key], value),
              ))),
        'What-if proposes adoption, replacement, unexpected configuration or a non-Create stage change.',
      );
      created.add(spec.id);
    } else
      requirePilot(
        ['Ignore', 'NoChange'].includes(item.changeType) &&
          existingIds.some((id) => sameId(item.resourceId, id)),
        'What-if includes a deletion, modification, replacement or unexpected resource.',
      );
  }
  requirePilot(
    created.size === expected.length,
    'What-if omitted a required new resource.',
  );
  return [...result.changes].sort((a, b) =>
    a.resourceId.toLowerCase().localeCompare(b.resourceId.toLowerCase()),
  );
}
