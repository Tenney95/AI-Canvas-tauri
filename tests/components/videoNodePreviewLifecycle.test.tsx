import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
const driver = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>, stateIndex: 0, refIndex: 0, effectIndex: 0,
  callbacks: [] as Array<{ callback: unknown; deps?: readonly unknown[] }>, upload: vi.fn(),
  acquire: vi.fn(), ready: vi.fn(), seek: vi.fn(), rerender: undefined as (() => void) | undefined,
  gesture: false,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, memo: <T,>(value: T) => value, useCallback: <T,>(value: T, deps?: readonly unknown[]) => {
    driver.callbacks.push({ callback: value, deps });
    return value;
  },
    useState: <T,>(initial: T | (() => T)) => {
      const index = driver.stateIndex++;
      if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [driver.states[index], (value: T | ((previous: T) => T)) => {
        driver.states[index] = typeof value === 'function' ? (value as (previous: T) => T)(driver.states[index] as T) : value;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = driver.refIndex++;
      driver.refs[index] ??= { current: initial };
      return driver.refs[index];
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = driver.effectIndex++;
      const previous = driver.effects[index];
      if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
      driver.pending.push(() => {
        previous?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
    },
  };
});
vi.mock('react-dom', () => ({ flushSync: (callback: () => void) => { callback(); driver.rerender?.(); } }));
vi.mock('@xyflow/react', () => ({ Handle: 'handle', Position: { Left: 'left', Right: 'right' } }));
vi.mock('../../src/components/nodes/shared/video/canvasVideoPreviewCache', () => ({
  acquireCanvasVideoPoster: driver.acquire,
  waitForCanvasVideoReady: driver.ready,
  releaseCanvasVideo: (video: FakeVideo | null) => { video?.pause(); video?.removeAttribute('src'); video?.load(); },
}));
vi.mock('../../src/i18n', () => ({ useT: () => (message: string) => message }));
vi.mock('../../src/hooks/useCompletionFlash', () => ({ useCompletionFlash: () => false }));
vi.mock('../../src/hooks/useCanvasNodeLod', () => ({ useCanvasNodeLodProtection: vi.fn() }));
vi.mock('../../src/components/nodes/shared/useNodeRename', () => ({ useNodeRename: () => ({ displayLabel: 'Video', handleRename: vi.fn() }) }));
vi.mock('../../src/components/nodes/shared/useSourceFileUpload', () => ({ useSourceFileUpload: () => ({ isUploading: false, handleUpload: driver.upload }) }));
vi.mock('../../src/services/fileService', () => ({ downloadUrlAndSave: vi.fn(), saveDataUrlToProjectData: vi.fn(), buildNodeFileName: () => 'frame.jpg' }));
vi.mock('../../src/services/clipboardService', () => ({ copyFile: vi.fn() }));
vi.mock('../../src/services/indexedDbService', () => ({ buildVideoEditorProjectId: () => 'editor' }));
vi.mock('../../src/services/videoEditorWindowService', () => ({
  postVideoEditorAiTransitionResult: vi.fn(), postVideoEditorModels: vi.fn(), subscribeVideoEditorWindow: () => vi.fn(),
}));
vi.mock('../../src/services/videoEditorAiTransitionService', () => ({ listVideoEditorVideoModels: vi.fn(), runVideoEditorAiTransition: vi.fn() }));
vi.mock('../../src/store/store.utils', () => ({ blobToDataUrl: async () => 'data:image/jpeg;base64,frame', derivedNodePlacement: () => ({ position: { x: 0, y: 0 } }) }));
vi.mock('../../src/utils/videoSeek', () => ({ seekVideoTo: driver.seek }));

class FakeVideo {
  readyState = 2; videoWidth = 1920; videoHeight = 1080; duration = 10;
  currentTime = 0; paused = true; ended = false; src = 'asset://video.mp4';
  volume = 1; muted = false;
  play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
  pause = vi.fn(() => { this.paused = true; });
  load = vi.fn();
  getAttribute = () => this.src;
  removeAttribute = vi.fn((_name: string) => { this.src = ''; this.readyState = 0; });
}

let Node: (props: { id: string; data: Record<string, unknown>; selected: boolean }) => unknown;
let tree: unknown;
let selected: boolean;
let compact: FakeVideo | undefined;
let fullscreen: FakeVideo | undefined;
let revision: number;
let store: {
  currentProjectId: string; nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }>;
  selectedNodeIds: string[]; getCurrentRevision: () => number;
  updateNodeData: ReturnType<typeof vi.fn>; updateNodeDataTransient: ReturnType<typeof vi.fn>;
  commitToHistory: ReturnType<typeof vi.fn>; openNodeDialog: ReturnType<typeof vi.fn>; showToast: ReturnType<typeof vi.fn>;
  addNode: ReturnType<typeof vi.fn>; setReversePromptRequest: ReturnType<typeof vi.fn>;
};

