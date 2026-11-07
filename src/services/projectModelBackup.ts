/** 项目模型迁移的有界本地备份；不调用归档脱敏器、不写数据库，也不激活迁移。 */
import { sha256BytesHex } from './mediaDataUrl';
import { DB_NAME, DB_VERSION } from './indexedDb/schema';
import { isProjectModelFixtureDatabaseName, PROJECT_MODEL_STAGING_STORES, PROJECT_MODEL_STAGING_VERSION,
  PROJECT_MODEL_SOURCE_FREEZE_KEY } from '../types/projectModelJournal';
import { PROJECT_MODEL_BUSINESS_FIXTURE_KEY } from '../types/projectModelBusiness';
import {
  isProjectModelBackupStore,
  isKnownExcludedProjectModelBackupStore,
  isProjectModelBackupMetadataKey,
} from './indexedDb/projectModelMigrationRepository';

export const PROJECT_MODEL_BACKUP_FORMAT = 'project-model-backup-v1' as const;
export const PROJECT_MODEL_FIXTURE_BACKUP_FORMAT = 'project-model-fixture-backup-v2' as const;
const fixtureStoreKeys: Record<string, string | string[]> = {
  projectRoots: ['generation', 'id'], projectContents: ['generation', 'projectId'], episodes: ['generation', 'id'],
  episodeContents: ['generation', 'episodeId'], canvasDocuments: ['generation', 'id'], canvasPreviews: ['generation', 'canvasId'],
  legacyProjectBindings: ['generation', 'namespace', 'legacyId'], archiveHistoryBindings: ['destinationProjectId', 'sourceNamespace', 'kind', 'archiveOriginId'],
  projectModelMigrations: 'operationId',
};
const fixtureStoreIndexes: Record<string, Record<string, string | string[]>> = {
  episodes: { projectId_orderRank: ['generation', 'projectId', 'orderRank'] },
  canvasDocuments: { projectId: ['generation', 'projectId'], episodeId: ['generation', 'episodeId'] },
  legacyProjectBindings: { projectId: ['generation', 'projectId'], canvasId: ['generation', 'canvasId'] },
  projectModelMigrations: { generation: 'generation', stage: 'stage' },
};
export const isProjectModelFixtureBackupStore = (name: string): boolean => isProjectModelBackupStore(name) || Object.hasOwn(fixtureStoreKeys, name);
export const isProjectModelFixtureBackupMetadataKey = (key: unknown): key is string => isProjectModelBackupMetadataKey(key)
  || key === PROJECT_MODEL_BUSINESS_FIXTURE_KEY || key === PROJECT_MODEL_SOURCE_FREEZE_KEY
  || typeof key === 'string' && ['project-model-business-tombstone:', 'project-model-business-cleanup:',
    'project-model-import:', 'project-model-export:', 'project-model-exchange:', 'project-model-recovery:',
    'project-model-pre-restore:'].some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
/** P1 在内存准备材料，超限明确拒绝；大库流式迁移属于后续阶段。 */
export const PROJECT_MODEL_BACKUP_LIMITS = {
  maxFileBytes: 128 * 1024 * 1024,
  maxManifestBytes: 2 * 1024 * 1024,
  maxCompleteBytes: 4096,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFiles: 20_000,
  maxRecords: 1_000_000,
  maxDepth: 64,
  maxValues: 4_000_000,
  chunkTargetBytes: 1024 * 1024,
} as const;

export interface ProjectModelBackupIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}
export interface ProjectModelBackupStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: ProjectModelBackupIndex[];
  records: Array<{ key: IDBValidKey; value: unknown }>;
}
export interface ProjectModelBackupSource {
  databaseName: string;
  schemaVersion: number;
  databaseStoreNames: string[];
  stores: ProjectModelBackupStore[];
  localStorage: Array<{ key: 'ai_canvas_pending_tasks'; value: string | null }>;
}
export interface ProjectModelBackupFile {
  path: string;
  kind: 'records' | 'binary' | 'localStorage';
  bytes: number;
  sha256: string;
}
export interface ProjectModelBackupStoreManifest extends Omit<ProjectModelBackupStore, 'records'> {
  recordCount: number;
  chunks: string[];
}
export interface ProjectModelBackupManifest {
  format: typeof PROJECT_MODEL_BACKUP_FORMAT | typeof PROJECT_MODEL_FIXTURE_BACKUP_FORMAT;
  operationId: string;
  createdAt: number;
  databaseName: string;
  schemaVersion: number;
  databaseStoreNames: string[];
  stores: ProjectModelBackupStoreManifest[];
  localStorage: Array<{ key: 'ai_canvas_pending_tasks'; path: string }>;
  files: ProjectModelBackupFile[];
  totalBytes: number;
}
export interface ProjectModelBackupBundle {
  manifest: ProjectModelBackupManifest;
  files: Map<string, Uint8Array>;
}
/** 路径均是固定备份根下的相对路径；端口必须拒绝覆盖和链接。 */
export interface ProjectModelBackupPort {
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string, maxBytes: number): Promise<Uint8Array>;
  /** complete.json 必须独占创建、落盘；不是允许覆盖的 rename。 */
  publishComplete(path: string, bytes: Uint8Array): Promise<void>;
}
export interface VerifiedProjectModelBackup {
  status: 'verified';
  manifest: ProjectModelBackupManifest;
  source: ProjectModelBackupSource;
}

