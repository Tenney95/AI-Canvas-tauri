/**
 * History Record slice — AI 输出历史记录 CRUD
 * 历史记录独立于节点存储（IndexedDB 持久化），节点删除后记录不丢失，用户手动管理
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { OutputHistoryEntry, BaseNodeData } from '../types';
import { generateId } from './store.utils';
import {
  putHistoryEntry,
  putHistoryEntries,
  deleteHistoryEntryFromDb,
  getHistoryEntriesPage,
  getHistoryEntriesForExport,
  getHistoryEntryCount,
  hasCompletedHistoryMigration,
  markHistoryMigrationCompleted,
  claimLegacyHistoryEntries,
  clearAllHistoryEntries,
  deleteNodeHistoryEntries,
} from '../services/indexedDbService';
import type { HistoryPageCursor, HistoryQuery } from '../services/indexedDbService';
import { tagGeneratedProjectAssetSafely } from '../services/fs/generatedAssetTags';
import { getAssetUrlFromPath, getProjectDataDir } from '../services/fs/core';
import { isTransientMediaUrl, persistMediaUrlToProjectData } from '../services/fileService';
import { exists } from '@tauri-apps/plugin-fs';

const HISTORY_PAGE_SIZE = 16;

let historyCursor: HistoryPageCursor | null = null;
let activeHistoryQuery: HistoryQuery = {};
let historyLoadRequestId = 0;

function getHistoryQueryKey(query: HistoryQuery): string {
  return `${query.nodeType ?? ''}\u0000${query.search?.trim().toLowerCase() ?? ''}`;
}

function matchesHistoryQuery(record: OutputHistoryEntry, query: HistoryQuery): boolean {
  if (query.nodeType && record.nodeType !== query.nodeType) return false;
  const search = query.search?.trim().toLowerCase();
  if (!search) return true;
  return [record.prompt, record.output, record.model, record.nodeLabel]
    .some((value) => value.toLowerCase().includes(search));
}

interface NormalizedHistoryRecord {
  record: OutputHistoryEntry;
  /** 记录是否被改写；落盘失败的改写不回写 IndexedDB。 */
  changed: boolean;
  failed: boolean;
}

function isPathInsideProject(filePath: string, projectDir: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, '/').toLowerCase();
  const normalizedDir = projectDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalizedFile.startsWith(`${normalizedDir}/`);
}

async function normalizeHistoryMediaRecord(
  record: OutputHistoryEntry,
  projectId: string,
): Promise<NormalizedHistoryRecord> {
  if (!isTransientMediaUrl(record.output) && !isTransientMediaUrl(record.mediaUrl)) {
    return { record, changed: false, failed: false };
  }
  try {
    const outputSource = typeof record.output === 'string' && isTransientMediaUrl(record.output)
      ? record.output
      : undefined;
    const mediaSource = typeof record.mediaUrl === 'string' && isTransientMediaUrl(record.mediaUrl)
      ? record.mediaUrl
      : undefined;
    const transientSources = [...new Set(
      [mediaSource, outputSource].filter((value): value is string => typeof value === 'string'),
    )];
    const persistedBySource = new Map<string, Awaited<ReturnType<typeof persistMediaUrlToProjectData>>>();
    const existingFilePath = typeof record.filePath === 'string' ? record.filePath : undefined;
    const projectDir = existingFilePath ? await getProjectDataDir(projectId) : null;
    const canReuseOwnFile = transientSources.length === 1
      && Boolean(existingFilePath)
      && Boolean(projectDir)
      && isPathInsideProject(existingFilePath!, projectDir!)
      && await exists(existingFilePath!).catch(() => false);
    if (canReuseOwnFile && existingFilePath) {
      const assetUrl = await getAssetUrlFromPath(existingFilePath);
      persistedBySource.set(transientSources[0], {
        filePath: existingFilePath,
        mediaUrl: assetUrl,
        sourceUrl: assetUrl,
      });
    } else {
      for (const source of transientSources) {
        persistedBySource.set(source, await persistMediaUrlToProjectData(
          source,
          projectId,
          record.nodeType,
          `${record.nodeLabel}-历史-${record.id}`,
          { deduplicateByContent: true },
        ));
      }
    }
    const outputMedia = outputSource
      ? persistedBySource.get(outputSource)
      : undefined;
    const attachedMedia = mediaSource
      ? persistedBySource.get(mediaSource)
      : undefined;
    const persistedFilePath = attachedMedia?.filePath ?? outputMedia?.filePath ?? record.filePath;
    return {
      record: {
        ...record,
        output: outputMedia?.mediaUrl ?? record.output,
        mediaUrl: attachedMedia?.mediaUrl ?? record.mediaUrl,
        filePath: persistedFilePath,
      },
      changed: true,
      failed: false,
    };
  } catch (error) {
    console.warn('[输出历史] 内嵌媒体迁移失败，已清除持久化正文', {
      projectId,
      recordId: record.id,
      error,
    });
    return {
      record: {
        ...record,
        output: isTransientMediaUrl(record.output) ? '媒体未能迁移到项目目录' : record.output,
        mediaUrl: isTransientMediaUrl(record.mediaUrl) ? undefined : record.mediaUrl,
        status: 'error',
      },
      changed: true,
      failed: true,
    };
  }
}

