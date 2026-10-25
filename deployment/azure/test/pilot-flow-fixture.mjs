import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cloud from '../cloud.mjs';
import * as initial from '../initial-activation.mjs';
import * as vm from '../vm.mjs';
import { managedTransport } from '../run-command.mjs';
import { existingPilotSave } from '../existing-pilot.mjs';
import { VM } from '../scope.mjs';
import { image, output, parameters, vmResources } from './fixtures.mjs';
import { existingFixture } from './existing-fixture.mjs';
import { managedFixture } from './managed-fixture.mjs';

const pilotUrl = new URL('../pilot.mjs', import.meta.url);
const source = await readFile(pilotUrl, 'utf8');
const artifacts = fileURLToPath(
  new URL('../../artifacts/azure-pilot/', pilotUrl),
);
const statePath = join(artifacts, 'vm-state.json');
const outputsPath = join(artifacts, 'arm-outputs.json');
const parametersPath = join(artifacts, 'vm-parameters.json');
const { oldUnit, newUnit, ...target } = initial.initialActivationTarget(image);

async function invoke(
  command,
  {
    profile = 'strict',
    record = 'absent',
    marker = 'provisioned',
    fault,
    power,
  } = {},
) {
  const f = existingFixture();
  if (profile === 'existing') await f.reconcile();
  else {
    Object.assign(f.resources, vmResources());
    delete f.resources.governance;
    f.state.image = image.replace(/a$/, 'b');
    f.state[marker] = true;
  }
  if (record === 'benign' || record === 'extra-receipt') {
    await assert.rejects(
      initial.recoverInitialActivation({
        az: {
          read: () =>
            assert.fail('Producer must reject before Azure/guest work'),
        },
        ssh: { run: () => assert.fail('No guest intent for benign rejection') },
        output,
        parameters,
        state: f.state,
        save: f.save,
        approval: { ...target, reviewSha256: 'e'.repeat(64) },
      }),
      /permanently ineligible/,
    );
    assert.notEqual(f.state.image, f.state.initialActivationRecovery.newImage);
    if (record === 'extra-receipt')
      f.state.initialActivationRecovery.receipt = false;
  } else if (record === 'null') f.state.initialActivationRecovery = null;
  else if (record === 'false') f.state.initialActivationRecovery = false;
  if (profile === 'original-image') f.state.image = initial.INITIAL_IMAGE;
  if (power) f.power = power;
  if (fault === 'identity')
    f.resources.vm.identity.principalId =
      '99999999-9999-9999-9999-999999999999';
  const m = managedFixture({
    state: f.state,
    afterPut: async (m) => {
      if (fault === 'guest-stop') m.complete(7, 'command-failed');
    },
  });
  if (fault === 'readiness') m.vm.properties.instanceView.vmAgent.statuses = [];
  if (fault === 'unknown-stop') m.putFailure = 'after';
  if (fault === 'pending') {
    if (profile === 'existing')
      m.guest = managedTransport({
        az: m.az,
        state: m.state,
        client: m.client,
        save: existingPilotSave(m.state, m.save),
      });
    m.putFailure = 'after';
    await assert.rejects(m.guest.run('true'));
    f.state = structuredClone(m.state);
    f.resources.command = m.resource;
    f.resources.handler = m.handler;
  }
  let diskState = structuredClone(f.state),
    guarded = 0,
    transports = 0;
  const phases = [],
    writes = [];
  const originalRecovery = structuredClone(diskState.initialActivationRecovery);
  const requestsBefore = m.requests.length;
  f.calls.length = 0;
  const az = {
    verify: (options) => (options ? m.az.verify(options) : f.az.verify()),
    read: (args, options) =>
      args[0] === 'rest' ? m.az.read(args, options) : f.az.read(args),
    write: async (args) => {
      const values = Array.from(args);
      assert.equal(values[0], 'vm');
      assert(['start', 'deallocate'].includes(values[1]));
      assert.deepEqual(values.slice(2), ['--ids', VM.ids.id]);
      if (values[1] === 'deallocate') {
        assert.equal(m.state.management.receipt.exitCode, 0);
        assert(!m.state.management.pending);
      } else f.power = 'PowerState/running';
      writes.push(values);
    },
  };
  const unexpected = () =>
    assert.fail(
      'Unexpected filesystem or app operation in isolated CLI fixture',
    );
  const overrides = {
    'node:fs/promises': {
      mkdir: async () => {},
      open: async () => ({ close: async () => {} }),
      rm: async () => {},
      mkdtemp: unexpected,
      lstat: unexpected,
      realpath: unexpected,
    },
    './runtime-env.mjs': {
      readPrivate: async (path) => {
        if (path === statePath) return JSON.stringify(diskState);
        if (path === outputsPath) return JSON.stringify(output);
        assert.equal(
          path,
          parametersPath,
          'No actual artifact/configuration read is allowed',
        );
        return JSON.stringify({
          parameters: {
            sshPublicKey: { value: parameters.sshPublicKey },
            operatorIpv4Cidr: { value: parameters.operatorIpv4Cidr },
          },
        });
      },
      writePrivate: async (path, contents) => {
        assert([statePath, outputsPath].includes(path));
        if (path === statePath) diskState = JSON.parse(contents);
      },
    },
    './cloud.mjs': { ...cloud, createAz: () => az },
    './initial-activation.mjs': {
      ...initial,
      assertNormalActivation: (state, outputs) => {
        guarded++;
        assert(
          f.calls.some(
            (args) => Array.isArray(args) && args.includes(VM.ids.dataDiskId),
          ),
          'Fresh disk verification must precede the guard',
        );
        assert(
          f.calls.some(
            (args) => Array.isArray(args) && args[1] === 'get-instance-view',
          ),
          'Fresh VM verification must precede the guard',
        );
        return initial.assertNormalActivation(state, outputs);
      },
    },
    './vm.mjs': {
      ...vm,
      provisionVm: async () => phases.push('provision'),
      configureVm: async () => phases.push('configure'),
    },
    './run-command.mjs': {
      managedTransport: (options) => {
        transports++;
        m.state = options.state;
        return managedTransport({ ...options, client: m.client });
      },
    },
  };
  const context = createContext({
    URL,
    JSON,
    Buffer,
    AbortController,
    AbortSignal,
    process: {
      argv: [],
      umask: () => {},
      on: () => {},
      removeListener: () => {},
    },
    console: { log: () => {}, error: unexpected },
  });
  const module = new SourceTextModule(source, {
    context,
    identifier: pilotUrl.href,
    initializeImportMeta: (meta) => {
      meta.url = pilotUrl.href;
    },
  });
  await module.link(async (specifier) => {
    const values =
      overrides[specifier] ??
      (await import(
        specifier.startsWith('node:')
          ? specifier
          : new URL(specifier, pilotUrl).href
      ));
    return new SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values))
          this.setExport(name, value);
      },
      { context },
    );
  });
  await module.evaluate();
  const args =
    command === 'provision'
      ? [command, outputsPath, diskState.image]
      : [command];
  let error;
  try {
    await module.namespace.main(args);
  } catch (value) {
    error = value;
  }
  assert.deepEqual(
    diskState.initialActivationRecovery,
    originalRecovery,
    'Normal operations must preserve recovery evidence',
  );
  return {
    error,
    guarded,
    phases,
    writes,
    transports,
    requests: m.requests.length - requestsBefore,
  };
}

