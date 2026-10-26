import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSPORT_SHA256 } from '../run-command.mjs';
import { VM } from '../scope.mjs';
import { managedFixture, handlerResource } from './managed-fixture.mjs';

function explicit(f) {
  f.handler = handlerResource();
  f.extensions.value = [structuredClone(f.handler)];
  f.vm.properties.instanceView.extensions = [
    {
      name: 'RunCommandHandlerLinux',
      type: 'Microsoft.CPlat.Core.RunCommandHandlerLinux',
      ...structuredClone(f.handler.properties.instanceView),
    },
  ];
}

const bad = {
  'missing VM': (f) => {
    f.vm = undefined;
  },
  'replaced VM': (f) => {
    f.vm.properties.vmId = 'foreign';
  },
  'replaced principal': (f) => {
    f.vm.identity.principalId = 'foreign';
  },
  'wrong tenant': (f) => {
    f.vm.identity.tenantId = 'foreign';
  },
  'user-assigned identity': (f) => {
    f.vm.identity.userAssignedIdentities = { foreign: {} };
  },
  'missing ownership': (f) => {
    f.vm.tags = {};
  },
  'disabled agent': (f) => {
    f.vm.properties.osProfile.linuxConfiguration.provisionVMAgent = false;
  },
  'VM provisioning failed': (f) => {
    f.vm.properties.provisioningState = 'Failed';
  },
  'VM provisioning updating': (f) => {
    f.vm.properties.provisioningState = 'Updating';
  },
  'missing instance view': (f) => {
    delete f.vm.properties.instanceView;
  },
  'missing power': (f) => {
    f.vm.properties.instanceView.statuses.pop();
  },
  'stopped VM': (f) => {
    f.vm.properties.instanceView.statuses[1].code = 'PowerState/deallocated';
  },
  'conflicting power states': (f) => {
    f.vm.properties.instanceView.statuses.push({ code: 'PowerState/stopped' });
  },
  'unknown provisioning view': (f) => {
    f.vm.properties.instanceView.statuses[0].code = 'ProvisioningState/unknown';
  },
  'missing agent': (f) => {
    delete f.vm.properties.instanceView.vmAgent;
  },
  'agent not Ready': (f) => {
    f.vm.properties.instanceView.vmAgent.statuses[0].displayStatus =
      'Not Ready';
  },
  'agent error': (f) => {
    f.vm.properties.instanceView.vmAgent.statuses[0].code =
      'ProvisioningState/failed';
  },
  'agent error level': (f) => {
    f.vm.properties.instanceView.vmAgent.statuses[0].level = 'Error';
  },
  'unknown agent statuses': (f) => {
    f.vm.properties.instanceView.vmAgent.statuses = [];
  },
  'unknown version': (f) => {
    delete f.vm.properties.instanceView.vmAgent.vmAgentVersion;
  },
  'malformed version': (f) => {
    f.vm.properties.instanceView.vmAgent.vmAgentVersion = '2.16.0.2-unknown';
  },
  'ambiguous version': (f) => {
    f.vm.properties.instanceView.vmAgent.vmAgentVersion = '2.016.0.2';
  },
  'below documented minimum': (f) => {
    f.vm.properties.instanceView.vmAgent.vmAgentVersion = '2.4.0.1';
  },
  'older minor version': (f) => {
    f.vm.properties.instanceView.vmAgent.vmAgentVersion = '2.3.99.99';
  },
  'missing extension response': (f) => {
    f.extensions = undefined;
  },
  'unknown extension collection': (f) => {
    f.extensions = {};
  },
  'nonarray extension collection': (f) => {
    f.extensions = { value: {} };
  },
  'partial extension inventory': (f) => {
    f.extensions.nextLink = 'https://management.azure.com/next';
  },
  'duplicate extensions': (f) => {
    explicit(f);
    f.extensions.value.push(f.handler);
  },
  'foreign extension': (f) => {
    f.extensions.value.push({
      ...handlerResource(),
      id: handlerResource().id + '-foreign',
    });
  },
  'missing previously tracked handler': (f) => {
    f.vm.properties.instanceView.vmAgent.extensionHandlers = [];
  },
  'wrong handler publisher': (f) => {
    explicit(f);
    f.handler.properties.publisher = 'foreign';
  },
  'unknown handler configured version': (f) => {
    explicit(f);
    f.handler.properties.typeHandlerVersion = '';
  },
  'unknown handler runtime version': (f) => {
    explicit(f);
    f.handler.properties.instanceView.typeHandlerVersion = '';
  },
  'missing handler instance view': (f) => {
    explicit(f);
    delete f.handler.properties.instanceView;
  },
  'conflicting handler instance view': (f) => {
    explicit(f);
    f.handler.properties.instanceView.statuses.push({
      code: 'ProvisioningState/failed',
    });
  },
  'handler error level': (f) => {
    explicit(f);
    f.handler.properties.instanceView.statuses[0].level = 'Error';
  },
};
for (const state of [
  'Creating',
  'Updating',
  'Deleting',
  'Failed',
  'Unknown',
  undefined,
])
  bad[`extension state ${state}`] = (f) => {
    explicit(f);
    f.handler.properties.provisioningState = state;
  };

