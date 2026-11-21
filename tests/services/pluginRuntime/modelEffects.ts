import {
  plugin,
  modelCatalog,
  modelToolPlugin,
  modelReadToolPlugin,
  pythonModelToolPlugin,
  outputToolPlugin,
} from './pluginFixtures';
import { expect, it } from 'vitest';
import type { PluginInvocationResources } from '../../../src/types/plugin';
import {
  executeNodePluginTool,
  executePluginUiHostEffect,
  getAvailableNodePluginTools,
  parsePluginVideoReplicaEffect,
} from '../../../src/services/plugins/pluginRuntime';
import { completeCanvasDerivation, registerCanvasDerivation } from '../../../src/services/canvasDerivationGuard';
import type { PluginRuntimeMocks } from '../pluginRuntime.test';

export function registerModelEffectTests(mocks: PluginRuntimeMocks) {
  function uiContext() {
    return {
      pluginId: plugin.id, projectId: 'project-1', nodeId: 'node-1', title: '拉片',
      permissions: ['files.connected.read', 'files.output.create'] as import('../../../src/types/plugin').PluginPermission[],
      models: [], trustedMediaReferences: new Set<string>(),
      resources: { self: [{ resourceId: 'self-video', origin: 'node-self', access: 'read', displayName: '视频', mediaType: 'video/mp4', size: 3, source: { nodeId: 'node-1' } }], incoming: [], inputs: {}, package: [], derived: [] } as PluginInvocationResources,
      resourceReadContext: {
        pluginId: plugin.id, sourceDigest: plugin.sourceDigest!, revisionDigest: plugin.revisionDigest!,
        invocationId: 'ui-shots', projectId: 'project-1', nodeId: 'node-1', baseRevision: 3,
        permissions: ['files.connected.read', 'files.output.create'] as const, state: mocks.state as never,
      },
    };
  }

  function lineArtContext() {
    const context = uiContext();
    context.resources.derived.push({ resourceId: 'frame', origin: 'derived', access: 'read', displayName: 'frame.jpg', mediaType: 'image/jpeg', size: 3 });
    return { ...context, effect: { type: 'image.lineArt', resourceId: 'frame' } };
  }
  const replicaStart = {
    type: 'video.replicaJob.start', resourceId: 'self-video', modelId: 'general/video', controls: ['depth'], audioMode: 'original', transcribe: true,
  };
  it('parses a full-video request while preserving manual cuts and explicit speech-download intent', () => {
    const input = { ...replicaStart, cuts: [15, 30, 45], maxSegmentSeconds: 30, downloadSpeech: true };
    expect(parsePluginVideoReplicaEffect(input)).toEqual(input);
    expect(parsePluginVideoReplicaEffect({ type: 'video.replicaJob.status', jobId: 'video-replica-valid' })).toEqual({ type: 'video.replicaJob.status', jobId: 'video-replica-valid' });
  });
  it.each([
    { path: 'D:\\private\\video.mp4' }, { controls: ['depth', 'depth'] }, { controls: ['invalid'] },
    { controls: [['depth']] }, { audioMode: ['original'] }, { resourceId: 1 }, { modelId: '' }, { transcribe: 'true' }, { downloadSpeech: 1 },
    { cuts: [15, 10] }, { cuts: [15, 15] }, { cuts: [NaN] }, { cuts: Array.from({ length: 64 }, (_, index) => index + 1) },
    { maxSegmentSeconds: 31 }, { maxSegmentSeconds: 0 }, { maxSegmentSeconds: Infinity }, { character: '文'.repeat(2001) },
  ])('rejects malformed or undeclared replica request fields %j', (patch) => {
    expect(() => parsePluginVideoReplicaEffect({ ...replicaStart, ...patch })).toThrow();
  });
  it.each(['video.replicaJob.status', 'video.replicaJob.cancel', 'video.replicaJob.restart'])('strictly validates %s task IDs and rejects extra identity fields', (type) => {
    for (const payload of [{ type, jobId: '../foreign' }, { type, jobId: 123 }, { type, jobId: 'video-replica-valid', projectId: 'foreign' }]) {
      expect(() => parsePluginVideoReplicaEffect(payload)).toThrow();
    }
  });
  it.each([
    replicaStart,
    { type: 'video.replicaJob.status', jobId: 'video-replica-valid' },
    { type: 'video.replicaJob.cancel', jobId: 'video-replica-valid' },
    { type: 'video.replicaJob.restart', jobId: 'video-replica-valid' },
  ])('rejects ordinary runtime execution of the broker-only %s effect', async (effect) => {
    const result = await executePluginUiHostEffect({ ...uiContext(), effect });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('已绑定的插件界面') });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.startVideoBatch).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
  it('resolves selected prompt references on the host and supplies their images to analysis', async () => {
    const context = uiContext();
    const permissions: import('../../../src/types/plugin').PluginPermission[] = ['prompt.references.read', 'models.invoke', 'models.read'];
    mocks.resolvePromptReferences.mockResolvedValue({ prompt: '替换角色：演员甲（图片1）', imageUrls: ['data:image/png;base64,YQ=='] });
    const result = await executePluginUiHostEffect({ ...context, permissions,
      resourceReadContext: { ...context.resourceReadContext, permissions },
      models: [{ id: 'gpt-4o', name: '分析模型', provider: 'openai', category: 'text' }],
      effect: { type: 'model.generate', modelId: 'gpt-4o', prompt: '替换角色 @{plugin-ref-12345678-1234-1234-1234-123456789abc:演员甲}' } });
    expect(result.ok).toBe(true);
    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ prompt: '替换角色：演员甲（图片1）', imageUrls: ['data:image/png;base64,YQ=='] }));
    expect(mocks.resolvePromptReferences).toHaveBeenCalledTimes(1);
  });

  it('keeps authorized target-character images before the source contact sheet in one analysis call', async () => {
    const context = uiContext();
    const permissions: import('../../../src/types/plugin').PluginPermission[] = ['prompt.references.read', 'models.invoke', 'models.read'];
    const targetImage = 'asset://localhost/target-character.png';
    const contactSheet = 'asset://localhost/source-contact-sheet.jpg';
    context.resources.derived.push({ resourceId: 'contact-sheet', origin: 'derived', access: 'read',
      displayName: 'contact-sheet.jpg', mediaType: 'image/jpeg', size: 3 });
    mocks.resolveResourceHostUrl.mockResolvedValueOnce(contactSheet);

    const result = await executePluginUiHostEffect({ ...context, permissions,
      resourceReadContext: { ...context.resourceReadContext, permissions },
      trustedMediaReferences: new Set([targetImage]),
      models: [{ id: 'gpt-4o', name: '分析模型', provider: 'openai', category: 'text' }],
      effect: { type: 'model.generate', modelId: 'gpt-4o', prompt: '前图提供目标角色外观，末图提供原片动作与构图。',
        imageUrls: [targetImage], resourceIds: ['contact-sheet'] } });

    expect(result.ok).toBe(true);
    expect(mocks.resolveResourceHostUrl).toHaveBeenCalledWith(expect.objectContaining({ invocationId: 'ui-shots' }), 'contact-sheet');
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: [targetImage, contactSheet] }));
  });

  it('rejects reference queries without the explicit permission before reaching the catalogue', async () => {
    const result = await executePluginUiHostEffect({ ...uiContext(), effect: { type: 'prompt.mentions', source: 'assets' } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('prompt.references.read') });
    expect(mocks.queryPromptMentions).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])('passes an optional boolean preview flag to the reference catalogue (%s)', async (preview) => {
    const context = uiContext();
    const controller = new AbortController();
    mocks.queryPromptMentions.mockResolvedValue({ items: [], hasMore: false });
    const result = await executePluginUiHostEffect({ ...context, permissions: ['prompt.references.read'], signal: controller.signal,
      effect: { type: 'prompt.mentions', source: 'nodes', query: '演员', offset: 20, ...(preview === undefined ? {} : { preview }) } });
    expect(result).toMatchObject({ ok: true, value: { items: [], hasMore: false } });
    expect(mocks.queryPromptMentions).toHaveBeenCalledWith(expect.objectContaining({
      source: 'nodes', query: '演员', offset: 20, preview, signal: controller.signal,
    }));
  });

  it.each(['true', 1, null, {}, []].map((preview) => ({ preview })))('rejects a non-boolean reference preview flag ($preview)', async ({ preview }) => {
    await expect(executePluginUiHostEffect({ ...uiContext(), permissions: ['prompt.references.read'],
      effect: { type: 'prompt.mentions', source: 'nodes', preview } })).rejects.toThrow('布尔预览');
    expect(mocks.queryPromptMentions).not.toHaveBeenCalled();
  });

  it('rejects plugin-selected preview addresses instead of sending them to the catalogue', async () => {
    await expect(executePluginUiHostEffect({ ...uiContext(), permissions: ['prompt.references.read'],
      effect: { type: 'prompt.mentions', source: 'nodes', preview: true, thumbnailUrl: 'https://untrusted.example/image.png' } })).rejects.toThrow('引用查询');
    expect(mocks.queryPromptMentions).not.toHaveBeenCalled();
  });

  it.each([
    { effect: { type: 'network.request', url: 'https://api.example.com/items' }, permission: 'network.request' },
    { effect: { type: 'settings.get', key: 'preferences' }, permission: 'settings.read' },
    { effect: { type: 'settings.set', key: 'preferences', value: { language: 'zh-CN' } }, permission: 'settings.write' },
    { effect: { type: 'settings.delete', key: 'preferences' }, permission: 'settings.write' },
  ])('denies $effect.type before native execution without $permission', async ({ effect, permission }) => {
    const result = await executePluginUiHostEffect({ ...uiContext(), toolId: 'rewrite', effect });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(permission) });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('passes only registered plugin identity to a guarded network effect', async () => {
    const context = uiContext();
    const effect = { type: 'network.request', url: 'https://api.example.com/items', method: 'POST', body: '{"name":"example"}' };
    mocks.invoke.mockResolvedValueOnce({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    const result = await executePluginUiHostEffect({ ...context, toolId: 'rewrite', permissions: ['network.request'], effect });
    expect(result).toMatchObject({ ok: true, value: { status: 200, body: '{"ok":true}' } });
    expect(mocks.invoke).toHaveBeenCalledWith('execute_plugin_host_effect', {
      identity: { pluginId: plugin.id, sourceDigest: plugin.sourceDigest, revisionDigest: plugin.revisionDigest, toolId: 'rewrite', invocationId: 'ui-shots' },
      requestId: expect.any(String),
      effect: { ...effect, headers: {} },
    });
    expect(context.trustedMediaReferences.size).toBe(0);
  });

  it.each(['cancel', 'revision'] as const)('rejects late network results after %s without retrying the request', async (change) => {
    const controller = new AbortController();
    mocks.invoke.mockImplementationOnce(async () => {
      if (change === 'cancel') controller.abort();
      else mocks.state = { ...mocks.state, installedPlugins: [{ ...plugin, revisionDigest: 'f'.repeat(64) }] };
      return { status: 200, body: 'late' };
    });
    const result = await executePluginUiHostEffect({ ...uiContext(), toolId: 'rewrite', permissions: ['network.request'],
      effect: { type: 'network.request', url: 'https://api.example.com' }, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'execute_plugin_host_effect')).toHaveLength(1);
    if (change === 'cancel') {
      const requestId = mocks.invoke.mock.calls[0][1].requestId;
      expect(mocks.invoke).toHaveBeenCalledWith('cancel_plugin_host_effect', { pluginId: plugin.id, requestId });
    }
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'network.request', url: 'https://api.example.com', headers: { Host: 'other.example.com' } },
    { type: 'network.request', url: 'https://api.example.com', method: 'GET', body: 'unexpected' },
    { type: 'network.request', url: 'https://api.example.com', method: 'POST', body: '文'.repeat(32_000) },
    { type: 'settings.set', key: '../other-plugin', value: true },
    { type: 'resource.createText', content: '文'.repeat(256_001) },
    { type: 'model.generate', modelId: 'gpt-4o', prompt: '文'.repeat(256_001) },
  ])('rejects malformed or oversized effects before native IPC %j', async (effect) => {
    await expect(executePluginUiHostEffect({ ...uiContext(), toolId: 'rewrite', effect })).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('converts an authorized original once and returns only a bounded preview and representation', async () => {
    const context = lineArtContext();
    const first = await executePluginUiHostEffect(context);
    expect(first).toEqual({ type: 'image.lineArt', ok: true, value: {
      resourceId: 'frame', representation: 'lineart', width: 480, height: 720,
      previewDataUrl: 'data:image/png;base64,iVBORw==',
    } });
    expect(mocks.createLineArtImage).toHaveBeenCalledWith({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' }, expect.objectContaining({ assertFresh: expect.any(Function) }));
    const cached = mocks.setLineArtResource.mock.calls[0][2];
    mocks.getLineArtResource.mockReturnValue(cached);
    expect(await executePluginUiHostEffect(context)).toEqual(first);
    expect(mocks.createLineArtImage).toHaveBeenCalledTimes(1);
    expect(mocks.setLineArtResource).toHaveBeenCalledTimes(1);
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it.each([
    { resourceId: '' }, { resourceId: 42 }, { resourceId: 'a'.repeat(161) },
    { resourceId: 'frame', url: 'https://example.com/frame.png' },
    { resourceId: 'frame', bytes: [137, 80, 78, 71] },
  ])('rejects malformed or uploaded line-art input before processing %j', async (extra) => {
    await expect(executePluginUiHostEffect({ ...lineArtContext(), effect: { type: 'image.lineArt', ...extra } })).rejects.toThrow('只接受');
    expect(mocks.createLineArtImage).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'self-video'])('rejects non-derived line-art source %s', async (resourceId) => {
    expect(await executePluginUiHostEffect({ ...lineArtContext(), effect: { type: 'image.lineArt', resourceId } }))
      .toMatchObject({ ok: false, error: expect.stringContaining('当前调用的派生图像') });
    expect(mocks.getLineArtResource).not.toHaveBeenCalled();
    expect(mocks.createLineArtImage).not.toHaveBeenCalled();
  });

  it.each(['files.connected.read', 'files.output.create'] as const)('requires %s for line art', async (missing) => {
    const context = lineArtContext();
    expect(await executePluginUiHostEffect({ ...context, permissions: context.permissions.filter((p) => p !== missing) }))
      .toMatchObject({ ok: false, error: expect.stringContaining('权限') });
    expect(mocks.createLineArtImage).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'project', 'revision', 'plugin', 'lease', 'decode'] as const)('does not cache line art after %s failure', async (failure) => {
    const context = lineArtContext();
    const controller = new AbortController();
    mocks.createLineArtImage.mockImplementationOnce(async () => {
      if (failure === 'cancel') controller.abort();
      if (failure === 'project') mocks.state.currentProjectId = 'other';
      if (failure === 'revision') mocks.revision += 1;
      if (failure === 'plugin') mocks.state.installedPlugins = [{ ...plugin, enabled: false }];
      if (failure === 'lease') mocks.setLineArtResource.mockImplementationOnce(() => { throw new Error('插件资源已失效'); });
      if (failure === 'decode') throw new Error('图片解码失败');
      return { bytes: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png', width: 1, height: 1, previewDataUrl: 'data:image/png;base64,iVBORw==' };
    });
    expect(await executePluginUiHostEffect({ ...context, signal: controller.signal })).toMatchObject({ ok: false });
    if (failure !== 'lease') expect(mocks.setLineArtResource).not.toHaveBeenCalled();
    expect(mocks.saveBinaryToProjectData).not.toHaveBeenCalled();
  });

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
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'execute_node_plugin_tool')).toHaveLength(1);
      if (reason === 'abort') expect(mocks.invoke).toHaveBeenCalledWith('cancel_node_plugin_tool', { pluginId: plugin.id, invocationId: 'cancelled-ui' });
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

  it('aborts a text model request when its plugin UI session is cancelled', async () => {
    const context = uiContext();
    const controller = new AbortController();
    mocks.generateText.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      controller.abort(new Error('用户取消了文本生成'));
      signal?.throwIfAborted();
      return '迟到的回复';
    });

    const result = await executePluginUiHostEffect({
      ...context,
      permissions: ['models.read', 'models.invoke'],
      models: modelCatalog,
      effect: { type: 'model.generate', modelId: 'gpt-4o', prompt: '分析素材' },
      signal: controller.signal,
    });

    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(result).toMatchObject({ type: 'model.generate', ok: false, error: '用户取消了文本生成' });
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
    expect(mocks.addNode).not.toHaveBeenCalled();
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
    ).rejects.toThrow('model 操作不能超过 4 次');
    expect(mocks.addNode).not.toHaveBeenCalled();
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });
}
