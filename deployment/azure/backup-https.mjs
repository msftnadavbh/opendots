import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, lstat, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PilotError, requirePilot, validateOutputs } from './scope.mjs';
import {
  readPrivate,
  parseEnv,
  validateRuntimeEnv,
  syncDirectory,
} from './runtime-env.mjs';
import { manifest } from './sqlite-backup.mjs';

const maxBytes = 32 * 1024 * 1024;
function responseManifest(value) {
  requirePilot(
    typeof value === 'string' && value.length > 0 && value.length <= 8192,
    'Invalid backup manifest.',
  );
  const bytes = Buffer.from(value, 'base64');
  requirePilot(bytes.toString('base64') === value, 'Invalid backup manifest.');
  const result = JSON.parse(bytes.toString('utf8'));
  requirePilot(
    result &&
      !Array.isArray(result) &&
      Object.keys(result).sort().join(',') === 'integrity,tables' &&
      result.integrity === 'ok',
    'Invalid backup manifest.',
  );
  requirePilot(
    result.tables &&
      typeof result.tables === 'object' &&
      !Array.isArray(result.tables),
    'Invalid backup manifest.',
  );
  const entries = Object.entries(result.tables);
  requirePilot(
    entries.length > 0 && entries.length <= 64,
    'Invalid backup manifest.',
  );
  for (const [name, table] of entries) {
    requirePilot(
      /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) &&
        !['__proto__', 'constructor', 'prototype'].includes(name),
      'Invalid backup manifest.',
    );
    requirePilot(
      table &&
        !Array.isArray(table) &&
        Object.keys(table).sort().join(',') === 'records,sha256' &&
        Number.isSafeInteger(table.records) &&
        table.records >= 0 &&
        /^[a-f0-9]{64}$/.test(table.sha256),
      'Invalid backup manifest.',
    );
  }
  return result;
}

// The operator verifies these owned outputs and immutable VM bindings live before calling.
export async function backupHttps({
  output,
  privatePath,
  directory,
  signal,
  request = fetch,
}) {
  let response;
  try {
    signal?.throwIfAborted();
    validateOutputs(output);
    const env = validateRuntimeEnv(parseEnv(await readPrivate(privatePath)));
    const origin = env.APP_ORIGIN,
      ownerToken = env.OWNER_TOKEN;
    requirePilot(
      origin === `https://${output.vm.fqdn}`,
      'Backup configuration differs from the owned VM origin.',
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
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(600_000)])
      : AbortSignal.timeout(600_000);
    const url = origin + '/api/backup';
    response = await request(url, {
      method: 'POST',
      redirect: 'error',
      signal: deadline,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        Origin: origin,
        'Content-Type': 'application/json',
        Accept: 'application/octet-stream',
      },
      body: '{}',
    });
    requirePilot(
      response.ok &&
        response.status === 200 &&
        !response.redirected &&
        response.url === url &&
        response.body,
      'Backup response failed.',
    );
    requirePilot(
      response.headers.get('content-type')?.toLowerCase() ===
        'application/octet-stream' &&
        /(?:^|,)\s*no-store\s*(?:,|$)/i.test(
          response.headers.get('cache-control') ?? '',
        ) &&
        /^attachment(?:;|$)/i.test(
          response.headers.get('content-disposition') ?? '',
        ),
      'Unexpected backup response.',
    );
    const length = response.headers.get('content-length');
    requirePilot(
      /^[1-9][0-9]{0,7}$/.test(length ?? ''),
      'Invalid backup length.',
    );
    const expectedBytes = Number(length),
      expectedHash = response.headers.get('x-opendots-backup-sha256');
    requirePilot(
      expectedBytes <= maxBytes && /^[a-f0-9]{64}$/.test(expectedHash ?? ''),
      'Invalid backup bounds.',
    );
    const reported = responseManifest(
      response.headers.get('x-opendots-backup-manifest'),
    );
    const destination = join(directory, `backup-${randomUUID()}.sqlite`),
      partial = destination + '.partial';
    let size = 0;
    const hash = createHash('sha256');
    const bounded = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > expectedBytes)
          return callback(new Error('Backup exceeds its declared bound.'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      bounded,
      createWriteStream(partial, { flags: 'wx', mode: 0o600, flush: true }),
      { signal: deadline },
    );
    requirePilot(
      size === expectedBytes && hash.digest('hex') === expectedHash,
      'Backup transfer differs.',
    );
    requirePilot(
      JSON.stringify(manifest(partial)) === JSON.stringify(reported),
      'Backup integrity or records differ.',
    );
    // Keep the existing durable manifest-before-exclusive-file-publication contract.
    const metadataPath = destination + '.manifest.json';
    const metadata = await open(metadataPath, 'wx', 0o600);
    let published = false;
    try {
      await metadata.writeFile(JSON.stringify(reported, null, 2));
      await metadata.sync();
      await metadata.close();
      await syncDirectory(directory);
      await link(partial, destination);
      published = true;
    } finally {
      await metadata.close();
      if (!published) await unlink(metadataPath);
    }
    await unlink(partial);
    await syncDirectory(directory);
    return destination;
  } catch {
    await response?.body?.cancel().catch(() => {});
    throw new PilotError(
      'HTTPS backup failed; any private partial file is retained. No unverified backup was reported as successful.',
    );
  }
}
