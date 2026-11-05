/** 长节点文字的有界读取与提示词片段修改回归。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../../src/types';
import { emptyDramaAssetLibrary, type DramaAsset } from '../../../src/types/dramaAssets';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerCanvasAgentTools } from '../../../src/services/chat/tools/canvasTools';
import { validateAgentToolInput } from '../../../src/services/chat/agentToolSchemas';
import { clearAgentToolRegistryForTests, getAgentTool, type AgentToolContext } from '../../../src/services/chat/toolRegistry';

const loadGlobalAssets = vi.hoisted(() => vi.fn<() => Promise<DramaAsset[]>>());
vi.mock('../../../src/services/generationService', () => ({ executeGeneration: vi.fn() }));
vi.mock('../../../src/services/globalDramaAssetService', () => ({ loadGlobalDramaAssetCards: loadGlobalAssets }));
vi.mock('../../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../../src/services/fileService')>(), isTauriEnv: () => false,
}));

function node(id: string, data: Partial<BaseNodeData> = {}): Node<BaseNodeData> {
  return { id, type: data.type ?? 'ai-video', position: { x: 0, y: 0 },
    data: { type: data.type ?? 'ai-video', label: id, status: 'idle', ...data } };
}

function context(): AgentToolContext {
  return { taskId: 'prompt-task', projectId: 'p1', conversationId: 'mcp-control-p1', mode: 'autonomous',
    baseRevision: useAppStore.getState().getCurrentRevision(), signal: new AbortController().signal };
}

function setPrompt(prompt: string) {
  useAppStore.setState({ nodes: [node('target', { displayId: 1, prompt })] });
}

function installReference() {
  const scene: DramaAsset = { id: 'scene-one', kind: 'scene', name: '街道', key: 'street', summary: '', visualNotes: '',
    importance: 'main', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1, imageUrl: 'https://example.test/ref.png' };
  const state = useAppStore.getState();
  useAppStore.setState({ nodes: [...state.nodes, node('ref', { type: 'source-image', imageUrl: scene.imageUrl })],
    dramaAssets: { ...emptyDramaAssetLibrary(), scenes: [scene] } });
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearAgentToolRegistryForTests();
  loadGlobalAssets.mockReset().mockResolvedValue([]);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p1', projectLoadStatus: 'ready', showToast: vi.fn(), nodes: [], edges: [] });
  registerCanvasAgentTools();
});

describe('长节点文字读取', () => {
  it('按 UTF-16 偏移完整续读当前提示词并保留空白，默认详情仍只给 400 字摘要', async () => {
    const prompt = ` \n开场😀${'镜头说明。'.repeat(1800)}结尾哨兵\r\n\t `;
    setPrompt(prompt);
    const query = getAgentTool('canvas_query')!;
    const detail = JSON.parse((await query.execute(context(), { nodeIds: ['target'], detail: true })).modelContent);
    expect(detail.nodes[0].prompt.truncated).toBe(true);
    expect(detail.nodes[0].prompt.text).toHaveLength(400);
    const revision = useAppStore.getState().getCurrentRevision();
    let restored = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await query.execute(context(), { nodeIds: ['target'], textField: 'prompt', textOffset: offset, textLimit: 4000 });
      expect(result.status).toBe('success');
      const page = JSON.parse(result.modelContent);
      expect(page).toMatchObject({ projectId: 'p1', nodeId: 'target', textField: 'prompt', offset, totalLength: prompt.length, revision });
      expect(page.text.length).toBeLessThanOrEqual(4000);
      expect(page.text).toBe(prompt.slice(offset, offset + page.text.length));
      expect(page).not.toHaveProperty('nodes');
      expect(page.nextOffset).toBe(offset + page.text.length < prompt.length ? offset + page.text.length : null);
      restored += page.text;
      offset = page.nextOffset;
    }
    expect(restored).toBe(prompt);
    const utf16 = JSON.parse((await query.execute(context(), { displayIds: [1], textField: 'prompt', textOffset: 4, textLimit: 2 })).modelContent);
    expect(utf16.text).toBe('😀');
    const boundary = JSON.parse((await query.execute(context(), { nodeIds: ['target'], textField: 'prompt', textOffset: 3, textLimit: 2 })).modelContent);
    expect(boundary).toMatchObject({ text: '场', nextOffset: 4 });
    expect((await query.execute(context(), { nodeIds: ['target'], textField: 'prompt', textOffset: 5 })).status).toBe('error');
    expect((await query.execute(context(), { nodeIds: ['target'], textField: 'prompt', textOffset: 4, textLimit: 1 })).status).toBe('error');
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
  });

  it('按完整 JSON 预算缩小转义字符片段并用实际步长续读', async () => {
    const prompt = `${'\u0001'.repeat(4000)}末尾😀`;
    setPrompt(prompt);
    const query = getAgentTool('canvas_query')!;
    let restored = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await query.execute(context(), { nodeIds: ['target'], textField: 'prompt', textOffset: offset, textLimit: 4000 });
      expect(result.status).toBe('success');
      expect(result.modelContent.length).toBeLessThanOrEqual(18_000);
      const page = JSON.parse(result.modelContent);
      expect(page.text.length).toBeGreaterThan(0);
      expect(page.text).toBe(prompt.slice(offset, offset + page.text.length));
      restored += page.text;
      offset = page.nextOffset;
    }
    expect(restored).toBe(prompt);
  });

  it('仅允许显式唯一节点，文本 output 可读而媒体 output 不泄漏路径', async () => {
    useAppStore.setState({ nodes: [node('video', { displayId: 1, output: 'PRIVATE_MEDIA_PATH', prompt: '视频提示词' }),
      node('text', { displayId: 2, type: 'source-text', output: '  正文😀\n结尾  ' })] });
    const query = getAgentTool('canvas_query')!;
    for (const target of [{}, { nodeType: 'source-text' }, { nodeIds: ['video', 'text'] }, { nodeIds: ['missing'] }]) {
      expect((await query.execute(context(), { ...target, textField: 'prompt' })).status).toBe('error');
    }
    const media = await query.execute(context(), { nodeIds: ['video'], textField: 'output' });
    expect(media.status).toBe('error');
    expect(media.modelContent + media.summary).not.toContain('PRIVATE_MEDIA_PATH');
    const text = JSON.parse((await query.execute(context(), { displayIds: [2], textField: 'output' })).modelContent);
    expect(text).toMatchObject({ nodeId: 'text', textField: 'output', text: '  正文😀\n结尾  ', offset: 0, nextOffset: null });
    const empty = JSON.parse((await query.execute(context(), { nodeIds: ['text'], textField: 'prompt' })).modelContent);
    expect(empty).toMatchObject({ text: '', totalLength: 0, nextOffset: null });
  });

  it('长文字读取参数限制整数偏移、字段枚举及每段上限', () => {
    const schema = getAgentTool('canvas_query')!.inputSchema;
    const input = { nodeIds: ['target'], textField: 'prompt' };
    for (const extra of [{ textField: 'filePath' }, { textOffset: -1 }, { textOffset: 0.5 }, { textLimit: 0 }, { textLimit: 4001 }]) {
      expect(validateAgentToolInput(schema, { ...input, ...extra }).valid).toBe(false);
    }
    expect(validateAgentToolInput(schema, { ...input, textOffset: 0, textLimit: 4000 }).valid).toBe(true);
  });

  it('已取消的长文字读取与片段写入不返回原文或改变节点', async () => {
    setPrompt('不应读取或修改的原文');
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const controller = new AbortController();
    controller.abort();
    const cancelled = { ...context(), signal: controller.signal };
    await expect(getAgentTool('canvas_query')!.execute(cancelled, { nodeIds: ['target'], textField: 'prompt' }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(getAgentTool('canvas_update_nodes')!.execute(cancelled, {
      nodeIds: ['target'], promptEdit: { oldText: '原文', newText: '新稿' },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(useAppStore.getState().nodes).toBe(state.nodes);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
  });
});

describe('提示词片段修改', () => {
  it('只替换唯一原文，保留超过 8000 字的原稿、范围外引用和首尾空白', async () => {
    const before = ` \n${'前文。'.repeat(1600)}@{ref:旧节点引用}待修改的唯一句${'尾文。'.repeat(1600)}\r\n\t `;
    setPrompt(before);
    installReference();
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['target'], promptEdit: { oldText: '待修改的唯一句', newText: '修改后的句子' },
    });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes[0].data.prompt).toBe(before.replace('待修改的唯一句', '修改后的句子'));
    expect(useAppStore.getState().nodes[0].data.prompt).toContain('@{ref:旧节点引用}');
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    expect(useAppStore.getState().edges).toBe(state.edges);
  });

  it('MCP 仅将新片段的同图节点引用转换为库引用，不改范围外的原引用', async () => {
    const before = '  外部 @{ref:旧节点引用} 原词 结尾\n ';
    setPrompt(before);
    installReference();
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['target'], promptEdit: { oldText: '原词', newText: '新段 @{ref:新节点引用} ' },
    });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes[0].data.prompt).toBe('  外部 @{ref:旧节点引用} 新段 @drama{scene-one:街道}  结尾\n ');
  });

  it('多个目标各自保留原文，只提交一次历史和 revision', async () => {
    useAppStore.setState({ nodes: [node('a', { prompt: '  甲：旧词。' }), node('b', { prompt: '乙：旧词！\n' })] });
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['a', 'b'], promptEdit: { oldText: '旧词', newText: '新词' },
    });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.map((item) => item.data.prompt)).toEqual(['  甲：新词。', '乙：新词！\n']);
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
  });

  it.each(['完全不同文本', '旧词与旧词', 'aaa'])('任一目标原文不唯一（%s）时整批保持原样', async (secondPrompt) => {
    const oldText = secondPrompt === 'aaa' ? 'aa' : '旧词';
    useAppStore.setState({ nodes: [node('a', { prompt: `甲：${oldText}。` }), node('b', { prompt: secondPrompt })] });
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['a', 'b'], promptEdit: { oldText, newText: '新词' },
    });
    expect(result.status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(state.nodes);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    expect(commit).not.toHaveBeenCalled();
  });

  it('混传整段 prompt 或存在不适用的媒体参数时不写入任何目标', async () => {
    const update = getAgentTool('canvas_update_nodes')!;
    useAppStore.setState({ nodes: [node('video', { prompt: '旧词' }), node('image', { type: 'ai-image', prompt: '旧词' })] });
    for (const input of [
      { nodeIds: ['video'], prompt: '整段', promptEdit: { oldText: '旧词', newText: '新词' } },
      { nodeIds: ['video', 'image'], videoDuration: 3, promptEdit: { oldText: '旧词', newText: '新词' } },
    ]) {
      const state = useAppStore.getState();
      const revision = state.getCurrentRevision();
      expect((await update.execute(context(), input)).status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(state.nodes);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    }
  });

  it.each(['@{ref:图片}', '@asset{images/ref.png}', '@drama{scene-one:街道}'])('不拆开引用令牌 %s，允许完整删除', async (token) => {
    const update = getAgentTool('canvas_update_nodes')!;
    for (const oldText of [token.slice(1), token.slice(0, -1)]) {
      setPrompt(`前 ${token} 后`);
      const state = useAppStore.getState();
      const result = await update.execute(context(), { nodeIds: ['target'], promptEdit: { oldText, newText: '替换' } });
      expect(result.status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(state.nodes);
    }
    const result = await update.execute(context(), { nodeIds: ['target'], promptEdit: { oldText: token, newText: '' } });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes[0].data.prompt).toBe('前  后');
  });

  it('片段修改不能只替换 emoji 的一个代理项，完整字符可以替换', async () => {
    const update = getAgentTool('canvas_update_nodes')!;
    setPrompt('前😀后');
    const nodes = useAppStore.getState().nodes;
    for (const oldText of ['\uD83D', '\uDE00']) {
      expect((await update.execute(context(), { nodeIds: ['target'], promptEdit: { oldText, newText: '替换' } })).status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(nodes);
    }
    expect((await update.execute(context(), { nodeIds: ['target'], promptEdit: { oldText: '😀', newText: '😃' } })).status).toBe('success');
    expect(useAppStore.getState().nodes[0].data.prompt).toBe('前😃后');
  });

  it('片段 schema 限制非空旧文、长度与额外键，允许空新文', () => {
    const schema = getAgentTool('canvas_update_nodes')!.inputSchema;
    const input = { nodeIds: ['target'] };
    for (const promptEdit of [{ oldText: '', newText: '新' }, { oldText: '旧', newText: '新', unexpected: true },
      { oldText: '旧'.repeat(8001), newText: '' }, { oldText: '旧', newText: '新'.repeat(8001) }]) {
      expect(validateAgentToolInput(schema, { ...input, promptEdit }).valid).toBe(false);
    }
    expect(validateAgentToolInput(schema, { ...input, promptEdit: { oldText: '旧', newText: '' } }).valid).toBe(true);
  });
});