async function normalizeHistoryPage(
  records: OutputHistoryEntry[],
  projectId: string,
): Promise<OutputHistoryEntry[]> {
  const normalized: NormalizedHistoryRecord[] = [];
  for (const record of records) {
    normalized.push(await normalizeHistoryMediaRecord(record, projectId));
  }
  // 迁移失败多半是磁盘暂时不可用：把成功记录改写成 error 再回写，会永久丢掉这次生成
  const migrated = normalized
    .filter((entry) => entry.changed && !entry.failed)
    .map((entry) => entry.record);
  if (migrated.length > 0) await putHistoryEntries(migrated);
  return normalized.map((entry) => entry.record);
}

export interface HistoryRecordSlice {
  /** 当前项目的输出历史记录（独立于节点，节点删除后记录不丢失） */
  outputHistoryRecords: OutputHistoryEntry[];
  historyProjectId: string | null;
  historyTotalCount: number;
  historyHasMore: boolean;
  historyLoading: boolean;
  /** 从 IndexedDB 加载首批历史记录 */
  loadHistoryFromDb: (query?: HistoryQuery) => Promise<void>;
  /** 按当前查询继续加载下一批历史记录 */
  loadMoreHistoryFromDb: (query?: HistoryQuery) => Promise<void>;
  /** 显式导出时读取全部匹配历史 */
  getHistoryForExport: (query?: HistoryQuery) => Promise<OutputHistoryEntry[]>;
  /** 迁移旧 node.data.outputHistory → IndexedDB 并加载 */
  migrateHistoryAndLoad: () => Promise<void>;
  /** 追加一条输出历史（同步写 IndexedDB） */
  recordOutputHistory: (
    nodeId: string,
    entry: Omit<OutputHistoryEntry, 'id' | 'projectId'>,
  ) => Promise<void>;
  /** 删除某条历史 */
  deleteHistoryEntry: (nodeId: string, entryId: string) => Promise<void>;
  /** 清空指定节点的全部历史 */
  clearNodeHistory: (nodeId: string) => Promise<void>;
  /** 清空所有节点的全部历史 */
  clearAllHistory: () => Promise<void>;
}

