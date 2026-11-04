/**
 * comfyTaskRecovery — 回归测试：ComfyUI 任务恢复合同。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import {
  beginComfyNodeDelivery, cancelNodePolling, cleanupNodePolling, clearProjectTasks, completeComfyNodeTask, completeVideoNodeTask, getPendingTasksForProject,
  isComfyNodeDeliveryActive, subscribeComfyDeliveries,
  pauseComfyNodeDelivery, pauseVideoNodeTask, prepareVideoNodeGeneration, registerNodePolling, resumeComfyUINodeTask,
  resumeMediaNodeTask, resumePendingTasks, resumeVideoNodeTask, savePendingTask, VideoPollingPausedError,
} from '../../src/services/pollManager';
import {
  cancelComfyUINodeTask, executeComfyUIAudioGenerate, executeComfyUIGenerate, executeComfyUIVideoGenerate,
} from '../../src/services/comfyWorkflowService';
import { ComfyPendingError, ComfyQueryAuthorizationError, pollComfyHistory } from '../../src/services/comfyPolling';
import { MediaPersistenceError } from '../../src/services/fileService';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), history: vi.fn(), queue: vi.fn(), cancel: vi.fn(), persist: vi.fn() }));
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
const completedVideo = () => json({ 'prompt-1': { status: { completed: true }, outputs: {
  '9': { images: [{ filename: 'out.mp4', subfolder: 'video', type: 'output' }], animated: [true] },
} } });
const completedAudio = () => json({ 'prompt-1': { status: { completed: true }, outputs: {
  '9': { audio: [{ filename: 'out.flac', type: 'output' }] },
} } });
const pending = () => getPendingTasksForProject('p1');
const promptCalls = () => mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/prompt'));

function configureVideo() {
  useAppStore.setState({
    nodes: [{ id: 'n1', type: 'ai-video', position: { x: 0, y: 0 }, data: {
      type: 'ai-video', label: 'test', provider: 'comfyui', model: params.model, workflowId: params.workflowId,
      prompt: params.prompt, seedanceRatio: '9:16', status: 'loading',
    } }],
    workflows: [{ id: 'wf-1', name: 'test', category: 'ai-video', createdAt: 1, fileName: 'test.json',
      fileContent: JSON.stringify({ '9': { class_type: 'SaveVideo', inputs: {} } }),
    }],
  });
  mocks.history.mockImplementation(async () => completedVideo());
}

beforeEach(() => {
  // IndexedDB 用真实 setImmediate 推进事务，仅模拟轮询所用的时钟和计时器。
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'p1',
    config: { ...useAppStore.getState().config, comfyUIUrl: task.baseUrl },
    nodes: [{ id: 'n1', type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'test', provider: 'comfyui', status: 'loading' } }],
    workflows: [{ id: 'wf-1', name: 'test', category: 'ai-image', createdAt: 1, fileName: 'test.json', fileContent: JSON.stringify({ '9': { class_type: 'SaveImage', inputs: {} } }) }],
  });
  mocks.history.mockReset().mockResolvedValue(completed());
  mocks.queue.mockReset().mockImplementation(async () => json({ queue_running: [], queue_pending: [] }));
  mocks.cancel.mockReset().mockResolvedValue(json({ cancelled: true }));
  mocks.persist.mockReset().mockImplementation(async (url: string) => ({ mediaUrl: url, sourceUrl: url }));
  mocks.fetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/prompt')) return json({ prompt_id: 'prompt-1' });
    if (url.includes('/history/')) return mocks.history(url, init);
    if (url.includes('/api/jobs/')) return mocks.cancel(url, init);
    if (url.includes('/object_info')) return json({});
    if (url.endsWith('/queue')) return mocks.queue(url, init);
    throw new Error(`Unexpected test request: ${url}`);
  });
});

afterEach(() => {
  cancelNodePolling('n1');
  clearProjectTasks('p1');
  vi.useRealTimers();
});

describe('ComfyUI 任务恢复合同', () => {
  it.each(['ai-image', 'ai-audio'] as const)('%s 远端完成先保留原任务，调用方交付后才清理', async (nodeType) => {
    useAppStore.getState().updateNodeDataTransient('n1', { type: nodeType });
    const result = await (nodeType === 'ai-audio' ? executeComfyUIAudioGenerate(params) : executeComfyUIGenerate(params));
    expect(result.comfyTaskId).toBe('prompt-1');
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', comfyRecoveryState: 'save_pending' });
    await expect(executeComfyUIGenerate(params)).rejects.toThrow('未交付');
    expect(promptCalls()).toHaveLength(1);
    completeComfyNodeTask('n1', 'old-prompt');
    expect(pending()).toHaveLength(1);
    useAppStore.getState().updateNodeDataTransient('n1', { status: 'success' });
    completeComfyNodeTask('n1', result.comfyTaskId);
    expect(pending()).toEqual([]);
  });

  it.each(['ai-image', 'ai-audio'] as const)('%s 下载失败及重新进入保留原 promptId，续取不重新提交', async (nodeType) => {
    useAppStore.getState().updateNodeDataTransient('n1', { type: nodeType });
    mocks.history.mockImplementation(async () => completed());
    await (nodeType === 'ai-audio' ? executeComfyUIAudioGenerate(params) : executeComfyUIGenerate(params));
    mocks.persist.mockRejectedValueOnce(new Error('/private/output?token=secret'));
    await resumeComfyUINodeTask('n1');
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', comfyRecoveryState: 'save_pending' });
    expect(useAppStore.getState().nodes[0].data.error).toContain('保存或回填尚未完成');
    expect(JSON.stringify(pending())).not.toMatch(/private|secret/);
    const calls = mocks.history.mock.calls.length;
    await resumePendingTasks('p1');
    expect(mocks.history).toHaveBeenCalledTimes(calls);
    expect(pending()).toHaveLength(1);
    await resumeComfyUINodeTask('n1');
    expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
    expect(promptCalls()).toHaveLength(1);
  });

  it('旧交付回执既不清除新任务，也不改写已失效画布的状态', () => {
    savePendingTask({ ...task, comfyRecoveryState: 'save_pending' });
    useAppStore.getState().updateNodeDataTransient('n1', { status: 'idle', imageUrl: 'asset://new.png' });
    pauseComfyNodeDelivery('n1', task.taskId, () => false);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', imageUrl: 'asset://new.png' });
    savePendingTask({ ...task, taskId: 'new-prompt', comfyRecoveryState: 'save_pending' });
    completeComfyNodeTask('n1', task.taskId);
    pauseComfyNodeDelivery('n1', task.taskId, () => true);
    expect(pending()[0].taskId).toBe('new-prompt');
    expect(useAppStore.getState().nodes[0].data.status).toBe('idle');
  });

  it('真实落盘期间禁止重入，过期交付结束后释放续取入口而不改写节点', async () => {
    savePendingTask({ ...task, comfyRecoveryState: 'save_pending' });
    const changed = vi.fn();
    const unsubscribe = subscribeComfyDeliveries(changed);
    beginComfyNodeDelivery('n1', task.taskId);
    expect(isComfyNodeDeliveryActive('p1', 'n1')).toBe(true);
    expect(isComfyNodeDeliveryActive('p2', 'n1')).toBe(false);
    await resumeComfyUINodeTask('n1');
    expect(mocks.history).not.toHaveBeenCalled();
    pauseComfyNodeDelivery('n1', task.taskId, () => false);
    expect(isComfyNodeDeliveryActive('p1', 'n1')).toBe(false);
    expect(pending()[0].comfyRecoveryState).toBe('save_pending');
    expect(useAppStore.getState().nodes[0].data.status).toBe('loading');
    expect(changed).toHaveBeenCalledTimes(2);
    beginComfyNodeDelivery('n1', task.taskId);
    clearProjectTasks('p1');
    expect(isComfyNodeDeliveryActive('p1', 'n1')).toBe(false);
    unsubscribe();
  });

  it('恢复查询期间画布 revision 改变，迟到结果不能被当作新节点的产物', async () => {
    savePendingTask({ ...task, comfyRecoveryState: 'save_pending' });
    mocks.history.mockImplementationOnce(async () => {
      useAppStore.getState().setCanvasRevision(useAppStore.getState().getCurrentRevision() + 1);
      return completed();
    });
    await resumeComfyUINodeTask('n1');
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBeUndefined();
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', comfyRecoveryState: 'save_pending' });
  });

  it.each([
    ['图片', () => executeComfyUIGenerate(params)],
    ['视频', () => executeComfyUIVideoGenerate(params)],
    ['音频', () => executeComfyUIAudioGenerate(params)],
  ] as const)('%s 查询中断保留任务，继续查询不再次生成', async (kind, generate) => {
    if (kind === '视频') configureVideo();
    mocks.history.mockRejectedValue(new TypeError('network unavailable'));
    const result = expect(generate()).rejects.toBeInstanceOf(kind === '视频' ? VideoPollingPausedError : ComfyPendingError);
    await vi.waitFor(() => expect(pending()[0]?.submitted).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', comfyRecoveryState: 'disconnected' });
    if (kind === '视频') {
      expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', videoTaskState: 'paused', error: undefined });
      expect(pending()[0].videoRecoveryMessage).toContain('本轮视频查询中断');
    }
    await expect(executeComfyUIGenerate(params)).rejects.toThrow('未确认结束');
    mocks.history.mockResolvedValue(kind === '视频'
      ? json({ 'prompt-1': { status: { completed: true }, outputs: { '9': { images: [{ filename: 'out.mp4' }] } } } })
      : completed());
    await resumeComfyUINodeTask('n1');
    expect(promptCalls()).toHaveLength(1);
    expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
  });

  it('远端完成后保留视频任务直到调用方完成本地交付', async () => {
    configureVideo();
    const result = await executeComfyUIVideoGenerate(params);
    expect(result.url).toBe(`${task.baseUrl}/view?filename=out.mp4&subfolder=video&type=output`);
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', videoRecoveryState: 'paused' });
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBeUndefined();
    await expect(executeComfyUIVideoGenerate(params)).rejects.toThrow('未交付');
    expect(promptCalls()).toHaveLength(1);
    useAppStore.getState().updateNodeDataTransient('n1', { videoUrl: 'asset://local.mp4', status: 'success' });
    completeVideoNodeTask('n1', 'prompt-1');
    expect(pending()).toEqual([]);
  });

  it('视频已回填时完成通知同步清除暂停提示，重开项目不再恢复旧任务', async () => {
    configureVideo();
    savePendingTask({ ...task, nodeType: 'ai-video', videoRecoveryState: 'paused' });
    useAppStore.getState().updateNodeDataTransient('n1', {
      videoUrl: 'asset://local.mp4', status: 'success', videoTaskState: 'paused',
    });
    completeVideoNodeTask('n1', 'prompt-1');
    expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ videoUrl: 'asset://local.mp4', status: 'success', videoTaskState: undefined });
    await resumePendingTasks('p1');
    expect(useAppStore.getState().nodes[0].data.videoTaskState).toBeUndefined();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('旧视频或旧任务的完成通知不能清除另一轮暂停任务', () => {
    configureVideo();
    savePendingTask({ ...task, taskId: 'new-prompt', nodeType: 'ai-video', videoRecoveryState: 'paused' });
    useAppStore.getState().updateNodeDataTransient('n1', { videoUrl: 'asset://previous.mp4', status: 'idle', videoTaskState: 'paused' });
    completeVideoNodeTask('n1', 'prompt-1');
    expect(pending()[0]).toMatchObject({ taskId: 'new-prompt', videoRecoveryState: 'paused' });
    expect(useAppStore.getState().nodes[0].data.videoTaskState).toBe('paused');
  });

  it('暂停、重开项目和重试沿用本轮开始时间，成功交付后结束计时', async () => {
    configureVideo();
    useAppStore.getState().updateNodeDataTransient('n1', { status: 'loading' });
    const startedAt = useAppStore.getState().nodes[0].data.generationStartedAt!;
    await executeComfyUIVideoGenerate(params);
    vi.setSystemTime(startedAt + 60_000);
    pauseVideoNodeTask('n1', 'prompt-1');
    expect(useAppStore.getState().nodes[0].data.generationStartedAt).toBe(startedAt);
    expect(pending()[0].videoGenerationStartedAt).toBe(startedAt);

    // 模拟项目快照还未保存暂停状态，重开时从待续任务恢复同一个计时起点。
    useAppStore.getState().updateNodeDataTransient('n1', { status: 'idle', videoTaskState: undefined });
    expect(useAppStore.getState().nodes[0].data.generationStartedAt).toBeUndefined();
    await resumePendingTasks('p1');
    expect(useAppStore.getState().nodes[0].data.generationStartedAt).toBe(startedAt);
    mocks.persist.mockImplementationOnce(async () => {
      expect(useAppStore.getState().nodes[0].data.generationStartedAt).toBe(startedAt);
      return { mediaUrl: 'asset://local.mp4', sourceUrl: 'http://comfy.test/out.mp4' };
    });
    await resumeVideoNodeTask('n1');
    expect(useAppStore.getState().nodes[0].data.generationStartedAt).toBeUndefined();
    expect(pending()).toEqual([]);
    expect(promptCalls()).toHaveLength(1);
  });

  it('再次生成时旧恢复节点保留原计时，新一轮重新计时', async () => {
    configureVideo();
    await executeComfyUIVideoGenerate(params);
    const startedAt = pending()[0].videoGenerationStartedAt;
    pauseVideoNodeTask('n1', 'prompt-1');
    vi.setSystemTime(startedAt! + 60_000);
    prepareVideoNodeGeneration('n1');
    const recoveryId = pending()[0].nodeId;
    expect(useAppStore.getState().nodes.find((node) => node.id === recoveryId)?.data.generationStartedAt).toBe(startedAt);
    useAppStore.getState().updateNodeDataTransient('n1', { status: 'loading' });
    expect(useAppStore.getState().nodes.find((node) => node.id === 'n1')?.data.generationStartedAt).toBe(startedAt! + 60_000);
  });

  it('无待续任务的旧暂停标记不能让新生成继承旧计时', () => {
    configureVideo();
    useAppStore.getState().updateNodeDataTransient('n1', { status: 'idle', videoTaskState: 'paused' });
    const startedAt = useAppStore.getState().nodes[0].data.generationStartedAt!;
    vi.setSystemTime(startedAt + 60_000);
    prepareVideoNodeGeneration('n1');
    useAppStore.getState().updateNodeDataTransient('n1', { status: 'loading' });
    expect(useAppStore.getState().nodes[0].data.generationStartedAt).toBe(startedAt + 60_000);
  });

  it('视频下载失败保留任务，重试后落盘回填且不重复生成', async () => {
    configureVideo();
    useAppStore.getState().updateNodeDataTransient('n1', { videoUrl: 'asset://previous.mp4' });
    await executeComfyUIVideoGenerate(params);
    mocks.persist.mockRejectedValueOnce(new MediaPersistenceError('下载结果不是有效视频 /private/user/video.mp4?token=secret'));
    await resumeVideoNodeTask('n1');
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', videoRecoveryState: 'paused',
      videoRecoveryMessage: '生成媒体未能写入项目目录：下载结果不是有效视频，请检查输出格式或下载服务' });
    expect(JSON.stringify(pending())).not.toMatch(/\/private|secret/);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', videoTaskState: 'paused', error: undefined });
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('asset://previous.mp4');

    mocks.persist.mockResolvedValue({ mediaUrl: 'asset://local.mp4', sourceUrl: 'http://comfy.test/out.mp4', filePath: 'saved.mp4' });
    await resumeVideoNodeTask('n1');
    expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ videoUrl: 'asset://local.mp4', filePath: 'saved.mp4', status: 'success', videoTaskState: undefined });
    expect(promptCalls()).toHaveLength(1);
  });

  it('实时生成和恢复都跳过图片预览，使用正式视频的远端取件地址', async () => {
    configureVideo();
    mocks.history.mockImplementation(async () => json({ 'prompt-1': { status: { completed: true }, outputs: {
      '1': { gifs: [{ filename: 'preview.webp', type: 'output' }] },
      '2': { videos: [{ filename: 'preview.webm', type: 'temp' }] },
      '9': { gifs: [{ filename: 'final.mp4', subfolder: 'video', type: 'output' }] },
    } } }));
    const url = `${task.baseUrl}/view?filename=final.mp4&subfolder=video&type=output`;
    await expect(executeComfyUIVideoGenerate(params)).resolves.toEqual({ url });
    mocks.persist.mockResolvedValue({ mediaUrl: 'asset://saved.mp4', sourceUrl: url, filePath: 'saved.mp4' });
    await resumeVideoNodeTask('n1');
    expect(mocks.persist).toHaveBeenCalledWith(url, 'p1', 'ai-video', 'test', {
      mediaDownloadAccess: undefined, signal: expect.any(AbortSignal),
    });
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('asset://saved.mp4');
    expect(pending()).toEqual([]);
    expect(promptCalls()).toHaveLength(1);
  });

  it('恢复暂停只保留受控的落盘错误，不持久化原生错误或签名地址', async () => {
    configureVideo();
    await executeComfyUIVideoGenerate(params);
    pauseVideoNodeTask('n1', 'prompt-1', new Error('/private/user/video.mp4?token=secret'));
    expect(pending()[0].videoRecoveryMessage).toBeUndefined();
    expect(JSON.stringify(pending())).not.toMatch(/\/private|secret/);
  });

  it('本轮已完成但取回失败时说明交付阶段，不把旧视频视为新任务成功', async () => {
    configureVideo();
    useAppStore.getState().updateNodeDataTransient('n1', { videoUrl: 'asset://previous.mp4' });
    await executeComfyUIVideoGenerate(params);
    mocks.persist.mockRejectedValueOnce(new Error('/private/user/video.mp4?token=secret'));
    await resumeVideoNodeTask('n1');
    expect(pending()[0].videoRecoveryMessage).toContain('本轮视频已生成，但保存或回填尚未完成');
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('asset://previous.mp4');
    expect(JSON.stringify(pending())).not.toMatch(/\/private|secret/);
    expect(promptCalls()).toHaveLength(1);
  });

  it.each(['项目', '画布 revision'])('视频下载期间%s变化时不回填，保留任务供重试', async (change) => {
    configureVideo();
    await executeComfyUIVideoGenerate(params);
    mocks.persist.mockImplementationOnce(async () => {
      if (change === '项目') useAppStore.setState({ currentProjectId: 'p2' });
      else useAppStore.getState().setCanvasRevision(useAppStore.getState().getCurrentRevision() + 1);
      return { mediaUrl: 'asset://stale.mp4', sourceUrl: 'http://comfy.test/out.mp4' };
    });
    await resumeVideoNodeTask('n1');
    expect(useAppStore.getState().nodes.find((node) => node.id === 'n1')?.data.videoUrl).toBeUndefined();
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', videoRecoveryState: 'paused' });
    expect(pending()[0].videoRecoveryMessage).toContain('画布或项目在本轮视频取回期间发生变化');
    useAppStore.setState({ currentProjectId: 'p1' });
    mocks.persist.mockResolvedValue({ mediaUrl: 'asset://fresh.mp4', sourceUrl: 'http://comfy.test/out.mp4' });
    await resumeVideoNodeTask('n1');
    expect(useAppStore.getState().nodes.find((node) => node.id === 'n1')?.data.videoUrl).toBe('asset://fresh.mp4');
    expect(pending()).toEqual([]);
    expect(promptCalls()).toHaveLength(1);
  });

  it('重开项目不会自动查询待交付视频，新生成前保留独立恢复节点', async () => {
    configureVideo();
    await executeComfyUIVideoGenerate(params);
    const queries = mocks.history.mock.calls.length;
    await resumePendingTasks('p1');
    expect(mocks.history).toHaveBeenCalledTimes(queries);
    expect(useAppStore.getState().nodes[0].data.videoTaskState).toBe('paused');
    useAppStore.getState().updateNodeDataTransient('n1', { prompt: 'new prompt', seedanceRatio: '16:9' });
    prepareVideoNodeGeneration('n1');
    const recovery = useAppStore.getState().nodes.find((node) => node.id !== 'n1')!;
    expect(pending()[0]).toMatchObject({ nodeId: recovery.id, taskId: 'prompt-1' });
    expect(recovery.data).toMatchObject({ prompt: 'cat', seedanceRatio: '9:16', videoTaskState: 'paused' });
    await resumeVideoNodeTask(recovery.id);
    expect(useAppStore.getState().nodes.find((node) => node.id === recovery.id)?.data.videoUrl).toContain('out.mp4');
    expect(useAppStore.getState().nodes.find((node) => node.id === 'n1')?.data.videoUrl).toBeUndefined();
    expect(promptCalls()).toHaveLength(1);
  });

  it('ComfyUI 明确失败不转成暂停，取消未确认的视频不自动查询或允许新提交', async () => {
    configureVideo();
    await executeComfyUIVideoGenerate(params);
    mocks.history.mockImplementation(async () => json({ 'prompt-1': { status: { status_str: 'error',
      messages: [['execution_error', { exception_message: 'video encode failed' }]],
    } } }));
    await expect(resumeVideoNodeTask('n1')).rejects.toThrow('video encode failed');
    expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'error', error: expect.stringContaining('video encode failed') });

    savePendingTask({ ...task, nodeType: 'ai-video', videoRecoveryState: 'paused', comfyRecoveryState: 'cancel_pending' });
    const queries = mocks.history.mock.calls.length;
    await resumePendingTasks('p1');
    expect(mocks.history).toHaveBeenCalledTimes(queries);
    expect(pauseVideoNodeTask('n1', task.taskId)).toBeUndefined();
    prepareVideoNodeGeneration('n1');
    expect(useAppStore.getState().nodes).toHaveLength(1);
    await expect(executeComfyUIVideoGenerate(params)).rejects.toThrow('未确认结束');
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

  it('history 已有输出但状态未完成时继续等待终态', async () => {
    let historyCalls = 0;
    mocks.history.mockImplementation(async () => {
      historyCalls += 1;
      return historyCalls === 1
        ? json({ 'prompt-1': { status: { completed: false }, outputs: { '9': { images: [{ filename: 'preview.png' }] } } } })
        : completed();
    });
    const result = executeComfyUIGenerate(params);
    await vi.waitFor(() => expect(historyCalls).toBe(1));
    let settled = false;
    void result.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toMatchObject({ url: expect.stringContaining('out.png') });
  });

  it('兼容没有 status 字段的旧版终态 history', async () => {
    mocks.history.mockResolvedValue(json({
      'prompt-1': { outputs: { '9': { images: [{ filename: 'legacy.png' }] } } },
    }));
    await expect(executeComfyUIGenerate(params)).resolves.toMatchObject({
      url: expect.stringContaining('legacy.png'),
    });
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
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', comfyRecoveryState: 'save_pending' });
    useAppStore.setState({ currentProjectId: 'p1' });
    mocks.history.mockImplementation(async () => completed());
    mocks.persist.mockImplementation(async (url: string) => ({ mediaUrl: url, sourceUrl: url }));
    await resumeComfyUINodeTask('n1');
    expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
    expect(promptCalls()).toHaveLength(0);
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

describe.each([401, 403] as const)('ComfyUI 查询鉴权失败 HTTP %i', (status) => {
  it.each(['history', 'queue'] as const)('%s 首次拒绝就暂停查询，不消耗网络抖动重试预算', async (endpoint) => {
    mocks.history.mockImplementation(async () => json({}, endpoint === 'history' ? status : 200));
    mocks.queue.mockImplementation(async () => json({ detail: '/private?token=secret' }, status));
    await expect(pollComfyHistory(task.baseUrl, task.taskId, 'timeout', () => null))
      .rejects.toMatchObject({ name: 'ComfyQueryAuthorizationError', status });
    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect(mocks.queue).toHaveBeenCalledTimes(endpoint === 'queue' ? 1 : 0);
    expect(promptCalls()).toHaveLength(0);
  });

  it.each([
    { kind: '图片', nodeType: 'ai-image', generate: () => executeComfyUIGenerate(params), complete: completed },
    { kind: '视频', nodeType: 'ai-video', generate: () => executeComfyUIVideoGenerate(params), complete: completedVideo },
    { kind: '音频', nodeType: 'ai-audio', generate: () => executeComfyUIAudioGenerate(params), complete: completedAudio },
  ] as const)('$kind 正常生成保留原任务与固定原因，重新进项目不盲目查询，修复后只续取', async ({ nodeType, generate, complete }) => {
    if (nodeType === 'ai-video') configureVideo();
    else useAppStore.getState().updateNodeDataTransient('n1', { type: nodeType });
    mocks.history.mockImplementation(async () => json({ detail: '/private?token=secret' }, status));
    await expect(generate()).rejects.toThrow(`HTTP ${status}`);
    expect(pending()[0]).toMatchObject({ taskId: 'prompt-1', submitted: true,
      comfyRecoveryState: 'disconnected', comfyQueryHttpStatus: status });
    expect(JSON.stringify(pending())).not.toMatch(/private|secret/);
    expect(mocks.history).toHaveBeenCalledTimes(1);
    await resumePendingTasks('p1');
    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().nodes[0].data.mediaTaskState).toBe('paused');
    mocks.history.mockImplementation(async () => complete());
    await resumeComfyUINodeTask('n1');
    expect(promptCalls()).toHaveLength(1);
    expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
  });

  it.each(['ai-image', 'ai-video', 'ai-audio'] as const)('%s 手动续查再次拒绝时保留原因和原任务', async (nodeType) => {
    if (nodeType === 'ai-video') configureVideo();
    else useAppStore.getState().updateNodeDataTransient('n1', { type: nodeType });
    savePendingTask({ ...task, nodeType });
    mocks.history.mockImplementation(async () => json({}, status));
    await resumeComfyUINodeTask('n1');
    expect(pending()[0]).toMatchObject({ taskId: task.taskId, comfyQueryHttpStatus: status,
      mediaRecoveryState: 'query_paused' });
    expect(useAppStore.getState().nodes[0].data.mediaTaskState).toBe('paused');
    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect(promptCalls()).toHaveLength(0);
    await resumePendingTasks('p1');
    expect(mocks.history).toHaveBeenCalledTimes(1);
  });

  it('鉴权错误继承可恢复类别，并只持久化有限状态码', () => {
    const error = new ComfyQueryAuthorizationError(status);
    expect(error).toBeInstanceOf(ComfyPendingError);
    savePendingTask({ ...task, comfyQueryHttpStatus: status });
    expect(pending()[0].comfyQueryHttpStatus).toBe(status);
    savePendingTask({ ...task, comfyQueryHttpStatus: { body: '/private?token=secret' } as unknown as 401 });
    expect(pending()[0].comfyQueryHttpStatus).toBeUndefined();
    expect(JSON.stringify(pending())).not.toMatch(/private|secret/);
  });

  it('共用续查入口向调用方保留鉴权原因，不会把仍保留的任务当成交付成功', async () => {
    savePendingTask(task);
    mocks.history.mockImplementation(async () => json({}, status));
    await expect(resumeMediaNodeTask('n1')).rejects.toThrow(`HTTP ${status}`);
    expect(pending()[0]).toMatchObject({ taskId: task.taskId, comfyQueryHttpStatus: status });
    expect(promptCalls()).toHaveLength(0);
  });
});
