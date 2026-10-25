import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseEnv, readPrivate, validateRuntimeEnv } from './runtime-env.mjs';

export async function stopChild(child, graceMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

export async function supervise({
  readConfiguration,
  launch,
  signal,
  pause = (ms) => delay(ms, undefined, { signal }),
}) {
  let child, previous;
  const stop = () => child?.kill('SIGTERM');
  signal.addEventListener('abort', stop);
  try {
    while (!signal.aborted) {
      let config;
      try {
        config = await readConfiguration();
      } catch {
        /* Never print configuration or parser errors. */
      }
      if (child && (child.exitCode !== null || child.signalCode)) {
        child = undefined;
      }
      if (child && (!config || config.revision !== previous)) {
        await stopChild(child);
        child = undefined;
      }
      if (config && !child && !signal.aborted) {
        child = launch(config.env);
        // Spawn errors must not bypass supervision or print the child environment.
        child.on('error', () => {
          child = undefined;
        });
        previous = config.revision;
      }
      if (!signal.aborted) await pause(3000);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', stop);
    await stopChild(child);
  }
}

async function main() {
  process.umask(0o077);
  // The service may launch the entrypoint as root; the app and supervisor never stay root.
  if (process.getuid() === 0) {
    process.setgroups([]);
    process.setgid(1000);
    process.setuid(1000);
  }
  if (process.getuid() !== 1000) throw new Error('Unexpected runtime user');
  process.chdir('/app');
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  await supervise({
    signal: controller.signal,
    readConfiguration: async () => {
      const paused = await stat('/data/pause.request').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (paused) return undefined;
      const text = await readPrivate('/data/runtime.env', { uid: 1000 });
      const env = validateRuntimeEnv(parseEnv(text));
      const restart = await stat('/data/restart.request').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      return {
        env,
        revision: createHash('sha256')
          .update(text)
          .update(String(restart?.mtimeMs ?? 0))
          .digest('hex'),
      };
    },
    launch: (env) =>
      spawn(process.execPath, ['dist/server/server/index.js'], {
        cwd: '/app',
        stdio: 'inherit',
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: '/home/node',
          ...env,
        },
      }),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Azure startup failed; details suppressed.');
    process.exitCode = 1;
  });
