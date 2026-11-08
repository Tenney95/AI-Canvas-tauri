/** 既有 APIMart 批次继续沿用原候选身份；完整集合交付复用媒体投影。 */
import type { CanvasDocument } from '../types/project';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { nativeImageBatchSettled } from './nativeImageBatch';
import { buildNativeMediaCollectionCanvas, assertNativeMediaCollectionCanvas, nativeMediaOutputArtifactId } from './nativeMediaCollectionCanvas';

export const nativeImageBatchNodeId = (operationId: string, ordinal: number) => `native-image-${operationId}-${ordinal}`;
export const nativeImageBatchArtifactId = nativeMediaOutputArtifactId;
export function buildNativeImageBatchCanvas(canvas: CanvasDocument, record: NativeMediaTaskRecord, resultRootRef = record.resultRootRef ?? canvas.storageRootRef) {
  if (!record.apimartImageBatch || !nativeImageBatchSettled(record.apimartImageBatch)) throw new Error('原图片批次尚未全部结算，不能截断候选交付');
  return buildNativeMediaCollectionCanvas(canvas, record, resultRootRef);
}
export function assertNativeImageBatchCanvas(before: CanvasDocument, after: Pick<CanvasDocument, 'nodes' | 'edges' | 'groups'>, record: NativeMediaTaskRecord, resultRootRef = record.resultRootRef ?? before.storageRootRef): void {
  if (!record.apimartImageBatch || !nativeImageBatchSettled(record.apimartImageBatch)) throw new Error('原图片批次尚未全部结算');
  assertNativeMediaCollectionCanvas(before, after, record, resultRootRef);
}
