/**
 * imageGenerationHistory — 回归测试：节点历史读取，以及内存、分页与导出的筛选一致性。
 */
import {
  IDBCursor as FakeIDBCursor,
  IDBFactory,
  IDBIndex as FakeIDBIndex,
  IDBObjectStore as FakeIDBObjectStore,
} from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryPageCursor, HistoryRecord } from '../../src/services/indexedDbService';
import type { HistoryQuery } from '../../src/types';
import { matchesHistoryQuery } from '../../src/utils/historyQuery';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.resetModules();
});

function historyRecord(
  id: string,
  nodeId: string,
  timestamp: number,
  projectId = 'project-a',
): HistoryRecord {
  return {
    id,
    projectId,
    nodeId,
    nodeLabel: nodeId,
    timestamp,
    prompt: `prompt-${id}`,
    output: `https://example.com/${id}.png`,
    nodeType: 'ai-image',
    model: 'image-model',
    provider: 'provider',
    status: 'success',
    mediaUrl: `https://example.com/${id}.png`,
  };
}

describe('getNodeHistoryEntries', () => {
  it('persists image quality and transparent background independently of resolution', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntry({ ...historyRecord('quality', 'node-a', 100),
      params: { imageSize: '2K', aspectRatio: '16:9', imageQuality: 'max', imageBackground: 'transparent' } });
    const [record] = await service.getNodeHistoryEntries('project-a', 'node-a');
    expect(record.params).toEqual({ imageSize: '2K', aspectRatio: '16:9', imageQuality: 'max', imageBackground: 'transparent' });
  });
  it('returns only the requested node history in reverse chronological order', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntries([
      historyRecord('node-a-old', 'node-a', 100),
      historyRecord('node-b', 'node-b', 300),
      historyRecord('node-a-new', 'node-a', 200),
    ]);

    const records = await service.getNodeHistoryEntries('project-a', 'node-a');

    expect(records.map((record) => record.id)).toEqual(['node-a-new', 'node-a-old']);
  });

  it('isolates records by project and caps each project at 16 entries', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntries([
      ...Array.from({ length: 17 }, (_, index) => (
        historyRecord(`a-${index}`, 'node-a', index, 'project-a')
      )),
      historyRecord('b-1', 'node-a', 100, 'project-b'),
    ]);

    const projectAPage = await service.getHistoryEntriesPage('project-a', 16);
    const projectBPage = await service.getHistoryEntriesPage('project-b', 16);

    expect(projectAPage.records).toHaveLength(16);
    expect(projectAPage.records.map((record) => record.id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `a-${16 - index}`),
    );
    expect(projectAPage.hasMore).toBe(false);
    expect(projectBPage.records.map((record) => record.id)).toEqual(['b-1']);
    await expect(service.getHistoryEntryCount('project-a')).resolves.toBe(16);
    await expect(service.getHistoryEntryCount('project-b')).resolves.toBe(1);
  });

  it('clears and deletes history only inside the target project', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.saveProjectToDb({
      id: 'project-a', name: 'A', createdAt: 1, updatedAt: 1, nodes: [], edges: [],
    });
    await service.saveProjectToDb({
      id: 'project-b', name: 'B', createdAt: 1, updatedAt: 1, nodes: [], edges: [],
    });
    await service.putHistoryEntries([
      historyRecord('a-1', 'node-a', 1, 'project-a'),
      historyRecord('b-1', 'node-b', 1, 'project-b'),
    ]);

    await service.clearAllHistoryEntries('project-a');
    await expect(service.getHistoryEntryCount('project-a')).resolves.toBe(0);
    await expect(service.getHistoryEntryCount('project-b')).resolves.toBe(1);

    await service.putHistoryEntry(historyRecord('a-2', 'node-a', 2, 'project-a'));
    await service.deleteProjectFromDb('project-a');

    await expect(service.getHistoryEntryCount('project-a')).resolves.toBe(0);
    await expect(service.getHistoryEntryCount('project-b')).resolves.toBe(1);
  });
});

