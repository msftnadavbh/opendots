import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  VM,
  requirePilot,
  PilotError,
  validateOperatorCidr,
} from './scope.mjs';
import { readPrivate, writePrivate } from './runtime-env.mjs';

const execute = promisify(execFile);
export function publicKey(value) {
  requirePilot(
    typeof value === 'string' && !/[\r\n]/.test(value.trim()),
    'Expected exactly one Ed25519 public key.',
  );
  const fields = value.trim().split(/\s+/);
  requirePilot(
    fields.length >= 2 &&
      fields[0] === 'ssh-ed25519' &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(fields[1]),
    'Invalid Ed25519 public key.',
  );
  const bytes = Buffer.from(fields[1], 'base64');
  requirePilot(
    bytes.length === 51 &&
      bytes.readUInt32BE(0) === 11 &&
      bytes.subarray(4, 15).toString() === 'ssh-ed25519' &&
      bytes.readUInt32BE(15) === 32 &&
      bytes.toString('base64') === fields[1],
    'Invalid Ed25519 public-key encoding.',
  );
  return fields.slice(0, 2).join(' ');
}
export function validateParameters(document) {
  const values = document?.parameters;
  requirePilot(
    values &&
      Object.keys(values).length === 2 &&
      Object.keys(values).every((key) =>
        ['sshPublicKey', 'operatorIpv4Cidr'].includes(key),
      ),
    'Only public SSH key and operator /32 ARM parameters are allowed.',
  );
  return {
    sshPublicKey: publicKey(values.sshPublicKey?.value),
    operatorIpv4Cidr: validateOperatorCidr(values.operatorIpv4Cidr?.value),
  };
}
async function privateMetadata(path, directory = false) {
  const info = await lstat(path);
  requirePilot(
    (directory ? info.isDirectory() : info.isFile()) &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o777) === (directory ? 0o700 : 0o600),
    'SSH material must be owned, regular and private (0700 directory / 0600 files).',
  );
}
export async function prepareOperator(directory, cidr, run = execute) {
  validateOperatorCidr(cidr);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privateMetadata(directory, true);
  const privatePath = join(directory, 'id_ed25519'),
    publicPath = `${privatePath}.pub`;
  const exists = async (path) =>
    lstat(path)
      .then(() => true)
      .catch((error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
  const [hasPrivate, hasPublic] = await Promise.all([
    exists(privatePath),
    exists(publicPath),
  ]);
  requirePilot(
    hasPrivate === hasPublic,
    'Incomplete SSH key pair; never regenerate or replace the existing private key.',
  );
  if (!hasPrivate) {
    await run(
      'ssh-keygen',
      [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        'opendots-pilot',
        '-f',
        privatePath,
      ],
      { timeout: 30_000 },
    );
    // Public files are also kept private alongside the operator state.
    const { chmod } = await import('node:fs/promises');
    await chmod(publicPath, 0o600);
  }
  const key = await verifyKeyPair(directory, run);
  return {
    $schema:
      'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0',
    parameters: {
      sshPublicKey: { value: key },
      operatorIpv4Cidr: { value: cidr },
    },
  };
}
export async function verifyKeyPair(directory, run = execute) {
  await privateMetadata(directory, true);
  const path = join(directory, 'id_ed25519');
  await privateMetadata(path);
  await privateMetadata(`${path}.pub`);
  const saved = publicKey(await readPrivate(`${path}.pub`));
  let derived;
  try {
    derived = publicKey(
      (
        await run('ssh-keygen', ['-y', '-P', '', '-f', path], {
          timeout: 30_000,
        })
      ).stdout,
    );
  } catch {
    throw new PilotError(
      'Cannot verify dedicated SSH key pair; no key was regenerated.',
    );
  }
  requirePilot(derived === saved, 'SSH public/private key pair differs.');
  return saved;
}

export function parseHostKey(response) {
  requirePilot(
    response?.value?.length === 1 &&
      response.value[0].code === 'ProvisioningState/succeeded',
    'Host-key RunCommand did not succeed.',
  );
  const message = response.value[0].message;
  const match = /\[stdout\]\s*\n([\s\S]*?)\n\[stderr\]([\s\S]*)$/.exec(
    message ?? '',
  );
  requirePilot(
    match && !match[2].trim(),
    'Expected only the host public key from RunCommand.',
  );
  return publicKey(match[1]);
}
export const knownHosts = (state) =>
  `${state.binding.ipv4},${state.binding.fqdn} ${publicKey(state.hostKey)}\n`;
export async function pinHostKey(az, state, directory, save) {
  requirePilot(
    state.binding?.vmId === VM.ids.id &&
      state.binding.vmUniqueId === state.seenVmUniqueId,
    'Verify immutable VM identity before retrieving its host key.',
  );
  const response = await az.write([
    'vm',
    'run-command',
    'invoke',
    '--ids',
    VM.ids.id,
    '--command-id',
    'RunShellScript',
    '--scripts',
    'cat /etc/ssh/ssh_host_ed25519_key.pub',
  ]);
  const key = parseHostKey(response);
  requirePilot(
    !state.hostKey || state.hostKey === key,
    'SSH host key changed; no silent pin refresh is allowed.',
  );
  const updated = { ...state, hostKey: key };
  const expected = knownHosts(updated),
    path = join(directory, 'known_hosts');
  const saved = await readPrivate(path, { optional: true });
  requirePilot(
    !saved || saved === expected,
    'Isolated known_hosts differs from the verified VM pin.',
  );
  await save(updated);
  if (!saved) await writePrivate(path, expected);
  return updated;
}
export function sshArgs(state, directory, command) {
  requirePilot(
    state.binding?.vmId === VM.ids.id && state.hostKey,
    'No trusted VM SSH pin.',
  );
  return [
    '-F',
    '/dev/null',
    '-T',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${join(directory, 'known_hosts')}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `IdentityFile=${join(directory, 'id_ed25519')}`,
    '-o',
    'IdentityAgent=none',
    '-o',
    'BatchMode=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'RequestTTY=no',
    '-o',
    'ProxyCommand=none',
    '-o',
    'ProxyJump=none',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'CheckHostIP=yes',
    '-o',
    'HostKeyAlgorithms=ssh-ed25519',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    `${VM.admin}@${state.binding.ipv4}`,
    command,
  ];
}
export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
// No PTY means killing ssh need not kill its remote command; serialize and bound remote mutations independently.
export function rootCommand(command, seconds = 180) {
  requirePilot(
    Number.isInteger(seconds) && seconds > 0 && seconds <= 1200,
    'Invalid remote deadline.',
  );
  return `sudo -n /bin/bash -c ${quote(`set -euo pipefail
umask 077
test ! -L /run/opendots-operator.lock
exec 9>>/run/opendots-operator.lock
test -f /run/opendots-operator.lock
test "$(stat -c '%u:%a' /run/opendots-operator.lock)" = 0:600
flock -w 30 9
exec timeout --kill-after=10 ${seconds} /bin/bash -c ${quote(command)}`)}`;
}
export async function sshTransport(
  state,
  directory,
  { launch = spawn, signal, run = execute } = {},
) {
  await verifyKeyPair(directory, run);
  requirePilot(
    (await readPrivate(join(directory, 'known_hosts'))) === knownHosts(state),
    'SSH pin file differs; TOFU is prohibited.',
  );
  return {
    signal,
    run: (
      command,
      {
        input,
        output,
        timeoutMs = 120_000,
        signal: operationSignal = signal,
      } = {},
    ) =>
      new Promise((resolve, reject) => {
        if (operationSignal?.aborted) {
          output?.destroy();
          reject(
            new PilotError(
              'Operation cancelled; remote completion must be reconciled before retry.',
            ),
          );
          return;
        }
        const child = launch('ssh', sshArgs(state, directory, command), {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let bytes = 0,
          interrupted = false;
        const chunks = [];
        const stop = () => {
          interrupted = true;
          child.kill('SIGKILL');
        };
        const timer = setTimeout(stop, timeoutMs);
        operationSignal?.addEventListener('abort', stop, { once: true });
        const failure = () =>
          new PilotError(
            'Pinned SSH operation failed or timed out; stdout/stderr suppressed. Do not widen SSH access or refresh host pins.',
          );
        child.stderr.resume();
        child.stdin.on('error', stop);
        child.stdin.end(input);
        const streamed = output
          ? pipeline(child.stdout, output).catch(() => {
              child.kill('SIGKILL');
              throw failure();
            })
          : Promise.resolve();
        // Observe stream errors immediately, including before ssh exits.
        streamed.catch(() => {});
        if (!output)
          child.stdout.on('data', (data) => {
            bytes += data.length;
            if (bytes > 1_000_000) child.kill('SIGKILL');
            else chunks.push(data);
          });
        child.on('error', () => {
          clearTimeout(timer);
          operationSignal?.removeEventListener('abort', stop);
          output?.destroy();
          reject(failure());
        });
        child.on('close', async (code) => {
          clearTimeout(timer);
          operationSignal?.removeEventListener('abort', stop);
          try {
            await streamed;
            if (code !== 0 || interrupted || bytes > 1_000_000) throw failure();
            resolve(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reject(failure());
          }
        });
      }),
  };
}

// Nonsecret checked-in scripts/units only. Runtime secrets use the dedicated configure stdin path.
export async function installFile(ssh, path, content, mode = '0644') {
  requirePilot(
    /^\/(?:usr\/local\/lib\/opendots|etc\/opendots|etc\/systemd\/system)(?:\/[A-Za-z0-9_.-]+)+$/.test(
      path,
    ) &&
      !path.split('/').some((part) => part === '.' || part === '..') &&
      ['0644', '0755', '0600'].includes(mode),
    'Unexpected VM bootstrap destination.',
  );
  const program = `import os,sys,stat,secrets
p=sys.argv[1];data=sys.stdin.buffer.read();parts=p.split('/')[1:]
roots=('/usr/local/lib/opendots','/etc/opendots','/etc/systemd/system')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
def check(d):
 s=os.fstat(d)
 if s.st_uid!=0 or s.st_mode&0o022: sys.exit(1)
d=os.open('/',flags);check(d);parent=''
for part in parts[:-1]:
 parent+='/'+part
 permitted=any(parent==r or parent.startswith(r+'/') for r in roots)
 try: n=os.open(part,flags,dir_fd=d)
 except FileNotFoundError:
  if not permitted: raise
  os.mkdir(part,mode=0o755,dir_fd=d)
  n=os.open(part,flags,dir_fd=d)
 os.close(d);d=n;check(d)
 if permitted: os.fchmod(d,0o755)
name=parts[-1]
try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
except FileNotFoundError:
 t='.opendots-'+secrets.token_hex(16)
 fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
 try:
  os.fchmod(fd,int(sys.argv[2],8))
  with os.fdopen(fd,'wb') as f: f.write(data);f.flush();os.fsync(f.fileno())
  os.link(t,name,src_dir_fd=d,dst_dir_fd=d,follow_symlinks=False)
 finally: os.unlink(t,dir_fd=d)
 os.fsync(d)
else:
 with os.fdopen(fd,'rb') as f:
  s=os.fstat(f.fileno())
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or stat.S_IMODE(s.st_mode)!=int(sys.argv[2],8) or f.read()!=data: sys.exit(1)
os.close(d)
`;
  await ssh.run(
    rootCommand(`python3 -c ${quote(program)} ${quote(path)} ${mode}`),
    {
      input: content,
      timeoutMs: 260_000,
    },
  );
}
