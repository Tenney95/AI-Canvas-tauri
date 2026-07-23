/**
 * Provider model catalog — built-in provider metadata and model-list adapters.
 * Local manifests are supplied by the caller so this service stays independent
 * from component-owned model presentation data.
 */
import {
  APIMART_BASE_URL,
  BOCHA_SEARCH_BASE_URL,
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
  GeneralModelCategory,
  ProviderCatalogAdapter,
  ProviderModelSelection,
  WebSearchProviderId,
} from '../../types';
import { corsSafeFetch } from './httpTransport';

export type ProviderAuthType = 'api-key' | 'oauth';
export type ProviderCredentialKey = 'apiKey' | 'baseUrl' | 'anthropicUrl';

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
  credentials: ProviderCredentialField[];
  /** web-search connections provide Agent capabilities and do not expose models. */
  kind?: 'model' | 'web-search';
}

export interface ProviderCatalogResult {
  models: ProviderModelSelection[];
  source: 'remote' | 'local-manifest' | 'local-fallback';
  warning?: string;
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
    allowCustomBaseUrl: true,
    credentials: [
      API_KEY_FIELD,
      { key: 'baseUrl', label: '接口地址', required: false, placeholder: APIMART_BASE_URL },
    ],
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
    allowCustomBaseUrl: true,
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
    description: '图像生成模型服务',
    badgeText: 'GR',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: GRSAI_BASE_URL,
    allowCustomBaseUrl: true,
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
    description: 'OpenAI 或 Anthropic 兼容接口',
    badgeText: 'API',
    authType: 'api-key',
    catalogAdapter: 'openai-compatible',
    modelsPath: '/models',
    allowCustomBaseUrl: true,
    credentials: [
      API_KEY_FIELD,
      { key: 'baseUrl', label: 'OpenAI 接口地址', required: true },
      { key: 'anthropicUrl', label: 'Anthropic 接口地址', required: false },
    ],
  },
];

const PROVIDER_DEFINITION_MAP = new Map(
  BUILT_IN_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
);

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

export function getProviderDefinition(
  providerId: string,
  config?: Pick<ApiProviderConfig, 'catalogId'>,
): ProviderDefinition | undefined {
  return PROVIDER_DEFINITION_MAP.get(config?.catalogId || providerId);
}

function inferModelCategory(modelId: string): GeneralModelCategory {
  const id = modelId.toLowerCase();
  if (/tts|speech|audio|music|voice|whisper|transcri/.test(id)) return 'audio';
  if (/video|seedance|sora|veo|kling|hailuo|wan\d|skyreels|vidu/.test(id)) return 'video';
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

function parseCatalogItem(item: unknown, providerId: string): ProviderModelSelection | null {
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? { id, name: id, category: inferModelCategory(id), provider: providerId } : null;
  }
  if (!item || typeof item !== 'object') return null;

  const record = item as Record<string, unknown>;
  const rawId = record.id ?? record.model ?? record.model_id;
  if (typeof rawId !== 'string' || !rawId.trim()) return null;
  const id = rawId.trim();
  const rawName = record.name ?? record.display_name ?? record.displayName;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : id;
  return { id, name, category: inferModelCategory(id), provider: providerId };
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
  signal?: AbortSignal,
): Promise<Response> {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  return corsSafeFetch(url, { method: 'GET', headers, signal });
}

async function fetchOpenAiCompatibleCatalog(
  definition: ProviderDefinition,
  providerId: string,
  config: ApiProviderConfig,
  signal?: AbortSignal,
): Promise<ProviderModelSelection[]> {
  const baseUrl = (config.baseUrl || definition.defaultBaseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请填写接口地址');

  const response = await fetchCatalogResponse(
    `${baseUrl}${definition.modelsPath || '/models'}`,
    config.apiKey,
    signal,
  );
  if (!response.ok) throw new Error(`模型列表拉取失败 (HTTP ${response.status})`);

  const payload: unknown = await response.json().catch(() => null);
  const models = readCatalogItems(payload)
    .map((item) => parseCatalogItem(item, providerId))
    .filter((item): item is ProviderModelSelection => item !== null);
  if (models.length === 0) throw new Error('模型列表拉取失败 (HTTP 200)');
  return normalizeModels(models, providerId);
}

export async function fetchProviderModelCatalog(
  options: FetchProviderCatalogOptions,
): Promise<ProviderCatalogResult> {
  const { providerId, config, fallbackModels = [], signal } = options;
  if (signal?.aborted) throw new DOMException('模型列表拉取已取消', 'AbortError');
  const definition = getProviderDefinition(providerId, config);
  if (!definition) throw new Error('未知厂商目录');
  const normalizedFallback = normalizeModels(fallbackModels, providerId);

  if (definition.catalogAdapter === 'local-manifest') {
    return { models: normalizedFallback, source: 'local-manifest' };
  }

  try {
    return {
      models: await fetchOpenAiCompatibleCatalog(definition, providerId, config, signal),
      source: 'remote',
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
