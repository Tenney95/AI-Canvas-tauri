/** 用户代码插件：安装记录、启停与 IndexedDB 持久化。 */
import { invoke } from '@tauri-apps/api/core';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type {
  InstalledPlugin,
  PluginManifest,
  PluginPackageResourcePayload,
} from '../types/plugin';
import { createInstalledPlugin, parsePluginBundle } from '../services/plugins/pluginManifest';
import { clearPluginResources } from '../services/plugins/pluginResourceService';
import {
  deletePluginFromDb,
  getAllPlugins,
  savePluginToDb,
} from '../services/indexedDbService';

export interface PluginSlice {
  installedPlugins: InstalledPlugin[];
  pluginRegistryRepairRequired: boolean;
  installPluginBundle: (
    manifestText: string,
    source: string,
    options?: {
      trustedPythonConfirmed?: boolean;
      expectedSourceDigest?: string;
      /** 自定义界面产物源码；manifest 声明了 ui 时必填。 */
      uiSource?: string;
      /** Manifest 声明的包资源字节；仅进入 Rust 私有快照。 */
      resourcePayloads?: PluginPackageResourcePayload[];
    },
  ) => Promise<InstalledPlugin>;
  setPluginEnabled: (
    id: string,
    enabled: boolean,
    options?: { trustedPythonConfirmed?: boolean },
  ) => Promise<void>;
  deletePlugin: (id: string) => Promise<void>;
  repairPluginRegistry: () => Promise<void>;
  loadPlugins: () => Promise<void>;
}

interface StagedPluginRevision {
  pluginId: string;
  sourceDigest: string;
  revisionDigest: string;
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

function isPluginRegistryCorruption(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes('插件信任注册表损坏')
    || message.includes('插件信任注册表及备份均损坏');
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
  resourcePayloads: PluginPackageResourcePayload[] = [],
): Promise<StagedPluginRevision> {
  const raw = await invoke<unknown>('stage_plugin_revision', {
    manifest,
    source,
    uiSource,
    resourcePayloads,
  });
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
    revisionDigest: normalizeSourceDigest(result.revisionDigest, '原生插件 revision 摘要'),
  };
}

async function activatePluginRevision(plugin: InstalledPlugin): Promise<void> {
  if (!plugin.sourceDigest) throw new Error('插件源码摘要缺失');
  if (!plugin.revisionDigest) throw new Error('插件 revision 摘要缺失');
  await invoke('activate_plugin_revision', {
    pluginId: plugin.id,
    sourceDigest: plugin.sourceDigest,
    revisionDigest: plugin.revisionDigest,
    enabled: plugin.enabled,
  });
}

async function restoreNativePluginRevision(
  previous: InstalledPlugin | undefined,
  pluginId: string,
): Promise<void> {
  if (previous?.sourceDigest && previous.revisionDigest) {
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
      resourcePayloads?: PluginPackageResourcePayload[];
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
      const staged = await stagePluginRevision(
        manifest,
        source,
        options?.uiSource,
        options?.resourcePayloads,
      );
      const plugin = {
        ...createInstalledPlugin(manifest, source, previous),
        sourceDigest: staged.sourceDigest,
        revisionDigest: staged.revisionDigest,
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
        if (previous.revisionDigest !== plugin.revisionDigest) clearPluginResources(plugin.id);
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
        clearPluginResources(manifest.id);
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
      clearPluginResources(id);
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
    const plugin = get().installedPlugins.find((item) => item.id === id);
    const disabled = plugin ? { ...plugin, enabled: false } : undefined;
    // 先撤销执行租约；两处持久化都删除成功后才隐藏列表项，避免卸载失败被误认为成功。
    set((state) => ({
      installedPlugins: state.installedPlugins.map((item) => (
        item.id === id && disabled ? disabled : item
      )),
    }));
    clearPluginResources(id);
    let nativeRemoved = false;
    try {
      await invoke('remove_plugin_registration', { pluginId: id });
      nativeRemoved = true;
      await deletePluginFromDb(id);
    } catch (error) {
      if (isPluginRegistryCorruption(error)) {
        set({ pluginRegistryRepairRequired: true });
      }
      let message = nativeRemoved
        ? `插件原生注册已移除，但删除安装记录失败：${errorMessage(error)}`
        : `插件卸载失败，原生注册删除状态未确认：${errorMessage(error)}`;
      if (disabled) {
        message += '；插件已在当前会话停用并保留在列表中，可重试卸载';
        try {
          await savePluginToDb(disabled);
        } catch (persistError) {
          message += `；停用状态保存失败：${errorMessage(persistError)}`;
        }
      }
      throw new Error(message, { cause: error });
    }
    set((state) => ({
      installedPlugins: state.installedPlugins.filter((item) => item.id !== id),
    }));
  };

  return {
    installedPlugins: [],
    pluginRegistryRepairRequired: false,

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

    repairPluginRegistry: async () => {
      const repaired = await invoke<boolean>('repair_plugin_registry');
      if (!repaired) {
        set({ pluginRegistryRepairRequired: false });
        get().showToast('插件信任注册表状态正常，无需修复');
        return;
      }
      const disabledPlugins = get().installedPlugins.map((plugin) => ({
        ...plugin,
        enabled: false,
        updatedAt: Date.now(),
      }));
      for (const plugin of disabledPlugins) clearPluginResources(plugin.id);
      set({
        installedPlugins: disabledPlugins,
        pluginRegistryRepairRequired: false,
      });
      const results = await Promise.allSettled(disabledPlugins.map(savePluginToDb));
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(`插件信任注册表已修复，但有 ${failed} 个插件的停用状态保存失败`);
      }
      get().showToast('插件信任注册表已修复；请重试卸载或重新安装插件');
    },

    loadPlugins: async () => {
      const plugins: InstalledPlugin[] = [];
      let repairRequired = false;
      for (const persisted of await getAllPlugins()) {
        let plugin: InstalledPlugin = {
          ...persisted,
          manifest: {
            ...persisted.manifest,
            runtime: persisted.manifest.runtime ?? 'javascript',
          },
        };
        try {
          if (plugin.manifest.apiVersion !== 1) {
            throw new Error('已安装插件不符合当前 API v1，请重新安装');
          }
          if (plugin.sourceDigest && plugin.revisionDigest) {
            plugin = {
              ...plugin,
              sourceDigest: normalizeSourceDigest(plugin.sourceDigest, '已安装插件源码摘要'),
              revisionDigest: normalizeSourceDigest(plugin.revisionDigest, '已安装插件 revision 摘要'),
            };
            await invoke('ensure_plugin_registration', {
              pluginId: plugin.id,
              sourceDigest: plugin.sourceDigest,
              revisionDigest: plugin.revisionDigest,
              enabled: plugin.enabled,
            });
          } else {
            throw new Error('已安装插件缺少完整 revision 摘要，请重新安装');
          }
        } catch (error) {
          if (isPluginRegistryCorruption(error)) repairRequired = true;
          plugin = await failClosedPlugin(plugin);
        }
        plugins.push(plugin);
      }
      set({
        installedPlugins: plugins.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)),
        pluginRegistryRepairRequired: repairRequired,
      });
    },
  };
};
