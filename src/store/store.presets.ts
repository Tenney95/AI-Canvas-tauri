/**
 * Preset slice — user-defined prompt presets CRUD
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { UserPreset, PresetNodeType, PresetRunRequest } from '../types';
import * as fileService from '../services/fileService';

export interface PresetSlice {
  userPresets: UserPreset[];
  presetManagerOpen: boolean;
  presetRunRequest: PresetRunRequest | null;
  setPresetManagerOpen: (open: boolean) => void;
  setPresetRunRequest: (request: PresetRunRequest | null) => void;
  addUserPreset: (preset: UserPreset) => Promise<void>;
  updateUserPreset: (id: string, data: Partial<UserPreset>) => Promise<void>;
  deleteUserPreset: (id: string) => Promise<void>;
  loadPresets: () => Promise<void>;
}

export const createPresetSlice: StateCreator<AppState, [], [], PresetSlice> = (set, get) => ({
  userPresets: [],
  presetManagerOpen: false,
  presetRunRequest: null,

  setPresetManagerOpen: (open) => set({ presetManagerOpen: open }),
  setPresetRunRequest: (request) => set({ presetRunRequest: request }),

  addUserPreset: async (preset) => {
    set((state) => ({ userPresets: [...state.userPresets, preset] }));
    await fileService.savePreset({ ...preset }).catch((e) => console.warn('[保存预设] 持久化失败:', e));
  },

  updateUserPreset: async (id, data) => {
    set((state) => ({
      userPresets: state.userPresets.map((p) =>
        p.id === id ? { ...p, ...data } : p,
      ),
    }));
    const updated = get().userPresets.find((p) => p.id === id);
    if (updated) {
      await fileService.savePreset({ ...updated }).catch((e) => console.warn('[更新预设] 持久化失败:', e));
    }
  },

  deleteUserPreset: async (id) => {
    set((state) => ({
      userPresets: state.userPresets.filter((p) => p.id !== id),
    }));
    await fileService.deletePreset(id).catch((e) => console.warn('[删除预设] 清理失败:', e));
  },

  loadPresets: async () => {
    const records = await fileService.loadPresets();
    if (records.length > 0) {
      set({
        userPresets: records.map((r) => ({
          id: r.id,
          nodeType: r.nodeType as PresetNodeType,
          name: r.name,
          description: r.description,
          promptTemplate: r.promptTemplate,
          icon: r.icon,
          thumbnail: r.thumbnail,
          triggerMode: (r.triggerMode as UserPreset['triggerMode']) || 'direct',
          model: r.model,
          provider: r.provider,
          imageSize: r.imageSize,
          aspectRatio: r.aspectRatio,
          mode: r.mode === 'advanced' ? 'advanced' : 'basic',
          advanced: r.advanced,
        })),
      });
    }
  },
});
