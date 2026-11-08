/** P2 隔离样本暂存器。正式库、正常 openDB 和 activeDataModel 均不在此处写入。 */
import { DB_VERSION } from './schema';
import { projectModelSourceToken } from '../projectModelComparisonMaterial';
export { projectModelSourceToken } from '../projectModelComparisonMaterial';
import { PROJECT_MODEL_BUSINESS_FIXTURE_KEY } from '../../types/projectModelBusiness';
import {
  isKnownExcludedProjectModelBackupMetadataKey,
  isProjectModelBackupMetadataKey, isProjectModelBackupStore,
} from './projectModelMigrationRepository';
import { projectLegacyRecords } from '../projectModelCompatibility';
import { sha256BytesHex } from '../mediaDataUrl';
import { createProjectModelBackup, type ProjectModelBackupSource } from '../projectModelBackup';
import { fingerprintProjectModelSource } from '../projectModelSourceFingerprint';
import type { LegacyProjectProjection, LegacyProjectRecord } from '../../types/projectMigration';
import {
  isProjectModelFixtureDatabaseName, PROJECT_MODEL_ACTIVE_MARKER_KEY,
  PROJECT_MODEL_GENERATION_STORES, PROJECT_MODEL_SOURCE_FREEZE_KEY, PROJECT_MODEL_STAGING_STORES,
  PROJECT_MODEL_STAGING_VERSION,
} from '../../types/projectModelJournal';
import type {
  ProjectModelGenerationStore, ProjectModelSourceFreeze, ProjectModelStagingJournal, ProjectModelStagingRow,
} from '../../types/projectModelJournal';

const journalStore = 'projectModelMigrations';
const keys: Record<typeof PROJECT_MODEL_STAGING_STORES[number], string | string[]> = {
  projectRoots: ['generation', 'id'], projectContents: ['generation', 'projectId'],
  episodes: ['generation', 'id'], episodeContents: ['generation', 'episodeId'],
  canvasDocuments: ['generation', 'id'], canvasPreviews: ['generation', 'canvasId'],
  legacyProjectBindings: ['generation', 'namespace', 'legacyId'],
  archiveHistoryBindings: ['destinationProjectId', 'sourceNamespace', 'kind', 'archiveOriginId'],
  projectModelMigrations: 'operationId',
};
const indexes: Partial<Record<typeof PROJECT_MODEL_STAGING_STORES[number], Record<string, string | string[]>>> = {
  episodes: { projectId_orderRank: ['generation', 'projectId', 'orderRank'] },
  canvasDocuments: { projectId: ['generation', 'projectId'], episodeId: ['generation', 'episodeId'] },
  legacyProjectBindings: { projectId: ['generation', 'projectId'], canvasId: ['generation', 'canvasId'] },
  projectModelMigrations: { generation: 'generation', stage: 'stage' },
};
const error = (code: string) => new Error('项目模型隔离暂存被阻止：' + code);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const digest = (value: string) => sha256BytesHex(new TextEncoder().encode(value));

function assertFixture(database: IDBDatabase): void {
  if (!isProjectModelFixtureDatabaseName(database.name) || database.version !== PROJECT_MODEL_STAGING_VERSION) throw error('fixture-only');
  const required = ['projects', 'metadata', ...PROJECT_MODEL_STAGING_STORES];
  if (required.some((name) => !database.objectStoreNames.contains(name))) throw error('missing-schema');
  const transaction = database.transaction(required, 'readonly');
  for (const name of PROJECT_MODEL_STAGING_STORES) {
    const store = transaction.objectStore(name);
    if (store.autoIncrement || JSON.stringify(store.keyPath) !== JSON.stringify(keys[name])) throw error('invalid-schema');
    const expected = indexes[name] ?? {};
    if (Array.from(store.indexNames).sort().join('\0') !== Object.keys(expected).sort().join('\0')) throw error('invalid-index');
    for (const [indexName, keyPath] of Object.entries(expected)) {
      const index = store.index(indexName);
      if (index.unique || index.multiEntry || JSON.stringify(index.keyPath) !== JSON.stringify(keyPath)) throw error('invalid-index');
    }
  }
}

