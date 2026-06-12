/**
 * History Record slice — AI 输出历史记录 CRUD
 * 每节点独立存储输出历史，不限条数，用户手动管理
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { OutputHistoryEntry, BaseNodeData } from '../types';
import { generateId } from './store.utils';

export interface HistoryRecordSlice {
  /** 追加一条输出历史到指定节点 */
  recordOutputHistory: (nodeId: string, entry: Omit<OutputHistoryEntry, 'id'>) => void;
  /** 删除指定节点的某条历史 */
  deleteHistoryEntry: (nodeId: string, entryId: string) => void;
  /** 清空指定节点的全部历史 */
  clearNodeHistory: (nodeId: string) => void;
  /** 清空所有节点的全部历史 */
  clearAllHistory: () => void;
}

export const createHistoryRecordSlice: StateCreator<AppState, [], [], HistoryRecordSlice> = (set, _get) => ({
  recordOutputHistory: (nodeId, entry) => {
    const id = `hist-${generateId()}`;
    const record: OutputHistoryEntry = { ...entry, id };
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              data: {
                ...n.data,
                outputHistory: [...(n.data.outputHistory || []), record],
              } as BaseNodeData,
            }
          : n,
      ),
    }));
  },

  deleteHistoryEntry: (nodeId, entryId) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              data: {
                ...n.data,
                outputHistory: (n.data.outputHistory || []).filter((e) => e.id !== entryId),
              } as BaseNodeData,
            }
          : n,
      ),
    }));
  },

  clearNodeHistory: (nodeId) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, outputHistory: [] } as BaseNodeData }
          : n,
      ),
    }));
  },

  clearAllHistory: () => {
    set((state) => ({
      nodes: state.nodes.map((n) => ({
        ...n,
        data: { ...n.data, outputHistory: [] } as BaseNodeData,
      })),
    }));
  },
});
