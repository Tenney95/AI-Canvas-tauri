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
  TOAPIS_BASE_URL,
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
import type { NormalizedModelExecutionProtocol } from '../../types/aiTypes';
import { corsSafeFetch } from './httpTransport';
import { baseUrlCandidates } from './providerBaseUrl';
import { APIMART_OMNI_MODELS, APIMART_UPDATED_VIDEO_MODELS, isLegacyApimartOmni } from './apimartVideoModels';
import { getChatApiHeaders, normalizeGeminiModelId, resolveChatApiProtocol } from './chatApiProtocol';
import { XAI_BASE_URL, XAI_MODEL_MANIFEST } from './providers/xaiModelManifest';
import { GRSAI_ADDED_MODELS } from './grsaiModels';
import { matchToapisCatalog, TOAPIS_MODEL_MANIFEST } from './providers/toapisModelManifest';
import { filterCccGroupModels } from './cccProviderGroups';
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
  kind?: 'model' | 'web-search' | 'workflow-api';
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

// CCC 的 Gemini 渠道沿用 generateContent；鉴权用中转 Key，不复用 Google 直连协议。
// https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/server/routes/gateway.go
function cccGeminiImageProtocol(supportsImageSize: boolean): NormalizedModelExecutionProtocol {
  return {
    version: 2, mode: 'sync', auth: { type: 'bearer' },
    submit: {
      method: 'POST', path: '/v1beta/models/{{model}}:generateContent', pathMode: 'origin',
      body: {
        contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: '{{aspectRatio}}',
            ...(supportsImageSize ? { imageSize: '{{imageSize}}' } : {}),
          },
        },
      },
    },
    response: {
      type: 'json', errorPath: 'error.message',
      result: { base64Path: 'candidates.*.content.parts.*.inlineData.data', mimeType: 'image/png' },
    },
  };
}

/**
 * 未填写 API Key 时展示的目录；填写后仍以远端 /models 为准。
 * 模型 ID 取自 CCC 模型广场和渠道页（2026-10-02），保留厂商的大小写与别名。
 * inputModalities 只在与按 ID 猜模态的兜底规则不一致时才显式声明，
 * 避免把 gpt-4 / o3-mini 这类纯文本模型误判成能吃图。
 */
