/**
 * indexedDbService — 回归测试：project snapshot updates。
 */
import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyStoryGraph } from '../../src/services/storyGraphService';

const DB_NAME = 'ai-canvas-db';
const EXPECTED_STORES = [
  'agentTasks',
  'appearanceThemes',
  'assetIndex',
  'assetMeta',
  'assetMetaV2',
  'chatConversations',
  'chatMessages',
  'config',
  'globalCharacters',
  'globalDramaAssets',
  'history',
  'metadata',
  'plugins',
  'presets',
  'projectExchangeSnapshots',
  'projectExchangeStates',
  'projectMemories',
  'projectSummaries',
  'projectVisualDescriptions',
  'projects',
  'sharedAssetConflicts',
  'sharedAssetMappings',
  'sharedAssetOutbox',
  'skills',
  'styles',
  'subAgentProfiles',
  'toolbarLayouts',
  'videoEditorProjects',
  'workflows',
];

function openDatabase(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined
      ? indexedDB.open(name)
      : indexedDB.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const RECOVERY_PROJECT = {
  id: 'saved-project',
  name: '昨天保存的项目',
  createdAt: 1,
  updatedAt: 2,
  nodes: [{ id: 'saved-node' }],
  edges: [],
};
const RECOVERY_CONFIG = {
  theme: 'light',
  providers: { saved: { name: '原有连接', apiKeyRef: 'provider/saved' } },
};

async function seedLegacyDatabase(version = 20): Promise<IDBDatabase> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' });
      request.result.createObjectStore('config', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['projects', 'config'], 'readwrite');
    transaction.objectStore('projects').put(RECOVERY_PROJECT);
    transaction.objectStore('config').put({ id: 'app-config', data: RECOVERY_CONFIG });
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  return db;
}

function readRecord(db: IDBDatabase, store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('故事图原子保存', () => {
  it('并发 CAS 只有一个成功，迟到的普通保存不能覆盖正式图或项目摘要', async () => {
    const db = await import('../../src/services/indexedDbService');
    const graph = { ...createEmptyStoryGraph('graph'), revision: 6 };
    const record = { id: 'series-graph', name: '整部剧', createdAt: 1, updatedAt: 2, nodes: [], edges: [],
      series: { script: '原剧本', storyGraph: graph } };
    await db.saveProjectToDb(record);
    const node = { id: 'event', kind: 'event' as const, label: '关键事件', description: '', aliases: [],
      episodeIds: [], evidence: [], origin: 'manual' as const, certainty: 'explicit' as const };
    const writes = await Promise.allSettled([
      db.updateProjectStoryGraphCAS(record.id, { graphId: graph.id, upsertNodes: [node] }, 6, 0),
      db.updateProjectStoryGraphCAS(record.id, { graphId: graph.id, upsertNodes: [{ ...node, label: '另一编辑' }] }, 6, 0),
    ]);
    expect(writes.filter((write) => write.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((write) => write.status === 'rejected')).toHaveLength(1);
    const committed = (await db.getProjectById(record.id))!.series!.storyGraph!;
    expect(committed.revision).toBe(7);
    await db.saveProjectToDb({ ...record, series: { ...record.series, script: '较新的正文' } });
    expect((await db.getProjectById(record.id))!.series).toEqual({ script: '较新的正文', storyGraph: committed });
    expect((await db.getAllProjects()).find((item) => item.id === record.id)?.series?.storyGraph).toEqual(committed);
  });

  it('归档代际变化或宿主守卫拒绝时不产生图写入', async () => {
    const db = await import('../../src/services/indexedDbService');
    const record = { id: 'series-epoch', name: '整部剧', exchangeEpoch: 3, createdAt: 1, updatedAt: 2, nodes: [], edges: [] };
    await db.saveProjectToDb({ ...record, exchangeEpoch: 0 });
    // 非零代际由导入事务产生，普通保存不能创建带有导入代际的新记录。
    const database = await openDatabase(DB_NAME);
    const { toProjectSummaryRecord } = await import('../../src/services/indexedDb/projectSummary');
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['projects', 'projectSummaries'], 'readwrite');
        transaction.objectStore('projects').put(record);
        transaction.objectStore('projectSummaries').put(toProjectSummaryRecord(record));
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
    await expect(db.updateProjectStoryGraphCAS(record.id, { graphId: 'graph' }, 0, 2)).rejects.toThrow('已变化');
    await expect(db.updateProjectStoryGraphCAS(record.id, { graphId: 'graph' }, 0, 3,
      () => { throw new Error('编辑会话已关闭'); })).rejects.toThrow('会话已关闭');
    expect((await db.getProjectById(record.id))?.series?.storyGraph).toBeUndefined();
  });
});

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.resetModules();
});

