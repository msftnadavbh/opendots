import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import {
  SCOPE,
  TAGS,
  VM,
  RUN_COMMAND,
  PilotError,
  assertEnvironment,
  assertOwned,
  requirePilot,
} from './scope.mjs';
import { rootCommand } from './ssh.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const wrapper = readFileSync(
  new URL('./run-command-wrapper.py', import.meta.url),
  'utf8',
);
export const TRANSPORT_SHA256 = hash(
  readFileSync(new URL(import.meta.url)) +
    wrapper +
    readFileSync(new URL('./scope.mjs', import.meta.url)) +
    readFileSync(new URL('./ssh.mjs', import.meta.url)),
);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const schemas = ['empty', 'status', 'image', 'disk', 'canary', 'recovery'];
const categories = [
  'ok',
  'command-failed',
  'deadline',
  'invalid-output',
  'invalid-input',
];
const endpoint = `https://management.azure.com${RUN_COMMAND.id}?api-version=${RUN_COMMAND.api}`;
const handlerEndpoint = `https://management.azure.com${RUN_COMMAND.handlerId}?api-version=${RUN_COMMAND.api}&$expand=instanceView`;
const fail = () =>
  new PilotError(
    'Managed Run Command request failed or was interrupted; provider details suppressed. Retain pending intent and reconcile before reuse; never retry PUT blindly.',
  );
const exactKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

// Only the real PUT client can prove that its HTTP invocation never began.
class NotDispatchedError extends PilotError {
  constructor() {
    super(
      'Managed Run Command PUT was not dispatched; request preflight failed. Details suppressed; no automatic resubmission.',
    );
  }
}