type Encoded = null | boolean | number | string | Encoded[] | { [key: string]: Encoded };
type ObjectRecord = Record<string, unknown>;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const COMPLETE_PATH = 'complete.json';
const MANIFEST_PATH = 'manifest.json';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const secretFields = new Set(['apikey', 'xapikey', 'xauthtoken', 'secretaccesskey', 'accesskeyid', 'authorization', 'proxyauthorization', 'password',
  'accesstoken', 'refreshtoken', 'sessiontoken', 'clientsecret', 'privatekey', 'token']);

/** 新模型业务写入复用备份的凭据字段边界，不把密钥藏入任意节点/正文扩展对象。 */
export function assertNoProjectModelCredentials(value: unknown): void {
  const seen = new WeakSet<object>();
  let visited = 0;
  const entry = (key: unknown, child: unknown) => {
    if (typeof key === 'string' && secretFields.has(key.replace(/[_-]/g, '').toLowerCase())
      && child !== undefined && child !== null && child !== '') fail('plaintext_credential_field');
  };
  const visit = (item: unknown, depth: number): void => {
    if (++visited > PROJECT_MODEL_BACKUP_LIMITS.maxValues || depth > PROJECT_MODEL_BACKUP_LIMITS.maxDepth) fail('value_limit');
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    if (item instanceof Map) {
      for (const [key, child] of item) { entry(key, child); visit(key, depth + 1); visit(child, depth + 1); }
    } else if (item instanceof Set) {
      for (const child of item) visit(child, depth + 1);
    } else if (!(item instanceof ArrayBuffer) && !ArrayBuffer.isView(item)
      && !(typeof Blob !== 'undefined' && item instanceof Blob) && !(item instanceof Date)) {
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!('value' in descriptor)) fail('unsupported_accessor');
        entry(key, descriptor.value); visit(descriptor.value, depth + 1);
      }
    }
  };
  visit(value, 0);
}
const views = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
  Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
