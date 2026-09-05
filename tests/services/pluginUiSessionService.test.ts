import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InstalledPlugin,
  PluginInvocationResources,
  PluginNodeToolManifest,
} from '../../src/types/plugin';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
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
  useAppStore: { getState: mocks.getState },
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

import { createPluginUiFrameSession } from '../../src/services/plugins/pluginUiSessionService';

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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.messageHandler = undefined;
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
