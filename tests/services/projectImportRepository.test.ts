/** 整部剧 CAS、恢复点、可选历史和旧 epoch 写入的回归材料。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ProjectImportCommit } from '../../src/services/indexedDb/projectImportRepository';
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
  it('冻结首次next和历史，剔除运行回调；DB前重启只允许相同commit原样继续', async () => {
    const { repo, owner, episode } = await setup();
    const commit: ProjectImportCommit = { operationId: 'frozen-import', expectedRecords: [owner, episode],
      records: [{ ...owner, name: '首次分配作品' }, episode], expectedState: null, state: null, revisions: [], ancestors: [], history: [],
      label: '更新前', assertCurrent: () => undefined, signal: new AbortController().signal };
    const media = { mode: 'already-ready' as const, targetFolder: owner.id, assets: [], required: [], verified: true };
    await repo.beginProjectImportOperation(commit.operationId, owner.id, 'preview', 'preview-folder');
    await repo.savePreparedProjectImportOperation(commit.operationId, { commit, media });
    const frozen = (await repo.readProjectImportOperation(commit.operationId))!.prepared!;
    expect(frozen.commit).not.toHaveProperty('assertCurrent'); expect(frozen.commit).not.toHaveProperty('signal');
    await repo.savePreparedProjectImportOperation(commit.operationId, { commit, media });
    await expect(repo.savePreparedProjectImportOperation(commit.operationId, { commit: { ...commit, records: [{ ...owner, name: '重新合并' }, episode] }, media }))
      .rejects.toThrow('冻结其他材料');
    await repo.advanceProjectImportOperation(commit.operationId, 'media_publishing');
    await repo.advanceProjectImportOperation(commit.operationId, 'media_ready');
    await expect(repo.commitProjectImport({ ...commit, history: [{ store: 'chatConversations', value: { id: 'other', projectId: owner.id } }] }))
      .rejects.toThrow('冻结内容');
    await repo.commitProjectImport({ ...frozen.commit, expectedRecords: [owner, episode] });
    await repo.commitProjectImport({ ...frozen.commit, expectedRecords: [owner, episode] });
    expect((await repo.readProjectImportScope(owner.id))[0]).toMatchObject({ name: '首次分配作品', exchangeEpoch: 1 });
  });

  it('旧expected的合法绝对引用只形成键序稳定CAS摘要，journal不复制路径，原事务仍可提交', async () => {
    const { repo, owner, episode, db } = await setup();
    const legacy = { ...owner, nodes: [{ id: 'old-image', data: { filePath: 'C:/private/old-image.png', relativePath: 'old-image.png' } }] } as unknown as ProjectSaveData;
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('projects', 'readwrite'); tx.objectStore('projects').put(legacy);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    const commit: ProjectImportCommit = { operationId: 'legacy-cas', expectedRecords: [legacy, episode], records: [owner, episode],
      expectedState: null, state: null, revisions: [], ancestors: [], history: [], label: '更新前' };
    await repo.beginProjectImportOperation(commit.operationId, owner.id, 'preview', 'preview-folder');
    await repo.savePreparedProjectImportOperation(commit.operationId, { commit, media: { mode: 'already-ready', targetFolder: owner.id,
      assets: [], required: [], verified: true } });
    const frozen = (await repo.readProjectImportOperation(commit.operationId))!.prepared!;
    expect(frozen.commit).not.toHaveProperty('expectedRecords');
    expect(JSON.stringify(frozen)).not.toContain('C:/private');
    expect(frozen.sourceRecordDigests.map((row) => row.id)).toEqual(['episode', 'owner']);
    const reordered = Object.fromEntries(Object.entries(legacy).reverse()) as unknown as ProjectSaveData;
    expect(await repo.digestProjectImportSourceRecords([reordered, episode])).toEqual(frozen.sourceRecordDigests);
    await repo.advanceProjectImportOperation(commit.operationId, 'media_publishing');
    await repo.advanceProjectImportOperation(commit.operationId, 'media_ready');
    await repo.commitProjectImport(commit);
    expect((await repo.readProjectImportScope(owner.id))[0].nodes).toEqual([]);
  });

  it('冻结材料中的本机绝对路径或运行时对象失败关闭，不保存半份prepared', async () => {
    const { repo, owner, episode } = await setup();
    const commit: ProjectImportCommit = { operationId: 'unsafe-material', expectedRecords: [owner, episode], records: [owner, episode],
      expectedState: null, state: null, revisions: [], ancestors: [], history: [], label: '更新前' };
    const media = { mode: 'already-ready' as const, targetFolder: owner.id, assets: [], required: [], verified: true };
    await repo.beginProjectImportOperation(commit.operationId, owner.id, 'preview', 'preview-folder');
    await expect(repo.savePreparedProjectImportOperation(commit.operationId, { commit: { ...commit,
      records: [{ ...owner, dataFolder: 'C:/private/project' }, episode] }, media })).rejects.toThrow('本机绝对路径');
    const controllerRecord = { ...owner, nodes: [{ id: 'runtime', data: { controller: new AbortController() } }] } as unknown as ProjectSaveData;
    await expect(repo.savePreparedProjectImportOperation(commit.operationId, { commit: { ...commit, records: [controllerRecord, episode] }, media }))
      .rejects.toThrow('运行时对象');
    expect((await repo.readProjectImportOperation(commit.operationId))!.prepared).toBeUndefined();
  });

  it('原导出尚未登记时拒绝并发导入，保留该外发分支供原操作核对', async () => {
    const { repo, owner, episode, db } = await setup();
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').put({ id: 'project-export-operation:original-export', operationId: 'original-export', ownerId: owner.id, phase: 'packing' });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    await expect(repo.commitProjectImport({ operationId: 'blocked-import', expectedRecords: [owner, episode], records: [owner, episode],
      expectedState: null, state: null, revisions: [], ancestors: [], history: [], label: '更新前' })).rejects.toThrow('未完成导出');
    expect(await repo.readProjectImportScope(owner.id)).toEqual([owner, episode]);
    expect(await repo.listProjectImportRecoveries(owner.id)).toEqual([]);
  });
  it('提交后重启按原操作读取；同内容重试不再合并、提升epoch或新增恢复点', async () => {
    const { repo, owner, episode } = await setup();
    await repo.beginProjectImportOperation('durable-import', owner.id, 'temporary', 'temporary-folder');
    await repo.advanceProjectImportOperation('durable-import', 'media_publishing');
    await repo.advanceProjectImportOperation('durable-import', 'media_ready');
    const input = { operationId: 'durable-import', expectedRecords: [owner, episode], records: [{ ...owner, name: '已提交作品' }, episode],
      expectedState: null, state: null, revisions: [], ancestors: [], history: [], label: '更新前' };
    await repo.commitProjectImport(input);
    await repo.commitProjectImport(input);
    expect((await repo.readProjectImportScope(owner.id))[0]).toMatchObject({ name: '已提交作品', exchangeEpoch: 1 });
    expect(await repo.listProjectImportRecoveries(owner.id)).toHaveLength(1);
    expect(await repo.recoverCommittedProjectImport('durable-import')).toMatchObject({ status: 'committed', records: [{ id: owner.id, exchangeEpoch: 1 }, { id: episode.id }] });
    await expect(repo.commitProjectImport({ ...input, records: [{ ...owner, name: '重复误合并' }, episode] })).rejects.toThrow('已提交其他内容');
    await repo.advanceProjectImportOperation('durable-import', 'projected');
    await repo.advanceProjectImportOperation('durable-import', 'finalized');
    expect((await repo.readProjectImportOperation('durable-import'))?.phase).toBe('finalized');
  });
  it('媒体未就绪不能提交；恢复无法读取原操作时不能推断未提交或删除媒体', async () => {
    const { repo, owner, episode } = await setup();
    await repo.beginProjectImportOperation('pending-import', owner.id, 'temporary', 'temporary-folder');
    await expect(repo.commitProjectImport({ operationId: 'pending-import', expectedRecords: [owner, episode], records: [owner, episode],
      expectedState: null, state: null, revisions: [], ancestors: [], history: [], label: '更新前' })).rejects.toThrow('媒体尚未就绪');
    expect(await repo.recoverCommittedProjectImport('pending-import')).toEqual({ status: 'not-committed' });
    await expect(repo.recoverCommittedProjectImport('missing-import')).rejects.toThrow('记录不存在');
    expect(await repo.listProjectImportRecoveries(owner.id)).toEqual([]);
  });
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
