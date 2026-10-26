import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SCOPE, TAGS, VM, RUN_COMMAND, safeError } from '../scope.mjs';
import { rootCommand } from '../ssh.mjs';
import { managedScript, TRANSPORT_SHA256 } from '../run-command.mjs';
import {
  managedFixture,
  nativeHandlers,
  handlerResource,
} from './managed-fixture.mjs';

const managedType = 'Microsoft.CPlat.Core.RunCommandHandlerLinux';
const natives = (f) => f.vm.properties.instanceView.vmAgent.extensionHandlers;
const managed = (f) => natives(f).find((item) => item.type === managedType);
const hash = (value) => createHash('sha256').update(value).digest('hex');

function explicit(f) {
  f.handler = handlerResource();
  f.extensions.value = [structuredClone(f.handler)];
  f.vm.properties.instanceView.extensions = [
    {
      name: 'RunCommandHandlerLinux',
      type: managedType,
      ...structuredClone(f.handler.properties.instanceView),
    },
  ];
}

test('captured native-only nested shape qualifies without inventing an ARM resource or configured version', async () => {
  const f = managedFixture();
  assert.deepEqual(
    natives(f).map((item) => [item.type, item.typeHandlerVersion]),
    [
      ['Microsoft.CPlat.Core.LinuxPatchExtension', '1.6.71'],
      [managedType, '1.3.28'],
      ['Microsoft.CPlat.Core.RunCommandLinux', '1.0.12'],
    ],
  );
  const candidate = await f.guest.canary();
  assert.deepEqual(candidate.handler, {
    kind: 'vmAgent.extensionHandlers',
    vmId: VM.ids.id,
    vmUniqueId: f.state.binding.vmUniqueId,
    type: managedType,
    runtimeVersion: '1.3.28',
    status: {
      code: 'ProvisioningState/succeeded',
      level: 'Info',
      displayStatus: 'Ready',
    },
    armExtension: { presence: 'absent' },
  });
  assert.equal(candidate.handler.id, undefined);
  assert.equal(candidate.handler.configuredVersion, undefined);
  assert.equal(f.handler, undefined);
  assert.deepEqual(f.extensions, { nextLink: null, value: [] });
  assert.deepEqual(f.vm.properties.instanceView.extensions, []);
  assert.equal(f.state.management.receipt.result, 'canary-ok');
  assert.equal(
    f.calls.filter((value) => value === 'handler').length,
    2,
    'GET404 must be checked before and after execution',
  );
});

test('empty native inventory is a modeled genuine first use, never a claim about the uncaptured pre-canary live list', async () => {
  const f = managedFixture();
  f.vm.properties.instanceView.vmAgent.extensionHandlers = [];
  await f.guest.canary();
  assert.deepEqual(
    natives(f),
    nativeHandlers().filter((item) => item.type === managedType),
  );
  assert.deepEqual(f.extensions.value, []);
  assert.equal(f.state.management.canary.handler.runtimeVersion, '1.3.28');
});

for (const auxiliary of [
  [],
  ['LinuxPatchExtension'],
  ['RunCommandLinux'],
  ['LinuxPatchExtension', 'RunCommandLinux'],
])
  test(`recognized auxiliary native handlers are optional: ${auxiliary.join(',') || 'none'}`, async () => {
    const f = managedFixture();
    f.vm.properties.instanceView.vmAgent.extensionHandlers = natives(f).filter(
      (item) =>
        item.type === managedType ||
        auxiliary.some((name) => item.type === `Microsoft.CPlat.Core.${name}`),
    );
    const before = structuredClone(natives(f));
    await f.guest.canary();
    await f.guest.recordPrivacyValidation(f.proof());
    await f.guest.requireProtectedInput();
    assert.deepEqual(natives(f), before);
    assert.deepEqual(f.extensions.value, []);
  });

