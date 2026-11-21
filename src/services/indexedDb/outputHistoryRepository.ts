import type { HistoryQuery } from '../../types';
import { matchesHistoryQuery } from '../../utils/historyQuery';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { stripVerbatimPrefix } from '../fs/core';
import { deleteKeyCursorEntries } from './deleteKeyCursorEntries';
import { withRelocatedMedia } from './mediaRelocations';
import { projectHistoryRange, pruneProjectHistory } from './outputHistoryRetention';
import { openDB, STORE_HISTORY, STORE_METADATA } from './schema';

const FORGOTTEN_ASSET_PREFIX = 'forgotten-missing-asset:';
const FORGOTTEN_PATH_PREFIX = 'forgotten-missing-path:';
const FORGOTTEN_HISTORY_PREFIX = 'forgotten-missing-history:';
export const forgottenAssetKey = (assetId: string) => `${FORGOTTEN_ASSET_PREFIX}${encodeURIComponent(assetId)}`;
export const forgottenPathKey = (path: string) => `${FORGOTTEN_PATH_PREFIX}${encodeURIComponent(path)}`;
export const forgottenHistoryKey = (historyId: string) => `${FORGOTTEN_HISTORY_PREFIX}${encodeURIComponent(historyId)}`;
const MEDIA_HISTORY_TYPES = new Set(['ai-image', 'ai-animation', 'ai-panorama', 'ai-storyboard', 'ai-video', 'ai-audio',
  'source-image', 'source-video', 'source-audio']);

export function cleanupTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = value && typeof value === 'object' && 'forgottenAt' in value ? value.forgottenAt : undefined;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error('失效素材清理记录无效，请检查存储');
  }
  return timestamp;
}

/** Only output identity fields count; prompt text and input/reference fields are never matched. */
export function historyOutputKeys(record: HistoryRecord): string[] {
  const localKey = (reference: string | undefined) => {
    if (typeof reference !== 'string' || !reference.trim()) return undefined;
    const path = localMediaUrlToPath(reference) ?? reference;
    if (!/^[a-z]:[/\\]/i.test(path) && !path.startsWith('/') && !path.startsWith('\\\\')) return undefined;
    return imageHistoryReferenceKey(path);
  };
  // A saved copy owns its history even when its original remote/output URL is shared.
  if (typeof record.filePath === 'string' && record.filePath.trim()) {
    const path = localKey(record.filePath);
    return path ? [path] : [];
  }
  return [...new Set([record.mediaUrl, MEDIA_HISTORY_TYPES.has(record.nodeType) ? record.output : undefined]
    .map(localKey).filter((key): key is string => !!key))];
}

function withActiveHistory(tx: IDBTransaction, records: readonly HistoryRecord[], write: (active: HistoryRecord[]) => void): void {
  const paths = [...new Set(records.flatMap(historyOutputKeys))];
  const historyIds = [...new Set(records.map((record) => record.id))];
  if (!paths.length && !historyIds.length) { write([]); return; }
  const cutoffs = new Map<string, number>();
  const forgotten = new Set<string>();
  let remaining = paths.length + historyIds.length;
  const finish = () => {
    if (--remaining !== 0) return;
    write(records.filter((record) => !forgotten.has(record.id) && historyOutputKeys(record)
      .every((key) => !cutoffs.has(key) || record.timestamp > cutoffs.get(key)!)));
  };
  for (const historyId of historyIds) {
    const request = tx.objectStore(STORE_METADATA).get(forgottenHistoryKey(historyId));
    request.onsuccess = () => {
      if (request.result !== undefined) forgotten.add(historyId);
      finish();
    };
  }
  for (const path of paths) {
    const request = tx.objectStore(STORE_METADATA).get(forgottenPathKey(path));
    request.onsuccess = () => {
      try {
        const cutoff = cleanupTimestamp(request.result);
        if (cutoff !== undefined) cutoffs.set(path, cutoff);
        finish();
      } catch { tx.abort(); }
    };
  }
}

/** A cleared path must not recover its old prompt from an unchanged canvas node. */
export async function isAssetHistoryRecordActive(record: HistoryRecord): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    let active = false;
    withActiveHistory(tx, [record], (records) => { active = records.length === 1; });
    tx.oncomplete = () => resolve(active);
    tx.onerror = tx.onabort = () => reject(new Error('失效素材清理读取失败'));
  });
}

// ============================================
// History CRUD — AI 输出历史记录
// ============================================

