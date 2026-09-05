/**
 * Provider model catalog — built-in provider metadata and model-list adapters.
 * Local manifests are supplied by the caller so this service stays independent
 * from component-owned model presentation data.
 */
import {
  APIMART_BASE_URL,
  BOCHA_SEARCH_BASE_URL,
  CCCAPI_BASE_URL,
  EXA_SEARCH_BASE_URL,
  GRSAI_BASE_URL,
  RUNNINGHUB_MODEL_BASE_URL,
  TAVILY_BASE_URL,
  VOLCENGINE_BASE_URL,
  ZHIPU_SEARCH_BASE_URL,
} from '../../constants/api';
import type {
  ApiProviderConfig,
  AppConfig,
  ChatApiProtocol,
  GeneralModelCategory,
  ProviderCatalogAdapter,
  ProviderModelSelection,
  WebSearchProviderId,
} from '../../types';
import { corsSafeFetch } from './httpTransport';
import { baseUrlCandidates } from './providerBaseUrl';
import { getChatApiHeaders, normalizeGeminiModelId, resolveChatApiProtocol } from './chatApiProtocol';
import { XAI_BASE_URL, XAI_MODEL_MANIFEST } from './providers/xaiModelManifest';
import {
  GOOGLE_GEMINI_BASE_URL,
  GOOGLE_MODEL_MANIFEST,
} from './providers/googleModelManifest';
import {
  SORA2U_BASE_URL,
  SORA2U_MODEL_MANIFEST,
  SORA2U_REQUEST_QUERY,
} from './providers/sora2uModelManifest';

export type ProviderAuthType = 'api-key' | 'oauth';
export type ProviderCredentialKey = 'apiKey' | 'baseUrl';

export interface ProviderCredentialField {
  key: ProviderCredentialKey;
  label: string;
  required: boolean;
  secret?: boolean;
  placeholder?: string;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  description: string;
  badgeText: string;
  authType: ProviderAuthType;
  catalogAdapter: ProviderCatalogAdapter;
  defaultBaseUrl?: string;
  modelsPath?: string;
  allowCustomBaseUrl?: boolean;
  /** 用户主动打开的注册、获取 Key 或充值页面；不得用作 API Base URL。 */
  externalUrl?: string;
  /** 无生成副作用的连接验证路径。 */
  connectionTestPath?: string;
  /** 该厂商 API 请求必须携带的固定查询参数。 */
  requestQuery?: Readonly<Record<string, string>>;
  /** 暂时不向用户暴露的模型 ID；保留底层协议，便于后续恢复。 */
  hiddenModelIds?: readonly string[];
  credentials: ProviderCredentialField[];
  /** 内置厂商随应用发布的模型及声明式执行协议。 */
  models?: readonly ProviderModelSelection[];
  /** web-search connections provide Agent capabilities and do not expose models. */
  kind?: 'model' | 'web-search';
}

export interface ProviderCatalogResult {
  models: ProviderModelSelection[];
  source: 'remote' | 'local-manifest' | 'local-fallback';
  warning?: string;
  /** 实际拉通的接口地址；与用户填的不同（如补了 /v1）时调用方应回写。 */
  resolvedBaseUrl?: string;
}

export interface FetchProviderCatalogOptions {
  providerId: string;
  config: ApiProviderConfig;
  fallbackModels?: ProviderModelSelection[];
  signal?: AbortSignal;
}

const API_KEY_FIELD: ProviderCredentialField = {
  key: 'apiKey',
  label: 'API Key',
  required: true,
  secret: true,
};

/**
 * 未填写 API Key 时展示的目录；填写后仍以远端 /models 为准。
 * 模型 ID 取自 CCC API 监控页 https://cccapi.cn/monitor 的 openai 渠道。
 * inputModalities 只在与按 ID 猜模态的兜底规则不一致时才显式声明，
 * 避免把 gpt-4 / o3-mini 这类纯文本模型误判成能吃图。
 */