const nativeDrift = {
  'missing collection': (f) => {
    delete f.vm.properties.instanceView.vmAgent.extensionHandlers;
  },
  'null collection': (f) => {
    f.vm.properties.instanceView.vmAgent.extensionHandlers = null;
  },
  'object collection': (f) => {
    f.vm.properties.instanceView.vmAgent.extensionHandlers = {};
  },
  'missing tracked runtime': (f) => {
    f.vm.properties.instanceView.vmAgent.extensionHandlers = [];
  },
  'unknown native type': (f) => {
    managed(f).type = 'Microsoft.CPlat.Core.Unreviewed';
  },
  'SDK-style projected collection': (f) => {
    f.vm.properties.instanceView.extensionHandlers = natives(f);
    delete f.vm.properties.instanceView.vmAgent.extensionHandlers;
  },
};
for (const type of nativeHandlers().map((item) => item.type)) {
  for (const [field, value] of [
    ['type', undefined],
    ['typeHandlerVersion', undefined],
    ['typeHandlerVersion', '1.3.29'],
    ['status', undefined],
    ['status', []],
    [
      'status',
      {
        code: 'ProvisioningState/updating',
        level: 'Info',
        displayStatus: 'Ready',
      },
    ],
    [
      'status',
      {
        code: 'ProvisioningState/succeeded',
        level: 'Warning',
        displayStatus: 'Ready',
      },
    ],
    [
      'status',
      {
        code: 'ProvisioningState/succeeded',
        level: 'Info',
        displayStatus: 'Not Ready',
      },
    ],
  ])
    nativeDrift[`${type} ${field} ${JSON.stringify(value)}`] = (f) => {
      natives(f).find((item) => item.type === type)[field] = value;
    };
  nativeDrift[`${type} duplicate`] = (f) => {
    const value = natives(f).find((item) => item.type === type);
    f.vm.properties.instanceView.vmAgent.extensionHandlers = [
      value,
      structuredClone(value),
    ];
  };
}
for (const [name, mutate] of Object.entries(nativeDrift))
  test(`native discovery rejects ${name} without PUT/intent or invalidating durable approval`, async () => {
    const f = managedFixture();
    await f.approveFixture();
    const before = structuredClone(f.state),
      saves = f.saved.length,
      requests = f.requests.length;
    mutate(f);
    await assert.rejects(f.guest.canary());
    assert.deepEqual(f.state, before);
    assert.equal(f.saved.length, saves);
    assert.equal(f.requests.length, requests);
  });

test('messages/timestamps never become handler identity; descriptor drift still blocks both privacy gates', async () => {
  const f = managedFixture();
  await f.guest.canary();
  const candidate = structuredClone(f.state.management.canary);
  for (const item of natives(f))
    Object.assign(item.status, {
      message: 'different transient text',
      time: '2099-01-01T00:00:00Z',
    });
  await f.guest.recordPrivacyValidation(f.proof());
  await f.guest.requireProtectedInput();
  assert.deepEqual(f.state.management.canary, candidate);
  assert(!/"(message|time)":/.test(JSON.stringify(candidate.handler)));
  managed(f).typeHandlerVersion = '1.3.29';
  const before = structuredClone(f.state),
    saves = f.saved.length;
  await assert.rejects(f.guest.requireProtectedInput(), /handler changed/);
  await assert.rejects(
    f.guest.recordPrivacyValidation(f.proof()),
    /handler changed/,
  );
  assert.deepEqual(f.state, before);
  assert.equal(f.saved.length, saves);
});

for (const mutation of [
  'lookup-error',
  'native-disappeared',
  'native-version',
  'agent-not-ready',
  'VM-replaced',
  'ARM-contradiction',
])
  test(`post-completion ${mutation} retains the successful receipt, not pending/candidate/privacy approval`, async () => {
    const f = managedFixture({
      afterPut: async (f) => {
        if (mutation === 'lookup-error')
          f.client.handler = async () => {
            throw new Error('FAKE-PRIVATE-ERROR');
          };
        if (mutation === 'native-disappeared')
          f.vm.properties.instanceView.vmAgent.extensionHandlers = [];
        if (mutation === 'native-version')
          managed(f).typeHandlerVersion = '1.3.29';
        if (mutation === 'agent-not-ready')
          f.vm.properties.instanceView.vmAgent.statuses = [];
        if (mutation === 'VM-replaced') f.vm.properties.vmId = 'foreign';
        if (mutation === 'ARM-contradiction') f.handler = handlerResource();
      },
    });
    await assert.rejects(
      f.guest.canary(),
      (error) => !safeError(error).includes('FAKE-PRIVATE-ERROR'),
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.management.receipt.schema, 'canary');
    assert.equal(f.state.management.receipt.category, 'ok');
    assert.equal(f.state.management.receipt.exitCode, 0);
    assert.equal(f.state.management.receipt.result, 'canary-ok');
    assert.equal(f.saved.length, 2);
    assert(
      !f.state.management.pending &&
        !f.state.management.canary &&
        !f.state.management.privacyValidation,
    );
    const before = structuredClone(f.state);
    await assert.rejects(f.guest.requireProtectedInput(), /Privacy proof/);
    assert.equal(await f.guest.reconcile(), undefined);
    assert.deepEqual(f.state, before);
  });

test('a ready preexisting native runtime does not authorize adopting a preexisting explicit ARM handler', async () => {
  const f = managedFixture();
  explicit(f);
  await assert.rejects(f.guest.canary(), /first-use adoption/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.saved.length, 0);
});

