import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Dot } from '../src/shared/types';
import { DotPhotoCache, type DotPhoto } from '../src/client/dot-photo-cache';
import { DotAvatar, DotPhotos } from '../src/client/DotAvatar';
import { DotPhotoSettings } from '../src/client/DotPhotoSettings';
import { prepareDotPhoto } from '../src/client/prepare-dot-photo';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
const photo = 'data:image/jpeg;base64,/9j/2Q==';
const dot: Dot = {
  id: 'dot',
  photoVersion: 'v1',
  name: 'Scout',
  instructions: 'Help',
  spaceId: 'space',
  spaceIds: ['space'],
  researchAllowed: true,
  memoryAllowed: true,
  appsAllowed: false,
  composioToolkits: [],
  createdAt: 0,
};
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const roots: ReturnType<typeof create>[] = [];
beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  vi.unstubAllGlobals();
});

it('deduplicates by Dot/version, ignores late responses, and clears even pending data on reset', async () => {
  const old = pending<DotPhoto>();
  const next = pending<DotPhoto>();
  const load = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(next.promise);
  const cache = new DotPhotoCache(load);
  expect(cache.get('dot')).toBeUndefined();
  const first = cache.ensure('dot', 'v1');
  const duplicate = cache.ensure('dot', 'v1');
  const second = cache.ensure('dot', 'v2');
  expect(load).toHaveBeenCalledTimes(2);
  next.resolve({ photoVersion: 'v2', dataUrl: photo });
  await second;
  old.resolve({ photoVersion: 'v1', dataUrl: 'old' });
  await Promise.all([first, duplicate]);
  expect(cache.get('dot', 'v2')).toBe(photo);
  expect(cache.get('dot', 'v1')).toBeUndefined();
  await cache.ensure('dot', 'v2');
  expect(load).toHaveBeenCalledTimes(2);
  const late = pending<DotPhoto>();
  load
    .mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce({ photoVersion: 'v3', dataUrl: 'new session' });
  const stale = cache.ensure('dot', 'v3');
  cache.clear();
  expect(cache.get('dot', 'v2')).toBeUndefined();
  await cache.ensure('dot', 'v3');
  late.resolve({ photoVersion: 'v3', dataUrl: 'old session' });
  await stale;
  expect(cache.get('dot', 'v3')).toBe('new session');
});

it('retries failed loads while deduplicating loaded and mismatched versions', async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('404'))
    .mockResolvedValueOnce({ photoVersion: 'v1', dataUrl: photo })
    .mockResolvedValueOnce({ photoVersion: 'other', dataUrl: photo });
  const cache = new DotPhotoCache(load);
  await cache.ensure('dot', 'v1');
  expect(cache.get('dot', 'v1')).toBeUndefined();
  await cache.ensure('dot', 'v1');
  expect(load).toHaveBeenCalledTimes(2);
  expect(cache.get('dot', 'v1')).toBe(photo);
  await cache.ensure('dot', 'v1');
  expect(load).toHaveBeenCalledTimes(2);
  await cache.ensure('dot', 'v2');
  expect(cache.get('dot', 'v2')).toBeUndefined();
  await cache.ensure('dot', 'v2');
  expect(load).toHaveBeenCalledTimes(3);
  load.mockResolvedValueOnce({ photoVersion: 'v2', dataUrl: photo });
  await cache.ensure('another', 'v2');
  expect(cache.get('another', 'v2')).toBe(photo);
});

it('retries a transient failure on remount but not on unchanged workspace polls', async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('503'))
    .mockResolvedValueOnce({ photoVersion: 'v1', dataUrl: photo });
  const cache = new DotPhotoCache(load);
  const view = () => (
    <DotPhotos.Provider value={cache}>
      <DotAvatar dot={{ ...dot }} />
    </DotPhotos.Provider>
  );
  let root!: ReturnType<typeof create>;
  await act(async () => {
    roots.push((root = create(view())));
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => root.update(view()));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  await act(async () => {
    roots.push((root = create(view())));
  });
  expect(load).toHaveBeenCalledTimes(2);
  expect(cache.get('dot', 'v1')).toBe(photo);
});