const CCCAPI_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  { id: 'gpt-5.6', name: 'GPT-5.6', category: 'text', provider: 'cccapi', description: 'GPT-5.6 通用文本与多模态模型' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', category: 'text', provider: 'cccapi', description: 'GPT-5.6 Sol 文本与多模态模型' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', category: 'text', provider: 'cccapi', description: 'GPT-5.6 Luna 文本与多模态模型' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', category: 'text', provider: 'cccapi', description: 'GPT-5.6 Terra 文本与多模态模型' },
  { id: 'gpt-5.5', name: 'GPT-5.5', category: 'text', provider: 'cccapi', description: 'GPT-5.5 通用文本与多模态模型' },
  { id: 'gpt-5.4', name: 'GPT-5.4', category: 'text', provider: 'cccapi', description: 'GPT-5.4 通用文本与多模态模型' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', category: 'text', provider: 'cccapi', description: 'GPT-5.4 mini 轻量文本与多模态模型' },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', category: 'text', provider: 'cccapi', description: 'GPT-5.3 Codex Spark 编码模型' },
  { id: 'gpt-5.2', name: 'GPT-5.2', category: 'text', provider: 'cccapi', description: 'GPT-5.2 通用文本与多模态模型' },
  { id: 'gpt-5.2-pro', name: 'GPT-5.2 Pro', category: 'text', provider: 'cccapi', description: 'GPT-5.2 Pro 高能力文本与多模态模型' },
  { id: 'gpt-5', name: 'GPT-5', category: 'text', provider: 'cccapi', description: 'GPT-5 通用文本与多模态模型' },
  { id: 'o4-mini', name: 'o4-mini', category: 'text', provider: 'cccapi', description: 'o4-mini 轻量推理模型，支持多模态输入' },
  { id: 'o3', name: 'o3', category: 'text', provider: 'cccapi', description: 'o3 强推理模型，支持多模态输入' },
  { id: 'o3-mini', name: 'o3-mini', category: 'text', provider: 'cccapi', description: 'o3-mini 轻量推理模型', inputModalities: ['text'] },
  { id: 'gpt-4.1', name: 'GPT-4.1', category: 'text', provider: 'cccapi', description: 'GPT-4.1 通用文本与多模态模型' },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', category: 'text', provider: 'cccapi', description: 'GPT-4.1 mini 轻量文本与多模态模型' },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', category: 'text', provider: 'cccapi', description: 'GPT-4.1 nano 极轻量文本与多模态模型' },
  { id: 'gpt-4o', name: 'GPT-4o', category: 'text', provider: 'cccapi', description: 'GPT-4o 通用文本与多模态模型' },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    category: 'text',
    provider: 'cccapi',
    description: 'OpenAI 兼容文本与多模态模型',
    inputModalities: ['text', 'image'],
  },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', category: 'text', provider: 'cccapi', description: 'GPT-4 Turbo 通用文本与多模态模型' },
  { id: 'gpt-4', name: 'GPT-4', category: 'text', provider: 'cccapi', description: 'GPT-4 通用文本模型', inputModalities: ['text'] },
  { id: 'codex-auto-review', name: 'Codex Auto Review', category: 'text', provider: 'cccapi', description: 'Codex 自动代码评审模型' },
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    category: 'image',
    provider: 'cccapi',
    description: 'OpenAI 兼容图片生成模型',
    imageReferenceRequestMode: 'edits-multipart',
  },
  { id: 'gpt-image-1', name: 'GPT Image 1', category: 'image', provider: 'cccapi', description: 'OpenAI 兼容图片生成模型（上一代）' },
];

const SORA2U_HIDDEN_MODEL_IDS = [
  'seedance-2.5',
  'seedance-2.5-character',
  'seedance-2.5-character-mono',
] as const;
const SORA2U_HIDDEN_MODEL_ID_SET = new Set<string>(SORA2U_HIDDEN_MODEL_IDS);

export const WEB_SEARCH_PROVIDER_IDS: readonly WebSearchProviderId[] = [
  'tavily',
  'bocha',
  'zhipu-search',
  'exa',
];

