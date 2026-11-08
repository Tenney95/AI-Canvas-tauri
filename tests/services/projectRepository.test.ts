/** P1 新领域只读仓储入口；保留现有写入权威。 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { createLegacyProjectRepository } from '../../src/services/indexedDb/projectRepository';
import type { LegacyProjectRecord } from '../../src/types/projectMigration';

async function databaseFor(records: LegacyProjectRecord[], summaries = true) {
  const factory = new IDBFactory();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('read-projects', 27);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' });
      if (summaries) request.result.createObjectStore('projectSummaries', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const names = summaries ? ['projects', 'projectSummaries'] : ['projects'];
    const transaction = database.transaction(names, 'readwrite');
    for (const record of records) {
      transaction.objectStore('projects').put(record);
      if (summaries) {
        const { nodes: _nodes, edges: _edges, ...summary } = record;
        transaction.objectStore('projectSummaries').put(summary);
      }
    }
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
  });
  return database;
}
const project = (id: string, fields: Partial<LegacyProjectRecord> = {}): LegacyProjectRecord => ({
  id, name: id, createdAt: 1, updatedAt: 2, nodes: [], edges: [], ...fields,
});

describe('项目领域旧仓储适配', () => {
  it('项目/分集目录只返回元数据，保留集号排序而不暴露剧本和预览正文', async () => {
    const database = await databaseFor([project('series', { series: { script: '全剧正文' } }),
      project('ep-b', { parentId: 'series', episodeNo: 2, episodeScript: '第二集正文', snapshot: 'preview' }),
      project('ep-a', { parentId: 'series', episodeNo: 1, episodeScript: '第一集正文' }), project('single')]);
    try {
      const repository = createLegacyProjectRepository(database);
      expect(repository.access).toBe('legacy-readonly');
      expect((await repository.listProjects()).map((row) => [row.id, row.kind])).toEqual([['series', 'series'], ['single', 'standalone']]);
      const episodes = await repository.listEpisodes('series');
      expect(episodes.map((row) => row.id)).toEqual(['ep-a', 'ep-b']);
      expect(episodes[1].hasPreview).toBe(true);
      for (const row of [...await repository.listProjects(), ...episodes]) {
        expect(row).not.toHaveProperty('series'); expect(row).not.toHaveProperty('episodeScript');
        expect(row).not.toHaveProperty('snapshot'); expect(row).not.toHaveProperty('nodes');
      }
    } finally { database.close(); }
  });

  it('一事务读取完整 owner/直接分集，子集入口指向同一只读聚合', async () => {
    const original = [project('series', { dataFolder: '剧集-old', series: { script: '全剧正文' } }),
      project('ep-a', { parentId: 'series', episodeNo: 1, episodeScript: '本集正文' }), project('unrelated')];
    const database = await databaseFor(original);
    try {
      const repository = createLegacyProjectRepository(database);
      expect((await repository.readRawRecords('ep-a')).map((row) => row.id)).toEqual(['ep-a', 'series']);
      const aggregate = await repository.readProjectAggregate('ep-a');
      expect(aggregate?.access).toBe('legacy-readonly');
      expect(aggregate?.project.id).toBe('series');
      expect(aggregate?.episodes[0].content.script).toBe('本集正文');
      expect((await repository.readRawRecords()).find((row) => row.id === 'ep-a')).toEqual(original[1]);
      expect(database.version).toBe(27);
      expect(Array.from(database.objectStoreNames)).toEqual(['projectSummaries', 'projects']);
    } finally { database.close(); }
  });

  it('老库没有摘要表时仅按完整记录读取，不创建摘要或写入新模型标记', async () => {
    const database = await databaseFor([project('ordinary', { episodeScript: '旧孤立分集稿件' })], false);
    try {
      const repository = createLegacyProjectRepository(database);
      expect(await repository.listProjects()).toHaveLength(1);
      const aggregate = await repository.readProjectAggregate('ordinary');
      expect(aggregate?.project.kind).toBe('standalone');
      expect(aggregate?.content.standaloneCreative?.script).toBe('旧孤立分集稿件');
      expect(Array.from(database.objectStoreNames)).toEqual(['projects']);
    } finally { database.close(); }
  });

  it.each(['empty', 'partial'])('摘要缓存为 %s 也不能隐藏源项目/分集或回读陈旧标题', async (cache) => {
    const database = await databaseFor([project('series', { name: '真实项目' }),
      project('episode', { parentId: 'series', episodeNo: 1 }), project('standalone')]);
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('projectSummaries', 'readwrite');
        const summaries = transaction.objectStore('projectSummaries');
        summaries.clear();
        if (cache === 'partial') summaries.put({ id: 'series', name: '陈旧标题', createdAt: 1, updatedAt: 1 });
        transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
      });
      const repository = createLegacyProjectRepository(database);
      expect((await repository.listProjects()).map((entry) => [entry.id, entry.name, entry.kind]))
        .toEqual([['series', '真实项目', 'series'], ['standalone', 'standalone', 'standalone']]);
      expect((await repository.listEpisodes('series')).map((entry) => entry.id)).toEqual(['episode']);
    } finally { database.close(); }
  });

  it('series 仅有 undefined 字段时，目录与完整投影均保持普通项目', async () => {
    const database = await databaseFor([project('ordinary', { series: { script: undefined } })]);
    try {
      const repository = createLegacyProjectRepository(database);
      expect((await repository.listProjects())[0].kind).toBe('standalone');
      expect((await repository.readProjectAggregate('ordinary'))?.project.kind).toBe('standalone');
    } finally { database.close(); }
  });

  it('无子集时共享原稿不将普通画布误判为剧集容器', async () => {
    const original = project('ordinary-with-source', { series: { script: '全剧共享稿' }, episodeScript: '顶层创作稿',
      nodes: [{ id: 'node', data: { text: '原画布' } }] });
    const database = await databaseFor([original]);
    try {
      const repository = createLegacyProjectRepository(database);
      expect((await repository.listProjects())[0]).toMatchObject({ id: original.id, kind: 'standalone' });
      expect(await repository.listEpisodes(original.id)).toEqual([]);
      expect(await repository.readProjectAggregate(original.id)).toMatchObject({ project: { id: original.id, kind: 'standalone' },
        content: { script: '全剧共享稿', standaloneCreative: { script: '顶层创作稿' } }, standaloneCanvas: { nodes: original.nodes } });
      expect(await repository.readRawRecords(original.id)).toEqual([original]);
    } finally { database.close(); }
  });

  it('缺失记录不补空图，断父链可读诊断但不成为可写聚合', async () => {
    const database = await databaseFor([project('orphan', { parentId: 'missing-owner' })]);
    try {
      const repository = createLegacyProjectRepository(database);
      expect(await repository.readProjectAggregate('not-found')).toBeNull();
      expect(await repository.readProjectAggregate('orphan')).toBeNull();
      const projection = await repository.readProjection('orphan');
      expect(projection.quarantinedRecordIds).toContain('orphan');
      expect(projection.diagnostics.some((item) => item.severity === 'blocking')).toBe(true);
    } finally { database.close(); }
  });

  it('任一入口都读取完整多级关系组件，不能把截断后的子链当作合法整剧', async () => {
    const database = await databaseFor([project('grandparent'), project('parent', { parentId: 'grandparent' }),
      project('child', { parentId: 'parent' }), project('sibling', { parentId: 'grandparent' }), project('unrelated')]);
    try {
      const repository = createLegacyProjectRepository(database);
      for (const identity of ['grandparent', 'parent', 'child']) {
        const projection = await repository.readProjection(identity);
        expect(new Set(projection.sourceRecords.map((record) => record.id)))
          .toEqual(new Set(['grandparent', 'parent', 'child', 'sibling']));
        expect(new Set(projection.quarantinedRecordIds)).toEqual(new Set(['grandparent', 'parent', 'child', 'sibling']));
        expect(projection.projects).toEqual([]);
        expect(projection.diagnostics.some((item) => item.code === 'nested_parent')).toBe(true);
        expect(await repository.readProjectAggregate(identity)).toBeNull();
      }
      expect((await repository.readRawRecords()).map((record) => record.id)).toContain('unrelated');
    } finally { database.close(); }
  });

  it('环与其后代都保留在同一个只读事务组件中', async () => {
    const database = await databaseFor([project('a', { parentId: 'b' }), project('b', { parentId: 'a' }),
      project('child', { parentId: 'a' }), project('unrelated')]);
    const transactionSpy = vi.spyOn(database, 'transaction');
    try {
      const repository = createLegacyProjectRepository(database);
      const projection = await repository.readProjection('b');
      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(transactionSpy).toHaveBeenCalledWith('projects', 'readonly');
      expect(new Set(projection.sourceRecords.map((record) => record.id))).toEqual(new Set(['a', 'b', 'child']));
      expect(new Set(projection.quarantinedRecordIds)).toEqual(new Set(['a', 'b', 'child']));
      expect(projection.projects).toEqual([]);
    } finally { transactionSpy.mockRestore(); database.close(); }
  });

  it('缺失 owner 的兄弟和多级后代一起诊断，不制造缺失父记录', async () => {
    const database = await databaseFor([project('orphan-a', { parentId: 'missing-owner' }),
      project('orphan-b', { parentId: 'missing-owner' }), project('descendant', { parentId: 'orphan-a' }), project('unrelated')]);
    try {
      const repository = createLegacyProjectRepository(database);
      for (const identity of ['orphan-b', 'missing-owner']) {
        const projection = await repository.readProjection(identity);
        expect(new Set(projection.sourceRecords.map((record) => record.id)))
          .toEqual(new Set(['orphan-a', 'orphan-b', 'descendant']));
        expect(new Set(projection.quarantinedRecordIds)).toEqual(new Set(['orphan-a', 'orphan-b', 'descendant']));
        expect(projection.sourceRecords.some((record) => record.id === 'missing-owner')).toBe(false);
        expect(projection.projects).toEqual([]);
      }
    } finally { database.close(); }
  });
});
