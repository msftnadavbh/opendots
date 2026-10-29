import { mkdir, mkdtemp, open, rm, lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SCOPE,
  PilotError,
  assertEnvironment,
  assertOwned,
  requirePilot,
  safeError,
  VM,
  REGISTRY_NAME,
  resourceId,
  validateImage,
  validateOutputs,
} from './scope.mjs';
import {
  createAz,
  inspectGroupBeforeDeployment,
  inspectTokenPolicy,
  verifyLiveResources,
} from './cloud.mjs';
import { disableImportToken } from './import-token.mjs';
import { recordDeployment, validateVmState, verifyVm } from './vm-state.mjs';
import { validateParameters } from './ssh.mjs';
import { provisionVm, configureVm, vmServiceCommand } from './vm.mjs';
import { managedTransport } from './run-command.mjs';
import {
  assertNormalActivation,
  inspectInitialGuest,
  inspectCaddy,
  recoverInitialActivation,
} from './initial-activation.mjs';
import {
  reconcileExistingPilot,
  verifyExistingPilot,
  existingPilotSave,
} from './existing-pilot.mjs';
import { backupHttps } from './backup-https.mjs';
import { readPrivate, writePrivate } from './runtime-env.mjs';
import { stageBuild } from './build-context.mjs';
import { manifest, verifyRestore } from './sqlite-backup.mjs';
import { ORIGINAL_PROFILE, selectProfile } from './profiles.mjs';
import { migrationMain } from './migration.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = join(root, 'artifacts/azure-pilot');
const outputsPath = join(artifacts, 'arm-outputs.json');
const statePath = join(artifacts, 'vm-state.json');
const parametersPath = join(artifacts, 'vm-parameters.json');
const save = (state) =>
  writePrivate(statePath, JSON.stringify(state, null, 2) + '\n');
const jsonFile = async (path, optional = false) => {
  const text = await readPrivate(path, { optional });
  return text ? JSON.parse(text) : undefined;
};

