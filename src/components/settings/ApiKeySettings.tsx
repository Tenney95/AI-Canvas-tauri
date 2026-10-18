/**
 * ApiKeySettings — provider connections and enabled model catalogs.
 */
import { Icon } from '@iconify/react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { NEW_API_KEY_CONNECTION_ID } from '../../store/store.ui';
import {
  createConnectionId,
  getProviderDefinition,
  getProviderDefinitions,
  getWebSearchProviderDefinitions,
  isProviderModelVisible,
  resolveWebSearchProviderId,
} from '../../services/ai/providerCatalogService';
import {
  parseConnectionShare,
  serializeConnection,
} from '../../services/ai/providerConnectionTransfer';
import { copyText } from '../../services/clipboardService';
import { exportJsonTextFile, readJsonTextFile, JsonFileTransferError } from '../../services/fileService';
import type {
  ApiProviderConfig,
  DreaminaRuntime,
  ProviderModelSelection,
  WebSearchProviderId,
} from '../../types';
import AnimatedButton from '../shared/AnimatedButton';
import PopupCloseButton from '../shared/PopupCloseButton';
import ProviderBadge from '../shared/ProviderBadge';
import { defaultModelGroups } from '../nodes/shared/defaultModels';
import { shouldListProviderConnection } from './apiKeySettingsUtils';
import { deleteAppSecret, isSecretStoreAvailable, readAppSecret, writeAppSecret } from '../../services/providerSecretService';
import { testProviderConnection } from '../../services/testConnection';
import { replaceLegacyApimartOmni } from '../../services/ai/apimartVideoModels';
import DreaminaLoginModal from './DreaminaLoginModal';
import ModalOverlay from '../shared/ModalOverlay';
import ProviderConnectionDialog from './ProviderConnectionDialog';
import VolcengineBillingSettings from './VolcengineBillingSettings';
import { queryBillingRuns } from '../../services/billing/volcengineBillingService';
import { saveAutodlWorkflowTemplate, saveWorkflowApiDrafts } from '../../services/workflowApi/workflowApiConfig';
import { invoke } from '@tauri-apps/api/core';
import { useT } from '../../i18n';
import { RUNNINGHUB_API_SITES, TOAPIS_API_SITES } from '../../constants/api';
import { buildRunningHubSiteProviders, runningHubSiteDrafts, runningHubSiteId, RUNNINGHUB_CREDENTIAL_IDS } from '../../services/runninghubSiteCredentials';
import type { RunningHubSiteKeyDrafts } from '../../types/runninghub';

interface ProviderListItem {
  id: string;
  config: ApiProviderConfig;
}

function modelCategory(model: { nodeTypes: string[] }): ProviderModelSelection['category'] {
  if (model.nodeTypes.includes('ai-video')) return 'video';
  if (model.nodeTypes.includes('ai-audio')) return 'audio';
  if (model.nodeTypes.includes('ai-image') || model.nodeTypes.includes('ai-animation')) return 'image';
  return 'text';
}

function providerSummaryUrl(config: ApiProviderConfig, defaultBaseUrl?: string): string {
  const value = config.baseUrl || defaultBaseUrl;
  if (!value) return '';
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return value;
  }
}

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

