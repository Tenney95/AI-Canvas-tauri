/**
 * nodeCriticalInteractions — 回归测试：image generation history application。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '../../src/services/indexedDbService';
import {
  confirmVideoReferencesBeforeGeneration,
  flushPendingAutoSave,
  type TestNode,
  type TestStore,
  deferred,
  findElement,
  componentName,
  installReactHookDriver,
  createStore,
  installStoreMock,
  mockComfyDeliveries,
  installCommonNodeMocks,
  installShotlistTimelineMock,
} from './nodeCriticalInteractions/nodeFixture';
import { registerEditingControlTests } from './nodeCriticalInteractions/editingControls';
import { registerShotlistEditingTests } from './nodeCriticalInteractions/shotlistEditing';
import { registerImageGenerationTests } from './nodeCriticalInteractions/imageGeneration';
import { registerMediaGenerationTests } from './nodeCriticalInteractions/mediaGeneration';

vi.mock('../../src/hooks/useComfyImageSource', () => ({ useComfyImageSource: (source?: string) => source }));
vi.mock('../../src/hooks/useComfyMediaSource', () => ({ useComfyMediaSource: (source?: string) => source }));

async function setupImageHistoryApplication(currentPath = 'C:/project/current.png', status = 'success') {
  const entry: HistoryRecord = {
    id: 'history-image', projectId: 'project-a', nodeId: 'image-node', nodeLabel: '图片',
    timestamp: 100, prompt: '历史提示词', output: 'https://example.com/history.png',
    mediaUrl: 'https://example.com/history.png', filePath: 'C:/project/history.png',
    nodeType: 'ai-image', model: 'history-model', provider: 'history-provider', status: 'success',
  };
  const effects: Array<() => void | (() => void)> = [];
  await installReactHookDriver((initial, index) => index % 9 === 0 ? [entry] : index % 9 === 1 ? 'project-a' : initial, effects);
  let revision = 1;
  const store = createStore([{
    id: 'image-node', type: 'ai-image', position: { x: 0, y: 0 },
    data: { filePath: currentPath, imageUrl: `asset://localhost/${encodeURIComponent(currentPath)}`,
      prompt: '当前提示词', model: 'current-model', status, nodeWidth: 360, mediaVersion: 5,
      annotation: 'old-annotation', mattingMask: 'old-mask', artifactId: 'old-artifact' },
  }], () => revision);
  installStoreMock(store);
  vi.doMock('../../src/i18n', () => ({ useT: () => (text: string) => text, getLocale: () => 'zh-CN' }));
  vi.doMock('react-dom', () => ({ createPortal: (children: unknown) => children }));
  vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}` }));
  vi.doMock('../../src/services/indexedDbService', () => ({ getNodeHistoryEntries: vi.fn(async () => [entry]) }));
  vi.doMock('../../src/components/shared/ModalOverlay', () => ({ default: function ModalOverlayMock() { return null; } }));
  vi.doMock('../../src/components/shared/PopupCloseButton', () => ({ default: function PopupCloseButtonMock() { return null; } }));
  vi.doMock('../../src/components/shared/FullscreenOverlay', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/ZoomableImage', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/ViewportImage', () => ({ default: () => null }));
  const size = { imageWidth: 1024, imageHeight: 512, nodeWidth: 280, nodeHeight: 142 };
  const dimensions = vi.fn<typeof import('../../src/components/nodes/shared/image/imageUtils').computeImageNodeDimensions>()
    .mockResolvedValue(size);
  vi.doMock('../../src/components/nodes/shared/image/imageUtils', () => ({ computeImageNodeDimensions: dimensions }));
  vi.stubGlobal('document', { body: {} });
  const Dialog = (await import('../../src/components/nodes/shared/image/ImageGenerationHistoryDialog')).default;
  const render = () => Dialog({ isOpen: true, nodeId: 'image-node', onClose: vi.fn() });
  const tree = render();
  const button = findElement(tree, (element) => element.type === 'button'
    && Array.isArray(element.props.children) && ['应用', '当前使用'].includes(element.props.children[1] as string));
  return { store, dimensions, size, tree, button, render, effects, changeRevision: () => { revision += 1; },
    click: () => (button.props.onClick as () => void)() };
}

describe('image generation history application', () => {
  afterEach(() => {
    vi.doUnmock('../../src/i18n');
    vi.doUnmock('react-dom');
    vi.doUnmock('@tauri-apps/api/core');
    vi.doUnmock('../../src/services/indexedDbService');
    vi.doUnmock('../../src/components/shared/ModalOverlay');
    vi.doUnmock('../../src/components/shared/PopupCloseButton');
    vi.doUnmock('../../src/components/shared/FullscreenOverlay');
    vi.doUnmock('../../src/components/shared/ZoomableImage');
    vi.doUnmock('../../src/components/shared/ViewportImage');
    vi.doUnmock('../../src/components/nodes/shared/image/imageUtils');
  });

  it('applies a historical image through the Store action while retaining generation settings', async () => {
    const setup = await setupImageHistoryApplication();
    setup.click();
    await vi.waitFor(() => expect(setup.store.updateNodeData).toHaveBeenCalledTimes(1));
    expect(setup.store.nodes[0].data).toMatchObject({
      imageUrl: 'asset://localhost/C%3A%2Fproject%2Fhistory.png',
      thumbnailUrl: 'asset://localhost/C%3A%2Fproject%2Fhistory.png', filePath: 'C:/project/history.png',
      prompt: '当前提示词', model: 'current-model', imageWidth: 1024, imageHeight: 512,
      nodeWidth: 360, nodeHeight: 182, mediaVersion: 6,
      annotation: undefined, mattingMask: undefined, artifactId: undefined,
    });
    const currentButton = findElement(setup.render(), (element) => element.type === 'button'
      && Array.isArray(element.props.children) && element.props.children[1] === '当前使用');
    expect(currentButton.props.disabled).toBe(true);
  });

  it('recognizes the current Windows path despite slash and case differences', async () => {
    const setup = await setupImageHistoryApplication('c:\\PROJECT\\history.png');
    expect(setup.button.props.disabled).toBe(true);
    setup.click();
    expect(setup.dimensions).not.toHaveBeenCalled();
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
  });

  it('falls back to the media link without retaining an unavailable local file', async () => {
    const setup = await setupImageHistoryApplication();
    setup.dimensions.mockResolvedValueOnce({ nodeWidth: 280, nodeHeight: 158 });
    setup.click();
    await vi.waitFor(() => expect(setup.store.updateNodeData).toHaveBeenCalledTimes(1));
    expect(setup.dimensions).toHaveBeenNthCalledWith(2, 'https://example.com/history.png');
    expect(setup.store.nodes[0].data).toMatchObject({
      imageUrl: 'https://example.com/history.png', filePath: undefined, fileName: undefined,
    });
  });

  it('retains the current result when both image sources fail', async () => {
    const setup = await setupImageHistoryApplication();
    setup.dimensions.mockResolvedValue({ nodeWidth: 280, nodeHeight: 158 });
    setup.click();
    await vi.waitFor(() => expect(setup.store.showToast).toHaveBeenCalledWith('图片加载失败', 'error'));
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
    expect(setup.store.nodes[0].data.filePath).toBe('C:/project/current.png');
  });

  it.each(['project', 'revision', 'node', 'close', 'unmount'] as const)('rejects a late image after %s changes', async (change) => {
    const setup = await setupImageHistoryApplication();
    const pending = deferred<typeof setup.size>();
    setup.dimensions.mockReturnValueOnce(pending.promise);
    setup.click();
    setup.click();
    expect(setup.dimensions).toHaveBeenCalledTimes(1);
    if (change === 'project') setup.store.currentProjectId = 'project-b';
    if (change === 'revision') setup.changeRevision();
    if (change === 'node') setup.store.nodes = [];
    if (change === 'close') {
      const modal = findElement(setup.tree, (element) => componentName(element) === 'ModalOverlayMock');
      (modal.props.onClose as () => void)();
    }
    if (change === 'unmount') {
      const cleanup = setup.effects[0]();
      if (typeof cleanup !== 'function') throw new Error('Missing application cleanup');
      cleanup();
    }
    pending.resolve(setup.size);
    await pending.promise;
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
    expect(setup.store.showToast).not.toHaveBeenCalled();
  });

  it('does not replace a result while the node is generating', async () => {
    const setup = await setupImageHistoryApplication(undefined, 'loading');
    expect(setup.button.props.disabled).toBe(true);
    setup.click();
    expect(setup.dimensions).not.toHaveBeenCalled();
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/services/generationService');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // These component tests cover delegation; the real reference guard has its own suite.
  confirmVideoReferencesBeforeGeneration.mockReset().mockResolvedValue(true);
  vi.doMock('../../src/services/videoReferenceConfirmation', () => ({ confirmVideoReferencesBeforeGeneration }));
  flushPendingAutoSave.mockReset().mockResolvedValue(true);
  vi.doMock('../../src/hooks/useAutoSave', () => ({ flushPendingAutoSave }));
  // The hook driver renders element trees directly, including the dialog's body portal.
  vi.doMock('react-dom', () => ({ createPortal: (children: unknown) => children }));
  vi.stubGlobal('document', { body: {}, documentElement: { getAttribute: () => null } });
});

describe('audio node clock and waveform ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const path of ['../../src/hooks/useViewportMediaSource', '../../src/components/nodes/shared/audio/useAudioNodeAsr',
      '../../src/components/nodes/shared/audio/audioWaveformCache', '../../src/components/nodes/shared/AudioNodeToolbar',
      '../../src/components/nodes/shared/MediaTaskStatus', '../../src/components/shared/CanvasAudioPreview',
      '../../src/components/shared/ModelDownloadDialog', '../../src/components/shared/FullscreenOverlay']) vi.doUnmock(path);
  });
  async function setupAudioNode(data: TestNode['data'] = { type: 'ai-audio', audioUrl: 'asset://tone.wav' }) {
    const effects: Array<() => void | (() => void)> = [];
    const setters: Array<ReturnType<typeof vi.fn>> = [];
    await installReactHookDriver(undefined, effects, undefined, setters);
    const node: TestNode = { id: 'audio', type: 'ai-audio', position: { x: 0, y: 0 }, data };
    const store = createStore([node], () => 1);
    const upload = vi.fn<ReturnType<typeof import('../../src/components/nodes/shared/useSourceFileUpload').useSourceFileUpload>['handleUpload']>()
      .mockResolvedValue(null);
    installStoreMock(store);
    installCommonNodeMocks(upload);
    vi.doMock('@xyflow/react', () => ({ Handle: () => null, Position: { Left: 'left', Right: 'right' } }));
    vi.doMock('../../src/hooks/useViewportMediaSource', () => ({ useViewportMediaSource: (source?: string) => source }));
    vi.doMock('../../src/components/nodes/shared/audio/useAudioNodeAsr', () => ({ useAudioNodeAsr: () => ({}) }));
    const pending = deferred<{ peaks: number[]; duration: number }>();
    const acquire = vi.fn<(_source: string, _signal: AbortSignal) => Promise<{ peaks: number[]; duration: number }>>(() => pending.promise);
    vi.doMock('../../src/components/nodes/shared/audio/audioWaveformCache', () => ({ WAVEFORM_COLUMNS: 220, acquireAudioWaveform: acquire }));
    vi.doMock('../../src/components/nodes/shared/AudioNodeToolbar', () => ({ default: () => null }));
    vi.doMock('../../src/components/nodes/shared/MediaTaskStatus', () => ({ default: () => null }));
    vi.doMock('../../src/components/shared/CanvasAudioPreview', () => ({ default: () => null }));
    // 这里只驱动父节点的播放时钟；未挂载的下载和全屏子树不应冷导入整套运行时。
    vi.doMock('../../src/components/shared/ModelDownloadDialog', () => ({ default: () => null }));
    vi.doMock('../../src/components/shared/FullscreenOverlay', () => ({ default: () => null }));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('window', {});
    const AudioNode = (await import('../../src/components/nodes/AudioNode')).default as unknown as (props: { id: string; data: Record<string, unknown>; selected: boolean }) => unknown;
    const tree = AudioNode({ id: node.id, data: node.data, selected: true });
    return { tree, store, upload, effects, setters, frames, pending, acquire };
  }

  async function setup() {
    const node = await setupAudioNode();
    const { tree } = node;
    const audio = { currentTime: 1.875, duration: 60, paused: true,
      play: vi.fn(async () => { audio.paused = false; }), pause: vi.fn(() => { audio.paused = true; }) };
    const context = { clearRect: vi.fn() };
    const canvas = { width: 220, height: 80, getContext: vi.fn(() => context) };
    (findElement(tree, (element) => element.type === 'audio').props.ref as { current: unknown }).current = audio;
    (findElement(tree, (element) => element.type === 'canvas').props.ref as { current: unknown }).current = canvas;
    const waveform = findElement(tree, (element) => element.props.className === 'audio-waveform-wrapper');
    return { ...node, audio, canvas, waveform };
  }

  it('opens source audio upload from the center and the selected toolbar through one handler', async () => {
    const { tree, store, upload } = await setupAudioNode({ type: 'ai-audio', role: 'source' });
    const placeholder = findElement(tree, (element) => element.type === 'button'
      && String(element.props.className).includes('node-preview-placeholder'));
    const toolbar = findElement(tree, (element) => typeof element.props.onUpload === 'function');
    const toolbarShell = findElement(tree, (element) => element.props.children === toolbar);
    expect(placeholder.props.className).toContain('nodrag nopan');
    expect(toolbar.props.hasAudio).toBe(false);
    expect(toolbarShell.props.visible).toBe(true);
    expect(() => findElement(tree, (element) => element.props.className === 'node-upload-btn')).toThrow('Element not found');

    const result = { dataUrl: 'asset://tone.wav', filePath: '/project/tone.wav', fileName: 'tone.wav', fileSize: 1024 };
    const pending = deferred<typeof result>();
    upload.mockReturnValueOnce(pending.promise);
    const stopPropagation = vi.fn();
    (placeholder.props.onClick as (event: unknown) => void)({ stopPropagation });
    await (toolbar.props.onUpload as () => Promise<void>)();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();

    pending.resolve(result);
    await pending.promise;
    expect(store.updateNodeData).toHaveBeenCalledWith('audio', {
      audioUrl: result.dataUrl, filePath: result.filePath, fileName: result.fileName, label: result.fileName, status: 'success',
    });
    await (toolbar.props.onUpload as () => Promise<void>)();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('publishes whole display seconds while fullscreen keeps the exact playback position', async () => {
    const { waveform, frames, audio, setters } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    (waveform.props.onPointerDownCapture as () => void)();
    (waveform.props.onClick as (event: unknown) => void)({ detail: 1, stopPropagation: vi.fn() });
    vi.advanceTimersByTime(250);
    await Promise.resolve();
    frames.at(-1)!(0);
    expect(setters[2]).toHaveBeenLastCalledWith(1);
    audio.currentTime = 2.875;
    frames.at(-1)!(16);
    expect(setters[2]).toHaveBeenLastCalledWith(2);
    (waveform.props.onDoubleClick as (event: unknown) => void)({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(setters[4]).toHaveBeenLastCalledWith({ projectId: 'project-a', time: 2.875, playing: true });
  });

  it('releases its waveform consumer on unmount and ignores a late completed result', async () => {
    const { effects, acquire, pending, canvas } = await setup();
    const cleanup = effects[1]();
    const signal = acquire.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    cleanup?.();
    expect(signal.aborted).toBe(true);
    pending.resolve({ peaks: [1], duration: 1 });
    await pending.promise; await Promise.resolve();
    expect(canvas.getContext).not.toHaveBeenCalled();
  });
});

async function setupImageFullscreen() {
  const effects: Array<() => void | (() => void)> = [];
  const setters: Array<ReturnType<typeof vi.fn>> = [];
  await installReactHookDriver(undefined, effects, undefined, setters);
  let revision = 1;
  const store = createStore([{
    id: 'image-source', type: 'ai-image', position: { x: 20, y: 30 },
    data: { type: 'ai-image', label: '原图', imageUrl: 'asset://localhost/image.png', filePath: '/project/image.png', mediaVersion: 1 },
  }], () => revision);
  installStoreMock(store);
  installCommonNodeMocks();
  vi.doMock('@xyflow/react', () => ({ Handle: () => null, Position: { Left: 'left', Right: 'right' } }));
  vi.doMock('../../src/components/nodes/shared/image/ImageNodeToolbar', () => ({ default: () => null }));
  // 这里只执行父节点的开图保存屏障；预览/轮询子组件不渲染，避免冷导入整套媒体服务。
  vi.doMock('../../src/components/shared/FullscreenOverlay', () => ({ default: () => null }));
  vi.doMock('../../src/components/nodes/shared/NodeLabel', () => ({ default: () => null }));
  vi.doMock('../../src/components/nodes/shared/ResizeHandle', () => ({ default: () => null }));
  vi.doMock('../../src/components/nodes/shared/NodeError', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/CanvasImagePreview', () => ({ default: () => null }));
  vi.doMock('../../src/components/nodes/shared/MediaTaskStatus', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/ModelDownloadDialog', () => ({ default: () => null, DOWNLOAD_MASCOT_EVENT: 'ai-canvas:download-mascot' }));
  vi.doMock('../../src/components/nodes/shared/image/CanvasPreviewImage', () => ({ default: () => null }));
  vi.doMock('../../src/hooks/useCanvasNodeLod', () => ({ useCanvasNodeLodPreviewRevision: () => undefined, useCanvasNodeLodProtection: () => {} }));
  vi.doMock('../../src/components/nodes/shared/image/useImageNodeOnnxActions', () => ({ useImageNodeOnnxActions: () => ({}) }));
  vi.doMock('../../src/components/nodes/shared/image/imageUtils', () => ({ computeImageNodeDimensions: vi.fn() }));
  vi.doMock('../../src/services/fileService', () => ({ buildNodeFileName: vi.fn(), saveDataUrlToProjectData: vi.fn() }));
  vi.doMock('../../src/services/clipboardService', () => ({ copyImage: vi.fn() }));
  vi.doMock('../../src/services/generationService', () => ({ executeGeneration: vi.fn() }));
  vi.doMock('../../src/services/imagePromptOverflowService', () => ({ executeGenerationWithImagePromptChoice: vi.fn() }));
  vi.doMock('../../src/store/store.utils', () => ({ blobToDataUrl: vi.fn() }));
  vi.doMock('../../src/components/nodes/shared/toolbar/presetAction', () => ({ createPresetNode: vi.fn() }));
  const ImageNode = (await import('../../src/components/nodes/ImageNode')).default as unknown as (
    props: { id: string; data: Record<string, unknown>; selected: boolean },
  ) => unknown;
  const renderNode = (id: string) => {
    const offset = setters.length;
    const tree = ImageNode({ id, data: store.nodes.find((node) => node.id === id)!.data, selected: true });
    const toolbar = findElement(tree, (element) => typeof element.props.onFullscreen === 'function');
    return { setters: setters.slice(offset), open: toolbar.props.onFullscreen as () => Promise<void> };
  };
  const first = renderNode('image-source');
  return { store, setters: first.setters, effects, open: first.open, renderNode,
    changeRevision: () => { revision++; } };
}

describe('image fullscreen save barrier', () => {
  afterEach(() => {
    for (const path of [
      '@xyflow/react', '../../src/components/nodes/shared/image/ImageNodeToolbar',
      '../../src/components/shared/FullscreenOverlay', '../../src/components/nodes/shared/NodeLabel',
      '../../src/components/nodes/shared/ResizeHandle', '../../src/components/nodes/shared/NodeError',
      '../../src/components/shared/CanvasImagePreview', '../../src/components/nodes/shared/MediaTaskStatus',
      '../../src/components/shared/ModelDownloadDialog', '../../src/components/nodes/shared/image/CanvasPreviewImage',
      '../../src/hooks/useCanvasNodeLod', '../../src/components/nodes/shared/image/useImageNodeOnnxActions',
      '../../src/components/nodes/shared/image/imageUtils', '../../src/services/fileService',
      '../../src/services/clipboardService',
      '../../src/services/generationService', '../../src/services/imagePromptOverflowService', '../../src/store/store.utils',
      '../../src/components/nodes/shared/toolbar/presetAction',
    ]) vi.doUnmock(path);
  });

  it('waits for the actual save before opening, coalesces repeated clicks and preserves the original', async () => {
    const setup = await setupImageFullscreen();
    const original = structuredClone(setup.store.nodes[0]);
    const saved = deferred<boolean>();
    flushPendingAutoSave.mockReturnValueOnce(saved.promise);
    const first = setup.open();
    await setup.open();
    expect(flushPendingAutoSave).toHaveBeenCalledExactlyOnceWith('project-a');
    expect(setup.setters[3]).not.toHaveBeenCalledWith(true);
    saved.resolve(true);
    await first;
    expect(setup.setters[2]).toHaveBeenCalledWith('project-a');
    expect(setup.setters[3]).toHaveBeenCalledWith(true);
    expect(setup.store.nodes[0]).toEqual(original);
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
    expect(setup.store.commitToHistory).not.toHaveBeenCalled();
  });

  it('opens only the latest image when two nodes share the same pending save', async () => {
    const setup = await setupImageFullscreen();
    setup.store.nodes = [...setup.store.nodes, { ...setup.store.nodes[0], id: 'image-second',
      data: { ...setup.store.nodes[0].data, imageUrl: 'blob:second' } }];
    const second = setup.renderNode('image-second');
    const saved = deferred<boolean>();
    flushPendingAutoSave.mockReturnValue(saved.promise);
    const firstOpening = setup.open();
    setup.store.selectedNodeIds = ['image-second'];
    const secondOpening = second.open();
    saved.resolve(true);
    await Promise.all([firstOpening, secondOpening]);
    expect(setup.setters[3]).not.toHaveBeenCalledWith(true);
    expect(second.setters[3]).toHaveBeenCalledWith(true);
    expect(setup.store.showToast).not.toHaveBeenCalled();
  });

  it.each(['false', 'reject'] as const)('keeps the canvas and reports a fixed error when saving returns %s', async (failure) => {
    const setup = await setupImageFullscreen();
    if (failure === 'false') flushPendingAutoSave.mockResolvedValue(false);
    else flushPendingAutoSave.mockRejectedValue(new Error('/private/secret/project save failed'));
    await setup.open();
    expect(setup.setters[3]).not.toHaveBeenCalledWith(true);
    expect(setup.store.showToast).toHaveBeenCalledExactlyOnceWith('保存失败，编辑内容已保留', 'error');
    expect(setup.store.nodes).toHaveLength(1);
    flushPendingAutoSave.mockResolvedValue(true);
    await setup.open();
    expect(setup.setters[3]).toHaveBeenCalledWith(true);
  });

  it.each(['project', 'revision', 'node', 'imageUrl', 'filePath', 'mediaVersion', 'unmount'] as const)(
    'rejects late fullscreen opening after %s changes while saving', async (change) => {
      const setup = await setupImageFullscreen();
      const saved = deferred<boolean>();
      flushPendingAutoSave.mockReturnValue(saved.promise);
      const pending = setup.open();
      if (change === 'project') setup.store.currentProjectId = 'project-b';
      if (change === 'revision') setup.changeRevision();
      if (change === 'node') setup.store.nodes = [];
      if (change === 'imageUrl') setup.store.nodes[0].data = { ...setup.store.nodes[0].data, imageUrl: 'blob:replacement' };
      if (change === 'filePath') setup.store.nodes[0].data = { ...setup.store.nodes[0].data, filePath: '/project/new.png' };
      if (change === 'mediaVersion') setup.store.nodes[0].data = { ...setup.store.nodes[0].data, mediaVersion: 2 };
      if (change === 'unmount') setup.effects.forEach((effect) => { const dispose = effect(); if (dispose) dispose(); });
      saved.resolve(true);
      await pending;
      expect(setup.setters[3]).not.toHaveBeenCalledWith(true);
      expect(setup.store.showToast).not.toHaveBeenCalled();
    },
  );
});



/** 只测工作流编辑与关闭回调，生成服务不在本用例执行范围内。 */


