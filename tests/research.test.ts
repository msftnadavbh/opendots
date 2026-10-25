import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestedUrls,
  research,
  type Config,
} from '../src/server/research.js';
import { modelRedirect } from './fixtures/model-redirect.js';
const signal = new AbortController().signal;
const config: Config = {
  mode: 'live',
  webSearchProvider: 'browser',
  apiKey: 'secret',
  model: 'test-model',
  baseUrl: 'https://model.example/v1',
  browserUrl: 'http://browser:4311',
  browserSecret: 'browser-secret',
};
afterEach(() => vi.unstubAllGlobals());
describe('research adapters', () => {
  it('does not contact providers in sample mode and labels every result', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await research(
      'Something useful',
      [],
      { mode: 'sample', baseUrl: '' },
      signal,
      () => {},
    );
    expect(result.sample).toBe(true);
    expect(result.text).toContain('fictional');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails visibly for missing live config and unsupported search', async () => {
    await expect(
      research('Research', [], { mode: 'live', baseUrl: '' }, signal, () => {}),
    ).rejects.toThrow('not configured');
    await expect(
      research('Research', [], config, signal, () => {}),
    ).rejects.toThrow('include a public');
  });
  it('grounds model input in browser evidence and returns provider output', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          title: 'Evidence',
          url: 'https://example.com',
          text: 'Verified source text',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: 'A grounded brief.' } }],
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const result = await research(
      'Summarize https://example.com',
      [],
      config,
      signal,
      () => {},
    );
    expect(result.text).toBe('A grounded brief.');
    expect(result.sample).toBe(false);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer secret');
    expect(fetch.mock.calls[1][1].redirect).toBe('error');
    expect(fetch.mock.calls[1][1].signal).toBe(signal);
    expect(
      JSON.parse(fetch.mock.calls[1][1].body).messages[1].content,
    ).toContain('Verified source text');
  });
  it('resolves the model credential immediately before every research request', async () => {
    const order: string[] = [];
    let generation = 0;
    const token = vi.fn(async () => {
      order.push('auth');
      return `token-${++generation}`;
    });
    const network = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/browse')) {
        order.push('browser');
        return Response.json({
          title: 'Page',
          url: 'https://example.com',
          text: 'Evidence',
        });
      }
      order.push('model');
      expect(new Headers(init.headers).get('authorization')).toBe(
        `Bearer token-${generation}`,
      );
      expect(init.signal).toBe(signal);
      expect(init.redirect).toBe('error');
      return Response.json({ choices: [{ message: { content: 'Brief' } }] });
    });
    vi.stubGlobal('fetch', network);
    expect(token).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      await research(
        'Read https://example.com',
        [],
        { ...config, apiKey: token },
        signal,
        () => {},
      );
    }
    expect(order).toEqual([
      'browser',
      'auth',
      'model',
      'browser',
      'auth',
      'model',
    ]);
    expect(token).toHaveBeenCalledTimes(2);
  });
  it.each(['before research', 'before auth', 'during auth'])(
    'does not send a model request after cancellation %s',
    async (when) => {
      const controller = new AbortController();
      const token = vi.fn(async () => {
        if (when === 'during auth') {
          await Promise.resolve();
          controller.abort();
        }
        return 'must-not-be-sent';
      });
      const network = vi.fn(async () => {
        if (when === 'before auth') controller.abort();
        return Response.json({
          title: 'Page',
          url: 'https://example.com',
          text: 'Evidence',
        });
      });
      vi.stubGlobal('fetch', network);
      if (when === 'before research') controller.abort();
      const error = await research(
        'Read https://example.com',
        [],
        { ...config, apiKey: token },
        controller.signal,
        () => {},
      ).catch((error: unknown) => error);
      expect(controller.signal.aborted).toBe(true);
      expect(error).toBe(controller.signal.reason);
      expect(network).toHaveBeenCalledTimes(when === 'before research' ? 0 : 1);
      expect(token).toHaveBeenCalledTimes(when === 'during auth' ? 1 : 0);
    },
  );
  it('does not request a completion when model authentication fails', async () => {
    const token = vi
      .fn()
      .mockRejectedValue(
        new Error('Managed identity model authentication failed.'),
      );
    const network = vi.fn().mockResolvedValue(
      Response.json({
        title: 'Page',
        url: 'https://example.com',
        text: 'Evidence',
      }),
    );
    vi.stubGlobal('fetch', network);
    await expect(
      research(
        'Read https://example.com',
        [],
        { ...config, apiKey: token },
        signal,
        () => {},
      ),
    ).rejects.toThrow('Managed identity model authentication failed.');
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('blocks real HTTP redirects from the raw model request', async () => {
    const redirect = await modelRedirect();
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/browse'))
          return Response.json({
            title: 'Page',
            url: 'https://example.com',
            text: 'Evidence',
          });
        return nativeFetch(redirect.url, init);
      }),
    );
    try {
      await expect(
        research(
          'Read https://example.com',
          [],
          { ...config, apiKey: async () => 'managed-token' },
          signal,
          () => {},
        ),
      ).rejects.toThrow();
      expect(redirect.requests).toEqual(['/redirect']);
    } finally {
      await redirect.close();
    }
  });
  it('surfaces browser and model failures without presenting success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'Blocked address' }, { status: 502 }),
        ),
    );
    await expect(
      research('Read https://example.com', [], config, signal, () => {}),
    ).rejects.toThrow('Blocked address');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            title: 'Page',
            url: 'https://example.com',
            text: 'Source',
          }),
        )
        .mockResolvedValueOnce(new Response('', { status: 429 })),
    );
    await expect(
      research('Read https://example.com', [], config, signal, () => {}),
    ).rejects.toThrow('429');
  });
  it('keeps balanced brackets in requested URLs and trims wrapping ones', () => {
    expect(
      requestedUrls(
        'Read https://en.wikipedia.org/wiki/Rust_(programming_language).',
      ),
    ).toEqual(['https://en.wikipedia.org/wiki/Rust_(programming_language)']);
    expect(
      requestedUrls(
        'See (https://example.com/a) and [https://example.com/b], or [x](https://example.com/c).',
      ),
    ).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
    expect(
      requestedUrls('Read https://example.com twice https://example.com'),
    ).toEqual(['https://example.com']);
  });
  it('parses Markdown links whose label is also a URL as separate occurrences', () => {
    expect(
      requestedUrls('Summarize [https://example.com](https://example.com).'),
    ).toEqual(['https://example.com']);
    expect(
      requestedUrls(
        'See [https://example.com/label](https://example.com/dest) for details.',
      ),
    ).toEqual(['https://example.com/label', 'https://example.com/dest']);
  });
});
