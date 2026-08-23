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
        placements: ['node-context-menu'],
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
      placements: ['node-context-menu'],
      nodeTypes: ['ai-text', 'source-text'],
      inputFields: ['output'],
      output: { mode: 'update-current', fields: ['output'] },
    });
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
