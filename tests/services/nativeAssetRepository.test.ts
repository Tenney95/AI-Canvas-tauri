import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { addNativeAssetsInTransaction, readNativeAsset, validateNativeAsset, type NativeAssetRecord } from '../../src/services/indexedDb/nativeAssetRepository';
import { createNativeProject, EXCHANGE, openNativeProjectDatabase, transact } from '../../src/services/indexedDb/nativeProjectRepository';

const asset = (): NativeAssetRecord => ({ assetId: 'na2-11111111-1111-4111-8111-111111111111',
  projectId: 'p2-22222222-2222-4222-8222-222222222222', ownerId: 'p2-22222222-2222-4222-8222-222222222222',
  rootRef: 'r2-33333333-3333-4333-8333-333333333333', primary: true, relativePath: 'imports/recovery/a.png',
  bytes: 3, sha256: 'a'.repeat(64), createdAt: 1 });

describe('同库恢复素材身份', () => {
  it('拒绝路径越界、额外持久字段、访问器及错误图片元数据', () => {
    expect(() => validateNativeAsset(asset())).not.toThrow();
    for (const patch of [{ relativePath: '../a.png' }, { relativePath: 'C:/a.png' }, { path: 'C:/private/a.png' },
      { rootRef: 'r2-invalid' }, { ownerId: 'another-project' },
      { images: [{ assetId: asset().assetId, id: 'wrong-image-id', contentDigest: 'a'.repeat(64), references: [] }] }]) {
      expect(() => validateNativeAsset({ ...asset(), ...patch } as NativeAssetRecord)).toThrow();
    }
    let accessed = false;
    const record = Object.defineProperty(asset(), 'relativePath', { enumerable: true, get: () => { accessed = true; return 'a.png'; } });
    expect(() => validateNativeAsset(record)).toThrow();
    expect(accessed).toBe(false);
  });
  it('索引和上层事务一起回滚，错误归属不能留下半写入', async () => {
    const factory = new IDBFactory(), aggregate = await createNativeProject({ name: '隔离素材' }, { factory });
    const row: NativeAssetRecord = { ...asset(), projectId: aggregate.project.id, ownerId: aggregate.project.id,
      rootRef: aggregate.project.storageRootRef };
    const db = (await openNativeProjectDatabase(false, { factory }))!;
    try {
      await expect(transact(db, 'readwrite', { factory }, async (tx) => {
        await addNativeAssetsInTransaction(tx, [row], aggregate);
        throw new Error('模拟项目提交失败');
      }, [EXCHANGE], true)).rejects.toThrow('模拟项目提交失败');
      expect(await readNativeAsset(row.assetId, { factory })).toBeUndefined();
      await expect(transact(db, 'readwrite', { factory }, (tx) => addNativeAssetsInTransaction(tx,
        [{ ...row, primary: false }], aggregate), [EXCHANGE], true)).rejects.toThrow('归属');
      await transact(db, 'readwrite', { factory }, (tx) => addNativeAssetsInTransaction(tx, [row], aggregate), [EXCHANGE], true);
      expect(await readNativeAsset(row.assetId, { factory })).toEqual(row);
      await transact(db, 'readwrite', { factory }, async (tx) => {
        await new Promise<void>((resolve, reject) => {
          const request = tx.objectStore(EXCHANGE).put({ projectId: `asset:${row.assetId}`, kind: 'wrong-kind', record: row });
          request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
        });
      }, [EXCHANGE], true);
      await expect(readNativeAsset(row.assetId, { factory })).rejects.toThrow('损坏');
    } finally { db.close(); }
  });
});
