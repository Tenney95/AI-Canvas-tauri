import {
  plugin,
  customNodePlugin,
  routingPlugin,
  mediaNodePlugin,
  mediaToolPlugin,
  pythonMediaToolPlugin,
  shotlistToolPlugin,
  markdownToolPlugin,
  noteToolPlugin,
} from './pluginFixtures';
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { LOCALES, setLocale } from '../../../src/i18n';
import type { InstalledPlugin, PluginInvocationResources } from '../../../src/types/plugin';
import { PLUGIN_HOST } from '../../../src/services/plugins/pluginHost';
import {
  executeNodePluginTool,
  executePluginNode,
  getAvailablePluginNodes,
  getAvailableNodePluginTools,
} from '../../../src/services/plugins/pluginRuntime';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../../src/services/canvasDerivationGuard';
import type { PluginRuntimeMocks } from '../pluginRuntime.test';

export function registerNodeExecutionTests(mocks: PluginRuntimeMocks) {
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
              video: { nodeId: 'forged-video', kind: 'video', assetId: 'forged-video-asset', filePath: 'C:/forged-video.mp4' },
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
    expect((shotlist.data.shotlistRows as Array<Record<string, unknown>>)[0]).not.toHaveProperty('video');
    expect(JSON.stringify(shotlist.data)).not.toContain('伪造来源');
    expect(mocks.showToast).toHaveBeenCalledWith('已生成拉片节点');
  });

  it('shows the entire shotlist frame without cropping its aspect ratio', () => {
    const styles = readFileSync(new URL('../../../src/styles/nodes-shotlist.css', import.meta.url), 'utf8');
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

  it.each(['frame', 'video'] as const)('rejects an untrusted nested shotlist %s URL', async (binding) => {
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
          [binding]: { nodeId: 'missing', kind: binding === 'video' ? 'video' : 'image', url: 'https://attacker.example/media' },
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

  it('插件改写分镜只保留宿主已有成片身份，不能用已授权 URL 伪造其他节点绑定', async () => {
    const video = { nodeId: 'real-video', kind: 'video', url: 'https://example.com/final.mp4', assetId: 'real-asset' };
    mocks.state = { ...mocks.state, nodes: [{ id: 'shotlist-node', type: 'ai-shotlist', position: { x: 0, y: 0 },
      data: { label: '分镜表', type: 'ai-shotlist', shotlistRows: [{ id: 'shot-1', shotNo: '1', video }] },
    }], installedPlugins: [shotlistToolPlugin] };
    const forged = { ...video, nodeId: 'forged-video', assetId: 'forged-asset' };
    mocks.invoke.mockResolvedValue({ data: { shotlistRows: [
      { id: 'shot-1', shotNo: '1', content: '修改文本', video: forged },
      { id: 'shot-2', shotNo: '2', video: forged },
    ] } });

    await executeNodePluginTool(getAvailableNodePluginTools([shotlistToolPlugin], 'ai-shotlist')[0], 'shotlist-node');

    expect(mocks.updateNodeData).toHaveBeenCalledWith('shotlist-node', { shotlistRows: [
      { id: 'shot-1', shotNo: '1', content: '修改文本', video },
      { id: 'shot-2', shotNo: '2' },
    ] });
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
}
