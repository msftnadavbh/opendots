import { cp, lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { requirePilot } from './scope.mjs';

// A positive allowlist, in addition to .dockerignore, keeps local credentials out of ACR uploads.
const entries = [
  'Dockerfile',
  '.dockerignore',
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.server.json',
  'src',
  'public',
  ...[
    'scope',
    'runtime-env',
    'start',
    'sqlite-backup',
    'vm-files',
    'export-backup',
  ].map((name) => `deployment/azure/${name}.mjs`),
  'deployment/azure/export-guardian.sh',
];
export async function stageBuild(root, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    await mkdir(dirname(join(destination, entry)), {
      recursive: true,
      mode: 0o700,
    });
    await cp(join(root, entry), join(destination, entry), {
      recursive: true,
      filter: async (source) => {
        const name = basename(source);
        requirePilot(
          !(await lstat(source)).isSymbolicLink(),
          'Symlinks are not allowed in the pilot build context.',
        );
        return (
          !/(?:^|\.)env(?:\.|$)/.test(name) &&
          !/^(?:\.env(?:\.|$)|runtime\.env|\.azure$|\.copilotkit$|\.opendots$|node_modules$|artifacts$|test-results$|playwright-report$)/.test(
            name,
          ) &&
          !/\.(?:sqlite.*|db.*|pem|key|log)$/.test(name)
        );
      },
    });
  }
}
