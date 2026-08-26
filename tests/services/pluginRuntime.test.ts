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
      runtime: 'javascript',
      input: expect.objectContaining({ parameters: {} }),
    }));
  });

  it('projects declared node inputs and applies validated output through the Store action', async () => {
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];
    await executeNodePluginTool(tool, 'node-1', { tone: 'brief' });

    expect(mocks.invoke).toHaveBeenCalledWith('execute_node_plugin_tool', expect.objectContaining({
      runtime: 'javascript',
      toolId: 'rewrite',
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
    expect(mocks.updateNodeData).toHaveBeenCalledWith('plugin-node-1', expect.objectContaining({
      pluginOutputs: { result: '模型结果' },
      output: '模型结果',
      status: 'success',
    }));
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
