import type {
  ApiProviderConfig,
  GeneralModelCategory,
  ProviderModelSelection,
} from '../../types';
import type { ModelExecutionProfile } from '../../types/aiTypes';
import {
  analyzeModelProtocolExamples,
  type ModelProtocolExamples,
} from '../ai/modelProtocolImport';
import { validateModelExecutionProtocol } from '../ai/modelProtocol';

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

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
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
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/$/, '');
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
  return {
    baseUrl: normalizeBaseUrl(result.baseUrl),
    selection: {
      id: result.modelId,
      name: displayName || result.modelId,
      category: result.category ?? examples.category ?? 'text',
      provider: connectionId,
      executionProfile,
    },
  };
}

export function summarizeProviderConfigDraft(draft: ProviderConfigDraft): string {
  const models = draft.config.selectedModels ?? [];
  const categoryLabels: Record<GeneralModelCategory, string> = {
    text: '文本',
    image: '图片',
    video: '视频',
    audio: '音频',
  };
  return [
    `连接：${draft.connectionName}`,
    `地址：${draft.baseUrl}`,
    `模型：${models.map((model) => `${model.name}（${categoryLabels[model.category]}）`).join('、')}`,
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

export function getProviderConfigDraftSummary(draftId: string): string | undefined {
  const draft = drafts.get(draftId);
  if (!draft || draft.expiresAt <= Date.now()) return undefined;
  return draft.summary;
}

export function clearProviderConfigDraftsForTests(): void {
  drafts.clear();
}