// No URL, origin, method override, deployment, redirect or secret CLI argument is accepted.
export function runCommandClient(az, fetcher = fetch) {
  const request = async (url, method, { body, signal } = {}) => {
    let invoked = false;
    try {
      assertEnvironment();
      signal?.throwIfAborted();
      await az.verify({ signal, timeoutMs: 30_000 });
      signal?.throwIfAborted();
      const token = await az.read(
        [
          'account',
          'get-access-token',
          '--resource',
          'https://management.azure.com/',
        ],
        { signal, timeoutMs: 30_000 },
      );
      const claims = JSON.parse(
        Buffer.from(token.accessToken.split('.')[1], 'base64url').toString(),
      );
      requirePilot(
        token.subscription === SCOPE.subscriptionId &&
          token.tenant === SCOPE.tenantId &&
          token.tokenType === 'Bearer' &&
          claims.tid === SCOPE.tenantId &&
          claims.oid === SCOPE.principalId &&
          [
            'https://management.azure.com/',
            'https://management.core.windows.net/',
          ].includes(claims.aud) &&
          claims.exp * 1000 > Date.now(),
        'ARM credential does not match the pinned pilot user, tenant and subscription.',
      );
      const request = {
        method,
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      };
      signal?.throwIfAborted();
      invoked = true; // Even a synchronous fetcher throw is an unknown submission.
      const response = await fetcher(url, request);
      if (response.status === 404 && method === 'GET') {
        await response.body?.cancel();
        return undefined;
      }
      if (![200, 201, 202].includes(response.status)) {
        await response.body?.cancel();
        throw new PilotError(
          'Managed Run Command HTTP request refused; response body suppressed. Stop on policy/governance denial; no fallback or scope broadening.',
        );
      }
      if (method === 'PUT') {
        await response.body?.cancel();
        return;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new PilotError('Unexpected managed Run Command read status.');
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          requirePilot(
            size <= 128 * 1024,
            'Managed Run Command response exceeded its fixed bound.',
          );
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (method === 'PUT' && !invoked) throw new NotDispatchedError();
      throw error instanceof PilotError &&
        !(error instanceof NotDispatchedError)
        ? error
        : fail();
    }
  };
  return {
    get: (signal) =>
      request(endpoint + '&$expand=instanceView', 'GET', { signal }),
    put: (body, signal) => request(endpoint, 'PUT', { body, signal }),
    handler: (signal) => request(handlerEndpoint, 'GET', { signal }),
  };
}

export function assertManagedHandler(resource, ready = false) {
  const p = resource?.properties;
  requirePilot(
    resource?.id?.toLowerCase() === RUN_COMMAND.handlerId.toLowerCase() &&
      resource.type?.toLowerCase() ===
        'microsoft.compute/virtualmachines/extensions' &&
      resource.location?.toLowerCase() === SCOPE.location &&
      p?.publisher === RUN_COMMAND.publisher &&
      p.type === RUN_COMMAND.handlerType &&
      /^\d+\.\d+(?:\.\d+){0,2}$/.test(p.typeHandlerVersion ?? '') &&
      (!ready ||
        (p.provisioningState === 'Succeeded' &&
          /^\d+\.\d+(?:\.\d+){0,2}$/.test(
            p.instanceView?.typeHandlerVersion ?? '',
          ) &&
          p.instanceView.statuses?.some(
            (s) => s.code === 'ProvisioningState/succeeded',
          ))),
    'Managed Run Command handler identity/version/readiness is unverified. Stop for exact handler review; do not allow other extensions.',
  );
  return {
    id: RUN_COMMAND.handlerId,
    publisher: p.publisher,
    type: p.type,
    configuredVersion: p.typeHandlerVersion,
    version: ready ? p.instanceView.typeHandlerVersion : p.typeHandlerVersion,
  };
}

async function submissionReady(az, client, state, existing, signal) {
  const options = { signal, timeoutMs: 30_000 };
  signal.throwIfAborted();
  await az.verify(options);
  const endpoint = `https://management.azure.com${VM.ids.id}`;
  const vmApi = '2025-11-01';
  const vm = await az.read(
    [
      'rest',
      '--method',
      'get',
      '--url',
      `${endpoint}?api-version=${vmApi}&$expand=instanceView`,
    ],
    options,
  );
  assertOwned(vm, VM.ids.id);
  const p = vm.properties,
    view = p?.instanceView,
    agent = view?.vmAgent;
  const status = (items, prefix, expected) =>
    Array.isArray(items) &&
    items.filter((item) => item.code?.startsWith(prefix)).length === 1 &&
    items.some((item) => item.code === expected);
  requirePilot(
    p?.vmId === state.binding.vmUniqueId &&
      vm.identity?.type === 'SystemAssigned' &&
      vm.identity.tenantId === state.binding.tenantId &&
      vm.identity.principalId === state.binding.principalId &&
      !Object.keys(vm.identity.userAssignedIdentities ?? {}).length &&
      p.osProfile?.linuxConfiguration?.provisionVMAgent === true &&
      p.provisioningState === 'Succeeded' &&
      view?.statuses?.length === 2 &&
      status(view?.statuses, 'PowerState/', 'PowerState/running') &&
      status(
        view?.statuses,
        'ProvisioningState/',
        'ProvisioningState/succeeded',
      ) &&
      Array.isArray(agent?.statuses) &&
      agent.statuses.length === 1 &&
      agent.statuses[0].code === 'ProvisioningState/succeeded' &&
      agent.statuses[0].level === 'Info' &&
      agent.statuses[0].displayStatus === 'Ready' &&
      /^(0|[1-9]\d{0,5})(\.(0|[1-9]\d{0,5})){3}$/.test(
        agent.vmAgentVersion ?? '',
      ),
    'Fresh bound VM/running/provisioning/Ready guest-agent evidence is unavailable; no new managed submission.',
  );
  // Documented Linux managed Run Command minimum; compare components, not strings.
  const minimum = [2, 4, 0, 2],
    version = agent.vmAgentVersion.split('.').map(Number);
  const different = version.findIndex((part, index) => part !== minimum[index]);
  requirePilot(
    different === -1 || version[different] > minimum[different],
    'Guest agent is older than the supported managed Run Command minimum 2.4.0.2.',
  );
  const inventory = await az.read(
    [
      'rest',
      '--method',
      'get',
      '--url',
      `${endpoint}/extensions?api-version=${vmApi}`,
    ],
    options,
  );
  requirePilot(
    Array.isArray(inventory?.value) &&
      inventory.nextLink == null &&
      inventory.value.length <= 2 &&
      new Set(inventory.value.map((item) => item.id?.toLowerCase())).size ===
        inventory.value.length,
    'Complete bounded VM extension inventory is unavailable; an error or partial page is not an empty inventory.',
  );
  let managed = false;
  for (const extension of inventory.value) {
    const id = extension.id?.toLowerCase();
    requirePilot(
      extension.properties?.provisioningState === 'Succeeded',
      'A VM extension is failed, transitional or unknown; no new managed submission.',
    );
    if (id === RUN_COMMAND.handlerId.toLowerCase()) {
      requirePilot(
        existing && state.management?.receipt,
        'Untracked managed handler; refusing first-use adoption.',
      );
      const configured = assertManagedHandler(extension);
      const observed = await client.handler(signal);
      const running = assertManagedHandler(observed, true);
      requirePilot(
        configured.configuredVersion === running.configuredVersion &&
          observed.properties.instanceView.statuses?.length === 1 &&
          observed.properties.instanceView.statuses[0].level === 'Info' &&
          status(
            observed.properties.instanceView.statuses,
            'ProvisioningState/',
            'ProvisioningState/succeeded',
          ),
        'Managed handler changed or has conflicting readiness during inspection.',
      );
      managed = true;
    } else {
      requirePilot(
        id === `${VM.ids.id}/extensions/RunCommandLinux`.toLowerCase() &&
          extension.type?.toLowerCase() ===
            'microsoft.compute/virtualmachines/extensions' &&
          extension.location?.toLowerCase() === SCOPE.location &&
          extension.properties.publisher === 'Microsoft.CPlat.Core' &&
          extension.properties.type === 'RunCommandLinux' &&
          /^\d+\.\d+(?:\.\d+){0,2}$/.test(
            extension.properties.typeHandlerVersion ?? '',
          ),
        'Unexpected VM extension; no new managed submission.',
      );
      const observed = await az.read(
        [
          'rest',
          '--method',
          'get',
          '--url',
          `${endpoint}/extensions/RunCommandLinux?api-version=${vmApi}&$expand=instanceView`,
        ],
        options,
      );
      requirePilot(
        observed?.id?.toLowerCase() === id &&
          observed.type === extension.type &&
          observed.location === extension.location &&
          observed.properties?.publisher === extension.properties.publisher &&
          observed.properties.type === extension.properties.type &&
          observed.properties.typeHandlerVersion ===
            extension.properties.typeHandlerVersion &&
          observed.properties.provisioningState === 'Succeeded' &&
          observed.properties.instanceView?.statuses?.length === 1 &&
          observed.properties.instanceView.statuses[0].level === 'Info' &&
          status(
            observed.properties.instanceView?.statuses,
            'ProvisioningState/',
            'ProvisioningState/succeeded',
          ),
        'Historical action handler readiness is unavailable; no new managed submission.',
      );
    }
  }
  requirePilot(
    managed ||
      (!existing &&
        !state.management?.receipt &&
        !state.management?.canary &&
        !state.management?.privacyValidation),
    'Previously tracked managed handler is missing; refusing recreation.',
  );
  signal.throwIfAborted();
}

function assertOperation(operation) {
  requirePilot(
    operation &&
      uuid.test(operation.operationId) &&
      sha.test(operation.sourceSha256) &&
      sha.test(operation.transportSha256) &&
      sha.test(operation.bindingSha256) &&
      schemas.includes(operation.schema) &&
      Number.isInteger(operation.timeoutInSeconds) &&
      operation.timeoutInSeconds >= 1 &&
      operation.timeoutInSeconds <= 1320,
    'Existing managed Run Command has no durable local intent/receipt; refusing adoption.',
  );
}

export function assertManagedCommand(resource, operation) {
  assertOwned(resource, RUN_COMMAND.id);
  assertOperation(operation);
  const p = resource.properties;
  requirePilot(
    resource.name === RUN_COMMAND.name &&
      resource.type?.toLowerCase() === RUN_COMMAND.type.toLowerCase() &&
      isDeepStrictEqual(resource.tags, {
        ...TAGS,
        transport: RUN_COMMAND.version,
        operationId: operation.operationId,
        transportSha256: operation.transportSha256,
      }) &&
      exactKeys(p?.source, ['script']) &&
      typeof p.source.script === 'string' &&
      hash(p.source.script) === operation.sourceSha256 &&
      p.timeoutInSeconds === operation.timeoutInSeconds &&
      p.asyncExecution === false &&
      p.treatFailureAsDeploymentFailure === false &&
      (p.parameters == null ||
        (Array.isArray(p.parameters) && p.parameters.length === 0)) &&
      (p.protectedParameters == null ||
        (Array.isArray(p.protectedParameters) &&
          p.protectedParameters.length === 0)) &&
      [
        'runAsUser',
        'runAsPassword',
        'outputBlobUri',
        'errorBlobUri',
        'outputBlobManagedIdentity',
        'errorBlobManagedIdentity',
      ].every((key) => !p[key]),
    'Managed Run Command resource/source/operation drift or exposed parameters; pending intent retained. No adoption or overwrite.',
  );
}

// Selection never mixes fields from the pending and durable prior contracts.
export function assertKnownManagedCommand(resource, state) {
  const m = state?.management;
  const matches = [m?.pending, m?.receipt].filter(
    (op) => op && op.operationId === resource?.tags?.operationId,
  );
  requirePilot(
    m?.version === 1 &&
      m.resourceId === RUN_COMMAND.id &&
      m.vmUniqueId === state.binding?.vmUniqueId &&
      matches.length === 1,
    'Managed resource has no unique known intent/receipt; refusing adoption.',
  );
  const operation = matches[0];
  requirePilot(
    operation.bindingSha256 === bindingHash(state),
    'Managed operation belongs to another VM binding.',
  );
  assertManagedCommand(resource, operation);
  return operation;
}

const boundDisk = (state) => ({
  operationId: state.operationId,
  vmUniqueId: state.binding.vmUniqueId,
  diskId: state.binding.diskId,
  diskUniqueId: state.binding.diskUniqueId,
  fsUuid: state.fsUuid ?? null,
});
function bindingHash(state) {
  requirePilot(
    state.binding?.vmId === VM.ids.id &&
      state.binding.vmUniqueId === state.seenVmUniqueId &&
      state.binding.diskId === VM.ids.dataDiskId &&
      state.binding.diskUniqueId === state.creation?.uniqueId &&
      state.binding.tenantId === SCOPE.tenantId,
    'Managed Run Command requires the existing immutable VM/disk/tenant bindings.',
  );
  // Filesystem UUID is learned by the existing disk gate, not a new transport pin.
  return hash(JSON.stringify(state.binding));
}

export function managedScript(spec) {
  return `#!/bin/sh\nexec /usr/bin/python3 - 2>/dev/null <<'OPENDOTS_MANAGED_V1'\n${wrapper}\nmain(json.loads(${JSON.stringify(JSON.stringify(spec))}))\nOPENDOTS_MANAGED_V1\n`;
}

const terminal = (view) =>
  ['Succeeded', 'Failed', 'TimedOut', 'Canceled'].includes(
    view?.executionState,
  );
function receiptOutput(view) {
  requirePilot(
    typeof view.output === 'string' &&
      Buffer.byteLength(view.output) <= 3072 &&
      !view.error?.trim(),
    'Managed Run Command has no bounded private completion receipt; reconcile, never assume completion.',
  );
  try {
    return JSON.parse(view.output);
  } catch {
    throw fail();
  }
}

function receipt(resource, operation) {
  const view = resource.properties?.instanceView;
  if (!terminal(view)) {
    requirePilot(
      ((!view || exactKeys(view, [])) &&
        ['Creating', 'Updating'].includes(
          resource.properties.provisioningState,
        )) ||
        (['Unknown', 'Pending', 'Running'].includes(view?.executionState) &&
          (view.output == null || view.output === '') &&
          (view.error == null || view.error === '') &&
          (view.exitCode == null || view.exitCode === 0)),
      'Managed Run Command has an invalid nonterminal execution view; pending intent retained.',
    );
    return;
  }
  const value = receiptOutput(view);
  requirePilot(
    exactKeys(value, [
      'version',
      'operationId',
      'exitCode',
      'category',
      'result',
    ]) &&
      value.version === 1 &&
      value.operationId === operation.operationId &&
      Number.isInteger(value.exitCode) &&
      value.exitCode >= 0 &&
      value.exitCode <= 255 &&
      value.exitCode === view.exitCode &&
      categories.includes(value.category) &&
      (value.exitCode === 0) === (value.category === 'ok') &&
      (value.exitCode === 0) === (view.executionState === 'Succeeded'),
    'Managed Run Command completion identity/status differs; retain pending intent.',
  );
  let valid = value.result === '';
  if (value.exitCode === 0) {
    if (operation.schema === 'status') valid = value.result === 'active';
    else if (operation.schema === 'image')
      valid = ['true', 'false'].includes(value.result);
    else if (operation.schema === 'canary')
      valid = value.result === 'canary-ok';
    else if (operation.schema === 'disk')
      valid =
        exactKeys(value.result, Object.keys(operation.disk)) &&
        Object.entries(operation.disk).every(([key, expected]) =>
          key === 'fsUuid'
            ? uuid.test(value.result[key]) &&
              (!expected || value.result[key] === expected)
            : value.result[key] === expected,
        );
    else if (operation.schema === 'recovery')
      valid =
        exactKeys(value.result, [
          'operationId',
          'status',
          'oldUnitSha256',
          'newUnitSha256',
        ]) &&
        ['applied', 'ineligible', 'post-intent-conflict'].includes(
          value.result.status,
        ) &&
        Object.entries(operation.recovery).every(
          ([key, expected]) => value.result[key] === expected,
        );
  }
  requirePilot(
    valid,
    'Managed Run Command returned a non-allowlisted result; raw output suppressed.',
  );
  return {
    ...operation,
    completedAt: new Date().toISOString(),
    executionState: view.executionState,
    ...value,
  };
}

function assertPriorCompletion(resource, prior, binding) {
  requirePilot(
    prior,
    'No durable prior completion exists for this execution view.',
  );
  assertOperation(prior);
  requirePilot(
    prior.bindingSha256 === binding,
    'Prior completion belongs to another VM binding.',
  );
  const completed = receipt(resource, prior);
  requirePilot(
    completed &&
      ['version', 'operationId', 'exitCode', 'category', 'result'].every(
        (key) => isDeepStrictEqual(completed[key], prior[key]),
      ) &&
      completed.executionState ===
        // Old success receipts prove Succeeded; an unrecorded failure state is ambiguous.
        (prior.executionState ??
          (prior.exitCode === 0 ? 'Succeeded' : undefined)),
    'Prior managed completion changed; pending intent retained.',
  );
}

export const PRIVACY_CHECKS = Object.freeze([
  'get',
  'expandedGet',
  'activityLog',
  'agentSettings',
  'agentLogs',
  'scripts',
  'stdout',
  'stderr',
  'processTelemetry',
]);

function assertPrivacyProof(proof, candidate, state) {
  requirePilot(
    candidate &&
      candidate.transportSha256 === TRANSPORT_SHA256 &&
      candidate.vmUniqueId === state.binding.vmUniqueId &&
      uuid.test(candidate.operationId) &&
      sha.test(candidate.sourceSha256) &&
      exactKeys(proof, [
        'version',
        'canaryOperationId',
        'vmUniqueId',
        'transportSha256',
        'handler',
        'evidenceSha256',
        'validatedAt',
        'checks',
        'plaintextLeaks',
      ]) &&
      proof.version === 1 &&
      proof.canaryOperationId === candidate.operationId &&
      proof.vmUniqueId === candidate.vmUniqueId &&
      proof.transportSha256 === candidate.transportSha256 &&
      sha.test(proof.evidenceSha256) &&
      Number.isFinite(Date.parse(proof.validatedAt)) &&
      Date.parse(proof.validatedAt) >= Date.parse(candidate.completedAt) &&
      Date.parse(proof.validatedAt) <= Date.now() &&
      proof.plaintextLeaks === false &&
      exactKeys(proof.checks, PRIVACY_CHECKS) &&
      PRIVACY_CHECKS.every((key) => proof.checks[key] === true) &&
      isDeepStrictEqual(proof.handler, candidate.handler),
    'Privacy proof must explicitly attest every inspection for the successful privacy canary and exact VM/handler/transport. Protected input remains locked; no fabricated or partial proof.',
  );
}

// Call only under the existing operator lock, after fresh verifyVm/verifyLiveResources.
export function managedTransport({
  az,
  state,
  save,
  signal,
  client = runCommandClient(az),
  wait = pause,
}) {
  const binding = bindingHash(state);
  let busy = false,
    poisoned = false;
  const current = () => {
    requirePilot(
      !poisoned && bindingHash(state) === binding,
      'Managed transport is stale or has an uncertain local save; reload and reconcile.',
    );
    const management =
      state.management === undefined
        ? {
            version: 1,
            resourceId: RUN_COMMAND.id,
            vmUniqueId: state.binding.vmUniqueId,
          }
        : state.management;
    requirePilot(
      management?.version === 1 &&
        management.resourceId === RUN_COMMAND.id &&
        management.vmUniqueId === state.binding.vmUniqueId,
      'Foreign managed transport state; no rebind or adoption.',
    );
    return management;
  };
  const persist = async (management) => {
    try {
      const next = { ...state, management };
      if (management === undefined) delete next.management;
      await save(next);
      if (management === undefined) delete state.management;
      else state.management = management;
    } catch {
      poisoned = true;
      throw new PilotError(
        'Managed operation local durability failed; reload state and reconcile before any further submission.',
      );
    }
  };
  const exclusive = async (operation) => {
    requirePilot(
      !busy,
      'Another managed operation is active in this operator.',
    );
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  };
  const handler = async (operationSignal) =>
    assertManagedHandler(await client.handler(operationSignal), true);
  const requirePrivacy = async (operationSignal = signal) => {
    const m = current(),
      proof = m.privacyValidation;
    requirePilot(
      !m.pending,
      'Protected input is blocked by pending management; reconcile before obtaining credentials or configuration.',
    );
    assertPrivacyProof(proof, m.canary, state);
    requirePilot(
      isDeepStrictEqual(
        await handler(boundedSignal(operationSignal, 120_000)),
        proof.handler,
      ),
      'Managed handler changed since privacy validation; a new reviewed canary is required.',
    );
  };
  const poll = async (operation, operationSignal) => {
    while (true) {
      operationSignal?.throwIfAborted();
      const resource = await client.get(operationSignal);
      requirePilot(
        resource,
        'Pending managed resource is missing; outcome is unknown. Retain intent; no resubmission.',
      );
      const known = assertKnownManagedCommand(resource, state);
      const prior = current().receipt;
      let completed;
      if (known.operationId !== operation.operationId) {
        assertPriorCompletion(resource, prior, binding);
      } else if (
        prior &&
        terminal(resource.properties.instanceView) &&
        receiptOutput(resource.properties.instanceView)?.operationId ===
          prior?.operationId
      ) {
        assertPriorCompletion(resource, prior, binding);
      } else completed = receipt(resource, operation);
      if (completed) {
        const next = { ...current(), receipt: completed };
        delete next.pending;
        await persist(next);
        return completed;
      }
      await wait(2000, undefined, { signal: operationSignal });
    }
  };
  const boundedSignal = (operationSignal, timeoutMs) =>
    AbortSignal.any([
      ...(operationSignal ? [operationSignal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
  const reconcile = async ({
    signal: operationSignal = signal,
    timeoutMs = 240_000,
  } = {}) =>
    exclusive(async () => {
      requirePilot(
        Number.isInteger(timeoutMs) &&
          timeoutMs >= 1000 &&
          timeoutMs <= 1_320_000,
        'Invalid reconciliation deadline.',
      );
      const operation = current().pending;
      if (!operation) return;
      requirePilot(
        operation.bindingSha256 === binding,
        'Pending operation belongs to another VM binding.',
      );
      try {
        return await poll(operation, boundedSignal(operationSignal, timeoutMs));
      } catch (error) {
        throw error instanceof PilotError ? error : fail();
      }
    });
  const run = async (command, options = {}, canary = false) => {
    const {
      input,
      output,
      schema = 'empty',
      recovery,
      timeoutMs = 260_000,
      signal: operationSignal = signal,
    } = options;
    requirePilot(
      !output,
      'Managed Run Command cannot stream files or backups. Use the separately reviewed HTTPS backup path.',
    );
    requirePilot(
      schemas.includes(schema) &&
        (schema !== 'canary' || canary) &&
        Number.isInteger(timeoutMs) &&
        timeoutMs >= 31_000 &&
        timeoutMs <= 1_320_000 &&
        typeof command === 'string' &&
        Buffer.byteLength(command) <= 48 * 1024,
      'Invalid bounded managed command.',
    );
    operationSignal?.throwIfAborted();
    const m = current();
    requirePilot(
      !m.pending,
      'A managed operation is pending. Run management-reconcile before further guest work.',
    );
    const deadline = boundedSignal(operationSignal, timeoutMs);
    const operationId = randomUUID();
    const bytes = canary
      ? Buffer.from(`opendots-privacy-canary-v1:${operationId}\n`)
      : input === undefined
        ? undefined
        : Buffer.from(input);
    let body;
    try {
      requirePilot(
        !bytes || bytes.length <= 65536,
        'Managed protected input exceeds 64 KiB; no chunking or file-transfer fallback.',
      );
      if (bytes && !canary) await requirePrivacy(deadline);
      const existing = await client.get(deadline);
      if (existing) {
        requirePilot(
          m.receipt,
          'Untracked managed Run Command exists; refusing adoption.',
        );
        assertManagedCommand(existing, m.receipt);
        assertPriorCompletion(existing, m.receipt, binding);
      } else
        requirePilot(
          !m.receipt,
          'Tracked managed Run Command is missing; refusing recreation.',
        );
      // Ten seconds to reap after execution, five to report, then fifteen for client polling.
      const seconds = Math.floor(timeoutMs / 1000) - 30;
      const spec = { operationId, command, schema, seconds, hasInput: !!bytes };
      if (schema === 'disk') spec.disk = boundDisk(state);
      if (schema === 'recovery') {
        requirePilot(
          exactKeys(recovery, [
            'operationId',
            'oldUnitSha256',
            'newUnitSha256',
          ]) &&
            uuid.test(recovery.operationId) &&
            sha.test(recovery.oldUnitSha256) &&
            sha.test(recovery.newUnitSha256),
          'Invalid recovery result binding.',
        );
        spec.recovery = recovery;
      }
      if (canary) {
        spec.canarySha256 = hash(bytes);
        spec.command = rootCommand('true', 60);
      }
      const script = managedScript(spec);
      requirePilot(
        Buffer.byteLength(script) <= 64 * 1024 &&
          Buffer.byteLength(
            JSON.stringify({ properties: { source: { script } } }),
          ) <=
            112 * 1024,
        'Managed source exceeds the bounded request/reconciliation envelope.',
      );
      requirePilot(
        !bytes?.length ||
          (!script.includes(bytes.toString('utf8')) &&
            !script.includes(bytes.toString('base64'))),
        'Protected input must never appear in public managed source.',
      );
      const operation = {
        operationId,
        schema,
        sourceSha256: hash(script),
        commandSha256: hash(command),
        transportSha256: TRANSPORT_SHA256,
        bindingSha256: binding,
        timeoutInSeconds: seconds + 15,
        createdAt: new Date().toISOString(),
        protectedInput: !!bytes,
        ...(spec.disk ? { disk: spec.disk } : {}),
        ...(recovery ? { recovery } : {}),
      };
      await submissionReady(az, client, state, existing, deadline);
      const next = { ...m, pending: operation };
      if (canary) {
        delete next.privacyValidation;
        delete next.canary;
      }
      const prior =
        state.management === undefined ? undefined : structuredClone(m);
      if (canary && prior) {
        delete prior.privacyValidation;
        delete prior.canary;
      }
      deadline.throwIfAborted(); // No invalidation transition has happened yet.
      await persist(next); // Intent must be durable BEFORE PUT, including an ambiguous/aborted submission.
      body = {
        location: SCOPE.location,
        tags: {
          ...TAGS,
          transport: RUN_COMMAND.version,
          transportSha256: TRANSPORT_SHA256,
          operationId,
        },
        properties: {
          source: { script },
          parameters: [],
          protectedParameters: bytes
            ? [
                {
                  name: 'OPENDOTS_PROTECTED_INPUT',
                  value: bytes.toString('base64'),
                },
              ]
            : [],
          timeoutInSeconds: operation.timeoutInSeconds,
          asyncExecution: false,
          treatFailureAsDeploymentFailure: false,
        },
      };
      let completed;
      try {
        if (deadline.aborted) {
          await persist(prior);
          throw new PilotError(
            'Managed operation cancelled before the client call; prior management restored without resubmission. Canary approval remains invalidated.',
          );
        }
        try {
          await client.put(body, deadline);
        } catch (error) {
          if (error instanceof NotDispatchedError) await persist(prior);
          throw error;
        }
        completed = await poll(operation, deadline);
      } catch (error) {
        throw error instanceof PilotError ? error : fail();
      }
      if (completed.exitCode !== 0) {
        const error = new PilotError(
          `Managed guest operation failed (${completed.category}, exit ${completed.exitCode}); raw stdout/stderr suppressed. Completion receipt retained.`,
        );
        error.exitCode = completed.exitCode;
        throw error;
      }
      if (canary) {
        const candidate = {
          operationId,
          transportSha256: TRANSPORT_SHA256,
          vmUniqueId: state.binding.vmUniqueId,
          sourceSha256: operation.sourceSha256,
          handler: await handler(deadline),
          completedAt: completed.completedAt,
        };
        await persist({ ...current(), canary: candidate });
        return candidate;
      }
      return typeof completed.result === 'string'
        ? completed.result
        : JSON.stringify(completed.result);
    } finally {
      if (body) body.properties.protectedParameters = [];
      bytes?.fill(0);
    }
  };
  return {
    kind: RUN_COMMAND.version,
    signal,
    requireProtectedInput: requirePrivacy,
    run: (command, options) => exclusive(() => run(command, options)),
    reconcile,
    canary: () =>
      exclusive(() => run('', { schema: 'canary', timeoutMs: 140_000 }, true)),
    recordPrivacyValidation: (proof) =>
      exclusive(async () => {
        const m = current(),
          candidate = m.canary;
        assertPrivacyProof(proof, candidate, state);
        // A reviewed nonsecret inspection probe may reuse the child after the canary; never leave it pending.
        requirePilot(
          !m.pending &&
            m.receipt?.transportSha256 === TRANSPORT_SHA256 &&
            m.receipt.exitCode === 0,
          'Privacy proof requires reconciled successful management/inspection receipts.',
        );
        const deadline = boundedSignal(signal, 120_000);
        const resource = await client.get(deadline);
        assertManagedCommand(resource, m.receipt);
        const completed = receipt(resource, m.receipt);
        requirePilot(
          completed?.exitCode === 0 &&
            isDeepStrictEqual(completed.result, m.receipt.result),
          'Privacy inspection completion changed; proof cannot be recorded.',
        );
        requirePilot(
          isDeepStrictEqual(await handler(deadline), candidate.handler),
          'Handler drift since canary.',
        );
        await persist({ ...m, privacyValidation: structuredClone(proof) });
      }),
  };
}
