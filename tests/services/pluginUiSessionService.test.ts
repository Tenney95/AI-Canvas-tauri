import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InstalledPlugin,
  PluginInvocationResources,
  PluginNodeToolManifest,
} from '../../src/types/plugin';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  subscribers: new Set<() => void>(),
  registerCanvasDerivation: vi.fn(),
  isCanvasDerivationFresh: vi.fn(),
  completeCanvasDerivation: vi.fn(),
  mintResources: vi.fn(),
  clearResources: vi.fn(),
  collectMedia: vi.fn(),
  executeTool: vi.fn(),
  executeEffect: vi.fn(),
  messageHandler: undefined as ((event: MessageEvent) => void) | undefined,
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string, protocol: string) => `http://${protocol}.localhost/${path}`,
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: {
    getState: mocks.getState,
    subscribe: (listener: () => void) => {
      mocks.subscribers.add(listener);
      return () => mocks.subscribers.delete(listener);
    },
  },
}));
vi.mock('../../src/services/canvasDerivationGuard', () => ({
  registerCanvasDerivation: mocks.registerCanvasDerivation,
  isCanvasDerivationFresh: mocks.isCanvasDerivationFresh,
  completeCanvasDerivation: mocks.completeCanvasDerivation,
}));
vi.mock('../../src/services/plugins/pluginModelCatalog', () => ({
  buildPluginModelCatalog: vi.fn(() => []),
  collectDeclaredModelCategories: vi.fn(() => []),
}));
vi.mock('../../src/services/plugins/pluginResourceService', () => ({
  mintPluginInvocationResources: mocks.mintResources,
  clearPluginInvocationResources: mocks.clearResources,
}));
vi.mock('../../src/services/plugins/pluginRuntime', () => ({
  collectTrustedNodeMediaReferences: mocks.collectMedia,
  executeNodePluginTool: mocks.executeTool,
  executePluginUiHostEffect: mocks.executeEffect,
}));

import { createPluginUiFrameSession, createPluginUiNativeSession } from '../../src/services/plugins/pluginUiSessionService';

const SOURCE_DIGEST = 'a'.repeat(64);
const REVISION_DIGEST = 'b'.repeat(64);
const UI_DIGEST = 'c'.repeat(64);
const resources: PluginInvocationResources = {
  self: [],
  incoming: [{
    resourceId: 'opaque-resource',
    origin: 'connection',
    displayName: 'frame.png',
    mediaType: 'image/png',
    size: 128,
    access: 'read',
    source: { nodeId: 'source', edgeId: 'edge-1', portId: 'media' },
  }],
  inputs: {},
  package: [],
  derived: [],
};

const tool: PluginNodeToolManifest = {
  id: 'open-panel',
  title: '打开面板',
  placements: ['node-toolbar'],
  nodeTypes: ['ai-image'],
  inputFields: ['output', 'filePath'],
  resourceAccess: { incoming: true },
  output: { mode: 'update-current', fields: ['output'] },
  dialog: { fields: [], ui: 'dialog' },
};

const plugin: InstalledPlugin = {
  id: 'plugin-a',
  enabled: true,
  installedAt: 1,
  updatedAt: 1,
  source: 'definePlugin({ tools: {} });',
  sourceDigest: SOURCE_DIGEST,
  revisionDigest: REVISION_DIGEST,
  uiDigest: UI_DIGEST,
  manifest: {
    apiVersion: 1,
    runtime: 'javascript',
    id: 'plugin-a',
    name: '测试插件',
    version: '1.0.0',
    category: 'utility',
    entry: 'main.js',
    permissions: ['node.read', 'node.write', 'files.connected.read', 'ui.custom'],
    contributes: { nodeTools: [tool] },
    ui: {
      entry: 'ui.js',
      integrity: `sha256-${UI_DIGEST}`,
      exports: { dialog: 'Dialog' },
    },
  },
};

