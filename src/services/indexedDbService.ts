/**
 * indexedDbService IndexedDB 持久化服务 — 浏览器端本地存储，保存项目、工作流、应用配置等数据
 */
import type { AgentTask } from '../types/agent';
import { markMcpTaskDeleted } from './indexedDb/agentTaskRepository';
import type { StoryGraph, StoryGraphPatch } from '../types/storyGraph';
import { applyStoryGraphPatch, normalizeStoryGraph } from './storyGraphService';
import type { ProjectMemory } from '../types/memory';
import { assertDramaAssetWriteCurrent, type DramaAssetWriteOptions } from '../types/dramaAssets';
import type { ProjectVisualDescription } from '../types/visualMemory';
import type { AssetUsageRecord } from '../types/assetUsage';
import { StorageError } from './storageDiagnostics';
import { configValuesEqual } from './configPatch';
import { createDurableSettingsTransaction } from './indexedDb/catalogRepository';
import {
  openDB,
  STORE_AGENT_TASKS,
  STORE_ASSET_INDEX,
  STORE_ASSET_META,
  STORE_ASSET_META_V2,
  STORE_CHAT_CONVERSATIONS,
  STORE_CHAT_MESSAGES,
  STORE_HISTORY,
  STORE_METADATA,
  STORE_PROJECT_MEMORIES,
  STORE_PROJECT_VISUAL_DESCRIPTIONS,
  STORE_PROJECT_SUMMARIES,
  STORE_PROJECTS,
  STORE_PROJECT_EXCHANGE_STATES,
  STORE_TOOLBAR_LAYOUTS,
} from './indexedDb/schema';
import {
  toProjectSummaryRecord,
  normalizeProjectSeriesInfo,
  type ProjectSummaryRecord,
} from './indexedDb/projectSummary';

import { withRelocatedMedia } from './indexedDb/mediaRelocations';
import { projectHistoryRange } from './indexedDb/outputHistoryRetention';
import { deleteKeyCursorEntries } from './indexedDb/deleteKeyCursorEntries';
import { cleanupTimestamp, forgottenAssetKey, forgottenHistoryKey, forgottenPathKey,
  historyOutputKeys, imageHistoryReferenceKey, type HistoryRecord } from './indexedDb/outputHistoryRepository';
export type { HistoryQuery } from '../types';
export {
  isAssetHistoryRecordActive,
  type HistoryRecord,
  type HistoryPageCursor,
  type HistoryPage,
  imageHistoryReferenceKey,
  findImageHistoryByReferences,
  findVideoHistoryByReferences,
  getUnprojectedNativeOutputHistory,
  putNativeOutputHistoryEntries,
  putHistoryEntry,
  putHistoryEntries,
  deleteHistoryEntryFromDb,
  getHistoryEntriesPage,
  getHistoryEntriesForExport,
  getNodeHistoryEntries,
  getHistoryEntryCount,
  hasCompletedHistoryMigration,
  markHistoryMigrationCompleted,
  claimLegacyHistoryEntries,
  clearAllHistoryEntries,
  deleteNodeHistoryEntries,
} from './indexedDb/outputHistoryRepository';
import { withLegacyProjectWrite } from './indexedDb/legacyProjectWriteGuard';
import { isProjectSnapshotDataUrl } from './projectSnapshotValidation';
import type { ChatConversationRecord, ChatMessageRecord } from './indexedDb/chatConversationRepository';

const LAST_ACTIVE_PROJECT_KEY = 'last-active-project';
const RECENT_ASSET_USAGE_KEY = 'recent-asset-usage';
const MAX_RECENT_ASSET_USAGE = 10;
/** Old identities stay retired; an explicit new import receives an independent asset ID. */
export function withActiveAsset(tx: IDBTransaction, assetId: string, write: () => void, onForgotten: () => void): void {
  if (assetId.startsWith('na2-')) { onForgotten(); tx.abort(); return; }
  const request = tx.objectStore(STORE_METADATA).get(forgottenAssetKey(assetId));
  request.onsuccess = () => {
    if (request.result !== undefined) {
      onForgotten();
      try { tx.abort(); } catch { /* 调用方可能已经中止事务。 */ }
      return;
    }
    write();
  };
}

export async function getAssetCleanupTime(references: readonly string[], signal?: AbortSignal): Promise<number | undefined> {
  signal?.throwIfAborted();
  const paths = [...new Set(references.map(imageHistoryReferenceKey).filter((key): key is string => !!key))];
  if (!paths.length) return undefined;
  const db = await openDB();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    let latest: number | undefined;
    let failure: unknown;
    const abort = () => { try { tx.abort(); } catch { /* 已结束。 */ } };
    signal?.addEventListener('abort', abort, { once: true });
    for (const path of paths) {
      const request = tx.objectStore(STORE_METADATA).get(forgottenPathKey(path));
      request.onsuccess = () => {
        try {
          const cutoff = cleanupTimestamp(request.result);
          if (cutoff !== undefined) latest = latest === undefined ? cutoff : Math.max(latest, cutoff);
        } catch (error) { failure = error; abort(); }
      };
    }
    const cleanup = () => signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(latest); };
    tx.onerror = tx.onabort = () => {
      cleanup(); reject(signal?.aborted ? new DOMException('失效素材清理已取消', 'AbortError')
        : failure ?? new Error('失效素材清理读取失败'));
    };
    if (signal?.aborted) abort();
  });
}

function validAssetUsageTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function latestAssetUsageTime(...values: unknown[]): number | undefined {
  let latest: number | undefined;
  for (const value of values) {
    if (validAssetUsageTime(value) && (latest === undefined || value > latest)) latest = value;
  }
  return latest;
}

function normalizeAssetUsage(value: unknown): AssetUsageRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((entry): entry is AssetUsageRecord => {
    if (!entry || typeof entry !== 'object' || typeof entry.assetId !== 'string'
      || !entry.assetId.trim() || entry.assetId.length > 256
      || !validAssetUsageTime(entry.usedAt)) return false;
    return true;
  }).sort((a, b) => b.usedAt - a.usedAt).filter((entry) => {
    if (seen.has(entry.assetId)) return false;
    seen.add(entry.assetId);
    return true;
  }).slice(0, MAX_RECENT_ASSET_USAGE).map(({ assetId, usedAt }) => ({ assetId, usedAt }));
}

export async function getRecentAssetUsage(): Promise<AssetUsageRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    const request = tx.objectStore(STORE_METADATA).get(RECENT_ASSET_USAGE_KEY);
    request.onsuccess = () => resolve(normalizeAssetUsage(request.result?.entries));
    request.onerror = () => reject(request.error);
  });
}

/** 只读取当前列表的稳定 ID；旧库仍保留的最近十项可作为时间回退，不补造更早历史。 */
export async function getAssetLastUsedTimes(assetIds: readonly string[]): Promise<Map<string, number>> {
  if (assetIds.some((id) => id.startsWith('na2-'))) {
    const native = await import('./indexedDb/nativeAssetRepository');
    const result = await getAssetLastUsedTimes(assetIds.filter((id) => !id.startsWith('na2-')));
    for (const id of assetIds.filter((id) => id.startsWith('na2-'))) {
      const row = await native.readNativeAsset(id);
      if (row?.lastUsedAt !== undefined) result.set(id, row.lastUsedAt);
    }
    return result;
  }
  const ids = new Set(assetIds.filter((id) => typeof id === 'string' && id.trim() && id.length <= 256));
  if (!ids.size) return new Map<string, number>();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ASSET_INDEX, STORE_METADATA], 'readonly');
    const times = new Map<string, number>();
    const merge = (assetId: string, time: unknown) => {
      const latest = latestAssetUsageTime(times.get(assetId), time);
      if (latest !== undefined) times.set(assetId, latest);
    };
    const recent = tx.objectStore(STORE_METADATA).get(RECENT_ASSET_USAGE_KEY);
    recent.onsuccess = () => {
      for (const entry of normalizeAssetUsage(recent.result?.entries)) {
        if (ids.has(entry.assetId)) merge(entry.assetId, entry.usedAt);
      }
    };
    const store = tx.objectStore(STORE_ASSET_INDEX);
    for (const assetId of ids) {
      const request = store.get(assetId);
      request.onsuccess = () => merge(assetId, request.result?.lastUsedAt);
    }
    tx.oncomplete = () => resolve(times);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('资产使用时间读取失败'));
  });
}

