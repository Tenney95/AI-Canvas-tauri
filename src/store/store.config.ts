/**
 * Config slice — API provider configuration (keys, URLs) persistence
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type {
  ApiProviderConfig,
  AppConfig,
  BaseNodeData,
  GeneralModelConfig,
  ProjectSettings,
} from '../types';
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

const MODEL_PREF_KEY = 'canvas-model-prefs';

interface RemovedModelReferences {
  generalModelIds: Set<string>;
  providerIds: Set<string>;
  providerPrefixes: Set<string>;
}

export interface ConfigSlice {
  config: AppConfig;
  /** IndexedDB 配置已成功读取；为 false 时禁止持久化默认配置。 */
  configHydrated: boolean;
  updateConfig: (config: Partial<AppConfig>) => void;
  setProviderKey: (providerName: string, key: string) => void;
  setProviderUrl: (providerName: string, url: string) => void;
  setProviderConfig: (providerName: string, cfg: Partial<ApiProviderConfig>) => void;
  saveProviderConfig: (providerName: string, cfg: ApiProviderConfig) => void;
  removeProviderConfig: (providerName: string) => Promise<void>;
  addGeneralModel: (model: Omit<GeneralModelConfig, 'id'>) => void;
  updateGeneralModel: (id: string, model: Partial<GeneralModelConfig>) => void;
  removeGeneralModel: (id: string) => void;
  saveConfig: (options?: { silent?: boolean }) => Promise<void>;
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
      modelId: model.id,
      category: model.category,
      contextWindow: existing?.contextWindow,
      providerConfigId,
      executionProfile: model.executionProfile,
      imageReferenceRequestMode: model.imageReferenceRequestMode
        ?? existing?.imageReferenceRequestMode,
    } satisfies GeneralModelConfig;
  });
  return [...otherModels, ...selectedModels];
}

function collectRemovedModelReferences(
  config: AppConfig,
  providerConfigId: string,
): RemovedModelReferences {
  const provider = config.providers[providerConfigId];
  // runninghub 仅保存工作流凭据；标准模型连接使用 runninghub-model。
  const isWorkflowOnlyProvider = providerConfigId === 'runninghub';
  const providerIds = new Set<string>(isWorkflowOnlyProvider ? [] : [providerConfigId]);
  const providerPrefixes = new Set<string>(
    isWorkflowOnlyProvider ? [] : [`${providerConfigId}/`],
  );

  if (providerConfigId === 'runninghub-model') {
    providerIds.add('runninghub');
    providerPrefixes.add('runninghub/');
  }
  if (!isWorkflowOnlyProvider && provider?.catalogId && provider.catalogId !== 'custom-openai') {
    providerIds.add(provider.catalogId);
    providerPrefixes.add(`${provider.catalogId}/`);
  }
  for (const model of isWorkflowOnlyProvider ? [] : (provider?.selectedModels ?? [])) {
    providerIds.add(model.provider);
    providerPrefixes.add(`${model.provider}/`);
  }

  return {
    generalModelIds: new Set(
      (config.generalModels ?? [])
        .filter((model) => model.providerConfigId === providerConfigId)
        .map((model) => model.id),
    ),
    providerIds,
    providerPrefixes,
  };
}

function isRemovedModelReference(
  value: string | undefined,
  references: RemovedModelReferences,
): boolean {
  if (!value) return false;
  if (references.generalModelIds.has(value)) return true;
  if (value.startsWith('general/')) {
    return references.generalModelIds.has(value.slice('general/'.length));
  }
  return [...references.providerPrefixes].some((prefix) => value.startsWith(prefix));
}

function clearProjectModelReferences(
  settings: ProjectSettings | undefined,
  references: RemovedModelReferences,
): ProjectSettings | undefined {
  if (!settings?.defaultModels) return settings;

  let changed = false;
  const defaultModels = Object.fromEntries(
    Object.entries(settings.defaultModels).filter(([, model]) => {
      const removed = isRemovedModelReference(model, references);
      changed ||= removed;
      return !removed;
    }),
  ) as NonNullable<ProjectSettings['defaultModels']>;
  if (!changed) return settings;

  const next = { ...settings };
  if (Object.keys(defaultModels).length > 0) next.defaultModels = defaultModels;
  else delete next.defaultModels;
  return next;
}

function clearNodeModelReferences<T extends { data: BaseNodeData }>(
  nodes: T[],
  references: RemovedModelReferences,
): { nodes: T[]; changed: boolean } {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    const removed = isRemovedModelReference(node.data.model, references)
      || (!!node.data.provider && references.providerIds.has(node.data.provider));
    if (!removed) return node;
    changed = true;
    return {
      ...node,
      data: { ...node.data, model: undefined, provider: undefined },
    };
  });
  return { nodes: changed ? nextNodes : nodes, changed };
}

