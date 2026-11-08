/**
 * 图片节点批量生成生命周期：先在源节点右侧创建加载节点，再把批量结果逐一回填。
 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { BatchImageResult, ImageGenerationResult, MediaTaskReceipt } from '../types/aiTypes';
import type { MediaGenerationResult } from '../types/media';
import { MAX_IMAGE_BATCH_COUNT } from '../types/aiTypes';
import { generateId } from '../store/store.utils';
import { useAppStore } from '../store/useAppStore';
import { persistMediaUrlToProjectData, type PersistedProjectMedia } from './fileService';
import { runBatchTasks } from './ai/batchUtils';
import { completeRunningHubNodeTask, getRunningHubPersistedOutput } from './ai/providers/runninghubWorkflow';
import { completeComfyNodeTask, completeMediaNodeTask, pauseMediaTask } from './pollManager';
import { getNodeHistoryEntries } from './indexedDbService';
import { BATCH_NODE_GAP, BATCH_COLUMNS_RIGHT_OF_SOURCE } from './imageBatchLayout';

interface ApplyImageBatchParams {
  model?: string;
  provider?: string;
  silent?: boolean;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
  /** 对话消息持久化后再确认同一个远端作业。 */
  deferTaskCompletion?: boolean;
  /** 宿主批次已提交历史时，内部候选节点只做 transient 写入。 */
  commitHistory?: boolean;
  /** 已落盘的对话产物，不再次下载；failed 项保持待交付。 */
  artifacts?: readonly MediaGenerationResult[];
  nodeId: string;
  /** 提交请求前创建的目标节点；恢复旧任务时可缺省，由 batchGroupId 自动找回。 */
  targetNodeIds?: string[];
  batch: BatchImageResult;
  projectId: string | null | undefined;
  prompt: string;
  imageSize: string;
  imageQuality?: string;
  imageBackground?: string;
  aspectRatio: string;
}

interface PrepareImageBatchParams {
  commitHistory?: boolean;
  nodeId: string;
  count: number;
  projectId: string | null | undefined;
  /** 恢复时按输出序号保留已有槽位；空字符串表示需要补建的槽位。 */
  existingNodeIds?: string[];
  /** 固定多候选作业不能沿用外层串行批次的作业分组。 */
  batchGroupId?: string;
  /** 串行作业预留每次返回的候选槽位宽度，内层候选仍使用紧凑布局。 */
  slotStride?: number;
}

export interface PreparedImageBatchNodes {
  nodeIds: string[];
  batchGroupId: string;
}

interface SavedBatchItem {
  index: number;
  result: ImageGenerationResult;
  persisted: PersistedProjectMedia;
}

const MISSING_BATCH_RESULT_ERROR = '批量生成未返回结果';

/** 每个远端作业的第 index 个产物，首次交付与续存使用相同身份。 */
export function imageBatchArtifactId(receipt: MediaTaskReceipt, index: number): string {
  // 重新生成会把旧任务重挂到恢复节点；attemptId 不变，nodeId 会变化。
  return `image-output:${[receipt.projectId, receipt.attemptId ? `attempt:${receipt.attemptId}` : `node:${receipt.nodeId}`,
    receipt.taskId, String(index)]
    .map(encodeURIComponent).join(':')}`;
}

function emptyImageOutput(): Partial<BaseNodeData> {
  return {
    imageUrl: undefined,
    sourceUrl: undefined,
    filePath: undefined,
    assetId: undefined,
    relativePath: undefined,
    artifactId: undefined,
    fileName: undefined,
    mattingMask: undefined,
    annotation: undefined,
    thumbnailUrl: undefined,
    output: undefined,
    imageWidth: undefined,
    imageHeight: undefined,
  };
}

/**
 * 数量包含源节点：选择 4 时保留源节点，并在其右侧立即创建 3 个加载节点。
 */
