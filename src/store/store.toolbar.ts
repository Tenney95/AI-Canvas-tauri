/**
 * store.toolbar.ts — Toolbar 自定义布局持久化
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { ToolbarLayout, ToolbarLayouts } from '../types';

export interface ToolbarSlice {
  toolbarLayouts: ToolbarLayouts;

  /** 保存某个 nodeType 的 Toolbar 布局 */
  setToolbarLayout: (nodeType: string, layout: ToolbarLayout) => void;

  /** 重置某个 nodeType 的 Toolbar 布局为默认值 */
  resetToolbarLayout: (nodeType: string) => void;
}

export const createToolbarSlice: StateCreator<AppState, [], [], ToolbarSlice> = (set) => ({
  toolbarLayouts: {},

  setToolbarLayout: (nodeType, layout) =>
    set((s) => ({
      toolbarLayouts: { ...s.toolbarLayouts, [nodeType]: layout },
    })),

  resetToolbarLayout: (nodeType) =>
    set((s) => {
      const next = { ...s.toolbarLayouts };
      delete next[nodeType];
      return { toolbarLayouts: next };
    }),
});