/** 原子维护最近十项与全量索引时间，多个窗口/旧扫描不能覆盖较新的使用记录。 */
export async function recordRecentAssetUsage(assetId: string, usedAt = Date.now()): Promise<void> {
  if (normalizeAssetUsage([{ assetId, usedAt }]).length !== 1) throw new Error('最近使用记录无效');
  if (assetId.startsWith('na2-')) return (await import('./indexedDb/nativeAssetRepository')).updateNativeAsset(assetId,
    (record) => ({ ...record, lastUsedAt: Math.max(record.lastUsedAt ?? 0, usedAt) }));
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_METADATA, STORE_ASSET_INDEX], 'readwrite');
    const store = tx.objectStore(STORE_METADATA);
    let forgotten = false;
    withActiveAsset(tx, assetId, () => {
      const request = store.get(RECENT_ASSET_USAGE_KEY);
      request.onsuccess = () => {
        const previous = normalizeAssetUsage(request.result?.entries);
        const existing = previous.find((entry) => entry.assetId === assetId);
        const assetStore = tx.objectStore(STORE_ASSET_INDEX);
        // 旧库只在 metadata 留有十项；裁剪前保留仍可恢复的真实时间，不为缺失资产造索引。
        for (const entry of previous) {
          if (entry.assetId === assetId) continue;
          const legacy = assetStore.get(entry.assetId);
          legacy.onsuccess = () => {
            const record = legacy.result as AssetIndexRecord | undefined;
            if (!record) return;
            const lastUsedAt = latestAssetUsageTime(record.lastUsedAt, entry.usedAt)!;
            if (lastUsedAt !== record.lastUsedAt) assetStore.put({ ...record, lastUsedAt });
          };
        }
        const indexed = assetStore.get(assetId);
        indexed.onsuccess = () => {
          const record = indexed.result as AssetIndexRecord | undefined;
          const lastUsedAt = latestAssetUsageTime(usedAt, existing?.usedAt, record?.lastUsedAt)!;
          const entries = normalizeAssetUsage([
            { assetId, usedAt: lastUsedAt },
            ...previous.filter((entry) => entry.assetId !== assetId),
          ]);
          store.put({ id: RECENT_ASSET_USAGE_KEY, entries });
          if (record) assetStore.put({ ...record, lastUsedAt });
        };
      };
    }, () => { forgotten = true; });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error(forgotten ? '素材已被清理，请重新加载后重试' : '最近使用记录保存失败'));
  });
}

export interface ProjectRecord extends ProjectSummaryRecord {
  nodes: unknown;
  edges: unknown;
  dramaAssets?: unknown;
}

export * from './indexedDb/catalogRepository';
export * from './indexedDb/videoEditorRepository';

/** 保存整个项目（含 nodes/edges）到 IndexedDB */
export async function saveProjectToDb(record: ProjectRecord, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const summary = toProjectSummaryRecord(record);
  if (!summary) throw new Error('项目摘要无效，无法写入 IndexedDB');
  const db = await openDB();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_METADATA], 'readwrite');
    let failure: Error | undefined;
    const abort = () => { try { tx.abort(); } catch { /* 已提交事务保留原结果 */ } };
    signal?.addEventListener('abort', abort, { once: true });
    const current = tx.objectStore(STORE_PROJECTS).get(record.id);
    current.onsuccess = () => {
      const before = current.result as ProjectRecord | undefined;
      const tombstone = tx.objectStore(STORE_METADATA).get(`project-deleted:${record.id}`);
      tombstone.onsuccess = () => {
        if ((before?.exchangeEpoch ?? 0) !== (record.exchangeEpoch ?? 0) || (!before && tombstone.result)) {
          failure = new Error('项目已被导入更新或删除，请重新打开项目后保存'); tx.abort(); return;
        }
        try {
          // 正式图只能经下方 CAS 写入；迟到的普通保存不得恢复旧图或抹掉新图。
          const next = { ...record };
          const series = normalizeProjectSeriesInfo(record.series);
          const storedGraph = before?.series?.storyGraph;
          if (before && (series || storedGraph)) {
            next.series = { ...(series ?? before.series) };
            if (storedGraph) next.series.storyGraph = normalizeStoryGraph(storedGraph);
            else delete next.series.storyGraph;
          } else if (series) next.series = series;
          if (next.parentId && next.series?.storyGraph) throw new Error('故事关系图只能由所属剧集保存');
          const nextSummary = toProjectSummaryRecord(next);
          if (!nextSummary) throw new Error('项目摘要无效，无法写入 IndexedDB');
          withRelocatedMedia(tx, next, (relocated) => tx.objectStore(STORE_PROJECTS).put(relocated));
          tx.objectStore(STORE_PROJECT_SUMMARIES).put(nextSummary);
        } catch (error) { failure = error instanceof Error ? error : new Error('故事图保存失败'); tx.abort(); }
      };
    };
    let settled = false;
    const fail = (error: DOMException | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(failure ?? signal?.reason ?? error ?? new Error(`项目 ${record.id} 的 IndexedDB 写入失败`));
    };
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });
}

/** 合并最新剧集记录后原子提交图补丁；不重存画布，也不覆盖同时更新的全剧剧本。 */
export async function updateProjectStoryGraphCAS(
  seriesId: string, patch: StoryGraphPatch, expectedRevision: number, expectedExchangeEpoch: number,
  assertCurrent?: (next?: StoryGraph) => void,
): Promise<StoryGraph> {
  if (!seriesId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || !Number.isSafeInteger(expectedExchangeEpoch) || expectedExchangeEpoch < 0) throw new Error('故事图保存版本无效');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_METADATA], 'readwrite');
    let result: StoryGraph | undefined;
    let failure: unknown;
    const request = tx.objectStore(STORE_PROJECTS).get(seriesId);
    request.onsuccess = () => withLegacyProjectWrite(tx, () => {
      try {
        assertCurrent?.();
        const before = request.result as ProjectRecord | undefined;
        if (!before || before.parentId || (before.exchangeEpoch ?? 0) !== expectedExchangeEpoch) {
          throw new Error('故事图所属剧集已变化，请重新打开关系图');
        }
        const series = normalizeProjectSeriesInfo(before.series);
        result = applyStoryGraphPatch(series?.storyGraph, patch, expectedRevision);
        const next = { ...before, series: { ...series, storyGraph: result }, updatedAt: Date.now() };
        const summary = toProjectSummaryRecord(next);
        if (!summary) throw new Error('故事图项目摘要无效');
        assertCurrent?.(result);
        tx.objectStore(STORE_PROJECTS).put(next);
        tx.objectStore(STORE_PROJECT_SUMMARIES).put(summary);
      } catch (error) { failure = error; tx.abort(); }
    }, (error) => { failure = error; });
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('故事图未提交'));
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('故事图提交失败'));
  });
}

