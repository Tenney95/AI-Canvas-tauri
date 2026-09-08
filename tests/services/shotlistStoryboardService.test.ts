import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ crop: vi.fn(), save: vi.fn(), tauri: vi.fn() }));
vi.mock('../../src/components/nodes/shared/image/imageUtils', async (original) => ({ ...await original<object>(), cropImageByRanges: mocks.crop }));
vi.mock('../../src/services/fileService', async (original) => ({ ...await original<object>(), saveDataUrlToProjectData: mocks.save, isTauriEnv: mocks.tauri }));
import { useAppStore } from '../../src/store/useAppStore';
import { bindStoryboardCellToShot, describeStoryboardGrid } from '../../src/services/shotlistStoryboardService';
import { clearAgentToolRegistryForTests, getAgentTool, getAvailableAgentTools, prepareAgentToolCall, type AgentToolContext } from '../../src/services/chat/toolRegistry';
import { registerShotlistAgentTools } from '../../src/services/chat/tools/shotlistTools';
const input = () => ({ projectId: 'ep', baseRevision: useAppStore.getState().getCurrentRevision(), nodeId: 'sheet', rowId: 'r1', storyboardId: 'grid', cellIndex: 1 });
beforeEach(() => {
  mocks.crop.mockReset().mockResolvedValue({ dataUrl: 'data:image/png;base64,crop', width: 30, height: 20 });
  mocks.save.mockReset().mockResolvedValue({ filePath: 'PRIVATE_PATH', assetUrl: 'asset://crop.png' });
  mocks.tauri.mockReset().mockReturnValue(true);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'ep', projectLoadStatus: 'ready', showToast: vi.fn(), nodes: [
    { id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: { type: 'ai-shotlist', label: '表', shotlistRows: [
      { id: 'r1', shotNo: '1', content: '甲', frame: null }, { id: 'r2', shotNo: '2', content: '乙' },
    ] } },
    { id: 'grid', type: 'ai-storyboard', position: { x: 0, y: 600 }, data: { type: 'ai-storyboard', label: '宫格', imageUrl: 'grid.png', storyboardRows: 2, storyboardCols: 2 } },
  ] });
});

