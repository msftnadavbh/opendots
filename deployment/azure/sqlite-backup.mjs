import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function manifest(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      JSON.stringify(db.prepare('PRAGMA integrity_check').all()) !==
      '[{"integrity_check":"ok"}]'
    )
      throw new Error('Backup integrity check failed');
    const tables = {};
    for (const { name, sql } of db
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()) {
      const statement = db.prepare(
        `SELECT * FROM "${String(name).replaceAll('"', '""')}"`,
      );
      statement.setReadBigInts(true);
      const rows = [];
      for (const row of statement.iterate()) {
        const values = Object.entries(row).map(([key, value]) => [
          key,
          value instanceof Uint8Array
            ? ['blob', Buffer.from(value).toString('base64')]
            : typeof value === 'bigint'
              ? ['integer', String(value)]
              : [typeof value, value],
        ]);
        rows.push(
          createHash('sha256').update(JSON.stringify(values)).digest('hex'),
        );
      }
      tables[name] = {
        records: rows.length,
        sha256: createHash('sha256')
          .update(String(sql))
          .update(rows.sort().join(''))
          .digest('hex'),
      };
    }
    return { integrity: 'ok', tables };
  } finally {
    db.close();
  }
}

export async function consistentBackup(source, destination) {
  if (resolve(source) === resolve(destination))
    throw new Error('Backup destination must be separate');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  // Reserve a private, new empty file; VACUUM INTO will not overwrite an existing backup.
  const file = await open(destination, 'wx', 0o600);
  await file.close();
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare('VACUUM INTO ?').run(destination);
  } finally {
    db.close();
  }
  await chmod(destination, 0o600);
  return manifest(destination);
}

export async function verifyRestore(source, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(
    directory,
    `restore-verification-${randomUUID()}.sqlite`,
  );
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  const before = manifest(source),
    after = manifest(destination);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Restored records or photos differ');
  return { destination, ...after };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.umask(0o077);
  if (process.getuid() === 0) {
    process.setgroups([]);
    process.setgid(1000);
    process.setuid(1000);
  }
  const [source, destination] = process.argv.slice(2);
  consistentBackup(source, destination)
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error('SQLite backup failed; details suppressed.');
      process.exitCode = 1;
    });
}
