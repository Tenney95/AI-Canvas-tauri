/**
 * ProviderConnectionDialog — add/edit one provider connection and choose its enabled models.
 */
import { Icon } from '@iconify/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ApiProviderConfig,
  GeneralModelCategory,
  ProviderModelSelection,
  WebSearchProviderId,
} from '../../types';
import {
  fetchProviderModelCatalog,
  getProviderDefinition,
  getProviderDefinitions,
  getWebSearchProviderDefinitions,
  type ProviderDefinition,
} from '../../services/ai/providerCatalogService';
import type { ModelProtocolImportResult } from '../../services/ai/modelProtocolImport';
import { testProviderConnection } from '../../services/testConnection';
import AnimatedButton from '../shared/AnimatedButton';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import ModelProtocolEditor from './ModelProtocolEditor';
import ProtocolImportPanel from './ProtocolImportPanel';

const CATEGORY_ORDER: GeneralModelCategory[] = ['text', 'image', 'video', 'audio'];
const CATEGORY_LABELS: Record<GeneralModelCategory, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
};

const PROVIDER_LINKS: Record<string, string> = {
  apimart: 'https://apimart.ai/register?aff=ZnmCKm',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  'runninghub-model': 'https://www.runninghub.cn?inviteCode=iadc40jt',
  grsai: 'https://grsai.com/zh/dashboard/user-info',
  dreamina: 'https://www.dreamina.com',
  tavily: 'https://app.tavily.com',
  bocha: 'https://open.bochaai.com/dashboard',
  'zhipu-search': 'https://open.bigmodel.cn/usercenter/apikeys',
  exa: 'https://dashboard.exa.ai/api-keys',
};

type CatalogStatus = 'idle' | 'loading' | 'ready' | 'warning' | 'error';

interface ProtocolImportSnapshot {
  baseUrl: string;
  models: ProviderModelSelection[];
  selectedIds: Set<string>;
  visibleModelCategories: Set<GeneralModelCategory>;
  category: GeneralModelCategory | 'all';
  protocolModelId: string | null;
  protocolValid: boolean;
  catalogStatus: CatalogStatus;
  catalogMessage: string;
}

interface ProviderConnectionDialogProps {
  isOpen: boolean;
  connectionId?: string;
  initialConfig?: ApiProviderConfig;
  providerConfigs: Record<string, ApiProviderConfig>;
  connectedProviderIds: string[];
  fallbackModels: Record<string, ProviderModelSelection[]>;
  dreaminaLoggedIn: boolean;
  dreaminaLoading: boolean;
  runninghubWorkflowApiKey?: string;
  onDreaminaLogin: () => void;
  onClose: () => void;
  onSave: (
    connectionId: string,
    config: ApiProviderConfig,
    related?: { runninghubWorkflowApiKey?: string },
  ) => Promise<void>;
}

function createConnectionId(providerId: string): string {
  if (providerId !== 'custom-openai') return providerId;
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return `custom-${suffix}`;
}

function mergeModels(
  current: ProviderModelSelection[],
  incoming: ProviderModelSelection[],
): ProviderModelSelection[] {
  const models = new Map(current.map((model) => [model.id, model]));
  for (const model of incoming) {
    const existing = models.get(model.id);
    const incomingHasOnlyRawName = model.name.trim().toLowerCase() === model.id.trim().toLowerCase();
    const existingHasFriendlyName = existing
      && existing.name.trim().toLowerCase() !== existing.id.trim().toLowerCase();
    const preserveExistingMetadata = incomingHasOnlyRawName && existingHasFriendlyName;
    models.set(model.id, {
      ...existing,
      ...model,
      name: preserveExistingMetadata ? existing.name : model.name,
      category: preserveExistingMetadata ? existing.category : model.category,
      description: model.description || existing?.description,
    });
  }
  return [...models.values()];
}

