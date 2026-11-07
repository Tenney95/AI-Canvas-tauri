/** P0/P1 迁移只读源：不调用 openDB、不创建数据库、不提升版本、不写回旧数据。 */
import { DB_NAME, DB_VERSION } from './schema';
import type { ProjectModelBackupSource } from '../projectModelBackup';
import {
  isProjectModelFixtureDatabaseName, PROJECT_MODEL_SOURCE_FREEZE_KEY,
  PROJECT_MODEL_STAGING_STORES, PROJECT_MODEL_STAGING_VERSION,
} from '../../types/projectModelJournal';

export const PROJECT_MODEL_PENDING_TASKS_KEY = 'ai_canvas_pending_tasks' as const;

/** 这些表是本机项目恢复材料；项目包不能替代其中的回执、索引和恢复日志。 */
export const PROJECT_MODEL_BACKUP_STORES = [
  'projects', 'projectSummaries', 'history', 'assetMeta', 'assetMetaV2', 'assetIndex',
  'chatConversations', 'chatMessages', 'agentTasks', 'projectMemories', 'metadata',
  'videoEditorProjects', 'projectVisualDescriptions', 'sharedAssetMappings',
  'sharedAssetOutbox', 'sharedAssetConflicts', 'projectExchangeStates', 'projectExchangeSnapshots',
] as const;

/** 此次模型准备不修改这些全局表，尤其不把 config/凭据复制到项目恢复格式。 */
export const PROJECT_MODEL_EXCLUDED_STORES = [
  'workflows', 'config', 'presets', 'styles', 'skills', 'toolbarLayouts',
  'globalCharacters', 'globalDramaAssets', 'subAgentProfiles', 'plugins', 'appearanceThemes',
] as const;

const backupStores = new Set<string>(PROJECT_MODEL_BACKUP_STORES);
const excludedStores = new Set<string>(PROJECT_MODEL_EXCLUDED_STORES);
const storeKeyPaths: Record<string, string> = Object.fromEntries(PROJECT_MODEL_BACKUP_STORES.map((name) => [name,
  name === 'assetMeta' ? 'path' : name === 'assetMetaV2' || name === 'assetIndex' ? 'assetId'
    : name === 'projectExchangeStates' ? 'ownerId' : name === 'projectExchangeSnapshots' ? 'revisionId' : 'id']));
const metadataKeys = new Set(['last-active-project', 'recent-asset-usage', 'media-relocations']);
const metadataPrefixes = [
  'project-deleted:', 'output-history-v1:', 'video-batches:', 'video-replica-jobs:',
  'asset-image:', 'forgotten-missing-asset:', 'forgotten-missing-path:', 'forgotten-missing-history:',
  'project-import-recovery:', 'project-import-operation:', 'project-export-operation:', 'archive-history-binding:', 'mcp-operation:',
];

export const isProjectModelBackupStore = (name: string): boolean => backupStores.has(name);
export const isKnownExcludedProjectModelBackupStore = (name: string): boolean => excludedStores.has(name);
export const isProjectModelBackupMetadataKey = (key: unknown): key is string => typeof key === 'string'
  && (metadataKeys.has(key) || metadataPrefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length));
export const isKnownExcludedProjectModelBackupMetadataKey = (key: unknown): boolean => key === 'preset-folders';

export interface ExistingProjectDatabaseOptions {
  name?: string;
  factory?: IDBFactory;
  signal?: AbortSignal;
  /** 仅独立 fixture 的恢复读取；绝不放宽正式数据库未来版本保护。 */
  allowFixtureStaging?: boolean;
}

