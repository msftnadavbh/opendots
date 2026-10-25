import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { parseEnv } from 'node:util';
import {
  requirePilot,
  validateInsightsConnectionString,
  validatePortUrl,
  MODEL_ENDPOINT,
} from './scope.mjs';

const fixed = Object.freeze({
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  PORT: '4310',
  DATABASE_PATH: '/data/opendots.sqlite',
  OPENAI_MODEL: 'dot-chat',
  OPENAI_AUTH_MODE: 'managed-identity',
  DO_NOT_TRACK: '1',
  COPILOTKIT_TELEMETRY_DISABLED: '1',
  WEB_SEARCH_PROVIDER: 'disabled',
});
const keys = [
  ...Object.keys(fixed),
  'OWNER_ID',
  'OWNER_TOKEN',
  'CPK_INTELLIGENCE_API_KEY',
  'OPENAI_BASE_URL',
  'APP_ORIGIN',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
];

export function validateRuntimeEnv(env) {
  requirePilot(
    Object.keys(env).length === keys.length &&
      keys.every(
        (key) =>
          typeof env[key] === 'string' &&
          env[key].length > 0 &&
          env[key].length <= 8192 &&
          !/[\x00-\x1f\x7f']/.test(env[key]),
      ),
    'Runtime configuration contains missing, unsupported or unsafe values.',
  );
  requirePilot(
    Object.entries(fixed).every(([key, value]) => env[key] === value),
    'Runtime configuration changes a fixed pilot setting.',
  );
  requirePilot(
    /^[A-Za-z0-9_-]{43}$/.test(env.OWNER_TOKEN),
    'Pilot OWNER_TOKEN must be a stable 43-character base64url token; refusing automatic rotation.',
  );
  requirePilot(
    /^[A-Za-z0-9_.:@-]{1,128}$/.test(env.OWNER_ID),
    'Invalid stable owner identity.',
  );
  requirePilot(
    env.OPENAI_BASE_URL === MODEL_ENDPOINT,
    'Unexpected pilot model endpoint.',
  );
  validatePortUrl(env.APP_ORIGIN);
  validateInsightsConnectionString(env.APPLICATIONINSIGHTS_CONNECTION_STRING);
  return env;
}
export function makeRuntimeEnv(source, previous, outputs, origin) {
  requirePilot(
    outputs.modelAuthMode === 'managed-identity' &&
      outputs.modelEndpoint === MODEL_ENDPOINT &&
      origin === `https://${outputs.vm?.fqdn}`,
    'Runtime origin and managed-identity model endpoint must match validated live VM outputs.',
  );
  const ownerId =
    previous?.OWNER_ID ?? (source.OWNER_ID?.trim() || 'opendots-owner');
  const ownerToken =
    previous?.OWNER_TOKEN ??
    (source.OWNER_TOKEN?.trim() || randomBytes(32).toString('base64url'));
  requirePilot(
    (!previous ||
      !source.OWNER_ID?.trim() ||
      source.OWNER_ID.trim() === previous.OWNER_ID) &&
      (!previous ||
        !source.OWNER_TOKEN?.trim() ||
        source.OWNER_TOKEN.trim() === previous.OWNER_TOKEN),
    'Source owner identity or token conflicts with the saved pilot configuration; refusing rotation.',
  );
  const intelligenceKey =
    source.CPK_INTELLIGENCE_API_KEY?.trim() ||
    source.INTELLIGENCE_API_KEY?.trim();
  requirePilot(
    !previous || previous.CPK_INTELLIGENCE_API_KEY === intelligenceKey,
    'Intelligence project changed; preserve the pilot project and conversation ownership.',
  );
  return validateRuntimeEnv({
    ...fixed,
    OWNER_ID: ownerId,
    OWNER_TOKEN: ownerToken,
    CPK_INTELLIGENCE_API_KEY: intelligenceKey,
    OPENAI_BASE_URL: outputs.modelEndpoint,
    APP_ORIGIN: validatePortUrl(origin),
    APPLICATIONINSIGHTS_CONNECTION_STRING:
      outputs.applicationInsightsConnectionString,
  });
}
export function encodeRuntimeEnv(env) {
  validateRuntimeEnv(env);
  const text = keys.map((key) => `${key}='${env[key]}'`).join('\n') + '\n';
  const parsed = parseEnv(text);
  requirePilot(
    keys.every((key) => parsed[key] === env[key]),
    'Runtime environment did not round-trip safely.',
  );
  return Buffer.from(text);
}
export async function readPrivate(
  path,
  { optional = false, uid = process.getuid(), privateMode = true } = {},
) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    requirePilot(
      stat.isFile() &&
        stat.size <= 1_000_000 &&
        (!privateMode || ((stat.mode & 0o777) === 0o600 && stat.uid === uid)),
      'Private configuration must be a regular owner-only file (0600).',
    );
    return await file.readFile('utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}
export async function writePrivate(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
    await file.close();
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await file.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function syncDirectory(path) {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export { parseEnv };
