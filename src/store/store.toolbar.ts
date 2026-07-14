/**
 * store.toolbar.ts — Toolbar 自定义布局持久化
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { ToolbarLayout, ToolbarLayouts } from '../types';
import { saveToolbarLayouts, loadToolbarLayouts } from '../services/storageService';

export interface ToolbarSlice {
  toolbarLayouts: ToolbarLayouts;

  /** 保存某个 nodeType 的 Toolbar 布局到内存 + IndexedDB */
  setToolbarLayout: (nodeType: string, layout: ToolbarLayout) => void;

  /** 重置某个 nodeType 的布局 */
  resetToolbarLayout: (nodeType: string) => void;

  /** 从 IndexedDB 加载所有 Toolbar 布局 */
  loadToolbarLayouts: () => Promise<void>;
}

export const createToolbarSlice: StateCreator<AppState, [], [], ToolbarSlice> = (set) => ({
  toolbarLayouts: {},

  setToolbarLayout: (nodeType, layout) => {
    set((s) => {
      const next = { ...s.toolbarLayouts, [nodeType]: layout };
      // 异步持久化到 IndexedDB
      saveToolbarLayouts(next).catch((e) => console.error('Failed to save toolbar layouts:', e));
      return { toolbarLayouts: next };
    });
  },

  resetToolbarLayout: (nodeType) => {
    set((s) => {
      const next = { ...s.toolbarLayouts };
      delete next[nodeType];
      saveToolbarLayouts(next).catch((e) => console.error('Failed to save toolbar layouts:', e));
      return { toolbarLayouts: next };
    });
  },

  loadToolbarLayouts: async () => {
    try {
      const data = await loadToolbarLayouts();
      if (data) {
        set({ toolbarLayouts: data as ToolbarLayouts });
      }
    } catch (e) {
      console.error('Failed to load toolbar layouts:', e);
    }
  },
});