const BUILT_IN_PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'apimart',
    name: 'APIMart',
    description: 'OpenAI 兼容的多类型模型服务',
    badgeText: 'AM',
    authType: 'api-key',
    catalogAdapter: 'openai-compatible',
    defaultBaseUrl: APIMART_BASE_URL,
    modelsPath: '/models',
    allowCustomBaseUrl: false,
    credentials: [
      API_KEY_FIELD,
      { key: 'baseUrl', label: '接口地址', required: false, placeholder: APIMART_BASE_URL },
    ],
  },
  {
    id: 'cccapi',
    name: 'CCC API',
    description: '群内大佬自建自用中转！平价对接，纯公益不赚一分钱✅，稳定、速度快、出图质量高',
    badgeText: 'CCC',
    authType: 'api-key',
    catalogAdapter: 'openai-compatible',
    defaultBaseUrl: CCCAPI_BASE_URL,
    modelsPath: '/models',
    allowCustomBaseUrl: false,
    externalUrl: 'https://cccapi.cn',
    credentials: [
      { ...API_KEY_FIELD, placeholder: 'sk-...' },
    ],
    models: CCCAPI_MODEL_MANIFEST,
  },
  {
    id: 'xai',
    name: 'xAI / Grok 官方',
    description: 'Grok 官方文本、图片与视频模型',
    badgeText: 'xAI',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: XAI_BASE_URL,
    credentials: [
      { ...API_KEY_FIELD, placeholder: 'xai-...' },
    ],
    models: XAI_MODEL_MANIFEST,
  },
  {
    id: 'google',
    name: 'Google Gemini 官方',
    description: 'Gemini 文本、Nano Banana 图片、Omni/Veo 视频与 TTS',
    badgeText: 'G',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: GOOGLE_GEMINI_BASE_URL,
    credentials: [
      { ...API_KEY_FIELD, placeholder: 'Google AI Studio API Key' },
    ],
    models: GOOGLE_MODEL_MANIFEST,
  },
  {
    id: 'sora2u',
    name: 'Sora2U',
    description: 'Seedance 全模态视频与 Gemini/Kontext 图片模型',
    badgeText: 'S2U',
    authType: 'api-key',
    catalogAdapter: 'openai-compatible',
    defaultBaseUrl: SORA2U_BASE_URL,
    modelsPath: '/api/v1/models',
    allowCustomBaseUrl: false,
    externalUrl: 'https://sora2u.com/?utm_source=tenney&utm_medium=canvas&utm_content=wx',
    connectionTestPath: '/api/v1/credits',
    requestQuery: SORA2U_REQUEST_QUERY,
    hiddenModelIds: SORA2U_HIDDEN_MODEL_IDS,
    credentials: [
      { ...API_KEY_FIELD, placeholder: 'sk_sora_...' },
    ],
    models: SORA2U_MODEL_MANIFEST.filter((model) => !SORA2U_HIDDEN_MODEL_ID_SET.has(model.id)),
  },
  {
    id: 'volcengine',
    name: '火山方舟',
    description: '火山引擎方舟模型服务',
    badgeText: 'V',
    authType: 'api-key',
    catalogAdapter: 'openai-compatible',
    defaultBaseUrl: VOLCENGINE_BASE_URL,
    modelsPath: '/models',
    allowCustomBaseUrl: false,
    credentials: [
      API_KEY_FIELD,
      { key: 'baseUrl', label: '接口地址', required: false, placeholder: VOLCENGINE_BASE_URL },
    ],
  },
  {
    id: 'runninghub-model',
    name: 'RunningHub',
    description: 'RunningHub 标准模型 API 与工作流',
    badgeText: 'RH',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: RUNNINGHUB_MODEL_BASE_URL,
    credentials: [{
      ...API_KEY_FIELD,
      label: '企业级-共享 API Key',
      placeholder: '用于 RunningHub 标准模型 API',
    }],
  },
  {
    id: 'grsai',
    name: 'GRSAI',
    description: '图像生成与多模态文本模型服务',
    badgeText: 'GR',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: GRSAI_BASE_URL,
    allowCustomBaseUrl: false,
    credentials: [
      API_KEY_FIELD,
      { key: 'baseUrl', label: '接口地址', required: false, placeholder: GRSAI_BASE_URL },
    ],
  },
  {
    id: 'dreamina',
    name: '即梦',
    description: '通过官方 OAuth 登录使用即梦模型',
    badgeText: 'JM',
    authType: 'oauth',
    catalogAdapter: 'local-manifest',
    credentials: [],
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description: '面向 AI Agent 的搜索与来源服务',
    badgeText: 'TV',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: TAVILY_BASE_URL,
    credentials: [{ ...API_KEY_FIELD, placeholder: 'tvly-...' }],
    kind: 'web-search',
  },
  {
    id: 'bocha',
    name: '博查 Web Search',
    description: '国内网络环境友好的结构化搜索服务',
    badgeText: 'BC',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: BOCHA_SEARCH_BASE_URL,
    credentials: [{ ...API_KEY_FIELD, placeholder: 'sk-...' }],
    kind: 'web-search',
  },
  {
    id: 'zhipu-search',
    name: '智谱联网搜索',
    description: '智谱开放平台提供的 Web Search API',
    badgeText: 'ZP',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: ZHIPU_SEARCH_BASE_URL,
    credentials: [{ ...API_KEY_FIELD, placeholder: '智谱 API Key' }],
    kind: 'web-search',
  },
  {
    id: 'exa',
    name: 'Exa',
    description: '支持语义检索与网页摘要的搜索服务',
    badgeText: 'EX',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: EXA_SEARCH_BASE_URL,
    credentials: [{ ...API_KEY_FIELD, placeholder: 'Exa API Key' }],
    kind: 'web-search',
  },
  {
    id: 'custom-openai',
    name: '自定义接口',
    description: 'OpenAI 兼容接口；非标准接口用模型的调用协议单独声明',
    badgeText: 'API',
    authType: 'api-key',
    catalogAdapter: 'openai-compatible',
    modelsPath: '/models',
    allowCustomBaseUrl: true,
    credentials: [
      API_KEY_FIELD,
      { key: 'baseUrl', label: '接口地址', required: true },
    ],
  },
];

