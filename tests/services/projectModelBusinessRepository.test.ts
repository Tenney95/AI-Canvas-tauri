/** P3 隔离业务仓储回归源；本轮仅编写，未运行。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginProjectModelFixtureBusinessSession, createProjectModelBusinessRepository, validateProjectModelTransferAggregate,
} from '../../src/services/indexedDb/projectModelBusinessRepository';
import { createProjectModelStagingRepository, openProjectModelFixtureDatabase } from '../../src/services/indexedDb/projectModelStagingRepository';
import { readLegacyMigrationSnapshot } from '../../src/services/indexedDb/projectModelMigrationRepository';
import { createProjectModelBackup } from '../../src/services/projectModelBackup';
import { fingerprintProjectModelSource } from '../../src/services/projectModelSourceFingerprint';
import { PROJECT_MODEL_BUSINESS_FIXTURE_KEY } from '../../src/types/projectModelBusiness';
import type { ProjectModelTransferAggregate } from '../../src/types/projectModelTransfer';

const legacy = (id: string, fields: Record<string, unknown> = {}) => ({ id, name: id, createdAt: 1, updatedAt: 2,
  nodes: [], edges: [], dataFolder: 'folder-' + id, ...fields });
async function mutate(database: IDBDatabase, names: string[], action: (tx: IDBTransaction) => void) {
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(names, 'readwrite'); action(tx);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
async function all(database: IDBDatabase, name: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(name, 'readonly').objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function setup(records: Array<Record<string, unknown>>) {
  const factory = new IDBFactory(), name = 'ai-canvas-model-fixture-business';
  const original = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 27);
    request.onupgradeneeded = () => {
      for (const store of ['projects', 'metadata', 'agentTasks', 'chatConversations']) request.result.createObjectStore(store, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await mutate(original, ['projects', 'metadata', 'agentTasks', 'chatConversations'], (tx) => {
    for (const row of records) tx.objectStore('projects').add(row);
    tx.objectStore('agentTasks').add({ id: 'paid', projectId: 'E', status: 'submit_unknown', sequence: 9, toolCallCount: 12 });
    tx.objectStore('metadata').add({ id: 'mcp-operation:paid-key', bindingId: 'original-binding', sequence: 9 });
    tx.objectStore('chatConversations').add({ id: 'chat', projectId: 'S', title: '共享会话' });
  });
  const snapshot = await readLegacyMigrationSnapshot(original, { localStorage: { getItem: () => '[]' } });
  expect(snapshot.complete).toBe(true); original.close();
  const bundle = await createProjectModelBackup(snapshot.source, { operationId: 'business-backup', createdAt: 0 });
  const database = await openProjectModelFixtureDatabase({ factory, name });
  const staging = createProjectModelStagingRepository(database);
  await staging.prepare({ operationId: 'business-migration', generation: 1, source: snapshot.source,
    sourceDigest: await fingerprintProjectModelSource(bundle.manifest), backupOperationId: 'business-backup', backupManifestDigest: 'b'.repeat(64) });
  await staging.stageNextBatch({ operationId: 'business-migration', batchSize: 500 });
  await staging.verify({ operationId: 'business-migration' });
  const session = await beginProjectModelFixtureBusinessSession(database, { operationId: 'business-migration', generation: 1, sessionId: 'business-session' });
  return { database, staging, session, repository: createProjectModelBusinessRepository(database, session),
    originalRecords: snapshot.source.stores.find((store) => store.name === 'projects')!.records.map((row) => row.value) };
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('P3 隔离新模型业务仓储', () => {
  it('接纳旧五角色团队DTO且保留原值，不接受其他有损规范化', () => {
    const oldTeam = { version: 1 as const, name: '旧团队', roles: { architect: 'a', writer: 'b', continuity: 'c', dialogue: 'd', editor: 'e' },
      maxCalls: 8, maxTotalTokens: 240000, maxOutputChars: 16000 };
    const input: ProjectModelTransferAggregate = {
      project: { id: 'P', name: '独立项目', kind: 'standalone', createdAt: 1, updatedAt: 1, epoch: 0,
        dataFolder: 'folder-P', storageRootRef: 'root-P', storageBindings: [
          { rootRef: 'root-P', folderName: 'folder-P', sourceRecordIds: [], source: 'project-managed' },
        ] },
      content: { projectId: 'P', revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 },
        standaloneCreative: { revision: 0, storageRootRef: 'root-P', teamProfileOverride: oldTeam as never } },
      episodes: [], episodeContents: [], previews: [], bindings: [],
      canvases: [{ id: 'canvas-P', projectId: 'P', episodeId: null, storageRootRef: 'root-P',
        nodes: [], edges: [], groups: [], epoch: 0, revision: 0, revisionScope: 'project' }],
    };
    expect(validateProjectModelTransferAggregate(input).content.standaloneCreative?.teamProfileOverride).toEqual(oldTeam);
    expect(input.content.standaloneCreative?.teamProfileOverride?.roles).not.toHaveProperty('director');
    const missingWriter: Record<string, unknown> = { ...oldTeam.roles };
    delete missingWriter.writer;
    for (const invalid of [
      { ...oldTeam, maxCalls: 100 },
      { ...oldTeam, roles: { ...oldTeam.roles, writer: ' b ' } },
      { ...oldTeam, roles: { ...oldTeam.roles, director: null } },
      { ...oldTeam, roles: { ...oldTeam.roles, storyboard: 42 } },
      { ...oldTeam, roles: { ...oldTeam.roles, unknown: '' } },
      { ...oldTeam, roles: missingWriter },
    ]) {
      const damaged = structuredClone(input);
      damaged.content.standaloneCreative!.teamProfileOverride = invalid as never;
      expect(() => validateProjectModelTransferAggregate(damaged)).toThrow('invalid-team-profile');
    }
  });

  it('分集正文属于其他暂存操作时拒绝读取、保存和删除，保留原项目和证据', async () => {
    const sample = await setup([legacy('S', { series: { script: '共享' } }), legacy('E', { parentId: 'S', episodeNo: 1, episodeScript: '原稿' })]);
    try {
      const project = (await sample.repository.readProject('S')).project;
      const target = await sample.repository.readEpisode('S', 'E'), canvas = await sample.repository.readCanvas('S', 'E');
      const body = await sample.repository.readEpisodeContent('S', 'E');
      await mutate(sample.database, ['episodeContents'], (tx) => tx.objectStore('episodeContents').put({ ...body, operationId: 'other-operation' }));
      await expect(sample.repository.readEpisodeContent('S', 'E')).rejects.toThrow('episode-content-unavailable');
      await expect(sample.repository.saveEpisodeContent({ projectId: 'S', expectedProjectEpoch: project.epoch, episodeId: 'E',
        expectedEpisodeRevision: target.revision, expectedContentRevision: body.revision, patch: { script: '不应覆盖' } })).rejects.toThrow('episode-content-unavailable');
      await expect(sample.repository.deleteEpisode({ projectId: 'S', expectedProjectEpoch: project.epoch, episodeId: 'E',
        expectedEpisodeRevision: target.revision, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision }))
        .rejects.toThrow('episode-content-unavailable');
      expect(await sample.repository.readEpisode('S', 'E')).toMatchObject({ id: 'E', revision: target.revision });
      expect((await all(sample.database, 'episodeContents'))[0]).toMatchObject({ episodeId: 'E', script: '原稿', operationId: 'other-operation' });
      expect((await all(sample.database, 'metadata')).some((row) => String(row.id).startsWith('project-model-business-tombstone:'))).toBe(false);
    } finally { sample.database.close(); }
  });

  it('分集列表发现其他操作的记录或重复排序时拒绝排序和选择，不能修补未知数据', async () => {
    const sample = await setup([legacy('S', { series: { script: '共享' } }), legacy('A', { parentId: 'S', episodeNo: 1 }),
      legacy('B', { parentId: 'S', episodeNo: 2 })]);
    try {
      const project = (await sample.repository.readProject('S')).project, before = await sample.repository.listEpisodes('S');
      const rows = await all(sample.database, 'episodes');
      const b = rows.find((row) => row.id === 'B')!;
      await mutate(sample.database, ['episodes'], (tx) => tx.objectStore('episodes').put({ ...b, operationId: 'other-operation' }));
      await expect(sample.repository.listEpisodes('S')).rejects.toThrow('broken-episode-membership');
      await expect(sample.repository.reorderEpisodes({ projectId: 'S', expectedProjectEpoch: project.epoch,
        expectedEpisodes: before.map(({ id, revision }) => ({ id, revision })), orderedEpisodeIds: ['B', 'A'] }))
        .rejects.toThrow('broken-episode-membership');
      await mutate(sample.database, ['episodes'], (tx) => tx.objectStore('episodes').put({ ...b, orderRank: before[0].orderRank }));
      await expect(sample.repository.openProject('S')).rejects.toThrow('broken-episode-membership');
      expect((await sample.repository.readProject('S')).project.epoch).toBe(project.epoch);
      expect(await sample.repository.readSession()).toMatchObject({ revision: 0, dirty: false });
    } finally { sample.database.close(); }
  });

  it('缺少对应画布的孤立分集不能产生可执行上下文', async () => {
    const sample = await setup([legacy('S', { series: { script: '共享' } }), legacy('E', { parentId: 'S', episodeNo: 1 })]);
    try {
      const linked = await sample.repository.readCanvas('S', 'E');
      await mutate(sample.database, ['canvasDocuments'], (tx) => tx.objectStore('canvasDocuments').put({ ...linked, operationId: 'other-operation' }));
      await expect(sample.repository.readExpectedContext({ kind: 'episode', projectId: 'S', episodeId: 'E' }))
        .rejects.toThrow('canvas-unavailable');
      await mutate(sample.database, ['canvasDocuments'], (tx) => tx.objectStore('canvasDocuments').delete([1, 'E']));
      await expect(sample.repository.readExpectedContext({ kind: 'episode', projectId: 'S', episodeId: 'E' }))
        .rejects.toThrow('canvas-unavailable');
      expect(await sample.repository.readEpisode('S', 'E')).toMatchObject({ id: 'E' });
      expect(await sample.repository.readSession()).toMatchObject({ revision: 0, dirty: false });
    } finally { sample.database.close(); }
  });

  it('P4只读上下文按同事务新表版本读取，退役alias可查历史而不能再取活动Canvas', async () => {
    const sample = await setup([legacy('S', { series: { script: '共享' } }), legacy('E', { parentId: 'S', episodeNo: 1 })]);
    try {
      const context = await sample.repository.readExpectedContext({ kind: 'canvas', projectId: 'S', canvasId: 'E' });
      expect(context).toMatchObject({ kind: 'canvas', projectId: 'S', canvasId: 'E', episodeId: 'E', modelGeneration: 1 });
      const project = (await sample.repository.readProject('S')).project;
      const episode = await sample.repository.readEpisode('S', 'E'), canvas = await sample.repository.readCanvas('S', 'E');
      await sample.repository.deleteEpisode({ projectId: 'S', expectedProjectEpoch: project.epoch, episodeId: 'E',
        expectedEpisodeRevision: episode.revision, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision });
      expect(await sample.repository.readExpectedContext({ kind: 'project', projectId: 'S' })).toMatchObject({ kind: 'project', projectId: 'S' });
      expect((await sample.repository.listLegacyBindings('S')).filter((item) => item.legacyId === 'E').every((item) => item.retired)).toBe(true);
      await expect(sample.repository.readExpectedContext({ kind: 'canvas', projectId: 'S', canvasId: 'E' })).rejects.toThrow('canvas-unavailable');
      expect(await all(sample.database, 'agentTasks')).toContainEqual(expect.objectContaining({ id: 'paid', sequence: 9, toolCallCount: 12 }));
    } finally { sample.database.close(); }
  });
  it('画布与共享各域独立CAS，旧整份内容不会覆盖其他域，dirty数据禁止P2撤销', async () => {
    const sample = await setup([legacy('P')]);
    try {
      const project = (await sample.repository.readProject('P')).project;
      await sample.repository.saveProjectContent({ projectId: 'P', expectedProjectEpoch: project.epoch,
        domain: 'script', expectedRevision: 0, value: '新的全剧稿' });
      await sample.repository.saveProjectContent({ projectId: 'P', expectedProjectEpoch: project.epoch,
        domain: 'source', expectedRevision: 0, value: { fileName: '原著.txt', relativePath: 'manuscripts/原著.txt', addedAt: 3 } });
      await expect(sample.repository.saveProjectContent({ projectId: 'P', expectedProjectEpoch: project.epoch,
        domain: 'script', expectedRevision: 0, value: '旧稿覆盖' })).rejects.toThrow('project-content-version-conflict');
      const canvas = await sample.repository.readCanvas('P', 'P');
      await sample.repository.saveCanvas({ projectId: 'P', expectedProjectEpoch: project.epoch, canvasId: 'P',
        expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
        document: { nodes: [{ id: 'n', data: { text: '独立画布修改' } }], edges: [], groups: [] } });
      expect(await sample.repository.readProjectContent('P')).toMatchObject({ script: '新的全剧稿',
        originalWork: { relativePath: 'manuscripts/原著.txt' }, revisions: { script: 1, source: 1 } });
      expect(await sample.repository.readSession()).toMatchObject({ dirty: true, revision: 3 });
      const expected = (await sample.staging.readJournal('business-migration'))!;
      await expect(sample.staging.rollback({ operationId: 'business-migration', expected })).rejects.toThrow();
      expect(await all(sample.database, 'projects')).toEqual(sample.originalRecords);
      expect((await all(sample.database, 'metadata')).some((row) => row.id === 'activeDataModel')).toBe(false);
    } finally { sample.database.close(); }
  });

  it('普通项目转换保留根和原画布ID，将旧顶层稿件移入真实第一集，新集继承而旧效果固定', async () => {
    const scriptFile = { fileName: '旧稿.txt', relativePath: 'manuscripts/旧稿.txt', digest: 'a'.repeat(64) };
    const sample = await setup([legacy('P', { episodeScript: '旧顶层分集稿', episodeOutline: '旧大纲', episodeScriptFile: scriptFile,
      settings: { defaultModels: { image: 'old-image-model' } }, nodes: [{ id: 'old-node', data: { text: '旧节点' } }] })]);
    try {
      const first = (await sample.repository.readProject('P')).project;
      const converted = await sample.repository.convertStandaloneToSeries({ projectId: 'P', expectedProjectEpoch: first.epoch,
        episodeId: 'first-episode', name: '第一集', displayNo: 1 });
      expect(converted).toMatchObject({ id: 'first-episode', projectId: 'P', canvasId: 'P',
        settingsPolicy: { mode: 'legacy-pinned', snapshot: { defaultModels: { image: 'old-image-model' } } } });
      expect(await sample.repository.readEpisodeContent('P', converted.id)).toMatchObject({ script: '旧顶层分集稿', outline: '旧大纲', scriptFile });
      expect(await sample.repository.readCanvas('P', 'P')).toMatchObject({ id: 'P', episodeId: converted.id,
        nodes: [{ id: 'old-node', data: { text: '旧节点' } }] });
      expect((await sample.repository.readProjectContent('P')).standaloneCreative).toBeUndefined();
      const current = (await sample.repository.readProject('P')).project;
      await sample.repository.createEpisode({ projectId: 'P', expectedProjectEpoch: current.epoch, episodeId: 'new-episode', canvasId: 'new-canvas', name: '新建第二集' });
      expect(await sample.repository.readEpisode('P', 'new-episode')).toMatchObject({ settingsPolicy: { mode: 'inherit', overrides: {} } });
      expect(await sample.repository.readEpisode('P', 'first-episode')).toMatchObject({ settingsPolicy: converted.settingsPolicy });
      expect((await sample.repository.listEpisodes('P'))[0]).not.toHaveProperty('settingsPolicy');
      expect((await sample.repository.listProjects())[0]).not.toHaveProperty('defaultSettings');
      expect(await all(sample.database, 'projects')).toEqual(sample.originalRecords);
    } finally { sample.database.close(); }
  });

  it('整组排序在同一事务完成，失败不留半次换序，并校验完整成员与各集版本', async () => {
    const sample = await setup([legacy('S', { series: { script: '共享' } }), legacy('A', { parentId: 'S', episodeNo: 1, episodeScript: 'A稿' }),
      legacy('B', { parentId: 'S', episodeNo: 2, episodeScript: 'B稿' })]);
    try {
      const project = (await sample.repository.readProject('S')).project, before = await sample.repository.listEpisodes('S');
      const input = { projectId: 'S', expectedProjectEpoch: project.epoch,
        expectedEpisodes: before.map(({ id, revision }) => ({ id, revision })), orderedEpisodeIds: ['B', 'A'] };
      const realPut = IDBObjectStore.prototype.put; let writes = 0;
      const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === 'episodes' && ++writes === 2) throw new DOMException('fixture quota', 'QuotaExceededError');
        return realPut.apply(this, args);
      });
      await expect(sample.repository.reorderEpisodes(input)).rejects.toThrow(); spy.mockRestore();
      expect(await sample.repository.listEpisodes('S')).toEqual(before);
      expect((await sample.repository.readProject('S')).project.epoch).toBe(project.epoch);
      await sample.repository.reorderEpisodes(input);
      expect((await sample.repository.listEpisodes('S')).map((row) => row.id)).toEqual(['B', 'A']);
      expect(await sample.repository.readEpisodeContent('S', 'A')).toMatchObject({ script: 'A稿' });
      await expect(sample.repository.reorderEpisodes(input)).rejects.toThrow('project-version-conflict');
      const next = (await sample.repository.readProject('S')).project;
      await expect(sample.repository.reorderEpisodes({ ...input, expectedProjectEpoch: next.epoch,
        expectedEpisodes: [{ id: 'B', revision: 1 }], orderedEpisodeIds: ['B'] })).rejects.toThrow('episode-membership-changed');
    } finally { sample.database.close(); }
  });

  it('删除最后一集保留整剧、共享资料和审计，零集打开没有假画布且可继续建集', async () => {
    const sample = await setup([legacy('S', { series: { script: '全剧稿' } }), legacy('E', { parentId: 'S', episodeNo: 1, episodeScript: '本集稿' }), legacy('other')]);
    try {
      const project = (await sample.repository.readProject('S')).project, target = await sample.repository.readEpisode('S', 'E'), canvas = await sample.repository.readCanvas('S', 'E');
      const audit = await all(sample.database, 'agentTasks'), chat = await all(sample.database, 'chatConversations');
      await sample.repository.deleteEpisode({ projectId: 'S', expectedProjectEpoch: project.epoch, episodeId: target.id,
        expectedEpisodeRevision: target.revision, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision });
      const surviving = (await sample.repository.readProject('S')).project;
      expect(surviving).toMatchObject({ id: 'S', kind: 'series' }); expect(await sample.repository.listEpisodes('S')).toEqual([]);
      expect(await sample.repository.openProject('S')).toMatchObject({ activeProjectId: 'S', activeCanvasId: null, activeEpisodeId: null, contextKind: 'project' });
      expect(await sample.repository.readProjectContent('S')).toMatchObject({ script: '全剧稿' });
      expect(await all(sample.database, 'agentTasks')).toEqual(audit); expect(await all(sample.database, 'chatConversations')).toEqual(chat);
      expect((await all(sample.database, 'legacyProjectBindings')).some((row) => row.legacyId === 'E' && row.retired === true)).toBe(true);
      expect((await sample.repository.listProjects()).map((row) => row.id)).toEqual(['S', 'other']);
      await sample.repository.createEpisode({ projectId: 'S', expectedProjectEpoch: surviving.epoch, episodeId: 'after-empty', canvasId: 'after-empty-canvas', name: '重建一集' });
      expect(await sample.repository.openProject('S')).toMatchObject({ activeCanvasId: 'after-empty-canvas', contextKind: 'canvas' });
      expect(await all(sample.database, 'projects')).toEqual(sample.originalRecords);
    } finally { sample.database.close(); }
  });

  it('删除整剧有独立tombstone和清理待办，保留其他项目/原源/收费事实；晚到写入使删除预览失效', async () => {
    const sample = await setup([legacy('S', { series: { script: '共享' } }), legacy('E', { parentId: 'S', episodeNo: 1 }), legacy('other')]);
    try {
      const before = await sample.repository.readProject('S');
      await sample.repository.saveProjectContent({ projectId: 'S', expectedProjectEpoch: before.project.epoch,
        domain: 'script', expectedRevision: 0, value: '预览后的更新' });
      await expect(sample.repository.deleteProject({ projectId: 'S', expectedProjectEpoch: before.project.epoch,
        expectedSessionRevision: before.sessionRevision })).rejects.toThrow('fixture-version-conflict');
      const current = await sample.repository.readProject('S');
      await sample.repository.deleteProject({ projectId: 'S', expectedProjectEpoch: current.project.epoch, expectedSessionRevision: current.sessionRevision });
      expect((await sample.repository.listProjects()).map((row) => row.id)).toEqual(['other']);
      expect(await all(sample.database, 'agentTasks')).toHaveLength(1); expect(await all(sample.database, 'chatConversations')).toHaveLength(1);
      const metadata = await all(sample.database, 'metadata');
      expect(metadata).toContainEqual(expect.objectContaining({ kind: 'project', targetId: 'S', projectId: 'S' }));
      expect(metadata).toContainEqual(expect.objectContaining({ projectId: 'S', stage: 'pending', canDeleteFiles: false }));
      expect(metadata).toContainEqual(expect.objectContaining({ id: PROJECT_MODEL_BUSINESS_FIXTURE_KEY, dirty: true }));
      expect(metadata).toContainEqual(expect.objectContaining({ id: 'mcp-operation:paid-key', sequence: 9 }));
      expect(await all(sample.database, 'projects')).toEqual(sample.originalRecords);
    } finally { sample.database.close(); }
  });

  it('新设置/稿件拒绝绝对路径和临时URL，旧集策略只在显式操作时修改', async () => {
    const sample = await setup([legacy('S', { series: { script: '共享' } }), legacy('E', { parentId: 'S', episodeNo: 1, settings: { defaultModels: { image: 'old' } } })]);
    try {
      const project = (await sample.repository.readProject('S')).project, episode = await sample.repository.readEpisode('S', 'E');
      await expect(sample.repository.updateProject({ projectId: 'S', expectedProjectEpoch: project.epoch,
        defaultSettings: { visualStyle: { styleReference: { filePath: 'C:/private/file.png' } } } })).rejects.toThrow('non-portable-reference');
      await expect(sample.repository.updateEpisodeSettings({ projectId: 'S', expectedProjectEpoch: project.epoch, episodeId: 'E', expectedEpisodeRevision: episode.revision,
        policy: { mode: 'inherit', overrides: { visualStyle: { styleReference: { op: 'set', value: { imageUrl: 'blob:temporary' } } } } } })).rejects.toThrow('temporary-style-reference');
      expect(await sample.repository.readEpisode('S', 'E')).toMatchObject({ settingsPolicy: episode.settingsPolicy });
    } finally { sample.database.close(); }
  });

  it('新画布和创作字段不能把凭据写入fixture，失败不推进业务版本', async () => {
    const sample = await setup([legacy('P')]);
    try {
      const project = (await sample.repository.readProject('P')).project, canvas = await sample.repository.readCanvas('P', 'P');
      await expect(sample.repository.saveCanvas({ projectId: 'P', expectedProjectEpoch: project.epoch, canvasId: 'P',
        expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
        document: { nodes: [{ id: 'bad', data: { apiKey: 'synthetic-secret' } }], edges: [], groups: [] } })).rejects.toThrow();
      expect(await sample.repository.readSession()).toMatchObject({ revision: 0, dirty: false });
      expect(await sample.repository.readCanvas('P', 'P')).toMatchObject({ revision: 0, nodes: [] });
    } finally { sample.database.close(); }
  });

  it('清空普通稿件仍推进独立版本，旧revision0不能在清空后复活正文', async () => {
    const sample = await setup([legacy('P')]);
    try {
      const project = (await sample.repository.readProject('P')).project;
      await sample.repository.saveProjectContent({ projectId: 'P', expectedProjectEpoch: project.epoch,
        domain: 'standaloneCreative', expectedRevision: 0, value: { script: '第一版' } });
      await sample.repository.saveProjectContent({ projectId: 'P', expectedProjectEpoch: project.epoch,
        domain: 'standaloneCreative', expectedRevision: 1, value: undefined });
      expect((await sample.repository.readProjectContent('P')).standaloneCreative).toMatchObject({ revision: 2 });
      await expect(sample.repository.saveProjectContent({ projectId: 'P', expectedProjectEpoch: project.epoch,
        domain: 'standaloneCreative', expectedRevision: 0, value: { script: '旧窗口稿' } })).rejects.toThrow('project-content-version-conflict');
      expect((await sample.repository.readProjectContent('P')).standaloneCreative?.script).toBeUndefined();
    } finally { sample.database.close(); }
  });

  it('目录只读轻量模型和marker，不通过P2journal重新克隆正文', async () => {
    const sample = await setup([legacy('S', { series: { script: '很长的全剧正文' } }), legacy('E', { parentId: 'S', episodeNo: 1, episodeScript: '正文' })]);
    try {
      const tables: string[] = [], realGet = IDBObjectStore.prototype.get, realAll = IDBObjectStore.prototype.getAll;
      const first = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
        tables.push(this.name); return realGet.apply(this, args);
      });
      const second = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
        tables.push(this.name); return realAll.apply(this, args);
      });
      await sample.repository.listProjects(); await sample.repository.listEpisodes('S');
      first.mockRestore(); second.mockRestore();
      expect(tables).not.toContain('projectModelMigrations'); expect(tables).not.toContain('projectContents');
      expect(tables).not.toContain('canvasDocuments'); expect(tables).not.toContain('episodeContents');
    } finally { sample.database.close(); }
  });

  it('本集场景清单允许保存并读回，缺少场景字段的旧清单保持兼容', async () => {
    const oldRoster = { version: 1 as const, revision: 0, characters: [], props: [] };
    const sample = await setup([legacy('S', { series: { script: '共享' } }),
      legacy('E', { parentId: 'S', episodeNo: 1, episodeAssetRoster: oldRoster })]);
    try {
      const project = (await sample.repository.readProject('S')).project, target = await sample.repository.readEpisode('S', 'E');
      const body = await sample.repository.readEpisodeContent('S', 'E');
      expect(body.assetRoster).toEqual(oldRoster);
      const assetRoster = { ...oldRoster, revision: 1, scenes: [{ id: 'scene-entry', kind: 'scene' as const,
        name: '车站', summary: '雨夜站台', visualNotes: '', notes: '', boundDramaAssetId: 'scene-formal', createdAt: 1, updatedAt: 1 }] };
      await sample.repository.saveEpisodeContent({ projectId: 'S', expectedProjectEpoch: project.epoch, episodeId: 'E',
        expectedEpisodeRevision: target.revision, expectedContentRevision: body.revision, patch: { assetRoster } });
      expect((await sample.repository.readEpisodeContent('S', 'E')).assetRoster).toEqual(assetRoster);
    } finally { sample.database.close(); }
  });

  it('域保存拒绝错误类型/坏图/越权归属字段，不以空对象代替资料', async () => {
    const sample = await setup([legacy('S', { series: { script: '共享' } }), legacy('E', { parentId: 'S', episodeNo: 1, episodeScript: '保留稿件' }), legacy('P')]);
    try {
      const project = (await sample.repository.readProject('S')).project, target = await sample.repository.readEpisode('S', 'E');
      const body = await sample.repository.readEpisodeContent('S', 'E');
      await expect(sample.repository.saveEpisodeContent({ projectId: 'S', expectedProjectEpoch: project.epoch, episodeId: target.id,
        expectedEpisodeRevision: target.revision, expectedContentRevision: body.revision,
        patch: { script: 42 as unknown as string } })).rejects.toThrow('invalid-creative-content');
      await expect(sample.repository.saveEpisodeContent({ projectId: 'S', expectedProjectEpoch: project.epoch, episodeId: target.id,
        expectedEpisodeRevision: target.revision, expectedContentRevision: body.revision,
        patch: { assetRoster: { version: 1, revision: 0, characters: 'bad', props: [] } as never } })).rejects.toThrow('invalid-asset-roster');
      await expect(sample.repository.saveProjectContent({ projectId: 'S', expectedProjectEpoch: project.epoch,
        domain: 'storyGraph', expectedRevision: 0, value: { schemaVersion: 1, nodes: [], edges: [{}] } as never })).rejects.toThrow();
      const ordinary = (await sample.repository.readProject('P')).project;
      await expect(sample.repository.saveProjectContent({ projectId: 'P', expectedProjectEpoch: ordinary.epoch,
        domain: 'standaloneCreative', expectedRevision: 0, value: { script: '稿', storageRootRef: 'other-root' } as never })).rejects.toThrow('invalid-standalone-creative');
      expect(await sample.repository.readEpisodeContent('S', 'E')).toMatchObject({ script: '保留稿件', revision: body.revision });
      expect(await sample.repository.readSession()).toMatchObject({ revision: 0, dirty: false });
    } finally { sample.database.close(); }
  });

  it('切换和保存拒绝孤立canvas，调用后修改请求对象不会改绑本次保存', async () => {
    const sample = await setup([legacy('S', { series: { script: '共享' } }), legacy('E', { parentId: 'S', episodeNo: 1 }), legacy('P')]);
    try {
      const ordinary = (await sample.repository.readProject('P')).project, canvas = await sample.repository.readCanvas('P', 'P');
      const input = { projectId: 'P', expectedProjectEpoch: ordinary.epoch, canvasId: 'P', expectedCanvasEpoch: canvas.epoch,
        expectedCanvasRevision: canvas.revision, document: { nodes: [{ id: 'one', data: { text: '原意图' } }], edges: [], groups: [] } };
      const pending = sample.repository.saveCanvas(input);
      input.projectId = 'S'; input.canvasId = 'E'; input.document.nodes[0].data.text = '调用后的变动';
      await pending;
      expect(await sample.repository.readCanvas('P', 'P')).toMatchObject({ nodes: [{ id: 'one', data: { text: '原意图' } }] });
      const target = await sample.repository.readCanvas('S', 'E');
      await mutate(sample.database, ['canvasDocuments'], (tx) => tx.objectStore('canvasDocuments').put({ ...target, episodeId: 'missing' }));
      await expect(sample.repository.openProject('S')).rejects.toThrow('broken-canvas-membership');
      await expect(sample.repository.saveCanvas({ projectId: 'S', expectedProjectEpoch: (await sample.repository.readProject('S')).project.epoch,
        canvasId: 'E', expectedCanvasEpoch: target.epoch, expectedCanvasRevision: target.revision,
        document: { nodes: [], edges: [], groups: [] } })).rejects.toThrow('broken-canvas-membership');
    } finally { sample.database.close(); }
  });
});