function fail(code: string): never { throw new Error('项目迁移备份不可用：' + code); }
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('项目迁移备份已取消', 'AbortError');
}
function object(value: unknown, keys: string[], required = keys): ObjectRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_object');
  const result = value as ObjectRecord;
  if (Object.keys(result).some((key) => !keys.includes(key)) || required.some((key) => !own(result, key))) fail('invalid_fields');
  return result;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail('invalid_number');
  return value;
}
function shortString(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || [...value].some((char) => char.charCodeAt(0) < 32)) fail('invalid_text');
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') fail('invalid_boolean'); return value; }
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('invalid_array');
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid_digest');
  return value;
}
export function assertProjectModelBackupPath(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:stores\/[a-zA-Z0-9-]+\/[0-9]{6}\.json|binary\/[0-9]{6}\.bin|local-storage\.json|manifest\.json|complete\.json)$/.test(value)) fail('invalid_path');
  return value;
}
function keyPath(value: unknown, nullable: boolean): string | string[] | null {
  if (value === null && nullable) return null;
  const one = (path: unknown) => {
    if (path === '') return '';
    const next = shortString(path);
    if (next.split('.').some((part) => forbidden.has(part) || !part)) fail('invalid_key_path');
    return next;
  };
  return Array.isArray(value) ? array(value, 32).map(one) : one(value);
}
function parseSchema(value: unknown, fixture = false): Omit<ProjectModelBackupStore, 'records'> {
  const row = object(value, ['name', 'keyPath', 'autoIncrement', 'indexes']);
  const name = shortString(row.name);
  if (!(fixture ? isProjectModelFixtureBackupStore(name) : isProjectModelBackupStore(name))) fail('unsupported_store');
  // 标准 IDB 不公开内部 key generator；不能把未保存它的备份称为可还原 schema。
  if (boolean(row.autoIncrement)) fail('unsupported_auto_increment');
  const indexes = array(row.indexes, 64).map((item) => {
    const index = object(item, ['name', 'keyPath', 'unique', 'multiEntry']);
    return { name: shortString(index.name), keyPath: keyPath(index.keyPath, false) as string | string[],
      unique: boolean(index.unique), multiEntry: boolean(index.multiEntry) };
  });
  if (new Set(indexes.map((index) => index.name)).size !== indexes.length) fail('duplicate_index');
  const parsedKeyPath = keyPath(row.keyPath, true);
  if (Object.hasOwn(fixtureStoreKeys, name) && JSON.stringify(parsedKeyPath) !== JSON.stringify(fixtureStoreKeys[name])) fail('invalid_fixture_key_path');
  if (Object.hasOwn(fixtureStoreKeys, name)) {
    const expected = fixtureStoreIndexes[name] ?? {};
    if (indexes.length !== Object.keys(expected).length || indexes.some((index) => index.unique || index.multiEntry
      || !Object.hasOwn(expected, index.name) || JSON.stringify(index.keyPath) !== JSON.stringify(expected[index.name]))) fail('invalid_fixture_index');
  }
  return { name, keyPath: parsedKeyPath, autoIncrement: boolean(row.autoIncrement), indexes };
}
function validateCoverage(namesInput: unknown, stores: readonly { name: string }[], fixture = false): string[] {
  const names = array(namesInput, 128).map((name) => shortString(name));
  if (new Set(names).size !== names.length || new Set(stores.map((store) => store.name)).size !== stores.length) fail('duplicate_store');
  const included = fixture ? isProjectModelFixtureBackupStore : isProjectModelBackupStore;
  if (!names.includes('projects') || names.some((name) => !included(name) && !isKnownExcludedProjectModelBackupStore(name))) fail('unknown_store_coverage');
  if (fixture && (!names.includes('metadata') || PROJECT_MODEL_STAGING_STORES.some((name) => !names.includes(name)))) fail('incomplete_fixture_coverage');
  const expected = names.filter(included).sort();
  if (JSON.stringify(expected) !== JSON.stringify(stores.map((store) => store.name).sort())) fail('incomplete_store_coverage');
  return names;
}
function parseManifest(value: unknown): ProjectModelBackupManifest {
  const row = object(value, ['format', 'operationId', 'createdAt', 'databaseName', 'schemaVersion', 'databaseStoreNames', 'stores', 'localStorage', 'files', 'totalBytes']);
  const fixture = row.format === PROJECT_MODEL_FIXTURE_BACKUP_FORMAT;
  if (row.format !== PROJECT_MODEL_BACKUP_FORMAT && !fixture
    || row.databaseName !== DB_NAME && !isProjectModelFixtureDatabaseName(row.databaseName)) fail('unsupported_format');
  const operationId = shortString(row.operationId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(operationId)) fail('invalid_operation');
  const schemaVersion = integer(row.schemaVersion);
  if (!schemaVersion || (fixture ? !isProjectModelFixtureDatabaseName(row.databaseName) || schemaVersion !== PROJECT_MODEL_STAGING_VERSION
    : schemaVersion > DB_VERSION)) fail('unsupported_schema');
  const files = array(row.files, PROJECT_MODEL_BACKUP_LIMITS.maxFiles).map((item): ProjectModelBackupFile => {
    const file = object(item, ['path', 'kind', 'bytes', 'sha256']);
    const path = assertProjectModelBackupPath(file.path);
    if (path === MANIFEST_PATH || path === COMPLETE_PATH || !['records', 'binary', 'localStorage'].includes(String(file.kind))) fail('invalid_file_kind');
    const kind = file.kind as ProjectModelBackupFile['kind'];
    if ((kind === 'binary') !== path.startsWith('binary/') || (kind === 'localStorage') !== (path === 'local-storage.json')) fail('invalid_file_kind');
    return { path, kind, bytes: integer(file.bytes, PROJECT_MODEL_BACKUP_LIMITS.maxFileBytes), sha256: digest(file.sha256) };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) fail('duplicate_file');
  const stores = array(row.stores, 128).map((item): ProjectModelBackupStoreManifest => {
    const store = object(item, ['name', 'keyPath', 'autoIncrement', 'indexes', 'recordCount', 'chunks']);
    const schema = parseSchema({ name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: store.indexes }, fixture);
    const chunks = array(store.chunks, PROJECT_MODEL_BACKUP_LIMITS.maxFiles).map(assertProjectModelBackupPath);
    if (new Set(chunks).size !== chunks.length || chunks.some((path) => !path.startsWith('stores/' + schema.name + '/')
      || !files.some((file) => file.path === path && file.kind === 'records'))) fail('invalid_chunk');
    return { ...schema, recordCount: integer(store.recordCount, PROJECT_MODEL_BACKUP_LIMITS.maxRecords), chunks };
  });
  if (stores.reduce((sum, store) => sum + store.recordCount, 0) > PROJECT_MODEL_BACKUP_LIMITS.maxRecords) fail('record_limit');
  const databaseStoreNames = validateCoverage(row.databaseStoreNames, stores, fixture);
  const localStorage = array(row.localStorage, 1).map((item) => {
    const local = object(item, ['key', 'path']);
    if (local.key !== 'ai_canvas_pending_tasks' || local.path !== 'local-storage.json') fail('unsupported_local_storage');
    return { key: 'ai_canvas_pending_tasks' as const, path: 'local-storage.json' };
  });
  if (localStorage.length !== 1 || !files.some((file) => file.path === 'local-storage.json' && file.kind === 'localStorage')) fail('incomplete_local_storage');
  const chunkPaths = new Set(stores.flatMap((store) => store.chunks));
  if (files.some((file) => file.kind === 'records' && !chunkPaths.has(file.path))) fail('unowned_chunk');
  const totalBytes = integer(row.totalBytes, PROJECT_MODEL_BACKUP_LIMITS.maxTotalBytes);
  if (files.reduce((sum, file) => sum + file.bytes, 0) !== totalBytes) fail('invalid_total');
  return { format: fixture ? PROJECT_MODEL_FIXTURE_BACKUP_FORMAT : PROJECT_MODEL_BACKUP_FORMAT, operationId, createdAt: integer(row.createdAt), databaseName: row.databaseName as string, schemaVersion,
    databaseStoreNames, stores, localStorage, files, totalBytes };
}
function jsonBytes(value: unknown, max: number): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > max) fail('file_limit');
  return bytes;
}
function readJson(bytes: Uint8Array, max: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > max) fail('file_limit');
  try { return JSON.parse(decoder.decode(bytes)); } catch { return fail('invalid_json'); }
}
function normalizedKey(value: unknown, depth = 0): string {
  if (depth > PROJECT_MODEL_BACKUP_LIMITS.maxDepth) fail('key_depth');
  if (typeof value === 'string') return JSON.stringify(['string', value]);
  if (typeof value === 'number' && !Number.isNaN(value)) return JSON.stringify(['number', value === Infinity ? '+Infinity' : value === -Infinity ? '-Infinity' : value === 0 ? 0 : value]);
  if (value instanceof Date && Number.isFinite(value.getTime())) return JSON.stringify(['date', value.getTime()]);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.byteLength > PROJECT_MODEL_BACKUP_LIMITS.maxFileBytes) fail('key_limit');
    return JSON.stringify(['binary', Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')]);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail('invalid_key');
    return JSON.stringify(['array', value.map((item) => normalizedKey(item, depth + 1))]);
  }
  return fail('invalid_key');
}