export interface HistoryRecord {
  id: string;
  projectId: string;
  nodeId: string;
  nodeLabel: string;
  timestamp: number;
  prompt: string;
  output: string;
  nodeType: string;
  model: string;
  provider: string;
  status: string;
  error?: string;
  mediaUrl?: string;
  filePath?: string;
  relativePath?: string;
  storageRootRef?: string;
  params?: Record<string, unknown>;
}

export interface HistoryPageCursor {
  timestamp: number;
  id: string;
}



export interface HistoryPage {
  records: HistoryRecord[];
  nextCursor: HistoryPageCursor | null;
  hasMore: boolean;
}

/** 图片身份比较仅使用完整路径/地址；不按文件名猜测来源。 */
export function imageHistoryReferenceKey(reference: string | undefined): string | undefined {
  if (!reference || reference.startsWith('data:') || reference.startsWith('blob:')) return undefined;
  const path = stripVerbatimPrefix(localMediaUrlToPath(reference) ?? reference);
  if (/^[a-z]:[/\\]/i.test(path) || path.startsWith('/') || path.startsWith('\\\\')) {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  }
  // 普通网络地址保持查询参数与大小写，签名不同的地址不能推断为同一图片。
  return reference;
}

/** 预览时只读查询匹配的最新成功图片记录；不加载或切换 Store 历史面板。 */
export async function findImageHistoryByReferences(references: string[], projectId?: string, signal?: AbortSignal): Promise<HistoryRecord | null> {
  return findMediaHistoryByReferences(references, 'ai-image', projectId, signal);
}

export async function findVideoHistoryByReferences(references: string[], projectId?: string, signal?: AbortSignal): Promise<HistoryRecord | null> {
  return findMediaHistoryByReferences(references, 'ai-video', projectId, signal);
}

async function findMediaHistoryByReferences(references: string[], nodeType: 'ai-image' | 'ai-video', projectId?: string, signal?: AbortSignal): Promise<HistoryRecord | null> {
  const keys = new Set(references.map(imageHistoryReferenceKey).filter((key): key is string => !!key));
  if (!keys.size) return null;
  if (signal?.aborted) throw new DOMException('Preview closed', 'AbortError');
  if (projectId?.startsWith('c2-')) {
    const records = await getHistoryEntriesForExport(projectId);
    signal?.throwIfAborted();
    return records.find((record) => record.status === 'success'
      && (record.nodeType === nodeType || nodeType === 'ai-image' && record.nodeType === 'ai-animation')
      && [record.filePath, record.mediaUrl, record.output].some((reference) => {
        const key = imageHistoryReferenceKey(reference); return !!key && keys.has(key);
      })) ?? null;
  }
  const db = await openDB();
  if (signal?.aborted) throw new DOMException('Preview closed', 'AbortError');
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readonly');
    const store = tx.objectStore(STORE_HISTORY);
    const request = projectId
      ? store.index('projectId_timestamp_id').openCursor(projectHistoryRange(projectId), 'prev')
      : store.openCursor();
    let latest: HistoryRecord | null = null;
    let scanned = 0;
    const abort = () => { try { tx.abort(); } catch { /* 事务已结束 */ } };
    signal?.addEventListener('abort', abort, { once: true });
    tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(latest); };
    tx.onabort = () => {
      signal?.removeEventListener('abort', abort);
      reject(signal?.aborted ? new DOMException('Preview closed', 'AbortError') : tx.error ?? new Error('生成记录读取失败'));
    };
    request.onerror = () => { /* 由事务统一报告读取失败 */ };
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (++scanned > 100_000) {
        reject(new Error('生成记录过多，无法完成媒体来源查询'));
        abort(); return;
      }
      const record = cursor.value as HistoryRecord;
      if ((record.nodeType === nodeType || nodeType === 'ai-image' && record.nodeType === 'ai-animation') && record.status === 'success'
        && [record.filePath, record.mediaUrl, record.output].some((reference) => {
          const key = imageHistoryReferenceKey(reference); return !!key && keys.has(key);
        }) && (!latest || record.timestamp > latest.timestamp || record.timestamp === latest.timestamp && record.id > latest.id)) {
        withActiveHistory(tx, [record], (active) => {
          if (active.length) latest = record;
          cursor.continue();
        });
        return;
      }
      cursor.continue();
    };
    if (signal?.aborted) abort();
  });
}

const HISTORY_MIGRATION_PREFIX = 'output-history-v1:';

const nativeHistoryProjectionKey = (id: string) => `native-output-history-projected:${id}`;

