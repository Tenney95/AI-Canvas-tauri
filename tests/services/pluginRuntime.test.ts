/**
 * pluginRuntime — 回归测试：plugin execution cancellation and categorized budgets。
 */
import {
  plugin,
  customNodePlugin,
  modelCatalog,
} from './pluginRuntime/pluginFixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { setLocale } from '../../src/i18n';
import type { InstalledPlugin, PluginInvocationResources, PluginNodeSetItem, PluginNodeSetEdge } from '../../src/types/plugin';
import {
  executeNodePluginTool,
  executePluginNode,
  getAvailablePluginNodes,
  getAvailableNodePluginTools,
} from '../../src/services/plugins/pluginRuntime';
import { completeCanvasDerivation, cancelProjectCanvasDerivations, registerCanvasDerivation } from '../../src/services/canvasDerivationGuard';
import { registerNodeExecutionTests } from './pluginRuntime/nodeExecution';
import { registerModelEffectTests } from './pluginRuntime/modelEffects';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  revision: 3,
  updateNodeData: vi.fn(),
  addNode: vi.fn(),
  addNodesWithEdges: vi.fn(),
  showToast: vi.fn(),
  saveBinaryToProjectData: vi.fn(),
  moveToTrash: vi.fn(),
  readDerivedResource: vi.fn(),
  getLineArtResource: vi.fn(),
  setLineArtResource: vi.fn(),
  createLineArtImage: vi.fn(),
  registerDerivedResource: vi.fn(),
  resolveResourceHostUrl: vi.fn(),
  resolveMediaInputs: vi.fn(),
  extractVideoFrames: vi.fn(),
  detectShots: vi.fn(),
  inspectFrame: vi.fn(),
  generateText: vi.fn(),
  generateImage: vi.fn(),
  queryPromptMentions: vi.fn(),
  rewritePromptReferences: vi.fn(),
  resolvePromptReferences: vi.fn(),
  resolveMediaModel: vi.fn(),
  startVideoBatch: vi.fn(),
  buildModelCatalog: vi.fn(() => [] as Array<Record<string, unknown>>),
  state: {} as Record<string, unknown>,
  subscribers: new Set<() => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => mocks.state, subscribe: (listener: () => void) => {
    mocks.subscribers.add(listener);
    return () => mocks.subscribers.delete(listener);
  } },
}));
vi.mock('../../src/services/plugins/pluginModelCatalog', () => ({
  buildPluginModelCatalog: mocks.buildModelCatalog,
  collectDeclaredModelCategories: () => ['text'],
}));
vi.mock('../../src/services/ai/generateText', () => ({ generateText: mocks.generateText }));
vi.mock('../../src/services/ai/generateImage', () => ({ generateImage: mocks.generateImage }));
vi.mock('../../src/services/ai/generateVideo', () => ({ generateVideo: vi.fn() }));
vi.mock('../../src/services/ai/generateAudio', () => ({ generateAudio: vi.fn() }));
vi.mock('../../src/services/ai/generationRuntime', () => ({ resolveMediaModel: mocks.resolveMediaModel }));
vi.mock('../../src/services/fileService', () => ({
  saveBinaryToProjectData: mocks.saveBinaryToProjectData,
  moveToTrash: mocks.moveToTrash,
}));
vi.mock('../../src/services/plugins/pluginResourceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/plugins/pluginResourceService')>();
  return {
    ...actual,
    readPluginDerivedResourceForOutput: mocks.readDerivedResource,
    getPluginLineArtResource: mocks.getLineArtResource,
    setPluginLineArtResource: mocks.setLineArtResource,
    registerPluginDerivedResource: mocks.registerDerivedResource,
    resolvePluginResourceHostUrl: mocks.resolveResourceHostUrl,
    resolvePluginMediaWorkspaceInputs: mocks.resolveMediaInputs,
  };
});
vi.mock('../../src/services/plugins/pluginVideoFrameService', () => ({
  extractPluginVideoFrames: mocks.extractVideoFrames,
  detectPluginVideoShots: mocks.detectShots,
  inspectPluginVideoFrame: mocks.inspectFrame,
}));
vi.mock('../../src/services/plugins/pluginImageService', () => ({
  createPluginLineArtImage: mocks.createLineArtImage,
}));
vi.mock('../../src/services/plugins/pluginPromptReferenceService', () => ({
  queryPluginPromptMentions: mocks.queryPromptMentions,
  rewritePluginPromptReferences: mocks.rewritePromptReferences,
  resolvePluginPromptReferencesForModel: mocks.resolvePromptReferences,
  clearPluginPromptReferences: vi.fn(),
  clearPluginPromptReferencesForPlugin: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  setLocale('zh-CN');
  vi.clearAllMocks();
  mocks.queryPromptMentions.mockReset().mockResolvedValue({ items: [], hasMore: false });
  mocks.rewritePromptReferences.mockReset().mockImplementation(async (text: string) => text);
  mocks.resolvePromptReferences.mockReset().mockImplementation(async (prompt: string) => ({ prompt, imageUrls: [] }));
  mocks.revision = 3;
  mocks.subscribers.clear();
  mocks.state = {
    currentProjectId: 'project-1',
    nodes: [{
      id: 'node-1',
      type: 'ai-text',
      position: { x: 10, y: 20 },
      data: {
        label: '文本',
        type: 'ai-text',
        output: 'before',
        filePath: '/Users/private/secret.txt',
      },
    }],
    installedPlugins: [plugin],
    edges: [],
    getCurrentRevision: () => mocks.revision,
    updateNodeData: mocks.updateNodeData,
    addNode: mocks.addNode,
    addNodesWithEdges: mocks.addNodesWithEdges,
    showToast: mocks.showToast,
    startVideoBatch: mocks.startVideoBatch,
  };
  mocks.invoke.mockResolvedValue({ data: { output: 'after' }, message: '完成' });
  mocks.generateText.mockResolvedValue('模型结果');
  mocks.startVideoBatch.mockReset().mockResolvedValue(undefined);
  mocks.resolveMediaModel.mockReset().mockImplementation((_kind, modelId: string) => modelId.startsWith('comfyui/')
    ? { configId: modelId, requestModel: 'comfyui/workflow', provider: 'comfyui', workflowId: modelId.slice(8) }
    : { configId: modelId, requestModel: modelId, provider: 'general' });
  mocks.saveBinaryToProjectData.mockReset().mockResolvedValue({
    filePath: 'G:\\project\\plugin-output.txt',
    assetUrl: 'asset://localhost/plugin-output.txt',
  });
  mocks.moveToTrash.mockResolvedValue(undefined);
  mocks.getLineArtResource.mockReset().mockReturnValue(undefined);
  mocks.setLineArtResource.mockReset();
  mocks.createLineArtImage.mockReset().mockResolvedValue({
    bytes: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png', width: 480, height: 720,
    previewDataUrl: 'data:image/png;base64,iVBORw==',
  });
  mocks.readDerivedResource.mockImplementation((_context, resourceId: string) => ({
    resource: {
      resourceId,
      origin: 'derived',
      displayName: `${resourceId}.jpg`,
      mediaType: 'image/jpeg',
      size: 3,
      access: 'read',
    },
    bytes: new Uint8Array([1, 2, 3]),
  }));
  mocks.resolveResourceHostUrl.mockResolvedValue('asset://localhost/video.mp4');
  mocks.resolveMediaInputs.mockReset().mockResolvedValue([{ resourceId: 'self-video', path: 'G:\\project\\reference.mp4' }]);
  mocks.registerDerivedResource.mockImplementation((_context, resources: PluginInvocationResources, options) => {
    const ref = {
      resourceId: `derived-${resources.derived.length + 1}`,
      origin: 'derived' as const,
      displayName: options.displayName,
      mediaType: options.mediaType,
      size: options.bytes.byteLength,
      access: 'read' as const,
    };
    resources.derived.push(ref);
    return ref;
  });
  mocks.buildModelCatalog.mockReturnValue(modelCatalog);
  mocks.generateImage.mockResolvedValue({ url: 'https://example.com/result.png', width: 1024, height: 1024 });
});

describe('plugin execution cancellation and categorized budgets', () => {
  const notify = () => { for (const listener of mocks.subscribers) listener(); };

  it.each(['project', 'node', 'revision', 'plugin', 'guard', 'dependency'])('cancels an active native tool after %s changes and releases listeners', async (change) => {
    const dependent: InstalledPlugin = { ...plugin, manifest: { ...plugin.manifest, apiVersion: 2,
      requiredCapabilities: ['plugin.dependencies'], dependencies: [{ pluginId: 'example.base' }] } };
    const base: InstalledPlugin = { ...plugin, id: 'example.base', manifest: { ...plugin.manifest, id: 'example.base' } };
    if (change === 'dependency') mocks.state.installedPlugins = [dependent, base];
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((command) => command === 'execute_node_plugin_tool'
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
    const run = executeNodePluginTool(getAvailableNodePluginTools([plugin], 'ai-text')[0], 'node-1');
    const assertion = expect(run).rejects.toThrow(/已取消|已变化|禁用/);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (change === 'project') mocks.state.currentProjectId = 'other';
    if (change === 'node') mocks.state.nodes = [];
    if (change === 'revision') mocks.revision += 1;
    if (change === 'plugin') mocks.state.installedPlugins = [{ ...plugin, enabled: false }];
    if (change === 'guard') cancelProjectCanvasDerivations('project-1');
    if (change === 'dependency') mocks.state.installedPlugins = [dependent, { ...base, revisionDigest: 'd'.repeat(64) }];
    notify();
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_node_plugin_tool', expect.objectContaining({ pluginId: plugin.id }));
    finish({ data: { output: 'late' } });
    await assertion;
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
    expect(mocks.subscribers.size).toBe(0);
  });

  it('aborts a custom node model request when its project is switched', async () => {
    mocks.state.installedPlugins = [customNodePlugin];
    mocks.invoke.mockResolvedValue({ effect: { type: 'model.generate', modelId: 'text-model', prompt: '测试' } });
    let receivedSignal: AbortSignal | undefined;
    mocks.generateText.mockImplementation(({ signal }) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('取消生成')), { once: true }));
    });
    const run = executePluginNode(getAvailablePluginNodes([customNodePlugin])[0], 'node-1', [
      { id: 'text-model', name: '文本', provider: 'general', category: 'text' },
    ]);
    const assertion = expect(run).rejects.toThrow(/已变化|已取消/);
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    mocks.state.currentProjectId = 'other';
    notify();
    await assertion;
    expect(receivedSignal!.aborted).toBe(true);
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
    expect(mocks.subscribers.size).toBe(0);
  });

  it.each([false, true])('uses separate settings and network budgets, exceed=%s', async (exceed) => {
    const installed: InstalledPlugin = { ...plugin, manifest: { ...plugin.manifest,
      permissions: ['node.read', 'node.write', 'settings.read', 'network.request'],
      network: { allowedOrigins: ['https://api.example.com'] },
    } };
    mocks.state.installedPlugins = [installed];
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === 'execute_plugin_host_effect') return { found: false };
      const iteration = args.input.iteration;
      if (iteration < 8) return { effect: { type: 'settings.get', key: 'preferences' } };
      if (iteration < (exceed ? 17 : 10)) return { effect: { type: 'network.request', url: 'https://api.example.com' } };
      return { data: { output: '完成' } };
    });
    const run = executeNodePluginTool(getAvailableNodePluginTools([installed], 'ai-text')[0], 'node-1');
    if (exceed) {
      await expect(run).rejects.toThrow('network 操作不能超过 8 次');
      expect(mocks.updateNodeData).not.toHaveBeenCalled();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'execute_plugin_host_effect')).toHaveLength(16);
    } else {
      await run;
      expect(mocks.updateNodeData).toHaveBeenCalledWith('node-1', { output: '完成' });
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'execute_plugin_host_effect')).toHaveLength(10);
    }
    expect(mocks.subscribers.size).toBe(0);
  });
});