for (const [name, mutate] of Object.entries(bad))
  test(`fresh readiness rejects ${name} before PUT/intent or durable canary invalidation`, async () => {
    const f = managedFixture();
    await f.approveFixture();
    const before = structuredClone(f.state),
      saved = f.saved.length,
      requests = f.requests.length;
    mutate(f);
    await assert.rejects(f.guest.canary());
    assert.equal(f.requests.length, requests);
    assert.equal(f.saved.length, saved);
    assert.deepEqual(f.state, before);
    assert.deepEqual(f.durable, before);
    assert(!f.state.management.pending);
  });

test('first use requires complete explicit inventory and a consistent GET, not an absent response or untracked ARM handler', async () => {
  const f = managedFixture();
  await f.guest.canary();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.calls.slice(0, 5), [
    'GET',
    'readiness',
    'handler',
    'save-intent',
    'PUT',
  ]);
  for (const inventory of [
    undefined,
    {},
    { value: null },
    { value: [handlerResource()] },
    { value: [], nextLink: 'unknown' },
  ]) {
    const g = managedFixture();
    g.extensions = inventory;
    const before = structuredClone(g.state);
    await assert.rejects(g.guest.canary());
    assert.equal(g.requests.length, 0);
    assert.equal(g.saved.length, 0);
    assert.deepEqual(g.state, before);
  }
});

for (const healthy of [true, false])
  test(`bounded historical action extension is ${healthy ? 'permitted only when ready' : 'not ignored when its runtime view is unhealthy'}`, async () => {
    const f = managedFixture(),
      action = handlerResource();
    action.id = `${VM.ids.id}/extensions/RunCommandLinux`;
    action.properties.type = 'RunCommandLinux';
    action.properties.typeHandlerVersion = '1.0';
    action.properties.instanceView.typeHandlerVersion = '1.0.12';
    f.extensions.value.push(action);
    f.vm.properties.instanceView.extensions.push({
      name: 'RunCommandLinux',
      type: 'Microsoft.CPlat.Core.RunCommandLinux',
      ...structuredClone(action.properties.instanceView),
    });
    const read = f.az.read;
    f.az.read = async (args, options) => {
      if (
        args[4] ===
        `https://management.azure.com${action.id}?api-version=2025-11-01&$expand=instanceView`
      ) {
        const observed = structuredClone(action);
        if (!healthy)
          observed.properties.instanceView.statuses[0].code =
            'ProvisioningState/updating';
        return observed;
      }
      return read(args, options);
    };
    if (healthy) {
      await f.guest.canary();
      assert.equal(f.requests.length, 1);
    } else {
      await assert.rejects(f.guest.canary(), /runtime\/readiness/);
      assert.equal(f.requests.length, 0);
      assert.equal(f.saved.length, 0);
    }
  });