/** 缩略图迟到时只更新最新记录的图片；不重存旧画布，也不重新创建已删除项目。 */
export async function updateProjectSnapshot(id: string, snapshot: string | undefined): Promise<boolean> {
  if (typeof id !== 'string' || !id.trim() || (snapshot !== undefined && !isProjectSnapshotDataUrl(snapshot))) {
    throw new Error('项目缩略图参数无效');
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_METADATA], 'readwrite');
    const projects = tx.objectStore(STORE_PROJECTS);
    const request = projects.get(id);
    let updated = false;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error('项目缩略图保存失败'));
    };
    request.onsuccess = () => withLegacyProjectWrite(tx, () => {
      const current = request.result as ProjectRecord | undefined;
      if (!current) return;
      try {
        const next = { ...current, snapshot };
        const summary = toProjectSummaryRecord(next);
        if (!summary) throw new Error('项目摘要无效，无法更新缩略图');
        projects.put(next);
        tx.objectStore(STORE_PROJECT_SUMMARIES).put(summary);
        updated = true;
      } catch (error) {
        tx.abort();
        fail(error);
      }
    }, fail);
    request.onerror = () => fail(request.error);
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(updated);
    };
    tx.onerror = tx.onabort = () => fail(tx.error);
  });
}

export * from './indexedDb/globalDramaAssetRepository';

/** 原子删除项目及其项目域持久化数据。 */
export async function deleteProjectFromDb(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([
      STORE_PROJECTS,
      STORE_PROJECT_SUMMARIES,
      STORE_CHAT_CONVERSATIONS,
      STORE_CHAT_MESSAGES,
      STORE_AGENT_TASKS,
      STORE_PROJECT_MEMORIES,
      STORE_PROJECT_VISUAL_DESCRIPTIONS,
      STORE_HISTORY,
      STORE_METADATA,
      STORE_PROJECT_EXCHANGE_STATES,
    ], 'readwrite');

    tx.objectStore(STORE_PROJECTS).delete(id);
    tx.objectStore(STORE_PROJECT_EXCHANGE_STATES).delete(id);
    tx.objectStore(STORE_METADATA).put({ id: `project-deleted:${id}`, deletedAt: Date.now() });
    tx.objectStore(STORE_METADATA).delete(`video-batches:${id}`);
    tx.objectStore(STORE_METADATA).delete(`video-replica-jobs:${id}`);
    const operationCursor = tx.objectStore(STORE_METADATA).openCursor();
    operationCursor.onsuccess = () => {
      const cursor = operationCursor.result;
      if (!cursor) return;
      if (cursor.value?.kind === 'mcp-operation-binding' && cursor.value.projectId === id) cursor.delete();
      cursor.continue();
    };
    tx.objectStore(STORE_PROJECT_SUMMARIES).delete(id);

    const conversationStore = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const conversationRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const conversationCursor = conversationStore
      .index('projectId_updatedAt')
      .openKeyCursor(conversationRange);
    deleteKeyCursorEntries(conversationStore, conversationCursor);

    // chatMessages 没有 projectId 索引；项目删除是低频操作，事务内全表扫描
    // 可以清理会话记录已损坏时留下的孤儿消息，同时避免为此升级 schema。
    const messageCursor = tx.objectStore(STORE_CHAT_MESSAGES).openCursor();
    messageCursor.onsuccess = () => {
      const cursor = messageCursor.result;
      if (!cursor) return;
      if ((cursor.value as ChatMessageRecord).projectId === id) cursor.delete();
      cursor.continue();
    };

    const taskRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const taskStore = tx.objectStore(STORE_AGENT_TASKS);
    const taskCursor = taskStore
      .index('projectId_updatedAt')
      .openKeyCursor(taskRange);
    deleteKeyCursorEntries(taskStore, taskCursor);

    const memoryRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const memoryStore = tx.objectStore(STORE_PROJECT_MEMORIES);
    const memoryCursor = memoryStore
      .index('projectId_updatedAt')
      .openKeyCursor(memoryRange);
    deleteKeyCursorEntries(memoryStore, memoryCursor);

    const historyStore = tx.objectStore(STORE_HISTORY);
    const historyCursor = historyStore
      .index('projectId_timestamp_id')
      .openKeyCursor(projectHistoryRange(id));
    deleteKeyCursorEntries(historyStore, historyCursor);

    const visualRange = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const visualStore = tx.objectStore(STORE_PROJECT_VISUAL_DESCRIPTIONS);
    const visualCursor = visualStore
      .index('projectId_updatedAt')
      .openKeyCursor(visualRange);
    deleteKeyCursorEntries(visualStore, visualCursor);

    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error(`删除项目 ${id} 的持久化数据失败`));
  });
}

/** 获取全部项目列表摘要；不会读取 projects store 中的 nodes/edges。 */
export async function getAllProjects(): Promise<ProjectSummaryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_SUMMARIES, 'readonly');
    const store = tx.objectStore(STORE_PROJECT_SUMMARIES);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 获取单个项目（含 nodes/edges） */
export async function getProjectById(id: string): Promise<ProjectRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 读取上次成功打开的项目；复用 metadata store，不需要升级 schema。 */
export async function getLastActiveProjectId(): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_METADATA, 'readonly')
      .objectStore(STORE_METADATA)
      .get(LAST_ACTIVE_PROJECT_KEY);
    request.onsuccess = () => {
      const projectId = (request.result as { projectId?: unknown } | undefined)?.projectId;
      resolve(typeof projectId === 'string' && projectId.trim() ? projectId : null);
    };
    request.onerror = () => reject(request.error);
  });
}

/** 仅在项目成功载入后更新，避免把加载失败的空状态记成最近项目。 */
export async function setLastActiveProjectId(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    tx.objectStore(STORE_METADATA).put({
      id: LAST_ACTIVE_PROJECT_KEY,
      projectId,
      updatedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ============================================
// Asset Meta CRUD — 稳定资产标签（v2 以 assetId 为键；v1 path 仅用于迁移）
// ============================================

export interface AssetMetaRecord {
  assetId: string;
  path?: string;         // 最近路径，仅用于诊断和旧数据迁移
  tags: string[];        // 标签
  taggedBy?: 'manual' | 'comfyui' | 'vision'; // 标签来源
  updatedAt: number;
}

// 图片编辑信息按资产身份及内容摘要独立存放，避免标签更新或历史裁剪覆盖它。
const ASSET_IMAGE_PREFIX = 'asset-image:';

async function legacy_getAssetImageRecords(signal?: AbortSignal): Promise<import('../types/assetImage').AssetImageRecord[]> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const db = await openDB();
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly');
    const records: import('../types/assetImage').AssetImageRecord[] = [];
    const abort = () => { try { tx.abort(); } catch { /* 已结束 */ } };
    signal?.addEventListener('abort', abort, { once: true });
    const request = tx.objectStore(STORE_METADATA).openCursor(IDBKeyRange.bound(ASSET_IMAGE_PREFIX, `${ASSET_IMAGE_PREFIX}\uffff`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (records.length >= 10_000) { reject(new Error('图片信息过多，请先整理')); abort(); return; }
      records.push(cursor.value); cursor.continue();
    };
    tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(records); };
    tx.onabort = () => { signal?.removeEventListener('abort', abort); reject(signal?.aborted ? new DOMException('Cancelled', 'AbortError') : tx.error ?? new Error('图片信息读取失败')); };
    if (signal?.aborted) abort();
  });
}

