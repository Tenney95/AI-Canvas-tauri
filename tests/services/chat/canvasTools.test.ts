import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerCanvasAgentTools } from '../../../src/services/chat/tools/canvasTools';
import { registerShotlistAgentTools } from '../../../src/services/chat/tools/shotlistTools';
import { validateAgentToolInput } from '../../../src/services/chat/agentToolSchemas';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import type { BaseNodeData } from '../../../src/types';
import { emptyDramaAssetLibrary, type DramaAsset } from '../../../src/types/dramaAssets';

const executeGeneration = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock('../../../src/services/generationService', () => ({ executeGeneration }));

function node(
  id: string,
  overrides: Partial<BaseNodeData> = {},
  position = { x: 100, y: 100 },
): Node<BaseNodeData> {
  return {
    id,
    type: overrides.type ?? 'ai-image',
    position,
    data: {
      label: id,
      type: overrides.type ?? 'ai-image',
      status: 'idle',
      ...overrides,
    } as BaseNodeData,
  };
}

function context(): AgentToolContext {
  return {
    taskId: 'task-1',
    projectId: 'p1',
    conversationId: 'c1',
    mode: 'autonomous',
    signal: new AbortController().signal,
  } as AgentToolContext;
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  executeGeneration.mockClear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'p1',
    nodes: [
      node('n1', { displayId: 1, prompt: '一只猫', imageUrl: 'asset://localhost/D:/data/cat.png' }),
      node('n2', { displayId: 2, type: 'source-text', output: '剧本正文' }, { x: 500, y: 220 }),
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  });
  registerCanvasAgentTools();
});

