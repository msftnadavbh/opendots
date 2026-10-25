import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  RUN_COMMAND,
  PULL_ACTIONS,
  TOKEN_NAME,
  requirePilot,
  validateImage,
  validateOutputs,
  assertOwned,
  PilotError,
} from './scope.mjs';
import { verifyVm } from './vm-state.mjs';
import { units } from './vm.mjs';
import { quote, rootCommand } from './ssh.mjs';

export const INITIAL_IMAGE =
  'odpilot7unu3az5tgmza.azurecr.io/opendots@sha256:ea4668cc47fd6e22a8cbd5a80ca42742aa8890b4a44fac3db304562a0541f978';
export const INITIAL_UNIT_SHA256 =
  '2813973ad9b447ebbd89e31354a7a85053eacf94808c83e84f648e98e89a73d3';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const program = readFileSync(
  new URL('./initial-activation.py', import.meta.url),
  'utf8',
);
const sha = /^[a-f0-9]{64}$/;
const uncertainStates = new WeakSet();
const conflictStatus = 'post-intent-conflict';

// Nonsecret review material only. A lead-supplied reviewSha256 is still mandatory.
export function initialActivationTarget(newImage) {
  validateImage(newImage, {
    registryLoginServer: 'odpilot7unu3az5tgmza.azurecr.io',
  });
  requirePilot(
    newImage !== INITIAL_IMAGE,
    'Initial recovery requires a distinct reviewed image.',
  );
  const oldUnit = units(
    {
      fsUuid: '00000000-0000-0000-0000-000000000000',
      binding: { fqdn: 'unused' },
    },
    INITIAL_IMAGE,
  ).app;
  requirePilot(
    digest(oldUnit) === INITIAL_UNIT_SHA256 &&
      oldUnit.split(INITIAL_IMAGE).length === 2,
    'Frozen initial unit renderer changed; consult the architect, never refresh the approved old hash.',
  );
  const newUnit = oldUnit.replace(INITIAL_IMAGE, newImage);
  return {
    version: 1,
    oldImage: INITIAL_IMAGE,
    newImage,
    oldUnitSha256: INITIAL_UNIT_SHA256,
    newUnitSha256: digest(newUnit),
    oldUnit,
    newUnit,
  };
}

function immutableState(state) {
  const value = structuredClone(state);
  for (const key of ['image', 'management', 'initialActivationRecovery'])
    delete value[key];
  return value;
}

async function dormantToken(az, output) {
  const registry = await az.read([
    'resource',
    'show',
    '--ids',
    output.registryId,
    '--api-version',
    '2025-11-01',
  ]);
  assertOwned(registry, output.registryId);
  requirePilot(
    registry.properties?.adminUserEnabled === false &&
      registry.properties.anonymousPullEnabled !== true,
    'Initial recovery requires registry admin/anonymous access disabled.',
  );
  const args = [
    '--registry',
    output.registryName,
    '--resource-group',
    output.resourceGroup,
  ];
  const token = await az.read([
    'acr',
    'token',
    'show',
    ...args,
    '--name',
    TOKEN_NAME,
  ]);
  const scope = await az.read([
    'acr',
    'scope-map',
    'show',
    ...args,
    '--name',
    output.scopeMapName,
  ]);
  requirePilot(
    token.status === 'disabled' &&
      !token.credentials?.passwords?.length &&
      !token.credentials?.certificates?.length &&
      token.scopeMapId ===
        `${output.registryId}/scopeMaps/${output.scopeMapName}` &&
      scope.id === token.scopeMapId &&
      Array.isArray(scope.actions) &&
      isDeepStrictEqual([...scope.actions].sort(), [...PULL_ACTIONS].sort()),
    'Initial recovery requires the exact read-only import token disabled and password/certificate-free; no credential generation or cleanup bypass.',
  );
}

