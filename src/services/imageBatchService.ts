import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { BatchImageResult, ImageGenerationResult } from '../types/aiTypes';
import { generateId } from '../store/store.utils';
import { useAppStore } from '../store/useAppStore';
import { downloadUrlAndSave } from './fileService';
import { runBatchTasks } from './ai/batchUtils';

interface ApplyImageBatchParams {
  nodeId: string;
  batch: BatchImageResult;
  projectId: string | null | undefined;
  prompt: string;
  imageSize: string;
  aspectRatio: string;
}

interface SavedBatchItem {
  result: ImageGenerationResult;
  saved: { filePath: string; assetUrl: string } | null;
}

/** Save and materialize a batch while keeping node placement and history consistent. */
export async function applyImageBatchResults({
  nodeId,
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

  const store = useAppStore.getState();
  const liveSource = store.nodes.find((node) => node.id === nodeId) as Node<BaseNodeData> | undefined;
  if (!liveSource || store.currentProjectId !== projectId) throw new Error('任务已被取消');

  const items = savedBatch.results;
  const first = items[0];
  const batchGroupId = `image-batch-${generateId()}`;
  const nodeWidth = (liveSource.data.nodeWidth as number) || 280;
  const nodeHeight = (liveSource.data.nodeHeight as number) || 280;
  const gap = 40;

  store.commitToHistory();
  store.updateNodeDataTransient(nodeId, {
    imageUrl: first.saved?.assetUrl || first.result.url,
    sourceUrl: first.result.url,
    filePath: first.saved?.filePath,
    assetId: undefined,
    relativePath: undefined,
    artifactId: undefined,
    fileName: undefined,
    mattingMask: undefined,
    annotation: undefined,
    thumbnailUrl: first.result.url,
    output: first.result.url,
    status: 'success',
    imageWidth: first.result.width,
    imageHeight: first.result.height,
    batchGroupId,
  });

  const additionalNodes = items.slice(1).map((item, offset) => {
    const resultIndex = offset + 1;
    const col = resultIndex % 4;
    const row = Math.floor(resultIndex / 4);
    return {
      id: `node-${generateId()}`,
      type: 'ai-image',
      position: {
        x: liveSource.position.x + col * (nodeWidth + gap),
        y: liveSource.position.y + row * (nodeHeight + gap),
      },
      data: {
        ...liveSource.data,
        label: `${sourceData.label} ${resultIndex + 1}`,
        type: 'ai-image',
        batchCount: 1,
        batchGroupId,
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
      },
    } as Node<BaseNodeData>;
  });
  store.addNodesTransient(additionalNodes);
  store.commitToHistory();

  const nodeIds = [nodeId, ...additionalNodes.map((node) => node.id)];
  await Promise.all(items.map((item, index) => store.recordOutputHistory(nodeIds[index], {
    nodeId: nodeIds[index],
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
  })));

  const failedCount = Math.max(batch.failedCount, batch.requestedCount - items.length);
  store.showToast(
    failedCount > 0
      ? `批量生成完成：成功 ${items.length}/${batch.requestedCount} 张`
      : `批量生成完成：共 ${items.length} 张`,
    failedCount > 0 ? 'error' : 'success',
  );
}
