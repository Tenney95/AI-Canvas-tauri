/**
 * batchExecute — 回归测试：batchExecuteNodes。
 */
import type { Edge, Node } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';
import type { BatchContext } from '../../src/utils/batchExecute';
import { DRAMA_EXTRACT_MARKER } from '../../src/types/dramaAssets';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  generateImage: vi.fn(), generateImagesBatch: vi.fn(),
  generateVideo: vi.fn(),
  generateAudio: vi.fn(),
  buildPanoramaPrompt: vi.fn(),
  buildAnimationSpritePrompt: vi.fn(),
  resolveAnimationSheetAspectRatio: vi.fn(),
  persistAudioGenerationResult: vi.fn(),
  persistMediaUrlToProjectData: vi.fn(),
  syncDramaAssetImageFromNode: vi.fn(),
  mergeDramaExtract: vi.fn(),
  completeMedia: vi.fn(), pauseMedia: vi.fn(() => new Error('任务已保留')), endOperation: vi.fn(),
  actions: {} as Pick<AppState, 'updateNodeDataTransient' | 'recordOutputHistory' | 'commitToHistory'>,
  projects: [] as AppState['projects'], workflows: [] as AppState['workflows'], edges: [] as Edge[],
  showToast: vi.fn(),
  liveState: { currentProjectId: null as string | null, nodes: [] as Node<BaseNodeData>[], revision: 0 },
}));

vi.mock('../../src/services/aiService', () => ({
  generateText: mocks.generateText,
  generateImage: mocks.generateImage, generateImagesBatch: mocks.generateImagesBatch,
  generateVideo: mocks.generateVideo,
  generateAudio: mocks.generateAudio,
  buildPanoramaPrompt: mocks.buildPanoramaPrompt,
}));

vi.mock('../../src/services/ai/animationPrompt', () => ({
  buildAnimationSpritePrompt: mocks.buildAnimationSpritePrompt,
  resolveAnimationSheetAspectRatio: mocks.resolveAnimationSheetAspectRatio,
}));

vi.mock('../../src/services/ai/generateAudio', () => ({
  persistAudioGenerationResult: mocks.persistAudioGenerationResult,
}));

vi.mock('../../src/services/fileService', () => ({
  persistMediaUrlToProjectData: mocks.persistMediaUrlToProjectData,
}));
vi.mock('../../src/services/pollManager', () => ({
  prepareMediaNodeGeneration: vi.fn(), completeMediaNodeTask: mocks.completeMedia, pauseMediaTask: mocks.pauseMedia,
  registerMediaNodeOperation: () => mocks.endOperation,
  isMediaTaskPausedError: (error: unknown) => error instanceof Error && error.message === '视频查询已暂停',
  beginComfyNodeDelivery: vi.fn(), completeComfyNodeTask: vi.fn(), pauseComfyNodeDelivery: vi.fn(),
  prepareVideoNodeGeneration: vi.fn(), completeVideoNodeTask: vi.fn(), pauseVideoNodeTask: vi.fn(),
  getPendingTasksForProject: () => [],
  VideoPollingPausedError: class extends Error {
    constructor() { super('视频查询已暂停'); }
  },
}));
vi.mock('../../src/services/workflowExecutionService', async (original) => ({ ...await original<typeof import('../../src/services/workflowExecutionService')>(), getCloudWorkflowPersistedOutput: () => undefined }));
vi.mock('../../src/services/ai/providers/runninghubWorkflow', () => ({ completeRunningHubNodeTask: vi.fn(), getRunningHubPersistedOutput: () => undefined }));
vi.mock('../../src/services/shotlistService', () => ({ generateShotlistRows: vi.fn() }));
vi.mock('../../src/services/workflowApi/workflowApiAdapter', () => ({ completeWorkflowApiNodeTask: vi.fn() }));

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.liveState, ...mocks.actions,
      projects: mocks.projects, workflows: mocks.workflows, customStyles: [], edges: mocks.edges,
      showToast: mocks.showToast, updateNodeData: vi.fn(() => { throw new Error('批量不应逐节点提交历史'); }),
      addNodesTransient: (nodes: Node<BaseNodeData>[]) => { mocks.liveState.nodes = [...mocks.liveState.nodes, ...nodes]; },
      config: { providers: {}, generalModels: [] },
      getCurrentRevision: () => mocks.liveState.revision,
      syncDramaAssetImageFromNode: mocks.syncDramaAssetImageFromNode,
      mergeDramaExtract: mocks.mergeDramaExtract,
    }),
  },
}));

