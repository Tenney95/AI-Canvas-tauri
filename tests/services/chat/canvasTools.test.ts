import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerCanvasAgentTools } from '../../../src/services/chat/tools/canvasTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import type { BaseNodeData } from '../../../src/types';

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
      160, // 16:9 横构图算出 159，被 160 下限兜住
      600, // 30 行正文按行数撑高，封顶 600
      160, // 还没有正文的生成型文本节点保持默认
    ]);
    expect(created[0].data.aspectRatio).toBe('3:4');
    // 比例只对视觉节点有意义，文本节点不该被塞上 aspectRatio
    expect(created[2].data.aspectRatio).toBeUndefined();
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

  it('refuses to write content into media nodes whose output holds a path', async () => {
    const result = await getAgentTool('canvas_create_nodes')!.execute(context(), {
      nodes: [{ type: 'ai-image', label: '角色·林默', content: '不该写进图片节点' }],
    });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('content 只能用于文本类节点');
    expect(useAppStore.getState().nodes).toHaveLength(2);
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
    expect(payload.edges).toEqual([{ id: 'e1', source: 'n1', target: 'n2' }]);
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
