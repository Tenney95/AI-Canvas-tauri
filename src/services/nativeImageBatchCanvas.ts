/** 完整候选按既有批量布局投递；只有原节点和本次稳定候选ID可变化。 */
import type { CanvasDocument } from '../types/project';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { nativeImageBatchResults, nativeImageBatchSettled } from './nativeImageBatch';
import { BATCH_NODE_GAP, BATCH_COLUMNS_RIGHT_OF_SOURCE } from './imageBatchLayout';
import { configValuesEqual } from './configPatch';
import { getNextDisplayId } from '../store/store.utils';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
type Body = Pick<CanvasDocument, 'nodes' | 'edges' | 'groups'>;
export const nativeImageBatchNodeId = (operationId: string, ordinal: number) => `native-image-${operationId}-${ordinal}`;
export const nativeImageBatchArtifactId = (operationId: string, ordinal: number) => `native-media-${operationId}${ordinal ? `-${ordinal}` : ''}`;

export function buildNativeImageBatchCanvas(canvas: CanvasDocument, record: NativeMediaTaskRecord): Body {
  if (!record.apimartImageBatch || !nativeImageBatchSettled(record.apimartImageBatch)) throw new Error('原图片批次尚未全部结算，不能截断候选交付');
  const results = nativeImageBatchResults(record);
  if (!results.length) throw new Error('原图片批次没有可交付候选');
  const matches = canvas.nodes.filter((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === record.nodeId);
  const source = matches[0] as { id: string; type?: string; position?: { x: number; y: number }; data?: Record<string, unknown> } | undefined;
  if (matches.length !== 1 || !source?.data || source.data.type !== 'ai-image' || !source.position
    || !Number.isFinite(source.position.x) || !Number.isFinite(source.position.y)) throw new Error('原图片节点不存在或位置已变化');
  const nodeIds = new Set(canvas.nodes.map((node) => (node as { id?: unknown })?.id));
  const width = typeof source.data.nodeWidth === 'number' && source.data.nodeWidth > 0 ? source.data.nodeWidth : 280;
  const height = typeof source.data.nodeHeight === 'number' && source.data.nodeHeight > 0 ? source.data.nodeHeight : 280;
  const firstDisplayId = getNextDisplayId(canvas.nodes as Node<BaseNodeData>[]);
  const output = results.map((file, ordinal) => {
    const id = ordinal === 0 ? source.id : nativeImageBatchNodeId(record.operationId, ordinal);
    if (ordinal && nodeIds.has(id)) throw new Error('原图片批次候选身份已被占用，不能覆盖已有节点');
    const inherited = ordinal ? Object.fromEntries(['prompt', 'model', 'provider', 'imageSize', 'imageQuality', 'imageBackground', 'aspectRatio', 'style', 'nodeWidth', 'nodeHeight']
      .filter((key) => Object.hasOwn(source.data!, key)).map((key) => [key, structuredClone(source.data![key])])) : structuredClone(source.data);
    const data = { ...inherited, type: 'ai-image', imageUrl: file.relativePath, relativePath: file.relativePath,
      sourceUrl: file.relativePath, output: file.relativePath, thumbnailUrl: file.relativePath,
      artifactId: nativeImageBatchArtifactId(record.operationId, ordinal), batchGroupId: `native-image-batch-${record.operationId}`,
      ...(ordinal ? { batchCount: 1, displayId: firstDisplayId + ordinal - 1, label: `${source.data.label || '图片'} ${ordinal + 1}` } : {}),
      status: 'success', error: undefined, mediaTaskState: undefined, mediaTaskStage: undefined, videoTaskState: undefined } as Record<string, unknown>;
    for (const key of ['filePath', 'assetId', 'mattingMask', 'annotation', 'annotationLayer', 'imageWidth', 'imageHeight']) delete data[key];
    return { ...(ordinal ? {} : structuredClone(source)), id, type: 'ai-image', ...(ordinal ? { selected: false,
      position: { x: source.position!.x + ((ordinal - 1) % BATCH_COLUMNS_RIGHT_OF_SOURCE + 1) * (width + BATCH_NODE_GAP),
        y: source.position!.y + Math.floor((ordinal - 1) / BATCH_COLUMNS_RIGHT_OF_SOURCE) * (height + BATCH_NODE_GAP) } } : {}), data };
  });
  return { nodes: [...canvas.nodes.map((node) => (node as { id?: unknown })?.id === source.id ? output[0] : node), ...output.slice(1)],
    edges: canvas.edges, groups: canvas.groups };
}
export function assertNativeImageBatchCanvas(before: CanvasDocument, after: Body, record: NativeMediaTaskRecord): void {
  const expected = buildNativeImageBatchCanvas(before, record);
  if (!configValuesEqual(expected, after)) throw new Error('图片批次投递必须完整且只能修改原节点与本批候选节点');
}