/** 不存在时中止首次建库事务；返回 null，而不是创建一个空库冒充旧数据。 */
export function openExistingProjectDatabase(options: ExistingProjectDatabaseOptions = {}): Promise<IDBDatabase | null> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error('当前环境无法读取本地项目数据库'));
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let absent = false;
    const finish = (database: IDBDatabase | null, error?: unknown) => {
      if (settled) { database?.close(); return; }
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(database);
    };
    const abort = () => finish(null, new DOMException('项目只读准备已取消', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    let request: IDBOpenDBRequest;
    try { request = factory.open(options.name ?? DB_NAME); }
    catch { finish(null, new Error('无法打开现有项目数据库')); return; }
    request.onupgradeneeded = (event) => {
      absent = event.oldVersion === 0;
      request.transaction?.abort();
    };
    request.onerror = (event) => {
      event.preventDefault();
      if (absent) finish(null);
      else finish(null, new Error('无法只读打开现有项目数据库'));
    };
    request.onblocked = () => finish(null, new Error('项目数据库被其他窗口占用，请关闭其他实例后重试'));
    request.onsuccess = () => {
      const database = request.result;
      if (database.version > DB_VERSION && !(options.allowFixtureStaging
        && isProjectModelFixtureDatabaseName(database.name) && database.version === PROJECT_MODEL_STAGING_VERSION)) {
        database.close(); finish(null, new Error('项目数据库来自更新版本，不能按旧模型读取')); return;
      }
      database.onversionchange = () => database.close();
      finish(database);
    };
    if (options.signal?.aborted) abort();
  });
}

const RECORD_BYTES_LIMIT = 128 * 1024 * 1024;
const TOTAL_BYTES_LIMIT = 256 * 1024 * 1024;
const RECORD_COUNT_LIMIT = 200_000;

/** 同步估算 raw structured-clone 的驻留体积，不在活跃 IDB 事务中 await 编码/哈希。 */
export function estimateLegacyBackupValueBytes(value: unknown, maxBytes = RECORD_BYTES_LIMIT): number {
  let bytes = 0;
  const seen = new WeakSet<object>();
  const add = (count: number) => {
    bytes += count;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new Error('项目恢复材料超过只读准备容量，请分批处理');
  };
  const string = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      const character = text.charCodeAt(index);
      if (character < 0x80) add(1);
      else if (character < 0x800) add(2);
      else if (character >= 0xd800 && character <= 0xdbff
        && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        add(4); index += 1;
      } else add(3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new Error('项目恢复材料嵌套过深');
    if (typeof item === 'string') { string(item); return; }
    if (item === null || item === undefined || typeof item === 'boolean') { add(4); return; }
    if (typeof item === 'number' || typeof item === 'bigint') { add(8); return; }
    if (typeof item !== 'object') throw new Error('项目恢复材料包含不支持的值类型');
    if (seen.has(item)) { add(8); return; }
    seen.add(item); add(16);
    if (typeof Blob !== 'undefined' && item instanceof Blob) { add(item.size); return; }
    if (item instanceof ArrayBuffer) { add(item.byteLength); return; }
    if (ArrayBuffer.isView(item)) { add(item.byteLength); return; }
    if (item instanceof Date) { add(8); return; }
    if (item instanceof Map) { for (const [key, entry] of item) { visit(key, depth + 1); visit(entry, depth + 1); } return; }
    if (item instanceof Set) { for (const entry of item) visit(entry, depth + 1); return; }
    if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return; }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error('项目恢复材料包含不支持的对象类型');
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (!('value' in descriptor)) throw new Error('项目恢复材料包含访问器字段');
      string(key); visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  return bytes;
}

export interface LegacyMigrationReadDiagnostic {
  code: 'unknown-store' | 'unknown-metadata-key' | 'unsupported-store-schema' | 'missing-projects-store'
    | 'local-storage-unavailable' | 'local-storage-changed' | 'source-freeze-conflict';
  blocking: true;
  /** 仅表名/行序号，不把不可信 metadata key、正文或文件路径带入诊断。 */
  store?: string;
  recordIndex?: number;
}

