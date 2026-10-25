import {
  PULL_ACTIONS,
  TOKEN_NAME,
  requirePilot,
  PilotError,
} from './scope.mjs';

export function tokenExpiration(now = Date.now()) {
  return new Date(now + 55 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
export function assertExpiry(expiry, now = Date.now()) {
  const remaining = Date.parse(expiry) - now;
  requirePilot(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(
      expiry ?? '',
    ) &&
      remaining > 0 &&
      remaining <= 60 * 60_000,
    'Registry password expiry must be UTC and no more than one hour away.',
  );
}
export async function disableImportToken(az, output) {
  const args = [
    '--registry',
    output.registryName,
    '--resource-group',
    output.resourceGroup,
    '--name',
    TOKEN_NAME,
  ];
  // Both operations are safe to repeat; never treat a failed update as proof of revocation.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await az.write([
        'acr',
        'token',
        'update',
        ...args,
        '--status',
        'disabled',
      ]);
      const token = await az.read(['acr', 'token', 'show', ...args]);
      if (token.status === 'disabled') return;
    } catch {
      /* Retry revocation, not import or credential generation. */
    }
  }
  throw new PilotError(
    'ACR token revocation could not be verified. Run the token-disable command immediately; do not continue deployment.',
  );
}
export async function withImportToken(
  az,
  output,
  operation,
  now = () => Date.now(),
) {
  const args = [
    '--registry',
    output.registryName,
    '--resource-group',
    output.resourceGroup,
    '--name',
    TOKEN_NAME,
  ];
  const token = await az.read(['acr', 'token', 'show', ...args]);
  const scope = await az.read([
    'acr',
    'scope-map',
    'show',
    '--registry',
    output.registryName,
    '--resource-group',
    output.resourceGroup,
    '--name',
    output.scopeMapName,
  ]);
  requirePilot(
    token.status === 'disabled' &&
      token.scopeMapId ===
        `${output.registryId}/scopeMaps/${output.scopeMapName}` &&
      scope.id === token.scopeMapId &&
      JSON.stringify([...scope.actions].sort()) ===
        JSON.stringify([...PULL_ACTIONS].sort()) &&
      !token.credentials?.certificates?.length &&
      (token.credentials?.passwords ?? []).every(
        (password) =>
          password.name === 'password1' &&
          password.expiry &&
          Date.parse(password.expiry) - Date.parse(password.creationTime) <=
            60 * 60_000,
      ),
    'Import token must be disabled, repository-read-only, and have no certificate, password2 or unbounded credential. Inspect policy; do not override a deny.',
  );
  let credentials;
  try {
    const expiration = tokenExpiration(now());
    assertExpiry(expiration, now());
    credentials = await az.write([
      'acr',
      'token',
      'credential',
      'generate',
      ...args,
      '--password1',
      '--expiration',
      expiration,
    ]);
    requirePilot(
      credentials.username === TOKEN_NAME &&
        credentials.passwords?.length === 1 &&
        credentials.passwords[0].name === 'password1' &&
        typeof credentials.passwords[0].value === 'string' &&
        credentials.passwords[0].value.length > 0,
      'Unexpected registry credential response.',
    );
    assertExpiry(credentials.passwords[0].expiry, now());
    const enabled = await az.write([
      'acr',
      'token',
      'update',
      ...args,
      '--status',
      'enabled',
    ]);
    requirePilot(
      enabled?.status === 'enabled',
      'Registry import token was not enabled.',
    );
    return await operation({
      username: TOKEN_NAME,
      token: credentials.passwords[0].value,
    });
  } catch (error) {
    // SDK errors may retain the request body containing registry credentials.
    throw error instanceof PilotError
      ? error
      : new PilotError(
          'Private image import failed; provider details suppressed. Reconcile existing image state before retrying.',
        );
  } finally {
    credentials = undefined;
    await disableImportToken(az, output);
  }
}
