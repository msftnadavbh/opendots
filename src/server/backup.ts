import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  statfs,
  type FileHandle,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';

// shortcut: the 64MiB pilot tmpfs supports only 32MiB snapshots; larger data needs reviewed storage.
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const PREFIX = 'opendots-backup-';
const COOLDOWN_MS = 30_000;
const LIFETIME_MS = 60_000;
const sha256 = /^[a-f0-9]{64}$/;

export function backupMetadata(text: string) {
  const value = JSON.parse(text);
  if (
    Object.keys(value).sort().join() !== 'manifest,sha256,size' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 512 ||
    value.size > MAX_BACKUP_BYTES ||
    typeof value.sha256 !== 'string' ||
    !sha256.test(value.sha256) ||
    typeof value.manifest !== 'string' ||
    Buffer.byteLength(value.manifest) > 8192
  )
    throw new Error('Invalid backup metadata');
  const manifest = JSON.parse(
    Buffer.from(value.manifest, 'base64').toString('utf8'),
  );
  if (
    Buffer.from(JSON.stringify(manifest)).toString('base64') !==
      value.manifest ||
    Object.keys(manifest).join() !== 'integrity,tables' ||
    manifest.integrity !== 'ok' ||
    !manifest.tables ||
    typeof manifest.tables !== 'object' ||
    Array.isArray(manifest.tables)
  )
    throw new Error('Invalid backup manifest');
  for (const table of Object.values(manifest.tables) as Record<
    string,
    unknown
  >[]) {
    if (
      !table ||
      Object.keys(table).join() !== 'records,sha256' ||
      !Number.isSafeInteger(table.records) ||
      (table.records as number) < 0 ||
      typeof table.sha256 !== 'string' ||
      !sha256.test(table.sha256)
    )
      throw new Error('Invalid backup manifest');
  }
  return value as { size: number; sha256: string; manifest: string };
}

async function scratchReady() {
  const info = await statfs('/tmp');
  if (
    (await lstat('/tmp')).isSymbolicLink() ||
    info.type !== 0x01021994 ||
    info.bsize * info.blocks !== 64 * 1024 * 1024 ||
    info.bsize * info.bavail < MAX_BACKUP_BYTES ||
    (await readdir('/tmp')).some((name) => name.startsWith(PREFIX))
  )
    throw new Error('Backup scratch unavailable');
}

class BackupJob {
  private child?: ChildProcessWithoutNullStreams;
  private closed?: Promise<void>;
  private directory?: string;
  private file?: FileHandle;
  private cancelled = false;
  private childClosed = false;
  private finishing?: Promise<void>;
  private timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  private controller = new AbortController();

  constructor(private requestSignal: AbortSignal) {
    this.signal = this.controller.signal;
    requestSignal.addEventListener('abort', this.cancel, { once: true });
    this.timer = setTimeout(this.cancel, LIFETIME_MS);
    if (requestSignal.aborted) this.cancel();
  }

  cancel = () => {
    this.cancelled = true;
    this.controller.abort();
    if (this.child?.pid && !this.childClosed) {
      try {
        // A detached guardian owns this process group; never signal an unrelated PID/group.
        process.kill(-this.child.pid, 'SIGKILL');
      } catch {
        // Cleanup still awaits actual close; the independent guardian bounds a failed signal.
      }
    }
  };

  async prepare(source: string) {
    this.signal.throwIfAborted();
    await scratchReady();
    const sourceInfo = await lstat(source);
    if (
      !sourceInfo.isFile() ||
      (await realpath(source)) !== source ||
      sourceInfo.size > MAX_BACKUP_BYTES
    )
      throw new Error('Backup source unavailable');
    this.directory = await mkdtemp(`/tmp/${PREFIX}`);
    const directoryInfo = await lstat(this.directory);
    if (
      (directoryInfo.mode & 0o777) !== 0o700 ||
      directoryInfo.uid !== process.getuid?.()
    )
      throw new Error('Backup directory unavailable');
    this.signal.throwIfAborted();
    const destination = join(this.directory, 'snapshot.sqlite');
    const child = spawn(
      '/bin/bash',
      [
        resolve('deployment/azure/export-guardian.sh'),
        this.directory,
        process.execPath,
        '--jitless',
        '--max-old-space-size=128',
        '--max-semi-space-size=8',
        resolve('deployment/azure/export-backup.mjs'),
        source,
        destination,
      ],
      {
        detached: true,
        cwd: this.directory,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          TMPDIR: this.directory,
          SQLITE_TMPDIR: this.directory,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    child.stdin.on('error', () => {});
    this.closed = new Promise((done) =>
      child.once('close', () => {
        this.childClosed = true;
        done();
      }),
    );
    const result = await new Promise<string>((done, fail) => {
      let output = '';
      let bytes = 0;
      let complete = false;
      const failed = () => fail(new Error('Backup worker failed'));
      child.once('error', failed);
      child.once('close', failed);
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16_384) {
          this.cancel();
          failed();
        }
      });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (complete || bytes > 16_384 || output.length + chunk.length > 9000) {
          this.cancel();
          failed();
          return;
        }
        output += chunk.toString('utf8');
        if (output.endsWith('\n')) {
          complete = true;
          done(output);
        }
      });
      if (this.cancelled) this.cancel();
    });
    this.signal.throwIfAborted();
    const metadata = backupMetadata(result);
    this.file = await open(
      destination,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = await this.file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size !== metadata.size
    )
      throw new Error('Backup file unavailable');
    this.signal.throwIfAborted();
    return { metadata, file: this.file };
  }

  finish() {
    return (this.finishing ??= this.cleanup());
  }

  private async cleanup() {
    // The caller has closed the file stream before this point.
    try {
      await this.file?.close();
    } finally {
      if (this.child) {
        if (this.cancelled) this.cancel();
        else this.child.stdin.end();
        // 'error'/AbortError is not proof of termination; only 'close' permits cleanup/unlock.
        await this.closed;
      }
    }
    clearTimeout(this.timer);
    this.requestSignal.removeEventListener('abort', this.cancel);
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true });
  }
}

