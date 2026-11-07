/** P2 隔离暂存/失败恢复/撤销材料；仅编写，本轮不运行。 */
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectModelStagingRepository, openProjectModelFixtureDatabase, projectModelSourceToken,
} from '../../src/services/indexedDb/projectModelStagingRepository';
import { readLegacyMigrationSnapshot } from '../../src/services/indexedDb/projectModelMigrationRepository';
import { PROJECT_MODEL_SOURCE_FREEZE_KEY } from '../../src/types/projectModelJournal';
import type { LegacyProjectRecord } from '../../src/types/projectMigration';
import { createProjectModelBackup, type ProjectModelBackupSource } from '../../src/services/projectModelBackup';
import { fingerprintProjectModelSource } from '../../src/services/projectModelSourceFingerprint';

const record = (id: string, fields: Partial<LegacyProjectRecord> = {}): LegacyProjectRecord => ({
  id, name: id, createdAt: 1, updatedAt: 2, nodes: [], edges: [], ...fields,
});
async function mutation(database: IDBDatabase, names: string[], run: (tx: IDBTransaction) => void) {
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(names, 'readwrite'); run(tx);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
async function all(database: IDBDatabase, name: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(name, 'readonly').objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function fixture(factory: IDBFactory, name: string, records: LegacyProjectRecord[]) {
  const original = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 27);
    request.onupgradeneeded = () => {
      for (const store of ['projects', 'metadata', 'agentTasks']) request.result.createObjectStore(store, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await mutation(original, ['projects', 'agentTasks', 'metadata'], (tx) => {
    for (const row of records) tx.objectStore('projects').add(row);
    tx.objectStore('agentTasks').add({ id: 'paid-task', projectId: records[0]?.id, status: 'submit_unknown',
      modelRounds: 4, toolCallCount: 8, receipt: 'existing-receipt' });
    tx.objectStore('metadata').add({ id: 'mcp-operation:old-key', sequence: 9, operationId: 'paid-operation' });
  });
  const captured = await readLegacyMigrationSnapshot(original, { localStorage: { getItem: () => '[]' } });
  expect(captured.complete).toBe(true); original.close();
  const database = await openProjectModelFixtureDatabase({ factory, name });
  const repository = createProjectModelStagingRepository(database);
  const prepare = async (source: ProjectModelBackupSource = captured.source) => {
    const checked = await createProjectModelBackup(source, { operationId: 'backup-one', createdAt: 0 });
    return repository.prepare({ operationId: 'migration-one', generation: 1, source,
      sourceDigest: await fingerprintProjectModelSource(checked.manifest),
      backupOperationId: 'backup-one', backupManifestDigest: 'b'.repeat(64), now: 10 });
  };
  return { database, repository, source: captured.source, prepare };
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('P2 隔离项目模型暂存仓储', () => {
  it('正式库及任意名称在打开前拒绝，缺失fixture中止建库，未来版本不降级', async () => {
    const factory = new IDBFactory();
    await expect(openProjectModelFixtureDatabase({ factory, name: 'ai-canvas-db' })).rejects.toThrow('fixture-only');
    await expect(openProjectModelFixtureDatabase({ factory, name: 'ai-canvas-model-fixture-' })).rejects.toThrow('fixture-only');
    await expect(openProjectModelFixtureDatabase({ factory, name: 'ai-canvas-model-fixture-missing' })).rejects.toThrow();
    expect(await factory.databases()).toEqual([]);
    const future = await new Promise<IDBDatabase>((resolve) => {
      const request = factory.open('ai-canvas-model-fixture-future', 29);
      request.onsuccess = () => resolve(request.result);
    });
    future.close();
    await expect(openProjectModelFixtureDatabase({ factory, name: 'ai-canvas-model-fixture-future' })).rejects.toThrow('future-source-schema');
    expect((await factory.databases())[0].version).toBe(29);
  });

  it('逐批journal可重开续接，保留旧ID/旧设置/多根文稿且仅到ready不激活', async () => {
    const factory = new IDBFactory(), name = 'ai-canvas-model-fixture-resume';
    const sample = await fixture(factory, name, [record('S'), record('E', { parentId: 'S', episodeNo: 1,
      dataFolder: '独立旧目录', episodeScript: '\uFEFF保留\r\n文稿', settings: { defaultModels: { image: 'model-old' } },
      nodes: [{ id: 'n', data: { text: '保留节点' } }] })]);
    const originalProjects = await all(sample.database, 'projects');
    const prepared = await sample.prepare();
    expect(prepared.stage).toBe('schema_ready');
    expect(await all(sample.database, 'metadata')).toContainEqual(expect.objectContaining({ id: PROJECT_MODEL_SOURCE_FREEZE_KEY, operationId: 'migration-one' }));
    const first = await sample.repository.stageNextBatch({ operationId: 'migration-one', batchSize: 1 });
    expect(first.nextRow).toBe(1); sample.database.close();
    const reopened = await openProjectModelFixtureDatabase({ factory, name });
    try {
      const repository = createProjectModelStagingRepository(reopened);
      let journal = (await repository.readJournal('migration-one'))!;
      expect(journal.nextRow).toBe(1);
      while (journal.nextRow < journal.rows.length) journal = await repository.stageNextBatch({ operationId: 'migration-one', batchSize: 2 });
      journal = await repository.verify({ operationId: 'migration-one' });
      expect(journal).toMatchObject({ stage: 'ready', activationAllowed: false, generation: 1 });
      expect(await all(reopened, 'episodes')).toContainEqual(expect.objectContaining({ id: 'E', projectId: 'S',
        settingsPolicy: { mode: 'legacy-pinned', snapshot: { defaultModels: { image: 'model-old' } } }, epoch: 1 }));
      expect(await all(reopened, 'episodeContents')).toContainEqual(expect.objectContaining({ episodeId: 'E', script: '\uFEFF保留\r\n文稿', storageRootRef: 'legacy-root:S' }));
      expect(await all(reopened, 'canvasDocuments')).toContainEqual(expect.objectContaining({ id: 'E', storageRootRef: 'legacy-root:E' }));
      expect(await all(reopened, 'projects')).toEqual(originalProjects);
      expect((await all(reopened, 'metadata')).some((row) => (row as { id: string }).id === 'activeDataModel')).toBe(false);
    } finally { reopened.close(); }
  });

  it('批次事务中断不留下半批，journal保留位置且可继续；取消不修改来源', async () => {
    const sample = await fixture(new IDBFactory(), 'ai-canvas-model-fixture-failure', [record('P')]);
    try {
      await sample.prepare();
      const realAdd = IDBObjectStore.prototype.add;
      const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === 'projectContents') throw new DOMException('fixture quota', 'QuotaExceededError');
        return realAdd.apply(this, args);
      });
      await expect(sample.repository.stageNextBatch({ operationId: 'migration-one', batchSize: 50 })).rejects.toThrow();
      spy.mockRestore();
      expect(await all(sample.database, 'canvasDocuments')).toEqual([]);
      const failure = await sample.repository.readJournal('migration-one');
      expect(failure).toMatchObject({ stage: 'failed', failureCode: 'transaction-failed', nextRow: 0 });
      const controller = new AbortController(); controller.abort();
      await expect(sample.repository.stageNextBatch({ operationId: 'migration-one', signal: controller.signal })).rejects.toThrow();
      expect((await sample.repository.readJournal('migration-one'))?.nextRow).toBe(0);
      const staged = await sample.repository.stageNextBatch({ operationId: 'migration-one' });
      expect(staged.nextRow).toBe(staged.rows.length);
      expect((await sample.repository.verify({ operationId: 'migration-one' })).stage).toBe('ready');
      expect(await all(sample.database, 'projects')).toEqual([record('P')]);
    } finally { sample.database.close(); }
  });

  it('源变化终止操作，后续重试不能降级错误；撤销只删自己的未激活行', async () => {
    const sample = await fixture(new IDBFactory(), 'ai-canvas-model-fixture-source', [record('P')]);
    try {
      await sample.prepare(); await sample.repository.stageNextBatch({ operationId: 'migration-one', batchSize: 1 });
      await mutation(sample.database, ['projects'], (tx) => tx.objectStore('projects').put(record('P', { name: '后来的编辑' })));
      await expect(sample.repository.stageNextBatch({ operationId: 'migration-one' })).rejects.toThrow('source-changed');
      await sample.repository.markFailed({ operationId: 'migration-one', code: 'transaction-failed' });
      expect(await sample.repository.readJournal('migration-one')).toMatchObject({ stage: 'failed', failureCode: 'source-changed' });
      const auditBefore = await all(sample.database, 'agentTasks');
      const rolledBack = await sample.repository.rollback({ operationId: 'migration-one' });
      expect(rolledBack.stage).toBe('rolled_back');
      expect(await all(sample.database, 'canvasDocuments')).toEqual([]);
      expect(await all(sample.database, 'projects')).toEqual([record('P', { name: '后来的编辑' })]);
      expect(await all(sample.database, 'agentTasks')).toEqual(auditBefore);
      expect(await all(sample.database, 'metadata')).toEqual([{ id: 'mcp-operation:old-key', sequence: 9, operationId: 'paid-operation' }]);
      expect(await sample.repository.rollback({ operationId: 'migration-one' })).toEqual(rolledBack);
      expect(await all(sample.database, 'projectModelMigrations')).toHaveLength(1);
    } finally { sample.database.close(); }
  });

  it('校验拒绝多行/篡改；已有激活标记阻止撤销而不是覆盖当前代', async () => {
    const sample = await fixture(new IDBFactory(), 'ai-canvas-model-fixture-verify', [record('P')]);
    try {
      await sample.prepare(); await sample.repository.stageNextBatch({ operationId: 'migration-one' });
      await mutation(sample.database, ['canvasPreviews'], (tx) => tx.objectStore('canvasPreviews').put({
        generation: 1, canvasId: 'unexpected', operationId: 'migration-one', snapshot: 'extra', updatedAt: 3,
      }));
      await expect(sample.repository.verify({ operationId: 'migration-one' })).rejects.toThrow('verification-failed');
      expect(await sample.repository.readJournal('migration-one')).toMatchObject({ stage: 'failed', failureCode: 'verification-failed' });
      await mutation(sample.database, ['metadata'], (tx) => tx.objectStore('metadata').put({ id: 'activeDataModel', modelVersion: 2, generation: 1 }));
      await expect(sample.repository.rollback({ operationId: 'migration-one' })).rejects.toThrow('active-model-present');
      expect(await all(sample.database, 'canvasPreviews')).toHaveLength(1);
    } finally { sample.database.close(); }
  });

  it('坏旧链整项隔离、保留原始材料，不把健康子集或空项目当迁移成功', async () => {
    const sample = await fixture(new IDBFactory(), 'ai-canvas-model-fixture-quarantine', [record('E', { parentId: 'missing' })]);
    try {
      const prepared = await sample.prepare();
      expect(prepared).toMatchObject({ stage: 'quarantined', quarantinedRecordIds: ['E'], nextRow: 0 });
      await expect(sample.repository.stageNextBatch({ operationId: 'migration-one' })).rejects.toThrow('stage-not-resumable');
      expect((await sample.repository.readJournal('migration-one'))?.stage).toBe('quarantined');
      expect(await all(sample.database, 'projects')).toEqual([record('E', { parentId: 'missing' })]);
      expect(await all(sample.database, 'projectRoots')).toEqual([]);
      await sample.repository.rollback({ operationId: 'migration-one' });
    } finally { sample.database.close(); }
  });

  it('同步原值比较区分undefined/稀疏数组/二进制，无法同步核对Blob时失败关闭', () => {
    expect(projectModelSourceToken({ a: undefined })).not.toBe(projectModelSourceToken({}));
    expect(projectModelSourceToken(Array(1))).not.toBe(projectModelSourceToken([undefined]));
    expect(projectModelSourceToken(new Uint8Array([1, 2]))).not.toBe(projectModelSourceToken(new Uint8Array([1, 3])));
    expect(() => projectModelSourceToken(new Blob(['byte']))).toThrow('unsupported-source-type');
  });

  it('低层prepare不能绕过备份敏感字段校验把凭据写入journal', async () => {
    const sample = await fixture(new IDBFactory(), 'ai-canvas-model-fixture-secret', [record('P')]);
    try {
      const source = structuredClone(sample.source);
      const tasks = source.stores.find((store) => store.name === 'agentTasks')!;
      tasks.records[0].value = { id: 'paid-task', apiKey: 'fixture-secret-never-persist' };
      await expect(sample.repository.prepare({ operationId: 'migration-one', generation: 1, source,
        sourceDigest: 'a'.repeat(64), backupOperationId: 'backup-one', backupManifestDigest: 'b'.repeat(64) })).rejects.toThrow();
      expect(await all(sample.database, 'projectModelMigrations')).toEqual([]);
      expect((await all(sample.database, 'metadata')).some((row) => (row as { id: string }).id === PROJECT_MODEL_SOURCE_FREEZE_KEY)).toBe(false);
    } finally { sample.database.close(); }
  });

  it('关联回执也在批次原子事务中守卫，受损journal不能将目标表改成旧projects', async () => {
    const sample = await fixture(new IDBFactory(), 'ai-canvas-model-fixture-guard', [record('P')]);
    try {
      const prepared = await sample.prepare();
      await mutation(sample.database, ['agentTasks'], (tx) => tx.objectStore('agentTasks').put({
        id: 'paid-task', projectId: 'P', status: 'confirmed', modelRounds: 5, toolCallCount: 9, receipt: 'new-receipt',
      }));
      await expect(sample.repository.stageNextBatch({ operationId: 'migration-one' })).rejects.toThrow('source-changed');
      expect(await all(sample.database, 'projectRoots')).toEqual([]);
      await sample.repository.rollback({ operationId: 'migration-one' });
      const tasks = await all(sample.database, 'agentTasks');
      expect(tasks).toContainEqual(expect.objectContaining({ receipt: 'new-receipt', modelRounds: 5 }));
      await mutation(sample.database, ['projectModelMigrations'], (tx) => tx.objectStore('projectModelMigrations').put({
        ...prepared, rows: prepared.rows.map((row, index) => index === 0 ? { ...row, store: 'projects' } : row),
      }));
      await expect(sample.repository.stageNextBatch({ operationId: 'migration-one' })).rejects.toThrow('invalid-journal');
      expect(await all(sample.database, 'projects')).toEqual([record('P')]);
      expect(await all(sample.database, 'agentTasks')).toEqual(tasks);
    } finally { sample.database.close(); }
  });
});
