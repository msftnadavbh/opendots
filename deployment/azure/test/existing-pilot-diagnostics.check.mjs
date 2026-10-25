import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  INITIAL_IMAGE,
  initialActivationTarget,
  inspectInitialGuest,
  inspectCaddy,
} from '../initial-activation.mjs';
import { units } from '../vm.mjs';
import { state, image } from './fixtures.mjs';

const execute = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const rendered = units(state, INITIAL_IMAGE);
const plan = {
  ...initialActivationTarget(image),
  operationId: '99999999-9999-9999-9999-999999999999',
  binding: state.binding,
  fsUuid: state.fsUuid,
  diskOperationId: state.operationId,
  image: INITIAL_IMAGE,
  unitSha256: hash(rendered.app),
  mountSha256: hash(rendered.mount),
  caddySha256: hash(rendered.caddy),
  caddyServiceSha256: hash(rendered.caddyService),
  ...rendered,
};

async function fixture(t, mode, scenario) {
  const directory = await mkdtemp(
    '/tmp/opencode/opendots-existing-diagnostic-',
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  let command;
  await (mode === 'check-initial' ? inspectInitialGuest : inspectCaddy)({
    state: {
      ...state,
      image: INITIAL_IMAGE,
      provisioned: false,
      configured: false,
    },
    ssh: {
      run: async (value, options) => {
        command = value;
        assert.equal(options.schema, 'empty');
      },
    },
  });
  assert(!/def publish\(|def replace_unit\(|def recover\(/.test(command));
  const child = execute(
    'python3',
    [
      '-B',
      new URL('./initial_activation_fixture.py', import.meta.url).pathname,
      directory,
      `${mode}:${scenario}`,
    ],
    { timeout: 8000, maxBuffer: 128 * 1024 },
  );
  child.child.stdin.end(JSON.stringify({ ...plan, command }));
  const result = await child;
  assert.equal(result.stderr, '');
  assert(
    !/FAKE-PRIVATE|FIXTURE-DATA|FIXTURE-PRIVATE-ERROR/.test(result.stdout),
  );
  const value = JSON.parse(result.stdout);
  assert(
    value.unitUnchanged &&
      !value.intent &&
      !value.applied &&
      !value.conflict &&
      !value.ineligible,
  );
  assert.equal(value.unitWrites, 0);
  assert(
    !value.events.some((event) =>
      /write:|sync|publish|daemon-reload/.test(event),
    ),
  );
  return value;
}

test('actual fixed initial probe reuses frozen safety predicates without recovery journal, file writes or service effects', async (t) => {
  const value = await fixture(t, 'check-initial', 'pristine');
  assert.equal(value.status, 'passed');
  assert(
    value.events.includes(
      'command:/usr/bin/python3 /usr/local/lib/opendots/vm-disk.py check',
    ),
  );
  assert(value.events.includes('command:/usr/bin/docker image ls'));
  assert(value.events.includes('command:/usr/bin/docker container ls'));
  assert(
    value.events.includes('command:/usr/bin/systemctl show opendots.service'),
  );
});

for (const scenario of [
  'wrong-uuid',
  'wrong-vm',
  'wrong-disk',
  'wrong-disk-id',
  'wrong-format-op',
  'disk-error',
  'container',
  'stopped-container',
  'image',
  'runtime',
  'database',
  'other-data',
  'lost-data',
  'container-error',
  'image-error',
  'active',
  'enabled',
  'job',
  'activation-job',
  'prior-activation',
  'invocation',
  'service-error',
  'job-error',
  'helper-drift',
  'unit-mode',
  'unit-owner',
  'unit-bytes',
  'unit-symlink',
  'unit-hardlink',
  'data-symlink',
  'lost-symlink',
  'parent-writable',
  'drop-ins',
  'effective-exec',
  'reload-needed',
  'mount-missing',
  'mount-drift',
  'pending-pull',
])
  test(`actual initial read-only diagnostic rejects ${scenario} without reading runtime/database contents or creating eligibility`, async (t) => {
    assert.equal(
      (await fixture(t, 'check-initial', scenario)).status,
      'rejected',
    );
  });

test('actual Caddy predicate checks bytes/modes, service-user readability and service condition without validate/reload/start', async (t) => {
  const value = await fixture(t, 'check-caddy', 'pristine');
  assert.equal(value.status, 'passed');
  assert.deepEqual(value.events, [
    'command:/usr/bin/sudo -n -u',
    'command:/usr/bin/systemctl show caddy.service',
  ]);
});

for (const scenario of [
  'caddy-mode',
  'caddy-bytes',
  'caddy-dropin-bytes',
  'caddy-unreadable',
  'caddy-failed',
  'caddy-inactive',
  'caddy-user',
  'caddy-extra-dropin',
  'caddy-job',
  'caddy-reload',
  'caddy-show-error',
])
  test(`actual Caddy read-only diagnostic rejects ${scenario}, never repairs it or exposes contents`, async (t) => {
    assert.equal(
      (await fixture(t, 'check-caddy', scenario)).status,
      'rejected',
    );
  });