/** 先读消费标记，避免每次打开面板都重验已投影的媒体文件。 */
export async function getUnprojectedNativeOutputHistory(records: HistoryRecord[]): Promise<HistoryRecord[]> {
  if (!records.length) return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    const unseen = new Set<string>();
    for (const record of records) {
      const request = tx.objectStore(STORE_METADATA).get(nativeHistoryProjectionKey(record.id));
      request.onsuccess = () => { if (request.result === undefined) unseen.add(record.id); };
    }
    tx.oncomplete = () => resolve(records.filter((record) => unseen.has(record.id)));
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('新项目输出历史标记读取失败'));
  });
}

/** 历史与消费标记原子写入；删除、清空或16条裁剪后不得被outbox再次补回。 */
export async function putNativeOutputHistoryEntries(records: HistoryRecord[]): Promise<void> {
  if (!records.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readwrite');
    const store = tx.objectStore(STORE_HISTORY), metadata = tx.objectStore(STORE_METADATA);
    for (const record of records) {
      const request = metadata.get(nativeHistoryProjectionKey(record.id));
      request.onsuccess = () => {
        if (request.result !== undefined) return;
        const existing = store.index('projectId_timestamp_id').getAll(projectHistoryRange(record.projectId));
        existing.onsuccess = () => {
          // 导入已保存完整历史时，不再把相同文件的无原稿补记添加为第二条。
          const duplicate = (existing.result as HistoryRecord[]).some((entry) => entry.id === record.id
            || record.params?.originalInputUnavailable === true && entry.status === 'success'
              && entry.relativePath === record.relativePath && entry.storageRootRef === record.storageRootRef
              && entry.nodeType === record.nodeType);
          withActiveHistory(tx, [record], (active) => {
            if (!duplicate) for (const entry of active) store.put(entry);
            metadata.put({ id: nativeHistoryProjectionKey(record.id), projectId: record.projectId });
            pruneProjectHistory(store, record.projectId);
          });
        };
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('新项目输出历史投影失败'));
  });
}

async function syncNativeHistory(projectId: string): Promise<void> {
  // 前缀只减少旧项目开销；实际身份由新库只读查询确认，不创建或迁移任何项目。
  if (!projectId.startsWith('c2-')) return;
  const { syncNativeOutputHistory } = await import('../nativeOutputHistorySync');
  await syncNativeOutputHistory(projectId);
}

async function nativeHistoryView(projectId: string, records: HistoryRecord[]): Promise<HistoryRecord[]> {
  if (!projectId.startsWith('c2-')) return records;
  const { hydrateNativeOutputHistoryRecords } = await import('../nativeOutputHistorySync');
  return hydrateNativeOutputHistoryRecords(projectId, records);
}

