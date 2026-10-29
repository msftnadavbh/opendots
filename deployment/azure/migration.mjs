import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { SCUS_PROFILE, assertProfile } from './profiles.mjs';
import { requirePilot, PilotError } from './scope.mjs';
import { createAz, assertProfileEnvironment } from './cloud.mjs';
import {
  openMigrationStore,
  assertMigrationState,
  sha256,
  hashObject,
} from './migration-state.mjs';
import {
  requireStage,
  deploymentId,
  stageIds,
  desiredResources,
  stageParameters,
  assertStageTemplate,
  inventory,
  coldSource,
  snapshotRecord,
  snapshotReady,
  assertGroup,
  assertValidation,
  assertParameters,
  assertWhatIf,
} from './migration-validation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sameId = (a, b) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const resources = (az, id, api) =>
  az.read(['resource', 'show', '--ids', id, '--api-version', api]);
export async function compileMigrationStage(profile, stage) {
  const plan = requireStage(profile, stage);
  try {
    const { stdout } = await execute(
      join(homedir(), '.azure/bin/bicep'),
      ['build', join(root, plan.template), '--stdout'],
      { timeout: 120_000, maxBuffer: 1_000_000 },
    );
    return stdout;
  } catch {
    throw new PilotError(
      'Local fixed-stage Bicep compilation failed; details suppressed. No Azure operation was attempted.',
    );
  }
}
function deploymentArgs(profile, stage, action) {
  const plan = requireStage(profile, stage);
  return [
    'deployment',
    plan.scope,
    action,
    '--name',
    plan.deploymentName,
    ...(plan.scope === 'group'
      ? ['--resource-group', profile.compute.resourceGroup]
      : []),
  ];
}
async function deploymentExists(az, profile, stage) {
  const plan = requireStage(profile, stage);
  const values = await az.read([
    'deployment',
    plan.scope,
    'list',
    ...(plan.scope === 'group'
      ? ['--resource-group', profile.compute.resourceGroup]
      : []),
    '--query',
    `[?name=='${plan.deploymentName}'].id`,
  ]);
  requirePilot(
    Array.isArray(values) &&
      values.length <= 1 &&
      values.every((id) => sameId(id, deploymentId(profile, stage))),
    'Deployment inventory is ambiguous or outside the fixed stage.',
  );
  return values.length === 1;
}
async function groupExists(az, profile) {
  const value = await az.read([
    'group',
    'exists',
    '--name',
    profile.compute.resourceGroup,
  ]);
  requirePilot(
    typeof value === 'boolean',
    'Target group absence is unverified.',
  );
  return value;
}
async function targetInventory(az, profile, state) {
  if (!(await groupExists(az, profile))) {
    requirePilot(
      !state.stages.group?.intent,
      'Tracked target group is missing; no recreation.',
    );
    return [];
  }
  requirePilot(
    state.stages.group?.intent,
    'Target group exists without this migration intent; refusing adoption.',
  );
  assertGroup(
    await az.read(['group', 'show', '--name', profile.compute.resourceGroup]),
    profile,
    state,
  );
  const items = await inventory(az, profile.compute.resourceGroup);
  const allowed = ['capture', 'copy'].flatMap((stage) =>
    state.stages[stage]?.intent
      ? [...stageIds(profile, stage), deploymentId(profile, stage)]
      : [],
  );
  for (const item of items)
    requirePilot(
      allowed.some((id) => sameId(id, item.id)),
      'Unexpected or untracked resource in target preservation group; no adoption.',
    );
  return items;
}

