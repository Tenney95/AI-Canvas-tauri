/**
 * 创建和管理任务级 Provider 配置草稿，负责协议示例分析、字段裁剪与凭据排除。
 * 草稿有数量和存活期限制，不直接写入正式配置。
 */
import type {
  ApiProviderConfig,
  GeneralModelCategory,
  ImageReferenceRequestMode,
  ProviderModelSelection,
} from '../../types';
import { GENERAL_MODEL_CATEGORY_LABELS } from '../../types';
import type { ModelExecutionProfile, VideoModelCapability } from '../../types/aiTypes';
import {
  analyzeModelProtocolExamples,
  type ModelProtocolExamples,
} from '../ai/modelProtocolImport';
import {
  modelProtocolUsesVariable,
  resolveModelExecutionProfile,
  validateModelExecutionProtocol,
} from '../ai/modelProtocol';
import {
  REFERENCE_PROTOCOL_VARIABLES,
  getCategoryProtocolVariables,
} from '../ai/modelProtocolVariables';
import { normalizeBaseUrl as normalizeUrlInput } from '../ai/providerBaseUrl';

const PROVIDER_CONFIG_DRAFT_TTL_MS = 30 * 60 * 1_000;
const MAX_PROVIDER_CONFIG_DRAFTS = 32;
const DOCUMENTATION_HOST_LABELS = new Set(['doc', 'docs', 'documentation', 'developer']);
const CREDENTIAL_FIELD_NAMES = new Set([
  'apikey',
  'authorization',
  'credential',
  'credentials',
  'password',
  'secret',
  'token',
]);

export interface ProviderConfigModelExamples extends ModelProtocolExamples {
  modelId?: string;
  name?: string;
  category?: GeneralModelCategory;
  /** 文档里的模型用途说明，显示在模型选择器里。 */
  description?: string;
  /** 文档声明的输入模态；含 'image' 表示该文本模型可读图。 */
  inputModalities?: Array<'text' | 'image'>;
  imageReferenceRequestMode?: ImageReferenceRequestMode;
  videoCapability?: VideoModelCapability;
}

export interface ProviderConfigDraftInput {
  connectionId?: string;
  connectionName: string;
  baseUrl?: string;
  models: ProviderConfigModelExamples[];
}

export type ProviderConfigDraftConfig = Omit<ApiProviderConfig, 'apiKey'>;

export interface ProviderConfigDraft {
  id: string;
  taskId: string;
  connectionId: string;
  connectionName: string;
  baseUrl: string;
  config: ProviderConfigDraftConfig;
  summary: string;
  createdAt: number;
  expiresAt: number;
}

const drafts = new Map<string, ProviderConfigDraft>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCredentialFieldName(value: string): string {
  return value.replace(/[\s_-]/g, '').toLowerCase();
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    CREDENTIAL_FIELD_NAMES.has(normalizeCredentialFieldName(key))
    || containsCredentialField(child)
  ));
}

