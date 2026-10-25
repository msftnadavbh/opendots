import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PULL_ACTIONS, TOKEN_NAME } from '../scope.mjs';
import {
  pullImage,
  provisionVm,
  configureVm,
  vmServiceCommand,
  units,
} from '../vm.mjs';
import { image, output, state } from './fixtures.mjs';
import { managedFixture } from './managed-fixture.mjs';

function fixture({ present = false, failure } = {}) {
  const calls = [],
    saved = [],
    signals = [],
    controller = new AbortController();
  let status = 'disabled';
  const scopeMapId = `${output.registryId}/scopeMaps/${output.scopeMapName}`;
  return {
    calls,
    saved,
    signals,
    controller,
    state: structuredClone(state),
    status: () => status,
    save: async (value) => saved.push(structuredClone(value)),
    az: {
      read: async (args) => {
        calls.push(['az-read', args]);
        if (args[0] === 'rest') return { value: [] };
        return args[1] === 'scope-map'
          ? { id: scopeMapId, actions: PULL_ACTIONS }
          : { status, scopeMapId, credentials: { passwords: [] } };
      },
      write: async (args) => {
        calls.push(['az-write', args]);
        if (args.includes('generate'))
          return {
            username: TOKEN_NAME,
            passwords: [
              {
                name: 'password1',
                value: 'private-registry-password',
                expiry: args[args.indexOf('--expiration') + 1],
              },
            ],
          };
        if (args.includes('--status')) status = args.at(-1);
        return { status };
      },
    },
    ssh: {
      signal: controller.signal,
      run: async (command, options = {}) => {
        calls.push(['ssh', command]);
        signals.push({ command, signal: options.signal ?? controller.signal });
        if (command.includes('image-present')) return String(present);
        if (command.includes(' pull ')) {
          assert.equal(options.input.toString(), 'private-registry-password\n');
          if (failure === 'pull') throw new Error('remote failure');
          if (failure === 'abort' || failure === 'abort-cleanup') {
            controller.abort();
            controller.signal.throwIfAborted();
          }
        }
        if (
          command.includes('cleanup-pull') &&
          ['cleanup', 'abort-cleanup'].includes(failure)
        )
          throw new Error('cleanup failure');
        return '';
      },
    },
  };
}

test('a digest already on the VM requires no registry credential or cloud write', async () => {
  const f = fixture({ present: true });
  await pullImage({ ...f, output, image });
  assert.equal(f.calls.length, 1);
  assert(f.calls[0][1].includes('image-present'));
  assert.equal(f.status(), 'disabled');
});
for (const failure of [undefined, 'pull', 'cleanup'])
  test(`VM pull keeps password on stdin and revokes it after ${failure ?? 'success'}`, async () => {
    const f = fixture({ failure });
    if (failure) await assert.rejects(pullImage({ ...f, output, image }));
    else await pullImage({ ...f, output, image });
    assert.equal(f.status(), 'disabled');
    assert(
      f.calls.some(
        ([type, command]) => type === 'ssh' && command.includes('cleanup-pull'),
      ),
    );
    assert(
      !JSON.stringify({ calls: f.calls, saved: f.saved }).includes(
        'private-registry-password',
      ),
    );
    assert.equal(!!f.state.pullOperationId, failure === 'cleanup');
  });
for (const failure of ['abort', 'abort-cleanup'])
  test(`normal SSH abort still cleans up with a fresh signal and disables ACR (${failure})`, async () => {
    const f = fixture({ failure });
    await assert.rejects(pullImage({ ...f, output, image }));
    assert(f.controller.signal.aborted);
    const cleanup = f.signals.find(({ command }) =>
      command.includes('cleanup-pull'),
    );
    assert(cleanup);
    assert.notEqual(cleanup.signal, f.controller.signal);
    assert.equal(cleanup.signal.aborted, false);
    assert.equal(f.status(), 'disabled');
    assert.equal(!!f.state.pullOperationId, failure === 'abort-cleanup');
    if (failure === 'abort-cleanup')
      assert.equal(f.saved.at(-1).pullOperationId, f.state.pullOperationId);
  });
test('a mismatched image stops provisioning before remote or cloud changes', async () => {
  const f = fixture();
  await assert.rejects(
    provisionVm({ ...f, output, image: image.replace(/a$/, 'b') }),
    /upgrades are manual/,
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.saved, []);
});
test('systemd binds app lifetime to the filesystem and pins the local image; Caddy has no request log', () => {
  const files = units(state, image);
  assert(files.mount.includes(`What=/dev/disk/by-uuid/${state.fsUuid}`));
  assert(files.app.includes('RequiresMountsFor=/srv/opendots'));
  assert(files.app.includes('BindsTo=srv-opendots.mount'));
  assert(files.app.includes('vm-disk.py check'));
  assert(files.app.includes(image));
  assert(files.caddy.includes(`https://${output.vm.fqdn}`));
  assert(files.caddy.includes('reverse_proxy 127.0.0.1:4310'));
  assert(!files.caddy.includes('flush_interval'));
  assert(!JSON.stringify(files).includes('OWNER_TOKEN'));
});