function assertRecordKey(store: Pick<ProjectModelBackupStore, 'keyPath'>, key: unknown, value: unknown): void {
  if (store.keyPath === null) return;
  const extract = (path: string): unknown => {
    if (path === '') return value;
    let current = value;
    for (const part of path.split('.')) {
      if (!current || typeof current !== 'object' || !own(current, part)) return undefined;
      current = (current as ObjectRecord)[part];
    }
    return current;
  };
  const inline = Array.isArray(store.keyPath) ? store.keyPath.map(extract) : extract(store.keyPath);
  if (normalizedKey(inline) !== normalizedKey(key)) fail('inline_key_mismatch');
}

/** 原串照存；只读检查不能经过会改写队列的 loadAll/sanitizePendingTask。 */
function assertPendingQueue(raw: string | null): void {
  if (raw === null) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail('pending_queue_invalid_json'); }
  if (!Array.isArray(parsed)) fail('pending_queue_invalid_shape');
  let count = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++count > PROJECT_MODEL_BACKUP_LIMITS.maxValues || depth > PROJECT_MODEL_BACKUP_LIMITS.maxDepth) fail('pending_queue_limit');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) fail('unsafe_property');
      if (secretFields.has(key.replace(/[_-]/g, '').toLowerCase()) && child !== undefined && child !== null && child !== '') fail('plaintext_credential_field');
      visit(child, depth + 1);
    }
  };
  visit(parsed, 0);
}

