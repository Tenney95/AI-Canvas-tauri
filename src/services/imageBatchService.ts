/**
 * 图片节点批量生成生命周期：先在源节点右侧创建加载节点，再把批量结果逐一回填。
 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { BatchImageResult, ImageGenerationResult } from '../types/aiTypes';
import { MAX_IMAGE_BATCH_COUNT } from '../types/aiTypes';
import { generateId } from '../store/store.utils';
import { useAppStore } from '../store/useAppStore';
import { downloadUrlAndSave } from './fileService';
import { runBatchTasks } from './ai/batchUtils';

interface ApplyImageBatchParams {
  nodeId: string;
  /** 提交请求前创建的目标节点；恢复旧任务时可缺省，由 batchGroupId 自动找回。 */
  targetNodeIds?: string[];
  batch: BatchImageResult;
  projectId: string | null | undefined;
  prompt: string;
  imageSize: string;
  aspectRatio: string;
}

interface PrepareImageBatchParams {
  nodeId: string;
  count: number;
  projectId: string | null | undefined;
}

export interface PreparedImageBatchNodes {
  nodeIds: string[];
  batchGroupId: string;
}

interface SavedBatchItem {
  result: ImageGenerationResult;
  saved: { filePath: string; assetUrl: string } | null;
}

const BATCH_NODE_GAP = 40;
const BATCH_COLUMNS_RIGHT_OF_SOURCE = 4;
const MISSING_BATCH_RESULT_ERROR = '批量生成未返回结果';

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
  nodeId,
  count,
  projectId,
}: PrepareImageBatchParams): PreparedImageBatchNodes {
  const store = useAppStore.getState();
  const sourceNode = store.nodes.find((node) => node.id === nodeId) as Node<BaseNodeData> | undefined;
  if (!sourceNode) throw new Error('生成节点不存在');
  if (store.currentProjectId !== projectId) throw new Error('任务已被取消');

  const requestedCount = Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(count)));
  const batchGroupId = `image-batch-${generateId()}`;
  const nodeWidth = (sourceNode.data.nodeWidth as number) || 280;
  const nodeHeight = (sourceNode.data.nodeHeight as number) || 280;
  const additionalNodes = Array.from({ length: requestedCount - 1 }, (_, index) => {
    const column = index % BATCH_COLUMNS_RIGHT_OF_SOURCE;
    const row = Math.floor(index / BATCH_COLUMNS_RIGHT_OF_SOURCE);
    return {
      id: `node-${generateId()}`,
      type: 'ai-image',
      position: {
        x: sourceNode.position.x + (column + 1) * (nodeWidth + BATCH_NODE_GAP),
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
    } as Node<BaseNodeData>;
  });

  store.commitToHistory();
  store.updateNodeDataTransient(nodeId, {
    batchGroupId,
    status: 'loading',
    error: undefined,
  });
  store.addNodesTransient(additionalNodes);

  return {
    nodeIds: [nodeId, ...additionalNodes.map((node) => node.id)],
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
  nodeId,
  targetNodeIds,
  batch,
  projectId,
  prompt,
  imageSize,
  aspectRatio,
}: ApplyImageBatchParams): Promise<void> {
  if (batch.results.length === 0) throw new Error('批量图片生成未返回可用结果');

  const initialStore = useAppStore.getState();
  const sourceNode = initialStore.nodes.find((node) => node.id === nodeId) as Node<BaseNodeData> | undefined;
  if (!sourceNode) throw new Error('生成节点不存在');
  const sourceData = sourceNode.data;

  const savedBatch = await runBatchTasks(batch.results.length, 3, async (index): Promise<SavedBatchItem> => {
    const result = batch.results[index];
    const saved = projectId
      ? await downloadUrlAndSave(
          result.url,
          projectId,
          'ai-image',
          `${sourceData.label}-${index + 1}`,
        ).catch(() => null)
      : null;
    return { result, saved };
  });

  let store = useAppStore.getState();
  let liveSource = store.nodes.find((node) => node.id === nodeId) as Node<BaseNodeData> | undefined;
  if (!liveSource || store.currentProjectId !== projectId) throw new Error('任务已被取消');

  let resolvedTargetNodeIds = resolveBatchTargetNodeIds(liveSource, batch.requestedCount, targetNodeIds);
  if (resolvedTargetNodeIds.length === 0) {
    resolvedTargetNodeIds = prepareImageBatchNodes({
      nodeId,
      count: batch.requestedCount,
      projectId,
    }).nodeIds;
    store = useAppStore.getState();
    liveSource = store.nodes.find((node) => node.id === nodeId) as Node<BaseNodeData> | undefined;
    if (!liveSource) throw new Error('任务已被取消');
  }

  const items = savedBatch.results;
  const liveNodeIds = new Set(store.nodes.map((node) => node.id));
  items.forEach((item, index) => {
    const targetNodeId = resolvedTargetNodeIds[index];
    if (!targetNodeId || !liveNodeIds.has(targetNodeId)) return;
    store.updateNodeDataTransient(targetNodeId, {
      imageUrl: item.saved?.assetUrl || item.result.url,
      sourceUrl: item.result.url,
      filePath: item.saved?.filePath,
      assetId: undefined,
      relativePath: undefined,
      artifactId: undefined,
      fileName: undefined,
      mattingMask: undefined,
      annotation: undefined,
      thumbnailUrl: item.result.url,
      output: item.result.url,
      status: 'success',
      error: undefined,
      imageWidth: item.result.width,
      imageHeight: item.result.height,
    });
  });

  resolvedTargetNodeIds.slice(items.length).forEach((targetNodeId) => {
    if (liveNodeIds.has(targetNodeId)) {
      store.updateNodeDataTransient(targetNodeId, {
        status: 'error',
        error: MISSING_BATCH_RESULT_ERROR,
      });
    }
  });

  await Promise.all(items.map((item, index) => {
    const targetNodeId = resolvedTargetNodeIds[index];
    if (!targetNodeId || !liveNodeIds.has(targetNodeId)) return Promise.resolve();
    return store.recordOutputHistory(targetNodeId, {
      nodeId: targetNodeId,
      nodeLabel: index === 0 ? sourceData.label : `${sourceData.label} ${index + 1}`,
      timestamp: Date.now(),
      prompt,
      output: item.result.url,
      nodeType: 'ai-image',
      model: (sourceData.model as string) || '',
      provider: (sourceData.provider as string) || '',
      status: 'success',
      mediaUrl: item.result.url,
      filePath: item.saved?.filePath,
      params: { imageSize, aspectRatio, batchCount: batch.requestedCount, batchIndex: index + 1 },
    });
  }));

  const failedCount = Math.max(batch.failedCount, batch.requestedCount - items.length);
  store.showToast(
    failedCount > 0
      ? `批量生成完成：成功 ${items.length}/${batch.requestedCount} 张`
      : `批量生成完成：共 ${items.length} 张`,
    failedCount > 0 ? 'error' : 'success',
  );
}