export type PluginRuntimeMocks = typeof mocks;

describe('node plugin runtime', () => {
  registerNodeExecutionTests(mocks);
});

describe('trusted Python media workspace', () => {
  function setup(enabled = true, materialsOnly = false) {
    const bytes = new Uint8Array([
      0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0,
      0, 0, 0, 8, 109, 111, 111, 118,
      0, 0, 0, 9, 109, 100, 97, 116, 1,
    ]);
    const artifact = { key: 'depth', artifactId: 'plugin-artifact-random', displayName: 'depth.mp4',
      mediaType: 'video/mp4', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    const payload: { data: { nodes: PluginNodeSetItem[]; edges: PluginNodeSetEdge[] }; artifacts: Array<typeof artifact> } = {
      data: { nodes: [{ key: 'control', nodeType: 'source-video', artifactKey: 'depth', data: { label: '深度视频' } }], edges: [] }, artifacts: [artifact],
    };
    const workspacePlugin: InstalledPlugin = { ...plugin, manifest: { ...plugin.manifest, apiVersion: 2,
      runtime: 'python', entry: 'main.py', requiredCapabilities: enabled ? ['python.mediaWorkspace', 'python.executionTimeout', ...(materialsOnly ? ['video.replicaPipeline'] : [])] : [],
      permissions: ['node.read', 'node.write', 'files.connected.read', 'files.output.create'],
      contributes: { nodeTools: [{ id: 'controls', title: '生成控制视频', nodeTypes: ['source-video'],
        placements: ['node-context-menu'], inputFields: ['label'], resourceAccess: { self: true },
        ...(enabled ? { pythonExecution: { timeoutSeconds: 120, mediaWorkspace: true } } : {}),
        output: { mode: 'create-node-set', nodeTypes: ['source-video', 'ai-shotlist'], maxNodes: 25, fields: ['label'] } }] },
    } };
    mocks.state.nodes = [{ id: 'node-1', type: 'source-video', position: { x: 0, y: 0 }, data: { type: 'source-video', label: '参考视频' } }];
    mocks.state.installedPlugins = [workspacePlugin];
    const resources: PluginInvocationResources = { self: [{ resourceId: 'self-video', origin: 'node-self', access: 'read',
      displayName: 'reference.mp4', mediaType: 'video/mp4', size: 100, source: { nodeId: 'node-1' } }],
      incoming: [], inputs: {}, package: [], derived: [] };
    const guard = registerCanvasDerivation(mocks.state as never, 'node-1')!;
    const tool = getAvailableNodePluginTools([workspacePlugin], 'source-video')[0];
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'execute_node_plugin_tool') return payload;
      if (command === 'read_plugin_media_artifact') return Array.from(bytes);
      return undefined;
    });
    mocks.saveBinaryToProjectData.mockImplementation(async (_bytes, _project, fileName: string) => ({
      assetUrl: `asset://localhost/${fileName}`, filePath: `G:\\project\\${fileName}`,
    }));
    const run = (materialLayout?: NonNullable<Parameters<typeof executeNodePluginTool>[4]>['materialLayout']) => executeNodePluginTool(tool, 'node-1', {}, { invocationId: 'native-video-invoke', guard, resources }, materialsOnly ? { materialsOnly: true, materialLayout } : undefined)
      .finally(() => completeCanvasDerivation(guard));
    return { run, payload, bytes, tool, workspacePlugin };
  }

  it('returns committed materials and key bindings for a host pipeline without starting a video batch', async () => {
    const { run } = setup(true, true);
    const result = await run();
    if (!result) throw new Error('宿主素材调用没有返回节点集合');
    expect(result).toMatchObject({ nodes: [expect.objectContaining({ type: 'source-video' })], edges: [], nodeIdsByKey: { control: expect.any(String) } });
    expect(result.nodeIdsByKey.control).toBe(result.nodes[0].id);
    expect(mocks.addNodesWithEdges).toHaveBeenCalledTimes(1);
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
  });

  it('rejects a host material invocation without pipeline capability before saving', async () => {
    const { run, workspacePlugin } = setup(true, true);
    workspacePlugin.manifest.requiredCapabilities = ['python.mediaWorkspace', 'python.executionTimeout'];
    await expect(run()).rejects.toThrow('全片任务能力');
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
  });

  it('projects only media nodes for a host task without saving source frames or creating display-only nodes', async () => {
    const { run, payload, tool } = setup(true, true);
    tool.tool.output.nodeTypes!.push('source-image', 'ai-markdown');
    payload.data.nodes.push(
      { key: 'frame', nodeType: 'source-image', resourceId: 'derived-frame', data: { label: '原片首帧' } },
      { key: 'shotlist', nodeType: 'ai-shotlist', data: { label: '分镜方案' } },
      { key: 'prompts', nodeType: 'ai-markdown', data: { label: '提示词' } },
    );
    payload.data.edges.push({ sourceKey: 'frame', targetKey: 'shotlist' }, { sourceKey: 'shotlist', targetKey: 'control' }, { sourceKey: 'shotlist', targetKey: 'prompts' });
    const result = await run();
    if (!result) throw new Error('宿主素材调用没有返回节点集合');
    expect(result).toMatchObject({ nodes: [expect.objectContaining({ type: 'source-video' })], edges: [], nodeIdsByKey: { control: expect.any(String) } });
    expect(Object.keys(result.nodeIdsByKey)).toEqual(['control']);
    expect(mocks.readDerivedResource).toHaveBeenCalledWith(expect.any(Object), 'derived-frame', 'original');
    expect(mocks.saveBinaryToProjectData).toHaveBeenCalledTimes(1);
    expect(mocks.saveBinaryToProjectData.mock.calls[0][2]).toBe('plugin-video-depth.mp4');
    expect(mocks.addNodesWithEdges).toHaveBeenCalledTimes(1);
    expect(mocks.addNodesWithEdges.mock.calls[0][0]).toHaveLength(1);
  });

  it('still validates removed frame leases and graph edges before saving host materials', async () => {
    const { run, payload, tool } = setup(true, true);
    tool.tool.output.nodeTypes!.push('source-image');
    payload.data.nodes.push({ key: 'frame', nodeType: 'source-image', resourceId: 'expired-frame', data: { label: '原片首帧' } });
    mocks.readDerivedResource.mockImplementation(() => { throw new Error('插件资源授权已失效'); });
    await expect(run()).rejects.toThrow('资源授权已失效');
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled(); expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
    const next = setup(true, true);
    next.payload.data.edges.push({ sourceKey: 'not-returned', targetKey: 'control' });
    await expect(next.run()).rejects.toThrow('节点集连线引用无效');
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
  });

  it('lays out host controls in one column using host dimensions and preserves their source group', async () => {
    const { run, payload } = setup(true, true);
    (mocks.state.nodes as Array<Record<string, unknown>>)[0].parentId = 'source-group';
    payload.artifacts.push({ ...payload.artifacts[0], key: 'depth2', artifactId: 'plugin-artifact-second' });
    payload.data.nodes.push({ key: 'control2', nodeType: 'source-video', artifactKey: 'depth2', data: { label: '第二份深度视频' } });
    const result = await run({ position: { x: 400, y: 100 }, nodeWidth: 320, nodeHeight: 180, gap: 40 });
    if (!result) throw new Error('宿主素材调用没有返回节点集合');
    expect(result.nodes).toMatchObject([
      { position: { x: 400, y: 100 }, parentId: 'source-group', data: { nodeWidth: 320, nodeHeight: 180 } },
      { position: { x: 400, y: 320 }, parentId: 'source-group', data: { nodeWidth: 320, nodeHeight: 180 } },
    ]);
    expect(mocks.addNodesWithEdges).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary plugin display nodes and their existing layout', async () => {
    const { run, payload, tool } = setup();
    tool.tool.output.nodeTypes!.push('ai-markdown');
    payload.data.nodes.push({ key: 'shotlist', nodeType: 'ai-shotlist', data: { label: '分镜方案' } }, { key: 'prompts', nodeType: 'ai-markdown', data: { label: '提示词' } });
    payload.data.edges.push({ sourceKey: 'shotlist', targetKey: 'control' }, { sourceKey: 'shotlist', targetKey: 'prompts' });
    await run();
    const [nodes, edges] = mocks.addNodesWithEdges.mock.calls[0];
    expect(nodes.map((node: { type: string }) => node.type)).toEqual(['source-video', 'ai-shotlist', 'ai-markdown']);
    expect(edges).toHaveLength(2);
    expect(new Set(nodes.map((node: { position: { x: number } }) => node.position.x)).size).toBe(3);
  });

  it('checks every native artifact but saves only artifacts retained by the host projection', async () => {
    const { run, payload, tool } = setup(true, true);
    tool.tool.output.nodeTypes!.push('ai-video');
    payload.artifacts.push({ ...payload.artifacts[0], key: 'unused', artifactId: 'plugin-artifact-unused' });
    payload.data.nodes.push({ key: 'unused-result', nodeType: 'ai-video', artifactKey: 'unused', data: { label: '插件额外返回的成片' } });
    const result = await run();
    if (!result) throw new Error('宿主素材调用没有返回节点集合');
    expect(result.nodes).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'read_plugin_media_artifact')).toHaveLength(2);
    expect(mocks.saveBinaryToProjectData).toHaveBeenCalledTimes(1);
    expect(mocks.saveBinaryToProjectData.mock.calls[0][2]).toBe('plugin-video-depth.mp4');
  });

  it('rejects an invalid native artifact even when its display node would be removed', async () => {
    const { run, payload, tool } = setup(true, true);
    tool.tool.output.nodeTypes!.push('ai-video');
    payload.artifacts.push({ ...payload.artifacts[0], key: 'unused', artifactId: 'plugin-artifact-unused', sha256: 'c'.repeat(64) });
    payload.data.nodes.push({ key: 'unused-result', nodeType: 'ai-video', artifactKey: 'unused', data: { label: '插件额外返回的成片' } });
    await expect(run()).rejects.toThrow();
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled(); expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
  });

  it('prepares only host-resolved inputs, reads verified native artifacts and commits one video batch', async () => {
    const { run, bytes } = setup();
    await run();
    const commands = mocks.invoke.mock.calls.map(([command]) => command);
    expect(commands).toEqual(['prepare_plugin_media_workspace', 'execute_node_plugin_tool', 'read_plugin_media_artifact', 'release_plugin_media_workspace']);
    const identity = { pluginId: plugin.id, sourceDigest: plugin.sourceDigest, revisionDigest: plugin.revisionDigest,
      toolId: 'controls', invocationId: 'native-video-invoke' };
    expect(mocks.invoke).toHaveBeenCalledWith('prepare_plugin_media_workspace', { identity,
      inputs: [{ resourceId: 'self-video', path: 'G:\\project\\reference.mp4' }] });
    const nativeInput = mocks.invoke.mock.calls.find(([command]) => command === 'execute_node_plugin_tool')?.[1].input;
    expect(JSON.stringify(nativeInput)).not.toContain('G:\\project');
    expect(nativeInput).not.toHaveProperty('nativeMedia');
    expect(mocks.saveBinaryToProjectData).toHaveBeenCalledWith(bytes, 'project-1', 'plugin-video-depth.mp4', { throwOnError: true });
    expect(mocks.addNodesWithEdges).toHaveBeenCalledTimes(1);
    expect(mocks.addNodesWithEdges.mock.calls[0][0][0]).toMatchObject({ type: 'source-video', data: {
      videoUrl: 'asset://localhost/plugin-video-depth.mp4', filePath: 'G:\\project\\plugin-video-depth.mp4',
      fileName: 'plugin-video-depth.mp4', relativePath: 'plugin-video-depth.mp4',
    } });
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
  });

  it('rejects artifacts from an undeclared Python tool without using any native media bridge', async () => {
    const { run } = setup(false);
    await expect(run()).rejects.toThrow('获准的 Python 媒体工作区');
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['execute_node_plugin_tool']);
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
  });

  it.each(['artifact-path', 'display-path', 'key-path', 'raw-file', 'mismatch', 'oversized', 'effect', 'wrong-node', 'resource-conflict', 'protected-path'] as const)('rejects %s descriptors before reading or saving an output', async (invalid) => {
      const { run, payload } = setup();
      if (invalid === 'artifact-path') payload.artifacts[0].artifactId = '../depth.mp4';
      if (invalid === 'display-path') payload.artifacts[0].displayName = 'C:\\private\\depth.mp4';
      if (invalid === 'key-path') payload.data.nodes[0].artifactKey = '../depth';
      if (invalid === 'raw-file') Object.assign(payload.artifacts[0], { fileName: 'depth.mp4' });
      if (invalid === 'mismatch') payload.data.nodes[0].artifactKey = 'unknown';
      if (invalid === 'oversized') payload.artifacts[0].size = 16 * 1024 * 1024 + 1;
      if (invalid === 'effect') Object.assign(payload, { effect: { type: 'settings.get', key: 'prefs' } });
      if (invalid === 'wrong-node') payload.data.nodes[0].nodeType = 'ai-shotlist';
      if (invalid === 'resource-conflict') Object.assign(payload.data.nodes[0], { resourceId: 'derived-image' });
      if (invalid === 'protected-path') Object.assign(payload.data.nodes[0].data, { filePath: 'C:\\private\\output.mp4' });
      await expect(run()).rejects.toThrow();
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'read_plugin_media_artifact')).toBe(false);
      expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
      expect(mocks.invoke).toHaveBeenCalledWith('release_plugin_media_workspace', expect.any(Object));
    });

  it.each(['bytes', 'digest', 'stale-read'] as const)('rejects %s native artifact results before writing project files', async (failure) => {
    const { run, payload, bytes } = setup();
    if (failure === 'digest') payload.artifacts[0].sha256 = 'c'.repeat(64);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'execute_node_plugin_tool') return payload;
      if (command === 'read_plugin_media_artifact') {
        if (failure === 'stale-read') mocks.revision++;
        return failure === 'bytes' ? [256, ...Array.from(bytes).slice(1)] : Array.from(bytes);
      }
      return undefined;
    });
    await expect(run()).rejects.toThrow();
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('release_plugin_media_workspace', expect.any(Object));
  });

  it.each(['stale-save', 'commit', 'empty-url'] as const)('recycles saved video artifacts and releases the workspace on %s', async (failure) => {
    const { run } = setup();
    if (failure === 'commit') mocks.addNodesWithEdges.mockImplementationOnce(() => { throw new Error('提交失败'); });
    const save = mocks.saveBinaryToProjectData.getMockImplementation()!;
    mocks.saveBinaryToProjectData.mockImplementation(async (...args) => {
      const saved = await save(...args);
      if (failure === 'stale-save') mocks.revision++;
      return failure === 'empty-url' ? { ...saved, assetUrl: '' } : saved;
    });
    await expect(run()).rejects.toThrow();
    expect(mocks.moveToTrash).toHaveBeenCalledWith('G:\\project\\plugin-video-depth.mp4');
    expect(mocks.invoke).toHaveBeenCalledWith('release_plugin_media_workspace', expect.any(Object));
    if (failure !== 'commit') expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
  });

  it('releases a workspace after a preparation failure without executing the Python tool', async () => {
    const { run } = setup();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'prepare_plugin_media_workspace') throw new Error('源视频发生变化');
      return undefined;
    });
    await expect(run()).rejects.toThrow('源视频发生变化');
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['prepare_plugin_media_workspace', 'release_plugin_media_workspace']);
  });

  it('rejects more than 18 native artifacts and workspace effect proposals before saving', async () => {
    const { run, payload } = setup();
    const artifact = payload.artifacts[0];
    payload.artifacts = Array.from({ length: 19 }, (_, index) => ({ ...artifact, key: `depth_${index}`, artifactId: `artifact_${index}` }));
    payload.data.nodes = payload.artifacts.map((item, index) => ({ key: `control_${index}`, nodeType: 'source-video', artifactKey: item.key, data: { label: '深度视频' } }));
    await expect(run()).rejects.toThrow('最多 18 项');
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
    const next = setup();
    mocks.invoke.mockImplementation(async (command: string) => command === 'execute_node_plugin_tool'
      ? { effect: { type: 'settings.get', key: 'prefs' } } : undefined);
    await expect(next.run()).rejects.toThrow('只接受最终节点集结果');
  });
});

