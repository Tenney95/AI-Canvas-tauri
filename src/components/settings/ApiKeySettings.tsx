/**
 * ApiKeySettings — provider connections and enabled model catalogs.
 */
import { Icon } from '@iconify/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
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
import { copyText, readText } from '../../services/clipboardService';
import type {
  ApiProviderConfig,
  DreaminaRuntime,
  ProviderModelSelection,
  WebSearchProviderId,
} from '../../types';
import AnimatedButton from '../shared/AnimatedButton';
import { defaultModelGroups } from '../nodes/shared/defaultModels';
import { shouldListProviderConnection } from './apiKeySettingsUtils';
import { isSecretStoreAvailable } from '../../services/providerSecretService';
import { testProviderConnection } from '../../services/testConnection';
import DreaminaLoginModal from './DreaminaLoginModal';
import ProviderConnectionDialog from './ProviderConnectionDialog';
import { invoke } from '@tauri-apps/api/core';
import { useT } from '../../i18n';

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
  const {
    config,
    updateConfig,
    setProviderConfig,
    saveProviderConfig,
    removeProviderConfig,
    saveConfig,
    pendingApiKeyConnectionId,
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
      setPendingApiKeyConnectionId: state.setPendingApiKeyConnectionId,
    })),
  );

  // 三者总是一起变化，合成一份状态；revision 用于每次打开时重挂载对话框
  const [dialog, setDialog] = useState<{ open: boolean; connectionId?: string; revision: number }>({
    open: false,
    revision: 0,
  });
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const [providerBalances, setProviderBalances] = useState<Record<string, string>>({});
  const balanceRefreshStartedRef = useRef(new Set<string>());
  const balanceRefreshActiveRef = useRef(true);
  // 凭据存在 Rust 侧的凭据存储里；不可用时只能本次会话有效，得在用户填写前就说清楚
  const [secretStoreAvailable, setSecretStoreAvailable] = useState(true);

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
      if (id === 'runninghub') continue;
      const definition = getProviderDefinition(id, providerConfig);
      if (!definition) continue;
      if (definition.kind === 'web-search' && id !== activeWebSearchProviderId) continue;
      if (!shouldListProviderConnection(providerConfig, definition.authType)) continue;
      items.push({ id, config: providerConfig });
    }
    if (config.providers.runninghub?.apiKey && !config.providers['runninghub-model']) {
      items.push({
        id: 'runninghub-model',
        config: { name: 'RunningHub', apiKey: '', catalogId: 'runninghub-model' },
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

  const connectedProviderIds = useMemo(
    () => providerItems.map((item) => getProviderDefinition(item.id, item.config)?.id || item.id),
    [providerItems],
  );

  // Agent 保存厂商配置后请求补填密钥：在渲染期直接生效，不用 effect 回写本地 state。
  // 任何一次手动开关对话框都视为消费掉该请求（关闭设置面板时 store 也会清空它）。
  const requestedConnectionId = pendingApiKeyConnectionId && config.providers[pendingApiKeyConnectionId]
    ? pendingApiKeyConnectionId
    : null;
  const connectionDialogOpen = dialog.open || !!requestedConnectionId;
  const editingConnectionId = requestedConnectionId ?? dialog.connectionId;
  const connectionDialogKey = requestedConnectionId
    ? `pending-${requestedConnectionId}`
    : dialog.revision;

  const editingConfig = editingConnectionId
    ? providerItems.find((item) => item.id === editingConnectionId)?.config
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
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    balanceRefreshActiveRef.current = true;
    return () => { balanceRefreshActiveRef.current = false; };
  }, []);

  useEffect(() => {
    let changed = false;
    for (const [connectionId, providerConfig] of Object.entries(config.providers)) {
      const catalogId = providerConfig.catalogId
        || getProviderDefinition(connectionId, providerConfig)?.id;
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
      if (definition?.id !== 'sora2u' || !item.config.apiKey.trim()) continue;
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
    const ok = await copyText(serializeConnection(providerConfig));
    useAppStore.getState().showToast(
      ok ? t('连接配置已复制（不含 API Key）') : t('复制失败'),
      ok ? 'success' : 'error',
    );
  };

  /** 从剪贴板导入连接；保存后直接打开对话框让用户补填 API Key。 */
  const handleImportConnection = async () => {
    const parsed = parseConnectionShare(await readText());
    if (!parsed) {
      useAppStore.getState().showToast(t('剪贴板里没有可导入的连接配置'), 'error');
      return;
    }
    const definition = getProviderDefinition(parsed.catalogId);
    if (!definition || definition.authType === 'oauth') {
      useAppStore.getState().showToast(t('该连接类型不支持导入'), 'error');
      return;
    }
    const newConnectionId = createConnectionId(parsed.catalogId);
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
    await saveConfig();
    useAppStore.getState().showToast(t('已导入连接，请补填 API Key'));
    setPendingApiKeyConnectionId(newConnectionId);
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
    related?: { runninghubWorkflowApiKey?: string },
  ) => {
    saveProviderConfig(connectionId, providerConfig);
    const definition = getProviderDefinition(connectionId, providerConfig);
    if (definition?.kind === 'web-search') {
      updateConfig({ webSearchProviderId: definition.id as WebSearchProviderId });
    } else if (related?.runninghubWorkflowApiKey) {
      setProviderConfig('runninghub', {
        name: 'RunningHub 工作流',
        apiKey: related.runninghubWorkflowApiKey,
      });
    } else if (related && config.providers.runninghub) {
      await removeProviderConfig('runninghub');
    }
    await saveConfig();
    closeConnectionDialog();
  };

  const handleRemoveConnection = async (connectionId: string) => {
    const providerConfig = config.providers[connectionId];
    const definition = getProviderDefinition(connectionId, providerConfig);
    if (connectionId === 'dreamina') await handleDreaminaLogout();
    if (definition?.kind === 'web-search') {
      for (const searchDefinition of getWebSearchProviderDefinitions()) {
        await removeProviderConfig(searchDefinition.id);
      }
      updateConfig({ webSearchProviderId: undefined });
    } else {
      await removeProviderConfig(connectionId);
    }
    if (connectionId === 'runninghub-model') await removeProviderConfig('runninghub');
    setPendingDeleteId(undefined);
    await saveConfig();
  };

  return (
    <div className="settings-pane">
      <div className="settings-pane-heading">
        <h2 className="settings-pane-title">API Key</h2>
        <div className="flex items-center gap-1.5">
          <AnimatedButton
            type="button"
            className="settings-add-provider-btn"
            aria-label={t('从剪贴板导入连接')}
            data-tooltip={t('从剪贴板导入连接')}
            onClick={() => void handleImportConnection()}
          >
            <Icon icon="mdi:clipboard-arrow-down-outline" width="17" />
          </AnimatedButton>
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
            {providerItems.map((item) => {
              const definition = getProviderDefinition(item.id, item.config);
              if (!definition) return null;
              const selectedCount = item.config.selectedModels?.length;
              const summaryUrl = providerSummaryUrl(item.config, definition.defaultBaseUrl);
              const isDreamina = definition.id === 'dreamina';
              const isRunningHub = definition.id === 'runninghub-model';
              const isWebSearchProvider = definition.kind === 'web-search';
              const isPendingApiKey = definition.authType !== 'oauth' && !item.config.apiKey.trim();
              const hasRunningHubModelKey = isRunningHub && !!item.config.apiKey.trim();
              const hasRunningHubWorkflowKey = isRunningHub
                && !!config.providers.runninghub?.apiKey.trim();
              const runningHubKeyCount = Number(hasRunningHubModelKey)
                + Number(hasRunningHubWorkflowKey);
              const displayName = isWebSearchProvider
                ? t('联网搜索')
                : definition.id === 'custom-openai'
                  ? item.config.name.trim() || definition.name
                  : definition.name;
              const statusLabel = isDreamina
                ? t('OAuth 已连接')
                : isRunningHub
                  ? t('{count}/2 密钥已配置', { count: runningHubKeyCount })
                  : isPendingApiKey
                    ? t('待填写 API Key')
                    : t('已连接');
              return (
                <div key={item.id} className="provider-connection-card">
                  <div className={`provider-badge provider-badge--${definition.id}`}>{definition.badgeText}</div>
                  <div className="provider-connection-copy">
                    <div className="provider-connection-title-row">
                      <strong>{displayName}</strong>
                      <span className={`provider-list-status${isPendingApiKey || (isRunningHub && runningHubKeyCount < 2) ? ' is-limited' : ''}`}>
                        {statusLabel}
                      </span>
                      {providerBalances[item.id] && (
                        <span className="shrink-0 text-xs font-medium text-canvas-text-secondary">
                          {providerBalances[item.id]}
                        </span>
                      )}
                    </div>
                    <div className="provider-connection-meta">
                      {isRunningHub ? (
                        <>
                          <span>{hasRunningHubModelKey ? t('企业级-共享已配置') : t('企业级-共享未配置')}</span>
                          <span>{hasRunningHubWorkflowKey ? t('消费级-会员已配置') : t('消费级-会员未配置')}</span>
                          {hasRunningHubModelKey && (
                            <span>
                              {selectedCount === undefined
                                ? t('沿用内置模型目录')
                                : t('{count} 个模型', { count: selectedCount })}
                            </span>
                          )}
                        </>
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
                          {summaryUrl && <span>{summaryUrl}</span>}
                        </>
                      )}
                    </div>
                  </div>

                  {pendingDeleteId === item.id ? (
                    <div className="provider-delete-confirm">
                      <span>{t('移除此连接？')}</span>
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
                        onClick={() => void handleRemoveConnection(item.id)}
                      >
                        <Icon icon="mdi:check" width="15" />
                      </AnimatedButton>
                    </div>
                  ) : (
                    <div className="provider-card-actions">
                      {!isDreamina && !isWebSearchProvider && (
                        <AnimatedButton
                          type="button"
                          className="provider-icon-btn"
                          aria-label={t('复制 {name} 配置', { name: definition.name })}
                          data-tooltip={t('复制配置（不含 API Key）')}
                          onClick={() => void handleCopyConnection(item.id)}
                        >
                          <Icon icon="mdi:content-copy" width="15" />
                        </AnimatedButton>
                      )}
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn"
                        aria-label={t('编辑 {name}', { name: definition.name })}
                        data-tooltip={t('编辑连接')}
                        onClick={() => openEditDialog(item.id)}
                      >
                        <Icon icon="mdi:pencil-outline" width="16" />
                      </AnimatedButton>
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn"
                        aria-label={t('删除 {name}', { name: definition.name })}
                        data-tooltip={t('删除连接')}
                        onClick={() => setPendingDeleteId(item.id)}
                      >
                        <Icon icon="mdi:trash-can-outline" width="16" />
                      </AnimatedButton>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="settings-pane-footer">
        <div className="settings-save-row">
          <AnimatedButton
            type="button"
            className="settings-save-btn"
            onClick={async () => {
              await saveConfig();
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
        providerConfigs={config.providers}
        connectedProviderIds={connectedProviderIds}
        fallbackModels={fallbackModels}
        dreaminaLoggedIn={!!dreaminaAuth?.loggedIn}
        dreaminaLoading={dreaminaLoading}
        runninghubWorkflowApiKey={config.providers.runninghub?.apiKey}
        onDreaminaLogin={() => void handleDreaminaLogin(!!dreaminaAuth?.loggedIn)}
        onClose={closeConnectionDialog}
        onSave={handleSaveConnection}
      />

      <DreaminaLoginModal
        isOpen={dreaminaModalOpen}
        runtime={dreaminaRuntime}
        onClose={() => setDreaminaModalOpen(false)}
        onOpenUrl={openExternalUrl}
        onCopy={handleDreaminaCopy}
      />
      <span className="sr-only" aria-live="polite">{dreaminaStatusMsg}</span>
    </div>
  );
}