/** 事务内比较 revision；批量反推可同时比较标签基线并原子替换，失败保留原信息。 */
export async function putAssetImageRecord(record: import('../types/assetImage').AssetImageRecord, expectedRevision: number,
  options?: { tagReplacement?: import('../types/assetImage').AssetImageTagReplacement; signal?: AbortSignal }): Promise<void> {
  if (!record.id.startsWith(ASSET_IMAGE_PREFIX) || !/^[a-f0-9]{64}$/.test(record.contentDigest)
    || record.revision !== expectedRevision + 1) throw new Error('图片信息无效');
  const replacement = options?.tagReplacement;
  if (replacement && (replacement.tags.length > 16 || replacement.tags.some((tag) => !tag.trim() || tag.length > 40))) throw new Error('标签信息无效');
  if (record.assetId.startsWith('na2-')) {
    return (await import('./indexedDb/nativeAssetRepository')).updateNativeAsset(record.assetId, (asset) => {
      const current = asset.images?.find((image) => image.id === record.id);
      if ((current?.revision ?? 0) !== expectedRevision || current && current.contentDigest !== record.contentDigest) throw new Error('图片信息已变化，请重新读取');
      if (replacement) {
        const tags = asset.tags;
        if (replacement.expected ? !tags || tags.updatedAt !== replacement.expected.updatedAt
          || JSON.stringify(tags.tags) !== JSON.stringify(replacement.expected.tags) : !!tags) throw new Error('标签已变化，请重新读取');
        asset.tags = { assetId: record.assetId, tags: [...replacement.tags], taggedBy: 'vision', updatedAt: Date.now() };
      }
      asset.images = [...(asset.images ?? []).filter((image) => image.id !== record.id), structuredClone(record)];
      return asset;
    }, { signal: options?.signal });
  }
  options?.signal?.throwIfAborted();
  const db = await openDB();
  options?.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(replacement ? [STORE_METADATA, STORE_ASSET_META_V2] : STORE_METADATA, 'readwrite');
    const store = tx.objectStore(STORE_METADATA);
    let conflict = false;
    let forgotten = false;
    const abort = () => { try { tx.abort(); } catch { /* 事务已完成 */ } };
    const cleanup = () => options?.signal?.removeEventListener('abort', abort);
    options?.signal?.addEventListener('abort', abort, { once: true });
    withActiveAsset(tx, record.assetId, () => {
      const request = store.get(record.id);
      request.onsuccess = () => {
        const current = request.result as import('../types/assetImage').AssetImageRecord | undefined;
        if ((current?.revision ?? 0) !== expectedRevision || current && current.contentDigest !== record.contentDigest) {
          conflict = true; tx.abort(); return;
        }
        withRelocatedMedia(tx, record, (next) => store.put(next));
      };
      if (replacement) {
        const tags = tx.objectStore(STORE_ASSET_META_V2);
        const baseline = tags.get(record.assetId);
        baseline.onsuccess = () => {
          const current = baseline.result as AssetMetaRecord | undefined;
          if (replacement.expected ? !current || current.updatedAt !== replacement.expected.updatedAt
            || JSON.stringify(current.tags) !== JSON.stringify(replacement.expected.tags) : !!current) {
            conflict = true; abort(); return;
          }
          tags.put({ assetId: record.assetId, tags: [...replacement.tags], taggedBy: 'vision', updatedAt: Date.now() } satisfies AssetMetaRecord);
        };
      }
    }, () => { forgotten = true; });
    tx.oncomplete = () => { cleanup(); resolve(); };
    tx.onabort = tx.onerror = () => {
      cleanup(); reject(options?.signal?.aborted ? new DOMException('Cancelled', 'AbortError')
        : new Error(forgotten ? '素材已被清理，请重新加载后重试'
          : conflict ? '提示词或标签已被其他操作修改，请重新读取后重试' : '图片信息保存失败'));
    };
    if (options?.signal?.aborted) abort();
  });
}

/** 获取全部资产元数据（一次性读入，组件侧建 Map 合并） */
async function legacy_getAllAssetMeta(): Promise<AssetMetaRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_META_V2, 'readonly');
    const store = tx.objectStore(STORE_ASSET_META_V2);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as AssetMetaRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/** 批量任务逐项捕获当前标签基线，避免为每张图片读取整个标签目录。 */
export async function getAssetMetaById(assetId: string): Promise<AssetMetaRecord | undefined> {
  if (assetId.startsWith('na2-')) return (await (await import('./indexedDb/nativeAssetRepository')).readNativeAsset(assetId))?.tags;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_ASSET_META_V2, 'readonly').objectStore(STORE_ASSET_META_V2).get(assetId);
    request.onsuccess = () => resolve(request.result as AssetMetaRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** 写入/更新单个文件的标签元数据 */
export async function putAssetMeta(record: AssetMetaRecord): Promise<void> {
  if (record.assetId.startsWith('na2-')) {
    const { path: _path, ...tags } = record;
    return (await import('./indexedDb/nativeAssetRepository')).updateNativeAsset(record.assetId, (asset) => ({ ...asset, tags }));
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ASSET_META_V2, STORE_METADATA], 'readwrite');
    let forgotten = false;
    withActiveAsset(tx, record.assetId, () => {
      withRelocatedMedia(tx, record, (next) => tx.objectStore(STORE_ASSET_META_V2).put(next));
    }, () => { forgotten = true; });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error(forgotten ? '素材已被清理，请重新加载后重试' : '文件引用写入事务失败'));
  });
}

/** 删除单个文件的标签元数据 */
export async function deleteAssetMeta(assetId: string): Promise<void> {
  if (assetId.startsWith('na2-')) return (await import('./indexedDb/nativeAssetRepository')).updateNativeAsset(assetId, (asset) => { delete asset.tags; return asset; });
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_META_V2, 'readwrite');
    tx.objectStore(STORE_ASSET_META_V2).delete(assetId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export {
  putChatConversation,
  setConversationCreationProfileCAS,
  getProjectConversations,
  getTrashConversations,
  forkChatConversationAtMessage,
} from './indexedDb/chatConversationRepository';
export type { ChatConversationRecord, ChatMessageRecord } from './indexedDb/chatConversationRepository';

export interface LegacyAssetMetaRecord {
  path: string;
  tags: string[];
  taggedBy?: 'manual' | 'comfyui' | 'vision';
  updatedAt: number;
}

export interface AssetIndexRecord {
  assetId: string;
  path: string;
  relativePath?: string;
  rootPath?: string;
  projectId?: string;
  source: 'project' | 'global' | 'folder';
  fingerprint: string;
  size: number;
  mtimeMs: number;
  /** 固定块 asset-image-sha256-chain-v1 全内容摘要；旧索引可以没有，不从元数据补造。 */
  contentDigest?: string;
  /** 最近一次真实使用时间（毫秒）；扫描刷新不产生或清空使用记录。 */
  lastUsedAt?: number;
  status: 'online' | 'offline';
  updatedAt: number;
}

export async function getAssetIndexById(assetId: string): Promise<AssetIndexRecord | undefined> {
  if (assetId.startsWith('na2-')) {
    const native = await import('./indexedDb/nativeAssetRepository');
    const record = await native.readNativeAsset(assetId);
    return record ? native.resolveNativeAssetIndex(record) : undefined;
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const request = tx.objectStore(STORE_ASSET_INDEX).get(assetId);
    request.onsuccess = () => resolve(request.result as AssetIndexRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function legacy_getAllAssetIndexes(): Promise<AssetIndexRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_ASSET_INDEX, 'readonly').objectStore(STORE_ASSET_INDEX).getAll();
    request.onsuccess = () => resolve(request.result as AssetIndexRecord[]);
    request.onerror = () => reject(request.error);
  });
}

