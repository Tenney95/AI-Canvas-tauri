import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { AssetFileEntry } from '../../src/services/fileService';

type OverlayState = Pick<AppState, 'projects' | 'currentProjectId' | 'projectLoadStatus' | 'nodes'>;
interface ElementLike { props: Record<string, unknown> & { children?: unknown } }
const driver = vi.hoisted(() => ({
  state: null as unknown as OverlayState,
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  load: vi.fn<(id: string) => Promise<{ nodes: AppState['nodes'] } | null>>(),
}));
vi.mock('react', async () => {
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const index = driver.memoIndex++;
    const previous = driver.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      driver.memos[index] = { value: factory(), deps };
    }
    return driver.memos[index].value as T;
  };
  return {
    ...await vi.importActual<typeof import('react')>('react'),
    useMemo: memo, useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useState: <T,>(initial?: T | (() => T)) => {
      const index = driver.stateIndex++;
      if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [driver.states[index], (next: T | ((old: T) => T)) => {
        driver.states[index] = typeof next === 'function' ? (next as (old: T) => T)(driver.states[index] as T) : next;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = driver.refIndex++;
      return (driver.refs[index] ??= { current: initial }) as { current: T };
    },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = driver.effectIndex++;
      const previous = driver.effects[index];
      if (previous && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      driver.pending.push(() => {
        previous?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
    },
  };
});
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: OverlayState) => unknown) => selector(driver.state) }));
vi.mock('../../src/services/storageService', () => ({ loadProjectData: driver.load }));
vi.mock('../../src/services/fileService', () => ({
  getConvertFileSrc: () => (path: string) => `asset://${path}`,
  CATEGORY_LABELS: { image: '图片', video: '视频' },
  extractFilesFromNodeData: (data: Record<string, unknown>) => data.imageUrl || data.videoUrl || data.filePath ? {
    name: data.fileName, path: data.filePath ?? data.imageUrl ?? data.videoUrl,
    assetUrl: data.imageUrl ?? data.videoUrl, assetId: data.assetId, relativePath: data.relativePath,
    category: String(data.fileName).endsWith('.mp4') ? 'video' : 'image', size: 0,
  } : null,
}));
vi.mock('../../src/hooks/useResourceVideoPreview', () => ({ useResourceVideoPreview: () => ({ expandedId: null, setExpanded: vi.fn() }) }));
vi.mock('../../src/components/shared/ViewportImage', () => ({ default: 'viewport-image' }));
vi.mock('../../src/components/shared/ResourceVideoPreview', () => ({ default: 'resource-video-preview' }));
vi.mock('../../src/components/shared/PopupCloseButton', () => ({ default: 'close-button' }));
vi.mock('@iconify/react', () => ({ Icon: 'icon' }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));

import ProjectAssetsOverlay from '../../src/components/ProjectAssetsOverlay';

function node(id: string, name: string): AppState['nodes'][number] {
  return { id, type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', label: name, fileName: name, imageUrl: `asset://${name}` } };
}
function render(isOpen = true) {
  driver.stateIndex = driver.refIndex = driver.memoIndex = driver.effectIndex = 0;
  const tree = ProjectAssetsOverlay({ isOpen, onClose: () => {} });
  driver.pending.splice(0).forEach((effect) => effect());
  return tree;
}
function elements(value: unknown): ElementLike[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ElementLike;
  return [element, ...elements(element.props.children)];
}
function files(tree: unknown): AssetFileEntry[] {
  return elements(tree).flatMap((element) => element.props.file ? [element.props.file as AssetFileEntry] : []);
}
async function settled() {
  await vi.waitFor(() => {
    const loading = elements(render()).some((element) => Array.isArray(element.props.children) && element.props.children.includes('加载中…'));
    expect(loading).toBe(false);
  });
  return render();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  driver.states = []; driver.refs = []; driver.memos = []; driver.effects = []; driver.pending = [];
  driver.state = {
    currentProjectId: 'ep1', projectLoadStatus: 'ready', nodes: [node('live', 'current.png')],
    projects: [
      { id: 'series', name: 'Series', createdAt: 1, updatedAt: 1 },
      ...[1, 2, 3].map((n) => ({ id: `ep${n}`, name: `Episode ${n}`, createdAt: 1, updatedAt: 1, parentId: 'series', episodeNo: n })),
    ],
  };
  driver.load.mockReset().mockImplementation(async (id) => ({ nodes: [node(`saved-${id}`, `${id}.png`)] }));
});
afterEach(() => { driver.effects.forEach((effect) => effect.cleanup?.()); });

