/** P2 仅隔离样本的显式迁移编排；正式库、自动激活和内容回滚均无入口。 */
import { isProjectModelFixtureDatabaseName } from '../types/projectModelJournal';
import { PROJECT_MODEL_BUSINESS_FIXTURE_KEY } from '../types/projectModelBusiness';
import type { ProjectModelStagingJournal } from '../types/projectModelJournal';
import type { LegacyProjectRecord } from '../types/projectMigration';
import {
  openExistingProjectDatabase, readLegacyMigrationSnapshot,
} from './indexedDb/projectModelMigrationRepository';
import {
  createProjectModelStagingRepository, openProjectModelFixtureDatabase,
  projectModelSourceToken, assertProjectModelStagingRollbackPlan,
} from './indexedDb/projectModelStagingRepository';
import {
  createProjectModelBackup, readVerifiedProjectModelBackup, writeVerifiedProjectModelBackup,
  PROJECT_MODEL_BACKUP_LIMITS,
  type ProjectModelBackupSource, type VerifiedProjectModelBackup,
} from './projectModelBackup';
import {
  createNativeProjectModelBackupPort, openNativeProjectModelBackupPort,
  getProjectModelMaintenanceLease, verifyProjectModelMaintenanceLease,
  sealNativeProjectModelBackup, verifyNativeProjectModelBackupSeal,
  type ProjectModelMaintenanceLease,
} from './projectModelNativeSafety';
import { projectLegacyRecords } from './projectModelCompatibility';
import { fingerprintProjectModelSource } from './projectModelSourceFingerprint';
import { sha256BytesHex } from './mediaDataUrl';

export const PROJECT_MODEL_STAGING_CAPABILITIES = Object.freeze({
  productionMigration: false, automaticMigration: false, activation: false,
  restoreWrites: false, fixtureStagingOnly: true,
} as const);

type FailureCode = 'production-disabled' | 'invalid-context' | 'backup-mismatch'
  | 'source-changed' | 'incomplete-source' | 'cancelled' | 'staging-failed' | 'business-session-present';
export class ProjectModelStagingError extends Error {
  readonly code: FailureCode;
  readonly operationId?: string;
  constructor(code: FailureCode, operationId?: string) {
    super('项目模型隔离暂存未完成：' + code);
    this.code = code;
    this.operationId = operationId;
    this.name = code === 'cancelled' ? 'AbortError' : 'ProjectModelStagingError';
  }
}

export interface ProjectModelFixtureStagingInput {
  databaseName: string;
  operationId: string;
  generation: number;
  /** 继续同一个操作，绝不在恢复时重发ID或覆盖备份。 */
  resume?: boolean;
  batchSize?: number;
  signal?: AbortSignal;
  factory?: IDBFactory;
  localStorage?: Pick<Storage, 'getItem'> | null;
}
export interface ProjectModelFixtureStagingReport {
  operationId: string;
  generation: number;
  stage: ProjectModelStagingJournal['stage'];
  sequence: number;
  stagedRows: number;
  totalRows: number;
  quarantinedRecordIds: string[];
  durability: 'fsync-and-directory-barrier';
  quiescence: 'native-exclusive-fixture-profile';
  canActivate: false;
  canRestoreContent: false;
}

function assertInput(input: ProjectModelFixtureStagingInput): void {
  // 第一条判断在任何本地库/文件/IPC调用之前执行，不能传DB_NAME或自定义任意库。
  if (!isProjectModelFixtureDatabaseName(input.databaseName)) throw new ProjectModelStagingError('production-disabled');
  if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.operationId)
    || !Number.isSafeInteger(input.generation) || input.generation < 1 || input.generation >= Number.MAX_SAFE_INTEGER
    || input.resume !== undefined && typeof input.resume !== 'boolean'
    || input.batchSize !== undefined && (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500)) {
    throw new ProjectModelStagingError('invalid-context');
  }
  input.signal?.throwIfAborted();
}

function assertLease(lease: ProjectModelMaintenanceLease, databaseName: string): void {
  if (lease.mode !== 'isolated-fixture' || lease.coldStart !== true || lease.productionAllowed !== false
    || databaseName !== 'ai-canvas-model-fixture-' + lease.profileId) {
    throw new ProjectModelStagingError('invalid-context');
  }
}

function assertPendingQueueCurrent(input: ProjectModelFixtureStagingInput, backup: VerifiedProjectModelBackup): void {
  input.signal?.throwIfAborted();
  try {
    const storage = input.localStorage === undefined ? globalThis.localStorage : input.localStorage;
    if (!storage || storage.getItem('ai_canvas_pending_tasks') !== backup.source.localStorage[0].value) {
      throw new ProjectModelStagingError('source-changed', input.operationId);
    }
  } catch (error) {
    if (error instanceof ProjectModelStagingError) throw error;
    throw new ProjectModelStagingError('incomplete-source', input.operationId);
  }
}