async function legacy_getAssetIndexByPath(path: string): Promise<AssetIndexRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const request = tx.objectStore(STORE_ASSET_INDEX).index('path').get(path);
    request.onsuccess = () => resolve(request.result as AssetIndexRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function legacy_getAssetIndexesByFingerprint(fingerprint: string): Promise<AssetIndexRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const request = tx.objectStore(STORE_ASSET_INDEX).index('fingerprint').getAll(fingerprint);
    request.onsuccess = () => resolve(request.result as AssetIndexRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/** 目录扫描的小批路径查询；一次事务读取，按输入顺序返回，不扫描整张索引表。 */
async function legacy_getAssetIndexesByPaths(paths: readonly string[]): Promise<Array<AssetIndexRecord | undefined>> {
  if (!paths.length) return [];
  if (paths.length > 128) throw new Error('资产索引查询批次过大');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readonly');
    const index = tx.objectStore(STORE_ASSET_INDEX).index('path');
    const records: Array<AssetIndexRecord | undefined> = new Array(paths.length);
    paths.forEach((path, position) => {
      const request = index.get(path);
      request.onsuccess = () => { records[position] = request.result as AssetIndexRecord | undefined; };
    });
    tx.oncomplete = () => resolve(records);
    tx.onerror = tx.onabort = () => reject(new Error('资产索引读取失败'));
  });
}

/** 扫描刷新合并小批事务；同值免写仍在墓碑与迁移日志校验之后执行。 */
export async function putAssetIndexes(
  records: readonly AssetIndexRecord[],
  options: { skipUnchanged?: boolean; migrateLegacyTags?: boolean; requireExistingPath?: boolean;
    preserveProjectOwnership?: boolean; expectedFolderProjection?: AssetIndexRecord } = {},
): Promise<AssetIndexRecord[]> {
  if (!records.length) return [];
  if (records.length > 128) throw new Error('资产索引保存批次过大');
  if (options.expectedFolderProjection && (records.length !== 1 || records[0].source !== 'project' || !records[0].projectId
    || records[0].assetId.startsWith('na2-') || records[0].assetId !== options.expectedFolderProjection.assetId)) {
    throw new Error('资产归属修复范围无效');
  }
  if (records.some((record) => record.assetId.startsWith('na2-'))) {
    const verified = new Map<string, AssetIndexRecord>();
    const normalize = (value: string) => { const path = value.replace(/\\/g, '/').replace(/\/+$/, ''); return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path; };
    for (const record of records) {
      if (!record.assetId.startsWith('na2-')) continue;
      const current = await getAssetIndexById(record.assetId);
      if (!current || normalize(current.path) !== normalize(record.path)
        || current.size !== record.size || current.projectId !== record.projectId) throw new Error('恢复素材的身份或字节已变化，不能覆盖原索引');
      verified.set(record.assetId, current);
    }
    const legacy = await putAssetIndexes(records.filter((record) => !record.assetId.startsWith('na2-')), options);
    let position = 0;
    return records.map((record) => verified.get(record.assetId) ?? legacy[position++]);
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const stores = options.migrateLegacyTags
      ? [STORE_ASSET_INDEX, STORE_METADATA, STORE_ASSET_META, STORE_ASSET_META_V2]
      : [STORE_ASSET_INDEX, STORE_METADATA];
    const tx = db.transaction(stores, 'readwrite');
    let forgotten = false;
    let identityChanged = false;
    const saved: AssetIndexRecord[] = new Array(records.length);
    let pendingActive = records.length;
    records.forEach((record) => {
      withActiveAsset(tx, record.assetId, () => {
        if (--pendingActive !== 0) return;
        // 全批墓碑检查通过后只读一次同事务内的迁移日志，不跨事务缓存。
        withRelocatedMedia(tx, records, (relocated) => {
          relocated.forEach((next, position) => {
            const record = records[position];
            const store = tx.objectStore(STORE_ASSET_INDEX);
            const request = store.get(next.assetId);
            request.onsuccess = () => {
              const current = request.result as AssetIndexRecord | undefined;
              const expectedFolder = options.expectedFolderProjection;
              if ((options.requireExistingPath && current?.path !== next.path)
                || (expectedFolder && (!current || current.source !== 'folder' || current.projectId !== undefined
                  || current.path !== expectedFolder.path || current.path !== next.path || current.rootPath !== expectedFolder.rootPath
                  || current.relativePath !== expectedFolder.relativePath))) {
                identityChanged = true;
                tx.abort();
                return;
              }
              if (options.preserveProjectOwnership && current?.source === 'project' && next.source !== 'project') {
                if (current.path !== next.path) {
                  identityChanged = true;
                  tx.abort();
                } else saved[position] = current;
                return;
              }
              const lastUsedAt = latestAssetUsageTime(next.lastUsedAt, current?.lastUsedAt);
              const merged = { ...next };
              if (!merged.contentDigest && current?.size === next.size && current.mtimeMs === next.mtimeMs) {
                merged.contentDigest = current.contentDigest;
              }
              if (lastUsedAt === undefined) delete merged.lastUsedAt;
              else merged.lastUsedAt = lastUsedAt;
              const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(merged)] as Array<keyof AssetIndexRecord>);
              keys.delete('updatedAt');
              const unchanged = options.skipUnchanged && current
                && [...keys].every((key) => Object.is(current[key], merged[key]));
              saved[position] = unchanged && current ? current : merged;
              if (!unchanged) store.put(merged);
            };
            if (options.migrateLegacyTags) {
              const tags = tx.objectStore(STORE_ASSET_META_V2);
              const currentTags = tags.get(next.assetId);
              currentTags.onsuccess = () => {
                // 已有标签（包括用户主动清空的标签）不再被旧路径标签覆盖。
                if (currentTags.result) return;
                const legacy = tx.objectStore(STORE_ASSET_META).get(record.path);
                legacy.onsuccess = () => {
                  const old = legacy.result as LegacyAssetMetaRecord | undefined;
                  if (old?.tags?.length) tags.put({ assetId: next.assetId, path: next.path,
                    tags: old.tags, taggedBy: old.taggedBy, updatedAt: old.updatedAt } satisfies AssetMetaRecord);
                };
              };
            }
          });
        });
      }, () => { forgotten = true; });
    });
    tx.oncomplete = () => resolve(saved);
    tx.onerror = tx.onabort = () => reject(new Error(forgotten ? '素材已被清理，请重新加载后重试'
      : identityChanged ? '资产身份已变化，请重新扫描' : '文件引用写入事务失败'));
  });
}

export async function putAssetIndex(record: AssetIndexRecord): Promise<void> {
  await putAssetIndexes([record]);
}