interface EncodingContext {
  addBinary(bytes: Uint8Array): Promise<string>;
  signal?: AbortSignal;
  values: number;
}
async function encodeValue(input: unknown, context: EncodingContext): Promise<Encoded> {
  const seen = new Map<object, number>(), active = new Set<object>();
  const visit = async (value: unknown, depth: number): Promise<Encoded> => {
    checkAbort(context.signal);
    if (++context.values > PROJECT_MODEL_BACKUP_LIMITS.maxValues || depth > PROJECT_MODEL_BACKUP_LIMITS.maxDepth) fail('value_limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value
      : { t: 'number', v: Object.is(value, -0) ? '-0' : String(value) };
    if (value === undefined) return { t: 'undefined' };
    if (typeof value === 'bigint') return { t: 'bigint', v: value.toString() };
    if (typeof value !== 'object') return fail('unsupported_value');
    if (active.has(value)) fail('cyclic_value');
    const previous = seen.get(value);
    if (previous !== undefined) return { t: 'ref', id: previous };
    const id = seen.size;
    seen.set(value, id); active.add(value);
    try {
      if (value instanceof Date) return { t: 'date', id, v: Number.isNaN(value.getTime()) ? null : value.getTime() };
      if (value instanceof ArrayBuffer) return { t: 'buffer', id, path: await context.addBinary(new Uint8Array(value)) };
      if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return fail('unsupported_shared_buffer');
      if (ArrayBuffer.isView(value)) {
        if (!(value.buffer instanceof ArrayBuffer)) fail('unsupported_shared_buffer');
        const kind = value instanceof DataView ? 'DataView' : value.constructor.name;
        if (kind !== 'DataView' && !own(views, kind)) fail('unsupported_view');
        return { t: 'view', id, kind, buffer: await visit(value.buffer, depth + 1), offset: value.byteOffset,
          length: value instanceof DataView ? value.byteLength : (value as Uint8Array).length };
      }
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        if (value.size > PROJECT_MODEL_BACKUP_LIMITS.maxFileBytes) fail('binary_limit');
        const path = await context.addBinary(new Uint8Array(await value.arrayBuffer()));
        if (typeof File !== 'undefined' && value instanceof File) return { t: 'file', id, path, mime: value.type, name: value.name, lastModified: value.lastModified };
        return { t: 'blob', id, path, mime: value.type };
      }
      if (value instanceof Map) {
        const entries: Encoded[] = [];
        for (const [key, child] of value) {
          if (typeof key === 'string' && secretFields.has(key.replace(/[_-]/g, '').toLowerCase())
            && child !== undefined && child !== null && child !== '') fail('plaintext_credential_field');
          entries.push([await visit(key, depth + 1), await visit(child, depth + 1)]);
        }
        return { t: 'map', id, entries };
      }
      if (value instanceof Set) {
        const entries: Encoded[] = [];
        for (const child of value) entries.push(await visit(child, depth + 1));
        return { t: 'set', id, entries };
      }
      const prototype = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail('unsupported_object');
      if (Array.isArray(value)) {
        context.values += value.length;
        if (context.values > PROJECT_MODEL_BACKUP_LIMITS.maxValues) fail('value_limit');
      }
      if (Object.getOwnPropertySymbols(value).length) fail('unsupported_symbol');
      const entries: Encoded[] = [];
      for (const key of Object.getOwnPropertyNames(value)) {
        if (Array.isArray(value) && key === 'length') continue;
        if (Array.isArray(value) && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) >= value.length) fail('invalid_array_index');
        if (forbidden.has(key)) fail('unsafe_property');
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !own(descriptor, 'value')) fail('unsupported_property');
        const normalized = key.replace(/[_-]/g, '').toLowerCase();
        if (secretFields.has(normalized) && descriptor.value !== undefined && descriptor.value !== null && descriptor.value !== '') fail('plaintext_credential_field');
        entries.push([key, await visit(descriptor.value, depth + 1)]);
      }
      return Array.isArray(value) ? { t: 'array', id, length: value.length, entries }
        : { t: prototype === null ? 'null-object' : 'object', id, entries };
    } finally { active.delete(value); }
  };
  return visit(input, 0);
}

