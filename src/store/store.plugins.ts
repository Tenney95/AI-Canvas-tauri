/** 用户代码插件：安装记录、启停与 IndexedDB 持久化。 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { InstalledPlugin } from '../types/plugin';
import { createInstalledPlugin, parsePluginBundle } from '../services/plugins/pluginManifest';
import { clearPluginFileGrants } from '../services/plugins/pluginFileGrantService';
import {
  deletePluginFromDb,
  getAllPlugins,
  savePluginToDb,
} from '../services/indexedDbService';

export interface PluginSlice {
  installedPlugins: InstalledPlugin[];
  installPluginBundle: (
    manifestText: string,
    source: string,
    options?: { trustedPythonConfirmed?: boolean },
  ) => Promise<InstalledPlugin>;
  setPluginEnabled: (
    id: string,
    enabled: boolean,
    options?: { trustedPythonConfirmed?: boolean },
  ) => Promise<void>;
  deletePlugin: (id: string) => Promise<void>;
  loadPlugins: () => Promise<void>;
}

export const createPluginSlice: StateCreator<AppState, [], [], PluginSlice> = (set, get) => ({
  installedPlugins: [],

  installPluginBundle: async (manifestText, source, options) => {
    const manifest = parsePluginBundle(manifestText, source);
    if (manifest.runtime === 'python' && options?.trustedPythonConfirmed !== true) {
      throw new Error('安装可信 Python 插件前必须确认其可访问本机资源');
    }
    const previous = get().installedPlugins.find((plugin) => plugin.id === manifest.id);
    const plugin = createInstalledPlugin(manifest, source, previous);
    await savePluginToDb(plugin);
    set((state) => ({
      installedPlugins: [
        ...state.installedPlugins.filter((item) => item.id !== plugin.id),
        plugin,
      ].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)),
    }));
    get().showToast(previous ? `已更新插件「${manifest.name}」` : `已安装插件「${manifest.name}」`);
    return plugin;
  },

  setPluginEnabled: async (id, enabled, options) => {
    const plugin = get().installedPlugins.find((item) => item.id === id);
    if (!plugin) return;
    if (enabled && plugin.manifest.runtime === 'python' && options?.trustedPythonConfirmed !== true) {
      throw new Error('启用可信 Python 插件前必须确认其可访问本机资源');
    }
    const updated = { ...plugin, enabled, updatedAt: Date.now() };
    await savePluginToDb(updated);
    set((state) => ({
      installedPlugins: state.installedPlugins.map((item) => item.id === id ? updated : item),
    }));
    if (!enabled) clearPluginFileGrants(id);
  },

  deletePlugin: async (id) => {
    await deletePluginFromDb(id);
    clearPluginFileGrants(id);
    set((state) => ({
      installedPlugins: state.installedPlugins.filter((plugin) => plugin.id !== id),
    }));
  },

  loadPlugins: async () => {
    const plugins = (await getAllPlugins()).map((plugin) => ({
      ...plugin,
      manifest: {
        ...plugin.manifest,
        runtime: plugin.manifest.runtime ?? 'javascript',
      },
    }));
    set({ installedPlugins: plugins.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)) });
  },
});