function clearLocalModelPreferences(references: RemovedModelReferences): void {
  try {
    const raw = globalThis.localStorage?.getItem(MODEL_PREF_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw) as Record<string, unknown>;
    let changed = false;
    for (const [nodeType, model] of Object.entries(prefs)) {
      if (typeof model === 'string' && isRemovedModelReference(model, references)) {
        delete prefs[nodeType];
        changed = true;
      }
    }
    if (changed) globalThis.localStorage?.setItem(MODEL_PREF_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage 不可用或旧偏好格式损坏时，不阻断连接删除。
  }
}

interface LegacyGeneralModelConfig extends Omit<GeneralModelConfig, 'providerConfigId'> {
  providerConfigId?: string;
  openaiUrl?: string;
  anthropicUrl?: string;
  apiKey?: string;
}

function sanitizeGeneralModel(
  model: LegacyGeneralModelConfig,
  providerConfigId: string,
): GeneralModelConfig {
  return {
    id: model.id,
    name: model.name,
    modelId: model.modelId,
    category: model.category,
    contextWindow: model.contextWindow,
    providerConfigId,
    executionProfile: model.executionProfile,
    imageReferenceRequestMode: model.imageReferenceRequestMode,
  };
}

function migrateLegacyGeneralModels(config: AppConfig): AppConfig {
  const generalModels = (config.generalModels ?? []) as LegacyGeneralModelConfig[];
  if (generalModels.length === 0) return config;

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
    if (model.providerConfigId) return sanitizeGeneralModel(model, model.providerConfigId);
    const signature = `${model.openaiUrl || ''}\u0000${model.anthropicUrl || ''}\u0000${model.apiKey || ''}`;
    let providerConfigId = connectionBySignature.get(signature);
    if (!providerConfigId) {
      do {
        providerConfigId = `custom-${nextCustomIndex}`;
        nextCustomIndex += 1;
      } while (providers[providerConfigId]);
      providers[providerConfigId] = {
        name: model.name || '自定义接口',
        apiKey: model.apiKey || '',
        baseUrl: model.openaiUrl || '',
        anthropicUrl: model.anthropicUrl || '',
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
          imageReferenceRequestMode: model.imageReferenceRequestMode,
        },
      ];
    }
    return sanitizeGeneralModel(model, providerConfigId);
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

  removeProviderConfig: async (providerName) => {
    const state = get();
    const references = collectRemovedModelReferences(state.config, providerName);
    const providers = { ...state.config.providers };
    delete providers[providerName];

    const nextNodes = clearNodeModelReferences(state.nodes, references);
    const now = Date.now();
    let currentProjectChanged = nextNodes.changed;
    const nextProjects = state.projects.map((project) => {
      const settings = clearProjectModelReferences(project.settings, references);
      if (settings === project.settings) return project;
      if (project.id === state.currentProjectId) currentProjectChanged = true;
      return { ...project, settings, updatedAt: now };
    });

    const nextConfig: AppConfig = {
      ...state.config,
      providers,
      generalModels: (state.config.generalModels ?? []).filter(
        (model) => model.providerConfigId !== providerName,
      ),
    };
    if (isRemovedModelReference(nextConfig.assistantModelId, references)) {
      nextConfig.assistantModelId = undefined;
    }
    if (isRemovedModelReference(nextConfig.assistantImageModelId, references)) {
      nextConfig.assistantImageModelId = undefined;
    }
    if (isRemovedModelReference(nextConfig.assistantVideoModelId, references)) {
      nextConfig.assistantVideoModelId = undefined;
    }

    if (nextNodes.changed) state.commitToHistory();
    clearLocalModelPreferences(references);
    set({ config: nextConfig, nodes: nextNodes.nodes, projects: nextProjects });

    const currentProjectId = state.currentProjectId;
    if (currentProjectChanged && currentProjectId) {
      await get().saveCurrentProjectSilent();
    }

    const records = await fileService.loadProjectsList();
    const changedRecords = records.flatMap((record) => {
      if (record.id === currentProjectId || !Array.isArray(record.nodes)) return [];
      const settings = clearProjectModelReferences(record.settings, references);
      const nodes = clearNodeModelReferences(
        record.nodes as Array<{ data: BaseNodeData }>,
        references,
      );
      if (settings === record.settings && !nodes.changed) return [];
      return [{ ...record, settings, nodes: nodes.nodes, updatedAt: now }];
    });
    if (changedRecords.length === 0) return;

    const results = await Promise.allSettled(
      changedRecords.map((record) => fileService.saveProject(record)),
    );
    const savedIds = new Set<string>();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') savedIds.add(changedRecords[index].id);
      else console.warn('[设置] 厂商已删除，但部分项目模型引用清理失败', result.reason);
    });
    if (savedIds.size > 0) {
      set((latest) => ({
        projects: latest.projects.map((project) => (
          savedIds.has(project.id) ? { ...project, updatedAt: now } : project
        )),
      }));
    }
  },

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

  saveConfig: async (options) => {
    const { config, configHydrated, showToast } = get();
    if (!configHydrated) {
      console.warn('[设置] 配置尚未完成加载，已阻止默认值覆盖持久化配置');
      return;
    }
    try {
      const normalizedConfig = migrateLegacyGeneralModels(config);
      await fileService.saveConfig(normalizedConfig);
      if (normalizedConfig !== config) set({ config: normalizedConfig });
      // 同步 baseDataDir 到 fileService
      setBaseDataDir(normalizedConfig.baseDataDir);
      await syncAuthorizedDirectories(normalizedConfig);
      if (!options?.silent) showToast('设置已保存');
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
