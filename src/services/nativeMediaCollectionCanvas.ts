/** 原作业的全部结果按稳定序号发布；其他节点、连线和分组不得被媒体回执覆盖。 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { CanvasDocument } from '../types/project';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { nativeMediaLocalOutputs } from './nativeMediaCollection';
import { BATCH_NODE_GAP, BATCH_COLUMNS_RIGHT_OF_SOURCE } from './imageBatchLayout';
import { configValuesEqual } from './configPatch';
import { getNextDisplayId } from '../store/store.utils';
import { animationResultPatch } from './animationService';

type Body = Pick<CanvasDocument, 'nodes' | 'edges' | 'groups'>;
export const nativeMediaOutputArtifactId = (operationId: string, ordinal: number) => `native-media-${operationId}${ordinal ? `-${ordinal}` : ''}`;
export const nativeMediaOutputNodeId = (record: Pick<NativeMediaTaskRecord, 'operationId' | 'apimartImageBatch'>, ordinal: number) =>
  `${record.apimartImageBatch ? 'native-image' : 'native-output'}-${record.operationId}-${ordinal}`;

export function buildNativeMediaCollectionCanvas(canvas: CanvasDocument, record: NativeMediaTaskRecord,
  resultRootRef = record.resultRootRef ?? canvas.storageRootRef): Body {
  const results = nativeMediaLocalOutputs(record);
  if (!results.length || results[0].category !== record.category) throw new Error('原媒体完整产物集合缺少主结果');
  if (record.resultRootRef && record.resultRootRef !== resultRootRef) throw new Error('原媒体产物主根已变化');
  const matches = canvas.nodes.filter((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === record.nodeId);
  const source = matches[0] as { id: string; type?: string; position?: { x: number; y: number }; data?: Record<string, unknown> } | undefined;
  const sourceType = record.targetNodeType ?? `ai-${record.category}`;
  if (matches.length !== 1 || !source?.data || source.data.type !== sourceType || !source.position
    || !Number.isFinite(source.position.x) || !Number.isFinite(source.position.y)) throw new Error('原媒体节点类型或位置已变化，产物保留');
  const sourceData = source.data, sourcePosition = source.position;
  const ids = new Set(canvas.nodes.map((node) => (node as { id?: unknown })?.id));
  const width = typeof sourceData.nodeWidth === 'number' && sourceData.nodeWidth > 0 ? sourceData.nodeWidth : 280;
  const height = typeof sourceData.nodeHeight === 'number' && sourceData.nodeHeight > 0 ? sourceData.nodeHeight : 280;
  const firstDisplayId = getNextDisplayId(canvas.nodes as Node<BaseNodeData>[]);
  const output = results.map((file, ordinal) => {
    const id = ordinal === 0 ? source.id : nativeMediaOutputNodeId(record, ordinal);
    if (ordinal && ids.has(id)) throw new Error('原媒体候选身份被占用，未覆盖已有节点');
    const sameCategory = file.category === record.category;
    const type = ordinal ? `${sameCategory ? 'ai' : 'source'}-${file.category}` : sourceType;
    const inherited = ordinal ? Object.fromEntries((sameCategory
      ? ['prompt', 'model', 'provider', 'imageSize', 'imageQuality', 'imageBackground', 'aspectRatio', 'style', 'nodeWidth', 'nodeHeight'] : [])
      .filter((key) => Object.hasOwn(sourceData, key)).map((key) => [key, structuredClone(sourceData[key])])) : structuredClone(sourceData);
    const mediaKey = file.category === 'image' ? 'imageUrl' : file.category === 'video' ? 'videoUrl' : 'audioUrl';
    const data: Record<string, unknown> = { ...inherited, type, [mediaKey]: file.relativePath, relativePath: file.relativePath, storageRootRef: resultRootRef,
      sourceUrl: file.relativePath, output: file.relativePath, ...(file.category !== 'audio' ? { thumbnailUrl: file.relativePath } : {}),
      artifactId: nativeMediaOutputArtifactId(record.operationId, ordinal), batchGroupId: `${record.apimartImageBatch ? 'native-image' : 'native-media'}-batch-${record.operationId}`,
      ...(ordinal ? { batchCount: 1, displayId: firstDisplayId + ordinal - 1, label: `${sourceData.label || (file.category === 'image' ? '图片' : '媒体')} ${ordinal + 1}`,
        ...(sameCategory ? {} : { role: 'source' }) } : {}),
      ...(type === 'ai-animation' ? animationResultPatch(sourceData as unknown as BaseNodeData) : {}),
      status: 'success', error: undefined, mediaTaskState: undefined, mediaTaskStage: undefined, videoTaskState: undefined };
    for (const key of ['filePath', 'assetId', 'mattingMask', 'annotation', 'annotationLayer', 'imageWidth', 'imageHeight']) delete data[key];
    return { ...(ordinal ? {} : structuredClone(source)), id, type, ...(ordinal ? { selected: false,
      position: { x: sourcePosition.x + ((ordinal - 1) % BATCH_COLUMNS_RIGHT_OF_SOURCE + 1) * (width + BATCH_NODE_GAP),
        y: sourcePosition.y + Math.floor((ordinal - 1) / BATCH_COLUMNS_RIGHT_OF_SOURCE) * (height + BATCH_NODE_GAP) } } : {}), data };
  });
  return { nodes: [...canvas.nodes.map((node) => (node as { id?: unknown })?.id === source.id ? output[0] : node), ...output.slice(1)], edges: canvas.edges, groups: canvas.groups };
}
export function assertNativeMediaCollectionCanvas(before: CanvasDocument, after: Body, record: NativeMediaTaskRecord, resultRootRef = record.resultRootRef ?? before.storageRootRef): void {
  if (!configValuesEqual(buildNativeMediaCollectionCanvas(before, record, resultRootRef), after)) throw new Error('媒体投递必须包括完整集合且只能修改原节点与本批候选');
}
