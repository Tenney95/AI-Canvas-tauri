/** 协作映射 CAS 与不可变基线的同事务保存。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExchangeRevision, ProjectExchangeState } from '../../src/types/projectExchange';
import { createProjectExchangeRevision, projectExchangeRevisionHeader } from '../../src/services/projectExchangeFormat';

beforeEach(() => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('crypto', webcrypto);
});
afterEach(async () => {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  (await openDB()).close(); vi.unstubAllGlobals();
});
async function fixture() {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put({ id: 'owner', name: '原项目', nodes: [], edges: [], createdAt: 1, updatedAt: 1 });
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
  });
  const revision = await createProjectExchangeRevision({ format: 'ai-canvas-project-snapshot', canonicalVersion: 1,
    lineageId: 'lineage', rootProjectId: 'root', complete: true, media: [], entities: [
      { kind: 'project', scopeId: 'root', id: 'root', data: { name: '项目' }, references: [] },
    ] });
  const state: ProjectExchangeState = { ownerId: 'owner', lineageId: 'lineage', rootProjectId: 'root',
    headRevisionId: revision.revisionId, stateVersion: 1,
    identities: [{ kind: 'project', scopeId: 'root', id: 'root', localId: 'owner' }] };
  return { revision, state };
}
async function child(revision: ProjectExchangeRevision) {
  const next = structuredClone(revision.snapshot); next.entities[0].data.name = '修改后的项目';
  return createProjectExchangeRevision(next, [revision.revisionId]);
}

describe('项目协作持久化', () => {
  it('v26 升级只补协作表，不给旧项目伪造来源或修改项目正文', async () => {
    const original = { id: 'old-project', name: '原有项目', nodes: [], edges: [], createdAt: 1, updatedAt: 2 };
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ai-canvas-db', 26);
      request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = oldDb.transaction('projects', 'readwrite'); tx.objectStore('projects').put(original);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    oldDb.close();
    const repo = await import('../../src/services/indexedDb/projectExchangeRepository');
    expect(await repo.loadProjectExchangeState('old-project')).toBeNull();
    const { openDB, DB_VERSION } = await import('../../src/services/indexedDb/schema');
    const db = await openDB(); expect(db.version).toBe(DB_VERSION);
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction('projects').objectStore('projects').get('old-project');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    expect(stored).toEqual(original);
  });

  it('状态与完整基线一起提交，薄父链不能覆盖基线正文', async () => {
    const repo = await import('../../src/services/indexedDb/projectExchangeRepository');
    const { revision, state } = await fixture();
    await repo.saveProjectExchangeCheckpoint({ expectedState: null, state, revisions: [revision] });
    expect(await repo.loadProjectExchangeState('owner')).toEqual(state);
    await repo.saveProjectExchangeCheckpoint({ expectedState: state, state: { ...state, stateVersion: 2 }, revisions: [],
      ancestors: [projectExchangeRevisionHeader(revision)] });
    expect((await repo.loadProjectExchangeGraph('lineage')).revisions).toEqual([revision]);
  });

  it('两个旧读取者只有一个能提交；失败方不能推进状态或留下候选版本', async () => {
    const repo = await import('../../src/services/indexedDb/projectExchangeRepository');
    const { revision, state } = await fixture();
    await repo.saveProjectExchangeCheckpoint({ expectedState: null, state, revisions: [revision] });
    await repo.saveProjectExchangeCheckpoint({ expectedState: state, state: { ...state, stateVersion: 2 }, revisions: [] });
    const next = await child(revision);
    await expect(repo.saveProjectExchangeCheckpoint({ expectedState: state,
      state: { ...state, stateVersion: 2, headRevisionId: next.revisionId }, revisions: [next] })).rejects.toThrow('项目协作版本已变化');
    expect((await repo.loadProjectExchangeState('owner'))!.headRevisionId).toBe(revision.revisionId);
    expect((await repo.loadProjectExchangeGraph('lineage')).revisions).toHaveLength(1);
  });

  it('没有完整 head、错误 owner 映射或篡改的摘要均不能落库', async () => {
    const repo = await import('../../src/services/indexedDb/projectExchangeRepository');
    const { revision, state } = await fixture();
    await expect(repo.saveProjectExchangeCheckpoint({ expectedState: null, state, revisions: [],
      ancestors: [projectExchangeRevisionHeader(revision)] })).rejects.toThrow();
    await expect(repo.saveProjectExchangeCheckpoint({ expectedState: null,
      state: { ...state, identities: [{ ...state.identities[0], localId: 'other-owner' }] }, revisions: [revision] })).rejects.toThrow();
    const altered = structuredClone(revision); altered.snapshot.entities[0].data.name = '未经核对';
    await expect(repo.saveProjectExchangeCheckpoint({ expectedState: null, state, revisions: [altered] })).rejects.toThrow();
    expect(await repo.loadProjectExchangeState('owner')).toBeNull();
    expect((await repo.loadProjectExchangeGraph('lineage')).revisions).toHaveLength(0);
  });

  it('合法直接后继可以推进，但不能将不相干版本冒充当前分支', async () => {
    const repo = await import('../../src/services/indexedDb/projectExchangeRepository');
    const { revision, state } = await fixture();
    await repo.saveProjectExchangeCheckpoint({ expectedState: null, state, revisions: [revision] });
    const unrelated = await createProjectExchangeRevision({ ...revision.snapshot,
      entities: [{ ...revision.snapshot.entities[0], data: { name: '无父关系的版本' } }] });
    await expect(repo.saveProjectExchangeCheckpoint({ expectedState: state,
      state: { ...state, stateVersion: 2, headRevisionId: unrelated.revisionId }, revisions: [unrelated] })).rejects.toThrow();
    const next = await child(revision);
    await repo.saveProjectExchangeCheckpoint({ expectedState: state,
      state: { ...state, stateVersion: 2, headRevisionId: next.revisionId }, revisions: [next] });
    expect((await repo.loadProjectExchangeState('owner'))!.headRevisionId).toBe(next.revisionId);
  });

  it.each(['project-model-source-freeze', 'activeDataModel', 'project-model-business-fixture'])(
    '%s 阻止旧导出准备推进协作状态或插入不可变候选', async (key) => {
      const repo = await import('../../src/services/indexedDb/projectExchangeRepository');
      const { revision, state } = await fixture();
      const db = await (await import('../../src/services/indexedDb/schema')).openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('metadata', 'readwrite'); tx.objectStore('metadata').put({ id: key, malformed: true });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
      await expect(repo.saveProjectExchangeCheckpoint({ expectedState: null, state, revisions: [revision] }))
        .rejects.toThrow('旧项目写入已停止');
      expect(await repo.loadProjectExchangeState('owner')).toBeNull();
      expect((await repo.loadProjectExchangeGraph('lineage')).revisions).toEqual([]);
    },
  );
});
