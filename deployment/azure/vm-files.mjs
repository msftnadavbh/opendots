import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import {
  readPrivate,
  writePrivate,
  parseEnv,
  validateRuntimeEnv,
  encodeRuntimeEnv,
} from './runtime-env.mjs';
import { consistentBackup } from './sqlite-backup.mjs';

// These operations run inside the restricted container as UID1000, never as host root.
export async function configureRuntime(directory, content) {
  if (content.length > 1_000_000)
    throw new Error('Configuration is too large.');
  const next = validateRuntimeEnv(parseEnv(content.toString()));
  const path = join(directory, 'runtime.env');
  const old = await readPrivate(path, { optional: true });
  if (old) {
    const previous = validateRuntimeEnv(parseEnv(old));
    for (const key of [
      'OWNER_ID',
      'OWNER_TOKEN',
      'CPK_INTELLIGENCE_API_KEY',
      'APP_ORIGIN',
      'OPENAI_BASE_URL',
    ])
      if (previous[key] !== next[key])
        throw new Error('Runtime identity differs.');
  }
  await writePrivate(path, encodeRuntimeEnv(next));
}

export async function backupDirectory(directory) {
  const path = join(directory, 'backups');
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error('Backup directory must be private and regular.');
  return path;
}

export async function streamBackup(path, output) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o600
    )
      throw new Error('Backup must be a private regular file.');
    await pipeline(file.createReadStream(), output);
  } finally {
    await file.close();
  }
}

async function main() {
  if (process.getuid() !== 1000)
    throw new Error('Container UID1000 is required.');
  const [command, name, ...extra] = process.argv.slice(2);
  if (command === 'configure' && !name) {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1_000_000) throw new Error('Configuration is too large.');
      chunks.push(chunk);
    }
    await configureRuntime('/data', Buffer.concat(chunks));
    return;
  }
  if (
    extra.length ||
    !['backup', 'download'].includes(command) ||
    !/^backup-[a-f0-9-]{36}\.sqlite$/.test(name ?? '')
  )
    throw new Error('Unsupported file operation.');
  const directory = await backupDirectory('/data');
  if (command === 'backup')
    console.log(
      JSON.stringify(
        await consistentBackup('/data/opendots.sqlite', join(directory, name)),
      ),
    );
  else await streamBackup(join(directory, name), process.stdout);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Private container file operation failed.');
    process.exitCode = 1;
  });