function decodeValue(input: unknown, binary: ReadonlyMap<string, Uint8Array>, used: Set<string>, budget: { values: number }): unknown {
  const references = new Map<number, unknown>(), declared = new Set<number>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++budget.values > PROJECT_MODEL_BACKUP_LIMITS.maxValues || depth > PROJECT_MODEL_BACKUP_LIMITS.maxDepth) fail('value_limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const tag = object(value, ['t', 'id', 'v', 'path', 'kind', 'buffer', 'offset', 'length', 'mime', 'name', 'lastModified', 'entries'], ['t']);
    const t = tag.t;
    const exact = (keys: string[]) => object(tag, keys);
    if (t === 'undefined') { exact(['t']); return undefined; }
    if (t === 'number') {
      exact(['t', 'v']);
      const numbers: Record<string, number> = { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 };
      if (typeof tag.v !== 'string' || !own(numbers, tag.v)) fail('invalid_number_tag');
      return numbers[tag.v];
    }
    if (t === 'bigint') { exact(['t', 'v']); if (typeof tag.v !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(tag.v)) fail('invalid_bigint'); return BigInt(tag.v); }
    if (t === 'ref') {
      exact(['t', 'id']); const id = integer(tag.id);
      if (!references.has(id)) fail('invalid_reference');
      return references.get(id);
    }
    const id = integer(tag.id);
    if (declared.has(id)) fail('duplicate_reference');
    declared.add(id);
    const bytes = () => {
      const path = assertProjectModelBackupPath(tag.path), found = binary.get(path);
      if (!path.startsWith('binary/') || !found) fail('missing_binary');
      // 共享对象使用 ref 标签；重复构造同一 payload 会绕过文件字节预算并放大内存。
      if (used.has(path)) fail('reused_binary_payload');
      used.add(path); return Uint8Array.from(found);
    };
    let result: unknown;
    if (t === 'date') {
      exact(['t', 'id', 'v']);
      if (tag.v !== null && (typeof tag.v !== 'number' || !Number.isFinite(tag.v))) fail('invalid_date');
      result = new Date(tag.v === null ? NaN : tag.v as number);
      if (tag.v !== null && (result as Date).getTime() !== tag.v) fail('invalid_date');
    } else if (t === 'buffer') { exact(['t', 'id', 'path']); result = bytes().buffer; }
    else if (t === 'blob' || t === 'file') {
      exact(t === 'blob' ? ['t', 'id', 'path', 'mime'] : ['t', 'id', 'path', 'mime', 'name', 'lastModified']);
      if (typeof tag.mime !== 'string' || tag.mime.length > 256) fail('invalid_mime');
      if (t === 'file') {
        if (typeof File === 'undefined' || typeof tag.name !== 'string' || tag.name.length > 1024) fail('unsupported_file');
        if (typeof tag.lastModified !== 'number' || !Number.isSafeInteger(tag.lastModified)) fail('invalid_file_time');
        result = new File([bytes().buffer], tag.name, { type: tag.mime, lastModified: tag.lastModified });
      } else result = new Blob([bytes().buffer], { type: tag.mime });
    } else if (t === 'view') {
      exact(['t', 'id', 'kind', 'buffer', 'offset', 'length']);
      const buffer = visit(tag.buffer, depth + 1);
      if (!(buffer instanceof ArrayBuffer)) fail('invalid_view_buffer');
      const offset = integer(tag.offset), length = integer(tag.length);
      try {
        if (tag.kind === 'DataView') result = new DataView(buffer, offset, length);
        else {
          if (typeof tag.kind !== 'string' || !own(views, tag.kind)) fail('unsupported_view');
          const Constructor = views[tag.kind as keyof typeof views] as new (buffer: ArrayBuffer, byteOffset: number, length: number) => ArrayBufferView;
          result = new Constructor(buffer, offset, length);
        }
      } catch { return fail('invalid_view'); }
    } else if (t === 'array' || t === 'object' || t === 'null-object') {
      exact(t === 'array' ? ['t', 'id', 'length', 'entries'] : ['t', 'id', 'entries']);
      const entries = array(tag.entries, PROJECT_MODEL_BACKUP_LIMITS.maxValues), keys = new Set<string>();
      const arrayLength = t === 'array' ? integer(tag.length, PROJECT_MODEL_BACKUP_LIMITS.maxValues) : 0;
      budget.values += arrayLength;
      if (budget.values > PROJECT_MODEL_BACKUP_LIMITS.maxValues) fail('value_limit');
      const target: ObjectRecord | unknown[] = t === 'array' ? new Array(arrayLength)
        : t === 'null-object' ? Object.create(null) as ObjectRecord : {};
      for (const entry of entries) {
        const pair = array(entry, 2);
        if (pair.length !== 2 || typeof pair[0] !== 'string' || forbidden.has(pair[0]) || keys.has(pair[0]) || (t === 'array' && pair[0] === 'length')) fail('invalid_property');
        keys.add(pair[0]);
        if (t === 'array' && /^(?:0|[1-9][0-9]*)$/.test(pair[0]) && Number(pair[0]) >= (target as unknown[]).length) fail('invalid_array_index');
        const child = visit(pair[1], depth + 1), normalized = pair[0].replace(/[_-]/g, '').toLowerCase();
        if (secretFields.has(normalized) && child !== undefined && child !== null && child !== '') fail('plaintext_credential_field');
        Object.defineProperty(target, pair[0], { value: child, enumerable: true, writable: true, configurable: true });
      }
      result = target;
    } else if (t === 'map' || t === 'set') {
      exact(['t', 'id', 'entries']);
      const entries = array(tag.entries, PROJECT_MODEL_BACKUP_LIMITS.maxValues);
      if (t === 'map') {
        const target = new Map<unknown, unknown>();
        for (const entry of entries) { const pair = array(entry, 2); if (pair.length !== 2) fail('invalid_map');
          const key = visit(pair[0], depth + 1); if (target.has(key)) fail('duplicate_map_key');
          const child = visit(pair[1], depth + 1);
          if (typeof key === 'string' && secretFields.has(key.replace(/[_-]/g, '').toLowerCase())
            && child !== undefined && child !== null && child !== '') fail('plaintext_credential_field');
          target.set(key, child); }
        result = target;
      } else {
        const target = new Set<unknown>();
        for (const entry of entries) { const child = visit(entry, depth + 1); if (target.has(child)) fail('duplicate_set_value'); target.add(child); }
        result = target;
      }
    } else return fail('unknown_value_tag');
    references.set(id, result);
    return result;
  };
  return visit(input, 0);
}

