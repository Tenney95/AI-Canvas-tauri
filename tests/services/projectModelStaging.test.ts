/** P2 隔离编排回归源。原生停写/耐久仅mock；不能替代Tauri验收，本轮未执行。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectModelBackupPort } from '../../src/services/projectModelBackup';
import type { ProjectModelDurableBackupSeal, ProjectModelMaintenanceLease } from '../../src/services/projectModelNativeSafety';
import type { ProjectModelStagingJournal } from '../../src/types/projectModelJournal';

const native = vi.hoisted(() => ({
  getLease: vi.fn<() => Promise<ProjectModelMaintenanceLease>>(),
  verifyLease: vi.fn<(leaseId: string) => Promise<ProjectModelMaintenanceLease>>(),
  createPort: vi.fn<(leaseId: string, operationId: string) => Promise<ProjectModelBackupPort>>(),
  openPort: vi.fn<(leaseId: string, operationId: string) => Promise<ProjectModelBackupPort>>(),
  seal: vi.fn<(leaseId: string, operationId: string) => Promise<ProjectModelDurableBackupSeal>>(),
  verifySeal: vi.fn<(leaseId: string, operationId: string) => Promise<ProjectModelDurableBackupSeal>>(),
}));
vi.mock('../../src/services/projectModelNativeSafety', () => ({
  getProjectModelMaintenanceLease: native.getLease,
  verifyProjectModelMaintenanceLease: native.verifyLease,
  createNativeProjectModelBackupPort: native.createPort,
  openNativeProjectModelBackupPort: native.openPort,
  sealNativeProjectModelBackup: native.seal,
  verifyNativeProjectModelBackupSeal: native.verifySeal,
}));

import {
  stageProjectModelFixture, rollbackProjectModelFixtureStaging, PROJECT_MODEL_STAGING_CAPABILITIES,
} from '../../src/services/projectModelStaging';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';
import { PROJECT_MODEL_SOURCE_FREEZE_KEY } from '../../src/types/projectModelJournal';

const profileId = 'staging-test';
const databaseName = 'ai-canvas-model-fixture-' + profileId;
const lease: ProjectModelMaintenanceLease = {
  leaseId: 'native-test-lease', profileId, mode: 'isolated-fixture', coldStart: true, productionAllowed: false,
};
let factory: IDBFactory;
let queue: string | null;
const localStorage = { getItem: () => queue };
const operations = new Map<string, Map<string, Uint8Array>>();
const seals = new Map<string, ProjectModelDurableBackupSeal>();
const project = (id: string) => ({ id, name: '旧项目' + id, createdAt: 1, updatedAt: 2,
  nodes: [{ id: 'node', data: { type: 'source-text', text: '保留中文稿件' } }], edges: [],
  episodeScript: '旧顶层文稿', dataFolder: 'folder-' + id });

function port(files: Map<string, Uint8Array>, readOnly: boolean): ProjectModelBackupPort {
  const write = async (path: string, bytes: Uint8Array) => {
    if (readOnly || files.has(path)) throw new Error('exclusive backup write rejected');
    files.set(path, Uint8Array.from(bytes));
  };
  return { writeExclusive: write, publishComplete: write, read: async (path, maxBytes) => {
    const bytes = files.get(path);
    if (!bytes || bytes.byteLength > maxBytes) throw new Error('backup unreadable');
    return Uint8Array.from(bytes);
  } };
}

beforeEach(async () => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto);
  factory = new IDBFactory(); queue = '[]'; operations.clear(); seals.clear();
  native.getLease.mockResolvedValue(lease); native.verifyLease.mockResolvedValue(lease);
  native.createPort.mockImplementation(async (_leaseId, operationId) => {
    if (operations.has(operationId)) throw new Error('backup operation already exists');
    const files = new Map<string, Uint8Array>(); operations.set(operationId, files);
    return port(files, false);
  });
  native.openPort.mockImplementation(async (_leaseId, operationId) => {
    const files = operations.get(operationId); if (!files) throw new Error('backup missing');
    return port(files, true);
  });
  native.seal.mockImplementation(async (_leaseId, operationId) => {
    const files = operations.get(operationId)!;
    const seal: ProjectModelDurableBackupSeal = {
      format: 'project-model-durable-seal-v1', operationId, profileId,
      manifestSha256: await sha256BytesHex(files.get('manifest.json')!),
      completeSha256: await sha256BytesHex(files.get('complete.json')!),
      durability: 'fsync-and-directory-barrier', canActivate: false,
    };
    seals.set(operationId, seal); return seal;
  });
  native.verifySeal.mockImplementation(async (_leaseId, operationId) => {
    const seal = seals.get(operationId); if (!seal) throw new Error('durable seal missing');
    return seal;
  });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 27);
    request.onupgradeneeded = () => {
      for (const name of ['projects', 'metadata', 'agentTasks']) request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try { await write(database, 'projects', [project('p'), project('q')]); } finally { database.close(); }
});
afterEach(() => vi.unstubAllGlobals());

async function databaseNow(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function write(database: IDBDatabase, store: string, rows: unknown[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, 'readwrite');
    for (const row of rows) transaction.objectStore(store).put(row);
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
  });
}
async function read<T>(database: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined); request.onerror = () => reject(request.error);
  });
}
function input(operationId: string) { return { databaseName, operationId, generation: 1, factory, localStorage, batchSize: 1 }; }

it.each(['ai-canvas-db', 'ai-canvas-model-fixture-', 'arbitrary-database'])('正式或任意库%s在IPC/文件前拒绝', async (name) => {
  const opening = vi.spyOn(factory, 'open');
  await expect(stageProjectModelFixture({ ...input('production-blocked'), databaseName: name }))
    .rejects.toMatchObject({ code: 'production-disabled' });
  expect(opening).not.toHaveBeenCalled(); expect(native.getLease).not.toHaveBeenCalled();
  expect(native.createPort).not.toHaveBeenCalled(); expect(operations.size).toBe(0);
  expect(PROJECT_MODEL_STAGING_CAPABILITIES).toMatchObject({ productionMigration: false, activation: false, restoreWrites: false });
});

it('原生备份失败不升级隔离旧库，也不改写旧项目或创建journal', async () => {
  native.createPort.mockRejectedValueOnce(new Error('disk quota'));
  await expect(stageProjectModelFixture(input('backup-fails'))).rejects.toMatchObject({ code: 'staging-failed' });
  const database = await databaseNow();
  try {
    expect(database.version).toBe(27); expect(database.objectStoreNames.contains('projectModelMigrations')).toBe(false);
    expect(await read(database, 'projects', 'p')).toEqual(project('p'));
    expect(await read(database, 'metadata', PROJECT_MODEL_SOURCE_FREEZE_KEY)).toBeUndefined();
    expect(native.seal).not.toHaveBeenCalled();
  } finally { database.close(); }
});

it('稳定批次后取消保留journal与原备份；显式同操作继续不重复发号或覆盖备份', async () => {
  const controller = new AbortController();
  let calls = 0;
  native.verifyLease.mockImplementation(async () => {
    if (++calls === 3) controller.abort();
    return lease;
  });
  await expect(stageProjectModelFixture({ ...input('resume-one'), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  const database = await databaseNow();
  let prior: ProjectModelStagingJournal;
  try {
    prior = (await read<ProjectModelStagingJournal>(database, 'projectModelMigrations', 'resume-one'))!;
    expect(prior.stage).toBe('staging'); expect(prior.nextRow).toBe(1);
    expect(await read(database, 'projects', 'p')).toEqual(project('p'));
    expect(await read(database, 'metadata', 'activeDataModel')).toBeUndefined();
  } finally { database.close(); }
  const manifest = Uint8Array.from(operations.get('resume-one')!.get('manifest.json')!);
  native.verifyLease.mockResolvedValue(lease);
  const report = await stageProjectModelFixture({ ...input('resume-one'), resume: true });
  expect(report).toMatchObject({ stage: 'ready', canActivate: false, canRestoreContent: false });
  expect(report.sequence).toBeGreaterThan(prior.sequence); expect(report.stagedRows).toBe(report.totalRows);
  expect(native.createPort).toHaveBeenCalledTimes(1); expect(native.seal).toHaveBeenCalledTimes(1);
  expect(operations.get('resume-one')!.get('manifest.json')).toEqual(manifest);
});

it.each(['side-store', 'local-storage'])('升级前备份后的%s变化拒绝暂存，不覆盖较新事实', async (domain) => {
  const receipt = { id: 'new-paid-task', projectId: 'p', sequence: 9, status: 'submit_unknown', budget: { toolCalls: 8 } };
  native.verifyLease.mockImplementationOnce(async () => {
    if (domain === 'local-storage') queue = JSON.stringify([receipt]);
    else {
      const database = await databaseNow();
      try { await write(database, 'agentTasks', [receipt]); } finally { database.close(); }
    }
    return lease;
  });
  await expect(stageProjectModelFixture(input('source-change'))).rejects.toMatchObject({ code: 'source-changed' });
  const database = await databaseNow();
  try {
    expect(await read(database, 'projects', 'p')).toEqual(project('p'));
    expect(await read(database, 'metadata', 'activeDataModel')).toBeUndefined();
    expect(await read(database, 'projectModelMigrations', 'source-change')).toBeUndefined();
    if (domain === 'side-store') expect(await read(database, 'agentTasks', receipt.id)).toEqual(receipt);
    else expect(queue).toBe(JSON.stringify([receipt]));
  } finally { database.close(); }
});

it('撤销仅删除本操作暂存，保留其他项目、后到付费回执和队列以及原备份', async () => {
  const report = await stageProjectModelFixture(input('rollback-one'));
  expect(report.stage).toBe('ready');
  const receipt = { id: 'paid-after-ready', projectId: 'p', sequence: 10, status: 'submitted', budget: { toolCalls: 9 } };
  const other = project('new-other');
  const inactive = { generation: 99, id: 'different-operation', operationId: 'different-op', name: '保留其他代' };
  const database = await databaseNow();
  try {
    await write(database, 'agentTasks', [receipt]); await write(database, 'projects', [other]);
    await write(database, 'projectRoots', [inactive]);
  } finally { database.close(); }
  queue = JSON.stringify([receipt]);
  const rolledBack = await rollbackProjectModelFixtureStaging(input('rollback-one'));
  expect(rolledBack).toMatchObject({ stage: 'rolled_back', canActivate: false });
  const current = await databaseNow();
  try {
    expect(await read(current, 'projects', 'p')).toEqual(project('p'));
    expect(await read(current, 'projects', 'q')).toEqual(project('q'));
    expect(await read(current, 'projects', other.id)).toEqual(other);
    expect(await read(current, 'agentTasks', receipt.id)).toEqual(receipt);
    expect(await read(current, 'projectRoots', [99, inactive.id])).toEqual(inactive);
    expect(await read(current, 'projectRoots', [1, 'p'])).toBeUndefined();
    expect(await read(current, 'metadata', PROJECT_MODEL_SOURCE_FREEZE_KEY)).toBeUndefined();
    expect(await read(current, 'metadata', 'activeDataModel')).toBeUndefined();
  } finally { current.close(); }
  expect(queue).toBe(JSON.stringify([receipt])); expect(operations.get('rollback-one')!.has('complete.json')).toBe(true);
  expect((await rollbackProjectModelFixtureStaging(input('rollback-one'))).sequence).toBe(rolledBack.sequence);
});

it('不接受相同前缀但与原生租约profile不同的目标库', async () => {
  native.getLease.mockResolvedValueOnce({ ...lease, profileId: 'other-profile' });
  const opening = vi.spyOn(factory, 'open');
  await expect(stageProjectModelFixture(input('wrong-native-profile'))).rejects.toMatchObject({ code: 'invalid-context' });
  expect(opening).not.toHaveBeenCalled(); expect(native.createPort).not.toHaveBeenCalled();
});

it('原生封印与实际manifest不一致时不升级旧库', async () => {
  native.verifySeal.mockImplementationOnce(async (_leaseId, operationId) => ({
    ...seals.get(operationId)!, manifestSha256: '0'.repeat(64),
  }));
  await expect(stageProjectModelFixture(input('wrong-seal'))).rejects.toMatchObject({ code: 'backup-mismatch' });
  const database = await databaseNow();
  try {
    expect(database.version).toBe(27); expect(await read(database, 'projects', 'p')).toEqual(project('p'));
    expect(database.objectStoreNames.contains('projectModelMigrations')).toBe(false);
  } finally { database.close(); }
});

it('最终原生停写复核期间取消不报告成功，也不把已提交ready批次倒退', async () => {
  const controller = new AbortController();
  let readyChecks = 0;
  native.verifyLease.mockImplementation(async () => {
    const database = await databaseNow();
    try {
      const journal = await read<ProjectModelStagingJournal>(database, 'projectModelMigrations', 'cancel-final-proof');
      if (journal?.stage === 'ready' && ++readyChecks === 2) controller.abort();
    } finally { database.close(); }
    return lease;
  });
  await expect(stageProjectModelFixture({ ...input('cancel-final-proof'), signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  const database = await databaseNow();
  try {
    const journal = await read<ProjectModelStagingJournal>(database, 'projectModelMigrations', 'cancel-final-proof');
    expect(journal).toMatchObject({ stage: 'ready', activationAllowed: false });
    expect(await read(database, 'metadata', 'activeDataModel')).toBeUndefined();
  } finally { database.close(); }
});

it('重启继续ready操作也重新核对暂存集合，不把丢失的目标行当成完整迁移', async () => {
  await stageProjectModelFixture(input('ready-row-missing'));
  const database = await databaseNow();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('projectRoots', 'readwrite');
      transaction.objectStore('projectRoots').delete([1, 'p']);
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
  await expect(stageProjectModelFixture({ ...input('ready-row-missing'), resume: true })).rejects.toThrow();
  const current = await databaseNow();
  try {
    expect(await read(current, 'projectModelMigrations', 'ready-row-missing'))
      .toMatchObject({ stage: 'failed', failureCode: 'verification-failed', activationAllowed: false });
    expect(await read(current, 'projects', 'p')).toEqual(project('p'));
    expect(await read(current, 'metadata', 'activeDataModel')).toBeUndefined();
    expect(operations.get('ready-row-missing')!.has('complete.json')).toBe(true);
  } finally { current.close(); }
});