for (const configured of ['1.3', '1.3.28', '1.0'])
  test(`explicit configured ${configured} remains distinct from validated native/runtime 1.3.28`, async () => {
    const f = managedFixture();
    await f.guest.canary();
    explicit(f);
    f.handler.properties.typeHandlerVersion = configured;
    f.extensions.value[0].properties.typeHandlerVersion = configured;
    const candidate = await f.guest.canary();
    assert.deepEqual(candidate.handler.armExtension, {
      presence: 'present',
      id: RUN_COMMAND.handlerId,
      publisher: 'Microsoft.CPlat.Core',
      type: 'RunCommandHandlerLinux',
      configuredVersion: configured,
      runtimeVersion: '1.3.28',
      status: { code: 'ProvisioningState/succeeded', level: 'Info' },
    });
    await f.guest.recordPrivacyValidation(f.proof());
    await f.guest.requireProtectedInput();
  });

const contradictions = {
  'listed managed + GET404': (f) => {
    f.handler = undefined;
  },
  'empty list + GETexists': (f) => {
    f.extensions.value = [];
  },
  'GET200 null is not GET404': (f) => {
    f.handler = null;
    f.extensions.value = [];
  },
  'list/get configured mismatch': (f) => {
    f.handler.properties.typeHandlerVersion = '1.4';
  },
  'list/get runtime mismatch': (f) => {
    f.extensions.value[0].properties.instanceView.typeHandlerVersion = '1.3.29';
  },
  'list/get status mismatch': (f) => {
    f.extensions.value[0].properties.instanceView.statuses[0].code =
      'ProvisioningState/failed';
  },
  'GET runtime mismatch': (f) => {
    f.handler.properties.instanceView.typeHandlerVersion = '1.3.29';
  },
  'GET wrong identity': (f) => {
    f.handler.id += '-foreign';
  },
  'GET publisher mismatch': (f) => {
    f.handler.properties.publisher = 'foreign';
  },
  'GET transitional': (f) => {
    f.handler.properties.provisioningState = 'Updating';
  },
  'top view drops explicit entry': (f) => {
    f.vm.properties.instanceView.extensions = [];
  },
  'top view duplicate': (f) => {
    f.vm.properties.instanceView.extensions.push(
      f.vm.properties.instanceView.extensions[0],
    );
  },
  'top view foreign type': (f) => {
    f.vm.properties.instanceView.extensions[0].type =
      'Microsoft.CPlat.Core.Unreviewed';
  },
  'top view wrong name': (f) => {
    f.vm.properties.instanceView.extensions[0].name = 'foreign';
  },
  'top view version': (f) => {
    f.vm.properties.instanceView.extensions[0].typeHandlerVersion = '1.3.29';
  },
  'top view readiness': (f) => {
    f.vm.properties.instanceView.extensions[0].statuses[0].level = 'Error';
  },
  'top view null': (f) => {
    f.vm.properties.instanceView.extensions = null;
  },
};
for (const [name, mutate] of Object.entries(contradictions))
  test(`independent handler surfaces reject ${name} without state writes`, async () => {
    const f = managedFixture();
    await f.approveFixture();
    explicit(f);
    const before = structuredClone(f.state),
      saves = f.saved.length,
      requests = f.requests.length;
    mutate(f);
    await assert.rejects(f.guest.canary());
    assert.deepEqual(f.state, before);
    assert.equal(f.saved.length, saves);
    assert.equal(f.requests.length, requests);
  });

test('optional top-level native views are validated, not required or silently discarded', async () => {
  const f = managedFixture();
  f.vm.properties.instanceView.extensions = [
    {
      name: 'RunCommandHandlerLinux',
      type: managedType,
      typeHandlerVersion: '1.3.28',
      statuses: [{ code: 'ProvisioningState/succeeded', level: 'Info' }],
    },
  ];
  await f.guest.canary();
  delete f.vm.properties.instanceView.extensions;
  await f.guest.recordPrivacyValidation(f.proof());
  await f.guest.requireProtectedInput();
});

test('recognition of the native patch handler grants no ARM extension allowance', async () => {
  const f = managedFixture();
  await f.approveFixture();
  const extension = handlerResource();
  extension.id = `${VM.ids.id}/extensions/LinuxPatchExtension`;
  extension.properties.type = 'LinuxPatchExtension';
  f.extensions.value.push(extension);
  const before = structuredClone(f.state);
  await assert.rejects(f.guest.canary(), /Unexpected explicit/);
  assert.deepEqual(f.state, before);
  assert.equal(f.requests.length, 1);
});

const oldId = '4d9396c2-acbb-4bb9-a3b3-2b17020659c6';
const oldTransport =
  '0b9b482a675c32c0bed2d1a0af3650a3905b9806ad3cfcfa716b011b5ff10d0d';
const oldSource =
  '8c159ec7ff021dbd21b66397307a2cba4254205f1574157f5e1e686f328156ff';
