/**
 * Preset slice — user-defined prompt presets CRUD
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { UserPreset, PresetNodeType } from '../types';
import * as fileService from '../services/fileService';

export interface PresetSlice {
  userPresets: UserPreset[];
  presetManagerOpen: boolean;
  setPresetManagerOpen: (open: boolean) => void;
  addUserPreset: (preset: UserPreset) => Promise<void>;
  updateUserPreset: (id: string, data: Partial<UserPreset>) => Promise<void>;
  deleteUserPreset: (id: string) => Promise<void>;
  loadPresets: () => Promise<void>;
}

export const createPresetSlice: StateCreator<AppState, [], [], PresetSlice> = (set, get) => ({
  userPresets: [],
  presetManagerOpen: false,

  setPresetManagerOpen: (open) => set({ presetManagerOpen: open }),

  addUserPreset: async (preset) => {
    set((state) => ({ userPresets: [...state.userPresets, preset] }));
    await fileService.savePreset({ ...preset }).catch(() => {});
  },

  updateUserPreset: async (id, data) => {
    set((state) => ({
      userPresets: state.userPresets.map((p) =>
        p.id === id ? { ...p, ...data } : p,
      ),
    }));
    const updated = get().userPresets.find((p) => p.id === id);
    if (updated) {
      await fileService.savePreset({ ...updated }).catch(() => {});
    }
  },

  deleteUserPreset: async (id) => {
    set((state) => ({
      userPresets: state.userPresets.filter((p) => p.id !== id),
    }));
    await fileService.deletePreset(id).catch(() => {});
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
          thumbnail: r.thumbnail,
          triggerMode: (r.triggerMode as UserPreset['triggerMode']) || 'direct',
        })),
      });
    }
  },
});