describe('ProjectAssetsOverlay loading scope', () => {
  it('keeps unsaved media live without rereading other episodes on movement, status or current saves', async () => {
    render();
    expect(files(await settled()).map((file) => file.name)).toEqual(['current.png', 'ep2.png', 'ep3.png']);
    const live = driver.state.nodes[0];
    driver.state.nodes = [{ ...live, position: { x: 100, y: 200 }, data: { ...live.data, status: 'loading' } }];
    render();
    driver.state.projects = driver.state.projects.map((ep) => ep.id === 'ep1' ? { ...ep, updatedAt: 2 } : ep);
    render();
    expect(driver.load.mock.calls.map(([id]) => id)).toEqual(['ep2', 'ep3']);
    driver.state.nodes = [{ ...live, data: { ...live.data, imageUrl: 'asset://replacement.png', assetId: 'new-id', relativePath: 'new.png' } }];
    expect(files(render())[0]).toMatchObject({ assetUrl: 'asset://replacement.png', assetId: 'new-id', relativePath: 'new.png' });
    driver.state.nodes = [];
    expect(files(render()).map((file) => file.name)).toEqual(['ep2.png', 'ep3.png']);
    driver.state.nodes = [node('generated', 'new-generation.png')];
    expect(files(render())[0].name).toBe('new-generation.png');
    expect(driver.load).toHaveBeenCalledTimes(2);
  });

  it('reloads only changed saved versions and reads fresh again after closing', async () => {
    render(); await settled();
    driver.load.mockImplementation(async (id) => ({ nodes: [node(`saved-${id}`, `${id}-updated.png`)] }));
    driver.state.projects = driver.state.projects.map((ep) => ep.id === 'ep2' ? { ...ep, updatedAt: 2 } : ep);
    render();
    expect(files(await settled()).map((file) => file.name)).toEqual(['current.png', 'ep2-updated.png', 'ep3.png']);
    expect(driver.load.mock.calls.map(([id]) => id)).toEqual(['ep2', 'ep3', 'ep2']);
    render(false); render(true); await settled();
    expect(driver.load.mock.calls.map(([id]) => id)).toEqual(['ep2', 'ep3', 'ep2', 'ep2', 'ep3']);
  });

  it('drops late closed-scope results and never pairs old nodes with a loading project', async () => {
    const old = deferred<{ nodes: AppState['nodes'] }>();
    driver.load.mockImplementationOnce(() => old.promise);
    render();
    await vi.waitFor(() => expect(driver.load).toHaveBeenCalledExactlyOnceWith('ep2'));
    render(false);
    driver.state.currentProjectId = 'new-ep';
    driver.state.projectLoadStatus = 'loading';
    driver.state.projects = [
      { id: 'new-series', name: 'New series', createdAt: 1, updatedAt: 1 },
      { id: 'new-ep', name: 'New episode', parentId: 'new-series', episodeNo: 1, createdAt: 1, updatedAt: 1 },
    ];
    render();
    expect(files(await settled())).toEqual([]);
    old.resolve({ nodes: [node('late', 'late.png')] });
    await old.promise;
    expect(files(render())).toEqual([]);
    driver.state.nodes = [node('new-live', 'new-project.png')];
    driver.state.projectLoadStatus = 'ready';
    expect(files(render()).map((file) => file.name)).toEqual(['new-project.png']);
    expect(driver.load).toHaveBeenCalledTimes(1);
  });
});
