import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import type { CanvasContext } from '../../src/types/project';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';

const io = vi.hoisted(() => ({ context: null as unknown as CanvasContext, records: [] as NativeMediaTaskRecord[],
  nodes: [] as Node<BaseNodeData>[], edges: [] as Edge[], update: vi.fn(), summary: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({
  currentProjectId: io.context.canvasId, projectExecutionContext: io.context, nodes: io.nodes,
  edges: io.edges, projects: [{ id: io.context.canvasId }], config: { generalModels: [], providers: {} }, customStyles: [],
  updateNodeDataTransient: io.update,
}) } }));
vi.mock('../../src/services/projectExecutionContext', () => ({
  isProjectExpectedContextCurrent: (context: CanvasContext) => context.canvasId === io.context.canvasId
    && context.projectId === io.context.projectId && context.projectEpoch === io.context.projectEpoch
    && context.canvasEpoch === io.context.canvasEpoch && context.runtimeEpoch === io.context.runtimeEpoch,
  captureLegacyCanvasContext: () => io.context,
}));
vi.mock('../../src/services/indexedDb/nativeMediaTaskRepository', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/nativeMediaTaskRepository')>(),
  listNativeMediaTasks: async () => io.records,
}));
vi.mock('../../src/services/nativeMediaRecoverySummary', () => ({ readNativeMediaRecoverySummary: io.summary }));
import { projectNativeMediaStoppedState } from '../../src/services/nativeMediaAutoDelivery';
import { assertNativeVideoSubmissionInput } from '../../src/services/nativeVideoSubmission';
import { nativeMediaInputMaterial } from '../../src/services/nativeMediaInput';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';
import { useAppStore } from '../../src/store/useAppStore';

beforeEach(() => {
  io.context = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'runtime', projectId: 'project',
    canvasId: 'canvas', episodeId: null, projectEpoch: 1, canvasEpoch: 1, canvasRevision: 1 };
  io.records = [{ kind: 'native-media-task-v1', projectId: 'media-task:original', operationId: 'original', ownerProjectId: 'project',
    canvasId: 'canvas', episodeId: null, projectEpoch: 1, canvasEpoch: 1, sourceCanvasRevision: 1, nodeId: 'node',
    inputFingerprint: 'a'.repeat(64), fingerprintScheme: 'media-input-v3', providerConfigId: 'fixture', providerBase: 'https://fixture.example',
    category: 'image', status: 'outcome-unknown', lease: 'lease', revision: 1, createdAt: 1, updatedAt: 1 }];
  io.nodes = [{ id: 'node', type: 'ai-image', position: { x: 0, y: 0 },
    data: { type: 'ai-image', label: '生成图片', prompt: '原输入', status: 'loading', mediaTaskStage: 'querying' } }];
  io.edges = [];
  io.update.mockReset().mockImplementation((id: string, patch: Partial<BaseNodeData>) => {
    io.nodes = io.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node);
  });
  io.summary.mockReset().mockResolvedValue({ canResume: false, cachedOnly: false, resultCount: 0, taskCount: 0 });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

it('无任务ID的未知提交停止转圈但保留原unknown记录，不发查询或生成', async () => {
  const original = structuredClone(io.records);
  expect(await projectNativeMediaStoppedState('original', io.context)).toBe(true);
  expect(io.nodes[0].data).toMatchObject({ status: 'error', mediaTaskState: 'submit_unknown' });
  expect(io.nodes[0].data.error).toContain('已停止等待');
  expect(io.nodes[0].data.mediaTaskStage).toBeUndefined();
  expect(io.records).toEqual(original);
  expect(fetch).not.toHaveBeenCalled();
  expect(await projectNativeMediaStoppedState('original', io.context)).toBe(false);
  expect(io.update).toHaveBeenCalledOnce();
});

