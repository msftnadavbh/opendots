import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  publicKey,
  parseHostKey,
  pinHostKey,
  knownHosts,
  prepareOperator,
  verifyKeyPair,
  sshArgs,
  sshTransport,
  rootCommand,
  installFile,
} from '../ssh.mjs';
import { writePrivate } from '../runtime-env.mjs';
import { units } from '../vm.mjs';
import { image, sshPublicKey, state } from './fixtures.mjs';

const execute = promisify(execFile);
const response = (key = sshPublicKey) => ({
  value: [
    {
      code: 'ProvisioningState/succeeded',
      message: `[stdout]\n${key}\n[stderr]\n`,
    },
  ],
});
function otherKey() {
  const fields = sshPublicKey.split(' '),
    bytes = Buffer.from(fields[1], 'base64');
  bytes[50] ^= 1;
  return `${fields[0]} ${bytes.toString('base64')}`;
}
async function temporary(t) {
  await mkdir('/tmp/opencode', { recursive: true });
  const directory = await mkdtemp('/tmp/opencode/opendots-ssh-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function operator(t) {
  const directory = await temporary(t),
    calls = [];
  const run = async (file, args, options) => {
    assert.equal(file, 'ssh-keygen');
    assert.equal(options.timeout, 30_000);
    calls.push(args);
    if (args[0] === '-q') {
      const path = args[args.indexOf('-f') + 1];
      await writeFile(path, 'FAKE-PRIVATE-KEY-FIXTURE-NOT-A-CREDENTIAL', {
        mode: 0o600,
        flag: 'wx',
      });
      await writeFile(path + '.pub', sshPublicKey, { mode: 0o600, flag: 'wx' });
      return { stdout: '' };
    }
    assert.deepEqual(args, [
      '-y',
      '-P',
      '',
      '-f',
      join(directory, 'id_ed25519'),
    ]);
    return { stdout: sshPublicKey + '\n' };
  };
  await prepareOperator(directory, '8.8.8.8/32', run);
  await writePrivate(join(directory, 'known_hosts'), knownHosts(state));
  return { directory, run, calls };
}
async function transport(t, script, { signal } = {}) {
  const f = await operator(t),
    launches = [],
    children = [];
  t.after(() => {
    for (const child of children)
      if (child.exitCode === null) child.kill('SIGKILL');
  });
  const launch = (file, args, options) => {
    assert.equal(file, 'ssh');
    launches.push({ file, args, options });
    const child = spawn(process.execPath, ['-e', script], options);
    children.push(child);
    return child;
  };
  return {
    ...f,
    launches,
    children,
    ssh: await sshTransport(state, f.directory, { launch, run: f.run, signal }),
  };
}

test('publicKey accepts only one canonical, strictly encoded Ed25519 binary key', () => {
  assert.equal(publicKey(sshPublicKey + ' fixture-comment'), sshPublicKey);
  const bytes = Buffer.from(sshPublicKey.split(' ')[1], 'base64');
  const malformed = [];
  for (const [offset, value] of [
    [0, 10],
    [15, 31],
  ]) {
    const changed = Buffer.from(bytes);
    changed.writeUInt32BE(value, offset);
    malformed.push(`ssh-ed25519 ${changed.toString('base64')}`);
  }
  const wrongName = Buffer.from(bytes);
  wrongName[4] = 0;
  malformed.push(`ssh-ed25519 ${wrongName.toString('base64')}`);
  for (const key of [
    undefined,
    '',
    'ssh-rsa AAAA',
    `ssh-ed25519 ${bytes.subarray(1).toString('base64')}`,
    sshPublicKey + '=',
    sshPublicKey + '\n' + sshPublicKey,
    sshPublicKey + '\rsecond-key',
    ...malformed,
  ])
    assert.throws(() => publicKey(key));
});

test('RunCommand must report exactly one succeeded key with no stderr or extra stdout', () => {
  assert.equal(parseHostKey(response()), sshPublicKey);
  for (const document of [
    {},
    { value: [] },
    { value: [...response().value, ...response().value] },
    { value: [{ ...response().value[0], code: 'ProvisioningState/failed' }] },
    { value: [{ ...response().value[0], message: sshPublicKey }] },
    {
      value: [
        {
          ...response().value[0],
          message: `[stdout]\n${sshPublicKey}\n[stderr]warning`,
        },
      ],
    },
    response(sshPublicKey + '\nextra-output'),
  ])
    assert.throws(() => parseHostKey(document));
});

test('operator fixture exercises key generation/derivation guards without needing ssh-keygen installed', async (t) => {
  const f = await operator(t);
  assert.equal(await verifyKeyPair(f.directory, f.run), sshPublicKey);
  assert.equal(f.calls.filter((args) => args[0] === '-q').length, 1);
  await prepareOperator(f.directory, '8.8.8.8/32', f.run);
  assert.equal(
    f.calls.filter((args) => args[0] === '-q').length,
    1,
    'Existing keys are never regenerated',
  );
  await assert.rejects(
    verifyKeyPair(f.directory, async () => ({ stdout: otherKey() })),
    /pair differs/,
  );
  await chmod(join(f.directory, 'id_ed25519'), 0o644);
  await assert.rejects(verifyKeyPair(f.directory, f.run), /private/);
  await chmod(join(f.directory, 'id_ed25519'), 0o600);
  await rm(join(f.directory, 'id_ed25519.pub'));
  await assert.rejects(
    prepareOperator(f.directory, '8.8.8.8/32', f.run),
    /Incomplete SSH/,
  );
  await symlink(
    join(f.directory, 'id_ed25519'),
    join(f.directory, 'id_ed25519.pub'),
  );
  await assert.rejects(verifyKeyPair(f.directory, f.run), /private/);
});

test('host-key drift and mismatched known_hosts fail before saving or silently refreshing pins', async (t) => {
  const directory = await temporary(t),
    saves = [],
    writes = [];
  const save = async (value) => saves.push(structuredClone(value));
  const az = {
    write: async (args) => {
      writes.push(args);
      return response();
    },
  };
  const initial = { ...state, hostKey: undefined };
  const pinned = await pinHostKey(az, initial, directory, save);
  assert.equal(pinned.hostKey, sshPublicKey);
  assert.equal(saves.length, 1);
  assert.equal(
    (await lstat(join(directory, 'known_hosts'))).mode & 0o777,
    0o600,
  );
  assert.equal(
    await readFile(join(directory, 'known_hosts'), 'utf8'),
    knownHosts(state),
  );
  const before = await readFile(join(directory, 'known_hosts'));
  await assert.rejects(
    pinHostKey(
      { write: async () => response(otherKey()) },
      state,
      directory,
      save,
    ),
    /no silent pin refresh/,
  );
  assert.equal(saves.length, 1);
  assert.deepEqual(await readFile(join(directory, 'known_hosts')), before);
  await writePrivate(join(directory, 'known_hosts'), 'foreign fixture pin\n');
  await assert.rejects(
    pinHostKey(az, state, directory, save),
    /known_hosts differs/,
  );
  assert.equal(saves.length, 1);
  assert.equal(
    await readFile(join(directory, 'known_hosts'), 'utf8'),
    'foreign fixture pin\n',
  );
  assert(
    writes.every(
      (args) => args.at(-1) === 'cat /etc/ssh/ssh_host_ed25519_key.pub',
    ),
  );
});

test('SSH disables ambient configuration, agent/proxy/TTY/multiplexing and all host-key refresh', () => {
  const directory = '/fixture/isolated',
    args = sshArgs(state, directory, 'fixture-command');
  assert.deepEqual(args.slice(0, 3), ['-F', '/dev/null', '-T']);
  for (const option of [
    'StrictHostKeyChecking=yes',
    `UserKnownHostsFile=${directory}/known_hosts`,
    'GlobalKnownHostsFile=/dev/null',
    `IdentityFile=${directory}/id_ed25519`,
    'IdentitiesOnly=yes',
    'IdentityAgent=none',
    'ForwardAgent=no',
    'ForwardX11=no',
    'ClearAllForwardings=yes',
    'RequestTTY=no',
    'ProxyCommand=none',
    'ProxyJump=none',
    'ControlMaster=no',
    'ControlPath=none',
    'UpdateHostKeys=no',
    'HostKeyAlgorithms=ssh-ed25519',
    'BatchMode=yes',
    'PasswordAuthentication=no',
    'KbdInteractiveAuthentication=no',
    'CheckHostIP=yes',
    'ConnectTimeout=10',
    'ConnectionAttempts=1',
  ])
    assert(args.includes(option), option);
  assert.equal(args.at(-2), `opendots@${state.binding.ipv4}`);
  assert.equal(args.at(-1), 'fixture-command');
});

test(
  'real fake-SSH child receives secrets only on stdin and completes buffered and streamed binary output',
  { timeout: 8_000 },
  async (t) => {
    const f = await transport(
      t,
      `const chunks=[];process.stdin.on('data',x=>chunks.push(x));process.stdin.on('end',()=>{if(Buffer.concat(chunks).toString()!=='fake-stdin-only-secret')process.exit(2);process.stdout.end(Buffer.alloc(256*1024,255));});`,
    );
    const chunks = [],
      output = new Writable({
        write(chunk, encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
    assert.equal(
      await f.ssh.run('fixture-safe-command', {
        input: 'fake-stdin-only-secret',
        output,
        timeoutMs: 3_000,
      }),
      '',
    );
    assert(output.writableFinished);
    assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(256 * 1024, 255));
    assert(!JSON.stringify(f.launches).includes('fake-stdin-only-secret'));
    const buffered = await transport(
      t,
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.end('complete fixture output'));`,
    );
    assert.equal(
      await buffered.ssh.run('fixture-buffered', { timeoutMs: 3_000 }),
      'complete fixture output',
    );
  },
);

for (const mode of ['exit', 'timeout', 'abort', 'output-error', 'overflow'])
  test(
    `real fake-SSH ${mode} fails boundedly without a pipeline hang or leaked stderr`,
    { timeout: 6_000 },
    async (t) => {
      const controller = new AbortController();
      const scripts = {
        exit: `process.stdin.resume();process.stderr.write('fixture-sensitive-error');process.stdout.write('partial');process.exitCode=2;`,
        timeout: `process.stdin.resume();setInterval(()=>{},1000);`,
        abort: `process.stdin.resume();setInterval(()=>{},1000);`,
        'output-error': `process.stdin.resume();process.stdout.write(Buffer.alloc(65536));setInterval(()=>{},1000);`,
        overflow: `process.stdin.resume();process.stdout.end(Buffer.alloc(1_000_001));`,
      };
      const f = await transport(t, scripts[mode], {
        signal: controller.signal,
      });
      const options = { timeoutMs: mode === 'timeout' ? 80 : 2_000 };
      if (mode !== 'overflow')
        options.output = new Writable({
          write(chunk, encoding, callback) {
            callback(
              mode === 'output-error'
                ? new Error('fixture output failure')
                : undefined,
            );
          },
        });
      if (mode === 'abort') {
        const timer = setTimeout(() => controller.abort(), 80);
        t.after(() => clearTimeout(timer));
      }
      await assert.rejects(f.ssh.run('fixture-failure', options), (error) => {
        assert.match(error.message, /failed or timed out/);
        assert(!error.message.includes('fixture-sensitive-error'));
        return true;
      });
      assert(
        f.children.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
      );
    },
  );

test(
  'launch errors and pre-aborted operations destroy output without hanging or launching SSH',
  { timeout: 5_000 },
  async (t) => {
    const f = await operator(t);
    const ssh = await sshTransport(state, f.directory, {
      run: f.run,
      launch: () =>
        spawn('/no-such-opendots-fixture-ssh', [], {
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
    });
    const output = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    });
    await assert.rejects(
      ssh.run('fixture', { output, timeoutMs: 1_000 }),
      /failed or timed out/,
    );
    assert(output.destroyed);
    const controller = new AbortController();
    controller.abort();
    const pre = await sshTransport(state, f.directory, {
      run: f.run,
      signal: controller.signal,
      launch: () => assert.fail('Aborted SSH must not launch'),
    });
    const next = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    });
    await assert.rejects(pre.run('fixture', { output: next }), /cancelled/);
    assert(next.destroyed);
  },
);

test('transport does not bypass private-key metadata or its isolated known_hosts guard', async (t) => {
  const f = await operator(t);
  await writePrivate(join(f.directory, 'known_hosts'), 'foreign-pin\n');
  await assert.rejects(
    sshTransport(state, f.directory, { run: f.run }),
    /TOFU is prohibited/,
  );
  await writePrivate(join(f.directory, 'known_hosts'), knownHosts(state));
  await chmod(join(f.directory, 'id_ed25519'), 0o644);
  await assert.rejects(
    sshTransport(state, f.directory, { run: f.run }),
    /private/,
  );
});

test('rootCommand fixes the private root lock and bounds both lock wait and remote execution', () => {
  const command = rootCommand('printf fixture', 720);
  for (const text of [
    'sudo -n /bin/bash -c',
    'set -euo pipefail',
    'umask 077',
    'test ! -L /run/opendots-operator.lock',
    'exec 9>>/run/opendots-operator.lock',
    'test -f /run/opendots-operator.lock',
    'stat -c',
    '0:600',
    'flock -w 30 9',
    'timeout --kill-after=10 720',
  ])
    assert(command.includes(text), text);
  for (const invalid of [0, -1, 1201, 1.5, Infinity])
    assert.throws(() => rootCommand('fixture', invalid), /deadline/);
});

const installDirectories = [
  '/usr/local/lib/opendots',
  '/etc/opendots',
  '/etc/systemd/system',
  '/etc/systemd/system/caddy.service.d',
];
const installFiles = [
  ['/usr/local/lib/opendots/vm-host.sh', '0755'],
  ['/etc/opendots/Caddyfile', '0644'],
  ['/etc/systemd/system/caddy.service.d/opendots.conf', '0644'],
  ['/etc/systemd/system/opendots.service', '0644'],
  ['/etc/opendots/private-fixture', '0600'],
];
const privateAncestors = [
  '/',
  '/usr',
  '/usr/local',
  '/usr/local/lib',
  '/etc',
  '/etc/systemd',
  '/srv',
  '/srv/opendots',
  '/srv/opendots/private',
];
const installContent = 'nonsecret install fixture\n';
async function installation(t) {
  const directory = await temporary(t);
  for (const path of privateAncestors) {
    await mkdir(directory + path, { recursive: true, mode: 0o700 });
    await chmod(directory + path, 0o700);
  }
  await writeFile(
    directory + '/srv/opendots/private/runtime.env',
    'private fixture\n',
    {
      mode: 0o600,
    },
  );
  return {
    directory,
    install: (path, content = installContent, mode = '0644', foreign = '') =>
      installFile(
        {
          run: async (command, { input, timeoutMs }) => {
            assert.equal(timeoutMs, 260_000);
            const result = execute(
              'python3',
              [
                new URL('./install_file_fixture.py', import.meta.url).pathname,
                directory,
                command,
                foreign,
              ],
              { cwd: directory, timeout: 5_000 },
            );
            result.child.stdin.end(input);
            return (await result).stdout;
          },
        },
        path,
        content,
        mode,
      ),
  };
}
async function assertPrivateInstallation(directory) {
  for (const path of privateAncestors)
    assert.equal((await lstat(directory + path)).mode & 0o777, 0o700, path);
  const path = directory + '/srv/opendots/private/runtime.env';
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, 'utf8'), 'private fixture\n');
}

for (const existing of [false, true])
  test(`installFile executes Python under umask 077 and repairs only approved ${existing ? 'existing 0700' : 'fresh'} directories`, async (t) => {
    const f = await installation(t);
    if (existing) {
      for (const path of installDirectories)
        await mkdir(f.directory + path, { recursive: true, mode: 0o700 });
      for (const [path, mode] of installFiles)
        await writeFile(f.directory + path, installContent, {
          mode: Number.parseInt(mode, 8),
        });
    }
    for (const [path, mode] of installFiles) {
      const before = existing ? await lstat(f.directory + path) : undefined;
      await f.install(path, installContent, mode);
      const after = await lstat(f.directory + path);
      assert.equal(after.mode & 0o777, Number.parseInt(mode, 8), path);
      assert.equal(await readFile(f.directory + path, 'utf8'), installContent);
      if (before)
        assert.equal(after.ino, before.ino, 'Identical file is not replaced');
    }
    for (const path of installDirectories)
      assert.equal((await lstat(f.directory + path)).mode & 0o777, 0o755, path);
    const privatePath = '/etc/opendots/private-fixture';
    const before = await lstat(f.directory + privatePath);
    await assert.rejects(f.install(privatePath, installContent, '0644'));
    const after = await lstat(f.directory + privatePath);
    assert.equal(
      after.mode & 0o777,
      0o600,
      'Retry never relaxes a private leaf',
    );
    assert.equal(after.ino, before.ino);
    await assertPrivateInstallation(f.directory);
  });

test('installFile refuses traversal, destinations outside the allowlist and unsupported modes before running', async () => {
  const ssh = {
    run: () => assert.fail('Invalid destination must not execute'),
  };
  for (const path of [
    '/etc/opendots/../Caddyfile',
    '/etc/opendots/./Caddyfile',
    '/etc/opendots/subdir/../../shadow',
    '/usr/local/lib/opendots/..',
    '/etc/systemd/system/.',
    '/etc/opendots//Caddyfile',
    '/etc/opendots/Caddyfile/',
    '/srv/opendots/runtime.env',
    '/etc/opendots',
  ])
    await assert.rejects(installFile(ssh, path, installContent), /destination/);
  await assert.rejects(
    installFile(ssh, '/etc/opendots/Caddyfile', installContent, '0777'),
    /destination/,
  );
});

for (const unsafe of [
  'symlink',
  'foreign owner',
  'group writable',
  'world writable',
])
  test(`installFile rejects every ${unsafe} parent without relaxing it`, async (t) => {
    const parents = [...privateAncestors.slice(0, 6), ...installDirectories];
    for (const parent of parents) {
      if (unsafe === 'symlink' && parent === '/') continue;
      await t.test(parent, async (t) => {
        const f = await installation(t);
        for (const path of installDirectories)
          await mkdir(f.directory + path, { recursive: true, mode: 0o700 });
        const path = f.directory + parent;
        if (unsafe === 'symlink') {
          await rm(path, { recursive: true });
          await symlink(f.directory + '/srv/opendots/private', path);
        } else if (unsafe.includes('writable'))
          await chmod(path, unsafe === 'group writable' ? 0o720 : 0o702);
        const before = await lstat(path);
        const destination = parent.startsWith('/usr')
          ? '/usr/local/lib/opendots/vm-host.sh'
          : parent.startsWith('/etc/systemd')
            ? '/etc/systemd/system/caddy.service.d/opendots.conf'
            : '/etc/opendots/Caddyfile';
        await assert.rejects(
          f.install(
            destination,
            installContent,
            '0644',
            unsafe === 'foreign owner' ? parent : '',
          ),
        );
        assert.equal((await lstat(path)).mode, before.mode);
        await assert.rejects(lstat(f.directory + destination), {
          code: 'ENOENT',
        });
        assert.equal(
          await readFile(
            f.directory + '/srv/opendots/private/runtime.env',
            'utf8',
          ),
          'private fixture\n',
        );
      });
    }
  });

test('installFile does not create missing broad ancestors', async (t) => {
  for (const [parent, destination] of [
    ['/usr/local/lib', '/usr/local/lib/opendots/vm-host.sh'],
    ['/etc/systemd', '/etc/systemd/system/opendots.service'],
  ]) {
    const f = await installation(t);
    await rm(f.directory + parent, { recursive: true });
    await assert.rejects(f.install(destination));
    await assert.rejects(lstat(f.directory + parent), { code: 'ENOENT' });
  }
});

test('installFile conflicts and unsafe leaves preserve existing bytes and metadata', async (t) => {
  for (const kind of [
    'different bytes',
    'wrong mode',
    'symlink',
    'foreign owner',
    'group writable',
    'world writable',
    'directory',
    'fifo',
  ])
    await t.test(kind, async (t) => {
      const f = await installation(t);
      const target = '/etc/opendots/Caddyfile',
        path = f.directory + target,
        saved = f.directory + '/srv/opendots/private/runtime.env';
      await mkdir(f.directory + '/etc/opendots', { mode: 0o700 });
      if (kind === 'symlink') await symlink(saved, path);
      else if (kind === 'directory') await mkdir(path, { mode: 0o700 });
      else if (kind === 'fifo') await execute('mkfifo', ['-m', '600', path]);
      else await writeFile(path, installContent, { mode: 0o600 });
      if (kind.includes('writable'))
        await chmod(path, kind === 'group writable' ? 0o620 : 0o602);
      const before = await lstat(path);
      await assert.rejects(
        f.install(
          target,
          kind === 'different bytes'
            ? 'conflicting replacement\n'
            : installContent,
          kind === 'wrong mode' ? '0755' : '0600',
          kind === 'foreign owner' ? target : '',
        ),
      );
      const after = await lstat(path);
      assert.equal(after.ino, before.ino);
      assert.equal(after.mode, before.mode);
      if (before.isFile())
        assert.equal(await readFile(path, 'utf8'), installContent);
      assert.equal(await readFile(saved, 'utf8'), 'private fixture\n');
      await assertPrivateInstallation(f.directory);
    });
});

test(
  'a real concurrent second flock fails while the first local fixture holds the lock',
  { timeout: 5_000 },
  async (t) => {
    const directory = await temporary(t),
      path = join(directory, 'operator.lock');
    const first = spawn(
      '/bin/bash',
      [
        '-c',
        'umask 077; exec 9>>"$1"; flock -w 1 9; printf held; read -r release',
        'fixture',
        path,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    t.after(() => {
      if (first.exitCode === null) first.kill('SIGKILL');
    });
    const closed = once(first, 'close');
    const [ready] = await once(first.stdout, 'data');
    assert.equal(ready.toString(), 'held');
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await assert.rejects(
      execute('flock', ['-w', '0.1', path, 'true'], { timeout: 1_000 }),
      (error) => error.code === 1,
    );
    first.stdin.end('release\n');
    assert.equal((await closed)[0], 0);
    await execute('flock', ['-n', path, 'true'], { timeout: 1_000 });
  },
);

test('startup avoids recursive operator locking and host file operations stay in bounded UID1000 helpers', async () => {
  const rendered = units(state, image);
  for (const line of rendered.app
    .split('\n')
    .filter((line) => line.startsWith('ExecStart'))) {
    assert(!line.includes('flock'));
    assert(!line.includes('rootCommand'));
    assert(!line.includes('opendots-operator.lock'));
  }
  assert(
    rendered.app.includes(
      'ExecStartPre=/usr/bin/python3 /usr/local/lib/opendots/vm-disk.py check',
    ),
  );
  assert(
    rendered.app.includes(
      `ExecStart=/usr/local/lib/opendots/vm-host.sh run ${image}`,
    ),
  );
  const host = await readFile(
    new URL('../vm-host.sh', import.meta.url),
    'utf8',
  );
  const bootstrap = await readFile(
    new URL('../vm-bootstrap.sh', import.meta.url),
    'utf8',
  );
  for (const path of ['vm-host.sh', 'vm-bootstrap.sh'])
    await execute(
      '/bin/bash',
      ['-n', new URL(`../${path}`, import.meta.url).pathname],
      { timeout: 2_000 },
    );
  assert(host.includes('((docker_major >= 28))'));
  assert(
    host.includes(
      '--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only',
    ),
  );
  assert(host.includes('--network bridge'));
  assert(host.includes('--publish 127.0.0.1:4310:4310/tcp'));
  assert(!host.includes('--restart'));
  assert(!host.includes('opendots-operator.lock'));
  for (const [verb, seconds] of [
    ['configure', 60],
    ['backup', 300],
    ['download', 840],
  ]) {
    const section = host.split(`  ${verb})`)[1].split(';;')[0];
    assert(section.includes('--user 1000:1000'));
    assert(
      section.includes(
        `/usr/bin/timeout ${seconds} /usr/local/bin/node /app/deployment/azure/vm-files.mjs ${verb}`,
      ),
    );
    assert(!section.includes('python3 -c'));
  }
  for (const text of [
    'timeout 600 cloud-init status --wait',
    'DPkg::Lock::Timeout=600',
    'udevadm control --reload-rules',
    'udevadm trigger --subsystem-match=block --action=change',
    'udevadm settle --timeout=30',
    '((docker_major >= 28))',
    '9DC858229FC7DD38854AE2D88D81803C0EBFCD88',
    '65760C51EDEA2017CEA2CA15155B6D79CA56EA34',
  ])
    assert(bootstrap.includes(text), text);
});