export default function ApiKeySettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const importFileRef = useRef<HTMLInputElement>(null);
  const importBusyRef = useRef(false);
  const [importBusy, setImportBusy] = useState(false);
  const siteSwitchBusyRef = useRef(false);
  const [switchingSite, setSwitchingSite] = useState<string | null>(null);
  const unreadSecrets = useAppStore((state) => state.configSecretReadErrors);
  const workflows = useAppStore((state) => state.workflows);
  const {
    config,
    updateConfig,
    setProviderConfig,
    saveProviderConfig,
    removeProviderConfig,
    saveConfig,
    pendingApiKeyConnectionId,
    pendingApiKeyModelId,
    setPendingApiKeyConnectionId,
  } = useAppStore(
    useShallow((state) => ({
      config: state.config,
      updateConfig: state.updateConfig,
      setProviderConfig: state.setProviderConfig,
      saveProviderConfig: state.saveProviderConfig,
      removeProviderConfig: state.removeProviderConfig,
      saveConfig: state.saveConfig,
      pendingApiKeyConnectionId: state.pendingApiKeyConnectionId,
      pendingApiKeyModelId: state.pendingApiKeyModelId,
      setPendingApiKeyConnectionId: state.setPendingApiKeyConnectionId,
    })),
  );

  // 三者总是一起变化，合成一份状态；revision 用于每次打开时重挂载对话框
  const [dialog, setDialog] = useState<{ open: boolean; connectionId?: string; revision: number }>({
    open: false,
    revision: 0,
  });
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const [billingOpen, setBillingOpen] = useState(false);
  const [hasBillingHistory, setHasBillingHistory] = useState(false);
  const [providerBalances, setProviderBalances] = useState<Record<string, string>>({});
  const balanceRefreshStartedRef = useRef(new Set<string>());
  const balanceRefreshActiveRef = useRef(true);
  // 凭据存在 Rust 侧的凭据存储里；不可用时只能本次会话有效，得在用户填写前就说清楚
  const [secretStoreAvailable, setSecretStoreAvailable] = useState(true);
  const [materialUploadKey, setMaterialUploadKey] = useState('');
  const [materialUploadKeySaving, setMaterialUploadKeySaving] = useState(false);

  const [dreaminaLoading, setDreaminaLoading] = useState(false);
  const [dreaminaStatusMsg, setDreaminaStatusMsg] = useState(() => t('首次登录时会自动准备即梦组件'));
  const [dreaminaModalOpen, setDreaminaModalOpen] = useState(false);
  const [dreaminaRuntime, setDreaminaRuntime] = useState<DreaminaRuntime | null>(null);
  const dreaminaDoneRef = useRef(false);
  const dreaminaAuth = config.dreaminaAuth;
  const activeWebSearchProviderId = resolveWebSearchProviderId(config);

  const fallbackModels = useMemo(() => {
    const catalog: Record<string, ProviderModelSelection[]> = {};
    for (const definition of getProviderDefinitions()) {
      if (!definition.models) continue;
      catalog[definition.id] = definition.models.map((model) => ({ ...model }));
    }
    for (const group of defaultModelGroups) {
      const providerId = group.id === 'runninghub' ? 'runninghub-model' : group.id;
      if (!getProviderDefinition(providerId)) continue;
      const current = catalog[providerId] || [];
      for (const model of group.models) {
        const id = model.value.includes('/') ? model.value.slice(model.value.indexOf('/') + 1) : model.value;
        if (current.some((item) => item.id === id)) continue;
        current.push({
          id,
          name: model.label,
          category: modelCategory(model),
          provider: providerId,
          description: model.description,
        });
      }
      catalog[providerId] = current;
    }
    return catalog;
  }, []);

  const providerItems = useMemo(() => {
    const items: ProviderListItem[] = [];
    for (const [id, providerConfig] of Object.entries(config.providers)) {
      if (id === 'runninghub' || RUNNINGHUB_CREDENTIAL_IDS.includes(id)) continue;
      const definition = getProviderDefinition(id, providerConfig);
      if (!definition) continue;
      if (definition.kind === 'web-search' && id !== activeWebSearchProviderId) continue;
      if (definition.id !== 'cccapi' && !shouldListProviderConnection(providerConfig, definition.authType, config.providers.runninghub?.apiKey)) continue;
      items.push({ id, config: providerConfig });
    }
    if (config.providers.runninghub?.apiKey && !config.providers['runninghub-model']) {
      items.push({
        id: 'runninghub-model',
        config: { name: 'RunningHub', apiKey: '', catalogId: 'runninghub-model', baseUrl: config.providers.runninghub.baseUrl },
      });
    }
    if (dreaminaAuth?.loggedIn && !config.providers.dreamina) {
      items.push({
        id: 'dreamina',
        config: { name: '即梦', apiKey: '', catalogId: 'dreamina' },
      });
    }
    const order = [
      'apimart',
      'xai',
      'google',
      'volcengine',
      'runninghub-model',
      'grsai',
      'dreamina',
      'web-search',
      'custom-openai',
    ];
    return items.sort((left, right) => {
      const leftDefinition = getProviderDefinition(left.id, left.config);
      const rightDefinition = getProviderDefinition(right.id, right.config);
      const leftOrderId = leftDefinition?.kind === 'web-search'
        ? 'web-search'
        : leftDefinition?.id || 'custom-openai';
      const rightOrderId = rightDefinition?.kind === 'web-search'
        ? 'web-search'
        : rightDefinition?.id || 'custom-openai';
      return order.indexOf(leftOrderId) - order.indexOf(rightOrderId);
    });
  }, [activeWebSearchProviderId, config.providers, dreaminaAuth?.loggedIn]);

  // 只合并展示入口，各连接仍保留独立的 ID、模型和凭据。
  const cccConnections = providerItems.filter((item) => getProviderDefinition(item.id, item.config)?.id === 'cccapi');
  const visibleProviderItems = providerItems.filter((item) => (
    getProviderDefinition(item.id, item.config)?.id !== 'cccapi' || item.id === cccConnections[0]?.id
  ));

  const connectedProviderIds = useMemo(
    () => providerItems.map((item) => getProviderDefinition(item.id, item.config)?.id || item.id),
    [providerItems],
  );
  const hasVolcengineConnection = providerItems.some((item) => getProviderDefinition(item.id, item.config)?.id === 'volcengine');

  useEffect(() => {
    if (billingOpen || hasVolcengineConnection || !isTauri()) return;
    let cancelled = false;
    void queryBillingRuns({}, 1, 1).then((page) => {
      if (!cancelled) setHasBillingHistory(page.total > 0);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [billingOpen, hasVolcengineConnection]);

  // 补填密钥或节点请求模型参数：在渲染期直接生效，不用 effect 回写本地 state。
  // 任何一次手动开关对话框都视为消费掉该请求（关闭设置面板时 store 也会清空它）。
  const requestedConnectionId = pendingApiKeyConnectionId === NEW_API_KEY_CONNECTION_ID
    ? NEW_API_KEY_CONNECTION_ID
    : pendingApiKeyConnectionId && config.providers[pendingApiKeyConnectionId]
      ? pendingApiKeyConnectionId
      : null;
  const connectionDialogOpen = dialog.open || !!requestedConnectionId;
  const editingConnectionId = requestedConnectionId === NEW_API_KEY_CONNECTION_ID
    ? undefined
    : requestedConnectionId ?? dialog.connectionId;
  const connectionDialogKey = requestedConnectionId
    ? `pending-${requestedConnectionId}-${pendingApiKeyModelId ?? ''}`
    : dialog.revision;

  const editingConfig = editingConnectionId
    ? config.providers[editingConnectionId] ?? providerItems.find((item) => item.id === editingConnectionId)?.config
    : undefined;

  const tauriInvoke = useCallback(
    async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      return invoke<T>(command, args);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void isSecretStoreAvailable().then((available) => {
      if (!cancelled) setSecretStoreAvailable(available);
    });
    void readAppSecret('creative-material-key').then((value) => {
      if (!cancelled) setMaterialUploadKey(value || '');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const saveMaterialUploadKey = useCallback(async (value = materialUploadKey) => {
    setMaterialUploadKeySaving(true);
    try {
      if (value.trim()) {
        const saved = await writeAppSecret('creative-material-key', value.trim());
        if (!saved) throw new Error('当前环境无法保存素材上传凭证');
      } else {
        await deleteAppSecret('creative-material-key');
      }
      useAppStore.getState().showToast(value.trim() ? '素材上传凭证已保存' : '素材上传凭证已清除');
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : '素材上传凭证保存失败', 'error');
    } finally {
      setMaterialUploadKeySaving(false);
    }
  }, [materialUploadKey]);

  useEffect(() => {
    balanceRefreshActiveRef.current = true;
    return () => { balanceRefreshActiveRef.current = false; };
  }, []);

  useEffect(() => {
    let changed = false;
    for (const [connectionId, providerConfig] of Object.entries(config.providers)) {
      const catalogId = providerConfig.catalogId
        || getProviderDefinition(connectionId, providerConfig)?.id;
      if (catalogId === 'apimart') {
        const selectedModels = replaceLegacyApimartOmni(providerConfig.selectedModels);
        const catalogModels = replaceLegacyApimartOmni(providerConfig.catalogModels);
        if (selectedModels !== providerConfig.selectedModels || catalogModels !== providerConfig.catalogModels) {
          changed = true;
          saveProviderConfig(connectionId, { ...providerConfig, selectedModels, catalogModels });
        }
        continue;
      }
      if (catalogId !== 'sora2u') continue;
      const selectedModels = providerConfig.selectedModels?.filter(
        (model) => isProviderModelVisible(catalogId, model.id),
      );
      const catalogModels = providerConfig.catalogModels?.filter(
        (model) => isProviderModelVisible(catalogId, model.id),
      );
      if (
        selectedModels?.length === providerConfig.selectedModels?.length
        && catalogModels?.length === providerConfig.catalogModels?.length
      ) continue;
      changed = true;
      saveProviderConfig(connectionId, { ...providerConfig, selectedModels, catalogModels });
    }
    if (changed) void saveConfig({ silent: true });
  }, [config.providers, saveConfig, saveProviderConfig]);

  useEffect(() => {
    for (const item of providerItems) {
      const definition = getProviderDefinition(item.id, item.config);
      if (!definition || !['sora2u', 'apimart'].includes(definition.id) || !item.config.apiKey.trim()) continue;
      const fingerprint = `${item.id}\u0000${item.config.apiKey}\u0000${item.config.baseUrl || ''}`;
      if (balanceRefreshStartedRef.current.has(fingerprint)) continue;
      balanceRefreshStartedRef.current.add(fingerprint);
      setProviderBalances((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      void testProviderConnection(
        definition.id,
        item.config.apiKey.trim(),
        item.config.baseUrl,
      ).then((result) => {
        const balance = result.balance;
        if (!balanceRefreshActiveRef.current || !result.success || !balance) return;
        const latest = useAppStore.getState().config.providers[item.id];
        if (!latest || latest.apiKey !== item.config.apiKey || latest.baseUrl !== item.config.baseUrl
          || getProviderDefinition(item.id, latest)?.id !== definition.id) return;
        setProviderBalances((current) => ({ ...current, [item.id]: balance }));
      });
    }
  }, [providerItems]);

  const applyDreaminaRuntime = useCallback((runtime: DreaminaRuntime) => {
    setDreaminaRuntime(runtime);
    if (runtime.message) setDreaminaStatusMsg(runtime.message);
    if (runtime.phase !== 'success' && !runtime.loggedIn) return;
    updateConfig({
      dreaminaAuth: {
        loggedIn: true,
        username: runtime.username || t('即梦用户'),
        credit: runtime.credit || undefined,
        loginTs: Date.now(),
      },
    });
    if (dreaminaDoneRef.current) return;
    dreaminaDoneRef.current = true;
    useAppStore.getState().showToast(t('即梦登录成功'));
    setTimeout(() => setDreaminaModalOpen(false), 800);
  }, [t, updateConfig]);

  const handleDreaminaLogin = useCallback(async (force = false) => {
    if (!isTauri()) {
      setDreaminaStatusMsg(t('OAuth 登录仅在桌面应用中可用'));
      useAppStore.getState().showToast(t('OAuth 登录仅在桌面应用中可用'), 'error');
      return;
    }
    dreaminaDoneRef.current = false;
    setDreaminaLoading(true);
    setDreaminaRuntime(null);
    setDreaminaModalOpen(true);
    try {
      setDreaminaRuntime(await tauriInvoke<DreaminaRuntime>('dreamina_login_start', { force }));
    } catch (error) {
      const message = typeof error === 'string' ? error : (error as Error)?.message || t('启动登录失败');
      setDreaminaStatusMsg(message);
    } finally {
      setDreaminaLoading(false);
    }
  }, [t, tauriInvoke]);

  const handleDreaminaLogout = useCallback(async () => {
    setDreaminaLoading(true);
    try {
      if (isTauri()) await tauriInvoke('dreamina_logout');
    } catch {
      // Local configuration still needs to be cleared if the native logout fails.
    }
    updateConfig({ dreaminaAuth: undefined });
    setDreaminaRuntime(null);
    setDreaminaStatusMsg(t('已退出登录'));
    setDreaminaLoading(false);
  }, [t, tauriInvoke, updateConfig]);

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      await import('@tauri-apps/plugin-shell').then(({ open }) => open(url));
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const handleDreaminaCopy = useCallback((text: string, label: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    useAppStore.getState().showToast(t('已复制{label}', { label }));
  }, [t]);

  useEffect(() => {
    if (!dreaminaModalOpen || !isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<DreaminaRuntime>('dreamina-login-runtime', (event) => applyDreaminaRuntime(event.payload)),
    ).then((stopListening) => {
      if (cancelled) stopListening();
      else unlisten = stopListening;
    }).catch(() => {});
    const timer = setInterval(async () => {
      try {
        applyDreaminaRuntime(await tauriInvoke<DreaminaRuntime>('dreamina_login_runtime'));
      } catch {
        // The event listener remains the primary source while polling is unavailable.
      }
    }, 1500);
    return () => {
      cancelled = true;
      unlisten?.();
      clearInterval(timer);
    };
  }, [applyDreaminaRuntime, dreaminaModalOpen, tauriInvoke]);

  useEffect(() => {
    if (!isTauri() || !dreaminaAuth?.loggedIn) return;
    void tauriInvoke<DreaminaRuntime>('dreamina_status').then((runtime) => {
      if (!runtime.loggedIn) return;
      setDreaminaRuntime(runtime);
      setDreaminaStatusMsg(t('即梦已登录'));
      updateConfig({
        dreaminaAuth: {
          loggedIn: true,
          username: runtime.username || t('即梦用户'),
          credit: runtime.credit || undefined,
          loginTs: dreaminaAuth.loginTs || Date.now(),
        },
      });
    }).catch(() => {});
    // Validate the persisted OAuth mirror only when the settings view mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 导出连接（不含 API Key）到剪贴板，便于分享中转站的模型清单与调用协议。 */
  const handleCopyConnection = async (connectionId: string) => {
    const providerConfig = config.providers[connectionId];
    if (!providerConfig) return;
    const ok = await copyText(serializeConnection(providerConfig,
      useAppStore.getState().workflows.filter((workflow) => workflow.workflowApi?.connectionId === connectionId)));
    useAppStore.getState().showToast(
      ok ? t('连接配置已复制（不含 API Key）') : t('复制失败'),
      ok ? 'success' : 'error',
    );
  };

  const handleExportConnection = async (connectionId: string) => {
    const providerConfig = config.providers[connectionId];
    if (!providerConfig) return;
    try {
      const connectionWorkflows = useAppStore.getState().workflows
        .filter((workflow) => workflow.workflowApi?.connectionId === connectionId);
      const exported = await exportJsonTextFile(
        serializeConnection(providerConfig, connectionWorkflows), providerConfig.name || 'connection',
      );
      if (exported) useAppStore.getState().showToast(t('连接配置已导出（不含 API Key）'), 'success');
    } catch {
      useAppStore.getState().showToast(t('导出 JSON 文件失败'), 'error');
    }
  };

  /** 从用户选择的 JSON 文件导入自定义连接；保存后补填 API Key。 */
  const importConnectionFile = async (file: File) => {
    const parsed = parseConnectionShare(await readJsonTextFile(file));
    if (!parsed) {
      useAppStore.getState().showToast(t('文件里没有有效的连接配置'), 'error');
      return;
    }
    const definition = getProviderDefinition(parsed.catalogId);
    if (!definition || (definition.id !== 'custom-openai' && definition.kind !== 'workflow-api')) {
      useAppStore.getState().showToast(t('该连接类型不支持导入'), 'error');
      return;
    }
    const newConnectionId = createConnectionId(definition.id);
    if (config.providers[newConnectionId]) {
      useAppStore.getState().showToast(
        t('已存在 {name} 连接，请先删除后再导入', { name: definition.name }),
        'error',
      );
      return;
    }
    const models = parsed.config.selectedModels?.map((model) => ({
      ...model,
      provider: newConnectionId,
    }));
    saveProviderConfig(newConnectionId, {
      ...parsed.config,
      selectedModels: models,
      catalogModels: parsed.config.catalogModels?.map((model) => ({
        ...model,
        provider: newConnectionId,
      })),
    });
    try {
      await saveConfig({ throwOnError: true });
      if (parsed.workflowApiDrafts) await saveWorkflowApiDrafts(newConnectionId, parsed.workflowApiDrafts);
      else if (parsed.workflowApi) await saveAutodlWorkflowTemplate(newConnectionId, parsed.workflowApi.defaults);
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : t('保存失败'), 'error');
      return;
    }
    useAppStore.getState().showToast(t('已导入连接，请补填 API Key'));
    setPendingApiKeyConnectionId(newConnectionId);
  };

  const handleImportConnection = async (file: File) => {
    if (importBusyRef.current) return;
    importBusyRef.current = true;
    setImportBusy(true);
    try {
      await importConnectionFile(file);
    } catch (error) {
      const message = error instanceof JsonFileTransferError
        ? error.code === 'too-large' ? t('JSON 文件不能超过 8 MiB') : t('文件必须使用 UTF-8 编码')
        : t('读取 JSON 文件失败');
      useAppStore.getState().showToast(message, 'error');
    } finally {
      importBusyRef.current = false;
      setImportBusy(false);
    }
  };

  const openAddDialog = () => {
    setPendingApiKeyConnectionId(null);
    setDialog((previous) => ({ open: true, connectionId: undefined, revision: previous.revision + 1 }));
  };

  const openEditDialog = (connectionId: string) => {
    setPendingApiKeyConnectionId(null);
    setDialog((previous) => ({ open: true, connectionId, revision: previous.revision + 1 }));
  };

  const closeConnectionDialog = () => {
    setPendingApiKeyConnectionId(null);
    setDialog((previous) => ({ open: false, connectionId: undefined, revision: previous.revision }));
  };

  const handleSaveConnection = async (
    connectionId: string,
    providerConfig: ApiProviderConfig,
    related?: { runninghubWorkflowApiKey?: string; runninghubSiteKeys?: RunningHubSiteKeyDrafts; workflowApiDrafts?: import('../../types/workflowApi').WorkflowApiDraft[] },
  ) => {
    const definition = getProviderDefinition(connectionId, providerConfig);
    if (definition?.id === 'runninghub-model' && related?.runninghubSiteKeys) {
      const providers = buildRunningHubSiteProviders(useAppStore.getState().config.providers, providerConfig, related.runninghubSiteKeys);
      updateConfig({ providers });
      saveProviderConfig(connectionId, providers['runninghub-model']);
      await saveConfig({ throwOnError: true });
      closeConnectionDialog();
      return;
    }
    saveProviderConfig(connectionId, providerConfig);
    if (definition?.kind === 'web-search') {
      updateConfig({ webSearchProviderId: definition.id as WebSearchProviderId });
    } else if (related?.runninghubWorkflowApiKey) {
      setProviderConfig('runninghub', {
        name: 'RunningHub 工作流',
        apiKey: related.runninghubWorkflowApiKey,
        baseUrl: providerConfig.baseUrl,
      });
    } else if (related && 'runninghubWorkflowApiKey' in related && config.providers.runninghub) {
      await removeProviderConfig('runninghub');
    }
    await saveConfig({ throwOnError: true });
    if (definition?.kind === 'workflow-api') await saveWorkflowApiDrafts(connectionId, related?.workflowApiDrafts ?? []);
    closeConnectionDialog();
  };

  const handleSwitchProviderSite = async (connectionId: string, baseUrl: string) => {
    if (siteSwitchBusyRef.current) return;
    const state = useAppStore.getState();
    const current = state.config.providers[connectionId]
      ?? (connectionId === 'runninghub-model' && state.config.providers.runninghub ? {
        name: 'RunningHub', apiKey: '', catalogId: 'runninghub-model', baseUrl: state.config.providers.runninghub.baseUrl,
      } : undefined);
    if (!current) return;
    const definition = getProviderDefinition(connectionId, current);
    const sites = definition?.id === 'toapis' ? TOAPIS_API_SITES
      : definition?.id === 'runninghub-model' ? RUNNINGHUB_API_SITES : undefined;
    if (!sites?.some((site) => site.baseUrl === baseUrl)) return;
    const activeUrl = definition?.id === 'runninghub-model'
      ? RUNNINGHUB_API_SITES.find((site) => site.id === runningHubSiteId(current.baseUrl))?.baseUrl
      : (current.baseUrl || definition?.defaultBaseUrl || '').replace(/\/+$/, '');
    if (activeUrl === baseUrl) return;

    siteSwitchBusyRef.current = true;
    setSwitchingSite(connectionId);
    try {
      if (definition?.id === 'runninghub-model') {
        // 先保留两站各自的凭据，再同时切换模型和工作流入口；空站点不借用另一站 Key。
        const providers = buildRunningHubSiteProviders(state.config.providers,
          { ...current, baseUrl, catalogId: 'runninghub-model' }, runningHubSiteDrafts(state.config.providers));
        state.updateConfig({ providers });
        state.saveProviderConfig(connectionId, providers['runninghub-model']);
      } else {
        state.saveProviderConfig(connectionId, { ...current, baseUrl });
      }
      await state.saveConfig({ throwOnError: true });
    } catch (error) {
      state.showToast(error instanceof Error ? error.message : t('保存失败'), 'error');
    } finally {
      siteSwitchBusyRef.current = false;
      setSwitchingSite(null);
    }
  };

  const handleSaveCccGroups = async (connections: Record<string, ApiProviderConfig>) => {
    // 先同步所有组的模型身份，再一次提交配置与凭据；单组失败不提前关闭编辑器。
    for (const [id, providerConfig] of Object.entries(connections)) saveProviderConfig(id, providerConfig);
    await saveConfig({ throwOnError: true });
  };

  const handleRemoveConnection = async (connectionId: string, removeAllCccGroups = false) => {
    try {
      const providerConfig = useAppStore.getState().config.providers[connectionId];
      const definition = getProviderDefinition(connectionId, providerConfig);
      if (connectionId === 'dreamina') await handleDreaminaLogout();
      const shouldClearVolcengineAssetLibrary = definition?.id === 'volcengine';
      const connectionIds = removeAllCccGroups && definition?.id === 'cccapi'
        ? Object.entries(useAppStore.getState().config.providers)
          .filter(([id, connection]) => getProviderDefinition(id, connection)?.id === 'cccapi')
          .map(([id]) => id)
        : definition?.kind === 'web-search'
        ? getWebSearchProviderDefinitions().map((provider) => provider.id)
        : [connectionId];
      if (connectionId === 'runninghub-model') connectionIds.push('runninghub', ...RUNNINGHUB_CREDENTIAL_IDS);
      let cleanupFailed = false;
      for (const id of connectionIds) {
        try {
          await removeProviderConfig(id);
        } catch {
          // Action 先移除内存配置，再清理项目引用。后者失败不能跳过配置提交。
          // 若配置仍存在，则删除本身未完成，不能当作引用清理失败继续。
          if (useAppStore.getState().config.providers[id]) throw new Error('连接删除失败，请重试');
          cleanupFailed = true;
        }
      }
      if (definition?.kind === 'web-search') updateConfig({ webSearchProviderId: undefined });
      await saveConfig({ silent: true, throwOnError: true });
      if (shouldClearVolcengineAssetLibrary) {
        await Promise.all([
          deleteAppSecret('provider/volcengine/asset-library/access-key'),
          deleteAppSecret('provider/volcengine/asset-library/secret-key'),
        ]);
      }
      setPendingDeleteId(undefined);
      useAppStore.getState().showToast(
        cleanupFailed ? t('连接已删除，但部分项目的模型引用清理失败，请检查相关项目') : t('连接已删除'),
        cleanupFailed ? 'error' : 'success',
      );
    } catch {
      const state = useAppStore.getState();
      state.showToast(state.configSaveError || t('连接删除失败，请重试'), 'error');
      return false;
    }
    return true;
  };

  return (
    <div className="settings-pane">
      {unreadSecrets?.length > 0 && (
        <div role="status" className="ui-alert ui-alert--warning">
          {t('部分 API Key 读取失败，原引用已保留。请在设置顶部重试加载；这与未填写 Key 不同。')}
        </div>
      )}
      <div className="settings-pane-heading">
        <h2 className="settings-pane-title">API Key</h2>
        <div className="flex items-center gap-1.5">
          <AnimatedButton
            type="button"
            className="settings-add-provider-btn"
            aria-label={t('从 JSON 文件导入自定义连接')}
            data-tooltip={t('从 JSON 文件导入自定义连接')}
            disabled={importBusy}
            onClick={() => importFileRef.current?.click()}
          >
            <Icon icon="mdi:file-import-outline" width="17" />
          </AnimatedButton>
          <input ref={importFileRef} type="file" accept=".json,application/json" className="hidden"
            aria-label={t('从 JSON 文件导入自定义连接')}
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) await handleImportConnection(file);
            }} />
          <AnimatedButton
            type="button"
            className="settings-add-provider-btn"
            aria-label={t('添加 API 厂商')}
            data-tooltip={t('添加 API 厂商')}
            onClick={openAddDialog}
          >
            <Icon icon="mdi:plus" width="18" />
          </AnimatedButton>
        </div>
      </div>

      <div className="settings-pane-body provider-settings-body">
        {!secretStoreAvailable && (
          <p className="provider-secret-warning">
            <Icon icon="mdi:shield-alert-outline" width="14" />
            {t('当前环境无法保存凭据，API Key 不会写入本地，仅本次会话有效。')}
          </p>
        )}
        <section className="provider-config-section mb-4">
          <div className="provider-section-heading">
            <div>
              <h4>素材上传凭证</h4>
              <p>用于把本地图片和音频上传到公网素材服务。与视频接口 API Key 分开保存。</p>
            </div>
          </div>
          <label className="provider-field">
            <span>创想素材 Key</span>
            <input
              type="password"
              value={materialUploadKey}
              placeholder="请输入 X-Creative-Material-Key"
              autoComplete="off"
              onChange={(event) => setMaterialUploadKey(event.target.value)}
            />
            <small>只保存到应用安全凭据存储，不会写入 JSON、普通配置或导出的连接配置。</small>
          </label>
          <div className="flex gap-2">
            <AnimatedButton
              type="button"
              className="provider-primary-btn"
              disabled={materialUploadKeySaving || !secretStoreAvailable}
              onClick={() => void saveMaterialUploadKey()}
            >
              {materialUploadKeySaving ? '保存中…' : '保存素材上传凭证'}
            </AnimatedButton>
            <AnimatedButton
              type="button"
              className="provider-text-btn"
              disabled={materialUploadKeySaving || !materialUploadKey}
              onClick={() => { setMaterialUploadKey(''); void saveMaterialUploadKey(''); }}
            >
              清除
            </AnimatedButton>
          </div>
        </section>
        {providerItems.length === 0 ? (
          <div className="provider-empty-state">
            <span className="provider-empty-icon"><Icon icon="mdi:key-chain-variant" width="24" /></span>
            <strong>{t('尚未添加 API 厂商')}</strong>
            <AnimatedButton type="button" className="provider-primary-btn" onClick={openAddDialog}>
              <Icon icon="mdi:plus" width="15" />
              {t('添加厂商')}
            </AnimatedButton>
          </div>
        ) : (
          <div className="provider-connection-list">
            {visibleProviderItems.map((item) => {
              const definition = getProviderDefinition(item.id, item.config);
              if (!definition) return null;
              const isCcc = definition.id === 'cccapi';
              const cccKeyCount = cccConnections.filter((connection) => connection.config.apiKey.trim()).length;
              const selectedCount = isCcc
                ? cccConnections.reduce((count, connection) => count + (connection.config.selectedModels?.length
                  ?? config.generalModels?.filter((model) => model.providerConfigId === connection.id).length ?? 0), 0)
                : item.config.selectedModels?.length;
              const summaryUrl = providerSummaryUrl(item.config, definition.defaultBaseUrl);
              const isDreamina = definition.id === 'dreamina';
              const isRunningHub = definition.id === 'runninghub-model';
              const siteOptions = definition.id === 'toapis' ? TOAPIS_API_SITES : isRunningHub ? RUNNINGHUB_API_SITES : undefined;
              const activeSiteUrl = isRunningHub
                ? RUNNINGHUB_API_SITES.find((site) => site.id === runningHubSiteId(item.config.baseUrl))?.baseUrl
                : (item.config.baseUrl || definition.defaultBaseUrl || '').replace(/\/+$/, '');
              const isWebSearchProvider = definition.kind === 'web-search';
              const isWorkflowApi = definition.kind === 'workflow-api';
              const isCustomConnection = definition.id === 'custom-openai' || isWorkflowApi;
              const connectionWorkflows = workflows.filter((workflow) => workflow.workflowApi?.connectionId === item.id);
              const needsWorkflowKey = connectionWorkflows.some((workflow) => workflow.workflowApi?.version !== 2 || workflow.workflowApi.protocol.auth?.type !== 'none');
              const isPendingApiKey = isCcc ? cccKeyCount === 0
                : definition.authType !== 'oauth' && !item.config.apiKey.trim() && (!isWorkflowApi || needsWorkflowKey);
              const hasRunningHubModelKey = isRunningHub && !!item.config.apiKey.trim();
              const hasRunningHubWorkflowKey = isRunningHub
                && !!config.providers.runninghub?.apiKey.trim();
              const runningHubKeyCount = Number(hasRunningHubModelKey)
                + Number(hasRunningHubWorkflowKey);
              const displayName = isWebSearchProvider
                ? t('联网搜索')
                : definition.id === 'custom-openai'
                  ? item.config.name.trim() || definition.name
                  : isWorkflowApi ? item.config.name.trim() || t(definition.name) : definition.name;
              const statusLabel = isDreamina
                ? t('OAuth 已连接')
                : isRunningHub
                  ? t('{count}/2 密钥已配置', { count: runningHubKeyCount })
                  : isCcc
                    ? t('{configured}/{count} 组已配置', { configured: cccKeyCount, count: cccConnections.length })
                  : isPendingApiKey
                    ? t('待填写 API Key')
                    : isWorkflowApi ? t('已配置') : t('已连接');
              return (
                <Fragment key={item.id}>
                <div className={`provider-connection-card${isRunningHub ? ' provider-connection-card--runninghub' : ''}`}>
                  <ProviderBadge providerId={item.id} config={item.config} size="large" />
                  <div className="provider-connection-copy">
                    <div className={`provider-connection-title-row${siteOptions ? ' flex-wrap' : ''}`}>
                      <strong>{displayName}</strong>
                      <span className={`provider-list-status${isPendingApiKey || (isRunningHub && runningHubKeyCount < 2) || (isCcc && cccKeyCount < cccConnections.length) ? ' is-limited' : ''}`}>
                        {statusLabel}
                      </span>
                      {siteOptions && <div className="ui-segmented shrink-0" role="group" aria-label={`${displayName} · ${t('API 站点')}`} aria-busy={switchingSite === item.id}>
                        {siteOptions.map((site) => (
                          <button key={site.id} type="button"
                            className={`ui-segmented__item disabled:cursor-wait disabled:opacity-50${activeSiteUrl === site.baseUrl ? ' is-active' : ''}`}
                            aria-label={`${displayName} · ${t(site.label)}`}
                            aria-pressed={activeSiteUrl === site.baseUrl}
                            data-tooltip={t(site.label)}
                            disabled={switchingSite !== null || pendingDeleteId === item.id}
                            onClick={() => handleSwitchProviderSite(item.id, site.baseUrl)}>
                            {t(site.label).replace(/[（(].*$/, '').trim()}
                          </button>
                        ))}
                      </div>}
                      {providerBalances[item.id] && (
                        <span className="shrink-0 text-xs font-medium text-canvas-text-secondary">
                          {providerBalances[item.id]}
                        </span>
                      )}
                    </div>
                    {!isRunningHub && <div className="provider-connection-meta">
                      {isWorkflowApi ? (
                        <><span>{t('自定义工作流')}</span>{summaryUrl && <span>{summaryUrl}</span>}</>
                      ) : isWebSearchProvider ? (
                        <>
                          <span>{t('当前厂商：{name}', { name: definition.name })}</span>
                          {summaryUrl && <span>{summaryUrl}</span>}
                        </>
                      ) : (
                        <>
                          <span>
                            {selectedCount === undefined
                              ? t('沿用内置模型目录')
                              : t('{count} 个模型', { count: selectedCount })}
                          </span>
                          {isCcc ? <span>{t('{count} 个分组', { count: cccConnections.length })}</span> : summaryUrl && <span>{summaryUrl}</span>}
                        </>
                      )}
                    </div>}
                  </div>

                  {isRunningHub && <div className="provider-runninghub-connections">
                    <div className="provider-runninghub-connection">
                      <span className="provider-runninghub-connection-state">
                        <Icon icon={hasRunningHubModelKey ? 'mdi:check-circle-outline' : 'mdi:circle-outline'} width="14" className={hasRunningHubModelKey ? 'is-configured' : ''} />
                        {hasRunningHubModelKey ? t('模型连接已配置') : t('模型连接未配置')}
                      </span>
                      {hasRunningHubModelKey && <span className="provider-runninghub-model-count">
                        {selectedCount === undefined ? t('沿用内置模型目录') : t('{count} 个模型', { count: selectedCount })}
                      </span>}
                    </div>
                    <div className="provider-runninghub-connection">
                      <span className="provider-runninghub-connection-state">
                        <Icon icon={hasRunningHubWorkflowKey ? 'mdi:check-circle-outline' : 'mdi:circle-outline'} width="14" className={hasRunningHubWorkflowKey ? 'is-configured' : ''} />
                        {hasRunningHubWorkflowKey ? t('工作流连接已配置') : t('工作流连接未配置')}
                      </span>
                      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost provider-runninghub-manage" onClick={() => { useAppStore.getState().setSettingsOpen(false); useAppStore.getState().setWorkflowPanelOpen(true, 'workflow'); }}>
                        管理云工作流 <Icon icon="mdi:arrow-right" width="14" />
                      </button>
                    </div>
                  </div>}

                  {pendingDeleteId === item.id ? (
                    <div className="provider-delete-confirm">
                      <span>{isCcc
                        ? t('移除全部 {count} 个 CCC 分组及其模型配置？', { count: cccConnections.length })
                        : t('移除此连接？')}</span>
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn"
                        aria-label={t('取消删除')}
                        onClick={() => setPendingDeleteId(undefined)}
                      >
                        <Icon icon="mdi:close" width="15" />
                      </AnimatedButton>
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn is-danger"
                        aria-label={t('确认删除')}
                        onClick={() => void handleRemoveConnection(item.id, isCcc)}
                      >
                        <Icon icon="mdi:check" width="15" />
                      </AnimatedButton>
                    </div>
                  ) : (
                    <div className="provider-card-actions">
                      {definition.id === 'volcengine' && (
                        <AnimatedButton type="button" className="provider-icon-btn" aria-label="查看火山方舟用量记录" data-tooltip="用量记录" onClick={() => setBillingOpen(true)}>
                          <Icon icon="lucide:receipt-text" width="16" />
                        </AnimatedButton>
                      )}
                      {!isDreamina && !isWebSearchProvider && !isCcc && (
                        <AnimatedButton
                          type="button"
                          className="provider-icon-btn"
                          aria-label={isCustomConnection
                            ? t('导出 {name} JSON', { name: displayName }) : t('复制 {name} 配置', { name: definition.name })}
                          data-tooltip={isCustomConnection
                            ? t('导出 JSON（不含 API Key）') : t('复制配置（不含 API Key）')}
                          onClick={() => void (isCustomConnection
                            ? handleExportConnection(item.id) : handleCopyConnection(item.id))}
                        >
                          <Icon icon={isCustomConnection ? 'mdi:file-export-outline' : 'mdi:content-copy'} width="15" />
                        </AnimatedButton>
                      )}
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn"
                        aria-label={isCcc ? t('管理 CCC 分组') : t('编辑 {name}', { name: definition.name })}
                        data-tooltip={isCcc ? t('统一管理分组') : t('编辑连接')}
                        onClick={() => openEditDialog(item.id)}
                      >
                        <Icon icon="mdi:pencil-outline" width="16" />
                      </AnimatedButton>
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn"
                        aria-label={isCcc ? t('删除 CCC API 全部分组') : t('删除 {name}', { name: definition.name })}
                        data-tooltip={isCcc ? t('删除全部 CCC 分组') : t('删除连接')}
                        onClick={() => setPendingDeleteId(item.id)}
                      >
                        <Icon icon="mdi:trash-can-outline" width="16" />
                      </AnimatedButton>
                    </div>
                  )}
                </div>
                </Fragment>
              );
            })}
          </div>
        )}
        {!hasVolcengineConnection && hasBillingHistory && (
          <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary mt-3" onClick={() => setBillingOpen(true)}>
            <Icon icon="lucide:receipt-text" />火山方舟历史用量
          </button>
        )}
      </div>

      <div className="settings-pane-footer">
        <div className="settings-save-row">
          <AnimatedButton
            type="button"
            className="settings-save-btn"
            onClick={async () => {
              try { await saveConfig(); } catch { return; }
              onClose();
            }}
          >
            {t('完成')}
          </AnimatedButton>
        </div>
      </div>

      <ProviderConnectionDialog
        key={connectionDialogKey}
        isOpen={connectionDialogOpen}
        connectionId={editingConnectionId}
        initialConfig={editingConfig}
        initialModelId={requestedConnectionId ? pendingApiKeyModelId ?? undefined : undefined}
        providerConfigs={config.providers}
        connectedProviderIds={connectedProviderIds}
        fallbackModels={fallbackModels}
        dreaminaLoggedIn={!!dreaminaAuth?.loggedIn}
        dreaminaLoading={dreaminaLoading}
        runninghubWorkflowApiKey={config.providers.runninghub?.apiKey}
        onDreaminaLogin={() => void handleDreaminaLogin(!!dreaminaAuth?.loggedIn)}
        onClose={closeConnectionDialog}
        onSave={handleSaveConnection}
        onSaveCccGroups={handleSaveCccGroups}
        onCopyCccGroup={handleCopyConnection}
        onRemoveCccGroup={handleRemoveConnection}
      />

      <DreaminaLoginModal
        isOpen={dreaminaModalOpen}
        runtime={dreaminaRuntime}
        onClose={() => setDreaminaModalOpen(false)}
        onOpenUrl={openExternalUrl}
        onCopy={handleDreaminaCopy}
      />
      <ModalOverlay
        isOpen={billingOpen}
        onClose={() => setBillingOpen(false)}
        ariaLabel="火山方舟用量记录"
        className="h-[min(860px,calc(100dvh-24px))] w-[min(1120px,calc(100vw-24px))]"
        zIndex={270}
        closeOnBackdrop={false}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-canvas-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Icon icon="lucide:receipt-text" width="19" className="shrink-0 text-canvas-text-secondary" />
            <h2 className="truncate text-base font-semibold text-canvas-text">火山方舟用量记录</h2>
          </div>
          <PopupCloseButton
            ariaLabel="关闭用量记录"
            title="关闭"
            onClick={() => setBillingOpen(false)}
          />
        </div>
        {billingOpen && <VolcengineBillingSettings />}
      </ModalOverlay>
      <span className="sr-only" aria-live="polite">{dreaminaStatusMsg}</span>
    </div>
  );
}