it('明确失败退出loading，保留失败回执及已有媒体字段', async () => {
  io.records[0].status = 'failed'; io.records[0].remoteTaskId = 'original-remote-id';
  io.nodes[0].data.imageUrl = 'asset://previous-result';
  expect(await projectNativeMediaStoppedState('original', io.context)).toBe(true);
  expect(io.nodes[0].data).toMatchObject({ status: 'error', imageUrl: 'asset://previous-result' });
  expect(io.nodes[0].data.error).toContain('已失败');
  expect(io.nodes[0].data.mediaTaskState).toBeUndefined();
  expect(io.records[0]).toMatchObject({ status: 'failed', remoteTaskId: 'original-remote-id' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['busy', 'success', 'superseded', 'canvas', 'lease'] as const)('不误改%s场景的节点', async (reason) => {
  const original = io.context;
  if (reason === 'success') io.nodes[0].data = { ...io.nodes[0].data, status: 'success', imageUrl: 'asset://chosen' };
  if (reason === 'superseded') io.records.push({ ...io.records[0], operationId: 'new-attempt', sourceCanvasRevision: 2 });
  if (reason === 'canvas' || reason === 'lease') io.summary.mockImplementation(async () => {
    if (reason === 'canvas') io.context = { ...original, canvasId: 'another', runtimeEpoch: 'other' };
    else io.records = [{ ...io.records[0], lease: 'new-lease', revision: 2 }];
    return { canResume: false, cachedOnly: false, resultCount: 0, taskCount: 0 };
  });
  await projectNativeMediaStoppedState('original', original, { isNodeBusy: () => reason === 'busy' }).catch(() => false);
  expect(io.update).not.toHaveBeenCalled();
});

it('异步检查期间的新稿和运行所有权变化也不得被错误状态覆盖', async () => {
  io.summary.mockImplementation(async () => {
    io.nodes[0] = { ...io.nodes[0], data: { ...io.nodes[0].data, prompt: '新稿' } };
    return { canResume: false, cachedOnly: false, resultCount: 0, taskCount: 0 };
  });
  expect(await projectNativeMediaStoppedState('original', io.context)).toBe(false);
  expect(io.update).not.toHaveBeenCalled();
  let busy = false;
  io.summary.mockImplementation(async () => {
    busy = true;
    return { canResume: false, cachedOnly: false, resultCount: 0, taskCount: 0 };
  });
  expect(await projectNativeMediaStoppedState('original', io.context, { isNodeBusy: () => busy })).toBe(false);
  expect(io.update).not.toHaveBeenCalled();
});

it.each(['missing-quality', 'removed-reference', 'edited-draft'] as const)('真实输入摘要已变化时仅停止旧等待并完整保留当前稿件：%s', async (change) => {
  io.nodes[0].data = { ...io.nodes[0].data, prompt: '@{reference:原参考} 原输入', model: 'general/fixture',
    imageQuality: 'low', aspectRatio: '2:3', nodeWidth: 280, nodeHeight: 420, imageUrl: 'asset://previous-result',
    assetId: 'current-asset', relativePath: 'current-result.png' };
  io.nodes.push({ id: 'reference', type: 'source-image', position: { x: 1, y: 1 },
    data: { type: 'source-image', label: '原参考', imageUrl: 'asset://reference-image', assetId: 'reference-asset' } });
  const baseline = nativeMediaInputMaterial(io.nodes[0], useAppStore.getState(), 'media-input-v3');
  io.records[0].inputFingerprint = await sha256BytesHex(new TextEncoder().encode(baseline));
  await expect(assertNativeVideoSubmissionInput(io.records[0], io.context)).resolves.toBeUndefined();
  if (change === 'missing-quality') delete io.nodes[0].data.imageQuality;
  if (change === 'removed-reference') io.nodes = [io.nodes[0]];
  if (change === 'edited-draft') io.nodes[0].data = { ...io.nodes[0].data, prompt: '用户当前新稿', aspectRatio: '16:9', nodeHeight: 158 };
  const currentInput = nativeMediaInputMaterial(io.nodes[0], useAppStore.getState(), 'media-input-v3');
  expect(currentInput).not.toBe(baseline);
  await expect(assertNativeVideoSubmissionInput(io.records[0], io.context)).rejects.toThrow('原媒体输入或画布已变化');
  const before = structuredClone(io.nodes), receipt = structuredClone(io.records);
  expect(await projectNativeMediaStoppedState('original', io.context)).toBe(true);
  expect(io.nodes).toEqual(before.map((node) => node.id === 'node' ? { ...node, data: { ...node.data,
    status: 'error', error: expect.stringContaining('已停止等待'), mediaTaskState: 'submit_unknown', mediaTaskStage: undefined, videoTaskState: undefined } } : node));
  expect(nativeMediaInputMaterial(io.nodes[0], useAppStore.getState(), 'media-input-v3')).toBe(currentInput);
  expect(io.records).toEqual(receipt);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['remote', 'cached'] as const)('可续查的%s任务不投影成无身份未知', async (kind) => {
  if (kind === 'remote') io.records[0].remoteTaskId = 'original-id';
  else io.summary.mockResolvedValue({ canResume: true, cachedOnly: true, resultCount: 1, taskCount: 0 });
  expect(await projectNativeMediaStoppedState('original', io.context)).toBe(false);
  expect(io.update).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