import { batchExecuteNodes as executeBatch } from '../../src/utils/batchExecute';
import { VideoPollingPausedError } from '../../src/services/pollManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createNode(
  id: string,
  type: BaseNodeData['type'] = 'ai-image',
  patch: Partial<BaseNodeData> = {},
): Node<BaseNodeData> {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type,
      prompt: `prompt-${id}`,
      model: `model-${id}`,
      provider: `provider-${id}`,
      status: 'idle',
      ...patch,
    } as BaseNodeData,
  };
}

type TestContext = BatchContext & Pick<AppState, 'updateNodeDataTransient' | 'recordOutputHistory'>;
function createContext(): TestContext {
  return {
    currentProjectId: 'default',
    commitToHistory: vi.fn(),
    updateNodeDataTransient: vi.fn((id, patch) => {
      mocks.liveState.nodes = mocks.liveState.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node);
    }),
    recordOutputHistory: vi.fn().mockResolvedValue(undefined),
  };
}

function batchExecuteNodes(ids: string[], nodes: Node<BaseNodeData>[], edges: Edge[], ctx: TestContext) {
  if (!mocks.liveState.nodes.length) mocks.liveState = { currentProjectId: ctx.currentProjectId, nodes, revision: 0 };
  mocks.actions = ctx;
  mocks.edges = edges;
  return executeBatch(ids, nodes, edges, ctx);
}

function createTextContext(node: Node<BaseNodeData>): TestContext {
  mocks.liveState = { currentProjectId: 'text-project', nodes: [node], revision: 0 };
  const ctx = createContext();
  ctx.currentProjectId = 'text-project';
  vi.mocked(ctx.updateNodeDataTransient).mockImplementation((nodeId, patch) => {
    mocks.liveState.nodes = mocks.liveState.nodes.map((current) => current.id === nodeId
      ? { ...current, data: { ...current.data, ...patch } } : current);
  });
  return ctx;
}

beforeEach(() => {
  mocks.completeMedia.mockClear(); mocks.pauseMedia.mockClear(); mocks.endOperation.mockClear();
  mocks.liveState = { currentProjectId: null, nodes: [], revision: 0 };
  mocks.projects = []; mocks.workflows = []; mocks.edges = []; mocks.showToast.mockClear();
  mocks.generateImagesBatch.mockReset();
  mocks.generateText.mockReset();
  mocks.generateImage.mockReset();
  mocks.generateVideo.mockReset();
  mocks.generateAudio.mockReset();
  mocks.buildPanoramaPrompt.mockReset().mockImplementation((prompt: string) => `panorama:${prompt}`);
  mocks.buildAnimationSpritePrompt.mockReset().mockImplementation((prompt: string) => `animation:${prompt}`);
  mocks.resolveAnimationSheetAspectRatio.mockReset().mockReturnValue('2:1');
  mocks.persistAudioGenerationResult.mockReset();
  mocks.persistMediaUrlToProjectData.mockReset().mockImplementation(async (url: string) => ({
    mediaUrl: url,
    sourceUrl: url,
  }));
  mocks.syncDramaAssetImageFromNode.mockReset();
  mocks.mergeDramaExtract.mockReset();
});