function all(root: unknown, predicate: (element: Element) => boolean): Element[] {
  if (Array.isArray(root)) return root.flatMap((child) => all(child, predicate));
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const element = root as Element;
  return [...(predicate(element) ? [element] : []), ...all(element.props.children, predicate)];
}
function find(predicate: (element: Element) => boolean) {
  const found = all(tree, predicate)[0];
  if (!found) throw new Error('Missing element');
  return found;
}
function named(name: string) { return find((element) => element.type === name); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function render() {
  driver.stateIndex = driver.refIndex = driver.effectIndex = 0;
  driver.callbacks = [];
  tree = Node({ id: 'video', data: store.nodes[0].data, selected });
  const videos = all(tree, (element) => element.type === 'video');
  const player = videos.find((element) => element.props.className === 'video-preview-player compact');
  if (player) {
    compact ??= new FakeVideo();
    compact.src = player.props.src as string;
    (player.props.ref as { current: unknown }).current = compact;
  } else {
    driver.refs[0].current = null;
    compact = undefined;
  }
  const full = videos.find((element) => element.props.className === 'fullscreen-video-view');
  if (full) {
    fullscreen ??= new FakeVideo();
    (full.props.ref as (video: FakeVideo) => void)(fullscreen);
  } else fullscreen = undefined;
  driver.pending.splice(0).forEach((effect) => effect());
  return tree;
}

beforeEach(async () => {
  vi.resetModules();
  driver.states = []; driver.refs = []; driver.effects = []; driver.pending = [];
  driver.acquire.mockReset().mockReturnValue(new Promise(() => {}));
  driver.ready.mockReset().mockResolvedValue(undefined);
  driver.seek.mockReset().mockImplementation(async (video: FakeVideo, time: number) => { video.currentTime = time; });
  driver.upload.mockReset().mockResolvedValue(null);
  driver.rerender = () => { render(); };
  selected = false; compact = undefined; fullscreen = undefined; revision = 1;
  store = {
    currentProjectId: 'project-a',
    nodes: [{ id: 'video', type: 'ai-video', position: { x: 0, y: 0 }, data: { type: 'ai-video', label: 'Video', videoUrl: 'asset://video.mp4' } }],
    selectedNodeIds: ['video'], getCurrentRevision: () => revision,
    updateNodeData: vi.fn(), updateNodeDataTransient: vi.fn(), commitToHistory: vi.fn(), openNodeDialog: vi.fn(), showToast: vi.fn(),
    addNode: vi.fn(), setReversePromptRequest: vi.fn(),
  };
  const useAppStore = Object.assign(<T,>(selector: (state: typeof store) => T) => selector(store), { getState: () => store });
  vi.doMock('../../src/store/useAppStore', () => ({ useAppStore, generateId: () => 'frame', computeImageNodeDimensions: async () => ({ nodeWidth: 280, nodeHeight: 158 }) }));
  for (const name of ['NodeLabel', 'NodeError', 'GooeyBtn', 'ResizeHandle', 'VideoNodeControls', 'VideoNodeToolbar', 'NodeToolbarShell', 'NodeGenerationProgress']) {
    vi.doMock(`../../src/components/nodes/shared/${name}`, () => ({ default: name }));
  }
  vi.doMock('../../src/components/shared/FullscreenOverlay', () => ({ default: 'FullscreenOverlay' }));
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['frame'])) }) });
  Node = (await import('../../src/components/nodes/VideoNode')).default as unknown as typeof Node;
});