async function inspectDurableBackup(lease: ProjectModelMaintenanceLease, operationId: string,
  signal?: AbortSignal): Promise<{ backup: VerifiedProjectModelBackup; manifestDigest: string; sourceDigest: string }> {
  signal?.throwIfAborted();
  const seal = await verifyNativeProjectModelBackupSeal(lease.leaseId, operationId);
  const port = await openNativeProjectModelBackupPort(lease.leaseId, operationId);
  const backup = await readVerifiedProjectModelBackup(port, { signal });
  const manifestDigest = await sha256BytesHex(await port.read('manifest.json', PROJECT_MODEL_BACKUP_LIMITS.maxManifestBytes));
  signal?.throwIfAborted();
  if (backup.manifest.format !== 'project-model-backup-v1' || backup.manifest.operationId !== operationId || seal.operationId !== operationId
    || seal.profileId !== lease.profileId || seal.manifestSha256 !== manifestDigest
    || seal.durability !== 'fsync-and-directory-barrier' || seal.canActivate !== false
    || backup.source.databaseName !== 'ai-canvas-model-fixture-' + lease.profileId) {
    throw new ProjectModelStagingError('backup-mismatch', operationId);
  }
  return { backup, manifestDigest, sourceDigest: await fingerprintProjectModelSource(backup.manifest) };
}

function projectionOf(source: ProjectModelBackupSource) {
  const store = source.stores.find((item) => item.name === 'projects');
  if (!store) throw new ProjectModelStagingError('incomplete-source');
  return projectLegacyRecords(store.records.map((item) => item.value as LegacyProjectRecord));
}

async function assertNoFixtureBusiness(database: IDBDatabase, operationId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('metadata', 'readonly');
    let present = false;
    const request = tx.objectStore('metadata').get(PROJECT_MODEL_BUSINESS_FIXTURE_KEY);
    request.onsuccess = () => { present = request.result !== undefined; };
    tx.oncomplete = () => present ? reject(new ProjectModelStagingError('business-session-present', operationId)) : resolve();
    tx.onabort = () => reject(new ProjectModelStagingError('staging-failed', operationId));
  });
}

/** 每一批重新核对完整旧IDB侧表与LS原串；原始projects还在批次事务内再次比较。 */
async function assertSourceCurrent(database: IDBDatabase, input: ProjectModelFixtureStagingInput,
  lease: ProjectModelMaintenanceLease, backup: VerifiedProjectModelBackup, sourceDigest: string, requireFrozen = false): Promise<void> {
  input.signal?.throwIfAborted();
  const proof = await verifyProjectModelMaintenanceLease(lease.leaseId);
  assertLease(proof, input.databaseName);
  if (proof.leaseId !== lease.leaseId) throw new ProjectModelStagingError('invalid-context', input.operationId);
  const snapshot = await readLegacyMigrationSnapshot(database, {
    localStorage: input.localStorage, signal: input.signal,
    fixtureSource: { schemaVersion: backup.source.schemaVersion, operationId: input.operationId,
      sourceDigest, generation: input.generation, requireFrozen },
  });
  if (!snapshot.complete) throw new ProjectModelStagingError('incomplete-source', input.operationId);
  const current = await createProjectModelBackup(snapshot.source, {
    operationId: input.operationId, createdAt: backup.manifest.createdAt, signal: input.signal,
  });
  if (await fingerprintProjectModelSource(current.manifest) !== sourceDigest) {
    throw new ProjectModelStagingError('source-changed', input.operationId);
  }
  // 异步编码/摘要之后再读一次原串；不让这段耗时掩盖队列变化。
  assertPendingQueueCurrent(input, backup);
  input.signal?.throwIfAborted();
}

function report(journal: ProjectModelStagingJournal): ProjectModelFixtureStagingReport {
  return {
    operationId: journal.operationId, generation: journal.generation, stage: journal.stage,
    sequence: journal.sequence, stagedRows: journal.nextRow, totalRows: journal.rows.length,
    quarantinedRecordIds: [...journal.quarantinedRecordIds], durability: 'fsync-and-directory-barrier',
    quiescence: 'native-exclusive-fixture-profile', canActivate: false, canRestoreContent: false,
  };
}

