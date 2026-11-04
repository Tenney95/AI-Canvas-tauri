/**
 * generationServiceReplicaLease — 回归测试：节点视频生成的宿主任务租约。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const mocks = vi.hoisted(() => ({
  store: { currentProjectId: 'p', nodes: [] as Array<{ id: string; data: BaseNodeData }>,
    workflows: [], projects: [], customStyles: [], updateNodeDataTransient: vi.fn(), updateNodeData: vi.fn(),
    recordOutputHistory: vi.fn(), showToast: vi.fn() },
  generate: vi.fn(), persist: vi.fn(), guardFresh: true, completeGuard: vi.fn(),
  image: vi.fn(), audio: vi.fn(), persistAudio: vi.fn(), completeComfy: vi.fn(), pauseComfy: vi.fn(),
  completeMedia: vi.fn(), pauseMedia: vi.fn(() => new Error('任务已保留')), endOperation: vi.fn(), prepareMedia: vi.fn(),
  tasks: [] as Array<import('../../src/services/pollManager').PendingTask>,
  polling: new Map<string, { controller: AbortController; signal: AbortSignal }>(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.store } }));
vi.mock('../../src/store/store.utils', () => ({ generateId: () => 'test-id', derivedNodePlacement: vi.fn() }));
vi.mock('../../src/services/aiService', () => ({ generateVideo: mocks.generate, generateImage: mocks.image, generateAudio: mocks.audio }));
vi.mock('../../src/services/ai/generateAudio', () => ({ persistAudioGenerationResult: mocks.persistAudio }));
vi.mock('../../src/services/fileService', () => ({ persistMediaUrlToProjectData: mocks.persist }));
vi.mock('../../src/services/imageBatchService', () => ({ applyImageBatchResults: vi.fn(), failImageBatchNodes: vi.fn(), prepareImageBatchNodes: vi.fn() }));
vi.mock('../../src/services/projectSettingsService', () => ({ getProjectModelKind: () => 'video', parseProjectModelRef: () => undefined,
  resolveProjectGenerationPrompt: ({ prompt }: { prompt: string }) => prompt }));
vi.mock('../../src/services/dramaAssetExtract', () => ({ postProcessDramaExtractOutput: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: vi.fn() }));
vi.mock('../../src/services/ai/videoRequestResolver', () => ({ resolveVideoSubmissionControls: (options: { seedanceDuration?: number }) => ({ seedanceDuration: options.seedanceDuration }) }));
vi.mock('../../src/services/shotlistService', () => ({ generateShotlistRows: vi.fn() }));
vi.mock('../../src/services/workflowExecutionService', () => ({ isCloudWorkflow: () => false, getCloudWorkflowPersistedOutput: () => undefined }));
vi.mock('../../src/services/workflowApi/workflowApiAdapter', () => ({ completeWorkflowApiNodeTask: vi.fn() }));
vi.mock('../../src/services/ai/providers/runninghubWorkflow', () => ({ completeRunningHubNodeTask: vi.fn() }));
vi.mock('../../src/services/canvasDerivationGuard', () => ({ registerCanvasDerivation: () => ({ key: 'guard' }),
  isCanvasDerivationFresh: () => mocks.guardFresh, completeCanvasDerivation: mocks.completeGuard }));
vi.mock('../../src/services/videoBatchPlanning', () => ({ videoInputFingerprint: () => 'video-fingerprint' }));
vi.mock('../../src/services/pollManager', () => ({
  prepareMediaNodeGeneration: mocks.prepareMedia, completeMediaNodeTask: mocks.completeMedia, pauseMediaTask: mocks.pauseMedia,
  registerMediaNodeOperation: () => mocks.endOperation,
  registerNodePolling: vi.fn((nodeId: string, parentSignal?: AbortSignal) => {
    mocks.polling.get(nodeId)?.controller.abort();
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    mocks.polling.set(nodeId, { controller, signal });
    return signal;
  }),
  cleanupNodePolling: vi.fn((nodeId: string, expectedSignal?: AbortSignal) => {
    if (expectedSignal && mocks.polling.get(nodeId)?.signal !== expectedSignal) return false;
    return mocks.polling.delete(nodeId);
  }),
  isMediaTaskPausedError: (error: unknown) => error instanceof Error && error.message === '视频查询已暂停',
  prepareVideoNodeGeneration: vi.fn(), completeVideoNodeTask: vi.fn(), pauseVideoNodeTask: vi.fn(),
  beginComfyNodeDelivery: vi.fn(), completeComfyNodeTask: mocks.completeComfy, pauseComfyNodeDelivery: mocks.pauseComfy,
  getPendingTasksForProject: () => mocks.tasks,
  VideoPollingPausedError: class extends Error {
    constructor() { super('视频查询已暂停'); }
  },
}));

import { executeGeneration, type GenerationLease } from '../../src/services/generationService';
import { cleanupNodePolling, registerNodePolling, VideoPollingPausedError } from '../../src/services/pollManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const data = (): BaseNodeData => ({ type: 'ai-video', label: '复刻分段', prompt: '保留动作和运镜',
  provider: 'general', model: 'general/video-model', seedanceDuration: 15 });
const run = (lease?: GenerationLease, passData?: BaseNodeData) => executeGeneration('video', undefined, undefined, passData, lease);
const cancelled = { success: false, message: '任务已取消' };
function expectNoCommit() {
  expect(mocks.store.updateNodeData).not.toHaveBeenCalled();
  expect(mocks.store.recordOutputHistory).not.toHaveBeenCalled();
  expect(mocks.store.updateNodeDataTransient.mock.calls.every((call) => call[1].status !== 'error')).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.guardFresh = true; mocks.store.currentProjectId = 'p';
  mocks.tasks = [];
  mocks.polling.clear();
  mocks.store.nodes = [{ id: 'video', data: data() }];
  mocks.generate.mockReset().mockResolvedValue({ url: 'generated.mp4' });
  mocks.persist.mockReset().mockResolvedValue({ mediaUrl: 'saved.mp4', sourceUrl: 'generated.mp4', filePath: 'saved.mp4' });
  mocks.store.recordOutputHistory.mockReset().mockResolvedValue(undefined);
});

describe('节点视频生成的宿主任务租约', () => {
  it('已完成任务的下载失败记为待下载，不写成生成失败，也不重新提交', async () => {
    mocks.tasks = [{ projectId: 'p', nodeId: 'video', taskId: 'remote-1', attemptId: 'attempt-1', provider: 'runninghubwf',
      nodeType: 'ai-video', taskType: 'runninghub-workflow', submitted: true, runninghubRecoveryState: 'save_pending' }];
    mocks.generate.mockRejectedValueOnce(Object.assign(new Error('生成媒体未能写入项目目录：下载媒体失败'), { name: 'MediaPersistenceError' }));
    expect(await run()).toEqual({ success: false, message: '生成已完成，待下载' });
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.store.recordOutputHistory).toHaveBeenCalledWith('video', expect.objectContaining({
      status: 'download_pending', output: '', recoveryTask: { projectId: 'p', nodeId: 'video', taskId: 'remote-1', attemptId: 'attempt-1' },
    }));
    expect(mocks.store.updateNodeDataTransient.mock.calls.every(([, patch]) => patch.status !== 'error')).toBe(true);
  });

  it('leaves a paused query out of failed output history and error toasts', async () => {
    mocks.generate.mockRejectedValueOnce(new VideoPollingPausedError());
    expect(await run()).toEqual({ success: false, message: '视频查询已暂停' });
    expectNoCommit();
    expect(mocks.store.showToast).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it('rejects an expired lease at entry before changing node state or submitting a paid request', async () => {
    const assertFresh = vi.fn(() => { throw new Error('plugin revision changed'); });
    expect(await run({ assertFresh })).toEqual(cancelled);
    expect(mocks.store.updateNodeDataTransient).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled(); expectNoCommit();
  });
  it('checks the lease again immediately before the paid video submission', async () => {
    const assertFresh = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('reference file changed'));
    expect(await run({ assertFresh })).toEqual(cancelled);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled(); expectNoCommit();
  });
  it('waits for asynchronous lease checks and notices cancellation before the request starts', async () => {
    const check = deferred<void>(); const controller = new AbortController();
    const assertFresh = vi.fn(() => check.promise);
    const pending = run({ signal: controller.signal, assertFresh });
    await vi.waitFor(() => expect(assertFresh).toHaveBeenCalledOnce());
    controller.abort(); check.resolve();
    expect(await pending).toEqual(cancelled); expect(mocks.generate).not.toHaveBeenCalled(); expectNoCommit();
  });
  it('does not persist or publish a held generation after the plugin revision changes', async () => {
    const response = deferred<{ url: string }>(); let current = true;
    const assertFresh = vi.fn(async () => { if (!current) throw new Error('plugin stopped'); });
    mocks.generate.mockReturnValueOnce(response.promise);
    const pending = run({ assertFresh });
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce());
    current = false; response.resolve({ url: 'old-revision.mp4' });
    expect(await pending).toEqual(cancelled); expect(mocks.persist).not.toHaveBeenCalled(); expectNoCommit();
    expect(mocks.completeGuard).toHaveBeenCalledOnce();
  });
  it('does not attach a saved result or error history if the lease expires during persistence', async () => {
    const saved = deferred<{ mediaUrl: string; sourceUrl: string }>(); let current = true;
    const assertFresh = vi.fn(async () => { if (!current) throw new Error('reference changed'); });
    mocks.persist.mockReturnValueOnce(saved.promise);
    const pending = run({ assertFresh });
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    current = false; saved.resolve({ mediaUrl: 'retained-file.mp4', sourceUrl: 'generated.mp4' });
    expect(await pending).toEqual(cancelled); expectNoCommit();
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.persist).toHaveBeenCalledOnce();
  });
  it('checks once more at the final canvas write boundary after persistence', async () => {
    const writeGate = deferred<void>(); let current = true; let calls = 0;
    const assertFresh = vi.fn(async () => {
      if (++calls === 5) await writeGate.promise;
      if (!current) throw new Error('lease revoked at write boundary');
    });
    const pending = run({ assertFresh });
    await vi.waitFor(() => expect(calls).toBe(5));
    expect(mocks.persist).toHaveBeenCalledOnce(); expectNoCommit();
    current = false; writeGate.resolve();
    expect(await pending).toEqual(cancelled); expectNoCommit();
  });
  it('passes the external AbortSignal to generateVideo and suppresses cancellation error history', async () => {
    const response = deferred<{ url: string }>(); const controller = new AbortController();
    mocks.generate.mockReturnValueOnce(response.promise);
    const pending = run({ signal: controller.signal, assertFresh: vi.fn(async () => undefined) });
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce());
    expect(mocks.generate.mock.calls[0][1]).toBe(controller.signal);
    controller.abort(); response.reject(new DOMException('Provider cancelled', 'AbortError'));
    expect(await pending).toEqual(cancelled); expect(mocks.persist).not.toHaveBeenCalled(); expectNoCommit();
  });
  it('rechecks lease freshness when a held provider rejects and never writes an error under a revoked revision', async () => {
    const response = deferred<{ url: string }>(); let current = true;
    mocks.generate.mockReturnValueOnce(response.promise);
    const pending = run({ assertFresh: async () => { if (!current) throw new Error('revision changed'); } });
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce());
    current = false; response.reject(new Error('upstream error'));
    expect(await pending).toEqual(cancelled); expectNoCommit();
  });
  it('keeps ordinary generation behavior and the original single-argument model call without a lease', async () => {
    expect(await run()).toEqual({ success: true });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'general/video-model', seedanceDuration: 15 }));
    expect(mocks.generate.mock.calls[0]).toHaveLength(1);
    expect(mocks.store.updateNodeData).toHaveBeenCalledWith('video', expect.objectContaining({ videoUrl: 'saved.mp4', status: 'success' }));
    expect(mocks.store.recordOutputHistory).toHaveBeenCalledWith('video', expect.objectContaining({ status: 'success' }), true);
  });
  it('preserves the fourth passData argument and succeeds with a valid asynchronous lease', async () => {
    const passData = { ...data(), model: 'general/override', prompt: '新要求', seedanceDuration: 30 };
    const assertFresh = vi.fn(async () => undefined);
    expect(await run({ assertFresh }, passData)).toEqual({ success: true });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'general/override', prompt: '新要求', seedanceDuration: 30 }), undefined, expect.any(Function));
    expect(assertFresh).toHaveBeenCalledTimes(5);
  });
  it('retains ordinary provider error reporting while its lease is still current', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('模型未接受请求'));
    expect(await run({ assertFresh: vi.fn(async () => undefined) })).toEqual({ success: false, message: '模型未接受请求' });
    expect(mocks.store.updateNodeDataTransient).toHaveBeenLastCalledWith('video', { status: 'error', error: '模型未接受请求' });
    expect(mocks.store.recordOutputHistory).toHaveBeenCalledWith('video', expect.objectContaining({ status: 'error', error: '模型未接受请求' }));
  });
});

describe('ComfyUI 图片与音频交付边界', () => {
  function setup(kind: 'ai-image' | 'ai-audio') {
    mocks.store.nodes = [{ id: 'media', data: { type: kind, label: '本地工作流', prompt: '内容',
      provider: 'comfyui', model: 'comfyui/workflow', workflowId: 'wf' } }];
    mocks.image.mockReset().mockResolvedValue({ url: 'remote.png', width: 64, height: 64, comfyTaskId: 'original' });
    mocks.audio.mockReset().mockResolvedValue({ url: 'remote.wav', comfyTaskId: 'original' });
    mocks.persistAudio.mockReset().mockResolvedValue({ mediaUrl: 'saved.wav', outputUrl: 'remote.wav', persistence: 'saved', filePath: 'saved.wav' });
  }

  it.each(['ai-image', 'ai-audio'] as const)('%s 保存期间 revision 变化，拒绝回填和任务清理', async (kind) => {
    setup(kind);
    const saving = deferred<{ mediaUrl: string; sourceUrl: string; outputUrl: string; persistence: string }>();
    const persist = kind === 'ai-image' ? mocks.persist : mocks.persistAudio;
    persist.mockReturnValueOnce(saving.promise);
    const pending = executeGeneration('media');
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    mocks.guardFresh = false;
    saving.resolve({ mediaUrl: 'stale', sourceUrl: 'remote', outputUrl: 'remote', persistence: 'saved' });
    expect((await pending).success).toBe(false);
    expect(mocks.store.updateNodeData).not.toHaveBeenCalled();
    expect(mocks.completeComfy).not.toHaveBeenCalled();
    expect(mocks.pauseComfy).toHaveBeenCalledWith('media', 'original', expect.any(Function));
    expect(mocks.pauseComfy.mock.calls[0][2]()).toBe(false);
  });

  it.each(['ai-image', 'ai-audio'] as const)('%s 保存并写回之后才清理同一个原任务', async (kind) => {
    setup(kind);
    expect(await executeGeneration('media')).toEqual({ success: true });
    expect(mocks.completeComfy).toHaveBeenCalledWith('media', 'original');
    expect(mocks.store.updateNodeData.mock.invocationCallOrder[0]).toBeLessThan(mocks.completeComfy.mock.invocationCallOrder[0]);
  });

  it('音频落盘失败不能以临时地址冒充成功交付', async () => {
    setup('ai-audio');
    mocks.persistAudio.mockResolvedValueOnce({ mediaUrl: 'remote.wav', outputUrl: 'remote.wav', persistence: 'failed', persistError: 'disk full' });
    expect((await executeGeneration('media')).success).toBe(false);
    expect(mocks.store.updateNodeData).not.toHaveBeenCalled();
    expect(mocks.completeComfy).not.toHaveBeenCalled();
    expect(mocks.pauseComfy).toHaveBeenCalledWith('media', 'original', expect.any(Function));
  });
});

describe('跨媒体异步任务交付确认', () => {
  const receipt = { projectId: 'p', nodeId: 'video', taskId: 'original', attemptId: 'first' };

  it('视频保存继承原生成连接的下载描述，不写入节点或历史', async () => {
    const mediaDownloadAccess = { providerConfigId: 'relay-video', origin: 'https://relayonapi.com', auth: { type: 'bearer' as const } };
    mocks.generate.mockResolvedValueOnce({ url: 'https://relayonapi.com/video', taskReceipt: receipt, mediaDownloadAccess });
    expect(await run()).toEqual({ success: true });
    expect(mocks.persist).toHaveBeenCalledWith('https://relayonapi.com/video', 'p', 'ai-video', '复刻分段', { mediaDownloadAccess, signal: expect.any(AbortSignal) });
    expect(JSON.stringify(mocks.store.updateNodeData.mock.calls)).not.toContain('mediaDownloadAccess');
    expect(JSON.stringify(mocks.store.recordOutputHistory.mock.calls)).not.toContain('mediaDownloadAccess');
  });

  it('保存和节点写入完成之后，才确认当次返回的任务身份', async () => {
    mocks.generate.mockResolvedValueOnce({ url: 'generated.mp4', taskReceipt: receipt });
    expect(await run()).toEqual({ success: true });
    expect(mocks.completeMedia).toHaveBeenCalledWith(receipt);
    expect(mocks.store.updateNodeData.mock.invocationCallOrder[0]).toBeLessThan(mocks.completeMedia.mock.invocationCallOrder[0]);
    expect(mocks.endOperation).toHaveBeenCalledOnce();
  });

  it('本地保存失败保留原任务，不确认或重新生成', async () => {
    mocks.generate.mockResolvedValueOnce({ url: 'generated.mp4', taskReceipt: receipt });
    mocks.persist.mockRejectedValueOnce(new Error('disk full'));
    expect((await run()).success).toBe(false);
    expect(mocks.completeMedia).not.toHaveBeenCalled();
    expect(mocks.pauseMedia).toHaveBeenCalledWith(receipt, expect.any(Error), 'delivery_pending');
    expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it('保存使用当前取消信号，停止后保留原任务并释放保存控制器', async () => {
    const controller = new AbortController();
    mocks.generate.mockResolvedValueOnce({ url: 'generated.mp4', taskReceipt: receipt });
    mocks.persist.mockImplementationOnce((_url, _project, _kind, _label, options: { signal: AbortSignal }) => (
      new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    ));
    const pending = run({ signal: controller.signal, assertFresh: vi.fn() });
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    const signal = mocks.persist.mock.calls[0][4].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect((await pending).success).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.completeMedia).not.toHaveBeenCalled();
    expect(mocks.pauseMedia).toHaveBeenCalledWith(receipt, expect.any(Error), 'delivery_pending');
    expect(cleanupNodePolling).toHaveBeenCalledWith('video', signal);
    expect(mocks.polling.has('video')).toBe(false);
    expectNoCommit();
  });

  it('旧保存结束不能回填或清除替代它的新查询控制器', async () => {
    const saving = deferred<{ mediaUrl: string; sourceUrl: string }>();
    mocks.generate.mockResolvedValueOnce({ url: 'generated.mp4', taskReceipt: receipt });
    mocks.persist.mockReturnValueOnce(saving.promise);
    const pending = run();
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    const oldSignal = mocks.persist.mock.calls[0][4].signal as AbortSignal;
    const replacement = registerNodePolling('video');
    expect(oldSignal.aborted).toBe(true);
    saving.resolve({ mediaUrl: 'saved.mp4', sourceUrl: 'generated.mp4' });
    expect((await pending).success).toBe(false);
    expect(cleanupNodePolling).toHaveBeenCalledWith('video', oldSignal);
    expect(mocks.polling.get('video')?.signal).toBe(replacement);
    expect(replacement.aborted).toBe(false);
    expect(mocks.completeMedia).not.toHaveBeenCalled();
    expectNoCommit();
  });

  it('保存期间目标已变化，旧回调只暂停原receipt，不确认新任务', async () => {
    const saving = deferred<{ mediaUrl: string; sourceUrl: string }>();
    mocks.generate.mockResolvedValueOnce({ url: 'generated.mp4', taskReceipt: receipt });
    mocks.persist.mockReturnValueOnce(saving.promise);
    const pending = run();
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    mocks.guardFresh = false;
    saving.resolve({ mediaUrl: 'saved.mp4', sourceUrl: 'generated.mp4' });
    expect((await pending).success).toBe(false);
    expect(mocks.completeMedia).not.toHaveBeenCalled();
    expect(mocks.pauseMedia).toHaveBeenCalledWith(receipt, undefined, 'canvas_changed');
  });
});
