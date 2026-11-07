/** 旧项目写入的同事务门禁；回归源已编写，本轮不执行。 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withLegacyProjectWrite, assertLegacyProjectWritesAllowed } from '../../src/services/indexedDb/legacyProjectWriteGuard';

let database: IDBDatabase;
beforeEach(async () => {
  const factory = new IDBFactory();
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('legacy-write-guard', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' });
      request.result.createObjectStore('metadata', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
});
afterEach(() => database.close());

async function writeMarker(key: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('metadata', 'readwrite');
    transaction.objectStore('metadata').put({ id: key, unknownFutureShape: null });
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
  });
}
async function guardedWrite(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['projects', 'metadata'], 'readwrite');
    let failure: Error | undefined;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error);
    withLegacyProjectWrite(transaction, () => transaction.objectStore('projects').put({ id: 'p', name: '应保留的修改' }),
      (error) => { failure = error; });
  });
}
async function projects(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction('projects').objectStore('projects').getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

it('无标记的旧项目可预检及写入，不创建新模型数据', async () => {
  await assertLegacyProjectWritesAllowed(database); await guardedWrite();
  expect(await projects()).toEqual([{ id: 'p', name: '应保留的修改' }]);
  expect(Array.from(database.objectStoreNames)).toEqual(['metadata', 'projects']);
});

it.each(['project-model-source-freeze', 'activeDataModel', 'project-model-business-fixture'])(
  '%s 存在时拒绝旧写入，不猜测未知标记形状', async (key) => {
    await writeMarker(key);
    await expect(assertLegacyProjectWritesAllowed(database)).rejects.toThrow('旧项目写入已停止');
    await expect(guardedWrite()).rejects.toThrow('旧项目写入已停止');
    expect(await projects()).toEqual([]);
  },
);

it('预检通过后才出现冻结标记，最终事务仍拒绝写入', async () => {
  await assertLegacyProjectWritesAllowed(database); await writeMarker('project-model-source-freeze');
  await expect(guardedWrite()).rejects.toThrow('旧项目写入已停止');
  expect(await projects()).toEqual([]);
});

it('业务回调同步失败时整批中止，不留下半条保存', async () => {
  await expect(new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['projects', 'metadata'], 'readwrite');
    let failure: Error | undefined;
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(failure ?? transaction.error);
    withLegacyProjectWrite(transaction, () => {
      transaction.objectStore('projects').put({ id: 'p' });
      throw new Error('fixture-write-failed');
    }, (error) => { failure = error; });
  })).rejects.toThrow('fixture-write-failed');
  expect(await projects()).toEqual([]);
});