describe('history key cursor pruning and cleanup', () => {
  it.each([0, 1, 15, 16, 17, 35])('retains the newest records at the 16-entry boundary with %s inputs', async (count) => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntries(Array.from({ length: count }, (_, index) => (
      historyRecord(`a-${index}`, 'node-a', index)
    )));
    const records = await service.getHistoryEntriesForExport('project-a');
    expect(records.map((record) => record.id)).toEqual(
      Array.from({ length: Math.min(count, 16) }, (_, index) => `a-${count - index - 1}`),
    );
  });

  it('uses the compound index id order to break timestamp ties', async () => {
    const service = await import('../../src/services/indexedDbService');
    const ids = Array.from({ length: 20 }, (_, index) => `tie-${String(index).padStart(2, '0')}`);
    await service.putHistoryEntries(ids.map((id) => historyRecord(id, 'node-a', 100)));
    expect((await service.getHistoryEntriesForExport('project-a')).map((record) => record.id))
      .toEqual(ids.slice(4).reverse());
  });

  it.each([16, 17])('requests only keys and advances once over the retained region for %s entries', async (count) => {
    const service = await import('../../src/services/indexedDbService');
    const valueCursor = vi.spyOn(FakeIDBIndex.prototype, 'openCursor');
    const keyCursor = vi.spyOn(FakeIDBIndex.prototype, 'openKeyCursor');
    const advance = vi.spyOn(FakeIDBCursor.prototype, 'advance');
    const next = vi.spyOn(FakeIDBCursor.prototype, 'continue');
    await service.putHistoryEntries(Array.from({ length: count }, (_, index) => (
      historyRecord(`a-${index}`, 'node-a', index)
    )));

    expect(valueCursor).not.toHaveBeenCalled();
    expect(keyCursor).toHaveBeenCalledTimes(1);
    expect(keyCursor.mock.calls[0][1]).toBe('prev');
    expect(advance).toHaveBeenCalledExactlyOnceWith(16);
    expect(next).toHaveBeenCalledTimes(count - 16);
    expect(await service.getHistoryEntryCount('project-a')).toBe(16);
  });

  it('also prunes after saving a single entry without removing another project history', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntries([
      ...Array.from({ length: 16 }, (_, index) => historyRecord(`a-${index}`, 'node-a', index)),
      historyRecord('foreign', 'node-a', 1, 'project-b'),
    ]);
    await service.putHistoryEntry(historyRecord('new', 'node-a', 100));
    const records = await service.getHistoryEntriesForExport('project-a');
    expect(records).toHaveLength(16);
    expect(records[0].id).toBe('new');
    expect(records.some((record) => record.id === 'a-0')).toBe(false);
    expect((await service.getHistoryEntriesForExport('project-b')).map((record) => record.id)).toEqual(['foreign']);
  });

  it.each(['project', 'node'] as const)('treats unmatched %s cleanup as a no-op', async (scope) => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntries([
      historyRecord('existing', 'node-a', 1), historyRecord('foreign', 'node-a', 1, 'project-b'),
    ]);
    const cleanup = () => scope === 'project' ? service.clearAllHistoryEntries('missing-project')
      : service.deleteNodeHistoryEntries('project-a', 'missing-node');
    await expect(cleanup()).resolves.toBeUndefined();
    await expect(cleanup()).resolves.toBeUndefined();
    expect((await service.getHistoryEntriesForExport('project-a')).map((record) => record.id)).toEqual(['existing']);
    expect((await service.getHistoryEntriesForExport('project-b')).map((record) => record.id)).toEqual(['foreign']);
  });

  it.each(['project', 'node'] as const)('cleans %s history using keys and preserves other scopes', async (scope) => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntries([
      historyRecord('target', 'node-a', 1),
      historyRecord('other-node', 'node-b', 2),
      historyRecord('foreign', 'node-a', 1, 'project-b'),
    ]);
    const valueCursor = vi.spyOn(FakeIDBIndex.prototype, 'openCursor');
    const keyCursor = vi.spyOn(FakeIDBIndex.prototype, 'openKeyCursor');
    if (scope === 'project') await service.clearAllHistoryEntries('project-a');
    else await service.deleteNodeHistoryEntries('project-a', 'node-a');

    expect(valueCursor).not.toHaveBeenCalled();
    expect(keyCursor).toHaveBeenCalledTimes(1);
    valueCursor.mockRestore();
    expect((await service.getHistoryEntriesForExport('project-a')).map((record) => record.id))
      .toEqual(scope === 'project' ? [] : ['other-node']);
    expect((await service.getHistoryEntriesForExport('project-b')).map((record) => record.id)).toEqual(['foreign']);
  });

  it.each(['project', 'node'] as const)('rejects aborted %s cleanup and rolls back deletions', async (scope) => {
    const service = await import('../../src/services/indexedDbService');
    await service.putHistoryEntries([
      historyRecord('older', 'node-a', 1), historyRecord('newer', 'node-a', 2),
      historyRecord('foreign', 'node-a', 1, 'project-b'),
    ]);
    const remove = FakeIDBObjectStore.prototype.delete;
    let abortScheduled = false;
    let abortInjected = false;
    const deletion = vi.spyOn(FakeIDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = remove.call(this, key);
      if (this.name === 'history' && !abortScheduled) {
        abortScheduled = true;
        const transaction = this.transaction;
        request.addEventListener('success', () => queueMicrotask(() => {
          transaction.abort();
          abortInjected = true;
        }), { once: true });
      }
      return request;
    });
    const operation = scope === 'project' ? service.clearAllHistoryEntries('project-a')
      : service.deleteNodeHistoryEntries('project-a', 'node-a');
    if (scope === 'node') await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    else await expect(operation).rejects.toThrow('历史记录清理失败');
    expect(abortInjected).toBe(true);
    deletion.mockRestore();
    expect((await service.getHistoryEntriesForExport('project-a')).map((record) => record.id)).toEqual(['newer', 'older']);
    expect((await service.getHistoryEntriesForExport('project-b')).map((record) => record.id)).toEqual(['foreign']);
  });
});

