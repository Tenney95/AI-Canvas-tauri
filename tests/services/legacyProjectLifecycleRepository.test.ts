/** P3 旧格式生命周期安全回归源；本轮只编写，不执行。 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ database: null as IDBDatabase | null }));
vi.mock('../../src/services/indexedDb/schema', () => ({
  openDB: vi.fn(async () => holder.database!), STORE_METADATA: 'metadata',
  STORE_PROJECTS: 'projects', STORE_PROJECT_SUMMARIES: 'projectSummaries',
}));
import { deleteLegacyProjectContent, swapLegacyEpisodeOrder } from '../../src/services/indexedDb/legacyProjectLifecycleRepository';

const owner = { id: 'series', name: '整部剧', createdAt: 1, updatedAt: 2, exchangeEpoch: 4,
  nodes: [], edges: [], series: { script: '全剧资料' }, dramaAssets: { version: 2, characters: [], scenes: [], props: [] } };
const first = { id: 'ep-1', parentId: owner.id, episodeNo: 2, name: '第一集', createdAt: 1, updatedAt: 3,
  exchangeEpoch: 4, nodes: [{ id: 'n', data: { text: '保留画布' } }], edges: [], episodeScript: '较新正文',
  episodeScriptFile: { relativePath: 'manuscripts/旧稿.txt', fileName: '旧稿.txt', digest: 'a'.repeat(64), updatedAt: 3 },
  legacyExtension: { unknown: '保留未知字段' } };
const second = { id: 'ep-2', parentId: owner.id, episodeNo: 7, name: '第二集', createdAt: 1, updatedAt: 4,
  exchangeEpoch: 4, nodes: [], edges: [] };
const task = { id: 'paid-task', projectId: first.id, status: 'submit_unknown', toolCallCount: 9, receipt: 'original' };

beforeEach(async () => {
  const factory = new IDBFactory();
  holder.database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('legacy-lifecycle-memory-fixture', 1);
    request.onupgradeneeded = () => {
      for (const name of ['projects', 'projectSummaries', 'metadata', 'agentTasks', 'history', 'chatConversations', 'projectMemories']) {
        request.result.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await put('projects', [owner, first, second]);
  await put('projectSummaries', [owner, first, second]);
  await put('agentTasks', [task]);
  await put('history', [{ id: 'paid-output', projectId: first.id, output: 'original-output' }]);
  await put('metadata', [{ id: 'mcp-operation:old-key', sequence: 8, taskId: task.id }]);
});
afterEach(() => { vi.restoreAllMocks(); holder.database?.close(); holder.database = null; });

async function put(store: string, rows: unknown[]) {
  await new Promise<void>((resolve, reject) => {
    const tx = holder.database!.transaction(store, 'readwrite');
    for (const row of rows) tx.objectStore(store).put(row);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
async function rows(store: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = holder.database!.transaction(store, 'readonly').objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
const swap = () => swapLegacyEpisodeOrder({ ownerId: owner.id, expectedOwnerEpoch: 4,
  expectedEpisodes: [first, second], episodeId: second.id, direction: -1 });

it('原子交换两集集号，保存最新正文、未知字段、TXT引用和原有ID', async () => {
  const patches = await swap();
  expect(patches.map(({ id, episodeNo }) => ({ id, episodeNo }))).toEqual([
    { id: second.id, episodeNo: 2 }, { id: first.id, episodeNo: 7 },
  ]);
  expect(await rows('projects')).toContainEqual(expect.objectContaining({ ...first, episodeNo: 7, updatedAt: expect.any(Number), exchangeEpoch: 5 }));
  expect(await rows('projects')).toContainEqual(expect.objectContaining({ ...second, episodeNo: 2, updatedAt: expect.any(Number), exchangeEpoch: 5 }));
  expect(await rows('projectSummaries')).toContainEqual(expect.objectContaining({ id: first.id, episodeNo: 7 }));
  expect(await rows('agentTasks')).toEqual([task]);
});

it('第二条摘要写入失败时整次换序回滚，不留下半次排序', async () => {
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'projectSummaries' && (value as { id?: string }).id === first.id) throw new DOMException('fixture quota', 'QuotaExceededError');
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  });
  await expect(swap()).rejects.toThrow();
  expect(await rows('projects')).toEqual([first, second, owner]);
  expect(await rows('projectSummaries')).toEqual([first, second, owner]);
});

it('完整成员集合或冻结代际变化时拒绝旧排序和删除', async () => {
  await put('projects', [{ ...second, id: 'ep-3', episodeNo: 9 }]);
  await expect(swap()).rejects.toThrow();
  expect(await rows('projects')).toContainEqual(first);
  await put('metadata', [{ id: 'project-model-source-freeze', state: 'frozen' }]);
  await expect(deleteLegacyProjectContent({ targetId: first.id, expectedProjects: [first] })).rejects.toThrow();
  expect(await rows('projects')).toContainEqual(first);
});

it('删除分集仅移除业务与摘要，保留整剧和收费/幂等审计；旧末集拒绝', async () => {
  await expect(deleteLegacyProjectContent({ targetId: first.id, expectedProjects: [first] })).resolves.toEqual([first.id]);
  expect(await rows('projects')).toEqual([second, owner]);
  expect(await rows('agentTasks')).toEqual([task]);
  expect(await rows('history')).toEqual([{ id: 'paid-output', projectId: first.id, output: 'original-output' }]);
  expect(await rows('metadata')).toContainEqual({ id: 'mcp-operation:old-key', sequence: 8, taskId: task.id });
  expect(await rows('metadata')).toContainEqual(expect.objectContaining({ id: 'project-deleted:ep-1', retainedAudit: true, retainedDataDirectory: true }));
  await expect(deleteLegacyProjectContent({ targetId: second.id, expectedProjects: [second] })).rejects.toThrow('最后一集');
  expect(await rows('projects')).toEqual([second, owner]);
});

it('整剧业务聚合一事务删除，原目录与历史资料只留下明确保留标记', async () => {
  await expect(deleteLegacyProjectContent({ targetId: owner.id, expectedProjects: [owner, first, second] }))
    .resolves.toEqual([first.id, second.id, owner.id]);
  expect(await rows('projects')).toEqual([]); expect(await rows('projectSummaries')).toEqual([]);
  expect(await rows('agentTasks')).toEqual([task]);
  expect(await rows('metadata')).toContainEqual(expect.objectContaining({ id: 'project-deleted:series', retainedDataDirectory: true }));
});
