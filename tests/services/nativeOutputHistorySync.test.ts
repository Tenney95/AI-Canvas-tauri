import { IDBFactory, IDBKeyRange, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';
import type { OutputHistoryEntry } from '../../src/types';

const canvasId = 'c2-11111111-1111-4111-8111-111111111111';
const ownerProjectId = 'p2-11111111-1111-4111-8111-111111111111';
const rootRef = 'r2-11111111-1111-4111-8111-111111111111';
const io = vi.hoisted(() => ({ read: vi.fn(), capture: vi.fn(), display: vi.fn() }));
vi.mock('../../src/services/nativeOutputHistory', () => ({ readNativeOutputHistory: io.read }));
vi.mock('../../src/services/nativeMediaDisplay', async (original) => ({
  ...await original<typeof import('../../src/services/nativeMediaDisplay')>(), createNativeMediaDisplayResolver: () => io.display,
}));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/nativeProjectRepository')>(), readNativeProjectCapture: io.capture,
}));

function candidate(ordinal = 0) {
  const sha256 = (ordinal + 1).toString(16).padStart(64, '0');
  const entry: OutputHistoryEntry = { id: `hist-native-${canvasId}-operation-${ordinal}`, projectId: canvasId,
    nodeId: 'original-node', nodeLabel: '原始生成', timestamp: ordinal + 1, prompt: `原稿-${ordinal}`,
    output: `media/${sha256}.png`, nodeType: 'ai-image', model: 'image-model', provider: 'fixture', status: 'success' };
  return { entry, ownerProjectId, rootRef, relativePath: entry.output, sha256, bytes: 10 };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });
  io.read.mockReset().mockImplementation(async (id: string) => id === canvasId ? [candidate()] : []);
  io.capture.mockReset().mockResolvedValue({ aggregate: { project: { id: ownerProjectId, epoch: 0, storageRootRef: rootRef,
    storageBindings: [] }, canvases: [{ id: canvasId, epoch: 0 }] } });
  io.display.mockReset().mockImplementation(async (_root: string, file: { relativePath: string }) => ({
    filePath: `/fixture/${file.relativePath}`, url: `asset:///fixture/${file.relativePath}`,
  }));
});

it('面板与节点历史、筛选和导出共用确定性记录，另一画布不串入', async () => {
  const service = await import('../../src/services/indexedDbService');
  const [page, count] = await Promise.all([service.getHistoryEntriesPage(canvasId, 16), service.getHistoryEntryCount(canvasId)]);
  expect(count).toBe(1);
  expect(page.records).toMatchObject([{ id: candidate().entry.id, prompt: '原稿-0', relativePath: candidate().relativePath,
    storageRootRef: rootRef, mediaUrl: `asset:///fixture/${candidate().relativePath}` }]);
  expect(await service.getNodeHistoryEntries(canvasId, 'original-node')).toEqual(page.records);
  expect(await service.getHistoryEntriesForExport(canvasId, { search: '原稿' })).toEqual(page.records);
  expect((await service.getHistoryEntriesPage('c2-22222222-2222-4222-8222-222222222222', 16)).records).toEqual([]);
  expect(io.display).toHaveBeenCalledOnce();
});

it.each(['entry', 'node', 'all'] as const)('删除或清空%s后重播原outbox不恢复记录', async (scope) => {
  const service = await import('../../src/services/indexedDbService');
  await service.getHistoryEntriesPage(canvasId, 16);
  if (scope === 'entry') await service.deleteHistoryEntryFromDb(canvasId, candidate().entry.id);
  else if (scope === 'node') await service.deleteNodeHistoryEntries(canvasId, 'original-node');
  else await service.clearAllHistoryEntries(canvasId);
  expect(await service.getHistoryEntryCount(canvasId)).toBe(0);
  expect((await service.getHistoryEntriesPage(canvasId, 16)).records).toEqual([]);
});

it('16条裁剪后删除新记录，不会让被裁剪的旧outbox复活', async () => {
  io.read.mockResolvedValue(Array.from({ length: 17 }, (_, index) => candidate(index)));
  const service = await import('../../src/services/indexedDbService');
  const page = await service.getHistoryEntriesPage(canvasId, 16);
  expect(page.records).toHaveLength(16);
  expect(page.records.some((entry) => entry.id === candidate(0).entry.id)).toBe(false);
  await service.deleteHistoryEntryFromDb(canvasId, candidate(16).entry.id);
  expect(await service.getHistoryEntryCount(canvasId)).toBe(15);
  expect((await service.getHistoryEntriesPage(canvasId, 16)).records.some((entry) => entry.id === candidate(0).entry.id)).toBe(false);
});

it('文件暂不可读不消费原outbox，恢复后可补记且没有模型请求', async () => {
  io.display.mockRejectedValueOnce(new Error('磁盘暂不可用'));
  const service = await import('../../src/services/indexedDbService');
  expect((await service.getHistoryEntriesPage(canvasId, 16)).records).toEqual([]);
  expect(await service.getHistoryEntryCount(canvasId)).toBe(1);
  expect(io.display).toHaveBeenCalledTimes(2);
});

it('投影事务中止同时回滚记录和消费标记，后续可重新投影', async () => {
  const original = FakeIDBObjectStore.prototype.put;
  let injected = false;
  const put = vi.spyOn(FakeIDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = key === undefined ? original.call(this, value) : original.call(this, value, key);
    if (!injected && this.name === 'metadata' && typeof value.id === 'string' && value.id.startsWith('native-output-history-projected:')) {
      injected = true;
      request.addEventListener('success', () => queueMicrotask(() => this.transaction.abort()), { once: true });
    }
    return request;
  });
  const service = await import('../../src/services/indexedDbService');
  await expect(service.getHistoryEntriesPage(canvasId, 16)).rejects.toBeDefined();
  expect(injected).toBe(true);
  put.mockRestore();
  expect(await service.getHistoryEntryCount(canvasId)).toBe(1);
  expect(io.display).toHaveBeenCalledTimes(2);
});
