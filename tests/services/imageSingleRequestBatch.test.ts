/**
 * imageSingleRequestBatch — 回归测试：单次仅一张的普通图片模型批量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, BaseNodeData } from '../../src/types';

const mocks = vi.hoisted(() => ({
  store: {
    currentProjectId: 'p', nodes: [] as Array<{ id: string; type: string; position: { x: number; y: number }; data: BaseNodeData }>,
    config: { providers: {}, generalModels: [], theme: 'dark' } satisfies AppConfig, workflows: [], projects: [], customStyles: [],
    getCurrentRevision: vi.fn(), commitToHistory: vi.fn(), addNodesTransient: vi.fn(),
    updateNodeDataTransient: vi.fn(), updateNodeData: vi.fn(), recordOutputHistory: vi.fn(), showToast: vi.fn(),
  },
  image: vi.fn(), batch: vi.fn(), persist: vi.fn(), capability: vi.fn(), camera: vi.fn(),
  completeMedia: vi.fn(), pauseMedia: vi.fn(), pauseNode: vi.fn(), cancelPolling: vi.fn(), prepare: vi.fn(),
  revision: 0, sequence: 0,
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.store } }));
vi.mock('../../src/store/store.utils', () => ({ generateId: () => `batch-${++mocks.sequence}`, derivedNodePlacement: vi.fn() }));
vi.mock('../../src/services/aiService', () => ({ generateImage: mocks.image, generateImagesBatch: mocks.batch }));
vi.mock('../../src/services/ai/generateAudio', () => ({ persistAudioGenerationResult: vi.fn() }));
vi.mock('../../src/services/fileService', () => ({ persistMediaUrlToProjectData: mocks.persist }));
vi.mock('../../src/services/projectSettingsService', () => ({
  getProjectModelKind: () => 'image', parseProjectModelRef: () => undefined,
  resolveProjectGenerationPrompt: ({ prompt }: { prompt: string }) => `style:${prompt}`,
}));
vi.mock('../../src/services/dramaAssetExtract', () => ({ postProcessDramaExtractOutput: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: vi.fn() }));
vi.mock('../../src/services/ai/videoRequestResolver', () => ({ resolveVideoSubmissionControls: vi.fn() }));
vi.mock('../../src/services/shotlistService', () => ({ generateShotlistRows: vi.fn() }));
vi.mock('../../src/services/workflowExecutionService', () => ({ isCloudWorkflow: () => false, getCloudWorkflowPersistedOutput: () => undefined }));
vi.mock('../../src/services/workflowApi/workflowApiAdapter', () => ({ completeWorkflowApiNodeTask: vi.fn() }));
vi.mock('../../src/services/ai/providers/runninghubWorkflow', () => ({ completeRunningHubNodeTask: vi.fn(), getRunningHubPersistedOutput: () => undefined }));
vi.mock('../../src/services/videoBatchPlanning', () => ({ videoInputFingerprint: vi.fn() }));
vi.mock('../../src/services/ai/mediaModelCapabilities', () => ({ resolveImageParameterCapability: mocks.capability }));
vi.mock('../../src/services/ai/modelCapabilityValidation', () => ({ resolveConfiguredImageQuality: () => undefined, resolveConfiguredImageBackground: () => undefined }));
vi.mock('../../src/utils/cinematography', async (original) => ({
  ...await original<typeof import('../../src/utils/cinematography')>(), buildGenerationCameraPrompt: mocks.camera,
}));
vi.mock('../../src/services/pollManager', () => ({
  prepareMediaNodeGeneration: mocks.prepare,
  registerMediaNodeOperation: () => vi.fn(), completeMediaNodeTask: mocks.completeMedia,
  pauseMediaTask: mocks.pauseMedia, pauseMediaNodeTask: mocks.pauseNode, cancelNodePolling: mocks.cancelPolling,
  isMediaTaskPausedError: () => false, beginComfyNodeDelivery: vi.fn(), completeComfyNodeTask: vi.fn(), pauseComfyNodeDelivery: vi.fn(),
}));

import { cancelImageBatchGeneration, executeGeneration, isImageBatchGenerating, subscribeImageBatches, usesSequentialImageBatch } from '../../src/services/generationService';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function imageResult(nodeId: string) {
  return { url: `https://result.test/${nodeId}.png`, width: 1024, height: 1024,
    taskReceipt: { projectId: 'p', nodeId, taskId: `task-${nodeId}`, attemptId: `attempt-${nodeId}` } };
}
const patchNode = (nodeId: string, patch: Partial<BaseNodeData>) => {
  mocks.store.nodes = mocks.store.nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node);
};

beforeEach(() => {
  vi.clearAllMocks(); mocks.revision = 0; mocks.sequence = 0;
  mocks.store.currentProjectId = 'p';
  mocks.store.nodes = [{ id: 'source', type: 'ai-image', position: { x: 0, y: 0 }, data: {
    type: 'ai-image', label: '生成图片', provider: 'general', model: 'general/flare', prompt: 'raw @reference', batchCount: 3,
  } }];
  mocks.store.getCurrentRevision.mockImplementation(() => mocks.revision);
  mocks.store.commitToHistory.mockImplementation(() => { mocks.revision += 1; });
  mocks.store.addNodesTransient.mockImplementation((nodes: typeof mocks.store.nodes) => { mocks.store.nodes.push(...nodes); });
  mocks.store.updateNodeDataTransient.mockImplementation(patchNode);
  mocks.store.updateNodeData.mockImplementation((nodeId: string, patch: Partial<BaseNodeData>) => {
    mocks.store.commitToHistory(); patchNode(nodeId, patch);
  });
  mocks.store.recordOutputHistory.mockResolvedValue(undefined);
  mocks.capability.mockReturnValue({ supportsBatch: false, maxBatchCount: 1 });
  mocks.camera.mockReturnValue('camera');
  mocks.image.mockImplementation(async ({ nodeId }: { nodeId: string }) => imageResult(nodeId));
  mocks.persist.mockImplementation(async (url: string) => ({ mediaUrl: `saved:${url}`, sourceUrl: url, filePath: 'saved.png' }));
  mocks.pauseMedia.mockReturnValue(undefined);
});
afterEach(() => { cancelImageBatchGeneration('source'); });

describe('单次仅一张的普通图片模型批量', () => {
  it('外层批量管理历史时，逐张生成不重复提交快照或弹出单节点通知', async () => {
    mocks.store.commitToHistory();
    await expect(executeGeneration('source', undefined, undefined, undefined, undefined,
      { history: 'transient', silent: true })).resolves.toEqual({ success: true });
    expect(mocks.image).toHaveBeenCalledTimes(3);
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.store.commitToHistory).toHaveBeenCalledOnce();
    expect(mocks.store.showToast).not.toHaveBeenCalled();
    expect(mocks.store.nodes.every((node) => node.data.status === 'success')).toBe(true);
  });

  it('只对明确单次上限为一的普通通用模型使用逐节点提交', () => {
    const config = mocks.store.config;
    expect(usesSequentialImageBatch('general', 'general/flare', config)).toBe(true);
    expect(usesSequentialImageBatch('general', 'general/flare', config, 'workflow')).toBe(false);
    expect(usesSequentialImageBatch('runninghubwf', 'runninghubwf/workflow', config)).toBe(false);
    mocks.capability.mockReturnValue({ supportsBatch: true, maxBatchCount: 4 });
    expect(usesSequentialImageBatch('general', 'general/flare', config)).toBe(false);
    mocks.capability.mockReturnValue({ maxBatchCount: 1 });
    expect(usesSequentialImageBatch('general', 'general/flare', config)).toBe(true);
    mocks.capability.mockReturnValue(undefined);
    expect(usesSequentialImageBatch('general', 'general/flare', config)).toBe(false);
  });

  it('创建三个节点后严格串行单图提交，每个节点独立保存并交付原回执，画布仅一个批量历史', async () => {
    const first = deferred<ReturnType<typeof imageResult>>();
    const second = deferred<ReturnType<typeof imageResult>>();
    mocks.image.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const notifications: boolean[] = [];
    const unsubscribe = subscribeImageBatches(() => notifications.push(isImageBatchGenerating('source')));
    try {
      const pending = executeGeneration('source');
      await vi.waitFor(() => expect(mocks.image).toHaveBeenCalledOnce());
      const ids = mocks.store.nodes.map((node) => node.id);
      expect(ids).toHaveLength(3);
      expect(ids.every(isImageBatchGenerating)).toBe(true);
      first.resolve(imageResult(ids[0]));
      await vi.waitFor(() => expect(mocks.image).toHaveBeenCalledTimes(2));
      expect(mocks.store.nodes[0].data.status).toBe('success');
      await expect(executeGeneration(ids[0])).resolves.toMatchObject({ success: false });
      await expect(executeGeneration(ids[2])).resolves.toMatchObject({ success: false });
      expect(mocks.image).toHaveBeenCalledTimes(2);
      second.resolve(imageResult(ids[1]));
      await expect(pending).resolves.toEqual({ success: true });
      expect(mocks.image.mock.calls.map(([request]) => request.nodeId)).toEqual(ids);
      expect(mocks.image.mock.calls.every(([request, signal]) => request.prompt === 'style:raw @reference\n\nCamera settings: camera.' && signal instanceof AbortSignal)).toBe(true);
      expect(mocks.batch).not.toHaveBeenCalled();
      expect(mocks.store.commitToHistory).toHaveBeenCalledOnce();
      expect(mocks.persist).toHaveBeenCalledTimes(3);
      expect(mocks.completeMedia.mock.calls.map(([receipt]) => receipt.nodeId)).toEqual(ids);
      expect(mocks.store.recordOutputHistory).toHaveBeenCalledTimes(3);
      expect(mocks.store.nodes.every((node) => node.data.status === 'success')).toBe(true);
      expect(mocks.store.nodes[0].data.batchCount).toBe(3);
      expect(notifications).toEqual([true, false]);
    } finally { unsubscribe(); }
  });

  it('首张失败即停，未提交节点退出loading且不自动重投', async () => {
    mocks.image.mockRejectedValueOnce(new Error('上游失败'));
    await expect(executeGeneration('source')).resolves.toEqual({ success: false, message: '上游失败' });
    expect(mocks.image).toHaveBeenCalledOnce();
    expect(mocks.store.nodes.map((node) => node.data.status)).toEqual(['error', 'idle', 'idle']);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(isImageBatchGenerating('source')).toBe(false);
  });

  it('取消会中止当前单图请求，保留当前pending并阻止后续提交', async () => {
    mocks.image.mockImplementationOnce((_request: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('已停止', 'AbortError')), { once: true });
    }));
    const pending = executeGeneration('source');
    await vi.waitFor(() => expect(mocks.image).toHaveBeenCalledOnce());
    const lastId = mocks.store.nodes[2].id;
    expect(cancelImageBatchGeneration(lastId)).toBe(true);
    expect(isImageBatchGenerating('source')).toBe(true);
    expect(mocks.pauseNode).toHaveBeenCalledWith('source');
    expect(mocks.cancelPolling).toHaveBeenCalledWith('source', true);
    await expect(pending).resolves.toMatchObject({ success: false });
    expect(mocks.image).toHaveBeenCalledOnce();
    expect(mocks.store.nodes.every((node) => node.data.status === 'idle')).toBe(true);
    expect(isImageBatchGenerating('source')).toBe(false);
  });

  it('项目切换后停止后续提交，不把迟到结果保存或写回其他项目', async () => {
    const first = deferred<ReturnType<typeof imageResult>>(); mocks.image.mockReturnValueOnce(first.promise);
    const pending = executeGeneration('source');
    await vi.waitFor(() => expect(mocks.image).toHaveBeenCalledOnce());
    mocks.store.currentProjectId = 'other';
    expect(isImageBatchGenerating('source')).toBe(false);
    expect(cancelImageBatchGeneration('source')).toBe(false);
    first.resolve(imageResult('source'));
    await expect(pending).resolves.toMatchObject({ success: false });
    expect(mocks.image).toHaveBeenCalledOnce(); expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.store.recordOutputHistory).not.toHaveBeenCalled();
  });

  it('当前图片输入变化且revision未变时，不保存迟到结果或启动后续请求', async () => {
    const first = deferred<ReturnType<typeof imageResult>>(); mocks.image.mockReturnValueOnce(first.promise);
    const pending = executeGeneration('source');
    await vi.waitFor(() => expect(mocks.image).toHaveBeenCalledOnce());
    const revision = mocks.revision;
    patchNode('source', { prompt: '用户刚修改的正文' });
    expect(mocks.revision).toBe(revision);
    first.resolve(imageResult('source'));
    await expect(pending).resolves.toMatchObject({ success: false });
    expect(mocks.image).toHaveBeenCalledOnce(); expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.store.recordOutputHistory).not.toHaveBeenCalled();
    expect(mocks.store.nodes[0].data.prompt).toBe('用户刚修改的正文');
    expect(mocks.store.nodes.every((node) => node.data.status === 'idle')).toBe(true);
  });

  it('后续图片停止时保留已完成源图，只暂停正在执行的节点', async () => {
    mocks.image.mockResolvedValueOnce(imageResult('source')).mockImplementationOnce((_request: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('已停止', 'AbortError')), { once: true });
    }));
    const pending = executeGeneration('source');
    await vi.waitFor(() => expect(mocks.image).toHaveBeenCalledTimes(2));
    const secondId = mocks.store.nodes[1].id;
    expect(mocks.store.nodes[0].data.status).toBe('success');
    expect(cancelImageBatchGeneration('source')).toBe(true);
    await expect(pending).resolves.toMatchObject({ success: false });
    expect(mocks.pauseNode).toHaveBeenCalledWith(secondId);
    expect(mocks.cancelPolling).toHaveBeenCalledWith(secondId, true);
    expect(mocks.store.nodes.map((node) => node.data.status)).toEqual(['success', 'idle', 'idle']);
    expect(mocks.image).toHaveBeenCalledTimes(2); expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.completeMedia).toHaveBeenCalledWith(imageResult('source').taskReceipt);
  });
});