/** Forget only identities already verified missing by the file service; never delete disk files. */
export async function forgetMissingAssetRecords(
  expected: readonly AssetIndexRecord[], options: DramaAssetWriteOptions = {},
): Promise<{ assetIds: string[]; historyIds: string[]; deletedHistoryCounts: Record<string, number> }> {
  assertDramaAssetWriteCurrent(options);
  const snapshot = expected.map((record) => ({ ...record }));
  if (snapshot.some((record) => record.assetId.startsWith('na2-'))) throw new Error('新项目恢复素材需从项目恢复入口处理，旧素材清理不能改写其身份');
  const assetIds = new Set(snapshot.map((record) => record.assetId));
  if (snapshot.length > 500 || assetIds.size !== snapshot.length || snapshot.some((record) => (
    typeof record.assetId !== 'string' || !record.assetId.trim() || record.assetId.length > 256
    || typeof record.path !== 'string' || !record.path.trim() || !imageHistoryReferenceKey(record.path)
  ))) throw new Error('失效素材清理批次无效');
  if (!snapshot.length) return { assetIds: [], historyIds: [], deletedHistoryCounts: {} };
  const paths = new Set(snapshot.map((record) => imageHistoryReferenceKey(record.path)!));
  const db = await openDB();
  assertDramaAssetWriteCurrent(options);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ASSET_INDEX, STORE_ASSET_META, STORE_ASSET_META_V2, STORE_METADATA, STORE_HISTORY], 'readwrite');
    const indexes = tx.objectStore(STORE_ASSET_INDEX);
    const metadata = tx.objectStore(STORE_METADATA);
    const historyIds: string[] = [];
    const counts = new Map<string, number>();
    let failure: unknown;
    let scanned = 0;
    let remaining = snapshot.length;
    const fail = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* 已有终态。 */ } };
    const abort = () => fail(new DOMException('失效素材清理已取消', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => {
      cleanup();
      // The committed removal is authoritative even if the view has just closed.
      resolve({ assetIds: [...assetIds], historyIds, deletedHistoryCounts: Object.fromEntries(counts) });
    };
    tx.onerror = tx.onabort = () => { cleanup(); reject(failure ?? new Error('失效素材清理保存失败')); };
    const scan = (store: IDBObjectStore, visit: (cursor: IDBCursorWithValue) => void, range?: IDBKeyRange) => {
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          assertDramaAssetWriteCurrent(options);
          if (++scanned > 100_000) throw new Error('失效素材清理扫描超过上限，请按目录分批处理');
          visit(cursor); cursor.continue();
        } catch (error) { fail(error); }
      };
    };
    const remove = () => {
      assertDramaAssetWriteCurrent(options);
      const forgottenAt = Date.now();
      for (const record of snapshot) {
        indexes.delete(record.assetId);
        tx.objectStore(STORE_ASSET_META_V2).delete(record.assetId);
        metadata.put({ id: forgottenAssetKey(record.assetId), assetId: record.assetId, forgottenAt });
      }
      for (const path of paths) {
        const marker = metadata.get(forgottenPathKey(path));
        marker.onsuccess = () => {
          try {
            assertDramaAssetWriteCurrent(options);
            const previous = cleanupTimestamp(marker.result);
            metadata.put({ id: forgottenPathKey(path), forgottenAt: Math.max(forgottenAt, previous ?? 0) });
          } catch (error) { fail(error); }
        };
      }
      const recent = metadata.get(RECENT_ASSET_USAGE_KEY);
      recent.onsuccess = () => {
        try {
          assertDramaAssetWriteCurrent(options);
          if (recent.result === undefined) return;
          if (!Array.isArray(recent.result.entries)) throw new Error('失效素材清理记录无效，请检查存储');
          metadata.put({ ...recent.result, entries: recent.result.entries.filter((entry: AssetUsageRecord) => !assetIds.has(entry?.assetId)) });
        } catch (error) { fail(error); }
      };
      scan(tx.objectStore(STORE_ASSET_META), (cursor) => {
        const path = imageHistoryReferenceKey(cursor.value.path);
        if (path && paths.has(path)) cursor.delete();
      });
      scan(metadata, (cursor) => {
        if (assetIds.has(cursor.value.assetId)) cursor.delete();
      }, IDBKeyRange.bound(ASSET_IMAGE_PREFIX, `${ASSET_IMAGE_PREFIX}\uffff`));
      scan(tx.objectStore(STORE_HISTORY), (cursor) => {
        const record = cursor.value as HistoryRecord;
        if (!historyOutputKeys(record).some((path) => paths.has(path))) return;
        if (typeof record.id !== 'string' || typeof record.projectId !== 'string') throw new Error('失效素材清理记录无效，请检查存储');
        historyIds.push(record.id);
        counts.set(record.projectId, (counts.get(record.projectId) ?? 0) + 1);
        metadata.put({ id: forgottenHistoryKey(record.id), historyId: record.id, forgottenAt });
        cursor.delete();
      });
    };
    for (const before of snapshot) {
      const request = indexes.get(before.assetId);
      request.onsuccess = () => {
        try {
          assertDramaAssetWriteCurrent(options);
          const current = request.result as AssetIndexRecord | undefined;
          if (!current || imageHistoryReferenceKey(current.path) !== imageHistoryReferenceKey(before.path)
            || current.fingerprint !== before.fingerprint || current.size !== before.size || current.mtimeMs !== before.mtimeMs
            || current.contentDigest !== before.contentDigest || current.updatedAt !== before.updatedAt || current.status !== before.status
            || current.source !== before.source || current.projectId !== before.projectId || current.rootPath !== before.rootPath
            || current.relativePath !== before.relativePath) throw new Error('素材身份或位置已变化，请重新预览');
          if (--remaining === 0) remove();
        } catch (error) { fail(error); }
      };
    }
    if (options.signal?.aborted) abort();
  });
}

/** 仅回收尚未提交的资产包索引；位置已改变的记录不属于本轮可清理范围。 */
export async function deleteImportedAssetIndexes(entries: readonly { assetId: string; path: string }[]): Promise<void> {
  if (!entries.length) return;
  if (entries.some((entry) => entry.assetId.startsWith('na2-'))) throw new Error('旧导入清理不能删除新项目恢复素材索引');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ASSET_INDEX, 'readwrite');
    const store = tx.objectStore(STORE_ASSET_INDEX);
    for (const entry of entries) {
      const request = store.get(entry.assetId);
      request.onsuccess = () => {
        if (request.result?.assetId === entry.assetId && request.result.path === entry.path) store.delete(entry.assetId);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('导入资产索引清理失败'));
  });
}

/** 保存 / 更新单条消息 */
export async function putChatMessage(record: ChatMessageRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHAT_MESSAGES, STORE_METADATA], 'readwrite');
    withRelocatedMedia(tx, record, (next) => tx.objectStore(STORE_CHAT_MESSAGES).put(next));
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

/** 获取指定会话的消息（分页，按 sequence 倒序） */
export async function getConversationMessages(
  conversationId: string,
  offset: number = 0,
  limit: number = 50,
): Promise<{ messages: ChatMessageRecord[]; total: number }> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_MESSAGES, 'readonly');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    const index = store.index('conversationId_sequence');
    const range = IDBKeyRange.bound(
      [conversationId, 0],
      [conversationId, Infinity],
    );
    const messages: ChatMessageRecord[] = [];
    let total = 0;
    // 旧比较逻辑对正小数向上取整，负数和 NaN 从头读取。
    let remaining = offset > 0 ? Math.ceil(offset) : 0;
    // 先获取总数
    const countReq = index.count(range);
    countReq.onsuccess = () => {
      total = countReq.result;
      if (!(limit > 0) || remaining >= total) return;
      // 再获取分页数据（cursor 倒序）
      const cursorReq = index.openCursor(range, 'prev');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        if (remaining > 0) {
          // advance 接受 unsigned long；大偏移分批跳过，不逐条分配 JS 回调。
          const step = Math.min(remaining, 0xffff_ffff);
          remaining -= step;
          cursor.advance(step);
          return;
        }
        messages.push(cursor.value as ChatMessageRecord);
        if (messages.length < limit) cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    countReq.onerror = () => reject(countReq.error);
    tx.oncomplete = () => resolve({ messages, total });
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('会话消息读取失败'));
  });
}

