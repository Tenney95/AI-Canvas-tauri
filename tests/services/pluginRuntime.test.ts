import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../../src/types/plugin';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  revision: 3,
  updateNodeData: vi.fn(),
  addNode: vi.fn(),
  showToast: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => mocks.state },
}));

import {
  executeNodePluginTool,
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
    getCurrentRevision: () => mocks.revision,
    updateNodeData: mocks.updateNodeData,
    addNode: mocks.addNode,
    showToast: mocks.showToast,
  };
  mocks.invoke.mockResolvedValue({ data: { output: 'after' }, message: '完成' });
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
      input: expect.objectContaining({ parameters: {} }),
    }));
  });

  it('projects declared node inputs and applies validated output through the Store action', async () => {
    const tool = getAvailableNodePluginTools([plugin], 'ai-text')[0];
    await executeNodePluginTool(tool, 'node-1', { tone: 'brief' });

    expect(mocks.invoke).toHaveBeenCalledWith('execute_node_plugin_tool', expect.objectContaining({
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
});
