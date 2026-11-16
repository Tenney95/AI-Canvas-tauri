/** 事务快照的项目分组互不污染，未知或损坏的材料仍关闭清理。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const mocks = vi.hoisted(() => ({ openDatabase: vi.fn() }));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', async () => ({
  ...await vi.importActual<typeof import('../../src/services/indexedDb/nativeProjectRepository')>(
    '../../src/services/indexedDb/nativeProjectRepository'),
  openNativeProjectDatabase: mocks.openDatabase,
}));

import { EXCHANGE, TRANSFER, RETIRED } from '../../src/services/indexedDb/nativeProjectRepository';
import {
  collectNativeStorageReferences, nativeStorageProjectProtected, nativeStorageProjectRows, readNativeStorageSnapshot,
} from '../../src/services/fs/nativeStorageReferences';

const first = 'p2-11111111-1111-4111-8111-111111111111';
const second = 'p2-22222222-2222-4222-8222-222222222222';
const canvas = 'c2-33333333-3333-4333-8333-333333333333';
let factory: IDBFactory;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open('native-storage-snapshot', 1);
    request.onupgradeneeded = () => {
      for (const name of [EXCHANGE, TRANSFER, RETIRED]) request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seed(rows: Partial<Record<typeof EXCHANGE | typeof TRANSFER | typeof RETIRED, unknown[]>>): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([EXCHANGE, TRANSFER, RETIRED], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
      for (const [name, values] of Object.entries(rows)) for (const row of values ?? []) tx.objectStore(name).put(row);
    });
  } finally { db.close(); }
}

beforeEach(() => {
  factory = new IDBFactory();
  mocks.openDatabase.mockReset().mockImplementation(openDatabase);
});

describe('原生存储快照的项目分组', () => {
  it('保持各命名空间原顺序，修改返回数组不会污染同一快照的后续查询', async () => {
    await seed({
      [EXCHANGE]: [
        { id: '1', ownerProjectId: first, kind: 'native-asset-v1', record: { projectId: first } },
        { id: '2', ownerProjectId: second, kind: 'future-operation' },
        { id: '3', ownerProjectId: first, kind: 'native-asset-v1' },
      ],
      [TRANSFER]: [{ id: 'transfer', targetProjectId: first, kind: 'project-model-export', phase: 'registered' }],
      [RETIRED]: [{ id: canvas, projectId: first, kind: 'canvas' }],
    });
    const snapshot = await readNativeStorageSnapshot();
    const rows = nativeStorageProjectRows(snapshot, first);
    expect(rows.exchange).toEqual([snapshot.exchange[0], snapshot.exchange[2]]);
    rows.exchange.reverse(); rows.transfers.length = 0; rows.retired.length = 0;
    expect(nativeStorageProjectRows(snapshot, first)).toEqual({
      exchange: [snapshot.exchange[0], snapshot.exchange[2]], transfers: snapshot.transfers, retired: snapshot.retired,
    });
    expect(nativeStorageProjectProtected(snapshot, first)).toBe(false);
    expect(nativeStorageProjectProtected(snapshot, second)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.exchange)).toBe(true);
    expect(Reflect.set(snapshot.exchange[0] as object, 'ownerProjectId', second)).toBe(false);
    expect(Reflect.set((snapshot.exchange[0] as { record: object }).record, 'projectId', second)).toBe(false);
    expect(nativeStorageProjectRows(snapshot, first).exchange).toHaveLength(2);
  });

  it('同一项目的新事务快照重新读取状态，旧快照不随数据库变化', async () => {
    await seed({ [EXCHANGE]: [{ id: 'task', ownerProjectId: first, kind: 'native-media-task-v1', status: 'delivered' }] });
    const before = await readNativeStorageSnapshot();
    expect(nativeStorageProjectProtected(before, first)).toBe(false);
    await seed({ [EXCHANGE]: [{ id: 'task', ownerProjectId: first, kind: 'native-media-task-v1', status: 'outcome-unknown' }] });
    const after = await readNativeStorageSnapshot();
    expect(after).not.toBe(before);
    expect(nativeStorageProjectProtected(after, first)).toBe(true);
    expect(nativeStorageProjectProtected(before, first)).toBe(false);
  });

  it('外部构造的可变材料不缓存项目分组，也不冻结其记录', () => {
    const row = { ownerProjectId: first, kind: 'native-asset-v1' };
    const snapshot = { exchange: [row], transfers: [], retired: [] };
    expect(nativeStorageProjectRows(snapshot, first).exchange).toEqual([row]);
    row.ownerProjectId = second;
    expect(nativeStorageProjectRows(snapshot, first).exchange).toEqual([]);
    expect(nativeStorageProjectRows(snapshot, second).exchange).toEqual([row]);
    const material = { relativePath: 'images/image.png' };
    expect(collectNativeStorageReferences(material, new Map([['root', '/project']]), 'root')).toContain('/project/images/image.png');
    expect(Object.isFrozen(material)).toBe(false);
  });

  it.each([
    { [EXCHANGE]: [{ id: 'broken', ownerProjectId: first, targetProjectId: second }] },
    { [RETIRED]: [{ id: canvas, projectId: first, kind: 'unknown' }] },
  ])('身份损坏或退役类型未知时拒绝生成快照', async (rows) => {
    await seed(rows);
    await expect(readNativeStorageSnapshot()).rejects.toThrow('新项目存储引用读取不完整');
  });
});