export function isProviderModelVisible(catalogId: string | undefined, modelId: string): boolean {
  if (!catalogId) return true;
  const definition = BUILT_IN_PROVIDER_DEFINITIONS.find((item) => item.id === catalogId);
  return !definition?.hiddenModelIds?.includes(modelId);
}

const PROVIDER_DEFINITION_MAP = new Map(
  BUILT_IN_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
);

/**
 * 落库的目录缓存上限。catalogModels 只是「下次打开对话框免去重新拉取」的缓存，
 * 而中转站 /models 常返回上千个模型，全量存进 config 会跟着每次 saveConfig
 * 重新序列化一遍。已勾选的模型是真配置，一个都不能丢，超出部分才截断。
 */
export const MAX_CACHED_CATALOG_MODELS = 300;

export function capCatalogModels(
  models: ProviderModelSelection[],
  selectedIds: ReadonlySet<string>,
): ProviderModelSelection[] {
  if (models.length <= MAX_CACHED_CATALOG_MODELS) return models;
  const selected = models.filter((model) => selectedIds.has(model.id));
  const remaining = MAX_CACHED_CATALOG_MODELS - selected.length;
  if (remaining <= 0) return selected;
  return [...selected, ...models.filter((model) => !selectedIds.has(model.id)).slice(0, remaining)];
}

export function getProviderDefinitions(): readonly ProviderDefinition[] {
  return BUILT_IN_PROVIDER_DEFINITIONS;
}

export function isWebSearchProviderId(value: string | undefined): value is WebSearchProviderId {
  return WEB_SEARCH_PROVIDER_IDS.includes(value as WebSearchProviderId);
}

export function getWebSearchProviderDefinitions(): readonly ProviderDefinition[] {
  return BUILT_IN_PROVIDER_DEFINITIONS.filter((definition) => definition.kind === 'web-search');
}

export function resolveWebSearchProviderId(
  config: Pick<AppConfig, 'providers' | 'webSearchProviderId'>,
): WebSearchProviderId | undefined {
  const configured = (providerId: WebSearchProviderId) =>
    Boolean(config.providers[providerId]?.apiKey?.trim());
  if (isWebSearchProviderId(config.webSearchProviderId) && configured(config.webSearchProviderId)) {
    return config.webSearchProviderId;
  }
  if (configured('tavily')) return 'tavily';
  return WEB_SEARCH_PROVIDER_IDS.find(configured);
}

/**
 * 连接 ID：内置厂商每种只允许一条连接，直接用目录 ID；
 * 自定义接口可以有多条，加随机后缀区分。
 */
export function createConnectionId(providerId: string): string {
  if (providerId !== 'custom-openai') return providerId;
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return `custom-${suffix}`;
}

export function getProviderDefinition(
  providerId: string,
  config?: Pick<ApiProviderConfig, 'catalogId'>,
): ProviderDefinition | undefined {
  return PROVIDER_DEFINITION_MAP.get(config?.catalogId || providerId);
}