/** 先只读打开确认存在；取消/blocked 后迟到的升级请求也不得建表。 */
export async function openProjectModelFixtureDatabase(options: {
  name: string; factory?: IDBFactory; signal?: AbortSignal;
}): Promise<IDBDatabase> {
  if (!isProjectModelFixtureDatabaseName(options.name)) throw error('fixture-only');
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) throw error('indexeddb-unavailable');
  options.signal?.throwIfAborted();
  const open = (version?: number): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    let settled = false;
    const fail = (failure: unknown) => {
      if (settled) return; settled = true;
      options.signal?.removeEventListener('abort', abort); reject(failure);
    };
    const abort = () => fail(new DOMException('隔离暂存已取消', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    let request: IDBOpenDBRequest;
    try { request = version === undefined ? factory.open(options.name) : factory.open(options.name, version); }
    catch { fail(error('open-failed')); return; }
    request.onupgradeneeded = (event) => {
      try {
        if (settled || options.signal?.aborted || event.oldVersion === 0 || version === undefined
          || event.oldVersion > DB_VERSION || !request.result.objectStoreNames.contains('projects')
          || !request.result.objectStoreNames.contains('metadata')) throw error('invalid-source-schema');
        for (const name of PROJECT_MODEL_STAGING_STORES) {
          if (request.result.objectStoreNames.contains(name)) throw error('schema-collision');
          const store = request.result.createObjectStore(name, { keyPath: keys[name] });
          for (const [indexName, keyPath] of Object.entries(indexes[name] ?? {})) store.createIndex(indexName, keyPath);
        }
      } catch (failure) { request.transaction?.abort(); fail(failure); }
    };
    request.onerror = () => fail(error('open-failed'));
    request.onblocked = () => fail(error('database-blocked'));
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      settled = true; options.signal?.removeEventListener('abort', abort);
      database.onversionchange = () => database.close(); resolve(database);
    };
    if (options.signal?.aborted) abort();
  });
  const source = await open();
  if (source.version === PROJECT_MODEL_STAGING_VERSION) {
    try { assertFixture(source); return source; } catch (failure) { source.close(); throw failure; }
  }
  const version = source.version; source.close();
  if (version > DB_VERSION) throw error('future-source-schema');
  options.signal?.throwIfAborted();
  const target = await open(PROJECT_MODEL_STAGING_VERSION);
  try { assertFixture(target); return target; } catch (failure) { target.close(); throw failure; }
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? error('request-failed'));
  });
}
function cursorRows(store: IDBObjectStore): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return new Promise((resolve, reject) => {
    const result: Array<{ key: IDBValidKey; value: unknown }> = [];
    const operation = store.openCursor();
    operation.onerror = () => reject(operation.error ?? error('cursor-failed'));
    operation.onsuccess = () => {
      const cursor = operation.result;
      if (!cursor) { resolve(result); return; }
      result.push({ key: cursor.primaryKey, value: cursor.value }); cursor.continue();
    };
  });
}
async function transaction<T>(database: IDBDatabase, names: string[], mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const tx = database.transaction(names, mode);
  let value: T;
  let failure: unknown;
  const abort = () => { failure = new DOMException('隔离暂存已取消', 'AbortError'); try { tx.abort(); } catch { /* 已结束 */ } };
  signal?.addEventListener('abort', abort, { once: true });
  return new Promise<T>((resolve, reject) => {
    tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(value); };
    tx.onabort = () => { signal?.removeEventListener('abort', abort); reject(failure ?? tx.error ?? error('transaction-failed')); };
    void body(tx).then((result) => { value = result; }).catch((cause: unknown) => {
      failure = cause; try { tx.abort(); } catch { reject(cause); }
    });
    if (signal?.aborted) abort();
  });
}

