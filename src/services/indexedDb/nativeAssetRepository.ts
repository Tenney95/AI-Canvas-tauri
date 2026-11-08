/** 新项目的恢复素材副本：索引和项目在同一数据库提交，不修改旧/全局素材身份。 */
import type { AssetIndexRecord, AssetMetaRecord } from '../indexedDbService';
import type { AssetImageRecord } from '../../types/assetImage';
import type { ProjectModelTransferAggregate } from '../../types/projectModelTransfer';
import { invoke } from '@tauri-apps/api/core';
import { safeExchangePath } from '../projectExchangeDomain';
import { configValuesEqual } from '../configPatch';
import { stripVerbatimPrefix } from '../fs/core';
import { EXCHANGE, ROOTS, REVISIONS, openNativeProjectDatabase, transact, assertNoPendingNativeSharedSync, type NativeProjectOptions } from './nativeProjectRepository';

export interface NativeAssetRecord {
  assetId: string; projectId: string; ownerId: string; rootRef: string; primary: boolean; relativePath: string;
  bytes: number; sha256: string; createdAt: number;
  lastUsedAt?: number;
  tags?: Omit<AssetMetaRecord, 'path'>;
  images?: AssetImageRecord[];
}
export const isNativeAssetId = (id: unknown): id is string => typeof id === 'string'
  && /^na2-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const key = (id: string) => `asset:${id}`;
const get = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const plain = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Object.getOwnPropertySymbols(value).length
  && Object.entries(Object.getOwnPropertyDescriptors(value)).every(([name, descriptor]) => fields.includes(name) && 'value' in descriptor && descriptor.enumerable);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (prefix: string, value: unknown) => typeof value === 'string'
  && new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
function unwrap(value: unknown, assetId?: string): NativeAssetRecord | undefined {
  if (value === undefined) return undefined;
  if (!plain(value, ['projectId', 'kind', 'record']) || value.kind !== 'native-asset-v1') throw new Error('恢复素材索引记录损坏');
  const record = value.record as NativeAssetRecord; validateNativeAsset(record);
  if (value.projectId !== key(record.assetId) || assetId !== undefined && record.assetId !== assetId) throw new Error('恢复素材索引身份错位');
  return record;
}

