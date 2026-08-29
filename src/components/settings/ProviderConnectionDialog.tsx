/**
 * ProviderConnectionDialog — add/edit one provider connection and choose its enabled models.
 *
 * 本组件只负责弹窗级状态与编排：凭证、模型清单、协议导入快照和各区块的联动。
 * 连接信息、联网搜索切换、模型清单三个区块分别拆到 ./providerConnection/* 子组件。
 */
import { Icon } from '@iconify/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  GeneralModelCategory,
  ImageReferenceRequestMode,
  ProviderModelSelection,
} from '../../types';
import type { VideoModelCapability } from '../../types/aiTypes';
import {
  capCatalogModels,
  createConnectionId,
  fetchProviderModelCatalog,
  getProviderDefinition,
  getProviderDefinitions,
  getWebSearchProviderDefinitions,
  type ProviderDefinition,
} from '../../services/ai/providerCatalogService';
import { normalizeBaseUrl } from '../../services/ai/providerBaseUrl';
import type { ModelProtocolImportResult } from '../../services/ai/modelProtocolImport';
import { emitCloseChatWindow } from '../../services/chat/chatWindowService';
import { testProviderConnection } from '../../services/testConnection';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import AnimatedButton from '../shared/AnimatedButton';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import ProviderConnectionForm from './providerConnection/ProviderConnectionForm';
import ProviderModelSection from './providerConnection/ProviderModelSection';
import ProviderWebSearchPicker from './providerConnection/ProviderWebSearchPicker';
import {
  assertProviderModelsVideoCapabilities,
  mergeModels,
} from './providerConnection/providerConnectionModels';
import {
  CATEGORY_ORDER,
  buildRelayAssistantPrompt,
  type CatalogStatus,
  type ProtocolImportSnapshot,
  type ProviderConnectionDialogProps,
} from './providerConnection/providerConnectionShared';

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
  const t = useT();
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
    initialCatalogModels.length > 0 ? t('已加载本地缓存 {count} 个模型', { count: initialCatalogModels.length }) : '',
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<GeneralModelCategory | 'all'>('all');
  const [visibleModelCategories, setVisibleModelCategories] = useState(
    () => new Set(initialConfig?.visibleModelCategories ?? CATEGORY_ORDER),
  );
  const [manualModelId, setManualModelId] = useState('');
  const [manualModelName, setManualModelName] = useState('');
  const [manualCategory, setManualCategory] = useState<GeneralModelCategory>('text');
  const [videoCapabilityModelId, setVideoCapabilityModelId] = useState<string | null>(null);
  const [protocolModelId, setProtocolModelId] = useState<string | null>(null);
  const [protocolValid, setProtocolValid] = useState(true);
  const [protocolImportOpen, setProtocolImportOpen] = useState(false);
  const [protocolImportSnapshot, setProtocolImportSnapshot] = useState<ProtocolImportSnapshot | null>(null);
  const [categoryEditModelId, setCategoryEditModelId] = useState<string | null>(null);
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
  const videoCapabilityModel = useMemo(
    () => models.find((model) => model.id === videoCapabilityModelId),
    [models, videoCapabilityModelId],
  );

  /**
   * 新建自定义连接时，若接口地址和已有连接重合，多半是忘了自己加过。
   * Agent 那条路会按 Base URL 并进已有连接，手动添加不便直接改写用户填的模型清单，
   * 所以只提示，由用户决定是新建还是回去编辑。
   */
  const duplicateConnectionName = useMemo(() => {
    if (editing || definition?.id !== 'custom-openai') return '';
    const target = normalizeBaseUrl(baseUrl);
    if (!target) return '';
    const match = Object.values(providerConfigs).find((item) => (
      item.catalogId === 'custom-openai' && normalizeBaseUrl(item.baseUrl) === target
    ));
    return match?.name?.trim() || '';
  }, [baseUrl, definition, editing, providerConfigs]);

  const missingCredentials = useMemo(() => {
    if (!definition) return true;
    if (definition.authType === 'oauth') return !dreaminaLoggedIn;
    if (!apiKey.trim()) return true;
    return definition.credentials.some(
      (field) => field.required && field.key === 'baseUrl' && !baseUrl.trim(),
    );
  }, [apiKey, baseUrl, definition, dreaminaLoggedIn]);

  const chooseDefinition = (nextDefinition: ProviderDefinition) => {
    const savedConfig = nextDefinition.kind === 'web-search'
      ? providerConfigs[nextDefinition.id]
      : undefined;
    setDefinitionId(nextDefinition.id);
    setConnectionName(savedConfig?.name || nextDefinition.name);
    setApiKey(savedConfig?.apiKey || '');
    setBaseUrl(savedConfig?.baseUrl || nextDefinition.defaultBaseUrl || '');
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
    setVideoCapabilityModelId(null);
    setProtocolModelId(null);
    setProtocolValid(true);
    setProtocolImportOpen(false);
    setProtocolImportSnapshot(null);
    setCategoryEditModelId(null);
  };

  /**
   * 探测补出的接口地址与用户填的不一致时回写输入框，返回更正后的地址。
   * 输入框为空说明走的是厂商默认地址，没什么可更正的，也不该把默认值钉进配置。
   */
  const adoptResolvedBaseUrl = (resolved: string | undefined): string | undefined => {
    const current = normalizeBaseUrl(baseUrl);
    if (!resolved || !current || resolved === current) return undefined;
    setBaseUrl(resolved);
    return resolved;
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
        if (!result.success) throw new Error(result.error || t('RunningHub API Key 验证失败'));
      }
      const result = await fetchProviderModelCatalog({
        providerId: definition.id,
        config: {
          name: connectionName.trim() || definition.name,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
          catalogId: definition.id,
        },
        fallbackModels: fallbackModels[definition.id] || [],
        signal: controller.signal,
      });
      setModels((current) => mergeModels(current, result.models));
      setCatalogStatus(result.warning ? 'warning' : 'ready');
      const corrected = adoptResolvedBaseUrl(result.resolvedBaseUrl);
      setCatalogMessage(
        result.warning
        || (corrected
          ? t('已获取 {count} 个模型，接口地址已更正为 {url}', {
            count: result.models.length,
            url: corrected,
          })
          : t('已获取 {count} 个模型', { count: result.models.length })),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setCatalogStatus('error');
      setCatalogMessage(error instanceof Error ? error.message : t('模型列表拉取失败'));
    }
  };

  const handleAssistantAdd = async () => {
    const store = useAppStore.getState();
    if (store.chatPanelDetached) await emitCloseChatWindow();
    store.openChatWithDraft(
      buildRelayAssistantPrompt(connectionName.trim(), normalizeBaseUrl(baseUrl)),
    );
  };

  const handleTestConnection = async () => {
    if (!definition || missingCredentials) return;
    setCatalogStatus('loading');
    setCatalogMessage(t('正在验证 {name} 连接...', { name: definition.name }));
    const result = await testProviderConnection(
      definition.id,
      apiKey.trim(),
      baseUrl.trim() || undefined,
    );
    if (result.success) {
      const corrected = adoptResolvedBaseUrl(result.baseUrl);
      setCatalogStatus('ready');
      setCatalogMessage([
        t('{name} 连接验证成功', { name: definition.name }),
        result.balance,
        corrected && t('接口地址已更正为 {url}', { url: corrected }),
      ].filter(Boolean).join('，'));
      return;
    }
    setCatalogStatus(result.unsupported ? 'warning' : 'error');
    setCatalogMessage(result.error || t('{name} 连接验证失败', { name: definition.name }));
  };

  const closeProtocolEditor = () => {
    setProtocolModelId(null);
    setProtocolValid(true);
  };

  const toggleModel = (modelId: string) => {
    if (selectedIds.has(modelId) && protocolModelId === modelId) closeProtocolEditor();
    if (selectedIds.has(modelId) && videoCapabilityModelId === modelId) {
      setVideoCapabilityModelId(null);
    }
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
    if (
      allVisibleSelected
      && videoCapabilityModelId
      && filteredModels.some((model) => model.id === videoCapabilityModelId)
    ) {
      setVideoCapabilityModelId(null);
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
      categoryManual: true,
    };
    setModels((current) => mergeModels(current, [model]));
    setSelectedIds((current) => new Set(current).add(id));
    setManualModelId('');
    setManualModelName('');
  };

  const updateModelCategory = (modelId: string, nextCategory: GeneralModelCategory) => {
    setModels((current) => current.map((model) =>
      model.id === modelId ? {
        ...model,
        category: nextCategory,
        categoryManual: true,
        ...(nextCategory === 'video' ? {} : { videoCapability: undefined }),
      } : model,
    ));
    if (nextCategory !== 'video' && videoCapabilityModelId === modelId) {
      setVideoCapabilityModelId(null);
    }
    setVisibleModelCategories((current) => new Set(current).add(nextCategory));
    setCategoryEditModelId(null);
  };

  /** 0 / 空 表示不声明，交回给按模型 ID 猜目录的兜底逻辑。 */
  const updateModelContextWindow = (modelId: string, raw: string) => {
    const parsed = Number.parseInt(raw.replace(/[^\d]/g, ''), 10);
    const contextWindow = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    setModels((current) => current.map((model) => (
      model.id === modelId ? { ...model, contextWindow } : model
    )));
  };

  const updateModelDescription = (modelId: string, description: string) => {
    setModels((current) => current.map((model) => (
      model.id === modelId
        ? { ...model, description: description.slice(0, 500), descriptionManual: true }
        : model
    )));
  };

  const updateModelVisionCapability = (modelId: string, enabled: boolean) => {
    setModels((current) => current.map((model) => model.id === modelId
      ? {
          ...model,
          inputModalities: enabled ? ['text', 'image'] : ['text'],
          inputModalitiesManual: true,
        }
      : model));
  };

  const updateModelProtocol = (
    modelId: string,
    executionProfile: ProviderModelSelection['executionProfile'],
  ) => {
    setModels((current) => current.map((model) =>
      model.id === modelId ? { ...model, executionProfile } : model,
    ));
  };

  const updateVideoCapability = (
    modelId: string,
    videoCapability: VideoModelCapability | undefined,
  ) => {
    setModels((current) => current.map((model) => (
      model.id === modelId ? { ...model, videoCapability } : model
    )));
  };

  const updateImageReferenceRequestMode = (
    modelId: string,
    imageReferenceRequestMode: ImageReferenceRequestMode,
  ) => {
    setModels((current) => current.map((model) =>
      model.id === modelId ? { ...model, imageReferenceRequestMode } : model,
    ));
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
      categoryManual: true,
    };
    setBaseUrl(result.baseUrl);
    setModels((current) => {
      const existing = current.find((model) => model.id === modelId);
      if (!existing) return [...current, importedModel];
      return current.map((model) => model.id === modelId
        ? { ...model, category: importedModel.category, executionProfile: importedModel.executionProfile, categoryManual: true }
        : model);
    });
    setSelectedIds((current) => new Set(current).add(modelId));
    setVisibleModelCategories((current) => new Set(current).add(importedModel.category));
    setCategory('all');
    setProtocolModelId(modelId);
    setProtocolValid(true);
    setCatalogStatus('ready');
    setCatalogMessage(t('已从接口文档导入模型 {id}，保存前可继续检查调用协议', { id: modelId }));
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
    try {
      assertProviderModelsVideoCapabilities(selectedModels);
    } catch (error) {
      setCatalogStatus('error');
      setCatalogMessage(error instanceof Error ? error.message : t('视频能力配置无效'));
      return;
    }
    const nextConnectionId = isWebSearchProvider
      ? definition.id
      : connectionId || createConnectionId(definition.id);
    const modelConfig = isWebSearchProvider
      ? {}
      : {
          selectedModels: selectedModels.map((model) => ({ ...model, provider: nextConnectionId })),
          catalogModels: capCatalogModels(models, selectedIds)
            .map((model) => ({ ...model, provider: nextConnectionId })),
          visibleModelCategories: CATEGORY_ORDER.filter((item) => visibleModelCategories.has(item)),
          catalogUpdatedAt: Date.now(),
        };
    await onSave(
      nextConnectionId,
      {
        name: connectionName.trim() || definition.name,
        apiKey: definition.authType === 'oauth' ? '' : apiKey.trim(),
        baseUrl: normalizeBaseUrl(baseUrl) || undefined,
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
      ariaLabel={editing ? t('编辑 API 厂商') : t('添加 API 厂商')}
      className="provider-dialog"
      closeOnBackdrop={false}
    >
      <header className="provider-dialog-header">
        <div>
          <span className="provider-dialog-kicker">{editing ? t('编辑连接') : t('新建连接')}</span>
          <h3>{isWebSearchProvider ? t('联网搜索') : definition ? definition.name : t('选择 API 厂商')}</h3>
        </div>
        <div className="flex items-center gap-2">
          {definition?.id === 'custom-openai' && (
            <AnimatedButton
              type="button"
              className="provider-secondary-btn h-7"
              onClick={() => void handleAssistantAdd()}
            >
              <Icon icon="mdi:message-processing-outline" width="14" />
              {t('调用助手添加')}
            </AnimatedButton>
          )}
          <PopupCloseButton onClick={closeDialog} />
        </div>
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
                  <strong>{item.kind === 'web-search' ? t('联网搜索') : item.name}</strong>
                  <small>{item.kind === 'web-search' ? t('Tavily、博查、智谱与 Exa') : item.description}</small>
                </span>
                <Icon icon="mdi:chevron-right" width="18" />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="provider-dialog-body">
            <ProviderConnectionForm
              editing={editing}
              definition={definition}
              isWebSearchProvider={isWebSearchProvider}
              connectionName={connectionName}
              setConnectionName={setConnectionName}
              apiKey={apiKey}
              setApiKey={setApiKey}
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
              workflowApiKey={workflowApiKey}
              setWorkflowApiKey={setWorkflowApiKey}
              dreaminaLoggedIn={dreaminaLoggedIn}
              dreaminaLoading={dreaminaLoading}
              onDreaminaLogin={onDreaminaLogin}
              duplicateConnectionName={duplicateConnectionName}
              catalogStatus={catalogStatus}
              catalogMessage={catalogMessage}
              missingCredentials={missingCredentials}
              onReturnToPicker={returnToDefinitionPicker}
              onTestConnection={handleTestConnection}
            />

            {isWebSearchProvider && (
              <ProviderWebSearchPicker
                definitions={webSearchDefinitions}
                providerConfigs={providerConfigs}
                currentDefinition={definition}
                onChoose={chooseDefinition}
              />
            )}

            {!isWebSearchProvider && (
              <ProviderModelSection
                definition={definition}
                models={models}
                filteredModels={filteredModels}
                selectedModels={selectedModels}
                selectedIds={selectedIds}
                query={query}
                setQuery={setQuery}
                category={category}
                setCategory={setCategory}
                visibleModelCategories={visibleModelCategories}
                catalogStatus={catalogStatus}
                catalogMessage={catalogMessage}
                missingCredentials={missingCredentials}
                apiKey={apiKey}
                baseUrl={baseUrl}
                setProtocolValid={setProtocolValid}
                protocolImportOpen={protocolImportOpen}
                setProtocolImportOpen={setProtocolImportOpen}
                protocolImportSnapshot={protocolImportSnapshot}
                protocolModel={protocolModel}
                videoCapabilityModel={videoCapabilityModel}
                setProtocolModelId={setProtocolModelId}
                setVideoCapabilityModelId={setVideoCapabilityModelId}
                categoryEditModelId={categoryEditModelId}
                setCategoryEditModelId={setCategoryEditModelId}
                manualModelId={manualModelId}
                setManualModelId={setManualModelId}
                manualModelName={manualModelName}
                setManualModelName={setManualModelName}
                manualCategory={manualCategory}
                setManualCategory={setManualCategory}
                onToggleModel={toggleModel}
                onToggleVisibleModels={toggleVisibleModels}
                onToggleVisibleCategory={toggleVisibleCategory}
                onToggleAllVisibleCategories={toggleAllVisibleCategories}
                onAddManualModel={addManualModel}
                onUpdateModelCategory={updateModelCategory}
                onUpdateModelContextWindow={updateModelContextWindow}
                onUpdateModelDescription={updateModelDescription}
                onUpdateModelVisionCapability={updateModelVisionCapability}
                onUpdateModelProtocol={updateModelProtocol}
                onUpdateVideoCapability={updateVideoCapability}
                onUpdateImageReferenceRequestMode={updateImageReferenceRequestMode}
                onCloseProtocolEditor={closeProtocolEditor}
                onApplyProtocolImport={applyProtocolImport}
                onUndoProtocolImport={undoProtocolImport}
                onFetchModels={handleFetchModels}
              />
            )}
          </div>

          <footer className="provider-dialog-footer">
            <span>
              {isWebSearchProvider
                ? `当前使用 ${definition.name}`
                : selectedModels.length > 0
                  ? t('将启用 {count} 个模型', { count: selectedModels.length })
                  : t('至少选择一个模型')}
            </span>
            <div>
              <AnimatedButton type="button" className="provider-secondary-btn" onClick={closeDialog}>
                {t('取消')}
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
                {editing ? t('保存更改') : t('添加厂商')}
              </AnimatedButton>
            </div>
          </footer>
        </>
      )}
    </ModalOverlay>,
    document.body,
  );
}
