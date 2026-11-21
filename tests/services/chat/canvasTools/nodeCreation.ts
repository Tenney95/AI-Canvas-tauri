import { expect, it, vi } from 'vitest';
import { useAppStore } from '../../../../src/store/useAppStore';
import { registerShotlistAgentTools } from '../../../../src/services/chat/tools/shotlistTools';
import { validateAgentToolInput } from '../../../../src/services/chat/agentToolSchemas';
import { getAgentTool, prepareAgentToolCall } from '../../../../src/services/chat/toolRegistry';
import type { BaseNodeData } from '../../../../src/types';
import { emptyDramaAssetLibrary, type DramaAsset } from '../../../../src/types/dramaAssets';
import type { CanvasCreationFixture } from '../canvasTools.test';

export function registerNodeCreationTests({ node, context, loadGlobalAssets, executeGeneration }: CanvasCreationFixture) {
  it('MCP 创建、查询和更新图片质量背景及视频帧率音轨，保留自动时长和 false', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, video: { name: '视频连接', catalogId: 'custom-openai', apiKey: 'fixture' } },
      generalModels: [
        { id: 'image-options', name: '图片模型', modelId: 'image-options', category: 'image', providerConfigId: 'video',
          imageCapability: { qualities: ['low', 'high'], backgrounds: ['opaque', 'transparent'] } },
        { id: 'video-auto', name: '视频模型', modelId: 'video-auto', category: 'video', providerConfigId: 'video',
          videoCapability: { operations: ['text-to-video'], automaticDurationValue: -1, frameRates: [24], supportsAudio: true } },
      ],
    } }));
    const create = getAgentTool('canvas_create_nodes')!;
    const input = { nodes: [
      { type: 'ai-image', label: '透明图', model: 'general/image-options', imageQuality: 'high', imageBackground: 'transparent' },
      { type: 'ai-video', label: '视频', model: 'general/video-auto', videoDuration: -1, videoFps: 24, generateAudio: false },
    ] };
    expect(validateAgentToolInput(create.inputSchema, input).valid).toBe(true);
    expect((await create.execute(context(), input)).status).toBe('success');
    const image = useAppStore.getState().nodes.find((item) => item.data.label === '透明图')!;
    const video = useAppStore.getState().nodes.find((item) => item.data.label === '视频')!;
    expect(image.data).toMatchObject({ imageQuality: 'high', imageBackground: 'transparent' });
    expect(video.data).toMatchObject({ seedanceDuration: -1, videoFps: 24, generateAudio: false });
    const update = getAgentTool('canvas_update_nodes')!;
    const patch = { nodeIds: [image.id], imageBackground: '' };
    expect(validateAgentToolInput(update.inputSchema, patch).valid).toBe(true);
    expect((await update.execute(context(), patch)).status).toBe('success');
    const query = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [image.id, video.id], detail: true });
    const nodes = JSON.parse(query.modelContent).nodes;
    expect(nodes.find((item: { id: string }) => item.id === image.id)).toMatchObject({ imageQuality: 'high', imageBackground: '' });
    expect(nodes.find((item: { id: string }) => item.id === video.id)).toMatchObject({ videoDuration: -1, videoFps: 24, generateAudio: false });
    expect((await update.execute(context(), { nodeIds: [video.id], videoFps: 30 })).status).toBe('error');
    expect((await update.execute(context(), { nodeIds: [image.id], imageQuality: 'max' })).status).toBe('error');
    expect(useAppStore.getState().nodes.find((item) => item.id === video.id)?.data.videoFps).toBe(24);
    expect(useAppStore.getState().nodes.find((item) => item.id === image.id)?.data.imageQuality).toBe('high');
    // 即使节点在别处被改成不受当前模型支持的值，运行入口也不能静默丢弃后调用模型。
    useAppStore.getState().updateNodeDataTransient(image.id, { imageQuality: 'max' });
    const run = await getAgentTool('canvas_run_nodes')!.execute(context(), { nodeIds: [image.id] });
    expect(run.status).toBe('error');
    expect(JSON.parse(run.modelContent).results[0].message).toContain('质量');
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('MCP 创建和更新 GIF 参数保留 false，切换 SVG 或未声明模型清除失效参数', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, output: { name: '图片连接', catalogId: 'custom-openai', apiKey: 'fixture' } },
      generalModels: [
        { id: 'image-output', name: '图片模型', modelId: 'image-output', category: 'image', providerConfigId: 'output',
          executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
            submit: { method: 'POST', path: '/images/generations', body: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}',
              output_format: '{{imageOutputFormat}}', frame_count: '{{imageFrameCount}}',
              frame_duration_ms: '{{imageFrameDurationMs}}', transparent: '{{imageTransparent}}' } },
            response: { type: 'json', result: { urlPath: 'data.*.url' } } } },
          imageCapability: { ratios: ['1:1'], resolutions: ['2K'], outputFormats: ['png', 'gif', 'svg'], defaultOutputFormat: 'png',
            squareOnlyOutputFormats: ['gif', 'svg'], textOnlyOutputFormats: ['gif', 'svg'],
            gifFrameCount: { min: 2, max: 16, default: 9 }, gifFrameDurationMs: { min: 20, max: 655350, step: 10, default: 200 },
            supportsGifTransparency: true } },
        { id: 'plain-image', name: '普通图片', modelId: 'plain-image', category: 'image', providerConfigId: 'output' },
      ],
    } }));
    const create = getAgentTool('canvas_create_nodes')!, update = getAgentTool('canvas_update_nodes')!;
    const output = { imageOutputFormat: 'gif', imageFrameCount: 8, imageFrameDurationMs: 300, imageTransparent: false };
    const input = { nodes: [{ type: 'ai-image', label: '动图', model: 'general/image-output', aspectRatio: '1:1', ...output }] };
    expect(validateAgentToolInput(create.inputSchema, input).valid).toBe(true);
    expect((await create.execute(context(), input)).status).toBe('success');
    const node = useAppStore.getState().nodes.find((item) => item.data.label === '动图')!;
    expect(node.data).toMatchObject(output);
    expect((await update.execute(context(), { nodeIds: [node.id], aspectRatio: '16:9' })).status).toBe('error');
    expect((await update.execute(context(), { nodeIds: [node.id], model: 'general/image-output', imageSize: '4K' })).status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === node.id)?.data).toMatchObject({ ...output, imageSize: '4K' });
    expect((await update.execute(context(), { nodeIds: [node.id], imageFrameCount: 17 })).status).toBe('error');
    expect((await update.execute(context(), { nodeIds: [node.id], imageOutputFormat: 'svg' })).status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === node.id)?.data).toMatchObject({ imageOutputFormat: 'svg',
      imageFrameCount: undefined, imageFrameDurationMs: undefined, imageTransparent: undefined });
    expect((await update.execute(context(), { nodeIds: [node.id], model: 'general/plain-image' })).status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === node.id)?.data.imageOutputFormat).toBeUndefined();
    expect((await update.execute(context(), { nodeIds: [node.id], imageOutputFormat: 'gif' })).status).toBe('error');
  });

  it('拒绝未声明的自动时长及跨类型参数，不写入画布', async () => {
    const before = useAppStore.getState().nodes;
    const tool = getAgentTool('canvas_create_nodes')!;
    expect((await tool.execute(context(), { nodes: [{ type: 'ai-video', label: '视频', videoDuration: -1 }] })).status).toBe('error');
    expect((await tool.execute(context(), { nodes: [{ type: 'ai-image', label: '图片', videoFps: 24 }] })).status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(before);
  });

  it('创建前拒绝把疑似凭据放进媒体参数，错误不回显原值', () => {
    const secret = 'sk-test-secret-fixture';
    const result = prepareAgentToolCall({ callId: 'unsafe', toolId: 'canvas_create_nodes', input: { nodes: [
      { type: 'ai-image', label: '图片', imageQuality: secret },
    ] } }, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.summary).not.toContain(secret);
    expect(useAppStore.getState().nodes).toHaveLength(2);
  });

  it('routes ready video bindings to the generated-video column and images to frame without replacing either reference', async () => {
    const frame = { nodeId: 'old-image', kind: 'image' as const, url: 'old.png' };
    useAppStore.setState({ nodes: [node('sheet', { type: 'ai-shotlist', shotlistRows: [{ id: 'r', shotNo: '1', frame, duration: 4 }] }),
      node('video', { type: 'source-video', videoUrl: 'ready.mp4', videoDuration: 8 }),
      node('image', { imageUrl: 'new.png' }), node('pending', { type: 'ai-video' })] });
    const tool = getAgentTool('canvas_bind_shotlist_frame')!;
    const bound = await tool.execute(context(), { shotlistId: 'sheet', rowId: 'r', sourceNodeId: 'video' });
    expect(bound.status).toBe('success');
    expect(JSON.parse(bound.modelContent)).toMatchObject({ target: 'video', reused: false, sourceNodeId: 'video' });
    expect(useAppStore.getState().nodes[0].data.shotlistRows![0]).toMatchObject({ frame, duration: 4,
      video: { nodeId: 'video', kind: 'video', url: 'ready.mp4' } });
    const revision = useAppStore.getState().getCurrentRevision();
    const repeated = await tool.execute(context(), { shotlistId: 'sheet', rowId: 'r', sourceNodeId: 'video' });
    expect(JSON.parse(repeated.modelContent)).toMatchObject({ target: 'video', reused: true, revision });
    const image = await tool.execute(context(), { shotlistId: 'sheet', rowId: 'r', sourceNodeId: 'image' });
    expect(image.status).toBe('success');
    expect(JSON.parse(image.modelContent).target).toBe('frame');
    expect(useAppStore.getState().nodes[0].data.shotlistRows![0]).toMatchObject({ frame: { nodeId: 'image' }, video: { nodeId: 'video' } });
    const pending = await tool.execute(context(), { shotlistId: 'sheet', rowId: 'r', sourceNodeId: 'pending' });
    expect(pending.status).toBe('error');
    expect(useAppStore.getState().nodes[0].data.shotlistRows![0].video?.nodeId).toBe('video');
    expect(useAppStore.getState().edges).toEqual([{ id: 'e1', source: 'n1', target: 'n2' }]);
  });

  it('MCP 冷查询、创建与更新可优先使用已存全局场景，且不要求先打开库', async () => {
    const global: DramaAsset = { id: 'global-scene', kind: 'scene', name: '全局街道', key: 'street', summary: '', visualNotes: '',
      importance: 'main', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1,
      imageUrl: useAppStore.getState().nodes[0].data.imageUrl };
    loadGlobalAssets.mockResolvedValue([global]);
    const mcp = { ...context(), conversationId: 'mcp-control-p1' };
    const queried = await getAgentTool('canvas_query')!.execute(mcp, { nodeIds: ['n1'], detail: true });
    expect(JSON.parse(queried.modelContent).nodes[0].preferredMention).toBe('@drama{global/global-scene:全局街道}');
    expect(useAppStore.getState().globalScenes).toEqual([]);
    expect((await getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [
      { type: 'ai-video', label: '镜头', prompt: '@{n1:场景} @{n2:剧本}' },
    ] })).status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.data.prompt).toBe('@drama{global/global-scene:全局街道} @{n2:剧本}');
    expect(useAppStore.getState().edges.filter((edge) => edge.target === created.id).map((edge) => edge.source)).toEqual(['n2']);
    await getAgentTool('canvas_update_nodes')!.execute(mcp, { nodeIds: [created.id], prompt: '@{n1:新引用}' });
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBe('@drama{global/global-scene:全局街道}');
  });

  it('全局目录读取失败仍可查询画布，并保留原节点引用与真实连线', async () => {
    loadGlobalAssets.mockRejectedValue(new Error('private-path-do-not-expose'));
    const mcp = { ...context(), conversationId: 'mcp-control-p1' };
    const queried = await getAgentTool('canvas_query')!.execute(mcp, { nodeIds: ['n1'], detail: true });
    expect(queried.status).toBe('success');
    expect(JSON.parse(queried.modelContent).nodes[0].preferredMention).toBeUndefined();
    expect(queried.modelContent).not.toContain('private-path');
    expect((await getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [
      { type: 'ai-video', label: '镜头', prompt: '@{n1:原节点}' },
    ] })).status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.data.prompt).toBe('@{n1:原节点}');
    expect(useAppStore.getState().edges.some((edge) => edge.target === created.id && edge.source === 'n1')).toBe(true);
  });

  it.each(['project', 'revision'] as const)('全局目录读取期间 %s 变化阻止旧 MCP 请求写入', async (change) => {
    let finish!: (assets: DramaAsset[]) => void;
    loadGlobalAssets.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const mcp = { ...context(), conversationId: 'mcp-control-p1' };
    const operation = getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [
      { type: 'ai-video', label: '旧请求', prompt: '@{n1:场景}' },
    ] });
    // 让动态 import 进入已登记的读取，随后才切换项目或画布版本。
    await vi.waitFor(() => expect(loadGlobalAssets).toHaveBeenCalledTimes(1));
    if (change === 'project') useAppStore.setState({ currentProjectId: 'p2' });
    else useAppStore.getState().incrementRevision();
    const nodes = useAppStore.getState().nodes;
    finish([]);
    await expect(operation).rejects.toThrow('项目或画布已变化');
    expect(useAppStore.getState().nodes).toBe(nodes);
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('creates a video from a stable shot reference with one real sheet edge and respects explicit duration', async () => {
    useAppStore.setState({ projectLoadStatus: 'ready', nodes: [node('sheet', {
      type: 'ai-shotlist', label: '分镜', shotlistRows: [{ id: 'r', shotNo: '1', content: '她合上书', duration: 4.3 }],
    })], edges: [] });
    const tool = getAgentTool('canvas_create_nodes')!;
    expect((await tool.execute(context(), { nodes: [
      { type: 'ai-video', label: '跟随分镜', prompt: '@{sheet/shot/r:镜1}' },
      { type: 'ai-video', label: '手动时长', prompt: '@{sheet/shot/r:镜1}', videoDuration: 12 },
    ] })).status).toBe('success');
    const videos = useAppStore.getState().nodes.filter((item) => item.data.type === 'ai-video');
    expect(videos[0].data).toMatchObject({ prompt: '@{sheet/shot/r:镜1}', seedanceDuration: 5,
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'r', kind: 'video', durationSync: 'auto' } });
    expect(videos[1].data).toMatchObject({ seedanceDuration: 12, shotlistProductionSource: { durationSync: 'manual' } });
    expect(useAppStore.getState().edges.map((edge) => [edge.source, edge.target])).toEqual(videos.map((video) => ['sheet', video.id]));
    useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: [{ id: 'r', shotNo: '1', content: '她合上书', duration: 8.1 }] });
    const current = useAppStore.getState().nodes.filter((item) => item.data.type === 'ai-video');
    expect(current.map((video) => video.data.seedanceDuration)).toEqual([9, 12]);
  });

  it('rejects a batch containing a deleted shot reference without writing partial nodes', async () => {
    useAppStore.setState({ nodes: [node('sheet', { type: 'ai-shotlist', shotlistRows: [{ id: 'r', shotNo: '1', content: '有效镜头' }] })], edges: [] });
    const before = useAppStore.getState().nodes;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-video', label: '有效镜头', prompt: '@{sheet/shot/r:镜1}' },
      { type: 'ai-video', label: '已删镜头', prompt: '@{sheet/shot/deleted:镜2}' },
    ] });
    expect(result.status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(before);
    expect(useAppStore.getState().edges).toEqual([]);
  });

  it('prefers exact library images in MCP prompts and avoids their automatic edges while preserving other dependencies', async () => {
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), props: [{
      id: 'prop-1', kind: 'prop', name: '茶壶', key: '茶壶', summary: '', visualNotes: '',
      importance: 'supporting', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1, imageNodeId: 'n1',
    }] } });
    const mcp = { ...context(), conversationId: 'mcp-control-p1' };
    const queried = await getAgentTool('canvas_query')!.execute(mcp, { nodeIds: ['n1'], detail: true });
    expect(JSON.parse(queried.modelContent).nodes[0].preferredMention).toBe('@drama{prop-1:茶壶}');
    const result = await getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [{
      type: 'ai-video', label: '镜头', prompt: 'Picture 1: @{n1:茶壶}\n说明 @{n2:剧本}',
    }] });
    expect(result.status).toBe('success');
    const video = useAppStore.getState().nodes.at(-1)!;
    expect(video.data.prompt).toBe('Picture 1: @drama{prop-1:茶壶}\n说明 @{n2:剧本}');
    expect(useAppStore.getState().edges.filter((edge) => edge.target === video.id).map((edge) => edge.source)).toEqual(['n2']);
    const update = await getAgentTool('canvas_update_nodes')!.execute(mcp, {
      nodeIds: [video.id], prompt: 'Picture 1: @{n1:旧节点名}',
    });
    expect(update.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBe('Picture 1: @drama{prop-1:茶壶}');
    const normal = await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: [video.id], prompt: '@{n1:显式节点}' });
    expect(normal.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBe('@{n1:显式节点}');
    await getAgentTool('canvas_create_nodes')!.execute(mcp, { nodes: [{
      type: 'source-text', label: '定稿正文', prompt: '保留 @{n1:原始引用}',
    }] });
    expect(useAppStore.getState().nodes.at(-1)?.data.output).toBe('保留 @{n1:原始引用}');
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it.each(['scene', 'prop', 'character'] as const)('links new %s reference images to an existing project asset before generation', async (kind) => {
    const asset = { id: 'asset-1', kind, name: '参考资产', key: '参考资产', summary: '', visualNotes: '',
      importance: 'supporting' as const, confirmed: true, source: 'manual' as const, createdAt: 1, updatedAt: 1, identity: '' };
    useAppStore.getState().upsertDramaAsset(asset as DramaAsset);
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [{
      type: 'ai-image', label: '参考图', prompt: '纯色背景参考图', dramaAssetId: asset.id,
    }] });
    expect(result.status).toBe('success');
    const image = useAppStore.getState().nodes.at(-1)!;
    expect(image.data).toMatchObject({ dramaAssetId: asset.id, dramaAssetKind: kind, status: 'idle' });
    useAppStore.getState().updateNodeDataTransient(image.id, { imageUrl: 'generated.png', status: 'success' });
    useAppStore.getState().syncDramaAssetImageFromNode(image.id, 'generated.png');
    const library = useAppStore.getState().dramaAssets;
    expect([...library.characters, ...library.scenes, ...library.props][0]).toMatchObject({ imageNodeId: image.id, imageUrl: 'generated.png' });
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('rejects invalid asset links before writing any nodes in a batch', async () => {
    const before = useAppStore.getState().nodes;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '正常图片' },
      { type: 'ai-image', label: '无效绑定', dramaAssetId: 'missing' },
    ] });
    expect(result.status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(before);
  });

  it('keeps canvas queries usable when an imported AI application is malformed', async () => {
    useAppStore.setState({ nodes: [
      ...useAppStore.getState().nodes,
      node('broken-app', { type: 'ai-app', aiApp: {} as BaseNodeData['aiApp'] }),
    ] });
    const result = await getAgentTool('canvas_query')!.execute(context(), { detail: true });
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent).nodes.find((item: { id: string }) => item.id === 'broken-app'))
      .toMatchObject({ aiApp: { unavailable: true } });
  });

  it('connects the shotlist and per-shot briefs into downstream directors', async () => {
    registerShotlistAgentTools();
    useAppStore.setState({ projectLoadStatus: 'ready' });
    const created = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-shotlist', label: '雨夜分镜', prompt: '雨夜车站重逢', x: 1000, y: 1000 },
    ] });
    expect(created.status).toBe('success');
    const sheetId = JSON.parse(created.modelContent).nodes[0].id;
    const edited = await getAgentTool('shotlist_update_rows')!.execute(context(), {
      nodeId: sheetId, mode: 'append', rows: [
        { content: '旅人走入车站', duration: 5 },
        { content: '两人重逢', duration: 7 },
      ],
    });
    expect(edited.status).toBe('success');
    const rowIds = useAppStore.getState().nodes.find((item) => item.id === sheetId)!.data.shotlistRows!.map((row) => row.id);
    const prepared = await getAgentTool('shotlist_prepare_production')!.execute(context(), {
      nodeId: sheetId, rowIds, kind: 'director',
    });
    expect(prepared.status).toBe('success');
    const state = useAppStore.getState();
    const directors = state.nodes.filter((item) => item.type === 'ai-director');
    expect(directors).toHaveLength(2);
    for (const director of directors) {
      expect(state.edges).toContainEqual(expect.objectContaining({
        source: sheetId, target: director.id, sourceHandle: 'right', targetHandle: 'left',
      }));
      const incoming = state.edges.filter((edge) => edge.target === director.id);
      expect(incoming).toHaveLength(2);
      const brief = state.nodes.find((item) => item.id === incoming.find((edge) => edge.source !== sheetId)!.source)!;
      expect(brief.type).toBe('source-text');
      expect(brief.position.x + brief.data.nodeWidth!).toBeLessThanOrEqual(director.position.x - 80);
      expect(director.data.shotlistProductionSource?.nodeId).toBe(sheetId);
    }
    expect(state.edges.some((edge) => edge.target === sheetId && directors.some((director) => director.id === edge.source))).toBe(false);
    expect(state.nodes.find((item) => item.id === sheetId)!.data.prompt).toBe('雨夜车站重逢');
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('creates wider shotlists and keeps mixed batches apart', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-shotlist', label: '雨夜分镜' },
      { type: 'ai-text', label: '镜头说明', content: '蓝衣旅人走向等候者。' },
      { type: 'ai-shotlist', label: '重逢分镜' },
      { type: 'ai-shotlist', label: '下一行分镜' },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    for (const sheet of created.filter((item) => item.type === 'ai-shotlist')) {
      expect(sheet.data).toMatchObject({ nodeWidth: 1920, nodeHeight: 640 });
    }
    const read = await getAgentTool('canvas_query')!.execute(context(), {
      nodeIds: created.map((item) => item.id), detail: true,
    });
    const reported = JSON.parse(read.modelContent).nodes;
    expect(reported[0].size).toEqual({ width: 1920, height: 640 });
    for (const [index, item] of created.entries()) {
      for (const other of created.slice(index + 1)) {
        const separated = item.position.x + item.data.nodeWidth! <= other.position.x
          || other.position.x + other.data.nodeWidth! <= item.position.x
          || item.position.y + item.data.nodeHeight! <= other.position.y
          || other.position.y + other.data.nodeHeight! <= item.position.y;
        expect(separated).toBe(true);
      }
    }
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('keeps mixed batches compact without letting a large node enlarge every column and row', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-text', label: '说明一' },
      { type: 'ai-image', label: '方图', aspectRatio: '1:1' },
      { type: 'ai-text', label: '说明二' },
      { type: 'ai-shotlist', label: '大分镜表' },
      { type: 'ai-text', label: '说明三' },
      { type: 'ai-text', label: '说明四' },
      { type: 'ai-text', label: '说明五' },
      { type: 'ai-text', label: '说明六' },
      { type: 'ai-text', label: '说明七' },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    // 大表位于第一列、第二行，不能影响第二列的宽度与第一行的高度。
    expect(created[2].position.x - (created[1].position.x + created[1].data.nodeWidth!)).toBe(48);
    expect(created[3].position.y - (created[1].position.y + created[1].data.nodeHeight!)).toBe(40);
    expect(created[6].position.y - (created[3].position.y + created[3].data.nodeHeight!)).toBe(40);
    const right = Math.max(...created.map((item) => item.position.x + item.data.nodeWidth!));
    const left = Math.min(...created.map((item) => item.position.x));
    // 分镜表加宽 640，其他普通列仍保持紧凑，不能全部跟随大表宽度。
    expect(right - left).toBeLessThan(2640);
    expect(created[3].data).toMatchObject({ nodeWidth: 1920, nodeHeight: 640 });
  });

  it.each(['assistant', 'mcp'] as const)('anchors %s creation beside actual prompt dependencies instead of distant unrelated nodes', async (channel) => {
    const existing = [
      node('source', { type: 'source-image', nodeWidth: 280, nodeHeight: 160 }),
      node('far', {}, { x: 30_000, y: 10_000 }),
    ];
    useAppStore.setState({ nodes: existing, edges: [] });
    const ctx = { ...context(), ...(channel === 'mcp' ? { conversationId: 'mcp-control-p1' } : {}) };
    const result = await getAgentTool('canvas_create_nodes')!.execute(ctx, { nodes: [
      { type: 'ai-image', label: '参考图变体', prompt: '依据 @{source:参考图} 调整构图' },
    ] });
    expect(result.status).toBe('success');
    const state = useAppStore.getState();
    const created = state.nodes.at(-1)!;
    expect(created.position.x - (existing[0].position.x + existing[0].data.nodeWidth!)).toBe(48);
    expect(created.position.y).toBe(100);
    expect(state.nodes.slice(0, 2).map((item) => item.position)).toEqual(existing.map((item) => item.position));
    expect(state.edges).toContainEqual(expect.objectContaining({ source: 'source', target: created.id }));
    expect(state.history).toHaveLength(1);
  });

  it('uses nearby vertical space when the dependency column is occupied', async () => {
    useAppStore.setState({ nodes: [
      node('source', { type: 'source-image', nodeWidth: 280, nodeHeight: 160 }),
      node('occupied', { nodeWidth: 280, nodeHeight: 160 }, { x: 428, y: 100 }),
      node('far', {}, { x: 30_000, y: 10_000 }),
    ], edges: [] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '相邻变体', prompt: '@{source:参考图}' },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.position.x).toBe(428);
    expect(Math.abs(created.position.y - 100)).toBe(200);
    const below = created.position.y >= 100 + 160 + 40;
    const above = created.position.y + created.data.nodeHeight! <= 100 - 40;
    expect(below || above).toBe(true);
  });

  it('preserves explicit positions and avoids them while placing automatic nodes in the same batch', async () => {
    useAppStore.setState({ nodes: [node('source', { type: 'source-image', nodeWidth: 280, nodeHeight: 160 })], edges: [] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '指定坐标', x: 428, y: 100 },
      { type: 'ai-image', label: '自动坐标', prompt: '@{source:参考图}' },
    ] });
    expect(result.status).toBe('success');
    const [fixed, automatic] = useAppStore.getState().nodes.slice(1);
    expect(fixed.position).toEqual({ x: 428, y: 100 });
    expect(automatic.position.x).toBe(fixed.position.x);
    expect(Math.abs(automatic.position.y - fixed.position.y)).toBe(200);
  });

  it('preserves a single explicit axis while avoiding obstacles on that actual axis', async () => {
    useAppStore.setState({ nodes: [node('source', { nodeWidth: 280, nodeHeight: 160 })], edges: [] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '固定横坐标', x: 100 },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.position.x).toBe(100);
    expect(Math.abs(created.position.y - 100)).toBe(200);
  });

  it('rejects conflicting partial coordinates before creating overlapping nodes', async () => {
    const before = useAppStore.getState().nodes;
    await expect(getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '同列一', x: 100 },
      { type: 'ai-image', label: '同列二', x: 100 },
    ] })).rejects.toThrow('无法在保留指定坐标的同时避免节点重叠');
    expect(useAppStore.getState().nodes).toEqual(before);
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('creates image, video and audio nodes with explicit generation settings and reads them back', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '竖屏分镜', prompt: '小满在酒馆门口', aspectRatio: '9:16', imageSize: '2K', batchCount: 2 },
      { type: 'ai-video', label: '镜头', prompt: '小满回头', aspectRatio: '9:16', videoLongSide: 832, videoDuration: 8.1 },
      { type: 'ai-audio', label: '旁白', prompt: '请进来', audioPurpose: 'speech', audioFormat: 'flac',
        audioSpeechSettings: { voiceStyle: 'girl', pace: 2, duration: 9 } },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    expect(created[0].data).toMatchObject({ aspectRatio: '9:16', imageSize: '2K', batchCount: 2 });
    expect(created[1].data).toMatchObject({ seedanceRatio: '9:16', videoResolution: 832, seedanceDuration: 9 });
    expect(created[2].data).toMatchObject({ audioPurpose: 'speech', audioFormat: 'flac',
      audioSpeechSettings: { voiceStyle: 'girl', pace: 2, duration: 9 } });
    const read = await getAgentTool('canvas_query')!.execute(context(), {
      nodeIds: created.map((item) => item.id), detail: true,
    });
    expect(JSON.parse(read.modelContent).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ imageSize: '2K', batchCount: 2 }),
      expect.objectContaining({ videoResolution: '832', videoLongSide: 832, videoDuration: 9 }),
      expect.objectContaining({ audioPurpose: 'speech', audioFormat: 'flac',
        audioSpeechSettings: { voiceStyle: 'girl', pace: 2, duration: 9 } }),
    ]));
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('maps legacy numeric resolution to the local long side and keeps API quality presets separate', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-video', label: '旧客户端长边', videoResolution: '832' },
      { type: 'ai-video', label: 'API 档位', videoResolution: '720p' },
    ] });
    expect(result.status).toBe('success');
    const [local, api] = useAppStore.getState().nodes.slice(2);
    expect(local.data).toMatchObject({ videoResolution: 832 });
    expect(local.data.seedanceResolution).not.toBe('832');
    expect(api.data).toMatchObject({ seedanceResolution: '720p' });
    const update = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: [api.id], videoLongSide: 640,
    });
    expect(update.status).toBe('success');
    expect(useAppStore.getState().nodes.find((node) => node.id === api.id)?.data.videoResolution).toBe(640);
  });

  it('rejects a mixed invalid media batch without creating any nodes', async () => {
    const before = useAppStore.getState().nodes;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '有效图片', imageSize: '2K' },
      { type: 'ai-audio', label: '错误音频', videoResolution: '832' },
    ] });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('只能用于视频节点');
    expect(useAppStore.getState().nodes).toBe(before);
  });

  it('keeps explicit image controls on an empty-prompt node despite project defaults', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { imageAspectRatio: '16:9', imageSize: '1K' } } }] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '待写提示词的竖屏图', aspectRatio: '9:16', imageSize: '2K' },
    ] });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({ aspectRatio: '9:16', imageSize: '2K' });
  });

  it('rejects an unconfigured model before creating any nodes', async () => {
    const before = useAppStore.getState().nodes;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-image', label: '有效图片' },
      { type: 'ai-video', label: '无效模型', model: 'unknown/workflow' },
    ] });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('未配置');
    expect(useAppStore.getState().nodes).toBe(before);
  });

  it('updates audio settings but rejects applying them to images', async () => {
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes,
      node('audio1', { type: 'ai-audio' }, { x: 800, y: 100 })] });
    const update = getAgentTool('canvas_update_nodes')!;
    const result = await update.execute(context(), { nodeIds: ['audio1'], audioPurpose: 'music',
      musicDuration: 90, musicBpm: 120, autoGenerateLyrics: false });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'audio1')?.data).toMatchObject({
      audioPurpose: 'music', musicDuration: 90, musicBpm: 120, autoGenerateLyrics: false,
    });
    const beforeImage = useAppStore.getState().nodes[0].data;
    const invalid = await update.execute(context(), { nodeIds: ['n1'], musicDuration: 90 });
    expect(invalid.status).toBe('error');
    expect(useAppStore.getState().nodes[0].data).toBe(beforeImage);
  });

  it('creates and updates a configured general voice ID and MP3 without resetting its model', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, 'libapi-voice': { name: 'LibAPI', catalogId: 'libapi',
        apiKey: 'fixture', baseUrl: 'https://libapi.cc/v1' } },
      generalModels: [{ id: 'libapi-voice', name: 'LibAPI TTS', modelId: 'speech-2.8',
        category: 'audio', providerConfigId: 'libapi-voice' }],
    } }));
    const create = getAgentTool('canvas_create_nodes')!;
    const input = { nodes: [{ type: 'ai-audio', label: '旁白', model: 'general/libapi-voice',
      audioPurpose: 'speech', audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25 }] };
    expect(validateAgentToolInput(create.inputSchema, input).valid).toBe(true);
    expect((await create.execute(context(), input)).status).toBe('success');
    const created = useAppStore.getState().nodes.at(-1)!;
    expect(created.data).toMatchObject({ model: 'general/libapi-voice', provider: 'general',
      audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25 });

    const update = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: [created.id], audioVoice: 'user_cloned_voice_02', audioSpeed: 0.8,
    });
    expect(update.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({ model: 'general/libapi-voice',
      audioVoice: 'user_cloned_voice_02', audioFormat: 'mp3', audioSpeed: 0.8 });
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('rejects unsafe voice IDs and keeps the existing voice restriction for other providers', async () => {
    useAppStore.setState({ nodes: [node('legacy-audio', { type: 'ai-audio', provider: 'apimart',
      model: 'apimart/gpt-4o-mini-tts', audioVoice: 'alloy' })] });
    const update = getAgentTool('canvas_update_nodes')!;
    const before = useAppStore.getState().nodes;
    for (const audioVoice of ['Zephyr', 'voice\nID', 'voice\u0085ID', 'x'.repeat(257)]) {
      expect((await update.execute(context(), { nodeIds: ['legacy-audio'], audioVoice })).status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(before);
    }
  });

  it('keeps title and lyrics on audio placeholders so later node generation uses the same settings', () => {
    const intent = { kind: 'audio' as const, prompt: '轻柔民谣', modelRef: 'general/music-model', deliveryMode: 'both' as const,
      audioPurpose: 'music' as const, musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走' };
    const id = useAppStore.getState().createMediaPlaceholder(intent, { x: 1000, y: 100 });
    expect(useAppStore.getState().nodes.find((item) => item.id === id)?.data).toMatchObject({
      type: 'ai-audio', model: 'general/music-model', audioPurpose: 'music',
      musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走',
    });
  });

  it('导入分镜小数秒写入实际视频时长，并优先于项目默认值', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoDuration: 5 } } }] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-video', label: '镜1', videoDuration: 8.1 },
      { type: 'ai-video', label: '镜2', videoDuration: 4 },
      { type: 'ai-video', label: '镜3' },
    ] });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.slice(2).map((n) => n.data.seedanceDuration)).toEqual([9, 4, 5]);
    const read = await getAgentTool('canvas_query')!.execute(context(), { nodeType: 'ai-video', detail: true });
    expect(JSON.parse(read.modelContent).nodes.map((n: { videoDuration: number }) => n.videoDuration)).toEqual([9, 4, 5]);
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('无效分镜秒数或非视频字段拒绝整个导入批次', async () => {
    const before = useAppStore.getState().nodes;
    for (const invalid of [0, -1, NaN, Infinity, 3600.1]) {
      const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
        { type: 'ai-video', label: '有效', videoDuration: 8.1 },
        { type: 'ai-video', label: '无效', videoDuration: invalid },
      ] });
      expect(result.status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(before);
    }
    expect((await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-image', label: '图片', videoDuration: 5 }],
    })).status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(before);
  });
  it('renames visible media titles and text labels with one history snapshot', async () => {
    const media = node('n1', {
      type: 'source-image', fileName: 'mcp-upload-original.png',
      filePath: 'D:/data/original.png', imageUrl: 'asset://localhost/D:/data/original.png',
      prompt: '保留角色提示词',
    });
    useAppStore.setState({ nodes: [media, useAppStore.getState().nodes[1]] });
    const beforeNodes = useAppStore.getState().nodes;
    const beforeEdges = useAppStore.getState().edges;
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1', 'n2'], label: '  角色｜小满｜白底全身  ',
    });
    expect(result.status).toBe('success');
    const [renamedMedia, renamedText] = useAppStore.getState().nodes;
    expect(renamedMedia.data).toEqual({
      ...media.data, label: '角色｜小满｜白底全身', fileName: '角色｜小满｜白底全身',
    });
    expect(renamedText.data.label).toBe('角色｜小满｜白底全身');
    expect(renamedText.data.fileName).toBeUndefined();
    expect(useAppStore.getState().edges).toEqual(beforeEdges);
    const queried = await getAgentTool('canvas_query')!.execute(context(), { detail: true });
    expect(JSON.parse(queried.modelContent).nodes.map((item: { displayLabel: string }) => item.displayLabel))
      .toEqual(['角色｜小满｜白底全身', '角色｜小满｜白底全身']);
    expect(queried.modelContent).not.toContain('D:/data');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().history[0].nodes).toEqual(beforeNodes);
  });

  it('preserves a media display alias when editing only its prompt', async () => {
    useAppStore.setState({ nodes: [node('n1', { fileName: 'original.png' })] });
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1'], prompt: 'new prompt',
    });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes[0].data.fileName).toBe('original.png');
  });

  it('registers advanced canvas operations with closed schemas', () => {
    const ids = [
      'canvas_duplicate_node',
      'canvas_update_note',
      'canvas_move_note_layer',
      'canvas_convert_image_kind',
      'canvas_rename_group',
      'canvas_fill_storyboard_cell',
      'canvas_bind_shotlist_frame',
    ];
    for (const id of ids) {
      expect(getAgentTool(id), id).toMatchObject({ effect: 'canvas_write' });
      expect(getAgentTool(id)?.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('duplicates a node and converts an unconnected image into a canvas note', async () => {
    const duplicated = await getAgentTool('canvas_duplicate_node')!.execute(context(), { nodeId: 'n1' });
    expect(duplicated.status).toBe('success');
    expect(useAppStore.getState().nodes).toHaveLength(3);

    useAppStore.setState({ edges: [] });
    const converted = await getAgentTool('canvas_convert_image_kind')!.execute({
      ...context(),
      baseRevision: useAppStore.getState().getCurrentRevision(),
    }, { nodeId: 'n1' });
    expect(converted.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'n1')?.type).toBe('canvas-note');
  });

  it('describes requested and actual details for created nodes', async () => {
    const definition = getAgentTool('canvas_create_nodes')!;
    const input = {
      nodes: [{
        type: 'ai-video',
        label: '开场镜头',
        prompt: '夜晚城市航拍',
        x: 320,
        y: 180,
      }],
    };

    expect(definition.buildInputDisplay?.(input, context())).toMatchObject({
      entities: [{
        title: '开场镜头',
        fields: [
          { label: '类型', value: 'ai-video' },
          { label: '位置', value: '(320, 180)', source: 'user' },
        ],
        preview: '夜晚城市航拍',
      }],
    });

    const result = await definition.execute(context(), input);
    expect(result.display).toMatchObject({
      entities: [{
        title: '开场镜头',
        fields: [
          { label: '类型', value: 'ai-video' },
          { label: '位置', value: '(320, 180)', source: 'resolved' },
        ],
      }],
    });
  });

  it('sizes created nodes from aspect ratio and text length instead of one fixed box', async () => {
    const script = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [
        { type: 'ai-image', label: '角色·林默', prompt: '冷白皮肤，及肩黑发', aspectRatio: '3:4' },
        { type: 'ai-video', label: '场景·雨夜街道', prompt: '霓虹倒影', aspectRatio: '16:9' },
        { type: 'source-text', label: '剧本 第一集全文', prompt: script },
        { type: 'ai-text', label: '分镜文案', prompt: '拆解为镜头表' },
      ],
    });

    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    expect(created.map((item) => item.data.nodeHeight)).toEqual([
      372, // 3:4 竖构图撑高
      158, // 视频框按实际 16:9 比例计算，不套图片框的边框和最小高度
      600, // 30 行正文按行数撑高，封顶 600
      160, // 还没有正文的生成型文本节点保持默认
    ]);
    expect(created[0].data.aspectRatio).toBe('3:4');
    // 比例只对视觉节点有意义，文本节点不该被塞上 aspectRatio
    expect(created[2].data.aspectRatio).toBeUndefined();
  });

  it('sets the actual video ratio on creation and update, including mixed node batches', async () => {
    const created = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-video', label: '竖屏镜头', prompt: '参考 @{n1:分镜图}', aspectRatio: '9:16' }],
    });
    expect(created.status).toBe('success');
    const video = useAppStore.getState().nodes.at(-1)!;
    expect(video.data).toMatchObject({ aspectRatio: '9:16', seedanceRatio: '9:16' });
    expect(useAppStore.getState().edges.some((edge) => edge.source === 'n1' && edge.target === video.id)).toBe(true);

    useAppStore.getState().updateNodeDataTransient(video.id, { seedanceRatio: '16:9' });
    const queriedBefore = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [video.id], detail: true });
    expect(JSON.parse(queriedBefore.modelContent).nodes[0].aspectRatio).toBe('16:9');
    useAppStore.getState().updateNodeDataTransient(video.id, { seedanceRatio: undefined });
    const legacy = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [video.id], detail: true });
    expect(JSON.parse(legacy.modelContent).nodes[0].aspectRatio).toBeUndefined();

    const updated = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: [video.id, 'n1'], aspectRatio: '9:16',
    });
    expect(updated.status).toBe('success');
    const nodes = useAppStore.getState().nodes;
    expect(nodes.find((item) => item.id === video.id)?.data).toMatchObject({
      aspectRatio: '9:16', seedanceRatio: '9:16',
    });
    expect(nodes.find((item) => item.id === 'n1')?.data.seedanceRatio).toBeUndefined();
    const queriedAfter = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [video.id], detail: true });
    expect(JSON.parse(queriedAfter.modelContent).nodes[0].aspectRatio).toBe('9:16');
  });

  it.each([
    ['16:9', 158], ['9:16', 498], ['1:1', 280], ['4:3', 210], ['3:4', 373], ['21:9', 120],
  ])('creates %s video frames with matching generation controls despite project defaults', async (aspectRatio, height) => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoAspectRatio: '1:1' } } }] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-video', label: '空视频', aspectRatio }],
    });
    expect(result.status).toBe('success');
    const video = useAppStore.getState().nodes.at(-1)!;
    expect(video.data).toMatchObject({ aspectRatio, seedanceRatio: aspectRatio, nodeWidth: 280, nodeHeight: height });
    const queried = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: [video.id], detail: true });
    expect(JSON.parse(queried.modelContent).nodes[0]).toMatchObject({ aspectRatio, size: { width: 280, height } });
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('lays out inherited portrait video frames using their final size', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoAspectRatio: '9:16' } } }] });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: Array.from({ length: 4 }, (_, index) => ({ type: 'ai-video', label: `镜头${index}` })),
    });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    for (const video of created) {
      expect(video.data).toMatchObject({ aspectRatio: '9:16', seedanceRatio: '9:16', nodeWidth: 280, nodeHeight: 498 });
    }
    expect(created[3].position.y).toBeGreaterThan(created[0].position.y + created[0].data.nodeHeight!);
  });

  it('repairs legacy video frames on MCP ratio updates and shares the linkage with UI parameter writes', async () => {
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes,
      node('legacy-video', { type: 'ai-video', aspectRatio: '1:1', seedanceRatio: '16:9', nodeWidth: 420, nodeHeight: 420 }),
    ] });
    const updated = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['legacy-video', 'n1'], aspectRatio: '16:9',
    });
    expect(updated.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'legacy-video')?.data).toMatchObject({
      aspectRatio: '16:9', seedanceRatio: '16:9', nodeWidth: 420, nodeHeight: 236,
    });
    expect(useAppStore.getState().nodes[0].data.seedanceRatio).toBeUndefined();
    useAppStore.getState().updateNodeData('legacy-video', { seedanceRatio: '9:16' });
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({
      aspectRatio: '9:16', seedanceRatio: '9:16', nodeWidth: 420, nodeHeight: 747,
    });
    // 手动缩放或仅改提示词不能被比例联动反复覆盖。
    useAppStore.getState().updateNodeDataTransient('legacy-video', { nodeHeight: 500 });
    useAppStore.getState().updateNodesDataBatch(['legacy-video'], { prompt: '新提示词' });
    expect(useAppStore.getState().nodes.at(-1)?.data.nodeHeight).toBe(500);
    const resized = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['legacy-video'], width: 560, height: 560, aspectRatio: '16:9',
    });
    expect(resized.status).toBe('success');
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({ nodeWidth: 560, nodeHeight: 315 });
  });

  it('does not infer an adaptive frame or resize produced and imported videos', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoAspectRatio: '1:1' } } }] });
    await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-video', label: '自适应', aspectRatio: 'adaptive' }],
    });
    const adaptive = useAppStore.getState().nodes.at(-1)!;
    expect(adaptive.data).toMatchObject({ seedanceRatio: 'adaptive', nodeWidth: 280, nodeHeight: 160 });
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes,
      node('produced', { type: 'ai-video', videoUrl: 'asset://localhost/movie.mp4', nodeWidth: 320, nodeHeight: 180 }),
      node('imported', { type: 'ai-video', role: 'source', nodeWidth: 180, nodeHeight: 320 }),
    ] });
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: [adaptive.id, 'produced', 'imported'], aspectRatio: '9:16',
    });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === adaptive.id)?.data.nodeHeight).toBe(498);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'produced')?.data).toMatchObject({ nodeWidth: 320, nodeHeight: 180 });
    expect(useAppStore.getState().nodes.find((item) => item.id === 'imported')?.data).toMatchObject({ nodeWidth: 180, nodeHeight: 320 });
    await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: [adaptive.id], aspectRatio: 'adaptive' });
    expect(useAppStore.getState().nodes.find((item) => item.id === adaptive.id)?.data.nodeHeight).toBe(498);
  });

  it('puts finished text in the node body and generation instructions in the prompt', async () => {
    const script = '场景一：剧本正文\n场景二：更多正文';
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [
        { type: 'ai-text', label: '剧本·第一集全文', content: script },
        { type: 'ai-text', label: '分镜文案', prompt: '把这集拆成镜头表' },
      ],
    });

    expect(result.status).toBe('success');
    const [body, generator] = useAppStore.getState().nodes.slice(2);
    // 定稿正文进节点正文，建完就能看见，也能被下游 @ 引用
    expect(body.data).toMatchObject({ output: script, role: 'source', status: 'success' });
    expect(body.data.prompt).toBeUndefined();
    // 生成指令仍然只进提示词，节点正文留空等用户点生成
    expect(generator.data).toMatchObject({ prompt: '把这集拆成镜头表', role: 'generator', status: 'idle' });
    expect(generator.data.output).toBeUndefined();
  });

  it('materializes prompt mentions as de-duplicated edges in the same history entry', async () => {
    useAppStore.setState({
      nodes: [
        ...useAppStore.getState().nodes,
        node('grid', { type: 'ai-storyboard', label: '分镜宫格' }, { x: 800, y: 100 }),
      ],
    });
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [
        {
          type: 'ai-image',
          label: '合成画面',
          prompt: '参考 @{n1:主图}，再次参考 @{n1:主图副本}，并使用 @{grid/cell/2:第三格}',
        },
        {
          type: 'ai-text',
          label: '改写结果',
          prompt: '根据 @{n2:剧本正文} 改写',
        },
        {
          type: 'source-text',
          label: '引用说明',
          content: '正文中提到 @{n1:主图}，但它不是生成依赖',
        },
      ],
    });

    expect(result.status).toBe('success');
    expect(result.summary).toContain('自动连接 3 条引用');
    const created = useAppStore.getState().nodes.slice(3);
    const addedEdges = useAppStore.getState().edges.slice(1);
    expect(addedEdges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    }))).toEqual([
      { source: 'n1', target: created[0].id, sourceHandle: 'right', targetHandle: 'left' },
      { source: 'grid', target: created[0].id, sourceHandle: 'right', targetHandle: 'left' },
      { source: 'n2', target: created[1].id, sourceHandle: 'right', targetHandle: 'left' },
    ]);
    expect(JSON.parse(result.modelContent).edges).toEqual(addedEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })));

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['n1', 'n2', 'grid']);
    expect(useAppStore.getState().edges.map((edge) => edge.id)).toEqual(['e1']);
  });

  it('rejects missing prompt references before creating any nodes or edges', async () => {
    const beforeNodes = useAppStore.getState().nodes;
    const beforeEdges = useAppStore.getState().edges;
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{
        type: 'ai-image',
        label: '坏引用节点',
        prompt: '使用 @{missing-node:已删除节点} 作为参考',
      }],
    });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('missing-node');
    expect(useAppStore.getState().nodes).toBe(beforeNodes);
    expect(useAppStore.getState().edges).toBe(beforeEdges);
  });

  it('refuses to write content into media nodes whose output holds a path', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-image', label: '角色·林默', content: '不该写进图片节点' }],
    });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('content 只能用于文本类节点');
    expect(useAppStore.getState().nodes).toHaveLength(2);
  });
}