const CCCAPI_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  ...[
    'DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Qwen3.8-Flash', 'mI MiMo-V2.5', 'Hy3',
    'claude-3-5-haiku', 'claude-3-5-sonnet', 'claude-3-7-sonnet',
    'claude-haiku-4-5', 'claude-haiku-4.5',
    'claude-sonnet-4', 'claude-sonnet-4-5', 'claude-sonnet-4.5',
    'claude-sonnet-4-6', 'claude-sonnet-4.6', 'claude-sonnet-5',
    'claude-opus-4', 'claude-opus-4-1', 'claude-opus-4-5',
    'claude-opus-4-6', 'claude-opus-4.6', 'claude-opus-4-7', 'claude-opus-4-8',
    'claude-opus-5', 'claude-fable-5',
    'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-pro',
    'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash',
    'gemini-3.1-flash-lite', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    'gemini-3.5-flash', 'gemini-3.5-flash-lite',
    'grok-3-mini', 'grok-3-mini-fast', 'grok-code-fast', 'grok-code-fast-1',
    'grok-4.3', 'grok-4.5', 'grok-4.5-latest', 'grok-4.20-multi-agent',
    'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning',
    'grok-build', 'grok-build-0.1',
  ].map((id): ProviderModelSelection => ({
    id, name: id, category: 'text', provider: 'cccapi',
    description: 'CCC 中转文本模型，使用共享 OpenAI 对话协议',
    executionProfile: { preset: 'openai-chat' },
    // 目录没有声明视觉能力时，先按文本输入接入。
    inputModalities: ['text'],
  })),
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
    id: 'gpt-image-2.5', name: 'GPT Image 2.5', category: 'image', provider: 'cccapi',
    description: 'OpenAI 兼容图片生成与编辑模型', imageReferenceRequestMode: 'edits-multipart',
  },
  ...[
    'gemini-3-pro-image-preview', 'gemini-3-pro-image', 'gemini-3.1-flash-image',
    'gemini-2.5-flash-image', 'nano-banana2', 'nano-banana-pro',
  ].map((id): ProviderModelSelection => ({
    id, name: id, category: 'image', provider: 'cccapi',
    description: 'CCC Gemini 原生文生图（当前不接收参考图）',
    inputModalities: ['text'],
    executionProfile: { preset: 'custom', protocol: cccGeminiImageProtocol(id !== 'gemini-2.5-flash-image') },
  })),
  {
    id: 'gpt-image-2.5-flare',
    name: 'GPT Image 2.5 Flare',
    category: 'image',
    provider: 'cccapi',
    description: '速度优先的轻量图片模型，支持文生图与图片编辑',
    imageReferenceRequestMode: 'edits-multipart',
  },
  {
    id: 'gpt-image-2.5-sunburst',
    name: 'GPT Image 2.5 Sunburst',
    category: 'image',
    provider: 'cccapi',
    description: '质量优先的高画质图片模型，支持文生图与图片编辑',
    imageReferenceRequestMode: 'edits-multipart',
  },
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
    id: 'workflow-api', name: '工作流 API', kind: 'workflow-api',
    description: '自定义平台、工作流路径、输入参数与结果映射', badgeText: 'WF',
    authType: 'api-key', catalogAdapter: 'local-manifest',
    credentials: [{ ...API_KEY_FIELD, label: 'API Key / Token', required: false, placeholder: '填写平台提供的密钥' },
      { key: 'baseUrl', label: '接口地址', required: true, placeholder: 'https://api.example.com' }],
  },
  {
    id: 'apimart',
    name: 'APIMart',
    description: '模型覆盖全面，价格适中。注册需使用境外网络，日常生成在国内网络环境下即可使用。',
    badgeText: 'AM',
    authType: 'api-key',
    catalogAdapter: 'openai-compatible',
    defaultBaseUrl: APIMART_BASE_URL,
    modelsPath: '/models',
    // Context-IR 返回提示词文本，Regeneration 需要源任务 ID；两者不能作为普通视频模型新接入。
    hiddenModelIds: ['MiniMax-H3-Context-IR', 'MiniMax-H3-Regeneration'],
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
    externalUrl: 'https://cccapi.cn/keys',
    credentials: [
      { ...API_KEY_FIELD, placeholder: 'sk-...' },
    ],
    models: CCCAPI_MODEL_MANIFEST,
  },
  {
    id: 'toapis', name: 'ToAPIs',
    description: '国内站与国际站共用账号和 API Key，按所选站点拉取可用模型。',
    badgeText: 'T', authType: 'api-key', catalogAdapter: 'openai-compatible',
    defaultBaseUrl: TOAPIS_BASE_URL, modelsPath: '/models', allowCustomBaseUrl: false,
    externalUrl: 'https://toapis.cn/login?aff=SnMr',
    credentials: [{ ...API_KEY_FIELD, placeholder: 'sk-...' }], models: TOAPIS_MODEL_MANIFEST,
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
    description: '图像、视频与多模态文本模型服务',
    badgeText: 'GR',
    authType: 'api-key',
    catalogAdapter: 'local-manifest',
    defaultBaseUrl: GRSAI_BASE_URL,
    allowCustomBaseUrl: false,
    models: GRSAI_ADDED_MODELS,
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
  if (catalogId === 'apimart') {
    if (isLegacyApimartOmni(modelId)) return false;
    const normalized = modelId.trim().toLowerCase();
    if (normalized === 'minimax-h3-context-ir' || normalized === 'minimax-h3-regeneration') {
      return false;
    }
  }
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
 * CCC 分组、自定义接口与工作流允许多条连接，各自使用独立的凭据身份。
 */
export function createConnectionId(providerId: string): string {
  if (!['custom-openai', 'workflow-api', 'cccapi'].includes(providerId)) return providerId;
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return `${providerId === 'custom-openai' ? 'custom' : providerId}-${suffix}`;
}

export function getProviderDefinition(
  providerId: string,
  config?: Pick<ApiProviderConfig, 'catalogId'>,
): ProviderDefinition | undefined {
  const id = config?.catalogId || providerId;
  return PROVIDER_DEFINITION_MAP.get(id === 'autodl-workflow' ? 'workflow-api' : id);
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

function parseImageCapability(record: Record<string, unknown>, category: GeneralModelCategory): ProviderModelSelection['imageCapability'] {
  if (category !== 'image') return undefined;
  const declared = readRecord(record.imageCapability ?? record.image_capability) ?? record;
  const limit = readRecord(declared.reference_limits ?? declared.referenceLimits);
  const boolean = (value: unknown) => typeof value === 'boolean' ? value : undefined;
  const capability: NonNullable<ProviderModelSelection['imageCapability']> = {
    resolutions: readStringArray(declared.resolutions),
    defaultResolution: typeof (declared.defaultResolution ?? declared.default_resolution) === 'string'
      ? String(declared.defaultResolution ?? declared.default_resolution) : undefined,
    ratios: readStringArray(declared.ratios ?? declared.aspect_ratios ?? declared.aspectRatios),
    defaultRatio: typeof (declared.defaultRatio ?? declared.default_aspect_ratio) === 'string'
      ? String(declared.defaultRatio ?? declared.default_aspect_ratio) : undefined,
    supportsBatch: boolean(declared.supportsBatch ?? declared.supports_batch),
    maxBatchCount: readFiniteNumber(declared.maxBatchCount ?? declared.max_batch_count),
    supportsImageReference: boolean(declared.supportsImageReference ?? declared.supports_image_reference),
    maxImageReferences: readFiniteNumber(declared.maxImageReferences ?? limit?.image),
    supportsDataUrlReference: boolean(declared.supportsDataUrlReference ?? declared.supports_data_url_reference),
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
    imageCapability: parseImageCapability(record, category),
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
      imageCapability: remote.imageCapability ?? fallback.imageCapability,
      videoCapability: remote.videoCapability || fallback.videoCapability
        ? { ...fallback.videoCapability, ...remote.videoCapability }
        : undefined,
    };
  });
}

