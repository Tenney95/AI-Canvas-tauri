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
import type { ImageHostingConfig } from '../../types/imageHosting';
import type { VolcengineTosConfig, VolcengineTosCredentials } from '../../types/volcengineTos';
import { persistImageHosting, validateImageHosting } from '../../services/imageHostingService';
import { deleteVolcengineTosCredential, persistVolcengineTosConfig, validateVolcengineTosConfig } from '../../services/volcengineTosConfigService';
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
  resolveProviderImageModelForValidation,
  type ProviderDefinition,
} from '../../services/ai/providerCatalogService';
import { normalizeBaseUrl } from '../../services/ai/providerBaseUrl';
import { testProviderConnection } from '../../services/testConnection';
import { confirmAction } from '../../services/confirmDialog';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import { runningHubSiteDrafts, runningHubSiteId } from '../../services/runninghubSiteCredentials';
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
import ProviderImageHostingSettings from './providerConnection/ProviderImageHostingSettings';
import VolcengineAssetLibrarySettings from '../volcengine/VolcengineAssetLibrarySettings';
import VolcengineTosSettings from './VolcengineTosSettings';
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

interface ConnectionDraftState {
  connectionName: string;
  chatApiProtocol: ChatApiProtocol;
  baseUrl: string;
  models: ProviderModelSelection[];
  selectedIds: Set<string>;
  visibleModelCategories: Set<GeneralModelCategory>;
  manualModelId: string;
  manualModelName: string;
  manualCategory: GeneralModelCategory;
  imageHosting?: ImageHostingConfig;
  tosUpload?: VolcengineTosConfig;
}