export function validateNativeAsset(record: NativeAssetRecord): void {
  if (!plain(record, ['assetId', 'projectId', 'ownerId', 'rootRef', 'primary', 'relativePath', 'bytes', 'sha256', 'createdAt', 'lastUsedAt', 'tags', 'images'])) {
    throw new Error('恢复素材索引包含未知或不可序列化字段');
  }
  if (!identity('p2', record.projectId) || !identity('r2', record.rootRef) || typeof record.relativePath !== 'string'
    || typeof record.ownerId !== 'string' || !digest(record.sha256)) throw new Error('恢复素材身份无效');
  if (record.tags !== undefined && !plain(record.tags, ['assetId', 'tags', 'taggedBy', 'updatedAt'])
    || record.images !== undefined && (!Array.isArray(record.images) || record.images.some((image) =>
      !plain(image, ['id', 'assetId', 'contentDigest', 'fileName', 'prompt', 'references', 'revision', 'updatedAt'])))) {
    throw new Error('恢复素材元数据包含未知字段');
  }
  if (!record || !isNativeAssetId(record.assetId) || !/^p2-[a-f0-9-]{36}$/.test(record.projectId)
    || !/^r2-[a-f0-9-]{36}$/.test(record.rootRef) || typeof record.primary !== 'boolean' || !record.ownerId || safeExchangePath(record.relativePath) !== record.relativePath
    || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)
    || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || record.lastUsedAt !== undefined && !integer(record.lastUsedAt)
    || record.tags && (record.tags.assetId !== record.assetId || Object.hasOwn(record.tags, 'path')
      || !Array.isArray(record.tags.tags) || record.tags.tags.some((tag) => typeof tag !== 'string'))
    || record.images && (!Array.isArray(record.images) || record.images.some((image) => typeof image.id !== 'string' || !digest(image.contentDigest) || image.assetId !== record.assetId
      || image.id !== `asset-image:${encodeURIComponent(record.assetId)}:${image.contentDigest}`
      || !digest(image.contentDigest) || !Array.isArray(image.references)))) throw new Error('恢复素材索引无效');
  if (!identity('p2', record.projectId) || !identity('r2', record.rootRef)
    || record.ownerId !== record.projectId && !identity('c2', record.ownerId)) throw new Error('恢复素材归属无效');
  if (record.tags && (!plain(record.tags, ['assetId', 'tags', 'taggedBy', 'updatedAt']) || record.tags.tags.length > 16
    || record.tags.tags.some((tag) => !tag.trim() || tag.length > 40) || !integer(record.tags.updatedAt)
    || record.tags.taggedBy !== undefined && !['manual', 'comfyui', 'vision'].includes(record.tags.taggedBy))) throw new Error('恢复素材标签无效');
  if (record.images && (record.images.length > 1000 || new Set(record.images.map((image) => image.id)).size !== record.images.length)) {
    throw new Error('恢复图片版本重复或过多');
  }
  for (const image of record.images ?? []) {
    if (!plain(image, ['id', 'assetId', 'contentDigest', 'fileName', 'prompt', 'references', 'revision', 'updatedAt'])
      || !text(image.fileName, 512) || /[\\/\u0000]/.test(image.fileName) || !text(image.prompt, 1_000_000)
      || !integer(image.revision) || !integer(image.updatedAt) || image.references.length > 1000) throw new Error('恢复图片元数据无效');
    const references = new Set<string>();
    for (const reference of image.references) {
      if (!plain(reference, ['id', 'name', 'relativePath', 'digest', 'bytes']) || !text(reference.id, 256) || !reference.id
        || references.has(reference.id) || !text(reference.name, 512) || !digest(reference.digest) || !integer(reference.bytes) || typeof reference.relativePath !== 'string'
        || safeExchangePath(reference.relativePath) !== reference.relativePath) throw new Error('恢复图片参考素材无效');
      references.add(reference.id);
    }
  }
}

export async function addNativeAssetsInTransaction(tx: IDBTransaction, records: readonly NativeAssetRecord[],
  target: Pick<ProjectModelTransferAggregate, 'project' | 'canvases'>): Promise<void> {
  const ids = new Set<string>(), paths = new Set<string>();
  for (const record of records) {
    validateNativeAsset(record);
    if (record.projectId !== target.project.id || !target.project.storageBindings.some((root) => root.rootRef === record.rootRef)
      || record.primary !== (record.rootRef === target.project.storageRootRef)
      || record.ownerId !== target.project.id && !target.canvases.some((canvas) => canvas.id === record.ownerId
        && canvas.projectId === record.projectId && canvas.storageRootRef === record.rootRef)) throw new Error('恢复素材与目标项目归属不一致');
    if (ids.has(record.assetId)) throw new Error('恢复素材身份重复'); ids.add(record.assetId);
    const location = JSON.stringify([record.rootRef, record.relativePath.normalize('NFC').toLowerCase()]);
    if (paths.has(location)) throw new Error('同一恢复路径具有多个素材身份'); paths.add(location);
    const current = unwrap(await get(tx.objectStore(EXCHANGE).get(key(record.assetId))), record.assetId);
    if (current && !configValuesEqual(current, record)) throw new Error('恢复素材身份已被占用');
    if (!current) await get(tx.objectStore(EXCHANGE).add({ projectId: key(record.assetId), kind: 'native-asset-v1', record }));
  }
}

