import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import {
  cancelNodePolling, cleanupNodePolling, getPendingTasksForProject, registerNodePolling,
  resumeComfyUINodeTask, resumePendingTasks, savePendingTask,
} from '../../src/services/pollManager';
import {
  cancelComfyUINodeTask, executeComfyUIAudioGenerate, executeComfyUIGenerate, executeComfyUIVideoGenerate,
} from '../../src/services/comfyWorkflowService';
import { ComfyPendingError, pollComfyHistory } from '../../src/services/comfyPolling';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), history: vi.fn(), cancel: vi.fn(), persist: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));
vi.mock('../../src/services/fileService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fileService')>(),
  persistMediaUrlToProjectData: mocks.persist,
}));
vi.mock('../../src/services/comfyProgress', () => ({ createComfyProgressSession: () => ({
  clientId: 'test-client', requestId: 'test-request', waitUntilReady: async () => {}, bindPrompt: () => {}, close: () => {},
}) }));

const task = {
  nodeId: 'n1', projectId: 'p1', nodeType: 'ai-image', provider: 'comfyui',
  taskId: 'prompt-1', taskType: 'comfyui', baseUrl: 'http://comfy.test:8188', submitted: true,
} as const;
const params = { nodeId: 'n1', prompt: 'cat', model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'wf-1' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completed = () => json({ 'prompt-1': { status: { completed: true }, outputs: { '9': { images: [{ filename: 'out.png' }] } } } });
const pending = () => getPendingTasksForProject('p1');
const promptCalls = () => mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/prompt'));

beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'p1',
    config: { ...useAppStore.getState().config, comfyUIUrl: task.baseUrl },
    nodes: [{ id: 'n1', type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'test', provider: 'comfyui', status: 'loading' } }],
    workflows: [{ id: 'wf-1', name: 'test', category: 'ai-image', createdAt: 1, fileName: 'test.json', fileContent: JSON.stringify({ '9': { class_type: 'SaveImage', inputs: {} } }) }],
  });
  mocks.history.mockReset().mockResolvedValue(completed());
  mocks.cancel.mockReset().mockResolvedValue(json({ cancelled: true }));
  mocks.persist.mockReset().mockImplementation(async (url: string) => ({ mediaUrl: url, sourceUrl: url }));
  mocks.fetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/prompt')) return json({ prompt_id: 'prompt-1' });
    if (url.includes('/history/')) return mocks.history(url, init);
    if (url.includes('/api/jobs/')) return mocks.cancel(url, init);
    if (url.includes('/object_info')) return json({});
    if (url.endsWith('/queue')) return json({ queue_running: [], queue_pending: [] });
    throw new Error(`Unexpected test request: ${url}`);
  });
});

afterEach(() => {
  cancelNodePolling('n1');
  vi.useRealTimers();
});