it('shows mascots through fetch/image loading and errors, while preserving name/status and decorative alt', async () => {
  const response = pending<DotPhoto>();
  const load = vi.fn(() => response.promise);
  const cache = new DotPhotoCache(load);
  let root!: ReturnType<typeof create>;
  const view = (decorative = false) => (
    <DotPhotos.Provider value={cache}>
      <DotAvatar dot={dot} state="working" decorative={decorative} />
    </DotPhotos.Provider>
  );
  await act(async () => {
    roots.push((root = create(view())));
  });
  expect(root.root.findByType('img').props.src).toMatch(/^\/dots\//);
  expect(root.root.findByType('img').props.alt).toBe('Scout is working');
  await act(async () => {
    response.resolve({ photoVersion: 'v1', dataUrl: photo });
  });
  const uploaded = () =>
    root.root.findAllByType('img').find((node) => node.props.src === photo)!;
  expect(uploaded().props.style.display).toBe('none');
  expect(
    root.root
      .findAllByType('img')
      .some((node) => node.props.src.startsWith('/dots/')),
  ).toBe(true);
  await act(async () => {
    uploaded().props.onLoad();
  });
  expect(root.root.findByType('img').props.src).toBe(photo);
  expect(root.root.findByType('img').props.alt).toBe('Scout is working');
  await act(async () => {
    root.update(view(true));
  });
  expect(root.root.findByType('img').props.alt).toBe('');
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    uploaded().props.onError();
  });
  expect(root.root.findByType('img').props.src).toMatch(/^\/dots\//);
  expect(root.root.findByType('img').props.alt).toBe('');
  await act(async () => {
    cache.clear();
  });
  expect(root.root.findByType('img').props.src).toMatch(/^\/dots\//);
});

function browser() {
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toDataURL: vi.fn(() => photo),
  };
  const decode = vi.fn(async () => {});
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:image/png;base64,AAAA';
      onload?: () => void;
      readAsDataURL() {
        this.onload?.();
      }
    },
  );
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 2048;
      naturalHeight = 1024;
      decode = decode;
    },
  );
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  return { context, canvas, decode };
}
const file = { type: 'image/png', size: 1024 } as File;

it('bounds the picker input and preserves aspect ratio with white JPEG output at quality 0.85', async () => {
  const { context, canvas } = browser();
  expect(await prepareDotPhoto(file)).toBe(photo);
  expect(canvas.width).toBe(512);
  expect(canvas.height).toBe(256);
  expect(context.fillStyle).toBe('#ffffff');
  expect(context.fillRect).toHaveBeenCalledWith(0, 0, 512, 256);
  expect(context.drawImage).toHaveBeenCalledWith(
    expect.anything(),
    0,
    0,
    512,
    256,
  );
  expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
  await expect(
    prepareDotPhoto({ ...file, type: 'image/svg+xml' }),
  ).rejects.toThrow('JPEG or PNG');
  await expect(
    prepareDotPhoto({ ...file, size: 10 * 1024 * 1024 + 1 }),
  ).rejects.toThrow('10 MiB');
  canvas.toDataURL.mockReturnValue(
    `data:image/jpeg;base64,${'A'.repeat(349_528)}`,
  );
  await expect(prepareDotPhoto(file)).rejects.toThrow('256 KiB');
});

it('rejects decode/canvas failures rather than uploading the original', async () => {
  const { decode, canvas } = browser();
  decode.mockRejectedValueOnce(new Error('invalid'));
  await expect(prepareDotPhoto(file)).rejects.toThrow('decode');
  canvas.getContext.mockReturnValueOnce(null as never);
  await expect(prepareDotPhoto(file)).rejects.toThrow('unavailable');
});

it('does not upscale a small photo or collapse a narrow photo to zero pixels', async () => {
  const { canvas } = browser();
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 2;
      naturalHeight = 3;
      async decode() {}
    },
  );
  await prepareDotPhoto(file);
  expect([canvas.width, canvas.height]).toEqual([2, 3]);
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 1;
      naturalHeight = 10000;
      async decode() {}
    },
  );
  await prepareDotPhoto(file);
  expect([canvas.width, canvas.height]).toEqual([1, 512]);
});

it('offers labeled keyboard-native immediate replace/remove controls without submitting name/instructions', async () => {
  browser();
  api.mockResolvedValue({ photoVersion: 'v2' });
  const saved = vi.fn(async () => {});
  let root!: ReturnType<typeof create>;
  await act(async () => {
    roots.push((root = create(<DotPhotoSettings dot={dot} onSaved={saved} />)));
  });
  const input = root.root.findByType('input');
  expect(input.props.type).toBe('file');
  expect(input.props.accept).toBe('image/jpeg,image/png');
  expect(root.root.findByProps({ htmlFor: input.props.id }).children).toContain(
    'Replace photo',
  );
  const target = { files: [file], value: 'chosen.png' };
  await act(async () => {
    input.props.onChange({ target });
  });
  expect(target.value).toBe('');
  expect(api).toHaveBeenCalledWith('/dots/dot/photo', 'PUT', {
    dataUrl: photo,
  });
  expect(saved).toHaveBeenCalledTimes(1);
  const remove = root.root.findByType('button');
  expect(remove.props.type).toBe('button');
  await act(async () => {
    remove.props.onClick();
  });
  expect(api).toHaveBeenLastCalledWith('/dots/dot/photo', 'DELETE', undefined);
  expect(root.root.findByProps({ role: 'status' }).children).toContain(
    'Photo removed.',
  );
  api.mockRejectedValueOnce(new Error('Photo rejected'));
  await act(async () => {
    input.props.onChange({ target: { files: [file], value: '' } });
  });
  expect(root.root.findByProps({ role: 'alert' }).children).toContain(
    'Photo rejected',
  );
  expect(saved).toHaveBeenCalledTimes(2);
});