function inferModelCategory(modelId: string): GeneralModelCategory {
  const id = modelId.toLowerCase();
  if (/tts|speech|audio|music|voice|whisper|transcri/.test(id)) return 'audio';
  // minimax-h3 及其 Context-IR / Regeneration 变体均为视频生成模型；
  // 中转站/自定义目录可能返回 MiniMax_H3、MiniMax H3 等写法，统一按分隔符变体识别。
  if (/video|seedance|sora|veo|kling|hailuo|wan\d|skyreels|vidu|minimax[-\s_.]?h3/.test(id)) return 'video';
  if (/image|seedream|imagen|flux|banana|midjourney|recraft|dall-e/.test(id)) return 'image';
  return 'text';
}

function readCatalogItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.models)) return record.models;
  return [];
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return items.length > 0 ? items : undefined;
}

function readNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  return items.length > 0 ? items : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseVideoCapability(
  record: Record<string, unknown>,
  category: GeneralModelCategory,
): ProviderModelSelection['videoCapability'] {
  if (category !== 'video') return undefined;
  const durations = readNumberArray(record.durations);
  const durationRange = readRecord(record.duration_range ?? record.durationRange);
  const referenceLimits = readRecord(record.reference_limits ?? record.referenceLimits);
  const capability: NonNullable<ProviderModelSelection['videoCapability']> = {
    durations,
    minDuration: readFiniteNumber(durationRange?.min) ?? (durations ? Math.min(...durations) : undefined),
    maxDuration: readFiniteNumber(durationRange?.max) ?? (durations ? Math.max(...durations) : undefined),
    defaultDuration: readFiniteNumber(record.default_duration ?? record.defaultDuration),
    ratios: readStringArray(record.aspect_ratios ?? record.aspectRatios),
    defaultRatio: typeof (record.default_aspect_ratio ?? record.defaultAspectRatio) === 'string'
      ? String(record.default_aspect_ratio ?? record.defaultAspectRatio)
      : undefined,
    resolutions: readStringArray(record.resolutions),
    defaultResolution: typeof (record.default_resolution ?? record.defaultResolution) === 'string'
      ? String(record.default_resolution ?? record.defaultResolution)
      : undefined,
    maxImageReferences: readFiniteNumber(referenceLimits?.image),
    maxVideoReferences: readFiniteNumber(referenceLimits?.video),
    maxAudioReferences: readFiniteNumber(referenceLimits?.audio),
    supportsStandaloneAudio: record.supports_audio === true ? true : undefined,
    requiresReference: record.supports_text_only === false ? true : undefined,
  };
  return Object.values(capability).some((value) => value !== undefined) ? capability : undefined;
}

function parseCatalogItem(
  item: unknown,
  providerId: string,
  protocol: ChatApiProtocol,
): ProviderModelSelection | null {
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? { id, name: id, category: inferModelCategory(id), provider: providerId } : null;
  }
  if (!item || typeof item !== 'object') return null;

  const record = item as Record<string, unknown>;
  const rawId = record.id ?? record.model ?? record.model_id
    ?? (protocol === 'gemini-native' ? record.name : undefined);
  if (typeof rawId !== 'string' || !rawId.trim()) return null;
  const id = protocol === 'gemini-native'
    ? normalizeGeminiModelId(rawId)
    : rawId.trim();
  const rawName = protocol === 'gemini-native'
    ? record.display_name ?? record.displayName
    : record.name ?? record.display_name ?? record.displayName;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : id;
  const category = inferModelCategory(id);
  const supportsImageInput = record.supports_image === true || record.supportsImage === true;
  return {
    id,
    name,
    category,
    provider: providerId,
    inputModalities: supportsImageInput ? ['text', 'image'] : undefined,
    videoCapability: parseVideoCapability(record, category),
  };
}

function normalizeModels(
  models: ProviderModelSelection[],
  providerId: string,
): ProviderModelSelection[] {
  const unique = new Map<string, ProviderModelSelection>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id || unique.has(id)) continue;
    unique.set(id, {
      ...model,
      id,
      name: model.name.trim() || id,
      provider: providerId,
    });
  }
  return [...unique.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN', { sensitivity: 'base' }),
  );
}

