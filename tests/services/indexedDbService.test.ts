import { IDBFactory } from 'fake-indexeddb';
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

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.resetModules();
});

describe('indexedDbService schema', () => {
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