export function prepareImageBatchNodes({
  commitHistory = true,
  nodeId,
  count,
  projectId,
  existingNodeIds,
  batchGroupId: requestedGroupId,
  slotStride = 1,
}: PrepareImageBatchParams): PreparedImageBatchNodes {
  const store = useAppStore.getState();
  const sourceNode = store.nodes.find((node) => node.id === nodeId) as Node<BaseNodeData> | undefined;
  if (!sourceNode) throw new Error('生成节点不存在');
  if (store.currentProjectId !== projectId) throw new Error('任务已被取消');

  const requestedCount = Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(count)));
  const batchGroupId = requestedGroupId || (existingNodeIds && sourceNode.data.batchGroupId) || `image-batch-${generateId()}`;
  const liveIds = new Set(store.nodes.map((node) => node.id));
  const nodeIds = Array.from({ length: requestedCount }, (_, index) => index === 0 ? nodeId
    : existingNodeIds?.[index] && liveIds.has(existingNodeIds[index]) ? existingNodeIds[index] : '');
  const nodeWidth = (sourceNode.data.nodeWidth as number) || 280;
  const nodeHeight = (sourceNode.data.nodeHeight as number) || 280;
  const additionalNodes = nodeIds.flatMap((existingId, outputIndex) => {
    if (existingId) return [];
    const index = outputIndex - 1;
    const column = index % BATCH_COLUMNS_RIGHT_OF_SOURCE;
    const row = Math.floor(index / BATCH_COLUMNS_RIGHT_OF_SOURCE);
    const id = `node-${generateId()}`;
    nodeIds[outputIndex] = id;
    return [{
      id,
      type: 'ai-image',
      position: {
        x: sourceNode.position.x + (column + 1) * (nodeWidth + BATCH_NODE_GAP) * slotStride,
        y: sourceNode.position.y + row * (nodeHeight + BATCH_NODE_GAP),
      },
      data: {
        ...sourceNode.data,
        ...emptyImageOutput(),
        label: `${sourceNode.data.label} ${index + 2}`,
        type: 'ai-image',
        batchCount: 1,
        batchGroupId,
        status: 'loading',
        error: undefined,
      },
    } as Node<BaseNodeData>];
  });

  if (commitHistory) store.commitToHistory();
  store.updateNodeDataTransient(nodeId, {
    batchGroupId,
    ...(!existingNodeIds ? { status: 'loading' } : {}),
    error: undefined,
  });
  if (existingNodeIds) nodeIds.slice(1).filter((id) => liveIds.has(id)).forEach((id) => {
    store.updateNodeDataTransient(id, { batchGroupId });
  });
  store.addNodesTransient(additionalNodes);

  return {
    nodeIds,
    batchGroupId,
  };
}

/** 把同一次批量请求仍在等待的节点统一收敛为失败状态。 */
export function failImageBatchNodes(
  nodeIds: string[],
  error: string,
  projectId: string | null | undefined,
): void {
  const store = useAppStore.getState();
  if (store.currentProjectId !== projectId) return;
  const liveNodes = new Map(store.nodes.map((node) => [node.id, node]));
  nodeIds.forEach((nodeId) => {
    if (liveNodes.get(nodeId)?.data.status === 'loading') {
      store.updateNodeDataTransient(nodeId, { status: 'error', error });
    }
  });
}

function resolveBatchTargetNodeIds(
  sourceNode: Node<BaseNodeData>,
  requestedCount: number,
  explicitNodeIds?: string[],
): string[] {
  if (explicitNodeIds?.length) return explicitNodeIds.slice(0, requestedCount);

  const groupId = sourceNode.data.batchGroupId;
  if (groupId) {
    const state = useAppStore.getState();
    const groupedNodeIds = [
      sourceNode.id,
      ...state.nodes
        .filter((node) => node.id !== sourceNode.id && node.data.batchGroupId === groupId)
        .map((node) => node.id),
    ];
    return groupedNodeIds.slice(0, requestedCount);
  }

  return [];
}