describe('critical canvas node interactions', () => {
  registerEditingControlTests();

  registerShotlistEditingTests();

  it('NodeGenerationProgress renders real ComfyUI value and percent for the current project', async () => {
    await installReactHookDriver();
    const store = createStore([], () => 1);
    store.comfyNodeProgress['node-1'] = {
      projectId: 'project-a',
      nodeId: 'node-1',
      requestId: 'request-1',
      clientId: 'client-1',
      stage: 'running',
      value: 6,
      max: 12,
      percent: 50,
      executingNodeId: '12',
      executingNodeLabel: '视频采样',
      cachedNodeCount: 8,
      updatedAt: 1,
    };
    installStoreMock(store);
    const { default: NodeGenerationProgress } = await import('../../src/components/nodes/shared/NodeGenerationProgress');

    const rendered = NodeGenerationProgress({ nodeId: 'node-1', fallbackLabel: '生成图像中...' });
    const progressbar = findElement(rendered, (element) => element.props.role === 'progressbar');
    const detail = findElement(rendered, (element) => element.props.children === '6 / 12 · 50%');

    expect(progressbar.props['aria-valuenow']).toBe(50);
    expect(progressbar.props['aria-label']).toBe('ComfyUI 当前节点进度');
    expect(detail).toBeTruthy();
    expect(findElement(rendered, (element) => element.props.children === '#12 · 视频采样')).toBeTruthy();
    expect(findElement(rendered, (element) => element.props.title === '已复用 8 个缓存节点')).toBeTruthy();
  });

  it('ComfyUI waiting and finalizing never display a stale node percentage', async () => {
    await installReactHookDriver();
    const store = createStore([], () => 1);
    store.comfyNodeProgress['node-1'] = {
      projectId: 'project-a', nodeId: 'node-1', requestId: 'request', clientId: 'client',
      stage: 'queued', queuePosition: 3, value: 12, max: 12, percent: 100, updatedAt: 1,
    };
    installStoreMock(store);
    const { default: NodeGenerationProgress } = await import('../../src/components/nodes/shared/NodeGenerationProgress');
    const waiting = NodeGenerationProgress({ nodeId: 'node-1', fallbackLabel: '生成视频中...', overlay: true });
    expect(findElement(waiting, (element) => element.props.children === '等待队列第 3 位')).toBeTruthy();
    expect(findElement(waiting, (element) => element.props.role === 'progressbar').props['aria-valuenow']).toBeUndefined();
    expect(waiting.props.className).toBe('generation-progress-overlay');

    store.comfyNodeProgress['node-1'].stage = 'finalizing';
    const finalizing = NodeGenerationProgress({ nodeId: 'node-1', fallbackLabel: '生成视频中...' });
    expect(findElement(finalizing, (element) => element.props.children === '执行已结束，等待结果回传')).toBeTruthy();
    expect(findElement(finalizing, (element) => element.props.role === 'progressbar').props['aria-valuenow']).toBeUndefined();
  });

  it('ComfyUI fallback explains unavailable step progress and does not leak another project status', async () => {
    await installReactHookDriver();
    const store = createStore([], () => 1);
    store.comfyNodeProgress['node-1'] = {
      projectId: 'project-a', nodeId: 'node-1', requestId: 'request', clientId: 'client',
      stage: 'running', transport: 'polling', updatedAt: 1,
    };
    installStoreMock(store);
    const { default: NodeGenerationProgress } = await import('../../src/components/nodes/shared/NodeGenerationProgress');
    const render = () => NodeGenerationProgress({ nodeId: 'node-1', fallbackLabel: '生成视频中...' });
    expect(findElement(render(), (element) => element.props.children === '正在查询任务状态').props.title)
      .toBe('正在查询任务状态，步骤进度暂不可用');
    store.comfyNodeProgress['node-1'].connectionIssue = 'forbidden';
    expect(findElement(render(), (element) => element.props.children === '进度访问被拒绝（403），仍在查询结果').props.title)
      .toContain('请检查 ComfyUI 服务或网关的访问权限');
    store.comfyNodeProgress['node-1'].projectId = 'other-project';
    expect(() => findElement(render(), (element) => element.props.role === 'progressbar')).toThrow('Element not found');
  });

  it('generation timing keeps total elapsed time while measuring the current ComfyUI node separately', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await installReactHookDriver();
    const store = createStore([{ id: 'video', type: 'ai-video', position: { x: 0, y: 0 },
      data: { type: 'ai-video', status: 'loading', generationStartedAt: 880_000 } }], () => 1);
    installStoreMock(store);
    const { GenerationWaitTime } = await import('../../src/components/nodes/shared/NodeGenerationProgress');
    const timing = GenerationWaitTime({ nodeId: 'video', nodeStartedAt: 990_000 });
    expect(findElement(timing, (element) => element.props.children === '已等待 02:00')).toBeTruthy();
    expect(findElement(timing, (element) => element.props.children === '本节点 00:10')).toBeTruthy();
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    store.nodes[0].data.videoTaskState = 'paused';
    store.nodes[0].data.status = 'idle';
    now.mockReturnValue(1_060_000);
    expect(findElement(GenerationWaitTime({ nodeId: 'video' }), (element) => element.props.children === '已等待 03:00')).toBeTruthy();
  });

  it('NodeContextMenu exposes character capture only when the callback is available', async () => {
    await installReactHookDriver();
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800 });
    const { NodeContextMenu } = await import('../../src/components/canvas/NodeContextMenu');
    const baseProps = {
      visible: true,
      position: { x: 10, y: 10 },
      menuRef: { current: null },
      onCopy: vi.fn(),
      onCut: vi.fn(),
      onDuplicate: vi.fn(),
      onToggleLock: vi.fn(),
      isLocked: false,
      onDelete: vi.fn(),
    };

    const withCapture = NodeContextMenu({ ...baseProps, onAddToCharacter: vi.fn() });
    expect(findElement(
      withCapture,
      (element) => element.type === 'span' && element.props.children === '添加到角色库…',
    )).toBeTruthy();

    const withoutCapture = NodeContextMenu(baseProps);
    expect(() => findElement(
      withoutCapture,
      (element) => element.type === 'span' && element.props.children === '添加到角色库…',
    )).toThrow('Element not found');
  });

  describe.each(['crop', 'compose'] as const)('ImageNode %s result saving', (operation) => {
    const suffix = operation === 'crop' ? 'cropped' : 'composed';
    const failureMessage = operation === 'crop' ? '裁切失败，请重试' : '合成失败，请重试';
    const successMessage = operation === 'crop' ? '裁切完成，已创建新节点' : '合成完成，已创建新节点';

    async function setup(projectId = 'project-a') {
      let revision = 1;
      const store = createStore([{
        id: 'image-source', type: 'ai-image', position: { x: 20, y: 30 },
        data: { type: 'ai-image', label: 'Source image', imageUrl: 'data:image/png;base64,source' },
      }], () => revision);
      store.currentProjectId = projectId;
      if (projectId === 'default') store.projects.push({ id: 'default' });
      const saved = { assetUrl: 'asset://result.png', filePath: 'data/result.png' };
      const measured = { imageWidth: 640, imageHeight: 360, nodeWidth: 200, nodeHeight: 120 };
      const saveFile = vi.fn<typeof import('../../src/services/fileService').saveDataUrlToProjectData>().mockResolvedValue(saved);
      const dimensions = vi.fn<typeof import('../../src/components/nodes/shared/image/imageUtils').computeImageNodeDimensions>()
        .mockResolvedValue(measured);
      const buildName = vi.fn((_label: string, _extension: string, fallback: string) => `${fallback}.png`);
      // The existing hook driver opens one lazy editor by its useState position.
      const editorStateIndex = operation === 'crop' ? 6 : 8;
      await installReactHookDriver((initialValue, index) => index === editorStateIndex ? true : initialValue);
      installStoreMock(store);
      installCommonNodeMocks();
      vi.doMock('../../src/components/nodes/shared/image/imageUtils', () => ({ computeImageNodeDimensions: dimensions }));
      vi.doMock('../../src/services/fileService', () => ({ buildNodeFileName: buildName, saveDataUrlToProjectData: saveFile }));
      vi.doMock('../../src/services/clipboardService', () => ({ copyImage: vi.fn() }));
      vi.doMock('../../src/services/onnxService', () => ({
        imageUpscale: vi.fn(), subjectMatting: vi.fn(), checkModelExists: vi.fn(), downloadModel: vi.fn(),
      }));
      vi.doMock('../../src/services/generationService', () => ({ executeGeneration: vi.fn() }));
      vi.doMock('../../src/store/store.utils', () => ({ blobToDataUrl: vi.fn() }));
      vi.doMock('../../src/components/nodes/shared/toolbar/presetAction', () => ({ createPresetNode: vi.fn() }));
      const ImageNode = (await import('../../src/components/nodes/ImageNode')).default as unknown as (
        props: { id: string; data: Record<string, unknown>; selected: boolean },
      ) => unknown;
      const tree = ImageNode({ id: 'image-source', data: store.nodes[0].data, selected: true });
      const editor = findElement(tree, (element) => (
        typeof element.props.onStart === 'function' && typeof element.props.onSave === 'function'
      ));
      return { store, saved, measured, saveFile, dimensions, buildName,
        start: editor.props.onStart as () => void,
        save: editor.props.onSave as (url: string, metadata?: { width: number; height: number }) => Promise<void>,
        invalidate: () => { revision += 1; } };
    }

    it.each(['saving', 'measuring'] as const)('cancels a result that becomes stale during %s', async (stage) => {
      const current = await setup();
      const saving = deferred<typeof current.saved>();
      const measuring = deferred<typeof current.measured>();
      if (stage === 'saving') current.saveFile.mockImplementationOnce(() => saving.promise);
      else current.dimensions.mockImplementationOnce(() => measuring.promise);
      current.start();
      const completion = current.save('data:image/png;base64,result');
      if (stage === 'measuring') await vi.waitFor(() => expect(current.dimensions).toHaveBeenCalledOnce());
      else expect(current.saveFile).toHaveBeenCalledOnce();
      current.invalidate();
      if (stage === 'saving') saving.resolve(current.saved);
      else measuring.resolve(current.measured);
      await completion;
      expect(current.store.nodes.map((node) => node.id)).toEqual(['image-source']);
      expect(current.store.updateNodeDataTransient).not.toHaveBeenCalled();
      expect(current.store.commitToHistory).not.toHaveBeenCalled();
      expect(current.store.showToast).not.toHaveBeenCalled();
      if (stage === 'saving') expect(current.dimensions).not.toHaveBeenCalled();
    }, 20_000);

    it.each(['saving', 'measuring'] as const)('removes its placeholder and reports a %s failure without committing', async (stage) => {
      const current = await setup();
      if (stage === 'saving') current.saveFile.mockRejectedValueOnce(new Error('save fixture'));
      else current.dimensions.mockRejectedValueOnce(new Error('measure fixture'));
      current.start();
      await current.save('data:image/png;base64,result');
      expect(current.store.nodes.map((node) => node.id)).toEqual(['image-source']);
      expect(current.store.updateNodeDataTransient).not.toHaveBeenCalled();
      expect(current.store.commitToHistory).not.toHaveBeenCalled();
      expect(current.store.showToast).toHaveBeenCalledExactlyOnceWith(failureMessage, 'error');
    }, 20_000);

    it.each(['project-a', 'default'])('keeps naming, metadata priority and commit order in %s', async (projectId) => {
      const current = await setup(projectId);
      const metadata = projectId === 'default' ? undefined : { width: 1024, height: 512 };
      const dataUrl = 'data:image/png;base64,result';
      current.start();
      await current.save(dataUrl, metadata);
      expect(current.store.updateNodeDataTransient).toHaveBeenCalledExactlyOnceWith('node-generated', {
        imageUrl: projectId === 'default' ? dataUrl : current.saved.assetUrl,
        filePath: projectId === 'default' ? undefined : current.saved.filePath,
        status: 'success', imageWidth: metadata?.width ?? current.measured.imageWidth,
        imageHeight: metadata?.height ?? current.measured.imageHeight,
        nodeWidth: current.measured.nodeWidth, nodeHeight: current.measured.nodeHeight,
      });
      if (projectId === 'default') {
        expect(current.saveFile).not.toHaveBeenCalled();
        expect(current.buildName).not.toHaveBeenCalled();
      } else {
        expect(current.buildName).toHaveBeenCalledExactlyOnceWith(
          operation === 'crop' ? 'Source image 裁切' : 'Source image 合成', 'png', suffix,
        );
        expect(current.saveFile).toHaveBeenCalledExactlyOnceWith(dataUrl, projectId, `${suffix}.png`);
      }
      expect(current.store.commitToHistory).toHaveBeenCalledOnce();
      expect(current.store.showToast).toHaveBeenCalledExactlyOnceWith(successMessage);
      expect(current.store.updateNodeDataTransient.mock.invocationCallOrder[0])
        .toBeLessThan(current.store.commitToHistory.mock.invocationCallOrder[0]);
      expect(current.store.commitToHistory.mock.invocationCallOrder[0])
        .toBeLessThan(current.store.showToast.mock.invocationCallOrder[0]);
    }, 20_000);
  });

  it('VideoNode does not create a frame node after its derivation becomes stale', async () => {
    let revision = 1;
    const dimensions = deferred<{ nodeWidth: number; nodeHeight: number }>();
    const store = createStore([{
      id: 'video-source',
      type: 'ai-video',
      position: { x: 20, y: 30 },
      data: { type: 'ai-video', label: 'Source video', videoUrl: 'asset://video.mp4' },
    }], () => revision);

    await installReactHookDriver();
    installCommonNodeMocks();
    const useAppStore = Object.assign(
      <T,>(selector: (state: TestStore) => T) => selector(store),
      { getState: () => store },
    );
    vi.doMock('../../src/store/useAppStore', () => ({
      generateId: () => 'frame',
      computeImageNodeDimensions: () => dimensions.promise,
      useAppStore,
    }));
    vi.doMock('../../src/components/nodes/shared/VideoNodeToolbar', () => ({
      default: function VideoNodeToolbarMock() { return null; },
    }));
    vi.doMock('../../src/components/shared/VideoPlayer', () => ({
      default: function VideoPlayerMock() { return null; },
    }));
    vi.doMock('../../src/services/fileService', () => ({
      buildNodeFileName: () => 'frame.png',
      saveDataUrlToProjectData: vi.fn(),
      downloadUrlAndSave: vi.fn(),
    }));
    vi.doMock('../../src/services/clipboardService', () => ({ copyFile: vi.fn() }));
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => 'data:image/png;base64,frame',
      }),
    });

    const VideoNode = (await import('../../src/components/nodes/VideoNode')).default as unknown as (
      props: { id: string; data: Record<string, unknown>; selected: boolean },
    ) => unknown;
    store.selectedNodeIds = ['video-source'];
    const tree = VideoNode({ id: 'video-source', data: store.nodes[0].data, selected: true });
    const video = findElement(tree, (element) => componentName(element) === 'VideoPlayerMock' && element.props.compact === true);
    const toolbar = findElement(tree, (element) => componentName(element) === 'VideoNodeToolbarMock');
    (video.props.mediaRef as (video: unknown) => void)({
      readyState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      currentTime: 12.5,
    });

    const completion = (toolbar.props.onCaptureFrame as () => Promise<void>)();
    revision = 2;
    dimensions.resolve({ nodeWidth: 280, nodeHeight: 158 });
    await completion;

    expect(store.addNode).not.toHaveBeenCalled();
    expect(store.showToast).not.toHaveBeenCalledWith('已截取当前帧为图像节点', 'success');
  });

  it('StoryboardNode rolls back its placeholder and extracted flag after a revision race', async () => {
    let revision = 1;
    const cropResult = deferred<{ dataUrl: string; width: number; height: number }>();
    const source: TestNode = {
      id: 'storyboard',
      type: 'ai-storyboard',
      position: { x: 0, y: 0 },
      data: {
        type: 'ai-storyboard',
        label: 'Storyboard',
        imageUrl: 'data:image/png;base64,board',
        storyboardRows: 1,
        storyboardCols: 1,
        storyboardExtracted: [false],
      },
    };
    const store = createStore([source], () => revision);
    const documentListeners = new Map<string, (event: Record<string, unknown>) => void>();

    await installReactHookDriver((initialValue, index) => index === 0 ? true : initialValue);
    installStoreMock(store);
    installCommonNodeMocks();
    vi.doMock('@xyflow/react', () => ({
      Handle: function HandleMock() { return null; },
      Position: { Left: 'left', Right: 'right' },
      useReactFlow: () => ({ screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }),
    }));
    vi.doMock('../../src/components/nodes/shared/image/imageUtils', () => ({
      cropImageCell: vi.fn(() => cropResult.promise),
      cropImageByRanges: vi.fn(),
      computeImageNodeDimensions: vi.fn().mockResolvedValue({ nodeWidth: 200, nodeHeight: 200 }),
    }));
    vi.doMock('../../src/services/fileService', () => ({
      buildNodeFileName: () => 'cell.png',
      saveDataUrlToProjectData: vi.fn().mockResolvedValue(null),
    }));
    vi.stubGlobal('document', {
      body: {},
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
        documentListeners.set(type, listener);
      },
      removeEventListener: (type: string) => { documentListeners.delete(type); },
    });

    const StoryboardNode = (await import('../../src/components/nodes/StoryboardNode')).default as unknown as (
      props: { id: string; data: Record<string, unknown>; selected: boolean },
    ) => unknown;
    const tree = StoryboardNode({ id: 'storyboard', data: source.data, selected: true });
    const cell = findElement(tree, (element) => element.props['data-sb-cell-idx'] === 0);
    (cell.props.onPointerDown as (event: Record<string, unknown>) => void)({
      clientX: 0,
      clientY: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    documentListeners.get('pointerup')?.({ clientX: 20, clientY: 20 });

    await vi.waitFor(() => {
      expect(store.nodes.map((node) => node.id)).toContain('node-generated');
    });
    expect(store.nodes.find((node) => node.id === 'storyboard')?.data.storyboardExtracted).toEqual([true]);

    revision = 2;
    cropResult.resolve({ dataUrl: 'data:image/png;base64,cell', width: 100, height: 100 });
    await vi.waitFor(() => {
      expect(store.nodes.map((node) => node.id)).toEqual(['storyboard']);
    });
    expect(store.nodes[0].data.storyboardExtracted).toEqual([false]);
  });

  it('ShotlistNode keeps a drag surface even though every cell is a nodrag input', async () => {
    // 表体的输入框必须带 nodrag 才能编辑文字，于是整张表都拖不动节点。
    // 工具带和表头是仅剩的抓手，谁给它们加上 nodrag，这个节点就彻底钉死在画布上了。
    const shotlist: TestNode = {
      id: 'shotlist',
      type: 'ai-shotlist',
      position: { x: 0, y: 0 },
      data: {
        type: 'ai-shotlist',
        label: '第一场',
        shotlistRows: [{ id: 'row-1', shotNo: '1', content: '警察松动警戒线', duration: 3 }],
      },
    };
    const store = createStore([shotlist], () => 1);

    await installReactHookDriver();
    installStoreMock(store);
    installCommonNodeMocks();
    vi.doMock('@xyflow/react', () => ({
      Handle: function HandleMock() { return null; },
      Position: { Left: 'left', Right: 'right' },
      useReactFlow: () => ({ setCenter: vi.fn(), getNode: vi.fn() }),
    }));
    await installShotlistTimelineMock();

    const ShotlistNode = (await import('../../src/components/nodes/ShotlistNode')).default as unknown as (
      props: { id: string; data: Record<string, unknown>; selected: boolean },
    ) => unknown;
    const tree = ShotlistNode({ id: 'shotlist', data: shotlist.data, selected: false });

    const toolbar = findElement(tree, (element) => (
      typeof element.props.className === 'string'
      && element.props.className.includes('shotlist-toolbar')
      && !element.props.className.includes('actions')
    ));
    expect(toolbar.props.className).not.toContain('nodrag');

    // 按钮区反过来必须挡住拖拽，否则点「推送时间轴」会变成拽着节点跑
    const actions = findElement(tree, (element) => (
      typeof element.props.className === 'string'
      && element.props.className.includes('shotlist-toolbar-actions')
    ));
    expect(actions.props.className).toContain('nodrag');

    // 单元格输入必须保留 nodrag，否则选中文字就变成拖节点
    const input = findElement(tree, (element) => (
      typeof element.props.className === 'string'
      && element.props.className.includes('shot-input')
    ));
    expect(input.props.className).toContain('nodrag');
  });

  it('GroupNode batches only direct children, keeps empty groups renderable, and records resize history', async () => {
    const group: TestNode = {
      id: 'group-a',
      type: 'group',
      position: { x: 0, y: 0 },
      data: { groupId: 'group-data-a', color: '#ffffff', label: 'Group A' },
    };
    const store = createStore([
      group,
      { id: 'direct', type: 'ai-image', parentId: 'group-a', position: { x: 0, y: 0 }, data: { type: 'ai-image' } },
      { id: 'nested', type: 'ai-image', parentId: 'direct', position: { x: 0, y: 0 }, data: { type: 'ai-image' } },
      { id: 'external', type: 'ai-image', parentId: 'group-b', position: { x: 0, y: 0 }, data: { type: 'ai-image' } },
    ], () => 1);
    const batchExecuteNodes = vi.fn().mockResolvedValue({ ok: 1, fail: 0 });

    await installReactHookDriver();
    installStoreMock(store);
    vi.doMock('@xyflow/react', () => ({
      NodeResizer: function NodeResizerMock() { return null; },
      Handle: function HandleMock() { return null; },
      Position: { Left: 'left', Right: 'right' },
    }));
    vi.doMock('@iconify/react', () => ({ Icon: function IconMock() { return null; } }));
    vi.doMock('../../src/components/shared/AnimatedButton', () => ({
      default: function AnimatedButtonMock() { return null; },
    }));
    vi.doMock('../../src/utils/batchExecute', () => ({ batchExecuteNodes }));

    const GroupNode = (await import('../../src/components/nodes/GroupNode')).default as unknown as (
      props: { id: string; data: Record<string, unknown>; selected: boolean },
    ) => unknown;
    const tree = GroupNode({ id: 'group-a', data: group.data, selected: true });
    const resizer = findElement(tree, (element) => componentName(element) === 'NodeResizerMock');
    const batchButton = findElement(tree, (element) => componentName(element) === 'AnimatedButtonMock'
      && String(element.props.className ?? '').includes('hover:text-green-300'));

    (resizer.props.onResizeStart as () => void)();
    (resizer.props.onResizeEnd as () => void)();
    await (batchButton.props.onClick as () => Promise<void>)();

    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    expect(store.settleGroupMembersOnResizeEnd).toHaveBeenCalledWith('group-a');
    expect(batchExecuteNodes).toHaveBeenCalledWith(
      ['direct'],
      store.nodes,
      store.edges,
      expect.objectContaining({ currentProjectId: 'project-a' }),
    );
    store.nodes = [group];
    expect(GroupNode({ id: 'group-a', data: group.data, selected: false })).not.toBeNull();
  });

  it.each([
    { runtime: 'lightweight-web', expanded: false }, { runtime: 'lightweight-web', expanded: true },
    { runtime: 'blender', expanded: false }, { runtime: 'blender', expanded: true },
    { runtime: undefined, expanded: false }, { runtime: undefined, expanded: true },
  ])('hides director input in runtime=$runtime, expanded=$expanded, including a live runtime switch', async ({ runtime, expanded }) => {
    const store = createStore([{
      id: 'director', type: 'ai-director', position: { x: 0, y: 0 },
      data: { type: 'ai-director', directorRuntimeKind: 'ai-threejs', status: 'idle' },
    }], () => 1);
    store.activeNodeId = 'director';
    const layoutEffects: Array<() => void | (() => void)> = [];
    await installReactHookDriver((initial, index) => index === 0 ? expanded : initial, undefined, layoutEffects);
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({
      default: function PromptPanelMock() { return null; },
    }));
    vi.doMock('../../src/services/pollManager', () => ({
      ...mockComfyDeliveries(),
      getPendingTasksForProject: () => [], resumeComfyUINodeTask: vi.fn(), resumeRunningHubNodeTask: vi.fn(),
      updatePendingTask: vi.fn(), removePendingTask: vi.fn(),
    }));
    const AINodeDialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    expect(findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock')).toBeDefined();
    for (const status of ['idle', 'loading', 'success', 'error']) {
      store.nodes[0].data = { ...store.nodes[0].data, directorRuntimeKind: runtime, status, imageUrl: 'frame.png', model: 'general/text', provider: 'general' };
      layoutEffects.length = 0;
      expect(AINodeDialog()).toBeNull();
      layoutEffects[0]();
    }
    expect(store.closeNodeDialog).toHaveBeenCalledTimes(4);
  });

  registerImageGenerationTests();

  registerMediaGenerationTests();
});