function mergeRemoteCatalogMetadata(
  remoteModels: ProviderModelSelection[],
  fallbackModels: ProviderModelSelection[],
): ProviderModelSelection[] {
  const fallbackById = new Map(fallbackModels.map((model) => [model.id, model]));
  return remoteModels.map((remote) => {
    const fallback = fallbackById.get(remote.id);
    if (!fallback) return remote;
    return {
      ...fallback,
      ...remote,
      description: remote.description ?? fallback.description,
      inputModalities: remote.inputModalities ?? fallback.inputModalities,
      executionProfile: remote.executionProfile ?? fallback.executionProfile,
      imageReferenceRequestMode: remote.imageReferenceRequestMode
        ?? fallback.imageReferenceRequestMode,
      videoCapability: remote.videoCapability || fallback.videoCapability
        ? { ...fallback.videoCapability, ...remote.videoCapability }
        : undefined,
    };
  });
}

function safeCatalogError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '模型列表拉取已取消';
  if (error instanceof Error && /^模型列表拉取失败 \(HTTP \d{3}\)$/.test(error.message)) {
    return error.message;
  }
  return '无法连接模型目录，请检查接口地址、网络和 API Key';
}

async function fetchCatalogResponse(
  url: string,
  apiKey: string,
  protocol: ChatApiProtocol,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = apiKey ? getChatApiHeaders(protocol, apiKey, false) : undefined;
  return corsSafeFetch(url, { method: 'GET', headers, signal });
}

async function fetchCatalogAt(
  baseUrl: string,
  definition: ProviderDefinition,
  providerId: string,
  config: ApiProviderConfig,
  signal?: AbortSignal,
): Promise<ProviderModelSelection[]> {
  const url = new URL(`${baseUrl}${definition.modelsPath || '/models'}`);
  for (const [key, value] of Object.entries(definition.requestQuery ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetchCatalogResponse(
    url.toString(),
    config.apiKey,
    resolveChatApiProtocol(config.chatApiProtocol),
    signal,
  );
  if (!response.ok) throw new Error(`模型列表拉取失败 (HTTP ${response.status})`);

  const payload: unknown = await response.json().catch(() => null);
  const models = readCatalogItems(payload)
    .map((item) => parseCatalogItem(item, providerId, resolveChatApiProtocol(config.chatApiProtocol)))
    .filter((item): item is ProviderModelSelection => (
      item !== null && isProviderModelVisible(definition.id, item.id)
    ));
  if (models.length === 0) throw new Error('模型列表拉取失败 (HTTP 200)');
  return normalizeModels(models, providerId);
}

async function fetchOpenAiCompatibleCatalog(
  definition: ProviderDefinition,
  providerId: string,
  config: ApiProviderConfig,
  signal?: AbortSignal,
): Promise<{ models: ProviderModelSelection[]; baseUrl: string }> {
  const candidates = baseUrlCandidates(
    config.baseUrl || definition.defaultBaseUrl,
    resolveChatApiProtocol(config.chatApiProtocol),
  );
  if (candidates.length === 0) throw new Error('请填写接口地址');

  let lastError: unknown;
  for (const baseUrl of candidates) {
    try {
      return {
        models: await fetchCatalogAt(baseUrl, definition, providerId, config, signal),
        baseUrl,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('模型列表拉取失败');
}

export async function fetchProviderModelCatalog(
  options: FetchProviderCatalogOptions,
): Promise<ProviderCatalogResult> {
  const { providerId, config, fallbackModels = [], signal } = options;
  if (signal?.aborted) throw new DOMException('模型列表拉取已取消', 'AbortError');
  const definition = getProviderDefinition(providerId, config);
  if (!definition) throw new Error('未知厂商目录');
  const normalizedFallback = normalizeModels(fallbackModels, providerId)
    .filter((model) => isProviderModelVisible(definition.id, model.id));

  if (definition.catalogAdapter === 'local-manifest') {
    return { models: normalizedFallback, source: 'local-manifest' };
  }

  try {
    const { models, baseUrl } = await fetchOpenAiCompatibleCatalog(
      definition,
      providerId,
      config,
      signal,
    );
    return {
      models: mergeRemoteCatalogMetadata(models, normalizedFallback),
      source: 'remote',
      resolvedBaseUrl: baseUrl,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const warning = safeCatalogError(error);
    if (normalizedFallback.length > 0) {
      return { models: normalizedFallback, source: 'local-fallback', warning };
    }
    throw new Error(warning, { cause: error });
  }
}