// 这些是界面版本选择 ID；执行时仍提交主模型 + version，不能绕过当前 Key 的目录。
const APIMART_MUSIC_VERSION_PARENTS: Readonly<Record<string, string>> = {
  'flowmusic-lyria-3.5': 'flowmusic',
  'suno-v6': 'suno',
  'suno-v6-wild': 'suno',
  'suno-v6-mini': 'suno',
};

function expandApimartCatalog(
  models: ProviderModelSelection[],
  fallbackModels: ProviderModelSelection[],
  providerId: string,
): ProviderModelSelection[] {
  const availableIds = new Set(models.map((model) => model.id));
  return [
    ...models.map((remote) => {
      const known = [...APIMART_OMNI_MODELS, ...APIMART_UPDATED_VIDEO_MODELS]
        .find((model) => model.id === remote.id);
      if (known) return { ...remote, ...known, provider: providerId };
      return remote.id === 'suno' ? { ...remote, category: 'audio' as const } : remote;
    }),
    ...APIMART_OMNI_MODELS.filter((model) => fallbackModels.some((item) => item.id === model.id)
      && !availableIds.has(model.id)).map((model) => ({ ...model, provider: providerId })),
    ...fallbackModels.filter((model) => {
      const parent = APIMART_MUSIC_VERSION_PARENTS[model.id];
      return parent && availableIds.has(parent) && !availableIds.has(model.id);
    }),
  ];
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

  if (definition.id === 'runninghub-model') {
    const { RUNNINGHUB_MODEL_MANIFEST, RUNNINGHUB_LEGACY_MODELS, getRunningHubModel, normalizeRunningHubModelId } = await import('./providers/runninghubModelManifest');
    const models = new Map<string, ProviderModelSelection>();
    for (const id of Object.keys(RUNNINGHUB_LEGACY_MODELS)) {
      const model = getRunningHubModel(id)!;
      models.set(id, { id, name: id, provider: 'runninghub', category: model.kind, description: '兼容已有选择；按图片引用自动切换生成或编辑' });
    }
    for (const model of normalizedFallback) {
      const id = normalizeRunningHubModelId(model.id);
      if (getRunningHubModel(id)) models.set(id, { ...model, id });
    }
    for (const model of RUNNINGHUB_MODEL_MANIFEST) models.set(model.id, {
      id: model.id, name: model.label, provider: 'runninghub', category: model.kind, description: model.id,
      inputModalities: [...new Set(model.parameters.flatMap((field) => field.binding === 'prompt' ? ['text' as const] : field.mediaKind === 'image' ? ['image' as const] : []))],
    });
    return { models: [...models.values()], source: 'local-manifest' };
  }
  if (definition.catalogAdapter === 'local-manifest') {
    return { models: definition.id === 'grsai'
      ? mergeRemoteCatalogMetadata(normalizedFallback, [...GRSAI_ADDED_MODELS])
      : normalizedFallback, source: 'local-manifest' };
  }

  try {
    const { models, baseUrl } = await fetchOpenAiCompatibleCatalog(
      definition,
      providerId,
      config,
      signal,
    );
    const matchedToapis = definition.id === 'toapis' ? matchToapisCatalog(models) : undefined;
    const catalogModels = mergeRemoteCatalogMetadata(
      definition.id === 'apimart'
        ? expandApimartCatalog(models, normalizedFallback, providerId)
        : matchedToapis || models,
      normalizedFallback,
    );
    return {
      models: definition.id === 'cccapi' ? filterCccGroupModels(catalogModels, config.cccGroup) : catalogModels,
      source: 'remote',
      resolvedBaseUrl: baseUrl,
      ...(matchedToapis && models.some((model) => model.category !== 'text' && !matchedToapis.some((known) => known.id === model.id))
        ? { warning: '已获取当前站点目录，仅展示已适配的媒体型号及指定文本型号；尚无完整调用合同的型号暂不展示。' } : {}),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const warning = safeCatalogError(error);
    // CCC 分组权限由 Key 决定，不能用全站目录伪装成该 Key 的可用模型。
    if (definition.id !== 'toapis' && !(definition.id === 'cccapi' && config.cccGroup) && normalizedFallback.length > 0) {
      return { models: normalizedFallback, source: 'local-fallback', warning };
    }
    throw new Error(warning, { cause: error });
  }
}