describe('visible frame outputs', () => {
  function setup(representation: 'original' | 'lineart', count = 2) {
    const outputPlugin: InstalledPlugin = {
      ...plugin,
      manifest: { ...plugin.manifest, permissions: ['node.read', 'node.write', 'files.connected.read', 'files.output.create'], contributes: {
        nodeTools: [{ id: 'frames', title: '分镜', nodeTypes: ['ai-text'], placements: ['node-context-menu'], inputFields: ['label'],
          output: { mode: 'create-node-set', nodeTypes: ['ai-image', 'ai-shotlist'], maxNodes: 25, fields: ['imageWidth', 'imageHeight', 'frameAnalysis', 'shotlistRows'] } }],
      } },
    };
    mocks.state.installedPlugins = [outputPlugin];
    const frames = Array.from({ length: count }, (_, i) => ({ key: `frame-${i}`, nodeType: 'ai-image', resourceId: `derived-${i}`, representation,
      data: { imageWidth: 9999, imageHeight: 9999, frameAnalysis: { shotId: `shot-${i}`, actualTime: i, content: '人工修改' } } }));
    const payload = { data: { nodes: [...frames, { key: 'sheet', nodeType: 'ai-shotlist', data: {
      shotlistRows: frames.map((frame, i) => ({ id: `shot-${i}`, frameKey: frame.key, content: '人工修改', frameAnalysis: { actualTime: i, reviewStatus: 'reviewed' } })),
    } }], edges: [] } };
    mocks.invoke.mockResolvedValue(payload);
    mocks.readDerivedResource.mockImplementation((_context, resourceId: string, view = 'original') => ({
      resource: { resourceId, origin: 'derived', displayName: 'frame.jpg', mediaType: view === 'lineart' ? 'image/png' : 'image/jpeg', size: 4, access: 'read' },
      bytes: new Uint8Array(view === 'lineart' ? [137, 80, 78, 71] : [255, 216, 255, 224]),
      ...(view === 'lineart' ? { dimensions: { width: 480, height: 720 } } : {}),
    }));
    mocks.saveBinaryToProjectData.mockImplementation(async (_bytes, _projectId, fileName: string) => ({ filePath: `G:\\project\\${fileName}`, assetUrl: `asset://localhost/${fileName}` }));
    vi.stubGlobal('Image', class {
      naturalWidth = 480;
      naturalHeight = 720;
      onload: (() => void) | null = null;
      set src(_value: string) { this.onload?.(); }
    });
    const resources: PluginInvocationResources = { self: [], incoming: [], inputs: {}, package: [], derived: frames.map((frame) => ({
      resourceId: frame.resourceId, origin: 'derived', access: 'read', displayName: 'frame.jpg', mediaType: 'image/jpeg', size: 4,
    })) };
    const guard = registerCanvasDerivation(mocks.state as never, 'node-1')!;
    const run = () => executeNodePluginTool(getAvailableNodePluginTools([outputPlugin], 'ai-text')[0], 'node-1', {}, {
      invocationId: 'visible-output', guard, resources, trustedMediaReferences: new Set(),
    });
    return { run, payload, resources };
  }

  it.each(['original', 'lineart'] as const)('saves 24 actual %s images and binds the same files to shotlist rows', async (view) => {
    const { run, resources } = setup(view, 24);
    await run();
    const extension = view === 'lineart' ? 'png' : 'jpg';
    expect(mocks.saveBinaryToProjectData).toHaveBeenCalledTimes(24);
    const expectedBytes = new Uint8Array(view === 'lineart' ? [137, 80, 78, 71] : [255, 216, 255, 224]);
    for (let i = 0; i < 24; i++) {
      expect(mocks.saveBinaryToProjectData).toHaveBeenNthCalledWith(i + 1, expectedBytes, 'project-1', `video-frame-frame-${i}.${extension}`);
    }
    expect(mocks.addNodesWithEdges).toHaveBeenCalledTimes(1);
    const nodes = mocks.addNodesWithEdges.mock.calls[0][0];
    const rows = nodes[24].data.shotlistRows;
    nodes.slice(0, 24).forEach((node: { id: string; data: Record<string, unknown> }, i: number) => {
      expect(node.data.frameAnalysis).toMatchObject({ shotId: `shot-${i}`, actualTime: i, content: '人工修改' });
      if (view === 'lineart') expect(node.data).toMatchObject({ imageWidth: 480, imageHeight: 720 });
      expect(rows[i]).toMatchObject({ id: `shot-${i}`, content: '人工修改', frameAnalysis: { actualTime: i, reviewStatus: 'reviewed' },
        frame: { nodeId: node.id, kind: 'image', url: node.data.imageUrl, filePath: node.data.filePath } });
    });
    expect(resources.derived.every((r) => r.mediaType === 'image/jpeg')).toBe(true);
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
  });

  it('preflights every selected variant before saving any file', async () => {
    const { run } = setup('lineart');
    const read = mocks.readDerivedResource.getMockImplementation()!;
    mocks.readDerivedResource.mockImplementation((...args) => {
      if (args[1] === 'derived-1') throw new Error('该帧尚未生成线稿');
      return read(...args);
    });
    await expect(run()).rejects.toThrow('尚未生成线稿');
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
  });

  it.each(['save', 'empty-url-first', 'empty-url-second', 'lease', 'commit'] as const)('recycles all written line art on %s failure', async (failure) => {
    const { run } = setup('lineart');
    const save = mocks.saveBinaryToProjectData.getMockImplementation()!;
    let count = 0;
    mocks.saveBinaryToProjectData.mockImplementation(async (...args) => {
      count++;
      if (failure === 'save' && count === 2) throw new Error('写入失败');
      const saved = await save(...args);
      if ((failure === 'empty-url-first' && count === 1) || (failure === 'empty-url-second' && count === 2)) return { ...saved, assetUrl: '' };
      if (failure === 'lease' && count === 2) mocks.readDerivedResource.mockImplementation(() => { throw new Error('插件资源已失效'); });
      return saved;
    });
    if (failure === 'commit') mocks.addNodesWithEdges.mockImplementationOnce(() => { throw new Error('画布写入失败'); });
    await expect(run()).rejects.toThrow();
    const expectedCount = failure === 'save' || failure === 'empty-url-first' ? 1 : 2;
    expect(mocks.moveToTrash).toHaveBeenCalledTimes(expectedCount);
    for (let i = 0; i < expectedCount; i++) expect(mocks.moveToTrash).toHaveBeenCalledWith(`G:\\project\\video-frame-frame-${i}.png`);
    if (failure !== 'commit') expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'non-image', 'oversized-id'] as const)('rejects %s output descriptors before any write', async (invalid) => {
    const { run, payload } = setup('lineart');
    if (invalid === 'unknown') Object.assign(payload.data.nodes[0], { representation: 'other' });
    if (invalid === 'non-image') Object.assign(payload.data.nodes[2], { representation: 'lineart' });
    if (invalid === 'oversized-id') Object.assign(payload.data.nodes[0], { resourceId: 'x'.repeat(161) });
    await expect(run()).rejects.toThrow();
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
  });
});

