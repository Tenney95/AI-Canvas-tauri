import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DB_NAME = 'ai-canvas-db';
const EXPECTED_STORES = [
  'agentTasks',
  'assetIndex',
  'assetMeta',
  'assetMetaV2',
  'chatConversations',
  'chatMessages',
  'config',
  'globalCharacters',
  'history',
  'metadata',
  'plugins',
  'presets',
  'projectMemories',
  'projectSummaries',
  'projectVisualDescriptions',
  'projects',
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

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.resetModules();
});

describe('indexedDbService schema', () => {
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
    expect(transaction.mock.calls.at(-1)).toEqual([['projects', 'projectSummaries'], 'readwrite']);
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

  it('creates the complete v21 schema for a fresh database', async () => {
    const service = await import('../../src/services/indexedDbService');
    await service.saveProjectToDb({
      id: 'project-fresh',
      name: 'Fresh project',
      createdAt: 1,
      updatedAt: 1,
      nodes: [],
      edges: [],
    });

    const db = await openDatabase(DB_NAME);
    expect(db.version).toBe(21);
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
    expect(upgradedDb.version).toBe(21);
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
});
