/**
 * Config slice — API provider configuration (keys, URLs) persistence
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { ApiProviderConfig, AppConfig, GeneralModelConfig } from '../types';
import * as fileService from '../services/fileService';
import { setBaseDataDir, syncAuthorizedDirectories } from '../services/fileService';

const defaultConfig: AppConfig = {
  providers: {},
  theme: 'dark',
  canvasBackground: 'default',
  comfyUIUrl: 'http://127.0.0.1:8188',
  comfyUIPath: '',
  generalModels: [],
  mascotVisible: false,
  interactionMode: 'default',
};

export interface ConfigSlice {
  config: AppConfig;
  /** IndexedDB 配置已成功读取；为 false 时禁止持久化默认配置。 */
  configHydrated: boolean;
  updateConfig: (config: Partial<AppConfig>) => void;
  setProviderKey: (providerName: string, key: string) => void;
  setProviderUrl: (providerName: string, url: string) => void;
  setProviderConfig: (providerName: string, cfg: Partial<ApiProviderConfig>) => void;
  saveProviderConfig: (providerName: string, cfg: ApiProviderConfig) => void;
  removeProviderConfig: (providerName: string) => void;
  addGeneralModel: (model: Omit<GeneralModelConfig, 'id'>) => void;
  updateGeneralModel: (id: string, model: Partial<GeneralModelConfig>) => void;
  removeGeneralModel: (id: string) => void;
  saveConfig: () => Promise<void>;
  loadConfig: () => Promise<void>;
}

