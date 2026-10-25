import { randomUUID } from 'node:crypto';
import { readFile, mkdir, lstat, link, unlink, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import {
  SCOPE,
  VM,
  RUN_COMMAND,
  requirePilot,
  validateImage,
} from './scope.mjs';
import { inspectTokenPolicy } from './cloud.mjs';
import { withImportToken } from './import-token.mjs';
import { diskPlan, validateVmState } from './vm-state.mjs';
import { installFile, quote, rootCommand } from './ssh.mjs';
import {
  makeRuntimeEnv,
  encodeRuntimeEnv,
  parseEnv,
  readPrivate,
  validateRuntimeEnv,
  writePrivate,
  syncDirectory,
} from './runtime-env.mjs';
import { manifest } from './sqlite-backup.mjs';

const helper = (verb, seconds = 180) =>
  rootCommand(`/usr/local/lib/opendots/vm-host.sh ${verb}`, seconds);
const readHelper = (verb) =>
  `sudo -n /usr/local/lib/opendots/vm-host.sh ${verb}`;
const cleanupPull = async (ssh, id) => {
  // Reconciliation and the following cleanup each keep their own bounded budget.
  const signal = AbortSignal.timeout(520_000);
  // A lost PUT/poll cannot be overwritten by cleanup while the pull may still be running.
  await ssh.reconcile?.({ signal, timeoutMs: 240_000 });
  return ssh.run(helper(`cleanup-pull ${id}`), {
    signal,
    timeoutMs: 260_000,
  });
};
export function units(state, image) {
  requirePilot(
    /^[0-9a-f-]{36}$/.test(state.fsUuid ?? ''),
    'Missing bound filesystem UUID.',
  );
  const origin = `https://${state.binding.fqdn}`;
  return {
    mount: `[Unit]\nDescription=OpenDots retained pilot data disk\nBefore=opendots.service\n\n[Mount]\nWhat=/dev/disk/by-uuid/${state.fsUuid}\nWhere=/srv/opendots\nType=ext4\nOptions=nodev,nosuid\nTimeoutSec=30\n\n[Install]\nWantedBy=multi-user.target\n`,
    app: `[Unit]\nDescription=OpenDots single-owner pilot\nRequires=docker.service\nRequiresMountsFor=/srv/opendots\nBindsTo=srv-opendots.mount\nAfter=docker.service srv-opendots.mount network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStartPre=/usr/bin/python3 /usr/local/lib/opendots/vm-disk.py check\nExecStart=/usr/local/lib/opendots/vm-host.sh run ${image}\nExecStop=/usr/bin/docker stop --time 15 opendots-pilot\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`,
    caddy: `{\n  admin 127.0.0.1:2019\n  log default {\n    exclude http.log.access http.log.error\n  }\n}\n\n${origin} {\n  reverse_proxy 127.0.0.1:4310\n}\n`,
    caddyService:
      '[Service]\nExecStart=\nExecStart=/usr/bin/caddy run --config /etc/opendots/Caddyfile --adapter caddyfile\nExecReload=\nExecReload=/usr/bin/caddy reload --config /etc/opendots/Caddyfile --adapter caddyfile\n',
  };
}

export async function pullImage({ az, ssh, output, image, state, save }) {
  validateImage(image, output);
  if (state.pullOperationId) {
    requirePilot(
      /^[a-f0-9-]{36}$/.test(state.pullOperationId),
      'Invalid pending pull operation.',
    );
    await cleanupPull(ssh, state.pullOperationId);
    delete state.pullOperationId;
    await save(state);
  }
  const present = (
    await ssh.run(helper(`image-present ${quote(image)}`), { schema: 'image' })
  ).trim();
  requirePilot(
    ['true', 'false'].includes(present),
    'Unexpected local image verification result.',
  );
  if (present === 'true') return;
  await ssh.requireProtectedInput?.();
  await inspectTokenPolicy(az, output.registryId);
  ssh.signal?.throwIfAborted();
  state.pullOperationId = randomUUID();
  await save(state);
  ssh.signal?.throwIfAborted();
  await withImportToken(az, output, async (credentials) => {
    try {
      await ssh.run(
        helper(`pull ${state.pullOperationId} ${quote(image)}`, 720),
        {
          input: Buffer.from(credentials.token + '\n'),
          timeoutMs: 800_000,
        },
      );
    } finally {
      // This verification is required even if the remote pull/session failed; ACR revocation still runs outside it.
      await cleanupPull(ssh, state.pullOperationId);
      delete state.pullOperationId;
      await save(state);
    }
  });
}

export async function provisionVm({ az, ssh, output, image, state, save }) {
  validateVmState(state);
  validateImage(image, output);
  requirePilot(
    !state.image || state.image === image,
    'Image differs; upgrades are manual and must preserve the data disk.',
  );
  requirePilot(
    !state.initialActivationRecovery?.conflict &&
      !['prepared', 'applied'].includes(
        state.initialActivationRecovery?.status,
      ),
    'Initial activation recovery must be reconciled before provisioning.',
  );
  await ssh.requireProtectedInput?.();
  state.image = image;
  await save(state);
  for (const name of ['vm-disk.py', 'vm-host.sh', 'vm-bootstrap.sh'])
    await installFile(
      ssh,
      `/usr/local/lib/opendots/${name}`,
      await readFile(new URL(name, import.meta.url)),
      '0755',
    );
  // Install host-only Caddy configuration before the package post-install can start the service.
  const render = units(
    {
      ...state,
      fsUuid: state.fsUuid ?? '00000000-0000-0000-0000-000000000000',
    },
    image,
  );
  await installFile(ssh, '/etc/opendots/Caddyfile', render.caddy);
  await installFile(
    ssh,
    '/etc/systemd/system/caddy.service.d/opendots.conf',
    render.caddyService,
  );
  await ssh.run(rootCommand('/usr/local/lib/opendots/vm-bootstrap.sh', 1200), {
    timeoutMs: 1_280_000,
  });
  const plan = diskPlan(state);
  const disk = JSON.parse(
    await ssh.run(
      rootCommand('python3 /usr/local/lib/opendots/vm-disk.py prepare'),
      {
        input: Buffer.from(JSON.stringify(plan)),
        schema: 'disk',
        timeoutMs: 260_000,
      },
    ),
  );
  requirePilot(
    ['operationId', 'vmUniqueId', 'diskId', 'diskUniqueId'].every(
      (key) => disk[key] === plan[key],
    ) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        disk.fsUuid ?? '',
      ) &&
      (!state.fsUuid || state.fsUuid === disk.fsUuid),
    'Guest filesystem binding differs from the tracked ARM disk.',
  );
  state.fsUuid = disk.fsUuid;
  await save(state);
  const files = units(state, image);
  await installFile(ssh, '/etc/systemd/system/srv-opendots.mount', files.mount);
  await installFile(ssh, '/etc/systemd/system/opendots.service', files.app);
  await ssh.run(
    rootCommand(`set -euo pipefail
if ! mountpoint -q /srv/opendots; then
  test ! -L /srv/opendots
  if test -d /srv/opendots; then test -z "$(find /srv/opendots -mindepth 1 -maxdepth 1 -print -quit)"; else mkdir -m 0700 /srv/opendots; fi
  chown 0:0 /srv/opendots; chmod 0700 /srv/opendots
fi
systemctl daemon-reload
systemctl enable --now srv-opendots.mount
python3 /usr/local/lib/opendots/vm-disk.py check >/dev/null
chown 1000:1000 /srv/opendots; chmod 0700 /srv/opendots
caddy validate --config /etc/opendots/Caddyfile --adapter caddyfile >/dev/null 2>&1
systemctl enable --now caddy.service
systemctl reload caddy.service`),
    { timeoutMs: 260_000 },
  );
  await pullImage({ az, ssh, output, image, state, save });
  await ssh.run(helper('start'), { timeoutMs: 260_000 });
  state.provisioned = true;
  await save(state);
}

