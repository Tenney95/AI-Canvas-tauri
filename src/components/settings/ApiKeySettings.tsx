/**
 * ApiKeySettings — provider connections and enabled model catalogs.
 */
import { Icon } from '@iconify/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { getProviderDefinition } from '../../services/ai/providerCatalogService';
import type { ApiProviderConfig, DreaminaRuntime, ProviderModelSelection } from '../../types';
import AnimatedButton from '../shared/AnimatedButton';
import { defaultModelGroups } from '../nodes/shared/defaultModels';
import DreaminaLoginModal from './DreaminaLoginModal';
import ProviderConnectionDialog from './ProviderConnectionDialog';

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
  const {
    config,
    updateConfig,
    setProviderConfig,
    saveProviderConfig,
    removeProviderConfig,
    saveConfig,
  } = useAppStore(
    useShallow((state) => ({
      config: state.config,
      updateConfig: state.updateConfig,
      setProviderConfig: state.setProviderConfig,
      saveProviderConfig: state.saveProviderConfig,
      removeProviderConfig: state.removeProviderConfig,
      saveConfig: state.saveConfig,
    })),
  );

  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string>();
  const [connectionDialogRevision, setConnectionDialogRevision] = useState(0);
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();

  const [dreaminaLoading, setDreaminaLoading] = useState(false);
  const [dreaminaStatusMsg, setDreaminaStatusMsg] = useState('首次登录时会自动准备即梦组件');
  const [dreaminaModalOpen, setDreaminaModalOpen] = useState(false);
  const [dreaminaRuntime, setDreaminaRuntime] = useState<DreaminaRuntime | null>(null);
  const dreaminaDoneRef = useRef(false);
  const dreaminaAuth = config.dreaminaAuth;

  const fallbackModels = useMemo(() => {
    const catalog: Record<string, ProviderModelSelection[]> = {};
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
      if (definition.authType !== 'oauth' && !providerConfig.apiKey.trim()) continue;
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
    const order = ['apimart', 'volcengine', 'runninghub-model', 'grsai', 'dreamina', 'custom-openai'];
    return items.sort((left, right) => {
      const leftDefinition = getProviderDefinition(left.id, left.config);
      const rightDefinition = getProviderDefinition(right.id, right.config);
      return order.indexOf(leftDefinition?.id || 'custom-openai')
        - order.indexOf(rightDefinition?.id || 'custom-openai');
    });
  }, [config.providers, dreaminaAuth?.loggedIn]);

  const connectedProviderIds = useMemo(
    () => providerItems.map((item) => getProviderDefinition(item.id, item.config)?.id || item.id),
    [providerItems],
  );

  const editingConfig = editingConnectionId
    ? providerItems.find((item) => item.id === editingConnectionId)?.config
    : undefined;

  const tauriInvoke = useCallback(
    async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<T>(command, args);
    },
    [],
  );

  const applyDreaminaRuntime = useCallback((runtime: DreaminaRuntime) => {
    setDreaminaRuntime(runtime);
    if (runtime.message) setDreaminaStatusMsg(runtime.message);
    if (runtime.phase !== 'success' && !runtime.loggedIn) return;
    updateConfig({
      dreaminaAuth: {
        loggedIn: true,
        username: runtime.username || '即梦用户',
        credit: runtime.credit || undefined,
        loginTs: Date.now(),
      },
    });
    if (dreaminaDoneRef.current) return;
    dreaminaDoneRef.current = true;
    useAppStore.getState().showToast('即梦登录成功');
    setTimeout(() => setDreaminaModalOpen(false), 800);
  }, [updateConfig]);

  const handleDreaminaLogin = useCallback(async (force = false) => {
    if (!isTauri()) {
      setDreaminaStatusMsg('OAuth 登录仅在桌面应用中可用');
      useAppStore.getState().showToast('OAuth 登录仅在桌面应用中可用', 'error');
      return;
    }
    dreaminaDoneRef.current = false;
    setDreaminaLoading(true);
    setDreaminaRuntime(null);
    setDreaminaModalOpen(true);
    try {
      setDreaminaRuntime(await tauriInvoke<DreaminaRuntime>('dreamina_login_start', { force }));
    } catch (error) {
      const message = typeof error === 'string' ? error : (error as Error)?.message || '启动登录失败';
      setDreaminaStatusMsg(message);
    } finally {
      setDreaminaLoading(false);
    }
  }, [tauriInvoke]);

  const handleDreaminaLogout = useCallback(async () => {
    setDreaminaLoading(true);
    try {
      if (isTauri()) await tauriInvoke('dreamina_logout');
    } catch {
      // Local configuration still needs to be cleared if the native logout fails.
    }
    updateConfig({ dreaminaAuth: undefined });
    setDreaminaRuntime(null);
    setDreaminaStatusMsg('已退出登录');
    setDreaminaLoading(false);
  }, [tauriInvoke, updateConfig]);

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      await import('@tauri-apps/plugin-shell').then(({ open }) => open(url));
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const handleDreaminaCopy = useCallback((text: string, label: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    useAppStore.getState().showToast(`已复制${label}`);
  }, []);

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
      setDreaminaStatusMsg('即梦已登录');
      updateConfig({
        dreaminaAuth: {
          loggedIn: true,
          username: runtime.username || '即梦用户',
          credit: runtime.credit || undefined,
          loginTs: dreaminaAuth.loginTs || Date.now(),
        },
      });
    }).catch(() => {});
    // Validate the persisted OAuth mirror only when the settings view mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAddDialog = () => {
    setEditingConnectionId(undefined);
    setConnectionDialogRevision((revision) => revision + 1);
    setConnectionDialogOpen(true);
  };

  const openEditDialog = (connectionId: string) => {
    setEditingConnectionId(connectionId);
    setConnectionDialogRevision((revision) => revision + 1);
    setConnectionDialogOpen(true);
  };

  const closeConnectionDialog = () => {
    setConnectionDialogOpen(false);
    setEditingConnectionId(undefined);
  };

  const handleSaveConnection = async (
    connectionId: string,
    providerConfig: ApiProviderConfig,
    related?: { runninghubWorkflowApiKey?: string },
  ) => {
    saveProviderConfig(connectionId, providerConfig);
    if (related?.runninghubWorkflowApiKey) {
      setProviderConfig('runninghub', {
        name: 'RunningHub 工作流',
        apiKey: related.runninghubWorkflowApiKey,
      });
    } else if (related && config.providers.runninghub) {
      removeProviderConfig('runninghub');
    }
    await saveConfig();
    closeConnectionDialog();
  };

  const handleRemoveConnection = async (connectionId: string) => {
    if (connectionId === 'dreamina') await handleDreaminaLogout();
    removeProviderConfig(connectionId);
    if (connectionId === 'runninghub-model') removeProviderConfig('runninghub');
    setPendingDeleteId(undefined);
    await saveConfig();
  };

  return (
    <div className="settings-pane">
      <div className="settings-pane-heading">
        <h2 className="settings-pane-title">API Key</h2>
        <AnimatedButton
          type="button"
          className="settings-add-provider-btn"
          aria-label="添加 API 厂商"
          data-tooltip="添加 API 厂商"
          onClick={openAddDialog}
        >
          <Icon icon="mdi:plus" width="18" />
        </AnimatedButton>
      </div>

      <div className="settings-pane-body provider-settings-body">
        {providerItems.length === 0 ? (
          <div className="provider-empty-state">
            <span className="provider-empty-icon"><Icon icon="mdi:key-chain-variant" width="24" /></span>
            <strong>尚未添加 API 厂商</strong>
            <AnimatedButton type="button" className="provider-primary-btn" onClick={openAddDialog}>
              <Icon icon="mdi:plus" width="15" />
              添加厂商
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
              const hasRunningHubModelKey = isRunningHub && !!item.config.apiKey.trim();
              const hasRunningHubWorkflowKey = isRunningHub
                && !!config.providers.runninghub?.apiKey.trim();
              const runningHubKeyCount = Number(hasRunningHubModelKey)
                + Number(hasRunningHubWorkflowKey);
              const displayName = definition.id === 'custom-openai'
                ? item.config.name.trim() || definition.name
                : definition.name;
              const statusLabel = isDreamina
                ? 'OAuth 已连接'
                : isRunningHub
                  ? `${runningHubKeyCount}/2 密钥已配置`
                  : '已连接';
              return (
                <div key={item.id} className="provider-connection-card">
                  <div className={`provider-badge provider-badge--${definition.id}`}>{definition.badgeText}</div>
                  <div className="provider-connection-copy">
                    <div className="provider-connection-title-row">
                      <strong>{displayName}</strong>
                      <span className={`provider-list-status${isRunningHub && runningHubKeyCount < 2 ? ' is-limited' : ''}`}>
                        {statusLabel}
                      </span>
                    </div>
                    <div className="provider-connection-meta">
                      {isRunningHub ? (
                        <>
                          <span>{hasRunningHubModelKey ? '企业级-共享已配置' : '企业级-共享未配置'}</span>
                          <span>{hasRunningHubWorkflowKey ? '消费级-会员已配置' : '消费级-会员未配置'}</span>
                          {hasRunningHubModelKey && (
                            <span>
                              {selectedCount === undefined
                                ? '沿用内置模型目录'
                                : `${selectedCount} 个模型`}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span>
                            {selectedCount === undefined
                              ? '沿用内置模型目录'
                              : `${selectedCount} 个模型`}
                          </span>
                          {summaryUrl && <span>{summaryUrl}</span>}
                        </>
                      )}
                    </div>
                  </div>

                  {pendingDeleteId === item.id ? (
                    <div className="provider-delete-confirm">
                      <span>移除此连接？</span>
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn"
                        aria-label="取消删除"
                        onClick={() => setPendingDeleteId(undefined)}
                      >
                        <Icon icon="mdi:close" width="15" />
                      </AnimatedButton>
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn is-danger"
                        aria-label="确认删除"
                        onClick={() => void handleRemoveConnection(item.id)}
                      >
                        <Icon icon="mdi:check" width="15" />
                      </AnimatedButton>
                    </div>
                  ) : (
                    <div className="provider-card-actions">
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn"
                        aria-label={`编辑 ${definition.name}`}
                        data-tooltip="编辑连接"
                        onClick={() => openEditDialog(item.id)}
                      >
                        <Icon icon="mdi:pencil-outline" width="16" />
                      </AnimatedButton>
                      <AnimatedButton
                        type="button"
                        className="provider-icon-btn"
                        aria-label={`删除 ${definition.name}`}
                        data-tooltip="删除连接"
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
            完成
          </AnimatedButton>
        </div>
      </div>

      <ProviderConnectionDialog
        key={connectionDialogRevision}
        isOpen={connectionDialogOpen}
        connectionId={editingConnectionId}
        initialConfig={editingConfig}
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
