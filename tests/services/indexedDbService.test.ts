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
  'history',
  'metadata',
  'presets',
  'projectMemories',
  'projects',
  'skills',
  'styles',
  'toolbarLayouts',
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
  it('creates the complete v15 schema for a fresh database', async () => {
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
    expect(db.version).toBe(15);
    expect([...db.objectStoreNames]).toEqual(EXPECTED_STORES);

    const taskStore = db.transaction('agentTasks', 'readonly').objectStore('agentTasks');
    expect([...taskStore.indexNames]).toEqual([
      'conversationId_updatedAt',
      'projectId_updatedAt',
      'status',
    ]);
    const memoryStore = db.transaction('projectMemories', 'readonly').objectStore('projectMemories');
    expect([...memoryStore.indexNames]).toEqual(['conversationId', 'projectId_updatedAt']);
    const historyStore = db.transaction('history', 'readonly').objectStore('history');
    expect([...historyStore.indexNames]).toEqual([
      'nodeId',
      'projectId_nodeId',
      'projectId_timestamp_id',
      'timestamp_id',
    ]);
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
        nodes: [{ id: 'legacy-node' }],
        edges: [],
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    oldDb.close();

    const service = await import('../../src/services/indexedDbService');
    const projects = await service.getAllProjects();

    expect(projects).toEqual([
      expect.objectContaining({
        id: 'legacy-project',
        nodes: [{ id: 'legacy-node' }],
      }),
    ]);
    const upgradedDb = await openDatabase(DB_NAME);
    expect(upgradedDb.version).toBe(15);
    expect([...upgradedDb.objectStoreNames]).toEqual(EXPECTED_STORES);
    upgradedDb.close();
  });
});
