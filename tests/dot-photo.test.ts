import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { validateDotPhoto } from '../src/server/dot-photo.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
const dataUrl = (photo: Buffer) =>
  `data:image/jpeg;base64,${photo.toString('base64')}`;
const image = (width = 2, height = 3) =>
  sharp({ create: { width, height, channels: 3, background: 'red' } });
const jpeg = (width = 2, height = 3) => image(width, height).jpeg().toBuffer();
function fixture() {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken: 'test-owner',
  });
  const path = `/api/dots/${ws.dots()[0].id}/photo`;
  const request = (
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) => ({
    method,
    headers: {
      Authorization: 'Bearer test-owner',
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body === undefined || method === 'GET'
      ? {}
      : { body: JSON.stringify(body) }),
  });
  return { ws, app, path, request };
}

it('fully decodes JPEGs, applies orientation, and strips metadata', async () => {
  const input = await image()
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  expect((await sharp(input).metadata()).exif).toBeDefined();
  const output = await validateDotPhoto({ dataUrl: dataUrl(input) });
  const metadata = await sharp(output).metadata();
  expect(metadata).toMatchObject({ format: 'jpeg', width: 3, height: 2 });
  for (const field of ['exif', 'icc', 'xmp', 'iptc', 'orientation'])
    expect(metadata[field as keyof typeof metadata]).toBeUndefined();
  expect(output.length).toBeLessThanOrEqual(262_144);
  await expect(sharp(output).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
  const truncated = input.subarray(0, input.length - 2);
  expect((await sharp(truncated).metadata()).format).toBe('jpeg');
  await expect(
    validateDotPhoto({ dataUrl: dataUrl(truncated) }),
  ).rejects.toMatchObject({ status: 400 });
});

it('rejects malformed, noncanonical, spoofed, oversized and out-of-bounds images', async () => {
  const valid = dataUrl(await jpeg());
  const zeroWidth = await jpeg();
  const frame = zeroWidth.indexOf(Buffer.from([0xff, 0xc0]));
  expect(frame).toBeGreaterThan(0);
  zeroWidth.writeUInt16BE(0, frame + 7);
  for (const body of [
    null,
    {},
    { dataUrl: valid, extra: true },
    { dataUrl: 1 },
    { dataUrl: 'https://example.com/photo.jpg' },
    { dataUrl: valid.replace('image/jpeg', 'image/png') },
    { dataUrl: valid + '\n' },
    { dataUrl: 'data:image/jpeg;base64,/9j/' },
    { dataUrl: 'data:image/jpeg;base64,/9j/AB==' },
    { dataUrl: dataUrl(await image().png().toBuffer()) },
    { dataUrl: dataUrl(Buffer.from('<svg/>')) },
    {
      dataUrl: dataUrl(
        Buffer.concat([
          Buffer.from([255, 216, 255]),
          await image().png().toBuffer(),
        ]),
      ),
    },
    { dataUrl: dataUrl(await jpeg(513, 1)) },
    { dataUrl: dataUrl(await jpeg(1, 513)) },
    { dataUrl: dataUrl(await jpeg(513, 513)) },
    { dataUrl: dataUrl(zeroWidth) },
  ])
    await expect(validateDotPhoto(body)).rejects.toMatchObject({ status: 400 });
  for (const size of [262_145, 262_146, 300_000])
    await expect(
      validateDotPhoto({ dataUrl: dataUrl(Buffer.alloc(size)) }),
    ).rejects.toMatchObject({ status: 413 });
  await expect(
    validateDotPhoto({ dataUrl: dataUrl(await jpeg(512, 512)) }),
  ).resolves.toBeInstanceOf(Buffer);
});

it('atomically replaces/deletes photos and keeps bytes out of Dot/workspace metadata', async () => {
  const { ws, app, path, request } = fixture();
  const id = ws.dots()[0].id;
  expect((await app.request(path, request())).status).toBe(404);
  const put = await app.request(
    path,
    request('PUT', { dataUrl: dataUrl(await jpeg()) }),
  );
  expect(put.status).toBe(200);
  const version = await put.json();
  const first = await (await app.request(path, request())).json();
  expect(first).toMatchObject(version);
  expect(first.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  const invalid = await app.request(
    path,
    request('PUT', { dataUrl: dataUrl(Buffer.from([255, 216, 255])) }),
  );
  expect(invalid.status).toBe(400);
  expect(ws.dotPhoto(id)).toEqual(first);
  expect(() => ws.saveDotPhoto(id, Buffer.alloc(262_145))).toThrow();
  expect(ws.dotPhoto(id)).toEqual(first);
  const dot = ws.dot(id)!;
  expect(dot.photoVersion).toBe(first.photoVersion);
  expect(dot).not.toHaveProperty('photo');
  expect(dot).not.toHaveProperty('dataUrl');
  const workspace = await (
    await app.request('/api/workspace', request())
  ).json();
  expect(JSON.stringify(workspace)).not.toContain('data:image');
  expect(JSON.stringify(workspace)).not.toContain('"photo":');
  const replacement = await app.request(
    path,
    request('PUT', { dataUrl: dataUrl(await jpeg(4, 2)) }),
  );
  expect(replacement.status).toBe(200);
  expect((await replacement.json()).photoVersion).not.toBe(first.photoVersion);
  expect(ws.dotPhoto(id)?.photoVersion).toBe(ws.dot(id)?.photoVersion);
  expect(await (await app.request(path, request('DELETE'))).json()).toEqual({
    photoVersion: null,
  });
  expect(ws.dot(id)?.photoVersion).toBeNull();
  expect((await app.request(path, request())).status).toBe(404);
  expect((await app.request(path, request('DELETE'))).status).toBe(404);
});

it('keeps the existing auth/origin/JSON/body limits and resource/error status boundaries', async () => {
  const { ws, app, path, request } = fixture();
  const body = { dataUrl: dataUrl(await jpeg()) };
  for (const method of ['GET', 'PUT', 'DELETE']) {
    expect(
      (
        await app.request(path, {
          ...request(method, body),
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          path,
          request(method, body, { Origin: 'https://evil.example' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          path,
          request(method, body, { 'Sec-Fetch-Site': 'cross-site' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await app.request('/api/dots/missing/photo', request(method, body)))
        .status,
    ).toBe(404);
  }
  expect(
    (
      await app.request(
        path,
        request('PUT', body, { 'Content-Type': 'text/plain' }),
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await app.request(
        path,
        request('PUT', { dataUrl: 'x'.repeat(1_000_000) }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await app.request(
        path,
        request('PUT', { dataUrl: dataUrl(Buffer.alloc(262_145)) }),
      )
    ).status,
  ).toBe(413);
  expect(
    (await app.request(path, { ...request('PUT'), body: '{' })).status,
  ).toBe(400);
  await app.request(path, request('PUT', body));
  const first = ws.dotPhoto(ws.dots()[0].id);
  vi.spyOn(ws, 'saveDotPhoto').mockImplementation(() => {
    throw new Error('database failed');
  });
  expect((await app.request(path, request('PUT', body))).status).toBe(503);
  expect(ws.dotPhoto(ws.dots()[0].id)).toEqual(first);
  const get = await app.request(path, request());
  expect(get.headers.get('Cache-Control')).toBe('no-store');
});

it('adds the photo table to legacy databases and persists replacements/deletions across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-photo-'));
  const path = join(dir, 'workspace.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('space', 'Original', '', 1);
      INSERT INTO dots VALUES ('dot', 'space', 'Dot', 'Help', 1, 1, 1);`);
    legacy.close();
    let ws = new WorkspaceStore(path, 'owner');
    expect(ws.dot('dot')?.photoVersion).toBeNull();
    const photo = await validateDotPhoto({ dataUrl: dataUrl(await jpeg()) });
    const version = ws.saveDotPhoto('dot', photo);
    ws.bindThread('thread', 'dot', 'Preserved');
    ws.close();
    ws = new WorkspaceStore(path, 'owner');
    expect(ws.dotPhoto('dot')).toEqual({ ...version, dataUrl: dataUrl(photo) });
    expect(ws.requireThread('thread').dotId).toBe('dot');
    expect(ws.deleteDotPhoto('dot')).toBe(true);
    ws.close();
    ws = new WorkspaceStore(path, 'owner');
    expect(ws.dotPhoto('dot')).toBeNull();
    expect(ws.dot('dot')).toMatchObject({
      name: 'Dot',
      instructions: 'Help',
      spaceIds: ['space'],
    });
    ws.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