function historicalFixture(pending = false) {
  const f = managedFixture();
  const script = managedScript({
    operationId: oldId,
    command: rootCommand('true', 60),
    schema: 'canary',
    seconds: 110,
    hasInput: true,
    canarySha256: hash(`opendots-privacy-canary-v1:${oldId}\n`),
  });
  assert.equal(
    hash(script),
    oldSource,
    'Frozen public source must reproduce the actual historical canary hash',
  );
  const operation = {
    operationId: oldId,
    schema: 'canary',
    sourceSha256: oldSource,
    commandSha256: hash(''),
    transportSha256: oldTransport,
    bindingSha256: hash(JSON.stringify(f.state.binding)),
    timeoutInSeconds: 125,
    createdAt: '2026-10-25T16:00:00.000Z',
    protectedInput: true,
  };
  const result = {
    version: 1,
    operationId: oldId,
    exitCode: 0,
    category: 'ok',
    result: 'canary-ok',
  };
  const receipt = {
    ...operation,
    completedAt: '2026-10-25T16:01:00.000Z',
    executionState: 'Succeeded',
    ...result,
  };
  f.state.management = {
    version: 1,
    resourceId: RUN_COMMAND.id,
    vmUniqueId: f.state.binding.vmUniqueId,
    ...(pending ? { pending: operation } : { receipt }),
  };
  f.resource = {
    id: RUN_COMMAND.id,
    name: RUN_COMMAND.name,
    type: RUN_COMMAND.type,
    location: SCOPE.location,
    tags: {
      ...TAGS,
      transport: RUN_COMMAND.version,
      operationId: oldId,
      transportSha256: oldTransport,
    },
    properties: {
      source: { script },
      parameters: [],
      protectedParameters: [],
      timeoutInSeconds: 125,
      asyncExecution: false,
      treatFailureAsDeploymentFailure: false,
      instanceView: {
        executionState: 'Succeeded',
        exitCode: 0,
        output: JSON.stringify(result),
        error: '',
      },
    },
  };
  f.durable = structuredClone(f.state);
  return f;
}

test('the actual historical source/hash contract passes preflight unchanged; only a deliberate new operation gets a candidate', async () => {
  const f = historicalFixture();
  assert.notEqual(TRANSPORT_SHA256, oldTransport);
  const old = structuredClone(f.state.management.receipt);
  await assert.rejects(f.guest.requireProtectedInput(), /Privacy proof/);
  assert.equal(await f.guest.reconcile(), undefined);
  assert.equal(f.requests.length, 0);
  assert.equal(f.saved.length, 0);
  const put = f.client.put;
  f.client.put = async (...args) => {
    assert.deepEqual(f.state.management.receipt, old);
    assert.notEqual(f.state.management.pending.operationId, oldId);
    await put(...args);
  };
  const candidate = await f.guest.canary();
  assert.notEqual(candidate.operationId, oldId);
  assert.equal(candidate.transportSha256, TRANSPORT_SHA256);
  assert.equal(candidate.handler.kind, 'vmAgent.extensionHandlers');
  assert.deepEqual(f.saved[0].management.receipt, old);
  assert(!f.state.management.privacyValidation);
  await assert.rejects(f.guest.requireProtectedInput(), /Privacy proof/);
  await f.guest.recordPrivacyValidation(f.proof());
  await f.guest.requireProtectedInput();
});

test('old-hash pending GET-only reconciliation remains available without any current native/ARM readiness', async () => {
  const f = historicalFixture(true);
  f.vm = undefined;
  f.extensions = undefined;
  f.az.read =
    f.az.verify =
    f.client.handler =
      () => assert.fail('GET reconciliation cannot discover handlers');
  const receipt = await f.guest.reconcile();
  assert.equal(receipt.operationId, oldId);
  assert.equal(receipt.sourceSha256, oldSource);
  assert.equal(receipt.transportSha256, oldTransport);
  assert.equal(receipt.exitCode, 0);
  assert(
    !f.state.management.pending &&
      !f.state.management.canary &&
      !f.state.management.privacyValidation,
  );
  assert.equal(f.requests.length, 0);
});

test('old handler proof shape cannot gain approval by copying the current transport hash', async () => {
  const f = managedFixture();
  await f.guest.canary();
  f.state.management.canary.handler = {
    id: RUN_COMMAND.handlerId,
    publisher: RUN_COMMAND.publisher,
    type: RUN_COMMAND.handlerType,
    configuredVersion: '1.3',
    version: '1.3.28',
  };
  const before = structuredClone(f.state);
  await assert.rejects(
    f.guest.recordPrivacyValidation(f.proof()),
    /Privacy proof/,
  );
  f.state.management.privacyValidation = f.proof();
  await assert.rejects(f.guest.requireProtectedInput(), /Privacy proof/);
  assert.deepEqual(f.state.management.canary, before.management.canary);
  assert.equal(f.requests.length, 1);
});
