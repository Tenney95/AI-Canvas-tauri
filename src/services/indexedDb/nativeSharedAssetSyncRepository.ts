/** 新项目共享素材跨库提交的持久写锁；不持久化原生授权令牌。 */
import type { DramaAssetLibrary } from '../../types/dramaAssets';
import type { EpisodeRecord, ProjectContent, ProjectRecord } from '../../types/project';
import { configValuesEqual } from '../configPatch';
import { EXCHANGE } from './nativeProjectRepository';
import { validateNativeAsset, type NativeAssetRecord } from './nativeAssetRepository';
import { openDB, STORE_METADATA } from './schema';
import { assertNoPendingNativeSharedSync, CANVASES, CONTENTS, isNativeCanvasId, isNativeEpisodeId, isNativeProjectId, openNativeProjectDatabase,
  REVISIONS, ROOTS, TRANSFER, transact, validateContentSlice, type NativeProjectOptions } from './nativeProjectRepository';

export interface NativeSharedAssetJournal {
  kind: 'native-shared-sync'; operationId: string; sourceOperationId: string; projectId: string;
  phase: 'prepared' | 'finalized' | 'aborted'; expectedProjectEpoch: number; expectedAssetsRevision: number;
  expectedLibrary: DramaAssetLibrary | undefined; nextLibrary: DramaAssetLibrary | undefined;
  hasLibraryUpdate: boolean; memberIds: string[]; receiptDigest: string; createdAt: number;
  nativeAssets?: NativeAssetRecord[];
}

const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error ?? new Error('共享同步记录读取失败'));
});
const key = (operationId: string) => `shared-${operationId}`;
const receiptKey = (operationId: string) => `native-shared-sync:${operationId}`;
const validOperation = (operationId: string) => /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(operationId);
const fail = () => new Error('新项目共享同步状态已变化，请恢复原操作');
const requireStrict = (tx: IDBTransaction) => {
  if (tx.durability !== 'strict') throw new Error('当前运行环境不能保证共享同步收据耐久，项目写锁已保留');
};

