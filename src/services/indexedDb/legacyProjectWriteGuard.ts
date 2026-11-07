/** 旧项目唯一写入路径的事务门禁；任何已定义的新模型标记都不能被猜作legacy。 */
import { STORE_METADATA } from './schema';
import { PROJECT_MODEL_SOURCE_FREEZE_KEY, PROJECT_MODEL_ACTIVE_MARKER_KEY } from '../../types/projectModelJournal';
import { PROJECT_MODEL_BUSINESS_FIXTURE_KEY } from '../../types/projectModelBusiness';

export function withLegacyProjectWrite(transaction: IDBTransaction, write: () => void,
  fail?: (error: Error) => void): void {
  let remaining = 3;
  let stopped = false;
  const stop = (error: Error) => {
    if (stopped) return;
    stopped = true;
    try { fail?.(error); }
    finally { try { transaction.abort(); } catch { /* 已结束的事务不能重新写入。 */ } }
  };
  try {
    const metadata = transaction.objectStore(STORE_METADATA);
    for (const key of [PROJECT_MODEL_SOURCE_FREEZE_KEY, PROJECT_MODEL_ACTIVE_MARKER_KEY, PROJECT_MODEL_BUSINESS_FIXTURE_KEY]) {
      const request = metadata.get(key);
      request.onsuccess = () => {
        if (stopped) return;
        if (request.result !== undefined) {
          stop(new Error('项目模型状态已改变，旧项目写入已停止'));
          return;
        }
        if (--remaining !== 0) return;
        try { write(); }
        catch (error) { stop(error instanceof Error ? error : new Error('旧项目写入未完成')); }
      };
    }
  } catch (error) { stop(error instanceof Error ? error : new Error('旧项目写入门禁不可用')); }
}

/** 文件effect前的只读预检；不能代替最终写入事务里的同一门禁。 */
export function assertLegacyProjectWritesAllowed(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE_METADATA, 'readonly'); }
    catch { reject(new Error('无法核对旧项目写入状态')); return; }
    let failure: Error | undefined;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('旧项目写入状态核对失败'));
    withLegacyProjectWrite(transaction, () => undefined, (error) => { failure = error; });
  });
}
