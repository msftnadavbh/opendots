import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { consistentBackup } from './sqlite-backup.mjs';

process.umask(0o077);
try {
  const [source, destination] = process.argv.slice(2);
  const manifest = await consistentBackup(source, destination);
  const { size } = await stat(destination);
  // shortcut: pilot exports are capped at 32MiB; review storage before supporting larger workspaces.
  if (size < 512 || size > 32 * 1024 * 1024) throw new Error();
  const encoded = Buffer.from(JSON.stringify(manifest)).toString('base64');
  if (Buffer.byteLength(encoded) > 8192) throw new Error();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  process.stdout.write(
    JSON.stringify({ size, sha256: hash.digest('hex'), manifest: encoded }) +
      '\n',
  );
} catch {
  // No raw SQLite errors, paths, table names, or payloads leave the worker.
  process.exitCode = 1;
}
