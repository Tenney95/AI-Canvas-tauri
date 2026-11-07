/** P6 前置演练：真实fixture IDB/适配/迁移/业务仓储；仅原生备份I/O与租约使用内存替身。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory as FixtureIDBFactory, IDBKeyRange as FixtureIDBKeyRange, IDBObjectStore as FixtureIDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectModelBackupPort } from '../../src/services/projectModelBackup';
import type { ProjectModelDurableBackupSeal, ProjectModelMaintenanceLease } from '../../src/services/projectModelNativeSafety';
import type { ProjectModelStagingJournal } from '../../src/types/projectModelJournal';

const native = vi.hoisted(() => ({
  getLease: vi.fn<() => Promise<ProjectModelMaintenanceLease>>(),
  verifyLease: vi.fn<(id: string) => Promise<ProjectModelMaintenanceLease>>(),
  create: vi.fn<(id: string, operationId: string) => Promise<ProjectModelBackupPort>>(),
  open: vi.fn<(id: string, operationId: string) => Promise<ProjectModelBackupPort>>(),
  seal: vi.fn<(id: string, operationId: string) => Promise<ProjectModelDurableBackupSeal>>(),
  verifySeal: vi.fn<(id: string, operationId: string) => Promise<ProjectModelDurableBackupSeal>>(),
}));
vi.mock('../../src/services/projectModelNativeSafety', () => ({
  getProjectModelMaintenanceLease: native.getLease, verifyProjectModelMaintenanceLease: native.verifyLease,
  createNativeProjectModelBackupPort: native.create, openNativeProjectModelBackupPort: native.open,
  sealNativeProjectModelBackup: native.seal, verifyNativeProjectModelBackupSeal: native.verifySeal,
}));

import { readLegacyMigrationSnapshot } from '../../src/services/indexedDb/projectModelMigrationRepository';
import { createLegacyProjectRepository } from '../../src/services/indexedDb/projectRepository';
import { readVerifiedProjectModelBackup } from '../../src/services/projectModelBackup';
import { stageProjectModelFixture, rollbackProjectModelFixtureStaging, PROJECT_MODEL_STAGING_CAPABILITIES } from '../../src/services/projectModelStaging';
import { beginProjectModelFixtureBusinessSession, createProjectModelBusinessRepository } from '../../src/services/indexedDb/projectModelBusinessRepository';
import { assertLegacyProjectWritesAllowed } from '../../src/services/indexedDb/legacyProjectWriteGuard';
import { PROJECT_MODEL_PREPARATION_CAPABILITIES } from '../../src/services/projectModelMigration';
import { PROJECT_ARCHIVE_V4_CONTRACT } from '../../src/types/projectArchiveV4';
import { PROJECT_MODEL_GENERATION_STORES, PROJECT_MODEL_SOURCE_FREEZE_KEY } from '../../src/types/projectModelJournal';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';

const profileId = 'p6-lifecycle', databaseName = `ai-canvas-model-fixture-${profileId}`;
const lease: ProjectModelMaintenanceLease = { leaseId: 'p6-memory-native-lease', profileId,
  mode: 'isolated-fixture', coldStart: true, productionAllowed: false };
const originalQueue = '[{"projectId":"E1","nodeId":"old-node","taskId":"paid-old","submitted":true,"mediaRecoveryState":"submit_unknown"}]';
const records = [
  { id: 'P', name: '普通旧项目', createdAt: 1, updatedAt: 2, dataFolder: 'ordinary-root',
    nodes: [{ id: 'P-node', data: { type: 'source-text', text: '普通旧画布' } }], edges: [], episodeOutline: '普通旧大纲', episodeScript: '普通旧稿' },
  { id: 'S', name: '两集旧剧集', createdAt: 1, updatedAt: 2, dataFolder: 'series-root', nodes: [], edges: [], series: { script: '共享全剧稿' } },
  { id: 'E1', parentId: 'S', name: '第一集', episodeNo: 1, createdAt: 1, updatedAt: 2, dataFolder: 'series-root',
    nodes: [{ id: 'E1-node', data: { type: 'source-text', text: '第一集画布' } }], edges: [], episodeOutline: '第一集大纲', episodeScript: '第一集原稿' },
  { id: 'E2', parentId: 'S', name: '第二集', episodeNo: 2, createdAt: 1, updatedAt: 2, dataFolder: 'series-root',
    nodes: [{ id: 'E2-node', data: { type: 'source-text', text: '第二集画布' } }], edges: [], episodeScript: '第二集原稿' },
];
let factory: IDBFactory, queue: string;
const storage = { getItem: () => queue };
const backups = new Map<string, Map<string, Uint8Array>>(), seals = new Map<string, ProjectModelDurableBackupSeal>();
const input = (operationId: string) => ({ databaseName, operationId, generation: 1, batchSize: 1, factory, localStorage: storage });

function backupPort(operationId: string, writable = false): ProjectModelBackupPort {
  const entries = backups.get(operationId); if (!entries) throw new Error('fixture backup missing');
  const write = async (path: string, bytes: Uint8Array) => {
    if (!writable || entries.has(path)) throw new Error('fixture backup is exclusive/read-only');
    entries.set(path, Uint8Array.from(bytes));
  };
  return { writeExclusive: write, publishComplete: write, read: async (path, maxBytes) => {
    const bytes = entries.get(path); if (!bytes || bytes.byteLength > maxBytes) throw new Error('fixture backup unreadable');
    return Uint8Array.from(bytes);
  } };
}
async function open(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, version);
    request.onupgradeneeded = () => {
      for (const name of ['projects', 'metadata', 'agentTasks', 'chatConversations', 'chatMessages', 'projectMemories']) request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function write(database: IDBDatabase, store: string, values: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readwrite'); for (const value of values) tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
async function all<T = Record<string, unknown>>(database: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readonly'), request = tx.objectStore(store).getAll();
    tx.oncomplete = () => resolve(request.result as T[]); tx.onabort = () => reject(tx.error);
  });
}
async function journal(database: IDBDatabase, operationId: string): Promise<ProjectModelStagingJournal> {
  const value = (await all<ProjectModelStagingJournal>(database, 'projectModelMigrations')).find((entry) => entry.operationId === operationId);
  if (!value) throw new Error('fixture journal missing'); return value;
}
async function targetRows(database: IDBDatabase) {
  return Object.fromEntries(await Promise.all(PROJECT_MODEL_GENERATION_STORES.map(async (name) => [name, await all(database, name)])));
}

beforeEach(async () => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', FixtureIDBKeyRange);
  factory = new FixtureIDBFactory(); queue = originalQueue; backups.clear(); seals.clear();
  native.getLease.mockResolvedValue(lease); native.verifyLease.mockResolvedValue(lease);
  native.create.mockImplementation(async (_id, operationId) => {
    if (backups.has(operationId)) throw new Error('fixture operation already has a backup');
    backups.set(operationId, new Map()); return backupPort(operationId, true);
  });
  native.open.mockImplementation(async (_id, operationId) => backupPort(operationId));
  native.seal.mockImplementation(async (_id, operationId) => {
    const entries = backups.get(operationId)!;
    const receipt: ProjectModelDurableBackupSeal = { format: 'project-model-durable-seal-v1', operationId, profileId,
      manifestSha256: await sha256BytesHex(entries.get('manifest.json')!), completeSha256: await sha256BytesHex(entries.get('complete.json')!),
      durability: 'fsync-and-directory-barrier', canActivate: false };
    seals.set(operationId, receipt); return receipt;
  });
  native.verifySeal.mockImplementation(async (_id, operationId) => {
    const seal = seals.get(operationId); if (!seal) throw new Error('fixture seal missing'); return seal;
  });
  const database = await open(27);
  try {
    await write(database, 'projects', records);
    await write(database, 'agentTasks', [{ id: 'paid-old', projectId: 'E1', status: 'paused', sequence: 7, toolCallCount: 3, budget: { maxToolCalls: 24 } }]);
    await write(database, 'metadata', [{ id: 'mcp-operation:old-key', bindingId: 'unchanged-idempotency-key', sequence: 7 }]);
    await write(database, 'chatConversations', [{ id: 'old-chat', projectId: 'E1', title: '旧会话', agentMode: 'plan' }]);
  } finally { database.close(); }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('P6 fixture迁移生命周期前置演练', () => {
  it('旧普通与多集经过真实备份、配额故障、原operation恢复和暂存回滚，较新回执/队列/其他代不倒退', async () => {
    const operationId = 'p6-resume-rollback', opening = vi.spyOn(factory, 'open');
    const before = await open();
    const source = await readLegacyMigrationSnapshot(before, { localStorage: storage });
    expect(source.complete).toBe(true);
    const directory = createLegacyProjectRepository(before);
    expect((await directory.listEpisodes('S')).map((entry) => entry.id)).toEqual(['E1', 'E2']); before.close();
    const add = FixtureIDBObjectStore.prototype.add; let plannedWrites = 0;
    const quota = vi.spyOn(FixtureIDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (PROJECT_MODEL_GENERATION_STORES.includes(this.name as typeof PROJECT_MODEL_GENERATION_STORES[number]) && ++plannedWrites === 2) {
        throw new DOMException('isolated fixture quota', 'QuotaExceededError');
      }
      return add.apply(this, args);
    });
    await expect(stageProjectModelFixture(input(operationId))).rejects.toMatchObject({ code: 'staging-failed' }); quota.mockRestore();
    let database = await open(), failed: ProjectModelStagingJournal, partial: Awaited<ReturnType<typeof targetRows>>;
    try {
      failed = await journal(database, operationId); partial = await targetRows(database);
      expect(failed).toMatchObject({ stage: 'failed', failureCode: 'transaction-failed', nextRow: 1, activationAllowed: false });
      expect(Object.values(partial).flat()).toHaveLength(1);
      expect(await all(database, 'projects')).toEqual([...records].sort((a, b) => a.id.localeCompare(b.id)));
    } finally { database.close(); }
    const decoded = await readVerifiedProjectModelBackup(backupPort(operationId)); expect(decoded.source).toEqual(source.source);
    const entries = backups.get(operationId)!, manifest = Uint8Array.from(entries.get('manifest.json')!);
    const chunk = decoded.manifest.files.find((entry) => entry.kind === 'records')!.path, originalChunk = entries.get(chunk)!;
    entries.set(chunk, new TextEncoder().encode('[]'));
    await expect(stageProjectModelFixture({ ...input(operationId), resume: true })).rejects.toThrow();
    database = await open();
    try { expect(await targetRows(database)).toEqual(partial); expect(await journal(database, operationId)).toEqual(failed); }
    finally { database.close(); }
    entries.set(chunk, originalChunk);
    const complete = await stageProjectModelFixture({ ...input(operationId), resume: true });
    expect(complete).toMatchObject({ stage: 'ready', canActivate: false, canRestoreContent: false });
    expect(complete.stagedRows).toBe(complete.totalRows); expect(native.create).toHaveBeenCalledTimes(1); expect(native.seal).toHaveBeenCalledTimes(1);
    database = await open();
    const newer = { id: 'paid-new', projectId: 'E2', status: 'submit_unknown', sequence: 11, toolCallCount: 9 };
    try {
      const ready = await journal(database, operationId);
      expect(ready.rows).toEqual(failed.rows); expect(ready.sourceDigest).toBe(failed.sourceDigest);
      expect(ready.manifestDigest).toBe(failed.manifestDigest); expect(ready.sequence).toBeGreaterThan(failed.sequence);
      await write(database, 'agentTasks', [{ id: 'paid-old', projectId: 'E1', status: 'paused', sequence: 10, toolCallCount: 8 }, newer]);
      await write(database, 'metadata', [{ id: 'mcp-operation:old-key', bindingId: 'unchanged-idempotency-key', sequence: 10 }]);
      await write(database, 'projectRoots', [{ generation: 99, operationId: 'unrelated-operation', id: 'unrelated-root', name: '其他代' }]);
    } finally { database.close(); }
    queue = JSON.stringify([newer]);
    const rolled = await rollbackProjectModelFixtureStaging(input(operationId)); expect(rolled.stage).toBe('rolled_back');
    expect((await rollbackProjectModelFixtureStaging(input(operationId))).sequence).toBe(rolled.sequence);
    database = await open();
    try {
      expect(await all(database, 'projects')).toEqual([...records].sort((a, b) => a.id.localeCompare(b.id)));
      expect(await all(database, 'agentTasks')).toEqual([newer, { id: 'paid-old', projectId: 'E1', status: 'paused', sequence: 10, toolCallCount: 8 }].sort((a, b) => a.id.localeCompare(b.id)));
      expect((await all(database, 'metadata')).find((entry) => entry.id === 'mcp-operation:old-key')).toMatchObject({ sequence: 10 });
      expect((await all(database, 'metadata')).some((entry) => entry.id === PROJECT_MODEL_SOURCE_FREEZE_KEY || entry.id === 'activeDataModel')).toBe(false);
      expect(await all(database, 'projectRoots')).toEqual([{ generation: 99, operationId: 'unrelated-operation', id: 'unrelated-root', name: '其他代' }]);
      for (const store of PROJECT_MODEL_GENERATION_STORES.filter((name) => name !== 'projectRoots')) expect(await all(database, store)).toEqual([]);
      expect(database.version).toBe(28); // 撤暂存不伪称schema降级或旧二进制可重新打开。
    } finally { database.close(); }
    expect(queue).toBe(JSON.stringify([newer])); expect(entries.get('manifest.json')).toEqual(manifest);
    expect((await readVerifiedProjectModelBackup(backupPort(operationId))).source).toEqual(source.source);
    expect(opening.mock.calls.every(([name]) => name === databaseName)).toBe(true);
  });

  it('真实P3接管后拒绝P2回滚和旧写入，保根转换/删末集只动新模型工作稿', async () => {
    const operationId = 'p6-business-session'; await stageProjectModelFixture(input(operationId));
    const database = await open();
    try {
      const session = await beginProjectModelFixtureBusinessSession(database, { operationId, generation: 1, sessionId: 'p6-business-session' });
      const originalJournal = await journal(database, operationId);
      const business = createProjectModelBusinessRepository(database, session);
      expect((await business.listProjects()).map((entry) => entry.id)).toEqual(['P', 'S']);
      expect(await business.readProjectContent('S')).toMatchObject({ script: '共享全剧稿' });
      expect(await business.readEpisodeContent('S', 'E1')).toMatchObject({ script: '第一集原稿', outline: '第一集大纲' });
      expect(await business.readEpisodeContent('S', 'E2')).toMatchObject({ script: '第二集原稿' });
      const ordinary = (await business.readProject('P')).project, oldCanvas = await business.readCanvas('P', 'P');
      await business.convertStandaloneToSeries({ projectId: 'P', expectedProjectEpoch: ordinary.epoch, episodeId: 'P-first', name: '原画布第一集' });
      expect(await business.readCanvas('P', 'P')).toMatchObject({ id: oldCanvas.id, episodeId: 'P-first', nodes: oldCanvas.nodes });
      expect(await business.readEpisodeContent('P', 'P-first')).toMatchObject({ script: '普通旧稿', outline: '普通旧大纲' });
      for (const episodeId of ['E1', 'E2']) {
        const project = (await business.readProject('S')).project, episode = await business.readEpisode('S', episodeId), canvas = await business.readCanvas('S', episode.canvasId);
        await business.deleteEpisode({ projectId: 'S', expectedProjectEpoch: project.epoch, episodeId,
          expectedEpisodeRevision: episode.revision, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision });
      }
      expect(await business.openProject('S')).toMatchObject({ activeProjectId: 'S', activeCanvasId: null, contextKind: 'project' });
      expect(await business.listEpisodes('S')).toEqual([]); expect((await business.readProject('S')).project.kind).toBe('series');
      expect(await business.readProjectContent('S')).toMatchObject({ script: '共享全剧稿' });
      expect((await business.listProjects()).map((entry) => entry.id)).toEqual(['P', 'S']);
      const working = await targetRows(database), audit = await all(database, 'agentTasks');
      await expect(stageProjectModelFixture({ ...input(operationId), resume: true })).rejects.toMatchObject({ code: 'business-session-present' });
      await expect(rollbackProjectModelFixtureStaging(input(operationId))).rejects.toMatchObject({ code: 'business-session-present' });
      await expect(assertLegacyProjectWritesAllowed(database)).rejects.toThrow('旧项目写入已停止');
      expect(await targetRows(database)).toEqual(working); expect(await all(database, 'agentTasks')).toEqual(audit);
      expect(await journal(database, operationId)).toEqual(originalJournal);
      expect(await all(database, 'projects')).toEqual([...records].sort((a, b) => a.id.localeCompare(b.id)));
      expect(queue).toBe(originalQueue); expect((await all(database, 'metadata')).some((entry) => entry.id === 'activeDataModel')).toBe(false);
    } finally { database.close(); }
  });

  it('正式/任意数据库在打开或原生调用前拒绝，P6验证不启正式激活或v4运行', async () => {
    const opening = vi.spyOn(factory, 'open');
    for (const name of ['ai-canvas-db', 'other-database', 'ai-canvas-model-fixture-']) {
      await expect(stageProjectModelFixture({ ...input('p6-disabled'), databaseName: name })).rejects.toMatchObject({ code: 'production-disabled' });
      await expect(rollbackProjectModelFixtureStaging({ ...input('p6-disabled'), databaseName: name })).rejects.toMatchObject({ code: 'production-disabled' });
    }
    expect(opening).not.toHaveBeenCalled(); expect(native.getLease).not.toHaveBeenCalled(); expect(backups.size).toBe(0);
    expect(PROJECT_MODEL_STAGING_CAPABILITIES).toMatchObject({ productionMigration: false, automaticMigration: false, activation: false, restoreWrites: false });
    expect(PROJECT_MODEL_PREPARATION_CAPABILITIES).toMatchObject({ dataModel: 'legacy', activation: false, restoreWrites: false });
    expect(PROJECT_ARCHIVE_V4_CONTRACT.runtimeEnabled).toBe(false);
  });
});
