/** 跨库历史交付与原native journal绑定；失败后只续接原材料，不重建执行任务。 */
import type { ProjectModelTransferHistoryRow, ProjectModelTransferIdMapEntry, ProjectModelTransferAggregate } from '../types/projectModelTransfer';
import { openDB, STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_PROJECT_MEMORIES, STORE_HISTORY, STORE_METADATA, STORE_PROJECTS } from './indexedDb/schema';
import { configValuesEqual } from './configPatch';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { sha256BytesHex } from './mediaDataUrl';
import { pruneProjectHistory } from './indexedDb/outputHistoryRetention';

interface HistoryOperation {
  operationId: string; targetProjectId: string; mode: 'import-new' | 'independent-copy' | 'update-existing' | 'restore-content';
  history: ProjectModelTransferHistoryRow[]; next: ProjectModelTransferAggregate; idMap: ProjectModelTransferIdMapEntry[];
}
const stores = { conversation: STORE_CHAT_CONVERSATIONS, message: STORE_CHAT_MESSAGES, memory: STORE_PROJECT_MEMORIES, output: STORE_HISTORY } as const;
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error('历史恢复失败'));
});
const digest = (value: unknown) => sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(value)));
const originKey = (projectId: string, row: ProjectModelTransferHistoryRow) =>
  `native-archive-output-origin:${encodeURIComponent(projectId)}:${encodeURIComponent(row.sourceNamespace)}:${row.archiveOriginId}`;

export async function commitNativeArchiveHistory(operation: HistoryOperation): Promise<void> {
  if (operation.mode === 'restore-content' && operation.history.length
    || operation.mode === 'update-existing' && operation.history.some((row) => row.kind !== 'output')) throw new Error('更新只能追加输出历史，恢复不回滚历史');
  const database = await openDB(), token = await digest(operation.history), markerId = `native-import-history:${operation.operationId}`;
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction([STORE_METADATA, STORE_PROJECTS, ...Object.values(stores)], 'readwrite');
    let failure: unknown, done = false;
    const work = async () => {
      const metadata = tx.objectStore(STORE_METADATA), existing = await request(metadata.get(markerId)) as { id: string; token: string } | undefined;
      const writtenCanvases = new Set<string>();
      if (existing && existing.token !== token) throw new Error('原导入历史回执不匹配');
      const ids = [operation.targetProjectId, ...operation.next.episodes.map((item) => item.id),
        ...operation.idMap.filter((item) => item.kind === 'canvas').map((item) => item.localId)];
      for (const id of ids) if (await request(tx.objectStore(STORE_PROJECTS).getKey(id)) !== undefined
        || await request(metadata.getKey(`project-deleted:${id}`)) !== undefined) throw new Error('新旧项目身份冲突，未导入');
      for (const row of operation.history) {
        const store = tx.objectStore(stores[row.kind]);
        if (row.kind === 'output') {
          const key = originKey(operation.targetProjectId, row);
          const bound = await request(metadata.get(key)) as { localId?: string } | undefined;
          if (bound) {
            if (bound.localId !== (row.existingLocalId ?? row.value.id)) throw new Error('原输出历史来源映射已变化');
            // 用户删除或修改已经交付的历史，不得让重复更新复活或覆盖它。
            continue;
          }
          const localId = row.existingLocalId ?? row.value.id;
          const actual = await request(store.get(localId));
          const forgotten = await request(metadata.getKey(`forgotten-missing-history:${encodeURIComponent(localId)}`));
          if (!row.existingLocalId && forgotten === undefined) {
            if (actual !== undefined && !configValuesEqual(actual, row.value)) throw new Error('导入输出历史身份冲突');
            if (actual === undefined) { await request(store.add(row.value)); writtenCanvases.add(row.value.projectId); }
          }
          await request(metadata.add({ id: key, localId, projectId: operation.targetProjectId }));
          continue;
        }
        const actual = await request(store.get(row.value.id));
        if (existing) {
          if (!configValuesEqual(actual, row.value)) throw new Error('已导入的历史记录发生变化，请核对原操作');
        } else {
          if (actual !== undefined) throw new Error('导入历史身份冲突，未覆盖已有数据');
          await request(store.add(row.value));
        }
      }
      for (const canvasId of writtenCanvases) pruneProjectHistory(tx.objectStore(STORE_HISTORY), canvasId);
      if (!existing) await request(metadata.add({ id: markerId, token, projectId: operation.targetProjectId }));
    };
    void work().then(() => { done = true; }, (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } });
    tx.oncomplete = () => done ? resolve() : reject(failure ?? new Error('历史恢复未完成'));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('历史恢复失败'));
  });
}

export async function assertNativeArchiveHistoryCommitted(operation: Pick<HistoryOperation, 'operationId' | 'history'>): Promise<void> {
  if (!operation.history.length) return;
  const expected = await digest(operation.history), database = await openDB();
  const value = await request(database.transaction(STORE_METADATA, 'readonly').objectStore(STORE_METADATA)
    .get(`native-import-history:${operation.operationId}`)) as { token?: string } | undefined;
  if (value?.token !== expected) throw new Error('项目输出历史尚未交付，原操作已保留');
}