function nextEpoch(value: number): number { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw error('epoch-overflow'); return value + 1; }
async function buildRows(projection: LegacyProjectProjection, generation: number, operationId: string): Promise<ProjectModelStagingRow[]> {
  const rows: ProjectModelStagingRow[] = [];
  const add = (store: ProjectModelGenerationStore, data: object) => {
    const value = { ...data, generation, operationId } as Record<string, unknown>;
    const path = keys[store] as string[];
    const key = path.map((field) => value[field]) as IDBValidKey;
    rows.push({ store, key, value, token: projectModelSourceToken(value), sha256: '' });
  };
  for (const aggregate of projection.projects) {
    add('projectRoots', { ...aggregate.project, epoch: nextEpoch(aggregate.project.epoch) });
    add('projectContents', aggregate.content);
    if (aggregate.standaloneCanvas) add('canvasDocuments', { ...aggregate.standaloneCanvas, epoch: nextEpoch(aggregate.standaloneCanvas.epoch) });
    if (aggregate.standalonePreview) add('canvasPreviews', aggregate.standalonePreview);
    for (const episode of aggregate.episodes) {
      add('episodes', { ...episode.episode, epoch: nextEpoch(episode.episode.epoch) });
      add('episodeContents', episode.content);
      add('canvasDocuments', { ...episode.canvas, epoch: nextEpoch(episode.canvas.epoch) });
      if (episode.preview) add('canvasPreviews', episode.preview);
    }
    for (const binding of aggregate.bindings) add('legacyProjectBindings', binding);
  }
  rows.sort((a, b) => {
    const left = a.store + '\0' + projectModelSourceToken(a.key), right = b.store + '\0' + projectModelSourceToken(b.key);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = row.store + '\0' + projectModelSourceToken(row.key);
    if (seen.has(identity)) throw error('duplicate-target-key'); seen.add(identity);
    row.sha256 = await digest(row.token);
  }
  return rows;
}

/** 用已封印备份的投影重建原计划；journal 自带的 token/摘要不能作为其真实性证明。 */
export async function assertProjectModelStagingRollbackPlan(journal: ProjectModelStagingJournal,
  projection: LegacyProjectProjection): Promise<void> {
  const rows = await buildRows(projection, journal.generation, journal.operationId);
  const manifest = await digest(JSON.stringify(rows.map(({ store, key, sha256 }) => ({ store, key, sha256 }))));
  if (manifest !== journal.manifestDigest || projectModelSourceToken(rows) !== projectModelSourceToken(journal.rows)) {
    throw error('rollback-plan-mismatch');
  }
}

async function assertSource(tx: IDBTransaction, journal: ProjectModelStagingJournal): Promise<void> {
  try {
    for (const expected of journal.sourceStores) {
      const store = tx.objectStore(expected.name);
      const schema = { keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames).map((name) => {
          const index = store.index(name);
          return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        }) };
      if (projectModelSourceToken(schema) !== expected.schemaToken) throw error('source-changed');
      const current = (await cursorRows(store)).filter(({ key }) => expected.name !== 'metadata'
        || key !== PROJECT_MODEL_SOURCE_FREEZE_KEY && !isKnownExcludedProjectModelBackupMetadataKey(key));
      if (current.length !== expected.records.length || current.some((row, index) =>
        projectModelSourceToken(row.key) !== projectModelSourceToken(expected.records[index].key)
        || projectModelSourceToken(row.value) !== expected.records[index].token)) throw error('source-changed');
    }
  } catch { throw error('source-changed'); }
}
async function assertFrozen(tx: IDBTransaction, journal: ProjectModelStagingJournal): Promise<void> {
  const metadata = tx.objectStore('metadata');
  if (await request(metadata.get(PROJECT_MODEL_BUSINESS_FIXTURE_KEY)) !== undefined) throw error('business-session-present');
  if (await request(metadata.get(PROJECT_MODEL_ACTIVE_MARKER_KEY)) !== undefined) throw error('active-model-present');
  const freeze = await request(metadata.get(PROJECT_MODEL_SOURCE_FREEZE_KEY)) as ProjectModelSourceFreeze | undefined;
  if (!freeze || freeze.id !== PROJECT_MODEL_SOURCE_FREEZE_KEY || freeze.operationId !== journal.operationId
    || freeze.generation !== journal.generation || freeze.sourceDigest !== journal.sourceDigest || freeze.state !== 'frozen') throw error('freeze-conflict');
}
function assertJournal(value: unknown, operationId: string): asserts value is ProjectModelStagingJournal {
  const item = value as ProjectModelStagingJournal | undefined;
  if (!item || item.operationId !== operationId || !positive(item.generation) || item.targetModelVersion !== 2
    || item.generation >= Number.MAX_SAFE_INTEGER || item.adapterVersion !== 1 || item.activationAllowed !== false
    || !positive(item.sourceSchemaVersion) || item.sourceSchemaVersion > DB_VERSION
    || !identifier(item.backupOperationId) || !hash(item.sourceDigest) || !hash(item.backupManifestDigest)
    || !Array.isArray(item.rows) || item.rows.length > 1_000_000 || !Array.isArray(item.sourceStores)
    || !Number.isSafeInteger(item.nextRow) || !Number.isSafeInteger(item.sequence) || item.sequence < 0
    || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0
    || !['schema_ready', 'staging', 'verifying', 'ready', 'failed', 'quarantined', 'rolled_back'].includes(item.stage)
    || !Array.isArray(item.projectIds) || item.projectIds.some((id) => typeof id !== 'string' || !id || id.length > 256)
    || !Array.isArray(item.quarantinedRecordIds) || !Array.isArray(item.diagnostics)
    || item.nextRow < 0 || item.nextRow > item.rows.length || !hash(item.manifestDigest)
    || ['verifying', 'ready'].includes(item.stage) && item.nextRow !== item.rows.length
    || ['schema_ready', 'quarantined'].includes(item.stage) && item.nextRow !== 0
    || item.stage === 'failed' && item.failureCode === undefined
    || item.failureCode !== undefined && !['source-changed', 'staging-conflict', 'verification-failed', 'transaction-failed'].includes(item.failureCode)) throw error('invalid-journal');
  const sourceNames = new Set<string>();
  for (const source of item.sourceStores) {
    if (!source || !isProjectModelBackupStore(source.name) || sourceNames.has(source.name)
      || typeof source.schemaToken !== 'string' || !Array.isArray(source.records) || source.records.length > 1_000_000
      || source.records.some((record) => !record || typeof record.token !== 'string')) throw error('invalid-journal');
    sourceNames.add(source.name);
  }
  if (!sourceNames.has('projects') || !sourceNames.has('metadata')) throw error('invalid-journal');
  const rowKeys = new Set<string>();
  for (const row of item.rows) {
    if (!row || !PROJECT_MODEL_GENERATION_STORES.includes(row.store) || !row.value
      || ![Object.prototype, null].includes(Object.getPrototypeOf(row.value)) || row.value.generation !== item.generation
      || row.value.operationId !== item.operationId || typeof row.token !== 'string' || !hash(row.sha256)
      || projectModelSourceToken(row.value) !== row.token) throw error('invalid-journal');
    const derivedKey = (keys[row.store] as string[]).map((field) => row.value[field]);
    if (projectModelSourceToken(derivedKey) !== projectModelSourceToken(row.key)) throw error('invalid-journal');
    const identity = row.store + '\0' + projectModelSourceToken(row.key);
    if (rowKeys.has(identity)) throw error('invalid-journal'); rowKeys.add(identity);
  }
}

