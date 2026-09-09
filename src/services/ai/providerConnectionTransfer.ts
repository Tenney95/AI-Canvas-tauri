/**
 * 连接配置的导出 / 导入。
 *
 * 中转站连接里最花时间的是模型清单和逐个模型的执行协议，导出成一段 JSON 就能分享
 * 或在多台机器间搬运。**导出永远不含 API Key**（凭据在 Rust 侧凭据存储里，配置对象
 * 里的明文只存在于内存），导入端也一律丢弃 payload 里的 apiKey / apiKeyRef，
 * 由用户自己补填。
 *
 * 导入的内容是外部数据：模型协议里的自定义请求会带着用户的 API Key 发出去，
 * 所以这里按白名单挑字段、规范化 Base URL，并用 validateModelExecutionProtocol
 * 丢掉非法协议（协议里的 path 只允许相对路径，拼在用户可见的 Base URL 上）。
 */
import type {
  ApiProviderConfig,
  ChatApiProtocol,
  GeneralModelCategory,
  ImageReferenceRequestMode,
  ProviderModelSelection,
  WorkflowDefinition,
} from '../../types';
import type { WorkflowApiDraft, WorkflowApiManifest } from '../../types/workflowApi';
import { editableWorkflowApiManifest } from '../workflowApi/workflowApiDefinition';
import { createAutodlH3WorkflowManifest, normalizeWorkflowApiBaseUrl, validateWorkflowApiManifest } from '../workflowApi/autodlWorkflowManifest';
import { GENERAL_MODEL_CATEGORY_LABELS } from '../../types';
import { validateModelExecutionProtocol } from './modelProtocol';
import { normalizeBaseUrl } from './providerBaseUrl';
import { isChatApiProtocol, resolveChatApiProtocol } from './chatApiProtocol';

const SHARE_KIND = 'ai-canvas/provider-connection';
const SHARE_VERSION = 1;

const CATEGORIES = Object.keys(GENERAL_MODEL_CATEGORY_LABELS) as GeneralModelCategory[];
const IMAGE_REFERENCE_MODES: ImageReferenceRequestMode[] = [
  'generation-json-image-urls',
  'generation-json-image-data-urls',
  'edits-multipart',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 序列化一个连接（不含凭据），用于复制到剪贴板分享。 */
export function serializeConnection(config: ApiProviderConfig, workflows: WorkflowDefinition[] = []): string {
  const customWorkflow = ['workflow-api', 'autodl-workflow'].includes(config.catalogId ?? '');
  const workflowApis = customWorkflow ? workflows.filter((workflow) => workflow.adapterType === 'workflow-api').map((workflow) => {
    validateWorkflowApiManifest(workflow.workflowApi);
    return { name: workflow.name, manifest: { ...workflow.workflowApi, connectionId: 'shared-connection' } };
  }) : undefined;
  const manifest = config.catalogId === 'autodl-workflow'
    ? workflows.find((workflow) => workflow.adapterType === 'workflow-api')?.workflowApi ?? createAutodlH3WorkflowManifest('shared-connection') : undefined;
  if (manifest) validateWorkflowApiManifest(manifest);
  return JSON.stringify({
    kind: SHARE_KIND,
    version: SHARE_VERSION,
    ...(manifest ? { workflowApi: { ...manifest, connectionId: 'shared-connection' } } : {}),
    ...(workflowApis?.length ? { workflowApis } : {}),
    connection: {
      name: config.name,
      catalogId: config.catalogId,
      baseUrl: config.baseUrl,
      chatApiProtocol: resolveChatApiProtocol(config.chatApiProtocol),
      selectedModels: config.selectedModels,
      catalogModels: config.catalogModels,
      visibleModelCategories: config.visibleModelCategories,
    },
  }, null, 2);
}

function parseModel(value: unknown): ProviderModelSelection | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  const category = CATEGORIES.includes(value.category as GeneralModelCategory)
    ? value.category as GeneralModelCategory
    : 'text';

  const model: ProviderModelSelection = {
    id,
    name: asString(value.name) || id,
    category,
    // provider 由调用方按新连接 ID 重写，这里先占位
    provider: '',
    categoryManual: value.categoryManual === true,
  };
  const description = asString(value.description);
  if (description) model.description = description.slice(0, 500);
  if (typeof value.contextWindow === 'number' && Number.isFinite(value.contextWindow)) {
    model.contextWindow = Math.max(0, Math.floor(value.contextWindow));
  }
  if (Array.isArray(value.inputModalities)) {
    model.inputModalities = value.inputModalities.filter(
      (item): item is 'text' | 'image' => item === 'text' || item === 'image',
    );
  }
  if (isRecord(value.videoCapability)) {
    model.videoCapability = value.videoCapability as ProviderModelSelection['videoCapability'];
  }
  if (IMAGE_REFERENCE_MODES.includes(value.imageReferenceRequestMode as ImageReferenceRequestMode)) {
    model.imageReferenceRequestMode = value.imageReferenceRequestMode as ImageReferenceRequestMode;
  }

  const profile = value.executionProfile;
  if (isRecord(profile) && typeof profile.preset === 'string') {
    if (profile.preset !== 'custom') {
      model.executionProfile = { preset: profile.preset as never };
    } else if (validateModelExecutionProtocol(profile.protocol).length === 0) {
      model.executionProfile = {
        preset: 'custom',
        protocol: profile.protocol as never,
      };
    }
    // 协议非法就退回预设协议，宁可少一条自定义规则也不让来路不明的请求跑起来
  }
  return model;
}

