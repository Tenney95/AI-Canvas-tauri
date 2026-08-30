import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../../src/types/plugin';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  revision: 3,
  updateNodeData: vi.fn(),
  addNode: vi.fn(),
  showToast: vi.fn(),
  generateText: vi.fn(),
  generateImage: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => mocks.state },
}));
vi.mock('../../src/services/ai/generateText', () => ({ generateText: mocks.generateText }));
vi.mock('../../src/services/ai/generateImage', () => ({ generateImage: mocks.generateImage }));
vi.mock('../../src/services/ai/generateVideo', () => ({ generateVideo: vi.fn() }));
vi.mock('../../src/services/ai/generateAudio', () => ({ generateAudio: vi.fn() }));
vi.mock('../../src/services/plugins/pluginFileGrantService', () => ({ readPluginGrantedTextFile: vi.fn() }));
vi.mock('../../src/services/fileService', () => ({ saveAgentTextOutput: vi.fn() }));

import {
  executeNodePluginTool,
  executePluginNode,
  getAvailablePluginNodes,
  getAvailableNodePluginTools,
} from '../../src/services/plugins/pluginRuntime';

const plugin: InstalledPlugin = {
  id: 'com.example.text',
  enabled: true,
  installedAt: 1,
  updatedAt: 1,
  source: 'definePlugin({ tools: {} });',
  sourceDigest: 'a'.repeat(64),
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
    apiVersion: 2,
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
    apiVersion: 2,
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
    apiVersion: 2,
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
    apiVersion: 3,
    runtime: 'python',
    entry: 'main.py',
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
    showToast: mocks.showToast,
  };
  mocks.invoke.mockResolvedValue({ data: { output: 'after' }, message: '完成' });
  mocks.generateText.mockResolvedValue('模型结果');
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
      invocationId: expect.any(String),
      input: expect.objectContaining({ parameters: {} }),
    }));
    const invocation = mocks.invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(invocation).not.toHaveProperty('runtime');
    expect(invocation).not.toHaveProperty('source');
  });

  it('fails before native invocation when the installed plugin has no registered source digest', async () => {
    const legacyPlugin = { ...plugin, sourceDigest: undefined };
    mocks.state = { ...mocks.state, installedPlugins: [legacyPlugin] };
    const tool = getAvailableNodePluginTools([legacyPlugin], 'ai-text')[0];

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
        parameters: { tone: 'brief' },
        node: {
          id: 'node-1',
          type: 'ai-text',
          data: { label: '文本', output: 'before' },
        },
      },
    }));
    expect(mocks.updateNodeData).toHaveBeenCalledWith('node-1', { output: 'after' });
    expect(mocks.showToast).toHaveBeenCalledWith('完成');
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

  it('keeps the legacy generic-value fallback for ordinary source nodes', async () => {
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
    const generatedUrl = 'https://example.com/result.png';
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

    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ image_urls: [] }));
  });
});