describe('MJ generation job controls', () => {
  afterEach(() => {
    for (const module of ['framer-motion', '../../src/components/nodes/shared/PromptPanel',
      '../../src/services/ai/mediaModelCapabilities']) vi.doUnmock(module);
  });

  it.each([4, 1])('labels a job with %i output images without multiplying the submitted job count', async (outputsPerJob) => {
    const store = Object.assign(createStore([], () => 1), {
      userPresets: [], presetFolders: [], userSkills: [], agentPackageSkills: [],
    });
    await installReactHookDriver();
    installStoreMock(store);
    vi.doMock('../../src/i18n', () => ({ useT: () => (key: string, values: Record<string, unknown> = {}) => (
      key.replace(/\{([^}]+)\}/g, (match, name: string) => String(values[name] ?? match))
    ), t: (key: string) => key }));
    vi.doMock('framer-motion', async () => ({
      ...await vi.importActual<typeof import('framer-motion')>('framer-motion'), useReducedMotion: () => false,
    }));
    vi.doMock('../../src/services/ai/mediaModelCapabilities', () => ({
      resolveAudioParameterCapability: () => undefined,
      resolveImageOutputsPerJob: () => outputsPerJob,
      resolveImageParameterCapability: () => ({ resolutions: ['1K'], defaultResolution: '1K',
        ratios: ['16:9'], defaultRatio: '16:9', supportsBatch: false, maxBatchCount: 1 }),
    }));
    vi.doUnmock('../../src/components/nodes/shared/PromptPanel');
    const Panel = (await import('../../src/components/nodes/shared/PromptPanel')).default;
    const onSubmit = vi.fn();
    const onChangeBatchCount = vi.fn();
    const tree = Panel({ nodeType: 'ai-image', selectedModel: 'general/mj', selectedProvider: 'general',
      prompt: 'cat', onChange: vi.fn(), onSubmit, onModelSelect: vi.fn(), onChangeBatchCount });
    const submit = findElement(tree, (element) => element.type === 'button' && element.props['aria-label'] === '调用模型生成');
    expect(submit.props['data-tooltip']).toContain(outputsPerJob === 4
      ? '点击生成 4 张候选图，长按选择作业次数' : '点击生成 1 张，长按选择数量');
    const item = findElement(tree, (element) => element.props.role === 'menuitem'
      && element.props['aria-label'] === (outputsPerJob === 4 ? '生成 3 次作业，共 12 张候选图' : '生成 3 张图片'));
    expect(item.props.title).toBe(outputsPerJob === 4 ? '生成 3 次作业，共 12 张候选图' : '生成 3 张');
    (item.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: vi.fn() });
    expect(onChangeBatchCount).toHaveBeenLastCalledWith(3);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenLastCalledWith('cat', undefined);
    (submit.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: vi.fn() });
    expect(onChangeBatchCount).toHaveBeenLastCalledWith(1);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});

