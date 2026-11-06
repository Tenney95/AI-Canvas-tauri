/**
 * imageBatchService — 回归测试：imageBatchService。
 */
import type { Node } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { BatchImageResult } from '../../src/types/aiTypes';
import type { MediaGenerationResult } from '../../src/types/media';

interface TestStore {
  nodes: Node<BaseNodeData>[];
  currentProjectId: string | null;
  commitToHistory: ReturnType<typeof vi.fn>;
  addNodesTransient: ReturnType<typeof vi.fn>;
  updateNodeDataTransient: ReturnType<typeof vi.fn<(nodeId: string, patch: Partial<BaseNodeData>) => void>>;
  recordOutputHistory: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
}

let store: TestStore;
let generatedId = 0;

const persistMediaUrlToProjectData = vi.fn();
const completeMediaNodeTask = vi.fn();
const pauseMediaTask = vi.fn();
const savedHistory = new Map<string, Array<{ status: string; params?: Record<string, unknown> }>>();
vi.mock('../../src/services/indexedDbService', () => ({
  getNodeHistoryEntries: async (_projectId: string, nodeId: string) => savedHistory.get(nodeId) ?? [],
}));
vi.mock('../../src/services/pollManager', () => ({ completeMediaNodeTask, pauseMediaTask, completeComfyNodeTask: vi.fn() }));
vi.mock('../../src/services/ai/providers/runninghubWorkflow', () => ({ getRunningHubPersistedOutput: () => undefined, completeRunningHubNodeTask: vi.fn() }));

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: {
    getState: () => store,
  },
}));

vi.mock('../../src/store/store.utils', () => ({
  generateId: () => `generated-${++generatedId}`,
}));

vi.mock('../../src/services/fileService', () => ({
  persistMediaUrlToProjectData,
}));

function createStore(): TestStore {
  const sourceNode: Node<BaseNodeData> = {
    id: 'source',
    type: 'ai-image',
    position: { x: 100, y: 200 },
    data: {
      type: 'ai-image',
      label: '原图节点',
      prompt: 'a cat',
      model: 'image-model',
      provider: 'general',
      batchCount: 4,
      nodeWidth: 280,
      nodeHeight: 220,
      status: 'idle',
      imageUrl: 'asset://old-image',
    },
  };

  const nextStore = {
    nodes: [sourceNode],
    currentProjectId: 'project-a',
    commitToHistory: vi.fn(),
    addNodesTransient: vi.fn((nodes: Node<BaseNodeData>[]) => {
      nextStore.nodes = [...nextStore.nodes, ...nodes];
    }),
    updateNodeDataTransient: vi.fn((nodeId: string, patch: Partial<BaseNodeData>) => {
      nextStore.nodes = nextStore.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, ...patch } }
        : node);
    }),
    recordOutputHistory: vi.fn(async (nodeId: string, entry: { status: string; params?: Record<string, unknown> }) => {
      savedHistory.set(nodeId, [...(savedHistory.get(nodeId) ?? []), entry]);
    }),
    showToast: vi.fn(),
  } satisfies TestStore;
  return nextStore;
}

beforeEach(() => {
  completeMediaNodeTask.mockClear(); pauseMediaTask.mockClear();
  generatedId = 0;
  savedHistory.clear();
  persistMediaUrlToProjectData.mockReset();
  persistMediaUrlToProjectData.mockImplementation(async (url: string) => ({
    mediaUrl: url,
    sourceUrl: url,
  }));
  store = createStore();
});