describe('project snapshot updates', () => {
  it('keeps episode creation references and role overrides in the persisted lightweight list', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { createDefaultTeamProfile } = await import('../../src/services/chat/teams/teamProfileService');
    const { toProjectSummaryRecord } = await import('../../src/services/indexedDb/projectSummary');
    const creationProfile = { id: 'script-team', version: '1.0.0', sha256: 'a'.repeat(64) };
    const teamProfileOverride = createDefaultTeamProfile('text');
    const episode = { ...RECOVERY_PROJECT, parentId: 'series', creationProfile, teamProfileOverride };
    await service.saveProjectToDb(episode);
    const listed = (await service.getAllProjects())[0];
    expect(listed.creationProfile).toEqual(creationProfile);
    expect(listed.teamProfileOverride).toEqual(teamProfileOverride);
    expect(listed).not.toHaveProperty('nodes');
    expect((await service.getProjectById(episode.id))?.creationProfile).toEqual(creationProfile);
    await service.saveProjectToDb({ ...episode, creationProfile: undefined, teamProfileOverride: undefined });
    expect((await service.getAllProjects())[0]).not.toHaveProperty('creationProfile');
    expect(toProjectSummaryRecord(RECOVERY_PROJECT)).not.toHaveProperty('teamProfileOverride');
    const invalid = toProjectSummaryRecord({ ...episode, creationProfile: { ...creationProfile, apiKey: 'fixture-private' } });
    expect(invalid?.creationProfile?.id).toBe('invalid-creation-profile');
    expect(JSON.stringify(invalid)).not.toContain('fixture-private');
  });

  it('keeps creation selection CAS changes when an older conversation snapshot later saves', async () => {
    const service = await import('../../src/services/indexedDbService');
    const original = { id: 'conv-profile', projectId: 'project', title: '旧标题', titleSource: 'user' as const,
      pinned: false, archived: false, agentMode: 'collaborative' as const, createdAt: 1, updatedAt: 1, messageCount: 0 };
    await service.putChatConversation(original);
    const selection = { id: 'creation', version: '1.0.0', sha256: 'a'.repeat(64) };
    await service.setConversationCreationProfileCAS(original.id, undefined, selection, { executionSelection: { kind: 'team', templateId: 'outline' } });
    await service.putChatConversation({ ...original, title: '新标题', messageCount: 3 });
    const saved = (await service.getProjectConversations('project'))[0];
    expect(saved.creationProfile).toEqual(selection); expect(saved.creationProfileRevision).toBe(1);
    expect(saved.executionSelection).toEqual({ kind: 'team', templateId: 'outline' }); expect(saved.messageCount).toBe(3);
    await expect(service.setConversationCreationProfileCAS(original.id, undefined, undefined)).rejects.toThrow('CONFLICT');
  });
  it('clears only the preview for an empty canvas while keeping persisted data', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    await service.saveProjectToDb({ ...RECOVERY_PROJECT, snapshot: 'data:image/webp;base64,OLD' });

    await expect(service.updateProjectSnapshot(RECOVERY_PROJECT.id, undefined)).resolves.toBe(true);

    const db = await openDB();
    expect(await readRecord(db, 'projects', RECOVERY_PROJECT.id)).toEqual({ ...RECOVERY_PROJECT, snapshot: undefined });
    expect(await readRecord(db, 'projectSummaries', RECOVERY_PROJECT.id)).toMatchObject({
      id: RECOVERY_PROJECT.id, updatedAt: RECOVERY_PROJECT.updatedAt,
    });
    expect(await readRecord(db, 'projectSummaries', RECOVERY_PROJECT.id)).not.toHaveProperty('snapshot');
  });

  it('patches a late snapshot onto the latest canvas and metadata without reverting other fields', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    await service.saveProjectToDb({ ...RECOVERY_PROJECT, snapshot: 'data:image/webp;base64,OLD' });
    const latest = {
      ...RECOVERY_PROJECT,
      name: '编辑后的项目', updatedAt: 42,
      nodes: [{ id: 'new-node', data: { output: '保存后的最新正文' } }],
      edges: [{ id: 'new-edge', source: 'saved-node', target: 'new-node' }],
      groups: [{ id: 'new-group', nodeIds: ['new-node'] }],
      dramaAssets: { characters: [], scenes: [], props: [{ id: 'new-prop', name: '新道具' }] },
      episodeScript: '最新分集剧本',
      snapshot: 'data:image/webp;base64,CURRENT',
    };
    await service.saveProjectToDb(latest);
    const snapshot = 'data:image/webp;base64,LATE';

    await expect(service.updateProjectSnapshot(latest.id, snapshot)).resolves.toBe(true);

    const db = await openDB();
    expect(await readRecord(db, 'projects', latest.id)).toEqual({ ...latest, snapshot });
    expect(await readRecord(db, 'projectSummaries', latest.id)).toMatchObject({
      id: latest.id, name: latest.name, createdAt: latest.createdAt, updatedAt: latest.updatedAt,
      episodeScript: latest.episodeScript, snapshot,
    });
    const summary = await readRecord(db, 'projectSummaries', latest.id);
    expect(summary).not.toHaveProperty('nodes');
    expect(summary).not.toHaveProperty('dramaAssets');
  });

  it('does not recreate a deleted project or its summary when a snapshot arrives', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    await service.saveProjectToDb(RECOVERY_PROJECT);
    await service.deleteProjectFromDb(RECOVERY_PROJECT.id);

    await expect(service.updateProjectSnapshot(RECOVERY_PROJECT.id, 'data:image/webp;base64,LATE'))
      .resolves.toBe(false);

    const db = await openDB();
    expect(await readRecord(db, 'projects', RECOVERY_PROJECT.id)).toBeUndefined();
    expect(await readRecord(db, 'projectSummaries', RECOVERY_PROJECT.id)).toBeUndefined();
  });

  it('rejects and rolls back both stores when the summary write fails', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    await service.saveProjectToDb(RECOVERY_PROJECT);
    const db = await openDB();
    const summaryBefore = await readRecord(db, 'projectSummaries', RECOVERY_PROJECT.id);
    const objectStore = db.transaction('projectSummaries', 'readonly').objectStore('projectSummaries');
    const prototype = Object.getPrototypeOf(objectStore) as IDBObjectStore;
    const originalPut = prototype.put;
    const failure = new DOMException('fixture quota exhausted', 'QuotaExceededError');
    const put = vi.spyOn(prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'projectSummaries') throw failure;
      return originalPut.call(this, value, key);
    });
    try {
      await expect(service.updateProjectSnapshot(RECOVERY_PROJECT.id, 'data:image/webp;base64,LATE'))
        .rejects.toBe(failure);
    } finally {
      put.mockRestore();
    }

    expect(await readRecord(db, 'projects', RECOVERY_PROJECT.id)).toEqual(RECOVERY_PROJECT);
    expect(await readRecord(db, 'projectSummaries', RECOVERY_PROJECT.id)).toEqual(summaryBefore);
  });

  it('rejects oversized and non-image snapshot values before opening the database', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH } = await import('../../src/services/projectSnapshotValidation');
    const open = vi.spyOn(indexedDB, 'open');
    for (const snapshot of ['https://example.com/snapshot.webp', 'data:text/plain;base64,AAAA',
      `data:image/webp;base64,${'A'.repeat(PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH)}`]) {
      await expect(service.updateProjectSnapshot(RECOVERY_PROJECT.id, snapshot)).rejects.toThrow('参数无效');
    }
    expect(open).not.toHaveBeenCalled();
  });
});