describe('node plugin tool model effects', () => {
  registerModelEffectTests(mocks);
});

describe('plugin node-set video generation', () => {
  function setup(modelId = 'general/video') {
    const generationPlugin: InstalledPlugin = { ...plugin, manifest: { ...plugin.manifest, apiVersion: 2,
      requiredCapabilities: ['video.nodeSetGeneration'], permissions: ['node.read', 'node.write', 'models.read', 'models.invoke'],
      contributes: { nodeTools: [{ id: 'replicate', title: '视频复刻', placements: ['node-context-menu'],
        nodeTypes: ['source-video'], inputFields: ['label'], dialog: { fields: [{ id: 'videoModel', type: 'model', label: '视频模型', modelCategories: ['video'] }] },
        output: { mode: 'create-node-set', nodeTypes: ['ai-video', 'ai-text', 'ai-image', 'source-video'], maxNodes: 25, fields: ['label', 'prompt', 'model', 'provider', 'workflowId', 'videoUrl'], generateVideos: true } }] },
    } };
    const payload: { data: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } } = { data: {
      nodes: [{ key: 'video', nodeType: 'ai-video', data: { label: '镜头一', prompt: '缓慢推镜，保持人物动作' },
        generation: { modelId, parameters: { duration: 5, aspectRatio: '16:9', resolution: '720p', videoResolution: 832, videoFps: 24, videoFrames: 121, generateAudio: false } } }], edges: [],
    } };
    mocks.buildModelCatalog.mockReturnValue([{ id: modelId, name: '视频模型', provider: modelId.startsWith('comfyui/') ? 'comfyui' : 'general', category: 'video' }]);
    mocks.state = { ...mocks.state, installedPlugins: [generationPlugin], projectLoadStatus: 'ready',
      projects: [{ id: 'project-1', name: '测试项目', createdAt: 1, updatedAt: 1 }], workflows: [{ id: 'local', fileContent: '{}', category: 'ai-video' }],
      config: { generalModels: [], providers: {}, comfyUIUrl: 'http://127.0.0.1:8188' }, videoBatchBusy: false,
      nodes: [{ id: 'node-1', type: 'source-video', position: { x: 0, y: 0 }, data: { type: 'source-video', label: '参考视频' } }] };
    mocks.addNodesWithEdges.mockImplementation((nodes, edges) => {
      mocks.state.nodes = [...mocks.state.nodes as unknown[], ...nodes];
      mocks.state.edges = [...mocks.state.edges as unknown[], ...edges];
      mocks.revision += 1;
      for (const subscriber of mocks.subscribers) subscriber();
    });
    mocks.invoke.mockResolvedValue(payload);
    const run = () => executeNodePluginTool(getAvailableNodePluginTools([generationPlugin], 'source-video')[0], 'node-1');
    return { run, payload, generationPlugin };
  }
  function addFrame(payload: { data: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } }) {
    payload.data.nodes.push({ key: 'frame', nodeType: 'ai-image', resourceId: 'derived-frame', data: { label: '参考帧' } });
    payload.data.edges.push({ sourceKey: 'frame', targetKey: 'video' });
    vi.stubGlobal('Image', class {
      naturalWidth = 1280;
      naturalHeight = 720;
      onload: (() => void) | null = null;
      set src(_value: string) { this.onload?.(); }
    });
  }
  it('rejects generation directives in a materials-only host call before saving references', async () => {
    const { payload, generationPlugin } = setup();
    generationPlugin.manifest.requiredCapabilities!.push('video.replicaPipeline');
    addFrame(payload);
    await expect(executeNodePluginTool(getAvailableNodePluginTools([generationPlugin], 'source-video')[0], 'node-1', {}, undefined, { materialsOnly: true })).rejects.toThrow('后台素材调用不能提交生成');
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
  });
  afterEach(() => {
    mocks.buildModelCatalog.mockReset().mockReturnValue([]);
    mocks.addNodesWithEdges.mockReset();
  });
  it('rewrites host-issued references before preflight and never sends opaque tokens to the video batch', async () => {
    const { run, payload, generationPlugin } = setup();
    generationPlugin.manifest.requiredCapabilities!.push('prompt.mentions');
    generationPlugin.manifest.permissions.push('prompt.references.read');
    const opaque = '@{plugin-ref-12345678-1234-1234-1234-123456789abc:角色}';
    (payload.data.nodes[0].data as Record<string, unknown>).prompt = `替换为 ${opaque}`;
    (mocks.state.nodes as unknown[]).push({ id: 'ref-image', type: 'source-image', data: { type: 'source-image', imageUrl: 'asset://localhost/role.png', label: '角色' } });
    mocks.rewritePromptReferences.mockImplementation(async (text: string) => text.replace(opaque, '@{ref-image:角色}'));
    await run();
    expect(mocks.addNodesWithEdges.mock.calls[0][0][0].data.prompt).toBe('替换为 @{ref-image:角色}');
    expect(mocks.startVideoBatch).toHaveBeenCalledWith('project-1', [expect.objectContaining({ issues: [] })], expect.objectContaining({ assertFresh: expect.any(Function) }));
    expect(mocks.rewritePromptReferences).toHaveBeenCalledWith(expect.stringContaining(opaque), expect.objectContaining({ resources: expect.any(Object) }));
  });
  it('rejects an expired prompt reference before media persistence or batch submission', async () => {
    const { run, payload, generationPlugin } = setup();
    generationPlugin.manifest.requiredCapabilities!.push('prompt.mentions');
    generationPlugin.manifest.permissions.push('prompt.references.read');
    (payload.data.nodes[0].data as Record<string, unknown>).prompt = '@{plugin-ref-12345678-1234-1234-1234-123456789abc:角色}';
    mocks.rewritePromptReferences.mockRejectedValue(new Error('提示词引用已删除、变更或撤销'));
    await expect(run()).rejects.toThrow('引用已删除');
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
  });
  it('places wide shotlists and materials without overlap, with generated videos in a separate right column', async () => {
    const { run, payload, generationPlugin } = setup();
    const output = generationPlugin.manifest.contributes.nodeTools[0].output;
    output.nodeTypes!.push('ai-shotlist', 'ai-markdown');
    addFrame(payload);
    payload.data.nodes.push({ key: 'shots', nodeType: 'ai-shotlist', data: { label: '分镜表' } },
      { key: 'prompts', nodeType: 'ai-markdown', data: { label: '提示词' } },
      { ...payload.data.nodes[0], key: 'video2', data: { label: '镜头二', prompt: '保持运镜' } });
    await run();
    const nodes = mocks.addNodesWithEdges.mock.calls[0][0] as Array<{ position: { x: number; y: number }; data: { type: string; nodeWidth: number; nodeHeight: number } }>;
    const materials = nodes.filter((node) => node.data.type !== 'ai-video');
    const generated = nodes.filter((node) => node.data.type === 'ai-video');
    const right = Math.max(...materials.map((node) => node.position.x + node.data.nodeWidth));
    expect(generated.every((node) => node.position.x >= right + 80)).toBe(true);
    expect(generated[1].position.y).toBeGreaterThanOrEqual(generated[0].position.y + generated[0].data.nodeHeight + 80);
    for (let index = 1; index < materials.length; index++) {
      const left = materials[index - 1];
      const next = materials[index];
      expect(next.position.x).toBeGreaterThanOrEqual(left.position.x + left.data.nodeWidth + 80);
    }
    expect(materials.find((node) => node.data.type === 'ai-shotlist')?.data.nodeWidth).toBe(720);
  });
  it.each(['general/video', 'comfyui/local'])('resolves %s through host identities and submits only new idle video nodes', async (modelId) => {
    const { run } = setup(modelId);
    // Long polling belongs to the host batch, so it cannot block the plugin's submit promise.
    mocks.startVideoBatch.mockReturnValue(new Promise<void>(() => undefined));
    await run();
    const node = mocks.addNodesWithEdges.mock.calls[0][0][0];
    expect(node.data).toMatchObject({ role: 'prompt', status: 'idle', seedanceDuration: 5, seedanceRatio: '16:9', seedanceResolution: '720p', videoResolution: 832, videoFps: 24, videoFrames: 121, generateAudio: false,
      model: modelId.startsWith('comfyui/') ? 'comfyui/workflow' : modelId, provider: modelId.startsWith('comfyui/') ? 'comfyui' : 'general' });
    if (modelId.startsWith('comfyui/')) expect(node.data.workflowId).toBe('local');
    expect(node.data).not.toHaveProperty('videoUrl');
    expect(mocks.startVideoBatch).toHaveBeenCalledWith('project-1', [expect.objectContaining({ nodeId: node.id, issues: [], existing: false })], expect.objectContaining({ assertFresh: expect.any(Function) }));
    expect(mocks.resolveMediaModel).toHaveBeenCalledWith('video', modelId);
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
  });
  it.each([{ duration: 0 }, { duration: 61 }, { duration: '5' }, { videoResolution: 128 }, { videoFrames: 1.5 }, { videoFps: 121 },
    { generateAudio: 'false' }, { aspectRatio: 'arbitrary' }, { resolution: '16K' }, { provider: 'attacker' }, { workflowInputs: {} }, { path: 'D:\\private\\secret.mp4' }])('rejects unsafe video parameters %j before committing', async (parameters) => {
    const { run, payload } = setup();
    (payload.data.nodes[0].generation as Record<string, unknown>).parameters = parameters;
    await expect(run()).rejects.toThrow();
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
  });
  it('captures fingerprints after the Store adds same-batch connection mentions', async () => {
    const { run, payload } = setup();
    addFrame(payload);
    mocks.addNodesWithEdges.mockImplementationOnce((nodes, edges) => {
      const frame = nodes.find((node: { data: { type: string } }) => node.data.type === 'ai-image');
      const video = nodes.find((node: { data: { type: string } }) => node.data.type === 'ai-video');
      video.data.prompt += ` @{${frame.id}:参考帧}`;
      mocks.state.nodes = [...mocks.state.nodes as unknown[], ...nodes];
      mocks.state.edges = [...mocks.state.edges as unknown[], ...edges];
      mocks.revision += 1;
    });
    await run();
    const nodes = mocks.state.nodes as Array<{ id: string; data: { type: string } }>;
    const video = nodes.find((node) => node.data.type === 'ai-video')!;
    const { inspectVideoNode } = await import('../../src/services/videoBatchPlanning');
    expect(mocks.startVideoBatch).toHaveBeenCalledWith('project-1', [inspectVideoNode(video as never, mocks.state as never)], expect.objectContaining({ assertFresh: expect.any(Function) }));
  });
  it('keeps the submitted host batch on its original epoch after its own canvas commit', async () => {
    const { run } = setup();
    mocks.state.projects = [{ id: 'project-1', exchangeEpoch: 0 }];
    await run();
    const lease = mocks.startVideoBatch.mock.calls[0][2] as { assertFresh: () => void };
    expect(() => lease.assertFresh()).not.toThrow();
    mocks.state.projects = [{ id: 'project-1', exchangeEpoch: 1 }];
    expect(() => lease.assertFresh()).toThrow('上下文');
    expect(mocks.startVideoBatch).toHaveBeenCalledOnce();
  });
  it('rejects workflow changes during media persistence and rolls back saved frames', async () => {
    const { run, payload } = setup('comfyui/local');
    addFrame(payload);
    mocks.saveBinaryToProjectData.mockImplementationOnce(async () => {
      (mocks.state.workflows as Array<Record<string, unknown>>)[0].fileContent = '{"changed":true}';
      return { assetUrl: 'asset://localhost/frame.jpg', filePath: 'G:\\project\\frame.jpg' };
    });
    await expect(run()).rejects.toThrow('配置已变化');
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
    expect(mocks.moveToTrash).toHaveBeenCalledWith('G:\\project\\frame.jpg');
  });
  it.each(['missing-permission', 'missing-capability', 'api-one', 'disabled-output', 'wrong-node', 'foreign-identity', 'foreign-reference', 'catalog-removed', 'too-many', 'reference-text'])('rejects %s without starting a batch', async (failure) => {
    const { run, payload, generationPlugin } = setup();
    if (failure === 'missing-permission') generationPlugin.manifest.permissions = ['node.read', 'node.write', 'models.read'];
    if (failure === 'missing-capability') generationPlugin.manifest.requiredCapabilities = [];
    if (failure === 'api-one') generationPlugin.manifest.apiVersion = 1;
    if (failure === 'disabled-output') generationPlugin.manifest.contributes.nodeTools[0].output.generateVideos = false;
    if (failure === 'wrong-node') payload.data.nodes[0].nodeType = 'ai-text';
    if (failure === 'foreign-identity') (payload.data.nodes[0].data as Record<string, unknown>).provider = 'attacker';
    if (failure === 'foreign-reference') (payload.data.nodes[0].data as Record<string, unknown>).prompt = '@{foreign:video}';
    if (failure === 'catalog-removed') mocks.buildModelCatalog.mockReturnValue([]);
    if (failure === 'too-many') payload.data.nodes = Array.from({ length: 7 }, (_, index) => ({ ...payload.data.nodes[0], key: `video${index}` }));
    if (failure === 'reference-text') { payload.data.nodes.push({ key: 'text', nodeType: 'ai-text', data: { prompt: '不应传入的整份分镜' } }); payload.data.edges = [{ sourceKey: 'text', targetKey: 'video' }]; }
    await expect(run()).rejects.toThrow();
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
  });
  it('rechecks a workflow changed during preparation before commit', async () => {
    const { run } = setup('comfyui/local');
    let calls = 0;
    mocks.resolveMediaModel.mockImplementation(() => {
      if (++calls === 2) (mocks.state.workflows as Array<Record<string, unknown>>)[0].fileContent = '{"changed":true}';
      return { configId: 'comfyui/local', requestModel: 'comfyui/workflow', provider: 'comfyui', workflowId: 'local' };
    });
    await expect(run()).rejects.toThrow('配置已变化');
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
  });
  it.each(['project', 'plugin', 'model', 'batch'])('keeps committed nodes when %s prevents initial batch dispatch', async (failure) => {
    const { run } = setup();
    mocks.addNodesWithEdges.mockImplementationOnce((nodes, edges) => {
      mocks.state.nodes = [...mocks.state.nodes as unknown[], ...nodes];
      mocks.state.edges = [...mocks.state.edges as unknown[], ...edges];
      mocks.revision += 1;
      if (failure === 'project') mocks.state.currentProjectId = 'other-project';
      if (failure === 'plugin') mocks.state.installedPlugins = [];
      if (failure === 'model') mocks.buildModelCatalog.mockReturnValue([]);
    });
    if (failure === 'batch') mocks.startVideoBatch.mockRejectedValue(new Error('提交状态未知'));
    await expect(run()).resolves.toBeUndefined();
    await Promise.resolve();
    expect(mocks.addNodesWithEdges).toHaveBeenCalledTimes(1);
    expect(mocks.startVideoBatch).toHaveBeenCalledTimes(failure === 'batch' ? 1 : 0);
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringMatching(/视频节点|视频批次/));
  });
});
