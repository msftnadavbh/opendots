import { beforeEach, expect, it, vi } from 'vitest';
import { modelCredentialFromEnv } from '../src/server/model-auth.js';
import { setupStatus } from '../src/server/platform-config.js';
import { configured } from '../src/server/research.js';

const identity = vi.hoisted(() => ({
  construct: vi.fn(),
  token: vi.fn<() => Promise<string>>(),
  provider: vi.fn(),
}));
vi.mock('@azure/identity', () => ({
  ManagedIdentityCredential: class {
    constructor() {
      identity.construct();
    }
  },
  getBearerTokenProvider: identity.provider,
}));

const managed = {
  OPENAI_AUTH_MODE: 'managed-identity',
  OPENAI_BASE_URL:
    'https://ai-opendots-7unu3az5tgmza.openai.azure.com/openai/v1',
};
beforeEach(() => {
  vi.clearAllMocks();
  identity.token.mockReset();
  identity.provider.mockReturnValue(identity.token);
});

it.each([undefined, '', 'api-key'])('preserves API-key mode %s', (mode) => {
  expect(
    modelCredentialFromEnv({
      OPENAI_AUTH_MODE: mode,
      OPENAI_API_KEY: 'existing-key',
      OPENAI_BASE_URL: 'http://ordinary-compatible-provider/v1',
    }),
  ).toBe('existing-key');
  expect(modelCredentialFromEnv({ OPENAI_AUTH_MODE: mode })).toBeUndefined();
  expect(identity.construct).not.toHaveBeenCalled();
  expect(identity.provider).not.toHaveBeenCalled();
});

it('creates one managed identity and fixed-audience provider without acquiring a token at startup or setup', async () => {
  const credential = modelCredentialFromEnv(managed);
  expect(identity.construct).toHaveBeenCalledTimes(1);
  expect(identity.provider).toHaveBeenCalledExactlyOnceWith(
    expect.any(Object),
    'https://ai.azure.com/.default',
  );
  const config = {
    apiKey: credential,
    intelligenceKey: 'fixture',
    model: 'dot-chat',
    baseUrl: managed.OPENAI_BASE_URL,
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  };
  expect(setupStatus(config)).toMatchObject({ model: true, missing: [] });
  expect(setupStatus({ ...config, model: undefined }).missing).toEqual([
    'OPENAI_MODEL',
  ]);
  expect(setupStatus({ ...config, apiKey: undefined }).missing).toEqual([
    'OPENAI_API_KEY',
  ]);
  expect(configured({ ...config, mode: 'live' })).toBe(true);
  expect(identity.token).not.toHaveBeenCalled();
  expect(JSON.stringify(setupStatus(config))).not.toContain('apiKey');
  if (typeof credential !== 'function') throw new Error('Expected provider');
  identity.token.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
  expect(await credential()).toBe('first');
  expect(await credential()).toBe('second');
  expect(identity.construct).toHaveBeenCalledTimes(1);
  expect(identity.token).toHaveBeenCalledTimes(2);
});

it.each(['auto', 'default', 'Managed-Identity'])(
  'rejects unsupported mode %s',
  (mode) => {
    expect(() =>
      modelCredentialFromEnv({ ...managed, OPENAI_AUTH_MODE: mode }),
    ).toThrow('OPENAI_AUTH_MODE must be api-key or managed-identity.');
    expect(identity.construct).not.toHaveBeenCalled();
  },
);

it('rejects a static key in managed-identity mode without echoing it', () => {
  expect(() =>
    modelCredentialFromEnv({ ...managed, OPENAI_API_KEY: 'SECRET-key' }),
  ).toThrow(
    'OPENAI_API_KEY must be empty when OPENAI_AUTH_MODE is managed-identity.',
  );
  expect(identity.construct).not.toHaveBeenCalled();
});

it.each([
  undefined,
  '',
  'not-a-url',
  'http://account.openai.azure.com/openai/v1',
  'https://account.openai.azure.com.attacker.example/openai/v1',
  'https://account.openai.azure.com@attacker.example/openai/v1',
  'https://user:SECRET@account.openai.azure.com/openai/v1',
  'https://account.openai.azure.com:8443/openai/v1',
  'https://account.openai.azure.com/openai/v1?api-key=SECRET',
  'https://account.openai.azure.com/openai/v1#SECRET',
  'https://account.openai.azure.com/openai/deployments/dot-chat',
  'https://account.openai.azure.com/openai/v1/chat/completions',
  'https://account.openai.azure.com/openai/v1/../v1',
  'https://account.services.ai.azure.com/openai/v1',
  'https://-account.openai.azure.com/openai/v1',
  'https://account_.openai.azure.com/openai/v1',
  'https://account.openai.azure.com/openai/v1\n',
])(
  'rejects invalid managed-identity endpoint %s before creating a credential',
  (baseUrl) => {
    expect(() =>
      modelCredentialFromEnv({ ...managed, OPENAI_BASE_URL: baseUrl }),
    ).toThrow(
      'Managed identity requires OPENAI_BASE_URL=https://<account>.openai.azure.com/openai/v1.',
    );
    expect(identity.construct).not.toHaveBeenCalled();
  },
);

it('accepts a trailing slash on the Azure OpenAI v1 endpoint', () => {
  expect(
    modelCredentialFromEnv({
      ...managed,
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: `${managed.OPENAI_BASE_URL}/`,
    }),
  ).toBeTypeOf('function');
  expect(identity.token).not.toHaveBeenCalled();
});

it.each(['throw', 'empty', 'invalid'])(
  'sanitizes identity failure: %s',
  async (failure) => {
    const credential = modelCredentialFromEnv(managed);
    if (typeof credential !== 'function') throw new Error('Expected provider');
    if (failure === 'throw')
      identity.token.mockRejectedValue(
        new Error('SECRET identity response body'),
      );
    else if (failure === 'empty') identity.token.mockResolvedValue('');
    else identity.token.mockResolvedValue({ token: 'SECRET' } as never);
    const error = await credential().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Managed identity model authentication failed.',
    );
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('SECRET');
  },
);