describe('输出历史筛选一致性', () => {
  it('内存、游标分页与导出使用相同条件，并保留项目隔离和倒序', async () => {
    const service = await import('../../src/services/indexedDbService');
    const records: HistoryRecord[] = [
      { ...historyRecord('legacy', 'node-a', 6), nodeType: 'legacy-widget' },
      { ...historyRecord('prompt', 'node-a', 5), prompt: 'Neon City' },
      { ...historyRecord('output', 'node-a', 4), nodeType: 'ai-text', output: 'CITY at dusk' },
      { ...historyRecord('model', 'node-a', 4), nodeType: 'ai-audio', model: 'City-v2' },
      { ...historyRecord('label', 'node-a', 2), nodeType: 'ai-video', nodeLabel: 'city scene' },
      { ...historyRecord('miss', 'node-a', 1), provider: 'CITY-ONLY-PROVIDER', error: 'city error' },
      { ...historyRecord('foreign', 'node-a', 10, 'project-b'), prompt: 'City' },
    ];
    await service.putHistoryEntries(records);

    const all = ['legacy', 'prompt', 'output', 'model', 'label', 'miss'];
    const cases: Array<{ query: HistoryQuery; ids: string[] }> = [
      { query: {}, ids: all },
      { query: { nodeType: '', search: ' \t\n' }, ids: all },
      { query: { search: '  cItY  ' }, ids: ['prompt', 'output', 'model', 'label'] },
      { query: { nodeType: 'ai-image', search: 'CITY' }, ids: ['prompt'] },
      { query: { nodeType: 'ai-video', search: 'city' }, ids: ['label'] },
      { query: { nodeType: 'AI-IMAGE' }, ids: [] },
      { query: { nodeType: 'legacy-widget' }, ids: ['legacy'] },
      { query: { search: 'provider' }, ids: [] },
      { query: { search: 'no-match' }, ids: [] },
    ];
    for (const { query, ids } of cases) {
      const inMemory = records.filter((record) => record.projectId === 'project-a'
        && matchesHistoryQuery(record, query));
      expect(inMemory.map((record) => record.id)).toEqual(ids);

      const paged: HistoryRecord[] = [];
      let cursor: HistoryPageCursor | null = null;
      let hasMore = true;
      // 有界遍历也能检测游标不前进，避免回归失败时用例挂起。
      for (let pageIndex = 0; hasMore && pageIndex < records.length; pageIndex += 1) {
        const page = await service.getHistoryEntriesPage('project-a', 2, cursor, query);
        paged.push(...page.records);
        cursor = page.nextCursor;
        hasMore = page.hasMore;
      }
      expect(hasMore).toBe(false);
      expect(paged.map((record) => record.id)).toEqual(ids);
      const exported = await service.getHistoryEntriesForExport('project-a', query);
      expect(exported.map((record) => record.id)).toEqual(ids);
    }
  });
});
