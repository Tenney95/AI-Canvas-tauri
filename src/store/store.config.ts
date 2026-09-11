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
import {
  GRSAI_BASE_URL,
  GRSAI_GLOBAL_BASE_URL,
  GRSAI_LEGACY_BASE_URL,
} from '../constants/api';
import * as fileService from '../services/fileService';
import {
  setBaseDataDir,
  syncAuthorizedDirectories,
  type ProjectSaveData,
} from '../services/fileService';
import { setLocale } from '../i18n';
import { applyConfigPatch, ConfigConflictError, configValuesEqual, configWithoutSecrets, createConfigPatch } from '../services/configPatch';
import { areSettingsMutationsFrozen, registerSettingsPersistence } from '../services/configPersistenceQueue';

const defaultConfig: AppConfig = {
  providers: {},
  theme: 'dark',
  canvasBackground: 'default',
  comfyUIUrl: 'http://127.0.0.1:8188',
  comfyUIPath: '',
  generalModels: [],
  mascotVisible: false,
  interactionMode: 'default',
  nodeToolbarMode: 'icons',
  nodeLabelVisible: true,
  startupView: 'last-project',
  performanceMode: false,
  // language 不给默认值：未设置时按系统语言判定
};

const MODEL_PREF_KEY = 'canvas-model-prefs';

function syncNodeToolbarMode(mode: AppConfig['nodeToolbarMode']): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.nodeToolbarMode = mode ?? 'icons';
}

function syncNodeLabelVisible(visible: AppConfig['nodeLabelVisible']): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.nodeLabelVisible = visible === false ? 'false' : 'true';
}

function syncPerformanceMode(enabled: AppConfig['performanceMode']): void {
  if (typeof document === 'undefined') return;
  document.documentElement.toggleAttribute('data-performance-mode', enabled === true);
}

function migrateLegacyPerformanceMode(config: AppConfig): AppConfig {
  const { graphicsCompatibilityMode, ...current } = config;
  return {
    ...current,
    performanceMode: current.performanceMode ?? graphicsCompatibilityMode ?? false,
  };
}

interface RemovedModelReferences {
  generalModelIds: Set<string>;
  providerIds: Set<string>;
  providerPrefixes: Set<string>;
}

export interface ConfigSlice {
  config: AppConfig;
  /** IndexedDB 配置已成功读取；为 false 时禁止持久化默认配置。 */
  configHydrated: boolean;
  configSaveStatus: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';
  configSaveError: string | null;
  configRevision: number;
  configDirty: boolean;
  /** 运行时基线只保留普通字段；不含 API Key。 */
  configEditBaseline: Record<string, unknown>;
  configPersistedBaseline: unknown;
  configSecretChanges: Record<string, string>;
  configSecretReadErrors: string[];
  updateConfig: (config: Partial<AppConfig>) => void;
  setProviderKey: (providerName: string, key: string) => void;
  setProviderUrl: (providerName: string, url: string) => void;
  setProviderConfig: (providerName: string, cfg: Partial<ApiProviderConfig>) => void;
  saveProviderConfig: (providerName: string, cfg: ApiProviderConfig) => void;
  removeProviderConfig: (providerName: string) => Promise<void>;
  addGeneralModel: (model: Omit<GeneralModelConfig, 'id'>) => void;
  updateGeneralModel: (id: string, model: Partial<GeneralModelConfig>) => void;
  removeGeneralModel: (id: string) => void;
  /** 失败始终拒绝并保留修改；保留 throwOnError 参数兼容既有调用方。 */
  saveConfig: (options?: { silent?: boolean; throwOnError?: boolean }) => Promise<void>;
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

const GENERAL_MODEL_CATALOG_IDS = new Set(['custom-openai', 'cccapi', 'xai', 'google', 'sora2u']);

function syncProviderModels(
  generalModels: GeneralModelConfig[],
  providerConfigId: string,
  config: ApiProviderConfig,
): GeneralModelConfig[] {
  if (!GENERAL_MODEL_CATALOG_IDS.has(config.catalogId ?? '') || config.selectedModels === undefined) {
    return generalModels;
  }

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
      contextWindow: model.contextWindow ?? existing?.contextWindow,
      description: model.description ?? existing?.description,
      inputModalities: model.inputModalities ?? existing?.inputModalities,
      providerConfigId,
      executionProfile: model.executionProfile,
      imageReferenceRequestMode: model.imageReferenceRequestMode
        ?? existing?.imageReferenceRequestMode,
      videoCapability: model.videoCapability,
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
  if (!settings) return settings;

  let changed = isRemovedModelReference(settings.visionModelId, references);
  const defaultModels = Object.fromEntries(
    Object.entries(settings.defaultModels ?? {}).filter(([, model]) => {
      const removed = isRemovedModelReference(model, references);
      changed ||= removed;
      return !removed;
    }),
  ) as NonNullable<ProjectSettings['defaultModels']>;
  if (!changed) return settings;

  const next = { ...settings };
  if (isRemovedModelReference(next.visionModelId, references)) delete next.visionModelId;
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
    description: model.description,
    inputModalities: model.inputModalities,
    providerConfigId,
    executionProfile: model.executionProfile,
    imageReferenceRequestMode: model.imageReferenceRequestMode,
    videoCapability: model.videoCapability,
  };
}

