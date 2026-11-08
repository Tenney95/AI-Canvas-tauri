/** 媒体结果与目标画布同事务提交；不使用运行时租约代替持久 lease/CAS。 */
import type { CanvasDocument } from '../types/project';
import { configValuesEqual } from './configPatch';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { sha256BytesHex } from './mediaDataUrl';
import { assertNoNewInlineMedia, assertNoPendingNativeSharedSync, CANVASES, CONTENTS, EPISODES, EXCHANGE, increment,
  openNativeProjectDatabase, readCanvasTarget, REVISIONS, ROOTS, TRANSFER, transact, validateCanvasTarget,
  type NativeProjectOptions } from './indexedDb/nativeProjectRepository';
import { validateNativeMediaTaskRecord, type NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { safeExchangePath } from './projectExchangeDomain';
import { nativeImageBatchResults, nativeImageBatchSettled } from './nativeImageBatch';
import { assertNativeImageBatchCanvas } from './nativeImageBatchCanvas';
import { assertNativeMediaCollectionCanvas } from './nativeMediaCollectionCanvas';

const req = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('媒体结果保存失败'));
});
const fail = (message = '原任务或画布已变化，媒体结果未写入'): never => { throw new Error(message); };
type CanvasBody = Pick<CanvasDocument, 'nodes' | 'edges' | 'groups'>;

/** 只允许修改原任务节点；不能借已完成媒体任务覆盖其他节点或连线。 */
function assertOnlyTargetNodeChanged(before: CanvasDocument, after: CanvasBody, nodeId: string): void {
  if (!Array.isArray(after.nodes) || !configValuesEqual(before.edges, after.edges) || !configValuesEqual(before.groups, after.groups)
    || before.nodes.length !== after.nodes.length) return fail();
  const matches = before.nodes.filter((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === nodeId);
  const nextMatches = after.nodes.filter((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === nodeId);
  if (matches.length !== 1 || nextMatches.length !== 1) return fail('原任务节点不存在或身份重复，媒体结果未写入');
  if (!before.nodes.every((node, index) => {
    const originalId = node && typeof node === 'object' ? (node as { id?: unknown }).id : undefined;
    const next = after.nodes[index];
    return originalId === nodeId ? !!next && typeof next === 'object' && (next as { id?: unknown }).id === nodeId
      : configValuesEqual(node, next);
  })) return fail('其他画布内容发生变化，请重新读取后交付');
}

export interface NativeMediaDeliveryResult { record: NativeMediaTaskRecord; canvasRevision: number; changeRevision: number; alreadyCommitted: boolean }
export interface NativeMediaDeliveryOptions extends NativeProjectOptions {
  /** 仅运行时投影；在IDB complete事件内、返回Promise兑现前同步执行。 */
  onCommitted?: (result: NativeMediaDeliveryResult) => void;
}

/** 对话专用产物不创建隐藏画布节点；完成回执和相对文件身份同一新库事务提交。 */
export async function commitNativeMediaMessageDelivery(record: NativeMediaTaskRecord, relativePath: string,
  options: NativeProjectOptions = {}): Promise<NativeMediaTaskRecord> {
  const original = validateNativeMediaTaskRecord(structuredClone(record));
  if (original.origin?.deliveryMode !== 'chat' || original.status !== 'submitted' || !(original.localResults?.length || (original.submissionKind === 'sync' ? original.localResult : original.remoteTaskId))
    || safeExchangePath(relativePath) !== relativePath) return fail();
  if (original.submissionKind === 'sync' && !original.localResults) {
    if (!original.localResult || original.localResult.relativePath !== relativePath) return fail();
    const { readNativeMediaLocalResult } = await import('./nativeMediaLocalResult');
    await readNativeMediaLocalResult(original.canvasId, original.localResult);
  }
  if (original.localResults) {
    if (original.localResults[0].relativePath !== relativePath) return fail();
    const { readNativeMediaLocalResult } = await import('./nativeMediaLocalResult');
    for (const file of original.localResults) await readNativeMediaLocalResult(original.canvasId, file);
  }
  if (original.apimartImageBatch) {
    if (!nativeImageBatchSettled(original.apimartImageBatch) || nativeImageBatchResults(original)[0]?.relativePath !== relativePath) return fail('图片批次尚未完整结算');
    const { readNativeMediaLocalResult } = await import('./nativeMediaLocalResult');
    for (const file of nativeImageBatchResults(original)) await readNativeMediaLocalResult(original.canvasId, file);
  }
  const deliveryDigest = await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken([
    original.operationId, original.remoteTaskId, original.origin, relativePath,
    ...(original.localResult ? [original.localResult] : []),
    ...(original.localResults ? [original.localResults] : []),
    ...(original.completion ? [original.completion] : []),
    ...(original.apimartImageBatch ? [original.apimartImageBatch] : []),
  ])));
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try {
    return await transact(db, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail('媒体投递需要严格耐久事务');
      const store = tx.objectStore(EXCHANGE), row = await req(store.get(original.projectId)) as NativeMediaTaskRecord | undefined;
      if (!row) return fail();
      const current = validateNativeMediaTaskRecord(row);
      if (current.lease !== original.lease || current.remoteTaskId !== original.remoteTaskId
        || !configValuesEqual(current.origin, original.origin) || !configValuesEqual(current.apimartImageBatch, original.apimartImageBatch)
        || !configValuesEqual(current.localResults, original.localResults) || !configValuesEqual(current.recovery, original.recovery)
        || !configValuesEqual(current.pollContext, original.pollContext) || !configValuesEqual(current.completion, original.completion)
        || current.resultRootRef !== original.resultRootRef) return fail();
      if (current.status === 'delivered') {
        if (current.deliveryDigest !== deliveryDigest || current.resultRelativePath !== relativePath) return fail();
        return current;
      }
      if (current.status !== 'submitted' || current.revision !== original.revision) return fail();
      await assertNoPendingNativeSharedSync(tx, current.ownerProjectId);
      const { project, canvas } = await readCanvasTarget(tx, current.ownerProjectId, current.canvasId);
      if (project.epoch !== current.projectEpoch || canvas.epoch !== current.canvasEpoch || canvas.episodeId !== current.episodeId) return fail();
      if (current.resultRootRef && current.resultRootRef !== project.storageRootRef) return fail('原媒体主根已变化');
      const revision = await req(tx.objectStore(REVISIONS).get(project.id)) as { projectId: string; changeRevision: number } | undefined;
      if (!revision || revision.projectId !== project.id || !Number.isSafeInteger(revision.changeRevision)) return fail();
      const delivered = validateNativeMediaTaskRecord({ ...current, status: 'delivered', resultRelativePath: relativePath,
        deliveryDigest, committedCanvasRevision: canvas.revision, revision: increment(current.revision), updatedAt: Date.now() });
      await Promise.all([req(store.put(delivered)), req(tx.objectStore(REVISIONS).put({ projectId: project.id, changeRevision: increment(revision.changeRevision) }))]);
      return delivered;
    }, [ROOTS, EPISODES, CANVASES, EXCHANGE, TRANSFER, REVISIONS], true);
  } finally { db.close(); }
}

