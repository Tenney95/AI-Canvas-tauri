import { describe, expect, it } from 'vitest';
import {
  createInstalledPlugin,
  parsePluginBundle,
} from '../../src/services/plugins/pluginManifest';

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    apiVersion: 1,
    id: 'com.example.text-tools',
    name: '文本工具',
    version: '1.0.0',
    author: 'Example',
    description: '处理文本节点内容',
    category: 'content',
    keywords: ['文本'],
    entry: 'main.js',
    permissions: ['node.read', 'node.write'],
    contributes: {
      nodeTools: [{
        id: 'uppercase',
        title: '转大写',
        placements: ['node-context-menu', 'node-toolbar'],
        icon: 'lucide:case-upper',
        dialog: {
          title: '转大写',
          submitLabel: '转换',
          fields: [{
            id: 'prefix',
            label: '前缀',
            type: 'text',
            defaultValue: '结果：',
          }],
        },
        nodeTypes: ['ai-text', 'source-text'],
        inputFields: ['output'],
        output: { mode: 'update-current', fields: ['output'] },
      }],
    },
    ...overrides,
  });
}

describe('AI Canvas Plugin Manifest Standard v1', () => {
  it('describes what a plugin does and where its tools appear', () => {
    const parsed = parsePluginBundle(manifest(), 'definePlugin({ tools: {} });');

    expect(parsed.runtime).toBe('javascript');
    expect(parsed.entry).toBe('main.js');
    expect(parsed.category).toBe('content');
    expect(parsed.permissions).toEqual(['node.read', 'node.write']);
    expect(parsed.contributes.nodeTools[0]).toMatchObject({
      id: 'uppercase',
      placements: ['node-context-menu', 'node-toolbar'],
      icon: 'lucide:case-upper',
      dialog: expect.objectContaining({
        title: '转大写',
        fields: [expect.objectContaining({ id: 'prefix', type: 'text' })],
      }),
      nodeTypes: ['ai-text', 'source-text'],
      inputFields: ['output'],
      output: { mode: 'update-current', fields: ['output'] },
    });
  });

  it('normalizes GitHub publishing metadata', () => {
    const parsed = parsePluginBundle(manifest({
      repository: 'https://github.com/example/text-tools.git',
      homepage: 'https://example.com/plugins/text-tools',
      license: 'MIT',
    }), 'definePlugin({ tools: {} });');

    expect(parsed.repository).toBe('https://github.com/example/text-tools');
    expect(parsed.homepage).toBe('https://example.com/plugins/text-tools');
    expect(parsed.license).toBe('MIT');
    expect(() => parsePluginBundle(manifest({
      repository: 'https://example.com/example/text-tools',
    }), 'definePlugin({});')).toThrow('github.com');
  });

  it('requires a safe Iconify icon for node toolbar tools', () => {
    const toolbarTool = {
      id: 'toolbar-action',
      title: '工具栏操作',
      placements: ['node-toolbar'],
      nodeTypes: ['ai-text'],
      inputFields: ['output'],
      output: { mode: 'update-current', fields: ['output'] },
    };

    expect(() => parsePluginBundle(manifest({
      contributes: { nodeTools: [toolbarTool] },
    }), 'definePlugin({});')).toThrow('必须配置 icon');

    expect(() => parsePluginBundle(manifest({
      contributes: { nodeTools: [{ ...toolbarTool, icon: 'https://example.com/icon.svg' }] },
    }), 'definePlugin({});')).toThrow('Iconify');

    expect(() => parsePluginBundle(manifest({
      contributes: { nodeTools: [{ ...toolbarTool, icon: 'lucide:wand-sparkles' }] },
    }), 'definePlugin({});')).toThrow('必须配置 dialog');

    const parsed = parsePluginBundle(manifest({
      contributes: { nodeTools: [{
        ...toolbarTool,
        icon: 'lucide:wand-sparkles',
        dialog: { fields: [] },
      }] },
    }), 'definePlugin({});');
    expect(parsed.contributes.nodeTools[0].icon).toBe('lucide:wand-sparkles');
  });

  it('validates declarative dialog fields and select options', () => {
    expect(() => parsePluginBundle(manifest({
      contributes: {
        nodeTools: [{
          id: 'dialog-action',
          title: '弹窗操作',
          placements: ['node-toolbar'],
          icon: 'lucide:sliders-horizontal',
          dialog: {
            fields: [{
              id: 'mode',
              label: '模式',
              type: 'select',
              options: [{ label: '快速', value: 'fast' }],
              defaultValue: 'missing',
            }],
          },
          nodeTypes: ['ai-text'],
          inputFields: ['output'],
          output: { mode: 'update-current', fields: ['output'] },
        }],
      },
    }), 'definePlugin({});')).toThrow('defaultValue 不在选项中');
  });

  it('accepts trusted Python plugins only through API v3 and main.py', () => {
    const parsed = parsePluginBundle(manifest({
      apiVersion: 3,
      runtime: 'python',
      entry: 'main.py',
    }), 'define_plugin({"tools": {}})');

    expect(parsed.apiVersion).toBe(3);
    expect(parsed.runtime).toBe('python');
    expect(parsed.entry).toBe('main.py');

    expect(() => parsePluginBundle(manifest({
      apiVersion: 2,
      runtime: 'python',
      entry: 'main.py',
    }), 'define_plugin({"tools": {}})')).toThrow('apiVersion: 3');
    expect(() => parsePluginBundle(manifest({
      apiVersion: 3,
      runtime: 'python',
      entry: 'main.js',
    }), 'define_plugin({"tools": {}})')).toThrow('main.py');
  });

  it('rejects unknown plugin API and unsupported contribution placement', () => {
    expect(() => parsePluginBundle(manifest({ apiVersion: 4 }), 'definePlugin({});'))
      .toThrow('apiVersion');
    expect(() => parsePluginBundle(manifest({
      contributes: {
        nodeTools: [{
          id: 'panel',
          title: '面板',
          placements: ['main-window'],
          nodeTypes: ['ai-text'],
          inputFields: ['output'],
          output: { mode: 'update-current', fields: ['output'] },
        }],
      },
    }), 'definePlugin({});')).toThrow('入口位置');
  });

  it('accepts API v2 custom nodes with model and granted-file fields', () => {
    const parsed = parsePluginBundle(manifest({
      apiVersion: 2,
      permissions: ['node.read', 'node.write', 'models.read', 'models.invoke', 'files.read', 'files.write'],
      contributes: {
        nodeTools: [],
        nodes: [{
          id: 'story-card',
          title: '故事卡片',
          icon: 'lucide:sparkles',
          inputs: [{ id: 'context', label: '上下文', type: 'text', multiple: true }],
          outputs: [{ id: 'result', label: '结果', type: 'text' }],
          fields: [
            { id: 'prompt', label: '提示词', type: 'textarea', required: true },
            { id: 'model', label: '模型', type: 'model', modelCategories: ['text'] },
            { id: 'source', label: '资料', type: 'file' },
          ],
        }],
      },
    }), 'definePlugin({ tools: { "story-card": () => ({ data: { outputs: { result: "ok" } } }) } });');

    expect(parsed.apiVersion).toBe(2);
    expect(parsed.contributes.nodeTools).toEqual([]);
    expect(parsed.contributes.nodes?.[0]).toMatchObject({
      id: 'story-card',
      inputs: [{ id: 'context', type: 'text', multiple: true }],
      outputs: [{ id: 'result', type: 'text' }],
      fields: [
        expect.objectContaining({ id: 'prompt', type: 'textarea' }),
        expect.objectContaining({ id: 'model', modelCategories: ['text'] }),
        expect.objectContaining({ id: 'source', type: 'file' }),
      ],
    });
  });

  it('requires declared capabilities for custom-node model and file fields', () => {
    const contributes = {
      nodeTools: [],
      nodes: [{
        id: 'unsafe-node',
        title: '未授权节点',
        icon: 'lucide:box',
        inputs: [],
        outputs: [],
        fields: [
          { id: 'model', label: '模型', type: 'model' },
          { id: 'file', label: '文件', type: 'file' },
        ],
      }],
    };
    expect(() => parsePluginBundle(manifest({
      apiVersion: 2,
      permissions: ['node.write'],
      contributes,
    }), 'definePlugin({});')).toThrow('models.read');
  });

  it('rejects local path exposure and protected output fields', () => {
    expect(() => parsePluginBundle(manifest({
      contributes: {
        nodeTools: [{
          id: 'read-path',
          title: '读取路径',
          placements: ['node-context-menu'],
          nodeTypes: ['ai-image'],
          inputFields: ['filePath'],
          output: { mode: 'update-current', fields: ['output'] },
        }],
      },
    }), 'definePlugin({});')).toThrow('本地字段');

    expect(() => parsePluginBundle(manifest({
      contributes: {
        nodeTools: [{
          id: 'change-type',
          title: '修改类型',
          placements: ['node-context-menu'],
          nodeTypes: ['ai-text'],
          inputFields: ['output'],
          output: { mode: 'update-current', fields: ['type'] },
        }],
      },
    }), 'definePlugin({});')).toThrow('受保护');
  });

  it('preserves enable state and install time when updating a plugin', () => {
    const parsed = parsePluginBundle(manifest(), 'definePlugin({ tools: {} });');
    const first = createInstalledPlugin(parsed, 'first');
    const updated = createInstalledPlugin(
      { ...parsed, version: '1.1.0' },
      'second',
      { ...first, enabled: false },
    );

    expect(updated.enabled).toBe(false);
    expect(updated.installedAt).toBe(first.installedAt);
    expect(updated.source).toBe('second');
  });

  it('accepts model fields in node tool dialogs from API v2 and gates them on models.read', () => {
    const modelTool = {
      id: 'summarize',
      title: '模型总结',
      placements: ['node-toolbar'],
      icon: 'lucide:sparkles',
      dialog: {
        fields: [{ id: 'model', label: '模型', type: 'model', modelCategories: ['text'] }],
      },
      nodeTypes: ['ai-text'],
      inputFields: ['output'],
      output: { mode: 'create-node', nodeType: 'ai-markdown', fields: ['output'] },
    };
    const parsed = parsePluginBundle(manifest({
      apiVersion: 2,
      permissions: ['node.read', 'node.write', 'models.read', 'models.invoke'],
      contributes: { nodeTools: [modelTool] },
    }), 'definePlugin({});');

    expect(parsed.contributes.nodeTools[0].dialog?.fields[0]).toMatchObject({
      id: 'model',
      type: 'model',
      modelCategories: ['text'],
    });

    expect(() => parsePluginBundle(manifest({
      apiVersion: 2,
      permissions: ['node.read', 'node.write'],
      contributes: { nodeTools: [modelTool] },
    }), 'definePlugin({});')).toThrow('models.read');

    expect(() => parsePluginBundle(manifest({
      apiVersion: 1,
      permissions: ['node.read', 'node.write', 'models.read'],
      contributes: { nodeTools: [modelTool] },
    }), 'definePlugin({});')).toThrow('apiVersion: 2 或 3');
  });

  it('rejects model categories on non-model dialog fields and unknown categories', () => {
    const baseTool = {
      id: 'summarize',
      title: '模型总结',
      placements: ['node-toolbar'],
      icon: 'lucide:sparkles',
      nodeTypes: ['ai-text'],
      inputFields: ['output'],
      output: { mode: 'update-current', fields: ['output'] },
    };

    expect(() => parsePluginBundle(manifest({
      apiVersion: 2,
      permissions: ['node.read', 'node.write', 'models.read'],
      contributes: {
        nodeTools: [{
          ...baseTool,
          dialog: {
            fields: [{
              id: 'mode',
              label: '模式',
              type: 'select',
              options: [{ label: '快速', value: 'fast' }],
              modelCategories: ['text'],
            }],
          },
        }],
      },
    }), 'definePlugin({});')).toThrow('只有 model 字段可以配置 modelCategories');

    expect(() => parsePluginBundle(manifest({
      apiVersion: 2,
      permissions: ['node.read', 'node.write', 'models.read'],
      contributes: {
        nodeTools: [{
          ...baseTool,
          dialog: { fields: [{ id: 'model', label: '模型', type: 'model', modelCategories: ['embedding'] }] },
        }],
      },
    }), 'definePlugin({});')).toThrow('不支持的模型分类');
  });
});
