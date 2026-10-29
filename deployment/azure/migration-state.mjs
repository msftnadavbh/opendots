import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SCUS_PROFILE, ORIGINAL_PROFILE, assertProfile } from './profiles.mjs';
import {
  requirePilot,
  PilotError,
  validateOutputs,
  VM,
  SCOPE,
} from './scope.mjs';
import { validateVmState } from './vm-state.mjs';
import { validateParameters } from './ssh.mjs';
import { writePrivate, syncDirectory } from './runtime-env.mjs';

export const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const hashObject = (value) => sha256(JSON.stringify(canonical(value)));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const sourceFiles = SCUS_PROFILE.sourcePreservation.archiveFiles;
const encode = (value) => JSON.stringify(value, null, 2) + '\n';

export function archiveInputs(files) {
  requirePilot(
    isDeepStrictEqual(Object.keys(files).sort(), [...sourceFiles].sort()),
    'Incomplete source input archive.',
  );
  const state = JSON.parse(files['vm-state.json'].toString('utf8'));
  const parameters = validateParameters(
    JSON.parse(files['vm-parameters.json'].toString('utf8')),
  );
  const output = validateOutputs(
    JSON.parse(files['arm-outputs.json'].toString('utf8')),
  );
  validateVmState(state, parameters);
  const binding = state.binding;
  requirePilot(
    binding &&
      state.pins &&
      Object.entries(binding).every(
        ([key, value]) => state.pins[key] === value,
      ) &&
      binding.vmId === VM.ids.id &&
      binding.diskId === VM.ids.dataDiskId &&
      binding.osDiskId === VM.ids.osDiskId &&
      binding.tenantId === SCOPE.tenantId &&
      binding.nicId === VM.ids.nicId &&
      binding.publicIpId === VM.ids.publicIpId &&
      binding.vmUniqueId === state.seenVmUniqueId &&
      binding.diskUniqueId === state.creation.uniqueId &&
      binding.vmUniqueId === output.vm.uniqueId &&
      binding.principalId === output.vm.principalId &&
      binding.diskUniqueId === output.vm.dataDiskUniqueId &&
      binding.ipv4 === output.vm.ipv4 &&
      binding.fqdn === output.vm.fqdn &&
      state.fsUuid === SCUS_PROFILE.sourcePreservation.fsUuid &&
      ['vmUniqueId', 'principalId', 'diskUniqueId', 'osDiskUniqueId'].every(
        (key) => uuid.test(binding[key] ?? ''),
      ),
    'Source archive does not establish the complete original VM/disk/filesystem/parameter bindings.',
  );
  const lineage = {
    profileId: ORIGINAL_PROFILE.id,
    vmId: binding.vmId,
    vmUniqueId: binding.vmUniqueId,
    principalId: binding.principalId,
    tenantId: binding.tenantId,
    osDiskId: binding.osDiskId,
    osDiskUniqueId: binding.osDiskUniqueId,
    dataDiskId: binding.diskId,
    dataDiskUniqueId: binding.diskUniqueId,
    parametersHash: state.parametersHash,
    fsUuid: state.fsUuid,
  };
  return { state, parameters, output, lineage };
}

export function assertMigrationState(state, profile) {
  assertProfile(profile);
  requirePilot(
    profile === SCUS_PROFILE &&
      state?.version === 3 &&
      state.profileId === profile.id &&
      uuid.test(state.migrationId ?? '') &&
      state.source?.profileId === ORIGINAL_PROFILE.id &&
      state.source.guestManifest === 'unavailable' &&
      state.source.shutdownCleanliness === 'unknown' &&
      isDeepStrictEqual(
        Object.keys(state).sort(),
        ['version', 'profileId', 'migrationId', 'source', 'stages'].sort(),
      ) &&
      isDeepStrictEqual(
        Object.keys(state.source.files ?? {}).sort(),
        [...sourceFiles].sort(),
      ) &&
      sourceFiles.every(
        (name) =>
          hash.test(state.source.files[name]?.sha256 ?? '') &&
          Number.isInteger(state.source.files[name].bytes) &&
          state.source.files[name].bytes > 0,
      ) &&
      state.source.archiveSha256 === hashObject(state.source.files) &&
      state.source.lineage?.vmId === profile.sourcePreservation.vmId &&
      state.source.lineage.fsUuid === profile.sourcePreservation.fsUuid &&
      state.stages &&
      Object.keys(state.stages).every((stage) =>
        Object.hasOwn(profile.stages, stage),
      ),
    'Missing, foreign or transplanted migration state; only version3 with original source lineage is allowed.',
  );
  return state;
}

