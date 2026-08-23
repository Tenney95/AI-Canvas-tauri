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

  it('rejects unknown plugin API and unsupported contribution placement', () => {
    expect(() => parsePluginBundle(manifest({ apiVersion: 2 }), 'definePlugin({});'))
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
});