describe('indexedDbService schema', () => {
  it('全局角色排序持久化只改顺序，旧编辑保存不会覆盖新顺序', async () => {
    const service = await import('../../src/services/indexedDbService');
    const a = { id: 'a', kind: 'character' as const, key: 'a', name: '角色 A', identity: '', summary: '', visualNotes: '',
      importance: 'main' as const, confirmed: false, source: 'manual' as const, createdAt: 1, updatedAt: 2 };
    const b = { ...a, id: 'b', name: '角色 B' };
    await service.putGlobalCharacter(a);
    await service.putGlobalCharacter(b);
    await service.putGlobalCharacterOrder(['b', 'a']);
    await service.putGlobalCharacter({ ...a, name: '编辑后的 A' });
    expect(await service.getAllGlobalCharacters()).toEqual([
      { ...a, name: '编辑后的 A', libraryOrder: 1 }, { ...b, libraryOrder: 0 },
    ]);
    await expect(service.putGlobalCharacterOrder(['a', 'missing'])).rejects.toThrow();
    expect((await service.getAllGlobalCharacters()).map((item) => item.libraryOrder)).toEqual([1, 0]);
    await expect(service.putGlobalCharacterOrder(['a', 'a'])).rejects.toThrow('重复');
  });
  it('uses strict durability only for configuration and toolbar writes', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    const db = await openDB();
    const transaction = vi.spyOn(db, 'transaction');
    await service.saveConfigToDb({ theme: 'dark' });
    await service.saveToolbarLayoutToDb('text', { version: 1, zones: [] }, { baseline: null });
    expect(transaction).toHaveBeenCalledWith('config', 'readwrite', { durability: 'strict' });
    expect(transaction).toHaveBeenCalledWith('toolbarLayouts', 'readwrite', { durability: 'strict' });
    await service.saveProjectToDb(RECOVERY_PROJECT);
    expect(transaction.mock.calls.at(-1)).toEqual([['projects', 'projectSummaries', 'metadata'], 'readwrite']);
  });

  it('falls back only when transaction options are unsupported and does not retry permission or quota failures', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    const db = await openDB();
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(() => { throw new TypeError('unsupported options'); });
    await service.saveConfigToDb({ theme: 'dark' });
    expect(transaction.mock.calls.slice(0, 2)).toEqual([['config', 'readwrite', { durability: 'strict' }], ['config', 'readwrite']]);
    for (const name of ['SecurityError', 'QuotaExceededError']) {
      transaction.mockClear().mockImplementationOnce(() => { throw new DOMException('fixture-private', name); });
      await expect(service.saveConfigToDb({ theme: 'light' })).rejects.toHaveProperty('name', name);
      expect(transaction).toHaveBeenCalledOnce();
    }
    expect(await service.loadConfigFromDb()).toEqual({ theme: 'dark' });
  });

  it('shares one opening request across concurrent callers', async () => {
    const { openDB } = await import('../../src/services/indexedDb/schema');
    const open = vi.spyOn(indexedDB, 'open');
    const first = openDB();
    const second = openDB();

    expect(second).toBe(first);
    expect(await second).toBe(await first);
    expect(open).toHaveBeenCalledTimes(1);
    (await first).close();
  });

  it.each(['upgrade abort', 'synchronous open failure'])(
    'retries after %s without losing saved projects or config',
    async (failure) => {
      (await seedLegacyDatabase()).close();
      const { openDB } = await import('../../src/services/indexedDb/schema');
      const nativeOpen = indexedDB.open.bind(indexedDB);
      const open = vi.spyOn(indexedDB, 'open').mockImplementationOnce((name, version) => {
        if (failure === 'synchronous open failure') {
          throw new DOMException('Storage temporarily unavailable', 'UnknownError');
        }
        const request = nativeOpen(name, version);
        request.addEventListener('upgradeneeded', () => {
          queueMicrotask(() => request.transaction?.abort());
        });
        return request;
      });

      await expect(openDB()).rejects.toMatchObject({
        name: failure === 'upgrade abort' ? 'AbortError' : 'UnknownError',
      });
      const recovered = await openDB();
      const service = await import('../../src/services/indexedDbService');

      expect(open).toHaveBeenCalledTimes(2);
      expect(await service.getProjectById(RECOVERY_PROJECT.id)).toEqual(RECOVERY_PROJECT);
      expect(await service.loadConfigFromDb()).toEqual(RECOVERY_CONFIG);
      recovered.close();
    },
  );

  it.each(['success', 'abort'])(
    'rejects a blocked open and tolerates its late %s without invalidating the retry',
    async (lateResult) => {
      const legacy = await seedLegacyDatabase();
      const { openDB } = await import('../../src/services/indexedDb/schema');
      const nativeOpen = indexedDB.open.bind(indexedDB);
      let firstRequest: IDBOpenDBRequest | undefined;
      let reportBlocked: () => void = () => {};
      const blocked = new Promise<void>((resolve) => { reportBlocked = resolve; });
      vi.spyOn(indexedDB, 'open').mockImplementationOnce((name, version) => {
        firstRequest = nativeOpen(name, version);
        firstRequest.addEventListener('blocked', reportBlocked);
        if (lateResult === 'abort') {
          firstRequest.addEventListener('upgradeneeded', () => {
            queueMicrotask(() => firstRequest?.transaction?.abort());
          });
        }
        return firstRequest;
      });
      let rejected: unknown;
      const first = openDB();
      void first.then((db) => db.close(), (error: unknown) => { rejected = error; });
      try {
        await blocked;
        await Promise.resolve();
        expect(rejected).toMatchObject({ name: 'InvalidStateError' });
      } finally {
        legacy.close();
      }

      const retry = openDB();
      const recovered = await retry;
      expect(openDB()).toBe(retry);
      expect(await readRecord(recovered, 'projects', RECOVERY_PROJECT.id)).toEqual(RECOVERY_PROJECT);
      expect(await readRecord(recovered, 'config', 'app-config')).toEqual({
        id: 'app-config', data: RECOVERY_CONFIG,
      });
      if (lateResult === 'success') {
        expect(() => firstRequest?.result.transaction('config', 'readonly'))
          .toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
      }
      recovered.close();
    },
  );

  it('releases its connection when another instance requests a schema upgrade', async () => {
    (await seedLegacyDatabase()).close();
    const { openDB, DB_VERSION } = await import('../../src/services/indexedDb/schema');
    const db = await openDB();
    const close = vi.spyOn(db, 'close');
    const versionChanged = new Promise<void>((resolve) => {
      db.addEventListener('versionchange', () => resolve());
    });
    const upgrade = openDatabase(DB_NAME, DB_VERSION + 1);
    try {
      await versionChanged;
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
    const upgraded = await upgrade;
    expect(await readRecord(upgraded, 'projects', RECOVERY_PROJECT.id)).toEqual(RECOVERY_PROJECT);
    expect(await readRecord(upgraded, 'config', 'app-config')).toEqual({
      id: 'app-config', data: RECOVERY_CONFIG,
    });
    upgraded.close();
    await expect(openDB()).rejects.toMatchObject({ name: 'VersionError' });
  });

  it('reconnects after the storage backend unexpectedly closes the database', async () => {
    (await seedLegacyDatabase()).close();
    const { openDB } = await import('../../src/services/indexedDb/schema');
    const first = await openDB();
    const closed = new Promise<void>((resolve) => first.addEventListener('close', () => resolve()));
    // 测试后端此辅助函数的声明误用了构造器类型，运行时参数是数据库实例。
    forceCloseDatabase(first as unknown as Parameters<typeof forceCloseDatabase>[0]);
    await closed;

    const recovered = await openDB();
    expect(recovered).not.toBe(first);
    expect(await readRecord(recovered, 'projects', RECOVERY_PROJECT.id)).toEqual(RECOVERY_PROJECT);
    expect(await readRecord(recovered, 'config', 'app-config')).toEqual({
      id: 'app-config', data: RECOVERY_CONFIG,
    });
    recovered.close();
  });

  it('refuses a newer database version without falling back or changing saved data', async () => {
    const { openDB, DB_VERSION } = await import('../../src/services/indexedDb/schema');
    (await seedLegacyDatabase(DB_VERSION + 1)).close();
    const open = vi.spyOn(indexedDB, 'open');

    await expect(openDB()).rejects.toMatchObject({ name: 'VersionError' });
    expect(open.mock.calls).toEqual([[DB_NAME, DB_VERSION]]);

    const newer = await openDatabase(DB_NAME);
    expect(newer.version).toBe(DB_VERSION + 1);
    expect(await readRecord(newer, 'projects', RECOVERY_PROJECT.id)).toEqual(RECOVERY_PROJECT);
    expect(await readRecord(newer, 'config', 'app-config')).toEqual({
      id: 'app-config', data: RECOVERY_CONFIG,
    });
    newer.close();
  });

  it('repairs an early v24 sync schema without losing projects, config, mappings or pending operations', async () => {
    const scope = {
      ownerId: RECOVERY_PROJECT.id, connectionId: 'saved-connection', connectionRevision: 'connection-v1',
      libraryId: 'shared-library', sharedProjectId: 'shared-project',
    };
    const mapping = {
      ...scope, id: 'saved-mapping', kind: 'file', localEntityId: 'local-file', sharedAssetId: 'shared-file',
      members: [], media: [], currentFileAssetId: 'local-file', acceptedRevisionId: 'revision-v1',
      acceptedETag: 'head-v1', baselineDigest: 'a'.repeat(64), updatedAt: 3,
    };
    const operation = {
      ...scope, id: 'saved-operation', operationId: 'saved-operation', mappingId: mapping.id,
      sharedAssetId: mapping.sharedAssetId, kind: 'file', direction: 'upload', revisionId: 'revision-v2',
      baseRevisionId: 'revision-v1', baseETag: 'head-v1', phase: 'prepared', createdAt: 4, updatedAt: 5,
    };
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 24);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('config', { keyPath: 'id' });
        for (const name of ['sharedAssetMappings', 'sharedAssetOutbox', 'sharedAssetConflicts']) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          store.createIndex('ownerId', 'ownerId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = oldDb.transaction(['projects', 'config', 'sharedAssetMappings', 'sharedAssetOutbox'], 'readwrite');
      tx.objectStore('projects').put(RECOVERY_PROJECT);
      tx.objectStore('config').put({ id: 'app-config', data: RECOVERY_CONFIG });
      tx.objectStore('sharedAssetMappings').put(mapping);
      tx.objectStore('sharedAssetOutbox').put(operation);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    oldDb.close();

    const { openDB, DB_VERSION } = await import('../../src/services/indexedDb/schema');
    const db = await openDB();
    expect(DB_VERSION).toBe(27);
    expect(db.version).toBe(27);
    const sync = db.transaction(['sharedAssetMappings', 'sharedAssetOutbox', 'sharedAssetConflicts'], 'readonly');
    const mappings = sync.objectStore('sharedAssetMappings');
    const outbox = sync.objectStore('sharedAssetOutbox');
    const conflicts = sync.objectStore('sharedAssetConflicts');
    expect([...mappings.indexNames]).toEqual(['localIdentity', 'ownerId', 'sharedIdentity']);
    expect([...outbox.indexNames]).toEqual(['operationId', 'ownerId']);
    expect([...conflicts.indexNames]).toEqual(['ownerId']);
    expect(mappings.index('localIdentity').unique).toBe(true);
    expect(mappings.index('localIdentity').keyPath).toEqual([
      'ownerId', 'connectionId', 'connectionRevision', 'libraryId', 'sharedProjectId', 'generation', 'kind', 'localEntityId',
    ]);
    expect(mappings.index('sharedIdentity').unique).toBe(true);
    expect(mappings.index('sharedIdentity').keyPath).toEqual([
      'ownerId', 'connectionId', 'connectionRevision', 'libraryId', 'sharedProjectId', 'generation', 'sharedAssetId',
    ]);
    expect(outbox.index('operationId').unique).toBe(true);
    expect(outbox.index('operationId').keyPath).toBe('operationId');
    const readUsingIndex = (store: string, name: string, key: IDBValidKey): Promise<unknown> => new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).index(name).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const sharedScope = [scope.ownerId, scope.connectionId, scope.connectionRevision, scope.libraryId, scope.sharedProjectId, 'legacy'];
    expect(await readUsingIndex('sharedAssetMappings', 'localIdentity', [...sharedScope, mapping.kind, mapping.localEntityId])).toEqual({ ...mapping, generation: 'legacy' });
    expect(await readUsingIndex('sharedAssetMappings', 'sharedIdentity', [...sharedScope, mapping.sharedAssetId])).toEqual({ ...mapping, generation: 'legacy' });
    expect(await readUsingIndex('sharedAssetMappings', 'ownerId', scope.ownerId)).toEqual({ ...mapping, generation: 'legacy' });
    expect(await readUsingIndex('sharedAssetOutbox', 'operationId', operation.operationId)).toEqual({ ...operation, generation: 'legacy' });
    expect(await readUsingIndex('sharedAssetOutbox', 'ownerId', scope.ownerId)).toEqual({ ...operation, generation: 'legacy' });
    expect(await readUsingIndex('sharedAssetConflicts', 'ownerId', scope.ownerId)).toBeUndefined();
    expect(await readRecord(db, 'projects', RECOVERY_PROJECT.id)).toEqual(RECOVERY_PROJECT);
    expect(await readRecord(db, 'config', 'app-config')).toEqual({ id: 'app-config', data: RECOVERY_CONFIG });
    expect(await readRecord(db, 'sharedAssetMappings', mapping.id)).toEqual({ ...mapping, generation: 'legacy' });
    expect(await readRecord(db, 'sharedAssetOutbox', operation.id)).toEqual({ ...operation, generation: 'legacy' });
    db.close();
  });

  it('creates the complete current schema for a fresh database', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { DB_VERSION } = await import('../../src/services/indexedDb/schema');
    await service.saveProjectToDb({
      id: 'project-fresh',
      name: 'Fresh project',
      createdAt: 1,
      updatedAt: 1,
      nodes: [],
      edges: [],
    });

    const db = await openDatabase(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).toEqual(EXPECTED_STORES);

    const taskStore = db.transaction('agentTasks', 'readonly').objectStore('agentTasks');
    expect([...taskStore.indexNames]).toEqual([
      'conversationId_updatedAt',
      'projectId_updatedAt',
      'status',
    ]);
    const memoryStore = db.transaction('projectMemories', 'readonly').objectStore('projectMemories');
    expect([...memoryStore.indexNames]).toEqual(['conversationId', 'projectId_updatedAt']);
    const visualStore = db.transaction('projectVisualDescriptions', 'readonly')
      .objectStore('projectVisualDescriptions');
    expect([...visualStore.indexNames]).toEqual(['projectId_fingerprint', 'projectId_updatedAt']);
    const historyStore = db.transaction('history', 'readonly').objectStore('history');
    expect([...historyStore.indexNames]).toEqual([
      'nodeId',
      'projectId_nodeId',
      'projectId_timestamp_id',
      'timestamp_id',
    ]);
    expect(await service.getAllProjects()).toEqual([{
      id: 'project-fresh',
      name: 'Fresh project',
      createdAt: 1,
      updatedAt: 1,
    }]);
    db.close();
  });

  it('upgrades an old database without losing existing project data', async () => {
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 8);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('projects', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = oldDb.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({
        id: 'legacy-project',
        name: 'Legacy project',
        createdAt: 1,
        updatedAt: 2,
        settings: {
          visualStyle: {
            styleName: '旧风格',
            styleReference: {
              assetId: 'style-asset',
              relativePath: 'styles/reference.png',
              filePath: 'G:/legacy/reference.png',
              imageUrl: 'data:image/png;base64,AAAA',
            },
          },
        },
        nodes: [{ id: 'legacy-node' }],
        edges: [],
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    oldDb.close();

    const service = await import('../../src/services/indexedDbService');
    const projects = await service.getAllProjects();

    expect(projects).toEqual([{
      id: 'legacy-project',
      name: 'Legacy project',
      createdAt: 1,
      updatedAt: 2,
      settings: {
        visualStyle: {
          styleName: '旧风格',
          styleReference: {
            assetId: 'style-asset',
            relativePath: 'styles/reference.png',
          },
        },
      },
    }]);
    expect(await service.getProjectById('legacy-project')).toEqual(expect.objectContaining({
      id: 'legacy-project',
      nodes: [{ id: 'legacy-node' }],
      settings: expect.objectContaining({
        visualStyle: expect.objectContaining({
          styleReference: expect.objectContaining({
            filePath: 'G:/legacy/reference.png',
            imageUrl: 'data:image/png;base64,AAAA',
          }),
        }),
      }),
    }));
    const upgradedDb = await openDatabase(DB_NAME);
    const { DB_VERSION } = await import('../../src/services/indexedDb/schema');
    expect(upgradedDb.version).toBe(DB_VERSION);
    expect([...upgradedDb.objectStoreNames]).toEqual(EXPECTED_STORES);
    upgradedDb.close();
  });

  it('persists and removes global character cards', async () => {
    const service = await import('../../src/services/indexedDbService');
    const card = {
      kind: 'character' as const,
      id: 'global-character',
      key: '全局角色',
      name: '全局角色',
      summary: '简介',
      visualNotes: '外形',
      identity: '身份',
      importance: 'main' as const,
      confirmed: true,
      createdAt: 1,
      updatedAt: 2,
      source: 'manual' as const,
      referenceImages: [],
    };

    await service.putGlobalCharacter(card);
    expect(await service.getAllGlobalCharacters()).toEqual([card]);

    await service.deleteGlobalCharacter('global-character');
    expect(await service.getAllGlobalCharacters()).toEqual([]);
  });

  it('removes cached visual descriptions with project domain data', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.saveProjectToDb({
      id: 'project-visual',
      name: 'Visual project',
      createdAt: 1,
      updatedAt: 1,
      nodes: [],
      edges: [],
    });
    await service.putProjectVisualDescription({
      id: 'project-visual:fingerprint',
      projectId: 'project-visual',
      fingerprint: 'fingerprint',
      description: '一张图片',
      modelId: 'general/vision',
      promptVersion: 'visual-description/v1',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    });

    await service.deleteProjectFromDb('project-visual');

    expect(await service.getProjectVisualDescription('project-visual', 'fingerprint'))
      .toBeUndefined();
    expect(await service.getAllProjects()).toEqual([]);
  });

  it('deletes only the selected project replica jobs while preserving other project metadata', async () => {
    const service = await import('../../src/services/indexedDbService');
    const { openDB } = await import('../../src/services/indexedDb/schema');
    await service.saveProjectToDb({ id: 'replica-project', name: '复刻项目', createdAt: 1, updatedAt: 1, nodes: [], edges: [] });
    const db = await openDB();
    const records = [
      { id: 'video-replica-jobs:replica-project', jobs: [{ jobId: 'video-replica-current' }] },
      { id: 'video-replica-jobs:other-project', jobs: [{ jobId: 'video-replica-other' }] },
      { id: 'video-batches:replica-project', batches: ['batch'] },
      { id: 'unrelated-metadata', value: { retained: true } },
    ];
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('metadata', 'readwrite');
      for (const record of records) transaction.objectStore('metadata').put(record);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    await service.deleteProjectFromDb('replica-project');
    expect(await readRecord(db, 'metadata', records[0].id)).toBeUndefined();
    expect(await readRecord(db, 'metadata', records[2].id)).toBeUndefined();
    expect(await readRecord(db, 'metadata', records[1].id)).toEqual(records[1]);
    expect(await readRecord(db, 'metadata', records[3].id)).toEqual(records[3]);
  });
});