async function trimProjectHistory(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    pruneProjectHistory(tx.objectStore(STORE_HISTORY), projectId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 保存单条历史记录 */
export async function putHistoryEntry(record: HistoryRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    withRelocatedMedia(tx, record, (next) => {
      withActiveHistory(tx, [next], (active) => {
        for (const entry of active) store.put(entry);
        if (active.length) pruneProjectHistory(store, record.projectId);
      });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

/** 在同一事务内写入旧节点中的历史记录。 */
export async function putHistoryEntries(records: HistoryRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    withRelocatedMedia(tx, records, (next) => {
      withActiveHistory(tx, next, (active) => {
        for (const record of active) store.put(record);
        for (const projectId of new Set(active.map((record) => record.projectId))) pruneProjectHistory(store, projectId);
      });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

/** 删除单条历史记录 */
export async function deleteHistoryEntryFromDb(projectId: string, id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as HistoryRecord | undefined;
      if (record?.projectId === projectId) store.delete(id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 按时间倒序读取一页历史；筛选在游标扫描期间完成，不保留未命中记录。 */
export async function getHistoryEntriesPage(
  projectId: string,
  limit: number,
  cursor: HistoryPageCursor | null = null,
  query: HistoryQuery = {},
): Promise<HistoryPage> {
  await syncNativeHistory(projectId);
  const db = await openDB();
  const page = await new Promise<HistoryPage>((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readonly');
    const index = tx.objectStore(STORE_HISTORY).index('projectId_timestamp_id');
    const request = index.openCursor(projectHistoryRange(projectId, cursor), 'prev');
    const records: HistoryRecord[] = [];
    let nextCursor: HistoryPageCursor | null = null;
    let hasMore = false;
    tx.oncomplete = () => resolve({ records, nextCursor: hasMore ? nextCursor : null, hasMore });
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('生成记录读取失败'));

    request.onsuccess = () => {
      const current = request.result;
      if (!current) return;
      if (records.length >= limit) {
        hasMore = true;
        return;
      }

      const record = current.value as HistoryRecord;
      if (matchesHistoryQuery(record, query)) {
        withActiveHistory(tx, [record], (active) => {
          if (active.length) {
            records.push(record);
            nextCursor = { timestamp: record.timestamp, id: record.id };
          }
          current.continue();
        });
        return;
      }
      current.continue();
    };
    request.onerror = () => { /* 事务统一报告。 */ };
  });
  return { ...page, records: await nativeHistoryView(projectId, page.records) };
}

/** 仅在用户显式导出时扫描并返回全部匹配记录。 */
export async function getHistoryEntriesForExport(
  projectId: string,
  query: HistoryQuery = {},
): Promise<HistoryRecord[]> {
  await syncNativeHistory(projectId);
  const db = await openDB();
  const records = await new Promise<HistoryRecord[]>((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readonly');
    const request = tx.objectStore(STORE_HISTORY)
      .index('projectId_timestamp_id')
      .openCursor(projectHistoryRange(projectId), 'prev');
    const records: HistoryRecord[] = [];
    tx.oncomplete = () => resolve(records);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('生成记录读取失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as HistoryRecord;
      if (matchesHistoryQuery(record, query)) {
        withActiveHistory(tx, [record], (active) => { records.push(...active); cursor.continue(); });
        return;
      }
      cursor.continue();
    };
    request.onerror = () => { /* 事务统一报告。 */ };
  });
  return nativeHistoryView(projectId, records);
}

/** 使用 nodeId 索引读取指定节点的全部历史记录，按生成时间倒序返回。 */
export async function getNodeHistoryEntries(projectId: string, nodeId: string): Promise<HistoryRecord[]> {
  await syncNativeHistory(projectId);
  const db = await openDB();
  const entries = await new Promise<HistoryRecord[]>((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_METADATA], 'readonly');
    let records: HistoryRecord[] = [];
    const request = tx.objectStore(STORE_HISTORY)
      .index('projectId_nodeId')
      .getAll(IDBKeyRange.only([projectId, nodeId]));
    request.onsuccess = () => {
      withActiveHistory(tx, request.result as HistoryRecord[], (active) => {
        records = active.sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id));
      });
    };
    tx.oncomplete = () => resolve(records);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('生成记录读取失败'));
  });
  return nativeHistoryView(projectId, entries);
}

export async function getHistoryEntryCount(projectId: string): Promise<number> {
  await syncNativeHistory(projectId);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_HISTORY, 'readonly')
      .objectStore(STORE_HISTORY)
      .index('projectId_timestamp_id')
      .count(projectHistoryRange(projectId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function hasCompletedHistoryMigration(projectId: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA, 'readonly')
      .objectStore(STORE_METADATA)
      .get(`${HISTORY_MIGRATION_PREFIX}${projectId}`);
    request.onsuccess = () => resolve(Boolean(request.result));
    request.onerror = () => reject(request.error);
  });
}

export async function markHistoryMigrationCompleted(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    tx.objectStore(STORE_METADATA).put({
      id: `${HISTORY_MIGRATION_PREFIX}${projectId}`,
      completedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 把 v14 及更早版本中可由节点 ID 确定归属的历史记录认领到当前项目。 */
export async function claimLegacyHistoryEntries(
  projectId: string,
  nodeIds: readonly string[],
): Promise<void> {
  const uniqueNodeIds = [...new Set(nodeIds)];
  if (uniqueNodeIds.length === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const nodeIndex = tx.objectStore(STORE_HISTORY).index('nodeId');
    for (const nodeId of uniqueNodeIds) {
      const request = nodeIndex.openCursor(IDBKeyRange.only(nodeId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value as HistoryRecord & { projectId?: string };
        if (!record.projectId) cursor.update({ ...record, projectId });
        cursor.continue();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await trimProjectHistory(projectId);
}

/** 清空指定项目的全部历史记录 */
export async function clearAllHistoryEntries(projectId: string): Promise<void> {
  await syncNativeHistory(projectId);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    const request = store
      .index('projectId_timestamp_id')
      .openKeyCursor(projectHistoryRange(projectId));
    deleteKeyCursorEntries(store, request);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('历史记录清理失败'));
  });
}

/** 使用 nodeId 索引批量删除指定节点的历史记录。 */
export async function deleteNodeHistoryEntries(projectId: string, nodeId: string): Promise<void> {
  await syncNativeHistory(projectId);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_HISTORY);
    const request = store
      .index('projectId_nodeId')
      .openKeyCursor(IDBKeyRange.only([projectId, nodeId]));
    deleteKeyCursorEntries(store, request);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('节点历史记录清理失败'));
  });
}