for (const version of ['2.4.0.2', '2.4.0.10', '2.10.0.0', '2.16.0.2'])
  test(`documented minimum is compared numerically: Ready agent ${version} submits`, async () => {
    const f = managedFixture();
    f.vm.properties.instanceView.vmAgent.vmAgentVersion = version;
    await f.guest.run('true');
    assert.equal(f.requests.length, 1);
  });

for (const boundary of ['authority', 'VM read', 'inventory read', 'deadline'])
  test(`readiness ${boundary} failure is not absence, nondispatch restoration or permission to invalidate proof`, async () => {
    const f = managedFixture();
    await f.approveFixture();
    const before = structuredClone(f.state),
      saved = f.saved.length;
    if (boundary === 'authority')
      f.az.verify = async () => {
        throw new Error('fixture authority failure');
      };
    else {
      const read = f.az.read;
      f.az.read = async (args, options) => {
        assert(options.signal instanceof AbortSignal);
        assert.equal(options.timeoutMs, 30_000);
        if (
          boundary === 'VM read' ||
          (boundary === 'inventory read' && args[4].includes('/extensions?'))
        )
          throw new Error('fixture read unavailable');
        const value = await read(args, options);
        if (boundary === 'deadline') f.controller.abort();
        return value;
      };
    }
    await assert.rejects(f.guest.canary());
    assert.equal(f.requests.length, 1);
    assert.equal(f.saved.length, saved);
    assert.deepEqual(f.state, before);
  });

test('every submission rechecks readiness, including protected commands after a genuine fixture canary', async () => {
  const f = managedFixture();
  await f.approveFixture();
  await f.guest.run('true', { input: 'FAKE-INPUT' });
  const before = structuredClone(f.state),
    saved = f.saved.length;
  f.vm.properties.instanceView.vmAgent.statuses[0].displayStatus = 'Not Ready';
  await assert.rejects(
    f.guest.run('true', { input: 'FAKE-INPUT' }),
    /guest-agent/,
  );
  assert.equal(f.requests.length, 2);
  assert.equal(f.saved.length, saved);
  assert.deepEqual(f.state, before);
});

test('GET-only pending reconciliation ignores unhealthy/missing readiness surfaces and retains historical transport hashes', async () => {
  const f = managedFixture();
  f.putFailure = 'after';
  await assert.rejects(f.guest.run('true'));
  const historical = 'a'.repeat(64);
  assert.notEqual(historical, TRANSPORT_SHA256);
  f.state.management.pending.transportSha256 = historical;
  f.resource.tags.transportSha256 = historical;
  const pending = structuredClone(f.state.management.pending);
  f.vm = undefined;
  f.extensions = undefined;
  f.az.verify = f.az.read = () =>
    assert.fail('Reconciliation must never call submission readiness');
  const completed = await f.guest.reconcile();
  assert.equal(completed.operationId, pending.operationId);
  assert.equal(completed.transportSha256, historical);
  for (const [key, value] of Object.entries(pending))
    assert.deepEqual(completed[key], value);
  assert.equal(f.requests.length, 1);
  assert(!f.state.management.pending);
});

test('old transport canary/privacy hashes cannot approve protected input after the readiness implementation changes', async () => {
  const f = managedFixture();
  await f.approveFixture();
  f.state.management.canary.transportSha256 = 'b'.repeat(64);
  f.state.management.privacyValidation.transportSha256 = 'b'.repeat(64);
  const before = structuredClone(f.state),
    saved = f.saved.length;
  await assert.rejects(f.guest.requireProtectedInput(), /Privacy proof/);
  await assert.rejects(
    f.guest.run('true', { input: 'FAKE-INPUT' }),
    /Privacy proof/,
  );
  assert.deepEqual(f.state, before);
  assert.equal(f.saved.length, saved);
  assert.equal(f.requests.length, 1);
});
