/** 独立 fake IndexedDB 演练跨库收据，不触及真实项目或云端。 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openDB: vi.fn<() => Promise<IDBDatabase>>() }));
vi.mock('../../src/services/indexedDb/schema', async () => ({
  ...await vi.importActual<typeof import('../../src/services/indexedDb/schema')>('../../src/services/indexedDb/schema'),
  openDB: mocks.openDB,
}));
import { createNativeProject, readNativeProjectContent, saveNativeProjectContent } from '../../src/services/indexedDb/nativeProjectRepository';
import { abortNativeSharedAssetSync, finalizeNativeSharedAssetSync, listPendingNativeSharedAssetSync, nativeSharedAssetReceiptKey,
  prepareNativeSharedAssetSync } from '../../src/services/indexedDb/nativeSharedAssetSyncRepository';

const projectId = 'p2-11111111-1111-4111-8111-111111111111';
const canvasId = 'c2-22222222-2222-4222-8222-222222222222';
let factory: IDBFactory, legacy: IDBDatabase;
beforeEach(async () => {
  factory = new IDBFactory();
  legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open('old-fixture', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('metadata', { keyPath: 'id' }); };
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  mocks.openDB.mockReset().mockResolvedValue(legacy);
});

async function putReceipt(id: string, digest: string) {
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({ id: nativeSharedAssetReceiptKey(id), projectId, digest });
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}

describe('新项目共享同步跨库收据', () => {
  it('冻结后普通写入停止；只有原旧库收据确认才能提交正文，重复恢复幂等', async () => {
    const initial = await createNativeProject({ projectId, canvasId, name: '新项目' }, { factory });
    const nextLibrary = { version: 2 as const, characters: [], scenes: [], props: [] };
    const operationId = '11111111-2222-4333-8444-555555555555', receiptDigest = 'a'.repeat(64);
    const input = { projectId, operationId, expectedProjectEpoch: initial.project.epoch,
      expectedAssetsRevision: 0, expectedLibrary: undefined, nextLibrary, receiptDigest };
    const journal = await prepareNativeSharedAssetSync(input, { factory });
    expect(journal.memberIds).toEqual(expect.arrayContaining([projectId, canvasId]));
    expect(await listPendingNativeSharedAssetSync(projectId, { factory })).toHaveLength(1);
    await expect(saveNativeProjectContent({ projectId, expectedProjectEpoch: initial.project.epoch,
      expectedRevisions: { script: 0 }, patch: { script: '不能抢写' } }, { factory })).rejects.toThrow('project-shared-sync-pending');
    await expect(finalizeNativeSharedAssetSync(journal, { factory })).rejects.toThrow();
    expect((await readNativeProjectContent(projectId, { factory }))?.content.dramaAssets).toBeUndefined();
    await putReceipt(operationId, receiptDigest);
    expect((await finalizeNativeSharedAssetSync(journal, { factory })).phase).toBe('finalized');
    expect((await finalizeNativeSharedAssetSync(journal, { factory })).phase).toBe('finalized');
    expect((await readNativeProjectContent(projectId, { factory }))?.content.dramaAssets).toEqual(nextLibrary);
    expect(await listPendingNativeSharedAssetSync(projectId, { factory })).toHaveLength(0);
  });

  it('来源基线或同一操作材料不一致时不接纳新提交', async () => {
    const initial = await createNativeProject({ projectId, canvasId, name: '新项目' }, { factory });
    const base = { projectId, operationId: 'op-one', expectedProjectEpoch: initial.project.epoch,
      expectedAssetsRevision: 0, expectedLibrary: undefined, receiptDigest: 'b'.repeat(64) };
    await expect(prepareNativeSharedAssetSync({ ...base, expectedAssetsRevision: 1 }, { factory })).rejects.toThrow();
    expect(await listPendingNativeSharedAssetSync(projectId, { factory })).toEqual([]);
    await prepareNativeSharedAssetSync(base, { factory });
    await expect(prepareNativeSharedAssetSync({ ...base, receiptDigest: 'c'.repeat(64) }, { factory })).rejects.toThrow();
  });

  it('先持久化撤销收据再释放写锁，重复撤销幂等，原操作不可重投', async () => {
    const initial = await createNativeProject({ projectId, canvasId, name: '新项目' }, { factory });
    const base = { projectId, operationId: 'op-abort', expectedProjectEpoch: initial.project.epoch,
      expectedAssetsRevision: 0, expectedLibrary: undefined, receiptDigest: 'd'.repeat(64) };
    const journal = await prepareNativeSharedAssetSync(base, { factory });
    expect((await abortNativeSharedAssetSync(base.operationId, { factory })).phase).toBe('aborted');
    expect((await abortNativeSharedAssetSync(base.operationId, { factory })).phase).toBe('aborted');
    await expect(finalizeNativeSharedAssetSync(journal, { factory })).rejects.toThrow();
    await expect(prepareNativeSharedAssetSync(base, { factory })).rejects.toThrow('已撤销');
    expect(await listPendingNativeSharedAssetSync(projectId, { factory })).toEqual([]);
    await saveNativeProjectContent({ projectId, expectedProjectEpoch: initial.project.epoch,
      expectedRevisions: { script: 0 }, patch: { script: '恢复编辑' } }, { factory });
    expect((await readNativeProjectContent(projectId, { factory }))?.content.script).toBe('恢复编辑');
  });

  it('已有提交收据时拒绝撤销并保留写锁，可继续按原收据恢复', async () => {
    const initial = await createNativeProject({ projectId, canvasId, name: '新项目' }, { factory });
    const base = { projectId, operationId: 'op-committed', expectedProjectEpoch: initial.project.epoch,
      expectedAssetsRevision: 0, expectedLibrary: undefined, receiptDigest: 'e'.repeat(64) };
    const journal = await prepareNativeSharedAssetSync(base, { factory });
    await putReceipt(base.operationId, base.receiptDigest);
    await expect(abortNativeSharedAssetSync(base.operationId, { factory })).rejects.toThrow('已有提交收据');
    expect(await listPendingNativeSharedAssetSync(projectId, { factory })).toHaveLength(1);
    expect((await finalizeNativeSharedAssetSync(journal, { factory })).phase).toBe('finalized');
  });
});