function createGeneralModelId(providerConfigId: string, modelId: string): string {
  const safeProviderId = providerConfigId.replace(/[^a-zA-Z0-9_-]/g, '-');
  let hash = 2166136261;
  for (let index = 0; index < modelId.length; index += 1) {
    hash ^= modelId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `provider-${safeProviderId}-${(hash >>> 0).toString(36)}`;
}

function syncCustomProviderModels(
  generalModels: GeneralModelConfig[],
  providerConfigId: string,
  config: ApiProviderConfig,
): GeneralModelConfig[] {
  if (config.catalogId !== 'custom-openai' || config.selectedModels === undefined) return generalModels;

  const linkedModels = new Map(
    generalModels
      .filter((model) => model.providerConfigId === providerConfigId)
      .map((model) => [model.modelId, model]),
  );
  const otherModels = generalModels.filter((model) => model.providerConfigId !== providerConfigId);
  const selectedModels = config.selectedModels.map((model) => {
    const existing = linkedModels.get(model.id);
    return {
      id: existing?.id || createGeneralModelId(providerConfigId, model.id),
      name: model.name,
      openaiUrl: config.baseUrl || '',
      anthropicUrl: config.anthropicUrl || '',
      modelId: model.id,
      apiKey: config.apiKey,
      category: model.category,
      contextWindow: existing?.contextWindow,
      providerConfigId,
      executionProfile: model.executionProfile,
    } satisfies GeneralModelConfig;
  });
  return [...otherModels, ...selectedModels];
}

function migrateLegacyGeneralModels(config: AppConfig): AppConfig {
  const generalModels = config.generalModels ?? [];
  if (generalModels.length === 0 || generalModels.every((model) => model.providerConfigId)) return config;

  const providers = { ...config.providers };
  const connectionBySignature = new Map<string, string>();
  for (const [providerId, provider] of Object.entries(providers)) {
    if (provider.catalogId !== 'custom-openai') continue;
    connectionBySignature.set(
      `${provider.baseUrl || ''}\u0000${provider.anthropicUrl || ''}\u0000${provider.apiKey}`,
      providerId,
    );
  }

  let nextCustomIndex = 1;
  const migratedModels = generalModels.map((model) => {
    if (model.providerConfigId) return model;
    const signature = `${model.openaiUrl}\u0000${model.anthropicUrl}\u0000${model.apiKey}`;
    let providerConfigId = connectionBySignature.get(signature);
    if (!providerConfigId) {
      do {
        providerConfigId = `custom-${nextCustomIndex}`;
        nextCustomIndex += 1;
      } while (providers[providerConfigId]);
      providers[providerConfigId] = {
        name: model.name || '自定义接口',
        apiKey: model.apiKey,
        baseUrl: model.openaiUrl,
        anthropicUrl: model.anthropicUrl,
        catalogId: 'custom-openai',
        selectedModels: [],
      };
      connectionBySignature.set(signature, providerConfigId);
    }
    const provider = providers[providerConfigId];
    if (!provider.selectedModels?.some((selection) => selection.id === model.modelId)) {
      provider.selectedModels = [
        ...(provider.selectedModels ?? []),
        {
          id: model.modelId,
          name: model.name,
          category: model.category,
          provider: providerConfigId,
        },
      ];
    }
    return { ...model, providerConfigId };
  });

  return { ...config, providers, generalModels: migratedModels };
}

export const createConfigSlice: StateCreator<AppState, [], [], ConfigSlice> = (set, get) => ({
  config: { ...defaultConfig },
  configHydrated: false,

  updateConfig: (partial) => {
    set((state) => ({ config: { ...state.config, ...partial } }));
    if ('baseDataDir' in partial && partial.baseDataDir !== undefined) {
      setBaseDataDir(partial.baseDataDir);
    }
  },

  setProviderKey: (providerName, key) =>
    set((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          [providerName]: {
            ...(state.config.providers[providerName] || { name: providerName }),
            apiKey: key,
          },
        },
      },
    })),

  setProviderUrl: (providerName, url) =>
    set((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          [providerName]: {
            ...(state.config.providers[providerName] || { name: providerName, apiKey: '' }),
            baseUrl: url,
          },
        },
      },
    })),

  setProviderConfig: (providerName, cfg) =>
    set((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          [providerName]: {
            ...(state.config.providers[providerName] || { name: providerName, apiKey: '' }),
            ...cfg,
          },
        },
      },
    })),

  saveProviderConfig: (providerName, cfg) =>
    set((state) => ({
      config: {
        ...state.config,
        providers: { ...state.config.providers, [providerName]: cfg },
        generalModels: syncCustomProviderModels(
          state.config.generalModels ?? [],
          providerName,
          cfg,
        ),
      },
    })),

  removeProviderConfig: (providerName) =>
    set((state) => {
      const providers = { ...state.config.providers };
      delete providers[providerName];
      return {
        config: {
          ...state.config,
          providers,
          generalModels: (state.config.generalModels ?? []).filter(
            (model) => model.providerConfigId !== providerName,
          ),
        },
      };
    }),

  addGeneralModel: (model) =>
    set((state) => ({
      config: {
        ...state.config,
        generalModels: [
          ...(state.config.generalModels || []),
          { ...model, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) },
        ],
      },
    })),

  updateGeneralModel: (id, model) =>
    set((state) => ({
      config: {
        ...state.config,
        generalModels: (state.config.generalModels || []).map((m) =>
          m.id === id ? { ...m, ...model } : m,
        ),
      },
    })),

  removeGeneralModel: (id) =>
    set((state) => ({
      config: {
        ...state.config,
        generalModels: (state.config.generalModels || []).filter((m) => m.id !== id),
      },
    })),

  saveConfig: async () => {
    const { config, configHydrated, showToast } = get();
    if (!configHydrated) {
      console.warn('[设置] 配置尚未完成加载，已阻止默认值覆盖持久化配置');
      return;
    }
    try {
      await fileService.saveConfig(config);
      // 同步 baseDataDir 到 fileService
      setBaseDataDir(config.baseDataDir);
      await syncAuthorizedDirectories(config);
      showToast('设置已保存');
    } catch {
      showToast('设置保存失败', 'error');
    }
  },

  loadConfig: async () => {
    let saved: unknown | null;
    try {
      saved = await fileService.loadConfig();
    } catch {
      set({ configHydrated: false });
      console.warn('[设置] 配置加载失败，已阻止默认值覆盖持久化配置');
      return;
    }

    if (!saved) {
      set({ configHydrated: true });
      return;
    }

    const cfg = migrateLegacyGeneralModels({ ...defaultConfig, ...(saved as AppConfig) });
    set({ config: cfg, configHydrated: true });
    try {
      setBaseDataDir(cfg.baseDataDir);
      await syncAuthorizedDirectories(cfg);
    } catch {
      console.warn('[设置] 配置已加载，但文件目录授权同步失败');
    }
  },
});