/** 导出时批量读取项目聊天；保持原读取范围，归档关系与正文校验仍由后续流程负责。 */
export async function getProjectChatForExport(
  projectId: string,
  maxMessagesPerConversation: number,
): Promise<{ conversations: ChatConversationRecord[]; messages: ChatMessageRecord[]; memories: ProjectMemoryRecord[] }> {
  if (!Number.isInteger(maxMessagesPerConversation) || maxMessagesPerConversation <= 0
    || maxMessagesPerConversation >= 0xffff_ffff) {
    throw new Error('会话消息归档上限无效');
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_PROJECT_MEMORIES], 'readonly');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    let conversations: ChatConversationRecord[] = [];
    let messageGroups: ChatMessageRecord[][] = [];
    let memories: ProjectMemoryRecord[] = [];
    let failure: unknown;
    const abort = (error: unknown) => {
      failure ??= error;
      tx.abort();
    };
    const conversationRequest = tx.objectStore(STORE_CHAT_CONVERSATIONS).index('projectId_updatedAt').getAll(range);
    conversationRequest.onsuccess = () => {
      try {
        conversations = (conversationRequest.result as ChatConversationRecord[]).filter((conversation) => !conversation.deletedAt);
        messageGroups = new Array(conversations.length);
        const messages = tx.objectStore(STORE_CHAT_MESSAGES).index('conversationId_sequence');
        conversations.forEach((conversation, index) => {
          const request = messages.getAll(
            IDBKeyRange.bound([conversation.id, 0], [conversation.id, Infinity]),
            maxMessagesPerConversation + 1,
          );
          request.onsuccess = () => {
            try {
              const records = request.result as ChatMessageRecord[];
              if (records.length > maxMessagesPerConversation) {
                abort(new Error('会话消息超过当前归档上限，请先拆分会话后重新导出'));
                return;
              }
              // 保留旧 prev 游标再稳定按 sequence 排序时，同序号主键倒序的行为。
              messageGroups[index] = records.reverse().sort((left, right) => left.sequence - right.sequence);
            } catch (error) { abort(error); }
          };
        });
      } catch (error) { abort(error); }
    };
    const memoryRequest = tx.objectStore(STORE_PROJECT_MEMORIES).index('projectId_updatedAt').getAll(range);
    memoryRequest.onsuccess = () => { memories = memoryRequest.result as ProjectMemoryRecord[]; };
    tx.oncomplete = () => resolve({ conversations, messages: messageGroups.flat(), memories });
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('项目聊天归档读取失败'));
  });
}

/**
 * 保存单条消息，并在同一读写事务内分配 sequence：
 * - 已存在的消息（同 id）保留原 sequence，避免更新时被重排到末尾；
 * - 新消息取当前会话最大 sequence + 1。
 *
 * 事务内读改写让 IndexedDB 串行化并发调用（如用户消息与助手占位同时落盘），
 * 从而不会分配到重复 sequence。返回最终写入的 sequence。
 */
export async function putChatMessageWithSequence(
  record: ChatMessageRecord,
): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHAT_MESSAGES, STORE_METADATA], 'readwrite');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    let sequence = record.sequence;
    const existingReq = store.get(record.id);
    existingReq.onsuccess = () => {
      const existing = existingReq.result as ChatMessageRecord | undefined;
      if (existing) {
        sequence = existing.sequence;
        withRelocatedMedia(tx, { ...record, sequence }, (next) => store.put(next));
        return;
      }
      const index = store.index('conversationId_sequence');
      const range = IDBKeyRange.bound(
        [record.conversationId, 0],
        [record.conversationId, Infinity],
      );
      const cursorReq = index.openKeyCursor(range, 'prev');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        sequence = cursor ? (cursor.key as [string, number])[1] + 1 : 0;
        withRelocatedMedia(tx, { ...record, sequence }, (next) => store.put(next));
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    existingReq.onerror = () => reject(existingReq.error);
    tx.oncomplete = () => resolve(sequence);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('文件引用写入事务失败'));
  });
}

/** 删除指定会话的全部消息 */
export async function deleteConversationMessages(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_MESSAGES, 'readwrite');
    const store = tx.objectStore(STORE_CHAT_MESSAGES);
    const index = store.index('conversationId_sequence');
    const range = IDBKeyRange.bound(
      [conversationId, 0],
      [conversationId, Infinity],
    );
    const cursorReq = index.openKeyCursor(range);
    deleteKeyCursorEntries(store, cursorReq);
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('会话消息删除失败'));
  });
}

/** 在事务中同时删除会话和全部消息 */
export async function permanentlyDeleteConversation(convId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_AGENT_TASKS, STORE_METADATA],
      'readwrite',
    );
    // 删除会话
    tx.objectStore(STORE_CHAT_CONVERSATIONS).delete(convId);
    // 删除消息
    const msgStore = tx.objectStore(STORE_CHAT_MESSAGES);
    const msgIndex = msgStore.index('conversationId_sequence');
    const range = IDBKeyRange.bound([convId, 0], [convId, Infinity]);
    const cursorReq = msgIndex.openKeyCursor(range);
    deleteKeyCursorEntries(msgStore, cursorReq);
    // 删除该会话的 Agent 任务。
    const taskStore = tx.objectStore(STORE_AGENT_TASKS);
    const taskIndex = taskStore.index('conversationId_updatedAt');
    const taskRange = IDBKeyRange.bound([convId, 0], [convId, Infinity]);
    const taskCursorReq = taskIndex.openCursor(taskRange);
    taskCursorReq.onsuccess = () => {
      const cursor = taskCursorReq.result;
      if (cursor) {
        markMcpTaskDeleted(tx, cursor.value as AgentTask);
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('会话删除失败'));
  });
}

export {
  type AgentTaskRecord,
  type McpOperationClaim,
  claimMcpAgentTask,
  getMcpOperationBinding,
  updateMcpOperationTask,
  putAgentTask,
  updateTeamRunCAS,
  getAgentTask,
  getProjectAgentTasks,
  getConversationAgentTasks,
  deleteAgentTask,
  deleteConversationAgentTasks,
  deleteProjectAgentTasks,
} from './indexedDb/agentTaskRepository';

// ============================================
// Project Memory CRUD
// ============================================

export type ProjectMemoryRecord = ProjectMemory;

export async function putProjectMemory(record: ProjectMemoryRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    tx.objectStore(STORE_PROJECT_MEMORIES).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getProjectMemories(projectId: string): Promise<ProjectMemoryRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readonly');
    const index = tx.objectStore(STORE_PROJECT_MEMORIES).index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result as ProjectMemoryRecord[]);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteProjectMemory(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    tx.objectStore(STORE_PROJECT_MEMORIES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProjectMemories(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    const store = tx.objectStore(STORE_PROJECT_MEMORIES);
    const index = store.index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const cursorRequest = index.openKeyCursor(range);
    deleteKeyCursorEntries(store, cursorRequest);
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('项目记忆清理失败'));
  });
}

/** 把某会话来源的记忆标记为来源不可用，不删除记忆本身。 */
export async function markConversationMemoriesUnavailable(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_MEMORIES, 'readwrite');
    const index = tx.objectStore(STORE_PROJECT_MEMORIES).index('conversationId');
    const cursorRequest = index.openCursor(IDBKeyRange.only(conversationId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        const record = cursor.value as ProjectMemoryRecord;
        if (!record.source.unavailable) {
          cursor.update({ ...record, source: { ...record.source, unavailable: true } });
        }
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================
// Toolbar Layouts persistence (single record)
// ============================================

const TOOLBAR_LAYOUTS_KEY = 'layouts';

export async function saveToolbarLayoutsToDb(data: Record<string, unknown>): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = createDurableSettingsTransaction(db, STORE_TOOLBAR_LAYOUTS);
    tx.objectStore(STORE_TOOLBAR_LAYOUTS).put({ id: TOOLBAR_LAYOUTS_KEY, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Toolbar transaction aborted', 'AbortError'));
  });
}

function toolbarRecordData(record: unknown): Record<string, unknown> | null {
  if (record === undefined) return null;
  const data = (record as { data?: unknown } | null)?.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new StorageError('toolbar-read', 'corrupt');
  }
  return data as Record<string, unknown>;
}

