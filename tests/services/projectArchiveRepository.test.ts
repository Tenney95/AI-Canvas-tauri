/** 旧库一致捕获和发布阶段恢复；只构造可丢弃 IndexedDB。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ProjectExchangeCheckpointInput } from '../../src/services/indexedDb/projectExchangeRepository';
import { createProjectExchangeRevision } from '../../src/services/projectExchangeFormat';

beforeEach(() => { vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('crypto', webcrypto); });
afterEach(async () => { (await (await import('../../src/services/indexedDb/schema')).openDB()).close(); vi.unstubAllGlobals(); });
async function write(db: IDBDatabase, rows: Array<[string, object]>) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...new Set(rows.map(([store]) => store))], 'readwrite');
    for (const [store, row] of rows) tx.objectStore(store).put(row);
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
async function fixture() {
  const db = await (await import('../../src/services/indexedDb/schema')).openDB();
  const owner: ProjectSaveData = { id: 'owner', name: '整部剧', nodes: [], edges: [], createdAt: 1, updatedAt: 1 };
  const episode: ProjectSaveData = { ...owner, id: 'episode', name: '分集', parentId: owner.id, episodeNo: 2 };
  await write(db, [['projects', owner], ['projects', episode],
    ['chatConversations', { id: 'chat', projectId: 'episode', title: '讨论', updatedAt: 1 }],
    ['chatConversations', { id: 'deleted', projectId: 'episode', deletedAt: 2, updatedAt: 1 }],
    ['chatConversations', { id: 'foreign', projectId: 'other', updatedAt: 1 }],
    ['chatMessages', { id: 'message', projectId: 'episode', conversationId: 'chat', sequence: 1, content: '已保存文本', agentTaskId: 'private-task' }],
    ['chatMessages', { id: 'deleted-message', projectId: 'episode', conversationId: 'deleted', sequence: 1 }],
    ['projectMemories', { id: 'memory', projectId: owner.id, content: '决定', updatedAt: 1 }]]);
  return { db, owner, episode };
}
async function checkpoint(): Promise<ProjectExchangeCheckpointInput> {
  const revision = await createProjectExchangeRevision({ format: 'ai-canvas-project-snapshot', canonicalVersion: 1,
    lineageId: 'lineage', rootProjectId: 'logical-root', complete: true, media: [], entities: [
      { kind: 'project', scopeId: 'logical-root', id: 'logical-root', data: { name: '整部剧' }, references: [] },
    ] });
  return { expectedState: null, revisions: [revision], state: { ownerId: 'owner', lineageId: 'lineage', rootProjectId: 'logical-root',
    headRevisionId: revision.revisionId, stateVersion: 1,
    identities: [{ kind: 'project', scopeId: 'logical-root', id: 'logical-root', localId: 'owner' }] } };
}

describe('旧模型归档一致捕获', () => {
  it('从分集入口捕获整部剧和关联历史，所有读取在一个只读事务，来源ID稳定', async () => {
    const { db } = await fixture();
    const repo = await import('../../src/services/indexedDb/projectArchiveRepository');
    const spy = vi.spyOn(db, 'transaction');
    const capture = await repo.captureLegacyProjectArchive('episode');
    expect(spy).toHaveBeenCalledTimes(1); expect(spy.mock.calls[0][1]).toBe('readonly'); spy.mockRestore();
    expect(capture.records.map((row) => row.id)).toEqual(['owner', 'episode']);
    expect(capture.chat[1].conversations.map((row) => row.id)).toEqual(['chat']);
    expect(capture.chat[1].messages.map((row) => row.id)).toEqual(['message']);
    expect(capture.chat[1].messages[0].archiveOriginId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(capture)).not.toContain('private-task');
    expect(await repo.captureLegacyProjectArchive('owner')).toEqual(capture);
    await expect(repo.assertLegacyProjectArchiveCurrent(capture)).resolves.toBeUndefined();
  });
  it('子集正文或历史变化即拒绝，不能用根 updatedAt 未变证明导出仍一致', async () => {
    const { db, episode } = await fixture();
    const repo = await import('../../src/services/indexedDb/projectArchiveRepository');
    const capture = await repo.captureLegacyProjectArchive('owner');
    await write(db, [['projects', { ...episode, episodeScript: '较新正文' }]]);
    await expect(repo.assertLegacyProjectArchiveCurrent(capture)).rejects.toThrow('变化');
    const latest = await repo.captureLegacyProjectArchive('owner');
    await write(db, [['chatMessages', { id: 'message', projectId: 'episode', conversationId: 'chat', sequence: 1, content: '较新讨论' }]]);
    await expect(repo.assertLegacyProjectArchiveCurrent(latest)).rejects.toThrow('变化');
  });
  it('消息串到其他项目时失败关闭，不输出不完整历史', async () => {
    const { db } = await fixture();
    await write(db, [['chatMessages', { id: 'wrong', projectId: 'other', conversationId: 'chat', sequence: 2 }]]);
    await expect((await import('../../src/services/indexedDb/projectArchiveRepository')).captureLegacyProjectArchive('owner')).rejects.toThrow('归属异常');
  });
});

describe('旧模型归档发布 journal', () => {
  it('准备/packing不推进head，首次并发导出串行且packing不能被当成未发布撤销', async () => {
    await fixture();
    const repo = await import('../../src/services/indexedDb/projectArchiveOperationRepository');
    const exchange = await import('../../src/services/indexedDb/projectExchangeRepository');
    const material = await checkpoint();
    const prepared = await repo.prepareLegacyArchiveExport('first', material);
    expect(await repo.prepareLegacyArchiveExport('first', material)).toEqual(prepared);
    await expect(repo.prepareLegacyArchiveExport('second', material)).rejects.toThrow('未完成导出');
    expect(await exchange.loadProjectExchangeState('owner')).toBeNull();
    const packing = await repo.advanceLegacyArchiveExport('first', prepared.sequence, 'packing');
    await expect(repo.advanceLegacyArchiveExport('first', packing.sequence, 'aborted')).rejects.toThrow('阶段已变化');
    await expect(repo.advanceLegacyArchiveExport('first', packing.sequence, 'published')).rejects.toThrow('缺少');
    expect((await repo.readLegacyArchiveExport('first'))?.phase).toBe('packing');
    expect(await exchange.loadProjectExchangeState('owner')).toBeNull();
    const published = await repo.advanceLegacyArchiveExport('first', packing.sequence, 'published', { publicationRef: 'opaque-receipt', archiveSha256: 'a'.repeat(64) });
    await exchange.saveProjectExchangeCheckpoint(published.checkpoint);
    await repo.advanceLegacyArchiveExport('first', published.sequence, 'registered');
    await expect(repo.prepareLegacyArchiveExport('second', material)).rejects.toThrow('协作版本');
    await expect(repo.prepareLegacyArchiveExport('second', { ...material, expectedState: material.state,
      state: { ...material.state, stateVersion: 2 } })).resolves.toMatchObject({ phase: 'prepared' });
  });
  it('仅prepared可显式撤销，过期sequence及替换首个checkpoint均拒绝', async () => {
    await fixture();
    const repo = await import('../../src/services/indexedDb/projectArchiveOperationRepository');
    const material = await checkpoint(), prepared = await repo.prepareLegacyArchiveExport('first', material);
    await expect(repo.prepareLegacyArchiveExport('first', { ...material, state: { ...material.state, stateVersion: 2 } })).rejects.toThrow('其他内容');
    await expect(repo.advanceLegacyArchiveExport('first', 0, 'packing')).rejects.toThrow('阶段已变化');
    await repo.advanceLegacyArchiveExport('first', prepared.sequence, 'aborted');
    await expect(repo.prepareLegacyArchiveExport('second', material)).resolves.toMatchObject({ phase: 'prepared' });
  });
});
