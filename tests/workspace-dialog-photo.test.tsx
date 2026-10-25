import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import type { Dot, State, WorkspaceState } from '../src/shared/types';

const api = vi.hoisted(() => vi.fn(async () => ({ photoVersion: 'new' })));
vi.mock('../src/client/api', () => ({ api }));
vi.mock('../src/client/prepare-dot-photo', () => ({
  prepareDotPhoto: async () => 'processed',
}));
vi.mock('../src/client/ConnectionsSection', () => ({
  ConnectionsSection: () => null,
}));

afterEach(() => vi.unstubAllGlobals());
it('saves a photo immediately without saving the draft name/instructions, and keeps dialog keyboard navigation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const listeners = new Map<string, (event: KeyboardEvent) => void>();
  const document = {
    activeElement: undefined as unknown,
    addEventListener: (
      name: string,
      listener: (event: KeyboardEvent) => void,
    ) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  class Element {
    focus = vi.fn(() => {
      document.activeElement = this;
    });
  }
  const first = new Element();
  const last = new Element();
  const querySelectorAll = vi.fn((_selector: string) => [first, last]);
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('document', document);
  const dot: Dot = {
    id: 'dot',
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
  const workspace: WorkspaceState = {
    spaces: [{ id: 'space', name: 'Everyday', description: '', createdAt: 0 }],
    dots: [dot],
    conversations: [],
    calls: [],
    setup: {
      intelligence: false,
      model: false,
      browser: false,
      voice: false,
      composio: false,
      slack: 'off',
      missing: [],
    },
  };
  const state = {
    settings: {
      researchAllowed: true,
      memoryAllowed: true,
      appsAllowed: false,
    },
  } as State;
  const mutate = vi.fn<
    (path: string, method: string, body?: unknown) => Promise<boolean>
  >(async () => true);
  const onPhotoSaved = vi.fn(async () => {});
  const onClose = vi.fn();
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      <WorkspaceDialog
        dialog={{ type: 'dot', dot, spaceId: 'space' }}
        state={state}
        workspace={workspace}
        mutate={mutate}
        onPhotoSaved={onPhotoSaved}
        onClose={onClose}
      />,
      {
        createNodeMock: (node) =>
          node.type === 'section'
            ? { querySelector: () => first, querySelectorAll }
            : null,
      },
    );
  });
  try {
    await act(async () => {
      root.root
        .findByProps({ id: 'entity-name' })
        .props.onChange({ target: { value: 'New name' } });
      root.root
        .findByProps({ id: 'entity-text' })
        .props.onChange({ target: { value: 'New instructions' } });
      root.root
        .findByProps({ id: 'dot-photo' })
        .props.onChange({ target: { files: [{}], value: 'file' } });
    });
    expect(api).toHaveBeenCalledWith('/dots/dot/photo', 'PUT', {
      dataUrl: 'processed',
    });
    expect(onPhotoSaved).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(root.root.findByProps({ id: 'entity-name' }).props.value).toBe(
      'New name',
    );
    const preventDefault = vi.fn();
    document.activeElement = last;
    listeners.get('keydown')!({
      key: 'Tab',
      shiftKey: false,
      preventDefault,
    } as unknown as KeyboardEvent);
    expect(document.activeElement).toBe(first);
    expect(preventDefault).toHaveBeenCalled();
    expect(querySelectorAll.mock.calls[0][0]).toContain('input:enabled');
    listeners.get('keydown')!({
      key: 'Tab',
      shiftKey: true,
      preventDefault,
    } as unknown as KeyboardEvent);
    expect(document.activeElement).toBe(last);
    await act(async () => {
      await root.root.findByType('form').props.onSubmit({ preventDefault });
    });
    expect(mutate).toHaveBeenCalledWith(
      '/dots/dot',
      'PUT',
      expect.objectContaining({
        name: 'New name',
        instructions: 'New instructions',
      }),
    );
    expect(mutate.mock.calls[0][2]).not.toHaveProperty('dataUrl');
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