async function openExternal(url: string): Promise<void> {
  try {
    await import('@tauri-apps/plugin-shell').then(({ open }) => open(url));
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export default function ProviderConnectionDialog({
  isOpen,
  connectionId,
  initialConfig,
  providerConfigs,
  connectedProviderIds,
  fallbackModels,
  dreaminaLoggedIn,
  dreaminaLoading,
  runninghubWorkflowApiKey = '',
  onDreaminaLogin,
  onClose,
  onSave,
}: ProviderConnectionDialogProps) {
  const editing = !!connectionId && !!initialConfig;
  const initialDefinitionId = initialConfig?.catalogId || connectionId || '';
  const initialDefinition = getProviderDefinition(initialDefinitionId, initialConfig);
  const initialSelectedModels = initialConfig?.selectedModels || [];
  const initialCatalogModels = initialConfig?.catalogModels || [];
  const initialLocalModels = initialDefinition ? (fallbackModels[initialDefinition.id] || []) : [];
  const [definitionId, setDefinitionId] = useState(initialDefinitionId);
  const [connectionName, setConnectionName] = useState(initialConfig?.name || initialDefinition?.name || '');
  const [apiKey, setApiKey] = useState(initialConfig?.apiKey || '');
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl || initialDefinition?.defaultBaseUrl || '');
  const [anthropicUrl, setAnthropicUrl] = useState(initialConfig?.anthropicUrl || '');
  const [workflowApiKey, setWorkflowApiKey] = useState(runninghubWorkflowApiKey);
  const [models, setModels] = useState<ProviderModelSelection[]>(
    mergeModels(mergeModels(initialLocalModels, initialCatalogModels), initialSelectedModels),
  );
  const [selectedIds, setSelectedIds] = useState(() =>
    new Set(initialSelectedModels.map((model) => model.id)),
  );
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>(
    initialSelectedModels.length > 0 || initialLocalModels.length > 0 ? 'ready' : 'idle',
  );
  const [catalogMessage, setCatalogMessage] = useState(
    initialCatalogModels.length > 0 ? `已加载本地缓存 ${initialCatalogModels.length} 个模型` : '',
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<GeneralModelCategory | 'all'>('all');
  const [visibleModelCategories, setVisibleModelCategories] = useState(
    () => new Set(initialConfig?.visibleModelCategories ?? CATEGORY_ORDER),
  );
  const [manualModelId, setManualModelId] = useState('');
  const [manualModelName, setManualModelName] = useState('');
  const [manualCategory, setManualCategory] = useState<GeneralModelCategory>('text');
  const [protocolModelId, setProtocolModelId] = useState<string | null>(null);
  const [protocolValid, setProtocolValid] = useState(true);
  const [protocolImportOpen, setProtocolImportOpen] = useState(false);
  const [protocolImportSnapshot, setProtocolImportSnapshot] = useState<ProtocolImportSnapshot | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const definition = getProviderDefinition(definitionId);
  const definitions = getProviderDefinitions();
  const webSearchDefinitions = getWebSearchProviderDefinitions();
  const isWebSearchProvider = definition?.kind === 'web-search';
  const hasWebSearchConnection = webSearchDefinitions.some((item) =>
    Boolean(providerConfigs[item.id]?.apiKey?.trim()),
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  const availableDefinitions = definitions.filter((item) => {
    if (item.kind === 'web-search') {
      return item.id === 'tavily' && (!hasWebSearchConnection || isWebSearchProvider);
    }
    return item.id === 'custom-openai'
      || item.id === initialDefinitionId
      || !connectedProviderIds.includes(item.id);
  });

  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return models.filter((model) =>
      (category === 'all' || model.category === category)
      && (!normalizedQuery
        || model.name.toLowerCase().includes(normalizedQuery)
        || model.id.toLowerCase().includes(normalizedQuery)),
    );
  }, [category, models, query]);

  const selectedModels = useMemo(
    () => models.filter((model) => selectedIds.has(model.id)),
    [models, selectedIds],
  );

  const protocolModel = useMemo(
    () => models.find((model) => model.id === protocolModelId),
    [models, protocolModelId],
  );

  const missingCredentials = useMemo(() => {
    if (!definition) return true;
    if (definition.authType === 'oauth') return !dreaminaLoggedIn;
    if (!apiKey.trim()) return true;
    return definition.credentials.some((field) =>
      field.required
      && field.key !== 'apiKey'
      && !(field.key === 'baseUrl' ? baseUrl : anthropicUrl).trim(),
    );
  }, [anthropicUrl, apiKey, baseUrl, definition, dreaminaLoggedIn]);

  const chooseDefinition = (nextDefinition: ProviderDefinition) => {
    const savedConfig = nextDefinition.kind === 'web-search'
      ? providerConfigs[nextDefinition.id]
      : undefined;
    setDefinitionId(nextDefinition.id);
    setConnectionName(savedConfig?.name || nextDefinition.name);
    setApiKey(savedConfig?.apiKey || '');
    setBaseUrl(savedConfig?.baseUrl || nextDefinition.defaultBaseUrl || '');
    setAnthropicUrl(savedConfig?.anthropicUrl || '');
    setWorkflowApiKey('');
    const localModels = fallbackModels[nextDefinition.id] || [];
    setModels(localModels);
    setSelectedIds(new Set());
    setCatalogStatus(localModels.length > 0 ? 'ready' : 'idle');
    setCatalogMessage('');
    setQuery('');
    setCategory('all');
    setVisibleModelCategories(new Set(CATEGORY_ORDER));
    setManualModelId('');
    setManualModelName('');
    setManualCategory('text');
    setProtocolModelId(null);
    setProtocolValid(true);
    setProtocolImportOpen(false);
    setProtocolImportSnapshot(null);
  };

  const handleFetchModels = async () => {
    if (!definition || missingCredentials) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCatalogStatus('loading');
    setCatalogMessage('');
    try {
      if (definition.id === 'runninghub-model') {
        const result = await testProviderConnection('runninghub-model', apiKey.trim());
        if (!result.success) throw new Error(result.error || 'RunningHub API Key 验证失败');
      }
      const result = await fetchProviderModelCatalog({
        providerId: definition.id,
        config: {
          name: connectionName.trim() || definition.name,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
          anthropicUrl: anthropicUrl.trim() || undefined,
          catalogId: definition.id,
        },
        fallbackModels: fallbackModels[definition.id] || [],
        signal: controller.signal,
      });
      setModels((current) => mergeModels(current, result.models));
      setCatalogStatus(result.warning ? 'warning' : 'ready');
      setCatalogMessage(result.warning || `已获取 ${result.models.length} 个模型`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setCatalogStatus('error');
      setCatalogMessage(error instanceof Error ? error.message : '模型列表拉取失败');
    }
  };

  const handleTestWebSearchConnection = async () => {
    if (!isWebSearchProvider || !definition || missingCredentials) return;
    setCatalogStatus('loading');
    setCatalogMessage(`正在验证 ${definition.name} 连接...`);
    const result = await testProviderConnection(
      definition.id as WebSearchProviderId,
      apiKey.trim(),
    );
    if (result.success) {
      setCatalogStatus('ready');
      setCatalogMessage(`${definition.name} 连接验证成功`);
      return;
    }
    setCatalogStatus('error');
    setCatalogMessage(result.error || `${definition.name} 连接验证失败`);
  };

  const toggleModel = (modelId: string) => {
    if (selectedIds.has(modelId) && protocolModelId === modelId) closeProtocolEditor();
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const toggleVisibleModels = () => {
    const allVisibleSelected = filteredModels.length > 0
      && filteredModels.every((model) => selectedIds.has(model.id));
    if (
      allVisibleSelected
      && protocolModelId
      && filteredModels.some((model) => model.id === protocolModelId)
    ) {
      closeProtocolEditor();
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const model of filteredModels) {
        if (allVisibleSelected) next.delete(model.id);
        else next.add(model.id);
      }
      return next;
    });
  };

  const toggleVisibleCategory = (nextCategory: GeneralModelCategory) => {
    setVisibleModelCategories((current) => {
      const next = new Set(current);
      if (next.has(nextCategory)) next.delete(nextCategory);
      else next.add(nextCategory);
      return next;
    });
  };

  const toggleAllVisibleCategories = () => {
    setVisibleModelCategories((current) =>
      current.size === CATEGORY_ORDER.length ? new Set() : new Set(CATEGORY_ORDER),
    );
  };

  const addManualModel = () => {
    const id = manualModelId.trim();
    if (!id || !definition) return;
    const model: ProviderModelSelection = {
      id,
      name: manualModelName.trim() || id,
      category: manualCategory,
      provider: connectionId || definition.id,
    };
    setModels((current) => mergeModels(current, [model]));
    setSelectedIds((current) => new Set(current).add(id));
    setManualModelId('');
    setManualModelName('');
  };

  const updateModelProtocol = (
    modelId: string,
    executionProfile: ProviderModelSelection['executionProfile'],
  ) => {
    setModels((current) => current.map((model) =>
      model.id === modelId ? { ...model, executionProfile } : model,
    ));
  };

  const closeProtocolEditor = () => {
    setProtocolModelId(null);
    setProtocolValid(true);
  };

  const applyProtocolImport = (result: ModelProtocolImportResult) => {
    if (
      definition?.id !== 'custom-openai'
      || !result.baseUrl
      || !result.modelId
      || !result.category
      || !result.protocol
    ) return;
    setProtocolImportSnapshot({
      baseUrl,
      models: structuredClone(models),
      selectedIds: new Set(selectedIds),
      visibleModelCategories: new Set(visibleModelCategories),
      category,
      protocolModelId,
      protocolValid,
      catalogStatus,
      catalogMessage,
    });
    const modelId = result.modelId;
    const importedModel: ProviderModelSelection = {
      id: modelId,
      name: models.find((model) => model.id === modelId)?.name || modelId,
      category: result.category,
      provider: connectionId || definition.id,
      executionProfile: { preset: 'custom', protocol: result.protocol },
    };
    setBaseUrl(result.baseUrl);
    setModels((current) => {
      const existing = current.find((model) => model.id === modelId);
      if (!existing) return [...current, importedModel];
      return current.map((model) => model.id === modelId
        ? { ...model, category: importedModel.category, executionProfile: importedModel.executionProfile }
        : model);
    });
    setSelectedIds((current) => new Set(current).add(modelId));
    setVisibleModelCategories((current) => new Set(current).add(importedModel.category));
    setCategory('all');
    setProtocolModelId(modelId);
    setProtocolValid(true);
    setCatalogStatus('ready');
    setCatalogMessage(`已从接口文档导入模型 ${modelId}，保存前可继续检查调用协议`);
    setProtocolImportOpen(false);
  };

  const undoProtocolImport = () => {
    if (!protocolImportSnapshot) return;
    setBaseUrl(protocolImportSnapshot.baseUrl);
    setModels(protocolImportSnapshot.models);
    setSelectedIds(protocolImportSnapshot.selectedIds);
    setVisibleModelCategories(protocolImportSnapshot.visibleModelCategories);
    setCategory(protocolImportSnapshot.category);
    setProtocolModelId(protocolImportSnapshot.protocolModelId);
    setProtocolValid(protocolImportSnapshot.protocolValid);
    setCatalogStatus(protocolImportSnapshot.catalogStatus);
    setCatalogMessage(protocolImportSnapshot.catalogMessage);
    setProtocolImportSnapshot(null);
    setProtocolImportOpen(false);
  };

  const closeDialog = () => {
    setProtocolImportOpen(false);
    setProtocolImportSnapshot(null);
    onClose();
  };

  const returnToDefinitionPicker = () => {
    setProtocolImportOpen(false);
    setProtocolImportSnapshot(null);
    setDefinitionId('');
  };

  const handleSave = async () => {
    if (
      !definition
      || missingCredentials
      || (!isWebSearchProvider && selectedModels.length === 0)
      || !protocolValid
    ) return;
    const nextConnectionId = isWebSearchProvider
      ? definition.id
      : connectionId || createConnectionId(definition.id);
    const modelConfig = isWebSearchProvider
      ? {}
      : {
          selectedModels: selectedModels.map((model) => ({ ...model, provider: nextConnectionId })),
          catalogModels: models.map((model) => ({ ...model, provider: nextConnectionId })),
          visibleModelCategories: CATEGORY_ORDER.filter((item) => visibleModelCategories.has(item)),
          catalogUpdatedAt: Date.now(),
        };
    await onSave(
      nextConnectionId,
      {
        name: connectionName.trim() || definition.name,
        apiKey: definition.authType === 'oauth' ? '' : apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        anthropicUrl: anthropicUrl.trim() || undefined,
        catalogId: definition.id,
        ...modelConfig,
      },
      definition.id === 'runninghub-model'
        ? { runninghubWorkflowApiKey: workflowApiKey.trim() }
        : undefined,
    );
  };

  return createPortal(
    <ModalOverlay
      isOpen={isOpen}
      onClose={closeDialog}
      ariaLabel={editing ? '编辑 API 厂商' : '添加 API 厂商'}
      className="provider-dialog"
      closeOnBackdrop={false}
      draggable
    >
      <header
        className="provider-dialog-header cursor-move select-none touch-none"
        data-modal-drag-handle
      >
        <div>
          <span className="provider-dialog-kicker">{editing ? '编辑连接' : '新建连接'}</span>
          <h3>{isWebSearchProvider ? '联网搜索' : definition ? definition.name : '选择 API 厂商'}</h3>
        </div>
        <PopupCloseButton onClick={closeDialog} />
      </header>

      {!definition ? (
        <div className="provider-dialog-body provider-picker-body">
          <div className="provider-picker-grid">
            {availableDefinitions.map((item) => (
              <button
                key={item.id}
                type="button"
                className="provider-picker-item"
                onClick={() => chooseDefinition(item)}
              >
                <span className={`provider-badge provider-badge--${item.id}`}>{item.badgeText}</span>
                <span className="provider-picker-copy">
                  <strong>{item.kind === 'web-search' ? '联网搜索' : item.name}</strong>
                  <small>{item.kind === 'web-search' ? 'Tavily、博查、智谱与 Exa' : item.description}</small>
                </span>
                <Icon icon="mdi:chevron-right" width="18" />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="provider-dialog-body">
            <section className="provider-config-section">
              <div className="provider-section-heading">
                <div>
                  <h4>连接信息</h4>
                  <p>{definition.description}</p>
                </div>
                {!editing && !isWebSearchProvider && (
                  <AnimatedButton
                    type="button"
                    className="provider-text-btn"
                    onClick={returnToDefinitionPicker}
                  >
                    更换厂商
                  </AnimatedButton>
                )}
              </div>

              {definition.id === 'custom-openai' && (
                <label className="provider-field">
                  <span>连接名称</span>
                  <input
                    type="text"
                    value={connectionName}
                    placeholder="例如：团队模型网关"
                    onChange={(event) => setConnectionName(event.target.value)}
                  />
                </label>
              )}

              {definition.authType === 'oauth' ? (
                <div className="provider-oauth-row">
                  <span className={`provider-connection-dot${dreaminaLoggedIn ? ' is-online' : ''}`} />
                  <div>
                    <strong>{dreaminaLoggedIn ? '即梦账号已登录' : '即梦账号未登录'}</strong>
                    <small>模型调用使用桌面端 OAuth 登录态</small>
                  </div>
                  <AnimatedButton
                    type="button"
                    className="provider-secondary-btn"
                    disabled={dreaminaLoading}
                    onClick={onDreaminaLogin}
                  >
                    {dreaminaLoading ? '处理中...' : dreaminaLoggedIn ? '重新登录' : 'OAuth 登录'}
                  </AnimatedButton>
                </div>
              ) : (
                <div className="provider-fields-grid">
                  {definition.credentials.map((field) => {
                    const value = field.key === 'apiKey'
                      ? apiKey
                      : field.key === 'baseUrl'
                        ? baseUrl
                        : anthropicUrl;
                    return (
                      <label key={field.key} className="provider-field">
                        <span>{field.label}{field.required ? ' *' : ''}</span>
                        <input
                          type={field.secret ? 'password' : 'text'}
                          value={value}
                          placeholder={field.placeholder}
                          onChange={(event) => {
                            if (field.key === 'apiKey') setApiKey(event.target.value);
                            else if (field.key === 'baseUrl') setBaseUrl(event.target.value);
                            else setAnthropicUrl(event.target.value);
                          }}
                        />
                      </label>
                    );
                  })}
                  {definition.id === 'runninghub-model' && (
                    <label className="provider-field">
                      <span>消费级-会员 API Key</span>
                      <input
                        type="password"
                        value={workflowApiKey}
                        placeholder="用于 RunningHub 工作流执行（可选）"
                        onChange={(event) => setWorkflowApiKey(event.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}

              {PROVIDER_LINKS[definition.id] && (
                <button
                  type="button"
                  className="provider-external-link"
                  onClick={() => void openExternal(PROVIDER_LINKS[definition.id])}
                >
                  <Icon icon="mdi:open-in-new" width="13" />
                  前往厂商控制台
                </button>
              )}

              {isWebSearchProvider && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <AnimatedButton
                    type="button"
                    className="provider-secondary-btn"
                    disabled={missingCredentials || catalogStatus === 'loading'}
                    onClick={() => void handleTestWebSearchConnection()}
                  >
                    <Icon
                      icon={catalogStatus === 'loading' ? 'mdi:loading' : 'mdi:connection'}
                      className={catalogStatus === 'loading' ? 'settings-spin' : undefined}
                      width="15"
                    />
                    {catalogStatus === 'loading' ? '验证中' : '验证连接'}
                  </AnimatedButton>
                  {catalogMessage && (
                    <div className={`provider-catalog-message is-${catalogStatus} m-0 flex-1`}>
                      <Icon
                        icon={catalogStatus === 'error' ? 'mdi:alert-circle-outline' : 'mdi:information-outline'}
                        width="14"
                      />
                      <span>{catalogMessage}</span>
                    </div>
                  )}
                </div>
              )}
            </section>

            {isWebSearchProvider && (
              <section className="provider-model-section">
                <div className="provider-section-heading">
                  <div>
                    <h4>搜索厂商</h4>
                    <p>选择当前使用的服务，其他厂商密钥会保留在本地</p>
                  </div>
                </div>
                <div className="provider-picker-grid">
                  {webSearchDefinitions.map((item) => {
                    const selected = item.id === definition.id;
                    const configured = Boolean(providerConfigs[item.id]?.apiKey?.trim());
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={selected}
                        className={`provider-picker-item ${selected ? 'ring-1 ring-indigo-400/60 bg-indigo-500/10' : ''}`}
                        onClick={() => chooseDefinition(item)}
                      >
                        <span className={`provider-badge provider-badge--${item.id}`}>{item.badgeText}</span>
                        <span className="provider-picker-copy">
                          <strong>{item.name}</strong>
                          <small>{configured ? 'API Key 已配置' : item.description}</small>
                        </span>
                        <Icon icon={selected ? 'mdi:check-circle' : 'mdi:chevron-right'} width="18" />
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {!isWebSearchProvider && <section className="provider-model-section">
              <div className="provider-section-heading provider-model-heading">
                <div>
                  <h4>启用模型</h4>
                  <p>仅勾选会在应用中使用的模型</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {definition.id === 'custom-openai' ? (
                    <>
                      {protocolImportSnapshot ? (
                        <AnimatedButton
                          type="button"
                          className="provider-text-btn h-7"
                          onClick={undoProtocolImport}
                        >
                          <Icon icon="mdi:undo-variant" width="14" />
                          撤销导入
                        </AnimatedButton>
                      ) : null}
                      <AnimatedButton
                        type="button"
                        className="provider-secondary-btn h-7"
                        aria-expanded={protocolImportOpen}
                        onClick={() => setProtocolImportOpen((open) => !open)}
                      >
                        <Icon icon="mdi:file-import-outline" width="14" />
                        导入文档
                      </AnimatedButton>
                    </>
                  ) : null}
                  <AnimatedButton
                    type="button"
                    className="provider-fetch-btn"
                    disabled={missingCredentials || catalogStatus === 'loading'}
                    onClick={() => void handleFetchModels()}
                  >
                    <Icon
                      icon={catalogStatus === 'loading' ? 'mdi:loading' : 'mdi:cloud-download-outline'}
                      className={catalogStatus === 'loading' ? 'settings-spin' : undefined}
                      width="15"
                    />
                    {catalogStatus === 'loading' ? '拉取中' : '拉取模型'}
                  </AnimatedButton>
                </div>
              </div>

              {definition.id === 'custom-openai' && protocolImportOpen ? (
                <ProtocolImportPanel
                  onApply={applyProtocolImport}
                  onClose={() => setProtocolImportOpen(false)}
                />
              ) : null}

              <div className="mb-3 flex min-h-8 items-center justify-between gap-3 rounded-md border border-canvas-border bg-white/[0.03] px-2.5 py-1.5">
                <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-canvas-text-secondary">
                  <Icon icon="mdi:eye-outline" width="14" />
                  节点列表显示
                </span>
                <div className="flex min-w-0 flex-wrap justify-end gap-1" role="group" aria-label="节点列表显示分类">
                  <button
                    type="button"
                    aria-pressed={visibleModelCategories.size === CATEGORY_ORDER.length}
                    className={`provider-category-choice is-all h-6 rounded px-2 text-[9px] ${
                      visibleModelCategories.size === CATEGORY_ORDER.length ? 'is-active' : ''
                    }`}
                    onClick={toggleAllVisibleCategories}
                  >
                    全部
                  </button>
                  {CATEGORY_ORDER.map((item) => (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={visibleModelCategories.has(item)}
                      className={`provider-category-choice is-${item} h-6 rounded px-2 text-[9px] ${
                        visibleModelCategories.has(item) ? 'is-active' : ''
                      }`}
                      onClick={() => toggleVisibleCategory(item)}
                    >
                      {CATEGORY_LABELS[item]}
                    </button>
                  ))}
                </div>
              </div>

              {catalogMessage && (
                <div className={`provider-catalog-message is-${catalogStatus}`}>
                  <Icon
                    icon={catalogStatus === 'error' ? 'mdi:alert-circle-outline' : 'mdi:information-outline'}
                    width="14"
                  />
                  <span>{catalogMessage}</span>
                </div>
              )}

              {models.length > 0 && (
                <>
                  <div className="provider-model-toolbar">
                    <label className="provider-search">
                      <Icon icon="mdi:magnify" width="15" />
                      <input
                        type="search"
                        value={query}
                        placeholder="搜索模型 ID 或名称"
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                    <div className="provider-category-tabs" aria-label="模型类别">
                      <button
                        type="button"
                        aria-pressed={category === 'all'}
                        className={`provider-category-choice is-all ${category === 'all' ? 'is-active' : ''}`}
                        onClick={() => setCategory('all')}
                      >
                        全部
                      </button>
                      {CATEGORY_ORDER.map((item) => (
                        <button
                          key={item}
                          type="button"
                          aria-pressed={category === item}
                          className={`provider-category-choice is-${item} ${category === item ? 'is-active' : ''}`}
                          onClick={() => setCategory(item)}
                        >
                          {CATEGORY_LABELS[item]}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="provider-model-list-head">
                    <label>
                      <input
                        type="checkbox"
                        checked={filteredModels.length > 0 && filteredModels.every((model) => selectedIds.has(model.id))}
                        onChange={toggleVisibleModels}
                      />
                      <span>选择当前结果</span>
                    </label>
                    <span>{selectedModels.length} 个已选</span>
                  </div>

                  <div className="provider-model-list">
                    {filteredModels.length > 0 ? filteredModels.map((model) => (
                      <div key={model.id} className="provider-model-row">
                        <label className="provider-model-select">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(model.id)}
                            onChange={() => toggleModel(model.id)}
                          />
                          <span className={`provider-model-kind is-${model.category}`}>
                            {CATEGORY_LABELS[model.category]}
                          </span>
                          <span className="provider-model-copy">
                            <strong>{model.name}</strong>
                            <small>{model.id}</small>
                          </span>
                        </label>
                        {definition.id === 'custom-openai' && selectedIds.has(model.id) ? (
                            <AnimatedButton
                              type="button"
                              className={`provider-model-protocol-btn ${model.executionProfile ? 'is-configured' : ''}`}
                              aria-label={`配置 ${model.name} 调用协议`}
                              title="调用协议"
                              onClick={() => {
                                setProtocolModelId(model.id);
                                setProtocolValid(true);
                              }}
                            >
                              <Icon icon="mdi:tune-variant" width="15" />
                            </AnimatedButton>
                          ) : null}
                      </div>
                    )) : (
                      <div className="provider-model-empty">没有匹配的模型</div>
                    )}
                  </div>

                  {definition.id === 'custom-openai'
                    && protocolModel
                    && selectedIds.has(protocolModel.id) ? (
                      <ModelProtocolEditor
                        key={protocolModel.id}
                        model={protocolModel}
                        onChange={(profile) => updateModelProtocol(protocolModel.id, profile)}
                        onValidityChange={setProtocolValid}
                        onClose={closeProtocolEditor}
                      />
                    ) : null}
                </>
              )}

              {definition.id === 'custom-openai' && (
                <div className="provider-manual-model">
                  <div className="provider-manual-fields">
                    <input
                      type="text"
                      value={manualModelId}
                      placeholder="手动输入模型 ID"
                      onChange={(event) => setManualModelId(event.target.value)}
                    />
                    <input
                      type="text"
                      value={manualModelName}
                      placeholder="显示名称（可选）"
                      onChange={(event) => setManualModelName(event.target.value)}
                    />
                    <select
                      value={manualCategory}
                      onChange={(event) => setManualCategory(event.target.value as GeneralModelCategory)}
                    >
                      {CATEGORY_ORDER.map((item) => (
                        <option key={item} value={item}>{CATEGORY_LABELS[item]}</option>
                      ))}
                    </select>
                    <AnimatedButton
                      type="button"
                      className="provider-icon-btn"
                      aria-label="添加手动模型"
                      disabled={!manualModelId.trim()}
                      onClick={addManualModel}
                    >
                      <Icon icon="mdi:plus" width="17" />
                    </AnimatedButton>
                  </div>
                </div>
              )}
            </section>}
          </div>

          <footer className="provider-dialog-footer">
            <span>
              {isWebSearchProvider
                ? `当前使用 ${definition.name}`
                : selectedModels.length > 0
                  ? `将启用 ${selectedModels.length} 个模型`
                  : '至少选择一个模型'}
            </span>
            <div>
              <AnimatedButton type="button" className="provider-secondary-btn" onClick={closeDialog}>
                取消
              </AnimatedButton>
              <AnimatedButton
                type="button"
                className="provider-primary-btn"
                disabled={
                  missingCredentials
                  || (!isWebSearchProvider && selectedModels.length === 0)
                  || !protocolValid
                }
                onClick={() => void handleSave()}
              >
                {editing ? '保存更改' : '添加厂商'}
              </AnimatedButton>
            </div>
          </footer>
        </>
      )}
    </ModalOverlay>,
    document.body,
  );
}