describe('ComfyUI 任务恢复合同', () => {
  it.each([
    ['图片', () => executeComfyUIGenerate(params)],
    ['视频', () => executeComfyUIVideoGenerate(params)],
    ['音频', () => executeComfyUIAudioGenerate(params)],
  ] as const)('%s 查询中断保留任务，继续查询不再次生成', async (_kind, generate) => {
    mocks.history.mockRejectedValue(new TypeError('network unavailable'));
    const result = expect(generate()).rejects.toBeInstanceOf(ComfyPendingError);
    await vi.waitFor(() => expect(pending()[0]?.submitted).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', comfyRecoveryState: 'disconnected' });
    await expect(executeComfyUIGenerate(params)).rejects.toThrow('未确认结束');
    mocks.history.mockResolvedValue(completed());
    await resumeComfyUINodeTask('n1');
    expect(promptCalls()).toHaveLength(1);
    expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
  });

  it('取消请求失败时，原轮询退出不会清理任务；可再次终止', async () => {
    mocks.history.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    mocks.cancel.mockResolvedValue(json({}, 503));
    const running = expect(executeComfyUIGenerate(params)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.history).toHaveBeenCalled());
    await expect(cancelComfyUINodeTask('n1')).rejects.toThrow('503');
    await running;
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', comfyRecoveryState: 'cancel_pending' });
    mocks.cancel.mockResolvedValue(json({ cancelled: true }));
    await cancelComfyUINodeTask('n1');
    expect(pending()).toEqual([]);
    expect(promptCalls()).toHaveLength(1);
  });

  it('重开项目保留取消未确认状态，不自动提交或再次取消', async () => {
    savePendingTask({ ...task, comfyRecoveryState: 'cancel_pending' });
    await resumePendingTasks('p1');
    expect(pending()[0].comfyRecoveryState).toBe('cancel_pending');
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'error', error: expect.stringContaining('取消尚未确认') });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('重开项目能恢复断线错误节点，已结束任务正常清理', async () => {
    savePendingTask({ ...task, comfyRecoveryState: 'disconnected' });
    useAppStore.getState().updateNodeDataTransient('n1', { status: 'error', error: '连接中断' });
    await resumePendingTasks('p1');
    await vi.waitFor(() => expect(pending()).toEqual([]));
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
    expect(promptCalls()).toHaveLength(0);
  });

  it('明确执行失败应清理记录，不标记为连接中断', async () => {
    mocks.history.mockResolvedValue(json({ 'prompt-1': { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'bad model' }]] } } }));
    await expect(executeComfyUIGenerate(params)).rejects.toThrow('bad model');
    expect(pending()).toEqual([]);
  });

  it('确认队列与历史都不存在时清理任务', async () => {
    mocks.history.mockImplementation(async () => json({}));
    const result = expect(executeComfyUIGenerate(params)).rejects.toThrow('找不到该任务');
    await vi.waitFor(() => expect(mocks.history).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(9_000);
    await result;
    expect(pending()).toEqual([]);
  });

  it('查询一小时到期是可恢复状态，不宣称远端失败', async () => {
    mocks.history.mockImplementation(async () => json({ 'prompt-1': {} }));
    const result = expect(pollComfyHistory(task.baseUrl, task.taskId, 'test-timeout', () => null)).rejects.toBeInstanceOf(ComfyPendingError);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await result;
  });

  it('旧控制器清理和延迟取消回执不能删除新任务', async () => {
    const oldSignal = registerNodePolling('n1');
    const newSignal = registerNodePolling('n1');
    expect(oldSignal.aborted).toBe(true);
    expect(cleanupNodePolling('n1', oldSignal)).toBe(false);
    savePendingTask(task);
    let finishCancel!: (response: Response) => void;
    mocks.cancel.mockImplementation(() => new Promise<Response>((resolve) => { finishCancel = resolve; }));
    const cancel = cancelComfyUINodeTask('n1');
    savePendingTask({ ...task, taskId: 'prompt-new' });
    finishCancel(json({ cancelled: true }));
    await cancel;
    expect(newSignal.aborted).toBe(true);
    expect(pending()[0].taskId).toBe('prompt-new');
  });

  it('下载期间切换项目不回写画布，原项目任务仍可恢复', async () => {
    savePendingTask({ ...task, comfyRecoveryState: 'disconnected' });
    mocks.persist.mockImplementation(async (url: string) => {
      useAppStore.setState({ currentProjectId: 'p2' });
      return { mediaUrl: url, sourceUrl: url };
    });
    await resumeComfyUINodeTask('n1');
    expect(useAppStore.getState().nodes[0].data.status).toBe('loading');
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBeUndefined();
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', comfyRecoveryState: 'disconnected' });
  });

  it('取消后迟到的 history 成功响应不能作为成功结果返回', async () => {
    const controller = new AbortController();
    mocks.history.mockImplementation(async () => {
      controller.abort();
      return completed();
    });
    await expect(pollComfyHistory(task.baseUrl, task.taskId, 'timeout', () => ({ url: 'out' }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
