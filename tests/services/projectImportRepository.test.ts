/** 整部剧 CAS、恢复点、可选历史和旧 epoch 写入的回归材料。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSaveData } from '../../src/services/storageService';
beforeEach(() => { vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('crypto', webcrypto); });
afterEach(async () => { (await (await import('../../src/services/indexedDb/schema')).openDB()).close(); vi.unstubAllGlobals(); });
async function setup() {
  const { openDB } = await import('../../src/services/indexedDb/schema'), db = await openDB();
  const owner: ProjectSaveData = { id: 'owner', name: '剧集', nodes: [], edges: [], createdAt: 1, updatedAt: 1 };
  const episode: ProjectSaveData = { ...owner, id: 'episode', name: '第一集', parentId: 'owner' };
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(owner); tx.objectStore('projects').put(episode); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  const repo = await import('../../src/services/indexedDb/projectImportRepository');
  return { db, repo, owner, episode };
}
describe('整部剧导入事务', () => {
  it('同时更新 owner/分集、摘要、恢复点和历史，并提升所有写入 epoch', async () => {
    const { repo, owner, episode, db } = await setup();
    await repo.commitProjectImport({ operationId: 'op', expectedRecords: [owner, episode], records: [{ ...owner, name: '新剧集' }, { ...episode, episodeScript: '新剧本' }],
      expectedState: null, state: null, revisions: [], ancestors: [], history: [{ store: 'chatConversations', value: { id: 'import-chat', projectId: 'owner' } }], label: '导入更新前' });
    const scope = await repo.readProjectImportScope('owner'); expect(scope.every((item) => item.exchangeEpoch === 1)).toBe(true);
    expect(scope[0].name).toBe('新剧集'); expect(scope[1].episodeScript).toBe('新剧本');
    expect((await repo.listProjectImportRecoveries('owner'))[0].records).toEqual([owner, episode]);
    const summary = await new Promise<{ name: string; exchangeEpoch: number }>((resolve) => {
      const request = db.transaction('projectSummaries').objectStore('projectSummaries').get('owner'); request.onsuccess = () => resolve(request.result); });
    expect(summary).toMatchObject({ name: '新剧集', exchangeEpoch: 1 });
  });
  it('预览后新增/删除分集或旧读取者再次提交，整批回滚而不产生恢复点', async () => {
    const { repo, owner, episode, db } = await setup();
    await new Promise<void>((resolve) => { const tx = db.transaction('projects', 'readwrite'); tx.objectStore('projects').put({ ...episode, id: 'another' }); tx.oncomplete = () => resolve(); });
    await expect(repo.commitProjectImport({ operationId: 'op', expectedRecords: [owner, episode], records: [{ ...owner, name: '不应落库' }],
      expectedState: null, state: null, revisions: [], ancestors: [], history: [], label: '导入更新前' })).rejects.toThrow('预览后发生变化');
    expect((await repo.readProjectImportScope('owner'))[0].name).toBe('剧集'); expect(await repo.listProjectImportRecoveries('owner')).toEqual([]);
  });
  it('历史同来源只追加一次，失败事务不留下部分会话', async () => {
    const { repo, owner, episode } = await setup();
    await expect(repo.commitProjectImport({ operationId: 'bad-op', expectedRecords: [owner, episode], records: [owner, episode], expectedState: null, state: null,
      revisions: [], ancestors: [], history: [{ store: 'chatConversations', value: { id: 'foreign', projectId: 'outside' } }], label: '导入更新前' })).rejects.toThrow('历史归属');
    expect(await repo.listProjectImportRecoveries('owner')).toEqual([]); expect((await repo.readProjectImportScope('owner'))[0].exchangeEpoch).toBeUndefined();
  });

  it.each(['project-model-source-freeze', 'activeDataModel', 'project-model-business-fixture'])(
    '%s 阻止旧导入/恢复提交及发布journal，不改作品或历史', async (key) => {
      const { repo, owner, episode, db } = await setup();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('metadata', 'readwrite'); tx.objectStore('metadata').put({ id: key, malformed: true });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
      await expect(repo.commitProjectImport({ operationId: 'frozen', expectedRecords: [owner, episode], records: [{ ...owner, name: '不得覆盖' }],
        expectedState: null, state: null, revisions: [], ancestors: [], history: [], label: '恢复前' })).rejects.toThrow('旧项目写入已停止');
      await expect(repo.beginProjectImportOperation('frozen-publish', owner.id, 'temporary', 'temporary-folder')).rejects.toThrow('旧项目写入已停止');
      expect(await repo.readProjectImportScope('owner')).toEqual([owner, episode]);
      expect(await repo.listProjectImportRecoveries('owner')).toEqual([]);
    },
  );
});