/** 仅比较弹窗内的编辑内容；凭据单独在内存比较，不进入序列化快照。 */
function serializeConnectionDraft(draft: ConnectionDraftState): string {
  return JSON.stringify({
    ...draft,
    selectedIds: [...draft.selectedIds].sort(),
    visibleModelCategories: [...draft.visibleModelCategories].sort(),
  });
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
  forceSingleGroupEdit = false,
  onEditRelayGroup,
}: ProviderConnectionDialogProps & {
  onSaveCccGroups: (connections: Record<string, ApiProviderConfig>) => Promise<void>;
  onCopyCccGroup?: (connectionId: string) => Promise<void>;
  onRemoveCccGroup?: (connectionId: string) => Promise<boolean>;
  forceSingleGroupEdit?: boolean;
  onEditRelayGroup?: (connectionId: string) => void;
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
  const initialLocalModels = initialDefinition?.policy.catalog.initialModelsOnEdit === 'fallback'
    ? (fallbackModels[initialDefinition.id] || []) : [];
  const initialBaseUrl = initialConfig?.baseUrl || initialDefinition?.defaultBaseUrl || '';
  const [definitionId, setDefinitionId] = useState(initialDefinitionId);
  const [connectionName, setConnectionName] = useState(initialConfig?.name || initialDefinition?.name || '');
  const [chatApiProtocol, setChatApiProtocol] = useState<ChatApiProtocol>(
    () => resolveChatApiProtocol(initialConfig?.chatApiProtocol),
  );
  const [genericApiKey, setGenericApiKey] = useState(initialConfig?.apiKey || '');
  const [museCredentialReady, setMuseCredentialReady] = useState(false);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [imageHosting, setImageHosting] = useState(initialConfig?.imageHosting);
  const [imageHostingApiKey, setImageHostingApiKey] = useState('');
  const [tosUpload, setTosUpload] = useState<VolcengineTosConfig | undefined>(initialConfig?.tosUpload);
  const [tosCredentials, setTosCredentials] = useState<VolcengineTosCredentials>({ accessKeyId: '', secretAccessKey: '' });
  const tosCleanupRefs = useRef(new Set(initialConfig?.tosUpload?.credentialRef ? [initialConfig.tosUpload.credentialRef] : []));
  const [assetLibraryConfig, setAssetLibraryConfig] = useState<VolcengineAssetLibraryConfig | undefined>(initialConfig?.assetLibrary);
  const [legacyWorkflowApiKey, setLegacyWorkflowApiKey] = useState(runninghubWorkflowApiKey);
  const [siteKeys, setSiteKeys] = useState(() => runningHubSiteDrafts({ ...providerConfigs,
    ...(initialDefinition?.id === 'runninghub-model' && initialConfig ? { 'runninghub-model': initialConfig } : {}),
    ...(!providerConfigs.runninghub && runninghubWorkflowApiKey ? { runninghub: {
      name: 'RunningHub 工作流', apiKey: runninghubWorkflowApiKey, baseUrl: initialBaseUrl,
    } } : {}),
  }));
  const activeRunningHubSite = definitionId === 'runninghub-model' ? runningHubSiteId(baseUrl) : undefined;
  const apiKey = activeRunningHubSite ? siteKeys[activeRunningHubSite].modelKey : genericApiKey;
  const workflowApiKey = activeRunningHubSite ? siteKeys[activeRunningHubSite].workflowKey : legacyWorkflowApiKey;
  const setApiKey = (value: string | ((previous: string) => string)) => {
    if (!activeRunningHubSite) { setGenericApiKey(value); return; }
    setSiteKeys((previous) => ({ ...previous, [activeRunningHubSite]: { ...previous[activeRunningHubSite],
      modelKey: typeof value === 'function' ? value(previous[activeRunningHubSite].modelKey) : value } }));
  };
  const setWorkflowApiKey = (value: string | ((previous: string) => string)) => {
    if (!activeRunningHubSite) { setLegacyWorkflowApiKey(value); return; }
    setSiteKeys((previous) => ({ ...previous, [activeRunningHubSite]: { ...previous[activeRunningHubSite],
      workflowKey: typeof value === 'function' ? value(previous[activeRunningHubSite].workflowKey) : value } }));
  };
  const [workflowDrafts, setWorkflowDrafts] = useState<WorkflowApiDraft[]>(() =>
    useAppStore.getState().workflows.filter((workflow) => workflow.adapterType === 'workflow-api' && workflow.workflowApi?.connectionId === connectionId)
      .map((workflow) => ({ id: workflow.id, name: workflow.name, manifest: editableWorkflowApiManifest(workflow.workflowApi!) })));
  const [workflowValid, setWorkflowValid] = useState(false);
  const [models, setModels] = useState<ProviderModelSelection[]>(
    () => {
      const options = { preferIncomingConfiguration: initialDefinition?.id === 'relayonapi' };
      return mergeModels(mergeModels(initialLocalModels, initialCatalogModels, options), initialSelectedModels, options)
        .map((model) => applyKnownVideoTemplateDefaults(model, initialBaseUrl));
    },
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
  const [testSessionScope] = useState(() => connectionId || createConnectionId('custom-openai'));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const protocolDraftInvalidRef = useRef(false);
  const navigationPendingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const currentConnectionDraft = (): ConnectionDraftState => ({
    connectionName, chatApiProtocol, baseUrl, models, selectedIds, visibleModelCategories,
    manualModelId, manualModelName, manualCategory, imageHosting, tosUpload,
  });
  const [draftBaseline, setDraftBaseline] = useState(() => ({
    snapshot: serializeConnectionDraft(currentConnectionDraft()),
    apiKey,
  }));

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
    if (definition.authType === 'browser-session') return !museCredentialReady;
    if (definition.id === 'runninghub-model') return activeRunningHubSite
      ? !Object.values(siteKeys).some((keys) => keys.modelKey.trim() || keys.workflowKey.trim())
      : !apiKey.trim() && !workflowApiKey.trim();
    if (!apiKey.trim()) return true;
    return definition.credentials.some(
      (field) => field.required && field.key === 'baseUrl' && !baseUrl.trim(),
    );
  }, [apiKey, baseUrl, definition, dreaminaLoggedIn, museCredentialReady, workflowApiKey, activeRunningHubSite, siteKeys]);
  const workflowOnlyConnection = definition?.id === 'runninghub-model' && !apiKey.trim();

  const hasConnectionChanges = () => (definition?.id === 'custom-openai' || definition?.id === 'volcengine')
    && (apiKey !== draftBaseline.apiKey
      || !!imageHostingApiKey
      || !!tosCredentials.accessKeyId || !!tosCredentials.secretAccessKey
      || serializeConnectionDraft(currentConnectionDraft()) !== draftBaseline.snapshot);

  const navigateWithDraftGuard = async (navigate: () => void, discardConnection = false): Promise<boolean> => {
    if (savingRef.current || navigationPendingRef.current) return false;
    if (!protocolDraftInvalidRef.current && !(discardConnection && hasConnectionChanges())) {
      navigate();
      return true;
    }
    navigationPendingRef.current = true;
    try {
      const confirmed = await confirmAction(
        discardConnection
          ? t('当前连接有未保存的修改，离开后将丢弃。是否放弃修改？')
          : t('当前协议有尚未同步的 JSON 草稿，离开后将丢弃。是否放弃草稿？'),
        { title: t('保留未完成的配置'), kind: 'warning', okLabel: t('放弃修改'), cancelLabel: t('继续编辑') },
      );
      if (!confirmed || savingRef.current) return false;
      protocolDraftInvalidRef.current = false;
      navigate();
      return true;
    } catch (error) {
      setCatalogStatus('error');
      setCatalogMessage(error instanceof Error ? error.message : t('无法确认是否放弃修改，请重试'));
      return false;
    } finally {
      navigationPendingRef.current = false;
    }
  };

  const chooseDefinition = (nextDefinition: ProviderDefinition) => {
    void navigateWithDraftGuard(() => {
      abortRef.current?.abort();
      const savedConfig = nextDefinition.kind === 'web-search'
        ? providerConfigs[nextDefinition.id]
        : undefined;
      setDefinitionId(nextDefinition.id);
      setConnectionName(savedConfig?.name || nextDefinition.name);
      setChatApiProtocol(resolveChatApiProtocol(savedConfig?.chatApiProtocol));
      setGenericApiKey(savedConfig?.apiKey || '');
      setBaseUrl(savedConfig?.baseUrl || nextDefinition.defaultBaseUrl || '');
      setImageHosting(savedConfig?.imageHosting);
      setImageHostingApiKey('');
      setTosUpload(savedConfig?.tosUpload);
      setTosCredentials({ accessKeyId: '', secretAccessKey: '' });
      tosCleanupRefs.current = new Set(savedConfig?.tosUpload?.credentialRef ? [savedConfig.tosUpload.credentialRef] : []);
      setAssetLibraryConfig(savedConfig?.assetLibrary);
      setLegacyWorkflowApiKey('');
      if (nextDefinition.id === 'runninghub-model') setSiteKeys(runningHubSiteDrafts(providerConfigs));
      const localModels = nextDefinition.policy.catalog.initialModelsOnCreate === 'empty' ? [] : fallbackModels[nextDefinition.id] || [];
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
      setImageCapabilityModelId(null);
      setVideoCapabilityModelId(null);
      setProtocolModelId(null);
      setProtocolValid(true);
      setCategoryEditModelId(null);
      setDraftBaseline({
        snapshot: serializeConnectionDraft({
          connectionName: savedConfig?.name || nextDefinition.name,
          chatApiProtocol: resolveChatApiProtocol(savedConfig?.chatApiProtocol),
          baseUrl: savedConfig?.baseUrl || nextDefinition.defaultBaseUrl || '',
          models: localModels,
          selectedIds: new Set(),
          visibleModelCategories: new Set(CATEGORY_ORDER),
          manualModelId: '', manualModelName: '', manualCategory: 'text',
          imageHosting: savedConfig?.imageHosting,
          tosUpload: savedConfig?.tosUpload,
        }),
        apiKey: savedConfig?.apiKey || '',
      });
    }, true);
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

  const changeBaseUrl = (value: string | ((previous: string) => string)) => {
    const next = typeof value === 'function' ? value(baseUrl) : value;
    if (next === baseUrl) return;
    if (definition?.id === 'toapis') {
      // Key 属于同一账号；仅取消旧站请求，防止迟到结果覆盖新站目录。
      abortRef.current?.abort();
      setCatalogStatus('idle');
      setCatalogMessage(t('站点已切换，请重新拉取当前站点的模型目录。'));
      setModels((current) => mergeModels(fallbackModels.toapis || [], current.filter((model) => selectedIds.has(model.id))));
    }
    setBaseUrl(next);
  };

  const changeApiKey = (value: string | ((previous: string) => string)) => {
    if (definition?.policy.catalog.invalidateOnKeyChange) {
      abortRef.current?.abort();
      setCatalogStatus('idle');
      setCatalogMessage(t('Key 已修改，保存后使用此 Key；可拉取模型验证权限。'));
    }
    setApiKey(value);
  };

  const handleFetchModels = async () => {
    if (!definition || missingCredentials) return;
    if (workflowOnlyConnection) { setCatalogStatus('warning'); setCatalogMessage(t('当前只配置工作流连接，可直接保存；获取模型目录需要模型 API Key')); return; }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCatalogStatus('loading');
    setCatalogMessage('');
    try {
      if (definition.id === 'runninghub-model') {
        const result = await testProviderConnection('runninghub-model', apiKey.trim(), baseUrl.trim() || undefined);
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
        definition.policy.catalog.refresh === 'replace' ? current.filter((model) => remoteIds.has(model.id)) : current,
        result.models,
      )
        .map((model) => applyKnownVideoTemplateDefaults(model, resolvedBaseUrl)));
      if (definition.policy.catalog.refresh === 'replace') {
        setSelectedIds((current) => new Set([...current].filter((id) => remoteIds.has(id))));
        if (protocolModelId && !remoteIds.has(protocolModelId)) {
          setProtocolModelId(null);
          setProtocolValid(true);
        }
        if (videoCapabilityModelId && !remoteIds.has(videoCapabilityModelId)) setVideoCapabilityModelId(null);
        if (imageCapabilityModelId && !remoteIds.has(imageCapabilityModelId)) setImageCapabilityModelId(null);
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

  const handleAssistantAdd = () => {
    const store = useAppStore.getState();
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
    if (definition.id === 'runninghub-model' && !apiKey.trim() && !workflowApiKey.trim()) {
      setCatalogStatus('warning'); setCatalogMessage(t('当前站点尚未配置密钥，请填写或切换到已配置的站点')); return;
    }
    if (definition.policy.catalog.connectionTest === 'catalog') {
      // 用当前 Key 的模型目录验证连接，同时刷新对应分组或站点的可选模型。
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
        checks.push(t('{label}连接：{result}', { label: t(label), result: result.success ? t('验证成功') + (result.balance ? ` (${result.balance})` : '') : result.error || t('验证失败') }));
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
    protocolDraftInvalidRef.current = false;
  };

  const openModelSettings = (modelId: string, kind: 'image' | 'video' | 'protocol'): Promise<boolean> => {
    if (kind === 'protocol' && protocolModelId === modelId) return Promise.resolve(true);
    return navigateWithDraftGuard(() => {
      closeProtocolEditor();
      setImageCapabilityModelId(kind === 'image' ? modelId : null);
      setVideoCapabilityModelId(kind === 'video' ? modelId : null);
      if (kind === 'protocol') setProtocolModelId(modelId);
    });
  };

  const toggleModel = (modelId: string) => {
    const removingProtocol = selectedIds.has(modelId) && protocolModelId === modelId;
    const toggle = () => {
      if (removingProtocol) closeProtocolEditor();
      if (selectedIds.has(modelId) && videoCapabilityModelId === modelId) setVideoCapabilityModelId(null);
      if (selectedIds.has(modelId) && imageCapabilityModelId === modelId) setImageCapabilityModelId(null);
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(modelId)) next.delete(modelId);
        else next.add(modelId);
        return next;
      });
    };
    if (removingProtocol) void navigateWithDraftGuard(toggle);
    else toggle();
  };

  const toggleVisibleModels = () => {
    const allVisibleSelected = filteredModels.length > 0
      && filteredModels.every((model) => selectedIds.has(model.id));
    const removingProtocol = Boolean(
      allVisibleSelected
      && protocolModelId
      && filteredModels.some((model) => model.id === protocolModelId),
    );
    const toggle = () => {
      if (removingProtocol) closeProtocolEditor();
      if (
        allVisibleSelected
        && videoCapabilityModelId
        && filteredModels.some((model) => model.id === videoCapabilityModelId)
      ) setVideoCapabilityModelId(null);
      if (allVisibleSelected && imageCapabilityModelId
        && filteredModels.some((model) => model.id === imageCapabilityModelId)) setImageCapabilityModelId(null);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const model of filteredModels) {
          if (allVisibleSelected) next.delete(model.id);
          else next.add(model.id);
        }
        return next;
      });
    };
    if (removingProtocol) void navigateWithDraftGuard(toggle);
    else toggle();
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
    const displacesProtocol = Boolean(protocolModelId
      && (model.category === 'image' || model.category === 'video' || protocolModelId === id));
    const add = () => {
      if (displacesProtocol) closeProtocolEditor();
      setModels((current) => mergeModels(current, [model]));
      setSelectedIds((current) => new Set(current).add(id));
      setManualModelId('');
      setManualModelName('');
      if (definition.id === 'custom-openai' && model.category === 'image') {
        setImageCapabilityModelId(id); setVideoCapabilityModelId(null); setProtocolModelId(null);
      }
      if (definition.id === 'custom-openai' && model.category === 'video') {
        setProtocolModelId(id);
        setImageCapabilityModelId(null);
        setVideoCapabilityModelId(null);
        setProtocolValid(true);
      }
    };
    if (displacesProtocol) void navigateWithDraftGuard(add);
    else add();
  };

  const updateModelCategory = (modelId: string, nextCategory: GeneralModelCategory) => {
    const update = () => {
      if (protocolModelId === modelId) closeProtocolEditor();
      setModels((current) => current.map((model) =>
        model.id === modelId ? {
          ...model,
          category: nextCategory,
          categoryManual: true,
          ...(nextCategory === 'video' ? {} : { videoCapability: undefined }),
          ...(nextCategory === 'image' ? {} : { imageCapability: undefined }),
        } : model,
      ));
      if (nextCategory !== 'video' && videoCapabilityModelId === modelId) setVideoCapabilityModelId(null);
      if (nextCategory !== 'image' && imageCapabilityModelId === modelId) setImageCapabilityModelId(null);
      setVisibleModelCategories((current) => new Set(current).add(nextCategory));
      setCategoryEditModelId(null);
    };
    if (protocolModelId === modelId) void navigateWithDraftGuard(update);
    else update();
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
    void navigateWithDraftGuard(() => {
      setModels((current) => current.map((model) => model.id === modelId && model.category === 'image'
        ? { ...model, ...template } : model));
      // 避免已展开的旧协议编辑器继续回写覆盖新模板。
      closeProtocolEditor();
    });
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
    void navigateWithDraftGuard(() => {
      abortRef.current?.abort();
      onClose();
    }, true);
  };

  const returnToDefinitionPicker = () => {
    void navigateWithDraftGuard(() => {
      abortRef.current?.abort();
      closeProtocolEditor();
      setDefinitionId('');
    }, true);
  };

  const handleSave = async () => {
    if (
      !definition
      || savingRef.current
      || navigationPendingRef.current
      || protocolDraftInvalidRef.current
      || missingCredentials
      || (!isWebSearchProvider && !isWorkflowApi && !workflowOnlyConnection && selectedModels.length === 0)
      || !protocolValid
    ) return;
    try {
      if (definition.id === 'custom-openai' && imageHosting) validateImageHosting(imageHosting, !!imageHostingApiKey.trim(), { apiKey, baseUrl });
      if (definition.id === 'volcengine') validateVolcengineTosConfig(tosUpload, tosCredentials);
      if (isWorkflowApi) {
        if (!baseUrl.trim() || !workflowValid || !workflowDrafts.length) throw new Error(t('请完成工作流配置'));
        normalizeWorkflowApiBaseUrl(baseUrl, true);
        workflowDrafts.forEach((draft) => validateDeclarativeWorkflowManifest(draft.manifest));
        if (!apiKey.trim() && workflowDrafts.some((draft) => draft.manifest.protocol.auth?.type !== 'none')) throw new Error(t('请填写工作流 API Token'));
      }
      assertProviderModelsVideoCapabilities(selectedModels.map((model) => resolveProviderImageModelForValidation(definition, model)));
    } catch (error) {
      setCatalogStatus('error');
      setCatalogMessage(error instanceof Error ? error.message : t('视频能力配置无效'));
      return;
    }
    const nextConnectionId = isWebSearchProvider
      ? definition.id
      : connectionId || (definition.id === 'custom-openai' ? testSessionScope : createConnectionId(definition.id));
    const modelConfig = isWebSearchProvider || isWorkflowApi
      ? {}
      : {
          selectedModels: selectedModels.map((model) => ({ ...model, provider: nextConnectionId })),
          catalogModels: capCatalogModels(models, selectedIds)
            .map((model) => ({ ...model, provider: nextConnectionId })),
          visibleModelCategories: CATEGORY_ORDER.filter((item) => visibleModelCategories.has(item)),
          catalogUpdatedAt: Date.now(),
        };
    savingRef.current = true;
    setSaving(true);
    try {
      const savedImageHosting = definition.id === 'custom-openai' && imageHosting
        ? await persistImageHosting(imageHosting, imageHostingApiKey, { apiKey, baseUrl }) : undefined;
      // 保存连接失败时保留新引用，重试不必再次输入或覆盖旧 Key。
      setImageHosting(savedImageHosting);
      setImageHostingApiKey('');
      if (definition.id === 'volcengine' && tosUpload?.credentialRef) tosCleanupRefs.current.add(tosUpload.credentialRef);
      const savedTosUpload = definition.id === 'volcengine'
        ? await persistVolcengineTosConfig(tosUpload, tosCredentials) : undefined;
      // 连接保存失败时保持新引用和空凭据草稿；重试不会覆写或丢弃原凭据。
      setTosUpload(savedTosUpload);
      setTosCredentials({ accessKeyId: '', secretAccessKey: '' });
      await onSave(
        nextConnectionId,
        {
          ...(definition.id === 'relayonapi' ? initialConfig : {}),
          name: connectionName.trim() || definition.name,
          apiKey: definition.authType === 'api-key' ? apiKey.trim() : '',
          baseUrl: isWorkflowApi ? normalizeWorkflowApiBaseUrl(baseUrl, true) : normalizeBaseUrl(baseUrl, chatApiProtocol) || undefined,
          catalogId: definition.id,
          ...(definition.id === 'custom-openai' ? { chatApiProtocol, imageHosting: savedImageHosting } : {}),
          ...(definition.id === 'volcengine' ? { tosUpload: savedTosUpload } : {}),
          ...modelConfig,
          ...(definition.id === 'volcengine' && assetLibraryConfig ? { assetLibrary: { ...assetLibraryConfig, projectName: assetLibraryConfig.projectName || 'default' } } : {}),
        },
        definition.id === 'runninghub-model'
          ? { runninghubWorkflowApiKey: workflowApiKey.trim(), ...(activeRunningHubSite ? { runninghubSiteKeys: siteKeys } : {}) }
          : isWorkflowApi ? { workflowApiDrafts: workflowDrafts } : undefined,
      );
      setDraftBaseline({ snapshot: serializeConnectionDraft({ ...currentConnectionDraft(), imageHosting: savedImageHosting, tosUpload: savedTosUpload }), apiKey });
      if (definition.id === 'volcengine') {
        for (const ref of tosCleanupRefs.current) {
          if (ref === savedTosUpload?.credentialRef
            || Object.values(useAppStore.getState().config.providers).some((provider) => provider.tosUpload?.credentialRef === ref)) continue;
          try {
            await deleteVolcengineTosCredential(ref);
            tosCleanupRefs.current.delete(ref);
          } catch { useAppStore.getState().showToast(t('连接已保存，旧 TOS 凭据清理未完成'), 'error'); }
        }
      }
    } catch (error) {
      setCatalogStatus('error');
      setCatalogMessage(error instanceof Error ? error.message : t('保存失败'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return createPortal(
    <ModalOverlay
      isOpen={isOpen}
      onClose={closeDialog}
      ariaLabel={editing ? t('编辑 API 厂商') : t('添加 API 厂商')}
      className="provider-dialog settings-modal-shell ui-dialog-surface"
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
      ) : definition.id === 'cccapi' || (definition.id === 'relayonapi' && !forceSingleGroupEdit && !initialModelId) ? (
        <CccGroupConnectionsForm provider={definition.id === 'relayonapi' ? 'relayonapi' : 'cccapi'} providerConfigs={providerConfigs} presetModels={fallbackModels[definition.id] || []}
          onSave={onSaveCccGroups} onClose={closeDialog} onReturnToPicker={editing ? undefined : returnToDefinitionPicker}
          onCopyConnection={onCopyCccGroup} onRemoveConnection={onRemoveCccGroup} onEditRelayGroup={onEditRelayGroup} />
      ) : (
        <>
          <div className="provider-dialog-body" inert={saving} aria-busy={saving}>
            <ProviderConnectionForm
              editing={editing}
              definition={definition}
              isWebSearchProvider={isWebSearchProvider}
              connectionName={connectionName}
              setConnectionName={setConnectionName}
              chatApiProtocol={chatApiProtocol}
              setChatApiProtocol={setChatApiProtocol}
              apiKey={apiKey}
              setApiKey={changeApiKey}
              baseUrl={baseUrl}
              setBaseUrl={changeBaseUrl}
              workflowApiKey={workflowApiKey}
              setWorkflowApiKey={setWorkflowApiKey}
              dreaminaLoggedIn={dreaminaLoggedIn}
              dreaminaLoading={dreaminaLoading}
              onDreaminaLogin={onDreaminaLogin}
              onMuseCredentialReadyChange={setMuseCredentialReady}
              duplicateConnectionName={duplicateConnectionName}
              catalogStatus={catalogStatus}
              catalogMessage={catalogMessage}
              missingCredentials={missingCredentials}
              onReturnToPicker={returnToDefinitionPicker}
              onTestConnection={handleTestConnection}
            />

            {definition?.id === 'custom-openai' && <ProviderImageHostingSettings
              config={imageHosting} onChange={setImageHosting} apiKey={imageHostingApiKey} onApiKeyChange={setImageHostingApiKey}
            />}

            {definition?.id === 'volcengine' && <VolcengineTosSettings config={tosUpload} onChange={setTosUpload}
              credentials={tosCredentials} onCredentialsChange={setTosCredentials} disabled={saving} />}

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
                onProtocolDraftInvalidChange={(invalid) => { protocolDraftInvalidRef.current = invalid; }}
                testSessionScope={testSessionScope}
                onOpenModelSettings={openModelSettings}
                protocolModel={protocolModel}
                imageCapabilityModel={imageCapabilityModel}
                setImageCapabilityModelId={setImageCapabilityModelId}
                onUpdateImageCapability={updateImageCapability}
                onApplyImageTemplate={applyImageTemplate}
                videoCapabilityModel={videoCapabilityModel}
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
                onCloseProtocolEditor={() => { void navigateWithDraftGuard(closeProtocolEditor); }}
                onFetchModels={handleFetchModels}
              />
            )}
          </div>

          <footer className="provider-dialog-footer">
            <span>
              {isWebSearchProvider
                ? t('当前使用 {name}', { name: definition.name })
                : isWorkflowApi ? t('将配置 {count} 个工作流', { count: workflowDrafts.length }) : selectedModels.length > 0
                  ? t('将启用 {count} 个模型', { count: selectedModels.length })
                  : t('至少选择一个模型')}
            </span>
            <div>
              <AnimatedButton type="button" className="provider-secondary-btn" disabled={saving} onClick={closeDialog}>
                {t('取消')}
              </AnimatedButton>
              <AnimatedButton
                type="button"
                className="provider-primary-btn"
                disabled={
                  saving
                  || missingCredentials
                  || (isWorkflowApi && !workflowValid)
                  || (!isWebSearchProvider && !isWorkflowApi && !workflowOnlyConnection && selectedModels.length === 0)
                  || !protocolValid
                }
                onClick={() => void handleSave()}
              >
                {saving ? t('保存中...') : editing ? t('保存更改') : t('添加厂商')}
              </AnimatedButton>
            </div>
          </footer>
        </>
      )}
    </ModalOverlay>,
    document.body,
  );
}
