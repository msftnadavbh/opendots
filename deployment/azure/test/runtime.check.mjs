import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  chmod,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  makeRuntimeEnv,
  encodeRuntimeEnv,
  parseEnv,
  readPrivate,
  writePrivate,
  validateRuntimeEnv,
} from '../runtime-env.mjs';
import { configureVm } from '../vm.mjs';
import { supervise } from '../start.mjs';
import {
  consistentBackup,
  manifest,
  verifyRestore,
} from '../sqlite-backup.mjs';
import { stageBuild } from '../build-context.mjs';
import { origin, output, state } from './fixtures.mjs';

const source = {
  CPK_INTELLIGENCE_API_KEY: 'fixture-project-key',
  OWNER_ID: 'stable-owner',
  OWNER_TOKEN: 'x'.repeat(43),
  NODE_OPTIONS: '--require=untrusted',
  COMPOSIO_API_KEY: 'not-in-pilot',
};
const env = () => makeRuntimeEnv(source, undefined, output, origin);
async function temporary(t) {
  await mkdir('/tmp/opencode', { recursive: true });
  const path = await mkdtemp('/tmp/opencode/opendots-pilot-test-');
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test('runtime config is allowlisted, safely serialized and keeps owner/project identity stable', () => {
  const initial = env();
  const encoded = encodeRuntimeEnv(initial);
  assert.deepEqual(parseEnv(encoded.toString()), initial);
  assert.equal(initial.DO_NOT_TRACK, '1');
  assert.equal(initial.COPILOTKIT_TELEMETRY_DISABLED, '1');
  assert.equal(initial.OPENAI_AUTH_MODE, 'managed-identity');
  assert.equal(Object.hasOwn(initial, 'OPENAI_API_KEY'), false);
  assert(!encoded.includes('NODE_OPTIONS'));
  assert(!encoded.includes('not-in-pilot'));
  const next = makeRuntimeEnv(source, initial, output, origin);
  assert.equal(next.OWNER_ID, initial.OWNER_ID);
  assert.equal(next.OWNER_TOKEN, initial.OWNER_TOKEN);
  for (const patch of [
    { OWNER_ID: 'different' },
    { OWNER_TOKEN: 'y'.repeat(43) },
    { CPK_INTELLIGENCE_API_KEY: 'different' },
  ])
    assert.throws(() =>
      makeRuntimeEnv({ ...source, ...patch }, initial, output, origin),
    );
  assert.throws(() => validateRuntimeEnv({ ...initial, NODE_OPTIONS: 'bad' }));
  assert.throws(() =>
    validateRuntimeEnv({ ...initial, OPENAI_API_KEY: 'forbidden' }),
  );
  assert.throws(() =>
    validateRuntimeEnv({ ...initial, OPENAI_AUTH_MODE: 'api-key' }),
  );
  assert.throws(() =>
    makeRuntimeEnv(
      source,
      undefined,
      { ...output, modelAuthMode: 'api-key' },
      origin,
    ),
  );
  assert.throws(() =>
    makeRuntimeEnv(
      source,
      undefined,
      output,
      origin.replace('.abcdef.', '.other.'),
    ),
  );
  assert.throws(() =>
    makeRuntimeEnv(
      { ...source, CPK_INTELLIGENCE_API_KEY: "x'\nOWNER_TOKEN=bad" },
      undefined,
      output,
      origin,
    ),
  );
  const generated = makeRuntimeEnv(
    { ...source, OWNER_TOKEN: '' },
    undefined,
    output,
    origin,
  );
  assert.match(generated.OWNER_TOKEN, /^[A-Za-z0-9_-]{43}$/);
});
test('private config writes are atomic and reject symlinks and permissive modes', async (t) => {
  const path = await temporary(t),
    file = join(path, '.env.pilot');
  await writePrivate(file, encodeRuntimeEnv(env()));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(parseEnv(await readPrivate(file)).OWNER_ID, 'stable-owner');
  await symlink(file, join(path, 'link'));
  await assert.rejects(readPrivate(join(path, 'link')));
  await chmod(file, 0o644);
  await assert.rejects(readPrivate(file), /owner-only/);
});
test('VM configuration uses private stdin, never model-key reads or secret command arguments', async (t) => {
  const path = await temporary(t),
    input = join(path, '.env'),
    local = join(path, '.env.pilot');
  await writePrivate(
    input,
    `CPK_INTELLIGENCE_API_KEY=${source.CPK_INTELLIGENCE_API_KEY}\nOWNER_ID=${source.OWNER_ID}\nOWNER_TOKEN=${source.OWNER_TOKEN}\n`,
  );
  const commands = [],
    uploads = [];
  let saved;
  const ssh = {
    run: async (command, options) => {
      commands.push(command);
      uploads.push(options.input);
    },
  };
  const current = structuredClone(state);
  await configureVm({
    ssh,
    output,
    state: current,
    sourcePath: input,
    privatePath: local,
    save: async (value) => {
      saved = value;
    },
  });
  assert(uploads[0] instanceof Uint8Array);
  assert.deepEqual(parseEnv(uploads[0].toString()), env());
  assert.equal((await stat(local)).mode & 0o777, 0o600);
  assert.equal(commands.length, 1);
  assert(commands[0].includes('vm-host.sh configure'));
  assert(commands[0].includes('flock -w 30'));
  assert.equal(saved.configured, true);
  for (const secret of [source.CPK_INTELLIGENCE_API_KEY, source.OWNER_TOKEN]) {
    assert(!JSON.stringify(commands).includes(secret));
    assert(!JSON.stringify(saved).includes(secret));
  }
  await rm(local);
  await assert.rejects(
    configureVm({
      ssh,
      output,
      state: current,
      sourcePath: input,
      privatePath: local,
      save: async () => {},
    }),
    /configuration is missing/,
  );
});
test('startup waits for secure config, supervises exits, and forwards graceful shutdown', async () => {
  const controller = new AbortController(),
    children = [],
    pauses = [];
  let step = 0;
  const child = () => {
    const instance = new EventEmitter();
    instance.exitCode = null;
    instance.signalCode = null;
    instance.kill = (signal) => {
      instance.signalCode = signal;
      instance.emit('exit', 0);
      return true;
    };
    children.push(instance);
    return instance;
  };
  await supervise({
    signal: controller.signal,
    readConfiguration: async () => {
      step++;
      if (step === 1) throw new Error('secret invalid configuration');
      if (step === 3) {
        children[0].exitCode = 1;
        children[0].emit('exit', 1);
      }
      return { env: env(), revision: 'one' };
    },
    launch: (config) => {
      assert.equal(config.HOST, '0.0.0.0');
      return child();
    },
    pause: async (ms) => {
      pauses.push(ms);
      if (step === 3) controller.abort();
    },
  });
  assert.equal(children.length, 2);
  assert(pauses.every((ms) => ms >= 3000));
  assert.equal(children[1].signalCode, 'SIGTERM');
});
test('consistent backup contains WAL writes and photos; restore comparison never touches active DB', async (t) => {
  const path = await temporary(t),
    active = join(path, 'active.sqlite'),
    snapshot = join(path, 'backup.sqlite');
  const db = new DatabaseSync(active);
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE dot_photos(dotId TEXT PRIMARY KEY, photo BLOB);',
    );
    db.prepare('INSERT INTO records VALUES (?, ?)').run(1, 'private-content');
    db.prepare('INSERT INTO dot_photos VALUES (?, ?)').run(
      'dot-1',
      Buffer.from([0, 1, 2, 255]),
    );
    const report = await consistentBackup(active, snapshot);
    db.prepare('INSERT INTO records VALUES (?, ?)').run(2, 'new-live-write');
    const restored = await verifyRestore(snapshot, join(path, 'verification'));
    assert.equal(report.tables.dot_photos.records, 1);
    assert.deepEqual(restored.tables, report.tables);
    assert.equal(manifest(active).tables.records.records, 2);
    assert.equal(manifest(snapshot).tables.records.records, 1);
    assert(!JSON.stringify(report).includes('private-content'));
    await assert.rejects(consistentBackup(active, snapshot));
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
  } finally {
    db.close();
  }
});
test('build staging excludes private env, metadata, operator dependencies and test artifacts', async (t) => {
  const directory = await temporary(t),
    root = join(directory, 'source'),
    target = join(directory, 'context');
  for (const name of [
    'src',
    'public',
    'deployment/azure',
    '.azure',
    '.copilotkit',
    'artifacts',
  ])
    await mkdir(join(root, name), { recursive: true });
  for (const name of [
    'Dockerfile',
    '.dockerignore',
    'package.json',
    'package-lock.json',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'tsconfig.server.json',
    ...[
      'scope',
      'runtime-env',
      'start',
      'sqlite-backup',
      'vm-files',
      'export-backup',
    ].map((part) => `deployment/azure/${part}.mjs`),
    'deployment/azure/export-guardian.sh',
  ])
    await writeFile(join(root, name), 'public source');
  for (const name of [
    '.env',
    '.env.pilot',
    '.copilotkit/project.json',
    '.azure/state.json',
    'artifacts/photo.jpg',
    'src/.env.private',
  ])
    await writeFile(join(root, name), 'PRIVATE-CANARY');
  await stageBuild(root, target);
  assert.equal(
    await readFile(join(target, 'Dockerfile'), 'utf8'),
    'public source',
  );
  for (const name of [
    '.env',
    '.env.pilot',
    '.copilotkit',
    '.azure',
    'artifacts',
    'src/.env.private',
    'deployment/azure/node_modules',
  ])
    await assert.rejects(stat(join(target, name)), { code: 'ENOENT' });
});
