import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LOCALES, setLocale } from '../../src/i18n';
import type { InstalledPlugin, PluginInvocationResources } from '../../src/types/plugin';
import { PLUGIN_HOST } from '../../src/services/plugins/pluginHost';

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

import {
  executeNodePluginTool,
  executePluginUiHostEffect,
  executePluginNode,
  getAvailablePluginNodes,
  getAvailableNodePluginTools,
  parsePluginVideoReplicaEffect,
} from '../../src/services/plugins/pluginRuntime';
import {
  completeCanvasDerivation,
  cancelProjectCanvasDerivations,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
} from '../../src/services/canvasDerivationGuard';

const plugin: InstalledPlugin = {
  id: 'com.example.text',
  enabled: true,
  installedAt: 1,
  updatedAt: 1,
  source: 'definePlugin({ tools: {} });',
  sourceDigest: 'a'.repeat(64),
  revisionDigest: 'b'.repeat(64),
  manifest: {
    apiVersion: 1,
    runtime: 'javascript',
    id: 'com.example.text',
    name: '文本插件',
    version: '1.0.0',
    category: 'content',
    entry: 'main.js',
    permissions: ['node.read', 'node.write'],
    contributes: {
      nodeTools: [{
        id: 'rewrite',
        title: '改写输出',
        placements: ['node-context-menu', 'node-toolbar'],
        icon: 'lucide:pencil',
        dialog: { fields: [] },
        nodeTypes: ['ai-text'],
        inputFields: ['label', 'output'],
        output: { mode: 'update-current', fields: ['output'] },
      }],
    },
  },
};

const customNodePlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.custom-node',
  manifest: {
    ...plugin.manifest,
    apiVersion: 1,
    id: 'com.example.custom-node',
    permissions: ['node.read', 'node.write', 'models.read', 'models.invoke'],
    contributes: {
      nodeTools: [],
      nodes: [{
        id: 'writer',
        title: '写作节点',
        icon: 'lucide:sparkles',
        inputs: [{ id: 'context', label: '上下文', type: 'text' }],
        outputs: [{ id: 'result', label: '结果', type: 'text' }],
        fields: [{ id: 'prompt', label: '提示词', type: 'textarea' }],
      }],
    },
  },
};

const routingPlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.routing',
  manifest: {
    ...plugin.manifest,
    apiVersion: 1,
    id: 'com.example.routing',
    contributes: {
      nodeTools: [],
      nodes: [{
        id: 'source',
        title: '多输出源',
        icon: 'lucide:split',
        inputs: [],
        outputs: [
          { id: 'first', label: '第一项', type: 'text' },
          { id: 'second', label: '第二项', type: 'text' },
          { id: 'image', label: '图片', type: 'image' },
        ],
        fields: [],
      }, {
        id: 'target',
        title: '目标节点',
        icon: 'lucide:target',
        inputs: [{ id: 'context', label: '上下文', type: 'text' }],
        outputs: [{ id: 'result', label: '结果', type: 'text' }],
        fields: [],
      }],
    },
  },
};

const mediaNodePlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.media-node',
  manifest: {
    ...plugin.manifest,
    apiVersion: 1,
    id: 'com.example.media-node',
    permissions: ['node.read', 'node.write', 'models.read', 'models.invoke'],
    contributes: {
      nodeTools: [],
      nodes: [{
        id: 'image-pass',
        title: '图片透传',
        icon: 'lucide:image',
        inputs: [{ id: 'source', label: '来源图片', type: 'image' }],
        outputs: [
          { id: 'image', label: '图片', type: 'image' },
          { id: 'alternate', label: '备用图片', type: 'image' },
        ],
        fields: [],
      }],
    },
  },
};

const mediaToolPlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.media-tool',
  manifest: {
    ...plugin.manifest,
    id: 'com.example.media-tool',
    contributes: {
      nodeTools: [{
        id: 'replace-image',
        title: '替换图片',
        placements: ['node-context-menu'],
        nodeTypes: ['ai-image'],
        inputFields: ['imageUrl'],
        output: { mode: 'update-current', fields: ['imageUrl'] },
      }],
    },
  },
};

const pythonMediaToolPlugin: InstalledPlugin = {
  ...mediaToolPlugin,
  source: 'define_plugin({"tools": {}})',
  manifest: {
    ...mediaToolPlugin.manifest,
    apiVersion: 1,
    runtime: 'python',
    entry: 'main.py',
  },
};

const modelCatalog = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', category: 'text' as const, inputModalities: ['text' as const, 'image' as const] },
];

const modelToolPlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.model-tool',
  manifest: {
    ...plugin.manifest,
    apiVersion: 1,
    id: 'com.example.model-tool',
    permissions: ['node.read', 'node.write', 'models.read', 'models.invoke'],
    contributes: {
      nodeTools: [{
        id: 'summarize',
        title: '模型总结',
        placements: ['node-context-menu', 'node-toolbar'],
        icon: 'lucide:sparkles',
        dialog: {
          fields: [{ id: 'model', label: '模型', type: 'model', modelCategories: ['text'] }],
        },
        nodeTypes: ['ai-text'],
        inputFields: ['label', 'output'],
        output: { mode: 'create-node', nodeType: 'ai-markdown', fields: ['output'] },
      }],
    },
  },
};

/** 只声明 models.read：能拿到目录，但不允许发起模型调用。 */
const modelReadToolPlugin: InstalledPlugin = {
  ...modelToolPlugin,
  id: 'com.example.model-read-tool',
  manifest: {
    ...modelToolPlugin.manifest,
    id: 'com.example.model-read-tool',
    permissions: ['node.read', 'node.write', 'models.read'],
  },
};

const pythonModelToolPlugin: InstalledPlugin = {
  ...modelToolPlugin,
  id: 'com.example.python-model-tool',
  source: 'define_plugin({"tools": {}})',
  manifest: {
    ...modelToolPlugin.manifest,
    apiVersion: 1,
    runtime: 'python',
    entry: 'main.py',
    id: 'com.example.python-model-tool',
  },
};

const shotlistToolPlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.shotlist-tool',
  manifest: {
    ...plugin.manifest,
    id: 'com.example.shotlist-tool',
    contributes: {
      nodeTools: [{
        id: 'rewrite-shotlist',
        title: '整理分镜表',
        placements: ['node-context-menu'],
        nodeTypes: ['ai-shotlist'],
        inputFields: ['shotlistRows'],
        output: { mode: 'update-current', fields: ['shotlistRows'] },
      }],
    },
  },
};

const markdownToolPlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.markdown-tool',
  manifest: {
    ...plugin.manifest,
    id: 'com.example.markdown-tool',
    contributes: {
      nodeTools: [{
        id: 'rewrite-markdown',
        title: '整理 Markdown',
        placements: ['node-context-menu'],
        nodeTypes: ['ai-markdown'],
        inputFields: ['output'],
        output: { mode: 'update-current', fields: ['output'] },
      }],
    },
  },
};

const noteToolPlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.note-tool',
  manifest: {
    ...plugin.manifest,
    id: 'com.example.note-tool',
    contributes: {
      nodeTools: [{
        id: 'restyle-note',
        title: '整理笔记',
        placements: ['node-context-menu'],
        nodeTypes: ['canvas-note'],
        inputFields: ['note'],
        output: { mode: 'update-current', fields: ['note'] },
      }],
    },
  },
};

const outputToolPlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.output-tool',
  manifest: {
    ...plugin.manifest,
    id: 'com.example.output-tool',
    permissions: ['node.read', 'node.write', 'files.output.create'],
  },
};

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

  it.each(['project', 'node', 'revision', 'plugin', 'guard'])('cancels an active native tool after %s changes and releases listeners', async (change) => {
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

describe('node plugin runtime', () => {
  it('preserves native string diagnostics as an Error without writing the node', async () => {
    const diagnostic = '插件工具执行失败（error · 调用）：Error: E2E_ERROR [已隐藏]\n    at main.js:3:17';
    mocks.invoke.mockRejectedValueOnce(diagnostic);
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];
    await expect(executeNodePluginTool(tool, 'node-1')).rejects.toThrow(diagnostic);
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
    expect(mocks.subscribers.size).toBe(0);
  });

  it('shows enabled tools only on their declared node types and placements', () => {
    expect(getAvailableNodePluginTools([plugin], 'ai-text')).toHaveLength(1);
    expect(getAvailableNodePluginTools([plugin], 'ai-text', 'node-toolbar')).toHaveLength(1);
    expect(getAvailableNodePluginTools([plugin], 'ai-image')).toHaveLength(0);
    expect(getAvailableNodePluginTools([{ ...plugin, enabled: false }], 'ai-text')).toHaveLength(0);
  });

  it('uses empty parameters when a context-menu tool executes directly', async () => {
    const tool = getAvailableNodePluginTools([plugin], 'ai-text', 'node-context-menu')[0];
    await executeNodePluginTool(tool, 'node-1');

    expect(mocks.invoke).toHaveBeenCalledWith('execute_node_plugin_tool', expect.objectContaining({
      pluginId: plugin.id,
      sourceDigest: plugin.sourceDigest,
      revisionDigest: plugin.revisionDigest,
      invocationId: expect.any(String),
      input: expect.objectContaining({ parameters: {} }),
    }));
    const invocation = mocks.invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(invocation).not.toHaveProperty('runtime');
    expect(invocation).not.toHaveProperty('source');
  });

  it.each(LOCALES)('passes the effective %s locale to tools without exposing app configuration', async (locale) => {
    setLocale(locale);
    const tool = getAvailableNodePluginTools([plugin], 'ai-text', 'node-context-menu')[0];
    await executeNodePluginTool(tool, 'node-1');
    const input = mocks.invoke.mock.calls[0][1].input;
    expect(input.locale).toBe(locale);
    expect(input).not.toHaveProperty('config');
  });

  it('reuses a custom UI execution lease without revoking it after submit', async () => {
    const tool = getAvailableNodePluginTools([plugin], 'ai-text', 'node-context-menu')[0];
    const guard = registerCanvasDerivation(mocks.state as never, 'node-1');
    expect(guard).not.toBeNull();
    const resources: PluginInvocationResources = {
      self: [],
      incoming: [],
      inputs: {},
      package: [],
      derived: [],
    };
    const trustedMediaReferences = new Set<string>();

    try {
      await executeNodePluginTool(tool, 'node-1', {}, {
        invocationId: 'ui-session-1',
        guard: guard!,
        resources,
        trustedMediaReferences,
      });

      expect(mocks.invoke).toHaveBeenCalledWith('execute_node_plugin_tool', expect.objectContaining({
        invocationId: 'ui-session-1',
        input: expect.objectContaining({ resources }),
      }));
      expect(isCanvasDerivationFresh(guard!, mocks.state as never)).toBe(true);
    } finally {
      completeCanvasDerivation(guard!);
    }
  });

  it('fails before native invocation when the installed plugin has no registered source digest', async () => {
    const incompletePlugin = { ...plugin, sourceDigest: undefined };
    mocks.state = { ...mocks.state, installedPlugins: [incompletePlugin] };
    const tool = getAvailableNodePluginTools([incompletePlugin], 'ai-text')[0];

    await expect(executeNodePluginTool(tool, 'node-1')).rejects.toThrow('源码摘要');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('fails closed when a tool descriptor belongs to an older plugin revision', async () => {
    const staleTool = getAvailableNodePluginTools([plugin], 'ai-text')[0];
    const updatedPlugin = {
      ...plugin,
      source: 'definePlugin({ tools: { rewrite: () => ({ output: "new" }) } });',
      sourceDigest: 'b'.repeat(64),
    };
    mocks.state = { ...mocks.state, installedPlugins: [updatedPlugin] };

    await expect(executeNodePluginTool(staleTool, 'node-1')).rejects.toThrow('插件版本已更新');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('drops a tool result when the plugin updates during native execution', async () => {
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];
    const updatedPlugin = {
      ...plugin,
      source: 'definePlugin({ tools: { rewrite: () => ({ output: "new" }) } });',
      sourceDigest: 'b'.repeat(64),
    };
    mocks.invoke.mockImplementationOnce(async () => {
      mocks.state = { ...mocks.state, installedPlugins: [updatedPlugin] };
      return { data: { output: 'stale' } };
    });

    await expect(executeNodePluginTool(tool, 'node-1')).rejects.toThrow('插件版本已更新');
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('projects declared node inputs and applies validated output through the Store action', async () => {
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];
    await executeNodePluginTool(tool, 'node-1', { tone: 'brief' });

    expect(mocks.invoke).toHaveBeenCalledWith('execute_node_plugin_tool', expect.objectContaining({
      pluginId: plugin.id,
      sourceDigest: plugin.sourceDigest,
      toolId: 'rewrite',
      invocationId: expect.any(String),
      input: {
        host: PLUGIN_HOST,
        projectId: 'project-1',
        locale: 'zh-CN',
        iteration: 0,
        parameters: { tone: 'brief' },
        node: {
          id: 'node-1',
          type: 'ai-text',
          data: { label: '文本', output: 'before' },
        },
        models: [],
        resources: { self: [], incoming: [], inputs: {}, package: [], derived: [] },
        effectResult: undefined,
      },
    }));
    expect(mocks.updateNodeData).toHaveBeenCalledWith('node-1', { output: 'after' });
    expect(mocks.showToast).toHaveBeenCalledWith('完成');
  });

  it.each([
    { name: 'long text', value: '文'.repeat(256_001), error: '字符串不能超过' },
    { name: 'large array', value: Array.from({ length: 257 }, (_, index) => index), error: '数组不能超过' },
    { name: 'large object', value: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, index])), error: '对象不能超过' },
    { name: 'deep JSON', value: Array.from({ length: 9 }).reduce<unknown>((value) => ({ child: value }), '完整内容'), error: '嵌套深度不能超过' },
  ])('rejects $name instead of writing a silently truncated plugin result', async ({ value, error }) => {
    mocks.invoke.mockResolvedValueOnce({ data: { output: value } });
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];

    await expect(executeNodePluginTool(tool, 'node-1')).rejects.toThrow(error);
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
    expect(mocks.addNode).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'text', value: '文'.repeat(256_000) },
    { name: 'array', value: Array.from({ length: 256 }, (_, index) => index) },
    { name: 'object', value: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`field${index}`, index])) },
    { name: 'nested JSON', value: Array.from({ length: 8 }).reduce<unknown>((value) => ({ child: value }), '完整内容') },
  ])('preserves all $name data at the supported boundary', async ({ value }) => {
    mocks.invoke.mockResolvedValueOnce({ data: { output: value } });

    await executeNodePluginTool(getAvailableNodePluginTools([plugin], 'ai-text')[0], 'node-1');

    expect(mocks.updateNodeData).toHaveBeenCalledWith('node-1', { output: value });
  });

  it.each([
    { prompt: '文'.repeat(256_001) },
    Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`parameter${index}`, index])),
  ])('rejects oversized parameters before invoking plugin code', async (parameters) => {
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];

    await expect(executeNodePluginTool(tool, 'node-1', parameters))
      .rejects.toThrow('不能超过');
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it.each([
    { name: '横图', width: 1280, height: 720, expireOnLoad: false },
    { name: '竖图', width: 720, height: 1280, expireOnLoad: false },
    { name: '方图', width: 1024, height: 1024, expireOnLoad: false },
    { name: '读取尺寸时画布过期', width: 720, height: 1280, expireOnLoad: true },
  ])('materializes proportional frames with guarded shotlist bindings ($name)', async ({ width, height, expireOnLoad }) => {
    const loadedImages: string[] = [];
    vi.stubGlobal('Image', class {
      naturalWidth = width;
      naturalHeight = height;
      onload: (() => void) | null = null;
      set src(value: string) {
        loadedImages.push(value);
        // 首张保持横图，验证行高取整行最大值而非只取第一张。
        if (value.endsWith('frame-1.jpg')) {
          this.naturalWidth = 1280;
          this.naturalHeight = 720;
        }
        if (expireOnLoad) mocks.revision += 1;
        this.onload?.();
      }
    });
    const nodeSetPlugin: InstalledPlugin = {
      ...plugin,
      id: 'com.example.frame-review',
      manifest: {
        ...plugin.manifest,
        id: 'com.example.frame-review',
        permissions: ['node.read', 'node.write', 'files.connected.read', 'files.output.create'],
        contributes: {
          nodeTools: [{
            id: 'frame-review',
            title: '逐帧拉片',
            placements: ['node-context-menu'],
            nodeTypes: ['ai-video'],
            inputFields: ['label'],
            output: {
              mode: 'create-node-set',
              nodeTypes: ['ai-image', 'ai-shotlist'],
              maxNodes: 6,
              fields: ['label', 'imageWidth', 'imageHeight', 'frameAnalysis', 'shotlistRows'],
            },
          }],
        },
      },
    };
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'video-1',
        type: 'ai-video',
        position: { x: 10, y: 20 },
        parentId: 'group-1',
        data: { label: '样片', type: 'ai-video', nodeWidth: 320 },
      }],
      installedPlugins: [nodeSetPlugin],
    };
    mocks.invoke.mockResolvedValueOnce({
      data: {
        nodes: [...Array.from({ length: 5 }, (_, index) => ({
          key: `frame-${index + 1}`,
          nodeType: 'ai-image',
          resourceId: `derived-${index + 1}`,
          data: {
            label: `画面 ${index + 1}`,
            // 故意都声明横图；展示比例必须来自保存的实际图像，而不是插件声明。
            imageWidth: 1280,
            imageHeight: 720,
            frameAnalysis: { requestedTime: index + 1, actualTime: index + 0.96, shotSize: '全景' },
          },
        })), {
          key: 'shotlist',
          nodeType: 'ai-shotlist',
          data: {
            label: '样片 · 拉片分镜表',
            shotlistRows: [{ id: 'shot-1', shotNo: '1', frameKey: 'frame-1', content: '建立环境',
              frameAnalysis: { sourceVideoNodeId: 'forged', sourceVideoName: '伪造来源', shotId: 'stable-1', inPoint: 0, outPoint: 2,
                aiOriginal: { content: 'AI 原文', confidence: 0.5 }, overrideFields: ['content'], reviewStatus: 'reviewed' } }],
          },
        }],
        edges: Array.from({ length: 5 }, (_, index) => ({ sourceKey: `frame-${index + 1}`, targetKey: 'shotlist' })),
      },
      message: '已生成拉片节点',
    });
    for (let index = 1; index <= 5; index += 1) {
      mocks.saveBinaryToProjectData.mockResolvedValueOnce({
        filePath: `G:\\project\\frame-${index}.jpg`, assetUrl: `asset://localhost/frame-${index}.jpg`,
      });
    }
    const resources: PluginInvocationResources = {
      self: [],
      incoming: [],
      inputs: {},
      package: [],
      derived: Array.from({ length: 5 }, (_, index) => ({
        resourceId: `derived-${index + 1}`, origin: 'derived', displayName: `frame-${index + 1}.jpg`,
        mediaType: 'image/jpeg', size: 3, access: 'read',
      })),
    };
    const guard = registerCanvasDerivation(mocks.state as never, 'video-1');
    expect(guard).not.toBeNull();

    const execution = executeNodePluginTool(
      getAvailableNodePluginTools([nodeSetPlugin], 'ai-video')[0],
      'video-1',
      {},
      {
        invocationId: 'frame-review-invocation',
        guard: guard!,
        resources,
        trustedMediaReferences: new Set(),
      },
    );

    if (expireOnLoad) {
      await expect(execution).rejects.toThrow('画布已变化，插件结果未写入');
      expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
      expect(mocks.saveBinaryToProjectData).toHaveBeenCalledTimes(1);
      expect(mocks.moveToTrash).toHaveBeenCalledWith('G:\\project\\frame-1.jpg');
      return;
    }
    await execution;
    expect(mocks.addNodesWithEdges).toHaveBeenCalledTimes(1);
    const [createdNodes, createdEdges] = mocks.addNodesWithEdges.mock.calls[0] as [
      Array<{ id: string; type: string; parentId?: string; position: { x: number; y: number }; data: Record<string, unknown> }>,
      Array<{ source: string; target: string }>,
    ];
    const firstFrame = createdNodes.find((node) => node.type === 'ai-image')!;
    const shotlist = createdNodes.find((node) => node.type === 'ai-shotlist')!;
    expect(firstFrame.data).toMatchObject({
      imageUrl: 'asset://localhost/frame-1.jpg',
      nodeWidth: 280,
      nodeHeight: 159,
      frameAnalysis: { sourceVideoNodeId: 'video-1', actualTime: 0.96 },
    });
    expect(loadedImages).toEqual(Array.from({ length: 5 }, (_, index) => `asset://localhost/frame-${index + 1}.jpg`));
    const frameHeight = Math.max(120, Math.round(276 * height / width) + 4);
    expect(createdNodes[1].data).toMatchObject({ nodeWidth: 280, nodeHeight: frameHeight });
    expect(createdNodes.every((node) => node.parentId === 'group-1')).toBe(true);
    expect(createdNodes[0].position).toEqual({ x: 370, y: 20 });
    expect(createdNodes[3].position.y).toBe(20);
    expect(createdNodes[4].position).toEqual({ x: 370, y: 20 + Math.max(280, frameHeight + 80) });
    expect(createdNodes[5].position.y).toBe(createdNodes[4].position.y);
    expect(createdNodes[4].position.y).toBeGreaterThan(createdNodes[1].position.y + frameHeight);
    expect(shotlist.data).toMatchObject({
      shotlistRows: [{
        id: 'shot-1',
        shotNo: '1',
        content: '建立环境',
        frameAnalysis: {
          sourceVideoNodeId: 'video-1', shotId: 'stable-1', inPoint: 0, outPoint: 2,
          aiOriginal: { content: 'AI 原文', confidence: 0.5 }, overrideFields: ['content'], reviewStatus: 'reviewed',
        },
        frame: {
          nodeId: firstFrame.id,
          kind: 'image',
          url: 'asset://localhost/frame-1.jpg',
          filePath: 'G:\\project\\frame-1.jpg',
        },
      }],
    });
    expect(createdEdges).toHaveLength(5);
    expect(createdEdges).toEqual(createdNodes.filter((node) => node.type === 'ai-image').map((node) => ({
      id: expect.any(String),
      source: node.id,
      target: shotlist.id,
      sourceHandle: 'right',
      targetHandle: 'left',
    })));
    expect(JSON.stringify(shotlist.data)).not.toContain('forged');
    expect(JSON.stringify(shotlist.data)).not.toContain('伪造来源');
    expect(mocks.showToast).toHaveBeenCalledWith('已生成拉片节点');
  });

  it('shows the entire shotlist frame without cropping its aspect ratio', () => {
    const styles = readFileSync(new URL('../../src/styles/nodes-shotlist.css', import.meta.url), 'utf8');
    const imageRule = styles.match(/(?:^|\n)\.shot-frame-img\s*\{([^}]*)\}/)?.[1];
    expect(imageRule).toMatch(/object-fit:\s*contain\s*;/);
  });

  it('redacts protected fields and nested local references even from a forged descriptor', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'node-1',
        type: 'ai-text',
        position: { x: 10, y: 20 },
        data: {
          label: '文本',
          type: 'ai-text',
          output: 'before',
          filePath: 'G:\\project\\secret.txt',
          note: {
            label: '保留',
            previewUrl: 'asset://localhost/private.png',
            filePath: 'G:\\project\\nested-secret.txt',
          },
        },
      }],
    };
    const available = getAvailableNodePluginTools([plugin], 'ai-text')[0];
    const forged = {
      ...available,
      tool: { ...available.tool, inputFields: ['filePath', 'note', 'output'] },
    };

    await executeNodePluginTool(forged, 'node-1');

    const nativeInput = mocks.invoke.mock.calls[0][1] as {
      input: { node: { data: Record<string, unknown> } };
    };
    expect(nativeInput.input.node.data).toEqual({
      note: { label: '保留' },
      output: 'before',
    });
  });

  it('drops a result when the canvas revision changes during execution', async () => {
    mocks.invoke.mockImplementation(async () => {
      mocks.revision += 1;
      return { data: { output: 'stale' } };
    });
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];

    await expect(executeNodePluginTool(tool, 'node-1')).rejects.toThrow('画布已变化');
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it('rejects output fields that were not declared by the manifest', async () => {
    mocks.invoke.mockResolvedValue({ data: { prompt: 'not allowed' } });
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];

    await expect(executeNodePluginTool(tool, 'node-1')).rejects.toThrow('未声明字段');
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it('runs a custom node through a host-controlled model effect', async () => {
    setLocale('ja-JP');
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-node-1',
        type: 'plugin-node',
        position: { x: 10, y: 20 },
        data: {
          label: '写作节点',
          type: 'plugin-node',
          pluginId: customNodePlugin.id,
          pluginNodeId: 'writer',
          pluginValues: { prompt: '写一句话' },
        },
      }],
      installedPlugins: [customNodePlugin],
    };
    mocks.invoke
      .mockResolvedValueOnce({
        effect: { type: 'model.generate', modelId: 'general/text-1', prompt: '写一句话' },
      })
      .mockResolvedValueOnce({
        data: { outputs: { result: '模型结果' } },
        message: '生成完成',
      });
    const available = getAvailablePluginNodes([customNodePlugin])[0];

    await executePluginNode(available, 'plugin-node-1', [{
      id: 'general/text-1',
      name: '文本模型',
      provider: 'general',
      category: 'text',
    }]);

    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: 'general/text-1',
      provider: 'general',
      prompt: '写一句话',
    }));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    const firstInvocation = mocks.invoke.mock.calls[0][1] as Record<string, unknown>;
    const secondInvocation = mocks.invoke.mock.calls[1][1] as Record<string, unknown>;
    expect(firstInvocation).toMatchObject({
      pluginId: customNodePlugin.id,
      sourceDigest: customNodePlugin.sourceDigest,
      toolId: 'writer',
      invocationId: expect.any(String),
    });
    expect(secondInvocation.invocationId).toBe(firstInvocation.invocationId);
    expect(firstInvocation).toMatchObject({ input: { locale: 'ja-JP' } });
    expect(secondInvocation).toMatchObject({ input: { locale: 'ja-JP' } });
    expect(firstInvocation).not.toHaveProperty('runtime');
    expect(firstInvocation).not.toHaveProperty('source');
    expect(mocks.updateNodeData).toHaveBeenCalledWith('plugin-node-1', expect.objectContaining({
      pluginOutputs: { result: '模型结果' },
      output: '模型结果',
      status: 'success',
    }));
  });

  it('fails closed when a custom-node descriptor belongs to an older plugin revision', async () => {
    const staleNode = getAvailablePluginNodes([customNodePlugin])[0];
    const updatedPlugin = {
      ...customNodePlugin,
      source: 'definePlugin({ nodes: { writer: () => ({ outputs: { result: "new" } }) } });',
      sourceDigest: 'b'.repeat(64),
    };
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-node-1',
        type: 'plugin-node',
        position: { x: 10, y: 20 },
        data: {
          label: '写作节点',
          type: 'plugin-node',
          pluginId: customNodePlugin.id,
          pluginNodeId: 'writer',
          pluginValues: { prompt: '写一句话' },
        },
      }],
      installedPlugins: [updatedPlugin],
    };

    await expect(executePluginNode(staleNode, 'plugin-node-1', [])).rejects.toThrow('插件版本已更新');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not start a host effect when the plugin updates during native execution', async () => {
    const updatedPlugin = {
      ...customNodePlugin,
      source: 'definePlugin({ nodes: { writer: () => ({ outputs: { result: "new" } }) } });',
      sourceDigest: 'b'.repeat(64),
    };
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-node-1',
        type: 'plugin-node',
        position: { x: 10, y: 20 },
        data: {
          label: '写作节点',
          type: 'plugin-node',
          pluginId: customNodePlugin.id,
          pluginNodeId: 'writer',
          pluginValues: { prompt: '写一句话' },
        },
      }],
      installedPlugins: [customNodePlugin],
    };
    mocks.invoke.mockImplementationOnce(async () => {
      mocks.state = { ...mocks.state, installedPlugins: [updatedPlugin] };
      return { effect: { type: 'model.generate', modelId: 'general/text-1', prompt: '写一句话' } };
    });
    const available = getAvailablePluginNodes([customNodePlugin])[0];

    await expect(executePluginNode(available, 'plugin-node-1', [{
      id: 'general/text-1',
      name: '文本模型',
      provider: 'general',
      category: 'text',
    }])).rejects.toThrow('插件版本已更新');
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it('does not continue a multi-round invocation when the plugin updates during a host effect', async () => {
    const updatedPlugin = {
      ...customNodePlugin,
      source: 'definePlugin({ nodes: { writer: () => ({ outputs: { result: "new" } }) } });',
      sourceDigest: 'b'.repeat(64),
    };
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-node-1',
        type: 'plugin-node',
        position: { x: 10, y: 20 },
        data: {
          label: '写作节点',
          type: 'plugin-node',
          pluginId: customNodePlugin.id,
          pluginNodeId: 'writer',
          pluginValues: { prompt: '写一句话' },
        },
      }],
      installedPlugins: [customNodePlugin],
    };
    mocks.invoke.mockResolvedValueOnce({
      effect: { type: 'model.generate', modelId: 'general/text-1', prompt: '写一句话' },
    });
    mocks.generateText.mockImplementationOnce(async () => {
      mocks.state = { ...mocks.state, installedPlugins: [updatedPlugin] };
      return 'stale model result';
    });
    const available = getAvailablePluginNodes([customNodePlugin])[0];

    await expect(executePluginNode(available, 'plugin-node-1', [{
      id: 'general/text-1',
      name: '文本模型',
      provider: 'general',
      category: 'text',
    }])).rejects.toThrow('插件版本已更新');
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it('routes a plugin-node edge from the exact declared source output', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-source',
        type: 'plugin-node',
        position: { x: 0, y: 0 },
        data: {
          label: '多输出源',
          type: 'plugin-node',
          pluginId: routingPlugin.id,
          pluginNodeId: 'source',
          pluginOutputs: { first: '第一项值', second: '第二项值' },
          output: '第一项值',
        },
      }, {
        id: 'plugin-target',
        type: 'plugin-node',
        position: { x: 400, y: 0 },
        data: {
          label: '目标节点',
          type: 'plugin-node',
          pluginId: routingPlugin.id,
          pluginNodeId: 'target',
          pluginValues: {},
        },
      }],
      installedPlugins: [routingPlugin],
      edges: [{
        id: 'edge-1',
        source: 'plugin-source',
        target: 'plugin-target',
        sourceHandle: 'plugin-out-second',
        targetHandle: 'plugin-in-context',
      }],
    };
    mocks.invoke.mockResolvedValue({ data: { outputs: { result: '完成' } } });
    const available = getAvailablePluginNodes([routingPlugin])
      .find((item) => item.node.id === 'target');

    await executePluginNode(available!, 'plugin-target', []);

    expect(mocks.invoke).toHaveBeenCalledWith('execute_node_plugin_tool', expect.objectContaining({
      input: expect.objectContaining({ inputs: { context: '第二项值' } }),
    }));
  });

  it('does not route a custom-node edge whose target handle is missing', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'text-source',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: '文本来源', type: 'ai-text', output: '不应透传' },
      }, {
        id: 'plugin-target',
        type: 'plugin-node',
        position: { x: 400, y: 0 },
        data: {
          label: '目标节点',
          type: 'plugin-node',
          pluginId: routingPlugin.id,
          pluginNodeId: 'target',
          pluginValues: {},
        },
      }],
      installedPlugins: [routingPlugin],
      edges: [{ id: 'edge-missing-handle', source: 'text-source', target: 'plugin-target' }],
    };
    mocks.invoke.mockResolvedValue({ data: { outputs: { result: '完成' } } });
    const available = getAvailablePluginNodes([routingPlugin])
      .find((item) => item.node.id === 'target');

    await executePluginNode(available!, 'plugin-target', []);

    expect(mocks.invoke).toHaveBeenCalledWith('execute_node_plugin_tool', expect.objectContaining({
      input: expect.objectContaining({ inputs: {} }),
    }));
  });

  it('rejects incompatible declared plugin port types before invoking the plugin', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-source',
        type: 'plugin-node',
        position: { x: 0, y: 0 },
        data: {
          label: '多输出源',
          type: 'plugin-node',
          pluginId: routingPlugin.id,
          pluginNodeId: 'source',
          pluginOutputs: { image: 'data:image/png;base64,iVBORw0KGgo=' },
        },
      }, {
        id: 'plugin-target',
        type: 'plugin-node',
        position: { x: 400, y: 0 },
        data: {
          label: '目标节点',
          type: 'plugin-node',
          pluginId: routingPlugin.id,
          pluginNodeId: 'target',
          pluginValues: {},
        },
      }],
      installedPlugins: [routingPlugin],
      edges: [{
        id: 'edge-1',
        source: 'plugin-source',
        target: 'plugin-target',
        sourceHandle: 'plugin-out-image',
        targetHandle: 'plugin-in-context',
      }],
    };
    const available = getAvailablePluginNodes([routingPlugin])
      .find((item) => item.node.id === 'target');

    await expect(executePluginNode(available!, 'plugin-target', []))
      .rejects.toThrow('端口类型不兼容');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('fails closed when an explicit source plugin port can no longer be resolved', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-source',
        type: 'plugin-node',
        position: { x: 0, y: 0 },
        data: {
          label: '已卸载来源',
          type: 'plugin-node',
          pluginId: 'com.example.missing',
          pluginNodeId: 'source',
          pluginOutputs: { second: '遗留输出' },
        },
      }, {
        id: 'plugin-target',
        type: 'plugin-node',
        position: { x: 400, y: 0 },
        data: {
          label: '目标节点',
          type: 'plugin-node',
          pluginId: routingPlugin.id,
          pluginNodeId: 'target',
          pluginValues: {},
        },
      }],
      installedPlugins: [routingPlugin],
      edges: [{
        id: 'edge-1',
        source: 'plugin-source',
        target: 'plugin-target',
        sourceHandle: 'plugin-out-second',
        targetHandle: 'plugin-in-context',
      }],
    };
    const available = getAvailablePluginNodes([routingPlugin])
      .find((item) => item.node.id === 'target');

    await expect(executePluginNode(available!, 'plugin-target', []))
      .rejects.toThrow('来源插件未安装或已卸载');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('keeps the generic-value fallback for ordinary source nodes', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'text-source',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: '文本来源', type: 'ai-text', output: '旧连线内容' },
      }, {
        id: 'plugin-target',
        type: 'plugin-node',
        position: { x: 400, y: 0 },
        data: {
          label: '目标节点',
          type: 'plugin-node',
          pluginId: routingPlugin.id,
          pluginNodeId: 'target',
          pluginValues: {},
        },
      }],
      installedPlugins: [routingPlugin],
      edges: [{
        id: 'edge-1',
        source: 'text-source',
        target: 'plugin-target',
        targetHandle: 'plugin-in-context',
      }],
    };
    mocks.invoke.mockResolvedValue({ data: { outputs: { result: '完成' } } });
    const available = getAvailablePluginNodes([routingPlugin])
      .find((item) => item.node.id === 'target');

    await executePluginNode(available!, 'plugin-target', []);

    expect(mocks.invoke).toHaveBeenCalledWith('execute_node_plugin_tool', expect.objectContaining({
      input: expect.objectContaining({ inputs: { context: '旧连线内容' } }),
    }));
  });

  it('rejects an untrusted remote URL from every custom media output', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-media',
        type: 'plugin-node',
        position: { x: 10, y: 20 },
        data: {
          label: '图片透传',
          type: 'plugin-node',
          pluginId: mediaNodePlugin.id,
          pluginNodeId: 'image-pass',
          pluginValues: {},
        },
      }],
      installedPlugins: [mediaNodePlugin],
      edges: [],
    };
    mocks.invoke.mockResolvedValue({
      data: {
        outputs: {
          image: 'data:image/png;base64,iVBORw0KGgo=',
          alternate: 'https://attacker.example/collect.png',
        },
      },
    });
    const available = getAvailablePluginNodes([mediaNodePlugin])[0];

    await expect(executePluginNode(available, 'plugin-media', []))
      .rejects.toThrow('未经宿主授权的远程媒体引用');
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it('allows a custom media output to pass through its connected media input unchanged', async () => {
    const sourceUrl = 'https://example.com/input.png';
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'image-source',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: { label: '输入图片', type: 'ai-image', imageUrl: sourceUrl },
      }, {
        id: 'plugin-media',
        type: 'plugin-node',
        position: { x: 400, y: 0 },
        data: {
          label: '图片透传',
          type: 'plugin-node',
          pluginId: mediaNodePlugin.id,
          pluginNodeId: 'image-pass',
          pluginValues: {},
        },
      }],
      installedPlugins: [mediaNodePlugin],
      edges: [{
        id: 'edge-1',
        source: 'image-source',
        target: 'plugin-media',
        sourceHandle: 'right',
        targetHandle: 'plugin-in-source',
      }],
    };
    mocks.invoke.mockResolvedValue({ data: { outputs: { image: sourceUrl } } });
    const available = getAvailablePluginNodes([mediaNodePlugin])[0];

    await executePluginNode(available, 'plugin-media', []);

    expect(mocks.updateNodeData).toHaveBeenCalledWith('plugin-media', expect.objectContaining({
      pluginOutputs: { image: sourceUrl },
      imageUrl: sourceUrl,
    }));
  });

  it('allows a media URL issued by a successful host model effect', async () => {
    const generatedUrl = 'asset://localhost/generated/result.png';
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-media',
        type: 'plugin-node',
        position: { x: 10, y: 20 },
        data: {
          label: '图片透传',
          type: 'plugin-node',
          pluginId: mediaNodePlugin.id,
          pluginNodeId: 'image-pass',
          pluginValues: {},
        },
      }],
      installedPlugins: [mediaNodePlugin],
      edges: [],
    };
    mocks.invoke
      .mockResolvedValueOnce({
        effect: { type: 'model.generate', modelId: 'general/image-1', prompt: '生成图片' },
      })
      .mockResolvedValueOnce({ data: { outputs: { image: generatedUrl } } });
    mocks.generateImage.mockResolvedValueOnce({ url: generatedUrl, width: 1024, height: 1024 });
    const available = getAvailablePluginNodes([mediaNodePlugin])[0];

    await executePluginNode(available, 'plugin-media', [{
      id: 'general/image-1',
      name: '图像模型',
      provider: 'general',
      category: 'image',
    }]);

    expect(mocks.updateNodeData).toHaveBeenCalledWith('plugin-media', expect.objectContaining({
      imageUrl: generatedUrl,
    }));
  });

  it('rejects an untrusted remote media field from a JavaScript node tool', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 10, y: 20 },
        data: { label: '图片', type: 'ai-image' },
      }],
      installedPlugins: [mediaToolPlugin],
    };
    mocks.invoke.mockResolvedValue({ data: { imageUrl: 'https://attacker.example/pixel.png' } });
    const tool = getAvailableNodePluginTools([mediaToolPlugin], 'ai-image')[0];

    await expect(executeNodePluginTool(tool, 'image-node'))
      .rejects.toThrow('未经宿主授权的远程媒体引用');
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it('rejects an untrusted local asset reference from a JavaScript node tool', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 10, y: 20 },
        data: { label: '图片', type: 'ai-image' },
      }],
      installedPlugins: [mediaToolPlugin],
    };
    mocks.invoke.mockResolvedValue({ data: { imageUrl: 'asset://localhost/private.png' } });
    const tool = getAvailableNodePluginTools([mediaToolPlugin], 'ai-image')[0];

    await expect(executeNodePluginTool(tool, 'image-node'))
      .rejects.toThrow('未经宿主授权的本地媒体引用');
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it('allows a JavaScript node tool to pass through an existing media field unchanged', async () => {
    const imageUrl = 'https://example.com/existing.png';
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 10, y: 20 },
        data: { label: '图片', type: 'ai-image', imageUrl },
      }],
      installedPlugins: [mediaToolPlugin],
    };
    mocks.invoke.mockResolvedValue({ data: { imageUrl } });
    const tool = getAvailableNodePluginTools([mediaToolPlugin], 'ai-image')[0];

    await executeNodePluginTool(tool, 'image-node');

    expect(mocks.updateNodeData).toHaveBeenCalledWith('image-node', { imageUrl });
  });

  it('recognizes scheme-relative remote media references', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 10, y: 20 },
        data: { label: '图片', type: 'ai-image' },
      }],
      installedPlugins: [mediaToolPlugin],
    };
    mocks.invoke.mockResolvedValue({ data: { imageUrl: '//attacker.example/pixel.png' } });
    const tool = getAvailableNodePluginTools([mediaToolPlugin], 'ai-image')[0];

    await expect(executeNodePluginTool(tool, 'image-node'))
      .rejects.toThrow('未经宿主授权的远程媒体引用');
  });

  it('rejects executable SVG data URLs from a JavaScript media output', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 10, y: 20 },
        data: { label: '图片', type: 'ai-image' },
      }],
      installedPlugins: [mediaToolPlugin],
    };
    mocks.invoke.mockResolvedValue({
      data: { imageUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
    });
    const tool = getAvailableNodePluginTools([mediaToolPlugin], 'ai-image')[0];

    await expect(executeNodePluginTool(tool, 'image-node'))
      .rejects.toThrow('不允许的内联媒体类型');
  });

  it('keeps trusted Python node-tool media behavior unchanged', async () => {
    const imageUrl = 'https://example.com/python-output.png';
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 10, y: 20 },
        data: { label: '图片', type: 'ai-image' },
      }],
      installedPlugins: [pythonMediaToolPlugin],
    };
    mocks.invoke.mockResolvedValue({ data: { imageUrl } });
    const tool = getAvailableNodePluginTools([pythonMediaToolPlugin], 'ai-image')[0];

    await executeNodePluginTool(tool, 'image-node');

    expect(mocks.updateNodeData).toHaveBeenCalledWith('image-node', { imageUrl });
  });

  it('rejects an untrusted nested shotlist frame URL', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'shotlist-node',
        type: 'ai-shotlist',
        position: { x: 10, y: 20 },
        data: { label: '分镜表', type: 'ai-shotlist', shotlistRows: [] },
      }],
      installedPlugins: [shotlistToolPlugin],
    };
    mocks.invoke.mockResolvedValue({
      data: {
        shotlistRows: [{
          id: 'shot-1',
          shotNo: '1',
          frame: { nodeId: 'missing', kind: 'image', url: 'https://attacker.example/frame.png' },
        }],
      },
    });
    const tool = getAvailableNodePluginTools([shotlistToolPlugin], 'ai-shotlist')[0];

    await expect(executeNodePluginTool(tool, 'shotlist-node'))
      .rejects.toThrow('未经宿主授权的远程媒体引用');
  });

  it('does not treat an ordinary URL in shotlist dialogue as a media reference', async () => {
    const shotlistRows = [{
      id: 'shot-1',
      shotNo: '1',
      dialogue: 'https://docs.example/dialogue',
    }];
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'shotlist-node',
        type: 'ai-shotlist',
        position: { x: 10, y: 20 },
        data: { label: '分镜表', type: 'ai-shotlist', shotlistRows: [] },
      }],
      installedPlugins: [shotlistToolPlugin],
    };
    mocks.invoke.mockResolvedValue({ data: { shotlistRows } });
    const tool = getAvailableNodePluginTools([shotlistToolPlugin], 'ai-shotlist')[0];

    await executeNodePluginTool(tool, 'shotlist-node');

    expect(mocks.updateNodeData).toHaveBeenCalledWith('shotlist-node', { shotlistRows });
  });

  it('rejects a new remote image embedded in Markdown output', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'markdown-node',
        type: 'ai-markdown',
        position: { x: 10, y: 20 },
        data: { label: 'Markdown', type: 'ai-markdown', output: '' },
      }],
      installedPlugins: [markdownToolPlugin],
    };
    mocks.invoke.mockResolvedValue({
      data: { output: '![远程图片](https://attacker.example/pixel.png)' },
    });
    const tool = getAvailableNodePluginTools([markdownToolPlugin], 'ai-markdown')[0];

    await expect(executeNodePluginTool(tool, 'markdown-node'))
      .rejects.toThrow('未经宿主授权的远程媒体引用');
  });

  it('allows an existing Markdown image reference to pass through unchanged', async () => {
    const output = '![已有图片](https://example.com/existing.png)';
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'markdown-node',
        type: 'ai-markdown',
        position: { x: 10, y: 20 },
        data: { label: 'Markdown', type: 'ai-markdown', output },
      }],
      installedPlugins: [markdownToolPlugin],
    };
    mocks.invoke.mockResolvedValue({ data: { output } });
    const tool = getAvailableNodePluginTools([markdownToolPlugin], 'ai-markdown')[0];

    await executeNodePluginTool(tool, 'markdown-node');

    expect(mocks.updateNodeData).toHaveBeenCalledWith('markdown-node', { output });
  });

  it('rejects CSS-escaped URL functions in canvas-note colors', async () => {
    const note = {
      kind: 'rectangle',
      width: 160,
      height: 100,
      style: {
        strokeColor: 'var(--theme-text)',
        backgroundColor: String.raw`u\72l(https://attacker.example/pattern.svg)`,
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 'artist',
        roundness: 'round',
        opacity: 100,
        lineType: 'straight',
        startArrowhead: 'none',
        endArrowhead: 'none',
        pressure: true,
        fontFamily: 'sans',
        fontSize: 16,
        textAlign: 'left',
      },
    };
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'note-node',
        type: 'canvas-note',
        position: { x: 10, y: 20 },
        data: { label: '笔记', type: 'canvas-note' },
      }],
      installedPlugins: [noteToolPlugin],
    };
    mocks.invoke.mockResolvedValue({ data: { note } });
    const tool = getAvailableNodePluginTools([noteToolPlugin], 'canvas-note')[0];

    await expect(executeNodePluginTool(tool, 'note-node'))
      .rejects.toThrow('不允许的画布笔记颜色');
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it('continues to allow ordinary URL text in a text-node output', async () => {
    mocks.invoke.mockResolvedValue({ data: { output: 'https://docs.example/guide' } });
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];

    await executeNodePluginTool(tool, 'node-1');

    expect(mocks.updateNodeData).toHaveBeenCalledWith('node-1', {
      output: 'https://docs.example/guide',
    });
  });

  it('does not accept arbitrary media URLs from plugin model parameters', async () => {
    mocks.state = {
      ...mocks.state,
      nodes: [{
        id: 'plugin-node-1',
        type: 'plugin-node',
        position: { x: 10, y: 20 },
        data: { label: '写作节点', type: 'plugin-node', pluginValues: { prompt: '生成图片' } },
      }],
      installedPlugins: [customNodePlugin],
    };
    mocks.invoke
      .mockResolvedValueOnce({
        effect: {
          type: 'model.generate',
          modelId: 'general/image-1',
          prompt: '生成图片',
          parameters: { imageUrls: ['http://127.0.0.1/private'] },
        },
      })
      .mockResolvedValueOnce({ data: { outputs: { result: 'done' } } });

    await executePluginNode(getAvailablePluginNodes([customNodePlugin])[0], 'plugin-node-1', [{
      id: 'general/image-1',
      name: '图像模型',
      provider: 'general',
      category: 'image',
    }]);

    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ image_urls: [] }), expect.any(AbortSignal));
  });
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
    const payload = { data: { nodes: [{ key: 'control', nodeType: 'source-video', artifactKey: 'depth', data: { label: '深度视频' } }], edges: [] }, artifacts: [artifact] };
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
    const run = () => executeNodePluginTool(tool, 'node-1', {}, { invocationId: 'native-video-invoke', guard, resources }, materialsOnly ? { materialsOnly: true } : undefined)
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

  it('rolls back written materials when an internal host invocation lacks pipeline capability', async () => {
    const { run, workspacePlugin } = setup(true, true);
    workspacePlugin.manifest.requiredCapabilities = ['python.mediaWorkspace', 'python.executionTimeout'];
    await expect(run()).rejects.toThrow('全片任务能力');
    expect(mocks.addNodesWithEdges).not.toHaveBeenCalled();
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
    expect(mocks.moveToTrash).toHaveBeenCalledWith('G:\\project\\plugin-video-depth.mp4');
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
  function uiContext() {
    return {
      pluginId: plugin.id, projectId: 'project-1', nodeId: 'node-1', title: '拉片',
      permissions: ['files.connected.read', 'files.output.create'] as import('../../src/types/plugin').PluginPermission[],
      models: [], trustedMediaReferences: new Set<string>(),
      resources: { self: [{ resourceId: 'self-video', origin: 'node-self', access: 'read', displayName: '视频', mediaType: 'video/mp4', size: 3, source: { nodeId: 'node-1' } }], incoming: [], inputs: {}, package: [], derived: [] } as PluginInvocationResources,
      resourceReadContext: {
        pluginId: plugin.id, sourceDigest: plugin.sourceDigest!, revisionDigest: plugin.revisionDigest!,
        invocationId: 'ui-shots', projectId: 'project-1', nodeId: 'node-1', baseRevision: 3,
        permissions: ['files.connected.read', 'files.output.create'] as const, state: mocks.state as never,
      },
    };
  }

  function lineArtContext() {
    const context = uiContext();
    context.resources.derived.push({ resourceId: 'frame', origin: 'derived', access: 'read', displayName: 'frame.jpg', mediaType: 'image/jpeg', size: 3 });
    return { ...context, effect: { type: 'image.lineArt', resourceId: 'frame' } };
  }
  const replicaStart = {
    type: 'video.replicaJob.start', resourceId: 'self-video', modelId: 'general/video', controls: ['depth'], audioMode: 'original', transcribe: true,
  };
  it('parses a full-video request while preserving manual cuts and explicit speech-download intent', () => {
    const input = { ...replicaStart, cuts: [15, 30, 45], maxSegmentSeconds: 30, downloadSpeech: true };
    expect(parsePluginVideoReplicaEffect(input)).toEqual(input);
    expect(parsePluginVideoReplicaEffect({ type: 'video.replicaJob.status', jobId: 'video-replica-valid' })).toEqual({ type: 'video.replicaJob.status', jobId: 'video-replica-valid' });
  });
  it.each([
    { path: 'D:\\private\\video.mp4' }, { controls: ['depth', 'depth'] }, { controls: ['invalid'] },
    { controls: [['depth']] }, { audioMode: ['original'] }, { resourceId: 1 }, { modelId: '' }, { transcribe: 'true' }, { downloadSpeech: 1 },
    { cuts: [15, 10] }, { cuts: [15, 15] }, { cuts: [NaN] }, { cuts: Array.from({ length: 64 }, (_, index) => index + 1) },
    { maxSegmentSeconds: 31 }, { maxSegmentSeconds: 0 }, { maxSegmentSeconds: Infinity }, { character: '文'.repeat(2001) },
  ])('rejects malformed or undeclared replica request fields %j', (patch) => {
    expect(() => parsePluginVideoReplicaEffect({ ...replicaStart, ...patch })).toThrow();
  });
  it.each(['video.replicaJob.status', 'video.replicaJob.cancel'])('strictly validates %s task IDs and rejects extra identity fields', (type) => {
    for (const payload of [{ type, jobId: '../foreign' }, { type, jobId: 123 }, { type, jobId: 'video-replica-valid', projectId: 'foreign' }]) {
      expect(() => parsePluginVideoReplicaEffect(payload)).toThrow();
    }
  });
  it.each([
    replicaStart,
    { type: 'video.replicaJob.status', jobId: 'video-replica-valid' },
    { type: 'video.replicaJob.cancel', jobId: 'video-replica-valid' },
  ])('rejects ordinary runtime execution of the broker-only %s effect', async (effect) => {
    const result = await executePluginUiHostEffect({ ...uiContext(), effect });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('已绑定的插件界面') });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
  it('resolves selected prompt references on the host and supplies their images to analysis', async () => {
    const context = uiContext();
    const permissions: import('../../src/types/plugin').PluginPermission[] = ['prompt.references.read', 'models.invoke', 'models.read'];
    mocks.resolvePromptReferences.mockResolvedValue({ prompt: '替换角色：演员甲（图片1）', imageUrls: ['data:image/png;base64,YQ=='] });
    const result = await executePluginUiHostEffect({ ...context, permissions,
      resourceReadContext: { ...context.resourceReadContext, permissions },
      models: [{ id: 'gpt-4o', name: '分析模型', provider: 'openai', category: 'text' }],
      effect: { type: 'model.generate', modelId: 'gpt-4o', prompt: '替换角色 @{plugin-ref-12345678-1234-1234-1234-123456789abc:演员甲}' } });
    expect(result.ok).toBe(true);
    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ prompt: '替换角色：演员甲（图片1）', imageUrls: ['data:image/png;base64,YQ=='] }));
    expect(mocks.resolvePromptReferences).toHaveBeenCalledTimes(1);
  });

  it('rejects reference queries without the explicit permission before reaching the catalogue', async () => {
    const result = await executePluginUiHostEffect({ ...uiContext(), effect: { type: 'prompt.mentions', source: 'assets' } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('prompt.references.read') });
    expect(mocks.queryPromptMentions).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])('passes an optional boolean preview flag to the reference catalogue (%s)', async (preview) => {
    const context = uiContext();
    const controller = new AbortController();
    mocks.queryPromptMentions.mockResolvedValue({ items: [], hasMore: false });
    const result = await executePluginUiHostEffect({ ...context, permissions: ['prompt.references.read'], signal: controller.signal,
      effect: { type: 'prompt.mentions', source: 'nodes', query: '演员', offset: 20, ...(preview === undefined ? {} : { preview }) } });
    expect(result).toMatchObject({ ok: true, value: { items: [], hasMore: false } });
    expect(mocks.queryPromptMentions).toHaveBeenCalledWith(expect.objectContaining({
      source: 'nodes', query: '演员', offset: 20, preview, signal: controller.signal,
    }));
  });

  it.each(['true', 1, null, {}, []].map((preview) => ({ preview })))('rejects a non-boolean reference preview flag ($preview)', async ({ preview }) => {
    await expect(executePluginUiHostEffect({ ...uiContext(), permissions: ['prompt.references.read'],
      effect: { type: 'prompt.mentions', source: 'nodes', preview } })).rejects.toThrow('布尔预览');
    expect(mocks.queryPromptMentions).not.toHaveBeenCalled();
  });

  it('rejects plugin-selected preview addresses instead of sending them to the catalogue', async () => {
    await expect(executePluginUiHostEffect({ ...uiContext(), permissions: ['prompt.references.read'],
      effect: { type: 'prompt.mentions', source: 'nodes', preview: true, thumbnailUrl: 'https://untrusted.example/image.png' } })).rejects.toThrow('引用查询');
    expect(mocks.queryPromptMentions).not.toHaveBeenCalled();
  });

  it.each([
    { effect: { type: 'network.request', url: 'https://api.example.com/items' }, permission: 'network.request' },
    { effect: { type: 'settings.get', key: 'preferences' }, permission: 'settings.read' },
    { effect: { type: 'settings.set', key: 'preferences', value: { language: 'zh-CN' } }, permission: 'settings.write' },
    { effect: { type: 'settings.delete', key: 'preferences' }, permission: 'settings.write' },
  ])('denies $effect.type before native execution without $permission', async ({ effect, permission }) => {
    const result = await executePluginUiHostEffect({ ...uiContext(), toolId: 'rewrite', effect });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(permission) });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('passes only registered plugin identity to a guarded network effect', async () => {
    const context = uiContext();
    const effect = { type: 'network.request', url: 'https://api.example.com/items', method: 'POST', body: '{"name":"example"}' };
    mocks.invoke.mockResolvedValueOnce({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    const result = await executePluginUiHostEffect({ ...context, toolId: 'rewrite', permissions: ['network.request'], effect });
    expect(result).toMatchObject({ ok: true, value: { status: 200, body: '{"ok":true}' } });
    expect(mocks.invoke).toHaveBeenCalledWith('execute_plugin_host_effect', {
      identity: { pluginId: plugin.id, sourceDigest: plugin.sourceDigest, revisionDigest: plugin.revisionDigest, toolId: 'rewrite', invocationId: 'ui-shots' },
      requestId: expect.any(String),
      effect: { ...effect, headers: {} },
    });
    expect(context.trustedMediaReferences.size).toBe(0);
  });

  it.each(['cancel', 'revision'] as const)('rejects late network results after %s without retrying the request', async (change) => {
    const controller = new AbortController();
    mocks.invoke.mockImplementationOnce(async () => {
      if (change === 'cancel') controller.abort();
      else mocks.state = { ...mocks.state, installedPlugins: [{ ...plugin, revisionDigest: 'f'.repeat(64) }] };
      return { status: 200, body: 'late' };
    });
    const result = await executePluginUiHostEffect({ ...uiContext(), toolId: 'rewrite', permissions: ['network.request'],
      effect: { type: 'network.request', url: 'https://api.example.com' }, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'execute_plugin_host_effect')).toHaveLength(1);
    if (change === 'cancel') {
      const requestId = mocks.invoke.mock.calls[0][1].requestId;
      expect(mocks.invoke).toHaveBeenCalledWith('cancel_plugin_host_effect', { pluginId: plugin.id, requestId });
    }
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'network.request', url: 'https://api.example.com', headers: { Host: 'other.example.com' } },
    { type: 'network.request', url: 'https://api.example.com', method: 'GET', body: 'unexpected' },
    { type: 'network.request', url: 'https://api.example.com', method: 'POST', body: '文'.repeat(32_000) },
    { type: 'settings.set', key: '../other-plugin', value: true },
    { type: 'resource.createText', content: '文'.repeat(256_001) },
    { type: 'model.generate', modelId: 'gpt-4o', prompt: '文'.repeat(256_001) },
  ])('rejects malformed or oversized effects before native IPC %j', async (effect) => {
    await expect(executePluginUiHostEffect({ ...uiContext(), toolId: 'rewrite', effect })).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('converts an authorized original once and returns only a bounded preview and representation', async () => {
    const context = lineArtContext();
    const first = await executePluginUiHostEffect(context);
    expect(first).toEqual({ type: 'image.lineArt', ok: true, value: {
      resourceId: 'frame', representation: 'lineart', width: 480, height: 720,
      previewDataUrl: 'data:image/png;base64,iVBORw==',
    } });
    expect(mocks.createLineArtImage).toHaveBeenCalledWith({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' }, expect.objectContaining({ assertFresh: expect.any(Function) }));
    const cached = mocks.setLineArtResource.mock.calls[0][2];
    mocks.getLineArtResource.mockReturnValue(cached);
    expect(await executePluginUiHostEffect(context)).toEqual(first);
    expect(mocks.createLineArtImage).toHaveBeenCalledTimes(1);
    expect(mocks.setLineArtResource).toHaveBeenCalledTimes(1);
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it.each([
    { resourceId: '' }, { resourceId: 42 }, { resourceId: 'a'.repeat(161) },
    { resourceId: 'frame', url: 'https://example.com/frame.png' },
    { resourceId: 'frame', bytes: [137, 80, 78, 71] },
  ])('rejects malformed or uploaded line-art input before processing %j', async (extra) => {
    await expect(executePluginUiHostEffect({ ...lineArtContext(), effect: { type: 'image.lineArt', ...extra } })).rejects.toThrow('只接受');
    expect(mocks.createLineArtImage).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'self-video'])('rejects non-derived line-art source %s', async (resourceId) => {
    expect(await executePluginUiHostEffect({ ...lineArtContext(), effect: { type: 'image.lineArt', resourceId } }))
      .toMatchObject({ ok: false, error: expect.stringContaining('当前调用的派生图像') });
    expect(mocks.getLineArtResource).not.toHaveBeenCalled();
    expect(mocks.createLineArtImage).not.toHaveBeenCalled();
  });

  it.each(['files.connected.read', 'files.output.create'] as const)('requires %s for line art', async (missing) => {
    const context = lineArtContext();
    expect(await executePluginUiHostEffect({ ...context, permissions: context.permissions.filter((p) => p !== missing) }))
      .toMatchObject({ ok: false, error: expect.stringContaining('权限') });
    expect(mocks.createLineArtImage).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'project', 'revision', 'plugin', 'lease', 'decode'] as const)('does not cache line art after %s failure', async (failure) => {
    const context = lineArtContext();
    const controller = new AbortController();
    mocks.createLineArtImage.mockImplementationOnce(async () => {
      if (failure === 'cancel') controller.abort();
      if (failure === 'project') mocks.state.currentProjectId = 'other';
      if (failure === 'revision') mocks.revision += 1;
      if (failure === 'plugin') mocks.state.installedPlugins = [{ ...plugin, enabled: false }];
      if (failure === 'lease') mocks.setLineArtResource.mockImplementationOnce(() => { throw new Error('插件资源已失效'); });
      if (failure === 'decode') throw new Error('图片解码失败');
      return { bytes: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png', width: 1, height: 1, previewDataUrl: 'data:image/png;base64,iVBORw==' };
    });
    expect(await executePluginUiHostEffect({ ...context, signal: controller.signal })).toMatchObject({ ok: false });
    if (failure !== 'lease') expect(mocks.setLineArtResource).not.toHaveBeenCalled();
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
  });

  it('routes local shot and frame operations through self resource and rejects stale results', async () => {
    mocks.detectShots.mockResolvedValueOnce({ shots: [{ inPoint: 0, outPoint: 1, score: 0 }], scannedFrames: 25 });
    const result = await executePluginUiHostEffect({ ...uiContext(), effect: { type: 'video.detectShots', resourceId: 'self-video', start: 0, end: 1 } });
    expect(result).toMatchObject({ ok: true, value: { scannedFrames: 25 } });
    expect(mocks.detectShots).toHaveBeenCalledWith(expect.objectContaining({ url: 'asset://localhost/video.mp4' }));
    const invalid = await executePluginUiHostEffect({ ...uiContext(), effect: { type: 'video.inspectFrame', resourceId: 'foreign', time: 0, direction: 0 } });
    expect(invalid).toMatchObject({ ok: false });
    expect(mocks.inspectFrame).not.toHaveBeenCalled();
    mocks.inspectFrame.mockImplementationOnce(async () => { mocks.revision = 4; return { actualTime: 1 }; });
    const stale = await executePluginUiHostEffect({ ...uiContext(), effect: { type: 'video.inspectFrame', resourceId: 'self-video', time: 0, direction: 1 } });
    expect(stale).toMatchObject({ ok: false });
  });

  it('exports derived bytes without paths, and recycles output if the canvas changes while saving', async () => {
    mocks.saveBinaryToProjectData.mockResolvedValueOnce({ filePath: 'G:\\project\\sheet.jpg', assetUrl: 'asset://sheet' });
    const exported = await executePluginUiHostEffect({ ...uiContext(), effect: { type: 'resource.export', resourceId: 'sheet', suggestedName: 'sheet.jpg' } });
    expect(exported).toMatchObject({ ok: true, value: { fileName: 'sheet.jpg', bytes: 3 } });
    expect(JSON.stringify(exported)).not.toContain('G:');
    mocks.saveBinaryToProjectData.mockImplementationOnce(async () => {
      mocks.revision = 4; return { filePath: 'G:\\project\\stale.json', assetUrl: 'asset://stale' };
    });
    const stale = await executePluginUiHostEffect({ ...uiContext(), effect: { type: 'resource.createText', content: '{}', suggestedName: 'stale.json' } });
    expect(stale).toMatchObject({ ok: false });
    expect(mocks.moveToTrash).toHaveBeenCalledWith('G:\\project\\stale.json');
  });

  it('extracts video frames only from the current self resource and registers analysis bytes opaquely', async () => {
    const resources: PluginInvocationResources = {
      self: [{
        resourceId: 'video-self',
        origin: 'node-self',
        displayName: 'video.mp4',
        mediaType: 'video/mp4',
        size: 1024,
        access: 'read',
        source: { nodeId: 'node-1' },
      }],
      incoming: [],
      inputs: {},
      package: [],
      derived: [],
    };
    mocks.extractVideoFrames.mockResolvedValueOnce({
      video: { duration: 5, width: 1920, height: 1080, videoCodec: 'avc1' },
      frames: [{
        key: 'frame-1',
        requestedTime: 1,
        actualTime: 0.96,
        frameDuration: 0.04,
        width: 1280,
        height: 720,
        mediaType: 'image/jpeg',
        previewDataUrl: 'data:image/jpeg;base64,AQ==',
        bytes: new Uint8Array([1, 2, 3]),
      }],
      contactSheet: {
        mediaType: 'image/jpeg',
        width: 360,
        height: 233,
        bytes: new Uint8Array([4, 5, 6]),
      },
    });

    const result = await executePluginUiHostEffect({
      pluginId: plugin.id,
      projectId: 'project-1',
      title: '逐帧拉片',
      permissions: ['files.connected.read', 'files.output.create'],
      nodeId: 'node-1',
      effect: {
        type: 'video.extractFrames',
        resourceId: 'video-self',
        mode: 'analysis',
        samples: [{ key: 'frame-1', time: 1 }],
      },
      models: [],
      trustedMediaReferences: new Set(),
      resources,
      resourceReadContext: {
        pluginId: plugin.id,
        sourceDigest: plugin.sourceDigest!,
        revisionDigest: plugin.revisionDigest!,
        invocationId: 'invoke-frames',
        projectId: 'project-1',
        nodeId: 'node-1',
        baseRevision: 3,
        permissions: ['files.connected.read', 'files.output.create'],
        state: mocks.state as never,
      },
    });

    expect(mocks.extractVideoFrames).toHaveBeenCalledWith(expect.objectContaining({
      url: 'asset://localhost/video.mp4',
      mode: 'analysis',
      samples: [{ key: 'frame-1', time: 1 }],
    }));
    expect(result).toMatchObject({
      type: 'video.extractFrames',
      ok: true,
      value: {
        frames: [{ key: 'frame-1', resourceId: 'derived-1' }],
        contactSheetResourceId: 'derived-2',
      },
    });
    expect(resources.derived).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('1,2,3');
  });

  it('applies JavaScript media-source restrictions to every custom UI effect', async () => {
    await expect(executePluginUiHostEffect({
      pluginId: plugin.id,
      projectId: 'project-1',
      title: '自定义界面',
      permissions: ['models.invoke'],
      nodeId: 'node-1',
      effect: {
        type: 'model.generate',
        modelId: 'image-model',
        prompt: '处理图片',
        imageUrls: ['https://untrusted.example/frame.png'],
      },
      models: [{
        id: 'image-model',
        name: '图像模型',
        provider: 'general',
        category: 'image',
      }],
      trustedMediaReferences: new Set(),
    })).rejects.toThrow('未经宿主授权的远程媒体引用');
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('adds a successful custom UI model result to the current trusted media set', async () => {
    const generatedUrl = 'asset://localhost/generated/ui-result.png';
    const trustedMediaReferences = new Set<string>();
    mocks.generateImage.mockResolvedValueOnce({ url: generatedUrl, width: 1024, height: 1024 });

    const result = await executePluginUiHostEffect({
      resourceReadContext: uiContext().resourceReadContext,
      pluginId: plugin.id,
      projectId: 'project-1',
      title: '自定义界面',
      permissions: ['models.invoke'],
      nodeId: 'node-1',
      effect: {
        type: 'model.generate',
        modelId: 'image-model',
        prompt: '生成图片',
      },
      models: [{
        id: 'image-model',
        name: '图像模型',
        provider: 'general',
        category: 'image',
      }],
      trustedMediaReferences,
    });

    expect(result).toEqual({
      type: 'model.generate',
      ok: true,
      value: { url: generatedUrl },
    });
    expect(trustedMediaReferences).toContain(generatedUrl);
  });

  it('passes media cancellation through and does not trust a model result after revocation', async () => {
    const controller = new AbortController();
    const context = uiContext();
    mocks.generateImage.mockImplementationOnce(async () => {
      controller.abort();
      return { url: 'https://example.com/late.png' };
    });
    const result = await executePluginUiHostEffect({
      ...context, permissions: ['models.invoke'], signal: controller.signal,
      models: [{ id: 'image-model', name: '图像', provider: 'general', category: 'image' }],
      effect: { type: 'model.generate', modelId: 'image-model', prompt: '生成' },
    });
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.anything(), controller.signal);
    expect(result).toMatchObject({ ok: false, error: '插件操作已取消' });
    expect(context.trustedMediaReferences.size).toBe(0);
  });

  it.each(['abort', 'canvas'])('does not run a host effect from a late native tool result after %s', async (reason) => {
    const controller = new AbortController();
    const guard = registerCanvasDerivation(mocks.state as never, 'node-1')!;
    mocks.invoke.mockImplementationOnce(async () => {
      if (reason === 'abort') controller.abort();
      else mocks.revision += 1;
      return { effect: { type: 'model.generate', modelId: 'general/text-1', prompt: '迟到请求' } };
    });
    try {
      await expect(executeNodePluginTool(getAvailableNodePluginTools([plugin], 'ai-text')[0], 'node-1', {}, {
        invocationId: 'cancelled-ui', guard, resources: { self: [], incoming: [], inputs: {}, package: [], derived: [] },
        signal: controller.signal,
      })).rejects.toThrow(reason === 'abort' ? '已取消' : '画布已变化');
      expect(mocks.generateText).not.toHaveBeenCalled();
      expect(mocks.updateNodeData).not.toHaveBeenCalled();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'execute_node_plugin_tool')).toHaveLength(1);
      if (reason === 'abort') expect(mocks.invoke).toHaveBeenCalledWith('cancel_node_plugin_tool', { pluginId: plugin.id, invocationId: 'cancelled-ui' });
    } finally { completeCanvasDerivation(guard); }
  });

  it('exposes the model catalog only to tools declaring models.read', async () => {
    mocks.state = { ...mocks.state, installedPlugins: [modelToolPlugin] };
    await executeNodePluginTool(getAvailableNodePluginTools([modelToolPlugin], 'ai-text')[0], 'node-1');
    const withModels = mocks.invoke.mock.calls[0][1] as { input: { models: unknown[] } };
    expect(withModels.input.models).toEqual(modelCatalog);

    mocks.invoke.mockClear();
    mocks.state = { ...mocks.state, installedPlugins: [plugin] };
    await executeNodePluginTool(getAvailableNodePluginTools([plugin], 'ai-text')[0], 'node-1');
    const withoutModels = mocks.invoke.mock.calls[0][1] as { input: { models: unknown[] } };
    expect(withoutModels.input.models).toEqual([]);
  });

  it('runs a host model effect and hands the result back on the next invocation', async () => {
    mocks.state = { ...mocks.state, installedPlugins: [modelToolPlugin] };
    mocks.invoke
      .mockResolvedValueOnce({ effect: { type: 'model.generate', modelId: 'gpt-4o', prompt: '总结这段文本' } })
      .mockResolvedValueOnce({ data: { output: '# 模型总结' }, message: '完成' });

    await executeNodePluginTool(getAvailableNodePluginTools([modelToolPlugin], 'ai-text')[0], 'node-1');

    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-4o',
      prompt: '总结这段文本',
      imageUrls: [],
    }));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    const second = mocks.invoke.mock.calls[1][1] as {
      input: { iteration: number; effectResult: { ok: boolean; value: unknown } };
    };
    expect(second.input.iteration).toBe(1);
    expect(second.input.effectResult).toEqual({
      type: 'model.generate',
      ok: true,
      value: { text: '模型结果' },
    });
    expect(mocks.addNode).toHaveBeenCalledTimes(1);
  });

  it('aborts a text model request when its plugin UI session is cancelled', async () => {
    const context = uiContext();
    const controller = new AbortController();
    mocks.generateText.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      controller.abort(new Error('用户取消了文本生成'));
      signal?.throwIfAborted();
      return '迟到的回复';
    });

    const result = await executePluginUiHostEffect({
      ...context,
      permissions: ['models.read', 'models.invoke'],
      models: modelCatalog,
      effect: { type: 'model.generate', modelId: 'gpt-4o', prompt: '分析素材' },
      signal: controller.signal,
    });

    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(result).toMatchObject({ type: 'model.generate', ok: false, error: '用户取消了文本生成' });
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
    expect(mocks.addNode).not.toHaveBeenCalled();
  });

  it('creates text only inside the current project and returns no local path', async () => {
    mocks.state = { ...mocks.state, installedPlugins: [outputToolPlugin] };
    mocks.saveBinaryToProjectData.mockResolvedValueOnce({
      filePath: 'G:\\project\\_secret_.md',
      assetUrl: 'asset://localhost/_secret_.md',
    });
    mocks.invoke
      .mockResolvedValueOnce({
        effect: { type: 'resource.createText', content: 'hello', suggestedName: '../secret?.md' },
      })
      .mockResolvedValueOnce({ data: { output: 'done' } });

    await executeNodePluginTool(
      getAvailableNodePluginTools([outputToolPlugin], 'ai-text')[0],
      'node-1',
    );

    expect(mocks.saveBinaryToProjectData).toHaveBeenCalledWith(
      new TextEncoder().encode('hello'),
      'project-1',
      '_secret_.md',
    );
    const second = mocks.invoke.mock.calls[1][1] as { input: { effectResult: unknown } };
    expect(second.input.effectResult).toEqual({
      type: 'resource.createText',
      ok: true,
      value: { fileName: '_secret_.md', bytes: 5 },
    });
    expect(JSON.stringify(second.input.effectResult)).not.toContain('G:\\project');
    expect(JSON.stringify(second.input.effectResult)).not.toContain('asset://');
  });

  it('rejects unauthorized remote image references from a JavaScript node tool', async () => {
    mocks.state = { ...mocks.state, installedPlugins: [modelToolPlugin] };
    mocks.invoke.mockResolvedValueOnce({
      effect: {
        type: 'model.generate',
        modelId: 'gpt-4o',
        prompt: '看图说话',
        imageUrls: ['https://evil.example.com/frame.png'],
      },
    });

    await expect(
      executeNodePluginTool(getAvailableNodePluginTools([modelToolPlugin], 'ai-text')[0], 'node-1'),
    ).rejects.toThrow('未经宿主授权的远程媒体引用');
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('does not constrain image references for trusted Python tools', async () => {
    mocks.state = { ...mocks.state, installedPlugins: [pythonModelToolPlugin] };
    mocks.invoke
      .mockResolvedValueOnce({
        effect: {
          type: 'model.generate',
          modelId: 'gpt-4o',
          prompt: '看图说话',
          imageUrls: ['https://cdn.example.com/frame.png'],
        },
      })
      .mockResolvedValueOnce({ data: { output: 'ok' } });

    await executeNodePluginTool(getAvailableNodePluginTools([pythonModelToolPlugin], 'ai-text')[0], 'node-1');

    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      imageUrls: ['https://cdn.example.com/frame.png'],
    }));
  });

  it('reports a rejected effect back to the tool instead of throwing', async () => {
    mocks.state = { ...mocks.state, installedPlugins: [modelReadToolPlugin] };
    mocks.invoke
      .mockResolvedValueOnce({ effect: { type: 'model.generate', modelId: 'gpt-4o', prompt: '总结' } })
      .mockResolvedValueOnce({ data: { output: '插件降级结果' } });

    await executeNodePluginTool(getAvailableNodePluginTools([modelReadToolPlugin], 'ai-text')[0], 'node-1');

    expect(mocks.generateText).not.toHaveBeenCalled();
    const second = mocks.invoke.mock.calls[1][1] as {
      input: { effectResult: { ok: boolean; error: string } };
    };
    expect(second.input.effectResult.ok).toBe(false);
    expect(second.input.effectResult.error).toContain('models.invoke');
  });

  it('stops a node tool that keeps requesting host effects', async () => {
    mocks.state = { ...mocks.state, installedPlugins: [modelToolPlugin] };
    mocks.invoke.mockResolvedValue({
      effect: { type: 'model.generate', modelId: 'gpt-4o', prompt: '再来一次' },
    });

    await expect(
      executeNodePluginTool(getAvailableNodePluginTools([modelToolPlugin], 'ai-text')[0], 'node-1'),
    ).rejects.toThrow('model 操作不能超过 4 次');
    expect(mocks.addNode).not.toHaveBeenCalled();
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });
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
    mocks.state = { ...mocks.state, installedPlugins: [generationPlugin], projects: [], workflows: [{ id: 'local', fileContent: '{}', category: 'ai-video' }],
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
  it('rejects generation directives in a materials-only host call and recycles saved references', async () => {
    const { payload, generationPlugin } = setup();
    generationPlugin.manifest.requiredCapabilities!.push('video.replicaPipeline');
    addFrame(payload);
    await expect(executeNodePluginTool(getAvailableNodePluginTools([generationPlugin], 'source-video')[0], 'node-1', {}, undefined, { materialsOnly: true })).rejects.toThrow('后台素材调用不能提交生成');
    expect(mocks.saveBinaryToProjectData).toHaveBeenCalledTimes(1);
    expect(mocks.moveToTrash).toHaveBeenCalledWith('G:\\project\\plugin-output.txt');
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
    expect(mocks.startVideoBatch).toHaveBeenCalledWith('project-1', [expect.objectContaining({ issues: [] })]);
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
    expect(mocks.startVideoBatch).toHaveBeenCalledWith('project-1', [expect.objectContaining({ nodeId: node.id, issues: [], existing: false })]);
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
    expect(mocks.startVideoBatch).toHaveBeenCalledWith('project-1', [inspectVideoNode(video as never, mocks.state as never)]);
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