function createOpaqueId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}`;
}

function normalizeConnectionId(value?: string): string {
  const candidate = value?.trim();
  if (!candidate) return createOpaqueId('custom');
  if (!/^custom-[a-zA-Z0-9_-]{1,56}$/.test(candidate)) {
    throw new Error('Agent 只能新建或更新 custom-* 自定义接口连接');
  }
  return candidate;
}

/**
 * Agent 侧的 Base URL 规范化：先走和设置页同一套清理（补协议、去尾斜杠、
 * 剥掉助手常从文档里照抄的 /chat/completions 之类端点后缀），再做这里独有的
 * 安全校验——助手的输入来自它读到的网页，比用户手输的更不可信，
 * 所以 HTTPS、默认端口、非文档站这几条限制一条都不放宽。
 */
function normalizeBaseUrl(value: string): string {
  const url = new URL(normalizeUrlInput(value) || value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('厂商 Base URL 必须是无凭据的 HTTPS 地址');
  }
  if (url.port && url.port !== '443') {
    throw new Error('厂商 Base URL 只允许使用 HTTPS 默认端口');
  }
  const firstHostLabel = url.hostname.toLowerCase().split('.')[0];
  if (DOCUMENTATION_HOST_LABELS.has(firstHostLabel)) {
    throw new Error('厂商 Base URL 不能使用文档站地址，请提供实际 API 网关地址');
  }
  return url.toString().replace(/\/$/, '');
}

function pruneExpiredDrafts(now: number): void {
  for (const [draftId, draft] of drafts) {
    if (draft.expiresAt <= now) drafts.delete(draftId);
  }
  while (drafts.size >= MAX_PROVIDER_CONFIG_DRAFTS) {
    const oldestDraftId = drafts.keys().next().value as string | undefined;
    if (!oldestDraftId) break;
    drafts.delete(oldestDraftId);
  }
}

function createModelSelection(
  connectionId: string,
  examples: ProviderConfigModelExamples,
  declaredBaseUrl?: string,
): { selection: ProviderModelSelection; baseUrl: string } {
  const explicitModelId = examples.modelId?.trim()
    || (examples.name && !/\s/.test(examples.name.trim()) ? examples.name.trim() : undefined);
  const result = analyzeModelProtocolExamples(examples, {
    category: examples.category,
    modelId: explicitModelId,
    baseUrl: declaredBaseUrl,
  });
  const displayName = examples.name?.trim() || explicitModelId || result.modelId;
  const diagnostic = result.warnings[0] ? `：${result.warnings[0]}` : '';
  if (!result.baseUrl) {
    throw new Error(`模型“${displayName || '未命名模型'}”未识别到 Base URL${diagnostic}`);
  }
  if (!result.modelId) throw new Error(`模型“${displayName || '未命名模型'}”未识别到模型 ID`);
  if (!result.protocol) {
    throw new Error(`模型“${displayName || result.modelId}”无法生成有效调用协议${diagnostic}`);
  }
  const protocolErrors = validateModelExecutionProtocol(result.protocol);
  if (protocolErrors.length > 0) {
    throw new Error(`模型“${displayName || result.modelId}”协议校验失败：${protocolErrors[0]}`);
  }
  const executionProfile: ModelExecutionProfile = {
    preset: 'custom',
    protocol: result.protocol,
  };
  const category = result.category ?? examples.category ?? 'text';
  const imageReferenceRequestMode = examples.imageReferenceRequestMode
    ?? result.imageReferenceRequestMode;
  if (imageReferenceRequestMode && category !== 'image') {
    throw new Error(`模型“${displayName || result.modelId}”只有图片分类可以配置参考图请求协议`);
  }
  // 能力声明只对视频模型生效：参数面板据此约束时长 / 比例 / 分辨率 / 参考素材数量
  if (examples.videoCapability && category !== 'video') {
    throw new Error(`模型“${displayName || result.modelId}”只有视频分类可以声明 videoCapability`);
  }
  const description = examples.description?.trim().slice(0, 500);
  const inputModalities = examples.inputModalities?.length
    ? [...new Set(['text' as const, ...examples.inputModalities])]
    : undefined;
  if (inputModalities && category !== 'text') {
    throw new Error(`模型“${displayName || result.modelId}”只有文本分类可以声明 inputModalities`);
  }
  return {
    baseUrl: normalizeBaseUrl(result.baseUrl),
    selection: {
      id: result.modelId,
      name: displayName || result.modelId,
      category,
      provider: connectionId,
      executionProfile,
      // 助手按文档定下的分类比拉取目录时的 ID 正则更准，标成手动避免下次刷新被改回去
      ...(examples.category ? { categoryManual: true } : {}),
      ...(description ? { description, descriptionManual: true } : {}),
      ...(inputModalities ? { inputModalities, inputModalitiesManual: true } : {}),
      ...(imageReferenceRequestMode ? { imageReferenceRequestMode } : {}),
      ...(examples.videoCapability ? { videoCapability: examples.videoCapability } : {}),
    },
  };
}

export interface ProviderModelMergeResult {
  /** 合并后的模型列表：保留原有模型，同 ID 由草稿覆盖，新模型追加在后。 */
  merged: ProviderModelSelection[];
  /** 草稿中原本不存在的模型 ID。 */
  addedIds: string[];
  /** 草稿覆盖了同 ID 原有模型的模型 ID。 */
  updatedIds: string[];
  /** 同 ID 且配置逐字段相同、原样跳过的模型 ID。 */
  unchangedIds: string[];
  /** 本次未涉及、原样保留的模型 ID。 */
  keptIds: string[];
}

/** 键序无关的稳定序列化，用于判断草稿模型与已有模型是否逐字段相同。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 把草稿模型并入已有连接，而不是整体替换。
 *
 * 用户说「给这个连接再加一个模型」时，草稿里只有那一个模型；直接替换会静默
 * 删掉该连接下其余模型和它们在 generalModels 中的关联项。
 * 同 ID 且配置完全相同的模型原样跳过，避免助手重复对接时把审批卡刷成一堆「更新」。
 */
export function mergeProviderModels(
  existingModels: ProviderModelSelection[] | undefined,
  draftModels: ProviderModelSelection[],
): ProviderModelMergeResult {
  const existing = existingModels ?? [];
  const draftById = new Map(draftModels.map((model) => [model.id, model]));
  const existingById = new Map(existing.map((model) => [model.id, model]));

  const isUnchanged = (model: ProviderModelSelection) => {
    const previous = existingById.get(model.id);
    return previous !== undefined && stableStringify(previous) === stableStringify(model);
  };

  const merged = existing.map((model) => {
    const draft = draftById.get(model.id);
    return draft && !isUnchanged(draft) ? draft : model;
  });
  const addedIds: string[] = [];
  for (const model of draftModels) {
    if (existingById.has(model.id)) continue;
    merged.push(model);
    addedIds.push(model.id);
  }

  return {
    merged,
    addedIds,
    updatedIds: draftModels
      .filter((model) => existingById.has(model.id) && !isUnchanged(model))
      .map((model) => model.id),
    unchangedIds: draftModels.filter(isUnchanged).map((model) => model.id),
    keptIds: existing.filter((model) => !draftById.has(model.id)).map((model) => model.id),
  };
}

/** 合并结果的中文说明，用于审批卡与回传模型的观察结果。 */
export function describeProviderModelMerge(result: ProviderModelMergeResult): string {
  const parts = [
    result.addedIds.length > 0 ? `新增 ${result.addedIds.length} 个模型` : '',
    result.updatedIds.length > 0 ? `更新 ${result.updatedIds.length} 个同 ID 模型` : '',
    result.unchangedIds.length > 0
      ? `跳过 ${result.unchangedIds.length} 个已存在且配置相同的模型（${result.unchangedIds.join('、')}）`
      : '',
    result.keptIds.length > 0 ? `保留原有 ${result.keptIds.length} 个模型` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('，') : '模型列表无变化';
}

/**
 * 图片 / 视频模型的协议里一个参考素材字段都没有时给出提示。
 * 中转站文档常常只给纯文生图 / 文生视频示例，照抄出来的配置在画布上连了参考图
 * 也发不出去；这个信息要出现在审批卡和回传给模型的摘要里，而不是等生成时才发现。
 */
function describeReferenceGap(model: ProviderModelSelection): string {
  const { category } = model;
  if (category !== 'image' && category !== 'video') return '';
  // 图片模型显式声明了参考图请求协议时走标准通道，不看模板
  if (model.imageReferenceRequestMode) return '';
  const protocol = resolveModelExecutionProfile(model.executionProfile);
  if (!protocol) return '';
  const supported = getCategoryProtocolVariables(category);
  const variables = REFERENCE_PROTOCOL_VARIABLES.filter((name) => supported.includes(name));
  return modelProtocolUsesVariable(JSON.stringify(protocol), ...variables)
    ? ''
    : '，无参考素材字段';
}

export function summarizeProviderConfigDraft(draft: ProviderConfigDraft): string {
  const models = draft.config.selectedModels ?? [];
  const referenceModeLabels: Record<ImageReferenceRequestMode, string> = {
    'generation-json-image-urls': '公网 URL 数组',
    'generation-json-image-data-urls': 'data URL 数组',
    'edits-multipart': 'Multipart 图片文件',
  };
  return [
    `连接：${draft.connectionName}`,
    `地址：${draft.baseUrl}`,
    `模型：${models.map((model) => (
      `${model.name}（${GENERAL_MODEL_CATEGORY_LABELS[model.category]}${model.inputModalities?.includes('image')
        ? '，可读图'
        : ''}${model.imageReferenceRequestMode
        ? `，参考图：${referenceModeLabels[model.imageReferenceRequestMode]}`
        : ''}${describeReferenceGap(model)}）`
    )).join('、')}`,
    '不会写入 API Key：新连接保持空白，已有连接保留原值',
  ].join('\n');
}

export function createProviderConfigDraft(
  taskId: string,
  input: ProviderConfigDraftInput,
  now = Date.now(),
): ProviderConfigDraft {
  if (containsCredentialField(input)) {
    throw new Error('配置草稿不得包含 API Key 或其他凭据字段');
  }
  const normalizedTaskId = taskId.trim();
  const connectionName = input.connectionName?.trim();
  if (!normalizedTaskId) throw new Error('Agent 任务 ID 不能为空');
  if (!connectionName) throw new Error('厂商连接名称不能为空');
  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new Error('至少需要一个模型的请求和响应示例');
  }

  const connectionId = normalizeConnectionId(input.connectionId);
  const declaredBaseUrl = input.baseUrl?.trim() ? normalizeBaseUrl(input.baseUrl) : undefined;
  const analyzed = input.models.map((examples) => (
    createModelSelection(connectionId, examples, declaredBaseUrl)
  ));
  const baseUrl = analyzed[0].baseUrl;
  if (analyzed.some((item) => item.baseUrl !== baseUrl)) {
    throw new Error('同一个厂商配置中的模型必须使用同一个 Base URL');
  }
  const modelIds = new Set<string>();
  for (const { selection } of analyzed) {
    if (modelIds.has(selection.id)) throw new Error(`模型 ID 重复：${selection.id}`);
    modelIds.add(selection.id);
  }
  const selectedModels = analyzed.map((item) => item.selection);
  const visibleModelCategories = [...new Set(selectedModels.map((model) => model.category))];
  const draftId = createOpaqueId('provider-draft');
  const draft: ProviderConfigDraft = {
    id: draftId,
    taskId: normalizedTaskId,
    connectionId,
    connectionName,
    baseUrl,
    config: {
      name: connectionName,
      baseUrl,
      catalogId: 'custom-openai',
      selectedModels,
      catalogModels: selectedModels.map((model) => ({ ...model })),
      visibleModelCategories,
      catalogUpdatedAt: now,
    },
    summary: '',
    createdAt: now,
    expiresAt: now + PROVIDER_CONFIG_DRAFT_TTL_MS,
  };
  draft.summary = summarizeProviderConfigDraft(draft);
  pruneExpiredDrafts(now);
  drafts.set(draft.id, draft);
  return draft;
}

export function getProviderConfigDraft(
  taskId: string,
  draftId: string,
  now = Date.now(),
): ProviderConfigDraft {
  const draft = drafts.get(draftId);
  if (!draft) throw new Error('厂商配置草稿不存在或已失效');
  if (draft.taskId !== taskId) throw new Error('厂商配置草稿不属于当前 Agent 任务');
  if (draft.expiresAt <= now) {
    drafts.delete(draftId);
    throw new Error('厂商配置草稿已过期，请重新分析文档');
  }
  return draft;
}

export function deleteProviderConfigDraft(taskId: string, draftId: string): void {
  const draft = getProviderConfigDraft(taskId, draftId);
  if (drafts.get(draftId) === draft) drafts.delete(draftId);
}

/**
 * 按 draftId 直查草稿，不做任务归属校验。
 * 仅供只读的摘要展示使用；写入路径必须走带 taskId 校验的 getProviderConfigDraft。
 */
export function peekProviderConfigDraft(draftId: string): ProviderConfigDraft | undefined {
  const draft = drafts.get(draftId);
  if (!draft || draft.expiresAt <= Date.now()) return undefined;
  return draft;
}

export function clearProviderConfigDraftsForTests(): void {
  drafts.clear();
}
