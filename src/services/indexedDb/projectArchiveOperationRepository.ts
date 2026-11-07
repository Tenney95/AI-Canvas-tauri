/** 旧库归档操作只保存可移植材料和不透明回执；不把输出绝对路径写入 metadata。 */
import type { ProjectExchangeCheckpointInput } from './projectExchangeRepository';
import { openDB, STORE_METADATA, STORE_PROJECTS, STORE_PROJECT_EXCHANGE_STATES } from './schema';
import { withLegacyProjectWrite } from './legacyProjectWriteGuard';
import { configValuesEqual } from '../configPatch';
import { projectTransferWriteTransaction } from './projectTransferTransaction';

export type LegacyArchiveExportPhase = 'prepared' | 'packing' | 'published' | 'registered' | 'aborted';
export interface LegacyArchiveExportOperation {
  id: string; operationId: string; ownerId: string; phase: LegacyArchiveExportPhase;
  sequence: number; createdAt: number; updatedAt: number;
  checkpoint: ProjectExchangeCheckpointInput;
  publicationRef?: string; archiveSha256?: string;
}
const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const key = (operationId: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId)) throw new Error('归档操作身份无效');
  return `project-export-operation:${operationId}`;
};
export async function readLegacyArchiveExport(operationId: string): Promise<LegacyArchiveExportOperation | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly'), request = tx.objectStore(STORE_METADATA).get(key(operationId));
    tx.oncomplete = () => resolve(request.result ?? null);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('归档操作记录不可读'));
  });
}
export async function prepareLegacyArchiveExport(operationId: string, checkpoint: ProjectExchangeCheckpointInput): Promise<LegacyArchiveExportOperation> {
  const db = await openDB();
  const now = Date.now();
  const next: LegacyArchiveExportOperation = { id: key(operationId), operationId, ownerId: checkpoint.state.ownerId,
    checkpoint: structuredClone(checkpoint), phase: 'prepared', sequence: 1, createdAt: now, updatedAt: now };
  return new Promise((resolve, reject) => {
    const tx = projectTransferWriteTransaction(db, [STORE_METADATA, STORE_PROJECTS, STORE_PROJECT_EXCHANGE_STATES]); let failure: unknown, result = next;
    withLegacyProjectWrite(tx, () => {
      const store = tx.objectStore(STORE_METADATA), request = store.get(next.id);
      request.onsuccess = () => {
        if (request.result) {
          if (!configValuesEqual(request.result.checkpoint, next.checkpoint)) {
            failure = new Error('归档操作身份已用于其他内容'); tx.abort(); return;
          }
          result = request.result; return;
        }
        const owner = tx.objectStore(STORE_PROJECTS).get(next.ownerId);
        owner.onsuccess = () => {
          if (!owner.result || owner.result.parentId) { failure = new Error('原导出作品已删除'); tx.abort(); return; }
          const state = tx.objectStore(STORE_PROJECT_EXCHANGE_STATES).get(next.ownerId);
          state.onsuccess = () => {
            if (!configValuesEqual(state.result ?? null, next.checkpoint.expectedState)) {
              failure = new Error('协作版本在导出准备期间变化，请重新捕获'); tx.abort(); return;
            }
            checkPending();
          };
        };
        // 首次导出也必须按作品串行，否则两个未登记的包会各自生成不同 lineage。
        const checkPending = () => {
          const cursor = store.openCursor(IDBKeyRange.bound('project-export-operation:', 'project-export-operation:\uffff'));
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) { store.add(next); return; }
            const previous = row.value as LegacyArchiveExportOperation;
            if (previous.ownerId === next.ownerId && !['registered', 'aborted'].includes(previous.phase)) {
              failure = new Error(`作品已有未完成导出 ${previous.operationId}，请先核对原发布回执`); tx.abort(); return;
            }
            row.continue();
          };
        };
      };
    }, (error) => { failure = error; });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('归档准备未保存'));
  });
}
export async function advanceLegacyArchiveExport(operationId: string, expectedSequence: number, phase: LegacyArchiveExportPhase,
  receipt?: { publicationRef: string; archiveSha256: string }): Promise<LegacyArchiveExportOperation> {
  const db = await openDB();
  const phases: LegacyArchiveExportPhase[] = ['prepared', 'packing', 'published', 'registered'];
  if (receipt && (!validId(receipt.publicationRef) || !/^[a-f0-9]{64}$/.test(receipt.archiveSha256))) throw new Error('原生归档发布回执无效');
  return new Promise((resolve, reject) => {
    const tx = projectTransferWriteTransaction(db, STORE_METADATA); let failure: unknown, next: LegacyArchiveExportOperation;
    withLegacyProjectWrite(tx, () => {
      const store = tx.objectStore(STORE_METADATA), request = store.get(key(operationId));
      request.onsuccess = () => {
        try {
          const current = request.result as LegacyArchiveExportOperation | undefined;
          const allowed = phase === 'aborted' ? current?.phase === 'prepared'
            : phase !== 'prepared' && current?.phase !== 'aborted' && phases.indexOf(phase) === phases.indexOf(current?.phase as LegacyArchiveExportPhase) + 1;
          if (!current || current.sequence !== expectedSequence || !allowed) {
            throw new Error('归档发布阶段已变化，请先核对原操作');
          }
          if (phase === 'published' && !receipt) throw new Error('缺少已核验的原生发布回执');
          next = { ...current, ...receipt, phase, sequence: current.sequence + 1, updatedAt: Date.now() }; store.put(next);
        } catch (error) { failure = error; tx.abort(); }
      };
    }, (error) => { failure = error; });
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('归档发布登记失败'));
  });
}