export async function configureVm({
  ssh,
  output,
  state,
  sourcePath,
  privatePath,
  save,
}) {
  requirePilot(
    state.provisioned && state.fsUuid && state.binding.fqdn === output.vm.fqdn,
    'Provision and verify the VM before configuring it.',
  );
  await ssh.requireProtectedInput?.();
  const local = await readPrivate(privatePath, { optional: true });
  requirePilot(
    !state.configured || local,
    'Saved pilot configuration is missing; recover it privately, never rotate owner identity.',
  );
  const previous = local ? validateRuntimeEnv(parseEnv(local)) : undefined;
  const source = parseEnv(await readPrivate(sourcePath));
  const content = encodeRuntimeEnv(
    makeRuntimeEnv(source, previous, output, `https://${state.binding.fqdn}`),
  );
  await writePrivate(privatePath, content);
  await ssh.run(helper('configure', 90), {
    input: content,
    timeoutMs: 170_000,
  });
  state.configured = true;
  await save(state);
}

export async function backupVm(ssh, directory) {
  // Legacy SSH tests/history only; Run Command's bounded output is never a data transport.
  requirePilot(
    ssh.kind !== RUN_COMMAND.version,
    'SSH backup is retired for managed transport; the reviewed HTTPS backup client is not implemented yet.',
  );
  const name = `backup-${randomUUID()}.sqlite`;
  const reported = JSON.parse(
    await ssh.run(helper(`backup ${name}`, 330), { timeoutMs: 390_000 }),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  requirePilot(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o777) === 0o700,
    'Backup directory must be private and owned.',
  );
  const destination = join(directory, name),
    temporary = destination + '.partial';
  // flush:true fsyncs before auto-close; disabling auto-close leaves pipeline waiting forever.
  await ssh.run(readHelper(`download ${name}`), {
    output: createWriteStream(temporary, {
      flags: 'wx',
      mode: 0o600,
      flush: true,
    }),
    timeoutMs: 900_000,
  });
  requirePilot(
    JSON.stringify(manifest(temporary)) === JSON.stringify(reported),
    'Streamed backup integrity or row/photo hashes differ; private .partial file retained.',
  );
  // Publish data last: a completed filename must always have its durable manifest.
  const metadataPath = destination + '.manifest.json';
  const metadata = await open(metadataPath, 'wx', 0o600);
  let published = false;
  try {
    await metadata.writeFile(JSON.stringify(reported, null, 2));
    await metadata.sync();
    await metadata.close();
    await syncDirectory(directory);
    await link(temporary, destination);
    published = true;
  } finally {
    await metadata.close();
    if (!published) await unlink(metadataPath);
  }
  await unlink(temporary);
  await syncDirectory(directory);
  return destination;
}

export const vmServiceCommand = (action) => {
  requirePilot(
    ['status', 'restart', 'stop'].includes(action),
    'Unsupported service operation.',
  );
  return helper(action);
};