function request(sessionId: string, requestId: string, kind: string, payload: unknown = null) {
  return {
    channel: 'ai-canvas-plugin-ui-v1',
    direction: 'request',
    sessionId,
    requestId,
    kind,
    payload,
  };
}

describe('pluginUiSessionService', () => {
  it('resolves the native mount name from the active manifest UI alias', async () => {
    const session = await createPluginUiNativeSession({
      plugin, tool, nodeId: 'target', exportName: 'dialog', onClose: vi.fn(),
    });
    expect(session).toHaveProperty('globalExport', 'Dialog');
    session.dispose();
  });

  afterEach(() => {
    mocks.getState.mockReturnValue({ installedPlugins: [] });
    for (const listener of mocks.subscribers) listener();
  });

  const native = (onClose = vi.fn()) => createPluginUiNativeSession({
    plugin, tool, nodeId: 'target', exportName: 'dialog', onClose,
  });
  const notify = () => { for (const listener of mocks.subscribers) listener(); };

  it('keeps native sessions inaccessible to iframe messages and retains the v1 context', async () => {
    const frame = await createPluginUiFrameSession({ plugin, tool, nodeId: 'target', exportName: 'dialog', onClose: vi.fn() });
    frame.dispose();
    const session = await native();
    expect(session.binding).toMatchObject({
      identity: { pluginId: plugin.id, toolId: tool.id, sourceDigest: SOURCE_DIGEST, revisionDigest: REVISION_DIGEST, uiDigest: UI_DIGEST },
      projectId: 'project-1', nodeId: 'target', canvasRevision: 7,
    });
    for (const source of [null, undefined, {}]) {
      mocks.messageHandler?.({ data: request(session.binding.sessionId, 'spoof', 'effect', {}), source } as MessageEvent);
    }
    expect(mocks.executeEffect).not.toHaveBeenCalled();
    expect(await session.request('context', null)).toMatchObject({ ok: true, value: { surface: 'tool-dialog', theme: 'light', resources } });
    session.dispose();
    expect(await session.request('effect', {})).toMatchObject({ ok: false });
    expect(mocks.executeEffect).not.toHaveBeenCalled();
  });

  it.each(['project', 'node', 'disabled', 'uninstalled', 'source', 'revision', 'ui', 'canvas'])(
    'revokes a native lease immediately on %s changes', async (change) => {
      const onClose = vi.fn();
      const session = await native(onClose);
      const state = mocks.getState();
      if (change === 'project') state.currentProjectId = 'project-2';
      else if (change === 'node') state.nodes = [];
      else if (change === 'uninstalled') state.installedPlugins = [];
      else if (change === 'canvas') mocks.isCanvasDerivationFresh.mockReturnValue(false);
      else state.installedPlugins = [{ ...plugin, ...({
        disabled: { enabled: false }, source: { sourceDigest: 'd'.repeat(64) },
        revision: { revisionDigest: 'd'.repeat(64) }, ui: { uiDigest: 'd'.repeat(64) },
      }[change]) }];
      notify();
      expect(session.isActive()).toBe(false);
      expect(mocks.clearResources).toHaveBeenCalledWith(session.binding.sessionId);
      expect(mocks.subscribers.size).toBe(0);
      await Promise.resolve();
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('aborts in-flight effects on close and refuses late results', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    mocks.executeEffect.mockImplementationOnce(async () => { await gate; return { ok: true }; });
    const session = await native();
    const pending = session.request('effect', { type: 'model.generate' });
    const signal = mocks.executeEffect.mock.calls[0][0].signal as AbortSignal;
    session.dispose();
    expect(signal.aborted).toBe(true);
    finish();
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('关闭') });
  });

  it('does not resurrect a session when resource minting finishes after invalidation', async () => {
    let finish!: (value: PluginInvocationResources) => void;
    mocks.mintResources.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = native();
    const state = mocks.getState();
    state.currentProjectId = 'project-2';
    notify();
    state.currentProjectId = 'project-1';
    finish(resources);
    await expect(pending).rejects.toThrow('关闭');
    expect(mocks.clearResources).toHaveBeenCalledTimes(2);
    expect(mocks.subscribers.size).toBe(0);
  });

  it('counts pending resource sessions towards the shared four-session limit', async () => {
    let finish!: (value: PluginInvocationResources) => void;
    const gate = new Promise<PluginInvocationResources>((resolve) => { finish = resolve; });
    mocks.mintResources.mockReturnValue(gate);
    const pending = Array.from({ length: 4 }, () => native());
    await expect(native()).rejects.toThrow('最多打开 4');
    finish(resources);
    const sessions = await Promise.all(pending);
    sessions.forEach((session) => session.dispose());
  });

  it('uses the live tool definition and rejects stale launcher revisions before minting', async () => {
    await expect(createPluginUiNativeSession({
      plugin: { ...plugin, revisionDigest: 'd'.repeat(64) }, tool, nodeId: 'target', exportName: 'dialog', onClose: vi.fn(),
    })).rejects.toThrow('revision');
    expect(mocks.mintResources).not.toHaveBeenCalled();
    const session = await createPluginUiNativeSession({
      plugin, tool: { ...tool, resourceAccess: { self: true } }, nodeId: 'target', exportName: 'dialog', onClose: vi.fn(),
    });
    expect(mocks.mintResources).toHaveBeenCalledWith(expect.objectContaining({ access: { incoming: true } }));
    session.dispose();
  });

  it('acknowledges its own canvas commit before cleanup, without relaxing later writes', async () => {
    const session = await native();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    mocks.executeTool.mockImplementationOnce(async () => {
      await gate;
      mocks.isCanvasDerivationFresh.mockReturnValue(false);
      notify();
    });
    const pending = session.request('submit', { data: { prompt: 'save' } });
    expect(await session.request('context', null)).toMatchObject({ ok: true });
    expect(await session.request('effect', {})).toMatchObject({ ok: false });
    finish();
    expect(await pending).toEqual({ ok: true, value: true });
    expect(session.isActive()).toBe(true);
    expect(mocks.executeTool).toHaveBeenCalledWith(expect.anything(), 'target', { prompt: 'save' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await session.request('submit', {})).toMatchObject({ ok: false });
    session.finishRequest();
    expect(session.isActive()).toBe(false);
  });
  it('keeps local media, exports and paid effects in separate bounded budgets', async () => {
    const session = await createPluginUiFrameSession({ plugin, tool, nodeId: 'target', exportName: 'dialog', parameters: {}, onClose: vi.fn() });
    const frame = { postMessage: vi.fn() } as unknown as Window;
    session.attach(frame);
    let serial = 0;
    const send = async (type: string) => {
      const requestId = `budget-${++serial}`;
      mocks.messageHandler?.({ data: request(session.sessionId, requestId, 'effect', { type }), source: frame } as MessageEvent);
      await vi.waitFor(() => expect(frame.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId }), '*'), { interval: 1 });
      return vi.mocked(frame.postMessage).mock.calls.at(-1)?.[0];
    };
    for (let i = 0; i < 96; i++) expect(await send('video.inspectFrame')).toMatchObject({ ok: true });
    expect(await send('video.inspectFrame')).toMatchObject({ ok: false });
    for (let i = 0; i < 4; i++) expect(await send('model.generate')).toMatchObject({ ok: true });
    expect(await send('model.generate')).toMatchObject({ ok: false });
    expect(await send('resource.export')).toMatchObject({ ok: true });
    session.dispose();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    // 服务模块只安装一次监听器；后续用例继续使用同一监听器引用。
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: vi.fn((kind: string, handler: (event: MessageEvent) => void) => {
          if (kind === 'message') mocks.messageHandler = handler;
        }),
      },
    });
    const state = {
      currentProjectId: 'project-1',
      nodes: [{
        id: 'target',
        data: {
          type: 'ai-image',
          output: 'https://example.com/frame.png',
          filePath: 'G:\\project\\secret.png',
        },
      }],
      edges: [],
      config: { theme: 'light' },
      installedPlugins: [plugin],
      getCurrentRevision: () => 7,
      showToast: vi.fn(),
    };
    mocks.getState.mockReturnValue(state);
    mocks.registerCanvasDerivation.mockReturnValue({
      operationId: 'guard-1',
      projectId: 'project-1',
      sourceNodeId: 'target',
      baseRevision: 7,
    });
    mocks.isCanvasDerivationFresh.mockReturnValue(true);
    mocks.mintResources.mockResolvedValue(resources);
    mocks.collectMedia.mockReturnValue(new Set(['https://example.com/frame.png']));
    mocks.executeEffect.mockResolvedValue({ type: 'resource.readText', ok: true, value: { content: 'ok' } });
    mocks.executeTool.mockResolvedValue(undefined);
  });

  it('binds requests to the iframe window, exposes opaque resources, and revokes on submit', async () => {
    const onClose = vi.fn();
    const session = await createPluginUiFrameSession({
      plugin,
      tool,
      nodeId: 'target',
      exportName: 'dialog',
      parameters: { prompt: 'initial' },
      onClose,
    });
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const spoof = {} as Window;
    session.attach(frame);
    expect(mocks.messageHandler).toBeTypeOf('function');
    expect(mocks.collectMedia).toHaveBeenCalledWith('ai-image', {
      output: 'https://example.com/frame.png',
    });

    mocks.messageHandler?.({
      data: request(session.sessionId, 'spoof', 'context'),
      source: spoof,
    } as MessageEvent);
    expect(frame.postMessage).not.toHaveBeenCalled();

    mocks.messageHandler?.({
      data: request(session.sessionId, 'context', 'context'),
      source: frame,
    } as MessageEvent);
    await vi.waitFor(() => expect(frame.postMessage).toHaveBeenCalledTimes(1));
    const contextResponse = vi.mocked(frame.postMessage).mock.calls[0][0] as Record<string, unknown>;
    expect(contextResponse).toMatchObject({ ok: true, requestId: 'context' });
    expect(JSON.stringify(contextResponse)).toContain('opaque-resource');
    expect(contextResponse).toMatchObject({
      value: { node: { data: { output: 'https://example.com/frame.png' } } },
    });
    expect(JSON.stringify(contextResponse)).not.toContain('secret.png');
    expect(JSON.stringify(contextResponse)).toContain('"theme":"light"');

    session.updateTheme('dark');
    expect(frame.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      direction: 'event',
      sessionId: session.sessionId,
      kind: 'theme',
      value: 'dark',
    }), '*');

    mocks.messageHandler?.({
      data: request(session.sessionId, 'effect', 'effect', {
        type: 'resource.readText',
        resourceId: 'opaque-resource',
      }),
      source: frame,
    } as MessageEvent);
    await vi.waitFor(() => expect(mocks.executeEffect).toHaveBeenCalledTimes(1));
    expect(mocks.executeEffect).toHaveBeenCalledWith(expect.objectContaining({
      resources,
      signal: expect.any(AbortSignal),
    }));
    await vi.waitFor(() => expect(frame.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'effect', ok: true }),
      '*',
    ));

    mocks.messageHandler?.({
      data: request(session.sessionId, 'submit', 'submit', { data: { prompt: 'final' } }),
      source: frame,
    } as MessageEvent);
    await vi.waitFor(() => expect(mocks.executeTool).toHaveBeenCalledTimes(1));
    expect(mocks.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'plugin-a', revisionDigest: REVISION_DIGEST }),
      'target',
      { prompt: 'final' },
      expect.objectContaining({
        invocationId: session.sessionId,
        resources,
        trustedMediaReferences: expect.any(Set),
        guard: expect.objectContaining({ operationId: 'guard-1' }),
      }),
    );
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.clearResources).toHaveBeenCalledWith(session.sessionId);
    expect(mocks.completeCanvasDerivation).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'guard-1' }));
  });
});