export async function main(args = process.argv.slice(2)) {
  const selected = selectProfile(args);
  if (selected.profile !== ORIGINAL_PROFILE)
    return migrationMain(selected.profile, selected.args);
  args = selected.args;
  const [command, ...parameters] = args;
  const arity = {
    prepare: 1,
    validate: 0,
    'what-if': 0,
    deploy: 0,
    build: 0,
    provision: 2,
    configure: 0,
    backup: 0,
    'restore-test': 1,
    restart: 0,
    stop: 0,
    resume: 0,
    status: 0,
    'token-disable': 0,
    'management-canary': 0,
    'management-reconcile': 0,
    'management-record-canary': 1,
    'recover-initial-image': 1,
    'reconcile-existing': 0,
    'initial-check': 0,
    'caddy-check': 0,
  };
  if (!command || command === 'help') {
    console.log(
      'VM pilot only: validate | what-if | deploy | build | provision <ARM-outputs.json> <registry/opendots@sha256:digest> | configure | status | backup | restore-test <backup.sqlite> | restart | stop | resume | token-disable | reconcile-existing | initial-check | caddy-check | management-canary | management-reconcile | management-record-canary <private-proof.json> | recover-initial-image <private-reviewed-target.json>. SSH management is retired; backup uses owner-authenticated HTTPS. Historical prepare parameters/keys stay pinned.',
    );
    return;
  }
  requirePilot(
    Object.hasOwn(arity, command) && parameters.length === arity[command],
    'Unknown command or arguments. Production deployment and destructive cleanup are not supported.',
  );
  assertEnvironment();
  requirePilot(
    command !== 'prepare',
    'SSH preparation is retired. Preserve the existing public parameters, hash, keys and host pin; never regenerate or rebind them.',
  );
  process.umask(0o077);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const lockPath = join(artifacts, 'operator.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new PilotError(
      'Another pilot operation or an interrupted lock exists. Confirm no operator is active before manually removing artifacts/azure-pilot/operator.lock.',
    );
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    if (command === 'restore-test') {
      const path = await realpath(resolve(parameters[0]));
      const metadata = await lstat(path);
      requirePilot(
        path.startsWith(join(artifacts, 'backups') + '/') &&
          metadata.isFile() &&
          metadata.uid === process.getuid() &&
          (metadata.mode & 0o777) === 0o600,
        'Restore tests only accept private pilot backups, never the active database.',
      );
      const expected = await jsonFile(`${path}.manifest.json`);
      requirePilot(
        JSON.stringify(manifest(path)) === JSON.stringify(expected),
        'Backup is missing its matching verified manifest.',
      );
      const result = await verifyRestore(path, join(artifacts, 'verification'));
      await writePrivate(
        `${result.destination}.manifest.json`,
        JSON.stringify(result, null, 2),
      );
      console.log(`Restore verification passed: ${result.destination}`);
      return;
    }
    const az = createAz();
    await az.verify();
    if (command === 'token-disable') {
      const registryId = resourceId(
        'Microsoft.ContainerRegistry/registries',
        REGISTRY_NAME,
      );
      assertOwned(
        await az.read([
          'resource',
          'show',
          '--ids',
          registryId,
          '--api-version',
          '2025-11-01',
        ]),
        registryId,
      );
      await disableImportToken(az, {
        registryName: REGISTRY_NAME,
        resourceGroup: SCOPE.resourceGroup,
      });
      console.log('Repository import token verified disabled.');
      return;
    }
    const publicParameters = validateParameters(await jsonFile(parametersPath));
    let saved = await jsonFile(statePath, true);
    if (['validate', 'what-if', 'deploy'].includes(command)) {
      const exists = await inspectGroupBeforeDeployment(az, saved);
      await inspectTokenPolicy(
        az,
        `/subscriptions/${SCOPE.subscriptionId}${exists ? `/resourceGroups/${SCOPE.resourceGroup}` : ''}`,
      );
      const operation = command === 'deploy' ? 'create' : command;
      if (command === 'deploy')
        saved = await recordDeployment(az, publicParameters, saved, save);
      controller.signal.throwIfAborted();
      const result = await az.write([
        'deployment',
        'sub',
        operation,
        '--name',
        'opendots-pilot',
        '--location',
        SCOPE.location,
        '--template-file',
        join(root, 'infra/main.bicep'),
        '--parameters',
        `@${parametersPath}`,
        ...(command === 'what-if' ? ['--no-pretty-print'] : []),
      ]);
      if (command === 'deploy') {
        const output = validateOutputs(result.properties?.outputs);
        await writePrivate(outputsPath, JSON.stringify(output, null, 2));
        await verifyLiveResources(az, output);
        await verifyVm(az, output, publicParameters, saved, save);
        console.log(
          'Pilot ARM outputs and immutable VM/disk bindings saved. No disk was formatted and no application was activated.',
        );
      } else {
        await writePrivate(
          join(artifacts, `${command}.json`),
          JSON.stringify(result, null, 2),
        );
        console.log(
          `Pilot ${command} result saved to artifacts/azure-pilot/${command}.json for review.`,
        );
      }
      return;
    }
    const output = validateOutputs(
      await jsonFile(
        command === 'provision' ? resolve(parameters[0]) : outputsPath,
      ),
    );
    if (command === 'reconcile-existing') {
      await reconcileExistingPilot(az, output, publicParameters, saved, save);
      console.log(
        'Existing original VM reconciliation recorded for the exact post-change web profile. No resource, binding, image or guest was changed.',
      );
      return;
    }
    let existing;
    if (saved?.existingPilot !== undefined)
      existing = await verifyExistingPilot(az, output, publicParameters, saved);
    else {
      await verifyLiveResources(az, output);
      await inspectGroupBeforeDeployment(az, saved);
    }
    if (command === 'build') {
      if (existing)
        requirePilot(
          !existing.state.management?.pending &&
            !existing.state.pullOperationId &&
            !existing.state.initialActivationRecovery?.conflict &&
            !['prepared', 'applied'].includes(
              existing.state.initialActivationRecovery?.status,
            ),
          'Reconcile pending or conflicting existing-pilot work before a new build.',
        );
      await mkdir('/tmp/opencode', { recursive: true, mode: 0o700 });
      const context = await mkdtemp('/tmp/opencode/opendots-pilot-build-');
      try {
        await stageBuild(root, context);
        const tag = `pilot-${Date.now()}-${randomUUID().slice(0, 8)}`;
        controller.signal.throwIfAborted();
        const result = await az.write([
          'acr',
          'build',
          '--registry',
          output.registryName,
          '--resource-group',
          SCOPE.resourceGroup,
          '--image',
          `opendots:${tag}`,
          '--target',
          'app',
          '--file',
          join(context, 'Dockerfile'),
          '--platform',
          'linux/amd64',
          '--no-logs',
          context,
        ]);
        requirePilot(
          result?.status === 'Succeeded',
          'ACR build did not succeed; no image will be deployed.',
        );
        const digest = await az.read([
          'acr',
          'repository',
          'show',
          '--name',
          output.registryName,
          '--image',
          `opendots:${tag}`,
          '--query',
          'digest',
        ]);
        const image = validateImage(
          `${output.registryLoginServer}/opendots@${digest}`,
          output,
        );
        await writePrivate(
          join(artifacts, 'image.json'),
          JSON.stringify({ tag, image }, null, 2),
        );
        console.log(
          `Built app image: ${image}\nRecorded in artifacts/azure-pilot/image.json; nothing was provisioned.`,
        );
      } finally {
        await rm(context, { recursive: true, force: true });
      }
      return;
    }
    validateVmState(saved, publicParameters);
    let verified =
      existing ?? (await verifyVm(az, output, publicParameters, saved, save));
    if (['provision', 'configure', 'restart', 'resume'].includes(command))
      assertNormalActivation(verified.state, output);
    if (command === 'status' && verified.power !== 'PowerState/running') {
      console.log(
        JSON.stringify({
          power: verified.power,
          origin: `https://${verified.state.binding.fqdn}`,
          mount: 'not checked while VM is stopped',
        }),
      );
      return;
    }
    if (
      command === 'stop' &&
      ['PowerState/stopped', 'PowerState/deallocated'].includes(verified.power)
    ) {
      console.log('VM is already stopped; both disks retained.');
      return;
    }
    if (
      command === 'resume' &&
      ['PowerState/stopped', 'PowerState/deallocated'].includes(verified.power)
    ) {
      requirePilot(
        !existing,
        'Existing-pilot reconciliation grants no automatic power start; obtain separate live power authorization.',
      );
      requirePilot(
        !verified.state.initialActivationRecovery?.conflict,
        'Bound post-intent conflict prohibits automatic resume; retain recovery facts for lead reconciliation.',
      );
      controller.signal.throwIfAborted();
      await az.write(['vm', 'start', '--ids', VM.ids.id]);
      verified = await verifyVm(
        az,
        output,
        publicParameters,
        verified.state,
        save,
      );
    }
    requirePilot(
      command === 'management-reconcile' ||
        verified.power === 'PowerState/running',
      'VM is not running. Explicitly resume it; SSH must remain closed.',
    );
    controller.signal.throwIfAborted();
    const state = verified.state;
    const persist = existing ? existingPilotSave(state, save) : save;
    if (command === 'backup') {
      requirePilot(
        state.provisioned && state.configured,
        'Configure and verify the pilot before exporting a backup.',
      );
      const destination = await backupHttps({
        output,
        privatePath: join(root, '.env.pilot'),
        directory: join(artifacts, 'backups'),
        signal: controller.signal,
      });
      console.log(
        `Consistent HTTPS backup saved privately: ${destination}\nRun restore-test on this file; the active database was not replaced.`,
      );
      return;
    }
    const ssh = managedTransport({
      az,
      state,
      save: persist,
      signal: controller.signal,
    });
    if (command === 'management-reconcile') {
      const receipt = await ssh.reconcile();
      console.log(
        receipt
          ? `Managed completion reconciled: ${receipt.operationId}, exit ${receipt.exitCode}. No command was resubmitted.`
          : 'No pending managed operation.',
      );
      return;
    }
    if (command === 'management-canary') {
      console.log(JSON.stringify(await ssh.canary()));
      console.log(
        'Nonsecret canary only; protected operations remain locked until every required surface is inspected and proof recorded.',
      );
      return;
    }
    if (command === 'management-record-canary') {
      await ssh.recordPrivacyValidation(await jsonFile(resolve(parameters[0])));
      console.log(
        'Lead privacy inspection recorded for the exact VM, handler and transport.',
      );
      return;
    }
    if (command === 'recover-initial-image') {
      await recoverInitialActivation({
        az,
        ssh,
        output,
        parameters: publicParameters,
        state,
        save: persist,
        approval: await jsonFile(resolve(parameters[0])),
      });
      console.log(
        'Version-1 initial image/unit recovery completed and image pin recorded. Nothing was started or enabled.',
      );
      return;
    }
    requirePilot(
      !state.initialActivationRecovery?.conflict &&
        !['prepared', 'applied'].includes(
          state.initialActivationRecovery?.status,
        ),
      'Reconcile initial activation recovery before normal guest operations; a bound conflict prohibits automatic continuation.',
    );
    if (
      command === 'initial-check' ||
      (command === 'status' &&
        existing &&
        !state.provisioned &&
        !state.configured)
    ) {
      await inspectInitialGuest({ ssh, state });
      console.log(
        JSON.stringify({
          power: verified.power,
          service: 'inactive',
          initialGuestChecks: 'passed',
          activated: false,
        }),
      );
      return;
    }
    if (command === 'caddy-check') {
      await inspectCaddy({ ssh, state });
      console.log(
        'Caddy fixed configuration, service-user readability and running service checks passed; no service/configuration was changed.',
      );
      return;
    }
    if (command === 'provision') {
      controller.signal.throwIfAborted();
      await provisionVm({
        az,
        ssh,
        output,
        image: parameters[1],
        state,
        save: persist,
      });
      // Imported outputs are stored only after scope and live ownership validation.
      await writePrivate(outputsPath, JSON.stringify(output, null, 2));
      console.log(
        `Pilot VM ready for private configuration: https://${state.binding.fqdn}\nRun configure; no runtime credentials are in the image or service unit.`,
      );
      return;
    }
    if (command === 'status') {
      await ssh.run(vmServiceCommand('status'), { schema: 'status' });
      console.log(
        JSON.stringify({
          power: verified.power,
          origin: `https://${state.binding.fqdn}`,
          mountVerified: true,
          service: 'active',
        }),
      );
    } else if (command === 'configure') {
      await configureVm({
        ssh,
        output,
        state,
        sourcePath: join(root, '.env'),
        privatePath: join(root, '.env.pilot'),
        save: persist,
      });
      console.log(
        'Runtime configuration uploaded atomically. Owner token is only in .env.pilot (0600), never stdout.',
      );
    } else if (command === 'restart') {
      await ssh.run(vmServiceCommand('restart'));
      console.log('Graceful application restart requested; verify /readyz.');
    } else if (command === 'stop') {
      await ssh.run(vmServiceCommand('stop'));
      controller.signal.throwIfAborted();
      await az.write(['vm', 'deallocate', '--ids', VM.ids.id]);
      console.log(
        'VM deallocated after application shutdown; data and OS disks retained.',
      );
    } else if (command === 'resume') {
      await ssh.run(vmServiceCommand('status'), { schema: 'status' });
      console.log(
        'VM resumed with verified mount and active service; verify HTTPS, identity and owner authentication.',
      );
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await lock.close();
    await rm(lockPath);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