export async function readNativeAssets(options: NativeProjectOptions = {}): Promise<NativeAssetRecord[]> {
  const db = await openNativeProjectDatabase(false, options); if (!db) return [];
  try { return await transact(db, 'readonly', options, async (tx) => {
    const rows = await get(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound('asset:', 'asset:\uffff'))) as unknown[];
    if (rows.length > 100_000) throw new Error('新项目素材索引过多');
    const records = rows.map((row) => unwrap(row)!);
    const roots = new Map<string, boolean>();
    for (const record of records) if (!roots.has(record.projectId)) roots.set(record.projectId, !!await get(tx.objectStore(ROOTS).get(record.projectId)));
    return records.filter((record) => roots.get(record.projectId));
  }, [EXCHANGE, ROOTS]); } finally { db.close(); }
}

export async function readNativeAsset(assetId: string, options: NativeProjectOptions = {}): Promise<NativeAssetRecord | undefined> {
  if (!isNativeAssetId(assetId)) throw new Error('新项目素材身份无效');
  const db = await openNativeProjectDatabase(false, options); if (!db) return undefined;
  try { return await transact(db, 'readonly', options, async (tx) => {
    const record = unwrap(await get(tx.objectStore(EXCHANGE).get(key(assetId))), assetId);
    if (!record) return undefined;
    return await get(tx.objectStore(ROOTS).get(record.projectId)) ? record : undefined;
  }, [EXCHANGE, ROOTS]); } finally { db.close(); }
}

export async function resolveNativeAssetIndex(record: NativeAssetRecord, knownRootPath?: string): Promise<AssetIndexRecord> {
  validateNativeAsset(record);
  const resolvedRoot = knownRootPath ?? (record.primary ? await invoke<string>('resolve_native_project_media_root', { projectId: record.projectId })
    : await invoke<string>('resolve_native_project_media_subroot', { projectId: record.projectId, rootRef: record.rootRef, create: false }));
  const rootPath = stripVerbatimPrefix(resolvedRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  return { assetId: record.assetId, path: `${rootPath.replace(/[\\/]+$/, '')}/${record.relativePath}`, rootPath,
    relativePath: record.relativePath, projectId: record.ownerId, source: 'project', size: record.bytes,
    mtimeMs: 0, fingerprint: `${record.bytes}:0`, status: 'online', updatedAt: record.createdAt,
    ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }) };
}

export async function updateNativeAsset(assetId: string, change: (record: NativeAssetRecord) => NativeAssetRecord,
  options: NativeProjectOptions = {}): Promise<void> {
  const db = await openNativeProjectDatabase(false, options); if (!db) throw new Error('新项目素材不存在');
  try { await transact(db, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') throw new Error('当前存储不支持耐久素材事务');
    const record = unwrap(await get(tx.objectStore(EXCHANGE).get(key(assetId))), assetId);
    if (!record || !await get(tx.objectStore(ROOTS).get(record.projectId))) throw new Error('新项目素材不存在');
    await assertNoPendingNativeSharedSync(tx, record.projectId);
    const next = change(structuredClone(record)); validateNativeAsset(next);
    const { tags: _oldTags, images: _oldImages, lastUsedAt: _oldUsed, ...before } = record;
    const { tags: _tags, images: _images, lastUsedAt: _used, ...after } = next;
    if (!configValuesEqual(before, after)) throw new Error('恢复素材身份与文件绑定不能被改写');
    await get(tx.objectStore(EXCHANGE).put({ projectId: key(assetId), kind: 'native-asset-v1', record: next }));
    if (!configValuesEqual(record.tags, next.tags) || !configValuesEqual(record.images, next.images)) {
      const revision = await get(tx.objectStore(REVISIONS).get(next.projectId)) as { projectId: string; changeRevision: number } | undefined;
      if (!revision || revision.projectId !== next.projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0 || revision.changeRevision >= Number.MAX_SAFE_INTEGER) throw new Error('素材所属项目版本无效');
      await get(tx.objectStore(REVISIONS).put({ ...revision, changeRevision: revision.changeRevision + 1 }));
    }
  }, [EXCHANGE, ROOTS, REVISIONS, 'nativeTransferJournal'], true); } finally { db.close(); }
}
