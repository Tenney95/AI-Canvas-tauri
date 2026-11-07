/** P2 旧媒体重定位边界：冻结源与恢复材料不允许被递归改写。未自动执行。 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROJECT_MODEL_SOURCE_FREEZE_KEY } from '../../src/types/projectModelJournal';
import {
  completeMediaRelocation, persistAssetRepairBatch, persistMediaRelocation, withRelocatedMedia,
  type MediaRelocation,
} from '../../src/services/indexedDb/mediaRelocations';

const io = vi.hoisted(() => ({ open: vi.fn<() => Promise<IDBDatabase>>() }));
vi.mock('../../src/services/indexedDb/schema', () => ({ openDB: io.open, STORE_METADATA: 'metadata' }));

let database: IDBDatabase;
const move: MediaRelocation = {
  projectId: 'p', oldPath: 'D:/fixture/a.png', newPath: 'D:/fixture/b.png',
  assetUrl: 'asset://new', oldAssetUrl: 'asset://old', relativePath: 'b.png',
};
const original = { id: 'p', name: '旧项目', nodes: [{ id: 'n', data: { filePath: move.oldPath } }], edges: [] };
const before = { assetId: 'asset', path: move.oldPath, fingerprint: '4:1' };
const repair: MediaRelocation = { ...move, assetMove: {
  assetId: 'asset', source: 'project', projectId: 'p', rootPath: 'D:/fixture',
  totalBytes: 4, mtimeMs: 2, digest: 'a'.repeat(64), repair: true,
} };

beforeEach(async () => {
  const factory = new IDBFactory();
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('ai-canvas-model-fixture-relocations', 28);
    request.onupgradeneeded = () => {
      for (const store of ['projects', 'metadata', 'history', 'projectRoots', 'projectModelMigrations', 'projectExchangeSnapshots']) {
        request.result.createObjectStore(store, { keyPath: 'id' });
      }
      request.result.createObjectStore('assetIndex', { keyPath: 'assetId' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  io.open.mockResolvedValue(database);
  await put('projects', original);
  await put('assetIndex', before);
});
afterEach(() => database.close());

async function put(store: string, value: unknown) {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, 'readwrite');
    transaction.objectStore(store).put(value);
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
  });
}
async function read(store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

it('无模型标记的旧业务仍修复活动记录，恢复快照和非活动代不进入扫描清单', async () => {
  const recovery = { id: 'project-import-recovery:old', records: [original], state: { path: move.oldPath } };
  const inactive = { id: 'inactive', generation: 7, filePath: move.oldPath };
  const immutable = { id: 'revision', snapshot: original, contentDigest: 'b'.repeat(64) };
  await put('metadata', recovery);
  await put('projectRoots', inactive);
  await put('projectExchangeSnapshots', immutable);
  await persistMediaRelocation(move);
  expect(await read('projects', 'p')).toMatchObject({ nodes: [{ data: { filePath: move.newPath } }] });
  expect(await read('metadata', recovery.id)).toEqual(recovery);
  expect(await read('projectRoots', inactive.id)).toEqual(inactive);
  expect(await read('projectExchangeSnapshots', immutable.id)).toEqual(immutable);
});

it('修复仅改已知可变图片metadata，保留导入journal、回执、墓碑与未知材料', async () => {
  const protectedRows = [
    { id: 'project-import-recovery:old', records: [original] },
    { id: 'project-import-operation:old', receipt: { filePath: move.oldPath } },
    { id: 'mcp-operation:key', taskId: 'paid-task', sequence: 4, output: move.oldPath },
    { id: 'forgotten-missing-path:old', filePath: move.oldPath, forgottenAt: 10 },
    { id: 'unknown-record', filePath: move.oldPath },
    { id: 'recent-asset-usage', entries: [{ assetId: 'asset', usedAt: 10 }] },
    { id: 'video-batches:p', batches: [{ id: 'batch', items: [{ nodeId: 'n', fingerprint: move.oldPath }] }] },
  ];
  for (const row of protectedRows) await put('metadata', row);
  await put('metadata', { id: 'asset-image:picture', assetId: 'asset', prompt: `@asset{${encodeURIComponent(move.oldPath)}}` });
  await persistAssetRepairBatch([repair], [before]);
  expect(await read('assetIndex', 'asset')).toMatchObject({ path: move.newPath });
  expect(await read('metadata', 'asset-image:picture')).toMatchObject({ prompt: `@asset{${encodeURIComponent(move.newPath)}}` });
  for (const row of protectedRows) expect(await read('metadata', row.id)).toEqual(row);
});

it.each([
  { id: PROJECT_MODEL_SOURCE_FREEZE_KEY, operationId: 'op', generation: 1, state: 'frozen' },
  { id: PROJECT_MODEL_SOURCE_FREEZE_KEY, unexpected: true },
  { id: 'activeDataModel', modelVersion: 2, generation: 1 },
  { id: 'activeDataModel', modelVersion: 999, generation: 'unrecognized' },
])('冻结或未知模型标记阻断全部旧媒体写入与迟到保存：$id', async (marker) => {
  const journal = { id: 'media-relocations', moves: [move], pending: [move] };
  await put('metadata', journal);
  await put('metadata', marker);
  await expect(persistMediaRelocation(move)).rejects.toThrow('冻结');
  await expect(persistAssetRepairBatch([repair], [before])).rejects.toThrow('冻结');
  await expect(completeMediaRelocation(move)).rejects.toThrow('冻结');
  let wrote = false;
  await expect(new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['projects', 'metadata'], 'readwrite');
    withRelocatedMedia(transaction, original, (value) => { wrote = true; transaction.objectStore('projects').put(value); });
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(new Error('late write blocked'));
  })).rejects.toThrow('late write blocked');
  expect(wrote).toBe(false);
  expect(await read('projects', 'p')).toEqual(original);
  expect(await read('assetIndex', 'asset')).toEqual(before);
  expect(await read('metadata', journal.id)).toEqual(journal);
  expect(await read('metadata', marker.id)).toEqual(marker);
});
