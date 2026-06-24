/**
 * Style slice — user-defined custom styles CRUD
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { CustomStyle } from '../types';
import * as fileService from '../services/fileService';

export interface StyleSlice {
  customStyles: CustomStyle[];
  loadCustomStyles: () => Promise<void>;
  addCustomStyle: (style: Omit<CustomStyle, 'id' | 'createdAt'>) => Promise<void>;
  updateCustomStyle: (id: string, data: Partial<CustomStyle>) => Promise<void>;
  deleteCustomStyle: (id: string) => Promise<void>;
}

export const createStyleSlice: StateCreator<AppState, [], [], StyleSlice> = (set, get) => ({
  customStyles: [],

  loadCustomStyles: async () => {
    const records = await fileService.loadStyles();
    if (records.length > 0) {
      set({
        customStyles: records.map((r) => ({
          id: r.id,
          nodeType: r.nodeType,
          name: r.name,
          prompt: r.prompt,
          thumbnail: r.thumbnail,
          createdAt: r.createdAt,
        })),
      });
    }
  },

  addCustomStyle: async (style) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const record: CustomStyle = { ...style, id, createdAt: Date.now() };
    set((state) => ({ customStyles: [...state.customStyles, record] }));
    await fileService.saveStyle({ ...record }).catch((e) => console.warn('[保存画风] 持久化失败:', e));
  },

  updateCustomStyle: async (id, data) => {
    set((state) => ({
      customStyles: state.customStyles.map((s) =>
        s.id === id ? { ...s, ...data } : s,
      ),
    }));
    const updated = get().customStyles.find((s) => s.id === id);
    if (updated) {
      await fileService.saveStyle({ ...updated }).catch((e) => console.warn('[更新画风] 持久化失败:', e));
    }
  },

  deleteCustomStyle: async (id) => {
    set((state) => ({
      customStyles: state.customStyles.filter((s) => s.id !== id),
    }));
    await fileService.deleteStyle(id).catch((e) => console.warn('[删除画风] 清理失败:', e));
  },
});
