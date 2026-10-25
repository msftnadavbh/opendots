import assert from 'node:assert/strict';
import { SCOPE, RUN_COMMAND, VM } from '../scope.mjs';
import {
  managedTransport,
  PRIVACY_CHECKS,
  TRANSPORT_SHA256,
} from '../run-command.mjs';
import { state as initial, vmResources } from './fixtures.mjs';

export function handlerResource() {
  return {
    id: RUN_COMMAND.handlerId,
    type: 'Microsoft.Compute/virtualMachines/extensions',
    location: SCOPE.location,
    properties: {
      publisher: RUN_COMMAND.publisher,
      type: RUN_COMMAND.handlerType,
      typeHandlerVersion: '1.0',
      provisioningState: 'Succeeded',
      instanceView: {
        typeHandlerVersion: '1.3.0',
        statuses: [{ code: 'ProvisioningState/succeeded', level: 'Info' }],
      },
    },
  };
}

export function fixtureAuth(claimPatch = {}, tokenPatch = {}) {
  const claims = {
    tid: SCOPE.tenantId,
    oid: SCOPE.principalId,
    aud: 'https://management.azure.com/',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claimPatch,
  };
  const token = {
    accessToken: `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`,
    tenant: SCOPE.tenantId,
    subscription: SCOPE.subscriptionId,
    tokenType: 'Bearer',
    ...tokenPatch,
  };
  const calls = [];
  return {
    calls,
    verify: async (options) => {
      assert.equal(options.timeoutMs, 30_000);
      calls.push('verify');
    },
    read: async (args, options) => {
      assert.equal(options.timeoutMs, 30_000);
      calls.push(args);
      return token;
    },
  };
}

export function managedFixture(options = {}) {
  const f = {
    state: structuredClone(options.state ?? initial),
    saved: [],
    requests: [],
    calls: [],
    controller: new AbortController(),
    handler: handlerResource(),
    vm: vmResources().vm,
    extensions: { value: [] },
    resource: undefined,
    result: undefined,
    imagePresent: false,
    putFailure: undefined,
    mutation: undefined,
  };
  f.vm.properties.instanceView = {
    statuses: [
      { code: 'ProvisioningState/succeeded' },
      { code: 'PowerState/running' },
    ],
    vmAgent: {
      vmAgentVersion: '2.16.0.2',
      statuses: [
        {
          code: 'ProvisioningState/succeeded',
          level: 'Info',
          displayStatus: 'Ready',
        },
      ],
    },
  };
  f.az = {
    verify: async ({ signal, timeoutMs }) => {
      assert.equal(timeoutMs, 30_000);
      signal.throwIfAborted();
      f.calls.push('readiness');
    },
    read: async (args, { signal, timeoutMs }) => {
      assert.equal(timeoutMs, 30_000);
      signal.throwIfAborted();
      assert.deepEqual(args.slice(0, 4), ['rest', '--method', 'get', '--url']);
      const endpoint = `https://management.azure.com${VM.ids.id}`;
      if (args[4] === `${endpoint}?api-version=2025-11-01&$expand=instanceView`)
        return structuredClone(f.vm);
      assert.equal(args[4], `${endpoint}/extensions?api-version=2025-11-01`);
      return structuredClone(f.extensions);
    },
    write: () => assert.fail('Fixture readiness must never write Azure'),
  };
  f.durable = structuredClone(f.state);
  f.complete = (exitCode = 0, category = 'ok') => {
    const operation = f.state.management.pending ?? f.state.management.receipt;
    const result =
      f.result ??
      {
        empty: '',
        image: String(f.imagePresent),
        status: 'active',
        canary: 'canary-ok',
        disk: { ...operation.disk, fsUuid: initial.fsUuid },
        recovery: { ...operation.recovery, status: 'applied' },
      }[operation.schema];
    f.resource.properties.instanceView = {
      executionState: exitCode === 0 ? 'Succeeded' : 'Failed',
      exitCode,
      output: JSON.stringify({
        version: 1,
        operationId: operation.operationId,
        exitCode,
        category,
        result,
      }),
      error: '',
    };
  };
  f.save = async (value) => {
    f.calls.push(value.management?.pending ? 'save-intent' : 'save-receipt');
    await options.beforeSave?.(value);
    f.saved.push(structuredClone(value));
    f.durable = structuredClone(value);
    await options.afterSave?.(value);
  };
  f.client = {
    get: async () => {
      f.calls.push('GET');
      const value = structuredClone(f.resource);
      if (value) f.mutation?.(value);
      return value;
    },
    handler: async () => {
      f.calls.push('handler');
      return structuredClone(f.handler);
    },
    put: async (body, signal) => {
      assert(f.state.management?.pending, 'PUT must follow a durable intent');
      f.calls.push('PUT');
      f.requests.push(structuredClone(body));
      if (f.putFailure === 'before')
        throw new Error('private provider failure');
      f.resource = {
        ...structuredClone(body),
        id: RUN_COMMAND.id,
        type: RUN_COMMAND.type,
        name: RUN_COMMAND.name,
      };
      f.resource.properties.protectedParameters = [];
      if (!f.extensions.value.includes(f.handler))
        f.extensions.value.push(f.handler);
      f.complete();
      if (f.putFailure === 'after') throw new Error('private provider failure');
      await options.afterPut?.(f, signal);
    },
  };
  f.guest = managedTransport({
    az: f.az,
    state: f.state,
    save: f.save,
    client: f.client,
    signal: f.controller.signal,
    ...(options.wait ? { wait: options.wait } : {}),
  });
  f.proof = () => ({
    version: 1,
    canaryOperationId: f.state.management.canary.operationId,
    vmUniqueId: f.state.binding.vmUniqueId,
    transportSha256: TRANSPORT_SHA256,
    handler: structuredClone(f.state.management.canary.handler),
    evidenceSha256: 'f'.repeat(64),
    validatedAt: new Date().toISOString(),
    checks: Object.fromEntries(PRIVACY_CHECKS.map((key) => [key, true])),
    plaintextLeaks: false,
  });
  f.approveFixture = async () => {
    await f.guest.canary();
    await f.guest.recordPrivacyValidation(f.proof());
  };
  return f;
}