export interface PrepareProjectModelStagingInput {
  operationId: string;
  generation: number;
  source: ProjectModelBackupSource;
  sourceDigest: string;
  backupOperationId: string;
  backupManifestDigest: string;
  projection?: LegacyProjectProjection;
  now?: number;
}

/** 外层核验原生封印后传入；撤销事务须复核同一个 journal，不能使用过期快照。 */
export type ProjectModelStagingRollbackExpectation = Pick<ProjectModelStagingJournal,
  'sequence' | 'generation' | 'stage' | 'nextRow' | 'sourceDigest' | 'sourceSchemaVersion' | 'backupOperationId' | 'backupManifestDigest' | 'manifestDigest' | 'rows'>;

export function createProjectModelStagingRepository(database: IDBDatabase) {
  assertFixture(database);
  const scope = Array.from(new Set([journalStore, ...PROJECT_MODEL_GENERATION_STORES,
    ...Array.from(database.objectStoreNames).filter(isProjectModelBackupStore)]));
  async function readJournal(operationId: string): Promise<ProjectModelStagingJournal | null> {
    if (!identifier(operationId)) throw error('invalid-operation');
    return transaction(database, [journalStore], 'readonly', async (tx) => {
      const item = await request(tx.objectStore(journalStore).get(operationId));
      if (item === undefined) return null; assertJournal(item, operationId); return item;
    });
  }
  async function failJournal(operationId: string, failure: unknown): Promise<void> {
    if (failure instanceof Error && failure.name === 'AbortError') return;
    await transaction(database, [journalStore, 'metadata'], 'readwrite', async (tx) => {
      if (await request(tx.objectStore('metadata').get(PROJECT_MODEL_BUSINESS_FIXTURE_KEY)) !== undefined) return;
      const store = tx.objectStore(journalStore), item: unknown = await request(store.get(operationId));
      assertJournal(item, operationId);
      if (item.stage === 'rolled_back' || item.stage === 'quarantined') return;
      if (item.stage === 'failed' && item.failureCode !== 'transaction-failed') return;
      const code = failure instanceof Error && failure.message.endsWith('source-changed') ? 'source-changed'
        : failure instanceof Error && failure.message.endsWith('verification-failed') ? 'verification-failed'
          : failure instanceof Error && failure.message.endsWith('staging-conflict') ? 'staging-conflict' : 'transaction-failed';
      await request(store.put({ ...item, stage: 'failed', sequence: item.sequence + 1, updatedAt: Date.now(), failureCode: code }));
    });
  }
  return {
    readJournal,
    /** 外层全来源/原生门禁失败也可落盘；终止错误不能被后来的普通失败覆盖。 */
    async markFailed(input: { operationId: string; expectedSequence?: number;
      code: 'source-changed' | 'verification-failed' | 'transaction-failed' }): Promise<ProjectModelStagingJournal> {
      if (!identifier(input.operationId) || !['source-changed', 'verification-failed', 'transaction-failed'].includes(input.code)) throw error('invalid-operation');
      return transaction(database, [journalStore, 'metadata'], 'readwrite', async (tx) => {
        if (await request(tx.objectStore('metadata').get(PROJECT_MODEL_BUSINESS_FIXTURE_KEY)) !== undefined) throw error('business-session-present');
        const store = tx.objectStore(journalStore), item: unknown = await request(store.get(input.operationId));
        assertJournal(item, input.operationId);
        if (item.stage === 'rolled_back' || item.stage === 'quarantined') throw error('stage-not-resumable');
        if (input.expectedSequence !== undefined && input.expectedSequence !== item.sequence) throw error('staging-conflict');
        if (item.stage === 'failed' && item.failureCode !== 'transaction-failed') return item;
        const updated: ProjectModelStagingJournal = { ...item, stage: 'failed', failureCode: input.code,
          sequence: item.sequence + 1, updatedAt: Date.now() };
        await request(store.put(updated)); return updated;
      });
    },
    async prepare(input: PrepareProjectModelStagingInput): Promise<ProjectModelStagingJournal> {
      if (!identifier(input.operationId) || !identifier(input.backupOperationId) || !positive(input.generation)
        || input.generation >= Number.MAX_SAFE_INTEGER || !hash(input.sourceDigest) || !hash(input.backupManifestDigest)
        || input.source.databaseName !== database.name || !positive(input.source.schemaVersion)
        || input.source.schemaVersion > DB_VERSION) throw error('invalid-preparation');
      // 低层fixture入口也走同一备份校验器，不能绕过凭据/未知来源检查后持久化raw token。
      const checkedSource = await createProjectModelBackup(input.source, { operationId: input.backupOperationId, createdAt: 0 });
      if (await fingerprintProjectModelSource(checkedSource.manifest) !== input.sourceDigest) throw error('source-digest-mismatch');
      const projectStore = input.source.stores.find((store) => store.name === 'projects');
      const sourceNames = input.source.stores.map((store) => store.name);
      const actualSourceNames = Array.from(database.objectStoreNames).filter(isProjectModelBackupStore);
      const actualOriginalNames = Array.from(database.objectStoreNames).filter((name) =>
        !PROJECT_MODEL_STAGING_STORES.includes(name as typeof PROJECT_MODEL_STAGING_STORES[number]));
      if (!projectStore || projectStore.keyPath !== 'id' || projectStore.autoIncrement || !sourceNames.includes('metadata')
        || new Set(sourceNames).size !== sourceNames.length || sourceNames.some((name) => !isProjectModelBackupStore(name))
        || sourceNames.slice().sort().join('\0') !== actualSourceNames.sort().join('\0')
        || input.source.databaseStoreNames.slice().sort().join('\0') !== actualOriginalNames.sort().join('\0')
        || input.source.stores.some((store) => store.autoIncrement || store.name === 'metadata'
          && store.records.some(({ key }) => !isProjectModelBackupMetadataKey(key)))) throw error('invalid-source-schema');
      const projection = projectLegacyRecords(projectStore.records.map((row) => row.value as LegacyProjectRecord));
      if (input.projection && projectModelSourceToken(input.projection) !== projectModelSourceToken(projection)) throw error('projection-mismatch');
      const rows = await buildRows(projection, input.generation, input.operationId);
      const manifestDigest = await digest(JSON.stringify(rows.map(({ store, key, sha256 }) => ({ store, key, sha256 }))));
      const now = input.now ?? Date.now();
      if (!Number.isSafeInteger(now) || now < 0) throw error('invalid-time');
      const journal: ProjectModelStagingJournal = {
        operationId: input.operationId, generation: input.generation, sourceSchemaVersion: input.source.schemaVersion,
        targetModelVersion: 2, adapterVersion: 1, sourceDigest: input.sourceDigest,
        backupOperationId: input.backupOperationId, backupManifestDigest: input.backupManifestDigest,
        stage: projection.diagnostics.some((item) => item.severity === 'blocking') ? 'quarantined' : 'schema_ready',
        sequence: 0, nextRow: 0, createdAt: now, updatedAt: now, projectIds: projection.projects.map((item) => item.project.id),
        sourceStores: input.source.stores.map(({ name, keyPath, autoIncrement, indexes: sourceIndexes, records }) => ({
          name, schemaToken: projectModelSourceToken({ keyPath, autoIncrement, indexes: sourceIndexes }),
          records: records.map(({ key, value }) => ({ key, token: projectModelSourceToken(value) })),
        })),
        rows, manifestDigest, diagnostics: projection.diagnostics, quarantinedRecordIds: projection.quarantinedRecordIds,
        activationAllowed: false,
      };
      return transaction(database, scope, 'readwrite', async (tx) => {
        const metadata = tx.objectStore('metadata'), store = tx.objectStore(journalStore);
        if (await request(metadata.get(PROJECT_MODEL_BUSINESS_FIXTURE_KEY)) !== undefined) throw error('business-session-present');
        if (await request(metadata.get(PROJECT_MODEL_ACTIVE_MARKER_KEY)) !== undefined) throw error('active-model-present');
        const existing = await request(store.get(input.operationId));
        if (existing !== undefined) {
          assertJournal(existing, input.operationId);
          if (existing.generation !== journal.generation || existing.sourceDigest !== journal.sourceDigest
            || existing.backupOperationId !== journal.backupOperationId || existing.backupManifestDigest !== journal.backupManifestDigest
            || existing.manifestDigest !== journal.manifestDigest) throw error('operation-conflict');
          await assertSource(tx, existing); if (existing.stage !== 'rolled_back') await assertFrozen(tx, existing); return existing;
        }
        const freeze = await request(metadata.get(PROJECT_MODEL_SOURCE_FREEZE_KEY));
        if (freeze !== undefined) throw error('freeze-conflict');
        const journals = await cursorRows(store);
        if (journals.some(({ value }) => (value as ProjectModelStagingJournal).generation === input.generation
          || (value as ProjectModelStagingJournal).stage !== 'rolled_back')) throw error('generation-conflict');
        await assertSource(tx, journal);
        for (const name of PROJECT_MODEL_GENERATION_STORES) {
          if ((await cursorRows(tx.objectStore(name))).some(({ value }) => (value as Record<string, unknown>).generation === input.generation)) throw error('generation-conflict');
        }
        await request(metadata.add({ id: PROJECT_MODEL_SOURCE_FREEZE_KEY, operationId: input.operationId,
          generation: input.generation, sourceDigest: input.sourceDigest, state: 'frozen' } satisfies ProjectModelSourceFreeze));
        await request(store.add(journal)); return journal;
      });
    },
    async stageNextBatch(input: { operationId: string; batchSize?: number; signal?: AbortSignal }): Promise<ProjectModelStagingJournal> {
      const batchSize = input.batchSize ?? 50;
      if (!identifier(input.operationId) || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw error('invalid-batch');
      try {
        return await transaction(database, scope, 'readwrite', async (tx) => {
          const store = tx.objectStore(journalStore), item: unknown = await request(store.get(input.operationId));
          assertJournal(item, input.operationId); await assertFrozen(tx, item); await assertSource(tx, item);
          if (item.stage === 'ready') return item;
          if (!['schema_ready', 'staging', 'verifying', 'failed'].includes(item.stage)
            || item.stage === 'failed' && item.failureCode !== 'transaction-failed') throw error('stage-not-resumable');
          const end = Math.min(item.nextRow + batchSize, item.rows.length);
          for (let index = item.nextRow; index < end; index++) {
            const row = item.rows[index], target = tx.objectStore(row.store);
            if (projectModelSourceToken(row.value) !== row.token) throw error('staging-conflict');
            const existing = await request(target.get(row.key));
            if (existing !== undefined && projectModelSourceToken(existing) !== row.token) throw error('staging-conflict');
            if (existing === undefined) await request(target.add(row.value));
          }
          const updated: ProjectModelStagingJournal = { ...item, stage: end === item.rows.length ? 'verifying' : 'staging',
            nextRow: end, sequence: item.sequence + 1, updatedAt: Date.now() };
          delete updated.failureCode; await request(store.put(updated)); return updated;
        }, input.signal);
      } catch (failure) { await failJournal(input.operationId, failure); throw failure; }
    },
    async verify(input: { operationId: string; signal?: AbortSignal }): Promise<ProjectModelStagingJournal> {
      const expected = await readJournal(input.operationId);
      if (!expected || !(['verifying', 'ready'].includes(expected.stage)
        || expected.stage === 'schema_ready' && expected.rows.length === 0
        || expected.stage === 'failed' && expected.failureCode === 'transaction-failed')
        || expected.nextRow !== expected.rows.length) throw error('stage-not-verifiable');
      input.signal?.throwIfAborted();
      try {
        for (const row of expected.rows) if (await digest(row.token) !== row.sha256 || projectModelSourceToken(row.value) !== row.token) throw error('verification-failed');
        if (await digest(JSON.stringify(expected.rows.map(({ store, key, sha256 }) => ({ store, key, sha256 })))) !== expected.manifestDigest) throw error('verification-failed');
        input.signal?.throwIfAborted();
        return await transaction(database, scope, 'readwrite', async (tx) => {
          const store = tx.objectStore(journalStore), item: unknown = await request(store.get(input.operationId));
          assertJournal(item, input.operationId);
          if (item.sequence !== expected.sequence || item.manifestDigest !== expected.manifestDigest
            || projectModelSourceToken(item.rows) !== projectModelSourceToken(expected.rows)) throw error('staging-conflict');
          await assertFrozen(tx, item); await assertSource(tx, item);
          for (const name of PROJECT_MODEL_GENERATION_STORES) {
            const actual = (await cursorRows(tx.objectStore(name))).filter(({ value }) => (value as Record<string, unknown>).generation === item.generation);
            const planned = item.rows.filter((row) => row.store === name);
            if (actual.length !== planned.length || actual.some(({ key, value }) => !planned.some((row) =>
              projectModelSourceToken(key) === projectModelSourceToken(row.key) && projectModelSourceToken(value) === row.token))) throw error('verification-failed');
          }
          const updated: ProjectModelStagingJournal = { ...item, stage: 'ready', sequence: item.sequence + 1, updatedAt: Date.now() };
          await request(store.put(updated)); return updated;
        }, input.signal);
      } catch (failure) { await failJournal(input.operationId, failure); throw failure; }
    },
    /** 仅撤销本次未激活暂存；不回写旧作品、不回滚任务/回执/队列。 */
    async rollback(input: { operationId: string; expected: ProjectModelStagingRollbackExpectation; signal?: AbortSignal }): Promise<ProjectModelStagingJournal> {
      if (!identifier(input.operationId)) throw error('invalid-operation');
      return transaction(database, scope, 'readwrite', async (tx) => {
        const store = tx.objectStore(journalStore), item: unknown = await request(store.get(input.operationId));
        assertJournal(item, input.operationId);
        if (!input.expected || item.sequence !== input.expected.sequence || item.generation !== input.expected.generation
          || item.stage !== input.expected.stage || item.nextRow !== input.expected.nextRow
          || item.sourceSchemaVersion !== input.expected.sourceSchemaVersion || item.sourceDigest !== input.expected.sourceDigest
          || item.backupOperationId !== input.expected.backupOperationId || item.backupManifestDigest !== input.expected.backupManifestDigest
          || item.manifestDigest !== input.expected.manifestDigest || projectModelSourceToken(item.rows) !== projectModelSourceToken(input.expected.rows)) {
          throw error('staging-conflict');
        }
        const metadata = tx.objectStore('metadata');
        if (await request(metadata.get(PROJECT_MODEL_BUSINESS_FIXTURE_KEY)) !== undefined) throw error('business-session-present');
        if (await request(metadata.get(PROJECT_MODEL_ACTIVE_MARKER_KEY)) !== undefined) throw error('active-model-present');
        if (item.stage === 'rolled_back') {
          // 已完成不代表此后不会出现同代异常数据；重试只能在原代仍为空时确认。
          for (const name of PROJECT_MODEL_GENERATION_STORES) {
            if ((await cursorRows(tx.objectStore(name))).some(({ value }) =>
              (value as Record<string, unknown>).generation === item.generation)) throw error('staging-conflict');
          }
          return item;
        }
        await assertFrozen(tx, item);
        for (const name of PROJECT_MODEL_GENERATION_STORES) {
          // nextRow 与对应批次在同一事务提交，已提交行必须一个不少、不多且内容完整。
          const expected = new Map(item.rows.slice(0, item.nextRow).filter((row) => row.store === name)
            .map((row) => [projectModelSourceToken(row.key), row.token]));
          const actual = (await cursorRows(tx.objectStore(name))).filter(({ value }) =>
            (value as Record<string, unknown>).generation === item.generation);
          if (actual.length !== expected.size) throw error('staging-conflict');
          for (const { key, value } of actual) {
            const row = value as Record<string, unknown>;
            // 不能仅凭代次和 operationId 清除未知或受损行；它们仍可能是唯一证据。
            if (row.operationId !== item.operationId || expected.get(projectModelSourceToken(key)) !== projectModelSourceToken(value)) {
              throw error('staging-conflict');
            }
            await request(tx.objectStore(name).delete(key));
          }
        }
        const others = await cursorRows(store);
        if (others.some(({ value }) => (value as ProjectModelStagingJournal).operationId !== item.operationId
          && (value as ProjectModelStagingJournal).stage !== 'rolled_back')) throw error('freeze-conflict');
        const updated: ProjectModelStagingJournal = { ...item, stage: 'rolled_back', sequence: item.sequence + 1, updatedAt: Date.now() };
        await request(store.put(updated)); await request(metadata.delete(PROJECT_MODEL_SOURCE_FREEZE_KEY)); return updated;
      }, input.signal);
    },
  };
}