export function backupRoutes(options: {
  ownerToken?: string;
  origin?: string | string[];
  databasePath?: string;
}) {
  const app = new Hono();
  const source = options.databasePath
    ? resolve(options.databasePath)
    : undefined;
  const origins = new Set(
    options.origin
      ? Array.isArray(options.origin)
        ? options.origin
        : [options.origin]
      : [],
  );
  let active = false;
  let blocked = false;
  let nextAllowed = 0;
  let attempts = 0;
  app.all('/backup', async (c) => {
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return c.json({ error: 'Use POST.' }, 405);
    }
    const authorization = c.req.header('authorization') ?? '';
    const expected = Buffer.from(`Bearer ${options.ownerToken ?? ''}`);
    const supplied = Buffer.from(authorization);
    if (
      !options.ownerToken ||
      !authorization.startsWith('Bearer ') ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return c.json({ error: 'Owner bearer authorization is required.' }, 401);
    const origin = c.req.header('origin');
    if (!origin || !origins.has(origin))
      return c.json({ error: 'A configured Origin is required.' }, 403);
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      Array.isArray(body) ||
      typeof body !== 'object' ||
      Object.keys(body).length
    )
      return c.json({ error: 'Use an empty JSON object.' }, 400);
    if (!source || blocked)
      return c.json({ error: 'Backup unavailable.' }, 503);
    if (active) return c.json({ error: 'Backup already running.' }, 409);
    if (Date.now() < nextAllowed) {
      c.header(
        'Retry-After',
        String(Math.ceil((nextAllowed - Date.now()) / 1000)),
      );
      return c.json({ error: 'Backup cooldown active.' }, 429);
    }
    active = true;
    attempts++;
    const job = new BackupJob(c.req.raw.signal);
    const finish = async (outcome: 'complete' | 'failed') => {
      try {
        await job.finish();
      } catch {
        blocked = true;
        outcome = 'failed';
      }
      active = false;
      nextAllowed = Date.now() + COOLDOWN_MS;
      console.info('Backup export', { outcome, attempts });
    };
    try {
      const { metadata, file } = await job.prepare(source);
      c.header('Content-Type', 'application/octet-stream');
      c.header(
        'Content-Disposition',
        'attachment; filename="opendots-backup.sqlite"',
      );
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Content-Length', String(metadata.size));
      c.header('X-OpenDots-Backup-Sha256', metadata.sha256);
      c.header('X-OpenDots-Backup-Manifest', metadata.manifest);
      return stream(
        c,
        async (output) => {
          const input = file.createReadStream({ autoClose: false });
          const cancel = () => {
            input.destroy(new Error('Backup cancelled'));
            output.abort();
            job.cancel();
          };
          job.signal.addEventListener('abort', cancel, { once: true });
          output.onAbort(cancel);
          let outcome: 'complete' | 'failed' = 'failed';
          try {
            if (job.signal.aborted) cancel();
            await output.pipe(
              Readable.toWeb(input) as ReadableStream<Uint8Array>,
            );
            if (!job.signal.aborted) outcome = 'complete';
          } finally {
            job.signal.removeEventListener('abort', cancel);
            input.destroy();
            await new Promise<void>((done) => {
              if (input.closed) done();
              else input.once('close', done);
            });
            await finish(outcome);
          }
        },
        async () => {},
      );
    } catch {
      await finish('failed');
      return c.json({ error: 'Backup unavailable.' }, 503);
    }
  });
  return app;
}
