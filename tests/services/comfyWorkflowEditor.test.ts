import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '../../src/types';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), missing: vi.fn(), nextId: 0 }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({}) }, generateId: () => `test-${++mocks.nextId}` }));
vi.mock('../../src/services/comfyWorkflowService', () => ({ findMissingNodeClasses: mocks.missing }));
import { openComfyUIWorkflowEditor } from '../../src/services/comfyUIWindowService';

const workflow: WorkflowDefinition = {
  id: 'wf-1', name: '测试工作流', category: 'ai-image', fileName: 'test.json',
  fileContent: JSON.stringify({ '1': { class_type: 'SaveImage', inputs: {} } }), createdAt: 1, updatedAt: 1,
};
const ready = (requestId: string) => ({ requestId, nodeCount: 4, source: 'editable', detail: '已载入编辑布局' });

beforeEach(() => {
  mocks.invoke.mockReset().mockImplementation(async (_command, args: { requestId: string }) => ready(args.requestId));
  mocks.missing.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe('ComfyUI 编辑器打开服务', () => {
  it('发送请求 ID，等待同请求非空画布回执，并返回缺失节点提示', async () => {
    mocks.missing.mockResolvedValue(['MissingNode']);
    const stage = vi.fn();
    const result = await openComfyUIWorkflowEditor('http://127.0.0.1:8188', workflow, stage);
    expect(stage.mock.calls).toEqual([['checking'], ['opening']]);
    expect(result).toMatchObject({ nodeCount: 4, missingNodeClasses: ['MissingNode'], source: 'editable' });
    expect(mocks.invoke).toHaveBeenCalledWith('open_comfyui_window', expect.objectContaining({ requestId: result.requestId, apiJson: workflow.fileContent }));
  });

  it.each([undefined, { requestId: 'old', nodeCount: 4, source: 'editable', detail: '旧结果' }])('拒绝无效或旧请求回执', async (result) => {
    mocks.invoke.mockResolvedValue(result);
    await expect(openComfyUIWorkflowEditor('http://127.0.0.1:8188', workflow)).rejects.toThrow('载入回执');
  });

  it('零节点不能作为成功回执', async () => {
    mocks.invoke.mockImplementation(async (_command, args: { requestId: string }) => ({ ...ready(args.requestId), nodeCount: 0 }));
    await expect(openComfyUIWorkflowEditor('http://127.0.0.1:8188', workflow)).rejects.toThrow('载入回执');
  });

  it('同工作流双击合并，另一个工作流不会挤掉在途请求', async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((_command, args: { requestId: string }) => new Promise((resolve) => { finish = () => resolve(ready(args.requestId)); }));
    const first = openComfyUIWorkflowEditor('http://127.0.0.1:8188', workflow);
    const duplicate = openComfyUIWorkflowEditor('http://127.0.0.1:8188', workflow);
    expect(first).toBe(duplicate);
    await expect(openComfyUIWorkflowEditor('http://127.0.0.1:8188', { ...workflow, id: 'wf-2' })).rejects.toThrow('另一个');
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    finish(undefined);
    await first;
  });

  it('载入失败后释放在途状态，重试使用新的请求 ID', async () => {
    mocks.invoke.mockRejectedValueOnce('插件载入失败');
    await expect(openComfyUIWorkflowEditor('http://127.0.0.1:8188', workflow)).rejects.toBe('插件载入失败');
    await openComfyUIWorkflowEditor('http://127.0.0.1:8188', workflow);
    expect(mocks.invoke.mock.calls[0][1].requestId).not.toBe(mocks.invoke.mock.calls[1][1].requestId);
  });

  it('缺节点探测卡住时四秒后仍开始开窗', async () => {
    vi.useFakeTimers();
    mocks.missing.mockImplementation(() => new Promise(() => undefined));
    const opening = openComfyUIWorkflowEditor('http://127.0.0.1:8188', workflow);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await opening).nodeCount).toBe(4);
  });

  it.each(['{}', '{broken', '{"nodes":[]}'])('无效 API 工作流在开窗前拒绝：%s', async (fileContent) => {
    await expect(openComfyUIWorkflowEditor('http://127.0.0.1:8188', { ...workflow, fileContent })).rejects.toThrow(/JSON|API/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
