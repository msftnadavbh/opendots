import {
  ManagedIdentityCredential,
  getBearerTokenProvider,
} from '@azure/identity';

export type ModelCredential = string | (() => Promise<string>);

export function modelCredentialFromEnv(
  env: Record<string, string | undefined>,
): ModelCredential | undefined {
  const mode = env.OPENAI_AUTH_MODE?.trim() || 'api-key';
  if (mode === 'api-key') return env.OPENAI_API_KEY;
  if (mode !== 'managed-identity')
    throw new Error('OPENAI_AUTH_MODE must be api-key or managed-identity.');
  if (env.OPENAI_API_KEY)
    throw new Error(
      'OPENAI_API_KEY must be empty when OPENAI_AUTH_MODE is managed-identity.',
    );
  const baseUrl = env.OPENAI_BASE_URL ?? '';
  if (
    baseUrl !== baseUrl.trim() ||
    !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.openai\.azure\.com\/openai\/v1\/?$/.test(
      baseUrl,
    )
  )
    throw new Error(
      'Managed identity requires OPENAI_BASE_URL=https://<account>.openai.azure.com/openai/v1.',
    );
  const tokenProvider = getBearerTokenProvider(
    new ManagedIdentityCredential(),
    'https://ai.azure.com/.default',
  );
  return async () => {
    try {
      const token = await tokenProvider();
      if (typeof token !== 'string' || !token) throw new Error();
      return token;
    } catch {
      // Identity errors can contain credential or endpoint response details.
      throw new Error('Managed identity model authentication failed.');
    }
  };
}