describe('character direction shortcuts', () => {
  afterEach(() => {
    vi.doUnmock('framer-motion');
    vi.doUnmock('../../src/i18n');
  });

  it.each([
    { id: 'char-8dir-run', draft: '', image: { imageUrl: 'blob:character' }, addCurrentImage: true },
    { id: 'char-8dir-walk', draft: '@{extra:服装}', image: { thumbnailUrl: 'blob:character' }, addCurrentImage: true },
    { id: 'char-8dir-walk', draft: '@{extra:服装} @{character:已引用图片}', image: { imageUrl: 'blob:character' }, addCurrentImage: false },
  ])('passes the existing image to $id while preserving explicit references in "$draft"', async ({
    id, draft, image, addCurrentImage,
  }) => {
    const store = Object.assign(createStore([
      { id: 'character', type: 'ai-image', position: { x: 0, y: 0 },
        data: { type: 'ai-image', label: '角色参考', prompt: draft, ...image } },
      { id: 'extra', type: 'ai-image', position: { x: 0, y: 0 },
        data: { type: 'ai-image', label: '服装', imageUrl: 'blob:costume' } },
    ], () => 1), { userPresets: [], presetFolders: [], userSkills: [], agentPackageSkills: [] });
    await installReactHookDriver((initial, index) => index === 1 ? true : initial);
    installStoreMock(store);
    vi.doMock('../../src/i18n', () => ({ useT: () => (key: string) => key, t: (key: string) => key }));
    vi.doMock('framer-motion', async () => ({
      ...await vi.importActual<typeof import('framer-motion')>('framer-motion'), useReducedMotion: () => false,
    }));
    vi.doUnmock('../../src/components/nodes/shared/PromptPanel');
    const { default: Panel } = await import('../../src/components/nodes/shared/PromptPanel');
    const { fillTemplate, getSlashCommands } = await import('../../src/components/nodes/shared/slashCommands');
    const preset = getSlashCommands('ai-image').find((item) => item.id === 'character')
      ?.children?.find((item) => item.id === id);
    if (!preset?.promptTemplate) throw new Error(`缺少角色快捷指令：${id}`);
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    const tree = Panel({ nodeId: 'character', nodeType: 'ai-image', prompt: draft,
      onSubmit, onChange, onModelSelect: vi.fn() });
    const menu = findElement(tree, (element) => componentName(element) === 'SlashCommandMenu');
    const filled = fillTemplate(preset.promptTemplate, menu.props.currentPrompt as string);
    const onSelect = menu.props.onSelect as (prompt: string, direct: boolean, override: typeof preset) => void;
    onSelect(filled, true, preset);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      addCurrentImage ? `${filled}\n@{character:角色参考}` : filled,
      'character-8-direction-grid',
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(store.nodes[0].data.prompt).toBe(draft);
  });
});