describe('batchExecuteNodes', () => {
  it.each(['character', 'scene', 'prop'].flatMap((kind) => (
    ['invalid-json', 'empty-items'].map((failure) => ({ kind: kind as keyof typeof DRAMA_EXTRACT_MARKER, failure }))
  )))('保留旧版源文本的原文并报告 $kind 提取失败：$failure', async ({ kind, failure }) => {
    const original = '原始剧本正文：林夏在深夜车站捡起一把旧雨伞。';
    const node = createNode('extract-text', 'ai-text', { role: 'source', output: original,
      prompt: `${DRAMA_EXTRACT_MARKER[kind]}\n# 剧本正文\n` });
    const ctx = createTextContext(node);
    mocks.generateText.mockResolvedValue(failure === 'invalid-json' ? '模型没有返回 JSON' : JSON.stringify({ kind, items: [] }));

    await expect(batchExecuteNodes([node.id], [node], [], ctx)).resolves.toEqual({ ok: 0, fail: 1, skipped: 0 });
    expect(mocks.generateText).toHaveBeenCalledWith({ prompt: expect.stringContaining(original), model: node.data.model, provider: node.data.provider });
    expect(mocks.liveState.nodes[0].data).toMatchObject({ role: 'source', output: original, status: 'error', error: expect.any(String) });
    expect(vi.mocked(ctx.updateNodeDataTransient).mock.calls.every(([, patch]) => !('output' in patch))).toBe(true);
    expect(ctx.recordOutputHistory).toHaveBeenCalledOnce();
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith(node.id, expect.objectContaining({ status: 'error', error: expect.any(String) }));
    expect(mocks.mergeDramaExtract).not.toHaveBeenCalled();
  });

  it.each(['character', 'scene', 'prop'] as const)('缺少正文时在本地阻止 %s 提取，不调用模型', async (kind) => {
    const node = createNode('empty-script', 'ai-text', { role: 'source', output: '  ',
      prompt: `${DRAMA_EXTRACT_MARKER[kind]}\n# 剧本正文\n` });
    const ctx = createTextContext(node);

    await expect(batchExecuteNodes([node.id], [node], [], ctx)).resolves.toEqual({ ok: 0, fail: 1, skipped: 0 });
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.mergeDramaExtract).not.toHaveBeenCalled();
    expect(mocks.liveState.nodes[0].data).toMatchObject({ output: '  ', status: 'error', error: expect.any(String) });
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith(node.id, expect.objectContaining({ status: 'error' }));
  });

  it.each(['character', 'scene', 'prop'] as const)('有效的 %s 提取仍生成简介并入库', async (kind) => {
    const node = createNode('valid-extract', 'ai-text', { role: 'source', output: '林夏在车站捡起雨伞。',
      prompt: `${DRAMA_EXTRACT_MARKER[kind]}\n# 剧本正文\n` });
    const ctx = createTextContext(node);
    mocks.generateText.mockResolvedValue(JSON.stringify({ kind, items: [{ name: '提取资产', summary: '资产简介', importance: 'main' }] }));

    await expect(batchExecuteNodes([node.id], [node], [], ctx)).resolves.toEqual({ ok: 1, fail: 0, skipped: 0 });
    expect(mocks.liveState.nodes[0].data).toMatchObject({ role: 'source', status: 'success', output: expect.stringContaining('提取资产') });
    expect(mocks.mergeDramaExtract).toHaveBeenCalledWith(expect.objectContaining({ kind }), { sourceNodeId: node.id, modelId: node.data.model });
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith(node.id, expect.objectContaining({ status: 'success', output: expect.stringContaining('提取资产') }));
  });

  it('普通文本生成保持原提示词和输出，不触发资产入库', async () => {
    const node = createNode('normal-text', 'ai-text', { prompt: '请润色这句普通文本', output: '旧内容' });
    const ctx = createTextContext(node);
    mocks.generateText.mockResolvedValue('生成后的普通文本');

    await expect(batchExecuteNodes([node.id], [node], [], ctx)).resolves.toEqual({ ok: 1, fail: 0, skipped: 0 });
    expect(mocks.generateText).toHaveBeenCalledWith({ prompt: node.data.prompt, model: node.data.model, provider: node.data.provider });
    expect(mocks.liveState.nodes[0].data.output).toBe('生成后的普通文本');
    expect(mocks.mergeDramaExtract).not.toHaveBeenCalled();
  });

  it.each(['project-switch', 'node-removed'])('文本请求完成时若已过期则不写回：%s', async (change) => {
    const node = createNode('late-text', 'ai-text', { output: '原文' });
    const ctx = createTextContext(node);
    const pending = deferred<string>();
    mocks.generateText.mockReturnValue(pending.promise);
    const execution = batchExecuteNodes([node.id], [node], [], ctx);
    await vi.waitFor(() => expect(mocks.generateText).toHaveBeenCalledOnce());
    if (change === 'project-switch') mocks.liveState.currentProjectId = 'another-project';
    else mocks.liveState.nodes = [];
    pending.resolve('迟到的生成结果');

    await expect(execution).resolves.toEqual({ ok: 0, fail: 1, skipped: 0 });
    expect(vi.mocked(ctx.updateNodeDataTransient).mock.calls.every(([, patch]) => !('output' in patch))).toBe(true);
    expect(ctx.recordOutputHistory).not.toHaveBeenCalled();
    expect(mocks.mergeDramaExtract).not.toHaveBeenCalled();
  });

  it('异步图片落盘失败时保留同一个任务，不清理或再次生成', async () => {
    const node = createNode('image', 'ai-image');
    const receipt = { projectId: 'project', nodeId: node.id, taskId: 'original', attemptId: 'first' };
    mocks.liveState = { currentProjectId: 'project', nodes: [node], revision: 0 };
    const ctx = createContext(); ctx.currentProjectId = 'project';
    mocks.generateImage.mockResolvedValueOnce({ url: 'remote.png', width: 1, height: 1, taskReceipt: receipt });
    mocks.persistMediaUrlToProjectData.mockRejectedValueOnce(new Error('disk full'));
    await batchExecuteNodes([node.id], [node], [], ctx);
    expect(mocks.completeMedia).not.toHaveBeenCalled();
    expect(mocks.pauseMedia).toHaveBeenCalledWith(receipt, expect.any(Error), 'delivery_pending');
    expect(mocks.generateImage).toHaveBeenCalledOnce();
    expect(mocks.endOperation).toHaveBeenCalledOnce();
  });

  it('只有保存和Store回填成功才确认异步图片原任务', async () => {
    const node = createNode('image', 'ai-image');
    const receipt = { projectId: 'project', nodeId: node.id, taskId: 'original', attemptId: 'first' };
    mocks.liveState = { currentProjectId: 'project', nodes: [node], revision: 0 };
    const ctx = createContext(); ctx.currentProjectId = 'project';
    mocks.generateImage.mockResolvedValueOnce({ url: 'remote.png', width: 1, height: 1, taskReceipt: receipt });
    await batchExecuteNodes([node.id], [node], [], ctx);
    expect(mocks.completeMedia).toHaveBeenCalledWith(receipt);
    const updateNode = vi.mocked(ctx.updateNodeDataTransient);
    const successCallIndex = updateNode.mock.calls.findIndex((call) => call[1].status === 'success');
    expect(successCallIndex).toBeGreaterThanOrEqual(0);
    expect(updateNode.mock.invocationCallOrder[successCallIndex]).toBeLessThan(mocks.completeMedia.mock.invocationCallOrder[0]);
  });

  it('批量执行将图片结果的下载连接传入保存层，不写入历史', async () => {
    const node = createNode('image', 'ai-image');
    mocks.liveState = { currentProjectId: 'project', nodes: [node], revision: 0 };
    const ctx = createContext(); ctx.currentProjectId = 'project';
    const mediaDownloadAccess = { providerConfigId: 'relay-image', origin: 'https://relayonapi.com', auth: { type: 'bearer' as const } };
    mocks.generateImage.mockResolvedValueOnce({ url: 'https://relayonapi.com/image', width: 1, height: 1, mediaDownloadAccess });
    await batchExecuteNodes([node.id], [node], [], ctx);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledWith('https://relayonapi.com/image', 'project', 'ai-image', 'image', { mediaDownloadAccess });
    expect(JSON.stringify(vi.mocked(ctx.recordOutputHistory).mock.calls)).not.toContain('mediaDownloadAccess');
  });
  it('does not mark a paused video query as a failed node or resubmit it', async () => {
    mocks.generateVideo.mockRejectedValueOnce(new VideoPollingPausedError());
    const node = createNode('slow-video', 'ai-video');
    const ctx = createContext();
    await batchExecuteNodes([node.id], [node], [], ctx);
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
    expect(ctx.recordOutputHistory).not.toHaveBeenCalled();
    expect(ctx.updateNodeDataTransient).not.toHaveBeenCalledWith(node.id, expect.objectContaining({ status: 'error' }));
  });
  it('queues workflows by display number and waits for generation and saving before starting the next', async () => {
    const generated = deferred<{ url: string }>();
    const saved = deferred<{ mediaUrl: string; sourceUrl: string }>();
    mocks.generateVideo.mockImplementation(async ({ nodeId }: { nodeId: string }) => (
      nodeId === 'random-z' ? generated.promise : { url: `${nodeId}.mp4` }
    ));
    mocks.persistMediaUrlToProjectData.mockImplementation(async (url: string) => (
      url === 'first.mp4' ? saved.promise : { mediaUrl: url, sourceUrl: url }
    ));
    const nodes = [
      createNode('random-a', 'ai-video', { provider: 'comfyui', workflowId: 'wf', displayId: 10 }),
      createNode('ordinary', 'ai-video'),
      createNode('random-z', 'ai-video', { provider: 'comfyui', workflowId: 'wf', displayId: 2 }),
    ];
    const ctx = createContext();
    ctx.currentProjectId = 'project';
    mocks.liveState = { currentProjectId: 'project', nodes, revision: 0 };
    const execution = batchExecuteNodes(nodes.map((node) => node.id), nodes, [], ctx);
    await vi.waitFor(() => expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['random-z', 'ordinary']));
    generated.resolve({ url: 'first.mp4' });
    await vi.waitFor(() => expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledWith(
      'first.mp4', 'project', 'ai-video', 'random-z',
      { mediaDownloadAccess: undefined },
    ));
    expect(mocks.generateVideo).toHaveBeenCalledTimes(2);
    saved.resolve({ mediaUrl: 'saved.mp4', sourceUrl: 'first.mp4' });
    await expect(execution).resolves.toEqual({ ok: 3, fail: 0, skipped: 0 });
    expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['random-z', 'ordinary', 'random-a']);
  });

  it('preserves dependencies through ordinary nodes while serializing all workflow types', async () => {
    mocks.generateVideo.mockResolvedValue({ url: 'result.mp4' });
    const nodes = [
      createNode('last', 'ai-video', { workflowId: 'cloud', provider: 'runninghubwf', displayId: 9 }),
      createNode('middle', 'ai-video'),
      createNode('first', 'ai-video', { workflowId: 'local', provider: 'comfyui', displayId: 1 }),
      createNode('before', 'ai-video'),
      createNode('after', 'ai-video'),
    ];
    const edges = [
      { id: 'a', source: 'before', target: 'first' },
      { id: 'b', source: 'first', target: 'middle' },
      { id: 'c', source: 'middle', target: 'last' },
      { id: 'd', source: 'last', target: 'after' },
    ];
    const originalEdges = structuredClone(edges);
    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, edges, createContext()))
      .resolves.toEqual({ ok: 5, fail: 0, skipped: 0 });
    expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId))
      .toEqual(['before', 'first', 'middle', 'last', 'after']);
    expect(edges).toEqual(originalEdges);
    expect(nodes.map((node) => node.id)).toEqual(['last', 'middle', 'first', 'before', 'after']);
  });

  it('prioritizes workflow display order over reverse edges and continues after a failure', async () => {
    mocks.generateVideo.mockRejectedValueOnce(new Error('workflow failed')).mockResolvedValue({ url: 'result.mp4' });
    const nodes = [
      createNode('ten', 'ai-video', { workflowId: 'wf', displayId: 10 }),
      createNode('two', 'ai-video', { workflowId: 'wf', displayId: 2 }),
    ];
    await expect(batchExecuteNodes(['ten', 'two'], nodes, [{ id: 'reverse', source: 'ten', target: 'two' }], createContext()))
      .resolves.toEqual({ ok: 1, fail: 1, skipped: 0 });
    expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['two', 'ten']);
  });

  it('keeps unnumbered workflows last in stable order and skips ineligible nodes', async () => {
    mocks.generateVideo.mockResolvedValue({ url: 'result.mp4' });
    const nodes = [
      createNode('old-b', 'ai-video', { workflowId: 'wf' }),
      createNode('loading', 'ai-video', { workflowId: 'wf', displayId: 1, status: 'loading' }),
      createNode('numbered', 'ai-video', { workflowId: 'wf', displayId: 2 }),
      createNode('old-a', 'ai-video', { workflowId: 'wf' }),
      createNode('empty', 'ai-video', { workflowId: 'wf', displayId: 3, prompt: '' }),
    ];
    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, [], createContext()))
      .resolves.toEqual({ ok: 3, fail: 0, skipped: 0 });
    expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['numbered', 'old-b', 'old-a']);
  });

  it('serializes connected nodes while starting isolated nodes concurrently', async () => {
    const pending = new Map([
      ['a', deferred<{ url: string; width: number; height: number }>()],
      ['b', deferred<{ url: string; width: number; height: number }>()],
      ['c', deferred<{ url: string; width: number; height: number }>()],
    ]);
    mocks.generateVideo.mockImplementation(({ nodeId }: { nodeId: string }) => pending.get(nodeId)!.promise);

    const nodes = ['a', 'b', 'c'].map((id) => createNode(id, 'ai-video'));
    const edges = [{ id: 'a-b', source: 'a', target: 'b' }] as Edge[];
    const ctx = createContext();
    const execution = batchExecuteNodes(nodes.map((node) => node.id), nodes, edges, ctx);

    await vi.waitFor(() => expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['a', 'c']));

    pending.get('c')!.resolve({ url: 'https://example.com/c.png', width: 64, height: 64 });
    pending.get('a')!.resolve({ url: 'https://example.com/a.png', width: 64, height: 64 });
    await vi.waitFor(() => {
      expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['a', 'c', 'b']);
    });

    pending.get('b')!.resolve({ url: 'https://example.com/b.png', width: 64, height: 64 });
    await expect(execution).resolves.toEqual({ ok: 3, fail: 0, skipped: 0 });
    expect(ctx.commitToHistory).toHaveBeenCalledTimes(1);
  });

  it('filters non-executable nodes and reports individual failures', async () => {
    mocks.generateImage
      .mockResolvedValueOnce({ url: 'https://example.com/ok.png', width: 64, height: 64 })
      .mockRejectedValueOnce(new Error('provider unavailable'));

    const nodes = [
      createNode('ok'),
      createNode('failed'),
      createNode('loading', 'ai-image', { status: 'loading' }),
      createNode('blank', 'ai-image', { prompt: '   ' }),
      createNode('group', 'group' as BaseNodeData['type']),
    ];
    const ctx = createContext();

    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, [], ctx)).resolves.toEqual({
      ok: 1,
      fail: 1,
      skipped: 0,
    });
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
    expect(ctx.updateNodeDataTransient).toHaveBeenCalledWith('failed', {
      status: 'error',
      error: 'provider unavailable',
    });
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith('failed', expect.objectContaining({
      status: 'error',
      error: 'provider unavailable',
    }));
  });

  it('forwards image and video parameters from each node snapshot', async () => {
    mocks.generateImage.mockResolvedValue({ url: 'https://example.com/image.png', width: 1280, height: 720 });
    mocks.generateVideo.mockResolvedValue({ url: 'https://example.com/video.mp4' });
    const nodes = [
      createNode('image', 'ai-image', {
        imageSize: '4K',
        aspectRatio: '16:9',
        workflowId: 'workflow-image',
        workflowInputs: { steps: '30' },
      }),
      createNode('video', 'ai-video', {
        videoResolution: 1280,
        videoFps: 30,
        videoFrames: 121,
        seedanceResolution: '1080p',
        seedanceRatio: '9:16',
        seedanceDuration: 10,
        generateAudio: true,
        workflowId: 'workflow-video',
        workflowInputs: { motion: '8' },
      }),
    ];

    await batchExecuteNodes(nodes.map((node) => node.id), nodes, [], createContext());

    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'image',
      imageSize: '4K',
      aspectRatio: '16:9',
      workflowId: 'workflow-image',
      workflowInputs: { steps: '30' },
    }));
    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'video',
      videoResolution: 1280,
      videoFps: 30,
      videoFrames: 301,
      seedanceResolution: '1080p',
      seedanceRatio: '9:16',
      seedanceDuration: 10,
      generateAudio: true,
      workflowId: 'workflow-video',
      workflowInputs: { motion: '8' },
    }));
  });

  it('does not inject legacy video defaults into direct general batch requests', async () => {
    mocks.generateVideo.mockResolvedValue({ url: 'https://example.com/video.mp4' });
    const node = createNode('general-video', 'ai-video', {
      provider: 'general',
      model: 'general/custom-video',
    });

    await expect(batchExecuteNodes([node.id], [node], [], createContext())).resolves.toEqual({
      ok: 1,
      fail: 0,
      skipped: 0,
    });

    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'general-video',
      videoResolution: undefined,
      videoFps: undefined,
      videoFrames: undefined,
      seedanceResolution: undefined,
      seedanceRatio: undefined,
      seedanceDuration: undefined,
    }));
  });

  it('forwards audio parameters and persists the generated result', async () => {
    mocks.generateAudio.mockResolvedValue({
      url: 'blob:audio-result',
      title: 'Generated title',
      lyrics: 'Generated lyrics',
      clipId: 'clip-1',
    });
    mocks.persistAudioGenerationResult.mockResolvedValue({
      mediaUrl: 'asset://audio.wav',
      sourceUrl: 'blob:audio-result',
      filePath: 'data/audio.wav',
      outputUrl: 'asset://audio.wav',
    });
    const node = createNode('audio', 'ai-audio', {
      audioVoice: 'nova',
      audioFormat: 'aac',
      audioSpeed: 1.25,
      musicTitle: 'Draft title',
      musicLyrics: 'Draft lyrics',
      musicBpm: 132,
      musicDuration: 90,
      autoGenerateLyrics: true,
      workflowId: 'workflow-audio',
      workflowInputs: { quality: 'high' },
    });
    const ctx = createContext();
    ctx.currentProjectId = 'project-a';
    mocks.liveState = { currentProjectId: 'project-a', nodes: [node], revision: 0 };

    await expect(batchExecuteNodes([node.id], [node], [], ctx)).resolves.toEqual({ ok: 1, fail: 0, skipped: 0 });

    expect(mocks.generateAudio).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'audio',
      audioVoice: 'nova',
      audioFormat: 'aac',
      audioSpeed: 1.25,
      musicTitle: 'Draft title',
      musicLyrics: 'Draft lyrics',
      musicBpm: 132,
      musicDuration: 90,
      autoGenerateLyrics: true,
      workflowId: 'workflow-audio',
      workflowInputs: { quality: 'high' },
    }));
    expect(mocks.persistAudioGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({ clipId: 'clip-1' }),
      'project-a',
      'audio',
    );
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith('audio', expect.objectContaining({
      params: expect.objectContaining({
        musicTitle: 'Generated title',
        musicBpm: 132,
        musicDuration: 90,
      }),
    }));
  });

  it('executes every node in a cycle while preserving dependencies outside the cycle', async () => {
    mocks.generateImage.mockImplementation(({ nodeId }: { nodeId: string }) => Promise.resolve({
      url: `https://example.com/${nodeId}.png`,
      width: 64,
      height: 64,
    }));
    const nodes = [
      createNode('downstream'),
      createNode('cycle-b'),
      createNode('cycle-a'),
      createNode('upstream'),
    ];
    const edges = [
      { id: 'upstream-a', source: 'upstream', target: 'cycle-a' },
      { id: 'a-b', source: 'cycle-a', target: 'cycle-b' },
      { id: 'b-a', source: 'cycle-b', target: 'cycle-a' },
      { id: 'b-downstream', source: 'cycle-b', target: 'downstream' },
    ] as Edge[];

    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, edges, createContext())).resolves.toEqual({
      ok: 4,
      fail: 0,
      skipped: 0,
    });
    expect(mocks.generateImage.mock.calls.map(([request]) => request.nodeId)).toEqual([
      'upstream',
      'cycle-b',
      'cycle-a',
      'downstream',
    ]);
  });

  it('maps animation and panorama requests without losing node-specific parameters', async () => {
    mocks.generateImage.mockResolvedValue({ url: 'https://example.com/result.png', width: 1280, height: 720 });
    const nodes = [
      createNode('animation', 'ai-animation', {
        imageSize: '4K',
        animationAction: 'run',
        animationFrames: 12,
      }),
      createNode('panorama', 'ai-panorama', {
        imageSize: '2K',
        aspectRatio: '21:9',
      }),
    ];
    const ctx = createContext();

    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, [], ctx)).resolves.toEqual({
      ok: 2,
      fail: 0,
      skipped: 0,
    });

    expect(mocks.resolveAnimationSheetAspectRatio).toHaveBeenCalledWith(12, 'provider-animation');
    expect(mocks.buildAnimationSpritePrompt).toHaveBeenCalledWith('prompt-animation', 'run', 12, '2:1', expect.objectContaining({ alignment: 'foot', ground: true }));
    expect(mocks.buildPanoramaPrompt).toHaveBeenCalledWith('prompt-panorama');
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'animation',
      prompt: 'animation:prompt-animation',
      imageSize: '4K',
      aspectRatio: '2:1',
    }));
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'panorama',
      prompt: 'panorama:prompt-panorama',
      imageSize: '2K',
      aspectRatio: '21:9',
    }));
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith('animation', expect.objectContaining({
      nodeType: 'ai-animation',
      params: expect.objectContaining({
        animationAction: 'run',
        animationFrames: 12,
        aspectRatio: '2:1',
      }),
    }));
    expect(ctx.updateNodeDataTransient).toHaveBeenCalledWith('animation', expect.objectContaining({ animationSheet: { cols: 4, rows: 3, frameCount: 12, action: 'run' }, animationEdits: undefined }));
  });

  it.each(['project', 'revision'])('discards an animation result after its %s changes', async (change) => {
    const waiting = deferred<{ url: string }>();
    const nodes = [createNode('animation', 'ai-animation')];
    const ctx = createContext(); ctx.currentProjectId = 'p1';
    mocks.liveState = { currentProjectId: 'p1', nodes, revision: 1 };
    mocks.generateImage.mockReturnValue(waiting.promise);
    const task = batchExecuteNodes(['animation'], nodes, [], ctx);
    await vi.waitFor(() => expect(mocks.generateImage).toHaveBeenCalledOnce());
    if (change === 'project') mocks.liveState.currentProjectId = 'p2'; else mocks.liveState.revision++;
    waiting.resolve({ url: 'https://example.com/stale.png' }); await task;
    expect(mocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
    expect(ctx.recordOutputHistory).not.toHaveBeenCalled();
    expect(ctx.updateNodeDataTransient).not.toHaveBeenCalledWith('animation', expect.objectContaining({ status: 'success' }));
  });

  it('批量复用项目默认模型、风格后缀与 RunningHub 参数，多图只提交一次历史', async () => {
    mocks.projects = [{ id: 'default', name: '项目', createdAt: 1, updatedAt: 1, settings: {
      defaultModels: { image: 'general/default-image' }, promptSuffixes: { image: '统一后缀' },
      visualStyle: { styleId: 'cinematic', prompt: '统一电影风格', locked: true },
    } }];
    const node = createNode('images', 'ai-image', { model: undefined, provider: undefined,
      batchCount: 3, runninghubModelParameters: { quality: 'high' } });
    mocks.generateImagesBatch.mockResolvedValue({ requestedCount: 3, failedCount: 0,
      results: [1, 2, 3].map((index) => ({ url: `https://example.com/${index}.png` })) });
    const ctx = createContext();
    await expect(batchExecuteNodes([node.id], [node], [], ctx)).resolves.toEqual({ ok: 1, fail: 0, skipped: 0 });
    expect(mocks.generateImagesBatch).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'general', model: 'general/default-image', runninghubModelParameters: { quality: 'high' },
      prompt: expect.stringContaining('统一后缀'),
    }), 3);
    expect(mocks.generateImagesBatch.mock.calls[0][0].prompt).toContain('统一电影风格');
    expect(mocks.liveState.nodes.filter((item) => item.data.status === 'success')).toHaveLength(3);
    expect(ctx.commitToHistory).toHaveBeenCalledOnce();
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith(node.id, expect.objectContaining({ model: 'general/default-image', provider: 'general' }));
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('空提示词云工作流和 RunningHub 可执行，显式清空的模型不会回退', async () => {
    mocks.workflows = [{ id: 'cloud', adapterType: 'workflow-api' } as AppState['workflows'][number]];
    mocks.projects = [{ id: 'default', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { defaultModels: { image: 'general/default' } } }];
    mocks.generateImage.mockResolvedValue({ url: 'https://example.com/image.png' });
    const nodes = [createNode('cloud', 'ai-image', { prompt: '', provider: 'workflow-api', workflowId: 'cloud' }),
      createNode('rh', 'ai-image', { prompt: '', provider: 'runninghub' }),
      createNode('deselected', 'ai-image', { model: '' })];
    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, [], createContext()))
      .resolves.toEqual({ ok: 2, fail: 0, skipped: 0 });
    expect(mocks.generateImage.mock.calls.map(([request]) => request.nodeId)).toEqual(['cloud', 'rh']);
  });

  it.each(['edit', 'remove', 'loading', 'project', 'revision'])('排队期间 %s 变化后跳过后继，不提交旧参数', async (change) => {
    const pending = deferred<{ url: string }>();
    mocks.generateImage.mockReturnValue(pending.promise);
    const nodes = [createNode('first'), createNode('next')];
    const ctx = createContext();
    const task = batchExecuteNodes(['first', 'next'], nodes, [{ id: 'link', source: 'first', target: 'next' }], ctx);
    await vi.waitFor(() => expect(mocks.generateImage).toHaveBeenCalledOnce());
    if (change === 'remove') mocks.liveState.nodes = mocks.liveState.nodes.filter((node) => node.id !== 'next');
    else if (change === 'project') mocks.liveState.currentProjectId = 'other';
    else if (change === 'revision') mocks.liveState.revision++;
    else ctx.updateNodeDataTransient('next', change === 'loading' ? { status: 'loading' } : { prompt: '新提示词' });
    pending.resolve({ url: 'https://example.com/result.png' });
    const result = await task;
    expect(result.skipped).toBe(1);
    expect(mocks.generateImage).toHaveBeenCalledOnce();
    expect(mocks.liveState.nodes.find((node) => node.id === 'next')?.data.error).toBeUndefined();
  });

  it('有依赖的链与独立节点共用三个执行名额，失败后保留成功结果且不重试', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => createNode(id));
    const releases = new Map<string, () => void>();
    let active = 0, peak = 0;
    mocks.generateImage.mockImplementation(async ({ nodeId }: { nodeId: string }) => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { releases.set(nodeId, resolve); });
      active--;
      if (nodeId === 'd') throw new Error('上游拒绝');
      return { url: `https://example.com/${nodeId}.png` };
    });
    const task = batchExecuteNodes(nodes.map((node) => node.id), nodes, [{ id: 'ab', source: 'a', target: 'b' }], createContext());
    await vi.waitFor(() => expect(releases.size).toBe(3));
    expect([...releases.keys()]).toEqual(['a', 'c', 'd']);
    expect(releases.has('b')).toBe(false);
    releases.get('a')!(); releases.get('c')!(); releases.get('d')!();
    await vi.waitFor(() => expect(releases.size).toBe(6));
    for (const id of ['b', 'e', 'f']) releases.get(id)!();
    await expect(task).resolves.toEqual({ ok: 5, fail: 1, skipped: 0 });
    expect(peak).toBe(3);
    expect(mocks.generateImage).toHaveBeenCalledTimes(6);
  });
});