async function directory(path, privateMode) {
  const info = await lstat(path);
  requirePilot(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (privateMode ? (info.mode & 0o777) === 0o700 : (info.mode & 0o022) === 0),
    'Migration directories must be owned, non-symlink and non-writable by other users; private leaves require0700.',
  );
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const after = await handle.stat();
    requirePilot(
      after.dev === info.dev && after.ino === info.ino,
      'Migration directory changed while opening.',
    );
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
const at = (directory, name) => `/proc/self/fd/${directory.fd}/${name}`;
async function bytes(path, optional = false) {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    requirePilot(
      info.isFile() &&
        info.uid === process.getuid() &&
        (info.mode & 0o777) === 0o600 &&
        info.nlink === 1 &&
        info.size > 0 &&
        info.size <= 1_000_000,
      'Migration inputs must be private owner-only0600 regular files, not links or oversized artifacts.',
    );
    return await file.readFile();
  } catch (error) {
    if (optional && error.code === 'ENOENT') return;
    throw error;
  } finally {
    await file?.close();
  }
}
async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function verifyArchiveFile(file, paths, expected, links, prefix = false) {
  const info = await file.stat();
  requirePilot(
    info.isFile() &&
      info.uid === process.getuid() &&
      (info.mode & 0o777) === 0o600 &&
      info.nlink === links &&
      info.size <= expected.length &&
      (prefix || info.size === expected.length),
    'Archive publication has unsafe metadata, unknown links or conflicting length; retain every path.',
  );
  const stablePaths = async () => {
    for (const path of paths)
      requirePilot(
        sameInode(await lstat(path), info),
        'Archive publication path changed; retain every path.',
      );
  };
  await stablePaths();
  const actual = Buffer.alloc(info.size);
  for (let offset = 0; offset < actual.length;) {
    const { bytesRead } = await file.read(
      actual,
      offset,
      actual.length - offset,
      offset,
    );
    requirePilot(
      bytesRead > 0,
      'Archive publication content changed while reading.',
    );
    offset += bytesRead;
  }
  const after = await file.stat();
  requirePilot(
    sameInode(after, info) &&
      after.size === info.size &&
      after.nlink === info.nlink &&
      after.uid === info.uid &&
      after.mode === info.mode &&
      after.mtimeMs === info.mtimeMs &&
      after.ctimeMs === info.ctimeMs &&
      actual.equals(expected.subarray(0, actual.length)),
    'Archive publication bytes changed or are not the exact planned prefix; retain every path.',
  );
  await stablePaths();
  return actual.length;
}