/**
 * 文档必须先走素材相对化，且由调用者确认活动运行租约；这里再次在事务中核对持久租约、画布版本和写锁。
 * 相同请求可只读复核已提交结果，不再次写画布；任务 lease 或内容不同一律拒绝。
 */
export async function commitNativeMediaDelivery(input: { record: NativeMediaTaskRecord; expectedCanvasRevision: number;
  expectedAssetsRevision: number; document: CanvasBody }, options: NativeMediaDeliveryOptions = {}): Promise<NativeMediaDeliveryResult> {
  const fixed = structuredClone(input), original = validateNativeMediaTaskRecord(fixed.record);
  if (original.status !== 'submitted' || !(original.localResults?.length || (original.submissionKind === 'sync' ? original.localResult : original.remoteTaskId)) || !Number.isSafeInteger(fixed.expectedCanvasRevision)
    || fixed.expectedCanvasRevision < 0 || !Number.isSafeInteger(fixed.expectedAssetsRevision) || fixed.expectedAssetsRevision < 0 || !fixed.document || typeof fixed.document !== 'object'
    || Object.keys(fixed.document).some((key) => !['nodes', 'edges', 'groups'].includes(key))) return fail();
  if (original.submissionKind === 'sync' && !original.localResults) {
    const target = fixed.document.nodes.find((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === original.nodeId) as { data?: { relativePath?: unknown } } | undefined;
    if (!original.localResult || target?.data?.relativePath !== original.localResult.relativePath) return fail();
    const { readNativeMediaLocalResult } = await import('./nativeMediaLocalResult');
    await readNativeMediaLocalResult(original.canvasId, original.localResult);
  }
  if (original.localResults) {
    const { readNativeMediaLocalResult } = await import('./nativeMediaLocalResult');
    for (const file of original.localResults) await readNativeMediaLocalResult(original.canvasId, file);
  }
  if (original.apimartImageBatch) {
    if (!nativeImageBatchSettled(original.apimartImageBatch)) return fail('图片批次尚未完整结算');
    const { readNativeMediaLocalResult } = await import('./nativeMediaLocalResult');
    for (const file of nativeImageBatchResults(original)) await readNativeMediaLocalResult(original.canvasId, file);
  }
  const deliveryDigest = await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(fixed.document)));
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try {
    return await transact(db, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail('媒体投递需要严格耐久事务，原任务已保留');
      const store = tx.objectStore(EXCHANGE);
      const row = await req(store.get(original.projectId)) as NativeMediaTaskRecord | undefined;
      if (!row) return fail();
      const current = validateNativeMediaTaskRecord(row);
      if (current.lease !== original.lease || current.operationId !== original.operationId
        || current.remoteTaskId !== original.remoteTaskId || !configValuesEqual(current.apimartImageBatch, original.apimartImageBatch)
        || !configValuesEqual(current.localResults, original.localResults) || !configValuesEqual(current.recovery, original.recovery)
        || !configValuesEqual(current.pollContext, original.pollContext) || !configValuesEqual(current.completion, original.completion)
        || current.resultRootRef !== original.resultRootRef) return fail();
      if (current.status === 'delivered') {
        if (current.deliveryDigest !== deliveryDigest || current.committedCanvasRevision === undefined) return fail();
        const revision = await req(tx.objectStore(REVISIONS).get(current.ownerProjectId)) as { projectId: string; changeRevision: number } | undefined;
        if (!revision || revision.projectId !== current.ownerProjectId || !Number.isSafeInteger(revision.changeRevision)) return fail();
        return { record: current, canvasRevision: current.committedCanvasRevision, changeRevision: revision.changeRevision, alreadyCommitted: true };
      }
      if (current.status !== 'submitted' || current.revision !== original.revision) return fail();
      await assertNoPendingNativeSharedSync(tx, current.ownerProjectId);
      const { project, canvas, episode } = await readCanvasTarget(tx, current.ownerProjectId, current.canvasId);
      const [revision, content] = await Promise.all([
        req(tx.objectStore(REVISIONS).get(current.ownerProjectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        req(tx.objectStore(CONTENTS).get(current.ownerProjectId)) as Promise<{ projectId: string; revisions: { assets: number } } | undefined>,
      ]);
      if (!revision || revision.projectId !== current.ownerProjectId || !Number.isSafeInteger(revision.changeRevision)
        || !content || content.projectId !== current.ownerProjectId || content.revisions?.assets !== fixed.expectedAssetsRevision
        || project.epoch !== current.projectEpoch || canvas.epoch !== current.canvasEpoch
        || canvas.episodeId !== current.episodeId || canvas.revision !== fixed.expectedCanvasRevision) return fail();
      if (current.resultRootRef && current.resultRootRef !== project.storageRootRef) return fail('原媒体主根已变化');
      if (current.apimartImageBatch) assertNativeImageBatchCanvas(canvas, fixed.document, current, project.storageRootRef);
      else if (current.localResults) assertNativeMediaCollectionCanvas(canvas, fixed.document, current, project.storageRootRef);
      else assertOnlyTargetNodeChanged(canvas, fixed.document, current.nodeId);
      const target = fixed.document.nodes.find((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === current.nodeId) as { data?: Record<string, unknown> } | undefined;
      const resultRelativePath = target?.data?.relativePath;
      if (typeof resultRelativePath !== 'string' || safeExchangePath(resultRelativePath) !== resultRelativePath) return fail('媒体结果缺少受控相对路径');
      if (typeof target?.data?.storageRootRef === 'string' ? target.data.storageRootRef !== project.storageRootRef : canvas.storageRootRef !== project.storageRootRef) return fail('媒体结果未绑定原作品主根');
      if (current.apimartImageBatch && resultRelativePath !== nativeImageBatchResults(current)[0]?.relativePath) return fail('图片批次主图不属于原候选集合');
      if (current.localResults && resultRelativePath !== current.localResults[0].relativePath) return fail('媒体主结果不属于原完整产物集合');
      const originalNode = canvas.nodes.find((node) => node && typeof node === 'object' && (node as { id?: unknown }).id === current.nodeId) as { data?: { type?: unknown } } | undefined;
      const mediaKey = current.category === 'video' ? 'videoUrl' : current.category === 'image' ? 'imageUrl' : 'audioUrl';
      const targetType = current.targetNodeType ?? `ai-${current.category}`;
      if (originalNode?.data?.type !== targetType || target?.data?.type !== targetType
        || target?.data?.[mediaKey] !== resultRelativePath) return fail('媒体结果类型与原任务目的地不一致');
      assertNoNewInlineMedia(canvas, fixed.document);
      const updated = validateCanvasTarget(project, episode, { ...canvas, ...fixed.document, revision: increment(canvas.revision) }, canvas);
      const delivered = validateNativeMediaTaskRecord({ ...current, status: 'delivered', deliveryDigest,
        resultRelativePath,
        committedCanvasRevision: updated.revision, revision: increment(current.revision), updatedAt: Date.now() });
      await Promise.all([req(tx.objectStore(CANVASES).put(updated)), req(tx.objectStore(ROOTS).put({ ...project, updatedAt: Date.now() })),
        req(tx.objectStore(REVISIONS).put({ projectId: project.id, changeRevision: increment(revision.changeRevision) })),
        req(store.put(delivered))]);
      return { record: delivered, canvasRevision: updated.revision, changeRevision: increment(revision.changeRevision), alreadyCommitted: false };
    }, [ROOTS, CONTENTS, EPISODES, CANVASES, REVISIONS, TRANSFER, EXCHANGE], true, options.onCommitted);
  } finally { db.close(); }
}
