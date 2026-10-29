import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCUS_PROFILE } from '../profiles.mjs';
import { SCOPE, VM } from '../scope.mjs';
import { createAz } from '../cloud.mjs';
import { openMigrationStore, hashObject, sha256 } from '../migration-state.mjs';
import { migrationController, migrationMain } from '../migration.mjs';
import {
  desiredResources,
  deploymentId,
  stageIds,
} from '../migration-validation.mjs';
import {
  state as baseState,
  parameters,
  output,
  account,
  vmResources,
} from './fixtures.mjs';

assert(
  process.env.PILOT_SCUS_TEMPLATE_DIR,
  'Compile all three infra/scus templates and set PILOT_SCUS_TEMPLATE_DIR; never skip this contract.',
);
export const compiled = Object.fromEntries(
  await Promise.all(
    ['group', 'capture', 'copy'].map(async (stage) => [
      stage,
      await readFile(
        join(process.env.PILOT_SCUS_TEMPLATE_DIR, `${stage}.json`),
        'utf8',
      ),
    ]),
  ),
);
export const serialize = (value) => JSON.stringify(value, null, 2) + '\n';

export async function migrationFixture(t) {
  const root = await mkdtemp('/tmp/opencode/opendots-scus-fixture-');
  const original = join(root, 'artifacts/azure-pilot');
  const target = join(root, SCUS_PROFILE.artifacts.directory);
  await mkdir(original, { recursive: true, mode: 0o700 });
  const state = {
    ...structuredClone(baseState),
    fsUuid: SCUS_PROFILE.sourcePreservation.fsUuid,
    pins: structuredClone(baseState.binding),
    management: { historicalFixtureFact: 'preserve-without-transplanting' },
  };
  const files = {
    'vm-state.json': serialize(state),
    'vm-parameters.json': serialize({
      parameters: Object.fromEntries(
        Object.entries(parameters).map(([key, value]) => [key, { value }]),
      ),
    }),
    'arm-outputs.json': serialize(output),
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(join(original, name), content, { mode: 0o600 });
  const r = vmResources();
  for (const value of Object.values(r))
    value.type = value.id
      .split('/providers/')[1]
      .split('/')
      .slice(0, 2)
      .join('/');
  delete r.vm.properties.storageProfile.osDisk.managedDisk.storageAccountType;
  for (const kind of ['os', 'disk']) {
    r[kind].type = 'Microsoft.Compute/disks';
    r[kind].sku.name = 'Standard_LRS';
    r[kind].properties.diskState = 'Reserved';
    r[kind].properties.LastOwnershipUpdateTime = '2026-10-25T16:00:00.000Z';
    r[kind].properties.encryption = { type: 'EncryptionAtRestWithPlatformKey' };
  }
  r.os.properties.diskSizeGB = 30;
  r.os.properties.securityProfile = { securityType: 'TrustedLaunch' };
  r.os.properties.networkAccessPolicy = 'AllowAll';
  r.os.properties.publicNetworkAccess = 'Enabled';
  r.disk.tags = {};
  const f = {
    root,
    original,
    target,
    files,
    source: r,
    resources: new Map(),
    deployments: new Map(),
    group: undefined,
    power: 'PowerState/deallocated',
    calls: [],
    account: structuredClone(account),
    principal: SCOPE.principalId,
    saves: [],
    creates: [],
    completionPercent: 100,
    snapshotAccessState: { capture: 'Available', copy: 'Available' },
    copyLineage: { os: 'captured-snapshot', data: 'captured-snapshot' },
    createFault: undefined,
    afterCreate: undefined,
    validationMutation: undefined,
    whatIfMutation: undefined,
    readFault: undefined,
  };
  const inventory = (values) =>
    values.map(({ id, type, location, tags }) => ({
      id,
      type,
      location,
      tags,
    }));
  f.diskState = async () =>
    JSON.parse(await readFile(join(target, 'migration-state.json'), 'utf8'));
  f.run = async (binary, raw, options) => {
    assert.equal(binary, 'az');
    assert(
      Object.isFrozen(raw),
      'Target invocation arguments must be immutable.',
    );
    assert.deepEqual(raw.slice(-5), [
      '--subscription',
      SCOPE.subscriptionId,
      '--only-show-errors',
      '--output',
      'json',
    ]);
    const args = raw.slice(0, -5);
    f.calls.push(args);
    await f.beforeCall?.(args, options);
    let value;
    const groupName = args[args.indexOf('--resource-group') + 1];
    if (args[0] === 'account') value = f.account;
    else if (args[0] === 'rest') value = f.principal;
    else if (args[0] === 'group')
      value = args[1] === 'exists' ? !!f.group : f.group;
    else if (args[0] === 'vm')
      value = [{ code: 'ProvisioningState/succeeded' }, { code: f.power }];
    else if (args[0] === 'resource' && args[1] === 'list') {
      value = inventory(
        groupName === SCOPE.resourceGroup
          ? Object.values(f.source).filter((item) => item !== f.source.role)
          : [...f.resources.values()],
      );
      if (f.inventoryResponse) value = f.inventoryResponse(value, groupName);
    } else if (args[0] === 'resource') {
      const id = args[args.indexOf('--ids') + 1];
      if (f.readFault === id) throw new Error('FAKE-PRIVATE-PROVIDER-ERROR');
      value =
        Object.values(f.source).find((item) => item.id === id) ??
        f.resources.get(id);
      assert(value, `Unexpected fixture resource read: ${id}`);
    } else if (args[0] === 'deployment') {
      if (args[2] === 'list') {
        const name = /name=='([^']+)'/.exec(
          args[args.indexOf('--query') + 1],
        )[1];
        value = [...f.deployments.values()]
          .filter((item) => item.name === name)
          .map((item) => item.id);
      } else {
        const name = args[args.indexOf('--name') + 1];
        const stage = Object.keys(SCUS_PROFILE.stages).find(
          (key) => SCUS_PROFILE.stages[key].deploymentName === name,
        );
        assert(stage);
        if (args[2] === 'show') {
          if (f.readFault === deploymentId(SCUS_PROFILE, stage))
            throw new Error('FAKE-PRIVATE-DEPLOYMENT-ERROR');
          value = f.deployments.get(stage);
          assert(value, 'No untracked deployment reads');
        } else {
          const templateBytes = await readFile(
            args[args.indexOf('--template-file') + 1],
            'utf8',
          );
          const template = JSON.parse(templateBytes);
          const params = JSON.parse(
            await readFile(
              args[args.indexOf('--parameters') + 1].slice(1),
              'utf8',
            ),
          ).parameters;
          const local = await f.diskState();
          const specs = desiredResources(SCUS_PROFILE, local, stage);
          const providerHash = 'opaque-' + sha256(templateBytes).slice(0, 20);
          if (args[2] === 'validate') {
            assert(
              args.includes('--validation-level') && args.includes('Provider'),
            );
            value = {
              id: deploymentId(SCUS_PROFILE, stage),
              name,
              type: 'Microsoft.Resources/deployments',
              properties: {
                mode: 'Incremental',
                provisioningState: 'Succeeded',
                parameters: params,
                templateHash: providerHash,
                validatedResources: specs.map(({ id }) => ({ id })),
                diagnostics: [],
                validationLevel: 'Provider',
              },
            };
            f.validationMutation?.(value);
          } else if (args[2] === 'what-if') {
            value = {
              status: 'Succeeded',
              changes: specs.map((item) => ({
                resourceId: item.id,
                changeType: 'Create',
                after: item,
              })),
            };
            f.whatIfMutation?.(value);
            await f.afterWhatIf?.(stage);
          } else {
            assert.equal(args[2], 'create');
            assert(args.includes('--no-wait'));
            assert(
              local.stages[stage].intent,
              'A durable intent must precede create',
            );
            assert.equal(
              local.stages[stage].intent.request.templateSha256,
              sha256(templateBytes),
            );
            assert.deepEqual(
              local.stages[stage].intent.request.parameters,
              params,
            );
            assert.equal(template.resources.length, stage === 'group' ? 1 : 2);
            f.creates.push(stage);
            if (f.createFault === 'before')
              throw new Error('FAKE-PRIVATE-UNKNOWN-SUBMISSION');
            for (const spec of specs) {
              if (stage === 'group')
                f.group = {
                  ...spec,
                  properties: { provisioningState: 'Succeeded' },
                };
              else {
                const sourceId = spec.properties.creationData.sourceResourceId;
                const source =
                  Object.values(f.source).find(
                    (item) => item.id === sourceId,
                  ) ?? f.resources.get(sourceId);
                assert(source);
                const kind =
                  spec.id ===
                  SCUS_PROFILE.sourcePreservation.snapshots.targetOs.id
                    ? 'os'
                    : 'data';
                f.resources.set(spec.id, {
                  ...structuredClone(spec),
                  properties: {
                    ...structuredClone(spec.properties),
                    provisioningState: 'Succeeded',
                    creationData: {
                      ...spec.properties.creationData,
                      sourceUniqueId:
                        stage === 'copy' &&
                        f.copyLineage[kind] === 'original-disk'
                          ? source.properties.creationData.sourceUniqueId
                          : source.properties.uniqueId,
                    },
                    uniqueId: randomUUID(),
                    incrementalSnapshotFamilyId: randomUUID(),
                    timeCreated: new Date().toISOString(),
                    ...(f.snapshotAccessState[stage] === undefined
                      ? {}
                      : { snapshotAccessState: f.snapshotAccessState[stage] }),
                    ...(stage === 'copy' && f.completionPercent !== undefined
                      ? { completionPercent: f.completionPercent }
                      : {}),
                  },
                });
              }
            }
            f.deployments.set(stage, {
              id: deploymentId(SCUS_PROFILE, stage),
              name,
              type: 'Microsoft.Resources/deployments',
              properties: {
                mode: 'Incremental',
                provisioningState: 'Succeeded',
                parameters: params,
                templateHash: providerHash,
                correlationId: randomUUID(),
                timestamp: new Date().toISOString(),
                outputResources: stageIds(SCUS_PROFILE, stage).map((id) => ({
                  id,
                })),
              },
            });
            await f.afterCreate?.(stage);
            if (f.createFault === 'after')
              throw new Error('FAKE-PRIVATE-UNKNOWN-SUBMISSION');
          }
        }
      }
    } else
      assert.fail(
        'No VM mutation, disk attach, source policy write, delete or credential operation exists in this fixture',
      );
    const stdout = value === undefined ? '' : JSON.stringify(value);
    await f.afterCall?.(args, value, options);
    return { stdout };
  };
  f.compile = async (_profile, stage) => compiled[stage];
  f.open = async () => {
    f.store = await openMigrationStore(SCUS_PROFILE, root);
    f.az = createAz(f.run, SCUS_PROFILE);
    f.controller = migrationController({
      profile: SCUS_PROFILE,
      az: f.az,
      store: f.store,
      compile: f.compile,
    });
    return f;
  };
  f.close = async () => {
    if (f.store) {
      await f.store.close();
      f.store = undefined;
    }
  };
  t.after(async () => {
    await f.close();
    await rm(root, { recursive: true, force: true });
  });
  f.prepare = async () => {
    await f.open();
    await f.store.prepare();
  };
  f.review = async (stage) => {
    const state = await f.diskState(),
      proof = state.stages[stage].validation;
    await f.store.write(`${stage}-review.json`, {
      version: 1,
      profileId: SCUS_PROFILE.id,
      migrationId: state.migrationId,
      stage,
      proposalSha256: hashObject(proof),
      changesSha256: proof.changesSha256,
      reviewSha256: 'f'.repeat(64),
      reviewedAt: new Date().toISOString(),
    });
  };
  f.stage = async (stage) => {
    await f.controller.validate(stage);
    await f.review(stage);
    return f.controller.apply(stage);
  };
  f.cli = (args) =>
    migrationMain(SCUS_PROFILE, args, {
      directory: root,
      run: f.run,
      compile: f.compile,
    });
  return f;
}