describe('宫格绑定指定镜头', () => {
  it('裁切、保存、真实节点和绑定一次历史完成，原宫格不变，可撤销', async () => {
    const before = structuredClone(useAppStore.getState().nodes);
    const commit = vi.fn(useAppStore.getState().commitToHistory);
    useAppStore.setState({ commitToHistory: commit });
    const result = await bindStoryboardCellToShot(input());
    expect(mocks.crop).toHaveBeenCalledWith('grid.png', [0, 50, 100], [0, 50, 100], 0, 1);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const state = useAppStore.getState();
    expect(state.nodes.find((node) => node.id === 'grid')).toEqual(before[1]);
    expect(state.nodes[0].data.shotlistRows?.[0].frame).toMatchObject({ nodeId: result.nodeId, url: 'asset://crop.png' });
    expect(state.nodes.find((node) => node.id === result.nodeId)!.data.imageWidth).toBe(30);
    expect(commit).toHaveBeenCalledTimes(1);
    await state.undo();
    expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0].frame).toBeNull();
    expect(useAppStore.getState().nodes).toHaveLength(2);
  });

  it('自定义分割线和覆盖图按实际范围处理，空格不复活', async () => {
    useAppStore.getState().updateNodeDataTransient('grid', { storyboardRowPositions: [30], storyboardColPositions: [70] });
    await bindStoryboardCellToShot(input());
    expect(mocks.crop).toHaveBeenLastCalledWith('grid.png', [0, 30, 100], [0, 70, 100], 0, 1);
    useAppStore.getState().updateNodeDataTransient('grid', { storyboardExtracted: [false, true], storyboardOverrides: [null, { url: 'override.png' }] });
    await bindStoryboardCellToShot({ ...input(), replaceExisting: true });
    expect(mocks.crop).toHaveBeenLastCalledWith('override.png', [0, 100], [0, 100], 0, 0);
    useAppStore.getState().updateNodeDataTransient('grid', { storyboardOverrides: [] });
    await expect(bindStoryboardCellToShot({ ...input(), replaceExisting: true })).rejects.toThrow('已为空');
  });

  it('无效网格和未确认替换拒绝，失败保留原画面', async () => {
    expect(() => describeStoryboardGrid({ type: 'ai-storyboard', label: '坏网格', storyboardCols: 2, storyboardColPositions: [80, 20] })).toThrow();
    await bindStoryboardCellToShot(input());
    const frame = useAppStore.getState().nodes[0].data.shotlistRows![0].frame;
    await expect(bindStoryboardCellToShot(input())).rejects.toThrow('明确选择替换');
    mocks.crop.mockRejectedValueOnce(new Error('PRIVATE_PATH and remote details'));
    await expect(bindStoryboardCellToShot({ ...input(), replaceExisting: true })).rejects.toThrow('宫格裁切失败');
    mocks.save.mockResolvedValueOnce(null);
    await expect(bindStoryboardCellToShot({ ...input(), replaceExisting: true })).rejects.toThrow('保存失败');
    expect(useAppStore.getState().nodes[0].data.shotlistRows![0].frame).toEqual(frame);
  });

  it('等待裁切时修改其他镜头不会被旧行数组覆盖', async () => {
    mocks.crop.mockImplementationOnce(async () => {
      const state = useAppStore.getState();
      state.updateNodeDataTransient('sheet', { shotlistRows: state.nodes[0].data.shotlistRows!.map((row) => row.id === 'r2' ? { ...row, content: '新乙' } : row) });
      return { dataUrl: 'crop', width: 30, height: 20 };
    });
    await bindStoryboardCellToShot(input());
    expect(useAppStore.getState().nodes[0].data.shotlistRows![1].content).toBe('新乙');
  });

  it.each(['project', 'source', 'row'])('等待期间 %s 变化拒绝回填', async (change) => {
    mocks.crop.mockImplementationOnce(async () => {
      const state = useAppStore.getState();
      if (change === 'project') useAppStore.setState({ currentProjectId: 'other' });
      if (change === 'source') state.updateNodeDataTransient('grid', { imageUrl: 'new.png' });
      if (change === 'row') state.updateNodeDataTransient('sheet', { shotlistRows: [{ id: 'r1', shotNo: '1', content: '新甲' }] });
      return { dataUrl: 'crop', width: 30, height: 20 };
    });
    await expect(bindStoryboardCellToShot(input())).rejects.toThrow('已变化');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes).toHaveLength(2);
  });

  it('取消不等待未返回的裁切，也不落盘或写节点', async () => {
    mocks.crop.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = bindStoryboardCellToShot({ ...input(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('已取消');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes).toHaveLength(2);
  });

  it('Registry/Policy 保持画布写边界，MCP 输出只给 ID', async () => {
    clearAgentToolRegistryForTests(); registerShotlistAgentTools();
    const context: AgentToolContext = { ...input(), conversationId: 'mcp-control-ep', taskId: '', mode: 'autonomous', signal: new AbortController().signal };
    const tool = getAgentTool('shotlist_bind_storyboard_cell')!;
    expect(tool.effect).toBe('canvas_write');
    expect(getAvailableAgentTools({ ...context, mode: 'plan' }).map((item) => item.id)).not.toContain(tool.id);
    const args = { nodeId: 'sheet', rowId: 'r1', storyboardId: 'grid', cellIndex: 1 };
    expect(prepareAgentToolCall({ callId: 'bad', toolId: tool.id, input: { ...args, cellIndex: -1 } }, context).ok).toBe(false);
    const result = await tool.execute(context, args);
    expect(result.status).toBe('success');
    expect(result.modelContent).not.toMatch(/PRIVATE_PATH|asset:|data:/);
  });
});