export async function createProjectModelBackup(source: ProjectModelBackupSource,
  options: { operationId: string; createdAt?: number; signal?: AbortSignal }): Promise<ProjectModelBackupBundle> {
  checkAbort(options.signal);
  const fixture = isProjectModelFixtureDatabaseName(source.databaseName) && source.schemaVersion === PROJECT_MODEL_STAGING_VERSION;
  if (source.databaseName !== DB_NAME && !isProjectModelFixtureDatabaseName(source.databaseName)
    || !Number.isSafeInteger(source.schemaVersion) || source.schemaVersion < 1 || !fixture && source.schemaVersion > DB_VERSION) fail('invalid_source');
  const schemas = source.stores.map((store) => parseSchema({ name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: store.indexes }, fixture));
  validateCoverage(source.databaseStoreNames, schemas, fixture);
  if (source.localStorage.length !== 1 || source.localStorage[0].key !== 'ai_canvas_pending_tasks'
    || (source.localStorage[0].value !== null && typeof source.localStorage[0].value !== 'string')) fail('incomplete_local_storage');
  assertPendingQueue(source.localStorage[0].value);
  const files = new Map<string, Uint8Array>(), descriptors: ProjectModelBackupFile[] = [];
  let totalBytes = 0, binaryCount = 0, recordCount = 0;
  const add = async (path: string, kind: ProjectModelBackupFile['kind'], bytes: Uint8Array) => {
    checkAbort(options.signal); assertProjectModelBackupPath(path);
    if (files.has(path) || bytes.byteLength > PROJECT_MODEL_BACKUP_LIMITS.maxFileBytes
      || files.size >= PROJECT_MODEL_BACKUP_LIMITS.maxFiles || totalBytes + bytes.byteLength > PROJECT_MODEL_BACKUP_LIMITS.maxTotalBytes) fail('backup_limit');
    const copy = Uint8Array.from(bytes);
    descriptors.push({ path, kind, bytes: copy.byteLength, sha256: await sha256BytesHex(copy) });
    files.set(path, copy); totalBytes += copy.byteLength;
  };
  const context: EncodingContext = { values: 0, signal: options.signal, addBinary: async (bytes) => {
    const path = 'binary/' + String(binaryCount++).padStart(6, '0') + '.bin'; await add(path, 'binary', bytes); return path;
  } };
  const stores: ProjectModelBackupStoreManifest[] = [];
  for (const [index, store] of source.stores.entries()) {
    const chunks: string[] = [], keys = new Set<string>();
    let pending: string[] = [], pendingBytes = 2;
    const flush = async () => {
      if (!pending.length) return;
      const path = 'stores/' + store.name + '/' + String(chunks.length).padStart(6, '0') + '.json';
      await add(path, 'records', encoder.encode('[' + pending.join(',') + ']')); chunks.push(path); pending = []; pendingBytes = 2;
    };
    for (const record of store.records) {
      if (++recordCount > PROJECT_MODEL_BACKUP_LIMITS.maxRecords) fail('record_limit');
      const key = normalizedKey(record.key);
      if (keys.has(key)) fail('duplicate_record_key'); keys.add(key);
      assertRecordKey(store, record.key, record.value);
      if (store.name === 'metadata' && !(fixture ? isProjectModelFixtureBackupMetadataKey(record.key) : isProjectModelBackupMetadataKey(record.key))) fail('unsupported_metadata');
      const encoded = await encodeValue({ key: record.key, value: record.value }, context);
      const text = JSON.stringify(encoded), count = encoder.encode(text).byteLength;
      if (count + 2 > PROJECT_MODEL_BACKUP_LIMITS.maxFileBytes) fail('record_limit');
      if (pending.length && pendingBytes + count + 1 > PROJECT_MODEL_BACKUP_LIMITS.chunkTargetBytes) await flush();
      pending.push(text); pendingBytes += count + 1;
    }
    await flush(); stores.push({ ...schemas[index], recordCount: store.records.length, chunks });
  }
  await add('local-storage.json', 'localStorage', jsonBytes(source.localStorage[0], PROJECT_MODEL_BACKUP_LIMITS.maxFileBytes));
  const manifest = parseManifest({ format: fixture ? PROJECT_MODEL_FIXTURE_BACKUP_FORMAT : PROJECT_MODEL_BACKUP_FORMAT, operationId: options.operationId, createdAt: options.createdAt ?? Date.now(),
    databaseName: source.databaseName, schemaVersion: source.schemaVersion, databaseStoreNames: source.databaseStoreNames, stores,
    localStorage: [{ key: 'ai_canvas_pending_tasks', path: 'local-storage.json' }], files: descriptors, totalBytes });
  jsonBytes(manifest, PROJECT_MODEL_BACKUP_LIMITS.maxManifestBytes);
  return { manifest, files };
}