// One-off old-image -> reviewed-image recovery, never a general upgrade or pin reset.
// The caller holds pilot.mjs's local lock; the entire guest transaction holds rootCommand's flock.
export async function recoverInitialActivation({
  az,
  ssh,
  output,
  parameters,
  state,
  save,
  approval,
}) {
  requirePilot(
    !uncertainStates.has(state),
    'Initial recovery local durability is uncertain; reload persistent state before further work.',
  );
  validateOutputs(output);
  const target = initialActivationTarget(approval?.newImage);
  const { oldUnit, newUnit, ...review } = target;
  requirePilot(
    isDeepStrictEqual(
      Object.keys(approval).sort(),
      [...Object.keys(review), 'reviewSha256'].sort(),
    ) &&
      Object.entries(review).every(([key, value]) => approval[key] === value) &&
      sha.test(approval.reviewSha256),
    'Initial recovery requires explicit reviewed old/new digests and unit hashes; no inferred approval.',
  );
  const persist = async (recovery, image = state.image) => {
    try {
      await save({ ...state, image, initialActivationRecovery: recovery });
    } catch {
      uncertainStates.add(state);
      throw new PilotError(
        'Initial recovery local durability failed; reload persistent state and retain all transaction facts.',
      );
    }
    state.initialActivationRecovery = recovery;
    state.image = image;
  };
  const previous = state.initialActivationRecovery;
  requirePilot(
    !previous?.conflict,
    'Bound post-intent conflict prohibits automatic initial recovery; retain journal, backup, receipt and image pin for lead reconciliation.',
  );
  const conflict = async (intent, result) => {
    requirePilot(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        intent.operationId ?? '',
      ) &&
        Object.entries(review).every(([key, value]) => intent[key] === value),
      'Cannot bind recovery conflict to the approved transaction.',
    );
    await persist({
      ...intent,
      conflict: result ?? {
        operationId: intent.operationId,
        status: conflictStatus,
        oldUnitSha256: intent.oldUnitSha256,
        newUnitSha256: intent.newUnitSha256,
      },
    });
    throw new PilotError(
      'Bound post-intent conflict prohibits automatic continuation; journal, backup, applied receipt and image pin retained.',
    );
  };
  if (
    previous?.status === 'ineligible' &&
    previous.receipt?.status === 'applied'
  )
    await conflict(previous);
  requirePilot(
    previous?.status !== 'ineligible',
    'Initial activation recovery is permanently ineligible; never delete evidence to retry.',
  );
  if (previous?.status === 'complete') {
    requirePilot(
      Object.entries(review).every(([key, value]) => previous[key] === value) &&
        state.image === target.newImage &&
        previous.reviewSha256 === approval.reviewSha256 &&
        isDeepStrictEqual(previous.binding, state.binding) &&
        previous.fsUuid === state.fsUuid &&
        previous.diskOperationId === state.operationId &&
        isDeepStrictEqual(previous.receipt, {
          operationId: previous.operationId,
          status: 'applied',
          oldUnitSha256: target.oldUnitSha256,
          newUnitSha256: target.newUnitSha256,
        }),
      'Completed one-off recovery cannot be rebound or used for another upgrade.',
    );
    return;
  }
  if (state.provisioned || state.configured) {
    if (previous && ['prepared', 'applied'].includes(previous.status))
      await conflict(previous);
    await persist({
      ...(previous ?? review),
      version: 1,
      status: 'ineligible',
    });
    requirePilot(
      false,
      'Application activation/configuration makes initial recovery permanently ineligible.',
    );
  }
  requirePilot(
    ssh.kind === RUN_COMMAND.version &&
      state.image === INITIAL_IMAGE &&
      state.fsUuid &&
      !state.pullOperationId &&
      !state.management?.pending,
    'Initial recovery requires the original image pin, verified filesystem, managed transport, and no pending management/pull. Reconcile first.',
  );
  const verified = await verifyVm(
    az,
    output,
    parameters,
    state,
    async () => {},
  );
  requirePilot(
    verified.power === 'PowerState/running' &&
      isDeepStrictEqual(verified.state.binding, state.binding),
    'Fresh live VM/disk bindings or running state differ; no recovery write.',
  );
  await dormantToken(az, output);
  await ssh.requireProtectedInput();
  const immutable = immutableState(state);
  const intent = previous ?? {
    ...review,
    status: 'prepared',
    operationId: randomUUID(),
    reviewSha256: approval.reviewSha256,
    binding: structuredClone(state.binding),
    fsUuid: state.fsUuid,
    diskOperationId: state.operationId,
    immutableStateSha256: digest(JSON.stringify(immutable)),
  };
  requirePilot(
    ['prepared', 'applied'].includes(intent.status) &&
      Object.entries(review).every(([key, value]) => intent[key] === value) &&
      intent.reviewSha256 === approval.reviewSha256 &&
      isDeepStrictEqual(intent.binding, state.binding) &&
      intent.fsUuid === state.fsUuid &&
      intent.diskOperationId === state.operationId &&
      intent.immutableStateSha256 === digest(JSON.stringify(immutable)),
    'Prepared recovery bindings, review or immutable state changed; stop, never clear pins or roll back blindly.',
  );
  if (!previous) await persist(intent); // Durable local intent before any guest write.
  const {
    status: _status,
    receipt: _receipt,
    conflict: _conflict,
    ...guestIntent
  } = intent;
  const resultBinding = {
    operationId: intent.operationId,
    oldUnitSha256: intent.oldUnitSha256,
    newUnitSha256: intent.newUnitSha256,
  };
  const result = JSON.parse(
    await ssh.run(rootCommand(`/usr/bin/python3 -c ${quote(program)}`, 180), {
      input: Buffer.from(JSON.stringify({ ...guestIntent, oldUnit, newUnit })),
      schema: 'recovery',
      recovery: resultBinding,
      timeoutMs: 260_000,
    }),
  );
  requirePilot(
    isDeepStrictEqual(result, { ...resultBinding, status: result.status }) &&
      ['applied', 'ineligible', conflictStatus].includes(result.status),
    'Unexpected initial recovery receipt.',
  );
  if (
    result.status === conflictStatus ||
    (result.status === 'ineligible' && previous)
  )
    await conflict(intent, { ...result, status: conflictStatus });
  if (result.status === 'ineligible') {
    await persist({ ...intent, status: 'ineligible', receipt: result });
    requirePilot(
      false,
      'Guest activation, image, configuration or data makes recovery permanently ineligible. Preserve all evidence.',
    );
  }
  const applied = { ...intent, status: 'applied', receipt: result };
  if (state.provisioned || state.configured) await conflict(applied);
  requirePilot(
    isDeepStrictEqual(immutableState(state), immutable),
    'Immutable local state changed during recovery; retain applied intent.',
  );
  await persist(applied);
  if (state.provisioned || state.configured)
    await conflict(state.initialActivationRecovery);
  requirePilot(
    isDeepStrictEqual(immutableState(state), immutable),
    'Immutable local state changed before pin commit; retain applied intent.',
  );
  // Applied receipt is durable first. This atomic save changes only the image pin and recovery metadata.
  await persist(
    { ...state.initialActivationRecovery, status: 'complete' },
    target.newImage,
  );
}
