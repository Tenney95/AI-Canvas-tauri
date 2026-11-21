import type { InstalledPlugin } from '../../../src/types/plugin';

export const plugin: InstalledPlugin = {
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

export const customNodePlugin: InstalledPlugin = {
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

export const routingPlugin: InstalledPlugin = {
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

export const mediaNodePlugin: InstalledPlugin = {
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

export const mediaToolPlugin: InstalledPlugin = {
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

export const pythonMediaToolPlugin: InstalledPlugin = {
  ...mediaToolPlugin,
  source: 'define_plugin({"tools": {}})',
  manifest: {
    ...mediaToolPlugin.manifest,
    apiVersion: 1,
    runtime: 'python',
    entry: 'main.py',
  },
};

export const modelCatalog = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', category: 'text' as const, inputModalities: ['text' as const, 'image' as const] },
];

export const modelToolPlugin: InstalledPlugin = {
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
export const modelReadToolPlugin: InstalledPlugin = {
  ...modelToolPlugin,
  id: 'com.example.model-read-tool',
  manifest: {
    ...modelToolPlugin.manifest,
    id: 'com.example.model-read-tool',
    permissions: ['node.read', 'node.write', 'models.read'],
  },
};

export const pythonModelToolPlugin: InstalledPlugin = {
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

export const shotlistToolPlugin: InstalledPlugin = {
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

export const markdownToolPlugin: InstalledPlugin = {
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

export const noteToolPlugin: InstalledPlugin = {
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

export const outputToolPlugin: InstalledPlugin = {
  ...plugin,
  id: 'com.example.output-tool',
  manifest: {
    ...plugin.manifest,
    id: 'com.example.output-tool',
    permissions: ['node.read', 'node.write', 'files.output.create'],
  },
};
