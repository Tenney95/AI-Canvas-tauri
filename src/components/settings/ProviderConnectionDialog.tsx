/**
 * ProviderConnectionDialog — add/edit one provider connection and choose its enabled models.
 *
 * 本组件只负责弹窗级状态与编排：凭证、模型清单和各区块的联动。
 * 连接信息、联网搜索切换、模型清单三个区块分别拆到 ./providerConnection/* 子组件。
 */
import { Icon } from '@iconify/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ApiProviderConfig,
  ChatApiProtocol,
  GeneralModelCategory,
  ImageReferenceRequestMode,
  ProviderModelSelection,
} from '../../types';
import type { VolcengineAssetLibraryConfig } from '../../types/volcengineAssetLibrary';
import { resolveChatApiProtocol } from '../../services/ai/chatApiProtocol';
import {
  applySeedanceTemplateDefaults,
  inferSeedanceModelVariant,
} from '../../services/ai/seedanceModelCapabilities';
import {
  applyH3TemplateDefaults,
  inferH3ModelVariant,
} from '../../services/ai/h3ModelCapabilities';
import type { ImageModelCapability, VideoModelCapability } from '../../types/aiTypes';
import { createImageQuickAdaptTemplate } from '../../services/ai/imageModelTemplates';
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
import { emitCloseChatWindow } from '../../services/chat/chatWindowService';
import { testProviderConnection } from '../../services/testConnection';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import AnimatedButton from '../shared/AnimatedButton';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import ProviderConnectionForm, { CccGroupConnectionsForm } from './providerConnection/ProviderConnectionForm';
import ProviderModelSection from './providerConnection/ProviderModelSection';
import ProviderWorkflowSection from './providerConnection/ProviderWorkflowSection';
import type { WorkflowApiDraft } from '../../types/workflowApi';
import { normalizeWorkflowApiBaseUrl } from '../../services/workflowApi/autodlWorkflowManifest';
import { editableWorkflowApiManifest, validateDeclarativeWorkflowManifest } from '../../services/workflowApi/workflowApiDefinition';
import ProviderWebSearchPicker from './providerConnection/ProviderWebSearchPicker';
import VolcengineAssetLibrarySettings from '../volcengine/VolcengineAssetLibrarySettings';
import {
  assertProviderModelsVideoCapabilities,
  materializeLegacyImageProtocolDefault,
  mergeModels,
} from './providerConnection/providerConnectionModels';
import {
  CATEGORY_ORDER,
  buildRelayAssistantPrompt,
  type CatalogStatus,
  type ProviderConnectionDialogProps,
} from './providerConnection/providerConnectionShared';

function applyKnownVideoTemplateDefaults(
  model: ProviderModelSelection,
  baseUrl?: string,
): ProviderModelSelection {
  return applyH3TemplateDefaults(applySeedanceTemplateDefaults(model, baseUrl), baseUrl);
}

