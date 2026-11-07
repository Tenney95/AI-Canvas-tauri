/**
 * videoEditorWindowService — 回归测试：videoEditorWindowService。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoEditorWindowBinding } from '../../src/services/videoEditorWindowService';
import { captureLegacyCanvasContext } from '../../src/services/projectExecutionContext';

const app = vi.hoisted(() => ({
  state: { currentProjectId: 'proj-1' as string | null, projectLoadStatus: 'ready', switchingProjectName: null as string | null,
    projects: [{ id: 'proj-1', exchangeEpoch: 0 }, { id: 'proj-2', exchangeEpoch: 0 }],
    nodes: [{ id: 'node-7' }, { id: 'node-9' }], getCurrentRevision: () => 7 },
  subscribers: new Set<() => void>(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: {
  getState: () => app.state,
  subscribe: (callback: () => void) => { app.subscribers.add(callback); return () => { app.subscribers.delete(callback); }; },
} }));
function setApp(partial: Partial<typeof app.state>): void {
  app.state = { ...app.state, ...partial };
  for (const callback of app.subscribers) callback();
}

const tauriMocks = vi.hoisted(() => ({
  emitTo: vi.fn(async () => undefined),
  eventHandler: null as null | ((event: { payload: unknown }) => void),
  hostHandler: null as null | ((event: { payload: unknown }) => void),
  existingWindow: null as MockWindow | null,
  created: [] as MockWindow[],
  destroyHandlers: [] as (() => void)[],
}));

class MockWindow {
  label: string;
  options: Record<string, unknown>;
  show = vi.fn(async () => undefined);
  unminimize = vi.fn(async () => undefined);
  setFocus = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);

  constructor(label: string, options: Record<string, unknown> = {}) {
    this.label = label;
    this.options = options;
    tauriMocks.created.push(this);
  }

  static getByLabel = vi.fn(async () => tauriMocks.existingWindow);

  once(event: string, handler: (event: { payload?: unknown }) => void) {
    if (event === 'tauri://created') queueMicrotask(() => handler({}));
    if (event === 'tauri://destroyed') tauriMocks.destroyHandlers.push(() => handler({}));
    return Promise.resolve(() => undefined);
  }
}

vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: MockWindow }));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: tauriMocks.emitTo,
  // 两条通道各自注册一个监听器，按事件名分开保存才能验证互不串台
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    if (event === 'video-editor:host-message') {
      tauriMocks.hostHandler = handler;
      return () => { tauriMocks.hostHandler = null; };
    }
    tauriMocks.eventHandler = handler;
    return () => { tauriMocks.eventHandler = null; };
  }),
}));

import {
  VIDEO_EDITOR_HOST_EVENT,
  VIDEO_EDITOR_MESSAGE_EVENT,
  VIDEO_EDITOR_WINDOW_LABEL,
  __resetVideoEditorWindowServiceForTests,
  buildVideoEditorWindowUrl,
  openVideoEditorWindow,
  parseVideoEditorHostEnvelope,
  parseVideoEditorWindowEnvelope,
  postVideoEditorAiTransitionResult,
  postVideoEditorAiTransitionRequest,
  postVideoEditorExported,
  postVideoEditorFrameExported,
  postVideoEditorModels,
  subscribeVideoEditorHost,
  subscribeVideoEditorWindow,
} from '../../src/services/videoEditorWindowService';

function activeBinding(): VideoEditorWindowBinding {
  const url = String(tauriMocks.created.at(-1)?.options.url);
  const value = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('executionBinding');
  if (!value) throw new Error('missing typed window binding');
  return JSON.parse(value) as VideoEditorWindowBinding;
}
async function openEditor(nodeId = 'node-7'): Promise<VideoEditorWindowBinding> {
  const expectedContext = captureLegacyCanvasContext(app.state)!;
  await openVideoEditorWindow({ instanceId: `proj-1::${nodeId}`, projectId: 'proj-1', nodeId, expectedContext });
  return activeBinding();
}
function useChildBinding(binding: VideoEditorWindowBinding): void {
  window.location.search = `?${new URLSearchParams({ executionBinding: JSON.stringify(binding) })}`;
}

/** ensureMainListener 走动态 import + await listen，需要让出若干轮事件循环 */
async function flushListener(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('videoEditorWindowService', () => {
  beforeEach(() => {
    __resetVideoEditorWindowServiceForTests();
    app.subscribers.clear();
    app.state = { currentProjectId: 'proj-1', projectLoadStatus: 'ready', switchingProjectName: null,
      projects: [{ id: 'proj-1', exchangeEpoch: 0 }, { id: 'proj-2', exchangeEpoch: 0 }],
      nodes: [{ id: 'node-7' }, { id: 'node-9' }], getCurrentRevision: () => 7 };
    tauriMocks.emitTo.mockClear();
    tauriMocks.eventHandler = null;
    tauriMocks.hostHandler = null;
    tauriMocks.existingWindow = null;
    tauriMocks.created.length = 0;
    tauriMocks.destroyHandlers.length = 0;
    MockWindow.getByLabel.mockClear();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __TAURI__: {},
        location: { origin: 'http://localhost:1420', search: '' },
        setTimeout,
        clearTimeout,
      },
    });
  });

  describe('buildVideoEditorWindowUrl', () => {
    it('routes to the shared entry with the session parameters', () => {
      const url = buildVideoEditorWindowUrl({
        instanceId: 'proj-1::node-7',
        projectId: 'proj-1',
        nodeId: 'node-7',
        theme: 'light',
      });

      expect(url.startsWith('index.html?')).toBe(true);
      const params = new URLSearchParams(url.slice('index.html?'.length));
      expect(params.get('view')).toBe('video-editor');
      expect(params.get('instanceId')).toBe('proj-1::node-7');
      expect(params.get('projectId')).toBe('proj-1');
      expect(params.get('nodeId')).toBe('node-7');
      expect(params.get('theme')).toBe('light');
    });
  });

  describe('parseVideoEditorWindowEnvelope', () => {
    it('accepts a well-formed envelope', () => {
      expect(parseVideoEditorWindowEnvelope({
        instanceId: 'proj::node',
        message: { type: 'storyai:video-editor-ready' },
      })).toEqual({
        instanceId: 'proj::node',
        message: { type: 'storyai:video-editor-ready' },
      });
    });

    it('accepts the current-frame export message', () => {
      expect(parseVideoEditorWindowEnvelope({
        instanceId: 'proj::node',
        message: {
          type: 'storyai:video-editor-frame-exported',
          payload: { imageUrl: 'asset://frame.png', fileName: 'frame.png', time: 1.5 },
        },
      })).toEqual({
        instanceId: 'proj::node',
        message: {
          type: 'storyai:video-editor-frame-exported',
          payload: { imageUrl: 'asset://frame.png', fileName: 'frame.png', time: 1.5 },
        },
      });
    });

    it('rejects message types outside the allow list', () => {
      expect(parseVideoEditorWindowEnvelope({
        instanceId: 'proj::node',
        message: { type: 'storyai:video-editor-evil' },
      })).toBeNull();
    });

    it('rejects malformed instance ids and payloads', () => {
      expect(parseVideoEditorWindowEnvelope({
        instanceId: '   ',
        message: { type: 'storyai:video-editor-ready' },
      })).toBeNull();
      expect(parseVideoEditorWindowEnvelope({
        instanceId: 'a'.repeat(129),
        message: { type: 'storyai:video-editor-ready' },
      })).toBeNull();
      expect(parseVideoEditorWindowEnvelope({
        instanceId: 'proj::node',
        message: { type: 'storyai:video-editor-exported', payload: 'nope' },
      })).toBeNull();
    });

    it('accepts the AI transition request but not the host-only reply', () => {
      expect(parseVideoEditorWindowEnvelope({
        instanceId: 'proj::node',
        message: {
          type: 'storyai:video-editor-ai-transition-request',
          payload: { requestId: 'ait-1', prompt: '推近穿过火光' },
        },
      })).not.toBeNull();
      expect(parseVideoEditorWindowEnvelope({
        instanceId: 'proj::node',
        message: { type: 'storyai:video-editor-ai-transition-result' },
      })).toBeNull();
    });
  });

  describe('parseVideoEditorHostEnvelope', () => {
    it('accepts the messages the main window pushes down', () => {
      expect(parseVideoEditorHostEnvelope({
        instanceId: 'proj::node',
        message: { type: 'storyai:video-editor-models', payload: { models: [] } },
      })).toEqual({
        instanceId: 'proj::node',
        message: { type: 'storyai:video-editor-models', payload: { models: [] } },
      });
      expect(parseVideoEditorHostEnvelope({
        instanceId: 'proj::node',
        message: {
          type: 'storyai:video-editor-ai-transition-result',
          payload: { requestId: 'ait-1', videoUrl: 'asset://t.mp4' },
        },
      })).not.toBeNull();
    });

    // 两条通道的白名单必须互斥，否则编辑器能自导自演一条「主窗口下发」的消息
    it('rejects editor-to-main message types', () => {
      expect(parseVideoEditorHostEnvelope({
        instanceId: 'proj::node',
        message: { type: 'storyai:video-editor-exported' },
      })).toBeNull();
      expect(parseVideoEditorHostEnvelope({
        instanceId: 'proj::node',
        message: { type: 'storyai:video-editor-ai-transition-request' },
      })).toBeNull();
    });
  });

  it('creates one window carrying the editor route', async () => {
    const expectedContext = captureLegacyCanvasContext(app.state)!;
    await openVideoEditorWindow({
      instanceId: 'proj-1::node-7',
      projectId: 'proj-1',
      nodeId: 'node-7',
      theme: 'dark',
      expectedContext,
    });

    expect(tauriMocks.created).toHaveLength(1);
    expect(tauriMocks.created[0]?.label).toBe(VIDEO_EDITOR_WINDOW_LABEL);
    expect(String(tauriMocks.created[0]?.options.url)).toContain('view=video-editor');
    expect(String(tauriMocks.created[0]?.options.url)).toContain('nodeId=node-7');
    expect(activeBinding().expectedContext).toEqual(expectedContext);
    // 与资源搜索窗口一致的自绘标题栏外观
    expect(tauriMocks.created[0]?.options.decorations).toBe(false);
    expect(tauriMocks.created[0]?.options.transparent).toBe(true);
  });

  it('旧的无租约窗口不能改绑为新工程，保留草稿并要求手动关闭重开', async () => {
    const existing = new MockWindow(VIDEO_EDITOR_WINDOW_LABEL);
    tauriMocks.created.length = 0;
    tauriMocks.existingWindow = existing;

    await expect(openVideoEditorWindow({
      instanceId: 'proj-1::node-9',
      projectId: 'proj-1',
      nodeId: 'node-9',
      expectedContext: captureLegacyCanvasContext(app.state)!,
    })).rejects.toThrow('不能改绑');

    expect(tauriMocks.created).toHaveLength(0);
    expect(existing.close).not.toHaveBeenCalled();
    expect(existing.setFocus).not.toHaveBeenCalled();
  });

  it('只复用同一 instance、同一持久代际的活动窗口', async () => {
    const binding = await openEditor();
    const existing = tauriMocks.created[0]!;
    tauriMocks.existingWindow = existing;
    await openVideoEditorWindow({ instanceId: 'proj-1::node-7', projectId: 'proj-1', nodeId: 'node-7',
      expectedContext: captureLegacyCanvasContext(app.state)! });
    expect(tauriMocks.created).toHaveLength(1);
    expect(existing.setFocus).toHaveBeenCalledOnce();
    expect(tauriMocks.emitTo).toHaveBeenCalledWith(
      VIDEO_EDITOR_WINDOW_LABEL,
      VIDEO_EDITOR_HOST_EVENT,
      expect.objectContaining({
        instanceId: 'proj-1::node-7', binding,
        message: expect.objectContaining({ type: 'storyai:video-editor-session' }),
      }),
    );
  });

  it('已有租约也不能把另一个节点借同一子窗改绑', async () => {
    await openEditor();
    const existing = tauriMocks.created[0]!;
    tauriMocks.existingWindow = existing;
    await expect(openVideoEditorWindow({ instanceId: 'proj-1::node-9', projectId: 'proj-1', nodeId: 'node-9',
      expectedContext: captureLegacyCanvasContext(app.state)! })).rejects.toThrow('不能改绑');
    expect(existing.close).not.toHaveBeenCalled();
    expect(tauriMocks.created).toHaveLength(1);
  });

  it('旧窗口缺少 typed context 时保留读取协议，但拒绝写入和新开窗执行', async () => {
    await expect(openVideoEditorWindow({ instanceId: 'proj-1::node-7', projectId: 'proj-1', nodeId: 'node-7' })).rejects.toThrow();
    await expect(postVideoEditorExported('proj-1::node-7', { videoUrl: 'asset://old.mp4', fileName: 'old.mp4', duration: 1 })).rejects.toThrow('旧剪辑窗口');
    await expect(postVideoEditorFrameExported('proj-1::node-7', { imageUrl: 'asset://old.png', fileName: 'old.png', time: 1,
      width: 1920, height: 1080 })).rejects.toThrow('旧剪辑窗口');
    await expect(postVideoEditorAiTransitionRequest('proj-1::node-7', { requestId: 'old-ai', prompt: '旧请求', model: 'model',
      provider: 'provider', firstFrameUrl: 'asset://first.png', lastFrameUrl: 'asset://last.png' })).rejects.toThrow('旧剪辑窗口');
    expect(tauriMocks.created).toHaveLength(0);
    expect(tauriMocks.emitTo).not.toHaveBeenCalled();
  });

  it.each(['storyai:video-editor-exported', 'storyai:video-editor-frame-exported', 'storyai:video-editor-ai-transition-request'] as const)(
    '主窗口拒绝没有原 binding 的 %s', async (type) => {
      await openEditor();
      const subscriber = vi.fn();
      subscribeVideoEditorWindow('proj-1::node-7', subscriber);
      await flushListener();
      tauriMocks.eventHandler?.({ payload: { instanceId: 'proj-1::node-7', message: { type, payload: {} } } });
      expect(subscriber).not.toHaveBeenCalled();
    },
  );

  it.each(['storyai:video-editor-exported', 'storyai:video-editor-frame-exported', 'storyai:video-editor-ai-transition-request'] as const)(
    '主窗口只接受活动 binding 的 %s', async (type) => {
      const binding = await openEditor();
      const subscriber = vi.fn();
      subscribeVideoEditorWindow('proj-1::node-7', subscriber);
      await flushListener();
      const message = { type, payload: { requestId: 'current-ai', videoUrl: 'asset://current.mp4', imageUrl: 'asset://current.png',
        fileName: 'current.mp4', duration: 1, prompt: '当前请求', model: 'model', provider: 'provider',
        firstFrameUrl: 'asset://first.png', lastFrameUrl: 'asset://last.png' } };
      tauriMocks.eventHandler?.({ payload: { instanceId: 'proj-1::node-7', binding, message } });
      expect(subscriber).toHaveBeenCalledWith(message, binding);
    },
  );

  it.each(['epoch', 'switch', 'node'] as const)('%s 变化永久撤销旧窗口，迟到导出/转场不能再获主窗 effect', async (boundary) => {
    const binding = await openEditor();
    const subscriber = vi.fn();
    subscribeVideoEditorWindow('proj-1::node-7', subscriber);
    await flushListener();
    if (boundary === 'epoch') setApp({ projects: app.state.projects.map((project) => project.id === 'proj-1' ? { ...project, exchangeEpoch: 1 } : project) });
    else if (boundary === 'switch') { setApp({ currentProjectId: 'proj-2' }); setApp({ currentProjectId: 'proj-1' }); }
    else { setApp({ nodes: [{ id: 'node-9' }] }); setApp({ nodes: [{ id: 'node-7' }, { id: 'node-9' }] }); }
    for (const type of ['storyai:video-editor-exported', 'storyai:video-editor-frame-exported', 'storyai:video-editor-ai-transition-request']) {
      tauriMocks.eventHandler?.({ payload: { instanceId: 'proj-1::node-7', binding,
        message: { type, payload: { requestId: 'late-ai', videoUrl: 'asset://late.mp4' } } } });
    }
    expect(subscriber).not.toHaveBeenCalled();
    await expect(postVideoEditorAiTransitionResult('proj-1::node-7', { requestId: 'late-ai', videoUrl: 'asset://late.mp4' }, binding)).rejects.toThrow('已撤销');
    expect(tauriMocks.emitTo).not.toHaveBeenCalled();
  });

  it('delivers export results only to the matching instance subscriber', async () => {
    const binding = await openEditor();
    const forNode7 = vi.fn();
    const forNode9 = vi.fn();
    subscribeVideoEditorWindow('proj-1::node-7', forNode7);
    subscribeVideoEditorWindow('proj-1::node-9', forNode9);
    await flushListener();

    tauriMocks.eventHandler?.({
      payload: {
        instanceId: 'proj-1::node-7',
        binding,
        message: {
          type: 'storyai:video-editor-exported',
          payload: { videoUrl: 'asset://out.mp4', fileName: 'out.mp4', duration: 3 },
        },
      },
    });

    expect(forNode7).toHaveBeenCalledWith(expect.objectContaining({
      type: 'storyai:video-editor-exported',
    }), binding);
    expect(forNode9).not.toHaveBeenCalled();
  });

  it('delivers host messages only to the matching editor subscriber', async () => {
    const binding = await openEditor();
    useChildBinding(binding);
    const forNode7 = vi.fn();
    const forNode9 = vi.fn();
    subscribeVideoEditorHost('proj-1::node-7', forNode7);
    subscribeVideoEditorHost('proj-1::node-9', forNode9);
    await flushListener();

    tauriMocks.hostHandler?.({
      payload: {
        instanceId: 'proj-1::node-7',
        binding,
        message: {
          type: 'storyai:video-editor-ai-transition-result',
          payload: { requestId: 'ait-1', videoUrl: 'asset://t.mp4' },
        },
      },
    });

    expect(forNode7).toHaveBeenCalledWith(expect.objectContaining({
      type: 'storyai:video-editor-ai-transition-result',
    }), binding);
    expect(forNode9).not.toHaveBeenCalled();
  });

  it('posts the model list and the AI transition result down to the editor window', async () => {
    const binding = await openEditor();
    await postVideoEditorModels('proj-1::node-7', [
      { value: 'volcengine/seedance', label: 'Seedance', provider: 'volcengine', groupName: '火山方舟' },
    ]);
    await postVideoEditorAiTransitionResult('proj-1::node-7', {
      requestId: 'ait-1',
      videoUrl: 'asset://t.mp4',
    });

    expect(tauriMocks.emitTo).toHaveBeenCalledWith(
      VIDEO_EDITOR_WINDOW_LABEL,
      VIDEO_EDITOR_HOST_EVENT,
      expect.objectContaining({
        instanceId: 'proj-1::node-7',
        binding,
        message: expect.objectContaining({ type: 'storyai:video-editor-models' }),
      }),
    );
    expect(tauriMocks.emitTo).toHaveBeenCalledWith(
      VIDEO_EDITOR_WINDOW_LABEL,
      VIDEO_EDITOR_HOST_EVENT,
      expect.objectContaining({
        instanceId: 'proj-1::node-7',
        binding,
        message: expect.objectContaining({
          type: 'storyai:video-editor-ai-transition-result',
          payload: { requestId: 'ait-1', videoUrl: 'asset://t.mp4' },
        }),
      }),
    );
  });

  it('ignores envelopes whose message type is not allowed', async () => {
    const subscriber = vi.fn();
    subscribeVideoEditorWindow('proj-1::node-7', subscriber);
    await flushListener();

    tauriMocks.eventHandler?.({
      payload: {
        instanceId: 'proj-1::node-7',
        message: { type: 'storyai:video-editor-inject', payload: { videoUrl: 'x' } },
      },
    });

    expect(subscriber).not.toHaveBeenCalled();
  });

  it('notifies subscribers when the window is destroyed', async () => {
    const subscriber = vi.fn();
    subscribeVideoEditorWindow('proj-1::node-7', subscriber);
    await openVideoEditorWindow({
      instanceId: 'proj-1::node-7',
      projectId: 'proj-1',
      nodeId: 'node-7',
      expectedContext: captureLegacyCanvasContext(app.state)!,
    });

    tauriMocks.destroyHandlers.forEach((handler) => handler());

    expect(subscriber).toHaveBeenCalledWith({ type: 'storyai:video-editor-close' }, activeBinding());
  });

  it('posts export results back to the main window', async () => {
    const binding = await openEditor();
    useChildBinding(binding);
    await postVideoEditorExported('proj-1::node-7', {
      videoUrl: 'asset://out.mp4',
      filePath: '/data/out.mp4',
      fileName: 'out.mp4',
      duration: 4.5,
    });

    expect(tauriMocks.emitTo).toHaveBeenCalledWith(
      'main',
      VIDEO_EDITOR_MESSAGE_EVENT,
      expect.objectContaining({
        instanceId: 'proj-1::node-7',
        binding,
        message: expect.objectContaining({
          type: 'storyai:video-editor-exported',
          payload: expect.objectContaining({ videoUrl: 'asset://out.mp4', duration: 4.5 }),
        }),
      }),
    );
  });

  it('posts the exported current frame back to the main window', async () => {
    const binding = await openEditor();
    useChildBinding(binding);
    await postVideoEditorFrameExported('proj-1::node-7', {
      imageUrl: 'asset://frame.png',
      filePath: '/data/frame.png',
      fileName: 'frame.png',
      time: 2.25,
      width: 1920,
      height: 1080,
    });

    expect(tauriMocks.emitTo).toHaveBeenCalledWith(
      'main',
      VIDEO_EDITOR_MESSAGE_EVENT,
      expect.objectContaining({
        instanceId: 'proj-1::node-7',
        binding,
        message: expect.objectContaining({
          type: 'storyai:video-editor-frame-exported',
          payload: expect.objectContaining({
            imageUrl: 'asset://frame.png',
            time: 2.25,
            width: 1920,
            height: 1080,
          }),
        }),
      }),
    );
  });
});