let cases = 0;
for (const command of ['provision', 'configure', 'restart', 'resume']) {
  for (const marker of ['provisioned', 'configured']) {
    const f = await invoke(command, {
      record: 'benign',
      marker,
      ...(command === 'resume' ? { power: 'PowerState/deallocated' } : {}),
    });
    assert.ifError(f.error);
    assert.equal(f.guarded, 1);
    if (['provision', 'configure'].includes(command))
      assert.deepEqual(f.phases, [command]);
    else assert.equal(f.requests, 1);
    if (command === 'resume') assert.equal(f.writes[0][1], 'start');
    cases++;
  }
  for (const options of [
    { record: 'null' },
    { record: 'false' },
    { record: 'extra-receipt' },
    { profile: 'existing' },
    { profile: 'original-image' },
    { record: 'benign', fault: 'identity' },
  ]) {
    const f = await invoke(command, options);
    assert(f.error);
    assert.deepEqual(f.phases, []);
    assert.deepEqual(f.writes, []);
    assert.equal(f.requests, 0);
    assert.equal(f.guarded, options.fault === 'identity' ? 0 : 1);
    cases++;
  }
  const absent = await invoke(command);
  assert.ifError(absent.error);
  assert.equal(absent.guarded, 1);
  cases++;
}
for (const profile of ['strict', 'existing']) {
  for (const fault of ['readiness', 'guest-stop', 'unknown-stop', 'pending']) {
    const f = await invoke('stop', { profile, fault });
    assert(f.error);
    assert.match(
      f.error.message,
      {
        readiness: /guest-agent/,
        'guest-stop': /exit 7/,
        'unknown-stop': /interrupted/,
        pending: /pending/,
      }[fault],
    );
    assert.equal(f.transports, 1);
    assert.deepEqual(f.writes, []);
    assert.equal(f.requests, ['readiness', 'pending'].includes(fault) ? 0 : 1);
    cases++;
  }
  for (const power of ['PowerState/stopped', 'PowerState/deallocated']) {
    const f = await invoke('stop', { profile, power, fault: 'readiness' });
    assert.ifError(f.error);
    assert.equal(f.transports, 0);
    assert.equal(f.requests, 0);
    assert.deepEqual(f.writes, []);
    cases++;
  }
  const success = await invoke('stop', { profile });
  assert.ifError(success.error);
  assert.equal(success.requests, 1);
  assert.deepEqual(success.writes, [['vm', 'deallocate', '--ids', VM.ids.id]]);
  cases++;
}
console.log(JSON.stringify({ cases }));