afterEach(() => {
  driver.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe('video node demand loading', () => {
  it('keeps idle nodes free of video players and ignores thumbnailUrl values that actually point at the video', () => {
    store.nodes[0].data.thumbnailUrl = 'asset://video.mp4';
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
    expect(driver.acquire).toHaveBeenCalledWith('asset://video.mp4', expect.any(AbortSignal));
    expect(named('VideoNodeControls').props.active).toBe(false);
    expect(all(tree, (element) => 'onMouseEnter' in element.props || 'onPointerEnter' in element.props)).toHaveLength(0);
  });

  it('uses a supplied image cover without decoding video and retries generation only if that image fails', () => {
    store.nodes[0].data.thumbnailUrl = 'asset://cover.jpg';
    render();
    expect(driver.acquire).not.toHaveBeenCalled();
    const image = find((element) => element.type === 'img' && element.props.src === 'asset://cover.jpg');
    (image.props.onError as () => void)();
    render();
    expect(driver.acquire).toHaveBeenCalledTimes(1);
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
  });

  it('clears the old cover and remote provenance when the upload handler replaces a video source', async () => {
    store.nodes[0].data.thumbnailUrl = 'asset://old-cover.jpg';
    store.nodes[0].data.sourceUrl = 'https://old.example/old-video.mp4';
    driver.upload.mockResolvedValue({ dataUrl: 'asset://new-video.mp4', filePath: 'project/new-video.mp4', fileName: 'new-video.mp4' });
    render();
    // 此回归调用真实上传处理器；当前已有视频的工具栏尚无独立替换入口。
    const upload = driver.callbacks.find(({ deps }) => deps?.includes(driver.upload))?.callback as () => Promise<void>;
    await upload();
    expect(store.updateNodeData).toHaveBeenCalledWith('video', expect.objectContaining({
      videoUrl: 'asset://new-video.mp4', thumbnailUrl: undefined, sourceUrl: undefined,
    }));
    store.nodes[0].data = { ...store.nodes[0].data, ...store.updateNodeData.mock.calls[0][1] };
    render();
    expect(driver.acquire).toHaveBeenCalledWith('asset://new-video.mp4', expect.any(AbortSignal));
    expect(all(tree, (element) => element.type === 'img' && element.props.src === 'asset://old-cover.jpg')).toHaveLength(0);
  });

  it('synchronously mounts the player before the original playback gesture, then unloads it after pause', () => {
    render();
    (named('VideoNodeControls').props.onRequestPlayback as () => void)();
    expect(compact?.play).toHaveBeenCalledOnce();
    expect(named('VideoNodeControls').props.active).toBe(true);
    const video = find((element) => element.type === 'video');
    (video.props.onPlay as () => void)();
    render();
    const oldVideo = compact!;
    oldVideo.currentTime = 4.5;
    oldVideo.volume = 0.3;
    oldVideo.muted = true;
    (video.props.onPause as () => void)();
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
    expect(oldVideo.removeAttribute).toHaveBeenCalledWith('src');
    (named('VideoNodeControls').props.onRequestPlayback as () => void)();
    const next = find((element) => element.type === 'video');
    (next.props.onLoadedMetadata as (event: unknown) => void)({ currentTarget: compact });
    expect(compact?.currentTime).toBe(4.5);
    expect(compact?.volume).toBe(0.3);
    expect(compact?.muted).toBe(true);
  });

  it('loads on selection and releases the paused player when selection moves away', () => {
    selected = true;
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(1);
    const oldVideo = compact!;
    selected = false;
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
    expect(oldVideo.load).toHaveBeenCalled();
  });

  it('does not activate players merely because many nodes are selected, but preserves explicit playback', () => {
    selected = true;
    store.selectedNodeIds = ['video', 'other-video'];
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
    expect(named('VideoNodeControls').props.active).toBe(false);
    (named('VideoNodeControls').props.onRequestPlayback as () => void)();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(1);
    expect(compact?.play).toHaveBeenCalledOnce();
    const player = find((element) => element.type === 'video');
    (player.props.onPlay as () => void)();
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(1);
    (player.props.onPause as () => void)();
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
  });

  it('unloads a paused player when an existing single selection expands into a multiple selection', () => {
    selected = true;
    store.selectedNodeIds = ['video'];
    render();
    const oldVideo = compact!;
    oldVideo.currentTime = 5;
    store.selectedNodeIds = ['video', 'other-video'];
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
    expect(oldVideo.removeAttribute).toHaveBeenCalledWith('src');
    store.selectedNodeIds = ['video'];
    render();
    const player = find((element) => element.type === 'video');
    (player.props.onLoadedMetadata as (event: unknown) => void)({ currentTarget: compact });
    expect(compact?.currentTime).toBe(5);
  });

  it.each([{ ids: [] }, { ids: ['previous-node'] }])('does not activate a stale React Flow selected flag while app selection is $ids', ({ ids }) => {
    selected = true;
    store.selectedNodeIds = ids;
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
    expect(named('VideoNodeControls').props.active).toBe(false);
  });

  it('cancels an obsolete poster result and never overwrites a newer manual canvas revision', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    driver.acquire.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render();
    const firstSignal = driver.acquire.mock.calls[0][1] as AbortSignal;
    store.nodes[0].data = { ...store.nodes[0].data, videoUrl: 'asset://new.mp4' };
    render();
    expect(firstSignal.aborted).toBe(true);
    const stale = { src: 'blob:old', release: vi.fn() };
    first.resolve(stale);
    await first.promise;
    expect(stale.release).toHaveBeenCalled();
    revision++;
    second.resolve({ src: 'blob:new', release: vi.fn(), width: 640, height: 360, videoWidth: 1920, videoHeight: 1080, duration: 10 });
    await second.promise;
    render();
    expect(find((element) => element.type === 'img').props.src).toBe('blob:new');
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
  });

  it('waits for a newly selected video before capturing and rejects a project switch during that wait', async () => {
    const ready = deferred<void>();
    driver.ready.mockReturnValue(ready.promise);
    selected = true;
    render();
    const completion = (named('VideoNodeToolbar').props.onCaptureFrame as () => Promise<void>)();
    expect(store.addNode).not.toHaveBeenCalled();
    expect(store.showToast).not.toHaveBeenCalled();
    store.currentProjectId = 'project-b';
    render();
    expect((driver.ready.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    ready.resolve();
    await completion;
    expect(store.addNode).not.toHaveBeenCalled();
  });

  it('releases the old poster when a source changes to an already supplied cover', async () => {
    const result = deferred<unknown>();
    driver.acquire.mockReturnValue(result.promise);
    render();
    const release = vi.fn();
    result.resolve({ src: 'blob:old', release, width: 640, height: 360, videoWidth: 1920, videoHeight: 1080, duration: 10 });
    await result.promise;
    render();
    store.nodes[0].data = { ...store.nodes[0].data, videoUrl: 'asset://other.mp4', thumbnailUrl: 'asset://other.jpg' };
    render();
    render();
    expect(release).toHaveBeenCalledOnce();
    expect(find((element) => element.type === 'img').props.src).toBe('asset://other.jpg');
  });

  it('completes a requested frame capture once delayed video pixels become ready', async () => {
    const ready = deferred<void>();
    driver.ready.mockReturnValue(ready.promise);
    selected = true;
    render();
    const completion = (named('VideoNodeToolbar').props.onCaptureFrame as () => Promise<void>)();
    expect(store.addNode).not.toHaveBeenCalled();
    ready.resolve();
    await completion;
    expect(store.addNode).toHaveBeenCalledOnce();
    expect(store.addNode.mock.calls[0][0].data.imageUrl).toBe('data:image/jpeg;base64,frame');
  });

  it('continues tracking a capture after readiness and discards its frame when the paused player is unloaded', async () => {
    const seek = deferred<void>();
    driver.seek.mockReturnValue(seek.promise);
    selected = true;
    render();
    const completion = (named('VideoNodeToolbar').props.onCaptureFrame as () => Promise<void>)();
    await Promise.resolve();
    expect(driver.seek).toHaveBeenCalled();
    const signal = driver.ready.mock.calls[0][1] as AbortSignal;
    selected = false;
    store.selectedNodeIds = [];
    render();
    expect(signal.aborted).toBe(true);
    seek.resolve();
    await completion;
    expect(store.addNode).not.toHaveBeenCalled();
    expect(store.showToast).not.toHaveBeenCalled();
  });

  it('suppresses a late seek error after source replacement and does not restore the new video to the old time', async () => {
    const seek = deferred<void>();
    driver.seek.mockReturnValue(seek.promise);
    selected = true;
    render();
    compact!.currentTime = 4;
    const completion = (named('VideoNodeToolbar').props.onCaptureFrame as () => Promise<void>)();
    await Promise.resolve();
    expect(driver.seek).toHaveBeenCalled();
    store.nodes[0].data = { ...store.nodes[0].data, videoUrl: 'asset://new.mp4' };
    render();
    compact!.currentTime = 1;
    compact!.readyState = 2;
    seek.reject(new Error('视频定位超时'));
    await completion;
    expect(compact!.currentTime).toBe(1);
    expect(store.addNode).not.toHaveBeenCalled();
    expect(store.showToast).not.toHaveBeenCalled();
  });

  it('does not emit reverse-prompt frames after the source revision changes while loading', async () => {
    const ready = deferred<void>();
    driver.ready.mockReturnValue(ready.promise);
    selected = true;
    render();
    const completion = (named('VideoNodeToolbar').props.onReversePrompt as () => Promise<void>)();
    revision++;
    ready.resolve();
    await completion;
    expect(store.setReversePromptRequest).not.toHaveBeenCalled();
    expect(store.showToast).not.toHaveBeenCalled();
  });

  it('keeps only one attached player through fullscreen and restores prior playback time', () => {
    selected = true;
    render();
    compact!.currentTime = 3;
    compact!.paused = false;
    (named('VideoNodeToolbar').props.onFullscreen as () => void)();
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(1);
    expect(find((element) => element.type === 'video').props.className).toBe('fullscreen-video-view');
    fullscreen!.currentTime = 7;
    (named('FullscreenOverlay').props.onClose as () => void)();
    render();
    const player = find((element) => element.type === 'video');
    expect(player.props.className).toBe('video-preview-player compact');
    (player.props.onLoadedMetadata as (event: unknown) => void)({ currentTarget: compact });
    expect(compact!.currentTime).toBe(7);
    expect(compact!.play).toHaveBeenCalled();
  });

  it('opens fullscreen at the remembered position after a paused compact player has been unloaded', () => {
    render();
    (named('VideoNodeControls').props.onRequestPlayback as () => void)();
    const player = find((element) => element.type === 'video');
    compact!.currentTime = 4.5;
    (player.props.onPause as () => void)();
    render();
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
    (named('VideoNodeToolbar').props.onFullscreen as () => void)();
    render();
    const full = find((element) => element.type === 'video');
    expect(full.props.className).toBe('fullscreen-video-view');
    (full.props.onLoadedMetadata as (event: unknown) => void)({ currentTarget: fullscreen });
    expect(fullscreen?.currentTime).toBe(4.5);
  });

  it('keeps thumbnail-only fullscreen usable without a video or saved playback record', () => {
    store.nodes[0].data = { type: 'ai-video', thumbnailUrl: 'asset://cover-only.jpg' };
    render();
    const preview = find((element) => typeof element.props.className === 'string' && element.props.className.startsWith('node-preview compact'));
    (preview.props.onDoubleClick as (event: unknown) => void)({ stopPropagation: vi.fn() });
    render();
    expect(named('FullscreenOverlay').props.isOpen).toBe(true);
    expect(all(tree, (element) => element.type === 'video')).toHaveLength(0);
  });
});
