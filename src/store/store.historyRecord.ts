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
  clearAllHistoryEntries,
  deleteNodeHistoryEntries,
} from '../services/indexedDbService';
import type { HistoryPageCursor, HistoryQuery } from '../services/indexedDbService';

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

export interface HistoryRecordSlice {
  /** 全局输出历史记录（独立于节点，节点删除后记录不丢失） */
  outputHistoryRecords: OutputHistoryEntry[];
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
  recordOutputHistory: (nodeId: string, entry: Omit<OutputHistoryEntry, 'id'>) => Promise<void>;
  /** 删除某条历史 */
  deleteHistoryEntry: (nodeId: string, entryId: string) => Promise<void>;
  /** 清空指定节点的全部历史 */
  clearNodeHistory: (nodeId: string) => Promise<void>;
  /** 清空所有节点的全部历史 */
  clearAllHistory: () => Promise<void>;
}

export const createHistoryRecordSlice: StateCreator<AppState, [], [], HistoryRecordSlice> = (set, get) => ({
  outputHistoryRecords: [],
  historyTotalCount: 0,
  historyHasMore: false,
  historyLoading: false,

  loadHistoryFromDb: async (query = {}) => {
    const requestId = ++historyLoadRequestId;
    activeHistoryQuery = query;
    historyCursor = null;
    set({ outputHistoryRecords: [], historyHasMore: false, historyLoading: true });
    try {
      const [page, totalCount] = await Promise.all([
        getHistoryEntriesPage(HISTORY_PAGE_SIZE, null, query),
        getHistoryEntryCount(),
      ]);
      if (requestId !== historyLoadRequestId) return;
      historyCursor = page.nextCursor;
      set({
        outputHistoryRecords: page.records as OutputHistoryEntry[],
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
    const queryKey = getHistoryQueryKey(query);
    if (queryKey !== getHistoryQueryKey(activeHistoryQuery)) {
      await get().loadHistoryFromDb(query);
      return;
    }
    if (get().historyLoading || !get().historyHasMore) return;

    const requestId = ++historyLoadRequestId;
    set({ historyLoading: true });
    try {
      const page = await getHistoryEntriesPage(HISTORY_PAGE_SIZE, historyCursor, query);
      if (requestId !== historyLoadRequestId) return;
      historyCursor = page.nextCursor;
      set((state) => ({
        outputHistoryRecords: [...state.outputHistoryRecords, ...page.records] as OutputHistoryEntry[],
        historyHasMore: page.hasMore,
        historyLoading: false,
      }));
    } catch (e) {
      console.warn('Failed to load more history from IndexedDB:', e);
      if (requestId === historyLoadRequestId) set({ historyLoading: false });
    }
  },

  getHistoryForExport: async (query = {}) => (
    getHistoryEntriesForExport(query) as Promise<OutputHistoryEntry[]>
  ),

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

          await putHistoryEntries(legacyRecords);
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
    const id = `hist-${generateId()}`;
    const record: OutputHistoryEntry = { ...entry, id };
    // Persist to IndexedDB first, then update store
    await putHistoryEntry(record).catch((e) => console.warn('Failed to persist history entry:', e));
    set((state) => ({
      outputHistoryRecords: matchesHistoryQuery(record, activeHistoryQuery)
        ? [record, ...state.outputHistoryRecords]
        : state.outputHistoryRecords,
      historyTotalCount: state.historyTotalCount + 1,
    }));
  },

  deleteHistoryEntry: async (_nodeId, entryId) => {
    await deleteHistoryEntryFromDb(entryId).catch(() => {});
    set((state) => ({
      outputHistoryRecords: state.outputHistoryRecords.filter((e) => e.id !== entryId),
      historyTotalCount: Math.max(0, state.historyTotalCount - 1),
    }));
  },

  clearNodeHistory: async (nodeId) => {
    await deleteNodeHistoryEntries(nodeId).catch(() => {});
    await get().loadHistoryFromDb(activeHistoryQuery);
  },

  clearAllHistory: async () => {
    await clearAllHistoryEntries().catch(() => {});
    historyCursor = null;
    set({
      outputHistoryRecords: [],
      historyTotalCount: 0,
      historyHasMore: false,
      historyLoading: false,
    });
  },
});