export const createHistoryRecordSlice: StateCreator<AppState, [], [], HistoryRecordSlice> = (set, get) => ({
  outputHistoryRecords: [],
  historyProjectId: null,
  historyTotalCount: 0,
  historyHasMore: false,
  historyLoading: false,

  loadHistoryFromDb: async (query = {}) => {
    const projectId = get().currentProjectId;
    const requestId = ++historyLoadRequestId;
    activeHistoryQuery = query;
    historyCursor = null;
    if (!projectId) {
      set({
        outputHistoryRecords: [],
        historyProjectId: null,
        historyTotalCount: 0,
        historyHasMore: false,
        historyLoading: false,
      });
      return;
    }
    set({
      outputHistoryRecords: [],
      historyProjectId: projectId,
      historyHasMore: false,
      historyLoading: true,
    });
    try {
      await claimLegacyHistoryEntries(projectId, get().nodes.map((node) => node.id));
      const [page, totalCount] = await Promise.all([
        getHistoryEntriesPage(projectId, HISTORY_PAGE_SIZE, null, query),
        getHistoryEntryCount(projectId),
      ]);
      const records = await normalizeHistoryPage(page.records as OutputHistoryEntry[], projectId);
      if (requestId !== historyLoadRequestId || get().currentProjectId !== projectId) return;
      historyCursor = page.nextCursor;
      set({
        outputHistoryRecords: records,
        historyProjectId: projectId,
        historyTotalCount: totalCount,
        historyHasMore: page.hasMore,
        historyLoading: false,
      });
    } catch (e) {
      console.warn('Failed to load history from IndexedDB:', e);
      if (requestId === historyLoadRequestId) set({ historyLoading: false });
    }
  },

  loadMoreHistoryFromDb: async (query = {}) => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    const queryKey = getHistoryQueryKey(query);
    if (
      get().historyProjectId !== projectId
      || queryKey !== getHistoryQueryKey(activeHistoryQuery)
    ) {
      await get().loadHistoryFromDb(query);
      return;
    }
    if (get().historyLoading || !get().historyHasMore) return;

    const requestId = ++historyLoadRequestId;
    set({ historyLoading: true });
    try {
      const page = await getHistoryEntriesPage(projectId, HISTORY_PAGE_SIZE, historyCursor, query);
      const records = await normalizeHistoryPage(page.records as OutputHistoryEntry[], projectId);
      if (requestId !== historyLoadRequestId || get().currentProjectId !== projectId) return;
      historyCursor = page.nextCursor;
      set((state) => ({
        outputHistoryRecords: [...state.outputHistoryRecords, ...records],
        historyHasMore: page.hasMore,
        historyLoading: false,
      }));
    } catch (e) {
      console.warn('Failed to load more history from IndexedDB:', e);
      if (requestId === historyLoadRequestId) set({ historyLoading: false });
    }
  },

  getHistoryForExport: async (query = {}) => {
    const projectId = get().currentProjectId;
    return projectId
      ? getHistoryEntriesForExport(projectId, query) as Promise<OutputHistoryEntry[]>
      : [];
  },

  migrateHistoryAndLoad: async () => {
    const { currentProjectId, nodes } = get();
    if (currentProjectId) {
      try {
        const completed = await hasCompletedHistoryMigration(currentProjectId);
        if (!completed) {
          const legacyRecords = nodes.flatMap((node) => {
            const outputHistory = (node.data as Record<string, unknown>).outputHistory;
            return Array.isArray(outputHistory) ? outputHistory as OutputHistoryEntry[] : [];
          });
          const hasLegacyField = nodes.some((node) => (
            'outputHistory' in (node.data as Record<string, unknown>)
          ));

          const normalizedLegacyRecords: OutputHistoryEntry[] = [];
          for (const legacyRecord of legacyRecords) {
            const normalized = await normalizeHistoryMediaRecord({
              ...legacyRecord,
              projectId: currentProjectId,
            }, currentProjectId);
            if (normalized.failed) {
              throw new Error(`历史媒体 ${legacyRecord.id} 尚未完成迁移`);
            }
            normalizedLegacyRecords.push(normalized.record);
          }
          await putHistoryEntries(normalizedLegacyRecords);
          if (get().currentProjectId !== currentProjectId) {
            await get().loadHistoryFromDb();
            return;
          }

          if (hasLegacyField) {
            set((state) => ({
              nodes: state.nodes.map((node) => {
                const data = { ...node.data } as Record<string, unknown>;
                if (!('outputHistory' in data)) return node;
                delete data.outputHistory;
                return { ...node, data: data as BaseNodeData };
              }),
            }));
            const savedProjectId = await get().saveCurrentProjectSilent();
            if (savedProjectId !== currentProjectId) {
              throw new Error('Failed to persist migrated project history');
            }
          }
          await markHistoryMigrationCompleted(currentProjectId);
        }
      } catch (e) {
        console.warn('Failed to migrate legacy output history:', e);
      }
    }
    await get().loadHistoryFromDb();
  },

  recordOutputHistory: async (_nodeId, entry) => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    const id = `hist-${generateId()}`;
    const { record } = await normalizeHistoryMediaRecord({ ...entry, id, projectId }, projectId);
    // Persist to IndexedDB first, then update store
    await putHistoryEntry(record).catch((e) => console.warn('Failed to persist history entry:', e));
    if (record.status === 'success' && record.filePath && record.prompt.trim()) {
      await tagGeneratedProjectAssetSafely({
        filePath: record.filePath,
        projectId,
        prompt: record.prompt,
      });
    }
    set((state) => {
      if (state.currentProjectId !== projectId) return {};
      const sameProject = state.historyProjectId === projectId;
      const records = sameProject ? state.outputHistoryRecords : [];
      return {
        outputHistoryRecords: matchesHistoryQuery(record, activeHistoryQuery)
          ? [record, ...records].slice(0, HISTORY_PAGE_SIZE)
          : records,
        historyProjectId: projectId,
        historyTotalCount: Math.min(
          HISTORY_PAGE_SIZE,
          sameProject ? state.historyTotalCount + 1 : 1,
        ),
        historyHasMore: false,
      };
    });
  },

  deleteHistoryEntry: async (_nodeId, entryId) => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    await deleteHistoryEntryFromDb(projectId, entryId).catch(() => {});
    set((state) => (
      state.currentProjectId === projectId && state.historyProjectId === projectId
        ? {
            outputHistoryRecords: state.outputHistoryRecords.filter((e) => e.id !== entryId),
            historyTotalCount: Math.max(0, state.historyTotalCount - 1),
          }
        : {}
    ));
  },

  clearNodeHistory: async (nodeId) => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    await deleteNodeHistoryEntries(projectId, nodeId).catch(() => {});
    if (get().currentProjectId !== projectId) return;
    await get().loadHistoryFromDb(activeHistoryQuery);
  },

  clearAllHistory: async () => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    await clearAllHistoryEntries(projectId).catch(() => {});
    if (get().currentProjectId !== projectId) return;
    historyCursor = null;
    set({
      outputHistoryRecords: [],
      historyProjectId: projectId,
      historyTotalCount: 0,
      historyHasMore: false,
      historyLoading: false,
    });
  },
});