/** Save and materialize a batch while keeping node placement and history consistent. */
export async function applyImageBatchResults({
  model,
  provider,
  silent = false,
  nodeId,
  targetNodeIds,
  batch,
  projectId,
  prompt,
  imageSize,
  imageQuality,
  imageBackground,
  aspectRatio,
  isCurrent,
  signal,
  deferTaskCompletion = false,
  commitHistory = true,
  artifacts,
}: ApplyImageBatchParams): Promise<boolean> {
  signal?.throwIfAborted();
  if (isCurrent && !isCurrent()) throw new Error('画布已变化，批量产物已保留');
  if (batch.results.length === 0) throw new Error('批量图片生成未返回可用结果');

  const initialStore = useAppStore.getState();
  if (initialStore.currentProjectId !== projectId) throw new Error('任务已被取消');
  const sourceNode = initialStore.nodes.find((node) => node.id === nodeId) as Node<BaseNodeData> | undefined;
  if (!sourceNode) throw new Error('生成节点不存在');
  const sourceData = sourceNode.data;
  const outputCount = Math.max(batch.expectedOutputCount ?? batch.requestedCount, batch.results.length);
  const fixedCandidates = Boolean(batch.expectedOutputCount);
  const fixedReceipt = fixedCandidates ? batch.taskReceipt ?? batch.results.find((result) => result.taskReceipt)?.taskReceipt : undefined;
  const artifactIds = Array.from({ length: outputCount }, (_, index) => {
    const receipt = batch.results[index]?.taskReceipt ?? batch.taskReceipt ?? fixedReceipt;
    return artifacts?.[index]?.id ?? (receipt ? imageBatchArtifactId(receipt, index) : undefined);
  });
  const outputGroupId = fixedCandidates ? `image-candidates:${artifactIds[0] ?? nodeId}` : undefined;
  const previousTargetIds = fixedCandidates ? targetNodeIds ?? [] : resolveBatchTargetNodeIds(sourceNode, outputCount, targetNodeIds);
  let resolvedTargetNodeIds = Array.from({ length: outputCount }, (_, index) => {
    const matching = artifactIds[index] ? initialStore.nodes.find((node) => node.data.artifactId === artifactIds[index]) : undefined;
    if (matching) return matching.id;
    const candidate = initialStore.nodes.find((node) => node.id === previousTargetIds[index]);
    if (!candidate || index > 0 && candidate.data.artifactId
      && (fixedCandidates || artifactIds.includes(candidate.data.artifactId))) return '';
    return candidate.id;
  });
  resolvedTargetNodeIds[0] = nodeId;
  if (resolvedTargetNodeIds.some((id) => !id)) {
    resolvedTargetNodeIds = prepareImageBatchNodes({ nodeId, count: outputCount, projectId,
      commitHistory, existingNodeIds: resolvedTargetNodeIds, ...(outputGroupId ? { batchGroupId: outputGroupId } : {}) }).nodeIds;
  }
  const reusable = new Map<number, PersistedProjectMedia>();
  const beforeSaving = useAppStore.getState();
  if (outputGroupId) resolvedTargetNodeIds.forEach((id) => {
    beforeSaving.updateNodeDataTransient(id, { batchGroupId: outputGroupId });
  });
  artifactIds.forEach((artifactId, index) => {
    if (!artifactId) return;
    const node = beforeSaving.nodes.find((item) => item.id === resolvedTargetNodeIds[index]);
    const matches = node?.data.artifactId === artifactId;
    if (matches && node?.data.imageUrl) {
      reusable.set(index, { mediaUrl: node.data.imageUrl, sourceUrl: node.data.sourceUrl || node.data.imageUrl,
        filePath: node.data.filePath });
    }
    beforeSaving.updateNodeDataTransient(resolvedTargetNodeIds[index], { ...(!matches ? emptyImageOutput() : {}), artifactId });
  });
  if (batch.results.some((result) => result.taskReceipt)) initialStore.updateNodeDataTransient(nodeId, { mediaTaskStage: 'saving' });

  let firstSaveError: unknown;
  const savedBatch = await runBatchTasks(batch.results.length, 3, async (index): Promise<SavedBatchItem> => {
    signal?.throwIfAborted();
    const result = batch.results[index];
    try {
      const artifact = artifacts?.[index];
      if (artifact?.persistence === 'failed') throw new Error(artifact.persistError || '图片已生成，但尚未保存到项目');
      const persisted = reusable.get(index) ?? (artifact ? { mediaUrl: artifact.url, sourceUrl: artifact.sourceUrl,
        filePath: artifact.filePath } : undefined) ?? getRunningHubPersistedOutput(result.runninghubOutputs, result.url) ?? (projectId
        ? await persistMediaUrlToProjectData(
            result.url,
            projectId,
            'ai-image',
            `${sourceData.label}-${index + 1}`,
            { mediaDownloadAccess: result.mediaDownloadAccess, ...(signal ? { signal } : {}) },
          )
        : { mediaUrl: result.url, sourceUrl: result.url });
      signal?.throwIfAborted();
      return { index, result, persisted };
    } catch (error) {
      firstSaveError ??= error;
      throw error;
    }
  });

  signal?.throwIfAborted();
  const store = useAppStore.getState();
  if (isCurrent && !isCurrent()) throw new Error('画布已变化，批量产物已保留');
  const liveSource = store.nodes.find((node) => node.id === nodeId) as Node<BaseNodeData> | undefined;
  if (!liveSource || store.currentProjectId !== projectId) throw new Error('任务已被取消');

  const items = savedBatch.results;
  const liveNodeIds = new Set(store.nodes.map((node) => node.id));
  const deliveredIndexes = new Set<number>();
  items.forEach((item) => {
    const targetNodeId = resolvedTargetNodeIds[item.index];
    if (!targetNodeId || !liveNodeIds.has(targetNodeId)) return;
    store.updateNodeDataTransient(targetNodeId, {
      imageUrl: item.persisted.mediaUrl,
      sourceUrl: item.persisted.sourceUrl,
      filePath: item.persisted.filePath,
      assetId: undefined,
      relativePath: undefined,
      artifactId: artifactIds[item.index],
      fileName: undefined,
      mattingMask: undefined,
      annotation: undefined,
      thumbnailUrl: item.persisted.mediaUrl,
      output: item.persisted.sourceUrl,
      status: 'success',
      error: undefined,
      imageWidth: item.result.width,
      imageHeight: item.result.height,
    });
    deliveredIndexes.add(item.index);
  });

  resolvedTargetNodeIds.forEach((targetNodeId, index) => {
    if (!deliveredIndexes.has(index) && liveNodeIds.has(targetNodeId)) {
      store.updateNodeDataTransient(targetNodeId, {
        status: 'error',
        error: batch.results[index] ? '图片已生成，但未能保存到项目；请继续保存原结果'
          : batch.allTasksSettled ? '上游任务已结束，该图片生成失败或未返回结果' : MISSING_BATCH_RESULT_ERROR,
        ...(batch.allTasksSettled && !batch.results[index] ? { mediaTaskState: undefined, mediaTaskStage: undefined } : {}),
      });
    }
  });

  await Promise.all(items.map((item) => {
    const index = item.index;
    const targetNodeId = resolvedTargetNodeIds[index];
    if (!targetNodeId || !liveNodeIds.has(targetNodeId)) return Promise.resolve();
    const artifactId = artifactIds[index];
    return (async () => {
      if (artifactId && projectId) {
        const previous = await getNodeHistoryEntries(projectId, targetNodeId);
        if (previous.some((entry) => entry.status === 'success' && entry.params?.imageOutputId === artifactId)) return;
      }
      signal?.throwIfAborted();
      const current = useAppStore.getState();
      if (current.currentProjectId !== projectId || (isCurrent && !isCurrent())
        || !current.nodes.some((node) => node.id === targetNodeId && (!artifactId || node.data.artifactId === artifactId))) {
        throw new Error('画布已变化，批量产物已保留');
      }
      const entry = {
        nodeId: targetNodeId,
        nodeLabel: index === 0 ? sourceData.label : `${sourceData.label} ${index + 1}`,
        timestamp: Date.now(),
        prompt,
        output: item.persisted.sourceUrl,
        nodeType: 'ai-image' as const,
        model: model ?? sourceData.model ?? '',
        provider: provider ?? sourceData.provider ?? '',
        status: 'success' as const,
        mediaUrl: item.persisted.mediaUrl,
        filePath: item.persisted.filePath,
        params: { imageSize, imageQuality, imageBackground, aspectRatio, batchCount: outputCount, batchIndex: index + 1,
          ...(artifactId ? { imageOutputId: artifactId } : {}) },
      };
      if (artifactId) await store.recordOutputHistory(targetNodeId, entry, true);
      else await store.recordOutputHistory(targetNodeId, entry);
    })();
  }));

  signal?.throwIfAborted();
  if (useAppStore.getState().currentProjectId !== projectId || (isCurrent && !isCurrent())) {
    throw new Error('画布已变化，批量产物已保留');
  }
  // 聚合任务的任一产物仍待保存或回填时，不能用一张成功图清掉整批远端身份。
  const remoteComplete = batch.allTasksSettled === true
    || (batch.failedCount === 0 && batch.results.length >= batch.requestedCount);
  const deliveryComplete = remoteComplete && savedBatch.failedCount === 0
    && deliveredIndexes.size === batch.results.length
    && (batch.expectedOutputCount === undefined || deliveredIndexes.size >= batch.expectedOutputCount);
  const receipts = new Map(batch.results.flatMap((result) => result.taskReceipt
    ? [[imageBatchArtifactId(result.taskReceipt, 0), result.taskReceipt] as const] : []));
  if (batch.taskReceipt) receipts.set(imageBatchArtifactId(batch.taskReceipt, 0), batch.taskReceipt);
  for (const receipt of receipts.values()) {
    if (deliveryComplete && !deferTaskCompletion) completeMediaNodeTask(receipt);
    else if (!deliveryComplete) pauseMediaTask(receipt, firstSaveError, 'delivery_pending');
  }
  if (deliveryComplete && !deferTaskCompletion) for (const result of batch.results) {
    if (result.comfyTaskId) completeComfyNodeTask(nodeId, result.comfyTaskId);
  }
  if (deliveryComplete && !deferTaskCompletion && !batch.results.some((result) => result.taskReceipt)
    && ['runninghub', 'runninghubwf'].includes(provider ?? sourceData.provider ?? '')) completeRunningHubNodeTask(nodeId);

  const failedCount = Math.max(batch.failedCount, outputCount - deliveredIndexes.size);
  if (!silent) store.showToast(
    failedCount > 0
      ? `批量生成完成：成功 ${items.length}/${outputCount} 张`
      : `批量生成完成：共 ${items.length} 张`,
    failedCount > 0 ? 'error' : 'success',
  );
  return deliveryComplete;
}