function parseModels(value: unknown): ProviderModelSelection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(parseModel)
    .filter((model): model is ProviderModelSelection => model !== null);
}

export interface ParsedConnectionShare {
  /** 目录定义 ID（custom-openai / apimart ...）；缺失时按自定义接口处理。 */
  catalogId: string;
  config: ApiProviderConfig;
  workflowApi?: WorkflowApiManifest;
  workflowApiDrafts?: WorkflowApiDraft[];
}

/** 解析剪贴板里的连接 JSON；格式不符返回 null。 */
export function parseConnectionShare(text: string): ParsedConnectionShare | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(payload) || payload.kind !== SHARE_KIND) return null;
  const source = isRecord(payload.connection) ? payload.connection : null;
  if (!source) return null;

  const catalogId = asString(source.catalogId) || 'custom-openai';
  let workflowApi: WorkflowApiManifest | undefined;
  let workflowApiDrafts: WorkflowApiDraft[] | undefined;
  const customWorkflow = ['workflow-api', 'autodl-workflow'].includes(catalogId);
  if (customWorkflow || payload.workflowApi !== undefined || payload.workflowApis !== undefined) {
    try {
      if (!customWorkflow || !asString(source.baseUrl)) return null;
      normalizeWorkflowApiBaseUrl(asString(source.baseUrl), true);
      if (payload.workflowApis !== undefined) {
        if (!Array.isArray(payload.workflowApis) || !payload.workflowApis.length || payload.workflowApis.length > 50) return null;
        workflowApiDrafts = payload.workflowApis.map((item) => {
          if (!isRecord(item) || !asString(item.name) || String(item.name).length > 120) throw new Error('工作流名称无效');
          validateWorkflowApiManifest(item.manifest);
          return { id: crypto.randomUUID(), name: String(item.name), manifest: editableWorkflowApiManifest(item.manifest) };
        });
      } else {
        validateWorkflowApiManifest(payload.workflowApi);
        workflowApi = payload.workflowApi;
        workflowApiDrafts = [{ id: crypto.randomUUID(), name: '导入的工作流', manifest: editableWorkflowApiManifest(workflowApi) }];
      }
    } catch { return null; }
  }
  const chatApiProtocol: ChatApiProtocol = isChatApiProtocol(source.chatApiProtocol)
    ? source.chatApiProtocol
    : 'openai-compatible';
  const visible = Array.isArray(source.visibleModelCategories)
    ? CATEGORIES.filter((item) => (source.visibleModelCategories as unknown[]).includes(item))
    : undefined;

  return {
    catalogId,
    ...(workflowApi ? { workflowApi } : {}),
    ...(workflowApiDrafts ? { workflowApiDrafts } : {}),
    config: {
      name: asString(source.name) || '导入的连接',
      // 凭据永远不随配置流转，由用户重新填写
      apiKey: '',
      baseUrl: customWorkflow ? normalizeWorkflowApiBaseUrl(asString(source.baseUrl), true) : normalizeBaseUrl(asString(source.baseUrl), chatApiProtocol) || undefined,
      chatApiProtocol,
      catalogId,
      selectedModels: customWorkflow ? [] : parseModels(source.selectedModels),
      catalogModels: customWorkflow ? [] : parseModels(source.catalogModels),
      visibleModelCategories: visible,
    },
  };
}
