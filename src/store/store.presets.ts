/**
 * Preset slice — user-defined prompt presets CRUD
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { UserPreset, PresetNodeType, PresetRunRequest, PresetFolder } from '../types';
import * as fileService from '../services/fileService';
import { generateId } from './store.utils';
import { normalizePresetFolderName, resolvePresetFolderId } from '../utils/presetFolders';

export interface PresetSlice {
  userPresets: UserPreset[];
  presetFolders: PresetFolder[];
  presetManagerOpen: boolean;
  presetRunRequest: PresetRunRequest | null;
  setPresetManagerOpen: (open: boolean) => void;
  setPresetRunRequest: (request: PresetRunRequest | null) => void;
  addUserPreset: (preset: UserPreset) => Promise<void>;
  updateUserPreset: (id: string, data: Partial<UserPreset>) => Promise<void>;
  deleteUserPreset: (id: string) => Promise<void>;
  addPresetFolder: (nodeType: PresetNodeType, name: string) => Promise<PresetFolder>;
  renamePresetFolder: (id: string, name: string) => Promise<void>;
  deletePresetFolder: (id: string) => Promise<void>;
  loadPresets: () => Promise<void>;
}

export const createPresetSlice: StateCreator<AppState, [], [], PresetSlice> = (set, get) => {
  // 指令保存和文件夹移除共用队列，失败不污染内存，也不会阻塞后续重试。
  let writeQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T,>(write: () => Promise<T>): Promise<T> => {
    const operation = writeQueue.then(write);
    writeQueue = operation.catch(() => undefined);
    return operation;
  };
  return {
    userPresets: [],
    presetFolders: [],
    presetManagerOpen: false,
    presetRunRequest: null,

    setPresetManagerOpen: (open) => set({ presetManagerOpen: open }),
    setPresetRunRequest: (request) => set({ presetRunRequest: request }),

    addUserPreset: (preset) => enqueue(async () => {
      const saved = { ...preset, folderId: resolvePresetFolderId(preset, get().presetFolders) };
      await fileService.savePreset(saved);
      set((state) => ({ userPresets: [...state.userPresets.filter((item) => item.id !== saved.id), saved] }));
    }),

    updateUserPreset: (id, data) => enqueue(async () => {
      const preset = get().userPresets.find((item) => item.id === id);
      if (!preset) throw new Error('快捷指令不存在');
      const updated = { ...preset, ...data, id };
      updated.folderId = resolvePresetFolderId(updated, get().presetFolders);
      await fileService.savePreset(updated);
      set((state) => ({ userPresets: state.userPresets.map((item) => item.id === id ? updated : item) }));
    }),

    deleteUserPreset: (id) => enqueue(async () => {
      await fileService.deletePreset(id);
      set((state) => ({
        userPresets: state.userPresets.filter((p) => p.id !== id),
      }));
    }),

    addPresetFolder: (nodeType, name) => enqueue(async () => {
      const folder: PresetFolder = { id: 'preset-folder-' + generateId(), nodeType, name: normalizePresetFolderName(name) };
      await fileService.savePresetFolder(folder);
      set((state) => ({ presetFolders: [...state.presetFolders, folder] }));
      return folder;
    }),

    renamePresetFolder: (id, name) => enqueue(async () => {
      const existing = get().presetFolders.find((folder) => folder.id === id);
      if (!existing) throw new Error('文件夹不存在');
      const folder = { ...existing, name: normalizePresetFolderName(name) };
      await fileService.savePresetFolder(folder);
      set((state) => ({ presetFolders: state.presetFolders.map((item) => item.id === id ? folder : item) }));
    }),

    deletePresetFolder: (id) => enqueue(async () => {
      await fileService.deletePresetFolder(id);
      set((state) => ({
        presetFolders: state.presetFolders.filter((folder) => folder.id !== id),
        userPresets: state.userPresets.map((preset) => preset.folderId === id ? { ...preset, folderId: undefined } : preset),
      }));
    }),

    loadPresets: () => enqueue(async () => {
      const [records, folders] = await Promise.all([fileService.loadPresets(), fileService.loadPresetFolders()]);
      set({
        presetFolders: folders,
        userPresets: records.map((r) => ({
          id: r.id,
          nodeType: r.nodeType as PresetNodeType,
          name: r.name,
          description: r.description,
          promptTemplate: r.promptTemplate,
          icon: r.icon,
          thumbnail: r.thumbnail,
          triggerMode: (r.triggerMode as UserPreset['triggerMode']) || 'direct',
          folderId: resolvePresetFolderId({ nodeType: r.nodeType as PresetNodeType, folderId: r.folderId }, folders),
          model: r.model,
          provider: r.provider,
          imageSize: r.imageSize,
          aspectRatio: r.aspectRatio,
          mode: r.mode === 'advanced' ? 'advanced' : 'basic',
          advanced: r.advanced,
        })),
      });
    }),
  };
};