export function migrationController({
  profile,
  az,
  store,
  compile = compileMigrationStage,
}) {
  assertProfile(profile);
  requirePilot(
    profile === SCUS_PROFILE && az.profile === profile,
    'Migration client/profile context differs.',
  );
  const load = async () => {
    const state = assertMigrationState(await store.readState(), profile);
    const inputs = await store.loadArchive(state);
    return { state, inputs };
  };
  const dependency = (state, stage) => {
    if (stage !== 'group')
      requirePilot(
        state.stages.group?.status === 'complete',
        'Complete the recorded group stage first.',
      );
    if (stage === 'copy')
      requirePilot(
        state.stages.capture?.status === 'complete' &&
          !state.stages.capture.uncertainPreservation,
        'Complete verified cold capture first; uncertain preservation cannot authorize copying.',
      );
  };
  const assertIntent = (saved, state, stage) => {
    requirePilot(
      saved?.intent &&
        saved.intent.request.profileId === profile.id &&
        saved.intent.request.migrationId === state.migrationId &&
        saved.intent.request.stage === stage &&
        saved.intent.request.sourceArchiveSha256 ===
          state.source.archiveSha256 &&
        sha.test(saved.intent.request.templateSha256 ?? '') &&
        sha.test(saved.intent.request.profileSha256 ?? '') &&
        saved.intent.request.deploymentId === deploymentId(profile, stage) &&
        saved.intent.requestSha256 === hashObject(saved.intent.request),
      'No exact durable migration intent exists for reconciliation.',
    );
    requirePilot(
      isDeepStrictEqual(
        saved.intent.request.expected.map((item) => item.id).sort(),
        stageIds(profile, stage).sort(),
      ),
      'Recorded intent resource graph escaped the fixed preservation stage.',
    );
    assertParameters(
      saved.intent.request.parameters,
      stageParameters(profile, state, stage),
    );
  };
  const verifyDeployment = async (saved, state, stage) => {
    assertIntent(saved, state, stage);
    const deployment = await az.read(deploymentArgs(profile, stage, 'show'));
    const p = deployment?.properties;
    requirePilot(
      sameId(deployment?.id, saved.intent.request.deploymentId) &&
        deployment.name === profile.stages[stage].deploymentName &&
        deployment.type?.toLowerCase() === 'microsoft.resources/deployments' &&
        p?.mode === 'Incremental' &&
        p.templateHash === saved.intent.providerTemplateHash &&
        !p.templateLink &&
        !p.parametersLink &&
        !p.onErrorDeployment &&
        uuid.test(p.correlationId ?? '') &&
        Number.isFinite(Date.parse(p.timestamp)) &&
        Date.parse(p.timestamp) >= Date.parse(saved.intent.at) - 600_000 &&
        (!saved.deployment ||
          saved.deployment.correlationId === p.correlationId) &&
        (saved.status !== 'complete' || saved.deployment),
      'Deployment identity/template/correlation differs from the recorded request; refusing adoption or replacement.',
    );
    assertParameters(p.parameters, saved.intent.request.parameters);
    return deployment;
  };
  const verifyCaptured = async (state) => {
    const deployment = await verifyDeployment(
      state.stages.capture,
      state,
      'capture',
    );
    requirePilot(
      deployment.properties.provisioningState === 'Succeeded' &&
        !deployment.properties.error,
      'Recorded capture deployment is no longer verifiable.',
    );
    const spec = desiredResources(profile, state, 'capture');
    for (const [index, kind] of ['os', 'data'].entries()) {
      const value = await resources(az, spec[index].id, '2025-01-02');
      snapshotRecord(
        value,
        spec[index],
        state.stages.capture.resources[kind],
        state.stages.capture.intent.at,
      );
      requirePilot(
        snapshotReady(value, 'capture'),
        'Source snapshot is not ready for managed copy.',
      );
    }
  };
  const preflight = async (stage) => {
    requireStage(profile, stage);
    const { state, inputs } = await load();
    requirePilot(
      !state.stages[stage]?.intent,
      'Stage already has a durable intent; use GET-only reconcile, never apply again.',
    );
    dependency(state, stage);
    await az.verify();
    if (stage !== 'group') {
      const deployment = await verifyDeployment(
        state.stages.group,
        state,
        'group',
      );
      requirePilot(
        deployment.properties.provisioningState === 'Succeeded' &&
          !deployment.properties.error,
        'Recorded group deployment is no longer verifiable.',
      );
    }
    const items = await targetInventory(az, profile, state);
    if (stage === 'group')
      requirePilot(
        !(await groupExists(az, profile)),
        'Group must be absent before its one creation.',
      );
    requirePilot(
      !(await deploymentExists(az, profile, stage)),
      'Fixed deployment name already exists without this stage intent; no adoption or name regeneration.',
    );
    if (stage === 'copy') await verifyCaptured(state);
    const source = await coldSource(az, profile, inputs, state.source.lineage);
    const compiled = await compile(profile, stage);
    const template = JSON.parse(compiled);
    assertStageTemplate(profile, state, stage, template);
    const parameters = stageParameters(profile, state, stage);
    const request = {
      profileId: profile.id,
      profileSha256: hashObject(profile),
      migrationId: state.migrationId,
      stage,
      deploymentId: deploymentId(profile, stage),
      templateSha256: sha256(compiled),
      parameters,
      sourceArchiveSha256: state.source.archiveSha256,
      source,
      existingIds: items.map((r) => r.id),
      expected: desiredResources(profile, state, stage),
    };
    return {
      state,
      inputs,
      compiled,
      request,
      requestSha256: hashObject(request),
    };
  };
  const providerChecks = async (stage, plan) => {
    await store.write(`${stage}-template.json`, plan.compiled);
    await store.write(`${stage}-parameters.json`, {
      parameters: plan.request.parameters,
    });
    const base = (action) => [
      ...deploymentArgs(profile, stage, action),
      ...(stage === 'group'
        ? ['--location', profile.compute.location]
        : ['--mode', 'Incremental']),
      '--template-file',
      store.deploymentPath(`${stage}-template.json`),
      '--parameters',
      `@${store.deploymentPath(`${stage}-parameters.json`)}`,
    ];
    const validation = await az.write([
      ...base('validate'),
      '--validation-level',
      'Provider',
    ]);
    const templateHash = assertValidation(
      validation,
      profile,
      plan.state,
      stage,
    );
    const whatIf = await az.write([
      ...base('what-if'),
      '--validation-level',
      'Provider',
      '--result-format',
      'FullResourcePayloads',
      '--no-pretty-print',
    ]);
    const changes = assertWhatIf(
      whatIf,
      profile,
      plan.state,
      stage,
      plan.request.existingIds,
    );
    return {
      at: new Date().toISOString(),
      request: plan.request,
      requestSha256: plan.requestSha256,
      providerTemplateHash: templateHash,
      validation,
      whatIf,
      changes,
      validationSha256: hashObject(validation),
      whatIfSha256: hashObject(whatIf),
      changesSha256: hashObject(changes),
    };
  };
  const validate = async (stage) => {
    const plan = await preflight(stage);
    const proof = await providerChecks(stage, plan);
    const fresh = await preflight(stage);
    requirePilot(
      fresh.requestSha256 === proof.requestSha256,
      'Stage/source inputs changed during validation; no usable proof.',
    );
    await store.write(`${stage}-validation.json`, proof);
    const old = plan.state.stages[stage] ?? {};
    await store.save({
      ...plan.state,
      stages: {
        ...plan.state.stages,
        [stage]: {
          ...old,
          validation: proof,
          validationHistory: [
            ...(old.validationHistory ?? []),
            ...(old.validation ? [old.validation] : []),
          ],
        },
      },
    });
    return {
      stage,
      status: 'review-required',
      proposalSha256: hashObject(proof),
      changesSha256: proof.changesSha256,
    };
  };
  const reconcile = async (stage) => {
    requireStage(profile, stage);
    const { state, inputs } = await load();
    const saved = state.stages[stage];
    assertIntent(saved, state, stage);
    await az.verify();
    let next = structuredClone(saved);
    const persist = async () =>
      store.save({ ...state, stages: { ...state.stages, [stage]: next } });
    const sourceUnchanged = async () => {
      try {
        const observed = await coldSource(
          az,
          profile,
          inputs,
          state.source.lineage,
        );
        requirePilot(
          isDeepStrictEqual(observed, saved.intent.request.source),
          'Source changed during capture.',
        );
        return observed;
      } catch {
        next.uncertainPreservation = true;
        next.status = 'uncertain';
        await persist();
        throw new PilotError(
          'Source power/identity/disk/transition evidence changed or became unavailable during capture. Preservation is uncertain; retain every resource and intent, no automatic continuation.',
        );
      }
    };
    if (stage === 'capture' && saved.status !== 'complete')
      await sourceUnchanged();
    requirePilot(
      !saved.uncertainPreservation,
      'Uncertain preservation requires lead reconciliation; evidence is not cleared by later observations.',
    );
    if (!(await deploymentExists(az, profile, stage)))
      return {
        stage,
        status: 'pending',
        reason: 'deployment outcome unknown; no resubmission',
      };
    const deployment = await verifyDeployment(saved, state, stage);
    const p = deployment.properties;
    next.deployment = {
      id: deployment.id,
      correlationId: p.correlationId,
      timestamp: p.timestamp,
      templateHash: p.templateHash,
    };
    await persist();
    requirePilot(
      !p.error &&
        !['Failed', 'Canceled', 'Deleted'].includes(p.provisioningState),
      'Deployment failed; retain partial resources and intent. No retry or cleanup is authorized.',
    );
    if (p.provisioningState !== 'Succeeded')
      return { stage, status: 'pending', reason: 'deployment not complete' };
    requirePilot(
      isDeepStrictEqual(
        (p.outputResources ?? []).map((r) => r.id.toLowerCase()).sort(),
        stageIds(profile, stage)
          .map((id) => id.toLowerCase())
          .sort(),
      ),
      'Deployment output-resource graph differs from the approved stage.',
    );
    if (stage === 'group') {
      requirePilot(
        await groupExists(az, profile),
        'Completed group deployment has no matching group.',
      );
      assertGroup(
        await az.read([
          'group',
          'show',
          '--name',
          profile.compute.resourceGroup,
        ]),
        profile,
        state,
      );
      next.resources = { groupId: profile.compute.groupId };
    } else {
      if (stage === 'copy') await verifyCaptured(state);
      const items = await targetInventory(az, profile, state);
      const expected = saved.intent.request.expected;
      let complete = true;
      next.resources ??= {};
      for (const [index, kind] of ['os', 'data'].entries()) {
        requirePilot(
          items.some((item) => sameId(item.id, expected[index].id)),
          'Tracked snapshot is missing; no recreation.',
        );
        const value = await resources(az, expected[index].id, '2025-01-02');
        next.resources[kind] = snapshotRecord(
          value,
          expected[index],
          saved.resources?.[kind],
          saved.intent.at,
          state,
        );
        await persist();
        complete = snapshotReady(value, stage) && complete;
      }
      if (stage === 'copy') await verifyCaptured(state);
      if (stage === 'capture' && saved.status !== 'complete') {
        await sourceUnchanged();
        next.consistency = 'cold/crash-consistent';
        next.sourceGuestManifest = 'unavailable';
        next.shutdownCleanliness = 'unknown';
      }
      if (!complete)
        return {
          stage,
          status: 'pending',
          reason:
            'snapshot provisioning/copy completion is incomplete or unavailable',
        };
    }
    next.status = 'complete';
    await persist();
    return {
      stage,
      status: 'complete',
      historical: saved.status === 'complete',
      applicationActivated: false,
    };
  };
  const apply = async (stage) => {
    const plan = await preflight(stage);
    const proof = plan.state.stages[stage]?.validation;
    const review = await store.read(`${stage}-review.json`);
    requirePilot(
      proof &&
        proof.requestSha256 === plan.requestSha256 &&
        proof.validationSha256 === hashObject(proof.validation) &&
        proof.whatIfSha256 === hashObject(proof.whatIf) &&
        proof.changesSha256 === hashObject(proof.changes) &&
        isDeepStrictEqual(
          Object.keys(review).sort(),
          [
            'version',
            'profileId',
            'migrationId',
            'stage',
            'proposalSha256',
            'changesSha256',
            'reviewSha256',
            'reviewedAt',
          ].sort(),
        ) &&
        review.version === 1 &&
        review.profileId === profile.id &&
        review.migrationId === plan.state.migrationId &&
        review.stage === stage &&
        review.proposalSha256 === hashObject(proof) &&
        review.changesSha256 === proof.changesSha256 &&
        sha.test(review.reviewSha256 ?? '') &&
        Date.parse(review.reviewedAt) >= Date.parse(proof.at) &&
        Date.parse(review.reviewedAt) <= Date.now(),
      'A private manual review of this exact validation/template/parameters/source/profile/change set is required; no blanket validation flag.',
    );
    const freshProof = await providerChecks(stage, plan);
    requirePilot(
      freshProof.providerTemplateHash === proof.providerTemplateHash &&
        freshProof.changesSha256 === proof.changesSha256,
      'Fresh provider validation/change set differs from the reviewed proof; no apply.',
    );
    const fresh = await preflight(stage);
    requirePilot(
      fresh.requestSha256 === plan.requestSha256,
      'Inputs or absence/source observations changed before intent publication.',
    );
    const intent = {
      at: new Date().toISOString(),
      request: plan.request,
      requestSha256: plan.requestSha256,
      providerTemplateHash: freshProof.providerTemplateHash,
      review: structuredClone(review),
      freshValidation: freshProof,
    };
    const intendedState = {
      ...plan.state,
      stages: {
        ...plan.state.stages,
        [stage]: { ...plan.state.stages[stage], status: 'pending', intent },
      },
    };
    const args = [
      ...deploymentArgs(profile, stage, 'create'),
      ...(stage === 'group'
        ? ['--location', profile.compute.location]
        : ['--mode', 'Incremental']),
      '--template-file',
      store.deploymentPath(`${stage}-template.json`),
      '--parameters',
      `@${store.deploymentPath(`${stage}-parameters.json`)}`,
      '--no-wait',
    ];
    await az.createWithIntent(args, async () => {
      requirePilot(
        sha256(await store.readBytes(`${stage}-template.json`)) ===
          plan.request.templateSha256 &&
          (await store.readBytes(`${stage}-parameters.json`)).equals(
            Buffer.from(
              JSON.stringify({ parameters: plan.request.parameters }, null, 2) +
                '\n',
            ),
          ),
        'Private request bytes or parameters changed after provider validation; no intent or apply.',
      );
      await store.save(intendedState);
    });
    return reconcile(stage);
  };
  return {
    preflight: async (stage) => {
      const plan = await preflight(stage);
      return {
        stage,
        status: 'preflight-only',
        requestSha256: plan.requestSha256,
        expectedCreates: plan.request.expected.map((r) => r.id),
      };
    },
    validate,
    apply,
    reconcile,
  };
}