/** 不被startup/UI调用。fixture也必须先原生冷维护、耐久备份，随后才升级隔离库。 */
export async function stageProjectModelFixture(input: ProjectModelFixtureStagingInput): Promise<ProjectModelFixtureStagingReport> {
  assertInput(input);
  const lease = await getProjectModelMaintenanceLease();
  assertLease(lease, input.databaseName);
  let database: IDBDatabase | null = null;
  let repository: ReturnType<typeof createProjectModelStagingRepository> | undefined;
  try {
    if (!input.resume) {
      database = await openExistingProjectDatabase({ name: input.databaseName, factory: input.factory, signal: input.signal });
      if (!database) throw new ProjectModelStagingError('incomplete-source', input.operationId);
      const snapshot = await readLegacyMigrationSnapshot(database, { localStorage: input.localStorage, signal: input.signal });
      if (!snapshot.complete || !snapshot.source.stores.some((store) => store.name === 'metadata')) {
        throw new ProjectModelStagingError('incomplete-source', input.operationId);
      }
      const bundle = await createProjectModelBackup(snapshot.source, { operationId: input.operationId, signal: input.signal });
      const port = await createNativeProjectModelBackupPort(lease.leaseId, input.operationId);
      await writeVerifiedProjectModelBackup(bundle, port, { signal: input.signal });
      input.signal?.throwIfAborted();
      await sealNativeProjectModelBackup(lease.leaseId, input.operationId);
      database.close(); database = null;
    }
    // 每次继续都重新读回原备份和原生耐久seal，不信任UI上次显示的阶段。
    const checked = await inspectDurableBackup(lease, input.operationId, input.signal);
    // 无法在IDB事务内精确核对的来源类型先阻断，不能先升版再发现Blob等不支持。
    for (const store of checked.backup.source.stores) {
      input.signal?.throwIfAborted();
      for (const row of store.records) { projectModelSourceToken(row.key); projectModelSourceToken(row.value); }
    }
    database = await openProjectModelFixtureDatabase({ name: input.databaseName, factory: input.factory, signal: input.signal });
    await assertNoFixtureBusiness(database, input.operationId);
    repository = createProjectModelStagingRepository(database);
    await assertSourceCurrent(database, input, lease, checked.backup, checked.sourceDigest);
    let journal = await repository.prepare({ operationId: input.operationId, generation: input.generation,
      source: checked.backup.source, sourceDigest: checked.sourceDigest,
      backupOperationId: input.operationId, backupManifestDigest: checked.manifestDigest,
      projection: projectionOf(checked.backup.source) });
    input.signal?.throwIfAborted();
    if (journal.stage === 'quarantined' || journal.stage === 'rolled_back') return report(journal);
    // 持久阶段不是校验凭据：ready之后材料也可能损坏，重启继续必须重验目标集合。
    if (journal.stage === 'ready') journal = await repository.verify({ operationId: input.operationId, signal: input.signal });
    while (journal.stage !== 'ready') {
      await assertSourceCurrent(database, input, lease, checked.backup, checked.sourceDigest, true);
      if (journal.nextRow < journal.rows.length) {
        journal = await repository.stageNextBatch({ operationId: input.operationId, batchSize: input.batchSize, signal: input.signal });
      } else {
        journal = await repository.verify({ operationId: input.operationId, signal: input.signal });
      }
    }
    await assertSourceCurrent(database, input, lease, checked.backup, checked.sourceDigest, true);
    const finalLease = await verifyProjectModelMaintenanceLease(lease.leaseId);
    assertLease(finalLease, input.databaseName);
    if (finalLease.leaseId !== lease.leaseId) throw new ProjectModelStagingError('invalid-context', input.operationId);
    assertPendingQueueCurrent(input, checked.backup);
    return report(journal);
  } catch (error) {
    const cancelled = error instanceof Error && error.name === 'AbortError';
    if (repository && !cancelled) {
      try {
        await repository.markFailed({ operationId: input.operationId,
          code: error instanceof ProjectModelStagingError && ['source-changed', 'incomplete-source'].includes(error.code)
            ? 'source-changed' : 'transaction-failed' });
      } catch { /* 已提交journal是恢复权威；失败记录失败不能覆盖或猜测原阶段。 */ }
    }
    if (error instanceof ProjectModelStagingError) throw error;
    throw new ProjectModelStagingError(cancelled ? 'cancelled' : 'staging-failed', input.operationId);
  } finally { database?.close(); }
}

/** 只撤销本操作未激活暂存；不把旧快照写回projects、任务/回执或localStorage。 */
export async function rollbackProjectModelFixtureStaging(input: ProjectModelFixtureStagingInput): Promise<ProjectModelFixtureStagingReport> {
  assertInput(input);
  const lease = await getProjectModelMaintenanceLease();
  assertLease(lease, input.databaseName);
  const checked = await inspectDurableBackup(lease, input.operationId, input.signal);
  const database = await openExistingProjectDatabase({ name: input.databaseName, factory: input.factory,
    allowFixtureStaging: true, signal: input.signal });
  if (!database) throw new ProjectModelStagingError('incomplete-source', input.operationId);
  try {
    await assertNoFixtureBusiness(database, input.operationId);
    const repository = createProjectModelStagingRepository(database);
    const journal = await repository.readJournal(input.operationId);
    if (!journal || journal.generation !== input.generation) throw new ProjectModelStagingError('invalid-context', input.operationId);
    if (journal.backupOperationId !== input.operationId || journal.backupManifestDigest !== checked.manifestDigest
      || journal.sourceDigest !== checked.sourceDigest || journal.sourceSchemaVersion !== checked.backup.source.schemaVersion) {
      throw new ProjectModelStagingError('backup-mismatch', input.operationId);
    }
    try { await assertProjectModelStagingRollbackPlan(journal, projectionOf(checked.backup.source)); }
    catch { throw new ProjectModelStagingError('backup-mismatch', input.operationId); }
    const current = await verifyProjectModelMaintenanceLease(lease.leaseId);
    assertLease(current, input.databaseName);
    if (current.leaseId !== lease.leaseId) throw new ProjectModelStagingError('invalid-context', input.operationId);
    return report(await repository.rollback({ operationId: input.operationId, expected: journal, signal: input.signal }));
  } finally { database.close(); }
}