export default function ProviderConnectionDialog({
  isOpen,
  connectionId,
  initialConfig,
  initialModelId,
  providerConfigs,
  connectedProviderIds,
  fallbackModels,
  dreaminaLoggedIn,
  dreaminaLoading,
  runninghubWorkflowApiKey = '',
  onDreaminaLogin,
  onClose,
  onSave,
  onSaveCccGroups,
  onCopyCccGroup,
  onRemoveCccGroup,
}: ProviderConnectionDialogProps & {
  onSaveCccGroups: (connections: Record<string, ApiProviderConfig>) => Promise<void>;
  onCopyCccGroup?: (connectionId: string) => Promise<void>;
  onRemoveCccGroup?: (connectionId: string) => Promise<boolean>;
}) {
  const t = useT();
  const editing = !!connectionId && !!initialConfig;
  const initialDefinitionId = initialConfig?.catalogId || connectionId || '';
  const initialDefinition = getProviderDefinition(initialDefinitionId, initialConfig);
  // Preserve settings saved by the short-lived connection-default UI as explicit
  // model settings when this connection is edited and saved again.
  const initialSelectedModels = materializeLegacyImageProtocolDefault(
    initialConfig?.selectedModels || [], initialConfig,
  );
  const initialModel = initialDefinition?.id === 'custom-openai'
    ? initialSelectedModels.find((model) => model.id === initialModelId)
    : undefined;
  const initialCatalogModels = initialConfig?.catalogModels || [];
  const initialLocalModels = initialDefinition ? (fallbackModels[initialDefinition.id] || []) : [];
  const initialBaseUrl = initialConfig?.baseUrl || initialDefinition?.defaultBaseUrl || '';
  const [definitionId, setDefinitionId] = useState(initialDefinitionId);
  const [connectionName, setConnectionName] = useState(initialConfig?.name || initialDefinition?.name || '');
  const [chatApiProtocol, setChatApiProtocol] = useState<ChatApiProtocol>(
    () => resolveChatApiProtocol(initialConfig?.chatApiProtocol),
  );
  const [apiKey, setApiKey] = useState(initialConfig?.apiKey || '');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [assetLibraryConfig, setAssetLibraryConfig] = useState<VolcengineAssetLibraryConfig | undefined>(initialConfig?.assetLibrary);
  const [workflowApiKey, setWorkflowApiKey] = useState(runninghubWorkflowApiKey);
  const [workflowDrafts, setWorkflowDrafts] = useState<WorkflowApiDraft[]>(() =>
    useAppStore.getState().workflows.filter((workflow) => workflow.adapterType === 'workflow-api' && workflow.workflowApi?.connectionId === connectionId)
      .map((workflow) => ({ id: workflow.id, name: workflow.name, manifest: editableWorkflowApiManifest(workflow.workflowApi!) })));
  const [workflowValid, setWorkflowValid] = useState(false);
  const [models, setModels] = useState<ProviderModelSelection[]>(
    () => mergeModels(mergeModels(initialLocalModels, initialCatalogModels), initialSelectedModels)
      .map((model) => applyKnownVideoTemplateDefaults(model, initialBaseUrl)),
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
  const [imageCapabilityModelId, setImageCapabilityModelId] = useState<string | null>(
    () => initialModel?.category === 'image' ? initialModel.id : null,
  );
  const [videoCapabilityModelId, setVideoCapabilityModelId] = useState<string | null>(
    () => initialModel?.category === 'video' ? initialModel.id : null,
  );
  const [protocolModelId, setProtocolModelId] = useState<string | null>(
    () => initialModel && initialModel.category !== 'image' && initialModel.category !== 'video' ? initialModel.id : null,
  );
  const [protocolValid, setProtocolValid] = useState(true);
  const [categoryEditModelId, setCategoryEditModelId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const definition = getProviderDefinition(definitionId);
  const definitions = getProviderDefinitions();
  const webSearchDefinitions = getWebSearchProviderDefinitions();
  const isWebSearchProvider = definition?.kind === 'web-search';
  const isWorkflowApi = definition?.kind === 'workflow-api';
  const hasWebSearchConnection = webSearchDefinitions.some((item) =>
    Boolean(providerConfigs[item.id]?.apiKey?.trim()),
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  const availableDefinitions = definitions.filter((item) => {
    if (item.kind === 'web-search') {
      return item.id === 'tavily' && (!hasWebSearchConnection || isWebSearchProvider);
    }
    return item.id === 'custom-openai'
      || item.id === 'cccapi'
      || item.kind === 'workflow-api'
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
  const imageCapabilityModel = useMemo(
    () => models.find((model) => model.id === imageCapabilityModelId), [models, imageCapabilityModelId],
  );
  const videoCapabilityModel = useMemo(
    () => models.find((model) => model.id === videoCapabilityModelId),
    [models, videoCapabilityModelId],
  );

  /**
   * 新建自定义连接时，若接口地址和对话协议都与已有连接重合，多半是忘了自己加过。
   * Agent 那条路会按 Base URL + 协议并进已有连接，手动添加不便直接改写用户填的模型清单，
   * 所以只提示，由用户决定是新建还是回去编辑。
   */
  const duplicateConnectionName = useMemo(() => {
    if (editing || definition?.id !== 'custom-openai') return '';
    const target = normalizeBaseUrl(baseUrl, chatApiProtocol);
    if (!target) return '';
    const match = Object.values(providerConfigs).find((item) => (
      item.catalogId === 'custom-openai'
      && resolveChatApiProtocol(item.chatApiProtocol) === chatApiProtocol
      && normalizeBaseUrl(item.baseUrl, chatApiProtocol) === target
    ));
    return match?.name?.trim() || '';
  }, [baseUrl, chatApiProtocol, definition, editing, providerConfigs]);

  const missingCredentials = useMemo(() => {
    if (!definition) return true;
    if (definition.kind === 'workflow-api') return !baseUrl.trim();
    if (definition.authType === 'oauth') return !dreaminaLoggedIn;
    if (definition.id === 'runninghub-model') return !apiKey.trim() && !workflowApiKey.trim();
    if (!apiKey.trim()) return true;
    return definition.credentials.some(
      (field) => field.required && field.key === 'baseUrl' && !baseUrl.trim(),
    );
  }, [apiKey, baseUrl, definition, dreaminaLoggedIn, workflowApiKey]);
  const workflowOnlyConnection = definition?.id === 'runninghub-model' && !!workflowApiKey.trim() && !apiKey.trim();

  const chooseDefinition = (nextDefinition: ProviderDefinition) => {
    abortRef.current?.abort();
    const savedConfig = nextDefinition.kind === 'web-search'
      ? providerConfigs[nextDefinition.id]
      : undefined;
    setDefinitionId(nextDefinition.id);
    setConnectionName(savedConfig?.name || nextDefinition.name);
    setChatApiProtocol(resolveChatApiProtocol(savedConfig?.chatApiProtocol));
    setApiKey(savedConfig?.apiKey || '');
    setBaseUrl(savedConfig?.baseUrl || nextDefinition.defaultBaseUrl || '');
    setAssetLibraryConfig(savedConfig?.assetLibrary);
    setWorkflowApiKey('');
    const localModels = nextDefinition.id === 'cccapi' ? [] : fallbackModels[nextDefinition.id] || [];
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
    setCategoryEditModelId(null);
  };

  /**
   * 探测补出的接口地址与用户填的不一致时回写输入框，返回更正后的地址。
   * 输入框为空说明走的是厂商默认地址，没什么可更正的，也不该把默认值钉进配置。
   */
  const adoptResolvedBaseUrl = (resolved: string | undefined): string | undefined => {
    const current = normalizeBaseUrl(baseUrl, chatApiProtocol);
    if (!resolved || !current || resolved === current) return undefined;
    setBaseUrl(resolved);
    return resolved;
  };

  const handleFetchModels = async () => {
    if (!definition || missingCredentials) return;
    if (workflowOnlyConnection) { setCatalogStatus('warning'); setCatalogMessage('当前只配置工作流连接，可直接保存；获取模型目录需要模型 API Key'); return; }
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
          chatApiProtocol,
        },
        fallbackModels: fallbackModels[definition.id] || [],
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const resolvedBaseUrl = result.resolvedBaseUrl || baseUrl;
      const remoteIds = new Set(result.models.map((model) => model.id));
      setModels((current) => mergeModels(
        definition.id === 'cccapi' ? current.filter((model) => remoteIds.has(model.id)) : current,
        result.models,
      )
        .map((model) => applyKnownVideoTemplateDefaults(model, resolvedBaseUrl)));
      if (definition.id === 'cccapi') {
        setSelectedIds((current) => new Set([...current].filter((id) => remoteIds.has(id))));
        if (protocolModelId && !remoteIds.has(protocolModelId)) {
          setProtocolModelId(null);
          setProtocolValid(true);
        }
        if (videoCapabilityModelId && !remoteIds.has(videoCapabilityModelId)) setVideoCapabilityModelId(null);
        if (categoryEditModelId && !remoteIds.has(categoryEditModelId)) setCategoryEditModelId(null);
      }
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
      if (controller.signal.aborted || error instanceof DOMException && error.name === 'AbortError') return;
      setCatalogStatus('error');
      setCatalogMessage(error instanceof Error ? error.message : t('模型列表拉取失败'));
    }
  };

  const handleAssistantAdd = async () => {
    const store = useAppStore.getState();
    if (store.chatPanelDetached) await emitCloseChatWindow();
    store.openChatWithDraft(
      buildRelayAssistantPrompt(
        connectionName.trim(),
        normalizeBaseUrl(baseUrl, chatApiProtocol),
        chatApiProtocol,
      ),
    );
  };

  const handleTestConnection = async () => {
    if (!definition || missingCredentials) return;
    if (definition.id === 'cccapi') {
      // 用该 Key 的模型目录验证分组连接，同时刷新它自己的可选模型。
      await handleFetchModels();
      return;
    }
    setCatalogStatus('loading');
    setCatalogMessage(t('正在验证 {name} 连接...', { name: definition.name }));
    if (definition.id === 'runninghub-model') {
      const checks: string[] = [];
      let passed = true;
      for (const [id, key, label] of [['runninghub-model', apiKey.trim(), '模型'], ['runninghub', workflowApiKey.trim(), '工作流']] as const) {
        if (!key) continue;
        const result = await testProviderConnection(id, key, baseUrl.trim() || undefined);
        checks.push(`${label}连接：${result.success ? `验证成功${result.balance ? `（${result.balance}）` : ''}` : result.error || '验证失败'}`);
        passed &&= result.success;
      }
      setCatalogStatus(passed ? 'ready' : 'error'); setCatalogMessage(checks.join('；')); return;
    }
    const result = await testProviderConnection(
      definition.id,
      apiKey.trim(),
      baseUrl.trim() || undefined,
      chatApiProtocol,
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
    setCatalogMessage((result.error && (isWorkflowApi ? t(result.error) : result.error)) || t('{name} 连接验证失败', { name: definition.name }));
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
    const name = manualModelName.trim() || id;
    const seedanceVariant = inferSeedanceModelVariant(id, name);
    const h3Variant = inferH3ModelVariant(id, name);
    const model = applyKnownVideoTemplateDefaults({
      id,
      name,
      category: seedanceVariant || h3Variant ? 'video' : manualCategory,
      provider: connectionId || definition.id,
      ...(!seedanceVariant && !h3Variant ? { categoryManual: true } : {}),
    }, baseUrl);
    setModels((current) => mergeModels(current, [model]));
    setSelectedIds((current) => new Set(current).add(id));
    setManualModelId('');
    setManualModelName('');
    if (definition.id === 'custom-openai' && model.category === 'image') {
      setImageCapabilityModelId(id); setVideoCapabilityModelId(null); setProtocolModelId(null);
    }
    if (definition.id === 'custom-openai' && model.category === 'video') {
      setProtocolModelId(id);
      setVideoCapabilityModelId(null);
      setProtocolValid(true);
    }
  };

  const updateModelCategory = (modelId: string, nextCategory: GeneralModelCategory) => {
    setModels((current) => current.map((model) =>
      model.id === modelId ? {
        ...model,
        category: nextCategory,
        categoryManual: true,
        ...(nextCategory === 'video' ? {} : { videoCapability: undefined }),
        ...(nextCategory === 'image' ? {} : { imageCapability: undefined }),
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

  const updateImageCapability = (modelId: string, imageCapability: ImageModelCapability) => {
    setModels((current) => current.map((model) => model.id === modelId ? { ...model, imageCapability } : model));
  };

  const applyImageTemplate = (modelId: string, templateId: string) => {
    const template = createImageQuickAdaptTemplate(templateId);
    setModels((current) => current.map((model) => model.id === modelId && model.category === 'image'
      ? { ...model, ...template } : model));
    // 避免已展开的旧协议编辑器继续回写覆盖新模板。
    closeProtocolEditor();
  };

  const updateImageReferenceRequestMode = (
    modelId: string,
    imageReferenceRequestMode: ImageReferenceRequestMode | undefined,
  ) => {
    setModels((current) => current.map((model) =>
      model.id === modelId ? { ...model, imageReferenceRequestMode } : model,
    ));
  };

  const closeDialog = () => {
    abortRef.current?.abort();
    onClose();
  };

  const returnToDefinitionPicker = () => {
    abortRef.current?.abort();
    setDefinitionId('');
  };

  const handleSave = async () => {
    if (!definition) {
      setCatalogStatus('error');
      setCatalogMessage(t('请先选择 API 厂商'));
      return;
    }
    if (missingCredentials) {
      setCatalogStatus('error');
      setCatalogMessage(t('请先填写接口地址和 API Key'));
      return;
    }
    if (!isWebSearchProvider && !isWorkflowApi && !workflowOnlyConnection && selectedModels.length === 0) {
      setCatalogStatus('error');
      setCatalogMessage(t('请至少选择一个模型'));
      return;
    }
    if (!protocolValid) {
      setCatalogStatus('error');
      setCatalogMessage(t('当前调用协议校验未通过，请检查 JSON 格式和协议字段'));
      return;
    }
    try {
      if (isWorkflowApi) {
        if (!baseUrl.trim() || !workflowValid || !workflowDrafts.length) throw new Error(t('请完成工作流配置'));
        normalizeWorkflowApiBaseUrl(baseUrl, true);
        workflowDrafts.forEach((draft) => validateDeclarativeWorkflowManifest(draft.manifest));
        if (!apiKey.trim() && workflowDrafts.some((draft) => draft.manifest.protocol.auth?.type !== 'none')) throw new Error(t('请填写工作流 API Token'));
      }
      assertProviderModelsVideoCapabilities(selectedModels);
    } catch (error) {
      setCatalogStatus('error');
      setCatalogMessage(error instanceof Error ? error.message : t('视频能力配置无效'));
      return;
    }
    const nextConnectionId = isWebSearchProvider
      ? definition.id
      : connectionId || createConnectionId(definition.id);
    const modelConfig = isWebSearchProvider || isWorkflowApi
      ? {}
      : {
          selectedModels: selectedModels.map((model) => ({ ...model, provider: nextConnectionId })),
          catalogModels: capCatalogModels(models, selectedIds)
            .map((model) => ({ ...model, provider: nextConnectionId })),
          visibleModelCategories: CATEGORY_ORDER.filter((item) => visibleModelCategories.has(item)),
          catalogUpdatedAt: Date.now(),
        };
    try { await onSave(
      nextConnectionId,
      {
        name: connectionName.trim() || definition.name,
        apiKey: definition.authType === 'oauth' ? '' : apiKey.trim(),
        baseUrl: isWorkflowApi ? normalizeWorkflowApiBaseUrl(baseUrl, true) : normalizeBaseUrl(baseUrl, chatApiProtocol) || undefined,
        catalogId: definition.id,
        ...(definition.id === 'custom-openai' ? { chatApiProtocol } : {}),
        ...modelConfig,
        ...(definition.id === 'volcengine' && assetLibraryConfig ? { assetLibrary: { ...assetLibraryConfig, projectName: assetLibraryConfig.projectName || 'default' } } : {}),
      },
      definition.id === 'runninghub-model'
        ? { runninghubWorkflowApiKey: workflowApiKey.trim() }
        : isWorkflowApi ? { workflowApiDrafts: workflowDrafts } : undefined,
    );
    } catch (error) {
      const message = error instanceof Error ? error.message : t('保存失败');
      setCatalogStatus('error');
      setCatalogMessage(message);
      useAppStore.getState().showToast(message, 'error');
    }
  };

  return createPortal(
    <ModalOverlay
      isOpen={isOpen}
      onClose={closeDialog}
      ariaLabel={editing ? t('编辑 API 厂商') : t('添加 API 厂商')}
      className="provider-dialog"
      closeOnBackdrop={false}
      zIndex={260}
    >
      <header className="provider-dialog-header">
        <div>
          <span className="provider-dialog-kicker">{editing ? t('编辑连接') : t('新建连接')}</span>
          <h3>{isWebSearchProvider ? t('联网搜索') : definition ? isWorkflowApi ? t(definition.name) : definition.name : t('选择 API 厂商')}</h3>
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
                  <strong>{item.kind === 'web-search' ? t('联网搜索') : item.kind === 'workflow-api' ? t(item.name) : item.name}</strong>
                  <small>{item.kind === 'web-search' ? t('Tavily、博查、智谱与 Exa') : item.kind === 'workflow-api' ? t(item.description) : item.description}</small>
                </span>
                <Icon icon="mdi:chevron-right" width="18" />
              </button>
            ))}
          </div>
        </div>
      ) : definition.id === 'cccapi' ? (
        <CccGroupConnectionsForm providerConfigs={providerConfigs} presetModels={fallbackModels.cccapi || []}
          onSave={onSaveCccGroups} onClose={closeDialog} onReturnToPicker={editing ? undefined : returnToDefinitionPicker}
          onCopyConnection={onCopyCccGroup} onRemoveConnection={onRemoveCccGroup} />
      ) : (
        <>
          <div className="provider-dialog-body">
            <ProviderConnectionForm
              editing={editing}
              definition={definition}
              isWebSearchProvider={isWebSearchProvider}
              connectionName={connectionName}
              setConnectionName={setConnectionName}
              chatApiProtocol={chatApiProtocol}
              setChatApiProtocol={setChatApiProtocol}
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

            {definition?.id === 'volcengine' && (
              <VolcengineAssetLibrarySettings
                config={{
                  name: connectionName,
                  apiKey,
                  baseUrl: baseUrl || undefined,
                  catalogId: definition.id,
                  assetLibrary: assetLibraryConfig,
                }}
                onChange={(next) => {
                  setAssetLibraryConfig(next.assetLibrary);
                }}
                defaultEnabled={!editing || !assetLibraryConfig}
                onPersist={connectionId ? async (nextLibrary) => {
                  const current = useAppStore.getState().config.providers[connectionId];
                  if (!current) return;
                  useAppStore.getState().saveProviderConfig(connectionId, { ...current, assetLibrary: nextLibrary });
                  await useAppStore.getState().saveConfig({ silent: true, throwOnError: true });
                } : undefined}
              />
            )}

            {isWebSearchProvider && (
              <ProviderWebSearchPicker
                definitions={webSearchDefinitions}
                providerConfigs={providerConfigs}
                currentDefinition={definition}
                onChoose={chooseDefinition}
              />
            )}

            {isWorkflowApi && <ProviderWorkflowSection drafts={workflowDrafts} onChange={setWorkflowDrafts} onValidityChange={setWorkflowValid} />}
            {!isWebSearchProvider && !isWorkflowApi && (
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
                protocolModel={protocolModel}
                imageCapabilityModel={imageCapabilityModel}
                setImageCapabilityModelId={setImageCapabilityModelId}
                onUpdateImageCapability={updateImageCapability}
                onApplyImageTemplate={applyImageTemplate}
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
                onFetchModels={handleFetchModels}
              />
            )}
          </div>

          <footer className="provider-dialog-footer">
            <span>
              {isWebSearchProvider
                ? `当前使用 ${definition.name}`
                : isWorkflowApi ? t('将配置 {count} 个工作流', { count: workflowDrafts.length }) : selectedModels.length > 0
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
                aria-disabled={
                  missingCredentials
                  || (isWorkflowApi && !workflowValid)
                  || (!isWebSearchProvider && !isWorkflowApi && !workflowOnlyConnection && selectedModels.length === 0)
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
