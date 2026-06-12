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
  deleteHistoryEntryFromDb,
  getAllHistoryEntries,
  clearAllHistoryEntries,
  deleteNodeHistoryEntries,
} from '../services/indexedDbService';

export interface HistoryRecordSlice {
  /** 全局输出历史记录（独立于节点，节点删除后记录不丢失） */
  outputHistoryRecords: OutputHistoryEntry[];
  /** 从 IndexedDB 加载历史记录 */
  loadHistoryFromDb: () => Promise<void>;
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

  loadHistoryFromDb: async () => {
    try {
      const records = await getAllHistoryEntries();
      if (records.length > 0) {
        set({ outputHistoryRecords: records as OutputHistoryEntry[] });
      }
    } catch (e) {
      console.warn('Failed to load history from IndexedDB:', e);
    }
  },

  migrateHistoryAndLoad: async () => {
    const { nodes } = get();
    const existing = await getAllHistoryEntries()
      .catch(() => []);
    const existingIds = new Set(existing.map((r) => r.id));

    // Collect old records from node data and write to IndexedDB (skip duplicates)
    let migratedCount = 0;
    for (const node of nodes) {
      const oldHistory = (node.data as Record<string, unknown>).outputHistory as OutputHistoryEntry[] | undefined;
      if (oldHistory && oldHistory.length > 0) {
        for (const entry of oldHistory) {
          if (!existingIds.has(entry.id)) {
            await putHistoryEntry(entry as OutputHistoryEntry).catch(() => {});
            migratedCount++;
          }
        }
      }
    }

    // Strip outputHistory from all node data
    if (migratedCount > 0) {
      set((state) => ({
        nodes: state.nodes.map((n) => {
          const d = { ...n.data } as Record<string, unknown>;
          if ('outputHistory' in d) {
            delete d.outputHistory;
            return { ...n, data: d as BaseNodeData };
          }
          return n;
        }),
      }));
    }

    // Load all records from IndexedDB
    const allRecords = await getAllHistoryEntries()
      .catch(() => []);
    allRecords.sort((a, b) => b.timestamp - a.timestamp);
    set({ outputHistoryRecords: allRecords as OutputHistoryEntry[] });
  },

  recordOutputHistory: async (_nodeId, entry) => {
    const id = `hist-${generateId()}`;
    const record: OutputHistoryEntry = { ...entry, id };
    // Persist to IndexedDB first, then update store
    await putHistoryEntry(record).catch((e) => console.warn('Failed to persist history entry:', e));
    set((state) => ({
      outputHistoryRecords: [...state.outputHistoryRecords, record],
    }));
  },

  deleteHistoryEntry: async (_nodeId, entryId) => {
    await deleteHistoryEntryFromDb(entryId).catch(() => {});
    set((state) => ({
      outputHistoryRecords: state.outputHistoryRecords.filter((e) => e.id !== entryId),
    }));
  },

  clearNodeHistory: async (nodeId) => {
    await deleteNodeHistoryEntries(nodeId).catch(() => {});
    set((state) => ({
      outputHistoryRecords: state.outputHistoryRecords.filter((e) => e.nodeId !== nodeId),
    }));
  },

  clearAllHistory: async () => {
    await clearAllHistoryEntries().catch(() => {});
    set({ outputHistoryRecords: [] });
  },
});
