/** 用户代码插件：安装记录、启停与 IndexedDB 持久化。 */
import { invoke } from '@tauri-apps/api/core';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { InstalledPlugin, PluginManifest } from '../types/plugin';
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
    options?: {
      trustedPythonConfirmed?: boolean;
      expectedSourceDigest?: string;
      /** 自定义界面产物源码；manifest 声明了 ui 时必填。 */
      uiSource?: string;
    },
  ) => Promise<InstalledPlugin>;
  setPluginEnabled: (
    id: string,
    enabled: boolean,
    options?: { trustedPythonConfirmed?: boolean },
  ) => Promise<void>;
  deletePlugin: (id: string) => Promise<void>;
  loadPlugins: () => Promise<void>;
}

interface StagedPluginRevision {
  pluginId: string;
  sourceDigest: string;
}

const SOURCE_DIGEST_RE = /^[0-9a-f]{64}$/u;
const pluginMutationQueues = new Map<string, Promise<void>>();

function enqueuePluginMutation<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
  const previous = pluginMutationQueues.get(pluginId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  pluginMutationQueues.set(pluginId, tail);
  return result.finally(() => {
    if (pluginMutationQueues.get(pluginId) === tail) pluginMutationQueues.delete(pluginId);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSourceDigest(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}缺失`);
  const digest = value.toLowerCase();
  if (!SOURCE_DIGEST_RE.test(digest)) throw new Error(`${label}无效`);
  return digest;
}

function normalizeUiIntegrity(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('sha256-') ? normalized.slice(7) : normalized;
}

async function stagePluginRevision(
  manifest: PluginManifest,
  source: string,
  uiSource?: string,
): Promise<StagedPluginRevision> {
  const raw = await invoke<unknown>('stage_plugin_revision', { manifest, source, uiSource });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('原生插件注册未返回有效结果');
  }
  const result = raw as Record<string, unknown>;
  if (result.pluginId !== manifest.id) {
    throw new Error('原生插件注册返回了不匹配的插件 ID');
  }
  return {
    pluginId: manifest.id,
    sourceDigest: normalizeSourceDigest(result.sourceDigest, '原生插件源码摘要'),
  };
}

async function activatePluginRevision(plugin: InstalledPlugin): Promise<void> {
  if (!plugin.sourceDigest) throw new Error('插件源码摘要缺失');
  await invoke('activate_plugin_revision', {
    pluginId: plugin.id,
    sourceDigest: plugin.sourceDigest,
    enabled: plugin.enabled,
  });
}

async function restoreNativePluginRevision(
  previous: InstalledPlugin | undefined,
  pluginId: string,
): Promise<void> {
  if (previous?.sourceDigest) {
    await activatePluginRevision(previous);
    return;
  }
  await invoke('remove_plugin_registration', { pluginId });
  if (previous) {
    throw new Error('原插件源码摘要缺失，已移除原生注册但无法恢复旧版本');
  }
}

async function restorePersistedPlugin(
  previous: InstalledPlugin | undefined,
  pluginId: string,
): Promise<void> {
  if (previous) {
    await savePluginToDb(previous);
    return;
  }
  await deletePluginFromDb(pluginId);
}

async function failClosedPlugin(plugin: InstalledPlugin): Promise<InstalledPlugin> {
  const disabled = { ...plugin, enabled: false };
  try {
    await invoke('set_plugin_registration_enabled', { pluginId: plugin.id, enabled: false });
  } catch {
    // 注册可能本就不存在；前端与持久化状态仍必须失败关闭。
  }
  try {
    await savePluginToDb(disabled);
  } catch (error) {
    console.error('[plugins] 无法持久化插件停用状态', error);
  }
  return disabled;
}

export const createPluginSlice: StateCreator<AppState, [], [], PluginSlice> = (set, get) => {
  const installPluginBundleCore = async (
    manifest: PluginManifest,
    source: string,
    options?: {
      trustedPythonConfirmed?: boolean;
      expectedSourceDigest?: string;
      uiSource?: string;
    },
  ): Promise<InstalledPlugin> => {
    if (manifest.runtime === 'python' && options?.trustedPythonConfirmed !== true) {
      throw new Error('安装可信 Python 插件前必须确认其可访问本机资源');
    }
    // 产物摘要由 Rust 侧逐字节核对，这里只保证声明了 ui 就一定带着产物。
    if (manifest.ui && !options?.uiSource) {
      throw new Error('插件声明了自定义界面，但缺少界面产物');
    }
    const previous = get().installedPlugins.find((plugin) => plugin.id === manifest.id);
    let previousLeaseRevoked = false;
    try {
      const staged = await stagePluginRevision(manifest, source, options?.uiSource);
      const plugin = {
        ...createInstalledPlugin(manifest, source, previous),
        sourceDigest: staged.sourceDigest,
        ...(manifest.ui
          ? { uiDigest: normalizeUiIntegrity(manifest.ui.integrity) }
          : {}),
      };
      if (options?.expectedSourceDigest !== undefined) {
        const expected = normalizeSourceDigest(options.expectedSourceDigest, '用户确认的插件源码摘要');
        if (staged.sourceDigest !== expected) {
          throw new Error('插件源码摘要与用户确认的版本不一致');
        }
      }
      await savePluginToDb(plugin);
      if (previous) {
        set((state) => ({
          installedPlugins: state.installedPlugins.map((item) => (
            item.id === previous.id ? { ...previous, enabled: false } : item
          )),
        }));
        previousLeaseRevoked = true;
        if (previous.sourceDigest !== plugin.sourceDigest) clearPluginFileGrants(plugin.id);
      }
      await activatePluginRevision(plugin);
      set((state) => ({
        installedPlugins: [
          ...state.installedPlugins.filter((item) => item.id !== plugin.id),
          plugin,
        ].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)),
      }));
      get().showToast(previous ? `已更新插件「${manifest.name}」` : `已安装插件「${manifest.name}」`);
      return plugin;
    } catch (error) {
      const rollbackFailures: string[] = [];
      let nativeRollbackSucceeded = false;
      if (previous && !previous.sourceDigest && !previousLeaseRevoked) {
        set((state) => ({
          installedPlugins: state.installedPlugins.map((item) => (
            item.id === previous.id ? { ...previous, enabled: false } : item
          )),
        }));
        previousLeaseRevoked = true;
        clearPluginFileGrants(manifest.id);
      }
      try {
        await restoreNativePluginRevision(previous, manifest.id);
        nativeRollbackSucceeded = true;
      } catch (rollbackError) {
        rollbackFailures.push(`恢复原生插件注册失败：${errorMessage(rollbackError)}`);
      }
      try {
        await restorePersistedPlugin(previous, manifest.id);
      } catch (rollbackError) {
        rollbackFailures.push(`恢复原插件记录失败：${errorMessage(rollbackError)}`);
      }
      if (previous && previousLeaseRevoked && nativeRollbackSucceeded) {
        set((state) => ({
          installedPlugins: state.installedPlugins.map((item) => (
            item.id === previous.id ? previous : item
          )),
        }));
      }
      if (rollbackFailures.length > 0) {
        throw new Error(`${errorMessage(error)}；${rollbackFailures.join('；')}`, { cause: error });
      }
      throw error;
    }
  };

  const setPluginEnabledCore = async (
    id: string,
    enabled: boolean,
    options?: { trustedPythonConfirmed?: boolean },
  ): Promise<void> => {
    const plugin = get().installedPlugins.find((item) => item.id === id);
    if (!plugin) return;
    if (enabled && plugin.manifest.runtime === 'python' && options?.trustedPythonConfirmed !== true) {
      throw new Error('启用可信 Python 插件前必须确认其可访问本机资源');
    }
    const updated = { ...plugin, enabled, updatedAt: Date.now() };
    if (!enabled) {
      set((state) => ({
        installedPlugins: state.installedPlugins.map((item) => item.id === id ? updated : item),
      }));
      clearPluginFileGrants(id);
    }
    try {
      if (enabled) {
        await activatePluginRevision(updated);
      } else {
        await invoke('set_plugin_registration_enabled', { pluginId: id, enabled: false });
      }
    } catch (error) {
      if (!enabled) {
        throw new Error(
          `插件已在当前会话停用，但原生停用状态未确认：${errorMessage(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      await savePluginToDb(updated);
    } catch (error) {
      try {
        await invoke('set_plugin_registration_enabled', { pluginId: id, enabled: plugin.enabled });
      } catch (rollbackError) {
        throw new Error(
          `${errorMessage(error)}；恢复原生插件启停状态失败：${errorMessage(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      if (!enabled) {
        set((state) => ({
          installedPlugins: state.installedPlugins.map((item) => item.id === id ? plugin : item),
        }));
      }
      throw error;
    }
    if (enabled) {
      set((state) => ({
        installedPlugins: state.installedPlugins.map((item) => item.id === id ? updated : item),
      }));
    }
  };

  const deletePluginCore = async (id: string): Promise<void> => {
    clearPluginFileGrants(id);
    set((state) => ({
      installedPlugins: state.installedPlugins.filter((plugin) => plugin.id !== id),
    }));
    try {
      await invoke('remove_plugin_registration', { pluginId: id });
    } catch (error) {
      throw new Error(
        `插件已从当前会话移除，但原生注册删除状态未确认：${errorMessage(error)}`,
        { cause: error },
      );
    }
    try {
      await deletePluginFromDb(id);
    } catch (error) {
      throw new Error(
        `插件已从原生运行时和当前会话移除，但删除持久化记录失败：${errorMessage(error)}`,
        { cause: error },
      );
    }
  };

  return {
    installedPlugins: [],

    installPluginBundle: async (manifestText, source, options) => {
      const manifest = parsePluginBundle(manifestText, source);
      return enqueuePluginMutation(
        manifest.id,
        () => installPluginBundleCore(manifest, source, options),
      );
    },

    setPluginEnabled: async (id, enabled, options) => enqueuePluginMutation(
      id,
      () => setPluginEnabledCore(id, enabled, options),
    ),

    deletePlugin: async (id) => enqueuePluginMutation(id, () => deletePluginCore(id)),

    loadPlugins: async () => {
      const plugins: InstalledPlugin[] = [];
      for (const persisted of await getAllPlugins()) {
        let plugin: InstalledPlugin = {
          ...persisted,
          manifest: {
            ...persisted.manifest,
            runtime: persisted.manifest.runtime ?? 'javascript',
          },
        };
        try {
          if (plugin.sourceDigest) {
            plugin = {
              ...plugin,
              sourceDigest: normalizeSourceDigest(plugin.sourceDigest, '已安装插件源码摘要'),
            };
            await invoke('ensure_plugin_registration', {
              pluginId: plugin.id,
              sourceDigest: plugin.sourceDigest,
              enabled: plugin.enabled,
            });
          } else {
            const staged = await stagePluginRevision(plugin.manifest, plugin.source);
            plugin = { ...plugin, sourceDigest: staged.sourceDigest };
            await savePluginToDb(plugin);
            await activatePluginRevision(plugin);
          }
        } catch {
          plugin = await failClosedPlugin(plugin);
        }
        plugins.push(plugin);
      }
      set({ installedPlugins: plugins.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)) });
    },
  };
};