describe('canvas agent tools', () => {
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

  it('creates shotlists at the manual default size and keeps mixed batches apart', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), { nodes: [
      { type: 'ai-shotlist', label: '雨夜分镜' },
      { type: 'ai-text', label: '镜头说明', content: '蓝衣旅人走向等候者。' },
      { type: 'ai-shotlist', label: '重逢分镜' },
      { type: 'ai-shotlist', label: '下一行分镜' },
    ] });
    expect(result.status).toBe('success');
    const created = useAppStore.getState().nodes.slice(2);
    for (const sheet of created.filter((item) => item.type === 'ai-shotlist')) {
      expect(sheet.data).toMatchObject({ nodeWidth: 800, nodeHeight: 400 });
    }
    const read = await getAgentTool('canvas_query')!.execute(context(), {
      nodeIds: created.map((item) => item.id), detail: true,
    });
    const reported = JSON.parse(read.modelContent).nodes;
    expect(reported[0].size).toEqual({ width: 800, height: 400 });
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

  it('treats storyboard grids as image-cut results instead of generatable nodes', async () => {
    const createTool = getAgentTool('canvas_create_nodes')!;
    expect(createTool.inputSchema.properties).toMatchObject({
      nodes: { items: { properties: { type: { enum: expect.not.arrayContaining(['ai-storyboard']) } } } },
    });

    const created = await createTool.execute(context(), {
      nodes: [{ type: 'ai-storyboard', label: '九宫格', prompt: '生成九宫格分镜' }],
    });
    expect(created.status).toBe('error');
    expect(created.summary).toContain('只能由已有图片裁切产生');
    expect(useAppStore.getState().nodes).toHaveLength(2);

    useAppStore.setState({
      nodes: [
        ...useAppStore.getState().nodes,
        node('grid', { type: 'ai-storyboard', imageUrl: 'asset://localhost/D:/data/grid.png' }),
      ],
    });
    const updated = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['grid'],
      prompt: '不应写入宫格',
    });
    expect(updated.status).toBe('error');
    expect(updated.summary).toContain('不能设置生成提示词');
    expect(useAppStore.getState().nodes.at(-1)?.data.prompt).toBeUndefined();

    const run = await getAgentTool('canvas_run_nodes')!.execute(context(), { nodeIds: ['grid'] });
    expect(run.status).toBe('error');
    expect(run.summary).toContain('不能运行生成');
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it('returns structured node detail without leaking local media paths', async () => {
    const result = await getAgentTool('canvas_query')!.execute(context(), { detail: true });
    const payload = JSON.parse(result.modelContent);

    expect(result.status).toBe('success');
    expect(payload.nodes).toHaveLength(2);
    expect(payload.nodes[0]).toMatchObject({
      id: 'n1',
      displayId: 1,
      position: { x: 100, y: 100 },
      outputKind: 'image',
      prompt: { text: '一只猫', truncated: false },
    });
    // 媒体节点只报类型，绝对路径和 URL 都不能出现在回传内容里
    expect(result.modelContent).not.toContain('asset://');
    expect(result.modelContent).not.toContain('D:/data');
    expect(payload.nodes[1].outputText).toEqual({ text: '剧本正文', truncated: false });
    expect(payload.edges).toEqual([{
      id: 'e1', source: 'n1', target: 'n2', sourceHandle: null, targetHandle: null,
      layout: { sourceRightX: 380, targetLeftX: 500, horizontalGap: 120, recommendedMinGap: 80, warning: null },
    }]);
  });

  it.each<{ label: string; data: Partial<BaseNodeData>; outputKind: string | null }>([
    { label: 'video with thumbnail and poster', data: { type: 'ai-video', videoUrl: 'asset://clip.mp4', thumbnailUrl: 'asset://thumb.jpg', imageUrl: 'asset://poster.png' }, outputKind: 'video' },
    { label: 'audio with thumbnail and cover', data: { type: 'ai-audio', audioUrl: 'asset://audio.wav', thumbnailUrl: 'asset://thumb.jpg', imageUrl: 'asset://cover.png' }, outputKind: 'audio' },
    { label: 'image', data: { imageUrl: 'asset://image.png' }, outputKind: 'image' },
    { label: 'thumbnail-only image', data: { thumbnailUrl: 'asset://thumb.jpg' }, outputKind: 'image' },
    { label: 'text with thumbnail', data: { type: 'source-text', output: '实际正文', thumbnailUrl: 'asset://thumb.jpg' }, outputKind: 'text' },
    { label: 'text', data: { type: 'ai-text', output: '实际正文' }, outputKind: 'text' },
    { label: 'video type without a result', data: { type: 'ai-video', status: 'success' }, outputKind: null },
    { label: 'audio type without a result', data: { type: 'ai-audio' }, outputKind: null },
  ])('reports the actual primary output for $label without exposing media URLs', async ({ data, outputKind }) => {
    useAppStore.setState({ nodes: [node('result', data)], edges: [] });
    const result = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: ['result'], detail: true });
    expect(result.status).toBe('success');
    const detail = JSON.parse(result.modelContent).nodes[0];
    expect(detail.outputKind).toBe(outputKind);
    expect(detail.outputText).toEqual(outputKind === 'text' ? { text: '实际正文', truncated: false } : undefined);
    expect(result.modelContent).not.toContain('asset://');
  });

  it('shifts nodes with dx/dy and resizes them in one call', async () => {
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1', 'n2'],
      dx: 40,
      dy: -20,
      width: 400,
    });

    expect(result.status).toBe('success');
    const nodes = useAppStore.getState().nodes;
    expect(nodes.map((item) => item.position)).toEqual([
      { x: 140, y: 80 },
      { x: 540, y: 200 },
    ]);
    expect(nodes[0].data.nodeWidth).toBe(400);
    expect(result.display?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: 'n1',
        field: '位置 X',
        before: 100,
        after: 140,
      }),
      expect.objectContaining({
        targetId: 'n1',
        field: '宽度',
        before: 280,
        after: 400,
      }),
      expect.objectContaining({
        targetId: 'n2',
        field: '位置 Y',
        before: 220,
        after: 200,
      }),
    ]));
  });

  it('records before and after values for text changes', async () => {
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1'],
      label: '主视觉',
      prompt: '一只戴红围巾的猫',
      aspectRatio: '16:9',
    });

    expect(result.display?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: '名称', before: 'n1', after: '主视觉' }),
      expect.objectContaining({ field: '提示词', before: '一只猫', after: '一只戴红围巾的猫' }),
      expect.objectContaining({ field: '画面比例', before: undefined, after: '16:9' }),
    ]));
  });

  it('maps standardized video controls onto video node protocol fields', async () => {
    useAppStore.setState({
      nodes: [
        ...useAppStore.getState().nodes,
        node('n3', { displayId: 3, type: 'ai-video' }, { x: 800, y: 100 }),
      ],
    });

    const definition = getAgentTool('canvas_update_nodes')!;
    expect(definition.inputSchema.properties).toMatchObject({
      videoResolution: { type: 'string' },
      videoDuration: { type: 'integer' },
    });
    const result = await definition.execute(context(), {
      nodeIds: ['n3'],
      videoResolution: '768P',
      videoDuration: 4,
    });

    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'n3')?.data).toMatchObject({
      seedanceResolution: '768P',
      seedanceDuration: 4,
    });
    expect(result.display?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: '视频分辨率', before: undefined, after: '768P' }),
      expect.objectContaining({ field: '视频时长', before: undefined, after: 4 }),
    ]));

    const queried = await getAgentTool('canvas_query')!.execute(context(), {
      nodeIds: ['n3'],
      detail: true,
    });
    expect(JSON.parse(queried.modelContent).nodes[0]).toMatchObject({
      videoResolution: '768P',
      videoDuration: 4,
    });

    const guarded = await definition.execute(context(), {
      nodeIds: ['n1'],
      videoDuration: 4,
    });
    expect(guarded.status).toBe('error');
    expect(guarded.summary).toContain('只能用于视频节点');
  });

  it('rejects absolute moves that target more than one node', async () => {
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1', 'n2'],
      x: 10,
      y: 10,
    });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('dx/dy');
    expect(useAppStore.getState().nodes[0].position).toEqual({ x: 100, y: 100 });
  });

  it('rewrites text node content but refuses media nodes', async () => {
    const definition = getAgentTool('canvas_update_nodes')!;

    // n1 是图片节点，output 存的是本地路径，不能被 content 覆盖
    const guarded = await definition.execute(context(), { nodeIds: ['n1'], content: '新正文' });
    expect(guarded.status).toBe('error');
    expect(useAppStore.getState().nodes[0].data.imageUrl).toContain('cat.png');

    const result = await definition.execute(context(), { nodeIds: ['n2'], content: '新正文' });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes[1].data.output).toBe('新正文');
  });

  it('refuses model refs that are not configured', async () => {
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['n1'],
      model: 'made-up/model',
    });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('未配置');
    expect(useAppStore.getState().nodes[0].data.model).toBeUndefined();
  });

  it('refuses connections whose target is a source-only node', async () => {
    const definition = getAgentTool('canvas_connect_nodes')!;

    // n2 是 source-text，没有输入端；写反方向必须被挡下而不是画一条永远读不到的线
    const reversed = await definition.execute(context(), { sourceId: 'n1', targetId: 'n2' });
    expect(reversed.status).toBe('error');
    expect(reversed.summary).toContain('素材节点');
    expect(useAppStore.getState().edges).toHaveLength(1);

    const forward = await definition.execute(context(), { sourceId: 'n2', targetId: 'n1' });
    expect(forward.status).toBe('success');
    const created = useAppStore.getState().edges.at(-1);
    expect(created).toMatchObject({
      source: 'n2',
      target: 'n1',
      sourceHandle: 'right',
      targetHandle: 'left',
    });
  });

  it('connects an output list once, skips duplicates and restores the batch with one undo', async () => {
    const beforeEdges = [{ id: 'existing', source: 'image', target: 'target', sourceHandle: 'right', targetHandle: 'left' }];
    useAppStore.setState({ nodes: [
      node('image', { type: 'source-image' }, { x: 0, y: 0 }),
      node('brief', { type: 'source-text', output: '镜头说明' }, { x: 0, y: 250 }),
      node('target', { prompt: '原提示词' }, { x: 1000, y: 0 }),
    ], edges: beforeEdges });
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const revision = useAppStore.getState().getCurrentRevision();
    const tool = getAgentTool('canvas_connect_nodes')!;
    const result = await tool.execute(context(), { sourceIds: ['image', 'image', 'brief'], targetId: 'target' });
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent)).toMatchObject({
      sourceIds: ['image', 'brief'], targetId: 'target', createdCount: 1, skippedCount: 2,
      connections: [
        { sourceId: 'image', targetId: 'target', alreadyConnected: true, sourceHandle: 'right', targetHandle: 'left' },
        { sourceId: 'brief', targetId: 'target', alreadyConnected: false, sourceHandle: 'right', targetHandle: 'left' },
      ],
    });
    expect(useAppStore.getState().edges).toHaveLength(2);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'target')!.data.prompt).toContain('@{brief:brief}');
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    expect(commit).toHaveBeenCalledTimes(1);
    const repeated = await tool.execute(context(), { sourceIds: ['image', 'brief'], targetId: 'target' });
    expect(JSON.parse(repeated.modelContent)).toMatchObject({ createdCount: 0, skippedCount: 2 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().edges).toEqual(beforeEdges);
    await useAppStore.getState().redo();
    expect(useAppStore.getState().edges).toContainEqual(expect.objectContaining({
      source: 'brief', target: 'target', sourceHandle: 'right', targetHandle: 'left',
    }));
  });

  it('accepts one output in a list and keeps the old single-source result fields', async () => {
    const tool = getAgentTool('canvas_connect_nodes')!;
    expect(validateAgentToolInput(tool.inputSchema, { sourceIds: ['n2'], targetId: 'n1' }).valid).toBe(true);
    expect(validateAgentToolInput(tool.inputSchema, { sourceId: 'n2', targetId: 'n1' }).valid).toBe(true);
    expect(validateAgentToolInput(tool.inputSchema, { sourceIds: Array(51).fill('n2'), targetId: 'n1' }).valid).toBe(false);
    const result = await tool.execute(context(), { sourceIds: ['n2'], targetId: 'n1' });
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent)).toMatchObject({
      sourceId: 'n2', targetId: 'n1', sourceHandle: 'right', targetHandle: 'left', createdCount: 1,
    });
  });

  it.each([
    { targetId: 'n1' },
    { sourceId: 'n2', sourceIds: ['n2'], targetId: 'n1' },
    { sourceIds: [], targetId: 'n1' },
    { sourceIds: ['n2', 'missing'], targetId: 'n1' },
    { sourceIds: ['n2', 'n1'], targetId: 'n1' },
    { sourceIds: ['n1'], targetId: 'n2' },
  ])('rejects an invalid output list without partial writes: %j', async (input) => {
    const before = useAppStore.getState();
    const revision = before.getCurrentRevision();
    const commit = vi.spyOn(before, 'commitToHistory');
    const result = await getAgentTool('canvas_connect_nodes')!.execute(context(), input);
    expect(result.status).toBe('error');
    expect(useAppStore.getState().edges).toBe(before.edges);
    expect(useAppStore.getState().nodes).toBe(before.nodes);
    expect(commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
  });

  it.each(['sourceId', 'sourceIds'] as const)('rejects a director feeding its own shotlist through %s', async (field) => {
    useAppStore.setState({ nodes: [
      node('sheet', { type: 'ai-shotlist' }),
      node('director', { type: 'ai-director', shotlistProductionSource: { nodeId: 'sheet', rowId: 'row', kind: 'director' } }),
      node('other'),
    ], edges: [] });
    const result = await getAgentTool('canvas_connect_nodes')!.execute(context(), {
      ...(field === 'sourceId' ? { sourceId: 'director' } : { sourceIds: ['other', 'director'] }), targetId: 'sheet',
    });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('分镜表 → 导演台');
    expect(useAppStore.getState().edges).toEqual([]);
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('rejects a collapsed batch source before writing any other connection', async () => {
    const source = { ...node('n2', { type: 'source-text' }), parentId: 'group' };
    useAppStore.setState({ nodes: [useAppStore.getState().nodes[0], source,
      node('other', { type: 'source-image' }), { ...node('group', { groupCollapsed: true }), type: 'group' },
    ], edges: [] });
    const result = await getAgentTool('canvas_connect_nodes')!.execute(context(), { sourceIds: ['other', 'n2'], targetId: 'n1' });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('展开分组');
    expect(useAppStore.getState().edges).toEqual([]);
  });

  it('removes only the edges matching the given endpoints', async () => {
    useAppStore.setState({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n1' },
      ],
    });
    const definition = getAgentTool('canvas_disconnect_nodes')!;

    // 两端都不给会清空整张图的连线，必须先被拒绝
    const guarded = await definition.execute(context(), {});
    expect(guarded.status).toBe('error');
    expect(useAppStore.getState().edges).toHaveLength(2);

    const result = await definition.execute(context(), { sourceId: 'n1' });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().edges.map((edge) => edge.id)).toEqual(['e2']);
  });

  it('reports backward layout even when connection ports are right-to-left, without moving nodes', async () => {
    const tool = getAgentTool('canvas_connect_nodes')!;
    const before = useAppStore.getState().nodes.map((item) => ({ ...item.position }));
    const result = await tool.execute(context(), { sourceId: 'n2', targetId: 'n1' });
    const payload = JSON.parse(result.modelContent);
    expect(payload).toMatchObject({ sourceHandle: 'right', targetHandle: 'left' });
    expect(payload.layout.horizontalGap).toBeLessThan(0);
    expect(payload.layout.warning).toContain('上游应放左');
    expect(useAppStore.getState().nodes.map((item) => item.position)).toEqual(before);
    const revision = useAppStore.getState().getCurrentRevision();
    const repeated = await tool.execute({ ...context(), baseRevision: revision }, { sourceId: 'n2', targetId: 'n1' });
    expect(JSON.parse(repeated.modelContent)).toMatchObject({ alreadyConnected: true, layout: payload.layout });
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
  });

  it('checks absolute grouped positions and returns actual ports in canvas detail', async () => {
    const parent = node('group', {}, { x: 1000, y: 0 });
    const source = { ...node('src', { type: 'source-image', nodeWidth: 400 }, { x: 100, y: 0 }), parentId: 'group' };
    const target = node('dst', {}, { x: 1580, y: 200 });
    useAppStore.setState({ nodes: [parent, source, target], edges: [] });
    const result = await getAgentTool('canvas_connect_nodes')!.execute(context(), { sourceId: 'src', targetId: 'dst' });
    const payload = JSON.parse(result.modelContent);
    expect(payload.layout).toEqual({ sourceRightX: 1500, targetLeftX: 1580, horizontalGap: 80, recommendedMinGap: 80, warning: null });
    const query = await getAgentTool('canvas_query')!.execute(context(), { nodeIds: ['src'], detail: true });
    expect(JSON.parse(query.modelContent).edges[0]).toMatchObject({ sourceHandle: 'right', targetHandle: 'left', layout: payload.layout });
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === 'dst'
      ? { ...item, position: { ...item.position, x: 1579 } } : item) });
    const crowded = await getAgentTool('canvas_connect_nodes')!.execute(context(), { sourceId: 'src', targetId: 'dst' });
    expect(JSON.parse(crowded.modelContent).layout.warning).toContain('80');
  });

  it('runs matched nodes serially and skips ones already generating', async () => {
    useAppStore.setState({
      nodes: [
        node('n1', { displayId: 1, status: 'loading' }),
        node('n2', { displayId: 2 }),
      ],
    });
    const definition = getAgentTool('canvas_run_nodes')!;

    expect(definition.effect).toBe('media_generation');
    const result = await definition.execute(context(), { nodeIds: ['n1', 'n2'] });
    const payload = JSON.parse(result.modelContent);

    expect(executeGeneration).toHaveBeenCalledTimes(1);
    expect(executeGeneration).toHaveBeenCalledWith('n2');
    expect(payload.results).toEqual([
      { nodeId: 'n1', status: 'skipped', message: '节点正在生成中' },
      { nodeId: 'n2', status: 'success', message: undefined },
    ]);
  });

  it('caps how many nodes one run call may generate', async () => {
    useAppStore.setState({
      nodes: Array.from({ length: 6 }, (_, index) => node(`n${index}`, { displayId: index + 1 })),
    });

    const result = await getAgentTool('canvas_run_nodes')!.execute(context(), {
      nodeType: 'ai-image',
    });

    expect(result.status).toBe('error');
    expect(executeGeneration).not.toHaveBeenCalled();
  });
});
