/**
 * Config slice — API provider configuration (keys, URLs) persistence
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { AppConfig } from '../types';
import * as fileService from '../services/fileService';
import { setBaseDataDir } from '../services/fileService';

const defaultConfig: AppConfig = {
  providers: {},
  theme: 'dark',
  localLLMUrl: '',
  comfyUIUrl: '',
};

export interface ConfigSlice {
  config: AppConfig;
  updateConfig: (config: Partial<AppConfig>) => void;
  setProviderKey: (providerName: string, key: string) => void;
  setProviderUrl: (providerName: string, url: string) => void;
  setProviderConfig: (providerName: string, cfg: Partial<{ apiKey: string; baseUrl: string }>) => void;
  saveConfig: () => Promise<void>;
  loadConfig: () => Promise<void>;
}

export const createConfigSlice: StateCreator<AppState, [], [], ConfigSlice> = (set, get) => ({
  config: { ...defaultConfig },

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

  saveConfig: async () => {
    const { config, showToast } = get();
    try {
      await fileService.saveConfig(config);
      // 同步 baseDataDir 到 fileService
      setBaseDataDir(config.baseDataDir);
      showToast('设置已保存');
    } catch {
      showToast('设置保存失败', 'error');
    }
  },

  loadConfig: async () => {
    try {
      const saved = await fileService.loadConfig();
      if (saved) {
        const cfg = { ...defaultConfig, ...(saved as AppConfig) };
        set({ config: cfg });
        setBaseDataDir(cfg.baseDataDir);
      }
    } catch {
      // Use default config if load fails
    }
  },
});
