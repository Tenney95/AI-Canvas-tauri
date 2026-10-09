import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const mocks = vi.hoisted(() => ({
  store: { currentProjectId: 'p', nodes: [] as Array<{ id: string; data: BaseNodeData }>,
    workflows: [], projects: [], customStyles: [], updateNodeDataTransient: vi.fn(), updateNodeData: vi.fn(),
    recordOutputHistory: vi.fn(), showToast: vi.fn() },
  generate: vi.fn(), persist: vi.fn(), guardFresh: true, completeGuard: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.store } }));
vi.mock('../../src/store/store.utils', () => ({ generateId: () => 'test-id', derivedNodePlacement: vi.fn() }));
vi.mock('../../src/services/aiService', () => ({ generateVideo: mocks.generate }));
vi.mock('../../src/services/ai/generateAudio', () => ({ persistAudioGenerationResult: vi.fn() }));
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

import { executeGeneration, type GenerationLease } from '../../src/services/generationService';

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
  mocks.store.nodes = [{ id: 'video', data: data() }];
  mocks.generate.mockReset().mockResolvedValue({ url: 'generated.mp4' });
  mocks.persist.mockReset().mockResolvedValue({ mediaUrl: 'saved.mp4', sourceUrl: 'generated.mp4', filePath: 'saved.mp4' });
  mocks.store.recordOutputHistory.mockReset().mockResolvedValue(undefined);
});

describe('节点视频生成的宿主任务租约', () => {
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
