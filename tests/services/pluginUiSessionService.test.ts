import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALES, setLocale } from '../../src/i18n';
import type {
  InstalledPlugin,
  PluginInvocationResources,
  PluginNodeToolManifest,
  PluginVideoReplicaJobSummary,
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
  parseReplicaEffect: vi.fn(),
  startReplicaJob: vi.fn(),
  findReplicaJob: vi.fn(),
  getReplicaJob: vi.fn(),
  cancelReplicaJob: vi.fn(),
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
  parsePluginVideoReplicaEffect: mocks.parseReplicaEffect,
}));
vi.mock('../../src/services/plugins/pluginVideoReplicaJobService', () => ({
  startPluginVideoReplicaJob: mocks.startReplicaJob,
  findPluginVideoReplicaJob: mocks.findReplicaJob,
  getPluginVideoReplicaJob: mocks.getReplicaJob,
  cancelPluginVideoReplicaJob: mocks.cancelReplicaJob,
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

const replicaPlugin: InstalledPlugin = {
  ...plugin,
  manifest: { ...plugin.manifest, apiVersion: 2, runtime: 'python', entry: 'main.py', requiredCapabilities: ['video.replicaPipeline'] },
};
const replicaSummary: PluginVideoReplicaJobSummary = {
  jobId: 'video-replica-test-1', projectId: 'project-1', pluginId: plugin.id, nodeId: 'target',
  sourceDigest: SOURCE_DIGEST, revisionDigest: REVISION_DIGEST, modelId: 'general/video',
  status: 'queued', stage: '等待全片复刻', totalSegments: 2, completedSegments: 0, progress: 0,
  createdAt: 1, updatedAt: 1, segmentNodeIds: [],
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
  const replicaNative = (onClose = vi.fn()) => {
    mocks.getState().installedPlugins = [replicaPlugin];
    return createPluginUiNativeSession({ plugin: replicaPlugin, tool, nodeId: 'target', exportName: 'dialog', onClose });
  };

  it.each(LOCALES)('returns the current %s locale through the bound context', async (locale) => {
    const session = await native();
    setLocale(locale);
    expect(await session.request('context', null)).toMatchObject({ ok: true, value: { locale } });
    session.dispose();
  });

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
    expect(await session.request('context', null)).toMatchObject({ ok: true, value: {
      host: { apiVersions: [1, 2], capabilities: expect.arrayContaining(['javascript.async', 'invocation.cancel']),
        limits: { tool: { total: 32, model: 4 } } },
    } });
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
  it.each([
    { value: '文'.repeat(256_001), error: '字符串不能超过' },
    { value: Array.from({ length: 257 }, (_, index) => index), error: '数组不能超过' },
    { value: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key${index}`, index])), error: '对象不能超过' },
    { value: Array.from({ length: 9 }).reduce<unknown>((value) => ({ child: value }), '完整内容'), error: '嵌套深度不能超过' },
  ])('keeps existing parameters intact when an oversized UI edit or submit is rejected ($error)', async ({ value, error }) => {
    const session = await createPluginUiNativeSession({ plugin, tool, nodeId: 'target', exportName: 'dialog', parameters: { prompt: 'initial' }, onClose: vi.fn() });
    expect(await session.request('set-parameters', { prompt: value })).toMatchObject({ ok: false, error: expect.stringContaining(error) });
    expect(await session.request('submit', { data: { prompt: value } })).toMatchObject({ ok: false, error: expect.stringContaining(error) });
    expect(await session.request('context', null)).toMatchObject({ ok: true, value: { parameters: { prompt: 'initial' } } });
    expect(mocks.executeTool).not.toHaveBeenCalled();
    session.dispose();
  });
  it('rejects initial UI overflow and releases the canvas guard', async () => {
    await expect(createPluginUiNativeSession({ plugin, tool, nodeId: 'target', exportName: 'dialog', parameters: { prompt: '文'.repeat(256_001) }, onClose: vi.fn() })).rejects.toThrow('字符串不能超过');
    expect(mocks.mintResources).not.toHaveBeenCalled();
    expect(mocks.completeCanvasDerivation).toHaveBeenCalled();
  });
  it('rejects merged parameter overflow even when each patch is within its own limit', async () => {
    const parameters = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`field${index}`, index]));
    const session = await createPluginUiNativeSession({ plugin, tool, nodeId: 'target', exportName: 'dialog', parameters, onClose: vi.fn() });
    expect(await session.request('set-parameters', { extra: true })).toMatchObject({ ok: false, error: expect.stringContaining('对象不能超过') });
    expect(await session.request('submit', { data: { extra: true } })).toMatchObject({ ok: false, error: expect.stringContaining('对象不能超过') });
    expect(await session.request('context', null)).toMatchObject({ ok: true, value: { parameters } });
    expect(mocks.executeTool).not.toHaveBeenCalled();
    session.dispose();
  });
  it('accepts submitted data at the depth boundary without counting the transport envelope', async () => {
    const value = Array.from({ length: 7 }).reduce<unknown>((value) => ({ child: value }), '完整内容');
    const session = await native();
    expect(await session.request('submit', { data: { prompt: value } })).toMatchObject({ ok: true });
    expect(mocks.executeTool).toHaveBeenCalledWith(expect.anything(), 'target', expect.objectContaining({ prompt: value }), expect.anything());
    session.dispose();
  });
  it('limits settings and network effects independently of paid model calls', async () => {
    const session = await native();
    for (let i = 0; i < 64; i++) expect(await session.request('effect', { type: 'settings.get', key: 'preferences' })).toMatchObject({ ok: true });
    expect(await session.request('effect', { type: 'settings.get', key: 'preferences' })).toMatchObject({ ok: false, error: expect.stringContaining('64') });
    for (let i = 0; i < 16; i++) expect(await session.request('effect', { type: 'network.request', url: 'https://api.example.com' })).toMatchObject({ ok: true });
    expect(await session.request('effect', { type: 'network.request' })).toMatchObject({ ok: false, error: expect.stringContaining('16') });
    for (let i = 0; i < 4; i++) expect(await session.request('effect', { type: 'model.generate' })).toMatchObject({ ok: true });
    expect(mocks.executeEffect).toHaveBeenCalledWith(expect.objectContaining({ toolId: tool.id }));
    session.dispose();
  });

  it('transfers start to a bound observer and survives its own canvas writes', async () => {
    const onClose = vi.fn();
    const session = await replicaNative(onClose);
    const start = { type: 'video.replicaJob.start', resourceId: 'source-video', modelId: 'general/video', controls: ['depth'], audioMode: 'original', transcribe: true };
    expect(await session.request('effect', start)).toMatchObject({ ok: true, value: { type: start.type, ok: true, value: replicaSummary } });
    expect(mocks.startReplicaJob).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', pluginId: plugin.id, nodeId: 'target', sourceDigest: SOURCE_DIGEST, revisionDigest: REVISION_DIGEST,
      resources, resourceReadContext: expect.objectContaining({ invocationId: session.binding.sessionId }), signal: expect.any(AbortSignal),
    }), start);
    expect(mocks.executeEffect).not.toHaveBeenCalled();
    expect(mocks.clearResources).toHaveBeenCalledWith(session.binding.sessionId);
    expect(mocks.completeCanvasDerivation).toHaveBeenCalled();
    mocks.isCanvasDerivationFresh.mockReturnValue(false);
    notify();
    expect(session.isActive()).toBe(true);
    const latest = { ...replicaSummary, status: 'generating' as const, stage: '第 1 段', progress: 25 };
    mocks.getReplicaJob.mockResolvedValue(latest);
    expect(await session.request('context', null)).toMatchObject({ ok: true, value: {
      parameters: { replicaJob: latest }, resources: { self: [], incoming: [], inputs: {}, package: [], derived: [] },
    } });
    expect(onClose).not.toHaveBeenCalled();
    session.dispose();
  });

  it('keeps the ordinary session when speech-model preparation is required', async () => {
    mocks.startReplicaJob.mockResolvedValue({ speechModelsRequired: true });
    const session = await replicaNative();
    expect(await session.request('effect', { type: 'video.replicaJob.start' })).toMatchObject({ ok: true, value: { value: { speechModelsRequired: true } } });
    expect(mocks.clearResources).not.toHaveBeenCalled();
    expect(await session.request('set-parameters', { prompt: '继续准备' })).toMatchObject({ ok: true });
    expect(await session.request('effect', { type: 'video.replicaJob.status', jobId: replicaSummary.jobId })).toMatchObject({ ok: false, error: expect.stringContaining('绑定') });
    expect(mocks.getReplicaJob).not.toHaveBeenCalled();
    session.dispose();
  });

  it('rejects foreign task IDs and all writes in an observation session', async () => {
    const session = await replicaNative();
    await session.request('effect', { type: 'video.replicaJob.start' });
    for (const type of ['video.replicaJob.status', 'video.replicaJob.cancel']) {
      expect(await session.request('effect', { type, jobId: 'another-job' })).toMatchObject({ ok: false, error: expect.stringContaining('绑定') });
    }
    for (const type of ['model.generate', 'resource.readRange', 'video.replicaJob.start']) {
      expect(await session.request('effect', { type })).toMatchObject({ ok: false, error: expect.stringContaining('仅观察') });
    }
    expect(await session.request('set-parameters', { prompt: 'overwrite' })).toMatchObject({ ok: false, error: expect.stringContaining('仅观察') });
    expect(await session.request('submit', { data: {} })).toMatchObject({ ok: false, error: expect.stringContaining('仅观察') });
    expect(mocks.executeEffect).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(mocks.getReplicaJob).not.toHaveBeenCalled();
    expect(mocks.cancelReplicaJob).not.toHaveBeenCalled();
    session.dispose();
  });

  it('closes observation without cancelling the independent background job', async () => {
    const onClose = vi.fn();
    const session = await replicaNative(onClose);
    await session.request('effect', { type: 'video.replicaJob.start' });
    expect(await session.request('close', null)).toMatchObject({ ok: true });
    session.finishRequest();
    await Promise.resolve();
    expect(session.isActive()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.cancelReplicaJob).not.toHaveBeenCalled();
  });

  it('recovers the same task when reopened without minting new media grants', async () => {
    mocks.findReplicaJob.mockResolvedValue({ ...replicaSummary, status: 'paused', stage: '待核对' });
    const session = await replicaNative();
    expect(mocks.mintResources).not.toHaveBeenCalled();
    expect(mocks.findReplicaJob).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', pluginId: plugin.id, nodeId: 'target', revisionDigest: REVISION_DIGEST }));
    expect(await session.request('effect', { type: 'video.replicaJob.status', jobId: replicaSummary.jobId })).toMatchObject({ ok: true, value: { value: replicaSummary } });
    expect(mocks.startReplicaJob).not.toHaveBeenCalled();
    expect(await session.request('submit', {})).toMatchObject({ ok: false });
    session.dispose();
  });

  it('does not resurrect an observer after a delayed lookup crosses a project switch', async () => {
    let finish!: (value: PluginVideoReplicaJobSummary) => void;
    mocks.findReplicaJob.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = replicaNative();
    await vi.waitFor(() => expect(mocks.findReplicaJob).toHaveBeenCalledTimes(1));
    mocks.getState().currentProjectId = 'project-2';
    notify();
    mocks.getState().currentProjectId = 'project-1';
    finish(replicaSummary);
    await expect(pending).rejects.toThrow('关闭');
    expect(mocks.mintResources).not.toHaveBeenCalled();
    expect(mocks.subscribers.size).toBe(0);
  });

  it('keeps an observer bound to its real iframe window', async () => {
    mocks.getState().installedPlugins = [replicaPlugin];
    const session = await createPluginUiFrameSession({ plugin: replicaPlugin, tool, nodeId: 'target', exportName: 'dialog', onClose: vi.fn() });
    const frame = { postMessage: vi.fn() } as unknown as Window;
    session.attach(frame);
    mocks.messageHandler?.({ data: request(session.sessionId, 'start', 'effect', { type: 'video.replicaJob.start' }), source: frame } as MessageEvent);
    await vi.waitFor(() => expect(frame.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'start', ok: true }), '*'));
    mocks.messageHandler?.({ data: request(session.sessionId, 'spoof-status', 'effect', { type: 'video.replicaJob.status', jobId: replicaSummary.jobId }), source: {} } as MessageEvent);
    await Promise.resolve();
    expect(mocks.getReplicaJob).not.toHaveBeenCalled();
    mocks.messageHandler?.({ data: request(session.sessionId, 'status', 'effect', { type: 'video.replicaJob.status', jobId: replicaSummary.jobId }), source: frame } as MessageEvent);
    await vi.waitFor(() => expect(mocks.getReplicaJob).toHaveBeenCalledTimes(1));
    session.dispose();
  });

  it('does not replace its bound task with a different summary returned during observation', async () => {
    const session = await replicaNative();
    await session.request('effect', { type: 'video.replicaJob.start' });
    mocks.getReplicaJob.mockResolvedValue({ ...replicaSummary, jobId: 'video-replica-foreign' });
    expect(await session.request('effect', { type: 'video.replicaJob.status', jobId: replicaSummary.jobId })).toMatchObject({ ok: false, error: expect.stringContaining('不匹配') });
    expect(await session.request('effect', { type: 'video.replicaJob.cancel', jobId: 'video-replica-foreign' })).toMatchObject({ ok: false, error: expect.stringContaining('绑定') });
    expect(mocks.cancelReplicaJob).not.toHaveBeenCalled();
    session.dispose();
  });

  it.each(['project', 'node', 'disabled', 'source', 'revision', 'ui'])('revokes an observer on %s identity changes', async (change) => {
    mocks.findReplicaJob.mockResolvedValue(replicaSummary);
    const onClose = vi.fn();
    const session = await replicaNative(onClose);
    const state = mocks.getState();
    if (change === 'project') state.currentProjectId = 'project-2';
    else if (change === 'node') state.nodes = [];
    else state.installedPlugins = [{ ...replicaPlugin, ...({
      disabled: { enabled: false }, source: { sourceDigest: 'd'.repeat(64) },
      revision: { revisionDigest: 'd'.repeat(64) }, ui: { uiDigest: 'd'.repeat(64) },
    }[change]) }];
    notify();
    expect(session.isActive()).toBe(false);
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.cancelReplicaJob).not.toHaveBeenCalled();
  });

  it('throttles status reads, permits immediate cancel, and uses a separate bounded query budget', async () => {
    const session = await replicaNative();
    await session.request('effect', { type: 'video.replicaJob.start' });
    let now = 1000;
    const time = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      expect(await session.request('effect', { type: 'video.replicaJob.status', jobId: replicaSummary.jobId })).toMatchObject({ ok: true });
      expect(await session.request('effect', { type: 'video.replicaJob.status', jobId: replicaSummary.jobId })).toMatchObject({ ok: false, error: expect.stringContaining('250') });
      expect(await session.request('effect', { type: 'video.replicaJob.cancel', jobId: replicaSummary.jobId })).toMatchObject({ ok: true });
      for (let index = 0; index < 2046; index += 1) {
        now += 250;
        expect(await session.request('effect', { type: 'video.replicaJob.status', jobId: replicaSummary.jobId })).toMatchObject({ ok: true });
      }
      now += 250;
      expect(await session.request('effect', { type: 'video.replicaJob.status', jobId: replicaSummary.jobId })).toMatchObject({ ok: false, error: expect.stringContaining('2048') });
      expect(await session.request('context', null)).toMatchObject({ ok: true });
      expect(await session.request('close', null)).toMatchObject({ ok: true });
    } finally {
      time.mockRestore();
      session.dispose();
    }
  });
  it('bounds mention queries independently of paid model calls', async () => {
    const session = await native();
    for (let i = 0; i < 96; i++) expect(await session.request('effect', { type: 'prompt.mentions', source: 'nodes' })).toMatchObject({ ok: true });
    expect(await session.request('effect', { type: 'prompt.mentions', source: 'nodes' })).toMatchObject({ ok: false, error: expect.stringContaining('96') });
    for (let i = 0; i < 4; i++) expect(await session.request('effect', { type: 'model.generate' })).toMatchObject({ ok: true });
    expect(await session.request('effect', { type: 'model.generate' })).toMatchObject({ ok: false });
    session.dispose();
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
    for (let i = 0; i < 96; i++) expect(await send(i % 2 ? 'image.lineArt' : 'video.inspectFrame')).toMatchObject({ ok: true });
    expect(await send('image.lineArt')).toMatchObject({ ok: false, error: expect.stringContaining('96') });
    for (let i = 0; i < 4; i++) expect(await send('model.generate')).toMatchObject({ ok: true });
    expect(await send('model.generate')).toMatchObject({ ok: false });
    expect(await send('resource.export')).toMatchObject({ ok: true });
    session.dispose();
  });
  it('bounds range reads separately while preserving model, media and export budgets', async () => {
    const session = await createPluginUiNativeSession({ plugin, tool, nodeId: 'target', exportName: 'dialog', parameters: {}, onClose: vi.fn() });
    for (let i = 0; i < 96; i++) {
      expect(await session.request('effect', { type: 'resource.readRange', resourceId: 'opaque-resource', offset: i, length: 1 })).toMatchObject({ ok: true });
    }
    expect(await session.request('effect', { type: 'resource.readRange', length: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('96') });
    for (let i = 0; i < 4; i++) expect(await session.request('effect', { type: 'model.generate' })).toMatchObject({ ok: true });
    expect(await session.request('effect', { type: 'model.generate' })).toMatchObject({ ok: false });
    expect(await session.request('effect', { type: 'video.inspectFrame' })).toMatchObject({ ok: true });
    for (let i = 0; i < 24; i++) {
      expect(await session.request('effect', { type: 'image.lineArt', resourceId: `frame-${i}` })).toMatchObject({ ok: true });
    }
    expect(await session.request('effect', { type: 'resource.export' })).toMatchObject({ ok: true });
    session.dispose();
  });
  it('rejects invalid read lengths and enforces the cumulative byte limit even on failed reads', async () => {
    const session = await createPluginUiNativeSession({ plugin, tool, nodeId: 'target', exportName: 'dialog', parameters: {}, onClose: vi.fn() });
    for (const length of [0, -1, 0.5, '1', 256 * 1024 + 1, NaN]) {
      expect(await session.request('effect', { type: 'resource.readRange', length })).toMatchObject({ ok: false });
    }
    expect(mocks.executeEffect).not.toHaveBeenCalled();
    mocks.executeEffect.mockRejectedValue(new Error('资源已失效'));
    for (let i = 0; i < 64; i++) {
      expect(await session.request('effect', { type: 'resource.readRange', length: 256 * 1024 })).toMatchObject({ ok: false, error: '资源已失效' });
    }
    expect(await session.request('effect', { type: 'resource.readRange', length: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('16 MiB') });
    expect(mocks.executeEffect).toHaveBeenCalledTimes(64);
    mocks.executeEffect.mockResolvedValue({ type: 'image.lineArt', ok: true });
    for (let i = 0; i < 24; i++) {
      expect(await session.request('effect', { type: 'image.lineArt', resourceId: `frame-${i}` })).toMatchObject({ ok: true });
    }
    session.dispose();
  });
  beforeEach(() => {
    setLocale('zh-CN');
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
    mocks.parseReplicaEffect.mockImplementation((value) => value);
    mocks.startReplicaJob.mockResolvedValue(replicaSummary);
    mocks.findReplicaJob.mockResolvedValue(undefined);
    mocks.getReplicaJob.mockResolvedValue(replicaSummary);
    mocks.cancelReplicaJob.mockResolvedValue({ ...replicaSummary, status: 'cancelled', stage: '已取消' });
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

    session.updateLocale('ko-KR');
    expect(frame.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      direction: 'event', sessionId: session.sessionId, kind: 'locale', value: 'ko-KR',
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