/** 同一事务内读取最新记录，只更新一个节点类型，保留其他实例保存的布局。 */
export async function saveToolbarLayoutToDb(nodeType: string, layout: unknown | null, expected?: { baseline: unknown }): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = createDurableSettingsTransaction(db, STORE_TOOLBAR_LAYOUTS);
    const store = tx.objectStore(STORE_TOOLBAR_LAYOUTS);
    const request = store.get(TOOLBAR_LAYOUTS_KEY);
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const next = { ...toolbarRecordData(request.result) };
        if (expected && !configValuesEqual(next[nodeType] ?? null, expected.baseline)
          && !configValuesEqual(next[nodeType] ?? null, layout)) throw new StorageError('toolbar-write', 'conflict');
        if (layout === null) delete next[nodeType];
        else Object.defineProperty(next, nodeType, { value: layout, enumerable: true, configurable: true, writable: true });
        store.put({ id: TOOLBAR_LAYOUTS_KEY, data: next });
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('Toolbar transaction aborted', 'AbortError'));
  });
}

export async function loadToolbarLayoutsFromDb(): Promise<Record<string, unknown> | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TOOLBAR_LAYOUTS, 'readonly');
    const request = tx.objectStore(STORE_TOOLBAR_LAYOUTS).get(TOOLBAR_LAYOUTS_KEY);
    let data: Record<string, unknown> | null = null;
    let failure: unknown;
    request.onsuccess = () => {
      try { data = toolbarRecordData(request.result); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(data);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('Toolbar transaction aborted', 'AbortError'));
  });
}

// ============================================
// Project visual descriptions
// ============================================

export async function getProjectVisualDescription(
  projectId: string,
  fingerprint: string,
): Promise<ProjectVisualDescription | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_PROJECT_VISUAL_DESCRIPTIONS, 'readonly')
      .objectStore(STORE_PROJECT_VISUAL_DESCRIPTIONS)
      .index('projectId_fingerprint')
      .get([projectId, fingerprint]);
    request.onsuccess = () => resolve(request.result as ProjectVisualDescription | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function putProjectVisualDescription(
  record: ProjectVisualDescription,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_VISUAL_DESCRIPTIONS, 'readwrite');
    tx.objectStore(STORE_PROJECT_VISUAL_DESCRIPTIONS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 新项目恢复索引优先，旧索引保持原记录与原身份。 */
export async function getAllAssetIndexes(): Promise<AssetIndexRecord[]> {
  const [legacy, rows] = await Promise.all([legacy_getAllAssetIndexes(), availableNativeAssetIndexes()]);
  return [...legacy, ...rows];
}
export async function getAssetIndexByPath(path: string): Promise<AssetIndexRecord | undefined> {
  const [legacy, native] = await Promise.all([legacy_getAssetIndexByPath(path), availableNativeAssetIndexes([path])]);
  const normalize = (value: string) => { const path = value.replace(/\\/g, '/').replace(/\/+$/, ''); return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path; };
  const matches = native.filter((index) => normalize(index.path) === normalize(path));
  if (matches.length > 1) throw new Error('同一文件存在多个恢复素材身份，请按原ID核对');
  // 新库提交的恢复副本是该路径的权威；旧扫描提前发现的索引仍留给旧历史按ID读取。
  return matches[0] ?? legacy;
}
export async function getAssetIndexesByFingerprint(fingerprint: string): Promise<AssetIndexRecord[]> {
  const [legacy, rows] = await Promise.all([legacy_getAssetIndexesByFingerprint(fingerprint), availableNativeAssetIndexes()]);
  return [...legacy, ...rows.filter((row) => row.fingerprint === fingerprint)];
}
export async function getAssetIndexesByPaths(paths: readonly string[]): Promise<Array<AssetIndexRecord | undefined>> {
  if (paths.length > 128) throw new Error('资产索引查询批次过大');
  const [legacy, indexes] = await Promise.all([legacy_getAssetIndexesByPaths(paths), availableNativeAssetIndexes(paths)]);
  const normalize = (value: string) => { const path = value.replace(/\\/g, '/').replace(/\/+$/, ''); return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path; };
  return paths.map((path, i) => {
    const matches = indexes.filter((row) => normalize(row.path) === normalize(path));
    if (matches.length > 1) throw new Error('同一文件存在多个恢复素材身份，请按原ID核对');
    return matches[0] ?? legacy[i];
  });
}
/** 单次作品扫描只取该作品的恢复索引，各批次再查询旧表的精确路径。 */
export async function loadProjectAssetPathLookup(projectId: string, projectDirectory: string, signal?: AbortSignal) {
  const byPath = new Map<string, AssetIndexRecord | null>();
  const unresolved = new Set<string>();
  const pathKey = (value: string) => {
    const path = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
  };
  const directory = pathKey(projectDirectory);
  const scoped = { projectId, signal, onUnavailable: (row: import('./indexedDb/nativeAssetRepository').NativeAssetRecord) => {
    unresolved.add(pathKey(`${directory}/roots/${row.rootRef}/${row.relativePath}`));
  } };
  for (const row of await availableNativeAssetIndexes(undefined, scoped)) {
    const key = pathKey(row.path);
    byPath.set(key, byPath.has(key) ? null : row);
  }
  return async (paths: readonly string[]): Promise<Array<AssetIndexRecord | undefined>> => {
    signal?.throwIfAborted();
    const legacy = await legacy_getAssetIndexesByPaths(paths);
    signal?.throwIfAborted();
    return paths.map((path, index) => {
      const key = pathKey(path);
      if (unresolved.has(key)) throw new Error('此文件所属的恢复素材根不可用，请先核对素材目录');
      const native = byPath.get(key);
      if (native === null) throw new Error('同一文件存在多个恢复素材身份，请按原ID核对');
      return native ?? legacy[index];
    });
  };
}

async function availableNativeAssetIndexes(paths?: readonly string[], scope?: {
  projectId: string; signal?: AbortSignal;
  onUnavailable: (record: import('./indexedDb/nativeAssetRepository').NativeAssetRecord) => void;
}): Promise<AssetIndexRecord[]> {
  const native = await import('./indexedDb/nativeAssetRepository');
  const roots = new Map<string, string | null>(), indexes: AssetIndexRecord[] = [];
  const signal = scope?.signal;
  const records = scope ? await native.readNativeAssetsForProject(scope.projectId, { signal }) : await native.readNativeAssets();
  for (const row of records) {
    signal?.throwIfAborted();
    if (paths && !paths.some((path) => path.replace(/\\/g, '/').toLowerCase().endsWith('/' + row.relativePath.toLowerCase()))) continue;
    const rootKey = JSON.stringify([row.projectId, row.rootRef]);
    if (roots.get(rootKey) === null) { scope?.onUnavailable(row); continue; }
    try {
      const index = await native.resolveNativeAssetIndex(row, roots.get(rootKey) ?? undefined);
      roots.set(rootKey, index.rootPath!); indexes.push(index);
    } catch (error) {
      signal?.throwIfAborted();
      if (scope && row.primary) throw error;
      roots.set(rootKey, null); /* 全局查询允许其他作品根暂不可用。 */
      scope?.onUnavailable(row);
    }
  }
  signal?.throwIfAborted();
  return indexes;
}
export async function getAllAssetMeta(): Promise<AssetMetaRecord[]> {
  const [legacy, native] = await Promise.all([legacy_getAllAssetMeta(), (await import('./indexedDb/nativeAssetRepository')).readNativeAssets()]);
  return [...legacy, ...native.flatMap((asset) => asset.tags ? [asset.tags] : [])];
}
export async function getAssetImageRecords(signal?: AbortSignal): Promise<import('../types/assetImage').AssetImageRecord[]> {
  signal?.throwIfAborted();
  const [legacy, native] = await Promise.all([legacy_getAssetImageRecords(signal), (await import('./indexedDb/nativeAssetRepository')).readNativeAssets({ signal })]);
  signal?.throwIfAborted(); return [...legacy, ...native.flatMap((asset) => asset.images ?? [])];
}