function migrateLegacyGeneralModels(config: AppConfig): AppConfig {
  let providerUrlsChanged = false;
  const normalizedProviders = Object.fromEntries(
    Object.entries(config.providers).map(([providerId, provider]) => {
      const normalizedBaseUrl = provider.baseUrl?.trim().replace(/\/+$/, '');
      const isGrsai = providerId === 'grsai' || provider.catalogId === 'grsai';
      const isLegacyGrsaiUrl = normalizedBaseUrl === GRSAI_LEGACY_BASE_URL
        || normalizedBaseUrl === `${GRSAI_LEGACY_BASE_URL}/v1`
        || normalizedBaseUrl === GRSAI_GLOBAL_BASE_URL;
      if (!isGrsai || !isLegacyGrsaiUrl) {
        return [providerId, provider];
      }
      providerUrlsChanged = true;
      return [providerId, { ...provider, baseUrl: GRSAI_BASE_URL }];
    }),
  );
  const normalizedConfig = providerUrlsChanged
    ? { ...config, providers: normalizedProviders }
    : config;
  const generalModels = (normalizedConfig.generalModels ?? []) as LegacyGeneralModelConfig[];
  if (generalModels.length === 0) return normalizedConfig;

  const providers = { ...normalizedConfig.providers };
  const connectionBySignature = new Map<string, string>();
  for (const [providerId, provider] of Object.entries(providers)) {
    if (provider.catalogId !== 'custom-openai') continue;
    // anthropicUrl 从未参与任何请求，签名里去掉它等于把同网关的旧模型并成一条连接
    connectionBySignature.set(`${provider.baseUrl || ''}\u0000${provider.apiKey}`, providerId);
  }

  let nextCustomIndex = 1;
  const migratedModels = generalModels.map((model) => {
    if (model.providerConfigId) return sanitizeGeneralModel(model, model.providerConfigId);
    const signature = `${model.openaiUrl || ''}\u0000${model.apiKey || ''}`;
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

  return { ...normalizedConfig, providers, generalModels: migratedModels };
}

export const createConfigSlice: StateCreator<AppState, [], [], ConfigSlice> = (rawSet, get) => {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  const set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => rawSet((state) => {
    if (areSettingsMutationsFrozen()) return {};
    const next = typeof partial === 'function' ? partial(state) : partial;
    if (!next.config || next.config === state.config) return next;
    const secretChanges = { ...state.configSecretChanges };
    const providers = { ...next.config.providers };
    for (const [id, provider] of Object.entries(providers)) {
      if (provider.apiKey !== state.config.providers[id]?.apiKey && provider.apiKey) secretChanges[id] = crypto.randomUUID();
      if (!provider.apiKeyRef && state.config.providers[id]?.apiKeyRef) {
        providers[id] = { ...provider, apiKeyRef: state.config.providers[id].apiKeyRef };
      }
      // 表单重建渠道对象时也保留凭据版本；只有持久化提交可以推进版本。
      const revision = Reflect.get(state.config.providers[id] ?? {}, 'apiKeyRevision');
      providers[id] = { ...providers[id] };
      if (revision === undefined) Reflect.deleteProperty(providers[id], 'apiKeyRevision');
      else Reflect.set(providers[id], 'apiKeyRevision', revision);
    }
    for (const id of Object.keys(secretChanges)) if (!providers[id]) delete secretChanges[id];
    const config = { ...next.config, providers };
    const dirty = Object.keys(secretChanges).length > 0 || !configValuesEqual(configWithoutSecrets(config), state.configEditBaseline);
    return { ...next, config, configSecretChanges: secretChanges, configDirty: dirty,
      configRevision: state.configRevision + 1,
      configSaveStatus: state.configSaveStatus === 'saving' ? 'saving' : dirty ? 'dirty' : 'idle',
      configSaveError: null };
  });
  registerSettingsPersistence('config', {
    flush: async (retry) => {
      await tail;
      const state = get();
      if ((state.configDirty && state.configSaveStatus !== 'error' && state.configSaveStatus !== 'conflict')
        || (retry && state.configSaveError !== null)) await state.saveConfig({ silent: true });
      await tail;
    },
    hasUnsaved: () => get().configDirty || get().configSaveError !== null,
  });
  return {
  config: { ...defaultConfig },
  configHydrated: false,
  configSaveStatus: 'idle',
  configSaveError: null,
  configRevision: 0,
  configDirty: false,
  configEditBaseline: configWithoutSecrets(defaultConfig),
  configPersistedBaseline: null,
  configSecretChanges: {},
  configSecretReadErrors: [],

  updateConfig: (partial) => {
    if (areSettingsMutationsFrozen()) return;
    set((state) => ({ config: { ...state.config, ...partial } }));
    if ('baseDataDir' in partial && partial.baseDataDir !== undefined) {
      setBaseDataDir(partial.baseDataDir);
    }
    if ('nodeToolbarMode' in partial) {
      syncNodeToolbarMode(partial.nodeToolbarMode);
    }
    if ('nodeLabelVisible' in partial) {
      syncNodeLabelVisible(partial.nodeLabelVisible);
    }
    if ('performanceMode' in partial) {
      syncPerformanceMode(partial.performanceMode);
    }
    if ('language' in partial) {
      setLocale(partial.language);
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
        generalModels: syncProviderModels(
          state.config.generalModels ?? [],
          providerName,
          cfg,
        ),
      },
    })),

  removeProviderConfig: async (providerName) => {
    if (areSettingsMutationsFrozen()) return;
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

    // 原生凭据由保存配置的事务成功后清理；保存失败不能先删掉 Key。

    const currentProjectId = state.currentProjectId;
    if (currentProjectChanged && currentProjectId) {
      await get().saveCurrentProjectSilent();
    }

    const summaries = await fileService.loadProjectsList();
    const changedRecords: ProjectSaveData[] = [];
    for (const summary of summaries) {
      if (summary.id === currentProjectId) continue;
      const record = await fileService.loadProjectData(summary.id);
      if (!record || !Array.isArray(record.nodes)) continue;
      const settings = clearProjectModelReferences(record.settings, references);
      const nodes = clearNodeModelReferences(
        record.nodes as Array<{ data: BaseNodeData }>,
        references,
      );
      if (settings === record.settings && !nodes.changed) continue;
      changedRecords.push({ ...record, settings, nodes: nodes.nodes, updatedAt: now });
    }
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

  saveConfig: (options) => {
    if (!get().configHydrated) {
      const message = '配置尚未完成加载，不能保存设置';
      if (!get().configSaveError) rawSet({ configSaveStatus: 'error', configSaveError: message });
      const rejected = Promise.reject<void>(new Error(message));
      void rejected.catch(() => {});
      return rejected;
    }
    const snapshot = structuredClone(get().config);
    const secretChanges = { ...get().configSecretChanges };
    const revision = get().configRevision;
    const hydrated = get().configHydrated;
    return enqueue(async () => {
      let committed: unknown;
      let committedFailure: unknown;
      let unstored: string[] = [];
      let directoriesSynced = false;
      try {
        if (!hydrated) throw new Error('配置尚未完成加载，不能保存设置');
        rawSet({ configSaveStatus: 'saving', configSaveError: null });
        const normalized = migrateLegacyGeneralModels(snapshot);
        const changes = createConfigPatch(get().configEditBaseline, configWithoutSecrets(normalized));
        const baseline = get().configPersistedBaseline;
        try {
          unstored = await fileService.saveConfig(normalized, {
            baseline, changes, secretChanges,
            onCommitted: (value) => { committed = value; },
          });
        } catch (error) {
          if (committed === undefined) throw error;
          // 数据库已提交而后续清理失败：仍需推进基线，否则后续撤回/重建会误判为没有修改。
          committedFailure = error;
        }
        if (!Array.isArray(unstored)) throw new Error('配置保存结果无效');
        // 兼容没有附带提交快照的保存适配器；生产路径由真实事务返回快照。
        committed ??= applyConfigPatch(configWithoutSecrets(baseline), changes, false);
        const ordinary = configWithoutSecrets(migrateLegacyGeneralModels({ ...defaultConfig, ...committed as AppConfig }));
        const latest = get();
        const pending = createConfigPatch(configWithoutSecrets(normalized), configWithoutSecrets(latest.config));
        const merged = applyConfigPatch(ordinary, pending, false) as unknown as AppConfig;
        const unread = new Set(latest.configSecretReadErrors.filter((id) => merged.providers?.[id]));
        const nextSecrets = { ...latest.configSecretChanges };
        const oldProviders = (configWithoutSecrets(baseline).providers ?? {}) as Record<string, Record<string, unknown>>;
        const savedProviders = (ordinary.providers ?? {}) as Record<string, Record<string, unknown>>;
        for (const [id, provider] of Object.entries(merged.providers ?? {})) {
          const changedHere = secretChanges[id] && !unstored.includes(id);
          const hasLaterEdit = nextSecrets[id] && nextSecrets[id] !== secretChanges[id];
          const sameCredential = oldProviders[id]?.apiKeyRevision === savedProviders[id]?.apiKeyRevision
            && oldProviders[id]?.apiKeyRef === savedProviders[id]?.apiKeyRef;
          provider.apiKey = hasLaterEdit || changedHere || sameCredential ? latest.config.providers[id]?.apiKey ?? '' : '';
          if (changedHere) unread.delete(id);
          else if (!sameCredential && provider.apiKeyRef && !hasLaterEdit) unread.add(id);
          if (changedHere && nextSecrets[id] === secretChanges[id]) delete nextSecrets[id];
        }
        const dirty = Object.keys(nextSecrets).length > 0 || !configValuesEqual(configWithoutSecrets(merged), ordinary);
        rawSet({ config: merged, configPersistedBaseline: configWithoutSecrets(committed), configEditBaseline: ordinary,
          configSecretChanges: nextSecrets, configSecretReadErrors: [...unread], configDirty: dirty });
        syncNodeToolbarMode(merged.nodeToolbarMode);
        syncNodeLabelVisible(merged.nodeLabelVisible);
        syncPerformanceMode(merged.performanceMode);
        setLocale(merged.language);
        setBaseDataDir(merged.baseDataDir);
        await syncAuthorizedDirectories(merged);
        directoriesSynced = true;
        if (committedFailure !== undefined) throw committedFailure;
        if (unstored.length) throw new Error('配置已保存，但凭据存储不可用，API Key 仅本次会话有效');
        rawSet({ configSaveStatus: get().configDirty ? 'dirty' : 'saved', configSaveError: null });
        if (!options?.silent && get().configRevision === revision) get().showToast('设置已保存');
      } catch (error) {
        const conflict = error instanceof ConfigConflictError;
        const message = conflict ? error.message
          : error instanceof Error && error.name === 'ConfigCleanupError' ? error.message
          : !hydrated ? '配置尚未完成加载，不能保存设置'
            : committed !== undefined
              ? (!directoriesSynced ? '配置已保存，但目录授权同步失败，请重试' + (unstored.length ? '；API Key 仅本次会话有效' : '')
                : '配置已保存，但凭据存储不可用，API Key 仅本次会话有效')
              : '设置保存失败，当前修改尚未确认持久化';
        rawSet({ configSaveStatus: conflict ? 'conflict' : 'error', configSaveError: message });
        get().showToast(message, 'error');
        throw conflict ? new ConfigConflictError() : new Error(message);
      }
    });
  },

  loadConfig: () => {
    rawSet({ configHydrated: false });
    return enqueue(async () => {
    const starting = get();
    const before = starting.config;
    const beforeOrdinary = configWithoutSecrets(before);
    rawSet({ configHydrated: false });
    let loaded: Awaited<ReturnType<typeof fileService.loadConfigWithSecrets>>;
    try {
      loaded = await fileService.loadConfigWithSecrets({
        allowSecretReadFailure: true,
        normalize: (config) => migrateLegacyGeneralModels(migrateLegacyPerformanceMode({
          ...config as AppConfig, providers: (config as AppConfig).providers ?? {},
        })),
      });
    } catch (error) {
      const message = error instanceof Error && error.name === 'VersionError'
        ? '数据由较新版本软件保存，请使用最新版本重新打开；已阻止覆盖原配置'
        : '设置读取失败，已阻止覆盖原配置；请重试加载';
      rawSet({ configHydrated: false, configSaveStatus: 'error', configSaveError: message });
      get().showToast(message, 'error');
      // eslint-disable-next-line preserve-caught-error -- 原始错误可能含凭据或路径，不保留 cause。
      throw new Error(message);
    }
    const saved = loaded.config;
    const cfg = saved ? migrateLegacyGeneralModels({ ...defaultConfig, ...migrateLegacyPerformanceMode(saved as AppConfig) }) : { ...defaultConfig };
    const ordinary = configWithoutSecrets(cfg);
    // 显式重新加载采用磁盘值；加载期间的新编辑单独重放，不能被迟到结果清掉。
    const latest = get();
    const pending = createConfigPatch(beforeOrdinary, configWithoutSecrets(latest.config));
    const merged = applyConfigPatch(ordinary, pending, false) as unknown as AppConfig;
    const unread = loaded.unreadSecrets ?? [];
    const nextSecrets: Record<string, string> = {};
    for (const [id, provider] of Object.entries(merged.providers ?? {})) {
      const edited = latest.configSecretChanges[id] !== starting.configSecretChanges[id];
      const oldProvider = before.providers[id];
      // 版本是持久化协议元数据，不作为渠道编辑字段暴露。
      const sameRef = oldProvider?.apiKeyRef === provider.apiKeyRef
        && Reflect.get(oldProvider ?? {}, 'apiKeyRevision') === Reflect.get(provider, 'apiKeyRevision');
      provider.apiKey = edited ? latest.config.providers[id]?.apiKey ?? ''
        : unread.includes(id) && sameRef ? oldProvider?.apiKey ?? '' : cfg.providers[id]?.apiKey ?? '';
      if (edited && latest.configSecretChanges[id]) nextSecrets[id] = latest.configSecretChanges[id];
    }
    const dirty = pending.length > 0 || Object.keys(nextSecrets).length > 0;
    rawSet({ config: merged, configHydrated: true, configEditBaseline: ordinary,
      configPersistedBaseline: configWithoutSecrets(loaded.persistedConfig ?? saved),
      configSecretChanges: nextSecrets, configSecretReadErrors: unread, configDirty: dirty,
      configSaveStatus: loaded.cleanupPending ? 'error' : dirty ? 'dirty' : 'idle',
      configSaveError: loaded.cleanupPending ? '设置已保存，但旧渠道凭据清理失败，请重试' : null });
    if (loaded.cleanupPending) get().showToast('设置已加载，但旧渠道凭据仍待清理，请重试保存', 'error');
    syncNodeToolbarMode(merged.nodeToolbarMode);
    syncNodeLabelVisible(merged.nodeLabelVisible);
    syncPerformanceMode(merged.performanceMode);
    setLocale(merged.language);
    if (unread.length || loaded.missingSecrets.length) {
      get().showToast(unread.length ? '部分 API Key 读取失败，已保留原引用，可重试加载；其他设置仍可保存'
        : '部分连接的 API Key 不存在，请在设置中重新填写', 'error');
    }
    try {
      setBaseDataDir(merged.baseDataDir);
      await syncAuthorizedDirectories(merged);
    } catch {
      get().showToast('配置已加载，但文件目录授权同步失败', 'error');
    }
    });
  },
  };
};