describe('imageBatchService', () => {
  const receipt = { projectId: 'project-a', nodeId: 'source', taskId: 'mj-original', attemptId: 'mj-attempt' };
  function fourCandidates(): BatchImageResult {
    return { requestedCount: 1, expectedOutputCount: 4, failedCount: 0, allTasksSettled: true, taskReceipt: receipt,
      results: Array.from({ length: 4 }, (_, index) => ({ url: `https://example.com/${index + 1}.png`,
        width: 1024, height: 1024, taskReceipt: receipt })) };
  }

  it('reserves separate candidate space for three sequential jobs without overlapping any of the twelve nodes', async () => {
    const { prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const jobs = prepareImageBatchNodes({ nodeId: 'source', count: 3, projectId: 'project-a', slotStride: 4 });
    for (const nodeId of jobs.nodeIds) prepareImageBatchNodes({ nodeId, count: 4, projectId: 'project-a', commitHistory: false });
    expect(store.nodes).toHaveLength(12);
    expect(new Set(store.nodes.map((node) => `${node.position.x},${node.position.y}`)).size).toBe(12);
    expect(store.commitToHistory).toHaveBeenCalledOnce();
  });

  it('expands one placeholder into four outputs for one remote job and acknowledges that receipt once', async () => {
    const { applyImageBatchResults, imageBatchArtifactId } = await import('../../src/services/imageBatchService');
    expect(await applyImageBatchResults({ nodeId: 'source', targetNodeIds: ['source'], batch: fourCandidates(),
      projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1' })).toBe(true);
    expect(store.nodes).toHaveLength(4);
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    expect(store.nodes.map((node) => node.data.imageUrl)).toEqual([1, 2, 3, 4].map((index) => `https://example.com/${index}.png`));
    expect(store.nodes.map((node) => node.data.artifactId)).toEqual([0, 1, 2, 3].map((index) => imageBatchArtifactId(receipt, index)));
    expect(store.recordOutputHistory).toHaveBeenCalledTimes(4);
    expect(completeMediaNodeTask).toHaveBeenCalledOnce();
    expect(completeMediaNodeTask).toHaveBeenCalledWith(receipt);
  });

  it('keeps a migrated task artifact identity stable without conflating other attempts or projects', async () => {
    const { imageBatchArtifactId } = await import('../../src/services/imageBatchService');
    expect(imageBatchArtifactId({ ...receipt, nodeId: 'recovery-node' }, 2)).toBe(imageBatchArtifactId(receipt, 2));
    expect(imageBatchArtifactId({ ...receipt, attemptId: 'another-attempt' }, 2)).not.toBe(imageBatchArtifactId(receipt, 2));
    expect(imageBatchArtifactId({ ...receipt, projectId: 'another-project' }, 2)).not.toBe(imageBatchArtifactId(receipt, 2));
    expect(imageBatchArtifactId({ ...receipt, attemptId: undefined, nodeId: 'other-node' }, 2))
      .not.toBe(imageBatchArtifactId({ ...receipt, attemptId: undefined }, 2));
  });

  it('does not take sibling job placeholders or another job’s saved output as fixed candidates', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const jobs = prepareImageBatchNodes({ nodeId: 'source', count: 3, projectId: 'project-a', slotStride: 4 });
    store.updateNodeDataTransient(jobs.nodeIds[2], { artifactId: 'other-job-image', status: 'success', imageUrl: 'asset://other-job' });
    const untouched = store.nodes.slice(1).map((node) => ({ id: node.id, data: { ...node.data } }));
    expect(await applyImageBatchResults({ nodeId: 'source', batch: fourCandidates(), projectId: 'project-a',
      prompt: 'cat', imageSize: '1K', aspectRatio: '1:1', commitHistory: false })).toBe(true);
    expect(store.nodes).toHaveLength(6);
    for (const expected of untouched) expect(store.nodes.find((node) => node.id === expected.id)?.data).toEqual(expected.data);
    expect(store.nodes.filter((node) => node.data.batchGroupId === store.nodes[0].data.batchGroupId)).toHaveLength(4);
  });

  it('does not overwrite a different artifact supplied as an explicit candidate target', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const targets = prepareImageBatchNodes({ nodeId: 'source', count: 4, projectId: 'project-a' });
    store.updateNodeDataTransient(targets.nodeIds[2], { artifactId: 'other-job-image', status: 'success', imageUrl: 'asset://other-job' });
    expect(await applyImageBatchResults({ nodeId: 'source', targetNodeIds: targets.nodeIds, batch: fourCandidates(), projectId: 'project-a',
      prompt: 'cat', imageSize: '1K', aspectRatio: '1:1', commitHistory: false })).toBe(true);
    expect(store.nodes).toHaveLength(5);
    expect(store.nodes.find((node) => node.id === targets.nodeIds[2])?.data).toMatchObject({ artifactId: 'other-job-image', imageUrl: 'asset://other-job' });
  });

  it('resumes only a failed slot without downloading successful images, duplicating nodes or duplicating history', async () => {
    const { applyImageBatchResults } = await import('../../src/services/imageBatchService');
    let fail = true;
    persistMediaUrlToProjectData.mockImplementation(async (url: string) => {
      if (fail && url.endsWith('/2.png')) throw new Error('disk full');
      return { mediaUrl: `asset://saved/${url.split('/').pop()}`, sourceUrl: url, filePath: `saved/${url.split('/').pop()}` };
    });
    const input = { nodeId: 'source', batch: fourCandidates(), projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1' };
    expect(await applyImageBatchResults(input)).toBe(false);
    const firstIds = store.nodes.map((node) => node.id);
    expect(store.recordOutputHistory).toHaveBeenCalledTimes(3);
    expect(completeMediaNodeTask).not.toHaveBeenCalled();
    // 恢复查询会让源节点重新进入 loading，已保存文件仍应被复用。
    store.updateNodeDataTransient('source', { status: 'loading' });
    fail = false;
    persistMediaUrlToProjectData.mockClear();
    expect(await applyImageBatchResults(input)).toBe(true);
    expect(store.nodes.map((node) => node.id)).toEqual(firstIds);
    expect(persistMediaUrlToProjectData).toHaveBeenCalledOnce();
    expect(persistMediaUrlToProjectData.mock.calls[0][0]).toBe('https://example.com/2.png');
    expect(store.recordOutputHistory).toHaveBeenCalledTimes(4);
    expect(completeMediaNodeTask).toHaveBeenCalledOnce();
  });

  it('restores a missing output slot without shifting the other saved candidates', async () => {
    const { applyImageBatchResults, imageBatchArtifactId } = await import('../../src/services/imageBatchService');
    let fail = true;
    persistMediaUrlToProjectData.mockImplementation(async (url: string) => {
      if (fail && url.endsWith('/2.png')) throw new Error('disk full');
      return { mediaUrl: url, sourceUrl: url };
    });
    const input = { nodeId: 'source', batch: fourCandidates(), projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1' };
    await applyImageBatchResults(input);
    const third = store.nodes.find((node) => node.data.artifactId === imageBatchArtifactId(receipt, 2))!;
    const fourth = store.nodes.find((node) => node.data.artifactId === imageBatchArtifactId(receipt, 3))!;
    store.nodes = store.nodes.filter((node) => node.data.artifactId !== imageBatchArtifactId(receipt, 1));
    fail = false;
    expect(await applyImageBatchResults(input)).toBe(true);
    expect(store.nodes).toHaveLength(4);
    expect(store.nodes.find((node) => node.id === third.id)?.data.imageUrl).toBe('https://example.com/3.png');
    expect(store.nodes.find((node) => node.id === fourth.id)?.data.imageUrl).toBe('https://example.com/4.png');
  });

  it('uses persisted chat artifacts without another download and defers acknowledgment until all messages are durable', async () => {
    const { applyImageBatchResults, imageBatchArtifactId } = await import('../../src/services/imageBatchService');
    const artifacts: MediaGenerationResult[] = [0, 1, 2, 3].map((index) => ({ id: imageBatchArtifactId(receipt, index),
      kind: 'image', deliveryMode: 'both', taskReceipt: receipt, url: `asset://saved/${index}.png`, sourceUrl: `https://example.com/${index + 1}.png`,
      filePath: `saved/${index}.png`, persistence: index === 2 ? 'failed' : 'saved', persistError: index === 2 ? 'disk full' : undefined,
      prompt: 'cat', modelId: 'mj', provider: 'general', createdAt: 1 }));
    const input = { nodeId: 'source', batch: fourCandidates(), projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1',
      artifacts, deferTaskCompletion: true, commitHistory: false };
    expect(await applyImageBatchResults(input)).toBe(false);
    expect(persistMediaUrlToProjectData).not.toHaveBeenCalled();
    expect(store.commitToHistory).not.toHaveBeenCalled();
    expect(completeMediaNodeTask).not.toHaveBeenCalled();
    artifacts[2] = { ...artifacts[2], persistence: 'saved', persistError: undefined };
    expect(await applyImageBatchResults(input)).toBe(true);
    expect(store.recordOutputHistory).toHaveBeenCalledTimes(4);
    expect(persistMediaUrlToProjectData).not.toHaveBeenCalled();
    expect(completeMediaNodeTask).not.toHaveBeenCalled();
  });

  it('does not acknowledge a fixed four-output job when the terminal response only contains three', async () => {
    const { applyImageBatchResults } = await import('../../src/services/imageBatchService');
    const batch = fourCandidates();
    batch.results = batch.results.slice(0, 3);
    batch.failedCount = 1;
    expect(await applyImageBatchResults({ nodeId: 'source', batch, projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1' })).toBe(false);
    expect(store.nodes).toHaveLength(4);
    expect(completeMediaNodeTask).not.toHaveBeenCalled();
    expect(pauseMediaTask).toHaveBeenCalledWith(receipt, undefined, 'delivery_pending');
    const targetIds = store.nodes.map((node) => node.id);
    persistMediaUrlToProjectData.mockClear();
    expect(await applyImageBatchResults({ nodeId: 'source', batch, projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1' })).toBe(false);
    expect(store.nodes.map((node) => node.id)).toEqual(targetIds);
    expect(persistMediaUrlToProjectData).not.toHaveBeenCalled();
    expect(store.recordOutputHistory).toHaveBeenCalledTimes(3);
  });

  it('keeps each batch result download access isolated during persistence', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const prepared = prepareImageBatchNodes({ nodeId: 'source', count: 2, projectId: 'project-a' });
    const imageAccess = { providerConfigId: 'relay-image', origin: 'https://relayonapi.com', auth: { type: 'bearer' as const } };
    const controller = new AbortController();
    await applyImageBatchResults({ nodeId: 'source', targetNodeIds: prepared.nodeIds, batch: { requestedCount: 2, failedCount: 0, results: [
      { url: 'https://relayonapi.com/1.png', width: 1, height: 1, mediaDownloadAccess: imageAccess },
      { url: 'https://cdn.example/2.png', width: 1, height: 1 },
    ] }, projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1', signal: controller.signal });
    expect(persistMediaUrlToProjectData).toHaveBeenCalledWith('https://relayonapi.com/1.png', 'project-a', 'ai-image', '原图节点-1', { mediaDownloadAccess: imageAccess, signal: controller.signal });
    expect(persistMediaUrlToProjectData).toHaveBeenCalledWith('https://cdn.example/2.png', 'project-a', 'ai-image', '原图节点-2', { mediaDownloadAccess: undefined, signal: controller.signal });
    expect(store.nodes.some((node) => 'mediaDownloadAccess' in node.data)).toBe(false);
  });

  it('取消批量保存会停止下载且不回填、写成功历史或确认原任务', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const prepared = prepareImageBatchNodes({ nodeId: 'source', count: 2, projectId: 'project-a' });
    const controller = new AbortController();
    const receipt = { projectId: 'project-a', nodeId: 'source', taskId: 'original', attemptId: 'first' };
    persistMediaUrlToProjectData.mockImplementation((_url, _project, _kind, _label, options: { signal: AbortSignal }) => (
      new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    ));
    const initialCallCount = persistMediaUrlToProjectData.mock.calls.length;
    const pending = applyImageBatchResults({ nodeId: 'source', targetNodeIds: prepared.nodeIds,
      batch: { requestedCount: 2, failedCount: 0, results: [
        { url: 'https://example.com/1.png', width: 1, height: 1, taskReceipt: receipt },
        { url: 'https://example.com/2.png', width: 1, height: 1, taskReceipt: receipt },
      ] }, projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1', signal: controller.signal });
    await vi.waitFor(() => expect(persistMediaUrlToProjectData.mock.calls.length).toBe(initialCallCount + 2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.updateNodeDataTransient.mock.calls.every(([, patch]) => patch.status !== 'success')).toBe(true);
    expect(store.recordOutputHistory).not.toHaveBeenCalled();
    expect(completeMediaNodeTask).not.toHaveBeenCalled();
  });

  it('完成历史写入时已取消，不能清掉批量任务', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const prepared = prepareImageBatchNodes({ nodeId: 'source', count: 1, projectId: 'project-a' });
    const controller = new AbortController();
    const receipt = { projectId: 'project-a', nodeId: 'source', taskId: 'original', attemptId: 'first' };
    store.recordOutputHistory.mockImplementationOnce(async () => controller.abort());
    await expect(applyImageBatchResults({ nodeId: 'source', targetNodeIds: prepared.nodeIds,
      batch: { requestedCount: 1, failedCount: 0, results: [
        { url: 'https://example.com/1.png', width: 1, height: 1, taskReceipt: receipt },
      ] }, projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(completeMediaNodeTask).not.toHaveBeenCalled();
  });
  it('records the selected quality and background for every delivered image', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const prepared = prepareImageBatchNodes({ nodeId: 'source', count: 2, projectId: 'project-a' });
    await applyImageBatchResults({ nodeId: 'source', targetNodeIds: prepared.nodeIds,
      batch: { requestedCount: 2, failedCount: 0, results: [
        { url: 'https://example.com/1.png', width: 2048, height: 1152 },
        { url: 'https://example.com/2.png', width: 2048, height: 1152 },
      ] }, projectId: 'project-a', prompt: 'cat', imageSize: '2K', imageQuality: 'max', imageBackground: 'transparent', aspectRatio: '16:9' });
    expect(store.recordOutputHistory).toHaveBeenCalledTimes(2);
    for (const [, record] of store.recordOutputHistory.mock.calls) {
      expect(record.params).toMatchObject({ imageSize: '2K', imageQuality: 'max', imageBackground: 'transparent', aspectRatio: '16:9' });
    }
  });
  it('keeps the explicit API-default choice in batch nodes while history records the effective omission', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    store.nodes[0].data.imageBackground = '';
    const prepared = prepareImageBatchNodes({ nodeId: 'source', count: 2, projectId: 'project-a' });
    expect(store.nodes.map((node) => node.data.imageBackground)).toEqual(['', '']);
    await applyImageBatchResults({ nodeId: 'source', targetNodeIds: prepared.nodeIds,
      batch: { requestedCount: 2, failedCount: 0, results: [
        { url: 'https://example.com/1.png', width: 2048, height: 1152 },
        { url: 'https://example.com/2.png', width: 2048, height: 1152 },
      ] }, projectId: 'project-a', prompt: 'cat', imageSize: '2K', aspectRatio: '16:9', imageBackground: undefined });
    expect(store.recordOutputHistory).toHaveBeenCalledTimes(2);
    for (const [, record] of store.recordOutputHistory.mock.calls) expect(record.params.imageBackground).toBeUndefined();
  });
  it('部分任务明确失败且其余任务均已终态时，成功产物交付后结束聚合记录', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const receipt = { projectId: 'project-a', nodeId: 'source', taskId: 'original', attemptId: 'first' };
    const prepared = prepareImageBatchNodes({ nodeId: 'source', count: 2, projectId: 'project-a' });
    const complete = await applyImageBatchResults({ nodeId: 'source', targetNodeIds: prepared.nodeIds,
      batch: { requestedCount: 2, failedCount: 1, allTasksSettled: true,
        results: [{ url: 'https://example.com/1.png', width: 1, height: 1, taskReceipt: receipt }] },
      projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1' });
    expect(complete).toBe(true);
    expect(completeMediaNodeTask).toHaveBeenCalledWith(receipt);
    expect(pauseMediaTask).not.toHaveBeenCalled();
    expect(store.nodes[1].data.status).toBe('error');
    expect(store.nodes[1].data.error).toContain('上游任务已结束');
  });

  it('部分任务查询仍不确定时，成功产物已保存也保留聚合记录', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const receipt = { projectId: 'project-a', nodeId: 'source', taskId: 'original', attemptId: 'first' };
    const prepared = prepareImageBatchNodes({ nodeId: 'source', count: 2, projectId: 'project-a' });
    const complete = await applyImageBatchResults({ nodeId: 'source', targetNodeIds: prepared.nodeIds,
      batch: { requestedCount: 2, failedCount: 1, allTasksSettled: false,
        results: [{ url: 'https://example.com/1.png', width: 1, height: 1, taskReceipt: receipt }] },
      projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1' });
    expect(complete).toBe(false);
    expect(completeMediaNodeTask).not.toHaveBeenCalled();
    expect(pauseMediaTask).toHaveBeenCalledWith(receipt, undefined, 'delivery_pending');
  });

  it('保存失败不重新排列后续产物，也不清理部分交付的聚合任务', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const receipt = { projectId: 'project-a', nodeId: 'source', taskId: 'original', attemptId: 'first' };
    const saveError = new Error('disk full');
    const prepared = prepareImageBatchNodes({ nodeId: 'source', count: 2, projectId: 'project-a' });
    persistMediaUrlToProjectData.mockImplementation(async (url: string) => {
      if (url.endsWith('/1.png')) throw saveError;
      return { mediaUrl: url, sourceUrl: url };
    });
    await applyImageBatchResults({ nodeId: 'source', targetNodeIds: prepared.nodeIds,
      batch: { requestedCount: 2, failedCount: 0, results: [
        { url: 'https://example.com/1.png', width: 1, height: 1, taskReceipt: receipt },
        { url: 'https://example.com/2.png', width: 1, height: 1, taskReceipt: receipt },
      ] }, projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1' });
    expect(store.nodes[0].data.status).toBe('error');
    expect(store.nodes[1].data.imageUrl).toBe('https://example.com/2.png');
    expect(completeMediaNodeTask).not.toHaveBeenCalled();
    expect(pauseMediaTask).toHaveBeenCalledWith(receipt, saveError, 'delivery_pending');
  });

  it('整批保存和写回成功后才确认原任务', async () => {
    const { applyImageBatchResults } = await import('../../src/services/imageBatchService');
    const receipt = { projectId: 'project-a', nodeId: 'source', taskId: 'original', attemptId: 'first' };
    await applyImageBatchResults({ nodeId: 'source', targetNodeIds: ['source'],
      batch: { requestedCount: 1, failedCount: 0, results: [{ url: 'https://example.com/1.png', width: 1, height: 1, taskReceipt: receipt }] },
      projectId: 'project-a', prompt: 'cat', imageSize: '1K', aspectRatio: '1:1' });
    expect(completeMediaNodeTask).toHaveBeenCalledWith(receipt);
    expect(store.updateNodeDataTransient.mock.invocationCallOrder[0]).toBeLessThan(completeMediaNodeTask.mock.invocationCallOrder[0]);
  });
  it('数量 4 时保留原节点，并立即在右侧创建 3 个加载节点', async () => {
    const { prepareImageBatchNodes } = await import('../../src/services/imageBatchService');

    const prepared = prepareImageBatchNodes({
      nodeId: 'source',
      count: 4,
      projectId: 'project-a',
    });

    expect(prepared.nodeIds).toHaveLength(4);
    expect(prepared.nodeIds[0]).toBe('source');
    expect(store.nodes).toHaveLength(4);
    expect(store.commitToHistory).toHaveBeenCalledTimes(1);
    expect(store.nodes.map((node) => node.data.status)).toEqual([
      'loading',
      'loading',
      'loading',
      'loading',
    ]);
    expect(store.nodes.slice(1).map((node) => node.position)).toEqual([
      { x: 420, y: 200 },
      { x: 740, y: 200 },
      { x: 1060, y: 200 },
    ]);
    expect(store.nodes.slice(1).every((node) => node.position.x > 100)).toBe(true);
    expect(store.nodes.slice(1).map((node) => node.data.batchCount)).toEqual([1, 1, 1]);
    expect(store.nodes.slice(1).map((node) => node.data.imageUrl)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('把成功结果依次回填，并将缺少结果的加载节点标记为失败', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const prepared = prepareImageBatchNodes({
      nodeId: 'source',
      count: 4,
      projectId: 'project-a',
    });

    await applyImageBatchResults({
      nodeId: 'source',
      targetNodeIds: prepared.nodeIds,
      batch: {
        requestedCount: 4,
        results: [
          { url: 'https://example.com/1.png', width: 1024, height: 1024 },
          { url: 'https://example.com/2.png', width: 1024, height: 1024 },
        ],
        failedCount: 2,
      },
      projectId: 'project-a',
      prompt: 'a cat',
      imageSize: '1K',
      aspectRatio: '1:1',
    });

    expect(store.nodes.map((node) => node.data.status)).toEqual([
      'success',
      'success',
      'error',
      'error',
    ]);
    expect(store.nodes[0].data.imageUrl).toBe('https://example.com/1.png');
    expect(store.nodes[1].data.imageUrl).toBe('https://example.com/2.png');
    expect(store.nodes[2].data.error).toContain('未返回结果');
    expect(store.recordOutputHistory).toHaveBeenCalledTimes(2);
    expect(store.showToast).toHaveBeenCalledWith('批量生成完成：成功 2/4 张', 'error');
  });

  it('stores inline batch results as local project references only', async () => {
    const { applyImageBatchResults } = await import('../../src/services/imageBatchService');
    const inline = 'data:image/png;base64,AQID';
    persistMediaUrlToProjectData.mockResolvedValueOnce({
      filePath: '/project/data/原图节点-1.png',
      assetUrl: 'asset:///project/data/原图节点-1.png',
      mediaUrl: 'asset:///project/data/原图节点-1.png',
      sourceUrl: 'asset:///project/data/原图节点-1.png',
    });

    await applyImageBatchResults({
      nodeId: 'source',
      targetNodeIds: ['source'],
      batch: {
        requestedCount: 1,
        failedCount: 0,
        results: [{ url: inline, width: 10, height: 10 }],
      },
      projectId: 'project-a',
      prompt: 'a cat',
      imageSize: '2K',
      aspectRatio: '1:1',
    });

    expect(JSON.stringify(store.nodes[0].data)).not.toContain('data:image');
    expect(store.nodes[0].data).toMatchObject({
      imageUrl: 'asset:///project/data/原图节点-1.png',
      sourceUrl: 'asset:///project/data/原图节点-1.png',
      thumbnailUrl: 'asset:///project/data/原图节点-1.png',
      output: 'asset:///project/data/原图节点-1.png',
      filePath: '/project/data/原图节点-1.png',
    });
    expect(JSON.stringify(store.recordOutputHistory.mock.calls[0][1])).not.toContain('data:image');
  });
});