async function readMaterial(port: ProjectModelBackupPort, manifest: ProjectModelBackupManifest, signal?: AbortSignal): Promise<ProjectModelBackupSource> {
  const files = new Map<string, Uint8Array>();
  for (const descriptor of manifest.files) {
    checkAbort(signal);
    const bytes = await port.read(descriptor.path, descriptor.bytes);
    checkAbort(signal);
    if (bytes.byteLength !== descriptor.bytes || await sha256BytesHex(bytes) !== descriptor.sha256) fail('content_digest_mismatch');
    checkAbort(signal);
    files.set(descriptor.path, bytes);
  }
  const binary = new Map(manifest.files.filter((file) => file.kind === 'binary').map((file) => [file.path, files.get(file.path)!]));
  const used = new Set<string>(), budget = { values: 0 };
  const stores = manifest.stores.map((store): ProjectModelBackupStore => {
    const records: ProjectModelBackupStore['records'] = [], keys = new Set<string>();
    for (const path of store.chunks) for (const item of array(readJson(files.get(path)!, PROJECT_MODEL_BACKUP_LIMITS.maxFileBytes), PROJECT_MODEL_BACKUP_LIMITS.maxRecords)) {
      const record = object(decodeValue(item, binary, used, budget), ['key', 'value']);
      const key = normalizedKey(record.key);
      if (keys.has(key)) fail('duplicate_record_key'); keys.add(key);
      assertRecordKey(store, record.key, record.value);
      if (store.name === 'metadata' && !(manifest.format === PROJECT_MODEL_FIXTURE_BACKUP_FORMAT
        ? isProjectModelFixtureBackupMetadataKey(record.key) : isProjectModelBackupMetadataKey(record.key))) fail('unsupported_metadata');
      records.push({ key: record.key as IDBValidKey, value: record.value });
      if (records.length > store.recordCount) fail('record_count_mismatch');
    }
    if (records.length !== store.recordCount) fail('record_count_mismatch');
    return { name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: store.indexes, records };
  });
  if (used.size !== binary.size) fail('unreferenced_binary');
  const local = object(readJson(files.get('local-storage.json')!, PROJECT_MODEL_BACKUP_LIMITS.maxFileBytes), ['key', 'value']);
  if (local.key !== 'ai_canvas_pending_tasks' || (local.value !== null && typeof local.value !== 'string')) fail('invalid_local_storage');
  assertPendingQueue(local.value);
  return { databaseName: manifest.databaseName, schemaVersion: manifest.schemaVersion, databaseStoreNames: manifest.databaseStoreNames, stores,
    localStorage: [{ key: 'ai_canvas_pending_tasks', value: local.value }] };
}

export async function readVerifiedProjectModelBackup(port: ProjectModelBackupPort,
  options: { signal?: AbortSignal } = {}): Promise<VerifiedProjectModelBackup> {
  checkAbort(options.signal);
  const complete = object(readJson(await port.read(COMPLETE_PATH, PROJECT_MODEL_BACKUP_LIMITS.maxCompleteBytes), PROJECT_MODEL_BACKUP_LIMITS.maxCompleteBytes),
    ['format', 'operationId', 'manifestSha256']);
  if (complete.format !== PROJECT_MODEL_BACKUP_FORMAT && complete.format !== PROJECT_MODEL_FIXTURE_BACKUP_FORMAT) fail('missing_completion');
  const bytes = await port.read(MANIFEST_PATH, PROJECT_MODEL_BACKUP_LIMITS.maxManifestBytes);
  checkAbort(options.signal);
  if (await sha256BytesHex(bytes) !== digest(complete.manifestSha256)) fail('manifest_digest_mismatch');
  const manifest = parseManifest(readJson(bytes, PROJECT_MODEL_BACKUP_LIMITS.maxManifestBytes));
  if (complete.operationId !== manifest.operationId || complete.format !== manifest.format) fail('operation_mismatch');
  const source = await readMaterial(port, manifest, options.signal);
  checkAbort(options.signal);
  return { status: 'verified', manifest, source };
}

/** 只有全部材料已从存储端读回且解码后才发布完成标记；失败保留未完成材料供诊断。 */
export async function writeVerifiedProjectModelBackup(bundle: ProjectModelBackupBundle, port: ProjectModelBackupPort,
  options: { signal?: AbortSignal } = {}): Promise<VerifiedProjectModelBackup> {
  checkAbort(options.signal);
  const manifest = parseManifest(bundle.manifest);
  if (bundle.files.size !== manifest.files.length || manifest.files.some((file) => !bundle.files.has(file.path))) fail('file_set_mismatch');
  for (const file of manifest.files) {
    checkAbort(options.signal);
    const bytes = bundle.files.get(file.path)!;
    if (bytes.byteLength !== file.bytes || await sha256BytesHex(bytes) !== file.sha256) fail('content_digest_mismatch');
    checkAbort(options.signal);
    await port.writeExclusive(file.path, bytes);
  }
  checkAbort(options.signal);
  const manifestBytes = jsonBytes(manifest, PROJECT_MODEL_BACKUP_LIMITS.maxManifestBytes);
  await port.writeExclusive(MANIFEST_PATH, manifestBytes);
  const persisted = await port.read(MANIFEST_PATH, PROJECT_MODEL_BACKUP_LIMITS.maxManifestBytes);
  if (await sha256BytesHex(persisted) !== await sha256BytesHex(manifestBytes)) fail('manifest_digest_mismatch');
  await readMaterial(port, parseManifest(readJson(persisted, PROJECT_MODEL_BACKUP_LIMITS.maxManifestBytes)), options.signal);
  const completion = jsonBytes({ format: manifest.format, operationId: manifest.operationId,
    manifestSha256: await sha256BytesHex(manifestBytes) }, PROJECT_MODEL_BACKUP_LIMITS.maxCompleteBytes);
  checkAbort(options.signal);
  await port.publishComplete(COMPLETE_PATH, completion);
  checkAbort(options.signal);
  return readVerifiedProjectModelBackup(port, options);
}
