import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { prepareShotlistProduction } from '../../src/services/shotlistProductionService';
import { clearAgentToolRegistryForTests, getAgentTool, getAvailableAgentTools, prepareAgentToolCall, type AgentToolContext } from '../../src/services/chat/toolRegistry';
import { registerShotlistAgentTools } from '../../src/services/chat/tools/shotlistTools';
import { searchMcpToolCatalog } from '../../src/services/mcp/mcpToolCatalog';

const scope = () => ({ projectId: 'ep', baseRevision: useAppStore.getState().getCurrentRevision() });
const context = (): AgentToolContext => ({ ...scope(), conversationId: 'mcp-control-ep', taskId: '', mode: 'autonomous', signal: new AbortController().signal });
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'ep', projectLoadStatus: 'ready', showToast: vi.fn(),
    projects: [{ id: 'ep', name: '集', createdAt: 1, updatedAt: 1, settings: { defaultModels: { audio: 'general/tts', video: 'general/video' } } }],
    nodes: [{ id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: { type: 'ai-shotlist', label: '镜头', shotlistRows: [
      { id: 'r1', shotNo: '1', content: '林夏站在月台', dialogue: '终于等到你了', camera: '推近', duration: 4,
        frame: { nodeId: 'frame', kind: 'image', url: 'PRIVATE_URL', filePath: 'PRIVATE_PATH' } },
      { id: 'r2', shotNo: '2', content: '列车驶入' },
    ] } }, { id: 'frame', type: 'source-image', position: { x: -300, y: 0 }, data: { type: 'source-image', label: '参考画面', imageUrl: 'PRIVATE_URL' } }],
  });
  clearAgentToolRegistryForTests();
  registerShotlistAgentTools();
});

describe('镜头制作准备', () => {
  it('配音只放对白和语音用途，一次历史，重复定位保留人工修改', () => {
    const commit = vi.fn(useAppStore.getState().commitToHistory);
    useAppStore.setState({ commitToHistory: commit });
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'voiceover');
    const node = useAppStore.getState().nodes.find((item) => item.id === result.nodeId)!;
    expect(node.data).toMatchObject({ type: 'ai-audio', status: 'idle', prompt: '终于等到你了', audioPurpose: 'speech', model: 'general/tts',
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'r1', kind: 'voiceover' } });
    expect(commit).toHaveBeenCalledTimes(1);
    useAppStore.getState().updateNodeDataTransient(node.id, { prompt: '人工对白' });
    expect(prepareShotlistProduction(scope(), 'sheet', ['r1'], 'voiceover')[0]).toMatchObject({ nodeId: node.id, status: 'reused' });
    expect(useAppStore.getState().nodes.find((item) => item.id === node.id)!.data.prompt).toBe('人工对白');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('视频引用真实画面节点，不把快照路径复制进提示词', () => {
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'video');
    const state = useAppStore.getState();
    const node = state.nodes.find((item) => item.id === result.nodeId)!;
    expect(node.data.prompt).toContain('推近，林夏站在月台');
    expect(node.data.prompt).toContain('@{frame:参考画面}');
    expect(node.data.prompt).not.toContain('PRIVATE_');
    expect(state.edges).toContainEqual(expect.objectContaining({ source: 'frame', target: node.id }));
    expect(node.data.model).toBe('general/video');
  });

  it('导演台带独立镜头说明且位置不重叠，不伪造场景或成果', async () => {
    const before = structuredClone(useAppStore.getState().nodes);
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'director');
    const state = useAppStore.getState();
    const director = state.nodes.find((item) => item.id === result.nodeId)!;
    const brief = state.nodes.find((item) => item.type === 'source-text')!;
    expect(brief.data.output).toContain('林夏站在月台');
    expect(brief.position.x + 320).toBeLessThan(director.position.x);
    expect(director.data.directorScene).toBeUndefined();
    expect(director.data.directorResultManifest).toBeUndefined();
    expect(director.data.directorStatus).toBe('idle');
    expect(state.edges).toContainEqual(expect.objectContaining({ source: brief.id, target: director.id }));
    await state.undo();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(before.map((item) => item.id));
    await useAppStore.getState().redo();
    expect(useAppStore.getState().nodes.find((item) => item.id === director.id)!.data.shotlistProductionSource?.rowId).toBe('r1');
  });

  it('无对白、重复 ID、已删镜头和跨项目全部拒绝且不留下部分节点', () => {
    const before = useAppStore.getState().nodes;
    for (const ids of [['r1', 'r2'], ['r1', 'r1'], ['r1', 'missing'], []]) {
      expect(() => prepareShotlistProduction(scope(), 'sheet', ids, 'voiceover')).toThrow();
      expect(useAppStore.getState().nodes).toBe(before);
    }
    expect(() => prepareShotlistProduction({ projectId: 'other' }, 'sheet', ['r1'], 'video')).toThrow();
    expect(() => prepareShotlistProduction({ ...scope(), baseRevision: -1 }, 'sheet', ['r1'], 'video')).toThrow();
  });

  it('同镜头存在多个同类制作节点时不猜测或覆盖', () => {
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'video');
    const node = useAppStore.getState().nodes.find((item) => item.id === result.nodeId)!;
    useAppStore.getState().addNode({ ...structuredClone(node), id: 'duplicate' });
    const count = useAppStore.getState().nodes.length;
    expect(() => prepareShotlistProduction(scope(), 'sheet', ['r1'], 'video')).toThrow('多个制作节点');
    expect(useAppStore.getState().nodes).toHaveLength(count);
  });

  it('助手与 MCP 发现和调用同一画布写工具；Plan 不开放，读取可追溯节点', async () => {
    const tool = getAgentTool('shotlist_prepare_production')!;
    expect(tool.effect).toBe('canvas_write');
    expect(getAvailableAgentTools({ ...context(), mode: 'plan' }).map((item) => item.id)).not.toContain(tool.id);
    expect(searchMcpToolCatalog(context(), { query: 'shotlist_prepare_production', category: 'shotlist' }).tools.map((item) => item.name)).toContain(tool.id);
    expect(prepareAgentToolCall({ callId: 'bad', toolId: tool.id, input: { nodeId: 'sheet', rowIds: ['r1'], kind: 'arbitrary' } }, context()).ok).toBe(false);
    expect((await tool.execute({ ...context(), baseRevision: -1 }, { nodeId: 'sheet', rowIds: ['r1'], kind: 'video' })).status).toBe('error');
    expect((await tool.execute(context(), { nodeId: 'sheet', rowIds: ['r1'], kind: 'voiceover' })).status).toBe('success');
    const read = await getAgentTool('shotlist_read')!.execute(context(), { nodeId: 'sheet' });
    expect(JSON.parse(read.modelContent).rows[0].productionNodes[0]).toMatchObject({ kind: 'voiceover', status: 'idle' });
    expect(read.modelContent).not.toContain('PRIVATE_');
  });
});
