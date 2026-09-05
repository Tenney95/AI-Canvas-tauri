import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { InstalledPlugin, PluginInvocationResources } from '../../src/types/plugin';

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
  registerDerivedResource: vi.fn(),
  resolveResourceHostUrl: vi.fn(),
  extractVideoFrames: vi.fn(),
  detectShots: vi.fn(),
  inspectFrame: vi.fn(),
  generateText: vi.fn(),
  generateImage: vi.fn(),
  buildModelCatalog: vi.fn(() => [] as Array<Record<string, unknown>>),
  state: {} as Record<string, unknown>,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => mocks.state },
}));
vi.mock('../../src/services/plugins/pluginModelCatalog', () => ({
  buildPluginModelCatalog: mocks.buildModelCatalog,
  collectDeclaredModelCategories: () => ['text'],
}));
vi.mock('../../src/services/ai/generateText', () => ({ generateText: mocks.generateText }));
vi.mock('../../src/services/ai/generateImage', () => ({ generateImage: mocks.generateImage }));
vi.mock('../../src/services/ai/generateVideo', () => ({ generateVideo: vi.fn() }));
vi.mock('../../src/services/ai/generateAudio', () => ({ generateAudio: vi.fn() }));
vi.mock('../../src/services/fileService', () => ({
  saveBinaryToProjectData: mocks.saveBinaryToProjectData,
  moveToTrash: mocks.moveToTrash,
}));
vi.mock('../../src/services/plugins/pluginResourceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/plugins/pluginResourceService')>();
  return {
    ...actual,
    readPluginDerivedResourceForOutput: mocks.readDerivedResource,
    registerPluginDerivedResource: mocks.registerDerivedResource,
    resolvePluginResourceHostUrl: mocks.resolveResourceHostUrl,
  };
});
vi.mock('../../src/services/plugins/pluginVideoFrameService', () => ({
  extractPluginVideoFrames: mocks.extractVideoFrames,
  detectPluginVideoShots: mocks.detectShots,
  inspectPluginVideoFrame: mocks.inspectFrame,
}));

import {
  executeNodePluginTool,
  executePluginUiHostEffect,
  executePluginNode,
  getAvailablePluginNodes,
  getAvailableNodePluginTools,
} from '../../src/services/plugins/pluginRuntime';
import {
  completeCanvasDerivation,
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
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', category: 'text' as const, inputModalities: ['text', 'image'] },
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
  vi.clearAllMocks();
  mocks.revision = 3;
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
  };
  mocks.invoke.mockResolvedValue({ data: { output: 'after' }, message: '完成' });
  mocks.generateText.mockResolvedValue('模型结果');
  mocks.saveBinaryToProjectData.mockReset().mockResolvedValue({
    filePath: 'G:\\project\\plugin-output.txt',
    assetUrl: 'asset://localhost/plugin-output.txt',
  });
  mocks.moveToTrash.mockResolvedValue(undefined);
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

describe('node plugin runtime', () => {
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
        projectId: 'project-1',
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

    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ image_urls: [] }), undefined);
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
      expect(mocks.invoke).toHaveBeenCalledOnce();
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
    ).rejects.toThrow('宿主操作不能超过 4 次');
    expect(mocks.addNode).not.toHaveBeenCalled();
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });
});
