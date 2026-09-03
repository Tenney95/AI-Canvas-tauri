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

  it('limits custom UI to a node-tool modal in Plugin API v1', () => {
    const toolUiManifest = JSON.parse(manifest()) as {
      permissions: string[];
      ui?: Record<string, unknown>;
      contributes: { nodeTools: Array<{ dialog: { ui?: string } }> };
    };
    toolUiManifest.permissions.push('ui.custom');
    toolUiManifest.ui = {
      entry: 'ui.js',
      integrity: `sha256-${'a'.repeat(64)}`,
      exports: { toolDialog: 'ToolDialog' },
    };
    toolUiManifest.contributes.nodeTools[0].dialog.ui = 'toolDialog';

    const parsed = parsePluginBundle(
      JSON.stringify(toolUiManifest),
      'definePlugin({ tools: {} });',
    );
    expect(parsed.contributes.nodeTools[0].dialog?.ui).toBe('toolDialog');

    const unusedUiManifest = structuredClone(toolUiManifest);
    delete unusedUiManifest.contributes.nodeTools[0].dialog.ui;
    expect(() => parsePluginBundle(
      JSON.stringify(unusedUiManifest),
      'definePlugin({ tools: {} });',
    )).toThrow('必须被至少一个节点工具 dialog.ui 引用');

    const nodeUiManifest = JSON.parse(manifest({
      contributes: {
        nodeTools: [],
        nodes: [{
          id: 'custom-panel',
          title: '自定义面板',
          icon: 'lucide:box',
          inputs: [],
          outputs: [],
          fields: [],
          ui: 'toolDialog',
        }],
      },
    }));
    expect(() => parsePluginBundle(
      JSON.stringify(nodeUiManifest),
      'definePlugin({ tools: {} });',
    )).toThrow('自定义 UI 仅用于节点工具 dialog.ui');
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

  it('accepts JavaScript and trusted Python through the v1 contract with matching entries', () => {
    const parsed = parsePluginBundle(manifest({
      runtime: 'python',
      entry: 'main.py',
    }), 'define_plugin({"tools": {}})');

    expect(parsed.apiVersion).toBe(1);
    expect(parsed.runtime).toBe('python');
    expect(parsed.entry).toBe('main.py');

    expect(() => parsePluginBundle(manifest({
      apiVersion: 0,
      runtime: 'python',
      entry: 'main.py',
    }), 'define_plugin({"tools": {}})')).toThrow('apiVersion: 1');
    expect(() => parsePluginBundle(manifest({
      runtime: 'python',
      entry: 'main.js',
    }), 'define_plugin({"tools": {}})')).toThrow('必须与 runtime 匹配');
  });

  it('rejects unknown plugin API and unsupported contribution placement', () => {
    expect(() => parsePluginBundle(manifest({ apiVersion: 0 }), 'definePlugin({});'))
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

  it('accepts v1 custom nodes with model and connected-resource inputs', () => {
    const parsed = parsePluginBundle(manifest({
      permissions: ['node.read', 'node.write', 'models.read', 'models.invoke', 'files.connected.read'],
      contributes: {
        nodeTools: [],
        nodes: [{
          id: 'story-card',
          title: '故事卡片',
          icon: 'lucide:sparkles',
          inputs: [
            { id: 'context', label: '上下文', type: 'text', multiple: true },
            { id: 'source', label: '资料', type: 'resource', accept: ['text/*'] },
          ],
          outputs: [{ id: 'result', label: '结果', type: 'text' }],
          fields: [
            { id: 'prompt', label: '提示词', type: 'textarea', required: true },
            { id: 'model', label: '模型', type: 'model', modelCategories: ['text'] },
          ],
          resourceAccess: { incoming: true, portIds: ['source'] },
        }],
      },
    }), 'definePlugin({ tools: { "story-card": () => ({ data: { outputs: { result: "ok" } } }) } });');

    expect(parsed.apiVersion).toBe(1);
    expect(parsed.contributes.nodeTools).toEqual([]);
    expect(parsed.contributes.nodes?.[0]).toMatchObject({
      id: 'story-card',
      inputs: [
        { id: 'context', type: 'text', multiple: true },
        { id: 'source', type: 'resource', accept: ['text/*'] },
      ],
      outputs: [{ id: 'result', type: 'text' }],
      fields: [
        expect.objectContaining({ id: 'prompt', type: 'textarea' }),
        expect.objectContaining({ id: 'model', modelCategories: ['text'] }),
      ],
      resourceAccess: { incoming: true, portIds: ['source'] },
    });
  });

  it('requires declared capabilities for custom-node model and resource inputs', () => {
    const contributes = {
      nodeTools: [],
      nodes: [{
        id: 'unsafe-node',
        title: '未授权节点',
        icon: 'lucide:box',
        inputs: [{ id: 'source', label: '文件', type: 'resource' }],
        outputs: [],
        fields: [
          { id: 'model', label: '模型', type: 'model' },
        ],
        resourceAccess: { incoming: true, portIds: ['source'] },
      }],
    };
    expect(() => parsePluginBundle(manifest({
      permissions: ['node.read', 'node.write', 'files.connected.read'],
      contributes,
    }), 'definePlugin({});')).toThrow('models.read');

    expect(() => parsePluginBundle(manifest({
      permissions: ['node.read', 'node.write', 'models.read'],
      contributes,
    }), 'definePlugin({});')).toThrow('files.connected.read');
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

  it('accepts model fields in node tool dialogs and gates them on models.read', () => {
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
      permissions: ['node.read', 'node.write', 'models.read', 'models.invoke'],
      contributes: { nodeTools: [modelTool] },
    }), 'definePlugin({});');

    expect(parsed.contributes.nodeTools[0].dialog?.fields[0]).toMatchObject({
      id: 'model',
      type: 'model',
      modelCategories: ['text'],
    });

    expect(() => parsePluginBundle(manifest({
      permissions: ['node.read', 'node.write'],
      contributes: { nodeTools: [modelTool] },
    }), 'definePlugin({});')).toThrow('models.read');

    expect(() => parsePluginBundle(manifest({
      apiVersion: 0,
      permissions: ['node.read', 'node.write', 'models.read'],
      contributes: { nodeTools: [modelTool] },
    }), 'definePlugin({});')).toThrow('apiVersion: 1');
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
      permissions: ['node.read', 'node.write', 'models.read'],
      contributes: {
        nodeTools: [{
          ...baseTool,
          dialog: { fields: [{ id: 'model', label: '模型', type: 'model', modelCategories: ['embedding'] }] },
        }],
      },
    }), 'definePlugin({});')).toThrow('不支持的模型分类');
  });

  it('accepts v1 resource scopes through opaque resource permissions', () => {
    const parsed = parsePluginBundle(manifest({
      apiVersion: 1,
      permissions: [
        'node.read',
        'node.write',
        'files.connected.read',
        'plugin.resources.read',
      ],
      resources: [{
        id: 'prompt-template',
        path: 'resources/prompt.json',
        integrity: `sha256-${'a'.repeat(64)}`,
        mediaType: 'application/json',
        bytes: 128,
      }],
      contributes: {
        nodeTools: [],
        nodes: [{
          id: 'resource-reader',
          title: '资源读取器',
          icon: 'lucide:file-input',
          inputs: [{
            id: 'media',
            label: '媒体',
            type: 'resource',
            accept: ['image/*', 'audio/wav'],
            maxBytes: 10_000_000,
          }],
          outputs: [{ id: 'result', label: '结果', type: 'text' }],
          fields: [],
          resourceAccess: { self: true, incoming: true, portIds: ['media'] },
        }],
      },
    }), 'definePlugin({ tools: {} });');

    expect(parsed.apiVersion).toBe(1);
    expect(parsed.resources?.[0]).toMatchObject({
      id: 'prompt-template',
      path: 'resources/prompt.json',
      mediaType: 'application/json',
      bytes: 128,
    });
    expect(parsed.contributes.nodes?.[0]).toMatchObject({
      resourceAccess: { self: true, incoming: true, portIds: ['media'] },
      inputs: [{ type: 'resource', accept: ['image/*', 'audio/wav'], maxBytes: 10_000_000 }],
    });
    expect(parsed.permissions).toContain('files.connected.read');
    expect(parsed.permissions).not.toContain('files.read');
  });

  it('supports both JavaScript and trusted Python runtimes in API v1', () => {
    const javascript = parsePluginBundle(manifest({ apiVersion: 1 }), 'definePlugin({ tools: {} });');
    const python = parsePluginBundle(manifest({
      apiVersion: 1,
      runtime: 'python',
      entry: 'main.py',
    }), 'define_plugin({"tools": {}})');

    expect(javascript.runtime).toBe('javascript');
    expect(python.runtime).toBe('python');
    expect(() => parsePluginBundle(manifest({
      apiVersion: 1,
      runtime: 'python',
      entry: 'main.js',
    }), 'define_plugin({"tools": {}})')).toThrow('必须与 runtime 匹配');
  });

  it('fails closed for undeclared, unsupported, or unsafe resource access', () => {
    const tool = {
      id: 'read-resource',
      title: '读取资源',
      placements: ['node-context-menu'],
      nodeTypes: ['ai-image'],
      inputFields: ['output'],
      resourceAccess: { self: true, incoming: true },
      output: { mode: 'update-current', fields: ['output'] },
    };

    expect(() => parsePluginBundle(manifest({
      apiVersion: 1,
      permissions: ['node.read', 'node.write'],
      contributes: { nodeTools: [tool] },
    }), 'definePlugin({});')).toThrow('files.connected.read');

    expect(() => parsePluginBundle(manifest({
      apiVersion: 0,
      permissions: ['node.read', 'node.write', 'files.connected.read'],
      contributes: { nodeTools: [tool] },
    }), 'definePlugin({});')).toThrow('apiVersion: 1');

    expect(() => parsePluginBundle(manifest({
      apiVersion: 1,
      permissions: ['node.write', 'plugin.resources.read'],
      resources: [{
        id: 'escape',
        path: '../secret.txt',
        integrity: 'a'.repeat(64),
        mediaType: 'text/plain',
        bytes: 5,
      }],
      contributes: { nodeTools: [] },
    }), 'definePlugin({});')).toThrow('安全的包内相对路径');
  });

  it('rejects resource port filters that do not reference a declared input', () => {
    expect(() => parsePluginBundle(manifest({
      apiVersion: 1,
      permissions: ['node.read', 'node.write', 'files.connected.read'],
      contributes: {
        nodeTools: [],
        nodes: [{
          id: 'resource-reader',
          title: '资源读取器',
          icon: 'lucide:file-input',
          inputs: [{ id: 'media', label: '媒体', type: 'resource' }],
          outputs: [],
          fields: [],
          resourceAccess: { incoming: true, portIds: ['missing'] },
        }],
      },
    }), 'definePlugin({});')).toThrow('未声明的输入端口');
  });
});