export interface LegacyMigrationSnapshot {
  source: ProjectModelBackupSource;
  diagnostics: LegacyMigrationReadDiagnostic[];
  complete: boolean;
}

export interface LegacyMigrationSnapshotOptions {
  localStorage?: Pick<Storage, 'getItem'> | null;
  signal?: AbortSignal;
  maxRecords?: number;
  maxRecordBytes?: number;
  maxTotalBytes?: number;
  /** 暂存后核对原来源；仅隔离fixture可忽略已知暂存表和本操作冻结marker。 */
  fixtureSource?: { schemaVersion: number; operationId: string; sourceDigest: string; generation: number; requireFrozen?: boolean };
}

/**
 * 有界内存快照，不是流式备份或跨进程停写证明。
 * 所有包含表在同一 readonly 事务读取；LS 只读原串并前后比较，不调用会写回的 loadAll。
 */
export function readLegacyMigrationSnapshot(database: IDBDatabase,
  options: LegacyMigrationSnapshotOptions = {}): Promise<LegacyMigrationSnapshot> {
  options.signal?.throwIfAborted();
  const fixture = options.fixtureSource;
  if (fixture && (!isProjectModelFixtureDatabaseName(database.name)
    || database.version !== PROJECT_MODEL_STAGING_VERSION
    || !Number.isSafeInteger(fixture.schemaVersion) || fixture.schemaVersion < 1 || fixture.schemaVersion > DB_VERSION
    || typeof fixture.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(fixture.operationId)
    || !/^[a-f0-9]{64}$/.test(fixture.sourceDigest) || !Number.isSafeInteger(fixture.generation) || fixture.generation < 1)) {
    return Promise.reject(new Error('隔离迁移来源范围无效'));
  }
  if (database.version > DB_VERSION && !fixture) return Promise.reject(new Error('项目数据库版本超出只读准备支持范围'));
  const limits = {
    records: options.maxRecords ?? RECORD_COUNT_LIMIT,
    record: options.maxRecordBytes ?? RECORD_BYTES_LIMIT,
    total: options.maxTotalBytes ?? TOTAL_BYTES_LIMIT,
  };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)
    || limits.records > 1_000_000 || limits.record > RECORD_BYTES_LIMIT || limits.total > 1024 * 1024 * 1024) {
    return Promise.reject(new Error('项目只读准备容量设置无效'));
  }
  const diagnostics: LegacyMigrationReadDiagnostic[] = [];
  let storage: Pick<Storage, 'getItem'> | null = null;
  let before: string | null = null;
  try {
    storage = options.localStorage === undefined ? globalThis.localStorage : options.localStorage;
    if (!storage) throw new Error('unavailable');
    before = storage.getItem(PROJECT_MODEL_PENDING_TASKS_KEY);
  } catch { diagnostics.push({ code: 'local-storage-unavailable', blocking: true }); }
  const stagingNames = new Set<string>(PROJECT_MODEL_STAGING_STORES);
  const names = Array.from(database.objectStoreNames).filter((name) => !fixture || !stagingNames.has(name));
  for (const name of names) if (!isProjectModelBackupStore(name) && !isKnownExcludedProjectModelBackupStore(name)) {
    diagnostics.push({ code: 'unknown-store', blocking: true });
  }
  if (!names.includes('projects')) diagnostics.push({ code: 'missing-projects-store', blocking: true });
  const selected = names.filter(isProjectModelBackupStore);
  const source: ProjectModelBackupSource = { databaseName: database.name, schemaVersion: fixture?.schemaVersion ?? database.version,
    databaseStoreNames: names, stores: [], localStorage: [{ key: PROJECT_MODEL_PENDING_TASKS_KEY, value: before }] };
  if (selected.length === 0) return Promise.resolve({ source, diagnostics, complete: false });
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(selected, 'readonly'); }
    catch { reject(new Error('无法开始项目只读准备')); return; }
    let failure: Error | undefined;
    let count = 0;
    let sourceFrozen = false;
    let bytes = estimateLegacyBackupValueBytes(before, limits.total);
    const abort = () => {
      failure ??= new DOMException('项目只读准备已取消', 'AbortError');
      try { transaction.abort(); } catch { /* 事务已结束。 */ }
    };
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    options.signal?.addEventListener('abort', abort, { once: true });
    for (const name of selected) {
      const store = transaction.objectStore(name);
      // IDB 不公开 autoIncrement 的内部计数，不能把异常 schema 备份宣称成可精确还原。
      if (store.autoIncrement || store.keyPath !== storeKeyPaths[name]) {
        diagnostics.push({ code: 'unsupported-store-schema', blocking: true, store: name });
      }
      const captured: ProjectModelBackupSource['stores'][number] = {
        name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames).map((indexName) => {
          const index = store.index(indexName);
          return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        }), records: [],
      };
      source.stores.push(captured);
      const request = store.openCursor();
      let recordIndex = 0;
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) return;
          count += 1;
          if (count > limits.records) throw new Error('项目恢复材料记录过多，请分批处理');
          bytes += estimateLegacyBackupValueBytes(cursor.primaryKey, limits.record)
            + estimateLegacyBackupValueBytes(cursor.value, limits.record);
          if (bytes > limits.total) throw new Error('项目恢复材料超过只读准备容量，请分批处理');
          if (fixture && name === 'metadata' && cursor.primaryKey === PROJECT_MODEL_SOURCE_FREEZE_KEY) {
            sourceFrozen = true;
            const marker = cursor.value as Record<string, unknown> | null;
            if (!marker || typeof marker !== 'object' || Array.isArray(marker)
              || marker.id !== PROJECT_MODEL_SOURCE_FREEZE_KEY || marker.operationId !== fixture.operationId
              || marker.state !== 'frozen' || typeof marker.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(marker.sourceDigest)
              || !Number.isSafeInteger(marker.generation) || (marker.generation as number) < 1
              || marker.sourceDigest !== fixture.sourceDigest || marker.generation !== fixture.generation
              || Object.keys(marker).some((key) => !['id', 'operationId', 'generation', 'sourceDigest', 'state'].includes(key))) {
              diagnostics.push({ code: 'source-freeze-conflict', blocking: true, store: 'metadata', recordIndex });
            }
          } else if (name !== 'metadata' || isProjectModelBackupMetadataKey(cursor.primaryKey)) {
            captured.records.push({ key: cursor.primaryKey, value: cursor.value });
          } else if (!isKnownExcludedProjectModelBackupMetadataKey(cursor.primaryKey)) {
            diagnostics.push({ code: 'unknown-metadata-key', blocking: true, store: 'metadata', recordIndex });
          }
          recordIndex += 1;
          cursor.continue();
        } catch (error) {
          failure = error instanceof Error ? error : new Error('项目恢复材料读取失败');
          try { transaction.abort(); } catch { /* 等待终止事件。 */ }
        }
      };
    }
    transaction.oncomplete = () => {
      cleanup();
      if (fixture?.requireFrozen && !sourceFrozen) {
        diagnostics.push({ code: 'source-freeze-conflict', blocking: true, store: 'metadata' });
      }
      if (storage) {
        try {
          if (storage.getItem(PROJECT_MODEL_PENDING_TASKS_KEY) !== before) {
            diagnostics.push({ code: 'local-storage-changed', blocking: true });
          }
        } catch { diagnostics.push({ code: 'local-storage-unavailable', blocking: true }); }
      }
      resolve({ source, diagnostics, complete: diagnostics.length === 0 });
    };
    transaction.onerror = () => { failure ??= new Error('项目只读准备事务失败'); };
    transaction.onabort = () => { cleanup(); reject(failure ?? new Error('项目只读准备未完成')); };
    if (options.signal?.aborted) abort();
  });
}