export async function migrationMain(
  profile,
  args,
  { directory = root, run, compile } = {},
) {
  assertProfile(profile);
  requirePilot(
    profile === SCUS_PROFILE,
    'Preservation commands require the explicit target profile.',
  );
  const [command, stage, ...extra] = args;
  requirePilot(
    (command === 'prepare' && !stage && !extra.length) ||
      (['preflight', 'validate', 'apply', 'reconcile'].includes(command) &&
        !extra.length &&
        Object.hasOwn(profile.stages, stage ?? '')),
    'Target supports prepare or preflight/validate/apply/reconcile group|capture|copy only. Host/audit/configure/activate, guest commands and arbitrary templates/scopes are unavailable.',
  );
  assertProfileEnvironment(profile);
  process.umask(0o077);
  const store = await openMigrationStore(profile, directory);
  try {
    if (command === 'prepare') {
      const state = await store.prepare();
      console.log(
        JSON.stringify({
          profileId: profile.id,
          status: 'local-source-archive-prepared',
          sourceArchiveSha256: state.source.archiveSha256,
          cloudChanged: false,
        }),
      );
    } else {
      const controller = migrationController({
        profile,
        az: createAz(run, profile),
        store,
        ...(compile ? { compile } : {}),
      });
      console.log(JSON.stringify(await controller[command](stage)));
    }
  } finally {
    await store.close();
  }
}
