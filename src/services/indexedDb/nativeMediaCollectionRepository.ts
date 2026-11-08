/** 完整媒体作业先保留全部本机字节，再授予原目的地的条件交付；不重新提交生成。 */
import type { NativeMediaLocalOutput, NativeMediaCompletion } from '../../types/media';
import type { CanvasDocument, ProjectRecord } from '../../types/project';
import { configValuesEqual } from '../configPatch';
import { validateNativeMediaLocalOutputs } from '../nativeMediaCollection';
import { readNativeMediaLocalResult } from '../nativeMediaLocalResult';
import { validateNativeMediaTaskRecord, type NativeMediaTaskRecord } from './nativeMediaTaskRepository';
import { CANVASES, EXCHANGE, ROOTS, REVISIONS, increment, openNativeProjectDatabase, transact, type NativeProjectOptions } from './nativeProjectRepository';

const req = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const fail = (): never => { throw new Error('原媒体集合或租约已变化，已保存文件保留，不会重新生成'); };
export interface NativeMediaOutputRetentionOptions extends NativeProjectOptions { inlineSubmission?: boolean; completion?: NativeMediaCompletion }

export async function retainNativeMediaOutputs(record: NativeMediaTaskRecord, outputs: readonly NativeMediaLocalOutput[],
  options: NativeMediaOutputRetentionOptions = {}): Promise<NativeMediaTaskRecord> {
  const original = validateNativeMediaTaskRecord(structuredClone(record)), files = structuredClone(outputs) as NativeMediaLocalOutput[];
  validateNativeMediaLocalOutputs(files);
  if (original.apimartImageBatch || original.localResult || files[0].category !== original.category) return fail();
  for (const file of files) await readNativeMediaLocalResult(original.canvasId, file);
  options.signal?.throwIfAborted();
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try { return await transact(db, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') return fail();
    const store = tx.objectStore(EXCHANGE), row = await req(store.get(original.projectId)) as NativeMediaTaskRecord | undefined;
    if (!row) return fail();
    const current = validateNativeMediaTaskRecord(row);
    if (current.lease !== original.lease || current.operationId !== original.operationId || current.localResult || current.apimartImageBatch
      || current.revision >= Number.MAX_SAFE_INTEGER) return fail();
    if (current.localResults) {
      if (!configValuesEqual(current.localResults, files) || options.completion !== undefined && !configValuesEqual(current.completion, options.completion)) return fail();
      return current;
    }
    const inline = options.inlineSubmission === true && current.submissionKind === 'async';
    if (current.revision !== original.revision || !configValuesEqual(current.recovery, original.recovery)
      || (current.submissionKind === 'sync' || inline ? !['prepared', 'outcome-unknown'].includes(current.status)
        : current.status !== 'submitted' || !current.remoteTaskId)
      || inline && (current.remoteTaskId !== undefined || !current.recovery)) return fail();
    const [project, canvas, revision] = await Promise.all([
      req(tx.objectStore(ROOTS).get(current.ownerProjectId)) as Promise<ProjectRecord | undefined>,
      req(tx.objectStore(CANVASES).get(current.canvasId)) as Promise<CanvasDocument | undefined>,
      req(tx.objectStore(REVISIONS).get(current.ownerProjectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
    ]);
    if (!project || !canvas || project.epoch !== current.projectEpoch || canvas.epoch !== current.canvasEpoch
      || canvas.projectId !== current.ownerProjectId || canvas.episodeId !== current.episodeId || !revision
      || revision.projectId !== current.ownerProjectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) return fail();
    // 只单调保留回执；真正投递另核验共享写锁、原输入和画布 CAS。
    const next = validateNativeMediaTaskRecord({ ...current, ...(inline ? { submissionKind: 'sync' as const } : {}), localResults: files,
      ...(options.completion ? { completion: structuredClone(options.completion) } : {}), resultRelativePath: files[0].relativePath,
      status: 'submitted', revision: increment(current.revision), updatedAt: Date.now() });
    await Promise.all([req(store.put(next)), req(tx.objectStore(REVISIONS).put({ ...revision, changeRevision: increment(revision.changeRevision) }))]);
    return next;
  }, [ROOTS, CANVASES, EXCHANGE, REVISIONS], true); } finally { db.close(); }
}