/** 先冻结正文基线及身份；只有同一操作可读取它，正常项目写入被仓储写锁阻止。 */
export async function prepareNativeSharedAssetSync(input: {
  projectId: string; operationId: string; expectedProjectEpoch: number; expectedAssetsRevision: number;
  expectedLibrary: DramaAssetLibrary | undefined; nextLibrary?: DramaAssetLibrary; receiptDigest: string;
  nativeAssets?: NativeAssetRecord[];
}, options: NativeProjectOptions = {}): Promise<NativeSharedAssetJournal> {
  const fixed = structuredClone(input);
  if (!isNativeProjectId(fixed.projectId) || !validOperation(fixed.operationId)
    || !Number.isSafeInteger(fixed.expectedProjectEpoch) || fixed.expectedProjectEpoch < 0
    || !Number.isSafeInteger(fixed.expectedAssetsRevision) || fixed.expectedAssetsRevision < 0
    || !/^[a-f0-9]{64}$/.test(fixed.receiptDigest)) throw fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) throw fail();
  try {
    return await transact(db, 'readwrite', options, async (tx) => {
      requireStrict(tx);
      const store = tx.objectStore(TRANSFER);
      const operationId = key(fixed.operationId);
      const existing = await request(store.get(operationId)) as NativeSharedAssetJournal | undefined;
      if (existing) {
        if (existing.phase === 'aborted') throw new Error('原共享同步的本机应用已撤销，请先核对远端和原操作');
        if (existing.kind !== 'native-shared-sync' || existing.projectId !== fixed.projectId
          || existing.receiptDigest !== fixed.receiptDigest || existing.sourceOperationId !== fixed.operationId
          || existing.expectedProjectEpoch !== fixed.expectedProjectEpoch || existing.expectedAssetsRevision !== fixed.expectedAssetsRevision
          || !configValuesEqual(existing.expectedLibrary, fixed.expectedLibrary)
          || existing.hasLibraryUpdate !== (fixed.nextLibrary !== undefined)
          || !configValuesEqual(existing.nativeAssets ?? [], fixed.nativeAssets ?? [])
          || !configValuesEqual(existing.nextLibrary, fixed.nextLibrary)) throw fail();
        return existing;
      }
      await assertNoPendingNativeSharedSync(tx, fixed.projectId);
      for (const asset of fixed.nativeAssets ?? []) {
        validateNativeAsset(asset);
        const live = await request(tx.objectStore(EXCHANGE).get(`asset:${asset.assetId}`)) as { record?: NativeAssetRecord } | undefined;
        if (asset.projectId !== fixed.projectId || !configValuesEqual(live?.record, asset)) throw fail();
      }
      const operations = await request(store.index('projectId').getAll(fixed.projectId)) as Array<{ kind?: string; phase?: string }>;
      if (operations.some((row) => row.kind === 'project-model-import' && row.phase !== 'finalized'
        || row.kind === 'project-model-export' && row.phase !== 'registered')) throw fail();
      const [project, content, revision, canvasKeys, episodes] = await Promise.all([
        request(tx.objectStore(ROOTS).get(fixed.projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(CONTENTS).get(fixed.projectId)) as Promise<ProjectContent | undefined>,
        request(tx.objectStore(REVISIONS).get(fixed.projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        request(tx.objectStore(CANVASES).index('projectId').getAllKeys(fixed.projectId)),
        request(tx.objectStore('episodes').index('projectId').getAll(fixed.projectId)) as Promise<EpisodeRecord[]>,
      ]);
      if (!project || project.id !== fixed.projectId || project.epoch !== fixed.expectedProjectEpoch || !content
        || content.projectId !== fixed.projectId || content.revisions.assets !== fixed.expectedAssetsRevision
        || !configValuesEqual(content.dramaAssets, fixed.expectedLibrary) || !revision || revision.projectId !== fixed.projectId
        || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) throw fail();
      validateContentSlice(project, content, canvasKeys);
      if (fixed.nextLibrary !== undefined) {
        if (content.revisions.assets >= Number.MAX_SAFE_INTEGER) throw fail();
        validateContentSlice(project, { ...content, dramaAssets: fixed.nextLibrary,
          revisions: { ...content.revisions, assets: content.revisions.assets + 1 } }, canvasKeys);
      }
      const episodeIds = episodes.map((episode) => episode.id), episodeCanvases = episodes.map((episode) => episode.canvasId);
      if (canvasKeys.some((id) => !isNativeCanvasId(id)) || episodes.some((episode) => !isNativeEpisodeId(episode.id)
        || episode.projectId !== fixed.projectId || !isNativeCanvasId(episode.canvasId))
        || new Set(episodeCanvases).size !== episodes.length || new Set(episodeIds).size !== episodes.length
        || (project.kind === 'standalone' ? episodes.length !== 0 || canvasKeys.length !== 1
          : canvasKeys.length !== episodes.length || episodeCanvases.some((id) => !canvasKeys.includes(id)))) throw fail();
      const memberIds = [fixed.projectId, ...canvasKeys, ...episodeIds];
      if (memberIds.some((id) => typeof id !== 'string') || new Set(memberIds).size !== memberIds.length) throw fail();
      const journal: NativeSharedAssetJournal = { kind: 'native-shared-sync', operationId, sourceOperationId: fixed.operationId,
        projectId: fixed.projectId, phase: 'prepared', expectedProjectEpoch: fixed.expectedProjectEpoch,
        expectedAssetsRevision: fixed.expectedAssetsRevision, expectedLibrary: fixed.expectedLibrary, nextLibrary: fixed.nextLibrary,
        hasLibraryUpdate: fixed.nextLibrary !== undefined, memberIds: memberIds as string[], receiptDigest: fixed.receiptDigest, createdAt: Date.now(),
        ...(fixed.nativeAssets?.length ? { nativeAssets: fixed.nativeAssets } : {}) };
      await request(store.add(journal));
      return journal;
    }, [ROOTS, CONTENTS, REVISIONS, CANVASES, 'episodes', EXCHANGE, TRANSFER], true);
  } finally { db.close(); }
}

/** 只在旧库事务确有原操作收据时提交正文；重试复核同一 journal，绝不重新下载。 */
export async function finalizeNativeSharedAssetSync(journal: NativeSharedAssetJournal,
  options: NativeProjectOptions = {}): Promise<NativeSharedAssetJournal> {
  if (journal.kind !== 'native-shared-sync' || journal.operationId !== key(journal.sourceOperationId)
    || !isNativeProjectId(journal.projectId) || !/^[a-f0-9]{64}$/.test(journal.receiptDigest)) throw fail();
  const legacy = await openDB();
  const receipt = await request(legacy.transaction(STORE_METADATA, 'readonly').objectStore(STORE_METADATA).get(receiptKey(journal.sourceOperationId))) as
    { id: string; projectId: string; digest: string; status?: string } | undefined;
  if (!receipt) throw new Error('原共享同步尚无旧库提交收据，项目写锁与原操作已保留，不能自动撤销或重投');
  if (receipt.id !== receiptKey(journal.sourceOperationId) || receipt.projectId !== journal.projectId
    || receipt.digest !== journal.receiptDigest || receipt.status !== undefined) throw fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) throw fail();
  try {
    return await transact(db, 'readwrite', options, async (tx) => {
      requireStrict(tx);
      const store = tx.objectStore(TRANSFER);
      const current = await request(store.get(journal.operationId)) as NativeSharedAssetJournal | undefined;
      if (!current || !configValuesEqual({ ...current, phase: journal.phase }, journal)) throw fail();
      if (current.phase === 'finalized') return current;
      if (current.phase !== 'prepared') throw fail();
      const [project, content, revision, canvasKeys] = await Promise.all([
        request(tx.objectStore(ROOTS).get(current.projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(CONTENTS).get(current.projectId)) as Promise<ProjectContent | undefined>,
        request(tx.objectStore(REVISIONS).get(current.projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        request(tx.objectStore(CANVASES).index('projectId').getAllKeys(current.projectId)),
      ]);
      if (!project || project.epoch !== current.expectedProjectEpoch || !content || content.projectId !== current.projectId
        || content.revisions.assets !== current.expectedAssetsRevision || !configValuesEqual(content.dramaAssets, current.expectedLibrary)
        || !revision || revision.projectId !== current.projectId || !Number.isSafeInteger(revision.changeRevision)
        || revision.changeRevision < 0 || revision.changeRevision >= Number.MAX_SAFE_INTEGER) throw fail();
      if (current.hasLibraryUpdate) {
        if (!current.nextLibrary || content.revisions.assets >= Number.MAX_SAFE_INTEGER) throw fail();
        const next = validateContentSlice(project, { ...content, dramaAssets: current.nextLibrary,
          revisions: { ...content.revisions, assets: content.revisions.assets + 1 } }, canvasKeys);
        await request(tx.objectStore(CONTENTS).put(next));
        await request(tx.objectStore(REVISIONS).put({ projectId: current.projectId, changeRevision: revision.changeRevision + 1 }));
      }
      const complete: NativeSharedAssetJournal = { ...current, phase: 'finalized' };
      await request(store.put(complete));
      return complete;
    }, [ROOTS, CONTENTS, REVISIONS, CANVASES, TRANSFER], true);
  } finally { db.close(); }
}

export function nativeSharedAssetReceiptKey(operationId: string): string { return receiptKey(operationId); }

/** 按原共享 operationId 查询；调用方只能续接这份持久材料。 */
export async function readNativeSharedAssetSync(operationId: string, options: NativeProjectOptions = {}): Promise<NativeSharedAssetJournal | null> {
  if (!validOperation(operationId)) throw fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) return null;
  try {
    return await transact(db, 'readonly', options, async (tx) => {
      const row = await request(tx.objectStore(TRANSFER).get(key(operationId))) as NativeSharedAssetJournal | undefined;
      if (!row) return null;
      if (row.kind !== 'native-shared-sync' || row.sourceOperationId !== operationId || row.operationId !== key(operationId)
        || !isNativeProjectId(row.projectId) || !['prepared', 'finalized', 'aborted'].includes(row.phase)
        || !/^[a-f0-9]{64}$/.test(row.receiptDigest)) throw fail();
      return row;
    }, [TRANSFER]);
  } finally { db.close(); }
}

export async function recoverNativeSharedAssetSync(operationId: string, options: NativeProjectOptions = {}): Promise<NativeSharedAssetJournal> {
  const journal = await readNativeSharedAssetSync(operationId, options);
  if (!journal) throw new Error('共享同步原操作不存在');
  return finalizeNativeSharedAssetSync(journal, options);
}

/** 旧库撤销收据与提交收据争用同一事务锁；收据持久后，迟到的提交必定失败。 */
export async function abortNativeSharedAssetSync(operationId: string, options: NativeProjectOptions = {}): Promise<NativeSharedAssetJournal> {
  const journal = await readNativeSharedAssetSync(operationId, options);
  if (!journal) throw new Error('共享同步原操作不存在');
  if (journal.phase === 'aborted') return journal;
  if (journal.phase !== 'prepared') throw new Error('原共享同步已经完成，不能撤销本机应用');
  const legacy = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction(STORE_METADATA, 'readwrite', { durability: 'strict' });
    requireStrict(tx);
    const store = tx.objectStore(STORE_METADATA);
    let reason: Error | undefined;
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(reason ?? tx.error ?? fail());
    tx.onerror = () => { /* onabort reports the transaction failure */ };
    const get = store.get(receiptKey(operationId));
    get.onsuccess = () => {
      const existing = get.result as { id: string; projectId: string; digest: string; status?: string } | undefined;
      if (existing && (existing.id !== receiptKey(operationId) || existing.projectId !== journal.projectId
        || existing.digest !== journal.receiptDigest || existing.status !== 'aborted')) {
        reason = new Error('原共享同步已有提交收据或收据冲突，请恢复原操作，项目写锁已保留');
        tx.abort();
        return;
      }
      if (!existing) store.put({ id: receiptKey(operationId), projectId: journal.projectId, digest: journal.receiptDigest, status: 'aborted' });
    };
  });
  const db = await openNativeProjectDatabase(false, options); if (!db) throw fail();
  try {
    return await transact(db, 'readwrite', options, async (tx) => {
      requireStrict(tx);
      const store = tx.objectStore(TRANSFER);
      const current = await request(store.get(journal.operationId)) as NativeSharedAssetJournal | undefined;
      if (!current || !configValuesEqual({ ...current, phase: journal.phase }, journal)) throw fail();
      if (current.phase === 'aborted') return current;
      if (current.phase !== 'prepared') throw fail();
      const aborted: NativeSharedAssetJournal = { ...current, phase: 'aborted' };
      await request(store.put(aborted));
      return aborted;
    }, [TRANSFER], true);
  } finally { db.close(); }
}

/** 恢复只能选择原项目上的原操作；未知或损坏材料不自动清理。 */
export async function listPendingNativeSharedAssetSync(projectId: string, options: NativeProjectOptions = {}): Promise<NativeSharedAssetJournal[]> {
  if (!isNativeProjectId(projectId)) throw fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) return [];
  try {
    return await transact(db, 'readonly', options, async (tx) => {
      const rows = await request(tx.objectStore(TRANSFER).index('projectId').getAll(projectId)) as NativeSharedAssetJournal[];
      return rows.filter((row) => row.kind === 'native-shared-sync' && row.phase !== 'finalized' && row.phase !== 'aborted');
    }, [TRANSFER]);
  } finally { db.close(); }
}