test('actual managed provisioning/configuration budgets include flock wait, root kill grace and transport margins', async (t) => {
  const token = fixture(),
    managed = managedFixture();
  managed.state.provisioned = false;
  managed.state.configured = false;
  await managed.approveFixture();
  await provisionVm({
    az: token.az,
    ssh: managed.guest,
    output,
    image,
    state: managed.state,
    save: managed.save,
  });
  const directory = await mkdtemp('/tmp/opencode/opendots-budget-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.env');
  await writeFile(
    sourcePath,
    `CPK_INTELLIGENCE_API_KEY='FAKE-PROJECT-KEY'\nOWNER_ID='fixture-owner'\nOWNER_TOKEN='${'f'.repeat(43)}'\n`,
    { mode: 0o600 },
  );
  await configureVm({
    ssh: managed.guest,
    output,
    state: managed.state,
    sourcePath,
    privatePath: join(directory, 'runtime.env'),
    save: managed.save,
  });
  await managed.guest.run(vmServiceCommand('restart'));
  const specs = managed.requests.map((body) => ({
    body,
    spec: JSON.parse(
      JSON.parse(
        body.properties.source.script
          .split('\nmain(json.loads(')[1]
          .split('))\n')[0],
      ),
    ),
  }));
  for (const { body, spec } of specs) {
    const root = /timeout --kill-after=10 (\d+) /.exec(spec.command);
    assert(
      root,
      'Every provisioning command is guarded by the root lock/deadline',
    );
    assert(
      spec.seconds >= Number(root[1]) + 30 + 10 + 10,
      'Execution includes lock wait, kill grace and launch margin',
    );
    assert.equal(body.properties.timeoutInSeconds - spec.seconds, 15);
    assert(body.properties.timeoutInSeconds <= 1320);
  }
  for (const operation of [
    'vm-bootstrap.sh',
    'vm-disk.py prepare',
    'vm-host.sh pull ',
    'vm-host.sh configure',
    'vm-host.sh restart',
  ])
    assert(
      specs.some(({ spec }) => spec.command.includes(operation)),
      operation,
    );
  assert.equal(token.status(), 'disabled');
});

for (const mode of ['unknown-put', 'abort-running', 'abort-completed'])
  test(`managed ${mode} reconciles before cleanup and always revokes the import token`, async () => {
    const token = fixture();
    let interrupt = true;
    const managed = managedFixture({
      afterPut: async (f) => {
        if (
          interrupt &&
          f.requests
            .at(-1)
            .properties.source.script.includes('vm-host.sh pull ')
        ) {
          interrupt = false;
          if (mode !== 'abort-completed')
            f.resource.properties.instanceView = { executionState: 'Running' };
          if (mode.startsWith('abort')) f.controller.abort();
          else throw new Error('fake lost PUT response');
        }
      },
      wait: async () => {
        throw new Error('fake reconciliation deadline');
      },
    });
    await managed.approveFixture();
    const call = () =>
      pullImage({
        az: token.az,
        ssh: managed.guest,
        output,
        image,
        state: managed.state,
        save: managed.save,
      });
    await assert.rejects(call());
    assert.equal(token.status(), 'disabled');
    assert.equal(!!managed.state.pullOperationId, mode !== 'abort-completed');
    assert.equal(
      !!managed.state.management.pending,
      mode !== 'abort-completed',
    );
    if (mode !== 'abort-completed') {
      assert(
        !managed.requests.some((r) =>
          r.properties.source.script.includes('vm-host.sh cleanup-pull '),
        ),
        'Unknown remote work cannot be overwritten by cleanup',
      );
      managed.complete();
      await managed.guest.reconcile({ signal: AbortSignal.timeout(1000) });
      // Simulate the next locked CLI session after reconciliation, not resuming an aborted signal.
      const { managedTransport } = await import('../run-command.mjs');
      managed.guest = managedTransport({
        az: managed.az,
        state: managed.state,
        save: managed.save,
        client: managed.client,
      });
      managed.imagePresent = true;
      await call();
      assert(!managed.state.pullOperationId);
    }
    assert.equal(
      token.calls.filter(
        ([kind, args]) => kind === 'az-write' && args.includes('generate'),
      ).length,
      1,
    );
    assert(
      !JSON.stringify(managed.saved).includes('private-registry-password'),
    );
    assert(
      managed.requests.some((r) =>
        r.properties.source.script.includes('vm-host.sh cleanup-pull '),
      ),
    );
  });

test('normal provision uses only managed calls with fixed schemas and retains every existing immutable guest helper', async () => {
  const f = managedFixture();
  f.state.provisioned = false;
  f.imagePresent = true;
  await f.approveFixture();
  await provisionVm({
    az: { read: () => assert.fail('Already present image needs no token') },
    ssh: f.guest,
    output,
    image,
    state: f.state,
    save: f.save,
  });
  assert.equal(f.state.provisioned, true);
  assert.equal(f.state.fsUuid, state.fsUuid);
  assert.equal(f.state.image, image);
  assert(
    f.requests.some((r) =>
      r.properties.source.script.includes('vm-disk.py prepare'),
    ),
  );
  assert(f.saved.some((s) => s.management.receipt?.schema === 'disk'));
  assert(f.requests.every((r) => r.properties.parameters.length === 0));
});
