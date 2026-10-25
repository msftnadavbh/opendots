import { afterEach, expect, it, vi } from 'vitest';
import { DotPhotoCache, type DotPhoto } from '../src/client/dot-photo-cache';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it('clears session-only photos immediately on any API 401 and on a token change', async () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => '',
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  const { api, onAuthChange, setToken } = await import('../src/client/api');
  const cache = new DotPhotoCache((id) => api<DotPhoto>(`/dots/${id}/photo`));
  const unsubscribe = onAuthChange(() => cache.clear());
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ photoVersion: 'v1', dataUrl: 'photo' })),
    );
  vi.stubGlobal('fetch', fetch);
  setToken('first');
  await cache.ensure('dot', 'v1');
  expect(cache.get('dot', 'v1')).toBe('photo');
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer first');
  expect(fetch.mock.calls[0][0]).toBe('/api/dots/dot/photo');
  fetch.mockResolvedValueOnce(
    new Response('{"error":"unauthorized"}', { status: 401 }),
  );
  await expect(api('/state')).rejects.toMatchObject({ status: 401 });
  expect(cache.get('dot', 'v1')).toBeUndefined();
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ photoVersion: 'v1', dataUrl: 'photo' })),
  );
  await cache.ensure('dot', 'v1');
  setToken('second');
  expect(cache.get('dot', 'v1')).toBeUndefined();
  unsubscribe();
});
