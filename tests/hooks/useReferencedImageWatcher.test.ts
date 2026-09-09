import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import {
  collectReferencedImagePaths,
  haveReferencedImageFieldsChanged,
  useReferencedImageWatcher,
} from '../../src/hooks/useReferencedImageWatcher';

const mocks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  getState: vi.fn(),
  subscribe: vi.fn(),
  getProjectDataDir: vi.fn(),
  watchFilePaths: vi.fn(),
  dispatchEvent: vi.fn(),
}));

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect); },
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: mocks.getState, subscribe: mocks.subscribe },
}));
vi.mock('../../src/services/fileService', () => ({
  getProjectDataDir: mocks.getProjectDataDir,
  watchFilePaths: mocks.watchFilePaths,
}));

function node(id: string, data: Partial<BaseNodeData> = {}): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-image',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'ai-image', ...data },
  };
}

describe('referenced image watcher projection', () => {
  it('ignores position changes that retain node data', () => {
    const previous = [node('image', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' })];
    const current = [{ ...previous[0], position: { x: 120, y: 80 } }];

    expect(haveReferencedImageFieldsChanged(current, previous)).toBe(false);
  });

  it('ignores unrelated node data changes', () => {
    const previous = [node('image', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' })];
    const current = [{
      ...previous[0],
      data: { ...previous[0].data, label: 'renamed', status: 'loading' as const },
    }];

    expect(haveReferencedImageFieldsChanged(current, previous)).toBe(false);
  });

  it('detects effective main image reference changes', () => {
    const previous = [node('image', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' })];
    const changedPath = [{
      ...previous[0],
      data: { ...previous[0].data, filePath: 'C:/images/b.png' },
    }];
    const hiddenImage = [{
      ...previous[0],
      data: { ...previous[0].data, imageUrl: undefined },
    }];

    expect(haveReferencedImageFieldsChanged(changedPath, previous)).toBe(true);
    expect(haveReferencedImageFieldsChanged(hiddenImage, previous)).toBe(true);
  });

  it('detects storyboard override reference changes', () => {
    const previous = [node('storyboard', {
      type: 'ai-storyboard',
      storyboardOverrides: [{ url: 'asset://a', filePath: 'C:/images/a.png' }],
    })];
    const current = [{
      ...previous[0],
      data: {
        ...previous[0].data,
        storyboardOverrides: [{ url: 'asset://b', filePath: 'C:/images/b.png' }],
      },
    }];

    expect(haveReferencedImageFieldsChanged(current, previous)).toBe(true);
  });

  it('ignores unreferenced node additions but detects referenced additions and removals', () => {
    const textNode = node('text', { type: 'ai-text' });
    const imageNode = node('image', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' });

    expect(haveReferencedImageFieldsChanged([textNode], [])).toBe(false);
    expect(haveReferencedImageFieldsChanged([textNode, imageNode], [textNode])).toBe(true);
    expect(haveReferencedImageFieldsChanged([textNode], [textNode, imageNode])).toBe(true);
  });

  it('ignores node reordering when effective image references stay unchanged', () => {
    const first = node('first', { filePath: 'C:/images/a.png', imageUrl: 'asset://a' });
    const second = node('second', { filePath: 'C:/images/b.png', imageUrl: 'asset://b' });

    expect(haveReferencedImageFieldsChanged([second, first], [first, second])).toBe(false);
  });

  it('collects unique referenced paths in stable order', () => {
    const nodes = [
      node('b', { filePath: 'C:/images/b.png', thumbnailUrl: 'asset://b' }),
      node('storyboard', {
        type: 'ai-storyboard',
        storyboardOverrides: [
          { url: 'asset://a', filePath: 'C:/images/a.png' },
          { url: 'asset://b-copy', filePath: 'C:/images/b.png' },
        ],
      }),
    ];

    expect(collectReferencedImagePaths(nodes)).toEqual([
      'C:/images/a.png',
      'C:/images/b.png',
    ]);
  });
});

describe('referenced image watcher ignores project thumbnail writes', () => {
  let cleanup: (() => void) | undefined;
  let frames: FrameRequestCallback[];
  let state: { currentProjectId: string | null; nodes: Node<BaseNodeData>[] };
  const stop = vi.fn();

  beforeEach(() => {
    cleanup = undefined;
    frames = [];
    mocks.effects.length = 0;
    state = {
      currentProjectId: 'episode',
      nodes: [node('image', { filePath: '/series/original.png', imageUrl: 'asset://original' })],
    };
    mocks.getState.mockImplementation(() => state);
    mocks.subscribe.mockReturnValue(vi.fn());
    mocks.getProjectDataDir.mockResolvedValue('/series');
    mocks.watchFilePaths.mockResolvedValue(stop);
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {},
      dispatchEvent: mocks.dispatchEvent,
      requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; },
      cancelAnimationFrame: vi.fn(),
    });
  });

  afterEach(() => { cleanup?.(); });

  function WatcherHarness(): void {
    useReferencedImageWatcher();
    cleanup = mocks.effects.pop()!() || undefined;
  }

  function emit(paths: string[], watcherIndex = 0): void {
    mocks.watchFilePaths.mock.calls[watcherIndex][1]({ type: 'any', paths });
  }

  function switchProject(projectId: string): void {
    const previous = state;
    state = { ...state, currentProjectId: projectId };
    mocks.subscribe.mock.calls[0][0](state, previous);
    frames.splice(0).forEach((callback) => callback(0));
  }

  it('ignores root cache creation and nested writes using the shared project directory once', async () => {
    WatcherHarness();
    await vi.waitFor(() => expect(mocks.watchFilePaths).toHaveBeenCalledOnce());

    emit(['/series/.thumbnail']);
    emit(['/series/.thumbnail/v1-image.cache']);
    emit(['/series/.thumbnail/temporary/image.tmp']);

    expect(mocks.dispatchEvent).not.toHaveBeenCalled();
    expect(mocks.getProjectDataDir).toHaveBeenCalledExactlyOnceWith('episode');
    emit(['/series/.thumbnail/cache', '/series/original.png']);
    expect(mocks.dispatchEvent).toHaveBeenCalledOnce();
    expect(mocks.dispatchEvent.mock.calls[0][0].detail.paths).toEqual(['/series/original.png']);
  });

  it('keeps group and external thumbnail directories and similarly prefixed folder events', async () => {
    state.nodes.push(
      node('group', { filePath: '/series/group/.thumbnail/user.png', imageUrl: 'asset://group' }),
      node('external', { filePath: '/external/.thumbnail/user.png', imageUrl: 'asset://external' }),
    );
    WatcherHarness();
    await vi.waitFor(() => expect(mocks.watchFilePaths).toHaveBeenCalledOnce());

    emit(['/series/group/.thumbnail/user.png']);
    emit(['/external/.thumbnail/user.png']);
    emit(['/series/.thumbnail-backup']);

    expect(mocks.dispatchEvent.mock.calls.map(([event]) => event.detail.paths)).toEqual([
      ['/series/group/.thumbnail/user.png'],
      ['/external/.thumbnail/user.png'],
      ['/series/original.png'],
    ]);
  });

  it('rebuilds cache scope on project switches even when referenced image paths are identical', async () => {
    WatcherHarness();
    await vi.waitFor(() => expect(mocks.watchFilePaths).toHaveBeenCalledOnce());
    mocks.getProjectDataDir.mockResolvedValue('/other');

    switchProject('other');
    await vi.waitFor(() => expect(mocks.watchFilePaths).toHaveBeenCalledTimes(2));
    emit(['/series/original.png'], 0);
    emit(['/other/.thumbnail'], 1);
    expect(mocks.dispatchEvent).not.toHaveBeenCalled();
    emit(['/series/.thumbnail'], 1);
    expect(mocks.dispatchEvent).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.getProjectDataDir.mock.calls).toEqual([['episode'], ['other']]);
  });

  it('does not install stale watchers when project resolution completes after a switch or cleanup', async () => {
    let resolveOld!: (directory: string) => void;
    mocks.getProjectDataDir.mockReturnValueOnce(new Promise<string>((resolve) => { resolveOld = resolve; }));
    WatcherHarness();
    switchProject('other');
    await vi.waitFor(() => expect(mocks.watchFilePaths).toHaveBeenCalledOnce());
    resolveOld('/stale');
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.watchFilePaths).toHaveBeenCalledOnce();

    let resolveLast!: (directory: string) => void;
    mocks.getProjectDataDir.mockReturnValueOnce(new Promise<string>((resolve) => { resolveLast = resolve; }));
    switchProject('last');
    cleanup?.();
    cleanup = undefined;
    resolveLast('/last');
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.watchFilePaths).toHaveBeenCalledOnce();
  });

  it('stops a native watcher that finishes registration after cleanup', async () => {
    let resolveWatch!: (unwatch: () => void) => void;
    mocks.watchFilePaths.mockReturnValueOnce(new Promise<() => void>((resolve) => { resolveWatch = resolve; }));
    WatcherHarness();
    await vi.waitFor(() => expect(mocks.watchFilePaths).toHaveBeenCalledOnce());
    cleanup?.();
    cleanup = undefined;
    resolveWatch(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });
});