async function publishArchive(archive, state, name, expected) {
  requirePilot(
    sourceFiles.includes(name) &&
      uuid.test(state.migrationId) &&
      expected.length === state.source.files[name].bytes &&
      sha256(expected) === state.source.files[name].sha256,
    'Archive publication must match the exact durable archive intent.',
  );
  const final = at(archive, name);
  const staging = at(archive, `.${name}.${state.migrationId}.tmp`);
  const hasFinal = !(await absent(final)),
    hasStaging = !(await absent(staging));
  const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
  if (hasFinal && !hasStaging) {
    const file = await open(final, constants.O_RDONLY | flags);
    try {
      await verifyArchiveFile(file, [final], expected, 1);
      await file.sync();
      await archive.sync();
      await verifyArchiveFile(file, [final], expected, 1);
    } finally {
      await file.close();
    }
  } else {
    const file = await open(
      staging,
      constants.O_RDWR |
        flags |
        (hasStaging ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    try {
      if (!hasFinal) {
        const length = await verifyArchiveFile(
          file,
          [staging],
          expected,
          1,
          true,
        );
        for (let offset = length; offset < expected.length;) {
          const { bytesWritten } = await file.write(
            expected,
            offset,
            expected.length - offset,
            offset,
          );
          requirePilot(
            bytesWritten > 0,
            'Archive publication made no write progress; retain its planned staging file.',
          );
          offset += bytesWritten;
        }
        await verifyArchiveFile(file, [staging], expected, 1);
        await file.sync();
        await verifyArchiveFile(file, [staging], expected, 1);
        await link(staging, final); // Exclusive publication: never replace an existing final path.
      } else {
        await verifyArchiveFile(file, [staging, final], expected, 2);
        await file.sync();
      }
      await verifyArchiveFile(file, [staging, final], expected, 2);
      await archive.sync();
      await verifyArchiveFile(file, [staging, final], expected, 2);
      await unlink(staging);
      await archive.sync();
      await verifyArchiveFile(file, [final], expected, 1);
    } finally {
      await file.close();
    }
  }
  requirePilot(
    (await absent(staging)) && (await bytes(final)).equals(expected),
    'Published archive is not the exact single-link final file; retain every path.',
  );
}

// Root is fixed by the CLI; tests supply a synthetic repository. All active I/O is through held directory descriptors.
export async function openMigrationStore(profile, root) {
  assertProfile(profile);
  requirePilot(profile === SCUS_PROFILE, 'Migration store is target-only.');
  root = resolve(root);
  requirePilot(
    (await realpath(root)) === root,
    'Repository path cannot traverse symlinks.',
  );
  const parentPath = join(root, 'artifacts');
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parent = await directory(parentPath, false);
  let target, lock;
  try {
    const leaf = profile.artifacts.directory.split('/').at(-1);
    await mkdir(at(parent, leaf), { recursive: true, mode: 0o700 });
    target = await directory(at(parent, leaf), true);
    try {
      lock = await open(at(target, 'operator.lock'), 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new PilotError(
        'Migration operator lock already exists; investigate the active/interrupted operator. No force or stale-lock deletion is provided.',
      );
    }
    const lockIdentity = await lock.stat();
    const allowed = new Set([
      'migration-state.json',
      ...Object.keys(profile.stages).flatMap((stage) => [
        `${stage}-template.json`,
        `${stage}-parameters.json`,
        `${stage}-validation.json`,
        `${stage}-review.json`,
      ]),
    ]);
    const path = (name) => {
      requirePilot(allowed.has(name), 'Unrecognized migration artifact.');
      return at(target, name);
    };
    const readState = async () => {
      const raw = await bytes(path('migration-state.json'), true);
      return raw ? assertMigrationState(JSON.parse(raw), profile) : undefined;
    };
    let poisoned = false;
    const save = async (value) => {
      requirePilot(
        !poisoned,
        'Migration durability is uncertain; reload the retained journal.',
      );
      assertMigrationState(value, profile);
      try {
        await writePrivate(path('migration-state.json'), encode(value));
      } catch {
        poisoned = true;
        throw new PilotError(
          'Migration journal durability failed; retain all facts and reload, never resubmit.',
        );
      }
    };
    const readOriginal = async () => {
      const source = await directory(
        at(parent, ORIGINAL_PROFILE.artifacts.directory.split('/').at(-1)),
        true,
      );
      try {
        requirePilot(
          await absent(at(source, 'operator.lock')),
          'Original operator lock exists; source inputs cannot be archived concurrently.',
        );
        const files = Object.fromEntries(
          await Promise.all(
            sourceFiles.map(async (name) => [
              name,
              await bytes(at(source, name)),
            ]),
          ),
        );
        requirePilot(
          await absent(at(source, 'operator.lock')),
          'Original operator became active during archival.',
        );
        for (const name of sourceFiles)
          requirePilot(
            (await bytes(at(source, name))).equals(files[name]),
            'Original operator inputs changed during archival.',
          );
        return files;
      } finally {
        await source.close();
      }
    };
    const loadArchive = async (state) => {
      const archive = await directory(at(target, 'source'), true);
      try {
        const files = Object.fromEntries(
          await Promise.all(
            sourceFiles.map(async (name) => [
              name,
              await bytes(at(archive, name)),
            ]),
          ),
        );
        requirePilot(
          sourceFiles.every(
            (name) =>
              sha256(files[name]) === state.source.files[name].sha256 &&
              files[name].length === state.source.files[name].bytes,
          ),
          'Source archive bytes changed; no rebinding.',
        );
        const inputs = archiveInputs(files);
        requirePilot(
          isDeepStrictEqual(inputs.lineage, state.source.lineage),
          'Archived original identity lineage changed.',
        );
        return inputs;
      } finally {
        await archive.close();
      }
    };
    return {
      path,
      readState,
      save,
      loadArchive,
      deploymentPath: (name) =>
        path(name).replace('/proc/self/', `/proc/${process.pid}/`),
      read: async (name) => JSON.parse(await bytes(path(name))),
      readBytes: (name) => bytes(path(name)),
      write: async (name, value) =>
        writePrivate(
          path(name),
          typeof value === 'string' ? value : encode(value),
        ),
      prepare: async () => {
        const files = await readOriginal();
        const inputs = archiveInputs(files);
        const identities = Object.fromEntries(
          sourceFiles.map((name) => [
            name,
            { sha256: sha256(files[name]), bytes: files[name].length },
          ]),
        );
        let state = await readState();
        if (state)
          requirePilot(
            isDeepStrictEqual(state.source.files, identities) &&
              isDeepStrictEqual(state.source.lineage, inputs.lineage),
            'Prepared source archive cannot be rebound to changed original inputs.',
          );
        else {
          state = {
            version: 3,
            profileId: profile.id,
            migrationId: randomUUID(),
            source: {
              profileId: ORIGINAL_PROFILE.id,
              files: identities,
              archiveSha256: hashObject(identities),
              lineage: inputs.lineage,
              guestManifest: 'unavailable',
              shutdownCleanliness: 'unknown',
            },
            stages: {},
          };
          await save(state); // Durable archive intent before publishing any archive file.
        }
        await mkdir(at(target, 'source'), { recursive: true, mode: 0o700 });
        const archive = await directory(at(target, 'source'), true);
        try {
          for (const name of sourceFiles)
            await publishArchive(archive, state, name, files[name]);
          await syncDirectory(at(target, 'source'));
          await syncDirectory(`/proc/self/fd/${target.fd}`);
        } finally {
          await archive.close();
        }
        await loadArchive(state);
        return state;
      },
      close: async () => {
        try {
          const current = await lstat(at(target, 'operator.lock'));
          requirePilot(
            current.isFile() &&
              current.dev === lockIdentity.dev &&
              current.ino === lockIdentity.ino,
            'Migration lock was replaced; do not remove another operation lock.',
          );
          await unlink(at(target, 'operator.lock'));
        } finally {
          await lock.close();
          await target.close();
          await parent.close();
        }
      },
    };
  } catch (error) {
    if (lock) {
      await lock.close();
      await unlink(at(target, 'operator.lock'));
    }
    await target?.close();
    await parent.close();
    throw error;
  }
}
